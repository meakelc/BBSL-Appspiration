/**
 * PRD §10 example 45 — **The Move that buys bidding power by spending cap**
 * (FR-44).
 *
 * > Team L holds two of its three Minor League Slots (`M = 1`), has Roster
 * > Count 10 and Cap Space $20,000,000, and leads two **eligible** Auctions at
 * > $12,000,000 and $4,000,000. Today: `N = 2, M = 1`, Overflow Count 1,
 * > **Minors Exposure $12,000,000**, Available Cap Space $8,000,000; Projected
 * > Active/Bench Additions is `1` for the Bid being placed plus `1` of
 * > Active/Bench Overflow, so Roster Reserve is `$0` and **Maximum Bid is
 * > $8,000,000**. It now **demotes** one stash — full value $2,000,000 — to
 * > an Active/Bench Slot. Minor League occupancy falls to 1, so `M = 2`;
 * > `N = 2 ≤ M = 2`, Overflow Count falls to **0** and **Minors Exposure falls
 * > to $0**. But the demoted Contract now charges, so **Cap Space falls to
 * > $18,000,000**. Roster Count rises to 11, so Roster Reserve becomes `$0`,
 * > and **Maximum Bid is $18,000,000**. The Team **spent $2,000,000 of Cap
 * > Space and gained $10,000,000 of Maximum Bid.**
 *
 * *(Quoted as CORRECTED on 2026-09-12 by this story. The PRD's before figure
 * previously read $7,000,000 and its gain $11,000,000, omitting Active/Bench
 * Overflow from Projected Additions in the before state only. See the note on
 * the Roster Count assertion below.)*
 *
 * **It is the mirror of example 40, and that is the test.** Every intuition
 * says putting a Player on the active roster costs you money; here it buys
 * bidding power, because an empty Minor League Slot is what Minors Exposure
 * reserves against. A sheet that asserted "a demotion costs you" would be
 * wrong for exactly this act — which is why `maximumBidDirectionSentence`
 * COMPUTES the direction from the figures run over the before state and again
 * over the after, and why the sentence is asserted here rather than taken on
 * trust.
 *
 * **Nothing below is recomputed by this file.** `evaluateRearrange` runs the
 * shared derivations a Bid is judged by; the two `ActCapGateOutcome`s it
 * returns are what the assertions read.
 *
 * Driven through the `RearrangeRoster` command itself.
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

describe('§10 example 45 — the Move that buys bidding power by spending cap', () => {
	it('starts Team L at M = 1, Roster Count 10, Cap Space $20,000,000 and Maximum Bid $7,000,000', () => {
		const outcome = evaluateRearrange(STATE, DEMOTION);
		if (outcome.kind !== 'permitted') throw new Error('refused');
		const before = outcome.capBefore;

		expect(outcome.delta.before.minorLeagueOccupied).toBe(2);
		expect(MINOR_LEAGUE_SLOTS - 2).toBe(1);
		expect(outcome.delta.before.rosterCount).toBe(10);
		expect(outcome.delta.before.capSpace).toBe(20_000_000);
		// Two eligible leads and ONE free Minor League Slot: it absorbs one of
		// them, and the largest that cannot be absorbed is the $12,000,000.
		expect(before.minorsExposure).toBe(BIG_LEAD);
		expect(before.availableCapSpace).toBe(20_000_000 - BIG_LEAD);
		expect(before.rosterReserve).toBe(1_000_000);
		expect(before.maximumBid).toBe(7_000_000);
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

	it('frees a Minor League Slot, so Minors Exposure falls to $0', () => {
		const outcome = evaluateRearrange(STATE, DEMOTION);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		expect(outcome.delta.after.minorLeagueOccupied).toBe(1);
		// `M = MINOR_LEAGUE_SLOTS − occupied`, derived and never stored: two
		// free Slots absorb both eligible leads.
		expect(MINOR_LEAGUE_SLOTS - outcome.delta.after.minorLeagueOccupied).toBe(2);
		expect(outcome.gates.cap.minorsExposure).toBe(0);
		expect(outcome.gates.cap.availableCapSpace).toBe(18_000_000);
	});

	it('raises Roster Count to 11, and the Roster Reserve is the shared evaluator’s', () => {
		const outcome = evaluateRearrange(STATE, DEMOTION);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		expect(outcome.delta.after.rosterCount).toBe(11);

		// **Two Maximum Bids, and the example is stated in the second one.**
		//
		// `evaluateActCap` calls `teamSolvencyFiguresFor` with
		// `prospectiveBidIsExempt: true`, so it projects NO prospective Bid — a
		// roster act places none, and `false` would refuse §10 example 39's
		// Team F over an addition nobody asked for. What it DOES count is
		// Active/Bench Overflow:
		//
		//   before: rosterCount 10 + overflow 1 = 11 → reserve $1,000,000
		//   after:  rosterCount 11 + overflow 0 = 11 → reserve $1,000,000
		//
		// That is the right question for a GATE, whose verdict is only
		// `maximumBid >= 0`, and it leaves a headroom of $17,000,000.
		//
		// It is NOT the figure a Manager knows as Maximum Bid. FR-12 and the §3
		// glossary count the Bid being placed, which is `12 − 11` before and
		// `12 − 12` after — the PRD's own model, reaching $18,000,000.
		// `managerMaximumBidFor` asks for exactly that, and it is what the sheet
		// quotes. The two coincide BEFORE the act and differ by one Slot's
		// reserve after, which is precisely how a stale reading hides.
		expect(outcome.gates.cap.rosterReserve).toBe(1_000_000);
		expect(outcome.gates.cap.maximumBid).toBe(17_000_000);
		expect(outcome.maximumBid.after).toBe(18_000_000);
	});

	it('spends Cap Space and RAISES the Maximum Bid — the direction is COMPUTED, in words', () => {
		const outcome = evaluateRearrange(STATE, DEMOTION);
		if (outcome.kind !== 'permitted') throw new Error('refused');
		const { capBefore, gates, delta, maximumBid } = outcome;

		// **The claim the example exists to make, and it holds exactly.** The
		// Team spent $2,000,000 of Cap Space and ended RICHER at the bidding
		// table, because an empty Minor League Slot is what Minors Exposure
		// reserves against. Every intuition says the opposite.
		expect(delta.before.capSpace - delta.after.capSpace).toBe(2_000_000);
		expect(maximumBid.after).toBeGreaterThan(maximumBid.before);

		// **$8,000,000 to $18,000,000 — and the PRD's $7,000,000 is a slip.**
		//
		// The PRD reaches its before figure with `12 − 11`, calling the 1
		// "bidding once" — the prospective Bid, and NO Active/Bench Overflow
		// term. But Team L holds two eligible leads against one free Minor
		// League Slot, so one of them WILL land in Active/Bench: overflow is 1,
		// and Story 2.8 made counting it the rule (§10 example 25). Projected
		// Additions before the Move is therefore 2, not 1, the reserve is $0
		// rather than $1,000,000, and Maximum Bid is $8,000,000.
		//
		// The PRD's AFTER figure omits nothing, because overflow is 0 once the
		// second Slot frees — which is why only the before figure is wrong, and
		// why its stated gain of $11,000,000 is a model mixed halfway through.
		// Both self-consistent readings put the gain at $10,000,000: the gate's
		// $7,000,000 → $17,000,000 and the Manager's $8,000,000 → $18,000,000.
		expect(maximumBid.before).toBe(8_000_000);
		expect(maximumBid.after).toBe(18_000_000);

		// The gain, stated as arithmetic rather than as a literal: $12,000,000
		// of Minors Exposure released against $2,000,000 of Cap Space spent.
		expect(capBefore.minorsExposure - gates.cap.minorsExposure).toBe(BIG_LEAD);
		expect(maximumBid.after - maximumBid.before).toBe(BIG_LEAD - 2_000_000);

		// **The sentence FR-44 requires before commit.** It says ROSE, and it
		// says by how much — and it computed both from two calls of one
		// expression rather than asserting a direction.
		const sentence = maximumBidDirectionSentence(capBefore, gates.cap, maximumBid);
		expect(sentence).toContain('ROSE');
		expect(sentence).toContain('$10.0M');
		expect(sentence).not.toContain('FELL');
		// It states the Cap Space fall in the same breath, so nobody reads the
		// rise as free money.
		expect(sentence).toContain('$20.0M');
		expect(sentence).toContain('$18.0M');
	});

	it('states FELL for the mirror act, so the sentence is not a constant', () => {
		// Promoting the demoted Contract back is the same act reversed, and the
		// same computation must word it the other way. If the sentence were a
		// flat rule, this is the case that would expose it.
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
			{ ...DEMOTION, moves: [{ fantraxPlayerId: 'p-stash', toPlacement: 'minor_league' }] }
		);
		expect(back.kind).toBe('permitted');
		if (back.kind !== 'permitted') return;

		const sentence = maximumBidDirectionSentence(back.capBefore, back.gates.cap, back.maximumBid);
		expect(sentence).toContain('FELL');
		// The mirror of the demotion, to the dollar: the same $10,000,000 back.
		expect(sentence).toContain('$10.0M');
		expect(back.maximumBid.before - back.maximumBid.after).toBe(BIG_LEAD - 2_000_000);
		// And the roster returns to exactly where it started.
		expect(back.delta.after.capSpace).toBe(20_000_000);
		expect(back.delta.after.rosterCount).toBe(10);
		expect(back.delta.after.minorLeagueOccupied).toBe(2);
	});
});
