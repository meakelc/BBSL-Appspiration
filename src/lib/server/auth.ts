/**
 * Identity: the registry gate and the session resolver. Server-only.
 *
 * AD-15 is the whole shape of this file. Managers authenticate with Discord
 * OAuth through Supabase Auth, but *authentication is not authorization here*:
 * whether an account may hold a session is answered from the `managers` table,
 * server-side, on every request. It is never answered from JWT app-metadata or
 * any claim the client can influence, because `updateUser` makes user metadata
 * self-writable and a metadata-based binding would be self-assignable.
 *
 * Nothing in this module performs I/O. The Discord provider and the registry
 * are both reached through injected ports, so every row of the story's
 * edge-case matrix — including Discord being down — is a unit test with no
 * network and no database. The concrete ports are built in `supabase.ts`.
 *
 * This module holds no environment variable and no secret. Import it freely
 * from server code; never from a `.svelte` file.
 */

// --- What a registered Manager is ------------------------------------------

/**
 * A row of the `managers` registry, joined against `teams`.
 *
 * `teamId`/`teamName` and `isCommissioner` are Story 1.4's binding, read only
 * from `managers.team_id` / `managers.is_commissioner` (and the `teams` row
 * that `team_id` points at) via the registry port below — never from
 * `user_metadata`, `app_metadata`, or any other client-influenceable claim
 * (AD-15). A Manager with no Team yet resolves both `teamId` and `teamName`
 * to `null`; two co-managed Manager rows sharing one `team_id` resolve to the
 * identical `teamId`/`teamName` pair, by construction of the join.
 */
export type RegisteredManager = {
	readonly id: string;
	readonly discordUserId: string;
	readonly displayName: string;
	readonly teamId: string | null;
	readonly teamName: string | null;
	readonly isCommissioner: boolean;
};

// --- The five outcomes ------------------------------------------------------

/**
 * The complete set of session outcomes. `expired` is a *distinct* outcome from
 * `signed-out` because AD-15 requires it to be: sessions persist ≥30 days
 * (AD-27), so an expiry is rare enough to be disorienting and must say so
 * rather than presenting as a fresh sign-out. It carries the path the Manager
 * was trying to reach so they land back on it.
 */
export type SessionState =
	| { readonly kind: 'signed-out' }
	| { readonly kind: 'registered'; readonly manager: RegisteredManager }
	| { readonly kind: 'unregistered' }
	| { readonly kind: 'expired'; readonly returnTo: string }
	| { readonly kind: 'discord-unavailable' };

/** The `kind` discriminants, for exhaustiveness checks and tests. */
export const SESSION_STATE_KINDS = Object.freeze([
	'signed-out',
	'registered',
	'unregistered',
	'expired',
	'discord-unavailable'
] as const);

// --- The refusals -----------------------------------------------------------

/**
 * The one and only refusal an unregistered account ever receives.
 *
 * It states the fact and names the Commissioner. It does not say whether that
 * Discord identity is known, whether any Team exists, or whether trying again
 * would help — AD-15 forbids a refusal that enumerates the league, and a
 * "try another account" prompt is a probe loop with better manners.
 *
 * It is a frozen module constant rather than a template so that two different
 * unregistered callers cannot receive two different bytes.
 */
export const UNREGISTERED_REFUSAL =
	'This account cannot sign in. The Commissioner adds accounts to the league.';

/** The status every unregistered caller receives, without exception. */
export const UNREGISTERED_REFUSAL_STATUS = 403;

/**
 * The refusal for a sign-in that did not complete at the provider — a replayed
 * callback, a code already exchanged, a state mismatch.
 *
 * It says nothing about the registry, because at this point the registry has
 * not been consulted and saying anything about it would leak that the code
 * belonged to a known account.
 */
export const EXCHANGE_REFUSAL = 'Sign-in did not complete. Start again from the sign-in page.';

/** The status for a failed or replayed exchange. */
export const EXCHANGE_REFUSAL_STATUS = 400;

/** What the sign-in surface says when the provider itself is unreachable. */
export const DISCORD_UNAVAILABLE_NOTICE =
	'Discord is unreachable, so signing in is unavailable. Sessions already open are unaffected.';

/** What the sign-in surface says when a session expired rather than ended. */
export const EXPIRED_NOTICE =
	'The session expired. This is not a sign-out; signing in again returns you to where you were.';

/** The single sentence a signed-out visitor reads above the one action. */
export const SIGNED_OUT_SENTENCE = 'Sign in with the Discord account the Commissioner registered.';

