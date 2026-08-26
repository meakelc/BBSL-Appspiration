#!/usr/bin/env bash
# run-review-layers.sh — execute BMAD review-layer prompts as model-pinned
# Claude Code processes, for the HALT-and-paste path.
#
# WHY THIS EXISTS
#   bmad-build renders an immutable snapshot at activation. A session that
#   activated before .claude/agents/ + _bmad/custom/*.user.toml existed is
#   following the OLD snapshot, whose review layers name no model and therefore
#   inherit the session tier (opus).
#
#   Step 4 offers an escape hatch: "if a layer's instruction requires subagents
#   and none are available, write the exact child prompt ... then HALT. Ask the
#   human to run each in a separate session (ideally a different LLM) and paste
#   back the findings." That path is not a downgrade — the workflow calls a
#   different LLM the STRONGER form, because it widens the information
#   asymmetry the review layers rely on.
#
#   This script is the "separate session" the workflow asks for, with the model
#   pinned explicitly instead of inherited.
#
# USAGE
#   ./scripts/run-review-layers.sh <prompt-file> [<prompt-file> ...]
#   ./scripts/run-review-layers.sh --auto      # discover in implementation-artifacts
#
#   Findings are written next to each prompt as <name>.findings.md and the
#   per-layer cost is printed. Paste the findings back into the paused session.
#
# COST NOTE
#   Each `claude -p` invocation pays its own system-prompt cache creation —
#   measured ~$0.12 even for a trivial prompt. Three reviewers therefore carry
#   ~$0.36 of fixed overhead that an in-session subagent would not. This is
#   still far cheaper than three opus reviewers over a real diff, but it is the
#   reason this script is a one-time bridge for an already-paused session, NOT
#   the steady-state design. Steady state is model-pinned agents in
#   .claude/agents/, which cost no extra process.

set -euo pipefail

MODEL="${REVIEW_MODEL:-sonnet}"
# The context-free layers get everything inline and need ~1-4 turns. A
# spec-aware auditor must READ the spec and its context docs first, so it needs
# more. MEASURED: the acceptance auditor blew --max-turns 6 (subtype
# error_max_turns, empty result) after burning $1.00 of opus. Do not lower this
# without checking which layer you are running.
MAX_TURNS="${REVIEW_MAX_TURNS:-20}"
ARTIFACTS="_bmad-output/implementation-artifacts"

