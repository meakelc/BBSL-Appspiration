/**
 * `auctionsReducer` and the Auction Clock's rendering (Story 2.5).
 *
 * Pure fold tests: an `AppendedEvent` literal in, a state out. No database,
 * no HTTP, no clock — `now` is an argument wherever one appears at all.
 */

import { describe, expect, it } from 'vitest';

import { AUCTION_CLOCK, MINIMUM_BID } from '../src/lib/core/constants.ts';
import {
	AUCTION_EXPIRED,
	BID_PLACED_EVENT,
	CONTENTION_CLOCK_UNMOVED,
	INITIAL_AUCTIONS,
	MINIMUM_BID_CONTENTION_LABEL,
	auctionForPlayer,
	auctionsReducer,
	closeInstantFor,
	closesInPhrase,
	contenderCountSentence,
	contentionForAmount,
	contentionOf,
	hasExpired
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
		/** Story 3.2: `hash(seed)`, on the Bid that opened a contention. */
		seedHash?: unknown;
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
			closesAt: options.closesAt ?? closeInstantFor(occurredAt, AUCTION_CLOCK),
			// Spread so the key is genuinely ABSENT unless a test supplies
			// one: `seedHash: undefined` and no key at all are different
			// payloads once they have been through JSON, and the reducer's
			// defensive read has to answer for the second.
			...('seedHash' in options ? { seedHash: options.seedHash } : {})
		},
		occurredAt
	);
}

/** The opening Bid of a Minimum-Bid Contention, with its published commitment. */
const SEED_HASH = 'f'.repeat(64);

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

	it('states the last minute in words rather than as 0m left', () => {
		expect(closesInPhrase('2026-08-27T09:00:00.000Z', '2026-08-27T08:59:23.000Z')).toBe(
			'less than a minute left'
		);
	});

	it('is pure — the same two instants always produce the same phrase', () => {
		const once = closesInPhrase('2026-08-27T09:00:00.000Z', '2026-08-26T20:00:00.000Z');
		expect(closesInPhrase('2026-08-27T09:00:00.000Z', '2026-08-26T20:00:00.000Z')).toBe(once);
	});

	it('still returns every phrase it returned before Story 3.1 — the gate reads hasExpired, not this', () => {
		// `expiry` decides through `hasExpired`; this function is a rendering
		// and Story 3.1 changed none of its wordings. The whole set, asserted
		// together so a later edit to one cannot slip past the cases above.
		const closes = '2026-08-27T09:00:00.000Z';
		expect([
			closesInPhrase(closes, '2026-08-26T09:00:00.000Z'),
			closesInPhrase(closes, '2026-08-27T04:48:00.000Z'),
			closesInPhrase(closes, '2026-08-27T08:23:00.000Z'),
			closesInPhrase(closes, '2026-08-27T08:59:23.000Z'),
			closesInPhrase(closes, closes),
			closesInPhrase('nonsense', closes)
		]).toEqual([
			'1d 0h left',
			'4h 12m left',
			'37m left',
			'less than a minute left',
			'no time left',
			'an unknown time left'
		]);
	});
});

// --- Story 3.1: expiry-as-authority, in one derivation ---------------------

describe('hasExpired — the ONE comparison expiry-as-authority is made through', () => {
	const CLOSES = '2026-08-27T09:00:00.000Z';

	it('passes one millisecond before the close', () => {
		expect(hasExpired(CLOSES, '2026-08-27T08:59:59.999Z')).toBe(false);
	});

	it('EXPIRES at exactly the close instant', () => {
		// `now >= closesAt`, not `>`: Story 3.5 hands each Auction its own
		// nominal expiry as `now`, so a Bid at that instant must not beat the
		// close it is being compared against.
		expect(hasExpired(CLOSES, CLOSES)).toBe(true);
	});

	it('expires one millisecond after, and identically thirty days after', () => {
		expect(hasExpired(CLOSES, '2026-08-27T09:00:00.001Z')).toBe(true);
		expect(hasExpired(CLOSES, '2026-09-26T09:00:00.000Z')).toBe(true);
	});

	it('passes when there is no clock at all — nominated, nobody has bid', () => {
		expect(hasExpired(null, '2026-09-26T09:00:00.000Z')).toBe(false);
		expect(hasExpired(null, '')).toBe(false);
	});

	it('reads an unreadable close instant as EXPIRED', () => {
		// `readPayload`'s own stated direction: an Auction whose close cannot
		// be read reads as already due rather than as running forever.
		expect(hasExpired('nonsense', CLOSES)).toBe(true);
		expect(hasExpired('2026-02-30T09:00:00.000Z', CLOSES)).toBe(true);
		expect(hasExpired('', CLOSES)).toBe(true);
	});

	it('reads an unreadable or empty `now` as NOT expired', () => {
		// The opposite direction, on purpose: `now` is the shell's to supply,
		// and AD-1 makes a shell bug a throw rather than a returned refusal.
		// Refusing here would swallow `decide()`'s TypeError into a
		// Manager-facing statement that is not true.
		expect(hasExpired(CLOSES, '')).toBe(false);
		expect(hasExpired(CLOSES, 'nonsense')).toBe(false);
		expect(hasExpired(CLOSES, '2026-02-30T09:00:00.000Z')).toBe(false);
	});

	it('is pure — the same two instants always give the same answer', () => {
		const once = hasExpired(CLOSES, '2026-08-27T10:00:00.000Z');
		expect(hasExpired(CLOSES, '2026-08-27T10:00:00.000Z')).toBe(once);
	});
});

