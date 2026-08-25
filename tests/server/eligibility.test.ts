import { describe, expect, it, vi } from 'vitest';

import { MINOR_LEAGUE_ELIGIBILITY_SET } from '../../src/lib/core/projection/eligibility.ts';
import { eligibilityRefusalDetail } from '../../src/lib/core/rules/eligibility.ts';
import type { MinorLeagueEligibilitySetPayload } from '../../src/lib/core/projection/eligibility.ts';
import {
	loadEligibilityPool,
	refuseEligibilityChange,
	setEligibility
} from '../../src/lib/server/eligibility.ts';
import type { EligibilityRejection } from '../../src/lib/server/eligibility.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

const ACTOR = { managerId: 'm-1', teamId: 't-commissioner' };

type PoolPlayer = { id: string; name: string };

/**
 * A stateful fake `ConnectionGateway` for `setEligibility`, in the style of
 * `tests/server/pool-import.test.ts` and `import-promotion.test.ts`: it
 * records every statement in order and keeps the live column in memory, so
 * "no event was appended", "no column was written on a rejection" and
 * "everything rolled back on a throw" are all observable rather than assumed.
 */
function fakeGateway(options: {
	pool?: PoolPlayer[];
	events?: QueryResultRow[];
	/** The first statement matching this pattern throws. */
	throwOn?: RegExp;
}) {
	const pool = options.pool ?? [];
	const order: string[] = [];
	const appendedEvents: QueryResultRow[] = [];
	/** The live `minor_league_eligible` column, as committed. */
	let column = new Set<string>();
	let uncommitted: Set<string> | null = null;
	let seq = 10;
	let released = 0;
	let committed = false;

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, params: readonly unknown[] = []) {
			const sql = text.trim();
			if (options.throwOn !== undefined && options.throwOn.test(sql)) {
				order.push('throw');
				throw new Error('the projection write failed partway');
			}
			if (/^begin/i.test(sql)) {
				order.push('begin');
				return { rows: [] };
			}
			if (/pg_advisory_xact_lock/i.test(sql)) {
				order.push('lock');
				return { rows: [{ locked: true, now: new Date('2026-08-25T09:00:00.000Z') }] };
			}
			if (/^select \* from auction_events/i.test(sql)) {
				order.push('read-log');
				return { rows: options.events ?? [] };
			}
			if (/^select fantrax_player_id, player_name/i.test(sql)) {
				order.push('read-pool');
				return {
					rows: pool.map((player) => ({
						fantrax_player_id: player.id,
						player_name: player.name
					}))
				};
			}
			if (/^insert into auction_events/i.test(sql)) {
				order.push('append-event');
				seq += 1;
				const row: QueryResultRow = {
					seq,
					occurred_at: params[0],
					schema_version: params[1],
					core_version: params[2],
					manager_id: params[3],
					team_id: params[4],
					event_type: params[5],
					payload: JSON.parse(String(params[6])),
					device_class: params[7],
					dispatch_outcome: params[8],
					delivery_outcome: params[9]
				};
				appendedEvents.push(row);
				return { rows: [row] };
			}
			if (/^update free_agent_players/i.test(sql)) {
				order.push('apply-projection');
				uncommitted = new Set((params[0] ?? []) as string[]);
				return { rows: [] };
			}
			if (/^commit/i.test(sql)) {
				order.push('commit');
				committed = true;
				if (uncommitted !== null) column = uncommitted;
				return { rows: [] };
			}
			if (/^rollback/i.test(sql)) {
				order.push('rollback');
				// A real ROLLBACK discards every uncommitted write; the fake must
				// too, or "nothing was written" would be trivially true.
				uncommitted = null;
				appendedEvents.length = 0;
				return { rows: [] };
			}
			throw new Error(`unexpected statement: ${sql}`);
		},
		release() {
			released += 1;
		}
	};

	const gateway: ConnectionGateway = { connect: async () => client };
	return {
		gateway,
		order,
		appendedEvents,
		state: {
			get column() {
				return [...column].sort();
			},
			get released() {
				return released;
			},
			get committed() {
				return committed;
			}
		}
	};
}

