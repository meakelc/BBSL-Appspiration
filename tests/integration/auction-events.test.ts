import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { GLOBAL_WRITE_LOCK_KEY } from '../../src/lib/core/constants.ts';
import { writeGateway, writePool } from '../../src/lib/shell/db.ts';
import { runTransactionalWrite } from '../../src/lib/shell/write.ts';
import type { Decision } from '../../src/lib/shell/write.ts';

/**
 * The two real-Postgres proofs this story's AC requires: that no role,
 * including `service_role`, holds UPDATE or DELETE on `auction_events`
 * (AC1), and that two concurrent writers serialize on the global advisory
 * lock rather than both proceeding (the concurrency AC). Every DB-touching
 * test before this story stubbed the client — these are the first to run
 * against a real local Postgres, via `supabase start`.
 *
 * `describe.skipIf`-guarded on a reachability probe, so `npm test` without
 * Docker skips visibly (the block's own title states the reason) rather than
 * failing or silently passing. CI always has Docker and runs `supabase
 * start` before `npm test` (.github/workflows/ci.yml); a local machine
 * without Docker running gets a skipped block instead of a red suite.
 */

const LOCAL_DB_URL =
	process.env['SUPABASE_DB_URL'] ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/** Is a local Postgres actually reachable at LOCAL_DB_URL right now? */
async function isLocalPostgresReachable(): Promise<boolean> {
	const client = new Client({ connectionString: LOCAL_DB_URL, connectionTimeoutMillis: 1500 });
	try {
		await client.connect();
		await client.query('select 1');
		return true;
	} catch {
		return false;
	} finally {
		await client.end().catch(() => {
			/* nothing to clean up if connect() itself failed */
		});
	}
}

const reachable = await isLocalPostgresReachable();

const SUITE_TITLE = reachable
	? 'auction_events, against real Postgres'
	: 'auction_events, against real Postgres — SKIPPED: no local Postgres reachable at ' +
		`${LOCAL_DB_URL}. Run "npx supabase start" first.`;

