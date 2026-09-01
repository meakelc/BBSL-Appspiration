/**
 * PRD §10 example 16's fixtures and its produced state, shared with example 17.
 *
 * **Why this is not in `tests/examples/`, and not a `.test.ts`.** Example 17
 * must run against the state example 16 produced — that chaining is AD-11's
 * arithmetic and the whole point of the pair. It was first achieved by having
 * `example-17-minors-overflow.test.ts` import directly from
 * `example-16-minors-placement.test.ts`, but vitest collects each `.test.ts`
 * as its own suite AND executes an imported module's top-level `describe`
 * registrations inside the importer: example 16's eight cases therefore ran a
 * second time inside example 17's file, inflating the suite total and
 * reporting any example-16 failure under two different files.
 *
 * Holding the shared state in a plain module fixes both halves. Nothing here
 * calls `describe` or `it`, so importing it registers no tests;
 * `vite.config.ts` collects only `tests/**\/*.test.ts`, so this file is never
 * a suite of its own; and `tests/structure.test.ts` asserts that
 * `tests/examples/` holds nothing but the registered example files, which is
 * why the module lives under `tests/fixtures/` rather than beside them.
 *
 * The chaining itself is unchanged and still derived rather than hand-copied:
 * `CONTRACTS_AFTER_16` is the real fold of the real close example 16 appended.
 */

import { parseMoney } from '../../src/lib/core/money.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import { INITIAL_CONTRACTS, contractsReducer } from '../../src/lib/core/projection/contracts.ts';
import { decideClose } from '../../src/lib/core/rules/close.ts';
import type { AuctionClosedPayload, CloseState } from '../../src/lib/core/rules/close.ts';
import type { CapHitRow } from '../../src/lib/core/rules/roster-import.ts';
import type { AppendedEvent, EventEnvelope } from '../../src/lib/core/types.ts';

export const CLOSES_AT = '2026-08-27T09:00:00.000Z';

/**
 * Team M's imported roster: nine Active/Bench contracts and TWO occupied Minor
 * League Slots. The two imported minors rows are what "holds two players in
 * Minor League Slots" means before any close.
 */
export const TEAM_M_IMPORTED: readonly CapHitRow[] = Object.freeze([
	...Array.from({ length: 9 }, () => ({
		capHit: parseMoney(1_000_000),
		rosterSlotKind: 'active_bench' as const
	})),
	{ capHit: parseMoney(30_000_000), rosterSlotKind: 'minor_league' as const },
	{ capHit: parseMoney(20_000_000), rosterSlotKind: 'minor_league' as const }
]);

/** Roster Count: `active_bench` rows and nothing else (PRD §3, §10 ex 23). */
export function rosterCountOf(rows: readonly CapHitRow[]): number {
	return rows.filter((row) => row.rosterSlotKind === 'active_bench').length;
}

/** Minor League occupancy: the raw count `M = max(0, 3 − occupied)` derives from. */
export function minorLeagueOccupiedIn(rows: readonly CapHitRow[]): number {
	return rows.filter((row) => row.rosterSlotKind === 'minor_league').length;
}

/** The Auction Team M is about to win, as `auctionsReducer` would hold it. */
export function auctionWonAt(fantraxPlayerId: string, amount: number) {
	const leadingBid = {
		seq: '2',
		teamId: 't-m',
		teamName: 'Team M',
		managerId: 'm-m',
		amount: parseMoney(amount),
		occurredAt: '2026-08-26T09:00:00.000Z',
		closesAt: CLOSES_AT,
		seedHash: null
	};
	return {
		fantraxPlayerId,
		contention: 'standard' as const,
		leadingBid,
		closesAt: CLOSES_AT,
		bids: [leadingBid],
		contenders: [],
		seedHash: null,
		seed: null
	};
}

/** The nomination that put the Player on the board, and names them. */
export function nominationOf(fantraxPlayerId: string, playerName: string) {
	return {
		fantraxPlayerId,
		playerName,
		teamId: 't-n',
		teamName: 'Team N',
		occurredAt: '2026-08-26T08:00:00.000Z'
	};
}

/** The one close, as the log would record it — envelope to `AppendedEvent`. */
export function appendedClose(seq: number, event: EventEnvelope): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt: CLOSES_AT,
		schemaVersion: 1,
		coreVersion: 1,
		type: event.type,
		payload: event.payload,
		managerId: event.managerId,
		teamId: event.teamId,
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

/** Team M, at the moment the $4,000,000 Auction closes. */
export const STATE_16: CloseState = {
	auction: auctionWonAt('p-stash', 4_000_000),
	nomination: nominationOf('p-stash', 'Ausar Bright'),
	// "a Minor League Eligible player"
	playerIsMinorLeagueEligible: true,
	// "Team M holds two players in Minor League Slots"
	minorLeagueOccupied: minorLeagueOccupiedIn(TEAM_M_IMPORTED),
	// A Standard Contention: no lottery, no draw, no winner to derive.
	drawnWinner: null
};

const DECIDED_16 = decideClose(STATE_16, CLOSES_AT, null);
const CLOSE_EVENT = DECIDED_16.events[0];
if (CLOSE_EVENT === undefined) throw new Error('example 16: the close appended no event');

/** The single `AuctionClosed` example 16's close appends. */
export const CLOSE_16: EventEnvelope = CLOSE_EVENT;

/** That close's payload — the two AD-23 money fields and the placement. */
export const PAYLOAD_16 = CLOSE_16.payload as AuctionClosedPayload;

/** The state example 17 continues from: the log, with this close folded in. */
export const CONTRACTS_AFTER_16 = fold(
	INITIAL_CONTRACTS,
	[appendedClose(3, CLOSE_16)],
	contractsReducer
);
