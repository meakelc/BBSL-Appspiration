/**
 * The Audit Log's CSV serialisation (Story 7.5).
 *
 * Two claims: the escaping is correct for every character a cell can hold, and
 * a filtered export is exactly the filtered page rows — which is asserted by
 * driving the SAME pure functions the two routes call, rather than by
 * inspecting the CSV for rows that look right.
 */

import { describe, expect, it } from 'vitest';

import { AUDIT_CSV_HEADERS, auditCsvCell, auditRowsToCsv } from '../src/lib/core/audit-export.ts';
import { auditRowsFor, filterAuditRows } from '../src/lib/core/audit-log.ts';
import type { AuditFilter, AuditReferences } from '../src/lib/core/audit-log.ts';
import { BID_PLACED_EVENT } from '../src/lib/core/projection/auctions.ts';
import { CONTENTION_DRAWN_EVENT } from '../src/lib/core/projection/draws.ts';
import { NOMINATION_PLACED_EVENT } from '../src/lib/core/projection/nominations.ts';
import type { BidPlacedPayload } from '../src/lib/core/rules/bidding.ts';
import type { DrawnContentionPayload } from '../src/lib/core/rules/close.ts';
import type { NominationPlacedPayload } from '../src/lib/server/nomination.ts';
import type { AppendedEvent } from '../src/lib/core/types.ts';

const TEAM_A = 'team-a';
const TEAM_B = 'team-b';
const MANAGER_A = 'manager-a';
const PLAYER_ONE = 'player-1';

const REFERENCES: AuditReferences = {
	teamNames: new Map([
		[TEAM_A, 'Lakers'],
		[TEAM_B, 'Celtics']
	]),
	playerNames: new Map([[PLAYER_ONE, 'Jalen Green']]),
	managerNames: new Map([[MANAGER_A, 'Meakel']]),
	reversedCloses: new Map()
};

