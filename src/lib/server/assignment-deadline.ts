/**
 * The two Commissioner deadline commands, the tick step that evaluates the
 * deadline, and the one read the monitoring page renders from (Story 6.2,
 * FR-29).
 *
 * **One event read, three folds, no table.** The deadline is
 * `assignmentDeadlineReducer` over the log, the submissions are the
 * `assignmentsReducer` set and the unset lengths are `contractYears` on the
 * contracts fold. None of them is a column and none is a projection this story
 * registers, so `runTransactionalWrite` is called with no `projections` at all
 * — which is what makes the whole feature converge under replay for free
 * (AD-5) and why this story adds no migration.
 *
 * **Every gate is re-derived INSIDE the transaction**, under the global
 * advisory lock, from the log the transaction itself read.
 * `server/contract-assignment.ts`'s discipline: a Commissioner with two tabs
 * open can otherwise walk the deadline backwards, and the page that rendered
 * the form is not the check.
 *
 * **The marker and its enqueue commit together or neither does.**
 * `evaluateAssignmentDeadline` appends `AssignmentRemindersSent` /
 * `AssignmentDeadlinePassed` in the SAME transaction as the outbox intents
 * they describe, so a crash between the two is impossible. The outbox's own
 * `(event_seq, channel, recipient)` conflict clause is the second line of
 * defence, not the first — the first is that a second pass folds a log that
 * already carries the marker and decides to do nothing.
 *
 * **`now` is the database's transaction-start clock and never a client's**
 * (AD-3). It reaches the pure core as an argument, on both the tick step and
 * the deadline command's own past check.
 *
 * **No contract length is written here, on any path.** The only events this
 * module appends are the two sets and the two markers.
 *
 * **One module, two runtimes.** Relative `.ts` imports only, no Node builtin,
 * no `$env` and no bare specifier — Deno loads this file through
 * `supabase/functions/tick/index.ts`, so it is under the same constraint
 * `server/phase-end.ts` is (AD-2).
 */

import {
	ASSIGNMENT_DEADLINE_PASSED_EVENT,
	ASSIGNMENT_REMINDERS_SENT_EVENT,
	INITIAL_ASSIGNMENT_DEADLINE,
	assignmentDeadlineReducer,
	readAssignmentMarker
} from '../core/projection/assignment-deadline.ts';
import {
	INITIAL_ASSIGNMENTS,
	assignmentsReducer
} from '../core/projection/assignments.ts';
import { INITIAL_CONTRACTS, contractsReducer } from '../core/projection/contracts.ts';
import { fold } from '../core/projection/fold.ts';
import {
	assignmentDeadlineRefusalDetail,
	deadlineSetEvent,
	decideAssignmentDeadlineTick,
	refuseDeadline,
	refuseReminderInterval,
	reminderIntervalSetEvent
} from '../core/rules/assignment-deadline.ts';
import type {
	AssignmentDeadlineRefusal,
	AssignmentDeadlineTickState,
	DeadlineActor
} from '../core/rules/assignment-deadline.ts';
import { assignmentMonitorFor } from '../core/rules/assignment-monitor.ts';
import type { AssignmentMonitor } from '../core/rules/assignment-monitor.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { loadEventsViaClientSince, maxSeqViaClient } from './event-log.ts';
import { foldCacheSlot, foldIncrementally } from './fold-cache.ts';
import { enqueueBroadcastsAndMentions } from './outbox.ts';
import { loadTeamIdentities } from './teams-index.ts';

export type { DeadlineActor };

/** What a rejection carries back to the route: the refusal and its sentence. */
export type AssignmentDeadlineRejection = {
	readonly refusal: AssignmentDeadlineRefusal;
	readonly detail: string;
};

/** A rejection, built once so the gate and the route read one wording. */
function rejectionFor(refusal: AssignmentDeadlineRefusal): AssignmentDeadlineRejection {
	return { refusal, detail: assignmentDeadlineRefusalDetail(refusal) };
}

/**
 * The deadline, the contracts and the submitted Teams, from ONE read of the
 * log.
 *
 * Three folds over a single `loadEventsViaClient` read: the projections cannot
 * disagree about which events they saw, because they saw the same array.
 * `server/contract-assignment.ts`'s `loadContractAssignmentState`, extended by
 * exactly one fold.
 */
export async function loadAssignmentDeadlineState(
	client: TransactionalClient
): Promise<AssignmentDeadlineTickState> {
	return foldIncrementally<AssignmentDeadlineTickState>({
		slot,
		liveSeq: () => maxSeqViaClient(client),
		loadSince: (since) => loadEventsViaClientSince(client, since),
		initial: {
			deadline: INITIAL_ASSIGNMENT_DEADLINE,
			contracts: INITIAL_CONTRACTS,
			submitted: INITIAL_ASSIGNMENTS
		},
		extend: (state, events) => ({
			deadline: fold(state.deadline, events, assignmentDeadlineReducer),
			contracts: fold(state.contracts, events, contractsReducer),
			submitted: fold(state.submitted, events, assignmentsReducer)
		})
	});
}

