/**
 * PRD §10 example 32 — **A restoration that is skipped, not undone**
 * (Story 10.4, FR-40).
 *
 * > Carter's history below Team U reads: Team V at $1,500,000 (sequence 150),
 * > Team W at $1,000,000 (sequence 120). By the time Team U's bid is
 * > cancelled, Team V has itself reached Roster Count 12. Team V is tried
 * > first and **fails the capacity gate**, so it is skipped — it is never
 * > restored and then cancelled, because a restoration must not trigger a
 * > cascade. Team W is tried next, passes both gates, and becomes Leading
 * > Bidder at $1,000,000. The auction's price falls from $2,000,000 to
 * > $1,000,000, which is correct: $1,000,000 is what the highest team still
 * > able to win him actually offered.
 *
 * **The load-bearing assertion is the negative one.** Team V is HIGHER than
 * Team W and still standing in the history, so a fold that promoted the
 * highest surviving Bid would seat Team V — a Team the capacity gate has just
 * refused. `withBidCancelled` reads the recorded decision instead, which is
 * the whole of why `restoration` rides the event.
 *
 * **And Team V is not cancelled.** A skipped candidate is passed over, not
 * withdrawn: its Bid keeps its standing, keeps its place in the history, and
 * carries no cancellation marker. Restoration is not a cascade trigger, and
 * that bound is what terminates the cascade.
 *
 * Calls the core directly against state literals — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { parseMoney } from '../../src/lib/core/money.ts';
import type { Money } from '../../src/lib/core/money.ts';
import {
	BID_CANCELLED_EVENT,
	auctionForPlayer,
	auctionsReducer,
	wasCancelled
} from '../../src/lib/core/projection/auctions.ts';
import type { Auction, Bid, OpenAuctions } from '../../src/lib/core/projection/auctions.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import type { OpenNomination } from '../../src/lib/core/projection/nominations.ts';
import { decideClose } from '../../src/lib/core/rules/close.ts';
import type { BidCancelledPayload, CloseState } from '../../src/lib/core/rules/close.ts';
import { bidStateFor, teamMoneyStateFor } from '../../src/lib/core/rules/bidding.ts';
import { evaluateRestore } from '../../src/lib/core/rules/bidding.ts';
import type { AppendedEvent, EventEnvelope } from '../../src/lib/core/types.ts';

/** Nobody here is short of money. Capacity is the ground, exactly as stated. */
const CAP_SPACE: Money = parseMoney(40_000_000);

const BROOKS_CLOSES = '2026-08-27T11:00:00.000Z';
const CARTER_CLOSES = '2026-08-28T06:00:00.000Z';

function bidBy(
	seq: string,
	teamId: string,
	teamName: string,
	managerId: string,
	amount: number,
	closesAt: string
): Bid {
	return {
		seq,
		teamId,
		teamName,
		managerId,
		amount: parseMoney(amount),
		occurredAt: '2026-08-26T09:00:00.000Z',
		closesAt,
		seedHash: null
	};
}

const BROOKS_BID = bidBy('140', 't-u', 'Team U', 'm-u', 3_000_000, BROOKS_CLOSES);
/** "Team W at $1,000,000 (sequence 120)" — the OLDEST Bid, and the winner. */
const CARTER_W_BID = bidBy('120', 't-w', 'Team W', 'm-w', 1_000_000, CARTER_CLOSES);
/** "Team V at $1,500,000 (sequence 150)" — higher, and skipped. */
const CARTER_V_BID = bidBy('150', 't-v', 'Team V', 'm-v', 1_500_000, CARTER_CLOSES);
const CARTER_U_BID = bidBy('190', 't-u', 'Team U', 'm-u', 2_000_000, CARTER_CLOSES);

function standardAuction(fantraxPlayerId: string, bids: readonly Bid[]): Auction {
	const leadingBid = bids[bids.length - 1];
	if (leadingBid === undefined) throw new Error('example 32: an Auction with no Bids');
	return {
		fantraxPlayerId,
		contention: 'standard',
		leadingBid,
		closesAt: leadingBid.closesAt,
		bids: [...bids],
		contenders: [],
		seedHash: null,
		seed: null
	};
}

