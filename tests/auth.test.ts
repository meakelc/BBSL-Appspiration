import { describe, expect, it } from 'vitest';

import {
	DISCORD_UNAVAILABLE_NOTICE,
	EXCHANGE_REFUSAL,
	EXCHANGE_REFUSAL_STATUS,
	EXPIRED_NOTICE,
	SESSION_STATE_KINDS,
	SIGNED_OUT_SENTENCE,
	UNREGISTERED_REFUSAL,
	UNREGISTERED_REFUSAL_STATUS,
	beginSignIn,
	completeCallback,
	findRegisteredManager,
	gateCallback,
	noticeFor,
	resolveSessionState,
	safeReturnTo,
	type CallbackOutcome,
	type DiscordOAuthPort,
	type ExchangeResult,
	type ManagerRegistry,
	type RegisteredManager,
	type SessionResolutionInput,
	type SessionState
} from '../src/lib/server/auth.ts';

/**
 * Every row of Story 1.3's edge-case matrix, driven against the pure resolver
 * and injected ports. Neither Supabase project exists yet, so nothing here may
 * reach a network — and nothing here does. That is not a compromise: the claims
 * worth asserting (an unregistered account is refused indistinguishably, a
 * Discord outage is a surfaced state rather than a swallowed exception) are
 * exactly the ones a real backend would make harder to observe, not easier.
 */

// --- Fixtures ---------------------------------------------------------------

const ALICE: RegisteredManager = {
	id: '00000000-0000-4000-8000-000000000001',
	discordUserId: '111111111111111111',
	displayName: 'Alice',
	teamId: null,
	teamName: null,
	isCommissioner: false
};

/** A registry holding exactly one Manager. */
function registryOf(...managers: RegisteredManager[]): ManagerRegistry {
	return {
		async findByDiscordUserId(discordUserId: string) {
			return managers.find((m) => m.discordUserId === discordUserId) ?? null;
		}
	};
}

/** A registry that records what it was asked, so we can prove it was not. */
function recordingRegistry(): ManagerRegistry & { readonly asked: string[] } {
	const asked: string[] = [];
	return {
		asked,
		async findByDiscordUserId(discordUserId: string) {
			asked.push(discordUserId);
			return null;
		}
	};
}

const BASE: SessionResolutionInput = {
	cookie: 'absent',
	refresh: 'not-attempted',
	discord: 'reachable',
	identity: null,
	registration: null,
	attemptedPath: '/'
};

function input(overrides: Partial<SessionResolutionInput>): SessionResolutionInput {
	return { ...BASE, ...overrides };
}

/** A Discord port built from parts, defaulting to "everything works". */
function oauthPort(
	overrides: Partial<DiscordOAuthPort> & { readonly onDestroy?: () => void } = {}
): DiscordOAuthPort & { readonly destroyed: () => number } {
	let destroyCount = 0;
	const port: DiscordOAuthPort = {
		authorizeUrl: overrides.authorizeUrl ?? (async () => 'https://discord.com/oauth2/authorize?x=1'),
		exchangeCode:
			overrides.exchangeCode ??
			(async (): Promise<ExchangeResult> => ({
				kind: 'exchanged',
				discordUserId: ALICE.discordUserId
			})),
		destroySession:
			overrides.destroySession ??
			(async () => {
				destroyCount += 1;
				overrides.onDestroy?.();
			})
	};
	return Object.assign(port, { destroyed: () => destroyCount });
}

// --- The five states are exactly five ---------------------------------------

describe('the session states', () => {
	it('are the five the story names, and no others', () => {
		expect([...SESSION_STATE_KINDS]).toEqual([
			'signed-out',
			'registered',
			'unregistered',
			'expired',
			'discord-unavailable'
		]);
	});
});

// --- The matrix, row by row -------------------------------------------------

