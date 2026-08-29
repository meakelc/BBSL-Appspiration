---
title: 'Story 3.2: Enter and join a Minimum-Bid Contention'
type: 'feature'
created: '2026-08-28'
status: 'done'
review_loop_iteration: 0
baseline_commit: '78da0eccd237a9e1ba32a131f83ac82452c7324a'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The lottery is the one rule this codebase can fold but cannot create. `evaluateOpening` refuses exactly `$1,000,000` by name (`rules/bidding.ts:589`), the `minimum_bid` literal exists only so `example-26` can build one by hand (`projection/auctions.ts:74-82`), `teamMoneyStateFor` says outright "Only the leader is visible in today's fold; Story 3.2 introduces the Contender list and must extend this one expression" (`:417`), and the Auction page prints `contentionSentence` as unstyled prose with no accent bar, no Contender count and no list (`+page.svelte:592`). AD-14 — the commit-reveal that makes a Commissioner who is also a rival acceptable, and which "fails completely if the seed is readable before the draw" — is entirely unbuilt.

**Approach:** Let a $1,000,000 Opening Bid through, and make everything that follows from it a rule rather than an accident. An eighth gate, `contention`, owns every amount question inside a lottery — join, join-twice, the dead zone, and the conversion this story deliberately does not build. The Contender list is folded from the Bids the log already holds, ordered by `seq`. The fixed clock is enforced in `decide()`, which stamps the contention's *existing* close instant onto a join rather than a fresh one. The seed is generated in the shell, sealed in a table no role can read, and reaches the log only as `hash(seed)` on the opening Bid's payload.

## Boundaries & Constraints

**Always:** `PLACE_BID_GATES` gains exactly one entry — `'contention'`, immediately after `'opening'` — the single edit in `core/types.ts` that makes every consumer a compile error, as 2.6, 2.7 and 3.1 each spent it. **The fixed clock is `decide()`'s, not the fold's.** A join's `BidPlaced` payload carries `state.closesAt` verbatim; a fresh `closeInstantFor(now, AUCTION_CLOCK)` is computed only for an opening or a raise. The fold preserving the clock because a join is never strictly higher is a *second* guarantee, and both are tested — a persisted payload that says a join closes 24 hours from itself is a lie 3.5's sweep would act on. **Contender order is ascending join `seq`** (AD-14), deduplicated on `teamId` keeping the earliest, derived once in `projection/auctions.ts` and read everywhere else. **The seed never enters `auction_events` and never leaves the server.** `decide()` receives it through the fourth parameter that has been declared and `void`ed since 2.5 (`rules/bidding.ts:2243`), publishes only `hash(seed)`, and throws when an opening arrives with a `null` seed — a shell that failed to supply one is a bug (AD-1). `hash` is SHA-256, implemented pure in the core so both runtimes and a Manager checking by hand compute the same commitment. **The increment rule does not apply in a Minimum-Bid Contention** and reports both figures `null`, exactly as it already does for an opening (`:624`) — there is no ascending raise to be short of, and `contention` owns the amount instead. `granularity` still reads the amount and nothing else. Capital commits by eligibility through `teamMoneyStateFor`'s ONE existing `minimum_bid` substitution (`:453`), widened from the leader to every Contender. Every sentence, chip, label and figure is worded in the core; `evaluate()` stays total; `core/` reads no clock and no randomness.

**Ask First:** Any second migration, or any column on the seed table beyond what the draw needs. Changing the gate ORDER once chosen. Putting the seed, or anything derived from it beyond `hash(seed)`, into `auction_events`. A second `<button>` on the Auction page (`tests/routes/auction-page.test.ts:539-549` asserts exactly one). A new design token — `--color-lottery`, `--color-lottery-text` and `--accent-bar-width` already exist unused (`styles/tokens.css:49-51`, `:105`) and `tests/tokens.test.ts:159` pins the colour count at 20. Any new CSS sizing literal (`auction-page.test.ts:905-926` pins the allowed list).

