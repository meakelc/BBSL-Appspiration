/**
 * Recording a Drop: one act, one Team, one evaluation at the end
 * (Story 7.8, FR-43, §10 examples 40, 41 and 43).
 *
 * **One rule, and no Slot kind is a special case.** The whole conversion is
 * two lines:
 *
 * ```
 * deadMoney = releasesToNothing(row) ? $0 : chargedCapHit(row)
 * removed   = deadMoney is $0
 * ```
 *
 * and all four outcomes fall out of them. An Active/Bench or Injury Reserve
 * Contract carries its full charge and its row is reclassified `dead_money`.
 * A Minor League row was charging `$0`, so nothing is carried and the row is
 * removed. A full-term second-round rookie deal is released to `$0` by
 * FR-43's exception and removed the same way — and removing the row IS the
 * release of its Cap Hit back to Cap Space. Nothing here tests
 * `rosterSlotKind` to decide either half: a branch on `minor_league` would be
 * a second spelling of `chargedCapHit`, which is the one statement of "a
 * Minor League row charges $0" and is not edited by this story (AR-43).
 *
 * **The exception needs BOTH facts.** Round 2 alone is a rookie deal that may
 * be part-served; a full term alone is an ordinary Contract that has simply
 * not started. `rookieScaleRound === 2` AND `contractYearsRemaining === 5`,
 * because the second-round rookie scale is five years and invariant — which
 * is exactly what makes the term test a sound proxy for "unelapsed".
 *
 * **It does no arithmetic of its own** (AR-42). Cap and capacity come from
 * `rules/roster-act.ts`, which is the evaluation a Move already runs; this
 * file writes no third statement of solvency, capacity, Cap Space or the
 * charged-Cap-Hit rule.
 *
 * **Refuse, never cancel.** A failing gate refuses the WHOLE Drop and this
 * module produces nothing to write. No Bid is stood down anywhere: FR-40's
 * cancellation trigger is a Close and only a Close.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { MINIMUM_BID } from '../constants.ts';
import { compareMoney, formatExactDollars, parseMoney, subtractMoney } from '../money.ts';
import type { Money } from '../money.ts';
import type { OpenAuctions } from '../projection/auctions.ts';
import type { DroppedContract, RosterMoveTeamFigures } from '../projection/contracts.ts';
import type { OpenNominations } from '../projection/nominations.ts';
import { RECORD_DROP_GATES } from '../types.ts';
import type {
	ContestedGateOutcome,
	ContestedPlayer,
	RecordDrop,
	RecordDropGateResults,
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
import { SLOT_LABELS } from './roster-import.ts';

/**
 * The reserve one free Active/Bench Slot costs, branded — `rules/bidding.ts`'s
 * own `MINIMUM_OPENING_BID`, which is what `rosterReserve` is a multiple of.
 *
 * Declared here only so the sentence below can PRINT it. Nothing in this file
 * multiplies by it or subtracts it from anything: the Roster Reserve and the
 * Maximum Bid the gates report are `teamSolvencyFiguresFor`'s, and a second
 * computation of either is exactly what AR-42 forbids.
 */
const SLOT_RESERVE: Money = parseMoney(MINIMUM_BID);

/**
 * The draft round FR-43's exception is about, and the full term of a deal in
 * it — the two literals the exception turns on, named rather than inlined.
 *
 * The second-round rookie scale is FIVE years and that length is invariant,
 * which is the whole reason a term test can stand in for "unelapsed": a
 * second-round deal with five years left has had none of it served. A
 * FIRST-round deal is out of scope whatever its term, because FR-43's
 * exception is second-round only.
 */
export const ROOKIE_SCALE_EXEMPT_ROUND = 2;
export const ROOKIE_SCALE_EXEMPT_TERM = 5;

