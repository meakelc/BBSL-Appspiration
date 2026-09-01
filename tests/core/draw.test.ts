/**
 * The draw, as a pure derivation (Story 3.6, FR-19, AD-14).
 *
 * Five things are pinned here and nowhere else:
 *
 *   1. **Every position is reachable.** A derivation that could never select
 *      the last Contender would be a lottery that quietly excluded a Team, and
 *      no amount of it being "random" would fix that.
 *   2. **The result is a function of the seed and the list alone.** Nothing
 *      varies with the published commitment, with a clock, or with anything
 *      ambient — which is what makes folding the same log twice select the
 *      same Team.
 *   3. **The derivation never reads `hash(seed)`.** If it did, any watcher
 *      could compute before joining whether becoming Contender `n+1` would
 *      make them the winner, which is the exploit AD-14's commit-reveal
 *      exists to prevent.
 *   4. **The worked example `/verify` prints is the answer this code gives.**
 *      A Manager runs the printed procedure in a spreadsheet; if the page and
 *      the code disagreed, the page would be the defect and nobody would find
 *      out until a Manager challenged a real draw.
 *   5. **The four throws.** A missing seed, a malformed seed, an empty
 *      Contender list and a Contender missing an identity are each a bug and
 *      each of them silently papered over is a lottery nobody can check.
 *
 * State literals throughout: no database, no clock, no fold.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_BID } from '../../src/lib/core/constants.ts';
import { hash } from '../../src/lib/core/hash.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import type { Auction, Bid, Contender } from '../../src/lib/core/projection/auctions.ts';
import { drawIndex, drawnWinnerFor } from '../../src/lib/core/rules/draw.ts';

/**
 * The seed the `/verify` page's worked example prints, and the four Teams it
 * prints beside it. If either literal changes, the page changes with it.
 */
const WORKED_EXAMPLE_SEED =
	'4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e';
const WORKED_EXAMPLE_COUNT = 4;
const WORKED_EXAMPLE_POSITION = 2;

/** A second seed, so "the derivation is the seed's" has something to compare. */
const OTHER_SEED = '7b4e2a90c15d386f7b4e2a90c15d386f7b4e2a90c15d386f7b4e2a90c15d386f';

const CLOSES_AT = '2026-08-27T09:00:00.000Z';

function contender(index: number): Contender {
	const letter = 'efghijklmnopqrstuvwxyz'[index] ?? String(index);
	return {
		seq: String(index + 2),
		teamId: `t-${letter}`,
		teamName: `Team ${letter.toUpperCase()}`,
		managerId: `m-${letter}`
	};
}

function bidOf(overrides: Partial<Bid> = {}): Bid {
	return {
		seq: '2',
		teamId: 't-e',
		teamName: 'Team E',
		managerId: 'm-e',
		amount: parseMoney(MINIMUM_BID),
		occurredAt: '2026-08-26T09:00:00.000Z',
		closesAt: CLOSES_AT,
		seedHash: null,
		...overrides
	};
}

/** A live Minimum-Bid Contention with `count` Contenders, in join order. */
function lottery(count: number, overrides: Partial<Auction> = {}): Auction {
	const contenders = Array.from({ length: count }, (_unused, index) => contender(index));
	const leadingBid = bidOf({ seedHash: hash(WORKED_EXAMPLE_SEED) });
	return {
		fantraxPlayerId: 'p-1',
		contention: 'minimum_bid',
		leadingBid,
		closesAt: CLOSES_AT,
		bids: [leadingBid],
		contenders,
		seedHash: hash(WORKED_EXAMPLE_SEED),
		seed: null,
		...overrides
	};
}

/**
 * A deterministic family of seeds. `hash` of an index is 64 lowercase hex
 * digits by construction, which is exactly a seed's shape — so the suite gets
 * a large sample with no random source anywhere in it, and the same sample on
 * every run.
 */
function seedFamily(howMany: number): readonly string[] {
	return Array.from({ length: howMany }, (_unused, index) => hash(`seed-${String(index)}`));
}

// --- The derivation ---------------------------------------------------------

