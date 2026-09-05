/**
 * The deadline transactions: the two Commissioner commands, the tick step, and
 * the monitoring read. Server-only (Story 6.2, FR-29).
 *
 * **This file exists because the sweep test stubs `assignmentDeadline`.** The
 * sweep owns WHEN the evaluation runs and what a failure of it means for the
 * pass; `evaluateAssignmentDeadline` owns what evaluating the deadline IS.
 * Driving the real transaction is the only way to prove the events that were
 * actually appended, the outbox intents that were actually filed, and that the
 * marker and its enqueue happened inside ONE committed transaction.
 *
 * The stateful fake `ConnectionGateway` is `tests/server/phase-end.test.ts`'s:
 * it records every statement in order and keeps the appended events in memory,
 * so "the reminder came first", "the intents were filed in the same
 * transaction" and "everything rolled back on a throw" are observable rather
 * than assumed. It throws on any statement it does not recognise, which is
 * what makes "no contract length was written and no table was touched"
 * provable rather than merely unasserted.
 */

import { describe, expect, it } from 'vitest';

import { closedPayload } from '../fixtures/closed-event.ts';

import {
	ASSIGNMENT_DEADLINE_PASSED_EVENT,
	ASSIGNMENT_DEADLINE_SET_EVENT,
	ASSIGNMENT_REMINDERS_SENT_EVENT,
	ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT
} from '../../src/lib/core/projection/assignment-deadline.ts';
import { ASSIGNMENTS_SUBMITTED_EVENT } from '../../src/lib/core/projection/assignments.ts';
import { CONTRACT_LENGTH_ASSIGNED_EVENT } from '../../src/lib/core/projection/contracts.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { assignmentDeadlineRefusalDetail } from '../../src/lib/core/rules/assignment-deadline.ts';
import type { DeadlineActor } from '../../src/lib/core/rules/assignment-deadline.ts';
import {
	evaluateAssignmentDeadline,
	loadAssignmentMonitor,
	setAssignmentDeadline,
	setReminderInterval
} from '../../src/lib/server/assignment-deadline.ts';
import type { AssignmentDeadlineRejection } from '../../src/lib/server/assignment-deadline.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

const ACTOR: DeadlineActor = { managerId: 'm-c', teamId: 't-c', teamName: 'Commissioner Team' };

const TEAM = 't-k';
const OTHER_TEAM = 't-other';

const DEADLINE = '2026-09-10T17:00:00.000Z';
const LATER = '2026-09-12T17:00:00.000Z';
const REMINDER_AT = '2026-09-09T17:00:00.000Z';

/** The database's transaction-start clock, well before the deadline. */
const EARLY = new Date('2026-09-01T09:00:00.000Z');
/** At the reminder instant, and past the deadline. */
const AT_REMINDER = new Date(REMINDER_AT);
const PAST_DEADLINE = new Date('2026-09-10T17:00:01.000Z');

