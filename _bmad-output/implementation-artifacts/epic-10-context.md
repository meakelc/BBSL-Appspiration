# Epic 10 Context: Chase two players with one slot

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

A Manager may hold one *more* outstanding Bid than they have room for — the **Outstanding Bid Allowance** — and may enter as many minimum-bid lotteries as their cap space allows, so the auction can actually finish instead of serialising every Manager behind their own wins. The allowance is only safe because the surplus is taken back automatically: when a Close fills a Team's last Slot, its leftover commitments are cancelled most-recent-first and each affected Auction falls to its next-highest surviving Bid. The two halves ship as one unit — the allowance without the cascade lets a Team win a thirteenth Player, which is exactly the invariant the roster ceiling exists to protect. No subset is safe to deploy alone, and the widening stories must never reach production ahead of the cancellation and restoration.

## Stories

- Story 10.1: The Outstanding Bid Allowance in the slots gate
- Story 10.2: Lottery entries leave the slots gate
- Story 10.3: Cancel the surplus commitment at Close
- Story 10.4: Restore the next-highest bidder
- Story 10.5: A lottery whose contenders were cancelled
- Story 10.6: Say it on the board and in Discord

## Requirements & Constraints

**The slots gate.** A Bid passes Roster Capacity when projected Active/Bench additions are zero, **or** when the Team holds at least one free Active/Bench Slot *and* projected additions are at most free slots plus one. The free-slot precondition is tested before the allowance arithmetic — no free Active/Bench Slot means no allowance at all. The ceiling of twelve is unchanged; the allowance is never a thirteenth Slot. The existing carve-out for a Minor-League-eligible Player whose win a free Minor League Slot absorbs is untouched. The `+ 1` is a named constant beside the slot counts, never an inline literal. Every evaluation — pass and refusal alike — reports roster count, projected additions, free slots, the allowance and the ceiling of twelve; a refusal quoting only the allowance would imply thirteen players are legal. Roster Reserve's `max(0, …)` clamp becomes reachable in ordinary play rather than an override-only safeguard.

**Lottery entries are exempt.** A Contention entry contributes nothing to projected Active/Bench additions and consumes no allowance; a Team may contend in any number of open Contentions. An entry is gated only on having somewhere for a win to land — a free Active/Bench Slot, or an eligible Player with a free Minor League Slot. Cap space is the only quantitative limit: a further entry with no money left is refused **on money, not capacity**. Per-entry commitment and eligible-entry exposure rules are unchanged.

**Two overflow figures, not one.** The money-side count includes Contention entries and feeds Minors Exposure; the slots-side count excludes them and is the only one reaching projected additions. They are one subtraction apart, must be separately named, and each must document which rule it serves. A single shared computation is a defect — an earlier story deliberately shared one and documented the sharing as load-bearing, so that comment must be replaced by one stating why the two must now disagree.

**The cancellation trigger** is any Close that **reduces the winning Team's free Slots — Active/Bench or Minor League**. Nothing else triggers it: not a Bid, not a Nomination, not the clock, and never a restoration. A Minor-League win at zero cap hit that leaves roster count unchanged still fires it; a trigger phrased as "a Close that increases Roster Count" would miss that case and finish the Team over the ceiling.

**The cascade** cancels commitments one at a time, most recent first by log sequence, re-testing roster and contention capacity after each, stopping the moment the Team is within both. An eligible leading Bid a free Minor League Slot can still absorb is left alone however recent. A Team still within capacity after the Close has nothing cancelled. Each cancellation releases committed capital and notifies the Team with **the win that caused it named**. One win can cascade into many cancellations; that is accepted, and the UX exists so it is never a surprise.

**Restoration** hands the Auction to the next-highest surviving Bid and re-commits that Team's capital at that amount, notifying them. A candidate failing re-validation is skipped and the next below tried, down the history; a candidate is never restored and then cancelled. If nothing survives, the Auction returns to Awaiting Opening Bid with its Auction Clock **cleared**, the Player still on the Board and the nominator's Nomination Slot still held — it must not close at the old expiry with no winner.

**Lottery draws** record the Contender list *after* cancellations; a cancelled Contender cannot be drawn, though the history still shows it entered and was cancelled. An empty list closes with no winner, the Player returning to the free-agent pool and the nominator's Slot released, recorded exactly as a drawn one would be. The recorded seed and list must still reproduce the selection by hand, each survivor at `1/n`.

**Test obligations.** Worked examples 29–35 land as new named tests; 24 and 25 are rewritten, 23 gains a capacity clause, and 18–25 are re-verified **as a block** — the eligible/overflow examples now depend on which overflow figure they mean, which is silent-drift territory. Suite green, plus type/lint checks, before any deploy touching the rules core.

## Technical Decisions

