import { describe, expect, it } from 'vitest';

import {
	NO_POOL_FILTER,
	POOL_POSITIONS,
	POOL_POSITION_NAMES,
	filterPool,
	isFiltering,
	matchesPoolFilter,
	poolCountSentence,
	splitPositions
} from '../../src/lib/core/pool-filter.ts';
import type { FilterablePlayer, PoolFilter } from '../../src/lib/core/pool-filter.ts';

/**
 * A pool in the export's own order, with the position cells the real file
 * uses. `Derrick White` and `Bam Adebayo` are the actual first two rows of
 * the promoted BBSL pool, so the order assertions below are the order a
 * Manager really sees.
 */
const WHITE: FilterablePlayer = {
	fantraxPlayerId: 'p-white',
	playerName: 'Derrick White',
	positions: 'PG,SG,G',
	nbaTeam: 'BOS'
};
const BAM: FilterablePlayer = {
	fantraxPlayerId: 'p-bam',
	playerName: 'Bam Adebayo',
	positions: 'PF,F,C',
	nbaTeam: 'MIA'
};
const MIKAL: FilterablePlayer = {
	fantraxPlayerId: 'p-mikal',
	playerName: 'Mikal Bridges',
	positions: 'SG,G,SF,F',
	nbaTeam: 'NYK'
};
const CHET: FilterablePlayer = {
	fantraxPlayerId: 'p-chet',
	playerName: 'Chet Holmgren',
	positions: 'C',
	nbaTeam: 'OKC'
};

// Named rather than indexed: `noUncheckedIndexedAccess` is on, and a fixture
// that has to be non-null-asserted at every use reads worse than four consts.
const POOL: readonly FilterablePlayer[] = [WHITE, BAM, MIKAL, CHET];

const filter = (part: Partial<PoolFilter> = {}): PoolFilter => ({ ...NO_POOL_FILTER, ...part });
const idsOf = (players: readonly FilterablePlayer[]) => players.map((p) => p.fantraxPlayerId);

describe('the position vocabulary', () => {
	it('is the seven tokens the real export uses, and every one is named', () => {
		expect([...POOL_POSITIONS]).toEqual(['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C']);
		for (const position of POOL_POSITIONS) {
			expect(POOL_POSITION_NAMES[position], `${position} has no spelled-out name`).toBeTruthy();
		}
	});

	it('splits the export cell and drops nothing that is a token', () => {
		expect([...splitPositions('PG,SG,G')]).toEqual(['PG', 'SG', 'G']);
		expect([...splitPositions(' pf , f ,c ')]).toEqual(['PF', 'F', 'C']);
		expect([...splitPositions('C')]).toEqual(['C']);
		// A blank between commas is not an empty position.
		expect([...splitPositions('PG,,SG')]).toEqual(['PG', 'SG']);
	});
});

describe('matchesPoolFilter', () => {
	it('matches a name by substring, not only by prefix', () => {
		// Half the value of a search box on a 1,467-row list is the surname.
		expect(matchesPoolFilter(WHITE, filter({ search: 'white' }))).toBe(true);
		expect(matchesPoolFilter(WHITE, filter({ search: 'DERRICK' }))).toBe(true);
		expect(matchesPoolFilter(WHITE, filter({ search: 'rick wh' }))).toBe(true);
		expect(matchesPoolFilter(WHITE, filter({ search: 'adebayo' }))).toBe(false);
	});

	it('matches the NBA team, so a league-wide search by club works', () => {
		expect(matchesPoolFilter(BAM, filter({ search: 'MIA' }))).toBe(true);
		expect(matchesPoolFilter(BAM, filter({ search: 'mia' }))).toBe(true);
	});

	it('ORs the position tokens among themselves', () => {
		// Picking PG and C asks for either, which is the only reading of a
		// multi-select that is not a contradiction.
		const guards = filter({ positions: ['PG', 'C'] });
		expect(matchesPoolFilter(WHITE, guards)).toBe(true);
		expect(matchesPoolFilter(CHET, guards)).toBe(true);
		expect(matchesPoolFilter(MIKAL, guards)).toBe(false);
	});

	it('matches the export umbrella tokens without inferring them', () => {
		// Every guard's cell carries `G` in the real file, so `G` needs no
		// derivation — and a Player whose cell lacks it must not match.
		expect(matchesPoolFilter(WHITE, filter({ positions: ['G'] }))).toBe(true);
		expect(matchesPoolFilter(CHET, filter({ positions: ['G'] }))).toBe(false);
	});

	it('ANDs the search against the positions', () => {
		const both = filter({ search: 'bridges', positions: ['C'] });
		expect(matchesPoolFilter(MIKAL, both)).toBe(false);
		expect(matchesPoolFilter(MIKAL, filter({ search: 'bridges', positions: ['SF'] }))).toBe(true);
	});

	it('treats blank text as no filter at all', () => {
		expect(isFiltering(filter({ search: '   ' }))).toBe(false);
		expect(matchesPoolFilter(CHET, filter({ search: '   ' }))).toBe(true);
	});
});

