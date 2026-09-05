/**
 * The `/assignment-monitoring` handlers, exercised through the REAL
 * `requireCommissioner` and `requireLiveDestination` guards (nothing about
 * either is mocked) so this proves the route actually calls both on `load` AND
 * on both actions. Only the I/O-touching layer is faked.
 *
 * `tests/routes/import.test.ts`'s shape, for its reason: the two guards are the
 * one thing a route test can prove that no other suite can, and mocking them
 * would leave the role gate and the phase gate — the I/O Matrix's
 * "non-Commissioner" and "wrong phase" rows — untested everywhere.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

import { assignmentDeadlineRefusalDetail } from '../../src/lib/core/rules/assignment-deadline.ts';
import { COMMISSIONER_ONLY_STATUS } from '../../src/lib/server/commissioner-guard.ts';
import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';

const stub = vi.hoisted(() => ({
	monitor: {} as Record<string, unknown>,
	deadlineOutcome: { kind: 'accepted', events: [] as unknown[] } as Record<string, unknown>,
	intervalOutcome: { kind: 'accepted', events: [] as unknown[] } as Record<string, unknown>
}));

const monitorCalls = vi.hoisted(() => [] as unknown[]);
const deadlineCalls = vi.hoisted(
	() => [] as Array<{ actor: Record<string, unknown>; deadline: string; deviceClass: string }>
);
const intervalCalls = vi.hoisted(
	() => [] as Array<{ actor: Record<string, unknown>; hours: number; deviceClass: string }>
);

vi.mock('$lib/server/assignment-deadline.ts', () => ({
	loadAssignmentMonitor: async (gateway: unknown) => {
		monitorCalls.push(gateway);
		return stub.monitor;
	},
	setAssignmentDeadline: async (
		_gateway: unknown,
		actor: Record<string, unknown>,
		deadline: string,
		deviceClass: string
	) => {
		deadlineCalls.push({ actor, deadline, deviceClass });
		return stub.deadlineOutcome;
	},
	setReminderInterval: async (
		_gateway: unknown,
		actor: Record<string, unknown>,
		hours: number,
		deviceClass: string
	) => {
		intervalCalls.push({ actor, hours, deviceClass });
		return stub.intervalOutcome;
	}
}));

vi.mock('$lib/shell/db.ts', () => ({
	writeGateway: () => ({
		connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} })
	})
}));

const route = await import('../../src/routes/assignment-monitoring/+page.server.ts');

/**
 * The two actions as plain callables. `Actions` types every entry as possibly
 * absent, and a test that asserted their presence with `!` would be asserting
 * the thing it is here to exercise — `import.test.ts`'s cast, for its reason.
 */
const deadlineAction = route.actions.deadline as unknown as (event: unknown) => unknown;
const intervalAction = route.actions.interval as unknown as (event: unknown) => unknown;

const COMMISSIONER: RegisteredManager = {
	id: 'm-1',
	discordUserId: '111',
	displayName: 'Commissioner Bob',
	teamId: 't-1',
	teamName: 'Celtics',
	isCommissioner: true
};

const UNBOUND_COMMISSIONER: RegisteredManager = {
	...COMMISSIONER,
	teamId: null,
	teamName: null
};

const MANAGER: RegisteredManager = {
	id: 'm-k',
	discordUserId: '222',
	displayName: 'Kay',
	teamId: 't-k',
	teamName: 'Team K',
	isCommissioner: false
};

const ASSIGNMENT_PHASE: ResolvedPhase = {
	name: 'Contract Assignment',
	sentence: 'Contract Assignment.',
	announcement: null
};
const SETUP_PHASE: ResolvedPhase = { name: 'Setup', sentence: 'Setup.', announcement: null };
const AUCTION_PHASE: ResolvedPhase = { name: 'Auction', sentence: 'Auction.', announcement: null };
const ARCHIVED_PHASE: ResolvedPhase = { name: 'Archived', sentence: 'Archived.', announcement: null };

function locals(session: SessionState, phase: ResolvedPhase = ASSIGNMENT_PHASE) {
	return { session, phase };
}

function request(fields: Record<string, string>, userAgent = 'Mozilla/5.0 (Macintosh)') {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return {
		formData: async () => form,
		headers: { get: (name: string) => (name === 'user-agent' ? userAgent : null) }
	};
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
	seq: '91',
	occurredAt: '2026-09-01T09:00:00.000Z',
	deviceClass: 'desktop',
	payload: {}
};

const DEADLINE = '2026-09-10T17:00:00Z';

beforeEach(() => {
	stub.monitor = {
		rows: [],
		teamCount: 0,
		submittedCount: 0,
		outstandingCount: 0,
		outstandingPlayerCount: 0,
		completionSentence: 'Completion.',
		deadline: null,
		deadlineSentence: 'Deadline.',
		reminderIntervalHours: null,
		reminderSentence: 'Reminder.',
		noticeSent: false,
		noticeSentence: 'Notice.'
	};
	stub.deadlineOutcome = { kind: 'accepted', events: [APPENDED] };
	stub.intervalOutcome = { kind: 'accepted', events: [APPENDED] };
	monitorCalls.length = 0;
	deadlineCalls.length = 0;
	intervalCalls.length = 0;
});

