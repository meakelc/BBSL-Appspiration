import { describe, expect, it } from 'vitest';

import {
	AttemptLedger,
	BREAK_GLASS_COOKIE,
	BREAK_GLASS_COOKIE_OPTIONS,
	BREAK_GLASS_TTL_HOURS,
	BREAK_GLASS_TTL_MS,
	BREAK_GLASS_VERSION,
	RECOVERY_ACCEPTED,
	RECOVERY_REFUSAL,
	RECOVERY_THROTTLED,
	THROTTLE_MAX_ATTEMPTS,
	THROTTLE_WINDOW_MS,
	attemptRecovery,
	isBreakGlassSession,
	isThrottled,
	mintBreakGlassCookie,
	pruneAttempts,
	recordAttempt,
	retryAfterMs,
	secretsMatch,
	throttleSource,
	verifyBreakGlassCookie
} from '../src/lib/server/commissioner-recovery.ts';

import { beginSignIn, type DiscordOAuthPort } from '../src/lib/server/auth.ts';

/**
 * The break-glass path exists for one moment: Discord is down, so nobody can
 * sign in and nobody can be told (AD-27). Everything below is that moment, plus
 * the controls that keep a shared secret from being a guessing oracle for the
 * rest of the year.
 */

const SECRET = 'correct-horse-battery-staple';
const T0 = 1_700_000_000_000;

// --- The secret comparison --------------------------------------------------

describe('the secret comparison', () => {
	it('accepts the configured secret', () => {
		expect(secretsMatch(SECRET, SECRET)).toBe(true);
	});

	it.each([
		['a wrong secret', 'wrong-horse-battery-staple'],
		['a prefix of the secret', 'correct-horse'],
		['the secret plus a character', `${SECRET}x`],
		['an empty submission', '']
	])('refuses %s', (_label: string, supplied: string) => {
		expect(secretsMatch(supplied, SECRET)).toBe(false);
	});

	it('refuses everything when no secret is configured', () => {
		// Unset and wrong must be the same refusal. If "no secret configured"
		// accepted an empty submission, an unconfigured deploy would be wide open.
		for (const configured of [undefined, null, ''] as const) {
			expect(secretsMatch('', configured)).toBe(false);
			expect(secretsMatch(SECRET, configured)).toBe(false);
		}
	});

	it('compares hashes, so the secret length is not observable', () => {
		// Both sides are hashed to 32 bytes before timingSafeEqual, which is what
		// stops the comparison throwing on a length mismatch — and a throw is a
		// timing signal as loud as any.
		expect(() => secretsMatch('x', SECRET)).not.toThrow();
		expect(() => secretsMatch('x'.repeat(10_000), SECRET)).not.toThrow();
	});

	it('is used rather than ===, in the module source', () => {
		// A regression here is invisible at runtime: `a === b` passes every test
		// above and leaks the secret one byte at a time.
		expect(String(secretsMatch)).toContain('timingSafeEqual');
	});
});

// --- The signed cookie ------------------------------------------------------

