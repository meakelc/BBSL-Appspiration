/**
 * The Year Allotment: how many of each contract length a Team has left, which
 * lengths it may still offer, and every refusal the Contract Assignment surface
 * can give (Story 6.1, FR-21, PRD §3 and §10 example 14).
 *
 * **The arithmetic is a COUNT over the folded contracts, never a ledger.**
 * `YEAR_ALLOTMENT` says a Team gets one 4-year, one 3-year and two 2-year deals
 * per offseason, with 1-year deals unlimited. What a Team has left is that
 * budget minus the lengths its contracts currently carry — and "currently" is
 * the whole design, because an assignment is corrected by appending a later
 * `ContractLengthAssigned` for the same Player. The earlier length stops being
 * counted the moment the fold stops reporting it, so a correction needs no
 * compensating event and the allotment can never drift from the contracts.
 *
 * **The re-assignment trap, which is the only subtlety in the file.** A
 * refusal must be computed against the Team's OTHER contracts — the Player
 * being assigned is excluded from the count. Counting inclusively would refuse
 * re-assigning P1 from 4-year to 4-year (their own deal would look like the
 * spent one), and would refuse moving P1 from 4-year to 2-year whenever both
 * 2-year deals were spent elsewhere, even though that move frees a 4-year.
 * `remainingAllotment`'s `excludingPlayerId` argument is that exclusion, and it
 * is required rather than optional so no caller can forget it.
 *
 * **The 1-year deal is always offerable.** It has no count in `YEAR_ALLOTMENT`
 * at all — PRD §3 makes one-year deals unlimited — so it can never be
 * exhausted, and `isLengthOfferable` answers `true` for it without consulting
 * the remainder. That absence is deliberate and is why `RemainingAllotment` has
 * three fields rather than four.
 *
 * Nothing here reads a database, a clock or a random source: the whole state
 * arrives as an argument, folded from the log by the caller. Every sentence a
 * Manager sees on `/contract-assignment` is worded in this file, so the route,
 * the transaction and the tests read one wording.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { YEAR_ALLOTMENT } from '../constants.ts';
import type { AuctionContract, AuctionContracts, ContractYears } from '../projection/contracts.ts';
import { contractsWonBy } from '../projection/contracts.ts';
import type { SubmittedTeams } from '../projection/assignments.ts';
import { hasSubmittedAssignments } from '../projection/assignments.ts';
import type { SlotPlacement } from '../types.ts';
import { describeAmount } from './bidding.ts';
// `SLOT_LABELS`, never `positions.ts`'s `PLACEMENT_LABELS`: that record is the
// ARTICLE form ("an Active/Bench Slot") a sentence needs, and a row's metadata
// line is a readout rather than a sentence. Two spellings for two registers
// already existed; this surface takes the one that fits it.
import { SLOT_LABELS } from './roster-import.ts';

/**
 * Every length a Manager may choose, in the order the surface offers them.
 *
 * Ascending, and the shortest first, because 1 year is the only one that can
 * never be refused: a list that led with the 4-year would put the scarcest
 * choice under the Manager's thumb on a 375px screen.
 */
export const ASSIGNABLE_LENGTHS: readonly ContractYears[] = Object.freeze([1, 2, 3, 4]);

/**
 * What a Team has left of each COUNTED length.
 *
 * Three fields, matching `YEAR_ALLOTMENT` exactly. There is no `oneYear`
 * because there is no count to keep: see the header.
 */
export type RemainingAllotment = {
	readonly fourYear: number;
	readonly threeYear: number;
	readonly twoYear: number;
};

/** The state every rule in this file decides against, folded from the log. */
export type ContractAssignmentState = {
	/** Every Auction Contract the log has produced — the lengths live here. */
	readonly contracts: AuctionContracts;
	/** The Teams that have submitted as final. */
	readonly submitted: SubmittedTeams;
};

/** The acting Manager's Team, resolved from the session and never a form field. */
export type AssignmentActor = {
	readonly managerId: string;
	readonly teamId: string;
	/** That Team's name — what a refusal says out loud. */
	readonly teamName: string;
};

