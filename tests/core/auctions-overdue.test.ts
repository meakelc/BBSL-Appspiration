/**
 * `overdueAuctions` — the set the tick sweeps, and the ORDER it sweeps it in
 * (Story 3.5, AD-11).
 *
 * The order is not presentation: §10 example 17 turns on which of two
 * eligible wins is evaluated first, so a comparator that fell back to map
 * order would silently decide a Cap Hit. Every assertion here is about that.
 *
 * Auctions are built from folded `BidPlaced` events rather than from object
 * literals, so "a closed Auction is absent" is the reducer's real answer and
 * not a fixture that was simply not written.
 */

import { describe, expect, it } from 'vitest';

import {
	BID_PLACED_EVENT,
	INITIAL_AUCTIONS,
	auctionsReducer,
	hasExpired,
	overdueAuctions
} from '../../src/lib/core/projection/auctions.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';

const NOW = '2026-08-27T12:00:00.000Z';

let nextSeq = 0;

function event(type: string, payload: unknown, occurredAt = '2026-08-26T09:00:00.000Z'): AppendedEvent {
	nextSeq += 1;
	return {
		seq: String(nextSeq),
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

/** One Bid, which is what makes an Auction exist at all. */
function bid(fantraxPlayerId: string, closesAt: string, amount = 2_000_000): AppendedEvent {
	return event(BID_PLACED_EVENT, {
		fantraxPlayerId,
		teamId: 't-1',
		teamName: 'Team One',
		managerId: 'm-1',
		amount,
		closesAt
	});
}

/** A close, which removes the Auction from the fold entirely. */
function closed(fantraxPlayerId: string): AppendedEvent {
	return event(AUCTION_CLOSED_EVENT, {
		fantraxPlayerId,
		playerName: fantraxPlayerId,
		teamId: 't-1',
		teamName: 'Team One',
		managerId: 'm-1',
		winningAmount: 2_000_000,
		capHit: 2_000_000,
		placement: 'active_bench',
		contention: 'standard',
		contractYears: null,
		closedAt: '2026-08-27T08:00:00.000Z'
	});
}

/** Fold a log into `OpenAuctions`, the way every reader of this projection does. */
function auctionsFrom(events: readonly AppendedEvent[]) {
	return fold(INITIAL_AUCTIONS, events, auctionsReducer);
}

const idsOf = (events: readonly AppendedEvent[], now = NOW): string[] =>
	overdueAuctions(auctionsFrom(events), now).map((auction) => auction.fantraxPlayerId);

describe('overdueAuctions — which Auctions are due', () => {
	it('returns nothing when no Auction has reached its close instant', () => {
		expect(
			idsOf([bid('p-1', '2026-08-27T18:00:00.000Z'), bid('p-2', '2026-08-28T09:00:00.000Z')])
		).toEqual([]);
	});

	it('includes an Auction at the EXACT close instant — `now >= closesAt`', () => {
		// The same boundary `hasExpired` states and the `expiry` gate refuses
		// Bids at, so the instant an Auction stops taking Bids is the instant
		// it becomes closable. Two answers here would be an Auction that is
		// both shut to Managers and invisible to the sweep.
		expect(hasExpired(NOW, NOW)).toBe(true);
		expect(idsOf([bid('p-1', NOW)])).toEqual(['p-1']);
	});

	it('excludes an Auction one millisecond short of its close', () => {
		expect(idsOf([bid('p-1', '2026-08-27T12:00:00.001Z')])).toEqual([]);
	});

	it('omits an Auction that has already closed — the fold no longer holds it', () => {
		// This is the whole of the sweep's restart safety: it re-derives, and
		// what it already did is simply not in the set any more.
		const log = [bid('p-1', '2026-08-27T09:00:00.000Z'), bid('p-2', '2026-08-27T10:00:00.000Z')];
		expect(idsOf(log)).toEqual(['p-1', 'p-2']);
		expect(idsOf([...log, closed('p-1')])).toEqual(['p-2']);
	});

	it('returns nothing at all for an empty fold', () => {
		expect(overdueAuctions(INITIAL_AUCTIONS, NOW)).toEqual([]);
	});
});

describe('overdueAuctions — AD-11’s order, which is an input to the outcome', () => {
	it('closes the EARLIEST expiry first, whatever order the log folded them in', () => {
		// p-a is bid on first and closes LAST. Insertion order and close order
		// disagree deliberately: a sweep that walked `byPlayer` would get this
		// backwards and hand §10 example 17's Minor League Slot to the wrong
		// Player.
		expect(
			idsOf([
				bid('p-a', '2026-08-27T09:00:00.000Z'),
				bid('p-b', '2026-08-27T08:00:00.000Z'),
				bid('p-c', '2026-08-27T07:00:00.000Z')
			])
		).toEqual(['p-c', 'p-b', 'p-a']);
	});

	it('breaks a tie on fantraxPlayerId ascending, never on map order', () => {
		// Two Auctions CAN share a close instant — a contention's fixed clock,
		// or two Bids inside one transaction clock. `p-9` folds first and
		// sorts second.
		const shared = '2026-08-27T08:00:00.000Z';
		expect(idsOf([bid('p-9', shared), bid('p-2', shared)])).toEqual(['p-2', 'p-9']);
		// ...and the reverse fold order gives the identical answer, which is
		// what "never on map order" means.
		expect(idsOf([bid('p-2', shared), bid('p-9', shared)])).toEqual(['p-2', 'p-9']);
	});

	it('sorts by INSTANT, not by the stored string', () => {
		// `.500+00:00` sorts BEFORE a bare `Z` as text — `.` is 0x2E and `Z` is
		// 0x5A — while being half a second LATER as an instant. `+00:00` is the
		// other spelling of `Z` that `parseInstant` accepts, and an optional
		// fractional part is the other thing it accepts, so this is a shape the
		// log can genuinely carry. A lexicographic comparator would swap them.
		expect(
			idsOf([bid('p-half', '2026-08-27T09:00:00.500+00:00'), bid('p-whole', '2026-08-27T09:00:00Z')])
		).toEqual(['p-whole', 'p-half']);
	});

	it('puts an unreadable close instant FIRST, agreeing with hasExpired', () => {
		// `hasExpired` reads an unreadable `closesAt` as already due — the
		// fail-closed direction `readPayload` takes everywhere. An ordering
		// that buried it would be a second, quieter answer to a question the
		// shared derivation has already answered.
		expect(hasExpired('not-an-instant', NOW)).toBe(true);
		expect(idsOf([bid('p-ok', '2026-08-27T08:00:00.000Z'), bid('p-broken', 'not-an-instant')])).toEqual([
			'p-broken',
			'p-ok'
		]);
	});

	it('returns whole Auctions, so the sweep can read `contention` without a second lookup', () => {
		const due = overdueAuctions(auctionsFrom([bid('p-1', '2026-08-27T08:00:00.000Z')]), NOW);
		expect(due).toHaveLength(1);
		expect(due[0]?.contention).toBe('standard');
		expect(due[0]?.closesAt).toBe('2026-08-27T08:00:00.000Z');
	});

	it('does not mutate the projection it was handed', () => {
		const auctions = auctionsFrom([
			bid('p-a', '2026-08-27T09:00:00.000Z'),
			bid('p-b', '2026-08-27T08:00:00.000Z')
		]);
		const before = Object.keys(auctions.byPlayer);
		overdueAuctions(auctions, NOW);
		expect(Object.keys(auctions.byPlayer)).toEqual(before);
	});
});
