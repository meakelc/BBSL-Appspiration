# Orchestrator effort triage — which band each story runs bmad-build on

Unmanaged file, safe to hand-edit. Companion to `hermes.md`. Not part of `_bmad-output/`,
which the `bmad-*` skills own.

**This file is load-bearing configuration, not documentation.** The Acceptance Auditor
layer in `_bmad/custom/bmad-build.toml` and `_bmad/custom/bmad-code-review.toml` picks its
model tier by looking the story up in the tables below: a **Safe** row buys
`bmad-reviewer-acceptance-lite` (sonnet), a **Tier A** or **Tier B** row buys
`bmad-reviewer-acceptance` (opus), and anything **unlisted** falls to opus by design.
Moving a story between tables changes what it costs to review, and re-running the triage
at an epic boundary is a config change.

Produced 2026-08-25 against `b2848c3` from `epics.md` + `sprint-status.yaml`, covering the
42 stories then in backlog (1.10 → 8.4). Revised 2026-08-26: added Story 2.3, which had
been omitted from all three tables, and replaced the two-position low/high dial with the
five-band ladder. Rows for stories since gone `done` (2.1, 2.2) are kept for the record —
bucket counts are as-triaged, not as-outstanding.

---

## What the effort setting governs

The orchestrator routes on story status, dispatches the implementer, **triages and
classifies review findings**, and **decides loopback versus accept**. Effort degrades only
the last two. The implementer and the review layers are separate dials
(`bmad-tiered-review`).

So the axis is **not** "is this story hard to write" but "if the orchestrator
under-reasons about a finding, how far does the damage travel."

**Three markers make a story unsafe for a reduced band:**

1. **It writes to `src/lib/core/`.** A rules bug is the worst failure class (NFR1), and
   under AD-25 a bad merge silently rewrites the executable specification.
2. **It establishes a pattern later stories inherit unexamined.**
3. **An acceptance criterion states an invariant as a negation** — "never cached",
   "silence alone can never produce Stale", "prospectively only", "neither short-circuits
   the other". A negative invariant is violated by the *absence* of correct code, so
   nothing in the diff contradicts it visibly and a thin triage pass has nothing to react
   to.

---

## The bands

Claude Code's bundled model registry defines exactly five. **There is no `none` and no
`minimal`** — `low` is the floor, and below it you are changing model, not effort.
Read out of `claude-code` 2.1.246:

```
effort: ["low","medium","high","xhigh","max"]
claude-opus-5  default_effort: high
               effort_cost_index: low 0.67 · medium 0.76 · high 1 · xhigh 1.6 · max 1.7
```

Re-verify against the current CLI rather than trusting the numbers above:

```bash
grep -a -o -E 'id:"claude-opus-5".{700,1100}' ~/.local/share/claude/versions/<ver>
```

| Band | Cost index | Which stories | Why |
| --- | --- | --- | --- |
| `low` | 0.67 | **none** | Only ~13% under medium — never worth the triage degradation |
| `medium` | 0.76 | The 14 Safe rows | Auditor is already sonnet there; medium avoids thinning both ends |
| `high` | 1.00 | Judgement-call rows, and Tier A/B except the three below | Opus-5's own `default_effort` |
| `xhigh` | 1.60 | 3.5, 5.1, 8.1 | Many new files + first-of-kind mechanism + invisible failure |
| `max` | 1.70 | **none** | ~6% over xhigh, no distinct failure mode it addresses |

The index multiplies only the effort-attributable slice of a turn, not the bill — cache
reads dominate (see the last section), so these ratios matter less than they look.

`xhigh` is for **invisible** failure, not difficulty: stories where no loopback ever fires
to correct the orchestrator. Hard-but-loud stories stay at `high`. Judgement-call rows
also stay at `high` — the named spot-check is what buys the saving there, and dropping the
band too would remove the reason the spot-check is sufficient.

### Setting a band

- **Session-level** (the one that matters): `/effort <band>`, or
  `modelSettings.claude-opus-5.effortLevel` in `~/.claude/settings.json`. **A global pin
  is not a per-story dial** — pin it to `high` and step *down* on Safe rows. Pinning low
  and remembering to step up is the wrong asymmetry: forgetting to step down costs ~32%,
  forgetting to step up costs a rules bug.
