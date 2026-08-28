---
title: 'Story 3.1: Expiry is authoritative for validation'
type: 'feature'
created: '2026-08-28'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'df4b55843b8691f8b40636b36bd3a592bba85563'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** No gate asks what time it is. `evaluate()` takes `now` and immediately `void`s it (`rules/bidding.ts:1079`); `LeadingBid` (`:168`) was deliberately narrowed so no gate could reach a close instant; the read path passes `now: ''` (`server/auction-page.ts:564`) and the surface passes `''` twice (`+page.svelte:235`, `:301`). So an Auction whose 24-hour clock ran out yesterday still accepts Bids until Story 3.5's sweep — which does not exist — records the close, and a page left open never crosses its own close time, because `nowIso` (`+page.svelte:362`) is derived from nothing reactive and freezes at load. AD-12 — the rule that makes a stalled sweep produce *late* closes rather than *wrong* ones — is entirely unbuilt, and it is the validation floor Stories 3.4 and 3.5 stand on.

**Approach:** Add the seventh gate, `expiry`, comparing the injected `now` against the **persisted absolute close instant** the `BidPlaced` payload already carries and `auctionsReducer` already folds. ONE predicate in `projection/auctions.ts`, beside the fold that owns `closesAt`, answers "has this run out", and the gate, the transaction and the page all read that one predicate — never whether a projection still holds an Auction row. The read path stops inventing a clock and reads the database's; the surface stops passing the empty string and instead anchors on that server instant and measures elapsed time locally, so a client receiving nothing still crosses the close.

## Boundaries & Constraints

**Always:** `PLACE_BID_GATES` gains exactly one entry — `'expiry'`, **first** in the list — which is the single edit in `core/types.ts` that makes every consumer a compile error, exactly as 2.6 and 2.7 spent it. The gate refuses exactly when a persisted close instant exists and **`now >= closesAt`**: at the close instant itself the Auction is closed, because 3.5 supplies each close's own nominal expiry as `now` and a Bid at that instant must not beat it. **Authority is the persisted absolute instant and nothing else** — the gate never reads whether an Auction row exists in a projection, never reads a contention state, and never reads the nomination fold. `closesAt: string | null` reaches the gate on `BidState`, taken from `Auction.closesAt`; `null` — nominated, nobody has bid — **passes**, because there is no clock until an Opening Bid starts one (`EXPERIENCE.md`'s Awaiting Opening Bid card has no clock at all). An **unreadable `closesAt` reads as expired**, which is `readPayload`'s own stated direction; an **unreadable or empty `now` passes**, because a clock the shell failed to supply is a bug and `decide()` must still reach its `TypeError` at `closeInstantFor` rather than converting a shell bug into a Manager-facing refusal. The refusal is worded distinctly from a cap refusal and a capacity refusal: it names a clock and an elapsed time and quotes **no money figure and no count**. The read path reads the **database** clock once, and that ONE instant is both the gate's `now` and the `figuresAt` caption, so the caption and the gate can never describe two moments. The surface derives its `now` from the server instant it was handed plus locally measured elapsed time, ticking once a second — a skewed client clock can never move a close time (NFR §5), and disabling a control is never the check (AD-9). The Auction Clock panel states expiry for **every** viewer, bound to a Team or not. `evaluate()` stays total, `decide()` reaches its outcome only by calling it, `core/rules/bidding.ts` still reads no clock and no randomness, and every sentence, chip, label and figure is worded in the core.

**Ask First:** Any migration or new table. Adding a gate beyond the seventh, or changing the gate ORDER once chosen. Persisting, memoising or serialising a derived expired flag. Changing `AUCTION_CLOCK`. Changing any phrase `closesInPhrase` already returns. A new Svelte component, design token or colour. Making the client's own clock authoritative for anything. Promoting the tick interval to anything more than a named constant.

