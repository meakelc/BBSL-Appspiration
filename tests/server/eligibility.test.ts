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
	/** Rostered Contracts, which the candidate read unions in behind the pool. */
	rosters?: PoolPlayer[];
	events?: QueryResultRow[];
	/** The first statement matching this pattern throws. */
	throwOn?: RegExp;
}) {
	const pool = options.pool ?? [];
	const rosters = options.rosters ?? [];
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
				order.push('read-candidates');
				// The real query is `distinct on (fantrax_player_id)` over
				// free_agent_players UNION ALL team_rosters, pool first, then
				// sorted by name. The fake reproduces all three properties, so a
				// duplicate id and the name ordering are testable here.
				expect(sql).toMatch(/free_agent_players/);
				expect(sql).toMatch(/team_rosters/);
				const byId = new Map<string, PoolPlayer & { source: number }>();
				// `source` 0 is the pool and 1 a Roster, pool first — so a duplicate
				// id resolves to the POOL, exactly as the real `distinct on` does.
				// The phase gate reads this, so the fake must carry it or every
				// candidate would read as rostered and the gate would never fire.
				for (const player of pool) {
					if (!byId.has(player.id)) byId.set(player.id, { ...player, source: 0 });
				}
				for (const player of rosters) {
					if (!byId.has(player.id)) byId.set(player.id, { ...player, source: 1 });
				}
				return {
					rows: [...byId.values()]
						.sort((left, right) => left.name.localeCompare(right.name))
						.map((player) => ({
							fantrax_player_id: player.id,
							player_name: player.name,
							source: player.source
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
				// The real statement is
				//   set minor_league_eligible = (fantrax_player_id = any($1))
				// which touches POOL ROWS ONLY. Intersecting with the pool here is
				// what makes that true of the fake as well: the fold handed in can
				// name a rostered Contract, and such an id matches no row and must
				// leave no trace in the column. Without the intersection the fake
				// would report the fold back as if it were the column, and
				// "a rostered flag lives only in the log" would be untestable.
				const folded = new Set((params[0] ?? []) as string[]);
				uncommitted = new Set(pool.map((player) => player.id).filter((id) => folded.has(id)));
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

describe('setEligibility — a rostered Contract is a candidate too', () => {
	// FR-44: `mayOccupyMinorLeague` is the union of this flag and the
	// observation fold, so a rostered Player the app has never seen in a Minor
	// League Slot can only be admitted by setting the flag on him. Before this,
	// his id was refused as unknown because the candidate read saw the pool
	// alone.
	it('sets the flag on a Player who is on a Roster and not in the pool', async () => {
		const harness = fakeGateway({
			pool: [{ id: 'p-pooled', name: 'Pooled Player' }],
			rosters: [{ id: 'p-rostered', name: 'Rostered Contract' }]
		});

		const { outcome, plan } = await setEligibility(
			harness.gateway,
			ACTOR,
			['p-rostered'],
			true
		);

		expect(outcome.kind).toBe('accepted');
		expect(plan?.changes.map((change) => change.fantraxPlayerId)).toEqual(['p-rostered']);
		expect(plan?.unknownIds).toEqual([]);
		expect(harness.appendedEvents).toHaveLength(1);
		const payload = harness.appendedEvents[0]?.payload as MinorLeagueEligibilitySetPayload;
		expect(payload.fantraxPlayerId).toBe('p-rostered');
		expect(payload.before).toBe(false);
		expect(payload.after).toBe(true);
	});

	it('leaves the column alone for a rostered id, because no pool row carries it', async () => {
		const harness = fakeGateway({
			pool: [{ id: 'p-pooled', name: 'Pooled Player' }],
			rosters: [{ id: 'p-rostered', name: 'Rostered Contract' }]
		});

		await setEligibility(harness.gateway, ACTOR, ['p-rostered'], true);

		// The projection statement still ran and still received the whole fold —
		// the rostered id simply matches no row. The fold is the authority; the
		// column is the pooled subset of it, so the column stays EMPTY here.
		// (This assertion read `['p-rostered']` until the fake was taught to
		// intersect with the pool, which is what the real `= any($1)` does. It
		// was reporting the fold back as the column and contradicting the name
		// of its own test.)
		expect(harness.order).toContain('apply-projection');
		expect(harness.state.column).toEqual([]);
	});

	it('sets pooled and rostered Players in ONE transaction, one event each', async () => {
		const harness = fakeGateway({
			pool: [{ id: 'p-pooled', name: 'Pooled Player' }],
			rosters: [{ id: 'p-rostered', name: 'Rostered Contract' }]
		});

		const { outcome, plan } = await setEligibility(
			harness.gateway,
			ACTOR,
			['p-pooled', 'p-rostered'],
			true
		);

		expect(outcome.kind).toBe('accepted');
		expect(plan?.changes).toHaveLength(2);
		expect(harness.appendedEvents).toHaveLength(2);
		expect(harness.order.filter((step) => step === 'commit')).toHaveLength(1);
	});

	it('still refuses an id that is in neither the pool nor a Roster', async () => {
		const harness = fakeGateway({
			pool: [{ id: 'p-pooled', name: 'Pooled Player' }],
			rosters: [{ id: 'p-rostered', name: 'Rostered Contract' }]
		});

		const { outcome } = await setEligibility(harness.gateway, ACTOR, ['ghost'], true);

		const rejection = rejectionOf(outcome);
		expect(rejection.refusal.kind).toBe('unknown_players');
		// The sentence names both halves, so it cannot read as "not in the pool"
		// to a Commissioner who just ticked a rostered Player.
		expect(rejection.detail).toContain('Free Agent pool');
		expect(rejection.detail).toContain('rostered');
		expect(harness.appendedEvents).toEqual([]);
	});

	it('writes ONE event for a Player the two tables both name', async () => {
		// The tables are disjoint in practice; `distinct on` makes that a
		// property of the query rather than a hope. Two rows for one Player
		// would append a second event whose `before` was already stale.
		const harness = fakeGateway({
			pool: [{ id: 'p-both', name: 'Two Rows' }],
			rosters: [{ id: 'p-both', name: 'Two Rows' }]
		});

		const { plan } = await setEligibility(harness.gateway, ACTOR, ['p-both'], true);

		expect(plan?.changes).toHaveLength(1);
		expect(harness.appendedEvents).toHaveLength(1);
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

	it('refuses end to end once the log holds an AuctionOpened event', async () => {
		// End to end since Story 1.11: `phaseReducer` now folds `AuctionOpened`
		// to Auction, so this goes through the real transaction rather than
		// through the exported gate — the case 1.10 logged as unreachable.
		const harness = fakeGateway({
			pool: poolOf(2),
			events: [
				{
					seq: 1,
					occurred_at: new Date('2026-08-25T08:00:00.000Z'),
					schema_version: 1,
					core_version: 1,
					manager_id: 'm-1',
					team_id: 't-commissioner',
					event_type: 'AuctionOpened',
					payload: { teams: [] }
				}
			]
		});

		const result = await setEligibility(harness.gateway, ACTOR, ['p-00'], true);

		const rejection = rejectionOf(result.outcome);
		expect(rejection.refusal.kind).toBe('phase');
		if (rejection.refusal.kind !== 'phase') return;
		expect(rejection.refusal.phase).toBe('Auction');
		expect(rejection.detail).toBe(eligibilityRefusalDetail(rejection.refusal));
		expect(harness.order).not.toContain('append-event');
		expect(harness.order).not.toContain('apply-projection');
		expect(harness.order).toContain('rollback');
		expect(harness.state.column).toEqual([]);
	});

	it('refuses once the phase folds to Auction, naming the phase and the pooled Player', () => {
		// The pure gate, driven directly, so the WORDING is asserted
		// independently of a log that can reach it.
		const refusal = refuseEligibilityChange(
			{
				phase: 'Auction',
				candidates: [
					{ fantraxPlayerId: 'p-00', playerName: 'Pooled', eligible: false, pooled: true }
				],
				eligible: new Set<string>()
			},
			['p-00'],
			{ changes: [], unchanged: [], unknownIds: [] }
		);
		expect(refusal?.kind).toBe('phase');
		if (refusal?.kind !== 'phase') return;
		expect(refusal.phase).toBe('Auction');
		expect(refusal.fantraxPlayerIds).toEqual(['p-00']);
		const detail = eligibilityRefusalDetail(refusal);
		expect(detail).toContain('Auction');
		expect(detail).toContain('FR-35');
		expect(detail).toContain('p-00');
	});

	// --- The FR-44 narrowing: the phase gates POOLED Players, not the flag ---

	it('accepts a rostered Contract outside Setup — it has no open Auction to restate', () => {
		const refusal = refuseEligibilityChange(
			{
				phase: 'Auction',
				candidates: [
					{ fantraxPlayerId: 'r-00', playerName: 'Rostered', eligible: false, pooled: false }
				],
				eligible: new Set<string>()
			},
			['r-00'],
			{ changes: [], unchanged: [], unknownIds: [] }
		);
		expect(refusal).toBeNull();
	});

	it('gates a rostered Contract in NO phase, and a pooled Player in every phase but Setup', () => {
		const candidates = [
			{ fantraxPlayerId: 'p-00', playerName: 'Pooled', eligible: false, pooled: true },
			{ fantraxPlayerId: 'r-00', playerName: 'Rostered', eligible: false, pooled: false }
		];
		const plan = { changes: [], unchanged: [], unknownIds: [] };
		for (const phase of ['Setup', 'Auction', 'Contract Assignment', 'Archived']) {
			const state = { phase, candidates, eligible: new Set<string>() };
			// The rostered half is never gated by the phase, in any phase.
			expect(refuseEligibilityChange(state, ['r-00'], plan)).toBeNull();
			// The pooled half is gated in every phase except Setup.
			const pooled = refuseEligibilityChange(state, ['p-00'], plan);
			if (phase === 'Setup') expect(pooled).toBeNull();
			else expect(pooled?.kind).toBe('phase');
		}
	});

	it('refuses a MIXED submission, naming only the pooled Player as the cause', () => {
		const refusal = refuseEligibilityChange(
			{
				phase: 'Auction',
				candidates: [
					{ fantraxPlayerId: 'p-00', playerName: 'Pooled', eligible: false, pooled: true },
					{ fantraxPlayerId: 'r-00', playerName: 'Rostered', eligible: false, pooled: false }
				],
				eligible: new Set<string>()
			},
			['p-00', 'r-00'],
			{ changes: [], unchanged: [], unknownIds: [] }
		);
		expect(refusal?.kind).toBe('phase');
		if (refusal?.kind !== 'phase') return;
		// The rostered Contract is not named: it is not why this was refused,
		// and naming it would tell the Commissioner to drop a Player they could
		// have kept.
		expect(refusal.fantraxPlayerIds).toEqual(['p-00']);
		expect(eligibilityRefusalDetail(refusal)).not.toContain('r-00');
	});

	it('resolves an unknown id BEFORE the phase, so a ghost cannot slip past it', () => {
		// A ghost is neither pooled nor rostered, so the phase gate has nothing
		// to classify it as. Were the phase asked first, an unknown id would be
		// reported as a phase problem and survive a resubmission in Setup.
		const refusal = refuseEligibilityChange(
			{ phase: 'Auction', candidates: [], eligible: new Set<string>() },
			['ghost'],
			{ changes: [], unchanged: [], unknownIds: ['ghost'] }
		);
		expect(refusal?.kind).toBe('unknown_players');
	});

	it('refuses an empty selection ahead of both', () => {
		const refusal = refuseEligibilityChange(
			{ phase: 'Auction', candidates: [], eligible: new Set<string>() },
			[],
			{ changes: [], unchanged: [], unknownIds: ['ghost'] }
		);
		expect(refusal?.kind).toBe('empty_selection');
	});

	it('accepts a rostered Contract end to end with an AuctionOpened in the log', async () => {
		// The whole point of the narrowing, through the real transaction: the
		// event is appended and the pool column is rewritten without the
		// rostered id, which owns no row in it.
		const harness = fakeGateway({
			pool: poolOf(2),
			rosters: [{ id: 'r-00', name: 'Rostered Contract' }],
			events: [
				{
					seq: 1,
					occurred_at: new Date('2026-08-25T08:00:00.000Z'),
					schema_version: 1,
					core_version: 1,
					manager_id: 'm-1',
					team_id: 't-commissioner',
					event_type: 'AuctionOpened',
					payload: { teams: [] }
				}
			]
		});

		const result = await setEligibility(harness.gateway, ACTOR, ['r-00'], true);

		expect(result.outcome.kind).toBe('accepted');
		if (result.outcome.kind !== 'accepted') return;
		expect(result.outcome.events).toHaveLength(1);
		expect(result.outcome.events[0]?.payload as MinorLeagueEligibilitySetPayload).toEqual({
			fantraxPlayerId: 'r-00',
			playerName: 'Rostered Contract',
			before: false,
			after: true
		});
		expect(harness.order).toContain('append-event');
		expect(harness.order).toContain('commit');
		// The projection still runs and still writes the WHOLE pool from the
		// fold. `r-00` is in the fold and matches no pool row, so the column is
		// unchanged — the flag lives only in the log for a rostered Contract.
		expect(harness.order).toContain('apply-projection');
		expect(harness.state.column).toEqual([]);
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
	/**
	 * A table-aware fake PostgREST client. The list is now a union of three
	 * reads — the pool, the Rosters and `auction_events` for the half no column
	 * materialises — so a single `from()` stub would answer for all of them and
	 * prove nothing about which table produced which row.
	 */
	function fakeClient(
		rows: unknown[] | null,
		error: { message: string } | null = null,
		extras: {
			rosters?: unknown[];
			teams?: unknown[];
			events?: unknown[];
			rosterError?: { message: string };
			teamError?: { message: string };
		} = {}
	) {
		// Every read pages with `.range()`, so the fake serves slices and the
		// "PostgREST caps a page at 1,000 rows" case is reproducible here.
		const PAGE = 1000;
		const pageOf = (source: unknown[]) => (from: number, to: number) =>
			source.slice(from, Math.min(to + 1, from + PAGE));
		const range = vi.fn(async (from: number, to: number) => {
			if (error !== null) return { data: null, error };
			return { data: pageOf(rows ?? [])(from, to), error: null };
		});
		const order = vi.fn(() => ({ range }));
		const select = vi.fn(() => ({ order }));
		let eventsServed = false;

		const from = vi.fn((table: string) => {
			if (table === 'free_agent_players') return { select };
			if (table === 'team_rosters') {
				const rosterRange = vi.fn(async (from: number, to: number) => {
					if (extras.rosterError !== undefined) return { data: null, error: extras.rosterError };
					return { data: pageOf(extras.rosters ?? [])(from, to), error: null };
				});
				return { select: vi.fn(() => ({ order: vi.fn(() => ({ range: rosterRange })) })) };
			}
			if (table === 'teams') {
				const teamRange = vi.fn(async (from: number, to: number) => {
					if (extras.teamError !== undefined) return { data: null, error: extras.teamError };
					return { data: pageOf(extras.teams ?? [])(from, to), error: null };
				});
				return { select: vi.fn(() => ({ order: vi.fn(() => ({ range: teamRange })) })) };
			}
			if (table === 'auction_events') {
				// `loadAppendedEvents` pages until a read comes back empty, calling
				// `from()` afresh each page — so the served flag lives OUTSIDE this
				// branch. A flag scoped here would reset every page and never end.
				const range = vi.fn(async () => {
					if (eventsServed) return { data: [], error: null };
					eventsServed = true;
					return { data: extras.events ?? [], error: null };
				});
				return { select: vi.fn(() => ({ order: vi.fn(() => ({ range })) })) };
			}
			throw new Error(`unexpected table: ${table}`);
		});

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

		const pool = await loadEligibilityPool({ phase: 'Setup', client });

		expect(from).toHaveBeenCalledWith('free_agent_players');
		expect(select).toHaveBeenCalled();
		// Ordered by the unique id, not by name: paging needs a stable key, and
		// two Players can share a name. The NAME order the surface shows is the
		// explicit sort over the merged list, asserted below.
		expect(order).toHaveBeenCalledWith('fantrax_player_id', { ascending: true });
		// Pinned to the core's own output, so a second renderer cannot pass.
		const { eligibilityRowSentence } = await import('../../src/lib/core/rules/eligibility.ts');
		expect(pool.players[0]?.consequence).toBe(eligibilityRowSentence('Alice', true));
		expect(pool.players[1]?.consequence).toBe(eligibilityRowSentence('Bob', false));
		expect(pool.players[0]?.eligible).toBe(true);
		expect(pool.players[1]?.eligible).toBe(false);
	});

	it('returns an empty pool as an empty list, not an error — nothing is promoted yet', async () => {
		const { client } = fakeClient([]);
		expect((await loadEligibilityPool({ phase: 'Setup', client })).players).toEqual([]);
	});

	it('throws a descriptive error on a read failure', async () => {
		const { client } = fakeClient(null, { message: 'permission denied' });
		await expect(loadEligibilityPool({ phase: 'Setup', client })).rejects.toThrow(/permission denied/);
	});

	it('lists rostered Contracts alongside the pool, filed by name', async () => {
		const { client } = fakeClient(
			[
				{
					fantrax_player_id: 'p-1',
					player_name: 'Alice',
					positions: 'PG',
					nba_team: 'LAL',
					minor_league_eligible: false
				}
			],
			null,
			{
				rosters: [
					{
						fantrax_player_id: 'p-9',
						player_name: 'Bob',
						roster_slot_kind: 'active_bench',
						team_id: 'team-1'
					}
				],
				teams: [{ id: 'team-1', name: 'Utah Jazz' }]
			}
		);

		const pool = await loadEligibilityPool({ phase: 'Setup', client });

		// One merged list in name order, not the pool followed by a roster block.
		expect(pool.players.map((player) => player.playerName)).toEqual(['Alice', 'Bob']);
		expect(pool.players[1]?.detail).toBe('Active/Bench Slot');
		expect(pool.players[1]?.heldBy).toBe('Utah Jazz');
		expect(pool.players[0]?.detail).toBe('Positions: PG');
		expect(pool.players[0]?.heldBy).toBe('Free Agent pool · LAL');
	});

	it('folds the flag for a rostered Contract from the log, the only place it lives', async () => {
		const { client } = fakeClient([], null, {
			rosters: [
				{
					fantrax_player_id: 'p-9',
					player_name: 'Bob',
					roster_slot_kind: 'minor_league',
					team_id: 'team-1'
				}
			],
			teams: [{ id: 'team-1', name: 'Utah Jazz' }],
			events: [
				{
					seq: 1,
					occurred_at: '2026-08-25T08:00:00.000Z',
					schema_version: 1,
					core_version: 1,
					manager_id: 'm-1',
					team_id: 't-1',
					event_type: MINOR_LEAGUE_ELIGIBILITY_SET,
					payload: { fantraxPlayerId: 'p-9', playerName: 'Bob', before: false, after: true }
				}
			]
		});

		const pool = await loadEligibilityPool({ phase: 'Setup', client });

		// `team_rosters` has no `minor_league_eligible` column to read, so this
		// can only have come from the fold.
		expect(pool.players[0]?.eligible).toBe(true);
		const { eligibilityRowSentence } = await import('../../src/lib/core/rules/eligibility.ts');
		expect(pool.players[0]?.consequence).toBe(eligibilityRowSentence('Bob', true));
	});

	it('skips a rostered Contract the pool already names, so no Player is listed twice', async () => {
		const { client } = fakeClient(
			[
				{
					fantrax_player_id: 'p-1',
					player_name: 'Alice',
					positions: 'PG',
					nba_team: 'LAL',
					minor_league_eligible: true
				}
			],
			null,
			{
				rosters: [
					{
						fantrax_player_id: 'p-1',
						player_name: 'Alice',
						roster_slot_kind: 'active_bench',
						team_id: 'team-1'
					}
				],
				teams: [{ id: 'team-1', name: 'Utah Jazz' }]
			}
		);

		const pool = await loadEligibilityPool({ phase: 'Setup', client });

		expect(pool.players).toHaveLength(1);
		expect(pool.players[0]?.heldBy).toBe('Free Agent pool · LAL');
	});

	it('lists a pool larger than one PostgREST page, which a single select truncates', async () => {
		// The live pool is 1,467 Players and PostgREST caps a page at 1,000. The
		// unbounded select this replaced returned the first 1,000 with NO error,
		// so 467 Players never rendered and could not be ticked.
		const many = Array.from({ length: 1467 }, (_unused, index) => ({
			fantrax_player_id: `p-${String(index).padStart(4, '0')}`,
			player_name: `Player ${String(index).padStart(4, '0')}`,
			positions: 'PG',
			nba_team: 'LAL',
			minor_league_eligible: false
		}));
		const { client } = fakeClient(many);

		const pool = await loadEligibilityPool({ phase: 'Setup', client });

		expect(pool.players).toHaveLength(1467);
		expect(pool.players.at(-1)?.playerName).toBe('Player 1466');
	});

	it('throws a descriptive error when the Roster read fails', async () => {
		const { client } = fakeClient([], null, { rosterError: { message: 'roster denied' } });
		await expect(loadEligibilityPool({ phase: 'Setup', client })).rejects.toThrow(/team_rosters read failed/);
	});
});
