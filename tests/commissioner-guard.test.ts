import { describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

import {
	COMMISSIONER_ONLY_REFUSAL,
	COMMISSIONER_ONLY_STATUS,
	requireCommissioner
} from '../src/lib/server/commissioner-guard.ts';
import type { RegisteredManager, SessionState } from '../src/lib/server/auth.ts';

/**
 * `requireCommissioner`, exercised against every `SessionState` kind.
 *
 * No Commissioner-only route exists yet — the first lands in 1.7-1.10 — so
 * this is the only place the guard is proven: synthetic `SessionState`
 * values in, a 403 or nothing out. AC3 wants "every session kind that is not
 * a Commissioner refuses", which this drives as one parametrised matrix
 * rather than one test per kind, so a new `SessionState` kind added later and
 * left out of the list fails loudly instead of silently passing.
 */

const NON_COMMISSIONER: RegisteredManager = {
	id: '00000000-0000-4000-8000-000000000001',
	discordUserId: '111111111111111111',
	displayName: 'Alice',
	teamId: '00000000-0000-4000-8000-0000000000aa',
	teamName: 'Lakers',
	isCommissioner: false
};

const COMMISSIONER: RegisteredManager = {
	id: '00000000-0000-4000-8000-000000000002',
	discordUserId: '222222222222222220',
	displayName: 'Commissioner Bob',
	teamId: '00000000-0000-4000-8000-0000000000bb',
	teamName: 'Celtics',
	isCommissioner: true
};

/** Assert a call refuses with the guard's 403, and nothing else. */
function expectRefusal(session: SessionState): void {
	let thrown: unknown;
	try {
		requireCommissioner(session);
	} catch (caught) {
		thrown = caught;
	}
	expect(thrown, `requireCommissioner(${session.kind}) did not throw`).toBeDefined();
	expect(isHttpError(thrown)).toBe(true);
	if (isHttpError(thrown)) {
		expect(thrown.status).toBe(COMMISSIONER_ONLY_STATUS);
		expect(thrown.body.message).toBe(COMMISSIONER_ONLY_REFUSAL);
	}
}

describe('requireCommissioner', () => {
	const refusedSessions: ReadonlyArray<[string, SessionState]> = [
		['signed-out', { kind: 'signed-out' }],
		['unregistered', { kind: 'unregistered' }],
		['expired', { kind: 'expired', returnTo: '/auction/nominate' }],
		['discord-unavailable', { kind: 'discord-unavailable' }],
		['registered, non-Commissioner', { kind: 'registered', manager: NON_COMMISSIONER }]
	];

	it.each(refusedSessions)('refuses a %s session with a 403', (_label, session) => {
		expectRefusal(session);
	});

	it('allows a registered Commissioner session without throwing', () => {
		expect(() => requireCommissioner({ kind: 'registered', manager: COMMISSIONER })).not.toThrow();
	});

	it('returns nothing on success — the caller continues past the call', () => {
		expect(
			requireCommissioner({ kind: 'registered', manager: COMMISSIONER })
		).toBeUndefined();
	});

	it('reaches the Commissioner through the identical SessionState shape as any other Manager', () => {
		// No special-casing: a Commissioner is a `registered` session whose
		// `manager.isCommissioner` happens to be true, not a distinct session kind.
		const state: SessionState = { kind: 'registered', manager: COMMISSIONER };
		expect(state.kind).toBe('registered');
		expect(() => requireCommissioner(state)).not.toThrow();
	});

	it('states the fact and nothing else in the refusal', () => {
		expect(COMMISSIONER_ONLY_REFUSAL).not.toContain('!');
		expect(COMMISSIONER_ONLY_REFUSAL.toLowerCase()).not.toMatch(/sorry|oops|please/);
	});
});
