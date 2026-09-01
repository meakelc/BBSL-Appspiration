/**
 * The tick's invocation check — the I/O Matrix's "bad invocation secret" row
 * (Story 3.5).
 *
 * `supabase/functions/tick/index.ts` calls `Deno.serve` at module scope and
 * reads `Deno.env`, so it cannot be imported here at all. The comparison it
 * delegates to can be, and is: `auth.ts` takes both secrets as arguments and
 * touches no global.
 *
 * The two halves of the matrix row are proven differently, and deliberately.
 * "The secret is refused" is behaviour and is asserted by calling the function.
 * "No connection is opened and no heartbeat is written" is an ORDERING claim
 * about a file no test can execute, so it is asserted against the file's own
 * source text — the same way `tests/structure.test.ts` proves claims about
 * `.svelte` files that this suite's `vite.config.ts` cannot render.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
	SECRET_HEADER,
	constantTimeEqual,
	isAuthorisedRequest,
	isAuthorisedSecret
} from '../../supabase/functions/tick/auth.ts';

const SECRET = 'a-real-looking-invocation-secret-0123456789';

/** A real `Request`, so header lookup behaves exactly as it will in production. */
function requestWith(headers: Record<string, string> = {}): Request {
	return new Request('https://example.test/tick', { method: 'POST', headers });
}

describe('the tick refuses a request that does not present the secret', () => {
	it('accepts the configured secret, presented exactly', () => {
		expect(isAuthorisedSecret(SECRET, SECRET)).toBe(true);
	});

	it.each([
		['a wrong secret of the same length', `${SECRET.slice(0, -1)}X`],
		['a wrong secret of a different length', 'nope'],
		['a prefix of the real secret', SECRET.slice(0, 10)],
		['the secret with trailing whitespace', `${SECRET} `],
		['an empty header', ''],
		['an absent header', null]
	])('refuses %s', (_label: string, presented: string | null) => {
		expect(isAuthorisedSecret(SECRET, presented)).toBe(false);
	});

	it.each([
		['unset', undefined],
		['null', null],
		['empty', '']
	])('refuses every request when the variable is %s — never "no secret required"', (
		_label: string,
		expected: string | undefined | null
	) => {
		// The dangerous failure: a deployment that forgot the variable must not
		// become a deployment anyone can drive the auction's closes from.
		expect(isAuthorisedSecret(expected, SECRET)).toBe(false);
		expect(isAuthorisedSecret(expected, '')).toBe(false);
		expect(isAuthorisedSecret(expected, null)).toBe(false);
	});

	it('does not distinguish "no secret configured" from "your secret is wrong"', () => {
		// Both are the same bare `false`. A caller that could tell them apart
		// would learn whether the deployment is configured at all.
		expect(isAuthorisedSecret(undefined, 'anything')).toBe(isAuthorisedSecret(SECRET, 'anything'));
	});
});

describe('isAuthorisedRequest — the WIRING, not just the comparison', () => {
	// The gap this block exists to close: extracting only `isAuthorisedSecret`
	// left which-header/which-variable/which-argument untested, and a
	// source-text position check cannot see any of them.

	it('accepts a request carrying the configured secret in the right header', () => {
		expect(isAuthorisedRequest(SECRET, requestWith({ [SECRET_HEADER]: SECRET }).headers)).toBe(
			true
		);
	});

	it('refuses the same secret presented in a DIFFERENT header', () => {
		expect(isAuthorisedRequest(SECRET, requestWith({ authorization: SECRET }).headers)).toBe(false);
		expect(isAuthorisedRequest(SECRET, requestWith({ 'x-tick-secret': SECRET }).headers)).toBe(
			false
		);
	});

	it('refuses a request with no headers at all', () => {
		expect(isAuthorisedRequest(SECRET, requestWith().headers)).toBe(false);
	});

	it('refuses a wrong secret in the right header', () => {
		expect(
			isAuthorisedRequest(SECRET, requestWith({ [SECRET_HEADER]: 'wrong' }).headers)
		).toBe(false);
	});

	it('refuses every request when the variable is unset, however the header looks', () => {
		expect(isAuthorisedRequest(undefined, requestWith({ [SECRET_HEADER]: SECRET }).headers)).toBe(
			false
		);
		expect(isAuthorisedRequest('', requestWith({ [SECRET_HEADER]: '' }).headers)).toBe(false);
	});

	it('reads the header case-insensitively, as Headers does', () => {
		// Proven with a real `Request` rather than a hand-rolled Map, which
		// would quietly not be case-insensitive and would make this pass for
		// the wrong reason.
		expect(
			isAuthorisedRequest(SECRET, requestWith({ 'X-Tick-Invocation-Secret': SECRET }).headers)
		).toBe(true);
	});

	it('cannot be called with the two sides swapped — the inversion is unrepresentable', () => {
		// The bug the old source-text check could not have caught: comparing
		// the presented header against itself authorises everybody. The
		// signature takes a secret and a header SOURCE, which are different
		// shapes, so the swap does not type-check. This asserts the runtime
		// half — a bare string is not a header lookup.
		const headers = requestWith({ [SECRET_HEADER]: 'attacker-supplied' }).headers;
		expect(isAuthorisedRequest('attacker-supplied', headers)).toBe(true);
		expect(isAuthorisedRequest(SECRET, headers)).toBe(false);
		// @ts-expect-error a string has no `.get`, so the swapped call is a type error
		expect(() => isAuthorisedRequest(headers.get(SECRET_HEADER), SECRET)).toThrow();
	});
});

