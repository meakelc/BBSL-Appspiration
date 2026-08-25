/**
 * The Commissioner-only `/auction-open` route: a gated `load` rendering the
 * pre-open report, and one `open` action that opens the auction (Story 1.11).
 *
 * Two server-side gates, in order — `requireCommissioner` and
 * `requireLiveDestination` (this destination is live for Setup and this role)
 * — on `load` AND on the action, exactly as `/import` and
 * `/minor-league-eligibility` do. Hiding a form is never the check.
 *
 * **Nothing this file decides is a rules gate.** Two refusals are raised
 * here because neither has anything to decide about inside a transaction:
 * the missing confirmation, because an unconfirmed submit means only that
 * this request did not mean to open; and the unbound actor, because
 * `auction_events.manager_id`/`team_id` are NOT NULL (AD-4) so there is no
 * event to append. Both sentences still come from the pure core — this file
 * words no refusal of its own. Every real gate — the phase, promoted-ness,
 * and every Team's Manager — is re-derived inside `openAuction`'s
 * transaction under the global lock, so a page that rendered a ready report
 * cannot race an open past a League that has changed since.
 *
 * All writes go through `writeGateway()`, the same direct Postgres
 * connection `auction_events` writes through; the browser's own credentials
 * are never a write path.
 */

import { fail } from '@sveltejs/kit';

import { auctionOpenRefusalDetail } from '$lib/core/rules/auction-open.ts';
import { openAuction, readAuctionOpenReport } from '$lib/server/auction-open.ts';
import type { AuctionOpenRejection } from '$lib/server/auction-open.ts';
import { requireCommissioner } from '$lib/server/commissioner-guard.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { Actions, PageServerLoad } from './$types';

const AUCTION_OPEN_DESTINATION_ID = 'auction-open-gate';

export const load: PageServerLoad = async ({ locals }) => {
	requireCommissioner(locals.session);
	requireLiveDestination(locals.session, locals.phase.name, AUCTION_OPEN_DESTINATION_ID);

	const { report } = await readAuctionOpenReport(writeGateway());

	return {
		phase: locals.phase,
		// Every sentence in the report is already worded by the pure core —
		// the surface prints them and never re-words one.
		report
	};
};

export const actions: Actions = {
	open: async ({ request, locals }) => {
		requireCommissioner(locals.session);
		requireLiveDestination(locals.session, locals.phase.name, AUCTION_OPEN_DESTINATION_ID);

		const form = await request.formData();
		if (form.get('confirm') !== 'yes') {
			// Opening cannot be undone, so it is never inferred from a submit.
			// No transaction is opened for an unconfirmed request.
			return fail(400, { notice: auctionOpenRefusalDetail({ kind: 'unconfirmed' }) });
		}

		// The actor, resolved server-side from the application tables the
		// session already carries (AD-4) — never from a form field. The guard
		// above has established a registered Commissioner; the narrowing below
		// exists because `requireCommissioner` returns void rather than the
		// manager. Story 1.4 binds the Commissioner's own Team like any other
		// Manager's, so this is the unbound-row case and not a special case.
		const session = locals.session;
		if (session.kind !== 'registered' || session.manager.teamId === null) {
			return fail(400, { notice: auctionOpenRefusalDetail({ kind: 'unbound_actor' }) });
		}
		const teamId = session.manager.teamId;

		const outcome = await openAuction(writeGateway(), {
			managerId: session.manager.id,
			teamId
		});

		if (outcome.kind === 'rejected') {
			// The sentence comes from the pure core through the rejection — this
			// route never words a refusal itself, so the page, the tests and the
			// transaction all read one wording.
			const rejection = outcome.reason as AuctionOpenRejection | undefined;
			return fail(409, { notice: rejection?.detail ?? auctionOpenRefusalDetail({ kind: 'unrecorded' }) });
		}

		const appended = outcome.events[0];
		return {
			notice:
				'The auction is open. The phase is Auction, folded from the event log, and ' +
				'the League Clock runs its 48 hours from this event.',
			appended:
				appended === undefined
					? null
					: { seq: appended.seq, occurredAt: appended.occurredAt }
		};
	}
};
