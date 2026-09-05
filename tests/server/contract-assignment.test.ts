/**
 * The two Contract Assignment transactions and the surface's read. Server-only
 * (Story 6.1).
 *
 * The stateful fake `ConnectionGateway` is `tests/server/nomination.test.ts`'s,
 * narrowed to the statements this module actually issues: it records every
 * statement in order and keeps the appended events in memory, so "no event was
 * appended" and "everything rolled back on a refusal" are observable rather
 * than assumed. The fake throws on any statement it does not recognise, which
 * is what makes "no table was written and no projection registered" provable
 * rather than merely unasserted — this story's whole claim is that a contract
 * length is a fold and nothing else.
 *
 * What is NOT here: the allotment arithmetic itself. That is
 * `tests/core/contract-assignment.test.ts`', proved with no database at all.
 * This suite proves the transaction re-derives it under the lock and appends
 * the right event.
 */

import { describe, expect, it } from 'vitest';

import { closedPayload } from '../fixtures/closed-event.ts';

import { ASSIGNMENTS_SUBMITTED_EVENT } from '../../src/lib/core/projection/assignments.ts';
import { CONTRACT_LENGTH_ASSIGNED_EVENT } from '../../src/lib/core/projection/contracts.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { contractAssignmentRefusalDetail } from '../../src/lib/core/rules/contract-assignment.ts';
import {
	assignContractLength,
	loadAssignmentBoard,
	submitAssignmentsFinal
} from '../../src/lib/server/contract-assignment.ts';
import type { ContractAssignmentRejection } from '../../src/lib/server/contract-assignment.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

const ACTOR = { managerId: 'm-k', teamId: 't-k', teamName: 'Team K' };

const NOW = new Date('2026-09-01T09:00:00.000Z');

const DEVICE_CLASS = 'mobile';

let rowSeq = 0;

/** One log row as `select * from auction_events` returns it. */
function logRow(type: string, payload: unknown, teamId = 't-k'): QueryResultRow {
	rowSeq += 1;
	return {
		seq: rowSeq,
		occurred_at: '2026-08-27T09:00:00.000Z',
		schema_version: 1,
		core_version: 1,
		manager_id: 'm-k',
		team_id: teamId,
		event_type: type,
		payload,
		device_class: null,
		dispatch_outcome: null,
		delivery_outcome: null
	};
}

function wonRow(playerId: string, playerName: string, teamId = 't-k'): QueryResultRow {
	return logRow(
		AUCTION_CLOSED_EVENT,
		closedPayload({
			fantraxPlayerId: playerId,
			playerName,
			teamId,
			teamName: teamId === 't-k' ? 'Team K' : 'Team Other'
		}),
		teamId
	);
}

function assignedRow(playerId: string, years: number, teamId = 't-k'): QueryResultRow {
	return logRow(
		CONTRACT_LENGTH_ASSIGNED_EVENT,
		{
			fantraxPlayerId: playerId,
			playerName: playerId,
			teamId,
			teamName: 'Team K',
			managerId: 'm-k',
			contractYears: years
		},
		teamId
	);
}

function submittedRow(teamId = 't-k'): QueryResultRow {
	return logRow(
		ASSIGNMENTS_SUBMITTED_EVENT,
		{ teamId, teamName: 'Team K', managerId: 'm-k', assignedCount: 0 },
		teamId
	);
}

