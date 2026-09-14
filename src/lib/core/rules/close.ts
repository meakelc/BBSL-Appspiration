/**
 * Closing an Auction: who won, for how much, where the Player lands, and what
 * that charges against the Cap. Pure (Story 3.4, FR-21, AD-11, AD-23).
 *
 * **A close has no gates, and that is why it is not in `bidding.ts`.**
 * `PLACE_BID_GATES` is a fixed list of questions a Manager's command can fail;
 * a close is not a command anybody issues and there is nothing about it a rule
 * can refuse. Every failure reachable here is a BUG — no Auction, the wrong
 * winner argument for the contention state, a clock that has not run out — so
 * every one of them THROWS (AD-1) rather than returning a refusal a Manager
 * would then be shown and asked to fix. `decideClose` returns `Accepted` and
 * nothing else, and no gate set was added to `core/types.ts`.
 *
 * **The winner arrives as an argument, the way `seed` does.** 3.6 supplies a
 * drawn Contender, 3.4 supplies the Leading Bidder, and neither the shell nor
 * this module exercises judgement about which: `closedWinnerFor` reads the
 * contention state off the fold and REQUIRES the matching argument. A drawn
 * winner handed to a Standard close, or a Standard close of a live lottery,
 * are both shell bugs and both throw — the same AD-1 posture Story 3.3 took on
 * a missing sealed seed, and for the identical reason: closing a lottery as
 * though its opener had won is exactly the silently-wrong outcome AD-14 exists
 * to prevent.
 *
 * **Time is a guard, never an input.** `decideClose` reads `now` in exactly
 * one expression — `hasExpired(auction.closesAt, now)`, the SAME derivation
 * the `expiry` gate refuses Bids with (AD-12) — and nothing it emits varies
 * with it. That is what makes AD-10's "a late sweep must produce exactly the
 * outcome an on-time sweep would have" structural rather than merely tested
 * for, and it is why the payload's `closedAt` is the Auction's own persisted
 * expiry while the event's `occurredAt` stays the transaction clock: the log
 * states both when the Auction was due to close and when the system got round
 * to it, and only the first is an input to anything.
 *
 * **Slot Placement is a pure function of two facts and involves no choice by
 * anybody** — the Player's eligibility, and the winning Team's Minor League
 * occupancy at this close (FR-35). Roster Count moves only on an
 * `active_bench` placement, and that falls out of the placement value rather
 * than being a second rule; `contractRowsFor` plus
 * `server/team-roster.ts`'s one existing loop is where it falls out.
 *
 * **This module closes ONE Auction.** Story 3.5 owns the sweep and calls this
 * once per overdue Auction in AD-11's order, committing each close before the
 * next is evaluated. There is no loop here, no clock read, no randomness and
 * no notion of a set of Auctions.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { ACTIVE_BENCH_SLOTS, MINIMUM_BID, MINOR_LEAGUE_SLOTS } from '../constants.ts';
import { hash } from '../hash.ts';
import type { Money } from '../money.ts';
import { parseMoney, subtractMoney } from '../money.ts';
import type { Auction, OpenAuctions } from '../projection/auctions.ts';
import type { ContentionState } from '../projection/auctions.ts';
import {
	BID_CANCELLED_EVENT,
	auctionForPlayer,
	hasExpired,
	withBidCancelled
} from '../projection/auctions.ts';
import type { SlotPlacement } from '../projection/contracts.ts';
import { CONTENTION_DRAWN_EVENT } from '../projection/draws.ts';
import type { OpenNomination } from '../projection/nominations.ts';
import { AUCTION_CLOSED_EVENT, AUCTION_TERMINATED_EVENT } from '../projection/nominations.ts';
import type { Restoration } from '../projection/auctions.ts';
import type { Accepted, EventEnvelope, PlaceBid } from '../types.ts';
import { bidStateFor, evaluate, teamMoneyStateFor } from './bidding.ts';
import { CANCELLATION_AXES, selectRestoration } from './restore.ts';
import type { CandidateRosterFigures } from './restore.ts';
import { isSeedShaped } from './draw.ts';
// **The type is REUSED, not re-declared** (Story 10.5). `AuctionTerminated`
// already means "this Auction ended with no winner and the Player returns to
// the pool", and an emptied lottery is that outcome arrived at a second way.
// It frees no Nomination Slot in either case: since FR-9's amendment only a
// win does that, and a termination has no winner by definition. A type of its own here would be a
// second name for one fact, and `releaseNomination` and `nominationsReducer`
// would each need a third case to read it. Type-only, and `phase-end.ts`
// imports nothing from this module, so there is no cycle.
import type { AuctionTerminatedPayload } from './phase-end.ts';

/** The flat amount every Contender in a Minimum-Bid Contention holds. */
const CONTENTION_AMOUNT: Money = parseMoney(MINIMUM_BID);

/** A Minor League placement charges nothing against the Cap (AD-23). */
const NO_CAP_HIT: Money = parseMoney(0);

/**
 * How a Minimum-Bid Contention came out — the winner argument its close
 * REQUIRES, in the two shapes a lottery can end in.
 *
 * **Declared by Story 3.4 and produced since Story 3.6.** `rules/draw.ts`
 * derives a winner from the revealed seed and the ordered Contender list
 * (AD-14) and hands the result here; declaring the shape a story early meant
 * 3.6 added a drawer rather than a signature change, and meant the lottery
 * branch below was proven against state literals before a producer existed.
 * `server/close.ts` reads the sealed seed under the lock and passes the drawn
 * winner, so a live contention now closes rather than throwing.
 *
 * **Story 3.4 wrote it as a discriminated union of one so a later story could
 * add a case, and 10.5 is that story.** The case 3.6 was expected to need — a
 * single-Contender lottery — never materialised, and still does not: `seed mod
 * 1 = 0` selects the only Contender there is and the one-team list is recorded
 * exactly as the multi-team one. The case that did materialise is the
 * **empty** one. Story 10.3's cascade can cancel every join a lottery holds,
 * and 10.5 stops that clearing the contention's clock, so a lottery now
 * reaches its own expiry with nobody in it. Nobody won, so there is no Team,
 * no amount and no position to name — and that is a `kind`, not a nullable
 * winner a reading could mistake for a Standard close.
 *
 * `seed` and `contenders` were carried for 3.6's reveal and deliberately not
 * read by 3.4. **Story 3.6 reads them**: `decideClose` builds the
 * `ContentionDrawn` payload from this shape, which is why the drawer puts the
 * derivation's inputs here beside its output. `rules/draw.ts` is the one
 * producer of both cases; nothing else in the codebase constructs one.
 */
export type ClosedWinner = DrawnWinner | UndrawnLottery;

/** The Contender the seed selected, and the position it selected them at. */
export type DrawnWinner = {
	readonly kind: 'drawn';
	/** The Team the draw selected. */
	readonly teamId: string;
	/** That Team's name — carried so the payload names the winner out loud. */
	readonly teamName: string;
	/** The Manager whose joining Bid put that Team in the draw. */
	readonly managerId: string;
	/** The revealed seed the selection is reproducible from (AD-14). Story 3.6's. */
	readonly seed: string;
	/** The ordered Contender list it was applied to, ascending join `seq`. */
	readonly contenders: readonly string[];
	/**
	 * The 0-based position the reduction produced — `drawIndex`'s own return
	 * value, carried rather than recoverable.
	 *
	 * **It is carried because it cannot be re-derived honestly.** Looking the
	 * winner up in `contenders` would answer with the FIRST occurrence of that
	 * Team, which is the same number only while the list holds no duplicate —
	 * a property `contendersFor` happens to guarantee and this shape does not
	 * require of whoever builds it. This is the one number a Manager's
	 * spreadsheet produces, so it is the arithmetic's own output or it is
	 * nothing.
	 */
	readonly selectedIndex: number;
};

/**
 * A lottery that reached its expiry with nobody in it (Story 10.5, FR-40).
 *
 * Reachable one way: 10.3's cascade cancelled every Contender, and 10.5 keeps
 * the contention's own clock running through that so the outcome can be
 * recorded rather than stranded. `contendersFor` is what emptied the list —
 * one skip, in one place — and this shape is what the close is told about it.
 *
 * **It carries the seed and nothing else it does not have.** There is no Team,
 * no name, no Manager, no amount and no `selectedIndex`, because there is
 * nothing that could honestly fill them; `drawIndex` is never reached, and
 * goes on refusing a count below 1. The seed is here because it is still
 * REVEALED: a published commitment that never opens is the one outcome AD-14
 * cannot survive, and an empty Contender list does not excuse it.
 *
 * `contenders` is carried, empty, rather than omitted — the payload states the
 * list the close ran over, and "empty" is the fact being recorded.
 */
export type UndrawnLottery = {
	readonly kind: 'undrawn';
	/** The revealed seed, verified against the commitment before it got here. */
	readonly seed: string;
	/** Empty, by construction: this case exists only for an empty list. */
	readonly contenders: readonly string[];
};

