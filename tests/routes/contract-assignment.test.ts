/**
 * The `/contract-assignment` handlers, exercised through the REAL
 * `requireLiveDestination` guard (nothing about it is mocked) so this proves
 * the route actually calls it on `load` AND on both actions. Only the
 * I/O-touching layer is faked.
 *
 * `tests/routes/nominate.test.ts`'s shape, for its reason: the guard is the one
 * thing a route test can prove that no other suite can, and mocking it would
 * leave the phase gate — the I/O Matrix's "wrong phase" row — untested
 * everywhere.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

import { contractAssignmentRefusalDetail } from '../../src/lib/core/rules/contract-assignment.ts';
import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';

const stub = vi.hoisted(() => ({
	board: {} as Record<string, unknown>,
	assignOutcome: { kind: 'accepted', events: [] as unknown[] } as Record<string, unknown>,
	submitOutcome: { kind: 'accepted', events: [] as unknown[] } as Record<string, unknown>
}));

const boardCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

const assignCalls = vi.hoisted(
	() =>
		[] as Array<{
			actor: Record<string, unknown>;
			fantraxPlayerId: string;
			contractYears: number;
			deviceClass: string;
		}>
);

const submitCalls = vi.hoisted(
	() => [] as Array<{ actor: Record<string, unknown>; deviceClass: string }>
);

vi.mock('$lib/server/contract-assignment.ts', () => ({
	loadAssignmentBoard: async (_gateway: unknown, actor: Record<string, unknown>) => {
		boardCalls.push(actor);
		return stub.board;
	},
	assignContractLength: async (
		_gateway: unknown,
		actor: Record<string, unknown>,
		fantraxPlayerId: string,
		contractYears: number,
		deviceClass: string
	) => {
		assignCalls.push({ actor, fantraxPlayerId, contractYears, deviceClass });
		return stub.assignOutcome;
	},
	submitAssignmentsFinal: async (
		_gateway: unknown,
		actor: Record<string, unknown>,
		deviceClass: string
	) => {
		submitCalls.push({ actor, deviceClass });
		return stub.submitOutcome;
	}
}));

vi.mock('$lib/shell/db.ts', () => ({
	writeGateway: () => ({
		connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} })
	})
}));

const route = await import('../../src/routes/contract-assignment/+page.server.ts');

const MANAGER: RegisteredManager = {
	id: 'm-k',
	discordUserId: '222',
	displayName: 'Kay',
	teamId: 't-k',
	teamName: 'Team K',
	isCommissioner: false
};

const COMMISSIONER: RegisteredManager = {
	id: 'm-1',
	discordUserId: '111',
	displayName: 'Commissioner Bob',
	teamId: 't-1',
	teamName: 'Celtics',
	isCommissioner: true
};

const ASSIGNMENT_PHASE: ResolvedPhase = {
	name: 'Contract Assignment',
	sentence: 'Contract Assignment.',
	announcement: null
};
const AUCTION_PHASE: ResolvedPhase = {
	name: 'Auction',
	sentence: 'Auction.',
	announcement: null
};
const ARCHIVED_PHASE: ResolvedPhase = {
	name: 'Archived',
	sentence: 'Archived.',
	announcement: null
};

function locals(session: SessionState, phase: ResolvedPhase = ASSIGNMENT_PHASE) {
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

const APPENDED = {
	seq: '77',
	occurredAt: '2026-09-01T09:00:00.000Z',
	deviceClass: 'mobile',
	payload: {}
};

beforeEach(() => {
	stub.board = {
		rows: [],
		remaining: { fourYear: 1, threeYear: 1, twoYear: 2 },
		remainingSentence: 'Allotment sentence.',
		unsetCount: 0,
		submitted: false,
		submittedDetail: null,
		canSubmit: true,
		submitBlockedDetail: null,
		submitConsequence: 'Consequence.'
	};
	stub.assignOutcome = { kind: 'accepted', events: [APPENDED] };
	stub.submitOutcome = { kind: 'accepted', events: [APPENDED] };
	boardCalls.length = 0;
	assignCalls.length = 0;
	submitCalls.length = 0;
});

describe('load — a Manager destination, gated on the destination and NOT on the role', () => {
	it('serves an ordinary Manager the board the core worded', async () => {
		const result = (await route.load({
			locals: locals({ kind: 'registered', manager: MANAGER })
		} as never)) as { board: unknown };

		expect(result.board).toEqual(stub.board);
		expect(boardCalls).toEqual([{ managerId: 'm-k', teamId: 't-k', teamName: 'Team K' }]);
	});

	it('serves the Commissioner too — they are a Manager like any other', async () => {
		await route.load({
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never);
		expect(boardCalls).toHaveLength(1);
	});

	it('refuses in the Auction Phase — this destination is not live there', async () => {
		await expectRefusal(
			() =>
				route.load({
					locals: locals({ kind: 'registered', manager: MANAGER }, AUCTION_PHASE)
				} as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		// The guard runs BEFORE any read.
		expect(boardCalls).toEqual([]);
	});

	it('refuses in Archived too', async () => {
		await expectRefusal(
			() =>
				route.load({
					locals: locals({ kind: 'registered', manager: MANAGER }, ARCHIVED_PHASE)
				} as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(boardCalls).toEqual([]);
	});

	it('refuses a signed-out session with 403', async () => {
		await expectRefusal(
			() => route.load({ locals: locals({ kind: 'signed-out' }) } as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
	});

	it('renders a Manager bound to NO Team the core’s sentence, and reads nothing', async () => {
		const unbound: RegisteredManager = { ...MANAGER, teamId: null };
		const result = (await route.load({
			locals: locals({ kind: 'registered', manager: unbound })
		} as never)) as { board: unknown; unboundDetail: string | null };

		expect(result.board).toBeNull();
		expect(result.unboundDetail).toBe(
			contractAssignmentRefusalDetail({ kind: 'unbound_actor' })
		);
		expect(boardCalls).toEqual([]);
	});
});

describe('actions.assign — gated the same way, and never the check itself', () => {
	const assign = route.actions.assign as unknown as (event: unknown) => unknown;

	function assignEvent(
		fields: Array<[string, string]>,
		session: SessionState = { kind: 'registered', manager: MANAGER },
		phase: ResolvedPhase = ASSIGNMENT_PHASE,
		headers: Record<string, string> = {
			'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148'
		}
	) {
		const form = new FormData();
		for (const [key, value] of fields) form.append(key, value);
		return {
			request: new Request('https://app.example/contract-assignment', {
				method: 'POST',
				body: form,
				headers
			}),
			locals: locals(session, phase)
		};
	}

	const CONFIRMED: Array<[string, string]> = [
		['fantraxPlayerId', 'p-1'],
		['contractYears', '4'],
		['confirm', 'yes']
	];

	it('refuses outside the Contract Assignment Phase — the guard runs on the action too', async () => {
		await expectRefusal(
			() =>
				assign(
					assignEvent(CONFIRMED, { kind: 'registered', manager: MANAGER }, AUCTION_PHASE)
				),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(assignCalls).toEqual([]);
	});

	it('assigns, passing the actor from the session and the device class from the header', async () => {
		const result = (await assign(assignEvent(CONFIRMED))) as { notice: string };

		expect(assignCalls).toEqual([
			{
				actor: { managerId: 'm-k', teamId: 't-k', teamName: 'Team K' },
				fantraxPlayerId: 'p-1',
				contractYears: 4,
				deviceClass: 'mobile'
			}
		]);
		expect(result.notice).toContain('assigned');
	});

	it('parses the length as a NUMBER of the four legal values', async () => {
		await assign(
			assignEvent([
				['fantraxPlayerId', 'p-1'],
				['contractYears', '1'],
				['confirm', 'yes']
			])
		);
		expect(assignCalls[0]?.contractYears).toBe(1);
	});

	it('refuses a submit naming no Player, without opening a transaction', async () => {
		const result = (await assign(
			assignEvent([
				['contractYears', '4'],
				['confirm', 'yes']
			])
		)) as { status: number; data: { notice: string } };

		expect(result.status).toBe(400);
		expect(result.data.notice).toBe(contractAssignmentRefusalDetail({ kind: 'not_won' }));
		expect(assignCalls).toEqual([]);
	});

	it('refuses an illegal or unparsable length, without opening a transaction', async () => {
		for (const years of ['', '0', '5', '4x', '2.5', 'four', ' ']) {
			assignCalls.length = 0;
			const result = (await assign(
				assignEvent([
					['fantraxPlayerId', 'p-1'],
					['contractYears', years],
					['confirm', 'yes']
				])
			)) as { status: number; data: { notice: string } };

			expect(result.status, years).toBe(400);
			expect(result.data.notice).toBe(
				contractAssignmentRefusalDetail({ kind: 'invalid_length' })
			);
			expect(assignCalls).toEqual([]);
		}
	});

	it('refuses an UNCONFIRMED post, independently of the UI', async () => {
		const result = (await assign(
			assignEvent([
				['fantraxPlayerId', 'p-1'],
				['contractYears', '4']
			])
		)) as { status: number; data: { notice: string } };

		expect(result.status).toBe(400);
		expect(result.data.notice).toBe(contractAssignmentRefusalDetail({ kind: 'unconfirmed' }));
		expect(assignCalls).toEqual([]);
	});

	it('refuses an unbound actor with 403, and appends nothing', async () => {
		const unbound: RegisteredManager = { ...MANAGER, teamId: null };
		const result = (await assign(
			assignEvent(CONFIRMED, { kind: 'registered', manager: unbound })
		)) as { status: number; data: { notice: string } };

		expect(result.status).toBe(403);
		expect(result.data.notice).toBe(contractAssignmentRefusalDetail({ kind: 'unbound_actor' }));
		expect(assignCalls).toEqual([]);
	});

	it('returns the command’s own refusal sentence with 409, re-wording nothing', async () => {
		const detail = contractAssignmentRefusalDetail({
			kind: 'already_final',
			teamName: 'Team K'
		});
		stub.assignOutcome = {
			kind: 'rejected',
			reason: { refusal: { kind: 'already_final', teamName: 'Team K' }, detail }
		};

		const result = (await assign(assignEvent(CONFIRMED))) as {
			status: number;
			data: { notice: string };
		};

		expect(result.status).toBe(409);
		expect(result.data.notice).toBe(detail);
	});

	it('falls back to the core’s `unrecorded` sentence for a reasonless rejection', async () => {
		stub.assignOutcome = { kind: 'rejected' };

		const result = (await assign(assignEvent(CONFIRMED))) as {
			status: number;
			data: { notice: string };
		};

		expect(result.status).toBe(409);
		expect(result.data.notice).toBe(contractAssignmentRefusalDetail({ kind: 'unrecorded' }));
	});

	it('reports the appended event so the Manager can see the fold moved', async () => {
		const result = (await assign(assignEvent(CONFIRMED))) as {
			appended: { seq: string } | null;
		};
		expect(result.appended).toEqual({
			seq: '77',
			occurredAt: '2026-09-01T09:00:00.000Z',
			deviceClass: 'mobile'
		});
	});

	it('classifies an absent user-agent rather than failing over it', async () => {
		await assign(
			assignEvent(CONFIRMED, { kind: 'registered', manager: MANAGER }, ASSIGNMENT_PHASE, {})
		);
		expect(assignCalls[0]?.deviceClass).toBe('unknown');
	});
});

describe('actions.submit — the second two-part act, gated the same way', () => {
	const submit = route.actions.submit as unknown as (event: unknown) => unknown;

	function submitEvent(
		fields: Array<[string, string]>,
		session: SessionState = { kind: 'registered', manager: MANAGER },
		phase: ResolvedPhase = ASSIGNMENT_PHASE
	) {
		const form = new FormData();
		for (const [key, value] of fields) form.append(key, value);
		return {
			request: new Request('https://app.example/contract-assignment', {
				method: 'POST',
				body: form,
				headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
			}),
			locals: locals(session, phase)
		};
	}

	it('refuses outside the Contract Assignment Phase', async () => {
		await expectRefusal(
			() =>
				submit(
					submitEvent(
						[['confirm', 'yes']],
						{ kind: 'registered', manager: MANAGER },
						ARCHIVED_PHASE
					)
				),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(submitCalls).toEqual([]);
	});

	it('submits, passing the actor from the session', async () => {
		const result = (await submit(submitEvent([['confirm', 'yes']]))) as { notice: string };

		expect(submitCalls).toEqual([
			{ actor: { managerId: 'm-k', teamId: 't-k', teamName: 'Team K' }, deviceClass: 'desktop' }
		]);
		expect(result.notice).toContain('final');
	});

	it('refuses an UNCONFIRMED submission, independently of the UI', async () => {
		const result = (await submit(submitEvent([]))) as {
			status: number;
			data: { notice: string };
		};

		expect(result.status).toBe(400);
		expect(result.data.notice).toBe(contractAssignmentRefusalDetail({ kind: 'unconfirmed' }));
		expect(submitCalls).toEqual([]);
	});

	it('refuses an unbound actor with 403', async () => {
		const unbound: RegisteredManager = { ...MANAGER, teamId: null };
		const result = (await submit(
			submitEvent([['confirm', 'yes']], { kind: 'registered', manager: unbound })
		)) as { status: number; data: { notice: string } };

		expect(result.status).toBe(403);
		expect(submitCalls).toEqual([]);
	});

	it('returns the command’s "still unset" refusal with 409', async () => {
		const detail = contractAssignmentRefusalDetail({ kind: 'unset_on_submit', unsetCount: 3 });
		stub.submitOutcome = {
			kind: 'rejected',
			reason: { refusal: { kind: 'unset_on_submit', unsetCount: 3 }, detail }
		};

		const result = (await submit(submitEvent([['confirm', 'yes']]))) as {
			status: number;
			data: { notice: string };
		};

		expect(result.status).toBe(409);
		expect(result.data.notice).toBe(detail);
		expect(result.data.notice).toContain('3 of the Players');
	});
});
