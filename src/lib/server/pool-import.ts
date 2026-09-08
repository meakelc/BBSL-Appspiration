/**
 * Staging the Free Agent pool file: parse, check for cross-source conflicts,
 * and write — delete+insert+status upsert, one transaction. Server-only.
 *
 * This module is `roster-import.ts`'s pool-keyed sibling and mirrors it
 * deliberately: same `ConnectionGateway`/`TransactionalClient` port, same
 * connect/begin/…/commit shape, same catch/rollback/rethrow, same
 * `finally` release, same two refusal altitudes, same "a refusal never
 * destroys an already-staged source" discipline. Read that module's header
 * first; only the differences are restated here.
 *
 * **Why staging skips `runTransactionalWrite`/the global lock.** Same reason
 * 1.7 gave: that pipeline is for the append-only `auction_events` log under
 * cross-Team contention, and staging is independent Setup state (AD-28).
 * The pool is one source; nothing contends with it.
 *
 * **The pool is exactly one source.** Re-supplying it replaces the pool
 * alone — `delete from import_staged_pool_players` with no predicate — and
 * leaves all thirty Team sources untouched. There is no per-Team fan-out
 * here because there is nothing to fan out over.
 *
 * **Two refusal altitudes (AD-24), unchanged.** File altitude — the pool
 * file supplied twice in one drop — never reaches the database at all:
 * writing it would destroy the status the first pool file in that same batch
 * just established. Content altitude — a missing column, a blank cell, a
 * duplicate Fantrax Player ID, or a Player who is also on a Team's staged
 * roster — reaches `writeOutcome`.
 *
 * **The pool/roster conflict is checked in BOTH directions.** Here, the pool
 * is checked against already-staged rosters; in `roster-import.ts`, a roster
 * is checked against an already-staged pool. A thirty-one-file drop arrives
 * in arbitrary browser order, so a one-directional check would make
 * acceptance depend on luck (this story's Design Notes). Both directions
 * word the refusal through `core/rules/pool-import.ts`'s
 * `poolConflictRefusalDetail`, so they cannot drift apart.
 *
 * **A refusal never destroys an already-staged pool.** `writeOutcome` reads
 * the current status first when the outcome is a refusal: a pool already
 * `staged` keeps its rows and status exactly as they were, and the failed
 * attempt is communicated only through this call's own returned
 * `StageOutcome`.
 */

import type { ConnectionGateway, TransactionalClient } from '../shell/write.ts';
import { POOL_SOURCE_LABEL, poolConflictRefusalDetail } from '../core/rules/pool-import.ts';
import type { PoolRosterConflict } from '../core/rules/pool-import.ts';
import type { ParsedPoolRow } from '../core/types.ts';
import { parsePoolCsv } from '../adapters/fantrax/pool-file.ts';
import {
	poolFileNameShadowsTeam,
	poolShadowsTeamDetail,
	poolShadowsTeamsDetail
} from './pool-registry.ts';
import type { TeamRecord } from './team-registry.ts';
import type { StageOutcome } from './roster-import.ts';

/**
 * The singleton `import_pool_source` primary key. One row by construction —
 * the column's check constraint admits this value and no other.
 */
export const POOL_SOURCE_ID = 'pool';

/**
 * Rows per multi-row INSERT when staging the pool.
 *
 * Bounded rather than "all of them in one statement" because a parameterised
 * query carries at most 65,535 bind parameters, and at four columns per row a
 * single statement would cap out around 16,000 Players. 500 keeps the whole
 * pool to three statements while leaving that ceiling far away, so a pool that
 * grows does not silently approach a wall.
 */
const POOL_INSERT_BATCH = 500;

/** Split `items` into consecutive runs of at most `size`. */
function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

export { POOL_SOURCE_LABEL };

/** The file-altitude refusal sentence for a second pool file in one drop. */
export function poolAlreadySuppliedDetail(fileName: string): string {
	return `"${fileName}" was refused: the ${POOL_SOURCE_LABEL} was already supplied in this batch.`;
}

