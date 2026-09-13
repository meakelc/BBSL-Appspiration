---
title: "Story 7.11: Rearrange a Roster's Slot Placements"
type: 'feature'
created: '2026-09-12'
status: 'done'
baseline_commit: '5fa48b8d0a64398d8ba303d2abdbbd0b3e0e9300'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A Contract arriving from a Trade or a Close is placed by FR-21's automatic rule against whatever the receiving Team's Minor League occupancy happened to be at that instant, and nothing can ever move it again. Team E pays $18,000,000 for a stash it meant to keep at $0 (§10 example 44), and no Manager can swap a Minor League Slot's occupant for a better one.

**Approach:** A fifth command type, `RearrangeRoster`, naming **one** Team and one or more of its own Contracts with the Slot each is to occupy. It calls `core/rules/roster-act.ts` — the module Story 7.8 extracted for exactly this — and writes no arithmetic of its own. Placement is taken **from the command**, never re-derived. Eligibility for a Minor League Slot is a **fold**: the pool flag union every Minor League occupancy the app has ever observed. Two controls: a Manager's solid, reasonless sheet on their own Team, and the Commissioner's dashed reason sheet on any Team.

## Boundaries & Constraints

**Always:**
- The Team is resolved **from the session** for a Manager, never from a form field. A Manager naming another Team is refused server-side whatever the page rendered. Every guard runs on `load` **and** on the action.
- **Departures from every Slot before any arrival is placed**, so the transient Minor League occupancy of 4 in §10 example 44 is never constructed. Figures are derived **once**, at the end, by `figuresFor` over the rows the Team is left holding.
- Cap Hit follows placement through `chargedCapHit` — the one expression — with the Contract's value untouched. Minors Exposure and Roster Count fall out of `postActMoneyStateFor`; nothing recomputes them by hand.
- The gates are `evaluateActCap` and `evaluateActSlots` **called, not copied**. A gate failure refuses the whole act and writes nothing.
- One transaction under the global write lock, appending **one** event carrying the whole delta — every Contract, both placements, both Cap Hits, the Team's figures before and after.
- Live in the **Auction** and **Contract Assignment** Phases; refused in Setup and Archived, via the destination catalog and `requireOverridablePhase`.
- The act works, and is still refused, with JavaScript off.

**Ask First:**
- Any change to `evaluateActCap`, `evaluateActSlots`, `figuresFor`, `chargedCapHit` or `teamMoneyStateFor`. This story calls them; if one is wrong, report it rather than fix it.
- Adding a migration. This story needs none.
- Reusing the persisted string `'RosterMoveRecorded'` — it is the **Trade's** wire name and is frozen (AD-4).

