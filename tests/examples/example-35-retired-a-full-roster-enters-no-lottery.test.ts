/**
 * PRD §10 example 35 — **RETIRED on 2026-09-18**, and this file is the record
 * of that plus the regression that keeps it retired.
 *
 * Example 35 existed to state two things, both resting on a Free Minor League
 * Slot being somewhere a win could land:
 *
 * > Team Y has Roster Count 12 (Free Active/Bench Slots 0) and one Free Minor
 * > League Slot. It is a Contender in three Minimum-Bid Contentions on **Minor
 * > League Eligible** players. All three entries are permitted under FR-18's
 * > `M ≥ 1` branch despite the Team having no Active/Bench room […]
 *
 * > The first is drawn and **Team Y wins**: he takes the last Minor League
 * > Slot at a $0 Cap Hit, **Roster Count stays 12** […] Had the trigger been
 * > written as *"a close that increases Roster Count"*, it would not have
 * > fired here at all.
 *
 * **Both halves are gone, and they are gone for one reason.** A Team cannot
 * win a Free Agent straight into its minors. FR-18's `M ≥ 1` branch has been
 * removed from `evaluateSlots` — the only Slot that can receive a lottery win
 * is an Active/Bench one — so Team Y, with no Active/Bench room, may enter no
 * contention at all and never reaches the state the second half describes.
 *
 * **The trigger distinction the example was built to protect no longer has a
 * witness, and that is the finding worth recording.** Every Auction win now
 * lands in Active/Bench and therefore increases Roster Count, so a trigger
 * phrased as "a close that increases Roster Count" and one phrased as "a close
 * that reduces a free slot" fire identically on every close. The example was
 * the one case that told them apart. FR-40's wording should still not be
 * narrowed to Roster Count — a Roster Move or a Trade can still free or fill a
 * Minor League Slot without touching the twelve — but a CLOSE can no longer
 * demonstrate it, and the assertions below say so rather than pretending
 * otherwise.
 *
 * **What survives is the cascade itself.** The close still fires it, still
 * cancels both remaining entries, still names the win as the cause and still
 * takes Team Y out of both Contender lists before either draws. Those are
 * FR-40's own guarantees and none of them depended on minors; they are kept
 * verbatim below, re-founded on a roster the gates can actually produce.
 *
 * **Roster Count starts at 11, not 12, and that is not a fudge.** At 12 Team Y
 * could not have entered the three lotteries it is holding, so a fixture built
 * there would assert against a position the gates make unreachable — the same
 * correction examples 20 and 22 needed. At 11 the entries are legal, the win
 * takes the twelfth Slot, and the two survivors are cancelled for having
 * nowhere left to land.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_BID, MINOR_LEAGUE_SLOTS } from '../../src/lib/core/constants.ts';
import { hash } from '../../src/lib/core/hash.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	BID_CANCELLED_EVENT,
	auctionForPlayer,
	auctionsReducer,
	wasCancelled
} from '../../src/lib/core/projection/auctions.ts';
import type {
	Auction,
	Bid,
	Contender,
	OpenAuctions
} from '../../src/lib/core/projection/auctions.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import { CONTENTION_DRAWN_EVENT } from '../../src/lib/core/projection/draws.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { decideClose } from '../../src/lib/core/rules/close.ts';
import type {
	AuctionClosedPayload,
	BidCancelledPayload,
	CloseState,
	ClosedWinner
} from '../../src/lib/core/rules/close.ts';
import type { AppendedEvent, EventEnvelope } from '../../src/lib/core/types.ts';
import {
	allGatesPassed,
	bidRefusalDetail,
	bidStateFor,
	decide,
	evaluate,
	failedGates
} from '../../src/lib/core/rules/bidding.ts';
import type {
	BidState,
	LeadingBidElsewhere,
	TeamMoneyState
} from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-24T14:00:00.000Z';

/** One eligible lottery Team Y already contends in. */
function eligibleEntry(index: number): LeadingBidElsewhere {
	return {
		fantraxPlayerId: `p-elig-${String(index)}`,
		playerName: `Prospect ${String(index)}`,
		// "each is an Eligible Leading Bid of $1,000,000" — the flat ticket
		// of FR-14, routed by eligibility rather than by amount.
		amount: parseMoney(MINIMUM_BID),
		isContentionEntry: true
	};
}

/**
 * Team Y holding `held` eligible entries: Roster Count 12, one Free Minor
 * League Slot, and enough Cap Space that money is never the ground here —
 * the example is about slots, and a fixture that ran out of money would be
 * asserting the wrong gate.
 */
