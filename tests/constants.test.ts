import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as constants from '../src/lib/core/constants.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONSTANTS_SOURCE = readFileSync(join(ROOT, 'src', 'lib', 'core', 'constants.ts'), 'utf8');

describe('every league constant is a named value in the core', () => {
	it('holds the money figures PRD §11 fixes', () => {
		expect(constants.SALARY_CAP).toBe(165_000_000);
		expect(constants.MINIMUM_BID).toBe(1_000_000);
		expect(constants.MINIMUM_INCREMENT).toBe(500_000);
	});

	it('serves the Minimum Increment and the grid from one constant', () => {
		// Two constants holding 500_000 could drift, and the abbreviated
		// rendering is lossless only while every figure sits on this one grid.
		const declarations = CONSTANTS_SOURCE.match(/^export const \w+ = 500_000;$/gm) ?? [];
		expect(declarations).toHaveLength(1);
		expect(declarations[0]).toContain('MINIMUM_INCREMENT');
	});

	it('holds both clocks, as durations rather than instants', () => {
		expect(constants.AUCTION_CLOCK).toBe(24 * 60 * 60 * 1000);
		expect(constants.LEAGUE_CLOCK).toBe(48 * 60 * 60 * 1000);
	});

	it('holds the freshness windows AD-29 names, in the order it names them', () => {
		expect(constants.FRESHNESS_WINDOW).toBe(30 * 1000);
		expect(constants.STALE_WINDOW).toBe(120 * 1000);
		expect(constants.FRESHNESS_WINDOW).toBeLessThan(constants.STALE_WINDOW);
	});

	it('holds every slot count', () => {
		expect(constants.ACTIVE_BENCH_SLOTS).toBe(12);
		expect(constants.INJURY_RESERVE_SLOTS).toBe(2);
		expect(constants.MINOR_LEAGUE_SLOTS).toBe(3);
	});

	it('holds the Year Allotment, with one-year deals deliberately uncounted', () => {
		expect(constants.YEAR_ALLOTMENT).toEqual({ fourYear: 1, threeYear: 1, twoYear: 2 });
		expect(Object.isFrozen(constants.YEAR_ALLOTMENT)).toBe(true);
		expect(constants.YEAR_ALLOTMENT).not.toHaveProperty('oneYear');
	});
});

describe('the AD-20 event versions', () => {
	it('are small integers, not strings or floats', () => {
		expect(constants.EVENT_SCHEMA_VERSION).toBe(1);
		expect(constants.CORE_VERSION).toBe(1);
		expect(Number.isInteger(constants.EVENT_SCHEMA_VERSION)).toBe(true);
		expect(Number.isInteger(constants.CORE_VERSION)).toBe(true);
	});

	it('are declared exactly once each', () => {
		for (const name of ['EVENT_SCHEMA_VERSION', 'CORE_VERSION']) {
			const declarations = CONSTANTS_SOURCE.match(new RegExp(`^export const ${name}\\b`, 'gm')) ?? [];
			expect(declarations, `${name} is declared ${declarations.length} times`).toHaveLength(1);
		}
	});
});

describe('the AD-6 advisory lock key', () => {
	it('is a single bigint, so every caller uses the one-argument form', () => {
		// pg_advisory_xact_lock(bigint) and pg_advisory_xact_lock(int, int)
		// occupy disjoint lock spaces. A two-element key would invite the
		// two-argument form, and a mixed arity excludes nothing at all.
		expect(typeof constants.GLOBAL_WRITE_LOCK_KEY).toBe('bigint');
		expect(Array.isArray(constants.GLOBAL_WRITE_LOCK_KEY)).toBe(false);
	});

	it('fits Postgres int8', () => {
		expect(constants.GLOBAL_WRITE_LOCK_KEY).toBeLessThan(2n ** 63n);
		expect(constants.GLOBAL_WRITE_LOCK_KEY).toBeGreaterThan(-(2n ** 63n));
	});

	it('is declared exactly once', () => {
		// Counts declarations, not mentions — a doc comment naming the constant
		// is documentation, not a second lock key.
		const declarations = CONSTANTS_SOURCE.match(/^export const GLOBAL_WRITE_LOCK_KEY/gm) ?? [];
		expect(declarations).toHaveLength(1);
	});
});

describe('no administrative surface can edit any of them', () => {
	it('reads no environment variable and no configuration file', () => {
		expect(CONSTANTS_SOURCE).not.toMatch(/process\.env|import\.meta\.env|readFileSync|JSON\.parse/);
		// The leaf of the core: it imports nothing, which is also what lets
		// money.ts import the grid from here without a cycle.
		expect(CONSTANTS_SOURCE).not.toMatch(/^import\s/m);
	});

	it('exports only constants — nothing that could set one', () => {
		for (const [name, value] of Object.entries(constants)) {
			expect(typeof value, `${name} is not a value`).not.toBe('function');
		}
	});

	it('is not shadowed by a second constants module anywhere in src/', () => {
		const found: string[] = [];
		const walk = (directory: string): void => {
			for (const entry of readdirSync(directory)) {
				const full = join(directory, entry);
				if (statSync(full).isDirectory()) walk(full);
				else if (entry === 'constants.ts') found.push(full);
			}
		};
		walk(join(ROOT, 'src'));
		expect(found).toHaveLength(1);
	});
});
