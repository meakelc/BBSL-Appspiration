/**
 * Promotion: all thirty-one staged sources committed to the live reference
 * tables in ONE transaction, or none of them. Server-only (Story 1.9).
 *
 * **Why this goes through `runTransactionalWrite` while staging deliberately
 * does not.** 1.7 and 1.8 stage per source with a local transaction and no
 * lock, because a file never contends with another source's rows and no
 * event is appended. Promotion is the opposite on every count: it spans all
 * thirty-one sources at once, it must be excluded from anything else writing
 * the log, it must READ THE PHASE FROM THE LOG to refuse after the auction
 * opens, and FR-1 requires its outcome in the Audit Log — which is a read of
 * `auction_events`. That is exactly lock -> load -> decide -> persist ->
 * enqueue (`shell/write.ts`).
 *
 * **The live-table write is the `projections` seam, and it is NOT a
 * projection.** Story 1.5 defined `ProjectionUpdater` and registered nothing
 * against it, noting "the story that first reads a projection is the first
 * to pass one". This is the first registration in the codebase — and the
 * live reference tables are mutable reference data by decision ("the world
 * is not event-sourced, only the auction is"), never rebuilt from the log.
 * The seam is used because it is the one hook that persists INSIDE the
 * appending transaction (AD-5), which is precisely what all-or-nothing
 * requires. A later reader must not infer a rebuild contract from this call
 * site: there is none, and no rebuild of these tables from the log exists or
 * is intended.
 *
 * **Every gate is re-derived here, server-side, inside the transaction.** The
 * confirm checkbox on the page is never the check, and neither is
 * `locals.phase` — that was folded when the page loaded and says nothing
 * about what the log holds now. A refusal is a returned value, never a throw
 * (AD-1); a throw out of any of this rolls the whole transaction back and
 * leaves the live tables and every staged source exactly as they were.
 */

import { previewTeam, promotionRefusalDetail } from '../core/rules/import-preview.ts';
import type { PromotionRefusal, TeamSlotBreach } from '../core/rules/import-preview.ts';
import { POOL_SOURCE_LABEL } from '../core/rules/pool-import.ts';
import { fold } from '../core/projection/fold.ts';
import { INITIAL_PHASE, phaseReducer } from '../core/projection/phase.ts';
import { parseMoney } from '../core/money.ts';
import type { EventEnvelope, ParsedRosterRow } from '../core/types.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { loadEventsViaClient } from './event-log.ts';
import { toParsedRosterRow } from './staged-roster-row.ts';

/** The event type appended on a successful promotion. Exactly one per promotion. */
export const IMPORT_PROMOTED_EVENT = 'ImportPromoted';

/** Who acted, resolved server-side from application tables (AD-4). */
export type PromotionActor = {
	readonly managerId: string;
	readonly teamId: string;
};

/** One Team as promotion loaded it: identity, staged status, staged rows. */
type LoadedTeam = {
	readonly teamId: string;
	readonly teamName: string;
	readonly status: string | null;
	readonly rows: readonly ParsedRosterRow[];
};

/** One staged pool Player as promotion loaded it. */
type LoadedPoolPlayer = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly positions: string;
	readonly nbaTeam: string;
	readonly minorLeagueEligible: boolean;
};

/** Everything `decide` needs, read under the lock in one transaction. */
export type PromotionState = {
	readonly phase: string;
	readonly teams: readonly LoadedTeam[];
	readonly poolStatus: string | null;
	readonly poolPlayers: readonly LoadedPoolPlayer[];
};

/**
 * Read the phase, every Team's staged status and rows, and the pool's status
 * and rows — all on the locked transaction's own client.
 *
 * Sorted by Team name so the refusal sentences and the event payload come
 * out in a stated order rather than whatever order the planner returned
 * (AD-1 forbids incidental order).
 */