/**
 * Everything a close decides from, and it really is everything.
 *
 * Four facts, gathered by the shell on ONE locked transaction so they cannot
 * disagree about the moment they describe: the Auction as `auctionsReducer`
 * folded it, the nomination that names the Player, whether the Player is
 * Minor League Eligible as `eligibilityReducer` folded it, and how many of the
 * winning Team's three Minor League Slots are occupied AT THIS CLOSE —
 * `team_rosters` plus the contracts already folded, through the one derivation
 * `server/team-roster.ts` owns.
 *
 * `auction` and `nomination` are nullable because the SHELL cannot rule
 * either out before it asks: a Player nobody bid on has a nomination and no
 * Auction, and one whose Auction already closed has neither. A null `auction`
 * is a bug at a close and THROWS — there is no winner and no price, and a
 * terminated unbid nomination is Story 3.7's, not a close's.
 *
 * A null `nomination` beside a non-null `auction` needs no throw of its own,
 * because no log this codebase can write holds one: the `no_open_auction`
 * check refuses a Bid on an unnominated Player, and a close drops the board
 * seat and the Auction together in one fold. The nomination is read for the
 * Player's NAME alone, so the unreachable case falls back to the id — the same
 * fallback every `readPayload` in the core already makes — rather than
 * standing as a fifth failure mode nothing can produce.
 *
 * `minorLeagueOccupied` is the RAW occupancy, never `M`: `max(0, 3 −
 * occupied)` is the derivation, it is clamped in `slotPlacementFor`, and a
 * Commissioner override can legitimately leave this above three. That is
 * `TeamMoneyState.minorLeagueOccupied`'s rule, restated for the same reason.
 */
export type CloseState = {
	/** The Auction as the fold holds it. `null` is "nobody bid" — a bug here. */
	readonly auction: Auction | null;
	/** The nomination naming the Player. `null` is "no Auction" — a bug here. */
	readonly nomination: OpenNomination | null;
	/** The eligibility FOLD's answer, never `free_agent_players`' column. */
	readonly playerIsMinorLeagueEligible: boolean;
	/** The WINNING Team's occupied Minor League Slots at this close. Raw. */
	readonly minorLeagueOccupied: number;
	/**
	 * Every open Auction as `auctionsReducer` folded it — INCLUDING the one
	 * being closed (Story 10.3).
	 *
	 * The cascade cannot use it raw and does not: `decideClose` drops the won
	 * Player from `byPlayer` itself, because the Auction this close is
	 * awarding is not a commitment the winner still holds. Handing the loaded
	 * snapshot to the re-test would count the win twice.
	 */
	readonly auctions: OpenAuctions;
	/**
	 * The WINNING Team's Cap Space at this close, BEFORE this close's Cap Hit
	 * — `TeamRosterFigures.capSpace`, the same read `minorLeagueOccupied`
	 * comes from. `decideClose` subtracts the Cap Hit itself.
	 */
	readonly capSpace: Money;
	/**
	 * The WINNING Team's Active/Bench Roster Count at this close, before this
	 * close's placement. `decideClose` adds the placement itself.
	 */
	readonly rosterCount: number;
	/**
	 * Whether a Player is Minor League Eligible, as the eligibility FOLD
	 * answers it — `teamMoneyStateFor`'s own callback, handed through so the
	 * re-test partitions the winner's other commitments exactly as a Bid
	 * would have.
	 */
	readonly isMinorLeagueEligible: (fantraxPlayerId: string) => boolean;
	/**
	 * What a Player is called, off the nominations fold —
	 * `teamMoneyStateFor`'s second callback. A cancellation names the Player
	 * whose commitment it withdrew, and an id is not a name.
	 */
	readonly playerNameFor: (fantraxPlayerId: string) => string;
	/**
	 * The drawn Contender, for a Minimum-Bid Contention, and `null` for every
	 * other close (Story 3.6).
	 *
	 * A FIFTH fact, and it is on the state for the same reason the other four
	 * are: the shell gathers it on the one locked transaction, from the sealed
	 * seed row read beside the log read, so the winner and the fold cannot
	 * disagree about the moment they describe. `server/close.ts` derives it
	 * through `rules/draw.ts` — pure, handed the folded `Auction` and the
	 * sealed seed — and hands the identical value to `closedWinnerFor` inside
	 * `load` and to `decideClose` inside `decide`.
	 *
	 * It is NOT a second `winner` parameter alongside `decideClose`'s own: the
	 * signature is unchanged, and this field is what `closeAuction` passes as
	 * that argument.
	 */
	readonly drawnWinner: ClosedWinner | null;
	/**
	 * The Cap and roster figures for ONE Team — any Team holding a Bid in
	 * `auctions` — or `null` for a Team the shell did not read (Story 10.4).
	 *
	 * **A SIXTH fact, and the cascade needed it the moment restoration
	 * arrived.** Everything above is about the WINNER, because until FR-40's
	 * restorer the cascade only ever asked questions about the winner: whose
	 * commitments no longer stand is a question about one Team's roster. A
	 * restoration asks it of somebody else — the candidate being handed the
	 * Auction — and there is nowhere on this shape for another Team's figures
	 * to come from.
	 *
	 * `server/close.ts` answers it from ONE batched `loadLeagueRosterDetail`
	 * over the Teams with a Bid in `auctions`, not a query per candidate: a
	 * Close changes the winner's roster and nobody else's, so every
	 * candidate's Slot occupancy and Cap Space are the same before and after
	 * it and one read describes them all. What moves under a candidate is its
	 * committed capital, and that comes from `auctions`, which the cascade is
	 * already threading.
	 *
	 * `null` is a Team the read did not cover. The restorer treats it as a
	 * failed candidate and moves down — the conservative answer, and the same
	 * one a failed gate gives.
	 */
	readonly rosterFiguresFor: (teamId: string) => CandidateRosterFigures | null;
};

/**
 * Who won and for how much — the ONE derivation of it.
 *
 * Exported because the shell needs the answer BEFORE `decide()` runs: the
 * winning Team is not known until the winner is derived, and the roster read
 * that answers `minorLeagueOccupied` is keyed on that Team. So
 * `server/close.ts` asks this inside `load`, and `decideClose` asks it again
 * inside `decide`. It is pure and takes only what it is handed, so the two
 * calls cannot disagree — and the alternative, a shell that worked the winner
 * out for itself, would be a second statement of the rule where the two could.
 *
 * **The amount by contention, and the lottery's is FLAT.** In Standard
 * Contention the Leading Bidder wins at their own amount. In a Minimum-Bid
 * Contention the drawn Contender wins at exactly `MINIMUM_BID` — never
 * `leadingBid.amount`, which is whichever Team happened to open the lottery
 * and is the same `$1,000,000` only by coincidence of the join rule. Reading
 * it off the leading Bid would be a figure that is right today and wrong the
 * moment anything about a lottery's amounts changes (FR-21).
 *
 * **`null` is an outcome and not a failure** (Story 10.5). A lottery whose
 * every Contender was cancelled reaches its expiry with nobody in it, and
 * there is no Team, no amount and no contention to close "on" anybody. The
 * absence of a party is returned as one; `decideClose` turns it into the empty
 * reveal and an `AuctionTerminated`, and `server/close.ts` reads it as "no
 * winning Team to key a roster read on". Every other route out of here is
 * either a party or a throw.
 *
 * Three throws, all of them shell bugs (AD-1):
 *
 *  - no Auction at all — nobody bid, or the Auction already closed. There is
 *    no winner and no price to invent.
 *  - a live Minimum-Bid Contention with no drawn winner. Closing it as though
 *    the opener had won is the silently-wrong outcome AD-14 exists to prevent,
 *    so the message names Story 3.6 as what is missing.
 *  - a drawn winner on a Standard close. A caller that has a drawn Contender
 *    in hand for an Auction with a Leading Bidder has confused two Auctions or
 *    two contention states, and silently overriding the Leading Bidder — or
 *    silently ignoring the draw — would be the wrong answer either way.
 */
export type ClosedParty = {
	readonly teamId: string;
	readonly teamName: string;
	readonly managerId: string;
	/** What they won at: their own Bid, or the lottery's flat `MINIMUM_BID`. */
	readonly winningAmount: Money;
	/** The contention this Auction closed out of, as the fold holds it. */
	readonly contention: ContentionState;
};

