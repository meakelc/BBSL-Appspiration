/**
 * The Manager-facing `/nominate` route: a gated `load` rendering the
 * nominatable pool, and one `nominate` action that places a nomination
 * (Story 2.1).
 *
 * One server-side gate, on `load` AND on the action: `requireLiveDestination`
 * for the `nominate` destination, which `server/destinations.ts:78` registers
 * as live in the Auction Phase for every Manager. `requireCommissioner` is
 * deliberately NOT called — nominating is the ordinary Manager act this whole
 * product exists for, and the catalog entry's `commissionerOnly: false` is
 * the statement of that. Hiding a form is never the check.
 *
 * **Nothing this file decides is a rules gate.** Two refusals are raised
 * here because neither has anything to decide about inside a transaction:
 * the missing confirmation, because an unconfirmed submit means only that
 * this request did not mean to nominate; and the unbound actor, because
 * `auction_events.manager_id`/`team_id` are NOT NULL (AD-4) so there is no
 * event to append. Both sentences still come from the pure core — this file
 * words no refusal of its own. Every real gate — the phase, the Player's
 * presence in the pool, their contract, the board and the Team's Slot — is
 * re-derived inside `placeNomination`'s transaction under the global lock,
 * so a page that rendered a Player as available cannot race a second
 * nomination past them.
 *
 * **The device class is read here and only here.** `request.headers` is a
 * transport fact; the pure core classifies the string and never sees the
 * header, and the classification rides the event envelope rather than the
 * payload so no rule can come to depend on it.
 *
 * All writes go through `writeGateway()`, the same direct Postgres
 * connection `auction_events` writes through; the browser's own credentials
 * are never a write path.
 */

import { fail } from '@sveltejs/kit';

import { classifyDeviceClass } from '$lib/core/device-class.ts';
import {
	nominationConsequenceSentence,
	nominationRefusalDetail
} from '$lib/core/rules/nomination.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import { loadNominatablePool, placeNomination } from '$lib/server/nomination.ts';
import type { NominationRejection } from '$lib/server/nomination.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { Actions, PageServerLoad } from './$types';

const NOMINATE_DESTINATION_ID = 'nominate';

/**
 * The acting Team, from the session and nothing else (AD-4).
 *
 * `null` for any session that is not a registered Manager bound to a Team.
 * The form field a browser could post is never consulted — a Manager may
 * nominate only as themselves.
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

export const load: PageServerLoad = async ({ locals }) => {
	requireLiveDestination(locals.session, locals.phase.name, NOMINATE_DESTINATION_ID);

	const actor = actorFrom(locals.session);
	const pool = await loadNominatablePool(writeGateway(), actor?.teamId ?? null);

	return {
		phase: locals.phase,
		// Every sentence in the pool is already worded by the pure core — the
		// surface prints them and never re-words one.
		pool
	};
};

export const actions: Actions = {
	nominate: async ({ request, locals }) => {
		requireLiveDestination(locals.session, locals.phase.name, NOMINATE_DESTINATION_ID);

		const form = await request.formData();
		const fantraxPlayerId = String(form.get('fantraxPlayerId') ?? '');

		if (form.get('confirm') !== 'yes') {
			// A nomination holds the Team's only Slot until that Auction
			// closes, so it is never inferred from a submit. No transaction is
			// opened for an unconfirmed request.
			return fail(400, {
				notice: nominationRefusalDetail({ kind: 'unconfirmed', playerName: 'a Player' })
			});
		}

		// The actor, resolved server-side from the application tables the
		// session already carries (AD-4) — never from a form field. Returned
		// as a `fail`, not thrown: an unbound Manager is a League
		// administration problem with a stated remedy, not an HTTP error.
		const actor = actorFrom(locals.session);
		if (actor === null) {
			return fail(400, { notice: nominationRefusalDetail({ kind: 'unbound_actor' }) });
		}

		// Classified here, at the transport boundary. `'unknown'` is a real
		// answer and never null — a request with no `user-agent` header
		// nominates normally.
		const deviceClass = classifyDeviceClass(request.headers.get('user-agent'));

		const outcome = await placeNomination(writeGateway(), actor, fantraxPlayerId, deviceClass);

		if (outcome.kind === 'rejected') {
			// The sentence comes from the pure core through the rejection — this
			// route never words a refusal itself, so the page, the tests and the
			// transaction all read one wording.
			const rejection = outcome.reason as NominationRejection | undefined;
			return fail(409, {
				notice: rejection?.detail ?? nominationRefusalDetail({ kind: 'unrecorded' })
			});
		}

		const appended = outcome.events[0];
		const payload = (appended?.payload ?? null) as { playerName?: string } | null;
		const playerName = payload?.playerName ?? null;

		return {
			notice:
				`The nomination is placed. ${nominationConsequenceSentence(playerName)} ` +
				'The League Clock runs its 48 hours from this event.',
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
