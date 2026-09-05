/**
 * The assignment deadline's fold, its refusals and its tick decision, driven
 * directly against a folded log — no database, no HTTP, no clock mocking
 * (Story 6.2, FR-29).
 *
 * Every row of the spec's I/O & Edge-Case Matrix that is a RULE rather than a
 * transport concern is asserted here: the first set, the extension, the
 * shorten-or-repeat refusal, the past refusal, the reminder firing once, the
 * marker suppressing a second send, the interval-unset case, the deadline
 * passing, and the every-Team-submitted case. The two that are not — the
 * unconfirmed post and the wrong phase — are the route's, and live in
 * `tests/routes/assignment-monitoring.test.ts`; their sentences are still this
 * module's and are asserted below.
 *
 * `now` is a string argument, as it is everywhere in this core.
 */

import { describe, expect, it } from 'vitest';

import { closedPayload } from '../fixtures/closed-event.ts';

import {
	ASSIGNMENT_DEADLINE_PASSED_EVENT,
	ASSIGNMENT_DEADLINE_SET_EVENT,
	ASSIGNMENT_REMINDERS_SENT_EVENT,
	ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT,
	INITIAL_ASSIGNMENT_DEADLINE,
	assignmentDeadlineReducer,
	readAssignmentMarker
} from '../../src/lib/core/projection/assignment-deadline.ts';
import type { AssignmentMarkerPayload } from '../../src/lib/core/projection/assignment-deadline.ts';
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
import {
	DEADLINE_EXAMPLE,
	MAX_REMINDER_INTERVAL_HOURS,
	assignmentDeadlineRefusalDetail,
	deadlineSetEvent,
	decideAssignmentDeadlineTick,
	normaliseDeadline,
	outstandingAssignmentTeams,
	refuseDeadline,
	refuseReminderInterval,
	reminderInstantFor,
	reminderIntervalSetEvent
} from '../../src/lib/core/rules/assignment-deadline.ts';
import type {
	AssignmentDeadlineTickState,
	DeadlineActor
} from '../../src/lib/core/rules/assignment-deadline.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';

const TEAM = 't-k';
const OTHER_TEAM = 't-other';

const ACTOR: DeadlineActor = { managerId: 'm-c', teamId: 't-c', teamName: 'Commissioner Team' };

/** The deadline every test works against, and the instants around it. */
const DEADLINE = '2026-09-10T17:00:00.000Z';
/** 24 hours before it — the reminder instant for a 24-hour interval. */
const REMINDER_AT = '2026-09-09T17:00:00.000Z';
const BEFORE_REMINDER = '2026-09-09T16:59:59.999Z';
const AFTER_DEADLINE = '2026-09-10T17:00:00.001Z';
const EARLY = '2026-09-01T09:00:00.000Z';

let nextSeq = 0;

