import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

/**
 * The route handlers themselves.
 *
 * The pure decision functions were well covered and the exported handlers were
 * not, so nothing asserted that a handler actually *used* the decision it
 * imported — the status it returns, the headers it sets, the cookie it writes.
 * Those are the bytes a browser receives, and a decision function returning the
 * right object proves nothing about them.
 *
 * `$lib/server/supabase.ts` is mocked so no test reaches the network or needs
 * an environment variable; everything else is the real module.
 */

/**
 * `$env/dynamic/private` is a SvelteKit virtual module and is not populated
 * from `process.env` outside a running server, so it is substituted rather than
 * poked at. That is also closer to what these tests are for: the route's
 * behaviour given a configured secret, not SvelteKit's env plumbing.
 */
const RECOVERY_SECRET = vi.hoisted(() => 'correct-horse-battery-staple');

vi.mock('$env/dynamic/private', () => ({
	env: { COMMISSIONER_RECOVERY_SECRET: RECOVERY_SECRET }
}));

const stub = vi.hoisted(() => ({
	authorize: async (_input: { returnTo: string }): Promise<string> =>
		'https://discord.com/oauth2/authorize?client_id=1',
	exchange: async (_input: { code: string }): Promise<{ kind: string; discordUserId?: string }> => ({
		kind: 'exchanged',
		discordUserId: '111111111111111111'
	}),
	find: async (_id: string): Promise<unknown> => null,
	destroyed: 0,
	clientFails: false
}));

vi.mock('$lib/server/supabase.ts', () => ({
	supabaseUrl: () => 'https://project.supabase.co',
	serviceRoleClient: () => ({}),
	requestClient: () => {
		if (stub.clientFails) throw new Error('SUPABASE_URL is not set.');
		return {};
	},
	managerRegistry: () => ({
		findByDiscordUserId: (id: string) => stub.find(id)
	}),
	discordOAuthPort: () => ({
		authorizeUrl: (input: { returnTo: string }) => stub.authorize(input),
		exchangeCode: (input: { code: string }) => stub.exchange(input),
		destroySession: async () => {
			stub.destroyed += 1;
		}
	})
}));

const { GET } = await import('../src/routes/auth/callback/+server.ts');
const signin = await import('../src/routes/signin/+page.server.ts');
const recovery = await import('../src/routes/commissioner-recovery/+page.server.ts');

const {
	DISCORD_UNAVAILABLE_NOTICE,
	EXCHANGE_REFUSAL,
	EXCHANGE_REFUSAL_STATUS,
	UNREGISTERED_REFUSAL,
	UNREGISTERED_REFUSAL_STATUS
} = await import('../src/lib/server/auth.ts');
const {
	BREAK_GLASS_COOKIE,
	BREAK_GLASS_TTL_MS,
	RECOVERY_REFUSAL,
	verifyBreakGlassCookie
} = await import('../src/lib/server/commissioner-recovery.ts');

const ALICE = {
	id: '00000000-0000-4000-8000-000000000001',
	discordUserId: '111111111111111111',
	displayName: 'Alice'
};

// --- Fakes ------------------------------------------------------------------

type SetCookie = { name: string; value: string; options: Record<string, unknown> };