/**
 * This process's folded assignment-deadline state, and the `seq` it is folded
 * through.
 *
 * **The three folds still see one events array** — the discipline the header
 * above states — because they are extended by the same tail in the same call.
 * What the cache removes is re-reading rows all three have already folded, on
 * a loader the tick runs every ten seconds forever (AD-10).
 *
 * **The deadline passes by time passing, not by an event**, so nothing about
 * when it is due is cached: the decision is re-derived from this state and the
 * transaction's own clock on every pass, exactly as before.
 */
const slot = foldCacheSlot<AssignmentDeadlineTickState>();

/** Discard this process's folded assignment-deadline state. For tests only. */
export function resetAssignmentDeadlineFoldCache(): void {
	slot.held = null;
}

/**
 * Set — or extend — the assignment deadline: one transaction, one
 * `AssignmentDeadlineSet`, nothing else written.
 *
 * The confirmation is checked by the route before this is called and is NOT a
 * rules gate; it establishes only that the request meant to act. Everything
 * that could make a deadline wrong — that it is readable, that it is in the
 * future, and that it is later than the standing one — is re-derived here,
 * under the lock, against the transaction's own clock.
 *
 * Returns `accepted` with the single appended event, or `rejected` carrying an
 * `AssignmentDeadlineRejection`.
 */
export async function setAssignmentDeadline(
	gateway: ConnectionGateway,
	actor: DeadlineActor,
	deadline: string,
	deviceClass: string
): Promise<WriteOutcome> {
	return await runTransactionalWrite<AssignmentDeadlineTickState>({
		gateway,
		load: (client) => loadAssignmentDeadlineState(client),
		decide: ({ state, now }) => {
			// The database's transaction-start instant, never `Date.now()`
			// (AD-3) and never a value the browser submitted.
			const at = now.toISOString();
			const refusal = refuseDeadline(state.deadline, deadline, at);
			if (refusal !== null) return { kind: 'rejected', reason: rejectionFor(refusal) };
			return {
				kind: 'accepted',
				events: [deadlineSetEvent(state.deadline, actor, deadline, at, deviceClass)]
			};
		}
	});
}

/**
 * Set the reminder interval: one transaction, one
 * `AssignmentReminderIntervalSet`.
 *
 * It takes no clock and compares against no deadline. An interval is a
 * duration rather than an instant, and it is legitimately set before any
 * deadline exists — the matrix's "interval unset" row is the mirror of that,
 * and neither ordering is refused.
 */
export async function setReminderInterval(
	gateway: ConnectionGateway,
	actor: DeadlineActor,
	intervalHours: number,
	deviceClass: string
): Promise<WriteOutcome> {
	return await runTransactionalWrite<AssignmentDeadlineTickState>({
		gateway,
		load: (client) => loadAssignmentDeadlineState(client),
		decide: ({ state }) => {
			const refusal = refuseReminderInterval(intervalHours);
			if (refusal !== null) return { kind: 'rejected', reason: rejectionFor(refusal) };
			return {
				kind: 'accepted',
				events: [reminderIntervalSetEvent(state.deadline, actor, intervalHours, deviceClass)]
			};
		}
	});
}

/**
 * What one deadline evaluation did, as the tick has to report it.
 *
 * `reminded` and `passed` are `true` only when THIS evaluation appended the
 * marker — never when it merely observed one already in the log. That is the
 * whole point of recording them: a heartbeat saying the reminder went out on
 * every pass for a week would be a heartbeat nobody could read the send out
 * of.
 */
export type AssignmentDeadlineOutcome = {
	readonly reminded: boolean;
	readonly passed: boolean;
	/** The deadline instant the markers fired for, or `null` for a quiet pass. */
	readonly deadline: string | null;
	/** The Teams the markers addressed, off the payloads that committed. */
	readonly outstandingTeamIds: readonly string[];
};

/** A pass that appended nothing, which is almost every pass. */
const NOTHING_OWED: AssignmentDeadlineOutcome = Object.freeze({
	reminded: false,
	passed: false,
	deadline: null,
	outstandingTeamIds: Object.freeze([]) as readonly string[]
});