/** One Manager's request to give a Player a length. */
export type AssignContractLengthCommand = {
	readonly fantraxPlayerId: string;
	readonly contractYears: ContractYears;
};

/**
 * The label for one length — `1 year`, `2 years`.
 *
 * Written once so the radio, the refusal sentence and the remaining-allotment
 * sentence cannot spell the same length three ways.
 */
export function contractLengthLabel(years: ContractYears): string {
	return years === 1 ? '1 year' : `${String(years)} years`;
}

/** `1 four-year deal` / `2 four-year deals` — the plural, in one place. */
function dealPhrase(count: number, years: 2 | 3 | 4): string {
	const word = years === 2 ? 'two' : years === 3 ? 'three' : 'four';
	return `${String(count)} ${word}-year deal${count === 1 ? '' : 's'}`;
}

/**
 * How many of each counted length `teamId` has left, EXCLUDING the contract of
 * `excludingPlayerId`.
 *
 * `excludingPlayerId` is required and takes `null` for "count everything" —
 * what the surface's own summary wants. A gate always passes the Player being
 * assigned, for the reason in the header. Counted over `contractsWonBy`, which
 * is already this Team's contracts in a stable order, so the count is a
 * function of the fold and of nothing incidental.
 *
 * The result can never go negative: a length is only ever spent through a gate
 * that refused an over-spend, so a negative here would mean an event was
 * appended past the gate. It is clamped at zero anyway, because a refusal
 * sentence reading "−1 four-year deals left" would be worse than a wrong count
 * stated plainly, and `isLengthOfferable` reads `> 0` either way.
 */
export function remainingAllotment(
	contracts: AuctionContracts,
	teamId: string,
	excludingPlayerId: string | null
): RemainingAllotment {
	let four = 0;
	let three = 0;
	let two = 0;
	for (const contract of contractsWonBy(contracts, teamId)) {
		if (contract.fantraxPlayerId === excludingPlayerId) continue;
		if (contract.contractYears === 4) four += 1;
		else if (contract.contractYears === 3) three += 1;
		else if (contract.contractYears === 2) two += 1;
	}
	return {
		fourYear: Math.max(0, YEAR_ALLOTMENT.fourYear - four),
		threeYear: Math.max(0, YEAR_ALLOTMENT.threeYear - three),
		twoYear: Math.max(0, YEAR_ALLOTMENT.twoYear - two)
	};
}

/**
 * Whether `years` may still be offered against `remaining`.
 *
 * The 1-year deal answers `true` unconditionally and without reading
 * `remaining` at all — it is unlimited, so there is nothing to read.
 */
export function isLengthOfferable(remaining: RemainingAllotment, years: ContractYears): boolean {
	if (years === 1) return true;
	if (years === 2) return remaining.twoYear > 0;
	if (years === 3) return remaining.threeYear > 0;
	return remaining.fourYear > 0;
}

/** Which lengths are still offerable, in `ASSIGNABLE_LENGTHS`' order. */
export function offerableLengths(remaining: RemainingAllotment): readonly ContractYears[] {
	return ASSIGNABLE_LENGTHS.filter((years) => isLengthOfferable(remaining, years));
}

/**
 * The remaining allotment in words — what the Manager reads above the list.
 *
 * It always names the 1-year deal's unlimited supply, including when everything
 * else is exhausted, because that is precisely the state (§10 example 14) in
 * which a Manager most needs to be told they can still finish.
 */
export function remainingAllotmentSentence(remaining: RemainingAllotment): string {
	return (
		`Your Year Allotment has ${dealPhrase(remaining.fourYear, 4)}, ` +
		`${dealPhrase(remaining.threeYear, 3)} and ${dealPhrase(remaining.twoYear, 2)} left. ` +
		'One-year deals are unlimited and are always available.'
	);
}

/** The Team's contracts that still carry no length. */
export function unassignedContracts(
	contracts: AuctionContracts,
	teamId: string
): readonly AuctionContract[] {
	return contractsWonBy(contracts, teamId).filter((contract) => contract.contractYears === null);
}

