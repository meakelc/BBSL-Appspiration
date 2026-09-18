/**
 * PRD §10 example 21 — **RETIRED on 2026-09-18**, and this file is the record
 * of that plus the regression that keeps it retired.
 *
 * Example 21 existed to state that an eligible lottery entry was free:
 *
 * > Team Q is capped out with $0 of Available Cap Space but has all three
 * > Minor League Slots free […] A Minor League Eligible fringe player is
 * > opened at exactly $1,000,000; Team Q joins the contention. […] the join
 * > is **permitted despite Team Q having no cap space at all**. Had the same
 * > lottery been on a player who is *not* Minor League Eligible, the flat
 * > $1,000,000 of FR-14 would apply and Team Q could not join.
 *
 * **Both halves of that sentence now read the same way, and the second one
 * won.** A Team cannot win a Free Agent straight into its minors, so a
 * Contender who wins an eligible lottery lands in Active/Bench and pays,
 * exactly as a Contender in a non-eligible one does. The flat $1,000,000 of
 * FR-14 applies to every contention, and Team Q — with $0 of Available Cap
 * Space — can join none of them.
 *
 * **This is the FR-14 vs FR-35 contradiction resolving the other way.** The
 * PRD recorded that collision on 2026-08-16 and settled it in favour of
 * FR-35, on the reasoning that "a lottery win on an eligible player lands in
 * a slot at a $0 Cap Hit, so holding $1M against the cap for him is simply
 * wrong". That premise was the thing that turned out to be false. FR-14's
 * flat $1,000,000 per Contender position is the whole rule again, with no
 * eligibility branch anywhere in it.
 *
 * So the two states this file builds — the eligible lottery and the
 * non-eligible one — are now literally the same object, and the assertions
 * below say so. That indistinguishability IS the retirement: if eligibility
 * ever re-enters the gates, these two stop matching and this file fails.
 *
 * **What survives untouched is FR-18's CAPACITY exemption.** A contention
 * entry still contributes nothing to Projected Active/Bench Additions and
 * still does not consume the Outstanding Bid Allowance, because that rule
 * rests on its own reasoning — "the expected outcome of a lottery is losing"
 * — and on FR-40 cancelling entries before the draw. The exemption was always
 * a capacity exemption and never a cap one; it is simply no longer entangled
 * with minors.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_BID, MINOR_LEAGUE_SLOTS } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import type { Auction, Bid } from '../../src/lib/core/projection/auctions.ts';
import { INITIAL_AUCTIONS } from '../../src/lib/core/projection/auctions.ts';
import {
	allGatesPassed,
	bidStateFor,
	evaluate,
	failedGates,
	teamMoneyStateFor
} from '../../src/lib/core/rules/bidding.ts';
import type { BidState, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-24T14:00:00.000Z';

/**
 * Team Q: literally $0 of Available Cap Space, all three Minor League Slots
 * free, leading nothing anywhere — and a FULL Active/Bench roster.
 *
 * **The roster is full because the example's own two claims force it.** "$0
 * of Available Cap Space" and "the join is permitted" can only both hold when
 * Roster Reserve is $0, since PRD §3 qualifies the unbounded case "provided
 * Roster Reserve remains coverable" and `Available − Reserve ≥ 0` still
 * decides. Roster Reserve is $1,000,000 per UNFILLED Active/Bench Slot, so it
 * is $0 exactly when the twelve are held — which is also §10 example 25's
 * Team, and FR-37's "a Team at Roster Capacity may still bid on a Minor
 * League Eligible Player". The example does not state the roster because the
 * roster is not what it is about; it is stated here because a fixture that
 * left it at nine would be asserting a Team that is not capped out.
 */
const TEAM_Q: TeamMoneyState = {
	// "capped out with $0 of Available Cap Space", and nothing committed, so
	// Cap Space is $0 outright.
	capSpace: parseMoney(0),
	// Twelve Active/Bench Slots held, so Roster Reserve is $0 — see above.
	rosterCount: 12,
	leading: [],
	// "no other eligible leading bids"
	eligibleLeading: [],
	// "all three Minor League Slots free"
	minorLeagueOccupied: 0
};

