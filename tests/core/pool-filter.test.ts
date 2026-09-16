import { describe, expect, it } from 'vitest';

import {
	NO_POOL_FILTER,
	POOL_POSITIONS,
	POOL_POSITION_NAMES,
	countUnavailable,
	filterPool,
	hiddenPoolSentence,
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
	nbaTeam: 'BOS',
	available: true
};
const BAM: FilterablePlayer = {
	fantraxPlayerId: 'p-bam',
	playerName: 'Bam Adebayo',
	positions: 'PF,F,C',
	nbaTeam: 'MIA',
	available: true
};
const MIKAL: FilterablePlayer = {
	fantraxPlayerId: 'p-mikal',
	playerName: 'Mikal Bridges',
	positions: 'SG,G,SF,F',
	nbaTeam: 'NYK',
	available: true
};
const CHET: FilterablePlayer = {
	fantraxPlayerId: 'p-chet',
	playerName: 'Chet Holmgren',
	positions: 'C',
	nbaTeam: 'OKC',
	available: true
};

/** Already on the Bid Board: the state the resting filter hides. */
const NOMINATED: FilterablePlayer = {
	fantraxPlayerId: 'p-jokic',
	playerName: 'Nikola Jokic',
	positions: 'C',
	nbaTeam: 'DEN',
	available: false
};

// Named rather than indexed: `noUncheckedIndexedAccess` is on, and a fixture
// that has to be non-null-asserted at every use reads worse than four consts.
const POOL: readonly FilterablePlayer[] = [WHITE, BAM, MIKAL, CHET];

/** The same pool with one Player already nominated, in the export's order. */
const MIXED: readonly FilterablePlayer[] = [WHITE, BAM, NOMINATED, MIKAL, CHET];

/** The filter a Manager who has asked for everything is looking at. */
const SHOW_ALL: PoolFilter = { ...NO_POOL_FILTER, showUnavailable: true };

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
		expect(isFiltering({ ...SHOW_ALL, search: '   ' })).toBe(false);
		expect(matchesPoolFilter(CHET, filter({ search: '   ' }))).toBe(true);
	});

	it('refuses a Player who cannot be nominated unless asked for them', () => {
		// The resting filter hides them: their radio refuses the tap, and by
		// the middle of an auction they are most of the pool.
		expect(matchesPoolFilter(NOMINATED, NO_POOL_FILTER)).toBe(false);
		expect(matchesPoolFilter(NOMINATED, SHOW_ALL)).toBe(true);
	});

	it('ANDs availability against the search, so a hidden Player stays hidden', () => {
		// Searching a name that is already on the Bid Board finds nothing until
		// the control is on — and the count sentence is what says so.
		expect(matchesPoolFilter(NOMINATED, filter({ search: 'jokic' }))).toBe(false);
		expect(matchesPoolFilter(NOMINATED, { ...SHOW_ALL, search: 'jokic' })).toBe(true);
	});
});

describe('the availability default', () => {
	it('counts as narrowing, because at rest the list is short of the pool', () => {
		// The count sentence is gated on this. Calling the default "not
		// narrowing" would keep it silent about the largest thing it hides.
		expect(isFiltering(NO_POOL_FILTER)).toBe(true);
		expect(isFiltering(SHOW_ALL)).toBe(false);
	});

	it('counts what it is holding back, over the whole pool', () => {
		expect(countUnavailable(MIXED)).toBe(1);
		expect(countUnavailable(POOL)).toBe(0);
		expect(countUnavailable([])).toBe(0);
	});

	it('states the fact when collapsed and the state when open', () => {
		// "Nominated" for all three refused states: the summary of a collapsed
		// control is not where a Manager learns the refusal vocabulary, and
		// every revealed row still carries its own state phrase.
		expect(hiddenPoolSentence(1, NO_POOL_FILTER)).toBe('1 nominated Player is hidden.');
		expect(hiddenPoolSentence(1204, NO_POOL_FILTER)).toBe('1,204 nominated Players are hidden.');
		// Nothing to hide is worth saying too: it is the one reading under
		// which an empty-looking control is not a control that broke.
		expect(hiddenPoolSentence(0, NO_POOL_FILTER)).toBe('Every Player in the pool can be nominated.');
		expect(hiddenPoolSentence(1204, SHOW_ALL)).toContain('are listed');
	});
});