function eligibilityEvent(
	seq: number,
	fantraxPlayerId: string,
	before: boolean,
	after: boolean
): QueryResultRow {
	return {
		seq,
		occurred_at: new Date('2026-08-25T08:00:00.000Z'),
		schema_version: 1,
		core_version: 1,
		manager_id: 'm-1',
		team_id: 't-commissioner',
		event_type: MINOR_LEAGUE_ELIGIBILITY_SET,
		payload: { fantraxPlayerId, playerName: fantraxPlayerId, before, after }
	};
}

/** A pool of `count` Players, named so the sort order is the id order. */
function poolOf(count: number): PoolPlayer[] {
	return Array.from({ length: count }, (_unused, index) => ({
		id: `p-${String(index).padStart(2, '0')}`,
		name: `Player ${String(index).padStart(2, '0')}`
	}));
}

function rejectionOf(outcome: { kind: string; reason?: unknown }): EligibilityRejection {
	expect(outcome.kind).toBe('rejected');
	return outcome.reason as EligibilityRejection;
}

describe('setEligibility — setting the flag', () => {
	it('sets one Player: one event with before false and after true, and the column matches', async () => {
		const harness = fakeGateway({ pool: poolOf(3) });

		const result = await setEligibility(harness.gateway, ACTOR, ['p-01'], true);

		expect(result.outcome.kind).toBe('accepted');
		if (result.outcome.kind !== 'accepted') return;
		expect(result.outcome.events).toHaveLength(1);
		const event = result.outcome.events[0];
		expect(event?.type).toBe(MINOR_LEAGUE_ELIGIBILITY_SET);
		expect(event?.managerId).toBe(ACTOR.managerId);
		expect(event?.teamId).toBe(ACTOR.teamId);
		expect(event?.occurredAt).toBe('2026-08-25T09:00:00.000Z');
		expect(typeof event?.schemaVersion).toBe('number');
		expect(typeof event?.coreVersion).toBe('number');
		expect(event?.payload as MinorLeagueEligibilitySetPayload).toEqual({
			fantraxPlayerId: 'p-01',
			playerName: 'Player 01',
			before: false,
			after: true
		});
		expect(harness.state.column).toEqual(['p-01']);
		expect(harness.state.committed).toBe(true);
		expect(harness.state.released).toBe(1);
	});

	it('takes the lock before it reads, and writes the column inside the same transaction', async () => {
		const harness = fakeGateway({ pool: poolOf(2) });

		await setEligibility(harness.gateway, ACTOR, ['p-00'], true);

		expect(harness.order[0]).toBe('begin');
		expect(harness.order[1]).toBe('lock');
		expect(harness.order[2]).toBe('read-log');
		const commitIndex = harness.order.indexOf('commit');
		expect(harness.order.indexOf('append-event')).toBeLessThan(commitIndex);
		expect(harness.order.indexOf('apply-projection')).toBeGreaterThan(
			harness.order.indexOf('append-event')
		);
		expect(harness.order.indexOf('apply-projection')).toBeLessThan(commitIndex);
		expect(harness.order.filter((step) => step === 'commit')).toHaveLength(1);
	});

	it('bulk-sets forty Players of which three are already eligible: 37 events, 3 unchanged', async () => {
		const pool = poolOf(40);
		const harness = fakeGateway({
			pool,
			events: [
				eligibilityEvent(1, 'p-00', false, true),
				eligibilityEvent(2, 'p-05', false, true),
				eligibilityEvent(3, 'p-39', false, true)
			]
		});

		const result = await setEligibility(
			harness.gateway,
			ACTOR,
			pool.map((player) => player.id),
			true
		);

		expect(result.outcome.kind).toBe('accepted');
		if (result.outcome.kind !== 'accepted') return;
		expect(result.outcome.events).toHaveLength(37);
		expect(result.plan?.unchanged.map((player) => player.fantraxPlayerId)).toEqual([
			'p-00',
			'p-05',
			'p-39'
		]);
		// The column matches the fold of the whole log: all forty.
		expect(harness.state.column).toEqual(pool.map((player) => player.id).sort());
	});

	it('appends NO event for a no-op and reports the Player as unchanged', async () => {
		const harness = fakeGateway({
			pool: poolOf(2),
			events: [eligibilityEvent(1, 'p-00', false, true)]
		});

		const result = await setEligibility(harness.gateway, ACTOR, ['p-00'], true);

		expect(result.outcome.kind).toBe('accepted');
		if (result.outcome.kind !== 'accepted') return;
		expect(result.outcome.events).toEqual([]);
		expect(harness.order).not.toContain('append-event');
		expect(result.plan?.unchanged).toEqual([
			{ fantraxPlayerId: 'p-00', playerName: 'Player 00', eligible: true }
		]);
		// The flag it already held is still held: an accepted no-op never
		// clears the column it did not change.
		expect(harness.state.column).toEqual(['p-00']);
	});

	it('unsets, carrying before true and after false', async () => {
		const harness = fakeGateway({
			pool: poolOf(2),
			events: [eligibilityEvent(1, 'p-00', false, true), eligibilityEvent(2, 'p-01', false, true)]
		});

		const result = await setEligibility(harness.gateway, ACTOR, ['p-00'], false);

		expect(result.outcome.kind).toBe('accepted');
		if (result.outcome.kind !== 'accepted') return;
		expect(result.outcome.events[0]?.payload as MinorLeagueEligibilitySetPayload).toMatchObject({
			fantraxPlayerId: 'p-00',
			before: true,
			after: false
		});
		expect(harness.state.column).toEqual(['p-01']);
	});

	it('unsets the LAST eligible Player, clearing the column for every row', async () => {
		// The empty-set case: `applyEligibilityProjection` runs with `any('{}')`,
		// which must make every row false rather than leaving the previous
		// value standing. Without this, a projection writer that skipped the
		// update on an empty set would ship green.
		const harness = fakeGateway({
			pool: poolOf(3),
			events: [eligibilityEvent(1, 'p-00', false, true)]
		});

		const result = await setEligibility(harness.gateway, ACTOR, ['p-00'], false);

		expect(result.outcome.kind).toBe('accepted');
		if (result.outcome.kind !== 'accepted') return;
		expect(result.outcome.events).toHaveLength(1);
		expect(harness.order).toContain('apply-projection');
		expect(harness.state.column).toEqual([]);
	});

	it('takes the current value from the FOLD of the log, not from the column it might disagree with', async () => {
		// The pool read carries no eligibility column at all — the only source
		// of "before" is the fold, which is what makes the Audit Log the log's
		// own account of itself.
		const harness = fakeGateway({
			pool: poolOf(2),
			events: [
				eligibilityEvent(1, 'p-01', false, true),
				eligibilityEvent(2, 'p-01', true, false)
			]
		});

		const result = await setEligibility(harness.gateway, ACTOR, ['p-01'], true);

		expect(result.outcome.kind).toBe('accepted');
		if (result.outcome.kind !== 'accepted') return;
		expect(result.outcome.events[0]?.payload as MinorLeagueEligibilitySetPayload).toMatchObject({
			before: false,
			after: true
		});
	});
});