/**
 * The sentence each session state reads on the sign-in surface. Exactly one is
 * ever shown, and *which* one is how the four states are told apart — AD-15
 * requires an expiry to be distinguishable from a fresh sign-out, and a refusal
 * to be identical for every caller.
 *
 * It lives here, beside the sentences and beside the states, rather than in the
 * route: a test can then assert the mapping directly. A test that only greps
 * the route for the four constant names proves they are all mentioned, not that
 * each is reached by the state it belongs to — swapping two cases would keep
 * such a test green while telling an expired Manager that Discord is down.
 */
export function noticeFor(session: SessionState): string {
	switch (session.kind) {
		case 'unregistered':
			return UNREGISTERED_REFUSAL;
		case 'expired':
			return EXPIRED_NOTICE;
		case 'discord-unavailable':
			return DISCORD_UNAVAILABLE_NOTICE;
		case 'signed-out':
		case 'registered':
			return SIGNED_OUT_SENTENCE;
	}
}

// --- The ports --------------------------------------------------------------

/**
 * The Discord provider, as this application needs it. Injected so a test can
 * make it throw, and so no route reaches Supabase Auth directly.
 */
export type DiscordOAuthPort = {
	/** Where to send the browser to begin sign-in. */
	authorizeUrl(input: { readonly returnTo: string }): Promise<string>;
	/** Trade the callback code for an identity. Throws or returns a failure. */
	exchangeCode(input: { readonly code: string }): Promise<ExchangeResult>;
	/**
	 * Destroy whatever session the exchange may already have established.
	 * Called before refusing, never after — see `NO_PARTIAL_SESSION`.
	 */
	destroySession(): Promise<void>;
};

/** The outcome of trading a callback code. */
export type ExchangeResult =
	| { readonly kind: 'exchanged'; readonly discordUserId: string }
	| { readonly kind: 'refused' };

/** The registry, as a port. The only question this story asks of it. */
export type ManagerRegistry = {
	findByDiscordUserId(discordUserId: string): Promise<RegisteredManager | null>;
};

// --- Reading the Discord identity -------------------------------------------

/** The provider name Supabase records for a Discord identity. */
export const DISCORD_PROVIDER = 'discord';

/**
 * C0 controls, DEL, and C1. Written with escapes rather than literal bytes so
 * the source stays text — a raw CR in a source file is invisible in review,
 * which is the same property that makes it dangerous in a header value.
 */
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * One linked provider identity, as Supabase Auth records it. `id` is the
 * provider's own user id — for Discord, the snowflake.
 *
 * Declared structurally rather than imported from `@supabase/supabase-js`, so
 * this module keeps its no-dependency, no-I/O shape and a test can hand it a
 * user object built by hand.
 */
export type ProviderIdentity = {
	readonly provider?: string | null;
	readonly id?: string | null;
};

/** As much of a Supabase user as any authorization decision may look at. */
export type AuthenticatedUser = {
	readonly identities?: readonly ProviderIdentity[] | null;
};

/**
 * The Discord user id for an authenticated user, or null.
 *
 * **This function is the whole of AD-15's "never from a client-influenceable
 * claim", so read what it does NOT do.**
 *
 * It does not look at `user_metadata`. Supabase's `updateUser` lets any
 * authenticated client write its own `user_metadata`, and the browser key that
 * authorizes that call is `PUBLIC_SUPABASE_ANON_KEY` — public by construction.
 * So a metadata field is attacker-controlled: anyone who can sign in to the
 * project at all could set `user_metadata.provider_id` to a registered
 * Manager's Discord id and be resolved as that Manager. Supabase also merges
 * provider data *into* `user_metadata` on sign-in, which makes the forged value
 * look exactly like a genuine one. There is no way to read that field safely,
 * so it is not read.
 *
 * `identities` is written by the auth server from the provider's own token
 * response and is not reachable from `updateUser`. It is the only trustworthy
 * source, and `identities[].id` is the provider's user id.
 *
 * Index `[0]` is not trusted either: a Supabase user may link several
 * providers, and their order is not a contract. The entry is selected by
 * `provider === 'discord'`.
 *
 * Ambiguity fails closed. Zero Discord identities, a blank id, or two Discord
 * identities disagreeing about the id all return null — an authorization
 * decision with two possible answers must not pick one.
 */