export function closedWinnerFor(
	auction: Auction | null,
	winner: ClosedWinner | null
): ClosedParty | null {
	if (auction === null) {
		throw new TypeError(
			'closeAuction: there is no Auction to close — no Bid was ever placed on this Player, or ' +
				'their Auction has already closed. A nominated Player nobody bid on is terminated by ' +
				'Story 3.7, not closed (AD-1)'
		);
	}

	if (auction.contention === 'minimum_bid') {
		if (winner === null) {
			throw new TypeError(
				'closeAuction: a Minimum-Bid Contention closes on the DRAWN Contender and no drawn ' +
					'winner was supplied; received null. The caller must derive one with ' +
					'drawnWinnerFor() from the sealed seed before closing. Closing it on the Leading ' +
					'Bidder would award the Auction to whichever Team happened to open the lottery ' +
					'(AD-14)'
			);
		}
		// **A lottery nobody is left in has no party, and that is an OUTCOME
		// rather than a throw** (Story 10.5). There is no Team to name, no
		// price to name it at and no contention to close "on" anybody — so the
		// answer is the absence of a party, stated as one. `decideClose` reads
		// the same `undrawn` winner and emits the empty reveal plus an
		// `AuctionTerminated`; `server/close.ts` reads this `null` and skips
		// the winner-keyed roster reads it has nothing to key on.
		if (winner.kind === 'undrawn') return null;
		// **The winner is validated HERE, at the rule that can name the field**
		// (Story 3.6). `auction_events.manager_id` and `.team_id` are
		// `not null` and reference real rows, so a `ClosedWinner` with an empty
		// identity would otherwise fail at the foreign key — at the insert,
		// with a driver's message, after the roster read and the whole close
		// had been computed. `rules/draw.ts` checks the same three fields on
		// the Contender it selects; this is the guard for a winner that
		// arrived from anywhere else, which is the case a shell bug is.
		for (const [field, value] of [
			['teamId', winner.teamId],
			['teamName', winner.teamName],
			['managerId', winner.managerId]
		] as const) {
			if (value === '') {
				throw new TypeError(
					`closeAuction: the drawn winner carries an empty "${field}", and a close names all ` +
						'three of teamId, teamName and managerId (AD-1)'
				);
			}
		}
		return {
			teamId: winner.teamId,
			teamName: winner.teamName,
			managerId: winner.managerId,
			// The FLAT amount every Contender held, never the leading Bid's:
			// any Contender may win and they all committed the same figure.
			winningAmount: CONTENTION_AMOUNT,
			contention: auction.contention
		};
	}

	if (winner !== null) {
		throw new TypeError(
			`closeAuction: a "${auction.contention}" Auction closes on its Leading Bidder and takes no ` +
				`drawn winner; received a "${winner.kind}" one` +
				(winner.kind === 'drawn' ? ` naming team "${winner.teamId}"` : '') +
				' (AD-1)'
		);
	}

	// Every contention that is not a lottery closes on the leader — and since
	// Story 10.3 an Auction that exists may not have one. FR-40 withdraws a
	// cancelled Bid's standing while keeping it in the history, so a
	// LEADERLESS Auction is now a real folded state, and `Auction.leadingBid`
	// is nullable to say so.
	//
	// **It is a fourth throw and not a fifth outcome** (AD-1). A leaderless
	// Auction has no winner and no price, exactly as one nobody bid on has
	// none, and inventing either would award a Player on a Bid that no longer
	// stands.
	//
	// **How reachable it is depends on whether anything survived, and until
	// Story 10.4 lands one case reaches it every pass.** Cancelling the last
	// Bid on an Auction clears its `closesAt` too, so `overdueAuctions` never
	// offers that one to a close at all. Cancelling a LEADER with lower Bids
	// still standing deliberately does not clear the clock — a cancellation
	// resets nothing — so the sweep does keep offering it, and this throw is
	// what it meets: recorded as one Auction's failure, which `runTick`
	// isolates from the rest of the pass, rather than a Player awarded on a
	// withdrawn Bid. Story 10.4 closes that window by appending the
	// restoration inside the very transaction the cancellation commits in, at
	// which point the Auction has a leader again before any close sees it.
	const leadingBid = auction.leadingBid;
	if (leadingBid === null) {
		throw new TypeError(
			'closeAuction: this Auction has no Leading Bidder — every Bid on it was cancelled, or its ' +
				'leader was and nothing has been restored in its place. A leaderless Auction has no ' +
				'winner and no price to invent, and its Auction Clock is cleared precisely so no close ' +
				'is attempted at the old expiry (FR-40, AD-1)'
		);
	}

	return {
		teamId: leadingBid.teamId,
		teamName: leadingBid.teamName,
		managerId: leadingBid.managerId,
		winningAmount: leadingBid.amount,
		contention: auction.contention
	};
}

/**
 * Where the won Player lands (FR-21, FR-35) — eligibility first, occupancy
 * second, and no choice by anybody in either.
 *
 * A Player who is not Minor League Eligible takes an Active/Bench Slot
 * whatever the Team's minors look like: eligibility is the FIRST test, so a
 * Team with three empty Minor League Slots still places an ineligible Player
 * in Active/Bench. An eligible Player takes a free Minor League Slot if one
 * exists and Active/Bench otherwise — which is §10 example 17's overflow, and
 * the reason AD-11 requires each close to be committed before the next is
 * evaluated.
 *
 * `M = max(0, 3 − occupied)` is CLAMPED, `minorsCountsFor`'s clamp for
 * `minorsCountsFor`'s reason: a Commissioner override can leave a Team with
 * four occupied Minor League Slots, and an unclamped `M` would go negative and
 * then read as "a Slot is free".
 */
export function slotPlacementFor(
	playerIsMinorLeagueEligible: boolean,
	minorLeagueOccupied: number
): SlotPlacement {
	if (!playerIsMinorLeagueEligible) return 'active_bench';
	const freeMinorLeagueSlots = Math.max(0, MINOR_LEAGUE_SLOTS - minorLeagueOccupied);
	return freeMinorLeagueSlots > 0 ? 'minor_league' : 'active_bench';
}

/**
 * What the contract charges against the Cap — `$0` on a Minor League
 * placement, the winning amount on an Active/Bench one (AD-23, FR-21).
 *
 * **Two fields, one of which is computed here and one of which is not.** This
 * function takes the winning amount and returns the Cap Hit; nothing anywhere
 * runs it the other way, and no expression derives either from the other by
 * assuming equality. On a Minor League placement the winning amount STANDS
 * UNCHANGED at whatever was bid — §10 example 16 wins at $4,000,000 and
 * charges $0 — which is the whole of what AD-23 exists to keep true through
 * the Cap arithmetic and the Fantrax export alike.
 *
 * A separate function from `slotPlacementFor` rather than one that returns
 * both, because the Cap rule is stated once here and read a second time by
 * `computeCapSpace`, which zeroes a `minor_league` row on its own terms. Two
 * statements of one rule that agree because they are the same rule; a single
 * function returning a pair would hide that the Cap arithmetic re-checks it.
 */
export function capHitFor(placement: SlotPlacement, winningAmount: Money): Money {
	return placement === 'minor_league' ? NO_CAP_HIT : winningAmount;
}

/**
 * The `AuctionClosed` payload: the whole outcome of a close, in the log.
 *
 * FR-21's "written to the Audit Log" IS this event — AD-4 makes the Audit Log
 * a read of `auction_events`, not a second table — so everything a later
 * reading needs is here rather than reachable only by re-folding the Auction
 * that produced it.
 *
 * `winningAmount` and `capHit` are TWO PERSISTED FIELDS (AD-23). They are
 * computed separately, by two functions above, and no consumer may derive one
 * from the other.
 *
 * `closedAt` is the Auction's own persisted `closesAt` — its NOMINAL expiry —
 * and never the transaction clock. The envelope's `occurredAt` states when the
 * close was recorded; a sweep that runs six hours late produces a
 * byte-identical payload with a later `occurredAt`, which is exactly the
 * distinction AD-10 and AD-12 draw between "late" and "wrong".
 *
 * `contractYears` is `null` and typed `null`: FR-21 records contract length
 * UNSET at a close and Epic 6 assigns it, so this states the absence rather
 * than carrying a placeholder length.
 *
 * `managerId` and `teamId` restate what the envelope already carries, for
 * `NominationPlacedPayload`'s reason: `contractsReducer` folds the PAYLOAD and
 * must not have to reach for an envelope column to know who owns the contract.
 * They are the WINNER's — `auction_events.manager_id`/`team_id` are `not null`
 * and reference real rows, and a close needs no synthetic actor.
 */
export type AuctionClosedPayload = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly teamId: string;
	readonly teamName: string;
	readonly managerId: string;
	/** What the Player was won for. Unchanged by the placement (AD-23). */
	readonly winningAmount: number;
	/** What that charges against the Cap. `0` on a minors placement (AD-23). */
	readonly capHit: number;
	readonly placement: SlotPlacement;
	/** Which contention the Auction closed out of. */
	readonly contention: ContentionState;
	/** Recorded UNSET at a close (FR-21). Epic 6 assigns it. */
	readonly contractYears: null;
	/** The Auction's own persisted expiry — never the transaction clock. */
	readonly closedAt: string;
};