// --- Refusals ---------------------------------------------------------------

/**
 * Every way an assignment or a submission is refused.
 *
 * `nomination.ts`'s `NominationRefusal` shape, and its `*RefusalDetail`
 * wording split: the union states the FACT and carries what a sentence has to
 * name, and one function below turns each into the one sentence the product
 * says. No route words a refusal of its own.
 *
 * `unconfirmed` and `unbound_actor` are raised by the route rather than by the
 * gate — `/nominate`'s split, for its reason: neither has anything to decide
 * about inside a transaction, and `auction_events.manager_id`/`team_id` are NOT
 * NULL (AD-4) so an unbound actor has no event to append. Their sentences still
 * come from here.
 *
 * `not_won` covers THREE cases with one sentence — "no such contract", "that
 * contract belongs to somebody else", and the route's own "this request named
 * no Player at all" — because from the acting Manager's side they are the same
 * fact: it is not a Player their Team won. The third is raised by
 * `+page.server.ts` before any transaction opens, for the reason its header
 * gives: a submit that names nobody has nothing for the gate to decide about,
 * and an unnamed Player is not among the ones this Team won either.
 */
export type ContractAssignmentRefusal =
	| { readonly kind: 'unbound_actor' }
	| { readonly kind: 'unconfirmed' }
	| { readonly kind: 'invalid_length' }
	| { readonly kind: 'not_won' }
	| { readonly kind: 'already_final'; readonly teamName: string }
	| {
			readonly kind: 'exhausted';
			readonly playerName: string;
			readonly years: ContractYears;
			/**
			 * The Team's remainder counting EVERY contract it holds — the
			 * inclusive count, deliberately NOT the exclusive one the gate
			 * decided against.
			 *
			 * The two differ on a re-assignment, and only one of them is a true
			 * sentence about the Team. `remainingAllotmentSentence` says "Your
			 * Year Allotment has … left", which is a claim about the TEAM, and
			 * the page header states the same figure from
			 * `assignmentBoardFor`'s inclusive count. Carrying the exclusive
			 * count here would print two different four-year counts on one
			 * screen: refuse a move of a Player off their 4-year and the
			 * refusal would claim a four-year deal is available while the
			 * header, correctly, says none is.
			 *
			 * The exclusion belongs to the DECISION and stays there — see
			 * `refuseAssignment`. What the Manager is TOLD about their allotment
			 * is the allotment they actually have.
			 */
			readonly remaining: RemainingAllotment;
	  }
	| { readonly kind: 'unset_on_submit'; readonly unsetCount: number }
	| { readonly kind: 'unrecorded' };

/**
 * The one refusal sentence for each case.
 *
 * `nomination.ts`'s product voice: state the fact, name the Player, the Team or
 * the figure it is about, then say what would change it. No apology, no
 * exclamation mark. Every sentence ends by saying nothing was written, because
 * that is the whole point of a refusal at this gate — no length was assigned,
 * the allotment is unmoved and the Team is not final.
 */
export function contractAssignmentRefusalDetail(refusal: ContractAssignmentRefusal): string {
	switch (refusal.kind) {
		case 'unbound_actor':
			return (
				'No length was assigned: you are not bound to a Team, and every event must name ' +
				'one. Ask the Commissioner to bind your Team. Nothing was written.'
			);
		case 'unconfirmed':
			return (
				'No length was assigned: the confirmation was not given. A length spends your ' +
				'Team’s Year Allotment, so it is never inferred from a submit. Tick the ' +
				'confirmation and submit again. Nothing was written.'
			);
		case 'invalid_length':
			return (
				'No length was assigned: the length submitted is not 1, 2, 3 or 4 years. Those ' +
				'four are the only contract lengths the league has. Nothing was written.'
			);
		case 'not_won':
			return (
				'No length was assigned: the Player named is not one your Team won at auction. ' +
				'Only an Auction Contract carries a length, and this page lists every one your ' +
				'Team holds. Nothing was written.'
			);
		case 'already_final':
			return (
				`No length was assigned: ${refusal.teamName} has submitted its contract ` +
				'assignments as final, and a final Team’s lengths do not change. Ask the ' +
				'Commissioner if something has to be corrected. Nothing was written.'
			);
		case 'exhausted':
			return (
				`No length was assigned: your Team has no ${contractLengthLabel(refusal.years)} deal ` +
				`left to give ${refusal.playerName}. ${remainingAllotmentSentence(refusal.remaining)} ` +
				'Nothing was written.'
			);
		case 'unset_on_submit':
			return (
				`Your Team was not submitted: ${String(refusal.unsetCount)} of the Players it won ` +
				`still ${refusal.unsetCount === 1 ? 'has' : 'have'} no contract length. Every won ` +
				'Player carries a length before a Team is final. Nothing was written.'
			);
		case 'unrecorded':
			return 'The write was refused and stated no reason. Nothing was written.';
	}
}

