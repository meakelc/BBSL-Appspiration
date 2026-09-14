/**
 * `POST /api/fantrax-read` — the handler itself (Story 7.9, FR-42).
 *
 * `tests/server/tick-auth.test.ts` is the template, and its central lesson is
 * the one this file exists to carry over: extracting the comparison left the
 * security-critical part untested, because **which** variable is read, **which**
 * header is read and **which argument goes where** are decisions a source-text
 * check cannot see. Swapping the two arguments to `isAuthorisedSecret` inverts
 * the boundary completely — it compares the presented header against itself, so
 * every caller is authorised — and the only way to catch that is to drive the
 * real handler with a real `Request`.
 *
 * The four contracts asserted here:
 *
 *  1. **A wrong, absent or empty secret is a bare 401, before any connection is
 *     opened.** The gateway fake below throws if it is ever reached, so "before
 *     any connection" is a failure rather than a silence.
 *  2. **Every RECORDED outcome is 2xx** — `ok`, `unreachable`, `rate_limited`,
 *     `malformed` and a skipped read alike. An unreachable Fantrax is a normal
 *     outcome of asking an undocumented third party a question; the scheduler
 *     has nothing to retry and the surface is what states it.
 *  3. **Only a thrown error from the read path is the record-failed status.**
 *     That is the one case that leaves no evidence behind (AD-19).
 *  4. **A never-configured deployment answers on its OWN terms**, with its own
 *     status and a body naming the missing variable — never the identical 500
 *     and body a failed insert produces.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'a-real-looking-fantrax-invocation-secret-0123456789';

/**
 * A MUTABLE env stub. The handler reads `$env/dynamic/private` at call time, so
 * the tests set and clear keys on this object between calls — an always-empty
 * stub would only ever exercise the unconfigured branch.
 */
vi.mock('$env/dynamic/private', () => ({ env: {} as Record<string, string | undefined> }));

/**
 * The gateway THROWS if it is reached at all.
 *
 * That is what makes "no connection is opened for an unauthorised caller" and
 * "no connection is opened for an unconfigured deployment" proofs rather than
 * claims — both would otherwise pass by simply not asserting anything.
 */
const db = vi.hoisted(() => ({ connections: 0, allow: false }));

vi.mock('$lib/shell/db.ts', () => ({
	writeGateway: () => {
		db.connections += 1;
		if (!db.allow) throw new Error('the endpoint opened a connection it should not have');
		return { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
	}
}));

/**
 * `runFantraxRead` and the port builder are substituted so this file tests the
 * ENDPOINT — its statuses, its headers and its ordering — rather than re-testing
 * the shell, which `tests/server/divergence.test.ts` already drives for real.
 * Everything else, including the genuine `isAuthorisedSecret`, runs unmocked.
 */
const shell = vi.hoisted(() => ({
	summary: null as unknown,
	thrown: null as Error | null,
	portBuilt: 0,
	readCalls: 0,
	missing: [] as string[]
}));

vi.mock('$lib/server/divergence.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		fantraxReadInvocationSecret: () => {
			const value = (globalThis as Record<string, unknown>)['__fantraxSecret'];
			return typeof value === 'string' && value !== '' ? value : undefined;
		},
		missingFantraxConfiguration: () => shell.missing,
		configuredFantraxPort: () => {
			shell.portBuilt += 1;
			return shell.missing.length > 0 ? null : { read: async () => ({ kind: 'ok' }) };
		},
		runFantraxRead: async () => {
			shell.readCalls += 1;
			if (shell.thrown !== null) throw shell.thrown;
			return shell.summary;
		}
	};
});

const { POST } = await import('../../../src/routes/api/fantrax-read/+server.ts');
const {
	FANTRAX_READ_SECRET_HEADER,
	NOT_CONFIGURED_STATUS,
	RECORD_FAILED_STATUS,
	UNAUTHORISED_STATUS
} = await import('../../../src/lib/server/divergence.ts');
const { isAuthorisedSecret } = await import('../../../supabase/functions/tick/auth.ts');

function request(headers: Record<string, string> = {}): Request {
	return new Request('https://bbsl.example/api/fantrax-read', { method: 'POST', headers });
}

function call(headers: Record<string, string> = {}) {
	return POST({ request: request(headers) } as never) as Promise<Response>;
}

beforeEach(() => {
	(globalThis as Record<string, unknown>)['__fantraxSecret'] = SECRET;
	db.connections = 0;
	db.allow = true;
	shell.summary = { kind: 'recorded', outcome: 'ok', readAt: '2026-09-14T12:00:00.000Z', detail: 'fine' };
	shell.thrown = null;
	shell.portBuilt = 0;
	shell.readCalls = 0;
	shell.missing = [];
});

