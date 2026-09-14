/**
 * `decidePhaseEnd` — whether the Auction Phase is over, and what that costs
 * (Story 3.7, FR-22, AD-22).
 *
 * Every row of the spec's I/O matrix that is decided in the core is here:
 * the not-yet-expired no-op, the no-origin no-op, the already-ended no-op, the
 * event ORDER, the zero-termination case, the null-and-null actor, and the
 * stuck-Auction case that AC7 exists for.
 *
 * Calls the core directly against folded state — no database, no HTTP, no clock
 * mocking. `now` is a string argument, as it is everywhere in this core.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_BID } from '../../src/lib/core/constants.ts';
import {
	BID_PLACED_EVENT,
	INITIAL_AUCTIONS,
	auctionsReducer
} from '../../src/lib/core/projection/auctions.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	INITIAL_LEAGUE_CLOCK,
	leagueClockExpiry,
	leagueClockReducer
} from '../../src/lib/core/projection/league-clock.ts';
import {
	AUCTION_TERMINATED_EVENT,
	INITIAL_NOMINATIONS,
	NOMINATION_PLACED_EVENT,
	nominationsReducer
} from '../../src/lib/core/projection/nominations.ts';
import {
	AUCTION_OPENED_EVENT,
	CONTRACT_ASSIGNMENT_OPENED_EVENT,
	INITIAL_PHASE,
	phaseReducer
} from '../../src/lib/core/projection/phase.ts';
import { decidePhaseEnd, hasLeagueClockExpired } from '../../src/lib/core/rules/phase-end.ts';
import type {
	AuctionTerminatedPayload,
	ContractAssignmentOpenedPayload,
	PhaseEndState
} from '../../src/lib/core/rules/phase-end.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';

/** The open: 09:00 Monday. The League Clock therefore expires 09:00 Wednesday. */
const OPENED_AT = '2026-08-24T09:00:00.000Z';
const EXPIRES_AT = '2026-08-26T09:00:00.000Z';

/** One instant after the expiry, and one before it. */
const AFTER = '2026-08-26T09:00:00.001Z';
const BEFORE = '2026-08-26T08:59:59.999Z';

function event(seq: number, type: string, occurredAt: string, payload: unknown = {}): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt,
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: 'm-actor',
		teamId: 't-actor',
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

/** A nomination, as `server/nomination.ts` writes its payload. */
function nomination(
	seq: number,
	fantraxPlayerId: string,
	playerName: string,
	teamId: string,
	teamName: string,
	managerId: string,
	occurredAt = OPENED_AT
): AppendedEvent {
	return event(seq, NOMINATION_PLACED_EVENT, occurredAt, {
		fantraxPlayerId,
		playerName,
		teamId,
		teamName,
		managerId
	});
}

/** An opening Bid, as `decide()` writes its payload. */
function bid(seq: number, fantraxPlayerId: string, amount: number, occurredAt: string): AppendedEvent {
	return event(seq, BID_PLACED_EVENT, occurredAt, {
		fantraxPlayerId,
		teamId: 't-bidder',
		teamName: 'Team Bidder',
		managerId: 'm-bidder',
		amount,
		closesAt: '2026-08-27T09:00:00.000Z',
		contention: amount === MINIMUM_BID ? 'minimum_bid' : 'standard'
	});
}

/** The four folds `server/phase-end.ts` builds, over one array. */
function stateOf(events: readonly AppendedEvent[]): PhaseEndState {
	return {
		clock: fold(INITIAL_LEAGUE_CLOCK, events, leagueClockReducer),
		nominations: fold(INITIAL_NOMINATIONS, events, nominationsReducer),
		auctions: fold(INITIAL_AUCTIONS, events, auctionsReducer),
		phase: fold(INITIAL_PHASE, events, phaseReducer)
	};
}

/** An auction opened at 09:00 Monday and nothing else. */
const JUST_OPENED = [event(1, AUCTION_OPENED_EVENT, OPENED_AT)];

