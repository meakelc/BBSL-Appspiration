/**
 * The Year Allotment rules, driven directly against a folded log — no
 * database, no HTTP, no clock (Story 6.1, FR-21).
 *
 * The whole point of putting this arithmetic in `core/rules/` is that it is
 * reachable this way, so every row of the story's I/O & Edge-Case Matrix that
 * is a RULE rather than a transport concern is asserted here. The two rows that
 * are not — the unconfirmed post and the wrong phase — are the route's, and
 * live in `tests/routes/contract-assignment.test.ts`; their sentences are still
 * this module's and are asserted below.
 *
 * The re-assignment cases are the reason the file exists. A count that included
 * the Player being assigned would pass every first-assignment case here and fail
 * exactly the two corrections a Manager is most likely to make.
 */

import { describe, expect, it } from 'vitest';

import { closedPayload } from '../fixtures/closed-event.ts';

import { YEAR_ALLOTMENT } from '../../src/lib/core/constants.ts';
import {
	ASSIGNMENTS_SUBMITTED_EVENT,
	INITIAL_ASSIGNMENTS,
	assignmentsReducer,
	hasSubmittedAssignments
} from '../../src/lib/core/projection/assignments.ts';
import {
	CONTRACT_LENGTH_ASSIGNED_EVENT,
	INITIAL_CONTRACTS,
	contractsReducer
} from '../../src/lib/core/projection/contracts.ts';
import type { ContractYears } from '../../src/lib/core/projection/contracts.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import {
	ASSIGNABLE_LENGTHS,
	assignmentBoardFor,
	contractAssignmentRefusalDetail,
	contractLengthLabel,
	isLengthOfferable,
	offerableLengths,
	refuseAssignment,
	refuseSubmission,
	remainingAllotment,
	remainingAllotmentSentence,
	unassignedContracts
} from '../../src/lib/core/rules/contract-assignment.ts';
import type {
	AssignmentActor,
	ContractAssignmentState
} from '../../src/lib/core/rules/contract-assignment.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';

const TEAM = 't-k';
const OTHER_TEAM = 't-other';

const ACTOR: AssignmentActor = { managerId: 'm-k', teamId: TEAM, teamName: 'Team K' };
const OTHER_ACTOR: AssignmentActor = {
	managerId: 'm-o',
	teamId: OTHER_TEAM,
	teamName: 'Team Other'
};

let nextSeq = 0;