describe('the invocation secret', () => {
	const refused: ReadonlyArray<[string, Record<string, string>]> = [
		['an absent header', {}],
		['an empty header', { [FANTRAX_READ_SECRET_HEADER]: '' }],
		['a wrong secret', { [FANTRAX_READ_SECRET_HEADER]: 'not-the-secret' }],
		// The tick's own header, presented to this route. Two jobs that share one
		// secret cannot be revoked separately, which is why they do not share one.
		['the tick’s header instead of this one', { 'x-tick-invocation-secret': SECRET }]
	];

	it.each(refused)('refuses %s with a bare 401 and no body', async (_name, headers) => {
		db.allow = false;
		const response = await call(headers);
		expect(response.status).toBe(UNAUTHORISED_STATUS);
		expect(await response.text()).toBe('');
	});

	it.each(refused)('opens no connection and attempts no read for %s', async (_name, headers) => {
		db.allow = false;
		await call(headers);
		// Not merely "does not record" — it must not CONNECT and must not ASK.
		expect(db.connections).toBe(0);
		expect(shell.readCalls).toBe(0);
		expect(shell.portBuilt).toBe(0);
	});

	it('refuses everything when the deployment has no secret configured', async () => {
		// An unset variable must never read as "no secret required", and a caller
		// must not be able to tell that case from a wrong secret.
		(globalThis as Record<string, unknown>)['__fantraxSecret'] = undefined;
		db.allow = false;
		const withSecret = await call({ [FANTRAX_READ_SECRET_HEADER]: SECRET });
		const without = await call({});
		expect(withSecret.status).toBe(UNAUTHORISED_STATUS);
		expect(without.status).toBe(UNAUTHORISED_STATUS);
		expect(await withSecret.text()).toBe(await without.text());
	});

	it('accepts the configured secret', async () => {
		expect((await call({ [FANTRAX_READ_SECRET_HEADER]: SECRET })).status).toBe(200);
	});

	it('is not an oracle: the arguments cannot be swapped and still pass', () => {
		// `tests/server/tick-auth.test.ts` exists for this case and it applies
		// verbatim here. `isAuthorisedSecret(presented, presented)` — the shape a
		// swap produces — authorises everybody, so the handler passing the
		// CONFIGURED secret first is the whole boundary.
		expect(isAuthorisedSecret('wrong-secret', SECRET)).toBe(false);
		expect(isAuthorisedSecret(SECRET, SECRET)).toBe(true);
		// The swap, made visible: it authorises a caller who presented nonsense.
		expect(isAuthorisedSecret('nonsense', 'nonsense')).toBe(true);
	});
});

describe('every recorded outcome is a 2xx', () => {
	const outcomes = ['ok', 'unreachable', 'rate_limited', 'malformed'] as const;

	it.each(outcomes)('answers 2xx for a recorded %s read', async (outcome) => {
		shell.summary = {
			kind: 'recorded',
			outcome,
			readAt: '2026-09-14T12:00:00.000Z',
			detail: `recorded ${outcome}`
		};
		const response = await call({ [FANTRAX_READ_SECRET_HEADER]: SECRET });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ kind: 'recorded', outcome });
	});

	it('answers 2xx for a SKIPPED read and states when the next is due', async () => {
		shell.summary = {
			kind: 'skipped',
			nextDueAt: '2026-09-14T13:00:00.000Z',
			detail: 'The next one is due at 2026-09-14T13:00:00.000Z.'
		};
		const response = await call({ [FANTRAX_READ_SECRET_HEADER]: SECRET });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			kind: 'skipped',
			nextDueAt: '2026-09-14T13:00:00.000Z'
		});
	});
});

describe('the two non-2xx cases, which are different facts', () => {
	it('answers the record-failed status only when the read path THROWS', async () => {
		shell.thrown = new Error('the fantrax_reads insert returned no row');
		const response = await call({ [FANTRAX_READ_SECRET_HEADER]: SECRET });
		expect(response.status).toBe(RECORD_FAILED_STATUS);
		expect(await response.json()).toMatchObject({
			detail: 'The Fantrax read could not be recorded.'
		});
	});

	it('answers a never-configured deployment on its OWN terms, naming the variable', async () => {
		// The AD-19 shape: returning the identical 500 and body a failed insert
		// produces, while appending no row at all, is an outage wearing the face
		// of a transient write error.
		shell.missing = ['FANTRAX_BASE_URL', 'FANTRAX_PERIOD'];
		db.allow = false;
		const response = await call({ [FANTRAX_READ_SECRET_HEADER]: SECRET });

		expect(response.status).toBe(NOT_CONFIGURED_STATUS);
		expect(response.status).not.toBe(RECORD_FAILED_STATUS);
		const body = (await response.json()) as { detail: string; missing: string[] };
		expect(body.missing).toEqual(['FANTRAX_BASE_URL', 'FANTRAX_PERIOD']);
		expect(body.detail).toContain('FANTRAX_BASE_URL');
		expect(body.detail).toContain('not configured');
		// And it attempted nothing: no connection, no read.
		expect(db.connections).toBe(0);
		expect(shell.readCalls).toBe(0);
	});
});

describe('the response headers', () => {
	it('are no-store and noindex on every path', async () => {
		db.allow = false;
		const refused = await call({});
		db.allow = true;
		const accepted = await call({ [FANTRAX_READ_SECRET_HEADER]: SECRET });

		for (const response of [refused, accepted]) {
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(response.headers.get('x-robots-tag')).toContain('noindex');
		}
	});
});
