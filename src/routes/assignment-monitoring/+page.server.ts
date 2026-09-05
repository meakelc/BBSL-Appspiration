/**
 * The Commissioner-only `/assignment-monitoring` route: a gated `load` listing
 * every Team as submitted or not with how many Players it still owes, one
 * `deadline` action that sets or extends the assignment deadline, and one
 * `interval` action that sets the reminder interval (Story 6.2, FR-29).
 *
 * Two server-side gates, in order — `requireCommissioner` (a Commissioner
 * only, whichever session kind) and `requireLiveDestination` (this destination
 * is live for Contract Assignment and this role) — on `load` AND on BOTH
 * actions, `/import`'s discipline. `server/destinations.ts` already registers
 * `assignment-monitoring` as `commissionerOnly: true` in the Contract
 * Assignment Phase; this story registers nothing and changes no catalog entry.
 * Hiding a form is never the check: a non-Commissioner, or a request in the
 * Auction or Archived Phase, refuses here regardless of what any client
 * renders.
 *
 * **Nothing this file decides is a rules gate.** Three refusals are raised
 * here, each a different kind of the core's union, because none has anything
 * to decide about inside a transaction:
 *
 *   - `unconfirmed`, for a missing confirmation — it establishes only that
 *     this request meant to act.
 *   - `unparseable_deadline` / `invalid_interval`, for a field that is not a
 *     value at all — there is no standing deadline to compare a non-instant
 *     against, and no range to place a non-number in.
 *   - `unbound_actor`, because `auction_events.manager_id`/`team_id` are NOT
 *     NULL for an actor-bearing event (AD-4), so there is no event to append.
 *
 * All three sentences still come from the pure core — this file words no
 * refusal of its own. Every real gate — that the instant is in the future and
 * later than the standing deadline, and that the interval is in range — is
 * re-derived inside the command's transaction under the global lock, against
 * the database's own clock, so a page loaded an hour ago cannot race a stale
 * deadline past it.
 *
 * **Nothing here writes a contract length**, and no code path reachable from
 * this route can: the two commands append an `AssignmentDeadlineSet` and an
 * `AssignmentReminderIntervalSet` and nothing else.
 */

import { fail } from '@sveltejs/kit';

import { classifyDeviceClass } from '$lib/core/device-class.ts';
import { assignmentDeadlineRefusalDetail } from '$lib/core/rules/assignment-deadline.ts';
import type { AssignmentDeadlineRefusal } from '$lib/core/rules/assignment-deadline.ts';
import {
	loadAssignmentMonitor,
	setAssignmentDeadline,
	setReminderInterval
} from '$lib/server/assignment-deadline.ts';
import type { AssignmentDeadlineRejection } from '$lib/server/assignment-deadline.ts';
import { requireCommissioner } from '$lib/server/commissioner-guard.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { Actions, PageServerLoad } from './$types';

const MONITORING_DESTINATION_ID = 'assignment-monitoring';

/** The one status an unbound actor is refused with. */
const UNBOUND_ACTOR_STATUS = 403;

/**
 * The status a gate refusal answers with.
 *
 * A value the Commissioner could have spelled differently is a 400; a value
 * that reads fine but conflicts with the deadline already standing is a 409.
 * The distinction is the whole reason `AssignmentDeadlineRejection` carries
 * the refusal and not just its sentence: `deadline_in_past` is only knowable
 * against the DATABASE clock, so it can be decided nowhere but inside the
 * transaction, and mapping every gate to one status would report it as a
 * conflict with a deadline that may not even exist yet.
 */
function statusFor(refusal: AssignmentDeadlineRefusal | undefined): number {
	switch (refusal?.kind) {
		case 'unparseable_deadline':
		case 'deadline_in_past':
		case 'invalid_interval':
			return 400;
		case 'unbound_actor':
			return UNBOUND_ACTOR_STATUS;
		default:
			return 409;
	}
}

/**
 * The acting Commissioner, from the session and nothing else (AD-4).
 *
 * `null` for a session bound to no Team. `requireCommissioner` has already
 * established the session is a registered Commissioner, so the narrowing below
 * cannot fail on its first half; it exists because that guard returns void
 * rather than the manager, and because the Team binding is a separate fact.
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

/** Both guards, in one place, so `load` and both actions cannot drift apart. */
function guard(locals: App.Locals): void {
	requireCommissioner(locals.session);
	requireLiveDestination(locals.session, locals.phase.name, MONITORING_DESTINATION_ID);
}