describe('setEligibility — the refusals, re-derived inside the transaction', () => {
	it('refuses an unknown Player id by name, and writes nothing', async () => {
		const harness = fakeGateway({ pool: poolOf(2) });

		const result = await setEligibility(harness.gateway, ACTOR, ['p-00', 'ghost'], true);

		const rejection = rejectionOf(result.outcome);
		expect(rejection.refusal.kind).toBe('unknown_players');
		if (rejection.refusal.kind !== 'unknown_players') return;
		expect(rejection.refusal.fantraxPlayerIds).toEqual(['ghost']);
		expect(rejection.detail).toBe(eligibilityRefusalDetail(rejection.refusal));
		expect(rejection.detail).toContain('ghost');
		// Not even the valid half of the submission was written.
		expect(harness.order).not.toContain('append-event');
		expect(harness.order).not.toContain('apply-projection');
		expect(harness.order).toContain('rollback');
		expect(harness.order).not.toContain('commit');
		expect(harness.state.column).toEqual([]);
		expect(result.plan).toBeNull();
	});

	it('refuses an empty selection inside the transaction too, not only at the route', async () => {
		const harness = fakeGateway({ pool: poolOf(2) });

		const result = await setEligibility(harness.gateway, ACTOR, [], true);

		const rejection = rejectionOf(result.outcome);
		expect(rejection.refusal.kind).toBe('empty_selection');
		expect(harness.order).not.toContain('append-event');
		expect(harness.order).not.toContain('apply-projection');
	});

	it('refuses once the phase folds to Auction, naming the phase and the override', async () => {
		// `phaseReducer` has no case for any event yet (1.11 teaches it
		// `AuctionOpened`), so the phase is driven here through the exported
		// gate rather than through a log the reducer cannot yet move. The
		// transaction-level proof that the phase comes from the log at all is
		// the `read-log` ordering assertion above.
		const refusal = refuseEligibilityChange(
			{ phase: 'Auction', pool: [], eligible: new Set<string>() },
			['p-00'],
			{ changes: [], unchanged: [], unknownIds: ['p-00'] }
		);
		expect(refusal?.kind).toBe('phase');
		if (refusal?.kind !== 'phase') return;
		expect(refusal.phase).toBe('Auction');
		const detail = eligibilityRefusalDetail(refusal);
		expect(detail).toContain('Auction');
		expect(detail).toContain('FR-35');
		expect(detail).toContain('override');
	});

	it('refuses on the phase before it complains about an unknown id', () => {
		const refusal = refuseEligibilityChange(
			{ phase: 'Auction', pool: [], eligible: new Set<string>() },
			[],
			{ changes: [], unchanged: [], unknownIds: ['ghost'] }
		);
		expect(refusal?.kind).toBe('phase');
	});
});

