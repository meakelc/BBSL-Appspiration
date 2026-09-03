---
title: 'Story 4.5: View any Team'
type: 'feature'
created: '2026-09-03'
status: 'in-review'
baseline_commit: 'e94f0123474824ff608975d9dfa9efa3437100e4'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-BBSL-Appspiration-2026-08-16/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `teams` is a live destination in three phases (`destinations.ts:79,87,94`, `/teams`) with no route behind it. A Manager deciding whether a rival can actually chase a Player has no way to read that rival's position: Cap Space, Committed Bids and Available Cap Space exist only as fields on a *per-Auction* `CapGateOutcome` computed for the viewer's own Team on one Auction page, and `loadTeamRoster` (`server/team-roster.ts:113`) returns three bare numbers for the bid path alone. Nothing in the repository produces a team-level position for an arbitrary Team, and nothing lists a Team's roster at all.

**Approach:** One computation, `teamViewFor`, that answers the whole of CAP-10's published set for **one** Team from one folded state — so Story 4.6's index is thirty calls to it and a second implementation is structurally impossible. It reaches its money by the strip's own no-Auction probe through `evaluate()`, never by new arithmetic, and it is rendered at `/teams/[teamId]`.

## Boundaries & Constraints

**Always:**
- Every figure comes from `evaluate()`'s `CapGateOutcome` against the **no-Auction baseline probe** (`core/strip.ts:153-198`) — Cap Space, Committed Bids, of-which Minors Exposure, Available Cap Space, Roster Reserve, Maximum Bid, `freeMinorLeagueSlots`, `eligibleLeadingBids`, `overflowCount`. No figure is added, re-derived or recomputed by this story (AD-7:109). `baselineMaximumBid` is refactored to read the same outcome, so one probe exists and not two.
- `teamViewFor` takes **one** Team and is called per Team. That is the whole of "the index and the Team view cannot disagree" (`epic-4-context.md:56`) — a shape 4.6 iterates, not a shape 4.6 re-derives.
- Both gates always run and both are reported where a refusal is stated; a slot figure never stands in for a money one and vice versa (AD-7:111).
- One transaction, one `loadEventsViaClient`, batched reference selects, always `rollback`, rethrow on failure — `server/positions.ts:238-380`'s discipline exactly. No advisory lock.
- **Maximum Bid is shown for the viewer's own Team and no other** (`epic-4-context.md:20`), with its components broken out through the existing `capBreakdown` (`rules/bidding.ts:1992`) and `CapBreakdown.svelte`. A rival's Team view carries no Maximum Bid field at all — absent, not blanked.
- The Roster Count is Active/Bench only; Injury Reserve is stated and visibly outside the twelve; Minor League occupancy renders as `N of 3` (`DESIGN.md:183`). `ACTIVE_BENCH_SLOTS`/`MINOR_LEAGUE_SLOTS` are the source of both ceilings, never a literal.
- A won Player is a roster row on the same footing as an imported one — `contractRowsFor` already concatenates it (`team-roster.ts:135`), and this story's row listing concatenates `contractsWonBy` (`projection/contracts.ts:198`) so the name arrives with it.
- The page carries `figuresAgeSentence` page-level in anything but Live (AD-29). The index takes the *age* branch of the freshness rule, not the disable branch — there is no control here to disable (`EXPERIENCE.md:139`).
- Absolute times derive **only inside `$effect`** — the SSR-leak rule `positions/+page.svelte:216-260` establishes.
- Money through `formatMoney`/`describeAmount` only; a Team is spelled out with its Manager(s); a three-letter capital is the NBA team and nothing else.
- The guard is `requireLiveDestination(session, phase, 'teams')` FIRST, before any read.

**Ask First:**
- Any new `--size-*` token (`tokens.test.ts` pins exactly ten); any edit to a planning artifact; any change to `evaluate()`, to any gate, or to `teamMoneyStateFor`'s signature.

