import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
	addMoney,
	compareMoney,
	formatExactDollars,
	formatMoney,
	isOnMoneyGrid,
	medianCount,
	medianMoney,
	multiplyMoney,
	parseMoney,
	subtractMoney,
	toExportDollars,
	type ExportCell,
	type Money
} from '../src/lib/core/money.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MONEY_SOURCE = readFileSync(join(ROOT, 'src', 'lib', 'core', 'money.ts'), 'utf8');

/** U+2212, the character the renderer must use. The codepoint is asserted
 *  separately below, so this still fails if an editor silently normalises
 *  either file's minus sign to a hyphen. */
const MINUS = '−';

describe('money crosses a runtime boundary exactly once', () => {
	it('parses the string node-postgres delivers for an int8', () => {
		expect(parseMoney('8500000')).toBe(8500000);
	});

	it('parses the number PostgREST delivers for the same column', () => {
		expect(parseMoney(8500000)).toBe(8500000);
	});

	it('converges both wire shapes on one value', () => {
		expect(parseMoney('8500000')).toBe(parseMoney(8500000));
	});

	it('parses negatives and zero', () => {
		expect(parseMoney('-4000000')).toBe(-4000000);
		expect(parseMoney(0)).toBe(0);
		expect(Object.is(parseMoney('-0'), 0)).toBe(true);
	});

	it('normalises negative zero on the numeric branch too', () => {
		// The number branch has its own normalisation, so it can regress
		// independently of the string branch above.
		expect(Object.is(parseMoney(-0), 0)).toBe(true);
	});

	it('tolerates surrounding whitespace, deliberately', () => {
		// A driver never pads, so this leniency costs nothing and is recorded
		// here so a future tightening is a decision rather than an accident.
		expect(parseMoney(' 8500000 ')).toBe(8500000);
	});

	const REFUSED: ReadonlyArray<[string, unknown]> = [
		['a fractional number', 8500000.5],
		['exponent notation', '8.5e6'],
		['a decimal point in text', '8500000.0'],
		['a thousands separator', '8,500,000'],
		['leading zeros', '008500000'],
		['a bare padded zero', '00'],
		// '-00' parsed as 0 until the round-trip check was rewritten: its old
		// negative-zero special case compared against the literal '0' instead of
		// the supplied text, so every negative zero-magnitude padding slipped
		// through while the positive form was refused.
		['a negative zero with padding', '-00'],
		['a longer negative zero with padding', '-0000000'],
		['a leading plus sign', '+8500000'],
		['whitespace-only', '   '],
		['the empty string', ''],
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
		['null', null],
		['undefined', undefined],
		['a boolean', true],
		['an object', { amount: 8500000 }],
		['a bigint', 8500000n]
	];

	it.each(REFUSED)('refuses %s', (_name: string, value: unknown) => {
		expect(() => parseMoney(value)).toThrow();
	});

	it('refuses a value beyond safe-integer range rather than rounding it', () => {
		// Number("9007199254740993") is 9007199254740992 — a silent one-dollar
		// loss, which is exactly the class of bug the branded type exists for.
		expect(() => parseMoney('9007199254740993')).toThrow(/safe-integer/);
	});

	it('names what it received, so a bad column is findable', () => {
		expect(() => parseMoney(null)).toThrow(/object/);
		expect(() => parseMoney('8.5e6')).toThrow(/digits/);
	});
});