export function discordIdentityOf(user: AuthenticatedUser | null | undefined): string | null {
	const identities = user?.identities;
	if (identities === null || identities === undefined) return null;

	const ids = new Set<string>();
	for (const identity of identities) {
		if (identity?.provider !== DISCORD_PROVIDER) continue;
		const id = typeof identity.id === 'string' ? identity.id.trim() : '';
		if (id !== '') ids.add(id);
	}

	if (ids.size !== 1) return null;
	const [only] = ids;
	return only ?? null;
}

/**
 * A reminder in code, because the ordering is the security property: any
 * session the exchange established is destroyed *before* the refusal is
 * written, so a refused caller never leaves the request holding a cookie.
 */
export const NO_PARTIAL_SESSION =
	'destroy the session before refusing, never after — a refused caller holds no cookie';

// --- The registry lookup ----------------------------------------------------

/**
 * Is this Discord account registered?
 *
 * A blank or whitespace-only id is refused without consulting the registry: it
 * can match no real Discord identity, and a query for it is a query an
 * attacker chose the shape of.
 */
export async function findRegisteredManager(
	discordUserId: string,
	registry: ManagerRegistry
): Promise<RegisteredManager | null> {
	const normalised = discordUserId.trim();
	if (normalised === '') return null;
	return await registry.findByDiscordUserId(normalised);
}

// --- The pure resolver ------------------------------------------------------

/**
 * Everything the resolver is allowed to know. Assembled by the caller from the
 * request; the resolver itself reads no cookie, no clock and no database.
 */
export type SessionResolutionInput = {
	/** Does the request carry a session cookie at all? */
	readonly cookie: 'absent' | 'present';
	/** What happened when that cookie's session was refreshed. */
	readonly refresh: 'not-attempted' | 'renewed' | 'refused';
	/** Whether the Discord provider answered. */
	readonly discord: 'reachable' | 'unavailable';
	/** The identity the session resolved to, if any. */
	readonly identity: { readonly discordUserId: string } | null;
	/** The registry row for that identity, if any. */
	readonly registration: RegisteredManager | null;
	/** The path the request was for, preserved across an expiry. */
	readonly attemptedPath: string;
};

/**
 * Resolve one request's session state. Pure: same input, same output, always.
 *
 * The ordering is deliberate.
 *
 *   1. No cookie at all is either a signed-out visitor or, if the provider is
 *      down, a visitor who cannot sign in — those are different sentences.
 *   2. A cookie whose refresh was refused is an *expiry*, whatever Discord is
 *      doing. Refresh is Supabase's, not Discord's, so a Discord outage must
 *      not relabel an expiry.
 *   3. A cookie that resolved to no identity is treated as no cookie. It is
 *      not an error to report; it is a session that is not there.
 *   4. An identity with no registry row is refused, and refused identically
 *      for every caller.
 */
export function resolveSessionState(input: SessionResolutionInput): SessionState {
	if (input.cookie === 'absent') {
		return input.discord === 'unavailable'
			? { kind: 'discord-unavailable' }
			: { kind: 'signed-out' };
	}

	if (input.refresh === 'refused') {
		return { kind: 'expired', returnTo: safeReturnTo(input.attemptedPath) };
	}

	if (input.identity === null) {
		return input.discord === 'unavailable'
			? { kind: 'discord-unavailable' }
			: { kind: 'signed-out' };
	}

	if (input.registration === null) {
		return { kind: 'unregistered' };
	}

	return { kind: 'registered', manager: input.registration };
}

/**
 * The path an expired session returns to.
 *
 * Only a same-origin absolute path survives. `//evil.example` and
 * `https://evil.example` are both absolute URLs to a browser, so a return path
 * taken from the request must be narrowed to a single leading slash or the
 * expiry notice becomes an open redirect. Anything else becomes the root.
 *
 * A path carrying a control character is rejected outright rather than
 * trimmed. `trim()` removes leading and trailing whitespace only, so an
 * *interior* CR or LF survived every other guard here and reached a `location:`
 * response header — where the HTTP layer rejects it and the route 500s on a
 * value the caller chose. Header splitting is the classic form of that bug and
 * a crash is the polite end of its range. There is no legitimate path with a
 * control character in it, so the whole class goes.
 */
export function safeReturnTo(path: string): string {
	const trimmed = path.trim();
	if (!trimmed.startsWith('/')) return '/';
	if (trimmed.startsWith('//')) return '/';
	if (trimmed.startsWith('/\\')) return '/';
	if (CONTROL_CHARACTER.test(trimmed)) return '/';
	return trimmed;
}

