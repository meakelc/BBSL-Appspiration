/**
 * The Commissioner's assignment monitor view model, driven directly against
 * folded state — no database, no HTTP, no clock (Story 6.2, FR-29).
 *
 * The page's whole content is these sentences and these rows, so what a
 * Commissioner reads is asserted here rather than through a rendered surface.
 * The matrix rows this file owns are the completion roster itself, the
 * deadline-unset sentence, and the interval-unset sentence.
 */

import { describe, expect, it } from 'vitest';

import { closedPayload } from '../fixtures/closed-event.ts';

import {
	ASSIGNMENT_DEADLINE_PASSED_EVENT,
	ASSIGNMENT_DEADLINE_SET_EVENT,
	ASSIGNMENT_REMINDERS_SENT_EVENT,
	ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT,
	INITIAL_ASSIGNMENT_DEADLINE,
	assignmentDeadlineReducer
} from '../../src/lib/core/projection/assignment-deadline.ts';
import {
	ASSIGNMENTS_SUBMITTED_EVENT,
	INITIAL_ASSIGNMENTS,
	assignmentsReducer
} from '../../src/lib/core/projection/assignments.ts';
import {
	CONTRACT_LENGTH_ASSIGNED_EVENT,
	INITIAL_CONTRACTS,
	contractsReducer
} from '../../src/lib/core/projection/contracts.ts';
import type { ContractYears } from '../../src/lib/core/projection/contracts.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { assignmentMonitorFor } from '../../src/lib/core/rules/assignment-monitor.ts';
import type { MonitoredTeamIdentity } from '../../src/lib/core/rules/assignment-monitor.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';

const DEADLINE = '2026-09-10T17:00:00.000Z';
const REMINDER_AT = '2026-09-09T17:00:00.000Z';

const TEAM_A = 't-a';
const TEAM_B = 't-b';
const TEAM_C = 't-c';

/** Deliberately not in name order, so the sort is doing the work. */
const TEAMS: readonly MonitoredTeamIdentity[] = [
	{ teamId: TEAM_C, teamName: 'Wizards', managerNames: [] },
	{ teamId: TEAM_A, teamName: 'Lakers', managerNames: ['Meakel', 'Dana'] },
	{ teamId: TEAM_B, teamName: 'Bulls', managerNames: ['Ari'] }
];

let nextSeq = 0;