function fakeGateway(events: QueryResultRow[] = []) {
	const order: string[] = [];
	const params: unknown[][] = [];
	const appendedEvents: QueryResultRow[] = [];
	let seq = 100;
	let released = 0;

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, queryParams: readonly unknown[] = []) {
			const sql = text.trim();
			if (/^begin/i.test(sql)) {
				order.push('begin');
				return { rows: [] };
			}
			if (/pg_advisory_xact_lock/i.test(sql)) {
				order.push('lock');
				return { rows: [{ locked: true, now: NOW }] };
			}
			if (/^select \* from auction_events/i.test(sql)) {
				order.push('read-log');
				return { rows: events };
			}
			if (/^insert into auction_events/i.test(sql)) {
				order.push('append-event');
				params.push([...queryParams]);
				seq += 1;
				const row: QueryResultRow = {
					seq,
					occurred_at: queryParams[0],
					schema_version: queryParams[1],
					core_version: queryParams[2],
					manager_id: queryParams[3],
					team_id: queryParams[4],
					event_type: queryParams[5],
					payload: JSON.parse(String(queryParams[6])),
					device_class: queryParams[7],
					dispatch_outcome: queryParams[8],
					delivery_outcome: queryParams[9]
				};
				appendedEvents.push(row);
				return { rows: [row] };
			}
			if (/^commit/i.test(sql)) {
				order.push('commit');
				return { rows: [] };
			}
			if (/^rollback/i.test(sql)) {
				order.push('rollback');
				// A real ROLLBACK discards every uncommitted write; the fake must
				// too, or "nothing was written" would be trivially true.
				appendedEvents.length = 0;
				return { rows: [] };
			}
			throw new Error(`unexpected statement: ${sql}`);
		},
		release() {
			released += 1;
		}
	};

	const gateway: ConnectionGateway = { connect: async () => client };
	return {
		gateway,
		order,
		params,
		appendedEvents,
		releasedCount: () => released
	};
}

/** Five wins for Team K, the §10 example 14 shape. */
function fiveWins(): QueryResultRow[] {
	return [
		wonRow('p-1', 'Player One'),
		wonRow('p-2', 'Player Two'),
		wonRow('p-3', 'Player Three'),
		wonRow('p-4', 'Player Four'),
		wonRow('p-5', 'Player Five')
	];
}

describe('loadAssignmentBoard — one read, no lock, no decision', () => {
	it('renders the acting Team’s won Players and its remaining allotment', async () => {
		const harness = fakeGateway([...fiveWins(), assignedRow('p-1', 4)]);

		const board = await loadAssignmentBoard(harness.gateway, ACTOR);

		expect(board.rows).toHaveLength(5);
		expect(board.unsetCount).toBe(4);
		expect(board.remaining).toEqual({ fourYear: 0, threeYear: 1, twoYear: 2 });
		// One statement, and it is the log read: a length is a fold, so there is
		// no contracts table to join and no lock to take.
		expect(harness.order).toEqual(['read-log']);
		expect(harness.releasedCount()).toBe(1);
	});

	it('shows another Team nothing of this one’s contracts', async () => {
		const harness = fakeGateway(fiveWins());
		const board = await loadAssignmentBoard(harness.gateway, {
			managerId: 'm-o',
			teamId: 't-other',
			teamName: 'Team Other'
		});
		expect(board.rows).toEqual([]);
	});

	it('returns the connection even when the read throws', async () => {
		const harness = fakeGateway(fiveWins());
		const broken: ConnectionGateway = {
			connect: async () => {
				const client = await harness.gateway.connect();
				return {
					query: async () => {
						throw new Error('the read connection died');
					},
					release: client.release
				};
			}
		};
		await expect(loadAssignmentBoard(broken, ACTOR)).rejects.toThrow('the read connection died');
		expect(harness.releasedCount()).toBe(1);
	});
});

