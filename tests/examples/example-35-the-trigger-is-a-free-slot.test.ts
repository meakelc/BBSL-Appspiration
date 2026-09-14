/**
 * PRD §10 example 35 — **The trigger is a free slot, not a roster count**
 * (AD-25), the bidding half.
 *
 * > Team Y has Roster Count 12 (Free Active/Bench Slots 0) and one Free
 * > Minor League Slot. It is a Contender in three Minimum-Bid Contentions on
 * > **Minor League Eligible** players. All three entries are permitted under
 * > FR-18's `M ≥ 1` branch despite the Team having no Active/Bench room, and
 * > each is an Eligible Leading Bid of $1,000,000 feeding Overflow Count on
 * > the money side.
 *
 * > The first is drawn and **Team Y wins**: he takes the last Minor League
 * > Slot at a $0 Cap Hit, **Roster Count stays 12**, and `M` falls to 0. The
 * > close still fires the cascade, because it reduced a free slot — and Team
 * > Y's two remaining entries now have neither an Active/Bench slot nor a
 * > minors slot to land in, so **both are cancelled** before their lotteries
 * > draw. Had the trigger been written as *"a close that increases Roster
 * > Count"*, it would not have fired here at all.
 *
 * **This file owns the entry half and, since Story 10.3, the trigger.** The
 * first half asserts the state the close starts from — three entries held by
 * a Team with a full Active/Bench roster — and the reason that state is
 * reachable at all. The second asserts the sentence the whole trigger wording
 * exists for: a win that leaves Roster Count exactly where it found it, at a
 * `$0` Cap Hit, still fires the cascade, because what it reduced was a free
 * MINOR LEAGUE Slot. The counterfactual is stated too — the same close with a
 * spare minors Slot cancels nothing — so a trigger rephrased as "increases
 * Roster Count" fails here rather than silently letting Team Y finish at
 * Roster Count 14.
 *
 * **This is where the two overflow figures visibly disagree**, which is the
 * whole reason Story 10.2 split one derivation into two:
 *
 *   money side:  `N = 3` against `M = 1`  →  Overflow Count 2
 *   slots side:  `N = 0` against `M = 1`  →  Active/Bench Overflow 0
 *
 * Same Team, same instant, both correct. The money side counts the entries
 * because a Contender who wins pays; the slots side does not, because FR-18
 * exempts an entry from Roster Capacity. A single shared computation would
 * have to be wrong for one of them, and this file is what would catch a
 * revision that collapsed them back together.
 *
 * **The pass is on the ELIGIBLE branch, and the fixture proves it.** `P = 0`
 * here, so FR-37's zero branch would also have admitted the Bid — which is
 * exactly why the last test takes the free Minor League Slot away and shows
 * the same Bid refused. If the entry branch fell through to `P = 0` instead
 * of replacing it, that refusal would not happen.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
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
import type { BidState, LeadingBidElsewhere, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
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
		leading: [],
		eligibleLeading: Array.from({ length: held }, (_unused, index) => eligibleEntry(index + 1)),
		// "one Free Minor League Slot".
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
	contenders: [{ seq: '1', teamId: 't-other', teamName: 'Team Other', managerId: 'm-other' }],
	seedHash: OPENING.seedHash,
	seed: null
};

/** Team Y joining it while it already holds `held` others. */
function joining(held: number, minorLeagueOccupied?: number): BidState {
	return bidStateFor(LOTTERY, teamY(held, minorLeagueOccupied), true, 'Auction');
}

const JOIN: PlaceBid = {
	kind: 'PlaceBid',
	fantraxPlayerId: 'p-next',
	teamId: 't-y',
	teamName: 'Team Y',
	managerId: 'm-y',
	amount: parseMoney(MINIMUM_BID)
};

