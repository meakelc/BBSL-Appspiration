import { describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

import {
	LIVE_DESTINATION_REFUSAL,
	LIVE_DESTINATION_REFUSAL_STATUS,
	SIGN_IN_DESTINATION,
	requireLiveDestination,
	resolveDestinations
} from '../src/lib/server/destinations.ts';
import type { LeaguePhase } from '../src/lib/server/phase.ts';
import type { RegisteredManager, SessionState } from '../src/lib/server/auth.ts';

/**
 * `resolveDestinations`/`requireLiveDestination`, across all four phases and
 * {Commissioner, non-Commissioner Manager, every non-registered
 * `SessionState` kind}. Setup's Import, Minor League Eligibility, Manager
 * registration and auction-open gate are all Commissioner-only — these are
 * Commissioner administrative acts, the same category the Auction and
 * Contract Assignment Commissioner-only entries already sit in — exercised
 * directly here, not assumed.
 */

const COMMISSIONER: RegisteredManager = {
	id: '00000000-0000-4000-8000-000000000002',
	discordUserId: '222222222222222220',
	displayName: 'Commissioner Bob',
	teamId: '00000000-0000-4000-8000-0000000000bb',
	teamName: 'Celtics',
	isCommissioner: true
};

const MANAGER: RegisteredManager = {
	id: '00000000-0000-4000-8000-000000000001',
	discordUserId: '111111111111111111',
	displayName: 'Alice',
	teamId: '00000000-0000-4000-8000-0000000000aa',
	teamName: 'Lakers',
	isCommissioner: false
};

const COMMISSIONER_SESSION: SessionState = { kind: 'registered', manager: COMMISSIONER };
const MANAGER_SESSION: SessionState = { kind: 'registered', manager: MANAGER };

const NON_REGISTERED_SESSIONS: ReadonlyArray<[string, SessionState]> = [
	['signed-out', { kind: 'signed-out' }],
	['unregistered', { kind: 'unregistered' }],
	['expired', { kind: 'expired', returnTo: '/positions' }],
	['discord-unavailable', { kind: 'discord-unavailable' }]
];

const PHASES: readonly LeaguePhase[] = ['Setup', 'Auction', 'Contract Assignment', 'Archived'];

/**
 * ids, exactly as EXPERIENCE.md's Information Architecture table and
 * epics.md's Story 1.6 AC list them, split by phase into the
 * Commissioner-only entries and the general ones.
 */
const EXPECTED: Record<
	LeaguePhase,
	{ manager: readonly string[]; commissionerOnly: readonly string[] }
> = {
	Setup: {
		manager: [],
		commissionerOnly: [
			'import',
			'minor-league-eligibility',
			'manager-registration',
			'auction-open-gate'
		]
	},
	Auction: {
		manager: [
			'your-positions',
			'bid-board',
			'auction',
			'nominate',
			'teams',
			'audit-log',
			'notification-settings'
		],
		// The three roster acts, in the catalog's own order. FR-41 and FR-44
		// permit them in the Auction Phase and the Contract Assignment Phase and
		// nowhere else, so all three are absent from Setup and Archived.
		//
		// **`roster-move` is here rather than in the Manager list, and that is an
		// operator decision rather than FR-44's.** FR-44 makes the Move a
		// Manager's own act on their own Team; the Move shipped Commissioner-only
		// while the Manager half waits (see `deferred-work.md`). Moving the id
		// back to the `manager` array above is half of re-enabling it — the
		// other half is the one `commissionerOnly` argument in each phase list.
		//
		// `pause-resume` and `operational-health` were removed on 2026-09-12:
		// both were catalog rows with no route behind them, so every click was a
		// 404. They return with their surfaces (Story 7.4, Epic 8).
		commissionerOnly: ['roster-move', 'roster-trade', 'roster-drop']
	},
	'Contract Assignment': {
		manager: ['contract-assignment', 'teams', 'audit-log'],
		commissionerOnly: [
			'roster-move',
			'roster-trade',
			'roster-drop',
			'assignment-monitoring',
			'export-gate'
		]
	},
	Archived: {
		manager: ['bid-board', 'teams', 'audit-log', 'export'],
		commissionerOnly: []
	}
};

describe('resolveDestinations', () => {
	it.each(PHASES)("%s: a non-Commissioner Manager sees only that phase's general entries", (phase) => {
		const ids = resolveDestinations(phase, MANAGER_SESSION).map((d) => d.id);
		expect(ids).toEqual(EXPECTED[phase].manager);
	});

	it.each(PHASES)('%s: a Commissioner sees the general entries plus the Commissioner-only ones', (phase) => {
		const ids = resolveDestinations(phase, COMMISSIONER_SESSION).map((d) => d.id);
		expect(ids).toEqual([...EXPECTED[phase].manager, ...EXPECTED[phase].commissionerOnly]);
	});

	it.each(PHASES)(
		"%s: every returned entry's commissionerOnly flag matches which set it belongs to",
		(phase) => {
			for (const entry of resolveDestinations(phase, COMMISSIONER_SESSION)) {
				const expectedCommissionerOnly = EXPECTED[phase].commissionerOnly.includes(entry.id);
				expect(entry.commissionerOnly).toBe(expectedCommissionerOnly);
			}
		}
	);

	it.each(NON_REGISTERED_SESSIONS)('%s: sees exactly [Sign-in], in every phase', (_label, session) => {
		for (const phase of PHASES) {
			expect(resolveDestinations(phase, session)).toEqual([SIGN_IN_DESTINATION]);
		}
	});

	it('never includes Sign-in for a registered session, Commissioner or not', () => {
		for (const phase of PHASES) {
			expect(resolveDestinations(phase, MANAGER_SESSION).some((d) => d.id === 'sign-in')).toBe(
				false
			);
			expect(
				resolveDestinations(phase, COMMISSIONER_SESSION).some((d) => d.id === 'sign-in')
			).toBe(false);
		}
	});

	it('Setup: the Commissioner-only entries name exactly the four global admin acts, no more, no fewer', () => {
		const ids = resolveDestinations('Setup', COMMISSIONER_SESSION).map((d) => d.id);
		expect(ids).toEqual([
			'import',
			'minor-league-eligibility',
			'manager-registration',
			'auction-open-gate'
		]);
	});

	it('Archived: carries no Commissioner split — the same set for Commissioner and Manager alike', () => {
		expect(resolveDestinations('Archived', MANAGER_SESSION)).toEqual(
			resolveDestinations('Archived', COMMISSIONER_SESSION)
		);
	});
});

describe('requireLiveDestination', () => {
	/** Assert a call refuses with the guard's 403, and nothing else. */
	function expectRefusal(session: SessionState, phase: LeaguePhase, id: string): void {
		let thrown: unknown;
		try {
			requireLiveDestination(session, phase, id);
		} catch (caught) {
			thrown = caught;
		}
		expect(
			thrown,
			`requireLiveDestination(${session.kind}, ${phase}, ${id}) did not throw`
		).toBeDefined();
		expect(isHttpError(thrown)).toBe(true);
		if (isHttpError(thrown)) {
			expect(thrown.status).toBe(LIVE_DESTINATION_REFUSAL_STATUS);
			expect(thrown.body.message).toBe(LIVE_DESTINATION_REFUSAL);
		}
	}

	it('allows a live destination without throwing', () => {
		expect(() => requireLiveDestination(MANAGER_SESSION, 'Auction', 'bid-board')).not.toThrow();
		expect(() => requireLiveDestination(COMMISSIONER_SESSION, 'Setup', 'import')).not.toThrow();
	});

	it('refuses a Commissioner-only destination for a non-Commissioner Manager, in the correct phase', () => {
		expectRefusal(MANAGER_SESSION, 'Setup', 'import');
	});

	it('refuses a destination not live in the current phase, even for a Commissioner', () => {
		expectRefusal(COMMISSIONER_SESSION, 'Setup', 'bid-board');
	});

	it('refuses every destination for a non-registered session except Sign-in', () => {
		expectRefusal({ kind: 'signed-out' }, 'Auction', 'bid-board');
	});

	it('allows Sign-in for a non-registered session, in any phase', () => {
		expect(() =>
			requireLiveDestination({ kind: 'signed-out' }, 'Setup', 'sign-in')
		).not.toThrow();
	});

	it('returns nothing on success — the caller continues past the call', () => {
		expect(requireLiveDestination(MANAGER_SESSION, 'Auction', 'bid-board')).toBeUndefined();
	});

	it('states the fact without asserting a specific cause (phase vs. role) it cannot always know', () => {
		expect(LIVE_DESTINATION_REFUSAL.toLowerCase()).not.toContain('current phase');
		expect(LIVE_DESTINATION_REFUSAL).not.toContain('!');
	});
});
