/**
 * The two Contract Assignment commands — assign one Player's length, and submit
 * a Team as final — plus the one read the surface renders from (Story 6.1,
 * FR-21).
 *
 * **One event read, two folds, no table.** A contract length is
 * `contractYears` on the Auction Contract fold and a submission is membership
 * of the `assignmentsReducer` set; neither is a column and neither is a
 * projection this story registers. `runTransactionalWrite` is therefore called
 * with no `projections` at all — there is nothing to persist beside the event,
 * which is what makes the whole feature converge under replay for free (AD-5).
 *
 * **Every gate is re-derived INSIDE the transaction**, under the global
 * advisory lock, from the log the transaction itself read.
 * `server/nomination.ts`'s discipline, and it matters as much here: a Manager
 * with two tabs open can otherwise spend one 4-year deal twice, and the page
 * that rendered both 4-year buttons is not the check. The `load` used by the
 * route's own `load` is the SAME function, so the surface and the gate cannot
 * disagree about what the log says — only about when they read it.
 *
 * **No `enqueue`.** Assignment is a Team talking to itself: nobody else is
 * waiting on which length a Manager gave their own Player, and a channel post
 * per assignment would be exactly the noise `server/eligibility.ts` declines to
 * make. The deadline reminders are Story 6.2 and will decide their own
 * addressing.
 *
 * The actor is resolved server-side from the session (AD-4/AD-15) and never
 * from a form field; the route is the one place that narrowing happens.
 */

import { fold } from '../core/projection/fold.ts';
import {
	ASSIGNMENTS_SUBMITTED_EVENT,
	INITIAL_ASSIGNMENTS,
	assignmentsReducer
} from '../core/projection/assignments.ts';
import type { AssignmentsSubmittedPayload } from '../core/projection/assignments.ts';
import {
	CONTRACT_LENGTH_ASSIGNED_EVENT,
	INITIAL_CONTRACTS,
	contractsReducer,
	contractsWonBy
} from '../core/projection/contracts.ts';
import type { ContractLengthAssignedPayload, ContractYears } from '../core/projection/contracts.ts';
import {
	assignmentBoardFor,
	contractAssignmentRefusalDetail,
	refuseAssignment,
	refuseSubmission
} from '../core/rules/contract-assignment.ts';
import type {
	AssignmentActor,
	AssignmentBoard,
	ContractAssignmentRefusal,
	ContractAssignmentState
} from '../core/rules/contract-assignment.ts';
import type { EventEnvelope } from '../core/types.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { loadEventsViaClient } from './event-log.ts';

export type { AssignmentActor };

/** What a rejection carries back to the route: the refusal and its one sentence. */
export type ContractAssignmentRejection = {
	readonly refusal: ContractAssignmentRefusal;
	readonly detail: string;
};

/** A rejection, built once so the gate and the route read one wording. */
function rejectionFor(refusal: ContractAssignmentRefusal): ContractAssignmentRejection {
	return { refusal, detail: contractAssignmentRefusalDetail(refusal) };
}

/**
 * The contracts and the submitted Teams, from ONE read of the log.
 *
 * Two folds over a single `loadEventsViaClient` read: the projections cannot
 * disagree about which events they saw, because they saw the same array. There
 * is no table read at all here — a length and a submission are both folds.
 */
export async function loadContractAssignmentState(
	client: TransactionalClient
): Promise<ContractAssignmentState> {
	const events = await loadEventsViaClient(client);
	return {
		contracts: fold(INITIAL_CONTRACTS, events, contractsReducer),
		submitted: fold(INITIAL_ASSIGNMENTS, events, assignmentsReducer)
	};
}

/**
 * The surface's own read: the acting Team's won Players, their current lengths
 * and what is left of the Year Allotment.
 *
 * It opens a transaction because `loadEventsViaClient` needs a
 * `TransactionalClient`; it takes no advisory lock and decides nothing. The
 * board it returns is the CORE's, worded by `core/rules/contract-assignment.ts`
 * — this module adds no sentence of its own.
 */
