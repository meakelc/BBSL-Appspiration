/**
 * Branded integer-dollar money type and its edge parsers (AD-8).
 *
 * Integer dollars end to end: no float, no decimal library, no cents. The same
 * `int8` column deserialises as a `string` through node-postgres and as a
 * `number` through PostgREST, so every runtime boundary parses explicitly into
 * `Money` before anything arithmetic happens to it.
 *
 * Three brands, deliberately mutually unassignable:
 *
 *  - `Money`        an integer-dollar amount the core will accept
 *  - `DisplayMoney` the abbreviated rendering; permitted in the UI and in
 *                   Discord payloads, which are a view of the same figures for
 *                   the same readers
 *  - `ExportCell`   an exact integer for a CSV cell
 *
 * `DisplayMoney` is not assignable to `ExportCell`, so the CSV export path is
 * structurally unable to emit a rendering — which would silently corrupt the
 * Fantrax round-trip. That is a compile error, not a code-review convention.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness, stdlib
 * only, relative .ts imports only so Deno can load it (AD-2).
 */

import { MINIMUM_INCREMENT } from './constants.ts';

declare const MoneyBrand: unique symbol;
declare const DisplayBrand: unique symbol;
declare const ExportBrand: unique symbol;

/** An amount in whole dollars, parsed at a boundary and never a bare number. */
export type Money = number & { readonly [MoneyBrand]: never };

/** The abbreviated rendering. UI and Discord only — never a CSV cell. */
export type DisplayMoney = string & { readonly [DisplayBrand]: never };

/** An exact integer-dollar string bound for a CSV cell. Never a rendering. */
export type ExportCell = string & { readonly [ExportBrand]: never };

/** Dollars per rendered tenth. One tenth of a million. */
const DOLLARS_PER_TENTH = 100_000;

/** Dollars per rendered whole unit. */
const DOLLARS_PER_MILLION = 1_000_000;

/** U+2212 MINUS SIGN. Not a hyphen — DESIGN.md is explicit about this. */
const MINUS_SIGN = '−';

/**
 * Exactly an optionally-signed canonical integer. No exponent, no decimal
 * point, and no leading zeros — `"007"` and `"-00"` are refused here rather
 * than downstream, because a driver never pads and padding means the value
 * came from somewhere it should not have.
 */
const INTEGER_TEXT = /^-?(?:0|[1-9][0-9]*)$/;

/**
 * Parse a value arriving from any runtime boundary into `Money`.
 *
 * Accepts the two shapes an `int8` actually arrives as — a `string` from
 * node-postgres, a `number` from PostgREST — and refuses everything else
 * loudly. A money value that cannot be parsed is corruption or a wiring
 * mistake, never a rule violation, so this throws rather than returning a
 * refusal (AD-1: a thrown exception signals a bug and nothing else).
 */
export function parseMoney(value: unknown): Money {
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value)) {
			throw new TypeError(
				`money must be a whole number of dollars within safe-integer range, received ${String(value)}`
			);
		}
		return (value === 0 ? 0 : value) as Money;
	}

	if (typeof value === 'string') {
		const text = value.trim();
		if (!INTEGER_TEXT.test(text)) {
			throw new TypeError(
				`money text must be an optionally-signed run of digits, received ${JSON.stringify(value)}`
			);
		}
		const parsed = Number(text) === 0 ? 0 : Number(text);
		if (!Number.isSafeInteger(parsed)) {
			throw new TypeError(
				`money text ${JSON.stringify(text)} exceeds safe-integer range and would be rounded`
			);
		}
		// Round-trip: catches anything the Number conversion altered. The regex
		// above already guarantees a canonical form, so `"-0"` is the only legal
		// input whose text differs from its parsed rendering — `String(-0)` is
		// `"0"`. An earlier version special-cased every negative zero-magnitude
		// string here instead, which let `"-00"` through while `"00"` was refused.
		if (text !== '-0' && String(parsed) !== text) {
			throw new TypeError(`money text ${JSON.stringify(text)} does not round-trip as an integer`);
		}
		return parsed as Money;
	}

	throw new TypeError(`money must arrive as a string or a number, received ${typeof value}`);
}

/** Re-brand a computed amount, refusing anything that left integer range. */
function brand(result: number, operation: string): Money {
	if (!Number.isSafeInteger(result)) {
		throw new RangeError(`${operation} left safe-integer range: ${String(result)}`);
	}
	return (result === 0 ? 0 : result) as Money;
}

