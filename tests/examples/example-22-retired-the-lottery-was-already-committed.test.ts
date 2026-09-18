/**
 * PRD §10 example 22 — **RETIRED on 2026-09-18**, and this file is the record
 * of that plus the regression that keeps it retired.
 *
 * Example 22 existed as the other half of example 21's pair:
 *
 * > Same Team Q, now already leading three eligible auctions at $5,000,000,
 * > $4,000,000 and $3,000,000 against its three free slots. It tries to join
 * > a $1,000,000 contention on a fourth eligible player: `N = 4` against
 * > `M = 3`, Overflow Count 1, Minors Exposure $5,000,000 — the largest of
 * > the four. With $0 Available Cap Space the join is **refused**, and the
 * > message names the $5,000,000 auction.
 *
 * **The pair was the point, and the pair is gone.** 21 and 22 differed only
 * in whether a fourth eligible win had a Free Minor League Slot to land in.
 * No win lands in one: a Team cannot win a Free Agent straight into its
 * minors, so all three standing leads commit their full amounts from the
 * moment they are placed, and the fourth join is refused for the same reason
 * every other over-commitment is.
 *
 * **The refusal SURVIVES, and so does "the money is the sole ground".** Team
 * Q still has $0 of Available Cap Space and the capacity gate still passes —
 * Roster Count 11 leaves one Free Active/Bench Slot, which is FR-18's landing
 * test. So the example's headline outcome is unchanged; only the term holding
 * the money is.
 *
 * **Cap Space is re-founded from $5,000,000 to $12,000,000, and that is not a
 * fudge.** The old figure produced "$0 Available Cap Space" only because
 * $12,000,000 of leads were charging $5,000,000 of exposure. Commit all three
 * in full and the same sentence needs $12,000,000 of room. Leaving it at
 * $5,000,000 would have built a Team holding $12,000,000 of commitments
 * against $5,000,000 of space — a state the gates could never have let it
 * reach, and a fixture asserting against an unreachable position proves
 * nothing.
 *
 * **The refusal no longer names the Auction holding the money**, exactly as
 * example 19's retirement records. `exposingBids` was the exposure set and
 * there is no exposure; `leading` still carries every Player name, so naming
 * them is follow-up work rather than information the app has lost.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_BID, MINOR_LEAGUE_SLOTS } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import type { Auction, Bid } from '../../src/lib/core/projection/auctions.ts';
import { INITIAL_AUCTIONS } from '../../src/lib/core/projection/auctions.ts';
import {
	bidRefusalDetail,
	bidStateFor,
	capBreakdown,
	evaluate,
	failedGates,
	teamMoneyStateFor
} from '../../src/lib/core/rules/bidding.ts';
import type { BidState, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-24T14:00:00.000Z';

/**
 * Team Q, now leading three Auctions.
 *
 * `capSpace` is $12,000,000 and Committed Bids will be $12,000,000, so
 * Available Cap Space is exactly $0 — the example's own figure, re-founded
 * on the full commitments (see the header). Eleven Active/Bench Slots are
 * held, so one Free Active/Bench Slot remains and FR-18's landing test
 * passes: the capacity gate PASSES and the money gate is the sole ground,
 * which is what the example's "the join is refused" requires.
 */
const TEAM_Q: TeamMoneyState = {
	capSpace: parseMoney(12_000_000),
	rosterCount: 11,
	// "leading three eligible auctions" — and eligibility routes nowhere now,
	// so all three are ordinary leads charging Committed Bids in full.
	leading: [
		{
			fantraxPlayerId: 'p-a',
			playerName: 'Ausar Thompson',
			amount: parseMoney(5_000_000),
			isContentionEntry: false
		},
		{
			fantraxPlayerId: 'p-b',
			playerName: 'Bilal Coulibaly',
			amount: parseMoney(4_000_000),
			isContentionEntry: false
		},
		{
			fantraxPlayerId: 'p-c',
			playerName: 'Cason Wallace',
			amount: parseMoney(3_000_000),
			isContentionEntry: false
		}
	],
	eligibleLeading: [],
	// "against its three free slots" — still free, and now deciding nothing.
	minorLeagueOccupied: 0
};

