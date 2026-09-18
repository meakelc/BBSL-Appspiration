/**
 * The post-act evaluation a Roster Trade and a Drop share (Stories 7.7, 7.8,
 * FR-41, FR-43, AR-42).
 *
 * **One act, two commands, one judgement.** A Trade and a Drop are different
 * acts — two Teams against one, a transfer against a release — but they are
 * judged the identical way: apply the whole act, derive one Team's five
 * figures from the rows it is left holding, and hand that state to the SAME
 * two derivations the bidding gates read (`teamSolvencyFiguresFor` for the
 * money and `slotCapacityFiguresFor` for the capacity). Everything in this
 * module was `rules/roster-trade.ts`'s when a Trade was the only such act; it
 * moved here the moment a second one needed it, which is the same extraction
 * Story 7.7 made on `bidding.ts` rather than write a parallel copy.
 *
 * **It contains no arithmetic of its own** (AR-42). There is no affordability
 * check here, no second Roster Reserve, no second Free Active/Bench Slots, no
 * second Minors Exposure and no third statement of the charged-Cap-Hit rule.
 * An act refused by arithmetic this module wrote itself would be an act
 * judged by a rule no Bid is judged by.
 *
 * **The extraction moved code and changed no gate's answer.** Every
 * expression below is verbatim what the Trade's own cap and slots gates held
 * before the extraction, down to the `isContentionEntry: true` argument and
 * the three explicit ceiling tests, and the Trade's own tests are the
 * statement of that.
 *
 * **The shapes are structural and minimal on purpose.** `ActingRow` asks for
 * the four facts the figures and the charge are computed from, so a Trade's
 * `TradingPlayer` and a Drop's `DroppablePlayer` both satisfy it while each
 * keeps the extra fields only its own act reads. Nothing here knows which
 * command it is serving, which is what stops a per-command branch from ever
 * appearing in a shared gate.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { ACTIVE_BENCH_SLOTS, INJURY_RESERVE_SLOTS, MINOR_LEAGUE_SLOTS } from '../constants.ts';
import {
	compareMoney,
	formatExactDollars,
	formatMoney,
	isOnMoneyGrid,
	parseMoney,
	subtractMoney
} from '../money.ts';
import type { Money } from '../money.ts';
import { auctionForPlayer } from '../projection/auctions.ts';
import type { OpenAuctions } from '../projection/auctions.ts';
import type { RosterActTeamFigures } from '../projection/contracts.ts';
import { nominationForPlayer } from '../projection/nominations.ts';
import type { OpenNominations } from '../projection/nominations.ts';
import type {
	ContestedPlayer,
	ActCapGateOutcome,
	ActLeadingAuction,
	ActSlotsGateOutcome,
	RosterSlotKind
} from '../types.ts';
import {
	activeBenchCapacityHolds,
	bidStateFor,
	describeAmount,
	slotCapacityFiguresFor,
	teamMoneyStateFor,
	teamSolvencyFiguresFor
} from './bidding.ts';
import type { TeamMoneyState } from './bidding.ts';
import { chargedCapHit, computeCapSpace } from './roster-import.ts';

/** $0, for the one comparison a roster act's money gate makes. */
export const NO_MONEY: Money = parseMoney(0);

/**
 * One Contract as a roster act sees it — the four facts every act's
 * arithmetic is computed from, and nothing else.
 *
 * **`value` is the full amount, never the charged one** (AD-23). An Auction
 * Contract stashed in a Minor League Slot carries a `capHit` of `$0` and a
 * `winningAmount` of whatever it was won for; an imported row carries its
 * full salary whatever Slot it sits in. Both are the same fact — what this
 * Contract is worth — and what it CHARGES is `chargedCapHit`'s answer about
 * the Slot it is in.
 *
 * Structural and minimal, so each act's own row type can carry more: a Trade
 * needs `won` and an assigned length, a Drop needs the imported term and the
 * rookie-scale round, and neither belongs to this module.
 */
export type ActingRow = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** The Slot this Contract occupies on the Team that holds it today. */
	readonly rosterSlotKind: RosterSlotKind;
	/** The full value of the Contract — never the charged Cap Hit. */
	readonly value: Money;
};

