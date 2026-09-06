import { describe, expect, it } from 'vitest';

import { POOL_COLUMNS } from '../../src/lib/adapters/fantrax/pool-file.ts';
import { poolConflictRefusalDetail } from '../../src/lib/core/rules/pool-import.ts';
import {
	POOL_SOURCE_ID,
	poolAlreadySuppliedDetail,
	stagePoolFile
} from '../../src/lib/server/pool-import.ts';
import { poolShadowsTeamDetail } from '../../src/lib/server/pool-registry.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

/** Built from `POOL_COLUMNS`, never a hardcoded header string. */
const HEADER = Object.values(POOL_COLUMNS).join(',');

const POOL_CSV = [HEADER, 'P1,Alice,PG,LAL', 'P2,Bob,C,BOS'].join('\n');

const LAKERS = { id: 't-lakers', name: 'Lakers' };

/**
 * A stateful fake `ConnectionGateway` for `stagePoolFile`, in the style of
 * `shell-write.test.ts`'s `fakeGateway()` and `roster-import.test.ts`'s —
 * it records every query in order and answers exactly the statements
 * `stagePoolFile`/`writeOutcome` are known to issue, keeping the pool's
 * status in memory so two calls against the SAME gateway see each other's
 * writes the way two transactions against one real database would.
 */
function fakeGateway(options: {
	teams?: ReadonlyArray<{ id: string; name: string }>;
	/** Seeds the singleton `import_pool_source` status row. */
	poolStatus?: string;
	/** Staged roster rows: Fantrax Player ID -> { playerName, teamName }. */
	stagedRosters?: Record<string, { playerName: string; teamName: string }>;
} = {}): {
	gateway: ConnectionGateway;
	order: string[];
	deletes: number;
	insertedRows: QueryResultRow[];
	upsertedSources: QueryResultRow[];
	released: boolean[];
	counts: { deletes: number };
} {
	const teams = options.teams ?? [LAKERS];
	const stagedRosters = options.stagedRosters ?? {};
	const order: string[] = [];
	const insertedRows: QueryResultRow[] = [];
	const upsertedSources: QueryResultRow[] = [];
	const released: boolean[] = [];
	const counts = { deletes: 0 };
	let poolStatus: string | undefined = options.poolStatus;

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, params: readonly unknown[] = []) {
			const sql = text.trim();

			if (/^begin/i.test(sql)) {
				order.push('begin');
				return { rows: [] };
			}
			if (/^commit/i.test(sql)) {
				order.push('commit');
				return { rows: [] };
			}
			if (/^rollback/i.test(sql)) {
				order.push('rollback');
				return { rows: [] };
			}
			if (/^select id, name from teams/i.test(sql)) {
				order.push('select-teams');
				return { rows: teams.map((t) => ({ id: t.id, name: t.name })) };
			}
			if (/^select p\.player_name, t\.name/i.test(sql)) {
				order.push('select-roster-conflicts');
				const ids = (params[0] as string[]) ?? [];
				return {
					rows: ids
						.filter((id) => id in stagedRosters)
						.map((id) => ({
							player_name: stagedRosters[id]?.playerName,
							name: stagedRosters[id]?.teamName
						}))
				};
			}
			if (/^select status from import_pool_source/i.test(sql)) {
				order.push('select-status');
				return { rows: poolStatus === undefined ? [] : [{ status: poolStatus }] };
			}
			if (/^delete from import_staged_pool_players/i.test(sql)) {
				order.push('delete-rows');
				counts.deletes += 1;
				// The pool is one source: the delete carries no predicate at all.
				expect(params).toEqual([]);
				return { rows: [] };
			}
			if (/^insert into import_staged_pool_players/i.test(sql)) {
				// Batched: one statement per 500 Players, four bind parameters
				// each (Story 9.7). It was one statement per row until a real
				// ~1,470-Player pool took 65 seconds to stage against the hosted
				// database — on its own, against a 10-second function budget. The
				// params are unflattened here so the assertions below still read
				// one Player at a time.
				order.push('insert-rows');
				expect(params.length % 4, 'params do not divide into four-column rows').toBe(0);
				for (let at = 0; at < params.length; at += 4) {
					insertedRows.push({
						fantrax_player_id: params[at],
						player_name: params[at + 1],
						positions: params[at + 2],
						nba_team: params[at + 3]
					});
				}
				// Eligibility is never in the INSERT — it takes the column default.
				expect(sql).not.toMatch(/minor_league_eligible/i);
				return { rows: [] };
			}
			if (/^insert into import_pool_source/i.test(sql)) {
				order.push('upsert-status');
				upsertedSources.push({
					id: params[0],
					file_name: params[1],
					status: params[2],
					refusal_detail: params[3]
				});
				poolStatus = String(params[2]);
				return { rows: [] };
			}
			// Nothing here may ever touch a Team's staged rows or status.
			throw new Error(`fakeGateway: unexpected query: ${sql}`);
		},
		release() {
			released.push(true);
		}
	};

	return {
		gateway: { connect: async () => client },
		order,
		get deletes() {
			return counts.deletes;
		},
		insertedRows,
		upsertedSources,
		released,
		counts
	};
}