describe('hasLeagueClockExpired — one derivation, not a second comparison', () => {
	it('is false before the expiry and true at it and after it', () => {
		const state = stateOf(JUST_OPENED);
		expect(leagueClockExpiry(state.clock)).toBe(EXPIRES_AT);

		expect(hasLeagueClockExpired(state, BEFORE)).toBe(false);
		// At the instant itself, as `hasExpired` decides everywhere else.
		expect(hasLeagueClockExpired(state, EXPIRES_AT)).toBe(true);
		expect(hasLeagueClockExpired(state, AFTER)).toBe(true);
	});

	it('is false with no origin — there is no League Clock during Setup', () => {
		expect(hasLeagueClockExpired(stateOf([]), '2099-01-01T00:00:00.000Z')).toBe(false);
	});
});

describe('decidePhaseEnd — the no-ops, which are states rather than refusals', () => {
	it('answers null while the clock is still running', () => {
		expect(decidePhaseEnd(stateOf(JUST_OPENED), BEFORE)).toBeNull();
	});

	it('answers null with no origin, rather than ending a phase that never started', () => {
		// A `now` far past anything, and still nothing: an auction that never
		// opened has no clock to run out.
		expect(decidePhaseEnd(stateOf([]), '2099-01-01T00:00:00.000Z')).toBeNull();
	});

	it('answers null once the phase has already ended, however long past the expiry', () => {
		const ended = stateOf([
			...JUST_OPENED,
			event(2, CONTRACT_ASSIGNMENT_OPENED_EVENT, EXPIRES_AT)
		]);
		expect(ended.phase).toBe('Contract Assignment');
		expect(decidePhaseEnd(ended, '2099-01-01T00:00:00.000Z')).toBeNull();
	});

	it('is idempotent through the log: folding its OWN events back in answers null', () => {
		// This is what makes a restart-safe tick safe. The second evaluation
		// reads a log containing the first evaluation's events.
		const state = stateOf(JUST_OPENED);
		const first = decidePhaseEnd(state, AFTER);
		if (first === null) throw new Error('expected the phase to end');

		const replayed = stateOf([
			...JUST_OPENED,
			...first.events.map((envelope, index) =>
				event(10 + index, envelope.type, AFTER, envelope.payload)
			)
		]);
		expect(decidePhaseEnd(replayed, AFTER)).toBeNull();
	});
});

