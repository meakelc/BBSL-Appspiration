/**
 * The log §10 example 58 and every Close-reversal test is built on
 * (Story 7.13, FR-32, AD-33).
 *
 * Team R holds eleven Active/Bench Contracts and one Contract on Injury
 * Reserve. It nominates Player X (spending its Slot), leads Player Y over
 * Team S, then wins X at $4,000,000 into Active/Bench — Roster Count 12. That
 * close releases R's Nomination Slot and cancels R's lead on Y under FR-40,
 * restoring Team S there.
 *
 * Built from the same payload shapes the producers write, so every fold in
 * the core reads it exactly as it reads a real log. `stateFor` assembles a
 * `CloseReversalState` the way `server/close-reversal.ts`'s loader does:
 * every fold over one events array, and Team R's rows as the Team page reads
 * them (imported rows plus the Contracts the fold says it won).
 */

import { parseMoney } from '../../src/lib/core/money.ts';
import { BID_CANCELLED_EVENT, BID_PLACED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import { INITIAL_AUCTIONS, auctionsReducer } from '../../src/lib/core/projection/auctions.ts';
import {
	AUCTION_CLOSE_REVERSED_EVENT,
	INITIAL_CONTRACTS,
	ROSTER_REARRANGED_EVENT,
	contractsReducer,
	contractsWonBy
} from '../../src/lib/core/projection/contracts.ts';
import type { AuctionContracts } from '../../src/lib/core/projection/contracts.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	AUCTION_CLOSED_EVENT,
	INITIAL_NOMINATIONS,
	NOMINATION_PLACED_EVENT,
	nominationForPlayer,
	nominationsReducer
} from '../../src/lib/core/projection/nominations.ts';
import {
	AUCTION_OPENED_EVENT,
	CONTRACT_ASSIGNMENT_OPENED_EVENT,
	INITIAL_PHASE,
	phaseReducer
} from '../../src/lib/core/projection/phase.ts';
import { closeReversalFactsFor } from '../../src/lib/core/rules/close-reversal.ts';
import type { CloseReversalState } from '../../src/lib/core/rules/close-reversal.ts';
import type { ActingRow } from '../../src/lib/core/rules/roster-act.ts';
import type { AppendedEvent, RosterSlotKind } from '../../src/lib/core/types.ts';

export const TEAM_R = 't-r';
export const TEAM_S = 't-s';
export const TEAM_T = 't-t';
export const PLAYER_X = 'p-x';
export const PLAYER_Y = 'p-y';
export const PLAYER_Z = 'p-z';
export const IR_PLAYER = 'p-ir';
export const WINNING_AMOUNT = 4_000_000;

/** The close's own `seq` in `baseLog()`. */
export const CLOSE_SEQ = '7';

const NAMES: Readonly<Record<string, string>> = {
	[TEAM_R]: 'Team R',
	[TEAM_S]: 'Team S',
	[TEAM_T]: 'Team T'
};

/** One `auction_events` row, as `toAppendedEvent` shapes it. */
export function ev(
	seq: number,
	type: string,
	payload: unknown,
	occurredAt = `2026-09-0${String(Math.min(9, 1 + Math.floor(seq / 10)))}T${String(10 + (seq % 10)).padStart(2, '0')}:00:00.000Z`,
	actor: { managerId: string | null; teamId: string | null } = { managerId: 'm-c', teamId: TEAM_T }
): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt,
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: actor.managerId,
		teamId: actor.teamId,
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

export function nominated(seq: number, playerId: string, playerName: string, teamId: string): AppendedEvent {
	return ev(seq, NOMINATION_PLACED_EVENT, {
		fantraxPlayerId: playerId,
		playerName,
		teamId,
		teamName: NAMES[teamId],
		managerId: `m-${teamId}`,
		holdsSlot: true
	});
}

export function bid(seq: number, playerId: string, teamId: string, amount: number): AppendedEvent {
	return ev(seq, BID_PLACED_EVENT, {
		fantraxPlayerId: playerId,
		teamId,
		teamName: NAMES[teamId],
		managerId: `m-${teamId}`,
		amount,
		closesAt: '2026-09-05T00:00:00.000Z'
	});
}

export function closed(
	seq: number,
	playerId: string,
	playerName: string,
	teamId: string,
	amount: number,
	releasedNominationSlot: boolean
): AppendedEvent {
	return ev(seq, AUCTION_CLOSED_EVENT, {
		fantraxPlayerId: playerId,
		playerName,
		teamId,
		teamName: NAMES[teamId],
		managerId: `m-${teamId}`,
		winningAmount: amount,
		capHit: amount,
		placement: 'active_bench',
		contention: 'standard',
		contractYears: null,
		closedAt: '2026-09-04T00:00:00.000Z',
		releasedNominationSlot
	});
}