const BROOKS = standardAuction('p-brooks', [BROOKS_BID]);
const CARTER = standardAuction('p-carter', [CARTER_W_BID, CARTER_V_BID, CARTER_U_BID]);

const PLAYER_NAMES: Readonly<Record<string, string>> = {
	'p-brooks': 'Dex Brooks',
	'p-carter': 'Ellis Carter'
};

function nominationOf(fantraxPlayerId: string): OpenNomination {
	return {
		fantraxPlayerId,
		playerName: PLAYER_NAMES[fantraxPlayerId] ?? fantraxPlayerId,
		teamId: 't-n',
		teamName: 'Team N',
		managerId: 'm-n',
		occurredAt: '2026-08-26T08:00:00.000Z'
	};
}

function auctionsOf(entries: readonly Auction[]): OpenAuctions {
	return {
		byPlayer: Object.fromEntries(entries.map((auction) => [auction.fantraxPlayerId, auction]))
	};
}

/**
 * The Brooks close, with Team U at Roster Count 11 before it — the state
 * example 31 leaves behind, which is the state this example opens from.
 *
 * `rosterFiguresFor` is the shell's one batched read: Team V is AT the twelve
 * and Team W has four Slots free. Those two numbers are the whole example.
 */
const CLOSE_STATE: CloseState = {
	auction: BROOKS,
	nomination: nominationOf('p-brooks'),
	playerIsMinorLeagueEligible: false,
	minorLeagueOccupied: 0,
	auctions: auctionsOf([BROOKS, CARTER]),
	capSpace: CAP_SPACE,
	rosterCount: 11,
	isMinorLeagueEligible: () => false,
	playerNameFor: (playerId: string) => PLAYER_NAMES[playerId] ?? playerId,
	drawnWinner: null,
	rosterFiguresFor: (teamId: string) => {
		if (teamId === 't-v') return { capSpace: CAP_SPACE, rosterCount: 12, minorLeagueOccupied: 0 };
		if (teamId === 't-w') return { capSpace: CAP_SPACE, rosterCount: 8, minorLeagueOccupied: 0 };
		return null;
	}
};

function appended(seq: number, event: EventEnvelope, occurredAt: string): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt,
		schemaVersion: 1,
		coreVersion: 2,
		type: event.type,
		payload: event.payload,
		managerId: event.managerId,
		teamId: event.teamId,
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

const decided = decideClose(CLOSE_STATE, BROOKS_CLOSES, null);
const cancellations = decided.events.filter((event) => event.type === BID_CANCELLED_EVENT);
const payload = cancellations[0]?.payload as BidCancelledPayload | undefined;
const folded = fold(
	auctionsOf([CARTER]),
	decided.events.map((event, index) => appended(200 + index, event, BROOKS_CLOSES)),
	auctionsReducer
);
const carter = auctionForPlayer(folded, 'p-carter');

