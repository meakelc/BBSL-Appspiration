---
title: 'Story 7.10: Rename the Roster Move to a Roster Trade'
type: 'refactor'
created: '2026-09-12'
status: 'done'
baseline_commit: '9686a097bd1631d7d760c7bf33edfe56ad77eff6'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The shipped two-Team trade recorder is called a "Roster Move" everywhere — files, routes, types, destination id, UI copy. Story 7.11 introduces the *actual* within-Team Roster Move (FR-44), so the name has to be free before that story can be written without every identifier meaning two things.

**Approach:** A pure rename of the trade act to **Trade**, plus a rename of the four types it shares with the Drop to **Act** (they belong to `roster-act.ts`, not to either caller). No behaviour changes. The persisted event-type string stays `'RosterMoveRecorded'` — AD-4 forbids rewriting history — while the constant holding it renames.

## Boundaries & Constraints

**Always:**
- Every existing test keeps its assertion's **meaning**. The only permitted test-body edits are identifiers, import paths, and the user-facing copy strings named below.
- The literal `'RosterMoveRecorded'` in `core/projection/contracts.ts` is **unchanged**, carries a comment naming AD-4 as the reason, and gains a test asserting the literal value so a later rename of the constant cannot silently change the wire.
- User-facing copy renames with the code: the destination label, the page title and heading, the commit label, the Audit Log label and headline, and the result/refusal sentences. FR-41 is itself retitled *Record a Roster Trade*.
- Use `git mv` for every file and directory rename, so history follows.
- `tests/examples/example-36…39` keep their **file names** — they are PRD §10 example numbers and those examples are about trades. Only their imports change.

**Ask First:**
- Any change that alters a gate's answer, a refusal's grounds, an event payload's shape, or the rendered arithmetic. This story may not fix a bug it finds; report it instead.
- Adding or removing a migration, or touching `auction_events` data.

**Never:**
- Renaming `'RosterMoveRecorded'`, or adding a migration/backfill to rewrite already-written event rows.
- Renaming the four shared types to Trade. They are `roster-act.ts`'s and become **Act**; naming them Trade would be as wrong as leaving them Move.
- Renaming `remove*` identifiers (`REMOVE_ROSTER_ROW_SQL`, `removesLeagueClockReset`, `removeChannel`, …) or `CONTENTION_CLOCK_UNMOVED` — they are unrelated English.
- Any behaviour, arithmetic, gate-set, or SQL-shape change.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Replay of pre-rename history | `auction_events` rows with `event_type = 'RosterMoveRecorded'` | Fold and Audit Log render exactly as before the rename | N/A |
| Destination catalog | Auction and Contract Assignment phases, Commissioner | `roster-trade` at `/roster-trade`, labelled *Record a Roster Trade*; absent when Archived and for Managers | unchanged guards |
| Old URL | `GET /roster-move` | 404 — no redirect is in scope | N/A |
| Constant drifts from wire | Someone edits `ROSTER_TRADE_RECORDED_EVENT`'s **value** | The literal-value test fails | test failure |
| §10 examples 36–39 | unchanged fixtures | Same figures, same refusals, same gate outcomes | N/A |

</frozen-after-approval>

## Code Map

**Files to `git mv` (source, then the three tests beside them, then the route):**
- `src/lib/core/rules/roster-move.ts` → `roster-trade.ts`; `src/lib/server/roster-move.ts` → `roster-trade.ts`; `src/routes/roster-move/` → `src/routes/roster-trade/` (`+page.server.ts`, `+page.svelte`).
- `tests/roster-move.test.ts`, `tests/routes/roster-move.test.ts`, `tests/server/roster-move.test.ts` → `roster-trade.test.ts`.

**The wire name and the fold (`src/lib/core/projection/contracts.ts`):**
- `:403` `ROSTER_MOVE_RECORDED_EVENT = 'RosterMoveRecorded'` → `ROSTER_TRADE_RECORDED_EVENT`, **value unchanged**; `:383` docblock states AD-4.
- `:418` `RosterMoveTransfer` → `RosterTradeTransfer`; `:444` `RosterMoveTeamFigures` → **`RosterActTeamFigures`** (the Drop uses it too); `:465` `RosterMoveRecordedPayload` → `RosterTradeRecordedPayload`; `:657-688` the reducer case; `:388` comment naming `rules/roster-move.ts`.

