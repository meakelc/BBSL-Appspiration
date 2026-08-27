/**
 * `auctionsReducer` and the Auction Clock's rendering (Story 2.5).
 *
 * Pure fold tests: an `AppendedEvent` literal in, a state out. No database,
 * no HTTP, no clock — `now` is an argument wherever one appears at all.
 */

import { describe, expect, it } from 'vitest';

import { AUCTION_CLOCK } from '../src/lib/core/constants.ts';
import {
	BID_PLACED_EVENT,
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer,
	closeInstantFor,
	closesInPhrase,
	contentionOf
} from '../src/lib/core/projection/auctions.ts';
import { AUCTION_CLOSED_EVENT } from '../src/lib/core/projection/nominations.ts';
import { fold } from '../src/lib/core/projection/fold.ts';
import type { AppendedEvent } from '../src/lib/core/types.ts';

function event(
	seq: number,
	type: string,
	payload: unknown,
	occurredAt = '2026-08-26T09:00:00.000Z'
): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt,
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: 'm-0',
		teamId: 't-0',
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

function bid(
	seq: number,
	amount: number,
	options: {
		fantraxPlayerId?: string;
		teamId?: string;
		teamName?: string;
		managerId?: string;
		occurredAt?: string;
		closesAt?: string;
	} = {}
): AppendedEvent {
	const occurredAt = options.occurredAt ?? '2026-08-26T09:00:00.000Z';
	return event(
		seq,
		BID_PLACED_EVENT,
		{
			fantraxPlayerId: options.fantraxPlayerId ?? 'p-1',
			teamId: options.teamId ?? 't-1',
			teamName: options.teamName ?? 'Lakers',
			managerId: options.managerId ?? 'm-1',
			amount,
			closesAt: options.closesAt ?? closeInstantFor(occurredAt, AUCTION_CLOCK)
		},
		occurredAt
	);
}

const at = (log: readonly AppendedEvent[], id = 'p-1') =>
	auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), id);

describe('auctionsReducer — with no BidPlaced, no Auction has a price', () => {
	it('starts empty and stays empty for an event type it has not been taught', () => {
		expect(INITIAL_AUCTIONS.byPlayer).toEqual({});
		expect(at([event(1, 'NominationPlaced', { fantraxPlayerId: 'p-1', teamId: 't-1' })])).toBeNull();
	});

	it('reports awaiting_opening_bid for a Player with no Auction row — never "no Auction"', () => {
		expect(contentionOf(null)).toBe('awaiting_opening_bid');
	});

	it('is not fooled by a key that names an Object.prototype member', () => {
		// The keys are Fantrax player ids, which are data.
		expect(at([], 'constructor')).toBeNull();
		expect(at([], '__proto__')).toBeNull();
		expect(at([], 'toString')).toBeNull();
	});
});

describe('auctionsReducer — the leading Bid, the price and the close instant', () => {
	it('folds one Bid into a leading Bid, a Standard Contention and a close instant', () => {
		const auction = at([
			bid(2, 8_000_000, { occurredAt: '2026-08-26T09:00:00.000Z' })
		]);
		expect(auction?.contention).toBe('standard');
		expect(auction?.leadingBid?.amount).toBe(8_000_000);
		expect(auction?.leadingBid?.teamId).toBe('t-1');
		expect(auction?.leadingBid?.managerId).toBe('m-1');
		// Exactly 24 hours after the Bid's own instant, absolute (AD-3).
		expect(auction?.closesAt).toBe('2026-08-27T09:00:00.000Z');
	});

	it('takes the raise as the leader and moves the close with it', () => {
		const auction = at([
			bid(2, 8_000_000, { occurredAt: '2026-08-26T09:00:00.000Z' }),
			bid(3, 8_500_000, {
				teamId: 't-2',
				teamName: 'Rockets',
				managerId: 'm-2',
				occurredAt: '2026-08-26T12:00:00.000Z'
			})
		]);
		expect(auction?.leadingBid?.amount).toBe(8_500_000);
		expect(auction?.leadingBid?.teamName).toBe('Rockets');
		expect(auction?.closesAt).toBe('2026-08-27T12:00:00.000Z');
	});

	it('keeps every Bid in seq order, oldest first, whatever the timestamps say', () => {
		// Under the global lock a transaction queued on it commits later while
		// holding an earlier `occurred_at`, so `seq` is the only order that
		// matches history (AD-5) — the fold must not re-sort by time.
		const auction = at([
			bid(3, 8_500_000, { occurredAt: '2026-08-26T09:00:00.000Z' }),
			bid(2, 8_000_000, { occurredAt: '2026-08-26T12:00:00.000Z' })
		]);
		expect(auction?.bids.map((b) => b.seq)).toEqual(['2', '3']);
		expect(auction?.leadingBid?.seq).toBe('3');
	});

	it('folds an opening at exactly $1,000,000 as a Minimum-Bid Contention', () => {
		// A state literal the fold must be total over. Nothing in this story
		// APPENDS one — `rules/bidding.ts`'s opening gate refuses that amount —
		// but §10 example 26's second half needs the state to exist.
		const auction = at([bid(2, 1_000_000)]);
		expect(auction?.contention).toBe('minimum_bid');
	});

	it('keeps auctions separate, one per Player', () => {
		const log = [
			bid(2, 8_000_000, { fantraxPlayerId: 'p-1' }),
			bid(3, 2_000_000, { fantraxPlayerId: 'p-2' })
		];
		expect(at(log, 'p-1')?.leadingBid?.amount).toBe(8_000_000);
		expect(at(log, 'p-2')?.leadingBid?.amount).toBe(2_000_000);
	});
});