describe('§10 example 35 — an eligible entry at a full Active/Bench roster', () => {
	it('permits ALL THREE entries with no Active/Bench room at all', () => {
		// "All three entries are permitted under FR-18's `M >= 1` branch
		// despite the Team having no Active/Bench room."
		for (const held of [0, 1, 2]) {
			const gates = evaluate(joining(held), JOIN, NOW);

			expect(gates.slots.freeActiveBenchSlots, String(held)).toBe(0);
			expect(gates.slots.freeMinorLeagueSlots, String(held)).toBe(1);
			expect(gates.slots.isContentionEntry, String(held)).toBe(true);
			expect(gates.slots.passed, String(held)).toBe(true);
			expect(allGatesPassed(gates), String(held)).toBe(true);
			expect(decide(joining(held), JOIN, NOW, null).kind, String(held)).toBe('accepted');
		}
	});

	it('states the TWO overflow figures, and they disagree — 2 against 0', () => {
		// The split, at the one instant it is visible. Neither figure is
		// wrong; they answer two questions about one Team.
		const gates = evaluate(joining(2), JOIN, NOW);

		// The money side: "each is an Eligible Leading Bid of $1,000,000
		// feeding Overflow Count on the money side". `N = 3` against `M = 1`.
		expect(gates.cap.eligibleLeadingBids).toBe(3);
		expect(gates.cap.freeMinorLeagueSlots).toBe(1);
		expect(gates.cap.overflowCount).toBe(2);
		// ...and it commits real capital: the two overflowing tickets.
		expect(gates.cap.minorsExposure).toBe(2_000_000);

		// The slots side: the entries are removed, so `N_slots = 0` and the
		// Active/Bench Overflow is `max(0, 0 - 1) = 0`.
		expect(gates.slots.eligibleLeadingBidsExcludingEntries).toBe(0);
		expect(gates.slots.freeMinorLeagueSlots).toBe(1);
		expect(gates.slots.activeBenchOverflow).toBe(0);
		// Which is what keeps Projected Active/Bench Additions at zero.
		expect(gates.slots.projectedAdditions).toBe(0);

		// Stated as the inequality, so a revision that shared one derivation
		// between the two gates fails here rather than somewhere subtler.
		expect(gates.cap.overflowCount).not.toBe(gates.slots.activeBenchOverflow);
	});

	it('leaves the allowance untouched and the ceiling stated, on a PASS', () => {
		const slots = evaluate(joining(2), JOIN, NOW).slots;

		// Reported on every evaluation, pass and refusal alike — and `F = 0`
		// so the raw allowance is 1, a figure no sentence here may quote.
		expect(slots.rosterCount).toBe(12);
		expect(slots.allowance).toBe(1);
		expect(slots.ceiling).toBe(12);
		// The allowance is not what admitted this Bid: `P` never reaches it,
		// and the precondition it guards would have refused an ordinary Bid
		// from this same Team.
		expect(slots.passed).toBe(true);
	});

	it('refuses an ORDINARY bid from the same Team, which is the rule the entry escapes', () => {
		// Roster Count 12 with no free Active/Bench Slot: a bid on a
		// non-eligible Player is refused on the precondition, allowance and
		// all (§10 examples 24 and 30). The exemption is FR-18's, and it
		// reaches lottery entries only.
		const ordinary = bidStateFor(null, teamY(2), false, 'Auction');
		const gates = evaluate(ordinary, { ...JOIN, amount: parseMoney(5_000_000) }, NOW);

		expect(gates.slots.isContentionEntry).toBe(false);
		expect(gates.slots.projectedAdditions).toBe(1);
		expect(gates.slots.passed).toBe(false);
		expect(bidRefusalDetail({ kind: 'gates', gates })).toContain('no free Active/Bench Slot');
	});

	it('refuses the entry once the last Minor League Slot is gone', () => {
		// The state the close in the example's second half creates: `M` falls
		// to 0 and Team Y's remaining entries have "neither an Active/Bench
		// slot nor a minors slot to land in". Story 10.3 cancels the ones
		// already held; this is the gate refusing a NEW one, and it is what
		// proves the entry branch REPLACES FR-37's zero branch rather than
		// falling through to it — `P` is 0 in both this case and the passing
		// one above.
		const gates = evaluate(joining(2, MINOR_LEAGUE_SLOTS), JOIN, NOW);

		expect(gates.slots.freeMinorLeagueSlots).toBe(0);
		expect(gates.slots.freeActiveBenchSlots).toBe(0);
		expect(gates.slots.projectedAdditions).toBe(0);
		expect(gates.slots.passed).toBe(false);
		expect(failedGates(gates)).toEqual(['slots']);

		const detail = bidRefusalDetail({ kind: 'gates', gates });
		expect(detail).toContain('A lottery entry needs somewhere for the win to land');
		expect(detail).toContain('Roster Capacity of 12');
		// Not the allowance sentence, and not the precondition one.
		// **The ALLOWANCE FIGURE must be absent, and that is the substantive
		// constraint** — not the word "allowance", which the sentence uses
		// on purpose to say that none was spent. The only digits an entry
		// refusal may carry are the Roster Count and the ceiling, both 12
		// here; an allowance quoted anywhere would leave a stray one behind.
		expect(detail.replace(/12/g, '')).not.toMatch(/\d/);
		// And neither of the allowance refusal's two phrasings, matched
		// case-insensitively so a capitalisation cannot make the guard inert.
		expect(detail).not.toMatch(/\d+(?:st|nd|rd|th) outstanding bid/i);
		expect(detail).not.toMatch(/permits?\s+\d/i);
		// Nor the precondition sentence's opening.
		expect(detail).not.toMatch(/no free Active\/Bench Slot/i);
		// And no money figure as its ground (AD-7).
		expect(detail).not.toMatch(/\$\d/);
	});
});


