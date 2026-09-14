/**
 * PRD §10 example 40 — **A Drop lowers the Maximum Bid** (FR-43).
 *
 * > Team H has Roster Count 10, Cap Space $5,000,000, and leads nothing;
 * > bidding once, Roster Reserve is $1,000,000 × max(0, 12 − 11) = $1,000,000
 * > and **Maximum Bid is $4,000,000**. It drops a Player whose Cap Hit is
 * > $2,000,000. Afterwards: Roster Count 9, and Cap Space **still
 * > $5,000,000** — the $2,000,000 is now Dead Money and charges exactly as it
 * > did before (FR-43). Roster Reserve becomes $1,000,000 × max(0, 12 − 10) =
 * > $2,000,000, so **Maximum Bid falls to $3,000,000**. The Team gained a
 * > Roster Slot, released no money, and lost $1,000,000 of bidding power.
 *
 * **The counter-intuitive half is the whole point.** Every Manager's
 * intuition says a drop frees cap; in this league it frees a *Slot*, and a
 * free Slot costs $1,000,000 to reserve, so the Team ends the act poorer at
 * the bidding table than it began. FR-43 requires the reason sheet to say so
 * before the act commits, which is why the arithmetic has to be right here
 * first.
 *
 * **Altitude — a stated assumption (Story 7.6).** The example describes a
 * Drop, and the Commissioner Drop command is Story 7.8. What is encoded here
 * is the post-drop roster STATE, constructed directly in the fixture exactly
 * as every other file in this directory constructs its state, and the figures
 * the core derives from it. 7.8 drives the same assertions through the
 * command. What 7.6 delivers, and what this file and its sibling for example
 * 41 exist to prove, is that the two inputs are distinguishable at all:
 * before the rookie round was captured, `2RK31` and `2031` parsed to
 * byte-identical rows and these two examples were the same example.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking. The one adapter call is the input the example turns on, read
 * exactly as an import would read it.
 */

import { describe, expect, it } from 'vitest';

import {
	CURRENT_CONTRACT_YEAR,
	ROSTER_COLUMNS,
	parseRosterCsv
} from '../../src/lib/adapters/fantrax/roster-file.ts';
import { ACTIVE_BENCH_SLOTS, SALARY_CAP } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { bidStateFor, evaluate } from '../../src/lib/core/rules/bidding.ts';
import type { TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import { computeCapSpace } from '../../src/lib/core/rules/roster-import.ts';
import type { CapHitRow } from '../../src/lib/core/rules/roster-import.ts';
import type { PlaceBid, RecordDrop } from '../../src/lib/core/types.ts';
import { INITIAL_AUCTIONS } from '../../src/lib/core/projection/auctions.ts';
import { INITIAL_NOMINATIONS } from '../../src/lib/core/projection/nominations.ts';
import { evaluateDrop } from '../../src/lib/core/rules/roster-drop.ts';
import type { DroppablePlayer, RosterDropState } from '../../src/lib/core/rules/roster-drop.ts';

const NOW = '2026-09-10T09:00:00.000Z';

/** The dropped Player's Cap Hit — the $2,000,000 the whole example is about. */
const DROPPED_CAP_HIT = 2_000_000;

/**
 * The nine contracts Team H keeps, summing to $158,000,000 so that with the
 * tenth at $2,000,000 the Team stands at Cap Space $5,000,000 exactly.
 */
const NINE_KEPT: readonly CapHitRow[] = [
	...Array.from({ length: 8 }, () => ({
		capHit: parseMoney(17_500_000),
		rosterSlotKind: 'active_bench' as const
	})),
	{ capHit: parseMoney(18_000_000), rosterSlotKind: 'active_bench' as const }
];

/** Before the Drop: ten Active/Bench contracts, the tenth at $2,000,000. */
const BEFORE: readonly CapHitRow[] = [
	...NINE_KEPT,
	{ capHit: parseMoney(DROPPED_CAP_HIT), rosterSlotKind: 'active_bench' as const }
];

/**
 * After the Drop: the same ten contracts, and the tenth is still charging.
 *
 * The row is RECLASSIFIED, not removed — that is what "Dead Money" means and
 * what makes Cap Space stand still while Roster Count falls.
 */
const AFTER: readonly CapHitRow[] = [
	...NINE_KEPT,
	{ capHit: parseMoney(DROPPED_CAP_HIT), rosterSlotKind: 'dead_money' as const }
];

/** Roster Count is the Active/Bench rows and nothing else (PRD §3). */
const rosterCountOf = (rows: readonly CapHitRow[]): number =>
	rows.filter((row) => row.rosterSlotKind === 'active_bench').length;

function teamHolding(rows: readonly CapHitRow[]): TeamMoneyState {
	return {
		capSpace: computeCapSpace(rows).capSpace,
		rosterCount: rosterCountOf(rows),
		// Team H "leads nothing", so `N` is the bid alone and `M` is the full
		// three Minor League Slots.
		leading: [],
		eligibleLeading: [],
		minorLeagueOccupied: 0
	};
}

function bidOf(amount: number): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId: 'p-target',
		teamId: 't-h',
		teamName: 'Team H',
		managerId: 'm-h',
		amount: parseMoney(amount)
	};
}

