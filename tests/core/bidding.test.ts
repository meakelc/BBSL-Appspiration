/**
 * The bidding gate: `evaluate()`, `decide()`, and the one sentence each
 * refusal has (Story 2.5).
 *
 * Every test here calls the pure core directly against a state literal — no
 * database, no HTTP, no clock mocking (AD-25's discipline, applied to the
 * whole gate rather than only to the §10 examples in `tests/examples/`).
 */

import { describe, expect, it } from 'vitest';

import {
	ACTIVE_BENCH_SLOTS,
	AUCTION_CLOCK,
	MINIMUM_BID,
	MINIMUM_INCREMENT,
	MINOR_LEAGUE_SLOTS,
	SALARY_CAP
} from '../../src/lib/core/constants.ts';
import {
	AUCTION_EXPIRED,
	BID_PLACED_EVENT,
	contentionForAmount
} from '../../src/lib/core/projection/auctions.ts';
import type { Auction, Bid, Contender } from '../../src/lib/core/projection/auctions.ts';
import { hash } from '../../src/lib/core/hash.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	BID_CONSEQUENCE,
	BID_READY,
	allGatesPassed,
	bidConsequenceSentence,
	bidControlState,
	bidGateReport,
	bidRefusalDelta,
	bidRefusalDetail,
	bidStateFor,
	capBreakdown,
	decide,
	describeAmount,
	evaluate,
	failedGates,
	figuresAtCaption,
	minimumLegalBid,
	minimumLegalSentence,
	REFUSAL_HEADLINE,
	REFUSAL_REASSURANCE,
	teamMoneyStateFor,
	readBidAmount
} from '../../src/lib/core/rules/bidding.ts';
import type {
	BidPlacedPayload,
	BidState,
	TeamMoneyState
} from '../../src/lib/core/rules/bidding.ts';
import { PLACE_BID_GATES } from '../../src/lib/core/types.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

/**
 * A Team the money gate cannot be the reason for anything here.
 *
 * Story 2.6 added `cap` to `PLACE_BID_GATES`, and every state literal in this
 * file must now say something about money whether or not the example is about
 * money. This one says "not the constraint": the full Salary Cap, nothing
 * committed, and a roster with room — so a refusal in this file is always the
 * gate the example is actually about. §10 examples 3, 4, 5 and 23 are where
 * the money arithmetic is exercised on purpose.
 */
const RICH: TeamMoneyState = {
	capSpace: parseMoney(SALARY_CAP),
	rosterCount: 9,
	leading: [],
	// Story 2.8: no eligible leads and no occupied Minor League
	// Slots, so `N` is the bid alone and `M` is the full three.
	eligibleLeading: [],
	minorLeagueOccupied: 0
};

const NOW = '2026-08-26T09:00:00.000Z';

/**
 * A seed, as `server/bidding.ts` would generate one — 32 bytes of hex.
 *
 * Handed to `decide()` wherever a Bid could open a Minimum-Bid Contention,
 * because a `null` seed on such an opening is a shell bug and THROWS rather
 * than refusing (AD-1). Its VALUE is never asserted: what reaches the payload
 * is `hash(seed)`, and the raw string must never appear in an event.
 */
const SEED = 'a3f19c0d5b7e2481a3f19c0d5b7e2481a3f19c0d5b7e2481a3f19c0d5b7e2481';

/** One leading Bid, as `auctionsReducer` would have folded it. */
function leading(amount: number, teamId = 't-1'): Bid {
	return {
		seq: '2',
		teamId,
		teamName: teamId === 't-1' ? 'Lakers' : 'Rockets',
		managerId: 'm-1',
		amount: parseMoney(amount),
		occurredAt: '2026-08-26T08:00:00.000Z',
		closesAt: '2026-08-27T08:00:00.000Z',
		// Story 3.2: the commit half of AD-14, present only on the Bid that
		// opened a Minimum-Bid Contention. Every fixture here folds an
		// ordinary Bid, so it is null.
		seedHash: null
	};
}

/**
 * The Contenders a list of Bids yields, as `auctionsReducer` derives them —
 * exactly `MINIMUM_BID`, in `seq` order, one per Team.
 *
 * Written out here rather than imported because the reducer's own derivation
 * is private to the fold; `tests/projection-auctions.test.ts` is what proves
 * the two agree, and a fixture that called the fold would be testing the
 * production of the state rather than the gate that reads it.
 */
function contendersOf(bids: readonly Bid[]): readonly Contender[] {
	const seen = new Set<string>();
	const contenders: Contender[] = [];
	for (const bid of bids) {
		if (Number(bid.amount) !== MINIMUM_BID) continue;
		if (seen.has(bid.teamId)) continue;
		seen.add(bid.teamId);
		contenders.push({ seq: bid.seq, teamId: bid.teamId, teamName: bid.teamName });
	}
	return contenders;
}

/**
 * An Auction at `amount`, held by `teamId`.
 *
 * **The contention state is DERIVED from the amount, never asserted by the
 * fixture** — through `contentionForAmount`, the same expression
 * `auctionsReducer` folds with. Before Story 3.2 this helper hard-coded
 * `'standard'`, which was harmless while `$1,000,000` could not be a leading
 * amount and became a lie the moment it could: `standardAt(MINIMUM_BID)` is a
 * Minimum-Bid Contention, and a fixture claiming otherwise would exercise a
 * state the fold cannot produce.
 */
function standardAt(amount: number, teamId = 't-1'): BidState {
	const bid = leading(amount, teamId);
	const auction: Auction = {
		fantraxPlayerId: 'p-1',
		contention: contentionForAmount(bid.amount),
		leadingBid: bid,
		closesAt: bid.closesAt,
		bids: [bid],
		contenders: contendersOf([bid]),
		seedHash: null
	};
	// Narrowed through the core's own bridge, so these fixtures exercise the
	// same path `server/bidding.ts` and `server/auction-page.ts` take.
	return bidStateFor(auction, RICH, false);
}

/**
 * A live Minimum-Bid Contention: opened by `t-1` at exactly $1,000,000, then
 * joined by each Team named, in the order given.
 *
 * Every join carries the OPENER's `closesAt`, which is what `decide()` stamps
 * onto a join's payload — so this fixture is the log a real contention
 * produces rather than a shape invented to make an assertion pass. The lead
 * never moves: a join is not strictly higher than the amount already leading.
 */
function contentionWith(joiners: readonly string[] = []): BidState {
	const opener: Bid = {
		seq: '2',
		teamId: 't-1',
		teamName: 'Lakers',
		managerId: 'm-1',
		amount: parseMoney(MINIMUM_BID),
		occurredAt: '2026-08-26T08:00:00.000Z',
		closesAt: '2026-08-27T08:00:00.000Z',
		// The published commitment rides the opening Bid and nothing else.
		seedHash: 'f'.repeat(64)
	};
	const bids: Bid[] = [opener];
	joiners.forEach((teamId, index) => {
		bids.push({
			...opener,
			seq: String(3 + index),
			teamId,
			teamName: teamId,
			managerId: `m-${teamId}`,
			// Its OWN instant, later than the opener's — and the opener's close
			// instant, unchanged, which is the whole of the fixed clock.
			occurredAt: '2026-08-26T14:00:00.000Z',
			seedHash: null
		});
	});
	const auction: Auction = {
		fantraxPlayerId: 'p-1',
		contention: 'minimum_bid',
		leadingBid: opener,
		closesAt: opener.closesAt,
		bids,
		contenders: contendersOf(bids),
		seedHash: opener.seedHash
	};
	return bidStateFor(auction, RICH, false);
}

/** A nominated Player nobody has bid on. */
const NO_BIDS: BidState = bidStateFor(null, RICH, false);

function command(amount: number, teamId = 't-2'): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId: 'p-1',
		teamId,
		teamName: teamId === 't-1' ? 'Lakers' : 'Rockets',
		managerId: teamId === 't-1' ? 'm-1' : 'm-2',
		amount: parseMoney(amount)
	};
}

// --- AC1: the shape of the two entry points --------------------------------

describe('evaluate — total, and the gate set is fixed per command type (AC1)', () => {
	it('declares exactly eight gates for PlaceBid, in one place and in one order', () => {
		// Four in Story 2.5, five in 2.6, six in 2.7, seven in 3.1, eight in
		// 3.2. The list is asserted literally rather than by length so ADDING
		// a gate is a deliberate edit here as well as in `core/types.ts` —
		// which is the whole point of it living in one place.
		//
		// The ORDER is asserted too, and this is the one place it is
		// recorded. `allGatesPassed`, `failedGates`, `bidRefusalDelta` and
		// `bidGateReport` all iterate this list, so it is the order a Manager
		// reads the refusal panel in — `expiry` is first because a clock that
		// has run out is the frame every other question sits inside, and
		// `contention` sits immediately after `opening` because the two are
		// one reading: what an amount means when nothing leads, and what it
		// means once a lottery is running.
		expect([...PLACE_BID_GATES]).toEqual([
			'expiry',
			'opening',
			'contention',
			'selfBid',
			'increment',
			'granularity',
			'cap',
			'slots'
		]);
	});

	it('returns EVERY declared gate in every state, passing and failing alike', () => {
		const states: Array<[label: string, state: BidState, amount: number]> = [
			['no bids, legal opening', NO_BIDS, 1_500_000],
			['no bids, refused opening', NO_BIDS, 1_000_000],
			['standard, legal raise', standardAt(8_000_000), 8_500_000],
			['standard, refused on both grounds', standardAt(8_000_000), 8_400_000],
			['self-bid', standardAt(8_000_000, 't-2'), 8_500_000]
		];
		for (const [label, state, amount] of states) {
			const gates = evaluate(state, command(amount), NOW);
			expect(Object.keys(gates).sort(), label).toEqual([...PLACE_BID_GATES].sort());
			for (const gate of PLACE_BID_GATES) {
				expect(typeof gates[gate].passed, `${label} / ${gate}`).toBe('boolean');
			}
		}
	});

	it('carries an identical gate set whether the Bid is accepted or refused', () => {
		const accepted = evaluate(standardAt(8_000_000), command(8_500_000), NOW);
		const refused = evaluate(standardAt(8_000_000), command(8_400_000), NOW);
		expect(allGatesPassed(accepted)).toBe(true);
		expect(allGatesPassed(refused)).toBe(false);
		expect(Object.keys(accepted).sort()).toEqual(Object.keys(refused).sort());
	});

	it('never throws, for any amount, in any state', () => {
		for (const amount of [0, 1, 1_000_000, 8_400_000, Number.MAX_SAFE_INTEGER]) {
			for (const state of [NO_BIDS, standardAt(8_000_000), standardAt(1_000_000)]) {
				expect(() => evaluate(state, command(amount), NOW)).not.toThrow();
				// Including with a `now` no clock would ever produce: the four
				// gates do not read it, and totality must not depend on it.
				expect(() => evaluate(state, command(amount), '')).not.toThrow();
			}
		}
	});

	it('is deterministic — the same state and command always give the same gates', () => {
		const once = evaluate(standardAt(8_000_000), command(8_400_000), NOW);
		expect(evaluate(standardAt(8_000_000), command(8_400_000), NOW)).toEqual(once);
	});

	it('reports failed gates in PLACE_BID_GATES order, never in object-key order', () => {
		const gates = evaluate(standardAt(8_000_000), command(8_400_000), NOW);
		expect(failedGates(gates)).toEqual(['increment', 'granularity']);
	});
});

describe('decide — reaches its outcome only by calling evaluate (AC1)', () => {
	it('accepts exactly when evaluate says every gate passed, and refuses exactly when it does not', () => {
		const cases: Array<[state: BidState, amount: number, teamId: string]> = [
			[NO_BIDS, 1_500_000, 't-2'],
			[NO_BIDS, 1_000_000, 't-2'],
			[NO_BIDS, 500_000, 't-2'],
			[standardAt(8_000_000), 8_500_000, 't-2'],
			[standardAt(8_000_000), 8_400_000, 't-2'],
			[standardAt(8_000_000), 8_000_000, 't-2'],
			[standardAt(8_000_000, 't-2'), 8_500_000, 't-2'],
			[standardAt(1_000_000), 1_000_001, 't-2'],
			// Story 3.2: a join, and a join by a Team already in.
			[standardAt(1_000_000), 1_000_000, 't-2'],
			[standardAt(1_000_000, 't-2'), 1_000_000, 't-2'],
			[standardAt(1_000_000), 2_000_000, 't-2']
		];
		for (const [state, amount, teamId] of cases) {
			const gates = evaluate(state, command(amount, teamId), NOW);
			// A seed is supplied for every case, because one of them opens a
			// contention and a `null` seed there is a shell bug that throws
			// rather than a refusal (AD-1). The seed is ignored by every
			// other case.
			const decided = decide(state, command(amount, teamId), NOW, SEED);
			expect(decided.kind, `${String(amount)} / ${teamId}`).toBe(
				allGatesPassed(gates) ? 'accepted' : 'rejected'
			);
			if (decided.kind === 'rejected') {
				// The SAME gate set `evaluate()` returned, not a re-derivation.
				expect(decided.gates).toEqual(gates);
			}
		}
	});

	it('returns a Rejected value rather than throwing on a violation (AD-1)', () => {
		expect(() => decide(standardAt(8_000_000), command(8_400_000), NOW, null)).not.toThrow();
	});

	it('reports EVERY gate on a refusal, not only the first that failed', () => {
		const decided = decide(standardAt(8_000_000), command(8_400_000), NOW, null);
		expect(decided.kind).toBe('rejected');
		if (decided.kind !== 'rejected') return;
		expect(Object.keys(decided.gates).sort()).toEqual([...PLACE_BID_GATES].sort());
		expect(decided.gates.opening.passed).toBe(true);
		expect(decided.gates.selfBid.passed).toBe(true);
	});

	it('ignores the seed entirely — a PlaceBid has no randomness in it', () => {
		const a = decide(standardAt(8_000_000), command(8_500_000), NOW, null);
		const b = decide(standardAt(8_000_000), command(8_500_000), NOW, 'a-seed');
		expect(a).toEqual(b);
	});
});

// --- AC4: the event, and the close instant ---------------------------------