describe('assignContractLength — lock, load, decide, append, commit', () => {
	it('appends exactly one ContractLengthAssigned, in the pipeline’s order', async () => {
		const harness = fakeGateway(fiveWins());

		const outcome = await assignContractLength(
			harness.gateway,
			ACTOR,
			'p-1',
			4,
			DEVICE_CLASS
		);

		expect(outcome.kind).toBe('accepted');
		// The lock is taken BEFORE the log is read (AD-6), and no projection
		// updater runs between the append and the commit — there is none.
		expect(harness.order).toEqual(['begin', 'lock', 'read-log', 'append-event', 'commit']);
		expect(harness.appendedEvents).toHaveLength(1);
	});

	it('names the acting Manager and Team on the envelope (AD-4)', async () => {
		const harness = fakeGateway(fiveWins());
		await assignContractLength(harness.gateway, ACTOR, 'p-1', 3, DEVICE_CLASS);

		const appended = harness.appendedEvents[0];
		expect(appended?.['manager_id']).toBe('m-k');
		expect(appended?.['team_id']).toBe('t-k');
		expect(appended?.['event_type']).toBe(CONTRACT_LENGTH_ASSIGNED_EVENT);
		expect(appended?.['device_class']).toBe(DEVICE_CLASS);
		// The transaction-start clock, read once by the pipeline (AD-3).
		expect(appended?.['occurred_at']).toBe(NOW);
	});

	it('takes the Player and Team names off the CONTRACT, never off the caller', async () => {
		const harness = fakeGateway(fiveWins());
		await assignContractLength(harness.gateway, ACTOR, 'p-2', 2, DEVICE_CLASS);

		expect(harness.appendedEvents[0]?.['payload']).toEqual({
			fantraxPlayerId: 'p-2',
			playerName: 'Player Two',
			teamId: 't-k',
			teamName: 'Team K',
			managerId: 'm-k',
			contractYears: 2
		});
	});

	it('re-derives the allotment INSIDE the transaction and refuses an over-spend', async () => {
		const harness = fakeGateway([
			...fiveWins(),
			assignedRow('p-1', 4),
			assignedRow('p-2', 3),
			assignedRow('p-3', 2),
			assignedRow('p-4', 2)
		]);

		const outcome = await assignContractLength(harness.gateway, ACTOR, 'p-5', 3, DEVICE_CLASS);

		expect(outcome.kind).toBe('rejected');
		const rejection = (outcome as { reason?: ContractAssignmentRejection }).reason;
		expect(rejection?.refusal.kind).toBe('exhausted');
		expect(rejection?.detail).toContain('Player Five');
		// Rolled back with nothing appended, and the append never even ran.
		expect(harness.order).toEqual(['begin', 'lock', 'read-log', 'rollback']);
		expect(harness.appendedEvents).toEqual([]);
	});

	it('accepts the 1-year deal against that same exhausted allotment', async () => {
		const harness = fakeGateway([
			...fiveWins(),
			assignedRow('p-1', 4),
			assignedRow('p-2', 3),
			assignedRow('p-3', 2),
			assignedRow('p-4', 2)
		]);

		expect(
			(await assignContractLength(harness.gateway, ACTOR, 'p-5', 1, DEVICE_CLASS)).kind
		).toBe('accepted');
	});

	it('accepts a correction and appends a SECOND event rather than updating one', async () => {
		const harness = fakeGateway([...fiveWins(), assignedRow('p-1', 4)]);

		const outcome = await assignContractLength(harness.gateway, ACTOR, 'p-1', 2, DEVICE_CLASS);

		expect(outcome.kind).toBe('accepted');
		expect(harness.appendedEvents).toHaveLength(1);
		// Nothing was updated and nothing deleted: the fake recognises no such
		// statement, so a `update auction_events` would have thrown.
		expect(harness.order.filter((step) => step === 'append-event')).toHaveLength(1);
	});

	it('accepts a re-assignment to the SAME length — the Player’s own deal is excluded', async () => {
		const harness = fakeGateway([...fiveWins(), assignedRow('p-1', 4)]);
		expect((await assignContractLength(harness.gateway, ACTOR, 'p-1', 4, DEVICE_CLASS)).kind).toBe(
			'accepted'
		);
	});

	it('refuses every assignment once the Team is final', async () => {
		const harness = fakeGateway([...fiveWins(), submittedRow()]);

		const outcome = await assignContractLength(harness.gateway, ACTOR, 'p-1', 1, DEVICE_CLASS);

		expect(outcome.kind).toBe('rejected');
		const rejection = (outcome as { reason?: ContractAssignmentRejection }).reason;
		expect(rejection?.detail).toBe(
			contractAssignmentRefusalDetail({ kind: 'already_final', teamName: 'Team K' })
		);
		expect(harness.appendedEvents).toEqual([]);
	});

	it('refuses a Player this Team did not win', async () => {
		const harness = fakeGateway([...fiveWins(), wonRow('p-9', 'Somebody Else', 't-other')]);

		const outcome = await assignContractLength(harness.gateway, ACTOR, 'p-9', 1, DEVICE_CLASS);

		expect(outcome.kind).toBe('rejected');
		expect((outcome as { reason?: ContractAssignmentRejection }).reason?.refusal.kind).toBe(
			'not_won'
		);
	});
});

