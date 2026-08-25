/**
 * The Commissioner-only `/minor-league-eligibility` route: a gated `load`
 * listing every pooled Player, and one `set` action that sets or unsets the
 * flag for the Players submitted (Story 1.10).
 *
 * Two server-side gates, in order — `requireCommissioner` (a Commissioner
 * only, whichever session kind) and `requireLiveDestination` (this
 * destination is live for Setup and this role) — on `load` AND on the
 * action, exactly as `/import` does. Hiding a form is never the check.
 *
 * **Nothing this file decides is a rules gate.** Three refusals are raised
 * here because none of them has anything to decide about inside a
 * transaction: an unstated direction, because which way the change was meant
 * is unknowable from the submission; an empty selection, because it names no
 * Player; and an unbound actor, because there is no event to append
 * (`auction_events.manager_id`/`team_id` are NOT NULL — AD-4). All three
 * sentences still come from the pure core — this file words no refusal of its
 * own. Every real gate — the
 * phase folded from the log, and whether each id is in the live pool — is
 * re-derived inside `setEligibility`'s transaction, so a page that rendered
 * during Setup cannot race a change past an auction that has since opened.
 *
 * All writes go through `writeGateway()`, the same direct Postgres
 * connection `auction_events` writes through; the browser's own credentials
 * are never a write path.
 */

import { fail } from '@sveltejs/kit';

import {
	eligibilityOutcomeDetail,
	eligibilityRefusalDetail
} from '$lib/core/rules/eligibility.ts';
import { requireCommissioner } from '$lib/server/commissioner-guard.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import { loadEligibilityPool, setEligibility } from '$lib/server/eligibility.ts';
import type { EligibilityRejection } from '$lib/server/eligibility.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { Actions, PageServerLoad } from './$types';

const ELIGIBILITY_DESTINATION_ID = 'minor-league-eligibility';

/**
 * Read the `eligible` form field: `'yes'` and `'no'`, and nothing else.
 *
 * Two direct comparisons rather than a lookup object. A plain object literal
 * inherits from `Object.prototype`, so `eligible=toString` (or `constructor`,
 * or `hasOwnProperty`) would resolve to an inherited member instead of
 * `undefined` — passing an "is this a known direction?" check with a Function
 * bound as the direction, which would then reach the planner and land as a
 * non-boolean `after` in an event payload that cannot be corrected in place.
 */
function readTarget(value: FormDataEntryValue | null): boolean | undefined {
	if (value === 'yes') return true;
	if (value === 'no') return false;
	return undefined;
}

export const load: PageServerLoad = async ({ locals }) => {
	requireCommissioner(locals.session);
	requireLiveDestination(locals.session, locals.phase.name, ELIGIBILITY_DESTINATION_ID);

	const pool = await loadEligibilityPool();

	return {
		phase: locals.phase,
		// Each row arrives with its consequence sentence already worded by the
		// pure core (`eligibilityRowSentence`) — the surface prints it and never
		// re-words it.
		players: pool.players
	};
};

export const actions: Actions = {
	set: async ({ request, locals }) => {
		requireCommissioner(locals.session);
		requireLiveDestination(locals.session, locals.phase.name, ELIGIBILITY_DESTINATION_ID);

		const form = await request.formData();
		const ids = form
			.getAll('ids')
			.filter((value): value is string => typeof value === 'string' && value !== '');

		const target = readTarget(form.get('eligible'));
		if (target === undefined) {
			// Neither 'yes' nor 'no' reached the server, so which direction was
			// meant is unknown. Guessing either way would write the opposite of
			// what was intended for up to the whole pool.
			return fail(400, { notice: eligibilityRefusalDetail({ kind: 'unstated_direction' }) });
		}

		if (ids.length === 0) {
			return fail(400, { notice: eligibilityRefusalDetail({ kind: 'empty_selection' }) });
		}

		// The actor, resolved server-side from the application tables the session
		// already carries (AD-4) — never from a form field. The guard above has
		// established a registered Commissioner; the narrowing below exists
		// because `requireCommissioner` returns void rather than the manager.
		const session = locals.session;
		if (session.kind !== 'registered' || session.manager.teamId === null) {
			return fail(400, { notice: eligibilityRefusalDetail({ kind: 'unbound_actor' }) });
		}
		const teamId = session.manager.teamId;

		const result = await setEligibility(
			writeGateway(),
			{ managerId: session.manager.id, teamId },
			ids,
			target
		);

		if (result.outcome.kind === 'rejected') {
			// The sentence comes from the pure core through the rejection — this
			// route never words a refusal itself, so the page, the tests and the
			// transaction all read one wording.
			const rejection = result.outcome.reason as EligibilityRejection | undefined;
			return fail(409, { notice: rejection?.detail ?? 'The change was refused.' });
		}

		const plan = result.plan;
		return {
			// Named, never counted: which Players moved and which were already at
			// the requested value, worded once in the core.
			notice:
				plan === null
					? 'The change was accepted.'
					: eligibilityOutcomeDetail(plan, target),
			// One event per changed Player, so the Commissioner can find them in
			// the Audit Log. Zero events is the correct, stated outcome of a
			// submission in which nothing changed.
			appended: result.outcome.events.map((event) => ({
				seq: event.seq,
				occurredAt: event.occurredAt
			}))
		};
	}
};