**Never:** **No dissolution.** A Bid of `$1,500,000` or more into a live contention is REFUSED by name on `contention`, exactly as 2.5 refused `at_the_minimum` by name rather than half-doing it — the Contender release, the seed reveal and `ContentionDissolved` are Story 3.3, and a conversion that silently released commitments while leaving the seed sealed is the one outcome AD-14 forbids. **No draw**, no winner, no `hash` verification path, no reveal (3.6). No close, no `AuctionClosed`, no sweep, no cron, no Deno function (3.4, 3.5). No League Clock work (3.7) — a join resets it because `league-clock.ts` already folds every accepted `BidPlaced`, and that is a fact to *test*, not code to write. No Bid Board (Epic 4 — it does not exist; the accent bar, count and list land on the Auction page only). No notifications (Epic 5). No pause, resume or void (Epic 7). No hand-edit of `planning-artifacts/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| §10 ex 6 — the lottery opens | Awaiting Opening Bid, opened at exactly `$1,000,000` 09:00 Mon | Accepted. `contention` = `minimum_bid`, close fixed 09:00 Tue, opener is Contender #1, payload carries `seedHash` and a seed row is written | N/A |
| §10 ex 7 — three joins, clock unmoved | Contention open, F/G/H each bid `$1,000,000` at 14:00, 20:00, 08:55 Tue | All accepted; each join's payload `closesAt` **is** 09:00 Tue; the fold's close time is 09:00 Tue after all three; Contenders E,F,G,H in `seq` order | N/A |
| Joining twice | Acting Team already on the Contender list, bids `$1,000,000` | Refused on `contention` alone (`already_contending`); the other seven report their own arithmetic | `fail(409)` |
| The opening bidder re-bids | Opener bids `$1,000,000` again | Refused on **both** `selfBid` and `contention` — two true grounds, neither suppressed | `fail(409)` |
| §10 ex 10 — the dead zone | Contention open, `$1,200,000` submitted | Refused on `contention` (neither a join nor a conversion) **and** `granularity` (off-grid); `increment` PASSES with both figures `null` | `fail(409)` |
| A conversion attempt | Contention open, `$2,000,000` submitted | Refused on `contention` alone, named as deferred to 3.3. Not silently accepted as a raise | `fail(409)` |
| §10 ex 21 — eligible join commits nothing | `$0` Available Cap Space, 3 free Minor League Slots, no other eligible leads | Accepted. `N=1`, `M=3`, Overflow 0, Minors Exposure `$0`; `cap` passes `unbounded` | N/A |
| §10 ex 22 — an overflowing join does commit | Same Team leading eligible Auctions at `$5.0M`/`$4.0M`/`$3.0M`, `$0` Available | Refused on `cap`; `N=4`, `M=3`, Overflow 1, Minors Exposure `$5,000,000`, and `exposingBids` names the `$5,000,000` Auction | `fail(409)` |
| A non-eligible join | Player not Minor League Eligible | Flat `$1,000,000` into Committed Bids for **every** Contender, not only the leader — any Contender may win | N/A |
| A lottery that has expired | `closesAt` passed, join submitted | Refused on `expiry` first, unchanged by this story; `contention` still reports its own outcome | `fail(409)` |
| Standard Contention, unchanged | Any Auction not at exactly `$1,000,000` | `contention` passes as `not_a_contention` with no figures; `increment` and every other gate behave exactly as on `main` | N/A |
| An opening reaches `decide()` with no seed | `seed` is `null`, gates all pass, amount is `MINIMUM_BID` | **Throws** `TypeError`. A missing seed is a shell bug, not a Manager-facing refusal (AD-1) | throws |
| A malformed Bid in a folded lottery | Log holds a `$1,000,001` `BidPlaced` on a `minimum_bid` Auction | Folded into `bids` and history as it is today, but **not** a Contender — the list filters on exactly `MINIMUM_BID` | N/A |
| Viewer bound to no Team | Registered session, live contention | Accent bar, icon, word, Contender count and list all render; the control is refused as `unbound_actor` | `fail(400)` |

</frozen-after-approval>

## Code Map

The lottery is folded from Bids the log already holds; the only thing stored is the seed. One migration, one new core module, one new gate.

- `supabase/migrations/20260828000000_contention_seeds.sql` -- **new.** `auction_contention_seeds`: `fantrax_player_id text primary key`, `seed text not null`, `created_at timestamptz not null`. Follow the idiom every existing table uses verbatim (`open_nominations.sql:70-71`, `:80-81`): `enable row level security` **and** `force row level security`, **no `create policy`**, `revoke all from anon`, `revoke all from authenticated` — and, unlike every other table, **`revoke all from service_role` with no grant back**. `auction_events` grants `service_role` select/insert (`auction_events.sql:103-104`); this table grants it nothing, so the only reachable identity is the direct `SUPABASE_DB_URL` connection `shell/db.ts:35-50` opens, which is what `write.ts` already inserts through. That is AD-14's "no manager-facing role, the Commissioner's included" — and the Commissioner is an application flag on `managers.is_commissioner` (`teams.sql:67`), never a database role, so there is no separate role to deny.
- `src/lib/core/hash.ts` -- **new.** Pure SHA-256 over a UTF-8 string → lowercase hex. Stdlib only, no `node:crypto`, no `crypto.subtle` (async, and AD-2 forbids the import), so Node, Deno and a Manager with any SHA-256 tool all produce one commitment. Test against the published `""`, `"abc"` and one long vector before anything else uses it.
- `src/lib/core/projection/auctions.ts` -- extend. Export the currently-private `contentionFor` as `contentionForAmount(amount)` (`:196`) so the rules module reads contention through the ONE derivation the reducer uses. Add `contenders: readonly Contender[]` and `seedHash: string | null` to `Auction` (`:115`), both folded in `auctionsReducer` (`:301`): Contenders are `bids` with `amount === MINIMUM_BID` in `seq` order, deduplicated on `teamId` keeping the earliest; `seedHash` is read defensively off the payload in `readPayload` (`:221`) — absent or non-string is `null`, never a throw. Add the two sentences the page prints: the lottery's own label and **the clock-will-not-reset statement**, beside `contentionSentence` (`:177`) which already owns this wording. `closesInPhrase` and `hasExpired` are untouched.
- `src/lib/core/types.ts` -- extend. New `ContentionGateOutcome = GateOutcome & { entry: 'not_a_contention' | 'joins' | 'already_contending' | 'converts' | 'neither'; offered: Money; joinAmount: Money; conversionAmount: Money; contenderCount: number }` — counts and the two thresholds, **no Cap figure and no close instant**, which is `SlotsGateOutcome`'s and `ExpiryGateOutcome`'s structural discipline (`:439`, `:474`). Add `'contention'` to `PLACE_BID_GATES` after `'opening'` (`:505`) and the key to `PlaceBidGateResults` (`:526`). Correct `OpeningGateOutcome`'s `at_the_minimum` doc (`:243-244`), which says this amount is refused.
- `src/lib/core/rules/bidding.ts` -- extend; most of the implementation.
  - `BidState` (`:241`) gains `contention: ContentionState` and `contenders: readonly string[]` — ids only, no names, keeping `LeadingBid`'s narrowing (`:198`). `bidStateFor` (`:365`) reads both off the `Auction` it already receives; the `null` branch gives `'awaiting_opening_bid'` and `[]`. **No caller signature changes**, exactly as 3.1 needed none.
  - `evaluateOpening` (`:582`): `at_the_minimum` becomes `passed: true`. Rewrite `:574-578`.
  - `evaluateContention(state, amount, actingTeamId)`: `not_a_contention` when contention is not `minimum_bid` → passes with `contenderCount: 0`. Otherwise exactly `MINIMUM_BID` → `joins` unless the Team is already in `contenders` → `already_contending`; `>= MINIMUM_BID + INCREMENT` → `converts`, **refused**, named as 3.3's; anything else → `neither`, refused.
  - `evaluateIncrement` (`:622`): returns the no-rule-applies shape when contention is `minimum_bid`, for the reason `:624` already gives for an opening. Rewrite the header (`:610-621`).
  - `teamMoneyStateFor` (`:429`): the `minimum_bid` substitution at `:453` currently fires only when this Team holds `leadingBid`; widen the `:448` leader filter so a Team that is any Contender contributes `MINIMUM_OPENING_BID`, still partitioned by eligibility into `leading`/`eligibleLeading` by the single existing branch (`:456`). This one change is §10 examples 21 and 22. Rewrite `:410-418`.
  - `decide` (`:2237`): stop `void seed` (`:2243`). Compute `closesAt` as `state.closesAt` when `gates.contention.entry === 'joins'` and `closeInstantFor(now, AUCTION_CLOCK)` otherwise; add `seedHash: hash(seed)` to `BidPlacedPayload` (`:2203`, optional) only when this Bid opens a contention, throwing when `seed` is `null` there. Rewrite `:105-109` and `:2227-2228`, which name 3.6 as the seed's first consumer.
  - `gateSentence` (`:1274`), `gateFigure` (`:1675`), `GATE_LABELS` (`:1831`) gain `contention`. The label is the glossary term so the chip cannot be mistaken for another gate's. `bidGateReport` and `bidRefusalDelta` iterate `PLACE_BID_GATES` and need **no** edit. `minimumLegalBid` (`:507`) must pre-fill `MINIMUM_BID` — no longer `MINIMUM_BID + INCREMENT` — for an opening, since the opening gate now passes it, and `MINIMUM_BID` in a live contention; `:495-505` states the derivation this changes. **One state has no legal amount at all**: a Team already on the Contender list, for whom `$1,000,000` is `already_contending` and everything above is `converts`. `tests/core/bidding.test.ts:504`'s "every state's pre-fill passes every gate" invariant does not hold there and must be narrowed deliberately, naming this state and 3.3 as what reopens it — not by weakening the assertion.
- `src/lib/server/bidding.ts` -- extend. Generate the seed here (`node:crypto` `randomBytes(32).toString('hex')` — the shell may, the core may not) and pass it to `decide()` in place of the `null` at `:268`; correct `:219-222`. Register ONE `ProjectionUpdater` (`shell/write.ts:178-184`) that inserts the seed row **iff** the accepted `BidPlaced` payload carries a `seedHash` — the shell reading the core's own output, never re-deriving the rule. Model it on `claimNomination` (`server/nomination.ts:337`, registered at `:525`), including its write-side-only discipline. Correct `:33-40`, which fixes the gate set at seven.
- `src/lib/server/auction-page.ts` -- extend. `AuctionPageState` (`:286`) gains the Contender list (team names, in order), the count, and `seedHash`. `contention` stays `contentionSentence(contentionOf(auction))` (`:538`) — the wording is the core's. Serialise **no** derived flag: no `isLottery`, no `youAreContending`.
- `src/routes/auction/[fantraxPlayerId]/+page.svelte` -- the one surface edit. The Price panel's contention line (`:592`) gains the 3px left accent bar in `--color-lottery`, an icon **and** a word, the live Contender list and count, the core's clock-will-not-reset sentence, and `seedHash`. `gateState` (`:288`) gains `contention` and `contenders`. **Four guards constrain this** and none may be relaxed without saying so: the route may not spell `Minimum-Bid Contention` itself (`tests/routes/auction-page.test.ts:254`); no conditional `class="{...}"` (`:928-934`) — use Svelte's `class:` directive; exactly one `<button>` (`:539-549`) — joining is placing a `$1,000,000` Bid through the form that already exists, not a second control; no new CSS sizing literal (`:905-926`).
- `tests/examples/` -- five new files, registered in `tests/structure.test.ts`'s `SECTION_10_EXAMPLES` (`:46-72`) with the story note (`:29-45`) updated from "Story 3.1 added NONE": `example-06-lottery-opens`, `example-07-lottery-grows-clock-unmoved`, `example-10-the-dead-zone`, `example-21-a-lottery-on-an-eligible-player-commits-nothing`, `example-22-a-lottery-that-overflows-does-commit`. Follow `example-24`'s idiom exactly: the PRD text quoted verbatim in the docblock, then state literals and direct core calls, no database and no clock mocking.
- `tests/core/bidding.test.ts` -- largest test edit. `:126`'s literal gate list gains `contention` in its new position. The join/dead-zone/conversion/already-contending table; the both-grounds cases in `PLACE_BID_GATES` order; and that `minimumLegalBid`'s pre-fill still passes every gate in every state, which is how `:504` asserts the derivation rather than the constant.
- `tests/projection-auctions.test.ts` -- the Contender derivation: `seq` order, dedup keeping the earliest, the `$1,000,001` non-Contender, `seedHash` absent/malformed → `null`, and that a join never moves `closesAt` or `leadingBid`.
- `tests/server/bidding.test.ts` -- the seed row written in the same transaction as the opening event and **not** written on a join or a raise; the join payload carrying the contention's original `closesAt`; the raw seed absent from every appended payload.
- `tests/integration/auction-events.test.ts` -- the AD-14 assertion, in the file that already owns role-grant testing: `anon`, `authenticated` **and** `service_role` each hold zero grants on `auction_contention_seeds`, via the `information_schema.role_table_grants` query already used at `:558-591`. This suite skips without a local Postgres and runs for real in CI (`.github/workflows/ci.yml:62`).
- `tests/core/hash.test.ts` -- **new.** Published SHA-256 vectors.
- `tests/server/auction-page.test.ts`, `tests/routes/auction-page.test.ts` -- the serialised Contender list and count, no derived flag on the wire, and the four route guards above still passing.
- `src/lib/components/RefusalPanel.svelte`, `CapBreakdown.svelte`, `+page.server.ts` -- **read-only.** The eighth chip reaches the panel by `PLACE_BID_GATES` growing, exactly as the seventh did. Any edit here is a finding.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/hash.ts`, `tests/core/hash.test.ts` -- pure SHA-256 against published vectors, before anything consumes it -- AC5
- [x] `supabase/migrations/20260828000000_contention_seeds.sql` -- the sealed seed table, granting no role anything -- AC5
- [x] `src/lib/core/projection/auctions.ts` -- `contentionForAmount`, `contenders`, `seedHash`, the two new sentences -- AC1, AC2, AC7
- [x] `src/lib/core/types.ts` -- `ContentionGateOutcome`, `'contention'` after `'opening'`, the key on `PlaceBidGateResults` -- AC1
- [x] `src/lib/core/rules/bidding.ts` -- the opening gate passing, `evaluateContention`, increment not applying, `teamMoneyStateFor` over Contenders, `decide()`'s fixed clock and `seedHash`, the sentence/figure/label -- AC1-AC6
- [x] `src/lib/server/bidding.ts` -- seed generation, `decide(..., seed)`, the seed-row projection registered on `seedHash` alone -- AC5
- [x] `src/lib/server/auction-page.ts`, `+page.svelte` -- Contender list, count and `seedHash` serialised; accent bar, icon, word, list and the clock statement rendered -- AC7
- [x] `tests/examples/` × 5 + `tests/structure.test.ts` -- §10 examples 6, 7, 10, 21, 22 as named tests, registered -- AC2, AC3, AC4
- [x] `tests/core/bidding.test.ts`, `tests/projection-auctions.test.ts` -- the gate table, the Contender derivation, the unmoved clock -- AC1-AC4
- [x] `tests/server/bidding.test.ts`, `tests/integration/auction-events.test.ts` -- the seed row's transaction and its total inaccessibility -- AC5
- [x] `tests/server/auction-page.test.ts`, `tests/routes/auction-page.test.ts` -- the wire shape and the four route guards -- AC7

