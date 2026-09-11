/**
 * PRD §10 example 42 — **A won Player traded after the Auction Phase**
 * (FR-41).
 *
 * > Team J won Powell at $9,000,000 and assigned him a **3-year** length,
 * > spending its single 3-year allotment. During the Contract Assignment
 * > Phase it trades Powell to Team K. The assigned length is **cleared**
 * > (FR-41): Team J's 3-year returns to its Year Allotment, and Powell
 * > arrives on Team K unassigned. FR-30 blocks the export until every Auction
 * > Contract carries a length, so the export is blocked again — correctly,
 * > and it heals itself the moment Team K assigns. Team K has already spent
 * > its 4-year and 3-year, so it assigns a 1-year, which is always available
 * > because 1-year deals are unlimited. **A receiving Team can therefore
 * > never be trapped**, which is why FR-41 clears the length rather than
 * > refusing the Move.
 *
 * **The fold is the test.** An Auction Contract has no row anywhere — it is
 * `contractsReducer`'s output — so this file drives the reducer over a log
 * and reads what comes out: Powell's Team, his placement, his Cap Hit and his
 * `contractYears`. The Year Allotment needs no compensating event because it
 * is a COUNT over the current folded lengths, so clearing the field returns
 * the year by arithmetic.
 *
 * **Replay convergence is asserted outright**: the same log folded twice, and
 * folded event by event, converges on the identical contract.
 *
 * **The FR-30 export re-block is NOT asserted here.** Story 6.3 has not
 * shipped, so this file clears the length and returns the year, at that
 * altitude and no further — at the human's direction, recorded in the spec.
 *
 * Calls the core directly against a log literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { parseMoney } from '../../src/lib/core/money.ts';
import {
	CONTRACT_LENGTH_ASSIGNED_EVENT,
	INITIAL_CONTRACTS,
	ROSTER_MOVE_RECORDED_EVENT,
	contractForPlayer,
	contractsReducer,
	contractsWonBy
} from '../../src/lib/core/projection/contracts.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';

const CLOSED_AT = '2026-09-09T09:00:00.000Z';

let nextSeq = 0;

function event(type: string, payload: unknown): AppendedEvent {
	nextSeq += 1;
	return {
		seq: String(nextSeq),
		occurredAt: CLOSED_AT,
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: 'm-commissioner',
		teamId: 't-j',
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

/** Powell, won by Team J at $9,000,000 and placed in Active/Bench. */
const CLOSE = event(AUCTION_CLOSED_EVENT, {
	fantraxPlayerId: 'p-powell',
	playerName: 'Powell',
	teamId: 't-j',
	teamName: 'Team J',
	managerId: 'm-j',
	winningAmount: 9_000_000,
	capHit: 9_000_000,
	placement: 'active_bench',
	closedAt: CLOSED_AT
});

/** Team J's single 3-year allotment, spent on Powell. */
const ASSIGN = event(CONTRACT_LENGTH_ASSIGNED_EVENT, {
	fantraxPlayerId: 'p-powell',
	playerName: 'Powell',
	teamId: 't-j',
	teamName: 'Team J',
	managerId: 'm-j',
	contractYears: 3
});

/** The Move: Powell to Team K, who has an Active/Bench Slot for him. */
const MOVE = event(ROSTER_MOVE_RECORDED_EVENT, {
	sendingTeamId: 't-j',
	sendingTeamName: 'Team J',
	receivingTeamId: 't-k',
	receivingTeamName: 'Team K',
	transfers: [
		{
			fantraxPlayerId: 'p-powell',
			playerName: 'Powell',
			fromTeamId: 't-j',
			fromTeamName: 'Team J',
			toTeamId: 't-k',
			toTeamName: 'Team K',
			won: true,
			fromPlacement: 'active_bench',
			toPlacement: 'active_bench',
			capHitBefore: 9_000_000,
			capHitAfter: 9_000_000,
			winningAmount: 9_000_000,
			clearedContractYears: 3
		}
	],
	sendingBefore: {
		teamId: 't-j',
		teamName: 'Team J',
		capSpace: 50_000_000,
		rosterCount: 1,
		injuryReserveOccupied: 0,
		minorLeagueOccupied: 0
	},
	sendingAfter: {
		teamId: 't-j',
		teamName: 'Team J',
		capSpace: 59_000_000,
		rosterCount: 0,
		injuryReserveOccupied: 0,
		minorLeagueOccupied: 0
	},
	receivingBefore: {
		teamId: 't-k',
		teamName: 'Team K',
		capSpace: 40_000_000,
		rosterCount: 0,
		injuryReserveOccupied: 0,
		minorLeagueOccupied: 0
	},
	receivingAfter: {
		teamId: 't-k',
		teamName: 'Team K',
		capSpace: 31_000_000,
		rosterCount: 1,
		injuryReserveOccupied: 0,
		minorLeagueOccupied: 0
	},
	reason: 'J and K agreed the trade in the league channel.'
});

