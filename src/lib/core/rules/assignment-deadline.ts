/**
 * The assignment deadline's rules: what the Commissioner may set, and what the
 * tick decides to send (Story 6.2, FR-29).
 *
 * **Two Commissioner acts, one tick decision, and no I/O in any of them.**
 * Every instant compared here is either an argument or a value the log already
 * carries; `now` is injected and reaches this file from the database server
 * clock through the tick or through the transaction, never from a client
 * (AD-3). `decideAssignmentDeadlineTick` is `decidePhaseEnd`'s shape verbatim:
 * a pure function of the folded state and one instant, answering the events to
 * append or `null` for "nothing to do", which is the answer on almost every
 * pass.
 *
 * **A deadline may only ever move later.** FR-29 grants an EXTENSION, not a
 * rescheduling, so a set naming an instant that is not later than the standing
 * one is refused and names the standing deadline. That is the whole of why
 * there is one event type rather than two: the first set and every extension
 * are the same act, and the log reads as a monotonic record of a deadline that
 * only moved outward.
 *
 * **Nothing here writes or implies a contract length.** The deadline passing
 * appends a marker and sends messages. No default, no fallback, no
 * "assign 1-year at the deadline" — a Commissioner assigning on a Team's
 * behalf is Story 7.3 and brings its own event.
 *
 * Voice: state the fact, name the figure it is about, say what would change
 * it. No exclamation mark, no urgency framing, no suggested action.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { formatInstant, parseInstant } from '../instant.ts';
import { hasExpired } from '../projection/auctions.ts';
import {
	ASSIGNMENT_DEADLINE_PASSED_EVENT,
	ASSIGNMENT_DEADLINE_SET_EVENT,
	ASSIGNMENT_REMINDERS_SENT_EVENT,
	ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT
} from '../projection/assignment-deadline.ts';
import type {
	AssignmentDeadlineSetPayload,
	AssignmentDeadlineState,
	AssignmentMarkerPayload,
	AssignmentReminderIntervalSetPayload
} from '../projection/assignment-deadline.ts';
import type { AuctionContracts } from '../projection/contracts.ts';
import type { SubmittedTeams } from '../projection/assignments.ts';
import type { Accepted, EventEnvelope } from '../types.ts';

/**
 * The spelling a deadline is submitted in, as an example a refusal can print.
 *
 * `core/instant.ts`'s `parseInstant` accepts ISO-8601 **UTC** and deliberately
 * nothing else — a non-UTC offset reads back as unparseable rather than being
 * silently treated as `Z` — so the surface asks for the one spelling the log
 * carries and this constant is what tells a Commissioner which it is. It lives
 * here rather than on the page for the reason every other sentence does: the
 * refusal and the field's own instruction must not drift.
 */
export const DEADLINE_EXAMPLE = '2026-09-10T17:00:00Z';

/** Milliseconds in one hour — the only unit conversion this story needs. */
const HOUR_MS = 60 * 60 * 1000;

/**
 * The narrowest and widest reminder interval the league may set, in whole
 * hours.
 *
 * One hour is the floor because the tick runs every ten seconds and a sub-hour
 * interval would be indistinguishable from the deadline itself on a surface
 * that states both. A week is the ceiling because an interval longer than any
 * plausible assignment window would put the reminder before the deadline was
 * even set, and a reminder that fires the instant it is configured is not a
 * reminder.
 */
export const MIN_REMINDER_INTERVAL_HOURS = 1;
export const MAX_REMINDER_INTERVAL_HOURS = 168;

// --- Refusals ---------------------------------------------------------------

/**
 * Every way one of the two Commissioner acts is refused.
 *
 * `ContractAssignmentRefusal`'s shape and its wording split: the union states
 * the FACT and carries what a sentence has to name, and one function below
 * turns each into the one sentence the product says. No route words a refusal
 * of its own.
 *
 * `unconfirmed` is raised by the route rather than by the gate, `/nominate`'s
 * split for its reason: there is nothing about a missing confirmation to
 * decide inside a transaction. Its sentence still comes from here.
 */
export type AssignmentDeadlineRefusal =
	| { readonly kind: 'unbound_actor' }
	| { readonly kind: 'unconfirmed' }
	| { readonly kind: 'unparseable_deadline' }
	| { readonly kind: 'deadline_in_past'; readonly now: string }
	| { readonly kind: 'not_later'; readonly standing: string }
	| { readonly kind: 'invalid_interval' }
	| { readonly kind: 'unrecorded' };