describe('drawIndex — the one expression a Manager reproduces', () => {
	it('gives the worked example on the /verify page: 64 digits, four Teams, position 2', () => {
		// The page prints this arithmetic in prose and a Manager runs it in a
		// spreadsheet. If the two ever disagree, the PAGE is the defect — it is
		// the half a Manager can actually run — and this is what notices.
		expect(drawIndex(WORKED_EXAMPLE_SEED, WORKED_EXAMPLE_COUNT)).toBe(WORKED_EXAMPLE_POSITION);
	});

	it('is exactly the digit-by-digit reduction, restated independently', () => {
		// A second implementation of the printed procedure, written from the
		// prose rather than from the source, over a large sample. Two
		// independent statements agreeing is what makes "this is that
		// arithmetic" a claim rather than a comment.
		const reduce = (seed: string, count: number): number => {
			let carried = 0;
			for (const digit of seed) {
				carried = (carried * 16 + Number.parseInt(digit, 16)) % count;
			}
			return carried;
		};
		for (const seed of seedFamily(40)) {
			for (let count = 1; count <= 12; count += 1) {
				expect(drawIndex(seed, count), `${seed} over ${String(count)}`).toBe(
					reduce(seed, count)
				);
			}
		}
	});

	it('always lands inside the list, for every count from one to thirty', () => {
		for (const seed of seedFamily(60)) {
			for (let count = 1; count <= 30; count += 1) {
				const position = drawIndex(seed, count);
				expect(Number.isInteger(position)).toBe(true);
				expect(position).toBeGreaterThanOrEqual(0);
				expect(position).toBeLessThan(count);
			}
		}
	});

	it('reaches EVERY position — no Contender is quietly excluded', () => {
		// The property that matters most and is easiest to lose: a derivation
		// that could never select the last Team on the list would be a lottery
		// that excluded a Team, and calling it random would not fix that.
		const seeds = seedFamily(400);
		for (let count = 2; count <= 8; count += 1) {
			const reached = new Set(seeds.map((seed) => drawIndex(seed, count)));
			expect(reached.size, `count ${String(count)} reached ${String(reached.size)}`).toBe(count);
		}
	});

	it('spreads roughly evenly — no position takes a visible share of the draw', () => {
		// Not a statistical test and not pretending to be one: a bias big
		// enough to matter to a Manager would show up as a position taking
		// half the draws, and this is the size of defect worth catching here.
		const seeds = seedFamily(600);
		for (const count of [2, 3, 4, 5, 7]) {
			const tally = new Array<number>(count).fill(0);
			for (const seed of seeds) {
				const position = drawIndex(seed, count);
				tally[position] = (tally[position] ?? 0) + 1;
			}
			const expected = seeds.length / count;
			for (const [position, hits] of tally.entries()) {
				expect(hits, `count ${String(count)}, position ${String(position)}`).toBeGreaterThan(
					expected * 0.5
				);
				expect(hits).toBeLessThan(expected * 1.5);
			}
		}
	});

	it('selects position 0 for a ONE-Contender lottery, with no special case', () => {
		// §10 example 11. `seed mod 1 = 0` for every seed there is, so a
		// single-Contender lottery needs no branch and gets none.
		for (const seed of seedFamily(20)) {
			expect(drawIndex(seed, 1)).toBe(0);
		}
	});

	it('is a pure function of its two arguments — the same call answers the same', () => {
		expect(drawIndex(WORKED_EXAMPLE_SEED, 5)).toBe(drawIndex(WORKED_EXAMPLE_SEED, 5));
		// ...and it takes two arguments and no third. A commitment, a clock or
		// a Team list could not reach it if they wanted to.
		expect(drawIndex).toHaveLength(2);
	});

	it('is the SEED that decides, not the list: one list, two seeds, two answers', () => {
		const positions = new Set(seedFamily(50).map((seed) => drawIndex(seed, 4)));
		expect(positions.size).toBeGreaterThan(1);
	});

	it('throws on a count below one, rather than reducing modulo zero', () => {
		expect(() => drawIndex(WORKED_EXAMPLE_SEED, 0)).toThrow(/at least one Contender/);
		expect(() => drawIndex(WORKED_EXAMPLE_SEED, -1)).toThrow(TypeError);
		expect(() => drawIndex(WORKED_EXAMPLE_SEED, 1.5)).toThrow(TypeError);
	});

	it('throws on anything that is not 64 lowercase hex digits', () => {
		for (const bad of [
			'',
			'4d81f0b6',
			`${WORKED_EXAMPLE_SEED}0`,
			WORKED_EXAMPLE_SEED.toUpperCase(),
			WORKED_EXAMPLE_SEED.replace('4', 'g')
		]) {
			expect(() => drawIndex(bad, 4), JSON.stringify(bad)).toThrow(/lowercase hex digits/);
		}
	});
});

// --- The winner -------------------------------------------------------------