/**
 * Stage the Free Agent pool file: parse and validate its content, check it
 * against every Team's already-staged roster, and write the outcome — all
 * inside one transaction on `gateway`.
 *
 * `poolClaimedInBatch` is the pool's analogue of `stageRosterFile`'s
 * `claimedInBatch` set, and the `/import` upload action threads one shared
 * batch state through both. It is read and set before content validation:
 * a second pool file in the same drop is refused at file altitude
 * regardless of whether the first one's content was valid, because two files
 * claiming the one pool source in a single drop is inherently ambiguous, not
 * a re-supply.
 */
export async function stagePoolFile(
	gateway: ConnectionGateway,
	fileName: string,
	csvText: string,
	poolClaimedInBatch: { claimed: boolean } = { claimed: false }
): Promise<StageOutcome> {
	const client = await gateway.connect();
	try {
		await client.query('begin');

		if (poolClaimedInBatch.claimed) {
			await client.query('rollback');
			return {
				kind: 'refused_file',
				source: 'unknown',
				fileName,
				detail: poolAlreadySuppliedDetail(fileName)
			};
		}

		// Refuse-not-guess: a file name that names BOTH the pool and a Team is
		// ambiguous, and silently staging one of the thirty as the thirty-first
		// (or the reverse) is a data-loss shape, not a mismatch. Read from the
		// same `teams` table, on the same connection, inside the same
		// transaction `stageRosterFile` reads it in.
		//
		// **This runs BEFORE the batch claim is taken, and the order is load-
		// bearing.** A shadowed name is not the pool — it is a file that failed
		// to name any one source. Claiming the pool on its way out would spend
		// the drop's single pool claim on a file that stages nothing, so the
		// genuine pool file later in the same batch would be refused as
		// "already supplied" and the pool would never stage at all. Only a file
		// that survives every file-altitude check claims the pool.
		const teamsResult = await client.query('select id, name from teams');
		const teams: TeamRecord[] = teamsResult.rows.map((row) => ({
			id: String(row['id']),
			name: String(row['name'])
		}));
		const shadowed = poolFileNameShadowsTeam(teams, fileName);
		if (shadowed !== null) {
			await client.query('rollback');
			return {
				kind: 'refused_file',
				source: 'unknown',
				fileName,
				detail:
					shadowed.kind === 'shadowed'
						? poolShadowsTeamDetail(fileName, shadowed.team.name)
						: poolShadowsTeamsDetail(fileName, shadowed.teams)
			};
		}

		poolClaimedInBatch.claimed = true;

		const parsed = parsePoolCsv(csvText);

		if (parsed.kind === 'refused') {
			await writeOutcome(client, fileName, 'refused_content', parsed.detail, []);
			await client.query('commit');
			return { kind: 'refused_content', source: 'pool', fileName, detail: parsed.detail };
		}

		const conflicts = await findRosterConflicts(client, parsed.rows);
		if (conflicts.length > 0) {
			const detail = poolConflictRefusalDetail(conflicts);
			await writeOutcome(client, fileName, 'refused_content', detail, []);
			await client.query('commit');
			return { kind: 'refused_content', source: 'pool', fileName, detail };
		}

		await writeOutcome(client, fileName, 'staged', null, parsed.rows);
		await client.query('commit');
		return { kind: 'staged', source: 'pool', fileName, rowCount: parsed.rows.length };
	} catch (error) {
		await client.query('rollback').catch(() => {
			/* the original error is what the caller needs to see */
		});
		throw error;
	} finally {
		client.release();
	}
}

/**
 * Every Player in `rows` who is already on some Team's staged roster, named
 * by Player and by Team. Empty means no conflict.
 *
 * Joins on the Fantrax player id (AD-24), never on name — the names come
 * back only so the refusal can state them. `import_staged_rosters` carries
 * no Team name, hence the join to `teams`.
 */
async function findRosterConflicts(
	client: TransactionalClient,
	rows: readonly ParsedPoolRow[]
): Promise<readonly PoolRosterConflict[]> {
	if (rows.length === 0) return [];

	const result = await client.query(
		`select p.player_name, t.name
		from import_staged_rosters p
		join teams t on t.id = p.team_id
		where p.fantrax_player_id = any($1)`,
		[rows.map((row) => row.fantraxPlayerId)]
	);

	return result.rows.map((row) => ({
		playerName: String(row['player_name']),
		teamName: String(row['name'])
	}));
}