describe('load — Commissioner-only, and live only in Contract Assignment', () => {
	it('serves the Commissioner the monitor the core worded', async () => {
		const result = (await route.load({
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never)) as { monitor: unknown };

		expect(result.monitor).toEqual(stub.monitor);
		expect(monitorCalls).toHaveLength(1);
	});

	it('refuses an ordinary Manager server-side, before any read', async () => {
		await expectRefusal(
			() => route.load({ locals: locals({ kind: 'registered', manager: MANAGER }) } as never),
			COMMISSIONER_ONLY_STATUS
		);
		expect(monitorCalls).toHaveLength(0);
	});

	it('refuses a signed-out session', async () => {
		await expectRefusal(
			() => route.load({ locals: locals({ kind: 'signed-out' }) } as never),
			COMMISSIONER_ONLY_STATUS
		);
	});

	for (const phase of [SETUP_PHASE, AUCTION_PHASE, ARCHIVED_PHASE]) {
		it(`refuses the Commissioner in the ${phase.name} Phase — the destination is not live there`, async () => {
			await expectRefusal(
				() =>
					route.load({
						locals: locals({ kind: 'registered', manager: COMMISSIONER }, phase)
					} as never),
				LIVE_DESTINATION_REFUSAL_STATUS
			);
			expect(monitorCalls).toHaveLength(0);
		});
	}
});

describe('the deadline action — two-part, and gated again', () => {
	it('re-runs BOTH guards: an ordinary Manager is refused on the action too', async () => {
		await expectRefusal(
			() =>
				deadlineAction({
					request: request({ deadline: DEADLINE, confirm: 'yes' }),
					locals: locals({ kind: 'registered', manager: MANAGER })
				} as never),
			COMMISSIONER_ONLY_STATUS
		);
		expect(deadlineCalls).toHaveLength(0);
	});

	it('re-runs the phase guard on the action too', async () => {
		await expectRefusal(
			() =>
				deadlineAction({
					request: request({ deadline: DEADLINE, confirm: 'yes' }),
					locals: locals({ kind: 'registered', manager: COMMISSIONER }, AUCTION_PHASE)
				} as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(deadlineCalls).toHaveLength(0);
	});

	it('refuses an UNCONFIRMED post independently of the UI, opening no transaction', async () => {
		const result = (await deadlineAction({
			request: request({ deadline: DEADLINE }),
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never)) as { status: number; data: { deadlineNotice: string } };

		expect(result.status).toBe(400);
		expect(result.data.deadlineNotice).toBe(
			assignmentDeadlineRefusalDetail({ kind: 'unconfirmed' })
		);
		expect(deadlineCalls).toHaveLength(0);
	});

	it('refuses a post naming no instant, in the core’s words', async () => {
		const result = (await deadlineAction({
			request: request({ confirm: 'yes' }),
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never)) as { status: number; data: { deadlineNotice: string } };

		expect(result.status).toBe(400);
		expect(result.data.deadlineNotice).toBe(
			assignmentDeadlineRefusalDetail({ kind: 'unparseable_deadline' })
		);
		expect(deadlineCalls).toHaveLength(0);
	});

	it('refuses a Commissioner bound to no Team — there is no event to append', async () => {
		const result = (await deadlineAction({
			request: request({ deadline: DEADLINE, confirm: 'yes' }),
			locals: locals({ kind: 'registered', manager: UNBOUND_COMMISSIONER })
		} as never)) as { status: number; data: { deadlineNotice: string } };

		expect(result.status).toBe(403);
		expect(result.data.deadlineNotice).toBe(
			assignmentDeadlineRefusalDetail({ kind: 'unbound_actor' })
		);
		expect(deadlineCalls).toHaveLength(0);
	});

	it('passes the session-resolved actor and the device class, never a form field', async () => {
		await deadlineAction({
			request: request({ deadline: DEADLINE, confirm: 'yes', teamId: 't-forged' }),
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never);

		expect(deadlineCalls).toEqual([
			{
				actor: { managerId: 'm-1', teamId: 't-1', teamName: 'Celtics' },
				deadline: DEADLINE,
				deviceClass: 'desktop'
			}
		]);
	});

	it('answers 409 with the command’s own sentence when the gate refuses', async () => {
		stub.deadlineOutcome = {
			kind: 'rejected',
			reason: {
				refusal: { kind: 'not_later', standing: '2026-09-12T17:00:00.000Z' },
				detail: 'the standing deadline sentence'
			}
		};
		const result = (await deadlineAction({
			request: request({ deadline: DEADLINE, confirm: 'yes' }),
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never)) as { status: number; data: { deadlineNotice: string } };

		expect(result.status).toBe(409);
		expect(result.data.deadlineNotice).toBe('the standing deadline sentence');
	});

	it('answers 400, not 409, for an instant at or before the database clock', async () => {
		// The matrix separates the two gate refusals by status on purpose: a
		// past instant is a value the Commissioner could have spelled
		// differently, while a non-later one conflicts with a deadline that is
		// already standing. Both are decided inside the transaction against the
		// database clock, so the route can only tell them apart by reading the
		// refusal off the rejection.
		stub.deadlineOutcome = {
			kind: 'rejected',
			reason: {
				refusal: { kind: 'deadline_in_past', now: '2026-09-05T09:00:00.000Z' },
				detail: 'the past-instant sentence'
			}
		};
		const result = (await deadlineAction({
			request: request({ deadline: DEADLINE, confirm: 'yes' }),
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never)) as { status: number; data: { deadlineNotice: string } };

		expect(result.status).toBe(400);
		expect(result.data.deadlineNotice).toBe('the past-instant sentence');
	});

	it('falls back to the core’s "unrecorded" sentence for a reasonless refusal', async () => {
		stub.deadlineOutcome = { kind: 'rejected' };
		const result = (await deadlineAction({
			request: request({ deadline: DEADLINE, confirm: 'yes' }),
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never)) as { data: { deadlineNotice: string } };

		expect(result.data.deadlineNotice).toBe(
			assignmentDeadlineRefusalDetail({ kind: 'unrecorded' })
		);
	});

	it('reports the appended event on acceptance', async () => {
		const result = (await deadlineAction({
			request: request({ deadline: DEADLINE, confirm: 'yes' }),
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never)) as { deadlineNotice: string; appended: { seq: string } | null };

		expect(result.appended).toEqual({
			seq: '91',
			occurredAt: '2026-09-01T09:00:00.000Z',
			deviceClass: 'desktop'
		});
		expect(result.deadlineNotice).not.toContain('!');
	});
});

describe('the interval action — two-part, and gated again', () => {
	it('re-runs both guards', async () => {
		await expectRefusal(
			() =>
				intervalAction({
					request: request({ intervalHours: '24', confirm: 'yes' }),
					locals: locals({ kind: 'registered', manager: MANAGER })
				} as never),
			COMMISSIONER_ONLY_STATUS
		);
		await expectRefusal(
			() =>
				intervalAction({
					request: request({ intervalHours: '24', confirm: 'yes' }),
					locals: locals({ kind: 'registered', manager: COMMISSIONER }, ARCHIVED_PHASE)
				} as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(intervalCalls).toHaveLength(0);
	});

	it('refuses an unconfirmed post', async () => {
		const result = (await intervalAction({
			request: request({ intervalHours: '24' }),
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never)) as { status: number; data: { intervalNotice: string } };

		expect(result.status).toBe(400);
		expect(result.data.intervalNotice).toBe(
			assignmentDeadlineRefusalDetail({ kind: 'unconfirmed' })
		);
		expect(intervalCalls).toHaveLength(0);
	});

	it('refuses a value that is not a number at all, before any transaction', async () => {
		for (const bad of ['', 'soon', '24h']) {
			intervalCalls.length = 0;
			const result = (await intervalAction({
				request: request({ intervalHours: bad, confirm: 'yes' }),
				locals: locals({ kind: 'registered', manager: COMMISSIONER })
			} as never)) as { status: number; data: { intervalNotice: string } };

			expect(result.status).toBe(400);
			expect(result.data.intervalNotice).toBe(
				assignmentDeadlineRefusalDetail({ kind: 'invalid_interval' })
			);
			expect(intervalCalls).toHaveLength(0);
		}
	});

	it('hands a numeric interval to the command, which owns the range gate', async () => {
		await intervalAction({
			request: request({ intervalHours: '2.5', confirm: 'yes' }),
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never);
		// The route refuses only what is not a value; whether 2.5 is a legal
		// interval is re-derived inside the transaction.
		expect(intervalCalls).toEqual([
			{
				actor: { managerId: 'm-1', teamId: 't-1', teamName: 'Celtics' },
				hours: 2.5,
				deviceClass: 'desktop'
			}
		]);
	});

	it('answers 400 when that range gate refuses — a number, but not a legal one', async () => {
		stub.intervalOutcome = {
			kind: 'rejected',
			reason: {
				refusal: { kind: 'invalid_interval' },
				detail: 'the interval range sentence'
			}
		};
		const result = (await intervalAction({
			request: request({ intervalHours: '2.5', confirm: 'yes' }),
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never)) as { status: number; data: { intervalNotice: string } };

		expect(result.status).toBe(400);
		expect(result.data.intervalNotice).toBe('the interval range sentence');
	});
});

describe('no code path on this route writes a contract length', () => {
	it('calls only the deadline and interval commands, never an assignment one', async () => {
		const contractModule = await import('../../src/lib/server/contract-assignment.ts');
		const spy = vi.spyOn(contractModule, 'assignContractLength');

		await route.load({
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never);
		await deadlineAction({
			request: request({ deadline: DEADLINE, confirm: 'yes' }),
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never);
		await intervalAction({
			request: request({ intervalHours: '24', confirm: 'yes' }),
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never);

		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});
