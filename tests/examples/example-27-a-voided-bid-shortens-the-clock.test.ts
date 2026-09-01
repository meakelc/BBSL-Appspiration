/**
 * PRD §10 example 27 — **A voided Bid shortens the League Clock** (AD-25).
 *
 * > A Nomination at 09:00 Monday and a Bid at 15:00 Monday. The Bid is voided
 * > at 18:00 Monday. The expiry moves from 15:00 Wednesday to **09:00
 * > Wednesday**. Both events remain in the log.
 *
 * **Nothing in this codebase appends a `BidVoided`.** Story 7.2 owns the
 * Commissioner's void; this file proves the FOLD survives one, against a state
 * literal containing both events, so that story need only append it. Epic 3.7's
 * acceptance criteria say exactly that, and AD-22 names the compensating void
 * as the reason a reset is distinguishable from the origin at all.
 *
 * **The void is a non-reset, never a deletion.** AD-4 makes the log
 * insert-only, so the `BidPlaced` is still there and every other fold still
 * sees it — the Auction still records the Bid and the Player is still on the
 * board. What changes is which reset the clock counts from, and the assertions
 * below check both halves: the expiry moves, and nothing else does.
 *
 * Calls the core directly against a folded log — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { LEAGUE_CLOCK } from '../../src/lib/core/constants.ts';
import {
	BID_PLACED_EVENT,
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer
} from '../../src/lib/core/projection/auctions.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	BID_VOIDED_EVENT,
	INITIAL_LEAGUE_CLOCK,
	leagueClockExpiry,
	leagueClockReducer
} from '../../src/lib/core/projection/league-clock.ts';
import {
	INITIAL_NOMINATIONS,
	NOMINATION_PLACED_EVENT,
	nominationForPlayer,
	nominationsReducer
} from '../../src/lib/core/projection/nominations.ts';
import { AUCTION_OPENED_EVENT } from '../../src/lib/core/projection/phase.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';

/** 08:00 Monday — the open. The origin, and the floor no void passes. */
const OPENED_AT = '2026-08-24T08:00:00.000Z';

/** 09:00 Monday — the Nomination. */
const NOMINATED_AT = '2026-08-24T09:00:00.000Z';

/** 15:00 Monday — the Bid. */
const BID_AT = '2026-08-24T15:00:00.000Z';

/** 18:00 Monday — the void, three hours after the Bid it names. */
const VOIDED_AT = '2026-08-24T18:00:00.000Z';

/** 15:00 Wednesday — where the clock stood before the void. */
const BEFORE_THE_VOID = '2026-08-26T15:00:00.000Z';

/** 09:00 Wednesday — where it stands after, and the example's answer. */
const AFTER_THE_VOID = '2026-08-26T09:00:00.000Z';

/** The `seq` the void names. The Bid's, and the whole mechanism. */
const VOIDED_SEQ = '3';

