/**
 * PRD §10 example 16 — **Minors placement** (AD-25).
 *
 * > Team M holds two players in Minor League Slots and wins a Minor League
 * > Eligible player at $4,000,000. He takes the third Minor League Slot. Cap
 * > Hit is $0, and Team M's Roster Count is unchanged — it still owes the same
 * > number of Active/Bench holes.
 *
 * **The whole example is one call to `decideClose`.** Slot Placement is a pure
 * function of two facts — the Player's eligibility and the Team's Minor League
 * occupancy at this close — and involves no choice by anybody. There is no
 * database here, no clock mocked and no transaction: the state is a literal and
 * the close is the core answering it.
 *
 * **It is the AD-23 example.** The Player is won at $4,000,000 and charges $0
 * against the Cap, and both figures are persisted on the event. A code path
 * that derived either from the other by assuming equality would pass every
 * Active/Bench example there is and fail this one — which is precisely why
 * AD-23 exists and why both fields are asserted below rather than one.
 *
 * **"Roster Count is unchanged" is a property of the placement, not a second
 * rule.** Roster Count counts `active_bench` rows and nothing else
 * (`server/team-roster.ts`, PRD §3), so a `minor_league` contract row moves it
 * by construction — there is no `+ wonCount` anywhere to get wrong. The two
 * counters below are the same two `loadTeamRoster` runs over the same
 * `CapHitRow` array; `tests/server/team-roster.test.ts` is what pins the server
 * side of that, and this file states the arithmetic the example is about.
 *
 * Example 17 continues directly from the state this one produces. Both files
 * read that state from `tests/fixtures/example-16-minors-placement.ts`, which
 * holds no `describe` of its own — importing one test file from another made
 * vitest register this suite twice.
 */

import { describe, expect, it } from 'vitest';

import { MINOR_LEAGUE_SLOTS, SALARY_CAP } from '../../src/lib/core/constants.ts';
import {
	contractForPlayer,
	contractRowsFor
} from '../../src/lib/core/projection/contracts.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { slotPlacementFor } from '../../src/lib/core/rules/close.ts';
import { computeCapSpace } from '../../src/lib/core/rules/roster-import.ts';
import {
	CLOSE_16,
	CONTRACTS_AFTER_16,
	PAYLOAD_16,
	TEAM_M_IMPORTED,
	minorLeagueOccupiedIn,
	rosterCountOf
} from '../fixtures/example-16-minors-placement.ts';

describe('§10 example 16 — minors placement', () => {
	it('starts from two occupied Minor League Slots and one free', () => {
		expect(minorLeagueOccupiedIn(TEAM_M_IMPORTED)).toBe(2);
		expect(MINOR_LEAGUE_SLOTS - minorLeagueOccupiedIn(TEAM_M_IMPORTED)).toBe(1);
	});

	it('takes the third Minor League Slot', () => {
		expect(PAYLOAD_16.placement).toBe('minor_league');
		// The same answer asked directly of the rule, from the same two facts
		// and nothing else. Eligibility first, occupancy second.
		expect(slotPlacementFor(true, 2)).toBe('minor_league');
	});

	it('records a Cap Hit of $0 while the winning amount stands at $4,000,000 (AD-23)', () => {
		expect(PAYLOAD_16.winningAmount).toBe(4_000_000);
		expect(PAYLOAD_16.capHit).toBe(0);
		// Two persisted fields, not one figure read two ways.
		expect(PAYLOAD_16.capHit).not.toBe(PAYLOAD_16.winningAmount);
	});

	it('records contract length unset (FR-21)', () => {
		expect(PAYLOAD_16.contractYears).toBeNull();
	});

	it('leaves Roster Count unchanged — the same Active/Bench holes still owed', () => {
		const after = [...TEAM_M_IMPORTED, ...contractRowsFor(CONTRACTS_AFTER_16, 't-m')];

		expect(rosterCountOf(TEAM_M_IMPORTED)).toBe(9);
		// Nothing swept, nothing incremented: a `minor_league` row simply is
		// not one of the twelve.
		expect(rosterCountOf(after)).toBe(9);
	});

	it('moves Minor League occupancy from two to three', () => {
		const after = [...TEAM_M_IMPORTED, ...contractRowsFor(CONTRACTS_AFTER_16, 't-m')];

		expect(minorLeagueOccupiedIn(after)).toBe(3);
		// ...which is the fact example 17 runs against.
		expect(MINOR_LEAGUE_SLOTS - minorLeagueOccupiedIn(after)).toBe(0);
	});

	it('charges the Cap nothing for the win', () => {
		const before = computeCapSpace(TEAM_M_IMPORTED).capSpace;
		const after = computeCapSpace([
			...TEAM_M_IMPORTED,
			...contractRowsFor(CONTRACTS_AFTER_16, 't-m')
		]).capSpace;

		// $9,000,000 of Active/Bench contracts; the two imported minors rows
		// charge nothing and neither does the win.
		expect(before).toBe(SALARY_CAP - 9_000_000);
		expect(after).toBe(before);
	});

	it('folds into an Auction Contract naming Team M', () => {
		expect(contractForPlayer(CONTRACTS_AFTER_16, 'p-stash')).toMatchObject({
			teamId: 't-m',
			teamName: 'Team M',
			winningAmount: 4_000_000,
			capHit: 0,
			placement: 'minor_league'
		});
		expect(CLOSE_16.type).toBe(AUCTION_CLOSED_EVENT);
	});
});