/**
 * The `ContentionDrawn` payload: the reveal, the list and the selection
 * (Story 3.6, FR-19, AD-14).
 *
 * **A second event rather than fields on `AuctionClosed`, and Story 3.4 said
 * why before it existed**: putting a seed on the close would publish half of a
 * commit-reveal 3.4 did not own. `ContentionDissolved` already carries the
 * other exit from this same state with the same four facts, so a
 * `ContentionDrawn` beside it means the two exits from a Minimum-Bid
 * Contention are read the same way — and `AuctionClosed`'s three existing
 * folds need no change at all.
 *
 * Appended FIRST, before the `AuctionClosed` it causes, in one transaction.
 * Cause then consequence: a log read in `seq` order states the draw that
 * selected the winner before it states the close that awarded them the Player.
 *
 * `seedHash` is restated here rather than left to be looked up on the opening
 * `BidPlaced` — `ContentionDissolvedPayload`'s reason: the reveal and the
 * commitment it answers belong in one event, so a Manager checking the pair
 * reads one row rather than joining two, and `null` states honestly that there
 * was nothing to check against.
 *
 * `contenders` is the fold's own list in the fold's own order, ascending join
 * `seq` — ids, unfiltered, exactly as the draw ran over them. AD-14 makes that
 * order an INPUT to the winner, so a list recorded in any other order would be
 * a list nobody could check the draw against.
 *
 * **Two shapes since Story 10.5**, because a lottery has two outcomes. A draw
 * that selected somebody records the list, the position and the winner. A
 * lottery every Contender was cancelled from records the list — empty — and
 * the revealed seed, and states the winner fields by their absence rather than
 * inventing values for them. The reveal is appended either way; what follows
 * it is an `AuctionClosed` in the first case and an `AuctionTerminated` in the
 * second.
 */
export type ContentionDrawnPayload = DrawnContentionPayload | UndrawnContentionPayload;

/**
 * What both shapes state: which Player, what was revealed, what it was
 * published against, the list it ran over and when the Auction was due.
 */
type ContentionDrawnFacts = {
	readonly fantraxPlayerId: string;
	/** The seed, revealed. The one place a drawn seed enters `auction_events`. */
	readonly seed: string;
	/** The commitment it was published against, or `null` if none ever was. */
	readonly seedHash: string | null;
	/** The Contender list the draw ran over, ascending join `seq` — ids. */
	readonly contenders: readonly string[];
	/** The Auction's own persisted expiry — never the transaction clock. */
	readonly drawnAt: string;
};

/** A lottery somebody was drawn from: the list, the position, the winner. */
export type DrawnContentionPayload = ContentionDrawnFacts & {
	/**
	 * The 0-based position the reduction produced.
	 *
	 * Redundant with `contenders[selectedIndex] === winningTeamId` by
	 * construction, and recorded anyway: a Manager who has run the 64-row
	 * spreadsheet holds a NUMBER, and checking a number against a number is
	 * the whole procedure. Making them perform the lookup first would add a
	 * step nobody needs to get wrong.
	 */
	readonly selectedIndex: number;
	/** The Team at that position — the winner. */
	readonly winningTeamId: string;
	/** That Team's name, so one row names the winner out loud. */
	readonly winningTeamName: string;
	/** The Manager whose joining Bid put that Team in the draw. */
	readonly winningManagerId: string;
};

/**
 * A lottery whose every Contender was cancelled (Story 10.5, FR-40).
 *
 * **The four winner fields are ABSENT rather than null**, and `selectedIndex`
 * with them. There was no selection: `drawIndex` was never reached, and a
 * `selectedIndex: 0` beside an empty list would name a position that does not
 * exist in a list that has none. A record stating the empty list and the
 * revealed seed is the whole truth of what happened here, and
 * `projection/draws.ts` reads exactly that back — a real record, not a row it
 * rejects.
 *
 * `contenders` is `[]` and `seed` is present for the reason it is present on
 * the drawn shape: the commitment published at the opening is discharged
 * whatever the list came out as.
 */
export type UndrawnContentionPayload = ContentionDrawnFacts & {
	readonly contenders: readonly [];
	readonly selectedIndex?: undefined;
	readonly winningTeamId?: undefined;
	readonly winningTeamName?: undefined;
	readonly winningManagerId?: undefined;
};

/**
 * The `BidCancelled` payload: one withdrawn commitment, its cause, and what
 * became of the Auction it was on (Story 10.3, FR-40, AD-31).
 *
 * **One fact, one event, one writer.** `close.ts` is the sole appender of
 * this type; nothing else in the codebase constructs one. It is a
 * COMPENSATING event and not a correction: the `BidPlaced` at `cancelledSeq`
 * is never deleted and never mutated, keeps its place in `seq` order, and
 * stays a visible history line — which is the whole of what distinguishes a
 * cancellation from a Commissioner's void, and why `league-clock.ts` has no
 * case for this type at all.
 *
 * **`amount` is recorded and no release is written.** The capital a
 * cancellation frees is a CONSEQUENCE: once the Bid no longer leads and no
 * longer contends, `teamMoneyStateFor` simply stops counting it, exactly as
 * being outbid already releases capital with no sweep and no flag (§10
 * example 5). The figure rides the payload so the notice and the Audit Log
 * can state what was released without re-folding the Auction it was on.
 *
 * **`restoration` carries the decision, and that is why it rides the event.**
 * Story 10.4's restorer walked this Auction's surviving history inside the
 * closing transaction, re-ran the cap and slots gates over each candidate's
 * roster and committed capital, skipped the failures and stopped at the first
 * pass. `auctionsReducer` READS that answer; re-deriving it would mean
 * re-running the gate suite inside a fold, over Teams whose rosters no
 * projection can see (AD-31). `null` is the honest answer for two different
 * facts and the payload does not distinguish them, because nothing needs it
 * to: nothing below survived re-validation, or the cancelled commitment was a
 * Minimum-Bid Contention entry, where the lead is a fold artifact that moves
 * with no re-validation at all.
 *
 * It is still `null` in a great many logs, and it was typed as the literal
 * `null` until Story 10.4 for exactly that reason — which is what made this
 * a compile error at every construction site rather than a silent absence.
 */
export type BidCancelledPayload = {
	/** The Auction the cancelled Bid was placed on. */
	readonly fantraxPlayerId: string;
	/** That Player's name, so one row names the Auction out loud. */
	readonly playerName: string;
	/** The cancelled Bid's own log position. Never re-issued (AD-8). */
	readonly cancelledSeq: string;
	/** The Team whose commitment this was — always the winning Team. */
	readonly teamId: string;
	readonly teamName: string;
	/** The Manager who placed the cancelled Bid. */
	readonly managerId: string;
	/** What the commitment was worth. Released as a consequence, not a write. */
	readonly amount: number;
	/** Whether it was a Minimum-Bid Contention entry rather than a lead. */
	readonly wasContentionEntry: boolean;
	/** The Player whose Close caused this — a DIFFERENT Auction. */
	readonly causeFantraxPlayerId: string;
	/** That Player's name, so the notice can name the win that caused it. */
	readonly causePlayerName: string;
	/** The winning Team of that Close. The same Team as `teamId`, stated. */
	readonly causeTeamId: string;
	/** Who leads the Auction now, or `null` — the decision, not a derivation. */
	readonly restoration: Restoration | null;
};

/**
 * One commitment the winning Team still holds after this close — a lead it
 * holds alone, or a Minimum-Bid Contention entry.
 *
 * The two are one shape because the cascade treats them as one thing: FR-40
 * cancels "commitments", most recent first, and which kind each is matters
 * only to the gate that judges it. `seq` is the LOG POSITION OF THE BID THAT
 * CREATED the commitment — the leading Bid's own `seq`, or the joining Bid's
 * — because that is what "most recent first by `seq`" orders on and what
 * `BidCancelled` names.
 */
type SurvivingCommitment = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly seq: string;
	readonly teamId: string;
	readonly teamName: string;
	readonly managerId: string;
	readonly amount: Money;
	readonly isContentionEntry: boolean;
};

/**
 * Every commitment `teamId` still holds in `auctions`, ascending by `seq`.
 *
 * **The same two tests `teamMoneyStateFor` makes, and deliberately so**: a
 * Team commits where it LEADS, and — in a Minimum-Bid Contention — where it
 * CONTENDS. What this adds is the `seq` and the identity of the Bid behind
 * each, which the money narrowing has no use for and drops.
 *
 * A cancelled Bid is absent by construction: `withBidCancelled` withdraws the
 * lead and `contendersFor` drops the Contender, so neither test finds it.
 *
 * Keys are iterated in sorted order and the result is then sorted by `seq`
 * (AD-5): the cascade's victim is `max(seq)`, and a maximum over an
 * incidental order is not a maximum.
 */
