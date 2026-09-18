/**
 * PRD §10 example 20 — **RETIRED on 2026-09-18**, and this file is the record
 * of that plus the regression that keeps it retired.
 *
 * Example 20 existed to state that exposure was released by a close:
 *
 * > The $30,000,000 auction closes and the player takes Team P's last Free
 * > Minor League Slot at a $0 Cap Hit; Roster Count is still 11. He is no
 * > longer an Eligible Leading Bid, so he no longer contributes exposure at
 * > all. […] The lesson is that an *open* leading bid creates exposure at
 * > full price while a *closed* one creates none, because it has already
 * > become a $0 Cap Hit in a slot.
 *
 * **The LESSON survives in a stronger form; the arithmetic does not.** A Team
 * cannot win a Free Agent straight into its minors, so the close does not
 * produce a $0 Cap Hit — it produces a $30,000,000 one in an Active/Bench
 * Slot. The $30,000,000 still stops being a commitment, and for exactly the
 * reason the example gave: the fold stops returning the Auction and the
 * amount stops appearing. It simply reappears as a Cap Hit instead of
 * vanishing.
 *
 * That makes the point cleaner than it was. The money does not disappear at a
 * close, it MOVES: out of Committed Bids and into the Cap Space the contract
 * now charges, with Available Cap Space landing in the same place either way.
 * The assertions below pin that conservation, which the old $0 Cap Hit hid.
 *
 * **This example needs no code at all, and that is still the finding.**
 * Nothing sweeps the closed Auction out and nothing recomputes a stored
 * figure: the close is one more event, the reducer stops returning that
 * Auction, and the amount simply stops appearing. AD-7's "derived on every
 * evaluation" is what makes a stale commitment structurally impossible rather
 * than merely tested against — the same property example 5 proves for an
 * outbid lead.
 *
 * **The figures are re-founded, and that is not a fudge.** Team P held a
 * $30,000,000 lead against $2,000,000 of Cap Space, which was solvent only
 * because the lead committed nothing. Commit it in full and that Team could
 * never have placed the Bid, so a fixture built on it would assert against a
 * position the gates make unreachable. Cap Space starts at $32,000,000 and
 * Roster Count at 10 — the smallest change that keeps Team P legal before the
 * close and leaves the example's own $2,000,000 of room after it.
 *
 * **The close is SYNTHETIC**, exactly as Story 2.3 proved its own fold, and
 * is folded rather than appended.
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
 * The close is what moves Cap Space and Roster Count, and it moves BOTH now:
 * the won Player lands in an Active/Bench Slot at a $30,000,000 Cap Hit, so
 * Cap Space falls from $32,000,000 to $2,000,000 and Roster Count rises from
 * 10 to 11. Minor League occupancy is untouched at two — the Slot the old
 * example filled stays free.
 */
