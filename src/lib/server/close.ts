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
 * many words that 3.4 would be a one-line registration. It is. Neither
 * release is this module's doing — `nominationsReducer` frees both by folding
 * the same event — and the deletes exist so the claim tables and the log agree
 * about what is now free.
 *
 * On THIS path it issues two: the closed Player's board seat, and the winning
 * Team's Nomination Slot. A close is the only event that frees a Slot at all
 * (FR-9, amended), and it frees the WINNER's — very often a Slot spent
 * nominating somebody else entirely, and never the nominator's for losing.
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
import { BID_CANCELLED_EVENT } from '../core/projection/auctions.ts';
import type { OpenAuctions, Restoration } from '../core/projection/auctions.ts';
import { CONTENTION_DRAWN_EVENT } from '../core/projection/draws.ts';
import { INITIAL_CONTRACTS, contractsReducer } from '../core/projection/contracts.ts';
import {
	INITIAL_ELIGIBILITY,
	eligibilityReducer,
	isEligible
} from '../core/projection/eligibility.ts';
import {
	AUCTION_CLOSED_EVENT,
	AUCTION_TERMINATED_EVENT,
	INITIAL_NOMINATIONS,
	nominationForPlayer,
	nominationsReducer
} from '../core/projection/nominations.ts';
import { closedWinnerFor, decideClose } from '../core/rules/close.ts';
import type { CloseState, ClosedWinner } from '../core/rules/close.ts';
import { drawnWinnerFor } from '../core/rules/draw.ts';
import type { AppendedEvent } from '../core/types.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { readContentionSeed } from './contention-seed.ts';
import { loadEventsViaClient } from './event-log.ts';
import { releaseNomination } from './nomination.ts';
import { enqueueBroadcastsAndMentions } from './outbox.ts';
import { loadLeagueRosterDetail, loadTeamRoster } from './team-roster.ts';
import type { TeamRosterFigures } from './team-roster.ts';
import type { Money } from '../core/money.ts';
import { parseMoney } from '../core/money.ts';

/**
 * The Cap Space a close with no winning Team is handed (Story 10.5).
 *
 * **Not a figure about anybody.** A lottery every Contender was cancelled from
 * has no winner, so there is no Team whose Cap Space this could be — and
 * `decideClose` returns its termination pair before it reaches a placement, a
 * Cap Hit or the cascade, which are the only three things that read it. Zero
 * is what "there is nobody to describe" looks like in a `Money`, and it is
 * stated here rather than left to a query that would have to invent a Team to
 * ask about.
 */
const NO_CAP_SPACE: Money = parseMoney(0);

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

	// **No winning Team means no winner-keyed read** (Story 10.5). A lottery
	// FR-40's cascade emptied closes with nobody having won: `closedWinnerFor`
	// answers `null`, and every read below it is keyed on a Team that does not
	// exist. `loadTeamRoster` would be a query against nothing, and
	// `loadLeagueRosterDetail` answers the CASCADE — which this close does not
	// run, because nobody won and so no Team's free Slots fell.
	//
	// `decideClose` returns its `ContentionDrawn` + `AuctionTerminated` pair
	// before it reaches a placement, a Cap Hit or `cascadeFor`, so not one of
	// the winner figures below is read on this path. They are stated as the
	// zeroes they are rather than left to a second read that would describe
	// nobody.
	const roster: TeamRosterFigures | null =
		winner === null ? null : await loadTeamRoster(client, winner.teamId, contracts);

	// **A SECOND roster read, batched over every Team with a Bid** (Story
	// 10.4). The cascade's restorer judges a CANDIDATE Team — somebody other
	// than the winner — against its Cap Space, Roster Count and Minor League
	// occupancy, and there is nowhere on `CloseState` for another Team's
	// figures to come from. `loadTeamRoster` above answers for the winner
	// alone, by design: `minorLeagueOccupied` is the WINNER's and the read is
	// keyed on a Team that is not known until the winner is derived.
	//
	// One statement over many Teams rather than a query per candidate, and
	// that is the whole reason `loadLeagueRosterDetail` exists: a Close changes
	// the WINNER's roster and nobody else's, so this single read describes
	// every candidate correctly both before and after it. `cascadeFor`
	// substitutes the winner's own post-close derivation for its own row, so
	// nothing here has to model the close it is about to make.
	//
	// The set comes from the Bid history rather than from the Team table: a
	// Team with no Bid anywhere can never be a candidate, and reading the whole
	// league would grow this statement with the league rather than with the
	// close.
	const rosterFigures =
		winner === null
			? new Map<string, TeamRosterFigures>()
			: await loadLeagueRosterDetail(client, teamsWithABid(auctions), contracts);

	return {
		auction,
		nomination: nominationForPlayer(nominations, fantraxPlayerId),
		// **The whole fold, INCLUDING the Auction being closed** (Story 10.3).
		// `decideClose` drops the won Player itself, because the post-close
		// picture is the core's to derive and a shell that pre-filtered it
		// would be deciding half of FR-40 out here.
		auctions,
		// The WINNER's Cap Space and Roster Count at this close, off the same
		// `loadTeamRoster` read `minorLeagueOccupied` already came from — two
		// figures the read has always returned and this module used to
		// discard. No new query, and no second moment they could describe.
		capSpace: roster?.capSpace ?? NO_CAP_SPACE,
		rosterCount: roster?.rosterCount ?? 0,
		// The eligibility FOLD and the nominations fold, handed through as
		// `teamMoneyStateFor`'s two callbacks so the cascade's re-test
		// partitions the winner's other commitments exactly as a Bid would.
		// `isEligible` is asked per Player rather than pre-computed, for the
		// reason it is asked per Player everywhere else: the answer is a fold
		// over the whole log and the set is not enumerable from here.
		isMinorLeagueEligible: (playerId: string) => isEligible(eligibility, playerId),
		// The Player's name, with the id as the fallback every `readPayload`
		// in the core already makes.
		playerNameFor: (playerId: string) =>
			nominationForPlayer(nominations, playerId)?.playerName ?? playerId,
		// The eligibility FOLD's answer, never `free_agent_players`' column —
		// `server/bidding.ts`'s reason: the column IS the fold of those events,
		// and asking the table too would make two answers possible inside one
		// transaction at the moment a Commissioner is changing it.
		playerIsMinorLeagueEligible: isEligible(eligibility, fantraxPlayerId),
		// The RAW occupancy at this close, contracts included. `M = max(0, 3 −
		// occupied)` is the core's derivation and is never computed here.
		minorLeagueOccupied: roster?.minorLeagueOccupied ?? 0,
		// Carried on the state so `decide` hands the CORE the very value the
		// roster read above was keyed on. Deriving it a second time inside
		// `decide` would be a second read of a table the transaction has
		// already passed the right moment to ask.
		drawnWinner,
		// A plain map lookup, and `undefined` narrowed to the `null` the core
		// asks for — "a Team this read did not cover", which the restorer
		// treats as a failed candidate and walks past.
		rosterFiguresFor: (teamId: string): TeamRosterFigures | null =>
			rosterFigures.get(teamId) ?? null
	};
}