**Never:**
- The **League Median**, a comparison, a rank, an ordinal, a colour by comparison, an "above median" chip, or any word calling a Team rich, poor, stacked or thin (`EXPERIENCE.md:131-133`). The median is Story 4.6's and lives in `core/money` when it arrives.
- The **Teams index itself** — the thirty-row list, its sort chips and its `30 teams` count are Story 4.6. This story ships the single-Team view and the computation the index will call.
- A **Contract Assignment column swap** to Year Allotment. No `ContractLengthAssigned` event, no allotment projection and no `contract_length` column exists; the same gap Story 4.2 already logged.
- A second definition of any figure. Nothing computes Committed Bids, Available Cap Space or Minors Exposure outside `evaluate()`.
- A partial-information layer. Every figure but Maximum Bid renders identically for every viewer on every Team.
- A write, a lock, or any client write path. The route reads and rolls back.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Any Team, any viewer | a `teams` row exists | Cap Space, Committed Bids, of-which Minors Exposure, Available Cap Space, Roster Count `N of 12`, Free Active/Bench Slots, Minor League `N of 3`, Free Minor League Slots, Minors Exposure and Nomination Slot status all render | N/A |
| Rival Team | `teamId !== viewerTeamId` | **no** Maximum Bid field and no cap breakdown anywhere on the page | N/A |
| Viewer's own Team | `teamId === viewerTeamId` | additionally Maximum Bid, its `capBreakdown` rows, and the Auctions this Team leads or contends in | N/A |
| Own Team, unbounded Maximum Bid | `cap.unbounded` | stated in words, never as a number (FR-35) | N/A |
| Own Team, negative Maximum Bid | overcommitted Team | rendered as the negative it is, never floored (`strip.ts:185-190`) | N/A |
| Won Player, before assignment | `AuctionContract` for this Team | the Player is on the roster in his `placement` slot kind, and the counts include him | N/A |
| Roster over the ceiling | `rosterCount > 12` | `Roster 13 of 12` stated as the fact it is, never clamped (`strip.ts:108-118`) | N/A |
| Nomination Slot used | `nominationForTeam` non-null | names the Player and links to that Auction via `auctionPathFor` | N/A |
| Nomination Slot free | `nominationForTeam` null | states the Slot is free; no Nominate offer on a rival's page | N/A |
| Co-managed Team | two `managers` rows share `team_id` | every Manager named, Team named once | N/A |
| Team with no roster rows | zero `team_rosters` rows | Cap Space is exactly `SALARY_CAP`, Roster Count 0 — a real state, not an error | N/A |
| Unknown Team id | no `teams` row | `error(404)` — not an empty page | 404 |
| Wrong phase | Setup, whose catalog omits `teams` | 403 via `requireLiveDestination` | the guard |
| Signed-out viewer | non-registered session | 403 via `requireLiveDestination` — its list is `[Sign-in]` in every phase | the guard |
| Viewer bound to no Team | `viewerTeamId` null | every Team still renders in full; no page shows Maximum Bid | N/A |
| Freshness below Live | client not Live | page-level `figuresAgeSentence`; nothing is disabled, because nothing here authorises | N/A |
| Read fails | database unreachable | rollback, rethrow — never a page of zeroes | rollback, rethrow |

</frozen-after-approval>

## Code Map