if [ $# -eq 0 ]; then
  echo "usage: $0 <prompt-file> [...] | --auto" >&2
  exit 2
fi

if [ "${1:-}" = "--auto" ]; then
  # BMAD names these files itself; match broadly, then let the human confirm.
  mapfile -t FILES < <(find "$ARTIFACTS" -maxdepth 1 -type f -name '*.md' \
    -newermt '-6 hours' \
    ! -name 'deferred-work.md' ! -name 'sprint-status*' ! -name 'spec-*' \
    | sort)
  if [ ${#FILES[@]} -eq 0 ]; then
    echo "No recent candidate prompt files in $ARTIFACTS." >&2
    echo "Pass the paths explicitly instead." >&2
    exit 1
  fi
  echo "Discovered ${#FILES[@]} candidate prompt file(s):"
  printf '  %s\n' "${FILES[@]}"
  echo
else
  FILES=("$@")
fi

total=0
failed=0
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "!! missing: $f" >&2
    continue
  fi
  name="$(basename "${f%.md}")"
  out="$(dirname "$f")/${name}.findings.md"
  raw="$(dirname "$f")/.${name}.raw.json"

  echo "=== $name  (model: $MODEL) ==="

  # The prompt file already contains the fully-substituted child prompt,
  # including the diff. Pass it as a PATH for the reviewer to read, not on
  # stdin: MEASURED (2026-08-25) that `cat "$f" | claude -p '...'` delivers
  # NOTHING — the child saw only the framing sentence and replied "there is
  # nothing to review", as a legitimate subtype=success/terminal_reason=
  # completed run that the guard below therefore could not catch. That is a
  # third success-shaped failure: it costs full price and produces a
  # confident non-finding. Read is allowed anyway because two of the three
  # layers point at an instruction file on disk.
  #
  # The path must be NATIVE Windows (C:/...) on an MSYS shell — `claude` is a
  # native binary and MSYS path translation is disabled, so an /c/... or
  # /tmp/... path is unreadable to it.
  abs="$(cd "$(dirname "$f")" && pwd -W 2>/dev/null || cd "$(dirname "$f")" && pwd)/$(basename "$f")"
  if ! claude -p "Read the file ${abs} COMPLETELY — it is a full review instruction with the content to review inlined. Follow it exactly as written. Return only the review result." \
      --model "$MODEL" \
      --allowedTools 'Read' \
      --max-turns "$MAX_TURNS" \
      --output-format json \
      --no-session-persistence > "$raw" 2>&1; then
    echo "!! claude failed for $name; see $raw" >&2
    continue
  fi

  layer_ok=1
  python - "$raw" "$out" <<'PY' || layer_ok=0
import json, sys, pathlib
raw, out = sys.argv[1], sys.argv[2]
try:
    text = pathlib.Path(raw).read_text(encoding="utf-8", errors="replace")
    # A wrapper (e.g. claude-account-switcher) may print a notice line BEFORE
    # the JSON. MEASURED: "[claude-account-switcher] account 2 hit its usage
    # limit..." made the whole result unparseable and lost a $0.31 opus run.
    # Start at the first brace rather than assuming the stream is pure JSON.
    d = json.loads(text[text.index("{"):])
except Exception as e:
    print(f"   !! unparseable result: {e}")
    sys.exit(1)
# A rate-limited run still reports subtype="success". The real tells are
# api_error_status and terminal_reason. MEASURED: a 429 came back as
# subtype=success, api_error_status=429, terminal_reason=api_error, with
# result="You've hit your session limit · resets 3:10pm". Writing that into
# .findings.md would silently poison the paste-back with a non-finding.
err = d.get("api_error_status")
term = d.get("terminal_reason")
res = d.get("result") or ""
bad = (
    d.get("is_error")
    or err
    or term not in (None, "completed")
    or d.get("subtype") != "success"
    or not res.strip()
)
# A reviewer that never RECEIVED the content returns a short, polite, entirely
# successful non-finding ("there is nothing to review", "please paste the
# diff"). It passes every check above. A real review of a real diff is long
# and is a list. MEASURED: the empty-input reply was 420 chars with no list
# marker. Treat a short, list-free result as a delivery failure, not a review.
if not bad:
    has_list = any(
        line.lstrip().startswith(("-", "*", "#", "1.")) for line in res.splitlines()
    )
    if len(res) < 800 or not has_list:
        print("   !! NOT WRITTEN — result looks like a non-finding "
              f"({len(res)} chars, list={has_list}). The reviewer probably "
              "never received the content.")
        print(f"   !! result was: {res[:160]!r}")
        print(f"COST {d.get('total_cost_usd') or 0.0}")
        sys.exit(4)
if bad:
    hint = ""
    if d.get("subtype") == "error_max_turns" or term == "max_turns":
        hint = "  <- raise REVIEW_MAX_TURNS and re-run this layer"
    print(f"   !! NOT WRITTEN — subtype={d.get('subtype')} "
          f"api_error_status={err} terminal_reason={term}{hint}")
    print(f"   !! result was: {res[:160]!r}")
    print(f"COST {d.get('total_cost_usd') or 0.0}")
    sys.exit(3)
pathlib.Path(out).write_text(res, encoding="utf-8")
cost = d.get("total_cost_usd") or 0.0
models = ",".join((d.get("modelUsage") or {}).keys())
print(f"   turns={d.get('num_turns')}  cost=${cost:.4f}  models={models}")
print(f"   findings -> {out}  ({len(res.splitlines())} lines)")
print(f"COST {cost}")
PY

  c=$(python -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8',errors='replace'))
print(d.get('total_cost_usd') or 0.0)
" "$raw" 2>/dev/null || echo 0)
  total=$(python -c "print($total + $c)")
  if [ "$layer_ok" = "1" ]; then
    rm -f "$raw"
  else
    failed=$((failed + 1))
    echo "   raw kept for inspection: $raw"
  fi
  echo
done

echo "-----------------------------------------"
printf 'TOTAL for %d layer(s) at %s: $%.4f\n' "${#FILES[@]}" "$MODEL" "$total"
if [ "$failed" -gt 0 ]; then
  echo
  echo "!! $failed layer(s) produced NO findings file. Cost was still incurred."
  echo "!! A 429 session limit is the usual cause — wait for the reset and"
  echo "!! re-run ONLY the failed layers. Do not paste partial results back as"
  echo "!! if the layer had run; a missing layer is better than a fake one."
  exit 1
fi
echo
echo "Paste each .findings.md back into the paused bmad-build session, labelled"
echo "with its layer name. The session owns Classify — it re-derives severity"
echo "and triage itself, and explicitly disregards any severity a reviewer set."
