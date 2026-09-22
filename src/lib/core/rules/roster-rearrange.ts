/**
 * Rearranging one Team's own Slot placements: one act, one Team, one
 * evaluation at the end (Story 7.11, FR-44, §10 examples 44, 45 and 46).
 *
 * **Placement comes from the COMMAND.** Every other placement in this
 * codebase goes through `slotPlacementFor`, which is FR-21's automatic rule
 * against the Team's occupancy at that instant — what a Close applies, and
 * what a Trade applies to an arrival. A Move that re-derived placement would
 * take the demotion the Manager just asked for and put the Contract straight
 * back in the Slot it left, so the Move it just recorded would silently undo
 * itself. `slotPlacementFor` is therefore not imported here, and that absence
 * is the requirement rather than an omission.
 *
 * **Departures from every Slot before any arrival is placed.** §10 example 44
 * is a swap on a Team standing at three of three Minor League Slots: demote
 * one leg first and occupancy transiently reads FOUR, breaching a ceiling the
 * act itself never breaches and refusing a legal rearrangement on a state
 * that never existed. Every named row is removed from the roster and then
 * re-placed at its commanded Slot, and the figures are derived ONCE, at the
 * end, over what the Team is left holding. The transient is unreachable
 * because it is never constructed.
 *
 * **It does no arithmetic of its own** (AR-42). Cap and capacity come from
 * `rules/roster-act.ts`, which is the evaluation a Trade and a Drop already
 * run; this file writes no third statement of solvency, capacity, Cap Space
 * or the charged-Cap-Hit rule. It is the THIRD caller of that shared
 * evaluator, which is the count AR-44 gets right.
 *
 * **Two eligibilities, and they answer different questions.** The POOL FLAG
 * (`projection/eligibility.ts`) says whether a contested Player, if won,
 * could be stashed — it is what `postActMoneyStateFor` reads to compute
 * Minors Exposure, and it is handed through untouched. PLACEMENT eligibility
 * is this module's own predicate: the pool flag UNION every Contract the app
 * has ever observed in a Minor League Slot (`projection/minors-history.ts`).
 * §10 example 46 is why the second half exists — Vassell and Thompson are
 * indistinguishable in `team_rosters`, and only the log tells them apart.
 * **Demotion to Active/Bench consults neither.**
 *
 * **Refuse, never cancel.** A failing gate refuses the WHOLE Move and this
 * module produces nothing to write. No Bid is stood down anywhere: FR-40's
 * cancellation trigger is a Close and only a Close.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { compareMoney, formatExactDollars, subtractMoney } from '../money.ts';
import type { Money } from '../money.ts';
import type { OpenAuctions } from '../projection/auctions.ts';
import type {
	RosterActTeamFigures,
	RosterRearrangedMove
} from '../projection/contracts.ts';
import type { OpenNominations } from '../projection/nominations.ts';
import { REARRANGE_ROSTER_GATES, ROSTER_PLACEMENTS } from '../types.ts';
import type {
	ActCapGateOutcome,
	ContestedGateOutcome,
	ContestedPlayer,
	RearrangeRoster,
	RearrangeRosterGateResults,
	RosterSlotKind
} from '../types.ts';
import {
	NO_MONEY,
	auctionsInWords,
	chargeOf,
	contestOf,
	describeActAmount,
	evaluateActCap,
	evaluateActSlots,
	figuresFor,
	inWords,
	movable,
	postActMoneyStateFor
} from './roster-act.ts';
import { bidStateFor, teamSolvencyFiguresFor } from './bidding.ts';
import type { TeamMoneyState } from './bidding.ts';
import { SLOT_LABELS } from './roster-import.ts';

/**
 * The three Slots a Move may name, as a source or as a target.
 *
 * **Injury Reserve IS rearrangeable, and Dead Money is still not a Slot**
 * (FR-44). The two exclusions were once one sentence and they were never the
 * same rule: Dead Money is a charge and not a Player — nobody holds it, it
 * occupies nothing, and `movable` says so for every roster act — while Injury
 * Reserve is an ordinary Slot with an ordinary ceiling that a Team's roster
 * genuinely occupies.
 *
 * IR was withheld because placing a Contract there is a claim about a player's
 * health, which is Fantrax's fact and not this app's. That reasoning holds for
 * a Manager and does not hold for the Commissioner, who is RECORDING a
 * placement the league already made — the same thing every other act on this
 * surface does, and the same reason the Move is Commissioner-only at all
 * (`server/destinations.ts`). The League's own IR designation is not a medical
 * opinion this app invents; it is a fact the Cap arithmetic has to see, because
 * an IR Contract charges in full and drops out of Roster Count, and until this
 * change the only way to state it was to re-import the whole roster.
 *
 * Stated once, HERE, so the picker offering three targets is a courtesy rather
 * than the check. `ROSTER_PLACEMENTS` is the union asked for rather than a
 * fourth literal list: a Contract's placements and a Move's namable Slots are
 * the same set, and writing them twice would let them drift.
 */
