/**
 * PRD §10 example 43 — **A stashed Drop moves the Maximum Bid the other way**
 * (FR-43).
 *
 * > Team L occupies one Minor League Slot (`M` = 1), has Roster Count 10 and
 * > Cap Space $20,000,000, and leads two eligible Auctions at $12,000,000 and
 * > $4,000,000 — so Minors Exposure is the largest of them that `M` cannot
 * > absorb, $12,000,000. It drops the stashed Player. Afterwards: nothing is
 * > carried, because a Minor League row was charging $0; the row is
 * > **removed**; Cap Space is unchanged at $20,000,000; Roster Count is
 * > unchanged at 10, because a stash never counted against the twelve; `M`
 * > rises to 2, Overflow falls to 0, **Minors Exposure falls to $0** and
 * > Available Cap Space is the full $20,000,000.
 *
 * **It is the opposite of example 40, from the same act, and that is the
 * test.** Example 40's Active/Bench Drop frees a Roster Slot that costs
 * $1,000,000 to reserve, so the Team ends POORER at the bidding table. This
 * Drop frees a Minor League Slot, which absorbs an eligible lead that was
 * being counted in full against the Cap — so the Team ends RICHER, by
 * $12,000,000, having released not one dollar. A flat "a Drop lowers the
 * Maximum Bid" rule computes this example wrongly, which is why the two
 * examples have to be run side by side.
 *
 * **Minors Exposure recomputes by derivation, not by writing.**
 * `teamMoneyStateFor` derives it on every evaluation from the post-Drop
 * occupancy; nothing is recalculated, stored or invalidated anywhere, and
 * this file asserts the figure that falls out rather than a figure anybody
 * set.
 *
 * Driven through the `RecordDrop` command itself (Story 7.8) — `evaluateDrop`
 * applies the act and hands the resulting state to the same derivations the
 * bidding gates read, so the figures below are the ones a real Drop would be
 * judged against.
 */

import { describe, expect, it } from 'vitest';

import { MINOR_LEAGUE_SLOTS, SALARY_CAP } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { INITIAL_NOMINATIONS } from '../../src/lib/core/projection/nominations.ts';
import type { Auction, OpenAuctions } from '../../src/lib/core/projection/auctions.ts';
import { teamMoneyStateFor, teamSolvencyFiguresFor, bidStateFor } from '../../src/lib/core/rules/bidding.ts';
import { evaluateDrop } from '../../src/lib/core/rules/roster-drop.ts';
import type { DroppablePlayer, RosterDropState } from '../../src/lib/core/rules/roster-drop.ts';
import type { RecordDrop } from '../../src/lib/core/types.ts';

const CLOSES_AT = '2026-09-12T09:00:00.000Z';

/** The stashed Contract Team L drops. Charged $0; stated at $3,000,000. */
const STASH_VALUE = 3_000_000;

/** The two eligible Auctions Team L leads. */
const BIG_LEAD = 12_000_000;
const SMALL_LEAD = 4_000_000;

/**
 * Ten Active/Bench Contracts summing to $145,000,000, so that Cap Space
 * stands at exactly $20,000,000 — a Minor League row charges nothing, so the
 * stash contributes no part of it.
 */
function row(
	id: string,
	name: string,
	kind: DroppablePlayer['rosterSlotKind'],
	value: number
): DroppablePlayer {
	return {
		fantraxPlayerId: id,
		playerName: name,
		rosterSlotKind: kind,
		value: parseMoney(value),
		won: false,
		// An ordinary imported Contract: no rookie-scale designation, so FR-43's
		// exception does not apply — and it does not need to, because a Minor
		// League row leaves nothing behind by the ordinary rule.
		contractYearsRemaining: 2,
		rookieScaleRound: null
	};
}

const TEN_ACTIVE: readonly DroppablePlayer[] = [
	...Array.from({ length: 9 }, (_unused, index) =>
		row(`p-a-${String(index)}`, `Active ${String(index)}`, 'active_bench', 15_000_000)
	),
	row('p-a-9', 'Active 9', 'active_bench', 10_000_000)
];

/**
 * Team L's roster: ten Active/Bench Contracts and TWO stashes, so exactly one
 * Minor League Slot stands free — `M` = 1, which is the figure the example
 * names. Dropping one stash takes `M` to 2.
 */
const ROWS: readonly DroppablePlayer[] = [
	...TEN_ACTIVE,
	row('p-stash', 'Stashed Player', 'minor_league', STASH_VALUE),
	row('p-stash-2', 'Other Stash', 'minor_league', STASH_VALUE)
];

/** Team L leads two open Auctions on Minor-League-eligible Players. */
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

function stateOf(rows: readonly DroppablePlayer[]): RosterDropState {
	return {
		team: { teamId: 't-l', teamName: 'Team L', rows },
		auctions: AUCTIONS,
		nominations: INITIAL_NOMINATIONS,
		// Both leads are on Minor-League-eligible Players, which is what makes
		// them absorbable and therefore what makes Minors Exposure a question.
		isMinorLeagueEligible: (id) => id === 'p-big' || id === 'p-small',
		playerNameFor: (id) => id
	};
}

const DROP: RecordDrop = {
	kind: 'RecordDrop',
	teamId: 't-l',
	teamName: 'Team L',
	fantraxPlayerIds: ['p-stash'],
	reason: 'Released in Fantrax on the 11th.'
};