**Acceptance Criteria:**
- Given any `PlaceBid`, when `evaluate()` runs, then `contention` is reported with its entry classification, the two thresholds and the Contender count and no money figure, the gate set is exactly the eight of `PLACE_BID_GATES` with `contention` third, immediately after `opening`, `evaluate()` never throws, and `decide()` reaches its outcome only by calling it.
- Given an Auction in Awaiting Opening Bid, when a Bid of exactly `$1,000,000` is placed, then it is accepted, the Auction folds to `minimum_bid`, the Auction Clock is 24 hours from that Bid, and the opening bidder is the first Contender.
- Given a live Minimum-Bid Contention, when any number of Teams each bid exactly `$1,000,000`, then each joins in ascending `seq` order, no Team appears twice, and the Auction Clock is not reset, extended or altered — proven both on each join's persisted payload and on the fold after all of them.
- Given a live Minimum-Bid Contention, when an amount other than exactly `$1,000,000` is submitted, then it is refused: strictly between the thresholds on `contention` and `granularity` together, at or above `$1,500,000` on `contention` alone and named as deferred, and in neither case is a conversion performed or a commitment released.
- Given a Minimum-Bid Contention opening, when it is created, then a seed is generated outside the core, stored in the same transaction as the event, and reachable by no Postgres role an automated test can authenticate as — `anon`, `authenticated` and `service_role` alike; only `hash(seed)` appears in `auction_events`, and `hash` is the one SHA-256 both runtimes and a Manager compute.
- Given a join, when capital is committed, then a non-eligible Player takes a flat `$1,000,000` into Committed Bids for every Contender rather than only the leader, and an eligible Player yields an Eligible Leading Bid of `$1,000,000` that commits nothing while a Free Minor League Slot can absorb the win.
- Given a Minimum-Bid Contention on the Auction page, when it renders, then it carries the 3px `lottery` left accent bar, an icon and a word, the live Contender list and count, and a statement in words that the clock will not reset on a join — for every viewer, bound to a Team or not — with every phrase worded in the core.
- Given the repository, when `npm test`, `npm run check` and `npm run check:purity` run, then all pass with no growth in the pre-existing `SUPABASE_DB_URL` integration failure, and `core/` still reads no clock and no randomness and imports nothing outside the core.