function teamY(held: number, minorLeagueOccupied = MINOR_LEAGUE_SLOTS - 1): TeamMoneyState {
	return {
		capSpace: parseMoney(40_000_000),
		// "Roster Count 12 (Free Active/Bench Slots 0)".
		rosterCount: 12,
		// Entries are ORDINARY commitments now — `teamMoneyStateFor` never
		// writes `eligibleLeading`, so a fixture that filled it would assert
		// against a state the core cannot produce.
		leading: Array.from({ length: held }, (_unused, index) => eligibleEntry(index + 1)),
		eligibleLeading: [],
		// "one Free Minor League Slot" — kept, and now decisive of nothing.
		minorLeagueOccupied
	};
}

const OPENING: Bid = {
	seq: '1',
	teamId: 't-other',
	teamName: 'Team Other',
	managerId: 'm-other',
	amount: parseMoney(MINIMUM_BID),
	occurredAt: '2026-08-24T09:00:00.000Z',
	closesAt: '2026-08-25T09:00:00.000Z',
	seedHash: 'a'.repeat(64)
};

/** The next eligible Player's lottery, opened by another Team. */
const LOTTERY: Auction = {
	fantraxPlayerId: 'p-next',
	contention: 'minimum_bid',
	leadingBid: OPENING,
	closesAt: OPENING.closesAt,
	bids: [OPENING],
	contenders: [
		{
			seq: '1',
			teamId: 't-other',
			teamName: 'Team Other',
			managerId: 'm-other'
		}
	],
	seedHash: OPENING.seedHash,
	seed: null
};

/** Team Y joining it while it already holds `held` others. */
function joining(held: number, minorLeagueOccupied?: number): BidState {
	return bidStateFor(LOTTERY, teamY(held, minorLeagueOccupied), 'Auction');
}

const JOIN: PlaceBid = {
	kind: 'PlaceBid',
	fantraxPlayerId: 'p-next',
	teamId: 't-y',
	teamName: 'Team Y',
	managerId: 'm-y',
	amount: parseMoney(MINIMUM_BID)
};

describe('§10 example 35 — RETIRED: a full roster enters no lottery', () => {
	it('REFUSES all three entries, Free Minor League Slot or not', () => {
		// "All three entries are permitted under FR-18's `M ≥ 1` branch despite
		// the Team having no Active/Bench room" — the branch is gone, so none of
		// them is.
		for (const held of [0, 1, 2]) {
			const gates = evaluate(joining(held), JOIN, NOW);

			expect(gates.slots.isContentionEntry, String(held)).toBe(true);
			expect(gates.slots.freeActiveBenchSlots, String(held)).toBe(0);
			// The Slot the old branch read. Still free, still no help.
			expect(gates.slots.freeMinorLeagueSlots, String(held)).toBe(1);
			expect(gates.slots.passed, String(held)).toBe(false);
			expect(failedGates(gates), String(held)).toEqual(['slots']);
			// Money is never the ground here, exactly as the example intended.
			expect(gates.cap.passed, String(held)).toBe(true);
		}
	});

	it('collapses the TWO overflow figures into one permanent zero', () => {
		// The example's whole reason for existing on the money side:
		//
		//   money side:  `N = 3` against `M = 1`  →  Overflow Count 2
		//   slots side:  `N = 0` against `M = 1`  →  Active/Bench Overflow 0
		//
		// Same Team, same instant, both correct, and they had to be two
		// derivations. Neither counts anything now, so they agree at zero —
		// which is why Story 10.2's split has nothing left to protect here.
		const gates = evaluate(joining(3), JOIN, NOW);

		expect(gates.cap.eligibleLeadingBids).toBe(0);
		expect(gates.cap.overflowCount).toBe(0);
		expect(gates.slots.eligibleLeadingBidsExcludingEntries).toBe(0);
		expect(gates.slots.activeBenchOverflow).toBe(0);
	});

	it("still commits every entry's flat $1,000,000 to Committed Bids", () => {
		// FR-18's CAP side, which the example got right and which survives: a
		// Contender who wins pays, so each entry charges its flat ticket.
		for (const held of [0, 1, 2, 3]) {
			const cap = evaluate(joining(held), JOIN, NOW).cap;
			expect(cap.committedBids, String(held)).toBe(held * MINIMUM_BID);
		}
	});

	it("still exempts the entry from Roster Capacity's ARITHMETIC", () => {
		// The exemption survives — an entry projects no Active/Bench addition
		// and consumes no allowance. It is the LANDING test that refuses, and
		// the two are different rules inside one gate.
		const slots = evaluate(joining(3), JOIN, NOW).slots;

		expect(slots.projectedAdditions).toBe(0);
		expect(slots.rosterCount).toBe(12);
		expect(slots.passed).toBe(false);
	});

	it('refuses an ORDINARY bid from the same Team, on the same ground', () => {
		// The example contrasted the entry's pass against an ordinary Bid's
		// refusal. Both refuse now, and the contrast is gone.
		const ordinary = evaluate(
			bidStateFor(null, teamY(0), 'Auction'),
			{ ...JOIN, amount: parseMoney(1_500_000) },
			NOW
		);

		expect(ordinary.slots.passed).toBe(false);
		expect(failedGates(ordinary)).toEqual(['slots']);
	});

	it('refuses the entry with NO Minor League Slot too — identically', () => {
		// The example's last test took the free Slot away to prove the pass had
		// been on the eligible branch. Taking it away changes nothing now,
		// which is the same proof read backwards.
		const withSlot = evaluate(joining(3), JOIN, NOW);
		const without = evaluate(joining(3, MINOR_LEAGUE_SLOTS), JOIN, NOW);

		expect(withSlot.slots.passed).toBe(false);
		expect(without.slots.passed).toBe(false);
		expect(withSlot.slots.freeMinorLeagueSlots).toBe(1);
		expect(without.slots.freeMinorLeagueSlots).toBe(0);
		// The only figure that differs is the one that decides nothing.
		expect(failedGates(withSlot)).toEqual(failedGates(without));
	});
});

