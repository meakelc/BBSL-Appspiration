/**
 * The one refusal sentence for a Player present in both the Free Agent pool
 * and a Team's staged roster (Story 1.8).
 *
 * **Why this is its own pure module rather than a string built at each call
 * site.** The conflict is checked in BOTH directions — when the pool is
 * staged against already-staged rosters (`server/pool-import.ts`), and when
 * a roster is staged against an already-staged pool
 * (`server/roster-import.ts`) — because a thirty-one-file drop arrives in
 * arbitrary browser order and acceptance must not depend on which file
 * happens to be second (see this story's Design Notes). Two call sites
 * wording the same refusal independently is exactly how they drift; both
 * import this function, so the Commissioner reads the same sentence
 * whichever file lost.
 *
 * Product voice: state the fact, then the specifics. No apology, no
 * exclamation mark.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

/**
 * How the pool is named on every surface — status list, refusals, gates.
 *
 * It lives in the pure core rather than in `server/pool-import.ts` because
 * the server modules that need it are otherwise unrelated: importing it from
 * the staging module dragged that module's `csv-parse` dependency into
 * `server/import-status.ts`'s graph for the sake of one string. Every
 * server-side caller reads it from here instead, so the label is written
 * exactly once. (`+page.svelte` still spells it out: no `.svelte` file may
 * reach a server-only module, and the core is loaded by both runtimes but
 * not by the client bundle here.)
 */
export const POOL_SOURCE_LABEL = 'Free Agent pool';

/**
 * One Player found in both the pool and a Team's staged roster. Named by
 * Player and by Team, as the refusal must name both.
 */
export type PoolRosterConflict = {
	readonly playerName: string;
	readonly teamName: string;
};

/**
 * The refusal sentence for one or more pool/roster conflicts.
 *
 * Callers only reach this with a non-empty list — a conflict-free check
 * returns no conflicts and never refuses — but an empty list still produces
 * an honest sentence rather than a ragged fragment, so a future caller
 * cannot render `"" `.
 */
export function poolConflictRefusalDetail(conflicts: readonly PoolRosterConflict[]): string {
	if (conflicts.length === 0) {
		return `No Player appears in both the ${POOL_SOURCE_LABEL} and a Team roster.`;
	}

	// "on the Lakers roster", never "on Lakers's roster" — most BBSL Team
	// names are plural, and the possessive form reads as a typo on every one
	// of them.
	const specifics = conflicts
		.map((conflict) => `${conflict.playerName} is on the ${conflict.teamName} roster`)
		.join('; ');

	const subject =
		conflicts.length === 1
			? 'A Player cannot be both a Free Agent and on a Team roster'
			: 'Players cannot be both Free Agents and on a Team roster';

	return `${subject}: ${specifics}.`;
}