describe('the break-glass cookie', () => {
	const cookie = mintBreakGlassCookie({ secret: SECRET, issuedAt: T0, nonce: 'n1' });

	it('verifies with the correct secret, inside its lifetime', () => {
		const verdict = verifyBreakGlassCookie({ secret: SECRET, value: cookie, now: T0 + 1000 });
		expect(verdict.kind).toBe('valid');
		expect(isBreakGlassSession(verdict)).toBe(true);
		expect(verdict.kind === 'valid' && verdict.expiresAt).toBe(T0 + BREAK_GLASS_TTL_MS);
	});

	it('carries an explicit expiry rather than living until the browser forgets', () => {
		expect(BREAK_GLASS_TTL_MS).toBeGreaterThan(0);
		expect(BREAK_GLASS_TTL_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
	});

	it('tells the Commissioner the lifetime the constant actually grants', () => {
		// The sentence used to type out "12 hours". Shorten the constant and it
		// would have kept saying so — and the one thing this sentence exists to
		// tell the Commissioner is how long they have.
		expect(BREAK_GLASS_TTL_HOURS).toBe(BREAK_GLASS_TTL_MS / (60 * 60 * 1000));
		expect(RECOVERY_ACCEPTED).toContain(`${BREAK_GLASS_TTL_HOURS} hours`);
		const stated = /expires in (\d+) hours/.exec(RECOVERY_ACCEPTED)?.[1];
		expect(stated, 'the accepted sentence states no lifetime').toBeDefined();
		expect(Number(stated) * 60 * 60 * 1000).toBe(BREAK_GLASS_TTL_MS);
	});

	it('is no session at all once expired', () => {
		const verdict = verifyBreakGlassCookie({
			secret: SECRET,
			value: cookie,
			now: T0 + BREAK_GLASS_TTL_MS
		});
		expect(verdict.kind).toBe('expired');
		expect(isBreakGlassSession(verdict)).toBe(false);
	});

	it('is no session at all under a different secret — rotation revokes it', () => {
		const verdict = verifyBreakGlassCookie({ secret: 'rotated', value: cookie, now: T0 });
		expect(verdict.kind).toBe('forged');
		expect(isBreakGlassSession(verdict)).toBe(false);
	});

	it('is no session at all when no secret is configured', () => {
		for (const secret of [undefined, null, ''] as const) {
			expect(isBreakGlassSession(verifyBreakGlassCookie({ secret, value: cookie, now: T0 }))).toBe(
				false
			);
		}
	});

	it('rejects a tampered signature before any lookup', () => {
		const parts = cookie.split('.');
		const flipped = parts[3]?.startsWith('0') ? '1' : '0';
		const tampered = [parts[0], parts[1], parts[2], flipped + (parts[3] ?? '').slice(1)].join('.');
		const verdict = verifyBreakGlassCookie({ secret: SECRET, value: tampered, now: T0 });
		expect(verdict.kind).toBe('forged');
		expect(isBreakGlassSession(verdict)).toBe(false);
	});

	it('rejects an extended expiry — the expiry is signed, so altering it is forgery', () => {
		const parts = cookie.split('.');
		const extended = [parts[0], parts[1], String(T0 + 10 * BREAK_GLASS_TTL_MS), parts[3]].join('.');
		const verdict = verifyBreakGlassCookie({ secret: SECRET, value: extended, now: T0 });
		expect(verdict.kind).toBe('forged');
	});

	it('rejects a swapped nonce', () => {
		const parts = cookie.split('.');
		const swapped = [parts[0], 'n2', parts[2], parts[3]].join('.');
		expect(verifyBreakGlassCookie({ secret: SECRET, value: swapped, now: T0 }).kind).toBe('forged');
	});

	it.each([
		['a bare word', 'nonsense'],
		['too few fields', `${BREAK_GLASS_VERSION}.n1.${T0}`],
		['too many fields', `${mintBreakGlassCookie({ secret: SECRET, issuedAt: T0, nonce: 'n1' })}.x`],
		['a wrong version', `bg0.n1.${T0 + 1000}.${'a'.repeat(64)}`],
		['a non-numeric expiry', `${BREAK_GLASS_VERSION}.n1.later.${'a'.repeat(64)}`],
		['a short signature', `${BREAK_GLASS_VERSION}.n1.${T0 + 1000}.abc`],
		['an empty nonce', `${BREAK_GLASS_VERSION}..${T0 + 1000}.${'a'.repeat(64)}`]
	])('treats %s as no session at all', (_label: string, value: string) => {
		expect(isBreakGlassSession(verifyBreakGlassCookie({ secret: SECRET, value, now: T0 }))).toBe(
			false
		);
	});

	it('treats an absent cookie as absent, not as an attack', () => {
		for (const value of [undefined, null, ''] as const) {
			expect(verifyBreakGlassCookie({ secret: SECRET, value, now: T0 }).kind).toBe('absent');
		}
	});

	it('mints a different value per nonce', () => {
		const a = mintBreakGlassCookie({ secret: SECRET, issuedAt: T0, nonce: 'a' });
		const b = mintBreakGlassCookie({ secret: SECRET, issuedAt: T0, nonce: 'b' });
		expect(a).not.toBe(b);
	});

	it('refuses a nonce that would smuggle a field separator', () => {
		expect(() => mintBreakGlassCookie({ secret: SECRET, issuedAt: T0, nonce: 'a.b' })).toThrow();
	});

	it('is not readable by script, not sent cross-site, and not sent in clear', () => {
		expect(BREAK_GLASS_COOKIE_OPTIONS.httpOnly).toBe(true);
		expect(BREAK_GLASS_COOKIE_OPTIONS.secure).toBe(true);
		expect(BREAK_GLASS_COOKIE_OPTIONS.sameSite).toBe('strict');
		expect(BREAK_GLASS_COOKIE_OPTIONS.path).toBe('/');
	});

	it('does not collide with a Supabase auth cookie', () => {
		// hooks.server.ts treats any `sb-` cookie as a Supabase session to resolve.
		expect(BREAK_GLASS_COOKIE.startsWith('sb-')).toBe(false);
	});
});

// --- The throttle -----------------------------------------------------------

describe('the throttle', () => {
	it('drops attempts that have aged out of the window', () => {
		const attempts = [T0 - THROTTLE_WINDOW_MS - 1, T0 - 1000, T0];
		expect(pruneAttempts(attempts, T0)).toEqual([T0 - 1000, T0]);
	});

	it('refuses once the ceiling is reached', () => {
		let attempts: number[] = [];
		for (let i = 0; i < THROTTLE_MAX_ATTEMPTS; i += 1) {
			expect(isThrottled(attempts, T0)).toBe(false);
			attempts = recordAttempt(attempts, T0 + i);
		}
		expect(isThrottled(attempts, T0 + THROTTLE_MAX_ATTEMPTS)).toBe(true);
	});

	it('lets a source back in once the window slides past', () => {
		let attempts: number[] = [];
		for (let i = 0; i < THROTTLE_MAX_ATTEMPTS; i += 1) attempts = recordAttempt(attempts, T0 + i);
		expect(isThrottled(attempts, T0 + THROTTLE_WINDOW_MS + 1)).toBe(false);
		expect(retryAfterMs(attempts, T0 + THROTTLE_WINDOW_MS + 1)).toBe(0);
	});

	it('states how long the wait is', () => {
		let attempts: number[] = [];
		for (let i = 0; i < THROTTLE_MAX_ATTEMPTS; i += 1) attempts = recordAttempt(attempts, T0);
		expect(retryAfterMs(attempts, T0)).toBe(THROTTLE_WINDOW_MS);
	});

	it('counts per source, so one attacker cannot lock the Commissioner out', () => {
		const ledger = new AttemptLedger();
		for (let i = 0; i < THROTTLE_MAX_ATTEMPTS; i += 1) ledger.record('203.0.113.7', T0 + i);
		expect(ledger.isThrottled('203.0.113.7', T0)).toBe(true);
		expect(ledger.isThrottled('198.51.100.4', T0)).toBe(false);
	});

	it('does not grow without bound as distinct sources come and go', () => {
		// Trimming a source's array on lookup left the empty array — and its key —
		// in the Map forever. One key per distinct source address, on a
		// long-lived instance, is an unbounded allocation an attacker chooses the
		// size of. The ledger must forget a source once its window empties.
		const ledger = new AttemptLedger();
		for (let i = 0; i < 1000; i += 1) ledger.record(`198.51.100.${i}`, T0);
		expect(ledger.size).toBe(1000);

		// One attempt from one new source, a full window later. Every earlier
		// source has aged out and none of them should still be held.
		ledger.record('203.0.113.7', T0 + THROTTLE_WINDOW_MS + 1);
		expect(ledger.size).toBe(1);
		expect(ledger.attemptsFor('198.51.100.0')).toEqual([]);
	});

	it('keeps a source that is still inside its window', () => {
		const ledger = new AttemptLedger();
		ledger.record('198.51.100.1', T0);
		ledger.record('203.0.113.7', T0 + 1000);
		expect(ledger.size).toBe(2);
		expect(ledger.attemptsFor('198.51.100.1')).toEqual([T0]);
	});

	it('collapses an unattributable attempt into one shared bucket, not into no throttle', () => {
		expect(throttleSource(null)).toBe('unknown');
		expect(throttleSource(undefined)).toBe('unknown');
		expect(throttleSource('   ')).toBe('unknown');
		expect(throttleSource(' 203.0.113.7 ')).toBe('203.0.113.7');
	});
});

// --- One whole attempt ------------------------------------------------------

describe('an attempt', () => {
	function attempt(supplied: string, ledger: AttemptLedger, now: number, configured = SECRET) {
		return attemptRecovery({
			supplied,
			configured,
			ledger,
			source: '203.0.113.7',
			now,
			nonce: 'nonce'
		});
	}

	it('accepts the correct secret and mints a verifiable cookie', () => {
		const ledger = new AttemptLedger();
		const outcome = attempt(SECRET, ledger, T0);
		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;
		expect(
			isBreakGlassSession(
				verifyBreakGlassCookie({ secret: SECRET, value: outcome.cookie, now: T0 + 1 })
			)
		).toBe(true);
		expect(outcome.expiresAt).toBe(T0 + BREAK_GLASS_TTL_MS);
	});

	it('refuses a wrong secret and an unset secret with the same words and status', () => {
		const wrong = attempt('nope', new AttemptLedger(), T0);
		const unset = attempt('nope', new AttemptLedger(), T0, '');
		expect(wrong).toEqual(unset);
		expect(wrong.kind === 'refused' && wrong.message).toBe(RECOVERY_REFUSAL);
		expect(wrong.kind === 'refused' && wrong.status).toBe(403);
	});

	it('says nothing about whether the secret is wrong or absent', () => {
		expect(RECOVERY_REFUSAL.toLowerCase()).not.toMatch(/not (set|configured)|missing|unset|wrong/);
		expect(RECOVERY_REFUSAL).not.toContain('!');
	});

	it('throttles before comparing, so a throttled source learns nothing', () => {
		const ledger = new AttemptLedger();
		for (let i = 0; i < THROTTLE_MAX_ATTEMPTS; i += 1) {
			expect(attempt('nope', ledger, T0 + i).kind).toBe('refused');
		}
		// Even the CORRECT secret is refused now. That is the point: the response
		// cannot be used to test a guess.
		const throttled = attempt(SECRET, ledger, T0 + THROTTLE_MAX_ATTEMPTS);
		expect(throttled.kind).toBe('throttled');
		expect(throttled.kind === 'throttled' && throttled.message).toBe(RECOVERY_THROTTLED);
		expect(throttled.kind === 'throttled' && throttled.status).toBe(429);
	});

	it('counts successes too, so a known-good guess cannot reset the counter', () => {
		const ledger = new AttemptLedger();
		attempt('nope', ledger, T0);
		expect(ledger.attemptsFor('203.0.113.7').length).toBe(1);
		attempt(SECRET, ledger, T0 + 1);
		// A success clears the source entirely — the Commissioner is in, and the
		// ledger has nothing left to protect against for that source.
		expect(ledger.attemptsFor('203.0.113.7').length).toBe(0);
	});

	it('reports the wait rather than nothing at all', () => {
		const ledger = new AttemptLedger();
		for (let i = 0; i < THROTTLE_MAX_ATTEMPTS; i += 1) attempt('nope', ledger, T0);
		expect(ledger.retryAfterMs('203.0.113.7', T0)).toBe(THROTTLE_WINDOW_MS);
	});
});

// --- The whole reason it exists ---------------------------------------------

describe('with Discord down', () => {
	/** A provider that fails every call, which is what an outage looks like. */
	const deadDiscord: DiscordOAuthPort = {
		authorizeUrl: async () => {
			throw new Error('discord.com: connect ETIMEDOUT');
		},
		exchangeCode: async () => {
			throw new Error('discord.com: connect ETIMEDOUT');
		},
		destroySession: async () => {
			throw new Error('discord.com: connect ETIMEDOUT');
		}
	};

	it('the Manager sign-in cannot proceed', async () => {
		expect(await beginSignIn({ oauth: deadDiscord, returnTo: '/' })).toEqual({
			kind: 'unavailable'
		});
	});

	it('but the break-glass path still issues a Commissioner session', async () => {
		// This is AD-27 in one assertion: the pause control stays reachable when
		// Discord is the component that failed, because nothing in this path
		// touches Discord at all.
		const ledger = new AttemptLedger();
		const outcome = attemptRecovery({
			supplied: SECRET,
			configured: SECRET,
			ledger,
			source: '203.0.113.7',
			now: T0,
			nonce: 'outage'
		});
		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;
		expect(
			isBreakGlassSession(
				verifyBreakGlassCookie({ secret: SECRET, value: outcome.cookie, now: T0 + 60_000 })
			)
		).toBe(true);
	});

	it('and the break-glass module depends on neither vendor, structurally', async () => {
		// The claim is not "it happens to work today" — it is that this module
		// cannot be broken by Discord or Supabase, because it imports neither and
		// reaches the network nowhere. `node:crypto` is its only dependency.
		const { readFileSync } = await import('node:fs');
		const { fileURLToPath } = await import('node:url');
		const source = readFileSync(
			fileURLToPath(new URL('../src/lib/server/commissioner-recovery.ts', import.meta.url)),
			'utf8'
		);
		const specifiers = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
		expect(specifiers).toEqual(['node:crypto']);

		const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:/])\/\/[^\n]*/g, '$1');
		expect(code).not.toMatch(/@supabase/);
		expect(code).not.toMatch(/\bfetch\s*\(/);
		expect(code).not.toMatch(/\$env/);
	});
});
