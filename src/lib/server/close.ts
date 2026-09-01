/**
 * The close: one transaction appending exactly one `AuctionClosed`, and
 * releasing the nomination beside it. Server-only (Story 3.4, FR-21).
 *
 * **Nothing here is stored but the event.** The winner, the price, the Cap
 * Hit, the Slot Placement and the released Nomination Slot are all folds of
 * `auction_events` — `contractsReducer`, `nominationsReducer` and
 * `auctionsReducer` between them — so there is no `contracts` table, no
 * migration, and no write to `team_rosters` or `free_agent_players`. AD-4 puts
 * the world (imported reference data) outside the log and the auction's own
 * OUTPUT inside it, and a contract is output. FR-21's "written to the Audit
 * Log" IS the appended event: AD-4 makes the Audit Log a read of
 * `auction_events`, not a second table.
 *
 * **`closeAuction` closes ONE Auction.** There is no sweep, no cron, no Deno
 * function and no loop over overdue Auctions here — Story 3.5 owns the tick
 * and calls this once per Auction in AD-11's order, committing each close
 * before the next is evaluated. That ordering is not an optimisation to skip:
 * §10 example 17's second win lands in Active/Bench precisely because the
 * first close's effect on Minor League occupancy was committed first, and this
 * function reading the roster INSIDE its own locked transaction is what makes
 * a sequential caller see it.
 *
 * **The ONE registered projection is `releaseNomination`, unchanged.** Story
 * 2.3 shipped that delete tested and deliberately unregistered, saying in as
 * many words that 3.4 would be a one-line registration. It is. The Slot's
 * release itself is not this module's doing either way —
 * `nominationsReducer` frees it by folding the same event — and the delete
 * exists so the claim table and the log agree about a Slot that is now free.
 *
 * **A live Minimum-Bid Contention THROWS**, and that is deliberate rather
 * than unfinished. No drawer exists until Story 3.6, and the alternative —
 * closing the lottery as though whichever Team opened it had won — is exactly
 * the silently-wrong outcome AD-14 exists to prevent. Nothing calls this
 * function in production until 3.5 lands, so the throw is unreachable rather
 * than merely unhandled. It is the same AD-1 posture Story 3.3 took on a
 * missing sealed seed. Story 3.5's sweep is now the one caller, and it
 * **skips** a live Minimum-Bid Contention rather than calling this and
 * catching the throw — so the throw guards the function against a future
 * caller rather than being routinely triggered by the present one.
 *
 * **No `deviceClass`.** A close is not a user action: no browser submitted it
 * and no header describes it, so the NFR §5 measurement column stays null
 * rather than carrying an invented class.
 *
 * **A close cannot be refused**, so this function has no rejection shape at
 * all. Every failure it can reach is a bug and arrives as a thrown
 * `TypeError` out of the core (AD-1), which rolls the transaction back and
 * appends nothing.
 */

import { fold } from '../core/projection/fold.ts';
import {
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer,
	hasExpired
} from '../core/projection/auctions.ts';
import { INITIAL_CONTRACTS, contractsReducer } from '../core/projection/contracts.ts';
import {
	INITIAL_ELIGIBILITY,
	eligibilityReducer,
	isEligible
} from '../core/projection/eligibility.ts';
import {
	INITIAL_NOMINATIONS,
	nominationForPlayer,
	nominationsReducer
} from '../core/projection/nominations.ts';
import { closedWinnerFor, decideClose } from '../core/rules/close.ts';
import type { CloseState } from '../core/rules/close.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { loadEventsViaClient } from './event-log.ts';
import { releaseNomination } from './nomination.ts';
import { loadTeamRoster } from './team-roster.ts';

/**
 * Fold everything a close decides from out of ONE read of the log, then read
 * the WINNING Team's roster.
 *
 * Four folds over a single `loadEventsViaClient` read — `server/bidding.ts`'s
 * discipline: the projections cannot disagree about which events they saw,
 * because they saw the same array.
 *
 * **The roster read follows the fold, and it has to.** `minorLeagueOccupied`
 * is the WINNER's, and who won is not known until the winner is derived. So
 * `closedWinnerFor` is asked here, before the read — the same pure function
 * `decideClose` asks again inside `decide`, so the shell cannot arrive at a
 * different winner than the core does. A shell that worked the winner out for
 * itself would be a second statement of the rule, and the two could disagree
 * about the one thing a close is.
 *
 * The winner argument is `null`: no drawer exists (Story 3.6), so a live
 * Minimum-Bid Contention throws out of `closedWinnerFor` right here, inside
 * the transaction, before any roster is read and long before any event is
 * built.
 *
 * `loadTeamRoster` is handed the contracts this same fold produced, so the
 * occupancy Slot Placement is decided against already includes every Auction
 * this Team has won — which is the whole of §10 example 17.
 */
