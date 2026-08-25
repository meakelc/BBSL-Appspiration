/**
 * Recognising the Free Agent pool file by its name. Server-only, pure.
 *
 * The thirty-first file of the drop is not a Team's roster and must not be
 * put through `resolveTeamByFileName` — so the `/import` upload action asks
 * this question FIRST, for every file, and only falls through to Team
 * resolution when the answer is no (AD-28: the pool is one distinguished
 * source, keyed by pool).
 *
 * Matching is deliberately conservative and, like `team-registry.ts`'s and
 * the adapters' column maps, **a documented placeholder — TODO-confirm**
 * against a real Fantrax export (addendum.md B; 1.9/AR-33). It normalises
 * the file's stem the same way `team-registry.ts` does — lowercase
 * alphanumerics only, extension dropped — and says yes when that stem
 * contains `freeagent` or equals `pool`.
 *
 * **Why `pool` must be an exact-stem match and not a substring.** A real
 * BBSL Team could plausibly be named something containing "Pool"; a
 * substring rule would let this function shadow that Team's roster file and
 * silently stage it as the pool, which is a data-loss shape, not a
 * mismatch. `freeagent` is matched as a substring because no Team name
 * plausibly contains it and real exports append suffixes ("free-agents
 * -2026.csv"). `poolFileNameShadowsTeam` below is the refuse-not-guess
 * companion: when a file name would ALSO resolve to a Team, the upload
 * action refuses rather than picking a winner.
 */

import { POOL_SOURCE_LABEL } from '../core/rules/pool-import.ts';
import { resolveTeamByFileName } from './team-registry.ts';
import type { TeamRecord } from './team-registry.ts';

/** Strip everything but letters and digits, lowercased. Mirrors `team-registry.ts`. */
function normalize(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Drop a trailing filename extension, e.g. "pool.csv" -> "pool". Mirrors `team-registry.ts`. */
function stem(fileName: string): string {
	const dot = fileName.lastIndexOf('.');
	return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * Does this file name name the Free Agent pool? Pure — no database, no
 * Team list. See the module header for why the two rules differ in
 * strictness.
 */
export function isPoolFileName(fileName: string): boolean {
	const normalizedStem = normalize(stem(fileName));
	return normalizedStem.includes('freeagent') || normalizedStem === 'pool';
}

/**
 * What checking a file name for Team shadowing found. `null` means no
 * shadow — either the name does not read as the pool at all, or it reads as
 * the pool and resolves to no Team.
 */
export type PoolShadowResult =
	| { readonly kind: 'shadowed'; readonly team: TeamRecord }
	| { readonly kind: 'ambiguous'; readonly teams: readonly TeamRecord[] }
	| null;

/** The refusal sentence for a file name that names both the pool and a Team. */
export function poolShadowsTeamDetail(fileName: string, teamName: string): string {
	return `"${fileName}" names both the ${POOL_SOURCE_LABEL} and ${teamName}. Rename it so it names exactly one source.`;
}

/**
 * The refusal sentence for a pool-looking file name that resolves to more
 * than one Team. Names every candidate rather than picking one — the whole
 * point of refusing here is that the right answer is not knowable.
 */
export function poolShadowsTeamsDetail(
	fileName: string,
	teams: readonly TeamRecord[]
): string {
	return `"${fileName}" names both the ${POOL_SOURCE_LABEL} and more than one Team: ${teams
		.map((team) => team.name)
		.join(', ')}. Rename it so it names exactly one source.`;
}

/**
 * A file name that reads as the pool AND resolves to a Team is ambiguous —
 * the drop's thirty-first file must never silently shadow one of the thirty
 * (Boundaries & Constraints: "refuse-not-guess if a Team name would also
 * match"). Returns the Team it would have shadowed, or `null` when there is
 * no such conflict.
 *
 * Kept pure and separate from the fetch, exactly as `resolveTeamByFileName`
 * is, so a test drives it with a synthetic Team list and no database at all.
 */
export function poolFileNameShadowsTeam(
	teams: readonly TeamRecord[],
	fileName: string
): PoolShadowResult {
	if (!isPoolFileName(fileName)) return null;
	const match = resolveTeamByFileName(teams, fileName);
	// `resolveTeamByFileName` distinguishes `ambiguous` from `unmatched`
	// precisely so a caller can refuse rather than guess, and this function
	// exists to refuse. Collapsing `ambiguous` into "no shadow" would stage
	// as the pool exactly the file whose Team is least certain — the
	// data-loss shape the module header warns about, arrived at by the one
	// path that looked safe.
	if (match.kind === 'matched') return { kind: 'shadowed', team: match.team };
	if (match.kind === 'ambiguous') return { kind: 'ambiguous', teams: match.teams };
	return null;
}