**Never:** **No Auction Close.** No `AuctionClosed` is appended, no winner is determined, no Slot Placement, no Cap Hit, no sweep, no cron and no Deno Edge Function (3.4, 3.5) — the close-side half of the epic AC ("closes late with the outcome an on-time sweep would have produced") is 3.5's, and this story owns only its other half: no Bid after nominal expiry is ever accepted, however long the gap. **No Minimum-Bid Contention**, fixed clock, join, dissolution or draw (3.2, 3.3, 3.6). No League Clock and no phase end (3.7). No pause, resume or remaining-duration arithmetic (AD-13, Epic 7); no void. **No Realtime, no freshness or Stale machinery, no persistent strip** (Epic 4) — the client tick is a local interval that touches no network. No rewrite of `no_open_auction`: whether a nomination exists stays the nomination fold's question, asked before `decide()` (`server/bidding.ts:233`). No red anywhere. No hand-edit of `planning-artifacts/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| A Bid after expiry, sweep not yet run | Auction still in the fold, `closesAt` 09:00, `now` 11:00 | Refused on `expiry` **alone**; the other six report their own arithmetic; no `BidPlaced` appended; the leading Bid untouched | `fail(409)` |
| At exactly the close instant | `now === closesAt` | **Refused.** 3.5 hands each Auction its own nominal expiry as `now`, so a Bid at that instant must not beat the close | N/A |
| One millisecond before | `now = closesAt − 1ms` | `expiry` passes; the remaining six decide the Bid on their own grounds | N/A |
| A sweep stalled for a month | `now = closesAt + 30 days` | Refused identically to one millisecond past — nothing was accepted in the interim, and no gate's answer drifts with the size of the gap | N/A |
| Nominated, nobody has bid | `closesAt` `null` | `expiry` **passes**; the `opening` gate decides. No clock exists to run out | N/A |
| The projection still shows the Auction open | No `AuctionClosed` folded, close time passed | Still refused. The gate compares instants and never reads the presence of an Auction row — this is AD-12's "never reads a projection's open flag as authority" | N/A |
| The close IS recorded | `AuctionClosed` folded, so nomination and Auction both released | Refused as `no_open_auction` **before** `decide()`, exactly as today; the gate set never runs. Unchanged by this story | N/A |
| A page left open crosses the close | Client receives no update at all | Countdown reaches `no time left`, the panel states the Auction expired, the control disables — from the absolute close time the client already holds (AD-29) | N/A |
| A client clock three hours fast | Same page, skewed device | Same close time and the same expiry instant a correct clock sees: `now` is anchored on the server's instant and only the elapsed delta is local | N/A |
| An unreadable close instant on the wire | `closesAt` is not an instant | Reads as **expired**; the control is disabled. The server is still the check | N/A |
| A caller still passing `''` | `now` empty or unparseable | The gate **passes**; `decide()` reaches `closeInstantFor` and throws its `TypeError` as it does today — a shell bug stays a bug | throws |
| Viewer bound to no Team, expired Auction | Registered session, no Team | The Auction Clock panel states expiry regardless; the control is refused as `unbound_actor`, which is the standing condition | `fail(400)` |
| Refused under the lock | Expiry re-derived inside the transaction, after the lock | The refusal carries that transaction's full gate set and its stamp; no `BidPlaced`; the earlier Bid untouched | `fail(409)` |

</frozen-after-approval>

## Code Map

The close instant already exists, persisted and folded — nothing new is stored and no migration is written. This is one predicate in the projection, one gate in the rules, one clock read on the server, and one ticking instant on the page.

- `src/lib/core/projection/auctions.ts` -- extend. Add `hasExpired(closesAt: string | null, now: string): boolean` beside `closesInPhrase` (`:388`) and `closeInstantFor` (`:425`), the two functions that already own close-time arithmetic: `null` → `false`; an unparseable `closesAt` → `true`; an unparseable `now` → `false`; otherwise `now >= closesAt` through `parseInstant`. Add `AUCTION_EXPIRED` — the one sentence the board states — for the gate sentence and the page to compose from, the way `bidPlacedNotice()` composes from `BID_CONSEQUENCE`. Correct `closesInPhrase`'s "no gate in `PLACE_BID_GATES` reads this function: Story 3.1 owns expiry-as-authority" paragraph (`:376-383`): the gate now exists, reads `hasExpired`, and `closesInPhrase` is still a rendering.
- `src/lib/core/types.ts` -- extend. New `ExpiryGateOutcome = GateOutcome & { closesAt: string | null; evaluatedAt: string }` — the persisted instant and the injected `now` it was compared against, and **no money field and no count**, for `SlotsGateOutcome`'s reason (`:439`). Add `'expiry'` **first** to `PLACE_BID_GATES` (`:466`) and the key to `PlaceBidGateResults` (`:486`). Correct the header's "3.1 adds `expiry`" note (`:459-464`) to the past tense and the ONE list it cost.
- `src/lib/core/rules/bidding.ts` -- extend, and this is most of the implementation.
  - `BidState` (`:209`) gains `closesAt: string | null`. It goes on `BidState` and **not** on `LeadingBid` (`:168`), whose header says outright that a gate seeing a Bid's close time is what it was narrowed to prevent — that narrowing was for a gate this story now owns, so rewrite `:161-166` rather than delete it. `bidStateFor` (`:317`) reads `auction.closesAt` and passes it through; its `null`-Auction branch passes `null`. No caller signature changes, which is why the transaction needs no plumbing at all.
  - `evaluateExpiry(state, now)` → `ExpiryGateOutcome`, calling `hasExpired` and deriving nothing itself. `evaluate` (`:1079`) drops `void now` (`:1080`), passes `now` to this one gate, and rewrites the "`now` is declared because … none of the six gates below asks what time it is" paragraph (`:1064-1078`) — now false, and the reason the parameter was kept.
  - `gateSentence` (`:1179`) gains the `expiry` case, composed from `AUCTION_EXPIRED` and `relativePhrase(closesAt, evaluatedAt)` — which returns `at an unknown time` for an unreadable instant, so the unparseable branch needs no second wording. `gateFigure` (`:1557`) gains `expiry`: `no Bids yet, so no Auction Clock` when `closesAt` is `null`, otherwise `closesInPhrase(closesAt, evaluatedAt)` — ONE branch for passed and refused alike, which is the `slots` figure's discipline (`:1611-1616`). `GATE_LABELS` (`:1686`) gains `expiry: 'Auction Clock'` — the glossary term, so the chip reads `Auction Clock · Refused` and cannot be mistaken for `Cap · Refused` or `Slots · Refused`. `bidRefusalDelta` (`:1774`) and `bidGateReport` (`:1735`) iterate `PLACE_BID_GATES` and need **no** edit.
  - Rewrite the module header's gate-set paragraph (`:36-41`), which says `expiry` "is not: this module still does not compare `now` to a close instant", and the closing "It reads no clock: `now` is an argument" paragraph (`:101-104`), which stays true and now has a consumer.
- `src/lib/server/auction-page.ts` -- extend. Read the database clock once — `select now() as now`, no lock, this module deliberately takes none — and use that ONE instant for both `figuresAt` (`:407`, today `new Date().toISOString()`) and `readBidControl`'s `now`. Rewrite `readBidControl`'s "`now` is passed as the empty string, and that is safe rather than sloppy … Story 3.1's `expiry` gate is the first that will need one, and it will have to source it here rather than invent one" paragraph (`:556-566`). `AuctionPageBidControl` (`:200`) needs no new field: `AuctionPageState.closesAt` (`:521`) already carries the instant and `figuresAt` (`:265`) already carries the server's. **Serialise no derived flag** — not `expired`, not a remaining duration; `tests/server/auction-page.test.ts:779` and `:828` are the guards.
- `src/lib/server/bidding.ts` -- **read-only, and prove it with a test rather than asserting it.** `decide(state.bid, command, now.toISOString(), null)` (`:256`) already hands the core the transaction-start clock, and `bidStateFor` already receives the `Auction`. Correct `:33-38`, which says `PLACE_BID_GATES` is fixed at six and none of them is a time question. If an executable line here needs to change, that is a finding worth stating plainly.
- `src/routes/auction/[fantraxPlayerId]/+page.svelte` -- the one surface edit. Replace `nowIso` (`:362`) with a server-anchored ticking instant: `control.figuresAt` plus `Date.now()` elapsed since first paint, recomputed on a one-second interval in an `$effect` with its `clearInterval` cleanup, client-only. `gateState` (`:211`) gains `closesAt: auction.closesAt`; `typed` (`:229`) and `liveGates` (`:283`) pass that instant instead of `''`, and their two "no gate in `PLACE_BID_GATES` reads `now`" comments (`:223-227`, `:296-300`) become the reason it is anchored on the server's. The Auction Clock panel (`:509-519`) states the Auction expired when `hasExpired` says so — the core's sentence, printed, so the panel is right for a viewer bound to no Team as well. **No rule, no wording, no figure.** `tests/routes/auction-page.test.ts:487` greps the raw text of both route files for the forbidden vocabulary and `:448` forbids `/running out/i` — word the new comments clear of both, and if that proves impossible, narrow the guard deliberately and say which phrase and why.
- `src/lib/components/RefusalPanel.svelte`, `CapBreakdown.svelte`, `+page.server.ts` -- **read-only.** The seventh chip reaches the panel by `PLACE_BID_GATES` growing, exactly as the sixth did. Any edit here is a finding.
- `tests/core/bidding.test.ts` -- the largest test edit. `:126`'s literal gate list gains `expiry` in its new position; `:146`/`:216` follow automatically. Add the boundary table: one millisecond before, exactly at, one millisecond after, thirty days after, `closesAt` `null`, unparseable `closesAt`, empty and unparseable `now`, and the both-refuse case (expired **and** over Maximum Bid) reporting both grounds in `PLACE_BID_GATES` order. Add the authority assertion: an Auction the fold still holds, past its close, refused — and the same state one millisecond earlier, accepted.
- `tests/projection-auctions.test.ts` -- `hasExpired`'s own table, and that `closesInPhrase` still returns every phrase it returned before.
- `tests/server/auction-page.test.ts` -- the fake gateway (`:136-203`) gains a `read-clock` label for `select now()`; an unrecognised statement still throws, so the new read is proven rather than assumed. Assert the gate's `evaluatedAt` and the `figuresAt` caption are the SAME instant, and that no derived expired flag crosses the wire (`:779`, `:828` unedited).
- `tests/server/bidding.test.ts` -- an expired Auction refused under the lock, carrying `gates` and `at`, with nothing appended and the earlier `BidPlaced` untouched; and that the transaction file needed no executable change.
- `tests/routes/auction-page.test.ts` -- the ticking instant is anchored on `figuresAt` and not on `new Date()`, the interval is cleared, and the page still words no gate (`:419`, `:466`, `:487` pass unedited except any deliberate narrowing named above).
- `tests/structure.test.ts` -- **no §10 example is owned here.** Epic 3's examples (6, 7, 8, 9, 10, 11, 13, 16, 17, 21, 22, 27) all belong to 3.2 – 3.7; expiry has none. Update the `SECTION_10_EXAMPLES` story note (`:30-37`) to say 3.1 added none, so the omission is recorded rather than looking like a miss.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/auctions.ts` -- `hasExpired`, `AUCTION_EXPIRED`, the corrected `closesInPhrase` header -- AC1, AC3
- [x] `src/lib/core/types.ts` -- `ExpiryGateOutcome`, `'expiry'` first in `PLACE_BID_GATES`, the key on `PlaceBidGateResults` -- AC1
- [x] `src/lib/core/rules/bidding.ts` -- `closesAt` on `BidState`, `bidStateFor` passing it through, `evaluateExpiry`, `evaluate` reading `now`, the sentence, the figure, the label, the rewritten headers -- AC1-AC4
- [x] `src/lib/server/auction-page.ts` -- one database clock read feeding both the gate and the caption; no derived flag serialised -- AC5
- [x] `src/routes/auction/[fantraxPlayerId]/+page.svelte` -- the server-anchored ticking instant, `closesAt` on `gateState`, both `''` call sites, the expired statement on the Auction Clock panel -- AC6
- [x] `tests/core/bidding.test.ts` -- the gate list, the boundary table, both-grounds order, and the authority assertion -- AC1-AC4
- [x] `tests/projection-auctions.test.ts` -- `hasExpired`'s table; `closesInPhrase` unchanged -- AC3
- [x] `tests/server/auction-page.test.ts`, `tests/server/bidding.test.ts` -- the clock read, one instant for gate and caption, the refusal under the lock, no executable change in `server/bidding.ts` -- AC5, AC7
- [x] `tests/routes/auction-page.test.ts` -- anchored and cleared ticking, and the page still words no gate -- AC6
- [x] `tests/structure.test.ts` -- record that 3.1 owns no §10 example -- AC8

