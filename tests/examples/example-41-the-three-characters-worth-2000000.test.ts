/**
 * PRD §10 example 41 — **The three characters worth $2,000,000** (FR-43).
 *
 * > Identical to example 40 in every figure, except that the dropped Player's
 * > `Contract` cell reads **`2RK31`** against a 2026 import — a second-round
 * > rookie deal with its full five-year term unelapsed, and therefore this
 * > year's draft class. His Cap Hit **clears** (FR-43): Cap Space rises to
 * > $7,000,000, no Dead Money is carried, Roster Reserve is $2,000,000 as
 * > before, and **Maximum Bid is $5,000,000** rather than $3,000,000. The
 * > same Player, the same amount, the same act, and a $2,000,000 difference
 * > decided entirely by a prefix the importer currently **discards**. Until
 * > that prefix is captured, examples 40 and 41 are the same example and the
 * > app computes one of them wrongly.
 *
 * **This file is the regression, and its sibling is the control.** The two
 * examples differ in exactly one input — three characters in one CSV cell —
 * and $2,000,000 of Maximum Bid. Before Story 7.6 captured the round,
 * `CONTRACT_END_YEAR` matched the rookie prefix in a non-capturing group and
 * threw it away, so `2RK31` and `2031` produced byte-identical
 * `ParsedRosterRow`s: nothing downstream could have told these two states
 * apart, whatever rule was written above them. The parse assertion at the
 * foot of this file is what fails if that capture is ever reverted.
 *
 * **Altitude — a stated assumption (Story 7.6).** As with example 40, the
 * post-drop roster state is constructed directly in the fixture; the
 * Commissioner Drop command that produces it is Story 7.8, which will drive
 * the same assertions through the command itself.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking. The one adapter call is the input the example turns on.
 */

import { describe, expect, it } from 'vitest';

