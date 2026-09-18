/**
 * The strip's server read: the FACTS one Team's baseline figure is derived
 * from. Server-only (Story 4.2).
 *
 * **Facts cross the wire, never derived money (AD-7).** This module returns a
 * `TeamMoneyState` — Cap Space, Roster Count, Minor League occupancy and the
 * open Auctions this Team leads — and the browser calls `evaluate()` itself.
 * Shipping a `maximumBid` field would make the transported number the check,
 * which is the one thing AD-7 forbids: a figure computed here and serialised
 * could be minutes old by the time it is read, and there would be no way to
 * tell from the value.
 *
 * **It is `loadAuctionPage`'s shape minus the Auction-specific half**, and it
 * copies that module's one-read discipline exactly: one transaction, ONE
 * `loadEventsViaClient`, and every fold taken over that single events array,
 * so the money, the leads and the eligibility partition cannot describe three
 * different moments. It takes no lock and always rolls back — rendering a
 * strip is not a write, and a report torn across a concurrent bid can only
 * ever be stale, never authoritative.
 *
 * **`fantraxPlayerId` is the probe id, not a Player.** `teamMoneyStateFor`
 * excludes the Auction being bid on from both lead lists; the baseline
 * excludes nothing, so it is handed an id no Auction can hold. That is what
 * makes the strip's figure hold this Team's own commitments against it — the
 * true answer to "what can I spend on something new" — and why the strip may
 * legitimately read lower than the Auction page's own panel.
 */

import { NO_AUCTION_PROBE_ID } from '../core/constants.ts';
import { fold } from '../core/projection/fold.ts';
import { INITIAL_AUCTIONS, auctionsReducer } from '../core/projection/auctions.ts';
import { INITIAL_CONTRACTS, contractsReducer } from '../core/projection/contracts.ts';
import { INITIAL_NOMINATIONS, nominationForPlayer, nominationsReducer } from '../core/projection/nominations.ts';
import { teamMoneyStateFor } from '../core/rules/bidding.ts';
import type { TeamMoneyState } from '../core/rules/bidding.ts';
import { loadEventsViaClient } from './event-log.ts';
import { loadTeamRoster } from './team-roster.ts';
import type { ConnectionGateway } from '../shell/write.ts';

/**
 * One Team's money facts, or `null` when they cannot be read.
 *
 * The caller is `+layout.server.ts` — the one load EVERY page inherits — so a
 * throw here would 500 every surface in the product over a strip. It does not
 * throw: an unreachable database, a missing table or a malformed row all
 * resolve to `null`, the strip does not render, and the page still does. That
 * is the I/O matrix's "Roster read fails" row, and it is the reason this
 * function catches at all.
 *
 * `null` is also the honest answer for a Team with no rows at all, except
 * that it is not: `computeCapSpace` over zero rows is exactly `SALARY_CAP`
 * with a Roster Count of 0, which is a real state the core already words. The
 * only `null` is a FAILURE, so the layout cannot mistake a Team that has
 * nothing for a read that got nothing.
 */
export async function loadStripTeam(
	gateway: ConnectionGateway,
	teamId: string
): Promise<TeamMoneyState | null> {
	let client;
	try {
		client = await gateway.connect();
	} catch {
		return null;
	}

	try {
		await client.query('begin');

		// ONE read, four folds over the same array — the discipline
		// `loadAuctionPage` sets. Eligibility is folded rather than read off
		// `free_agent_players.minor_league_eligible` for the reason
		// `server/bidding.ts` gives: the column IS the fold of those events,
		// and asking both would make two answers possible at the moment a
		// Commissioner is changing one.
		const events = await loadEventsViaClient(client);
		const auctions = fold(INITIAL_AUCTIONS, events, auctionsReducer);
		const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);
		// The contracts fold reaches the figures only through `loadTeamRoster`,
		// which counts a won Player exactly as it counts an imported roster
		// row (Story 3.4) — so a Team that has just won a Player is described
		// by the roster it now has.
		const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);

		const team = teamMoneyStateFor({
			teamId,
			// No Auction is being bid on, so nothing is excluded. See the
			// module header: this is what the baseline means.
			fantraxPlayerId: NO_AUCTION_PROBE_ID,
			...(await loadTeamRoster(client, teamId, contracts)),
			auctions,
			// The name an exposing Auction would be refused by, from the fold
			// that already holds it — the identical expression the read path
			// and the locked transaction both use. The strip prints none of
			// these names; the narrowing is one function and takes what it
			// takes rather than growing a strip-shaped variant.
			playerNameFor: (playerId) =>
				nominationForPlayer(nominations, playerId)?.playerName ?? playerId
		});

		await client.query('rollback');
		return team;
	} catch {
		// A rollback that itself fails is nothing anybody can act on, and must
		// not replace the `null` this function owes its caller.
		await client.query('rollback').catch(() => {});
		return null;
	} finally {
		client.release();
	}
}