**Acceptance Criteria:**
- Given any `PlaceBid`, when `evaluate()` runs, then `expiry` is reported with `closesAt` and `evaluatedAt` and no money field and no count, the gate set is exactly the seven of `PLACE_BID_GATES` with `expiry` first, `evaluate()` never throws, and `decide()` reaches its outcome only by calling it.
- Given an Auction whose persisted absolute close instant has passed, when a Bid is validated at any point after it — one millisecond or thirty days — then it is refused as expired and never accepted and later reversed, and the refusal names a clock and an elapsed time and quotes no money figure and no count.
- Given the open/closed question, when it is answered, then it is answered by comparing the injected `now` against the persisted absolute close instant through the one `hasExpired` derivation, and never by reading whether a projection still holds an Auction row, a contention state, or a nomination.
- Given an Auction with no Bids, when it is validated, then `expiry` passes because no clock has started; and given an unreadable close instant it reads as expired, while given an unreadable or empty `now` the gate passes and `decide()` still throws its `TypeError`.
- Given the Auction page load, when it reads, then it reads the database clock exactly once with no lock, and that one instant is both the `expiry` gate's `now` and the `figuresAt` caption; no derived expired flag or remaining duration is serialised.
- Given a client in any connection state that receives no update, when the Auction it is displaying passes its close time, then the page states the Auction expired and disables its bid control, derived from the absolute close instant it already holds and anchored on the server's instant rather than the device's clock.
- Given the transaction, when a Bid on an expired Auction is refused under the lock, then the close instant was folded after `pg_advisory_xact_lock`, the refusal carries that transaction's gate set and stamp, no `BidPlaced` is appended, and `src/lib/server/bidding.ts` needed no executable change.
- Given the repository, when `npm test`, `npm run check` and `npm run check:purity` run, then all pass with no growth in the pre-existing integration failure, and `core/rules/bidding.ts` still reads no clock and no randomness and imports nothing outside the core.