**Never:**
- Deriving placement with `slotPlacementFor`. FR-21's automatic rule is what a Close and a Trade arrival apply; a Move that re-derived placement would silently undo itself.
- Widening the `isMinorLeagueEligible` function handed to `postActMoneyStateFor`. That is the **pool flag**, and it answers a different question — whether a contested Player, if won, could be stashed. Placement eligibility is a separate predicate.
- Cancelling a Bid. AD-31's trigger stays a Close, and the sheet offers no control that would change it.
- Moving to or from **Injury Reserve** or **Dead Money**, editing any amount, clearing any assigned contract length, or touching the Year Allotment.
- A single sheet component with a conditional reason field (UX-DR41), or any Manager control inside a `commissioner-block`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| The swap (§10 example 44) | Ellis Active/Bench→minors, Brooks minors→Active/Bench, 3 of 3 minors occupied | Permitted. Cap Space $2,000,000 → **$17,000,000**; Roster Count 10; minors occupancy 3 | N/A |
| The same swap, sequenced | Ellis demoted first | Minors occupancy transiently 4 — **must be unreachable**; the sequenced order is the regression test, not the implementation | N/A |
| Buying bidding power (§10 example 45) | One stash worth $2,000,000 demoted to Active/Bench | Cap Space $20M→$18M, Manager-facing Maximum Bid $8M→**$18M**; sheet states Maximum Bid **ROSE by $10,000,000** in words | N/A |
| Never-observed promotion (§10 example 46) | Vassell, imported Active/Bench, no pool row, never in minors | Refused, named: *the app has never been told he is eligible* | shape refusal, `gates: null` |
| The round trip (§10 example 46) | Thompson, no pool row, demoted out of minors by an earlier Move | **Permitted** — the log observed him in minors | N/A |
| Demotion needs nothing | Any minors Contract → Active/Bench | Permitted; eligibility is not consulted | N/A |
| IR or Dead Money named | Either as source or as target Slot | Refused by the **rules core**, not the screen; neither is offered by the picker | shape refusal |
| Gate failure | Post-Move state fails money or slots | Whole Move refused, nothing written, naming the gate, the Auction and the arithmetic | `refusal: 'gates'` with full gate results |
| Manager names another Team | POST with a foreign `team` param | Refused server-side | guard refusal |
| Contract in an open Auction | Named Player has an open Auction or nomination | `contested` gate fails; cap and slots still report | gate refusal |
| Won Contract moved | Auction Contract, no `team_rosters` row | Moves **by the event alone**, folded latest-placement-wins | N/A |

</frozen-after-approval>

## Code Map

**Reuse verbatim — call, never copy (`src/lib/core/rules/roster-act.ts`):**
- `:151` `figuresFor(team, rows)` — the five figures, derived from rows only. `:172` `chargeOf`, `:177` `minorsOccupiedIn`, `:140` `movable`, `:196` `postActMoneyStateFor`, `:225` `evaluateActCap`, `:274` `evaluateActSlots`, `:340` `contestOf`, `:356` `inWords`, `:365` `auctionsInWords`, `:127` `describeActAmount`, `:71` `NO_MONEY`.
- `chargedCapHit` (`rules/roster-import.ts:78`) is the one charge expression; `SLOT_LABELS` (`:159`) the one slot vocabulary.

**The closest template is the Drop, not the Trade** — one Team, one act: `src/lib/core/rules/roster-drop.ts:270` `evaluateDrop` (dedupe → `contestOf` → shape refusals → after-rows → `figuresFor` → one gate evaluation → `allDropGatesPassed`), `:183` `RosterDropRefusal`, `:207` `DropOutcome`, `:438` `dropRefusalDetail`, `:545` `dropAttention` (**the precedent for stating a direction in words**), `:596` `dropActSentence`.

**New pure rule — `src/lib/core/rules/roster-rearrange.ts`:** `RearrangingPlayer` (an `ActingRow` plus `won`), `RosterRearrangeState`, `RosterRearrangeRefusal`, `RearrangeOutcome`, `evaluateRearrange`, `allRearrangeGatesPassed`, `rearrangeRefusalDetail`, `moveAttention`, `maximumBidDirectionSentence`, `rearrangeActSentence`.

**New pure projection — `src/lib/core/projection/minors-history.ts`:** the eligibility fold. Model it on `projection/eligibility.ts` (`:113` `eligibilityReducer`, `:63` `isEligible`) — a `ReadonlySet<string>` folded by the generic `fold()` (`projection/fold.ts:40`). **Union, never replace.** Fold every `minor_league` placement out of `ROSTER_TRADE_RECORDED_EVENT` transfers (`fromPlacement`/`toPlacement`), the new event's moves, and `DROP_RECORDED_EVENT` releases' `fromPlacement`. Seed with the Team's **current** minors rows from `loadTeamRosterDetail`.

