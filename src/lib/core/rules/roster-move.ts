/**
 * Recording a Roster Move: one act, two Teams, one evaluation at the end
 * (Story 7.7, FR-41, §10 examples 36–39 and 42).
 *
 * **One evaluator, and it does no arithmetic of its own.** `evaluateMove`
 * applies the whole Move — every departure on both sides first, then every
 * arrival, re-placed against the receiving Team's occupancy — and hands the
 * resulting state to the SAME two derivations the bidding gates read:
 * `teamSolvencyFiguresFor` for the money and `slotCapacityFiguresFor` for the
 * capacity (AR-42). There is no affordability check in this file, no second
 * Roster Reserve, no second Free Active/Bench Slots and no second Minors
 * Exposure. A Move that could be refused by arithmetic this module wrote
 * itself would be a Move judged by a rule no Bid is judged by.
 *
 * **Why not a synthetic `PlaceBid`.** AD-7 defines the cap gate as
 * single-Team and incremental — it answers "may THIS Team offer THIS amount"
 * — and a Move has two Teams whose deltas point in opposite directions and
 * no amount at all. Forcing one through that gate would either invent an
 * offer or evaluate one Team at a time, and evaluating one Team at a time is
 * exactly the defect §10 example 39 exists to name.
 *
 * **One evaluation, at the END.** Departures apply to both Teams before any
 * arrival is placed, so the transient Roster Count 14 of §10 example 39 is
 * never constructed, let alone judged. Arrivals are then placed **sorted by
 * `fantraxPlayerId`** (AD-5): two eligible Players arriving at a Team with
 * one free Minor League Slot must land the same way on every replay, and a
 * sequence is the only thing that makes that true.
 *
 * **Refuse, never cancel.** A failing gate refuses the WHOLE Move and this
 * module produces nothing to write. No Bid is stood down anywhere: FR-40's
 * cancellation trigger is a Close and only a Close, and nothing here appends,
 * cancels or restores.
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
import type {
	ContractYears,
	RosterMoveTeamFigures,
	RosterMoveTransfer
} from '../projection/contracts.ts';
import { nominationForPlayer } from '../projection/nominations.ts';
import type { OpenNominations } from '../projection/nominations.ts';
import { RECORD_ROSTER_MOVE_GATES } from '../types.ts';
import type {
	ContestedGateOutcome,
	ContestedPlayer,
	MoveCapGateOutcome,
	MoveLeadingAuction,
	MoveSlotsGateOutcome,
	RecordRosterMove,
	RecordRosterMoveGateResults,
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
import { slotPlacementFor } from './close.ts';
import { SLOT_LABELS, chargedCapHit, computeCapSpace } from './roster-import.ts';

/** $0, for the one comparison a Move's money gate makes. */
const NO_MONEY: Money = parseMoney(0);

/**
 * An amount, rendered for a sheet a Commissioner is about to commit against.
 *
 * **It never declines to state the figure**, and that is the whole difference
 * from `describeAmount`. That renderer answers "an amount that is not on the
 * grid" off the `$500,000` grid, which is the right answer inside a BID
 * refusal — the offered amount is the thing being refused and the granularity
 * sentence beside it already says what is wrong with it. It is the wrong
 * answer on a Roster Move: an imported Cap Hit is a real-world salary and
 * `rules/roster-import.ts` asserts no grid over it, so a Team's Cap Space
 * legitimately sits off the grid and a sheet that hedged would be asking for a
 * commitment against a number it would not print.
 *
 * **No third renderer is invented** (AD-8). It composes the two `core/money.ts`
 * already exports, choosing between them on `isOnMoneyGrid` — exactly the
 * decision that module's own header says a caller should make before calling
 * either: the abbreviated `$14.5M` where it is lossless, and grouped exact
 * dollars where it is not.
 */
export function describeMoveAmount(amount: Money): string {
	return isOnMoneyGrid(amount) ? formatMoney(amount) : formatExactDollars(amount);
}

