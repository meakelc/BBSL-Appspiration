import { describe, expect, it } from 'vitest';

import { ACTIVE_BENCH_SLOTS } from '../../src/lib/core/constants.ts';
import { promotionRefusalDetail } from '../../src/lib/core/rules/import-preview.ts';
import { POOL_SOURCE_LABEL } from '../../src/lib/core/rules/pool-import.ts';
import {
	IMPORT_PROMOTED_EVENT,
	promoteImport
} from '../../src/lib/server/import-promotion.ts';
import type {
	ImportPromotedPayload,
	PromotionRejection
} from '../../src/lib/server/import-promotion.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

const ACTOR = { managerId: 'm-1', teamId: 't-commissioner' };

type StagedRoster = {
	teamId: string;
	fantraxPlayerId: string;
	playerName?: string;
	capHit?: number;
	slotKind?: string;
	years?: number;
};

type Team = { id: string; name: string; status: string | null };

/**
 * A stateful fake `ConnectionGateway` for `promoteImport`, in the style of
 * `shell-write.test.ts`'s and `pool-import.test.ts`'s: it records every
 * statement in order and answers exactly the ones the promotion transaction
 * is known to issue, keeping the live tables in memory so "nothing was
 * written on a rejection" and "everything rolled back on a throw" are both
 * observable rather than assumed.
 */