/** The five figures a Team stands on, derived exactly as a gate derives them. */
function figuresOf(rows: readonly DroppablePlayer[]) {
	const minorLeagueOccupied = rows.filter((held) => held.rosterSlotKind === 'minor_league').length;
	const money = teamMoneyStateFor({
		teamId: 't-l',
		fantraxPlayerId: '',
		capSpace: parseMoney(
			SALARY_CAP -
				rows
					.filter((held) => held.rosterSlotKind !== 'minor_league')
					.reduce((total, held) => total + held.value, 0)
		),
		rosterCount: rows.filter((held) => held.rosterSlotKind === 'active_bench').length,
		minorLeagueOccupied,
		auctions: AUCTIONS,
		isMinorLeagueEligible: (id) => id === 'p-big' || id === 'p-small',
		playerNameFor: (id) => id
	});
	const figures = teamSolvencyFiguresFor(
		bidStateFor(null, money, false, 'Auction'),
		'',
		parseMoney(0),
		true
	);
	if (figures === null) throw new Error('no Team');
	return figures;
}

describe('§10 example 43 — a stashed Drop moves the Maximum Bid the other way', () => {
	it('starts Team L at M = 1, Roster Count 10, Cap Space $20,000,000, Minors Exposure $12,000,000', () => {
		const before = figuresOf(ROWS);

		// `M` is the FREE Minor League Slots: two of the three are occupied, so
		// exactly one stands free.
		expect(ROWS.filter((held) => held.rosterSlotKind === 'minor_league')).toHaveLength(2);
		expect(MINOR_LEAGUE_SLOTS - 2).toBe(1);
		expect(before.rosterCount).toBe(10);
		expect(before.capSpace).toBe(20_000_000);
		// Two eligible leads and ONE free Minor League Slot: it absorbs one of
		// them, and the largest that cannot be absorbed is the $12,000,000.
		expect(before.minorsExposure).toBe(BIG_LEAD);
		expect(before.availableCapSpace).toBe(20_000_000 - BIG_LEAD);
	});

	it('commits, carries nothing, and REMOVES the row', () => {
		const outcome = evaluateDrop(stateOf(ROWS), DROP);

		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;
		const release = outcome.delta.released[0];
		// It was charging $0, so there is nothing to carry — and the row is
		// removed because the amount is $0, by the same expression that keeps
		// an Active/Bench row.
		expect(release?.chargedCapHit).toBe(0);
		expect(release?.deadMoney).toBe(0);
		expect(release?.removed).toBe(true);
		// The stated value survives on the record beside the charge (AD-23).
		expect(release?.value).toBe(STASH_VALUE);
	});

	it('leaves Cap Space and Roster Count exactly where they were', () => {
		const outcome = evaluateDrop(stateOf(ROWS), DROP);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		expect(outcome.delta.after.capSpace).toBe(20_000_000);
		expect(outcome.delta.before.capSpace).toBe(20_000_000);
		// A stash never counted against the twelve, so dropping it frees
		// nothing there — which is the whole reason this example moves the
		// opposite way from example 40.
		expect(outcome.delta.after.rosterCount).toBe(10);
		expect(outcome.delta.before.rosterCount).toBe(10);
	});

	it('raises M to 2, drops Overflow to 0 and Minors Exposure to $0', () => {
		const outcome = evaluateDrop(stateOf(ROWS), DROP);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		expect(outcome.delta.before.minorLeagueOccupied).toBe(2);
		expect(outcome.delta.after.minorLeagueOccupied).toBe(1);
		// `M = MINOR_LEAGUE_SLOTS − occupied`, derived and never stored.
		expect(MINOR_LEAGUE_SLOTS - outcome.delta.after.minorLeagueOccupied).toBe(2);

		// **Overflow 0**, the figure the matrix pins beside `M`→2. It is the
		// count of eligible leads the free Minor League Slots cannot absorb:
		// one before the Drop (two leads, one free Slot) and none after it.
		expect(figuresOf(ROWS).overflowCount).toBe(1);
		expect(figuresOf(ROWS.filter((held) => held.fantraxPlayerId !== 'p-stash')).overflowCount).toBe(
			0
		);

		const gate = outcome.gates.cap;
		// Two free Minor League Slots absorb both eligible leads, so nothing is
		// exposed at all.
		expect(gate.minorsExposure).toBe(0);
		expect(gate.availableCapSpace).toBe(20_000_000);
	});

	it('moves the Maximum Bid UP, which is the opposite of example 40', () => {
		const before = figuresOf(ROWS);
		const outcome = evaluateDrop(stateOf(ROWS), DROP);
		if (outcome.kind !== 'permitted') throw new Error('refused');
		const after = outcome.gates.cap;

		// **The gain, stated as the arithmetic rather than as one literal.**
		// $12,000,000 of Minors Exposure is released, because the freed Minor
		// League Slot absorbs the lead that was being counted in full — and
		// $1,000,000 goes back into Roster Reserve, because that lead had been
		// projecting as an Active/Bench addition and no longer does. The Team
		// ends $11,000,000 richer at the bidding table having released nothing.
		expect(before.minorsExposure - after.minorsExposure).toBe(BIG_LEAD);
		expect(after.rosterReserve - before.rosterReserve).toBe(1_000_000);
		expect(after.maximumBid - before.maximumBid).toBe(BIG_LEAD - 1_000_000);
		expect(after.maximumBid).toBeGreaterThan(before.maximumBid);
		// Not one dollar was released, and Roster Count did not move — so
		// neither the Cap nor the Slot arithmetic explains the gain. The Minor
		// League Slot does.
		expect(after.capSpace).toBe(before.capSpace);
		expect(after.rosterCount).toBe(before.rosterCount);
	});
});