async function loadPromotionState(client: TransactionalClient): Promise<PromotionState> {
	const events = await loadEventsViaClient(client);
	const phase = fold(INITIAL_PHASE, events, phaseReducer);

	const teamsResult = await client.query(
		`select t.id, t.name, s.status
		from teams t
		left join import_team_sources s on s.team_id = t.id
		order by t.name asc`
	);

	const rosterResult = await client.query(
		`select team_id, fantrax_player_id, player_name, cap_hit, roster_slot_kind,
			contract_years_remaining
		from import_staged_rosters`
	);

	const rowsByTeam = new Map<string, ParsedRosterRow[]>();
	for (const row of rosterResult.rows) {
		const teamId = String(row['team_id']);
		const parsed = toParsedRosterRow(row);
		const existing = rowsByTeam.get(teamId);
		if (existing === undefined) rowsByTeam.set(teamId, [parsed]);
		else existing.push(parsed);
	}

	const teams: LoadedTeam[] = teamsResult.rows.map((row) => {
		const teamId = String(row['id']);
		const status = row['status'];
		return {
			teamId,
			teamName: String(row['name']),
			status: status === null || status === undefined ? null : String(status),
			rows: rowsByTeam.get(teamId) ?? []
		};
	});

	const poolSourceResult = await client.query('select status from import_pool_source');
	const rawPoolStatus = poolSourceResult.rows[0]?.['status'];

	const poolResult = await client.query(
		`select fantrax_player_id, player_name, positions, nba_team, minor_league_eligible
		from import_staged_pool_players`
	);

	return {
		phase,
		teams,
		poolStatus: rawPoolStatus === null || rawPoolStatus === undefined ? null : String(rawPoolStatus),
		poolPlayers: poolResult.rows.map((row) => ({
			fantraxPlayerId: String(row['fantrax_player_id']),
			playerName: String(row['player_name']),
			positions: String(row['positions']),
			nbaTeam: String(row['nba_team']),
			// Carried across exactly as staged — promotion never sets, derives or
			// edits Minor League Eligibility (1.10 owns that). The staged value is
			// the column's `false` default until 1.10 exists to change it.
			minorLeagueEligible: row['minor_league_eligible'] === true
		}))
	};
}

/**
 * The three gates, in order: phase, then outstanding sources, then slot
 * ceilings. Returns the refusal, or `null` when every gate holds.
 *
 * Phase goes first deliberately — once the auction has opened, the state of
 * staging is beside the point, and "the phase is Auction" is the honest
 * answer rather than a list of files.
 *
 * Exported so a test can drive every gate as pure logic, and so the ordering
 * itself is assertable rather than implied.
 */
export function refusePromotion(state: PromotionState): PromotionRefusal | null {
	if (state.phase !== 'Setup') {
		return { kind: 'phase', phase: state.phase };
	}

	const outstanding: string[] = state.teams
		.filter((team) => team.status !== 'staged')
		.map((team) => team.teamName);
	if (state.poolStatus !== 'staged') outstanding.push(POOL_SOURCE_LABEL);
	if (outstanding.length > 0) {
		return { kind: 'outstanding', sourceNames: outstanding };
	}

	const breaching: TeamSlotBreach[] = [];
	for (const team of state.teams) {
		const preview = previewTeam(team.rows);
		if (preview.breaches.length > 0) {
			breaching.push({ teamName: team.teamName, breaches: preview.breaches });
		}
	}
	if (breaching.length > 0) return { kind: 'breach', teams: breaching };

	return null;
}

/**
 * What a rejection carries back to the route: the machine-readable refusal
 * and the one rendered sentence, so the route never words it itself.
 */
export type PromotionRejection = {
	readonly refusal: PromotionRefusal;
	readonly detail: string;
};

/**
 * The `ImportPromoted` payload: what was committed, per source, named. The
 * event's actor, timestamp, `schemaVersion` and `coreVersion` are columns
 * `runTransactionalWrite` fills from the database clock and the pinned
 * constants — never restated here.
 */
export type ImportPromotedPayload = {
	readonly teams: ReadonlyArray<{
		readonly teamId: string;
		readonly teamName: string;
		readonly rosterCount: number;
	}>;
	readonly poolSize: number;
};

