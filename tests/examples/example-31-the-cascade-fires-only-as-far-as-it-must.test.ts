/**
 * PRD §10 example 31 — **The cascade fires, and only as far as it must**
 * (AD-25), the cancellation half.
 *
 * > Team U has Roster Count 10, so Free Active/Bench Slots is 2 and it may
 * > hold 3 outstanding bids. It leads three non-eligible auctions: Anderson at
 * > $4,000,000 (sequence 100), Brooks at $3,000,000 (sequence 140), Carter at
 * > $2,000,000 (sequence 190). `P = 3 ≤ 2 + 1` — permitted. **Anderson
 * > closes.** Team U wins, Roster Count becomes 11, Free Active/Bench Slots
 * > becomes 1, and it now holds 2 surviving commitments against an allowance
 * > of `1 + 1 = 2`. It is within capacity, so **nothing is cancelled** — the
 * > cascade is conditional, not a reflex. **Brooks then closes.** Roster Count
 * > becomes 12, Free Active/Bench Slots becomes 0, and the single surviving
 * > commitment on Carter has `P = 1 ≠ 0` with no free slot. **Carter's bid is
 * > cancelled** — it is the most recent survivor at sequence 190 — Team U's
 * > $2,000,000 is released, and Team U is notified naming *the Brooks win* as
 * > the cause. […] **Carter's Auction Clock is untouched** and still expires
 * > when it always would have. The League Clock does not move, and Team U's
 * > original bid stays visible in Carter's history.
 *
 * > Carter's auction is restored to its next-highest surviving bid — Team V's
 * > $1,500,000 — and Team V is notified that it is leading again.
 *
 * **This file owns both halves since Story 10.4.** The cancellation half is
 * unchanged: the first close cancels nothing, the second cancels exactly one
 * Bid and names the Brooks win as its cause, Team U's $2,000,000 is released
 * with no release written anywhere, and the cancelled Bid is still in Carter's
 * history. The restoration half is the sentence above: Team V's $1,500,000
 * passes both gates, the ONE `BidCancelled` carries the restored Team, Bid
 * `seq` and amount, the fold seats Team V as Leading Bidder, Team V's capital
 * is committed again with nothing written to commit it, and **Carter's Auction
 * Clock and the League Clock are both still untouched** — a Restored Leading
 * Bidder inherits the minutes that were left, and a restoration is not a
 * reset.
 *
 * **The two negatives are the load-bearing assertions.** A cascade that fired
 * on the first close would take a Bid the allowance permits; one that kept
 * going after Carter would take a Bid nothing requires. Both are stated.
 *
 * Calls the core directly against state literals — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { parseMoney } from '../../src/lib/core/money.ts';
import type { Money } from '../../src/lib/core/money.ts';
import {
	BID_CANCELLED_EVENT,
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer,
	wasCancelled
} from '../../src/lib/core/projection/auctions.ts';
import type { Auction, Bid, OpenAuctions } from '../../src/lib/core/projection/auctions.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	BID_VOIDED_EVENT,
	INITIAL_LEAGUE_CLOCK,
	leagueClockReducer
} from '../../src/lib/core/projection/league-clock.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import type { OpenNomination } from '../../src/lib/core/projection/nominations.ts';
import { decideClose } from '../../src/lib/core/rules/close.ts';
import type { BidCancelledPayload, CloseState } from '../../src/lib/core/rules/close.ts';
import { bidStateFor, evaluate, teamMoneyStateFor } from '../../src/lib/core/rules/bidding.ts';
import type { AppendedEvent, EventEnvelope } from '../../src/lib/core/types.ts';

/** Team U's Cap Space before either close. Money is never the ground here. */
const CAP_SPACE: Money = parseMoney(30_000_000);

const ANDERSON_CLOSES = '2026-08-27T09:00:00.000Z';
const BROOKS_CLOSES = '2026-08-27T11:00:00.000Z';
/** Carter's clock: hours after both, and it must be identical afterwards. */
const CARTER_CLOSES = '2026-08-28T06:00:00.000Z';

/** One of Team U's three leads, at the `seq` the example names. */
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