function fakeGateway(options: { events?: QueryResultRow[]; now?: Date } = {}) {
	const order: string[] = [];
	const appendedEvents: QueryResultRow[] = [];
	const outboxIntents: Array<{ eventSeq: string; recipient: string }> = [];
	let seq = 100;
	let released = 0;
	let committed = false;
	let rolledBack = false;

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, queryParams: readonly unknown[] = []) {
			const sql = text.trim();
			if (/^begin/i.test(sql)) {
				order.push('begin');
				return { rows: [] };
			}
			if (/pg_advisory_xact_lock/i.test(sql)) {
				order.push('lock');
				return { rows: [{ locked: true, now: options.now ?? EARLY }] };
			}
			if (/^select \* from auction_events/i.test(sql)) {
				order.push('read-log');
				return { rows: [...(options.events ?? []), ...appendedEvents] };
			}
			if (/^insert into auction_events/i.test(sql)) {
				order.push('append-event');
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
			if (/^select t\.id::text as id/i.test(sql)) {
				order.push('read-teams');
				return {
					rows: [
						{ id: TEAM, team_name: 'Team K', display_name: 'Kay' },
						{ id: OTHER_TEAM, team_name: 'Team Other', display_name: 'Ollie' }
					]
				};
			}
			if (/^select discord_user_id\s+from managers\s+where team_id = \$1/i.test(sql)) {
				order.push('resolve-managers');
				return { rows: [{ discord_user_id: `discord-${String(queryParams[0])}` }] };
			}
			if (/^select discord_user_id\s+from managers\s+where team_id is not null/i.test(sql)) {
				order.push('resolve-every-manager');
				return { rows: [{ discord_user_id: 'discord-every' }] };
			}
			if (/^insert into notification_outbox/i.test(sql)) {
				order.push('enqueue');
				outboxIntents.push({
					eventSeq: String(queryParams[0]),
					recipient: String(queryParams[2])
				});
				return { rows: [] };
			}
			if (/^commit/i.test(sql)) {
				order.push('commit');
				committed = true;
				return { rows: [] };
			}
			if (/^rollback/i.test(sql)) {
				order.push('rollback');
				rolledBack = true;
				appendedEvents.length = 0;
				outboxIntents.length = 0;
				return { rows: [] };
			}
			throw new Error(`unexpected statement: ${sql}`);
		},
		release() {
			released += 1;
		}
	};

	return {
		gateway: { connect: async () => client } satisfies ConnectionGateway,
		order,
		appendedEvents,
		outboxIntents,
		state: {
			get released() {
				return released;
			},
			get committed() {
				return committed;
			},
			get rolledBack() {
				return rolledBack;
			}
		}
	};
}

let nextSeq = 0;

function logEvent(type: string, payload: unknown): QueryResultRow {
	nextSeq += 1;
	return {
		seq: nextSeq,
		occurred_at: new Date('2026-09-01T08:00:00.000Z'),
		schema_version: 1,
		core_version: 1,
		manager_id: 'm-c',
		team_id: 't-c',
		event_type: type,
		payload
	};
}

const deadlineSet = (deadline: string) =>
	logEvent(ASSIGNMENT_DEADLINE_SET_EVENT, { deadline, previousDeadline: null });
const intervalSet = (intervalHours: number) =>
	logEvent(ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT, { intervalHours });
const won = (playerId: string, teamId: string) =>
	logEvent(
		AUCTION_CLOSED_EVENT,
		closedPayload({ fantraxPlayerId: playerId, playerName: playerId, teamId, teamName: teamId })
	);
const assigned = (playerId: string, teamId: string) =>
	logEvent(CONTRACT_LENGTH_ASSIGNED_EVENT, {
		fantraxPlayerId: playerId,
		playerName: playerId,
		teamId,
		teamName: teamId,
		managerId: 'm-x',
		contractYears: 2
	});
const submittedFinal = (teamId: string) =>
	logEvent(ASSIGNMENTS_SUBMITTED_EVENT, {
		teamId,
		teamName: teamId,
		managerId: 'm-x',
		assignedCount: 1
	});

// --- setAssignmentDeadline ----------------------------------------------------

