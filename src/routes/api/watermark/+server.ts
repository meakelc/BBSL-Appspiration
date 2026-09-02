/**
 * The liveness endpoint. `GET /api/watermark` -> `{ watermark, at }`.
 * Story 4.1, AD-29.
 *
 * **This is the half that still works.** In production the Realtime socket is
 * blocked by `connect-src 'self'` until the two Supabase projects exist to
 * name, so a deployed client sits in Reconnecting and refreshes on this poll
 * rather than on the push. Same-origin is why: a `GET` to this app's own origin
 * needs no CSP widening of its own, which keeps the eventual `connect-src`
 * change scoped to the socket alone.
 *
 * **Session-guarded, and it discloses nothing to a caller without one.** PRD §6
 * allows no public or spectator access, and AD-16 requires authentication for
 * all data — the height of the log is data. A signed-out caller gets `401` and
 * no number. The client treats that exactly as it treats a network failure: a
 * lapsed check, not a crash.
 *
 * **It is not the fold.** `resolveLeagueRead` reads the entire log once per page
 * request; this reads one row. Wiring the page's own resolver in here would put
 * a full-log pagination on a ten-second interval per connected Manager.
 *
 * `cache-control: no-store` because the whole value of the response is that it
 * was produced now. A cached liveness check is a lie about reachability, and it
 * is the one lie this endpoint exists to prevent.
 */

import { json } from '@sveltejs/kit';

import {
	WATERMARK_UNAUTHENTICATED_STATUS,
	WATERMARK_UNAVAILABLE_STATUS,
	readWatermark,
	serverInstant
} from '$lib/server/watermark.ts';

import type { RequestHandler } from './$types';

/**
 * The headers every response carries, whatever its status — so a refused caller
 * cannot tell a signed-out `401` from a database-down `503` by anything but the
 * status line, and neither can be cached by anything in between.
 */
const RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
	'cache-control': 'no-store',
	'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet'
});

export const GET: RequestHandler = async ({ locals }) => {
	if (locals.session.kind !== 'registered') {
		// A body with no figure in it. The status is what the client reads; the
		// sentence is for a human who reaches this URL directly.
		return json(
			{ detail: 'Sign in to read this.' },
			{ status: WATERMARK_UNAUTHENTICATED_STATUS, headers: { ...RESPONSE_HEADERS } }
		);
	}

	try {
		const reading = await readWatermark();
		return json(reading, { headers: { ...RESPONSE_HEADERS } });
	} catch {
		// The read failed. This is NOT an error the client should surface as a
		// fault: the freshness contract already has a state for "the server
		// could not be reached", and it degrades on schedule rather than on a
		// single failure. `at` is still returned so a reader of this response by
		// hand can see when it was refused; the client ignores it, because a
		// non-200 never advances `lastLivenessOkAt`.
		return json(
			{ detail: 'The watermark could not be read.', at: serverInstant() },
			{ status: WATERMARK_UNAVAILABLE_STATUS, headers: { ...RESPONSE_HEADERS } }
		);
	}
};