- The slots gate takes the bid *state*, not the amount, so it stays structurally incapable of reading a Bid's size. Capacity and money remain independent refusal grounds; neither short-circuits the other.
- Derived quantities (cap space, exposure, overflow, projected additions, capacity) are never stored or memoised, and are evaluated against the hypothetical state as if the prospective Bid were accepted.
- `BidCancelled` is a compensating event: the original `BidPlaced` is never deleted or mutated and stays visible in history. The event carries its own decision — cancelled sequence, cause, and either the restored Team, Bid sequence and amount, or null. The projection **reads** that record rather than re-deriving it by re-running gates inside a fold. No migration: the event-type column is generic text.
- The close module is the sole appender — the close event first, then each cancellation in cascade order, committed in the transaction the next Close is evaluated against. The restore module decides and appends nothing.
- Restoration declares its own command type with a fixed gate set running **only** cap and slots. A synthetic bid placement would re-run the increment rule against a price that just fell and refuse every restoration that mattered. It evaluates **post-close** state: after the triggering placement and after every cancellation already decided in this cascade.
- The selection algorithm is **one** pure function (`core/rules/restore.ts`, `selectRestoration`) — walk the surviving history downward, re-evaluate, skip failures, stop at the first pass — parameterised on the three axes separating a cancellation from a Commissioner void: retain-vs-erase in the fold, leave-vs-restore the Auction Clock, keep-vs-remove the League Clock reset.
- Clock semantics are the sharpest trap: a cancellation resets nothing and removes nothing. The Auction Clock is untouched where a Bid survives (a restored bidder may inherit very little time) and cleared only where none does. The League Clock keeps its reset. A reducer treating cancellation and void alike would end the Auction Phase early every time a roster fills.
- Sequential closing becomes load-bearing rather than merely correct: closes run one at a time in expiry order, each committing before the next is evaluated, so a Team winning the first of several simultaneous lotteries is removed from the rest before they draw.
- Churn concentrates in the bidding, close and restore rule modules, the auctions projection, the shared constants module, and the team/index view figures.

## UX & Interaction Patterns

- **Three refusal-panel sentences that must never collapse into one:** passed (permitted-bid count plus projected roster figure), refused at the allowance (outstanding bids against what the free slots permit), and refused on the precondition (no free Active/Bench slot, so no bid is permitted). The first resolves itself at the next close; the second lasts the whole auction.
- The gate row wraps to a second line rather than truncating, at line-height 1.6, aligned to the sentence's first line.
- The bid control names the allowance trade **once, before the confirm step**, in plain words and without alarm — winning elsewhere first cancels this bid and the next-highest leads. Not a dialog, not a checkbox, not repeated on later views.
- A Team at its allowance has board controls disabled stating *"at your allowance"*, visibly distinct from a Team with no room at all; both stated on the board, not discovered at submission.
- The persistent strip carries bids against the allowance beside the roster figure; at parity the figure alone is the signal, with no colour, badge or warning treatment.
- The Teams index row gains bids against the allowance, with open lottery entries counted **separately** — folding them in would imply a ceiling that does not exist.
- **One event, three notices.** The cancelled Manager's notice leads with the cause then the effect, with no apology, alarm styling or congratulation around it. The restored Manager's re-establishes context, then states the cap cost and how long they have, since the clock did not reset. The league channel gets one line in the existing register.
- Both mentions ride the existing **outbid** category as two new clauses — no fourth category, mutable set unchanged, so they stay unmutable server-side with the existing refusal wording. That category now means "your position in an Auction changed without you", deliberately, because a Manager must not be able to mute the notice telling them they lost a Player through no act of their own.
- The cancelled Bid stays visible in Auction history, struck through, labelled *cancelled*, with the causing win named — never deleted, hidden or reordered. Copy must distinguish it from a void: a void says someone decided the Bid should not have stood; a cancellation says nothing of the kind.
- An Auction with nothing surviving renders as an ordinary **unbid nomination** — the treatment the board already has — not a new "restarted" state, and its history remains.

## Cross-Story Dependencies

- **Internal:** 10.1 and 10.2 widen what may be held; 10.3 and 10.4 take the surplus back. Ship as one unit. 10.3's cascade consumes 10.4's selector; 10.5 depends on cancellations landing before a draw; 10.6 surfaces the figures 10.1 and 10.2 produce.
- **Upstream:** builds on the bidding and capacity work of Epic 2 and the contention, close and clock work of Epic 3, superseding named clauses in both. Requires nothing after it.
- **Downstream:** the Commissioner bid-void story consumes `selectRestoration` with the void's own axes (erase in the fold, restore the Auction Clock, remove the League Clock reset) and writes no selector of its own; its spec cites this function. Recovery/replay work must fold `BidCancelled` and cover a cascade.
- **Sequencing:** must land **before** the moderator pilot and production setup day. Rule changes are fail-stopped during a live Auction Phase, and the pilot exists to measure the very property this rule targets — auction speed. Piloting the old rules would pilot rules the league will not play under.
