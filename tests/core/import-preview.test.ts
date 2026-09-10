import { describe, expect, it } from 'vitest';

import {
	ACTIVE_BENCH_SLOTS,
	INJURY_RESERVE_SLOTS,
	MINIMUM_INCREMENT,
	MINOR_LEAGUE_SLOTS,
	SALARY_CAP
} from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	offGridCapSpaceDetail,
	previewTeam,
	promotionRefusalDetail,
	renderCapSpace
} from '../../src/lib/core/rules/import-preview.ts';
import { computeCapSpace } from '../../src/lib/core/rules/roster-import.ts';
import type { ParsedRosterRow, RosterSlotKind } from '../../src/lib/core/types.ts';

function row(
	overrides: Partial<ParsedRosterRow> & { readonly rosterSlotKind?: RosterSlotKind } = {}
): ParsedRosterRow {
	return {
		fantraxPlayerId: 'p-1',
		playerName: 'Alice',
		capHit: parseMoney(1_000_000),
		rosterSlotKind: 'active_bench',
		contractYearsRemaining: 1,
		rookieScaleRound: null,
		...overrides
	};
}

function rows(count: number, slotKind: RosterSlotKind, capHit = 1_000_000): ParsedRosterRow[] {
	return Array.from({ length: count }, (_unused, index) =>
		row({ fantraxPlayerId: `p-${slotKind}-${index}`, rosterSlotKind: slotKind, capHit: parseMoney(capHit) })
	);
}

describe('previewTeam', () => {
	it('reports the staged row count, the cap hit total and Cap Space', () => {
		const preview = previewTeam(rows(3, 'active_bench', 2_000_000));
		expect(preview.rosterCount).toBe(3);
		expect(preview.capHitTotal).toBe(6_000_000);
		expect(preview.capSpace).toBe(SALARY_CAP - 6_000_000);
		expect(preview.breaches).toEqual([]);
	});

	it('is exactly computeCapSpace — no second definition of the arithmetic', () => {
		// If `previewTeam` ever grew its own copy of the Cap Space rule, this is
		// the assertion that catches the divergence: the two must agree on the
		// Minor League $0 treatment, which is the part most likely to be
		// re-derived incorrectly.
		const staged = [
			...rows(2, 'active_bench', 3_000_000),
			...rows(1, 'minor_league', 9_000_000)
		];
		const preview = previewTeam(staged);
		const direct = computeCapSpace(staged);
		expect(preview.capSpace).toBe(direct.capSpace);
		expect(preview.capHitTotal).toBe(direct.capHitTotal);
		// The Minor League row's stated cap hit does not count against the Cap.
		expect(preview.capHitTotal).toBe(6_000_000);
	});

	it('reports an empty Team as zero rows against the full Salary Cap', () => {
		const preview = previewTeam([]);
		expect(preview.rosterCount).toBe(0);
		expect(preview.capSpace).toBe(SALARY_CAP);
		expect(preview.breaches).toEqual([]);
	});

	it.each([
		['active_bench' as const, ACTIVE_BENCH_SLOTS],
		['injury_reserve' as const, INJURY_RESERVE_SLOTS],
		['minor_league' as const, MINOR_LEAGUE_SLOTS]
	])('detects a %s ceiling breach and states the count against the ceiling', (slotKind, ceiling) => {
		const preview = previewTeam(rows(ceiling + 1, slotKind, 0));
		expect(preview.breaches).toEqual([{ slotKind, count: ceiling + 1, ceiling }]);
	});
});