describe('AUCTION_EXPIRED — the one sentence the board states', () => {
	it('is a complete sentence a surface prints verbatim', () => {
		expect(AUCTION_EXPIRED).toBe('This Auction expired.');
	});

	it('quotes no figure of any kind', () => {
		expect(AUCTION_EXPIRED).not.toMatch(/\d/);
		expect(AUCTION_EXPIRED).not.toContain('$');
	});
});

// --- Story 3.2: the Contender list, folded from the Bids the log holds -----

describe('contendersFor — ascending join seq, one per Team (AD-14)', () => {
	it('makes the opener of a lottery its first Contender', () => {
		const auction = at([bid(1, MINIMUM_BID, { teamId: 't-1', teamName: 'Lakers' })]);
		expect(auction?.contention).toBe('minimum_bid');
		expect(auction?.contenders).toEqual([{ seq: '1', teamId: 't-1', teamName: 'Lakers' }]);
	});

	it('orders Contenders by ascending seq and by nothing else', () => {
		// The joins are folded in seq order — `fold()` guarantees it (AD-5) —
		// and their own `occurredAt` runs BACKWARDS relative to it here, which
		// is legitimate under the global lock. AD-14 pins the order to `seq`,
		// so the list must follow the log rather than the wall clock.
		const auction = at([
			bid(1, MINIMUM_BID, { teamId: 't-1', teamName: 'Lakers', occurredAt: '2026-08-26T09:00:00.000Z' }),
			bid(2, MINIMUM_BID, { teamId: 't-2', teamName: 'Rockets', occurredAt: '2026-08-26T20:00:00.000Z' }),
			bid(3, MINIMUM_BID, { teamId: 't-3', teamName: 'Bulls', occurredAt: '2026-08-26T14:00:00.000Z' })
		]);
		expect(auction?.contenders.map((contender) => contender.teamId)).toEqual([
			't-1',
			't-2',
			't-3'
		]);
		expect(auction?.contenders.map((contender) => contender.seq)).toEqual(['1', '2', '3']);
	});

	it('deduplicates on Team, keeping the EARLIEST join', () => {
		// The gate refuses a second join by name, so this is a log this
		// codebase cannot write — but the order is an input to the winner, and
		// a Team appearing twice would get two chances at the draw.
		const auction = at([
			bid(1, MINIMUM_BID, { teamId: 't-1', teamName: 'Lakers' }),
			bid(2, MINIMUM_BID, { teamId: 't-2', teamName: 'Rockets' }),
			bid(3, MINIMUM_BID, { teamId: 't-1', teamName: 'Lakers' })
		]);
		expect(auction?.contenders).toEqual([
			{ seq: '1', teamId: 't-1', teamName: 'Lakers' },
			{ seq: '2', teamId: 't-2', teamName: 'Rockets' }
		]);
	});

	it('does NOT count a $1,000,001 Bid — it folds into history but never joined', () => {
		// A malformed historical row on a lottery. It is a Bid that happened,
		// so it is in `bids` and in the visible history; it is not a join, so
		// the draw does not run over it.
		const auction = at([
			bid(1, MINIMUM_BID, { teamId: 't-1', teamName: 'Lakers' }),
			bid(2, 1_000_001, { teamId: 't-2', teamName: 'Rockets' })
		]);
		expect(auction?.bids).toHaveLength(2);
		expect(auction?.contenders.map((contender) => contender.teamId)).toEqual(['t-1']);
	});

	it('is empty for an Auction in Standard Contention', () => {
		expect(at([bid(1, 8_000_000)])?.contenders).toEqual([]);
	});
});

