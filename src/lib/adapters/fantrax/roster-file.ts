/**
 * The Fantrax roster CSV — the only module in the repository that knows this
 * file's column names (AD-24, AR-2). Everything downstream — the pure core,
 * the server layer — sees only `ParsedRosterRow`, a domain type with no
 * notion of a CSV cell.
 *
 * **Column shape CONFIRMED 2026-09-05 against a real BBSL export** (AR-33,
 * Story 9.5), replacing the six `TODO-confirm` placeholders that had stood
 * since Story 1.7. The real export differs from the guess in four ways, and
 * three of them are structural rather than cosmetic:
 *
 *   1. **The header is not row 1.** A team-roster export emits a preamble
 *      row — `"","Player"` — above the real header. `findHeaderOffset` below
 *      handles it. The *player* export (`pool-file.ts`) has no such row, which
 *      is precisely why these two modules share no base.
 *   2. **There is no Fantrax Team ID column, at all.** The file carries no
 *      team identity; the exporting team's name is in the *filename* only.
 *      The binding therefore comes entirely from the UI's team selection
 *      (`import_team_sources.team_id`). See the note on `ROSTER_COLUMNS`.
 *   3. **Money carries thousands separators** — `25,000,000`, not `25000000`.
 *      `parseMoney` requires an unpunctuated run of digits and rightly refuses
 *      to be loosened (AD-1: a throw from it signals a bug). The separators
 *      are stripped here, at the boundary, which is where format lives.
 *   4. **`Contract` is not a count of years.** It holds a contract *end year*
 *      (`2028`) or a rookie-scale code (`2RK29`). `contractYearsRemaining` is
 *      derived from it against `CURRENT_CONTRACT_YEAR` below, and the rookie
 *      code's leading DRAFT ROUND is carried out as `rookieScaleRound` —
 *      `2RK31` and `2031` mean the same length and different things (FR-43).
 *
 * Rows join on the stable Fantrax player id, never on name (AD-24) — nothing
 * here reads a name for matching, only for display. The id is asterisk-wrapped
 * in the export (`*04ewu*`) and is stored exactly as it appears, wrapping
 * included: the pool export writes it the same way, so the join holds, and
 * stripping the asterisks in one adapter and not the other would silently
 * break every match.
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
 * The column headers, exactly as they appear in the real header row of a
 * Fantrax team-roster export. Confirmed 2026-09-05; see the module header.
 *
 * **`fantraxTeamId` is gone, and its absence is load-bearing.** The export
 * carries no team column, so the previous "every row must agree on one Team
 * ID" check had nothing to read and has been removed with it. That check was
 * the only content-altitude defence against uploading one Team's file into
 * another Team's slot, and there is now no such defence: the file is bound to
 * a Team purely by the Commissioner's selection in the import UI. A
 * mis-slotted file stages cleanly and looks correct. This is a real loss and
 * is recorded rather than papered over — the per-Team preview (Story 1.9) is
 * where a human can still catch it, which is an argument for actually reading
 * that preview rather than clicking through it.
 */
export const ROSTER_COLUMNS = Object.freeze({
	fantraxPlayerId: 'ID',
	playerName: 'Player',
	capHit: 'Salary',
	rosterSlot: 'Status',
	contractYearsRemaining: 'Contract'
} as const);

/**
 * The season year the import is run against — the year the upcoming season
 * begins. A contract whose `Contract` cell reads `2027` therefore has one
 * year remaining, and one reading `2026` has none and is expiring.
 *
 * **This is a Commissioner-set constant and it is the one value in this module
 * that was not read off the export.** The export states an end year; turning
 * that into "years remaining" needs a reference point the file does not carry.
 * Getting it wrong shifts every Existing Contract's length by the same whole
 * number of years — visibly wrong rather than subtly wrong, which is the only
 * comfort available. Confirm it before setup day and change this one line if
 * the league counts differently.
 */
export const CURRENT_CONTRACT_YEAR = 2026;

const REQUIRED_COLUMNS: readonly string[] = Object.values(ROSTER_COLUMNS);

