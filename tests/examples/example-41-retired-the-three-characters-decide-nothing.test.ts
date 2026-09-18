/**
 * PRD §10 example 41 — **RETIRED on 2026-09-16**, and this file is the record
 * of that plus the regression that keeps it retired.
 *
 * Example 41 existed to state FR-43's one exception: a `Contract` cell reading
 * `2RK31` against a 2026 import — a second-round rookie deal with its full
 * five-year term unelapsed — cleared entirely on a Drop, so Cap Space rose to
 * $7,000,000 and Maximum Bid landed at $5,000,000 rather than $3,000,000.
 * Identical to example 40 in every other figure, and $2,000,000 apart on the
 * strength of three characters in one CSV cell.
 *
 * **The League does not waive Dead Money during the auction at all.** The
 * waiver is an AMNESTY PERIOD that runs BEFORE the auction opens: it is
 * settled in Fantrax and is already reflected in the rosters this app
 * imports. By the time a Drop can be recorded here there is nothing left to
 * waive, so the exception was never a rule this product needed — and while it
 * stood it fired once in production, removing Washington's $1,000,000 Contract
 * on Malique Lewis and handing the Team back money it should have kept
 * charging.
 *
 * So example 41 **is** example 40 now, and this file pins exactly that. What
 * it must never become is silence: deleting it would leave nothing to fail if
 * the exception were ever reintroduced, and the parse assertion at the foot is
 * what proves the designation still SURVIVES the import while deciding nothing
 * — the distinction it took Story 7.6 to build, and which a future rule may
 * legitimately want back.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking. The one adapter call is the input the example turned on.
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
import type { PlaceBid, RecordDrop } from '../../src/lib/core/types.ts';
import { INITIAL_AUCTIONS } from '../../src/lib/core/projection/auctions.ts';
import { INITIAL_NOMINATIONS } from '../../src/lib/core/projection/nominations.ts';
import { evaluateDrop } from '../../src/lib/core/rules/roster-drop.ts';
import type { DroppablePlayer, RosterDropState } from '../../src/lib/core/rules/roster-drop.ts';

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
 * After the Drop — and it is now example 40's after-state exactly.
 *
 * The row is **reclassified**, not removed. There is no second construction
 * here any more, because there is no second outcome: this one fixture is what
 * the rule produces for a `2RK31` cell and for a `2031` cell alike.
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
	return evaluate(bidStateFor(null, teamHolding(rows), 'Auction'), bidOf(1_000_000), NOW);
}

describe('example 41, retired — the three characters that decide nothing', () => {
	it('starts from the state example 40 starts from, figure for figure', () => {
		const before = gatesFor(BEFORE);

		expect(before.cap.rosterCount).toBe(10);
		expect(before.cap.capSpace).toBe(5_000_000);
		expect(before.cap.rosterReserve).toBe(1_000_000);
		expect(before.cap.maximumBid).toBe(4_000_000);
	});

	it('CARRIES the Cap Hit — Cap Space stands still at $5,000,000', () => {
		// The retirement, stated as arithmetic. This assertion read $7,000,000
		// while the exception stood.
		expect(gatesFor(AFTER).cap.capSpace).toBe(5_000_000);
		expect(AFTER.some((row) => row.rosterSlotKind === 'dead_money')).toBe(true);
		// A Dead Money row charges in full, so the Team's total is untouched.
		expect(computeCapSpace(AFTER).capHitTotal).toBe(computeCapSpace(BEFORE).capHitTotal);
	});

	it('frees the same Roster Slot, so Roster Reserve is $2,000,000 as before', () => {
		const after = gatesFor(AFTER);

		expect(after.cap.rosterCount).toBe(9);
		expect(after.cap.projectedAdditions).toBe(1);
		// $1,000,000 × max(0, 12 − 10) — identical to example 40, and the Slot
		// arithmetic never was what separated the two examples.
		expect(after.cap.rosterReserve).toBe(2_000_000);
	});

	it('lands Maximum Bid at $3,000,000 — example 40’s answer, not $5,000,000', () => {
		const before = gatesFor(BEFORE).cap.maximumBid;
		const after = gatesFor(AFTER).cap.maximumBid;

		expect(after).toBe(3_000_000);
		expect(before).toBe(4_000_000);
		// The Drop LOWERS it, by the reserve on the hole it opened and by
		// nothing else.
		expect(Number(before) - Number(after)).toBe(1_000_000);
	});

	it('still reads `2RK31` as a second-round deal — the designation SURVIVES', () => {
		// It is still parsed and still persisted; it simply decides nothing.
		// Keeping this assertion is deliberate: Story 7.6 built the capture,
		// reverting it would now be invisible everywhere else, and a future rule
		// may want the fact back.
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
		expect(plain.rows[0]?.rookieScaleRound).toBeNull();
		expect(rookie.rows[0]).not.toEqual(plain.rows[0]);
	});
});

describe('example 41, retired — and the COMMAND agrees with the fixture', () => {
	const DROPPED: DroppablePlayer = {
		fantraxPlayerId: 'p-dropped',
		playerName: 'Dropped Player',
		rosterSlotKind: 'active_bench',
		value: parseMoney(DROPPED_CAP_HIT),
		won: false,
		// The two facts FR-43's exception used to ask for, at the exact values
		// that used to trigger it.
		contractYearsRemaining: 5,
		rookieScaleRound: 2
	};

	const KEPT: readonly DroppablePlayer[] = NINE_KEPT.map((row, index) => ({
		fantraxPlayerId: `p-kept-${String(index)}`,
		playerName: `Kept ${String(index)}`,
		rosterSlotKind: 'active_bench' as const,
		value: row.capHit,
		won: false,
		contractYearsRemaining: 3,
		rookieScaleRound: null
	}));

	const STATE: RosterDropState = {
		team: { teamId: 't-h', teamName: 'Team H', rows: [...KEPT, DROPPED] },
		auctions: INITIAL_AUCTIONS,
		nominations: INITIAL_NOMINATIONS,
		isMinorLeagueEligible: () => false,
		playerNameFor: (id) => id
	};

	const COMMAND: RecordDrop = {
		kind: 'RecordDrop',
		teamId: 't-h',
		teamName: 'Team H',
		fantraxPlayerIds: ['p-dropped'],
		reason: 'Released in Fantrax.'
	};

	it('carries the full $2,000,000 as Dead Money and keeps the row', () => {
		const outcome = evaluateDrop(STATE, COMMAND);

		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		const release = outcome.delta.released[0];
		expect(release?.deadMoney).toBe(DROPPED_CAP_HIT);
		expect(release?.removed).toBe(false);
		// The designation rode into the payload untouched — it is a fact about
		// the Contract and the Audit Log prints it — but it changed nothing.
		expect(release?.rookieScaleRound).toBe(2);
		expect(release?.contractYearsRemaining).toBe(5);
	});

	it('derives the fixture above: Cap Space still $5,000,000, Roster Count 9', () => {
		const outcome = evaluateDrop(STATE, COMMAND);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		expect(outcome.delta.before.capSpace).toBe(computeCapSpace(BEFORE).capSpace);
		expect(outcome.delta.after.capSpace).toBe(computeCapSpace(AFTER).capSpace);
		expect(outcome.delta.after.capSpace).toBe(outcome.delta.before.capSpace);
		expect(outcome.delta.after.rosterCount).toBe(9);
	});
});
