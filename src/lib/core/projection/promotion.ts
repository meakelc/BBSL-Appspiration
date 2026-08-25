/**
 * Promoted-ness, folded from the log (Story 1.11).
 *
 * **Why this is a fold and not a column read.** `import_team_sources.status`
 * and `import_pool_source.status` stay `'staged'` after a promotion — there
 * is no `promoted_at` and no promotion table — so `outstandingSourceNames`
 * (`server/import-status.ts`) answers *staged*, which is a different
 * question. A gate that collapsed the two would let a fully staged, never
 * promoted League open. The `ImportPromoted` payload already names every
 * Team it committed and the pool size it committed, so it answers this
 * gate's exact question.
 *
 * **Later promotions replace earlier ones wholesale.** Promotion is
 * all-or-nothing (AD-28): it deletes the live tables and rewrites them from
 * the staged sources in one transaction. A fold that merged two payloads
 * would therefore invent a state promotion never produces — the union of two
 * different re-imports. Each `ImportPromoted` event states the whole world as
 * of that promotion, so the fold takes the latest one and nothing else.
 *
 * This is the first reader of `ImportPromoted`: Story 1.9 appends it and
 * nothing folded it until now.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import type { Reducer } from './fold.ts';

/** The event type a successful promotion appends (`server/import-promotion.ts`). */
export const IMPORT_PROMOTED_EVENT = 'ImportPromoted';

/**
 * What the log says has been promoted.
 *
 * `promoted` is carried separately rather than inferred from the two lists
 * being empty: "no import has ever been promoted" and "a promotion committed
 * nothing" are different facts with different refusal sentences, and only
 * the flag distinguishes them.
 *
 * `teamIds` and `teamNames` are parallel and in the payload's own order,
 * which promotion states by Team name.
 */
export type PromotedSources = {
	readonly promoted: boolean;
	readonly teamIds: readonly string[];
	readonly teamNames: readonly string[];
	readonly poolSize: number;
};

/** With no `ImportPromoted` event, nothing has been promoted. */
export const INITIAL_PROMOTION: PromotedSources = Object.freeze({
	promoted: false,
	teamIds: Object.freeze([]) as readonly string[],
	teamNames: Object.freeze([]) as readonly string[],
	poolSize: 0
});

/**
 * Read an `ImportPromoted` payload defensively.
 *
 * `AppendedEvent.payload` is `unknown` — whatever JSON the column holds — and
 * an insert-only log cannot be corrected in place, so a malformed historical
 * row must never crash the fold. A payload that is not an object at all is
 * still evidence that a promotion happened, so it folds to a `promoted`
 * state naming nothing rather than being skipped: the gate then refuses with
 * every Team outstanding, which is the safe answer, instead of claiming no
 * import was ever promoted.
 */
function readPromotedPayload(payload: unknown): PromotedSources {
	if (typeof payload !== 'object' || payload === null) {
		return { promoted: true, teamIds: [], teamNames: [], poolSize: 0 };
	}
	const record = payload as Record<string, unknown>;
	const rawTeams = record['teams'];
	const teamIds: string[] = [];
	const teamNames: string[] = [];
	if (Array.isArray(rawTeams)) {
		for (const entry of rawTeams) {
			if (typeof entry !== 'object' || entry === null) continue;
			const team = entry as Record<string, unknown>;
			const id = team['teamId'];
			const name = team['teamName'];
			if (typeof id !== 'string' || id === '') continue;
			teamIds.push(id);
			// The name is audit detail the gate prints; the id is what it
			// matches on. A missing name falls back to the id, which still
			// identifies the Team, rather than dropping the Team entirely.
			teamNames.push(typeof name === 'string' && name !== '' ? name : id);
		}
	}
	const poolSize = record['poolSize'];
	return {
		promoted: true,
		teamIds,
		teamNames,
		poolSize: typeof poolSize === 'number' && Number.isFinite(poolSize) ? poolSize : 0
	};
}

/**
 * Fold one event onto promoted-ness.
 *
 * The `default: return state` discipline is `phase.ts`'s: an event type this
 * reducer has not been taught is not an error, it is simply not about
 * promotion. Replaying the same events twice converges, because each
 * `ImportPromoted` replaces the state rather than adding to it.
 */
export const promotedSourcesReducer: Reducer<PromotedSources> = (state, event) => {
	switch (event.type) {
		case IMPORT_PROMOTED_EVENT:
			return readPromotedPayload(event.payload);
		default:
			return state;
	}
};
