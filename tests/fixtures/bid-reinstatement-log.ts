/**
 * The log every Bid-reinstatement test is built on (Story 7.14) — the shape of
 * the production case that prompted it.
 *
 * DET leads Dalton Knecht at $2,000,000 (the prod `BidPlaced` was seq 5218,
 * closing 2026-09-25T15:15:01.801Z). DET then wins Cam Whitmore, and because
 * Jimmy Butler had not yet been moved to Injury Reserve that close cancels
 * DET's Knecht lead under FR-40 with nothing restored (prod seq 5479). NYK
 * then opens a $1,000,000 Minimum-Bid Contention on Knecht (prod seq 5534,
 * closing 2026-09-26T16:57Z) and BOS joins it.
 *
 * The real `seq`s are used, so the golden replay reads like the production
 * log it stands for. Built from the same payload shapes the producers write,
 * so every fold in the core reads it exactly as it reads a real log.
 */

import { parseMoney } from '../../src/lib/core/money.ts';
import {
	BID_CANCELLATION_REVERSED_EVENT,
	BID_CANCELLED_EVENT,
	BID_PLACED_EVENT,
	INITIAL_AUCTIONS,
	auctionsReducer
} from '../../src/lib/core/projection/auctions.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import { INITIAL_LEAGUE_CLOCK, leagueClockReducer } from '../../src/lib/core/projection/league-clock.ts';
import {
	AUCTION_CLOSED_EVENT,
	INITIAL_NOMINATIONS,
	nominationForPlayer,
	nominationsReducer
} from '../../src/lib/core/projection/nominations.ts';
import { INITIAL_PHASE, phaseReducer } from '../../src/lib/core/projection/phase.ts';
import { bidReinstatementFactsFor } from '../../src/lib/core/rules/bid-reinstatement.ts';
import type { BidReinstatementState } from '../../src/lib/core/rules/bid-reinstatement.ts';
import type { CandidateRosterFigures } from '../../src/lib/core/rules/restore.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';
import { ev, nominated } from './close-reversal-log.ts';

export const DET = 't-det';
export const NYK = 't-nyk';
export const BOS = 't-bos';
export const CHA = 't-cha';
export const KNECHT = 'p-knecht';
export const WHITMORE = 'p-whitmore';

/** The reinstated Bid, its cancellation, and the lottery opening that followed. */
export const DET_BID_SEQ = '5218';
export const CANCELLATION_SEQ = '5479';
export const NYK_BID_SEQ = '5534';
export const BOS_BID_SEQ = '5540';

/** DET's Knecht Bid's ORIGINAL Auction Clock. */
export const DET_CLOSES_AT = '2026-09-25T15:15:01.801Z';
/** The Minimum-Bid Contention NYK opened. */
export const LOTTERY_CLOSES_AT = '2026-09-26T16:57:00.000Z';

/** After DET's clock, before the lottery's. */
export const NOW_AFTER_CLOCK = '2026-09-25T18:00:00.000Z';
/** Before DET's clock. */
export const NOW_BEFORE_CLOCK = '2026-09-25T12:00:00.000Z';

const NAMES: Readonly<Record<string, string>> = {
	[DET]: 'Detroit',
	[NYK]: 'New York',
	[BOS]: 'Boston',
	[CHA]: 'Charlotte'
};

const SYSTEM = { managerId: null, teamId: null };

export function placed(
	seq: number,
	playerId: string,
	teamId: string,
	amount: number,
	occurredAt: string,
	closesAt: string,
	seedHash: string | null = null
): AppendedEvent {
	return ev(
		seq,
		BID_PLACED_EVENT,
		{
			fantraxPlayerId: playerId,
			teamId,
			teamName: NAMES[teamId],
			managerId: `m-${teamId}`,
			amount,
			closesAt,
			...(seedHash === null ? {} : { seedHash })
		},
		occurredAt,
		{ managerId: `m-${teamId}`, teamId }
	);
}

/** The FR-40 cancellation of DET's Knecht lead, caused by the Whitmore close. */
export function detCancelled(seq = Number(CANCELLATION_SEQ), wasContentionEntry = false): AppendedEvent {
	return ev(
		seq,
		BID_CANCELLED_EVENT,
		{
			fantraxPlayerId: KNECHT,
			playerName: 'Dalton Knecht',
			cancelledSeq: DET_BID_SEQ,
			teamId: DET,
			teamName: 'Detroit',
			managerId: `m-${DET}`,
			amount: 2_000_000,
			wasContentionEntry,
			causeFantraxPlayerId: WHITMORE,
			causePlayerName: 'Cam Whitmore',
			causeTeamId: DET,
			restoration: null
		},
		'2026-09-24T20:00:00.000Z',
		SYSTEM
	);
}

