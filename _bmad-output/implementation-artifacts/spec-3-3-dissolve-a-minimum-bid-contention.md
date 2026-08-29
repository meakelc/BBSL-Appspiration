---
title: 'Story 3.3: Dissolve a Minimum-Bid Contention'
type: 'feature'
created: '2026-08-28'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'aada989496e651a5fe24d54e7bc127c46581cc2d'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A lottery can be entered and joined but never left. `evaluateContention` refuses `converts` by name (`rules/bidding.ts:797`) exactly as 2.5 refused `at_the_minimum`, so FR-19 is entirely unbuilt; the sealed seed has no reader at all — `server/bidding.ts:257-259` states outright that "nothing in this codebase selects from `auction_contention_seeds` until Story 3.6's draw" — and `tests/core/bidding.test.ts:915-944` deliberately narrows the "every state's pre-fill passes every gate" invariant around a Team already on the Contender list, naming Story 3.3 as what reopens it. There is no `ContentionDissolved` event type, and a contention that dissolved with its seed still sealed is the one outcome AD-14 cannot survive.

**Approach:** Let `$1,500,000` through, and make everything that follows from it a rule rather than an accident. `decide()` emits **two** events on a dissolution — the converting `BidPlaced`, then `ContentionDissolved` carrying the revealed seed — and it *verifies before it reveals*, throwing unless `hash(sealedSeed)` equals the commitment the log already published. The seed is read under the same lock that appends, on the one connection the sealed table grants anything. Release, clock reset and the change of Leading Bidder are **not** written: they already fall out of `teamMoneyStateFor`'s contention test, `decide()`'s existing fresh-clock branch and `auctionsReducer`'s strictly-higher comparison, and this story's job is to prove that rather than to re-implement it.

## Boundaries & Constraints

**Always:** **`decide()`'s fourth parameter widens from `string | null` to a `ContentionSeed` union** — `{ kind: 'fresh' }` for the seed a lottery-opening commits to, `{ kind: 'sealed' }` for the seed a dissolution reveals, `null` for the overwhelming majority of Bids that are neither. A union and not two adjacent nullable strings: the two are never both meaningful — `fresh` needs `leadingBid === null`, `sealed` needs `contention === 'minimum_bid'` — and every existing `null` call site is unchanged, so the diff lands where the rule changed. **`decide()` verifies before it reveals.** A dissolution with no sealed seed throws, and a sealed seed whose `hash` does not equal `state.seedHash` throws — both AD-1 shell bugs, never Manager-facing refusals. Publishing a reveal that does not match the published commitment is foreclosed structurally, not merely tested for. `BidState` gains `seedHash` for this, read off the fold and already on the wire. **Two events, cause then consequence**: `[BidPlaced, ContentionDissolved]`, appended by the one `runTransactionalWrite` loop that already supports N events (`shell/write.ts:241-260`). **`selfBid` passes inside a live Minimum-Bid Contention** — see Design Notes; this changes a behaviour 3.2 shipped, deliberately and with its test rewritten rather than deleted. **`contenders` is not cleared**, and "the Contender list is discarded" is about commitment and the draw, not about history: `teamMoneyStateFor:531` already tests contention state rather than list emptiness, and `rules/bidding.ts:523-533` says in as many words that this is the line that makes a dissolved contention safe. **Three consequences are facts to test, not code to write**: capital releases because `contention` folds to `standard`; the clock resets because `decide():2618` computes a fresh `closeInstantFor` for anything that is not a join; the converting Team leads because `$1,500,000` is strictly higher. The League Clock is a fourth — `league-clock.ts:123`'s `default: return state` means a new event type does not reset it. Every sentence, label and figure is worded in the core; `evaluate()` stays total; `core/` reads no clock and no randomness.

**Ask First:** Any migration at all — the analysis below concludes none is needed, and needing one means something in this reading is wrong. Any new design token or CSS sizing literal (`tokens.test.ts:159` pins the colour count at 20; `tests/routes/auction-page.test.ts:1047` pins the sizing-literal list at `['-1px','1px','22px','2px']`). A second `<button>` on the Auction page. Putting anything into `auction_events` beyond the revealed seed and its hash. Changing the gate set or the gate order.