describe('arithmetic keeps the brand', () => {
	const cap = parseMoney(165_000_000);
	const bid = parseMoney(1_000_000);

	it('adds, subtracts and scales', () => {
		expect(addMoney(cap, bid)).toBe(166_000_000);
		expect(subtractMoney(cap, bid)).toBe(164_000_000);
		expect(multiplyMoney(bid, 12)).toBe(12_000_000);
	});

	it('allows a negative difference — Available Cap Space legitimately goes under', () => {
		expect(subtractMoney(bid, cap)).toBe(-164_000_000);
	});

	it('orders explicitly, for sequences a rule may depend on', () => {
		expect(compareMoney(bid, cap)).toBe(-1);
		expect(compareMoney(cap, cap)).toBe(0);
		expect(compareMoney(cap, bid)).toBe(1);
	});

	it('refuses a fractional scale factor', () => {
		expect(() => multiplyMoney(bid, 1.5)).toThrow(/whole count/);
	});

	it('permits a negative scale factor, and normalises the resulting zero', () => {
		// Not currently used by any rule — locked in so that if a later story
		// wants a negative count refused, that is a deliberate change with a
		// failing test, not a silent behavioural drift.
		expect(multiplyMoney(bid, -1)).toBe(-1_000_000);
		expect(Object.is(multiplyMoney(parseMoney(0), -1), 0)).toBe(true);
	});
});

describe('the renderer is lossless or it is loud', () => {
	const RENDERINGS: ReadonlyArray<[number, string]> = [
		[14_500_000, '$14.5M'],
		[12_000_000, '$12.0M'],
		[165_000_000, '$165.0M'],
		[1_000_000, '$1.0M'],
		[500_000, '$0.5M'],
		[0, '$0.0M']
	];

	it.each(RENDERINGS)('renders %d as %s', (amount: number, expected: string) => {
		expect(formatMoney(parseMoney(amount))).toBe(expected);
	});

	it('never drops the decimal, even on a whole million', () => {
		expect(formatMoney(parseMoney(12_000_000))).not.toBe('$12M');
	});

	it('uses a true minus sign, not a hyphen', () => {
		const rendered = formatMoney(parseMoney(-4_000_000));
		expect(rendered).toBe(`${MINUS}$4.0M`);
		expect(rendered.startsWith('-')).toBe(false);
		expect(rendered.codePointAt(0)).toBe(0x2212);
	});

	it.each([4_250_000, 250_000, -1_250_000, -499_999, -500_001, 1])(
		'refuses %d rather than rounding it onto the grid',
		(amount: number) => {
			expect(() => formatMoney(parseMoney(amount))).toThrow(/grid/);
		}
	);
});

describe('isOnMoneyGrid — the predicate formatMoney throws on, asked instead of caught', () => {
	it.each([0, 500_000, 1_000_000, 14_500_000, -4_000_000, -500_000])(
		'answers true for %d, which formatMoney renders',
		(amount: number) => {
			expect(isOnMoneyGrid(parseMoney(amount))).toBe(true);
			expect(() => formatMoney(parseMoney(amount))).not.toThrow();
		}
	);

	it.each([1, 250_000, 4_250_000, -1_250_000, -499_999, -500_001])(
		'answers false for %d, which is exactly what formatMoney refuses',
		(amount: number) => {
			expect(isOnMoneyGrid(parseMoney(amount))).toBe(false);
			expect(() => formatMoney(parseMoney(amount))).toThrow(/grid/);
		}
	);

	it('answers the same for an amount and its negation — the magnitude is what is tested', () => {
		for (const amount of [1, 250_000, 500_000, 14_500_000]) {
			expect(isOnMoneyGrid(parseMoney(amount))).toBe(isOnMoneyGrid(parseMoney(-amount)));
		}
	});
});

describe('the export path emits integers, never a rendering', () => {
	it('encodes exact dollars', () => {
		expect(toExportDollars(parseMoney(14_500_000))).toBe('14500000');
		expect(toExportDollars(parseMoney(-4_000_000))).toBe('-4000000');
	});

	it('never abbreviates', () => {
		expect(toExportDollars(parseMoney(14_500_000))).not.toContain('M');
		expect(toExportDollars(parseMoney(14_500_000))).not.toContain('$');
	});

	it('round-trips back through the parser', () => {
		const amount = parseMoney(14_500_000);
		expect(parseMoney(toExportDollars(amount))).toBe(amount);
	});
});

