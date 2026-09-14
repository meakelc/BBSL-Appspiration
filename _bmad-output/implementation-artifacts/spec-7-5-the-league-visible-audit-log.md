---
title: 'Story 7.5: The league-visible Audit Log'
type: 'feature'
created: '2026-09-11'
baseline_commit: '1af48bad7af524b0e565a754caa5b2e50b015731'
status: 'done'
review_loop_iteration: 1
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `auction_events` has been insert-only and complete since Story 1.5, and nineteen event types now append to it — but nothing in `src/` reads it for a human. `resolveLeagueRead` is the log's only reader and it folds into projections. The `audit-log` destination is already registered at `/audit-log` in three phase catalogs and leads nowhere. Until it does, a Roster Move — the one Commissioner act deliberately *not* broadcast to Discord (FR-41) — changes two Teams' figures with no announcement and no surface to look it up on. 7.5 is on the critical path for exactly that reason.

**Approach:** A read-only route that folds nothing. One pure module turns each `AppendedEvent` into a normalized `AuditRow` — actor, instant, sentence, detail rows, and the Team and Player ids the filters match on — so filtering is uniform over the derived row and never over nineteen payload shapes. The page renders those rows; a sibling `+server.ts` serves the same filtered rows as CSV. No new table, no migration, no event.

## Boundaries & Constraints

**Always:**
- The Log is a read of `auction_events` and nothing else. One full-log read per request through the existing `loadEventsViaClient`, in one transaction that always rolls back — no lock, mirroring `server/board.ts`'s read discipline.
- **Completeness is the load-bearing property.** An event whose `event_type` has no renderer still renders, as its envelope plus raw payload, and is still exported and still counted. Dropping an unrecognized row is the one defect this surface cannot have. `BidVoided` (`projection/league-clock.ts:108`) is declared and never yet emitted — it must render the day 7.2 emits it, with no change here.
- **No money rendering may throw.** `formatMoney` raises `RangeError` off the $500,000 grid; in the Log that would take the whole page down rather than one cell. Off-grid falls back to `formatExactDollars`.
- Money renders at exactly one decimal (`formatMoney`). Teams spell out with the Manager attached (`formatTeamManager`); a three-letter abbreviation means the player's NBA team and nothing else.
- An unattributed event — the null `manager_id`/`team_id` pair the system-actor migration permits — renders as the system acting, never as the Commissioner.
- The export carries the filters in force and the same rendered content as the page.
- `requireLiveDestination(..., 'audit-log')` runs first on both the page load and the export handler, before any read.

**Ask First:**
- Any change to `src/lib/server/destinations.ts` or its catalogs, including adding `audit-log` to `Setup`.
- Any migration, any new `auction_events` column, or any read of `contention_seeds`.
- Adding pagination, or any dependency for CSV serialization.

**Never:**
- No edit, delete, redact or "correct" affordance anywhere on the surface — no form action, no POST, no button that mutates.
- No second table, no projection, no cache, no materialized audit view.
- No read of `contention_seeds`. A seed reaches this surface only because a `ContentionDrawn` payload already carries it.
- No client-JS dependency for filtering or export: a `method="get"` form and an ordinary link.
- No new event type, and no write path of any kind.
- Not Story 7.2's void, 7.3's overrides or 7.4's pause — only the rendering they will inherit.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Full log | Events of every known type | One row each, newest first, every type rendered | N/A |
| Unknown type | `event_type` with no renderer | Envelope row plus raw payload; counted and exported | Never dropped, never thrown |
| Draw entry | `ContentionDrawn` (drawn) | Revealed seed, ordered contender list in payload order, and the selection | N/A |
| Undrawn contention | `ContentionDrawn` (dissolved) | Seed revealed, stated as dissolved with no winner | N/A |
| Override entry | Payload carrying before/after/reason | Actor, timestamp, before → after rows, the free-text reason verbatim | N/A |
| Roster Move | `RosterMoveRecorded` | One entry, both Teams' before/after figures, Players named, reason | N/A |
| System event | `manager_id` and `team_id` both null | Attributed to the system, not to any Manager | N/A |
| Off-grid money | A payload amount off the $500,000 grid | That cell renders exact dollars; the page still renders | No throw |
| Filter by Team | `?team=<id>` | Only rows naming that Team, either side of a Move | Unknown id → empty result, stated |
| Filter by Player | `?player=<id>` | Only rows naming that Player | Unknown id → empty result, stated |
| Filter by type | `?type=<event_type>` | Only rows of that type | Unrecognized value → refused, not silently ignored |
| Combined filters | Team + Player + type together | Conjunction of all three | N/A |
| Export | Same query string on the export path | CSV of exactly the filtered rows, same order | N/A |
| Empty log | No events | Says the log is empty; not an error, not a blank page | N/A |
| Archived phase | phase = `Archived` | Readable in full by any Manager | N/A |
| Setup phase | phase = `Setup` | Refused by the destination guard — not in that catalog | 403 |

