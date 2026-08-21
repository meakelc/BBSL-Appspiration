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
 *   1. The League phase, so every surface states the same one.
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

import { resolveSessionState } from '$lib/server/auth.ts';
import {
	BREAK_GLASS_COOKIE,
	isBreakGlassSession,
	verifyBreakGlassCookie
} from '$lib/server/commissioner-recovery.ts';
import { resolveLeaguePhase } from '$lib/server/phase.ts';
import { gatherSessionFacts, type SessionGateway } from '$lib/server/session.ts';
import { managerRegistry, requestClient } from '$lib/server/supabase.ts';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.phase = resolveLeaguePhase();

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

	return await resolve(event);
};
