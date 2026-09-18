/**
 * PRD §10 example 16 — **RETIRED on 2026-09-18**, and this file is the record
 * of that plus the regression that keeps it retired.
 *
 * Example 16 existed to state Slot Placement at a close:
 *
 * > Team M holds two players in Minor League Slots and wins a Minor League
 * > Eligible player at $4,000,000. He takes the third Minor League Slot. Cap
 * > Hit is $0, and Team M's Roster Count is unchanged — it still owes the same
 * > number of Active/Bench holes.
 *
 * **A Team cannot win a Free Agent straight into its minors.** It has to be
 * able to fit him on its active roster first, and only then may it move him
 * down under FR-44 — which is what reopens the Active/Bench Slot. The old rule
 * let a Team acquire a Player it had no room for and charged its Cap nothing
 * for the arrival.
 *
 * So the same close now lands the Player in an **Active/Bench Slot** at a Cap
 * Hit of the full **$4,000,000**, Team M's Roster Count goes 9 → 10, and its
 * Minor League occupancy stays at two. Every figure the example asserted is
 * inverted below, which is what makes this file fail if the old placement is
 * ever reintroduced.
 *
 * **What has NOT changed is `slotPlacementFor`.** The function is still
 * correct and still reachable — a Roster Trade re-evaluates placement against
 * the receiving Team's occupancy (FR-41), because a Contract arriving by trade
 * is already settled rather than being won into a roster. It is asserted below
 * still answering `minor_league`, beside a close that no longer consults it:
 * the two facts together are the whole of what this retirement changed.
 *
 * **AD-23 survives and is still the point.** Winning amount and Cap Hit remain
 * two persisted fields rather than one figure read twice. They simply agree on
 * this close now, which is why the inequality the example used to assert is
 * the one line that could not be kept.
 *
 * Example 17 continues directly from the state this one produces. Both files
 * read that state from `tests/fixtures/example-16-minors-placement.ts`, which
 * holds no `describe` of its own — importing one test file from another made
 * vitest register this suite twice.
 */

import { describe, expect, it } from 'vitest';

import { MINOR_LEAGUE_SLOTS, SALARY_CAP } from '../../src/lib/core/constants.ts';
import { contractForPlayer, contractRowsFor } from '../../src/lib/core/projection/contracts.ts';
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

describe('§10 example 16 — RETIRED: the win that cannot land in minors', () => {
	it('starts from two occupied Minor League Slots and one free', () => {
		expect(minorLeagueOccupiedIn(TEAM_M_IMPORTED)).toBe(2);
		expect(MINOR_LEAGUE_SLOTS - minorLeagueOccupiedIn(TEAM_M_IMPORTED)).toBe(1);
	});

	it('takes an Active/Bench Slot, leaving the free Minor League Slot alone', () => {
		// The free third Slot above is NOT taken. A win lands in Active/Bench
		// whatever the Player's eligibility and whatever the minors look like.
		expect(PAYLOAD_16.placement).toBe('active_bench');
	});

	it('still answers `minor_league` from `slotPlacementFor` — the TRADE path', () => {
		// The rule the close used to consult is unchanged, and still correct
		// for the one act that still uses it: a Contract arriving by Roster
		// Trade is re-placed against the receiving Team's occupancy (FR-41).
		expect(slotPlacementFor(true, 2)).toBe('minor_league');
		// ...and the close reached a different answer from the same two facts,
		// which is the whole of the retirement in one comparison.
		expect(PAYLOAD_16.placement).not.toBe(slotPlacementFor(true, 2));
	});

	it('charges the FULL $4,000,000 against the Cap (AD-23)', () => {
		expect(PAYLOAD_16.winningAmount).toBe(4_000_000);
		expect(PAYLOAD_16.capHit).toBe(4_000_000);
	});

	it('records contract length unset (FR-21)', () => {
		expect(PAYLOAD_16.contractYears).toBeNull();
	});

	it('RAISES Roster Count from nine to ten — the win owes an Active/Bench hole', () => {
		const after = [...TEAM_M_IMPORTED, ...contractRowsFor(CONTRACTS_AFTER_16, 't-m')];

		expect(rosterCountOf(TEAM_M_IMPORTED)).toBe(9);
		// The arrival is one of the twelve now, which is exactly the room a
		// Team must have before it may win him at all.
		expect(rosterCountOf(after)).toBe(10);
	});

	it('leaves Minor League occupancy at two — nothing was stashed', () => {
		const after = [...TEAM_M_IMPORTED, ...contractRowsFor(CONTRACTS_AFTER_16, 't-m')];

		expect(minorLeagueOccupiedIn(after)).toBe(2);
		// The third Slot is still free, and stays free until a Manager moves
		// somebody into it under FR-44.
		expect(MINOR_LEAGUE_SLOTS - minorLeagueOccupiedIn(after)).toBe(1);
	});

	it('charges the Cap the full winning amount', () => {
		const before = computeCapSpace(TEAM_M_IMPORTED).capSpace;
		const after = computeCapSpace([
			...TEAM_M_IMPORTED,
			...contractRowsFor(CONTRACTS_AFTER_16, 't-m')
		]).capSpace;

		// $9,000,000 of Active/Bench contracts; the two imported minors rows
		// still charge nothing, and the win now charges all $4,000,000.
		expect(before).toBe(SALARY_CAP - 9_000_000);
		expect(after).toBe(before - 4_000_000);
	});

	it('folds into an Auction Contract naming Team M', () => {
		expect(contractForPlayer(CONTRACTS_AFTER_16, 'p-stash')).toMatchObject({
			teamId: 't-m',
			teamName: 'Team M',
			winningAmount: 4_000_000,
			capHit: 4_000_000,
			placement: 'active_bench'
		});
		expect(CLOSE_16.type).toBe(AUCTION_CLOSED_EVENT);
	});
});