**Never:** **No draw and no winner** — the seed is revealed here because this contention will never draw, and 3.6 owns selection, the ordered-list-at-expiry payload and the hand-reproducible derivation. **No close, no `AuctionClosed`, no sweep, no cron, no Deno function** (3.4, 3.5). **No notification delivery and no outbox** (Epic 5): `ContentionDissolved` carries what a dispatcher will need so 5.x adds no handler here, and nothing dispatches it in this story. **No re-opening or re-nomination of a dissolved Auction** — the seed table's `fantrax_player_id`-only primary key stays unreachable because a dissolved Auction continues as the same Standard Contention rather than becoming a second opening; that deferred finding stays open and belongs to Epic 7.2. No Bid Board (Epic 4 — it does not exist). No void, pause or resume (Epic 7). No hand-edit of `planning-artifacts/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| §10 ex 9 — the lottery dissolves | Contention open 20:30 Mon with Contenders E, F, G; Team I bids `$1,500,000` | Accepted. Two events. Fold: `standard`, I leads at `$1,500,000`, close 20:30 Tue. E/F/G's `committedBids` drop by `$1,000,000` each. Next legal bid `$2,000,000` | N/A |
| A Contender converts | Contender F bids `$1,500,000` into its own contention | Accepted, identically. F's own `$1,000,000` commitment is replaced by the `$1,500,000` lead, not added to it | N/A |
| The OPENER converts | Team E — Contender #1 **and** `leadingBid` — bids `$1,500,000` | Accepted. `selfBid` passes because a lottery has no Leading Bidder to bid against | N/A |
| Contender count is irrelevant | One Contender, then twenty | Byte-identical outcome but for the count in the payload and the sentence | N/A |
| Far above the threshold | `$8,000,000` into a live contention | Accepted. `contention` = `converts`; `increment` still reports both figures `null`, because no raise applied to the decision | N/A |
| The dead zone, unchanged | `$1,200,000` submitted | Still refused on `contention` (`neither`) **and** `granularity`. §10 example 10 passes untouched | `fail(409)` |
| The opener re-joins | Opener bids `$1,000,000` again | Refused on `already_contending` **alone** — `selfBid` no longer contributes a second ground | `fail(409)` |
| Pre-fill for a Contender | Team already on the Contender list opens the page | `minimumLegalBid` is `$1,500,000` and passes every gate. The narrowed invariant at `tests/core/bidding.test.ts:915` is restored, not re-narrowed | N/A |
| A join after dissolution | `$1,000,000` into the now-`standard` Auction | Refused on `increment` and `selfBid`/`cap` as an ordinary low bid — never as a join. `contention` reports `not_a_contention` | `fail(409)` |
| No sealed seed in hand | Dissolution reaches `decide()` with `seeds` `null` or `kind: 'fresh'` | **Throws** `TypeError`. A shell that failed to read the seed is a bug (AD-1) | throws |
| The wrong seed | `hash(sealedSeed) !== state.seedHash` | **Throws** `TypeError`, naming both digests. The reveal never reaches the log | throws |
| A commitment that folded to `null` | Corrupt log: live contention, `seedHash` is `null` | Dissolution proceeds and reveals; there is nothing to verify against, and refusing would strand the Auction forever. The page says the reveal is unverifiable | N/A |
| An expired contention | `closesAt` passed, `$1,500,000` submitted | Refused on `expiry` first, unchanged by this story; `contention` still reports `converts` beside it | `fail(409)` |
| The dissolved Auction renders | Fold: `standard`, `seed` non-`null`, `contenders` non-empty | No accent bar and no live Contender list. A dissolution block: the former Contenders in join order, the revealed seed, the published hash, and the sentence that ordinary ascending rules now apply | N/A |
| Viewer bound to no Team | Registered session, dissolved Auction | The whole dissolution block renders; the control is refused as `unbound_actor` | `fail(400)` |

</frozen-after-approval>

## Code Map

One new event type, one widened parameter, one table read. No migration.