describe('§10 example 32 — a restoration that is skipped, not undone', () => {
	it('cancels exactly one Bid — Team U’s — and appends no second event', () => {
		expect(decided.events.map((event) => event.type)).toEqual([
			AUCTION_CLOSED_EVENT,
			BID_CANCELLED_EVENT
		]);
		expect(payload?.cancelledSeq).toBe('190');
		expect(payload?.teamId).toBe('t-u');
	});

	it('fails Team V on capacity — Roster Count 12, so no Slot and no allowance', () => {
		// The gate, asked directly, so the skip has a stated reason rather than
		// being inferred from the outcome. `F = 0`, so FR-37's precondition
		// refuses before the allowance arithmetic is even reached.
		const team = teamMoneyStateFor({
			teamId: 't-v',
			fantraxPlayerId: 'p-carter',
			capSpace: CAP_SPACE,
			rosterCount: 12,
			minorLeagueOccupied: 0,
			auctions: auctionsOf([CARTER]),
			isMinorLeagueEligible: () => false,
			playerNameFor: (playerId: string) => PLAYER_NAMES[playerId] ?? playerId
		});
		const gates = evaluateRestore(
			bidStateFor(CARTER, team, false, 'Auction'),
			{
				kind: 'RestoreLeadingBid',
				fantraxPlayerId: 'p-carter',
				teamId: 't-v',
				teamName: 'Team V',
				managerId: 'm-v',
				amount: parseMoney(1_500_000)
			},
			CARTER_CLOSES
		);

		expect(gates.slots.freeActiveBenchSlots).toBe(0);
		expect(gates.slots.passed).toBe(false);
		// Money is not the ground here, and both outcomes are always returned.
		expect(gates.cap.passed).toBe(true);
	});

	it('restores Team W at $1,000,000 — the next below the skipped one', () => {
		expect(payload?.restoration).toEqual({
			seq: '120',
			teamId: 't-w',
			teamName: 'Team W',
			managerId: 'm-w',
			amount: 1_000_000
		});
	});

	it('seats Team W in the fold, and the price falls from $2,000,000 to $1,000,000', () => {
		expect(carter?.leadingBid?.seq).toBe('120');
		expect(carter?.leadingBid?.teamId).toBe('t-w');
		expect(carter?.leadingBid?.amount).toBe(1_000_000);
		expect(carter?.contention).toBe('standard');
		// A Bid leads, so the clock is untouched — a Restored Leading Bidder
		// inherits whatever is left of it.
		expect(carter?.closesAt).toBe(CARTER_CLOSES);
	});

	it('never cancels Team V — it is skipped, and its Bid still stands', () => {
		// The bound that terminates the cascade, stated as the negative it is.
		// A restoration is not a trigger, so nothing here may take Team V's
		// $1,500,000 away from it.
		expect(cancellations).toHaveLength(1);
		const teamV = carter?.bids.find((bid) => bid.seq === '150');
		expect(teamV?.teamId).toBe('t-v');
		expect(wasCancelled(teamV as Bid)).toBe(false);
		// And the history is whole: three Bids, in `seq` order, one marked.
		expect(carter?.bids.map((bid) => bid.seq)).toEqual(['120', '150', '190']);
		expect(wasCancelled(carter?.bids[2] as Bid)).toBe(true);
	});

	it('does NOT promote the highest survivor — which is the whole example', () => {
		// Team V is higher than Team W and still standing. A fold deriving the
		// lead from `highestStandingBid` in Standard Contention would seat it,
		// and would be seating a Team the capacity gate has just refused.
		expect(carter?.leadingBid?.teamId).not.toBe('t-v');
		expect(carter?.leadingBid?.amount).toBeLessThan(1_500_000);
	});

	it('commits Team W’s $1,000,000 and commits Team V nothing', () => {
		// Re-committing is a consequence, not a write: the Bid starts leading
		// and `teamMoneyStateFor` starts counting it.
		const w = teamMoneyStateFor({
			teamId: 't-w',
			fantraxPlayerId: 'p-nothing',
			capSpace: CAP_SPACE,
			rosterCount: 8,
			minorLeagueOccupied: 0,
			auctions: folded,
			isMinorLeagueEligible: () => false,
			playerNameFor: (playerId: string) => PLAYER_NAMES[playerId] ?? playerId
		});
		expect(w.leading.map((lead) => lead.amount)).toEqual([1_000_000]);

		const v = teamMoneyStateFor({
			teamId: 't-v',
			fantraxPlayerId: 'p-nothing',
			capSpace: CAP_SPACE,
			rosterCount: 12,
			minorLeagueOccupied: 0,
			auctions: folded,
			isMinorLeagueEligible: () => false,
			playerNameFor: (playerId: string) => PLAYER_NAMES[playerId] ?? playerId
		});
		expect(v.leading).toEqual([]);
		expect(v.eligibleLeading).toEqual([]);
	});
});
