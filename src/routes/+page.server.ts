/**
 * The root landing (Story 4.4).
 *
 * **Landing is Your Positions, and the test is the RESOLVER's, never a
 * hardcoded phase.** `epic-4-context.md` puts a Manager on what they lead,
 * have been outbid on and are contending in the moment they open the app, so
 * `/` redirects there — but only when `your-positions` genuinely resolves live
 * for this session's phase AND role. A `phase === 'Auction'` test would send
 * an unregistered visitor, or a Manager in Archived, straight into
 * `requireLiveDestination`'s 403: a redirect that lands on a refusal is worse
 * than no redirect at all. Asking the same resolver the guard asks makes the
 * two structurally incapable of disagreeing.
 *
 * A session for whom the destination is not live keeps this page's existing
 * behaviour exactly: the skeleton renders and states the Phase sentence from
 * `locals.phase`, the same server-resolved source the sign-in surface reads.
 * Two copies of that sentence would be two sources, and they would drift.
 *
 * `303` rather than `302`: this is a GET arriving at a location that has moved
 * for this viewer, and `303` states that the response is at another URI to be
 * fetched with GET, which is what a browser should do here regardless of how
 * it arrived.
 */

import { redirect } from '@sveltejs/kit';

import { resolveDestinations } from '$lib/server/destinations.ts';

import type { PageServerLoad } from './$types';

const YOUR_POSITIONS_DESTINATION_ID = 'your-positions';

/** The status a moved landing answers with. */
const LANDING_REDIRECT_STATUS = 303;

export const load: PageServerLoad = ({ locals }) => {
	// The destination's OWN entry, off the catalog — so the redirect's target
	// is the href the guard, the header menu and the strip's sheet all read,
	// never a literal spelled here that could fall out of step with it.
	const destination = resolveDestinations(locals.phase.name, locals.session).find(
		(entry) => entry.id === YOUR_POSITIONS_DESTINATION_ID
	);
	if (destination !== undefined) redirect(LANDING_REDIRECT_STATUS, destination.href);

	return { phase: locals.phase };
};