- **Per-agent, currently unused:** `.claude/agents/*.md` frontmatter accepts `effort:`
  alongside `model:`. All seven agent files set `model:` only. Do not enable it in the
  same change as a band revision — two dials moving at once makes neither attributable.

---

## Safe for low-effort Opus (14) — band `medium`

Presentation-bound or mechanical, consuming rules rather than writing them, with the
pattern already established by a sibling story.

| Story | Why it is safe |
| --- | --- |
| 2.2 Nomination refusals and concurrency | Refusal copy plus one data-layer uniqueness clause |
| 2.4 The Auction page and its bid control | Presentation; 2.5 and 2.6 own the semantics |
| 4.2 The persistent strip | Renders `evaluate()` output; introduces no arithmetic |
| 4.3 View the Bid Board | Wide AC surface, all mechanical; greyscale test is objective |
| 4.5 View any Team | Read-only, and must share its computation with 4.6 |
| 5.2 Broadcast to the league channel | Formatting plus `allowed_mentions`; 5.1 owns the hard part |
| 5.4 Notification settings | Three categories, server-side refusal, nothing else |
| 6.1 Assign contract lengths | The Year Allotment is counting to 1 / 1 / 2 / unlimited |
| 6.4 Export full post-auction rosters | Inherits the export discipline 6.3 sets |
| 6.5 Archive the auction | A phase event plus refuse-everything |
| 7.5 The league-visible Audit Log | A read of a table that already exists |
| 8.2 Detect that the tick has stopped | Infrastructure, verifiable by killing the tick |
| 8.4 Recovery procedure and go-live gate | Largely a written document plus a checklist |
| 1.10 Set Minor League Eligibility by hand | CRUD plus lock-after-open — spot-check one AC |

**Caveat on 1.10.** Its AC "a projection rebuild reproduces the flag as it stood at each
point in the log" is the first appearance of reference-data-as-events (AR-6). Verify that
single AC by hand before accepting.

---

## Keep on high-effort Opus (17) — band `high`, three of them `xhigh`

### Tier A — where a rules bug lives

| Story | The specific hazard |
| --- | --- |
| 2.3 Nomination Slot lifecycle | Fold, not a stored flag; four negative invariants; correctness asserted via a synthetic `AuctionClosed` against unbuilt Epic 3 — a wrongly-keyed fold passes green here and surfaces at 3.4 |
| 2.5 Place a Bid | Establishes the `evaluate()` / `decide()` contract for the whole project |
| 2.6 The money gate and the refusal panel | Every derived-money invariant (AR-8) lands here |
| 2.7 The slots gate, both gates reported | "Neither short-circuits the other"; misreporting is a defect by definition |
| 2.8 Minors Exposure | Hardest arithmetic in the product; a new bid refused for exposing an older one |
| 3.4 Close an Auction and place the Player | Winning amount and Cap Hit as distinct fields — silently wrong if conflated |
| 3.5 The tick | Sequential closes, `now` = each Auction's own nominal expiry, restart-safety |
| 3.7 The League Clock and phase end | A voided Bid as a non-reset against an insert-only log |
| 7.2 Void a Bid and restore the Auction | Refold plus League Clock recompute plus "prospectively only" |
| 4.1 Live updates and the freshness contract | "Silence alone can never produce Stale" is the exact shape a thin pass fumbles |

### Tier B — pattern-setting or a security boundary

| Story | The specific hazard |
| --- | --- |
| 2.1 Nominate a Free Agent | First command through the transactional shell; every later command copies it |
| 3.2 Enter and join a Minimum-Bid Contention | Seed table unreadable by every role including the Commissioner; eligible-versus-flat commitment |
| 3.6 Draw a Minimum-Bid Contention winner | Commit-reveal must be hand-reproducible, or the fairness premise is theatre |
| 5.1 The transactional outbox and its dispatcher | `(event seq, channel, recipient)`; keying on the event alone drops a co-Manager |
| 7.1 The Commissioner control class and reason sheet | Every override in Epic 7 inherits it |
| 7.4 Pause and resume the auction | The universal escape hatch, including the break-glass path |
| 8.1 Replay against a synthetic clock | "No code path special-cased for the rehearsal" needs judgement to enforce |

---

