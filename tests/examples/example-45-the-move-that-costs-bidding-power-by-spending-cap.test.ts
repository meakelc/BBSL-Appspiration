/**
 * PRD §10 example 45 — **The Move that costs bidding power by spending cap**
 * (FR-44), rewritten on 2026-09-18.
 *
 * The example used to read:
 *
 * > […] It now **demotes** one stash — full value $2,000,000 — to an
 * > Active/Bench Slot. Minor League occupancy falls to 1, so `M = 2`;
 * > `N = 2 ≤ M = 2`, Overflow Count falls to **0** and **Minors Exposure falls
 * > to $0**. But the demoted Contract now charges, so **Cap Space falls to
 * > $18,000,000**. […] The Team **spent $2,000,000 of Cap Space and gained
 * > $10,000,000 of Maximum Bid.**
 *
 * **The gain is gone, and the direction reverses.** A Team cannot win a Free
 * Agent straight into its minors, so Team L's two leads commit their full
 * $16,000,000 whatever its Minor League occupancy. Freeing a Slot releases
 * nothing, and the demoted Contract still starts charging — so the Move costs
 * $2,000,000 of Cap Space and $2,000,000 of Maximum Bid, which is what
 * everyone's intuition said in the first place.
 *
 * **What the example is FOR survives intact, and it is not the gain.** It
 * exists so `maximumBidDirectionSentence` cannot be a constant: the direction
 * has to be COMPUTED from the figures run over the before state and again over
 * the after. The demotion now says FELL and the promotion back says ROSE, so
 * the two acts still word it oppositely and a flat rule in either direction
 * still fails here. Only the sign changed.
 *
 * **And there is still a Move that buys bidding power — the other one.**
 * Promoting a Contract INTO a Minor League Slot takes its Cap Hit to $0 under
 * FR-44, which frees real money and raises the Maximum Bid. That is the mirror
 * test at the foot of this file, and it is now the interesting half: stashing
 * buys bidding power by NOT spending cap, rather than by releasing an exposure
 * that never existed.
 *
 * **The PRD's $7,000,000-vs-$8,000,000 correction is moot.** It turned on
 * whether Active/Bench Overflow belonged in Projected Additions in the before
 * state. There is no overflow in either state now, so both readings collapse
 * onto one figure and the discrepancy has nothing left to be about.
 */

import { describe, expect, it } from 'vitest';

import { MINOR_LEAGUE_SLOTS, SALARY_CAP } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { INITIAL_NOMINATIONS } from '../../src/lib/core/projection/nominations.ts';
import type { Auction, OpenAuctions } from '../../src/lib/core/projection/auctions.ts';
import {
	evaluateRearrange,
	maximumBidDirectionSentence
} from '../../src/lib/core/rules/roster-rearrange.ts';
import type {
	RearrangingPlayer,
	RosterRearrangeState
} from '../../src/lib/core/rules/roster-rearrange.ts';
import type { RearrangeRoster } from '../../src/lib/core/types.ts';

const CLOSES_AT = '2026-09-12T09:00:00.000Z';

/** The stash Team L demotes. Charging $0 today; worth $2,000,000. */
const STASH_VALUE = 2_000_000;

/** The two eligible Auctions Team L leads. */
const BIG_LEAD = 12_000_000;
const SMALL_LEAD = 4_000_000;

function row(
	id: string,
	name: string,
	kind: RearrangingPlayer['rosterSlotKind'],
	value: number
): RearrangingPlayer {
	return {
		fantraxPlayerId: id,
		playerName: name,
		rosterSlotKind: kind,
		value: parseMoney(value),
		won: false
	};
}

/**
 * Team L: ten Active/Bench Contracts summing to `SALARY_CAP − $20,000,000`,
 * so Cap Space stands at exactly $20,000,000 — and two stashes, so one Minor
 * League Slot stands free and `M = 1`, the figure the example names.
 */
const ACTIVE_TOTAL = SALARY_CAP - 20_000_000;

const ROWS: readonly RearrangingPlayer[] = [
	...Array.from({ length: 9 }, (_unused, index) =>
		row(`p-a-${String(index)}`, `Active ${String(index)}`, 'active_bench', 15_000_000)
	),
	row('p-a-9', 'Active 9', 'active_bench', ACTIVE_TOTAL - 9 * 15_000_000),
	row('p-stash', 'Stashed Player', 'minor_league', STASH_VALUE),
	row('p-stash-2', 'Other Stash', 'minor_league', 3_000_000)
];

