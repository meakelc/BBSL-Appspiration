/**
 * The Fantrax roster CSV — the only module in the repository that knows this
 * file's column names (AD-24, AR-2). Everything downstream — the pure core,
 * the server layer — sees only `ParsedRosterRow`, a domain type with no
 * notion of a CSV cell.
 *
 * **Column shape is a placeholder, TODO-confirm (addendum.md B).** No real
 * Fantrax export has been obtained yet; the six header names below are this
 * story's best-effort mapping from addendum.md B's documented row shape
 * ("Fantrax team ID, Fantrax player ID, player name, cap hit, roster slot
 * kind (Active/Bench, IR, Minor League), contract years remaining"). Real
 * confirmation against a BBSL export is deferred to 1.9/AR-33, per this
 * story's Boundaries & Constraints. Keeping the map in this one module —
 * `ROSTER_COLUMNS` below — is what makes that confirmation a one-file edit
 * rather than a rewrite.
 *
 * Rows join on the stable Fantrax player id, never on name (AD-24) — nothing
 * here reads a name for matching, only for display.
 *
 * Validates on parse and reports the offending row, not just a failure
 * (addendum.md B: "Setup day is high-stress and low-patience"). A file
 * either parses in full, or the first invalid row refuses the whole file at
 * content altitude — there is no partial stage of a bad file.
 */

import { parse } from 'csv-parse/sync';

import { parseMoney } from '../../core/money.ts';
import type { ParsedRosterRow, RosterSlotKind } from '../../core/types.ts';

/**
 * The placeholder column headers, exactly as they must appear in row 1 of
 * the CSV. See the module header above — TODO-confirm against a real export.
 */
export const ROSTER_COLUMNS = Object.freeze({
	fantraxTeamId: 'Fantrax Team ID',
	fantraxPlayerId: 'Fantrax Player ID',
	playerName: 'Player Name',
	capHit: 'Cap Hit',
	rosterSlot: 'Roster Slot',
	contractYearsRemaining: 'Contract Years Remaining'
} as const);

const REQUIRED_COLUMNS: readonly string[] = Object.values(ROSTER_COLUMNS);

/**
 * Postgres' `integer` (int4) upper bound. `import_staged_rosters
 * .contract_years_remaining` is that column type — a value beyond this would
 * pass `Number.isSafeInteger` and reach the INSERT, where it would throw an
 * unhandled database error rather than a content refusal naming the row.
 */
const POSTGRES_INTEGER_MAX = 2_147_483_647;

/**
 * The "Roster Slot" cell text this adapter recognises, mapped to the
 * `RosterSlotKind` the core deals in. Case-insensitive, trimmed. A handful of
 * obvious synonyms are accepted alongside addendum.md B's own wording
 * ("Active/Bench, IR, Minor League") because a real export's exact wording is
 * unconfirmed — narrow this back to the exact confirmed strings once 1.9/AR-33
 * settles it.
 */
const ROSTER_SLOT_ALIASES: Readonly<Record<string, RosterSlotKind>> = Object.freeze({
	'active/bench': 'active_bench',
	active: 'active_bench',
	bench: 'active_bench',
	ir: 'injury_reserve',
	'injury reserve': 'injury_reserve',
	'injured reserve': 'injury_reserve',
	'minor league': 'minor_league',
	minors: 'minor_league',
	minor: 'minor_league'
});

/** What parsing one roster CSV produced. */
export type RosterParseResult =
	| { readonly kind: 'parsed'; readonly rows: readonly ParsedRosterRow[] }
	| { readonly kind: 'refused'; readonly rowNumber: number; readonly detail: string };

/**
 * Parse a roster CSV into `ParsedRosterRow`s, or the first content refusal
 * found. `rowNumber` is 1-based over data rows only (row 1 is the first row
 * of data, not the header); `rowNumber: 0` means the refusal is about the
 * file as a whole (unreadable, or the header is missing a required column)
 * rather than any one row.
 *
 * Content-altitude checks, in order, matching this story's I/O matrix:
 * missing/blank required columns, a row's Fantrax Team ID disagreeing with
 * the file's own established Team ID (every row in one file must carry the
 * same Team ID — internal consistency only; `teams` stores no Fantrax Team ID
 * for a row to be checked against, per Boundaries & Constraints), a Fantrax
 * Player ID repeating one already seen earlier in the file (AD-24: rows join
 * on this id, so a duplicate within one file is unresolvable, not merely
 * untidy), a Cap Hit that does not parse as whole-dollar money or parses
 * negative, an unrecognised Roster Slot, and a Contract Years Remaining that
 * is not a whole number or exceeds Postgres `integer`'s range. The first
 * failure found refuses the whole file; nothing partial stages.
 */
