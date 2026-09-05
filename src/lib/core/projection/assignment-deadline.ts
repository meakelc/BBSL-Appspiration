/**
 * The Contract Assignment deadline, its reminder interval, and the two markers
 * that record what has already been sent for it — all folded from the log
 * (Story 6.2, FR-29).
 *
 * **The deadline is not a column and neither is the interval.** Both are
 * appended events and nothing else, for `assignments.ts`'s reason: a deadline
 * stored in a table would be a second statement of a fact the log already
 * carries, and the two could disagree after a replay. The Commissioner setting
 * a deadline appends `AssignmentDeadlineSet`; extending it appends another one
 * naming a later instant. There is no separate extend event and no update.
 *
 * **The markers hold an INSTANT, never a boolean, and that is the whole
 * design.** `remindedFor` and `passedFor` each carry the deadline instant that
 * marker fired for. The tick runs every ten seconds forever, so it must be
 * able to ask "has the reminder for THIS deadline gone out?" rather than "has
 * a reminder ever gone out". A boolean answers the second question, which is
 * the wrong one the moment the Commissioner extends: the new deadline is a
 * different instant, both markers stop matching it, and both re-arm by
 * construction rather than by a reset somebody has to remember to write.
 *
 * That is also what makes the tick idempotent. Appending the marker happens in
 * the SAME transaction as the enqueue it describes, so a crash between the two
 * is impossible, and a second pass folds a log that already carries the marker
 * and decides to do nothing. The outbox's own `(event_seq, channel, recipient)`
 * conflict clause is the second line of defence, not the first.
 *
 * **Nothing here is a gate.** The deadline passing appends a marker. It does
 * not change the phase, does not mark a Team delinquent, does not write a
 * contract length and does not touch any export gate.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { parseInstant } from '../instant.ts';
import type { Reducer } from './fold.ts';

/**
 * The event the Commissioner appends to set — or to extend — the assignment
 * deadline.
 *
 * Declared here beside the reducer that gives it meaning, `nominations.ts`'s
 * `NOMINATION_PLACED_EVENT` pattern. ONE type covers the first set and every
 * extension: `core/rules/assignment-deadline.ts` refuses an instant that is
 * not later than the standing one, so the log reads as a monotonic record of a
 * deadline that only ever moved outward, which is what "the extension is
 * logged" is asking for.
 */
export const ASSIGNMENT_DEADLINE_SET_EVENT = 'AssignmentDeadlineSet';

/** The event that sets how far ahead of the deadline the one reminder goes. */
export const ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT = 'AssignmentReminderIntervalSet';

/**
 * The marker appended in the same transaction as the reminder's enqueue.
 *
 * System-originated: nobody acted, a tick compared a clock. Its envelope
 * carries a null Manager and a null Team together, exactly as
 * `ContractAssignmentOpened` does.
 */
export const ASSIGNMENT_REMINDERS_SENT_EVENT = 'AssignmentRemindersSent';

/** The marker appended in the same transaction as the deadline notice. */
export const ASSIGNMENT_DEADLINE_PASSED_EVENT = 'AssignmentDeadlinePassed';

/**
 * The `AssignmentDeadlineSet` payload.
 *
 * `previousDeadline` is what this set moved the deadline FROM, or `null` for
 * the first one — the extension, readable off the one event rather than
 * reconstructed by scanning backwards for the set before it. `deadline` is the
 * new instant, ISO-8601 UTC as the core normalised it, so a fold and a
 * rendering cannot disagree about a millisecond or an offset spelling.
 */
export type AssignmentDeadlineSetPayload = {
	readonly deadline: string;
	readonly previousDeadline: string | null;
	readonly managerId: string;
	readonly teamId: string;
	readonly teamName: string;
	/** The injected `now` the deadline was checked against, as audit detail. */
	readonly setAt: string;
};

/** The `AssignmentReminderIntervalSet` payload: a whole number of hours. */
export type AssignmentReminderIntervalSetPayload = {
	readonly intervalHours: number;
	readonly previousIntervalHours: number | null;
	readonly managerId: string;
	readonly teamId: string;
	readonly teamName: string;
};

/**
 * What both markers carry, and they carry the same three things.
 *
 * `deadline` is the instant the marker fired FOR — the fold keys on it, and it
 * is what makes an extension re-arm. `outstandingTeamIds` is who was mentioned,
 * recorded on the event so the enqueue reads the addressees off what was
 * actually appended rather than re-deriving them; empty is an ordinary outcome
 * and is the "every Team submitted" row of the matrix. `evaluatedAt` is the
 * injected `now` the comparison was made against, so a tick that ran late is
 * readable as late rather than as wrong — `AuctionTerminatedPayload` carries
 * the identical pair for the identical reason.
 */
export type AssignmentMarkerPayload = {
	readonly deadline: string;
	readonly outstandingTeamIds: readonly string[];
	/** How many won Players across those Teams still carry no length. */
	readonly outstandingPlayerCount: number;
	readonly evaluatedAt: string;
};