function auctionOf(fantraxPlayerId: string, amount: number): Auction {
	return {
		fantraxPlayerId,
		contention: 'standard',
		leadingBid: {
			seq: '10',
			teamId: 't-l',
			teamName: 'Team L',
			managerId: 'm-l',
			amount: parseMoney(amount),
			occurredAt: '2026-09-11T09:00:00.000Z',
			closesAt: CLOSES_AT,
			seedHash: null
		},
		closesAt: CLOSES_AT,
		bids: [],
		contenders: [],
		seedHash: null,
		seed: null
	};
}

const AUCTIONS: OpenAuctions = {
	byPlayer: {
		'p-big': auctionOf('p-big', BIG_LEAD),
		'p-small': auctionOf('p-small', SMALL_LEAD)
	}
};

const STATE: RosterRearrangeState = {
	team: { teamId: 't-l', teamName: 'Team L', rows: ROWS },
	auctions: AUCTIONS,
	nominations: INITIAL_NOMINATIONS,
	// Both leads are on Minor-League-eligible Players, which is what makes
	// them absorbable and therefore what makes Minors Exposure a question.
	// **This is the POOL FLAG, and it is not what decides placement.**
	isMinorLeagueEligible: (id) => id === 'p-big' || id === 'p-small',
	// A demotion consults nothing, so the observation fold can say `false`
	// about everything and the act still stands.
	hasEverOccupiedMinorLeague: () => false,
	playerNameFor: (id) => id
};

const DEMOTION: RearrangeRoster = {
	kind: 'RearrangeRoster',
	teamId: 't-l',
	teamName: 'Team L',
	moves: [{ fantraxPlayerId: 'p-stash', toPlacement: 'active_bench' }],
	reason: null
};