/**
 * One Contract as a Drop can release it.
 *
 * **`value` is the full amount, never the charged one** (AD-23), exactly as
 * a Move's `MovingPlayer` carries it — an imported row stores its salary in
 * full whatever Slot it sits in, and what it CHARGES is `chargedCapHit`'s
 * answer about that Slot.
 *
 * `won` is what a Drop REFUSES on. A Player held by an Auction Contract is
 * not in Fantrax until the FR-30/31 export, so he cannot have been dropped
 * there; FR-42's divergence detector excludes won Players for the identical
 * reason, and Story 7.2's void is the remedy for a Player wrongly won.
 *
 * `contractYearsRemaining` and `rookieScaleRound` are the two facts FR-43's
 * exception asks for, and both are `null` on a won row — it has no imported
 * term and no draft round. That costs nothing, because a won row is refused
 * before the conversion is ever reached.
 */
export type DroppablePlayer = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** The Slot this Contract occupies on the Team that holds it today. */
	readonly rosterSlotKind: RosterSlotKind;
	/** The full value of the Contract — never the charged Cap Hit. */
	readonly value: Money;
	/** `true` for an Auction Contract, which a Drop refuses outright. */
	readonly won: boolean;
	/** Years still to run, as Fantrax stated them, or `null`. */
	readonly contractYearsRemaining: number | null;
	/** The draft round of a rookie-scale Contract, or `null` for an ordinary one. */
	readonly rookieScaleRound: number | null;
};

/**
 * The Team a Drop acts on: who they are and everything they hold.
 *
 * **The whole roster, Dead Money included.** Cap Space is a sum over every
 * row a Team carries, so handing this module only the droppable ones would
 * compute a Cap Space the Teams page disagrees with. Dead Money simply cannot
 * be named in a Drop — `movable` in `rules/roster-act.ts` is what says so, in
 * one place, for both acts.
 *
 * No figures are carried. Cap Space, Roster Count and all three occupancies
 * are DERIVED from `rows` on every evaluation, before the Drop and after it,
 * which is what makes the before/after pair structurally incapable of being
 * computed two different ways.
 */
export type DroppingTeam = {
	readonly teamId: string;
	readonly teamName: string;
	readonly rows: readonly DroppablePlayer[];
};

/**
 * Everything a Drop is judged against — one snapshot, so no two gates can be
 * judged against different moments.
 *
 * `auctions` and `nominations` are the folds the contested ground reads: a
 * Player with an open Auction or an open nomination is held by nobody, so
 * there is no settled Contract for a Drop to release.
 */
export type RosterDropState = {
	readonly team: DroppingTeam;
	readonly auctions: OpenAuctions;
	readonly nominations: OpenNominations;
	readonly isMinorLeagueEligible: (fantraxPlayerId: string) => boolean;
	readonly playerNameFor: (fantraxPlayerId: string) => string;
};

/** One Team's five figures, declared in `projection/contracts.ts` beside the event. */
export type DropTeamFigures = RosterMoveTeamFigures;
export type DropRelease = DroppedContract;

/** The whole delta: every released Player, and the Team before and after. */
export type RosterDropDelta = {
	readonly released: readonly DropRelease[];
	readonly before: DropTeamFigures;
	readonly after: DropTeamFigures;
};

/**
 * Why a Drop was refused.
 *
 * **Four of the five are about the SHAPE of the act and one is about the
 * gates**, which is `RosterMoveRefusal`'s own split: a malformed act has no
 * arithmetic to show, so the gate results come back `null` rather than as
 * figures computed over a state that could not be built.
 */
export type RosterDropRefusal =
	| { readonly kind: 'names_nothing' }
	| {
			readonly kind: 'not_held';
			readonly fantraxPlayerId: string;
			readonly playerName: string;
			readonly teamId: string;
			readonly teamName: string;
	  }
	| {
			readonly kind: 'dead_money';
			readonly fantraxPlayerId: string;
			readonly playerName: string;
			readonly teamName: string;
	  }
	| {
			readonly kind: 'won';
			readonly fantraxPlayerId: string;
			readonly playerName: string;
			readonly teamName: string;
	  }
	| { readonly kind: 'gates' };

