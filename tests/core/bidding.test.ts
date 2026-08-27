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
	AUCTION_CLOCK,
	MINIMUM_BID,
	MINIMUM_INCREMENT,
	SALARY_CAP
} from '../../src/lib/core/constants.ts';
import { BID_PLACED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import type { Auction, Bid } from '../../src/lib/core/projection/auctions.ts';
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
	leading: []
};

const NOW = '2026-08-26T09:00:00.000Z';

/** One leading Bid, as `auctionsReducer` would have folded it. */
function leading(amount: number, teamId = 't-1'): Bid {
	return {
		seq: '2',
		teamId,
		teamName: teamId === 't-1' ? 'Lakers' : 'Rockets',
		managerId: 'm-1',
		amount: parseMoney(amount),
		occurredAt: '2026-08-26T08:00:00.000Z',
		closesAt: '2026-08-27T08:00:00.000Z'
	};
}

/** An Auction in Standard Contention at `amount`, held by `teamId`. */
function standardAt(amount: number, teamId = 't-1'): BidState {
	const bid = leading(amount, teamId);
	const auction: Auction = {
		fantraxPlayerId: 'p-1',
		contention: 'standard',
		leadingBid: bid,
		closesAt: bid.closesAt,
		bids: [bid]
	};
	// Narrowed through the core's own bridge, so these fixtures exercise the
	// same path `server/bidding.ts` and `server/auction-page.ts` take.
	return bidStateFor(auction, RICH);
}

