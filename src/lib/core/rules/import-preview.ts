/**
 * The per-Team import preview, and the three promotion refusal sentences.
 * Pure (Story 1.9).
 *
 * `previewTeam` is deliberately thin: it CALLS `computeCapSpace` and
 * `checkSlotCeilings` from `./roster-import.ts` rather than re-deriving
 * either. Cap Space has exactly one definition in this codebase and the
 * preview must show the same figure promotion refuses on — a second copy is
 * how a preview comes to say one thing and the commit another.
 *
 * `renderCapSpace` is where the $500,000 grid meets a real-world salary
 * figure. An imported Cap Hit carries whatever the export stated, so a
 * Team's Cap Space can legitimately land off the grid; `formatMoney` throws
 * on that by design (AD-8: fail loudly rather than round). The preview asks
 * `isOnMoneyGrid` first and renders exact integer dollars when the answer is
 * no, with the true minus sign — and that does NOT block commit. An off-grid
 * figure is information about the export, not a rule violation.
 *
 * `promotionRefusalDetail` holds all three refusal sentences so the route,
 * the promotion transaction and the tests read ONE wording, exactly as
 * `core/rules/pool-import.ts` does for the pool/roster conflict.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { MINIMUM_INCREMENT } from '../constants.ts';
import { formatMoney, isOnMoneyGrid } from '../money.ts';
import type { Money } from '../money.ts';
import type { ParsedRosterRow } from '../types.ts';
import { checkSlotCeilings, computeCapSpace, slotCeilingRefusalDetail } from './roster-import.ts';
import type { SlotCeilingBreach } from './roster-import.ts';

/**
 * U+2212 MINUS SIGN — not a hyphen. `core/money.ts` and
 * `core/rules/roster-import.ts` each keep their own copy of this character
 * for the same reason (neither exports it); this module holds an equivalent
 * constant rather than reaching into either module's internals.
 */
const MINUS_SIGN = '−';

/** What the preview reports for one Team, from its staged rows alone. */
export type TeamPreview = {
	/** The staged row count. Not a slot total, not a capacity — the rows staged. */
	readonly rosterCount: number;
	readonly capSpace: Money;
	readonly capHitTotal: Money;
	/** Empty when every slot ceiling holds. Non-empty is what promotion refuses on. */
	readonly breaches: readonly SlotCeilingBreach[];
};

/**
 * The preview for one Team's staged rows.
 *
 * Reads staging only — no live table is consulted, here or by this module's
 * caller. Before promotion there is nothing live to read; after it, the
 * preview must still describe what WOULD be committed, not what already was.
 */
export function previewTeam(rows: readonly ParsedRosterRow[]): TeamPreview {
	const { capSpace, capHitTotal } = computeCapSpace(rows);
	return {
		rosterCount: rows.length,
		capSpace,
		capHitTotal,
		breaches: checkSlotCeilings(rows)
	};
}

/** A rendered Cap Space figure, and whether it had to leave the grid to render. */
export type RenderedCapSpace = {
	readonly text: string;
	/**
	 * True when the amount is off the $500,000 grid and `text` is therefore
	 * exact integer dollars rather than the abbreviated one-decimal form. The
	 * surface states a sentence naming the Team and the figure when this is
	 * set. It never blocks commit.
	 */
	readonly offGrid: boolean;
};

/**
 * Render Cap Space for display: `formatMoney` when the amount is on the
 * grid, exact integer dollars otherwise.
 *
 * `$14.5M` is never rounded into existence — an off-grid amount is shown in
 * full, so the Commissioner sees the real figure and can go and fix the
 * export if they choose to.
 */
export function renderCapSpace(capSpace: Money): RenderedCapSpace {
	if (isOnMoneyGrid(capSpace)) {
		return { text: String(formatMoney(capSpace)), offGrid: false };
	}
	const magnitude = capSpace < 0 ? -capSpace : capSpace;
	return {
		text: `${capSpace < 0 ? MINUS_SIGN : ''}$${String(magnitude)}`,
		offGrid: true
	};
}

/**
 * The sentence stated beside an off-grid figure: names the Team and the
 * figure, and says plainly that it does not stop the import.
 */
export function offGridCapSpaceDetail(teamName: string, rendered: RenderedCapSpace): string {
	return (
		`${teamName}'s Cap Space is ${rendered.text}, which is not on the $${String(MINIMUM_INCREMENT)} grid ` +
		`and is shown in exact dollars. It does not block promotion.`
	);
}

// --- The three promotion refusals ----------------------------------------

/**
 * One Team whose staged rows breach a slot ceiling, named with its
 * arithmetic. EVERY offending Team is carried, not the first one found: a
 * refusal that names one Team at a time turns a thirty-file import into
 * thirty round trips, and "names what is offending, never a count" reads on
 * the whole set.
 */
export type TeamSlotBreach = {
	readonly teamName: string;
	readonly breaches: readonly SlotCeilingBreach[];
};

/**
 * Why promotion was refused.
 *
 * Three of the four are gates promotion re-derives inside its own
 * transaction: `outstanding` NAMES every source still missing, `breach`
 * names the Team and carries the arithmetic, and `phase` states the phase
 * that was folded from the log. Never a count (epic-1-context.md: "anything
 * outstanding is named, never counted").
 *
 * `unbound_actor` is the fourth, and it is decided BEFORE the transaction
 * opens rather than inside it: `auction_events.manager_id` and `team_id` are
 * both NOT NULL from the first event onward (AD-4), so an actor with no Team
 * binding has no event to append and must be refused rather than allowed to
 * fail on a constraint violation mid-transaction. It lives in this union
 * anyway so that the route does not word a refusal itself — it is the only
 * refusal the route raises, and it reads in the same voice as the other
 * three (review-loop-iteration 1).
 */
export type PromotionRefusal =
	| { readonly kind: 'outstanding'; readonly sourceNames: readonly string[] }
	| { readonly kind: 'breach'; readonly teams: readonly TeamSlotBreach[] }
	| { readonly kind: 'phase'; readonly phase: string }
	| { readonly kind: 'unbound_actor' };

/**
 * The one refusal sentence for each case, so the route, the promotion
 * transaction and the tests cannot word them differently.
 *
 * Product voice: state the fact, then the arithmetic. No apology, no
 * exclamation mark, no advice.
 */
export function promotionRefusalDetail(refusal: PromotionRefusal): string {
	switch (refusal.kind) {
		case 'outstanding':
			return (
				'Promotion was refused: every one of the thirty-one sources must be staged first. ' +
				`Outstanding: ${refusal.sourceNames.join(', ')}.`
			);
		case 'breach':
			return (
				'Promotion was refused: a staged Team breaches a slot ceiling. ' +
				refusal.teams
					.map((team) => `${team.teamName} — ${slotCeilingRefusalDetail(team.breaches)}`)
					.join(' ')
			);
		case 'phase':
			return (
				`Promotion was refused: the phase is ${refusal.phase}, not Setup. ` +
				"The League's data is imported during Setup only, and the phase is folded " +
				'from the event log inside this transaction.'
			);
		case 'unbound_actor':
			return (
				'Promotion was refused: the acting Manager is not bound to a Team, ' +
				'and every event must name one.'
			);
	}
}
