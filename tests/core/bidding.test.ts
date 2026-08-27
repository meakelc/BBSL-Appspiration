/**
 * The bidding gate: `evaluate()`, `decide()`, and the one sentence each
 * refusal has (Story 2.5).
 *
 * Every test here calls the pure core directly against a state literal — no
 * database, no HTTP, no clock mocking (AD-25's discipline, applied to the
 * whole gate rather than only to the §10 examples in `tests/examples/`).
 */

import { describe, expect, it } from 'vitest';

import { AUCTION_CLOCK, MINIMUM_BID, MINIMUM_INCREMENT } from '../../src/lib/core/constants.ts';
import { BID_PLACED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import type { Auction, Bid } from '../../src/lib/core/projection/auctions.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	BID_CONSEQUENCE,
	BID_READY,
	allGatesPassed,
	bidConsequenceSentence,
	bidControlState,
	bidRefusalDetail,
	bidStateFor,
	decide,
	describeAmount,
	evaluate,
	failedGates,
	minimumLegalBid,
	minimumLegalSentence,
	readBidAmount
} from '../../src/lib/core/rules/bidding.ts';
import type { BidPlacedPayload, BidState } from '../../src/lib/core/rules/bidding.ts';
import { PLACE_BID_GATES } from '../../src/lib/core/types.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

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
	return bidStateFor(auction);
}

/** A nominated Player nobody has bid on. */
const NO_BIDS: BidState = bidStateFor(null);

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
	it('declares exactly four gates for PlaceBid, in one place', () => {
		expect([...PLACE_BID_GATES]).toEqual(['opening', 'selfBid', 'increment', 'granularity']);
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

	it('names no money or capacity gate — those are Stories 2.6 and 2.7', () => {
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
		for (const forbidden of [
			/maximumBid/i,
			/committed bids/i,
			/minors exposure/i,
			/roster reserve/i,
			/roster count/i,
			/no money/i,
			/roster slot/i,
			/cap space/i
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
