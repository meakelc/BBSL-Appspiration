/**
 * The Cap and roster figures read from `team_rosters`. Server-only (Story 2.6).
 *
 * One reader, two callers — the locked transaction and the read path — so the
 * figure a control is disabled against and the figure a Bid is refused
 * against cannot be computed two different ways. What this file pins is the
 * asymmetry between the two figures, which is the part that is easy to get
 * backwards: an Injury Reserve contract counts against the CAP and not
 * against the TWELVE, and a Minor League contract counts against neither.
 */

import { describe, expect, it } from 'vitest';

import { SALARY_CAP } from '../../src/lib/core/constants.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { INITIAL_CONTRACTS, contractsReducer } from '../../src/lib/core/projection/contracts.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import { loadTeamRoster } from '../../src/lib/server/team-roster.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';
import type { QueryResultRow, TransactionalClient } from '../../src/lib/shell/write.ts';

/**
 * The Auction Contracts a log holds, folded (Story 3.4).
 *
 * Built by folding real `AuctionClosed` events rather than by hand-assembling
 * an `AuctionContracts` literal: the reducer is what a caller will actually
 * have, and a hand-built state could carry a shape the fold cannot produce.
 */
function contractsFrom(...closes: readonly AppendedEvent[]) {
	return fold(INITIAL_CONTRACTS, closes, contractsReducer);
}

function close(
	seq: number,
	fantraxPlayerId: string,
	teamId: string,
	winningAmount: number,
	capHit: number,
	placement: 'active_bench' | 'minor_league'
): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt: '2026-08-27T09:00:00.000Z',
		schemaVersion: 1,
		coreVersion: 1,
		type: AUCTION_CLOSED_EVENT,
		payload: {
			fantraxPlayerId,
			playerName: fantraxPlayerId,
			teamId,
			teamName: teamId,
			managerId: 'm-1',
			winningAmount,
			capHit,
			placement,
			contention: 'standard',
			contractYears: null,
			closedAt: '2026-08-27T09:00:00.000Z'
		},
		managerId: 'm-1',
		teamId,
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

/**
 * A client that answers the one statement and records what it was asked.
 *
 * It throws on anything else, so a second query — or a read of a table this
 * module has no business touching — fails the suite rather than passing
 * silently.
 */
function fakeClient(rows: QueryResultRow[]) {
	const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
	const client: TransactionalClient = {
		async query(text: string, params: readonly unknown[] = []) {
			const sql = text.trim();
			statements.push({ sql, params });
			// Matched on the TABLE rather than on the column list: Story 4.5
			// widened the select to carry the Player id and name the Team
			// view's roster listing needs from the same one read, and pinning
			// the columns here would make that widening read as an unexpected
			// statement. Any OTHER table still throws.
			if (/from team_rosters/i.test(sql)) {
				return { rows };
			}
			throw new Error(`unexpected statement: ${sql}`);
		}
	};
	return { client, statements };
}

const row = (capHit: string | number, kind: string): QueryResultRow => ({
	cap_hit: capHit,
	roster_slot_kind: kind
});

describe('loadTeamRoster — Cap Space, Roster Count and minors occupancy from one statement', () => {
	it('reads one statement, keyed on the Team', async () => {
		const harness = fakeClient([]);

		await loadTeamRoster(harness.client, 't-7', INITIAL_CONTRACTS);

		expect(harness.statements).toHaveLength(1);
		expect(harness.statements[0]?.params).toEqual(['t-7']);
	});

	it('answers a Team with no rows with the full Salary Cap and Roster Count 0', async () => {
		// Reachable before the import promotes anything. A real state, not an
		// error — and not a refusal for a reason no rule states.
		const harness = fakeClient([]);

		expect(await loadTeamRoster(harness.client, 't-7', INITIAL_CONTRACTS)).toEqual({
			capSpace: SALARY_CAP,
			rosterCount: 0,
			minorLeagueOccupied: 0
		});
	});

	it('counts an Injury Reserve contract against the Cap but NOT against the twelve', async () => {
		const harness = fakeClient([
			row('4000000', 'active_bench'),
			row('3000000', 'injury_reserve')
		]);

		expect(await loadTeamRoster(harness.client, 't-7', INITIAL_CONTRACTS)).toEqual({
			capSpace: SALARY_CAP - 7_000_000,
			rosterCount: 1,
			// An IR row occupies no Minor League Slot either.
			minorLeagueOccupied: 0
		});
	});

	it('counts a Minor League contract against NEITHER', async () => {
		const harness = fakeClient([
			row('4000000', 'active_bench'),
			row('30000000', 'minor_league')
		]);

		expect(await loadTeamRoster(harness.client, 't-7', INITIAL_CONTRACTS)).toEqual({
			capSpace: SALARY_CAP - 4_000_000,
			rosterCount: 1,
			// ...and it is the one kind that DOES occupy a Minor League Slot,
			// which is the fact `M = max(0, 3 - occupied)` is derived from
			// (Story 2.8). Counted from the same rows, in the same loop.
			minorLeagueOccupied: 1
		});
	});

	it('brands the amount at the boundary, whichever shape the driver returns it in', async () => {
		// The same `int8` arrives as a string through one client and a number
		// through the other; `parseMoney` is what settles it (AD-8).
		const asString = fakeClient([row('4000000', 'active_bench')]);
		const asNumber = fakeClient([row(4_000_000, 'active_bench')]);

		expect(await loadTeamRoster(asString.client, 't-7', INITIAL_CONTRACTS)).toEqual(
			await loadTeamRoster(asNumber.client, 't-7', INITIAL_CONTRACTS)
		);
	});

	it('does not let an unknown slot kind silently consume one of the twelve', async () => {
		// Unreachable through the database, which carries a check constraint.
		// If it ever were reached, counting it against the Cap and not against
		// Roster Count is the conservative reading.
		const harness = fakeClient([row('4000000', 'something_else')]);

		expect(await loadTeamRoster(harness.client, 't-7', INITIAL_CONTRACTS)).toEqual({
			capSpace: SALARY_CAP - 4_000_000,
			rosterCount: 0,
			// Nor does it silently consume one of the three.
			minorLeagueOccupied: 0
		});
	});
});

