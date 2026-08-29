/**
 * The Auction Contracts fold (Story 3.4, FR-21, AD-23).
 *
 * An Auction Contract is a fold, not a table, so what this suite pins is what
 * a fold has to be: total over any log it is handed, convergent under replay,
 * and silent about a malformed historical row an insert-only log can never
 * correct in place.
 *
 * It also pins the one thing AD-23 exists for — that the winning amount and
 * the Cap Hit are two persisted fields and neither is derived from the other.
 * The Minor League cases below carry a non-zero winning amount beside a $0 Cap
 * Hit for exactly that reason: a fold that assumed equality would pass every
 * Active/Bench case in this file and fail these.
 */

import { describe, expect, it } from 'vitest';

import {
	INITIAL_CONTRACTS,
	auctionContracts,
	contractForPlayer,
	contractRowsFor,
	contractsReducer
} from '../src/lib/core/projection/contracts.ts';
import { fold } from '../src/lib/core/projection/fold.ts';
import { AUCTION_CLOSED_EVENT } from '../src/lib/core/projection/nominations.ts';
import { computeCapSpace } from '../src/lib/core/rules/roster-import.ts';
import type { AppendedEvent } from '../src/lib/core/types.ts';

function event(seq: number, type: string, payload: unknown, occurredAt = '2026-08-27T09:00:00.000Z'): AppendedEvent {
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

/** A well-formed close, as `decideClose` builds one. */
function close(
	seq: number,
	overrides: Record<string, unknown> = {},
	occurredAt = '2026-08-27T09:00:00.000Z'
): AppendedEvent {
	return event(
		seq,
		AUCTION_CLOSED_EVENT,
		{
			fantraxPlayerId: 'p-1',
			playerName: 'Ausar Bright',
			teamId: 't-1',
			teamName: 'Team M',
			managerId: 'm-1',
			winningAmount: 8_000_000,
			capHit: 8_000_000,
			placement: 'active_bench',
			contention: 'standard',
			contractYears: null,
			closedAt: '2026-08-27T09:00:00.000Z',
			...overrides
		},
		occurredAt
	);
}

const foldClosures = (...events: readonly AppendedEvent[]) =>
	fold(INITIAL_CONTRACTS, events, contractsReducer);

describe('contractsReducer — what a close records', () => {
	it('records nothing at all before a close', () => {
		expect(INITIAL_CONTRACTS.byPlayer).toEqual({});
		expect(contractForPlayer(INITIAL_CONTRACTS, 'p-1')).toBeNull();
		expect(auctionContracts(INITIAL_CONTRACTS)).toEqual([]);
	});

	it('records the placement and BOTH money fields (AD-23)', () => {
		const contracts = foldClosures(
			close(1, { winningAmount: 4_000_000, capHit: 0, placement: 'minor_league' })
		);

		expect(contractForPlayer(contracts, 'p-1')).toEqual({
			fantraxPlayerId: 'p-1',
			playerName: 'Ausar Bright',
			teamId: 't-1',
			teamName: 'Team M',
			// The winning amount STANDS at what was bid...
			winningAmount: 4_000_000,
			// ...while the Cap Hit is $0. Two fields, neither read out of the
			// other — this is the whole of AD-23 as a fold sees it.
			capHit: 0,
			placement: 'minor_league',
			contractYears: null,
			closedAt: '2026-08-27T09:00:00.000Z'
		});
	});

	it('records contract length UNSET, never as a zero-length deal', () => {
		// FR-21 records the length unset at a close; Epic 6 assigns it. `null`
		// is the absence; `0` would be a length, and a wrong one.
		expect(contractForPlayer(foldClosures(close(1)), 'p-1')?.contractYears).toBeNull();
	});

	it('keeps the Auction’s NOMINAL expiry, not the event’s own instant', () => {
		// A late close and an on-time one differ only in `occurredAt`. The
		// contract states when the Auction was DUE, which is what makes a
		// stalled sweep produce late closes rather than wrong ones (AD-10).
		const late = foldClosures(
			close(1, { closedAt: '2026-08-27T09:00:00.000Z' }, '2026-08-27T15:00:00.000Z')
		);
		expect(contractForPlayer(late, 'p-1')?.closedAt).toBe('2026-08-27T09:00:00.000Z');
	});

	it('is not about events it has not been taught', () => {
		const contracts = foldClosures(event(1, 'BidPlaced', { fantraxPlayerId: 'p-1', amount: 1 }));
		expect(contracts).toEqual(INITIAL_CONTRACTS);
	});
});

describe('contractsReducer — first close wins, and replay converges (AD-5)', () => {
	it('keeps the FIRST close seen for a Player', () => {
		const contracts = foldClosures(
			close(1, { teamId: 't-1', teamName: 'Team M', winningAmount: 8_000_000 }),
			close(2, { teamId: 't-9', teamName: 'Team Z', winningAmount: 30_000_000 })
		);

		expect(contractForPlayer(contracts, 'p-1')?.teamId).toBe('t-1');
		expect(contractForPlayer(contracts, 'p-1')?.winningAmount).toBe(8_000_000);
		expect(auctionContracts(contracts)).toHaveLength(1);
	});

	it('converges on a double fold of the same log', () => {
		const log = [
			close(1),
			close(2, { fantraxPlayerId: 'p-2', teamId: 't-2', teamName: 'Team N' })
		];
		const once = fold(INITIAL_CONTRACTS, log, contractsReducer);
		expect(fold(once, log, contractsReducer)).toEqual(once);
	});

	it('does not read a prototype key back as a contract', () => {
		// The keys are Fantrax player ids, which are data. `hasOwn` is what
		// stops `constructor` reading back as an inherited function.
		expect(contractForPlayer(INITIAL_CONTRACTS, 'constructor')).toBeNull();
		expect(contractForPlayer(INITIAL_CONTRACTS, '__proto__')).toBeNull();

		const contracts = foldClosures(close(1, { fantraxPlayerId: '__proto__' }));
		expect(contractForPlayer(contracts, '__proto__')?.teamId).toBe('t-1');
		expect(contractForPlayer(contracts, 'p-1')).toBeNull();
	});
});

describe('contractsReducer — a malformed close is SKIPPED, never thrown over', () => {
	const skipped: Array<[what: string, event: AppendedEvent]> = [
		['a payload that is not an object', event(1, AUCTION_CLOSED_EVENT, 'nonsense')],
		['a null payload', event(1, AUCTION_CLOSED_EVENT, null)],
		['no Player named', close(1, { fantraxPlayerId: undefined })],
		['an empty Player id', close(1, { fantraxPlayerId: '' })],
		['no winning Team', close(1, { teamId: undefined })],
		['an unparseable winning amount', close(1, { winningAmount: 'lots' })],
		['an unparseable Cap Hit', close(1, { capHit: {} })],
		['a negative winning amount', close(1, { winningAmount: -1 })],
		['a negative Cap Hit', close(1, { capHit: -1 })],
		['no placement', close(1, { placement: undefined })],
		// A close cannot put a Player on Injury Reserve, and guessing at an
		// unrecognised placement would move Roster Count and the Cap on the
		// strength of a corrupt row.
		['an Injury Reserve placement', close(1, { placement: 'injury_reserve' })],
		['a placement that is not a slot kind', close(1, { placement: 'somewhere_else' })]
	];

	it.each(skipped)('skips %s', (_what, malformed) => {
		expect(() => foldClosures(malformed)).not.toThrow();
		expect(foldClosures(malformed)).toEqual(INITIAL_CONTRACTS);
	});

	it('leaves the rest of the log folding around it', () => {
		const contracts = foldClosures(
			close(1, { fantraxPlayerId: undefined }),
			close(2, { fantraxPlayerId: 'p-2', teamId: 't-2', teamName: 'Team N' })
		);
		expect(auctionContracts(contracts)).toHaveLength(1);
		expect(contractForPlayer(contracts, 'p-2')?.teamName).toBe('Team N');
	});

	it('REPAIRS the audit-detail fields rather than dropping a real contract', () => {
		// Names fall back to their ids and `closedAt` to the event's own
		// instant: losing a won Player over a cosmetic field would silently
		// return them to the pool, which is far the worse failure.
		const contracts = foldClosures(
			close(
				1,
				{ playerName: undefined, teamName: '', closedAt: undefined },
				'2026-08-27T11:00:00.000Z'
			)
		);
		expect(contractForPlayer(contracts, 'p-1')).toMatchObject({
			playerName: 'p-1',
			teamName: 't-1',
			closedAt: '2026-08-27T11:00:00.000Z'
		});
	});
});

describe('contractRowsFor — the ONE bridge to the Cap arithmetic', () => {
	it('answers a Team with no contracts with no rows', () => {
		expect(contractRowsFor(INITIAL_CONTRACTS, 't-1')).toEqual([]);
	});

	it('emits an Active/Bench row at the winning amount', () => {
		const contracts = foldClosures(close(1, { winningAmount: 8_000_000, capHit: 8_000_000 }));
		expect(contractRowsFor(contracts, 't-1')).toEqual([
			{ capHit: 8_000_000, rosterSlotKind: 'active_bench' }
		]);
	});

	it('emits a $0 Minor League row while the winning amount stands (AD-23)', () => {
		const contracts = foldClosures(
			close(1, { winningAmount: 4_000_000, capHit: 0, placement: 'minor_league' })
		);

		expect(contractRowsFor(contracts, 't-1')).toEqual([
			{ capHit: 0, rosterSlotKind: 'minor_league' }
		]);
		// ...and the contract still says $4,000,000, which is the point.
		expect(contractForPlayer(contracts, 'p-1')?.winningAmount).toBe(4_000_000);
		// `computeCapSpace` zeroes a Minor League row on its own terms too, so
		// the rule holds even against a historical payload that disagreed.
		expect(computeCapSpace(contractRowsFor(contracts, 't-1')).capHitTotal).toBe(0);
	});

	it('emits only the named Team’s rows, in sorted Player order (AD-5)', () => {
		const contracts = foldClosures(
			close(1, { fantraxPlayerId: 'p-z', winningAmount: 3_000_000, capHit: 3_000_000 }),
			close(2, { fantraxPlayerId: 'p-a', winningAmount: 2_000_000, capHit: 2_000_000 }),
			close(3, { fantraxPlayerId: 'p-m', teamId: 't-2', teamName: 'Team N' })
		);

		// A sum's inputs are a sequence: sorted by Player id, not by fold
		// order, so two evaluations of one state cannot add up differently.
		expect(contractRowsFor(contracts, 't-1')).toEqual([
			{ capHit: 2_000_000, rosterSlotKind: 'active_bench' },
			{ capHit: 3_000_000, rosterSlotKind: 'active_bench' }
		]);
	});
});