describe('auctionsReducer — totality and replay', () => {
	it('converges on a double replay', () => {
		const log = [bid(2, 8_000_000), bid(3, 8_500_000, { teamId: 't-2' })];
		const once = fold(INITIAL_AUCTIONS, log, auctionsReducer);
		expect(fold(once, log, auctionsReducer)).toEqual(once);
	});

	it('never lets a Bid at or below the leader take the lead, however it got into the log', () => {
		const auction = at([bid(2, 8_500_000), bid(3, 8_000_000, { teamId: 't-2' })]);
		expect(auction?.leadingBid?.amount).toBe(8_500_000);
		// It still happened, so it is still history.
		expect(auction?.bids).toHaveLength(2);
	});

	it('skips a malformed payload rather than throwing — an insert-only log cannot be corrected', () => {
		for (const payload of [
			null,
			'not an object',
			{},
			{ fantraxPlayerId: 'p-1' },
			{ fantraxPlayerId: 'p-1', teamId: 't-1' },
			{ fantraxPlayerId: 'p-1', teamId: 't-1', managerId: 'm-1' },
			{ fantraxPlayerId: 'p-1', teamId: 't-1', managerId: 'm-1', amount: 'eight million' },
			{ fantraxPlayerId: 'p-1', teamId: 't-1', managerId: 'm-1', amount: 8.5 },
			{ fantraxPlayerId: '', teamId: 't-1', managerId: 'm-1', amount: 1 }
		]) {
			expect(() => fold(INITIAL_AUCTIONS, [event(2, BID_PLACED_EVENT, payload)], auctionsReducer))
				.not.toThrow();
			expect(at([event(2, BID_PLACED_EVENT, payload)])).toBeNull();
		}
	});

	it('accepts an int8 arriving as a string, which is how node-postgres hands one back', () => {
		const auction = at([
			event(2, BID_PLACED_EVENT, {
				fantraxPlayerId: 'p-1',
				teamId: 't-1',
				managerId: 'm-1',
				amount: '8500000',
				closesAt: '2026-08-27T09:00:00.000Z'
			})
		]);
		expect(auction?.leadingBid?.amount).toBe(8_500_000);
	});

	it('falls back to the Team id when the payload carries no Team name', () => {
		const auction = at([
			event(2, BID_PLACED_EVENT, {
				fantraxPlayerId: 'p-1',
				teamId: 't-1',
				managerId: 'm-1',
				amount: 8_000_000
			})
		]);
		expect(auction?.leadingBid?.teamName).toBe('t-1');
	});

	it('falls back to the Bid’s own instant when closesAt is absent or unreadable', () => {
		// The conservative direction: an Auction whose close cannot be read
		// reads as already due, never as running forever.
		for (const closesAt of [undefined, 'nonsense', 42]) {
			const auction = at([
				event(
					2,
					BID_PLACED_EVENT,
					{ fantraxPlayerId: 'p-1', teamId: 't-1', managerId: 'm-1', amount: 8_000_000, closesAt },
					'2026-08-26T09:00:00.000Z'
				)
			]);
			expect(auction?.closesAt).toBe('2026-08-26T09:00:00.000Z');
		}
	});
});