const SEED = '31d7a5c0be92f46831d7a5c0be92f46831d7a5c0be92f46831d7a5c0be92f468';
const SEED_HASH = hash(SEED);

/** The fixed instant these three lotteries close at. */
const LOTTERY_CLOSES = '2026-08-25T09:00:00.000Z';

function joinBid(seq: string, teamId: string, teamName: string, managerId: string): Bid {
	return {
		seq,
		teamId,
		teamName,
		managerId,
		amount: parseMoney(MINIMUM_BID),
		occurredAt: '2026-08-24T09:00:00.000Z',
		closesAt: LOTTERY_CLOSES,
		seedHash: null
	};
}

function contenderOf(bid: Bid): Contender {
	return {
		seq: bid.seq,
		teamId: bid.teamId,
		teamName: bid.teamName,
		managerId: bid.managerId
	};
}

/** One of Team Y's three lotteries on a Minor League Eligible Player. */
function eligibleLottery(index: number): Auction {
	const opening = joinBid(String(200 + index * 10), 't-other', 'Team Other', 'm-other');
	const join = joinBid(String(205 + index * 10), 't-y', 'Team Y', 'm-y');
	return {
		fantraxPlayerId: `p-elig-${String(index)}`,
		contention: 'minimum_bid',
		leadingBid: opening,
		closesAt: LOTTERY_CLOSES,
		bids: [opening, join],
		contenders: [contenderOf(opening), contenderOf(join)],
		seedHash: SEED_HASH,
		seed: null
	};
}

/** The three: index 0 is drawn and won; 1 and 2 survive into the cascade. */
const ELIGIBLE_LOTTERIES: readonly Auction[] = [0, 1, 2].map(eligibleLottery);
const WON_ELIGIBLE = ELIGIBLE_LOTTERIES[0] as Auction;

function auctionsOf(entries: readonly Auction[]): OpenAuctions {
	return {
		byPlayer: Object.fromEntries(entries.map((auction) => [auction.fantraxPlayerId, auction]))
	};
}

const DRAWN_Y: ClosedWinner = {
	kind: 'drawn',
	teamId: 't-y',
	teamName: 'Team Y',
	managerId: 'm-y',
	seed: SEED,
	contenders: WON_ELIGIBLE.contenders.map((contender) => contender.teamId),
	selectedIndex: 1
};

/**
 * The close, with Team Y's roster as it stands BEFORE it: Roster Count 12,
 * ONE free Minor League Slot, and the other two entries still held.
 *
 * `minorLeagueOccupied` is `MINOR_LEAGUE_SLOTS - 1`, the same "one Free Minor
 * League Slot" the entry half's fixture states, written as the raw occupancy
 * the core clamps rather than as `M`.
 */
const CLOSE_STATE: CloseState = {
	auction: WON_ELIGIBLE,
	nomination: {
		fantraxPlayerId: WON_ELIGIBLE.fantraxPlayerId,
		playerName: 'Prospect 0',
		teamId: 't-n',
		teamName: 'Team N',
		managerId: 'm-n',
		holdsSlot: true,
		occurredAt: '2026-08-24T08:00:00.000Z'
	},
	winnerHoldsNominationSlot: false,
	minorLeagueOccupied: MINOR_LEAGUE_SLOTS - 1,
	auctions: auctionsOf(ELIGIBLE_LOTTERIES),
	capSpace: parseMoney(40_000_000),
	// **11, not the example's 12** — see the header. At 12 Team Y could not
	// have entered these three lotteries at all, so the close would be
	// evaluated against a position the gates make unreachable.
	rosterCount: 11,
	playerNameFor: (playerId: string) => `Prospect ${playerId.replace('p-elig-', '')}`,
	drawnWinner: DRAWN_Y,
	rosterFiguresFor: () => null
};

