---
title: 'Story 3.6: Draw a Minimum-Bid Contention winner'
type: 'feature'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'dc0aac4d778854301354892c60554e5e7798c511'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing draws. `ClosedWinner` (`core/rules/close.ts:89`) was declared by Story 3.4 and is produced by nothing; `closedWinnerFor` (`:185`) throws on a live `minimum_bid` naming this story as what is missing; `server/close.ts:113` passes `null`; and `server/sweep.ts:244` **skips** every expired lottery by name. So a Minimum-Bid Contention reaching its fixed 24-hour Clock never resolves: the Contenders' capital stays committed forever, the Player is never awarded, and the seed sealed in `auction_contention_seeds` — the commitment a Manager recorded at the opening — is never opened. AD-14's whole premise is that a Commissioner who is also a rival is acceptable *because* the draw can be checked; today there is no draw to check.

**Approach:** **The winner is derived, not chosen, and the derivation is arithmetic a Manager can do in a spreadsheet.** A new pure `core/rules/draw.ts` reduces the revealed 64-hex-digit seed modulo the Contender count — digit by digit, every intermediate under 500 — to a 0-based position in the list pinned to ascending join `seq`. The shell reads the sealed seed under the same lock that appends, so `loadCloseState` hands `decideClose` a `ClosedWinner` exactly as Story 3.4 shaped it to; `decideClose` verifies `hash(seed)` against the published commitment and then appends **`ContentionDrawn` before `AuctionClosed`** — cause then consequence, `ContentionDissolved`'s own idiom — carrying the seed, the ordered list and the selection. A new `projection/draws.ts` folds that event and never drops it, so the three facts outlive the Auction they came from. `sweep.ts` stops skipping. A `/verify` route states the procedure in prose, so the seed is something a losing Manager can act on rather than a hex string they are asked to trust.

## Boundaries & Constraints

**Always:** **The derivation reads the SEED and never `hash(seed)`.** The commitment is published the moment a lottery opens, so a winner derived from it would let a watcher compute whether joining makes them win — the exact exploit AD-14's prevents-line names. **Contender order is ascending join `seq`, from the fold's own `contenders` list and nothing else** — it is an input to the winner, not a rendering preference. **The seed reaches the core as an ARGUMENT**; `core/` reads no random source and generates nothing, as `check-core-purity.js` enforces. **`hash(seed)` is verified against the folded `seedHash` before any reveal is built**, and a mismatch THROWS with nothing appended — Story 3.3's posture on the identical question. A `seedHash` that folded to `null` is unverifiable, not fatal: the draw proceeds and says so, because refusing would strand the Auction forever. **`ContentionDrawn` is appended FIRST and `AuctionClosed` second**, in one transaction. **A one-Contender lottery resolves to that Contender** and is recorded with a one-team list. **The winning amount is the flat `MINIMUM_BID`** through `closedWinnerFor`'s existing branch, and Slot Placement, Cap Hit and the Nomination Slot release are Story 3.4's unchanged. **Every module `server/close.ts` imports must be Deno-loadable** — `supabase/functions/tick/index.ts:45` loads it — so relative `.ts` imports only and no `node:` builtin anywhere in the chain. **`closedWinnerFor` validates the winner it is handed** (deferred-work, owner: this story). **Losing Contenders' capital releases as a consequence of the close**, asserted rather than written: the Auction leaves `auctions.byPlayer`, so `teamMoneyStateFor` stops counting every Contender.

**Ask First:** Any migration. Bumping `CORE_VERSION` or `EVENT_SCHEMA_VERSION`. Adding an entry to `destinations.ts`'s catalog. Any change to `decideClose`'s signature, to `runTransactionalWrite`'s pipeline, or to `AuctionClosedPayload`. Any new design token or CSS sizing literal. Any new npm or Deno dependency.