/** One Team, identified. The rows it holds are passed alongside, never carried. */
export type ActingTeam = {
	readonly teamId: string;
	readonly teamName: string;
};

/** The folds the contested ground is read from. */
export type ContestState = {
	readonly auctions: OpenAuctions;
	readonly nominations: OpenNominations;
	readonly playerNameFor: (fantraxPlayerId: string) => string;
};

/** Everything `postActMoneyStateFor` needs that is not the Team's own figures. */
export type ActMoneyInputs = {
	readonly auctions: OpenAuctions;
	readonly isMinorLeagueEligible: (fantraxPlayerId: string) => boolean;
	readonly playerNameFor: (fantraxPlayerId: string) => string;
};

/**
 * An amount, rendered for a sheet a Commissioner is about to commit against.
 *
 * **It never declines to state the figure**, and that is the whole difference
 * from `describeAmount`. That renderer answers "an amount that is not on the
 * grid" off the `$500,000` grid, which is the right answer inside a BID
 * refusal — the offered amount is the thing being refused and the granularity
 * sentence beside it already says what is wrong with it. It is the wrong
 * answer on a roster act: an imported Cap Hit is a real-world salary and
 * `rules/roster-import.ts` asserts no grid over it, so a Team's Cap Space
 * legitimately sits off the grid and a sheet that hedged would be asking for
 * a commitment against a number it would not print.
 *
 * **No third renderer is invented** (AD-8). It composes the two
 * `core/money.ts` already exports, choosing between them on `isOnMoneyGrid` —
 * exactly the decision that module's own header says a caller should make
 * before calling either.
 */
export function describeActAmount(amount: Money): string {
	return isOnMoneyGrid(amount) ? formatMoney(amount) : formatExactDollars(amount);
}

/**
 * Whether a Contract may be acted on at all.
 *
 * Dead Money is a charge, not a Player: it occupies no Slot, nobody holds it,
 * and FR-43 keeps it with the Team that released the Contract. It is
 * therefore neither movable nor droppable, and it is stated HERE rather than
 * by a branch in each act's own loop so there is one answer to the question.
 */
export function movable(row: { readonly rosterSlotKind: RosterSlotKind }): boolean {
	return row.rosterSlotKind !== 'dead_money';
}

/** One Team's five figures, derived from the rows it holds and nothing else. */
export function figuresFor(team: ActingTeam, rows: readonly ActingRow[]): RosterActTeamFigures {
	let rosterCount = 0;
	let injuryReserveOccupied = 0;
	let minorLeagueOccupied = 0;
	for (const row of rows) {
		if (row.rosterSlotKind === 'active_bench') rosterCount += 1;
		if (row.rosterSlotKind === 'injury_reserve') injuryReserveOccupied += 1;
		if (row.rosterSlotKind === 'minor_league') minorLeagueOccupied += 1;
	}
	return {
		teamId: team.teamId,
		teamName: team.teamName,
		// `computeCapSpace` is the ONE Cap Space expression, and `chargedCapHit`
		// inside it is the one statement of "a Minor League row charges $0".
		// Handing it `value` rather than a pre-charged figure is what makes a
		// re-placed stash start charging without a second rule saying so.
		capSpace: computeCapSpace(
			rows.map((row) => ({ capHit: row.value, rosterSlotKind: row.rosterSlotKind }))
		).capSpace,
		rosterCount,
		injuryReserveOccupied,
		minorLeagueOccupied
	};
}

/** What one row charges the Team it currently sits on. */
export function chargeOf(row: ActingRow): Money {
	return chargedCapHit({ capHit: row.value, rosterSlotKind: row.rosterSlotKind });
}

/** How many of `rows` sit in a Minor League Slot. */
export function minorsOccupiedIn(rows: readonly ActingRow[]): number {
	return rows.filter((row) => row.rosterSlotKind === 'minor_league').length;
}

/**
 * One Team's committed capital, as it stands AFTER the act.
 *
 * Built ONCE per Team and handed to both of that Team's gates, for
 * `evaluateActSlots`' reason: two derivations from the same inputs cannot
 * disagree, but one derivation cannot even be asked to.
 */