describe('filterPool', () => {
	it('narrows without ever reordering', () => {
		// Narrowing is not ranking. The result is a subsequence of the input,
		// in the input's order, which is the export's order.
		expect(idsOf(filterPool(POOL, filter({ positions: ['F'] })))).toEqual(['p-bam', 'p-mikal']);
		expect(idsOf(filterPool(POOL, NO_POOL_FILTER))).toEqual(idsOf(POOL));
	});

	it('keeps the chosen Player even when the filter excludes them', () => {
		// The radio is the only thing carrying the selection: filtering the
		// chosen Player out unmounts it and the form posts nobody.
		const narrowed = filterPool(POOL, filter({ search: 'holmgren' }), ['p-white']);
		expect(idsOf(narrowed)).toEqual(['p-white', 'p-chet']);
	});

	it('keeps the chosen Player in the export order, not pinned to the top', () => {
		const narrowed = filterPool(POOL, filter({ positions: ['C'] }), ['p-mikal']);
		expect(idsOf(narrowed)).toEqual(['p-bam', 'p-mikal', 'p-chet']);
	});

	it('returns everything when nothing is asked of it', () => {
		expect(filterPool(POOL, NO_POOL_FILTER)).toBe(POOL);
	});

	it('never returns a Player twice when they both match and are kept', () => {
		const narrowed = filterPool(POOL, filter({ positions: ['C'] }), ['p-chet']);
		expect(idsOf(narrowed)).toEqual(['p-bam', 'p-chet']);
	});
});

describe('poolCountSentence', () => {
	it('says NOTHING when the Manager has not narrowed anything', () => {
		// A pool size is not news: the same figure on every visit, answering a
		// question nobody asked, costing a line of a phone's first screen. The
		// count earns its line only once narrowing has changed it.
		expect(poolCountSentence(1467, 1467, NO_POOL_FILTER)).toBe('');
		expect(poolCountSentence(1, 1, NO_POOL_FILTER)).toBe('');
		// Blank text is not narrowing either.
		expect(poolCountSentence(1467, 1467, filter({ search: '  ' }))).toBe('');
	});

	it('states BOTH numbers when narrowed', () => {
		// The question is not "how many can I see" but "how much am I not
		// looking at", so a bare count of the visible rows will not do.
		expect(poolCountSentence(42, 1467, filter({ search: 'w' }))).toBe('Showing 42 of 1,467 Players.');
	});

	it('says how to get back when nothing matches', () => {
		const sentence = poolCountSentence(0, 1467, filter({ search: 'zzz' }));
		expect(sentence).toContain('No Player matches');
		expect(sentence).toContain('1,467');
		expect(sentence).toContain('clear');
	});

	it('groups digits without Intl, which the pure core forbids', () => {
		// `check-core-purity.js` fails the build on `Intl`, so the separator is
		// inserted by hand — these are the boundaries that catch an off-by-one.
		// Asked through the narrowed branch, since the resting one is silent.
		const narrowed = filter({ search: 'a' });
		expect(poolCountSentence(999, 999, narrowed)).toBe('Showing 999 of 999 Players.');
		expect(poolCountSentence(1000, 1000, narrowed)).toBe('Showing 1,000 of 1,000 Players.');
		expect(poolCountSentence(1, 1234567, narrowed)).toContain('1,234,567');
		expect(poolCountSentence(12, 12, narrowed)).toBe('Showing 12 of 12 Players.');
	});
});