describe('resolveSessionState', () => {
	it('signed-out visitor: no cookie is a signed-out visitor', () => {
		expect(resolveSessionState(input({ cookie: 'absent' }))).toEqual({ kind: 'signed-out' });
	});

	it('registered Discord account: an identity present in the registry holds a session', () => {
		const state = resolveSessionState(
			input({
				cookie: 'present',
				refresh: 'renewed',
				identity: { discordUserId: ALICE.discordUserId },
				registration: ALICE
			})
		);
		expect(state).toEqual({ kind: 'registered', manager: ALICE });
		// The Discord user id is recorded, because every event records the acting
		// Manager and the id is where notifications are addressed (AD-18).
		expect(state.kind === 'registered' && state.manager.discordUserId).toBe(ALICE.discordUserId);
	});

	it('unregistered Discord account: an identity absent from the registry holds none', () => {
		expect(
			resolveSessionState(
				input({
					cookie: 'present',
					refresh: 'renewed',
					identity: { discordUserId: '999999999999999999' },
					registration: null
				})
			)
		).toEqual({ kind: 'unregistered' });
	});

	it('expired session: a cookie whose refresh was refused is an expiry, not a sign-out', () => {
		const state = resolveSessionState(
			input({ cookie: 'present', refresh: 'refused', attemptedPath: '/auction/nominate' })
		);
		expect(state.kind).toBe('expired');
		expect(state.kind === 'expired' && state.returnTo).toBe('/auction/nominate');
		// The distinction is the whole point of AD-15's second bullet.
		expect(state.kind).not.toBe('signed-out');
	});

	it('expired stays expired even while Discord is unreachable', () => {
		// Refresh is Supabase's, not Discord's. A Discord outage must not relabel
		// an expiry as "you cannot sign in right now" — those need different words.
		const state = resolveSessionState(
			input({ cookie: 'present', refresh: 'refused', discord: 'unavailable', attemptedPath: '/x' })
		);
		expect(state.kind).toBe('expired');
	});

	it('Discord unavailable: a signed-out visitor is told the provider is down', () => {
		expect(resolveSessionState(input({ cookie: 'absent', discord: 'unavailable' }))).toEqual({
			kind: 'discord-unavailable'
		});
	});

	it('a cookie that resolves to no identity is no session, not an error', () => {
		expect(
			resolveSessionState(input({ cookie: 'present', refresh: 'renewed', identity: null }))
		).toEqual({ kind: 'signed-out' });
	});

	it('is pure — the same input resolves to the same output every time', () => {
		const one = input({
			cookie: 'present',
			refresh: 'renewed',
			identity: { discordUserId: ALICE.discordUserId },
			registration: ALICE
		});
		expect(resolveSessionState(one)).toEqual(resolveSessionState(one));
	});

	it('never returns a state outside the five', () => {
		const cookies = ['absent', 'present'] as const;
		const refreshes = ['not-attempted', 'renewed', 'refused'] as const;
		const discords = ['reachable', 'unavailable'] as const;
		const identities = [null, { discordUserId: ALICE.discordUserId }];
		const registrations = [null, ALICE];

		for (const cookie of cookies) {
			for (const refresh of refreshes) {
				for (const discord of discords) {
					for (const identity of identities) {
						for (const registration of registrations) {
							const state = resolveSessionState(
								input({ cookie, refresh, discord, identity, registration })
							);
							expect(SESSION_STATE_KINDS).toContain(state.kind);
						}
					}
				}
			}
		}
	});
});

// --- The Team binding and the Commissioner flag (Story 1.4) -----------------

