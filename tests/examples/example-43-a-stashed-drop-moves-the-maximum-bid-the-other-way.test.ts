/**
 * PRD §10 example 43 — **A stashed Drop costs its whole salary** (FR-43),
 * amended 2026-09-23.
 *
 * Rewritten on 2026-09-18 to "a stashed Drop moves the Maximum Bid NOWHERE":
 * the stash was charging $0, so the Drop released nothing, removed the row and
 * left every figure where it was. **That rule was wrong for this League.** A
 * dropped minors Contract carries its salary as Dead Money like any other, and
 * the old reading fired once in production — Brooklyn dropped Koby Brea from a
 * Minor League Slot and the app removed his $1,000,000 row instead of charging
 * it.
 *
 * So Team L's stash, stated at $3,000,000 and charging $0 while stashed, stays
 * on the roster as $3,000,000 of Dead Money. Cap Space FALLS by that amount,
 * Roster Count does not move (a stash never counted toward it and Dead Money
 * does not either), and the Maximum Bid falls with Cap Space.
 *
 * **The example's point beside example 40 survives.** "A Drop lowers the
 * Maximum Bid by the $1,000,000 reserve" is still not a rule: example 40's
 * Active/Bench Drop costs exactly the reserve on the freed hole, while this
 * one costs the stash's whole salary and frees no Active/Bench Slot at all.
 *
 * **Everything still derives rather than being written.** `teamMoneyStateFor`
 * recomputes on every evaluation from the post-Drop rows; nothing is
 * recalculated, stored or invalidated anywhere.
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
import {
	teamMoneyStateFor,
	teamSolvencyFiguresFor,
	bidStateFor
} from '../../src/lib/core/rules/bidding.ts';
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
		// An ordinary imported Contract, with no rookie-scale designation.
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
		playerNameFor: (id: string) => id
	});
	const figures = teamSolvencyFiguresFor(
		bidStateFor(null, money, 'Auction'),
		'',
		parseMoney(0),
		true
	);
	if (figures === null) throw new Error('no Team');
	return figures;
}

describe('§10 example 43 — a stashed Drop costs its whole salary', () => {
	it('starts Team L at M = 1, Roster Count 10, Cap Space $20,000,000, nothing exposed', () => {
		const before = figuresOf(ROWS);

		// `M` is the FREE Minor League Slots: two of the three are occupied, so
		// exactly one stands free.
		expect(ROWS.filter((held) => held.rosterSlotKind === 'minor_league')).toHaveLength(2);
		expect(MINOR_LEAGUE_SLOTS - 2).toBe(1);
		expect(before.rosterCount).toBe(10);
		expect(before.capSpace).toBe(20_000_000);
		// Two leads and ONE free Minor League Slot: it absorbs neither, because
		// no win lands in one. Both commit in full, so what Team L has already
		// spent is the SUM rather than the largest that overflowed.
		expect(before.minorsExposure).toBe(0);
		expect(before.committedBids).toBe(BIG_LEAD + SMALL_LEAD);
		expect(before.availableCapSpace).toBe(20_000_000 - (BIG_LEAD + SMALL_LEAD));
	});

	it('commits, carries the full salary, and KEEPS the row as Dead Money', () => {
		const outcome = evaluateDrop(stateOf(ROWS), DROP);

		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;
		const release = outcome.delta.released[0];
		// It was charging $0 while stashed, and the Drop starts all of it.
		expect(release?.chargedCapHit).toBe(0);
		expect(release?.deadMoney).toBe(STASH_VALUE);
		expect(release?.removed).toBe(false);
		// The stated value survives on the record beside the charge (AD-23).
		expect(release?.value).toBe(STASH_VALUE);
	});

	it('lowers Cap Space by the salary and leaves Roster Count where it was', () => {
		const outcome = evaluateDrop(stateOf(ROWS), DROP);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		expect(outcome.delta.before.capSpace).toBe(20_000_000);
		expect(outcome.delta.after.capSpace).toBe(20_000_000 - STASH_VALUE);
		// A stash never counted against the twelve, so dropping it frees
		// nothing there — which is what separates this example from example 40.
		expect(outcome.delta.after.rosterCount).toBe(10);
		expect(outcome.delta.before.rosterCount).toBe(10);
	});

	it('raises M to 2, and the freed Minor League Slot buys nothing', () => {
		const outcome = evaluateDrop(stateOf(ROWS), DROP);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		expect(outcome.delta.before.minorLeagueOccupied).toBe(2);
		expect(outcome.delta.after.minorLeagueOccupied).toBe(1);
		// `M = MINOR_LEAGUE_SLOTS − occupied`, derived and never stored.
		expect(MINOR_LEAGUE_SLOTS - outcome.delta.after.minorLeagueOccupied).toBe(2);

		// **Overflow 0 on BOTH sides**, which is the difference from the old
		// example: it used to fall 1 → 0 and release $12,000,000 on the way.
		// There is nothing to overflow, before or after.
		expect(figuresOf(ROWS).overflowCount).toBe(0);
		expect(figuresOf(ROWS.filter((held) => held.fantraxPlayerId !== 'p-stash')).overflowCount).toBe(
			0
		);

		const gate = outcome.gates.cap;
		// The freed Slot buys nothing: both leads were committed in full before
		// the Drop and still are after it. Available Cap Space falls by the
		// salary alone.
		expect(gate.minorsExposure).toBe(0);
		expect(gate.committedBids).toBe(BIG_LEAD + SMALL_LEAD);
		expect(gate.availableCapSpace).toBe(20_000_000 - STASH_VALUE - (BIG_LEAD + SMALL_LEAD));
	});

	it('lowers the Maximum Bid by the whole salary, which is still not example 40', () => {
		const before = figuresOf(ROWS);
		const outcome = evaluateDrop(stateOf(ROWS), DROP);
		if (outcome.kind !== 'permitted') throw new Error('refused');
		const after = outcome.gates.cap;

		// Cap Space falls by the salary and nothing offsets it: the leads were
		// always committed in full, and no Active/Bench Slot was freed, so the
		// reserve does not move.
		expect(after.minorsExposure).toBe(before.minorsExposure);
		expect(after.committedBids).toBe(before.committedBids);
		expect(after.rosterReserve).toBe(before.rosterReserve);
		expect(after.rosterCount).toBe(before.rosterCount);
		expect(before.capSpace - after.capSpace).toBe(STASH_VALUE);
		expect(before.maximumBid - after.maximumBid).toBe(STASH_VALUE);

		// **The pair with example 40 still holds**: that Drop costs exactly the
		// $1,000,000 reserve on a freed hole, and this one costs a salary and
		// frees no hole — so "a Drop lowers the Maximum Bid by the reserve" is
		// still not a rule.
		expect(before.maximumBid - after.maximumBid).not.toBe(1_000_000);
	});
});
