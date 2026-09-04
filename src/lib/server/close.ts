/**
 * The close: one transaction appending `AuctionClosed` — preceded by the
 * `ContentionDrawn` reveal when a Minimum-Bid Contention is what closed — and
 * releasing the nomination beside it. Server-only (Stories 3.4 and 3.6,
 * FR-21, AD-14).
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
 * **A Minimum-Bid Contention is DRAWN and then closed, in one transaction**
 * (Story 3.6). `loadCloseState` reads the sealed seed on this transaction's
 * own client — the only identity the seeds table grants anything — and hands
 * it with the folded Auction to `rules/draw.ts`, which verifies the published
 * commitment and derives the winner from the seed and the ordered Contender
 * list. `decideClose` then appends `ContentionDrawn` before `AuctionClosed`.
 * Story 3.5's sweep no longer skips a lottery: there is a drawer now, and a
 * lottery that throws is recorded on the heartbeat like any other failed close
 * rather than being passed over by name.
 *
 * Every failure in that chain still THROWS with nothing appended (AD-1) — a
 * missing seed, a malformed one, a commitment that does not match, an empty
 * Contender list. Closing a lottery on whichever Team happened to open it is
 * exactly the silently-wrong outcome AD-14 exists to prevent, so none of them
 * is papered over.
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
import type { CloseState, ClosedWinner } from '../core/rules/close.ts';
import { drawnWinnerFor } from '../core/rules/draw.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { readContentionSeed } from './contention-seed.ts';
import { loadEventsViaClient } from './event-log.ts';
import { releaseNomination } from './nomination.ts';
import { enqueueBroadcasts } from './outbox.ts';
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
 * **The sealed seed is read under the SAME lock that will append** (Story
 * 3.6), and only when the folded Auction is a live Minimum-Bid Contention —
 * a point read on the transaction's own client, exactly as `loadBidState`
 * reads it for a dissolution, because `20260828000000_contention_seeds.sql`
 * grants `anon`, `authenticated` and `service_role` nothing at all. Every
 * ordinary close reads it not at all.
 *
 * `drawnWinnerFor` is pure and is handed the folded `Auction` and that seed,
 * so the winner is a function of the log and the sealed value alone. A
 * Standard close derives no winner and passes `null`, which is what makes
 * `closedWinnerFor` throw if the shell and the fold ever disagree about which
 * kind of close this is.
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

	// The draw, for a lottery and for nothing else. `readContentionSeed`
	// answers `null` when the table holds no row, and `drawnWinnerFor` is what
	// says a lottery with no sealed seed cannot be closed — in the core, at the
	// rule that can name what was missing, rather than here.
	const drawnWinner: ClosedWinner | null =
		auction !== null && auction.contention === 'minimum_bid'
			? drawnWinnerFor(auction, await readContentionSeed(client, fantraxPlayerId))
			: null;

	// Throws on no Auction, on a drawn winner handed to a Standard close, and
	// on a live Minimum-Bid Contention with no drawn winner — all bugs, all
	// before the roster is read and long before anything is written (AD-1).
	const winner = closedWinnerFor(auction, drawnWinner);

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
		minorLeagueOccupied: roster.minorLeagueOccupied,
		// Carried on the state so `decide` hands the CORE the very value the
		// roster read above was keyed on. Deriving it a second time inside
		// `decide` would be a second read of a table the transaction has
		// already passed the right moment to ask.
		drawnWinner
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
		// Story 5.2 broadcasts this write: it appends the `ContentionDrawn` reveal
		// and the `AuctionClosed` that awards the Player — the two events the
		// league most needs stated out loud, and the pair that batches into one
		// post because they commit together.
		// `enqueueBroadcasts` files one channel-addressed intent per event in the
		// broadcast set. `eligibility.ts` and `import-promotion.ts` pass no
		// `enqueue` at all: Commissioner bookkeeping is not league news, and a
		// notice for it would be channel noise nothing can mute.
		enqueue: enqueueBroadcasts,
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
			// The winner `load` derived, unchanged — never re-derived here.
			// `decideClose` asks `closedWinnerFor` about it again, which is pure
			// and takes only what it is handed, so the shell and the core cannot
			// arrive at different winners (Story 3.6).
			return decideClose(state, auction.closesAt, state.drawnWinner);
		}
	});
}