export const REARRANGEABLE_SLOTS: readonly RosterSlotKind[] = ROSTER_PLACEMENTS;

/** Whether one Slot kind may be the source or the target of a Move. */
export function isRearrangeableSlot(kind: RosterSlotKind): boolean {
	return REARRANGEABLE_SLOTS.includes(kind);
}

/**
 * One Contract as a Move can re-place it.
 *
 * An `ActingRow` — the four facts every roster act's arithmetic is computed
 * from — plus `won`, which decides whether the Contract moves by an `UPDATE`
 * of its `team_rosters` row or by the appended event alone.
 *
 * **`value` is the full amount, never the charged one** (AD-23), exactly as a
 * Trade's `TradingPlayer` and a Drop's `DroppablePlayer` carry it. What the
 * Contract CHARGES is `chargedCapHit`'s answer about the Slot it is in, and
 * a Move is precisely the act that changes that answer without changing the
 * value.
 *
 * Unlike a Drop, a Move needs no imported term and no rookie-scale round:
 * FR-43's exception is about releasing a Contract, and a Move releases
 * nothing.
 */
export type RearrangingPlayer = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** The Slot this Contract occupies today. */
	readonly rosterSlotKind: RosterSlotKind;
	/** The full value of the Contract — never the charged Cap Hit. */
	readonly value: Money;
	/** `true` for an Auction Contract, which has no `team_rosters` row. */
	readonly won: boolean;
};

/**
 * The Team a Move acts on: who they are and everything they hold.
 *
 * **The whole roster, Dead Money included.** Cap Space is a sum over every row
 * a Team carries, so handing this module only the movable ones would compute a
 * Cap Space the Teams page disagrees with. Dead Money cannot be NAMED in a
 * Move — `movable` and `isRearrangeableSlot` both say so — but it still
 * counts.
 *
 * No figures are carried. Cap Space, Roster Count and all three occupancies
 * are DERIVED from `rows` on every evaluation, before the Move and after it,
 * which is what makes the before/after pair structurally incapable of being
 * computed two different ways.
 */
export type RearrangingTeam = {
	readonly teamId: string;
	readonly teamName: string;
	readonly rows: readonly RearrangingPlayer[];
};

/**
 * Everything a Move is judged against — one snapshot, so no two gates can be
 * judged against different moments.
 *
 * `isMinorLeagueEligible` is the POOL FLAG and is handed straight through to
 * `postActMoneyStateFor`; `hasEverOccupiedMinorLeague` is the observation
 * fold. `mayOccupyMinorLeague` below is the only place the two are combined,
 * and neither input is widened to reach the other.
 */
export type RosterRearrangeState = {
	readonly team: RearrangingTeam;
	readonly auctions: OpenAuctions;
	readonly nominations: OpenNominations;
	/** The pool flag — Minors Exposure's input, never placement's whole answer. */
	readonly isMinorLeagueEligible: (fantraxPlayerId: string) => boolean;
	/** The observation fold — every Minor League Slot the app has ever seen. */
	readonly hasEverOccupiedMinorLeague: (fantraxPlayerId: string) => boolean;
	readonly playerNameFor: (fantraxPlayerId: string) => string;
};

