/**
 * The end of the Auction Phase: when the League Clock has run out, what that
 * costs, and what is appended to record it. Story 3.7, FR-22, AD-22.
 *
 * **The phase ends by falling out of the log.** Nothing here sets a flag,
 * writes a column or performs a transition. `decidePhaseEnd` returns the
 * events that, once appended, make `phaseReducer` fold to Contract Assignment
 * and `nominationsReducer` free every Slot that was still held — so the phase,
 * the freed Slots and the returned Players are all folds, and evaluating twice
 * appends nothing the second time because the first evaluation's own events
 * are in the log the second one reads.
 *
 * **Terminations FIRST, `ContractAssignmentOpened` LAST.** Both land in one
 * transaction, so no reader ever sees a partial state — but the log is read by
 * prefix forever afterwards, and a prefix ending between them would say the
 * Auction Phase is over while a Player is still on the board holding a Slot.
 * The other order says the opposite: Slots freed inside a phase that has not
 * yet ended, which is merely early rather than contradictory.
 * `ContentionDrawn`-before-`AuctionClosed` chose its order on the same ground.
 *
 * **Only a nomination with NO Auction is terminated, and the auctions fold is
 * what makes that checkable rather than assumed.** `openNominations()` answers
 * which Players hold a board seat; it does not answer which of them took a
 * Bid. A nomination whose Auction is contested but STUCK — a close that keeps
 * throwing, which `server/sweep.ts` models and retries forever — is
 * indistinguishable from an unbid one in the nominations fold alone.
 * `auctionForPlayer(...) === null` IS the definition of Awaiting Opening Bid
 * (`projection/auctions.ts`'s `contentionOf` says so in one line), so that is
 * the test, and a nomination with a live Auction is left open and untouched.
 *
 * Three answers were possible for that stuck Auction and two of them are
 * wrong. Terminating it discards a Bid the rules already accepted — a money
 * outcome, and the worst failure class NFR1 names. Refusing to end the phase
 * until it closes lets one corrupt Auction hold the entire league open
 * indefinitely, which is exactly what the sweep's per-Auction `catch` exists
 * to prevent. So the phase ends, that one nomination stays open, and the sweep
 * keeps retrying its close on every later pass — a close is not phase-gated,
 * so the rightful winner can still be awarded afterwards. That is AD-10's
 * "late, not wrong" applied to the phase boundary rather than to a single
 * Auction.
 *
 * **The actor on `ContractAssignmentOpened` is null, and null on both halves.**
 * The alternative attributes the phase end to the one person the whole epic
 * exists to keep out of it: the Audit Log would read as though a rival
 * adjudicated the close of the books, which is the exact perception AD-14's
 * commit-reveal was built to foreclose. `spec-1-5` left this open for the first
 * story to emit a system event, and `20260901000000_system_actor.sql` relaxes
 * the two columns together behind a check constraint so a half-null actor is
 * unwritable. An `AuctionTerminated` is NOT a system event and carries the
 * nominating Manager and Team off the nomination it ends.
 *
 * **`now` is injected and nothing here reads a clock** (AD-3). Every instant
 * this module compares is either an argument or a value the log already
 * carries.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { auctionForPlayer, hasExpired } from '../projection/auctions.ts';
import type { OpenAuctions } from '../projection/auctions.ts';
import type { LeagueClock } from '../projection/league-clock.ts';
import { leagueClockExpiry } from '../projection/league-clock.ts';
import {
	AUCTION_TERMINATED_EVENT,
	openNominations
} from '../projection/nominations.ts';
import type { OpenNomination, OpenNominations } from '../projection/nominations.ts';
import { CONTRACT_ASSIGNMENT_OPENED_EVENT } from '../projection/phase.ts';
import type { LeaguePhase } from '../projection/phase.ts';
import type { Accepted, EventEnvelope } from '../types.ts';

/**
 * Everything the end of the Auction Phase is decided from — four folds over
 * one read of the log, and nothing else.
 *
 * `clock` answers when the phase was due to end; `phase` answers whether it
 * already has; `nominations` answers which Players still hold a board seat;
 * and `auctions` answers which of those took a Bid. The fourth is the one that
 * is easy to leave out and cannot be: without it, "Awaiting Opening Bid" is
 * assumed from the calendar rather than derived, and a contested Auction whose
 * close keeps throwing would be terminated as though nobody had ever bid on
 * it.
 *
 * There is no roster read, no pool read and no table read of any kind: ending
 * the phase records that a clock ran out and frees the Slots that were still
 * held, and neither of those is a fact about money or a roster.
 */
