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
	const rows: AppendedEvent[] = [];
	let offset = 0;

	for (;;) {
		const { data, error } = await client
			.from(AUCTION_EVENTS_TABLE)
			.select('*')
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