- `src/lib/core/rules/bidding.ts` — `teamMoneyStateFor` `:596-647` (**team-level except for its `fantraxPlayerId` exclusion**; pass `NO_AUCTION_PROBE_ID` to exclude nothing, which is what makes the figure about the Team), `bidStateFor` `:502`, `evaluate` `:1550`, `evaluateCap` `:1300-1380` (every figure this story renders is a field it returns: `committedBids :1361`, `minorsExposure :1362`, `availableCapSpace :1363`, `rosterReserve :1366`, `maximumBid :1349`, `freeMinorLeagueSlots`/`eligibleLeadingBids`/`overflowCount` `:1368-1370`, `unbounded :1353`), `capBreakdown` `:1992-2070` (returns `CapBreakdownLine[]`; **empty for a null-Team outcome**, and its `label`s must stay unique — `CapBreakdown.svelte` keys its `{#each}` on `label`), `describeAmount` `:2114`. `CapGateOutcome` is `types.ts:470-500`.
- `src/lib/core/strip.ts:125-198` — `probeFor` `:153` and `baselineMaximumBid` `:191`, the no-Auction probe and every reason behind its four arguments. **Read this before writing anything.** This story lifts the outcome out of it: a new exported `baselineCapOutcome(team, phase, now): CapGateOutcome` returns `evaluate(bidStateFor(null, team, false, phase), probeFor(), now).cap`, and `baselineMaximumBid` becomes `baselineCapOutcome(...).maximumBid` — one probe, not two. `rosterCountSentence` `:120` and its overflow/negative reasoning are reused verbatim.
- `src/lib/server/strip.ts:57-114` `loadStripTeam` — the exact assembly this story generalises from one Team to a named Team: `begin` `:69`, one `loadEventsViaClient` `:77`, four folds `:78-85`, `teamMoneyStateFor({teamId, fantraxPlayerId: NO_AUCTION_PROBE_ID, ...await loadTeamRoster(...), auctions, isMinorLeagueEligible, playerNameFor})` `:87-102`, `rollback` `:104`. **It swallows every failure to `null` because its caller is `+layout.server.ts`** — this story's caller is a page, so it rethrows instead.
- `src/lib/server/team-roster.ts:113-146` `loadTeamRoster` — `select cap_hit, roster_slot_kind from team_rosters where team_id = $1` `:118-123`, concatenated with `contractRowsFor(contracts, teamId)` `:135`, then one loop `:140-143` producing `{capSpace, rosterCount, minorLeagueOccupied}`. It yields **no names**, so the roster listing needs the rows themselves; widen the select and return them beside the three figures rather than adding a second query with a second row set.
- `src/lib/core/projection/contracts.ts` — `AuctionContract` `:85-103` (`playerName`, `winningAmount`, `capHit`, `placement`, `closedAt`), `contractRowsFor` `:154-166` (`CapHitRow[]`, the Cap bridge, no name), `contractsWonBy` `:198-216` (**the named rows, newest `closedAt` first — Story 4.4 built it and this is its second caller**).
- `src/lib/core/projection/nominations.ts` — `OpenNomination` `:123-153`, `nominationForTeam` `:199-205` (non-null = Slot used).
- `src/lib/core/projection/auctions.ts` — `OpenAuctions.byPlayer` `:246`, `auctionForPlayer` `:266`, `contentionOf` `:278`. A Team's leads and contentions are already partitioned onto `TeamMoneyState.leading` / `.eligibleLeading` by `teamMoneyStateFor` `:610-645` — the own-Team "Auctions they lead or contend in" list is those two arrays, not a fourth traversal.
- `src/lib/core/team-identity.ts:36` `formatTeamManager(teamName, managerDisplayName)` — one Manager only. `epics.md:1569` and `EXPERIENCE.md:127` say **Manager(s)**, and `server/auction-open.ts:99-110` documents that two `managers` rows sharing one `team_id` is co-management rather than an error. Add `formatTeamManagers(teamName, displayNames)` beside it, delegating for the single case so the em dash is still spelled once.
- `src/lib/core/constants.ts` — `SALARY_CAP :18`, `ACTIVE_BENCH_SLOTS :98`, `INJURY_RESERVE_SLOTS :120`, `MINOR_LEAGUE_SLOTS :126`, `NO_AUCTION_PROBE_ID :117`.
- `src/lib/server/positions.ts` — the transaction and two-pass shape to copy: `begin` `:261`, one `loadEventsViaClient` `:269`, five folds `:270-274`, `select now()` + `requireDatabaseClock` `:280-281`, `loadMetadata` `:157-180` and `loadManagerNames` `:191-211` (both `::text = any($1::text[])`, both returning a `Map`, both for the reason a malformed historical id must yield a missing line rather than a 500), two-pass build `:340-363`, `rollback` on the happy path `:365`, `catch` → rollback + rethrow `:433-437`, `finally` release `:438-440`. **No advisory lock** — `:9-11` states why. `WonCardView` `:69-79` is the row shape precedent.
- `src/lib/core/positions.ts:502` `PLACEMENT_LABELS` — the existing wording for `active_bench` / `minor_league`, and `wonCardSentence` `:516` reads it. The roster listing's slot-kind headings come from here; a second spelling of "Active/Bench" in a new module is the defect the 4.4 exit audit caught. `board.ts:284` `boardCountSentence` is the 0/1/N count-sentence pattern to follow rather than re-derive.
- `src/lib/server/auction-open.ts:87-115` — the `teams × managers` left join, `order by t.name asc`, and the **`Map` collapse by team id** that keeps a co-managed Team from being named twice. The single-Team read is that query with a `where t.id = $1`.
- `src/routes/auction/[fantraxPlayerId]/+page.server.ts:79-102` — the only dynamic-param route today: `requireLiveDestination` FIRST `:80`, `actorFrom(session)` `:68-77`, then `error(404, …)` on a null read `:88-94`. Its `actorFrom` is the shape to copy for `viewerTeamId`.
- `src/routes/positions/+page.svelte` — the presentation precedent: core-wording imports `:30-51`, `figuresAgeSentence` `:204`, absolute stamps inside `$effect` `:216-260`, `<section class="panel">` / `id=` conventions `:262-509`. `src/lib/components/CapBreakdown.svelte` renders `CapBreakdownLine[]` already and needs no change.
- `_bmad-output/planning-artifacts/ux-designs/ux-BBSL-Appspiration-2026-08-17/DESIGN.md:178-192` "Teams row" — 1px `border` rules not card gaps; Team name `ui` 15px not Georgia; labels 10px uppercase `0.16em` `text-tertiary` above `tabular-nums` figures; `of 12` in `text-secondary`; IR in `text-tertiary` outside the group; **nothing coloured by comparison, ever**. `mockups/Teams.dc.html:38-58` is the *index row*, the closest visual reference that exists — **there is no per-Team mockup**, so the row's three-band anatomy (identity · slots · money) is what the page's summary follows.
- Tests: `tests/server/positions.test.ts` `fakeGateway()` `:22-56` — `options.failOn` plus per-table row fixtures (`events`, `players`, `managers`, `rosterRows`), and it **throws on any unexpected statement**, so a new table read must be added to the fake deliberately. `tests/routes/positions.test.ts` mocks `$lib/server/positions.ts` and `$lib/shell/db.ts` and asserts source text. `tests/strip.test.ts` covers the baseline probe. Purity: `scripts/check-core-purity.js`, `.ts` extension on every relative core import.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/strip.ts` — export `baselineCapOutcome(team, phase, now): CapGateOutcome` holding the existing `bidStateFor(null, team, false, phase)` + `probeFor()` call, and reduce `baselineMaximumBid` to `baselineCapOutcome(...).maximumBid`. One probe, one set of reasons; the strip's behaviour is unchanged and its tests must still pass untouched.
- [x] `src/lib/core/team-identity.ts` — add `formatTeamManagers(teamName, displayNames: readonly string[])`, delegating to `formatTeamManager` for one name and joining several with a single spelled-once separator. Empty list → the Team name alone.
- [x] `src/lib/core/team-view.ts` — new pure module. `TeamView` and `TeamRosterEntry`; `teamViewFor({teamName, managerNames, rosterRows, team, phase, nomination, viewerIsThisTeam, now})` returning the whole published set from `baselineCapOutcome` plus the roster grouped by `RosterSlotKind`; `maximumBid` and `capBreakdown` present **only** when `viewerIsThisTeam`; `TEAM_VIEW_LABELS`, `rosterSlotSentence`, `minorLeagueSlotSentence`, `injuryReserveSentence`, `nominationSlotStatusSentence`, and the own-Team leads/contentions list built from `TeamMoneyState.leading` + `.eligibleLeading`. Reuse `rosterCountSentence`, `describeAmount`, `formatTeamManagers`, `auctionPathFor`. Respell nothing.
- [x] `src/lib/server/team-roster.ts` — widen the select to `fantrax_player_id, player_name, cap_hit, roster_slot_kind` and add `loadTeamRosterDetail(client, teamId, contracts)` returning the named rows **and** the existing three figures from one read and one loop; `loadTeamRoster` keeps its signature and delegates. The contract half's names come from `contractsWonBy`, not `contractRowsFor`.
- [x] `src/lib/server/team-view.ts` — new `loadTeamView(gateway, teamId, viewerTeamId)`: one transaction, one `loadEventsViaClient`, folds auctions + eligibility + nominations + contracts + phase, `select now()` → `figuresAt`, the `teams × managers` left join collapsed by team id, `loadTeamRosterDetail`, then `teamMoneyStateFor` at `NO_AUCTION_PROBE_ID` and `teamViewFor`. Returns `null` for an unknown Team; always `rollback`; rethrows a read failure.
- [x] `src/routes/teams/[teamId]/+page.server.ts` — `requireLiveDestination(locals.session, locals.phase.name, 'teams')` FIRST, then `loadTeamView(writeGateway(), params.teamId, actorFrom(locals.session)?.teamId ?? null)`; `error(404, …)` on `null`; return `{ phase, team }`.
- [x] `src/routes/teams/[teamId]/+page.svelte` — the three bands (identity · slots · money), the roster grouped by slot kind with IR outside the twelve, the own-Team `CapBreakdown` and leads list behind one `{#if}`, absolute time in `$effect` only, page-level `figuresAgeSentence` in anything but Live. No wording of its own, no colour by comparison, no median.
- [x] `tests/team-view.test.ts` — every I/O matrix row through `src/lib/core/team-view.ts`: the published set for a rival, the **absence** of `maximumBid` and of any breakdown row on a rival, both own-Team additions, the won-Player placement, the over-ceiling and no-rows states, both Nomination Slot states, the co-managed naming, and an assertion that no exported string contains "median", "average", "above" or "below".
- [x] `tests/server/team-view.test.ts` — execute `loadTeamView` against a `fakeGateway()` extended from `tests/server/positions.test.ts`'s: one log read, no advisory lock, always `rollback`, rethrow rather than an empty page, `null` for an unknown Team, and a real assembly exercising the roster and manager joins.
- [x] `tests/routes/team-view.test.ts` — the guard runs first; the 404 on a null read; the load shape; source-text assertions that the page imports no `$lib/server`, words nothing itself, and carries `figuresAgeSentence`.
- [x] `tests/strip.test.ts` — add the equivalence: `baselineMaximumBid(...)` equals `baselineCapOutcome(...).maximumBid` for a bounded, an unbounded and a null-Team state, so the refactor cannot silently fork.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` — append two entries: the Contract Assignment Year Allotment column swap (owner Story 6.1, the same seam Story 4.2 logged), and that `/teams/[teamId]` is reachable only by direct URL until Story 4.6 builds the index that links to it.

**Acceptance Criteria:**
- Given a greyscale screenshot of any Team view, when it is read, then every figure is identifiable from its label and position alone, and nothing on the page is distinguished by colour.
- Given any string on the page is traced, then it originates in `src/lib/core/`, and no `.svelte` file under `src/routes/teams/` contains a user-facing sentence.
- Given a rival's Team view, when its source text and its rendered payload are both searched, then neither contains a Maximum Bid figure, a cap breakdown row, or any field derived from one.
- Given the viewer's own Team view and the persistent strip on the same page, when both render, then their Maximum Bid figures are the same number, because both are `baselineCapOutcome` over the same fold.
- Given a Team whose figures a Manager reproduces by hand from the Bid Board, when they compare, then every figure agrees — none is privileged information.

## Spec Change Log

**2026-09-03 — step-03 exit audit, orchestrator.** One correction before the story left
implementation, in the half of this repository nothing can execute.

*The naming rule shipped in one register instead of two.* `DESIGN.md:187` is explicit —
every Team name sits in `text`, the viewer's included, and the Manager name beside it
takes `text-secondary` — and `mockups/Teams.dc.html:40,62` draws exactly that. The page
rendered `team.identity`, a single joined string, in one colour, so the whole pairing sat
at full strength and the distinction the mock settled was gone. Everything about it looked
right: `.team-identity` correctly took `--font-ui` over Georgia (`DESIGN.md:181`), the
existing test asserted that within a scoped selector block, and it passed. The rule the
suite did not ask about is the one that was broken — which is the presentation-story
blindness exactly: source text proves a token is *used*, never that it lands on the right
element.

The fix keeps the em dash spelled once. `core/team-identity.ts` gains
`teamManagerSuffix`, which **derives** the Manager half by slicing the Team name off
`formatTeamManagers`' own output rather than re-concatenating it, so the two cannot
disagree about the separator or its spacing; `TeamView` carries both halves; the surface
sets each in its own register and never splits a string on the punctuation itself.
Mutation-checked twice, each failing exactly one test and restoring green: inverting the
two colours fails the register test alone, and reverting the heading to `{team.identity}`
fails the two-halves test alone.

Three tests were added for the relationship rather than the rendering —
`teamName + managerSuffix === identity` across the single, co-managed and no-Manager
cases — because that identity is what makes the split safe, and it is checkable where the
colours are not.

## Design Notes

**Why one Team and not thirty.** `epic-4-context.md:56` requires 4.5 and 4.6 to share one computation, and 4.6 does not exist. A function over a *list* would be written now, guessed at, and rewritten by the story that actually needs it — the low-effort trap of building for an unbuilt sibling. A function over **one** Team cannot be rewritten by 4.6: the index is a `map` over it plus a median, and the disagreement the requirement exists to prevent is ruled out by construction rather than by discipline.

**Why the strip's probe and not a new one.** Every figure the AC lists is already a field on `CapGateOutcome`, and `core/strip.ts` already builds the exact no-Auction state that makes those fields describe a Team rather than a bid. A second probe would be a second answer to "what does this Team hold", and the first to drift when a gate changes. Lifting the outcome out of `baselineMaximumBid` costs three lines and makes the strip and the Team view structurally incapable of printing different numbers — which the fourth acceptance criterion then asserts.

**Why the roster rows come from the existing read.** `loadTeamRoster` already concatenates won contracts onto imported rows before its one counting loop, which is precisely what makes a won Player occupy a slot immediately. Adding a second query for the names would produce a row set that could disagree with the counted one at the moment a close commits. Widening the select keeps one read, one concatenation and one loop.

## Verification

**Commands:**
- `npm test` — expected: green, with `tests/team-view.test.ts`, `tests/server/team-view.test.ts` and `tests/routes/team-view.test.ts` all collected and executed, and `tests/strip.test.ts` and `tests/server/strip.test.ts` still passing unmodified except for the added equivalence.
- `npm run check` — expected: 0 errors, 0 warnings.
- `npm run check:pins` — expected: pass.

**Manual checks (if no CLI):**
- Open `src/routes/teams/[teamId]/+page.svelte` beside `DESIGN.md:178-192` and `mockups/Teams.dc.html:38-58` and match each visual rule to the selector carrying it — nothing in this repository can render a component, so this reading is the only gate that exists.
