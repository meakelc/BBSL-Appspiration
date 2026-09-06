/**
 * Staging one Team roster file: resolve, parse, validate, and write —
 * delete+insert+status upsert, one transaction. Server-only.
 *
 * **Why this does not go through `runTransactionalWrite` (Design Notes).**
 * That pipeline exists for the append-only `auction_events` log under
 * cross-Team contention — the global advisory lock (AD-6), the
 * event-envelope columns, the projection-fold seam. Staging is independent
 * per-Team Setup state (AD-28): two files never contend for the same Team's
 * rows, so a per-file local transaction is enough, with no lock and no
 * event appended. What IS reused from that pipeline's world is the
 * `ConnectionGateway`/`TransactionalClient` port (`shell/write.ts`) and the
 * real pooled connection behind it (`shell/db.ts`'s `writeGateway()`) — the
 * same direct-Postgres route `auction_events` writes through, needed here
 * for the same reason: `BEGIN ... COMMIT` held open across a multi-statement
 * write is not something PostgREST can do.
 *
 * **Two refusal altitudes (AD-24).** File altitude — no Team matches the
 * file's name, or a Team already claimed by an earlier file in this same
 * upload batch — never reaches the database at all: there is either no
 * `team_id` to key a row by, or writing one would destroy the status an
 * earlier file in the same batch just established. Content altitude — a bad
 * column, a row Team ID mismatch, a negative Cap Space, a breached slot
 * ceiling — reaches `writeOutcome`.
 *
 * **A refusal never deletes a Team's already-staged rows (Boundaries &
 * Constraints, amended at review-loop-iteration 1).** `writeOutcome` reads
 * the Team's current status first when the outcome is a refusal: a Team
 * already `staged` keeps its rows and status exactly as they were — the
 * failed attempt is communicated only through this call's own returned
 * `StageOutcome`, never by touching the database. Only a Team with nothing
 * currently staged (no row, or a prior non-`staged` status) records the
 * refusal's status/detail, because there is nothing staged to protect there.
 */

import type { ConnectionGateway, TransactionalClient } from '../shell/write.ts';
import {
	capSpaceRefusalDetail,
	checkSlotCeilings,
	computeCapSpace,
	slotCeilingRefusalDetail
} from '../core/rules/roster-import.ts';
import { poolConflictRefusalDetail } from '../core/rules/pool-import.ts';
import type { PoolRosterConflict } from '../core/rules/pool-import.ts';
import type { ParsedRosterRow } from '../core/types.ts';
import { parseRosterCsv } from '../adapters/fantrax/roster-file.ts';
import { resolveTeamByFileName } from './team-registry.ts';
import type { TeamRecord } from './team-registry.ts';

/**
 * What staging one file produced — Team-keyed or pool-keyed.
 *
 * **Story 1.8 widened this union to span both sources.** `source` is the
 * discriminator: `'team'` members carry `teamId`/`teamName`, `'pool'`
 * members carry neither (the pool is one source, keyed by pool — AD-28), and
 * `'unknown'` covers the two outcomes that belong to a file rather than a
 * resolved source (a file-altitude refusal, and the route's per-file
 * `error`). A `source` field on every member, rather than a nullable
 * `teamId`, is what lets a caller — the `/import` page above all — narrow
 * the union without a presence check.
 *
 * The union lives here rather than in a third module because
 * `server/pool-import.ts` is this module's sibling and imports the type from
 * it; the `/import` route's `results` array is typed `StageOutcome[]` and
 * needs every shape it can hold to be part of the one type.
 */
export type StageOutcome =
	| {
			readonly kind: 'staged';
			readonly source: 'team';
			readonly teamId: string;
			readonly teamName: string;
			readonly fileName: string;
			readonly rowCount: number;
	  }
	| {
			/** The Free Agent pool staged. `rowCount` is the pool size, reported for explicit confirmation. */
			readonly kind: 'staged';
			readonly source: 'pool';
			readonly fileName: string;
			readonly rowCount: number;
	  }
	| {
			readonly kind: 'refused_file';
			readonly source: 'unknown';
			readonly fileName: string;
			readonly detail: string;
	  }
	| {
			readonly kind: 'refused_content';
			readonly source: 'team';
			readonly teamId: string;
			readonly teamName: string;
			readonly fileName: string;
			readonly detail: string;
	  }
	| {
			readonly kind: 'refused_content';
			readonly source: 'pool';
			readonly fileName: string;
			readonly detail: string;
	  }
	| {
			/**
			 * Not returned by `stageRosterFile`/`stagePoolFile` themselves —
			 * either only ever returns one of the kinds above, or throws (a
			 * genuine bug or infrastructure failure, per each module's own
			 * try/catch/rethrow). The `/import` route's `upload` action catches
			 * that throw per file and converts it into this shape so one file's
			 * failure becomes that file's own result rather than aborting the
			 * rest of the batch (Boundaries & Constraints, amended at
			 * review-loop-iteration 1).
			 */
			readonly kind: 'error';
			readonly source: 'unknown';
			readonly fileName: string;
			readonly detail: string;
	  };