describe('RegisteredManager carries the Team binding and the Commissioner flag', () => {
	it('a Manager bound to a Team resolves teamId and teamName from the registry', async () => {
		const bound: RegisteredManager = {
			id: '00000000-0000-4000-8000-000000000002',
			discordUserId: '222222222222222220',
			displayName: 'Bob',
			teamId: '00000000-0000-4000-8000-0000000000aa',
			teamName: 'Lakers',
			isCommissioner: false
		};
		const state = resolveSessionState(
			input({
				cookie: 'present',
				refresh: 'renewed',
				identity: { discordUserId: bound.discordUserId },
				registration: bound
			})
		);
		expect(state).toEqual({ kind: 'registered', manager: bound });
		expect(state.kind === 'registered' && state.manager.teamId).toBe(bound.teamId);
		expect(state.kind === 'registered' && state.manager.teamName).toBe('Lakers');
	});

	it('a Manager with no Team yet resolves both teamId and teamName to null, without crashing', () => {
		const state = resolveSessionState(
			input({
				cookie: 'present',
				refresh: 'renewed',
				identity: { discordUserId: ALICE.discordUserId },
				registration: ALICE
			})
		);
		expect(state.kind === 'registered' && state.manager.teamId).toBeNull();
		expect(state.kind === 'registered' && state.manager.teamName).toBeNull();
	});

	it('two co-managed Manager rows sharing one team_id resolve identical teamId and teamName', () => {
		const sharedTeamId = '00000000-0000-4000-8000-0000000000bb';
		const first: RegisteredManager = {
			id: '00000000-0000-4000-8000-000000000003',
			discordUserId: '333333333333333330',
			displayName: 'Cara',
			teamId: sharedTeamId,
			teamName: 'Celtics',
			isCommissioner: false
		};
		const second: RegisteredManager = {
			id: '00000000-0000-4000-8000-000000000004',
			discordUserId: '444444444444444440',
			displayName: 'Dana',
			teamId: sharedTeamId,
			teamName: 'Celtics',
			isCommissioner: false
		};

		const firstState = resolveSessionState(
			input({
				cookie: 'present',
				refresh: 'renewed',
				identity: { discordUserId: first.discordUserId },
				registration: first
			})
		);
		const secondState = resolveSessionState(
			input({
				cookie: 'present',
				refresh: 'renewed',
				identity: { discordUserId: second.discordUserId },
				registration: second
			})
		);

		expect(firstState.kind === 'registered' && firstState.manager.teamId).toBe(
			secondState.kind === 'registered' && secondState.manager.teamId
		);
		expect(firstState.kind === 'registered' && firstState.manager.teamName).toBe(
			secondState.kind === 'registered' && secondState.manager.teamName
		);
	});

	it('carries isCommissioner through to the resolved session, true and false alike', () => {
		const commissioner: RegisteredManager = { ...ALICE, isCommissioner: true };
		const state = resolveSessionState(
			input({
				cookie: 'present',
				refresh: 'renewed',
				identity: { discordUserId: commissioner.discordUserId },
				registration: commissioner
			})
		);
		expect(state.kind === 'registered' && state.manager.isCommissioner).toBe(true);

		const nonCommissioner = resolveSessionState(
			input({
				cookie: 'present',
				refresh: 'renewed',
				identity: { discordUserId: ALICE.discordUserId },
				registration: ALICE
			})
		);
		expect(nonCommissioner.kind === 'registered' && nonCommissioner.manager.isCommissioner).toBe(
			false
		);
	});
});

// --- The non-enumeration claim ----------------------------------------------

describe('an unregistered account cannot be told from any other', () => {
	it('two distinct unregistered ids produce byte-identical refusals', () => {
		// This is the claim an attacker actually tests: feed two ids, diff the
		// responses. If anything differs — a byte, a status, a field — the app is
		// a membership oracle for the league.
		const first = gateCallback({
			exchange: { kind: 'exchanged', discordUserId: '222222222222222222' },
			registration: null
		});
		const second = gateCallback({
			exchange: { kind: 'exchanged', discordUserId: '333333333333333333' },
			registration: null
		});

		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(first).toEqual(second);
	});

	it('the refusal names the Commissioner and nothing else', () => {
		const refusal = UNREGISTERED_REFUSAL;
		expect(refusal).toContain('Commissioner');
		// No retry loop to probe with, and nothing about what does or does not
		// exist in the league.
		expect(refusal.toLowerCase()).not.toMatch(/try again|another account|retry|team|register(ed)?\b/);
		expect(refusal).not.toContain('!');
	});

	it('carries no id, and no field that could carry one', () => {
		const outcome = gateCallback({
			exchange: { kind: 'exchanged', discordUserId: '444444444444444444' },
			registration: null
		});
		expect(JSON.stringify(outcome)).not.toContain('444444444444444444');
	});

	it('gives every unregistered caller the same status', () => {
		const outcome = gateCallback({
			exchange: { kind: 'exchanged', discordUserId: '555555555555555555' },
			registration: null
		});
		expect(outcome.kind).toBe('refused');
		expect(outcome.kind === 'refused' && outcome.status).toBe(UNREGISTERED_REFUSAL_STATUS);
		expect(UNREGISTERED_REFUSAL_STATUS).toBe(403);
	});

	it('says nothing about the registry when the exchange itself failed', () => {
		// A replayed code has not reached the registry, and a message that named
		// it would leak that the code belonged to a known account.
		const outcome = gateCallback({ exchange: { kind: 'refused' }, registration: null });
		expect(outcome.kind === 'refused' && outcome.message).toBe(EXCHANGE_REFUSAL);
		expect(EXCHANGE_REFUSAL).not.toContain('Commissioner');
		expect(EXCHANGE_REFUSAL).not.toBe(UNREGISTERED_REFUSAL);
	});
});

