import { describe, expect, it } from 'vitest';

import { POOL_COLUMNS, parsePoolCsv } from '../../src/lib/adapters/fantrax/pool-file.ts';

/** Built from `POOL_COLUMNS`, never a hardcoded header string — a future
 *  column-name confirmation (1.9/AR-33) must stay a one-file edit. */
const HEADER = Object.values(POOL_COLUMNS).join(',');

function csv(...rows: string[]): string {
	return [HEADER, ...rows].join('\n');
}

describe('parsePoolCsv — the happy path', () => {
	it('parses every row into ParsedPoolRow, joining on the Fantrax player id', () => {
		const result = parsePoolCsv(csv('P1,Alice,PG,LAL', 'P2,Bob,SF/PF,BOS'));
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows).toEqual([
			{ fantraxPlayerId: 'P1', playerName: 'Alice', positions: 'PG', nbaTeam: 'LAL' },
			{ fantraxPlayerId: 'P2', playerName: 'Bob', positions: 'SF/PF', nbaTeam: 'BOS' }
		]);
	});

	it('carries the four fields and nothing else — no eligibility, no money, no slot kind', () => {
		const result = parsePoolCsv(csv('P1,Alice,PG,LAL'));
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual(
			['fantraxPlayerId', 'nbaTeam', 'playerName', 'positions'].sort()
		);
	});

	it('never derives, infers, or fails on Minor League Eligibility — even when the file states one', () => {
		// An extra column the adapter does not know about is simply not read:
		// eligibility is app-owned and defaults to `false` as a DATABASE column
		// default, never from the file (epic-1-context.md, this story's AC2).
		const text = [
			`${HEADER},Minor League Eligible`,
			'P1,Alice,PG,LAL,TRUE',
			'P2,Bob,C,BOS,YES'
		].join('\n');
		const result = parsePoolCsv(text);
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		for (const row of result.rows) {
			expect(Object.keys(row)).not.toContain('minorLeagueEligible');
		}
	});

	it('trims surrounding whitespace on every cell', () => {
		const result = parsePoolCsv(csv('  P1 ,  Alice  ,  PG/SG ,  LAL  '));
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows[0]).toEqual({
			fantraxPlayerId: 'P1',
			playerName: 'Alice',
			positions: 'PG/SG',
			nbaTeam: 'LAL'
		});
	});
});

describe('parsePoolCsv — file-shape refusals (rowNumber 0)', () => {
	it('refuses a file with a header but no data rows', () => {
		expect(parsePoolCsv(`${HEADER}\n`)).toMatchObject({ kind: 'refused', rowNumber: 0 });
	});

	it('refuses a zero-byte file', () => {
		expect(parsePoolCsv('')).toMatchObject({ kind: 'refused', rowNumber: 0 });
	});

	it('refuses a missing required column, naming it', () => {
		const text = [
			`${POOL_COLUMNS.fantraxPlayerId},${POOL_COLUMNS.playerName}`,
			'P1,Alice'
		].join('\n');
		const result = parsePoolCsv(text);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(0);
		expect(result.detail).toContain(POOL_COLUMNS.positions);
		expect(result.detail).toContain(POOL_COLUMNS.nbaTeam);
	});

	it('refuses text that is not CSV at all', () => {
		const result = parsePoolCsv('"unterminated\n,,,');
		expect(result).toMatchObject({ kind: 'refused', rowNumber: 0 });
	});
});

describe('parsePoolCsv — row refusals name the row', () => {
	it.each([
		[',Alice,PG,LAL', POOL_COLUMNS.fantraxPlayerId],
		['P1,,PG,LAL', POOL_COLUMNS.playerName],
		['P1,Alice,,LAL', POOL_COLUMNS.positions],
		['P1,Alice,PG,', POOL_COLUMNS.nbaTeam]
	])('refuses a blank cell in %s, naming %s', (row: string, column: string) => {
		const result = parsePoolCsv(csv(row));
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(1);
		expect(result.detail).toContain(column);
	});

	it('refuses a Fantrax Player ID repeating one already seen in the file, naming the row', () => {
		const result = parsePoolCsv(csv('P1,Alice,PG,LAL', 'P2,Bob,C,BOS', 'P1,Alice Again,PG,LAL'));
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(3);
		expect(result.detail).toContain('P1');
		expect(result.detail).toContain('repeats');
	});

	it('the first invalid row refuses the whole file — nothing partial parses', () => {
		const result = parsePoolCsv(csv('P1,Alice,PG,LAL', 'P2,,C,BOS', 'P3,Cara,,LAL'));
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(2);
	});
});