export type PhaseEndState = {
	readonly clock: LeagueClock;
	readonly nominations: OpenNominations;
	readonly auctions: OpenAuctions;
	readonly phase: LeaguePhase;
};

/**
 * The `AuctionTerminated` payload: an Auction that ran out of time with
 * nobody standing to win it.
 *
 * **Two producers since Story 10.5**, and the payload is one shape for both.
 * This module appends one for every nomination still Awaiting an Opening Bid
 * when the League Clock expires — nobody ever bid. `rules/close.ts` appends
 * one for a Minimum-Bid Contention whose every Contender was cancelled by
 * FR-40's cascade — Teams did bid, and none of their joins still stands. The
 * outcome is identical in every respect a reader cares about: no winner, no
 * contract, no Nomination Slot released, and the Player in the Free Agent pool
 * by arithmetic, which is why it is this event rather than a second one
 * meaning the same thing.
 *
 * **It frees no Slot precisely because it names no winner.** Since FR-9's
 * amendment a Nomination Slot is released by winning a Player and by nothing
 * else, so a Team whose nomination expired unbid keeps the Slot it spent.
 *
 * FR-21's "written to the Audit Log" IS this event — AD-4 makes the Audit Log
 * a read of `auction_events`, not a second table — so everything a later
 * reading needs is here rather than reachable only by re-folding the
 * nomination that produced it.
 *
 * `teamId`/`teamName`/`managerId` are the NOMINATOR's, not a winner's: there
 * is no winner, which is the whole reason this event exists rather than an
 * `AuctionClosed`. They restate what the envelope carries, for
 * `AuctionClosedPayload`'s reason — a fold reads the payload and must not have
 * to reach for an envelope column.
 *
 * `expiredAt` is **whichever clock ran out** — the League Clock's own computed
 * expiry for a phase-boundary termination, the Auction's own persisted
 * `closesAt` for an emptied lottery — and never the transaction clock in
 * either case. A reader must not be told it is always the former: the two
 * producers answer "when was this due" about two different clocks, and both
 * answers are the instant the log persisted rather than the instant the sweep
 * got round to it. A tick that runs six hours late appends a byte-identical
 * payload and only the row's `occurred_at` records when it actually landed,
 * which is AD-10's "late, not wrong". `evaluatedAt` is
 * the injected `now` the expiry was compared against, so a reader can see both
 * the instant it was due and the instant it was judged at — `ExpiryGateOutcome`
 * carries the same pair for the same reason.
 *
 * No amount, no placement and no `contractYears`. A termination awards nothing
 * and charges nothing, and a payload carrying a money field would be one a
 * later reading could mistake for a close.
 */
export type AuctionTerminatedPayload = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/**
	 * The NOMINATING Team — the one that spent a Slot on this Player and, since
	 * FR-9's amendment, goes on holding it: nobody won, so nobody pays one back.
	 */
	readonly teamId: string;
	readonly teamName: string;
	/** The nominating Manager, or `null` when the nomination named none. */
	readonly managerId: string | null;
	/**
	 * The clock that ran out: the League Clock's own expiry at a phase
	 * boundary, or the Auction's own `closesAt` for an emptied lottery. Never
	 * the transaction clock.
	 */
	readonly expiredAt: string;
	/** The injected `now` that expiry was compared against. */
	readonly evaluatedAt: string;
};

/**
 * The `ContractAssignmentOpened` payload: the phase boundary, in the log.
 *
 * `terminatedPlayerIds` is the set this same decision terminated, in the order
 * it appended them, so the transition and its cost read as one fact rather
 * than as a count somebody has to reconstruct by scanning backwards. Empty is
 * an ordinary outcome, not a failure: a league where every nomination drew a
 * Bid ends its Auction Phase with this event alone.
 *
 * The two instants are `AuctionTerminatedPayload`'s two instants, for its
 * reasons.
 */