/**
 * Delete the pool's existing staged rows, insert the new ones (none, on a
 * refusal), and upsert the singleton status row — UNLESS this is a refusal
 * and the pool's current status is already `staged`, in which case nothing
 * is written at all: the pool's rows and status survive the failed attempt
 * untouched, exactly as 1.7 amended for a Team. A successful stage always
 * proceeds — re-supplying a valid pool file is the normal re-supply path and
 * always replaces its rows.
 *
 * The delete carries no predicate on purpose: the pool is one source, so
 * "the pool's rows" is the whole table. Nothing here touches
 * `import_staged_rosters` or `import_team_sources`, which is what makes
 * "all thirty Team sources untouched" true by construction rather than by
 * a correctly-written WHERE clause.
 */
async function writeOutcome(
	client: TransactionalClient,
	fileName: string,
	status: 'staged' | 'refused_content',
	refusalDetail: string | null,
	rows: readonly ParsedPoolRow[]
): Promise<void> {
	if (status === 'refused_content') {
		const current = await client.query('select status from import_pool_source where id = $1', [
			POOL_SOURCE_ID
		]);
		if (current.rows[0]?.['status'] === 'staged') {
			// Nothing to do: the already-good pool rows and status stand. The
			// refusal is still reported to the caller — see `stagePoolFile`'s
			// `refused_content` returns above — only the database is left alone.
			return;
		}
	}

	await client.query('delete from import_staged_pool_players');

	// Inserted in BATCHES, not one statement per row (Story 9.7).
	//
	// This was a row-at-a-time loop until the first import of a real pool. A
	// BBSL Free Agent pool is ~1,470 Players, so that loop was ~1,470 sequential
	// round trips inside one transaction: 65 seconds measured against the hosted
	// database, on its own, for this one file. Netlify's synchronous function
	// budget is 10 seconds, so the import did not fail — it was killed, and
	// reported as "This function has crashed. An unknown error has occurred",
	// which names neither the file nor the cause.
	//
	// No test could have caught it. Every fixture in the suite is two or three
	// rows, where a loop and a batch are indistinguishable; only a real pool
	// makes the difference visible, and only a real deploy makes it fatal.
	//
	// `minor_league_eligible` is deliberately absent from the column list: it
	// takes the column's `false` default. Eligibility is app-owned, never
	// imported (1.10 owns changing it).
	//
	// `source_rank` IS written here, and this is the only place it can be:
	// `parsePoolFile` returns its rows in file order, and that array index is
	// the whole of what the column means. Batching must not lose it, so the
	// rank is computed from the row's position in `rows` — `batchStart + i` —
	// never from `i`, which restarts at zero on every batch and would give
	// every 500th Player rank 0. The adapter reads no `Score` or `RkOv`
	// column; the app repeats the file's order without claiming to know why
	// the file is in that order.
	let batchStart = 0;
	for (const batch of chunk(rows, POOL_INSERT_BATCH)) {
		const values: unknown[] = [];
		const tuples = batch.map((row, i) => {
			values.push(row.fantraxPlayerId, row.playerName, row.positions, row.nbaTeam, batchStart + i);
			const at = i * 5;
			return `($${String(at + 1)}, $${String(at + 2)}, $${String(at + 3)}, $${String(at + 4)}, $${String(at + 5)})`;
		});
		await client.query(
			`insert into import_staged_pool_players
				(fantrax_player_id, player_name, positions, nba_team, source_rank)
			values ${tuples.join(', ')}`,
			values
		);
		batchStart += batch.length;
	}

	await client.query(
		`insert into import_pool_source (id, file_name, status, refusal_detail, updated_at)
		values ($1, $2, $3, $4, now())
		on conflict (id) do update set
			file_name = excluded.file_name,
			status = excluded.status,
			refusal_detail = excluded.refusal_detail,
			updated_at = excluded.updated_at`,
		[POOL_SOURCE_ID, fileName, status, refusalDetail]
	);
}