const DECIDED = decideClose(CLOSE_STATE, LOTTERY_CLOSES, DRAWN_Y);
const CANCELLATIONS = DECIDED.events.filter((event) => event.type === BID_CANCELLED_EVENT);

function appended(seq: number, event: EventEnvelope): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt: LOTTERY_CLOSES,
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

describe('§10 example 35 — RETIRED: the close that fills an Active/Bench Slot', () => {
	it('places the win in ACTIVE/BENCH at its full Cap Hit, raising Roster Count', () => {
		// The example's premise was that nothing about Active/Bench moved. It
		// moves now: the win takes the twelfth Slot and charges the Cap.
		const closed = DECIDED.events.find((event) => event.type === AUCTION_CLOSED_EVENT);
		const payload = closed?.payload as AuctionClosedPayload | undefined;

		expect(payload?.placement).toBe('active_bench');
		expect(payload?.capHit).toBe(MINIMUM_BID);
		// The flat lottery amount, and now equal to the Cap Hit (AD-23 still
		// holds; the two fields simply agree).
		expect(payload?.winningAmount).toBe(MINIMUM_BID);
	});

	it('fires the cascade, and cancels BOTH remaining entries', () => {
		// FR-40's own guarantee, untouched: the two survivors have nowhere to
		// land, so both are stood down before their lotteries draw.
		expect(DECIDED.events.map((event) => event.type)).toEqual([
			CONTENTION_DRAWN_EVENT,
			AUCTION_CLOSED_EVENT,
			BID_CANCELLED_EVENT,
			BID_CANCELLED_EVENT
		]);

		const cancelled = CANCELLATIONS.map((event) => event.payload as BidCancelledPayload);
		// Most recent first, here as everywhere.
		expect(cancelled.map((payload) => payload.fantraxPlayerId)).toEqual(['p-elig-2', 'p-elig-1']);
		for (const payload of cancelled) {
			expect(payload.wasContentionEntry).toBe(true);
			expect(payload.teamId).toBe('t-y');
			expect(payload.amount).toBe(MINIMUM_BID);
			expect(payload.causeFantraxPlayerId).toBe('p-elig-0');
			expect(payload.restoration).toBeNull();
		}
	});

	it('WOULD now have fired on a trigger phrased as "increases Roster Count"', () => {
		// The sentence this example existed for, inverted. Roster Count moves
		// on this close — 11 before, 12 after — so the narrow phrasing FR-40
		// deliberately avoided would have fired here too. Every Auction win
		// increases Roster Count now, so no close can tell the two triggers
		// apart, and this file is where that stops being demonstrable.
		expect(CLOSE_STATE.rosterCount).toBe(11);
		const closed = DECIDED.events.find((event) => event.type === AUCTION_CLOSED_EVENT);
		expect((closed?.payload as AuctionClosedPayload).placement).toBe('active_bench');
		expect(CANCELLATIONS).toHaveLength(2);
	});

	it('cancels both even with a SPARE Minor League Slot — minors decide nothing', () => {
		// The example's counterfactual: with two free Minor League Slots the
		// old close cancelled nothing, because the survivors passed FR-18's
		// eligible branch on the Slot that was left. There is no such branch,
		// so the spare Slot changes nothing at all.
		const roomy = decideClose(
			{ ...CLOSE_STATE, minorLeagueOccupied: MINOR_LEAGUE_SLOTS - 2 },
			LOTTERY_CLOSES,
			DRAWN_Y
		);
		expect(roomy.events.map((event) => event.type)).toEqual([
			CONTENTION_DRAWN_EVENT,
			AUCTION_CLOSED_EVENT,
			BID_CANCELLED_EVENT,
			BID_CANCELLED_EVENT
		]);
	});

	it('takes Team Y out of both remaining Contender lists before either draws', () => {
		const folded = fold(
			auctionsOf(ELIGIBLE_LOTTERIES.slice(1)),
			DECIDED.events.map((event, index) => appended(400 + index, event)),
			auctionsReducer
		);
		for (const index of [1, 2]) {
			const auction = auctionForPlayer(folded, `p-elig-${String(index)}`);
			expect(
				auction?.contenders.map((contender) => contender.teamId),
				String(index)
			).toEqual(['t-other']);
			// The joining Bid is still there, marked, naming the win.
			expect(wasCancelled(auction?.bids[1] as Bid), String(index)).toBe(true);
			expect(auction?.bids[1]?.cancellation?.causePlayerName, String(index)).toBe('Prospect 0');
			// The lottery keeps running, on the clock it always had.
			expect(auction?.contention, String(index)).toBe('minimum_bid');
			expect(auction?.closesAt, String(index)).toBe(LOTTERY_CLOSES);
		}
	});
});