/**
 * Every Team holding a Bid anywhere in the fold, sorted and deduplicated.
 *
 * Sorted because it is the argument to a single statement whose result the
 * cascade reads (AD-5), and because a stable order makes the query text the
 * same across two closes that see the same Teams.
 *
 * CANCELLED Bids are included deliberately. `bids` keeps them — that is the
 * whole of what tells a cancellation from a void — and a Team whose Bid was
 * cancelled on one Auction can still be the next-highest survivor on another,
 * so filtering them here would drop a legitimate candidate to save nothing.
 */
function teamsWithABid(auctions: OpenAuctions): readonly string[] {
	const teamIds = new Set<string>();
	for (const playerId of Object.keys(auctions.byPlayer).sort()) {
		const auction = auctionForPlayer(auctions, playerId);
		if (auction === null) continue;
		for (const bid of auction.bids) teamIds.add(bid.teamId);
	}
	return [...teamIds].sort();
}

/** The restored Team on a `BidCancelled` payload, or `null`. Total. */
function restoredTeamId(payload: unknown): string | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const restoration = (payload as Record<string, unknown>)['restoration'];
	if (typeof restoration !== 'object' || restoration === null) return null;
	const teamId = (restoration as Partial<Restoration>)['teamId'];
	return typeof teamId === 'string' && teamId !== '' ? teamId : null;
}

/**
 * Which Teams each of a close's events affects, as `outbox.ts`'s
 * `AffectedTeamsFn` (Story 5.3).
 *
 * **Three roles, and every one of them comes off the state this transaction
 * already folded** — never off the payload, which names the WINNER and nobody
 * else:
 *
 *  - `ContentionDrawn` mentions every Contender, in the fold's own order
 *    (AD-14). They are the Teams that had money in the lottery, and the draw is
 *    the only event that can tell them how it went.
 *  - `BidCancelled` mentions the Team whose commitment was withdrawn (Story
 *    10.3, FR-40) — off the APPENDED EVENT'S OWN `team_id`, which is the one
 *    role here that does not need the state at all. `decideClose` addresses
 *    each cancellation to the Manager and Team it is about, because
 *    `auction_events.manager_id`/`team_id` are `not null` and reference real
 *    rows, so the fact is already on the row this enqueue is handed. Deriving
 *    it a second time — re-running `closedWinnerFor` over the loaded state —
 *    would be the same fact by a longer route, and a route with a throw in it:
 *    the enqueue runs INSIDE the write transaction, so it would have to be
 *    caught, and a caught throw mentions nobody. This cannot silently drop a
 *    mention, and a Manager must not be able to miss the notice telling them
 *    they lost a Player through no act of their own. The mention has no copy
 *    of its own until Story 10.6 and falls back to the plain factual line.
 *  - `AuctionClosed` mentions the Team that LED the Auction into its close —
 *    the winner, for every Standard close — and the Team whose Nomination Slot
 *    the close released, which is the nominator and is frequently somebody
 *    else. The Slot release is not an event of its own (`nominationsReducer`
 *    simply drops the key), so this close is where it is stated.
 *
 * The leader is nulled inside a Minimum-Bid Contention for `server/bidding.ts`'s
 * reason: `auctionsReducer` reports one because some Bid has to be the highest,
 * but a lottery has no Leading Bidder. The Contenders already have their
 * mention on the draw, and the drawn winner is one of them.
 *
 * A `null` state is the pre-`load` window the enqueue cannot observe; empty is
 * the safe answer there.
 */