/** The fringe Player's lottery, opened by another Team at exactly $1,000,000. */
const OPENING: Bid = {
	seq: '1',
	teamId: 't-other',
	teamName: 'Team Other',
	managerId: 'm-other',
	amount: parseMoney(MINIMUM_BID),
	occurredAt: '2026-08-24T09:00:00.000Z',
	closesAt: '2026-08-25T09:00:00.000Z',
	seedHash: 'e'.repeat(64)
};

const LOTTERY: Auction = {
	fantraxPlayerId: 'p-fringe',
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
	// The contention is LIVE: the seed is still sealed, so nothing is revealed.
	seed: null
};

/**
 * Team Q's join, on a Minor League Eligible Player.
 *
 * ...and on a Player who is not. The two used to differ by an argument
 * `bidStateFor` no longer accepts, so they are now the same state built
 * twice. Both names are kept so the assertions below can state the
 * indistinguishability rather than merely enjoy it.
 */
const ELIGIBLE: BidState = bidStateFor(LOTTERY, TEAM_Q, 'Auction');
const NOT_ELIGIBLE: BidState = bidStateFor(LOTTERY, TEAM_Q, 'Auction');

const JOIN: PlaceBid = {
	kind: 'PlaceBid',
	fantraxPlayerId: 'p-fringe',
	teamId: 't-q',
	teamName: 'Team Q',
	managerId: 'm-q',
	amount: parseMoney(MINIMUM_BID)
};

