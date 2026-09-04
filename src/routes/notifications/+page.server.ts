/**
 * The `/notifications` route: what a Manager has asked not to be mentioned on,
 * and the one action that changes it (Story 5.4, FR-27).
 *
 * **The catalog entry existed before the route did.**
 * `server/destinations.ts:81` has advertised `notification-settings` ->
 * `/notifications` in the Auction phase since Story 1.6; this is the surface it
 * points at. `requireLiveDestination` gates `load` AND the action, in that
 * order and before any read — the pattern `/minor-league-eligibility` and
 * `/positions` establish. Hiding a form is never the check.
 *
 * **THE UNMUTABLE CATEGORIES ARE REFUSED SERVER-SIDE, not merely absent from
 * the page.** A request posting `outbid`, `contract_assignment`, or an id no
 * module names, is refused with wording from
 * `core/notification-categories.ts` and writes nothing. Every sentence comes
 * from that pure module — this file words no refusal of its own, so the page,
 * the tests and the refusal all read one wording.
 *
 * **Muting suppresses the MENTION, never the post.** Nothing here touches the
 * outbox, the enqueue, or any auction write path. The preference is one row;
 * the drain reads it as a left join once per pass and withholds the `<@id>` at
 * composition time.
 *
 * The actor is resolved server-side from the session (AD-4/AD-15) and never
 * from a form field — a `managerId` in the request body would be the whole
 * vulnerability of a per-Manager setting.
 */

import { fail } from '@sveltejs/kit';

import {
	MUTABLE_NOTIFICATION_CATEGORY,
	isMutableNotificationCategory,
	isNotificationCategory,
	notificationMuteOutcomeDetail,
	notificationMuteRefusalDetail
} from '$lib/core/notification-categories.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import {
	DEFAULT_NOTIFICATION_PREFERENCES,
	loadNotificationPreferences,
	setSlotReleaseMuted
} from '$lib/server/notification-preferences.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { Actions, PageServerLoad } from './$types';

const NOTIFICATION_DESTINATION_ID = 'notification-settings';

/**
 * Read the `muted` form field: `'yes'` and `'no'`, and nothing else.
 *
 * Two direct comparisons rather than a lookup object, for
 * `/minor-league-eligibility`'s stated reason: a plain object literal inherits
 * from `Object.prototype`, so `muted=toString` would resolve to an inherited
 * member instead of `undefined` and pass an "is this a known direction?" check
 * with a Function bound as the value.
 */
function readMuted(value: FormDataEntryValue | null): boolean | undefined {
	if (value === 'yes') return true;
	if (value === 'no') return false;
	return undefined;
}

export const load: PageServerLoad = async ({ locals }) => {
	requireLiveDestination(locals.session, locals.phase.name, NOTIFICATION_DESTINATION_ID);

	// The guard above has already refused every non-registered session — the
	// catalog answers `[Sign-in]` and nothing else for one — so this narrowing
	// is the type system catching up rather than a second gate. A registered
	// Manager with no Team still has preferences: the mute is a fact about the
	// person, and `managers.team_id` is nullable.
	const session = locals.session;
	if (session.kind !== 'registered') {
		return {
			phase: locals.phase,
			slotReleaseMuted: DEFAULT_NOTIFICATION_PREFERENCES.slotReleaseMuted
		};
	}

	const preferences = await loadNotificationPreferences(writeGateway(), session.manager.id);

	return {
		phase: locals.phase,
		slotReleaseMuted: preferences.slotReleaseMuted
	};
};

export const actions: Actions = {
	mute: async ({ request, locals }) => {
		requireLiveDestination(locals.session, locals.phase.name, NOTIFICATION_DESTINATION_ID);

		const form = await request.formData();
		const category = form.get('category');
		const muted = readMuted(form.get('muted'));

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

		if (muted === undefined) {
			return fail(400, {
				notice: notificationMuteRefusalDetail({ kind: 'unstated_target' })
			});
		}

		const session = locals.session;
		if (session.kind !== 'registered') {
			// Unreachable behind the guard above, which answers `[Sign-in]` for
			// every non-registered session; kept because `requireLiveDestination`
			// returns void rather than the Manager, and a preference has to be
			// attributed to somebody to be written at all.
			return fail(400, {
				notice: notificationMuteRefusalDetail({ kind: 'unregistered_actor' })
			});
		}

		const preferences = await setSlotReleaseMuted(
			writeGateway(),
			session.manager.id,
			muted
		);

		return {
			category: MUTABLE_NOTIFICATION_CATEGORY,
			slotReleaseMuted: preferences.slotReleaseMuted,
			// Worded in the core, printed here — the page never re-words it.
			notice: notificationMuteOutcomeDetail(preferences.slotReleaseMuted)
		};
	}
};