/** The fourth eligible Player's lottery, opened by another Team. */
const OPENING: Bid = {
	seq: '1',
	teamId: 't-other',
	teamName: 'Team Other',
	managerId: 'm-other',
	amount: parseMoney(MINIMUM_BID),
	occurredAt: '2026-08-24T09:00:00.000Z',
	closesAt: '2026-08-25T09:00:00.000Z',
	seedHash: 'b'.repeat(64)
};

const LOTTERY: Auction = {
	fantraxPlayerId: 'p-d',
	contention: 'minimum_bid',
	leadingBid: OPENING,
	closesAt: OPENING.closesAt,
	bids: [OPENING],
	contenders: [
		{
			seq: '1',
			teamId: 't-other',
			teamName: 'Team Other',
			managerId: 'm-other'
		}
	],
	seedHash: OPENING.seedHash,
	// The contention is LIVE: the seed is still sealed, so nothing is revealed.
	seed: null
};

const STATE: BidState = bidStateFor(LOTTERY, TEAM_Q, 'Auction');

const JOIN: PlaceBid = {
	kind: 'PlaceBid',
	fantraxPlayerId: 'p-d',
	teamId: 't-q',
	teamName: 'Team Q',
	managerId: 'm-q',
	amount: parseMoney(MINIMUM_BID)
};