function commitmentsFor(
	auctions: OpenAuctions,
	teamId: string,
	playerNameFor: (fantraxPlayerId: string) => string
): readonly SurvivingCommitment[] {
	const commitments: SurvivingCommitment[] = [];
	for (const playerId of Object.keys(auctions.byPlayer).sort()) {
		const auction = auctionForPlayer(auctions, playerId);
		if (auction === null) continue;
		const leader = auction.leadingBid;
		const contender =
			auction.contention === 'minimum_bid'
				? (auction.contenders.find((entry) => entry.teamId === teamId) ?? null)
				: null;
		const playerName = playerNameFor(playerId);
		if (contender !== null) {
			commitments.push({
				fantraxPlayerId: playerId,
				playerName,
				// The JOINING Bid's position, never the fold's leader: in a
				// lottery the leader is whichever Team opened it, and this
				// Team's commitment is its own join.
				seq: contender.seq,
				teamId,
				teamName: contender.teamName,
				managerId: contender.managerId,
				// The flat amount every Contender holds (FR-14), never the
				// leading amount — `teamMoneyStateFor`'s substitution, and the
				// same `CONTENTION_AMOUNT` this module awards a drawn winner at.
				amount: CONTENTION_AMOUNT,
				isContentionEntry: true
			});
			continue;
		}
		if (leader === null || leader.teamId !== teamId) continue;
		commitments.push({
			fantraxPlayerId: playerId,
			playerName,
			seq: leader.seq,
			teamId,
			teamName: leader.teamName,
			managerId: leader.managerId,
			amount: auction.contention === 'minimum_bid' ? CONTENTION_AMOUNT : leader.amount,
			isContentionEntry: auction.contention === 'minimum_bid'
		});
	}
	// `seq` is an `int8` that arrives as a string (AD-8), so it is compared
	// through `BigInt` exactly as `fold()` compares it — `Number` would
	// misorder a log this league will never reach and `<` would misorder one
	// it reaches on the tenth event.
	return [...commitments].sort((left, right) => {
		const a = BigInt(left.seq);
		const b = BigInt(right.seq);
		if (a === b) return 0;
		return a < b ? -1 : 1;
	});
}

/** Everything the re-test needs about the winning Team, POST-CLOSE. */
type CascadeBasis = {
	readonly teamId: string;
	readonly capSpace: Money;
	readonly rosterCount: number;
	readonly minorLeagueOccupied: number;
	readonly isMinorLeagueEligible: (fantraxPlayerId: string) => boolean;
	readonly playerNameFor: (fantraxPlayerId: string) => string;
	/** The Auction's own nominal expiry — `evaluate`'s `now`, unread by `slots`. */
	readonly now: string;
};

/** `auctions`, narrowed to the named Players and nothing else. */
function auctionsLimitedTo(
	auctions: OpenAuctions,
	fantraxPlayerIds: readonly string[]
): OpenAuctions {
	// Built through `Object.entries`/`fromEntries` for `auctionsReducer`'s
	// reason: the keys are Fantrax player ids, which are data, so a key of
	// `__proto__` must not set a prototype.
	return {
		byPlayer: Object.fromEntries(
			Object.entries(auctions.byPlayer).filter(([playerId]) =>
				fantraxPlayerIds.includes(playerId)
			)
		)
	};
}

/**
 * Whether one commitment stands, given the older ones the Team is keeping —
 * `evaluateSlots`, asked through `evaluate`, and no arithmetic of this
 * module's own.
 *
 * **The question is the one the gate already owns.** "Is this Team within
 * capacity" is what FR-37 and FR-18 answer at a Bid, and the way to ask it of
 * a commitment already held is to ask whether that same Bid would be
 * permitted NOW: build the Team's money state from the other commitments,
 * build the `BidState` for this one's Auction, and read `slots.passed`. The
 * allowance, its `F >= 1` precondition, FR-18's entry exemption and the
 * eligible-absorbed carve-out all arrive with it. A hand-rolled
 * `holdings <= freeSlots` test would cancel a Bid the rule permits — §10
 * example 31's first close holds exactly two commitments against an allowance
 * of `1 + 1`, and is within capacity for that reason and no other.
 *
 * `evaluate` is used rather than the gate directly because it is the exported
 * total function that runs the whole set and never throws: it hands
 * `evaluateContention`'s own verdict to `evaluateSlots`, which is how a held
 * lottery entry is classified as one without this module comparing an amount.
 * Only `slots` is read — capacity is the question FR-40 asks, and the money
 * gate has nothing to say about a commitment already made.
 */
function commitmentStands(
	commitment: SurvivingCommitment,
	held: readonly SurvivingCommitment[],
	auctions: OpenAuctions,
	basis: CascadeBasis
): boolean {
	const scoped = auctionsLimitedTo(auctions, [
		...held.map((other) => other.fantraxPlayerId),
		commitment.fantraxPlayerId
	]);
	const team = teamMoneyStateFor({
		teamId: basis.teamId,
		// The Auction being judged, excluded from both lists exactly as a
		// prospective Bid's own Auction is — `evaluateSlots` counts it back in
		// once, on the post-bid basis AD-7 requires.
		fantraxPlayerId: commitment.fantraxPlayerId,
		capSpace: basis.capSpace,
		rosterCount: basis.rosterCount,
		minorLeagueOccupied: basis.minorLeagueOccupied,
		auctions: scoped,
		isMinorLeagueEligible: basis.isMinorLeagueEligible,
		playerNameFor: basis.playerNameFor
	});
	const state = bidStateFor(
		auctionForPlayer(scoped, commitment.fantraxPlayerId),
		team,
		basis.isMinorLeagueEligible(commitment.fantraxPlayerId),
		// A close happens inside the Auction Phase by construction — the sweep
		// runs nowhere else — and the phase gate is not one this re-test reads.
		'Auction'
	);
	const command: PlaceBid = {
		kind: 'PlaceBid',
		fantraxPlayerId: commitment.fantraxPlayerId,
		teamId: commitment.teamId,
		teamName: commitment.teamName,
		managerId: commitment.managerId,
		amount: commitment.amount
	};
	return evaluate(state, command, basis.now).slots.passed;
}

/**
 * The commitments this Team can no longer keep — SENIORITY first, which is
 * what "most recent first" means from the other end.
 *
 * The walk is ascending by `seq`, and each commitment is judged against the
 * older ones already kept. A Team's oldest commitments therefore hold their
 * place and the newest are the ones squeezed out, which is the same ordering
 * FR-40 states as "cancel most recent first" and the only one that makes the
 * two agree about which Bid a Team loses.
 *
 * **The eligible carve-out falls out here rather than being restated.** A
 * leading Bid on a Minor League Eligible Player a Free Minor League Slot can
 * still absorb contributes NOTHING to Projected Active/Bench Additions —
 * `evaluateSlots`' own eligible branch, through `activeBenchOverflow` — so it
 * passes against its seniors however recent it is, and never appears in this
 * set. An older non-eligible commitment over the same Team's allowance does
 * appear, and is what gets cancelled instead. There is no second rule saying
 * so, and if there were the two could disagree.
 */
function unlandableCommitments(
	commitments: readonly SurvivingCommitment[],
	auctions: OpenAuctions,
	basis: CascadeBasis
): readonly SurvivingCommitment[] {
	const kept: SurvivingCommitment[] = [];
	const over: SurvivingCommitment[] = [];
	for (const commitment of commitments) {
		if (commitmentStands(commitment, kept, auctions, basis)) kept.push(commitment);
		else over.push(commitment);
	}
	return over;
}

/**
 * The cascade: every `BidCancelled` this close owes, in the order it owes
 * them (Story 10.3, FR-40).
 *
 * **The trigger is a Close that REDUCES a free Slot — Active/Bench or Minor
 * League — and nothing else.** Not a Bid, not a Nomination, not a clock, and
 * never a restoration; that last bound is what terminates the cascade rather
 * than letting it chase its own tail. It is a *reduction*, tested pre- against
 * post-close, so a Team that was already full stays where it is and nothing
 * fires. And it is stated over BOTH Slot kinds, because a Minor League win at
 * a `$0` Cap Hit leaves Roster Count untouched: a trigger phrased as "a Close
 * that increases Roster Count" would miss §10 example 35 entirely.
 *
 * **Everything is POST-CLOSE.** `loadCloseState` reads the winner's roster
 * BEFORE this close and folds `auctions` INCLUDING the Auction being closed,
 * so the cascade derives the picture itself: the placement's effect on Roster
 * Count and Minor League occupancy, the Cap Hit's effect on Cap Space, and
 * the won Player dropped from `byPlayer`. That is the same basis AD-11 hands
 * the next Close; handing the cascade the loaded snapshot would re-admit the
 * Team the Close just disqualified.
 *
 * **One at a time, re-tested after each, stopping at the first pass.** The
 * loop cancels `max(seq)` among the commitments that no longer stand,
 * re-derives the Auctions through the SAME `withBidCancelled` the reducer
 * will fold, and asks again. A Team already within capacity after the Close
 * has nothing cancelled at all — the cascade is conditional, not a reflex.
 */
