/**
 * Minor League Eligibility: reading the pool for the surface, and the one
 * transaction that changes the flag. Server-only (Story 1.10).
 *
 * **The column is a projection; the rest of the table is not.** 1.9 is still
 * right that `free_agent_players` is mutable reference data — name,
 * positions and NBA team are imported and are never rebuilt from the log.
 * `minor_league_eligible` is the one column that is app-owned, and this
 * story requires it to be reproducible from the log at any point. So one
 * table holds a projection column and four reference columns, and neither
 * half generalises to the other. The same note sits at the promotion write
 * site (`import-promotion.ts`).
 *
 * **The column is written only through `applyEligibilityProjection`.** Here
 * it is registered as a `ProjectionUpdater`, so the write persists inside
 * the very transaction that appends the events it folds (AD-5); promotion
 * calls the same function after inserting the pool rows. There is no third
 * write path to this column, and adding one would be the point at which
 * "the column is the fold" stopped being true.
 *
 * **Every gate is re-derived inside the transaction.** The phase is folded
 * from the log through `phaseReducer` under the global lock — never taken
 * from `locals.phase`, which was resolved when the page loaded — and the
 * live pool is read on the same client, so an id that is not in the pool is
 * refused against the pool as it stands now. Refusals are returned values,
 * never throws (AD-1).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { fold } from '../core/projection/fold.ts';
import {
	INITIAL_ELIGIBILITY,
	MINOR_LEAGUE_ELIGIBILITY_SET,
	eligibilityReducer,
	isEligible
} from '../core/projection/eligibility.ts';
import type {
	EligibilitySet,
	MinorLeagueEligibilitySetPayload
} from '../core/projection/eligibility.ts';
import { INITIAL_PHASE, phaseReducer } from '../core/projection/phase.ts';
import {
	eligibilityRefusalDetail,
	eligibilityRowSentence,
	planEligibilityChanges
} from '../core/rules/eligibility.ts';
import type {
	EligibilityPlan,
	EligibilityRefusal,
	PooledPlayerEligibility
} from '../core/rules/eligibility.ts';
import type { EventEnvelope } from '../core/types.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { loadEventsViaClient } from './event-log.ts';
import { serviceRoleClient } from './supabase.ts';

const FREE_AGENT_PLAYERS_TABLE = 'free_agent_players';

/** Who acted, resolved server-side from application tables (AD-4). */
export type EligibilityActor = {
	readonly managerId: string;
	readonly teamId: string;
};

/**
 * One pooled Player as the surface prints them: identity, the current flag,
 * and the FINISHED consequence sentence.
 *
 * The sentence is rendered here rather than in `+page.svelte` for the reason
 * 1.9 settled at review-loop-iteration 1: the server renders, the surface
 * prints. A `.svelte` file may not reach a server-only module, and it
 * equally must not re-word a rule to work around that.
 */
export type EligibilityPoolRow = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly positions: string;
	readonly nbaTeam: string;
	readonly eligible: boolean;
	/** `eligibilityRowSentence`'s output, verbatim. */
	readonly consequence: string;
};

/** The whole pool as the surface receives it, sorted by Player name. */
export type EligibilityPool = {
	readonly players: readonly EligibilityPoolRow[];
};

type PoolRow = {
	readonly fantrax_player_id: string;
	readonly player_name: string;
	readonly positions: string;
	readonly nba_team: string;
	readonly minor_league_eligible: boolean;
};

/**
 * Read the live Free Agent pool for the surface, sorted by Player name.
 *
 * This is the READ path and it reads the live column, not the log: the
 * column is the fold, kept true by the one writer below, and re-folding the
 * whole log on every page view would be a second answer to the same
 * question. The transaction, which is the path that can act on the answer,
 * folds the log itself.
 *
 * An empty pool is a legitimate state — nothing has been promoted yet — and
 * comes back as an empty list for the surface to render as such, not as an
 * error.
 */
export async function loadEligibilityPool(
	client: SupabaseClient = serviceRoleClient()
): Promise<EligibilityPool> {
	const { data, error } = await client
		.from(FREE_AGENT_PLAYERS_TABLE)
		.select('fantrax_player_id, player_name, positions, nba_team, minor_league_eligible')
		.order('player_name', { ascending: true });

	if (error !== null) {
		throw new Error(`free_agent_players read failed: ${error.message}`);
	}

	const players = ((data ?? []) as PoolRow[]).map((row) => {
		const eligible = row.minor_league_eligible === true;
		return {
			fantraxPlayerId: row.fantrax_player_id,
			playerName: row.player_name,
			positions: row.positions,
			nbaTeam: row.nba_team,
			eligible,
			consequence: eligibilityRowSentence(row.player_name, eligible)
		};
	});

	return { players };
}

/**
 * Write `minor_league_eligible` for every pooled Player so the column equals
 * `eligible` exactly — the ONE writer of this column.
 *
 * One statement, not one per changed Player: the column IS the fold, so the
 * honest write is "make every row agree with the fold", which is also
 * idempotent and correct for a full rebuild. A Player absent from the set is
 * set to `false` rather than left alone, which is what makes the default
 * fail safe even for a Player who has never appeared in an event.
 *
 * `= any($1::text[])` is used rather than two statements so no window exists
 * — even inside the transaction — in which some rows are folded and others
 * are not.
 */
export async function applyEligibilityProjection(
	client: TransactionalClient,
	eligible: EligibilitySet
): Promise<void> {
	await client.query(
		`update ${FREE_AGENT_PLAYERS_TABLE}
		set minor_league_eligible = (fantrax_player_id = any($1::text[]))`,
		[[...eligible]]
	);
}