**The four shared types (`src/lib/core/types.ts`):**
- `:1052` `MoveLeadingAuction` → `ActLeadingAuction`; `:1078` `MoveCapGateOutcome` → `ActCapGateOutcome`; `:1110` `MoveSlotsGateOutcome` → `ActSlotsGateOutcome`. Consumed by `roster-act.ts:225,282,369`, `roster-drop.ts`, `reason-sheet-view.ts`.
- `:969` `RecordRosterMove` → `RecordRosterTrade`; `:1011` `RECORD_ROSTER_MOVE_GATES` → `RECORD_ROSTER_TRADE_GATES`; `:1020` `RecordRosterMoveGate`; `:1136` `RecordRosterMoveGateResults`. `:957` comment.

**The rule (`src/lib/core/rules/roster-move.ts` → `roster-trade.ts`):**
- `:82` `export const describeMoveAmount = describeActAmount` — **deleted**, not renamed. Its call sites (`reason-sheet-view.ts` ×6, `routes/roster-trade/+page.server.ts` ×3, `routes/roster-drop/+page.server.ts` ×3, `tests` ×5) import `describeActAmount` from `core/rules/roster-act.ts` directly — which the alias's own docblock already says it is.
- `:107` `MovingPlayer` → `TradingPlayer`; `:132` `MovingTeam` → `TradingTeam`; `:150` `RosterMoveState` → `RosterTradeState`; `:169-170` `MoveTeamFigures`/`MoveTransfer` aliases → `TradeTeamFigures`/`TradeTransfer`; `:173` `RosterMoveDelta` → `RosterTradeDelta`; `:190` `RosterMoveRefusal`; `:208` `MoveOutcome` → `TradeOutcome`; `:264` `evaluateMove` → `evaluateTrade`; `:469` `allMoveGatesPassed` → `allTradeGatesPassed`; `:485` `rosterMoveRefusalDetail`; `:491` the `same_team` sentence.

**The write path (`src/lib/server/roster-move.ts` → `roster-trade.ts`):**
- `:89` `MOVE_ROSTER_ROW_SQL` → `TRADE_ROSTER_ROW_SQL` (**SQL text unchanged**); `:96` `RosterMoveInput`; `:113` `RosterMoveRejection`; `:120` `LoadedRosterMoveState`; `:149` `movingTeamFor` → `tradingTeamFor` (and its throw message at `:176`); `:270` `RosterMovePreview`; `recordRosterMove`, `loadRosterMoveState`, `loadRosterMoveTeams`, `previewRosterMove`.

**Surface and catalog:**
- `src/lib/server/destinations.ts:126,139` — both phase arrays: id, label and href all become trade.
- `src/lib/reason-sheet-view.ts:39-40` imports; `:216,219,306` comments; `:307` `rosterMoveReasonRows`; `:323` `rosterMoveActSentence`; `:345` `ROSTER_MOVE_COMMIT_LABEL = 'Record the Roster Move'` → `ROSTER_TRADE_COMMIT_LABEL = 'Record the Roster Trade'`.
- `src/lib/core/audit-log.ts:69` import, `:761` `renderRosterMove` → `renderRosterTrade`, `:769` headline, `:1065-1067` `RENDERERS` entry and `label: 'Roster Move recorded'`, `:1139` docblock. **`RENDERERS` is open** — a missed key fails silently at runtime, not at compile time, so the audit-log test is the only proof.
- `src/routes/roster-trade/+page.server.ts:60` `ROSTER_MOVE_DESTINATION_ID`/`'roster-move'`, `:201` cancel href, `:273` result sentence; `+page.svelte:74,79,93,101,112,152,202` title, heading, prose and three `action`/`href` values.
- Prose-only mentions to update: `src/lib/core/rules/bidding.ts:1600,1612,1881`, `roster-act.ts:2,11,28`, `roster-drop.ts:29,99`, `server/roster-drop.ts:29`, `server/audit-log.ts:171`, `routes/roster-drop/+page.server.ts:7`, `routes/audit-log/+page.svelte:351`.

