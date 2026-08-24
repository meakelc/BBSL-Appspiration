import { describe, expect, it } from 'vitest';

import {
	ACTIVE_BENCH_SLOTS,
	INJURY_RESERVE_SLOTS,
	MINOR_LEAGUE_SLOTS,
	SALARY_CAP
} from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	capSpaceRefusalDetail,
	checkSlotCeilings,
	computeCapSpace,
	slotCeilingRefusalDetail
} from '../../src/lib/core/rules/roster-import.ts';
import type { ParsedRosterRow, RosterSlotKind } from '../../src/lib/core/types.ts';

/** Build one row, cheaply, with only the fields a test cares about varied. */
function row(overrides: Partial<ParsedRosterRow> = {}): ParsedRosterRow {
	return {
		fantraxPlayerId: 'p-1',
		playerName: 'Player One',
		capHit: parseMoney(1_000_000),
		rosterSlotKind: 'active_bench',
		contractYearsRemaining: 1,
		...overrides
	};
}

describe('computeCapSpace', () => {
	it('computes SALARY_CAP minus the sum of cap hits', () => {
		const rows = [row({ capHit: parseMoney(10_000_000) }), row({ capHit: parseMoney(20_000_000) })];
		const result = computeCapSpace(rows);
		expect(result.capHitTotal).toBe(30_000_000);
		expect(result.capSpace).toBe(SALARY_CAP - 30_000_000);
	});

	it('treats a Minor League row as a $0 cap hit regardless of what the row states', () => {
		const rows = [
			row({ rosterSlotKind: 'minor_league', capHit: parseMoney(5_000_000) }),
			row({ rosterSlotKind: 'active_bench', capHit: parseMoney(10_000_000) })
		];
		const result = computeCapSpace(rows);
		expect(result.capHitTotal).toBe(10_000_000);
		expect(result.capSpace).toBe(SALARY_CAP - 10_000_000);
	});

	it('computes zero total, and full Cap Space, for an empty roster', () => {
		const result = computeCapSpace([]);
		expect(result.capHitTotal).toBe(0);
		expect(result.capSpace).toBe(SALARY_CAP);
	});

	it('produces a negative Cap Space when the sum exceeds the cap, without throwing', () => {
		const rows = [row({ capHit: parseMoney(SALARY_CAP + 1_000_000) })];
		const result = computeCapSpace(rows);
		expect(result.capSpace).toBe(-1_000_000);
	});
});

describe('checkSlotCeilings', () => {
	function rowsOf(kind: RosterSlotKind, count: number): ParsedRosterRow[] {
		return Array.from({ length: count }, (_, i) =>
			row({ rosterSlotKind: kind, fantraxPlayerId: `${kind}-${String(i)}` })
		);
	}

	it('finds no breach when every count sits at or under its ceiling', () => {
		const rows = [
			...rowsOf('active_bench', ACTIVE_BENCH_SLOTS),
			...rowsOf('injury_reserve', INJURY_RESERVE_SLOTS),
			...rowsOf('minor_league', MINOR_LEAGUE_SLOTS)
		];
		expect(checkSlotCeilings(rows)).toEqual([]);
	});

	it('reports a breach naming the slot kind, count and ceiling when Active/Bench exceeds its ceiling', () => {
		const rows = rowsOf('active_bench', ACTIVE_BENCH_SLOTS + 1);
		expect(checkSlotCeilings(rows)).toEqual([
			{ slotKind: 'active_bench', count: ACTIVE_BENCH_SLOTS + 1, ceiling: ACTIVE_BENCH_SLOTS }
		]);
	});

	it('reports a breach for Injury Reserve independently', () => {
		const rows = rowsOf('injury_reserve', INJURY_RESERVE_SLOTS + 1);
		expect(checkSlotCeilings(rows)).toEqual([
			{ slotKind: 'injury_reserve', count: INJURY_RESERVE_SLOTS + 1, ceiling: INJURY_RESERVE_SLOTS }
		]);
	});

	it('reports a breach for Minor League independently', () => {
		const rows = rowsOf('minor_league', MINOR_LEAGUE_SLOTS + 1);
		expect(checkSlotCeilings(rows)).toEqual([
			{ slotKind: 'minor_league', count: MINOR_LEAGUE_SLOTS + 1, ceiling: MINOR_LEAGUE_SLOTS }
		]);
	});

	it('reports every breach at once, not just the first', () => {
		const rows = [
			...rowsOf('active_bench', ACTIVE_BENCH_SLOTS + 2),
			...rowsOf('injury_reserve', INJURY_RESERVE_SLOTS + 1)
		];
		const breaches = checkSlotCeilings(rows);
		expect(breaches).toHaveLength(2);
		expect(breaches.map((b) => b.slotKind).sort()).toEqual(['active_bench', 'injury_reserve']);
	});

	it('returns empty for an empty roster', () => {
		expect(checkSlotCeilings([])).toEqual([]);
	});
});

describe('refusal wording — states the fact, then the arithmetic', () => {
	it('capSpaceRefusalDetail names the cap, the total, and the result — with a true minus sign, never a hyphen', () => {
		const result = computeCapSpace([row({ capHit: parseMoney(SALARY_CAP + 500_000) })]);
		const detail = capSpaceRefusalDetail(result);
		expect(detail).toContain(String(SALARY_CAP));
		expect(detail).toContain(String(SALARY_CAP + 500_000));
		// U+2212 MINUS SIGN, not a hyphen — `$-500000` must never appear.
		expect(detail).toContain('−$500000');
		expect(detail).not.toContain('$-500000');
		expect(detail).not.toContain('!');
	});

	it('slotCeilingRefusalDetail names each breach, count and ceiling', () => {
		const breaches = checkSlotCeilings([
			...Array.from({ length: ACTIVE_BENCH_SLOTS + 1 }, (_, i) =>
				row({ rosterSlotKind: 'active_bench', fantraxPlayerId: `ab-${String(i)}` })
			)
		]);
		const detail = slotCeilingRefusalDetail(breaches);
		expect(detail).toContain('Active/Bench');
		expect(detail).toContain(String(ACTIVE_BENCH_SLOTS + 1));
		expect(detail).toContain(String(ACTIVE_BENCH_SLOTS));
		expect(detail).not.toContain('!');
	});
});