export type ContractAssignmentOpenedPayload = {
	/**
	 * The League Clock's own expiry — never the transaction clock.
	 *
	 * **Unlike `AuctionTerminatedPayload`'s field of the same name, this one
	 * has exactly one clock and always will.** A termination gained a second
	 * producer in Story 10.5 and so a second answer to "which clock ran out";
	 * a phase boundary did not. `decidePhaseEnd` is the only thing that ever
	 * appends this event, and the League Clock is the only clock a phase
	 * boundary is about.
	 */
	readonly expiredAt: string;
	/** The injected `now` that expiry was compared against. */
	readonly evaluatedAt: string;
	/** The Players terminated by this same transaction, in appended order. */
	readonly terminatedPlayerIds: readonly string[];
};

/**
 * The two instants a `ContractAssignmentOpened` carries, or `null` when the
 * payload is not one.
 *
 * `readTerminatedPlayerId`'s idiom (`projection/nominations.ts`) for
 * `readTerminatedPlayerId`'s reason: `AppendedEvent.payload` is `unknown`, an
 * insert-only log cannot be corrected in place, and a malformed historical row
 * must never crash a reader. Exported so `server/sweep.ts` can state on the
 * heartbeat WHEN the phase was due to end and when it was actually judged —
 * through the same definition of the payload the core wrote, rather than
 * through a cast that could come to disagree with it.
 *
 * Both instants or neither. They are a pair — the difference between them IS
 * how late the pass was — and one without the other says nothing an operator
 * can act on.
 */
export function readPhaseEndInstants(
	payload: unknown
): { readonly expiredAt: string; readonly evaluatedAt: string } | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const record = payload as Record<string, unknown>;
	const expiredAt = record['expiredAt'];
	const evaluatedAt = record['evaluatedAt'];
	if (typeof expiredAt !== 'string' || expiredAt === '') return null;
	if (typeof evaluatedAt !== 'string' || evaluatedAt === '') return null;
	return { expiredAt, evaluatedAt };
}

/**
 * Has the League Clock run out, as of `now`?
 *
 * **One derivation, and it is not a second one.** `leagueClockExpiry`
 * (`projection/league-clock.ts`) is the ONE place `LEAGUE_CLOCK` is added to
 * anything, and `hasExpired` (`projection/auctions.ts`) is the ONE comparison
 * of a persisted absolute instant against an injected `now` — the same one the
 * `expiry` gate refuses Bids with and the same one `decideClose` asserts
 * against. Neither is restated here, so the League Clock and the Auction Clock
 * cannot come to disagree about what "has run out" means, and there is no
 * inline `parseInstant` comparison in this file at all.
 *
 * `null` — the auction has not opened, or its origin cannot be read — is NOT
 * expired. `hasExpired` passes a null instant, and that is the right answer
 * for both cases: there is no League Clock during Setup, and a clock nobody
 * can find the start of has no expiry to have passed.
 */
export function hasLeagueClockExpired(state: PhaseEndState, now: string): boolean {
	return hasExpired(leagueClockExpiry(state.clock), now);
}

/**
 * Every open nomination that is still Awaiting an Opening Bid, in an
 * explicitly sorted order.
 *
 * **`auctionForPlayer(...) === null` IS Awaiting Opening Bid.** An entry
 * exists in `OpenAuctions` if and only if at least one `BidPlaced` was folded
 * for that Player, so "no Auction row" is the no-Bid state and
 * `projection/auctions.ts`'s `contentionOf` maps exactly that `null` to
 * `awaiting_opening_bid`. Asking the auctions fold rather than assuming from
 * the nominations fold is what keeps a contested-but-stuck Auction from being
 * terminated as though nobody had bid.
 *
 * Sorted by `fantraxPlayerId` because AD-5 requires iteration over any
 * collection that can affect an outcome to be over an explicitly sorted
 * sequence. Nothing about the outcome varies with the order — each termination
 * is independent, and the phase ends the same way whichever came first — so
 * the sort exists to make the appended `seq` order a stated property rather
 * than an incidental one inherited from object key insertion.
 */
function awaitingOpeningBid(state: PhaseEndState): readonly OpenNomination[] {
	return openNominations(state.nominations)
		.filter((nomination) => auctionForPlayer(state.auctions, nomination.fantraxPlayerId) === null)
		.slice()
		.sort((left, right) => (left.fantraxPlayerId < right.fantraxPlayerId ? -1 : 1));
}