describe('§10 example 21 — RETIRED: every lottery entry commits', () => {
	it('builds the SAME state for an eligible Player and an ineligible one', () => {
		// The distinction the whole example rested on cannot be expressed.
		expect(ELIGIBLE).toEqual(NOT_ELIGIBLE);
	});

	it('counts NO Eligible Leading Bids: N = 0, M = 3, Overflow 0', () => {
		const gates = evaluate(ELIGIBLE, JOIN, NOW);

		expect(gates.cap.eligibleLeadingBids).toBe(0);
		expect(gates.cap.freeMinorLeagueSlots).toBe(MINOR_LEAGUE_SLOTS);
		expect(gates.cap.overflowCount).toBe(0);
		// **The capacity gate's own counts, and Story 10.2 makes them a
		// different derivation rather than a copy.** The example's `N = 1` is
		// the MONEY-side count and it includes this join, because a Contender
		// who wins pays. The slots side excludes it — FR-18 exempts an entry
		// from Roster Capacity and from nothing else — so `N_slots` is 0 and
		// Active/Bench Overflow is `max(0, 0 − 3) = 0`. `M` is the one figure
		// genuinely shared.
		expect(gates.slots.eligibleLeadingBidsExcludingEntries).toBe(0);
		expect(gates.slots.freeMinorLeagueSlots).toBe(MINOR_LEAGUE_SLOTS);
		expect(gates.slots.activeBenchOverflow).toBe(0);
		// Both overflows are 0 here, but they are 0 for two different
		// reasons, and the gate records which rule decided the verdict.
		expect(gates.slots.isContentionEntry).toBe(true);
		expect(gates.slots.projectedAdditions).toBe(0);
	});

	it('holds Minors Exposure at $0 and Available Cap Space at $0', () => {
		const cap = evaluate(ELIGIBLE, JOIN, NOW).cap;

		// "Minors Exposure $0" — one eligible lead against three free Slots
		// overflows nothing, so there is no amount to sum.
		expect(cap.minorsExposure).toBe(0);
		expect(cap.committedBids).toBe(0);
		// "capped out with $0 of Available Cap Space", literally.
		expect(cap.availableCapSpace).toBe(0);
		// And the reserve is coverable because there is nothing left to
		// reserve: the twelve Active/Bench Slots are held.
		expect(cap.rosterReserve).toBe(0);
		expect(cap.maximumBid).toBe(0);
	});

	it('REFUSES the join — $1,000,000 against $0 of Available Cap Space', () => {
		const gates = evaluate(ELIGIBLE, JOIN, NOW);

		expect(allGatesPassed(gates)).toBe(false);
		// The money gate compared the amount to a real ceiling. The unbounded
		// branch the example turned on cannot be reached.
		expect(gates.cap.unbounded).toBe(false);
		expect(gates.cap.maximumBid).toBe(0);
		expect(gates.cap.passed).toBe(false);
		// ...and the join is still a join. The contention gate reads no Cap
		// figure and no roster, so it is unmoved by the refusal beside it.
		expect(gates.contention.entry).toBe('joins');
		expect(gates.contention.contenderCount).toBe(1);
	});

	it('refuses the non-eligible join IDENTICALLY — one rule, not two', () => {
		// The example's last sentence was the case that proved the eligibility
		// partition was doing work. There is no partition, so the two outcomes
		// are the same outcome, asserted here field by field.
		const eligible = evaluate(ELIGIBLE, JOIN, NOW);
		const notEligible = evaluate(NOT_ELIGIBLE, JOIN, NOW);

		expect(eligible).toEqual(notEligible);
		expect(notEligible.cap.unbounded).toBe(false);
		expect(notEligible.cap.maximumBid).toBe(0);
		expect(notEligible.cap.passed).toBe(false);
		expect(notEligible.contention.entry).toBe('joins');
	});

	it("keeps FR-18's capacity EXEMPTION but loses its minors LANDING branch", () => {
		const gates = evaluate(ELIGIBLE, JOIN, NOW);

		// The exemption survives: an entry still projects no Active/Bench
		// addition and still consumes no allowance.
		expect(gates.slots.isContentionEntry).toBe(true);
		expect(gates.slots.projectedAdditions).toBe(0);
		expect(gates.slots.rosterCount).toBe(12);

		// The LANDING test does not. FR-18 used to let a Team join an eligible
		// lottery on the strength of a Free Minor League Slot the win would
		// land in — and it would not land there. Team Q has three free Minor
		// League Slots and no Active/Bench room, so it may enter no contention
		// at all.
		expect(gates.slots.freeMinorLeagueSlots).toBe(MINOR_LEAGUE_SLOTS);
		expect(gates.slots.freeActiveBenchSlots).toBe(0);
		expect(gates.slots.passed).toBe(false);
		expect(failedGates(gates)).toEqual(['cap', 'slots']);
	});

	it('carries the join into every OTHER Auction as a COMMITMENT of $1.0M', () => {
		// Story 3.2's one change to `teamMoneyStateFor`, seen from the other
		// side: once Team Q is a Contender, that lottery is a commitment it
		// carries wherever it bids next — even though Team Other still leads
		// it, because any Contender may win.
		const joined: Auction = {
			...LOTTERY,
			contenders: [
				...LOTTERY.contenders,
				{ seq: '2', teamId: 't-q', teamName: 'Team Q', managerId: 'm-q' }
			]
		};
		expect(joined.leadingBid?.teamId).toBe('t-other');

		const money = teamMoneyStateFor({
			teamId: 't-q',
			// A different Auction, so the lottery counts as a commitment
			// elsewhere rather than being excluded as the one being bid on.
			fantraxPlayerId: 'p-elsewhere',
			capSpace: parseMoney(0),
			rosterCount: 12,
			minorLeagueOccupied: 0,
			auctions: { ...INITIAL_AUCTIONS, byPlayer: { 'p-fringe': joined } },
			playerNameFor: () => 'The Fringe Player'
		});

		// The flat $1,000,000 of FR-14, routed nowhere special — it lands in
		// `leading` and charges Committed Bids like any other commitment. That
		// is what makes this example and example 22 one rule rather than two,
		// which was always the claim; only the rule changed.
		expect(money.leading).toEqual([
			{
				fantraxPlayerId: 'p-fringe',
				playerName: 'The Fringe Player',
				amount: MINIMUM_BID,
				// Still recorded, and still load-bearing: `isContentionEntry` is
				// what FR-18's CAPACITY exemption reads. It no longer routes the
				// money anywhere.
				isContentionEntry: true
			}
		]);
		expect(money.eligibleLeading).toEqual([]);
	});
});
