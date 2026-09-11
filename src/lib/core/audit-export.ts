/**
 * The Audit Log's CSV serialisation (Story 7.5, FR-33).
 *
 * One function over `AuditRow[]` — the SAME rows the page renders, in the same
 * order, carrying the same rendered content. The export is a record of what
 * the Log said, read by a human; it is not a data interchange format and
 * nothing round-trips back through it.
 *
 * **These cells are ordinary strings, never `ExportCell`.**
 * `money.ts:229-239` reserves that brand for the Fantrax round-trip, where a
 * `$14.5M` cell would corrupt an import. Epic 6's exports keep the brand; this
 * one must never be reused as a Fantrax input, so it deliberately cannot
 * satisfy the type a Fantrax writer accepts.
 *
 * **The formula guard is the ONE place this CSV deliberately differs from the
 * page.** A cell a spreadsheet would evaluate as a formula is prefixed with an
 * apostrophe, so the text a reader sees in Excel, Numbers or Sheets is the text
 * the Log recorded rather than the result of executing it. Everything else in
 * every cell is byte-identical to what the page renders.
 *
 * No dependency: the serialisation is forty lines and a library would be a
 * supply-chain surface for it (and the spec's Ask First list names adding one).
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import type { AuditDetail, AuditRow } from './audit-log.ts';

/** RFC 4180's record separator. Excel is the reader that insists on it. */
const RECORD_SEPARATOR = '\r\n';

/** The header row, in the order the columns are written below. */
export const AUDIT_CSV_HEADERS: readonly string[] = Object.freeze([
	'Entry',
	'Recorded at',
	'Actor',
	'Event',
	'Summary',
	'Details'
]);

/** How the detail rows of one entry are joined into the one Details cell. */
const DETAIL_SEPARATOR = '; ';

/** The separator between a detail's label and what it says. */
const LABEL_SEPARATOR = ': ';

/**
 * The characters a spreadsheet treats as the start of a formula.
 *
 * `-` is on the list alongside `=`, `+` and `@` because a leading hyphen opens
 * a formula in every major spreadsheet. It costs this export nothing: the
 * Log's own negative figures are rendered with U+2212 MINUS SIGN
 * (`money.ts:46`), which is not this character and is not guarded.
 */
const FORMULA_LEADS: readonly string[] = Object.freeze(['=', '+', '-', '@']);

/** The prefix that neutralises one. Inert text in every spreadsheet. */
const FORMULA_GUARD = "'";

/**
 * Whitespace a spreadsheet skips before deciding a cell is a formula.
 *
 * The test runs AFTER trimming these, which is the whole point: `" =1+1"`
 * evaluates exactly as `"=1+1"` does, and a guard that only looked at index 0
 * would be bypassed by one space. `\s` rather than a literal space, because a
 * tab, a newline and a non-breaking space are all whitespace a cell can
 * legitimately hold and all of them are skipped the same way.
 */
const LEADING_WHITESPACE = /^\s+/;

/**
 * Neutralise a cell a spreadsheet would evaluate.
 *
 * Applied BEFORE quoting, so the apostrophe lands inside the quotes where the
 * spreadsheet will see it — a guard added after the closing quote would be
 * outside the field and would corrupt the row instead of protecting it.
 */
function guardFormula(value: string): string {
	const withoutLeadingSpace = value.replace(LEADING_WHITESPACE, '');
	const lead = withoutLeadingSpace.slice(0, 1);
	return FORMULA_LEADS.includes(lead) ? `${FORMULA_GUARD}${value}` : value;
}

/**
 * Quote one field: every field, always, and every inner quote doubled.
 *
 * Quoting unconditionally rather than only when a comma, quote or newline is
 * present. Deciding per cell is the version of this function that has a bug in
 * it, and an always-quoted file is valid RFC 4180 that every reader accepts.
 */
function quote(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

/** One cell: guarded, then quoted. The order is load-bearing — see above. */
export function auditCsvCell(value: string): string {
	return quote(guardFormula(value));
}

/**
 * One entry's detail rows, flattened into the single Details cell.
 *
 * **This cell is for reading, not for parsing.** The separators are ordinary
 * punctuation, and a detail value may legitimately contain either of them — a
 * Commissioner's free-text reason is the obvious case ("traded; see #bbsl-
 * general"). Nothing here escapes them, so splitting this cell back into
 * label/value pairs is not a supported operation and will mis-split on exactly
 * the entries that matter most.
 *
 * That is deliberate rather than an oversight. The alternative — escaping the
 * separators, or emitting one CSV row per detail — would either put escape
 * artefacts in front of a human reading a spreadsheet, or destroy the one-row-
 * per-event shape that makes the export legible at all. A consumer that needs
 * structure should read `auction_events` itself, which is the actual record;
 * this file is a rendering of it, and the spec says so in as many words.
 *
 * The CSV remains well-formed regardless: every cell is quoted and inner quotes
 * doubled, so a separator inside a value can never break the RECORD boundaries,
 * only the sub-structure within this one field.
 */
function detailsCell(details: readonly AuditDetail[]): string {
	return details
		.map((detail) => `${detail.label}${LABEL_SEPARATOR}${detail.value}`)
		.join(DETAIL_SEPARATOR);
}

/**
 * The rows, as CSV.
 *
 * Takes the FILTERED rows the page is showing and serialises exactly those, in
 * exactly that order: the export carries the filters in force because the
 * caller hands it the same array the page rendered, not because this function
 * re-derives anything.
 *
 * An empty list still produces the header row. A file with a header and no
 * records states "nothing matched"; a zero-byte file states "something went
 * wrong", and those must not look the same.
 */
export function auditRowsToCsv(rows: readonly AuditRow[]): string {
	const lines: string[] = [AUDIT_CSV_HEADERS.map(auditCsvCell).join(',')];
	for (const entry of rows) {
		lines.push(
			[
				entry.seq,
				entry.occurredAt,
				entry.actor.label,
				entry.typeLabel,
				entry.headline,
				detailsCell(entry.details)
			]
				.map(auditCsvCell)
				.join(',')
		);
	}
	// A trailing separator, so the last record ends the same way every other
	// record does and a reader that splits on it sees no ragged final line.
	return `${lines.join(RECORD_SEPARATOR)}${RECORD_SEPARATOR}`;
}
