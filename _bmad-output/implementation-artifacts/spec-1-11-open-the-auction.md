---
title: 'Story 1.11: Open the auction'
type: 'feature'
created: '2026-08-25'
status: 'done'
review_loop_iteration: 0
baseline_commit: '37d58c3bca93d12f64f7f8f670325db33444b566'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Thirty managers arrive at a 12:00pm start. Nothing today can move the League out of Setup, and nothing checks that the League is actually ready — the phase reducer has no transition case at all, and no code anywhere asks whether all thirty-one import sources were promoted or whether every Team has a Manager who can act.

**Approach:** One Commissioner-only gate at `/auction-open` that folds its answer from the event log, names everything outstanding rather than counting it, reports the Minor League Eligible count for confirmation without blocking on it, and — on an explicit confirm — appends a single `AuctionOpened` event that folds the phase to Auction and gives the League Clock its origin.

## Boundaries & Constraints

**Always:** Readiness is derived inside the transaction, under the global lock, from the log plus live tables — never from a status column. Promoted-ness comes from the latest `ImportPromoted` event's payload, never from `import_team_sources.status`, which stays `'staged'` forever. Outstanding Teams, outstanding sources and Teams without a Manager are **named**, never counted. Every refusal sentence has exactly one definition in the pure core. The gate re-derives every check under the lock regardless of what the page rendered.

**Ask First:** Any change to the two League Clock reset events (AD-22). Any second write path to `auction_events` for phase transitions.

**Never:** No `nomination_slots` table or column — the Slot projection is Story 2.1's, folded from this event. No notification of any kind: AD-17's outbox does not exist and is Epic 5.1's. No Bid Board or empty-board screen — Epic 2 owns `/board`. No re-open, no un-open, no override path. No blocking on the eligibility count. No hand-edit of `ARCHITECTURE-SPINE.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ready and confirmed | Log holds `ImportPromoted` with 30 teams + poolSize > 0; every Team has a bound Manager; phase Setup; `confirm=yes` | One `AuctionOpened` event appended carrying actor, db `now()`, stamped `schemaVersion`/`coreVersion`; phase folds to Auction; clock origin set | N/A |
| Never promoted | No `ImportPromoted` event in the log | Refused `not_promoted`; the sentence states that no import has been promoted | Nothing written |
| Partial promotion | Latest `ImportPromoted` payload names fewer than 30 Teams, or `poolSize` is 0 | Refused `outstanding_sources`, naming each missing Team and the pool by label | Nothing written |
| Team without a Manager | `teams left join managers` yields rows with no Manager | Refused `unbound_teams`, naming each Team | Nothing written |
| Already open | Phase folds to Auction (or later) | Refused `phase`, naming the folded phase | Nothing written |
| Unconfirmed submit | Gate passes but `confirm !== 'yes'` | `fail(400)` with the confirmation sentence; no transaction opened | Nothing written |
| Unbound actor | Session registered but `manager.teamId` is null | `fail(400)` worded by the core; no transaction opened | Nothing written |
| Zero eligible Players | Gate otherwise passes, eligibility fold is empty | Opens normally; the report states the count is zero in words | N/A |
| Mid-transaction failure | Insert throws after BEGIN | Rollback; no event, no phase change | Rethrown as a bug |

</frozen-after-approval>

## Code Map

Read 1.10's Code Map and Design Notes first — `runTransactionalWrite`, the core-worded refusal discipline, the "server renders, surface prints" split and the guard-on-load-and-every-action rule are reused, not re-derived. **No migration:** phase, promoted-ness and the clock are all folds; nothing is stored. `/auction-open` is already a registered Commissioner-only Setup destination (`server/destinations.ts:72`) with no route behind it.