/** The gates Team H would face on one new non-eligible Bid. */
function gatesFor(rows: readonly CapHitRow[]) {
	return evaluate(bidStateFor(null, teamHolding(rows), false, 'Auction'), bidOf(1_000_000), NOW);
}

describe('§10 example 40 — a Drop lowers the Maximum Bid', () => {
	it('starts Team H at Roster Count 10, Cap Space $5,000,000, Maximum Bid $4,000,000', () => {
		const before = gatesFor(BEFORE);

		expect(before.cap.rosterCount).toBe(10);
		expect(before.cap.capSpace).toBe(5_000_000);
		expect(before.cap.projectedAdditions).toBe(1);
		// $1,000,000 × max(0, 12 − 11).
		expect(before.cap.rosterReserve).toBe(1_000_000);
		expect(before.cap.maximumBid).toBe(4_000_000);
	});

	it('leaves Cap Space UNTOUCHED after the Drop — the $2,000,000 is Dead Money', () => {
		// The row is reclassified rather than removed, and `chargedCapHit`
		// zeroes `minor_league` alone, so the released contract charges
		// exactly what it charged the day before.
		expect(computeCapSpace(AFTER).capHitTotal).toBe(computeCapSpace(BEFORE).capHitTotal);
		expect(gatesFor(AFTER).cap.capSpace).toBe(5_000_000);
	});

	it('frees a Roster Slot in the same act, and Roster Count falls to 9', () => {
		expect(rosterCountOf(AFTER)).toBe(9);
		expect(gatesFor(AFTER).cap.rosterCount).toBe(9);
		// Dead Money occupies no Minor League Slot either — it occupies
		// nothing at all.
		expect(teamHolding(AFTER).minorLeagueOccupied).toBe(0);
	});

	it('raises Roster Reserve to $2,000,000 and drops Maximum Bid to $3,000,000', () => {
		const after = gatesFor(AFTER);

		expect(after.cap.projectedAdditions).toBe(1);
		// $1,000,000 × max(0, 12 − 10).
		expect(after.cap.rosterReserve).toBe(2_000_000);
		expect(after.cap.maximumBid).toBe(3_000_000);
	});

	it('is the whole counter-intuitive claim in one line: the Team lost $1,000,000 of bidding power', () => {
		const before = gatesFor(BEFORE);
		const after = gatesFor(AFTER);

		// The gate figures are nullable on the outcome — outside the Auction
		// Phase there is no arithmetic to state — so they are pinned to their
		// literal values before any is subtracted from another.
		expect(before.cap.capSpace).toBe(5_000_000);
		expect(before.cap.rosterCount).toBe(10);
		expect(before.cap.rosterReserve).toBe(1_000_000);
		expect(before.cap.maximumBid).toBe(4_000_000);

		expect(after.cap.capSpace).toBe(5_000_000);
		expect(after.cap.rosterCount).toBe(9);
		// The loss is exactly the reserve on the freed hole, never a flat
		// adjustment applied because a Drop happened.
		expect(after.cap.rosterReserve).toBe(2_000_000);
		expect(after.cap.maximumBid).toBe(3_000_000);
		expect(ACTIVE_BENCH_SLOTS).toBe(12);
		expect(SALARY_CAP - computeCapSpace(AFTER).capHitTotal).toBe(5_000_000);
	});

	it('reads the dropped Player’s contract as a PLAIN deal — the input example 41 varies', () => {
		// `2031` against a 2026 import: five years remaining, no rookie-scale
		// designation. Example 41 supplies `2RK31` here instead, and nothing
		// else about the two examples differs.
		const cell = String(CURRENT_CONTRACT_YEAR + 5);
		const result = parseRosterCsv(
			[
				Object.values(ROSTER_COLUMNS).join(','),
				`*P-dropped*,Dropped Player,${String(DROPPED_CAP_HIT)},Act,${cell}`
			].join('\n')
		);

		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows[0]?.capHit).toBe(DROPPED_CAP_HIT);
		expect(result.rows[0]?.contractYearsRemaining).toBe(5);
		expect(result.rows[0]?.rookieScaleRound).toBeNull();
	});
});

// --- Story 7.8: the same example, driven through the command --------------

/**
 * The identical example, derived by `evaluateDrop` rather than by a fixture.
 *
 * **Added beside the hand-built states above, never in place of them** —
 * Story 7.6's change log KEEPs those, and they are what proves the two INPUTS
 * are distinguishable at all. What this block adds is that the COMMAND
 * produces the state they assert: the same $3,000,000, reached by applying
 * the act rather than by writing down its result.
 */