## Design Notes

**`expiry` goes first in `PLACE_BID_GATES`, and the order is the reading order.** The list is what `allGatesPassed`, `failedGates`, `bidRefusalDelta` and `bidGateReport` all iterate, so its order is the order a Manager reads the panel in. A clock that has run out is the frame every other question sits inside — offering, raising and affording are all moot once it has — so `Auction Clock · Refused` belongs above `Cap · Refused`, not below `Slots`. Nothing asserts the six in a fixed order except `:126`'s literal list, which is the one place the decision is recorded.

**The two unreadable-instant cases go opposite ways on purpose.** An unreadable `closesAt` reads as **expired**, which is exactly the trade `readPayload` already makes one module over — "an Auction whose close cannot be read reads as already due rather than as running forever". An unreadable `now` reads as **not expired**, because `now` is the shell's to supply and AD-1 makes a shell bug a throw rather than a returned refusal: passing keeps `decide()`'s existing `TypeError` at `closeInstantFor` reachable, where refusing would swallow it into a Manager-facing "this Auction expired" that is not true.

**The client's clock measures elapsed time; it never sets the origin.** NFR §5 requires that a skewed client neither see a different close time nor bid after expiry, and AD-29 exempts countdowns from freezing because they derive from an absolute close time the client already holds. Both hold if `now` is `figuresAt + (Date.now() − anchor)`: the origin is the database's instant, only the delta is local, and a device three hours fast crosses the close at the same real moment a correct one does. Deriving `now` from `new Date()` — which is what `nowIso` does today — would hand a skewed device a different answer; deriving it from nothing, which is what `$derived(new Date())` actually does, freezes the page at load and is why an open tab never expires today.