describe('decide — the one BidPlaced it emits (AC4)', () => {
	it('emits exactly one event, naming the Team and the acting Manager', () => {
		const decided = decide(standardAt(8_000_000), command(8_500_000), NOW, null);
		expect(decided.kind).toBe('accepted');
		if (decided.kind !== 'accepted') return;
		expect(decided.events).toHaveLength(1);
		const event = decided.events[0];
		expect(event?.type).toBe(BID_PLACED_EVENT);
		expect(event?.type).toBe('BidPlaced');
		expect(event?.managerId).toBe('m-2');
		expect(event?.teamId).toBe('t-2');
	});

	it('carries Team, Manager, amount and the absolute close instant on the payload', () => {
		const decided = decide(standardAt(8_000_000), command(8_500_000), NOW, null);
		if (decided.kind !== 'accepted') throw new Error('expected acceptance');
		expect(decided.events[0]?.payload).toEqual({
			fantraxPlayerId: 'p-1',
			teamId: 't-2',
			teamName: 'Rockets',
			managerId: 'm-2',
			amount: 8_500_000,
			// Exactly AUCTION_CLOCK after `now`, which is the same instant the
			// shell stamps as the event's own `occurredAt`.
			closesAt: '2026-08-27T09:00:00.000Z'
		} satisfies BidPlacedPayload);
	});

	it('sets the close to exactly AUCTION_CLOCK after the Bid, never a duration', () => {
		const decided = decide(standardAt(8_000_000), command(8_500_000), NOW, null);
		if (decided.kind !== 'accepted') throw new Error('expected acceptance');
		const payload = decided.events[0]?.payload as BidPlacedPayload;
		expect(Date.parse(payload.closesAt) - Date.parse(NOW)).toBe(AUCTION_CLOCK);
		// An absolute instant, not "seconds remaining" (AD-3).
		expect(payload.closesAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it('stamps no occurredAt and no deviceClass of its own — those are the shell’s', () => {
		const decided = decide(standardAt(8_000_000), command(8_500_000), NOW, null);
		if (decided.kind !== 'accepted') throw new Error('expected acceptance');
		expect(Object.keys(decided.events[0] ?? {}).sort()).toEqual([
			'managerId',
			'payload',
			'teamId',
			'type'
		]);
	});

	it('throws rather than refusing when `now` is not an instant — that is a shell bug, not a rule', () => {
		expect(() => decide(standardAt(8_000_000), command(8_500_000), 'nonsense', null)).toThrow(
			TypeError
		);
	});

	// --- Story 3.2: the seed, and the clock a join must not move ------------

	it('publishes hash(seed) on the Bid that OPENS a contention, and the seed itself nowhere', () => {
		const decided = decide(NO_BIDS, command(MINIMUM_BID), NOW, SEED);
		if (decided.kind !== 'accepted') throw new Error('expected acceptance');
		const payload = decided.events[0]?.payload as BidPlacedPayload;

		expect(payload.seedHash).toBe(hash(SEED));
		expect(payload.seedHash).toMatch(/^[0-9a-f]{64}$/);
		// **The raw seed is in no part of the event, at any depth.** This is
		// the assertion AD-14 lives or dies on: the whole commit-reveal fails
		// completely if the seed is readable before the draw.
		expect(JSON.stringify(decided.events)).not.toContain(SEED);
	});

	it('publishes NOTHING about a seed on a raise or on an ordinary opening', () => {
		for (const [label, state, amount] of [
			['a raise', standardAt(8_000_000), 8_500_000],
			['an opening above the minimum', NO_BIDS, 1_500_000],
			['a join', contentionWith(['t-3']), MINIMUM_BID]
		] as const) {
			const decided = decide(state, command(amount, 't-2'), NOW, SEED);
			if (decided.kind !== 'accepted') throw new Error(`expected acceptance: ${label}`);
			const payload = decided.events[0]?.payload as BidPlacedPayload;
			// Absent, not null: the overwhelming majority of Bids have no
			// commitment to make, and a key claiming an absence is not the
			// same as no key.
			expect(Object.keys(payload), label).not.toContain('seedHash');
			expect(JSON.stringify(decided.events), label).not.toContain(SEED);
		}
	});

	it('THROWS when an opening that starts a contention arrives with no seed (AD-1)', () => {
		// A shell that failed to supply a seed is a bug, not something a
		// Manager did — so it is a throw rather than a Manager-facing refusal,
		// which would send them away to fix something that is not theirs.
		expect(() => decide(NO_BIDS, command(MINIMUM_BID), NOW, null)).toThrow(TypeError);
		// ...and every other Bid ignores the parameter entirely, so a caller
		// with genuinely no randomness in hand is unaffected.
		expect(() => decide(NO_BIDS, command(1_500_000), NOW, null)).not.toThrow();
		expect(() => decide(standardAt(8_000_000), command(8_500_000), NOW, null)).not.toThrow();
		expect(() => decide(contentionWith(['t-3']), command(MINIMUM_BID, 't-2'), NOW, null)).not.toThrow();
	});

	it('stamps the contention’s EXISTING close instant on a join, never a fresh one', () => {
		// **The fixed clock, on the persisted payload.** The fold also happens
		// to preserve `closesAt` — a join is never strictly higher, so it never
		// becomes the leading Bid — but that rests on an unrelated invariant.
		// A payload claiming a join closes 24 hours after ITSELF is a lie
		// Story 3.5's sweep would act on, because the sweep reads persisted
		// instants and nothing else (AD-12).
		const state = contentionWith(['t-3']);
		const joinedAt = '2026-08-26T20:00:00.000Z';
		const decided = decide(state, command(MINIMUM_BID, 't-2'), joinedAt, SEED);
		if (decided.kind !== 'accepted') throw new Error('expected acceptance');
		const payload = decided.events[0]?.payload as BidPlacedPayload;

		expect(payload.closesAt).toBe(state.closesAt);
		expect(payload.closesAt).toBe('2026-08-27T08:00:00.000Z');
		// And it is emphatically NOT 24 hours from the join.
		expect(Date.parse(payload.closesAt) - Date.parse(joinedAt)).not.toBe(AUCTION_CLOCK);
	});

	it('computes a FRESH close for an opening and for a raise, which is the 24-hour restart', () => {
		for (const [label, state, amount] of [
			['an opening', NO_BIDS, MINIMUM_BID],
			['a raise', standardAt(8_000_000), 8_500_000]
		] as const) {
			const decided = decide(state, command(amount, 't-2'), NOW, SEED);
			if (decided.kind !== 'accepted') throw new Error(`expected acceptance: ${label}`);
			const payload = decided.events[0]?.payload as BidPlacedPayload;
			expect(Date.parse(payload.closesAt) - Date.parse(NOW), label).toBe(AUCTION_CLOCK);
		}
	});

	it('gives every Bid in one contention the SAME persisted close instant', () => {
		// Three joins at three different instants, each stamping the opener's
		// close. The log therefore states one close per contention, which is
		// what makes it honest on its own terms.
		const closes = new Set<string>();
		let state = contentionWith([]);
		for (const [index, joinedAt] of [
			'2026-08-26T14:00:00.000Z',
			'2026-08-26T20:00:00.000Z',
			'2026-08-27T07:55:00.000Z'
		].entries()) {
			const decided = decide(state, command(MINIMUM_BID, `t-${String(index + 2)}`), joinedAt, SEED);
			if (decided.kind !== 'accepted') throw new Error(`expected acceptance at ${joinedAt}`);
			closes.add((decided.events[0]?.payload as BidPlacedPayload).closesAt);
			state = contentionWith(['t-2', 't-3', 't-4'].slice(0, index + 1));
		}
		expect([...closes]).toEqual(['2026-08-27T08:00:00.000Z']);
	});
});

// --- AC2 / AC3: the four gates individually --------------------------------

describe('the opening gate', () => {
	it('passes an Opening Bid above the minimum, and calls it Standard Contention', () => {
		const gates = evaluate(NO_BIDS, command(1_500_000), NOW);
		expect(gates.opening).toEqual({
			passed: true,
			opening: 'above_the_minimum',
			offered: 1_500_000,
			minimumOpening: MINIMUM_BID
		});
	});

	it('PASSES an Opening Bid of exactly $1,000,000, which opens a lottery (Story 3.2)', () => {
		const gates = evaluate(NO_BIDS, command(MINIMUM_BID), NOW);
		expect(gates.opening.passed).toBe(true);
		// The case still NAMES itself, so the panel's figure says which of the
		// four this was and a later story that had to refuse it again would
		// have the branch to do it in.
		expect(gates.opening.opening).toBe('at_the_minimum');
		// Nothing else refuses it either: $1,000,000 is on the grid, there is
		// no high to clear, no Team leads, and `contention` has nothing to
		// decide because the lottery does not exist until this Bid lands.
		expect(failedGates(gates)).toEqual([]);
		expect(gates.contention.entry).toBe('not_a_contention');
	});

	it('refuses an Opening Bid below the minimum, and nothing else refuses it', () => {
		const gates = evaluate(NO_BIDS, command(500_000), NOW);
		expect(gates.opening.opening).toBe('below_the_minimum');
		expect(failedGates(gates)).toEqual(['opening']);
	});

	it('has nothing to decide once a Bid leads, and says so', () => {
		const gates = evaluate(standardAt(8_000_000), command(8_500_000), NOW);
		expect(gates.opening).toEqual({
			passed: true,
			opening: 'not_an_opening',
			offered: 8_500_000,
			minimumOpening: MINIMUM_BID
		});
	});
});

// --- Story 3.2: the contention gate ---------------------------------------

describe('the contention gate — every amount question inside a lottery', () => {
	it('has nothing to decide outside a lottery, and reports zero Contenders', () => {
		for (const [label, state] of [
			['awaiting an opening', NO_BIDS],
			['standard contention', standardAt(8_000_000)]
		] as const) {
			const outcome = evaluate(state, command(8_500_000), NOW).contention;
			expect(outcome, label).toEqual({
				passed: true,
				entry: 'not_a_contention',
				offered: 8_500_000,
				joinAmount: MINIMUM_BID,
				conversionAmount: MINIMUM_BID + MINIMUM_INCREMENT,
				// Zero because there are none, not because the figure is
				// unknown: this gate always states its count.
				contenderCount: 0
			});
		}
	});

	it('classifies every amount in a live contention, and the table IS the rule', () => {
		// One state, six amounts, three named outcomes. The thresholds are the
		// same two figures on every row, which is what makes this a
		// classification rather than six independent comparisons.
		const state = contentionWith(['t-3', 't-4']);
		const cases: Array<[amount: number, entry: string, passed: boolean]> = [
			[MINIMUM_BID, 'joins', true],
			[1_200_000, 'neither', false],
			[1_499_999, 'neither', false],
			[MINIMUM_BID + MINIMUM_INCREMENT, 'converts', false],
			[2_000_000, 'converts', false],
			[40_000_000, 'converts', false]
		];
		for (const [amount, entry, passed] of cases) {
			const outcome = evaluate(state, command(amount, 't-2'), NOW).contention;
			expect(outcome.entry, String(amount)).toBe(entry);
			expect(outcome.passed, String(amount)).toBe(passed);
			expect(outcome.joinAmount, String(amount)).toBe(MINIMUM_BID);
			expect(outcome.conversionAmount, String(amount)).toBe(MINIMUM_BID + MINIMUM_INCREMENT);
			// Three Contenders — the opener and the two joiners — and the
			// count is the one BEFORE this Bid, because that is what the gate
			// was decided against.
			expect(outcome.contenderCount, String(amount)).toBe(3);
		}
	});

	it('refuses a second join from a Team already on the list, on contention ALONE', () => {
		// `t-3` joined but never led, so no other gate has anything to say.
		const gates = evaluate(contentionWith(['t-3']), command(MINIMUM_BID, 't-3'), NOW);
		expect(gates.contention.entry).toBe('already_contending');
		expect(failedGates(gates)).toEqual(['contention']);
		// The other seven report their own arithmetic, unsuppressed.
		expect(gates.expiry.passed).toBe(true);
		expect(gates.opening.passed).toBe(true);
		expect(gates.selfBid.passed).toBe(true);
		expect(gates.increment.passed).toBe(true);
		expect(gates.granularity.passed).toBe(true);
		expect(gates.cap.passed).toBe(true);
		expect(gates.slots.passed).toBe(true);
	});

	it('refuses the OPENER re-bidding on BOTH selfBid and contention, neither suppressed', () => {
		// Two true grounds. AD-1 forbids short-circuiting, so both are
		// reported, in `PLACE_BID_GATES` order — `contention` before
		// `selfBid`, because the lottery's answer is the frame the ordinary
		// auction's sits inside.
		const gates = evaluate(contentionWith(['t-3']), command(MINIMUM_BID, 't-1'), NOW);
		expect(failedGates(gates)).toEqual(['contention', 'selfBid']);
		expect(gates.contention.entry).toBe('already_contending');
		expect(gates.selfBid.leadingTeamId).toBe('t-1');

		const detail = bidRefusalDetail({ kind: 'gates', gates });
		expect(detail).toContain('already a Contender');
		expect(detail).toContain('does not bid against itself');
		expect(detail.indexOf('already a Contender')).toBeLessThan(
			detail.indexOf('does not bid against itself')
		);
	});

	it('names the conversion as deferred rather than accepting it as a raise', () => {
		const gates = evaluate(contentionWith(['t-3']), command(2_000_000, 't-2'), NOW);
		expect(failedGates(gates)).toEqual(['contention']);
		const detail = bidRefusalDetail({ kind: 'gates', gates });
		expect(detail).toContain('convert');
		expect(detail).toContain('cannot do that yet');
		// The commitments it would have released are named, because that is
		// what makes the refusal honest rather than an arbitrary ceiling.
		expect(detail).toContain("Contender's commitment");
	});

	it('matches on the Team and never on the Manager — a co-managed Team is one Contender', () => {
		const state = contentionWith(['t-3']);
		const second = { ...command(MINIMUM_BID, 't-3'), managerId: 'a-different-manager' };
		expect(evaluate(state, second, NOW).contention.entry).toBe('already_contending');
	});

	it('carries no close instant, no Cap figure and no roster count on its shape', () => {
		const outcome = evaluate(contentionWith(['t-3']), command(2_000_000, 't-2'), NOW).contention;
		// Exactly six keys, and the three money-shaped ones are the gate's own
		// two thresholds and the amount it was handed.
		expect(Object.keys(outcome).sort()).toEqual([
			'contenderCount',
			'conversionAmount',
			'entry',
			'joinAmount',
			'offered',
			'passed'
		]);
	});

	it('is unmoved by how much money the Team has, and by what time it is', () => {
		const poor: TeamMoneyState = {
			capSpace: parseMoney(0),
			rosterCount: 9,
			leading: [],
			eligibleLeading: [],
			minorLeagueOccupied: 0
		};
		const broke: BidState = { ...contentionWith(['t-3']), team: poor };
		for (const now of ['', NOW, '2099-01-01T00:00:00.000Z']) {
			expect(evaluate(broke, command(MINIMUM_BID, 't-2'), now).contention.entry, now).toBe(
				'joins'
			);
		}
	});
});

describe('the dead zone — PRD §10 example 10, as two grounds together', () => {
	it('refuses $1,200,000 on contention AND granularity, and increment PASSES with nulls', () => {
		const gates = evaluate(contentionWith([]), command(1_200_000, 't-2'), NOW);

		expect(failedGates(gates)).toEqual(['contention', 'granularity']);
		expect(gates.contention.entry).toBe('neither');
		// The increment rule does not apply in a lottery, and it says so with
		// both figures null rather than inventing a raise over a high that is
		// not functioning as one.
		expect(gates.increment).toEqual({
			passed: true,
			offered: 1_200_000,
			currentHigh: null,
			minimumLegal: null
		});
	});

	it('contains no on-grid amount at all, which is why granularity always joins in', () => {
		// "between $1,000,000 (join) and $1,500,000 (convert) there is no whole
		// multiple of $500,000". Asserted over the whole open interval rather
		// than sampled, because it is a claim about the constants.
		for (let amount = MINIMUM_BID + 1; amount < MINIMUM_BID + MINIMUM_INCREMENT; amount += 1) {
			if (amount % MINIMUM_INCREMENT === 0) {
				throw new Error(`the dead zone contains an on-grid amount: ${String(amount)}`);
			}
		}
		expect(failedGates(evaluate(contentionWith([]), command(1_400_000, 't-2'), NOW))).toEqual([
			'contention',
			'granularity'
		]);
	});
});

describe('the increment gate steps aside in a lottery, and granularity does not', () => {
	it('reports no rule applies for EVERY amount in a Minimum-Bid Contention', () => {
		const state = contentionWith(['t-3']);
		for (const amount of [MINIMUM_BID, 1_200_000, 2_000_000, 40_000_000]) {
			const increment = evaluate(state, command(amount, 't-2'), NOW).increment;
			expect(increment.passed, String(amount)).toBe(true);
			expect(increment.currentHigh, String(amount)).toBeNull();
			expect(increment.minimumLegal, String(amount)).toBeNull();
		}
	});

	it('still reads the amount and nothing else for granularity', () => {
		const state = contentionWith(['t-3']);
		expect(evaluate(state, command(1_000_001, 't-2'), NOW).granularity.passed).toBe(false);
		expect(evaluate(state, command(MINIMUM_BID, 't-2'), NOW).granularity.passed).toBe(true);
	});
});

describe('the contention chip and its figure', () => {
	const rowFor = (gates: ReturnType<typeof evaluate>) =>
		bidGateReport(gates).find((row) => row.gate === 'contention');

	it('is labelled with the glossary term, so it cannot be read as another gate', () => {
		const row = rowFor(evaluate(contentionWith(['t-3']), command(MINIMUM_BID, 't-3'), NOW));
		expect(row?.chip).toBe('Minimum-Bid Contention · Refused');
		expect(row?.label).toBe('Minimum-Bid Contention');
	});

	it('carries a figure in every entry, passing and refused alike', () => {
		const rows = [
			rowFor(evaluate(standardAt(8_000_000), command(8_500_000, 't-2'), NOW)),
			rowFor(evaluate(contentionWith(['t-3']), command(MINIMUM_BID, 't-2'), NOW)),
			rowFor(evaluate(contentionWith(['t-3']), command(MINIMUM_BID, 't-3'), NOW)),
			rowFor(evaluate(contentionWith(['t-3']), command(2_000_000, 't-2'), NOW)),
			rowFor(evaluate(contentionWith(['t-3']), command(1_200_000, 't-2'), NOW))
		];
		for (const row of rows) {
			expect(row?.figure.length).toBeGreaterThan(0);
			expect(row?.figure).not.toContain('reported without a figure');
		}
		expect(rows[0]?.figure).toBe('no Minimum-Bid Contention is running');
		expect(rows[2]?.figure).toContain('already a Contender');
		expect(rows[2]?.figure).toContain('2 Contenders');
	});

	it('quotes no Cap figure and no roster count in its sentence', () => {
		const detail = bidRefusalDelta({
			kind: 'gates',
			gates: evaluate(contentionWith(['t-3']), command(MINIMUM_BID, 't-3'), NOW)
		});
		expect(detail).not.toContain('Maximum Bid');
		expect(detail).not.toContain('Roster');
		expect(detail).not.toContain('Cap Space');
	});
});

describe('the self-bid gate', () => {
	it('refuses the Team that already leads, whichever of its Managers acts', () => {
		const gates = evaluate(standardAt(8_000_000, 't-2'), command(8_500_000, 't-2'), NOW);
		expect(gates.selfBid).toEqual({ passed: false, actingTeamId: 't-2', leadingTeamId: 't-2' });
		// Matched on the Team, never the Manager: a co-managed Team is one
		// bidder, so the second Manager is refused exactly as the first is.
		const other = evaluate(
			standardAt(8_000_000, 't-2'),
			{ ...command(8_500_000, 't-2'), managerId: 'm-99' },
			NOW
		);
		expect(other.selfBid.passed).toBe(false);
	});

	it('passes another Team, and passes when nothing leads', () => {
		expect(evaluate(standardAt(8_000_000, 't-1'), command(8_500_000, 't-2'), NOW).selfBid).toEqual({
			passed: true,
			actingTeamId: 't-2',
			leadingTeamId: 't-1'
		});
		expect(evaluate(NO_BIDS, command(1_500_000), NOW).selfBid.leadingTeamId).toBeNull();
	});
});

describe('the increment gate', () => {
	it('passes exactly one increment over the high, and states the arithmetic', () => {
		const gates = evaluate(standardAt(8_000_000), command(8_500_000), NOW);
		expect(gates.increment).toEqual({
			passed: true,
			offered: 8_500_000,
			currentHigh: 8_000_000,
			minimumLegal: 8_500_000
		});
	});

	it('refuses a Bid AT the current high, and one below it', () => {
		expect(evaluate(standardAt(8_000_000), command(8_000_000), NOW).increment.passed).toBe(false);
		expect(evaluate(standardAt(8_000_000), command(7_500_000), NOW).increment.passed).toBe(false);
		expect(evaluate(standardAt(8_000_000), command(1_000_000), NOW).increment.passed).toBe(false);
	});

	it('does not apply to an Opening Bid, and says so with nulls rather than inventing a high', () => {
		expect(evaluate(NO_BIDS, command(500_000), NOW).increment).toEqual({
			passed: true,
			offered: 500_000,
			currentHigh: null,
			minimumLegal: null
		});
	});
});

describe('the granularity gate', () => {
	it('passes a whole multiple of $500,000 and refuses anything else', () => {
		expect(evaluate(NO_BIDS, command(1_500_000), NOW).granularity.passed).toBe(true);
		expect(evaluate(NO_BIDS, command(1_500_001), NOW).granularity.passed).toBe(false);
		expect(evaluate(NO_BIDS, command(6_750_000), NOW).granularity.passed).toBe(false);
	});

	it('reads the amount and nothing else, so it cannot depend on contention state (AC3)', () => {
		const offGrid = 1_000_001;
		const states = [NO_BIDS, standardAt(8_000_000), standardAt(MINIMUM_BID)];
		for (const state of states) {
			const gates = evaluate(state, command(offGrid), NOW);
			expect(gates.granularity).toEqual({
				passed: false,
				offered: offGrid,
				grid: MINIMUM_INCREMENT
			});
		}
	});
});

// --- minimumLegalBid, the read path's pre-fill -----------------------------

describe('minimumLegalBid — the pre-filled figure the control shows', () => {
	it('is the current high plus one increment in Standard Contention', () => {
		expect(minimumLegalBid(standardAt(8_000_000))).toBe(8_500_000);
	});

	it('is $1,000,000 with no Bid — the least the opening gate will now take', () => {
		// It was $1,500,000 until Story 3.2, because the opening gate refused
		// exactly $1,000,000 by name. The gate passes that amount now, and the
		// pre-fill follows the gates rather than being adjusted to match them.
		expect(minimumLegalBid(NO_BIDS)).toBe(MINIMUM_BID);
	});

	it('is the join amount inside a live contention, never a raise over it', () => {
		// A raise does not exist in a lottery: `minimumRaise` would pre-fill
		// $1,500,000, which is the conversion `contention` refuses by name.
		expect(minimumLegalBid(standardAt(MINIMUM_BID))).toBe(MINIMUM_BID);
	});

	it('always passes every gate it was derived for', () => {
		for (const state of [
			NO_BIDS,
			standardAt(8_000_000),
			standardAt(MINIMUM_BID),
			contentionWith(['t-3'])
		]) {
			const amount = minimumLegalBid(state);
			const gates = evaluate(state, command(amount, 't-99'), NOW);
			expect(allGatesPassed(gates), String(amount)).toBe(true);
		}
	});

	it('has ONE state with no legal amount at all, and it is named rather than hidden', () => {
		// **The invariant above is narrowed here, deliberately.** A Team
		// already on the Contender list is refused at $1,000,000 on
		// `already_contending` and at everything above it on `converts` —
		// there is no amount that passes every gate for them, so the pre-fill
		// cannot pass every gate either. The assertion above is scoped to a
		// Team that is not yet a Contender rather than weakened to "usually
		// passes", because a claim that admits exceptions silently is worth
		// nothing.
		//
		// Story 3.3 is what reopens it: dissolution gives a Contender
		// somewhere to go. Until then the honest rendering is the join amount
		// in a disabled field, beside the reason — never a figure invented to
		// satisfy an invariant.
		const state = contentionWith(['t-2']);
		const amount = minimumLegalBid(state);
		expect(amount).toBe(MINIMUM_BID);

		const gates = evaluate(state, command(amount, 't-2'), NOW);
		expect(allGatesPassed(gates)).toBe(false);
		expect(failedGates(gates)).toEqual(['contention']);

		// And nothing above it passes either, which is what makes this a state
		// with no legal amount rather than a badly chosen pre-fill.
		for (const higher of [1_500_000, 2_000_000, 40_000_000]) {
			expect(allGatesPassed(evaluate(state, command(higher, 't-2'), NOW)), String(higher)).toBe(
				false
			);
		}
	});
});

// --- parseBidAmount, the form boundary -------------------------------------

describe('readBidAmount — the "unusable amount" row of the I/O matrix', () => {
	it('accepts whole dollars, with surrounding whitespace trimmed', () => {
		expect(readBidAmount('8500000')).toEqual({ kind: 'usable', amount: 8_500_000 });
		expect(readBidAmount('  8500000  ')).toEqual({ kind: 'usable', amount: 8_500_000 });
		expect(readBidAmount('0')).toEqual({ kind: 'usable', amount: 0 });
	});

	it('refuses empty, non-numeric and decimal-carrying amounts as unusable', () => {
		for (const text of [
			'',
			'   ',
			'abc',
			'8.5',
			'8500000.0',
			'8,500,000',
			'$8500000',
			'8e6',
			'007',
			'Infinity',
			'NaN'
		]) {
			expect(readBidAmount(text), text).toEqual({
				kind: 'unusable',
				refusal: { kind: 'unusable_amount' }
			});
		}
	});

	it('gives a negative amount its OWN refusal — it IS a whole number of dollars', () => {
		// The remedy differs: a decimal point is a typing slip, a minus sign
		// is a misunderstanding of what the field is for. One sentence for
		// both would be false about this input.
		expect(readBidAmount('-500000')).toEqual({
			kind: 'unusable',
			refusal: { kind: 'negative_amount' }
		});
		const detail = bidRefusalDetail({ kind: 'negative_amount' });
		expect(detail).toContain('negative');
		expect(detail).not.toContain('not a whole number of dollars');
	});

	it('never throws — an unusable amount is a person, not a corrupt column', () => {
		for (const text of ['', 'abc', '8.5', '-1', '9'.repeat(40)]) {
			expect(() => readBidAmount(text)).not.toThrow();
		}
	});
});

// --- The wording -----------------------------------------------------------

describe('bidRefusalDetail — one sentence per refusal, worded here and nowhere else', () => {
	it('states BOTH grounds when both fail, in PLACE_BID_GATES order', () => {
		const gates = evaluate(standardAt(8_000_000), command(8_400_000), NOW);
		const detail = bidRefusalDetail({ kind: 'gates', gates });
		expect(detail).toContain('at least the current high plus $0.5M');
		expect(detail).toContain('whole multiple of $0.5M');
		expect(detail.indexOf('current high')).toBeLessThan(detail.indexOf('whole multiple'));
	});

	it('has no refusal at all for an Opening Bid of exactly $1,000,000 (Story 3.2)', () => {
		// Until 3.2 this sentence named the lottery as the ground for a
		// refusal. The lottery exists now, so there is no refusal to word:
		// every gate passes and the panel has nothing to draw.
		const gates = evaluate(NO_BIDS, command(MINIMUM_BID), NOW);
		expect(allGatesPassed(gates)).toBe(true);
		expect(bidRefusalDelta({ kind: 'gates', gates })).toBe('');
	});

	it('names the lottery ground for a CONVERSION into a live contention', () => {
		// The refusal by name moved rather than disappeared: 2.5 refused the
		// opening at $1,000,000 because no lottery could be run, and 3.2
		// refuses the conversion at $1,500,000 because no lottery can yet be
		// dissolved. The same trade, one story on.
		const gates = evaluate(standardAt(MINIMUM_BID), command(2_000_000, 't-2'), NOW);
		const detail = bidRefusalDetail({ kind: 'gates', gates });
		expect(gates.contention.entry).toBe('converts');
		expect(detail).toContain('Minimum-Bid Contention');
		expect(detail).toContain('convert');
	});

	it('gives the self-bid its own distinct wording', () => {
		const gates = evaluate(standardAt(8_000_000, 't-2'), command(8_500_000, 't-2'), NOW);
		const detail = bidRefusalDetail({ kind: 'gates', gates });
		expect(detail).toContain('does not bid against itself');
		expect(detail).not.toContain('whole multiple');
		expect(detail).not.toContain('current high');
	});

	it('never renders an off-grid figure, because there is no lossless rendering of one', () => {
		const gates = evaluate(standardAt(6_000_000), command(6_750_000), NOW);
		const detail = bidRefusalDetail({ kind: 'gates', gates });
		expect(detail).not.toContain('6750000');
		expect(detail).not.toContain('$6.75M');
		expect(detail).not.toContain('$6.8M');
	});

	it('ends every refusal by saying nothing was written', () => {
		const refusals = [
			{ kind: 'gates' as const, gates: evaluate(NO_BIDS, command(500_000), NOW) },
			{ kind: 'unusable_amount' as const },
			{ kind: 'negative_amount' as const },
			{ kind: 'unconfirmed' as const },
			{ kind: 'unbound_actor' as const },
			{ kind: 'no_open_auction' as const },
			{ kind: 'unrecorded' as const }
		];
		for (const refusal of refusals) {
			const detail = bidRefusalDetail(refusal);
			expect(detail, refusal.kind).toContain('Nothing was written.');
			expect(detail.length, refusal.kind).toBeGreaterThan(40);
		}
	});

	it('earned every term the pre-2.8 guard forbade, and the guard is retired', () => {
		const everything = [
			bidRefusalDetail({ kind: 'gates', gates: evaluate(NO_BIDS, command(1), NOW) }),
			bidRefusalDetail({ kind: 'unusable_amount' }),
			bidRefusalDetail({ kind: 'negative_amount' }),
			bidRefusalDetail({ kind: 'unconfirmed' }),
			bidRefusalDetail({ kind: 'unbound_actor' }),
			bidRefusalDetail({ kind: 'no_open_auction' }),
			bidRefusalDetail({ kind: 'unrecorded' }),
			BID_CONSEQUENCE,
			bidConsequenceSentence(null)
		].join('\n');
		// **The guard's CLAIM is retired; the loop below now asserts a
		// different one.** Until Story 2.8 these five terms — `free minor
		// league`, `eligible leading bid`, `overflow`, `no cap limit` and
		// `unbounded` — were forbidden in every refusal sentence, because a
		// sentence naming arithmetic that did not exist would state a rule
		// nothing enforced. 2.8 built all five, so that claim is dead.
		//
		// What the same five regexes assert NOW is the positive counterpart:
		// none of those terms appears in a refusal that has no exposure behind
		// it. The states below have no eligible lead and no eligible Player, so
		// every one of the five would be a term invented for a rule this
		// refusal is not about. The list was re-scoped rather than deleted, and
		// the block beneath it proves each term IS produced when the exposure
		// is real — which a deletion would have stopped checking.
		for (const forbidden of [
			/free minor league/i,
			/eligible leading bid/i,
			/overflow/i,
			/no cap limit/i,
			/unbounded/i
		]) {
			expect(everything, String(forbidden)).not.toMatch(forbidden);
		}

		// ...and here they are, earned, on a state that genuinely overflows.
		// One assertion per term, so a term that stopped being produced fails
		// by name rather than by a count.
		const overflowing = bidRefusalDetail({
			kind: 'gates',
			gates: evaluate(
				bidStateFor(
					null,
					{
						capSpace: parseMoney(2_000_000),
						rosterCount: 11,
						leading: [],
						eligibleLeading: [
							{
								fantraxPlayerId: 'p-stash',
								playerName: 'Ausar Bright',
								amount: parseMoney(30_000_000)
							}
						],
						minorLeagueOccupied: 2
					},
					true
				),
				command(1_500_000),
				NOW
			)
		});
		expect(overflowing).toMatch(/free minor league/i);
		expect(overflowing).toMatch(/eligible leading bid/i);
		expect(overflowing).toMatch(/overflow/i);

		// `no cap limit` and `unbounded` belong to the OTHER branch: the one
		// where the offered amount is compared to nothing. `unbounded` is a
		// field name and never product copy — the figure is rendered in words
		// — so what a Manager reads is `no cap limit`, and it appears on a
		// refusal only when Roster Reserve is what failed.
		const reserveShort = bidRefusalDetail({
			kind: 'gates',
			gates: evaluate(
				bidStateFor(
					null,
					{
						capSpace: parseMoney(1_000_000),
						rosterCount: 5,
						leading: [],
						eligibleLeading: [],
						minorLeagueOccupied: 0
					},
					true
				),
				command(30_000_000),
				NOW
			)
		});
		expect(reserveShort).toMatch(/no cap limit/i);
		expect(reserveShort).toContain('Roster Reserve');
		// Product copy, not a field name.
		expect(reserveShort).not.toMatch(/unbounded/i);
	});

	it('falls back to the stated no-reason sentence for a gate set with no failure', () => {
		const gates = evaluate(standardAt(8_000_000), command(8_500_000), NOW);
		expect(bidRefusalDetail({ kind: 'gates', gates })).toContain('stated no reason');
	});
});

describe('the consequence, stated once', () => {
	it('names what a Bid commits and nothing it cannot compute', () => {
		expect(BID_CONSEQUENCE).toContain('Leading Bidder');
		expect(BID_CONSEQUENCE).toContain('24 hours');
		expect(BID_CONSEQUENCE).toContain('League Clock');
		expect(BID_CONSEQUENCE).toContain('cancelled, amended or lowered');
	});

	it('reads as a finished sentence with and without an amount', () => {
		expect(bidConsequenceSentence(null)).toBe(`A Bid cannot be undone: ${BID_CONSEQUENCE}.`);
		expect(bidConsequenceSentence(parseMoney(8_500_000))).toContain('Bidding $8.5M cannot be undone');
	});

	it('declines to render an off-grid amount rather than throwing', () => {
		expect(() => bidConsequenceSentence(parseMoney(8_400_000))).not.toThrow();
		expect(bidConsequenceSentence(parseMoney(8_400_000))).toContain('A Bid cannot be undone');
	});
});

describe('describeAmount — money renders through formatMoney or not at all', () => {
	it('renders an on-grid amount through the one money renderer', () => {
		expect(describeAmount(parseMoney(8_500_000))).toBe('$8.5M');
		expect(describeAmount(parseMoney(0))).toBe('$0.0M');
	});

	it('describes an off-grid amount rather than inventing a second rendering', () => {
		expect(describeAmount(parseMoney(6_750_000))).toBe('an amount that is not on the grid');
		expect(() => describeAmount(parseMoney(1_000_001))).not.toThrow();
	});
});

// --- Finding 2: one arithmetic, two callers --------------------------------

describe('minimumLegalBid and the increment gate report the SAME figure', () => {
	it('agrees with the gate’s minimumLegal in every Standard Contention state', () => {
		for (const high of [1_500_000, 2_000_000, 8_000_000, 40_000_000]) {
			const state = standardAt(high);
			const pre = minimumLegalBid(state);
			const gate = evaluate(state, command(pre), NOW).increment;
			expect(gate.minimumLegal, String(high)).toBe(pre);
			expect(gate.passed, String(high)).toBe(true);
		}
	});

	it('has no gate counterpart for an opening, and says so with a null', () => {
		// The increment rule does not apply to an Opening Bid, so the gate
		// reports `null` rather than inventing a raise over a high that does
		// not exist. The pre-fill is derived from the two gates that DO apply.
		expect(evaluate(NO_BIDS, command(minimumLegalBid(NO_BIDS)), NOW).increment.minimumLegal)
			.toBeNull();
		expect(allGatesPassed(evaluate(NO_BIDS, command(minimumLegalBid(NO_BIDS)), NOW))).toBe(true);
		// And nothing smaller does. $500,000 is the next value down the grid,
		// and it is below the opening minimum.
		expect(allGatesPassed(evaluate(NO_BIDS, command(500_000), NOW))).toBe(false);
	});
});

describe('minimumLegalSentence — a figure with no lossless rendering is not stated', () => {
	it('states an on-grid figure', () => {
		expect(minimumLegalSentence(parseMoney(9_000_000))).toContain('$9.0M');
	});

	it('returns null rather than a sentence whose figure is a phrase', () => {
		expect(minimumLegalSentence(parseMoney(6_750_000))).toBeNull();
	});
});

// --- Finding 1: the control disables against the TYPED amount --------------

function controlFor(state: BidState, amountText: string, viewerTeamId: string | null = 't-2') {
	return bidControlState({
		state,
		fantraxPlayerId: 'p-1',
		viewerTeamId,
		amountText,
		confirmed: true,
		now: ''
	});
}

describe('bidControlState — one decision function for the read path and the surface', () => {
	it('is ready for the pre-filled amount, and says so in the core’s words', () => {
		const control = controlFor(standardAt(8_000_000), '8500000');
		expect(control.blocked).toBe(false);
		expect(control.detail).toBe(BID_READY);
		expect(control.refusingGates).toEqual([]);
	});

	it('blocks an off-grid TYPED amount with the granularity sentence', () => {
		// $6,750,000 over a $6,000,000 high clears the increment and is off
		// the grid — the case that used to reach an enabled control.
		const control = controlFor(standardAt(6_000_000), '6750000');
		expect(control.blocked).toBe(true);
		expect(control.refusingGates).toEqual(['granularity']);
		expect(control.detail).toContain('whole multiple of $0.5M');
		expect(control.detail).toBe(
			bidRefusalDetail({
				kind: 'gates',
				gates: evaluate(standardAt(6_000_000), command(6_750_000), '')
			})
		);
	});

	it('blocks a sub-increment TYPED amount with the increment sentence', () => {
		const control = controlFor(standardAt(8_000_000), '8400000');
		expect(control.blocked).toBe(true);
		expect(control.refusingGates).toEqual(['increment', 'granularity']);
		expect(control.detail).toContain('the least you may offer is $8.5M');
	});

	it('ALLOWS a TYPED Opening Bid of exactly $1,000,000 — it opens a lottery', () => {
		const control = controlFor(NO_BIDS, '1000000');
		expect(control.blocked).toBe(false);
		expect(control.refusingGates).toEqual([]);
		expect(control.detail).toBe(BID_READY);
	});

	it('blocks a TYPED join from a Team that is already a Contender', () => {
		// The one state with no legal amount at all until Story 3.3 builds
		// dissolution: $1,000,000 is `already_contending` and everything above
		// it is `converts`.
		// `t-2` joined but does not lead, so `contention` is the SOLE ground:
		// the opener re-bidding would be refused on `selfBid` as well.
		const control = controlFor(contentionWith(['t-2']), '1000000');
		expect(control.blocked).toBe(true);
		expect(control.refusingGates).toEqual(['contention']);
		expect(control.detail).toContain('already a Contender');
	});

	it('blocks the Team that already leads, whatever it types', () => {
		for (const typed of ['8500000', '9000000', '40000000']) {
			const control = controlFor(standardAt(8_000_000, 't-2'), typed);
			expect(control.blocked, typed).toBe(true);
			expect(control.detail, typed).toContain('does not bid against itself');
		}
	});

	it('blocks an unusable field before any gate runs, and names which problem it is', () => {
		expect(controlFor(standardAt(8_000_000), '').detail).toBe(
			bidRefusalDetail({ kind: 'unusable_amount' })
		);
		expect(controlFor(standardAt(8_000_000), '8.5').detail).toBe(
			bidRefusalDetail({ kind: 'unusable_amount' })
		);
		expect(controlFor(standardAt(8_000_000), '-500000').detail).toBe(
			bidRefusalDetail({ kind: 'negative_amount' })
		);
		expect(controlFor(standardAt(8_000_000), '').refusingGates).toEqual([]);
	});

	it('blocks an unbound viewer before anything else — no Team, no command', () => {
		const control = controlFor(standardAt(8_000_000), '8500000', null);
		expect(control.blocked).toBe(true);
		expect(control.detail).toBe(bidRefusalDetail({ kind: 'unbound_actor' }));
		expect(control.refusingGates).toEqual([]);
	});

	it('blocks on the confirmation last, once the amount itself is legal', () => {
		const control = bidControlState({
			state: standardAt(8_000_000),
			fantraxPlayerId: 'p-1',
			viewerTeamId: 't-2',
			amountText: '8500000',
			confirmed: false,
			now: ''
		});
		expect(control.blocked).toBe(true);
		expect(control.detail).toBe(bidRefusalDetail({ kind: 'unconfirmed' }));
	});

	it('always states something — `detail` is never empty, in any branch', () => {
		const cases = ['', '8.5', '-1', '1000000', '8400000', '8500000'];
		for (const typed of cases) {
			for (const viewer of ['t-2', 't-1', null]) {
				const control = controlFor(standardAt(8_000_000, 't-1'), typed, viewer);
				expect(control.detail.length, `${typed} / ${String(viewer)}`).toBeGreaterThan(20);
			}
		}
	});

	it('agrees exactly with what decide() would answer for the same amount', () => {
		// The whole point: a control that says a Bid is impossible and a
		// server refusal explaining why cannot disagree, because both reach
		// their answer through `evaluate()`.
		for (const typed of ['1000000', '8400000', '8500000', '9000000']) {
			for (const state of [NO_BIDS, standardAt(8_000_000), standardAt(8_000_000, 't-2')]) {
				const control = controlFor(state, typed);
				const amount = readBidAmount(typed);
				if (amount.kind !== 'usable') continue;
				const decided = decide(state, command(Number(typed)), NOW, SEED);
				expect(control.blocked, `${typed}`).toBe(decided.kind === 'rejected');
				if (decided.kind === 'rejected') {
					expect(control.detail).toBe(bidRefusalDetail({ kind: 'gates', gates: decided.gates }));
				}
			}
		}
	});
});

// --- Story 2.6: the money gate ---------------------------------------------

describe('evaluateCap — Maximum Bid, derived on every evaluation (AD-7)', () => {
	/** A Team with the figures spelled out, so each test reads as a statement. */
	function team(input: {
		capSpace: number;
		rosterCount: number;
		leading?: readonly [string, number][];
		/** Story 2.8: the eligible half of the same partition. */
		eligibleLeading?: readonly [string, number][];
		/** Story 2.8: raw occupancy, never `M`. */
		minorLeagueOccupied?: number;
	}): TeamMoneyState {
		return {
			capSpace: parseMoney(input.capSpace),
			rosterCount: input.rosterCount,
			leading: (input.leading ?? []).map(([fantraxPlayerId, amount]) => ({
				fantraxPlayerId,
				playerName: fantraxPlayerId,
				amount: parseMoney(amount)
			})),
			eligibleLeading: (input.eligibleLeading ?? []).map(([fantraxPlayerId, amount]) => ({
				fantraxPlayerId,
				playerName: fantraxPlayerId,
				amount: parseMoney(amount)
			})),
			minorLeagueOccupied: input.minorLeagueOccupied ?? 0
		};
	}

	/** One open Auction, as `projection/auctions.ts` folds it. */
	function auctionLiteral(
		fantraxPlayerId: string,
		teamId: string,
		amount: number,
		contention: 'standard' | 'minimum_bid' = 'standard'
	): Auction {
		const bid: Bid = {
			seq: '2',
			teamId,
			teamName: 'Rockets',
			managerId: 'm-2',
			amount: parseMoney(amount),
			occurredAt: '2026-08-26T08:00:00.000Z',
			closesAt: '2026-08-27T08:00:00.000Z',
			seedHash: null
		};
		return {
			fantraxPlayerId,
			contention,
			leadingBid: bid,
			closesAt: bid.closesAt,
			bids: [bid],
			// A contention's opener is its first Contender (Story 3.2), which
			// is what makes the money it holds visible to `teamMoneyStateFor`.
			contenders: contention === 'minimum_bid' ? contendersOf([bid]) : [],
			seedHash: null
		};
	}

	const capOf = (state: BidState, amount: number) => evaluate(state, command(amount), NOW).cap;

	it('reports every figure, and they sum exactly as the panel prints them', () => {
		const state = bidStateFor(null, team({ capSpace: 12_000_000, rosterCount: 9 }), false);
		const cap = capOf(state, 1_500_000);

		// The two subtractions the breakdown is a rendering of.
		expect(cap.availableCapSpace).toBe(Number(cap.capSpace) - Number(cap.committedBids));
		expect(cap.maximumBid).toBe(Number(cap.availableCapSpace) - Number(cap.rosterReserve));
	});

	it('excludes the Auction being bid on — a Team is never committed twice for one Player', () => {
		// The narrowing is what enforces this, so it is asserted where the
		// narrowing runs rather than by hand-building the state.
		const money = teamMoneyStateFor({
			teamId: 't-2',
			fantraxPlayerId: 'p-1',
			capSpace: parseMoney(12_000_000),
			rosterCount: 9,
			auctions: {
				byPlayer: {
					'p-1': auctionLiteral('p-1', 't-2', 8_000_000),
					'p-2': auctionLiteral('p-2', 't-2', 3_000_000)
				}
			},
			minorLeagueOccupied: 0,
			isMinorLeagueEligible: () => false,
			playerNameFor: (id) => id
		});

		expect(money.leading).toEqual([
			{ fantraxPlayerId: 'p-2', playerName: 'p-2', amount: 3_000_000 }
		]);
	});

	it('excludes an Auction another Team leads — capital releases by fold, not by sweep', () => {
		const money = teamMoneyStateFor({
			teamId: 't-2',
			fantraxPlayerId: 'p-new',
			capSpace: parseMoney(12_000_000),
			rosterCount: 9,
			auctions: {
				byPlayer: {
					'p-mine': auctionLiteral('p-mine', 't-2', 3_000_000),
					'p-theirs': auctionLiteral('p-theirs', 't-9', 4_000_000)
				}
			},
			minorLeagueOccupied: 0,
			isMinorLeagueEligible: () => false,
			playerNameFor: (id) => id
		});

		expect(money.leading).toEqual([
			{ fantraxPlayerId: 'p-mine', playerName: 'p-mine', amount: 3_000_000 }
		]);
	});

	it('PARTITIONS a Minor League Eligible Player into the eligible set, never dropping it', () => {
		const money = teamMoneyStateFor({
			teamId: 't-2',
			fantraxPlayerId: 'p-new',
			capSpace: parseMoney(12_000_000),
			rosterCount: 9,
			auctions: {
				byPlayer: {
					'p-flat': auctionLiteral('p-flat', 't-2', 3_000_000),
					'p-eligible': auctionLiteral('p-eligible', 't-2', 9_000_000)
				}
			},
			minorLeagueOccupied: 0,
			isMinorLeagueEligible: (id) => id === 'p-eligible',
			playerNameFor: (id) => id
		});

		// FR-14: an eligible lead is not a smaller contribution to Committed
		// Bids — it is not in Committed Bids at all. Until Story 2.8 the loop
		// `continue`d and the amount vanished; it is now ROUTED, which is the
		// difference between a filter and a partition.
		expect(money.leading).toEqual([
			{ fantraxPlayerId: 'p-flat', playerName: 'p-flat', amount: 3_000_000 }
		]);
		expect(money.eligibleLeading).toEqual([
			{ fantraxPlayerId: 'p-eligible', playerName: 'p-eligible', amount: 9_000_000 }
		]);
		// Every lead the fold holds lands in exactly one of the two lists —
		// none dropped, none counted twice. That is what makes `N` and
		// Committed Bids describe the same set of Auctions between them.
		expect(money.leading.length + money.eligibleLeading.length).toBe(2);
		expect(
			[...money.leading, ...money.eligibleLeading].map((lead) => lead.fantraxPlayerId).sort()
		).toEqual(['p-eligible', 'p-flat']);
	});

	it('commits a flat $1.0M for a Minimum-Bid Contention, not the leading amount', () => {
		const money = teamMoneyStateFor({
			teamId: 't-2',
			fantraxPlayerId: 'p-new',
			capSpace: parseMoney(12_000_000),
			rosterCount: 9,
			auctions: {
				byPlayer: {
					'p-lottery': auctionLiteral('p-lottery', 't-2', 1_000_000, 'minimum_bid')
				}
			},
			minorLeagueOccupied: 0,
			isMinorLeagueEligible: () => false,
			playerNameFor: (id) => id
		});

		expect(money.leading).toEqual([
			{ fantraxPlayerId: 'p-lottery', playerName: 'p-lottery', amount: MINIMUM_BID }
		]);
	});

	it('orders its inputs by Player id — a sum over incidental key order is not a sequence (AD-5)', () => {
		const money = teamMoneyStateFor({
			teamId: 't-2',
			fantraxPlayerId: 'p-new',
			capSpace: parseMoney(12_000_000),
			rosterCount: 9,
			auctions: {
				byPlayer: {
					'p-z': auctionLiteral('p-z', 't-2', 1_000_000),
					'p-a': auctionLiteral('p-a', 't-2', 2_000_000),
					'p-m': auctionLiteral('p-m', 't-2', 3_000_000)
				}
			},
			minorLeagueOccupied: 0,
			isMinorLeagueEligible: () => false,
			playerNameFor: (id) => id
		});

		expect(money.leading.map((lead) => lead.fantraxPlayerId)).toEqual(['p-a', 'p-m', 'p-z']);
	});

	it('reports absence rather than zeroes when the actor is bound to no Team', () => {
		const cap = capOf(bidStateFor(null, null, false), 1_500_000);

		// Every nullable figure null together, and the gate PASSES — the
		// refusal an unbound Manager sees is `unbound_actor`, raised before
		// any transaction opens. Stating $0 would be an invented figure a
		// panel would then print.
		expect(cap.passed).toBe(true);
		expect(cap.capSpace).toBeNull();
		expect(cap.committedBids).toBeNull();
		expect(cap.minorsExposure).toBeNull();
		expect(cap.availableCapSpace).toBeNull();
		expect(cap.rosterCount).toBeNull();
		expect(cap.projectedAdditions).toBeNull();
		expect(cap.rosterReserve).toBeNull();
		expect(cap.maximumBid).toBeNull();
		// Story 2.8's three counts join them, for the same reason: `M = 3` for
		// a Team that does not exist would be an invented figure about an
		// invented roster.
		expect(cap.freeMinorLeagueSlots).toBeNull();
		expect(cap.eligibleLeadingBids).toBeNull();
		expect(cap.overflowCount).toBeNull();
		// `unbounded` and `exposingBids` are NOT figures, so they are not
		// nulled: a false boolean and an absent one are the same false, and a
		// list of Auctions nobody leads is genuinely empty.
		expect(cap.unbounded).toBe(false);
		expect(cap.exposingBids).toEqual([]);
		// And nothing to render, rather than a column of zeroes.
		expect(capBreakdown(cap)).toEqual([]);
	});

	it('nulls the capacity gate’s two counts on the same state, and passes it too', () => {
		const slots = evaluate(bidStateFor(null, null, false), command(1_500_000), NOW).slots;

		// Both absent rather than invented zeroes, and absent TOGETHER — the
		// real refusal is `unbound_actor`, raised before any transaction opens.
		expect(slots.passed).toBe(true);
		expect(slots.rosterCount).toBeNull();
		expect(slots.projectedAdditions).toBeNull();
		// ...and so are Story 2.8's three counts, on the same state.
		expect(slots.freeMinorLeagueSlots).toBeNull();
		expect(slots.eligibleLeadingBids).toBeNull();
		expect(slots.overflowCount).toBeNull();
		// The ceiling is a league constant and is true of a Team that does not
		// exist, so it is stated rather than nulled with the others.
		expect(slots.ceiling).toBe(ACTIVE_BENCH_SLOTS);
	});

	it('carries a negative Available Cap Space honestly rather than clamping it', () => {
		// Only the ROSTER RESERVE has a clamp. A Team that is over-committed
		// has a genuinely negative Maximum Bid, and reporting $0 would imply it
		// could still open at the minimum.
		//
		// Roster Count 11 plus one lead plus the bid is 13, so `slots` refuses
		// this state too — which is exactly why every assertion below names
		// `cap`. Two gates refusing one Bid is the ordinary case, and each
		// reports its own arithmetic.
		const state = bidStateFor(
			null,
			team({ capSpace: 2_000_000, rosterCount: 11, leading: [['p-2', 5_000_000]] })
		, false);
		const cap = capOf(state, 1_500_000);

		expect(cap.committedBids).toBe(5_000_000);
		expect(cap.availableCapSpace).toBe(-3_000_000);
		expect(Number(cap.maximumBid)).toBeLessThan(0);
		expect(cap.passed).toBe(false);
	});

	it('never short-circuits another gate, and is never short-circuited by one', () => {
		// A bid that is off-grid AND unaffordable reports both, with both sets
		// of arithmetic — AD-7's "neither gate subsumes the other", applied to
		// the gates that exist today.
		// Roster Count 10 plus the bid being placed leaves one unfilled
		// Active/Bench Slot, so the reserve is a real $1.0M rather than zero —
		// the cap figure here has to be non-trivial or the assertion below
		// would pass on an arithmetic that never ran.
		const state = bidStateFor(null, team({ capSpace: 3_000_000, rosterCount: 10 }), false);
		const gates = evaluate(state, command(9_400_000), NOW);

		expect(gates.granularity.passed).toBe(false);
		expect(gates.cap.passed).toBe(false);
		expect(failedGates(gates)).toEqual(['granularity', 'cap']);
		// Each keeps its own figures.
		expect(gates.granularity.grid).toBe(MINIMUM_INCREMENT);
		expect(gates.cap.maximumBid).toBe(2_000_000);
	});

	it('is reported on an ACCEPTED result too, with the identical shape', () => {
		const state = bidStateFor(null, team({ capSpace: 12_000_000, rosterCount: 9 }), false);
		const accepted = evaluate(state, command(1_500_000), NOW);
		const refused = evaluate(state, command(10_500_000), NOW);

		expect(Object.keys(accepted).sort()).toEqual(Object.keys(refused).sort());
		expect(accepted.cap.passed).toBe(true);
		expect(accepted.cap.maximumBid).toBe(refused.cap.maximumBid);
	});
});

describe('evaluateSlots — Roster Capacity, the second independent ground (AC2, AC3)', () => {
	/** A Team stated as its two capacity facts, so each test reads as one. */
	function team(input: {
		capSpace: number;
		rosterCount: number;
		leading?: readonly [string, number][];
		/** Story 2.8: the eligible half of the same partition. */
		eligibleLeading?: readonly [string, number][];
		/** Story 2.8: raw occupancy, never `M`. */
		minorLeagueOccupied?: number;
	}): TeamMoneyState {
		return {
			capSpace: parseMoney(input.capSpace),
			rosterCount: input.rosterCount,
			leading: (input.leading ?? []).map(([fantraxPlayerId, amount]) => ({
				fantraxPlayerId,
				playerName: fantraxPlayerId,
				amount: parseMoney(amount)
			})),
			eligibleLeading: (input.eligibleLeading ?? []).map(([fantraxPlayerId, amount]) => ({
				fantraxPlayerId,
				playerName: fantraxPlayerId,
				amount: parseMoney(amount)
			})),
			minorLeagueOccupied: input.minorLeagueOccupied ?? 0
		};
	}

	const slotsOf = (state: BidState, amount: number) =>
		evaluate(state, command(amount), NOW).slots;

	it('refuses exactly when Roster Count plus Projected Additions exceeds twelve', () => {
		// The boundary stated as a table rather than as three separate tests,
		// because the whole gate is one comparison and the only thing worth
		// asserting about it is where it turns over.
		const cases: Array<[rosterCount: number, leads: number, passed: boolean]> = [
			[0, 0, true],
			[9, 0, true],
			[10, 1, true],
			[11, 0, true],
			[9, 2, true],
			[12, 0, false],
			[10, 2, false],
			[9, 3, false],
			[14, 0, false]
		];
		for (const [rosterCount, leads, passed] of cases) {
			const state = bidStateFor(
				null,
				team({
					capSpace: SALARY_CAP,
					rosterCount,
					leading: Array.from(
						{ length: leads },
						(_unused, index) => [`p-lead-${String(index)}`, 1_000_000] as [string, number]
					)
				})
			, false);
			const slots = slotsOf(state, 1_500_000);

			expect(slots.passed, `${String(rosterCount)} held, ${String(leads)} led`).toBe(passed);
			expect(slots.rosterCount).toBe(rosterCount);
			// The POST-BID basis: the leads elsewhere PLUS the Bid being placed.
			expect(slots.projectedAdditions).toBe(leads + 1);
			expect(slots.ceiling).toBe(ACTIVE_BENCH_SLOTS);
		}
	});

	it('reads no amount at all — it fails with unlimited Cap Space and passes with none', () => {
		// FR-37's property, asserted as the structural fact it is: the gate has
		// no `offered` field, so the only way to check it is that the verdict
		// does not move when the money does.
		const full = bidStateFor(null, team({ capSpace: 400_000_000, rosterCount: 12 }), false);
		const broke = bidStateFor(null, team({ capSpace: 0, rosterCount: 9 }), false);

		for (const amount of [1_500_000, 5_000_000, 40_000_000]) {
			expect(slotsOf(full, amount).passed, String(amount)).toBe(false);
			expect(slotsOf(broke, amount).passed, String(amount)).toBe(true);
		}
		// And the outcome carries no money figure to be confused for a ground.
		// Story 2.8 added three fields to this shape and all three are COUNTS,
		// which is the whole reason the capacity gate could learn about Minors
		// Exposure at all: `Overflow Count = max(0, N - M)` needs two
		// integers. There is still no `offered` and no amount here.
		expect(Object.keys(slotsOf(full, 5_000_000)).sort()).toEqual([
			'ceiling',
			'eligibleLeadingBids',
			'freeMinorLeagueSlots',
			'overflowCount',
			'passed',
			'projectedAdditions',
			'rosterCount'
		]);
	});

	it('shares the derivation with the money gate and never the outcome', () => {
		// One expression behind both counts, two outcomes in front of it:
		// the figures agree, and the objects are not the same object.
		const state = bidStateFor(
			null,
			team({ capSpace: 12_000_000, rosterCount: 9, leading: [['p-2', 3_000_000]] })
		, false);
		const gates = evaluate(state, command(1_500_000), NOW);

		expect(gates.slots.rosterCount).toBe(gates.cap.rosterCount);
		expect(gates.slots.projectedAdditions).toBe(gates.cap.projectedAdditions);
		expect(gates.slots).not.toBe(gates.cap);
	});

	it('is refused by leads elsewhere, though no single Bid did it', () => {
		// Roster Count 10 and two non-eligible Auctions led: 10 + 3 = 13.
		const state = bidStateFor(
			null,
			team({
				capSpace: SALARY_CAP,
				rosterCount: 10,
				leading: [
					['p-2', 1_000_000],
					['p-3', 1_000_000]
				]
			})
		, false);
		const gates = evaluate(state, command(1_500_000), NOW);

		expect(gates.slots.projectedAdditions).toBe(3);
		expect(gates.slots.passed).toBe(false);
		expect(failedGates(gates)).toEqual(['slots']);
	});

	it('neither short-circuits the other, on either side of the pair', () => {
		// Money fails, capacity does not: Roster Count 9, over Maximum Bid.
		const moneyOnly = bidStateFor(null, team({ capSpace: 12_000_000, rosterCount: 9 }), false);
		const overCap = evaluate(moneyOnly, command(10_500_000), NOW);
		expect(failedGates(overCap)).toEqual(['cap']);
		expect(overCap.slots.passed).toBe(true);
		expect(overCap.slots.rosterCount).toBe(9);

		// Capacity fails, money does not: Roster Count 12 with $40.0M spare.
		const slotsOnly = bidStateFor(null, team({ capSpace: 40_000_000, rosterCount: 12 }), false);
		const overSlots = evaluate(slotsOnly, command(5_000_000), NOW);
		expect(failedGates(overSlots)).toEqual(['slots']);
		expect(overSlots.cap.passed).toBe(true);
		expect(overSlots.cap.maximumBid).toBe(40_000_000);

		// Both fail, each with its own arithmetic, in PLACE_BID_GATES order.
		const both = bidStateFor(null, team({ capSpace: 3_000_000, rosterCount: 12 }), false);
		const gates = evaluate(both, command(5_000_000), NOW);
		expect(failedGates(gates)).toEqual(['cap', 'slots']);
		expect(gates.cap.maximumBid).toBe(3_000_000);
		expect(gates.slots.rosterCount).toBe(12);

		// And the composed refusal states BOTH sentences, in that same order —
		// the half of "each with its own sentence" that the numeric assertions
		// above cannot reach. AD-1 forbids short-circuiting, so a Bid refused
		// on two grounds must say both; saying only the first would be the
		// same defect as evaluating only the first.
		const detail = bidRefusalDetail({ kind: 'gates', gates });
		expect(detail).toContain('exceeds your Maximum Bid');
		expect(detail).toContain('no roster slot');
		expect(detail.indexOf('Maximum Bid')).toBeLessThan(detail.indexOf('no roster slot'));
		// Two complete sentences joined, not one ground swallowing the other.
		expect(detail).toContain('Roster Count is 12');
		expect(detail).toContain('Roster Capacity of 12');
	});

	it('keeps the two machine-readable reasons distinct, and their two sentences', () => {
		const capOnly = bidRefusalDetail({
			kind: 'gates',
			gates: evaluate(
				bidStateFor(null, team({ capSpace: 12_000_000, rosterCount: 9 }), false),
				command(10_500_000),
				NOW
			)
		});
		const slotsOnly = bidRefusalDetail({
			kind: 'gates',
			gates: evaluate(
				bidStateFor(null, team({ capSpace: 40_000_000, rosterCount: 12 }), false),
				command(5_000_000),
				NOW
			)
		});

		// A capacity refusal never states a cap figure as its ground...
		expect(slotsOnly).toContain('no roster slot');
		expect(slotsOnly).toContain('Roster Capacity');
		expect(slotsOnly).not.toContain('Maximum Bid');
		expect(slotsOnly).not.toMatch(/\$\d/);
		// ...and a cap refusal never states a roster one.
		expect(capOnly).toContain('Maximum Bid');
		expect(capOnly).not.toContain('Roster Capacity');
		expect(capOnly).not.toContain('roster slot');
	});

	it('refuses a Team a Commissioner override put above the ceiling', () => {
		// The other half of the `unfilledSlots` clamp: the reserve stays at $0
		// so no extra spending power is handed out, and the capacity gate is
		// what actually refuses the Bid.
		const state = bidStateFor(null, team({ capSpace: 40_000_000, rosterCount: 14 }), false);
		const gates = evaluate(state, command(5_000_000), NOW);

		expect(gates.cap.rosterReserve).toBe(0);
		expect(gates.cap.passed).toBe(true);
		expect(gates.slots.passed).toBe(false);
		expect(gates.slots.rosterCount).toBe(14);
		expect(gates.slots.projectedAdditions).toBe(1);
	});

	it('passes a Team with no roster rows at all — a real post-import state', () => {
		const gates = evaluate(
			bidStateFor(null, team({ capSpace: SALARY_CAP, rosterCount: 0 }), false),
			command(1_500_000),
			NOW
		);

		expect(gates.slots.rosterCount).toBe(0);
		expect(gates.slots.projectedAdditions).toBe(1);
		expect(gates.slots.passed).toBe(true);
	});

	it('carries its figure when it PASSES, which is the row EXPERIENCE.md specifies', () => {
		// `EXPERIENCE.md:89` shows the passing row verbatim — `Slots · Passed`
		// beside `Roster Count would be 10 of 12` — and that is the row the
		// whole "both gates, always" design exists to produce: reporting the
		// gate that passed proves every check ran and this is the only
		// obstacle. Asserted as the exact string, because a generic
		// "the figure is non-empty" check would pass on a wrong one, and the
		// refused figure being right is no evidence the passing one is.
		const rowFor = (state: BidState, amount: number) =>
			bidGateReport(evaluate(state, command(amount), NOW)).find((row) => row.gate === 'slots');

		// The example's own numbers: Roster Count 9, one Bid being placed.
		const spare = bidStateFor(null, team({ capSpace: SALARY_CAP, rosterCount: 9 }), false);
		expect(rowFor(spare, 1_500_000)?.chip).toBe('Slots · Passed');
		expect(rowFor(spare, 1_500_000)?.figure).toBe('Roster Count would be 10 of 12');

		// And at the boundary, where the Bid itself fills the last hole.
		const lastHole = bidStateFor(null, team({ capSpace: SALARY_CAP, rosterCount: 11 }), false);
		expect(rowFor(lastHole, 1_500_000)?.chip).toBe('Slots · Passed');
		expect(rowFor(lastHole, 1_500_000)?.figure).toBe('Roster Count would be 12 of 12');

		// One branch serves both outcomes: the figure states the arithmetic
		// and the chip beside it states the verdict, so the same sentence
		// shape survives the turnover.
		const full = bidStateFor(null, team({ capSpace: SALARY_CAP, rosterCount: 12 }), false);
		expect(rowFor(full, 1_500_000)?.chip).toBe('Slots · Refused');
		expect(rowFor(full, 1_500_000)?.figure).toBe('Roster Count would be 13 of 12');
	});
});

// --- Story 2.8: Minors Exposure --------------------------------------------

describe('the exposure arithmetic — M, N, Overflow Count and Minors Exposure', () => {
	/** A Team stated as its exposure facts, so each case reads as one. */
	function team(input: {
		capSpace?: number;
		rosterCount?: number;
		minorLeagueOccupied?: number;
		leading?: readonly [string, number][];
		eligibleLeading?: readonly [string, number][];
	}): TeamMoneyState {
		const entry = ([fantraxPlayerId, amount]: [string, number]) => ({
			fantraxPlayerId,
			playerName: `Name ${fantraxPlayerId}`,
			amount: parseMoney(amount)
		});
		return {
			capSpace: parseMoney(input.capSpace ?? SALARY_CAP),
			rosterCount: input.rosterCount ?? 9,
			leading: (input.leading ?? []).map(entry),
			eligibleLeading: (input.eligibleLeading ?? []).map(entry),
			minorLeagueOccupied: input.minorLeagueOccupied ?? 0
		};
	}

	const eligibleLeads = (count: number, amount = 5_000_000): [string, number][] =>
		Array.from({ length: count }, (_unused, index) => [`p-e${String(index)}`, amount]);

	it('turns over exactly at N = M + 1, and nowhere else', () => {
		// The whole derivation is `Overflow Count = max(0, N - M)`, so the
		// only thing worth asserting about it is where it turns over. Stated
		// as a table rather than as ten separate tests, `evaluateSlots`' own
		// discipline.
		const cases: Array<
			[occupied: number, leads: number, eligible: boolean, m: number, n: number, overflow: number]
		> = [
			// N below M, at M, and one past it — the three the matrix names.
			[0, 0, true, 3, 1, 0],
			[0, 2, true, 3, 3, 0],
			[0, 3, true, 3, 4, 1],
			[2, 0, true, 1, 1, 0],
			[2, 1, true, 1, 2, 1],
			[3, 0, true, 0, 1, 1],
			// A non-eligible Player never joins the set, so N counts the leads
			// alone and the Bid being placed adds nothing to it.
			[0, 3, false, 3, 3, 0],
			[3, 1, false, 0, 1, 1],
			// Occupancy above the ceiling: `M` clamps at 0 rather than going
			// negative and handing a Team extra room as a reward for the
			// Commissioner override that put it there.
			[4, 0, true, 0, 1, 1],
			[9, 2, true, 0, 3, 3]
		];

		for (const [occupied, leads, eligible, m, n, overflow] of cases) {
			const label = `${String(occupied)} occupied, ${String(leads)} led, eligible=${String(eligible)}`;
			const state = bidStateFor(
				null,
				team({ minorLeagueOccupied: occupied, eligibleLeading: eligibleLeads(leads) }),
				eligible
			);
			const gates = evaluate(state, command(9_000_000), NOW);

			expect(gates.cap.freeMinorLeagueSlots, label).toBe(m);
			expect(gates.cap.eligibleLeadingBids, label).toBe(n);
			expect(gates.cap.overflowCount, label).toBe(overflow);
			// The capacity gate reaches the IDENTICAL three counts, through
			// the identical call — one expression, two gates.
			expect(gates.slots.freeMinorLeagueSlots, label).toBe(m);
			expect(gates.slots.eligibleLeadingBids, label).toBe(n);
			expect(gates.slots.overflowCount, label).toBe(overflow);
		}
	});

	it('sums the Overflow Count LARGEST amounts, and nothing when nothing overflows', () => {
		// `N = 4` against `M = 1` leaves three overflowing out of four, so the
		// sum is the three largest and the smallest is left out.
		const state = bidStateFor(
			null,
			team({
				minorLeagueOccupied: 2,
				eligibleLeading: [
					['p-a', 4_000_000],
					['p-b', 8_000_000],
					['p-c', 2_000_000]
				]
			}),
			true
		);
		const cap = evaluate(state, command(6_000_000), NOW).cap;

		expect(cap.overflowCount).toBe(3);
		// $8.0M + $6.0M (this Bid) + $4.0M — the $2.0M is the one that fits.
		expect(cap.minorsExposure).toBe(18_000_000);
		// The EARLIER Auctions only: this Bid is in the sum but never named.
		expect(cap.exposingBids.map((bid) => bid.fantraxPlayerId)).toEqual(['p-b', 'p-a']);

		// And zero when `N <= M`, rather than a smaller sum.
		const inside = bidStateFor(null, team({ eligibleLeading: [['p-a', 4_000_000]] }), true);
		expect(evaluate(inside, command(6_000_000), NOW).cap.minorsExposure).toBe(0);
		expect(evaluate(inside, command(6_000_000), NOW).cap.exposingBids).toEqual([]);
	});

	it('breaks a tie on Player id ascending, so the figure and the naming are stable', () => {
		// Two exposing Auctions at the same amount. With `M = 2` nothing
		// overflows at all...
		const roomy = bidStateFor(
			null,
			team({
				minorLeagueOccupied: 1,
				eligibleLeading: [
					['p-zulu', 5_000_000],
					['p-alpha', 5_000_000]
				]
			}),
			false
		);
		expect(evaluate(roomy, command(9_000_000), NOW).cap.overflowCount).toBe(0);

		// ...and with `M = 1` the slice cuts BETWEEN the tie, which is the
		// only case where the tiebreak can be observed at all.
		const tighter = bidStateFor(
			null,
			team({
				minorLeagueOccupied: 2,
				eligibleLeading: [
					['p-zulu', 5_000_000],
					['p-alpha', 5_000_000]
				]
			}),
			false
		);
		const tie = evaluate(tighter, command(9_000_000), NOW).cap;

		expect(tie.overflowCount).toBe(1);
		expect(tie.minorsExposure).toBe(5_000_000);
		// Ascending id (AD-5) — `p-alpha`, deterministically, however the
		// list happened to be built.
		expect(tie.exposingBids.map((bid) => bid.fantraxPlayerId)).toEqual(['p-alpha']);
	});

	it('breaks a tie between THIS Bid and an earlier lead, on the same id rule', () => {
		// The tie above is between two earlier leads. This one straddles the
		// cutoff differently: the prospective Bid's own amount ties an earlier
		// lead, and the id rule decides which of the two the slice keeps — which
		// in turn decides whether `exposingBids` names an Auction or is empty.
		// The command bids on `p-1`.
		const against = (leadId: string) =>
			evaluate(
				bidStateFor(
					null,
					team({ minorLeagueOccupied: 2, eligibleLeading: [[leadId, 5_000_000]] }),
					true
				),
				command(5_000_000),
				NOW
			).cap;

		// `p-1` sorts before `p-zulu`, so THIS Bid takes the one overflow slot
		// and there is no earlier Auction to name.
		const thisBidWins = against('p-zulu');
		expect(thisBidWins.overflowCount).toBe(1);
		expect(thisBidWins.minorsExposure).toBe(5_000_000);
		expect(thisBidWins.exposingBids).toEqual([]);
		expect(thisBidWins.exposureIncludesThisBid).toBe(true);

		// `p-0` sorts before `p-1`, so the earlier lead takes it instead — the
		// same figure, reached from the other side of the tiebreak, and now with
		// an Auction to name.
		const leadWins = against('p-0');
		expect(leadWins.overflowCount).toBe(1);
		expect(leadWins.minorsExposure).toBe(5_000_000);
		expect(leadWins.exposingBids.map((bid) => bid.fantraxPlayerId)).toEqual(['p-0']);
		expect(leadWins.exposureIncludesThisBid).toBe(false);
	});

	it('accounts for THIS Bid when the slice holds it AND an earlier lead, or the sum is short', () => {
		// The third composition of the overflow slice, and the one a refusal can
		// silently get wrong: `M = 1` with leads at $5.0M and $4.0M and a
		// prospective eligible Bid of $6.0M gives `N = 3`, Overflow Count 2, and
		// a slice of this Bid plus `p-alpha`. Exposure is $11.0M, but only $5.0M
		// of it belongs to an Auction the sentence may name.
		const state = bidStateFor(
			null,
			team({
				capSpace: 2_000_000,
				rosterCount: 11,
				minorLeagueOccupied: 2,
				eligibleLeading: [
					['p-alpha', 5_000_000],
					['p-beta', 4_000_000]
				]
			}),
			true
		);
		const gates = evaluate(state, command(6_000_000), NOW);
		const cap = gates.cap;

		expect(cap.overflowCount).toBe(2);
		expect(cap.minorsExposure).toBe(11_000_000);
		expect(cap.exposingBids.map((bid) => bid.fantraxPlayerId)).toEqual(['p-alpha']);
		expect(cap.exposureIncludesThisBid).toBe(true);
		expect(cap.passed).toBe(false);

		// The refusal must ACCOUNT for this Bid without NAMING this Auction.
		// Naming only `p-alpha` would print $5.0M of explanation under an $11.0M
		// figure, and a Manager checking the arithmetic by hand would find it
		// $6.0M short with nothing to tell them why.
		const detail = bidRefusalDetail({ kind: 'gates', gates });
		expect(detail).toContain('Minors Exposure of $11.0M');
		expect(detail).toContain('$5.0M');
		expect(detail).toContain("this Bid's own amount");
		// And it still never names the Auction being bid on as its own cause.
		expect(detail).not.toContain('Name p-1');
	});

	it('bounds a NON-eligible Bid with an eligible lead’s exposure, and the column still sums', () => {
		// The matrix's "an eligible lead bounds a non-eligible bid": exposure
		// enters Committed Bids, Maximum Bid is an ordinary number, and the
		// breakdown's commentary row is non-zero.
		const state = bidStateFor(
			null,
			team({
				capSpace: 40_000_000,
				rosterCount: 9,
				minorLeagueOccupied: 3,
				eligibleLeading: [['p-stash', 30_000_000]]
			}),
			false
		);
		const cap = evaluate(state, command(1_500_000), NOW).cap;

		expect(cap.unbounded).toBe(false);
		expect(cap.minorsExposure).toBe(30_000_000);
		expect(cap.committedBids).toBe(30_000_000);
		// Every subtraction the breakdown is a rendering of still holds.
		expect(cap.availableCapSpace).toBe(Number(cap.capSpace) - Number(cap.committedBids));
		expect(cap.maximumBid).toBe(Number(cap.availableCapSpace) - Number(cap.rosterReserve));

		const lines = capBreakdown(cap);
		const exposure = lines.find((line) => line.label === 'of which Minors Exposure');
		expect(exposure?.figure).toBe('$30.0M');
		// Commentary inside Committed Bids, never a second subtraction.
		expect(exposure?.kind).toBe('detail');
		expect(exposure?.operator).toBe('');
		// Labels stay unique — the column keys its rows on them.
		const labels = lines.map((line) => line.label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it('routes an eligible Minimum-Bid Contention to $1.0M of EXPOSURE, not to Committed Bids', () => {
		// The `minimum_bid` substitution is written once, before the
		// partition, so it applies to an eligible contention exactly as it
		// does to a non-eligible one. `minimum_bid` is reachable only as a
		// state literal here: this story produces no Minimum-Bid Contention.
		const contender: Bid = {
			seq: '2',
			teamId: 't-2',
			teamName: 'Rockets',
			managerId: 'm-2',
			amount: parseMoney(1_000_000),
			occurredAt: '2026-08-26T08:00:00.000Z',
			closesAt: '2026-08-27T08:00:00.000Z',
			seedHash: null
		};
		const money = teamMoneyStateFor({
			teamId: 't-2',
			fantraxPlayerId: 'p-new',
			capSpace: parseMoney(12_000_000),
			rosterCount: 9,
			minorLeagueOccupied: 0,
			auctions: {
				byPlayer: {
					'p-lottery': {
						fantraxPlayerId: 'p-lottery',
						contention: 'minimum_bid',
						leadingBid: contender,
						closesAt: contender.closesAt,
						bids: [contender],
						contenders: [{ seq: contender.seq, teamId: 't-2', teamName: 'Rockets' }],
						seedHash: null
					}
				}
			},
			isMinorLeagueEligible: (id) => id === 'p-lottery',
			playerNameFor: () => 'Lottery Prospect'
		});

		// Not in `leading` at all, and carrying the flat $1,000,000.
		expect(money.leading).toEqual([]);
		expect(money.eligibleLeading).toEqual([
			{ fantraxPlayerId: 'p-lottery', playerName: 'Lottery Prospect', amount: MINIMUM_BID }
		]);

		// And it commits NOTHING while a Free Minor League Slot absorbs it.
		const cap = evaluate(bidStateFor(null, money, false), command(1_500_000), NOW).cap;
		expect(cap.eligibleLeadingBids).toBe(1);
		expect(cap.overflowCount).toBe(0);
		expect(cap.minorsExposure).toBe(0);
		expect(cap.committedBids).toBe(0);
	});

	it('refuses on BOTH grounds at once, each with its own arithmetic', () => {
		// A Team that is both over-committed by exposure and out of
		// Active/Bench room. AD-1 forbids short-circuiting, so both refuse and
		// both sentences are composed — the money one naming the Auction, the
		// capacity one naming the overflow in counts.
		const state = bidStateFor(
			null,
			team({
				capSpace: 2_000_000,
				rosterCount: 12,
				minorLeagueOccupied: 3,
				eligibleLeading: [['p-stash', 30_000_000]]
			}),
			true
		);
		const gates = evaluate(state, command(1_500_000), NOW);

		expect(failedGates(gates)).toEqual(['cap', 'slots']);
		expect(gates.cap.overflowCount).toBe(2);
		expect(gates.slots.overflowCount).toBe(2);
		expect(gates.slots.projectedAdditions).toBe(2);
		expect(gates.slots.rosterCount).toBe(12);

		const detail = bidRefusalDetail({ kind: 'gates', gates });
		expect(detail).toContain('exceeds your Maximum Bid');
		expect(detail).toContain('Name p-stash');
		expect(detail).toContain('no roster slot');
		expect(detail.indexOf('Maximum Bid')).toBeLessThan(detail.indexOf('no roster slot'));
	});

	it('derives every figure afresh, from the facts, on every single evaluation', () => {
		// AD-7: never persisted, never memoised, never transported. The proof
		// available to a unit test is that the same facts always give the same
		// answer and different facts always give a different one — there is no
		// cache to stale, because there is no cache.
		const facts = team({ minorLeagueOccupied: 2, eligibleLeading: [['p-a', 7_000_000]] });
		const state = bidStateFor(null, facts, true);

		expect(evaluate(state, command(9_000_000), NOW).cap).toEqual(
			evaluate(state, command(9_000_000), NOW).cap
		);
		// One more Free Minor League Slot, and the exposure is simply gone.
		const freer = bidStateFor(null, { ...facts, minorLeagueOccupied: 1 }, true);
		expect(evaluate(freer, command(9_000_000), NOW).cap.minorsExposure).toBe(0);
		expect(evaluate(state, command(9_000_000), NOW).cap.minorsExposure).toBe(9_000_000);
	});

	it('reaches MINOR_LEAGUE_SLOTS through the one counts expression', () => {
		// `M` is the constant minus occupancy, and both gates report the same
		// `M` because both call the same function. A second derivation would
		// be free to disagree with this one.
		const state = bidStateFor(null, team({ minorLeagueOccupied: 0 }), true);
		const gates = evaluate(state, command(9_000_000), NOW);

		expect(gates.cap.freeMinorLeagueSlots).toBe(MINOR_LEAGUE_SLOTS);
		expect(gates.slots.freeMinorLeagueSlots).toBe(gates.cap.freeMinorLeagueSlots);
		expect(gates.slots.eligibleLeadingBids).toBe(gates.cap.eligibleLeadingBids);
		expect(gates.slots.overflowCount).toBe(gates.cap.overflowCount);
	});
});

describe('the refusal panel content, worded by the core and nowhere else', () => {
	const PANEL_STATE = bidStateFor(null, {
		capSpace: parseMoney(12_000_000),
		rosterCount: 9,
		leading: [],
		// Story 2.8: no eligible leads and no occupied Minor League
		// Slots, so `N` is the bid alone and `M` is the full three.
		eligibleLeading: [],
		minorLeagueOccupied: 0
	}, false);

	it('reports EVERY gate, refused and passed alike, in the declared order', () => {
		const rows = bidGateReport(evaluate(PANEL_STATE, command(10_500_000), NOW));

		expect(rows.map((row) => row.gate)).toEqual([...PLACE_BID_GATES]);
		// Reporting the passing gate proves every check ran and this is the
		// only obstacle — the property that forecloses "what else is it not
		// telling me".
		expect(rows.filter((row) => !row.passed).map((row) => row.gate)).toEqual(['cap']);
		for (const row of rows) {
			expect(row.figure.length, row.gate).toBeGreaterThan(0);
			expect(row.label.length, row.gate).toBeGreaterThan(0);
		}
	});

	it('gives the passing gates their OWN figures, not a bare "Passed"', () => {
		const rows = bidGateReport(evaluate(PANEL_STATE, command(10_500_000), NOW));
		const figureFor = (gate: string) => rows.find((row) => row.gate === gate)?.figure;

		expect(figureFor('granularity')).toContain('$0.5M');
		expect(figureFor('cap')).toContain('$10.0M');
	});

	it('states the delta without the one-line refusal framing', () => {
		const gates = evaluate(PANEL_STATE, command(10_500_000), NOW);

		// The panel's headline says "not placed" and its reassurance says
		// "nothing was written", so the delta says neither — and it is the
		// same sentence the one-line form carries, not a second wording.
		const delta = bidRefusalDelta({ kind: 'gates', gates });
		expect(delta).toBe('$10.5M exceeds your Maximum Bid of $10.0M by $0.5M.');
		expect(delta).not.toContain('No Bid was placed');
		expect(delta).not.toContain('Nothing was written');
		expect(bidRefusalDetail({ kind: 'gates', gates })).toContain(delta);
	});

	it('answers for a refusal decided before any transaction opened, too', () => {
		// The matrix requires the panel on ANY refused submit, and the three
		// refusals the route raises have a sentence without having arithmetic.
		for (const kind of ['unusable_amount', 'unconfirmed', 'unbound_actor', 'no_open_auction'] as const) {
			const delta = bidRefusalDelta({ kind });
			expect(delta.length, kind).toBeGreaterThan(20);
			// Unframed: the panel's headline and reassurance say these two.
			expect(delta, kind).not.toContain('No Bid was placed');
			expect(delta, kind).not.toContain('Nothing was written');
			// And the one-line form is composed FROM it, never re-worded.
			expect(bidRefusalDetail({ kind }), kind).toContain(delta);
		}
	});

	it('is empty when nothing refused — the caller cue that there is no panel', () => {
		const gates = evaluate(PANEL_STATE, command(1_500_000), NOW);
		expect(bidRefusalDelta({ kind: 'gates', gates })).toBe('');
	});

	it('labels the breakdown with PRD §3 glossary terms, verbatim', () => {
		const labels = capBreakdown(evaluate(PANEL_STATE, command(10_500_000), NOW).cap).map(
			(line) => line.label
		);

		expect(labels).toContain('Cap Space');
		expect(labels).toContain('Committed Bids');
		expect(labels).toContain('Available Cap Space');
		expect(labels).toContain('Roster Reserve');
		expect(labels).toContain('Maximum Bid');
		// A synonym in UI copy is a defect, the same as a synonym in code.
		for (const wrong of ['Cap Room', 'Budget', 'Spending Power', 'Max Bid']) {
			expect(labels).not.toContain(wrong);
		}
	});

	it('carries Minors Exposure as commentary inside Committed Bids, never as a second subtraction', () => {
		const lines = capBreakdown(evaluate(PANEL_STATE, command(10_500_000), NOW).cap);
		const exposure = lines.find((line) => line.label.includes('Minors Exposure'));

		expect(exposure?.kind).toBe('detail');
		// No operator: subtracting it again would double-count a term already
		// inside Committed Bids, and the column would stop summing.
		expect(exposure?.operator).toBe('');
	});

	it('states the headline and the reassurance once, here', () => {
		expect(REFUSAL_HEADLINE).toBe('This bid was not placed.');
		expect(REFUSAL_REASSURANCE).toContain('Nothing has been committed');
		expect(REFUSAL_REASSURANCE).toContain('Auction is unchanged');
		// No apologies and no exclamation marks (EXPERIENCE.md).
		expect(`${REFUSAL_HEADLINE}${REFUSAL_REASSURANCE}`).not.toMatch(/sorry|apolog|!/i);
	});

	it('words the arithmetic caption, so no component writes one', () => {
		expect(figuresAtCaption('2:14 AM Wed')).toBe('Your figures at 2:14 AM Wed');
	});
});

describe('off-grid figures — rendered, never thrown on', () => {
	/**
	 * A Cap Space that is not a whole multiple of $500,000.
	 *
	 * Not a contrived value. Cap Space is `SALARY_CAP` minus imported Cap
	 * Hits, and `money.ts`'s own `isOnMoneyGrid` states the premise outright:
	 * "an imported Cap Hit is a real-world salary figure with no guarantee it
	 * sits on the app's own $500,000 grid". `import-preview.ts` agrees — it
	 * asks before rendering and shows exact dollars otherwise, because an
	 * off-grid Cap Space is imported, flagged to the Commissioner, and allowed
	 * to stand. So this state reaches the Auction page in production.
	 */
	const AWKWARD = bidStateFor(null, {
		capSpace: parseMoney(12_345_678),
		rosterCount: 9,
		leading: [],
		// Story 2.8: no eligible leads and no occupied Minor League
		// Slots, so `N` is the bid alone and `M` is the full three.
		eligibleLeading: [],
		minorLeagueOccupied: 0
	}, false);

	it('renders a breakdown from an off-grid Cap Space instead of throwing', () => {
		// `formatMoney` throws a RangeError on an off-grid amount BY DESIGN.
		// Calling it here would turn a tolerated import into a 500 on the
		// Auction page for every viewer on that Team.
		const gates = evaluate(AWKWARD, command(1_500_000), NOW);
		expect(() => capBreakdown(gates.cap)).not.toThrow();
		expect(capBreakdown(gates.cap).length).toBeGreaterThan(4);
	});

	it('renders every gate row and every refusal sentence from that state', () => {
		const gates = evaluate(AWKWARD, command(99_000_000), NOW);

		expect(gates.cap.passed).toBe(false);
		expect(() => bidGateReport(gates)).not.toThrow();
		expect(() => bidRefusalDelta({ kind: 'gates', gates })).not.toThrow();
		expect(() => bidRefusalDetail({ kind: 'gates', gates })).not.toThrow();
	});

	it('survives an amount that is BOTH off-grid and over Maximum Bid', () => {
		// AD-1's no-short-circuiting guarantees this state is reachable: the
		// granularity gate and the cap gate both fail, and every sentence for
		// both is composed. `bidControlState` composes them live on every
		// keystroke, so a throw here is a crash while a Manager is typing.
		const state = bidStateFor(null, {
			capSpace: parseMoney(3_000_000),
			rosterCount: 10,
			leading: [],
			// Story 2.8: no eligible leads and no occupied Minor League
			// Slots, so `N` is the bid alone and `M` is the full three.
			eligibleLeading: [],
			minorLeagueOccupied: 0
		}, false);
		const gates = evaluate(state, command(9_400_000), NOW);

		expect(failedGates(gates)).toEqual(['granularity', 'cap']);
		const delta = bidRefusalDelta({ kind: 'gates', gates });
		// Both grounds are stated, and the off-grid amount is DESCRIBED rather
		// than rendered — no second money renderer is invented to print a
		// number the product has no lossless spelling for.
		expect(delta).toContain('whole multiple');
		expect(delta).toContain('exceeds your Maximum Bid');
		expect(delta).toContain('an amount that is not on the grid');
	});

	it('keeps the control live and worded through an off-grid keystroke', () => {
		const control = bidControlState({
			state: AWKWARD,
			fantraxPlayerId: 'p-1',
			viewerTeamId: 't-2',
			amountText: '9400000',
			confirmed: true,
			now: ''
		});

		expect(control.blocked).toBe(true);
		expect(control.detail.length).toBeGreaterThan(20);
	});
});

// --- Story 3.1: expiry is authoritative for validation ---------------------

/**
 * The same fixture shape `standardAt` builds, with the Auction's close
 * instant chosen by the test rather than inherited from the leading Bid.
 *
 * Built through `bidStateFor` for the reason every fixture in this file is:
 * these tests must exercise the bridge `server/bidding.ts` and
 * `server/auction-page.ts` take, not a hand-assembled shape that could drift
 * from it.
 */
function auctionClosingAt(closesAt: string, amount = 8_000_000, teamId = 't-1'): BidState {
	const bid = leading(amount, teamId);
	const auction: Auction = {
		fantraxPlayerId: 'p-1',
		contention: contentionForAmount(bid.amount),
		leadingBid: { ...bid, closesAt },
		closesAt,
		bids: [{ ...bid, closesAt }],
		contenders: contendersOf([{ ...bid, closesAt }]),
		seedHash: null
	};
	return bidStateFor(auction, RICH, false);
}

/** The close instant every boundary below is measured against. */
const CLOSES = '2026-08-27T09:00:00.000Z';

/** A legal raise over the $8.0M fixture — refused by nothing but the clock. */
const RAISE = command(8_500_000);

describe('expiry — the persisted close instant is the authority (AC2, AC3)', () => {
	it('passes one millisecond before the close, and the other six decide the Bid', () => {
		const gates = evaluate(auctionClosingAt(CLOSES), RAISE, '2026-08-27T08:59:59.999Z');
		expect(gates.expiry.passed).toBe(true);
		expect(allGatesPassed(gates)).toBe(true);
		expect(decide(auctionClosingAt(CLOSES), RAISE, '2026-08-27T08:59:59.999Z', null).kind).toBe(
			'accepted'
		);
	});

	it('REFUSES at exactly the close instant', () => {
		// Story 3.5 supplies each Auction its own nominal expiry as `now`, so
		// a Bid at that instant must not beat the close.
		const gates = evaluate(auctionClosingAt(CLOSES), RAISE, CLOSES);
		expect(gates.expiry.passed).toBe(false);
		expect(failedGates(gates)).toEqual(['expiry']);
	});

	it('refuses one millisecond after, and identically thirty days after', () => {
		for (const now of ['2026-08-27T09:00:00.001Z', '2026-09-26T09:00:00.000Z']) {
			const gates = evaluate(auctionClosingAt(CLOSES), RAISE, now);
			// No gate's answer drifts with the size of the gap: a sweep
			// stalled for a month refuses exactly as one stalled for a
			// millisecond does, and nothing was accepted in the interim.
			expect(failedGates(gates), now).toEqual(['expiry']);
			expect(gates.expiry.closesAt, now).toBe(CLOSES);
			expect(gates.expiry.evaluatedAt, now).toBe(now);
		}
	});

	it('passes when nobody has bid — no Opening Bid, so no clock to run out', () => {
		const gates = evaluate(NO_BIDS, command(1_500_000), '2099-01-01T00:00:00.000Z');
		expect(gates.expiry).toEqual({
			passed: true,
			closesAt: null,
			evaluatedAt: '2099-01-01T00:00:00.000Z'
		});
		// The `opening` gate is what decides such a Bid, and it does.
		expect(failedGates(evaluate(NO_BIDS, command(500_000), NOW))).toEqual(['opening']);
	});

	it('reads an unreadable close instant as expired', () => {
		const gates = evaluate(auctionClosingAt('nonsense'), RAISE, NOW);
		expect(gates.expiry.passed).toBe(false);
		expect(gates.expiry.closesAt).toBe('nonsense');
	});

	it('PASSES on an empty or unreadable `now`, and decide() still throws its TypeError', () => {
		// A clock the shell failed to supply is a bug, and AD-1 makes a shell
		// bug a throw rather than a returned refusal. Refusing here would
		// swallow that throw into a Manager-facing statement that is not true.
		for (const now of ['', 'nonsense']) {
			const gates = evaluate(auctionClosingAt(CLOSES), RAISE, now);
			expect(gates.expiry.passed, now).toBe(true);
			expect(allGatesPassed(gates), now).toBe(true);
			expect(() => decide(auctionClosingAt(CLOSES), RAISE, now, null), now).toThrow(TypeError);
		}
	});

	it('never reads whether a projection still holds the Auction — only the two instants', () => {
		// The IDENTICAL state, folded and still present in `OpenAuctions`,
		// with no `AuctionClosed` anywhere: accepted before its close and
		// refused after it. That is AD-12's "never reads a projection's open
		// flag as authority", stated as a behaviour rather than as a claim.
		const state = auctionClosingAt(CLOSES);
		expect(decide(state, RAISE, '2026-08-27T08:59:59.999Z', null).kind).toBe('accepted');
		expect(decide(state, RAISE, '2026-08-27T09:00:00.001Z', null).kind).toBe('rejected');
	});

	it('carries the two instants, and no money field and no count', () => {
		const outcome = evaluate(auctionClosingAt(CLOSES), RAISE, '2026-08-27T11:00:00.000Z').expiry;
		expect(Object.keys(outcome).sort()).toEqual(['closesAt', 'evaluatedAt', 'passed']);
		expect(outcome).toEqual({
			passed: false,
			closesAt: CLOSES,
			evaluatedAt: '2026-08-27T11:00:00.000Z'
		});
	});

	it('reports both grounds, in PLACE_BID_GATES order, when the clock AND the cap refuse', () => {
		const poor: TeamMoneyState = {
			capSpace: parseMoney(9_000_000),
			rosterCount: 9,
			leading: [],
			eligibleLeading: [],
			minorLeagueOccupied: 0
		};
		const bid = leading(8_000_000);
		const state = bidStateFor(
			{
				fantraxPlayerId: 'p-1',
				contention: 'standard',
				leadingBid: { ...bid, closesAt: CLOSES },
				closesAt: CLOSES,
				bids: [{ ...bid, closesAt: CLOSES }],
				contenders: [],
				seedHash: null
			},
			poor,
			false
		);
		// A $30.0M offer is far over whatever this Team's Maximum Bid is, and
		// the Auction is two hours past its close as well.
		const gates = evaluate(state, command(30_000_000), '2026-08-27T11:00:00.000Z');
		expect(failedGates(gates)).toEqual(['expiry', 'cap']);
		const delta = bidRefusalDelta({ kind: 'gates', gates });
		// The clock's sentence comes FIRST — the reading order is the
		// declared order — and each ground states its own arithmetic.
		expect(delta.indexOf(AUCTION_EXPIRED)).toBe(0);
		expect(delta).toContain('exceeds your Maximum Bid');
	});
});

describe('expiry — the sentence, the figure and the chip (AC2)', () => {
	const expiredGates = () => evaluate(auctionClosingAt(CLOSES), RAISE, '2026-08-27T11:00:00.000Z');

	it('names a clock and an elapsed time, and quotes no money figure and no count', () => {
		const delta = bidRefusalDelta({ kind: 'gates', gates: expiredGates() });
		expect(delta).toContain(AUCTION_EXPIRED);
		expect(delta).toContain('Auction Clock');
		expect(delta).toContain('2 hours ago');
		// No money anywhere in it, and no roster count either: this Bid was
		// not too large and the roster was not too full — the Auction was
		// over, and a refusal quoting a ground it did not decide on would be
		// the defect AD-7 names.
		expect(delta).not.toContain('$');
		expect(delta).not.toContain('Maximum Bid');
		expect(delta).not.toContain('Roster Count');
		expect(delta).not.toContain('Roster Capacity');
	});

	it('says "at an unknown time" rather than inventing a second wording for an unreadable close', () => {
		const gates = evaluate(auctionClosingAt('nonsense'), RAISE, NOW);
		expect(bidRefusalDelta({ kind: 'gates', gates })).toContain('at an unknown time');
	});

	it('labels the chip with the glossary term, so it cannot be read as Cap or Slots', () => {
		const row = bidGateReport(expiredGates()).find((entry) => entry.gate === 'expiry');
		expect(row?.label).toBe('Auction Clock');
		expect(row?.chip).toBe('Auction Clock · Refused');
	});

	it('reports the row FIRST, above the cap and the slots rows', () => {
		const rows = bidGateReport(expiredGates());
		expect(rows.map((row) => row.gate)).toEqual([...PLACE_BID_GATES]);
		expect(rows[0]?.gate).toBe('expiry');
	});

	it('states one figure for passed and refused alike — the clock left, from closesInPhrase', () => {
		const refused = bidGateReport(expiredGates()).find((row) => row.gate === 'expiry');
		expect(refused?.figure).toBe('no time left');

		const running = bidGateReport(
			evaluate(auctionClosingAt(CLOSES), RAISE, '2026-08-27T04:48:00.000Z')
		).find((row) => row.gate === 'expiry');
		expect(running?.chip).toBe('Auction Clock · Passed');
		expect(running?.figure).toBe('4h 12m left');
	});

	it('states an unreadable close time rather than contradicting its own chip', () => {
		// `hasExpired` fails CLOSED on an instant it cannot read, so the chip
		// says Refused. `closesInPhrase` answers `an unknown time left` for
		// that same input, and printing THAT beside a Refused chip would say
		// time may still remain next to a verdict saying it does not. The
		// figure is therefore keyed on readability, and the two agree.
		const row = bidGateReport(evaluate(auctionClosingAt('nonsense'), RAISE, NOW)).find(
			(entry) => entry.gate === 'expiry'
		);
		expect(row?.chip).toBe('Auction Clock · Refused');
		expect(row?.figure).toBe('the close time cannot be read');
		expect(row?.figure).not.toContain('left');
	});

	it('agrees between chip and figure in EVERY expiry case', () => {
		// The property the branch above exists to hold: a row saying Refused
		// never carries a figure that implies time remains, and a row saying
		// Passed never carries one that implies it does not.
		const cases: Array<[state: BidState, now: string]> = [
			[auctionClosingAt(CLOSES), '2026-08-27T04:48:00.000Z'],
			[auctionClosingAt(CLOSES), '2026-08-27T08:59:59.999Z'],
			[auctionClosingAt(CLOSES), CLOSES],
			[auctionClosingAt(CLOSES), '2026-09-26T09:00:00.000Z'],
			[auctionClosingAt('nonsense'), NOW],
			[NO_BIDS, NOW]
		];
		// The two figures that mean "this clock is done". Anything else on the
		// row asserts a quantity of time still to come.
		const statesNoTimeRemains = (figure: string) =>
			figure === 'no time left' || figure === 'the close time cannot be read';
		for (const [state, now] of cases) {
			const row = bidGateReport(evaluate(state, RAISE, now)).find(
				(entry) => entry.gate === 'expiry'
			);
			const refused = row?.chip === 'Auction Clock · Refused';
			const label = `${String(row?.figure)} / ${now}`;
			// Refused rows say the clock is done; passed rows never do.
			expect(statesNoTimeRemains(String(row?.figure)), label).toBe(refused);
		}
	});

	it('states there is no Auction Clock at all when nobody has bid', () => {
		const row = bidGateReport(evaluate(NO_BIDS, command(1_500_000), NOW)).find(
			(entry) => entry.gate === 'expiry'
		);
		expect(row?.chip).toBe('Auction Clock · Passed');
		expect(row?.figure).toBe('no Bids yet, so no Auction Clock');
	});

	it('words nothing for a gate that passed', () => {
		const gates = evaluate(auctionClosingAt(CLOSES), RAISE, '2026-08-27T04:48:00.000Z');
		expect(bidRefusalDelta({ kind: 'gates', gates })).toBe('');
	});
});

describe('expiry — the control the surface disables (AC6)', () => {
	it('blocks the control once the clock has run out, worded by the core', () => {
		const control = bidControlState({
			state: auctionClosingAt(CLOSES),
			fantraxPlayerId: 'p-1',
			viewerTeamId: 't-2',
			amountText: '8500000',
			confirmed: true,
			now: '2026-08-27T11:00:00.000Z'
		});

		expect(control.blocked).toBe(true);
		expect(control.refusingGates).toEqual(['expiry']);
		expect(control.detail).toContain(AUCTION_EXPIRED);
	});

	it('leaves the same control live one millisecond earlier', () => {
		const control = bidControlState({
			state: auctionClosingAt(CLOSES),
			fantraxPlayerId: 'p-1',
			viewerTeamId: 't-2',
			amountText: '8500000',
			confirmed: true,
			now: '2026-08-27T08:59:59.999Z'
		});

		expect(control.blocked).toBe(false);
		expect(control.detail).toBe(BID_READY);
	});
});