/** The one refusal sentence for each case. */
export function assignmentDeadlineRefusalDetail(refusal: AssignmentDeadlineRefusal): string {
	switch (refusal.kind) {
		case 'unbound_actor':
			return (
				'No deadline was set: you are not bound to a Team, and every event must name ' +
				'one. Ask for your Team to be bound. Nothing was written.'
			);
		case 'unconfirmed':
			return (
				'Nothing was set: the confirmation was not given. A deadline and a reminder ' +
				'interval are both appended events, so neither is inferred from a submit. Tick ' +
				'the confirmation and submit again. Nothing was written.'
			);
		case 'unparseable_deadline':
			return (
				'No deadline was set: the instant submitted could not be read. The log carries ' +
				'UTC and nothing else, so a deadline is written as an ISO-8601 UTC instant — ' +
				`${DEADLINE_EXAMPLE}. Nothing was written.`
			);
		case 'deadline_in_past':
			return (
				`No deadline was set: the instant submitted is at or before ${refusal.now}, which ` +
				'is the database clock this request was checked against. A deadline that has ' +
				'already passed would fire its reminder and its notice on the next tick. ' +
				'Nothing was written.'
			);
		case 'not_later':
			return (
				`No deadline was set: the assignment deadline stands at ${refusal.standing} and a ` +
				'deadline may only move later. Submit a later instant to extend it. Nothing was ' +
				'written.'
			);
		case 'invalid_interval':
			return (
				'No reminder interval was set: the interval submitted is not a whole number of ' +
				`hours from ${String(MIN_REMINDER_INTERVAL_HOURS)} to ` +
				`${String(MAX_REMINDER_INTERVAL_HOURS)}. Nothing was written.`
			);
		case 'unrecorded':
			return 'The write was refused and stated no reason. Nothing was written.';
	}
}

// --- The two Commissioner acts ----------------------------------------------

/** The acting Commissioner, resolved from the session and never a form field. */
export type DeadlineActor = {
	readonly managerId: string;
	readonly teamId: string;
	readonly teamName: string;
};

/**
 * Normalise a submitted instant to the one spelling the log carries, or `null`
 * when it cannot be read.
 *
 * Through `parseInstant`/`formatInstant` — the core's own pair — so a deadline
 * the Commissioner typed with an offset and a deadline the fold compares are
 * the identical string. Nothing else in this file parses a date.
 */
export function normaliseDeadline(raw: string): string | null {
	const ms = parseInstant(raw.trim());
	if (ms === null) return null;
	return formatInstant(ms);
}

/**
 * The gates for setting or extending the deadline, in order: it must be
 * readable, it must be in the future, and it must be later than the standing
 * one. Returns the first refusal, or `null` when every gate holds.
 *
 * Readability first, because the two sentences after it both compare the
 * instant against something and neither can compare a value that is not one.
 * The past check before the monotonic one, because "that date has already
 * gone" is the more useful answer for a request that is both.
 *
 * Exported so the ordering is assertable as pure logic rather than inferred
 * from a transaction. Takes no clock, no database and no random source.
 */
export function refuseDeadline(
	state: AssignmentDeadlineState,
	deadline: string,
	now: string
): AssignmentDeadlineRefusal | null {
	const normalised = normaliseDeadline(deadline);
	if (normalised === null) return { kind: 'unparseable_deadline' };

	// `hasExpired` is the ONE comparison of a persisted absolute instant
	// against an injected `now` in this codebase, and it is not restated here:
	// a deadline at or before `now` has, in exactly its sense, already expired.
	if (hasExpired(normalised, now)) return { kind: 'deadline_in_past', now };

	const standing = state.deadline;
	if (standing !== null) {
		const standingMs = parseInstant(standing);
		const proposedMs = parseInstant(normalised);
		// A standing deadline nobody can read cannot be compared against, and
		// refusing on it would leave the league with a deadline it can never
		// move. `null` there therefore passes: the set stands.
		if (standingMs !== null && proposedMs !== null && proposedMs <= standingMs) {
			return { kind: 'not_later', standing };
		}
	}

	return null;
}