**Types (`src/lib/core/types.ts`):** after `:1231` `RecordDropGateResults`, add `RearrangeRoster` (`teamId`, `teamName`, `moves: readonly {fantraxPlayerId, toPlacement}[]`, `reason: string | null`), `REARRANGE_ROSTER_GATES = Object.freeze(['contested','cap','slots'])`, `RearrangeRosterGate`, `RearrangeRosterGateResults` — reusing `ContestedGateOutcome`, `ActCapGateOutcome`, `ActSlotsGateOutcome` exactly as `RecordDropGateResults` (`:1224`) does. Copy the docblock discipline at `:1171` and `:1182`.

**Event and fold (`src/lib/core/projection/contracts.ts`):** `ROSTER_TRADE_RECORDED_EVENT = 'RosterMoveRecorded'` at `:411` is **frozen and belongs to the Trade** — the new constant is `ROSTER_REARRANGED_EVENT = 'RosterRearranged'`. Add `RosterRearrangedMove` (`fantraxPlayerId`, `playerName`, `won`, `fromPlacement`, `toPlacement`, `capHitBefore`, `capHitAfter`, `value`) and `RosterRearrangedPayload` (`teamId`, `teamName`, `moves`, `teamBefore`, `teamAfter`, `reason: string | null` — **`teamBefore`/`teamAfter`, never `before`/`after`**: `audit-log.ts`'s `mergeOverride` renders an `OverrideRecord` state map off any payload carrying a top-level `before`/`after` pair, with no second condition, and would print the Team figures again raw. `DropRecordedPayload` avoids it the same way), beside `RosterTradeTransfer` (`:426`) and `RosterTradeRecordedPayload` (`:473`). Add a `contractsReducer` case (`:728`, beside the Trade's at `:779`) so a **won** Contract's placement moves latest-wins; narrow with the existing `isSlotPlacement` (`:794`).

**Write path — `src/lib/server/roster-rearrange.ts`:** mirror `server/roster-drop.ts` (`:184` `loadRosterDropState`, `:247` `previewRosterDrop`, `:269` `loadRosterDropTeams`, `:298` `recordDrop` → `runTransactionalWrite`). SQL is one statement: `update team_rosters set roster_slot_kind = $2 where fantrax_player_id = $1`. Skip won Contracts in the projection exactly as `server/roster-trade.ts:401-410` does. Values for won rows come from `contractsWonBy`, as at `server/roster-trade.ts:161-199`.

**Surface:**
- `src/lib/server/destinations.ts:79` `destination(id,label,href,commissionerOnly,listed)`; add `destination('roster-move','Record a Roster Move','/roster-move', false)` to **both** the Auction (`:126`) and Contract Assignment (`:139`) arrays. `commissionerOnly: false` — a Manager needs it.
- `src/lib/reason-sheet-view.ts` — `ReasonSheetRow` (`:60`), `teamFigureRows` (`:245`), `dropReasonRows` (`:392`), `reasonSheetView` (`:193`). Add `rearrangeReasonRows`, `rearrangeActSentence` and `ROSTER_MOVE_COMMIT_LABEL`. `ReasonSheetView` (`:104`) carries `reasonLabel`/`reasonFieldName` — the Manager variant needs a shape without them.
- **`ReasonSheet.svelte:50` wraps everything in `<section class="commissioner-block">` unconditionally, with no variant.** Add a sibling `src/lib/components/ManagerSheet.svelte` — `manager-block`, `control-manager`, solid, **no reason field**. `tests/signin-surface.test.ts:212-260` walks every `src/**/*.svelte` and fails if the two classes ever mix.
- `src/lib/core/audit-log.ts:761` `renderRosterTrade` is the model; add `renderRosterMove` and a `RENDERERS` entry keyed by `ROSTER_REARRANGED_EVENT` labelled `'Roster Move recorded'`. **`RENDERERS` is open — a missing key renders a plain envelope at runtime with no compile error**, so the audit-log test is the only proof.
- `src/routes/roster-move/+page.server.ts` + `+page.svelte` — the three-step `GET` state machine of `routes/roster-drop/+page.server.ts:123-208` and `+page.svelte:104,134,176`. Guards: `requireLiveDestination`, `requireOverridablePhase`, and — **only on the Commissioner branch** — `requireCommissioner` and `requireOverrideReason` (`server/override-guard.ts:104`). The Team comes from `locals.session.registered.manager.teamId` (`src/app.d.ts`) unless the actor is the Commissioner.

