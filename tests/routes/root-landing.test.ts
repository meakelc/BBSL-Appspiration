/**
 * The root landing's `load`, executed (Story 4.4).
 *
 * `src/routes/+page.server.ts` had no test at all before this story, and it
 * now makes a routing DECISION — so the decision is executed rather than
 * read as source text. `tests/routes.test.ts:2` already imports `isRedirect`
 * for exactly this assertion shape.
 *
 * The two cases the matrix names are the whole suite: a session for whom
 * `your-positions` resolves live arrives at Your Positions, and a session for
 * whom it does not keeps this page's current behaviour and is never redirected
 * into a 403. Nothing is mocked — `resolveDestinations` is the real catalog,
 * which is the point: the redirect and the guard ask ONE resolver and are
 * therefore structurally incapable of disagreeing.
 */

import { describe, expect, it } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

import { requireLiveDestination } from '../../src/lib/server/destinations.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';

const route = await import('../../src/routes/+page.server.ts');

const MANAGER: RegisteredManager = {
	id: 'm-2',
	discordUserId: '222',
	displayName: 'Alice',
	teamId: 't-2',
	teamName: 'Lakers',
	isCommissioner: false
};

const COMMISSIONER: RegisteredManager = {
	...MANAGER,
	id: 'm-1',
	isCommissioner: true
};

const PHASES: readonly ResolvedPhase[] = [
	{ name: 'Setup', sentence: 'Setup.', announcement: null },
	{ name: 'Auction', sentence: 'Auction.', announcement: null },
	{
		name: 'Contract Assignment',
		sentence: 'Contract Assignment.',
		announcement: null
	},
	{ name: 'Archived', sentence: 'Archived.', announcement: null }
];

function phase(name: ResolvedPhase['name']): ResolvedPhase {
	const found = PHASES.find((entry) => entry.name === name);
	if (found === undefined) throw new Error(`no phase ${name}`);
	return found;
}

function locals(session: SessionState, resolved: ResolvedPhase) {
	return { session, phase: resolved };
}

/** The thrown redirect, or `null` when the load returned instead. */
function redirectFrom(run: () => unknown): { status: number; location: string } | null {
	try {
		const result = run();
		void result;
		return null;
	} catch (caught) {
		if (!isRedirect(caught)) throw caught;
		return { status: caught.status, location: caught.location };
	}
}

describe('the root landing redirects to Your Positions when it is live', () => {
	it('sends a signed-in Manager in the Auction Phase to /positions', () => {
		const redirect = redirectFrom(() =>
			route.load({
				locals: locals({ kind: 'registered', manager: MANAGER }, phase('Auction'))
			} as never)
		);
		expect(redirect).not.toBeNull();
		expect(redirect?.location).toBe('/positions');
		// A GET arriving at a location that has moved for this viewer.
		expect(redirect?.status).toBe(303);
	});

	it('sends a Commissioner there too — the destination is not role-gated', () => {
		const redirect = redirectFrom(() =>
			route.load({
				locals: locals({ kind: 'registered', manager: COMMISSIONER }, phase('Auction'))
			} as never)
		);
		expect(redirect?.location).toBe('/positions');
	});

	it('sends a Manager bound to no Team there as well — the guard, not this load, decides', () => {
		// `your-positions` is not team-gated in the catalog, so the redirect
		// resolves for an unbound Manager and `/positions`' own guard is what
		// answers. Deciding it twice, in two places, is the disagreement this
		// whole design forecloses.
		const unbound: RegisteredManager = {
			...MANAGER,
			teamId: null,
			teamName: null
		};
		const redirect = redirectFrom(() =>
			route.load({
				locals: locals({ kind: 'registered', manager: unbound }, phase('Auction'))
			} as never)
		);
		expect(redirect?.location).toBe('/positions');
	});
});

describe('and never redirects a session into a 403', () => {
	it('leaves a signed-out visitor on the existing page in every phase', () => {
		for (const resolved of PHASES) {
			const result = route.load({
				locals: locals({ kind: 'signed-out' }, resolved)
			} as never) as {
				phase: ResolvedPhase;
			};
			// The existing return, untouched: the Phase sentence from the one
			// server-resolved source both this page and sign-in read.
			expect(result.phase, resolved.name).toEqual(resolved);
		}
	});

	it('leaves a registered Manager on the existing page in every phase without the destination', () => {
		for (const name of ['Setup', 'Contract Assignment', 'Archived'] as const) {
			const resolved = phase(name);
			const result = route.load({
				locals: locals({ kind: 'registered', manager: MANAGER }, resolved)
			} as never) as { phase: ResolvedPhase };
			expect(result.phase, name).toEqual(resolved);
		}
	});

	it('agrees with the guard EXACTLY — the redirect fires iff the guard would allow', () => {
		// The whole reason the redirect resolves through `resolveDestinations`
		// rather than testing `phase === 'Auction'`: a hardcoded test could
		// send someone straight into `requireLiveDestination`'s 403, and this
		// asserts the two can never disagree for any (phase, session) pair.
		const sessions: readonly SessionState[] = [
			{ kind: 'signed-out' },
			{ kind: 'registered', manager: MANAGER },
			{ kind: 'registered', manager: COMMISSIONER }
		];
		for (const session of sessions) {
			for (const resolved of PHASES) {
				const redirected =
					redirectFrom(() => route.load({ locals: locals(session, resolved) } as never)) !== null;

				let guardAllows = true;
				try {
					requireLiveDestination(session, resolved.name, 'your-positions');
				} catch {
					guardAllows = false;
				}

				expect(redirected, `${resolved.name} / ${session.kind}`).toBe(guardAllows);
			}
		}
	});
});