**Tests that name paths or copy (read-only evidence):**
- `tests/destinations.test.ts:82,87,91` — the id in **both** phase lists.
- `tests/reason-sheet.test.ts:329-330,373-374` — route file paths in a source-text list.
- `tests/roster-move.test.ts:637-639,676` — `code()`/`read()` source paths, including the negative `BidCancelled` assertion.
- `tests/routes/roster-move.test.ts:113,161,177-178,299` — dynamic import path, URLs, commit label.
- `tests/examples/example-36…39`, `example-42`, `tests/core/audit-log.test.ts:546`, `tests/projection-contracts.test.ts:469` — imports and describe names.
- `tests/structure.test.ts:185` — comment naming `RecordRosterMove`. The §10 registry lists **example file names**, which do not change.

**Already done — verify, do not re-do:** `ARCHITECTURE-SPINE.md` AD-32 was amended on 2026-09-12 by the approved Sprint Change Proposal: it already says *Roster Trade* and already names the event `RosterMoveRecorded` (`:308-316`). The AC's "fix the drift" is discharged; confirm by grepping the spine for `RosterMoved` and expecting no hit. `reviews/` and `.memlog.md` still carry the old wording and must **not** be edited — they are historical records.

## Tasks & Acceptance

**Execution:**
- [x] `git mv` the six files and the route directory -- rename first, before any content edit -- history follows the code.
- [x] `src/lib/core/projection/contracts.ts` -- rename the constant, the three payload types (`RosterMoveTeamFigures` → `RosterActTeamFigures`), and the reducer case; leave the string literal alone and comment it with AD-4.
- [x] `src/lib/core/types.ts` -- rename the command, gate set, gate-name and gate-results types to Trade; rename the three shared outcome types to **Act**.
- [x] `src/lib/core/rules/roster-trade.ts` -- rename the module's own symbols; **delete** the `describeMoveAmount` alias.
- [x] `src/lib/core/rules/roster-act.ts` + `roster-drop.ts` -- take the Act-renamed types and the now-direct `describeActAmount` imports -- these files change only because the shared vocabulary moved.
- [x] `src/lib/server/roster-trade.ts` -- rename its exports and `tradingTeamFor`; SQL text untouched.
- [x] `src/lib/server/destinations.ts` -- `destination('roster-trade', 'Record a Roster Trade', '/roster-trade', true)` in **both** phase arrays.
- [x] `src/lib/reason-sheet-view.ts` -- rename the two builders and the commit label, and import `describeActAmount` from `roster-act.ts`.
- [x] `src/lib/core/audit-log.ts` -- rename the renderer and its `RENDERERS` key/label; the key is `ROSTER_TRADE_RECORDED_EVENT`, whose value is still the old wire string.
- [x] `src/routes/roster-trade/+page.server.ts` + `+page.svelte` -- destination id, hrefs, form actions, title, heading, prose, result sentence.
- [x] `src/lib/core/rules/bidding.ts` and the other prose-only files listed in the Code Map -- comments only.
- [x] `tests/**` -- follow every rename; add the literal-value assertion for `'RosterMoveRecorded'` in `tests/projection-contracts.test.ts`; update `tests/destinations.test.ts` in both lists; update the source-path lists in `tests/reason-sheet.test.ts` and the renamed `tests/roster-trade.test.ts`.

**Acceptance Criteria:**
- Given the finished rename, when `npm test`, `npm run check` and `npm run build` run, then all three pass and no test's assertion changed in meaning.
- Given `git grep -i "roster.move"` over `src/`, when it runs, then it returns only the `'RosterMoveRecorded'` literal and the comment explaining why it is frozen.
- Given a grep for `Move`, `MOVE` and `Moving` as identifier fragments over `src/`, when it runs, then it matches no identifier — only the frozen literal, `remove*`/`unmoved` English, and `CONTENTION_CLOCK_UNMOVED`.
- Given a Commissioner in the Auction Phase, when the destination catalog is read, then `roster-trade` is present with the trade label and `roster-move` is absent from both phase lists.
- Given the Audit Log folded over history written before the rename, when it renders, then the entry appears with the new label and the same figures — proving the key still matches the persisted string.
- Given the diff, when it is reviewed, then it contains no change to any SQL text, gate set membership, arithmetic expression, or payload shape.

## Spec Change Log

## Design Notes