**Nothing is stored, and nothing new is read under the lock.** The close instant rides the `BidPlaced` payload and is folded by `auctionsReducer`; `bidStateFor` already receives the `Auction` that holds it. So the transaction gets expiry-as-authority without a migration, without a projection table, without a second query and — if this is built as specified — without one executable line changing in `server/bidding.ts`. That is the test worth writing, not the claim worth asserting.

```
Auction Clock · Refused    no time left
Opening       · Passed     a Bid already leads, so no opening minimum applies
Self-bid      · Passed     another Team leads
Increment     · Passed     least $9.0M over a $8.5M high, offered $9.0M
Granularity   · Passed     on the $500.0K grid
Cap           · Passed     Maximum Bid $14.0M, offered $9.0M
Slots         · Passed     Roster Count would be 10 of 12
```

## Verification

**Commands:**
- `npm test` -- all pass. Baseline on `df4b558` is **1617 passed / 1 failed**, the failure being the pre-existing `SUPABASE_DB_URL is not set` integration case (`deferred-work.md`). It must not grow.
- `npm run check` -- 0 errors, 0 warnings.
- `npm run check:purity` -- clean.

**Manual checks (if no CLI):**
- `git diff --stat` touches no file under `supabase/migrations/`, changes no executable line in `src/lib/components/`, `src/routes/auction/[fantraxPlayerId]/+page.server.ts` or `src/lib/server/bidding.ts`, and the only surface change is `+page.svelte`. Anything more is a finding: say which and why.
- `rg -n "hasExpired|closesAt" src/lib/core/rules/bidding.ts` shows the comparison reached only through `hasExpired`, never a second `parseInstant` comparison written inline in a gate.
- `rg -n "auctionForPlayer|nomination" src/lib/core/rules/bidding.ts` returns nothing inside `evaluateExpiry` — the gate reads an instant, not a projection row.
- `rg -n "new Date\(\)" src/routes/auction src/lib/server/auction-page.ts` shows the page's `Date.now()` used only as an elapsed-time delta and the server's clock coming from `select now()`, not from Node.
- `rg -n "expired|remainingMs|closesIn" src/lib/server src/routes/auction/\[fantraxPlayerId\]/+page.server.ts` returns no serialised derived flag and no remaining duration on the wire.
- `rg -n "setInterval" src/routes/auction/` shows exactly one, inside an `$effect`, with its `clearInterval` cleanup returned.

