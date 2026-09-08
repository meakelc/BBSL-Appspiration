# Epic 10 Context: Chase two players with one slot

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

A Manager with one open roster slot may hold one *more* outstanding Bid than they have room for — the **Outstanding Bid Allowance** — and may enter as many minimum-bid lotteries as their cap space allows. Without this, every Manager is serialised behind their own wins and the auction cannot finish in time. The allowance is only safe because the surplus is taken back automatically: when a Close fills a Team's last Slot, its leftover commitments are cancelled most-recent-first and each affected Auction is restored to its next-highest surviving Bid. The two halves ship as one unit — an allowance without the cascade lets a Team win a thirteenth player, which is exactly the invariant the roster ceiling exists to protect. No subset of this epic is safe to deploy alone, and the widening stories must not reach production without the cancellation and restoration behind them.

## Stories

- Story 10.1: The Outstanding Bid Allowance in the slots gate
- Story 10.2: Lottery entries leave the slots gate
- Story 10.3: Cancel the surplus commitment at Close
- Story 10.4: Restore the next-highest bidder
- Story 10.5: A lottery whose contenders were cancelled
- Story 10.6: Say it on the board and in Discord

## Requirements & Constraints

**The slots gate.** A Bid passes Roster Capacity when projected Active/Bench additions are zero, **or** when the Team holds at least one free Active/Bench Slot *and* projected additions are at most free slots plus one. The free-slot precondition is checked before the allowance arithmetic — a Team with no free Active/Bench Slot gets no allowance at all. The ceiling of twelve is unchanged; the allowance is never a thirteenth Slot. The pre-existing carve-out for a Minor-League-eligible Player whose win a free Minor League Slot absorbs is untouched. The `+ 1` is a named constant, never an inline literal. Every gate evaluation — pass and refusal alike — reports roster count, projected additions, free slots, the allowance, and the ceiling of twelve; a refusal quoting only the allowance would imply thirteen players are legal. Roster Reserve's `max(0, …)` clamp is now reachable in ordinary play rather than being an override-only safeguard.

**Lottery entries are exempt.** A minimum-bid Contention entry contributes nothing to projected Active/Bench additions and consumes no allowance; a Team may contend in any number of open Contentions. An entry is gated only on having somewhere for a win to land: a free Active/Bench Slot, or an eligible Player with a free Minor League Slot. Cap space is the only quantitative limit — a tenth entry against nine million dollars of available space is refused **on money, not capacity**. The flat per-entry commitment and the eligible-entry exposure rules are unchanged.

**Two overflow figures, not one.** The money-side overflow count includes Contention entries and feeds Minors Exposure; the slots-side overflow excludes them and is the only one reaching projected Active/Bench additions. They are one subtraction apart. A single shared computation serving both gates is a defect — and it is one an earlier story deliberately introduced and documented as load-bearing, so the old comment asserting the two "cannot disagree about the count" must be replaced by one stating why they now must.

**The cancellation trigger** is any Close that **reduces the winning Team's free Slots — Active/Bench or Minor League**. Nothing else triggers it: not a Bid, not a Nomination, not the clock, and never a restoration (that bound is what terminates the cascade). A Minor-League win at zero cap hit that leaves roster count unchanged still fires it; a trigger phrased as "a Close that increases Roster Count" would miss that case.

**The cascade** cancels commitments one at a time, most recent first by log sequence, re-testing roster capacity and contention capacity after each, and stops the moment the Team is within both — nothing further is cancelled. An eligible leading Bid a free Minor League Slot can still absorb is left alone however recent. A Team still within capacity after the Close has nothing cancelled at all. Each cancellation releases that Team's committed capital and notifies it with **the win that caused it named**.

**Restoration** hands the Auction to the next-highest surviving Bid and re-commits that Team's capital at that amount, notifying them. A candidate failing re-validation is skipped and the next below is tried, down the history; a candidate is never restored and then cancelled. If nothing survives, the Auction returns to Awaiting Opening Bid with its Auction Clock **cleared**, the Player still on the board and the nominator's Nomination Slot still held; it must not close at the old expiry with no winner.

**Lottery draws** record the Contender list *after* cancellations. A cancelled Contender cannot be drawn, but the history still shows it entered and was cancelled. An empty Contender list closes with no winner, the Player returning to the free-agent pool and the nominator's Slot released, with the empty list and the reason recorded as a drawn one would be. The recorded seed and list must still reproduce the selection by hand, each survivor at `1/n` over the post-cancellation list.

**Test obligations.** Worked examples 29–35 land as new named tests (allowance pass, precondition, cascade with clean restoration, restoration skipped on re-validation, restoration with nothing surviving, unlimited lotteries ended by one win, the Minor-League trigger). Examples 24 and 25 are rewritten, 23 gains a capacity clause, and 18–25 are re-verified **as a block** — the eligible/overflow examples now depend on which overflow figure they mean, which is silent-drift territory. The suite must be green before any production deploy.

## Technical Decisions