**Never:** **No closed-Auction page.** The Auction route still 404s on a closed Auction; EXPERIENCE.md:156's Closed state — winner, amount, placement, and the lottery's seed and list — is Epic 4's, and this story's obligation is to make the three facts durable and readable, not to render them. Log it to `deferred-work.md` rather than building it. **No Audit Log surface** (7.5). **No `AuctionClosed` payload change** — the reveal is its own event, which is why Story 3.4 declined to put a seed on the close. **No notification and no outbox** (Epic 5), and the drain stays the no-op seam it is. **No League Clock evaluation, no phase end, no terminated unbid Nominations** (3.7). **No pause check** (Epic 7). **No second reveal path** — a dissolution still reveals through `ContentionDissolved`, untouched. **No rejection sampling and no `Math.random` anywhere.** **No re-seeding, no re-draw, and nothing that could make a second fold of one log choose a different winner.** No hand-edit of `planning-artifacts/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| §10 ex 8 — the draw | Contenders `[E, F, G, H]` by join `seq`, seed sealed, Clock expired | Winner = list position `seed mod 4`. `ContentionDrawn` then `AuctionClosed` at exactly `$1,000,000`; the other three release; Team D's Nomination Slot frees | N/A |
| §10 ex 11 — one Contender | Only E ever bid `$1,000,000` | E wins outright. `contenders` recorded as a ONE-team list, not omitted; `seed mod 1 = 0` needs no special case | N/A |
| Derivation is the seed's | Two lotteries share a Contender list but not a seed | Different positions may be selected. Nothing in the derivation reads `seedHash` | N/A |
| Reveal verifies | `hash(seed) === auction.seedHash` | The reveal is built and appended, carrying both values so one row answers the check | N/A |
| Commitment mismatch | Sealed seed hashes to something else | **Throws.** No event appended, transaction rolled back, sweep records the failure and continues | throws |
| No commitment published | `seedHash` folded to `null` (corrupt or hand-written log) | The draw runs and the reveal states `seedHash: null` — unverifiable, stated for the record, never implying a check | N/A |
| No sealed seed row | The seeds table holds nothing for this Player | **Throws.** A draw with no seed is the one outcome AD-14 cannot survive; the Auction stays open and visibly unclosed | throws |
| Malformed seed | Sealed value is not 64 lowercase hex digits | **Throws**, naming what was required. Unreachable from any log this app writes | throws |
| Empty Contender list | `minimum_bid` with `contenders: []` | **Throws.** There is nobody to draw and no winner to invent | throws |
| Winner missing a field | A `ClosedWinner` with an empty `teamId`, `teamName` or `managerId` | **Throws** at the rule that can name it, not later at the FK | throws |
| Sweep meets a lottery | An expired `minimum_bid` in the overdue set | It is CLOSED, not skipped. `skipped` on the heartbeat stays empty | per-Auction catch |
| Sweep meets a broken one | One lottery throws; three ordinary Auctions are also overdue | All three still close. The failure is named on the heartbeat and retried next pass | caught, recorded |
| Replay convergence | The same log folded twice, or `ContentionDrawn` folded twice | Identical winner both times; the fold keeps the FIRST draw seen | N/A |
| Malformed reveal payload | `ContentionDrawn` missing a Player, a seed or a winner | The draws fold **skips** it — `readPayload`'s idiom. Nothing throws | N/A |
| Live lottery, no commitment | The Auction page renders a running contention whose `seedHash` is `null` | It says so, in the words `SEED_COMMITMENT_UNVERIFIABLE` already carries for the dissolution — never a silently absent block | N/A |
| Verification page | A Manager opens `/verify` | The procedure in prose with a worked example. Registered sessions only; no league data on it | 403 |

</frozen-after-approval>

## Code Map

Two new core files, one new server file, one new route, no migration.

- `src/lib/core/rules/draw.ts` — **NEW, and the story's centre.** `drawIndex(seed, contenderCount): number` — the digit-by-digit reduction, the one expression a Manager reproduces — and `drawnWinnerFor(auction, seed): ClosedWinner`, which verifies the commitment, validates the list and builds the winner. Type-imports `ClosedWinner` from `rules/close.ts`; `close.ts` does **not** import this file, so there is no cycle. Uses `hash` (`core/hash.ts:127`), which is already pure and already the one commitment function.
- `src/lib/core/rules/close.ts:89` — `ClosedWinner`, declared by 3.4 with `seed` and `contenders` carried "for 3.6's reveal" and deliberately unread. This story reads them. `:185` `closedWinnerFor` — the lottery branch at `:200` already returns the flat `CONTENTION_AMOUNT`; add the non-empty validation the deferred-work entry assigns here. `:133` `CloseState` gains `drawnWinner: ClosedWinner | null`. `:361` `decideClose` keeps its signature and now emits TWO envelopes; add `ContentionDrawnPayload` beside `AuctionClosedPayload` (`:313`).
- `src/lib/core/projection/draws.ts` — **NEW.** `CONTENTION_DRAWN_EVENT` declared beside the reducer that gives it meaning, exactly as `CONTENTION_DISSOLVED_EVENT` is at `projection/auctions.ts:90`. `Draw`, `Draws { byPlayer }`, `INITIAL_DRAWS`, `drawsReducer`, `drawForPlayer`, and a defensive `readDrawnFacts`. Mirror `projection/contracts.ts` — `hasOwn`, skip a malformed payload, first-draw-wins for replay convergence. **Nothing removes an entry**: this is the permanence the AC asks for.
- `src/lib/core/projection/auctions.ts:137` — `Contender` gains `managerId`, filled at `contendersFor` (`:519`) from the joining Bid the loop already holds. `ClosedWinner` needs the Manager whose join put the Team in; a lookup back through `bids` by `seq` would be a second, failable derivation.
- `src/lib/core/rules/bidding.ts:2711` — `ContentionDissolvedPayload`, the exact template: revealed seed, the commitment restated so one row answers the check, the unfiltered ordered id list. `:2773` `seedFor` is the throw idiom — a message naming what was required and what arrived. **Read-only.**
- `src/lib/server/contention-seed.ts` — **NEW, and load-bearing for the runtime boundary.** `CONTENTION_SEEDS_TABLE` and `readContentionSeed` move here verbatim from `server/bidding.ts:298,325`. They cannot simply be exported from `bidding.ts`: that module imports `node:crypto` (`:84`), and `supabase/functions/tick/index.ts:45` makes Deno load `server/close.ts`, so a close that imported `bidding.ts` would break AD-2 at the runtime boundary. `server/bidding.ts` imports the new module.
- `src/lib/server/close.ts:103` — `loadCloseState` reads the sealed seed on the transaction's own client when the folded Auction is `minimum_bid`, derives `drawnWinner` through `drawnWinnerFor`, and hands it to `closedWinnerFor` (`:113`, currently `null`) so the roster read is keyed on the Team that actually won. `:205` passes `state.drawnWinner` to `decideClose`. The `runTransactionalWrite` shape, the `releaseNomination` registration and the two-clock discipline are unchanged.
- `src/lib/server/sweep.ts:244` — delete the skip and its comment. `:108` `skipped` and the heartbeat's `skipped` column **stay**, always empty, documented — dropping a column off an append-only heartbeat table for cosmetics is not worth a migration. `:47` the header paragraph asserting the skip is now false and must be rewritten.
- `src/routes/verify/+page.svelte`, `+page.server.ts` — **NEW.** Static prose: the procedure, a worked example, the spreadsheet formula, and how to check `hash(seed)` with `sha256sum`. `src/routes/signin/+page.svelte` (87 lines) is the shape; tokens come from `src/lib/styles/tokens.css`. Gated to registered sessions reusing `destinations.ts:124,127`'s constants — **no new catalog entry**, and it is linked from the Auction page's lottery block instead.
- `src/routes/auction/[fantraxPlayerId]/+page.svelte:691` — the live-contention commitment block, guarded with no `{:else}`. Add the unverifiable statement using the existing `SEED_COMMITMENT_UNVERIFIABLE` (`auctions.ts:408`), which line `:728` already prints for the dissolution, and the `/verify` link. Closes the Story 3.2 deferred entry.
- `tests/structure.test.ts:57` — the Story 3.5 note says outright that "8 and 11 are Story 3.6's". `:66` `SECTION_10_EXAMPLES` is where they register.
- `tests/examples/example-09-the-lottery-dissolves.test.ts` — the idiom for a lottery example: PRD text verbatim, state literals, direct core calls. `tests/examples/example-17-minors-overflow.test.ts` shows one example importing another's produced state.
- `tests/server/close.test.ts:43` — `fakeGateway`, the stateful recording `ConnectionGateway`; it must learn the seeds-table select. `tests/server/sweep.test.ts:67` — the lottery-skip row inverts to a lottery-close row.
- `supabase/migrations/`, `src/lib/shell/write.ts`, `src/lib/core/constants.ts`, `src/lib/core/hash.ts`, `src/lib/server/destinations.ts` — **read-only.** Any edit here is a finding: say which and why.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/rules/draw.ts` — `drawIndex` and `drawnWinnerFor`, with the commitment verification and the three throws — AC1, AC2
- [x] `src/lib/core/projection/draws.ts` — `CONTENTION_DRAWN_EVENT`, the permanent fold, the defensive reader — AC3
- [x] `src/lib/core/rules/close.ts` — `ContentionDrawnPayload`; `decideClose` emits the reveal before the close; `CloseState.drawnWinner`; `closedWinnerFor` validates its winner — AC2, AC3
- [x] `src/lib/core/projection/auctions.ts` — `Contender.managerId`, filled in `contendersFor` — AC1
- [x] `src/lib/server/contention-seed.ts` + `src/lib/server/bidding.ts` — move the seeds-table reader to a Deno-safe module; `bidding.ts` imports it — AC5
- [x] `src/lib/server/close.ts` — read the sealed seed under the lock, derive the winner, pass it through — AC2, AC4
- [x] `src/lib/server/sweep.ts` — delete the lottery skip; correct the header; keep `skipped` empty and say why — AC4
- [x] `src/routes/verify/+page.svelte`, `+page.server.ts` — the procedure in prose, session-gated, no new destination — AC6
- [x] `src/routes/auction/[fantraxPlayerId]/+page.svelte` — the unverifiable-commitment sentence on a LIVE contention, and the `/verify` link — AC6
- [x] `tests/examples/example-08-lottery-draws.test.ts`, `example-11-single-contender-lottery.test.ts` + `tests/structure.test.ts` — §10 examples 8 and 11, registered, the story note extended — AC1
- [x] `tests/core/draw.test.ts` — the derivation: uniformity across every position, the worked example the `/verify` page prints, the throws, and that no output varies with `seedHash` — AC1, AC2
- [x] `tests/projection-draws.test.ts` — the fold: recorded, first-draw-wins, malformed skipped, never removed by a later close — AC3
- [x] `tests/core/close.test.ts`, `tests/server/close.test.ts`, `tests/server/sweep.test.ts` — every I/O Matrix row: two events in order, the flat amount, the winner validation, the seed read under the lock, a lottery closing in the sweep, and a broken one not stalling the pass — AC2, AC4
- [x] `tests/server/bidding.test.ts`, `tests/routes/auction-page.test.ts` — the end-to-end unverifiable-commitment assertion the Story 3.3 deferred entry asks for, and the live block's new sentence — AC6
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` — close the three entries this story owns; append the closed-Auction surface as Epic 4's — AC6

**Acceptance Criteria:**
- Given a Contender list of `n` and a seed, when the winner is derived, then every position `0..n-1` is reachable, the result is a function of the seed and the list alone, and folding the same log twice selects the same Team.
- Given the draw is recorded, when the log is read, then `ContentionDrawn` precedes `AuctionClosed` for that Player, carries the revealed seed, the commitment it answers, the ordered Contender ids as they stood at expiry and the selection, and the close awards exactly `$1,000,000`.
- Given a closed lottery, when its Auction has left `auctions.byPlayer`, then the draws fold still answers with all three facts, and every losing Contender's committed capital has released.
- Given an expired Minimum-Bid Contention and three ordinary overdue Auctions, when the tick runs, then all four close, the heartbeat reports four closed and none skipped, and a lottery that throws leaves the other three closed.
- Given `npm run check`, `npm test` and `npm run check:purity`, when they run, then all pass, and `npx deno check --config supabase/functions/tick/deno.json supabase/functions/tick/index.ts` still resolves the whole chain.
- Given a Manager holding a revealed seed and the recorded list, when they follow `/verify` with a spreadsheet, then they reach the same Team the log names.

## Spec Change Log

## Design Notes

**The derivation, and why this one.** Read the seed's 64 hex digits left to right as one 256-bit number and take its remainder modulo the Contender count. Every intermediate stays under `16 × n + 15`, so with `n ≤ 30` nothing exceeds 500 — pencil, paper or one spreadsheet column all work.

```
r = 0
for each hex digit d of the seed, left to right:
    r = (r * 16 + value(d)) mod n
