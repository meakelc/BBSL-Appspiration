# Orchestrator effort triage — which stories can run bmad-build on low-effort Opus

Unmanaged file, safe to hand-edit. Companion to `hermes.md`. Not part of `_bmad-output/`,
which the `bmad-*` skills own.

Produced 2026-08-25 against `b2848c3`, reading all 2,309 lines of
`_bmad-output/planning-artifacts/epics.md` and
`_bmad-output/implementation-artifacts/sprint-status.yaml`.
Covers the 41 stories still in backlog at that date (1.10 → 8.4); Epic 1 stories 1.1–1.9
were already `done`.

Amended 2026-08-26: the tables below are now read programmatically by the Acceptance
Auditor review layer to pick its model tier. See "Two operational notes".

---

## What the effort setting actually governs

The orchestrator in `bmad-build` does four things: route on story status, dispatch the
implementer, **triage and classify review findings**, and **decide loopback versus accept**.
Low effort degrades the third and fourth. The implementer and the review layers are
separate dials — see `bmad-tiered-review` — and reducing orchestrator effort does not
touch them.

So the axis is **not** "is this story hard to write." It is "if the orchestrator
under-reasons about a finding, how far does the damage travel."

**Three markers make a story unsafe for low effort:**

1. **It writes to `src/lib/core/`.** A rules bug is the project's worst failure class
   (NFR1), and AD-25 means a bad merge silently rewrites the executable specification.
2. **It establishes a pattern later stories inherit unexamined.**
3. **Its acceptance criteria state an invariant as a negation** — "never cached",
   "silence alone can never produce Stale", "prospectively only", "neither short-circuits
   the other". Negative invariants are precisely what a low-effort triage pass
   rationalises away, because nothing in the diff contradicts them visibly.

---

## Safe for low-effort Opus (14)

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
| 1.10 Set Minor League Eligibility by hand | CRUD plus lock-after-open — one caveat below |

**Caveat on 1.10.** Its AC "a projection rebuild reproduces the flag as it stood at each
point in the log" is the first appearance of the reference-data-as-events pattern
(AR-6). If this runs low-effort, verify that single AC by hand before accepting.

---

## Keep on high-effort Opus (16)

### Tier A — where a rules bug lives

| Story | The specific hazard |
| --- | --- |
| 2.5 Place a Bid | Establishes the `evaluate()` / `decide()` contract for the whole project |
| 2.6 The money gate and the refusal panel | Every derived-money invariant (AR-8) lands here |
| 2.7 The slots gate, both gates reported | "Neither short-circuits the other"; misreporting is a defect by definition |
| 2.8 Minors Exposure | Hardest arithmetic in the product; a new bid refused for exposing an older one |
| 3.4 Close an Auction and place the Player | Winning amount and Cap Hit as distinct fields — silently wrong if conflated |
| 3.5 The tick | Sequential closes, `now` = each Auction's own nominal expiry, restart-safety |
| 3.7 The League Clock and phase end | A voided Bid as a non-reset against an insert-only log |
| 7.2 Void a Bid and restore the Auction | Refold plus League Clock recompute plus "prospectively only" |
| 4.1 Live updates and the freshness contract | "Silence alone can never produce Stale" is the exact shape low effort fumbles |

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

## Judgement call (11) — low effort acceptable with one named spot-check

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

*(Ten listed; the eleventh is 1.10, carried in the safe table above with its caveat.)*

---

## Two operational notes

**This file is load-bearing configuration, not just advice.** As of 2026-08-26 the
Acceptance Auditor layer in `_bmad/custom/bmad-build.toml` and
`_bmad/custom/bmad-code-review.toml` selects its model tier by looking the story up in
the tables above: a **Safe** row buys `bmad-reviewer-acceptance-lite` (sonnet), a Tier A
or Tier B row buys `bmad-reviewer-acceptance` (opus). Anything **not listed** falls to
opus by design — the triage is dated and pinned to a commit, so a story added since is an
unknown, and an unknown is not a safe story. Two consequences: moving a story between
tables changes what it costs to review, and **re-running this triage at an epic boundary
is now a config change**, not a documentation refresh.

**Effort and reviewer tier are independent dials.** The current setup pins Blind Hunter,
Edge Case Hunter and Verification Gap to sonnet unconditionally, the step-02 investigators
to sonnet, and the Acceptance Auditor to whichever tier this file's tables imply.
Dropping the orchestrator to low does not change any of that. **Do not lower both on a
Tier A story** — that thins judgement at the orchestrator and the auditor at the same
time, and the Acceptance Auditor is the layer that compares code against spec. On a Safe
story the auditor is already at sonnet, so running the orchestrator low as well is the
same double-thinning one tier down: pick one.

