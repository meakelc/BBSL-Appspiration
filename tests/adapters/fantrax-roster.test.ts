import { describe, expect, it } from 'vitest';

import {
	CURRENT_CONTRACT_YEAR,
	ROSTER_COLUMNS,
	parseRosterCsv
} from '../../src/lib/adapters/fantrax/roster-file.ts';

/** Built from `ROSTER_COLUMNS`, never a hardcoded header string — a future
 * column rename must not need this file edited alongside it. */
const HEADER = Object.values(ROSTER_COLUMNS).join(',');

/** A file whose header is row 1, as the Free Agent pool export writes it. */
function csv(...rows: string[]): string {
	return [HEADER, ...rows].join('\n');
}

/** A file carrying the preamble row a real team-roster export emits above its
 * header — `"","Player"` — which is the shape confirmed on 2026-09-05. */
function csvWithPreamble(...rows: string[]): string {
	return ['"","Player"', HEADER, ...rows].join('\n');
}

/** An end year that is always exactly two years out, so these fixtures do not
 * silently expire when `CURRENT_CONTRACT_YEAR` is next moved forward. */
const TWO_YEARS_OUT = String(CURRENT_CONTRACT_YEAR + 2);

describe('parseRosterCsv — the real export shape', () => {
	it('reads the header beneath a preamble row rather than treating the preamble as the header', () => {
		const result = parseRosterCsv(csvWithPreamble(`*P1*,Alice,"1,000,000",Act,${TWO_YEARS_OUT}`));
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.playerName).toBe('Alice');
	});

	it('still reads a file whose header is row 1, so the two export shapes both parse', () => {
		const result = parseRosterCsv(csv(`*P1*,Alice,1000000,Act,${TWO_YEARS_OUT}`));
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows[0]?.capHit).toBe(1_000_000);
	});

	it('strips thousands separators from Salary without loosening parseMoney itself', () => {
		const result = parseRosterCsv(csv(`*P1*,Alice,"25,000,000",Act,${TWO_YEARS_OUT}`));
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows[0]?.capHit).toBe(25_000_000);
	});

	it('maps Act, Res and Min — the three confirmed Status values', () => {
		const text = csv(
			`*P1*,Alice,0,Act,${TWO_YEARS_OUT}`,
			`*P2*,Bob,0,Res,${TWO_YEARS_OUT}`,
			`*P3*,Cara,0,Min,${TWO_YEARS_OUT}`
		);
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows.map((row) => row.rosterSlotKind)).toEqual([
			'active_bench',
			'active_bench',
			'minor_league'
		]);
	});

	it('still maps IR, which is retained but was absent from the confirming export', () => {
		const result = parseRosterCsv(csv(`*P1*,Alice,0,IR,${TWO_YEARS_OUT}`));
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows[0]?.rosterSlotKind).toBe('injury_reserve');
	});

	it('accepts case-insensitive, trimmed Status text', () => {
		const result = parseRosterCsv(csv(`*P1*,Alice,0,  min  ,${TWO_YEARS_OUT}`));
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows[0]?.rosterSlotKind).toBe('minor_league');
	});

	it('keeps the asterisk wrapping on a player id, because the pool export writes it the same way', () => {
		const result = parseRosterCsv(csv(`*06mlk*,Alice,0,Act,${TWO_YEARS_OUT}`));
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows[0]?.fantraxPlayerId).toBe('*06mlk*');
	});

	it('carries nothing CSV-specific onto a parsed row, and no team id — the export has none', () => {
		const result = parseRosterCsv(csv(`*P1*,Alice,0,Act,${TWO_YEARS_OUT}`));
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual(
			[
				'capHit',
				'contractYearsRemaining',
				'fantraxPlayerId',
				'playerName',
				'rookieScaleRound',
				'rosterSlotKind'
			].sort()
		);
	});
});

