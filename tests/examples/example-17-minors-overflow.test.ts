/**
 * PRD §10 example 17 — **Minors overflow** (AD-25, AD-11).
 *
 * > Same Team M immediately wins a second Minor League Eligible player at
 * > $3,000,000. All three Minor League Slots are now occupied, so he takes an
 * > Active/Bench Slot at a $3,000,000 Cap Hit and Roster Count increases by
 * > one.
 *
 * **"Same Team M" is the whole example, and it is why this file imports
 * example 16's produced state rather than restating its numbers.** That state
 * lives in `tests/fixtures/example-16-minors-placement.ts` — a plain module
 * with no `describe` of its own, because importing example 16's TEST file
 * here made vitest register its whole suite a second time inside this one. The state this close is
 * evaluated against is the state example 16's close PRODUCED — its
 * `AuctionClosed`, folded through `contractsReducer` into a Minor League row
 * that `contractRowsFor` hands the Cap arithmetic. That is AD-11 in one file:
 * "each close's effect on slot occupancy, Roster Count, Cap Hit and Minors
 * Exposure is committed to the state the *next* close is evaluated against.
 * Folding an overdue set against one loaded snapshot is a defect, not an
 * optimisation."
 *
 * If the two closes were evaluated against one snapshot, this Player would
 * take a Minor League Slot that example 16's Player is already in — four
 * eligible Players into three Slots, the exact failure AD-11 names. The
 * occupancy below is derived, never asserted as a literal three, so that
 * failure would surface here as a wrong placement rather than as a number
 * somebody forgot to update.
 *
 * **Nothing sweeps and nothing recomputes.** There is no second counter and no
 * `+ wonCount`: a won Player is one more `CapHitRow`, and Roster Count rises
 * by one because the row's kind is `active_bench`. State literals, direct core
 * calls, no database and no clock mocked.
 */

import { describe, expect, it } from 'vitest';

import { MINOR_LEAGUE_SLOTS, SALARY_CAP } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	contractForPlayer,
	contractRowsFor,
	contractsReducer
} from '../../src/lib/core/projection/contracts.ts';
import { decideClose, slotPlacementFor } from '../../src/lib/core/rules/close.ts';
import type { AuctionClosedPayload, CloseState } from '../../src/lib/core/rules/close.ts';
import { computeCapSpace } from '../../src/lib/core/rules/roster-import.ts';
import type { CapHitRow } from '../../src/lib/core/rules/roster-import.ts';
import {
	CONTRACTS_AFTER_16,
	TEAM_M_IMPORTED,
	appendedClose,
	auctionWonAt,
	minorLeagueOccupiedIn,
	nominationOf,
	rosterCountOf
} from '../fixtures/example-16-minors-placement.ts';

const CLOSES_AT = '2026-08-27T09:00:00.000Z';

/**
 * Team M's rows AFTER example 16's close: the imported roster plus the
 * contract that close produced. Nothing about `team_rosters` changed — the
 * stashed Player is a fold, and this is the concatenation
 * `server/team-roster.ts` performs before its one loop.
 */
const ROWS_AFTER_16: readonly CapHitRow[] = [
	...TEAM_M_IMPORTED,
	...contractRowsFor(CONTRACTS_AFTER_16, 't-m')
];

/** The second close, evaluated against what the first one did. */
const STATE: CloseState = {
	auction: auctionWonAt('p-second', 3_000_000),
	nomination: nominationOf('p-second', 'Malik Rowe'),
	// "a second Minor League Eligible player"
	playerIsMinorLeagueEligible: true,
	// DERIVED from example 16's committed effect, never written as a literal.
	minorLeagueOccupied: minorLeagueOccupiedIn(ROWS_AFTER_16),
	// **Story 10.3's cascade inputs.** `auctions` is empty here, so the
	// winning Team holds no other commitment and FR-40's cascade has nothing
	// to cancel whichever way the figures beside it go — this example is
	// about Slot Placement and sequencing, and nothing else.
	auctions: { byPlayer: {} },
	capSpace: parseMoney(0),
	rosterCount: 0,
	isMinorLeagueEligible: () => false,
	playerNameFor: (playerId: string) => playerId,
	// A Standard Contention: no lottery, no draw, no winner to derive.
	drawnWinner: null,
	rosterFiguresFor: () => null
};