**Low effort is worst exactly where the diff-coverage trap bites.** `bmad-tiered-review`
records a measured case where 66% of a story was never shown to any reviewer, because a
plain `git diff <baseline>` omits untracked files and step-04 forbids `git add`. Catching
that requires the orchestrator to notice a discrepancy nobody flagged. Stories that ADD
many new files — 2.5, 3.5, 5.1, 8.1 — are both the highest-risk and the ones where the
failure is invisible. A further reason those four stay high.

Before trusting any review, verify coverage:

```bash
grep '^diff --git' <prompt-file>.md | sed 's/.* b\// /'   # what was reviewed
git status --short                                        # what changed
```

---

## The two levers no model pin can reach

Measured on this project over the ten days to 2026-08-26 (`scripts/bmad-cost-report.py
--hours 240`): **$1,185 total, 88.2% of it opus**, against 2,520 opus turns and 1,321
sonnet turns. The re-tiering is demonstrably working — the sonnet row exists — but it only
moved ~12% of spend, because the cost is not really in the generation.

**Cache reads dominate everything.** Roughly 80% of spend is cache read, not output: the
price of carrying a long context across many turns. Two single sessions in that window
cost $64 and $77 on their own, at 28.7M and 31.0M cache-read tokens. No model pin touches
that column. Only two things do.

**1. The duplication test is whether a review actually RAN, not whether `bmad-build` ran.**
`bmad-build` step-04 and `bmad-code-review` step-02 run the same layers over the same diff
from byte-identical prompt files, so re-reviewing a diff **that build already reviewed** is
~100% waste. But a `bmad-build` run that was **paused after implementation, before step-04
executed its layers**, has reviewed nothing — and finishing it in `bmad-code-review` is the
supported handoff, not duplication.

That split is routine here, and usually forced: a large story plus a full four-layer review
does not always fit inside one 5-hour usage window. Pausing after implementation, committing,
and running the review in a fresh context is the correct response, and it is **cheaper than
the in-session review** — the reviewers start on a clean context instead of inheriting the
whole planning-and-implementation session, which is where the cache-read cost lives.

**Running the split correctly.** `bmad-code-review` step-01 Tier 1 accepts a spec path and
reads `baseline_commit` from its frontmatter as the diff baseline — that is the designed seam
between the two skills.

- **Always pass the spec path.** It is what sets `review_mode = "full"`, and the Acceptance
  Auditor is gated on exactly that (`when = 'Only when {review_mode} = "full".'`). Omit the
  spec and step-02 silently **drops the auditor** with a one-line notice — you lose the
  judgement layer, which is the one layer worth the most.
- **Commit before switching.** This is a real advantage of the split, not just tidiness: the
  66%-of-the-diff-missing trap exists because `git diff <baseline>` omits untracked files
  while step-04 forbids `git add`. Once the work is committed there are no untracked files,
  so the diff is complete by construction.
- **Check the spec says `in-review` before you pause.** Step-04 sets that as its first
  action. If you stopped earlier and it still reads `in-progress`, step-01 of a resumed
  `bmad-build` routes to step-03 and **re-implements the story**.
- `bmad-code-review` step-04 closes the loop itself — it sets the story to `done` or
  `in-progress` and syncs `sprint-status.yaml`.

So: skip the second pass when build's step-04 already ran its layers on that diff. Otherwise
run it — deliberately, with the spec path. Also keep it for what build never covered: code
that did not come from a build run, a diff spanning several stories whose *interaction*
nobody reviewed, or a second opinion before a risky merge.

**2. One story per session — and splitting one story across sessions is fine too.** Given
the cache-read share, five stories in one long session costs far more than five sessions of
one story: every turn re-reads the whole accumulated context. The same arithmetic means
pausing a long story at the review gate and finishing it fresh is a *saving*, not a
compromise — the reviewers stop paying for the planning and implementation context they do
not need. Loopbacks are where this hurts most: Story 1.6 went three full rounds (implement →
four reviewers → re-implement, ×3) inside one session, ~12 reviewer invocations and 3
implementer runs, each turn paying for everything before it. A story already on its second
loopback is a good candidate to commit and resume fresh.

**The implementer stays on the session tier, deliberately.** Its output is large, its
mistakes propagate into every review layer, and a bad implementation triggers a loopback
that re-runs steps 2-4 at full price — Story 1.6 is the worked example of exactly that.
The override shape is written out and commented out at the bottom of
`_bmad/custom/bmad-build.toml`; do not enable it without first tracking
`review_loop_iteration` across a dozen stories before and after. A downgrade here can
easily cost more than it saves.