describe('§10 example 22 — RETIRED: the lottery was already committed', () => {
	it('counts NO Eligible Leading Bids and NO overflow — M decides nothing', () => {
		const gates = evaluate(STATE, JOIN, NOW);

		expect(gates.cap.eligibleLeadingBids).toBe(0);
		// Three Minor League Slots, still free, still irrelevant.
		expect(gates.cap.freeMinorLeagueSlots).toBe(MINOR_LEAGUE_SLOTS);
		expect(gates.cap.overflowCount).toBe(0);
	});

	it('commits ALL THREE leads in full — $12,000,000, not $5,000,000', () => {
		const cap = evaluate(STATE, JOIN, NOW).cap;

		// The old figure summed the single largest amount that overflowed. All
		// three are committed now, unconditionally.
		expect(cap.minorsExposure).toBe(0);
		expect(cap.committedBids).toBe(12_000_000);
		// "With $0 Available Cap Space" — the example's own sentence, reached
		// by the ordinary subtraction.
		expect(cap.availableCapSpace).toBe(0);
		// Three projected additions against eleven held takes the Team past the
		// ceiling, so there is nothing left to reserve.
		expect(cap.rosterReserve).toBe(0);
		expect(cap.maximumBid).toBe(0);
		expect(cap.exposureIncludesThisBid).toBe(false);
	});

	it('REFUSES the join on money, with capacity still passing', () => {
		const gates = evaluate(STATE, JOIN, NOW);

		// The example's headline outcome, unchanged.
		expect(failedGates(gates)).toEqual(['cap']);
		expect(gates.cap.passed).toBe(false);
		expect(gates.cap.unbounded).toBe(false);
		// **The capacity gate passes on FR-18's landing test alone.** An entry
		// projects no Active/Bench addition and consumes no allowance, and
		// Roster Count 11 leaves one Free Active/Bench Slot for the win to land
		// in. Both overflow figures are now permanently zero.
		expect(gates.slots.passed).toBe(true);
		expect(gates.slots.isContentionEntry).toBe(true);
		expect(gates.slots.freeActiveBenchSlots).toBe(1);
		// Three standing leads project three additions; the ENTRY projects none,
		// which is the exemption doing its work. The entry branch decides the
		// verdict, so the 14 this would imply never reaches a comparison.
		expect(gates.slots.projectedAdditions).toBe(3);
		expect(gates.slots.eligibleLeadingBidsExcludingEntries).toBe(0);
		expect(gates.slots.activeBenchOverflow).toBe(0);
		expect(gates.cap.overflowCount).toBe(0);
		// And the contention gate is unmoved: it reads no Cap figure, so this
		// is still a join — refused on money, not misclassified.
		expect(gates.contention.entry).toBe('joins');
		expect(gates.contention.passed).toBe(true);
	});

	it('no longer names the Auction holding the money', () => {
		const gates = evaluate(STATE, JOIN, NOW);
		const detail = bidRefusalDetail({ kind: 'gates', gates });

		// `exposingBids` was the exposure set; there is no exposure.
		expect(gates.cap.exposingBids).toEqual([]);
		expect(detail).toContain('Maximum Bid');
		expect(detail).not.toContain('Ausar Thompson');
		expect(detail).not.toContain('Minors Exposure');
		expect(detail).not.toContain('Overflow Count');
		// The names are still held, which is what makes this a gap rather than
		// a loss of information.
		expect(TEAM_Q.leading.map((lead) => lead.playerName)).toContain('Ausar Thompson');
	});

	it('prints a breakdown that sums exactly as displayed', () => {
		const lines = capBreakdown(evaluate(STATE, JOIN, NOW).cap);
		const figureFor = (label: string) => lines.find((line) => line.label === label)?.figure;

		expect(figureFor('Cap Space')).toBe('$12.0M');
		expect(figureFor('Committed Bids')).toBe('$12.0M');
		// Vestigial, and now always zero.
		expect(figureFor('of which Minors Exposure')).toBe('$0.0M');
		expect(figureFor('Available Cap Space')).toBe('$0.0M');
		expect(figureFor('Roster Reserve')).toBe('$0.0M');
		// Never "no cap limit": nothing is unbounded any more.
		expect(figureFor('Maximum Bid')).toBe('$0.0M');
		expect(lines.map((line) => line.label)).not.toContain('Why there is no cap limit');
	});

	it('holds the flat $1,000,000 against a CONTENDER, not only the leader', () => {
		// Story 3.2's one change to `teamMoneyStateFor`, stated directly.
		// Team Q joined the lottery on `p-d`; Team Other still leads it. The
		// commitment is Team Q's all the same, because any Contender may win.
		const joined: Auction = {
			...LOTTERY,
			contenders: [
				...LOTTERY.contenders,
				{ seq: '2', teamId: 't-q', teamName: 'Team Q', managerId: 'm-q' }
			]
		};
		const money = teamMoneyStateFor({
			teamId: 't-q',
			// A different Auction, so the lottery counts as a commitment
			// elsewhere rather than being excluded as the one being bid on.
			fantraxPlayerId: 'p-elsewhere',
			capSpace: parseMoney(12_000_000),
			rosterCount: 11,
			minorLeagueOccupied: 0,
			auctions: { ...INITIAL_AUCTIONS, byPlayer: { 'p-d': joined } },
			playerNameFor: () => 'The Fourth Player'
		});

		expect(joined.leadingBid?.teamId).toBe('t-other');
		expect(money.leading).toEqual([
			{
				fantraxPlayerId: 'p-d',
				playerName: 'The Fourth Player',
				amount: MINIMUM_BID,
				// Still recorded, and still read by FR-18's capacity exemption.
				isContentionEntry: true
			}
		]);
		// Flat, never the leading amount — every Contender holds the same.
		expect(money.eligibleLeading).toEqual([]);
	});

	it('holds NOTHING for a Team that neither leads nor contends', () => {
		// The other half of the widened filter: it widened to Contenders, and
		// to nobody else.
		const money = teamMoneyStateFor({
			teamId: 't-nobody',
			fantraxPlayerId: 'p-elsewhere',
			capSpace: parseMoney(12_000_000),
			rosterCount: 11,
			minorLeagueOccupied: 0,
			auctions: { ...INITIAL_AUCTIONS, byPlayer: { 'p-d': LOTTERY } },
			playerNameFor: () => 'The Fourth Player'
		});

		expect(money.leading).toEqual([]);
		expect(money.eligibleLeading).toEqual([]);
	});
});