describe('filterPool', () => {
	it('narrows without ever reordering', () => {
		// Narrowing is not ranking. The result is a subsequence of the input,
		// in the input's order, which is the export's order.
		expect(idsOf(filterPool(POOL, filter({ positions: ['F'] })))).toEqual(['p-bam', 'p-mikal']);
		expect(idsOf(filterPool(POOL, NO_POOL_FILTER))).toEqual(idsOf(POOL));
	});

	it('drops the Players who cannot be nominated, and puts them back in order', () => {
		// Hidden by default; revealed in the export's order, never appended.
		expect(idsOf(filterPool(MIXED, NO_POOL_FILTER))).toEqual([
			'p-white',
			'p-bam',
			'p-mikal',
			'p-chet'
		]);
		expect(idsOf(filterPool(MIXED, SHOW_ALL))).toEqual(idsOf(MIXED));
	});

	it('still keeps a chosen Player who has become unavailable', () => {
		// The gate is the server's and it can turn a row unavailable between
		// page loads. The radio carrying the selection must survive it anyway,
		// or the form posts nobody.
		expect(idsOf(filterPool(MIXED, NO_POOL_FILTER, ['p-jokic']))).toContain('p-jokic');
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

	it('returns the list itself when nothing is being hidden at all', () => {
		// The identity fast path, which now needs the availability control on:
		// the resting filter has something to do.
		expect(filterPool(POOL, SHOW_ALL)).toBe(POOL);
	});

	it('never returns a Player twice when they both match and are kept', () => {
		const narrowed = filterPool(POOL, filter({ positions: ['C'] }), ['p-chet']);
		expect(idsOf(narrowed)).toEqual(['p-bam', 'p-chet']);
	});
});

describe('poolCountSentence', () => {
	it('says NOTHING while there is a list on screen to read', () => {
		// There is no running count. "Showing 42 of 1,467" was arithmetic about
		// a list the Manager can see, it moved on every keystroke, and neither
		// number is one they do anything with.
		expect(poolCountSentence(1467, 1467, SHOW_ALL)).toBe('');
		expect(poolCountSentence(1, 1, SHOW_ALL)).toBe('');
		expect(poolCountSentence(1467, 1467, { ...SHOW_ALL, search: '  ' })).toBe('');
		// Narrowed, and still silent: rows came back, so they answer for
		// themselves.
		expect(poolCountSentence(42, 1467, filter({ search: 'w' }))).toBe('');
		expect(poolCountSentence(1204, 1467, NO_POOL_FILTER)).toBe('');
	});

	it('names only the controls that are actually narrowing', () => {
		// Telling a Manager to clear a search they never typed is advice about
		// a control they did not touch.
		const hiddenOnly = poolCountSentence(0, 1467, NO_POOL_FILTER);
		expect(hiddenOnly).toContain('show the nominated Players');
		expect(hiddenOnly).not.toContain('clear the search');

		const typedOnly = poolCountSentence(0, 1467, { ...SHOW_ALL, search: 'zzz' });
		expect(typedOnly).toContain('clear the search or the positions');
		expect(typedOnly).not.toContain('nominated Players');

		const both = poolCountSentence(0, 1467, filter({ search: 'zzz' }));
		expect(both).toContain('clear the search or the positions');
		expect(both).toContain('show the nominated Players');
	});

	it('says how to get back when nothing matches', () => {
		const sentence = poolCountSentence(0, 1467, { ...SHOW_ALL, search: 'zzz' });
		expect(sentence).toContain('No Player matches');
		expect(sentence).toContain('1,467');
		expect(sentence).toContain('clear');
	});

	it('groups digits without Intl, which the pure core forbids', () => {
		// `check-core-purity.js` fails the build on `Intl`, so the separator is
		// inserted by hand — these are the boundaries that catch an off-by-one.
		// Asked through the no-match branch, the only one that prints a number.
		const narrowed = { ...SHOW_ALL, search: 'zzz' };
		expect(poolCountSentence(0, 999, narrowed)).toContain('999 are in the pool');
		expect(poolCountSentence(0, 1000, narrowed)).toContain('1,000 are in the pool');
		expect(poolCountSentence(0, 1234567, narrowed)).toContain('1,234,567');
		expect(poolCountSentence(0, 12, narrowed)).toContain('12 are in the pool');
		// And the same boundaries through the hidden count's own sentence.
		expect(hiddenPoolSentence(1000, NO_POOL_FILTER)).toContain('1,000 nominated Players are hidden');
	});
});