/** One Team's five figures, declared in `projection/contracts.ts` beside the event. */
export type RearrangeTeamFigures = RosterActTeamFigures;
export type RearrangeMove = RosterRearrangedMove;

/** The whole delta: every re-placed Contract, and the Team before and after. */
export type RosterRearrangeDelta = {
	readonly moves: readonly RearrangeMove[];
	readonly before: RearrangeTeamFigures;
	readonly after: RearrangeTeamFigures;
};

/**
 * Why a Move was refused.
 *
 * **Four of the five are about the SHAPE of the act and one is about the
 * gates**, which is `RosterDropRefusal`'s own split: a malformed act has no
 * arithmetic to show, so the gate results come back `null` rather than as
 * figures computed over a state that could not be built.
 */
export type RosterRearrangeRefusal =
	| { readonly kind: 'names_nothing' }
	| {
			readonly kind: 'not_held';
			readonly fantraxPlayerId: string;
			readonly playerName: string;
			readonly teamId: string;
			readonly teamName: string;
	  }
	| {
			readonly kind: 'unmovable_slot';
			readonly fantraxPlayerId: string;
			readonly playerName: string;
			readonly teamName: string;
			readonly fromPlacement: RosterSlotKind;
			readonly toPlacement: RosterSlotKind;
	  }
	| {
			readonly kind: 'never_observed_eligible';
			readonly fantraxPlayerId: string;
			readonly playerName: string;
			readonly teamName: string;
	  }
	| { readonly kind: 'gates' };

/**
 * What `evaluateRearrange` decided. A rejection is a RETURNED value, never a
 * throw.
 *
 * **`capBefore` rides the permitted outcome and is not part of the delta.**
 * It is the SECOND call of `evaluateActCap` — over the Team's figures as they
 * stand BEFORE the act — and it exists so the sheet can state which way
 * Maximum Bid actually moved rather than assert a direction. It is deliberately
 * not written to the event payload: the payload records what happened, and
 * this is a counterfactual computed for the reader.
 *
 * **`maximumBid` is the MANAGER-FACING pair, and it is not the gates'.** See
 * `managerMaximumBidFor` — the gate's `maximumBid` is a solvency headroom
 * that projects no Bid, while the figure a Manager knows as Maximum Bid
 * counts the Bid about to be placed (FR-12, PRD §3). Both belong on the
 * outcome: the gates decide with theirs, the sheet speaks with this one.
 */
export type RearrangeOutcome =
	| {
			readonly kind: 'refused';
			readonly refusal: RosterRearrangeRefusal;
			/** The three gates, or `null` when the act's shape stopped them running. */
			readonly gates: RearrangeRosterGateResults | null;
	  }
	| {
			readonly kind: 'permitted';
			readonly gates: RearrangeRosterGateResults;
			readonly delta: RosterRearrangeDelta;
			/** `evaluateActCap` over the BEFORE figures — the direction's other half. */
			readonly capBefore: ActCapGateOutcome;
			/** The Manager's own Maximum Bid, before and after — what the sheet states. */
			readonly maximumBid: MaximumBidPair;
	  };

/**
 * One Team's Maximum Bid either side of the act — the figure a Manager knows
 * by that name, not the gate's.
 */
export type MaximumBidPair = {
	readonly before: Money;
	readonly after: Money;
};

/**
 * The Maximum Bid a Manager would see, over one post-act money state.
 *
 * **Why this is not `evaluateActCap`'s `maximumBid`, and why both exist.**
 * The gate passes `prospectiveBidIsExempt: true`, because a Move places no
 * Bid and projecting one would invent a commitment nobody made — that is the
 * right question for a GATE, whose verdict is only `maximumBid >= 0`. But
 * "Maximum Bid" is a defined term with a different meaning: FR-12 and the §3
 * glossary both count the Bid being placed, which is what makes it the
 * largest amount a Team could actually offer. §10 example 45 is stated in
 * that figure — $7,000,000 rising to $18,000,000 — and the sheet has to quote
 * the number a Manager will recognise from the board rather than a solvency
 * headroom that happens to share a field name.
 *
 * The two coincide before the act in §10 example 45 and differ by exactly one
 * Slot's reserve after it, which is precisely how a stale reading of this
 * hides: the before figure agrees, so only the gain is wrong.
 *
 * **A second CALL, never a second expression** (AR-42). `false` is the
 * default `evaluateCap` itself passes; nothing here computes a reserve, an
 * exposure or an available Cap Space of its own.
 */