const LOG: readonly AppendedEvent[] = [CLOSE, ASSIGN, MOVE];

/** How many of a Team's folded lengths are 3-year deals. */
function threeYearsSpentBy(
	contracts: Parameters<typeof contractsWonBy>[0],
	teamId: string
): number {
	return contractsWonBy(contracts, teamId).filter(
		(contract) => contract.contractYears === 3
	).length;
}

describe('§10 example 42 — a won Player traded after the Auction Phase', () => {
	it('spends the 3-year allotment before the Move', () => {
		const before = fold(INITIAL_CONTRACTS, [CLOSE, ASSIGN], contractsReducer);
		const powell = contractForPlayer(before, 'p-powell');

		expect(powell?.teamId).toBe('t-j');
		expect(powell?.contractYears).toBe(3);
		expect(threeYearsSpentBy(before, 't-j')).toBe(1);
	});

	it('CLEARS the assigned length on the Move', () => {
		const after = fold(INITIAL_CONTRACTS, LOG, contractsReducer);
		const powell = contractForPlayer(after, 'p-powell');

		// `null` is the absence, exactly as a close records it — never a zero.
		expect(powell?.contractYears).toBeNull();
	});

	it("returns Team J's 3-year to its Year Allotment, with no compensating event", () => {
		const after = fold(INITIAL_CONTRACTS, LOG, contractsReducer);

		// The allotment is a COUNT over the current folded lengths, so clearing
		// the field IS the return. Nothing was appended to give the year back.
		expect(threeYearsSpentBy(after, 't-j')).toBe(0);
		expect(contractsWonBy(after, 't-j')).toEqual([]);
	});

	it('lands Powell on Team K, unassigned, at the same winning amount', () => {
		const after = fold(INITIAL_CONTRACTS, LOG, contractsReducer);
		const powell = contractForPlayer(after, 'p-powell');

		expect(powell?.teamId).toBe('t-k');
		expect(powell?.teamName).toBe('Team K');
		expect(powell?.placement).toBe('active_bench');
		expect(powell?.capHit).toBe(parseMoney(9_000_000));
		// A Move is not a restructure: the Contract travels unchanged in value.
		expect(powell?.winningAmount).toBe(parseMoney(9_000_000));
		expect(powell?.contractYears).toBeNull();
		expect(contractsWonBy(after, 't-k')).toHaveLength(1);
	});

	it('lets Team K assign a 1-year afterwards — a receiving Team is never trapped', () => {
		const assignOne = event(CONTRACT_LENGTH_ASSIGNED_EVENT, {
			fantraxPlayerId: 'p-powell',
			playerName: 'Powell',
			teamId: 't-k',
			teamName: 'Team K',
			managerId: 'm-k',
			contractYears: 1
		});
		const after = fold(INITIAL_CONTRACTS, [...LOG, assignOne], contractsReducer);

		// The length lands because the contract is Team K's now — the reducer's
		// ownership guard is what would have refused it a moment earlier.
		expect(contractForPlayer(after, 'p-powell')?.contractYears).toBe(1);
	});

	it('converges under replay — the same log folded twice is the same contract', () => {
		const once = fold(INITIAL_CONTRACTS, LOG, contractsReducer);
		const twice = fold(INITIAL_CONTRACTS, [...LOG, ...LOG], contractsReducer);

		// Latest-transfer-wins, so a repeated Move lands him on the same Team
		// rather than bouncing him back.
		expect(contractForPlayer(twice, 'p-powell')).toEqual(contractForPlayer(once, 'p-powell'));
	});

	it('folds an assignment the sending Team makes AFTER the Move onto nobody', () => {
		// The guard `contractsReducer` already holds: a length may only land on
		// a contract the naming Team holds, and Team J does not hold this one.
		const lateAssign = event(CONTRACT_LENGTH_ASSIGNED_EVENT, {
			fantraxPlayerId: 'p-powell',
			playerName: 'Powell',
			teamId: 't-j',
			teamName: 'Team J',
			managerId: 'm-j',
			contractYears: 4
		});
		const after = fold(INITIAL_CONTRACTS, [...LOG, lateAssign], contractsReducer);

		expect(contractForPlayer(after, 'p-powell')?.teamId).toBe('t-k');
		expect(contractForPlayer(after, 'p-powell')?.contractYears).toBeNull();
	});
});
