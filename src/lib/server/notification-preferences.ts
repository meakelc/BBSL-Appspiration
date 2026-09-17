/**
 * One Manager's notification preferences: the read a settings page rendered
 * from, and the one upsert that changed it. Server-only (Story 5.4, FR-27).
 *
 * **NOTHING CALLS THIS ANY MORE, and the rows are kept anyway.** Story 5.4's
 * one mutable category, `slot_release`, was retired when FR-9 was amended —
 * `core/notification-categories.ts` carries that argument — so no category can
 * be muted, `/notifications` has no control to render and reads nothing here,
 * and `server/outbox.ts` dropped the LEFT JOIN that used to read the same rows
 * beside its registry read. The table, its migration and this module are left
 * standing: a Manager's stored preference is not deleted because the league
 * stopped asking, and a category that ever becomes mutable again finds both
 * the storage and the statements already here.
 *
 * **This is the SvelteKit half, and the Deno half must never import it.** That
 * held while the drain read these rows and holds now that it does not: nothing
 * reachable from `supabase/functions/tick/` may reach this module.
 *
 * **Absence is the default, not an error.** A Manager with no row reads as not
 * muted here exactly as it does in the drain's `coalesce`. `loadPreferences`
 * therefore never throws for a missing row and never writes one to create the
 * default — a Manager who has never opened this page stays absent from the
 * table until they change something.
 *
 * **`on conflict (manager_id) do update`**, `server/roster-import.ts:321` and
 * `server/pool-import.ts:245`'s idiom. The migration explains why a preference
 * is the second update-in-place table in a schema that is otherwise append-only:
 * it is the current answer to a question with no history anybody reads, and this
 * story deliberately adds no audit event for a change and no Commissioner view
 * of who has muted what.
 *
 * **No advisory lock and no transaction spanning a decision.** Nothing here
 * reads state to decide against it: the value arrives from the form, already
 * validated against `core/notification-categories.ts`, and the write is one
 * statement whose last writer wins. A Manager racing themselves across two tabs
 * gets whichever they submitted last, which is the only answer that means
 * anything.
 *
 * **The actor is resolved server-side from the session** (AD-4/AD-15) and never
 * from a form field. This module takes a `managerId` and trusts its caller to
 * have taken it from `locals.session`; the route is the one place that
 * narrowing happens.
 */

import type { ConnectionGateway } from '../shell/write.ts';
// The ONE `bool` coercion, imported rather than restated — see its own note in
// `outbox.ts`. The dependency points at the Deno-loadable module and never back.
import { isTrueFlag } from './outbox.ts';

/** What one Manager currently has muted. */
export type NotificationPreferences = {
	/**
	 * Whether the one mutable category — `core/notification-categories.ts`'s
	 * `MUTABLE_NOTIFICATION_CATEGORY` — is muted for this Manager. `false` for
	 * a Manager with no row, which is the common case.
	 */
	readonly slotReleaseMuted: boolean;
};

/** The default every Manager starts from, stated rather than implied. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
	slotReleaseMuted: false
};

const SELECT_SQL = `
	select slot_release_muted
	from manager_notification_preferences
	where manager_id = $1
`;

const UPSERT_SQL = `
	insert into manager_notification_preferences (manager_id, slot_release_muted)
	values ($1, $2)
	on conflict (manager_id) do update set
		slot_release_muted = excluded.slot_release_muted
`;

/**
 * What `managerId` currently has muted.
 *
 * Throws on a read failure rather than answering the default —
 * `server/positions.ts`'s posture, for its reason: an unreachable database and
 * a Manager who has muted nothing must never render the same screen, because
 * the second is the designed default state and the page says so out loud.
 */
export async function loadNotificationPreferences(
	gateway: ConnectionGateway,
	managerId: string
): Promise<NotificationPreferences> {
	const client = await gateway.connect();
	try {
		const result = await client.query(SELECT_SQL, [managerId]);
		const row = result.rows[0];
		// No row is the DEFAULT and not a miss to report: see the header.
		if (row === undefined) return DEFAULT_NOTIFICATION_PREFERENCES;
		return { slotReleaseMuted: isTrueFlag(row['slot_release_muted']) };
	} finally {
		// Guarded exactly as `drainOutbox`'s release is: returning a connection
		// to a pool is never news worth losing a completed read over.
		try {
			client.release();
		} catch (error) {
			console.error(
				'loadNotificationPreferences: releasing the read connection failed',
				error
			);
		}
	}
}

/**
 * Set the mute for the one mutable category, and answer what is now stored.
 *
 * The caller has already established that the category it was asked about is
 * the mutable one — that gate is `core/notification-categories.ts`'s and the
 * route's, refused with stated wording before anything reaches here. This
 * function words no refusal and takes no category: there is one column, and a
 * second mutable category would be a schema change and a product decision
 * rather than a new argument.
 */
export async function setSlotReleaseMuted(
	gateway: ConnectionGateway,
	managerId: string,
	muted: boolean
): Promise<NotificationPreferences> {
	const client = await gateway.connect();
	try {
		await client.query(UPSERT_SQL, [managerId, muted]);
		return { slotReleaseMuted: muted };
	} finally {
		try {
			client.release();
		} catch (error) {
			console.error('setSlotReleaseMuted: releasing the write connection failed', error);
		}
	}
}