/**
 * The `Status` cell text this adapter recognises, mapped to the
 * `RosterSlotKind` the core deals in. Case-insensitive, trimmed.
 *
 * **`Act`, `Res` and `Min` are confirmed** against the 2026-09-05 export.
 * `Act` and `Res` both fold to `active_bench`, which is the domain's single
 * kind covering an active player and a benched one alike — the distinction
 * Fantrax draws between them is a lineup concern the BBSL cap does not see,
 * and both count against Roster Capacity. `Min` is a Minor League placement,
 * which resolves to a $0 Cap Hit and sits outside the 12 slots.
 *
 * **`IR` is retained but UNCONFIRMED.** The sample export held no injured
 * player, so Fantrax's exact wording for that state has never been observed.
 * The three spellings below are kept deliberately: an unrecognised Status
 * refuses the whole file at content altitude, so guessing wide costs nothing
 * and guessing narrow costs a setup day. Narrow this the first time a real
 * export contains one.
 */
const ROSTER_SLOT_ALIASES: Readonly<Record<string, RosterSlotKind>> = Object.freeze({
	act: 'active_bench',
	res: 'active_bench',
	min: 'minor_league',
	ir: 'injury_reserve',
	'injury reserve': 'injury_reserve',
	'injured reserve': 'injury_reserve'
});

/**
 * A contract end year (`2028`) or a rookie-scale code carrying a draft round
 * and a two-digit end year (`2RK29`, `1RK30`). Nothing else is accepted: an
 * unrecognised shape refuses the row rather than guessing a length.
 *
 * **The round is CAPTURED, and that is the whole of Story 7.6's parse
 * change.** It used to be matched in a non-capturing group and thrown away,
 * which made `2RK31` and `2031` produce byte-identical rows against a 2026
 * import — both five years remaining, and nothing else to tell them apart.
 * FR-43's exception turns on exactly the digit that was discarded: released
 * with its full term unelapsed, a SECOND-round rookie deal carries no Dead
 * Money while the plain contract carries all of it (PRD §10 examples 40 and
 * 41). The shapes the regex accepts and refuses are unchanged; only what it
 * hands back is wider.
 *
 * The prefix is a DIGIT plus `RK`, not the literal `NRK` that `AR-43` and
 * `prd.md:854` name — `N` was standing for the round all along.
 */
const CONTRACT_END_YEAR = /^(?:(\d)(?:RK|rk))?(\d{2}|\d{4})$/;

/**
 * What a `Contract` cell states, once parsed: a whole number of years
 * remaining, and the draft round if the cell was a rookie-scale code.
 *
 * `rookieScaleRound` is `null` for an ordinary end-year cell. It is the round
 * itself rather than an is-rookie flag because FR-43's exception is about the
 * round being **2**, and a boolean would throw away the fact the exception
 * reads.
 */
type ParsedContractCell = {
	readonly contractYearsRemaining: number;
	readonly rookieScaleRound: number | null;
};

/**
 * Resolve a `Contract` cell, or `null` if the cell is not a shape this
 * adapter recognises.
 *
 * A two-digit year is read as 2000-relative, which is safe for the lifetime
 * of a basketball contract and unambiguous for every value Fantrax emits.
 */
function contractCellFrom(raw: string): ParsedContractCell | null {
	const match = CONTRACT_END_YEAR.exec(raw);
	if (match === null) return null;
	const round = match[1];
	const digits = match[2] ?? '';
	const endYear = digits.length === 2 ? 2000 + Number(digits) : Number(digits);
	const remaining = endYear - CURRENT_CONTRACT_YEAR;
	if (remaining < 0) return null;
	return {
		contractYearsRemaining: remaining,
		rookieScaleRound: round === undefined ? null : Number(round)
	};
}

/**
 * Parse the CSV, taking the header from the first row that actually carries
 * every required column.
 *
 * A Fantrax team-roster export puts a preamble row (`"","Player"`) above its
 * real header, so `columns: true` alone would read that junk row as the
 * header and then report every column missing. Rather than hardcode "skip one
 * line" — which would break the moment Fantrax emits two preamble rows, or
 * none — this tries each of the first few rows as the header and keeps the
 * first that fits.
 *
 * The scan is bounded deliberately. An unbounded search over a malformed file
 * would eventually "find" a data row whose cells happen to match and parse
 * nonsense confidently; a short bound fails fast and refuses with the missing
 * column names instead, which is the answer a Commissioner can act on.
 */
const MAX_PREAMBLE_ROWS = 4;