</frozen-after-approval>

## Code Map

- `src/lib/server/destinations.ts:114,127,135` -- `destination('audit-log', 'Audit Log', '/audit-log', false)` already registered in Auction, Contract Assignment and Archived; absent from `Setup:94-104`. **Read-only — do not widen.** `:176-184` `requireLiveDestination`, the gate to call first.
- `src/routes/board/+page.server.ts:41-59` -- **the route pattern to copy**: guard first, `loadX(writeGateway(), ...)`, return `{ phase, ... }`. No action on a read surface.
- `src/lib/server/board.ts:1-33` -- **the read pattern to copy**: one transaction, one `loadEventsViaClient`, batched reference reads never one per row, always rollback, no advisory lock. `:54` shows `formatTeamManager` in use.
- `src/lib/server/event-log.ts:123-126` -- `loadEventsViaClient(client)`, `select * from auction_events order by seq asc`. `:98-118` warns the read grows with the log and that a later-phase caller wants a bounded read — read it before considering pagination.
- `src/lib/shell/write.ts:208-225` -- `toAppendedEvent`; `actorId()` at `:219-220` preserves the null actor pair.
- `src/lib/core/types.ts:119-133` -- `AppendedEvent`. `:40-44` -- **the rule that no central event-type union exists**; this story adds a *rendering* registry, not a domain union, and it must stay total over unknown values.
- **The payload field names, verbatim from the declared types.** Every renderer reads THESE keys and no others. A key not in this table does not exist; inventing one produces a row that renders blank against the real log while passing any fixture written to match it. Open each type before writing its renderer.

