---
title: 'Story 10.6 — Say it on the board'
type: 'feature'
created: '2026-09-09'
status: 'done'
review_loop_iteration: 0
baseline_commit: '4c6c27529332319682ec5c0b7b5937ece767d09c'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Stories 10.1–10.5 shipped the Outstanding Bid Allowance and the cancellation cascade into the rules core, and no surface says so. The bid control offers no word that a Bid is the one at risk (`auction/[fantraxPlayerId]/+page.svelte:839-844` records that the prior consequence sentence was deliberately removed). The strip and the Teams index carry a roster figure that now answers their own question wrongly in both directions. And a cancelled Bid arrives at the Auction page indistinguishable from a live one: `AuctionPageBid` (`server/auction-page.ts:168-177`) drops `bid.cancellation` at the wire, so the history renders a Bid that no longer stands as though it did.

**Approach:** One named core figure — outstanding non-entry Bids against the allowance, with open lottery entries counted **separately** — derived from `TeamMoneyState` and read by both the strip and `teamViewFor`. One sentence on the bid control, before confirm, when the prospective Bid is the allowance Bid. And the cancellation facts carried through the auction-page wire so the history row can be struck through and labelled. No gate verdict, fold or schema changes.

**Scope note:** The Discord half of this story — the two `outbid` clauses and the league-channel line (UX-DR37) — was split out at the scope gate on 2026-09-09 and is logged in `deferred-work.md`. Until it lands, both mentions degrade to the existing plain fallback line, which is correct if terse.

## Boundaries & Constraints

**Always:**
- **One derivation, reused.** The allowance is `unfilledSlots(rosterCount, 0) + OUTSTANDING_BID_ALLOWANCE`; the numerator is the **slots-side** count with entries excluded, built from the expressions `activeBenchOverflowFor`/`projectedAdditionsFor` already use (`bidding.ts:1217-1233,1391-1408`). No second subtraction is spelled out, and the money-side `overflowCount` is never substituted for it.
- **Lottery entries are counted separately, always.** Folding them into the bids figure would imply a ceiling that does not exist (UX-DR36).
- **Every word and figure is worded in the pure core**, per `strip.ts:28-31` ("No `.svelte` file words a figure or a label"). Components render strings; they do not build them.
- At parity the figure alone is the signal — **no colour, no badge, no warning treatment**, wherever the figure appears (UX-DR35).
- The allowance sentence is stated **once, before the confirm step**, as plain prose. Not a dialog, not a checkbox, not repeated on later views (UX-DR34).
- The cancelled Bid is **never** deleted, hidden or reordered. `auction-page.ts:652-654` already lists every Bid; this story only stops discarding the fact that one was cancelled.
- Copy distinguishes a cancellation from a void: a void says someone decided the Bid should not have stood; a cancellation says nothing of the kind (UX-DR38).
- All figures derived in the browser from transported **facts**, never a pre-computed number on the wire (AD-7).

**Ask First:**
- Changing any of the four `gateFigure` slots forms Story 10.1 wrote (`bidding.ts:2787-2864`), or the fifth Story 10.2 added at `:2826-2831`.
- Adding an Available Cap Space figure to Your Positions — resolved 2026-09-09 as **no**; reopening it is a human call.

**Never:**
- Do not bump `CORE_VERSION` — 10.1 already took it 1 → 2, and the branch is deliberately ahead of the live log.
- Do not add a "restarted" board state. A leaderless Auction renders as the unbid nomination the board already has (`board.ts:492-507`), unchanged.
- Do not change a gate verdict, a projection, or the cascade. `evaluate()`, `decide()`, `decideClose`, `selectRestoration` and `withBidCancelled` are read-only here.
- Do not touch `src/lib/adapters/discord/**` — that is the deferred half, and two stories editing one renderer is what the split exists to prevent.
- Do not deploy, and do not exercise a real Discord send: `DISCORD_WEBHOOK_URL` is the live pilot channel.
- No migration, and no new event type.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Allowance bid, pre-confirm | `slots.freeActiveBenchSlots >= 1` and `slots.projectedAdditions === slots.allowance` | The trade sentence renders once above the confirm step, naming the ordinal and the permitted count | N/A |
| Under the allowance | `projectedAdditions < allowance` | No sentence — this Bid is not the one at risk | N/A |
| Precondition failed | `freeActiveBenchSlots === 0` | No sentence. No Bid is permitted at all, so there is no trade to name | N/A |
| Lottery entry | `slots.isContentionEntry` is `true` | No sentence. An entry spends no allowance | N/A |
| Strip at parity | Roster 9 of 12, 2 non-entry Bids outstanding, 3 free slots | `Roster 9 of 12 · 2 of 4 bids`, plain — no colour, badge or warning | N/A |
| Strip, viewer bound to no Team | `team === null` | The bids segment is absent entirely — never `0 of 0` | N/A |
| Teams index row, entries held | 1 non-entry Bid, allowance 3, 4 open lottery entries | Bids figure `1 of 3`; the 4 entries stated in their own figure, never summed into it | N/A |
| Eligible bid absorbed by a Minor League Slot | An eligible leading Bid with a free Minor League Slot | Contributes nothing to the bids figure — the overflow clamp is what removes it, not a second filter | N/A |
| Cancelled Bid in history | `bid.cancellation !== null` | The row renders struck through and labelled *cancelled*, naming `causePlayerName` as the win that caused it; `seq` ordering unchanged | N/A |
| Cancellation with no successor | `cancellation.restoration === null` | Same row treatment; the Auction itself renders as an unbid nomination with its history intact | N/A |
| Bid never cancelled | `bid.cancellation` absent or `null` | Renders exactly as today — no label, no strikethrough, no layout shift | N/A |

