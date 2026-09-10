/**
 * Mapping one `import_staged_rosters` row to the core's `ParsedRosterRow`.
 * Server-only.
 *
 * **One definition, two readers.** `server/import-preview.ts` reads staged
 * rows through PostgREST and `server/import-promotion.ts` reads them through
 * the `pg` connection inside the promotion transaction, but both need the
 * same three things from a row: the slot kind checked rather than cast, the
 * cap hit parsed at the boundary through `core/money.ts`, and the rest
 * carried across unchanged. Each module previously held its own copy, down
 * to the error string — two copies of a corruption guard that must agree,
 * with nothing making them agree (review-loop-iteration 1).
 *
 * The two callers hand rows in shaped by their own driver — PostgREST gives
 * an `int8` back as a number, `pg` as a string — so this takes the loose
 * shape and lets `parseMoney` refuse anything that is neither.
 */

import { parseMoney } from '../core/money.ts';
import type { ParsedRosterRow, RosterSlotKind } from '../core/types.ts';

/**
 * The three IMPORTABLE roster slot kinds at runtime, so a value read back from
 * the database is checked rather than cast. The column carries a check
 * constraint admitting exactly these, but a bare `as RosterSlotKind` on a
 * database string asserts something TypeScript cannot know — and this one
 * feeds a slot-ceiling count, where a silently unrecognised kind would
 * simply vanish from the arithmetic.
 *
 * **Three, not four, and it stays at three** (Story 7.6). `RosterSlotKind`
 * gained `dead_money`, and this array typechecks either way — it is a
 * `readonly RosterSlotKind[]`, not a total record, so nothing here would have
 * complained had the fourth been added. Adding it would make Dead Money
 * importable, which is exactly what `import_staged_rosters`'s own
 * three-value check constraint exists to forbid: Dead Money is produced by a
 * Commissioner Drop, never read off an export. A staged row claiming it is
 * corruption or a wiring mistake, and the throw below is the right answer.
 */
export const KNOWN_SLOT_KINDS: readonly RosterSlotKind[] = Object.freeze([
	'active_bench',
	'injury_reserve',
	'minor_league'
]);

/**
 * One staged roster row, as either driver hands it back.
 *
 * An index signature rather than five named fields: `pg` types a row as
 * `Record<string, unknown>`, which does not structurally satisfy a type
 * with required named properties, and widening the promotion path's row
 * type just to satisfy this signature would be the tail wagging the dog.
 * The five columns are read by name below and every one is validated or
 * converted there, so nothing is lost by accepting the looser shape.
 */
export type StagedRosterRowShape = { readonly [column: string]: unknown };

/**
 * Map one staged row to the core's domain shape, refusing an unrecognised
 * slot kind loudly.
 *
 * Corruption or a wiring mistake, never a rule violation — so it throws
 * (AD-1). The alternative, dropping the row, would understate a Team's Cap
 * Hit total and hide a ceiling breach; inside the promotion transaction the
 * throw rolls the whole promotion back, which is the correct outcome for
 * staged data that cannot be trusted.
 */
export function toParsedRosterRow(row: StagedRosterRowShape): ParsedRosterRow {
	const slotKind = String(row['roster_slot_kind']) as RosterSlotKind;
	if (!KNOWN_SLOT_KINDS.includes(slotKind)) {
		throw new Error(
			`import_staged_rosters.roster_slot_kind is not a known slot kind: ${JSON.stringify(row['roster_slot_kind'])}`
		);
	}
	return {
		fantraxPlayerId: String(row['fantrax_player_id']),
		playerName: String(row['player_name']),
		capHit: parseMoney(row['cap_hit']),
		rosterSlotKind: slotKind,
		contractYearsRemaining: Number(row['contract_years_remaining']),
		// **`null`, and stated rather than omitted.** `import_staged_rosters`
		// has no column for the rookie-scale round: the designation is parsed
		// by the adapter and read by the import preview, and nothing between
		// staging and the live roster consumes it in v1. Writing it out here
		// makes the loss visible at the seam where it happens, so the story
		// that needs it persisted (7.8's Drop) has one line to change rather
		// than an absence to notice.
		rookieScaleRound: null
	};
}
