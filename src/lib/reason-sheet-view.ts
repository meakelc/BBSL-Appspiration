/**
 * The reason sheet, and every word it says (Story 7.1).
 *
 * The sheet is the interstitial that stands between a Commissioner control
 * and a committed override — DESIGN.md:236 counts it as one of the
 * Commissioner class's four properties, and `styles/commissioner.css:23-28`
 * records that Epic 1 shipped the persistent label in its place and left the
 * sheet to this story. It states the act in words, both states side by side,
 * the consequences that are not obvious from those states, and it takes a
 * reason it will not proceed without.
 *
 * **Every sentence lives here, not in `ReasonSheet.svelte`** — the
 * `core/strip.ts` / `PersistentStrip.svelte` precedent. `vite.config.ts` pins
 * `environment: 'node'` and no `.svelte` file renders under the suite, so
 * words asserted in a component are words asserted by reading source text.
 * Words asserted here are called and compared.
 *
 * **It is not in `core/`, and that is deliberate.** This is a rendering of an
 * override into a screen's worth of strings; the override itself, and the
 * rule that it cannot exist without a reason, are the core's
 * (`core/rules/override.ts`). Same split as `destinations-view.ts` against
 * `server/destinations.ts`. Nothing server-only is reachable from here.
 *
 * **Zero call sites.** No override control, route or event exists yet; Story
 * 7.2 renders the first sheet.
 */

import { OVERRIDE_REASON_FIELD } from './core/rules/override.ts';

/**
 * One before→after row, as the caller states it.
 *
 * `before` and `after` arrive already rendered into words — money through
 * `describeAmount` (AD-8), clocks through their own renderer. This module
 * pairs them; it does not format them, because a second money renderer is
 * exactly the divergence AD-8 exists to prevent.
 *
 * `attention` is a sentence, not a flag. A row whose change is obvious from
 * its own before and after carries `null`: the amber marker is the product's
 * single attention colour and it means something, so a sheet that marks every
 * row marks nothing. A row carries a sentence only when a consequence follows
 * that the two states do not show — "this removes the bid's League Clock
 * reset; the Auction Phase will end 5h 47m sooner".
 */
export type ReasonSheetRow = {
	readonly label: string;
	readonly before: string;
	readonly after: string;
	readonly attention: string | null;
};

/** Everything the caller must decide: what the act is, and what it changes. */
export type ReasonSheetInput = {
	/**
	 * The act, as one finished sentence — "Void the leading bid on Jalen
	 * Duren." The sheet never assembles this from parts: an act described by
	 * template is an act described the same way whether or not the template
	 * still fits it.
	 */
	readonly act: string;
	/** The commit control's own words. Never "Confirm" — it names the act. */
	readonly commitLabel: string;
	/** Every value the act changes. May be empty; the rows block then does not render. */
	readonly rows: readonly ReasonSheetRow[];
	/** Where Cancel goes. Always somewhere — leaving the sheet is never a dead end. */
	readonly cancelHref: string;
};

/** One row, paired and ready to render. */
export type ReasonSheetViewRow = {
	/**
	 * This row's identity in the rendered list.
	 *
	 * Derived from the row's POSITION, never from its words. Keying an
	 * `{#each}` on a label or a sentence means two rows that happen to read
	 * the same collide on a duplicate key — and "Leading bid" appearing twice,
	 * or the same consequence sentence attached to two Clocks, is an ordinary
	 * thing for an override to want to say, not a defect to guard against.
	 */
	readonly key: string;
	readonly label: string;
	/** `before → after`, in one string, so the component pairs nothing itself. */
	readonly change: string;
	/** This row's consequence sentence, or `null`. Rendered ON the row. */
	readonly attention: string | null;
};