/** Sum. Brand-preserving, so the result stays usable as `Money`. */
export function addMoney(a: Money, b: Money): Money {
	return brand(a + b, 'addMoney');
}

/** Difference. May be negative — Available Cap Space legitimately is. */
export function subtractMoney(a: Money, b: Money): Money {
	return brand(a - b, 'subtractMoney');
}

/**
 * Scale by a whole count — Roster Reserve is `MINIMUM_BID × holes`. The factor
 * is a count, not money, which is why it is a plain integer.
 */
export function multiplyMoney(amount: Money, factor: number): Money {
	if (!Number.isSafeInteger(factor)) {
		throw new TypeError(`money may only be scaled by a whole count, received ${String(factor)}`);
	}
	return brand(amount * factor, 'multiplyMoney');
}

/** Ordering, for explicitly sorted sequences (AD-1 forbids incidental order). */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/**
 * Whether `amount` sits on the `MINIMUM_INCREMENT` grid — exactly the
 * predicate `formatMoney` throws on.
 *
 * Exported so a caller can ASK before rendering rather than catch a
 * `RangeError` to find out. An imported Cap Hit is a real-world salary
 * figure with no guarantee it sits on the app's own $500,000 grid, so the
 * import preview must decide between the abbreviated rendering and exact
 * integer dollars before it calls either. Control flow through an exception
 * would also make "off the grid" indistinguishable from a genuine bug, which
 * is what `RangeError` means everywhere else in this module (AD-1).
 *
 * The magnitude is taken first so a negative amount answers the same as its
 * positive twin — `formatMoney` tests the magnitude too, and the two must
 * not disagree about any value.
 */
export function isOnMoneyGrid(amount: Money): boolean {
	const magnitude = amount < 0 ? -amount : amount;
	return magnitude % MINIMUM_INCREMENT === 0;
}

/**
 * Render for display: `$14.5M`, always exactly one decimal, never dropped.
 *
 * Lossless rather than rounded, and only because every BBSL figure sits on the
 * `MINIMUM_INCREMENT` grid: an amount on that grid has a tenths digit of
 * exactly 0 or 5 and nothing else, so the digits are taken by remainder and
 * exact division and concatenated. Nothing here is a floating-point operation
 * to be rounded — an off-grid amount is refused rather than made to fit.
 */
export function formatMoney(amount: Money): DisplayMoney {
	const negative = amount < 0;
	const magnitude = negative ? -amount : amount;

	// The grid test is `isOnMoneyGrid`'s, called rather than repeated: two
	// copies of this predicate could disagree, and a caller that asked first
	// and then rendered would get a `RangeError` it had already ruled out.
	if (!isOnMoneyGrid(amount)) {
		throw new RangeError(
			`${String(amount)} is not on the $${String(MINIMUM_INCREMENT)} grid and cannot be rendered at one decimal place`
		);
	}

	const remainder = magnitude % DOLLARS_PER_MILLION;
	const millions = (magnitude - remainder) / DOLLARS_PER_MILLION;
	const tenths = remainder / DOLLARS_PER_TENTH;

	return `${negative ? MINUS_SIGN : ''}$${String(millions)}.${String(tenths)}M` as DisplayMoney;
}

/**
 * Render an exact figure in full: `$300,000`, `−$6,700,000`. Lossless at any
 * amount, on the grid or off it.
 *
 * **This is a diagnostic renderer, not a second surface rendering.** AD-8's
 * one-rendering rule is about the figures a Manager reads off a gate outcome,
 * and those still go through `formatMoney`/`describeAmount` — `$14.5M`,
 * always. What this is for is the case `describeAmount` cannot serve: a
 * REFUSAL that has to state its own arithmetic, where the amount may be off
 * the grid and "an amount that is not on the grid" would leave the
 * Commissioner unable to check the sum. An off-grid figure is real — the CSV
 * roster importer asserts no grid, so an imported Cap Hit carries whatever
 * Fantrax held — and a refusal that cannot name it is a refusal that cannot
 * be acted on.
 *
 * Grouping is by hand for `pool-filter.ts`'s reason: the platform's
 * locale-aware number formatters read ICU data that differs between Node and
 * Deno, and `check-core-purity.js` fails the build on `Intl` for exactly that
 * divergence (AD-2). They are not named here in full, because
 * `tests/money.test.ts`'s guard is a substring scan over this whole file,
 * comments included — naming one would disarm the check that forbids it.
 *
 * Two older private spellings of this exist — `teams-index.ts`'s
 * `exactDollars` (grouped, applied to one compile-time constant) and the
 * off-grid branch of `import-preview.ts`'s `renderCapSpace` (ungrouped).
 * Neither is folded in here: doing so would change rendered output on two
 * shipped surfaces, which is a cleanup of its own rather than a line in this
 * refusal.
 */