function event(type: string, payload: unknown): AppendedEvent {
	nextSeq += 1;
	return {
		seq: String(nextSeq),
		occurredAt: EARLY,
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

function deadlineSet(deadline: string): AppendedEvent {
	return event(ASSIGNMENT_DEADLINE_SET_EVENT, {
		deadline,
		previousDeadline: null,
		managerId: 'm-c',
		teamId: 't-c',
		teamName: 'Commissioner Team',
		setAt: EARLY
	});
}

function intervalSet(intervalHours: number): AppendedEvent {
	return event(ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT, {
		intervalHours,
		previousIntervalHours: null,
		managerId: 'm-c',
		teamId: 't-c',
		teamName: 'Commissioner Team'
	});
}

function marker(type: string, deadline: string, outstandingTeamIds: readonly string[] = []): AppendedEvent {
	const payload: AssignmentMarkerPayload = {
		deadline,
		outstandingTeamIds,
		outstandingPlayerCount: outstandingTeamIds.length,
		evaluatedAt: DEADLINE
	};
	return event(type, payload);
}

/** A close that awards `playerId` to `teamId`, with no length assigned. */
function won(playerId: string, teamId: string = TEAM): AppendedEvent {
	return event(
		AUCTION_CLOSED_EVENT,
		closedPayload({
			fantraxPlayerId: playerId,
			playerName: playerId,
			teamId,
			teamName: teamId === TEAM ? 'Team K' : 'Team Other'
		})
	);
}

function assigned(playerId: string, years: ContractYears, teamId: string = TEAM): AppendedEvent {
	return event(CONTRACT_LENGTH_ASSIGNED_EVENT, {
		fantraxPlayerId: playerId,
		playerName: playerId,
		teamId,
		teamName: teamId === TEAM ? 'Team K' : 'Team Other',
		managerId: 'm-k',
		contractYears: years
	});
}

function submitted(teamId: string = TEAM): AppendedEvent {
	return event(ASSIGNMENTS_SUBMITTED_EVENT, {
		teamId,
		teamName: teamId === TEAM ? 'Team K' : 'Team Other',
		managerId: 'm-k',
		assignedCount: 0
	});
}

function stateOf(...events: readonly AppendedEvent[]): AssignmentDeadlineTickState {
	return {
		deadline: fold(INITIAL_ASSIGNMENT_DEADLINE, events, assignmentDeadlineReducer),
		contracts: fold(INITIAL_CONTRACTS, events, contractsReducer),
		submitted: fold(INITIAL_ASSIGNMENTS, events, assignmentsReducer)
	};
}

// --- The fold ---------------------------------------------------------------

describe('assignmentDeadlineReducer — the deadline IS the fold', () => {
	it('has no deadline, no interval and neither marker with an empty log', () => {
		expect(fold(INITIAL_ASSIGNMENT_DEADLINE, [], assignmentDeadlineReducer)).toEqual({
			deadline: null,
			reminderIntervalHours: null,
			remindedFor: null,
			passedFor: null
		});
	});

	it('folds a set to the deadline it names', () => {
		expect(stateOf(deadlineSet(DEADLINE)).deadline.deadline).toBe(DEADLINE);
	});

	it('folds the LATER of two sets, because the log order decides', () => {
		const later = '2026-09-12T17:00:00.000Z';
		expect(stateOf(deadlineSet(DEADLINE), deadlineSet(later)).deadline.deadline).toBe(later);
	});

	it('folds an EARLIER set too — the log order decides, not the instants', () => {
		// The gate refuses a non-later instant, so this log cannot arise from the
		// commands. The reducer must still be total over it and must not invent a
		// monotonic rule of its own: the answer is the last set, whichever way it
		// moved.
		const earlier = '2026-09-08T17:00:00.000Z';
		expect(stateOf(deadlineSet(DEADLINE), deadlineSet(earlier)).deadline.deadline).toBe(earlier);
	});

	it('rejects a set naming an instant nothing downstream can parse', () => {
		// A folded-but-unreadable deadline would never fire and could not be
		// compared against an extension, so the standing one survives instead.
		const state = stateOf(deadlineSet(DEADLINE), deadlineSet('the tenth of September'));
		expect(state.deadline.deadline).toBe(DEADLINE);
	});

	it('carries the markers through an extension UNCHANGED, so they stop matching', () => {
		const later = '2026-09-12T17:00:00.000Z';
		const state = stateOf(
			deadlineSet(DEADLINE),
			marker(ASSIGNMENT_REMINDERS_SENT_EVENT, DEADLINE),
			marker(ASSIGNMENT_DEADLINE_PASSED_EVENT, DEADLINE),
			deadlineSet(later)
		);
		expect(state.deadline.deadline).toBe(later);
		// The markers still name the OLD instant, which is exactly what re-arms
		// both without anything having to reset them.
		expect(state.deadline.remindedFor).toBe(DEADLINE);
		expect(state.deadline.passedFor).toBe(DEADLINE);
	});

	it('folds the interval and skips one that is not a whole positive number', () => {
		expect(stateOf(intervalSet(24)).deadline.reminderIntervalHours).toBe(24);
		expect(stateOf(intervalSet(2.5)).deadline.reminderIntervalHours).toBeNull();
		expect(stateOf(intervalSet(0)).deadline.reminderIntervalHours).toBeNull();
	});

	it('skips a set that names no instant rather than clearing the deadline', () => {
		const blank = event(ASSIGNMENT_DEADLINE_SET_EVENT, { deadline: '' });
		expect(stateOf(deadlineSet(DEADLINE), blank).deadline.deadline).toBe(DEADLINE);
	});

	it('ignores an event type it has not been taught', () => {
		expect(stateOf(deadlineSet(DEADLINE), submitted()).deadline.deadline).toBe(DEADLINE);
	});

	it('converges when the same log is folded twice (AD-5)', () => {
		const log = [deadlineSet(DEADLINE), intervalSet(24), marker(ASSIGNMENT_REMINDERS_SENT_EVENT, DEADLINE)];
		expect(stateOf(...log)).toEqual(stateOf(...log));
	});
});

describe('readAssignmentMarker — defensive, and total', () => {
	it('reads the pair off a well-formed marker', () => {
		expect(readAssignmentMarker({ deadline: DEADLINE, outstandingTeamIds: [TEAM] })).toEqual({
			deadline: DEADLINE,
			outstandingTeamIds: [TEAM]
		});
	});

	it('answers null for a payload that is not one', () => {
		expect(readAssignmentMarker(null)).toBeNull();
		expect(readAssignmentMarker({})).toBeNull();
		expect(readAssignmentMarker({ deadline: '' })).toBeNull();
	});

	it('treats an absent or malformed team list as empty rather than as a rejection', () => {
		expect(readAssignmentMarker({ deadline: DEADLINE })?.outstandingTeamIds).toEqual([]);
		expect(
			readAssignmentMarker({ deadline: DEADLINE, outstandingTeamIds: [1, '', TEAM] })
				?.outstandingTeamIds
		).toEqual([TEAM]);
	});

	it('deduplicates the team list, because it becomes mention addressees', () => {
		// `enqueueMentions` resolves each id to that Team's Managers, so a
		// repeated id would file one Manager's intent twice for one event.
		expect(
			readAssignmentMarker({ deadline: DEADLINE, outstandingTeamIds: [TEAM, TEAM] })
				?.outstandingTeamIds
		).toEqual([TEAM]);
	});
});

// --- Setting and extending ---------------------------------------------------

describe('refuseDeadline — the matrix rows for setting one', () => {
	it('accepts the first deadline, in the future, with none standing', () => {
		expect(refuseDeadline(stateOf().deadline, DEADLINE, EARLY)).toBeNull();
	});

	it('accepts a LATER instant — the extension path, and the only one', () => {
		const state = stateOf(deadlineSet(DEADLINE)).deadline;
		expect(refuseDeadline(state, '2026-09-12T17:00:00.000Z', EARLY)).toBeNull();
	});

	it('refuses an EARLIER instant, naming the standing deadline', () => {
		const state = stateOf(deadlineSet(DEADLINE)).deadline;
		const refusal = refuseDeadline(state, '2026-09-09T17:00:00.000Z', EARLY);
		expect(refusal).toEqual({ kind: 'not_later', standing: DEADLINE });
		expect(assignmentDeadlineRefusalDetail(refusal!)).toContain(DEADLINE);
	});

	it('refuses a REPEAT of the standing deadline', () => {
		const state = stateOf(deadlineSet(DEADLINE)).deadline;
		expect(refuseDeadline(state, DEADLINE, EARLY)).toEqual({ kind: 'not_later', standing: DEADLINE });
	});

	it('refuses an instant at or before now, before it ever reaches the standing check', () => {
		expect(refuseDeadline(stateOf().deadline, DEADLINE, DEADLINE)).toEqual({
			kind: 'deadline_in_past',
			now: DEADLINE
		});
		expect(refuseDeadline(stateOf().deadline, DEADLINE, AFTER_DEADLINE)).toEqual({
			kind: 'deadline_in_past',
			now: AFTER_DEADLINE
		});
	});

	it('refuses an instant it cannot read at all, before anything is compared', () => {
		expect(refuseDeadline(stateOf().deadline, 'next Tuesday', EARLY)).toEqual({
			kind: 'unparseable_deadline'
		});
		// A local wall-clock value, which is what `datetime-local` would post.
		expect(refuseDeadline(stateOf().deadline, '2026-09-10T17:00', EARLY)).toEqual({
			kind: 'unparseable_deadline'
		});
		// A non-UTC offset is not silently treated as `Z`.
		expect(refuseDeadline(stateOf().deadline, '2026-09-10T17:00:00+05:00', EARLY)).toEqual({
			kind: 'unparseable_deadline'
		});
	});

	it('normalises the accepted spelling to the one the log carries', () => {
		expect(normaliseDeadline('  2026-09-10T17:00:00Z  ')).toBe(DEADLINE);
		expect(normaliseDeadline(DEADLINE_EXAMPLE)).toBe(DEADLINE);
	});
});

describe('refuseReminderInterval — a whole number of hours, in range', () => {
	it('accepts the bounds and everything between them', () => {
		expect(refuseReminderInterval(1)).toBeNull();
		expect(refuseReminderInterval(24)).toBeNull();
		expect(refuseReminderInterval(MAX_REMINDER_INTERVAL_HOURS)).toBeNull();
	});

	it('refuses zero, a negative, a fraction, NaN and anything past the ceiling', () => {
		for (const bad of [0, -1, 2.5, Number.NaN, MAX_REMINDER_INTERVAL_HOURS + 1]) {
			expect(refuseReminderInterval(bad)).toEqual({ kind: 'invalid_interval' });
		}
	});
});

describe('the appended events — the actor rides the envelope', () => {
	it('names the acting Manager and Team on a set, and records what it moved from', () => {
		const state = stateOf(deadlineSet(DEADLINE)).deadline;
		const later = '2026-09-12T17:00:00.000Z';
		const appended = deadlineSetEvent(state, ACTOR, later, EARLY, 'mobile');
		expect(appended.type).toBe(ASSIGNMENT_DEADLINE_SET_EVENT);
		expect(appended.managerId).toBe('m-c');
		expect(appended.teamId).toBe('t-c');
		expect(appended.payload).toEqual({
			deadline: later,
			previousDeadline: DEADLINE,
			managerId: 'm-c',
			teamId: 't-c',
			teamName: 'Commissioner Team',
			setAt: EARLY
		});
	});

	it('carries the NORMALISED instant, never the submitted text', () => {
		const appended = deadlineSetEvent(stateOf().deadline, ACTOR, '2026-09-10T17:00:00Z', EARLY, 'desktop');
		expect((appended.payload as { deadline: string }).deadline).toBe(DEADLINE);
	});

	it('names the acting Manager and Team on an interval too', () => {
		const appended = reminderIntervalSetEvent(stateOf(intervalSet(12)).deadline, ACTOR, 24, 'desktop');
		expect(appended.type).toBe(ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT);
		expect(appended.managerId).toBe('m-c');
		expect(appended.payload).toMatchObject({ intervalHours: 24, previousIntervalHours: 12 });
	});
});

// --- Who is outstanding -------------------------------------------------------

describe('outstandingAssignmentTeams — derived from the contracts fold alone', () => {
	it('is empty with no contracts at all', () => {
		expect(outstandingAssignmentTeams(stateOf().contracts)).toEqual([]);
	});

	it('counts each Team’s unset Players, sorted by Team id', () => {
		const state = stateOf(won('p-1'), won('p-2'), won('p-3', OTHER_TEAM));
		expect(outstandingAssignmentTeams(state.contracts)).toEqual([
			{ teamId: TEAM, teamName: 'Team K', unsetCount: 2 },
			{ teamId: OTHER_TEAM, teamName: 'Team Other', unsetCount: 1 }
		]);
	});

	it('drops a Team the moment its last Player carries a length', () => {
		const state = stateOf(won('p-1'), assigned('p-1', 2));
		expect(outstandingAssignmentTeams(state.contracts)).toEqual([]);
	});

	it('never lists a Team that won nothing, however many exist', () => {
		const state = stateOf(won('p-1', OTHER_TEAM));
		expect(outstandingAssignmentTeams(state.contracts).map((t) => t.teamId)).toEqual([OTHER_TEAM]);
	});
});

describe('reminderInstantFor — one derivation of the reminder instant', () => {
	it('subtracts the interval from the deadline', () => {
		expect(reminderInstantFor(DEADLINE, 24)).toBe(REMINDER_AT);
	});

	it('is null when either half is absent or the deadline is unreadable', () => {
		expect(reminderInstantFor(null, 24)).toBeNull();
		expect(reminderInstantFor(DEADLINE, null)).toBeNull();
		expect(reminderInstantFor('whenever', 24)).toBeNull();
	});
});

// --- The tick decision ---------------------------------------------------------

describe('decideAssignmentDeadlineTick — the matrix rows the tick owns', () => {
	it('does nothing at all while no deadline is set, whatever the interval', () => {
		expect(decideAssignmentDeadlineTick(stateOf(intervalSet(24), won('p-1')), AFTER_DEADLINE)).toBeNull();
	});

	it('does nothing before the reminder is due', () => {
		const state = stateOf(deadlineSet(DEADLINE), intervalSet(24), won('p-1'));
		expect(decideAssignmentDeadlineTick(state, BEFORE_REMINDER)).toBeNull();
	});

	it('appends ONE AssignmentRemindersSent at the reminder instant, naming the unset Teams', () => {
		const state = stateOf(deadlineSet(DEADLINE), intervalSet(24), won('p-1'), won('p-2', OTHER_TEAM));
		const decision = decideAssignmentDeadlineTick(state, REMINDER_AT);
		expect(decision).not.toBeNull();
		expect(decision!.events).toHaveLength(1);
		const [reminder] = decision!.events;
		expect(reminder!.type).toBe(ASSIGNMENT_REMINDERS_SENT_EVENT);
		// **Null, and null together** — nobody acted, a tick compared a clock.
		expect(reminder!.managerId).toBeNull();
		expect(reminder!.teamId).toBeNull();
		expect(reminder!.payload).toEqual({
			deadline: DEADLINE,
			outstandingTeamIds: [TEAM, OTHER_TEAM],
			outstandingPlayerCount: 2,
			evaluatedAt: REMINDER_AT
		});
	});

	it('appends NOTHING once the marker matches this deadline — the tick is idempotent', () => {
		const state = stateOf(
			deadlineSet(DEADLINE),
			intervalSet(24),
			won('p-1'),
			marker(ASSIGNMENT_REMINDERS_SENT_EVENT, DEADLINE)
		);
		expect(decideAssignmentDeadlineTick(state, REMINDER_AT)).toBeNull();
	});

	it('re-arms the reminder when the deadline is EXTENDED, because it is a different instant', () => {
		const later = '2026-09-12T17:00:00.000Z';
		const state = stateOf(
			deadlineSet(DEADLINE),
			intervalSet(24),
			won('p-1'),
			marker(ASSIGNMENT_REMINDERS_SENT_EVENT, DEADLINE),
			deadlineSet(later)
		);
		const decision = decideAssignmentDeadlineTick(state, '2026-09-11T17:00:00.000Z');
		expect(decision!.events.map((e) => e.type)).toEqual([ASSIGNMENT_REMINDERS_SENT_EVENT]);
		expect((decision!.events[0]!.payload as { deadline: string }).deadline).toBe(later);
	});

	it('does not remind a Team that has since assigned every length', () => {
		const later = '2026-09-12T17:00:00.000Z';
		const state = stateOf(
			deadlineSet(DEADLINE),
			intervalSet(24),
			won('p-1'),
			won('p-2', OTHER_TEAM),
			marker(ASSIGNMENT_REMINDERS_SENT_EVENT, DEADLINE),
			deadlineSet(later),
			assigned('p-1', 3)
		);
		const decision = decideAssignmentDeadlineTick(state, '2026-09-11T17:00:00.000Z');
		expect((decision!.events[0]!.payload as { outstandingTeamIds: string[] }).outstandingTeamIds).toEqual([
			OTHER_TEAM
		]);
	});

	it('sends NO reminder ever when no interval is set — and the notice still fires', () => {
		const state = stateOf(deadlineSet(DEADLINE), won('p-1'));
		expect(decideAssignmentDeadlineTick(state, REMINDER_AT)).toBeNull();
		const decision = decideAssignmentDeadlineTick(state, AFTER_DEADLINE);
		expect(decision!.events.map((e) => e.type)).toEqual([ASSIGNMENT_DEADLINE_PASSED_EVENT]);
	});

	it('appends AssignmentDeadlinePassed at the deadline, naming the still-unset Teams', () => {
		const state = stateOf(
			deadlineSet(DEADLINE),
			intervalSet(24),
			won('p-1'),
			marker(ASSIGNMENT_REMINDERS_SENT_EVENT, DEADLINE)
		);
		const decision = decideAssignmentDeadlineTick(state, DEADLINE);
		expect(decision!.events).toHaveLength(1);
		expect(decision!.events[0]!.type).toBe(ASSIGNMENT_DEADLINE_PASSED_EVENT);
		expect(decision!.events[0]!.payload).toEqual({
			deadline: DEADLINE,
			outstandingTeamIds: [TEAM],
			outstandingPlayerCount: 1,
			evaluatedAt: DEADLINE
		});
	});

	it('appends the marker with NO Teams when every Team has submitted', () => {
		const state = stateOf(deadlineSet(DEADLINE), won('p-1'), assigned('p-1', 1), submitted());
		const decision = decideAssignmentDeadlineTick(state, AFTER_DEADLINE);
		expect(decision!.events[0]!.payload).toMatchObject({
			outstandingTeamIds: [],
			outstandingPlayerCount: 0
		});
	});

	it('appends NOTHING once the passed marker matches this deadline', () => {
		const state = stateOf(
			deadlineSet(DEADLINE),
			won('p-1'),
			marker(ASSIGNMENT_DEADLINE_PASSED_EVENT, DEADLINE)
		);
		expect(decideAssignmentDeadlineTick(state, AFTER_DEADLINE)).toBeNull();
	});

	it('appends BOTH, reminder first, for a tick that was down across the window', () => {
		const state = stateOf(deadlineSet(DEADLINE), intervalSet(24), won('p-1'));
		const decision = decideAssignmentDeadlineTick(state, AFTER_DEADLINE);
		expect(decision!.events.map((e) => e.type)).toEqual([
			ASSIGNMENT_REMINDERS_SENT_EVENT,
			ASSIGNMENT_DEADLINE_PASSED_EVENT
		]);
	});

	it('re-arms BOTH markers on an extension', () => {
		const later = '2026-09-12T17:00:00.000Z';
		const state = stateOf(
			deadlineSet(DEADLINE),
			intervalSet(24),
			won('p-1'),
			marker(ASSIGNMENT_REMINDERS_SENT_EVENT, DEADLINE),
			marker(ASSIGNMENT_DEADLINE_PASSED_EVENT, DEADLINE),
			deadlineSet(later)
		);
		const decision = decideAssignmentDeadlineTick(state, '2026-09-13T00:00:00.000Z');
		expect(decision!.events.map((e) => e.type)).toEqual([
			ASSIGNMENT_REMINDERS_SENT_EVENT,
			ASSIGNMENT_DEADLINE_PASSED_EVENT
		]);
	});

	it('writes NO contract length on any decision it can reach', () => {
		const state = stateOf(deadlineSet(DEADLINE), intervalSet(24), won('p-1'), won('p-2', OTHER_TEAM));
		for (const now of [REMINDER_AT, DEADLINE, AFTER_DEADLINE]) {
			const decision = decideAssignmentDeadlineTick(state, now);
			for (const appended of decision?.events ?? []) {
				expect(appended.type).not.toBe(CONTRACT_LENGTH_ASSIGNED_EVENT);
				expect(JSON.stringify(appended.payload)).not.toContain('contractYears');
			}
		}
		// And the contracts fold, re-derived over the decision's own events, is
		// unchanged: no Player gained a length.
		const decision = decideAssignmentDeadlineTick(state, AFTER_DEADLINE);
		const after = fold(
			state.contracts,
			(decision?.events ?? []).map((envelope) => event(envelope.type, envelope.payload)),
			contractsReducer
		);
		expect(after).toEqual(state.contracts);
	});
});

describe('the refusal sentences — one wording, and no exclamation mark', () => {
	it('states a sentence for every kind, each ending in "Nothing was written."', () => {
		const kinds = [
			{ kind: 'unbound_actor' },
			{ kind: 'unconfirmed' },
			{ kind: 'unparseable_deadline' },
			{ kind: 'deadline_in_past', now: EARLY },
			{ kind: 'not_later', standing: DEADLINE },
			{ kind: 'invalid_interval' },
			{ kind: 'unrecorded' }
		] as const;
		for (const refusal of kinds) {
			const sentence = assignmentDeadlineRefusalDetail(refusal);
			expect(sentence).not.toContain('!');
			expect(sentence.trim().endsWith('Nothing was written.')).toBe(true);
		}
	});
});