## Judgement call (11) — band `high` plus one named spot-check

| Story | Check this one AC by hand |
| --- | --- |
| 1.11 Open the auction | Outstanding items **named**, never counted |
| 3.1 Expiry is authoritative | Never reads a projection's "open" flag as authority |
| 3.3 Dissolve a contention | Seed revealed at dissolution |
| 4.4 Your Positions | Outbid card states whether a legal re-entry exists at all |
| 4.6 The Teams index and League Median | Lower of the two middle values, not their mean (§10 example 28) |
| 5.3 Notify Managers by mention | Both co-Managers mentioned individually |
| 6.2 Track completion, deadline resolves nothing | No code path can write a length without an acting actor |
| 6.3 Review and export Auction Contracts | The `$14.5M` renderer is unreachable from the export path |
| 7.3 The remaining overrides | Every override appends an event and is refused once archived |
| 8.3 Reconstruct from outside Supabase | Exported reference data includes everything a fold reads |

*(Ten listed; the eleventh is 1.10, carried in the Safe table above with its caveat.)*

---

## The diff-coverage trap

`bmad-tiered-review` records a measured case where **66% of a story never reached any
reviewer**: `git diff <baseline>` omits untracked files and step-04 forbids `git add`. The
reviewers returned confident, correct findings about the fragment they saw. Catching it
requires noticing a discrepancy nobody flagged — the first thing a reduced band drops.
Stories that add many new files (2.5, 3.5, 5.1, 8.1) are both highest-risk and the ones
where the failure is silent.

Before trusting any review, verify coverage:

```bash
grep '^diff --git' <prompt-file>.md | sed 's/.* b\// /'   # what was reviewed
git status --short                                        # what changed
```

Committing before review closes the trap by construction.

---

## The two levers no model pin can reach

Measured over the ten days to 2026-08-26 (`scripts/bmad-cost-report.py --hours 240`):
**$1,185 total, 88.2% of it opus**, 2,520 opus turns against 1,321 sonnet. Re-tiering
works but moved only ~12% of spend — **roughly 80% of the bill is cache read**, the price
of carrying a long context across many turns. Two single sessions cost $64 and $77 alone,
at 28.7M and 31.0M cache-read tokens. No model or effort setting touches that column.
Two things do.

### 1. The duplication test is whether a review RAN, not whether `bmad-build` ran

`bmad-build` step-04 and `bmad-code-review` step-02 run the same layers over the same diff
from byte-identical prompt files, so re-reviewing a diff **build already reviewed** is
~100% waste. But a build run **paused before step-04 executed its layers** has reviewed
nothing, and finishing it in `bmad-code-review` is the supported handoff — routine here,
usually forced by the 5-hour window, and *cheaper* than the in-session review because the
reviewers start clean instead of inheriting the planning-and-implementation context.

Running the split correctly:

- **Always pass the spec path.** It sets `review_mode = "full"`, and the Acceptance
  Auditor is gated on exactly that. Omit it and step-02 silently drops the auditor — the
  layer worth the most.
- **Commit before switching**, which closes the diff-coverage trap above.
- **Check the spec reads `in-review` before you pause.** Step-04 sets it first thing; if
  it still reads `in-progress`, a resumed `bmad-build` routes to step-03 and
  **re-implements the story**.
- `bmad-code-review` step-04 closes the loop — sets `done` or `in-progress`, syncs
  `sprint-status.yaml`.

Also keep the second pass for what build never covered: code not from a build run, a diff
spanning several stories whose *interaction* nobody reviewed, or a second opinion before a
risky merge.

### 2. One story per session — and splitting one story across sessions is fine

Five stories in one long session costs far more than five sessions of one story: every
turn re-reads the accumulated context. Loopbacks hurt most — Story 1.6 went three full
rounds inside one session (~12 reviewer invocations, 3 implementer runs), each turn paying
for everything before it. A story on its second loopback is a good candidate to commit and
resume fresh.

**The implementer stays on the session tier, deliberately.** Its output is large, its
mistakes propagate into every review layer, and a bad implementation triggers a loopback
that re-runs steps 2–4 at full price. The override shape is commented out at the bottom of
`_bmad/custom/bmad-build.toml`; do not enable it without first tracking
`review_loop_iteration` across a dozen stories before and after.