// --- The registry gate sits server-side of the session ----------------------

describe('the callback gate', () => {
	it('establishes a session for a registered account', async () => {
		const port = oauthPort();
		const outcome = await completeCallback({
			code: 'code-1',
			oauth: port,
			registry: registryOf(ALICE)
		});
		expect(outcome).toEqual({ kind: 'accepted', manager: ALICE });
		expect(port.destroyed()).toBe(0);
	});

	it('destroys any partial session BEFORE refusing an unregistered account', async () => {
		// The exchange establishes a session as a side effect of succeeding, so by
		// the time the registry is consulted a partial session already exists. A
		// refusal that leaves it in place is not a refusal.
		const order: string[] = [];
		const port = oauthPort({
			destroySession: async () => {
				order.push('destroyed');
			}
		});
		const outcome = await completeCallback({
			code: 'code-2',
			oauth: port,
			registry: registryOf() // nobody is registered
		});
		order.push('refused');

		expect(outcome.kind).toBe('refused');
		expect(order).toEqual(['destroyed', 'refused']);
	});

	it('refuses a replayed callback without establishing a second session', async () => {
		const exchanged = new Set<string>();
		const port = oauthPort({
			exchangeCode: async ({ code }) => {
				if (exchanged.has(code)) return { kind: 'refused' };
				exchanged.add(code);
				return { kind: 'exchanged', discordUserId: ALICE.discordUserId };
			}
		});
		const registry = registryOf(ALICE);

		const first = await completeCallback({ code: 'once', oauth: port, registry });
		const second = await completeCallback({ code: 'once', oauth: port, registry });

		expect(first.kind).toBe('accepted');
		expect(second.kind).toBe('refused');
		expect(second.kind === 'refused' && second.message).toBe(EXCHANGE_REFUSAL);
		expect(second.kind === 'refused' && second.status).toBe(EXCHANGE_REFUSAL_STATUS);
	});

	it('surfaces a provider that throws rather than swallowing it into acceptance', async () => {
		const port = oauthPort({
			exchangeCode: async () => {
				throw new Error('discord.com: connect ETIMEDOUT');
			}
		});
		const outcome: CallbackOutcome = await completeCallback({
			code: 'code-3',
			oauth: port,
			registry: registryOf(ALICE)
		});
		expect(outcome.kind).toBe('refused');
		// And it never claims to know anything about the registry.
		expect(outcome.kind === 'refused' && outcome.message).toBe(EXCHANGE_REFUSAL);
	});

	it('still refuses when destroying the session itself throws', async () => {
		const port = oauthPort({
			destroySession: async () => {
				throw new Error('signOut failed');
			}
		});
		const outcome = await completeCallback({
			code: 'code-4',
			oauth: port,
			registry: registryOf()
		});
		expect(outcome.kind).toBe('refused');
	});

	it('destroys the partial session when the REGISTRY throws, not just when it refuses', async () => {
		// The exchange succeeded, so a session already exists. If the registry
		// then fails — a database outage, a bad key, a timeout — letting the throw
		// escape would leave a live cookie behind an error page: a caller the
		// registry never approved, holding a session. That is the same hole as an
		// un-destroyed refusal, reached by a different road.
		const port = oauthPort();
		const outcome = await completeCallback({
			code: 'code-6',
			oauth: port,
			registry: {
				async findByDiscordUserId() {
					throw new Error('managers lookup failed: connection refused');
				}
			}
		});

		expect(outcome.kind).toBe('refused');
		expect(port.destroyed(), 'a session survived a registry failure').toBe(1);
		// And it still says nothing about the registry.
		expect(outcome.kind === 'refused' && outcome.message).toBe(EXCHANGE_REFUSAL);
	});

	it('does not consult the registry when the exchange failed', async () => {
		const registry = recordingRegistry();
		await completeCallback({
			code: 'code-5',
			oauth: oauthPort({ exchangeCode: async () => ({ kind: 'refused' }) }),
			registry
		});
		expect(registry.asked).toEqual([]);
	});
});