function event(type: string, payload: unknown): AppendedEvent {
	nextSeq += 1;
	return {
		seq: String(nextSeq),
		occurredAt: '2026-09-01T09:00:00.000Z',
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: 'm-c',
		teamId: 't-c',
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

function won(playerId: string, teamId: string): AppendedEvent {
	return event(
		AUCTION_CLOSED_EVENT,
		closedPayload({ fantraxPlayerId: playerId, playerName: playerId, teamId, teamName: teamId })
	);
}

function assigned(playerId: string, teamId: string, years: ContractYears): AppendedEvent {
	return event(CONTRACT_LENGTH_ASSIGNED_EVENT, {
		fantraxPlayerId: playerId,
		playerName: playerId,
		teamId,
		teamName: teamId,
		managerId: 'm-x',
		contractYears: years
	});
}

function submitted(teamId: string): AppendedEvent {
	return event(ASSIGNMENTS_SUBMITTED_EVENT, {
		teamId,
		teamName: teamId,
		managerId: 'm-x',
		assignedCount: 0
	});
}

function deadlineSet(deadline: string): AppendedEvent {
	return event(ASSIGNMENT_DEADLINE_SET_EVENT, { deadline, previousDeadline: null });
}

function intervalSet(intervalHours: number): AppendedEvent {
	return event(ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT, { intervalHours });
}

function marker(type: string, deadline: string): AppendedEvent {
	return event(type, { deadline, outstandingTeamIds: [], outstandingPlayerCount: 0, evaluatedAt: deadline });
}

function monitorOf(...events: readonly AppendedEvent[]) {
	return assignmentMonitorFor({
		teams: TEAMS,
		contracts: fold(INITIAL_CONTRACTS, events, contractsReducer),
		submitted: fold(INITIAL_ASSIGNMENTS, events, assignmentsReducer),
		deadline: fold(INITIAL_ASSIGNMENT_DEADLINE, events, assignmentDeadlineReducer)
	});
}

describe('assignmentMonitorFor — every Team, submitted or not, with what it owes', () => {
	it('lists EVERY Team, in name order, including one that won nothing', () => {
		const monitor = monitorOf(won('p-1', TEAM_A));
		expect(monitor.rows.map((row) => row.teamName)).toEqual(['Bulls', 'Lakers', 'Wizards']);
		expect(monitor.teamCount).toBe(3);
	});

	it('names each Team through the one formatter, Managers and all', () => {
		const monitor = monitorOf();
		expect(monitor.rows.map((row) => row.teamLabel)).toEqual([
			'Bulls — Ari',
			'Lakers — Meakel & Dana',
			// No Manager bound is the Team name alone, never a stray dash.
			'Wizards'
		]);
	});

	it('counts each Team’s unset Players and states the status in words', () => {
		const monitor = monitorOf(won('p-1', TEAM_A), won('p-2', TEAM_A), won('p-3', TEAM_B));
		const lakers = monitor.rows.find((row) => row.teamId === TEAM_A)!;
		expect(lakers.unsetCount).toBe(2);
		expect(lakers.submitted).toBe(false);
		expect(lakers.statusLabel).toBe('Not submitted');
		expect(lakers.detail).toContain('2 won Players');
		expect(monitor.outstandingCount).toBe(2);
		expect(monitor.outstandingPlayerCount).toBe(3);
	});

	it('reports a submitted Team as submitted, with nothing outstanding', () => {
		const monitor = monitorOf(won('p-1', TEAM_A), assigned('p-1', TEAM_A, 2), submitted(TEAM_A));
		const lakers = monitor.rows.find((row) => row.teamId === TEAM_A)!;
		expect(lakers.submitted).toBe(true);
		expect(lakers.statusLabel).toBe('Submitted');
		expect(lakers.unsetCount).toBe(0);
		expect(monitor.submittedCount).toBe(1);
		expect(monitor.outstandingPlayerCount).toBe(0);
	});

	it('counts a Team that won nothing as done once it submits — it owes nothing', () => {
		const monitor = monitorOf(submitted(TEAM_C));
		expect(monitor.submittedCount).toBe(1);
		expect(monitor.completionSentence).toContain('1 of 3 Teams');
	});

	it('states the completion figures in one sentence, with no exclamation mark', () => {
		const monitor = monitorOf(won('p-1', TEAM_A));
		expect(monitor.completionSentence).toBe(
			'0 of 3 Teams have submitted contract assignments as final. 1 won Player across the ' +
				'league still carries no contract length.'
		);
		expect(monitor.completionSentence).not.toContain('!');
	});
});

describe('the deadline sentences — what the page says about the instants', () => {
	it('says the deadline is UNSET, and that nothing can fire until it is', () => {
		const monitor = monitorOf();
		expect(monitor.deadline).toBeNull();
		expect(monitor.deadlineSentence).toContain('not set');
		expect(monitor.noticeSentence).toContain('No deadline notice is sent');
	});

	it('names the standing deadline and states that it may only move later', () => {
		const monitor = monitorOf(deadlineSet(DEADLINE));
		expect(monitor.deadline).toBe(DEADLINE);
		expect(monitor.deadlineSentence).toContain(DEADLINE);
		expect(monitor.deadlineSentence).toContain('only move later');
	});

	it('says no reminder is sent while the interval is unset', () => {
		const monitor = monitorOf(deadlineSet(DEADLINE));
		expect(monitor.reminderIntervalHours).toBeNull();
		expect(monitor.reminderSentence).toContain('No reminder interval is set');
		// The notice does not depend on it — the matrix's "interval unset" row.
		expect(monitor.reminderSentence).toContain('does not depend on it');
	});

	it('states the reminder instant once both halves exist', () => {
		const monitor = monitorOf(deadlineSet(DEADLINE), intervalSet(24));
		expect(monitor.reminderSentence).toContain(REMINDER_AT);
		expect(monitor.reminderSentence).toContain('24 hours');
	});

	it('states an interval set before any deadline without inventing an instant', () => {
		const monitor = monitorOf(intervalSet(24));
		expect(monitor.reminderSentence).toContain('No reminder is sent until a deadline is set.');
	});

	it('reports the reminder as sent once its marker matches the standing deadline', () => {
		const monitor = monitorOf(
			deadlineSet(DEADLINE),
			intervalSet(24),
			marker(ASSIGNMENT_REMINDERS_SENT_EVENT, DEADLINE)
		);
		expect(monitor.reminderSentence).toContain('was sent');
	});

	it('reports the reminder as PENDING again after an extension', () => {
		const later = '2026-09-12T17:00:00.000Z';
		const monitor = monitorOf(
			deadlineSet(DEADLINE),
			intervalSet(24),
			marker(ASSIGNMENT_REMINDERS_SENT_EVENT, DEADLINE),
			deadlineSet(later)
		);
		expect(monitor.reminderSentence).toContain('One reminder is sent at');
		expect(monitor.noticeSent).toBe(false);
	});

	it('reports the notice as sent, and says it wrote no contract length', () => {
		const monitor = monitorOf(deadlineSet(DEADLINE), marker(ASSIGNMENT_DEADLINE_PASSED_EVENT, DEADLINE));
		expect(monitor.noticeSent).toBe(true);
		expect(monitor.noticeSentence).toContain('No contract length was written');
		expect(monitor.noticeSentence).toContain('no phase changed');
	});
});