// --- The callback gate ------------------------------------------------------

/** What the OAuth callback route should do, once every fact is in hand. */
export type CallbackOutcome =
	| { readonly kind: 'accepted'; readonly manager: RegisteredManager }
	| {
			readonly kind: 'refused';
			readonly status: number;
			readonly message: string;
			/** Whether a session may already exist and must be destroyed first. */
			readonly destroySession: boolean;
	  };

/** Everything the callback gate is allowed to know. */
export type CallbackGateInput = {
	readonly exchange: ExchangeResult | { readonly kind: 'unavailable' };
	readonly registration: RegisteredManager | null;
};

/**
 * Decide the callback. Pure, so the non-enumeration claim is testable: two
 * different unregistered ids produce the same object, byte for byte, because
 * neither id reaches the result at all.
 *
 * A refusal after a successful exchange always carries `destroySession: true`.
 * Supabase's code exchange establishes the session as a side effect of
 * succeeding, so by the time the registry is consulted a partial session may
 * already exist — and a refusal that leaves it in place is not a refusal.
 */
export function gateCallback(input: CallbackGateInput): CallbackOutcome {
	if (input.exchange.kind === 'unavailable' || input.exchange.kind === 'refused') {
		return {
			kind: 'refused',
			status: EXCHANGE_REFUSAL_STATUS,
			message: EXCHANGE_REFUSAL,
			// Nothing was established, but destroying costs nothing and a
			// half-written cookie jar is exactly the case this guards.
			destroySession: true
		};
	}

	if (input.registration === null) {
		return {
			kind: 'refused',
			status: UNREGISTERED_REFUSAL_STATUS,
			message: UNREGISTERED_REFUSAL,
			destroySession: true
		};
	}

	return { kind: 'accepted', manager: input.registration };
}

/**
 * Run the callback end to end against injected ports.
 *
 * The order is the contract: exchange, then gate, then — if refused — destroy
 * before the caller writes a response. A provider that throws is caught and
 * reported as unavailable rather than swallowed into a generic failure.
 */
export async function completeCallback(input: {
	readonly code: string;
	readonly oauth: DiscordOAuthPort;
	readonly registry: ManagerRegistry;
}): Promise<CallbackOutcome> {
	let exchange: ExchangeResult | { readonly kind: 'unavailable' };
	try {
		exchange = await input.oauth.exchangeCode({ code: input.code });
	} catch {
		exchange = { kind: 'unavailable' };
	}

	let registration: RegisteredManager | null = null;
	if (exchange.kind === 'exchanged') {
		try {
			registration = await findRegisteredManager(exchange.discordUserId, input.registry);
		} catch {
			// The registry could not answer — a database outage, a bad key, a
			// timeout. That is emphatically NOT "this account is registered", and
			// the exchange has already established a session, so the session must
			// be destroyed on this path exactly as it is on a refusal. Letting the
			// throw propagate would have left a live cookie behind an error page:
			// a caller the registry never approved, holding a session.
			await destroyQuietly(input.oauth);
			return {
				kind: 'refused',
				status: EXCHANGE_REFUSAL_STATUS,
				message: EXCHANGE_REFUSAL,
				destroySession: false
			};
		}
	}

	const outcome = gateCallback({ exchange, registration });
	if (outcome.kind === 'refused' && outcome.destroySession) {
		await destroyQuietly(input.oauth);
	}
	return outcome;
}

/**
 * Destroy the session, swallowing a failure to do so.
 *
 * Best effort, and deliberately before the response. If destroying throws we
 * still refuse — but we never accept.
 */
async function destroyQuietly(oauth: DiscordOAuthPort): Promise<void> {
	try {
		await oauth.destroySession();
	} catch {
		/* the refusal stands either way */
	}
}

/**
 * Ask the provider where to send the browser, reporting an outage as a state
 * rather than an exception. AD-27: a Discord failure is total, so the surface
 * that fronts it must be able to say so.
 */
export async function beginSignIn(input: {
	readonly oauth: DiscordOAuthPort;
	readonly returnTo: string;
}): Promise<{ readonly kind: 'redirect'; readonly url: string } | { readonly kind: 'unavailable' }> {
	try {
		const url = await input.oauth.authorizeUrl({ returnTo: safeReturnTo(input.returnTo) });
		if (typeof url !== 'string' || url === '') return { kind: 'unavailable' };
		return { kind: 'redirect', url };
	} catch {
		return { kind: 'unavailable' };
	}
}
