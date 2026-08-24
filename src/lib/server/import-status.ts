/**
 * The full per-Team import status list. Server-only.
 *
 * Joins `teams` × `import_team_sources` so the whole matrix — staged,
 * refused, outstanding — reads from one place: the `/import` route's `load`,
 * and later 1.11's auction-open gate. AC5 ("status has persisted and
 * re-supply replaces only that Team's rows") is provable because this reads
 * the exact `import_team_sources` row `server/roster-import.ts`'s
 * transaction writes — there is no second, in-memory copy of status that
 * could drift from it across a refresh.
 *
 * A Team with no `import_team_sources` row, or one whose status is not
 * `'staged'`, resolves to `'outstanding'` here — the one place "staged vs.
 * outstanding" is decided, so a caller never re-derives it from a raw status
 * string.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { serviceRoleClient } from './supabase.ts';

/** A Team's import status, as this surface names it. */
export type ImportStatus = 'staged' | 'refused_file' | 'refused_content' | 'outstanding';

/** One Team's row on the import status list. */
export type TeamImportStatus = {
	readonly teamId: string;
	readonly teamName: string;
	readonly status: ImportStatus;
	readonly fileName: string | null;
	readonly refusalDetail: string | null;
	readonly updatedAt: string | null;
};

type SourceRow = {
	readonly file_name: string;
	readonly status: string;
	readonly refusal_detail: string | null;
	readonly updated_at: string;
};

type TeamRow = {
	readonly id: string;
	readonly name: string;
	// A many-to-one embed (`import_team_sources.team_id` -> `teams.id`, itself
	// the PK) resolves to a single object or null, never an array — but
	// nothing enforces that shape at the type level, so a defensive array
	// case is handled below, mirroring `managerRegistry`'s teams embed.
	readonly import_team_sources: SourceRow | SourceRow[] | null;
};

/** Every Team, joined against its most recent import outcome, sorted by name. */
export async function loadImportStatus(
	client: SupabaseClient = serviceRoleClient()
): Promise<readonly TeamImportStatus[]> {
	const { data, error } = await client
		.from('teams')
		.select('id, name, import_team_sources(file_name, status, refusal_detail, updated_at)')
		.order('name', { ascending: true });

	if (error !== null) {
		throw new Error(`import status read failed: ${error.message}`);
	}

	return ((data ?? []) as TeamRow[]).map((row) => {
		const source = Array.isArray(row.import_team_sources)
			? (row.import_team_sources[0] ?? null)
			: row.import_team_sources;

		return {
			teamId: row.id,
			teamName: row.name,
			status: (source?.status as ImportStatus | undefined) ?? 'outstanding',
			fileName: source?.file_name ?? null,
			refusalDetail: source?.refusal_detail ?? null,
			updatedAt: source?.updated_at ?? null
		};
	});
}

/** Team names whose status is not `'staged'` — the "named, never counted" list. */
export function outstandingTeamNames(statuses: readonly TeamImportStatus[]): readonly string[] {
	return statuses.filter((entry) => entry.status !== 'staged').map((entry) => entry.teamName);
}