export function formatExactDollars(amount: Money): string {
	const negative = amount < 0;
	const digits = String(negative ? -amount : amount);
	let grouped = '';
	for (let i = 0; i < digits.length; i += 1) {
		if (i > 0 && (digits.length - i) % 3 === 0) grouped += ',';
		grouped += digits[i];
	}
	return `${negative ? MINUS_SIGN : ''}$${grouped}`;
}

/**
 * Encode for a CSV cell: exact integer dollars, never a rendering (AD-24).
 *
 * The distinct brand is the whole point. A CSV writer accepting `ExportCell`
 * cannot be handed `formatMoney()`'s output, so `$14.5M` reaching a Fantrax
 * round-trip is a compile error rather than a silent data corruption found
 * next offseason.
 */
export function toExportDollars(amount: Money): ExportCell {
	return String(amount) as ExportCell;
}

// --- The League Median -----------------------------------------------------

/**
 * The index of the median value in an ASCENDING sequence of `count` values —
 * the lower of the two middles when the count is even (Story 4.6).
 *
 * **The rule is spelled exactly once, here.** `medianMoney` and `medianCount`
 * differ only in their comparator; they must not differ in where they look,
 * because the money half and the slot half of PRD §10 example 28 are the same
 * rule and two spellings of it are two things that can drift.
 *
 * `ceil(count / 2) - 1` is that index: 1 value gives 0; 2 give 0, the LOWER
 * middle; 3 give 1; 29 give 14; 30 give 14, which is the 15th row and exactly
 * what example 28 asks for.
 *
 * `null` for an empty sequence. There is no median of nothing, and `0` would
 * be a figure — `$0.0M`, or a Team with no free Slots — where the truth is
 * that the question was never answerable. `amountLabel`'s policy in
 * `core/team-view.ts`, in the one module that can state it.
 */
function lowerMiddleIndex(count: number): number | null {
	if (!Number.isFinite(count) || count <= 0) return null;
	return Math.ceil(count / 2) - 1;
}

/**
 * The League Median of a set of money figures — the lower of the two middle
 * values, NEVER their mean (Story 4.6, `epic-4-context.md:24`).
 *
 * **Why the mean is refused.** The mean of `$4,000,000` and `$4,500,000` is
 * `$4,250,000`, which lands at $250,000 granularity — off the
 * `MINIMUM_INCREMENT` grid, which is precisely what `formatMoney` throws a
 * `RangeError` on. Rounding it back onto the grid would publish a figure no
 * Team holds and no Manager can reproduce by hand from the same rows. The
 * lower middle is always some real Team's own number, so it is always on the
 * grid — assertable through `isOnMoneyGrid` rather than argued — and always
 * renders losslessly at one decimal, which is the property every abbreviated
 * figure in this product rests on.
 *
 * This is a READ-MODEL AGGREGATE and not a rule: it authorises nothing, so it
 * lives here with the money arithmetic rather than behind `evaluate()` or
 * `decide()` (`ARCHITECTURE-SPINE.md:122`).
 *
 * The input is sorted as a COPY through `compareMoney` — the module's existing
 * ordering primitive, which exists for exactly this ("explicitly sorted
 * sequences") — so a caller's array is never reordered underneath it and the
 * answer is identical whatever order the values arrive in.
 */
export function medianMoney(values: readonly Money[]): Money | null {
	const at = lowerMiddleIndex(values.length);
	if (at === null) return null;
	const ascending = [...values].sort(compareMoney);
	return ascending[at] ?? null;
}

/**
 * The League Median of a set of whole counts — free roster Slots (Story 4.6).
 *
 * The slot half of §10 example 28: 2 and 3 give **2**, never `2.5`. Half a
 * roster Slot is not a thing that exists, and this is `medianMoney`'s rule
 * through `lowerMiddleIndex` rather than a second one — the only difference
 * between the two functions is the comparator.
 *
 * `null` for an empty sequence, for `medianMoney`'s reason.
 */
export function medianCount(values: readonly number[]): number | null {
	const at = lowerMiddleIndex(values.length);
	if (at === null) return null;
	const ascending = [...values].sort((a, b) => {
		if (a < b) return -1;
		if (a > b) return 1;
		return 0;
	});
	return ascending[at] ?? null;
}