/**
 * Promote every staged source to the live reference tables, in one
 * transaction or none.
 *
 * Returns the pipeline's own `WriteOutcome`: `accepted` with the single
 * appended `ImportPromoted` event, or `rejected` carrying a
 * `PromotionRejection`. A thrown error — a unique-constraint violation from
 * the same Player appearing on two Teams' rosters, say — propagates after
 * the transaction has rolled back, leaving the live tables and every staged
 * source untouched.
 */
export async function promoteImport(
	gateway: ConnectionGateway,
	actor: PromotionActor
): Promise<WriteOutcome> {
	// `decide` and the projection both need the loaded state, and the
	// `ProjectionUpdater` signature carries only the client and the appended
	// events. Capturing it here is what lets the live write use exactly the
	// rows `decide` accepted — re-reading them inside the projection would be
	// a second place deciding what gets written.
	let loaded: PromotionState | undefined;

	return runTransactionalWrite<PromotionState>({
		gateway,
		load: async (client) => {
			loaded = await loadPromotionState(client);
			return loaded;
		},
		decide: ({ state }) => {
			const refusal = refusePromotion(state);
			if (refusal !== null) {
				const rejection: PromotionRejection = {
					refusal,
					detail: promotionRefusalDetail(refusal)
				};
				return { kind: 'rejected', reason: rejection };
			}

			const payload: ImportPromotedPayload = {
				teams: state.teams.map((team) => ({
					teamId: team.teamId,
					teamName: team.teamName,
					rosterCount: team.rows.length
				})),
				poolSize: state.poolPlayers.length
			};

			const event: EventEnvelope = {
				type: IMPORT_PROMOTED_EVENT,
				payload,
				managerId: actor.managerId,
				teamId: actor.teamId
			};
			return { kind: 'accepted', events: [event] };
		},
		projections: [
			async (client) => {
				if (loaded === undefined) {
					// Unreachable: `runTransactionalWrite` runs `load` before any
					// projection and rolls back if it throws. The guard exists to fail
					// loudly rather than write an empty League if that ever changes.
					throw new Error('promoteImport: the projection ran before load completed');
				}
				await writeLiveTables(client, loaded);
			}
		]
	});
}

/**
 * Replace the live reference tables wholesale, on the appending
 * transaction's own client.
 *
 * Delete-then-insert, no predicate on either delete: re-import during Setup
 * replaces live state ENTIRELY, and "nothing from a previous promotion
 * survives" is true by construction rather than by a correctly-written WHERE
 * clause. Both deletes and every insert are inside the one transaction that
 * appends the event, so a failure anywhere — including `team_rosters`'
 * cross-Team unique constraint on `fantrax_player_id` catching the same
 * Player on two rosters — rolls back the event and both tables together.
 */
async function writeLiveTables(client: TransactionalClient, state: PromotionState): Promise<void> {
	await client.query('delete from team_rosters');
	await client.query('delete from free_agent_players');

	for (const team of state.teams) {
		for (const row of team.rows) {
			await client.query(
				`insert into team_rosters
					(team_id, fantrax_player_id, player_name, cap_hit, roster_slot_kind,
					 contract_years_remaining)
				values ($1, $2, $3, $4, $5, $6)`,
				[
					team.teamId,
					row.fantraxPlayerId,
					row.playerName,
					// Integer dollars, as an exact string: a `bigint` must never make
					// the round trip as a float.
					String(row.capHit),
					row.rosterSlotKind,
					row.contractYearsRemaining
				]
			);
		}
	}

	for (const player of state.poolPlayers) {
		await client.query(
			`insert into free_agent_players
				(fantrax_player_id, player_name, positions, nba_team, minor_league_eligible)
			values ($1, $2, $3, $4, $5)`,
			[
				player.fantraxPlayerId,
				player.playerName,
				player.positions,
				player.nbaTeam,
				// Carried across, never derived: 1.10 owns changing this.
				player.minorLeagueEligible
			]
		);
	}
}