export function managerMaximumBidFor(money: TeamMoneyState): Money {
	const figures = teamSolvencyFiguresFor(
		bidStateFor(null, money, 'Auction'),
		'',
		NO_MONEY,
		false
	);
	// Unreachable for `postActMoneyStateFor`'s output, which always carries a
	// Team — the guard is the narrowing, not a reachable state, exactly as
	// `evaluateActCap`'s own is.
	if (figures === null) {
		throw new Error('managerMaximumBidFor: the solvency figures came back with no Team');
	}
	return figures.maximumBid;
}

/**
 * Whether a Contract may occupy a Minor League Slot — the PLACEMENT
 * predicate, and it is not the pool flag (FR-44, §10 example 46).
 *
 * **Union, and both halves are load-bearing.** The pool flag alone refuses
 * Brooks, an imported stash sitting in a Minor League Slot right now with no
 * pool row, from ever being put back where he already is. The observation
 * fold alone refuses Ellis, won at auction and flagged eligible, from being
 * stashed the moment a Trade lands him in Active/Bench — §10 example 44 says
 * he is eligible *because the pool says so*.
 *
 * **Demotion is not asked.** Nothing calls this for a move to Active/Bench:
 * FR-44 says demotion requires no eligibility at all, and asking anyway would
 * make a Contract the app has never observed permanently unmovable in either
 * direction.
 */
export function mayOccupyMinorLeague(
	state: RosterRearrangeState,
	fantraxPlayerId: string
): boolean {
	return (
		state.isMinorLeagueEligible(fantraxPlayerId) ||
		state.hasEverOccupiedMinorLeague(fantraxPlayerId)
	);
}

/** Ascending by `fantraxPlayerId` (AD-5) — the one comparator this file sorts by. */
function byPlayerId(left: { fantraxPlayerId: string }, right: { fantraxPlayerId: string }): number {
	if (left.fantraxPlayerId === right.fantraxPlayerId) return 0;
	return left.fantraxPlayerId < right.fantraxPlayerId ? -1 : 1;
}

/**
 * Evaluate one Move: apply the whole act, then judge the result once.
 *
 * The order inside is the rule (FR-44):
 *
 *  1. the act's SHAPE — at least one Contract named;
 *  2. the CONTESTED ground, before cap and slots, because neither has
 *     anything to say about a Player nobody holds;
 *  3. every remaining named Contract is HELD by this Team, leaves and enters
 *     a rearrangeable Slot, and — for a promotion only — may occupy a Minor
 *     League Slot at all;
 *  4. **every named row DEPARTS, and only then does every one arrive**, so no
 *     intermediate occupancy is ever constructed;
 *  5. the three gates, ONCE, over the resulting state.
 *
 * A contested Player is excluded from the delta rather than moved: there is
 * no settled Contract to re-place. The other two gates still run, and still
 * report what the rest of the Move would have done — no gate short-circuits
 * another (AD-7).
 */
