---
title: 'Story 2.3: Nomination Slot lifecycle'
type: 'feature'
created: '2026-08-26'
status: 'in-review'
review_loop_iteration: 0
baseline_commit: '8766c4c4ba9177e7382c15b538f49d2d799fd933'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `nominationsReducer` has no release case, so every nomination stays open forever: a Team gets one nomination for the whole auction, a Player is nominatable once ever. `projection/nominations.ts:14-20` names this story as the fix; `deferred-work.md:216` records it as a live deployment hazard if Story 2.2's migration reaches a hosted project first.

**Approach:** One new case in the fold. `AuctionClosed` for a nominated Player frees that Player's board seat and the nominating Team's Slot together, keyed on the Player. Epic 3 owns closing, so this is proven against a synthetic event, and the claim row's deleter ships tested for Story 3.4 to register.

## Boundaries & Constraints

**Always:** Slot status stays a fold over `auction_events` — `nominationForTeam` remains the only answer to "is this Slot held", and nothing reads `open_nominations` to answer a question (Story 2.2's Always). Release keys on the **Player**: the Slot frees whether the nominator won, lost, or never bid. The reducer is total and defensive — a malformed payload is skipped, never thrown on — and a double fold converges.

**Ask First:** Any read of `open_nominations`. Any release trigger other than `AuctionClosed`. Any change to `AUCTION_CLOSED_EVENT`'s name or the payload key the fold reads, once written — Story 3.4 is built against it. Any new refusal wording.

**Never:** No `AuctionClosed` **producer** — no command, rule, sweep or route appends one; Epic 3 owns closing. No production call site for `releaseNomination`. No `AuctionClosed` in the League Clock reset set — AD-22 fixes it at two and `league-clock.ts:13-19` says why. No "already won" refusal, still unreachable. No expiry, withdrawal or return-to-pool on any timer, and no control to clear a dead nomination — only a Commissioner override (Epic 7.3). **No unbid-age flag, no `core/instant.ts`, no Bid Board** — split out, logged in `deferred-work.md`. No hand-edit of `planning-artifacts/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Released on close | `NominationPlaced`(P, team A), then `AuctionClosed`(P) | Both indexes drop P: `nominationForPlayer(P)` and `nominationForTeam(A)` are `null` | N/A |
| Winner irrelevant | Close names team B as winner, or names none | A's Slot frees identically; the fold reads only the Player | N/A |
| Nominator never bid | Close for P, A absent from bid history | A's Slot frees | N/A |
| Close before open | `AuctionClosed`(P), no prior nomination of P | State unchanged — the reducer is total | No throw |
| Another Player closes | `AuctionClosed`(Q) while A holds P | A's Slot stays held; P stays on the board | N/A |
| Replay converges | The same close folded twice | Identical state — a no-op on an absent key | N/A |
| Re-nomination | P closes, A nominates R | Both indexes carry R; P's entry gone, not overwritten | N/A |
| Malformed payload | Close naming no `fantraxPlayerId`, or a non-object payload | Skipped, state unchanged | No throw |
| Claim row released | `releaseNomination` for `AuctionClosed`(P) | The `open_nominations` row for P is deleted on the appending client | N/A |
| Claim, no row | `releaseNomination` for a Player with no claim row | Zero rows affected | No throw — idempotent |
| Claim, other event | `releaseNomination` handed a `NominationPlaced` | No statement issued | N/A |

</frozen-after-approval>

## Code Map

Read Story 2.1's and 2.2's Code Maps and Design Notes first — the fold discipline, the `ProjectionUpdater` seam and the fake-gateway harness are reused. Nothing here touches `core/rules/nomination.ts`.

- `src/lib/core/projection/nominations.ts` -- edit, the whole story. Add `export const AUCTION_CLOSED_EVENT = 'AuctionClosed'` beside `NOMINATION_PLACED_EVENT:44`. Add the case to `nominationsReducer:170-185`: read `fantraxPlayerId` defensively (mirror `readPayload:134-157`), look it up via `hasOwn:90-92`, and when present rebuild `byPlayer`/`byTeam` omitting that Player's key **and** the holding Team's key. `default: return state` (`:182-183`) stays. Replace the "no release case, and that is deliberate" block (`:14-20`) with the case and the payload contract 3.4 inherits.
- `src/lib/server/nomination.ts` -- edit, additive. Add `export const releaseNomination: ProjectionUpdater` mirroring `claimNomination:334-345`: loop appended events, skip non-`AUCTION_CLOSED_EVENT`, `delete from open_nominations where fantrax_player_id = $1`. Reuse `OPEN_NOMINATIONS_TABLE:309`. **Not added to `placeNomination`'s `projections` (`:455`).** `loadNominationState:111-149` and `loadNominatablePool:206-301` need no change — both already fold through `nominationsReducer` (`:117`, `:216`), so the release reaches every gate for free.
- `src/lib/core/projection/league-clock.ts` -- read-only, verify untouched. `leagueClockReducer:86-102` must not gain a close case.
- `tests/core/nomination.test.ts` -- extend. Every core matrix row as a named test; the synthetic-`AuctionClosed` release is AC1's required one. Event factory pattern at `tests/projection-fold.test.ts:6-9`; state as a literal, no fixtures, no clock.
- `tests/server/nomination.test.ts` -- extend. `releaseNomination` issues one delete per close, none for other types, Player id passed as a parameter. The fake gateway (`:45-175`) throws on unrecognised SQL — add a `'release-nomination'` label.
- `tests/integration/auction-events.test.ts` -- extend, behind the existing `describe.skipIf` (`:24-50`). Insert a claim row, run `releaseNomination` on a real client, assert the row is gone and a second run is a no-op. The only place `20260825000000_open_nominations.sql`'s DELETE grant is exercised.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/nominations.ts` -- the event constant and the release case -- AC1, AC2
- [x] `src/lib/server/nomination.ts` -- add `releaseNomination`, unregistered -- AC3
- [x] `tests/core/nomination.test.ts` -- extend: the synthetic-close table -- AC1, covers the I/O matrix
- [x] `tests/server/nomination.test.ts` -- extend: `releaseNomination`'s statements -- covers the I/O matrix
- [x] `tests/integration/auction-events.test.ts` -- extend: the real delete -- AC3

**Acceptance Criteria:**
- Given a `NominationPlaced` then a synthetic `AuctionClosed` for that Player, when the log is folded, then the nominating Team's Slot is free and the board seat empty — regardless of which Team the close names as winner and whether the nominator ever bid.
- Given the release, when the codebase is inspected, then it is computed by the fold with no stored flag toggled by a handler, nothing reading `open_nominations`, and no trigger but a close — not a timer, not being outbid, not elapsed time.
- Given Epic 3 later appends a real `AuctionClosed`, when it does, then this fold needs no change and the claim deleter exists, tested, awaiting only registration.

## Design Notes

**Keyed on the Player, not the Team.** The Slot and the board seat are two readings of one fact. `byTeam` indexes the same object `byPlayer` holds (`:60-72`), so releasing by Player and dropping the holder's key keeps both consistent by construction. Keying on the Team would need the close to carry the nominator — which it has no reason to know — and would free the wrong Slot if it carried the winner instead.

**The payload contract, fixed here for 3.4.** The fold reads exactly `fantraxPlayerId` and ignores winner, price, Slot Placement, bid history. Deliberate both ways: 3.4 may shape that payload freely without touching this reducer, and this story cannot depend on a field 3.4 has not designed.

**Why `releaseNomination` ships uncalled.** AC3 requires Epic 3 to need no change here, and the delete must run inside the transaction appending the close — 3.4's, not this one's. Tested-but-unregistered makes 3.4 a one-line registration and closes `deferred-work.md:216` with a proven path.

## Verification

**Commands:**
- `npm test` -- all pass, including purity, pins and structure gates. The integration suite skips unless local Supabase is up; run `npx supabase start` with `SUPABASE_DB_URL` exported before calling AC3 proven.
- `npm run check` -- clean, 0 errors 0 warnings.

**Manual checks (if no CLI):**
- `rg -n "open_nominations" src/` shows only the insert in `claimNomination` and the delete in `releaseNomination` — no select.
- `git diff` touches nothing under `src/lib/core/rules/` and does not modify `league-clock.ts`.