/** The three file-altitude refusal sentences, exported so callers/tests share them verbatim. */
export function fileNoMatchDetail(fileName: string): string {
	return `"${fileName}" matches no Team by name.`;
}
export function fileAmbiguousDetail(fileName: string): string {
	return `"${fileName}" matches more than one Team by name.`;
}
export function fileAlreadySuppliedDetail(fileName: string, teamName: string): string {
	return `"${fileName}" was refused: ${teamName} was already supplied in this batch.`;
}

/**
 * Stage one file: resolve its Team, parse and validate its content, and
 * write the outcome — all inside one transaction on `gateway`.
 *
 * `claimedInBatch` is shared across every file in one upload batch (the
 * `/import` route's `upload` action builds one `Set` and passes it to every
 * call). The Team a file resolves to is added to it as soon as it is
 * matched, before content validation — a second file in the same batch
 * matching that Team is refused at file altitude regardless of whether the
 * first file's content was itself valid, because two files claiming one
 * Team in a single drop is inherently ambiguous, not a re-supply (re-supply
 * is a separate, later action — see this story's I/O matrix).
 */
export async function stageRosterFile(
	gateway: ConnectionGateway,
	fileName: string,
	csvText: string,
	claimedInBatch: Set<string> = new Set()
): Promise<StageOutcome> {
	const client = await gateway.connect();
	try {
		await client.query('begin');

		const teamsResult = await client.query('select id, name from teams');
		const teams: TeamRecord[] = teamsResult.rows.map((row) => ({
			id: String(row['id']),
			name: String(row['name'])
		}));

		const match = resolveTeamByFileName(teams, fileName);

		if (match.kind !== 'matched') {
			await client.query('rollback');
			return {
				kind: 'refused_file',
				source: 'unknown',
				fileName,
				detail:
					match.kind === 'ambiguous' ? fileAmbiguousDetail(fileName) : fileNoMatchDetail(fileName)
			};
		}

		const team = match.team;

		if (claimedInBatch.has(team.id)) {
			await client.query('rollback');
			return {
				kind: 'refused_file',
				source: 'unknown',
				fileName,
				detail: fileAlreadySuppliedDetail(fileName, team.name)
			};
		}
		claimedInBatch.add(team.id);

		const parsed = parseRosterCsv(csvText);

		if (parsed.kind === 'refused') {
			await writeOutcome(client, team.id, fileName, 'refused_content', parsed.detail, []);
			await client.query('commit');
			return {
				kind: 'refused_content',
				source: 'team',
				teamId: team.id,
				teamName: team.name,
				fileName,
				detail: parsed.detail
			};
		}

		const capResult = computeCapSpace(parsed.rows);
		if (capResult.capSpace < 0) {
			const detail = capSpaceRefusalDetail(capResult);
			await writeOutcome(client, team.id, fileName, 'refused_content', detail, []);
			await client.query('commit');
			return {
				kind: 'refused_content',
				source: 'team',
				teamId: team.id,
				teamName: team.name,
				fileName,
				detail
			};
		}

		const breaches = checkSlotCeilings(parsed.rows);
		if (breaches.length > 0) {
			const detail = slotCeilingRefusalDetail(breaches);
			await writeOutcome(client, team.id, fileName, 'refused_content', detail, []);
			await client.query('commit');
			return {
				kind: 'refused_content',
				source: 'team',
				teamId: team.id,
				teamName: team.name,
				fileName,
				detail
			};
		}

		// The pool/roster conflict, roster direction (Story 1.8). The other
		// direction lives in `server/pool-import.ts`, which checks a pool file
		// against already-staged rosters. Both are needed because a
		// thirty-one-file drop arrives in arbitrary browser order: whichever
		// file is staged second is the one refused, and a one-directional check
		// would make acceptance depend on that order (this story's Design
		// Notes). Both word the refusal through the same pure function, so the
		// Commissioner reads the same sentence either way.
		const poolConflicts = await findPoolConflicts(client, team.name, parsed.rows);
		if (poolConflicts.length > 0) {
			const detail = poolConflictRefusalDetail(poolConflicts);
			await writeOutcome(client, team.id, fileName, 'refused_content', detail, []);
			await client.query('commit');
			return {
				kind: 'refused_content',
				source: 'team',
				teamId: team.id,
				teamName: team.name,
				fileName,
				detail
			};
		}

		await writeOutcome(client, team.id, fileName, 'staged', null, parsed.rows);
		await client.query('commit');
		return {
			kind: 'staged',
			source: 'team',
			teamId: team.id,
			teamName: team.name,
			fileName,
			rowCount: parsed.rows.length
		};
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
 * Delete a Team's existing staged rows, insert the new ones (none, on a
 * refusal), and upsert its status row — UNLESS this is a refusal
 * (`status === 'refused_content'`) and the Team's current status is already
 * `'staged'`, in which case nothing is written at all: the Team's rows and
 * status survive the failed attempt untouched (Boundaries & Constraints,
 * amended at review-loop-iteration 1). A successful stage (`status ===
 * 'staged'`) always proceeds — re-supplying a Team with a valid file is the
 * normal re-supply path and always replaces its rows.
 */
async function writeOutcome(
	client: TransactionalClient,
	teamId: string,
	fileName: string,
	status: 'staged' | 'refused_content',
	refusalDetail: string | null,
	rows: readonly ParsedRosterRow[]
): Promise<void> {
	if (status === 'refused_content') {
		const current = await client.query(
			'select status from import_team_sources where team_id = $1',
			[teamId]
		);
		const currentStatus = current.rows[0]?.['status'];
		if (currentStatus === 'staged') {
			// Nothing to do: the Team's already-good rows and status stand.
			// The refusal is still reported to the caller — see
			// `stageRosterFile`'s `refused_content` return above this call —
			// only the database is left untouched.
			return;
		}
	}

	await client.query('delete from import_staged_rosters where team_id = $1', [teamId]);

	// One multi-row INSERT rather than one statement per Player (Story 9.7).
	//
	// A roster is only ten to fifteen rows, so this file is not the one that
	// broke the import — the Free Agent pool's ~1,470 rows were (see the note in
	// `pool-import.ts`). But thirty rosters staged in a single request add their
	// round trips together against the same 10-second function budget, and a
	// batch here is the same shape for none of the cost. Uploading all
	// thirty-one files at once is the documented workflow, not an edge case.
	if (rows.length > 0) {
		const values: unknown[] = [];
		const tuples = rows.map((row, i) => {
			values.push(
				teamId,
				row.fantraxPlayerId,
				row.playerName,
				row.capHit,
				row.rosterSlotKind,
				row.contractYearsRemaining
			);
			const at = i * 6;
			return `($${String(at + 1)}, $${String(at + 2)}, $${String(at + 3)}, $${String(at + 4)}, $${String(at + 5)}, $${String(at + 6)})`;
		});
		await client.query(
			`insert into import_staged_rosters
				(team_id, fantrax_player_id, player_name, cap_hit, roster_slot_kind, contract_years_remaining)
			values ${tuples.join(', ')}`,
			values
		);
	}

	await client.query(
		`insert into import_team_sources (team_id, file_name, status, refusal_detail, updated_at)
		values ($1, $2, $3, $4, now())
		on conflict (team_id) do update set
			file_name = excluded.file_name,
			status = excluded.status,
			refusal_detail = excluded.refusal_detail,
			updated_at = excluded.updated_at`,
		[teamId, fileName, status, refusalDetail]
	);
}

/**
 * Every Player in this roster file who is already in the staged Free Agent
 * pool, named by Player and by this file's Team (Story 1.8).
 *
 * Joins on the Fantrax player id (AD-24), never on name; the pool row's own
 * name is what the refusal states, so the two directions of this check name
 * the Player identically even if the two files spell it differently. The
 * Team name comes from the already-resolved Team rather than a second query.
 */
async function findPoolConflicts(
	client: TransactionalClient,
	teamName: string,
	rows: readonly ParsedRosterRow[]
): Promise<readonly PoolRosterConflict[]> {
	if (rows.length === 0) return [];

	const result = await client.query(
		'select player_name from import_staged_pool_players where fantrax_player_id = any($1)',
		[rows.map((row) => row.fantraxPlayerId)]
	);

	return result.rows.map((row) => ({ playerName: String(row['player_name']), teamName }));
}