export function evaluateRearrange(
	state: RosterRearrangeState,
	command: RearrangeRoster
): RearrangeOutcome {
	if (command.moves.length === 0) {
		return { kind: 'refused', refusal: { kind: 'names_nothing' }, gates: null };
	}

	// **Deduplicated on the Player**, because one Contract occupies one Slot: a
	// form that posted the same id twice would otherwise depart the row twice
	// and re-place it twice. The FIRST entry wins, exactly as a Drop's dedupe
	// keeps the first — a second entry naming the same Contract says either the
	// same thing again or something contradictory, and neither is an act.
	const named: { fantraxPlayerId: string; toPlacement: RosterSlotKind }[] = [];
	const alreadyNamed = new Set<string>();
	for (const move of command.moves) {
		if (alreadyNamed.has(move.fantraxPlayerId)) continue;
		alreadyNamed.add(move.fantraxPlayerId);
		named.push({ fantraxPlayerId: move.fantraxPlayerId, toPlacement: move.toPlacement });
	}

	const contested: ContestedPlayer[] = [];
	for (const move of named) {
		const contest = contestOf(state, move.fantraxPlayerId);
		if (contest !== null) contested.push(contest);
	}
	const contestedIds = new Set(contested.map((player) => player.fantraxPlayerId));
	const contestedGate: ContestedGateOutcome = { passed: contested.length === 0, contested };

	// The Contracts that will actually move — everything named that an open
	// Auction or nomination is not still deciding.
	const rearranging = named.filter((move) => !contestedIds.has(move.fantraxPlayerId));

	const placing: { row: RearrangingPlayer; toPlacement: RosterSlotKind }[] = [];
	for (const move of rearranging) {
		const row = state.team.rows.find((held) => held.fantraxPlayerId === move.fantraxPlayerId);
		if (row === undefined) {
			return {
				kind: 'refused',
				refusal: {
					kind: 'not_held',
					fantraxPlayerId: move.fantraxPlayerId,
					playerName: state.playerNameFor(move.fantraxPlayerId),
					teamId: state.team.teamId,
					teamName: state.team.teamName
				},
				gates: null
			};
		}
		// **Neither end may be Dead Money**, and the refusal is the rules core's
		// rather than the screen's. `movable` states it for every roster act and
		// `isRearrangeableSlot` states it again over the target, which is what
		// refuses a crafted POST naming `dead_money` as a destination — there is
		// no row to move there and no Slot for it to occupy.
		if (!movable(row) || !isRearrangeableSlot(row.rosterSlotKind) || !isRearrangeableSlot(move.toPlacement)) {
			return {
				kind: 'refused',
				refusal: {
					kind: 'unmovable_slot',
					fantraxPlayerId: row.fantraxPlayerId,
					playerName: row.playerName,
					teamName: state.team.teamName,
					fromPlacement: row.rosterSlotKind,
					toPlacement: move.toPlacement
				},
				gates: null
			};
		}
		// **Promotion only.** A demotion consults nothing — FR-44 is explicit,
		// and asking would make an unobserved Contract unmovable in both
		// directions.
		if (move.toPlacement === 'minor_league' && !mayOccupyMinorLeague(state, row.fantraxPlayerId)) {
			return {
				kind: 'refused',
				refusal: {
					kind: 'never_observed_eligible',
					fantraxPlayerId: row.fantraxPlayerId,
					playerName: row.playerName,
					teamName: state.team.teamName
				},
				gates: null
			};
		}
		placing.push({ row, toPlacement: move.toPlacement });
	}

	const before = figuresFor(state.team, state.team.rows);

	// **Sorted by `fantraxPlayerId`** (AD-5), exactly as a Drop sorts its
	// releases. Nothing in the gates depends on the order — the act is
	// evaluated once over the state it produces — but `moves[]` is written
	// verbatim into a permanent `RosterRearranged` payload and read back by the
	// Audit Log, so an order that came from the caller's field order would make
	// the RECORD unreproducible.
	const ordered = [...placing].sort((left, right) => byPlayerId(left.row, right.row));

	// **Every departure, then every arrival** — the whole of §10 example 44's
	// counterfactual, made unreachable by construction. `staying` is the roster
	// with every named row REMOVED; the re-placed rows are appended to it, so
	// no Slot is ever occupied by a Contract that has already left it.
	const departing = new Set(ordered.map((entry) => entry.row.fantraxPlayerId));
	const staying = state.team.rows.filter((row) => !departing.has(row.fantraxPlayerId));
	const arriving: RearrangingPlayer[] = ordered.map((entry) => ({
		...entry.row,
		rosterSlotKind: entry.toPlacement
	}));
	const after = figuresFor(state.team, [...staying, ...arriving]);

	// The record, built from the rows on either side of the act. `chargeOf` is
	// `chargedCapHit` — the ONE charge expression — asked of the Slot the
	// Contract left and again of the Slot it entered. Nothing here reads the
	// value out of the charge or the charge out of the value (AD-23).
	const moves: RearrangeMove[] = ordered.map((entry, index) => {
		const arrived = arriving[index] as RearrangingPlayer;
		return {
			fantraxPlayerId: entry.row.fantraxPlayerId,
			playerName: entry.row.playerName,
			won: entry.row.won,
			fromPlacement: entry.row.rosterSlotKind,
			toPlacement: entry.toPlacement,
			capHitBefore: chargeOf(entry.row),
			capHitAfter: chargeOf(arrived),
			value: entry.row.value
		};
	});

	// **One evaluation, at the end, over the state the whole act produced.**
	const money = postActMoneyStateFor(state.team, after, state);
	const gates: RearrangeRosterGateResults = {
		contested: contestedGate,
		cap: evaluateActCap(state.team, money),
		slots: evaluateActSlots(state.team, after, money)
	};

	if (!allRearrangeGatesPassed(gates)) {
		return { kind: 'refused', refusal: { kind: 'gates' }, gates };
	}

	// **The SECOND call of `evaluateActCap`, over the BEFORE figures.** §10
	// example 45 spends $2,000,000 of Cap Space and gains $10,000,000 of
	// Maximum Bid, and no pair of figures on the sheet says so — the direction
	// runs through Minors Exposure and cannot be derived per-row at all. This
	// is a second CALL of one expression, never a second expression.
	const moneyBefore = postActMoneyStateFor(state.team, before, state);
	const capBefore = evaluateActCap(state.team, moneyBefore);

	// **And the Manager's own Maximum Bid, either side.** Not the gates'
	// figure — see `managerMaximumBidFor`. The gates decide with theirs; the
	// sheet must quote the number a Manager recognises from the board.
	const maximumBid: MaximumBidPair = {
		before: managerMaximumBidFor(moneyBefore),
		after: managerMaximumBidFor(money)
	};

	return { kind: 'permitted', gates, delta: { moves, before, after }, capBefore, maximumBid };
}

