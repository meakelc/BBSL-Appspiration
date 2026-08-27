#!/usr/bin/env python3
"""Aggregate real per-run cost from HERMES session transcripts.

Companion to `bmad-cost-report.py`, which reads Claude Code's
~/.claude/projects/**/*.jsonl and therefore reports "No assistant turns" for
anything run inside Hermes. This script reads the equivalent Hermes source:
the `session_model_usage` table in state.db.

WHY A SEPARATE SCRIPT AND NOT A FLAG
    The two stores are shaped differently. Claude Code writes one JSONL record
    per assistant turn and cannot distinguish orchestrator from subagent
    (`isSidechain` is always false as of CC 2.1.238), so the CC script groups by
    MODEL TIER. Hermes records a row per (session, model) and marks subagent
    sessions with `source='subagent'` plus a `parent_session_id`, so this script
    can report the orchestrator/subagent split DIRECTLY — which the CC script
    structurally cannot.

MEASURED CAVEATS (2026-08-26, state.db schema v-current)
  * Hermes' own pricing table covers claude-sonnet-5 but NOT claude-opus-5 or
    claude-haiku-4-5: those rows carry cost_status='unknown', cost_source='none'
    and estimated_cost_usd=0.0. `hermes insights` therefore under-reports total
    spend by roughly the whole opus share. This script IGNORES Hermes'
    estimated_cost_usd and prices every row itself from the table below, which
    is the same table `bmad-cost-report.py` uses.
  * `input_tokens` is uncached input only and runs implausibly low (~2/call on
    long sessions). Cache read/write is where the money is anyway; treat the
    `in` column as indicative, not authoritative.
  * `sessions.git_repo_root` is NULL on every row and `cwd` is recorded on only
    a minority (3 of 79 in a ten-day window), never on subagent sessions. There
    is therefore NO reliable per-project scoping. The default is all sessions;
    `--project-root` is best-effort and warns about what it dropped.

Usage:
    python scripts/hermes-cost-report.py                 # last 24h, all sessions
    python scripts/hermes-cost-report.py --hours 240
    python scripts/hermes-cost-report.py --since 2026-08-20
    python scripts/hermes-cost-report.py --by-session
    python scripts/hermes-cost-report.py --project-root .   # best-effort, lossy

Prices are USD per million tokens and MUST be checked against
https://www.anthropic.com/pricing before you trust the dollar column.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import pathlib
import sqlite3
import sys
from collections import defaultdict

# USD per million tokens: (input, output, cache_write_5m, cache_read)
# Keep in sync with scripts/bmad-cost-report.py — the two reports are only
# comparable if they price identically.
PRICES = {
    "opus":   (15.00, 75.00, 18.75, 1.50),
    "sonnet": ( 3.00, 15.00,  3.75, 0.30),
    "haiku":  ( 1.00,  5.00,  1.25, 0.10),
}


def state_db() -> pathlib.Path:
    base = os.environ.get("LOCALAPPDATA") or str(pathlib.Path.home() / "AppData" / "Local")
    return pathlib.Path(base) / "hermes" / "state.db"


def tier(model: str) -> str | None:
    m = (model or "").lower()
    for name in PRICES:
        if name in m:
            return name
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=24.0)
    ap.add_argument("--since", type=str, default=None, help="ISO date/datetime; overrides --hours")
    ap.add_argument("--project-root", type=str, default=None,
                    help="best-effort scope by recorded cwd; see the caveat printed "
                         "when rows have no cwd recorded")
    ap.add_argument("--by-session", action="store_true")
    ap.add_argument("--db", type=str, default=None)
    args = ap.parse_args()

    if args.since:
        cutoff = dt.datetime.fromisoformat(args.since)
        if cutoff.tzinfo is None:
            cutoff = cutoff.replace(tzinfo=dt.timezone.utc)
    else:
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=args.hours)
    cut_ts = cutoff.timestamp()

    db = pathlib.Path(args.db) if args.db else state_db()
    if not db.is_file():
        print(f"No Hermes state.db at {db}", file=sys.stderr)
        return 1

    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    rows = con.execute(
        """
        SELECT u.session_id, u.model, u.api_call_count, u.input_tokens,
               u.output_tokens, u.cache_write_tokens, u.cache_read_tokens,
               s.source, s.parent_session_id, s.git_repo_root, s.cwd, s.started_at
        FROM session_model_usage u
        JOIN sessions s ON s.id = u.session_id
        WHERE COALESCE(u.last_seen, s.started_at) >= ?
        """,
        (cut_ts,),
    ).fetchall()

    root = pathlib.Path(args.project_root).resolve() if args.project_root else None
    # MEASURED 2026-08-26: `sessions.git_repo_root` is NULL on every row and
    # `cwd` is recorded for only a minority (3 of 79 in a ten-day window), and
    # subagent sessions carry neither. Scoping by project is therefore
    # best-effort at best. Default is ALL sessions, which is honest; pass
    # --project-root only when you accept that it silently drops every session
    # with no cwd recorded, including all subagents.
    parent_repo: dict[str, str] = {}
    for sid, repo, cwd in con.execute("SELECT id, git_repo_root, cwd FROM sessions"):
        parent_repo[sid] = (repo or cwd or "")

    unscoped = 0

    def in_scope(repo: str, cwd: str, parent: str | None) -> bool:
        nonlocal unscoped
        if root is None:
            return True
        cand = repo or cwd or (parent_repo.get(parent or "", ""))
        if not cand:
            unscoped += 1
            return False
        try:
            p = pathlib.Path(cand).resolve()
            return p == root or root in p.parents
        except OSError:
            return False

    agg: dict[tuple[str, str, str], dict[str, int]] = defaultdict(
        lambda: {"in": 0, "out": 0, "cw": 0, "cr": 0, "calls": 0}
    )
    sessions_seen: set[str] = set()
    unpriced: set[str] = set()

    for (sid, model, calls, tin, tout, cw, cr, source, parent, repo, cwd, started) in rows:
        if not in_scope(repo or "", cwd or "", parent):
            continue
        t = tier(model)
        if not t:
            unpriced.add(model)
            continue
        scope = "subagent" if (source == "subagent" or parent) else "orchestrator"
        key_scope = f"{sid[:15]} {scope[:4]}" if args.by_session else scope
        sessions_seen.add(sid)
        a = agg[(key_scope, t, scope)]
        a["calls"] += calls or 0
        a["in"] += tin or 0
        a["out"] += tout or 0
        a["cw"] += cw or 0
        a["cr"] += cr or 0

    if not agg:
        print(f"No Hermes usage rows since {cutoff.isoformat()}"
              + (f" for {root}." if root else "."))
        print("Try a wider --hours, dropping --project-root, or --db <path>.")
        return 0

    print(f"Window: since {cutoff.isoformat()}   sessions: {len(sessions_seen)}"
          f"   scope: {root if root else 'ALL SESSIONS (all projects)'}")
    print(f"{'scope':<26}{'tier':<9}{'calls':>7}{'in':>10}{'out':>10}"
          f"{'cache_wr':>11}{'cache_rd':>13}{'USD':>10}")
    print("-" * 96)

    total = 0.0
    by_tier: dict[str, float] = defaultdict(float)
    by_scope: dict[str, float] = defaultdict(float)
    for (key_scope, t, scope), a in sorted(agg.items()):
        pi, po, pw, pr = PRICES[t]
        cost = (a["in"] * pi + a["out"] * po + a["cw"] * pw + a["cr"] * pr) / 1e6
        total += cost
        by_tier[t] += cost
        by_scope[scope] += cost
        print(f"{key_scope:<26}{t:<9}{a['calls']:>7}{a['in']:>10,}{a['out']:>10,}"
              f"{a['cw']:>11,}{a['cr']:>13,}{cost:>10.4f}")

    print("-" * 96)
    for k, v in sorted(by_tier.items()):
        share = (v / total * 100) if total else 0.0
        print(f"{k + ' subtotal':<26}{'':<9}{'':>7}{'':>10}{'':>10}{'':>11}{'':>13}"
              f"{v:>10.4f}   ({share:.1f}%)")
    print()
    for k, v in sorted(by_scope.items()):
        share = (v / total * 100) if total else 0.0
        print(f"{k + ' subtotal':<26}{'':<9}{'':>7}{'':>10}{'':>10}{'':>11}{'':>13}"
              f"{v:>10.4f}   ({share:.1f}%)")
    print(f"{'TOTAL':<26}{'':<9}{'':>7}{'':>10}{'':>10}{'':>11}{'':>13}{total:>10.4f}")

    if unpriced:
        print()
        print("Unpriced models skipped (add them to PRICES to include): "
              + ", ".join(sorted(unpriced)))
    if unscoped:
        print()
        print(f"WARNING: {unscoped} usage row(s) were DROPPED because the session "
              "recorded no cwd.")
        print("Hermes leaves git_repo_root NULL and omits cwd on most sessions, and on")
        print("every subagent session — so --project-root can hide the review swarm")
        print("entirely. Re-run without --project-root to see the true total.")
    print()
    print("Read the SUBAGENT row as the review swarm. Unlike bmad-cost-report.py,")
    print("this split is recorded, not inferred from tier — so a sonnet subagent")
    print("row confirms delegation.model took effect for that dispatch.")
    print()
    print("Do NOT cross-check against `hermes insights`: its pricing table has no")
    print("entry for claude-opus-5, so it reports the opus share as $0.00.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