**Why `MovingTeam`/`MovingPlayer` rename too.** They are not literally spelled "Move", so the AC's grep would pass either way — but they are the trade module's own types, and Story 7.11's within-Team Move will need exactly that vocabulary. Leaving them is the collision this story exists to remove, one story later and harder to see. The Drop already avoided them (`DroppablePlayer`), which is the precedent.

**Why the alias is deleted rather than renamed.** `describeMoveAmount` exists only because Story 7.8 moved the renderer to `roster-act.ts` and did not want to touch every call site that day. Renaming it to `describeTradeAmount` would re-create the same indirection under a name that is now *wrong* — the Drop's route reaches it too. Point every site at `describeActAmount`.

**The one thing that can break silently.** `RENDERERS` in `audit-log.ts` is `Readonly<Record<string, AuditEntry>>`, so a key that no longer matches the persisted event type compiles cleanly and renders nothing. The renderer is keyed by `ROSTER_TRADE_RECORDED_EVENT` and that constant must keep the old value; the literal-value test is what makes this a compile-or-test failure rather than a blank Audit Log entry discovered in production.

## Verification

**Commands:**
- `npm run check` -- expected: zero errors.
- `npm test` -- expected: full suite green, including the new literal-value assertion.
- `npm run build` -- expected: passes, including `scripts/check-core-purity.js` for the renamed `core/rules/roster-trade.ts`.
- `git grep -i "roster.move" -- src` -- expected: the frozen literal and its comment, nothing else.
- `git status` -- expected: renames shown as renames (`R`), not add+delete.

**Manual checks:**
- Sign in as Commissioner in the Auction Phase: `/roster-trade` loads, reads *Record a Roster Trade*, and records a trade whose sheet and result sentence say Trade throughout; `/roster-move` 404s.
- Open the Audit Log and confirm a trade recorded **before** this story still renders, now labelled *Roster Trade recorded* — this is the only check that proves the wire name survived.

## Suggested Review Order

**The one thing that is deliberately not renamed**

- The whole story turns on this line: new constant, old wire value.
  [`contracts.ts:411`](../../src/lib/core/projection/contracts.ts#L411)

- The renderer key that silently breaks if that value ever drifts.
  [`audit-log.ts:1065`](../../src/lib/core/audit-log.ts#L1065)

- The assertion that makes the drift a test failure, not a blank entry.
  [`projection-contracts.test.ts:479`](../../tests/projection-contracts.test.ts#L479)

- Folds a pre-rename wire string and proves it renders under the new label.
  [`audit-log.test.ts:554`](../../tests/core/audit-log.test.ts#L554)

**Act versus Trade — why the shared types went the third way**

- Shared by Trade and Drop, so named for `roster-act.ts`, not either caller.
  [`types.ts:1078`](../../src/lib/core/types.ts#L1078)

- Same reasoning on the payload side; the Drop reuses it unchanged.
  [`contracts.ts:452`](../../src/lib/core/projection/contracts.ts#L452)

- Trade-specific by contrast: its own command type keeps its own gate set.
  [`types.ts:1011`](../../src/lib/core/types.ts#L1011)

**The act itself**

- The rule entry point, renamed whole; no arithmetic touched.
  [`roster-trade.ts:252`](../../src/lib/core/rules/roster-trade.ts#L252)

- The `UPDATE` of `team_id`; constant renamed, SQL text byte-identical.
  [`roster-trade.ts:95`](../../src/lib/server/roster-trade.ts#L95)

**The surface a Commissioner sees**

- Both phase arrays: id, label and href all move together.
  [`destinations.ts:126`](../../src/lib/server/destinations.ts#L126)

- The route's own id, which must match the catalog entry exactly.
  [`+page.server.ts:61`](../../src/routes/roster-trade/+page.server.ts#L61)

- User-facing copy: the dashed commit control's label.
  [`reason-sheet-view.ts:346`](../../src/lib/reason-sheet-view.ts#L346)

**Peripherals**

- The new guard: no `/roster-move` route survives, and no redirect was added.
  [`roster-trade.test.ts:650`](../../tests/roster-trade.test.ts#L650)

- Untouched by design — the Drop's `delete`, restored after a bad substitution.
  [`roster-drop.ts:99`](../../src/lib/server/roster-drop.ts#L99)
