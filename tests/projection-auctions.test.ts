/**
 * `auctionsReducer` and the Auction Clock's rendering (Story 2.5).
 *
 * Pure fold tests: an `AppendedEvent` literal in, a state out. No database,
 * no HTTP, no clock — `now` is an argument wherever one appears at all.
 */

import { describe, expect, it } from 'vitest';

import { closedPayload } from './fixtures/closed-event.ts';

import { AUCTION_CLOCK, MINIMUM_BID } from '../src/lib/core/constants.ts';
import {
	AUCTION_EXPIRED,
	BID_CANCELLED_EVENT,
	CAUSE_UNNAMED,
	BID_PLACED_EVENT,
	CONTENTION_CLOCK_UNMOVED,
	CONTENTION_DISSOLVED,
	CONTENTION_DISSOLVED_EVENT,
	INITIAL_AUCTIONS,
	MINIMUM_BID_CONTENTION_LABEL,
	MINIMUM_LOTTERY_LABEL,
	SEED_COMMITMENT_UNVERIFIABLE,
	SEED_REVEALED,
	auctionAtClose,
	auctionForPlayer,
	auctionsReducer,
	closeInstantFor,
	closesInPhrase,
	contenderCountSentence,
	contentionForAmount,
	contentionOf,
	formerContenderSentence,
	hasExpired,
	wasCancelled,
	wasDissolved,
	withBidCancelled
} from '../src/lib/core/projection/auctions.ts';
import {
	AUCTION_CLOSED_EVENT,
	AUCTION_TERMINATED_EVENT
} from '../src/lib/core/projection/nominations.ts';
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
			event(3, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1' }))
		]);
		expect(auction).toBeNull();
	});

	it('leaves other Players’ auctions alone', () => {
		const log = [
			bid(2, 8_000_000, { fantraxPlayerId: 'p-1' }),
			bid(3, 2_000_000, { fantraxPlayerId: 'p-2' }),
			event(4, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1' }))
		];
		expect(at(log, 'p-1')).toBeNull();
		expect(at(log, 'p-2')).not.toBeNull();
	});

	it('is a no-op for a close naming no Player, or one nobody bid on', () => {
		expect(at([bid(2, 8_000_000), event(3, AUCTION_CLOSED_EVENT, {})])?.leadingBid?.amount).toBe(
			8_000_000
		);
		expect(
			at([bid(2, 8_000_000), event(3, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-9' }))])
				?.leadingBid?.amount
		).toBe(8_000_000);
	});

	it('converges on a double replay of the close', () => {
		const log = [bid(2, 8_000_000), event(3, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1' }))];
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
		// `managerId` rides along from the joining Bid (Story 3.6): a drawn
		// winner names the Manager whose join put the Team in, and a lookup
		// back through `bids` would be a second, failable derivation.
		expect(auction?.contenders).toEqual([
			{ seq: '1', teamId: 't-1', teamName: 'Lakers', managerId: 'm-1' }
		]);
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
			{ seq: '1', teamId: 't-1', teamName: 'Lakers', managerId: 'm-1' },
			{ seq: '2', teamId: 't-2', teamName: 'Rockets', managerId: 'm-1' }
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
		expect(auction?.leadingBid?.teamId).toBe('t-e');
		expect(auction?.leadingBid?.amount).toBe(MINIMUM_BID);
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
	it('never adopts a LATER Bid’s commitment when the opener published none', () => {
		// The opening Bid is the only Bid `decide()` ever stamps, so an
		// Auction whose opener carries no readable `seedHash` HAS no
		// commitment. Taking a later Bid's would let a replay supply one
		// after the fact — the precise swap AD-14's commit half exists to
		// prevent.
		const auction = at([
			bid(1, MINIMUM_BID, { teamId: 't-1' }),
			bid(2, MINIMUM_BID, { teamId: 't-2', seedHash: SEED_HASH })
		]);
		expect(auction?.seedHash).toBeNull();
		// The Bid's own field still reads what the payload said — only the
		// Auction-level commitment is refused.
		expect(auction?.bids[1]?.seedHash).toBe(SEED_HASH);
	});

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
			expect(auction?.leadingBid?.amount, JSON.stringify(malformed)).toBe(MINIMUM_BID);
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

/** One `ContentionDissolved`, as `decide()` builds its payload (Story 3.3). */
function dissolved(
	seq: number,
	payload: unknown,
	occurredAt = '2026-08-26T14:00:00.000Z'
): AppendedEvent {
	return event(seq, CONTENTION_DISSOLVED_EVENT, payload, occurredAt);
}

/** The payload of a well-formed reveal for `p-1`. */
function reveal(seed: unknown = 'the-revealed-seed', fantraxPlayerId: unknown = 'p-1') {
	return {
		fantraxPlayerId,
		seed,
		seedHash: SEED_HASH,
		formerContenders: ['t-1', 't-2'],
		convertingTeamId: 't-3',
		amount: 1_500_000
	};
}

describe('ContentionDissolved — the reveal, folded and nothing else (Story 3.3)', () => {
	it('records the revealed seed on the Auction the converting Bid dissolved', () => {
		const auction = at([
			bid(1, MINIMUM_BID, { teamId: 't-1', seedHash: SEED_HASH }),
			bid(2, MINIMUM_BID, { teamId: 't-2' }),
			bid(3, 1_500_000, { teamId: 't-3', teamName: 'Bulls' }),
			dissolved(4, reveal())
		]);

		expect(auction?.seed).toBe('the-revealed-seed');
		// ...and the contention, the lead and the clock are the CONVERTING
		// BID's arithmetic, not this event's: the reveal writes nothing but
		// the seed.
		expect(auction?.contention).toBe('standard');
		expect(auction?.leadingBid?.teamId).toBe('t-3');
		expect(auction?.seedHash).toBe(SEED_HASH);
	});

	it('is null until one is folded — almost every Auction has nothing revealed', () => {
		expect(at([bid(1, 8_000_000)])?.seed).toBeNull();
		expect(at([bid(1, MINIMUM_BID, { seedHash: SEED_HASH })])?.seed).toBeNull();
	});

	it('leaves the Contender list and the Bid history untouched', () => {
		// **`contenders` is NOT cleared, and that is the rule.** "The
		// Contender list is discarded" is about commitment and the draw:
		// `teamMoneyStateFor` tests the contention STATE rather than the list
		// being empty, so a dissolved contention commits nobody while keeping
		// the history the reveal is about.
		const log = [
			bid(1, MINIMUM_BID, { teamId: 't-1', seedHash: SEED_HASH }),
			bid(2, MINIMUM_BID, { teamId: 't-2', teamName: 'Rockets' }),
			bid(3, 1_500_000, { teamId: 't-3', teamName: 'Bulls' })
		];
		const before = at(log);
		const after = at([...log, dissolved(4, reveal())]);

		expect(after?.contenders).toEqual(before?.contenders);
		expect(after?.contenders.map((contender) => contender.teamId)).toEqual(['t-1', 't-2']);
		expect(after?.bids).toEqual(before?.bids);
		expect(after?.closesAt).toBe(before?.closesAt);
	});

	it('keeps the FIRST seed seen, so replay converges', () => {
		const log = [
			bid(1, MINIMUM_BID, { teamId: 't-1', seedHash: SEED_HASH }),
			bid(2, 1_500_000, { teamId: 't-3' }),
			dissolved(3, reveal('first')),
			dissolved(4, reveal('second'))
		];
		expect(at(log)?.seed).toBe('first');
		// Folding the same log twice converges on the same state.
		expect(at([...log, ...log])?.seed).toBe('first');
	});

	it('is not erased by an ordinary Bid placed after the dissolution', () => {
		const auction = at([
			bid(1, MINIMUM_BID, { teamId: 't-1', seedHash: SEED_HASH }),
			bid(2, 1_500_000, { teamId: 't-3' }),
			dissolved(3, reveal()),
			bid(4, 2_000_000, { teamId: 't-4', teamName: 'Heat' })
		]);
		expect(auction?.seed).toBe('the-revealed-seed');
		expect(auction?.leadingBid?.teamId).toBe('t-4');
	});

	it('nulls a malformed seed rather than throwing, and folds everything else', () => {
		for (const malformed of [null, 42, {}, [], true, '']) {
			const log = [
				bid(1, MINIMUM_BID, { teamId: 't-1', seedHash: SEED_HASH }),
				bid(2, 1_500_000, { teamId: 't-3' }),
				dissolved(3, reveal(malformed))
			];
			const label = JSON.stringify(malformed) ?? 'undefined';
			expect(() => at(log), label).not.toThrow();
			expect(at(log)?.seed, label).toBeNull();
			// The Auction is otherwise exactly where the converting Bid left
			// it: a corrupt payload in an insert-only log is not this fold's
			// to crash over.
			expect(at(log)?.contention, label).toBe('standard');
			expect(at(log)?.leadingBid?.teamId, label).toBe('t-3');
		}
		// ...and the same for a payload with no `seed` key at all, which is a
		// different JSON shape from one carrying `null`.
		const noKey = [
			bid(1, MINIMUM_BID, { teamId: 't-1', seedHash: SEED_HASH }),
			bid(2, 1_500_000, { teamId: 't-3' }),
			dissolved(3, { fantraxPlayerId: 'p-1', convertingTeamId: 't-3' })
		];
		expect(at(noKey)?.seed).toBeNull();
		expect(at(noKey)?.contention).toBe('standard');
	});

	it('skips an event naming no Player, and one naming a Player with no Auction', () => {
		const opened = [
			bid(1, MINIMUM_BID, { teamId: 't-1', seedHash: SEED_HASH }),
			bid(2, 1_500_000, { teamId: 't-3' })
		];
		for (const payload of [
			null,
			42,
			'nonsense',
			{},
			reveal('s', ''),
			reveal('s', 7),
			reveal('s', 'p-nobody-bid-on')
		]) {
			const label = JSON.stringify(payload) ?? 'null';
			expect(() => at([...opened, dissolved(3, payload)]), label).not.toThrow();
			expect(at([...opened, dissolved(3, payload)])?.seed, label).toBeNull();
		}
		// ...and no Auction is invented for the Player it named.
		expect(at([...opened, dissolved(3, reveal('s', 'p-9'))], 'p-9')).toBeNull();
	});

	it('records NOTHING on an Auction that never ran a lottery', () => {
		// A hand-written or corrupt `ContentionDissolved` naming an ordinary
		// Auction must not set `seed`: that would make `wasDissolved` true and
		// put a dissolution block — former Contenders, a revealed seed, a
		// published hash — on a page whose Auction had none of those things.
		const ordinary = [bid(1, 8_000_000, { teamId: 't-1' }), bid(2, 9_000_000, { teamId: 't-2' })];
		const auction = at([...ordinary, dissolved(3, reveal())]);

		expect(auction?.seed).toBeNull();
		expect(auction?.contenders).toEqual([]);
		expect(auction === null ? true : wasDissolved(auction)).toBe(false);
		// ...and the Auction is otherwise untouched.
		expect(auction?.leadingBid?.teamId).toBe('t-2');
		expect(auction?.contention).toBe('standard');
	});

	it('is guarded on the CONTENDER LIST, not on the contention state', () => {
		// The distinction is load-bearing. By the time this case runs the
		// converting `BidPlaced` has already folded and moved the Auction to
		// `standard`, so a guard on `contention !== 'minimum_bid'` would
		// reject every genuine dissolution there is. `contenders` is never
		// cleared, so a non-empty list is the one durable evidence that a
		// lottery ran here — before and after the dissolution alike.
		const log = [
			bid(1, MINIMUM_BID, { teamId: 't-1', seedHash: SEED_HASH }),
			bid(2, 1_500_000, { teamId: 't-3' })
		];
		// The state at the moment the reveal is folded is already `standard`...
		expect(at(log)?.contention).toBe('standard');
		// ...and the list is still there, which is why the reveal lands.
		expect(at(log)?.contenders).toHaveLength(1);
		expect(at([...log, dissolved(3, reveal())])?.seed).toBe('the-revealed-seed');
	});

	it('changes nothing at all when no Bid has been folded for that Player', () => {
		const state = fold(INITIAL_AUCTIONS, [dissolved(1, reveal())], auctionsReducer);
		expect(state.byPlayer).toEqual({});
	});
});

describe('wasDissolved — the ONE derivation, so no surface assembles it', () => {
	it('is true only for a standard Auction with a revealed seed', () => {
		expect(wasDissolved({ contention: 'standard', seed: 'a-seed' })).toBe(true);
		// A live lottery: the seed is still sealed, so the fold has none.
		expect(wasDissolved({ contention: 'minimum_bid', seed: null })).toBe(false);
		// An Auction that never ran one.
		expect(wasDissolved({ contention: 'standard', seed: null })).toBe(false);
		expect(wasDissolved({ contention: 'awaiting_opening_bid', seed: null })).toBe(false);
		// Neither half alone is the answer.
		expect(wasDissolved({ contention: 'minimum_bid', seed: 'a-seed' })).toBe(false);
	});

	it('agrees with the fold, end to end', () => {
		const live = at([bid(1, MINIMUM_BID, { teamId: 't-1', seedHash: SEED_HASH })]);
		expect(live === null ? false : wasDissolved(live)).toBe(false);

		const gone = at([
			bid(1, MINIMUM_BID, { teamId: 't-1', seedHash: SEED_HASH }),
			bid(2, 1_500_000, { teamId: 't-3' }),
			dissolved(3, reveal())
		]);
		expect(gone === null ? false : wasDissolved(gone)).toBe(true);
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
		// The card name for the same contention — shorter, because a Bid Board
		// or Your Positions identity row is scanned beside a Player's name. It
		// is the ONE deliberate second name in the product, and it lives here
		// beside the term it shortens so a third spelling cannot appear.
		expect(MINIMUM_LOTTERY_LABEL).toBe('Minimum Lottery');
		expect(MINIMUM_LOTTERY_LABEL).not.toContain('.');
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

	it('words the FORMER Contender count in the past tense, never "so far"', () => {
		// A dissolved contention takes no further join, so a sentence
		// implying more may arrive would be false.
		expect(formerContenderSentence(0)).toBe(
			'No Teams had joined this contention when it dissolved.'
		);
		expect(formerContenderSentence(1)).toBe('One Team contended before this contention dissolved.');
		expect(formerContenderSentence(4)).toBe('4 Teams contended before this contention dissolved.');
		for (const count of [0, 1, 4]) {
			expect(formerContenderSentence(count), String(count)).not.toContain('so far');
		}
	});

	it('does not claim each of them was RELEASED — one of them may now lead', () => {
		// FR-19 permits a Contender to be the converting bidder, and the count
		// this sentence words is the whole list. On the page it sits above a
		// Leading Bidder line that may name one of the very Teams it is
		// describing, so a release claim would be false about one of them
		// beside the evidence that it is false. What they have in common is
		// that they contended.
		for (const count of [0, 1, 4]) {
			expect(formerContenderSentence(count), String(count)).not.toMatch(/releas/i);
		}
		expect(formerContenderSentence(4)).toContain('contended');
	});

	it('states what a dissolution IS, quoting no figure of any kind', () => {
		expect(CONTENTION_DISSOLVED).toContain('dissolved');
		expect(CONTENTION_DISSOLVED).toContain('Standard Contention');
		expect(CONTENTION_DISSOLVED).toContain('Minimum Increment');
		expect(CONTENTION_DISSOLVED).toContain('released');
		// Every figure renders beside it from the fold's own values; one
		// restated here would be a second copy that could disagree.
		expect(CONTENTION_DISSOLVED).not.toMatch(/\$|\d/);
	});

	it('states what the revealed seed IS, and that no draw ran', () => {
		expect(SEED_REVEALED).toContain('revealed');
		expect(SEED_REVEALED).toContain('commitment');
		// A revealed seed beside a Contender list would otherwise read as a
		// draw result.
		expect(SEED_REVEALED).toContain('No draw was run');
		expect(SEED_REVEALED).not.toMatch(/\$/);
	});

	it('has its OWN sentence for a commitment that folded to null', () => {
		expect(SEED_COMMITMENT_UNVERIFIABLE).toContain('No commitment was published');
		expect(SEED_COMMITMENT_UNVERIFIABLE).toContain('nothing to check');
		// The two are printed instead of one another, never together, so
		// neither may claim what the other denies.
		expect(SEED_COMMITMENT_UNVERIFIABLE).not.toContain('the two must match');
	});
});


// --- BidCancelled: the compensating event (Story 10.3, FR-40) -------------

/** A `BidCancelled` naming one Bid's `seq`, as `rules/close.ts` writes it. */
function cancelled(
	seq: number,
	cancelledSeq: unknown,
	options: {
		fantraxPlayerId?: unknown;
		cause?: string;
		causeName?: string;
		/** Story 10.4's recorded decision, unnarrowed so a test can malform it. */
		restoration?: unknown;
		/**
		 * Leave the `restoration` key OFF the payload altogether, rather than
		 * writing it as `null` (Story 10.4).
		 *
		 * A malformed value and an absent key are different inputs to
		 * `readRestoration`, and only this one models the Story 10.3 rows
		 * already in the log — every `BidCancelled` written before the
		 * restorer existed. `'restoration' in options` cannot express it,
		 * because passing `restoration: undefined` still writes the key.
		 */
		omitRestoration?: boolean;
	} = {}
): AppendedEvent {
	const restoration = options.omitRestoration
		? {}
		: { restoration: 'restoration' in options ? options.restoration : null };
	return event(seq, BID_CANCELLED_EVENT, {
		...restoration,
		fantraxPlayerId: 'fantraxPlayerId' in options ? options.fantraxPlayerId : 'p-1',
		playerName: 'Ausar Bright',
		cancelledSeq,
		teamId: 't-1',
		teamName: 'Lakers',
		managerId: 'm-1',
		amount: 4_000_000,
		wasContentionEntry: false,
		causeFantraxPlayerId: options.cause ?? 'p-cause',
		causePlayerName: options.causeName ?? 'Dex Brooks',
		causeTeamId: 't-1'
	});
}

/** The `restoration` a well-formed payload carries, for the Bid at `seq`. */
function restoring(seq: string, teamId: string, amount: number) {
	return { seq, teamId, teamName: `Team ${teamId}`, managerId: `m-${teamId}`, amount };
}

// --- An emptied lottery keeps its clock (Story 10.5, FR-40) ---------------

/** A `AuctionTerminated`, as `rules/close.ts` and `rules/phase-end.ts` write it. */
function terminated(seq: number, fantraxPlayerId: unknown = 'p-1'): AppendedEvent {
	return event(seq, AUCTION_TERMINATED_EVENT, {
		fantraxPlayerId,
		playerName: 'Ausar Bright',
		teamId: 't-n',
		teamName: 'Team N',
		managerId: 'm-n',
		expiredAt: '2026-08-27T09:00:00.000Z',
		evaluatedAt: '2026-08-27T09:00:00.000Z'
	});
}

describe('auctionsReducer — cancelling the LAST Contender does not stop the clock', () => {
	it('keeps `minimum_bid` and `closesAt` with the Contender list emptied', () => {
		// The whole seam. A lottery's `closesAt` is the CONTENTION's clock,
		// not any bidder's, so no Team's departure earns it — and only an
		// expiry the sweep still offers can reach the outcome the empty close
		// has to record.
		const log = [bid(1, 1_000_000, { teamId: 't-x' }), cancelled(2, '1')];
		const before = at([log[0] as AppendedEvent]);
		const auction = at(log);

		expect(auction?.contention).toBe('minimum_bid');
		expect(auction?.closesAt).toBe(before?.closesAt);
		expect(auction?.closesAt).not.toBeNull();
		expect(auction?.contenders).toEqual([]);
		expect(auction?.leadingBid).toBeNull();
		// The join is still in the history, marked — the record must show the
		// Team entered AND that its entry was cancelled.
		expect(auction?.bids).toHaveLength(1);
		expect(wasCancelled(auction?.bids[0] as never)).toBe(true);
	});

	it('keeps the clock however many joins are cancelled, down to none', () => {
		const opening = bid(1, 1_000_000, { teamId: 't-x' });
		const auction = at([
			opening,
			bid(2, 1_000_000, { teamId: 't-p' }),
			bid(3, 1_000_000, { teamId: 't-q' }),
			cancelled(4, '2'),
			cancelled(5, '3'),
			cancelled(6, '1')
		]);

		expect(auction?.contention).toBe('minimum_bid');
		expect(auction?.closesAt).toBe(at([opening])?.closesAt);
		expect(auction?.contenders).toEqual([]);
	});

	it('leaves the STANDARD leaderless branch exactly as Story 10.4 wrote it', () => {
		// The rule is narrowed to lotteries and nowhere else: outside one, no
		// leader still means no clock, because a cleared clock is what stops a
		// close at the old expiry with no winner.
		const auction = at([bid(1, 4_000_000, { teamId: 't-1' }), cancelled(2, '1')]);

		expect(auction?.contention).toBe('awaiting_opening_bid');
		expect(auction?.closesAt).toBeNull();
	});

	it('lets a new join re-enter an emptied lottery before its expiry', () => {
		// The clock is still running, so a Team may still bid MINIMUM_BID —
		// it becomes a Contender again and the Auction draws normally.
		const auction = at([
			bid(1, 1_000_000, { teamId: 't-x' }),
			cancelled(2, '1'),
			bid(3, 1_000_000, { teamId: 't-p' })
		]);

		expect(auction?.contention).toBe('minimum_bid');
		expect(auction?.contenders.map((entry) => entry.teamId)).toEqual(['t-p']);
		expect(auction?.leadingBid?.teamId).toBe('t-p');
		expect(auction?.closesAt).not.toBeNull();
	});
});

describe('auctionsReducer — AuctionTerminated drops the Auction (Story 10.5)', () => {
	it('removes an emptied lottery, so it is never offered to a second sweep', () => {
		const log = [bid(1, 1_000_000, { teamId: 't-x' }), cancelled(2, '1'), terminated(3)];

		expect(at(log)).toBeNull();
	});

	it('is idempotent — a second fold finds nothing to drop', () => {
		const log = [bid(1, 1_000_000, { teamId: 't-x' }), cancelled(2, '1'), terminated(3)];
		const once = fold(INITIAL_AUCTIONS, log, auctionsReducer);

		expect(fold(INITIAL_AUCTIONS, [...log, ...log], auctionsReducer)).toEqual(once);
		expect(fold(once, [terminated(4)], auctionsReducer)).toEqual(once);
	});

	it('changes nothing for a Player with no Auction, or a payload naming none', () => {
		// Every termination `phase-end.ts` appends is this case: a nomination
		// nobody ever bid on has no Auction row at all.
		expect(at([terminated(1)])).toBeNull();
		const live = [bid(1, 1_000_000, { teamId: 't-x' })];
		expect(at([...live, terminated(2, 'p-other')])).toEqual(at(live));
		expect(at([...live, terminated(2, 7)])).toEqual(at(live));
	});
});

describe('auctionsReducer — BidCancelled withdraws a Bid’s standing and nothing else', () => {
	it('marks the Bid, keeps it in history, and withdraws the lead', () => {
		const auction = at([
			bid(1, 4_000_000, { teamId: 't-1' }),
			bid(2, 6_000_000, { teamId: 't-2' }),
			cancelled(3, '2')
		]);

		// The history is untouched in length, order and content — one field
		// more on the Bid the event named.
		expect(auction?.bids.map((entry) => entry.seq)).toEqual(['1', '2']);
		expect(auction?.bids[1]?.amount).toBe(6_000_000);
		expect(wasCancelled(auction?.bids[1] as never)).toBe(true);
		expect(auction?.bids[1]?.cancellation?.seq).toBe('3');
		expect(auction?.bids[1]?.cancellation?.causeFantraxPlayerId).toBe('p-cause');
		expect(auction?.bids[1]?.cancellation?.causePlayerName).toBe('Dex Brooks');
		// The Bid it did not name keeps standing.
		expect(wasCancelled(auction?.bids[0] as never)).toBe(false);

		// **The lead is withdrawn, not handed down.** This payload records no
		// restoration, so the $4.0M Bid beneath does NOT take the lead — a
		// fold that promoted it would be restoring a Team no gate had
		// re-validated, which is precisely the decision `rules/restore.ts`
		// makes inside the closing transaction and this reducer only reads.
		expect(auction?.leadingBid).toBeNull();
		// ...and with no leader there is no clock and no contention, however
		// many Bids are still standing in `bids` (Story 10.4). A cleared clock
		// is what stops the Auction closing at its old expiry with no winner.
		expect(auction?.closesAt).toBeNull();
		expect(auction?.contention).toBe('awaiting_opening_bid');
	});

	it('leaves the lead alone when the cancelled Bid was not holding it', () => {
		const auction = at([
			bid(1, 4_000_000, { teamId: 't-1' }),
			bid(2, 6_000_000, { teamId: 't-2' }),
			cancelled(3, '1')
		]);

		expect(auction?.leadingBid?.seq).toBe('2');
		expect(auction?.leadingBid?.amount).toBe(6_000_000);
		expect(wasCancelled(auction?.bids[0] as never)).toBe(true);
	});

	it('clears the clock and returns to Awaiting Opening Bid when nothing survives', () => {
		const auction = at([bid(1, 4_000_000), cancelled(2, '1')]);

		expect(auction?.leadingBid).toBeNull();
		expect(auction?.closesAt).toBeNull();
		expect(auction?.contention).toBe('awaiting_opening_bid');
		// The Bid is still there. An insert-only log states what happened.
		expect(auction?.bids).toHaveLength(1);
		// A cleared clock is what stops a close at the old expiry (§10 ex 33).
		expect(hasExpired(auction?.closesAt ?? null, '2030-01-01T00:00:00.000Z')).toBe(false);
	});

	it('drops a cancelled Contender from the list and moves the fold’s artifact lead', () => {
		// In a lottery the leader is a fold artifact — every Contender holds
		// the identical $1,000,000 — so cancelling the opener moves it to the
		// next surviving join rather than stranding a contention that is still
		// running. Nobody's position or capital changes.
		const auction = at([
			bid(1, MINIMUM_BID, { teamId: 't-1', seedHash: SEED_HASH }),
			bid(2, MINIMUM_BID, { teamId: 't-2' }),
			cancelled(3, '1')
		]);

		expect(auction?.contention).toBe('minimum_bid');
		expect(auction?.contenders.map((contender) => contender.teamId)).toEqual(['t-2']);
		expect(auction?.leadingBid?.seq).toBe('2');
		expect(auction?.closesAt).toBe(closeInstantFor('2026-08-26T09:00:00.000Z', AUCTION_CLOCK));
		// The commitment is still published and still checkable.
		expect(auction?.seedHash).toBe(SEED_HASH);
	});

	it('converges under replay and ignores a second cancellation of the same Bid', () => {
		const log = [bid(1, 4_000_000), bid(2, 6_000_000), cancelled(3, '2')];
		const once = fold(INITIAL_AUCTIONS, log, auctionsReducer);
		const twice = fold(once, log, auctionsReducer);
		expect(twice).toEqual(once);

		// A second event naming the same `seq` changes nothing either — the
		// marker is already there and `withBidCancelled` returns the Auction
		// it was handed.
		const again = fold(once, [cancelled(4, '2')], auctionsReducer);
		expect(again).toEqual(once);
	});

	it('is total over a malformed or unmatched event, exactly as every other case is', () => {
		const base = [bid(1, 4_000_000)];
		const untouched = at(base);

		// No payload object at all.
		expect(at([...base, event(2, BID_CANCELLED_EVENT, 'not-an-object')])).toEqual(untouched);
		// No Player id, no cancelled `seq`, and non-string versions of each.
		expect(at([...base, cancelled(2, '1', { fantraxPlayerId: '' })])).toEqual(untouched);
		expect(at([...base, cancelled(2, 1)])).toEqual(untouched);
		expect(at([...base, cancelled(2, '')])).toEqual(untouched);
		// A Player with no Auction, and a `seq` this Auction never held.
		expect(at([...base, cancelled(2, '1', { fantraxPlayerId: 'p-other' })])).toEqual(untouched);
		expect(at([...base, cancelled(2, '99')])).toEqual(untouched);
	});

	it('names an unnameable cause in words rather than blank', () => {
		// A payload with neither a cause name nor a cause id — a corrupt row
		// this codebase cannot write. The cancellation still happened, and the
		// history line says so instead of trailing off into nothing.
		const auction = at([
			bid(1, 4_000_000),
			event(2, BID_CANCELLED_EVENT, { fantraxPlayerId: 'p-1', cancelledSeq: '1' })
		]);
		expect(auction?.bids[0]?.cancellation?.causePlayerName).toBe(CAUSE_UNNAMED);
		expect(auction?.bids[0]?.cancellation?.causePlayerName).not.toBe('');
	});

	it('falls back to the cause’s id when the cause has no readable name', () => {
		const auction = at([
			bid(1, 4_000_000),
			event(2, BID_CANCELLED_EVENT, {
				fantraxPlayerId: 'p-1',
				cancelledSeq: '1',
				causeFantraxPlayerId: 'p-cause'
			})
		]);
		expect(auction?.bids[0]?.cancellation?.causePlayerName).toBe('p-cause');
	});

	it('refuses the lead to a Bid BELOW a survivor — leaderless is not bidless', () => {
		// The trap the nullable leader sets. Cancelling the $6.0M leader
		// leaves the Auction with no leader and a $4.0M Bid still standing; a
		// $2.0M Bid arriving next must NOT lead, because the price would fall
		// on account of somebody else's cancellation. The Auction stays
		// leaderless — promoting the $4.0M survivor is restoration, and Story
		// 10.4 owns it — and keeps the clock it already had.
		const before = at([bid(1, 4_000_000, { teamId: 't-1' }), bid(2, 6_000_000, { teamId: 't-2' }), cancelled(3, '2')]);
		const after = at([
			bid(1, 4_000_000, { teamId: 't-1' }),
			bid(2, 6_000_000, { teamId: 't-2' }),
			cancelled(3, '2'),
			bid(4, 2_000_000, { teamId: 't-3', occurredAt: '2026-08-26T18:00:00.000Z' })
		]);

		expect(after?.leadingBid).toBeNull();
		expect(after?.closesAt).toBe(before?.closesAt);
		expect(after?.contention).toBe(before?.contention);
		// The Bid still happened, and history says so. (`seq` 3 is the
		// `BidCancelled` itself, which is not a Bid and is not in `bids`.)
		expect(after?.bids.map((entry) => entry.seq)).toEqual(['1', '2', '4']);
	});

	it('lets a Bid ABOVE the survivor take the lead, cancellation or not', () => {
		// The other side of the same comparison: the question is unchanged —
		// is this Bid strictly higher than what still stands? — and $5.0M is.
		const auction = at([
			bid(1, 4_000_000, { teamId: 't-1' }),
			bid(2, 6_000_000, { teamId: 't-2' }),
			cancelled(3, '2'),
			bid(4, 5_000_000, { teamId: 't-3', occurredAt: '2026-08-26T18:00:00.000Z' })
		]);

		expect(auction?.leadingBid?.seq).toBe('4');
		expect(auction?.leadingBid?.amount).toBe(5_000_000);
		expect(auction?.closesAt).toBe(auction?.leadingBid?.closesAt);
	});

	it('lets a fresh Bid lead a leaderless Auction, the way an Opening Bid does', () => {
		const auction = at([bid(1, 4_000_000), cancelled(2, '1'), bid(3, 1_500_000, { teamId: 't-9' })]);

		expect(auction?.leadingBid?.seq).toBe('3');
		expect(auction?.leadingBid?.amount).toBe(1_500_000);
		expect(auction?.closesAt).toBe(auction?.leadingBid?.closesAt);
	});

	it('exports the one derivation the reducer and the cascade share', () => {
		// `withBidCancelled` is exported so `rules/close.ts` can see the effect
		// of each cancellation before deciding whether another is owed. The
		// two callers must produce identical state from one decision.
		const folded = fold(INITIAL_AUCTIONS, [bid(1, 4_000_000), bid(2, 6_000_000)], auctionsReducer);
		const auction = auctionForPlayer(folded, 'p-1');
		if (auction === null) throw new Error('the Auction did not fold');

		const byHand = withBidCancelled(auction, '2', {
			seq: '3',
			causeFantraxPlayerId: 'p-cause',
			causePlayerName: 'Dex Brooks',
			// The same decision the fixture's payload carries: nothing restored.
			restoration: null
		});
		const byFold = at([bid(1, 4_000_000), bid(2, 6_000_000), cancelled(3, '2')]);
		expect(byHand).toEqual(byFold);

		// Idempotent, which is what makes the cascade's own modelling safe.
		expect(
			withBidCancelled(byHand, '2', {
				seq: '4',
				causeFantraxPlayerId: 'p-cause',
				causePlayerName: 'Dex Brooks',
				restoration: null
			})
		).toBe(byHand);
	});
});

describe('auctionsReducer — BidCancelled seats the RECORDED restoration (Story 10.4)', () => {
	it('hands the lead to the Bid the payload names, and keeps the clock', () => {
		const auction = at([
			bid(1, 4_000_000, { teamId: 't-9' }),
			bid(2, 6_000_000, { teamId: 't-1' }),
			cancelled(3, '2', { restoration: restoring('1', 't-9', 4_000_000) })
		]);

		expect(auction?.leadingBid?.seq).toBe('1');
		expect(auction?.leadingBid?.teamId).toBe('t-9');
		expect(auction?.leadingBid?.amount).toBe(4_000_000);
		// A leader stands, so the Auction Clock is untouched — the Restored
		// Leading Bidder inherits whatever is left of it.
		expect(auction?.closesAt).toBe(closeInstantFor('2026-08-26T09:00:00.000Z', AUCTION_CLOCK));
		expect(auction?.contention).toBe('standard');
		// The marker still rides the cancelled Bid, restoration and all.
		expect(auction?.bids[1]?.cancellation?.restoration).toEqual(
			restoring('1', 't-9', 4_000_000)
		);
	});

	it('seats the recorded Bid even when a HIGHER survivor was skipped', () => {
		// Example 32's shape. The $5.0M Bid is still standing and is higher
		// than the restored $2.0M one; the fold must not promote it, because
		// the gates refused it and this reducer cannot re-run them.
		const auction = at([
			bid(1, 2_000_000, { teamId: 't-w' }),
			bid(2, 5_000_000, { teamId: 't-v' }),
			bid(3, 6_000_000, { teamId: 't-1' }),
			cancelled(4, '3', { restoration: restoring('1', 't-w', 2_000_000) })
		]);

		expect(auction?.leadingBid?.teamId).toBe('t-w');
		expect(auction?.leadingBid?.amount).toBe(2_000_000);
		// Skipped is not cancelled: the $5.0M Bid still stands, unmarked.
		expect(wasCancelled(auction?.bids[1] as never)).toBe(false);
	});

	it('goes leaderless and clockless when the record says nothing was restored', () => {
		// `highestStandingBid` is non-null here — the $4.0M Bid is right there
		// — and the Auction still returns to Awaiting Opening Bid.
		const auction = at([
			bid(1, 4_000_000, { teamId: 't-9' }),
			bid(2, 6_000_000, { teamId: 't-1' }),
			cancelled(3, '2')
		]);

		expect(auction?.leadingBid).toBeNull();
		expect(auction?.closesAt).toBeNull();
		expect(auction?.contention).toBe('awaiting_opening_bid');
		expect(auction?.bids).toHaveLength(2);
		expect(wasCancelled(auction?.bids[0] as never)).toBe(false);
	});

	it('degrades a malformed restoration to null rather than throwing in a fold', () => {
		// Every shape that cannot be used, and each one leaves the Auction in
		// the leaderless state the fold already models. A throw here would
		// take down the board, the Auction page and every close after it.
		const malformed: readonly unknown[] = [
			'the next-highest bid',
			42,
			[],
			{},
			{ seq: '1' },
			{ seq: '', teamId: 't-9', teamName: 'Team 9', managerId: 'm-9', amount: 4_000_000 },
			{ seq: '1', teamId: 't-9', teamName: 'Team 9', managerId: 'm-9' },
			{ seq: '1', teamId: 't-9', teamName: 'Team 9', managerId: 'm-9', amount: 'lots' },
			// `Money`'s own domain: a whole number of dollars above zero. A
			// fraction, a negative, a zero, a NaN, an Infinity and a figure
			// past the safe-integer range are none of them Bid amounts.
			{ seq: '1', teamId: 't-9', teamName: 'Team 9', managerId: 'm-9', amount: 4_000_000.5 },
			{ seq: '1', teamId: 't-9', teamName: 'Team 9', managerId: 'm-9', amount: -4_000_000 },
			{ seq: '1', teamId: 't-9', teamName: 'Team 9', managerId: 'm-9', amount: 0 },
			{ seq: '1', teamId: 't-9', teamName: 'Team 9', managerId: 'm-9', amount: Number.NaN },
			{
				seq: '1',
				teamId: 't-9',
				teamName: 'Team 9',
				managerId: 'm-9',
				amount: Number.POSITIVE_INFINITY
			},
			{
				seq: '1',
				teamId: 't-9',
				teamName: 'Team 9',
				managerId: 'm-9',
				amount: Number.MAX_SAFE_INTEGER + 2
			}
		];

		for (const restoration of malformed) {
			const auction = at([
				bid(1, 4_000_000, { teamId: 't-9' }),
				bid(2, 6_000_000, { teamId: 't-1' }),
				cancelled(3, '2', { restoration })
			]);
			expect(auction?.leadingBid).toBeNull();
			expect(auction?.closesAt).toBeNull();
			// The cancellation itself still landed — only the succession failed.
			expect(wasCancelled(auction?.bids[1] as never)).toBe(true);
			expect(auction?.bids[1]?.cancellation?.restoration).toBeNull();
		}
	});

	it('reads a payload with NO restoration key as the Story 10.3 rows in the log', () => {
		// Not the same input as a malformed value, and the distinction is not
		// hypothetical: every `BidCancelled` Story 10.3 appended carries no
		// restorer's decision at all, and those rows are in the log this
		// reducer folds on every read. An absent key must reach the same
		// leaderless state a `null` one does — never a throw, and never a
		// seated leader read off `undefined`.
		const auction = at([
			bid(1, 4_000_000, { teamId: 't-9' }),
			bid(2, 6_000_000, { teamId: 't-1' }),
			cancelled(3, '2', { omitRestoration: true })
		]);

		expect(auction?.leadingBid).toBeNull();
		expect(auction?.closesAt).toBeNull();
		expect(auction?.contention).toBe('awaiting_opening_bid');
		// The cancellation still landed, and the survivor is still standing.
		expect(wasCancelled(auction?.bids[1] as never)).toBe(true);
		expect(auction?.bids[1]?.cancellation?.restoration).toBeNull();
		expect(wasCancelled(auction?.bids[0] as never)).toBe(false);
	});

	it('seats nobody when a READABLE restoration names a Bid it cannot use', () => {
		// A different failure from the one above, and it degrades a different
		// way. These records read cleanly, so the marker keeps them verbatim
		// — the Audit Log should show what the event actually said — but the
		// `seq` names no Bid in this history, or names the very Bid this event
		// cancelled, so no leader is seated. The amount on the record is never
		// what puts a price on an Auction; the Bid at `seq` is.
		for (const restoration of [restoring('99', 't-9', 4_000_000), restoring('2', 't-1', 6_000_000)]) {
			const auction = at([
				bid(1, 4_000_000, { teamId: 't-9' }),
				bid(2, 6_000_000, { teamId: 't-1' }),
				cancelled(3, '2', { restoration })
			]);
			expect(auction?.leadingBid).toBeNull();
			expect(auction?.closesAt).toBeNull();
			expect(auction?.contention).toBe('awaiting_opening_bid');
			expect(auction?.bids[1]?.cancellation?.restoration).toEqual(restoration);
		}
	});

	it('converges on a second fold of the same log, restoration and all', () => {
		// The identity check that makes replay converge has to survive the
		// restoration: a `seq` already cancelled returns the Auction unchanged
		// however the second event words its succession.
		const log = [
			bid(1, 4_000_000, { teamId: 't-9' }),
			bid(2, 6_000_000, { teamId: 't-1' }),
			cancelled(3, '2', { restoration: restoring('1', 't-9', 4_000_000) })
		];
		expect(at(log)).toEqual(at([...log, ...log]));
		expect(at([...log, cancelled(4, '2')])).toEqual(at(log));
	});

	it('ignores a restoration inside a Minimum-Bid Contention', () => {
		// The lead there is a fold artifact over identical flat amounts and
		// moves to the earliest surviving join with no re-validation. A
		// payload naming something else does not get to override that.
		const auction = at([
			bid(1, 1_000_000, { teamId: 't-1' }),
			bid(2, 1_000_000, { teamId: 't-2' }),
			cancelled(3, '1', { restoration: restoring('2', 't-2', 1_000_000) })
		]);

		expect(auction?.contention).toBe('minimum_bid');
		expect(auction?.leadingBid?.seq).toBe('2');
		expect(auction?.contenders.map((entry) => entry.teamId)).toEqual(['t-2']);
	});
});

describe('auctionAtClose — the history a settled Auction left behind', () => {
	const closeOf = (seq: number, fantraxPlayerId = 'p-1') =>
		event(seq, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId }));

	it('returns the Auction exactly as it stood the instant before the close', () => {
		// The whole point: `auctionsReducer` drops the entry on the close, so
		// `at()` finds nothing — while the Bids themselves are still in the log
		// and fold back into the record the Closed page prints.
		const log = [bid(1, 6_000_000, { teamId: 't-1' }), bid(2, 8_000_000, { teamId: 't-2' }), closeOf(3)];

		expect(at(log)).toBeNull();

		const closed = auctionAtClose(log, 'p-1');
		expect(closed?.bids.map((entry) => entry.seq)).toEqual(['1', '2']);
		expect(closed?.bids.map((entry) => entry.amount)).toEqual([6_000_000, 8_000_000]);
		expect(closed?.leadingBid?.seq).toBe('2');
	});

	it('keeps a cancelled Bid in the history, still marked', () => {
		// FR-40 requires a cancelled Bid kept visible, and the close must not
		// be the thing that finally hides it.
		const log = [
			bid(1, 4_000_000, { teamId: 't-9' }),
			bid(2, 6_000_000, { teamId: 't-1' }),
			cancelled(3, '1'),
			closeOf(4)
		];

		const closed = auctionAtClose(log, 'p-1');
		expect(closed?.bids).toHaveLength(2);
		expect(wasCancelled(closed!.bids[0]!)).toBe(true);
		expect(wasCancelled(closed!.bids[1]!)).toBe(false);
	});

	it('ignores everything after the close, including another Player’s Bids', () => {
		// The cut is this Player's own close and nothing else. A later Auction
		// on the same log contributes nothing here.
		const log = [
			bid(1, 8_000_000),
			closeOf(2),
			bid(3, 5_000_000, { fantraxPlayerId: 'p-2' }),
			bid(4, 9_000_000, { fantraxPlayerId: 'p-1' })
		];

		const closed = auctionAtClose(log, 'p-1');
		expect(closed?.bids.map((entry) => entry.seq)).toEqual(['1']);
	});

	it('drops the Bids of an earlier round that was terminated', () => {
		// A Player nominated, terminated with no winner, then nominated again
		// and won. The prefix is folded in FULL, so the reducer's own
		// termination case clears the abandoned round before the second one
		// starts — the closed page never shows a Bid from an Auction that
		// produced no contract.
		const log = [
			bid(1, 4_000_000, { teamId: 't-9' }),
			event(2, AUCTION_TERMINATED_EVENT, { fantraxPlayerId: 'p-1' }),
			bid(3, 7_000_000, { teamId: 't-2' }),
			closeOf(4)
		];

		const closed = auctionAtClose(log, 'p-1');
		expect(closed?.bids.map((entry) => entry.seq)).toEqual(['3']);
	});

	it('cuts at the FIRST close, which is the one that produced the contract', () => {
		// `contractsReducer` keeps the first close for a Player and ignores a
		// second, so this has to agree with it — otherwise the winner printed
		// above the history and the history itself would describe two
		// different Auctions.
		const log = [bid(1, 8_000_000), closeOf(2), closeOf(3)];

		expect(auctionAtClose(log, 'p-1')?.bids.map((entry) => entry.seq)).toEqual(['1']);
	});

	it('reads the cut off `seq` rather than array position', () => {
		// `fold` sorts a copy, so a caller handing over an unsorted array must
		// not get a different history from one that sorted first.
		const ordered = [bid(1, 6_000_000), bid(2, 8_000_000), closeOf(3)];
		const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!];

		expect(auctionAtClose(shuffled, 'p-1')).toEqual(auctionAtClose(ordered, 'p-1'));
	});

	it('answers null for a Player whose Auction never closed', () => {
		// Deliberately not an empty Auction: "never closed" and "closed with no
		// surviving Bid" are different answers, and only the second is a
		// history a page may render as empty.
		expect(auctionAtClose([bid(1, 8_000_000)], 'p-1')).toBeNull();
		expect(auctionAtClose([], 'p-1')).toBeNull();
		// A close naming some other Player is not this Player's cut.
		expect(auctionAtClose([bid(1, 8_000_000), closeOf(2, 'p-2')], 'p-1')).toBeNull();
	});

	it('answers null for a close naming no readable Player', () => {
		// The same reader `nominationsReducer` folds a close through, so a
		// malformed payload is skipped here exactly as it is skipped there.
		const log = [bid(1, 8_000_000), event(2, AUCTION_CLOSED_EVENT, { fantraxPlayerId: 42 })];

		expect(auctionAtClose(log, 'p-1')).toBeNull();
	});
});

describe('auctionAtClose — cut at a NAMED close (Story 7.13)', () => {
	const closeOf = (seq: number) =>
		event(seq, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1' }));
	// Closed, reversed, re-nominated and closed again. The reversal is folded by
	// no reducer here — the Auction was already gone — so the second round's
	// Bids start a fresh Auction after the first close.
	const log = [
		bid(1, 6_000_000, { teamId: 't-1' }),
		bid(2, 8_000_000, { teamId: 't-2' }),
		closeOf(3),
		event(4, 'AuctionCloseReversed', { closeSeq: '3', fantraxPlayerId: 'p-1' }),
		bid(5, 2_000_000, { teamId: 't-3' }),
		bid(6, 3_000_000, { teamId: 't-4' }),
		closeOf(7)
	];

	it('returns only the second round’s Bids when the second close is named', () => {
		const second = auctionAtClose(log, 'p-1', '7');
		expect(second?.bids.map((entry) => entry.seq)).toEqual(['5', '6']);
		expect(second?.leadingBid?.teamId).toBe('t-4');
	});

	it('returns the first round when the first close is named, and by default', () => {
		expect(auctionAtClose(log, 'p-1', '3')?.bids.map((entry) => entry.seq)).toEqual(['1', '2']);
		expect(auctionAtClose(log, 'p-1')?.bids.map((entry) => entry.seq)).toEqual(['1', '2']);
	});

	it('returns null for a named seq that is not a close of this Player', () => {
		expect(auctionAtClose(log, 'p-1', '5')).toBeNull();
		expect(auctionAtClose(log, 'p-2', '7')).toBeNull();
	});
});
