---
title: 'Story 2.1: Nominate a Free Agent'
type: 'feature'
created: '2026-08-25'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'ffc811ae06fb1e5b77fe933a4a8a640625987250'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The auction opens and there is nothing to do. `/nominate` is a registered Auction-phase destination with no route behind it, no command can append a `NominationPlaced` event, and the League Clock folded at open has no reset — so the phase would expire 48 hours after the open no matter what the league did.

**Approach:** One Manager-facing gate at `/nominate` that folds open nominations from the log, refuses in the pure core with the offending Player or holder named, and on an explicit confirm appends a single `NominationPlaced` event that resets the League Clock and holds the Team's Nomination Slot. Nothing is committed: no cap space, no Leading Bidder, no Auction Clock.

## Boundaries & Constraints

**Always:** Every gate is re-derived inside the transaction, under the global lock, from the log folded plus the live reference tables — never from what the page rendered. Nomination Slot status and board occupancy are **folds over the log**, never stored flags. Every refusal sentence has exactly one definition in the pure core and names the Player or the holder rather than counting. The acting Manager comes from the session, never from a form field. `NominationPlaced` carries device class from the first event onward — an insert-only log cannot be backfilled.

**Ask First:** Any further change to the League Clock reset set beyond adding `NominationPlaced` (AD-22). Any stored Nomination Slot column or flag. Any second write path to `auction_events`.

**Never:** No migration and no projection table — nothing new is stored. No `/board` route, no board card, no Bid Board render; `/nominate` confirms its own outcome. No data-layer uniqueness constraint and no concurrency test — Story 2.2's. No refusal for "already won in this auction": no close event exists yet, so the state is unreachable. No bid, no Auction Clock, no cap arithmetic, no `maximumBid`. No suggested player, ranking, or "similar players" affordance. No hand-edit of `_bmad-output/planning-artifacts/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Nominated | Phase Auction; actor's Team holds no open nomination; Player in `free_agent_players`, on no roster, not on the board; `confirm=yes` | One `NominationPlaced` event appended carrying actor, Team, `fantraxPlayerId`, player name, db `now()`, stamped versions and a non-null `deviceClass`; League Clock reset folds to that event | N/A |
| Slot in use | Actor's Team has an open nomination | Refused `slot_in_use`, **naming the Player holding the Slot** | Nothing written |
| Already on the board | Another Team nominated this Player and it is still open | Refused `already_nominated`, naming the nominating Team | Nothing written |
| Under Contract | Player has a `team_rosters` row | Refused `under_contract`, naming the Team | Nothing written |
| Unknown Player | `fantraxPlayerId` matches no pool row | Refused `unknown_player` | Nothing written |
| Wrong phase | Phase folds to anything but Auction | Refused `phase`, naming the folded phase | Nothing written |
| Unconfirmed submit | Gate would pass but `confirm !== 'yes'` | `fail(400)` with the confirmation sentence; no transaction opened | Nothing written |
| Unbound actor | Registered session with `manager.teamId` null | `fail(400)` worded by the core; no transaction opened | Nothing written |
| Cannot afford | Actor's Team has no cap space at all | **Nominated normally** — nomination commits nothing | N/A |
| Absent User-Agent | Request carries no `user-agent` header | Classifier returns `'unknown'`; the event's `deviceClass` is `'unknown'`, never null | N/A |
| Mid-transaction failure | Insert throws after BEGIN | Rollback; no event, no clock reset | Rethrown as a bug |

</frozen-after-approval>

## Code Map

Read 1.11's Code Map and Design Notes first — `runTransactionalWrite`, the core-worded refusal discipline, the "server renders, surface prints" split and the guard-on-load-and-every-action rule are reused, not re-derived. **No migration:** board occupancy, Slot status and the clock are all folds. `/nominate` is already a registered Auction-phase **Manager** destination (`server/destinations.ts:78`, `commissionerOnly: false`) with no route behind it — so `requireLiveDestination` applies and `requireCommissioner` does **not**.

