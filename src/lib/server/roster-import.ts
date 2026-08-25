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
import type { ParsedRosterRow } from '../core/types.ts';
import { parseRosterCsv } from '../adapters/fantrax/roster-file.ts';
import { resolveTeamByFileName } from './team-registry.ts';
import type { TeamRecord } from './team-registry.ts';

/** What staging one file produced. */
export type StageOutcome =
	| {
			readonly kind: 'staged';
			readonly teamId: string;
			readonly teamName: string;
			readonly fileName: string;
			readonly rowCount: number;
	  }
	| { readonly kind: 'refused_file'; readonly fileName: string; readonly detail: string }
	| {
			readonly kind: 'refused_content';
			readonly teamId: string;
			readonly teamName: string;
			readonly fileName: string;
			readonly detail: string;
	  }
	| {
			/**
			 * Not returned by `stageRosterFile` itself — `stageRosterFile` only
			 * ever returns one of the three kinds above, or throws (a genuine bug
			 * or infrastructure failure, per this module's own try/catch/rethrow).
			 * The `/import` route's `upload` action catches that throw per file
			 * and converts it into this shape so one file's failure becomes that
			 * file's own result rather than aborting the rest of the batch
			 * (Boundaries & Constraints, amended at review-loop-iteration 1). It
			 * lives on this union, rather than as a route-local type, because the
			 * route's `results` array is typed `StageOutcome[]` and needs every
			 * shape it can hold to be part of the one type.
			 */
			readonly kind: 'error';
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
				fileName,
				detail:
					match.kind === 'ambiguous' ? fileAmbiguousDetail(fileName) : fileNoMatchDetail(fileName)
			};
		}

		const team = match.team;

		if (claimedInBatch.has(team.id)) {
			await client.query('rollback');
			return { kind: 'refused_file', fileName, detail: fileAlreadySuppliedDetail(fileName, team.name) };
		}
		claimedInBatch.add(team.id);

		const parsed = parseRosterCsv(csvText);

		if (parsed.kind === 'refused') {
			await writeOutcome(client, team.id, fileName, 'refused_content', parsed.detail, []);
			await client.query('commit');
			return {
				kind: 'refused_content',
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
			return { kind: 'refused_content', teamId: team.id, teamName: team.name, fileName, detail };
		}

		const breaches = checkSlotCeilings(parsed.rows);
		if (breaches.length > 0) {
			const detail = slotCeilingRefusalDetail(breaches);
			await writeOutcome(client, team.id, fileName, 'refused_content', detail, []);
			await client.query('commit');
			return { kind: 'refused_content', teamId: team.id, teamName: team.name, fileName, detail };
		}

		await writeOutcome(client, team.id, fileName, 'staged', null, parsed.rows);
		await client.query('commit');
		return { kind: 'staged', teamId: team.id, teamName: team.name, fileName, rowCount: parsed.rows.length };
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

	for (const row of rows) {
		await client.query(
			`insert into import_staged_rosters
				(team_id, fantrax_player_id, player_name, cap_hit, roster_slot_kind, contract_years_remaining)
			values ($1, $2, $3, $4, $5, $6)`,
			[teamId, row.fantraxPlayerId, row.playerName, row.capHit, row.rosterSlotKind, row.contractYearsRemaining]
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
