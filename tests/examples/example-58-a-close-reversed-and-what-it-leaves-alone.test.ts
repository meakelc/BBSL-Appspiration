/**
 * PRD §10 example 58 — **A Close reversed, and what it leaves alone**
 * (FR-32, AD-33, Story 7.13).
 *
 * > Team R holds 11 Active/Bench Contracts and one Contract in an Injury
 * > Reserve Slot the league rules say it may not hold during free agency.
 * > Team R wins Player X at $4,000,000 into Active/Bench, reaching Roster
 * > Count 12. That Close cancels Team R's leading Bid on Player Y under FR-40
 * > and restores Team S there. The Commissioner reverses the Close → Team R's
 * > Roster Count is **11**, its Cap Space is **$4,000,000 higher**, Player X is
 * > **nominatable** by any Team, Team S **still leads** Player Y, and the
 * > League Clock's expiry is **unchanged**. The Commissioner then Roster Moves
 * > the IR Contract to Active/Bench, and Team R is at **12** — the position it
 * > should have held all along. Done in the other order, the Move is refused:
 * > it would have made **13**.
 *
 * Driven through the real folds and the real pure decisions: the reversal is
 * `decideCloseReversal` over the log, APPENDED as the event it returns, and
 * every consequence is read back by re-folding — nothing asserted against a
 * state literal.
 */

import { describe, expect, it } from 'vitest';

import { INITIAL_AUCTIONS, auctionForPlayer, auctionsReducer } from '../../src/lib/core/projection/auctions.ts';
import {
	INITIAL_CONTRACTS,
	contractForPlayer,
	contractsReducer
} from '../../src/lib/core/projection/contracts.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	INITIAL_LEAGUE_CLOCK,
	leagueClockExpiry,
	leagueClockReducer
} from '../../src/lib/core/projection/league-clock.ts';
import { INITIAL_NOMINATIONS, nominationsReducer } from '../../src/lib/core/projection/nominations.ts';
import { decideCloseReversal } from '../../src/lib/core/rules/close-reversal.ts';
import { refuseNomination } from '../../src/lib/core/rules/nomination.ts';
import { evaluateRearrange } from '../../src/lib/core/rules/roster-rearrange.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';
import {
	IR_PLAYER,
	PLAYER_X,
	PLAYER_Y,
	TEAM_R,
	TEAM_S,
	WINNING_AMOUNT,
	baseLog,
	reversalEvent,
	rowsFor,
	stateFor
} from '../fixtures/close-reversal-log.ts';

/** The Move of the IR Contract to Active/Bench, judged over a given log. */
function irMoveOver(events: readonly AppendedEvent[]) {
	const state = stateFor(events);
	const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);
	return evaluateRearrange(
		{
			team: {
				teamId: TEAM_R,
				teamName: 'Team R',
				rows: rowsFor(TEAM_R, contracts).map((row) => ({
					...row,
					won: row.fantraxPlayerId === PLAYER_X
				}))
			},
			auctions: state.auctions,
			nominations: state.nominations,
			isMinorLeagueEligible: () => false,
			hasEverOccupiedMinorLeague: () => false,
			playerNameFor: state.playerNameFor
		},
		{
			kind: 'RearrangeRoster',
			teamId: TEAM_R,
			teamName: 'Team R',
			moves: [{ fantraxPlayerId: IR_PLAYER, toPlacement: 'active_bench' }],
			reason: 'The IR designation was against the free-agency rule.'
		}
	);
}

/** The log with the reversal appended exactly as `decideCloseReversal` decided it. */
function reversedLog(): AppendedEvent[] {
	const log = baseLog();
	const outcome = decideCloseReversal(stateFor(log), 'Won with an illegal IR designation.');
	if (outcome.kind !== 'accepted') throw new Error('refused');
	return [...log, reversalEvent(9, outcome.payload)];
}

describe('§10 example 58 — a Close reversed, and what it leaves alone', () => {
	it('starts Team R at Roster Count 12, with the IR Move refused at 13', () => {
		const outcome = decideCloseReversal(stateFor(baseLog()), 'reason');
		if (outcome.kind !== 'accepted') throw new Error('refused');
		expect(outcome.decision.teamBefore.rosterCount).toBe(12);
		expect(outcome.decision.teamBefore.injuryReserveOccupied).toBe(1);

		// Done in the other order, the Move is refused: it would have made 13.
		const move = irMoveOver(baseLog());
		expect(move.kind).toBe('refused');
		if (move.kind !== 'refused' || move.gates === null) throw new Error('expected a gate refusal');
		expect(move.gates.slots.passed).toBe(false);
		expect(move.gates.slots.rosterCount).toBe(13);
	});

	it('falls to Roster Count 11 with Cap Space $4,000,000 higher', () => {
		const outcome = decideCloseReversal(stateFor(baseLog()), 'reason');
		if (outcome.kind !== 'accepted') throw new Error('refused');
		const { teamBefore, teamAfter } = outcome.decision;
		expect(teamAfter.rosterCount).toBe(11);
		expect(teamAfter.capSpace - teamBefore.capSpace).toBe(WINNING_AMOUNT);
	});

	it('leaves Player X nominatable by any Team', () => {
		const events = reversedLog();
		const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);
		expect(contractForPlayer(contracts, PLAYER_X)).toBeNull();
		// The gate `server/nomination.ts` runs, over the refolded log: Team S —
		// or anybody — may nominate X. No `under_contract`, no board seat.
		const refusal = refuseNomination(
			{
				phase: 'Auction',
				nominations: fold(INITIAL_NOMINATIONS, events, nominationsReducer),
				poolPlayer: { fantraxPlayerId: PLAYER_X, playerName: 'Player X' },
				contractHolderTeamName: contractForPlayer(contracts, PLAYER_X)?.teamName ?? null
			},
			'team-anyone'
		);
		expect(refusal).toBeNull();
	});

	it('leaves Team S leading Player Y — the cancellation and its restoration stand', () => {
		const before = auctionForPlayer(fold(INITIAL_AUCTIONS, baseLog(), auctionsReducer), PLAYER_Y);
		const after = auctionForPlayer(fold(INITIAL_AUCTIONS, reversedLog(), auctionsReducer), PLAYER_Y);
		expect(before?.leadingBid?.teamId).toBe(TEAM_S);
		expect(after?.leadingBid?.teamId).toBe(TEAM_S);
		expect(after).toEqual(before);
	});

	it("leaves the League Clock's expiry unchanged", () => {
		const before = leagueClockExpiry(fold(INITIAL_LEAGUE_CLOCK, baseLog(), leagueClockReducer));
		const after = leagueClockExpiry(fold(INITIAL_LEAGUE_CLOCK, reversedLog(), leagueClockReducer));
		expect(before).not.toBeNull();
		expect(after).toBe(before);
	});

	it('then lets the IR Move land Team R at 12 — the position it should have held', () => {
		const move = irMoveOver(reversedLog());
		if (move.kind !== 'permitted') throw new Error('the Move after the reversal was refused');
		expect(move.delta.after.rosterCount).toBe(12);
		expect(move.delta.after.injuryReserveOccupied).toBe(0);
	});
});
