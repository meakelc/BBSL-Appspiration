/**
 * PRD §10 example 20 — **A resolved win stops being exposure** (AD-25).
 *
 * > The $30,000,000 auction closes and the player takes Team P's last Free
 * > Minor League Slot at a $0 Cap Hit; Roster Count is still 11. He is no
 * > longer an Eligible Leading Bid, so he no longer contributes exposure at
 * > all. Team P re-bids $1,000,000 on the second eligible player: now `N = 1`
 * > against `M = 0`, Overflow Count 1, and Minors Exposure is $1,000,000 —
 * > the bid's own amount, which Team P's $2,000,000 of room covers. Projected
 * > Active/Bench Additions is 1, so Roster Reserve is
 * > `$1,000,000 × max(0, 12 − 12) = $0` and Maximum Bid is $1,000,000;
 * > capacity passes at `11 + 1 = 12`. The bid is **permitted**. The lesson is
 * > that an *open* leading bid creates exposure at full price while a
 * > *closed* one creates none, because it has already become a $0 Cap Hit in
 * > a slot.
 *
 * **This example needs no code at all, and that is the finding.** Nothing
 * sweeps the closed Auction out of Minors Exposure and nothing recomputes a
 * stored figure: the close is one more event, the fold stops returning that
 * Auction, and the amount simply stops appearing. AD-7's "derived on every
 * evaluation" is what makes stale exposure structurally impossible rather
 * than merely tested against — the same property example 5 proves for an
 * outbid lead.
 *
 * **The close is SYNTHETIC**, exactly as Story 2.3 proved its own fold. No
 * `AuctionClosed` is appended anywhere in Epic 2 — closing is Epic 3's — so
 * the event is handed to `auctionsReducer` directly and only folded.
 *
 * **The prospective Bid is inside the set it is judged against**, which is
 * what makes Maximum Bid `$2.0M − $1.0M = $1.0M` rather than `$2.0M`. The
 * effective bound on a sole overflowing eligible Bid is therefore half the
 * Team's room. That is conservative rather than wrong; it is what §10 states,
 * and §10 is the executable specification.
 *
 * **One seam this story could not close, and it is Epic 3's.** The example's
 * $1,000,000 is an Opening Bid at exactly `MINIMUM_BID`, which PRD §3 says
 * opens a Minimum-Bid Contention — and Story 2.5's `opening` gate refuses
 * that amount by name, because no Contender list, seed table, fixed clock or
 * draw exists to run one (Stories 3.2/3.3). Both the money gate and the
 * capacity gate PASS on this Bid, exactly as the example says they must, and
 * `opening` is the only gate that does not. Asserted as such below rather
 * than papered over.
 */

import { describe, expect, it } from 'vitest';

import { closedPayload } from '../fixtures/closed-event.ts';