describe('the compile-time guarantees', () => {
	// These assertions are verified by `npm run check`, which type-checks
	// tests/**. Vitest itself strips types without checking them, so the
	// function below is never called — its value is that svelte-check reports
	// an error if any @ts-expect-error stops being an error.
	function neverRun(): void {
		// @ts-expect-error — an unparsed string is not Money; "8500000" + 500000
		// is the concatenation AD-8 exists to make impossible to write.
		const concatenated: Money = '8500000' + 500000;

		// @ts-expect-error — a bare number has not crossed the parser.
		const unparsed: Money = 8500000;

		// @ts-expect-error — arithmetic helpers take Money, not numbers.
		addMoney(1_000_000, 500_000);

		// @ts-expect-error — the CSV path cannot be handed a rendering.
		const cell: ExportCell = formatMoney(parseMoney(14_500_000));

		// @ts-expect-error — nor can it be handed an ordinary string.
		const rawCell: ExportCell = '14500000';

		void concatenated;
		void unparsed;
		void cell;
		void rawCell;
	}

	it('are declared, and checked by svelte-check rather than by vitest', () => {
		expect(neverRun).toBeTypeOf('function');
	});

	it('sit inside the directory the typechecker actually covers', () => {
		// The guarantees above are worth exactly as much as `npm run check`
		// covering tests/. The resolved include list comes from the generated
		// SvelteKit config, so a future config change could drop tests/ and
		// silently stop enforcing every @ts-expect-error in this file.
		const generated = join(ROOT, '.svelte-kit', 'tsconfig.json');
		expect(
			existsSync(generated),
			'run `npm run prepare` — the generated tsconfig is what defines the checked file set'
		).toBe(true);
		const include = JSON.parse(readFileSync(generated, 'utf8')) as { include?: string[] };
		// The generated config lives in .svelte-kit/, so its globs are relative
		// to that directory — '../tests/**/*.ts', not 'tests/**/*.ts'.
		expect(include.include?.some((glob) => glob.includes('tests/'))).toBe(true);
	});
});

describe('no float reaches the money path', () => {
	it('declares no fractional numeric literal', () => {
		// Parsed rather than grepped: `$14.5M` appears in this module's own doc
		// comments, and a text search would flag them.
		const file = ts.createSourceFile(
			'money.ts',
			MONEY_SOURCE,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS
		);
		const fractional: string[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isNumericLiteral(node) && node.getText(file).includes('.')) {
				fractional.push(node.getText(file));
			}
			ts.forEachChild(node, visit);
		};
		ts.forEachChild(file, visit);
		expect(fractional).toEqual([]);
	});

	it.each(['toFixed', 'parseFloat', 'toPrecision', 'toLocaleString', 'Intl.NumberFormat'])(
		'never reaches for %s',
		(construct: string) => {
			expect(MONEY_SOURCE).not.toContain(construct);
		}
	);

	it('carries no decimal library or cents representation', () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		const installed = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
		for (const name of ['decimal.js', 'big.js', 'bignumber.js', 'dinero.js', 'currency.js']) {
			expect(installed, `${name} must not be a dependency`).not.toContain(name);
		}
	});
});