function fakeGateway(options: {
	teams?: Team[];
	rosters?: StagedRoster[];
	poolStatus?: string | null;
	pool?: Array<{ id: string; name?: string; positions?: string; nbaTeam?: string; eligible?: boolean }>;
	events?: QueryResultRow[];
	/** When set, the first statement matching this pattern throws. */
	throwOn?: RegExp;
	/** Seeds the live tables, as a previous promotion would have left them. */
	liveRosters?: QueryResultRow[];
	liveFreeAgents?: QueryResultRow[];
}) {
	const teams = options.teams ?? [];
	const rosters = options.rosters ?? [];
	const pool = options.pool ?? [];
	const order: string[] = [];
	const live = {
		rosters: [...(options.liveRosters ?? [])] as QueryResultRow[],
		freeAgents: [...(options.liveFreeAgents ?? [])] as QueryResultRow[]
	};
	const appendedEvents: QueryResultRow[] = [];
	let seq = 10;
	let released = 0;
	let committed = false;

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, params: readonly unknown[] = []) {
			const sql = text.trim();
			if (options.throwOn !== undefined && options.throwOn.test(sql)) {
				order.push('throw');
				throw new Error('insert failed partway through promotion');
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
			if (/^select t\.id, t\.name, s\.status/i.test(sql)) {
				order.push('read-team-sources');
				return { rows: teams.map((team) => ({ id: team.id, name: team.name, status: team.status })) };
			}
			if (/from import_staged_rosters/i.test(sql)) {
				order.push('read-staged-rosters');
				return {
					rows: rosters.map((row) => ({
						team_id: row.teamId,
						fantrax_player_id: row.fantraxPlayerId,
						player_name: row.playerName ?? 'Alice',
						cap_hit: String(row.capHit ?? 1_000_000),
						roster_slot_kind: row.slotKind ?? 'active_bench',
						contract_years_remaining: row.years ?? 1
					}))
				};
			}
			if (/^select status from import_pool_source/i.test(sql)) {
				order.push('read-pool-status');
				return {
					rows:
						options.poolStatus === undefined || options.poolStatus === null
							? []
							: [{ status: options.poolStatus }]
				};
			}
			if (/from import_staged_pool_players/i.test(sql)) {
				order.push('read-staged-pool');
				return {
					rows: pool.map((player) => ({
						fantrax_player_id: player.id,
						player_name: player.name ?? 'Bob',
						positions: player.positions ?? 'PG',
						nba_team: player.nbaTeam ?? 'LAL',
						minor_league_eligible: player.eligible ?? false
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
			if (/^delete from team_rosters/i.test(sql)) {
				order.push('delete-live-rosters');
				// No predicate: the replacement is wholesale by construction.
				expect(params).toEqual([]);
				live.rosters = [];
				return { rows: [] };
			}
			if (/^delete from free_agent_players/i.test(sql)) {
				order.push('delete-live-pool');
				expect(params).toEqual([]);
				live.freeAgents = [];
				return { rows: [] };
			}
			if (/^insert into team_rosters/i.test(sql)) {
				order.push('insert-live-roster');
				live.rosters.push({
					team_id: params[0],
					fantrax_player_id: params[1],
					player_name: params[2],
					cap_hit: params[3],
					roster_slot_kind: params[4],
					contract_years_remaining: params[5]
				});
				return { rows: [] };
			}
			if (/^insert into free_agent_players/i.test(sql)) {
				order.push('insert-live-free-agent');
				live.freeAgents.push({
					fantrax_player_id: params[0],
					player_name: params[1],
					positions: params[2],
					nba_team: params[3],
					minor_league_eligible: params[4]
				});
				return { rows: [] };
			}
			if (/^commit/i.test(sql)) {
				order.push('commit');
				committed = true;
				return { rows: [] };
			}
			if (/^rollback/i.test(sql)) {
				order.push('rollback');
				// A real ROLLBACK discards every uncommitted write; the fake must
				// too, or "nothing was written" would be trivially true.
				live.rosters = [...(options.liveRosters ?? [])];
				live.freeAgents = [...(options.liveFreeAgents ?? [])];
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
		live,
		appendedEvents,
		state: {
			get released() {
				return released;
			},
			get committed() {
				return committed;
			}
		}
	};
}

/** Thirty Teams, every one staged, as the happy path requires. */
function thirtyTeams(overrides: Partial<Team> = {}): Team[] {
	return Array.from({ length: 30 }, (_unused, index) => ({
		id: `t-${index}`,
		name: `Team ${String(index).padStart(2, '0')}`,
		status: 'staged',
		...overrides
	}));
}

function rosterFor(teams: Team[], rowsPerTeam = 2): StagedRoster[] {
	return teams.flatMap((team) =>
		Array.from({ length: rowsPerTeam }, (_unused, index) => ({
			teamId: team.id,
			fantraxPlayerId: `${team.id}-p${index}`
		}))
	);
}

function rejectionOf(outcome: { kind: string; reason?: unknown }): PromotionRejection {
	expect(outcome.kind).toBe('rejected');
	return outcome.reason as PromotionRejection;
}

describe('promoteImport — the happy path', () => {
	it('commits all thirty-one sources and appends exactly one ImportPromoted event', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({
			teams,
			rosters: rosterFor(teams),
			poolStatus: 'staged',
			pool: [{ id: 'fa-1' }, { id: 'fa-2' }, { id: 'fa-3' }]
		});

		const outcome = await promoteImport(harness.gateway, ACTOR);

		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;
		expect(outcome.events).toHaveLength(1);
		const event = outcome.events[0];
		expect(event?.type).toBe(IMPORT_PROMOTED_EVENT);
		expect(event?.managerId).toBe(ACTOR.managerId);
		expect(event?.teamId).toBe(ACTOR.teamId);
		expect(event?.occurredAt).toBe('2026-08-25T09:00:00.000Z');
		// schemaVersion/coreVersion are columns the pipeline fills; the point is
		// they are present on the appended event, not what they equal.
		expect(typeof event?.schemaVersion).toBe('number');
		expect(typeof event?.coreVersion).toBe('number');

		const payload = event?.payload as ImportPromotedPayload;
		expect(payload.poolSize).toBe(3);
		expect(payload.teams).toHaveLength(30);
		expect(payload.teams[0]).toEqual({ teamId: 't-0', teamName: 'Team 00', rosterCount: 2 });

		expect(harness.live.rosters).toHaveLength(60);
		expect(harness.live.freeAgents).toHaveLength(3);
		expect(harness.state.committed).toBe(true);
		expect(harness.state.released).toBe(1);
	});

	it('takes the lock before it reads anything, and writes live rows inside the same transaction', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({
			teams,
			rosters: rosterFor(teams, 1),
			poolStatus: 'staged',
			pool: [{ id: 'fa-1' }]
		});

		await promoteImport(harness.gateway, ACTOR);

		expect(harness.order[0]).toBe('begin');
		expect(harness.order[1]).toBe('lock');
		expect(harness.order[2]).toBe('read-log');
		// The event and both live tables are written after the lock and before
		// the single COMMIT — one transaction, all thirty-one sources.
		const commitIndex = harness.order.indexOf('commit');
		expect(harness.order.lastIndexOf('insert-live-roster')).toBeLessThan(commitIndex);
		expect(harness.order.lastIndexOf('insert-live-free-agent')).toBeLessThan(commitIndex);
		expect(harness.order.indexOf('append-event')).toBeLessThan(commitIndex);
		expect(harness.order.filter((step) => step === 'commit')).toHaveLength(1);
	});

	it('carries the staged Minor League Eligibility across untouched, never deriving it', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({
			teams,
			rosters: rosterFor(teams, 1),
			poolStatus: 'staged',
			pool: [
				{ id: 'fa-1', eligible: false },
				{ id: 'fa-2', eligible: true }
			]
		});

		await promoteImport(harness.gateway, ACTOR);

		expect(harness.live.freeAgents.map((row) => row['minor_league_eligible'])).toEqual([
			false,
			true
		]);
	});

	it('replaces live state entirely on a re-import during Setup', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({
			teams,
			rosters: rosterFor(teams, 1),
			poolStatus: 'staged',
			pool: [{ id: 'fa-new' }],
			liveRosters: [{ fantrax_player_id: 'stale-1' }],
			liveFreeAgents: [{ fantrax_player_id: 'stale-fa' }],
			// A previous ImportPromoted event does not move the phase off Setup.
			events: [
				{
					seq: 1,
					occurred_at: new Date('2026-08-25T08:00:00.000Z'),
					schema_version: 1,
					core_version: 1,
					manager_id: 'm-1',
					team_id: 't-commissioner',
					event_type: IMPORT_PROMOTED_EVENT,
					payload: {}
				}
			]
		});

		const outcome = await promoteImport(harness.gateway, ACTOR);

		expect(outcome.kind).toBe('accepted');
		expect(harness.order.indexOf('delete-live-rosters')).toBeLessThan(
			harness.order.indexOf('insert-live-roster')
		);
		expect(harness.live.rosters.map((row) => row['fantrax_player_id'])).not.toContain('stale-1');
		expect(harness.live.freeAgents.map((row) => row['fantrax_player_id'])).toEqual(['fa-new']);
		// A second event, appended — the first is not amended.
		expect(harness.appendedEvents).toHaveLength(1);
	});
});

describe('promoteImport — the refusals, every one re-derived inside the transaction', () => {
	it('refuses when a source is missing, naming every outstanding one', async () => {
		const teams = thirtyTeams();
		teams[3] = { ...teams[3]!, status: null };
		teams[7] = { ...teams[7]!, status: 'refused_content' };
		const harness = fakeGateway({ teams, rosters: [], poolStatus: 'staged' });

		const outcome = await promoteImport(harness.gateway, ACTOR);

		const rejection = rejectionOf(outcome);
		expect(rejection.refusal.kind).toBe('outstanding');
		if (rejection.refusal.kind !== 'outstanding') return;
		expect(rejection.refusal.sourceNames).toEqual(['Team 03', 'Team 07']);
		expect(rejection.detail).toContain('Team 03');
		expect(rejection.detail).toContain('Team 07');
		expect(rejection.detail).toBe(promotionRefusalDetail(rejection.refusal));
	});

	it('names the Free Agent pool when it alone is outstanding', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({ teams, rosters: rosterFor(teams, 1), poolStatus: null });

		const rejection = rejectionOf(await promoteImport(harness.gateway, ACTOR));
		expect(rejection.refusal.kind).toBe('outstanding');
		if (rejection.refusal.kind !== 'outstanding') return;
		expect(rejection.refusal.sourceNames).toEqual([POOL_SOURCE_LABEL]);
	});

	it('refuses a slot-ceiling breach, naming the Team and stating the arithmetic', async () => {
		const teams = thirtyTeams();
		const rosters = rosterFor(teams, 1);
		for (let index = 0; index < ACTIVE_BENCH_SLOTS; index += 1) {
			rosters.push({ teamId: 't-5', fantraxPlayerId: `t-5-extra-${index}` });
		}
		const harness = fakeGateway({ teams, rosters, poolStatus: 'staged', pool: [{ id: 'fa-1' }] });

		const rejection = rejectionOf(await promoteImport(harness.gateway, ACTOR));
		expect(rejection.refusal.kind).toBe('breach');
		if (rejection.refusal.kind !== 'breach') return;
		expect(rejection.refusal.teams).toEqual([
			{
				teamName: 'Team 05',
				breaches: [
					{ slotKind: 'active_bench', count: ACTIVE_BENCH_SLOTS + 1, ceiling: ACTIVE_BENCH_SLOTS }
				]
			}
		]);
		expect(rejection.detail).toContain('Team 05');
		expect(rejection.detail).toContain(`${String(ACTIVE_BENCH_SLOTS + 1)} rows exceeds the ceiling`);
	});

	it('folds the phase from the log inside the transaction, before it reads any staging', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({
			teams,
			rosters: rosterFor(teams, 1),
			poolStatus: 'staged',
			pool: [{ id: 'fa-1' }],
			events: [
				{
					seq: 1,
					occurred_at: new Date('2026-08-25T08:00:00.000Z'),
					schema_version: 1,
					core_version: 1,
					manager_id: 'm-1',
					team_id: 't-1',
					event_type: 'AuctionOpened',
					payload: {}
				}
			]
		});

		// The phase reducer has no AuctionOpened case yet (Story 1.11 adds it),
		// so this log still folds to Setup — the assertion that matters here is
		// that the log IS read inside the transaction, before anything is
		// decided, rather than `locals.phase` being trusted.
		await promoteImport(harness.gateway, ACTOR);
		expect(harness.order.indexOf('read-log')).toBeLessThan(
			harness.order.indexOf('read-team-sources')
		);
	});

	it('writes no live row and appends no event on any rejection', async () => {
		const teams = thirtyTeams();
		teams[0] = { ...teams[0]!, status: null };
		const harness = fakeGateway({
			teams,
			rosters: rosterFor(teams, 1),
			poolStatus: 'staged',
			pool: [{ id: 'fa-1' }],
			liveRosters: [{ fantrax_player_id: 'previous' }]
		});

		const outcome = await promoteImport(harness.gateway, ACTOR);

		expect(outcome.kind).toBe('rejected');
		expect(harness.order).not.toContain('append-event');
		expect(harness.order).not.toContain('delete-live-rosters');
		expect(harness.order).not.toContain('insert-live-roster');
		expect(harness.order).not.toContain('insert-live-free-agent');
		expect(harness.order).toContain('rollback');
		expect(harness.order).not.toContain('commit');
		// The previous promotion's live rows are exactly as they were.
		expect(harness.live.rosters).toEqual([{ fantrax_player_id: 'previous' }]);
		expect(harness.state.released).toBe(1);
	});

	it('refuses on the phase before it complains about staging', async () => {
		// Nothing is staged AND the log is non-empty: the honest answer is about
		// the phase, not a list of files. The ordering is asserted through
		// `refusePromotion` in the module rather than inferred.
		const { refusePromotion } = await import('../../src/lib/server/import-promotion.ts');
		const refusal = refusePromotion({
			phase: 'Auction',
			teams: [{ teamId: 't-1', teamName: 'Lakers', status: null, rows: [] }],
			poolStatus: null,
			poolPlayers: []
		});
		expect(refusal?.kind).toBe('phase');
	});
});