/** The gate for the reminder interval: a whole number of hours, in range. */
export function refuseReminderInterval(hours: number): AssignmentDeadlineRefusal | null {
	if (!Number.isInteger(hours)) return { kind: 'invalid_interval' };
	if (hours < MIN_REMINDER_INTERVAL_HOURS) return { kind: 'invalid_interval' };
	if (hours > MAX_REMINDER_INTERVAL_HOURS) return { kind: 'invalid_interval' };
	return null;
}

/**
 * The `AssignmentDeadlineSet` this act appends, built from the NORMALISED
 * instant rather than from the submitted text.
 *
 * The caller has already run `refuseDeadline` and been answered `null`, so the
 * normalisation cannot fail here; the guard gives TypeScript the narrowing
 * rather than handling a reachable state.
 */
export function deadlineSetEvent(
	state: AssignmentDeadlineState,
	actor: DeadlineActor,
	deadline: string,
	now: string,
	deviceClass: string
): EventEnvelope {
	const normalised = normaliseDeadline(deadline);
	if (normalised === null) {
		throw new Error('deadlineSetEvent: the gate passed with an unreadable instant');
	}
	const payload: AssignmentDeadlineSetPayload = {
		deadline: normalised,
		previousDeadline: state.deadline,
		managerId: actor.managerId,
		teamId: actor.teamId,
		teamName: actor.teamName,
		setAt: now
	};
	return {
		type: ASSIGNMENT_DEADLINE_SET_EVENT,
		payload,
		managerId: actor.managerId,
		teamId: actor.teamId,
		deviceClass
	};
}

/** The `AssignmentReminderIntervalSet` this act appends. */
export function reminderIntervalSetEvent(
	state: AssignmentDeadlineState,
	actor: DeadlineActor,
	hours: number,
	deviceClass: string
): EventEnvelope {
	const payload: AssignmentReminderIntervalSetPayload = {
		intervalHours: hours,
		previousIntervalHours: state.reminderIntervalHours,
		managerId: actor.managerId,
		teamId: actor.teamId,
		teamName: actor.teamName
	};
	return {
		type: ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT,
		payload,
		managerId: actor.managerId,
		teamId: actor.teamId,
		deviceClass
	};
}

// --- Who is still outstanding ------------------------------------------------

/** One Team that still owes at least one contract length. */
export type OutstandingTeam = {
	readonly teamId: string;
	readonly teamName: string;
	/** How many won Players it holds that carry no length. */
	readonly unsetCount: number;
};

/**
 * Every Team with at least one won Player carrying no contract length, in an
 * explicitly sorted order.
 *
 * **Derived from the contracts fold alone, and that is deliberate.** A Team
 * that won nothing has no unset Player and is therefore never outstanding — it
 * has no assignment to make, which is exactly what `refuseSubmission` says
 * when it lets an empty Team submit. So this needs no roster of Teams to be
 * correct about one, `assignments.ts`'s reason for being a set.
 *
 * A submitted Team cannot appear here: `refuseSubmission` refuses a submission
 * while any won Player carries no length, so submission and an unset count of
 * zero are the same state reached two ways. The submissions fold is not
 * consulted, so the two cannot come to disagree.
 *
 * Sorted by `teamId` because AD-5 requires iteration over any collection that
 * can affect an outcome to be over an explicitly sorted sequence — this list
 * becomes the addressees of a mention and the payload of a marker, both of
 * which are outcomes.
 */
export function outstandingAssignmentTeams(
	contracts: AuctionContracts
): readonly OutstandingTeam[] {
	const byTeam = new Map<string, { teamName: string; unsetCount: number }>();
	for (const playerId of Object.keys(contracts.byPlayer).sort()) {
		const contract = contracts.byPlayer[playerId];
		if (contract === undefined) continue;
		if (contract.contractYears !== null) continue;
		const entry = byTeam.get(contract.teamId);
		if (entry === undefined) {
			byTeam.set(contract.teamId, { teamName: contract.teamName, unsetCount: 1 });
		} else {
			entry.unsetCount += 1;
		}
	}
	return [...byTeam.entries()]
		.map(([teamId, entry]) => ({
			teamId,
			teamName: entry.teamName,
			unsetCount: entry.unsetCount
		}))
		.sort((left, right) => (left.teamId < right.teamId ? -1 : 1));
}

