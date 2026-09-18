/**
 * Reading the full `auction_events` log for a fold. Server-only.
 *
 * AD-5 requires the phase projection (and any future one) to fold the
 * *entire* log by `seq`. Reads may query a projection's backing table
 * directly through the service-role client — `service_role` already holds
 * `SELECT` on `auction_events`, granted in Story 1.5 — so this module is a
 * thin, paginated reader, not a second write path.
 *
 * **Paginated, not a single `select('*')`.** PostgREST caps the rows a
 * single response returns; hitting that cap arrives as a successful
 * *partial* response, not an error, which would silently truncate the fold
 * below "the full log" the moment `auction_events` is no longer tiny. This
 * loops `.range()` until a page comes back shorter than `PAGE_SIZE`,
 * accumulating every row first.
 *
 * `toAppendedEvent` is reused from `shell/write.ts` rather than duplicated:
 * a Postgrest row and a `pg` row carry the same snake_case columns, so one
 * mapping function serves both.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { INITIAL_WATERMARK } from '../core/projection/watermark.ts';
import type { AppendedEvent } from '../core/types.ts';
import { toAppendedEvent } from '../shell/write.ts';
import type { TransactionalClient } from '../shell/write.ts';

/**
 * The width of each `.range()` request. Not assumed to equal the server's
 * actual per-response row cap — see the termination note on the loop below,
 * which does not rely on that equality holding.
 */
export const PAGE_SIZE = 1000;

const AUCTION_EVENTS_TABLE = 'auction_events';

/**
 * Load the entire `auction_events` log, ordered by `seq`, paginated.
 *
 * A thin wrapper over `loadAppendedEventsSince` with the lowest possible
 * bound: `seq` is `generated always as identity` starting at 1, so
 * `seq > '0'` is every row there can ever be. One implementation, two
 * callers — the full read and the tail read differ only in that bound, and
 * writing them as two loops would be two copies of the termination
 * reasoning below, which is the part that is easy to get wrong.
 *
 * Throws a descriptive error on any read failure — a query error, or a
 * response whose `data` is non-null but not an array, which would otherwise
 * reach `rows.push(...page)` as an opaque "not iterable" crash. The caller
 * (`resolveLeaguePhase`) is the throwing half of the fail-closed pair;
 * `resolveLeaguePhaseOrDefault` is what catches this.
 *
 * Terminates on an *empty* page, not a page shorter than `PAGE_SIZE`. A
 * response can legitimately come back shorter than requested even mid-log:
 * PostgREST enforces its own configured row cap regardless of what a
 * request asks for, and that cap is a deployment setting this module has no
 * way to read. Advancing `offset` by the page's actual length — not by the
 * assumed `PAGE_SIZE` — and stopping only once a page is empty is correct
 * for any server-side cap, including one smaller than `PAGE_SIZE`; treating
 * a short page as "the last page" is not, and would silently truncate the
 * log exactly like the single-unbounded-select case this pagination exists
 * to avoid.
 */
export async function loadAppendedEvents(client: SupabaseClient): Promise<AppendedEvent[]> {
	return loadAppendedEventsSince(client, INITIAL_WATERMARK);
}

/**
 * The same read, bounded below: every event with `seq` strictly greater than
 * `since`, ordered by `seq`, paginated.
 *
 * **This is a transfer optimisation, never a change of fold semantics.** AD-5
 * requires a projection to be folded from the entire log, and it still is —
 * `fold()`'s own header names both of its jobs, "folding the events a
 * transaction just appended onto an already-loaded projection state" and
 * "rebuilding a projection from empty state", as the same function. A caller
 * holding state already folded through `since` and folding this tail onto it
 * lands on precisely the value a full replay produces, because every reducer
 * here is a left fold in `seq` order and `auction_events` is insert-only
 * (AD-4: no role holds UPDATE or DELETE, so no row below `since` can ever
 * change after it is read).
 *
 * `since` is a `seq` as a string, the same shape `AppendedEvent.seq` and
 * `INITIAL_WATERMARK` carry — never a number, which would misorder the log
 * once `seq` exceeds `Number.MAX_SAFE_INTEGER` (`projection/watermark.ts`
 * makes the same argument about the same column).
 *
 * The bound is a filter, not an offset: `offset` below still walks the
 * FILTERED set from zero, so the pagination reasoning is unchanged and holds
 * for any `since`.
 */
export async function loadAppendedEventsSince(
	client: SupabaseClient,
	since: string
): Promise<AppendedEvent[]> {
	const rows: AppendedEvent[] = [];
	let offset = 0;

	for (;;) {
		const { data, error } = await client
			.from(AUCTION_EVENTS_TABLE)
			.select('*')
			.gt('seq', since)
			.order('seq', { ascending: true })
			.range(offset, offset + PAGE_SIZE - 1);

		if (error !== null) {
			throw new Error(`auction_events read failed: ${error.message}`);
		}
		if (!Array.isArray(data)) {
			throw new Error('auction_events read failed: response was not an array');
		}
		if (data.length === 0) break;

		for (const row of data as Record<string, unknown>[]) {
			rows.push(toAppendedEvent(row));
		}

		offset += data.length;
	}

	return rows;
}