/**
 * Whether every gate in `REARRANGE_ROSTER_GATES` passed.
 *
 * Iterates the frozen NAME LIST rather than the result object's own keys, for
 * `allDropGatesPassed`'s reason: a result that somehow lost a key would
 * otherwise pass by having nothing to fail.
 */
export function allRearrangeGatesPassed(gates: RearrangeRosterGateResults): boolean {
	return REARRANGE_ROSTER_GATES.every((gate) => gates[gate].passed);
}

/**
 * The one sentence a refused Move is reported by — the Team, the gate, the
 * Auction and the arithmetic (FR-44).
 *
 * **The never-observed refusal states what the app does not KNOW, not what it
 * knows.** §10 example 46 is explicit: *the app has never been told he is
 * eligible* rather than *he is ineligible*, because the second asserts
 * something the app cannot see. Vassell may well be minor-league eligible in
 * the real league; nothing in this system has ever been told so.
 *
 * **It never offers to cancel a Bid.** FR-40's cancellation trigger is a
 * Close and only a Close.
 *
 * Every failing gate is reported, not the first.
 */
export function rearrangeRefusalDetail(
	refusal: RosterRearrangeRefusal,
	gates: RearrangeRosterGateResults | null
): string {
	switch (refusal.kind) {
		case 'names_nothing':
			return 'This Roster Move names no Contracts. A Move re-places at least one Contract.';
		case 'not_held':
			return `${refusal.playerName} is not a Contract ${refusal.teamName} holds, so there is nothing for this Roster Move to re-place.`;
		case 'unmovable_slot': {
			const from = SLOT_LABELS[refusal.fromPlacement];
			const to = SLOT_LABELS[refusal.toPlacement];
			return (
				`A Roster Move re-places a Contract between an ${SLOT_LABELS.active_bench} Slot, an ` +
				`${SLOT_LABELS.injury_reserve} Slot and a ${SLOT_LABELS.minor_league} Slot, and ` +
				`${refusal.playerName} was named ${from} → ${to} on ${refusal.teamName}. ` +
				`${SLOT_LABELS.dead_money} is a charge and not a Slot: nobody holds it, it occupies nothing, ` +
				`and it cannot be re-placed or moved into.`
			);
		}
		case 'never_observed_eligible':
			return (
				`${refusal.playerName} cannot be promoted into a ${SLOT_LABELS.minor_league} Slot on ` +
				`${refusal.teamName}: the app has never been told he is eligible. He was not in the Free Agent ` +
				`pool and the app has never observed him in a ${SLOT_LABELS.minor_league} Slot. That is not the ` +
				`same as saying he is ineligible — it is something this app does not know. Set the pool flag, or ` +
				`record the placement the league already made.`
			);
		case 'gates': {
			if (gates === null) return 'The Roster Move was refused.';
			const sentences: string[] = [];
			if (!gates.contested.passed) {
				const named = gates.contested.contested.map((player) =>
					player.contest === 'bid'
						? `${player.playerName} is being bid on in an open Auction`
						: `${player.playerName} is nominated and awaiting an opening Bid`
				);
				const singular = gates.contested.contested.length === 1;
				sentences.push(
					`${inWords(named)}. No Team holds a settled Contract on ${singular ? 'him' : 'them'} yet, so ` +
						`${singular ? 'he cannot' : 'they cannot'} be re-placed until that Auction closes.`
				);
			}
			if (!gates.cap.passed) {
				const gate = gates.cap;
				// **The remedy is only offered when there is something to wait
				// for.** `auctionsInWords` answers "It leads no open Auction."
				// when the Team leads none, and appending "wait for it to close"
				// after that sentence tells the reader to wait for an Auction the
				// line above has just said does not exist. Where the shortfall is
				// the Team's own committed capital rather than a lead, the honest
				// answer is that the figures themselves are the whole story.
				const remedy =
					gate.leadingAuctions.length > 0
						? ' Wait for it to close or void the Bid; the Move will not cancel it.'
						: '';
				sentences.push(
					`${gate.teamName} cannot cover what it is already committed to after this Roster Move. ` +
						`Cap Space ${formatExactDollars(gate.capSpace)}, Committed Bids ${formatExactDollars(gate.committedBids)}, ` +
						`Roster Reserve ${formatExactDollars(gate.rosterReserve)} — a shortfall of ${formatExactDollars(gate.shortfall ?? NO_MONEY)}. ` +
						`${auctionsInWords(gate)}${remedy}`
				);
			}
			if (!gates.slots.passed) {
				const gate = gates.slots;
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
				} else {
					sentences.push(
						`${gate.teamName} has no room for what it still has outstanding: Roster Count ${String(gate.rosterCount)}, ` +
							`Free Active/Bench Slots ${String(gate.freeActiveBenchSlots)}, ` +
							`Projected Additions ${String(gate.projectedAdditions)} against an allowance of ${String(gate.allowance)}.`
					);
				}
			}
			return sentences.join(' ');
		}
	}
}