describe('decidePhaseEnd — the transaction it decides', () => {
	it('appends ContractAssignmentOpened ALONE when nothing is unbid', () => {
		const decision = decidePhaseEnd(stateOf(JUST_OPENED), AFTER);
		if (decision === null) throw new Error('expected the phase to end');

		expect(decision.kind).toBe('accepted');
		expect(decision.events.map((envelope) => envelope.type)).toEqual([
			CONTRACT_ASSIGNMENT_OPENED_EVENT
		]);
		// Zero terminations is an ordinary outcome, not a failure.
		const payload = decision.events[0]?.payload as ContractAssignmentOpenedPayload;
		expect(payload.terminatedPlayerIds).toEqual([]);
	});

	it('appends one AuctionTerminated per unbid nomination, THEN the phase end', () => {
		const decision = decidePhaseEnd(
			stateOf([
				...JUST_OPENED,
				nomination(2, 'p-a', 'Ausar Bright', 't-1', 'Lakers', 'm-1'),
				nomination(3, 'p-b', 'Malik Rowe', 't-2', 'Celtics', 'm-2'),
				nomination(4, 'p-c', 'Jalen Green', 't-3', 'Bulls', 'm-3')
			]),
			AFTER
		);
		if (decision === null) throw new Error('expected the phase to end');

		// **The ORDER is the assertion.** A prefix of the log ending between a
		// termination and the phase end says Slots were freed inside a phase
		// that has not ended — early, but never contradictory. The other order
		// would say the phase is over while a Player is still on the board.
		expect(decision.events.map((envelope) => envelope.type)).toEqual([
			AUCTION_TERMINATED_EVENT,
			AUCTION_TERMINATED_EVENT,
			AUCTION_TERMINATED_EVENT,
			CONTRACT_ASSIGNMENT_OPENED_EVENT
		]);

		const opened = decision.events[3]?.payload as ContractAssignmentOpenedPayload;
		expect(opened.terminatedPlayerIds).toEqual(['p-a', 'p-b', 'p-c']);
		expect(opened.expiredAt).toBe(EXPIRES_AT);
		expect(opened.evaluatedAt).toBe(AFTER);
	});

	it('carries the NOMINATING Team and Manager on each termination, envelope and payload', () => {
		const decision = decidePhaseEnd(
			stateOf([...JUST_OPENED, nomination(2, 'p-a', 'Ausar Bright', 't-1', 'Lakers', 'm-1')]),
			AFTER
		);
		if (decision === null) throw new Error('expected the phase to end');

		const terminated = decision.events[0];
		expect(terminated?.managerId).toBe('m-1');
		expect(terminated?.teamId).toBe('t-1');

		const payload = terminated?.payload as AuctionTerminatedPayload;
		expect(payload).toEqual({
			fantraxPlayerId: 'p-a',
			playerName: 'Ausar Bright',
			teamId: 't-1',
			teamName: 'Lakers',
			managerId: 'm-1',
			// The League Clock's own expiry, never the transaction clock — so a
			// tick six hours late appends a byte-identical payload (AD-10).
			expiredAt: EXPIRES_AT,
			evaluatedAt: AFTER
		});
		// No money, no placement, no contract years: a termination awards
		// nothing, and a payload carrying a money field could be mistaken for a
		// close.
		expect(Object.keys(payload).sort()).toEqual([
			'evaluatedAt',
			'expiredAt',
			'fantraxPlayerId',
			'managerId',
			'playerName',
			'teamId',
			'teamName'
		]);
	});

	it('gives ContractAssignmentOpened a null actor, and null on BOTH halves', () => {
		const decision = decidePhaseEnd(stateOf(JUST_OPENED), AFTER);
		if (decision === null) throw new Error('expected the phase to end');

		const opened = decision.events[0];
		expect(opened?.type).toBe(CONTRACT_ASSIGNMENT_OPENED_EVENT);
		// Nobody acted: a clock ran out. Attributing it to the Commissioner
		// would make the Audit Log read as though a rival closed the books.
		expect(opened?.managerId).toBeNull();
		expect(opened?.teamId).toBeNull();
	});

	it('records NEITHER actor on a termination whose nomination named no Manager', () => {
		// The pair moves together or not at all
		// (`auction_events_actor_pair_null_together`), and `manager_id`
		// references `managers(id)`, so an invented id would fail a foreign key
		// rather than merely read oddly.
		const decision = decidePhaseEnd(
			stateOf([
				...JUST_OPENED,
				event(2, NOMINATION_PLACED_EVENT, OPENED_AT, {
					fantraxPlayerId: 'p-a',
					playerName: 'Ausar Bright',
					teamId: 't-1',
					teamName: 'Lakers'
				})
			]),
			AFTER
		);
		if (decision === null) throw new Error('expected the phase to end');

		expect(decision.events[0]?.managerId).toBeNull();
		expect(decision.events[0]?.teamId).toBeNull();
		// The payload still names the Team, which is audit detail rather than
		// an actor column, so the Slot's owner is still recorded.
		expect((decision.events[0]?.payload as AuctionTerminatedPayload).teamId).toBe('t-1');
	});

	it('is pure — the same state and the same now give the same events', () => {
		const state = stateOf([...JUST_OPENED, nomination(2, 'p-a', 'A', 't-1', 'T1', 'm-1')]);
		expect(decidePhaseEnd(state, AFTER)).toEqual(decidePhaseEnd(state, AFTER));
	});
});