describe('setAssignmentDeadline — every gate re-derived inside the transaction', () => {
	it('appends one AssignmentDeadlineSet, naming the acting Manager and Team', async () => {
		const fake = fakeGateway();
		const outcome = await setAssignmentDeadline(fake.gateway, ACTOR, DEADLINE, 'desktop');

		expect(outcome.kind).toBe('accepted');
		expect(fake.appendedEvents).toHaveLength(1);
		expect(fake.appendedEvents[0]!['event_type']).toBe(ASSIGNMENT_DEADLINE_SET_EVENT);
		expect(fake.appendedEvents[0]!['manager_id']).toBe('m-c');
		expect(fake.appendedEvents[0]!['team_id']).toBe('t-c');
		expect(fake.appendedEvents[0]!['device_class']).toBe('desktop');
		expect(fake.state.committed).toBe(true);
	});

	it('takes the lock BEFORE it reads the log (AD-6), and commits once', async () => {
		const fake = fakeGateway();
		await setAssignmentDeadline(fake.gateway, ACTOR, DEADLINE, 'desktop');
		expect(fake.order.indexOf('lock')).toBeLessThan(fake.order.indexOf('read-log'));
		expect(fake.order.filter((step) => step === 'commit')).toHaveLength(1);
	});

	it('accepts a LATER instant against a standing deadline, and records what it moved from', async () => {
		const fake = fakeGateway({ events: [deadlineSet(DEADLINE)] });
		const outcome = await setAssignmentDeadline(fake.gateway, ACTOR, LATER, 'mobile');
		expect(outcome.kind).toBe('accepted');
		expect(fake.appendedEvents[0]!['payload']).toMatchObject({
			deadline: LATER,
			previousDeadline: DEADLINE
		});
	});

	it('refuses an earlier instant with the core’s sentence, writing nothing', async () => {
		const fake = fakeGateway({ events: [deadlineSet(LATER)] });
		const outcome = await setAssignmentDeadline(fake.gateway, ACTOR, DEADLINE, 'mobile');

		expect(outcome.kind).toBe('rejected');
		const rejection = (outcome as { reason: AssignmentDeadlineRejection }).reason;
		expect(rejection.refusal).toEqual({ kind: 'not_later', standing: LATER });
		expect(rejection.detail).toBe(
			assignmentDeadlineRefusalDetail({ kind: 'not_later', standing: LATER })
		);
		expect(fake.appendedEvents).toHaveLength(0);
		expect(fake.state.rolledBack).toBe(true);
	});

	it('refuses an instant at or before the DATABASE clock, never a client one', async () => {
		const fake = fakeGateway({ now: PAST_DEADLINE });
		const outcome = await setAssignmentDeadline(fake.gateway, ACTOR, DEADLINE, 'mobile');
		expect(outcome.kind).toBe('rejected');
		expect((outcome as { reason: AssignmentDeadlineRejection }).reason.refusal).toEqual({
			kind: 'deadline_in_past',
			now: PAST_DEADLINE.toISOString()
		});
	});

	it('files NO outbox intent — a deadline being set is not a notice', async () => {
		const fake = fakeGateway();
		await setAssignmentDeadline(fake.gateway, ACTOR, DEADLINE, 'desktop');
		expect(fake.outboxIntents).toEqual([]);
	});
});

describe('setReminderInterval', () => {
	it('appends one AssignmentReminderIntervalSet', async () => {
		const fake = fakeGateway();
		const outcome = await setReminderInterval(fake.gateway, ACTOR, 24, 'desktop');
		expect(outcome.kind).toBe('accepted');
		expect(fake.appendedEvents[0]!['event_type']).toBe(ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT);
		expect(fake.appendedEvents[0]!['payload']).toMatchObject({ intervalHours: 24 });
	});

	it('refuses an out-of-range interval and writes nothing', async () => {
		const fake = fakeGateway();
		const outcome = await setReminderInterval(fake.gateway, ACTOR, 0, 'desktop');
		expect(outcome.kind).toBe('rejected');
		expect(fake.appendedEvents).toHaveLength(0);
	});

	it('is accepted before any deadline exists — an interval is a duration', async () => {
		const fake = fakeGateway();
		expect((await setReminderInterval(fake.gateway, ACTOR, 24, 'desktop')).kind).toBe('accepted');
	});
});

// --- evaluateAssignmentDeadline -------------------------------------------------

