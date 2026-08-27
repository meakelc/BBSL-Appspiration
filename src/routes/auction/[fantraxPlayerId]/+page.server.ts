/**
 * The Auction page's `load`: gate, read, 404 on no open nomination
 * (Story 2.4).
 *
 * `requireLiveDestination` first, mirroring `nominate/+page.server.ts:70-82`
 * exactly — the `auction` destination is already declared live for every
 * Manager in the Auction Phase (`destinations.ts:77`). Then the one server
 * reader, `loadAuctionPage`, reached through `writeGateway()` like every
 * other route.
 *
 * **`load` only — no `actions` export.** This story builds no bidding
 * control and no write path of any kind — the rules that would size an
 * offer do not exist yet.
 *
 * A `null` read — closed, or never nominated — is a 404 (I/O matrix), not
 * an empty page: an Auction page with nothing to show is not "the Auction",
 * it is a Player who was never put on the board.
 */

import { error } from '@sveltejs/kit';

import { requireLiveDestination } from '$lib/server/destinations.ts';
import { loadAuctionPage } from '$lib/server/auction-page.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { PageServerLoad } from './$types';

const AUCTION_DESTINATION_ID = 'auction';

export const load: PageServerLoad = async ({ locals, params }) => {
	requireLiveDestination(locals.session, locals.phase.name, AUCTION_DESTINATION_ID);

	const auction = await loadAuctionPage(writeGateway(), params.fantraxPlayerId);
	if (auction === null) {
		// Closed, or never nominated, or an id matching nothing anywhere —
		// the I/O matrix's three "not an open Auction" rows all land here,
		// as one 404 rather than three distinguishable answers that would
		// tell a prober which case they hit.
		error(404, 'There is no open Auction for this Player.');
	}

	return {
		phase: locals.phase,
		auction
	};
};