/** Everything the deadline is decided from, folded from the log. */
export type AssignmentDeadlineState = {
	/** The standing deadline, ISO-8601 UTC, or `null` until one is set. */
	readonly deadline: string | null;
	/** The reminder interval in whole hours, or `null` until one is set. */
	readonly reminderIntervalHours: number | null;
	/** The deadline instant the one reminder has already gone out for. */
	readonly remindedFor: string | null;
	/** The deadline instant the notice has already gone out for. */
	readonly passedFor: string | null;
};

/** With no deadline event, there is no deadline and nothing can fire. */
export const INITIAL_ASSIGNMENT_DEADLINE: AssignmentDeadlineState = Object.freeze({
	deadline: null,
	reminderIntervalHours: null,
	remindedFor: null,
	passedFor: null
});

/** A non-blank string field of an unknown payload, or `null`. */
function text(payload: unknown, key: string): string | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const value = (payload as Record<string, unknown>)[key];
	if (typeof value !== 'string') return null;
	return value === '' ? null : value;
}

/**
 * Read a marker payload defensively — the pair a write site and a heartbeat
 * both need, or `null` for a payload that is not one.
 *
 * `readPhaseEndInstants`' idiom, for its reason: `AppendedEvent.payload` is
 * `unknown`, an insert-only log cannot be corrected in place, and a malformed
 * historical row must never crash a reader. Exported so `server/outbox.ts`'s
 * affected-Teams answer and the projection read one definition of the payload.
 */
export function readAssignmentMarker(payload: unknown): {
	readonly deadline: string;
	readonly outstandingTeamIds: readonly string[];
} | null {
	const deadline = text(payload, 'deadline');
	if (deadline === null) return null;
	const raw = (payload as Record<string, unknown>)['outstandingTeamIds'];
	// An absent list is an empty one rather than a rejection: "no Team was
	// outstanding" is a real, ordinary outcome and the marker still stands.
	// Deduplicated, because this list becomes the ADDRESSEES of a mention:
	// `enqueueMentions` resolves each id to that Team's Managers, so a repeated
	// id would file the same Manager's intent twice for one event. The writer
	// builds the list off a Map keyed by Team id and cannot repeat one, which is
	// exactly why the guarantee belongs here too rather than only there.
	const outstandingTeamIds = Array.isArray(raw)
		? [...new Set(raw.filter((id): id is string => typeof id === 'string' && id !== ''))]
		: [];
	return { deadline, outstandingTeamIds };
}

/**
 * Fold one event onto the deadline state.
 *
 * `AssignmentDeadlineSet` folds UNCONDITIONALLY, without comparing the instant
 * it carries against the one it is replacing. The GATE is what makes a
 * non-later instant unappendable (`core/rules/assignment-deadline.ts`); a
 * reducer must be total over any log it is handed, and the ORDER of the log
 * decides the answer. That is `phaseReducer`'s discipline verbatim.
 *
 * The `default: return state` arm is `assignments.ts`'s: an event type this
 * reducer has not been taught is not an error, it is simply not about the
 * deadline.
 */
export const assignmentDeadlineReducer: Reducer<AssignmentDeadlineState> = (state, event) => {
	switch (event.type) {
		case ASSIGNMENT_DEADLINE_SET_EVENT: {
			const deadline = text(event.payload, 'deadline');
			// A set that names no instant states nothing this projection can
			// record, so it is REJECTED rather than folded as a clearing.
			if (deadline === null) return state;
			// And an instant nothing downstream can READ is rejected on the same
			// ground. `hasExpired` and `reminderInstantFor` both parse this value;
			// a fold holding a string they answer `null` to would be a deadline
			// that silently never fires and that the monotonic gate in
			// `refuseDeadline` cannot compare an extension against — so it would
			// also let an EARLIER instant through. Writes normalise before they
			// append, so this is unreachable from the commands; it is here
			// because a reducer must be total over any log it is handed.
			if (parseInstant(deadline) === null) return state;
			// A new object every time: the caller's state is never mutated,
			// which is what makes replay converge rather than accumulate. The
			// markers are carried through UNCHANGED — they key on the deadline
			// instant, so they stop matching the moment it moves and re-arm
			// without anything here having to reset them.
			return { ...state, deadline };
		}
		case ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT: {
			if (typeof event.payload !== 'object' || event.payload === null) return state;
			const hours = (event.payload as Record<string, unknown>)['intervalHours'];
			if (typeof hours !== 'number' || !Number.isInteger(hours) || hours <= 0) return state;
			return { ...state, reminderIntervalHours: hours };
		}
		case ASSIGNMENT_REMINDERS_SENT_EVENT: {
			const marker = readAssignmentMarker(event.payload);
			if (marker === null) return state;
			return { ...state, remindedFor: marker.deadline };
		}
		case ASSIGNMENT_DEADLINE_PASSED_EVENT: {
			const marker = readAssignmentMarker(event.payload);
			if (marker === null) return state;
			return { ...state, passedFor: marker.deadline };
		}
		default:
			return state;
	}
};
