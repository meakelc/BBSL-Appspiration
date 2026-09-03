/**
 * PRD §10 example 28 — **The median lands between two grid values** (FR-39).
 *
 * > The 30 Teams' Available Cap Space figures are sorted ascending; the 15th
 * > is $4,000,000 and the 16th is $4,500,000. The conventional median — the
 * > mean of the two middle values — is **$4,250,000**, which is *not* a whole
 * > multiple of $500,000 and cannot be rendered losslessly at one decimal:
 * > `$4.3M` is wrong by $50,000, and `$4.25M` breaks the one-decimal rule the
 * > entire money rendering depends on. The **League Median is therefore
 * > $4,000,000**, the lower middle value, which renders as `$4.0M` and is a
 * > figure a real Team actually holds. The same rule applies to slots: with a
 * > 15th value of 2 Free Active/Bench Slots and a 16th of 3, the League Median
 * > is **2**, not 2.5 — half a roster slot is not a thing that exists.
 *
 * This is the example that pays for the median being written as an INDEX into
 * a sorted copy rather than as arithmetic on two values. The mean is not
 * merely a different answer here, it is an unrenderable one: `formatMoney`
 * throws a `RangeError` on $4,250,000, so a mean would surface as a 500 rather
 * than as a wrong figure — and the fix a reader reaches for under that pressure
 * is rounding, which publishes a number no Team holds.
 *
 * Both halves are one rule. `medianMoney` and `medianCount` differ only in
 * their comparator, which is why the slot half is in this file rather than in
 * a separate one: if they ever disagree, they disagree here.
 *
 * Calls the core directly — no database, no HTTP, no clock mocking.
 */

import { describe, expect, it } from 'vitest';

import {
	formatMoney,
	isOnMoneyGrid,
	medianCount,
	medianMoney,
	parseMoney
} from '../../src/lib/core/money.ts';
import type { Money } from '../../src/lib/core/money.ts';

/**
 * Thirty Available Cap Space figures whose 15th and 16th, ascending, are
 * exactly the example's two — every other Team is deliberately far enough away
 * on both sides that no other pair could be mistaken for the middle.
 *
 * They are supplied SHUFFLED rather than sorted, because a median that only
 * worked on pre-sorted input would pass a sorted fixture and fail the index,
 * whose rows arrive in Team-name order.
 */
const FIFTEENTH = parseMoney(4_000_000);
const SIXTEENTH = parseMoney(4_500_000);

function thirtyAvailableFigures(): Money[] {
	// Fourteen Teams strictly poorer than the 15th and fourteen strictly richer
	// than the 16th, so no other pair could be mistaken for the middle. They
	// repeat one figure each on purpose: thirty Teams on a $500,000 grid share
	// figures constantly, and a fixture of thirty distinct values would be the
	// unrepresentative case.
	const below: Money[] = [];
	for (let i = 0; i < 14; i += 1) below.push(parseMoney(1_000_000));
	const over: Money[] = [];
	for (let i = 0; i < 14; i += 1) over.push(parseMoney(10_000_000));

	// Interleaved, so the input order is nothing like the sorted order.
	const shuffled: Money[] = [];
	for (let i = 0; i < 14; i += 1) {
		shuffled.push(over[i] as Money, below[i] as Money);
	}
	shuffled.splice(7, 0, SIXTEENTH);
	shuffled.splice(19, 0, FIFTEENTH);
	return shuffled;
}

describe('PRD §10 example 28 — the median lands between two grid values', () => {
	it('sorts thirty figures whose 15th and 16th are the example’s own two', () => {
		const figures = thirtyAvailableFigures();
		expect(figures).toHaveLength(30);
		const ascending = [...figures].sort((a, b) => a - b);
		// 0-based 14 and 15 are the 15th and 16th.
		expect(ascending[14]).toBe(4_000_000);
		expect(ascending[15]).toBe(4_500_000);
	});

	it('answers $4,000,000 — the LOWER middle, never the mean', () => {
		const median = medianMoney(thirtyAvailableFigures());
		expect(median).toBe(4_000_000);
		// The conventional mean-of-two-middles, named so the assertion below is
		// unmistakably about refusing it rather than about arithmetic luck.
		const mean = (4_000_000 + 4_500_000) / 2;
		expect(mean).toBe(4_250_000);
		expect(median).not.toBe(mean);
	});

	it('renders as $4.0M — never $4.3M, never $4.25M, never $4,250,000', () => {
		const median = medianMoney(thirtyAvailableFigures());
		expect(median).not.toBeNull();
		const rendered = formatMoney(median as Money);
		expect(rendered).toBe('$4.0M');
		expect(rendered).not.toBe('$4.3M');
		expect(rendered).not.toBe('$4.25M');
	});

	it('lands on the grid, so the renderer cannot throw — and the mean does not', () => {
		const median = medianMoney(thirtyAvailableFigures());
		expect(isOnMoneyGrid(median as Money)).toBe(true);
		expect(() => formatMoney(median as Money)).not.toThrow();

		// The half of the example that explains WHY the lower middle is the
		// rule: the mean is off the $500,000 grid and the product has no
		// lossless spelling for it, so it surfaces as a RangeError rather than
		// as a subtly wrong figure.
		const mean = parseMoney(4_250_000);
		expect(isOnMoneyGrid(mean)).toBe(false);
		expect(() => formatMoney(mean)).toThrow(RangeError);
	});

	it('is a figure a real Team actually holds', () => {
		const figures = thirtyAvailableFigures();
		const median = medianMoney(figures);
		expect(figures).toContain(median);
	});

	/**
	 * The slot half. Same rule, different comparator — which is the point:
	 * half a roster Slot is not a thing that exists, and neither is a
	 * quarter-million-dollar grid step.
	 */
	it('answers 2 free Slots, never 2.5, for a 15th of 2 and a 16th of 3', () => {
		const slots: number[] = [];
		for (let i = 0; i < 14; i += 1) slots.push(0);
		slots.push(2, 3);
		for (let i = 0; i < 14; i += 1) slots.push(12);
		expect(slots).toHaveLength(30);

		const shuffled = [...slots].reverse();
		const median = medianCount(shuffled);
		expect(median).toBe(2);
		expect(median).not.toBe(2.5);
		expect(Number.isInteger(median)).toBe(true);
	});

	it('answers the same under every input order, money and slots alike', () => {
		const figures = thirtyAvailableFigures();
		const answer = medianMoney(figures);
		expect(medianMoney([...figures].reverse())).toBe(answer);
		expect(medianMoney([...figures].sort((a, b) => a - b))).toBe(answer);
		expect(medianMoney([...figures].sort((a, b) => b - a))).toBe(answer);
	});
});