- `src/lib/core/projection/auctions.ts` -- **the new event.** `CONTENTION_DISSOLVED_EVENT = 'ContentionDissolved'` beside `BID_PLACED_EVENT` (`:64`) — there is no central event registry and no DB check constraint (`20260821020000_auction_events.sql:63,75` deliberately has "no opinion on what `event_type` values are legal"), so the const beside its reducer is the whole registration. `Auction` (`:157`) gains `seed: string | null`, folded in a new `auctionsReducer` case (`:494`) that reads the payload defensively in `readPayload`'s idiom (`:404`) and keeps the FIRST seed seen, mirroring `seedHash` (`:551-555`). Add the dissolution wording beside `SEED_COMMITMENT` (`:305`) and `CONTENTION_CLOCK_UNMOVED` (`:288`): the dissolution sentence, the seed-revealed sentence, the unverifiable-commitment sentence, and a `formerContenderSentence(count)` beside `contenderCountSentence` (`:325`) — "so far" is the wrong tense for a list that is over. Export ONE predicate, `wasDissolved(auction)`, so the page tests a derivation the core owns rather than assembling `seed !== null && contention === 'standard'` itself. `contendersFor` (`:371`) and `contentionForAmount` (`:352`) are untouched.
- `src/lib/core/types.ts` -- extend. `ContentionGateOutcome`'s `entry` union is unchanged — `converts` stays named, only its verdict moves. Correct the `converts` doc, which says it is refused. `PLACE_BID_GATES` (`:505`) is **untouched**: no gate is added, so this story spends no compile-error budget.
- `src/lib/core/rules/bidding.ts` -- most of the implementation.
  - `ContentionSeed` union, exported, declared beside `BidPlacedPayload` (`:2523`). `decide` (`:2591`) takes it as its fourth parameter.
  - `evaluateContention` (`:771`): `converts` becomes `passed: true`. One line; the comparison at `:794` is unchanged.
  - `evaluateSelfBid` (`:809`): passes when `state.contention === 'minimum_bid'`, for the reason `evaluateIncrement` (`:840`) already steps aside. Rewrite `:802-808`.
  - `BidState` (`:269`) gains `seedHash: string | null`; `bidStateFor` (`:425`) reads it off the `Auction`, `null` on the `null` branch.
  - `minimumLegalBid` (`:621`) takes the acting Team id as a second parameter — available at its one production call site (`server/auction-page.ts:664`, which already holds `viewerTeamId`). In a live contention it is `MINIMUM_BID` for a Team not yet in and `CONVERSION_AMOUNT` (`:727`) for one already in. Rewrite `:612-620`, which states the state that had no legal amount.
  - `decide` (`:2591`): the seed branch splits by `ContentionSeed.kind`; a dissolution is `gates.contention.entry === 'converts'`, asked off the gate rather than re-derived. On one, verify the hash, then append `ContentionDissolved` after the `BidPlaced`. `closesAt` needs **no** change — `:2618` already computes a fresh instant for anything that is not a join. Rewrite `:2560-2585`.
  - `gateSentence` (`:1513`): delete the `converts` refusal branch at `:1568-1580` — the `if (outcome.passed) return null` at `:1555` now covers it. `gateFigure` (`:1948`): the `converts` figure at `:2008-2013` must state what happened, not what would. `GATE_LABELS` (`:2155`) is unchanged.