describe('parseRosterCsv — Contract is an end year, not a count', () => {
	it('derives years remaining from a four-digit end year', () => {
		const result = parseRosterCsv(csv(`*P1*,Alice,0,Act,${String(CURRENT_CONTRACT_YEAR + 3)}`));
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows[0]?.contractYearsRemaining).toBe(3);
	});

	it('derives years remaining from a rookie-scale code carrying a two-digit end year', () => {
		const twoDigit = String(CURRENT_CONTRACT_YEAR + 3).slice(2);
		const result = parseRosterCsv(csv(`*P1*,Alice,0,Act,2RK${twoDigit}`));
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows[0]?.contractYearsRemaining).toBe(3);
	});

	it('treats a contract ending in the current year as expiring, not as an error', () => {
		const result = parseRosterCsv(csv(`*P1*,Alice,0,Act,${String(CURRENT_CONTRACT_YEAR)}`));
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows[0]?.contractYearsRemaining).toBe(0);
	});

	it('refuses a contract that ended before the current year rather than storing a negative length', () => {
		const result = parseRosterCsv(csv(`*P1*,Alice,0,Act,${String(CURRENT_CONTRACT_YEAR - 1)}`));
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(1);
		expect(result.detail).toContain(ROSTER_COLUMNS.contractYearsRemaining);
	});

	it('refuses a Contract cell that is neither an end year nor a rookie-scale code', () => {
		const result = parseRosterCsv(csv('*P1*,Alice,0,Act,two years'));
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(1);
		expect(result.detail).toContain(ROSTER_COLUMNS.contractYearsRemaining);
	});

	it('refuses a bare count, which is what the placeholder shape wrongly assumed', () => {
		const result = parseRosterCsv(csv('*P1*,Alice,0,Act,2'));
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(1);
	});
});

/**
 * The three characters worth $2,000,000 (Story 7.6, FR-43, PRD §10 ex 41).
 *
 * `2RK31` and `2031` are the same contract LENGTH and different contracts.
 * Before the round was captured they produced byte-identical rows, so no test
 * anywhere in this repository could have told them apart — which is why the
 * regression is asserted here, at the parse, and not only at the rule that
 * reads it.
 */
describe('parseRosterCsv — the rookie-scale designation survives the parse', () => {
	/** Five years out, written both ways: `2RK31` and `2031` against 2026. */
	const FIVE_OUT = String(CURRENT_CONTRACT_YEAR + 5);
	const FIVE_OUT_SHORT = FIVE_OUT.slice(2);

	it('makes a rookie deal and a plain deal of the same length DISTINGUISHABLE', () => {
		const rookie = parseRosterCsv(csv(`*P1*,Alice,2000000,Act,2RK${FIVE_OUT_SHORT}`));
		const plain = parseRosterCsv(csv(`*P1*,Alice,2000000,Act,${FIVE_OUT}`));
		expect(rookie.kind).toBe('parsed');
		expect(plain.kind).toBe('parsed');
		if (rookie.kind !== 'parsed' || plain.kind !== 'parsed') return;

		// Same length — the fact that made the two rows identical.
		expect(rookie.rows[0]?.contractYearsRemaining).toBe(5);
		expect(plain.rows[0]?.contractYearsRemaining).toBe(5);

		// ...and now a difference FR-43's exception can read: the round.
		expect(rookie.rows[0]?.rookieScaleRound).toBe(2);
		expect(plain.rows[0]?.rookieScaleRound).toBeNull();
		expect(rookie.rows[0]).not.toEqual(plain.rows[0]);
	});

	it('carries the round itself, not an is-rookie flag — the exception turns on it being 2', () => {
		const first = parseRosterCsv(csv(`*P1*,Alice,0,Act,1RK${FIVE_OUT_SHORT}`));
		expect(first.kind).toBe('parsed');
		if (first.kind !== 'parsed') return;
		expect(first.rows[0]?.rookieScaleRound).toBe(1);
	});

	it('accepts the lowercase spelling on the same terms, as it always did', () => {
		const result = parseRosterCsv(csv(`*P1*,Alice,0,Act,2rk${FIVE_OUT_SHORT}`));
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows[0]?.rookieScaleRound).toBe(2);
		expect(result.rows[0]?.contractYearsRemaining).toBe(5);
	});

	it('still refuses an unrecognised shape, naming the row and the raw cell', () => {
		// Capturing the round widened what the regex HANDS BACK, never what it
		// accepts. `20X1` is not a year and not a rookie code, and the refusal
		// is a returned value rather than a throw.
		const result = parseRosterCsv(csv('*P1*,Alice,0,Act,20X1'));
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(1);
		expect(result.detail).toContain(ROSTER_COLUMNS.contractYearsRemaining);
		expect(result.detail).toContain('20X1');
	});

	it('refuses a two-digit round, and a rookie code with no year at all', () => {
		expect(parseRosterCsv(csv(`*P1*,Alice,0,Act,12RK${FIVE_OUT_SHORT}`)).kind).toBe('refused');
		expect(parseRosterCsv(csv('*P1*,Alice,0,Act,2RK')).kind).toBe('refused');
	});
});

/**
 * Dead Money is NOT importable in v1 (Story 7.6). It is produced by a
 * Commissioner Drop inside this product and never read off an export, so
 * nothing was added to `ROSTER_SLOT_ALIASES` — an unrecognised Status refuses
 * the row and names it, exactly as it did before the fourth slot kind existed.
 * `import_staged_rosters`'s own three-value check constraint is the backstop
 * underneath this refusal.
 */