describe('auctionsReducer — AuctionClosed removes the Auction', () => {
	it('drops the Auction on a close naming its Player', () => {
		const auction = at([
			bid(2, 8_000_000),
			event(3, AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'p-1' })
		]);
		expect(auction).toBeNull();
	});

	it('leaves other Players’ auctions alone', () => {
		const log = [
			bid(2, 8_000_000, { fantraxPlayerId: 'p-1' }),
			bid(3, 2_000_000, { fantraxPlayerId: 'p-2' }),
			event(4, AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'p-1' })
		];
		expect(at(log, 'p-1')).toBeNull();
		expect(at(log, 'p-2')).not.toBeNull();
	});

	it('is a no-op for a close naming no Player, or one nobody bid on', () => {
		expect(at([bid(2, 8_000_000), event(3, AUCTION_CLOSED_EVENT, {})])?.leadingBid?.amount).toBe(
			8_000_000
		);
		expect(
			at([bid(2, 8_000_000), event(3, AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'p-9' })])
				?.leadingBid?.amount
		).toBe(8_000_000);
	});

	it('converges on a double replay of the close', () => {
		const log = [bid(2, 8_000_000), event(3, AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'p-1' })];
		const once = fold(INITIAL_AUCTIONS, log, auctionsReducer);
		expect(fold(once, log, auctionsReducer)).toEqual(once);
	});
});

describe('closeInstantFor — AUCTION_CLOCK after a Bid’s own instant', () => {
	it('adds exactly 24 hours', () => {
		expect(closeInstantFor('2026-08-26T09:00:00.000Z', AUCTION_CLOCK)).toBe(
			'2026-08-27T09:00:00.000Z'
		);
	});

	it('crosses a month boundary correctly', () => {
		expect(closeInstantFor('2026-08-31T23:30:00.000Z', AUCTION_CLOCK)).toBe(
			'2026-09-01T23:30:00.000Z'
		);
	});

	it('returns null rather than inventing an instant for unreadable text', () => {
		expect(closeInstantFor('nonsense', AUCTION_CLOCK)).toBeNull();
		expect(closeInstantFor('2026-02-30T09:00:00.000Z', AUCTION_CLOCK)).toBeNull();
	});
});

describe('closesInPhrase — the client counts down from an absolute instant', () => {
	it('reads hours and minutes for the ordinary case', () => {
		expect(closesInPhrase('2026-08-27T09:00:00.000Z', '2026-08-27T04:48:00.000Z')).toBe(
			'4h 12m left'
		);
	});

	it('reads minutes alone under an hour', () => {
		expect(closesInPhrase('2026-08-27T09:00:00.000Z', '2026-08-27T08:23:00.000Z')).toBe('37m left');
	});

	it('reads days and hours at a day or more — a fresh 24-hour clock', () => {
		expect(closesInPhrase('2026-08-27T09:00:00.000Z', '2026-08-26T09:00:00.000Z')).toBe(
			'1d 0h left'
		);
	});

	it('says so plainly once the clock has run out, rather than counting backwards', () => {
		expect(closesInPhrase('2026-08-27T09:00:00.000Z', '2026-08-27T09:00:00.000Z')).toBe(
			'no time left'
		);
		expect(closesInPhrase('2026-08-27T09:00:00.000Z', '2026-08-28T09:00:00.000Z')).toBe(
			'no time left'
		);
	});

	it('states an unknown time rather than throwing on an unreadable instant', () => {
		expect(closesInPhrase('nonsense', '2026-08-27T09:00:00.000Z')).toBe('an unknown time left');
		expect(closesInPhrase('2026-08-27T09:00:00.000Z', 'nonsense')).toBe('an unknown time left');
	});

	it('is pure — the same two instants always produce the same phrase', () => {
		const once = closesInPhrase('2026-08-27T09:00:00.000Z', '2026-08-26T20:00:00.000Z');
		expect(closesInPhrase('2026-08-27T09:00:00.000Z', '2026-08-26T20:00:00.000Z')).toBe(once);
	});
});