## Suggested Review Order

**The one derivation everything else reads**

- Start here: five lines, and the two unreadable cases go opposite ways on purpose.
  [`auctions.ts:463`](../../src/lib/core/projection/auctions.ts#L463)

- The gate, which calls that predicate and derives nothing of its own.
  [`bidding.ts:1146`](../../src/lib/core/rules/bidding.ts#L1146)

- `now` stopped being `void`ed — one gate reads it, the other six still do not.
  [`bidding.ts:1171`](../../src/lib/core/rules/bidding.ts#L1171)

- Two instants, no money field and no count — `SlotsGateOutcome`'s discipline.
  [`types.ts:474`](../../src/lib/core/types.ts#L474)

- `expiry` first: the list's order is the order a Manager reads the panel in.
  [`types.ts:505`](../../src/lib/core/types.ts#L505)

- On `BidState`, not on `LeadingBid` — the narrowing this story was told to undo.
  [`bidding.ts:253`](../../src/lib/core/rules/bidding.ts#L253)

**The wording, and the chip that must not contradict its own figure**

- The sentence: a clock and an elapsed time, no money figure and no count.
  [`bidding.ts:1276`](../../src/lib/core/rules/bidding.ts#L1276)

- The figure, branched on READABILITY in review — `Refused` may never read as time left.
  [`bidding.ts:1695`](../../src/lib/core/rules/bidding.ts#L1695)

**One clock read, two consumers**

- The database's instant, not Node's — the gate's `now` and the caption, inseparable.
  [`auction-page.ts:430`](../../src/lib/server/auction-page.ts#L430)

- The shared validator, extracted in review; only the check, never the query.
  [`write.ts:156`](../../src/lib/shell/write.ts#L156)

**The client measures elapsed time; it never sets the origin**

- Server anchor plus a local delta — a skewed device cannot move a close time.
  [`+page.svelte:256`](../../src/routes/auction/[fantraxPlayerId]/+page.svelte#L256)

- The tick, re-anchoring on a fresh server instant rather than adding to an old count.
  [`+page.svelte:274`](../../src/routes/auction/[fantraxPlayerId]/+page.svelte#L274)

- Stated for every viewer, on the panel rather than on the control.
  [`+page.svelte:460`](../../src/routes/auction/[fantraxPlayerId]/+page.svelte#L460)

- The field disables too, added in review: the submit alone left it typable.
  [`+page.svelte:684`](../../src/routes/auction/[fantraxPlayerId]/+page.svelte#L684)

**Supporting**

- Authority proved as behaviour: the same folded state, accepted then refused.
  [`bidding.test.ts:1923`](../../tests/core/bidding.test.ts#L1923)

- `hasExpired`'s own table — exactly at, either side, and both unreadable cases.
  [`projection-auctions.test.ts:350`](../../tests/projection-auctions.test.ts#L350)

- Refused under the lock, with that transaction's gate set and stamp.
  [`bidding.test.ts:810`](../../tests/server/bidding.test.ts#L810)

- The no-plumbing claim, strengthened in review to test the claim not two strings.
  [`bidding.test.ts:939`](../../tests/server/bidding.test.ts#L939)

- The throw path made reachable, including an Invalid Date.
  [`auction-page.test.ts:999`](../../tests/server/auction-page.test.ts#L999)

- The tick asserted against source text — the suite cannot render a component.
  [`auction-page.test.ts:409`](../../tests/routes/auction-page.test.ts#L409)