/** Team H's roster as the Drop sees it — ten Active/Bench Contracts. */
const DROPPABLE: readonly DroppablePlayer[] = [
	...Array.from({ length: 8 }, (_unused, index) => ({
		fantraxPlayerId: `p-keep-${String(index)}`,
		playerName: `Kept ${String(index)}`,
		rosterSlotKind: 'active_bench' as const,
		value: parseMoney(17_500_000),
		won: false,
		contractYearsRemaining: 3,
		rookieScaleRound: null
	})),
	{
		fantraxPlayerId: 'p-keep-8',
		playerName: 'Kept 8',
		rosterSlotKind: 'active_bench' as const,
		value: parseMoney(18_000_000),
		won: false,
		contractYearsRemaining: 3,
		rookieScaleRound: null
	},
	{
		fantraxPlayerId: 'p-dropped',
		playerName: 'Dropped Player',
		rosterSlotKind: 'active_bench' as const,
		value: parseMoney(DROPPED_CAP_HIT),
		won: false,
		// `2031` against a 2026 import: five years remaining and NO rookie-scale
		// round. Example 41 varies exactly this one field.
		contractYearsRemaining: 5,
		rookieScaleRound: null
	}
];

const DROP_STATE: RosterDropState = {
	team: { teamId: 't-h', teamName: 'Team H', rows: DROPPABLE },
	auctions: INITIAL_AUCTIONS,
	nominations: INITIAL_NOMINATIONS,
	isMinorLeagueEligible: () => false,
	playerNameFor: (id) => id
};

const DROP: RecordDrop = {
	kind: 'RecordDrop',
	teamId: 't-h',
	teamName: 'Team H',
	fantraxPlayerIds: ['p-dropped'],
	reason: 'Released in Fantrax on the 10th.'
};

describe('§10 example 40 — the same figures, derived through `RecordDrop`', () => {
	it('carries the full $2,000,000 as Dead Money and keeps the row', () => {
		const outcome = evaluateDrop(DROP_STATE, DROP);

		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;
		const release = outcome.delta.released[0];
		expect(release?.deadMoney).toBe(DROPPED_CAP_HIT);
		expect(release?.removed).toBe(false);
		expect(release?.fromPlacement).toBe('active_bench');
	});

	it('reproduces the hand-built after-state, figure for figure', () => {
		const outcome = evaluateDrop(DROP_STATE, DROP);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		expect(outcome.delta.before.capSpace).toBe(5_000_000);
		expect(outcome.delta.before.rosterCount).toBe(10);
		// Cap Space still $5,000,000 — the $2,000,000 is Dead Money and charges
		// exactly as it did before — and one Roster Slot is free.
		expect(outcome.delta.after.capSpace).toBe(5_000_000);
		expect(outcome.delta.after.rosterCount).toBe(9);
		// The same state the fixture above constructs by hand.
		expect(outcome.delta.after.capSpace).toBe(gatesFor(AFTER).cap.capSpace);
		expect(outcome.delta.after.rosterCount).toBe(rosterCountOf(AFTER));
	});

	it('lands Maximum Bid at $3,000,000 for the Team’s next Bid', () => {
		const outcome = evaluateDrop(DROP_STATE, DROP);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		// **The Drop's own cap gate offers no amount**, so it projects no
		// addition and reserves all three free Slots: $3,000,000 of reserve
		// against $5,000,000, leaving $2,000,000. That is the SOLVENCY question
		// FR-43 asks of the act — "can this Team still cover what it is already
		// committed to" — and it passes.
		expect(outcome.gates.cap.capSpace).toBe(5_000_000);
		expect(outcome.gates.cap.rosterReserve).toBe(3_000_000);
		expect(outcome.gates.cap.passed).toBe(true);

		// The example's $3,000,000 is the OTHER question: what Team H may offer
		// on its next non-eligible Bid, which projects that one addition. Asked
		// of the state the command produced rather than of a fixture, and it is
		// the same $3,000,000 — and the same $1,000,000 loss of bidding power.
		const afterDrop = evaluate(
			bidStateFor(
				null,
				{
					capSpace: outcome.delta.after.capSpace,
					rosterCount: outcome.delta.after.rosterCount,
					leading: [],
					eligibleLeading: [],
					minorLeagueOccupied: outcome.delta.after.minorLeagueOccupied
				},
				false,
				'Auction'
			),
			bidOf(1_000_000),
			NOW
		);

		expect(afterDrop.cap.rosterReserve).toBe(2_000_000);
		expect(afterDrop.cap.maximumBid).toBe(3_000_000);
		// Identical to the hand-built fixture's answer — one arithmetic, two
		// routes to it (AR-42).
		expect(afterDrop.cap.maximumBid).toBe(gatesFor(AFTER).cap.maximumBid);
		// The gate figures are nullable on the outcome — outside the Auction
		// Phase there is no arithmetic to state — so they are pinned to their
		// literal values before any is subtracted from another.
		expect(gatesFor(BEFORE).cap.maximumBid).toBe(4_000_000);
		expect(4_000_000 - 3_000_000).toBe(1_000_000);
	});
});
