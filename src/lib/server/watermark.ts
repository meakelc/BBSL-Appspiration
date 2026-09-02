/**
 * The lightweight watermark re-read, and the server instant every surface
 * anchors its freshness on. Server-only. Story 4.1, AD-29.
 *
 * **This is the LIVENESS half, and it is deliberately not a fold.**
 * `resolveLeagueRead` (`server/phase.ts`) folds the entire log once per page
 * request, which is right for a page and ruinous on a 10-second interval:
 * `loadAppendedEvents` paginates the whole of `auction_events`, and asking it
 * "is the server reachable" every ten seconds would make the cheapest question
 * in the product the most expensive query in it. This asks the database for one
 * number.
 *
 * **It is the same connection the read path uses**, not a health endpoint of its
 * own. The liveness check must fail exactly when the app's own figures would be
 * unrefreshable — an endpoint that answered `200` from Node while Postgres was
 * unreachable would hold every client at Live through the one outage the
 * contract exists to surface.
 *
 * **It reads `auction_events`, not `auction_watermark`.** The row is a derived
 * cache maintained by a trigger; the log's own `max(seq)` is the thing AD-29
 * calls the source. The server therefore never depends on the trigger being
 * correct — if the two ever disagreed, the poll would raise the client's
 * watermark and reload it, which is the safe direction.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { INITIAL_WATERMARK } from '../core/projection/watermark.ts';
import { serviceRoleClient } from './supabase.ts';

const AUCTION_EVENTS_TABLE = 'auction_events';

/**
 * The two statuses the liveness endpoint answers a non-answer with.
 *
 * Declared HERE rather than in `routes/api/watermark/+server.ts` because
 * SvelteKit permits only its own named exports from a `+server.ts` — the same
 * reason `EXCHANGE_REFUSAL_STATUS` lives in `server/auth.ts` rather than beside
 * the route that returns it.
 */

/** Signed out, expired, unregistered, or Discord unavailable: no watermark. */
export const WATERMARK_UNAUTHENTICATED_STATUS = 401;

/** The database could not be read. A lapsed check, not a broken app. */
export const WATERMARK_UNAVAILABLE_STATUS = 503;

/** What a liveness re-read answers with. */
export type WatermarkReading = {
	/** The highest `auction_events.seq`. `'0'` for an empty log. */
	readonly watermark: string;
	/** The server instant this reading was taken at, ISO-8601 UTC. */
	readonly at: string;
};

/**
 * The instant the server is answering at, ISO-8601 UTC.
 *
 * **One clock read function, two callers** — this endpoint and
 * `+layout.server.ts`'s SSR seed — so the instant a page is born holding and
 * the instant a poll returns are the same kind of value from the same kind of
 * clock. The client measures a DURATION between two of them, and a duration
 * between two readings of one clock is the one thing a clock is unambiguously
 * good for.
 *
 * Node's clock rather than the database's, and that is a considered
 * departure from `auction-page.ts`, which reads `select now()`. That read is
 * inside a transaction whose figures the instant CAPTIONS, and AD-3 makes
 * server time the only time a RULE may be decided against. Freshness is not a
 * rule: it authorises nothing, refuses nothing, and is re-derived under the
 * lock like everything else. Paying a database round trip for it every ten
 * seconds, per client, would buy nothing the contract needs.
 */
export function serverInstant(): string {
	return new Date().toISOString();
}

/**
 * `select max(seq) from auction_events`, through PostgREST.
 *
 * Written as a one-row descending read rather than as an aggregate because
 * PostgREST exposes no `max()` without a database function, and a database
 * function would be a second definition of a number that already has one.
 * `order by seq desc limit 1` is the same answer off the same index the primary
 * key already provides.
 *
 * Throws on a read failure. The caller turns that into a `503` and the client
 * treats it as a lapsed check — never as a crash, and never as evidence that
 * anything about the auction changed.
 */
export async function readWatermark(
	client: SupabaseClient = serviceRoleClient()
): Promise<WatermarkReading> {
	const { data, error } = await client
		.from(AUCTION_EVENTS_TABLE)
		.select('seq')
		.order('seq', { ascending: false })
		.limit(1);

	if (error !== null) {
		throw new Error(`watermark read failed: ${error.message}`);
	}
	if (!Array.isArray(data)) {
		throw new Error('watermark read failed: response was not an array');
	}

	// An empty log is not a failure and is not an error to report: it is the
	// ordinary state of a league in Setup, and `'0'` is what the pure fold
	// produces for it.
	const row = data[0] as { seq?: unknown } | undefined;
	if (row === undefined) return { watermark: INITIAL_WATERMARK, at: serverInstant() };

	// **Validated, not stringified.** `String(row.seq)` on a row whose `seq`
	// column is absent produces the four-character string `"undefined"`, which
	// is truthy, survives JSON, and reaches the browser as a watermark that
	// `higherSeq` cannot read — where it would be silently passed over forever,
	// so the client would never reload again and would never say why. A row that
	// does not carry a readable `seq` is a failed read, and the endpoint answers
	// 503 for it exactly as it does for a refused query.
	const seq = row.seq;
	const watermark =
		typeof seq === 'string' || typeof seq === 'number' || typeof seq === 'bigint'
			? String(seq)
			: '';
	if (!/^\d+$/.test(watermark)) {
		throw new Error('watermark read failed: seq was not a whole number');
	}

	return { watermark, at: serverInstant() };
}