function fakeCookies(initial: Record<string, string> = {}) {
	const jar = new Map(Object.entries(initial));
	const setCalls: SetCookie[] = [];
	return {
		setCalls,
		get: (name: string) => jar.get(name),
		getAll: () => [...jar].map(([name, value]) => ({ name, value })),
		set: (name: string, value: string, options: Record<string, unknown>) => {
			setCalls.push({ name, value, options });
			jar.set(name, value);
		},
		delete: (name: string) => void jar.delete(name),
		serialize: () => ''
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callbackEvent(search: string): any {
	return {
		url: new URL(`https://app.example/auth/callback${search}`),
		cookies: fakeCookies()
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formEvent(url: string, fields: Record<string, string>, extra: Record<string, unknown> = {}): any {
	const body = new URLSearchParams(fields);
	return {
		url: new URL(url),
		cookies: fakeCookies(),
		getClientAddress: () => '203.0.113.7',
		request: new Request(url, {
			method: 'POST',
			body,
			headers: { 'content-type': 'application/x-www-form-urlencoded' }
		}),
		...extra
	};
}

/**
 * A form action, narrowed.
 *
 * `Actions` types every entry as optional and returning `MaybePromise`, so
 * calling one straight off the module is neither type-safe nor awaitable. This
 * also fails loudly if the action is renamed, which a cast would not.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ActionFn = (event: any) => unknown;

function requireAction(actions: unknown, name: string): ActionFn {
	const found = (actions as Record<string, ActionFn | undefined>)[name];
	if (typeof found !== 'function') throw new Error(`no "${name}" action is exported`);
	return found;
}

const discordAction = requireAction(signin.actions, 'discord');
const recoveryAction = requireAction(recovery.actions, 'default');

/** Run something that may throw a SvelteKit redirect, and report which. */
async function outcomeOf(
	run: () => unknown
): Promise<{ redirect: { status: number; location: string } } | { value: unknown }> {
	try {
		return { value: await run() };
	} catch (thrown) {
		if (isRedirect(thrown)) {
			return { redirect: { status: thrown.status, location: thrown.location } };
		}
		throw thrown;
	}
}

beforeEach(() => {
	stub.authorize = async () => 'https://discord.com/oauth2/authorize?client_id=1';
	stub.exchange = async () => ({ kind: 'exchanged', discordUserId: ALICE.discordUserId });
	stub.find = async () => null;
	stub.destroyed = 0;
	stub.clientFails = false;
});

// --- The OAuth callback -----------------------------------------------------

describe('GET /auth/callback', () => {
	it('refuses a request carrying no code, before touching anything', async () => {
		let exchanged = 0;
		stub.exchange = async () => {
			exchanged += 1;
			return { kind: 'exchanged', discordUserId: ALICE.discordUserId };
		};
		const response = await GET(callbackEvent(''));

		expect(response.status).toBe(EXCHANGE_REFUSAL_STATUS);
		expect(await response.text()).toBe(EXCHANGE_REFUSAL);
		expect(exchanged, 'a codeless callback reached the provider').toBe(0);
	});

	it('refuses when the provider itself reported an error', async () => {
		const response = await GET(callbackEvent('?error=access_denied'));
		expect(response.status).toBe(EXCHANGE_REFUSAL_STATUS);
		expect(await response.text()).toBe(EXCHANGE_REFUSAL);
	});

	it('carries the two headers that are its own, and no longer restates the security ones', async () => {
		const response = await GET(callbackEvent(''));

		// These two are the route's, and route-only on purpose: a `no-store`
		// default across the app would defeat the immutable asset caching the
		// built client depends on.
		expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(response.headers.get('cache-control')).toBe('no-store');

		// The security headers moved to `hooks.server.ts` in Story 9.3, which
		// applies them to every response this app generates. They are absent
		// HERE because this test calls the route handler directly, below the
		// hook — their presence on a real response is asserted by
		// `tests/headers.test.ts` against the single source both halves share,
		// and proven end to end by `curl -I` against a deploy.
		//
		// This assertion is deliberately the negative one. The route used to set
		// these to avoid a collision with netlify.toml that Story 9.1 proved
		// never happens — that block does not reach a Function response — which
		// meant these two were the ONLY security headers this path had, and the
		// other five were simply missing. Restating them now would put a second
		// writer on a value that must have one.
		expect(response.headers.get('x-robots-tag')).toBeNull();
		expect(response.headers.get('referrer-policy')).toBeNull();
	});

	it('refuses an unregistered account with the registry refusal, and destroys the session', async () => {
		stub.find = async () => null;
		const response = await GET(callbackEvent('?code=abc'));

		expect(response.status).toBe(UNREGISTERED_REFUSAL_STATUS);
		expect(await response.text()).toBe(UNREGISTERED_REFUSAL);
		expect(stub.destroyed, 'a refused caller was left holding a session').toBe(1);
	});

	it('serves byte-identical refusals to two different unregistered ids', async () => {
		// The claim an attacker actually tests, asserted where they test it: at
		// the response, not at the decision function behind it.
		async function refusalFor(discordUserId: string) {
			stub.exchange = async () => ({ kind: 'exchanged', discordUserId });
			const response = await GET(callbackEvent('?code=abc'));
			return {
				status: response.status,
				body: await response.text(),
				headers: [...response.headers].sort()
			};
		}
		expect(await refusalFor('222222222222222222')).toEqual(await refusalFor('333333333333333333'));
	});

	it('redirects a registered account to the root by default', async () => {
		stub.find = async () => ALICE;
		const response = await GET(callbackEvent('?code=abc'));

		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(stub.destroyed).toBe(0);
	});

	it('returns a registered account to the path it was headed for', async () => {
		stub.find = async () => ALICE;
		const response = await GET(callbackEvent('?code=abc&next=%2Fauction%2Fnominate'));
		expect(response.headers.get('location')).toBe('/auction/nominate');
	});

	it.each([
		['an off-site next', '?code=abc&next=https%3A%2F%2Fevil.example'],
		['a protocol-relative next', '?code=abc&next=%2F%2Fevil.example'],
		['a next carrying CRLF', '?code=abc&next=%2Fx%0d%0aSet-Cookie%3A%20a%3Db']
	])('never redirects off-site or emits a broken header for %s', async (_label, search) => {
		stub.find = async () => ALICE;
		const response = await GET(callbackEvent(search));
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/');
	});

	it('refuses rather than 500s when the registry throws', async () => {
		stub.find = async () => {
			throw new Error('managers lookup failed: connection refused');
		};
		const response = await GET(callbackEvent('?code=abc'));
		expect(response.status).toBe(EXCHANGE_REFUSAL_STATUS);
		expect(stub.destroyed, 'a session survived a registry failure').toBe(1);
	});
});

// --- The sign-in action -----------------------------------------------------

describe('POST /signin?/discord', () => {
	it('redirects to the provider when Discord answers', async () => {
		const result = await outcomeOf(() =>
			discordAction(formEvent('https://app.example/signin', { returnTo: '/' }))
		);
		expect(result).toEqual({
			redirect: { status: 303, location: 'https://discord.com/oauth2/authorize?client_id=1' }
		});
	});

	it('surfaces a Discord outage on the surface rather than swallowing it', async () => {
		// `discord-unavailable` is unreachable from a page load by design —
		// reachability is not probed per request. This action is the only place
		// it is produced, so it is the only place it can be proved.
		stub.authorize = async () => {
			throw new Error('discord.com: connect ETIMEDOUT');
		};
		const result = await outcomeOf(() =>
			discordAction(formEvent('https://app.example/signin', { returnTo: '/' }))
		);

		expect('value' in result).toBe(true);
		if (!('value' in result)) return;
		const failure = result.value as { status: number; data: { state: string; notice: string } };
		expect(failure.status).toBe(503);
		expect(failure.data.state).toBe('discord-unavailable');
		expect(failure.data.notice).toBe(DISCORD_UNAVAILABLE_NOTICE);
	});

	it('reports missing configuration as an outage rather than crashing', async () => {
		stub.clientFails = true;
		const result = await outcomeOf(() =>
			discordAction(formEvent('https://app.example/signin', { returnTo: '/' }))
		);
		expect('value' in result).toBe(true);
	});

	it('narrows an off-site return path before handing it to the provider', async () => {
		let seen = '';
		stub.authorize = async ({ returnTo }) => {
			seen = returnTo;
			return 'https://discord.com/oauth2/authorize';
		};
		await outcomeOf(() =>
			discordAction(
				formEvent('https://app.example/signin', { returnTo: '//evil.example/pwn' })
			)
		);
		expect(seen).toBe('/');
	});
});

// --- The break-glass action -------------------------------------------------

describe('POST /commissioner-recovery', () => {
	const SECRET = RECOVERY_SECRET;

	it('refuses a wrong secret without setting any cookie', async () => {
		const event = formEvent('https://app.example/commissioner-recovery', { secret: 'nope' });
		const result = await outcomeOf(() => recoveryAction(event));

		expect('value' in result).toBe(true);
		if (!('value' in result)) return;
		const failure = result.value as { status: number; data: { notice: string } };
		expect(failure.status).toBe(403);
		expect(failure.data.notice).toBe(RECOVERY_REFUSAL);
		expect(event.cookies.setCalls).toEqual([]);
	});

	it('sets the cookie with a maxAge in SECONDS, not milliseconds', async () => {
		// Passing BREAK_GLASS_TTL_MS straight through would turn a twelve-hour
		// break-glass session into a ~500-year one, silently: the cookie still
		// works, the signed expiry inside it still says twelve hours, and only the
		// browser's retention is wrong. Nothing else in the suite would notice.
		const event = formEvent('https://app.example/commissioner-recovery', { secret: SECRET });
		const result = await outcomeOf(() => recoveryAction(event));

		expect(result).toEqual({ redirect: { status: 303, location: '/' } });

		const [written] = event.cookies.setCalls as SetCookie[];
		expect(written).toBeDefined();
		if (written === undefined) return;
		expect(written.name).toBe(BREAK_GLASS_COOKIE);
		expect(written.options['maxAge']).toBe(BREAK_GLASS_TTL_MS / 1000);
		expect(written.options['maxAge']).toBe(43_200);
		expect(written.options['maxAge']).not.toBe(BREAK_GLASS_TTL_MS);
		// A year is 31,536,000 seconds. Anything above that is the units bug.
		expect(written.options['maxAge'] as number).toBeLessThan(31_536_000);
	});

	it('sets the cookie with the attributes that keep it out of script and off other sites', async () => {
		const event = formEvent('https://app.example/commissioner-recovery', { secret: SECRET });
		await outcomeOf(() => recoveryAction(event));

		const [written] = event.cookies.setCalls as SetCookie[];
		expect(written?.options).toMatchObject({
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'strict'
		});
	});

	it('writes a cookie that verifies against the configured secret', async () => {
		const event = formEvent('https://app.example/commissioner-recovery', { secret: SECRET });
		await outcomeOf(() => recoveryAction(event));

		const [written] = event.cookies.setCalls as SetCookie[];
		const verdict = verifyBreakGlassCookie({
			secret: SECRET,
			value: written?.value,
			now: Date.now()
		});
		expect(verdict.kind).toBe('valid');
	});
});