describe('a join moves neither the lead nor the clock', () => {
	const OPENED = '2026-08-26T09:00:00.000Z';
	const CLOSES = '2026-08-27T09:00:00.000Z';

	it('keeps the opener leading and the close instant unmoved after three joins', () => {
		// PRD §10 example 7, at the fold. Each join carries the CONTENTION's
		// close instant on its own payload — which is what `decide()` stamps —
		// so the fold has nothing to preserve by accident.
		const auction = at([
			bid(1, MINIMUM_BID, { teamId: 't-e', teamName: 'Team E', occurredAt: OPENED }),
			bid(2, MINIMUM_BID, {
				teamId: 't-f',
				teamName: 'Team F',
				occurredAt: '2026-08-26T14:00:00.000Z',
				closesAt: CLOSES
			}),
			bid(3, MINIMUM_BID, {
				teamId: 't-g',
				teamName: 'Team G',
				occurredAt: '2026-08-26T20:00:00.000Z',
				closesAt: CLOSES
			}),
			bid(4, MINIMUM_BID, {
				teamId: 't-h',
				teamName: 'Team H',
				occurredAt: '2026-08-27T08:55:00.000Z',
				closesAt: CLOSES
			})
		]);

		expect(auction?.closesAt).toBe(CLOSES);
		expect(auction?.leadingBid.teamId).toBe('t-e');
		expect(auction?.leadingBid.amount).toBe(MINIMUM_BID);
		expect(auction?.contention).toBe('minimum_bid');
		expect(auction?.contenders.map((contender) => contender.teamName)).toEqual([
			'Team E',
			'Team F',
			'Team G',
			'Team H'
		]);
	});

	it('is unmoved even by a join whose payload claims a LATER close', () => {
		// The fold's second guarantee, tested on its own terms: a join is
		// never strictly higher, so it never becomes the leading Bid and its
		// `closesAt` never becomes the Auction's. `decide()` is what stops
		// such a payload being written; this is what stops one already in the
		// log from moving the clock.
		const auction = at([
			bid(1, MINIMUM_BID, { teamId: 't-1', occurredAt: OPENED }),
			bid(2, MINIMUM_BID, {
				teamId: 't-2',
				occurredAt: '2026-08-26T20:00:00.000Z',
				closesAt: '2026-08-30T00:00:00.000Z'
			})
		]);
		expect(auction?.closesAt).toBe(CLOSES);
	});
});

describe('seedHash — read defensively, and the FIRST one wins', () => {
	it('folds the commitment off the opening Bid', () => {
		const auction = at([bid(1, MINIMUM_BID, { seedHash: SEED_HASH })]);
		expect(auction?.seedHash).toBe(SEED_HASH);
		expect(auction?.bids[0]?.seedHash).toBe(SEED_HASH);
	});

	it('is null when the key is absent, and never a throw', () => {
		const auction = at([bid(1, MINIMUM_BID)]);
		expect(auction?.seedHash).toBeNull();
		expect(auction?.bids[0]?.seedHash).toBeNull();
	});

	it('is null for every malformed shape, and the Bid still folds', () => {
		for (const malformed of [null, 42, {}, [], true, '']) {
			const auction = at([bid(1, MINIMUM_BID, { seedHash: malformed })]);
			expect(auction?.seedHash, JSON.stringify(malformed)).toBeNull();
			// The price, the Leading Bidder and the Contender list are all
			// still there: a corrupt commitment in an insert-only log is not
			// this fold's to crash over.
			expect(auction?.leadingBid.amount, JSON.stringify(malformed)).toBe(MINIMUM_BID);
			expect(auction?.contenders, JSON.stringify(malformed)).toHaveLength(1);
		}
	});

	it('keeps the FIRST commitment when a later Bid carries another', () => {
		// Replay must converge, and a second `seedHash` must not be able to
		// swap the commitment a Manager already recorded.
		const auction = at([
			bid(1, MINIMUM_BID, { teamId: 't-1', seedHash: SEED_HASH }),
			bid(2, MINIMUM_BID, { teamId: 't-2', seedHash: 'a'.repeat(64) })
		]);
		expect(auction?.seedHash).toBe(SEED_HASH);
	});

	it('is null on a Standard Contention, which publishes no commitment', () => {
		expect(at([bid(1, 8_000_000)])?.seedHash).toBeNull();
	});
});

describe('contentionForAmount — the ONE derivation the reducer and decide() share', () => {
	it('is minimum_bid at exactly the minimum and standard everywhere above it', () => {
		expect(contentionForAmount(MINIMUM_BID as never)).toBe('minimum_bid');
		expect(contentionForAmount(1_000_001 as never)).toBe('standard');
		expect(contentionForAmount(1_500_000 as never)).toBe('standard');
		expect(contentionForAmount(8_000_000 as never)).toBe('standard');
	});

	it('agrees with the fold for every amount the fold could see', () => {
		for (const amount of [MINIMUM_BID, 1_000_001, 1_500_000, 40_000_000]) {
			expect(at([bid(1, amount)])?.contention, String(amount)).toBe(
				contentionForAmount(amount as never)
			);
		}
	});
});

describe('the lottery’s own wording, beside the fold that decides it', () => {
	it('names the contention with the glossary term and no full stop', () => {
		expect(MINIMUM_BID_CONTENTION_LABEL).toBe('Minimum-Bid Contention');
		expect(MINIMUM_BID_CONTENTION_LABEL).not.toContain('.');
	});

	it('states in WORDS that the clock will not reset on a join', () => {
		expect(CONTENTION_CLOCK_UNMOVED).toContain('will not reset');
		expect(CONTENTION_CLOCK_UNMOVED).toContain('24 hours');
		// A fact about the clock, and no money figure on it.
		expect(CONTENTION_CLOCK_UNMOVED).not.toMatch(/\$/);
	});

	it('words the Contender count, singular and plural alike', () => {
		expect(contenderCountSentence(0)).toBe('No Teams have joined this contention yet.');
		expect(contenderCountSentence(1)).toBe('One Contender so far.');
		expect(contenderCountSentence(4)).toBe('4 Contenders so far.');
		// Never "1 Contenders".
		expect(contenderCountSentence(1)).not.toContain('Contenders');
	});
});
