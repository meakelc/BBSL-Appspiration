/**
 * The Audit Log's read: the whole event log, normalised, with every party id
 * any row names resolved to a name. Server-only (Story 7.5).
 *
 * **`server/board.ts`'s discipline, over the log instead of a board.** ONE
 * transaction, ONE `loadEventsViaClient`, one `select now()` for the instant
 * the page anchors its age line on, always `rollback`, and a rethrow on
 * failure. It takes NO advisory lock, for that module's reason: rendering a
 * log is not a write, and a report torn across a concurrent bid can only ever
 * be stale, never authoritative.
 *
 * **It folds NOTHING.** Every other full-log reader in this codebase folds a
 * projection; this one does not, because the Audit Log is a reading of the
 * events themselves and a projection would be a second, derived answer to a
 * question the log already answers directly (AD-4).
 *
 * **Three batched reference reads and never one per row.** The rows are built
 * ONCE with no names to learn which Teams, Players and Managers the Log names
 * — including the ids only a payload's list carries, `contenders`,
 * `formerContenders`, `outstandingTeamIds` and a `ContentionDrawn`'s Player —
 * then resolved in one statement each and rebuilt with the names in hand. That
 * two-pass shape is what makes "no raw id reaches the reader" affordable: a
 * thousand-entry log costs three reference statements, not three thousand.
 *
 * **The sealed-seed table is never read here, and there is no statement in
 * this file that names it** — the whole story greps for its name and expects
 * to find it nowhere under this surface. A seed reaches the Log only because a
 * `ContentionDrawn` or `ContentionDissolved` payload already revealed it
 * (AD-14); an open contention's seed stays sealed behind a table no Postgres
 * role holds a grant on.
 *
 * **No write path of any kind.** No `insert`, no `update`, no `delete`, no
 * event, no lock — the transaction exists only so the read is consistent and
 * it always ends in `rollback`.
 */

import { error } from '@sveltejs/kit';

import {
	NO_REFERENCES,
	UNKNOWN_TYPE_REFUSAL_STATUS,
	auditPartyIds,
	auditPlayerOptions,
	auditRowsFor,
	auditTeamOptions,
	auditTypeOptions,
	filterAuditRows,
	parseAuditQuery
} from '../core/audit-log.ts';
import type {
	AuditFilter,
	AuditFilterOption,
	AuditReferences,
	AuditRow
} from '../core/audit-log.ts';
import { loadEventsViaClient } from './event-log.ts';
import type { ConnectionGateway, TransactionalClient } from '../shell/write.ts';
import { requireDatabaseClock } from '../shell/write.ts';

const TEAMS_TABLE = 'teams';
const MANAGERS_TABLE = 'managers';
const FREE_AGENT_PLAYERS_TABLE = 'free_agent_players';
const TEAM_ROSTERS_TABLE = 'team_rosters';

/**
 * The destination both entry points gate on, defined once.
 *
 * The page and the export are two routes onto one Log, and a Manager who may
 * read it may download it — so they must never gate on different ids. Two
 * copies of a string literal is exactly how that drifts: a typo in one leaves
 * the other guarding a destination nothing registers, and
 * `requireLiveDestination` refuses an unknown id rather than failing loudly at
 * the typo. One definition, imported twice.
 */
export const AUDIT_LOG_DESTINATION_ID = 'audit-log';

/**
 * The whole Log as the two entry points read it.
 *
 * `rows` is EVERY entry, newest first and unfiltered: the route filters this
 * array, and the filter catalogues below are drawn from it rather than from
 * the filtered view, so a filter can always be widened without being cleared
 * first.
 */
export type AuditLogState = {
	readonly rows: readonly AuditRow[];
	/** The database clock at the moment of the read (AD-3). Never Node's. */
	readonly figuresAt: string;
	readonly teamOptions: readonly AuditFilterOption[];
	readonly playerOptions: readonly AuditFilterOption[];
	readonly typeOptions: readonly AuditFilterOption[];
};

/**
 * Every Team the Log names, in ONE statement.
 *
 * `id::text = any($1::text[])` rather than a typed uuid array cast, for
 * `server/board.ts`'s reason: a malformed historical payload carrying a
 * non-conforming id must produce an UNRESOLVED name, not a failed query that
 * 500s the whole Log. On this surface that matters more than anywhere else —
 * the one page whose job is that nothing is hidden must not be takeable down
 * by one bad row.
 *
 * A `Map`, not a `Record`: the keys are data, and a plain object probed with
 * `[key]` would read `constructor` back as an inherited function.
 */
async function loadTeamNames(
	client: TransactionalClient,
	teamIds: readonly string[]
): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	if (teamIds.length === 0) return names;

	const result = await client.query(
		`select id::text as id, name
		from ${TEAMS_TABLE}
		where id::text = any($1::text[])`,
		[[...teamIds]]
	);
	for (const row of result.rows) {
		const id = row['id'];
		const name = row['name'];
		if (typeof id !== 'string' || id === '') continue;
		if (typeof name !== 'string' || name === '') continue;
		names.set(id, name);
	}
	return names;
}

/**
 * Every Manager the Log names, in ONE statement — the actor of every entry,
 * and the actor of every override an entry carries, asked together because
 * both are the same question of the same table.
 *
 * Keyed on manager id alone and not on the (Manager, Team) pair
 * `server/board.ts` uses. That pairing exists there to stop a `managerId`
 * being rendered beside a Team it does not belong to; here the Manager IS the
 * actor column's own half of a pair the database constrains
 * (`20260901000000_system_actor.sql:43`), and a Manager whose Team binding has
 * since changed must still be nameable on the events they actually appended —
 * which is exactly what an audit surface is for.
 */