export async function loadCloseState(
	client: TransactionalClient,
	fantraxPlayerId: string
): Promise<CloseState> {
	const events = await loadEventsViaClient(client);
	const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);
	const auctions = fold(INITIAL_AUCTIONS, events, auctionsReducer);
	const eligibility = fold(INITIAL_ELIGIBILITY, events, eligibilityReducer);
	const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);

	const auction = auctionForPlayer(auctions, fantraxPlayerId);

	// Throws on no Auction, and on a live Minimum-Bid Contention with no drawn
	// winner — both bugs, both before anything is read or written (AD-1).
	const winner = closedWinnerFor(auction, null);

	const roster = await loadTeamRoster(client, winner.teamId, contracts);

	return {
		auction,
		nomination: nominationForPlayer(nominations, fantraxPlayerId),
		// The eligibility FOLD's answer, never `free_agent_players`' column —
		// `server/bidding.ts`'s reason: the column IS the fold of those events,
		// and asking the table too would make two answers possible inside one
		// transaction at the moment a Commissioner is changing it.
		playerIsMinorLeagueEligible: isEligible(eligibility, fantraxPlayerId),
		// The RAW occupancy at this close, contracts included. `M = max(0, 3 −
		// occupied)` is the core's derivation and is never computed here.
		minorLeagueOccupied: roster.minorLeagueOccupied
	};
}

/**
 * Close one Player's Auction: one transaction, one `AuctionClosed`, one
 * claim-row delete.
 *
 * **Two clocks, and which is which is the whole of AD-10's "late, not
 * wrong".** `runTransactionalWrite` reads the database's transaction-start
 * clock once (AD-3); this function uses it for exactly one thing — the shell's
 * overdue guard below — and hands the CORE the Auction's own persisted
 * `closesAt` instead (Story 3.5). Nothing `decideClose` emits varies with the
 * instant it is handed, so a sweep running six hours late appends a
 * byte-identical payload and only the row's `occurred_at` records when it
 * actually landed. That is structural rather than tested for.
 *
 * Returns the pipeline's own `WriteOutcome`, which is always `accepted` here
 * or a throw: `decideClose` has no `Rejected` half, so no rejection shape
 * exists for a caller to handle.
 */
export async function closeAuction(
	gateway: ConnectionGateway,
	fantraxPlayerId: string
): Promise<WriteOutcome> {
	return await runTransactionalWrite<CloseState>({
		gateway,
		load: (client) => loadCloseState(client, fantraxPlayerId),
		// The one-line registration Story 2.3 wrote `releaseNomination` for.
		// It goes through the `projections` hook because that is the one seam
		// that persists INSIDE the appending transaction (AD-5), so the claim
		// row and the close event commit together or neither does.
		projections: [releaseNomination],
		// No `deviceClass` is stamped on the envelope: a close is not a user
		// action, and an invented measurement value would be worse than a null
		// column.
		decide: ({ state, now }) => {
			const auction = state.auction;
			if (auction === null) {
				// Unreachable: `loadCloseState` above asks `closedWinnerFor`,
				// which throws on a null Auction before the roster is read. The
				// guard exists to give TypeScript the narrowing it cannot prove
				// through `load`'s boundary, not to handle a reachable state.
				throw new TypeError('closeAuction: no Auction was loaded to close');
			}

			// **The shell's own overdue guard, against the DATABASE clock**
			// (Story 3.5). One derivation, two call sites — the same
			// `hasExpired` the `expiry` gate refuses Bids with and the same one
			// `decideClose` asserts below — so the instant at which this
			// Auction stops taking Bids and the instant at which it may be
			// closed cannot drift apart (AD-12).
			//
			// It has to be here rather than left to the core, because the line
			// below now hands the core the Auction's OWN `closesAt` as `now`:
			// `hasExpired(closesAt, closesAt)` is `true` by definition, so the
			// core's guard can no longer tell a live Auction from an expired
			// one. This is the check that still can. Both throw, both roll the
			// transaction back with nothing appended (AD-1).
			if (!hasExpired(auction.closesAt, now.toISOString())) {
				throw new TypeError(
					`closeAuction: this Auction closes at ${JSON.stringify(auction.closesAt)} and the ` +
						`transaction clock is ${JSON.stringify(now.toISOString())}, which has not reached ` +
						'it. Closing a live Auction is the sweep’s bug — the same instant the expiry ' +
						'gate refuses Bids against (AD-12)'
				);
			}

			// **The Auction's own nominal expiry, never the transaction
			// clock.** A sweep six hours late must append the payload an
			// on-time close would have appended, byte for byte, with only
			// `occurred_at` recording when it actually landed — that is AD-10's
			// "late, not wrong", and `decideClose`'s own comment names this
			// story as the caller that supplies it.
			return decideClose(state, auction.closesAt, null);
		}
	});
}