describe.skipIf(!reachable)(SUITE_TITLE, () => {
	let owner: Client;
	let managerId: string;
	let teamId: string;

	beforeAll(async () => {
		owner = new Client({ connectionString: LOCAL_DB_URL });
		await owner.connect();

		// Fixture rows this suite's own inserts reference. Postgres' local
		// `postgres` role is a superuser, so this insert bypasses the
		// zero-policy RLS on managers/teams the way only a superuser can — the
		// same reason it can freely clean up after itself in afterAll.
		const manager = await owner.query<{ id: string }>(
			`insert into public.managers (discord_user_id, display_name)
			 values ($1, 'Story 1.5 integration fixture')
			 returning id`,
			[`story-1-5-fixture-${Date.now()}`]
		);
		managerId = manager.rows[0]?.id ?? (() => {
			throw new Error('fixture manager insert returned no row');
		})();

		const team = await owner.query<{ id: string }>(
			`insert into public.teams (name) values ($1) returning id`,
			[`Story 1.5 Fixture Team ${Date.now()}`]
		);
		teamId = team.rows[0]?.id ?? (() => {
			throw new Error('fixture team insert returned no row');
		})();
	});

	afterAll(async () => {
		await owner.query('delete from public.auction_events where manager_id = $1', [managerId]);
		await owner.query('delete from public.managers where id = $1', [managerId]);
		await owner.query('delete from public.teams where id = $1', [teamId]);
		await owner.end();
	});

	describe('AC1 — no role holds UPDATE or DELETE, including service_role', () => {
		it('denies UPDATE to service_role', async () => {
			const client = new Client({ connectionString: LOCAL_DB_URL });
			await client.connect();
			try {
				await client.query('begin');
				await client.query('set local role service_role');
				await expect(
					client.query("update public.auction_events set event_type = 'x' where seq = -1")
				).rejects.toThrow(/permission denied/i);
			} finally {
				await client.query('rollback').catch(() => {});
				await client.end();
			}
		});

		it('denies DELETE to service_role', async () => {
			const client = new Client({ connectionString: LOCAL_DB_URL });
			await client.connect();
			try {
				await client.query('begin');
				await client.query('set local role service_role');
				await expect(
					client.query('delete from public.auction_events where seq = -1')
				).rejects.toThrow(/permission denied/i);
			} finally {
				await client.query('rollback').catch(() => {});
				await client.end();
			}
		});

		it('still permits service_role to SELECT and INSERT — the revoke is narrow, not total', async () => {
			const client = new Client({ connectionString: LOCAL_DB_URL });
			await client.connect();
			try {
				await client.query('begin');
				await client.query('set local role service_role');
				await expect(client.query('select count(*) from public.auction_events')).resolves.toBeDefined();
				await expect(
					client.query(
						`insert into public.auction_events
							(occurred_at, schema_version, core_version, manager_id, team_id, event_type, payload)
						 values (now(), 1, 1, $1, $2, 'IntegrationProbe', '{}'::jsonb)`,
						[managerId, teamId]
					)
				).resolves.toBeDefined();
			} finally {
				// Rolled back, not committed — this test proves the grant exists,
				// not that the row should survive the suite.
				await client.query('rollback').catch(() => {});
				await client.end();
			}
		});

		it('denies anon and authenticated everything: SELECT, INSERT, UPDATE, DELETE', async () => {
			// "fully revoked" (the Boundaries' own word) means all four verbs, not
			// just the one this test happened to check before. Each attempt gets
			// its own client/transaction: a role's permission-denied error aborts
			// the enclosing transaction, so a second statement in the same
			// transaction would fail with "current transaction is aborted" rather
			// than proving anything about that statement's own grant.
			const attempts: ReadonlyArray<{ label: string; run: (c: Client) => Promise<unknown> }> = [
				{ label: 'select', run: (c) => c.query('select count(*) from public.auction_events') },
				{
					label: 'insert',
					run: (c) =>
						c.query(
							`insert into public.auction_events
								(occurred_at, schema_version, core_version, manager_id, team_id, event_type, payload)
							 values (now(), 1, 1, $1, $2, 'DenialProbe', '{}'::jsonb)`,
							[managerId, teamId]
						)
				},
				{
					label: 'update',
					run: (c) => c.query("update public.auction_events set event_type = 'x' where seq = -1")
				},
				{
					label: 'delete',
					run: (c) => c.query('delete from public.auction_events where seq = -1')
				}
			];

			for (const role of ['anon', 'authenticated']) {
				for (const attempt of attempts) {
					const client = new Client({ connectionString: LOCAL_DB_URL });
					await client.connect();
					try {
						await client.query('begin');
						await client.query(`set local role ${role}`);
						await expect(
							attempt.run(client),
							`${role} should be denied ${attempt.label}`
						).rejects.toThrow(/permission denied/i);
					} finally {
						await client.query('rollback').catch(() => {});
						await client.end();
					}
				}
			}
		});
	});

	describe('AC2 — every row carries the required fields from the first row onward', () => {
		it('assigns seq, occurred_at, schema_version and core_version, and leaves the measurement fields null', async () => {
			const client = new Client({ connectionString: LOCAL_DB_URL });
			await client.connect();
			try {
				await client.query('begin');
				const result = await client.query(
					`insert into public.auction_events
						(occurred_at, schema_version, core_version, manager_id, team_id, event_type, payload)
					 values (now(), 1, 1, $1, $2, 'IntegrationProbe', '{"note":"ac2"}'::jsonb)
					 returning seq, occurred_at, schema_version, core_version, manager_id, team_id,
						device_class, dispatch_outcome, delivery_outcome`,
					[managerId, teamId]
				);
				const row = result.rows[0] as
					| {
							seq: string;
							occurred_at: Date;
							schema_version: number;
							core_version: number;
							manager_id: string;
							team_id: string;
							device_class: string | null;
							dispatch_outcome: string | null;
							delivery_outcome: string | null;
					  }
					| undefined;

				expect(row).toBeDefined();
				expect(typeof row?.seq).toBe('string');
				expect(BigInt(row?.seq ?? '0')).toBeGreaterThan(0n);
				expect(row?.occurred_at).toBeInstanceOf(Date);
				expect(row?.schema_version).toBe(1);
				expect(row?.core_version).toBe(1);
				expect(row?.manager_id).toBe(managerId);
				expect(row?.team_id).toBe(teamId);
				expect(row?.device_class).toBeNull();
				expect(row?.dispatch_outcome).toBeNull();
				expect(row?.delivery_outcome).toBeNull();
			} finally {
				await client.query('rollback').catch(() => {});
				await client.end();
			}
		});
	});

	describe('the auction_events_event_type_not_blank check constraint', () => {
		it('rejects an empty event_type', async () => {
			const client = new Client({ connectionString: LOCAL_DB_URL });
			await client.connect();
			try {
				await client.query('begin');
				await expect(
					client.query(
						`insert into public.auction_events
							(occurred_at, schema_version, core_version, manager_id, team_id, event_type, payload)
						 values (now(), 1, 1, $1, $2, '', '{}'::jsonb)`,
						[managerId, teamId]
					)
				).rejects.toThrow(/violates check constraint/i);
			} finally {
				await client.query('rollback').catch(() => {});
				await client.end();
			}
		});

		it('rejects a whitespace-only event_type', async () => {
			const client = new Client({ connectionString: LOCAL_DB_URL });
			await client.connect();
			try {
				await client.query('begin');
				await expect(
					client.query(
						`insert into public.auction_events
							(occurred_at, schema_version, core_version, manager_id, team_id, event_type, payload)
						 values (now(), 1, 1, $1, $2, '   ', '{}'::jsonb)`,
						[managerId, teamId]
					)
				).rejects.toThrow(/violates check constraint/i);
			} finally {
				await client.query('rollback').catch(() => {});
				await client.end();
			}
		});
	});

	describe('the concurrency AC — two writers race the global advisory lock', () => {
		it('serializes: the second writer does not proceed until the first writer’s transaction ends', async () => {
			const first = new Client({ connectionString: LOCAL_DB_URL });
			const second = new Client({ connectionString: LOCAL_DB_URL });
			await first.connect();
			await second.connect();

			try {
				await first.query('begin');
				await first.query('select pg_advisory_xact_lock($1::bigint)', [
					GLOBAL_WRITE_LOCK_KEY.toString()
				]);

				let secondAcquired = false;
				const secondAttempt = (async () => {
					await second.query('begin');
					await second.query('select pg_advisory_xact_lock($1::bigint)', [
						GLOBAL_WRITE_LOCK_KEY.toString()
					]);
					secondAcquired = true;
					await second.query('commit');
				})();

				// Give the second writer a real chance to attempt and block. It is
				// still possible in principle for it to win a race before this
				// check — the assertion after `first` commits is the load-bearing
				// one; this is the "it actually blocked" signal.
				await new Promise((resolve) => setTimeout(resolve, 300));
				expect(secondAcquired).toBe(false);

				await first.query('commit');
				await secondAttempt;
				expect(secondAcquired).toBe(true);
			} finally {
				await first.end();
				await second.end();
			}
		});

		it('lets the second writer load state the first writer’s now-committed transaction wrote', async () => {
			const first = new Client({ connectionString: LOCAL_DB_URL });
			const second = new Client({ connectionString: LOCAL_DB_URL });
			await first.connect();
			await second.connect();

			try {
				await first.query('begin');
				await first.query('select pg_advisory_xact_lock($1::bigint)', [
					GLOBAL_WRITE_LOCK_KEY.toString()
				]);
				const inserted = await first.query(
					`insert into public.auction_events
						(occurred_at, schema_version, core_version, manager_id, team_id, event_type, payload)
					 values (now(), 1, 1, $1, $2, 'ConcurrencyProbe', '{}'::jsonb)
					 returning seq`,
					[managerId, teamId]
				);
				const firstSeq = String((inserted.rows[0] as { seq: string }).seq);

				const secondSaw = (async () => {
					await second.query('begin');
					await second.query('select pg_advisory_xact_lock($1::bigint)', [
						GLOBAL_WRITE_LOCK_KEY.toString()
					]);
					const loaded = await second.query(
						'select seq from public.auction_events where seq = $1',
						[firstSeq]
					);
					await second.query('rollback');
					return loaded.rows.length;
				})();

				await first.query('commit');
				await expect(secondSaw).resolves.toBe(1);
			} finally {
				await first.end();
				await second.end();
			}
		});
	});

	// Every other proof in this file drives raw `pg.Client` calls against
	// hand-written SQL text of its own — deliberately, per this story's Design
	// Notes, since no domain `decide()` exists yet for the lock-serialization
	// proof to drive. But that means `write.ts`'s actual `INSERT_EVENT_SQL` /
	// `LOCK_AND_CLOCK_SQL` and `db.ts`'s `writePool()`/`writeGateway()` had
	// never once executed against a real database: a real syntax error, wrong
	// column name, or param-count mismatch in either file would pass every
	// other test in this repository and only surface the first time a real
	// caller used it. This block closes that gap by driving the real
	// `runTransactionalWrite` through the real `writeGateway()` — the same
	// functions a route handler would call — end to end against Postgres.
	describe('the real transactional shell — runTransactionalWrite() through writeGateway()', () => {
		afterAll(async () => {
			// `writePool()` is a module-level singleton (one pool per process);
			// end it explicitly so the pool's open sockets do not keep the test
			// process alive after the suite finishes.
			await writePool()
				.end()
				.catch(() => {
					/* already ended, or never successfully opened — nothing to clean up */
				});
		});

		it('runs lock -> load -> decide -> persist -> commit for real, and a row lands in auction_events with the right columns', async () => {
			const gateway = writeGateway();

			const result = await runTransactionalWrite({
				gateway,
				load: async () => ({}),
				decide: async (): Promise<Decision> => ({
					kind: 'accepted',
					events: [
						{
							type: 'IntegrationRealShell',
							payload: { via: 'runTransactionalWrite' },
							managerId,
							teamId
						}
					]
				})
			});

			expect(result.kind).toBe('accepted');
			if (result.kind !== 'accepted') return;
			expect(result.events).toHaveLength(1);
			const appended = result.events[0];
			expect(appended).toBeDefined();
			expect(typeof appended?.seq).toBe('string');
			expect(BigInt(appended?.seq ?? '0')).toBeGreaterThan(0n);
			expect(appended?.type).toBe('IntegrationRealShell');
			expect(appended?.managerId).toBe(managerId);
			expect(appended?.teamId).toBe(teamId);

			// Verify independently, straight from Postgres through a separate
			// connection — not merely that the driver handed back a plausible
			// `RETURNING` row, but that the row is really durably there.
			const row = await owner.query(
				`select event_type, manager_id, team_id, payload, schema_version, core_version
				 from public.auction_events where seq = $1`,
				[appended?.seq]
			);
			expect(row.rows).toHaveLength(1);
			expect(row.rows[0]?.['event_type']).toBe('IntegrationRealShell');
			expect(row.rows[0]?.['manager_id']).toBe(managerId);
			expect(row.rows[0]?.['team_id']).toBe(teamId);
			expect(row.rows[0]?.['payload']).toEqual({ via: 'runTransactionalWrite' });
		});
	});
});
