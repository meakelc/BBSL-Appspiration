#!/usr/bin/env python3
"""Aggregate real per-run cost from Claude Code session transcripts.

The prior analysis in this workflow asserted savings from re-tiering the BMAD
review swarm. This script is what turns that assertion into a measurement.

Claude Code writes one JSONL transcript per session under
~/.claude/projects/<slugified-cwd>/<session-id>.jsonl. Each assistant record
carries `message.model` and `message.usage`, including cache token counts.
Subagent turns appear in the same transcript, so a review swarm's cost lands
here alongside the orchestrator's.

MEASURED CAVEAT (Claude Code 2.1.238): the `isSidechain` field is present on
every assistant record but is ALWAYS false, including in projects where
subagents demonstrably ran at other tiers. It cannot be used to separate
orchestrator turns from subagent turns. This script therefore groups by MODEL
TIER, which is the thing the pins actually control and the thing that carries
the price. Under an opus orchestrator with sonnet-pinned reviewers, the sonnet
row IS the review swarm.

Usage:
    python bmad-cost-report.py                    # this project, last 24h
    python bmad-cost-report.py --hours 168        # last week
    python bmad-cost-report.py --since 2026-08-20 # since a date
    python bmad-cost-report.py --by-session       # break out per session

Prices are USD per million tokens and MUST be checked against
https://www.anthropic.com/pricing before you trust the dollar column. The
token counts are measured; the dollars are only as good as this table.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import sys
from collections import defaultdict

# USD per million tokens: (input, output, cache_write_5m, cache_read)
# VERIFY THESE before citing dollar figures.
PRICES = {
    "opus":   (15.00, 75.00, 18.75, 1.50),
    "sonnet": ( 3.00, 15.00,  3.75, 0.30),
    "haiku":  ( 1.00,  5.00,  1.25, 0.10),
}


def tier(model: str) -> str | None:
    m = (model or "").lower()
    for name in PRICES:
        if name in m:
            return name
    return None


def transcript_dirs(project_root: pathlib.Path) -> list[pathlib.Path]:
    """Claude Code slugifies the cwd to name its project transcript dir.

    The exact slug rule is not documented and has changed between versions, so
    match on a normalised suffix rather than reconstructing it.
    """
    base = pathlib.Path.home() / ".claude" / "projects"
    if not base.is_dir():
        return []
    want = project_root.name.lower()
    hits = [d for d in base.iterdir() if d.is_dir() and d.name.lower().endswith(want)]
    return hits or [d for d in base.iterdir() if d.is_dir()]


def parse_ts(rec: dict) -> dt.datetime | None:
    raw = rec.get("timestamp")
    if not raw:
        return None
    try:
        return dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=24.0)
    ap.add_argument("--since", type=str, default=None,
                    help="ISO date/datetime; overrides --hours")
    ap.add_argument("--project-root", type=str, default=os.getcwd())
    ap.add_argument("--by-session", action="store_true")
    args = ap.parse_args()

    if args.since:
        cutoff = dt.datetime.fromisoformat(args.since)
        if cutoff.tzinfo is None:
            cutoff = cutoff.replace(tzinfo=dt.timezone.utc)
    else:
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=args.hours)

    root = pathlib.Path(args.project_root).resolve()
    dirs = transcript_dirs(root)
    if not dirs:
        print("No transcripts found under ~/.claude/projects.", file=sys.stderr)
        return 1

    # (scope, tier) -> token counters
    agg: dict[tuple[str, str], dict[str, int]] = defaultdict(
        lambda: {"in": 0, "out": 0, "cw": 0, "cr": 0, "turns": 0}
    )
    sessions_seen = set()

    for d in dirs:
        for f in d.glob("*.jsonl"):
            for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
                if not line.strip():
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("type") != "assistant":
                    continue
                ts = parse_ts(rec)
                if ts and ts < cutoff:
                    continue
                msg = rec.get("message") or {}
                t = tier(msg.get("model", ""))
                if not t:
                    continue
                u = msg.get("usage") or {}
                # Do NOT use rec["isSidechain"] — measured always-false in
                # CC 2.1.238. Tier is the only reliable discriminator.
                scope = f"{f.stem[:8]}" if args.by_session else "all"
                sessions_seen.add(f.stem)
                a = agg[(scope, t)]
                a["in"] += u.get("input_tokens", 0) or 0
                a["out"] += u.get("output_tokens", 0) or 0
                a["cw"] += u.get("cache_creation_input_tokens", 0) or 0
                a["cr"] += u.get("cache_read_input_tokens", 0) or 0
                a["turns"] += 1

    if not agg:
        print(f"No assistant turns since {cutoff.isoformat()}.")
        return 0

    print(f"Window: since {cutoff.isoformat()}   sessions touched: {len(sessions_seen)}")
    print(f"{'scope':<24}{'tier':<9}{'turns':>7}{'in':>12}{'out':>10}"
          f"{'cache_wr':>11}{'cache_rd':>11}{'USD':>10}")
    print("-" * 94)

    total = 0.0
    subtotal: dict[str, float] = defaultdict(float)
    for (scope, t), a in sorted(agg.items()):
        pi, po, pw, pr = PRICES[t]
        cost = (a["in"] * pi + a["out"] * po + a["cw"] * pw + a["cr"] * pr) / 1e6
        total += cost
        subtotal[t] += cost
        print(f"{scope:<24}{t:<9}{a['turns']:>7}{a['in']:>12,}{a['out']:>10,}"
              f"{a['cw']:>11,}{a['cr']:>11,}{cost:>10.4f}")

    print("-" * 94)
    for k, v in sorted(subtotal.items()):
        share = (v / total * 100) if total else 0.0
        print(f"{k + ' subtotal':<24}{'':<9}{'':>7}{'':>12}{'':>10}"
              f"{'':>11}{'':>11}{v:>10.4f}   ({share:.1f}%)")
    print(f"{'TOTAL':<24}{'':<9}{'':>7}{'':>12}{'':>10}{'':>11}{'':>11}{total:>10.4f}")
    print()
    print("Read this as a TIER MIX, not a scope split. Before the re-tiering an")
    print("all-opus BMAD project shows a single opus row; afterwards the review")
    print("swarm should appear as a sonnet row carrying most of the turns. If no")
    print("sonnet row appears after a build+review run, the model pins in")
    print(".claude/agents/ are not taking effect.")
    print()
    print("Watch cache_rd. On long orchestrator sessions it dominates every other")
    print("column, and re-tiering reviewers does nothing to it — only shorter")
    print("sessions and fewer turns do.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
