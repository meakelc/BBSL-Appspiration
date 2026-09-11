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
 * **One exception, added by Story 1.10:
 * `free_agent_players.minor_league_eligible` IS an event-sourced projection.**
 * It is the single app-owned column in either live table — every other column
 * is imported reference data — and it is the fold of
 * `MinorLeagueEligibilitySet` events, rebuildable from the log at any point.
 * Promotion therefore folds it here and writes it through
 * `applyEligibilityProjection`, the one writer that owns it. Neither half
 * generalises to the other: do not infer a rebuild contract for the rest of
 * these tables from that column, nor a mutable-reference-data licence for
 * that column from the rest.
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
import { INITIAL_ELIGIBILITY, eligibilityReducer } from '../core/projection/eligibility.ts';
import type { EligibilitySet } from '../core/projection/eligibility.ts';
import { INITIAL_PHASE, phaseReducer } from '../core/projection/phase.ts';
import { IMPORT_PROMOTED_EVENT } from '../core/projection/promotion.ts';
import { parseMoney } from '../core/money.ts';
import type { EventEnvelope, ParsedRosterRow } from '../core/types.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { applyEligibilityProjection } from './eligibility.ts';
import { loadEventsViaClient } from './event-log.ts';
import { toParsedRosterRow } from './staged-roster-row.ts';

/**
 * The event type appended on a successful promotion. Exactly one per promotion.
 *
 * Re-exported from the core projection that folds it rather than declared
 * again here. Two independent literals of the same name is how the writer and
 * the auction-open fold (`core/projection/promotion.ts`) silently drift apart:
 * rename one and every promotion appends an event the gate does not recognise,
 * so a fully promoted League refuses forever with "no import has been
 * promoted" — with a green suite, because each side asserts against its own
 * constant. One declaration makes that unrepresentable.
 */
export { IMPORT_PROMOTED_EVENT } from '../core/projection/promotion.ts';

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

/**
 * One staged pool Player as promotion loaded it.
 *
 * No eligibility field: Minor League Eligibility is NOT imported and is not
 * carried from staging (AR-33 — it is app-owned and absent from the Fantrax
 * file). Since Story 1.10 the live column is the fold of
 * `MinorLeagueEligibilitySet` events, applied below by the one writer that
 * owns that column.
 */
type LoadedPoolPlayer = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly positions: string;
	readonly nbaTeam: string;
	/** The row's position in the supplied CSV, carried across verbatim. */
	readonly sourceRank: number;
};