/** What `evaluateDrop` decided. A rejection is a RETURNED value, never a throw. */
export type DropOutcome =
	| {
			readonly kind: 'refused';
			readonly refusal: RosterDropRefusal;
			/** The three gates, or `null` when the act's shape stopped them running. */
			readonly gates: RecordDropGateResults | null;
	  }
	| {
			readonly kind: 'permitted';
			readonly gates: RecordDropGateResults;
			readonly delta: RosterDropDelta;
	  };

/**
 * FR-43's one exception, asked as one question of one row.
 *
 * Both facts or neither. Exported so a surface can state WHY a Contract
 * cleared without re-spelling the test.
 */
export function releasesToNothing(row: {
	readonly rookieScaleRound: number | null;
	readonly contractYearsRemaining: number | null;
}): boolean {
	return (
		row.rookieScaleRound === ROOKIE_SCALE_EXEMPT_ROUND &&
		row.contractYearsRemaining === ROOKIE_SCALE_EXEMPT_TERM
	);
}

/**
 * The Dead Money one release carries — **the one expression that decides the
 * amount**, and the only one.
 *
 * `chargeOf` is `chargedCapHit` over the row's full value, which is the same
 * function `computeCapSpace` sums and therefore the same answer the Team's
 * Cap Space was computed from a line earlier. That is what makes "Cap Space
 * stands still" in §10 example 40 an identity rather than a coincidence: the
 * row keeps charging exactly what it charged.
 */
function deadMoneyFor(row: DroppablePlayer): Money {
	return releasesToNothing(row) ? NO_MONEY : chargeOf(row);
}

/**
 * Evaluate one Drop: apply the whole act, then judge the result once.
 *
 * The order inside is the rule (FR-43):
 *
 *  1. the act's SHAPE — at least one Player named;
 *  2. the CONTESTED ground, before cap and slots, because neither has
 *     anything to say about a Player nobody holds;
 *  3. every remaining named Player is HELD by this Team, is not Dead Money
 *     and is not an Auction Contract — malformed acts, with no figures to
 *     show;
 *  4. the conversion, applied to every release at once;
 *  5. the three gates, ONCE, over the resulting state.
 *
 * A contested Player is excluded from the delta rather than released: there
 * is no settled Contract to release, and constructing one out of an open
 * Auction would manufacture a Player nobody has won. The other two gates
 * still run, and still report what the rest of the Drop would have done — no
 * gate short-circuits another (AD-7).
 */
