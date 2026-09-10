/**
 * One staged roster row, mapped to the core's domain shape — and the guard
 * that stands between the two (Stories 1.7, 7.6).
 *
 * What this file pins is a NON-widening. `RosterSlotKind` gained a fourth
 * member, `dead_money`, and `KNOWN_SLOT_KINDS` is a `readonly
 * RosterSlotKind[]` rather than a total record — so it typechecks at three
 * entries and at four alike, and nothing would have complained had the fourth
 * been added here. It must not be: Dead Money is produced by a Commissioner
 * Drop, never read off a Fantrax export, and `import_staged_rosters`'s own
 * three-value check constraint is what says so in the database. Widening this
 * array would make Dead Money importable and remove that backstop.
 */

import { describe, expect, it } from 'vitest';

import { KNOWN_SLOT_KINDS, toParsedRosterRow } from '../../src/lib/server/staged-roster-row.ts';

function staged(overrides: Record<string, unknown> = {}) {
	return {
		fantrax_player_id: '*P1*',
		player_name: 'Alice',
		cap_hit: '2000000',
		roster_slot_kind: 'active_bench',
		contract_years_remaining: 2,
		...overrides
	};
}

describe('toParsedRosterRow — the three importable slot kinds, and no fourth', () => {
	it('maps the three kinds a roster export can state', () => {
		for (const kind of ['active_bench', 'injury_reserve', 'minor_league'] as const) {
			expect(toParsedRosterRow(staged({ roster_slot_kind: kind })).rosterSlotKind).toBe(kind);
		}
	});

	it('holds exactly three kinds, and dead_money is not one of them', () => {
		expect([...KNOWN_SLOT_KINDS].sort()).toEqual([
			'active_bench',
			'injury_reserve',
			'minor_league'
		]);
		expect(KNOWN_SLOT_KINDS).not.toContain('dead_money');
	});

	it('THROWS on a staged dead_money row, naming the value it refused', () => {
		// Corruption or a wiring mistake, never a rule violation — so it
		// throws (AD-1), and inside the promotion transaction the throw rolls
		// the whole promotion back. Dropping the row would understate a Team's
		// Cap Hit total instead.
		expect(() => toParsedRosterRow(staged({ roster_slot_kind: 'dead_money' }))).toThrow(
			/not a known slot kind.*dead_money/
		);
	});

	it('carries no rookie-scale round through staging — the column does not exist', () => {
		// Stated rather than omitted, so the seam where the designation is
		// lost is visible at the line that loses it (Story 7.8 persists it).
		expect(toParsedRosterRow(staged()).rookieScaleRound).toBeNull();
	});
});
