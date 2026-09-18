/**
 * The per-process cache behind `hooks.server.ts`'s phase-and-watermark read.
 * Server-only.
 *
 * **The problem it exists for.** `resolveLeagueRead` folds the ENTIRE
 * `auction_events` log, and `hooks.server.ts` calls it on every request — to
 * produce two values, a phase string and a `seq`. That includes
 * `GET /api/watermark`, which every signed-in Manager polls every ten seconds
 * (`LIVENESS_INTERVAL`). `server/watermark.ts`'s own header states the rule
 * this violated: folding the log "every ten seconds would make the cheapest
 * question in the product the most expensive query in it". The endpoint was
 * built to read one row; the hook in front of it read the whole log first, so
 * egress was (requests x log size) with both terms growing all season.
 *
 * **What it does.** One live `max(seq)` read per request. If that equals the
 * `seq` the cached fold state was folded through, the cached values are
 * returned and not one event row crosses the wire. If it is higher, only the
 * events ABOVE it are fetched and folded onto the state already held.
 *
 * **Why that is not a weakening of AD-5.** AD-5 requires projections to be
 * folded from the whole log, and they still are: `phaseReducer` and
 * `watermarkReducer` are left folds in `seq` order, and `fold()`'s own header
 * names folding a tail onto loaded state and replaying from empty as the SAME
 * function. `fold(fold(INITIAL, below), above)` is `fold(INITIAL, whole)`.
 * What makes the cached half trustworthy is AD-4, not an assumption: the log
 * is insert-only and NO role holds UPDATE or DELETE on it, so an unchanged
 * `max(seq)` is proof of an unchanged prefix, not merely evidence of one.
 * A projection that folded mutable reference data could not do this; these
 * two read nothing but the log.
 *
 * **Why `max(seq)` and not `auction_watermark`.** `readWatermark` is reused
 * rather than reading the trigger-maintained cache row, for the reason its own
 * header gives: the log's `max(seq)` is what AD-29 calls the source, and the
 * server never has to depend on the trigger being correct. It is one row off
 * the primary key index either way.
 *
 * **The check is also the liveness proof.** The value of the hook's read was
 * never only the phase — a request that reaches this code and gets an answer
 * has demonstrably reached Postgres. A cache hit still performs that round
 * trip, so nothing here can report a phase from a database it can no longer
 * see. A cache that skipped the query would be faster and would be lying.
 *
 * **It is process-local and needs no invalidation.** Two Netlify instances
 * holding different states is not a coherence problem: each re-reads
 * `max(seq)` on every request and converges on the same answer within that
 * request. Nothing is shared, nothing expires, and a cold instance simply
 * takes the full read once.
 *
 * The mechanism itself — the slot, the `seq` comparison, the rebuild-on-a
 * -backwards-watermark guard and the argument that all of it preserves AD-5 —
 * lives in `fold-cache.ts`, which the tick's own loaders share. This module is
 * only the two reducers and the two ports.
 */

import { INITIAL_PHASE, phaseReducer } from '../core/projection/phase.ts';
import type { LeaguePhase } from '../core/projection/phase.ts';
import { INITIAL_WATERMARK, watermarkReducer } from '../core/projection/watermark.ts';
import { fold } from '../core/projection/fold.ts';
import { loadAppendedEventsSince } from './event-log.ts';
import { foldCacheSlot, foldIncrementally } from './fold-cache.ts';
import { phaseOf } from './phase.ts';
import type { ResolvedLeagueRead } from './phase.ts';
import { serviceRoleClient } from './supabase.ts';
import { readWatermark } from './watermark.ts';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The two reducer accumulators this module carries between requests.
 *
 * The EVENTS are deliberately not retained. Both reducers accumulate into a
 * single small value (a phase string, a `seq` string), so holding the log in a
 * long-lived Function instance would cost memory growing with the season to
 * answer a question the accumulators already answer.
 */
type LeagueFold = {
	/** `phaseReducer`'s accumulator, before `phaseOf` renders it. */
	readonly phase: LeaguePhase;
	/** `watermarkReducer`'s accumulator. */
	readonly watermark: string;
};

/** Module scope IS the process-local cache. */
const slot = foldCacheSlot<LeagueFold>();

/**
 * The phase and the global watermark, folded from the whole log, transferring
 * only the part of it this process has not already folded.
 *
 * Throws on any read failure, exactly as `resolveLeagueRead` does — the
 * fail-closed wrapper is `resolveLeagueReadCachedOrDefault` below.
 *
 * `client` is injectable, the same shape `resolveLeagueRead` uses, so a test
 * drives it against a fake without a live database.
 */
export async function resolveLeagueReadCached(
	client: SupabaseClient = serviceRoleClient()
): Promise<ResolvedLeagueRead> {
	const folded = await foldIncrementally<LeagueFold>({
		slot,
		// `readWatermark` is reused rather than the trigger-maintained
		// `auction_watermark` row, for the reason its own header gives: the
		// log's `max(seq)` is what AD-29 calls the source, so the server never
		// has to depend on the trigger being correct. One row off the primary
		// key index either way.
		liveSeq: async () => (await readWatermark(client)).watermark,
		loadSince: (since) => loadAppendedEventsSince(client, since),
		initial: { phase: INITIAL_PHASE, watermark: INITIAL_WATERMARK },
		extend: (state, events) => ({
			phase: fold(state.phase, events, phaseReducer),
			watermark: fold(state.watermark, events, watermarkReducer)
		})
	});

	return { phase: phaseOf(folded.phase), watermark: folded.watermark };
}

/**
 * The same read, failing closed to Setup and `'0'` on any read failure.
 *
 * Identical in contract to `resolveLeagueReadOrDefault`, which it replaces in
 * `hooks.server.ts`, including why `client` takes no default parameter: a
 * default-parameter expression runs before the function body, so a throwing
 * `serviceRoleClient()` there would reject before the `try` ever ran, which is
 * the single most likely real failure this wrapper exists to catch.
 */
export async function resolveLeagueReadCachedOrDefault(
	client?: SupabaseClient
): Promise<ResolvedLeagueRead> {
	try {
		return await resolveLeagueReadCached(client ?? serviceRoleClient());
	} catch {
		return { phase: phaseOf(INITIAL_PHASE), watermark: INITIAL_WATERMARK };
	}
}

/**
 * Discard the cached fold. For tests only — nothing in production has a reason
 * to call it, because `resolveLeagueReadCached` already re-reads `max(seq)` on
 * every request and rebuilds whenever that read says to.
 */
export function resetLeagueReadCache(): void {
	slot.held = null;
}
