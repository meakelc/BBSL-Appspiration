/**
 * The Auction page's `load` and its one `bid` action (Stories 2.4, 2.5).
 *
 * `requireLiveDestination` first, on the load AND on the action, mirroring
 * `nominate/+page.server.ts:70-82` exactly — the `auction` destination is
 * already declared live for every Manager in the Auction Phase
 * (`destinations.ts:77`). Hiding a form is never the check, so the action is
 * gated in its own right rather than trusting that a render preceded it.
 *
 * **The read is discriminated, and only one of its outcomes is missing.**
 * `loadAuctionPage` answers with an OPEN Auction, a CLOSED one, or `null`, and
 * this file renders the first two and refuses the third. A close used to land
 * in the null case — it deletes the nomination — and the page 404'd on an
 * Auction that had a winner, a final amount and, for a lottery, a seed and an
 * ordered Contender list somebody was owed a look at. It renders now.
 *
 * What is left in `null` is a Player with no Auction of any kind: never
 * nominated, an id matching nothing anywhere, or a `ContentionDrawn` with no
 * close behind it — a draw alone is not a closed Auction, and inventing a
 * winner from one would put a Player on a roster nothing says they are on. All
 * three arrive as ONE 404 rather than three distinguishable answers that would
 * tell a prober which case they hit.
 *
 * **Nothing this file decides is a rules gate.** Three refusals are raised
 * here because none has anything to decide about inside a transaction: the
 * unusable amount, because a field that is empty, non-numeric, negative or
 * carrying a decimal has no amount for a gate to compare; the missing
 * confirmation, because an unconfirmed submit means only that this request
 * did not mean to bid; and the unbound actor, because
 * `auction_events.manager_id`/`team_id` are NOT NULL (AD-4) so there is no
 * event to append. All three sentences still come from the pure core — this
 * file words no refusal of its own, and the amount is parsed by the core's
 * own `parseBidAmount` rather than by a second rule written here. Every real
 * gate is re-derived inside `placeBid`'s transaction under the global lock,
 * so a page that rendered a price cannot race a stale amount past the board.
 *
 * **The device class is read here and only here.** `request.headers` is a
 * transport fact; the pure core classifies the string and never sees the
 * header, and the classification rides the event envelope rather than the
 * payload so no rule can come to depend on it.
 *
 * **The viewer's Team comes from the session and nothing else** (AD-4), on
 * the load as well as the action. A Manager may bid only as themselves, and
 * the control's disabled state is decided against the same Team id the
 * submission will be attributed to.
 *
 * All writes go through `writeGateway()`, the same direct Postgres
 * connection `auction_events` writes through; the browser's own credentials
 * are never a write path (AD-9).
 */

import { error, fail } from '@sveltejs/kit';

import { classifyDeviceClass } from '$lib/core/device-class.ts';
import {
	bidPlacedNotice,
	bidRefusalDelta,
	bidRefusalDetail,
	readBidAmount
} from '$lib/core/rules/bidding.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import { loadAuctionPage } from '$lib/server/auction-page.ts';
import { placeBid } from '$lib/server/bidding.ts';
import type { BidRejection } from '$lib/server/bidding.ts';
import type { BidRefusal } from '$lib/core/rules/bidding.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { Actions, PageServerLoad } from './$types';

const AUCTION_DESTINATION_ID = 'auction';

/**
 * The acting Manager and Team, from the session and nothing else (AD-4).
 *
 * `null` for any session that is not a registered Manager bound to a Team.
 * The form field a browser could post is never consulted.
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

export const load: PageServerLoad = async ({ locals, params }) => {
	requireLiveDestination(locals.session, locals.phase.name, AUCTION_DESTINATION_ID);

	const actor = actorFrom(locals.session);
	const auction = await loadAuctionPage(
		writeGateway(),
		params.fantraxPlayerId,
		actor?.teamId ?? null
	);
	if (auction === null) {
		// Never nominated, an id matching nothing anywhere, or a draw with no
		// close behind it. The sentence no longer says "open": a closed Auction
		// has a page now, so "no OPEN Auction" would be a refusal whose reason
		// is false of the one case it still refuses.
		error(404, 'There is no Auction for this Player.');
	}

	return {
		phase: locals.phase,
		// Every sentence on the control is already worded by the pure core —
		// the surface prints them and never re-words one.
		auction
	};
};

/**
 * A refusal, shaped for the panel that renders it.
 *
 * `notice` is the one-line form for a viewer with no panel; `delta` is the
 * same wording unframed, which is what the panel's part two prints beneath
 * its headline. Both come from the core, and the second is where the first
 * gets its middle — a route that composed either itself would be a second
 * definition of what a refusal says.
 *
 * `gates` and `figuresAt` are `null` for every refusal decided before a
 * transaction opened. Those have a sentence but no arithmetic, and the panel
 * renders for them anyway: the matrix requires it on ANY refused submit, and
 * a Manager who mis-typed an amount deserves the same surface as one who
 * overran their cap.
 */