describe('stagePoolFile — the happy path', () => {
	it('parses, checks for conflicts, deletes+inserts+upserts, then commits', async () => {
		const fake = fakeGateway();

		const outcome = await stagePoolFile(fake.gateway, 'free-agents.csv', POOL_CSV);

		expect(outcome).toEqual({
			kind: 'staged',
			source: 'pool',
			fileName: 'free-agents.csv',
			rowCount: 2
		});
		expect(fake.order).toEqual([
			'begin',
			'select-teams',
			'select-roster-conflicts',
			'delete-rows',
			'insert-rows',
			'upsert-status',
			'commit'
		]);
		expect(fake.insertedRows).toEqual([
			{ fantrax_player_id: 'P1', player_name: 'Alice', positions: 'PG', nba_team: 'LAL' },
			{ fantrax_player_id: 'P2', player_name: 'Bob', positions: 'C', nba_team: 'BOS' }
		]);
		expect(fake.upsertedSources).toEqual([
			{
				id: POOL_SOURCE_ID,
				file_name: 'free-agents.csv',
				status: 'staged',
				refusal_detail: null
			}
		]);
		expect(fake.released).toEqual([true]);
	});

	it('reports the pool size for explicit confirmation', async () => {
		const rows = Array.from({ length: 7 }, (_, i) => `P${String(i)},Player ${String(i)},PG,LAL`);
		const fake = fakeGateway();
		const outcome = await stagePoolFile(fake.gateway, 'pool.csv', [HEADER, ...rows].join('\n'));
		expect(outcome).toMatchObject({ kind: 'staged', rowCount: 7 });
	});

	it('re-supply replaces the pool wholesale and touches no Team source', async () => {
		const fake = fakeGateway();
		await stagePoolFile(fake.gateway, 'pool.csv', POOL_CSV);
		const second = await stagePoolFile(
			fake.gateway,
			'pool-fixed.csv',
			[HEADER, 'P9,Zoe,SG,MIA'].join('\n')
		);

		expect(second).toMatchObject({ kind: 'staged', rowCount: 1 });
		expect(fake.counts.deletes).toBe(2);
		// The fake throws on any statement touching import_staged_rosters or
		// import_team_sources; reaching here proves none was issued.
		expect(fake.order.filter((step) => step === 'delete-rows')).toHaveLength(2);
	});

	it('claims the pool in the shared batch state', async () => {
		const fake = fakeGateway();
		const claimed = { claimed: false };
		await stagePoolFile(fake.gateway, 'pool.csv', POOL_CSV, claimed);
		expect(claimed.claimed).toBe(true);
	});
});

