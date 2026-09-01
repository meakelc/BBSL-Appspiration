import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { isHttpError } from '@sveltejs/kit';

import { eligibilityRefusalDetail } from '../../src/lib/core/rules/eligibility.ts';
import { COMMISSIONER_ONLY_STATUS } from '../../src/lib/server/commissioner-guard.ts';
import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';

/**
 * The `/minor-league-eligibility` handlers, exercised through the REAL
 * `requireCommissioner`/`requireLiveDestination` guards (nothing about them
 * is mocked) so this proves the route actually calls them on `load` AND on
 * the action. Only the I/O-touching layer is faked.
 */

const stub = vi.hoisted(() => ({
	players: [] as unknown[],
	result: { outcome: { kind: 'accepted', events: [] as unknown[] }, plan: null } as Record<
		string,
		unknown
	>
}));

const setCalls = vi.hoisted(
	() => [] as Array<{ actor: { managerId: string; teamId: string }; ids: string[]; target: boolean }>
);

vi.mock('$lib/server/eligibility.ts', () => ({
	loadEligibilityPool: async () => ({ players: stub.players }),
	setEligibility: vi.fn(
		async (
			_gateway: unknown,
			actor: { managerId: string; teamId: string },
			ids: string[],
			target: boolean
		) => {
			setCalls.push({ actor, ids, target });
			return stub.result;
		}
	)
}));

vi.mock('$lib/shell/db.ts', () => ({
	writeGateway: () => ({
		connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} })
	})
}));

const route = await import('../../src/routes/minor-league-eligibility/+page.server.ts');

const COMMISSIONER: RegisteredManager = {
	id: 'm-1',
	discordUserId: '111',
	displayName: 'Commissioner Bob',
	teamId: 't-1',
	teamName: 'Celtics',
	isCommissioner: true
};

const MANAGER: RegisteredManager = {
	id: 'm-2',
	discordUserId: '222',
	displayName: 'Alice',
	teamId: 't-2',
	teamName: 'Lakers',
	isCommissioner: false
};

const SETUP_PHASE: ResolvedPhase = { name: 'Setup', sentence: 'Setup.' , announcement: null };
const AUCTION_PHASE: ResolvedPhase = { name: 'Auction', sentence: 'Auction.' , announcement: null };

function locals(session: SessionState, phase: ResolvedPhase = SETUP_PHASE) {
	return { session, phase };
}

async function expectRefusal(run: () => unknown, status: number): Promise<void> {
	let thrown: unknown;
	try {
		await run();
	} catch (caught) {
		thrown = caught;
	}
	expect(thrown, 'the call did not throw').toBeDefined();
	expect(isHttpError(thrown)).toBe(true);
	if (isHttpError(thrown)) expect(thrown.status).toBe(status);
}

beforeEach(() => {
	stub.players = [];
	stub.result = { outcome: { kind: 'accepted', events: [] }, plan: null };
	setCalls.length = 0;
});