// --- The registry lookup ----------------------------------------------------

describe('findRegisteredManager', () => {
	it('finds a registered Discord account', async () => {
		expect(await findRegisteredManager(ALICE.discordUserId, registryOf(ALICE))).toEqual(ALICE);
	});

	it('returns nothing for an id nobody registered', async () => {
		expect(await findRegisteredManager('666666666666666666', registryOf(ALICE))).toBeNull();
	});

	it('tolerates surrounding whitespace on the id', async () => {
		expect(await findRegisteredManager(` ${ALICE.discordUserId} `, registryOf(ALICE))).toEqual(
			ALICE
		);
	});

	it.each(['', '   ', '\t\n'])('refuses the blank id %j without querying at all', async (blank) => {
		const registry = recordingRegistry();
		expect(await findRegisteredManager(blank, registry)).toBeNull();
		expect(registry.asked).toEqual([]);
	});
});

// --- Discord being down is a state, not an exception ------------------------

describe('beginSignIn', () => {
	it('returns the authorize URL when Discord answers', async () => {
		const outcome = await beginSignIn({ oauth: oauthPort(), returnTo: '/' });
		expect(outcome.kind).toBe('redirect');
		expect(outcome.kind === 'redirect' && outcome.url).toContain('discord.com');
	});

	it('reports an outage when the port throws', async () => {
		const outcome = await beginSignIn({
			oauth: oauthPort({
				authorizeUrl: async () => {
					throw new Error('503 Service Unavailable');
				}
			}),
			returnTo: '/'
		});
		expect(outcome).toEqual({ kind: 'unavailable' });
	});

	it('reports an outage when the port answers with no URL', async () => {
		const outcome = await beginSignIn({
			oauth: oauthPort({ authorizeUrl: async () => '' }),
			returnTo: '/'
		});
		expect(outcome).toEqual({ kind: 'unavailable' });
	});

	it('narrows the return path before handing it to the provider', async () => {
		let seen = '';
		await beginSignIn({
			oauth: oauthPort({
				authorizeUrl: async ({ returnTo }) => {
					seen = returnTo;
					return 'https://discord.com/oauth2/authorize';
				}
			}),
			returnTo: '//evil.example/pwn'
		});
		expect(seen).toBe('/');
	});
});

// --- The return path is not an open redirect --------------------------------

describe('safeReturnTo', () => {
	it.each(['/', '/auction', '/auction/nominate?player=42'])('keeps the internal path %j', (path) => {
		expect(safeReturnTo(path)).toBe(path);
	});

	it.each([
		'//evil.example',
		'https://evil.example',
		'http://evil.example',
		'/\\evil.example',
		'evil.example',
		'javascript:alert(1)',
		''
	])('collapses %j to the root', (path) => {
		// `//evil.example` is a protocol-relative absolute URL to a browser. A
		// return path taken from a request and echoed into a redirect is an open
		// redirect unless it is narrowed to one leading slash.
		expect(safeReturnTo(path)).toBe('/');
	});

	it.each([
		['a carriage return', '/x\r\nSet-Cookie: a=b'],
		['a bare line feed', '/x\nLocation: https://evil.example'],
		['a NUL', '/x\u0000'],
		['an interior tab', '/x\ty'],
		['a DEL', '/x\u007F'],
		['a C1 control', '/x\u0085']
	])('rejects a path carrying %s', (_label: string, path: string) => {
		// `trim()` removes leading and trailing whitespace only, so an INTERIOR
		// control character passed every other guard and reached a `location:`
		// header — where the HTTP layer rejects it and the route 500s on a value
		// the caller chose in a query parameter. No legitimate path contains one.
		expect(safeReturnTo(path)).toBe('/');
	});

	it('produces nothing a response header would reject', () => {
		const hostile = [
			'/x\r\nSet-Cookie: a=b',
			'//evil.example',
			'https://evil.example',
			'/x\u0000',
			'/ok'
		];
		for (const path of hostile) {
			// If this throws, the callback route 500s on the same input.
			expect(() => new Headers({ location: safeReturnTo(path) })).not.toThrow();
		}
	});
});