describe('setEligibility — a failure mid-write', () => {
	it('rolls the whole transaction back and rethrows, leaving no event and no column change', async () => {
		const harness = fakeGateway({
			pool: poolOf(2),
			throwOn: /^update free_agent_players/i
		});

		await expect(setEligibility(harness.gateway, ACTOR, ['p-00'], true)).rejects.toThrow(
			/failed partway/
		);

		expect(harness.order).toContain('rollback');
		expect(harness.order).not.toContain('commit');
		expect(harness.appendedEvents).toEqual([]);
		expect(harness.state.column).toEqual([]);
		expect(harness.state.released).toBe(1);
	});
});

describe('loadEligibilityPool', () => {
	function fakeClient(rows: unknown[] | null, error: { message: string } | null = null) {
		const order = vi.fn(async () => ({ data: rows, error }));
		const select = vi.fn(() => ({ order }));
		const from = vi.fn(() => ({ select }));
		return { client: { from } as never, from, select, order };
	}

	it('hands the surface finished consequence sentences, sorted by Player name', async () => {
		const { client, from, select, order } = fakeClient([
			{
				fantrax_player_id: 'p-1',
				player_name: 'Alice',
				positions: 'PG',
				nba_team: 'LAL',
				minor_league_eligible: true
			},
			{
				fantrax_player_id: 'p-2',
				player_name: 'Bob',
				positions: 'C',
				nba_team: 'BOS',
				minor_league_eligible: false
			}
		]);

		const pool = await loadEligibilityPool(client);

		expect(from).toHaveBeenCalledWith('free_agent_players');
		expect(select).toHaveBeenCalled();
		expect(order).toHaveBeenCalledWith('player_name', { ascending: true });
		// Pinned to the core's own output, so a second renderer cannot pass.
		const { eligibilityRowSentence } = await import('../../src/lib/core/rules/eligibility.ts');
		expect(pool.players[0]?.consequence).toBe(eligibilityRowSentence('Alice', true));
		expect(pool.players[1]?.consequence).toBe(eligibilityRowSentence('Bob', false));
		expect(pool.players[0]?.eligible).toBe(true);
		expect(pool.players[1]?.eligible).toBe(false);
	});

	it('returns an empty pool as an empty list, not an error — nothing is promoted yet', async () => {
		const { client } = fakeClient([]);
		expect((await loadEligibilityPool(client)).players).toEqual([]);
	});

	it('throws a descriptive error on a read failure', async () => {
		const { client } = fakeClient(null, { message: 'permission denied' });
		await expect(loadEligibilityPool(client)).rejects.toThrow(/permission denied/);
	});
});