export function parseRosterCsv(csvText: string): RosterParseResult {
	let records: Record<string, string>[];
	try {
		records = parse(csvText, {
			columns: true,
			skip_empty_lines: true,
			trim: true,
			bom: true
		}) as Record<string, string>[];
	} catch (error) {
		return {
			kind: 'refused',
			rowNumber: 0,
			detail: `The file could not be read as CSV: ${error instanceof Error ? error.message : String(error)}.`
		};
	}

	if (records.length === 0) {
		return { kind: 'refused', rowNumber: 0, detail: 'The file has no data rows.' };
	}

	const headerColumns = new Set(Object.keys(records[0] ?? {}));
	const missingColumns = REQUIRED_COLUMNS.filter((name) => !headerColumns.has(name));
	if (missingColumns.length > 0) {
		return {
			kind: 'refused',
			rowNumber: 0,
			detail: `The file is missing required column(s): ${missingColumns.join(', ')}.`
		};
	}

	const rows: ParsedRosterRow[] = [];
	let anchorTeamId: string | null = null;
	const seenPlayerIds = new Set<string>();

	for (let index = 0; index < records.length; index += 1) {
		const record = records[index] ?? {};
		const rowNumber = index + 1;

		const teamId = (record[ROSTER_COLUMNS.fantraxTeamId] ?? '').trim();
		const playerId = (record[ROSTER_COLUMNS.fantraxPlayerId] ?? '').trim();
		const playerName = (record[ROSTER_COLUMNS.playerName] ?? '').trim();
		const rawCapHit = (record[ROSTER_COLUMNS.capHit] ?? '').trim();
		const rawSlot = (record[ROSTER_COLUMNS.rosterSlot] ?? '').trim();
		const rawYears = (record[ROSTER_COLUMNS.contractYearsRemaining] ?? '').trim();

		if (teamId === '') {
			return refuse(rowNumber, `${ROSTER_COLUMNS.fantraxTeamId} is blank.`);
		}
		if (playerId === '') {
			return refuse(rowNumber, `${ROSTER_COLUMNS.fantraxPlayerId} is blank.`);
		}
		if (playerName === '') {
			return refuse(rowNumber, `${ROSTER_COLUMNS.playerName} is blank.`);
		}

		if (anchorTeamId === null) {
			anchorTeamId = teamId;
		} else if (teamId !== anchorTeamId) {
			return refuse(
				rowNumber,
				`${ROSTER_COLUMNS.fantraxTeamId} "${teamId}" does not match the file's Team ID "${anchorTeamId}".`
			);
		}

		if (seenPlayerIds.has(playerId)) {
			// Rows join on the Fantrax player id (AD-24); a duplicate within one
			// file is unresolvable — which occurrence is the real one? — not
			// merely untidy.
			return refuse(
				rowNumber,
				`${ROSTER_COLUMNS.fantraxPlayerId} "${playerId}" repeats a Fantrax Player ID already seen earlier in this file.`
			);
		}
		seenPlayerIds.add(playerId);

		let capHit: ParsedRosterRow['capHit'];
		try {
			capHit = parseMoney(rawCapHit);
		} catch {
			return refuse(rowNumber, `${ROSTER_COLUMNS.capHit} "${rawCapHit}" is not a whole-dollar amount.`);
		}
		if (capHit < 0) {
			return refuse(rowNumber, `${ROSTER_COLUMNS.capHit} "${rawCapHit}" is negative.`);
		}

		const rosterSlotKind = ROSTER_SLOT_ALIASES[rawSlot.toLowerCase()];
		if (rosterSlotKind === undefined) {
			return refuse(
				rowNumber,
				`${ROSTER_COLUMNS.rosterSlot} "${rawSlot}" is not Active/Bench, IR, or Minor League.`
			);
		}

		if (!/^\d+$/.test(rawYears)) {
			return refuse(
				rowNumber,
				`${ROSTER_COLUMNS.contractYearsRemaining} "${rawYears}" is not a whole number.`
			);
		}
		const contractYearsRemaining = Number(rawYears);
		if (!Number.isSafeInteger(contractYearsRemaining)) {
			return refuse(
				rowNumber,
				`${ROSTER_COLUMNS.contractYearsRemaining} "${rawYears}" is out of range.`
			);
		}
		if (contractYearsRemaining > POSTGRES_INTEGER_MAX) {
			return refuse(
				rowNumber,
				`${ROSTER_COLUMNS.contractYearsRemaining} "${rawYears}" exceeds the database's integer range (max ${String(POSTGRES_INTEGER_MAX)}).`
			);
		}

		rows.push({
			fantraxPlayerId: playerId,
			playerName,
			capHit,
			rosterSlotKind,
			contractYearsRemaining
		});
	}

	return { kind: 'parsed', rows };
}

function refuse(rowNumber: number, detail: string): RosterParseResult {
	return { kind: 'refused', rowNumber, detail };
}
