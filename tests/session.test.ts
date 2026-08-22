import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	DISCORD_PROVIDER,
	discordIdentityOf,
	resolveSessionState,
	type AuthenticatedUser,
	type ManagerRegistry,
	type RegisteredManager
} from '../src/lib/server/auth.ts';
import {
	SUPABASE_COOKIE_PREFIX,
	gatherSessionFacts,
	type SessionGateway,
	type SessionRequest
} from '../src/lib/server/session.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The layer that turns a request into a session.
 *
 * It had no test at all, and that is exactly how an authentication bypass
 * shipped: both call sites read the Discord id as
 * `user_metadata.provider_id ?? identities[0].id`, metadata first. Supabase's
 * `updateUser` lets any authenticated client write its own `user_metadata`, and
 * the key that authorizes it is the *public* anon key — so anyone who could
 * sign in to the project at all could name a registered Manager's Discord id
 * and be resolved as that Manager. Every test below exists because nothing
 * here was covered.
 */

const ALICE: RegisteredManager = {
	id: '00000000-0000-4000-8000-000000000001',
	discordUserId: '111111111111111111',
	displayName: 'Alice',
	teamId: '00000000-0000-4000-8000-0000000000aa',
	teamName: 'Lakers',
	isCommissioner: false
};

/** An unregistered Discord account — the attacker's own. */
const MALLORY_DISCORD_ID = '999999999999999999';

function registry(...managers: RegisteredManager[]): ManagerRegistry {
	return {
		async findByDiscordUserId(discordUserId: string) {
			return managers.find((m) => m.discordUserId === discordUserId) ?? null;
		}
	};
}

function request(overrides: Partial<SessionRequest> = {}): SessionRequest {
	return {
		url: { pathname: '/', search: '' },
		cookies: { getAll: () => [] },
		...overrides
	};
}

/** A request carrying a Supabase auth cookie. */
function withSessionCookie(pathname = '/', search = ''): SessionRequest {
	return request({
		url: { pathname, search },
		cookies: { getAll: () => [{ name: `${SUPABASE_COOKIE_PREFIX}proj-auth-token`, value: 'x' }] }
	});
}

function gateway(user: AuthenticatedUser | null, managers: RegisteredManager[] = []): SessionGateway {
	return {
		authenticatedUser: async () => user,
		registry: () => registry(...managers)
	};
}

// --- The bypass, closed -----------------------------------------------------