describe('stagePoolFile — file-altitude refusals write nothing', () => {
	it('refuses a second pool file in the same batch, naming the file', async () => {
		const fake = fakeGateway();
		const claimed = { claimed: true };

		const outcome = await stagePoolFile(fake.gateway, 'pool-2.csv', POOL_CSV, claimed);

		expect(outcome).toEqual({
			kind: 'refused_file',
			source: 'unknown',
			fileName: 'pool-2.csv',
			detail: poolAlreadySuppliedDetail('pool-2.csv')
		});
		expect(fake.order).toEqual(['begin', 'rollback']);
		expect(fake.upsertedSources).toEqual([]);
	});

	it('the first pool file stages; only the second in that drop is refused', async () => {
		const fake = fakeGateway();
		const claimed = { claimed: false };
		const first = await stagePoolFile(fake.gateway, 'pool.csv', POOL_CSV, claimed);
		expect(first.kind).toBe('staged');
		const second = await stagePoolFile(fake.gateway, 'pool-again.csv', POOL_CSV, claimed);
		expect(second.kind).toBe('refused_file');
	});

	it('refuses a name that would shadow a real Team, naming both, without writing anything', async () => {
		const fake = fakeGateway({ teams: [LAKERS, { id: 't-fa', name: 'Free Agents' }] });

		const outcome = await stagePoolFile(fake.gateway, 'Free Agents.csv', POOL_CSV);

		expect(outcome).toEqual({
			kind: 'refused_file',
			source: 'unknown',
			fileName: 'Free Agents.csv',
			detail: poolShadowsTeamDetail('Free Agents.csv', 'Free Agents')
		});
		expect(fake.order).toEqual(['begin', 'select-teams', 'rollback']);
	});

	it('does not spend the batch pool claim on a file it refuses at file altitude', async () => {
		// The claim is the drop's single "the pool has been supplied" token. A
		// shadowed name is not the pool -- it is a file that failed to name any
		// one source -- so claiming on its way out would make the GENUINE pool
		// file later in the same batch refuse as "already supplied", and the
		// pool would never stage at all (review-loop-iteration 1).
		const fake = fakeGateway({ teams: [LAKERS, { id: 't-fa', name: 'Free Agents' }] });
		const poolClaimed = { claimed: false };

		const shadowedOutcome = await stagePoolFile(
			fake.gateway,
			'Free Agents.csv',
			POOL_CSV,
			poolClaimed
		);

		expect(shadowedOutcome.kind).toBe('refused_file');
		expect(poolClaimed.claimed).toBe(false);

		// The real pool file, second in the same drop, must still stage.
		const realOutcome = await stagePoolFile(fake.gateway, 'pool.csv', POOL_CSV, poolClaimed);

		expect(realOutcome).toMatchObject({ kind: 'staged', source: 'pool', rowCount: 2 });
		expect(poolClaimed.claimed).toBe(true);
	});

});

describe('stagePoolFile — content-altitude refusals over an unstaged pool', () => {
	it('refuses a missing column, recording refused_content (nothing was staged to protect)', async () => {
		const fake = fakeGateway();
		const badCsv = `${POOL_COLUMNS.fantraxPlayerId},${POOL_COLUMNS.playerName}\nP1,Alice`;

		const outcome = await stagePoolFile(fake.gateway, 'pool.csv', badCsv);

		expect(outcome.kind).toBe('refused_content');
		expect(outcome.kind).toBe('refused_content');
		expect(outcome).toMatchObject({ source: 'pool' });
		if (outcome.kind !== 'refused_content') return;
		expect(outcome.detail).toContain(POOL_COLUMNS.positions);
		expect(fake.order).toEqual([
			'begin',
			'select-teams',
			'select-status',
			'delete-rows',
			'upsert-status',
			'commit'
		]);
		expect(fake.insertedRows).toEqual([]);
		expect(fake.upsertedSources).toEqual([
			{
				id: POOL_SOURCE_ID,
				file_name: 'pool.csv',
				status: 'refused_content',
				refusal_detail: outcome.detail
			}
		]);
	});

	it('refuses a blank cell, naming the row', async () => {
		const fake = fakeGateway();
		const outcome = await stagePoolFile(
			fake.gateway,
			'pool.csv',
			[HEADER, 'P1,Alice,PG,LAL', 'P2,,C,BOS'].join('\n')
		);
		expect(outcome.kind).toBe('refused_content');
		expect(outcome.kind).toBe('refused_content');
		expect(outcome).toMatchObject({ source: 'pool' });
		if (outcome.kind !== 'refused_content') return;
		expect(outcome.detail).toContain(POOL_COLUMNS.playerName);
	});

	it('refuses a duplicate Fantrax Player ID within the pool file', async () => {
		const fake = fakeGateway();
		const outcome = await stagePoolFile(
			fake.gateway,
			'pool.csv',
			[HEADER, 'P1,Alice,PG,LAL', 'P1,Alice Again,PG,LAL'].join('\n')
		);
		expect(outcome.kind).toBe('refused_content');
		expect(outcome.kind).toBe('refused_content');
		expect(outcome).toMatchObject({ source: 'pool' });
		if (outcome.kind !== 'refused_content') return;
		expect(outcome.detail).toContain('repeats');
	});
});