// --- The close half: the trigger is a free slot ---------------------------

/** A real 64-hex seed, and the commitment DERIVED from it. */
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
	return { seq: bid.seq, teamId: bid.teamId, teamName: bid.teamName, managerId: bid.managerId };
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
	// "Minor League Eligible players" — every one of the three.
	playerIsMinorLeagueEligible: true,
	minorLeagueOccupied: MINOR_LEAGUE_SLOTS - 1,
	auctions: auctionsOf(ELIGIBLE_LOTTERIES),
	capSpace: parseMoney(40_000_000),
	// "Roster Count 12 (Free Active/Bench Slots 0)", and it stays there.
	rosterCount: 12,
	isMinorLeagueEligible: () => true,
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

describe('§10 example 35 — the close that reduces a MINORS Slot and nothing else', () => {
	it('places the win in minors at a $0 Cap Hit, leaving Roster Count where it was', () => {
		// The premise the trigger has to survive: nothing about Active/Bench
		// moved at all. A cascade keyed on Roster Count sees no change here.
		const closed = DECIDED.events.find((event) => event.type === AUCTION_CLOSED_EVENT);
		const payload = closed?.payload as AuctionClosedPayload | undefined;

		expect(payload?.placement).toBe('minor_league');
		expect(payload?.capHit).toBe(0);
		// The flat lottery amount, unchanged by the placement (AD-23).
		expect(payload?.winningAmount).toBe(MINIMUM_BID);
	});

	it('fires the cascade anyway, and cancels BOTH remaining entries', () => {
		// "The close still fires the cascade, because it reduced a free slot —
		// and Team Y's two remaining entries now have neither an Active/Bench
		// slot nor a minors slot to land in, so both are cancelled."
		expect(DECIDED.events.map((event) => event.type)).toEqual([
			CONTENTION_DRAWN_EVENT,
			AUCTION_CLOSED_EVENT,
			BID_CANCELLED_EVENT,
			BID_CANCELLED_EVENT
		]);

		const cancelled = CANCELLATIONS.map((event) => event.payload as BidCancelledPayload);
		// Most recent first, here as everywhere.
		expect(cancelled.map((payload) => payload.fantraxPlayerId)).toEqual([
			'p-elig-2',
			'p-elig-1'
		]);
		for (const payload of cancelled) {
			expect(payload.wasContentionEntry).toBe(true);
			expect(payload.teamId).toBe('t-y');
			expect(payload.amount).toBe(MINIMUM_BID);
			expect(payload.causeFantraxPlayerId).toBe('p-elig-0');
			expect(payload.restoration).toBeNull();
		}
	});

	it('would NOT have fired on a trigger phrased as "increases Roster Count"', () => {
		// Stated as the arithmetic rather than as prose: Roster Count is
		// identical on both sides of this close, and the only figure that
		// moved is the free minors count.
		expect(CLOSE_STATE.rosterCount).toBe(12);
		const closed = DECIDED.events.find((event) => event.type === AUCTION_CLOSED_EVENT);
		expect((closed?.payload as AuctionClosedPayload).placement).toBe('minor_league');
		expect(CANCELLATIONS).toHaveLength(2);
	});

	it('cancels NOTHING when a minors Slot is still free afterwards', () => {
		// The counterfactual that keeps the trigger from being a reflex: with
		// two free Minor League Slots the win takes `M` from 2 to 1, which IS
		// a reduction and does fire the cascade — and both survivors then pass
		// FR-18's eligible branch on the Slot that is left.
		const roomy = decideClose(
			{ ...CLOSE_STATE, minorLeagueOccupied: MINOR_LEAGUE_SLOTS - 2 },
			LOTTERY_CLOSES,
			DRAWN_Y
		);
		expect(roomy.events.map((event) => event.type)).toEqual([
			CONTENTION_DRAWN_EVENT,
			AUCTION_CLOSED_EVENT
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
			expect(auction?.contenders.map((contender) => contender.teamId), String(index)).toEqual([
				't-other'
			]);
			// The joining Bid is still there, marked, naming the win.
			expect(wasCancelled(auction?.bids[1] as Bid), String(index)).toBe(true);
			expect(auction?.bids[1]?.cancellation?.causePlayerName, String(index)).toBe('Prospect 0');
			// The lottery keeps running, on the clock it always had.
			expect(auction?.contention, String(index)).toBe('minimum_bid');
			expect(auction?.closesAt, String(index)).toBe(LOTTERY_CLOSES);
		}
	});
});