import {
	INITIAL_AUCTIONS,
	auctionsReducer,
	BID_PLACED_EVENT
} from '../../src/lib/core/projection/auctions.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	bidStateFor,
	capBreakdown,
	evaluate,
	failedGates,
	teamMoneyStateFor
} from '../../src/lib/core/rules/bidding.ts';
import type { BidState, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import type { AppendedEvent, PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-27T09:00:00.000Z';

function event(seq: number, type: string, payload: unknown): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt: '2026-08-26T09:00:00.000Z',
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: 'm-p',
		teamId: 't-p',
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

/** Team P's $30,000,000 stash Bid, leading an OPEN eligible Auction. */
const THE_STASH_BID = event(1, BID_PLACED_EVENT, {
	fantraxPlayerId: 'p-stash',
	teamId: 't-p',
	teamName: 'Team P',
	managerId: 'm-p',
	amount: 30_000_000,
	closesAt: '2026-08-27T09:00:00.000Z'
});

/**
 * The close — synthetic, and folded rather than appended.
 *
 * Nothing in Epic 2 writes one of these. `auctionsReducer` reads the Player
 * id through `nominations.ts`'s own `readClosedPlayerId`, so this is the
 * exact shape a real close will carry when Epic 3 starts appending them.
 */
const THE_CLOSE = event(2, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-stash' }));

/**
 * Team P, from the fold, at a given point in the log — plus the roster facts
 * `team_rosters` answers.
 *
 * `minorLeagueOccupied` is the roster's, and the close is what moved it from
 * two to three: the won Player now sits in the last Free Minor League Slot at
 * a $0 Cap Hit, so Cap Space is unchanged at $2,000,000 and Roster Count is
 * unchanged at 11.
 */
function teamPAfter(
	events: readonly AppendedEvent[],
	minorLeagueOccupied: number
): TeamMoneyState {
	return teamMoneyStateFor({
		teamId: 't-p',
		fantraxPlayerId: 'p-second',
		capSpace: parseMoney(2_000_000),
		rosterCount: 11,
		minorLeagueOccupied,
		auctions: fold(INITIAL_AUCTIONS, events, auctionsReducer),
		isMinorLeagueEligible: () => true,
		playerNameFor: (playerId) => (playerId === 'p-stash' ? 'Ausar Bright' : playerId)
	});
}

function bidOf(amount: number): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId: 'p-second',
		teamId: 't-p',
		teamName: 'Team P',
		managerId: 'm-p',
		amount: parseMoney(amount)
	};
}

/** Before the close: two Slots occupied, one open eligible lead. */
const BEFORE: BidState = bidStateFor(null, teamPAfter([THE_STASH_BID], 2), true, 'Auction');

/** After it: three Slots occupied, and no eligible lead left in the fold. */
const AFTER: BidState = bidStateFor(null, teamPAfter([THE_STASH_BID, THE_CLOSE], 3), true, 'Auction');

describe('§10 example 20 — a resolved win stops being exposure', () => {
	it('drops the closed Auction out of the eligible set by folding one more event', () => {
		// Nothing swept, nothing recomputed, nothing invalidated. The reducer
		// stops returning the Auction and the amount simply stops appearing.
		expect(BEFORE.team?.eligibleLeading).toEqual([
			{ fantraxPlayerId: 'p-stash', playerName: 'Ausar Bright', amount: 30_000_000 }
		]);
		expect(AFTER.team?.eligibleLeading).toEqual([]);
		// The close moved nothing else: same Cap Space, same Roster Count.
		expect(AFTER.team?.capSpace).toBe(2_000_000);
		expect(AFTER.team?.rosterCount).toBe(11);
	});

	it('derives N = 1 against M = 0, Overflow 1, and exposure of the bid’s OWN amount', () => {
		const cap = evaluate(AFTER, bidOf(1_000_000), NOW).cap;

		// The won Player took the last Slot, so there are none free.
		expect(cap.freeMinorLeagueSlots).toBe(0);
		expect(cap.eligibleLeadingBids).toBe(1);
		expect(cap.overflowCount).toBe(1);
		// "$1,000,000 — the bid's own amount". The $30,000,000 contributes
		// nothing at all now.
		expect(cap.minorsExposure).toBe(1_000_000);
		// ...and there is no EARLIER Auction to name: the only thing in the
		// overflow set is the Bid a Manager is already looking at.
		expect(cap.exposingBids).toEqual([]);
	});

	it('is not unbounded — a Free Minor League Slot no longer absorbs this Player', () => {
		const cap = evaluate(AFTER, bidOf(1_000_000), NOW).cap;

		expect(cap.unbounded).toBe(false);
		// Contrast with the state before the close, where `M = 1` and `N = 2`
		// left an overflow too — unbounded needs `Overflow Count` 0, which
		// neither state has.
		expect(evaluate(BEFORE, bidOf(1_000_000), NOW).cap.unbounded).toBe(false);
	});

	it('permits $1,000,000 at exactly the ceiling: Maximum Bid $1.0M, offered $1.0M', () => {
		const cap = evaluate(AFTER, bidOf(1_000_000), NOW).cap;

		expect(cap.committedBids).toBe(1_000_000);
		expect(cap.availableCapSpace).toBe(1_000_000);
		expect(cap.projectedAdditions).toBe(1);
		expect(cap.rosterReserve).toBe(0);
		expect(cap.maximumBid).toBe(1_000_000);
		// "At or below" passes — a Bid exactly equal to Maximum Bid is legal.
		expect(cap.offered).toBe(1_000_000);
		expect(cap.passed).toBe(true);
	});

	it('passes capacity at 11 + 1 = 12', () => {
		const slots = evaluate(AFTER, bidOf(1_000_000), NOW).slots;

		// The overflow has nowhere in the minors to land, so it counts against
		// Active/Bench — and one addition still fits.
		expect(slots.overflowCount).toBe(1);
		expect(slots.projectedAdditions).toBe(1);
		expect(slots.rosterCount).toBe(11);
		expect(slots.passed).toBe(true);
	});

	it('leaves NO refusal at all — the lottery opening is legal since Story 3.2', () => {
		// Both grounds this story owns pass, exactly as the example says. Until
		// Story 3.2 one gate still refused: `opening`, because $1,000,000
		// exactly would open a Minimum-Bid Contention and no Contender list,
		// seed or fixed clock existed to run one. All three exist now, the
		// opening passes, and this Bid is accepted outright — which is what the
		// example always meant by "the $1,000,000 bid is permitted".
		const gates = evaluate(AFTER, bidOf(1_000_000), NOW);

		expect(gates.cap.passed).toBe(true);
		expect(gates.slots.passed).toBe(true);
		expect(failedGates(gates)).toEqual([]);
		expect(gates.opening.opening).toBe('at_the_minimum');
		expect(gates.opening.passed).toBe(true);
	});

	it('prints the exposure inside Committed Bids, and no "no cap limit" row', () => {
		const lines = capBreakdown(evaluate(AFTER, bidOf(1_000_000), NOW).cap);
		const figureFor = (label: string) => lines.find((line) => line.label === label)?.figure;

		expect(figureFor('Cap Space')).toBe('$2.0M');
		expect(figureFor('Committed Bids')).toBe('$1.0M');
		expect(figureFor('of which Minors Exposure')).toBe('$1.0M');
		expect(figureFor('Available Cap Space')).toBe('$1.0M');
		expect(figureFor('Maximum Bid')).toBe('$1.0M');
		expect(figureFor('Eligible Leading Bids 1 of 0 Free Minor League Slots')).toBe(
			'Overflow Count 1'
		);
		// Bounded, so the figure is a number and there is nothing to explain.
		expect(lines.some((line) => line.label === 'Why there is no cap limit')).toBe(false);
	});
});