function event(type: string, payload: unknown, occurredAt = '2026-09-01T09:00:00.000Z'): AppendedEvent {
	nextSeq += 1;
	return {
		seq: String(nextSeq),
		occurredAt,
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: 'm-k',
		teamId: TEAM,
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

/** A close that awards `playerId` to `teamId`, closing at a distinct instant. */
function won(
	playerId: string,
	playerName: string,
	teamId: string = TEAM,
	closedAt = '2026-08-27T09:00:00.000Z'
): AppendedEvent {
	return event(
		AUCTION_CLOSED_EVENT,
		closedPayload({
			fantraxPlayerId: playerId,
			playerName,
			teamId,
			teamName: teamId === TEAM ? 'Team K' : 'Team Other',
			closedAt
		})
	);
}

/** An assignment of `years` to `playerId`, as `assignContractLength` builds one. */
function assigned(
	playerId: string,
	years: ContractYears,
	teamId: string = TEAM
): AppendedEvent {
	return event(CONTRACT_LENGTH_ASSIGNED_EVENT, {
		fantraxPlayerId: playerId,
		playerName: playerId,
		teamId,
		teamName: teamId === TEAM ? 'Team K' : 'Team Other',
		managerId: 'm-k',
		contractYears: years
	});
}

/** A Team going final. */
function submitted(teamId: string = TEAM): AppendedEvent {
	return event(ASSIGNMENTS_SUBMITTED_EVENT, {
		teamId,
		teamName: teamId === TEAM ? 'Team K' : 'Team Other',
		managerId: 'm-k',
		assignedCount: 0
	});
}

function stateOf(...events: readonly AppendedEvent[]): ContractAssignmentState {
	return {
		contracts: fold(INITIAL_CONTRACTS, events, contractsReducer),
		submitted: fold(INITIAL_ASSIGNMENTS, events, assignmentsReducer)
	};
}

/** Team K won five Players, as §10 example 14 has it. */
const FIVE_WINS: readonly AppendedEvent[] = [
	won('p-1', 'Player One', TEAM, '2026-08-27T09:00:00.000Z'),
	won('p-2', 'Player Two', TEAM, '2026-08-27T10:00:00.000Z'),
	won('p-3', 'Player Three', TEAM, '2026-08-27T11:00:00.000Z'),
	won('p-4', 'Player Four', TEAM, '2026-08-27T12:00:00.000Z'),
	won('p-5', 'Player Five', TEAM, '2026-08-27T13:00:00.000Z')
];

describe('remainingAllotment — a count over the folded lengths, never a ledger', () => {
	it('starts at the whole Year Allotment when nothing is assigned', () => {
		const state = stateOf(...FIVE_WINS);
		expect(remainingAllotment(state.contracts, TEAM, null)).toEqual({
			fourYear: YEAR_ALLOTMENT.fourYear,
			threeYear: YEAR_ALLOTMENT.threeYear,
			twoYear: YEAR_ALLOTMENT.twoYear
		});
	});

	it('spends one deal per assigned length', () => {
		const state = stateOf(...FIVE_WINS, assigned('p-1', 4), assigned('p-2', 2));
		expect(remainingAllotment(state.contracts, TEAM, null)).toEqual({
			fourYear: 0,
			threeYear: 1,
			twoYear: 1
		});
	});

	it('does not count 1-year deals at all — they are unlimited', () => {
		const state = stateOf(
			...FIVE_WINS,
			assigned('p-1', 1),
			assigned('p-2', 1),
			assigned('p-3', 1),
			assigned('p-4', 1),
			assigned('p-5', 1)
		);
		expect(remainingAllotment(state.contracts, TEAM, null)).toEqual({
			fourYear: 1,
			threeYear: 1,
			twoYear: 2
		});
	});

	it('counts only the named Team’s contracts', () => {
		const state = stateOf(
			...FIVE_WINS,
			won('p-9', 'Somebody Else', OTHER_TEAM),
			assigned('p-9', 4, OTHER_TEAM)
		);
		expect(remainingAllotment(state.contracts, TEAM, null).fourYear).toBe(1);
		expect(remainingAllotment(state.contracts, OTHER_TEAM, null).fourYear).toBe(0);
	});

	it('EXCLUDES the Player being assigned — the whole subtlety', () => {
		const state = stateOf(...FIVE_WINS, assigned('p-1', 4));
		// Counting inclusively, P1's own 4-year would read as spent.
		expect(remainingAllotment(state.contracts, TEAM, null).fourYear).toBe(0);
		expect(remainingAllotment(state.contracts, TEAM, 'p-1').fourYear).toBe(1);
	});

	it('frees the previously held length when a Player is re-assigned', () => {
		const state = stateOf(...FIVE_WINS, assigned('p-1', 4), assigned('p-1', 2));
		// The 4-year came back the moment the fold stopped reporting it. No
		// compensating event was appended, and none exists.
		expect(remainingAllotment(state.contracts, TEAM, null)).toEqual({
			fourYear: 1,
			threeYear: 1,
			twoYear: 1
		});
	});

	it('never goes negative, however the log got there', () => {
		// Two 4-year deals against a budget of one — unreachable through the
		// gate, and clamped rather than printed as "−1 four-year deals left".
		const state = stateOf(...FIVE_WINS, assigned('p-1', 4), assigned('p-2', 4));
		expect(remainingAllotment(state.contracts, TEAM, null).fourYear).toBe(0);
	});
});

describe('isLengthOfferable / offerableLengths', () => {
	it('always offers the 1-year deal, whatever is left', () => {
		const exhausted = { fourYear: 0, threeYear: 0, twoYear: 0 };
		expect(isLengthOfferable(exhausted, 1)).toBe(true);
		expect(offerableLengths(exhausted)).toEqual([1]);
	});

	it('offers all four when nothing is spent, shortest first', () => {
		expect(offerableLengths({ fourYear: 1, threeYear: 1, twoYear: 2 })).toEqual([1, 2, 3, 4]);
		expect(ASSIGNABLE_LENGTHS).toEqual([1, 2, 3, 4]);
	});

	it('drops exactly the exhausted lengths', () => {
		expect(offerableLengths({ fourYear: 0, threeYear: 1, twoYear: 0 })).toEqual([1, 3]);
	});
});

describe('refuseAssignment — the gates, in order', () => {
	it('accepts the first assignment against an untouched allotment', () => {
		const state = stateOf(...FIVE_WINS);
		expect(refuseAssignment(state, ACTOR, { fantraxPlayerId: 'p-1', contractYears: 4 })).toBeNull();
	});

	it('refuses an exhausted length, naming it and stating what remains (§10 ex. 14)', () => {
		const state = stateOf(
			...FIVE_WINS,
			assigned('p-1', 4),
			assigned('p-2', 3),
			assigned('p-3', 2),
			assigned('p-4', 2)
		);
		const refusal = refuseAssignment(state, ACTOR, { fantraxPlayerId: 'p-5', contractYears: 3 });

		expect(refusal).toEqual({
			kind: 'exhausted',
			playerName: 'Player Five',
			years: 3,
			remaining: { fourYear: 0, threeYear: 0, twoYear: 0 }
		});
		const detail = contractAssignmentRefusalDetail(refusal!);
		// The refusal NAMES the exhausted length and states what is left.
		expect(detail).toContain('3 years');
		expect(detail).toContain('Player Five');
		expect(detail).toContain('One-year deals are unlimited');
		expect(detail).toContain('Nothing was written.');
	});

	it('still accepts the 1-year deal with everything else exhausted', () => {
		const state = stateOf(
			...FIVE_WINS,
			assigned('p-1', 4),
			assigned('p-2', 3),
			assigned('p-3', 2),
			assigned('p-4', 2)
		);
		expect(refuseAssignment(state, ACTOR, { fantraxPlayerId: 'p-5', contractYears: 1 })).toBeNull();
	});

	it('accepts a re-assignment to the SAME length — the Player’s own deal is excluded', () => {
		const state = stateOf(...FIVE_WINS, assigned('p-1', 4));
		expect(refuseAssignment(state, ACTOR, { fantraxPlayerId: 'p-1', contractYears: 4 })).toBeNull();
	});

	it('accepts moving a Player off a 4-year onto a 2-year the Team has left', () => {
		const state = stateOf(...FIVE_WINS, assigned('p-1', 4), assigned('p-2', 2));
		expect(refuseAssignment(state, ACTOR, { fantraxPlayerId: 'p-1', contractYears: 2 })).toBeNull();
	});

	it('still refuses a move onto a length genuinely spent ELSEWHERE', () => {
		const state = stateOf(...FIVE_WINS, assigned('p-1', 4), assigned('p-2', 2), assigned('p-3', 2));
		// Both 2-year deals are held by other Players, so P1's move has nothing
		// to move onto — the exclusion frees a 4-year, never a 2-year.
		expect(refuseAssignment(state, ACTOR, { fantraxPlayerId: 'p-1', contractYears: 2 })).toEqual({
			kind: 'exhausted',
			playerName: 'Player One',
			years: 2,
			// The INCLUSIVE remainder — what Team K actually has — and NOT the
			// exclusive count the gate decided on, which would read `fourYear: 1`
			// here because P1's own 4-year is discounted. The sentence says "Your
			// Year Allotment has … left", which is a claim about the TEAM, and
			// P1 still holds that four-year deal while this refusal is written.
			remaining: { fourYear: 0, threeYear: 1, twoYear: 0 }
		});
	});

	it('states the SAME allotment figure the page header does, on one screen', () => {
		// The bug this pins: the gate counts exclusively so a re-assignment is
		// not refused against the Player's own deal, but the refusal SENTENCE and
		// the header are both claims about the Team and must agree. A Manager
		// reading "1 four-year deal left" above a header saying 0 is being told
		// two different things about one allotment.
		const state = stateOf(...FIVE_WINS, assigned('p-1', 4), assigned('p-2', 2), assigned('p-3', 2));

		const refusal = refuseAssignment(state, ACTOR, { fantraxPlayerId: 'p-1', contractYears: 2 });
		const board = assignmentBoardFor(state, ACTOR);

		expect(refusal?.kind).toBe('exhausted');
		// The figures, and then the whole sentence they render into.
		expect(refusal !== null && refusal.kind === 'exhausted' ? refusal.remaining : null).toEqual(
			board.remaining
		);
		expect(contractAssignmentRefusalDetail(refusal!)).toContain(board.remainingSentence);
	});

	it('refuses every assignment once the Team is final, before anything else', () => {
		const state = stateOf(...FIVE_WINS, submitted());
		const refusal = refuseAssignment(state, ACTOR, { fantraxPlayerId: 'p-1', contractYears: 1 });

		expect(refusal).toEqual({ kind: 'already_final', teamName: 'Team K' });
		expect(contractAssignmentRefusalDetail(refusal!)).toContain('Team K');
		// Finality is answered even for a Player this Team never won, which is
		// what "before anything else" means.
		expect(refuseAssignment(state, ACTOR, { fantraxPlayerId: 'nobody', contractYears: 1 })).toEqual({
			kind: 'already_final',
			teamName: 'Team K'
		});
	});

	it('another Team going final leaves this one free to assign', () => {
		const state = stateOf(...FIVE_WINS, submitted(OTHER_TEAM));
		expect(hasSubmittedAssignments(state.submitted, TEAM)).toBe(false);
		expect(refuseAssignment(state, ACTOR, { fantraxPlayerId: 'p-1', contractYears: 4 })).toBeNull();
	});

	it('refuses a Player this Team did not win', () => {
		const state = stateOf(...FIVE_WINS, won('p-9', 'Somebody Else', OTHER_TEAM));
		expect(refuseAssignment(state, ACTOR, { fantraxPlayerId: 'p-9', contractYears: 1 })).toEqual({
			kind: 'not_won'
		});
		expect(refuseAssignment(state, ACTOR, { fantraxPlayerId: 'ghost', contractYears: 1 })).toEqual({
			kind: 'not_won'
		});
	});
});

describe('refuseSubmission — a Team goes final once, and only when it is complete', () => {
	it('refuses while any won Player has no length, naming how many', () => {
		const state = stateOf(...FIVE_WINS, assigned('p-1', 4), assigned('p-2', 3));
		const refusal = refuseSubmission(state, ACTOR);

		expect(refusal).toEqual({ kind: 'unset_on_submit', unsetCount: 3 });
		expect(contractAssignmentRefusalDetail(refusal!)).toContain('3 of the Players');
		expect(contractAssignmentRefusalDetail(refusal!)).toContain('have no contract length');
	});

	it('says "has" for exactly one outstanding Player', () => {
		expect(contractAssignmentRefusalDetail({ kind: 'unset_on_submit', unsetCount: 1 })).toContain(
			'1 of the Players it won still has no contract length'
		);
	});

	it('accepts once every won Player carries a length', () => {
		const state = stateOf(
			...FIVE_WINS,
			assigned('p-1', 4),
			assigned('p-2', 3),
			assigned('p-3', 2),
			assigned('p-4', 2),
			assigned('p-5', 1)
		);
		expect(unassignedContracts(state.contracts, TEAM)).toEqual([]);
		expect(refuseSubmission(state, ACTOR)).toBeNull();
	});

	it('accepts a Team that won nothing — it has nothing outstanding', () => {
		expect(refuseSubmission(stateOf(...FIVE_WINS), OTHER_ACTOR)).toBeNull();
	});

	it('refuses a second submission from a Team already final', () => {
		const state = stateOf(submitted());
		expect(refuseSubmission(state, ACTOR)).toEqual({
			kind: 'already_final',
			teamName: 'Team K'
		});
	});
});

describe('the refusal sentences', () => {
	it('words every kind, and every one says nothing was written', () => {
		const sentences = [
			contractAssignmentRefusalDetail({ kind: 'unbound_actor' }),
			contractAssignmentRefusalDetail({ kind: 'unconfirmed' }),
			contractAssignmentRefusalDetail({ kind: 'invalid_length' }),
			contractAssignmentRefusalDetail({ kind: 'not_won' }),
			contractAssignmentRefusalDetail({ kind: 'already_final', teamName: 'Team K' }),
			contractAssignmentRefusalDetail({
				kind: 'exhausted',
				playerName: 'Player Five',
				years: 4,
				remaining: { fourYear: 0, threeYear: 1, twoYear: 2 }
			}),
			contractAssignmentRefusalDetail({ kind: 'unset_on_submit', unsetCount: 2 }),
			contractAssignmentRefusalDetail({ kind: 'unrecorded' })
		];
		for (const sentence of sentences) {
			expect(sentence).toContain('Nothing was written.');
			expect(sentence).not.toContain('!');
			expect(sentence.length).toBeGreaterThan(40);
		}
	});

	it('spells one year singular and the rest plural, in one place', () => {
		expect(contractLengthLabel(1)).toBe('1 year');
		expect(contractLengthLabel(2)).toBe('2 years');
		expect(contractLengthLabel(4)).toBe('4 years');
	});

	it('pluralises the remaining-allotment sentence', () => {
		expect(remainingAllotmentSentence({ fourYear: 1, threeYear: 1, twoYear: 2 })).toBe(
			'Your Year Allotment has 1 four-year deal, 1 three-year deal and 2 two-year deals ' +
				'left. One-year deals are unlimited and are always available.'
		);
		expect(remainingAllotmentSentence({ fourYear: 0, threeYear: 0, twoYear: 0 })).toContain(
			'0 four-year deals, 0 three-year deals and 0 two-year deals left'
		);
	});
});

describe('assignmentBoardFor — the surface, derived from the fold and nothing else', () => {
	it('lists every won Player with their current length and what they may be given', () => {
		const state = stateOf(...FIVE_WINS, assigned('p-1', 4));
		const board = assignmentBoardFor(state, ACTOR);

		expect(board.rows).toHaveLength(5);
		expect(board.unsetCount).toBe(4);

		const p1 = board.rows.find((row) => row.fantraxPlayerId === 'p-1');
		expect(p1?.contractYears).toBe(4);
		expect(p1?.lengthLabel).toBe('4 years');
		// P1 keeps the 4-year on offer: their own deal is excluded from the count.
		expect(p1?.offerable).toEqual([1, 2, 3, 4]);

		// The placement in words, so no surface writes a ternary of its own.
		expect(p1?.placement).toBe('active_bench');
		expect(p1?.placementLabel).toBe('Active/Bench');

		const p2 = board.rows.find((row) => row.fantraxPlayerId === 'p-2');
		expect(p2?.contractYears).toBeNull();
		expect(p2?.lengthLabel).toBe('Not assigned');
		// P2 cannot have the 4-year: P1 holds it.
		expect(p2?.offerable).toEqual([1, 2, 3]);
	});

	it('words a Minor League placement from the core’s own record', () => {
		const state = stateOf(
			event(
				AUCTION_CLOSED_EVENT,
				closedPayload({
					fantraxPlayerId: 'p-m',
					playerName: 'Stashed Player',
					teamId: TEAM,
					teamName: 'Team K',
					placement: 'minor_league',
					capHit: 0
				})
			)
		);
		const row = assignmentBoardFor(state, ACTOR).rows[0];
		expect(row?.placement).toBe('minor_league');
		expect(row?.placementLabel).toBe('Minor League');
	});

	it('renders money in the abbreviated form and nothing else (AD-8)', () => {
		const state = stateOf(...FIVE_WINS);
		const board = assignmentBoardFor(state, ACTOR);
		for (const row of board.rows) {
			expect(row.winningAmountLabel).toMatch(/^\$\d+\.\dM$/);
		}
	});

	it('offers only the 1-year with the allotment exhausted (§10 ex. 14)', () => {
		const state = stateOf(
			...FIVE_WINS,
			assigned('p-1', 4),
			assigned('p-2', 3),
			assigned('p-3', 2),
			assigned('p-4', 2)
		);
		const board = assignmentBoardFor(state, ACTOR);
		expect(board.rows.find((row) => row.fantraxPlayerId === 'p-5')?.offerable).toEqual([1]);
		expect(board.canSubmit).toBe(false);
		expect(board.submitBlockedDetail).toContain('1 of the Players');
	});

	it('states the Team is final and blocks submission once it has submitted', () => {
		const state = stateOf(...FIVE_WINS, submitted());
		const board = assignmentBoardFor(state, ACTOR);

		expect(board.submitted).toBe(true);
		expect(board.submittedDetail).toContain('Team K');
		expect(board.canSubmit).toBe(false);
	});

	it('is empty and submittable for a Team that won nothing', () => {
		const board = assignmentBoardFor(stateOf(...FIVE_WINS), OTHER_ACTOR);
		expect(board.rows).toEqual([]);
		expect(board.unsetCount).toBe(0);
		expect(board.canSubmit).toBe(true);
		expect(board.submitBlockedDetail).toBeNull();
	});

	it('reads the allotment sentence off the same count the rows do', () => {
		const state = stateOf(...FIVE_WINS, assigned('p-1', 4));
		const board = assignmentBoardFor(state, ACTOR);
		expect(board.remaining).toEqual({ fourYear: 0, threeYear: 1, twoYear: 2 });
		expect(board.remainingSentence).toBe(remainingAllotmentSentence(board.remaining));
	});
});

describe('assignmentsReducer — per-Team submission, folded from the log', () => {
	it('records nothing before any submission', () => {
		expect(fold(INITIAL_ASSIGNMENTS, FIVE_WINS, assignmentsReducer)).toEqual(new Set());
		expect(hasSubmittedAssignments(INITIAL_ASSIGNMENTS, TEAM)).toBe(false);
	});

	it('records exactly the Teams that submitted', () => {
		const state = fold(
			INITIAL_ASSIGNMENTS,
			[submitted(TEAM), submitted(OTHER_TEAM)],
			assignmentsReducer
		);
		expect(hasSubmittedAssignments(state, TEAM)).toBe(true);
		expect(hasSubmittedAssignments(state, OTHER_TEAM)).toBe(true);
		expect(hasSubmittedAssignments(state, 't-nobody')).toBe(false);
	});

	it('converges under replay — a repeated submission is a no-op', () => {
		const log = [submitted(TEAM)];
		const once = fold(INITIAL_ASSIGNMENTS, log, assignmentsReducer);
		const twice = fold(INITIAL_ASSIGNMENTS, [...log, ...log], assignmentsReducer);
		expect(twice).toEqual(once);
		// And the reducer never mutated the state it was handed.
		expect(INITIAL_ASSIGNMENTS.size).toBe(0);
	});

	it('SKIPS a submission naming no Team rather than throwing over it', () => {
		for (const payload of [
			{ teamName: 'Team K' },
			{ teamId: '' },
			{ teamId: 42 },
			'nonsense',
			null,
			undefined
		]) {
			const state = fold(
				INITIAL_ASSIGNMENTS,
				[event(ASSIGNMENTS_SUBMITTED_EVENT, payload)],
				assignmentsReducer
			);
			expect(state.size, JSON.stringify(payload ?? null)).toBe(0);
		}
	});

	it('is not about events it has not been taught', () => {
		const state = fold(INITIAL_ASSIGNMENTS, [assigned('p-1', 4)], assignmentsReducer);
		expect(state).toEqual(INITIAL_ASSIGNMENTS);
	});
});
