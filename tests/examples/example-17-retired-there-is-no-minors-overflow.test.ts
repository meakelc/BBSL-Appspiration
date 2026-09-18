/**
 * PRD §10 example 17 — **RETIRED on 2026-09-18**, and this file is the record
 * of that plus the regression that keeps it retired.
 *
 * Example 17 existed to state what happened when a Team's minors filled up:
 *
 * > Same Team M immediately wins a second Minor League Eligible player at
 * > $3,000,000. All three Minor League Slots are now occupied, so he takes an
 * > Active/Bench Slot at a $3,000,000 Cap Hit and Roster Count increases by
 * > one.
 *
 * **There is no overflow any more, because there is no stashing at a close.**
 * A Team cannot win a Free Agent straight into its minors: it must fit him on
 * its active roster first and move him down afterwards under FR-44. So the
 * second win reaches the same destination the example predicted — an
 * Active/Bench Slot at the full Cap Hit — but by the ordinary rule rather
 * than by exhausting three Minor League Slots. The example's ANSWER survived
 * its REASON, which is exactly why it had to be retired rather than kept:
 * a file that still passed for the wrong reason would be worse than one that
 * failed.
 *
 * The first close now leaves the minors untouched (see example 16's own
 * retirement), so Team M reaches this close with **one** Minor League Slot
 * still free and takes an Active/Bench Slot anyway. That is the assertion
 * below which the old rule could not have made, and it is what keeps this
 * retirement pinned.
 *
 * **AD-11 survives untouched and is still worth this file.** Each close's
 * effect must be committed to the state the next close is evaluated against,
 * and folding an overdue set against one loaded snapshot is still a defect.
 * What changed is which figure demonstrates it: Roster Count now carries the
 * sequencing (9 → 10 → 11) where Minor League occupancy used to, and the
 * count below is derived from the first close's committed effect rather than
 * written as a literal, so a snapshot bug still surfaces here as a wrong
 * figure rather than as a number somebody forgot to update.
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
	winnerHoldsNominationSlot: false,
	// DERIVED from example 16's committed effect, never written as a literal.
	minorLeagueOccupied: minorLeagueOccupiedIn(ROWS_AFTER_16),
	// **Story 10.3's cascade inputs.** `auctions` is empty here, so the
	// winning Team holds no other commitment and FR-40's cascade has nothing
	// to cancel whichever way the figures beside it go — this example is
	// about Slot Placement and sequencing, and nothing else.
	auctions: { byPlayer: {} },
	capSpace: parseMoney(0),
	rosterCount: 0,
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

describe('§10 example 17 — RETIRED: there is no minors overflow', () => {
	it('reaches this close with a Minor League Slot still FREE', () => {
		// Two imported, and the first close added none: it placed its winner
		// in Active/Bench. `team_rosters` holds two rows and the fold adds no
		// third.
		expect(minorLeagueOccupiedIn(TEAM_M_IMPORTED)).toBe(2);
		expect(contractRowsFor(CONTRACTS_AFTER_16, 't-m')).toEqual([
			{ capHit: 4_000_000, rosterSlotKind: 'active_bench' }
		]);
		expect(minorLeagueOccupiedIn(ROWS_AFTER_16)).toBe(2);
		// The free Slot the old example had exhausted. It is still here, and
		// the win below takes Active/Bench anyway.
		expect(MINOR_LEAGUE_SLOTS - minorLeagueOccupiedIn(ROWS_AFTER_16)).toBe(1);
	});

	it('takes an Active/Bench Slot even though the minors have room', () => {
		expect(PAYLOAD.placement).toBe('active_bench');
		// The assertion the old rule could not have made: a free Minor League
		// Slot sits unused, because a win never lands in one.
		expect(slotPlacementFor(true, minorLeagueOccupiedIn(ROWS_AFTER_16))).toBe('minor_league');
		expect(PAYLOAD.placement).not.toBe(
			slotPlacementFor(true, minorLeagueOccupiedIn(ROWS_AFTER_16))
		);
	});

	it('charges the full $3,000,000 as the Cap Hit (AD-23)', () => {
		expect(PAYLOAD.winningAmount).toBe(3_000_000);
		// An Active/Bench placement charges the winning amount — and every
		// placement is Active/Bench now, so example 16 charges its own
		// $4,000,000 in the same way rather than contrasting at $0.
		expect(PAYLOAD.capHit).toBe(3_000_000);
	});

	it("increases Roster Count by one, on top of the first close's own", () => {
		// 9 imported, 10 after the first close, 11 after this one. THIS is
		// the figure carrying AD-11's sequencing now.
		expect(rosterCountOf(ROWS_AFTER_16)).toBe(10);
		expect(rosterCountOf(ROWS_AFTER_17)).toBe(11);
		// Roster Count moved because the placement did, not because anything
		// counted a win: the contract row's kind is the whole mechanism.
		expect(contractRowsFor(CONTRACTS_AFTER_17, 't-m')).toContainEqual({
			capHit: 3_000_000,
			rosterSlotKind: 'active_bench'
		});
	});

	it('charges the Cap for BOTH wins — there is no free arrival', () => {
		// $9,000,000 imported, plus the first close's $4,000,000...
		expect(computeCapSpace(ROWS_AFTER_16).capSpace).toBe(SALARY_CAP - 13_000_000);
		// ...plus this close's $3,000,000. The old example charged $12,000,000
		// in total because one of the two wins arrived free.
		expect(computeCapSpace(ROWS_AFTER_17).capSpace).toBe(SALARY_CAP - 16_000_000);
	});

	it('leaves Team M holding two Auction Contracts, BOTH in Active/Bench', () => {
		expect(contractForPlayer(CONTRACTS_AFTER_17, 'p-stash')).toMatchObject({
			winningAmount: 4_000_000,
			capHit: 4_000_000,
			placement: 'active_bench'
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
