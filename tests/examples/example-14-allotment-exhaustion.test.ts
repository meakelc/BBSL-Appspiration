/**
 * PRD §10 example 14 — **Allotment exhaustion** (FR-21, PRD §3).
 *
 * > Team K won five players and has already used its 4-year, 3-year, and both
 * > 2-year deals. Every remaining player must be assigned 1 year; longer
 * > options are unavailable.
 *
 * The example is the Year Allotment's whole shape in one state: a budget of
 * four counted deals against five won Players, so the fifth Player has exactly
 * one legal length left. It is worth a named test because the failure it
 * forecloses is silent in both directions — an allotment that miscounted would
 * either hand Team K a second 4-year deal it does not have, or refuse the
 * 1-year deal that PRD §3 makes unlimited and strand a Manager with a Player
 * they cannot finish.
 *
 * **The exhaustion is a COUNT over the folded contracts, not a ledger.** There
 * is no `contract_length` column and no spent-deals table: Team K's four spent
 * deals are four `ContractLengthAssigned` events, folded onto the four
 * contracts an `AuctionClosed` already produced, and the remainder is
 * `YEAR_ALLOTMENT` minus what those contracts currently carry. Which is why the
 * last assertion here matters as much as the first: re-assigning Player One
 * from the 4-year to a 1-year hands the 4-year straight back, with no
 * compensating event anywhere in the log.
 *
 * Calls the core directly against a folded log — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { YEAR_ALLOTMENT } from '../../src/lib/core/constants.ts';
import {
	INITIAL_ASSIGNMENTS,
	assignmentsReducer
} from '../../src/lib/core/projection/assignments.ts';
import {
	CONTRACT_LENGTH_ASSIGNED_EVENT,
	INITIAL_CONTRACTS,
	contractsReducer
} from '../../src/lib/core/projection/contracts.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import {
	assignmentBoardFor,
	contractAssignmentRefusalDetail,
	offerableLengths,
	refuseAssignment,
	refuseSubmission,
	remainingAllotment
} from '../../src/lib/core/rules/contract-assignment.ts';
import type {
	AssignmentActor,
	ContractAssignmentState
} from '../../src/lib/core/rules/contract-assignment.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';

/** Team K, and the Manager acting for it. */
const TEAM_K = 't-k';
const ACTOR: AssignmentActor = { managerId: 'm-k', teamId: TEAM_K, teamName: 'Team K' };

/** The five Players Team K won, in the order their Auctions closed. */
const WINS: ReadonlyArray<readonly [id: string, name: string, closedAt: string]> = [
	['p-1', 'Player One', '2026-08-27T09:00:00.000Z'],
	['p-2', 'Player Two', '2026-08-27T10:00:00.000Z'],
	['p-3', 'Player Three', '2026-08-27T11:00:00.000Z'],
	['p-4', 'Player Four', '2026-08-27T12:00:00.000Z'],
	['p-5', 'Player Five', '2026-08-27T13:00:00.000Z']
];

function event(seq: number, type: string, payload: unknown, occurredAt: string): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt,
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: 'm-k',
		teamId: TEAM_K,
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

function close(seq: number, id: string, name: string, closedAt: string): AppendedEvent {
	return event(
		seq,
		AUCTION_CLOSED_EVENT,
		{
			fantraxPlayerId: id,
			playerName: name,
			teamId: TEAM_K,
			teamName: 'Team K',
			managerId: 'm-k',
			winningAmount: 2_000_000,
			capHit: 2_000_000,
			placement: 'active_bench',
			contention: 'standard',
			// UNSET at the close, exactly as FR-21 and `rules/close.ts` record it.
			contractYears: null,
			closedAt
		},
		closedAt
	);
}

function assign(seq: number, id: string, name: string, years: 1 | 2 | 3 | 4): AppendedEvent {
	return event(
		seq,
		CONTRACT_LENGTH_ASSIGNED_EVENT,
		{
			fantraxPlayerId: id,
			playerName: name,
			teamId: TEAM_K,
			teamName: 'Team K',
			managerId: 'm-k',
			contractYears: years
		},
		'2026-09-01T09:00:00.000Z'
	);
}

/**
 * The example's log: five closes, then the four counted deals spent — the
 * 4-year, the 3-year and BOTH 2-year deals.
 */
