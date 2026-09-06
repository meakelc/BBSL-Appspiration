/**
 * One session resolution per request.
 *
 * AD-15 requires identity, and every authorization decision built on it, to
 * resolve server-side from application tables. Doing that here — once, into
 * `locals` — rather than in each `+page.server.ts` is what makes "server-side"
 * a property of the app instead of a habit each surface has to remember.
 *
 * Three facts are established, in this order:
 *
 *   1. The League phase and the global watermark, folded from ONE read of the
 *      event log, so every surface states the same phase and reports the same
 *      age (AD-29).
 *   2. The break-glass marker, verified from a signed cookie with no network
 *      call at all — it must work when Supabase and Discord are both down.
 *   3. The Discord/Supabase session state, which needs the registry and so
 *      needs the database.
 *
 * This file is deliberately thin. It reads the environment, so the test suite
 * cannot import it; everything worth testing therefore lives in
 * `lib/server/session.ts` and `lib/server/auth.ts`, and this is the wiring
 * between them. Keep it that way — logic that lands here is logic no test can
 * reach.
 *
 * A configuration or database failure resolves to `signed-out`, never to a
 * session. Failing closed is the only safe direction here.
 */

import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

import { resolveSessionState } from '$lib/server/auth.ts';
import {
	BREAK_GLASS_COOKIE,
	isBreakGlassSession,
	verifyBreakGlassCookie
} from '$lib/server/commissioner-recovery.ts';
import { resolveLeagueReadOrDefault } from '$lib/server/phase.ts';
import { securityHeaders } from '$lib/server/security-headers.ts';
import { gatherSessionFacts, type SessionGateway } from '$lib/server/session.ts';
import { managerRegistry, requestClient } from '$lib/server/supabase.ts';

export const handle: Handle = async ({ event, resolve }) => {
	// The fail-closed behaviour (any read failure resolves to Setup and the
	// watermark to '0' rather than 500ing the request) lives inside
	// resolveLeagueReadOrDefault itself, not here — this file reads
	// $env/dynamic/private at import time and the test suite cannot load it, so
	// a try/catch written inline here could never be exercised by a test.
	//
	// ONE read of the log, TWO folds off the same events array (Story 4.1): the
	// phase every surface states, and the global watermark AD-29 requires every
	// projection read to carry. A second read for the watermark would be a
	// second source for a number that must have one, and the two could disagree
	// by whatever committed between them.
	const read = await resolveLeagueReadOrDefault();
	event.locals.phase = read.phase;
	event.locals.watermark = read.watermark;

	event.locals.breakGlass = isBreakGlassSession(
		verifyBreakGlassCookie({
			secret: env['COMMISSIONER_RECOVERY_SECRET'],
			value: event.cookies.get(BREAK_GLASS_COOKIE),
			now: Date.now()
		})
	);

	const gateway: SessionGateway = {
		async authenticatedUser() {
			const { data, error } = await requestClient(event.cookies).auth.getUser();
			return error !== null ? null : data.user;
		},
		registry: () => managerRegistry()
	};

	event.locals.session = resolveSessionState(await gatherSessionFacts(event, gateway));

	const response = await resolve(event);

	// The security headers, on every response this app generates (Story 9.3).
	//
	// `netlify.toml`'s `[[headers]]` block reaches CDN-served static files and
	// NOT Function responses — Story 9.1's `curl -I` proved it: a static asset
	// returned all seven, the page a human loads returned none. With
	// `adapter-netlify` every page here is a Function response, so without this
	// the app is framable, indexable and has no Content-Security-Policy.
	//
	// Set unconditionally rather than only when absent. These are floors, and a
	// route that wanted to WEAKEN one would be doing something this hook exists
	// to prevent; a route wanting to ADD a header is unaffected. It also lets
	// `auth/callback` stop restating two of them to avoid a collision that, as
	// it turns out, never happens.
	for (const [name, value] of Object.entries(
		securityHeaders(publicEnv['PUBLIC_SUPABASE_URL'])
	)) {
		response.headers.set(name, value);
	}

	return response;
};
