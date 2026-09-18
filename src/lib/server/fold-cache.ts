/**
 * The generic "fold the log, but transfer only what this process has not
 * already folded" machinery. Server-only.
 *
 * **Why this exists.** Reading the whole of `auction_events` to answer a
 * question is correct and was, by mid-season, the dominant cost of running
 * this app: `hooks.server.ts` did it on every request, and the tick does it
 * three times every ten seconds — so egress was (reads x log size), with both
 * terms growing all season and neither bounded by anything.
 *
 * **What it changes, and what it does not.** It changes how many rows cross
 * the wire. It does not change what is folded: AD-5's "fold the entire log by
 * `seq`" still holds, because `fold()`'s own header names folding a tail onto
 * loaded state and replaying from empty as the SAME function, and every
 * reducer this is used with is a left fold in `seq` order:
 *
 *     fold(fold(INITIAL, below), above)  ===  fold(INITIAL, whole)
 *
 * **AD-4 is what makes the cached half sound, and it is a proof rather than
 * an assumption.** `auction_events` is insert-only and NO role holds UPDATE or
 * DELETE on it, so an unchanged `max(seq)` means an unchanged prefix — not
 * merely a prefix that probably did not change. A cache over a mutable table
 * could not make this argument. **This is therefore only safe for a fold whose
 * every input is the log.** A projection folded against mutable reference data
 * must not use it — the events would say nothing about the reference row
 * moving underneath. (Every caller today folds events alone; AD-33's point
 * reads sit BESIDE such folds and are re-read per pass regardless.)
 *
 * **AD-6's single global write lock is what makes an INCREMENTAL read safe,
 * and it is the dependency most easily broken from a distance.** A bounded
 * `seq > $1` read has a hazard a whole-log read does not: if two writers could
 * overlap, one could be assigned `seq` 11 and commit while `seq` 10 was still
 * in flight, so a reader would see 11, record itself as folded through 11, and
 * skip 10 forever. That cannot happen here — `shell/write.ts` holds
 * `pg_advisory_xact_lock` from before the insert until `COMMIT`, and it is the
 * ONLY writer to `auction_events` in this codebase — so `seq` order and commit
 * order are the same order, exactly as AD-5 states. `tests/structure.test.ts`
 * pins the single-writer half of that, because a second insert site added
 * outside the lock would break this file silently and at a distance.
 *
 * **The live `seq` read is not merely a cache key, it is the liveness proof.**
 * Every call performs it, including a hit. A caller can therefore never report
 * a folded answer from a database this request could not reach — which is the
 * property `hooks.server.ts` always had for free by reading the log, and the
 * one a cache would quietly destroy by answering from memory alone.
 *
 * **Each caller owns its own slot.** The state lives in a slot the caller
 * declares at module scope, not in a registry here, so nothing shares a cache
 * by accident and every cache is visible in the module that depends on it.
 */

import { fold } from '../core/projection/fold.ts';
import { INITIAL_WATERMARK, watermarkReducer } from '../core/projection/watermark.ts';
import type { AppendedEvent } from '../core/types.ts';

/**
 * One process-local fold, and the `seq` it is folded through.
 *
 * Mutable by design: the slot IS the cache, and `foldIncrementally` replaces
 * `held` wholesale rather than mutating the state inside it, so a caller
 * holding a previous result is never surprised by it changing.
 */
export type FoldCacheSlot<State> = {
	held: { readonly seq: string; readonly state: State } | null;
};

/** Declare a cache slot. Empty until the first fold; reset by assigning null. */
export function foldCacheSlot<State>(): FoldCacheSlot<State> {
	return { held: null };
}

/**
 * Compare two `seq` values as integers of unbounded width, or `null` when
 * either cannot be read as one.
 *
 * `projection/watermark.ts` argues this at length for the same column: `seq`
 * is `bigint` and arrives at every runtime boundary as a string, so a `Number`
 * comparison misorders the log once it exceeds `Number.MAX_SAFE_INTEGER`.
 */
function compareSeq(a: string, b: string): number | null {
	if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return null;
	const left = BigInt(a);
	const right = BigInt(b);
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

/**
 * Whether state folded through `cachedSeq` may be EXTENDED to `liveSeq`,
 * rather than discarded and rebuilt from empty.
 *
 * Only when the live `max(seq)` is at or above it. A live `seq` BELOW the
 * cached one means the rows the cache folded are gone, which is not
 * hypothetical: `scripts/reset-pilot.js` deletes every row and runs `alter
 * column seq restart with 1`, so a warm process pointed at a wiped dev project
 * would otherwise serve the state of a league that no longer exists, forever,
 * with no event able to correct it. An unreadable `seq` on either side is
 * treated the same way — rebuild, never extend. The guard costs one comparison
 * and is the difference between a cache and a haunting.
 */
function extendable(cachedSeq: string, liveSeq: string): boolean {
	const order = compareSeq(cachedSeq, liveSeq);
	return order !== null && order <= 0;
}

/** Everything `foldIncrementally` reaches the database and the caller through. */
export type IncrementalFold<State> = {
	/** Where this caller's folded state is kept between calls. */
	readonly slot: FoldCacheSlot<State>;
	/** The log's current `max(seq)`. Performed on every call, hit or miss. */
	readonly liveSeq: () => Promise<string>;
	/** Every event with `seq` strictly greater than `since`, in `seq` order. */
	readonly loadSince: (since: string) => Promise<readonly AppendedEvent[]>;
	/** The state an empty log folds to. */
	readonly initial: State;
	/** Fold these events onto this state. One left fold per reducer. */
	readonly extend: (state: State, events: readonly AppendedEvent[]) => State;
};

/**
 * Fold the whole log, transferring only the part of it not already folded.
 *
 * Throws whatever the two reads throw. Nothing here catches: a failed read
 * must never be answered from the cache, because "the state I last saw" is
 * not an answer to "what is the state now", and AD-29's whole posture is that
 * a figure which cannot be refreshed says so rather than looking current.
 */
export async function foldIncrementally<State>({
	slot,
	liveSeq,
	loadSince,
	initial,
	extend
}: IncrementalFold<State>): Promise<State> {
	const live = await liveSeq();

	const held = slot.held;
	// The steady state: nothing appended since this process last folded, so
	// the whole read is the one `seq` already fetched above.
	if (held !== null && held.seq === live) return held.state;

	const base =
		held !== null && extendable(held.seq, live)
			? held
			: { seq: INITIAL_WATERMARK, state: initial };

	// Bounded by the CACHED `seq`, never by the `seq` just read: a transaction
	// that commits between the two reads is picked up here rather than
	// skipped, and the slot below records what actually arrived.
	const events = await loadSince(base.seq);

	// The highest `seq` genuinely folded. `watermarkReducer` already computes
	// exactly that and is the one definition AD-29 allows for this number, so
	// it is reused rather than re-derived by scanning the array here.
	const seq = fold(base.seq, events, watermarkReducer);
	const state = extend(base.state, events);

	slot.held = { seq, state };
	return state;
}
