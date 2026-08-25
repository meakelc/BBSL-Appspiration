import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { SALARY_CAP } from '../../src/lib/core/constants.ts';
import { offGridCapSpaceDetail, renderCapSpace } from '../../src/lib/core/rules/import-preview.ts';
import { slotCeilingRefusalDetail } from '../../src/lib/core/rules/roster-import.ts';
import { ACTIVE_BENCH_SLOTS } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { loadImportPreview } from '../../src/lib/server/import-preview.ts';

/**
 * A fake PostgREST client answering the two reads `loadImportPreview` makes:
 * the `teams` embed of `import_staged_rosters`, and the single-row
 * `import_pool_status` view.
 *
 * It records the table names it was asked for, so "the preview reads
 * staging only and never a live table" is asserted rather than assumed.
 */
function fakeClient(options: {
	teams?: unknown[];
	teamsError?: string;
	poolRow?: { player_count: number } | null;
	poolError?: string;
}): { client: SupabaseClient; tables: string[] } {
	const tables: string[] = [];
	const client = {
		from(table: string) {
			tables.push(table);
			if (table === 'teams') {
				const query = {
					select: () => query,
					order: async () =>
						options.teamsError !== undefined
							? { data: null, error: { message: options.teamsError } }
							: { data: options.teams ?? [], error: null }
				};
				return query;
			}
			const query = {
				select: () => query,
				maybeSingle: async () =>
					options.poolError !== undefined
						? { data: null, error: { message: options.poolError } }
						: { data: options.poolRow ?? null, error: null }
			};
			return query;
		}
	} as unknown as SupabaseClient;
	return { client, tables };
}

function stagedRow(overrides: Record<string, unknown> = {}) {
	return {
		fantrax_player_id: 'p-1',
		player_name: 'Alice',
		cap_hit: 2_000_000,
		roster_slot_kind: 'active_bench',
		contract_years_remaining: 1,
		...overrides
	};
}

