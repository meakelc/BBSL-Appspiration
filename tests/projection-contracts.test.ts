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
	CONTRACT_LENGTH_ASSIGNED_EVENT,
	INITIAL_CONTRACTS,
	ROSTER_REARRANGED_EVENT,
	ROSTER_TRADE_RECORDED_EVENT,
	contractForPlayer,
	contractRowsFor,
	contractsReducer,
	isContractYears
} from '../src/lib/core/projection/contracts.ts';
import { fold } from '../src/lib/core/projection/fold.ts';
import {
	AUCTION_CLOSED_EVENT,
	INITIAL_NOMINATIONS,
	NOMINATION_PLACED_EVENT,
	nominationForPlayer,
	nominationsReducer
} from '../src/lib/core/projection/nominations.ts';
import {
	BID_PLACED_EVENT,
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer
} from '../src/lib/core/projection/auctions.ts';
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
		expect(Object.keys(INITIAL_CONTRACTS.byPlayer)).toEqual([]);
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
		expect(Object.keys(contracts.byPlayer)).toHaveLength(1);
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
		expect(Object.keys(contracts.byPlayer)).toHaveLength(1);
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

// --- The three folds agree about what a close IS ---------------------------

describe('one close, three folds — a payload any of them skips, all of them skip', () => {
	/**
	 * The invariant this block exists for, found by Story 3.4's code review.
	 *
	 * `nominationsReducer` frees the board seat and the nominating Team's
	 * Nomination Slot, `auctionsReducer` drops the Auction, and
	 * `contractsReducer` records who now owns the Player. Those are two halves
	 * of one fact plus the fact itself — the Player left the pool AND landed on
	 * a Team — so they must agree, event for event, about which payloads count.
	 *
	 * They did not. The first two gated only on `fantraxPlayerId` while the
	 * third also required a Team, a placement and two parseable amounts. A
	 * payload naming a valid Player with a corrupt `teamId` therefore released
	 * the seat and removed the Auction while recording NO contract: the won
	 * Player was in no auction, no nomination, no contract and no
	 * `team_rosters` row — silently back in the nominatable pool, with the
	 * winning Team's Cap Space and Roster Count never moving.
	 *
	 * `readClosedFacts` is now the one definition all three share, so the
	 * failure is loud instead: the Auction stays standing and visible.
	 */
	const NOMINATED = event(1, NOMINATION_PLACED_EVENT, {
		fantraxPlayerId: 'p-1',
		playerName: 'Ausar Bright',
		teamId: 't-n',
		teamName: 'Team N'
	});

	const BID = event(2, BID_PLACED_EVENT, {
		fantraxPlayerId: 'p-1',
		teamId: 't-1',
		teamName: 'Team M',
		managerId: 'm-1',
		amount: 8_000_000,
		closesAt: '2026-08-27T09:00:00.000Z'
	});

	/** Every way a close can name a real Player and still not be a close. */
	const CORRUPT: readonly [string, Record<string, unknown>][] = [
		['no teamId', { teamId: undefined }],
		['a blank teamId', { teamId: '' }],
		['an unknown placement', { placement: 'injury_reserve' }],
		['no placement', { placement: undefined }],
		['an unparseable winningAmount', { winningAmount: 'lots' }],
		['an unparseable capHit', { capHit: {} }],
		['a negative winningAmount', { winningAmount: -1 }],
		['a negative capHit', { capHit: -1 }]
	];

	it.each(CORRUPT)('all three folds skip a close with %s', (_label, overrides) => {
		const log = [NOMINATED, BID, close(3, overrides)];

		// The contract is not recorded...
		expect(contractForPlayer(foldClosures(...log), 'p-1')).toBeNull();
		// ...and neither of the other two moved either, so the Player is still
		// on the board and their Auction is still standing to be closed again.
		expect(
			nominationForPlayer(fold(INITIAL_NOMINATIONS, log, nominationsReducer), 'p-1')
		).not.toBeNull();
		expect(auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1')).not.toBeNull();
	});

	it('all three folds ACCEPT the well-formed close the same log ends with', () => {
		const log = [NOMINATED, BID, close(3)];

		// The mirror of the case above: when the payload is a real close, all
		// three move together — seat freed, Auction dropped, contract recorded.
		expect(contractForPlayer(foldClosures(...log), 'p-1')?.teamId).toBe('t-1');
		expect(nominationForPlayer(fold(INITIAL_NOMINATIONS, log, nominationsReducer), 'p-1')).toBeNull();
		expect(auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1')).toBeNull();
	});

	it('still skips a close naming no Player at all, in all three', () => {
		// The original shared case, which was never the broken one — kept so a
		// future narrowing of `readClosedFacts` cannot quietly drop it.
		const log = [NOMINATED, BID, close(3, { fantraxPlayerId: undefined })];

		expect(contractForPlayer(foldClosures(...log), 'p-1')).toBeNull();
		expect(
			nominationForPlayer(fold(INITIAL_NOMINATIONS, log, nominationsReducer), 'p-1')
		).not.toBeNull();
		expect(auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1')).not.toBeNull();
	});
});

describe('contractsReducer — the LATEST assignment for a Player wins (Story 6.1)', () => {
	/** An assignment, as `assignContractLength` builds one. */
	function assign(seq: number, overrides: Record<string, unknown> = {}): AppendedEvent {
		return event(seq, CONTRACT_LENGTH_ASSIGNED_EVENT, {
			fantraxPlayerId: 'p-1',
			playerName: 'Ausar Bright',
			teamId: 't-1',
			teamName: 'Team M',
			managerId: 'm-1',
			contractYears: 4,
			...overrides
		});
	}

	it('sets the length on the contract the close already recorded', () => {
		const contracts = foldClosures(close(1), assign(2));
		const contract = contractForPlayer(contracts, 'p-1');

		expect(contract?.contractYears).toBe(4);
		// Everything else on the contract is untouched: the assignment carries a
		// length and nothing the close already settled.
		expect(contract?.winningAmount).toBe(8_000_000);
		expect(contract?.capHit).toBe(8_000_000);
		expect(contract?.placement).toBe('active_bench');
		expect(contract?.closedAt).toBe('2026-08-27T09:00:00.000Z');
	});

	it('lets a LATER assignment overwrite an earlier one — the opposite of a close', () => {
		// First close wins; latest assignment wins. Both rules in one reducer,
		// and this is the assertion that they are actually different.
		const contracts = foldClosures(close(1), assign(2, { contractYears: 4 }), assign(3, { contractYears: 2 }));
		expect(contractForPlayer(contracts, 'p-1')?.contractYears).toBe(2);
	});

	it('converges under replay — folding the same log twice is the same state', () => {
		const log = [close(1), assign(2, { contractYears: 3 })];
		expect(foldClosures(...log, ...log)).toEqual(foldClosures(...log));
	});

	it('records nothing for a Player who holds no contract', () => {
		// There is no contract to carry the length, and an assignment must never
		// manufacture one out of its own payload.
		expect(foldClosures(assign(1))).toEqual(INITIAL_CONTRACTS);
	});

	it('refuses to move a length onto a contract another Team holds', () => {
		const contracts = foldClosures(close(1, { teamId: 't-1' }), assign(2, { teamId: 't-2' }));
		expect(contractForPlayer(contracts, 'p-1')?.contractYears).toBeNull();
	});

	it('SKIPS a malformed assignment rather than throwing over it', () => {
		for (const overrides of [
			{ fantraxPlayerId: undefined },
			{ fantraxPlayerId: '' },
			{ teamId: undefined },
			{ contractYears: undefined },
			{ contractYears: 0 },
			{ contractYears: 5 },
			{ contractYears: '4' },
			{ contractYears: null }
		]) {
			const contracts = foldClosures(close(1), assign(2, overrides));
			expect(
				contractForPlayer(contracts, 'p-1')?.contractYears,
				JSON.stringify(overrides)
			).toBeNull();
		}

		// A payload that is not an object at all, and one that is null.
		expect(
			contractForPlayer(
				foldClosures(close(1), event(2, CONTRACT_LENGTH_ASSIGNED_EVENT, 'nonsense')),
				'p-1'
			)?.contractYears
		).toBeNull();
		expect(
			contractForPlayer(
				foldClosures(close(1), event(2, CONTRACT_LENGTH_ASSIGNED_EVENT, null)),
				'p-1'
			)?.contractYears
		).toBeNull();
	});

	it('leaves a malformed assignment’s PREDECESSOR standing', () => {
		// A skipped correction must not silently unset a length that was validly
		// assigned before it — the fold returns the state it was handed.
		const contracts = foldClosures(close(1), assign(2, { contractYears: 3 }), assign(3, { contractYears: 9 }));
		expect(contractForPlayer(contracts, 'p-1')?.contractYears).toBe(3);
	});

	it('leaves every OTHER Player’s contract alone', () => {
		const contracts = foldClosures(
			close(1),
			close(2, { fantraxPlayerId: 'p-2', playerName: 'Somebody Else' }),
			assign(3, { contractYears: 4 })
		);
		expect(contractForPlayer(contracts, 'p-1')?.contractYears).toBe(4);
		expect(contractForPlayer(contracts, 'p-2')?.contractYears).toBeNull();
	});

	it('does not change what a CLOSE records — still UNSET', () => {
		expect(contractForPlayer(foldClosures(close(1)), 'p-1')?.contractYears).toBeNull();
	});
});

describe('isContractYears — the four legal lengths, stated once', () => {
	it('admits exactly 1, 2, 3 and 4', () => {
		for (const value of [1, 2, 3, 4]) expect(isContractYears(value)).toBe(true);
		for (const value of [0, 5, -1, 1.5, '4', null, undefined, NaN, true, {}]) {
			expect(isContractYears(value), JSON.stringify(value ?? null)).toBe(false);
		}
	});
});

describe('the Roster Trade event type (Story 7.10)', () => {
	it('still spells the WIRE name `RosterMoveRecorded`, whatever the constant is called', () => {
		// The act was renamed from Roster Move to Roster Trade in Story 7.10,
		// but AD-4 makes `auction_events` insert-only: rows written before that
		// story carry `'RosterMoveRecorded'` and always will. The constant moved
		// to Trade; the string did not. This assertion is what makes a later
		// rename of the VALUE a test failure rather than a fold that silently
		// stops matching history — `audit-log.ts` keys `RENDERERS` off this
		// constant, and that record is `Readonly<Record<string, AuditEntry>>`,
		// so a drifted key compiles cleanly and renders nothing.
		expect(ROSTER_TRADE_RECORDED_EVENT).toBe('RosterMoveRecorded');
	});
});

describe('contractsReducer — a Roster Trade (Story 7.7, FR-41)', () => {
	/** One well-formed transfer, as `evaluateTrade` builds one. */
	function transfer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			fantraxPlayerId: 'p-1',
			playerName: 'Ausar Bright',
			fromTeamId: 't-1',
			fromTeamName: 'Team M',
			toTeamId: 't-2',
			toTeamName: 'Team N',
			won: true,
			fromPlacement: 'active_bench',
			toPlacement: 'active_bench',
			capHitBefore: 8_000_000,
			capHitAfter: 8_000_000,
			winningAmount: 8_000_000,
			clearedContractYears: null,
			...overrides
		};
	}

	/** An assignment, as `assignContractLength` builds one. */
	function assign(seq: number, overrides: Record<string, unknown> = {}): AppendedEvent {
		return event(seq, CONTRACT_LENGTH_ASSIGNED_EVENT, {
			fantraxPlayerId: 'p-1',
			playerName: 'Ausar Bright',
			teamId: 't-1',
			teamName: 'Team M',
			managerId: 'm-1',
			contractYears: 4,
			...overrides
		});
	}

	function move(seq: number, transfers: readonly unknown[]): AppendedEvent {
		return event(seq, ROSTER_TRADE_RECORDED_EVENT, {
			sendingTeamId: 't-1',
			sendingTeamName: 'Team M',
			receivingTeamId: 't-2',
			receivingTeamName: 'Team N',
			transfers,
			sendingBefore: {
				teamId: 't-1',
				teamName: 'Team M',
				capSpace: 100_000_000,
				rosterCount: 1,
				injuryReserveOccupied: 0,
				minorLeagueOccupied: 0
			},
			sendingAfter: {
				teamId: 't-1',
				teamName: 'Team M',
				capSpace: 108_000_000,
				rosterCount: 0,
				injuryReserveOccupied: 0,
				minorLeagueOccupied: 0
			},
			receivingBefore: {
				teamId: 't-2',
				teamName: 'Team N',
				capSpace: 100_000_000,
				rosterCount: 0,
				injuryReserveOccupied: 0,
				minorLeagueOccupied: 0
			},
			receivingAfter: {
				teamId: 't-2',
				teamName: 'Team N',
				capSpace: 92_000_000,
				rosterCount: 1,
				injuryReserveOccupied: 0,
				minorLeagueOccupied: 0
			},
			reason: 'Agreed in the league channel.'
		});
	}

	it('rewrites the Team, re-derives the placement and Cap Hit, and clears the length', () => {
		const contracts = foldClosures(
			close(1, { winningAmount: 18_000_000, capHit: 0, placement: 'minor_league' }),
			assign(2, { contractYears: 3 }),
			move(3, [
				transfer({
					fromPlacement: 'minor_league',
					toPlacement: 'active_bench',
					capHitBefore: 0,
					capHitAfter: 18_000_000,
					winningAmount: 18_000_000,
					clearedContractYears: 3
				})
			])
		);

		expect(contractForPlayer(contracts, 'p-1')).toEqual({
			fantraxPlayerId: 'p-1',
			playerName: 'Ausar Bright',
			teamId: 't-2',
			teamName: 'Team N',
			// Unchanged by the Trade: a Trade is not a restructure (AD-23).
			winningAmount: 18_000_000,
			// ...while the charge follows the new placement.
			capHit: 18_000_000,
			placement: 'active_bench',
			contractYears: null,
			closedAt: '2026-08-27T09:00:00.000Z'
		});
	});

	it('folds the LATEST transfer, not the first — a Player may be traded twice', () => {
		// **Two DIFFERENT Moves for one Player**, which is the only shape that
		// can tell latest-wins from first-wins. Folding one Trade twice cannot:
		// identical events converge whichever rule is in force.
		const contracts = foldClosures(
			close(1, { winningAmount: 9_000_000, capHit: 9_000_000 }),
			move(2, [
				transfer({
					toTeamId: 't-2',
					toTeamName: 'Team N',
					toPlacement: 'active_bench',
					capHitAfter: 9_000_000
				})
			]),
			move(3, [
				transfer({
					fromTeamId: 't-2',
					fromTeamName: 'Team N',
					toTeamId: 't-3',
					toTeamName: 'Team P',
					toPlacement: 'minor_league',
					capHitBefore: 9_000_000,
					capHitAfter: 0,
					winningAmount: 9_000_000
				})
			])
		);

		const contract = contractForPlayer(contracts, 'p-1');
		// Where he is NOW, not where the first Trade put him.
		expect(contract?.teamId).toBe('t-3');
		expect(contract?.teamName).toBe('Team P');
		expect(contract?.placement).toBe('minor_league');
		expect(contract?.capHit).toBe(0);
		// The value never moved through either Trade (AD-23).
		expect(contract?.winningAmount).toBe(9_000_000);
	});

	it('lands the good transfers in a Trade whose array also holds a malformed one', () => {
		const contracts = foldClosures(
			close(1, { fantraxPlayerId: 'p-1' }),
			close(2, { fantraxPlayerId: 'p-2', playerName: 'Somebody Else' }),
			move(3, [
				transfer({ fantraxPlayerId: 'p-1' }),
				// `capHitAfter` that is a string but not a number: the old guard
				// admitted it on TYPE and `parseMoney` threw inside the fold,
				// which does not lose one transfer — it makes every future fold of
				// the whole log raise.
				transfer({ fantraxPlayerId: 'p-2', capHitAfter: 'abc' })
			])
		);

		expect(contractForPlayer(contracts, 'p-1')?.teamId).toBe('t-2');
		// The malformed one is SKIPPED: p-2 stays where the close put him.
		expect(contractForPlayer(contracts, 'p-2')?.teamId).toBe('t-1');
	});

	it('never throws on a malformed money field, whatever shape it takes', () => {
		for (const bad of [
			'abc',
			'',
			'  ',
			'1.5',
			'1e9',
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 2,
			'99999999999999999999',
			null,
			undefined,
			{},
			[],
			true
		]) {
			const label = JSON.stringify(bad ?? null);
			expect(() =>
				foldClosures(close(1), move(2, [transfer({ capHitAfter: bad })])),
				`capHitAfter ${label}`
			).not.toThrow();
			expect(() =>
				foldClosures(close(1), move(2, [transfer({ capHitBefore: bad })])),
				`capHitBefore ${label}`
			).not.toThrow();
			expect(() =>
				foldClosures(close(1), move(2, [transfer({ winningAmount: bad })])),
				`winningAmount ${label}`
			).not.toThrow();

			// ...and the contract is left exactly where the close put it.
			expect(
				contractForPlayer(foldClosures(close(1), move(2, [transfer({ capHitAfter: bad })])), 'p-1')
					?.teamId
			).toBe('t-1');
		}
	});

	it('SKIPS a transfer with no valid winningAmount rather than reading one out of the Cap Hit', () => {
		// AD-23: the two money fields are distinct and neither is derived from
		// the other. Falling back to `capHitAfter` would make a $0 stash's value
		// $0 — silently erasing exactly the distinction this fold exists to keep.
		const contracts = foldClosures(
			close(1),
			move(2, [transfer({ winningAmount: undefined, capHitAfter: 8_000_000 })])
		);

		expect(contractForPlayer(contracts, 'p-1')?.teamId).toBe('t-1');
		expect(contractForPlayer(contracts, 'p-1')?.winningAmount).toBe(8_000_000);
	});

	it('SKIPS a transfer with no valid capHitBefore rather than defaulting it to $0', () => {
		const contracts = foldClosures(close(1), move(2, [transfer({ capHitBefore: undefined })]));

		expect(contractForPlayer(contracts, 'p-1')?.teamId).toBe('t-1');
	});

	it('ignores a transfer for an Existing Contract — it has no row in this fold', () => {
		const contracts = foldClosures(close(1), move(2, [transfer({ won: false })]));

		expect(contractForPlayer(contracts, 'p-1')?.teamId).toBe('t-1');
	});

	it('ignores a transfer naming a Player who holds no Auction Contract', () => {
		const contracts = foldClosures(move(1, [transfer({ fantraxPlayerId: 'p-nobody' })]));

		expect(contractForPlayer(contracts, 'p-nobody')).toBeNull();
		expect(Object.keys(contracts.byPlayer)).toEqual([]);
	});

	it('refuses a placement outside the two legal ones — a moved win never lands on IR', () => {
		const contracts = foldClosures(
			close(1),
			move(2, [transfer({ toPlacement: 'injury_reserve' })])
		);

		expect(contractForPlayer(contracts, 'p-1')?.teamId).toBe('t-1');
		expect(contractForPlayer(contracts, 'p-1')?.placement).toBe('active_bench');
	});

	it('survives a payload with no transfers array at all', () => {
		expect(() =>
			foldClosures(close(1), event(2, ROSTER_TRADE_RECORDED_EVENT, { transfers: 'nonsense' }))
		).not.toThrow();
		expect(() =>
			foldClosures(close(1), event(2, ROSTER_TRADE_RECORDED_EVENT, null))
		).not.toThrow();
	});
});

describe('contractsReducer — a Roster Move (Story 7.11, FR-44)', () => {
	/** One well-formed re-placement, as `evaluateRearrange` builds one. */
	function moveOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			fantraxPlayerId: 'p-1',
			playerName: 'Ausar Bright',
			won: true,
			fromPlacement: 'active_bench',
			toPlacement: 'minor_league',
			capHitBefore: 8_000_000,
			capHitAfter: 0,
			value: 8_000_000,
			...overrides
		};
	}

	function rearranged(seq: number, moves: readonly unknown[]): AppendedEvent {
		return event(seq, ROSTER_REARRANGED_EVENT, {
			teamId: 't-1',
			teamName: 'Team M',
			moves,
			teamBefore: {
				teamId: 't-1',
				teamName: 'Team M',
				capSpace: 100_000_000,
				rosterCount: 1,
				injuryReserveOccupied: 0,
				minorLeagueOccupied: 0
			},
			teamAfter: {
				teamId: 't-1',
				teamName: 'Team M',
				capSpace: 108_000_000,
				rosterCount: 0,
				injuryReserveOccupied: 0,
				minorLeagueOccupied: 1
			},
			reason: null
		});
	}

	it('is a DIFFERENT wire name from the Trade, which is frozen', () => {
		// `'RosterMoveRecorded'` is the Trade's persisted name and AD-4 forbids
		// rewriting history, so the within-Team act takes a string of its own.
		// A collision here would fold two different payload shapes through one
		// reducer case.
		expect(ROSTER_REARRANGED_EVENT).toBe('RosterRearranged');
		expect(ROSTER_REARRANGED_EVENT).not.toBe(ROSTER_TRADE_RECORDED_EVENT);
	});

	it('moves a WON Contract by the event alone — placement and charged Cap Hit', () => {
		// **The whole reason this case exists.** An Auction Contract has no
		// `team_rosters` row, so nothing else in the system can re-place it: a
		// replay from the log alone has to reproduce both the Slot and what it
		// charges there.
		const contracts = foldClosures(close(1), rearranged(2, [moveOf()]));
		const contract = contractForPlayer(contracts, 'p-1');

		expect(contract?.placement).toBe('minor_league');
		expect(contract?.capHit).toBe(0);
		// **The value is untouched** (AD-23): a Move is not a restructure, and
		// a stash charging $0 against a win of $8,000,000 is exactly the pair
		// that must not collapse.
		expect(contract?.winningAmount).toBe(8_000_000);
		// And the Team did not change: a Move has no counterparty.
		expect(contract?.teamId).toBe('t-1');
	});

	it('does NOT clear the assigned contract length — §10 example 42 does not apply', () => {
		// A Trade clears it, because the Contract changed hands and the year
		// goes back to the sending Team's Year Allotment. A Move transfers
		// nothing, so FR-44 leaves the Year Allotment alone.
		const assigned = event(2, CONTRACT_LENGTH_ASSIGNED_EVENT, {
			fantraxPlayerId: 'p-1',
			playerName: 'Ausar Bright',
			teamId: 't-1',
			teamName: 'Team M',
			managerId: 'm-1',
			contractYears: 3
		});
		const contracts = foldClosures(close(1), assigned, rearranged(3, [moveOf()]));

		expect(contractForPlayer(contracts, 'p-1')?.contractYears).toBe(3);
	});

	it('LATEST move wins — the round trip returns the Contract exactly', () => {
		const contracts = foldClosures(
			close(1),
			rearranged(2, [moveOf()]),
			rearranged(3, [
				moveOf({
					fromPlacement: 'minor_league',
					toPlacement: 'active_bench',
					capHitBefore: 0,
					capHitAfter: 8_000_000
				})
			])
		);
		const contract = contractForPlayer(contracts, 'p-1');

		expect(contract?.placement).toBe('active_bench');
		expect(contract?.capHit).toBe(8_000_000);
		// Exactly the state the close left, which is §10 example 46's round
		// trip read off the fold.
		expect(contract).toEqual(contractForPlayer(foldClosures(close(1)), 'p-1'));
	});

	it('ignores a move for an Existing Contract — it has no row in this fold', () => {
		const contracts = foldClosures(close(1), rearranged(2, [moveOf({ won: false })]));

		expect(contractForPlayer(contracts, 'p-1')?.placement).toBe('active_bench');
		expect(contractForPlayer(contracts, 'p-1')?.capHit).toBe(8_000_000);
	});

	it('ignores a move naming a Player who holds no Auction Contract', () => {
		const contracts = foldClosures(rearranged(1, [moveOf({ fantraxPlayerId: 'p-nobody' })]));

		expect(contractForPlayer(contracts, 'p-nobody')).toBeNull();
		expect(Object.keys(contracts.byPlayer)).toEqual([]);
	});

	it('refuses a placement outside the two legal ones — a moved win never lands on IR', () => {
		const contracts = foldClosures(
			close(1),
			rearranged(2, [moveOf({ toPlacement: 'injury_reserve' })])
		);

		expect(contractForPlayer(contracts, 'p-1')?.placement).toBe('active_bench');
	});

	it('SKIPS a move whose money is not a whole number of dollars, rather than repairing it', () => {
		for (const bad of [undefined, null, 'abc', 1.5, {}, []]) {
			for (const field of ['capHitBefore', 'capHitAfter', 'value']) {
				const contracts = foldClosures(
					close(1),
					rearranged(2, [moveOf({ [field]: bad })])
				);
				// Nothing moved: the contract is left exactly where the close put
				// it, rather than re-placed at a charge nobody wrote.
				expect(contractForPlayer(contracts, 'p-1')?.placement).toBe('active_bench');
				expect(contractForPlayer(contracts, 'p-1')?.capHit).toBe(8_000_000);
			}
		}
	});

	it('SKIPS a move whose `fromPlacement` is unreadable, rather than substituting', () => {
		// **Not `readTransfers`' repair.** That reader falls back to
		// `toPlacement`, which is survivable because nothing folds on it here.
		// This field IS folded on: `projection/minors-history.ts` reads it to
		// decide whether the app has ever observed a Contract in a Minor League
		// Slot, so substituting `active_bench` for a missing origin would erase
		// the observation that makes a demoted stash promotable again.
		for (const bad of [undefined, null, 'injury_reserve', 'dead_money', '', 42]) {
			const contracts = foldClosures(
				close(1),
				rearranged(2, [moveOf({ fromPlacement: bad })])
			);
			expect(contractForPlayer(contracts, 'p-1')?.placement).toBe('active_bench');
			expect(contractForPlayer(contracts, 'p-1')?.capHit).toBe(8_000_000);
		}
	});

	it('orders LATEST-WINS across the Trade’s case and this one', () => {
		// The two acts are different reducer cases on one fold, and `fold()`
		// orders by `seq` alone. A Contract traded away and then rearranged by
		// its new Team must end where the LATER event put it — and the reverse
		// order must end the other way, or the fold is reading something other
		// than the sequence.
		const traded = event(2, ROSTER_TRADE_RECORDED_EVENT, {
			sendingTeamId: 't-1',
			sendingTeamName: 'Team M',
			receivingTeamId: 't-2',
			receivingTeamName: 'Team N',
			transfers: [
				{
					fantraxPlayerId: 'p-1',
					playerName: 'Ausar Bright',
					fromTeamId: 't-1',
					fromTeamName: 'Team M',
					toTeamId: 't-2',
					toTeamName: 'Team N',
					won: true,
					fromPlacement: 'active_bench',
					toPlacement: 'active_bench',
					capHitBefore: 8_000_000,
					capHitAfter: 8_000_000,
					winningAmount: 8_000_000,
					clearedContractYears: null
				}
			]
		});

		// Traded first, then rearranged: the Move is later, so it decides the
		// placement — and the Trade still decided the Team, which a Move never
		// touches.
		const thenMoved = contractForPlayer(foldClosures(close(1), traded, rearranged(3, [moveOf()])), 'p-1');
		expect(thenMoved?.teamId).toBe('t-2');
		expect(thenMoved?.placement).toBe('minor_league');
		expect(thenMoved?.capHit).toBe(0);

		// Rearranged first, then traded: the Trade is later, and it re-derives
		// placement against the receiving Team, so the Move's placement is
		// superseded rather than preserved.
		const thenTraded = contractForPlayer(
			foldClosures(close(1), rearranged(2, [moveOf()]), event(3, ROSTER_TRADE_RECORDED_EVENT, traded.payload)),
			'p-1'
		);
		expect(thenTraded?.teamId).toBe('t-2');
		expect(thenTraded?.placement).toBe('active_bench');
		expect(thenTraded?.capHit).toBe(8_000_000);
	});

	it('survives a payload with no moves array at all, and never throws', () => {
		for (const payload of [null, 'a string', 42, [1, 2, 3], { moves: 'nonsense' }]) {
			expect(() =>
				foldClosures(close(1), event(2, ROSTER_REARRANGED_EVENT, payload))
			).not.toThrow();
		}
	});

	it('converges when the same log is folded twice (AD-5)', () => {
		const events = [close(1), rearranged(2, [moveOf()])];
		const once = fold(INITIAL_CONTRACTS, events, contractsReducer);
		const twice = fold(once, events, contractsReducer);

		expect(twice).toEqual(once);
	});
});