/**
 * One Contract as a Move can move it — the roster row and the fold's own
 * output stated in ONE shape.
 *
 * **`value` is the full amount, never the charged one**, and the distinction
 * is AD-23's. An Auction Contract stashed in a Minor League Slot carries a
 * `capHit` of `$0` and a `winningAmount` of whatever it was won for; an
 * imported row carries its full salary in `team_rosters.cap_hit` whatever
 * Slot it sits in. Both are the same fact — what this Contract is worth —
 * and what it CHARGES is `chargedCapHit`'s answer about the Slot it is in.
 * Carrying the charged figure here instead would lose $18,000,000 the
 * instant §10 example 38's stash landed in Active/Bench.
 *
 * `won` is what tells the two kinds apart where it matters and only there:
 * an Existing Contract is a row in `team_rosters` and moves by an `UPDATE` of
 * `team_id`, while an Auction Contract has no row and moves by the event
 * alone (AR-41). Nothing in this module's arithmetic reads it.
 *
 * `contractYears` is the length an Auction Contract currently carries, which
 * a Move CLEARS (§10 example 42). An imported row's remaining years are not
 * this field and are not cleared: they are the world Fantrax already knows
 * about.
 */
export type MovingPlayer = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** The Slot this Contract occupies on the Team that holds it today. */
	readonly rosterSlotKind: RosterSlotKind;
	/** The full value of the Contract — never the charged Cap Hit. */
	readonly value: Money;
	/** `true` for an Auction Contract, which has no `team_rosters` row. */
	readonly won: boolean;
	readonly contractYears: ContractYears | null;
};

/**
 * One side of a Move: who they are and everything they hold.
 *
 * **The whole roster, Dead Money included.** Cap Space is a sum over every
 * row a Team carries, so handing this module only the movable ones would
 * compute a Cap Space the Teams page disagrees with. Dead Money simply never
 * appears in a transfer — `movable` below is what says so, in one place.
 *
 * No figures are carried. Cap Space, Roster Count and all three occupancies
 * are DERIVED from `rows` on every evaluation, before the Move and after it,
 * which is what makes the before/after pair structurally incapable of being
 * computed two different ways.
 */
export type MovingTeam = {
	readonly teamId: string;
	readonly teamName: string;
	readonly rows: readonly MovingPlayer[];
};

/**
 * Everything a Move is judged against — one snapshot, so no two Teams and no
 * two gates can be judged against different moments.
 *
 * `auctions` and `nominations` are the folds the contested ground reads: a
 * Player with an open Auction or an open nomination is held by nobody, and
 * the Contract that would receive the transfer does not exist yet.
 *
 * `isMinorLeagueEligible` and `playerNameFor` are `teamMoneyStateFor`'s own
 * two functions, threaded straight through — this module asks neither
 * question itself.
 */
export type RosterMoveState = {
	readonly sending: MovingTeam;
	readonly receiving: MovingTeam;
	readonly auctions: OpenAuctions;
	readonly nominations: OpenNominations;
	readonly isMinorLeagueEligible: (fantraxPlayerId: string) => boolean;
	readonly playerNameFor: (fantraxPlayerId: string) => string;
};

/**
 * One Team's five figures, and one Contract's whole journey — both declared
 * in `projection/contracts.ts`, beside the event that carries them.
 *
 * Aliased here rather than restated, because `evaluateMove` builds exactly
 * what `contractsReducer` folds: two structurally identical declarations are
 * the drift Story 4.5's review removed elsewhere in this codebase, and a
 * Move's delta is the one thing in this story that MUST mean the same on
 * both sides of the log.
 */
export type MoveTeamFigures = RosterMoveTeamFigures;
export type MoveTransfer = RosterMoveTransfer;

/** The whole delta: every Player, both Teams, before and after. */
export type RosterMoveDelta = {
	readonly transfers: readonly MoveTransfer[];
	readonly sendingBefore: MoveTeamFigures;
	readonly sendingAfter: MoveTeamFigures;
	readonly receivingBefore: MoveTeamFigures;
	readonly receivingAfter: MoveTeamFigures;
};