## Spec Change Log

- **2026-08-28 — frozen-block correction, human-authorised (not a review loopback).** AC1 said the gate set carried `contention` "second", contradicting the Boundaries' "immediately after `'opening'`" and the Design Notes' own refusal-panel mock-up, both of which put it third. The implementer followed the two agreeing signals and flagged the discrepancy rather than choosing silently. AC1 now reads "third, immediately after `opening`". No code or test changed. **KEEP:** `opening` must precede `contention` — it asks whether any Bid leads at all, which has to be settled before the kind of contention can be. The avoided bad state is a gate order set from a drafting slip rather than from the reading order the refusal panel is built on.

## Design Notes

**The fixed clock is enforced twice, and only one of them is a rule.** `auctionsReducer` keeps `closesAt` on a join because a join is never strictly higher than the leading Bid, so it never becomes `leadingBid` (`:331-338`). That is true and it is an accident of an unrelated invariant — if a later story ever makes joins visible in the lead, the clock silently starts moving. So `decide()` stamps the contention's existing `closesAt` onto the join's own payload, which makes the persisted log honest on its own terms: every `BidPlaced` in a contention states the same close instant, and 3.5's sweep — which reads persisted instants and nothing else (AD-12) — cannot be handed a join claiming to close 24 hours after itself.