export async function loadAssignmentBoard(
	gateway: ConnectionGateway,
	actor: AssignmentActor
): Promise<AssignmentBoard> {
	const client = await gateway.connect();
	try {
		const state = await loadContractAssignmentState(client);
		return assignmentBoardFor(state, actor);
	} finally {
		try {
			client.release();
		} catch (error) {
			console.error('loadAssignmentBoard: releasing the read connection failed', error);
		}
	}
}

/**
 * Give one won Player a contract length: one transaction, one
 * `ContractLengthAssigned`, nothing else written.
 *
 * The confirmation is checked by the route before this is called and is NOT a
 * rules gate — it establishes only that the request meant to assign. Everything
 * that could make an assignment wrong — the Team's finality, the contract's
 * existence and ownership, and the Year Allotment — is re-derived here, under
 * the lock, from the log.
 *
 * The payload carries the Player's name and the Team's name off the CONTRACT
 * this transaction folded, never off the form: a refusal or an Audit Log line
 * that named a Player the submitter chose to call something else would be the
 * form talking.
 *
 * Returns `accepted` with the single appended event, or `rejected` carrying a
 * `ContractAssignmentRejection`.
 */
export async function assignContractLength(
	gateway: ConnectionGateway,
	actor: AssignmentActor,
	fantraxPlayerId: string,
	contractYears: ContractYears,
	deviceClass: string
): Promise<WriteOutcome> {
	return await runTransactionalWrite<ContractAssignmentState>({
		gateway,
		load: (client) => loadContractAssignmentState(client),
		decide: ({ state }) => {
			const refusal = refuseAssignment(state, actor, { fantraxPlayerId, contractYears });
			if (refusal !== null) return { kind: 'rejected', reason: rejectionFor(refusal) };

			// Non-null by construction: `refuseAssignment` answers `not_won` when
			// this Team holds no contract for the Player, so reaching here means
			// the contract was folded. The guard gives TypeScript the narrowing
			// rather than handling a reachable state.
			const contract = contractsWonBy(state.contracts, actor.teamId).find(
				(won) => won.fantraxPlayerId === fantraxPlayerId
			);
			if (contract === undefined) {
				throw new Error('assignContractLength: the gate passed with no contract loaded');
			}

			const payload: ContractLengthAssignedPayload = {
				fantraxPlayerId: contract.fantraxPlayerId,
				playerName: contract.playerName,
				teamId: actor.teamId,
				teamName: actor.teamName,
				managerId: actor.managerId,
				contractYears
			};

			const event: EventEnvelope = {
				type: CONTRACT_LENGTH_ASSIGNED_EVENT,
				payload,
				managerId: actor.managerId,
				teamId: actor.teamId,
				deviceClass
			};
			return { kind: 'accepted', events: [event] };
		}
	});
}

/**
 * Submit the acting Team's assignments as final: one transaction, one
 * `AssignmentsSubmitted`.
 *
 * The gate is re-derived inside the transaction for the reason the header
 * gives, and it is the stricter half of the pair: a Team may not go final while
 * any Player it won carries no length, and the count in that refusal is the
 * count this transaction folded rather than the one the page rendered from.
 */
export async function submitAssignmentsFinal(
	gateway: ConnectionGateway,
	actor: AssignmentActor,
	deviceClass: string
): Promise<WriteOutcome> {
	return await runTransactionalWrite<ContractAssignmentState>({
		gateway,
		load: (client) => loadContractAssignmentState(client),
		decide: ({ state }) => {
			const refusal = refuseSubmission(state, actor);
			if (refusal !== null) return { kind: 'rejected', reason: rejectionFor(refusal) };

			const payload: AssignmentsSubmittedPayload = {
				teamId: actor.teamId,
				teamName: actor.teamName,
				managerId: actor.managerId,
				assignedCount: contractsWonBy(state.contracts, actor.teamId).length
			};

			const event: EventEnvelope = {
				type: ASSIGNMENTS_SUBMITTED_EVENT,
				payload,
				managerId: actor.managerId,
				teamId: actor.teamId,
				deviceClass
			};
			return { kind: 'accepted', events: [event] };
		}
	});
}