</frozen-after-approval>

## Code Map

- `src/lib/core/rules/bidding.ts:1217-1233` `activeBenchOverflowFor`, `:1391-1408` `projectedAdditionsFor`, `:1092-1094` `unfilledSlots`, `:1162-1171` `minorsCountsFor` — **the expressions the new figure must reuse.** The numerator is `leading.filter(!isContentionEntry).length + max(0, eligibleLeading.filter(!isContentionEntry).length − freeMinorLeagueSlots)` — `projectedAdditionsFor` without its prospective `+ 1`. The comment at `:1186-1196` states why the money-side and slots-side counts must disagree; the display figure is the **slots** side.
- `src/lib/core/rules/bidding.ts:630-706` `teamMoneyStateFor`, with `LeadingBidElsewhere.isContentionEntry` set at `:693` — the classification is already recorded per bid, so the entries count is a filter, never a re-derivation from an amount.
- `src/lib/core/constants.ts:121` `OUTSTANDING_BID_ALLOWANCE`, `:98` `ACTIVE_BENCH_SLOTS` — the named `+1` and the ceiling. Never inline either.
- `src/lib/core/types.ts:625-692` `SlotsGateOutcome` — `projectedAdditions:627`, `freeActiveBenchSlots:644`, `allowance:656` (raw `F+1`, unclamped), `isContentionEntry:691`. These are what the bid control's "is this the allowance bid" test reads; nothing flags it today.
- `src/lib/core/strip.ts:120-123` `rosterCountSentence` — the precedent and the neighbour for the new sentences. Consumed at `PersistentStrip.svelte:149,194`; the `·` separator is markup at `PersistentStrip.svelte:192` (`.strip-separator`, CSS `:369-372`). Strip data is the `TeamMoneyState` **prop** (`PersistentStrip.svelte:55,62`) — it already carries `rosterCount`, `minorLeagueOccupied`, `leading` and `eligibleLeading`, so nothing new is transported.
- `src/lib/core/team-view.ts:555-642` `teamViewFor` (takes `team: TeamMoneyState` at `:559`); `TeamView` from `:207` with `rosterCount:254`, `freeActiveBenchSlots:260`, `rosterCountSentence:261`. `src/lib/core/teams-index.ts:439-462` `rowFor`; `MEDIAN_SEPARATOR = ' · '` at `:129`. Row markup `routes/teams/+page.svelte:161-215`; the `.figure`/`.figure-qualifier` register at `:180-184`, CSS `:388-403`.
- `src/routes/auction/[fantraxPlayerId]/+page.svelte:794-863` the bid form — amount `:828-838`, the removed-sentence comment `:839-844` (which must be rewritten, not deleted), confirm `:845-854`, submit `:855-862`. `liveGates` derived at `:447-467`. History loop `:904-917`; client `AuctionBid` type `:83-88`.
- `src/lib/server/auction-page.ts:168-177` `AuctionPageBid` and `:662-667` the mapping that drops `cancellation` — **the one wire change.** `:652-654` confirms every Bid is already listed.
- `src/lib/core/projection/auctions.ts:204-229` `BidCancellation` (`seq`, `causeFantraxPlayerId`, `causePlayerName`, `restoration`), `:246-269` `Restoration` (`seq`, `teamId`, `teamName`, `managerId`, `amount`), `:309` `Bid.cancellation`, `:313-315` `wasCancelled`. **Read-only.** `:194` already says "Story 10.6 words it". There is **no** cause *Team* name here — the causing win is named by its **Player**.
- `src/lib/components/RefusalPanel.svelte:119-128` gate rows, `:211-217` `.gate-row` (`align-items: flex-start`, `flex-wrap: wrap`), `:242-247` `.gate-figure` (`line-height: 1.6`, `flex: 1 1 12rem`). **Read-only evidence: UX-DR33 is already satisfied** — no `text-overflow` or `white-space` rule exists in the file. This story pins it; it does not change it.
- `src/lib/core/board.ts:492-507` — the leaderless Auction deliberately shares the unbid-nomination treatment, with `contention` the only field distinguishing anything. **Read-only; pin, do not change.**
- `src/routes/positions/+page.svelte:309-648` the five groups (`won`, `outbid`, `youLead`, `contending`, `nominationSlot`). **Read-only** — no Available Cap Space figure here, by decision.
- Tests: `tests/routes/auction-page.test.ts:59-64` and `tests/routes/board.test.ts:48-53` set the convention — `.svelte` files are read as **text** under a node environment and asserted with `toContain` after a local `stripComments()`, so prose about a thing is not that thing; route server logic is imported and run for real with `vi.mock`.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/rules/bidding.ts` -- export one figure function over `TeamMoneyState` returning the outstanding non-entry Bid count, the allowance, and the open contention-entry count as three separately named fields, built from the existing overflow and `unfilledSlots` expressions -- one derivation feeding two surfaces is what stops the strip and the Teams index from ever disagreeing, and the entry count stays separate because entries consume no allowance.
- [x] `src/lib/core/strip.ts` -- word the bids sentence beside `rosterCountSentence`, and word the allowance-trade sentence the bid control states -- every figure and label in this product is worded in the core, and a second wording is a second thing to keep in step.
- [x] `src/lib/components/PersistentStrip.svelte` -- render the bids segment after the roster segment behind the existing `·` separator, absent entirely when no Team is bound -- plain type only, because the strip is inherited by every screen and a nag here is a nag everywhere.
- [x] `src/lib/core/team-view.ts`, `src/lib/core/teams-index.ts` -- carry the same three figures onto `TeamView` and the index row -- `teamViewFor` is the one computation both Team surfaces share, and re-deriving in the index is the second computation Epic 4 forbids.
- [x] `src/routes/teams/+page.svelte` -- render the bids figure and the lottery-entries figure as two figures in the established `.figure`/`.figure-qualifier` register -- one combined figure would imply a ceiling that does not exist.
- [x] `src/routes/auction/[fantraxPlayerId]/+page.svelte` -- state the allowance trade once above the confirm step from a derived test over `liveGates.slots`, rewriting the `:839-844` comment that records the old sentence's removal -- this is where the product's obligation to the Manager is discharged, and it is prose, not a dialog or a checkbox.
- [x] `src/lib/server/auction-page.ts` -- widen `AuctionPageBid` with the cancellation facts (the causing Player's name, and whether anyone was restored) and stop dropping them in the mapping -- the history already lists every Bid; today it simply cannot tell them apart.
- [x] `src/routes/auction/[fantraxPlayerId]/+page.svelte` -- render a cancelled history row struck through and labelled, naming the win that caused it, in unchanged `seq` order -- never deleted, hidden or reordered, and worded so it cannot be read as a void.
- [x] `tests/core/bidding.test.ts`, `tests/strip.test.ts`, `tests/team-view.test.ts`, `tests/teams-index.test.ts` -- cover the figure at parity, with entries held, with an eligible Bid a Minor League Slot absorbs, and with no Team bound -- the figure is the story's one new piece of arithmetic and the entry separation is the invariant most easily lost.
- [x] `tests/routes/auction-page.test.ts`, `tests/routes/teams-index.test.ts` -- cover the sentence's presence and its three absences, the two Teams-index figures staying separate, and the cancelled history row against a live one -- the absences are the half a thin pass ships broken.
- [x] `tests/routes/board.test.ts` and the nearest existing home for the panel -- pin that a leaderless Auction still renders as an unbid nomination and that `.gate-figure` still carries `line-height: 1.6` with no truncation rule -- two properties this story inherits and must not break.

**Acceptance Criteria:**
- Given a Team holding two non-entry Bids with three free Active/Bench Slots, when the strip and the Teams index render, then both state `2 of 4` from the same derivation, and any open lottery entries appear only in their own figure.
- Given a Team whose only outstanding commitments are lottery entries, when either surface renders, then the bids figure reads `0 of n` and the entries figure states the entries — proving the two are never summed.
- Given `grep -rn "OUTSTANDING_BID_ALLOWANCE\|ACTIVE_BENCH_SLOTS" src/lib/components src/routes`, when it runs, then there is no match — no surface re-derives the allowance or the ceiling.
- Given an Auction whose history holds one cancelled Bid and one live Bid, when the page renders, then both appear in `seq` order, the cancelled one is struck through, labelled and names the causing Player, and the live one is unchanged from today.
- Given `git diff` over `src/lib/core/rules/close.ts`, `restore.ts`, `projection/auctions.ts`, `board.ts`, `src/lib/adapters/discord/` and `supabase/migrations`, when it runs, then it is empty — this story changes no rule, no fold, no notice and no schema.
- Given `npx vitest run`, when the suite runs, then every test passes except the pre-existing `tests/integration/auction-events.test.ts` FK failure. (Planned against the 3474 baseline; the story added 43 tests, so the figure to expect is 3517.)
- Given `npm run check`, when it runs, then it is clean.

## Spec Change Log

- 2026-09-09 — Review patches (no intent change; no loopback). Four layers ran
  over the diff from `4c6c275`. No `bad_spec` finding; the one `intent_gap`
  candidate was resolved by the human at patch scope rather than by
  re-derivation, so `review_loop_iteration` stays 0.
  - **The unspecified absences, resolved.** The frozen I/O matrix named exactly
    one absence for the new figures (no Team bound), leaving the zero case and
    the non-Auction phases undecided. As built, the strip was phase-gated and
    the Teams index was not, so an Archived index read `0 of 3 bids · 0 lottery
    entries` on every row. Resolved 2026-09-09: **both** surfaces render the
    figures only in the Auction Phase, and a Team holding no lottery entries
    gets no entries figure at all rather than a stated zero. The bids figure
    still reads `0 of n`; only the entries line disappears. Recorded here
    rather than in the matrix, which is frozen.
  - **A live history row was shifting.** `<span class="history-amount">` was
    reflowed across lines, and Svelte renders the surrounding indentation as
    whitespace text nodes — so under `justify-content: space-between` every
    *uncancelled* amount left the shared trailing edge that makes a column of
    tabular figures scannable. The matrix row demanding "no layout shift" for
    an uncancelled Bid was therefore already violated. Made whitespace-tight
    and pinned by a test.
  - **The server mapping shipped untested.** Nothing in
    `tests/server/auction-page.test.ts` ever produced a non-null
    `cancellation`, so inverting `restored` or returning
    `causeFantraxPlayerId` in place of `causePlayerName` would have passed a
    green suite and shipped the wrong sentence onto a real cancelled Bid.
    Covered through an executed `loadAuctionPage` in both directions.
  - Five smaller fixes: `aria-describedby` wiring for the allowance paragraph
    (the id existed and nothing referenced it), a comment saying why the strip
    carries bids but not entries, a duplicate import, an import-order slip, and
    the two tones on the cancellation row.
  - **The strip's phase gate was itself a review fix**, made before these
    layers ran: `strip.ts`'s own docblock states that Contract Assignment and
    Archived carry "the Roster Count alone", and `stripShowsMaximumBid`
    justifies that with "outside it no Bid is accepted at any amount". An
    ungated bids figure falsified both.
  - **KEEP.** The one derivation must survive any re-derivation: the numerator
    is `projectedAdditionsFor` less its prospective `+ 1`, reusing
    `activeBenchOverflowFor`'s clamp rather than spelling a second
    subtraction; entries stay a third named field on every surface; and the
    history loop stays unfiltered and unsorted, with the row treatment
    conditioned on `bid.cancellation !== null` and nothing else.
  - **Rejected, deliberately.** `allowanceTradeSentence` asserting that the
    next-highest Bid leads is UX-DR34's approved copy verbatim, not an
    unguarded claim. The null-guard findings against `outstandingBidFiguresFor`
    resolve on its non-null overload, with `npm run check` clean. `BidCancellation`
    is 10.3/10.4's and its absence from this diff is correct. The `_MARKUP`
    rename in `tests/strip.test.ts` is a coherent consistency pass, not churn.

## Design Notes

**Why the figure is a new function and not `projectedAdditions`.** `projectedAdditions` is the count *including a prospective Bid* — it answers "if I bid now, what would this be". The strip and the index answer a different question: what the Team holds right now. That is the same expression without its `+ 1`, which is why it is derived from the same parts rather than by calling the gate with a probe and subtracting one — a subtraction the reader would have to justify every time they met it.

**The causing win is named by its Player, not its Team.** `BidCancellation` carries `causeFantraxPlayerId` and `causePlayerName` and no cause team name (`auctions.ts:204-229`). On the Auction page the cancelled row already names its own bidder, so naming the Player is sufficient and the wire widens by two facts rather than by a lookup.

**UX-DR33 is inherited, not built.** `.gate-row` already wraps and `.gate-figure` is already `line-height: 1.6` with no truncation rule. The task is a regression test, and saying so is the point — a story that "implements" an already-correct property tends to reimplement it.

## Verification

**Commands:**
- `npx vitest run` -- expected: 3517 passed, the 1 pre-existing failure, no new ones.
- `npm run check` -- expected: clean.
- `git diff --stat -- supabase/migrations src/lib/adapters/discord src/lib/core/rules/close.ts src/lib/core/rules/restore.ts src/lib/core/board.ts src/lib/core/projection/auctions.ts` -- expected: empty.
- `grep -rn "CORE_VERSION" src/lib/core/` -- expected: still `2`.

**Manual checks (if no CLI):**
- The strip at parity: figure only, no colour, badge or warning treatment on any surface that inherits it.
- No real Discord send is exercised at any point — `DISCORD_WEBHOOK_URL` is the live pilot channel.

## Suggested Review Order

**The one derivation — start here, everything else reads it**

- The whole story's arithmetic: outstanding non-entry Bids, the allowance, entries — three named fields.
  [`bidding.ts:1460`](../../src/lib/core/rules/bidding.ts#L1460)

- `projectedAdditionsFor` without its prospective `+ 1`, reusing the clamp rather than a second subtraction.
  [`bidding.ts:1391`](../../src/lib/core/rules/bidding.ts#L1391)

- One call, two sentences: nobody words the result twice.
  [`strip.ts:225`](../../src/lib/core/strip.ts#L225)

**Where a figure is allowed to be silent**

- Auction Phase only, its own predicate, read by every surface — so none can disagree.
  [`strip.ts:132`](../../src/lib/core/strip.ts#L132)

- A Team holding no entries gets no entries line: entries have no ceiling, so a zero states nothing.
  [`strip.ts:204`](../../src/lib/core/strip.ts#L204)

- The counts stay facts; only the sentences are gated.
  [`team-view.ts:635`](../../src/lib/core/team-view.ts#L635)

**The decision the Manager actually makes**

- Stated once, and its three absences are as load-bearing as the presence.
  [`strip.ts:264`](../../src/lib/core/strip.ts#L264)

- Prose above the confirm step — not a dialog, not a checkbox.
  [`+page.svelte:849`](../../src/routes/auction/[fantraxPlayerId]/+page.svelte#L849)

- Described to the field only while it exists, so the reference cannot dangle.
  [`+page.svelte:878`](../../src/routes/auction/[fantraxPlayerId]/+page.svelte#L878)

**A cancelled Bid, told from a live one**

- The wire stops discarding the fact: two facts, not a sentence.
  [`auction-page.ts:699`](../../src/lib/server/auction-page.ts#L699)

- Conditioned on the fact and nothing else; the loop stays unfiltered and unsorted.
  [`+page.svelte:970`](../../src/routes/auction/[fantraxPlayerId]/+page.svelte#L970)

- Whitespace-tight, because `space-between` turns an indent into a shifted column.
  [`+page.svelte:987`](../../src/routes/auction/[fantraxPlayerId]/+page.svelte#L987)

- Struck through, never removed — and worded so it cannot read as a void.
  [`bidding.ts:3389`](../../src/lib/core/rules/bidding.ts#L3389)

**The two surfaces that inherit the figure**

- The strip takes bids and not entries, deliberately — one comment says why.
  [`PersistentStrip.svelte:168`](../../src/lib/components/PersistentStrip.svelte#L168)

- Two figures on the index row, never summed, each absent on its own terms.
  [`teams/+page.svelte:199`](../../src/routes/teams/+page.svelte#L199)

**Tests**

- The mapping that would otherwise ship a wrong sentence with a green suite.
  [`server/auction-page.test.ts:1751`](../../tests/server/auction-page.test.ts#L1751)

- The figure at parity, entries-only, absorbed-by-minors, over-ceiling and unbound.
  [`core/bidding.test.ts:3405`](../../tests/core/bidding.test.ts#L3405)

- The trade sentence and its three silences, driven through a real `evaluate()`.
  [`routes/auction-page.test.ts:1704`](../../tests/routes/auction-page.test.ts#L1704)

- The leaderless Auction is the unbid nomination — no restarted state anywhere.
  [`board.test.ts:1`](../../tests/board.test.ts#L1)
