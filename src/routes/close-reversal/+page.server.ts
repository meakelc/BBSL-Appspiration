/**
 * The Commissioner-only `/close-reversal` route: a gated `load` that renders
 * the reason sheet for one Close, and one `reverse` action that commits it
 * (Story 7.13, FR-32, AD-33).
 *
 * **Three guards, in order, on `load` AND on the action** — a Commissioner
 * only, this destination live for this phase and this role, and the League
 * not Archived. `/roster-drop` is the template, and hiding the Team page's
 * control is never the check: a non-Commissioner who types this URL, or
 * POSTs to it, is refused whatever rendered.
 *
 * **The Close is named by `?close=<seq>`** — the `AuctionClosed` event's own
 * log position, which is what the reversal records (AD-33). The link on the
 * won Contract's row on the Team page carries it.
 *
 * **Nothing this file decides is a rule.** Whether the Close exists, is
 * already reversed, was traded or dropped, and everything the sheet states,
 * is `decideCloseReversal`'s — rendered here from a preview, and re-derived
 * inside `recordCloseReversal`'s transaction under the global lock (AD-9).
 *
 * **The reason is validated server-side**, by `requireOverrideReason`, over
 * what was submitted. The `required` attribute on the sheet is a courtesy.
 */

import { fail } from '@sveltejs/kit';

import { classifyDeviceClass } from '$lib/core/device-class.ts';
import { closeReversalRefusalDetail } from '$lib/core/rules/close-reversal.ts';
import {
	CLOSE_REVERSAL_COMMIT_LABEL,
	closeReversalActSentence,
	closeReversalReasonRows,
	reasonSheetView
} from '$lib/reason-sheet-view.ts';
import { recordCloseReversal, previewCloseReversal } from '$lib/server/close-reversal.ts';
import type { CloseReversalRejection } from '$lib/server/close-reversal.ts';
import { requireCommissioner } from '$lib/server/commissioner-guard.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import { requireOverridablePhase, requireOverrideReason } from '$lib/server/override-guard.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { Actions, PageServerLoad } from './$types';

const CLOSE_REVERSAL_DESTINATION_ID = 'close-reversal';

/** Every guard this surface has, in one place, so `load` and the action cannot drift. */
function guard(locals: App.Locals): void {
	requireCommissioner(locals.session);
	requireLiveDestination(locals.session, locals.phase.name, CLOSE_REVERSAL_DESTINATION_ID);
	// NOT covered by the destination gate alone — `/teams` is live in
	// Archived — so the archived refusal is its own gate and its own wording.
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

/** The Close named in the query string, as the digits a `seq` is — or `''`. */
function closeSeqFrom(url: URL): string {
	const raw = url.searchParams.get('close') ?? '';
	return /^(?:0|[1-9][0-9]*)$/.test(raw) ? raw : '';
}

export const load: PageServerLoad = async ({ locals, url }) => {
	guard(locals);

	const closeSeq = closeSeqFrom(url);
	const outcome = await previewCloseReversal(writeGateway(), {
		closeSeq,
		// The sheet is a READ. The reason is typed on it and validated when it
		// posts; this placeholder never reaches a write.
		reason: 'preview'
	});

	if (outcome.kind === 'rejected') {
		return {
			phase: locals.phase,
			closeSeq,
			sheet: null,
			commitAction: null,
			// The sentence is the pure core's — the page, the tests and the
			// transaction read one wording.
			refusal: { detail: closeReversalRefusalDetail(outcome.refusal) },
			teamHref: null
		};
	}

	const decision = outcome.decision;
	const teamHref = `/teams/${encodeURIComponent(decision.contract.teamId)}`;
	return {
		phase: locals.phase,
		closeSeq,
		sheet: reasonSheetView({
			act: closeReversalActSentence(decision),
			commitLabel: CLOSE_REVERSAL_COMMIT_LABEL,
			rows: closeReversalReasonRows(decision),
			// Back to the Team page the control lives on.
			cancelHref: teamHref
		}),
		// The Close travels on the action URL rather than as a hidden field:
		// the sheet's `<form>` is `ReasonSheet.svelte`'s and carries exactly
		// one field.
		commitAction: `?/reverse&close=${closeSeq}`,
		refusal: null,
		teamHref
	};
};

export const actions: Actions = {
	reverse: async ({ request, locals, url }) => {
		guard(locals);

		const closeSeq = closeSeqFrom(url);
		const form = await request.formData();

		// **Before the write, and before anything else is decided.** A
		// reasonless override is a 400 raised here: nothing is written and no
		// transaction is opened for it.
		const reason = requireOverrideReason(form);

		const actor = actorFrom(locals.session);
		if (actor === null) {
			return fail(400, {
				notice:
					'This account is not bound to a Team, so there is no actor to record the reversal under.'
			});
		}

		const deviceClass = classifyDeviceClass(request.headers.get('user-agent'));

		const outcome = await recordCloseReversal(writeGateway(), actor, { closeSeq, reason }, deviceClass);

		if (outcome.kind === 'rejected') {
			const rejection = outcome.reason as CloseReversalRejection | undefined;
			return fail(409, { notice: rejection?.detail ?? 'The reversal was refused.' });
		}

		const appended = outcome.events[0];
		return {
			notice:
				'The Close is reversed. The Contract has left the Team, its Cap Hit has left Cap Space, and ' +
				'the Player is back in the pool. Every Bid Cancellation the Close caused stands. The entry is ' +
				'in the Audit Log with the reason, and it is announced in Discord.',
			appended:
				appended === undefined ? null : { seq: appended.seq, occurredAt: appended.occurredAt }
		};
	}
};