describe('the comparison is constant-time over the bytes', () => {
	it('is true only for identical byte sequences', () => {
		const encoder = new TextEncoder();
		expect(constantTimeEqual(encoder.encode('abc'), encoder.encode('abc'))).toBe(true);
		expect(constantTimeEqual(encoder.encode('abc'), encoder.encode('abd'))).toBe(false);
		expect(constantTimeEqual(encoder.encode('abc'), encoder.encode('ab'))).toBe(false);
		expect(constantTimeEqual(new Uint8Array(), new Uint8Array())).toBe(true);
	});

	it('reads every byte rather than returning at the first difference', () => {
		// A first-byte difference and a last-byte difference must both take the
		// whole loop. Timing is not assertable here, but the ABSENCE of an early
		// return is: the source carries no `return` inside the loop body.
		const source = readFileSync(
			fileURLToPath(new URL('../../supabase/functions/tick/auth.ts', import.meta.url)),
			'utf8'
		);
		const loop = /for \(let index = 0[\s\S]*?\n\t\}/.exec(source)?.[0] ?? '';
		expect(loop, 'the accumulator loop was not found — has it been rewritten?').toContain('|=');
		expect(loop, 'an early return turns the comparison into an oracle').not.toContain('return');
	});
});

describe('the entry point checks the secret BEFORE it opens anything', () => {
	const source = readFileSync(
		fileURLToPath(new URL('../../supabase/functions/tick/index.ts', import.meta.url)),
		'utf8'
	);

	it('answers 401 and opens no connection, writes no heartbeat, closes nothing', () => {
		const refusal = source.indexOf('status: 401');
		const gateway = source.indexOf('tickGateway()');
		const tick = source.indexOf('runTick(');

		expect(refusal, 'no 401 refusal is rendered at all').toBeGreaterThan(-1);
		expect(gateway, 'the gateway is never built').toBeGreaterThan(-1);
		expect(refusal, 'a connection is opened before the secret is checked').toBeLessThan(gateway);
		expect(refusal, 'the pass runs before the secret is checked').toBeLessThan(tick);
	});

	it('reads the header the migration names, not a guessed one', () => {
		expect(SECRET_HEADER).toBe('x-tick-invocation-secret');
		const migration = readFileSync(
			fileURLToPath(
				new URL('../../supabase/migrations/20260831000000_tick.sql', import.meta.url)
			),
			'utf8'
		);
		expect(
			migration,
			'the cron job and the function disagree about the header name'
		).toContain(SECRET_HEADER);
	});
});

describe('the entry point wires the real evaluation, in the stated order (Story 3.7)', () => {
	const source = readFileSync(
		fileURLToPath(new URL('../../supabase/functions/tick/index.ts', import.meta.url)),
		'utf8'
	);

	/** The file with every comment stripped, so prose about a seam is not a seam. */
	const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

	it('passes `endPhase` and it is the real `evaluateLeagueClock`', () => {
		// The seam is optional on `runTick`, and a caller that omits it gets a
		// pass that records `not_evaluated` — honest, and completely inert. The
		// production wiring is the one place that must actually pass it, and
		// nothing else in the repository does.
		expect(code).toContain(
			"import { evaluateLeagueClock } from '../../../src/lib/server/phase-end.ts'"
		);
		expect(code).toContain('endPhase: () => evaluateLeagueClock(gateway)');
	});

	it('states the order — sweep, then the League Clock, then the drain', () => {
		// The order is not decided here (it is `sweep.ts`'s), but it is STATED
		// here, at the one place all three seams are wired together, exactly as
		// `drain` already was.
		const closeOne = code.indexOf('closeOne:');
		const endPhase = code.indexOf('endPhase:');
		const drain = code.indexOf('drain:');

		expect(closeOne).toBeGreaterThan(-1);
		expect(endPhase).toBeGreaterThan(closeOne);
		expect(drain).toBeGreaterThan(endPhase);
	});

	it('hands the evaluation the SAME gateway the closes use', () => {
		// One connection source for the whole pass. A second gateway would
		// mean the evaluation folding a log through a connection that had not
		// seen this pass's committed closes.
		expect(code).toContain('closeOne: (fantraxPlayerId) => closeAuction(gateway, fantraxPlayerId)');
		expect(code).toContain('evaluateLeagueClock(gateway)');
	});

	it('no longer claims the League Clock is unevaluated', () => {
		// The header said "no League Clock evaluation (3.7)" until this story
		// made it false. A stale "not this story" line is worse than none: it
		// is the first thing a reader trusts.
		expect(source).not.toContain('no League Clock evaluation (3.7)');
	});
});