/** Everything `decide` needs, read under the lock in one transaction. */
export type PromotionState = {
	readonly phase: string;
	/**
	 * Minor League Eligibility as the log folds to it, right now, inside this
	 * transaction (Story 1.10). Promotion replaces the pool wholesale, so
	 * without this a re-import during Setup would silently revert every flag
	 * the Commissioner had set while the log still said otherwise.
	 */
	readonly eligible: EligibilitySet;
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
	// The same single read of the log, folded a second way. Both projections
	// come from one read inside one transaction, so they cannot disagree about
	// which events they saw.
	const eligible = fold(INITIAL_ELIGIBILITY, events, eligibilityReducer);

	const teamsResult = await client.query(
		`select t.id, t.name, s.status
		from teams t
		left join import_team_sources s on s.team_id = t.id
		order by t.name asc`
	);

	const rosterResult = await client.query(
		`select team_id, fantrax_player_id, player_name, cap_hit, roster_slot_kind,
			contract_years_remaining, rookie_scale_round
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

	// Ordered by the file's own rank, so promotion reads the pool in the
	// order the export stated rather than whatever order the planner returned
	// (AD-1 forbids incidental order). The rank is carried across as a column
	// regardless — this ordering is for the read, not for the storage.
	const poolResult = await client.query(
		`select fantrax_player_id, player_name, positions, nba_team, source_rank
		from import_staged_pool_players
		order by source_rank asc, player_name asc`
	);

	return {
		phase,
		eligible,
		teams,
		poolStatus: rawPoolStatus === null || rawPoolStatus === undefined ? null : String(rawPoolStatus),
		poolPlayers: poolResult.rows.map((row) => ({
			fantraxPlayerId: String(row['fantrax_player_id']),
			playerName: String(row['player_name']),
			positions: String(row['positions']),
			nbaTeam: String(row['nba_team']),
			sourceRank: Number(row['source_rank'])
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
 * Rows per multi-row INSERT when promoting to the live tables.
 *
 * Bounded rather than "everything in one statement" because a parameterised
 * query carries at most 65,535 bind parameters; at six columns per roster row a
 * single statement would cap out near 10,900 Players. 500 keeps a real
 * promotion to a handful of statements while leaving that ceiling far away.
 */
const LIVE_INSERT_BATCH = 500;

/** Split `items` into consecutive runs of at most `size`. */
function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
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

	// Written in BATCHES, not one statement per row (Story 9.7).
	//
	// This was a nested row-at-a-time loop, and it is the same defect the
	// staging paths carried: a real league is ~300 rostered Players and ~1,470
	// Free Agents, so promotion was ~1,770 sequential round trips inside one
	// transaction. Against Netlify's 10-second synchronous function budget that
	// is not a slow promotion, it is a killed one — reported as "This function
	// has crashed. An unknown error has occurred", which names nothing.
	//
	// Batching does not weaken the atomicity this function exists for. Every
	// statement here still runs inside the single transaction `promoteImport`
	// opened, so a failure anywhere still rolls the event and both tables back
	// together; only the number of round trips changes.
	const rosterRows = state.teams.flatMap((team) =>
		team.rows.map((row) => ({ teamId: team.teamId, row }))
	);
	for (const batch of chunk(rosterRows, LIVE_INSERT_BATCH)) {
		const values: unknown[] = [];
		const tuples = batch.map(({ teamId, row }, i) => {
			values.push(
				teamId,
				row.fantraxPlayerId,
				row.playerName,
				// Integer dollars, as an exact string: a `bigint` must never make
				// the round trip as a float.
				String(row.capHit),
				row.rosterSlotKind,
				row.contractYearsRemaining,
				// **The rookie-scale round reaches the LIVE table here** (Story
				// 7.8), which is the whole point of persisting it: FR-43's Drop
				// exception reads `team_rosters`, and until this column existed
				// the designation was discarded at staging and the exception was
				// unreachable. `null` for an ordinary Contract, written as the
				// adapter parsed it. Seven columns now, and the `at` stride and
				// the `$n` run move with the tuple width.
				row.rookieScaleRound
			);
			const at = i * 7;
			return `($${String(at + 1)}, $${String(at + 2)}, $${String(at + 3)}, $${String(at + 4)}, $${String(at + 5)}, $${String(at + 6)}, $${String(at + 7)})`;
		});
		await client.query(
			`insert into team_rosters
				(team_id, fantrax_player_id, player_name, cap_hit, roster_slot_kind,
				 contract_years_remaining, rookie_scale_round)
			values ${tuples.join(', ')}`,
			values
		);
	}

	// `source_rank` travels with the row rather than being recomputed from
	// the loop index: staging owns what the rank means, and re-deriving it
	// here from insert position would silently invent a second answer the
	// moment this read stopped being ordered.
	for (const batch of chunk(state.poolPlayers, LIVE_INSERT_BATCH)) {
		const values: unknown[] = [];
		const tuples = batch.map((player, i) => {
			values.push(
				player.fantraxPlayerId,
				player.playerName,
				player.positions,
				player.nbaTeam,
				player.sourceRank
			);
			const at = i * 5;
			return `($${String(at + 1)}, $${String(at + 2)}, $${String(at + 3)}, $${String(at + 4)}, $${String(at + 5)})`;
		});
		await client.query(
			`insert into free_agent_players
				(fantrax_player_id, player_name, positions, nba_team, source_rank)
			values ${tuples.join(', ')}`,
			values
		);
	}

	// Minor League Eligibility, folded from the log and written by the ONE
	// writer that owns this column (Story 1.10). The inserts above leave the
	// column at its `false` default deliberately: this column is an
	// event-sourced projection while every other column of the same table is
	// imported reference data that is never rebuilt from the log, and a second
	// place setting it is exactly how the two halves would come to disagree.
	// Inside the same transaction as the inserts, so a re-import during Setup
	// commits the pool and its folded eligibility together or not at all.
	await applyEligibilityProjection(client, state.eligible);
}