import {
	CURRENT_CONTRACT_YEAR,
	ROSTER_COLUMNS,
	parseRosterCsv
} from '../../src/lib/adapters/fantrax/roster-file.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { bidStateFor, evaluate } from '../../src/lib/core/rules/bidding.ts';
import type { TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import { computeCapSpace } from '../../src/lib/core/rules/roster-import.ts';
import type { CapHitRow } from '../../src/lib/core/rules/roster-import.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-09-10T09:00:00.000Z';

/** The dropped Player's Cap Hit — the same $2,000,000 as example 40. */
const DROPPED_CAP_HIT = 2_000_000;

/** The identical nine contracts example 40's Team H keeps. */
const NINE_KEPT: readonly CapHitRow[] = [
	...Array.from({ length: 8 }, () => ({
		capHit: parseMoney(17_500_000),
		rosterSlotKind: 'active_bench' as const
	})),
	{ capHit: parseMoney(18_000_000), rosterSlotKind: 'active_bench' as const }
];

/** Before the Drop: the identical state example 40 starts from. */
const BEFORE: readonly CapHitRow[] = [
	...NINE_KEPT,
	{ capHit: parseMoney(DROPPED_CAP_HIT), rosterSlotKind: 'active_bench' as const }
];

/**
 * After the Drop: the row is **removed**, not reclassified.
 *
 * This is the one structural difference from example 40, and it is the whole
 * of FR-43's exception. A second-round rookie deal released with its full
 * term unelapsed carries no Dead Money — so there is no fourth-kind row to
 * construct, and the $2,000,000 goes back to Cap Space.
 */
const AFTER: readonly CapHitRow[] = NINE_KEPT;

/** Example 40's post-drop state, for the side-by-side at the foot. */
const AFTER_AS_EXAMPLE_40: readonly CapHitRow[] = [
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

function gatesFor(rows: readonly CapHitRow[]) {
	return evaluate(bidStateFor(null, teamHolding(rows), false, 'Auction'), bidOf(1_000_000), NOW);
}

describe('§10 example 41 — the three characters worth $2,000,000', () => {
	it('starts from the state example 40 starts from, figure for figure', () => {
		const before = gatesFor(BEFORE);

		expect(before.cap.rosterCount).toBe(10);
		expect(before.cap.capSpace).toBe(5_000_000);
		expect(before.cap.rosterReserve).toBe(1_000_000);
		expect(before.cap.maximumBid).toBe(4_000_000);
	});

	it('CLEARS the Cap Hit — Cap Space rises to $7,000,000 and no Dead Money is carried', () => {
		expect(gatesFor(AFTER).cap.capSpace).toBe(7_000_000);
		// Nothing was reclassified: there is no Dead Money row to find.
		expect(AFTER.some((row) => row.rosterSlotKind === 'dead_money')).toBe(false);
		expect(computeCapSpace(AFTER).capHitTotal).toBe(
			computeCapSpace(BEFORE).capHitTotal - DROPPED_CAP_HIT
		);
	});

	it('frees the same Roster Slot, so Roster Reserve is $2,000,000 as before', () => {
		const after = gatesFor(AFTER);

		expect(after.cap.rosterCount).toBe(9);
		expect(after.cap.projectedAdditions).toBe(1);
		// $1,000,000 × max(0, 12 − 10) — identical to example 40. The Slot
		// arithmetic is not what differs between the two examples.
		expect(after.cap.rosterReserve).toBe(2_000_000);
	});

	it('leaves Maximum Bid at $5,000,000, not $3,000,000 — and that gap is the story', () => {
		const here = gatesFor(AFTER);
		const asExample40 = gatesFor(AFTER_AS_EXAMPLE_40);

		expect(here.cap.maximumBid).toBe(5_000_000);
		expect(asExample40.cap.maximumBid).toBe(3_000_000);
		// The gap, stated as the arithmetic rather than as two literals: the
		// dropped Player's own Cap Hit, to the dollar.
		expect(5_000_000 - 3_000_000).toBe(DROPPED_CAP_HIT);

		// The same Player, the same amount, the same act — and the two states
		// agree on every SLOT figure while disagreeing by $2,000,000 on the
		// money. Whatever else changes, these two must not converge.
		expect(here.cap.rosterCount).toBe(asExample40.cap.rosterCount);
		expect(here.cap.rosterReserve).toBe(asExample40.cap.rosterReserve);
		expect(here.cap.capSpace).not.toBe(asExample40.cap.capSpace);
	});

	it('reads `2RK31` as a SECOND-ROUND rookie deal with five years unelapsed', () => {
		// The three characters. `2RK31` against a 2026 import is round 2 and
		// five years remaining; example 40's `2031` is the same five years and
		// no round at all. Revert the capture in `CONTRACT_END_YEAR` and this
		// assertion is the one that goes red — before this story the two cells
		// produced identical rows and no test could have separated them.
		const twoDigit = String(CURRENT_CONTRACT_YEAR + 5).slice(2);
		const parse = (cell: string) =>
			parseRosterCsv(
				[
					Object.values(ROSTER_COLUMNS).join(','),
					`*P-dropped*,Dropped Player,${String(DROPPED_CAP_HIT)},Act,${cell}`
				].join('\n')
			);

		const rookie = parse(`2RK${twoDigit}`);
		const plain = parse(String(CURRENT_CONTRACT_YEAR + 5));
		expect(rookie.kind).toBe('parsed');
		expect(plain.kind).toBe('parsed');
		if (rookie.kind !== 'parsed' || plain.kind !== 'parsed') return;

		expect(rookie.rows[0]?.rookieScaleRound).toBe(2);
		expect(rookie.rows[0]?.contractYearsRemaining).toBe(5);
		// "his full five-year term unelapsed" — the second-round rookie scale
		// is five years, and five remain, so none of it has been served.
		expect(plain.rows[0]?.rookieScaleRound).toBeNull();
		expect(rookie.rows[0]).not.toEqual(plain.rows[0]);
	});
});