/** A nominated Player nobody has bid on. */
const NO_BIDS: BidState = bidStateFor(null, RICH);

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
	it('declares exactly five gates for PlaceBid, in one place', () => {
		// Four in Story 2.5, five in 2.6. The list is asserted literally rather
		// than by length so ADDING a gate is a deliberate edit here as well as
		// in `core/types.ts` — which is the whole point of it living in one
		// place. Story 2.7 adds `slots` and 3.1 adds `expiry`.
		expect([...PLACE_BID_GATES]).toEqual([
			'opening',
			'selfBid',
			'increment',
			'granularity',
			'cap'
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
			[standardAt(1_000_000), 1_000_001, 't-2']
		];
		for (const [state, amount, teamId] of cases) {
			const gates = evaluate(state, command(amount, teamId), NOW);
			const decided = decide(state, command(amount, teamId), NOW, null);
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

	it('refuses an Opening Bid of exactly $1,000,000 by name — no lottery is created', () => {
		const gates = evaluate(NO_BIDS, command(MINIMUM_BID), NOW);
		expect(gates.opening.passed).toBe(false);
		expect(gates.opening.opening).toBe('at_the_minimum');
		// And it is the ONLY gate that refuses it: $1,000,000 is on the grid,
		// there is no high to clear and no Team leads.
		expect(failedGates(gates)).toEqual(['opening']);
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

	it('is $1,500,000 with no Bid — above the lottery amount AND on the grid', () => {
		expect(minimumLegalBid(NO_BIDS)).toBe(1_500_000);
	});

	it('always passes every gate it was derived for', () => {
		for (const state of [NO_BIDS, standardAt(8_000_000), standardAt(MINIMUM_BID)]) {
			const amount = minimumLegalBid(state);
			const gates = evaluate(state, command(amount, 't-99'), NOW);
			expect(allGatesPassed(gates), String(amount)).toBe(true);
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

	it('names the lottery ground for an Opening Bid of exactly $1,000,000', () => {
		const gates = evaluate(NO_BIDS, command(MINIMUM_BID), NOW);
		expect(bidRefusalDetail({ kind: 'gates', gates })).toContain('Minimum-Bid Contention');
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

	it('names no capacity gate and no exposure arithmetic — those are 2.7 and 2.8', () => {
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
		// The money vocabulary is Story 2.6's and is now expected in a cap
		// refusal — `Maximum Bid` above all. What must still be absent is the
		// CAPACITY gate's wording (2.7) and the exposure arithmetic (2.8),
		// because reporting a capacity refusal as a cap refusal is a defect
		// (AD-7) and an unbounded Maximum Bid does not exist yet.
		//
		// `Minors Exposure` is deliberately not forbidden: it is a named term
		// in the breakdown, structurally zero, because FR-13 requires the
		// refusal to show it and a breakdown missing a component would not
		// sum. What 2.8 adds is a non-zero value, not the words.
		for (const forbidden of [
			/roster capacity/i,
			/no roster slot/i,
			/free minor league/i,
			/eligible leading bid/i,
			/overflow/i,
			/no cap limit/i,
			/unbounded/i
		]) {
			expect(everything, String(forbidden)).not.toMatch(forbidden);
		}
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
		// And nothing smaller does.
		expect(allGatesPassed(evaluate(NO_BIDS, command(1_000_000), NOW))).toBe(false);
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

	it('blocks a TYPED Opening Bid of exactly $1,000,000 with the lottery sentence', () => {
		const control = controlFor(NO_BIDS, '1000000');
		expect(control.blocked).toBe(true);
		expect(control.refusingGates).toEqual(['opening']);
		expect(control.detail).toContain('Minimum-Bid Contention');
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
				const decided = decide(state, command(Number(typed)), NOW, null);
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
	}): TeamMoneyState {
		return {
			capSpace: parseMoney(input.capSpace),
			rosterCount: input.rosterCount,
			leading: (input.leading ?? []).map(([fantraxPlayerId, amount]) => ({
				fantraxPlayerId,
				amount: parseMoney(amount)
			}))
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
			closesAt: '2026-08-27T08:00:00.000Z'
		};
		return {
			fantraxPlayerId,
			contention,
			leadingBid: bid,
			closesAt: bid.closesAt,
			bids: [bid]
		};
	}

	const capOf = (state: BidState, amount: number) => evaluate(state, command(amount), NOW).cap;

	it('reports every figure, and they sum exactly as the panel prints them', () => {
		const state = bidStateFor(null, team({ capSpace: 12_000_000, rosterCount: 9 }));
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
			isMinorLeagueEligible: () => false
		});

		expect(money.leading).toEqual([{ fantraxPlayerId: 'p-2', amount: 3_000_000 }]);
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
			isMinorLeagueEligible: () => false
		});

		expect(money.leading).toEqual([{ fantraxPlayerId: 'p-mine', amount: 3_000_000 }]);
	});

	it('excludes a Minor League Eligible Player — that money reaches the cap only via Minors Exposure', () => {
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
			isMinorLeagueEligible: (id) => id === 'p-eligible'
		});

		// FR-14: an eligible lead is not a smaller contribution to Committed
		// Bids — it is not in Committed Bids at all. Story 2.8 adds the set it
		// feeds instead.
		expect(money.leading).toEqual([{ fantraxPlayerId: 'p-flat', amount: 3_000_000 }]);
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
			isMinorLeagueEligible: () => false
		});

		expect(money.leading).toEqual([{ fantraxPlayerId: 'p-lottery', amount: MINIMUM_BID }]);
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
			isMinorLeagueEligible: () => false
		});

		expect(money.leading.map((lead) => lead.fantraxPlayerId)).toEqual(['p-a', 'p-m', 'p-z']);
	});

	it('reports absence rather than zeroes when the actor is bound to no Team', () => {
		const cap = capOf(bidStateFor(null, null), 1_500_000);

		// All nine figures null together, and the gate PASSES — the refusal an
		// unbound Manager sees is `unbound_actor`, raised before any
		// transaction opens. Stating $0 would be an invented figure a panel
		// would then print.
		expect(cap.passed).toBe(true);
		expect(cap.capSpace).toBeNull();
		expect(cap.committedBids).toBeNull();
		expect(cap.minorsExposure).toBeNull();
		expect(cap.availableCapSpace).toBeNull();
		expect(cap.rosterCount).toBeNull();
		expect(cap.projectedAdditions).toBeNull();
		expect(cap.rosterReserve).toBeNull();
		expect(cap.maximumBid).toBeNull();
		// And nothing to render, rather than a column of zeroes.
		expect(capBreakdown(cap)).toEqual([]);
	});

	it('carries a negative Available Cap Space honestly rather than clamping it', () => {
		// Only the ROSTER RESERVE has a clamp. A Team that is over-committed
		// has a genuinely negative Maximum Bid, and reporting $0 would imply it
		// could still open at the minimum.
		const state = bidStateFor(
			null,
			team({ capSpace: 2_000_000, rosterCount: 11, leading: [['p-2', 5_000_000]] })
		);
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
		const state = bidStateFor(null, team({ capSpace: 3_000_000, rosterCount: 10 }));
		const gates = evaluate(state, command(9_400_000), NOW);

		expect(gates.granularity.passed).toBe(false);
		expect(gates.cap.passed).toBe(false);
		expect(failedGates(gates)).toEqual(['granularity', 'cap']);
		// Each keeps its own figures.
		expect(gates.granularity.grid).toBe(MINIMUM_INCREMENT);
		expect(gates.cap.maximumBid).toBe(2_000_000);
	});

	it('is reported on an ACCEPTED result too, with the identical shape', () => {
		const state = bidStateFor(null, team({ capSpace: 12_000_000, rosterCount: 9 }));
		const accepted = evaluate(state, command(1_500_000), NOW);
		const refused = evaluate(state, command(10_500_000), NOW);

		expect(Object.keys(accepted).sort()).toEqual(Object.keys(refused).sort());
		expect(accepted.cap.passed).toBe(true);
		expect(accepted.cap.maximumBid).toBe(refused.cap.maximumBid);
	});
});

describe('the refusal panel content, worded by the core and nowhere else', () => {
	const PANEL_STATE = bidStateFor(null, {
		capSpace: parseMoney(12_000_000),
		rosterCount: 9,
		leading: []
	});

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
		leading: []
	});

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
			leading: []
		});
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