winner = contenders[r]          # 0-based, ascending join seq
```

Spreadsheet: `B2 = MOD(B1*16 + HEX2DEC(MID($seed, ROW()-1, 1)), $n)`, filled down 64 rows.

Two alternatives were rejected. `HEX2DEC(LEFT(seed,8)) mod n` is one cell but carries `(2^32 mod n)/2^32 ≈ 7e-9` of modulo bias, so "probability exactly `1/n`" would be false as stated. Rejection sampling over 8-digit windows is exactly uniform but adds a step to the hand procedure and a branch firing with probability `~7e-9` — untestable except through a crafted seed. Full-width reduction has bias below `n / 2^256`, which is far under the chance of a SHA-256 collision, and no branch at all.

**Why the derivation must not read `hash(seed)`.** The commitment is published the instant a lottery opens. If the winning position were `hash(seed) mod n`, any watcher could compute, before joining, whether becoming Contender `n+1` would make them the winner — AD-14's stated prevention, reached without ever reading the seed. The seed is the only input, and it stays sealed until this event reveals it.

**Why a second event rather than fields on `AuctionClosed`.** Story 3.4 declined to put a seed on the close because that would publish half a commit-reveal it did not own. `ContentionDissolved` already carries the other exit from this same state with the same four facts; a `ContentionDrawn` beside it means the two exits from a Minimum-Bid Contention are read the same way, and `AuctionClosed`'s three existing folds need no change at all.

**No second `ClosedWinner` case was needed.** 3.4 shaped it as a union of one anticipating that a single-Contender lottery might want its own kind. It does not: `seed mod 1 = 0`, the one-team list is recorded as the AC requires, and a second case would be a branch stating something the arithmetic already states.

## Verification

**Commands:**
- `npm test` — expected: green, including the two new §10 examples and the draw, fold and sweep suites.
- `npm run check` — expected: no type errors.
- `npm run check:purity` — expected: green; `core/` gained `rules/draw.ts` and `projection/draws.ts`, neither reading a clock nor a random source.
- `npx deno check --config supabase/functions/tick/deno.json supabase/functions/tick/index.ts` — expected: resolves. **Not optional**: `server/close.ts` gained an import, and the whole point of the new `contention-seed.ts` module is that this check would fail if the reader had been exported from `bidding.ts` instead. `--config` is load-bearing.
- `npm run check:pins` — expected: green, unchanged.
- `git diff --stat -- supabase/migrations src/lib/shell src/lib/core/constants.ts src/lib/core/hash.ts src/lib/server/destinations.ts` — expected: empty.

**Manual checks (if no CLI):**
- Take a recorded seed and Contender list from a passing example test, run the `/verify` page's procedure by hand in a spreadsheet, and confirm it names the Team the test asserts. If the printed procedure and the code disagree, the page is the defect — it is the half a Manager can actually run.

## Suggested Review Order

**The derivation — the one thing a Manager reproduces**

- The reduction entire: full-width, digit by digit, no branch and no rejection step.
  [`draw.ts:133`](../../src/lib/core/rules/draw.ts#L133)

- Why the seed and never `hash(seed)` — the exploit AD-14 names, in the header.
  [`draw.ts:1`](../../src/lib/core/rules/draw.ts#L1)

- Verifies the commitment, then selects. The index is computed once and carried.
  [`draw.ts:193`](../../src/lib/core/rules/draw.ts#L193)

- One definition of what a seed looks like, shared rather than restated.
  [`draw.ts:110`](../../src/lib/core/rules/draw.ts#L110)

**The reveal — two events, cause then consequence**

- `ContentionDrawn` before `AuctionClosed`, both from the one `decideClose`.
  [`close.ts:480`](../../src/lib/core/rules/close.ts#L480)

- The published position is the drawer's own output, cross-checked, never a lookup.
  [`close.ts:602`](../../src/lib/core/rules/close.ts#L602)

- Shape before hash: with a null commitment nothing else would examine the seed.
  [`close.ts:579`](../../src/lib/core/rules/close.ts#L579)

- `ClosedWinner` carries the index because it cannot be re-derived honestly.
  [`close.ts:118`](../../src/lib/core/rules/close.ts#L118)

- The winner it is handed is validated at the rule that can name the field.
  [`close.ts:220`](../../src/lib/core/rules/close.ts#L220)

**Permanence — the Auction goes, the draw stays**

- No removal case, and that is the whole design.
  [`draws.ts:232`](../../src/lib/core/projection/draws.ts#L232)

- The one cross-FIELD check: a winner absent from its own list is skipped.
  [`draws.ts:183`](../../src/lib/core/projection/draws.ts#L183)

- A manager id never falls back to a team id — `null` is the honest record.
  [`draws.ts:151`](../../src/lib/core/projection/draws.ts#L151)

- The event type, declared beside the reducer that gives it meaning.
  [`draws.ts:60`](../../src/lib/core/projection/draws.ts#L60)

**The runtime — one sweep, two runtimes, no Node builtin in the graph**

- The seed read under the same lock that appends, before the winner's roster.
  [`server/close.ts:132`](../../src/lib/server/close.ts#L132)

- The seeds reader in its own module: `bidding.ts`'s `node:crypto` may not reach Deno.
  [`contention-seed.ts:59`](../../src/lib/server/contention-seed.ts#L59)

- The lottery branch is gone: a contention is swept like any other Auction.
  [`sweep.ts:261`](../../src/lib/server/sweep.ts#L261)

- `skipped` kept and permanently empty — dropping a column needs a migration.
  [`sweep.ts:258`](../../src/lib/server/sweep.ts#L258)

**The surfaces — what a Manager can actually act on**

- The procedure in prose, with the worked example the suite pins to the code.
  [`verify/+page.svelte:86`](../../src/routes/verify/+page.svelte#L86)

- A live lottery with no commitment now says so instead of rendering nothing.
  [`auction/+page.svelte:703`](../../src/routes/auction/[fantraxPlayerId]/+page.svelte#L703)

- `Contender.managerId`, so the drawer needs no failable lookup back through bids.
  [`auctions.ts:150`](../../src/lib/core/projection/auctions.ts#L150)

**Supporting — the claims the tests actually pin**

- The printed example driven through the real `drawIndex`; the two cannot drift.
  [`draw.test.ts:104`](../../tests/core/draw.test.ts#L104)

- A duplicated Contender list proves the index is the arithmetic's, not `indexOf`'s.
  [`close.test.ts:524`](../../tests/core/close.test.ts#L524)

- AC4 at its own arity: a lottery plus three ordinary Auctions, four closed.
  [`sweep.test.ts:384`](../../tests/server/sweep.test.ts#L384)

- A winner absent from its own Contender list is skipped, not folded.
  [`projection-draws.test.ts:248`](../../tests/projection-draws.test.ts#L248)
