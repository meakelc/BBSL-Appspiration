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
 *
 * **Story 1.8 folds the Free Agent pool in as a thirty-first source.**
 * `loadPoolStatus` reads the singleton `import_pool_source` row (plus the
 * staged pool's size, which the surface states for explicit confirmation),
 * and `outstandingSourceNames` names the pool alongside any outstanding
 * Teams so 1.11's gate reads ONE list rather than joining two. The existing
 * `outstandingTeamNames` is untouched and `outstandingSourceNames` is
 * written in terms of it — the "staged vs. outstanding" rule is still
 * decided in exactly one place (1.7 change-log item 8).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { POOL_SOURCE_LABEL } from '../core/rules/pool-import.ts';
import { serviceRoleClient } from './supabase.ts';

/** A Team's import status, as this surface names it. */
export type ImportStatus = 'staged' | 'refused_file' | 'refused_content' | 'outstanding';

/**
 * The same four values at runtime, so a status string read back from the
 * database can be checked rather than cast. A bare `as ImportStatus` on a
 * database string asserts something TypeScript cannot know.
 */
const KNOWN_IMPORT_STATUSES: readonly ImportStatus[] = Object.freeze([
	'staged',
	'refused_file',
	'refused_content',
	'outstanding'
]);

/** One row of `import_pool_status` — the pool's status and size in one snapshot. */
type PoolStatusRow = {
	readonly file_name: string;
	readonly status: string;
	readonly refusal_detail: string | null;
	readonly updated_at: string;
	readonly player_count: number;
};

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


// --- Story 1.8: the Free Agent pool as the thirty-first source ------------

/**
 * The Free Agent pool's row on the import status list. Shaped like
 * `TeamImportStatus` minus the Team identity (the pool is one source, keyed
 * by pool — AD-28) plus `playerCount`, the pool size the surface states for
 * explicit confirmation.
 */
export type PoolImportStatus = {
	readonly status: ImportStatus;
	readonly fileName: string | null;
	readonly refusalDetail: string | null;
	readonly updatedAt: string | null;
	readonly playerCount: number;
};

/**
 * The pool's status and its staged size. Two reads rather than an embed:
 * `import_staged_pool_players` has no foreign key to `import_pool_source`
 * (the pool is a singleton, not a parent row), so PostgREST has no
 * relationship to embed across. The count is requested `head: true` — the
 * rows themselves are never wanted here, only how many there are.
 *
 * A missing status row means the pool has never been supplied:
 * `'outstanding'`, with every field null and a count of zero.
 */
export async function loadPoolStatus(
	client: SupabaseClient = serviceRoleClient()
): Promise<PoolImportStatus> {
	// ONE statement, so status and size come from one snapshot. Read as two
	// queries these could disagree — a re-stage committing between them
	// returns a size belonging to a different stage than the status beside
	// it, and that size is precisely the figure the Commissioner confirms.
	// `import_pool_status` is the view that collapses them; see its comment
	// in the migration.
	const { data, error } = await client
		.from('import_pool_status')
		.select('file_name, status, refusal_detail, updated_at, player_count')
		.maybeSingle();

	if (error !== null) {
		throw new Error(`pool import status read failed: ${error.message}`);
	}

	const source = (data ?? null) as PoolStatusRow | null;

	// A status string outside the known set is a defect somewhere upstream,
	// not a new state to render: fall back to 'outstanding', which under-
	// claims rather than over-claims — the pool reads as not yet supplied and
	// stays named on the outstanding list, instead of silently passing a gate.
	const rawStatus = source?.status;
	const status: ImportStatus =
		rawStatus !== undefined && KNOWN_IMPORT_STATUSES.includes(rawStatus as ImportStatus)
			? (rawStatus as ImportStatus)
			: 'outstanding';

	return {
		status,
		fileName: source?.file_name ?? null,
		refusalDetail: source?.refusal_detail ?? null,
		updatedAt: source?.updated_at ?? null,
		playerCount: source?.player_count ?? 0
	};
}

/**
 * Every source not yet staged, named — Teams first, then the Free Agent pool
 * (epic-1-context.md: "anything outstanding is named, never counted"). This
 * is the one list 1.11's auction-open gate reads; `outstandingTeamNames`
 * stays as the Team-only view, and this function calls it rather than
 * re-deriving the rule.
 */
export function outstandingSourceNames(
	statuses: readonly TeamImportStatus[],
	poolStatus: PoolImportStatus
): readonly string[] {
	const names = [...outstandingTeamNames(statuses)];
	if (poolStatus.status !== 'staged') names.push(POOL_SOURCE_LABEL);
	return names;
}