/**
 * Decide whether the Auction Phase is over, and what that costs.
 *
 * Returns `null` for "nothing to do", which is the overwhelmingly common
 * answer and is not a refusal: there is no `Rejected` half here, because a
 * phase end is not a command anybody submitted and there is nobody to word a
 * refusal to. The tick calls this on every pass and gets `null` on almost all
 * of them.
 *
 * Two ways to `null`, and each is a state rather than a failure:
 *
 *  - **the phase is not Auction.** Already ended, or never started. This is
 *    what makes a second evaluation a no-op and therefore what makes a
 *    restart-safe tick safe: the first evaluation's own
 *    `ContractAssignmentOpened` is in the log the second one folds.
 *  - **the League Clock has not run out**, including the case where it has not
 *    started — `leagueClockExpiry` is `null` with no origin, `hasExpired`
 *    passes a null instant, and a no-op is the correct answer rather than a
 *    phase end.
 *
 * Everything below `now` is a function of the log and the injected instant.
 * Nothing already accepted is reconsidered: the expiry is compared against
 * `now` at this evaluation and no Bid, close or nomination that was accepted
 * before it is looked at again.
 */
export function decidePhaseEnd(
	state: PhaseEndState,
	now: string
): Accepted<readonly EventEnvelope[]> | null {
	// The phase gate, first, for the reason `PLACE_BID_GATES` puts its own
	// first: outside the Auction Phase there is no Auction Phase to end, and
	// what the clock says is beside the point.
	if (state.phase !== 'Auction') return null;

	// **The verdict comes from `hasLeagueClockExpired` above**, and from
	// nowhere else. Restating `leagueClockExpiry(...) + hasExpired(...)` inline
	// here would be exactly the second derivation that function's own header
	// forbids — two comparisons free to drift about what "has run out" means,
	// in one file.
	if (!hasLeagueClockExpired(state, now)) return null;

	// The instant itself, for the payloads. `hasLeagueClockExpired` answered
	// the question; this asks the ONE derivation for the value, and the
	// null-guard is what lets `expiredAt` be a `string` on the payloads below
	// rather than a nullable field every reader has to branch on. It cannot be
	// `null` here — `hasExpired` passes a null instant, so the check above
	// would already have returned.
	const expiredAt = leagueClockExpiry(state.clock);
	if (expiredAt === null) return null;

	const events: EventEnvelope[] = [];
	const terminatedPlayerIds: string[] = [];

	for (const nomination of awaitingOpeningBid(state)) {
		const payload: AuctionTerminatedPayload = {
			fantraxPlayerId: nomination.fantraxPlayerId,
			playerName: nomination.playerName,
			teamId: nomination.teamId,
			teamName: nomination.teamName,
			managerId: nomination.managerId,
			expiredAt,
			evaluatedAt: now
		};
		events.push({
			type: AUCTION_TERMINATED_EVENT,
			payload,
			// **The NOMINATOR's Manager and Team**, exactly as an `AuctionClosed`
			// carries the winner's. A termination is somebody's nomination
			// ending, not the system acting.
			//
			// The pair moves together or not at all
			// (`auction_events_actor_pair_null_together`). A nomination whose
			// payload named no Manager therefore records NEITHER — the honest
			// alternative would be a `manager_id` this event invented, and that
			// column references `managers(id)`.
			managerId: nomination.managerId,
			teamId: nomination.managerId === null ? null : nomination.teamId
		});
		terminatedPlayerIds.push(nomination.fantraxPlayerId);
	}

	const opened: ContractAssignmentOpenedPayload = {
		expiredAt,
		evaluatedAt: now,
		terminatedPlayerIds
	};
	// **LAST, after every termination.** A prefix of the log ending here says
	// the Auction Phase is over and no Player is still on the board, which is
	// the only reading of the pair that is never contradictory.
	events.push({
		type: CONTRACT_ASSIGNMENT_OPENED_EVENT,
		payload: opened,
		// **Null, and null together.** Nobody acted: a clock ran out. See this
		// module's header, and the check constraint that makes the half-null
		// alternative unwritable.
		managerId: null,
		teamId: null
	});

	return { kind: 'accepted', events };
}