/**
 * Evaluate the assignment deadline and send what it owes: one transaction, at
 * most one `AssignmentRemindersSent` and at most one
 * `AssignmentDeadlinePassed`, with the outbox intents they describe.
 *
 * **`evaluateLeagueClock`'s shape, called on the same tick.** It is its own
 * whole `runTransactionalWrite`, so a throw here rolls back nothing already
 * committed and is recorded on the heartbeat like a failed close. It runs
 * AFTER the phase end and BEFORE the drain, so it folds a log that already
 * carries any `ContractAssignmentOpened` this pass appended and every intent
 * it files is drained on the same pass.
 *
 * **The enqueue is the composed one, and the composition does the routing.**
 * `enqueueBroadcasts` files a channel-addressed intent only for a type in
 * `BROADCAST_EVENT_TYPES`, and only `AssignmentDeadlinePassed` is in it — so
 * the reminder gets mentions alone and the notice gets the league channel too,
 * without this call site branching on a type. The addressed Teams are read off
 * the payload that was actually appended, through the projection's own reader,
 * so who was mentioned and what the log records cannot diverge.
 *
 * **No `deviceClass`.** A tick evaluation is not a user action: no browser
 * submitted it and no header describes it.
 *
 * **A deadline evaluation cannot be refused**, so there is no rejection shape.
 * `decideAssignmentDeadlineTick` answers `null` for "nothing to do", which
 * becomes an accepted decision appending zero events — the transaction still
 * opens, takes the lock and commits. Every failure it can reach is a bug and
 * arrives as a throw (AD-1), which rolls back with nothing appended.
 */
export async function evaluateAssignmentDeadline(
	gateway: ConnectionGateway
): Promise<AssignmentDeadlineOutcome> {
	const outcome = await runTransactionalWrite<AssignmentDeadlineTickState>({
		gateway,
		enqueue: enqueueBroadcastsAndMentions((event) => {
			if (
				event.type !== ASSIGNMENT_REMINDERS_SENT_EVENT &&
				event.type !== ASSIGNMENT_DEADLINE_PASSED_EVENT
			) {
				return [];
			}
			// Off the appended payload, through the core's own reader — never
			// re-derived here. An empty list is the honest answer for the
			// matrix's "every Team submitted at the deadline" row: the marker
			// stands and the league-channel line still records it.
			return readAssignmentMarker(event.payload)?.outstandingTeamIds ?? [];
		}),
		load: (client) => loadAssignmentDeadlineState(client),
		decide: ({ state, now }) => {
			const decision = decideAssignmentDeadlineTick(state, now.toISOString());
			// `null` is "no deadline is set", "nothing is due yet" or "both
			// markers already fired for this deadline" — by far the common
			// answer, and not a refusal.
			if (decision === null) return { kind: 'accepted', events: [] };
			return decision;
		}
	});

	if (outcome.kind !== 'accepted') {
		// Unreachable: `decideAssignmentDeadlineTick` has no `Rejected` half,
		// so the pipeline can only answer `accepted` here or throw. The guard
		// gives TypeScript the narrowing rather than handling a reachable
		// state.
		return NOTHING_OWED;
	}

	// **Derived from what was actually appended**, not from what was decided.
	// The events came back off the `returning` clause of the inserts that
	// committed, so this reports the transaction's real effect.
	const reminder = outcome.events.find((event) => event.type === ASSIGNMENT_REMINDERS_SENT_EVENT);
	const passed = outcome.events.find((event) => event.type === ASSIGNMENT_DEADLINE_PASSED_EVENT);
	const marker = readAssignmentMarker(passed?.payload ?? reminder?.payload ?? null);

	return {
		reminded: reminder !== undefined,
		passed: passed !== undefined,
		deadline: marker?.deadline ?? null,
		outstandingTeamIds: marker?.outstandingTeamIds ?? []
	};
}

/**
 * The monitoring page's own read: every Team, whether it has submitted, how
 * many Players it still owes, and the deadline state.
 *
 * It opens a transaction because `loadEventsViaClient` needs a
 * `TransactionalClient`; it takes no advisory lock and decides nothing —
 * rendering a page is not a write. The identity read is
 * `server/teams-index.ts`'s, reused rather than restated, so the roster of
 * Teams this page lists and the one `/teams` lists come from one statement.
 *
 * The view it returns is the CORE's, worded by `core/rules/assignment-monitor.ts`
 * — this module adds no sentence of its own.
 */
export async function loadAssignmentMonitor(
	gateway: ConnectionGateway
): Promise<AssignmentMonitor> {
	const client = await gateway.connect();
	try {
		// The log read first, then the identity read, on the SAME connection —
		// sequential rather than raced, because a pooled client serves one
		// statement at a time.
		const state = await loadAssignmentDeadlineState(client);
		const teams = await loadTeamIdentities(client);
		return assignmentMonitorFor({
			teams,
			contracts: state.contracts,
			submitted: state.submitted,
			deadline: state.deadline
		});
	} finally {
		try {
			client.release();
		} catch (error) {
			console.error('loadAssignmentMonitor: releasing the read connection failed', error);
		}
	}
}