| Event type | Payload type, declared at | Fields |
|---|---|---|
| `BidPlaced` | `rules/bidding.ts:3559` | `fantraxPlayerId`, `teamId`, `teamName`, `managerId`, `amount`, `closesAt`, `seedHash?` |
| `ContentionDissolved` | `rules/bidding.ts:3628` | `fantraxPlayerId`, `seed`, `seedHash`, `formerContenders[]`, `convertingTeamId`, `amount` — **no `teamId`/`teamName`** |
| `BidCancelled` | `rules/close.ts:675` | `fantraxPlayerId`, `playerName`, `cancelledSeq`, `teamId`, `teamName`, `managerId`, `amount`, `wasContentionEntry`, `causeFantraxPlayerId`, `causePlayerName`, `causeTeamId`, `restoration` |
| `AuctionClosed` | `rules/close.ts:525` | `fantraxPlayerId`, `playerName`, `teamId`, `teamName`, `managerId`, `winningAmount`, `capHit`, `placement`, `contention`, `contractYears`, `closedAt` |
| `AuctionTerminated` | `rules/phase-end.ts:138` | `fantraxPlayerId`, `playerName`, `teamId`, `teamName`, `managerId`, `expiredAt`, `evaluatedAt` — **no `reason`** |
| `ContentionDrawn` | `rules/close.ts:579-615` | `fantraxPlayerId`, `seed`, `seedHash`, `contenders[]` (ids, ordered), `drawnAt`; drawn adds `selectedIndex`, `winningTeamId`, `winningTeamName`, `winningManagerId`. Undrawn has `contenders: []` and the rest `undefined` — the union makes a half-drawn row unrepresentable. **No `playerName`.** |
| `NominationPlaced` | `server/nomination.ts:129` | `fantraxPlayerId`, `playerName`, `teamId`, `teamName`, `managerId` |
| `AuctionOpened` | `server/auction-open.ts:67` | `teams[{teamId,teamName}]`, `minorLeagueEligibleCount` — **no `openedAt`** |
| `ContractAssignmentOpened` | `rules/phase-end.ts:168` | `expiredAt`, `evaluatedAt`, `terminatedPlayerIds[]` — **no `terminatedCount`** |
| `ContractLengthAssigned` | `projection/contracts.ts:114` | `fantraxPlayerId`, `playerName`, `teamId`, `teamName`, `managerId`, `contractYears` |
| `RosterMoveRecorded` | `projection/contracts.ts:465` | `sendingTeamId/Name`, `receivingTeamId/Name`, `transfers[]`, `reason`, plus `sendingBefore/After` and `receivingBefore/After` as `RosterMoveTeamFigures{teamId,teamName,capSpace,rosterCount,injuryReserveOccupied,minorLeagueOccupied}` |
| `RosterMoveTransfer` | `projection/contracts.ts:418` | `fantraxPlayerId`, `playerName`, `fromTeamId/Name`, `toTeamId/Name`, `won`, `fromPlacement`, `toPlacement`, `capHitBefore`, `capHitAfter`, `winningAmount`, `clearedContractYears` — **render `won`, `winningAmount` and `clearedContractYears`; `won` is the Existing-vs-Auction Contract distinction the epic requires be visible** |
| `MinorLeagueEligibilitySet` | `projection/eligibility.ts:49` | `fantraxPlayerId`, `playerName`, `before`, `after` (booleans) |
| `AssignmentsSubmitted` | `projection/assignments.ts:44` | `teamId`, `teamName`, `managerId`, `assignedCount` |
| `AssignmentDeadlineSet` | `projection/assignment-deadline.ts:76` | `deadline`, `previousDeadline`, `managerId`, `teamId`, `teamName`, `setAt` |
| `AssignmentReminderIntervalSet` | `projection/assignment-deadline.ts:87` | `intervalHours`, `previousIntervalHours`, `managerId`, `teamId`, `teamName` |
| `AssignmentRemindersSent`, `AssignmentDeadlinePassed` | `projection/assignment-deadline.ts:107` | `deadline`, `outstandingTeamIds[]`, `outstandingPlayerCount`, `evaluatedAt` |
| `ImportPromoted` | `server/import-promotion.ts:250` | `teams[{teamId,teamName,rosterCount}]`, `poolSize` — **no `teamIds`/`teamNames`** |
| `BidVoided` | `projection/league-clock.ts:108` | Declared, never emitted. Story 7.2 defines the payload. Render it through the override shape alone and invent no field names for it. |

- Event-type constants, one per reducer -- `projection/auctions.ts:69,95,126`; `projection/nominations.ts:85,98,124`; `projection/draws.ts:60`; `projection/phase.ts:59,80`; `projection/contracts.ts:99,403`; `projection/eligibility.ts:33`; `projection/assignments.ts:41`; `projection/assignment-deadline.ts:50,53,62,65`; `projection/promotion.ts:30`; `projection/league-clock.ts:108`.
- `src/lib/core/types.ts:162,185` -- `RosterSlotKind = 'active_bench' | 'injury_reserve' | 'minor_league' | 'dead_money'` and `SlotPlacement = 'active_bench' | 'minor_league'`. **These are machine tokens and must never reach the reader** — word every one.
- `supabase/migrations/20260901000000_system_actor.sql:43` -- `check ((manager_id is null) = (team_id is null))`. The actor pair is null together or not at all, so a half-null row is unwritable; treat the pair as one decision in one place rather than testing each half separately.
- `src/lib/core/rules/close.ts:588-615` -- `DrawnContentionPayload`: `seed`, `seedHash`, `contenders` (ordered), and the selection. **The seed enters the log only here.**
- `src/lib/core/projection/contracts.ts:444-476` -- `RosterMoveRecordedPayload` and `RosterMoveTeamFigures`; `:453-463` states this payload *is* the audit entry.
- `src/lib/core/rules/override.ts:131-172` -- `OverrideActor`, `OverrideState`, `OverrideRecord` (`actor`/`before`/`after`/`reason`), shipped by 7.1 with zero call sites. Render against this shape so 7.2/7.3 need no change here.
- `src/lib/core/money.ts:169-187` -- `formatMoney`, one decimal, **throws `RangeError` off-grid** via `:155-158`. `:218-227` `formatExactDollars`, the fallback. `:237-239` `toExportDollars`/`ExportCell` — reserved for the Fantrax round-trip; **not this export.**
- `src/lib/core/team-identity.ts:36-39,69-77` -- `formatTeamManager` / `formatTeamManagers`. Module doc `:4-6` is the three-letter-abbreviation rule; `tests/team-identity.test.ts:35-41` asserts it.
- `src/lib/core/instant.ts:133-149,173-183` -- `formatInstant`, `relativePhrase`. UTC only; unparseable yields `'at an unknown time'` rather than throwing.
- `src/routes/api/watermark/+server.ts:48-75` -- **the only `+server.ts` precedent**: session refusal shape, `cache-control: no-store`. Global headers come from `hooks.server.ts` via `server/security-headers.ts:36-54` — do not re-add them.
- `src/routes/board/+page.svelte:726-768` -- the 375px single-column convention: `flex-direction: column`, `flex-wrap: wrap`, no fixed widths, stated in a comment. `:122-123,337-395` -- the board's filter control is `$state` + `bind:group`, **client-JS-only; deliberately not the pattern here.**
- `tests/routes/board.test.ts:39-54` -- the source-text assertion convention with `stripComments`. `vite.config.ts:6-9` -- `environment: 'node'`, so no `.svelte` renders under the suite.
- `tests/destinations.test.ts:79,88,92` -- asserts `audit-log` in the three catalogs; must stay green untouched.