function teamPAfter(
	events: readonly AppendedEvent[],
	capSpace: number,
	rosterCount: number
): TeamMoneyState {
	return teamMoneyStateFor({
		teamId: 't-p',
		fantraxPlayerId: 'p-second',
		capSpace: parseMoney(capSpace),
		rosterCount,
		minorLeagueOccupied: 2,
		auctions: fold(INITIAL_AUCTIONS, events, auctionsReducer),
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

/** Before the close: $32,000,000 of room, ten held, one open lead. */
const BEFORE: BidState = bidStateFor(null, teamPAfter([THE_STASH_BID], 32_000_000, 10), 'Auction');

/** After it: the win charged, eleven held, and no lead left in the fold. */
const AFTER: BidState = bidStateFor(
	null,
	teamPAfter([THE_STASH_BID, THE_CLOSE], 2_000_000, 11),
	'Auction'
);

describe('§10 example 20 — RETIRED: a resolved win stops being a commitment', () => {
	it('drops the closed Auction out of the leads by folding one more event', () => {
		// Nothing swept, nothing recomputed, nothing invalidated. The reducer
		// stops returning the Auction and the amount simply stops appearing.
		expect(BEFORE.team?.leading).toEqual([
			{
				fantraxPlayerId: 'p-stash',
				playerName: 'Ausar Bright',
				amount: 30_000_000,
				isContentionEntry: false
			}
		]);
		expect(AFTER.team?.leading).toEqual([]);
		// Nothing was ever routed to the eligible list, before or after.
		expect(BEFORE.team?.eligibleLeading).toEqual([]);
		expect(AFTER.team?.eligibleLeading).toEqual([]);
	});

	it('MOVES the money rather than releasing it — commitment becomes Cap Hit', () => {
		const before = evaluate(BEFORE, bidOf(1_000_000), NOW).cap;
		const after = evaluate(AFTER, bidOf(1_000_000), NOW).cap;

		// Before: $32,000,000 of room, $30,000,000 committed.
		expect(before.capSpace).toBe(32_000_000);
		expect(before.committedBids).toBe(30_000_000);
		// After: the commitment is gone and the Cap Space is $30,000,000
		// smaller, because the contract now charges.
		expect(after.capSpace).toBe(2_000_000);
		expect(after.committedBids).toBe(0);
		// ...and Available Cap Space lands in exactly the same place either
		// way. That conservation is the lesson, and the old $0 Cap Hit hid it.
		expect(before.availableCapSpace).toBe(2_000_000);
		expect(after.availableCapSpace).toBe(2_000_000);
	});

	it('leaves the Minor League Slot FREE and raises Roster Count instead', () => {
		// The old close filled Team P's last Minor League Slot and left Roster
		// Count at 11. It does neither now.
		expect(AFTER.team?.minorLeagueOccupied).toBe(2);
		expect(BEFORE.team?.rosterCount).toBe(10);
		expect(AFTER.team?.rosterCount).toBe(11);
	});

	it('counts no eligible leads and is never unbounded, before or after', () => {
		const after = evaluate(AFTER, bidOf(1_000_000), NOW).cap;

		// One free Minor League Slot, and it decides nothing.
		expect(after.freeMinorLeagueSlots).toBe(1);
		expect(after.eligibleLeadingBids).toBe(0);
		expect(after.overflowCount).toBe(0);
		expect(after.minorsExposure).toBe(0);
		expect(after.exposingBids).toEqual([]);
		expect(after.unbounded).toBe(false);
		expect(evaluate(BEFORE, bidOf(1_000_000), NOW).cap.unbounded).toBe(false);
	});

	it('permits $1,000,000 comfortably: Maximum Bid $2.0M, offered $1.0M', () => {
		const cap = evaluate(AFTER, bidOf(1_000_000), NOW).cap;

		expect(cap.committedBids).toBe(0);
		expect(cap.availableCapSpace).toBe(2_000_000);
		expect(cap.projectedAdditions).toBe(1);
		expect(cap.rosterReserve).toBe(0);
		// The whole room, because nothing is committed and the projected win
		// fills the twelfth Slot so there is nothing to reserve. The old
		// example's ceiling was half this, halved by the bid's own exposure.
		expect(cap.maximumBid).toBe(2_000_000);
		expect(cap.offered).toBe(1_000_000);
		expect(cap.passed).toBe(true);
	});

	it('passes capacity at 11 + 1 = 12', () => {
		const slots = evaluate(AFTER, bidOf(1_000_000), NOW).slots;

		// No overflow of any kind — the figure is permanently zero.
		expect(slots.activeBenchOverflow).toBe(0);
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

	it('prints nothing committed, and no "no cap limit" row', () => {
		const lines = capBreakdown(evaluate(AFTER, bidOf(1_000_000), NOW).cap);
		const figureFor = (label: string) => lines.find((line) => line.label === label)?.figure;

		expect(figureFor('Cap Space')).toBe('$2.0M');
		expect(figureFor('Committed Bids')).toBe('$0.0M');
		expect(figureFor('of which Minors Exposure')).toBe('$0.0M');
		expect(figureFor('Available Cap Space')).toBe('$2.0M');
		expect(figureFor('Maximum Bid')).toBe('$2.0M');
		expect(figureFor('Eligible Leading Bids 0 of 1 Free Minor League Slots')).toBe(
			'Overflow Count 0'
		);
		// Bounded, so the figure is a number and there is nothing to explain.
		expect(lines.some((line) => line.label === 'Why there is no cap limit')).toBe(false);
	});
});
