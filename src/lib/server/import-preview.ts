/**
 * Reading staging into the per-Team import preview. Server-only (Story 1.9).
 *
 * **Staging only.** This module reads `teams`, `import_staged_rosters` and
 * the pool's staged size, and NOTHING live. Before promotion there is no
 * live row to read; after it, the preview must still describe what WOULD be
 * committed by the next promotion, not what already was — reading
 * `team_rosters` here would make the preview agree with itself even when the
 * staged sources had drifted away from what was promoted.
 *
 * Reads go through PostgREST/the service-role client, exactly as
 * `import-status.ts` does — this is a read, not a write path, and
 * `service_role` already holds `SELECT`.
 *
 * `cap_hit` is parsed through `parseMoney` HERE, at the boundary (AD-8): the
 * same `int8` arrives as a string through node-postgres and a number through
 * PostgREST, and the pure core is handed branded `Money` or nothing. The
 * arithmetic itself is `core/rules/import-preview.ts`'s `previewTeam`, which
 * in turn calls the one `computeCapSpace`/`checkSlotCeilings` pair — nothing
 * in this file re-derives either.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { offGridCapSpaceDetail, previewTeam, renderCapSpace } from '../core/rules/import-preview.ts';
import { slotCeilingRefusalDetail } from '../core/rules/roster-import.ts';
import type { TeamPreview } from '../core/rules/import-preview.ts';
import { serviceRoleClient } from './supabase.ts';
import { toParsedRosterRow } from './staged-roster-row.ts';

/**
 * One Team's preview row, with the identity the surface names it by and its
 * Cap Space **already rendered**.
 *
 * The rendering happens here rather than in `+page.svelte` so
 * `renderCapSpace` keeps exactly one definition. A `.svelte` file may not
 * reach a server-only module, but it equally must not re-implement the
 * money rule to work around that — the server hands it finished text, the
 * same way the batch results and the pool row already arrive as sentences.
 */
export type TeamPreviewRow = {
	readonly teamId: string;
	readonly teamName: string;
	/** Cap Space as the surface prints it — `$14.5M`, or exact dollars when off-grid. */
	readonly capSpaceText: string;
	/** The off-grid sentence naming this Team, or null when the figure is on the grid. */
	readonly offGridDetail: string | null;
	/**
	 * The slot-ceiling sentence, or null when every ceiling holds — worded by
	 * the one `slotCeilingRefusalDetail`, so the preview states a breach in
	 * exactly the words the promotion refusal will use, with the glossary's
	 * slot labels rather than the database's `active_bench` slugs. A surface
	 * that assembled this from the raw fields would be a second copy of the
	 * sentence, free to drift from the refusal (review-loop-iteration 1).
	 */
	readonly breachDetail: string | null;
} & TeamPreview;

/** The whole preview: every Team, sorted by name, plus the staged pool size. */
export type ImportPreview = {
	readonly teams: readonly TeamPreviewRow[];
	readonly poolSize: number;
};

type StagedRosterRow = {
	readonly fantrax_player_id: string;
	readonly player_name: string;
	readonly cap_hit: string | number;
	readonly roster_slot_kind: string;
	readonly contract_years_remaining: number;
	/** The draft round of a rookie-scale Contract, or `null` (Story 7.8). */
	readonly rookie_scale_round: number | null;
};

type TeamRow = {
	readonly id: string;
	readonly name: string;
	readonly import_staged_rosters: StagedRosterRow[] | null;
};

/**
 * Every Team's preview from staging, sorted by Team name, plus the staged
 * Free Agent pool's size.
 *
 * A Team with nothing staged is still listed, with a roster count of zero
 * and the full Salary Cap as Cap Space — it is outstanding, and the status
 * list above the preview is what names it as such. Omitting it would make
 * "all thirty Teams are reported" depend on the import being complete.
 */
export async function loadImportPreview(
	client: SupabaseClient = serviceRoleClient()
): Promise<ImportPreview> {
	const teamsResult = await client
		.from('teams')
		.select(
			'id, name, import_staged_rosters(fantrax_player_id, player_name, cap_hit, roster_slot_kind, contract_years_remaining, rookie_scale_round)'
		)
		.order('name', { ascending: true });

	if (teamsResult.error !== null) {
		throw new Error(`import preview read failed: ${teamsResult.error.message}`);
	}

	const teams = ((teamsResult.data ?? []) as TeamRow[]).map((team) => {
		const rows = (team.import_staged_rosters ?? []).map(toParsedRosterRow);
		const preview = previewTeam(rows);
		const rendered = renderCapSpace(preview.capSpace);
		return {
			teamId: team.id,
			teamName: team.name,
			capSpaceText: rendered.text,
			offGridDetail: rendered.offGrid ? offGridCapSpaceDetail(team.name, rendered) : null,
			breachDetail:
				preview.breaches.length > 0 ? slotCeilingRefusalDetail(preview.breaches) : null,
			...preview
		};
	});

	// The pool's size only — its status is `loadPoolStatus`'s job, read from
	// the one-statement `import_pool_status` view so status and size cannot
	// disagree (Story 1.8, review-loop-iteration 1). This is the same figure
	// from the same view; only the count is wanted here.
	const poolResult = await client.from('import_pool_status').select('player_count').maybeSingle();

	if (poolResult.error !== null) {
		throw new Error(`import preview pool read failed: ${poolResult.error.message}`);
	}

	const poolSize = ((poolResult.data ?? null) as { player_count: number } | null)?.player_count ?? 0;

	return { teams, poolSize };
}