## Tasks & Acceptance

**The rule that governs every task below.** Each renderer is written **from the declared payload type**, read at the anchor the Code Map table gives. Every fixture is built the same way — from the declared type, not from what the renderer happens to read. A fixture that cannot be produced by the emitter is a fixture that proves nothing, and it is how a renderer reading an invented key passes a green suite while rendering blank against the real log.

**Execution:**
- [x] `src/lib/core/audit-log.ts` -- new pure module: `AuditRow` (seq, instant, actor, type, headline, detail rows, and the Team/Player parties the filters match on), a per-type renderer registry keyed off the Code Map table, a total fallback for unrecognized types, the filter predicate, and the filter-option catalogue -- normalizing first is what lets three filters work over nineteen payload shapes without a switch in the route.
- [x] Every renderer names its Teams and Players as **parties**, not only as prose -- `ContentionDissolved`'s `formerContenders` and `convertingTeamId`, `ContentionDrawn`'s `contenders`, `ImportPromoted`'s `teams`, `AuctionOpened`'s `teams` and the marker events' `outstandingTeamIds` all become filterable parties -- a Team released by a dissolution must find that row under `?team=`, the same "either side" property a Move has.
- [x] **No raw id reaches the reader.** Where a payload carries a name, render it; where it does not (`contenders`, `outstandingTeamIds`, `ContentionDrawn`'s Player), the server resolves it. Word every `RosterSlotKind`/`SlotPlacement` token. A filter option whose name is unresolved is the one place an id may still show, and it is labelled as an id.
- [x] `src/lib/core/audit-export.ts` -- new pure module: CSV serialization of `AuditRow[]`, with its own escaping (quotes, commas, newlines, and a formula lead neutralized). Test the lead **after** trimming leading whitespace, so `" =1+1"` is guarded too. Say in the module doc that the guard is the one place the CSV deliberately differs from the page.
- [x] `src/lib/server/audit-log.ts` -- new read module following `server/board.ts`: one transaction, one `loadEventsViaClient`, always rollback, no lock. Its batched reference reads resolve **every party id any row names**, not only the envelope's `manager_id`/`team_id` -- that is what makes the previous task possible in one statement each rather than one per row.
- [x] `src/routes/audit-log/+page.server.ts` -- `requireLiveDestination` first, parse and validate the three query params, refuse an unrecognized `type` rather than ignoring it, return rows plus the filter state.
- [x] `src/routes/audit-log/+page.svelte` -- single-column rows, a `method="get"` filter form that round-trips without client JS, an export link carrying the current query string, and no control that mutates anything. A filter value absent from its option list still renders as the selected option, so the control can never read "Any" while a filter is in force.
- [x] `src/routes/audit-log/export/+server.ts` -- same guard, same filters, CSV response with `content-type: text/csv; charset=utf-8`, a `Content-Disposition` filename, and `cache-control: no-store`.
- [x] `tests/core/audit-log.test.ts` -- drive every I/O matrix row over the pure module, with **every fixture built from the declared payload type**. Cover: the unknown type, the null actor pair, the off-grid amount, an override whose `actor.teamId` names a Team no base renderer and no id-harvest already surfaces (assert it reaches `row.teams` and is matched by the Team filter), and an override state whose own key is literally `Reason` (assert one Reason row, not two).
- [x] `tests/audit-export.test.ts` -- CSV escaping including the whitespace-led formula case, and that a filtered export equals the filtered page rows.
- [x] `tests/routes/audit-log.test.ts` -- execute the load for the guard and param validation; source-text assertions that the surface carries no `method="post"`, no form action, and no edit or delete affordance. **Fixtures must carry non-null, distinct `manager_id`/`team_id` pairs**, and the stubbed client must answer the Manager and Team statements with rows, so name resolution actually executes; assert one statement each for N actors rather than N, and assert a resolved name reaches the rendered actor. Drive a read failure and assert it surfaces rather than rendering an empty Log.

**Acceptance Criteria:**
- Given the Log, when the repository is searched, then no table, projection or cache backs it and no role gained `UPDATE` or `DELETE` — `supabase/migrations/` is unchanged by this story.
- Given a Manager who is not the Commissioner, when they open `/audit-log` in the Auction, Contract Assignment or Archived phase, then they read the complete Log; given `Setup`, then the destination guard refuses with 403.
- Given an open Minimum-Bid Contention that has not drawn, when the Log renders, then no seed for it appears anywhere in the response, and `contention_seeds` was never queried — **both halves asserted**: a log holding a `BidPlaced` with a `seedHash` and no draw, whose whole rendered response and CSV are searched for the seed, and a query-log assertion. The content half matters because the unrecognized-type fallback serializes payloads verbatim.
- Given every event type in the Code Map table, when a row of that type renders, then each field that table lists is either rendered or deliberately omitted — and the omission is stated in a comment, never left to a silently-null read of a key that does not exist.
- Given the whole event log, when every row is rendered, then the count of rendered rows equals the count of events read, for every event type including one this story does not recognize.
- Given the Log at 375px, when it renders, then it is single column with no lateral scrolling, in every phase including Archived.
- Given an export event, when the Log renders, then it is **not** covered — no export event exists to render, because Epic 6 ships the export. This clause of FR-33 is deferred, not met, and is recorded here rather than silently dropped.

## Spec Change Log

### 2026-09-11 — iteration 1, `bad_spec`

**Triggering findings.** The Acceptance Auditor found five renderers reading payload keys no emitter writes (`ImportPromoted` → `teamIds`/`teamNames`; `AuctionOpened` → `openedAt`; `ContractAssignmentOpened` → `terminatedCount`; `ContentionDissolved` → `teamId`/`teamName`; `AuctionTerminated` → `reason`), and found the fixtures had been written to match those inventions rather than the declared types — so 69 tests passed while five event types would render blank against the real log, three of them losing their Team parties entirely. The Verification Gap reviewer found the same disease at route level: a single `row()` helper hardcoding `manager_id: null, team_id: null`, so both reference-read functions took their early return in all 18 tests, the batching assertion was vacuous, and the whole name-resolution path had no coverage. Blind Hunter and the Edge Case Hunter added raw ids and machine enum tokens reaching the reader, a formula guard bypassed by leading whitespace, a filter control reading "Any" while a filter is in force, and an untested `mergeOverride` team merge.

**What was amended.** The Code Map's one-line list of event types was replaced with a table enumerating every payload's field names verbatim, with the declaring anchor for each and explicit `no X` notes on the five that were invented. Tasks gained a governing rule that renderers and fixtures are both derived from the declared type; a task making every Team and Player a filterable *party* rather than only prose; a task forbidding raw ids and unworded enum tokens; a requirement that the server's batched reads resolve every party id, not just the envelope's; and named test requirements for the override-actor merge, the duplicate `Reason` key, the whitespace-led formula cell, the read-failure path and non-null route fixtures. Two acceptance criteria were added or strengthened — the sealed-seed AC now demands both halves, and a new AC requires every field in the table to be rendered or its omission commented.

**Known-bad state avoided.** An Audit Log that looks complete and tests green while five of nineteen event types render as bare headlines, and a Team released by a dissolution cannot find that event under its own filter — on the one surface whose entire purpose is that a Manager can check rather than trust.

**KEEP — these were right and must survive re-derivation.**
- The normalize-then-filter shape: one `AuditRow` with parties, so three filters work over nineteen payload shapes with no switch in the route.
- The registry as a *lookup with a total fallback*, not a union — an unrecognized type renders as envelope plus raw payload and is still counted and exported. Four tests covered this, including a payload that is not an object.
- `renderAuditAmount` testing `isOnMoneyGrid` and falling back to `formatExactDollars`, so `formatMoney`'s `RangeError` can never take the page down.
- `mergeOverride` rendering the `OverrideRecord` shape on *any* payload carrying it, so 7.2 and 7.3 need no change here.
- CSV escaping with the formula guard applied **before** quoting, so the apostrophe lands inside the quotes — and the decision that these cells are ordinary strings, never `ExportCell`.
- The server read's discipline: one transaction, one log read, one `select now()`, always rollback, no advisory lock.
- Filter options drawn from the **whole** Log rather than the filtered rows, so a filter can be widened without clearing it first.
- The type-filter catalogue as the union of the registry and the types present in the log, so an unworded type stays selectable.
- `seq`-descending ordering, and the executed negative test that no statement names `contention_seeds`.
- Both entry points running `requireLiveDestination` first, by name.

## Design Notes

**Why fixtures must come from the declared types.** This surface has no schema to check it. `event_type` is a free `text` column by design, `payload` is `jsonb`, and the renderer reads keys off an untyped record — so a renderer that reads `teamIds` where the emitter writes `teams` is not a type error, not a test failure, and not visible in the diff. The only thing standing between a wrong key and a blank row is where the fixture came from. Build each one from the type the emitter declares, and the mismatch becomes impossible; write it beside the renderer, and the test asserts the renderer against itself. This is the single discipline the first iteration lacked.

**Why a rendering registry does not contradict `types.ts:40-44`.** That rule forbids a central *domain* union — a list a reducer must be added to. This registry is a lookup from a string to a renderer, total by construction: an absent key produces the envelope fallback. Nothing breaks when a new event type ships without touching it; it renders plainly until someone writes its sentence. A `switch` with no `default` would invert exactly the property this surface needs.

**Why the export is not `ExportCell`.** `money.ts:229-235` reserves that brand for the Fantrax round-trip, where a `$14.5M` cell would corrupt an import. This CSV is a record of what the Log said, read by a human, so it carries the same one-decimal rendering the page shows. Epic 6's exports keep the brand; this one must never be reused as a Fantrax input.

**Why no pagination.** `event-log.ts:98-118` already warns the read grows with the log, and that warning stands — but every page in the app already folds the entire log on load (`server/phase.ts:159`), so the Log adds no new read cost, and filters are the specified remedy. If the log outgrows one page, the fix is the bounded read that module already names — a change to the reader, not to this surface.

**Ordering.** Newest first for reading, over `seq` and never `occurred_at`: a transaction queued on the global lock commits later while holding an earlier timestamp, so timestamp order would misreport causality in exactly the case an auditor is looking at.

## Verification

**Commands:**
- `npm test` -- expected: full suite green, including `tests/destinations.test.ts` and `tests/structure.test.ts` untouched.
- `npm run check` -- expected: no TypeScript or svelte-check errors.
- `npm run check:purity` -- expected: clean; `core/audit-log.ts` and `core/audit-export.ts` import nothing outside the core and use no `Date`, `Intl` or `Math.random`.

**Manual checks (if no CLI):**
- `git diff --stat` shows no file under `supabase/migrations/`, and no change to `src/lib/server/destinations.ts` or `src/lib/core/money.ts`.
- `grep -rn "contention_seeds" src/routes/audit-log src/lib/core/audit-log.ts src/lib/server/audit-log.ts` returns nothing.