describe('promoteImport — corrupted staged data', () => {
	it('throws and rolls back on a staged row whose slot kind is unrecognised', async () => {
		// Dropping the row would understate a Cap Hit total and hide a ceiling
		// breach, so `toParsedRosterRow` throws (AD-1) and the throw rolls the
		// whole promotion back. `tests/server/import-preview.test.ts` covers the
		// same guard on the read path; the write path needs its own coverage,
		// because this is the one where a silent miscount would be COMMITTED.
		const teams = thirtyTeams();
		const rosters = rosterFor(teams, 1);
		rosters[0] = { ...rosters[0], slotKind: 'taxi_squad' } as (typeof rosters)[number];
		const harness = fakeGateway({
			teams,
			rosters,
			poolStatus: 'staged',
			pool: [{ id: 'fa-1' }],
			liveRosters: [{ fantrax_player_id: 'previous' }],
			liveFreeAgents: [{ fantrax_player_id: 'previous-fa' }]
		});

		await expect(promoteImport(harness.gateway, ACTOR)).rejects.toThrow(/not a known slot kind/);

		expect(harness.order).toContain('rollback');
		expect(harness.order).not.toContain('commit');
		expect(harness.live.rosters).toEqual([{ fantrax_player_id: 'previous' }]);
		expect(harness.live.freeAgents).toEqual([{ fantrax_player_id: 'previous-fa' }]);
		expect(harness.appendedEvents).toEqual([]);
	});
});

describe('promoteImport — a failure mid-promotion', () => {
	it('rolls the whole transaction back and rethrows, leaving live tables unchanged', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({
			teams,
			rosters: rosterFor(teams, 1),
			poolStatus: 'staged',
			pool: [{ id: 'fa-1' }],
			liveRosters: [{ fantrax_player_id: 'previous' }],
			liveFreeAgents: [{ fantrax_player_id: 'previous-fa' }],
			// The shape a duplicate `fantrax_player_id` across two Teams takes:
			// the live table's unique constraint aborts the insert partway.
			throwOn: /^insert into team_rosters/i
		});

		await expect(promoteImport(harness.gateway, ACTOR)).rejects.toThrow(/insert failed partway/);

		expect(harness.order).toContain('rollback');
		expect(harness.order).not.toContain('commit');
		expect(harness.live.rosters).toEqual([{ fantrax_player_id: 'previous' }]);
		expect(harness.live.freeAgents).toEqual([{ fantrax_player_id: 'previous-fa' }]);
		expect(harness.appendedEvents).toEqual([]);
		expect(harness.state.released).toBe(1);
	});
});