**A conversion is refused by name, and that is the same trade 2.5 made.** `evaluateOpening` refused exactly `$1,000,000` rather than promoting it or half-accepting it, because the machinery to run a lottery did not exist. `$1,500,000` into a live contention is now that case exactly: accepting it as an ordinary raise would produce most of dissolution for free — the fold would go `standard`, the clock would reset, and every Contender's commitment would quietly release, because `teamMoneyStateFor` stops seeing them — while leaving the seed sealed forever. AD-14's "no unopened commitment is left behind" is precisely what that silently breaks.

**The seed table denies `service_role` too, which no other table does.** Every existing table revokes `anon` and `authenticated` and then grants `service_role` what it needs (`auction_events.sql:103-104`, `open_nominations.sql:89-90`). This one grants nothing to anybody: with RLS forced and no policy, the sole reachable identity is the direct `SUPABASE_DB_URL` connection, which is the only path a browser can never travel. AD-14 says the seed must be unreadable by every manager-facing role including the Commissioner's, and since the Commissioner is a boolean on a table (`managers.is_commissioner`) rather than a role, denying every role is the only assertion that means what the AD says.

```
Auction Clock · Passed     23h 12m left
Opening       · Passed     a Bid already leads, so no opening minimum applies
Contention    · Refused    your Team is already a Contender, 4 of them so far
Self-bid      · Passed     another Team leads
Increment     · Passed     no raise applies in a Minimum-Bid Contention
Granularity   · Passed     on the $500.0K grid
Cap           · Passed     Maximum Bid $14.0M, offered $1.0M
Slots         · Passed     Roster Count would be 10 of 12
```