function cascadeFor(
	state: CloseState,
	auction: Auction,
	party: ClosedParty,
	placement: SlotPlacement,
	capHit: Money,
	closesAt: string,
	playerName: string
): readonly EventEnvelope[] {
	// `M = max(0, 3 − occupied)` and `F = max(0, 12 − count)`, both CLAMPED
	// for `slotPlacementFor`'s reason: a Commissioner override can leave a
	// Team above either ceiling, and an unclamped figure would go negative and
	// then read as "a Slot is free".
	const rosterCountAfter = state.rosterCount + (placement === 'active_bench' ? 1 : 0);
	const minorLeagueOccupiedAfter =
		state.minorLeagueOccupied + (placement === 'minor_league' ? 1 : 0);
	const freeBefore = Math.max(0, ACTIVE_BENCH_SLOTS - state.rosterCount);
	const freeAfter = Math.max(0, ACTIVE_BENCH_SLOTS - rosterCountAfter);
	const minorsBefore = Math.max(0, MINOR_LEAGUE_SLOTS - state.minorLeagueOccupied);
	const minorsAfter = Math.max(0, MINOR_LEAGUE_SLOTS - minorLeagueOccupiedAfter);
	if (freeAfter >= freeBefore && minorsAfter >= minorsBefore) return [];

	const basis: CascadeBasis = {
		teamId: party.teamId,
		// The Cap Hit this close charges, subtracted here rather than read off
		// a roster the transaction has already passed the right moment to ask.
		capSpace: subtractMoney(state.capSpace, capHit),
		rosterCount: rosterCountAfter,
		minorLeagueOccupied: minorLeagueOccupiedAfter,
		isMinorLeagueEligible: state.isMinorLeagueEligible,
		playerNameFor: state.playerNameFor,
		now: closesAt
	};

	/**
	 * A candidate Team's three roster figures — the shell's batched read for
	 * everybody, and the POST-CLOSE derivation for the winning Team.
	 *
	 * **The override is not a convenience.** `state.rosterFiguresFor` answers
	 * from a read taken BEFORE this close, which is correct for every other
	 * Team — a Close changes the winner's roster and nobody else's — and wrong
	 * for exactly one: the winner, whose Slot this close just filled and whose
	 * Cap Space this close's Cap Hit just reduced. The winner CAN be its own
	 * next-highest candidate, holding an older outbid Bid on the same Auction,
	 * and judging that Bid against a pre-close roster would restore the Team
	 * the Close had just disqualified.
	 *
	 * **What the post-close figures buy is a fair test, not a guaranteed
	 * refusal.** Handed them, the winner's own older Bid is judged against the
	 * roster and the committed capital the cancellation just left it with —
	 * the same basis `commitmentStands` used a moment ago, and a STRICTER one,
	 * because `candidateStands` counts the Team's whole remaining commitment
	 * set where `commitmentStands` counted only the seniority prefix. A Team
	 * squeezed out on capacity therefore fails again. A Team whose Bid is on a
	 * Minor League Eligible Player a free Minor League Slot can still absorb
	 * passes — as it should, since that is the carve-out `evaluateSlots`
	 * already owns and the same Bid the cascade itself walks past. Either way
	 * the answer comes from the gate, and there is no special case here.
	 */
	const rosterFiguresFor = (teamId: string): CandidateRosterFigures | null =>
		teamId === party.teamId
			? {
					capSpace: basis.capSpace,
					rosterCount: basis.rosterCount,
					minorLeagueOccupied: basis.minorLeagueOccupied
				}
			: state.rosterFiguresFor(teamId);

	// The won Auction leaves `byPlayer`: it is a contract now, not a
	// commitment, and counting it as both is the subtle version of this bug.
	let auctions = auctionsLimitedTo(
		state.auctions,
		Object.keys(state.auctions.byPlayer).filter(
			(playerId) => playerId !== auction.fantraxPlayerId
		)
	);

	const events: EventEnvelope[] = [];
	// A bound, not a condition: every iteration cancels one commitment and a
	// cancelled commitment cannot be found again, so the loop terminates on
	// its own. The bound is here because a loop in the core that could not
	// terminate would hang the transaction rather than fail it (AD-1).
	const bound = commitmentsFor(auctions, party.teamId, state.playerNameFor).length;
	for (let iteration = 0; iteration <= bound; iteration += 1) {
		const commitments = commitmentsFor(auctions, party.teamId, state.playerNameFor);
		const over = unlandableCommitments(commitments, auctions, basis);
		// **The stop condition, and it is the whole of it.** Within both FR-37
		// and FR-18, nothing further is cancelled.
		if (over.length === 0) return events;
		// Most recent first: `over` is in ascending `seq`, so the last of it is
		// the newest commitment the Team can no longer keep.
		const victim = over[over.length - 1];
		if (victim === undefined) return events;

		const cancelledAuction = auctionForPlayer(auctions, victim.fantraxPlayerId);
		if (cancelledAuction === null) {
			throw new TypeError(
				'decideClose: the cascade selected a commitment on ' +
					`${JSON.stringify(victim.fantraxPlayerId)} and no Auction for that Player is in the ` +
					'fold it selected from (AD-1)'
			);
		}
		// **The marker the REDUCER writes carries the appended event's own
		// `seq`; this one cannot.** `seq` is assigned by the database at the
		// insert (`shell/write.ts`), so the core has no number to put here —
		// and it needs none, because nothing the cascade re-tests reads it. The
		// empty string models "marked cancelled", and the fold writes the real
		// position when the appended event comes back through
		// `auctionsReducer`.
		const marker = {
			seq: '',
			causeFantraxPlayerId: auction.fantraxPlayerId,
			causePlayerName: playerName
		};

		// **The withdrawal FIRST, and the succession decided against it**
		// (Story 10.4). The candidate is judged on the state the Auction is
		// actually in once this commitment is gone — leaderless, with the
		// winner's capital already released — so the same `withBidCancelled`
		// the reducer will fold is what produces the basis. Restoring nothing
		// here is not the answer; it is the question.
		const withdrawn = {
			byPlayer: {
				...auctions.byPlayer,
				[victim.fantraxPlayerId]: withBidCancelled(cancelledAuction, victim.seq, {
					...marker,
					restoration: null
				})
			}
		};
		const restored = selectRestoration({
			fantraxPlayerId: victim.fantraxPlayerId,
			withdrawnSeq: victim.seq,
			basis: {
				// POST-CLOSE and POST-CASCADE: the won Player is already out of
				// `byPlayer`, every earlier cancellation is already folded in,
				// and so is every earlier RESTORATION — which is the only way one
				// cascade can push a non-winning Team over its own allowance, and
				// the second candidacy has to see the first.
				auctions: withdrawn,
				rosterFiguresFor,
				isMinorLeagueEligible: basis.isMinorLeagueEligible,
				playerNameFor: basis.playerNameFor,
				now: basis.now
			},
			// Retain, leave, keep. The Bid stays in the history, the Auction
			// Clock is untouched, and the League Clock keeps its reset — the
			// three things that make this a cancellation and not a void.
			axes: CANCELLATION_AXES
		}).restored;

		const payload: BidCancelledPayload = {
			fantraxPlayerId: victim.fantraxPlayerId,
			playerName: victim.playerName,
			cancelledSeq: victim.seq,
			teamId: victim.teamId,
			teamName: victim.teamName,
			managerId: victim.managerId,
			amount: victim.amount,
			wasContentionEntry: victim.isContentionEntry,
			causeFantraxPlayerId: auction.fantraxPlayerId,
			causePlayerName: playerName,
			causeTeamId: party.teamId,
			// The decision, recorded so the fold reads it rather than re-making
			// it. No second event is appended for a restoration: one
			// `BidCancelled` carries the cancelled `seq`, the cause AND the
			// restored Team, Bid `seq` and amount.
			restoration: restored
		};
		events.push({
			type: BID_CANCELLED_EVENT,
			payload,
			// The CANCELLED Manager and Team — who this event is about, and who
			// the mention is owed to. It is the winning Team either way: the
			// cascade cancels the winner's own surplus and nobody else's. The
			// RESTORED Team is owed a mention too, and it is addressed off the
			// payload by `server/close.ts` rather than from here: an event row
			// carries one Team, and this one is about the cancellation.
			managerId: victim.managerId,
			teamId: victim.teamId
		});

		// The SAME `withBidCancelled` the reducer will fold, now carrying the
		// decision — so the next iteration's re-test, and the next
		// restoration's, both see the restored leader and the capital it
		// re-commits. Re-committing is a consequence and never a write:
		// `teamMoneyStateFor` simply starts counting the Bid again once it
		// leads.
		auctions = {
			byPlayer: {
				...auctions.byPlayer,
				[victim.fantraxPlayerId]: withBidCancelled(cancelledAuction, victim.seq, {
					...marker,
					restoration: restored
				})
			}
		};
	}

	throw new TypeError(
		'decideClose: the cancellation cascade did not settle within one pass per commitment, which ' +
			'means a cancellation left the Team no better off than it found it (FR-40, AD-1)'
	);
}