const ANDERSON_BID = bidBy('100', 't-u', 'Team U', 'm-u', 4_000_000, ANDERSON_CLOSES);
const BROOKS_BID = bidBy('140', 't-u', 'Team U', 'm-u', 3_000_000, BROOKS_CLOSES);
/** Team V's earlier, lower Bid on Carter. Story 10.4 restores it, not this. */
const CARTER_TEAM_V_BID = bidBy('150', 't-v', 'Team V', 'm-v', 1_500_000, CARTER_CLOSES);
const CARTER_BID = bidBy('190', 't-u', 'Team U', 'm-u', 2_000_000, CARTER_CLOSES);

function standardAuction(fantraxPlayerId: string, bids: readonly Bid[]): Auction {
	// The highest Bid leads, which in an ascending Auction is the last one.
	const leadingBid = bids[bids.length - 1];
	if (leadingBid === undefined) throw new Error('example 31: an Auction with no Bids');
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

const ANDERSON = standardAuction('p-anderson', [ANDERSON_BID]);
const BROOKS = standardAuction('p-brooks', [BROOKS_BID]);
const CARTER = standardAuction('p-carter', [CARTER_TEAM_V_BID, CARTER_BID]);

const PLAYER_NAMES: Readonly<Record<string, string>> = {
	'p-anderson': 'Ray Anderson',
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
		holdsSlot: true,
		occurredAt: '2026-08-26T08:00:00.000Z'
	};
}

function auctionsOf(entries: readonly Auction[]): OpenAuctions {
	return {
		byPlayer: Object.fromEntries(entries.map((auction) => [auction.fantraxPlayerId, auction]))
	};
}

/**
 * The close of one Auction, with Team U's roster as it stands BEFORE it.
 *
 * `auctions` carries the Auction being closed as well as the survivors,
 * exactly as `loadCloseState` hands it over: dropping the won Player is
 * `decideClose`'s own derivation and not the caller's.
 */
function closeOf(
	auction: Auction,
	rosterCount: number,
	survivors: readonly Auction[]
): CloseState {
	return {
		auction,
		nomination: nominationOf(auction.fantraxPlayerId),
		winnerHoldsNominationSlot: false,
		playerIsMinorLeagueEligible: false,
		// "no minor-league involvement" — every one of these is non-eligible.
		minorLeagueOccupied: 0,
		auctions: auctionsOf([auction, ...survivors]),
		capSpace: CAP_SPACE,
		rosterCount,
		isMinorLeagueEligible: () => false,
		playerNameFor: (playerId: string) => PLAYER_NAMES[playerId] ?? playerId,
		drawnWinner: null,
		// **Story 10.4: the candidate's figures, from the shell's one batched
		// read.** Team V has room and money — Roster Count 8 against a ceiling
		// of twelve, and the same $30,000,000 nobody in this example is short
		// of — so its $1,500,000 passes both restoration gates and it is handed
		// the Auction. The WINNER's figures are not answered here: `cascadeFor`
		// substitutes its own post-close derivation for Team U, which is what
		// stops a Close restoring the Team it just disqualified.
		rosterFiguresFor: (teamId: string) =>
			teamId === 't-v'
				? { capSpace: CAP_SPACE, rosterCount: 8, minorLeagueOccupied: 0 }
				: null
	};
}

/** The envelope-to-`AppendedEvent` lift, so decided events can be folded. */
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

