/**
 * Which Teams have submitted their contract assignments as FINAL, folded from
 * the log (Story 6.1, FR-21).
 *
 * **Submission is per-TEAM state, and that is why it is not on the contract.**
 * `contractsReducer` keys everything by Player, and a Team submitting is a fact
 * about the Team: it is true of a Team that won five Players and equally of one
 * that won none. Writing it onto five contracts would be five copies of one
 * fact, and the copies could disagree.
 *
 * It is a SET of Team ids for `eligibility.ts`'s reason: absence is the default
 * and the safe answer. A Team this fold has never seen has not submitted, which
 * is exactly the state every Team starts the Contract Assignment Phase in, so
 * the fold needs no roster of Teams to be correct about one.
 *
 * **Submission is one-way and this story keeps it that way.** There is no
 * `AssignmentsReopened` event and no un-submit: once a Team is in this set,
 * `refuseAssignment` refuses every further assignment from it. A Commissioner
 * acting on a Team's behalf is Story 7.3 and will bring its own event; nothing
 * here anticipates its shape.
 *
 * The `default: return state` discipline is `phase.ts`'s, for the same reason:
 * an event type this reducer has not been taught is not an error, it is simply
 * not about submission.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import type { Reducer } from './fold.ts';

/**
 * The event type a Team appends when it submits its assignments as final
 * (Story 6.1).
 *
 * Declared here, beside the reducer that gives it meaning, for
 * `nominations.ts`'s `NOMINATION_PLACED_EVENT` reason. Story 6.2 monitors this
 * same fold for the deadline and the completion roster, and Story 6.3's export
 * gate reads it; all three read one definition of "this Team is done".
 */
export const ASSIGNMENTS_SUBMITTED_EVENT = 'AssignmentsSubmitted';

/** The payload an `AssignmentsSubmitted` carries. */
export type AssignmentsSubmittedPayload = {
	readonly teamId: string;
	/** That Team's name — what the Audit Log and a refusal say out loud. */
	readonly teamName: string;
	readonly managerId: string;
	/** How many contracts the Team was submitting, as audit detail. */
	readonly assignedCount: number;
};

/** The Teams that have submitted their assignments as final, by Team id. */
export type SubmittedTeams = ReadonlySet<string>;

/** With no `AssignmentsSubmitted` event, no Team has submitted. */
export const INITIAL_ASSIGNMENTS: SubmittedTeams = new Set<string>();

/**
 * Whether one Team has submitted as final under a folded state.
 *
 * Exported so no call site writes `state.has(id)` itself — the route, the
 * command's gate inside the transaction and the core's refusal all ask the same
 * question the same way.
 */
export function hasSubmittedAssignments(state: SubmittedTeams, teamId: string): boolean {
	return state.has(teamId);
}

/**
 * Read an `AssignmentsSubmitted` payload defensively.
 *
 * Only `teamId` is folded on, and it cannot be guessed: an event naming no Team
 * states nothing this projection can record, so it is REJECTED. `teamName`,
 * `managerId` and `assignedCount` are audit detail this reducer never reads.
 */
function readPayload(payload: unknown): { readonly teamId: string } | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const record = payload as Record<string, unknown>;
	const teamId = record['teamId'];
	if (typeof teamId !== 'string' || teamId === '') return null;
	return { teamId };
}

/**
 * Fold one event onto the set of submitted Teams.
 *
 * A repeated `AssignmentsSubmitted` for a Team already in the set is a no-op,
 * which is what makes folding the same log twice converge (AD-5). In practice
 * one cannot arrive: the gate refuses a second submission from a final Team.
 */
export const assignmentsReducer: Reducer<SubmittedTeams> = (state, event) => {
	switch (event.type) {
		case ASSIGNMENTS_SUBMITTED_EVENT: {
			const payload = readPayload(event.payload);
			if (payload === null) return state;
			if (state.has(payload.teamId)) return state;
			// A new Set every time: the caller's state is never mutated, which is
			// what makes replay converge rather than accumulate.
			const next = new Set(state);
			next.add(payload.teamId);
			return next;
		}
		default:
			return state;
	}
};
