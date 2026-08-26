# Epic 2 Context: Nominate and bid — the engine and the refusal

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Build the auction's engine and the surface that explains it: a Manager puts a Free Agent on the Bid Board without committing money, bids on an open Auction, and sees `maximumBid` broken into its components before pressing a button. An illegal Bid is refused at submission — never accepted then reversed — with both gates reported and arithmetic that visibly sums. This is where the product earns trust, because the Commissioner built it and also competes in it: the 4am refusal must leave a Manager annoyed at themselves rather than suspicious of a rival. Auctions deliberately do not close here; the Nomination Slot fold is written so Epic 3's closes require no rework.

## Stories

- Story 2.1: Nominate a Free Agent
- Story 2.2: Nomination refusals and concurrency
- Story 2.3: Nomination Slot lifecycle and dead-nomination visibility
- Story 2.4: The Auction page and its bid control
- Story 2.5: Place a Bid — increment, granularity, and the 24-hour clock
- Story 2.6: The money gate and the refusal panel
- Story 2.7: The slots gate — Roster Capacity, and both gates always reported
- Story 2.8: Minors Exposure — unbounded eligible bidding bounded by overflow

## Requirements & Constraints

- **A nomination commits nothing.** No cap space committed, the nominator is not made Leading Bidder, no Auction Clock runs, and a Team may nominate a Player it could not afford. It marks the Team's Nomination Slot used and names the Player holding it.
- **The Slot releases at Auction Close and not before** — not on being outbid, on no timer of its own. An unbid Nomination never expires, withdraws or returns to the pool; the only exit is a Commissioner override, out of scope here. An Auction unbid past 24 hours is flagged publicly with a word and a shape, derived on read from the nomination timestamp against server time, and the nominating Team is told plainly its Slot is stuck.
- **Every refusal names its actual cause**: Slot in use (naming the holder), Player already on the board / won / under Contract, or wrong phase. Two Managers nominating the same Player concurrently yield exactly one Nomination, enforced at the data layer rather than a check-then-write read.
- **Bid legality:** in Standard Contention a Bid must be at least current high + $500,000 **and** a whole multiple of $500,000. Both checks are written separately though they coincide, because granularity catches an off-grid amount in Minimum-Bid Contention where the increment rule does not apply. A Bid at or below the current high is refused, and a Team may never bid against its own leading Bid.
- **An accepted Bid sets the Auction Clock to exactly 24 hours from that Bid's timestamp**, running continuously with no pause or business-hours adjustment, and resets the League Clock to 48 hours.
- **`committedBids`** = leading amounts on open Standard Contention Auctions for non-eligible Players, plus $1,000,000 per Contender position in a non-eligible Minimum-Bid Contention, plus `minorsExposure`. **Available Cap Space** = Cap Space − `committedBids`. **`rosterReserve`** = `$1,000,000 × max(0, 12 − (Roster Count + Projected Active/Bench Additions))` — clamp retained because an override can put a Team above 12. **`maximumBid`** = Available Cap Space − `rosterReserve` for a non-eligible Player.
- **`freeMinorLeagueSlots` (M)** = 3 − occupied; **Eligible Leading Bids (N)** includes $1,000,000 per open eligible Minimum-Bid Contention contended in; **`overflowCount`** = `max(0, N − M)`; **`minorsExposure`** = the sum of the `overflowCount` **largest** Eligible Leading Bids, zero when N ≤ M — sized to the largest because Slot Placement follows close order and no bidder steers which win overflows. Where a free slot absorbs a `minorLeagueEligible` Player, `maximumBid` is **unbounded and said in words — "no cap limit"** — never a number.
- **Capital releases immediately** on ceasing to be Leading Bidder — not at close, not on a sweep — and the outbid Team is marked for notification.
- **A later cheap eligible bid may be refused** for pushing the Team into overflow and exposing an earlier expensive one. The refusal names that specific earlier Auction; an accepted Bid is never retroactively invalidated.
- **Activation is out of scope entirely** — moving a stashed Player to Active/Bench is enforced in Fantrax; never modelled, warned about, or blocked on.

## Technical Decisions