describe('evaluateAssignmentDeadline — the tick step', () => {
	it('appends nothing and commits when no deadline is set', async () => {
		const fake = fakeGateway({ events: [won('p-1', TEAM)], now: PAST_DEADLINE });
		const outcome = await evaluateAssignmentDeadline(fake.gateway);
		expect(outcome).toEqual({ reminded: false, passed: false, deadline: null, outstandingTeamIds: [] });
		expect(fake.appendedEvents).toHaveLength(0);
		expect(fake.state.committed).toBe(true);
	});

	it('appends the reminder and mentions ONLY the Teams with unset Players', async () => {
		const fake = fakeGateway({
			events: [deadlineSet(DEADLINE), intervalSet(24), won('p-1', TEAM), won('p-2', OTHER_TEAM), assigned('p-2', OTHER_TEAM)],
			now: AT_REMINDER
		});
		const outcome = await evaluateAssignmentDeadline(fake.gateway);

		expect(outcome.reminded).toBe(true);
		expect(outcome.passed).toBe(false);
		expect(outcome.outstandingTeamIds).toEqual([TEAM]);
		expect(fake.appendedEvents.map((row) => row['event_type'])).toEqual([
			ASSIGNMENT_REMINDERS_SENT_EVENT
		]);
		// The Team whose Players all carry a length is not addressed.
		expect(fake.outboxIntents.map((intent) => intent.recipient)).toEqual([`discord-${TEAM}`]);
		// A reminder is NOT broadcast: no channel-addressed intent was filed.
		expect(fake.order).not.toContain('resolve-every-manager');
	});

	it('files the intents in the SAME transaction as the marker', async () => {
		const fake = fakeGateway({
			events: [deadlineSet(DEADLINE), intervalSet(24), won('p-1', TEAM)],
			now: AT_REMINDER
		});
		await evaluateAssignmentDeadline(fake.gateway);
		const append = fake.order.indexOf('append-event');
		const enqueue = fake.order.indexOf('enqueue');
		const commit = fake.order.indexOf('commit');
		expect(append).toBeGreaterThan(-1);
		expect(enqueue).toBeGreaterThan(append);
		expect(commit).toBeGreaterThan(enqueue);
	});

	it('appends NOTHING on a second pass — the marker is the idempotency', async () => {
		const events = [deadlineSet(DEADLINE), intervalSet(24), won('p-1', TEAM)];
		const fake = fakeGateway({ events, now: AT_REMINDER });
		const first = await evaluateAssignmentDeadline(fake.gateway);
		expect(first.reminded).toBe(true);
		// The fake's log read returns the seed events PLUS everything appended,
		// exactly as a committed transaction would leave it.
		const second = await evaluateAssignmentDeadline(fake.gateway);
		expect(second.reminded).toBe(false);
		expect(fake.appendedEvents).toHaveLength(1);
		expect(fake.outboxIntents).toHaveLength(1);
	});

	it('appends the notice past the deadline, mentions the unset Teams AND the channel', async () => {
		const fake = fakeGateway({
			events: [deadlineSet(DEADLINE), won('p-1', TEAM)],
			now: PAST_DEADLINE
		});
		const outcome = await evaluateAssignmentDeadline(fake.gateway);

		expect(outcome.passed).toBe(true);
		expect(outcome.deadline).toBe(DEADLINE);
		expect(fake.appendedEvents.map((row) => row['event_type'])).toEqual([
			ASSIGNMENT_DEADLINE_PASSED_EVENT
		]);
		// One channel-addressed broadcast intent plus one Manager mention.
		expect(fake.outboxIntents.map((intent) => intent.recipient).sort()).toEqual(
			['#channel', `discord-${TEAM}`].sort()
		);
	});

	it('still files the league-channel line when every Team has submitted', async () => {
		const fake = fakeGateway({
			events: [deadlineSet(DEADLINE), won('p-1', TEAM), assigned('p-1', TEAM), submittedFinal(TEAM)],
			now: PAST_DEADLINE
		});
		const outcome = await evaluateAssignmentDeadline(fake.gateway);

		expect(outcome.passed).toBe(true);
		expect(outcome.outstandingTeamIds).toEqual([]);
		// The marker stands, the channel hears it, and nobody is mentioned.
		expect(fake.appendedEvents).toHaveLength(1);
		expect(fake.outboxIntents.map((intent) => intent.recipient)).toEqual(['#channel']);
	});

	it('appends BOTH markers for a tick that was down across the reminder window', async () => {
		const fake = fakeGateway({
			events: [deadlineSet(DEADLINE), intervalSet(24), won('p-1', TEAM)],
			now: PAST_DEADLINE
		});
		const outcome = await evaluateAssignmentDeadline(fake.gateway);
		expect(outcome.reminded).toBe(true);
		expect(outcome.passed).toBe(true);
		expect(fake.appendedEvents.map((row) => row['event_type'])).toEqual([
			ASSIGNMENT_REMINDERS_SENT_EVENT,
			ASSIGNMENT_DEADLINE_PASSED_EVENT
		]);
	});

	it('re-arms after an extension and sends again for the NEW instant', async () => {
		const events = [deadlineSet(DEADLINE), won('p-1', TEAM)];
		const fake = fakeGateway({ events, now: PAST_DEADLINE });
		await evaluateAssignmentDeadline(fake.gateway);
		expect(fake.appendedEvents).toHaveLength(1);

		// The Commissioner extends. The fake's mutable log carries it forward.
		events.push(deadlineSet(LATER));
		const later = fakeGateway({
			events: [...events, ...fake.appendedEvents.map(toRow)],
			now: new Date('2026-09-13T00:00:00.000Z')
		});
		const outcome = await evaluateAssignmentDeadline(later.gateway);
		expect(outcome.passed).toBe(true);
		expect(outcome.deadline).toBe(LATER);
	});

	it('writes NO contract length on any path, and touches no table but the outbox', async () => {
		const fake = fakeGateway({
			events: [deadlineSet(DEADLINE), intervalSet(24), won('p-1', TEAM)],
			now: PAST_DEADLINE
		});
		await evaluateAssignmentDeadline(fake.gateway);

		for (const row of fake.appendedEvents) {
			expect(row['event_type']).not.toBe(CONTRACT_LENGTH_ASSIGNED_EVENT);
			expect(JSON.stringify(row['payload'])).not.toContain('contractYears');
		}
		// The fake throws on any statement it does not recognise, so this
		// enumeration IS the proof that nothing else was written.
		expect(new Set(fake.order)).toEqual(
			new Set([
				'begin',
				'lock',
				'read-log',
				'append-event',
				// The per-Team resolution only. `EVERY_TEAM` is never asked for
				// here: neither marker addresses the whole league, so the
				// whole-league query is one the write site cannot reach.
				'resolve-managers',
				'enqueue',
				'commit'
			])
		);
	});
});