describe('decidePhaseEnd — only a nomination with NO Auction is terminated (AC7)', () => {
	/**
	 * Two nominations. `p-stuck` took a real Bid and its Auction is live;
	 * `p-unbid` never took one. The spec's stuck-Auction case is exactly this
	 * log with a close that keeps throwing — and a close that keeps throwing
	 * leaves the log looking precisely like this.
	 */
	const CONTESTED_AND_UNBID = [
		...JUST_OPENED,
		nomination(2, 'p-stuck', 'Ausar Bright', 't-1', 'Lakers', 'm-1'),
		nomination(3, 'p-unbid', 'Malik Rowe', 't-2', 'Celtics', 'm-2'),
		bid(4, 'p-stuck', 8_000_000, '2026-08-24T12:00:00.000Z')
	];

	it('terminates the unbid Player and leaves the contested nomination open', () => {
		const state = stateOf(CONTESTED_AND_UNBID);
		// The clock's latest reset is the Bid at noon Monday, so the expiry is
		// noon Wednesday — derived rather than assumed.
		expect(leagueClockExpiry(state.clock)).toBe('2026-08-26T12:00:00.000Z');

		const decision = decidePhaseEnd(state, '2026-08-26T12:00:00.001Z');
		if (decision === null) throw new Error('expected the phase to end');

		expect(decision.events.map((envelope) => envelope.type)).toEqual([
			AUCTION_TERMINATED_EVENT,
			CONTRACT_ASSIGNMENT_OPENED_EVENT
		]);
		expect((decision.events[0]?.payload as AuctionTerminatedPayload).fantraxPlayerId).toBe(
			'p-unbid'
		);
		expect(
			(decision.events[1]?.payload as ContractAssignmentOpenedPayload).terminatedPlayerIds
		).toEqual(['p-unbid']);
	});

	it('ends the phase anyway — one broken Auction must never hold the league open', () => {
		const decision = decidePhaseEnd(stateOf(CONTESTED_AND_UNBID), '2026-08-26T12:00:00.001Z');
		if (decision === null) throw new Error('expected the phase to end');

		expect(decision.events.at(-1)?.type).toBe(CONTRACT_ASSIGNMENT_OPENED_EVENT);
	});

	it('leaves the contested nomination and its Bid standing in the fold', () => {
		// Terminating it would discard a Bid the rules already accepted — a
		// money outcome, and the one thing this story must not produce. The
		// sweep keeps retrying that close on later passes, and a close is not
		// phase-gated.
		const decision = decidePhaseEnd(stateOf(CONTESTED_AND_UNBID), '2026-08-26T12:00:00.001Z');
		if (decision === null) throw new Error('expected the phase to end');

		const after = stateOf([
			...CONTESTED_AND_UNBID,
			...decision.events.map((envelope, index) =>
				event(10 + index, envelope.type, '2026-08-26T12:00:00.001Z', envelope.payload)
			)
		]);

		expect(after.nominations.byPlayer['p-stuck']).toBeDefined();
		expect(after.nominations.byTeam['t-1']).toBeDefined();
		expect(after.auctions.byPlayer['p-stuck']?.leadingBid?.amount).toBe(8_000_000);
		// And the unbid one has left the BOARD — but not its nominator's Slot.
		// Since FR-9 was amended only a win frees a Slot, and a termination has
		// no winner by definition: t-2 spent theirs on a Player nobody bid for
		// and does not get it back for that.
		expect(after.nominations.byPlayer['p-unbid']).toBeUndefined();
		expect(after.nominations.byTeam['t-2']).toBeDefined();
	});

	it('terminates a nomination whose only Bid is a lottery join not at all', () => {
		// A Minimum-Bid Contention is an Auction with Bids. It has a row in the
		// fold, so it is not Awaiting an Opening Bid and is never terminated.
		const decision = decidePhaseEnd(
			stateOf([
				...JUST_OPENED,
				nomination(2, 'p-lottery', 'Ausar Bright', 't-1', 'Lakers', 'm-1'),
				bid(3, 'p-lottery', MINIMUM_BID, '2026-08-24T12:00:00.000Z')
			]),
			'2026-08-26T12:00:00.001Z'
		);
		if (decision === null) throw new Error('expected the phase to end');

		expect(decision.events.map((envelope) => envelope.type)).toEqual([
			CONTRACT_ASSIGNMENT_OPENED_EVENT
		]);
	});
});