// --- The tick decision --------------------------------------------------------

/**
 * Everything the deadline tick is decided from — three folds over one read of
 * the log, and nothing else.
 *
 * `submitted` is carried for the monitoring page's benefit and is deliberately
 * NOT read by the decision below: who is outstanding is a fact about contracts
 * carrying no length, and asking two folds the same question is how two
 * answers start to differ. See `outstandingAssignmentTeams`.
 */
export type AssignmentDeadlineTickState = {
	readonly deadline: AssignmentDeadlineState;
	readonly contracts: AuctionContracts;
	readonly submitted: SubmittedTeams;
};

/**
 * The instant one reminder interval before `deadline`, or `null` when either
 * half is absent or unreadable.
 *
 * The ONE derivation of the reminder instant, so the tick, a test and any
 * sentence the monitoring page states cannot disagree about it by an hour.
 */
export function reminderInstantFor(
	deadline: string | null,
	intervalHours: number | null
): string | null {
	if (deadline === null || intervalHours === null) return null;
	const ms = parseInstant(deadline);
	if (ms === null) return null;
	return formatInstant(ms - intervalHours * HOUR_MS);
}

/**
 * Decide what the deadline owes as of `now`: the reminder, the notice, both,
 * or nothing.
 *
 * Returns `null` for "nothing to do", which is the overwhelmingly common
 * answer and is not a refusal — `decidePhaseEnd`'s posture, for its reason:
 * this is not a command anybody submitted and there is nobody to word a
 * refusal to.
 *
 * Four ways to `null`, and each is a state rather than a failure:
 *
 *  - **no deadline has been set.** Until the Commissioner sets one there is no
 *    instant to compare against, so neither marker can fire. This is the whole
 *    of "the deadline exists only once the Commissioner sets it".
 *  - **the reminder is not due yet**, or no interval is set at all — in which
 *    case no reminder EVER fires for this deadline, and the notice still does.
 *  - **the reminder already went out for THIS deadline**, which is
 *    `remindedFor === deadline` and nothing else. After an extension it is the
 *    previous instant, does not match, and the reminder re-arms.
 *  - **the deadline has not passed**, or its notice already went out for this
 *    instant.
 *
 * Both may fire in ONE pass, and that is correct rather than a double-send: a
 * tick that was down across the reminder window comes back to a deadline that
 * has already passed, and the honest record is that both were owed. They are
 * appended in chronological order — the reminder first — so no prefix of the
 * log reads as a deadline that passed before its reminder was due.
 *
 * No contract length is written on this path or on any other in this story.
 */
export function decideAssignmentDeadlineTick(
	state: AssignmentDeadlineTickState,
	now: string
): Accepted<readonly EventEnvelope[]> | null {
	const deadline = state.deadline.deadline;
	if (deadline === null) return null;

	const outstanding = outstandingAssignmentTeams(state.contracts);
	const outstandingTeamIds = outstanding.map((team) => team.teamId);
	const outstandingPlayerCount = outstanding.reduce((sum, team) => sum + team.unsetCount, 0);

	const events: EventEnvelope[] = [];

	const reminderAt = reminderInstantFor(deadline, state.deadline.reminderIntervalHours);
	if (reminderAt !== null && state.deadline.remindedFor !== deadline && hasExpired(reminderAt, now)) {
		const payload: AssignmentMarkerPayload = {
			deadline,
			outstandingTeamIds,
			outstandingPlayerCount,
			evaluatedAt: now
		};
		events.push({
			type: ASSIGNMENT_REMINDERS_SENT_EVENT,
			payload,
			// **Null, and null together.** Nobody acted: a tick compared a
			// clock. `20260901000000_system_actor.sql` relaxes the two columns
			// together behind a check constraint, so a half-null actor is
			// unwritable.
			managerId: null,
			teamId: null
		});
	}

	if (state.deadline.passedFor !== deadline && hasExpired(deadline, now)) {
		const payload: AssignmentMarkerPayload = {
			deadline,
			outstandingTeamIds,
			outstandingPlayerCount,
			evaluatedAt: now
		};
		events.push({
			type: ASSIGNMENT_DEADLINE_PASSED_EVENT,
			payload,
			managerId: null,
			teamId: null
		});
	}

	if (events.length === 0) return null;
	return { kind: 'accepted', events };
}