describe('drawnWinnerFor — the Contender the seed selected', () => {
	it('selects the Team at the derived position, in the fold’s own order', () => {
		const winner = drawnWinnerFor(lottery(WORKED_EXAMPLE_COUNT), WORKED_EXAMPLE_SEED);

		expect(winner.kind).toBe('drawn');
		expect(winner.teamId).toBe('t-g');
		expect(winner.teamName).toBe('Team G');
		// The Manager whose JOIN put the Team in — carried on the Contender by
		// the fold, never looked back up through `bids`.
		expect(winner.managerId).toBe('m-g');
		expect(winner.seed).toBe(WORKED_EXAMPLE_SEED);
		expect(winner.contenders).toEqual(['t-e', 't-f', 't-g', 't-h']);
	});

	it('carries the list as ids in the fold’s order, never re-sorted', () => {
		// A join order that is deliberately NOT alphabetical, so "the fold's
		// order" and "sorted" are distinguishable answers. AD-14 makes the
		// order an input to the winner, so a drawer that re-sorted would draw
		// from a list nobody could check against.
		const auction: Auction = {
			...lottery(3),
			contenders: [
				{ seq: '2', teamId: 't-z', teamName: 'Team Z', managerId: 'm-z' },
				{ seq: '3', teamId: 't-a', teamName: 'Team A', managerId: 'm-a' },
				{ seq: '4', teamId: 't-m', teamName: 'Team M', managerId: 'm-m' }
			]
		};
		const winner = drawnWinnerFor(auction, WORKED_EXAMPLE_SEED);

		expect(winner.contenders).toEqual(['t-z', 't-a', 't-m']);
		expect(winner.teamId).toBe(winner.contenders[drawIndex(WORKED_EXAMPLE_SEED, 3)]);
	});

	it('gives the SAME winner every time — folding one log twice cannot differ', () => {
		const one = drawnWinnerFor(lottery(6), WORKED_EXAMPLE_SEED);
		const two = drawnWinnerFor(lottery(6), WORKED_EXAMPLE_SEED);
		expect(one).toEqual(two);
	});

	it('reads the SEED and never the commitment (AD-14’s whole prevention)', () => {
		// The same seed and the same list, once against a published commitment
		// and once against none. If `hash(seed)` were an input, a watcher could
		// work out before joining whether becoming Contender n+1 would make
		// them win — which is exactly what sealing the seed exists to stop.
		const verified = drawnWinnerFor(lottery(4), WORKED_EXAMPLE_SEED);
		const unverifiable = drawnWinnerFor(lottery(4, { seedHash: null }), WORKED_EXAMPLE_SEED);

		expect(unverifiable).toEqual(verified);
	});

	it('draws when the commitment folded to null rather than stranding the Auction', () => {
		// Reachable only from a corrupt or hand-written log. Refusing would
		// leave every Contender's capital committed forever with no second
		// exit, so the draw runs and the reveal states the null.
		expect(() => drawnWinnerFor(lottery(3, { seedHash: null }), OTHER_SEED)).not.toThrow();
	});

	it('throws when the seed does not answer the published commitment', () => {
		// `lottery()` publishes `hash(WORKED_EXAMPLE_SEED)`; this is a
		// different seed entirely.
		expect(() => drawnWinnerFor(lottery(4), OTHER_SEED)).toThrow(TypeError);
		expect(() => drawnWinnerFor(lottery(4), OTHER_SEED)).toThrow(
			/does not match the published commitment/
		);
	});

	it('throws when no seed was sealed at all', () => {
		expect(() => drawnWinnerFor(lottery(4), null)).toThrow(/no sealed seed exists/);
	});

	it('throws on a malformed sealed seed, naming what was required', () => {
		expect(() => drawnWinnerFor(lottery(4), 'not-a-seed')).toThrow(/64 lowercase hex digits/);
	});

	it('throws on an empty Contender list — there is nobody to draw', () => {
		expect(() => drawnWinnerFor(lottery(0), WORKED_EXAMPLE_SEED)).toThrow(/no\s+Contenders/);
	});

	it('throws when the drawn Contender is missing an identity', () => {
		// `auction_events.manager_id`/`team_id` are `not null` and reference
		// real rows, so this would otherwise fail at the foreign key instead of
		// at the rule that can name which field was empty.
		const auction = lottery(WORKED_EXAMPLE_COUNT);
		const damaged: Auction = {
			...auction,
			contenders: auction.contenders.map((entry, index) =>
				index === WORKED_EXAMPLE_POSITION ? { ...entry, managerId: '' } : entry
			)
		};

		expect(() => drawnWinnerFor(damaged, WORKED_EXAMPLE_SEED)).toThrow(
			/empty teamId, teamName or managerId/
		);
	});

	it('resolves a one-Contender lottery to that Contender, with a one-team list', () => {
		// §10 example 11 through the drawer: the list is recorded rather than
		// omitted, and no second `ClosedWinner` case was needed for it.
		const winner = drawnWinnerFor(lottery(1), WORKED_EXAMPLE_SEED);

		expect(winner.teamId).toBe('t-e');
		expect(winner.contenders).toEqual(['t-e']);
	});
});
