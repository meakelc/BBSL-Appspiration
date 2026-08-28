# Epic 3 Context: The auction resolves itself — lottery, close, and phase end

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Make the auction finish without anyone watching it. An Auction closes within 60 seconds of its expiry at 4am with the winner placed, priced and folded into the Team's cap position; a $1,000,000 opening becomes a lottery whose seed is sealed before the draw and handed over after it, so a losing Manager can reproduce the result by hand; and the Auction Phase ends itself after 48 hours of league silence, with the phase falling out of the log rather than being flipped by the Commissioner. This is the epic where the Commissioner-is-also-a-rival problem is settled for good: a stalled sweep may make a close *late*, never *wrong*, and a draw nobody can check is theatre.

## Stories

- Story 3.1: Expiry is authoritative for validation
- Story 3.2: Enter and join a Minimum-Bid Contention
- Story 3.3: Dissolve a Minimum-Bid Contention
- Story 3.4: Close an Auction and place the Player
- Story 3.5: The tick — one cron, one function, sweep then drain
- Story 3.6: Draw a Minimum-Bid Contention winner
- Story 3.7: The League Clock and the end of the Auction Phase

## Requirements & Constraints

- **Expiry closes an Auction for validation from that instant**, whether or not the sweep has recorded it. A Bid arriving in the gap is **refused as expired** — never accepted then reversed — worded distinctly from the cap and capacity refusals. Validation compares injected `now` against the **persisted absolute close time**; a projection's "open" flag is never authority, because a projection lags a stalled sweep.
- **Minimum-Bid Contention** is entered by an Opening Bid of exactly $1,000,000; anything above opens Standard Contention. Its Clock is set to 24 hours from that Opening Bid and is **thereafter fixed** — a join never resets, extends or alters it, though a join **does** reset the League Clock. The opening bidder is the first Contender; no Team joins twice. An amount strictly between $1,000,000 and $1,500,000 is refused as neither a valid lottery entry nor a valid ascending Bid — under $500,000 granularity that dead zone holds no grid-valid amount, so it is reachable only off-grid.
- **Joining commits capital by eligibility**: $1,000,000 straight into `committedBids` for a non-eligible Player, because any Contender may win; an **Eligible Leading Bid** of $1,000,000 feeding Minors Exposure for a `minorLeagueEligible` Player, committing nothing while a free Minor League Slot can absorb the win.
- **$1,500,000 or more dissolves the lottery** regardless of Contender count, including from a Contender: the Contender list is discarded, every $1,000,000 commitment releases immediately, the Clock resets to 24 hours from the converting Bid, and ordinary ascending rules — increment included — apply from that point. A dissolved contention still **reveals its seed**, so no unopened commitment is left behind.
- **The draw is uniform over the Contender list**, every Contender at `1/n`, a single Contender resolving without ambiguity. Seed, the **ordered Contender list as it stood at expiry**, and the selection are all appended and permanently visible on the closed Auction and in the Audit Log; losing Contenders' capital releases at the draw. The seed-to-winner derivation must be a documented deterministic procedure a Manager can run by hand or in a spreadsheet, **shipped with the app** rather than living in a commit message.
- **Close awards and places in one step**: Leading Bidder at their amount in Standard Contention, the drawn Contender at $1,000,000 in a lottery. **Slot Placement is automatic with no Manager or Commissioner choice** — an eligible Player takes a free Minor League Slot if one exists, Active/Bench otherwise; everyone else takes Active/Bench. Roster Count increments **only** on an Active/Bench placement. Contract length is recorded unset.
- **Close folds downstream**: the Player leaves the Bid Board and the Free Agent pool, Minors Exposure carried *for this Auction* releases and is recomputed across the Team's remaining eligible bids, and the nominating Team's Nomination Slot releases through the existing fold with no new handler. **A close does not reset the League Clock.**
- **Auctions close within 60 seconds of nominal expiry with no user present.** A late sweep must produce exactly the outcome an on-time sweep would have.
- **The League Clock is reset by exactly two event types** — a Nomination and an accepted Bid, lottery join included — and by nothing else: not a close, a draw, a dissolution, a void, an override, or a pause/resume. New event types default to **not** resetting it. Expiry is 48 hours after the **later** of the origin (the auction open, which no compensating event can move) and the latest surviving reset.
- **On League Clock expiry** Nomination and bidding are disabled league-wide, every Auction still in Awaiting Opening Bid is terminated with no winner and its Player returns to the pool unclaimed, the phase folds to Contract Assignment, and all Managers are notified.

## Technical Decisions

