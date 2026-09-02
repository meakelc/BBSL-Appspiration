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

import { resolveDestinations } from '$lib/server/destinations.ts';
import { serverInstant } from '$lib/server/watermark.ts';

import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	return {
		phase: locals.phase,
		destinations: resolveDestinations(locals.phase.name, locals.session),
		watermark: locals.watermark,
		serverInstant: serverInstant(),
		signedIn: locals.session.kind === 'registered'
	};
};
