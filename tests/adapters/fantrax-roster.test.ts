import { describe, expect, it } from 'vitest';

import { ROSTER_COLUMNS, parseRosterCsv } from '../../src/lib/adapters/fantrax/roster-file.ts';

const HEADER = Object.values(ROSTER_COLUMNS).join(',');

function csv(...rows: string[]): string {
	return [HEADER, ...rows].join('\n');
}

describe('parseRosterCsv — the happy path', () => {
	it('parses every row into ParsedRosterRow, joining on the Fantrax player id', () => {
		const text = csv(
			'T1,P1,Alice,10000000,Active/Bench,2',
			'T1,P2,Bob,0,IR,1',
			'T1,P3,Cara,500000,Minor League,4'
		);
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows).toEqual([
			{
				fantraxPlayerId: 'P1',
				playerName: 'Alice',
				capHit: 10_000_000,
				rosterSlotKind: 'active_bench',
				contractYearsRemaining: 2
			},
			{
				fantraxPlayerId: 'P2',
				playerName: 'Bob',
				capHit: 0,
				rosterSlotKind: 'injury_reserve',
				contractYearsRemaining: 1
			},
			{
				fantraxPlayerId: 'P3',
				playerName: 'Cara',
				capHit: 500_000,
				rosterSlotKind: 'minor_league',
				contractYearsRemaining: 4
			}
		]);
	});

	it('accepts case-insensitive, trimmed Roster Slot text', () => {
		const text = csv('T1,P1,Alice,0,  minors  ,0');
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows[0]?.rosterSlotKind).toBe('minor_league');
	});

	it('never carries a Fantrax Team ID, a file name, or anything CSV-specific onto a parsed row', () => {
		const text = csv('T1,P1,Alice,0,IR,0');
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual(
			['capHit', 'contractYearsRemaining', 'fantraxPlayerId', 'playerName', 'rosterSlotKind'].sort()
		);
	});
});

describe('parseRosterCsv — file-shape refusals (rowNumber 0)', () => {
	it('refuses an empty file', () => {
		const result = parseRosterCsv(`${HEADER}\n`);
		expect(result).toMatchObject({ kind: 'refused', rowNumber: 0 });
	});

	it('refuses a file missing a required column, naming it', () => {
		const text = 'Fantrax Team ID,Fantrax Player ID,Player Name,Cap Hit,Roster Slot\nT1,P1,Alice,0,IR';
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(0);
		expect(result.detail).toContain('Contract Years Remaining');
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
		const text = csv('T1,P1,Alice,0,IR,0', 'T1,,Bob,0,IR,0');
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(2);
		expect(result.detail).toContain('Fantrax Player ID');
	});

	it("refuses a row whose Fantrax Team ID disagrees with the file's own established Team ID", () => {
		const text = csv('T1,P1,Alice,0,IR,0', 'T2,P2,Bob,0,IR,0');
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(2);
		expect(result.detail).toContain('T2');
		expect(result.detail).toContain('T1');
	});

	it('refuses a Cap Hit that is not a whole-dollar amount', () => {
		const text = csv('T1,P1,Alice,not-a-number,IR,0');
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(1);
		expect(result.detail).toContain('Cap Hit');
	});

	it('refuses an unrecognised Roster Slot', () => {
		const text = csv('T1,P1,Alice,0,Point Guard,0');
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(1);
		expect(result.detail).toContain('Roster Slot');
	});

	it('refuses a non-whole-number Contract Years Remaining', () => {
		const text = csv('T1,P1,Alice,0,IR,1.5');
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(1);
		expect(result.detail).toContain('Contract Years Remaining');
	});

	it('refuses only the offending row, stopping the whole file rather than partially staging', () => {
		const text = csv('T1,P1,Alice,0,IR,0', 'T1,P2,Bob,bad-money,IR,0', 'T1,P3,Cara,0,IR,0');
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(2);
	});

	it('refuses a Fantrax Player ID that repeats one already seen earlier in the file', () => {
		const text = csv('T1,P1,Alice,0,IR,0', 'T1,P2,Bob,0,IR,0', 'T1,P1,Cara,0,IR,0');
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(3);
		expect(result.detail).toContain('Fantrax Player ID');
		expect(result.detail).toContain('P1');
	});

	it('refuses a negative Cap Hit', () => {
		const text = csv('T1,P1,Alice,-500000,IR,0');
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(1);
		expect(result.detail).toContain('Cap Hit');
		expect(result.detail).toContain('-500000');
	});

	it("refuses a Contract Years Remaining exceeding Postgres integer's range", () => {
		const text = csv('T1,P1,Alice,0,IR,99999999999');
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect(result.rowNumber).toBe(1);
		expect(result.detail).toContain('Contract Years Remaining');
	});

	it('accepts Contract Years Remaining exactly at the integer boundary', () => {
		const text = csv('T1,P1,Alice,0,IR,2147483647');
		const result = parseRosterCsv(text);
		expect(result.kind).toBe('parsed');
		if (result.kind !== 'parsed') return;
		expect(result.rows[0]?.contractYearsRemaining).toBe(2_147_483_647);
	});
});