/**
 * The gates for one assignment, in order: the Team's finality, then the
 * contract's existence and ownership, then the allotment. Returns the first
 * refusal, or `null` when every gate holds.
 *
 * **Finality goes first** for `refuseNomination`'s reason: once a Team is
 * final, which Player was named and what was left of its allotment are both
 * beside the point, and "your Team is final" is the honest answer. `not_won`
 * follows immediately because the sentence after it names the Player, and a
 * gate cannot state a length against a contract that does not exist.
 *
 * The allotment is counted EXCLUDING this Player, which is the whole subtlety —
 * see the header. Re-assigning P1 from a 4-year to a 4-year therefore passes,
 * because P1's own 4-year is not among the deals counted as spent.
 *
 * Exported so the ordering is assertable as pure logic rather than inferred
 * from a transaction. Takes no clock, no database and no random source.
 */
export function refuseAssignment(
	state: ContractAssignmentState,
	actor: AssignmentActor,
	command: AssignContractLengthCommand
): ContractAssignmentRefusal | null {
	if (hasSubmittedAssignments(state.submitted, actor.teamId)) {
		return { kind: 'already_final', teamName: actor.teamName };
	}

	const contract = contractsWonBy(state.contracts, actor.teamId).find(
		(won) => won.fantraxPlayerId === command.fantraxPlayerId
	);
	if (contract === undefined) return { kind: 'not_won' };

	// The remainder this Player's own current length is NOT counted against.
	// This is the count the DECISION is made on, and it is the only thing it is
	// used for.
	const offerable = remainingAllotment(state.contracts, actor.teamId, command.fantraxPlayerId);
	if (!isLengthOfferable(offerable, command.contractYears)) {
		return {
			kind: 'exhausted',
			playerName: contract.playerName,
			years: command.contractYears,
			// The INCLUSIVE count for the SENTENCE — see the field's own note.
			// The refusal states what the Team has, which is what the page
			// header states too; the exclusion never leaves this function.
			remaining: remainingAllotment(state.contracts, actor.teamId, null)
		};
	}

	return null;
}

/**
 * The gates for submitting a Team as final: it is not already final, and every
 * Player it won carries a length.
 *
 * A Team that won NOTHING passes both and submits an empty Team, which is
 * correct: it has no assignments to make and Story 6.2's completion roster must
 * be able to count it as done rather than as permanently outstanding.
 */
export function refuseSubmission(
	state: ContractAssignmentState,
	actor: AssignmentActor
): ContractAssignmentRefusal | null {
	if (hasSubmittedAssignments(state.submitted, actor.teamId)) {
		return { kind: 'already_final', teamName: actor.teamName };
	}

	const unset = unassignedContracts(state.contracts, actor.teamId).length;
	if (unset > 0) return { kind: 'unset_on_submit', unsetCount: unset };

	return null;
}

// --- The surface's own view -------------------------------------------------

