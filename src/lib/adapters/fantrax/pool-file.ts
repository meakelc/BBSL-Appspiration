/**
 * The Fantrax Free Agent pool CSV — the only module in the repository that
 * knows this file's column names (AD-24, AR-2). Everything downstream — the
 * server layer, the core — sees only `ParsedPoolRow`, a domain type with no
 * notion of a CSV cell.
 *
 * **Column shape is a placeholder, TODO-confirm (addendum.md B).** No real
 * Fantrax export has been obtained yet; the four header names below are this
 * story's best-effort mapping from addendum.md B's documented pool row shape
 * ("Fantrax player ID, name, position(s), NBA team"). Real confirmation
 * against a BBSL export is deferred to 1.9/AR-33, per this story's
 * Boundaries & Constraints. Keeping the map in this one module —
 * `POOL_COLUMNS` below — is what makes that confirmation a one-file edit.
 *
 * **This module deliberately shares no base with `roster-file.ts`**, whose
 * structure it otherwise mirrors line for line. The two column maps must
 * stay independently editable: a real export will very plausibly name the
 * pool's Player ID column differently from the roster's, and a shared base
 * extracted today would make that a two-file negotiation instead of a
 * one-file edit. The duplication is the point.
 *
 * **Minor League Eligibility is not here, and must never be.** It is
 * app-owned, not imported (epic-1-context.md); the staged row's
 * `minor_league_eligible` column defaults to `false` — not eligible, so
 * omission fails safe. Nothing in this adapter reads, derives, infers or
 * fails on it.
 *
 * Rows join on the stable Fantrax player id, never on name (AD-24).
 *
 * Validates on parse and reports the offending row, not just a failure. A
 * file either parses in full, or the first invalid row refuses the whole
 * file at content altitude — there is no partial stage of a bad file.
 */

import { parse } from 'csv-parse/sync';

import type { ParsedPoolRow } from '../../core/types.ts';

/**
 * The placeholder column headers, exactly as they must appear in row 1 of
 * the pool CSV. See the module header above — TODO-confirm against a real
 * export.
 */
export const POOL_COLUMNS = Object.freeze({
	fantraxPlayerId: 'Fantrax Player ID',
	playerName: 'Player Name',
	positions: 'Positions',
	nbaTeam: 'NBA Team'
} as const);

const REQUIRED_COLUMNS: readonly string[] = Object.values(POOL_COLUMNS);

/** What parsing one pool CSV produced. */
export type PoolParseResult =
	| { readonly kind: 'parsed'; readonly rows: readonly ParsedPoolRow[] }
	| { readonly kind: 'refused'; readonly rowNumber: number; readonly detail: string };

/**
 * Parse a Free Agent pool CSV into `ParsedPoolRow`s, or the first content
 * refusal found. `rowNumber` is 1-based over data rows only (row 1 is the
 * first row of data, not the header); `rowNumber: 0` means the refusal is
 * about the file as a whole (unreadable, empty, or a header missing a
 * required column) rather than any one row.
 *
 * Content-altitude checks, in order, matching this story's I/O matrix:
 * missing required columns, a blank required cell, and a Fantrax Player ID
 * repeating one already seen earlier in the file. The pool is exactly one
 * source, and rows join on that id (AD-24), so a duplicate within it is
 * unresolvable — which occurrence is the real Player? — not merely untidy.
 * The first failure found refuses the whole file; nothing partial stages.
 */
export function parsePoolCsv(csvText: string): PoolParseResult {
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

	const rows: ParsedPoolRow[] = [];
	const seenPlayerIds = new Set<string>();

	for (let index = 0; index < records.length; index += 1) {
		const record = records[index] ?? {};
		const rowNumber = index + 1;

		const playerId = (record[POOL_COLUMNS.fantraxPlayerId] ?? '').trim();
		const playerName = (record[POOL_COLUMNS.playerName] ?? '').trim();
		const positions = (record[POOL_COLUMNS.positions] ?? '').trim();
		const nbaTeam = (record[POOL_COLUMNS.nbaTeam] ?? '').trim();

		if (playerId === '') {
			return refuse(rowNumber, `${POOL_COLUMNS.fantraxPlayerId} is blank.`);
		}
		if (playerName === '') {
			return refuse(rowNumber, `${POOL_COLUMNS.playerName} is blank.`);
		}
		if (positions === '') {
			return refuse(rowNumber, `${POOL_COLUMNS.positions} is blank.`);
		}
		if (nbaTeam === '') {
			return refuse(rowNumber, `${POOL_COLUMNS.nbaTeam} is blank.`);
		}

		if (seenPlayerIds.has(playerId)) {
			return refuse(
				rowNumber,
				`${POOL_COLUMNS.fantraxPlayerId} "${playerId}" repeats a Fantrax Player ID already seen earlier in this file.`
			);
		}
		seenPlayerIds.add(playerId);

		rows.push({ fantraxPlayerId: playerId, playerName, positions, nbaTeam });
	}

	return { kind: 'parsed', rows };
}

function refuse(rowNumber: number, detail: string): PoolParseResult {
	return { kind: 'refused', rowNumber, detail };
}