**Read-only evidence — no migration is needed:**
- `supabase/migrations/20260910000000_dead_money_roster_slot_kind.sql:33-35` — `roster_slot_kind` already admits all four values.
- `supabase/migrations/20260821020000_auction_events.sql:63` — `event_type text not null`, no enum.
- `tests/structure.test.ts:88` `SECTION_10_EXAMPLES` — add three entries; `:267` asserts `tests/examples/` holds nothing else.
- `tests/examples/example-43-a-stashed-drop-moves-the-maximum-bid-the-other-way.test.ts` is the template for a §10 example driven through a command.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/minors-history.ts` — new pure projection: the `minor_league`-occupancy union fold, its reducer, and `hasEverOccupiedMinorLeague`. Union, never replace.
- [x] `src/lib/core/projection/contracts.ts` — add `ROSTER_REARRANGED_EVENT`, `RosterRearrangedMove`, `RosterRearrangedPayload`, and the `contractsReducer` case that moves a won Contract's placement latest-wins. Leave `'RosterMoveRecorded'` alone.
- [x] `src/lib/core/types.ts` — declare `RearrangeRoster`, `REARRANGE_ROSTER_GATES` and `RearrangeRosterGateResults`, reusing the three Act outcome shapes. Note in the docblock that this is the **fifth** command type (AR-44 says "fourth"; `RecordDrop` at `:1171` already took that number — AR-44's other count, "third caller of the shared evaluator", is correct).
- [x] `src/lib/core/rules/roster-rearrange.ts` — `evaluateRearrange`: dedupe on Player, `contestOf`, shape refusals (`names_nothing`, `not_held`, `unmovable_slot`, `never_observed_eligible`), **remove every named row then re-place it at its commanded Slot**, `figuresFor` once, then the three gates. Placement from the command; `slotPlacementFor` is never called.
- [x] `src/lib/core/rules/roster-rearrange.ts` — the wording: `rearrangeRefusalDetail`, `moveAttention` (per-Contract Cap Hit change), and `maximumBidDirectionSentence` — computed over the **before** state as well as the after. The sentence quotes `managerMaximumBidFor` (a second call of `teamSolvencyFiguresFor` with `prospectiveBidIsExempt: false`), not the gate's headroom; see the Spec Change Log. Never asserted as a flat rule.
- [x] `src/lib/server/roster-rearrange.ts` — load state (roster detail, contracts, eligibility fold, minors history), preview, and `recordRearrange` through `runTransactionalWrite`: one `roster_slot_kind` `UPDATE` per Existing Contract, no row for a won one, one appended event.
- [x] `src/lib/server/destinations.ts` — the `roster-move` entry in both phase arrays, `commissionerOnly: false`.
- [x] `src/lib/reason-sheet-view.ts` — `rearrangeReasonRows`, `rearrangeActSentence`, `ROSTER_MOVE_COMMIT_LABEL`, and the reasonless view shape the Manager sheet reads.
- [x] `src/lib/components/ManagerSheet.svelte` — new: solid `manager-block`, `control-manager` commit, no reason field, plain `POST`.
- [x] `src/lib/core/audit-log.ts` — `renderRosterMove` and its `RENDERERS` entry. Not broadcast to Discord.
- [x] `src/routes/roster-move/+page.server.ts` + `+page.svelte` — both branches, every guard on `load` and on the action, no-JS `GET` steps into a `POST` commit.
- [x] `tests/examples/example-44-…`, `example-45-…`, `example-46-….test.ts` — the three §10 examples, driven through `evaluateRearrange`; register all three in `tests/structure.test.ts:88`.
- [x] `tests/**` — unit tests for every I/O Matrix row, the audit-log renderer, the destinations entry in both phase lists, the minors-history fold, and the server write path.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` — append the pause-refusal entry (see Design Notes).

**Acceptance Criteria:**
- Given the finished story, when `npm test`, `npm run check` and `npm run build` run, then all three pass, including `scripts/check-core-purity.js` over the two new core modules.
- Given `git status -- supabase/`, when it runs, then it is clean — this story adds no migration.
- Given a Manager signed in, when they open `/roster-move`, then only their own Team is reachable, the sheet is solid with no reason field, and a POST naming another Team is refused whatever was rendered.
- Given the Commissioner, when they open `/roster-move`, then any Team may be named and the dashed reason sheet demands free text, refused server-side when blank.
- Given a recorded Move, when the Audit Log renders, then the entry names the actor, both placements, both Cap Hits and the Team's figures before and after — and the Commissioner's reason where there is one.
- Given a recorded Move on a **won** Contract, when the contracts projection is rebuilt from the log alone, then the Contract's placement and charged Cap Hit are reproduced.
- Given a Move refused by either gate, when the transaction is inspected, then no row was updated and no event was appended.
- Given the diff, when it is reviewed, then no affordability, Roster Reserve, Minors Exposure or charged-Cap-Hit expression was written in it.

## Spec Change Log

- **2026-09-12 — the payload's figure blocks are `teamBefore`/`teamAfter`.** Acceptance-audit finding: the Code Map specified `before`/`after`, and the implementation used the prefixed names without logging the deviation. The implementation is **right** and the Code Map was wrong — `core/audit-log.ts`'s `mergeOverride` renders the `OverrideRecord` shape off *any* payload with a top-level `before`/`after`, unconditionally, so those names make the Audit Log print the Team figures a second time as a raw state map and fail the suite's "no raw party id" assertion. `DropRecordedPayload` already avoids the collision this way. Code Map amended to match the code; no code change.

  **KEEP:** the prefixed names, and `tests/server/roster-rearrange.test.ts`'s "names the figure blocks `teamBefore`/`teamAfter`, never `before`/`after`" assertion, which is what stops a later re-derivation reintroducing the collision.

- **2026-09-12 — §10 example 45's Maximum Bid, and a PRD arithmetic correction.** Implementation found the matrix row's `$7M→$18M / +$11,000,000` unreachable. The PRD's two figures used *different* definitions of Projected Additions: its before figure counted the prospective Bid but omitted Active/Bench Overflow, which is `1` before the Move (two eligible leads, one free Minor League Slot) and `0` after — so only the before figure was wrong, and the stated gain mixed two models. Both self-consistent readings put the gain at **$10,000,000**: the gate's `$7M→$17M` and the Manager-facing `$8M→$18M`.

  Human decided (a) the sheet quotes the **Manager-facing** figure, not the gate's, and (b) the PRD is corrected. Amended: the matrix row to `$8M→$18M / +$10,000,000`; the Design Notes to name both figures; `prd.md` §10 example 45 and `epics.md` UX-DR41 and the Story 7.11 AC line, each with a dated in-place note. `evaluateActCap` was **not** touched — it remains on Ask First, and adding `managerMaximumBidFor` beside it is a second call rather than a change.

  **KEEP:** the gate keeps `prospectiveBidIsExempt: true`; the sheet keeps the Manager-facing pair; `tests/examples/example-45-…` asserts both figures side by side so the distinction cannot be quietly collapsed again.

## Design Notes

**Why the eligibility fold needs only three event types and a live seed.** `ImportPromotedPayload` (`server/import-promotion.ts:250-257`) carries `{teamId, teamName, rosterCount}` and `poolSize` — **no per-player slot detail** — so the import baseline is not reconstructible from the log and must be read from `team_rosters` as it stands. That is sound: re-import replaces live state wholesale and happens only in Setup, while a Move is live only from the Auction Phase on. Everything that has moved a Contract out of a Minor League Slot **since** import is one of three recorded acts, so the union of (current minors occupancy) and (every `minor_league` placement those three events carry) is complete. An Auction Close needs no entry: a Close can only place in minors because the **pool flag** said so, and that flag is folded independently — and if the Commissioner later unsets it, the Contract is either still in minors (seeded) or was moved out by one of the three acts (folded).

**Why the figures are computed twice, and why there are two of them.** §10 example 45 spends $2,000,000 of Cap Space and gains $10,000,000 of Maximum Bid, and no pair of figures on the sheet says so. `dropAttention` (`rules/roster-drop.ts:545`) sets the precedent — it *computes* the net direction rather than asserting one, because the same act moves it both ways. A Move's direction runs through Minors Exposure and cannot be derived per-row at all, so it is computed over the before state and again over the after.

**Two Maximum Bids, and the sheet quotes the second.** `evaluateActCap` passes `prospectiveBidIsExempt: true` — right for a *gate*, whose verdict is only `maximumBid >= 0`, since a Move places no Bid. But "Maximum Bid" is a defined term that counts the Bid being placed (FR-12, PRD §3), so a sheet quoting the gate's headroom would show a Manager a number they do not recognise from the board. `managerMaximumBidFor` asks `teamSolvencyFiguresFor` the second question with `false` — a second **call** of one expression, never a second expression — and the gate is untouched.

**The blocked criterion: "refused while paused" (AD-13).** There is **no pause state in `src/` at all** — no `paused`, no `pausedAt`, no guard — because Story 7.4 is still `backlog`, and the epic explicitly does not make 7.11 depend on it. This story therefore cannot implement that criterion, and inventing a pause flag for it would be Story 7.4's design decided here. It is deferred to `deferred-work.md` and must be discharged by 7.4, which has to add the guard to every act route it finds.

**Placement comes from the command.** Stated three times in the requirements because it is the one thing that reads like a bug: every other placement in this codebase goes through `slotPlacementFor`. Re-deriving it here would take a demotion the Manager just asked for and put the Contract straight back in the Slot it left.

## Verification

**Commands:**
- `npm run check` — expected: zero errors.
- `npm test` — expected: full suite green, including the three new `tests/examples/` files.
- `npm run build` — expected: passes, including core purity over `rules/roster-rearrange.ts` and `projection/minors-history.ts`.
- `git status -- supabase/` — expected: clean.

**Manual checks:**
- Sign in as an ordinary Manager in the Auction Phase: `/roster-move` lists only your own Team, the sheet is solid with no reason field, and the swap of §10 example 44 records and shows the new figures.
- Sign in as Commissioner: the same route offers all thirty Teams and a dashed sheet demanding a reason.
- Disable JavaScript and repeat both — every step is a plain form submit.
- Demote a stash, then promote it back, and confirm the roster returns to exactly the state it held (§10 example 46's round trip).

## Suggested Review Order

**The act, and the two rules that make it different from every other placement**

- The evaluator: departures from every Slot, then arrivals, then one judgement.
  [`roster-rearrange.ts:346`](../../src/lib/core/rules/roster-rearrange.ts#L346)

- Placement eligibility — the pool flag UNION the observation fold (§10 example 46).
  [`roster-rearrange.ts:310`](../../src/lib/core/rules/roster-rearrange.ts#L310)

- The two Slots a Move may name; IR and Dead Money stated once, here.
  [`roster-rearrange.ts:91`](../../src/lib/core/rules/roster-rearrange.ts#L91)

- Note the absence: `slotPlacementFor` is never imported, and that is the requirement.
  [`roster-rearrange.ts:1`](../../src/lib/core/rules/roster-rearrange.ts#L1)

**The Maximum Bid the sheet quotes — the one figure with two right answers**

- The Manager's figure, projecting the Bid about to be placed. Not the gate's.
  [`roster-rearrange.ts:278`](../../src/lib/core/rules/roster-rearrange.ts#L278)

- The direction, computed from both states rather than asserted.
  [`roster-rearrange.ts:676`](../../src/lib/core/rules/roster-rearrange.ts#L676)

- The row that carries it, and why it earns a row of its own.
  [`reason-sheet-view.ts:516`](../../src/lib/reason-sheet-view.ts#L516)

**Eligibility as a fold — what the log can and cannot reconstruct**

- Union, never replace: the seed plus every `minor_league` the log carries.
  [`minors-history.ts:156`](../../src/lib/core/projection/minors-history.ts#L156)

- Absence is "never observed", which is the honest default.
  [`minors-history.ts:100`](../../src/lib/core/projection/minors-history.ts#L100)

**The record, and the one field name that is load-bearing**

- A new wire string; the Trade's `'RosterMoveRecorded'` is untouched.
  [`contracts.ts:625`](../../src/lib/core/projection/contracts.ts#L625)

- Rejects a malformed `fromPlacement` rather than repairing it — the fold reads it.
  [`contracts.ts:829`](../../src/lib/core/projection/contracts.ts#L829)

- A won Contract has no row and moves by the event alone, latest-wins.
  [`contracts.ts:984`](../../src/lib/core/projection/contracts.ts#L984)

- `teamBefore`/`teamAfter`: `before`/`after` would print raw ids in the Audit Log.
  [`roster-rearrange.ts:396`](../../src/lib/server/roster-rearrange.ts#L396)

**The write path**

- One transaction, one `roster_slot_kind` UPDATE per Existing Contract, one event.
  [`roster-rearrange.ts:385`](../../src/lib/server/roster-rearrange.ts#L385)

- A won row with no Contract behind it throws rather than valuing it at $0.
  [`roster-rearrange.ts:209`](../../src/lib/server/roster-rearrange.ts#L209)

**The surface — two controls, and a parser that does not judge**

- Parses all four Slot kinds so the CORE refuses the two a Move may not name.
  [`+page.server.ts:197`](../../src/routes/roster-move/+page.server.ts#L197)

- Why that matters twice: a per-entry drop would commit a mixed POST's valid leg.
  [`+page.server.ts:216`](../../src/routes/roster-move/+page.server.ts#L216)

- An unknown Team id is refused, not rendered as its own name.
  [`+page.server.ts:165`](../../src/routes/roster-move/+page.server.ts#L165)

- The Manager's sheet: solid, `manager-block`, structurally unable to carry a reason.
  [`ManagerSheet.svelte:45`](../../src/lib/components/ManagerSheet.svelte#L45)

- The shape split that makes that structural rather than conditional (UX-DR41).
  [`reason-sheet-view.ts:122`](../../src/lib/reason-sheet-view.ts#L122)

- Listed for Managers too — `commissionerOnly: false`, in both live phases.
  [`destinations.ts:131`](../../src/lib/server/destinations.ts#L131)

**Peripherals**

- The fifth command type and its gate set; AR-44's "fourth" is stale.
  [`types.ts:1273`](../../src/lib/core/types.ts#L1273)

- The renderer key — `RENDERERS` is open, so only the test proves it matches.
  [`audit-log.ts:1147`](../../src/lib/core/audit-log.ts#L1147)

- §10 example 45: both Maximum Bids asserted side by side, deliberately.
  [`example-45.test.ts:1`](../../tests/examples/example-45-the-move-that-buys-bidding-power-by-spending-cap.test.ts#L1)

- §10 example 44: the transient occupancy of 4, proved unreachable.
  [`example-44.test.ts:1`](../../tests/examples/example-44-the-optimization-after-the-trade.test.ts#L1)

- §10 example 46: Vassell refused, Thompson permitted, only the log tells them apart.
  [`example-46.test.ts:1`](../../tests/examples/example-46-the-promotion-the-app-must-refuse-and-the-one-it-must-allow.test.ts#L1)