export function postActMoneyStateFor(
	team: ActingTeam,
	after: RosterActTeamFigures,
	state: ActMoneyInputs
): TeamMoneyState {
	return teamMoneyStateFor({
		teamId: team.teamId,
		// **No Auction is excluded**, and that is the difference from a Bid: a
		// Bid excludes the Auction it is being placed on because the post-bid
		// basis adds it back once. A Trade places no Bid and neither does a
		// Drop, so every Auction this Team leads counts exactly as it stands.
		// The empty id names no Player.
		fantraxPlayerId: '',
		capSpace: after.capSpace,
		rosterCount: after.rosterCount,
		minorLeagueOccupied: after.minorLeagueOccupied,
		auctions: state.auctions,
		isMinorLeagueEligible: state.isMinorLeagueEligible,
		playerNameFor: state.playerNameFor
	});
}

/**
 * A roster act's own $0-offer money gate, over one Team's post-act figures.
 *
 * **The verdict is `maximumBid >= 0` and not a comparison**, because neither
 * act offers an amount. What can fail is solvency: §10 example 37's Team is
 * $500,000 richer after sending a Player away and $300,000 short, because the
 * Slot it freed costs $1,000,000 to reserve — and §10 example 40 is the same
 * arithmetic reached by releasing a Player rather than trading one.
 */
export function evaluateActCap(team: ActingTeam, money: TeamMoneyState): ActCapGateOutcome {
	const figures = teamSolvencyFiguresFor(
		// No Auction, no prospective Player, and the phase is not a gate this
		// evaluation reads — `requireOverridablePhase` and the destination
		// catalog are what keep a roster act inside the phases that permit it.
		bidStateFor(null, money, false, 'Auction'),
		'',
		NO_MONEY,
		// `noProspectiveBid`: there is no Bid here, so nothing is projected for
		// one. The Team's existing leads still project — every one of them,
		// Minimum-Bid Contention entries included, because their capital is
		// committed and the Slots it would buy are funded (see
		// `reserveAdditionsFor`). That is the whole of §10 example 37.
		true
	);
	// Unreachable: `teamMoneyStateFor` always returns a Team, so the state's
	// `team` is never `null` here. The guard gives TypeScript the narrowing
	// rather than handling a reachable state.
	if (figures === null) {
		throw new Error('evaluateActCap: the solvency figures came back with no Team');
	}

	const passed = compareMoney(figures.maximumBid, NO_MONEY) >= 0;
	const leadingAuctions: ActLeadingAuction[] = [...money.leading, ...money.eligibleLeading]
		.map((lead) => ({
			fantraxPlayerId: lead.fantraxPlayerId,
			playerName: lead.playerName,
			amount: lead.amount
		}))
		// Two already-sorted lists concatenated are not a sorted list (AD-5).
		.sort((left, right) =>
			left.fantraxPlayerId === right.fantraxPlayerId
				? 0
				: left.fantraxPlayerId < right.fantraxPlayerId
					? -1
					: 1
		);

	return {
		passed,
		teamId: team.teamId,
		teamName: team.teamName,
		capSpace: figures.capSpace,
		committedBids: figures.committedBids,
		minorsExposure: figures.minorsExposure,
		availableCapSpace: figures.availableCapSpace,
		rosterCount: figures.rosterCount,
		projectedAdditions: figures.projectedAdditions,
		rosterReserve: figures.rosterReserve,
		maximumBid: figures.maximumBid,
		// Stated as a positive size rather than as a negative Maximum Bid, so
		// no surface has to negate a Money to say "$300,000 short".
		shortfall: passed ? null : subtractMoney(NO_MONEY, figures.maximumBid),
		leadingAuctions,
		exposingBids: figures.exposingBids
	};
}