/**
 * What one re-placement does to what the Contract CHARGES, in words.
 *
 * **Cap Hit follows placement** (FR-44, FR-21, FR-35): promoted into a Minor
 * League Slot a Contract charges `$0`, demoted to Active/Bench it charges its
 * full amount — and its value never changes. §10 example 44's Ellis is
 * $18,000,000 → $0 and Brooks is $0 → $3,000,000 in the same act, which is
 * the whole of the $15,000,000 the Team recovers.
 *
 * `null` where the charge did not move: the amber marker is the product's
 * single attention colour, and a sheet that marks every row marks nothing.
 * That is the honest answer for a Move that only re-labels the Slot a
 * Contract already occupies — and it is also the honest answer for the
 * Active/Bench ↔ Injury Reserve pair, where both Slots charge in full and the
 * only thing that moves is Roster Count, which the sheet's own figure rows
 * state before and after.
 *
 * **The arrival Slot is NAMED from the move, never assumed from the
 * direction.** With two rearrangeable Slots a falling charge could only mean
 * Minor League and a rising one could only mean Active/Bench, so the sentences
 * named those Slots as literals. Injury Reserve makes the second literal a
 * lie: a stash promoted from Minor League to Injury Reserve starts charging in
 * full and never goes near an Active/Bench Slot.
 */
