/**
 * The verification page's `load`: a session check and nothing else
 * (Story 3.6, AD-14).
 *
 * **No new destination.** `destinations.ts`'s catalog is the phase/role
 * navigation, and this page is not a destination in it: it is reached from the
 * lottery block on an Auction page, by a Manager who is looking at a
 * commitment and wants to know what to do with it. Adding a catalog entry
 * would put "Verify" in the nav of every phase, which is not where the
 * question is asked. The two constants below are reused so a refused caller
 * gets byte-identically the same status and sentence every other refused
 * caller in this app gets.
 *
 * **Registered sessions only, and that is the whole gate.** The page states a
 * public procedure and carries no league data at all — no Auction, no Team, no
 * seed, no commitment — so there is nothing on it that varies by who is
 * looking. It is gated anyway because the league is private and every other
 * surface in it is; a page that is technically harmless to leak is still a
 * page that says the league exists.
 *
 * It returns nothing. The layout already supplies the phase and the
 * destinations; a `load` that fetched anything here would be the first league
 * fact on a page whose whole claim is that it holds none.
 */

import { error } from '@sveltejs/kit';

import {
	LIVE_DESTINATION_REFUSAL,
	LIVE_DESTINATION_REFUSAL_STATUS
} from '$lib/server/destinations.ts';

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.session.kind !== 'registered') {
		error(LIVE_DESTINATION_REFUSAL_STATUS, LIVE_DESTINATION_REFUSAL);
	}
	return {};
};