- **One cron schedule, one Deno Edge Function, sweep *then* drain.** It never runs on Netlify and holds no in-memory timer. The sub-minute interval is chosen against remaining free-tier headroom, not the SLA alone — two 10-second schedules would be ~518K invocations/month against a 500K org-wide cap; one combined tick is ~259K. The dev project's schedule is disabled by default and enabled only for a rehearsal. Every pass writes a **heartbeat row**.
- **The sweep re-derives what has expired** rather than remembering what is pending, which makes it restart-safe by construction. It takes the same global advisory lock, same named constant, same arity as every Node caller, and closes nothing while paused.
- **Closes are sequential, never batched.** Overdue Auctions close **one at a time, ascending nominal expiry, ties broken by auction id**, each close's effect on slot occupancy, Roster Count, Cap Hit and Minors Exposure committed to the state the next close is evaluated against. Folding an overdue set against one loaded snapshot must fail a test — four eligible Players cannot go into three Minor League Slots.
- **`now` for a close is that Auction's own nominal expiry**, not the sweep's wall time. Time stays a parameter, so a full auction is replayable against a synthetic clock.
- **Commit-reveal randomizer.** The seed is generated at contention open and stored in a table readable by **no client-facing role, the Commissioner's included** — assert that in an automated test. Only `hash(seed)` is published before the draw. The seed reaches the core as an **argument**; the core reads no random source. **Contender order is pinned to ascending join `seq`**, because order is an input to the winner.
- **Winning amount and Cap Hit are separate persisted fields.** A Minor League placement yields Cap Hit `$0` with the winning amount unchanged; no code path derives one from the other by assuming equality.
- **The League Clock is a fold, never a stored countdown.** Because the log is insert-only, the fold treats a `BidPlaced` with a matching `BidVoided` as a **non-reset** rather than expecting the event to be gone; the clock recomputes shorter. Recomputation is **prospective only** — an expiry landing in the past ends the phase at the next evaluation, and nothing accepted in the interim is invalidated.
- **Phase is a projection folded from the log**, rebuildable to the same value; nobody sets a flag, and it is the single source every surface reads to change shape.
- **Dual-runtime version parity is fail-stop**: differing `coreVersion` between the Node and Deno deployments makes the tick **refuse to run and alert**. Any deploy touching `core/` during a live Auction Phase requires a pause, a green §10 suite, and a recorded reason.
- **§10 examples owned here** — 6, 7, 8, 9, 10, 11, 13, 16, 17, 21, 22, 27 — each a named test calling the core directly against a state literal. Example 27 is written now against a literal containing both `BidPlaced` and `BidVoided`, so Epic 7 need only append the void.

## UX & Interaction Patterns

- **A Minimum-Bid Contention is marked by the 3px `lottery` left accent bar plus an icon and a word** — never colour alone, and no other element may borrow the device. It shows the live Contender list and count, and states **in words, not iconography**, that the clock will not reset on a join. This completes the contention clause carried over from Story 2.4.
- **A closed Auction shows winner, final amount and Slot placement permanently**, and for a lottery the seed and the ordered Contender list alongside them. A terminated Auction shows no winner and that the Player returned to the pool. Your Positions groups the wake-up in order: won while you slept, outbid, you lead, contending, Nomination Slot.
- **The countdown derives from an absolute close time the client already holds**, so an Auction displays as expired with its bid control disabled in any connection state, including Stale, with no update received.
- **The phase transition is announced in the app**, not merely reflected by controls quietly ceasing to work; the Bid Board freezes and stays readable.

## Cross-Story Dependencies

- 3.1 is the validation floor everything else stands on — build it before the sweep, or a late tick becomes a wrong outcome. 3.2 creates the contention and its sealed seed; 3.3 dissolves it and 3.6 draws it, and both must release capital and reveal the seed, so treat them as the two exits from one state.
- 3.4 owns close and Slot Placement as pure rules; 3.5 owns the runtime that invokes them, and 3.6's draw runs inside that sweep. 3.5's sequential-close requirement is only testable once 3.4's placement arithmetic exists.
- 3.7's fold is the first production reader of the League Clock; the sweep evaluates it, so 3.5 lands first.
- Depends on Epic 2 for `evaluate()`/`decide()`, the bidding and nomination rules, `committedBids`, Minors Exposure and Overflow, Roster Capacity, and the Nomination Slot fold whose release is exercised here for real rather than by synthetic event. Depends on Epic 1 for the append-only log, the global advisory lock, database-clock `now`, branded money, the League Clock origin, and phase-and-role gating.
- **Out of scope here:** Commissioner override, bid voiding and pause/resume mechanics (Epic 7) — 3.7 only proves the fold handles a void; notification delivery and the outbox dispatcher's own behaviour (Epic 5), though 3.5 runs the drain in the same tick; and Contract Assignment itself (Epic 6), which 3.7 only hands the phase to.