describe('load — Commissioner-only, gated on both the guard and the destination', () => {
	it('refuses a non-Commissioner registered session with 403', async () => {
		await expectRefusal(
			() => route.load({ locals: locals({ kind: 'registered', manager: MANAGER }) } as never),
			COMMISSIONER_ONLY_STATUS
		);
	});

	it('refuses a signed-out session with 403', async () => {
		await expectRefusal(
			() => route.load({ locals: locals({ kind: 'signed-out' }) } as never),
			COMMISSIONER_ONLY_STATUS
		);
	});

	it('refuses a Commissioner outside Setup — this destination is not live in Auction', async () => {
		await expectRefusal(
			() =>
				route.load({
					locals: locals({ kind: 'registered', manager: COMMISSIONER }, AUCTION_PHASE)
				} as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
	});

	it('loads the pool for a Commissioner in Setup, sentences and all', async () => {
		stub.players = [
			{
				fantraxPlayerId: 'p-1',
				playerName: 'Alice',
				positions: 'PG',
				nbaTeam: 'LAL',
				eligible: false,
				consequence: 'Alice is not Minor League Eligible: …'
			}
		];
		const result = (await route.load({
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never)) as { players: unknown[] };

		expect(result.players).toEqual(stub.players);
	});

	it('loads an empty pool without error — nothing promoted is a state, not a failure', async () => {
		const result = (await route.load({
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never)) as { players: unknown[] };
		expect(result.players).toEqual([]);
	});
});

describe('actions.set — gated the same way, and never the check itself', () => {
	const setAction = route.actions.set as unknown as (event: unknown) => unknown;

	function setEvent(
		fields: Array<[string, string]>,
		session: SessionState = { kind: 'registered', manager: COMMISSIONER },
		phase: ResolvedPhase = SETUP_PHASE
	) {
		const form = new FormData();
		for (const [key, value] of fields) form.append(key, value);
		return {
			request: new Request('https://app.example/minor-league-eligibility', {
				method: 'POST',
				body: form
			}),
			locals: locals(session, phase)
		};
	}

	it('refuses a non-Commissioner session with 403, before writing anything', async () => {
		await expectRefusal(
			() =>
				setAction(
					setEvent([['ids', 'p-1'], ['eligible', 'yes']], {
						kind: 'registered',
						manager: MANAGER
					})
				),
			COMMISSIONER_ONLY_STATUS
		);
		expect(setCalls).toEqual([]);
	});

	it('refuses a signed-out session with 403', async () => {
		await expectRefusal(
			() => setAction(setEvent([['ids', 'p-1'], ['eligible', 'yes']], { kind: 'signed-out' })),
			COMMISSIONER_ONLY_STATUS
		);
		expect(setCalls).toEqual([]);
	});

	it('refuses outside Setup — the destination guard runs on the action too', async () => {
		await expectRefusal(
			() =>
				setAction(
					setEvent(
						[['ids', 'p-1'], ['eligible', 'yes']],
						{ kind: 'registered', manager: COMMISSIONER },
						AUCTION_PHASE
					)
				),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(setCalls).toEqual([]);
	});

	it('refuses an empty selection with 400, in the core’s words, writing nothing', async () => {
		const result = (await setAction(setEvent([['eligible', 'yes']]))) as {
			status: number;
			data: { notice: string };
		};
		expect(result.status).toBe(400);
		expect(result.data.notice).toBe(eligibilityRefusalDetail({ kind: 'empty_selection' }));
		expect(setCalls).toEqual([]);
	});

	it('refuses a submission that does not state the direction, in the core’s words', async () => {
		const result = (await setAction(setEvent([['ids', 'p-1']]))) as {
			status: number;
			data: { notice: string };
		};
		expect(result.status).toBe(400);
		expect(result.data.notice).toBe(eligibilityRefusalDetail({ kind: 'unstated_direction' }));
		expect(setCalls).toEqual([]);
	});

	it('refuses a direction field that is neither yes nor no', async () => {
		const result = (await setAction(
			setEvent([['ids', 'p-1'], ['eligible', 'maybe']])
		)) as { status: number };
		expect(result.status).toBe(400);
		expect(setCalls).toEqual([]);
	});

	it.each(['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf'])(
		'refuses the inherited Object.prototype key %s as a direction',
		async (key: string) => {
			// A lookup object would resolve every one of these to an inherited
			// member instead of `undefined`, passing the "is this a known
			// direction?" check with a Function bound as the direction — which
			// would reach the planner and land as a non-boolean `after` in an
			// event payload that cannot be corrected in place.
			const result = (await setAction(
				setEvent([['ids', 'p-1'], ['eligible', key]])
			)) as { status: number; data: { notice: string } };
			expect(result.status).toBe(400);
			expect(result.data.notice).toBe(eligibilityRefusalDetail({ kind: 'unstated_direction' }));
			expect(setCalls).toEqual([]);
		}
	);

	it('refuses with 400 when the acting Commissioner is bound to no Team', async () => {
		const unbound: RegisteredManager = { ...COMMISSIONER, teamId: null };
		const result = (await setAction(
			setEvent([['ids', 'p-1'], ['eligible', 'yes']], { kind: 'registered', manager: unbound })
		)) as { status: number; data: { notice: string } };

		expect(result.status).toBe(400);
		expect(result.data.notice).toBe(eligibilityRefusalDetail({ kind: 'unbound_actor' }));
		expect(setCalls).toEqual([]);
	});

	it('passes every selected id and the direction, with the actor from the session', async () => {
		stub.result = {
			outcome: { kind: 'accepted', events: [{ seq: '11', occurredAt: 'now' }] },
			plan: { changes: [{ playerName: 'Alice' }], unchanged: [], unknownIds: [] }
		};
		const result = (await setAction(
			setEvent([
				['ids', 'p-1'],
				['ids', 'p-2'],
				['eligible', 'yes'],
				// A form field naming a different actor must be ignored entirely.
				['managerId', 'not-me']
			])
		)) as { notice: string; appended: unknown[] };

		expect(setCalls).toEqual([
			{
				actor: { managerId: COMMISSIONER.id, teamId: COMMISSIONER.teamId },
				ids: ['p-1', 'p-2'],
				target: true
			}
		]);
		expect(result.notice).toContain('Alice');
		expect(result.appended).toEqual([{ seq: '11', occurredAt: 'now' }]);
	});

	it('passes target false for an unset', async () => {
		await setAction(setEvent([['ids', 'p-1'], ['eligible', 'no']]));
		expect(setCalls[0]?.target).toBe(false);
	});

	it('renders the refusal sentence the transaction produced, without rewording it', async () => {
		const refusal = { kind: 'unknown_players', fantraxPlayerIds: ['ghost'] } as const;
		stub.result = {
			outcome: {
				kind: 'rejected',
				reason: { refusal, detail: eligibilityRefusalDetail(refusal) }
			},
			plan: null
		};
		const result = (await setAction(
			setEvent([['ids', 'ghost'], ['eligible', 'yes']])
		)) as { status: number; data: { notice: string } };

		expect(result.status).toBe(409);
		expect(result.data.notice).toBe(eligibilityRefusalDetail(refusal));
	});

	it('states a no-op submission as unchanged, with no event', async () => {
		stub.result = {
			outcome: { kind: 'accepted', events: [] },
			plan: {
				changes: [],
				unchanged: [{ fantraxPlayerId: 'p-1', playerName: 'Alice', eligible: true }],
				unknownIds: []
			}
		};
		const result = (await setAction(
			setEvent([['ids', 'p-1'], ['eligible', 'yes']])
		)) as { notice: string; appended: unknown[] };

		expect(result.appended).toEqual([]);
		expect(result.notice).toContain('Alice');
		expect(result.notice).toContain('No Player was set');
	});
});

// --- The empty state offers no control -------------------------------------

describe('the surface when nothing has been promoted', () => {
	/**
	 * Asserted against the source text, not a render: `vite.config.ts` sets
	 * `environment: 'node'` and no component harness exists (deferred-work.md),
	 * so `tests/signin-surface.test.ts` established this discipline for every
	 * surface claim in the repository.
	 *
	 * The claim is the I/O matrix's "nothing promoted yet" row: the empty
	 * state names Import as what is outstanding and offers NO control. The
	 * branch structure is what guarantees it — every control lives in the
	 * `{:else}` half — so that is what is asserted, rather than the prose.
	 */
	const SOURCE = readFileSync(
		new URL('../../src/routes/minor-league-eligibility/+page.svelte', import.meta.url),
		'utf8'
	);

	function emptyBranch(): string {
		const start = SOURCE.indexOf('{#if poolIsEmpty}');
		const end = SOURCE.indexOf('{:else}', start);
		expect(start, 'the empty state branch is gone').toBeGreaterThan(-1);
		expect(end, 'the empty state has no non-empty counterpart').toBeGreaterThan(start);
		return SOURCE.slice(start, end);
	}

	it('names Import as what is outstanding', () => {
		expect(emptyBranch()).toContain('Import');
	});

	it('offers no form, no control and no checkbox while the pool is empty', () => {
		const branch = emptyBranch();
		expect(branch, 'the empty state offers a form').not.toMatch(/<form\b/);
		expect(branch, 'the empty state offers a button').not.toMatch(/<button\b/);
		expect(branch, 'the empty state offers an input').not.toMatch(/<input\b/);
		expect(branch, 'the empty state offers a Commissioner control').not.toContain(
			'control-commissioner'
		);
	});
});