/** The whole sheet, in words. */
export type ReasonSheetView = {
	readonly title: string;
	readonly act: string;
	readonly rowsHeading: string;
	readonly rows: readonly ReasonSheetViewRow[];
	/**
	 * Every row's consequence sentence, in row order. Empty when none.
	 *
	 * The sheet does NOT render this list — each sentence renders on the row
	 * it belongs to, so the Commissioner can see which value a consequence is
	 * about. This is the same set, flattened, for a caller that needs to ask
	 * "does this override have consequences at all" without walking the rows.
	 */
	readonly attentionNotes: readonly string[];
	readonly reasonLabel: string;
	/** The `name` the reason posts under — the guard's field, not a second literal. */
	readonly reasonFieldName: string;
	readonly cancelLabel: string;
	readonly cancelHref: string;
	readonly commitLabel: string;
	readonly auditFooter: string;
};

/**
 * The sheet's title.
 *
 * The same words on every override in the epic, because the sheet's first job
 * is to say which of the two people using this app is acting. The specific
 * act is the sentence below it.
 */
export const REASON_SHEET_TITLE = 'Commissioner override';

/** The before→after block's own heading. */
export const REASON_SHEET_ROWS_HEADING = 'Before → after';

/**
 * The reason field's label.
 *
 * Three facts, because all three change what gets typed: it is required, it
 * is permanent, and every Manager can read it. A Commissioner who believes
 * the box is a private note writes a different sentence than one who knows
 * the League will read it, and the second sentence is the one worth keeping.
 */
export const REASON_SHEET_FIELD_LABEL = 'Reason — required, permanent, readable by every Manager';

/** The Cancel control's words. Cancel is not a refusal; it is a way back. */
export const REASON_SHEET_CANCEL_LABEL = 'Cancel';

/**
 * The Audit Log footer.
 *
 * States what is written and that it cannot be unwritten — including by the
 * Commissioner, which is the half that matters. The Audit Log's own read
 * surface is Story 7.5; this sentence describes the record, and links to
 * nothing that does not exist yet.
 */
export const REASON_SHEET_AUDIT_FOOTER =
	'Written to the Audit Log with your name, the timestamp, both states and this reason. ' +
	'It cannot be edited or deleted afterwards, by you or anyone.';

/** Pair one row's two states into the single string the sheet shows. */
function change(row: ReasonSheetRow): string {
	return `${row.before} → ${row.after}`;
}

/**
 * A row's consequence sentence, or `null` if it has nothing to say.
 *
 * An empty or whitespace-only `attention` is treated as absent rather than
 * rendered: the amber bar is the product's single attention colour, and a bar
 * with no sentence in it marks a row as consequential while explaining
 * nothing — worse than no marker, because the reader looks for the reason and
 * finds a blank.
 */
function attentionOf(row: ReasonSheetRow): string | null {
	if (row.attention === null) return null;
	return row.attention.trim().length === 0 ? null : row.attention;
}

/**
 * Build the sheet.
 *
 * A pure mapping: the caller supplies the act and what it changes, this
 * supplies every word that is the same on every override. Nothing here knows
 * how the override commits, and nothing here validates the reason — the
 * reason is validated where it can actually be enforced, server-side
 * (`server/override-guard.ts`), over what was submitted rather than over what
 * was rendered.
 */
export function reasonSheetView(input: ReasonSheetInput): ReasonSheetView {
	const rows = input.rows.map((row, index) => ({
		key: `row-${index}`,
		label: row.label,
		change: change(row),
		attention: attentionOf(row)
	}));
	return {
		title: REASON_SHEET_TITLE,
		act: input.act,
		rowsHeading: REASON_SHEET_ROWS_HEADING,
		rows,
		attentionNotes: rows
			.map((row) => row.attention)
			.filter((note): note is string => note !== null),
		reasonLabel: REASON_SHEET_FIELD_LABEL,
		reasonFieldName: OVERRIDE_REASON_FIELD,
		cancelLabel: REASON_SHEET_CANCEL_LABEL,
		cancelHref: input.cancelHref,
		commitLabel: input.commitLabel,
		auditFooter: REASON_SHEET_AUDIT_FOOTER
	};
}