function parseFromHeaderRow(csvText: string): Record<string, string>[] {
	let lastError: unknown = null;

	for (let offset = 0; offset <= MAX_PREAMBLE_ROWS; offset += 1) {
		let candidate: Record<string, string>[];
		try {
			candidate = parse(csvText, {
				columns: true,
				skip_empty_lines: true,
				trim: true,
				bom: true,
				relax_column_count: true,
				from_line: offset + 1
			}) as Record<string, string>[];
		} catch (error) {
			lastError = error;
			continue;
		}

		const headerColumns = new Set(Object.keys(candidate[0] ?? {}));
		if (REQUIRED_COLUMNS.every((name) => headerColumns.has(name))) {
			return candidate;
		}
		// Remember the first attempt: if no offset fits, the caller reports
		// against row 1, which is what a file with a genuinely wrong header has.
		if (offset === 0) lastError = null;
	}

	if (lastError !== null) throw lastError;

	// No offset carried every required column. Return the row-1 reading so the
	// missing-column refusal below names what row 1 actually lacked.
	return parse(csvText, {
		columns: true,
		skip_empty_lines: true,
		trim: true,
		bom: true,
		relax_column_count: true
	}) as Record<string, string>[];
}

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
		records = parseFromHeaderRow(csvText);
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
	const seenPlayerIds = new Set<string>();

	for (let index = 0; index < records.length; index += 1) {
		const record = records[index] ?? {};
		const rowNumber = index + 1;

		const playerId = (record[ROSTER_COLUMNS.fantraxPlayerId] ?? '').trim();
		const playerName = (record[ROSTER_COLUMNS.playerName] ?? '').trim();
		const rawCapHit = (record[ROSTER_COLUMNS.capHit] ?? '').trim();
		const rawSlot = (record[ROSTER_COLUMNS.rosterSlot] ?? '').trim();
		const rawYears = (record[ROSTER_COLUMNS.contractYearsRemaining] ?? '').trim();

		if (playerId === '') {
			return refuse(rowNumber, `${ROSTER_COLUMNS.fantraxPlayerId} is blank.`);
		}
		if (playerName === '') {
			return refuse(rowNumber, `${ROSTER_COLUMNS.playerName} is blank.`);
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

		// Strip thousands separators before the core sees the value. The export
		// writes `25,000,000`; `parseMoney` accepts only an unpunctuated run of
		// digits and must not be loosened — a throw from it is a bug signal
		// (AD-1), not a validation path. Format belongs at the boundary, which
		// is here. Only separators are removed, so `25.5` or `25,00,0` still
		// refuse rather than silently becoming a number.
		let capHit: ParsedRosterRow['capHit'];
		try {
			capHit = parseMoney(rawCapHit.replace(/,/g, ''));
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

		// The export states an end year, not a count — see the module header.
		// A cell that is neither a recognised year shape nor already expired
		// refuses the row and names the cell, rather than being coerced into a
		// length nobody chose.
		const contract = contractCellFrom(rawYears);
		if (contract === null) {
			return refuse(
				rowNumber,
				`${ROSTER_COLUMNS.contractYearsRemaining} "${rawYears}" is not a contract end year (e.g. "2028") or a rookie-scale code (e.g. "2RK29") ending in or after ${String(CURRENT_CONTRACT_YEAR)}.`
			);
		}
		// No Postgres-integer ceiling check follows, and its absence is
		// deliberate. `CONTRACT_END_YEAR` admits at most four digits, so the
		// largest value this can yield is 9999 - CURRENT_CONTRACT_YEAR. The
		// `import_staged_rosters.contract_years_remaining` int4 column is
		// therefore unreachable by construction rather than by a guard, and a
		// guard that cannot fire is worse than none: it implies a risk that the
		// parse shape has already eliminated.

		rows.push({
			fantraxPlayerId: playerId,
			playerName,
			capHit,
			rosterSlotKind,
			contractYearsRemaining: contract.contractYearsRemaining,
			// `null` for an ordinary contract, and the DRAFT ROUND for a
			// rookie-scale code — the three characters FR-43's exception
			// turns on, carried into the domain as structured data rather
			// than left in a string only this adapter can read (AD-24).
			rookieScaleRound: contract.rookieScaleRound
		});
	}

	return { kind: 'parsed', rows };
}

function refuse(rowNumber: number, detail: string): RosterParseResult {
	return { kind: 'refused', rowNumber, detail };
}
