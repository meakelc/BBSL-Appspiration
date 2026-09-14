/**
 * The Commissioner-only `/divergence` route: a gated `load` that states what
 * the last Fantrax read found, and one `dismiss` action (Story 7.9, FR-42).
 *
 * **Three guards, in order, on `load` AND on the action** — a Commissioner
 * only, this destination live for this phase and this role, and the League not
 * Archived. `/roster-trade` and `/roster-drop` are the template for all three
 * and this route copies them rather than inventing a fourth shape. Hiding a
 * link is never the check.
 *
 * **This route writes no Trade, no Drop and no event.** Every proposal on the
 * page is a LINK into the existing Story 7.7 or 7.8 route, pre-filled through
 * the query string those routes already read — so following one opens the real
 * act, with its own three guards and its own mandatory reason, and nothing here
 * can commit anything. The only write reachable from this file is one row in
 * `fantrax_divergence_dismissals`, which changes nothing the arithmetic
 * computes.
 *
 * **The `dismiss` action is BOTH controls**, and deliberately so: dismissing a
 * divergence and acknowledging a tripped plausibility guard are the same row
 * keyed on different content fingerprints. A guard's acknowledgement REVEALS
 * the proposals it was holding back rather than discarding them, which falls
 * out of that identity rather than needing a second path.
 *
 * **No reason sheet, and that is an argument rather than an omission.** Every
 * Epic 7 override appends an event with FR-32's mandatory reason because it
 * changes what the arithmetic computes. A dismissal does not: it says "not now"
 * about an unconfirmed reading of a third-party system and it undoes itself the
 * moment the underlying difference changes. Auction-grade ceremony on a "seen
 * it" click would put a third party's noise in the league-visible log.
 */

import { fail } from '@sveltejs/kit';

import {
	DIVERGENCE_DISMISSED_NOTICE,
	GUARD_ACKNOWLEDGED_NOTICE
} from '$lib/core/rules/divergence.ts';
import { requireCommissioner } from '$lib/server/commissioner-guard.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import { requireOverridablePhase } from '$lib/server/override-guard.ts';
import { dismissDivergence, loadDivergenceView } from '$lib/server/divergence.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { Actions, PageServerLoad } from './$types';

const DIVERGENCE_DESTINATION_ID = 'divergence';


/** Every guard this surface has, in one place, so `load` and the action cannot drift. */
function guard(locals: App.Locals): void {
	requireCommissioner(locals.session);
	requireLiveDestination(locals.session, locals.phase.name, DIVERGENCE_DESTINATION_ID);
	// NOT covered by the destination gate: `/board` and `/teams` are live in
	// Archived, so a surface reached from one of those would pass it. The
	// archived refusal is its own gate and its own wording.
	requireOverridablePhase(locals.phase.name);
}

export const load: PageServerLoad = async ({ locals }) => {
	guard(locals);

	const view = await loadDivergenceView(writeGateway());

	return {
		phase: locals.phase,
		read: view.read,
		report: view.report,
		volumeFraction: view.volumeFraction
	};
};

export const actions: Actions = {
	dismiss: async ({ request, locals }) => {
		guard(locals);

		const form = await request.formData();
		const fingerprint = form.get('fingerprint');
		if (typeof fingerprint !== 'string' || fingerprint.trim() === '') {
			return fail(400, { notice: 'That dismissal named no divergence, so nothing was dismissed.' });
		}

		// **Which of the two this row is.** The action writes one shape for both
		// — a dismissal of a divergence and an acknowledgement of a tripped guard
		// are the same row keyed on different content — but they mean OPPOSITE
		// things to the person who clicked, and one notice for both told a
		// Commissioner the thing "stays out of the way" at the exact moment the
		// proposals it was holding back became visible. The form states which,
		// and the server words it accordingly.
		const acknowledging = form.get('kind') === 'guard';

		// The actor is resolved server-side from the session (AD-15), never from
		// a form field. `dismissed_by` is audit detail and nothing reads it to
		// decide anything, so a Commissioner bound to no Team is not a refusal
		// here the way it is for an event-appending act — there is no event.
		const dismissedBy = locals.session.kind === 'registered' ? locals.session.manager.id : null;

		await dismissDivergence(writeGateway(), fingerprint.trim(), dismissedBy);

		return {
			notice: acknowledging ? GUARD_ACKNOWLEDGED_NOTICE : DIVERGENCE_DISMISSED_NOTICE
		};
	}
};