describe('§10 example 31 — the cascade fires, and only as far as it must', () => {
	it('permits all three outstanding Bids at Roster Count 10: P = 3 <= 2 + 1', () => {
		// The state the example opens from, stated as the gate that admitted
		// it: two of the three leads already held, the third being placed.
		const team = teamMoneyStateFor({
			teamId: 't-u',
			fantraxPlayerId: 'p-carter',
			capSpace: CAP_SPACE,
			rosterCount: 10,
			minorLeagueOccupied: 0,
			auctions: auctionsOf([ANDERSON, BROOKS, CARTER]),
			isMinorLeagueEligible: () => false,
			playerNameFor: (playerId: string) => PLAYER_NAMES[playerId] ?? playerId
		});
		const gates = evaluate(
			bidStateFor(null, team, false, 'Auction'),
			{
				kind: 'PlaceBid',
				fantraxPlayerId: 'p-carter',
				teamId: 't-u',
				teamName: 'Team U',
				managerId: 'm-u',
				amount: parseMoney(2_000_000)
			},
			'2026-08-26T09:00:00.000Z'
		);

		expect(gates.slots.freeActiveBenchSlots).toBe(2);
		expect(gates.slots.allowance).toBe(3);
		expect(gates.slots.projectedAdditions).toBe(3);
		expect(gates.slots.passed).toBe(true);
	});

	describe('Anderson closes — nothing is cancelled', () => {
		const decided = decideClose(
			closeOf(ANDERSON, 10, [BROOKS, CARTER]),
			ANDERSON_CLOSES,
			null
		);

		it('appends ONE event, and it is the close', () => {
			// "It is within capacity, so nothing is cancelled — the cascade is
			// conditional, not a reflex." The Close DID reduce a free Slot
			// (2 → 1), so the trigger fired and the re-test is what stopped it.
			expect(decided.events).toHaveLength(1);
			expect(decided.events[0]?.type).toBe(AUCTION_CLOSED_EVENT);
		});

		it('holds 2 surviving commitments against an allowance of 1 + 1', () => {
			// The arithmetic the example gives for why nothing goes. Stated
			// through the same gate the cascade re-tests with, so a hand-rolled
			// `holdings <= freeSlots` rule would fail here rather than silently
			// cancelling Carter a close early.
			const team = teamMoneyStateFor({
				teamId: 't-u',
				fantraxPlayerId: 'p-carter',
				capSpace: CAP_SPACE,
				rosterCount: 11,
				minorLeagueOccupied: 0,
				auctions: auctionsOf([BROOKS, CARTER]),
				isMinorLeagueEligible: () => false,
				playerNameFor: (playerId: string) => PLAYER_NAMES[playerId] ?? playerId
			});
			const gates = evaluate(
				bidStateFor(CARTER, team, false, 'Auction'),
				{
					kind: 'PlaceBid',
					fantraxPlayerId: 'p-carter',
					teamId: 't-u',
					teamName: 'Team U',
					managerId: 'm-u',
					amount: parseMoney(2_000_000)
				},
				'2026-08-27T09:00:00.000Z'
			);

			expect(gates.slots.freeActiveBenchSlots).toBe(1);
			expect(gates.slots.allowance).toBe(2);
			expect(gates.slots.projectedAdditions).toBe(2);
			expect(gates.slots.passed).toBe(true);
		});
	});

	describe('Brooks then closes — Carter’s Bid is cancelled, and only Carter’s', () => {
		const decided = decideClose(closeOf(BROOKS, 11, [CARTER]), BROOKS_CLOSES, null);
		const cancellations = decided.events.filter((event) => event.type === BID_CANCELLED_EVENT);
		const payload = cancellations[0]?.payload as BidCancelledPayload | undefined;

		it('appends the close and then exactly ONE cancellation, in that order', () => {
			// The fixed order inside the one transaction: cause, then
			// consequence. A log read in `seq` order states the win that filled
			// the Slot before it states what that cost the Team elsewhere.
			expect(decided.events.map((event) => event.type)).toEqual([
				AUCTION_CLOSED_EVENT,
				BID_CANCELLED_EVENT
			]);
		});

		it('names sequence 190 — the most recent survivor — and the Brooks win as its cause', () => {
			expect(payload?.cancelledSeq).toBe('190');
			expect(payload?.fantraxPlayerId).toBe('p-carter');
			expect(payload?.playerName).toBe('Ellis Carter');
			// "Team U is notified naming the Brooks win as the cause."
			expect(payload?.causeFantraxPlayerId).toBe('p-brooks');
			expect(payload?.causePlayerName).toBe('Dex Brooks');
			expect(payload?.causeTeamId).toBe('t-u');
			// "$2,000,000 is released" — the figure is recorded; the release
			// itself is derived, and the next test is where that is proved.
			expect(payload?.amount).toBe(2_000_000);
			expect(payload?.wasContentionEntry).toBe(false);
		});

		it('carries the restored Team, Bid sequence and amount on the SAME event', () => {
			// "Carter's auction is restored to its next-highest surviving bid —
			// Team V's $1,500,000." One `BidCancelled` states the cancellation
			// AND the succession; `rules/restore.ts` appends nothing of its own,
			// so a second event here would be the bug.
			expect(cancellations).toHaveLength(1);
			expect(payload?.restoration).toEqual({
				seq: '150',
				teamId: 't-v',
				teamName: 'Team V',
				managerId: 'm-v',
				amount: 1_500_000
			});
		});

		it('addresses the cancelled Manager and Team, so the notice has somewhere to go', () => {
			expect(cancellations[0]?.teamId).toBe('t-u');
			expect(cancellations[0]?.managerId).toBe('m-u');
		});

		it('releases the $2,000,000 with no release written — it simply stops being counted', () => {
			// The whole of FR-40's capital release: fold the decided events
			// onto the Auctions and ask `teamMoneyStateFor` again. Nothing in
			// the log says "release"; the Bid stops leading and the sum stops
			// including it.
			const before = teamMoneyStateFor({
				teamId: 't-u',
				fantraxPlayerId: 'p-nothing',
				capSpace: CAP_SPACE,
				rosterCount: 12,
				minorLeagueOccupied: 0,
				auctions: auctionsOf([CARTER]),
				isMinorLeagueEligible: () => false,
				playerNameFor: (playerId: string) => PLAYER_NAMES[playerId] ?? playerId
			});
			expect(before.leading.map((lead) => lead.amount)).toEqual([2_000_000]);

			const folded = fold(
				auctionsOf([CARTER]),
				decided.events.map((event, index) => appended(200 + index, event, BROOKS_CLOSES)),
				auctionsReducer
			);
			const after = teamMoneyStateFor({
				teamId: 't-u',
				fantraxPlayerId: 'p-nothing',
				capSpace: CAP_SPACE,
				rosterCount: 12,
				minorLeagueOccupied: 0,
				auctions: folded,
				isMinorLeagueEligible: () => false,
				playerNameFor: (playerId: string) => PLAYER_NAMES[playerId] ?? playerId
			});
			expect(after.leading).toEqual([]);
			expect(after.eligibleLeading).toEqual([]);
		});

		it('re-commits Team V’s $1,500,000 as a consequence — no re-commit is written', () => {
			// The mirror of the release above, and the same mechanism read the
			// other way. Before the fold Team V leads nothing: Team U's
			// $2,000,000 is above it. After it, Team V leads Carter and
			// `teamMoneyStateFor` counts the $1,500,000 again. Nothing in the
			// log says "commit"; the Bid starts leading and the sum starts
			// including it.
			const before = teamMoneyStateFor({
				teamId: 't-v',
				fantraxPlayerId: 'p-nothing',
				capSpace: CAP_SPACE,
				rosterCount: 8,
				minorLeagueOccupied: 0,
				auctions: auctionsOf([CARTER]),
				isMinorLeagueEligible: () => false,
				playerNameFor: (playerId: string) => PLAYER_NAMES[playerId] ?? playerId
			});
			expect(before.leading).toEqual([]);

			const folded = fold(
				auctionsOf([CARTER]),
				decided.events.map((event, index) => appended(200 + index, event, BROOKS_CLOSES)),
				auctionsReducer
			);
			const after = teamMoneyStateFor({
				teamId: 't-v',
				fantraxPlayerId: 'p-nothing',
				capSpace: CAP_SPACE,
				rosterCount: 8,
				minorLeagueOccupied: 0,
				auctions: folded,
				isMinorLeagueEligible: () => false,
				playerNameFor: (playerId: string) => PLAYER_NAMES[playerId] ?? playerId
			});
			expect(after.leading.map((lead) => lead.amount)).toEqual([1_500_000]);
			expect(after.eligibleLeading).toEqual([]);
		});

		it('keeps the Bid in Carter’s history, marked, and leaves the Auction Clock untouched', () => {
			const folded = fold(
				auctionsOf([CARTER]),
				decided.events.map((event, index) => appended(200 + index, event, BROOKS_CLOSES)),
				auctionsReducer
			);
			const carter = auctionForPlayer(folded, 'p-carter');

			// "Team U's original bid stays visible in Carter's history."
			expect(carter?.bids.map((bid) => bid.seq)).toEqual(['150', '190']);
			const cancelled = carter?.bids.find((bid) => bid.seq === '190');
			expect(cancelled?.amount).toBe(2_000_000);
			expect(cancelled?.teamId).toBe('t-u');
			expect(wasCancelled(cancelled as Bid)).toBe(true);
			expect(cancelled?.cancellation?.causePlayerName).toBe('Dex Brooks');
			// Team V's Bid is untouched, and now it LEADS — seated from the
			// recorded decision, not re-derived from the history.
			expect(wasCancelled(carter?.bids[0] as Bid)).toBe(false);
			expect(carter?.leadingBid?.seq).toBe('150');
			expect(carter?.leadingBid?.teamId).toBe('t-v');
			expect(carter?.leadingBid?.amount).toBe(1_500_000);
			// The price fell, and the contention state did not move with it.
			expect(carter?.contention).toBe('standard');

			// "Carter's Auction Clock is untouched and still expires when it
			// always would have." A Bid survives, so nothing clears it.
			expect(carter?.closesAt).toBe(CARTER_CLOSES);
		});

		it('does not move the League Clock — a cancellation is not a void', () => {
			// The sharpest trap in the epic. `BidVoided` withdraws a reset;
			// `BidCancelled` withdraws a Bid's standing and nothing else, so
			// `leagueClockReducer` must fall through to its default. A reducer
			// treating the two alike would end the Auction Phase early every
			// time a roster filled.
			const before = fold(
				INITIAL_LEAGUE_CLOCK,
				[
					appended(
						1,
						{ type: 'AuctionOpened', payload: {}, managerId: null, teamId: null },
						'2026-08-20T00:00:00.000Z'
					),
					// Carter's own Bid, as the reset it was. It is the very
					// `seq` the cancellation names, so a reducer that treated
					// the two alike would drop THIS reset and shorten the
					// League Clock — which is the failure this test exists for.
					appended(190, bidEvent(CARTER_BID, 'p-carter'), CARTER_BID.occurredAt)
				],
				leagueClockReducer
			);
			expect(before.resets.map((reset) => reset.seq)).toEqual(['190']);
			const after = fold(
				before,
				decided.events.map((event, index) => appended(200 + index, event, BROOKS_CLOSES)),
				leagueClockReducer
			);

			expect(after).toEqual(before);
			expect(after.voidedSeqs).toEqual([]);
			// ...and the type it must not be confused with is a different one.
			expect(BID_CANCELLED_EVENT).not.toBe(BID_VOIDED_EVENT);
		});
	});

	it('cancels nothing at all once Carter is gone — the cascade stops where it must', () => {
		// The other negative: a Team with no surviving commitment has nothing
		// left to take, and a cascade that kept going would have to invent a
		// victim. Brooks closes again against a fold holding only itself.
		const decided = decideClose(closeOf(BROOKS, 11, []), BROOKS_CLOSES, null);
		expect(decided.events.map((event) => event.type)).toEqual([AUCTION_CLOSED_EVENT]);
	});

	it('starts from the log’s own fold, not only from state literals', () => {
		// The fixtures above are hand-built `Auction`s; this is the same
		// Carter Auction reached through `auctionsReducer`, so a divergence
		// between what the reducer folds and what the example assumes fails
		// here rather than in production.
		const folded = fold(
			INITIAL_AUCTIONS,
			[
				appended(150, bidEvent(CARTER_TEAM_V_BID, 'p-carter'), CARTER_TEAM_V_BID.occurredAt),
				appended(190, bidEvent(CARTER_BID, 'p-carter'), CARTER_BID.occurredAt)
			],
			auctionsReducer
		);
		const carter = auctionForPlayer(folded, 'p-carter');
		expect(carter?.leadingBid?.seq).toBe('190');
		expect(carter?.closesAt).toBe(CARTER_CLOSES);
	});
});

/** A `BidPlaced` envelope for one folded Bid — the payload as `decide()` writes it. */
function bidEvent(bid: Bid, fantraxPlayerId: string): EventEnvelope {
	return {
		type: 'BidPlaced',
		payload: {
			fantraxPlayerId,
			teamId: bid.teamId,
			teamName: bid.teamName,
			managerId: bid.managerId,
			amount: bid.amount,
			closesAt: bid.closesAt,
			seedHash: bid.seedHash
		},
		managerId: bid.managerId,
		teamId: bid.teamId
	};
}