/**
 * The same full-log read, over an open `pg` transaction instead of
 * PostgREST. Story 1.9.
 *
 * Promotion must fold the phase from the log INSIDE its own transaction —
 * `locals.phase` was resolved when the page loaded and says nothing about
 * what the log holds now, so trusting it would let "re-import is refused
 * once the auction has opened" be raced past by a tab that loaded during
 * Setup. `runTransactionalWrite` takes the global advisory lock before
 * `load` runs (AD-6), so a read through this function sees a log no
 * concurrent write can change underneath it.
 *
 * No pagination here: `pg` enforces no PostgREST-style per-response row cap,
 * which is the only reason `loadAppendedEvents` above loops at all. It does
 * NOT stream — `query()` buffers the whole result set into memory — so this
 * read grows with the log.
 *
 * Two call sites today, both bounded by the phase they run in rather than by
 * anything this function does:
 *
 *   - `import-promotion.ts`'s `promoteImport`, which runs only in Setup and
 *     at most a handful of times.
 *   - `eligibility.ts`'s `setEligibility` (Story 1.10), which also runs only
 *     in Setup but MAY run many times — one transaction per submit, each
 *     appending up to one event per changed Player. Setup's whole log is
 *     those events plus a few promotions, so the read stays small; it is not
 *     small because the caller is rare.
 *
 * Both bounds are properties of Setup, not of this reader. A caller folding
 * the log in a later phase — where the log is every bid ever placed — wants a
 * bounded read instead, and adding one here is the work that unblocks that.
 * `order by seq` is the fold order AD-5 requires — never `occurred_at`,
 * because a transaction queued on the lock commits later while holding an
 * earlier timestamp.
 *
 * `toAppendedEvent` is reused, as above: one row mapping, two clients.
 */
export async function loadEventsViaClient(client: TransactionalClient): Promise<AppendedEvent[]> {
	const result = await client.query('select * from auction_events order by seq asc');
	return result.rows.map((row) => toAppendedEvent(row));
}

/**
 * The same read over `pg`, bounded below: every event with `seq` strictly
 * greater than `since`, in `seq` order.
 *
 * `loadAppendedEventsSince`'s PostgREST twin, and its header carries the whole
 * argument for why a bounded read still satisfies AD-5's "fold the entire log"
 * — the tail is folded onto state already folded through `since`, and AD-4's
 * insert-only log is what makes the part below `since` immovable.
 *
 * **Every caller of this is inside the AD-6 global write lock**, which is what
 * makes the `max(seq)` its caller compares against meaningful: the log cannot
 * grow between that read and this one, so "nothing above `since`" is a fact
 * about the log rather than a race that happened to come back empty.
 *
 * `since` is bound as a parameter, never interpolated: it reaches here from a
 * `bigint` column as a string and is compared to one.
 */
export async function loadEventsViaClientSince(
	client: TransactionalClient,
	since: string
): Promise<AppendedEvent[]> {
	const result = await client.query(
		'select * from auction_events where seq > $1 order by seq asc',
		[since]
	);
	return result.rows.map((row) => toAppendedEvent(row));
}

/**
 * The log's current height over `pg`: `max(seq)`, or `'0'` for an empty log.
 *
 * `'0'` rather than `null`, matching `INITIAL_WATERMARK` — `seq` is `generated
 * always as identity` starting at 1, so no row can hold it, which is what
 * makes it an unambiguous "nothing yet" rather than a value to special-case.
 *
 * A string, never a number: `seq` is `bigint`, and `pg` hands `int8` back as a
 * string precisely so it is not rounded. `coalesce` runs in SQL so the empty
 * case needs no branch here, and `::text` makes the two runtimes agree — `pg`
 * and deno-postgres shape `int8` differently (AD-8), and a `bigint` from one
 * would not `===` a string from the other.
 */
export async function maxSeqViaClient(client: TransactionalClient): Promise<string> {
	const result = await client.query(
		'select coalesce(max(seq), 0)::text as seq from auction_events'
	);
	const seq = result.rows[0]?.['seq'];
	// Validated rather than stringified, `server/watermark.ts`'s reasoning:
	// `String(undefined)` is the four-character string "undefined", which is
	// truthy, survives a comparison, and would silently pin a cache forever.
	if (typeof seq !== 'string' || !/^\d+$/.test(seq)) {
		throw new Error('auction_events max(seq) read failed: seq was not a whole number');
	}
	return seq;
}
