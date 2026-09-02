/**
 * Your Positions' `load` (Story 4.4).
 *
 * `requireLiveDestination` FIRST, before any read, mirroring
 * `board/+page.server.ts:50` exactly. The `your-positions` destination is live
 * for every Manager in the Auction Phase (`server/destinations.ts:73`) and in
 * no other, so a request from a phase whose catalog omits it receives the
 * guard's 403 — never a redirect, and never an empty page, which would be
 * indistinguishable from a Manager with nothing in play.
 *
 * A viewer bound to no Team is refused by the same guard for a different
 * reason: a non-registered session resolves to `[Sign-in]` alone in every
 * phase, so it never reaches the read. A registered Manager with a `null`
 * `teamId` does reach it, and `loadPositions` answers five empty groups rather
 * than rendering a group against a Team that does not exist.
 *
 * **There is no action here at all.** Your Positions is a read surface:
 * bidding happens on an Auction's own page and nominating on its own, and no
 * control on this route mutates anything.
 *
 * **The viewer's Team comes from the session and nothing else** (AD-4). It
 * decides every group, and a Team named in a query parameter would let anyone
 * read another Manager's Maximum Bid.
 */

import { requireLiveDestination } from '$lib/server/destinations.ts';
import { loadPositions } from '$lib/server/positions.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { PageServerLoad } from './$types';

const YOUR_POSITIONS_DESTINATION_ID = 'your-positions';

/**
 * The viewing Team, from the session and nothing else (AD-4).
 *
 * `board/+page.server.ts`'s `actorFrom`, verbatim in shape: `null` for any
 * session that is not a registered Manager bound to a Team.
 */
function actorFrom(session: App.Locals['session']) {
	if (session.kind !== 'registered') return null;
	const { manager } = session;
	if (manager.teamId === null) return null;
	return { managerId: manager.id, teamId: manager.teamId };
}

export const load: PageServerLoad = async ({ locals }) => {
	requireLiveDestination(locals.session, locals.phase.name, YOUR_POSITIONS_DESTINATION_ID);

	const actor = actorFrom(locals.session);
	const positions = await loadPositions(writeGateway(), actor?.teamId ?? null);

	return {
		phase: locals.phase,
		// Every word on every card is already chosen by `core/positions.ts` —
		// the surface prints them and words nothing itself.
		positions
	};
};
