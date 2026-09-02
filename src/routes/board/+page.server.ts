/**
 * The Bid Board's `load` (Story 4.3).
 *
 * `requireLiveDestination` FIRST, before any read, mirroring
 * `nominate/+page.server.ts:71` and `auction/[fantraxPlayerId]/+page.server.ts:80`
 * exactly. The `bid-board` destination is live for every Manager in the
 * Auction and Archived phases (`server/destinations.ts:76,93`) and in neither
 * of the other two, so a request from a phase whose catalog omits it receives
 * the guard's 403 — never a redirect, and never an empty board, which would
 * be indistinguishable from a league with nothing nominated.
 *
 * **There is no action here at all.** The board is a read surface: bidding
 * happens on an Auction's own page, and no control on this route mutates
 * anything. There is nothing to gate a second time.
 *
 * **The viewer's Team comes from the session and nothing else** (AD-4). It
 * decides every card's viewer-relative state, and a Team named in a query
 * parameter would let anyone read the board as somebody else.
 *
 * The read goes through `writeGateway()` — the same direct Postgres
 * connection `auction_events` is folded through, which is what
 * `loadEventsViaClient` needs; the browser's own credentials are never a
 * read path for a fold (AD-9).
 */

import { loadBoard } from '$lib/server/board.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { PageServerLoad } from './$types';

const BID_BOARD_DESTINATION_ID = 'bid-board';

/**
 * The viewing Team, from the session and nothing else (AD-4).
 *
 * `null` for any session that is not a registered Manager bound to a Team —
 * a signed-out visitor, an unregistered account, a Commissioner with no Team.
 * All of them read the board in full, with every card Not involved.
 */
function actorFrom(session: App.Locals['session']) {
	if (session.kind !== 'registered') return null;
	const { manager } = session;
	if (manager.teamId === null) return null;
	return { managerId: manager.id, teamId: manager.teamId };
}

export const load: PageServerLoad = async ({ locals }) => {
	requireLiveDestination(locals.session, locals.phase.name, BID_BOARD_DESTINATION_ID);

	const actor = actorFrom(locals.session);
	const board = await loadBoard(writeGateway(), actor?.teamId ?? null);

	return {
		phase: locals.phase,
		// Every word on every card is already chosen by `core/board.ts` — the
		// surface prints them and words nothing itself.
		board
	};
};