function affectedTeamsForClose(
	event: AppendedEvent,
	state: CloseState | null
): readonly string[] {
	const eventType = event.type;
	// **Answered before the `null` guard, because it does not read the
	// state.** The appended row names the Team the cancellation is about, so
	// even the pre-`load` window the enqueue cannot observe still addresses it.
	if (eventType === BID_CANCELLED_EVENT) {
		// **Two Teams, one event** (Story 10.4). The row names the CANCELLED
		// Team; the RESTORED one is on the payload, because an
		// `auction_events` row carries one Team and this one is about the
		// cancellation. A Manager whose Bid is leading again must not miss the
		// notice telling them so — they did nothing to earn it and nothing to
		// deserve losing it either — so the restored Team is added here rather
		// than left to a fold on some later read.
		//
		// Read straight off the payload with no narrowing beyond a string
		// test: this runs INSIDE the write transaction, so a throw would have
		// to be caught and a caught throw mentions nobody.
		const cancelled = event.teamId === null ? [] : [event.teamId];
		const restored = restoredTeamId(event.payload);
		if (restored === null || cancelled.includes(restored)) return cancelled;
		return [...cancelled, restored];
	}
	if (state === null) return [];
	const auction = state.auction;

	if (eventType === CONTENTION_DRAWN_EVENT) {
		// An emptied lottery's reveal mentions nobody, and correctly so: the
		// list is empty, and the Teams that were on it were told the moment
		// their Bid was cancelled. The Manager owed a notice here is the
		// NOMINATOR, and the event that is about them is the termination
		// below (Story 10.5).
		return auction === null ? [] : auction.contenders.map((contender) => contender.teamId);
	}
	if (eventType === AUCTION_TERMINATED_EVENT) {
		// **The nominating Team, and only them** (Story 10.5). Nobody won, so
		// there is no winner to congratulate and no leader to console; the one
		// party to this event is the Manager whose Nomination Slot has just
		// come back and whose Player is in the pool again. The Team is off the
		// nominations fold, exactly as the close case reads it — the payload
		// names it too, but one derivation is what keeps the two from drifting.
		const terminatedNominator = state.nomination?.teamId ?? null;
		return terminatedNominator === null ? [] : [terminatedNominator];
	}
	if (eventType !== AUCTION_CLOSED_EVENT) return [];

	const teams: string[] = [];
	// Optional-chained exactly as `server/bidding.ts`'s `displacedTeamsFor` is,
	// and for a sharper reason: `enqueue` runs INSIDE the write transaction, so
	// a `TypeError` here would roll back an otherwise valid close over a notice.
	// Unreachable today — `decideClose` throws before this if nobody ever bid —
	// but "a Discord outage costs a notification and never a bid" has to hold
	// for the outbox's own targeting too.
	const leader =
		auction === null || auction.contention === 'minimum_bid'
			? null
			: (auction.leadingBid?.teamId ?? null);
	if (leader !== null) teams.push(leader);
	// The nominating Team, off the nominations fold — `AuctionClosedPayload`
	// names the winner and could never answer this.
	const nominator = state.nomination?.teamId ?? null;
	if (nominator !== null) teams.push(nominator);
	return teams;
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
	// The state `load` folded, captured for the enqueue — `server/bidding.ts`'s
	// note, for the same reason: who a close AFFECTS is on no payload.
	let loaded: CloseState | null = null;

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
		//
		// Story 5.3 mentions the Contenders on the draw, and the leader and the
		// nominating Team on the close — see `affectedTeamsForClose`.
		enqueue: enqueueBroadcastsAndMentions((event) => affectedTeamsForClose(event, loaded)),
		load: async (client) => {
			loaded = await loadCloseState(client, fantraxPlayerId);
			return loaded;
		},
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
			//
			// **A `null` clock takes the same throw** (Story 10.3). FR-40
			// clears `closesAt` on an Auction whose every Bid was cancelled,
			// precisely so it never closes at its old expiry with no winner —
			// `hasExpired(null, …)` is already `false`, and stating the `null`
			// here as well is what lets the core be handed a string below.
			const closesAt = auction.closesAt;
			if (closesAt === null || !hasExpired(closesAt, now.toISOString())) {
				throw new TypeError(
					`closeAuction: this Auction closes at ${JSON.stringify(closesAt)} and the ` +
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
			return decideClose(state, closesAt, state.drawnWinner);
		}
	});
}