/** An appended row, re-shaped as a seed row for a fresh fake. */
function toRow(row: QueryResultRow): QueryResultRow {
	return {
		seq: row['seq'],
		occurred_at: row['occurred_at'],
		schema_version: row['schema_version'],
		core_version: row['core_version'],
		manager_id: row['manager_id'],
		team_id: row['team_id'],
		event_type: row['event_type'],
		payload: row['payload']
	};
}

// --- loadAssignmentMonitor ------------------------------------------------------

describe('loadAssignmentMonitor — the page’s read', () => {
	it('takes no lock, opens no transaction, and releases the connection', async () => {
		const fake = fakeGateway({ events: [won('p-1', TEAM)] });
		await loadAssignmentMonitor(fake.gateway);
		expect(fake.order).not.toContain('lock');
		expect(fake.order).not.toContain('begin');
		expect(fake.state.released).toBe(1);
	});

	it('returns the CORE’s view over every Team the league has', async () => {
		const fake = fakeGateway({
			events: [deadlineSet(DEADLINE), won('p-1', TEAM), won('p-2', TEAM), won('p-3', OTHER_TEAM), assigned('p-3', OTHER_TEAM), submittedFinal(OTHER_TEAM)]
		});
		const monitor = await loadAssignmentMonitor(fake.gateway);

		expect(monitor.teamCount).toBe(2);
		expect(monitor.submittedCount).toBe(1);
		expect(monitor.outstandingPlayerCount).toBe(2);
		expect(monitor.deadline).toBe(DEADLINE);
		expect(monitor.rows.map((row) => row.teamLabel)).toEqual([
			'Team K — Kay',
			'Team Other — Ollie'
		]);
	});
});
