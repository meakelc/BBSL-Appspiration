import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { GLOBAL_WRITE_LOCK_KEY } from '../../src/lib/core/constants.ts';
import {
	AUCTION_CLOSED_EVENT,
	NOMINATION_PLACED_EVENT
} from '../../src/lib/core/projection/nominations.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';
import { classifyNominationConflict, releaseNomination } from '../../src/lib/server/nomination.ts';
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
	/** A second Team, so the Slot constraint can be raced by one Team twice. */
	let otherTeamId: string;

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

		const otherTeam = await owner.query<{ id: string }>(
			`insert into public.teams (name) values ($1) returning id`,
			[`Story 2.2 Fixture Team ${Date.now()}`]
		);
		otherTeamId = otherTeam.rows[0]?.id ?? (() => {
			throw new Error('fixture second team insert returned no row');
		})();
	});

	afterAll(async () => {
		// Claims first: they reference both auction_events(seq) and teams(id).
		await owner.query('delete from public.open_nominations where team_id = any($1::uuid[])', [
			[teamId, otherTeamId]
		]);
		await owner.query('delete from public.auction_events where manager_id = $1', [managerId]);
		await owner.query('delete from public.managers where id = $1', [managerId]);
		await owner.query('delete from public.teams where id = any($1::uuid[])', [
			[teamId, otherTeamId]
		]);
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

	// Story 2.2's AC4: uniqueness is enforced by a CONSTRAINT the second
	// writer cannot pass, not by the read that preceded it. That cannot be
	// proven by asserting the DDL exists, so these two tests race two real
	// writers whose reads BOTH saw a free Player and a free Slot — the
	// check-then-write gap Story 2.1 deliberately left open — and let the
	// claim table be the only thing standing between them.
	//
	// Each writer replicates the pipeline's own statement sequence
	// (lock -> read -> insert event -> insert claim -> commit) against raw
	// `pg.Client`s, for the same reason every other proof in this file does:
	// two independent connections are needed, and `writeGateway()`'s pool
	// cannot be made to interleave them deterministically.
	describe('Story 2.2 AC4 — the claim table separates two writers the gate let through', () => {
		/** One writer's transaction, up to but not including the claim insert. */
		async function appendNomination(
			client: Client,
			fantraxPlayerId: string,
			playerName: string,
			claimingTeamId: string
		): Promise<{ seq: string; occurredAt: Date }> {
			await client.query('select pg_advisory_xact_lock($1::bigint)', [
				GLOBAL_WRITE_LOCK_KEY.toString()
			]);
			const inserted = await client.query<{ seq: string; occurred_at: Date }>(
				`insert into public.auction_events
					(occurred_at, schema_version, core_version, manager_id, team_id, event_type, payload)
				 values (now(), 1, 1, $1, $2, $3, $4::jsonb)
				 returning seq, occurred_at`,
				[
					managerId,
					claimingTeamId,
					NOMINATION_PLACED_EVENT,
					JSON.stringify({
						fantraxPlayerId,
						playerName,
						teamId: claimingTeamId,
						teamName: 'Fixture',
						managerId
					})
				]
			);
			const row = inserted.rows[0];
			if (row === undefined) throw new Error('nomination insert returned no row');
			return { seq: String(row.seq), occurredAt: row.occurred_at };
		}

		async function claim(
			client: Client,
			fantraxPlayerId: string,
			claimingTeamId: string,
			appended: { seq: string; occurredAt: Date }
		): Promise<void> {
			await client.query(
				`insert into public.open_nominations
					(fantrax_player_id, team_id, seq, occurred_at)
				 values ($1, $2, $3, $4)`,
				[fantraxPlayerId, claimingTeamId, appended.seq, appended.occurredAt]
			);
		}

		// Each test in this block commits a claim of its own, and the two
		// constraints under test are exactly what a leftover claim would trip.
		// Without this, the Slot test dies on the PREVIOUS test's committed
		// row before reaching the assertion it exists to make — a green-or-red
		// verdict that depends on execution order rather than on the schema.
		afterEach(async () => {
			await owner.query('delete from public.open_nominations where team_id = any($1::uuid[])', [
				[teamId, otherTeamId]
			]);
		});

		it('lets exactly ONE nomination of a Player survive: the loser raises 23505 on the PK', async () => {
			const playerId = `race-player-${Date.now()}`;
			const first = new Client({ connectionString: LOCAL_DB_URL });
			const second = new Client({ connectionString: LOCAL_DB_URL });
			await first.connect();
			await second.connect();

			try {
				// BOTH readers see a Player nobody has nominated — the gate
				// would pass for each of them. This is the race being staged.
				await first.query('begin');
				await second.query('begin');
				for (const reader of [first, second]) {
					const board = await reader.query(
						`select 1 from public.auction_events
						 where event_type = $1 and payload->>'fantraxPlayerId' = $2`,
						[NOMINATION_PLACED_EVENT, playerId]
					);
					expect(board.rows).toHaveLength(0);
				}

				const firstAppend = await appendNomination(first, playerId, 'Race Player', teamId);
				await claim(first, playerId, teamId, firstAppend);
				await first.query('commit');

				// The second writer now takes the lock the first has released,
				// appends its own event — and is stopped by the constraint.
				const secondAppend = await appendNomination(second, playerId, 'Race Player', otherTeamId);
				let thrown: unknown = null;
				try {
					await claim(second, playerId, otherTeamId, secondAppend);
				} catch (error) {
					thrown = error;
				}
				await second.query('rollback');

				expect(thrown).not.toBeNull();
				// The real error, classified by the real classifier: this is
				// what makes the constraint NAME in the migration load-bearing.
				expect(classifyNominationConflict(thrown)).toBe('already_nominated');

				// Exactly one NominationPlaced row and exactly one claim row.
				const events = await owner.query(
					`select seq from public.auction_events
					 where event_type = $1 and payload->>'fantraxPlayerId' = $2`,
					[NOMINATION_PLACED_EVENT, playerId]
				);
				expect(events.rows).toHaveLength(1);
				expect(String(events.rows[0]?.['seq'])).toBe(firstAppend.seq);

				const claims = await owner.query(
					'select team_id, seq from public.open_nominations where fantrax_player_id = $1',
					[playerId]
				);
				expect(claims.rows).toHaveLength(1);
				expect(claims.rows[0]?.['team_id']).toBe(teamId);
			} finally {
				await first.end();
				await second.end();
			}
		});

		it('lets a Team spend its Slot ONCE: a second Player raises 23505 on the team constraint', async () => {
			const firstPlayer = `slot-race-a-${Date.now()}`;
			const secondPlayer = `slot-race-b-${Date.now()}`;
			const client = new Client({ connectionString: LOCAL_DB_URL });
			await client.connect();

			try {
				await client.query('begin');
				const appendedFirst = await appendNomination(client, firstPlayer, 'Slot A', teamId);
				await claim(client, firstPlayer, teamId, appendedFirst);
				await client.query('commit');

				await client.query('begin');
				const appendedSecond = await appendNomination(client, secondPlayer, 'Slot B', teamId);
				let thrown: unknown = null;
				try {
					await claim(client, secondPlayer, teamId, appendedSecond);
				} catch (error) {
					thrown = error;
				}
				await client.query('rollback');

				expect(thrown).not.toBeNull();
				expect(classifyNominationConflict(thrown)).toBe('slot_in_use');

				// The rolled-back writer left no event and no claim behind.
				const events = await owner.query(
					`select seq from public.auction_events
					 where event_type = $1 and payload->>'fantraxPlayerId' = $2`,
					[NOMINATION_PLACED_EVENT, secondPlayer]
				);
				expect(events.rows).toHaveLength(0);

				const claims = await owner.query(
					'select fantrax_player_id from public.open_nominations where team_id = $1',
					[teamId]
				);
				expect(claims.rows).toHaveLength(1);
				expect(claims.rows[0]?.['fantrax_player_id']).toBe(firstPlayer);
			} finally {
				await client.end();
			}
		});

		it('grants service_role select/insert/delete on open_nominations, and no update', async () => {
			const client = new Client({ connectionString: LOCAL_DB_URL });
			await client.connect();
			try {
				const grants = await client.query<{ privilege_type: string }>(
					`select privilege_type from information_schema.role_table_grants
					 where table_schema = 'public' and table_name = 'open_nominations'
					   and grantee = 'service_role'`
				);
				const held = grants.rows.map((r) => r.privilege_type).sort();
				expect(held).toEqual(['DELETE', 'INSERT', 'SELECT']);
			} finally {
				await client.end();
			}
		});

		it('leaves anon and authenticated with ZERO privileges on open_nominations', async () => {
			// The migration's "belt as well as braces" revoke was asserted only
			// in a comment. The security property is that the client-facing
			// roles hold nothing at all — not merely that RLS would hide the
			// rows if they did.
			const client = new Client({ connectionString: LOCAL_DB_URL });
			await client.connect();
			try {
				const grants = await client.query<{ grantee: string; privilege_type: string }>(
					`select grantee, privilege_type from information_schema.role_table_grants
					 where table_schema = 'public' and table_name = 'open_nominations'
					   and grantee in ('anon', 'authenticated')`
				);
				expect(grants.rows).toEqual([]);
			} finally {
				await client.end();
			}
		});
	});

	// Story 2.3's AC3: the claim row's DELETE, run by the real
	// `releaseNomination` against real Postgres. This is the only place
	// `20260825000000_open_nominations.sql`'s DELETE grant is exercised —
	// every other proof in this file either inserts or cleans up as the
	// superuser `postgres` role, which would pass whether the grant existed
	// or not.
	//
	// `releaseNomination` has no production call site by design (Epic 3 owns
	// appending `AuctionClosed`), so this drives it directly with a synthetic
	// close, exactly as `runTransactionalWrite` would through the projection
	// seam: the real function, the real client, the real table.
	describe('Story 2.3 AC3 — releaseNomination deletes the claim row for real', () => {
		afterEach(async () => {
			await owner.query('delete from public.open_nominations where team_id = any($1::uuid[])', [
				[teamId, otherTeamId]
			]);
		});

		/** One appended event, shaped as `runTransactionalWrite` hands them on. */
		function closedEvent(fantraxPlayerId: string): AppendedEvent {
			return {
				seq: '1',
				occurredAt: '2026-08-26T09:00:00.000Z',
				schemaVersion: 1,
				coreVersion: 1,
				type: AUCTION_CLOSED_EVENT,
				payload: { fantraxPlayerId },
				managerId,
				teamId,
				deviceClass: null,
				dispatchOutcome: null,
				deliveryOutcome: null
			};
		}

		/**
		 * A committed nomination plus its claim row — the state a release has
		 * to find something to delete. The claim's `seq` references
		 * `auction_events(seq)`, so the event must be appended first.
		 */
		async function nominateAndClaim(client: Client, fantraxPlayerId: string): Promise<void> {
			await client.query('begin');
			const inserted = await client.query<{ seq: string; occurred_at: Date }>(
				`insert into public.auction_events
					(occurred_at, schema_version, core_version, manager_id, team_id, event_type, payload)
				 values (now(), 1, 1, $1, $2, $3, $4::jsonb)
				 returning seq, occurred_at`,
				[
					managerId,
					teamId,
					NOMINATION_PLACED_EVENT,
					JSON.stringify({
						fantraxPlayerId,
						playerName: 'Release Fixture',
						teamId,
						teamName: 'Fixture',
						managerId
					})
				]
			);
			const row = inserted.rows[0];
			if (row === undefined) throw new Error('nomination insert returned no row');
			await client.query(
				`insert into public.open_nominations
					(fantrax_player_id, team_id, seq, occurred_at)
				 values ($1, $2, $3, $4)`,
				[fantraxPlayerId, teamId, String(row.seq), row.occurred_at]
			);
			await client.query('commit');
		}

		it('removes the claim, freeing the Player and the Team’s Slot at the data layer', async () => {
			const playerId = `release-player-${Date.now()}`;
			const client = new Client({ connectionString: LOCAL_DB_URL });
			await client.connect();

			try {
				await nominateAndClaim(client, playerId);

				const before = await owner.query(
					'select 1 from public.open_nominations where fantrax_player_id = $1',
					[playerId]
				);
				expect(before.rows).toHaveLength(1);

				// The real deleter, on a real client, inside a transaction —
				// the same shape the projection seam gives it.
				await client.query('begin');
				await releaseNomination(client, [closedEvent(playerId)]);
				await client.query('commit');

				const after = await owner.query(
					'select 1 from public.open_nominations where fantrax_player_id = $1',
					[playerId]
				);
				expect(after.rows).toHaveLength(0);

				// The Team's Slot is free at the data layer too: the row that
				// held it via `open_nominations_team_id_key` is gone.
				const held = await owner.query(
					'select 1 from public.open_nominations where team_id = $1',
					[teamId]
				);
				expect(held.rows).toHaveLength(0);
			} finally {
				await client.end();
			}
		});

		it('is a no-op the second time — deleting an absent claim affects zero rows, no error', async () => {
			const playerId = `release-twice-${Date.now()}`;
			const client = new Client({ connectionString: LOCAL_DB_URL });
			await client.connect();

			try {
				await nominateAndClaim(client, playerId);

				await client.query('begin');
				await releaseNomination(client, [closedEvent(playerId)]);
				// The SAME close, folded again — which is what a replayed or
				// duplicated close would do. It must not raise.
				await expect(
					releaseNomination(client, [closedEvent(playerId)])
				).resolves.toBeUndefined();
				await client.query('commit');

				const after = await owner.query(
					'select 1 from public.open_nominations where fantrax_player_id = $1',
					[playerId]
				);
				expect(after.rows).toHaveLength(0);
			} finally {
				await client.end();
			}
		});

		it('deletes nothing for a Player who was never nominated', async () => {
			const client = new Client({ connectionString: LOCAL_DB_URL });
			await client.connect();
			try {
				await client.query('begin');
				await expect(
					releaseNomination(client, [closedEvent(`never-nominated-${Date.now()}`)])
				).resolves.toBeUndefined();
				await client.query('rollback');
			} finally {
				await client.end();
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