function event(seq: string, type: string, occurredAt: string, payload: unknown = {}): AppendedEvent {
	return {
		seq,
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

const OPENED = event('1', AUCTION_OPENED_EVENT, OPENED_AT);

const NOMINATED = event('2', NOMINATION_PLACED_EVENT, NOMINATED_AT, {
	fantraxPlayerId: 'p-1',
	playerName: 'Ausar Bright',
	teamId: 't-n',
	teamName: 'Team N',
	managerId: 'm-n'
});

const BID = event(VOIDED_SEQ, BID_PLACED_EVENT, BID_AT, {
	fantraxPlayerId: 'p-1',
	teamId: 't-1',
	teamName: 'Team One',
	managerId: 'm-1',
	amount: 8_000_000,
	closesAt: '2026-08-25T15:00:00.000Z',
	contention: 'standard'
});

/**
 * The compensating void, as Story 7.2 will append it. The one field this fold
 * reads is `voidedSeq`; the rest is what an audit reading needs and no fold
 * decides on.
 */
const VOID = event('4', BID_VOIDED_EVENT, VOIDED_AT, {
	voidedSeq: VOIDED_SEQ,
	fantraxPlayerId: 'p-1',
	reason: 'entered in error'
});

/** The log before the void, and the log after it. */
const BEFORE: readonly AppendedEvent[] = [OPENED, NOMINATED, BID];
const AFTER: readonly AppendedEvent[] = [OPENED, NOMINATED, BID, VOID];

describe('§10 example 27 — a voided Bid shortens the League Clock', () => {
	it('stood at 15:00 Wednesday before the void', () => {
		const clock = fold(INITIAL_LEAGUE_CLOCK, BEFORE, leagueClockReducer);

		expect(leagueClockExpiry(clock)).toBe(BEFORE_THE_VOID);
		expect(BEFORE_THE_VOID).toBe(new Date(Date.parse(BID_AT) + LEAGUE_CLOCK).toISOString());
	});

	it('moves to 09:00 Wednesday once the void is folded — the Nomination is the survivor', () => {
		const clock = fold(INITIAL_LEAGUE_CLOCK, AFTER, leagueClockReducer);

		expect(leagueClockExpiry(clock)).toBe(AFTER_THE_VOID);
		// 48 hours after the NOMINATION, which is the reset the walk lands on
		// after skipping the voided one.
		expect(AFTER_THE_VOID).toBe(new Date(Date.parse(NOMINATED_AT) + LEAGUE_CLOCK).toISOString());
		// SHORTER, which is the direction a compensation must move it.
		expect(Date.parse(AFTER_THE_VOID)).toBeLessThan(Date.parse(BEFORE_THE_VOID));
	});

	it('records the void as a non-reset: both resets stay, the seq is withdrawn', () => {
		const clock = fold(INITIAL_LEAGUE_CLOCK, AFTER, leagueClockReducer);

		// The Bid's reset is still recorded. It is skipped at derivation time,
		// not removed at fold time.
		expect(clock.resets).toEqual([
			{ seq: '2', occurredAt: NOMINATED_AT },
			{ seq: VOIDED_SEQ, occurredAt: BID_AT }
		]);
		expect(clock.voidedSeqs).toEqual([VOIDED_SEQ]);
		// And the void, three hours LATER than the Bid, appended no reset of
		// its own — otherwise the expiry would have moved forward to 18:00
		// Wednesday, the opposite of what a compensation means.
		expect(clock.resets).toHaveLength(2);
	});

	it('leaves BOTH events in the log, and every other fold still sees the Bid', () => {
		// AD-4: the log is insert-only and a void is a compensating event, not
		// a deletion. The Auction still records the $8,000,000 Bid and the
		// Player is still on the board — only the CLOCK stopped counting from
		// it. Story 7.2 owns releasing the capital and restoring the previous
		// leader; this story owns only the clock.
		expect(AFTER).toHaveLength(4);
		expect(AFTER.map((appended) => appended.type)).toContain(BID_PLACED_EVENT);
		expect(AFTER.map((appended) => appended.type)).toContain(BID_VOIDED_EVENT);

		const auctions = fold(INITIAL_AUCTIONS, AFTER, auctionsReducer);
		expect(auctionForPlayer(auctions, 'p-1')?.leadingBid.amount).toBe(8_000_000);

		const nominations = fold(INITIAL_NOMINATIONS, AFTER, nominationsReducer);
		expect(nominationForPlayer(nominations, 'p-1')?.playerName).toBe('Ausar Bright');
	});

	it('gives the identical answer whichever order the array arrives in', () => {
		// Membership, not position: `fold()` sorts by `seq`, and the void's
		// effect is recorded as a `seq` rather than as "the last thing I saw".
		const shuffled = [VOID, BID, OPENED, NOMINATED];
		const clock = fold(INITIAL_LEAGUE_CLOCK, shuffled, leagueClockReducer);

		expect(leagueClockExpiry(clock)).toBe(AFTER_THE_VOID);
	});

	it('converges on a double replay', () => {
		const once = fold(INITIAL_LEAGUE_CLOCK, AFTER, leagueClockReducer);
		expect(fold(once, AFTER, leagueClockReducer)).toEqual(once);
		expect(leagueClockExpiry(fold(once, AFTER, leagueClockReducer))).toBe(AFTER_THE_VOID);
	});

	it('cannot pass the origin, however many resets are voided', () => {
		// Void the Nomination as well and the clock falls back to the open at
		// 08:00 Monday — 08:00 Wednesday, and not one second earlier. That is
		// AD-22's floor, and it is what makes voiding the only Bid of a
		// just-opened auction safe.
		const alsoVoided = [
			...AFTER,
			event('5', BID_VOIDED_EVENT, VOIDED_AT, { voidedSeq: '2' })
		];
		const clock = fold(INITIAL_LEAGUE_CLOCK, alsoVoided, leagueClockReducer);

		expect(leagueClockExpiry(clock)).toBe('2026-08-26T08:00:00.000Z');
		expect(leagueClockExpiry(clock)).toBe(
			new Date(Date.parse(OPENED_AT) + LEAGUE_CLOCK).toISOString()
		);
	});
});