- `src/lib/server/bidding.ts` -- extend. `loadBidState` (`:174`, returning `LoadedBidState` at `:124`) reads the sealed seed on the transaction's own `client` when the folded Auction is `minimum_bid` — the same discipline `loadNominationState` uses for its point reads (`server/nomination.ts:130-135`), and it must go through this `client` and not `server/supabase.ts`, because `20260828000000_contention_seeds.sql:77-88` grants `anon`, `authenticated` and `service_role` nothing. `placeBid` (`:337`) chooses the `ContentionSeed` from the loaded state: `sealed` in a live contention, `fresh` otherwise. `recordContentionSeed` (`:286`) is **read-only** — it keys on `seedHash` and a dissolution's `BidPlaced` carries none, so no second row is written and no `on conflict` is needed. Correct `:257-259` and `:320-333`.
- `src/lib/server/auction-page.ts` -- extend. `AuctionPageState` (`:301`) gains `seed: string | null`. `AuctionPageBidControl` (`:201`) needs **no** new field: the browser rebuilds `BidState.seedHash` from the `seedHash` already serialised. `readBidControl` (`:653`) passes `viewerTeamId` to `minimumLegalBid` (`:664`).
- `src/routes/auction/[fantraxPlayerId]/+page.svelte` -- the one surface edit. Beside the lottery block (`:621-675`), a dissolution block gated on the core's `wasDissolved`: the former Contenders, the revealed seed, the published hash, the core's sentences. Reuse `.seed-hash` (`:1009-1014`) and existing spacing tokens — **no new token and no new sizing literal**. `gateState` (`:308-324`) gains `seedHash`. Four guards hold: no `Minimum-Bid Contention` spelled in the route (`tests/routes/auction-page.test.ts:254`), no conditional `class="{...}"` (`:560`), exactly one `<button>` (`:631`), no new sizing literal (`:636-647`, `:1027-1047`).
- `tests/examples/example-09-the-lottery-dissolves.test.ts` -- **new**, registered in `tests/structure.test.ts`'s `SECTION_10_EXAMPLES` (`:51-91`) with the story note (`:29-50`) extended. Follow `example-07`'s idiom exactly: PRD text quoted verbatim, file-local helpers, state literals, direct core calls, no database and no clock mocking.
- `tests/core/bidding.test.ts` -- largest test edit. The conversion table; `selfBid` passing in a contention and the opener's re-join refused on `already_contending` alone (rewriting `:1017-1027`); the two `decide()` throws; and `:915-944`'s narrowing **restored to the general invariant** at `:902-913` rather than left with a smaller exception.
- `tests/projection-auctions.test.ts` -- the `ContentionDissolved` fold: `seed` recorded, first-seen kept, a malformed payload nulled not thrown, an event naming no Player skipped, and `contenders`/`bids` untouched by it.
- `tests/server/bidding.test.ts` -- the sealed read happening under the lock; both events appended in one transaction in order; **no** second seed row on a dissolution; the raw seed absent from the converting `BidPlaced`.
- `tests/core/auction-open.test.ts` -- the League Clock fold's own file (there is no `league-clock.test.ts`): that `ContentionDissolved` does not reset the clock while the converting `BidPlaced` beside it does. Example 9 asserts the same fact end-to-end, exactly as `example-07` did for a join.
- `tests/server/auction-page.test.ts`, `tests/routes/auction-page.test.ts` -- `seed` on the wire, the dissolution block, and the four route guards still passing.
- `supabase/migrations/`, `src/lib/core/hash.ts`, `src/lib/components/RefusalPanel.svelte`, `CapBreakdown.svelte`, `+page.server.ts` -- **read-only.** Any edit here is a finding: say which and why.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/auctions.ts` -- the event const, `Auction.seed`, the reducer case, `wasDissolved`, the four sentences -- AC3, AC5
- [x] `src/lib/core/types.ts` -- correct the `converts` doc; assert `PLACE_BID_GATES` is untouched -- AC1
- [x] `src/lib/core/rules/bidding.ts` -- `ContentionSeed`; `converts` passes; `selfBid` steps aside; `BidState.seedHash`; `minimumLegalBid` by acting Team; `decide()`'s verify-then-reveal and second event; the sentence and figure -- AC1-AC5
- [x] `src/lib/server/bidding.ts` -- the sealed read under the lock, the `ContentionSeed` choice, `recordContentionSeed` left alone -- AC3
- [x] `src/lib/server/auction-page.ts`, `+page.svelte` -- `seed` serialised; the dissolution block rendered from the core's own wording -- AC5
- [x] `tests/examples/example-09-*.test.ts` + `tests/structure.test.ts` -- §10 example 9 as a named test, registered -- AC2
- [x] `tests/core/bidding.test.ts` -- conversions, `selfBid` in a lottery, the two throws, and the restored pre-fill invariant -- AC1-AC4
- [x] `tests/projection-auctions.test.ts`, `tests/core/auction-open.test.ts`, `tests/server/bidding.test.ts` -- the fold, the League Clock non-reset, the transaction -- AC3, AC6
- [x] `tests/server/auction-page.test.ts`, `tests/routes/auction-page.test.ts` -- the wire shape and the four route guards -- AC5
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- mark the Story 2.8 examples-19/20 entry resolved; it was closed by 3.2 -- AC7

**Acceptance Criteria:**
- Given a live Minimum-Bid Contention, when a Bid of `$1,500,000` or more is placed by any Team — a Contender, the opening bidder, or a Team that never joined — then it is accepted, `contention` reports `converts` as a pass, `selfBid` passes, and `increment` still reports both figures `null`.
- Given that acceptance, when the events fold, then the Auction is `standard`, the converting Team is Leading Bidder at its amount, the Auction Clock is 24 hours from the converting Bid, every former Contender's `$1,000,000` commitment is gone, and the next legal bid is one Minimum Increment above the converting amount — identically for one Contender and for twenty.
- Given a dissolution, when `decide()` runs, then it emits exactly two events in the order `BidPlaced`, `ContentionDissolved`; the second carries the revealed seed, its published hash and the ordered former Contenders; both are appended in one transaction; no second seed row is written; and the raw seed appears in no `BidPlaced` payload.
- Given a dissolution, when the sealed seed is absent, or is present but does not hash to the commitment the log published, then `decide()` throws rather than returning a refusal, and no event reaches the log.
- Given a dissolved Auction on its page, when it renders, then it shows no `lottery` accent bar and no live Contender list, and does show the former Contenders in join order, the revealed seed, the published hash and a statement that ordinary ascending rules now apply — every phrase worded in the core, for every viewer, bound to a Team or not.
- Given the League Clock fold, when `ContentionDissolved` is applied, then the clock does not reset, while the converting `BidPlaced` beside it does.
- Given the repository, when `npm test`, `npm run check` and `npm run check:purity` run, then all pass with no growth in the pre-existing `SUPABASE_DB_URL` integration failure, `supabase/migrations/` is unchanged, and `core/` still reads no clock and no randomness.

## Spec Change Log

## Design Notes

**`selfBid` steps aside inside a lottery, and this changes a behaviour 3.2 shipped.** FR-19 states plainly that "a Team that was a Contender may itself be the converting bidder," and Story 3.2 records the opening bidder as Contender #1 — who is also, unavoidably, `auctionsReducer`'s `leadingBid`, because a join is never strictly higher. Left alone, `evaluateSelfBid` would freeze exactly one Team out of converting: the one whose money opened the lottery, and the one FR-19's own scenario is about. The rule is not "the opener is special", it is that **a Minimum-Bid Contention has no Leading Bidder at all** — `leadingBid` there is a fold artifact, which is why `evaluateIncrement` already nulls `currentHigh` in a contention rather than reporting `$1,000,000` as an amount to beat. `selfBid` steps aside for the identical reason, and the consequence is deliberate: 3.2's I/O matrix has the opener re-bidding `$1,000,000` refused on *both* `selfBid` and `contention`, and that becomes `already_contending` alone. That is not a suppressed ground — it is a ground that was never true, reported because the gate could not yet see it.

**Verify, then reveal.** The shell reads a seed and the core publishes it; between those two steps sits the only failure AD-14 cannot survive, which is a reveal that does not match the commitment a Manager already checked. `decide()` closes it by hashing what it was handed and comparing against `state.seedHash` before building the payload. This is why `BidState` gains `seedHash` — a public value, already serialised to the page — and why the raw seed never goes near that shape.

**The payload carries more than the fold reads, on purpose.** `auctionsReducer` reads only `fantraxPlayerId` and `seed`. The ordered former Contenders, the converting Team and the amount ride along because Epic 5's dispatcher must notify every former Contender from one event without re-folding, and because 3.6 will append the ordered list at expiry for the same reason. A field nothing reads yet is worth flagging; these are named here so a reviewer sees the choice rather than the omission.

**No migration, and that is a conclusion rather than an oversight.** The seed table's `fantrax_player_id` primary key collides only if a Player reaches a *second* contention opening. A dissolved Auction does not re-open — it continues as the same Standard Contention under ordinary ascending rules — so no path in this story writes a second row, and `recordContentionSeed` never fires on a dissolution because that `BidPlaced` carries no `seedHash`. The deferred finding stays open against Epic 7.2, which is where a void-and-restore genuinely creates a second opening.

```
Auction Clock · Passed     23h 12m left
Opening       · Passed     a Bid already leads, so no opening minimum applies
Contention    · Passed     dissolves this Minimum-Bid Contention, releasing 4 Contenders
Self-bid      · Passed     no Team leads a Minimum-Bid Contention
Increment     · Passed     no raise applies in a Minimum-Bid Contention
Granularity   · Passed     on the $500.0K grid
Cap           · Passed     Maximum Bid $14.0M, offered $1.5M
Slots         · Passed     Roster Count would be 10 of 12
```

## Verification

**Commands:**
- `npm test` -- all pass. Baseline measured on `aada989` is **1798 passed / 1 failed** across 73 files, the failure being the pre-existing `SUPABASE_DB_URL is not set` integration case (`deferred-work.md`). It must not grow.
- `npm run check` -- 0 errors, 0 warnings.
- `npm run check:purity` -- clean.

**Manual checks (if no CLI):**
- `git diff --stat supabase/migrations/` is empty, and `git status --short supabase/` shows no new file.
- `rg -n "seed" src/lib/core/rules/bidding.ts` shows the raw seed reaching a payload only in `ContentionDissolved`, and reaching `BidPlaced` only through `hash()`.
- `rg -n "auction_contention_seeds" src/lib/server/bidding.ts` shows exactly one `insert` and exactly one `select`, both on the transaction's `client`.
- `rg -n "class=\"[^\"]*\{" src/routes/auction/` returns nothing, and `rg -c "<button" "src/routes/auction/[fantraxPlayerId]/+page.svelte"` is still `1`.
- `rg -n "Minimum-Bid Contention" "src/routes/auction/[fantraxPlayerId]/+page.svelte"` returns nothing — the route imports the label, never spells it.
- `git diff --stat` changes no executable line in `src/lib/components/`, `+page.server.ts` or `src/lib/core/hash.ts`. Anything more is a finding: say which and why.

## Review Findings

Code review 2026-08-29 (`bmad-code-review`, four layers: blind-hunter, edge-case-hunter, verification-gap, and acceptance-auditor on `bmad-reviewer-acceptance` — the opus variant, because the diff touches `src/lib/core/` and three ACs are negative invariants). The review diff was assembled to include the untracked `example-09` file, which `git diff` alone would have hidden from every layer. All three gates pass: `npm test` 1865 passed / 1 failed (the pre-existing `SUPABASE_DB_URL` case, unchanged from the 1798/1 baseline), `npm run check` 0 errors / 0 warnings, `npm run check:purity` clean.

- [x] [Review][Patch] The converting Team was counted among the Contenders "released" — in the payload doc, in the `contention` panel figure, and in the page's former-Contender sentence. Two layers found it independently. The list is deliberately NOT filtered: it is the historical record the reveal is about and the ordered list 3.6 needs, and `convertingTeamId` beside it is how a consumer excludes the converter. What was false was the claim, so the claim changed [src/lib/core/rules/bidding.ts:2711, :2095; src/lib/core/projection/auctions.ts:432]
- [x] [Review][Patch] `ContentionDissolved` recorded a reveal onto an Auction that was never a lottery. Guarded on the Contender list, **not** on contention state — the reviewer's proposed `existing.contention !== 'minimum_bid'` guard would have rejected every genuine dissolution, because the converting `BidPlaced` folds first and has already moved the Auction to `standard` [src/lib/core/projection/auctions.ts:781]
- [x] [Review][Patch] The module header still said a contention is "dissolved nowhere" and that a conversion is "REFUSED by name" — this diff is what made both false. Four further pre-3.3 claims in the same block corrected alongside it [src/lib/core/rules/bidding.ts:109]
- [x] [Review][Patch] `expect(detail).toContain('Team')` was satisfied by almost any sentence in the panel's vocabulary; it now asserts the actual unbound refusal [tests/server/auction-page.test.ts:1576]

- [x] [Review][Defer] The corrupt-log path — a live contention whose `seedHash` folded to `null` — is proven at the core level but never end-to-end through `placeBid`. Logged against Story 3.6, which builds the reveal-verification surface

**Rejected as noise (9).** Four were factually wrong and were checked rather than assumed: `bidRefusalDelta` reported as an undefined typo (it is exported at `rules/bidding.ts:2323` and imported at `tests/core/bidding.test.ts:36`); `minimumLegalBid`'s widened signature reported as possibly missing call sites (16 sites, and `svelte-check` is clean); the `deferred-work.md` resolution note reported as citing tests absent from the diff (the note is accurate — a second layer independently verified both files); and `sprint-status.yaml` reading `in-progress` mid-workflow. The rest: the payload's `convertingTeamId`/`amount` fields read as breaching the frozen Ask First gate — the human chose exactly those fields when the notification boundary was put to them at planning time; the fold not re-verifying `seedHash` — verified at write time by design, and re-deriving it in a disposable projection is the drift AD-5 forbids; no route-level HTTP test — the dissolution travels the same route path as every other Bid and adds no wiring; and the page being verified by source text rather than a rendered component, which is pre-existing and already deferred from Story 3.1.

**Review outcome (2026-08-29).** All 4 `patch` findings applied, 1 deferred, 9 rejected. No `intent_gap` and no `bad_spec`, so no loopback: `review_loop_iteration` stays 0. Seven tests were added alongside the fixes, so every corrected claim and the new fold guard are asserted rather than merely applied.

## Suggested Review Order

**The rule that changed**

- The one-line verdict flip that is the whole story — the comparison is untouched.
  [`bidding.ts:840`](../../src/lib/core/rules/bidding.ts#L840)

- Verify-then-reveal, then two events. The hash check forecloses a wrong reveal structurally.
  [`bidding.ts:2843`](../../src/lib/core/rules/bidding.ts#L2843)

- `selfBid` steps aside: a lottery has no Leading Bidder, so FR-19's Contender may convert.
  [`bidding.ts:903`](../../src/lib/core/rules/bidding.ts#L903)

- The union that keeps `fresh` and `sealed` from ever being transposed at a call site.
  [`bidding.ts:2755`](../../src/lib/core/rules/bidding.ts#L2755)

- The pre-fill a Contender had no answer for until now — the narrowed invariant, reopened.
  [`bidding.ts:682`](../../src/lib/core/rules/bidding.ts#L682)

**What the log records**

- The payload, and the header stating why the Contender list is deliberately unfiltered.
  [`auctions.ts:2711`](../../src/lib/core/rules/bidding.ts#L2711)

- Records the reveal and nothing else — release, clock and lead are the `BidPlaced`'s doing.
  [`auctions.ts:748`](../../src/lib/core/projection/auctions.ts#L748)

- The guard, and why guarding on contention state instead would break every dissolution.
  [`auctions.ts:781`](../../src/lib/core/projection/auctions.ts#L781)

- One new field on the fold; `contenders` is not cleared, because the reveal is about it.
  [`auctions.ts:233`](../../src/lib/core/projection/auctions.ts#L233)

**The seed leaves the sealed table**

- The table's only reader, on the one connection holding any privilege on it.
  [`bidding.ts:306`](../../src/lib/server/bidding.ts#L306)

- Read under the same lock that appends, so the seed and the event cannot disagree.
  [`bidding.ts:209`](../../src/lib/server/bidding.ts#L209)

**What a Manager sees**

- The one derivation, so no surface assembles "dissolved" from two fields itself.
  [`auctions.ts:452`](../../src/lib/core/projection/auctions.ts#L452)

- The figure that claims no release — a Contender who converts was not released.
  [`bidding.ts:2095`](../../src/lib/core/rules/bidding.ts#L2095)

- Worded past-tense and beside a Leading Bidder line that may name one of them.
  [`auctions.ts:432`](../../src/lib/core/projection/auctions.ts#L432)

- No accent bar, no live list; the reveal, or the sentence saying it cannot be checked.
  [`+page.svelte:711`](../../src/routes/auction/%5BfantraxPlayerId%5D/+page.svelte#L711)

**Peripherals**

- PRD §10 example 9, end to end against a real folded log.
  [`example-09:186`](../../tests/examples/example-09-the-lottery-dissolves.test.ts#L186)

- A new event type does not reset the League Clock — a fact tested, not code written.
  [`auction-open.test.ts:371`](../../tests/core/auction-open.test.ts#L371)
