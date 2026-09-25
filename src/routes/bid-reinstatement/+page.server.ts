/**
 * The Commissioner-only `/bid-reinstatement` route: a gated `load` that
 * renders the reason sheet for one Bid Cancellation, and one `reinstate`
 * action that commits it (Story 7.14, FR-32, FR-40).
 *
 * **Three guards, in order, on `load` AND on the action** — a Commissioner
 * only, this destination live for this phase and this role, and the League
 * not Archived. `/close-reversal` is the template, and hiding the Auction
 * page's control is never the check: a non-Commissioner who types this URL,
 * or POSTs to it, is refused whatever rendered.
 *
 * **The cancellation is named by `?cancellation=<seq>`** — the `BidCancelled`
 * event's own log position, which is what the reinstatement records. The link
 * on the cancelled row of the Auction page's Bid history carries it.
 *
 * **Nothing this file decides is a rule.** Whether the cancellation exists,
 * is already reinstated, was a lottery entry, whether the Auction has ended,
 * whether a fair Bid overtook it and whether the Team still passes its gates
 * is `decideBidReinstatement`'s — rendered here from a preview, and
 * re-derived inside `recordBidReinstatement`'s transaction under the global
 * lock (AD-9).
 *
 * **The reason is validated server-side**, by `requireOverrideReason`, over
 * what was submitted. The `required` attribute on the sheet is a courtesy.
 */

import { fail } from '@sveltejs/kit';

import { auctionPathFor } from '$lib/core/auction-link.ts';
import { classifyDeviceClass } from '$lib/core/device-class.ts';
import { bidReinstatementRefusalDetail } from '$lib/core/rules/bid-reinstatement.ts';
import {
	BID_REINSTATEMENT_COMMIT_LABEL,
	bidReinstatementActSentence,
	bidReinstatementReasonRows,
	reasonSheetView
} from '$lib/reason-sheet-view.ts';
import {
	previewBidReinstatement,
	recordBidReinstatement
} from '$lib/server/bid-reinstatement.ts';
import type { BidReinstatementRejection } from '$lib/server/bid-reinstatement.ts';
import { requireCommissioner } from '$lib/server/commissioner-guard.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import { requireOverridablePhase, requireOverrideReason } from '$lib/server/override-guard.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { Actions, PageServerLoad } from './$types';

const BID_REINSTATEMENT_DESTINATION_ID = 'bid-reinstatement';

/** Every guard this surface has, in one place, so `load` and the action cannot drift. */
function guard(locals: App.Locals): void {
	requireCommissioner(locals.session);
	requireLiveDestination(locals.session, locals.phase.name, BID_REINSTATEMENT_DESTINATION_ID);
	requireOverridablePhase(locals.phase.name);
}

/** The acting Commissioner, resolved from the session (AD-15) — never a form field. */
function actorFrom(session: App.Locals['session']) {
	if (session.kind !== 'registered') return null;
	const { manager } = session;
	if (manager.teamId === null) return null;
	return {
		managerId: manager.id,
		teamId: manager.teamId,
		displayName: manager.displayName
	};
}

/** The cancellation named in the query string, as the digits a `seq` is — or `''`. */
function cancellationSeqFrom(url: URL): string {
	const raw = url.searchParams.get('cancellation') ?? '';
	return /^(?:0|[1-9][0-9]*)$/.test(raw) ? raw : '';
}

export const load: PageServerLoad = async ({ locals, url }) => {
	guard(locals);

	const cancellationSeq = cancellationSeqFrom(url);
	const outcome = await previewBidReinstatement(writeGateway(), {
		cancellationSeq,
		// The sheet is a READ. The reason is typed on it and validated when it
		// posts; this placeholder never reaches a write.
		reason: 'preview'
	});

	if (outcome.kind === 'rejected') {
		return {
			phase: locals.phase,
			cancellationSeq,
			sheet: null,
			commitAction: null,
			// The sentence is the pure core's — the page, the tests and the
			// transaction read one wording.
			refusal: { detail: bidReinstatementRefusalDetail(outcome.refusal) },
			// Back to the Auction whenever the log names its Player, so a
			// refusal is never a dead end.
			auctionHref: outcome.fantraxPlayerId === null ? null : auctionPathFor(outcome.fantraxPlayerId)
		};
	}

	const decision = outcome.decision;
	const auctionHref = auctionPathFor(decision.cancellation.fantraxPlayerId);
	return {
		phase: locals.phase,
		cancellationSeq,
		sheet: reasonSheetView({
			act: bidReinstatementActSentence(decision),
			commitLabel: BID_REINSTATEMENT_COMMIT_LABEL,
			rows: bidReinstatementReasonRows(decision),
			// Back to the Auction page the control lives on.
			cancelHref: auctionHref
		}),
		// The cancellation travels on the action URL rather than as a hidden
		// field: the sheet's `<form>` is `ReasonSheet.svelte`'s and carries
		// exactly one field.
		commitAction: `?/reinstate&cancellation=${cancellationSeq}`,
		refusal: null,
		auctionHref
	};
};

export const actions: Actions = {
	reinstate: async ({ request, locals, url }) => {
		guard(locals);

		const cancellationSeq = cancellationSeqFrom(url);
		const form = await request.formData();

		// **Before the write, and before anything else is decided.** A
		// reasonless override is a 400 raised here: nothing is written and no
		// transaction is opened for it.
		const reason = requireOverrideReason(form);

		const actor = actorFrom(locals.session);
		if (actor === null) {
			return fail(400, {
				notice:
					'This account is not bound to a Team, so there is no actor to record the reinstatement under.'
			});
		}

		const deviceClass = classifyDeviceClass(request.headers.get('user-agent'));

		const outcome = await recordBidReinstatement(
			writeGateway(),
			actor,
			{ cancellationSeq, reason },
			deviceClass
		);

		if (outcome.kind === 'rejected') {
			const rejection = outcome.reason as BidReinstatementRejection | undefined;
			return fail(409, { notice: rejection?.detail ?? 'The reinstatement was refused.' });
		}

		const appended = outcome.events[0];
		return {
			notice:
				'The Bid is reinstated. It leads again with its original Auction Clock, and every Bid placed ' +
				'after the cancellation is erased. If that clock has already passed, the next tick closes the ' +
				'Auction. The entry is in the Audit Log with the reason, and it is announced in Discord.',
			appended:
				appended === undefined ? null : { seq: appended.seq, occurredAt: appended.occurredAt }
		};
	}
};
