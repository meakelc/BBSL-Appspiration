/**
 * One destination list for every page (AD-30), and one freshness contract for
 * every page (AD-29).
 *
 * Phase and the viewer's role are already resolved once per request into
 * `locals` by `hooks.server.ts`; this load does nothing but pass them
 * through `resolveDestinations`, the single function both `HeaderMenu` here
 * and, later, the persistent strip's sheet (Story 4.2) call — there is no
 * second implementation.
 *
 * Story 4.1 adds the other two facts every page inherits: the global watermark
 * the request's fold reached, and the server instant it was answered at. They
 * ride HERE, on the one load every page inherits, rather than on the surfaces
 * that happen to need them today — so 4.2's strip, 4.3's board, 4.4's landing
 * and 4.6's index are born carrying the contract instead of retrofitting age
 * labelling onto four screens afterwards.
 *
 * **`serverInstant` is not a decorative timestamp.** It is what the browser
 * seeds `lastLivenessOkAt` from, which is why a freshly loaded page is never
 * born Stale — a page that came back from the server IS proof the server was
 * reachable, and this is that proof written down. It is also re-read on every
 * navigation and every `invalidateAll()`, so a successful reload re-anchors the
 * contract for free.
 *
 * **`signedIn` is a boolean and deliberately nothing more.** The contract must
 * not run for a visitor with no session — there are no figures to protect and
 * no controls to disable, and the liveness endpoint's `401` is indistinguishable
 * client-side from an outage, so an ungated contract would tell the sign-in page
 * that the app could not reach a server which had just answered the request that
 * rendered it. The layout needs one bit to gate on, so one bit is what crosses:
 * no manager, no team, no role. Everything else about the session stays
 * server-side where AD-15 resolves it, and every route still refuses on its own
 * (AD-30) — this bit gates a subscription, never an authorisation.
 */

import { stripPresent } from '$lib/core/strip.ts';
import { resolveDestinations } from '$lib/server/destinations.ts';
import { loadStripTeam } from '$lib/server/strip.ts';
import { serverInstant } from '$lib/server/watermark.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { LayoutServerLoad } from './$types';

/**
 * The Team the persistent strip states figures about, or `null` (Story 4.2).
 *
 * Three gates, in this order, and each rules out a state with nothing to say:
 * a visitor with no session (no figures to protect, and no server read at
 * all); a registered Manager bound to no Team, which is a real supported
 * state — a Commissioner with no Team has no Maximum Bid and no Slots; and a
 * phase in which the strip does not render, decided by the core's own
 * `stripPresent` rather than by a second phase table written here.
 *
 * The read is attempted only once all three pass, so the signed-out case
 * costs no connection.
 */
async function stripTeamFor(locals: App.Locals) {
	if (locals.session.kind !== 'registered') return null;
	const { teamId } = locals.session.manager;
	if (teamId === null) return null;
	if (!stripPresent(locals.phase.name)) return null;
	try {
		// `loadStripTeam` already answers `null` rather than throwing on any
		// read failure. The `try` covers `writeGateway()` itself, which throws
		// when `SUPABASE_DB_URL` is unset — a configuration failure rather than
		// a read one, and the matrix's requirement is the same either way: the
		// layout load must not 500 a whole page over a strip.
		return await loadStripTeam(writeGateway(), teamId);
	} catch {
		return null;
	}
}

export const load: LayoutServerLoad = async ({ locals }) => {
	return {
		phase: locals.phase,
		destinations: resolveDestinations(locals.phase.name, locals.session),
		watermark: locals.watermark,
		serverInstant: serverInstant(),
		signedIn: locals.session.kind === 'registered',
		/**
		 * FACTS only (AD-7): Cap Space, Roster Count, Minor League occupancy
		 * and the leads. No `maximumBid` field exists on anything this load
		 * serialises — the browser calls `evaluate()` itself, so the figure
		 * recomputes on every reload the freshness contract forces rather than
		 * being a transported number nobody can date.
		 */
		stripTeam: await stripTeamFor(locals)
	};
};