function refused(
	status: number,
	refusal: BidRefusal,
	arithmetic: { gates: unknown; figuresAt: string | null } = { gates: null, figuresAt: null }
) {
	return fail(status, {
		notice: bidRefusalDetail(refusal),
		delta: bidRefusalDelta(refusal),
		gates: arithmetic.gates,
		figuresAt: arithmetic.figuresAt
	});
}

export const actions: Actions = {
	bid: async ({ request, locals, params }) => {
		requireLiveDestination(locals.session, locals.phase.name, AUCTION_DESTINATION_ID);

		const form = await request.formData();

		// The core's own parser, so "empty, non-numeric, negative, or carrying
		// a decimal" has ONE definition — and so does the choice between the
		// two sentences those cases deserve, which is why the reading carries
		// its own refusal rather than this route picking one. No transaction is
		// opened for a request that cannot name an amount, the same reasoning
		// `nominate/+page.server.ts` applies to a submit naming no Player.
		const reading = readBidAmount(String(form.get('amount') ?? ''));
		if (reading.kind === 'unusable') {
			return refused(400, reading.refusal);
		}

		if (form.get('confirm') !== 'yes') {
			// A Bid commits the Team to the amount for as long as it leads, so
			// it is never inferred from a submit.
			return refused(400, { kind: 'unconfirmed' });
		}

		// The actor, resolved server-side from the application tables the
		// session already carries (AD-4) — never from a form field. Returned
		// as a `fail`, not thrown: an unbound Manager is a League
		// administration problem with a stated remedy, not an HTTP error.
		const actor = actorFrom(locals.session);
		if (actor === null) {
			return refused(400, { kind: 'unbound_actor' });
		}

		// Classified here, at the transport boundary. `'unknown'` is a real
		// answer and never null — a request with no `user-agent` header bids
		// normally.
		const deviceClass = classifyDeviceClass(request.headers.get('user-agent'));

		const outcome = await placeBid(
			writeGateway(),
			actor,
			params.fantraxPlayerId,
			reading.amount,
			deviceClass
		);

		if (outcome.kind === 'rejected') {
			// The sentence comes from the pure core through the rejection — this
			// route never words a refusal itself, so the disabled control, the
			// tests and the transaction all read one wording.
			const rejection = outcome.reason as BidRejection | undefined;
			// The gate set as the LOCKED TRANSACTION decided it, and the clock
			// it decided at — passed through untouched so the refusal panel
			// prints the arithmetic this Bid was actually judged against
			// (FR-13: "refused with the current figures shown"). A route that
			// recomputed them would be evaluating a state that no longer
			// exists.
			return refused(409, rejection?.refusal ?? { kind: 'unrecorded' }, {
				gates: rejection?.gates ?? null,
				figuresAt: rejection?.at ?? null
			});
		}

		const appended = outcome.events[0];

		return {
			// Composed from the core's own statement of what a Bid does, the way
			// `nominate/+page.server.ts` composes its notice from
			// `nominationConsequenceSentence`. The confirm and the outcome
			// describe the same commitment, so they are the same words.
			notice: bidPlacedNotice(),
			// `seq` and nothing else. The close instant, the event's timestamp
			// and the device class were all shipped here and rendered nowhere —
			// and the first two are already on the page, because a form action
			// re-runs `load` and the Auction Clock panel redraws from the fold.
			appended: appended === undefined ? null : { seq: appended.seq }
		};
	}
};