- **Two core entry points only.** `evaluate(state, command, now) → GateResults` is total and never refuses to answer; `decide(state, command, now, seed)` returns `Accepted<Event[]>` or `Rejected<GateResults>` and obtains its outcomes by **calling `evaluate()`**, never re-deriving them. The gate set is fixed per command type, so a `PlaceBid` result always carries every gate whether or not each passed. A violation is a returned `Rejected`, never a thrown exception. Rules live in `core/rules/nomination` and `core/rules/bidding`, reading no clock, database or random source, and iterating only over explicitly sorted sequences.
- **The read path calls `evaluate()` directly** — the same function `decide()` calls — so a control claiming a bid is impossible and a refusal explaining why cannot disagree. Figures recompute within one second of any Bid, Auction Close or override.
- **Derived money is never stored.** `committedBids`, `minorsExposure`, `overflowCount`, `rosterReserve`, `maximumBid` and Roster Capacity are computed from committed state at validation time — never persisted on a Team row, memoised across transactions, or cached client-side for validation — and evaluated against the **hypothetical post-bid state**, with Projected Active/Bench Additions counting the bid being placed.
- **Roster Capacity is a second, independent gate**: refuse when `Roster Count + Projected Active/Bench Additions > 12`, same post-bid basis. Neither gate subsumes or short-circuits the other; `evaluate()` returns both outcomes with their own arithmetic and **distinct machine-readable reasons** — reporting a capacity refusal as a cap refusal is a defect. An unbounded `maximumBid` grants no capacity exemption, and an eligible bid that would overflow with nowhere to land is refused on capacity with no Slot Placement carve-out.
- **Commands run the transactional shell** — lock → load → decide → persist — taking the one global advisory transaction lock before reading any state, with `now` from the database clock. The *Team* is raced, not the Auction, so per-Auction serialisation is insufficient. Expiry persists as an absolute close timestamp; the client counts down from it and never receives "seconds remaining".
- **Nomination Slot status is a fold over the log**, held while the nominated Player's Auction is open and released on that Player's `AuctionClosed` regardless of who won or whether the nominator ever bid — never a stored flag toggled by a handler. A test appends a synthetic `AuctionClosed` and asserts release.
- **League Clock resets are exactly two** — a Nomination and an accepted Bid — added on top of an **origin already folded from the auction open**. An origin is not a reset: no compensating event moves it, and expiry is 48 hours after the later of origin and latest surviving reset, so nothing recomputes back past the open.
- **Events** are past-tense `PascalCase` (`NominationPlaced`, `BidPlaced`), carrying acting Manager, Team, Player/amount, timestamp and **device class** — captured from the first event, since an insert-only log cannot be backfilled. Money is integer dollars branded at every runtime boundary; glossary terms are the identifier names verbatim and a synonym is a defect.
- **The §10 worked examples are the executable specification.** Owned here: 1, 2, 3, 4, 5, 15, 18, 19, 20, 23, 24, 25, 26 — each a named test calling the core directly against a state literal, plus an automated nomination-concurrency test. Examples 16, 17, 21 and 22 are **not** owned here; they are close-time or lottery cases and land in Epic 3.

## UX & Interaction Patterns

- **Nomination and bidding are both deliberate two-part acts** — select/enter, then confirm — never a one-tap raise. No suggested player, ranking, "similar players" affordance, recommended amount, or countdown pressure anywhere.
- **Disabled means explained on the board, not discovered at submission**, worded distinctly per cause — already leading, no money, no roster slot each call for a different remedy. On a stale read path, controls disable with the reason stated and `maximumBid` renders as an explicitly labelled last-known figure.
- **`maximumBid` is never a bare number**: Cap Space, `committedBids`, `minorsExposure` and `rosterReserve` are broken out and **visibly sum as displayed**, which the $500,000 grid makes possible at one decimal.
- **The refusal panel** is a `surface` panel with a 3px top accent bar in `attention` — the only top bar in the system, so a refusal is identifiable before a word is read. Order: Georgia 19px headline, the delta in one sentence, reassurance that nothing was committed and the Auction is unchanged, the gate report, the full timestamped arithmetic, then the disabled control with its reason. The arithmetic is never behind a disclosure, and the refusal is **announced to assistive technology as it appears**, not merely rendered.
- **Both gates always render**: the refusing gate a filled `attention` chip with `attention-ink`, the passing gate an outlined `border-interactive` chip with `text-secondary`, chip left and sentence right, top-aligned, the passing gate carrying its own figure. Filled-versus-outlined survives greyscale; colour alone would not. **No red anywhere** — `attention` amber marks Outbid and refusal and nothing else.
- **The Auction page** shows Player identity, current price, Leading Bidder, state and time remaining; a metadata line of real-life team, position, existing salary and contract length; and full chronological bid history with acting Manager names and **no anonymity at any point**. Time appears twice — relative and absolute in the viewer's timezone — the absolute never dropped to save space. Single-column and one-handed at 375px, ≥44×44px targets, readable in greyscale. A three-letter capitalised abbreviation means the real-life NBA team only; a fantasy Team is spelled out with its acting Manager.
- **No control to cancel, edit or lower an accepted Bid exists — absent, not disabled.** Refusals state the fact then the arithmetic, no apologies, no exclamation marks.

## Cross-Story Dependencies

- 2.1 establishes the nomination command and event; 2.2 layers the refusal set and data-layer uniqueness on it; 2.3 folds the Slot from what those two write. 2.4's bid control depends on 2.5 for its minimum-legal-Bid pre-fill and on 2.6/2.7's gate outcomes for its disabled reasons — build the rules before the surface, or the page invents figures.
- 2.6, 2.7 and 2.8 are one arithmetic split three ways: 2.6 owns the money gate and refusal panel, 2.7 the capacity gate and the always-both-gates report, 2.8 the eligible-player exposure feeding `committedBids` back into 2.6. 2.8's overflow case also refuses through 2.7's gate.
- Depends on Epic 1 for the pure core boundary, branded money, the append-only log and fold machinery, the global write lock, phase-and-role gating, imported reference data, and the Commissioner-set `minorLeagueEligible` flag.
- Feeds Epic 3, which owns Auction Close, the lottery draw and phase end. Nothing here may depend on a close existing; 2.3's fold is the seam, proven with a synthetic close event.
- **Deliberately out of scope:** Commissioner override and bid voiding (Epic 7), outbid notification delivery (Epic 5), and Minimum-Bid Contention's own lifecycle (Epic 3) — though 2.5 and 2.8 must still account for contention commitments in the arithmetic.