- `src/lib/core/projection/nominations.ts` -- new, pure. `NOMINATION_PLACED_EVENT = 'NominationPlaced'`; `nominationsReducer: Reducer<OpenNominations>` folding into `{ byPlayer: Record<fantraxPlayerId, OpenNomination>, byTeam: Record<teamId, OpenNomination> }`. **Amended during review (2026-08-25):** `byTeam` holds the whole `OpenNomination`, not a bare `fantraxPlayerId` as first drafted — `slot_in_use` must name the Player holding the Slot, and the fuller index supplies that name without a second lookup the gate would then have to re-word. Same `switch` + `default: return state` shape as `phase.ts:60` with a defensive private `readPayload` returning `null` rather than throwing, per `promotion.ts:69`. No release case — `AuctionClosed` does not exist and is Story 2.3's.
- `src/lib/core/projection/league-clock.ts` -- extend. Add `lastReset: string | null` to `LeagueClock` (`:39`) and `INITIAL_LEAGUE_CLOCK` (`:44`), plus a `case NOMINATION_PLACED_EVENT` at `:58` setting `lastReset` to `event.occurredAt`. Add `leagueClockExpiry(clock)` returning `LEAGUE_CLOCK` after the **later** of origin and `lastReset` (AD-22's amended third bullet). The origin case at `:55-57` is unchanged and still ignores repeats. Update the header comment, which currently states the reset cases are deliberately absent.
- `src/lib/core/device-class.ts` -- new, pure. `classifyDeviceClass(userAgent: string | null): DeviceClass` where `DeviceClass = 'mobile' | 'tablet' | 'desktop' | 'unknown'`. Total, no throw, no regex backtracking risk, no clock or randomness. First producer of a value for a column that has existed unpopulated since `20260821020000_auction_events.sql:71`.
- `src/lib/core/rules/nomination.ts` -- new, pure. `NominationState = { phase; nominations: OpenNominations; poolPlayer: {fantraxPlayerId, playerName} | null; contractHolderTeamName: string | null }`. `NominationRefusal` discriminated union on `kind` — `phase` | `unknown_player` | `under_contract` | `already_nominated` | `slot_in_use` | `unconfirmed` | `unbound_actor` | `unrecorded` — each carrying its own naming components, exactly mirroring `rules/auction-open.ts:72-80`. `nominationRefusalDetail(refusal)` as an exhaustive switch, every sentence closing "Nothing was written." (`auction-open.ts:101`). `refuseNomination(state, actorTeamId)` returning the first refusal or `null` (`auction-open.ts:173`), checked in that order. `NOMINATION_CONSEQUENCE`: the sentence stating the Slot is held until that Player's Auction closes.
- `src/lib/server/nomination.ts` -- new, server-only. `loadNominationState(client, fantraxPlayerId)`: one `loadEventsViaClient` (`server/event-log.ts:123`) folded twice — phase, nominations — plus `select fantrax_player_id, player_name from free_agent_players where fantrax_player_id = $1` and `select t.name from team_rosters r join teams t on t.id = r.team_id where r.fantrax_player_id = $1`. `loadNominatablePool(gateway, actorTeamId)` for the render path: begin/read/rollback, **no lock**, per `server/auction-open.ts:136-140`. **Amended during review (2026-08-25):** the actor id moved from the loader to the render path. `loadNominationState` never needed it — the gate receives it in `decide`, where `refuseNomination(state, actor.teamId)` is called — while `loadNominatablePool` does, because AC2 requires the page to word the acting Team's own Slot refusal (`slotDetail`) rather than leave the surface to invent one. `placeNomination(gateway, actor, fantraxPlayerId, deviceClass)`: one `runTransactionalWrite` (`shell/write.ts:179`) whose `decide` calls `refuseNomination` and returns `{kind:'rejected', reason:{refusal, detail}}` or `{kind:'accepted', events:[envelope]}` with `deviceClass` set on the envelope (`core/types.ts:61`). **No `projections` key** — nothing is persisted.
- `src/routes/nominate/+page.server.ts` -- new. `requireLiveDestination(locals.session, locals.phase.name, 'nominate')` on `load` and on the single `nominate` action; **no** `requireCommissioner`. `confirm !== 'yes'` mirrors `routes/auction-open/+page.server.ts:59-63`; unbound actor as a returned `fail(400)`, not a throw; rejection → `fail(409, {notice: rejection?.detail ?? ...})`. Device class read here as `request.headers.get('user-agent')` and passed into `placeNomination` — the core never sees a header.
- `src/routes/nominate/+page.svelte` -- new. `.manager-block` + `.control-manager` (46px, `commissioner.css:56-79`), **not** the Commissioner classes. The pool as a selectable list per `routes/minor-league-eligibility/+page.svelte:143-165` but **single-select** (`type="radio"`, `bind:group`), then a separate confirm checkbox and submit — the two-part act. Reason paragraph always in the DOM with a stable id and `aria-describedby`, per `routes/auction-open/+page.svelte:140-174`. `NOMINATION_CONSEQUENCE` printed beside the confirm. Types declared structurally, never imported from `$lib/server`. Single-column at 375px.
- Tests -- `tests/core/nomination.test.ts` (the reducer's fold and double-replay convergence, every refusal sentence, the classifier's table including a null header); `tests/server/nomination.test.ts` (stateful fake `ConnectionGateway` per `tests/server/auction-open.test.ts:34-128`: every matrix row, statement order, the rollback, a rejection appending nothing, and that `deviceClass` reaches `params[7]`); `tests/routes/nominate.test.ts` (`vi.mock` of `$lib/server/nomination.ts` and `$lib/shell/db.ts` per `tests/routes/auction-open.test.ts:25-39`; the destination guard refuses in Setup; unconfirmed and unbound actor refuse; surface source-text assertions). **Extend** `tests/core/auction-open.test.ts`, which owns the existing League Clock tests, with the reset case and `leagueClockExpiry`.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/nominations.ts` -- fold open nominations by Player and by Team -- AC1, AC2
- [x] `src/lib/core/device-class.ts` -- the pure classifier -- AC5
- [x] `src/lib/core/projection/league-clock.ts` -- the reset case, `lastReset`, and `leagueClockExpiry` -- AC4
- [x] `src/lib/core/rules/nomination.ts` -- the gate, its refusal wording, the consequence sentence -- AC2, AC3
- [x] `src/lib/server/nomination.ts` -- the read, the pool render path, the one transaction -- AC1, AC5
- [x] `src/routes/nominate/+page.server.ts` -- destination guard, confirm, device class, outcome mapping -- AC3, AC6
- [x] `src/routes/nominate/+page.svelte` -- the pool list and the two-part act -- AC6
- [x] Tests per Code Map -- covers the I/O matrix
- [x] `tests/core/auction-open.test.ts` -- extend with the clock reset and expiry -- AC4

**Acceptance Criteria:**
- Given a nomination is accepted, when the Team's position is recomputed, then no cap space is committed, the Team is not Leading Bidder, no Auction Clock exists for that Player, and a Team with zero cap space nominates successfully.
- Given a Team's Nomination Slot is held or a Player is unavailable, when a nomination is attempted, then it is refused and the Player or holding Team is named individually rather than counted.
- Given the nomination command, when it is processed, then it runs lock → load → decide → persist, taking the global advisory lock before reading any state, and the rule reads no clock, no database and no random source.
- Given a nomination is appended, when the League Clock is folded, then its expiry is 48 hours from that Nomination, and the reset set is not widened beyond AD-22's two event types.
- Given any appended `NominationPlaced`, when the row is read back, then `device_class` is non-null and `payload` names the acting Manager, Team and Player.
- Given the surface, when inspected, then every control is a Manager control, nomination is a two-part act, each disabled control states its reason, and no suggested or ranked player appears.

### Review Findings

- [x] [Review][Patch] `refuseNomination`'s doc comment miscounts its own refusals — says "Six of the eight are re-derived INSIDE the transaction" then lists five, and five is correct [src/lib/core/rules/nomination.ts:71]
- [x] [Review][Patch] Code Map's `byTeam` shape is stale — spec says `Record<teamId, fantraxPlayerId>`, code ships `Record<string, OpenNomination>`; the code is right (it lets `slot_in_use` name the Player without a second lookup), the Code Map line was never updated [_bmad-output/implementation-artifacts/spec-2-1-nominate-a-free-agent.md]
- [x] [Review][Patch] Code Map's two signatures are stale — `loadNominationState(client, fantraxPlayerId, actorTeamId)` ships without the actor id, `loadNominatablePool(gateway)` ships with one; both changes are coherent and neither affects an AC [_bmad-output/implementation-artifacts/spec-2-1-nominate-a-free-agent.md]
- [x] [Review][Patch] `leagueClockExpiry` treats a corrupt `origin` and a corrupt `lastReset` inconsistently and unremarkably — an unparseable origin returns `null`, an unparseable reset is silently ignored and the clock computes as though no reset occurred. Behaviour is defensible; the asymmetry is undocumented [src/lib/core/projection/league-clock.ts:121-133]
- [x] [Review][Patch] The `nominate` action does not reject an empty `fantraxPlayerId` before opening a transaction — an empty submit takes the global advisory lock and runs two SQL lookups only to be refused `unknown_player`, unlike the `confirm` check which refuses for free [src/routes/nominate/+page.server.ts:88]
- [x] [Review][Defer] AC6's surface guarantees are asserted by `readFileSync` + `toContain` against `.svelte` source text, never by rendering — dropping the `!confirmed` term from `blocked` leaves every assertion passing [src/routes/nominate/+page.svelte:75] — deferred, pre-existing
- [x] [Review][Defer] AC4 has no production consumer — `leagueClockExpiry` and `leagueClockReducer` are referenced only inside their own module and from tests, so the reset this story exists to introduce changes no observable behaviour yet [src/lib/core/projection/league-clock.ts] — deferred, pre-existing
- [x] [Review][Defer] The "Cannot afford" matrix row is satisfied by construction, not demonstration — its only test asserts `NominationState` has no Money-shaped key rather than placing a nomination for a Team with zero cap space [tests/core/nomination.test.ts:353] — deferred, pre-existing

## Spec Change Log

## Design Notes

**Why the four rule refusals live here and not in Story 2.2.** A command that can append `NominationPlaced` without checking phase, Slot occupancy, board occupancy and Free Agency is not a shippable increment — it double-nominates. Story 2.2 keeps what genuinely needs its own build: uniqueness enforced at the data layer rather than by this check-then-write read, the automated concurrency test, the route's independent phase gate, and the refusal surface treatment. This gate deliberately admits the check-then-write gap that 2.2 closes.

**Why no projection table.** AD-5 creates a projection table in the story that first *reads* one, and nothing reads one: the gate folds from the log inside the transaction exactly as `server/auction-open.ts:88-91` folds three projections over a single read. Story 2.3's AC also requires Slot status to be "a fold over the log … never a stored flag toggled by a handler", so storing it here would have to be undone.

**Why the clock gains a second field.** `LeagueClock` today is `{origin}` alone. AD-22's amended third bullet fixes expiry at `LEAGUE_CLOCK` after the *later* of the origin and the latest surviving reset, so origin and reset must be distinguishable — a single field would let a void recompute back past the open, which the AD forbids. `lastReset` stays null until this story's first nomination.

**Device class stays outside the payload.** It is an envelope column (`shell/write.ts:226`), not domain data: no reducer or gate may read it, or a measurement field would become a rule input.

## Verification

**Commands:**
- `npm test` -- all pass, including the purity, pins and structure gates
- `npm run check` -- clean

**Manual checks (if no CLI):**
- As a Manager at `/nominate` during the Auction Phase: confirm the pool list is operable one-handed at 375px without lateral scrolling, that selecting a player does not submit, that the Slot-held consequence is stated in words beside the confirm, and that a greyscale screenshot leaves every state readable.
