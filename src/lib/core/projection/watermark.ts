/**
 * The global watermark: the highest `auction_events.seq` folded (AD-29).
 *
 * **One watermark, one source.** AD-29 forbids a per-table stamp — the board and
 * the Maximum Bid strip must never report different ages, and two units
 * stamping their own tables would guarantee they do. This is the whole of the
 * derivation, and it is the same `fold()` every other projection uses over the
 * same events array the phase is folded from. No caller reads a second one.
 *
 * **A string, not a number.** `seq` is `bigint` in Postgres and arrives at every
 * runtime boundary as a string (`AppendedEvent.seq`); comparing it as a
 * `number` would misorder the log the moment `seq` exceeds
 * `Number.MAX_SAFE_INTEGER`, and rounding it would silently invent a value no
 * row holds. The comparison is via `BigInt`, exactly as `fold()`'s own sort
 * already does.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import type { Reducer } from './fold.ts';

/**
 * With no events appended, the watermark is `'0'`.
 *
 * `seq` is `generated always as identity` and starts at 1, so `'0'` is a value
 * no row can ever hold — which is what makes it a safe "nothing yet" rather
 * than an ambiguous first event. An empty log therefore folds to `'0'` with no
 * special case anywhere, exactly as an empty log folds to `Setup`.
 */
export const INITIAL_WATERMARK = '0';

/**
 * Read a `seq` as a `BigInt`, or `null` when it is not one.
 *
 * `BigInt('')` is `0n` and `BigInt('abc')` throws, so both are refused here
 * rather than allowed to either lower the watermark or crash a page. Nothing
 * this codebase writes produces such a value — `toAppendedEvent` builds `seq`
 * with `String(row['seq'])` off a `bigint` column — but the watermark is read
 * on every surface, and a surface is the wrong place to discover that a row was
 * malformed.
 */
function readSeq(seq: string): bigint | null {
	if (!/^\d+$/.test(seq)) return null;
	return BigInt(seq);
}

/**
 * The higher of two `seq` values, compared as integers of unbounded width.
 *
 * An unreadable value never wins and never lowers the answer: it is passed over
 * in favour of the readable one, and two unreadable values yield the first
 * argument unchanged, which in the fold is the state accumulated so far.
 *
 * **Monotonic by construction.** This returns one of its two arguments and is
 * commutative in value, so folding an out-of-order events array produces the
 * same watermark as folding an ordered one — the highest `seq` present. The
 * ordering `fold()` imposes matters to the phase reducer; it cannot matter to
 * this one, and that is a property worth having rather than a coincidence.
 */
export function higherSeq(a: string, b: string): string {
	const left = readSeq(a);
	const right = readSeq(b);
	if (right === null) return a;
	if (left === null) return b;
	return right > left ? b : a;
}

/**
 * Raise the watermark to this event's `seq` if it is higher.
 *
 * Every event type raises it — this reducer has no `switch` and deliberately
 * cannot grow one. The watermark answers "has anything happened at all", so an
 * event it ignored would be an event that happened invisibly.
 */
export const watermarkReducer: Reducer<string> = (state, event) => higherSeq(state, event.seq);