/** Everything `decide` needs, read under the lock in one transaction. */
export type EligibilityState = {
	readonly phase: string;
	/** The live pool, each Player carrying their value AS FOLDED from the log. */
	readonly pool: readonly PooledPlayerEligibility[];
	/** The fold of the log, which is the state the projection extends. */
	readonly eligible: EligibilitySet;
};

/**
 * Read the phase and the live pool on the locked transaction's own client.
 *
 * Both projections are folded from the same single read of the log, in the
 * same transaction, before any decision is taken. Each Player's CURRENT
 * value comes from that fold rather than from the column, so a "before"
 * value in the Audit Log is the log's own account of itself.
 */
async function loadEligibilityState(client: TransactionalClient): Promise<EligibilityState> {
	const events = await loadEventsViaClient(client);
	const phase = fold(INITIAL_PHASE, events, phaseReducer);
	const eligible = fold(INITIAL_ELIGIBILITY, events, eligibilityReducer);

	const poolResult = await client.query(
		`select fantrax_player_id, player_name
		from ${FREE_AGENT_PLAYERS_TABLE}
		order by player_name asc`
	);

	const pool = poolResult.rows.map((row) => {
		const fantraxPlayerId = String(row['fantrax_player_id']);
		return {
			fantraxPlayerId,
			playerName: String(row['player_name']),
			eligible: isEligible(eligible, fantraxPlayerId)
		};
	});

	return { phase, pool, eligible };
}

/**
 * The gates, in order: phase, then the empty selection, then unknown ids.
 *
 * Phase first, for `refusePromotion`'s reason: once the auction has opened,
 * which ids were submitted is beside the point. Exported so a test can drive
 * the ordering as pure logic rather than infer it.
 */
export function refuseEligibilityChange(
	state: EligibilityState,
	ids: readonly string[],
	plan: EligibilityPlan
): EligibilityRefusal | null {
	if (state.phase !== 'Setup') return { kind: 'phase', phase: state.phase };
	if (ids.length === 0) return { kind: 'empty_selection' };
	if (plan.unknownIds.length > 0) {
		return { kind: 'unknown_players', fantraxPlayerIds: plan.unknownIds };
	}
	return null;
}

/** What a rejection carries back to the route: the refusal and its one sentence. */
export type EligibilityRejection = {
	readonly refusal: EligibilityRefusal;
	readonly detail: string;
};

/**
 * The outcome of a change: the pipeline's own `WriteOutcome`, plus the plan
 * the transaction decided from.
 *
 * The plan travels separately because `WriteOutcome` carries only events,
 * and the unchanged Players — the ones that deliberately produced NO event —
 * still have to be reported. `plan` is null when the change was refused
 * before a plan was formed.
 */
export type SetEligibilityResult = {
	readonly outcome: WriteOutcome;
	readonly plan: EligibilityPlan | null;
};

/**
 * Set or unset Minor League Eligibility for the named Players, in one
 * transaction.
 *
 * One event per CHANGED Player — not one per submit. "Before and after
 * values" is a per-Player fact and the reducer folds per Player, so a bulk of
 * forty is up to forty events in one transaction. That is the correct Audit
 * Log record and a Setup-only cost.
 *
 * A submission in which every Player already holds the target value is
 * ACCEPTED with zero events: nothing changed, nothing is recorded, and the
 * plan reports each Player as unchanged.
 */
export async function setEligibility(
	gateway: ConnectionGateway,
	actor: EligibilityActor,
	ids: readonly string[],
	target: boolean
): Promise<SetEligibilityResult> {
	// Captured for the projection, which receives only the client and the
	// appended events: the fold must extend the state `decide` decided from,
	// not a second read.
	let loaded: EligibilityState | undefined;
	// Held in an object rather than a bare `let`: TypeScript does not track an
	// assignment made inside the `decide` callback, so a plain variable would
	// read back as its initialiser's type at the return statement.
	const planned: { current: EligibilityPlan | null } = { current: null };

	const outcome = await runTransactionalWrite<EligibilityState>({
		gateway,
		load: async (client) => {
			loaded = await loadEligibilityState(client);
			return loaded;
		},
		decide: ({ state }) => {
			const candidate = planEligibilityChanges(state.pool, ids, target);
			const refusal = refuseEligibilityChange(state, ids, candidate);
			if (refusal !== null) {
				const rejection: EligibilityRejection = {
					refusal,
					detail: eligibilityRefusalDetail(refusal)
				};
				return { kind: 'rejected', reason: rejection };
			}

			planned.current = candidate;
			const events: EventEnvelope[] = candidate.changes.map((change) => {
				const payload: MinorLeagueEligibilitySetPayload = {
					fantraxPlayerId: change.fantraxPlayerId,
					playerName: change.playerName,
					before: change.before,
					after: change.after
				};
				return {
					type: MINOR_LEAGUE_ELIGIBILITY_SET,
					payload,
					managerId: actor.managerId,
					teamId: actor.teamId
				};
			});
			return { kind: 'accepted', events };
		},
		projections: [
			async (client, appended) => {
				if (loaded === undefined) {
					// Unreachable: `runTransactionalWrite` runs `load` before any
					// projection and rolls back if it throws. The guard fails loudly
					// rather than clearing every flag in the pool if that changes.
					throw new Error('setEligibility: the projection ran before load completed');
				}
				// The fold of the just-appended events onto the state loaded under
				// the lock — the same `fold()` a full rebuild from `INITIAL_ELIGIBILITY`
				// would call, with the same reducer (AD-5).
				const next = fold(loaded.eligible, appended, eligibilityReducer);
				await applyEligibilityProjection(client, next);
			}
		]
	});

	return { outcome, plan: outcome.kind === 'accepted' ? planned.current : null };
}