const LOG: readonly AppendedEvent[] = [
	...WINS.map(([id, name, closedAt], index) => close(index + 1, id, name, closedAt)),
	assign(6, 'p-1', 'Player One', 4),
	assign(7, 'p-2', 'Player Two', 3),
	assign(8, 'p-3', 'Player Three', 2),
	assign(9, 'p-4', 'Player Four', 2)
];

function stateOf(events: readonly AppendedEvent[]): ContractAssignmentState {
	return {
		contracts: fold(INITIAL_CONTRACTS, events, contractsReducer),
		submitted: fold(INITIAL_ASSIGNMENTS, events, assignmentsReducer)
	};
}

describe('§10 example 14 — allotment exhaustion', () => {
	it('leaves Team K with nothing but 1-year deals after spending all four', () => {
		const state = stateOf(LOG);

		// The budget itself, so the example is read against the constant rather
		// than against four numbers copied out of it.
		expect(YEAR_ALLOTMENT).toEqual({ fourYear: 1, threeYear: 1, twoYear: 2 });

		expect(remainingAllotment(state.contracts, TEAM_K, null)).toEqual({
			fourYear: 0,
			threeYear: 0,
			twoYear: 0
		});
	});

	it('offers Player Five the 1-year deal and nothing longer', () => {
		const state = stateOf(LOG);
		const remaining = remainingAllotment(state.contracts, TEAM_K, 'p-5');

		expect(offerableLengths(remaining)).toEqual([1]);
		expect(assignmentBoardFor(state, ACTOR).rows.find((row) => row.fantraxPlayerId === 'p-5')
			?.offerable).toEqual([1]);
	});

	it('refuses every longer choice for Player Five, naming what remains', () => {
		const state = stateOf(LOG);

		for (const years of [2, 3, 4] as const) {
			const refusal = refuseAssignment(state, ACTOR, {
				fantraxPlayerId: 'p-5',
				contractYears: years
			});
			expect(refusal, `a ${String(years)}-year deal was not refused`).not.toBeNull();
			expect(refusal?.kind).toBe('exhausted');

			const detail = contractAssignmentRefusalDetail(refusal!);
			// The refusal names the exhausted length and the Player...
			// Every length in this loop is plural; the singular is `1 year`, and
			// that one is never refused.
			expect(detail).toContain(`${String(years)} years`);
			expect(detail).toContain('Player Five');
			// ...and states what is left, which is the one thing that tells the
			// Manager how to finish.
			expect(detail).toContain('One-year deals are unlimited');
		}
	});

	it('accepts the 1-year deal, which is the only way this Team finishes', () => {
		const state = stateOf(LOG);
		expect(refuseAssignment(state, ACTOR, { fantraxPlayerId: 'p-5', contractYears: 1 })).toBeNull();

		// And with it assigned, Team K is complete and may go final.
		const finished = stateOf([...LOG, assign(10, 'p-5', 'Player Five', 1)]);
		expect(refuseSubmission(finished, ACTOR)).toBeNull();
		expect(assignmentBoardFor(finished, ACTOR).unsetCount).toBe(0);
		// The 1-year deal spent NOTHING: the remainder is unmoved, because
		// one-year deals are uncounted rather than merely plentiful.
		expect(remainingAllotment(finished.contracts, TEAM_K, null)).toEqual({
			fourYear: 0,
			threeYear: 0,
			twoYear: 0
		});
	});

	it('hands the 4-year back the moment Player One is re-assigned', () => {
		// The claim the "count, not a ledger" design rests on: no compensating
		// event, no stored column — a later assignment for the same Player is
		// simply the one the fold reports.
		const corrected = stateOf([...LOG, assign(10, 'p-1', 'Player One', 1)]);

		expect(remainingAllotment(corrected.contracts, TEAM_K, null)).toEqual({
			fourYear: 1,
			threeYear: 0,
			twoYear: 0
		});
		expect(
			refuseAssignment(corrected, ACTOR, { fantraxPlayerId: 'p-5', contractYears: 4 })
		).toBeNull();
	});

	it('refuses Team K going final while Player Five has no length', () => {
		const refusal = refuseSubmission(stateOf(LOG), ACTOR);
		expect(refusal).toEqual({ kind: 'unset_on_submit', unsetCount: 1 });
		expect(contractAssignmentRefusalDetail(refusal!)).toContain(
			'1 of the Players it won still has no contract length'
		);
	});
});