/**
 * The log up to and including the close and its cancellation.
 *
 *   1 AuctionOpened
 *   2 R nominates X (spends R's Slot)
 *   3 S nominates Y
 *   4 R bids $4.0M on X
 *   5 S bids $2.0M on Y
 *   6 R bids $3.0M on Y — R leads Y
 *   7 X closes to R at $4.0M — releases R's Slot
 *   8 BidCancelled: R's lead on Y, caused by X's close, S restored
 */
export function baseLog(): AppendedEvent[] {
	return [
		ev(1, AUCTION_OPENED_EVENT, { teams: [] }, '2026-09-01T00:00:00.000Z'),
		nominated(2, PLAYER_X, 'Player X', TEAM_R),
		nominated(3, PLAYER_Y, 'Player Y', TEAM_S),
		bid(4, PLAYER_X, TEAM_R, WINNING_AMOUNT),
		bid(5, PLAYER_Y, TEAM_S, 2_000_000),
		bid(6, PLAYER_Y, TEAM_R, 3_000_000),
		closed(7, PLAYER_X, 'Player X', TEAM_R, WINNING_AMOUNT, true),
		ev(8, BID_CANCELLED_EVENT, {
			fantraxPlayerId: PLAYER_Y,
			playerName: 'Player Y',
			cancelledSeq: '6',
			teamId: TEAM_R,
			teamName: 'Team R',
			managerId: `m-${TEAM_R}`,
			amount: 3_000_000,
			wasContentionEntry: false,
			causeFantraxPlayerId: PLAYER_X,
			causePlayerName: 'Player X',
			causeTeamId: TEAM_R,
			restoration: {
				seq: '5',
				teamId: TEAM_S,
				teamName: 'Team S',
				managerId: `m-${TEAM_S}`,
				amount: 2_000_000
			}
		})
	];
}

/** Contract Assignment opens — the phase a reversal is still permitted in. */
export function contractAssignmentOpened(seq: number): AppendedEvent {
	return ev(seq, CONTRACT_ASSIGNMENT_OPENED_EVENT, { terminatedPlayerIds: [] }, undefined, {
		managerId: null,
		teamId: null
	});
}

/** A Roster Move of the won Contract within Team R (Story 7.11). */
export function movedWithinTeam(seq: number, to: RosterSlotKind): AppendedEvent {
	return ev(seq, ROSTER_REARRANGED_EVENT, {
		teamId: TEAM_R,
		teamName: 'Team R',
		moves: [
			{
				fantraxPlayerId: PLAYER_X,
				playerName: 'Player X',
				won: true,
				fromPlacement: 'active_bench',
				toPlacement: to,
				capHitBefore: WINNING_AMOUNT,
				capHitAfter: WINNING_AMOUNT,
				value: WINNING_AMOUNT
			}
		],
		teamBefore: {},
		teamAfter: {},
		reason: 'moved'
	});
}

/** Team R's imported rows: eleven Active/Bench at $5.0M and one IR at $3.0M. */
export function importedRowsR(): ActingRow[] {
	const rows: ActingRow[] = Array.from({ length: 11 }, (_unused, index) => ({
		fantraxPlayerId: `p-r-${String(index)}`,
		playerName: `Rostered ${String(index)}`,
		rosterSlotKind: 'active_bench' as const,
		value: parseMoney(5_000_000)
	}));
	rows.push({
		fantraxPlayerId: IR_PLAYER,
		playerName: 'Injured Star',
		rosterSlotKind: 'injury_reserve',
		value: parseMoney(3_000_000)
	});
	return rows;
}

/** A Team's rows as the Team page reads them: imported, plus what it has won. */
export function rowsFor(teamId: string, contracts: AuctionContracts): ActingRow[] {
	const imported = teamId === TEAM_R ? importedRowsR() : [];
	return [
		...imported,
		...contractsWonBy(contracts, teamId).map((contract) => ({
			fantraxPlayerId: contract.fantraxPlayerId,
			playerName: contract.playerName,
			rosterSlotKind: contract.placement,
			value: contract.capHit
		}))
	];
}

/** Every fold over one events array — `loadCloseReversalState`, in memory. */
export function stateFor(events: readonly AppendedEvent[], closeSeq = CLOSE_SEQ): CloseReversalState {
	const phase = fold(INITIAL_PHASE, events, phaseReducer);
	const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);
	const auctions = fold(INITIAL_AUCTIONS, events, auctionsReducer);
	const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);
	const facts = closeReversalFactsFor(events, closeSeq);
	const teamId = facts.close?.teamId ?? '';
	return {
		phase,
		facts,
		contracts,
		nominations,
		auctions,
		team: { teamId, teamName: facts.close?.teamName ?? '', rows: rowsFor(teamId, contracts) },
		playerNameFor: (id) => nominationForPlayer(nominations, id)?.playerName ?? id
	};
}

/** The appended reversal, as the shell would append it. */
export function reversalEvent(seq: number, payload: unknown): AppendedEvent {
	return ev(seq, AUCTION_CLOSE_REVERSED_EVENT, payload, undefined, {
		managerId: 'm-c',
		teamId: TEAM_T
	});
}
