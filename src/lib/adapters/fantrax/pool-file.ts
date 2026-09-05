/**
 * The Fantrax Free Agent pool CSV — the only module in the repository that
 * knows this file's column names (AD-24, AR-2). Everything downstream — the
 * server layer, the core — sees only `ParsedPoolRow`, a domain type with no
 * notion of a CSV cell.
 *
 * **Column shape CONFIRMED 2026-09-05 against a real BBSL export** (AR-33,
 * Story 9.5), replacing the four `TODO-confirm` placeholders that had stood
 * since Story 1.8. All four were wrong — the real export names them `ID`,
 * `Player`, `Position` and `Team`, not `Fantrax Player ID`, `Player Name`,
 * `Positions` and `NBA Team`. Every one of the thirty-one files would have
 * refused at row 0 on setup day. Keeping the map in this one module —
 * `POOL_COLUMNS` below — is what made that confirmation a one-file edit.
 *
 * **The export carries far more than these four columns** — `Rookie`, `RkOv`,
 * `Status`, `Age`, `Opponent`, `Salary`, `Contract` and a dozen stat columns.
 * The header check below tests only for *missing* required names, so the
 * extras are ignored rather than refused. That is deliberate: Fantrax will add
 * a stat column one day and it must not break setup day.
 *
 * **`Salary` and `Contract` are present but deliberately unread.** A Free
 * Agent's Fantrax salary is not his BBSL price — the auction sets that — and
 * `free_agent_players` carries no column for either. Reading them here would
 * invent a figure the domain has no place for.
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
 * The column headers, exactly as they appear in row 1 of a real Fantrax
 * player export. Confirmed 2026-09-05; see the module header above.
 *
 * `positions` holds the export's `Position` cell verbatim — a comma-joined
 * run like `PG,SG,G` — because `ParsedPoolRow.positions` is a string and no
 * consumer splits it. It survives the CSV's own comma because the cell is
 * quoted.
 *
 * `nbaTeam` is the export's `Team`, which is the player's real-life NBA club
 * (`BOS`, `LAL`), never a fantasy Team. That is the glossary rule holding:
 * a three-letter capitalised abbreviation always and only means an NBA team.
 */
export const POOL_COLUMNS = Object.freeze({
	fantraxPlayerId: 'ID',
	playerName: 'Player',
	positions: 'Position',
	nbaTeam: 'Team'
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