describe('the League Median — the lower of two middles, never their mean', () => {
	const money = (dollars: number): Money => parseMoney(dollars);

	it('answers the single middle of an odd count', () => {
		expect(medianMoney([money(1_000_000), money(3_000_000), money(2_000_000)])).toBe(2_000_000);
		expect(medianCount([1, 3, 2])).toBe(2);
	});

	it('answers the LOWER middle of an even count, never the mean', () => {
		expect(medianMoney([money(4_000_000), money(4_500_000)])).toBe(4_000_000);
		expect(medianCount([2, 3])).toBe(2);
		// The mean would be off the $500,000 grid, which is the whole reason.
		expect(isOnMoneyGrid(money(4_250_000))).toBe(false);
	});

	it('answers a single value as itself', () => {
		expect(medianMoney([money(8_500_000)])).toBe(8_500_000);
		expect(medianCount([7])).toBe(7);
	});

	it('answers null for an empty input — never 0, which would be a figure', () => {
		expect(medianMoney([])).toBeNull();
		expect(medianCount([])).toBeNull();
	});

	it('answers identically whatever order the input arrives in', () => {
		const values = [money(9_000_000), money(1_000_000), money(5_000_000), money(3_000_000)];
		const answer = medianMoney(values);
		expect(answer).toBe(3_000_000);
		expect(medianMoney([...values].reverse())).toBe(answer);
		expect(medianMoney([...values].sort((a, b) => a - b))).toBe(answer);
		expect(medianMoney([...values].sort((a, b) => b - a))).toBe(answer);

		const counts = [9, 1, 5, 3];
		expect(medianCount(counts)).toBe(3);
		expect(medianCount([...counts].reverse())).toBe(3);
	});

	it('orders negative amounts as amounts, not as text', () => {
		// Available Cap Space is legitimately negative for an overcommitted
		// Team, and a lexical sort would place −$9.0M above −$1.0M.
		const values = [money(-9_000_000), money(-1_000_000), money(1_000_000)];
		expect(medianMoney(values)).toBe(-1_000_000);
		expect(medianCount([-9, -1, 1])).toBe(-1);
	});

	it('does not mutate the array it is given', () => {
		const values = [money(9_000_000), money(1_000_000), money(5_000_000)];
		const before = [...values];
		medianMoney(values);
		expect(values).toEqual(before);

		const counts = [9, 1, 5];
		const countsBefore = [...counts];
		medianCount(counts);
		expect(counts).toEqual(countsBefore);
	});

	it('lands on the grid for every input, because it is always a real value', () => {
		const values = [money(500_000), money(4_000_000), money(4_500_000), money(20_000_000)];
		const answer = medianMoney(values);
		expect(answer).not.toBeNull();
		expect(isOnMoneyGrid(answer as Money)).toBe(true);
		expect(() => formatMoney(answer as Money)).not.toThrow();
		expect(values).toContain(answer);
	});
});

describe('formatExactDollars — the diagnostic renderer', () => {
	const money = (value: number): Money => parseMoney(value);

	it('groups thousands and keeps every digit, on the grid or off it', () => {
		expect(formatExactDollars(money(300_000))).toBe('$300,000');
		expect(formatExactDollars(money(6_700_000))).toBe('$6,700,000');
		expect(formatExactDollars(money(1_000_000))).toBe('$1,000,000');
		expect(formatExactDollars(money(0))).toBe('$0');
		expect(formatExactDollars(money(999))).toBe('$999');
		expect(formatExactDollars(money(1_000))).toBe('$1,000');
	});

	it('renders an off-grid amount that formatMoney refuses outright', () => {
		const offGrid = money(6_700_000);
		expect(isOnMoneyGrid(offGrid)).toBe(false);
		expect(() => formatMoney(offGrid)).toThrow(RangeError);
		expect(formatExactDollars(offGrid)).toBe('$6,700,000');
	});

	it('carries a negative with the same minus sign formatMoney uses', () => {
		// Not a hyphen: `formatMoney` renders U+2212, and two renderings of one
		// figure that differ by a character are two figures to a reader.
		expect(formatExactDollars(money(-300_000))).toBe('\u2212$300,000');
		expect(formatMoney(money(-1_500_000))).toBe('\u2212$1.5M');
	});

	it('is lossless — the digits round-trip back to the amount', () => {
		for (const value of [1, 999, 300_000, 6_700_000, 90_000_000]) {
			const rendered = formatExactDollars(money(value));
			expect(Number(rendered.replace(/[$,]/g, ''))).toBe(value);
		}
	});
});