function event(seq: string, type: string, payload: unknown, teamId: string): AppendedEvent {
	return {
		seq,
		occurredAt: '2026-09-01T12:00:00.000Z',
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: MANAGER_A,
		teamId,
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

const BID_PLACED: BidPlacedPayload = {
	fantraxPlayerId: PLAYER_ONE,
	teamId: TEAM_A,
	teamName: 'Lakers',
	managerId: MANAGER_A,
	amount: 8_500_000,
	closesAt: '2026-09-02T12:00:00.000Z'
};

const NOMINATION_PLACED: NominationPlacedPayload = {
	fantraxPlayerId: PLAYER_ONE,
	playerName: 'Jalen Green',
	teamId: TEAM_B,
	teamName: 'Celtics',
	managerId: MANAGER_A,
	holdsSlot: true
};

describe('the CSV escaping', () => {
	it('quotes every field and doubles an inner quote', () => {
		expect(auditCsvCell('plain')).toBe('"plain"');
		expect(auditCsvCell('he said "no"')).toBe('"he said ""no"""');
	});

	it('keeps a comma and a newline inside one field', () => {
		expect(auditCsvCell('Lakers, Celtics')).toBe('"Lakers, Celtics"');
		expect(auditCsvCell('first\nsecond')).toBe('"first\nsecond"');
		expect(auditCsvCell('first\r\nsecond')).toBe('"first\r\nsecond"');
	});

	it('neutralises a formula, with the guard INSIDE the quotes', () => {
		for (const lead of ['=', '+', '-', '@']) {
			const cell = auditCsvCell(`${lead}1+1`);
			expect(cell).toBe(`"'${lead}1+1"`);
			// The guard must land after the opening quote, never before it — a
			// guard outside the field would corrupt the row rather than protect
			// it.
			expect(cell.startsWith('"\'')).toBe(true);
		}
	});

	it('neutralises a formula led by whitespace', () => {
		// A spreadsheet skips the space and evaluates this exactly as `=1+1`,
		// so a guard that only looked at index 0 would be bypassed by it.
		expect(auditCsvCell(' =1+1')).toBe('"\' =1+1"');
		expect(auditCsvCell('\t@SUM(A1)')).toBe('"\'\t@SUM(A1)"');
		expect(auditCsvCell('\n-1')).toBe('"\'\n-1"');
	});

	it('leaves the Log’s own minus sign alone', () => {
		// U+2212 MINUS SIGN, which `money.ts:46` renders and which is not the
		// ASCII hyphen a spreadsheet reads as a formula.
		expect(auditCsvCell('−$6,700,000')).toBe('"−$6,700,000"');
	});

	it('leaves an ordinary money rendering alone', () => {
		expect(auditCsvCell('$14.5M')).toBe('"$14.5M"');
	});
});

describe('the CSV document', () => {
	const events = [
		event('1', BID_PLACED_EVENT, BID_PLACED, TEAM_A),
		event('2', NOMINATION_PLACED_EVENT, NOMINATION_PLACED, TEAM_B)
	];
	const rows = auditRowsFor(events, REFERENCES);

	it('carries the header row even when nothing matched', () => {
		const csv = auditRowsToCsv([]);
		expect(csv).toBe(`${AUDIT_CSV_HEADERS.map(auditCsvCell).join(',')}\r\n`);
	});

	it('writes one record per row, in the rows’ own order', () => {
		const csv = auditRowsToCsv(rows);
		const records = csv.trimEnd().split('\r\n');
		expect(records).toHaveLength(rows.length + 1);
		// Newest first: `seq` 2 before `seq` 1.
		expect(records[1]).toContain('"2"');
		expect(records[2]).toContain('"1"');
	});

	it('carries the same rendered content the page shows', () => {
		const csv = auditRowsToCsv(rows);
		for (const entry of rows) {
			expect(csv).toContain(entry.headline);
			expect(csv).toContain(entry.actor.label);
			expect(csv).toContain(entry.typeLabel);
			for (const detail of entry.details) expect(csv).toContain(detail.value);
		}
	});

	it('exports exactly the filtered rows and no others', () => {
		const filter: AuditFilter = { team: TEAM_B, player: null, type: null };
		const shown = filterAuditRows(rows, filter);
		expect(shown).toHaveLength(1);

		// The SAME array the page renders — the export carries the filters in
		// force because there is one code path, not because two agree.
		expect(auditRowsToCsv(shown)).toBe(auditRowsToCsv(filterAuditRows(rows, filter)));

		const csv = auditRowsToCsv(shown);
		expect(csv).toContain('Celtics');
		expect(csv).not.toContain('Lakers');
	});
});

/**
 * The sealed seed, in the CSV.
 *
 * The acceptance criterion names the export explicitly, and it is the half most
 * worth asserting: the unrecognised-type fallback serialises whole payloads
 * verbatim into the Details cell, so a leak would reach the downloaded file by
 * a path the page's own rendering does not exercise.
 */
describe('the sealed seed in the export', () => {
	const OPEN_COMMITMENT = 'open-commitment-hash';
	const DRAWN_SEED = 'drawn-revealed-seed';

	const open: BidPlacedPayload = { ...BID_PLACED, seedHash: OPEN_COMMITMENT };
	const drawn: DrawnContentionPayload = {
		fantraxPlayerId: PLAYER_ONE,
		seed: DRAWN_SEED,
		seedHash: 'another-commitment',
		contenders: [TEAM_A, TEAM_B],
		drawnAt: '2026-09-02T12:00:00.000Z',
		selectedIndex: 1,
		winningTeamId: TEAM_B,
		winningTeamName: 'Celtics',
		winningManagerId: 'manager-b'
	};

	it('writes a drawn contention’s revealed seed', () => {
		// The control: proves the assertion below can fail.
		const rows = auditRowsFor([event('2', CONTENTION_DRAWN_EVENT, drawn, TEAM_A)], REFERENCES);
		expect(auditRowsToCsv(rows)).toContain(DRAWN_SEED);
	});

	it('writes no seed for a contention still open, only its commitment', () => {
		const rows = auditRowsFor([event('1', BID_PLACED_EVENT, open, TEAM_A)], REFERENCES);
		const csv = auditRowsToCsv(rows);
		expect(csv).toContain(OPEN_COMMITMENT);
		expect(csv).not.toContain(DRAWN_SEED);
	});

	it('attaches the revealed seed to exactly one record when both are in the Log', () => {
		const rows = auditRowsFor(
			[
				event('1', BID_PLACED_EVENT, open, TEAM_A),
				event('2', CONTENTION_DRAWN_EVENT, drawn, TEAM_A)
			],
			REFERENCES
		);
		const records = auditRowsToCsv(rows)
			.split('\n')
			.filter((line) => line.includes(DRAWN_SEED));
		expect(records).toHaveLength(1);
	});
});