async function loadManagerNames(
	client: TransactionalClient,
	managerIds: readonly string[]
): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	if (managerIds.length === 0) return names;

	const result = await client.query(
		`select id::text as id, display_name
		from ${MANAGERS_TABLE}
		where id::text = any($1::text[])`,
		[[...managerIds]]
	);
	for (const row of result.rows) {
		const id = row['id'];
		const displayName = row['display_name'];
		if (typeof id !== 'string' || id === '') continue;
		if (typeof displayName !== 'string' || displayName === '') continue;
		names.set(id, displayName);
	}
	return names;
}

/**
 * Every Player the Log names, in ONE statement across BOTH reference tables.
 *
 * A Player nominated out of the pool and won moves from `free_agent_players`
 * to `team_rosters`, so neither table alone answers for a whole Log: the
 * nomination names a Player the roster now holds, and a Roster Move names a
 * Player who was never in this offseason's pool. A `union all` asks both in
 * one round trip, and the pool row wins on a collision only because it is read
 * first — the two tables carry the same `player_name` for the same id.
 */
async function loadPlayerNames(
	client: TransactionalClient,
	fantraxPlayerIds: readonly string[]
): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	if (fantraxPlayerIds.length === 0) return names;

	const result = await client.query(
		`select fantrax_player_id::text as fantrax_player_id, player_name
		from ${FREE_AGENT_PLAYERS_TABLE}
		where fantrax_player_id::text = any($1::text[])
		union all
		select fantrax_player_id::text as fantrax_player_id, player_name
		from ${TEAM_ROSTERS_TABLE}
		where fantrax_player_id::text = any($1::text[])`,
		[[...fantraxPlayerIds]]
	);
	for (const row of result.rows) {
		const id = row['fantrax_player_id'];
		const name = row['player_name'];
		if (typeof id !== 'string' || id === '') continue;
		if (typeof name !== 'string' || name === '') continue;
		if (names.has(id)) continue;
		names.set(id, name);
	}
	return names;
}

/**
 * Read the whole Audit Log.
 *
 * Throws on a read failure rather than returning an empty Log —
 * `server/board.ts`'s posture exactly, and it matters more here than anywhere:
 * an unreachable database and a League that has recorded nothing must never
 * render the same screen, because the second is a designed empty state saying
 * the Log is genuinely empty. On an audit surface, a silent empty result is
 * indistinguishable from a cover-up.
 */
export async function loadAuditLog(gateway: ConnectionGateway): Promise<AuditLogState> {
	const client = await gateway.connect();
	try {
		await client.query('begin');

		// ONE read of the log, and NO fold. `event-log.ts:98-118` warns this read
		// grows with the log; every page in this app already folds the whole log
		// on load (`server/phase.ts`), so the Log adds no new read cost, and the
		// remedy it names — a bounded read in that module — is a change to the
		// reader rather than to this surface.
		const events = await loadEventsViaClient(client);

		// The DATABASE clock, read exactly once and with no lock — Postgres'
		// transaction-start timestamp (AD-3).
		const clockResult = await client.query('select now() as now');
		const figuresAt = requireDatabaseClock(clockResult.rows[0]?.['now']).toISOString();

		// Built once WITHOUT names to learn every party id the Log names, then
		// rebuilt with the reference rows in hand. Two passes over an array
		// already in memory, rather than a statement per row.
		const bare = auditRowsFor(events, NO_REFERENCES);
		const { teamIds, playerIds, managerIds } = auditPartyIds(bare);

		const teamNames = await loadTeamNames(client, teamIds);
		const managerNames = await loadManagerNames(client, managerIds);
		const playerNames = await loadPlayerNames(client, playerIds);
		const references: AuditReferences = {
			teamNames,
			playerNames,
			managerNames
		};

		const rows = auditRowsFor(events, references);

		await client.query('rollback');

		return {
			rows,
			figuresAt,
			// Drawn from the WHOLE Log, never from a filtered view.
			teamOptions: auditTeamOptions(rows, references),
			playerOptions: auditPlayerOptions(rows, references),
			typeOptions: auditTypeOptions(rows)
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

/** The whole Log, the filter in force, and the rows that filter admits. */
export type FilteredAuditLog = {
	readonly log: AuditLogState;
	readonly filter: AuditFilter;
	/** Exactly what the page renders, and exactly what the CSV serialises. */
	readonly rows: readonly AuditRow[];
};

/**
 * Read the Log and apply the query string's three filters.
 *
 * ONE function for both entry points, so "the export carries the filters in
 * force and the same rendered content as the page" is a property of there
 * being one code path rather than of two paths agreeing. Neither entry point
 * may call this before its own `requireLiveDestination`, which each states by
 * name at the top of its handler.
 *
 * An unrecognised `type` is REFUSED here rather than ignored — a filter
 * silently dropped would hand a reader the whole Log while the control claimed
 * a filter was in force. Note the ORDER: the read happens first because the
 * type catalogue includes the types actually present in the log, so an event
 * type this story does not word is still a legal filter value.
 */
export async function readFilteredAuditLog(
	gateway: ConnectionGateway,
	searchParams: URLSearchParams
): Promise<FilteredAuditLog> {
	const log = await loadAuditLog(gateway);
	const outcome = parseAuditQuery(
		(key) => searchParams.get(key),
		log.typeOptions.map((option) => option.value)
	);
	if (!outcome.ok) error(UNKNOWN_TYPE_REFUSAL_STATUS, outcome.refusal);

	return {
		log,
		filter: outcome.filter,
		rows: filterAuditRows(log.rows, outcome.filter)
	};
}