/**
 * The two events an emptied lottery ends with (Story 10.5, FR-40, AD-14).
 *
 * **The `ContentionDrawn` first, and it is not a formality.** The lottery
 * published a `seedHash` at its opening and a Manager may have recorded it. A
 * contention that closed with its seed still sealed is the outcome AD-14
 * cannot survive — an empty Contender list does not excuse it — so the reveal
 * is appended here exactly as it is on a drawn close, carrying the empty list
 * as the fact it is. `drawnWinnerFor` verified `hash(seed)` before it built
 * this result; it is verified AGAIN below, because this function must never
 * publish a seed that does not answer the commitment whatever route the
 * `ClosedWinner` took to reach it.
 *
 * **Then an `AuctionTerminated`, and never an `AuctionClosed`.**
 * `AuctionClosedPayload` requires a `teamId`, a `managerId`, a
 * `winningAmount` and a `placement`, and the columns behind the first two are
 * `not null` and reference real rows. Nobody won, so there is nothing to put
 * in any of them. `AuctionTerminated` already means precisely this outcome —
 * no winner, no contract, no Nomination Slot released, the Player in the
 * Free Agent pool by arithmetic rather than by a table write — and
 * `server/nomination.ts`'s `releaseNomination` already reads both event types.
 * What this story gives it is a second producer: until now every one came from
 * `phase-end.ts`, for a nomination that never drew a Bid at all.
 *
 * **No cascade, and that is the rule rather than an omission.** `cascadeFor`
 * is not consulted: nobody won, so no Team's free Slots fell, so no
 * commitment anywhere became surplus. The trigger FR-40 names is a Close that
 * REDUCES the winning Team's free Slots, and this close has no winning Team.
 *
 * The nomination is required rather than fallen back on. `expiredAt` is the
 * Auction's own persisted `closesAt` — `closedAt`'s rule for `closedAt`'s
 * reason — and `evaluatedAt` the injected `now`, which is the one thing this
 * whole function emits that varies with the clock.
 */
function undrawnClose(
	state: CloseState,
	auction: Auction,
	winner: UndrawnLottery,
	closesAt: string,
	playerName: string,
	now: string
): Accepted<readonly EventEnvelope[]> {
	// **An `undrawn` result carrying Contenders is a caller bug** (AD-14). The
	// one producer builds it only for an empty list; anything else reaching
	// here would record a draw that ran over Teams and selected none of them,
	// which is a record inviting a Manager to reproduce a derivation that
	// never happened — so it is tagged as the sibling guards below are, on the
	// verification record it would corrupt rather than on the caller.
	if (winner.contenders.length > 0) {
		throw new TypeError(
			`decideClose: an undrawn lottery has no Contenders by definition; received ` +
				`${String(winner.contenders.length)} (AD-14)`
		);
	}

	// The shape first and the comparison second, `decideClose`'s own order for
	// `decideClose`'s own reason: when `auction.seedHash` is `null` — the
	// corrupt-log case that reveals anyway rather than stranding the Auction —
	// the comparison does not run at all, and an unshaped seed would reach the
	// payload unexamined.
	if (!isSeedShaped(winner.seed)) {
		throw new TypeError(
			'decideClose: the revealed seed is not 64 lowercase hex digits, as sha256sum prints ' +
				`them; received ${JSON.stringify(winner.seed)} (AD-14)`
		);
	}
	if (auction.seedHash !== null) {
		const revealed = hash(winner.seed);
		if (revealed !== auction.seedHash) {
			throw new TypeError(
				'decideClose: the revealed seed does not match the published commitment; hash(seed) ' +
					`is ${revealed} and the log published ${auction.seedHash} (AD-14)`
			);
		}
	}

	// **The NOMINATING Team, off the nominations fold, and there is no
	// fallback for it.** `AuctionTerminatedPayload` names the Team that
	// nominated this Player, and no other fold knows who that is — the
	// Auction names bidders, and every one of them has been cancelled. A close
	// with an Auction and no nomination is a log this codebase cannot write
	// (the `no_open_auction` check refuses a Bid on an unnominated Player), so
	// this is AD-1's throw rather than a synthetic Team on a `not null` column
	// that references `teams(id)`.
	const nomination = state.nomination;
	if (nomination === null) {
		throw new TypeError(
			`decideClose: "${auction.fantraxPlayerId}" drew no Contender and its termination must ` +
				'name the NOMINATING Team, which only the nominations fold knows; none was loaded ' +
				'(FR-22, AD-1)'
		);
	}

	const drawn: UndrawnContentionPayload = {
		fantraxPlayerId: auction.fantraxPlayerId,
		// Revealed, and only after the comparison above.
		seed: winner.seed,
		seedHash: auction.seedHash,
		// Empty, stated. No `selectedIndex` and no winner fields: there was no
		// selection to record and no Team to invent one for.
		contenders: [],
		// The Auction's OWN persisted expiry, never `now` (AD-10).
		drawnAt: closesAt
	};

	const terminated: AuctionTerminatedPayload = {
		fantraxPlayerId: auction.fantraxPlayerId,
		playerName,
		teamId: nomination.teamId,
		teamName: nomination.teamName,
		managerId: nomination.managerId,
		// **The AUCTION's own expiry here, not the League Clock's.** The other
		// producer terminates on the phase boundary and puts that instant on
		// this field; this one terminates on the Auction running out with
		// nobody in it, and the Auction's persisted `closesAt` is the instant
		// that describes. Both are "when it was due", and neither is `now`.
		expiredAt: closesAt,
		evaluatedAt: now
	};

	// **Cause, then consequence**, the same fixed order a drawn close keeps: a
	// log read in `seq` order states the empty draw before it states the
	// termination that empty draw caused.
	const accepted: Accepted<readonly EventEnvelope[]> = {
		kind: 'accepted',
		events: [
			{
				type: CONTENTION_DRAWN_EVENT,
				payload: drawn,
				// The NOMINATOR's, because there is no winner whose it could
				// be. `phase-end.ts` states the pair the same way, and for the
				// same constraint: `auction_events_actor_pair_null_together`
				// means a nomination that named no Manager records NEITHER
				// rather than inventing a `manager_id` that column references.
				managerId: nomination.managerId,
				teamId: nomination.managerId === null ? null : nomination.teamId
			},
			{
				type: AUCTION_TERMINATED_EVENT,
				payload: terminated,
				managerId: nomination.managerId,
				teamId: nomination.managerId === null ? null : nomination.teamId
			}
		]
	};
	return accepted;
}

/**
 * Close one Auction: one `AuctionClosed` envelope — or, for a Minimum-Bid
 * Contention, the `ContentionDrawn` reveal and then the close — or a throw.
 *
 * There is no `Rejected` half and no gate set. A close cannot be refused by a
 * rule — nobody issued it, and every question it asks has an answer — so the
 * return type is `Accepted` and every failure is a `TypeError` (AD-1).
 *
 * **The signature is unchanged from Story 3.4.** The winner still arrives as
 * the third argument; what changed is that `server/close.ts` now has one to
 * pass, derived by `rules/draw.ts` from the sealed seed it read under the same
 * lock. A Standard close still passes `null` and still emits exactly one
 * event.
 *
 * **`now` is read in exactly one expression and nothing emitted varies with
 * it.** The guard is `hasExpired`, the same derivation the `expiry` gate
 * refuses Bids with, so a live Auction cannot be closed under the same lock
 * that would still be accepting Bids on it (AD-12). Everything else — the
 * winner, the amount, the placement, the Cap Hit, `closedAt` — is a function
 * of the folded state alone, so an on-time close and a six-hours-late close
 * emit byte-identical payloads.
 *
 * **Three facts are asserted elsewhere rather than written here**, and that is
 * the design rather than an omission:
 *
 *  - the League Clock does not reset — `league-clock.ts`'s
 *    `default: return state`, because AD-22 fixes the reset set at a
 *    Nomination and an accepted Bid and a close is neither;
 *  - the board seat releases, and the WINNING Team's Nomination Slot with it —
 *    `nominationsReducer`'s own fold of this same event, keyed on the Player
 *    for the seat and on the winner for the Slot (FR-9, amended);
 *  - Minors Exposure recomputes — the won Auction leaves `auctions.byPlayer`,
 *    so `teamMoneyStateFor` stops counting it (§10 example 20).
 *
 * Not one of them needed a line here, which is what "derived on every
 * evaluation" (AD-7) buys.
 */