export const load: PageServerLoad = async ({ locals }) => {
	guard(locals);

	const monitor = await loadAssignmentMonitor(writeGateway());

	return {
		phase: locals.phase,
		// Every sentence on the monitor is already worded by the pure core — the
		// surface prints them and never re-words one.
		monitor
	};
};

export const actions: Actions = {
	/**
	 * Set the assignment deadline, or extend it.
	 *
	 * One action for both, because there is one act: FR-29 grants an extension
	 * rather than a rescheduling, and the core refuses an instant that is not
	 * later than the standing one. There is no separate extend command and no
	 * separate event type.
	 */
	deadline: async ({ request, locals }) => {
		guard(locals);

		const form = await request.formData();
		const deadline = String(form.get('deadline') ?? '').trim();

		if (deadline === '') {
			// A set naming no instant has nothing for the gate to compare, so no
			// transaction is opened for it.
			return fail(400, {
				deadlineNotice: assignmentDeadlineRefusalDetail({ kind: 'unparseable_deadline' })
			});
		}

		if (form.get('confirm') !== 'yes') {
			// The second half of the two-part act. A deadline is an appended
			// event that arms two markers, so it is never inferred from a submit.
			return fail(400, {
				deadlineNotice: assignmentDeadlineRefusalDetail({ kind: 'unconfirmed' })
			});
		}

		const actor = actorFrom(locals.session);
		if (actor === null) {
			return fail(UNBOUND_ACTOR_STATUS, {
				deadlineNotice: assignmentDeadlineRefusalDetail({ kind: 'unbound_actor' })
			});
		}

		// Read here and only here, at the transport boundary, exactly as
		// `/contract-assignment` reads it: the pure core classifies the string
		// and never sees the header.
		const deviceClass = classifyDeviceClass(request.headers.get('user-agent'));

		const outcome = await setAssignmentDeadline(writeGateway(), actor, deadline, deviceClass);

		if (outcome.kind === 'rejected') {
			const rejection = outcome.reason as AssignmentDeadlineRejection | undefined;
			return fail(statusFor(rejection?.refusal), {
				deadlineNotice:
					rejection?.detail ?? assignmentDeadlineRefusalDetail({ kind: 'unrecorded' })
			});
		}

		const appended = outcome.events[0];

		return {
			deadlineNotice:
				'The assignment deadline is set. It is an appended event, not a stored column, ' +
				'and the reminder and the deadline notice are both keyed to this instant — so ' +
				'moving it later re-arms them and neither can be sent twice for one deadline.',
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

	/** Set how far ahead of the deadline the one reminder goes. */
	interval: async ({ request, locals }) => {
		guard(locals);

		const form = await request.formData();
		const raw = String(form.get('intervalHours') ?? '').trim();

		// `Number` rather than `parseInt`: `parseInt('24h')` is 24, and an
		// interval is a whole submitted value or it is not an interval.
		const intervalHours = raw === '' ? Number.NaN : Number(raw);
		if (!Number.isFinite(intervalHours)) {
			return fail(400, {
				intervalNotice: assignmentDeadlineRefusalDetail({ kind: 'invalid_interval' })
			});
		}

		if (form.get('confirm') !== 'yes') {
			return fail(400, {
				intervalNotice: assignmentDeadlineRefusalDetail({ kind: 'unconfirmed' })
			});
		}

		const actor = actorFrom(locals.session);
		if (actor === null) {
			return fail(UNBOUND_ACTOR_STATUS, {
				intervalNotice: assignmentDeadlineRefusalDetail({ kind: 'unbound_actor' })
			});
		}

		const deviceClass = classifyDeviceClass(request.headers.get('user-agent'));

		const outcome = await setReminderInterval(writeGateway(), actor, intervalHours, deviceClass);

		if (outcome.kind === 'rejected') {
			const rejection = outcome.reason as AssignmentDeadlineRejection | undefined;
			return fail(statusFor(rejection?.refusal), {
				intervalNotice:
					rejection?.detail ?? assignmentDeadlineRefusalDetail({ kind: 'unrecorded' })
			});
		}

		const appended = outcome.events[0];

		return {
			intervalNotice:
				'The reminder interval is set. One reminder is sent for each deadline, to the ' +
				'Teams that still have Players with no contract length at that moment.',
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