describe('submitAssignmentsFinal — the one-way act', () => {
	it('appends one AssignmentsSubmitted once every won Player carries a length', async () => {
		const harness = fakeGateway([
			...fiveWins(),
			assignedRow('p-1', 4),
			assignedRow('p-2', 3),
			assignedRow('p-3', 2),
			assignedRow('p-4', 2),
			assignedRow('p-5', 1)
		]);

		const outcome = await submitAssignmentsFinal(harness.gateway, ACTOR, DEVICE_CLASS);

		expect(outcome.kind).toBe('accepted');
		expect(harness.order).toEqual(['begin', 'lock', 'read-log', 'append-event', 'commit']);
		expect(harness.appendedEvents[0]?.['event_type']).toBe(ASSIGNMENTS_SUBMITTED_EVENT);
		expect(harness.appendedEvents[0]?.['payload']).toEqual({
			teamId: 't-k',
			teamName: 'Team K',
			managerId: 'm-k',
			assignedCount: 5
		});
		expect(harness.appendedEvents[0]?.['manager_id']).toBe('m-k');
		expect(harness.appendedEvents[0]?.['team_id']).toBe('t-k');
	});

	it('refuses while any won Player has no length, naming how many', async () => {
		const harness = fakeGateway([...fiveWins(), assignedRow('p-1', 4)]);

		const outcome = await submitAssignmentsFinal(harness.gateway, ACTOR, DEVICE_CLASS);

		expect(outcome.kind).toBe('rejected');
		const rejection = (outcome as { reason?: ContractAssignmentRejection }).reason;
		expect(rejection?.refusal).toEqual({ kind: 'unset_on_submit', unsetCount: 4 });
		expect(harness.order).toEqual(['begin', 'lock', 'read-log', 'rollback']);
		expect(harness.appendedEvents).toEqual([]);
	});

	it('refuses a second submission from a Team already final', async () => {
		const harness = fakeGateway([submittedRow()]);

		const outcome = await submitAssignmentsFinal(harness.gateway, ACTOR, DEVICE_CLASS);

		expect(outcome.kind).toBe('rejected');
		expect((outcome as { reason?: ContractAssignmentRejection }).reason?.refusal.kind).toBe(
			'already_final'
		);
	});

	it('submits a Team that won nothing — it has nothing outstanding', async () => {
		const harness = fakeGateway(fiveWins());

		const outcome = await submitAssignmentsFinal(
			harness.gateway,
			{ managerId: 'm-o', teamId: 't-other', teamName: 'Team Other' },
			DEVICE_CLASS
		);

		expect(outcome.kind).toBe('accepted');
		expect(harness.appendedEvents[0]?.['payload']).toEqual({
			teamId: 't-other',
			teamName: 'Team Other',
			managerId: 'm-o',
			assignedCount: 0
		});
	});

	it('leaves another Team’s submission alone', async () => {
		const harness = fakeGateway([...fiveWins(), submittedRow('t-other')]);

		// Team K is not final because Team Other went final.
		const outcome = await assignContractLength(harness.gateway, ACTOR, 'p-1', 4, DEVICE_CLASS);
		expect(outcome.kind).toBe('accepted');
	});
});