describe('parseRosterCsv — Dead Money is not importable', () => {
	for (const status of ['Dead Money', 'dead_money', 'DM', 'Dead']) {
		it(`refuses a Status of "${status}", naming the row and the cell`, () => {
			const result = parseRosterCsv(csv(`*P1*,Alice,2000000,${status},${TWO_YEARS_OUT}`));
			expect(result.kind).toBe('refused');
			if (result.kind !== 'refused') return;
			expect(result.rowNumber).toBe(1);
			expect(result.detail).toContain(ROSTER_COLUMNS.rosterSlot);
			expect(result.detail).toContain(status);
		});
	}
});

describe('parseRosterCsv — file-shape refusals (rowNumber 0)', () => {
	it('refuses an empty file', () => {
		const result = parseRosterCsv(`${HEADER}\n`);
		expect(result).toMatchObject({ kind: 'refused', rowNumber: 0 });
	});

	it('refuses a file missing a required column, naming it', () => {
		const text = `${ROSTER_COLUMNS.fantraxPlayerId},${ROSTER_COLUMNS.playerName},${ROSTER_COLUMNS.capHit},${ROSTER_COLUMNS.rosterSlot}\n*P1*,Alice,0,Act`;
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(0);
		expect(result.detail).toContain(ROSTER_COLUMNS.contractYearsRemaining);
	});

	it('refuses rather than scanning indefinitely for a header that is not there', () => {
		const junk = Array.from({ length: 12 }, () => '"","Player"').join('\n');
		const result = parseRosterCsv(`${junk}\n`);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(0);
	});

	it('refuses unparsable CSV text rather than throwing', () => {
		const result = parseRosterCsv('"unterminated quote');
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(0);
	});
});

describe('parseRosterCsv — content refusals name the offending row', () => {
	it('refuses a blank required cell, naming the 1-based data row', () => {
		const text = csv(`*P1*,Alice,0,Act,${TWO_YEARS_OUT}`, `,Bob,0,Act,${TWO_YEARS_OUT}`);
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(2);
		expect(result.detail).toContain(ROSTER_COLUMNS.fantraxPlayerId);
	});

	it('numbers rows from the first row of data, not from the top of a file with a preamble', () => {
		const text = csvWithPreamble(
			`*P1*,Alice,0,Act,${TWO_YEARS_OUT}`,
			`*P2*,Bob,bad-money,Act,${TWO_YEARS_OUT}`
		);
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(2);
	});

	it('refuses a Salary that is not a whole-dollar amount', () => {
		const result = parseRosterCsv(csv(`*P1*,Alice,not-a-number,Act,${TWO_YEARS_OUT}`));
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(1);
		expect(result.detail).toContain(ROSTER_COLUMNS.capHit);
	});

	it('refuses a decimal Salary, so stripping separators has not admitted a float', () => {
		const result = parseRosterCsv(csv(`*P1*,Alice,25.5,Act,${TWO_YEARS_OUT}`));
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(1);
		expect(result.detail).toContain(ROSTER_COLUMNS.capHit);
	});

	it('refuses a negative Salary', () => {
		const result = parseRosterCsv(csv(`*P1*,Alice,-500000,Act,${TWO_YEARS_OUT}`));
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(1);
		expect(result.detail).toContain(ROSTER_COLUMNS.capHit);
		expect(result.detail).toContain('-500000');
	});

	it('refuses an unrecognised Status', () => {
		const result = parseRosterCsv(csv(`*P1*,Alice,0,Point Guard,${TWO_YEARS_OUT}`));
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(1);
		expect(result.detail).toContain(ROSTER_COLUMNS.rosterSlot);
	});

	it('refuses only the offending row, stopping the whole file rather than partially staging', () => {
		const text = csv(
			`*P1*,Alice,0,Act,${TWO_YEARS_OUT}`,
			`*P2*,Bob,bad-money,Act,${TWO_YEARS_OUT}`,
			`*P3*,Cara,0,Act,${TWO_YEARS_OUT}`
		);
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(2);
	});

	it('refuses a Fantrax Player ID that repeats one already seen earlier in the file', () => {
		const text = csv(
			`*P1*,Alice,0,Act,${TWO_YEARS_OUT}`,
			`*P2*,Bob,0,Act,${TWO_YEARS_OUT}`,
			`*P1*,Cara,0,Act,${TWO_YEARS_OUT}`
		);
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(3);
		expect(result.detail).toContain(ROSTER_COLUMNS.fantraxPlayerId);
		expect(result.detail).toContain('*P1*');
	});
});