export function moveAttention(move: RearrangeMove): string | null {
	const direction = compareMoney(move.capHitAfter, move.capHitBefore);
	if (direction === 0) return null;

	const stated = `The Contract's value is unchanged at ${describeActAmount(move.value)}.`;
	const arrived = SLOT_LABELS[move.toPlacement];
	if (direction < 0) {
		return (
			`${move.playerName} stops charging: ${describeActAmount(subtractMoney(move.capHitBefore, move.capHitAfter))} ` +
			`goes back to Cap Space, because a ${arrived} Contract charges nothing. ${stated}`
		);
	}
	// **The article is a constant and the union is why.** Only `minor_league`
	// charges nothing, so a FALLING charge can only have arrived there ("a
	// Minor League Contract") and a RISING one can only have arrived in
	// Active/Bench or Injury Reserve — both of which take "an". A vowel test on
	// the label would be a rule about spelling standing in for a rule about
	// Slots.
	return (
		`${move.playerName} starts charging: ${describeActAmount(subtractMoney(move.capHitAfter, move.capHitBefore))} ` +
		`comes off Cap Space, because an ${arrived} Contract charges in full. ${stated}`
	);
}

/**
 * Which way this Move actually moved the Team's Maximum Bid, in words — the
 * sentence FR-44 requires on the sheet before a Move commits.
 *
 * **Computed, never asserted.** §10 example 45 spends $2,000,000 of Cap Space
 * and gains $10,000,000 of Maximum Bid: demoting a stash frees a Minor League
 * Slot, which absorbs an eligible lead that was being counted in full, while
 * the demoted Contract starts charging. The two halves pull opposite ways and
 * the net is neither obvious nor one-directional — a flat rule would be wrong
 * for exactly the case this sentence exists for, and it is the mirror of §10
 * example 40 on the Drop side.
 *
 * `dropAttention` sets the precedent for stating a direction the two states
 * do not show. The difference is that a Drop's direction can be computed per
 * release; a Move's runs through Minors Exposure and cannot, so the honest
 * computation is the figures over the before state and again over the after.
 *
 * **The figure quoted is `managerMaximumBidFor`'s, not the gates'.** The two
 * gate outcomes still supply Cap Space and Minors Exposure — identical under
 * either reading, because neither depends on Projected Additions — but the
 * Maximum Bid a sheet states has to be the one a Manager recognises from the
 * board, which counts the Bid about to be placed.
 */
export function maximumBidDirectionSentence(
	before: ActCapGateOutcome,
	after: ActCapGateOutcome,
	maximumBid: MaximumBidPair
): string {
	const direction = compareMoney(maximumBid.after, maximumBid.before);
	const from = describeActAmount(maximumBid.before);
	const to = describeActAmount(maximumBid.after);
	if (direction === 0) {
		return `Net, this Roster Move leaves ${after.teamName}'s Maximum Bid unchanged at ${to}.`;
	}
	const size: Money =
		direction > 0
			? subtractMoney(maximumBid.after, maximumBid.before)
			: subtractMoney(maximumBid.before, maximumBid.after);
	const word = direction > 0 ? 'ROSE' : 'FELL';
	return (
		`Net, ${after.teamName}'s Maximum Bid ${word} by ${describeActAmount(size)} — from ${from} to ${to}. ` +
		`Cap Space moved from ${describeActAmount(before.capSpace)} to ${describeActAmount(after.capSpace)} and ` +
		`Minors Exposure from ${describeActAmount(before.minorsExposure)} to ${describeActAmount(after.minorsExposure)}, ` +
		`so the two do not have to move the same way.`
	);
}

/**
 * The act, as one finished sentence — never assembled from a template the
 * sheet itself holds.
 *
 * It names the Team and every Contract with the Slot it is to occupy, because
 * a Move of three Contracts is one act and the sentence a Manager commits
 * against has to say so.
 */
export function rearrangeActSentence(delta: RosterRearrangeDelta): string {
	const named = inWords(
		delta.moves.map((move) => `${move.playerName} to ${SLOT_LABELS[move.toPlacement]}`)
	);
	return `Record that ${delta.after.teamName} moves ${named}.`;
}