const DECIDED = decideClose(STATE, CLOSES_AT, null);
const CLOSE = DECIDED.events[0];
if (CLOSE === undefined) throw new Error('example 17: the close appended no event');
const PAYLOAD = CLOSE.payload as AuctionClosedPayload;

const CONTRACTS_AFTER_17 = fold(CONTRACTS_AFTER_16, [appendedClose(4, CLOSE)], contractsReducer);
const ROWS_AFTER_17: readonly CapHitRow[] = [
	...TEAM_M_IMPORTED,
	...contractRowsFor(CONTRACTS_AFTER_17, 't-m')
];

describe('§10 example 17 — minors overflow', () => {
	it('sees all three Minor League Slots occupied, because example 16 committed one', () => {
		// Two imported plus one WON. `team_rosters` still holds two rows; the
		// third is the fold's.
		expect(minorLeagueOccupiedIn(TEAM_M_IMPORTED)).toBe(2);
		expect(contractRowsFor(CONTRACTS_AFTER_16, 't-m')).toEqual([
			{ capHit: 0, rosterSlotKind: 'minor_league' }
		]);
		expect(minorLeagueOccupiedIn(ROWS_AFTER_16)).toBe(MINOR_LEAGUE_SLOTS);
		expect(MINOR_LEAGUE_SLOTS - minorLeagueOccupiedIn(ROWS_AFTER_16)).toBe(0);
	});

	it('takes an Active/Bench Slot — an eligible Player with nowhere in the minors to go', () => {
		expect(PAYLOAD.placement).toBe('active_bench');
		// Eligibility passes; occupancy is what refuses the Slot.
		expect(slotPlacementFor(true, MINOR_LEAGUE_SLOTS)).toBe('active_bench');
		// ...and against example 16's own state it would NOT have. The
		// difference between the two answers IS the first close's effect.
		expect(slotPlacementFor(true, minorLeagueOccupiedIn(TEAM_M_IMPORTED))).toBe('minor_league');
	});

	it('charges the full $3,000,000 as the Cap Hit (AD-23)', () => {
		expect(PAYLOAD.winningAmount).toBe(3_000_000);
		// An Active/Bench placement charges the winning amount. Contrast
		// example 16, where the identical field is $0 beside a larger amount.
		expect(PAYLOAD.capHit).toBe(3_000_000);
	});

	it('increases Roster Count by one', () => {
		expect(rosterCountOf(ROWS_AFTER_16)).toBe(9);
		expect(rosterCountOf(ROWS_AFTER_17)).toBe(10);
		// Roster Count moved because the placement did, not because anything
		// counted a win: the contract row's kind is the whole mechanism.
		expect(contractRowsFor(CONTRACTS_AFTER_17, 't-m')).toContainEqual({
			capHit: 3_000_000,
			rosterSlotKind: 'active_bench'
		});
	});

	it('charges the Cap for THIS win and still nothing for the stash', () => {
		expect(computeCapSpace(ROWS_AFTER_16).capSpace).toBe(SALARY_CAP - 9_000_000);
		expect(computeCapSpace(ROWS_AFTER_17).capSpace).toBe(SALARY_CAP - 12_000_000);
	});

	it('leaves Team M holding two Auction Contracts, one of each placement', () => {
		expect(contractForPlayer(CONTRACTS_AFTER_17, 'p-stash')).toMatchObject({
			winningAmount: 4_000_000,
			capHit: 0,
			placement: 'minor_league'
		});
		expect(contractForPlayer(CONTRACTS_AFTER_17, 'p-second')).toMatchObject({
			winningAmount: 3_000_000,
			capHit: 3_000_000,
			placement: 'active_bench'
		});
	});

	it('converges on a replay of both closes', () => {
		// Two closes folded twice are still two contracts: first close wins,
		// so the second fold changes nothing (AD-5).
		const log = [appendedClose(3, CLOSE), appendedClose(4, CLOSE)];
		expect(fold(CONTRACTS_AFTER_17, log, contractsReducer)).toEqual(CONTRACTS_AFTER_17);
	});
});