- The slots gate takes the bid *state*, not the amount, so it stays structurally incapable of reading a Bid's size. Capacity and money remain two independent refusal grounds; neither short-circuits the other, and both outcomes are returned on every evaluation.
- Derived quantities (cap space, exposure, overflow, projected additions, capacity) are never stored or memoised, and are evaluated against the hypothetical state *as if the prospective bid were accepted*.
- `BidCancelled` is a compensating event: the original `BidPlaced` is never deleted or mutated and stays a visible history line. The event carries its own decision — the cancelled sequence, the cause, and either the restored Team, Bid sequence and amount, or null. The projection **reads** that recorded decision; re-deriving it would mean re-running the gate suite inside a fold.
- `close.ts` is the sole appender: the close event first, then each cancellation in cascade order, all committed in the transaction the next Close is evaluated against. `restore.ts` decides and appends nothing. No schema migration is needed — the event-type column is generic text.
- Restoration declares its own fixed gate set as a distinct command type running **only** the cap and slots gates. Implementing it as a synthetic bid placement would re-run the increment rule against a price that has just fallen and refuse every restoration that mattered.
- Restoration is evaluated against **post-close** state: after the triggering Close's placement and after every cancellation already decided in this cascade. Handing it the pre-close snapshot restores a Team the Close just disqualified.
- The selection algorithm is **one** pure function in `core/rules/restore.ts` — walk the surviving history downward, re-evaluate, skip failures, stop at the first pass — parameterised on the three axes that separate a cancellation from a Commissioner void: retain-vs-erase in the fold, leave-vs-restore the Auction Clock, keep-vs-remove the League Clock reset. The void story consumes this function rather than writing its own.
- Clock semantics are the sharpest trap: a cancellation resets **nothing** and removes **nothing**. The Auction Clock is untouched where a Bid survives (a restored bidder may inherit very little time) and cleared only where none does. The League Clock keeps its reset. A reducer treating cancellation and void alike would end the Auction Phase early every time a roster fills.
- Sequential closing is now load-bearing rather than merely correct: closes run one at a time in expiry order, each committing its cancellations and restorations before the next is evaluated. A Team winning the first of several simultaneously-expiring lotteries is removed from the rest before they draw; a batched fold would let it win two.
- Churn concentrates in `core/rules/bidding.ts`, `core/rules/close.ts`, `core/rules/restore.ts` and `core/projection/auctions.ts`, plus the shared constants module.

## UX & Interaction Patterns

- **Three distinct refusal-panel strings that must never collapse into one:** passed (naming the permitted-bid count and the projected roster figure), refused at the allowance (outstanding bids against what the free slots permit), and refused on the precondition (no free Active/Bench slot, so no bid is permitted). The first resolves itself at the next close; the second lasts the whole auction; the remedies differ.
- The gate row **wraps to a second line rather than truncating**, at line-height 1.6, aligned to the sentence's first line, never centred on the chip.
- The bid control names the allowance trade **once, before the confirm step**, in words and without alarm — that winning elsewhere first cancels this bid and the next-highest leads. Not a dialog, not a checkbox, not repeated on later views.
- A Team at its allowance has its board controls disabled stating *"at your allowance"*, visibly distinct from a Team with no room at all. Both are stated on the board, not discovered at submission.
- The persistent strip carries bids against the allowance beside the roster figure. At parity the figure alone is the signal — no colour, badge or warning treatment, since the strip is inherited by every screen.
- The Teams index row gains a bids-against-allowance column with open lottery entries counted **separately**; folding them together would imply a ceiling that does not exist.
- **One event, three notices.** The cancelled Manager's notice leads with the cause then the effect, with no apology, no alarm styling and no congratulation wrapped around it. The restored Manager's notice re-establishes context, then states what it costs their cap and how long they have — the clock did not reset, so it may be minutes. The league channel gets one line in the existing register.
- Both mentions ride the existing **outbid** category as two new clauses — no fourth category, and the mutable set is unchanged, so these stay unmutable server-side with the existing refusal wording. The category name now covers three things ("your position in an Auction changed without you"); that is deliberate, because a Manager must not be able to mute the notice telling them they lost a Player through no act of their own.
- The cancelled Bid stays visible in the Auction history, struck through, labelled *cancelled*, with the causing win named — never deleted, hidden or reordered. Copy must distinguish it from a void: a void says someone decided the Bid should not have stood; a cancellation says nothing of the kind.
- An Auction with nothing surviving renders as an ordinary **unbid nomination**, the treatment the board already has, not a new "restarted" state.

## Cross-Story Dependencies

- **Internal:** 10.1 and 10.2 widen what may be held; 10.3 and 10.4 take the surplus back. Ship as one unit — 10.1 must not reach production without 10.3 and 10.4 behind it. 10.3's cascade consumes 10.4's restorer; 10.5 depends on cancellations landing before a draw; 10.6 surfaces the figures 10.1 and 10.2 produce.
- **Upstream:** builds on the bidding and capacity work of Epic 2 and the contention, close and clock work of Epic 3, and amends both. Requires nothing after it.
- **Downstream:** the Commissioner bid-void story consumes the restorer this epic builds instead of implementing its own — that story gets cheaper, not enabled, and there is no dependency in either direction.
- **Sequencing:** must land **before** the moderator pilot and the production setup day. Rule changes are fail-stopped during a live Auction Phase, and the pilot exists to measure the very property this rule targets — auction speed. Piloting the old rules would pilot rules the league will not play under.