- `src/lib/core/projection/phase.ts` -- extend. Add `AUCTION_OPENED_EVENT = 'AuctionOpened'` and the single `case` its docblock (`phase.ts:9-13`) reserves for this story, returning `'Auction'`; the `default: return state` discipline is unchanged. This one case is what makes 1.9's and 1.10's phase gates reachable end-to-end — see Tasks.
- `src/lib/core/projection/promotion.ts` -- new, pure. `promotedSourcesReducer`: folds the latest `ImportPromoted` payload (`server/import-promotion.ts:62,231-238`) into `{ teamIds, teamNames, poolSize }`, later promotions replacing earlier ones wholesale — promotion is all-or-nothing (AD-28), so a fold that merged them would invent a state promotion never produces. `INITIAL_PROMOTION` is empty. First reader of that event: it has none today.
- `src/lib/core/projection/league-clock.ts` -- new, pure. `leagueClockReducer` folding `AuctionOpened` into the clock's **origin**; `LEAGUE_CLOCK` (`core/constants.ts:53`) is added by the shell to get an absolute expiry, so the core never learns the time (AD-3). Nomination and Bid resets are Epic 2's and are deliberately absent — see Design Notes.
- `src/lib/core/rules/auction-open.ts` -- new, pure. `AuctionOpenRefusal` union (`phase` | `not_promoted` | `outstanding_sources` | `unbound_teams` | `unconfirmed` | `unbound_actor`) and `auctionOpenRefusalDetail()`, mirroring `eligibilityRefusalDetail` (`rules/eligibility.ts:176`). `refuseAuctionOpen(state)` returning the first refusal or `null`, exported so it is unit-testable independently of the transaction. `preOpenReport(state)` returning the named outstanding items and the eligible-Player count as a finished sentence.
- `src/lib/server/auction-open.ts` -- new, server-only. `loadAuctionOpenState(client)`: one `loadEventsViaClient` (`server/event-log.ts:110`) folded three ways — phase, promotion, eligibility — plus `select t.id, t.name from teams t left join managers m on m.team_id = t.id` (`20260821010000_teams.sql:61`) for the unbound-Team names. `openAuction(gateway, actor, confirmed)`: one `runTransactionalWrite` (`shell/write.ts:179`) whose `decide` returns `rejected` with a worded detail or `accepted` with exactly one `EventEnvelope`. **No `projections` hook** — nothing is persisted.
- `src/routes/auction-open/+page.server.ts` -- new. Both guards on `load` and on the single `open` action, commissioner → destination (`routes/minor-league-eligibility/+page.server.ts:60-64`); the `confirm !== 'yes'` check mirrors `routes/import/+page.server.ts:150-158`; unbound actor as a returned `fail(400)`, not a throw.
- `src/routes/auction-open/+page.svelte` -- new. `commissioner-block` + `control-commissioner`; the pre-open report as named lists, never counts, with the eligibility count stated in a sentence beside the confirm; the single confirm disabled from one flag with an always-present reason element carrying a stable id (`tests/signin-surface.test.ts:261-276` enforces this); stacked at 375px, table at the 640px breakpoint `/import` established. Types declared structurally, never imported from `$lib/server`.
- Tests -- `tests/core/auction-open.test.ts` (each reducer's fold + double-replay convergence, every refusal sentence, the report's naming); `tests/server/auction-open.test.ts` (stateful fake `ConnectionGateway` per `tests/server/eligibility.test.ts:29-135`: every matrix row, the rollback, and that a rejection appends nothing); `tests/routes/auction-open.test.ts` (both guards; unconfirmed and unbound actor refuse). **Extend** `tests/server/import-promotion.test.ts` and `tests/server/eligibility.test.ts` with the now-reachable end-to-end phase rejection. Assert a discriminant before narrowing.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/phase.ts` -- the event type and its one case -- AC3
- [x] `src/lib/core/projection/promotion.ts` -- fold promoted-ness from the log -- AC1
- [x] `src/lib/core/projection/league-clock.ts` -- the clock's origin -- AC4
- [x] `src/lib/core/rules/auction-open.ts` -- the gate, the refusal wording, the pre-open report -- AC1, AC2, AC5
- [x] `src/lib/server/auction-open.ts` -- the read and the one transaction -- AC1, AC3
- [x] `src/routes/auction-open/+page.server.ts` -- guards, confirm, outcome mapping -- AC2, AC5
- [x] `src/routes/auction-open/+page.svelte` -- the report and the confirmation -- AC2, AC5
- [x] Tests per Code Map, including the two now-reachable phase gates -- covers the I/O matrix

**Acceptance Criteria:**
- Given a League missing any promoted source or any Team's Manager, when the Commissioner attempts to open, then it is refused and every outstanding item is named individually rather than counted.
- Given the pre-open report, when it renders, then it states the number of Players marked Minor League Eligible in words and does not block on that number whatever its value.
- Given a gate that passes and a Commissioner who confirms, when the auction opens, then exactly one `AuctionOpened` event is appended carrying actor, timestamp, `schemaVersion` and `coreVersion`, and the phase projection folds to Auction with no flag set anywhere.
- Given the auction has opened, when the League Clock is folded, then its origin is that event and its expiry is 48 hours from it.
- Given the auction has opened, when a promotion or an eligibility change is attempted through its own transaction, then each is refused with the phase named — the end-to-end cases 1.9 and 1.10 logged as unreachable.
- Given the surface, when inspected, then every control is a Commissioner control, every disabled control states its reason, and each refusal sentence has exactly one definition in the pure core.

## Spec Change Log

## Design Notes

**Why promoted-ness is folded from an event rather than read from a column.** `import_team_sources.status` and `import_pool_source.status` stay `'staged'` after promotion — there is no `promoted_at` and no promotion table (`import-promotion.ts:117-178`). `outstandingSourceNames` (`server/import-status.ts:190`) was written for this gate but answers *staged*, not *promoted*, so it is deliberately **not** reused here; the two questions differ and collapsing them would let a fully staged, never-promoted League open. The `ImportPromoted` payload already names all thirty Teams and the pool size, so it answers the gate's exact question and is all-or-nothing by construction.

**Why `AuctionOpened` is the clock's origin and not a reset.** AD-22 fixes the reset set at exactly two event types and says new types default to not resetting. An origin is a different thing: a reset can be unwound by a compensating `BidVoided`, whereas the open can never be unwound, so folding the origin separately keeps AD-22's invariant intact rather than widening it. The AD does not yet say this in writing — logged to `deferred-work.md` for a `bmad-correct-course` run.

**Why no Nomination Slot table.** "All 30 Teams receive an unused Nomination Slot" is a statement about the fold, not about storage. Projection tables are created by the story that first *reads* them (AD-5, epic-1-context.md); the first reader is Story 2.1's nomination command. This story appends the event 2.1 folds.

## Verification

**Commands:**
- `npm test` -- all pass, including the purity, pins and structure gates
- `npm run check` -- clean

**Manual checks (if no CLI):**
- As Commissioner at `/auction-open` with a partially imported League: confirm every outstanding Team and the pool are named on screen, that the page is legible at 375px without lateral scrolling, and that a greyscale screenshot still distinguishes these controls from a Manager control.

## Suggested Review Order

**The phase finally moves**

- Entry point — the one case the whole story hangs on; the reducer's shape is unchanged.
  [`phase.ts:62`](../../src/lib/core/projection/phase.ts#L62)

- Promoted-ness folded from the event, because no status column ever says "promoted".
  [`promotion.ts:108`](../../src/lib/core/projection/promotion.ts#L108)

- One declaration of the event string, re-exported by the writer — drift here refuses a promoted League forever.
  [`import-promotion.ts:73`](../../src/lib/server/import-promotion.ts#L73)

- The clock's origin, not a reset: AD-22's two-event reset set is not widened.
  [`league-clock.ts:53`](../../src/lib/core/projection/league-clock.ts#L53)

**The gate, in order**

- The gates in refusal order; a refusal is a returned value, never a throw.
  [`auction-open.ts:173`](../../src/lib/core/rules/auction-open.ts#L173)

- Zero Teams is refused outright — every other source check derives from the live table.
  [`auction-open.ts:183`](../../src/lib/core/rules/auction-open.ts#L183)

- Outstanding sources named individually; a count is useless at 11am on setup day.
  [`auction-open.ts:211`](../../src/lib/core/rules/auction-open.ts#L211)

- Seven refusals worded once, for route, transaction and tests alike.
  [`auction-open.ts:101`](../../src/lib/core/rules/auction-open.ts#L101)

- The eligible count as a sentence the surface prints, never a gate.
  [`auction-open.ts:266`](../../src/lib/core/rules/auction-open.ts#L266)

**The one transaction**

- The whole write path: lock, fold three ways from one log read, decide, append.
  [`auction-open.ts:179`](../../src/lib/server/auction-open.ts#L179)

- Three projections folded over a single `loadEventsViaClient` read.
  [`auction-open.ts:87`](../../src/lib/server/auction-open.ts#L87)

- The render path takes no lock and always rolls back — the render is never the check.
  [`auction-open.ts:140`](../../src/lib/server/auction-open.ts#L140)

**The surface**

- Both guards on the action, and the confirmation checked before any transaction opens.
  [`+page.server.ts:59`](../../src/routes/auction-open/+page.server.ts#L59)

- The single Commissioner control, disabled from one flag with an always-present reason.
  [`+page.svelte:168`](../../src/routes/auction-open/+page.svelte#L168)

- Stacked at 375px, a real table at 640px — the breakpoint `/import` established.
  [`+page.svelte:286`](../../src/routes/auction-open/+page.svelte#L286)

**Peripherals**

- Every reducer's fold, double-replay convergence, and each refusal sentence.
  [`auction-open.test.ts`](../../tests/core/auction-open.test.ts)

- Every matrix row: each refusal, the rollback, and the empty-teams open.
  [`auction-open.test.ts`](../../tests/server/auction-open.test.ts)

- The drift pin: writer and fold held to one string.
  [`auction-open.test.ts:409`](../../tests/server/auction-open.test.ts#L409)

- The two gates 1.9 and 1.10 logged as unreachable, now driven end to end.
  [`import-promotion.test.ts`](../../tests/server/import-promotion.test.ts)