/**
 * Why a Move was refused.
 *
 * **Three of the four are about the SHAPE of the act and one is about the
 * gates**, which is the same split `server/bidding.ts` draws between
 * `no_open_auction` and a gate refusal: a malformed act has no arithmetic to
 * show, so the gate results come back `null` rather than as figures computed
 * over a state that could not be built.
 */
export type RosterMoveRefusal =
	| { readonly kind: 'same_team'; readonly teamId: string; readonly teamName: string }
	| { readonly kind: 'names_nothing' }
	| {
			readonly kind: 'named_both_ways';
			readonly fantraxPlayerId: string;
			readonly playerName: string;
	  }
	| {
			readonly kind: 'not_held';
			readonly fantraxPlayerId: string;
			readonly playerName: string;
			readonly teamId: string;
			readonly teamName: string;
	  }
	| { readonly kind: 'gates' };

/** What `evaluateMove` decided. A rejection is a RETURNED value, never a throw. */
export type MoveOutcome =
	| {
			readonly kind: 'refused';
			readonly refusal: RosterMoveRefusal;
			/** The five gates, or `null` when the act's shape stopped them running. */
			readonly gates: RecordRosterMoveGateResults | null;
	  }
	| {
			readonly kind: 'permitted';
			readonly gates: RecordRosterMoveGateResults;
			readonly delta: RosterMoveDelta;
	  };

/**
 * Whether a Contract may travel at all.
 *
 * Dead Money is a charge, not a Player: it occupies no Slot, nobody holds it,
 * and FR-43 keeps it with the Team that released the Contract. It is
 * therefore not movable, and it is stated HERE rather than by a branch in the
 * transfer loop so there is one answer to the question.
 */
function movable(player: MovingPlayer): boolean {
	return player.rosterSlotKind !== 'dead_money';
}