describe('§10 example 45 — the Move that costs bidding power by spending cap', () => {
	it('starts Team L at M = 1, Roster Count 10, Cap Space $20,000,000 and Maximum Bid $4,000,000', () => {
		const outcome = evaluateRearrange(STATE, DEMOTION);
		if (outcome.kind !== 'permitted') throw new Error('refused');
		const before = outcome.capBefore;

		expect(outcome.delta.before.minorLeagueOccupied).toBe(2);
		expect(MINOR_LEAGUE_SLOTS - 2).toBe(1);
		expect(outcome.delta.before.rosterCount).toBe(10);
		expect(outcome.delta.before.capSpace).toBe(20_000_000);
		// Two leads and ONE free Minor League Slot: it absorbs neither, so
		// both commit in full and nothing is exposed.
		expect(before.minorsExposure).toBe(0);
		expect(before.committedBids).toBe(BIG_LEAD + SMALL_LEAD);
		expect(before.availableCapSpace).toBe(20_000_000 - (BIG_LEAD + SMALL_LEAD));
		// Two leads project two additions against ten held, which reaches the
		// ceiling exactly — so there is nothing left to reserve.
		expect(before.rosterReserve).toBe(0);
		expect(before.maximumBid).toBe(4_000_000);
	});

	it('spends $2,000,000 of Cap Space: the demoted Contract starts charging', () => {
		const outcome = evaluateRearrange(STATE, DEMOTION);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		expect(outcome.delta.after.capSpace).toBe(18_000_000);
		expect(outcome.delta.before.capSpace - outcome.delta.after.capSpace).toBe(STASH_VALUE);
		// The Contract's value never changed — only what it charges.
		const move = outcome.delta.moves[0];
		expect(move?.capHitBefore).toBe(0);
		expect(move?.capHitAfter).toBe(STASH_VALUE);
		expect(move?.value).toBe(STASH_VALUE);
	});

	it('frees a Minor League Slot that buys nothing at all', () => {
		const outcome = evaluateRearrange(STATE, DEMOTION);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		expect(outcome.delta.after.minorLeagueOccupied).toBe(1);
		// `M = MINOR_LEAGUE_SLOTS − occupied`, derived and never stored — and
		// now decisive of nothing: two free Slots absorb no lead, because no
		// win lands in one.
		expect(MINOR_LEAGUE_SLOTS - outcome.delta.after.minorLeagueOccupied).toBe(2);
		// Zero before and zero after, so the freed Slot released no money.
		expect(outcome.capBefore.minorsExposure).toBe(0);
		expect(outcome.gates.cap.minorsExposure).toBe(0);
		expect(outcome.gates.cap.committedBids).toBe(BIG_LEAD + SMALL_LEAD);
		// Available Cap Space fell by exactly what the Contract now charges.
		expect(outcome.gates.cap.availableCapSpace).toBe(18_000_000 - (BIG_LEAD + SMALL_LEAD));
	});

	it('raises Roster Count to 11, and the Roster Reserve is the shared evaluator’s', () => {
		const outcome = evaluateRearrange(STATE, DEMOTION);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		expect(outcome.delta.after.rosterCount).toBe(11);

		// **Two Maximum Bids, and they now AGREE — which is itself the
		// finding.**
		//
		// `evaluateActCap` calls `teamSolvencyFiguresFor` with
		// `prospectiveBidIsExempt: true`, so it projects NO prospective Bid — a
		// roster act places none, and `false` would refuse §10 example 39's
		// Team F over an addition nobody asked for. `managerMaximumBidFor` asks
		// the other question, counting the Bid being placed, which is what FR-12
		// and the §3 glossary define and what the sheet quotes.
		//
		// The two used to differ by one Slot's reserve after the act. Both
		// reserves are $0 here — two committed leads against eleven held is
		// already at the ceiling, with or without a prospective Bid — so the
		// figures coincide. They are still two calls of two expressions, and
		// the assertions below keep both named so a future divergence surfaces
		// rather than hiding behind one number.
		expect(outcome.gates.cap.rosterReserve).toBe(0);
		expect(outcome.gates.cap.maximumBid).toBe(2_000_000);
		expect(outcome.maximumBid.after).toBe(2_000_000);
	});

	it('spends Cap Space and LOWERS the Maximum Bid — the direction is COMPUTED, in words', () => {
		const outcome = evaluateRearrange(STATE, DEMOTION);
		if (outcome.kind !== 'permitted') throw new Error('refused');
		const { capBefore, gates, delta, maximumBid } = outcome;

		// **The claim, inverted.** The Team spent $2,000,000 of Cap Space and
		// ended POORER at the bidding table by exactly that — there is no
		// exposure for an emptied Minor League Slot to release, so the only
		// figure that moved is the Cap Hit the demoted Contract started
		// charging.
		expect(delta.before.capSpace - delta.after.capSpace).toBe(2_000_000);
		expect(maximumBid.after).toBeLessThan(maximumBid.before);

		expect(maximumBid.before).toBe(4_000_000);
		expect(maximumBid.after).toBe(2_000_000);

		// The loss, stated as arithmetic rather than as a literal: no exposure
		// released, against $2,000,000 of Cap Space spent.
		expect(capBefore.minorsExposure - gates.cap.minorsExposure).toBe(0);
		expect(maximumBid.before - maximumBid.after).toBe(2_000_000);

		// **The sentence FR-44 requires before commit.** It says FELL, and it
		// says by how much — and it computed both from two calls of one
		// expression rather than asserting a direction.
		const sentence = maximumBidDirectionSentence(capBefore, gates.cap, maximumBid);
		expect(sentence).toContain('FELL');
		expect(sentence).toContain('$2.0M');
		expect(sentence).not.toContain('ROSE');
		// It states the Cap Space fall in the same breath.
		expect(sentence).toContain('$20.0M');
		expect(sentence).toContain('$18.0M');
	});

	it('states ROSE for the mirror act — stashing is what buys bidding power', () => {
		// Promoting the demoted Contract back is the same act reversed, and the
		// same computation must word it the other way. If the sentence were a
		// flat rule, this is the case that would expose it.
		//
		// It is also the interesting half now: moving a Contract INTO a Minor
		// League Slot takes its Cap Hit to $0 under FR-44, which frees real
		// money rather than releasing an exposure. THAT is the Move that buys
		// bidding power, and it buys it by not spending cap.
		const demoted = evaluateRearrange(STATE, DEMOTION);
		if (demoted.kind !== 'permitted') throw new Error('refused');

		const after: readonly RearrangingPlayer[] = ROWS.map((held) =>
			held.fantraxPlayerId === 'p-stash'
				? { ...held, rosterSlotKind: 'active_bench' as const }
				: held
		);
		const back = evaluateRearrange(
			{
				...STATE,
				team: { teamId: 't-l', teamName: 'Team L', rows: after },
				// He has been observed in a Minor League Slot — this Move is what
				// observed him — so the promotion back is permitted. §10 example
				// 46's round trip is the same fact reached from the log.
				hasEverOccupiedMinorLeague: (id) => id === 'p-stash'
			},
			{
				...DEMOTION,
				moves: [{ fantraxPlayerId: 'p-stash', toPlacement: 'minor_league' }]
			}
		);
		expect(back.kind).toBe('permitted');
		if (back.kind !== 'permitted') return;

		const sentence = maximumBidDirectionSentence(back.capBefore, back.gates.cap, back.maximumBid);
		expect(sentence).toContain('ROSE');
		expect(sentence).not.toContain('FELL');
		// The mirror of the demotion, to the dollar: the same $2,000,000 back.
		expect(sentence).toContain('$2.0M');
		expect(back.maximumBid.after - back.maximumBid.before).toBe(2_000_000);
		// And the roster returns to exactly where it started.
		expect(back.delta.after.capSpace).toBe(20_000_000);
		expect(back.delta.after.rosterCount).toBe(10);
		expect(back.delta.after.minorLeagueOccupied).toBe(2);
	});
});
