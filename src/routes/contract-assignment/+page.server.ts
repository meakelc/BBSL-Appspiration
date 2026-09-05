/**
 * The Manager-facing `/contract-assignment` route: a gated `load` listing the
 * Players this Team won with their current lengths and what is left of the Year
 * Allotment, one `assign` action and one `submit` action (Story 6.1, FR-21).
 *
 * One server-side gate, on `load` AND on both actions:
 * `requireLiveDestination` for the `contract-assignment` destination, which
 * `server/destinations.ts:86` already registers as live in the Contract
 * Assignment Phase for every Manager. `requireCommissioner` is deliberately NOT
 * called — assigning lengths is the ordinary Manager act this phase exists for,
 * and the catalog entry's `commissionerOnly: false` is the statement of that.
 * Hiding a form is never the check.
 *
 * **Nothing this file decides is a rules gate.** Four refusals are raised here
 * because none has anything to decide about inside a transaction: the unnamed
 * or unparsable length, because a submit that states no legal length cannot be
 * gated against an allotment; the missing confirmation, because an unconfirmed
 * submit means only that this request did not mean to act; and the unbound
 * actor, because `auction_events.manager_id`/`team_id` are NOT NULL (AD-4) so
 * there is no event to append. All four sentences still come from the pure core
 * — this file words no refusal of its own. Every real gate — the Team's
 * finality, the contract's existence and ownership, and the Year Allotment — is
 * re-derived inside the command's transaction under the global lock, so a page
 * that rendered a 4-year button cannot race a second 4-year deal past it.
 *
 * **The device class is read here and only here**, at the transport boundary,
 * exactly as `/nominate` reads it: the pure core classifies the string and never
 * sees the header, and the classification rides the event envelope rather than
 * the payload so no rule can come to depend on it.
 */

import { fail } from '@sveltejs/kit';

import { classifyDeviceClass } from '$lib/core/device-class.ts';
import { isContractYears } from '$lib/core/projection/contracts.ts';
import { contractAssignmentRefusalDetail } from '$lib/core/rules/contract-assignment.ts';
import {
	assignContractLength,
	loadAssignmentBoard,
	submitAssignmentsFinal
} from '$lib/server/contract-assignment.ts';
import type { ContractAssignmentRejection } from '$lib/server/contract-assignment.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { Actions, PageServerLoad } from './$types';

const CONTRACT_ASSIGNMENT_DESTINATION_ID = 'contract-assignment';

/**
 * The acting Team, from the session and nothing else (AD-4).
 *
 * `null` for any session that is not a registered Manager bound to a Team. The
 * form field a browser could post is never consulted — a Manager assigns only
 * as themselves, to their own Team.
 */
function actorFrom(session: App.Locals['session']) {
	if (session.kind !== 'registered') return null;
	const { manager } = session;
	if (manager.teamId === null) return null;
	return {
		managerId: manager.id,
		teamId: manager.teamId,
		teamName: manager.teamName ?? manager.teamId
	};
}

/** The one status an unbound actor is refused with (I/O matrix). */
const UNBOUND_ACTOR_STATUS = 403;

export const load: PageServerLoad = async ({ locals }) => {
	requireLiveDestination(
		locals.session,
		locals.phase.name,
		CONTRACT_ASSIGNMENT_DESTINATION_ID
	);

	const actor = actorFrom(locals.session);
	if (actor === null) {
		// A registered Manager bound to no Team has no contracts to assign and no
		// event they could ever append. The page still renders and says so, in
		// the core's words, rather than 500ing on a null Team.
		return {
			phase: locals.phase,
			board: null,
			unboundDetail: contractAssignmentRefusalDetail({ kind: 'unbound_actor' })
		};
	}

	const board = await loadAssignmentBoard(writeGateway(), actor);

	return {
		phase: locals.phase,
		// Every sentence on the board is already worded by the pure core — the
		// surface prints them and never re-words one.
		board,
		unboundDetail: null
	};
};

