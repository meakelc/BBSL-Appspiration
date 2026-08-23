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