// --- Which sentence each state reads ----------------------------------------

describe('noticeFor', () => {
	// Grepping the route for the four constant names proves they are all
	// mentioned, not that each is reached by the state it belongs to: swap the
	// `expired` and `discord-unavailable` cases and such a check stays green
	// while an expired Manager is told Discord is down.
	it.each([
		['signed-out', { kind: 'signed-out' } as const, SIGNED_OUT_SENTENCE],
		['unregistered', { kind: 'unregistered' } as const, UNREGISTERED_REFUSAL],
		['expired', { kind: 'expired', returnTo: '/x' } as const, EXPIRED_NOTICE],
		['discord-unavailable', { kind: 'discord-unavailable' } as const, DISCORD_UNAVAILABLE_NOTICE]
	])('reads %s its own sentence', (_label, state, expected) => {
		expect(noticeFor(state)).toBe(expected);
	});

	it('gives every state a sentence, and no two states the same one', () => {
		const states: SessionState[] = [
			{ kind: 'signed-out' },
			{ kind: 'unregistered' },
			{ kind: 'expired', returnTo: '/' },
			{ kind: 'discord-unavailable' }
		];
		const sentences = states.map((state) => noticeFor(state));
		for (const sentence of sentences) expect(sentence).not.toBe('');
		expect(new Set(sentences).size, 'two states read the same sentence').toBe(states.length);
	});

	it('reads a registered Manager the neutral sentence rather than a refusal', () => {
		// `registered` never reaches the sign-in surface — the load redirects it
		// away — but a mapping with a hole would throw rather than redirect if
		// that ever changed.
		expect(noticeFor({ kind: 'registered', manager: ALICE })).toBe(SIGNED_OUT_SENTENCE);
	});
});

// --- The surface copy -------------------------------------------------------

describe('the sign-in copy', () => {
	it('states an expiry as an expiry, distinctly from a sign-out', () => {
		expect(EXPIRED_NOTICE).toMatch(/expired/i);
		expect(EXPIRED_NOTICE).not.toBe(SIGNED_OUT_SENTENCE);
		expect(EXPIRED_NOTICE).toMatch(/not a sign-out/i);
	});

	it('states a Discord outage as an outage', () => {
		expect(DISCORD_UNAVAILABLE_NOTICE).toMatch(/discord/i);
		expect(DISCORD_UNAVAILABLE_NOTICE).toMatch(/unreachable|unavailable/i);
	});

	it('carries no email anywhere in the identity copy', () => {
		for (const copy of [
			SIGNED_OUT_SENTENCE,
			EXPIRED_NOTICE,
			DISCORD_UNAVAILABLE_NOTICE,
			UNREGISTERED_REFUSAL,
			EXCHANGE_REFUSAL
		]) {
			expect(copy.toLowerCase()).not.toContain('email');
			expect(copy.toLowerCase()).not.toContain('magic link');
			expect(copy.toLowerCase()).not.toContain('password');
		}
	});

	it('never advises, apologises or manufactures urgency', () => {
		for (const copy of [
			SIGNED_OUT_SENTENCE,
			EXPIRED_NOTICE,
			DISCORD_UNAVAILABLE_NOTICE,
			UNREGISTERED_REFUSAL,
			EXCHANGE_REFUSAL
		]) {
			expect(copy).not.toContain('!');
			expect(copy.toLowerCase()).not.toMatch(/sorry|oops|please|unfortunately/);
		}
	});
});