export const actions: Actions = {
	assign: async ({ request, locals }) => {
		requireLiveDestination(
			locals.session,
			locals.phase.name,
			CONTRACT_ASSIGNMENT_DESTINATION_ID
		);

		const form = await request.formData();
		const fantraxPlayerId = String(form.get('fantraxPlayerId') ?? '').trim();
		const rawYears = String(form.get('contractYears') ?? '').trim();

		if (fantraxPlayerId === '') {
			// A submit naming no Player has nothing for the gate to decide about,
			// so no transaction is opened for it. `not_won` is exactly "that is
			// not a Player your Team won", and an unnamed Player is not one.
			return fail(400, { notice: contractAssignmentRefusalDetail({ kind: 'not_won' }) });
		}

		// `Number` rather than `parseInt`: `parseInt('4x')` is 4, and a length is
		// a whole submitted value or it is not a length. `isContractYears` is the
		// core's one statement of which four values exist.
		const contractYears = rawYears === '' ? Number.NaN : Number(rawYears);
		if (!isContractYears(contractYears)) {
			return fail(400, { notice: contractAssignmentRefusalDetail({ kind: 'invalid_length' }) });
		}

		if (form.get('confirm') !== 'yes') {
			// A length spends the Team's Year Allotment, so it is never inferred
			// from a submit. No transaction is opened for an unconfirmed request.
			return fail(400, { notice: contractAssignmentRefusalDetail({ kind: 'unconfirmed' }) });
		}

		const actor = actorFrom(locals.session);
		if (actor === null) {
			return fail(UNBOUND_ACTOR_STATUS, {
				notice: contractAssignmentRefusalDetail({ kind: 'unbound_actor' })
			});
		}

		const deviceClass = classifyDeviceClass(request.headers.get('user-agent'));

		const outcome = await assignContractLength(
			writeGateway(),
			actor,
			fantraxPlayerId,
			contractYears,
			deviceClass
		);

		if (outcome.kind === 'rejected') {
			// The sentence comes from the pure core through the rejection — this
			// route never words a refusal itself, so the page, the tests and the
			// transaction all read one wording.
			const rejection = outcome.reason as ContractAssignmentRejection | undefined;
			return fail(409, {
				notice: rejection?.detail ?? contractAssignmentRefusalDetail({ kind: 'unrecorded' })
			});
		}

		const appended = outcome.events[0];

		return {
			notice:
				'The contract length is assigned. It is an appended event, not a stored column, ' +
				'so your Year Allotment is a count over your contracts and you may change this ' +
				'until you submit your Team as final.',
			appended:
				appended === undefined
					? null
					: {
							seq: appended.seq,
							occurredAt: appended.occurredAt,
							deviceClass: appended.deviceClass
						}
		};
	},

	submit: async ({ request, locals }) => {
		requireLiveDestination(
			locals.session,
			locals.phase.name,
			CONTRACT_ASSIGNMENT_DESTINATION_ID
		);

		const form = await request.formData();

		if (form.get('confirm') !== 'yes') {
			// Submitting is one-way: once final, no length on this Team changes
			// again. It is never inferred from a submit.
			return fail(400, { notice: contractAssignmentRefusalDetail({ kind: 'unconfirmed' }) });
		}

		const actor = actorFrom(locals.session);
		if (actor === null) {
			return fail(UNBOUND_ACTOR_STATUS, {
				notice: contractAssignmentRefusalDetail({ kind: 'unbound_actor' })
			});
		}

		const deviceClass = classifyDeviceClass(request.headers.get('user-agent'));

		const outcome = await submitAssignmentsFinal(writeGateway(), actor, deviceClass);

		if (outcome.kind === 'rejected') {
			const rejection = outcome.reason as ContractAssignmentRejection | undefined;
			return fail(409, {
				notice: rejection?.detail ?? contractAssignmentRefusalDetail({ kind: 'unrecorded' })
			});
		}

		const appended = outcome.events[0];

		return {
			notice:
				'Your Team is submitted as final. No length on it changes again; a correction ' +
				'from here goes through the Commissioner.',
			appended:
				appended === undefined
					? null
					: {
							seq: appended.seq,
							occurredAt: appended.occurredAt,
							deviceClass: appended.deviceClass
						}
		};
	}
};