/** One won Player, as the assignment surface lists them. */
export type AssignmentRow = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** What the Auction was won for, in the abbreviated form (AD-8). */
	readonly winningAmountLabel: string;
	readonly placement: SlotPlacement;
	/** That placement in words — `Active/Bench` or `Minor League`. */
	readonly placementLabel: string;
	/** The length currently assigned, or `null` while it is unset. */
	readonly contractYears: ContractYears | null;
	/** `Not assigned`, or `4 years`. */
	readonly lengthLabel: string;
	/**
	 * Which lengths this Player may be given, counted with this Player's OWN
	 * current length excluded — so a Player already on a 4-year is still offered
	 * the 4-year, and a Player on nothing is offered only what is left.
	 */
	readonly offerable: readonly ContractYears[];
};

/** Everything `/contract-assignment` renders, worded by the core. */
export type AssignmentBoard = {
	readonly rows: readonly AssignmentRow[];
	/** The Team's remaining allotment, counting every contract it holds. */
	readonly remaining: RemainingAllotment;
	readonly remainingSentence: string;
	/** How many won Players still carry no length. */
	readonly unsetCount: number;
	readonly submitted: boolean;
	/** Why the surface is read-only, or `null` when it is not. */
	readonly submittedDetail: string | null;
	/** Whether a submission would be accepted right now. */
	readonly canSubmit: boolean;
	/** Why it would not be, or `null` when it would. */
	readonly submitBlockedDetail: string | null;
	/** What submitting costs, stated beside the confirmation. */
	readonly submitConsequence: string;
};

/**
 * The whole surface, derived from the fold and nothing else.
 *
 * It lives in the core rather than in the route for the reason the header
 * gives: the allotment arithmetic is reachable with no database, and a route
 * that built this itself would be a second statement of which lengths are
 * offerable. Every sentence on it comes from this file.
 *
 * Rows are `contractsWonBy`'s order — newest close first, tie-broken totally on
 * the Player id — so two renders of one state list the Players identically.
 * ASSIGNED Players stay in the list beside unassigned ones, because a
 * correction is the whole reason assignment is changeable before a Team is
 * final; a list that dropped a Player the moment they were given a length would
 * make the 4-year unrecoverable by design.
 */
export function assignmentBoardFor(
	state: ContractAssignmentState,
	actor: AssignmentActor
): AssignmentBoard {
	const won = contractsWonBy(state.contracts, actor.teamId);
	const submitted = hasSubmittedAssignments(state.submitted, actor.teamId);
	// `unassignedContracts`, not a second filter of its own: `refuseSubmission`
	// counts the same Players to decide whether this Team may go final, and a
	// board that counted them differently would offer a submit the gate refuses.
	const unsetCount = unassignedContracts(state.contracts, actor.teamId).length;

	const rows: AssignmentRow[] = won.map((contract) => ({
		fantraxPlayerId: contract.fantraxPlayerId,
		playerName: contract.playerName,
		// `describeAmount`, which renders through `formatMoney` and describes an
		// off-grid historical amount rather than throwing a `RangeError` that
		// would take the whole page down over one bad row.
		winningAmountLabel: describeAmount(contract.winningAmount),
		placement: contract.placement,
		// Worded HERE and never on the surface. A ternary on the page would also
		// silently label a future third `SlotPlacement` as Active/Bench; this
		// record is keyed on the type, so a new kind is a compile error instead.
		placementLabel: SLOT_LABELS[contract.placement],
		contractYears: contract.contractYears,
		lengthLabel:
			contract.contractYears === null ? 'Not assigned' : contractLengthLabel(contract.contractYears),
		offerable: offerableLengths(
			remainingAllotment(state.contracts, actor.teamId, contract.fantraxPlayerId)
		)
	}));

	const remaining = remainingAllotment(state.contracts, actor.teamId, null);
	const blocking = refuseSubmission(state, actor);

	return {
		rows,
		remaining,
		remainingSentence: remainingAllotmentSentence(remaining),
		unsetCount,
		submitted,
		submittedDetail: submitted
			? contractAssignmentRefusalDetail({ kind: 'already_final', teamName: actor.teamName })
			: null,
		canSubmit: blocking === null,
		submitBlockedDetail: blocking === null ? null : contractAssignmentRefusalDetail(blocking),
		submitConsequence:
			'Submitting is final: once your Team is submitted, no length on it changes again ' +
			'and every correction goes through the Commissioner.'
	};
}