export function evaluateDrop(state: RosterDropState, command: RecordDrop): DropOutcome {
	if (command.fantraxPlayerIds.length === 0) {
		return { kind: 'refused', refusal: { kind: 'names_nothing' }, gates: null };
	}

	// **Deduplicated on the Player**, because a Contract cannot be released
	// twice in one act: a form that posted the same id twice would otherwise
	// carry the Dead Money twice and remove the row twice. Naming him twice
	// says one thing twice, so the repeat is dropped and the act is unchanged.
	const named: string[] = [];
	const alreadyNamed = new Set<string>();
	for (const fantraxPlayerId of command.fantraxPlayerIds) {
		if (alreadyNamed.has(fantraxPlayerId)) continue;
		alreadyNamed.add(fantraxPlayerId);
		named.push(fantraxPlayerId);
	}

	const contested: ContestedPlayer[] = [];
	for (const fantraxPlayerId of named) {
		const contest = contestOf(state, fantraxPlayerId);
		if (contest !== null) contested.push(contest);
	}
	const contestedIds = new Set(contested.map((player) => player.fantraxPlayerId));
	const contestedGate: ContestedGateOutcome = { passed: contested.length === 0, contested };

	// The Contracts that will actually be released — everything named that an
	// open Auction is not still deciding.
	const dropping = named.filter((fantraxPlayerId) => !contestedIds.has(fantraxPlayerId));

	const releasing: DroppablePlayer[] = [];
	for (const fantraxPlayerId of dropping) {
		const row = state.team.rows.find((held) => held.fantraxPlayerId === fantraxPlayerId);
		if (row === undefined) {
			return {
				kind: 'refused',
				refusal: {
					kind: 'not_held',
					fantraxPlayerId,
					playerName: state.playerNameFor(fantraxPlayerId),
					teamId: state.team.teamId,
					teamName: state.team.teamName
				},
				gates: null
			};
		}
		// **Dead Money is not droppable**, and the question is asked of
		// `movable` rather than of the Slot kind: it is a charge and not a
		// Player, so there is nothing to release and no Slot to free.
		if (!movable(row)) {
			return {
				kind: 'refused',
				refusal: {
					kind: 'dead_money',
					fantraxPlayerId,
					playerName: row.playerName,
					teamName: state.team.teamName
				},
				gates: null
			};
		}
		// **A won Player is refused as a SHAPE refusal.** He is not in Fantrax
		// until the FR-30/31 export, so he cannot have been dropped there —
		// FR-42's divergence detector excludes won Players for the same reason,
		// and Story 7.2's void is the remedy for a Player wrongly won.
		if (row.won) {
			return {
				kind: 'refused',
				refusal: {
					kind: 'won',
					fantraxPlayerId,
					playerName: row.playerName,
					teamName: state.team.teamName
				},
				gates: null
			};
		}
		releasing.push(row);
	}

	const before = figuresFor(state.team, state.team.rows);

	// **Releases applied SORTED by `fantraxPlayerId`** (AD-5), exactly as a
	// Move sorts its arrivals. Nothing in the gates depends on the order — the
	// act is evaluated once over the state it produces — but `released[]` is
	// written verbatim into a permanent `DropRecorded` payload and read back by
	// the Audit Log, so an order that came from the caller's field order would
	// make the RECORD unreproducible. The route happens to sort its checkbox
	// ids; that is an accident of the route, and this is the rule.
	const releases = [...releasing].sort((left, right) =>
		left.fantraxPlayerId === right.fantraxPlayerId
			? 0
			: left.fantraxPlayerId < right.fantraxPlayerId
				? -1
				: 1
	);

	// **The conversion, in one pass, with no branch on the Slot kind.**
	const released: DropRelease[] = [];
	const releasedIds = new Set(releases.map((row) => row.fantraxPlayerId));
	const carried: DroppablePlayer[] = [];
	for (const row of releases) {
		const deadMoney = deadMoneyFor(row);
		const removed = compareMoney(deadMoney, NO_MONEY) === 0;
		released.push({
			fantraxPlayerId: row.fantraxPlayerId,
			playerName: row.playerName,
			fromPlacement: row.rosterSlotKind,
			chargedCapHit: chargeOf(row),
			value: row.value,
			deadMoney,
			removed,
			contractYearsRemaining: row.contractYearsRemaining,
			rookieScaleRound: row.rookieScaleRound
		});
		if (removed) continue;
		// The surviving row: Dead Money, valued at exactly what is carried.
		// `chargedCapHit` returns a `dead_money` row's stated hit in full, so
		// the Team's Cap Space after the act is its Cap Space before it —
		// which is §10 example 40's "Cap Space still $5,000,000", derived
		// rather than asserted.
		carried.push({ ...row, rosterSlotKind: 'dead_money', value: deadMoney });
	}

	const rows: DroppablePlayer[] = [
		...state.team.rows.filter((row) => !releasedIds.has(row.fantraxPlayerId)),
		...carried
	];
	const after = figuresFor(state.team, rows);

	// **One evaluation, at the end, over the state the whole act produced.**
	const money = postActMoneyStateFor(state.team, after, state);
	const gates: RecordDropGateResults = {
		contested: contestedGate,
		cap: evaluateActCap(state.team, money),
		slots: evaluateActSlots(state.team, after, money)
	};

	if (!allDropGatesPassed(gates)) {
		return { kind: 'refused', refusal: { kind: 'gates' }, gates };
	}

	return { kind: 'permitted', gates, delta: { released, before, after } };
}