describe('renderCapSpace', () => {
	it('renders an on-grid amount through formatMoney, at exactly one decimal', () => {
		expect(renderCapSpace(parseMoney(14_500_000))).toEqual({ text: '$14.5M', offGrid: false });
		expect(renderCapSpace(parseMoney(14_000_000))).toEqual({ text: '$14.0M', offGrid: false });
	});

	it('renders a negative on-grid amount with the true minus sign, not a hyphen', () => {
		const rendered = renderCapSpace(parseMoney(-2_500_000));
		expect(rendered).toEqual({ text: '−$2.5M', offGrid: false });
		expect(rendered.text).not.toContain('-');
	});

	it('renders an off-grid amount as exact integer dollars, flagged off-grid', () => {
		const amount = parseMoney(14_123_456);
		expect(amount % MINIMUM_INCREMENT).not.toBe(0);
		expect(renderCapSpace(amount)).toEqual({ text: '$14123456', offGrid: true });
	});

	it('renders a negative off-grid amount with the true minus sign', () => {
		const rendered = renderCapSpace(parseMoney(-123_456));
		expect(rendered).toEqual({ text: '−$123456', offGrid: true });
		expect(rendered.text).not.toContain('-');
	});

	it('never throws on an off-grid amount — asking is the alternative to catching', () => {
		expect(() => renderCapSpace(parseMoney(1))).not.toThrow();
	});
});

describe('offGridCapSpaceDetail', () => {
	it('names the Team and the figure, and says it does not block promotion', () => {
		const rendered = renderCapSpace(parseMoney(14_123_456));
		const sentence = offGridCapSpaceDetail('Lakers', rendered);
		expect(sentence).toContain('Lakers');
		expect(sentence).toContain('$14123456');
		expect(sentence).toContain('does not block promotion');
	});
});

describe('promotionRefusalDetail', () => {
	it('names every outstanding source and never states a count', () => {
		const detail = promotionRefusalDetail({
			kind: 'outstanding',
			sourceNames: ['Celtics', 'Lakers', 'Free Agent pool']
		});
		expect(detail).toContain('Celtics');
		expect(detail).toContain('Lakers');
		expect(detail).toContain('Free Agent pool');
		// "named, never counted" — no bare digit standing in for the list.
		expect(detail).not.toMatch(/\b3 sources?\b/);
	});

	it('names the breaching Team and states the arithmetic against the ceiling', () => {
		const detail = promotionRefusalDetail({
			kind: 'breach',
			teams: [
				{
					teamName: 'Lakers',
					breaches: [{ slotKind: 'active_bench', count: 13, ceiling: ACTIVE_BENCH_SLOTS }]
				}
			]
		});
		expect(detail).toContain('Lakers');
		expect(detail).toContain('13 rows exceeds the ceiling of 12');
	});

	it('names every breaching Team, not only the first', () => {
		const detail = promotionRefusalDetail({
			kind: 'breach',
			teams: [
				{ teamName: 'Lakers', breaches: [{ slotKind: 'injury_reserve', count: 3, ceiling: 2 }] },
				{ teamName: 'Celtics', breaches: [{ slotKind: 'minor_league', count: 4, ceiling: 3 }] }
			]
		});
		expect(detail).toContain('Lakers');
		expect(detail).toContain('Celtics');
	});

	it('states the phase that was folded, and where it was folded from', () => {
		const detail = promotionRefusalDetail({ kind: 'phase', phase: 'Auction' });
		expect(detail).toContain('Auction');
		expect(detail).toContain('not Setup');
		expect(detail).toContain('event log');
	});

	it('states the fact first, with no apology and no exclamation mark', () => {
		for (const detail of [
			promotionRefusalDetail({ kind: 'outstanding', sourceNames: ['Lakers'] }),
			promotionRefusalDetail({
				kind: 'breach',
				teams: [{ teamName: 'Lakers', breaches: [{ slotKind: 'active_bench', count: 13, ceiling: 12 }] }]
			}),
			promotionRefusalDetail({ kind: 'phase', phase: 'Auction' })
		]) {
			expect(detail.startsWith('Promotion was refused')).toBe(true);
			expect(detail).not.toContain('!');
			expect(detail.toLowerCase()).not.toContain('sorry');
		}
	});
});