describe('stagePoolFile — the pool/roster conflict, pool-last direction', () => {
	it('refuses when a pool Player is already on a Team roster, naming the Player and the Team', async () => {
		const fake = fakeGateway({
			stagedRosters: { P2: { playerName: 'Bob', teamName: 'Lakers' } }
		});

		const outcome = await stagePoolFile(fake.gateway, 'pool.csv', POOL_CSV);

		expect(outcome.kind).toBe('refused_content');
		expect(outcome.kind).toBe('refused_content');
		expect(outcome).toMatchObject({ source: 'pool' });
		if (outcome.kind !== 'refused_content') return;
		expect(outcome.detail).toBe(
			poolConflictRefusalDetail([{ playerName: 'Bob', teamName: 'Lakers' }])
		);
		expect(outcome.detail).toContain('Bob');
		expect(outcome.detail).toContain('Lakers');
		// Nothing staged: the refusal path never inserted a row.
		expect(fake.insertedRows).toEqual([]);
	});

	it('stages when no pool Player appears on any Team roster', async () => {
		const fake = fakeGateway({
			stagedRosters: { P9: { playerName: 'Someone Else', teamName: 'Celtics' } }
		});
		const outcome = await stagePoolFile(fake.gateway, 'pool.csv', POOL_CSV);
		expect(outcome.kind).toBe('staged');
	});
});

describe('stagePoolFile — a refused re-supply over a staged pool leaves it untouched', () => {
	it('writes nothing at all when the pool is already staged and the new file is invalid', async () => {
		const fake = fakeGateway({ poolStatus: 'staged' });
		const badCsv = `${POOL_COLUMNS.fantraxPlayerId},${POOL_COLUMNS.playerName}\nP1,Alice`;

		const outcome = await stagePoolFile(fake.gateway, 'pool-bad.csv', badCsv);

		// The refusal is still reported to the caller...
		expect(outcome.kind).toBe('refused_content');
		// ...but the database is untouched: no delete, no insert, no upsert.
		expect(fake.order).toEqual(['begin', 'select-teams', 'select-status', 'commit']);
		expect(fake.counts.deletes).toBe(0);
		expect(fake.insertedRows).toEqual([]);
		expect(fake.upsertedSources).toEqual([]);
	});

	it('records the refusal when the pool was previously refused rather than staged', async () => {
		const fake = fakeGateway({ poolStatus: 'refused_content' });
		const badCsv = `${POOL_COLUMNS.fantraxPlayerId},${POOL_COLUMNS.playerName}\nP1,Alice`;

		const outcome = await stagePoolFile(fake.gateway, 'pool.csv', badCsv);

		expect(outcome.kind).toBe('refused_content');
		expect(fake.upsertedSources).toHaveLength(1);
	});

	it('a valid re-supply over a staged pool always replaces its rows', async () => {
		const fake = fakeGateway({ poolStatus: 'staged' });
		const outcome = await stagePoolFile(fake.gateway, 'pool-fixed.csv', POOL_CSV);
		expect(outcome.kind).toBe('staged');
		expect(fake.counts.deletes).toBe(1);
		expect(fake.insertedRows).toHaveLength(2);
	});
});

describe('stagePoolFile — failure handling', () => {
	it('rolls back, releases the connection, and rethrows when a query throws', async () => {
		const released: boolean[] = [];
		const order: string[] = [];
		const client: TransactionalClient & { release(): void } = {
			async query(text: string) {
				const sql = text.trim();
				order.push(sql.split(/\s+/)[0] ?? '');
				if (/^begin/i.test(sql)) return { rows: [] };
				if (/^rollback/i.test(sql)) return { rows: [] };
				throw new Error('connection reset');
			},
			release() {
				released.push(true);
			}
		};

		await expect(
			stagePoolFile({ connect: async () => client }, 'pool.csv', POOL_CSV)
		).rejects.toThrow(/connection reset/);
		expect(order).toContain('rollback');
		expect(released).toEqual([true]);
	});
});