describe('a client-forged metadata claim changes nothing', () => {
	/**
	 * The attack, concretely. Mallory signs in to the Supabase project with her
	 * own Discord account, calls `updateUser({ data: { provider_id: <Alice's
	 * id> } })` with the public anon key, and presents the resulting cookie.
	 * Supabase merges provider data into `user_metadata` on sign-in, so the
	 * forged field is indistinguishable from a genuine one by shape.
	 *
	 * `identities` is written by the auth server from the provider's token
	 * response and `updateUser` cannot reach it. It says Mallory.
	 *
	 * Story 1.4 widens the same attack: `updateUser` can just as easily write
	 * `user_metadata.team_id` or `user_metadata.is_commissioner`, so the forged
	 * object below also claims Alice's Team and the Commissioner flag — neither
	 * of which the `managers` row backing this session actually grants.
	 */
	const forged = {
		user_metadata: {
			provider_id: ALICE.discordUserId,
			sub: ALICE.discordUserId,
			team_id: ALICE.teamId,
			is_commissioner: true
		},
		app_metadata: {
			provider_id: ALICE.discordUserId,
			team_id: ALICE.teamId,
			is_commissioner: true
		},
		identities: [{ provider: DISCORD_PROVIDER, id: MALLORY_DISCORD_ID }]
	} as unknown as AuthenticatedUser;

	it('reads the provider-managed identity, not the self-writable claim', () => {
		expect(discordIdentityOf(forged)).toBe(MALLORY_DISCORD_ID);
		expect(discordIdentityOf(forged)).not.toBe(ALICE.discordUserId);
	});

	it('does NOT resolve the forger as the Manager she named', async () => {
		const facts = await gatherSessionFacts(withSessionCookie(), gateway(forged, [ALICE]));
		const state = resolveSessionState(facts);

		expect(facts.identity).toEqual({ discordUserId: MALLORY_DISCORD_ID });
		expect(state.kind).toBe('unregistered');
		expect(state.kind === 'registered' && state.manager.id).not.toBe(ALICE.id);
	});

	it('resolves the forger as registered only if her OWN id is in the registry', async () => {
		// The control: the same forged metadata, but Mallory is genuinely
		// registered. She gets her own row, never Alice's.
		const mallory: RegisteredManager = {
			id: '00000000-0000-4000-8000-00000000000f',
			discordUserId: MALLORY_DISCORD_ID,
			displayName: 'Mallory',
			teamId: null,
			teamName: null,
			isCommissioner: false
		};
		const state = resolveSessionState(
			await gatherSessionFacts(withSessionCookie(), gateway(forged, [ALICE, mallory]))
		);
		expect(state).toEqual({ kind: 'registered', manager: mallory });

		// The claim this test exists for: `forged` sets user_metadata.team_id to
		// Alice's Team and user_metadata.is_commissioner to true, and Mallory's
		// OWN registry row grants neither. The resolved binding must match her
		// row, not the claim she wrote on herself.
		expect(state.kind === 'registered' && state.manager.teamId).toBeNull();
		expect(state.kind === 'registered' && state.manager.teamName).toBeNull();
		expect(state.kind === 'registered' && state.manager.isCommissioner).toBe(false);
	});

	it('a forged Commissioner claim on a genuinely registered account changes nothing', async () => {
		// The tightest version of the claim: Mallory IS registered, and her real
		// row grants no Team and no Commissioner flag. Her forged user_metadata
		// claims both anyway. The resolved session must still read straight off
		// her `managers` row.
		const mallory: RegisteredManager = {
			id: '00000000-0000-4000-8000-00000000000f',
			discordUserId: MALLORY_DISCORD_ID,
			displayName: 'Mallory',
			teamId: null,
			teamName: null,
			isCommissioner: false
		};
		const mallorysOwnForgedMetadata = {
			user_metadata: { team_id: ALICE.teamId, is_commissioner: true },
			app_metadata: { team_id: ALICE.teamId, is_commissioner: true },
			identities: [{ provider: DISCORD_PROVIDER, id: MALLORY_DISCORD_ID }]
		} as unknown as AuthenticatedUser;

		const state = resolveSessionState(
			await gatherSessionFacts(
				withSessionCookie(),
				gateway(mallorysOwnForgedMetadata, [ALICE, mallory])
			)
		);
		expect(state).toEqual({ kind: 'registered', manager: mallory });
		expect(state.kind === 'registered' && state.manager.isCommissioner).toBe(false);
		expect(state.kind === 'registered' && state.manager.teamId).toBeNull();
	});

	it('never reads user_metadata or app_metadata, in any identity path', () => {
		// A source assertion, because this is a property of the code rather than
		// of one input: the next person to add a fallback here reintroduces the
		// bypass, and no behavioural test would catch a fallback that only fires
		// when `identities` is empty.
		for (const relative of [
			'src/lib/server/auth.ts',
			'src/lib/server/session.ts',
			'src/lib/server/supabase.ts',
			'src/lib/server/commissioner-guard.ts',
			'src/hooks.server.ts'
		]) {
			const source = readFileSync(join(ROOT, relative), 'utf8');
			const code = source
				.replace(/\/\*[\s\S]*?\*\//g, ' ')
				.replace(/(^|[^:/])\/\/[^\n]*/g, '$1');
			expect(code, `${relative} reads user_metadata`).not.toContain('user_metadata');
			expect(code, `${relative} reads app_metadata`).not.toContain('app_metadata');
		}
	});
});

// --- The identity reader ----------------------------------------------------

describe('discordIdentityOf', () => {
	it('reads the Discord identity', () => {
		expect(
			discordIdentityOf({ identities: [{ provider: DISCORD_PROVIDER, id: ALICE.discordUserId }] })
		).toBe(ALICE.discordUserId);
	});

	it('selects by provider rather than by index', () => {
		// A Supabase user may link several providers and their order is not a
		// contract. `identities[0]` was a coin flip.
		expect(
			discordIdentityOf({
				identities: [
					{ provider: 'github', id: 'gh-1' },
					{ provider: DISCORD_PROVIDER, id: ALICE.discordUserId }
				]
			})
		).toBe(ALICE.discordUserId);
	});

	it('trims surrounding whitespace', () => {
		expect(
			discordIdentityOf({ identities: [{ provider: DISCORD_PROVIDER, id: ` ${ALICE.discordUserId} ` }] })
		).toBe(ALICE.discordUserId);
	});

	it.each([
		['no user', null],
		['no identities field', {}],
		['a null identities field', { identities: null }],
		['an empty identities list', { identities: [] }],
		['no Discord identity', { identities: [{ provider: 'github', id: 'gh-1' }] }],
		['a blank Discord id', { identities: [{ provider: DISCORD_PROVIDER, id: '   ' }] }],
		['a missing Discord id', { identities: [{ provider: DISCORD_PROVIDER }] }],
		['a null provider', { identities: [{ provider: null, id: 'x' }] }]
	])('returns nothing for %s', (_label: string, user: unknown) => {
		expect(discordIdentityOf(user as AuthenticatedUser | null)).toBeNull();
	});

	it('fails closed when two Discord identities disagree', () => {
		// An authorization decision with two possible answers must not pick one.
		expect(
			discordIdentityOf({
				identities: [
					{ provider: DISCORD_PROVIDER, id: ALICE.discordUserId },
					{ provider: DISCORD_PROVIDER, id: MALLORY_DISCORD_ID }
				]
			})
		).toBeNull();
	});

	it('tolerates two Discord identities that agree', () => {
		expect(
			discordIdentityOf({
				identities: [
					{ provider: DISCORD_PROVIDER, id: ALICE.discordUserId },
					{ provider: DISCORD_PROVIDER, id: ALICE.discordUserId }
				]
			})
		).toBe(ALICE.discordUserId);
	});
});

// --- Assembling one request's facts -----------------------------------------

describe('gatherSessionFacts', () => {
	const registered: AuthenticatedUser = {
		identities: [{ provider: DISCORD_PROVIDER, id: ALICE.discordUserId }]
	};

	it('does not call the auth server when no Supabase cookie is present', async () => {
		let called = 0;
		const facts = await gatherSessionFacts(request(), {
			authenticatedUser: async () => {
				called += 1;
				return registered;
			},
			registry: () => registry(ALICE)
		});
		expect(called, 'an anonymous request paid a round trip').toBe(0);
		expect(resolveSessionState(facts)).toEqual({ kind: 'signed-out' });
	});

	it('ignores a cookie that is not a Supabase auth cookie', async () => {
		const facts = await gatherSessionFacts(
			request({ cookies: { getAll: () => [{ name: 'bbsl_break_glass', value: 'x' }] } }),
			gateway(registered, [ALICE])
		);
		expect(facts.cookie).toBe('absent');
	});

	it('reads a cookie that will not refresh as an expiry, keeping the attempted path', async () => {
		const facts = await gatherSessionFacts(
			withSessionCookie('/auction/nominate', '?player=42'),
			gateway(null, [ALICE])
		);
		expect(facts.cookie).toBe('present');
		expect(facts.refresh).toBe('refused');
		expect(resolveSessionState(facts)).toEqual({
			kind: 'expired',
			returnTo: '/auction/nominate?player=42'
		});
	});

	it('resolves a registered Manager', async () => {
		const facts = await gatherSessionFacts(withSessionCookie(), gateway(registered, [ALICE]));
		expect(resolveSessionState(facts)).toEqual({ kind: 'registered', manager: ALICE });
	});

	it('resolves an account nobody registered as unregistered', async () => {
		const facts = await gatherSessionFacts(withSessionCookie(), gateway(registered, []));
		expect(resolveSessionState(facts)).toEqual({ kind: 'unregistered' });
	});

	it('treats a user with no readable Discord identity as an expiry, not a session', async () => {
		const facts = await gatherSessionFacts(
			withSessionCookie(),
			gateway({ identities: [{ provider: 'github', id: 'gh-1' }] }, [ALICE])
		);
		expect(facts.identity).toBeNull();
		expect(resolveSessionState(facts).kind).toBe('expired');
	});

	it('fails closed when the registry throws', async () => {
		// A database outage is not "this account is registered". It is not a
		// session at all.
		const facts = await gatherSessionFacts(withSessionCookie(), {
			authenticatedUser: async () => registered,
			registry: () => ({
				async findByDiscordUserId() {
					throw new Error('managers lookup failed: connection refused');
				}
			})
		});
		expect(resolveSessionState(facts)).toEqual({ kind: 'signed-out' });
	});

	it('fails closed when the auth gateway throws', async () => {
		const facts = await gatherSessionFacts(withSessionCookie(), {
			authenticatedUser: async () => {
				throw new Error('SUPABASE_URL is not set.');
			},
			registry: () => registry(ALICE)
		});
		expect(resolveSessionState(facts)).toEqual({ kind: 'signed-out' });
	});

	it('never reports Discord unreachable from a page load', async () => {
		// Reachability is not probed per request — that would be an outbound call
		// on every page load. The `discord-unavailable` sentence is produced by
		// the sign-in action, where a real call has just failed.
		for (const req of [request(), withSessionCookie()]) {
			const facts = await gatherSessionFacts(req, gateway(registered, [ALICE]));
			expect(facts.discord).toBe('reachable');
		}
	});
});

// --- The wiring -------------------------------------------------------------

describe('hooks.server.ts', () => {
	// It reads the environment, so the suite cannot import it. What can be
	// asserted is that it stays thin — that it delegates rather than growing a
	// second copy of the logic the tests above cover.
	const source = readFileSync(join(ROOT, 'src', 'hooks.server.ts'), 'utf8');

	it('delegates session assembly rather than repeating it', () => {
		expect(source).toContain('gatherSessionFacts');
		expect(source).toContain('resolveSessionState');
	});

	it('resolves all three locals', () => {
		expect(source).toContain('event.locals.phase');
		expect(source).toContain('event.locals.breakGlass');
		expect(source).toContain('event.locals.session');
	});

	it('verifies the break-glass cookie without a network call', () => {
		// It must work when Supabase and Discord are both down, so nothing in
		// that path may be awaited against either.
		const breakGlassLine = /event\.locals\.breakGlass = ([\s\S]*?);\n/.exec(source)?.[1] ?? '';
		expect(breakGlassLine).toContain('verifyBreakGlassCookie');
		expect(breakGlassLine).not.toContain('await');
	});
});