/**
 * The log up to the Commissioner's reinstatement.
 *
 *   1    AuctionOpened
 *   2    CHA nominates Knecht
 *   3    DET nominates Whitmore
 *   5200 DET bids $3.0M on Whitmore
 *   5218 DET bids $2.0M on Knecht — closes 2026-09-25T15:15:01.801Z
 *   5478 Whitmore closes to DET
 *   5479 BidCancelled: DET's Knecht lead, nothing restored
 *   5534 NYK opens a $1.0M Minimum-Bid Contention on Knecht
 *   5540 BOS joins it
 */
export function knechtLog(): AppendedEvent[] {
	return [
		ev(1, 'AuctionOpened', { teams: [] }, '2026-09-20T00:00:00.000Z', SYSTEM),
		{ ...nominated(2, KNECHT, 'Dalton Knecht', CHA), occurredAt: '2026-09-22T10:00:00.000Z' },
		{ ...nominated(3, WHITMORE, 'Cam Whitmore', DET), occurredAt: '2026-09-22T11:00:00.000Z' },
		placed(5200, WHITMORE, DET, 3_000_000, '2026-09-23T19:00:00.000Z', '2026-09-24T19:00:00.000Z'),
		placed(5218, KNECHT, DET, 2_000_000, '2026-09-24T15:15:01.801Z', DET_CLOSES_AT),
		ev(
			5478,
			AUCTION_CLOSED_EVENT,
			{
				fantraxPlayerId: WHITMORE,
				playerName: 'Cam Whitmore',
				teamId: DET,
				teamName: 'Detroit',
				managerId: `m-${DET}`,
				winningAmount: 3_000_000,
				capHit: 3_000_000,
				placement: 'active_bench',
				contention: 'standard',
				contractYears: null,
				closedAt: '2026-09-24T19:00:00.000Z',
				releasedNominationSlot: true
			},
			'2026-09-24T20:00:00.000Z',
			SYSTEM
		),
		detCancelled(),
		placed(5534, KNECHT, NYK, 1_000_000, '2026-09-25T16:57:00.000Z', LOTTERY_CLOSES_AT, 'a'.repeat(64)),
		placed(5540, KNECHT, BOS, 1_000_000, '2026-09-25T17:30:00.000Z', LOTTERY_CLOSES_AT)
	];
}

/** DET's roster as it stands after Butler's IR Move: room to land Knecht. */
export const DET_FIGURES_NOW: CandidateRosterFigures = {
	capSpace: parseMoney(30_000_000),
	rosterCount: 10,
	minorLeagueOccupied: 3
};

/** DET's roster with no Active/Bench room and no Minor League room either. */
export const DET_FIGURES_FULL: CandidateRosterFigures = {
	capSpace: parseMoney(30_000_000),
	rosterCount: 12,
	minorLeagueOccupied: 3
};

/** Every fold over one events array — `loadBidReinstatementState`, in memory. */
export function stateFor(
	events: readonly AppendedEvent[],
	cancellationSeq = CANCELLATION_SEQ,
	figures: CandidateRosterFigures | null = DET_FIGURES_NOW
): BidReinstatementState {
	const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);
	return {
		phase: fold(INITIAL_PHASE, events, phaseReducer),
		facts: bidReinstatementFactsFor(events, cancellationSeq),
		auctions: fold(INITIAL_AUCTIONS, events, auctionsReducer),
		leagueClock: fold(INITIAL_LEAGUE_CLOCK, events, leagueClockReducer),
		rosterFigures: figures,
		playerNameFor: (id) => nominationForPlayer(nominations, id)?.playerName ?? id
	};
}

/** The appended reinstatement, as the shell would append it. */
export function reinstatementEvent(seq: number, payload: unknown): AppendedEvent {
	return ev(seq, BID_CANCELLATION_REVERSED_EVENT, payload, '2026-09-25T18:00:00.000Z', {
		managerId: 'm-c',
		teamId: CHA
	});
}

/** The unrelated cancellation of NYK's lottery entry, by a close elsewhere. */
export const NYK_CANCELLATION_SEQ = '5536';

/**
 * The nested case: after NYK opens the lottery, an UNRELATED close cancels
 * NYK's entry (5536) before BOS joins (5540). Reinstating DET still erases
 * both later Bids — but NYK's had already committed nothing.
 */
export function nestedLog(): AppendedEvent[] {
	const log = knechtLog();
	const bos = log.pop();
	if (bos === undefined) throw new Error('knechtLog is empty');
	return [
		...log,
		ev(
			Number(NYK_CANCELLATION_SEQ),
			BID_CANCELLED_EVENT,
			{
				fantraxPlayerId: KNECHT,
				playerName: 'Dalton Knecht',
				cancelledSeq: NYK_BID_SEQ,
				teamId: NYK,
				teamName: 'New York',
				managerId: `m-${NYK}`,
				amount: 1_000_000,
				wasContentionEntry: true,
				causeFantraxPlayerId: 'p-elsewhere',
				causePlayerName: 'Someone Else',
				causeTeamId: NYK,
				restoration: null
			},
			'2026-09-25T17:00:00.000Z',
			SYSTEM
		),
		bos
	];
}