/**
 * Whether every gate in `RECORD_DROP_GATES` passed.
 *
 * Iterates the frozen NAME LIST rather than the result object's own keys, for
 * `allMoveGatesPassed`'s reason: a result that somehow lost a key would
 * otherwise pass by having nothing to fail, and adding a fourth gate name
 * would silently go unchecked.
 */
export function allDropGatesPassed(gates: RecordDropGateResults): boolean {
	return RECORD_DROP_GATES.every((gate) => gates[gate].passed);
}

/**
 * The one sentence a refused Drop is reported by — the Team, the gate, the
 * Auction and the arithmetic (FR-43).
 *
 * **It never offers to cancel a Bid.** FR-40's cancellation trigger is a
 * Close and only a Close, so the remedies this wording states are the two
 * FR-41 allows a Move: wait for the Auction to close, or void the Bid under
 * FR-32.
 *
 * Every failing gate is reported, not the first: a Commissioner told about a
 * shortfall who then hits a ceiling has been made to retry for no reason.
 */
export function dropRefusalDetail(
	refusal: RosterDropRefusal,
	gates: RecordDropGateResults | null
): string {
	switch (refusal.kind) {
		case 'names_nothing':
			return 'This Drop names no Players. A Drop releases at least one Contract.';
		case 'not_held':
			return `${refusal.playerName} is not a Contract ${refusal.teamName} holds, so there is nothing for this Drop to release.`;
		case 'dead_money':
			return (
				`${refusal.playerName} is already Dead Money on ${refusal.teamName}. Dead Money is a charge and ` +
				`not a Player: there is no Contract left to release and no Roster Slot to free.`
			);
		case 'won':
			return (
				`The Auction on ${refusal.playerName} closed to ${refusal.teamName}, so ${refusal.playerName} is held ` +
				`under an Auction Contract and is not in Fantrax until the export. A Team cannot have dropped a ` +
				`Contract it has not yet been given; a Player wrongly won is put right by voiding the Bid in the ` +
				`Auction on ${refusal.playerName}, not by a Drop.`
			);
		case 'gates': {
			if (gates === null) return 'The Drop was refused.';
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
						`${singular ? 'he cannot' : 'they cannot'} be dropped until that Auction closes.`
				);
			}
			if (!gates.cap.passed) {
				const gate = gates.cap;
				sentences.push(
					`${gate.teamName} cannot cover what it is already committed to after this Drop. ` +
						`Cap Space ${formatExactDollars(gate.capSpace)}, Committed Bids ${formatExactDollars(gate.committedBids)}, ` +
						`Roster Reserve ${formatExactDollars(gate.rosterReserve)} — a shortfall of ${formatExactDollars(gate.shortfall ?? NO_MONEY)}. ` +
						`${auctionsInWords(gate)} Wait for it to close or void the Bid; the Drop will not cancel it.`
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
 * What one release costs the Team's bidding power, in words — the sentence
 * FR-43 requires on the reason sheet before a Drop commits (UX-DR40).
 *
 * **Two facts, stated separately, because only one of them is universal.**
 * Every Active/Bench release frees a SLOT, and a free Slot costs
 * `MINIMUM_BID` to reserve — that is true of all of them. What it NETS to is
 * not: §10 example 40 carries its Cap Hit as Dead Money and the Maximum Bid
 * FALLS $1,000,000, while §10 example 41 is the same Slot, the same
 * $2,000,000 and the same act and the Maximum Bid RISES $1,000,000, because
 * the charge went back to Cap Space. So the reserve is one sentence and the
 * net direction is another, and the second is COMPUTED from what the release
 * actually returned rather than assumed.
 *
 * **Stating it backwards is worse than not stating it.** A sheet showing only
 * the two states shows a Cap Space that did not move and a Roster Count that
 * fell, and a Commissioner reads that as a gain; a sheet that asserts one
 * direction for both cases is wrong for exactly the release whose direction
 * is least obvious, which is the one this requirement exists for.
 *
 * **The rookie clause is gated on `releasesToNothing`, not on `removed`.**
 * `removed` says only that the carried Dead Money is `$0`, and an ordinary
 * Contract charging `$0` satisfies that too — citing FR-43's second-round
 * exception over such a release would state a reason that did not happen.
 *
 * `null` for an Injury Reserve or Minor League release, because neither frees
 * an Active/Bench Slot and neither moves Maximum Bid by this route — the
 * amber marker is the product's single attention colour, and a sheet that
 * marks every row marks nothing.
 */
export function dropAttention(release: DropRelease): string | null {
	if (release.fromPlacement !== 'active_bench') return null;

	// Fact one, true of EVERY Active/Bench release: the freed hole has to be
	// reserved, so Roster Reserve rises by `MINIMUM_BID` whatever else happens.
	const freed =
		`Dropping ${release.playerName} frees an Active/Bench Slot, and a free Slot costs ` +
		`${describeActAmount(SLOT_RESERVE)} to reserve — so Roster Reserve rises by that much.`;

	// Fact two: what, if anything, goes back to Cap Space. **The rookie clause
	// is gated on `releasesToNothing` and not on `removed`**, because `removed`
	// only says the carried Dead Money is $0 — which an ordinary Contract
	// charging $0 also satisfies, and telling its Commissioner it cleared under
	// FR-43's exception would be false.
	const returned = release.removed ? release.chargedCapHit : NO_MONEY;
	const fate = !release.removed
		? `None of the ${describeActAmount(release.chargedCapHit)} comes back — the Contract keeps charging it ` +
			`as Dead Money under nobody's name.`
		: releasesToNothing(release)
			? `The ${describeActAmount(release.chargedCapHit)} returns to Cap Space: a second-round rookie-scale ` +
				`Contract released with its full term unelapsed carries no Dead Money (FR-43).`
			: `The Contract was charging ${describeActAmount(release.chargedCapHit)}, so it leaves no Dead Money ` +
				`behind and that is what returns to Cap Space.`;

	// The NET direction, for THIS release — and it is the half the sheet exists
	// for, so it is computed rather than asserted. §10 example 40 carries its
	// Cap Hit and the Maximum Bid FALLS $1,000,000; §10 example 41 is the same
	// Slot, the same amount and the same act, and it RISES $1,000,000. A
	// sentence that stated one direction for both would be wrong for one of the
	// two examples FR-43 exists to distinguish.
	const direction = compareMoney(returned, SLOT_RESERVE);
	const net =
		direction === 0
			? `Net, this Drop leaves the Team's Maximum Bid unchanged.`
			: direction > 0
				? `Net, this Drop RAISES the Team's Maximum Bid by ` +
					`${describeActAmount(subtractMoney(returned, SLOT_RESERVE))}.`
				: `Net, this Drop LOWERS the Team's Maximum Bid by ` +
					`${describeActAmount(subtractMoney(SLOT_RESERVE, returned))}.`;

	return `${freed} ${fate} ${net}`;
}

/**
 * The act, as one finished sentence — never assembled from a template the
 * sheet itself holds.
 *
 * It names the Team and every Player released, because a Drop of three
 * Players is one act and the sentence a Commissioner commits against has to
 * say so.
 */
export function dropActSentence(delta: RosterDropDelta): string {
	const names = inWords(delta.released.map((release) => release.playerName));
	return `Record that ${delta.after.teamName} dropped ${names}.`;
}
