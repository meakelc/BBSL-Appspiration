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

import { MINIMUM_BID, MINOR_LEAGUE_SLOTS } from '../constants.ts';
import { hash } from '../hash.ts';
import type { Money } from '../money.ts';
import { parseMoney } from '../money.ts';
import type { Auction, ContentionState } from '../projection/auctions.ts';
import { hasExpired } from '../projection/auctions.ts';
import type { SlotPlacement } from '../projection/contracts.ts';
import { CONTENTION_DRAWN_EVENT } from '../projection/draws.ts';
import type { OpenNomination } from '../projection/nominations.ts';
import { AUCTION_CLOSED_EVENT } from '../projection/nominations.ts';
import type { Accepted, EventEnvelope } from '../types.ts';
import { isSeedShaped } from './draw.ts';

/** The flat amount every Contender in a Minimum-Bid Contention holds. */
const CONTENTION_AMOUNT: Money = parseMoney(MINIMUM_BID);

/** A Minor League placement charges nothing against the Cap (AD-23). */
const NO_CAP_HIT: Money = parseMoney(0);

/**
 * The Contender a draw selected — the winner argument a Minimum-Bid
 * Contention's close REQUIRES, and the only kind there is.
 *
 * **Declared by Story 3.4 and produced since Story 3.6.** `rules/draw.ts`
 * derives a winner from the revealed seed and the ordered Contender list
 * (AD-14) and hands the result here; declaring the shape a story early meant
 * 3.6 added a drawer rather than a signature change, and meant the lottery
 * branch below was proven against state literals before a producer existed.
 * `server/close.ts` reads the sealed seed under the lock and passes the drawn
 * winner, so a live contention now closes rather than throwing.
 *
 * Written as a discriminated union of one so 3.6 could add a case — a
 * single-Contender lottery that needs no draw (§10 example 11), say. **It did
 * not need one**, and the union stays a union of one: `seed mod 1 = 0` selects
 * the only Contender there is, the one-team list is recorded exactly as the
 * multi-team one, and a second case would be a branch stating something the
 * arithmetic already states.
 *
 * `seed` and `contenders` were carried for 3.6's reveal and deliberately not
 * read by 3.4. **Story 3.6 reads them**: `decideClose` builds the
 * `ContentionDrawn` payload from this shape, which is why the drawer puts the
 * derivation's inputs here beside its output. `rules/draw.ts` is the one
 * producer; nothing else in the codebase constructs one.
 */
export type ClosedWinner = {
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
): ClosedParty {
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
				`drawn winner; received one naming team "${winner.teamId}" (AD-1)`
		);
	}

	// Every contention that is not a lottery closes on the leader, and an
	// Auction that exists always has one — that is what makes it exist, and
	// `Auction.leadingBid` is non-nullable for exactly that reason. So
	// `awaiting_opening_bid`, which no folded Auction can hold, needs no branch
	// of its own rather than a dead one that hides the invariant.
	return {
		teamId: auction.leadingBid.teamId,
		teamName: auction.leadingBid.teamName,
		managerId: auction.leadingBid.managerId,
		winningAmount: auction.leadingBid.amount,
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
 */
export type ContentionDrawnPayload = {
	readonly fantraxPlayerId: string;
	/** The seed, revealed. The one place a drawn seed enters `auction_events`. */
	readonly seed: string;
	/** The commitment it was published against, or `null` if none ever was. */
	readonly seedHash: string | null;
	/** The Contender list the draw ran over, ascending join `seq` — ids. */
	readonly contenders: readonly string[];
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
	/** The Auction's own persisted expiry — never the transaction clock. */
	readonly drawnAt: string;
};

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
 *  - the nominating Team's Nomination Slot releases —
 *    `nominationsReducer`'s own fold of this same event, keyed on the Player;
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
	if (!hasExpired(auction.closesAt, now)) {
		throw new TypeError(
			`decideClose: this Auction closes at ${JSON.stringify(auction.closesAt)} and "now" is ` +
				`${JSON.stringify(now)}, which has not reached it. Closing a live Auction is the ` +
				'caller’s bug — the same instant the expiry gate refuses Bids against (AD-12)'
		);
	}

	const placement = slotPlacementFor(state.playerIsMinorLeagueEligible, state.minorLeagueOccupied);
	// Computed from the placement and the winning amount SEPARATELY, and never
	// by assuming the two money figures are equal (AD-23).
	const capHit = capHitFor(placement, party.winningAmount);

	const payload: AuctionClosedPayload = {
		fantraxPlayerId: auction.fantraxPlayerId,
		// The nomination is what knows the Player's NAME — the fold that holds
		// it is the same one this close releases. A close whose nomination
		// somehow folded away still names the Player by id rather than dropping
		// the field, which is `readPayload`'s fallback everywhere else.
		playerName: state.nomination?.playerName ?? auction.fantraxPlayerId,
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
		closedAt: auction.closesAt
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

	if (winner === null) {
		const accepted: Accepted<readonly EventEnvelope[]> = { kind: 'accepted', events: [closed] };
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
		drawnAt: auction.closesAt
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
			closed
		]
	};
	return accepted;
}
