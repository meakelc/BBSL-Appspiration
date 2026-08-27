import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { fold } from '../../src/lib/core/projection/fold.ts';
import { AUCTION_OPENED_EVENT, INITIAL_PHASE, phaseReducer } from '../../src/lib/core/projection/phase.ts';
import {
	IMPORT_PROMOTED_EVENT,
	INITIAL_PROMOTION,
	promotedSourcesReducer
} from '../../src/lib/core/projection/promotion.ts';
import {
	INITIAL_LEAGUE_CLOCK,
	leagueClockExpiry,
	leagueClockReducer
} from '../../src/lib/core/projection/league-clock.ts';
import { BID_PLACED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import { NOMINATION_PLACED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { LEAGUE_CLOCK } from '../../src/lib/core/constants.ts';
import { POOL_SOURCE_LABEL } from '../../src/lib/core/rules/pool-import.ts';
import {
	AUCTION_OPEN_CONSEQUENCE,
	auctionOpenRefusalDetail,
	eligibilitySentence,
	preOpenReport,
	refuseAuctionOpen
} from '../../src/lib/core/rules/auction-open.ts';
import type {
	AuctionOpenRefusal,
	AuctionOpenState,
	GateTeam
} from '../../src/lib/core/rules/auction-open.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';

function event(
	seq: number,
	type: string,
	payload: unknown = {},
	occurredAt = '2026-08-25T12:00:00.000Z'
): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt,
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: 'm-1',
		teamId: 't-1',
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

function promotedPayload(teamCount: number, poolSize = 100) {
	return {
		teams: Array.from({ length: teamCount }, (_unused, index) => ({
			teamId: `t-${String(index).padStart(2, '0')}`,
			teamName: `Team ${String(index).padStart(2, '0')}`,
			rosterCount: 12
		})),
		poolSize
	};
}

function teams(count: number, overrides: Partial<Record<number, Partial<GateTeam>>> = {}): GateTeam[] {
	return Array.from({ length: count }, (_unused, index) => ({
		teamId: `t-${String(index).padStart(2, '0')}`,
		teamName: `Team ${String(index).padStart(2, '0')}`,
		hasManager: true,
		...(overrides[index] ?? {})
	}));
}

function readyState(overrides: Partial<AuctionOpenState> = {}): AuctionOpenState {
	return {
		phase: 'Setup',
		promotion: fold(
			INITIAL_PROMOTION,
			[event(1, IMPORT_PROMOTED_EVENT, promotedPayload(30))],
			promotedSourcesReducer
		),
		teams: teams(30),
		eligibleCount: 7,
		...overrides
	};
}

// --- phaseReducer's one new case --------------------------------------------

describe('phaseReducer — the AuctionOpened case', () => {
	it('names the event type once, and it is what the log carries', () => {
		expect(AUCTION_OPENED_EVENT).toBe('AuctionOpened');
	});

	it('folds an empty log to Setup, unchanged', () => {
		expect(fold(INITIAL_PHASE, [], phaseReducer)).toBe('Setup');
	});

	it('folds AuctionOpened to Auction', () => {
		expect(fold(INITIAL_PHASE, [event(1, AUCTION_OPENED_EVENT)], phaseReducer)).toBe('Auction');
	});

	it('leaves every other event type alone, including the promotion that precedes it', () => {
		expect(
			fold(INITIAL_PHASE, [event(1, IMPORT_PROMOTED_EVENT), event(2, 'Whatever')], phaseReducer)
		).toBe('Setup');
	});

	it('converges on a double replay — the phase is a fold, not an accumulation', () => {
		const log = [event(1, IMPORT_PROMOTED_EVENT), event(2, AUCTION_OPENED_EVENT)];
		const once = fold(INITIAL_PHASE, log, phaseReducer);
		const twice = fold(once, log, phaseReducer);
		expect(once).toBe('Auction');
		expect(twice).toBe(once);
	});

	it('folds by seq, not by arrival order', () => {
		const state = fold(
			INITIAL_PHASE,
			[event(2, AUCTION_OPENED_EVENT), event(1, IMPORT_PROMOTED_EVENT)],
			phaseReducer
		);
		expect(state).toBe('Auction');
	});
});

// --- promotedSourcesReducer -------------------------------------------------

describe('promotedSourcesReducer', () => {
	it('starts with nothing promoted — and says so as a flag, not as an empty list', () => {
		expect(INITIAL_PROMOTION.promoted).toBe(false);
		expect(INITIAL_PROMOTION.teamIds).toEqual([]);
		expect(INITIAL_PROMOTION.poolSize).toBe(0);
	});

	it('folds an ImportPromoted payload into its Teams and its pool size', () => {
		const state = fold(
			INITIAL_PROMOTION,
			[event(1, IMPORT_PROMOTED_EVENT, promotedPayload(30, 412))],
			promotedSourcesReducer
		);
		expect(state.promoted).toBe(true);
		expect(state.teamIds).toHaveLength(30);
		expect(state.teamNames[0]).toBe('Team 00');
		expect(state.poolSize).toBe(412);
	});

	it('replaces an earlier promotion wholesale rather than merging the two', () => {
		// Promotion is all-or-nothing (AD-28): a merge would invent the union
		// of two re-imports, a state promotion never produces.
		const state = fold(
			INITIAL_PROMOTION,
			[
				event(1, IMPORT_PROMOTED_EVENT, promotedPayload(30, 400)),
				event(2, IMPORT_PROMOTED_EVENT, {
					teams: [{ teamId: 't-99', teamName: 'Only Team', rosterCount: 1 }],
					poolSize: 3
				})
			],
			promotedSourcesReducer
		);
		expect(state.teamIds).toEqual(['t-99']);
		expect(state.poolSize).toBe(3);
	});

	it('ignores every other event type', () => {
		const state = fold(
			INITIAL_PROMOTION,
			[event(1, AUCTION_OPENED_EVENT), event(2, 'MinorLeagueEligibilitySet')],
			promotedSourcesReducer
		);
		expect(state).toEqual(INITIAL_PROMOTION);
	});

	it('converges on a double replay', () => {
		const log = [event(1, IMPORT_PROMOTED_EVENT, promotedPayload(30))];
		const once = fold(INITIAL_PROMOTION, log, promotedSourcesReducer);
		const twice = fold(once, log, promotedSourcesReducer);
		expect(twice).toEqual(once);
	});

	it('treats a malformed payload as a promotion that named nothing, never as no promotion', () => {
		// The safe answer: the gate then refuses with every Team outstanding,
		// rather than claiming no import was ever promoted.
		for (const payload of [null, 'nonsense', 42, {}, { teams: 'not-an-array' }]) {
			const state = fold(
				INITIAL_PROMOTION,
				[event(1, IMPORT_PROMOTED_EVENT, payload)],
				promotedSourcesReducer
			);
			expect(state.promoted).toBe(true);
			expect(state.teamIds).toEqual([]);
			expect(state.poolSize).toBe(0);
		}
	});

	it('falls back to the id when a Team entry carries no usable name, and skips one with no id', () => {
		const state = fold(
			INITIAL_PROMOTION,
			[
				event(1, IMPORT_PROMOTED_EVENT, {
					teams: [{ teamId: 't-1' }, { teamName: 'Nameless id' }, null],
					poolSize: 1
				})
			],
			promotedSourcesReducer
		);
		expect(state.teamIds).toEqual(['t-1']);
		expect(state.teamNames).toEqual(['t-1']);
	});
});

// --- leagueClockReducer -----------------------------------------------------

describe('leagueClockReducer', () => {
	it('has no origin while the auction has not opened — a state, not a failure', () => {
		expect(INITIAL_LEAGUE_CLOCK.origin).toBeNull();
		expect(INITIAL_LEAGUE_CLOCK.lastReset).toBeNull();
		expect(fold(INITIAL_LEAGUE_CLOCK, [event(1, IMPORT_PROMOTED_EVENT)], leagueClockReducer)).toEqual(
			INITIAL_LEAGUE_CLOCK
		);
	});

	it('takes AuctionOpened’s own instant as the origin', () => {
		const state = fold(
			INITIAL_LEAGUE_CLOCK,
			[event(1, AUCTION_OPENED_EVENT, {}, '2026-08-25T19:00:00.000Z')],
			leagueClockReducer
		);
		expect(state.origin).toBe('2026-08-25T19:00:00.000Z');
	});

	it('expires 48 hours after that origin, once the shell adds the duration (AD-3)', () => {
		const state = fold(
			INITIAL_LEAGUE_CLOCK,
			[event(1, AUCTION_OPENED_EVENT, {}, '2026-08-25T19:00:00.000Z')],
			leagueClockReducer
		);
		expect(state.origin).not.toBeNull();
		if (state.origin === null) return;
		const expiry = new Date(Date.parse(state.origin) + LEAGUE_CLOCK);
		expect(expiry.toISOString()).toBe('2026-08-27T19:00:00.000Z');
	});

	it('keeps the first open’s origin, so a replay never moves a running clock', () => {
		const log = [
			event(1, AUCTION_OPENED_EVENT, {}, '2026-08-25T19:00:00.000Z'),
			event(2, AUCTION_OPENED_EVENT, {}, '2026-08-26T19:00:00.000Z')
		];
		const once = fold(INITIAL_LEAGUE_CLOCK, log, leagueClockReducer);
		expect(once.origin).toBe('2026-08-25T19:00:00.000Z');
		expect(fold(once, log, leagueClockReducer)).toEqual(once);
	});

	it('does not reset on any other event type — AD-22’s reset set is not widened here', () => {
		const opened = fold(
			INITIAL_LEAGUE_CLOCK,
			[event(1, AUCTION_OPENED_EVENT, {}, '2026-08-25T19:00:00.000Z')],
			leagueClockReducer
		);
		const later = fold(
			opened,
			// The reset set is now complete at exactly two — `NominationPlaced`
			// (Story 2.1) and `BidPlaced` (Story 2.5). Everything below is
			// outside it. `PlayerNominated` and `PlacedBid` are deliberately the
			// WRONG spellings of the two real types: a reducer that reset on one
			// would be matching a string nothing appends. `AuctionClosed` is §10
			// example 13's case — a close does NOT reset the League Clock.
			[
				event(2, 'PlacedBid'),
				event(3, 'PlayerNominated'),
				event(4, 'ImportPromoted'),
				event(5, 'AuctionClosed'),
				event(6, 'BidVoided')
			],
			leagueClockReducer
		);
		expect(later).toEqual(opened);
		expect(later.lastReset).toBeNull();
	});

	it('folds exactly two reset cases and no more — AD-22, read off the source', () => {
		// The set is fixed at two by an AD, so "how many event types reset it"
		// is asserted structurally as well as behaviourally: a third `case`
		// added to the reducer would widen the set silently otherwise.
		// Comments are stripped BOTH ways — block and line — for the reason
		// `tests/structure.test.ts` and `tests/routes/auction-page.test.ts`
		// both state: prose about a case is not a case. Stripping only block
		// comments left a `// case FOO:` in a note able to corrupt the count.
		const source = readFileSync(
			fileURLToPath(new URL('../../src/lib/core/projection/league-clock.ts', import.meta.url)),
			'utf8'
		)
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '');
		const cases = [...source.matchAll(/case\s+([A-Z_]+):/g)].map((match) => match[1]);
		expect(cases).toEqual([
			'AUCTION_OPENED_EVENT',
			'NOMINATION_PLACED_EVENT',
			'BID_PLACED_EVENT'
		]);
	});
});

// --- the second and last reset: BidPlaced (Story 2.5, AD-22) ----------------

/** One `BidPlaced`, which is a reset — never an origin. */
function bidAt(seq: number, occurredAt: string) {
	return event(
		seq,
		BID_PLACED_EVENT,
		{ fantraxPlayerId: 'p-1', teamId: 't-1', managerId: 'm-1', amount: 8_500_000 },
		occurredAt
	);
}

describe('leagueClockReducer — the BidPlaced reset', () => {
	it('records a Bid’s own instant as the last reset — AC5', () => {
		const state = fold(
			INITIAL_LEAGUE_CLOCK,
			[
				event(1, AUCTION_OPENED_EVENT, {}, '2026-08-25T19:00:00.000Z'),
				bidAt(2, '2026-08-26T12:00:00.000Z')
			],
			leagueClockReducer
		);
		expect(state.origin).toBe('2026-08-25T19:00:00.000Z');
		expect(state.lastReset).toBe('2026-08-26T12:00:00.000Z');
	});

	it('moves the expiry to 48 hours after the Bid, not after the nomination', () => {
		const state = fold(
			INITIAL_LEAGUE_CLOCK,
			[
				event(1, AUCTION_OPENED_EVENT, {}, '2026-08-25T19:00:00.000Z'),
				nominationAt(2, '2026-08-26T09:00:00.000Z'),
				bidAt(3, '2026-08-26T12:00:00.000Z')
			],
			leagueClockReducer
		);
		expect(leagueClockExpiry(state)).toBe('2026-08-28T12:00:00.000Z');
	});

	it('leaves the origin exactly where it was — a reset is not an origin', () => {
		const state = fold(
			INITIAL_LEAGUE_CLOCK,
			[
				event(1, AUCTION_OPENED_EVENT, {}, '2026-08-25T19:00:00.000Z'),
				bidAt(2, '2026-08-26T12:00:00.000Z')
			],
			leagueClockReducer
		);
		expect(state.origin).toBe('2026-08-25T19:00:00.000Z');
	});

	it('converges on a double replay', () => {
		const log = [
			event(1, AUCTION_OPENED_EVENT, {}, '2026-08-25T19:00:00.000Z'),
			bidAt(2, '2026-08-26T12:00:00.000Z')
		];
		const once = fold(INITIAL_LEAGUE_CLOCK, log, leagueClockReducer);
		expect(fold(once, log, leagueClockReducer)).toEqual(once);
	});
});

// --- the reset, and the expiry it moves (Story 2.1, AD-22) -------------------

/** One `NominationPlaced`, which is a reset — never an origin. */
function nominationAt(seq: number, occurredAt: string) {
	return event(seq, NOMINATION_PLACED_EVENT, { fantraxPlayerId: 'p-1', teamId: 't-1' }, occurredAt);
}

describe('leagueClockReducer — the NominationPlaced reset', () => {
	it('records a nomination’s own instant as the last reset', () => {
		const state = fold(
			INITIAL_LEAGUE_CLOCK,
			[
				event(1, AUCTION_OPENED_EVENT, {}, '2026-08-25T19:00:00.000Z'),
				nominationAt(2, '2026-08-26T09:00:00.000Z')
			],
			leagueClockReducer
		);
		expect(state.origin).toBe('2026-08-25T19:00:00.000Z');
		expect(state.lastReset).toBe('2026-08-26T09:00:00.000Z');
	});

	it('leaves the origin exactly where it was — a reset is not an origin', () => {
		const state = fold(
			INITIAL_LEAGUE_CLOCK,
			[
				event(1, AUCTION_OPENED_EVENT, {}, '2026-08-25T19:00:00.000Z'),
				nominationAt(2, '2026-08-26T09:00:00.000Z'),
				nominationAt(3, '2026-08-26T20:00:00.000Z')
			],
			leagueClockReducer
		);
		expect(state.origin).toBe('2026-08-25T19:00:00.000Z');
	});

	it('takes the LATEST reset in seq order, not the first and not by timestamp', () => {
		// Under the global lock a transaction queued on it can commit later
		// while holding an earlier `occurred_at`, so `seq` is the only order
		// that matches history (AD-5).
		const state = fold(
			INITIAL_LEAGUE_CLOCK,
			[
				event(1, AUCTION_OPENED_EVENT, {}, '2026-08-25T19:00:00.000Z'),
				nominationAt(3, '2026-08-26T09:00:00.000Z'),
				nominationAt(2, '2026-08-26T20:00:00.000Z')
			],
			leagueClockReducer
		);
		expect(state.lastReset).toBe('2026-08-26T09:00:00.000Z');
	});

	it('converges on a double replay', () => {
		const log = [
			event(1, AUCTION_OPENED_EVENT, {}, '2026-08-25T19:00:00.000Z'),
			nominationAt(2, '2026-08-26T09:00:00.000Z')
		];
		const once = fold(INITIAL_LEAGUE_CLOCK, log, leagueClockReducer);
		expect(fold(once, log, leagueClockReducer)).toEqual(once);
	});
});

describe('leagueClockExpiry — 48 hours after the LATER of origin and reset (AD-22)', () => {
	it('is null while the auction has not opened', () => {
		expect(leagueClockExpiry(INITIAL_LEAGUE_CLOCK)).toBeNull();
	});

	it('is 48 hours after the origin when nothing has reset it', () => {
		const clock = fold(
			INITIAL_LEAGUE_CLOCK,
			[event(1, AUCTION_OPENED_EVENT, {}, '2026-08-25T19:00:00.000Z')],
			leagueClockReducer
		);
		expect(leagueClockExpiry(clock)).toBe('2026-08-27T19:00:00.000Z');
	});

	it('is 48 hours after the NOMINATION once one has been placed — AC4', () => {
		const clock = fold(
			INITIAL_LEAGUE_CLOCK,
			[
				event(1, AUCTION_OPENED_EVENT, {}, '2026-08-25T19:00:00.000Z'),
				nominationAt(2, '2026-08-26T09:00:00.000Z')
			],
			leagueClockReducer
		);
		expect(leagueClockExpiry(clock)).toBe('2026-08-28T09:00:00.000Z');
	});

	it('never recomputes back past the open, even for a reset that predates it', () => {
		// The whole reason the clock carries two fields rather than one: a
		// void that left an earlier surviving reset must not shorten the
		// clock below the open's own 48 hours.
		expect(
			leagueClockExpiry({
				origin: '2026-08-25T19:00:00.000Z',
				lastReset: '2026-08-25T08:00:00.000Z'
			})
		).toBe('2026-08-27T19:00:00.000Z');
	});

	it('is null for a reset with no origin — a stray reset starts no clock', () => {
		expect(leagueClockExpiry({ origin: null, lastReset: '2026-08-26T09:00:00.000Z' })).toBeNull();
	});

	it('agrees with Date arithmetic, which the core itself may not use', () => {
		// The core is forbidden `Date` (scripts/check-core-purity.js), so its
		// instant arithmetic is written by hand. This is the check that the
		// hand-rolled version has not drifted from the real calendar.
		const cases = [
			'2026-08-25T19:00:00.000Z',
			'2026-02-27T12:00:00.000Z', // across a non-leap February end
			'2028-02-27T12:00:00.000Z', // across a LEAP February end
			'2026-12-30T23:59:59.999Z', // across a year end
			'2100-02-26T00:00:00.000Z', // a century year that is NOT a leap year
			'2000-02-27T00:00:00.000Z' // a century year that IS a leap year
		];
		for (const origin of cases) {
			expect(leagueClockExpiry({ origin, lastReset: null })).toBe(
				new Date(Date.parse(origin) + LEAGUE_CLOCK).toISOString()
			);
		}
	});

	it.each([
		['not an instant at all', 'yesterday'],
		['a month that does not exist', '2026-13-01T00:00:00.000Z'],
		['a day that does not exist', '2026-02-30T00:00:00.000Z'],
		['a non-leap 29 February', '2027-02-29T00:00:00.000Z'],
		['an hour that does not exist', '2026-08-25T24:00:00.000Z'],
		['a non-UTC offset, which this log never holds', '2026-08-25T19:00:00.000+05:00']
	])('returns null rather than throwing for an origin that is %s', (_label, origin: string) => {
		expect(leagueClockExpiry({ origin, lastReset: null })).toBeNull();
	});

	it('falls back to the origin for a lastReset that does not parse', () => {
		expect(
			leagueClockExpiry({ origin: '2026-08-25T19:00:00.000Z', lastReset: 'nonsense' })
		).toBe('2026-08-27T19:00:00.000Z');
	});

	it('accepts the second-precision spelling the database can also produce', () => {
		expect(leagueClockExpiry({ origin: '2026-08-25T19:00:00Z', lastReset: null })).toBe(
			'2026-08-27T19:00:00.000Z'
		);
	});

	it('is a pure function of the state it is handed', () => {
		const clock = { origin: '2026-08-25T19:00:00.000Z', lastReset: '2026-08-26T09:00:00.000Z' };
		expect(leagueClockExpiry(clock)).toBe(leagueClockExpiry(clock));
	});
});

// --- the gate ---------------------------------------------------------------

describe('refuseAuctionOpen — the gates, in order', () => {
	it('allows an open when everything holds', () => {
		expect(refuseAuctionOpen(readyState())).toBeNull();
	});

	it('refuses once the phase has folded past Setup, naming the phase', () => {
		const refusal = refuseAuctionOpen(readyState({ phase: 'Auction' }));
		expect(refusal?.kind).toBe('phase');
		if (refusal?.kind !== 'phase') return;
		expect(refusal.phase).toBe('Auction');
		expect(auctionOpenRefusalDetail(refusal)).toContain('Auction');
	});

	it('refuses when no import has been promoted at all', () => {
		const refusal = refuseAuctionOpen(readyState({ promotion: INITIAL_PROMOTION }));
		expect(refusal?.kind).toBe('not_promoted');
		expect(auctionOpenRefusalDetail({ kind: 'not_promoted' })).toContain(
			'no import has been promoted'
		);
	});

	it('names each Team the promotion left out, rather than counting them', () => {
		const promotion = fold(
			INITIAL_PROMOTION,
			[event(1, IMPORT_PROMOTED_EVENT, promotedPayload(28))],
			promotedSourcesReducer
		);
		const refusal = refuseAuctionOpen(readyState({ promotion }));
		expect(refusal?.kind).toBe('outstanding_sources');
		if (refusal?.kind !== 'outstanding_sources') return;
		expect(refusal.sourceNames).toEqual(['Team 28', 'Team 29']);
		const detail = auctionOpenRefusalDetail(refusal);
		expect(detail).toContain('Team 28');
		expect(detail).toContain('Team 29');
		expect(detail, 'the refusal counted instead of naming').not.toMatch(/\b2 (sources|Teams)\b/);
	});

	it('names the Free Agent pool when the promotion committed no Player', () => {
		const promotion = fold(
			INITIAL_PROMOTION,
			[event(1, IMPORT_PROMOTED_EVENT, promotedPayload(30, 0))],
			promotedSourcesReducer
		);
		const refusal = refuseAuctionOpen(readyState({ promotion }));
		expect(refusal?.kind).toBe('outstanding_sources');
		if (refusal?.kind !== 'outstanding_sources') return;
		expect(refusal.sourceNames).toEqual([POOL_SOURCE_LABEL]);
		expect(auctionOpenRefusalDetail(refusal)).toContain(POOL_SOURCE_LABEL);
	});

	it('names each Team with no Manager, rather than counting them', () => {
		const refusal = refuseAuctionOpen(
			readyState({ teams: teams(30, { 4: { hasManager: false }, 9: { hasManager: false } }) })
		);
		expect(refusal?.kind).toBe('unbound_teams');
		if (refusal?.kind !== 'unbound_teams') return;
		expect(refusal.teamNames).toEqual(['Team 04', 'Team 09']);
		const detail = auctionOpenRefusalDetail(refusal);
		expect(detail).toContain('Team 04');
		expect(detail).toContain('Team 09');
		expect(detail).toContain('have no Manager bound');
	});

	it('says “has” for a single unbound Team', () => {
		expect(
			auctionOpenRefusalDetail({ kind: 'unbound_teams', teamNames: ['Lakers'] })
		).toContain('Lakers has no Manager bound');
	});

	it('refuses on the phase before it complains about anything else', () => {
		const refusal = refuseAuctionOpen({
			phase: 'Auction',
			promotion: INITIAL_PROMOTION,
			teams: teams(1, { 0: { hasManager: false } }),
			eligibleCount: 0
		});
		expect(refusal?.kind).toBe('phase');
	});

	it('says “no import has been promoted” before it lists thirty outstanding Teams', () => {
		const refusal = refuseAuctionOpen(readyState({ promotion: INITIAL_PROMOTION }));
		expect(refusal?.kind).toBe('not_promoted');
	});

	it('refuses a League with no Teams at all, rather than opening an empty auction', () => {
		// The other source gates derive "outstanding" from the live teams table,
		// so an empty table has nothing to be outstanding about and would sail
		// through into an irreversible open with no Team able to nominate.
		const refusal = refuseAuctionOpen(readyState({ teams: [] }));
		expect(refusal?.kind).toBe('no_teams');
	});

	it('refuses no_teams before it complains about a Team with no Manager', () => {
		expect(refuseAuctionOpen(readyState({ teams: [] }))?.kind).toBe('no_teams');
	});

	it('states every phase in its own words, not only Auction', () => {
		for (const phase of ['Auction', 'Contract Assignment', 'Archived'] as const) {
			const detail = auctionOpenRefusalDetail({ kind: 'phase', phase });
			expect(detail).toContain(phase);
			expect(detail).toContain('Nothing was written.');
		}
		// The "already open, opens once" claim is true only of Auction.
		expect(auctionOpenRefusalDetail({ kind: 'phase', phase: 'Archived' })).not.toContain(
			'already open'
		);
	});

	it('names no fixed source count in the not_promoted sentence', () => {
		// Thirty-one is the league's size today, not a rule the core owns.
		const detail = auctionOpenRefusalDetail({ kind: 'not_promoted' });
		expect(detail).not.toMatch(/thirty-one|thirty one|31/i);
	});

	it('opens with zero Minor League Eligible Players', () => {
		expect(refuseAuctionOpen(readyState({ eligibleCount: 0 }))).toBeNull();
	});
});

describe('auctionOpenRefusalDetail — one sentence per refusal, defined once', () => {
	const ALL: AuctionOpenRefusal[] = [
		{ kind: 'phase', phase: 'Auction' },
		{ kind: 'not_promoted' },
		{ kind: 'outstanding_sources', sourceNames: ['Lakers', POOL_SOURCE_LABEL] },
		{ kind: 'unbound_teams', teamNames: ['Celtics'] },
		{ kind: 'no_teams' },
		{ kind: 'unconfirmed' },
		{ kind: 'unrecorded' },
		{ kind: 'unbound_actor' }
	];

	it.each(ALL.map((refusal) => [refusal.kind, refusal] as const))(
		'%s states a finished sentence and never apologises',
		(_kind: string, refusal: AuctionOpenRefusal) => {
			const detail = auctionOpenRefusalDetail(refusal);
			expect(detail.length).toBeGreaterThan(20);
			expect(detail.trim().endsWith('.')).toBe(true);
			expect(detail).not.toMatch(/sorry|oops|!/i);
		}
	);

	it('says nothing was written on every refusal a submit can reach', () => {
		for (const refusal of ALL.filter((entry) => entry.kind !== 'unbound_actor')) {
			expect(auctionOpenRefusalDetail(refusal)).toContain('Nothing was written');
		}
	});

	it('gives every refusal kind a distinct sentence', () => {
		const sentences = ALL.map((refusal) => auctionOpenRefusalDetail(refusal));
		expect(new Set(sentences).size).toBe(ALL.length);
	});
});

// --- the report -------------------------------------------------------------

describe('eligibilitySentence — the count in words, never a gate', () => {
	it('states zero as “No Player”, not as a missing value', () => {
		expect(eligibilitySentence(0)).toContain('No Player is marked Minor League Eligible');
	});

	it('states one in the singular', () => {
		expect(eligibilitySentence(1)).toContain('One Player is marked');
	});

	it('states many with the number', () => {
		expect(eligibilitySentence(41)).toContain('41 Players are marked');
	});

	it('says plainly that it does not block, whatever the number', () => {
		for (const count of [0, 1, 41]) {
			expect(eligibilitySentence(count)).toContain('does not stop the auction opening');
		}
	});
});

describe('preOpenReport', () => {
	it('reports ready exactly when the gate holds', () => {
		const report = preOpenReport(readyState());
		expect(report.ready).toBe(true);
		expect(report.refusal).toBeNull();
		expect(report.refusalDetail).toBeNull();
		expect(report.outstandingSources).toEqual([]);
		expect(report.unboundTeams).toEqual([]);
	});

	it('names every outstanding item individually, and carries the gate’s own sentence', () => {
		const promotion = fold(
			INITIAL_PROMOTION,
			[event(1, IMPORT_PROMOTED_EVENT, promotedPayload(29, 0))],
			promotedSourcesReducer
		);
		const report = preOpenReport(
			readyState({ promotion, teams: teams(30, { 2: { hasManager: false } }) })
		);
		expect(report.ready).toBe(false);
		expect(report.outstandingSources).toEqual(['Team 29', POOL_SOURCE_LABEL]);
		// Named even though the gate refuses on the earlier one: the
		// Commissioner sees everything outstanding at once, not one item per
		// round trip.
		expect(report.unboundTeams).toEqual(['Team 02']);
		expect(report.refusalDetail).toBe(
			auctionOpenRefusalDetail(report.refusal as AuctionOpenRefusal)
		);
	});

	it('states the eligible count in words, and the consequence from its one definition', () => {
		const report = preOpenReport(readyState({ eligibleCount: 0 }));
		expect(report.eligibilitySentence).toBe(eligibilitySentence(0));
		expect(report.consequence).toContain(AUCTION_OPEN_CONSEQUENCE);
		expect(report.consequence).toContain('cannot be undone');
	});

	it('never reports ready for a state the gate would refuse', () => {
		const states: AuctionOpenState[] = [
			readyState({ phase: 'Auction' }),
			readyState({ promotion: INITIAL_PROMOTION }),
			readyState({ teams: teams(30, { 0: { hasManager: false } }) })
		];
		for (const state of states) {
			expect(preOpenReport(state).ready).toBe(refuseAuctionOpen(state) === null);
			expect(preOpenReport(state).ready).toBe(false);
		}
	});
});