/**
 * The Auction Contracts half of the same three figures (Story 3.4).
 *
 * What a Team WON is not in `team_rosters` — nothing writes that table but the
 * import — so it is folded from `AuctionClosed` and concatenated onto the rows
 * read, before the ONE loop. What this suite pins is that a contract is
 * counted by exactly the same rules an imported row is, with no second counter
 * anywhere: Roster Count moves only on an Active/Bench placement, occupancy
 * moves only on a Minor League one, and a Minor League Cap Hit is $0.
 */
describe('loadTeamRoster — the Auction Contracts fold, counted by the same loop', () => {
	it('issues no extra statement for the contracts — they are not a table', async () => {
		const harness = fakeClient([]);

		await loadTeamRoster(
			harness.client,
			't-7',
			contractsFrom(close(1, 'p-1', 't-7', 8_000_000, 8_000_000, 'active_bench'))
		);

		// One read, still keyed on the Team. A contract is a fold, not a row
		// somebody has to go and fetch.
		expect(harness.statements).toHaveLength(1);
	});

	it('charges an Active/Bench win against the Cap and against the twelve', async () => {
		const harness = fakeClient([row('4000000', 'active_bench')]);

		expect(
			await loadTeamRoster(
				harness.client,
				't-7',
				contractsFrom(close(1, 'p-1', 't-7', 8_000_000, 8_000_000, 'active_bench'))
			)
		).toEqual({
			capSpace: SALARY_CAP - 12_000_000,
			rosterCount: 2,
			minorLeagueOccupied: 0
		});
	});

	it('charges a Minor League win against NEITHER, and occupies a Slot (AD-23)', async () => {
		// §10 example 16's shape: won at $4,000,000, Cap Hit $0, Roster Count
		// unchanged, occupancy up by one. The winning amount stands on the
		// contract; it simply is not what the Cap is charged.
		const harness = fakeClient([row('4000000', 'active_bench')]);

		expect(
			await loadTeamRoster(
				harness.client,
				't-7',
				contractsFrom(close(1, 'p-1', 't-7', 4_000_000, 0, 'minor_league'))
			)
		).toEqual({
			capSpace: SALARY_CAP - 4_000_000,
			rosterCount: 1,
			minorLeagueOccupied: 1
		});
	});

	it('counts only THIS Team’s contracts', async () => {
		const harness = fakeClient([]);

		expect(
			await loadTeamRoster(
				harness.client,
				't-7',
				contractsFrom(
					close(1, 'p-1', 't-7', 8_000_000, 8_000_000, 'active_bench'),
					close(2, 'p-2', 't-8', 30_000_000, 30_000_000, 'active_bench')
				)
			)
		).toEqual({
			capSpace: SALARY_CAP - 8_000_000,
			rosterCount: 1,
			minorLeagueOccupied: 0
		});
	});

	it('adds imported rows and won contracts into ONE set of figures', async () => {
		const harness = fakeClient([
			row('4000000', 'active_bench'),
			row('3000000', 'injury_reserve'),
			row('30000000', 'minor_league')
		]);

		expect(
			await loadTeamRoster(
				harness.client,
				't-7',
				contractsFrom(
					close(1, 'p-1', 't-7', 8_000_000, 8_000_000, 'active_bench'),
					close(2, 'p-2', 't-7', 4_000_000, 0, 'minor_league')
				)
			)
		).toEqual({
			// $4.0M imported + $3.0M IR + $0 minors + $8.0M won + $0 won-minors.
			capSpace: SALARY_CAP - 15_000_000,
			// One imported Active/Bench row plus one Active/Bench win. The IR
			// row and both Minor League rows count for nothing here.
			rosterCount: 2,
			// One imported Minor League row plus one Minor League win.
			minorLeagueOccupied: 2
		});
	});
});