export function decideClose(
	state: CloseState,
	now: string,
	winner: ClosedWinner | null
): Accepted<readonly EventEnvelope[]> {
	// **The winner is derived FIRST, and that ordering is the shell's rather
	// than a judgement about which failure matters more.** `server/close.ts`
	// asks this same pure function inside `load`, because it cannot read the
	// winning Team's roster until it knows which Team won — and it has no
	// `now` there, since `runTransactionalWrite` hands the clock to `decide`
	// alone. So a wrong-winner bug surfaces before an unexpired one either
	// way, and putting the expiry guard above this line would only make the
	// two disagree about which message a caller sees. Both abort the
	// transaction with nothing appended (AD-1).
	const party = closedWinnerFor(state.auction, winner);
	const auction = state.auction;
	if (auction === null) {
		// Unreachable: `closedWinnerFor` throws on a null Auction one line
		// above. The guard exists to give TypeScript the narrowing it cannot
		// prove through a function boundary, not to handle a reachable state.
		throw new TypeError('decideClose: the winner was derived with no Auction loaded');
	}

	// **The ONE expression in this function that reads `now`**, and it is a
	// guard rather than an input: nothing below varies with it. It is the same
	// `hasExpired` the `expiry` gate refuses Bids against, so an Auction
	// cannot be closed under the same lock that would still be taking Bids on
	// it, and `now >= closesAt` means Story 3.5 handing an Auction its own
	// nominal expiry closes it rather than finding it live (AD-12).
	//
	// **The narrowing is the leaderless case, not a style choice** (Story
	// 10.3). `Auction.closesAt` is nullable now and it is `null` for exactly
	// one Auction: one whose every Bid was cancelled, which is deliberately
	// left with no clock so it never closes at its old expiry with no winner.
	// `hasExpired(null, …)` is already `false`, so such an Auction takes this
	// same throw — the guard states the `null` as well so the payload below
	// can carry a `closedAt` that is a string.
	const closesAt = auction.closesAt;
	if (closesAt === null || !hasExpired(closesAt, now)) {
		throw new TypeError(
			`decideClose: this Auction closes at ${JSON.stringify(closesAt)} and "now" is ` +
				`${JSON.stringify(now)}, which has not reached it. Closing a live Auction is the ` +
				'caller’s bug — the same instant the expiry gate refuses Bids against (AD-12)'
		);
	}

	// The nomination is what knows the Player's NAME — the fold that holds it
	// is the same one this close releases. A close whose nomination somehow
	// folded away still names the Player by id rather than dropping the field,
	// which is `readPayload`'s fallback everywhere else. Hoisted to a local
	// since Story 10.3: every `BidCancelled` this close causes names the Player
	// whose win caused it, and one derivation is what keeps the close and the
	// cancellations from naming them two different ways.
	const playerName = state.nomination?.playerName ?? auction.fantraxPlayerId;

	// **A lottery every Contender was cancelled from: the THIRD return**
	// (Story 10.5, FR-40). It is taken before anything a winner would be
	// needed for — the placement, the Cap Hit, the close payload and the
	// cascade are all downstream of a party this outcome does not have.
	if (winner !== null && winner.kind === 'undrawn') {
		return undrawnClose(state, auction, winner, closesAt, playerName, now);
	}
	// Unreachable: `closedWinnerFor` returns `null` for an `undrawn` winner
	// and for nothing else, and that case returned one line above. The guard
	// is the narrowing TypeScript cannot prove through a function boundary.
	if (party === null) {
		throw new TypeError(
			'decideClose: no closing party was derived and no lottery was undrawn (AD-1)'
		);
	}

	const placement = slotPlacementFor(state.playerIsMinorLeagueEligible, state.minorLeagueOccupied);
	// Computed from the placement and the winning amount SEPARATELY, and never
	// by assuming the two money figures are equal (AD-23).
	const capHit = capHitFor(placement, party.winningAmount);

	const payload: AuctionClosedPayload = {
		fantraxPlayerId: auction.fantraxPlayerId,
		playerName,
		teamId: party.teamId,
		teamName: party.teamName,
		managerId: party.managerId,
		winningAmount: party.winningAmount,
		capHit,
		placement,
		contention: party.contention,
		contractYears: null,
		// The Auction's OWN persisted expiry, not `now`. This is the whole of
		// what makes a late close produce the same event as an on-time one.
		closedAt: closesAt
	};

	const closed: EventEnvelope = {
		type: AUCTION_CLOSED_EVENT,
		payload,
		// The WINNER's Manager and Team. `auction_events.manager_id`/`team_id`
		// are `not null` and reference real rows, and a close needs no
		// synthetic actor — the Team that now owns the contract is the honest
		// answer to "who does this event belong to".
		managerId: party.managerId,
		teamId: party.teamId
	};

	// **The cascade FR-40 owes this close, derived once and used by both
	// returns** (Story 10.3). It is empty unless this Close reduced the winning
	// Team's free Slots, and empty again when the Team is still within capacity
	// after it — the cascade is conditional, not a reflex. It is derived here,
	// above both returns, so a lottery close and a Standard close cannot end up
	// running two different cascades.
	const cancellations = cascadeFor(
		state,
		auction,
		party,
		placement,
		capHit,
		closesAt,
		playerName
	);

	if (winner === null) {
		const accepted: Accepted<readonly EventEnvelope[]> = {
			// **The order inside the one transaction is fixed**:
			// `AuctionClosed`, then each `BidCancelled` in cascade order. Cause
			// then consequence, the same rule `ContentionDrawn` keeps on the
			// other side of the close — a log read in `seq` order states the
			// win that filled the Slot before it states what that cost the
			// Team elsewhere.
			kind: 'accepted',
			events: [closed, ...cancellations]
		};
		return accepted;
	}

	// **`hash(seed)` is verified against the folded commitment BEFORE the
	// reveal is built** (Story 3.6, AD-14). `rules/draw.ts` made the same
	// check when it selected this Contender; it is made again here because
	// this function must never publish a seed that does not answer the
	// commitment a Manager already recorded, whatever route the `ClosedWinner`
	// took to reach it. Both calls are pure over the same two values, so they
	// cannot disagree — and a mismatch throws with NOTHING appended, which
	// rolls the whole transaction back.
	//
	// A `seedHash` of `null` is the corrupt-log case `readPayload` produces:
	// unverifiable rather than mismatched. The draw proceeds and the payload
	// states the `null` for the record, because refusing would strand the
	// Auction in a contention forever with every Contender's capital
	// committed. Story 3.3 took the identical position on a dissolution.
	// **The shape first, because the hash check cannot stand in for it.** When
	// `auction.seedHash` is `null` — the corrupt-log case that draws anyway
	// rather than stranding the Auction — the comparison below does not run at
	// all, and an unshaped seed would reach the payload unexamined. A seed is
	// what a Manager types into `sha256sum`; publishing something that is not
	// one is publishing a reveal nobody can use. `isSeedShaped` is `draw.ts`'s
	// own predicate, asked here rather than restated.
	if (!isSeedShaped(winner.seed)) {
		throw new TypeError(
			'decideClose: the revealed seed is not 64 lowercase hex digits, as sha256sum prints ' +
				`them; received ${JSON.stringify(winner.seed)} (AD-14)`
		);
	}

	if (auction.seedHash !== null) {
		const revealed = hash(winner.seed);
		if (revealed !== auction.seedHash) {
			throw new TypeError(
				'decideClose: the revealed seed does not match the published commitment; hash(seed) ' +
					`is ${revealed} and the log published ${auction.seedHash} (AD-14)`
			);
		}
	}

	// **The reduction's own output, carried — never recovered by lookup.**
	// `winner.contenders.indexOf(winner.teamId)` would answer with the first
	// occurrence of that Team, which agrees with the arithmetic only while the
	// list holds no duplicate. The number published here is the one a Manager
	// compares their 64-row spreadsheet against, so it is `drawIndex`'s return
	// value or it is nothing.
	const selectedIndex = winner.selectedIndex;
	if (
		!Number.isInteger(selectedIndex) ||
		selectedIndex < 0 ||
		selectedIndex >= winner.contenders.length
	) {
		throw new TypeError(
			`decideClose: the drawn position ${JSON.stringify(selectedIndex)} is not a place in the ` +
				`Contender list it was drawn from (${winner.contenders.length} Contenders) (AD-14)`
		);
	}
	// **The carried index and the carried winner must agree**, and a
	// disagreement is a throw rather than a silent reconciliation in favour of
	// either. Unreachable through `drawnWinnerFor`, which reads the winner out
	// of this very list at this very position — which is exactly why a caller
	// that reached here some other way must not be trusted to have done so.
	if (winner.contenders[selectedIndex] !== winner.teamId) {
		throw new TypeError(
			`decideClose: the drawn winner "${winner.teamId}" is not at position ` +
				`${String(selectedIndex)} of the Contender list it was drawn from ` +
				`(${winner.contenders.join(', ')}) (AD-14)`
		);
	}

	const drawn: ContentionDrawnPayload = {
		fantraxPlayerId: auction.fantraxPlayerId,
		// The seed, revealed — the one place a drawn seed enters the log, and
		// only after the comparison above.
		seed: winner.seed,
		seedHash: auction.seedHash,
		// The fold's own order, never re-sorted and never filtered.
		contenders: winner.contenders,
		selectedIndex,
		winningTeamId: winner.teamId,
		winningTeamName: winner.teamName,
		winningManagerId: winner.managerId,
		// The Auction's OWN persisted expiry, `closedAt`'s rule for
		// `closedAt`'s reason: a sweep six hours late appends a byte-identical
		// payload and only `occurred_at` records when it landed (AD-10).
		drawnAt: closesAt
	};

	// **Cause, then consequence**, and the order is the rule rather than a
	// preference: a log read in `seq` order states the draw that selected the
	// winner before it states the close that awarded them the Player.
	// `runTransactionalWrite` has always appended N events in order under one
	// lock, so two is no new machinery — it is what a dissolution already does.
	const accepted: Accepted<readonly EventEnvelope[]> = {
		kind: 'accepted',
		events: [
			{
				type: CONTENTION_DRAWN_EVENT,
				payload: drawn,
				// The WINNER's, exactly as the close below: the Team the draw
				// selected is the honest answer to "who does this belong to",
				// and a close needs no synthetic actor.
				managerId: party.managerId,
				teamId: party.teamId
			},
			closed,
			// ...and then FR-40's cancellations, last. The three-way order —
			// draw, close, cancellations — is the fixed one, and it is the
			// causal one read in `seq` order.
			...cancellations
		]
	};
	return accepted;
}