/** One Team's five figures, derived from the rows it holds and nothing else. */
function figuresFor(team: MovingTeam, rows: readonly MovingPlayer[]): MoveTeamFigures {
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
function chargeOf(player: MovingPlayer): Money {
	return chargedCapHit({ capHit: player.value, rosterSlotKind: player.rosterSlotKind });
}

/**
 * Where an arriving Contract lands (FR-41, FR-21).
 *
 * **Sitting in a Minor League Slot IS the eligibility statement.** A rostered
 * Player has no row in `free_agent_players` to consult and the eligibility
 * fold is about the pool, so the Slot he occupies today is the only fact
 * available — and it is the right one, because nothing but eligibility could
 * have put him there. `slotPlacementFor(true, …)` then applies FR-21's
 * ordinary rule against the receiving Team's occupancy, which is what makes
 * §10 example 38 fall out rather than be special-cased.
 *
 * **Active/Bench and Injury Reserve arrive unchanged.** An Active/Bench
 * Player is not made eligible by being traded, and IR is a Fantrax fact about
 * a Player's health rather than a placement this app assigns — re-placing an
 * IR row would be this app inventing a medical opinion.
 */
function arrivalPlacementFor(
	player: MovingPlayer,
	receivingMinorLeagueOccupied: number
): RosterSlotKind {
	if (player.rosterSlotKind !== 'minor_league') return player.rosterSlotKind;
	return slotPlacementFor(true, receivingMinorLeagueOccupied);
}

/** How many of `rows` sit in a Minor League Slot. */
function minorsOccupiedIn(rows: readonly MovingPlayer[]): number {
	return rows.filter((row) => row.rosterSlotKind === 'minor_league').length;
}

/**
 * One Team's committed capital, as it stands AFTER the Move.
 *
 * Built ONCE per Team and handed to both of that Team's gates, for
 * `evaluateSlots`' reason: two derivations from the same inputs cannot
 * disagree, but one derivation cannot even be asked to.
 */
function postMoveMoneyStateFor(
	team: MovingTeam,
	after: MoveTeamFigures,
	state: RosterMoveState
): TeamMoneyState {
	return teamMoneyStateFor({
		teamId: team.teamId,
		// **No Auction is excluded**, and that is the difference from a Bid: a
		// Bid excludes the Auction it is being placed on because the post-bid
		// basis adds it back once. A Move places no Bid, so every Auction this
		// Team leads counts exactly as it stands. The empty id names no Player.
		fantraxPlayerId: '',
		capSpace: after.capSpace,
		rosterCount: after.rosterCount,
		minorLeagueOccupied: after.minorLeagueOccupied,
		auctions: state.auctions,
		isMinorLeagueEligible: state.isMinorLeagueEligible,
		playerNameFor: state.playerNameFor
	});
}

/** A Move's own $0-offer money gate, over one Team's post-Move figures. */
function evaluateMoveCap(
	team: MovingTeam,
	money: TeamMoneyState
): MoveCapGateOutcome {
	const figures = teamSolvencyFiguresFor(
		// No Auction, no prospective Player, and the phase is not a gate this
		// evaluation reads — `requireOverridablePhase` and the destination
		// catalog are what keep a Move inside the two phases FR-41 permits.
		bidStateFor(null, money, false, 'Auction'),
		'',
		NO_MONEY,
		// There is no prospective Bid, so nothing is projected for one. The
		// Team's existing leads still project, which is the whole of §10
		// example 37.
		true
	);
	// Unreachable: `teamMoneyStateFor` always returns a Team, so the state's
	// `team` is never `null` here. The guard gives TypeScript the narrowing
	// rather than handling a reachable state.
	if (figures === null) {
		throw new Error('evaluateMoveCap: the solvency figures came back with no Team');
	}

	const passed = compareMoney(figures.maximumBid, NO_MONEY) >= 0;
	const leadingAuctions: MoveLeadingAuction[] = [...money.leading, ...money.eligibleLeading]
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

/** A Move's capacity gate, over one Team's post-Move figures. */
function evaluateMoveSlots(
	team: MovingTeam,
	after: MoveTeamFigures,
	money: TeamMoneyState
): MoveSlotsGateOutcome {
	// **`isContentionEntry: true`, and it is the same choice `prospectiveBidIsExempt`
	// makes on the money side, for the same reason.** A Move places no Bid, so
	// nothing may be projected for one — and `true` is what says so through this
	// parameter. Read what it does on each derivation it reaches:
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
	// and the destination catalog keep a Move inside the two phases FR-41 permits.
	const capacity = slotCapacityFiguresFor(bidStateFor(null, money, false, 'Auction'), true);
	if (capacity === null) {
		throw new Error('evaluateMoveSlots: the capacity figures came back with no Team');
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
		// called rather than copied — and then FR-41's three ceilings. A second
		// spelling of it here is the only thing that could let a Move admit a
		// roster a Bid would be refused for.
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
function contestOf(state: RosterMoveState, fantraxPlayerId: string): ContestedPlayer | null {
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

/**
 * Evaluate one Roster Move: apply the whole act, then judge the result once.
 *
 * The order inside is the rule (FR-41):
 *
 *  1. the act's SHAPE — two distinct Teams, and at least one Player named;
 *  2. the CONTESTED ground, before cap and slots, because neither has
 *     anything to say about a Player nobody holds;
 *  3. every remaining named Player is HELD by the Team said to be sending
 *     him — a malformed act, with no figures to show;
 *  4. departures on both sides, then arrivals sorted by `fantraxPlayerId`;
 *  5. the four money and capacity gates, ONCE, over the resulting state.
 *
 * A contested Player is excluded from the delta rather than moved: there is
 * no Contract to move, and constructing one out of an open Auction would
 * manufacture a Player nobody has won. The other four gates still run, and
 * still report what the rest of the Move would have done — no gate
 * short-circuits another (AD-7).
 */
export function evaluateMove(state: RosterMoveState, command: RecordRosterMove): MoveOutcome {
	if (command.sendingTeamId === command.receivingTeamId) {
		return {
			kind: 'refused',
			refusal: {
				kind: 'same_team',
				teamId: command.sendingTeamId,
				teamName: command.sendingTeamName
			},
			gates: null
		};
	}
	if (command.sendingPlayerIds.length === 0 && command.receivingPlayerIds.length === 0) {
		return { kind: 'refused', refusal: { kind: 'names_nothing' }, gates: null };
	}

	// **A Player named in BOTH directions is incoherent, and is refused as the
	// act it is rather than silently resolved into a different one.**
	//
	// He cannot travel both ways, and picking one of them for the Commissioner
	// would commit a Move nobody agreed: a Contract that appears on both sides
	// means the two lists disagree about who holds him, which is a mistake in
	// the act and not a preference to be settled by iteration order. Refused
	// here with the shape grounds, BEFORE `contested`, because there is no
	// coherent post-Move state to evaluate any gate against.
	//
	// Note what this does NOT refuse: the same Player named twice in the SAME
	// direction, which says one thing twice. That is deduplicated below.
	const bothWays = command.sendingPlayerIds.find((id) =>
		command.receivingPlayerIds.includes(id)
	);
	if (bothWays !== undefined) {
		const held =
			state.sending.rows.find((row) => row.fantraxPlayerId === bothWays) ??
			state.receiving.rows.find((row) => row.fantraxPlayerId === bothWays);
		return {
			kind: 'refused',
			refusal: {
				kind: 'named_both_ways',
				fantraxPlayerId: bothWays,
				playerName: held?.playerName ?? state.playerNameFor(bothWays)
			},
			gates: null
		};
	}

	// Every named Player, in one list with the side that is said to hold him.
	//
	// **Deduplicated on the Player**, because a Contract cannot travel twice in
	// one act: a form that posted the same id twice would otherwise be applied
	// twice and count him twice in the receiving Team's Roster Count. Naming
	// him twice in one direction says one thing twice, so the repeat is
	// dropped and the act is unchanged — the OPPOSING case, where the two
	// directions disagree about who holds him, was refused outright above.
	const named: Array<{
		readonly fantraxPlayerId: string;
		readonly from: MovingTeam;
		readonly to: MovingTeam;
	}> = [];
	const alreadyNamed = new Set<string>();
	for (const entry of [
		...command.sendingPlayerIds.map((fantraxPlayerId) => ({
			fantraxPlayerId,
			from: state.sending,
			to: state.receiving
		})),
		...command.receivingPlayerIds.map((fantraxPlayerId) => ({
			fantraxPlayerId,
			from: state.receiving,
			to: state.sending
		}))
	]) {
		if (alreadyNamed.has(entry.fantraxPlayerId)) continue;
		alreadyNamed.add(entry.fantraxPlayerId);
		named.push(entry);
	}

	const contested: ContestedPlayer[] = [];
	for (const entry of named) {
		const contest = contestOf(state, entry.fantraxPlayerId);
		if (contest !== null) contested.push(contest);
	}
	const contestedIds = new Set(contested.map((player) => player.fantraxPlayerId));
	const contestedGate: ContestedGateOutcome = { passed: contested.length === 0, contested };

	// The Players that will actually travel — everything named that an open
	// Auction is not still deciding.
	const moving = named.filter((entry) => !contestedIds.has(entry.fantraxPlayerId));

	type Departure = {
		readonly player: MovingPlayer;
		readonly from: MovingTeam;
		readonly to: MovingTeam;
	};
	const departures: Departure[] = [];
	for (const entry of moving) {
		const player = entry.from.rows.find(
			(row) => row.fantraxPlayerId === entry.fantraxPlayerId && movable(row)
		);
		if (player === undefined) {
			return {
				kind: 'refused',
				refusal: {
					kind: 'not_held',
					fantraxPlayerId: entry.fantraxPlayerId,
					playerName: state.playerNameFor(entry.fantraxPlayerId),
					teamId: entry.from.teamId,
					teamName: entry.from.teamName
				},
				gates: null
			};
		}
		departures.push({ player, from: entry.from, to: entry.to });
	}

	const sendingBefore = figuresFor(state.sending, state.sending.rows);
	const receivingBefore = figuresFor(state.receiving, state.receiving.rows);

	// **Departures first, on BOTH Teams, before any arrival is placed.** This
	// is the whole of §10 example 39: the transient state in which one side
	// holds both what it kept and what it is about to receive is never
	// constructed, so it can never be judged.
	const leavingIds = new Set(departures.map((departure) => departure.player.fantraxPlayerId));
	const sendingRows: MovingPlayer[] = state.sending.rows.filter(
		(row) => !leavingIds.has(row.fantraxPlayerId)
	);
	const receivingRows: MovingPlayer[] = state.receiving.rows.filter(
		(row) => !leavingIds.has(row.fantraxPlayerId)
	);

	// **Arrivals sorted by `fantraxPlayerId`** (AD-5): two eligible Players
	// arriving at a Team with one free Minor League Slot must land the same
	// way on every replay, and the sort is what makes that a sequence rather
	// than an accident of the form's field order.
	const arrivals = [...departures].sort((left, right) =>
		left.player.fantraxPlayerId === right.player.fantraxPlayerId
			? 0
			: left.player.fantraxPlayerId < right.player.fantraxPlayerId
				? -1
				: 1
	);

	const transfers: MoveTransfer[] = [];
	for (const arrival of arrivals) {
		const landing = arrival.to.teamId === state.sending.teamId ? sendingRows : receivingRows;
		const toPlacement = arrivalPlacementFor(arrival.player, minorsOccupiedIn(landing));
		const arrived: MovingPlayer = { ...arrival.player, rosterSlotKind: toPlacement };
		landing.push(arrived);
		transfers.push({
			fantraxPlayerId: arrival.player.fantraxPlayerId,
			playerName: arrival.player.playerName,
			fromTeamId: arrival.from.teamId,
			fromTeamName: arrival.from.teamName,
			toTeamId: arrival.to.teamId,
			toTeamName: arrival.to.teamName,
			won: arrival.player.won,
			fromPlacement: arrival.player.rosterSlotKind,
			toPlacement,
			capHitBefore: chargeOf(arrival.player),
			capHitAfter: chargeOf(arrived),
			// Unchanged by the act, and stated beside the two Cap Hits so the
			// pair can be read without anybody deriving one from the other
			// (AD-23, §10 example 38).
			winningAmount: arrival.player.value,
			// FR-41 clears an assigned length on transfer (§10 example 42). The
			// field records what was cleared so the Audit Log can say so; the
			// year returns to the sending Team by arithmetic, because the Year
			// Allotment is a count over the current folded lengths.
			clearedContractYears: arrival.player.contractYears
		});
	}

	const sendingAfter = figuresFor(state.sending, sendingRows);
	const receivingAfter = figuresFor(state.receiving, receivingRows);

	// **One evaluation, at the end, over the state the whole act produced.**
	const sendingMoney = postMoveMoneyStateFor(state.sending, sendingAfter, state);
	const receivingMoney = postMoveMoneyStateFor(state.receiving, receivingAfter, state);
	const gates: RecordRosterMoveGateResults = {
		contested: contestedGate,
		sendingCap: evaluateMoveCap(state.sending, sendingMoney),
		sendingSlots: evaluateMoveSlots(state.sending, sendingAfter, sendingMoney),
		receivingCap: evaluateMoveCap(state.receiving, receivingMoney),
		receivingSlots: evaluateMoveSlots(state.receiving, receivingAfter, receivingMoney)
	};

	if (!allMoveGatesPassed(gates)) {
		return { kind: 'refused', refusal: { kind: 'gates' }, gates };
	}

	return {
		kind: 'permitted',
		gates,
		delta: { transfers, sendingBefore, sendingAfter, receivingBefore, receivingAfter }
	};
}

/**
 * Whether every gate in `RECORD_ROSTER_MOVE_GATES` passed.
 *
 * Iterates the frozen NAME LIST rather than the result object's own keys, for
 * `allRestoreGatesPassed`'s reason: a result that somehow lost a key would
 * otherwise pass by having nothing to fail, and adding a sixth gate name
 * would silently go unchecked.
 */
export function allMoveGatesPassed(gates: RecordRosterMoveGateResults): boolean {
	return RECORD_ROSTER_MOVE_GATES.every((gate) => gates[gate].passed);
}

/** A list of names, in words: "A", "A and B", "A, B and C". */
function inWords(items: readonly string[]): string {
	if (items.length === 0) return '';
	if (items.length === 1) return items[0] ?? '';
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/** The Auctions a Team leads, named — or the stated absence of any. */
function auctionsInWords(gate: MoveCapGateOutcome): string {
	if (gate.leadingAuctions.length === 0) return 'It leads no open Auction.';
	const named = gate.leadingAuctions.map(
		(auction) => `${auction.playerName} at ${describeAmount(auction.amount)}`
	);
	return `It leads ${inWords(named)}.`;
}

/**
 * The one sentence a refused Move is reported by — the Team, the gate, the
 * Auction and the arithmetic (FR-41).
 *
 * **It never offers to cancel a Bid.** FR-40's cancellation trigger is a
 * Close and only a Close, so the remedies this wording states are the two
 * FR-41 allows: wait for the Auction to close, or void the Bid under FR-32.
 *
 * Every failing gate is reported, not the first: a Commissioner told about
 * one Team's shortfall who then hits the other Team's ceiling has been made
 * to retry for no reason.
 */
export function rosterMoveRefusalDetail(
	refusal: RosterMoveRefusal,
	gates: RecordRosterMoveGateResults | null
): string {
	switch (refusal.kind) {
		case 'same_team':
			return `A Roster Move is between two Teams. ${refusal.teamName} is named on both sides of this one.`;
		case 'names_nothing':
			return 'This Move names no Players. A Move may send in one direction only, but it must move something.';
		case 'named_both_ways':
			return `${refusal.playerName} is named on both sides of this Move. A Contract travels one way or the other, never both, so the Move says two things that cannot both be true.`;
		case 'not_held':
			return `${refusal.playerName} is not a Contract ${refusal.teamName} holds, so there is nothing for this Move to transfer.`;
		case 'gates': {
			if (gates === null) return 'The Move was refused.';
			const sentences: string[] = [];
			if (!gates.contested.passed) {
				const named = gates.contested.contested.map((player) =>
					player.contest === 'bid'
						? `${player.playerName} is being bid on in an open Auction`
						: `${player.playerName} is nominated and awaiting an opening Bid`
				);
				sentences.push(
					`${inWords(named)}. No Team holds a settled Contract on ${gates.contested.contested.length === 1 ? 'him' : 'them'} yet, so ${gates.contested.contested.length === 1 ? 'he cannot' : 'they cannot'} be moved until that Auction closes.`
				);
			}
			for (const gate of [gates.sendingCap, gates.receivingCap]) {
				if (gate.passed) continue;
				sentences.push(
					`${gate.teamName} cannot cover what it is already committed to after this Move. ` +
						`Cap Space ${formatExactDollars(gate.capSpace)}, Committed Bids ${formatExactDollars(gate.committedBids)}, ` +
						`Roster Reserve ${formatExactDollars(gate.rosterReserve)} — a shortfall of ${formatExactDollars(gate.shortfall ?? NO_MONEY)}. ` +
						`${auctionsInWords(gate)} Wait for it to close or void the Bid; the Move will not cancel it.`
				);
			}
			for (const gate of [gates.sendingSlots, gates.receivingSlots]) {
				if (gate.passed) continue;
				if (gate.breaches.length > 0) {
					const named = gate.breaches.map((kind) => {
						const held =
							kind === 'active_bench'
								? gate.rosterCount
								: kind === 'injury_reserve'
									? gate.injuryReserveOccupied
									: gate.minorLeagueOccupied;
						const ceiling =
							kind === 'active_bench'
								? gate.activeBenchCeiling
								: kind === 'injury_reserve'
									? gate.injuryReserveCeiling
									: gate.minorLeagueCeiling;
						return `${String(held)} ${SLOT_LABELS[kind]} against a ceiling of ${String(ceiling)}`;
					});
					sentences.push(`${gate.teamName} would stand at ${inWords(named)}.`);
					continue;
				}
				sentences.push(
					`${gate.teamName} has no room for what it still has outstanding: Roster Count ${String(gate.rosterCount)}, ` +
						`Free Active/Bench Slots ${String(gate.freeActiveBenchSlots)}, ` +
						`Projected Additions ${String(gate.projectedAdditions)} against an allowance of ${String(gate.allowance)}.`
				);
			}
			return sentences.join(' ');
		}
	}
}

/**
 * The Cap Hit a re-placement changed, stated in words — the sentence FR-41
 * requires on the reason sheet before a Move commits.
 *
 * `null` where the charge did not move, because the sheet's amber marker is
 * the product's single attention colour and a sheet that marks every row
 * marks nothing.
 */
export function capHitChangeSentence(transfer: MoveTransfer): string | null {
	if (compareMoney(transfer.capHitBefore, transfer.capHitAfter) === 0) return null;
	return (
		`${transfer.playerName} moves from ${SLOT_LABELS[transfer.fromPlacement]} to ` +
		`${SLOT_LABELS[transfer.toPlacement]}, so his Cap Hit changes from ` +
		`${describeMoveAmount(transfer.capHitBefore)} to ` +
		`${describeMoveAmount(transfer.capHitAfter)} on ${transfer.toTeamName}. His winning ` +
		`amount is unchanged at ${describeMoveAmount(transfer.winningAmount)}.`
	);
}

/**
 * The assigned contract length a Move CLEARS, stated in words (§10 example 42,
 * FR-41).
 *
 * **The second consequence the two states do not show, and the one that has
 * no arithmetic to give it away.** §10 example 42's Powell charges $9,000,000
 * before the Move and $9,000,000 after it, so `capHitChangeSentence` answers `null`
 * and the sheet would otherwise carry no warning at all — while the Move wipes
 * the 3-year length the sending Team spent its single allotment on, returns
 * that year to it, leaves the Player unassigned on the receiving Team, and
 * re-blocks the FR-30 export until somebody assigns again.
 *
 * `null` where nothing was assigned, which is every Move during the Auction
 * Phase and every Move of an Existing Contract: the amber marker is the
 * product's single attention colour, and a sheet that marks every row marks
 * nothing.
 *
 * Both sentences may apply to one transfer — a stashed Player with a length,
 * re-placed on arrival — and the sheet carries both on the row.
 */
export function clearedLengthSentence(transfer: MoveTransfer): string | null {
	const years = transfer.clearedContractYears;
	if (years === null) return null;
	const term = years === 1 ? '1-year' : `${String(years)}-year`;
	return (
		`${transfer.playerName} carries an assigned ${term} contract, and moving him CLEARS it. ` +
		`The ${term} returns to ${transfer.fromTeamName}'s Year Allotment and he arrives on ` +
		`${transfer.toTeamName} unassigned, so the Fantrax export stays blocked until ` +
		`${transfer.toTeamName} assigns him a length of its own.`
	);
}

/**
 * Every consequence one transfer carries that its two states do not show, as
 * one sentence — or `null` where it carries none.
 *
 * The sheet renders ONE `attention` string per row, so the two sentences above
 * are joined here rather than at the render site: a caller choosing between
 * them would have to know which takes precedence, and the answer is neither.
 */
export function transferAttention(transfer: MoveTransfer): string | null {
	const sentences = [capHitChangeSentence(transfer), clearedLengthSentence(transfer)].filter(
		(sentence): sentence is string => sentence !== null
	);
	return sentences.length === 0 ? null : sentences.join(' ');
}

/**
 * `slotPlacementFor` re-exported, because it is the rule a Move REUSES rather
 * than restates.
 *
 * `rules/close.ts` owns "an eligible Player takes a free Minor League Slot if
 * one exists and Active/Bench otherwise" (FR-21), and `arrivalPlacementFor`
 * above calls it verbatim. Re-exporting it here lets a caller reading a Move's
 * placement reach the one definition rather than a copy.
 *
 * **`capHitFor` is deliberately NOT here.** Nothing in a Move calls it: the
 * charge a Contract makes is `chargedCapHit`'s answer, which covers all four
 * `RosterSlotKind` values — an Injury Reserve row charges in full and a Move
 * can carry one — while `capHitFor` answers only the two-member
 * `SlotPlacement`. And `contractsReducer` reads `capHitAfter` off the payload
 * this module computed rather than re-deriving it, so there is no second
 * caller to serve.
 */
export { slotPlacementFor };