describe('loadImportPreview', () => {
	it('returns one preview per Team, sorted as the query ordered them, plus the pool size', async () => {
		const { client } = fakeClient({
			teams: [
				{
					id: 't-1',
					name: 'Celtics',
					import_staged_rosters: [
						stagedRow({ fantrax_player_id: 'p-1' }),
						stagedRow({ fantrax_player_id: 'p-2' })
					]
				},
				{ id: 't-2', name: 'Lakers', import_staged_rosters: [stagedRow({ cap_hit: 4_000_000 })] }
			],
			poolRow: { player_count: 214 }
		});

		const preview = await loadImportPreview(client);

		expect(preview.poolSize).toBe(214);
		expect(preview.teams.map((team) => team.teamName)).toEqual(['Celtics', 'Lakers']);
		expect(preview.teams[0]?.rosterCount).toBe(2);
		expect(preview.teams[0]?.capSpace).toBe(SALARY_CAP - 4_000_000);
		expect(preview.teams[1]?.rosterCount).toBe(1);
		expect(preview.teams[1]?.capSpace).toBe(SALARY_CAP - 4_000_000);
	});

	it('lists a Team with nothing staged, at zero rows against the full Cap', async () => {
		const { client } = fakeClient({
			teams: [{ id: 't-1', name: 'Lakers', import_staged_rosters: null }],
			poolRow: null
		});

		const preview = await loadImportPreview(client);

		expect(preview.teams).toEqual([
			{
				teamId: 't-1',
				teamName: 'Lakers',
				rosterCount: 0,
				capHitTotal: 0,
				capSpace: SALARY_CAP,
				capSpaceText: '$165.0M',
				offGridDetail: null,
				breachDetail: null,
				breaches: []
			}
		]);
		expect(preview.poolSize).toBe(0);
	});

	it('parses cap_hit at the boundary, whichever runtime shape it arrives in', async () => {
		// node-postgres hands an int8 back as a string, PostgREST as a number.
		const { client } = fakeClient({
			teams: [
				{
					id: 't-1',
					name: 'Lakers',
					import_staged_rosters: [
						stagedRow({ fantrax_player_id: 'p-1', cap_hit: '3000000' }),
						stagedRow({ fantrax_player_id: 'p-2', cap_hit: 1_000_000 })
					]
				}
			]
		});

		const preview = await loadImportPreview(client);
		expect(preview.teams[0]?.capHitTotal).toBe(4_000_000);
	});

	it('carries the slot-ceiling breaches through from the one checkSlotCeilings', async () => {
		const { client } = fakeClient({
			teams: [
				{
					id: 't-1',
					name: 'Lakers',
					import_staged_rosters: Array.from({ length: 13 }, (_unused, index) =>
						stagedRow({ fantrax_player_id: `p-${index}`, cap_hit: 0 })
					)
				}
			]
		});

		const preview = await loadImportPreview(client);
		expect(preview.teams[0]?.breaches).toEqual([
			{ slotKind: 'active_bench', count: 13, ceiling: 12 }
		]);
	});

	it('reads staging only — it never touches a live reference table', async () => {
		const { client, tables } = fakeClient({
			teams: [{ id: 't-1', name: 'Lakers', import_staged_rosters: [stagedRow()] }],
			poolRow: { player_count: 1 }
		});

		await loadImportPreview(client);

		expect(tables).not.toContain('team_rosters');
		expect(tables).not.toContain('free_agent_players');
		expect(tables).toEqual(['teams', 'import_pool_status']);
	});

	it('throws, naming the read, when the Team query fails', async () => {
		const { client } = fakeClient({ teamsError: 'connection reset' });
		await expect(loadImportPreview(client)).rejects.toThrow(/import preview read failed/);
	});

	it('throws, naming the read, when the pool size query fails', async () => {
		const { client } = fakeClient({ teams: [], poolError: 'connection reset' });
		await expect(loadImportPreview(client)).rejects.toThrow(/import preview pool read failed/);
	});

	it('throws rather than silently dropping a row whose slot kind is unrecognised', async () => {
		// Dropping it would understate the Cap Hit total and hide a ceiling
		// breach — corruption, not a rule violation, so it throws (AD-1).
		const { client } = fakeClient({
			teams: [
				{
					id: 't-1',
					name: 'Lakers',
					import_staged_rosters: [stagedRow({ roster_slot_kind: 'taxi_squad' })]
				}
			]
		});
		await expect(loadImportPreview(client)).rejects.toThrow(/not a known slot kind/);
	});

	/**
	 * The rendering is done here, server-side, so `+page.svelte` never
	 * re-implements the money rule. These two assert the text and the
	 * sentence are the pure core's own output verbatim — a second renderer
	 * anywhere would have to agree with `renderCapSpace` character for
	 * character to keep them passing, which is the point.
	 */
	it('renders Cap Space through the one core renderer, on the grid', async () => {
		const { client } = fakeClient({
			teams: [
				{ id: 't-1', name: 'Lakers', import_staged_rosters: [stagedRow({ cap_hit: 4_500_000 })] }
			]
		});

		const preview = await loadImportPreview(client);
		const expected = renderCapSpace(parseMoney(SALARY_CAP - 4_500_000));

		expect(expected.offGrid).toBe(false);
		expect(preview.teams[0]?.capSpaceText).toBe(expected.text);
		expect(preview.teams[0]?.offGridDetail).toBeNull();
	});

	it('renders an off-grid Cap Space in exact dollars and words the sentence server-side', async () => {
		const { client } = fakeClient({
			teams: [
				{ id: 't-1', name: 'Lakers', import_staged_rosters: [stagedRow({ cap_hit: 4_300_000 })] }
			]
		});

		const preview = await loadImportPreview(client);
		const expected = renderCapSpace(parseMoney(SALARY_CAP - 4_300_000));

		expect(expected.offGrid).toBe(true);
		expect(preview.teams[0]?.capSpaceText).toBe(expected.text);
		expect(preview.teams[0]?.offGridDetail).toBe(offGridCapSpaceDetail('Lakers', expected));
		// Named, and explicitly not a blocker.
		expect(preview.teams[0]?.offGridDetail).toContain('Lakers');
		expect(preview.teams[0]?.offGridDetail).toContain('does not block promotion');
	});

	/**
	 * The breach sentence is worded server-side by the ONE
	 * `slotCeilingRefusalDetail`, so the preview says exactly what the
	 * promotion refusal will say. The surface previously assembled it from
	 * the raw fields and printed the database slug `active_bench` where the
	 * glossary label is `Active/Bench` (review-loop-iteration 1).
	 */
	it('words a breach through the one slotCeilingRefusalDetail, in glossary labels', async () => {
		const rows = Array.from({ length: ACTIVE_BENCH_SLOTS + 1 }, (_unused, index) =>
			stagedRow({ fantrax_player_id: `p-${index}`, cap_hit: 0 })
		);
		const { client } = fakeClient({
			teams: [{ id: 't-1', name: 'Lakers', import_staged_rosters: rows }]
		});

		const preview = await loadImportPreview(client);
		const team = preview.teams[0];

		expect(team?.breachDetail).toBe(slotCeilingRefusalDetail(team?.breaches ?? []));
		expect(team?.breachDetail).toContain('Active/Bench');
		// The database's own slug must never reach the Commissioner.
		expect(team?.breachDetail).not.toContain('active_bench');
	});

	it('leaves the breach sentence null when every ceiling holds', async () => {
		const { client } = fakeClient({
			teams: [{ id: 't-1', name: 'Lakers', import_staged_rosters: [stagedRow({})] }]
		});
		const preview = await loadImportPreview(client);
		expect(preview.teams[0]?.breachDetail).toBeNull();
	});
});