## Verification

**Commands:**
- `npm test` -- all pass. Baseline on `78da0ec` is **1617 passed / 1 failed**, the failure being the pre-existing `SUPABASE_DB_URL is not set` integration case (`deferred-work.md`). It must not grow.
- `npm run check` -- 0 errors, 0 warnings.
- `npm run check:purity` -- clean.

**Manual checks (if no CLI):**
- `rg -n "randomBytes|Math.random|node:crypto" src/lib/core/` returns nothing — the seed is generated in the shell and arrives as an argument (AD-1).
- `rg -n "seed" src/lib/core/rules/bidding.ts` shows `seed` reaching the payload only through `hash()`, never stored raw.
- `rg -n "service_role|anon|authenticated" supabase/migrations/*contention_seeds.sql` shows three revokes and **zero** grants.
- `git diff --stat` changes no executable line in `src/lib/components/` or `+page.server.ts`, and adds exactly one migration. Anything more is a finding: say which and why.
- `rg -n "class=\"[^\"]*\{" src/routes/auction/` returns nothing — the accent bar is applied by Svelte's `class:` directive, not a conditional class string.
- `rg -c "<button" "src/routes/auction/[fantraxPlayerId]/+page.svelte"` is still `1`.

## Review Findings

Code review 2026-08-28 (`bmad-code-review`, four layers: blind-hunter, edge-case-hunter, verification-gap, acceptance-auditor on `bmad-reviewer-acceptance` — Tier B in `BMAD-EFFORT-TRIAGE.md` and the diff touches `src/lib/core/`). All three verification gates pass: `npm test` 1793 passed / 1 failed (the pre-existing `SUPABASE_DB_URL` case, not grown from baseline), `npm run check` 0 errors / 0 warnings, `npm run check:purity` clean. All seven of the spec's manual checks pass.

