/**
 * Assembling one request's session facts. Server-only.
 *
 * This is the I/O half of the session resolution: it reads the request's
 * cookies, asks the auth server who the caller is, asks the registry whether
 * that Discord account is registered, and hands the result to the pure
 * `resolveSessionState`. Nothing here decides anything — the decision is in
 * `auth.ts` and has no I/O at all.
 *
 * It lives in its own module, taking its I/O through an injected
 * {@link SessionGateway}, for one reason: `hooks.server.ts` imports
 * `$env/dynamic/private`, and a module that reads the environment at import
 * time is a module the test suite cannot load. Splitting the gateway out is
 * what makes "does a forged metadata claim change anything?" a unit test
 * rather than a hope. The bypass this file now guards against reached `main`
 * precisely because nothing tested this layer.
 */

import {
	discordIdentityOf,
	type AuthenticatedUser,
	type ManagerRegistry,
	type SessionResolutionInput
} from './auth.ts';

/**
 * Supabase writes its auth cookies under an `sb-` prefix. Their presence is the
 * cheap, offline answer to "is there a session to resolve at all" — without it
 * every anonymous request would pay a round trip to prove nothing.
 */
export const SUPABASE_COOKIE_PREFIX = 'sb-';

/**
 * As much of a SvelteKit `RequestEvent` as session assembly may look at.
 *
 * Structural rather than the real type, so a test builds one as an object
 * literal instead of standing up a framework.
 */
export type SessionRequest = {
	readonly url: { readonly pathname: string; readonly search: string };
	readonly cookies: { getAll(): Array<{ name: string; value: string }> };
};

/**
 * The I/O this assembly needs, injected.
 *
 * `authenticatedUser` returns the caller's user, or null for *any* reason it
 * cannot — an error, an expired refresh token, no user on the response. All of
 * those are the same fact here: the cookie will not turn into a session.
 */
export type SessionGateway = {
	authenticatedUser(): Promise<AuthenticatedUser | null>;
	registry(): ManagerRegistry;
};

/**
 * Assemble everything the pure resolver is allowed to know.
 *
 * Note what is *not* assembled: `discord` is always `'reachable'`. Reachability
 * is deliberately not probed per request — that would be an outbound network
 * call on every page load, on a free tier, to answer a question that only
 * matters at the moment someone tries to sign in. The `discord-unavailable`
 * state is therefore produced by the sign-in action in
 * `routes/signin/+page.server.ts`, where a real call to the provider has just
 * failed, and not from here. The parameter stays in the resolver's input
 * because the resolver is the one place that decides which sentence a visitor
 * reads, and it must be able to decide that one too.
 */
export async function gatherSessionFacts(
	request: SessionRequest,
	gateway: SessionGateway
): Promise<SessionResolutionInput> {
	const base = {
		discord: 'reachable',
		attemptedPath: request.url.pathname + request.url.search
	} as const;

	const noSession = {
		...base,
		cookie: 'absent',
		refresh: 'not-attempted',
		identity: null,
		registration: null
	} as const;

	const hasSupabaseCookie = request.cookies
		.getAll()
		.some((cookie) => cookie.name.startsWith(SUPABASE_COOKIE_PREFIX));

	if (!hasSupabaseCookie) return noSession;

	try {
		const user = await gateway.authenticatedUser();

		// A cookie that will not refresh into a user is an *expiry*, and AD-15
		// requires it to read as one rather than as a fresh sign-out. Sessions
		// persist ≥30 days (AD-27), so this is rare enough to be disorienting.
		if (user === null) {
			return {
				...base,
				cookie: 'present',
				refresh: 'refused',
				identity: null,
				registration: null
			};
		}

		// The one reader of identity in the codebase. It ignores `user_metadata`
		// entirely, because `updateUser` makes that field self-writable against a
		// public key — see the docblock on `discordIdentityOf`.
		const discordUserId = discordIdentityOf(user);
		if (discordUserId === null) {
			return {
				...base,
				cookie: 'present',
				refresh: 'refused',
				identity: null,
				registration: null
			};
		}

		const registration = await gateway.registry().findByDiscordUserId(discordUserId);

		return {
			...base,
			cookie: 'present',
			refresh: 'renewed',
			identity: { discordUserId },
			registration
		};
	} catch {
		// Missing configuration, an unreachable database, a registry error: none
		// of these are a session. Fail closed rather than guess.
		return noSession;
	}
}