/** A roster act's capacity gate, over one Team's post-act figures. */
export function evaluateActSlots(
	team: ActingTeam,
	after: RosterActTeamFigures,
	money: TeamMoneyState
): ActSlotsGateOutcome {
	// **`isContentionEntry: true`, and it is the same choice `noProspectiveBid`
	// makes on the money side, for the same reason.** A roster act places no
	// Bid, so nothing may be projected for one — and `true` is what says so
	// through this parameter. The two parameters are spelled differently
	// because they mean different things wherever a Bid DOES exist; here,
	// where none does, they happen to agree. Read what it does on each
	// derivation it reaches:
	//
	//  - `activeBenchOverflowFor(bound, true)` — the flag only ever suppresses a
	//    `+ 1` guarded by `state.playerIsMinorLeagueEligible`, which is `false`
	//    here, so Active/Bench Overflow is the Team's real eligible leads either
	//    way. The value does not matter to this one.
	//  - `projectedAdditionsFor(bound, true, counts)` — the flag DOES matter
	//    here, and this is why the argument exists: `false` would add
	//    `(eligible || entry ? 0 : 1)` = 1, inventing a prospective Bid the
	//    Commissioner never placed, and refusing §10 example 39's Team F at
	//    Roster Count 11 with an addition nobody asked for.
	//
	// The phase is not a gate this evaluation reads — `requireOverridablePhase`
	// and the destination catalog keep a roster act inside the phases that
	// permit it.
	const capacity = slotCapacityFiguresFor(bidStateFor(null, money, false, 'Auction'), true);
	if (capacity === null) {
		throw new Error('evaluateActSlots: the capacity figures came back with no Team');
	}

	const breaches: RosterSlotKind[] = [];
	// **The explicit ceiling tests, and the Active/Bench one is load-bearing.**
	// `unfilledSlots` clamps at zero, so a Team standing at 14 with nothing
	// outstanding computes `projectedAdditions === 0` and would pass FR-37's
	// first branch. §10 example 39 is that counterfactual, and this line is
	// what makes it unreachable.
	if (after.rosterCount > ACTIVE_BENCH_SLOTS) breaches.push('active_bench');
	if (after.injuryReserveOccupied > INJURY_RESERVE_SLOTS) breaches.push('injury_reserve');
	if (after.minorLeagueOccupied > MINOR_LEAGUE_SLOTS) breaches.push('minor_league');

	return {
		// FR-37's two branches — the ONE expression `evaluateSlots` reads too,
		// called rather than copied — and then the three ceilings. A second
		// spelling of it here is the only thing that could let a roster act
		// admit a roster a Bid would be refused for.
		passed: breaches.length === 0 && activeBenchCapacityHolds(capacity),
		teamId: team.teamId,
		teamName: team.teamName,
		rosterCount: after.rosterCount,
		projectedAdditions: capacity.projectedAdditions,
		freeActiveBenchSlots: capacity.freeActiveBenchSlots,
		allowance: capacity.allowance,
		injuryReserveOccupied: after.injuryReserveOccupied,
		minorLeagueOccupied: after.minorLeagueOccupied,
		activeBenchCeiling: ACTIVE_BENCH_SLOTS,
		injuryReserveCeiling: INJURY_RESERVE_SLOTS,
		minorLeagueCeiling: MINOR_LEAGUE_SLOTS,
		breaches
	};
}

/** Whichever open thing still contests a Player, or `null` if nothing does. */
export function contestOf(state: ContestState, fantraxPlayerId: string): ContestedPlayer | null {
	if (auctionForPlayer(state.auctions, fantraxPlayerId) !== null) {
		return {
			fantraxPlayerId,
			playerName: state.playerNameFor(fantraxPlayerId),
			contest: 'bid'
		};
	}
	const nomination = nominationForPlayer(state.nominations, fantraxPlayerId);
	if (nomination !== null) {
		return {
			fantraxPlayerId,
			playerName: nomination.playerName,
			contest: 'nomination'
		};
	}
	return null;
}

/** A list of names, in words: "A", "A and B", "A, B and C". */
export function inWords(items: readonly string[]): string {
	if (items.length === 0) return '';
	if (items.length === 1) return items[0] ?? '';
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/** The Auctions a Team leads, named — or the stated absence of any. */
export function auctionsInWords(gate: ActCapGateOutcome): string {
	if (gate.leadingAuctions.length === 0) return 'It leads no open Auction.';
	const named = gate.leadingAuctions.map(
		(auction) => `${auction.playerName} at ${describeAmount(auction.amount)}`
	);
	return `It leads ${inWords(named)}.`;
}