- [x] [Review][Decision] `SEED_COMMITMENT` forward-declares Story 3.6's reveal in Manager-facing copy — The page renders `<p id="auction-seed-commitment">{SEED_COMMITMENT}</p>`, whose text ends "so when the seed is revealed you can hash it yourself and check it against this value" (`src/lib/core/projection/auctions.ts:305-309`). AC7 enumerates what the lottery renders — accent bar, icon, word, Contender list, count, clock statement — and the Code Map asks the page for `seedHash` itself, not a sentence explaining it. The Never list says "no reveal (3.6)". No reveal code exists, so this is copy rather than behaviour, and a bare hash with no explanation is arguably worse for the trust surface AD-14 is built on. The call is whether Manager-facing copy may promise a capability that does not exist yet. **Resolved 2026-08-28 (Meakel): keep as-is.** The commitment needs explaining for AD-14's trust surface to mean anything, and 3.6 is committed work. No code change.

- [x] [Review][Patch] `tests/core/hash.test.ts` contains a raw NUL byte, making the file binary to git [tests/core/hash.test.ts:72]
- [x] [Review][Patch] The `increment` panel figure says "no current high to raise" inside a live contention where $1,000,000 leads [src/lib/core/rules/bidding.ts:2021-2024]
- [x] [Review][Patch] The `contention` panel figure asserts an offered amount is "between $1.0M and $1.5M" when it is below $1.0M [src/lib/core/rules/bidding.ts:2008-2012]
- [x] [Review][Patch] `teamMoneyStateFor`'s comment claims `contenders` is empty off a lottery; `contendersFor` never consults contention state [src/lib/core/rules/bidding.ts:532-537]
- [x] [Review][Patch] `seedHash: existing.seedHash ?? bid.seedHash` adopts a later Bid's commitment when the opener's is null, contradicting its own comment [src/lib/core/projection/auctions.ts:555]
- [x] [Review][Patch] The I/O matrix row "A lottery that has expired" has no test anywhere in the diff [tests/core/bidding.test.ts]

- [x] [Review][Defer] `auction_contention_seeds`' primary key collides if a Player's Auction is ever re-opened [supabase/migrations/20260828000000_contention_seeds.sql] — deferred, belongs to 3.3 / Epic 7
- [x] [Review][Defer] A lottery whose `seedHash` folds to `null` renders no commitment block and no absence notice [src/routes/auction/[fantraxPlayerId]/+page.svelte:669-671] — deferred, unreachable until a corrupt log exists; 3.6 owns the verification surface

**Review outcome (2026-08-28).** All 6 `patch` findings applied and the 1 `decision-needed` resolved (keep `SEED_COMMITMENT`). 2 findings deferred to `deferred-work.md`; 11 dismissed as noise. Gates after the patches: `npm test` 1798 passed / 1 failed — the pre-existing `SUPABASE_DB_URL` integration case, unchanged from the 1617/1 baseline — `npm run check` 0 errors / 0 warnings, `npm run check:purity` clean. Four tests were added alongside the fixes so every new branch and guard is asserted rather than merely applied.
