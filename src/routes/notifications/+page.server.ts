/**
 * The `/notifications` route: which notices reach a Manager, and why not one
 * of them can be turned off (Story 5.4, FR-27).
 *
 * **The catalog entry existed before the route did.**
 * `server/destinations.ts:81` has advertised `notification-settings` ->
 * `/notifications` in the Auction phase since Story 1.6; this is the surface it
 * points at. `requireLiveDestination` gates `load` AND the action, in that
 * order and before any read — the pattern `/minor-league-eligibility` and
 * `/positions` establish. Hiding a form is never the check.
 *
 * **EVERY MUTE IS REFUSED SERVER-SIDE, not merely absent from the page.** The
 * one mutable category, `slot_release`, was retired when FR-9 was amended —
 * `core/notification-categories.ts` carries that argument — so this action now
 * refuses every submission it can receive: an id no module names, and an id
 * that names one of the four categories, which are all unmutable. It writes
 * nothing on either path, and it wrote nothing on those paths before either.
 * Every sentence comes from that pure module; this file words no refusal of
 * its own, so the page, the tests and the refusal all read one wording.
 *
 * **The action is kept rather than deleted.** A form posted from a page a
 * Manager already had open, or by hand, must be answered with a stated refusal
 * rather than a 404 that leaves them guessing — and the refusal is the same
 * one the page's own prose gives.
 *
 * Nothing here touches the outbox, the enqueue, or any auction write path, and
 * nothing here reads or writes `manager_notification_preferences`: the table
 * and `server/notification-preferences.ts` are left in place, simply unread.
 */

import { fail } from '@sveltejs/kit';

import {
	isMutableNotificationCategory,
	isNotificationCategory,
	notificationMuteRefusalDetail
} from '$lib/core/notification-categories.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';

import type { Actions, PageServerLoad } from './$types';

const NOTIFICATION_DESTINATION_ID = 'notification-settings';

/**
 * **No read, because there is no preference left to render.** This used to
 * load the Manager's `slot_release` mute so the page could state which way the
 * control was set; no category is mutable, so the page is a list of categories
 * and their reasons and nothing on it varies by Manager.
 *
 * `server/notification-preferences.ts` and the table behind it are untouched
 * and unread — a stored preference is not deleted because nothing consults it.
 */
export const load: PageServerLoad = async ({ locals }) => {
	requireLiveDestination(locals.session, locals.phase.name, NOTIFICATION_DESTINATION_ID);
	return { phase: locals.phase };
};

export const actions: Actions = {
	mute: async ({ request, locals }) => {
		requireLiveDestination(locals.session, locals.phase.name, NOTIFICATION_DESTINATION_ID);

		const form = await request.formData();
		const category = form.get('category');
		// The `muted` direction is deliberately not read. It decides nothing:
		// both refusals below are about the CATEGORY, and a submission is
		// refused whichever way it asked. Reading it would only invite a
		// refusal that answered the wrong half of the request.

		// **Order matters, and this is the order.** An unknown id is answered
		// before an unmutable one, because "no such category" and "that
		// category cannot be muted" are different facts and the second would be
		// a false statement about an id the league does not have.
		if (!isNotificationCategory(category)) {
			return fail(400, {
				notice: notificationMuteRefusalDetail({
					kind: 'unknown_category',
					requested: typeof category === 'string' ? category : ''
				})
			});
		}

		if (!isMutableNotificationCategory(category)) {
			// The refusal the story's matrix names: posted directly to the
			// action, without going through the page, and refused all the same.
			return fail(400, {
				notice: notificationMuteRefusalDetail({ kind: 'unmutable_category', category })
			});
		}

		// **Unreachable, and it is the exhaustiveness rather than a real
		// branch.** The two checks above refuse every submission there is: an
		// id no module names, or one that names a category — and no category is
		// mutable. Nothing here reaches a write, which is why this action no
		// longer resolves the actor or touches
		// `server/notification-preferences.ts`. A `throw` rather than a
		// fall-through: if a category ever becomes mutable again, this is where
		// the direction and the actor have to be read, and an action that
		// quietly returned success without writing would be the worse failure.
		throw new Error(
			'notifications: a mute submission passed every refusal, but no category is mutable'
		);
	}
};
