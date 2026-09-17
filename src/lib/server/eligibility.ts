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
 * **The column is the fold RESTRICTED TO THE POOL, and the fold is the
 * authority.** The flag can also be set on a rostered Contract, which has no
 * column on `team_rosters` to hold it — so `EligibilitySet`, folded from the
 * log and keyed by Fantrax player id, is the only complete answer, and it is
 * what every rule reads (`isEligible`, at eleven call sites). The column
 * materialises the pooled subset of that fold and nothing else. Do not read
 * it to decide anything: `loadEligibilityPool` reads it to RENDER the pooled
 * half of one Commissioner-only list, and that is its whole remaining job.
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
	eligibilityPoolWithheldSentence,
	eligibilityRefusalDetail,
	eligibilityRowSentence,
	planEligibilityChanges,
	pooledAmong
} from '../core/rules/eligibility.ts';
import type {
	EligibilityCandidate,
	EligibilityPlan,
	EligibilityRefusal
} from '../core/rules/eligibility.ts';
import { SLOT_LABELS } from '../core/rules/roster-import.ts';
import type { EventEnvelope, RosterSlotKind } from '../core/types.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { PAGE_SIZE, loadAppendedEvents, loadEventsViaClient } from './event-log.ts';
import type { LeaguePhase } from './phase.ts';
import { serviceRoleClient } from './supabase.ts';

const FREE_AGENT_PLAYERS_TABLE = 'free_agent_players';
const TEAM_ROSTERS_TABLE = 'team_rosters';
const TEAMS_TABLE = 'teams';

/** Who acted, resolved server-side from application tables (AD-4). */
export type EligibilityActor = {
	readonly managerId: string;
	readonly teamId: string;
};

/**
 * One Player the surface prints: identity, the current flag, and the FINISHED
 * consequence sentence.
 *
 * The sentence is rendered here rather than in `+page.svelte` for the reason
 * 1.9 settled at review-loop-iteration 1: the server renders, the surface
 * prints. A `.svelte` file may not reach a server-only module, and it
 * equally must not re-word a rule to work around that.
 *
 * `detail` and `heldBy` are finished cell text for the same reason, and they
 * are two strings rather than the four columns this row carried while the
 * list was pool-only. A pooled Player has Positions and an NBA team; a
 * rostered Contract has a Slot and the Team holding it, and neither shape has
 * the other's columns. Wording both here keeps the narrow layout's
 * "every cell states its own word" rule true without the surface branching on
 * where a row came from.
 */
export type EligibilityPoolRow = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** What this Player is, in the list's own words. */
	readonly detail: string;
	/** Where this Player is: the Free Agent pool, or the Team holding them. */
	readonly heldBy: string;
	readonly eligible: boolean;
	/** `eligibilityRowSentence`'s output, verbatim. */
	readonly consequence: string;
};

/** Everything the flag can be set on, as the surface receives it, by name. */
export type EligibilityPool = {
	readonly players: readonly EligibilityPoolRow[];
	/**
	 * Why the Free Agent pool is absent from `players`, or `null` in Setup
	 * where it is present. `eligibilityPoolWithheldSentence`'s output,
	 * verbatim — the surface prints it and never re-words it.
	 */
	readonly poolWithheld: string | null;
};

type PoolRow = {
	readonly fantrax_player_id: string;
	readonly player_name: string;
	readonly positions: string;
	readonly nba_team: string;
	readonly minor_league_eligible: boolean;
};

type RosterRow = {
	readonly fantrax_player_id: string;
	readonly player_name: string;
	readonly roster_slot_kind: RosterSlotKind;
	readonly team_id: string;
};

type TeamRow = { readonly id: string; readonly name: string };

type PagedResponse = { data: unknown; error: { message: string } | null };

/**
 * Read every row of a table, paging until a page comes back empty.
 *
 * **A single unbounded `select` silently truncates.** PostgREST enforces its
 * own configured row cap — 1,000 by default — regardless of what a request
 * asks for, and a page with 1,467 pooled Players got the first 1,000 and no
 * error. On a page whose whole job is ticking the right Players, the 467 that
 * never rendered could not be set, and nothing said so.
 *
 * The loop is `loadAppendedEvents`' and so is its reasoning: terminate on an
 * EMPTY page rather than a short one, and advance `offset` by the page's
 * actual length rather than by the assumed `PAGE_SIZE`, because the cap is a
 * deployment setting this module cannot read and may be smaller than the page
 * asked for. Every caller must order by a stable key, or paging re-reads and
 * skips rows across pages.
 */
async function readEveryRow<Row>(
	label: string,
	page: (from: number, to: number) => PromiseLike<PagedResponse>
): Promise<Row[]> {
	const rows: Row[] = [];
	let offset = 0;

	for (;;) {
		const { data, error } = await page(offset, offset + PAGE_SIZE - 1);
		if (error !== null) throw new Error(`${label} read failed: ${error.message}`);
		if (!Array.isArray(data)) {
			throw new Error(`${label} read failed: response was not an array`);
		}
		if (data.length === 0) break;
		for (const row of data as Row[]) rows.push(row);
		offset += data.length;
	}

	return rows;
}

/**
 * Every rostered Contract as a surface row, with its flag folded from the log.
 *
 * A Contract that is ALSO in the pool is skipped: the two tables should be
 * disjoint, but if they ever disagree the pooled row already states the same
 * Player, and two rows for one Player would post `ids` twice and read as two
 * different men on a page whose whole job is picking the right ones.
 *
 * The Team name comes from a second read rather than a PostgREST embed: the
 * embed would depend on the foreign key's generated relationship name, which
 * is schema trivia this module has no other reason to know.
 */
async function loadRosteredCandidates(
	client: SupabaseClient,
	pooledIds: ReadonlySet<string>
): Promise<EligibilityPoolRow[]> {
	const all = await readEveryRow<RosterRow>(TEAM_ROSTERS_TABLE, (from, to) =>
		client
			.from(TEAM_ROSTERS_TABLE)
			.select('fantrax_player_id, player_name, roster_slot_kind, team_id')
			.order('fantrax_player_id', { ascending: true })
			.range(from, to)
	);

	const rostered = all.filter((row) => !pooledIds.has(row.fantrax_player_id));
	if (rostered.length === 0) return [];

	const teams = await readEveryRow<TeamRow>(TEAMS_TABLE, (from, to) =>
		client.from(TEAMS_TABLE).select('id, name').order('id', { ascending: true }).range(from, to)
	);

	const teamNames = new Map(teams.map((row) => [row.id, row.name]));

	// The fold, for the half of the list no column materialises. Same reducer
	// and same `fold()` the transaction uses, so the two answers cannot drift.
	const eligibility = fold(
		INITIAL_ELIGIBILITY,
		await loadAppendedEvents(client),
		eligibilityReducer
	);

	return rostered.map((row) => {
		const eligible = isEligible(eligibility, row.fantrax_player_id);
		return {
			fantraxPlayerId: row.fantrax_player_id,
			playerName: row.player_name,
			detail: `${SLOT_LABELS[row.roster_slot_kind]} Slot`,
			heldBy: teamNames.get(row.team_id) ?? 'an unnamed Team',
			eligible,
			consequence: eligibilityRowSentence(row.player_name, eligible)
		};
	});
}

/**
 * Read everything the flag can be set on — the live Free Agent pool AND every
 * rostered Contract — for the surface, sorted by Player name.
 *
 * **Why the column cannot answer for a rostered Contract.**
 * `minor_league_eligible` lives on `free_agent_players` and there is no such
 * column on `team_rosters`. The AUTHORITATIVE answer was never the column: it
 * is `EligibilitySet`, folded from the log, which is keyed by Fantrax player
 * id and has never cared whether that id is in the pool. So the pool half of
 * this list reads its flag from the column as it always has, and the roster
 * half folds the log for the same fact. Both halves are the same fold; they
 * differ only in whether a materialised copy of it existed to read.
 *
 * Three reads rather than one join: PostgREST cannot express the union, and
 * this is a Commissioner-only page that renders once per Setup-phase visit.
 *
 * An empty pool is a legitimate state — nothing has been promoted yet — and
 * an empty roster set likewise. Both come back as an empty list for the
 * surface to render as such, not as an error.
 *
 * **`phase` decides whether the pool half is listed at all.** Outside Setup
 * the transaction refuses a pooled Player, so offering one a checkbox would
 * be offering a control whose only outcome is a refusal. The rostered half is
 * listed in every phase because the transaction accepts it in every phase.
 * This is a RENDERING decision and not a gate: `refuseEligibilityChange`
 * re-derives the same rule from the log inside the transaction, so a page
 * that rendered during Setup cannot race a pooled change past an auction that
 * has since opened, exactly as before.
 */
export async function loadEligibilityPool({
	phase,
	client = serviceRoleClient()
}: {
	/**
	 * Typed as `LeaguePhase`, not `string`, and named rather than positional.
	 * Both are deliberate: this function used to take the client as its only
	 * argument, so a positional `phase` would have let every existing caller
	 * keep compiling with a `SupabaseClient` bound to it — and the phase is
	 * interpolated into a sentence, so the failure would have shipped as
	 * "The phase is [object Object]" rather than as a type error.
	 */
	readonly phase: LeaguePhase;
	readonly client?: SupabaseClient;
}): Promise<EligibilityPool> {
	const pooled = await readEveryRow<PoolRow>(FREE_AGENT_PLAYERS_TABLE, (from, to) =>
		client
			.from(FREE_AGENT_PLAYERS_TABLE)
			.select('fantrax_player_id, player_name, positions, nba_team, minor_league_eligible')
			.order('fantrax_player_id', { ascending: true })
			.range(from, to)
	);

	const pooledIds = new Set(pooled.map((row) => row.fantrax_player_id));

	// **Outside Setup the pool is READ and then withheld, not skipped.** The
	// read still happens because `pooledIds` is what keeps a Contract that is
	// somehow in both tables from rendering twice, and because the sentence
	// below counts the Players it is declining to list. Dropping the read to
	// save it would trade a correct list for one query on a Commissioner-only
	// page that renders once a visit.
	const withheld = phase === 'Setup' ? null : eligibilityPoolWithheldSentence(phase, pooled.length);

	const players: EligibilityPoolRow[] =
		withheld !== null
			? []
			: pooled.map((row) => {
					const eligible = row.minor_league_eligible === true;
					return {
						fantraxPlayerId: row.fantrax_player_id,
						playerName: row.player_name,
						detail: `Positions: ${row.positions}`,
						heldBy: `Free Agent pool · ${row.nba_team}`,
						eligible,
						consequence: eligibilityRowSentence(row.player_name, eligible)
					};
				});

	for (const row of await loadRosteredCandidates(client, pooledIds)) {
		players.push(row);
	}

	// One sort over the merged list, so a rostered Contract files alphabetically
	// among the pooled Players rather than in a block after them.
	players.sort((left, right) => left.playerName.localeCompare(right.playerName));

	return { players, poolWithheld: withheld };
}

/**
 * Write `minor_league_eligible` for every pooled Player so the column equals
 * `eligible` exactly — the ONE writer of this column.
 *
 * One statement, not one per changed Player: the column IS the fold
 * restricted to the pool, so the honest write is "make every row agree with
 * the fold", which is also idempotent and correct for a full rebuild. A
 * Player absent from the set is set to `false` rather than left alone, which
 * is what makes the default fail safe even for a Player who has never
 * appeared in an event.
 *
 * An id in `eligible` that names a rostered Contract rather than a pooled
 * Player matches no row and writes nothing, which is correct and needs no
 * filtering: the fold already holds that Player's flag, and this statement
 * only ever materialises the part of it the pool can carry.
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
	/**
	 * Everything the flag can be set on — pooled Players AND rostered
	 * Contracts — each carrying their value AS FOLDED from the log.
	 */
	readonly candidates: readonly EligibilityCandidate[];
	/** The fold of the log, which is the state the projection extends. */
	readonly eligible: EligibilitySet;
};

/**
 * Read the phase and the live candidate set on the locked transaction's own
 * client.
 *
 * Both projections are folded from the same single read of the log, in the
 * same transaction, before any decision is taken. Each Player's CURRENT
 * value comes from that fold rather than from the column, so a "before"
 * value in the Audit Log is the log's own account of itself — and it is why
 * a rostered Contract, which has no column anywhere to read, needs no special
 * handling here at all.
 *
 * **The candidate set is the union, and `free_agent_players` wins a tie.**
 * The two tables are disjoint in practice — a Player is in the pool or on a
 * Roster, not both — but `distinct on` makes that a property of this query
 * rather than an assumption about the data. A duplicate id would otherwise
 * put one Player in the plan twice and write two events for him in one
 * transaction, the second carrying a `before` that was already stale.
 */
async function loadEligibilityState(client: TransactionalClient): Promise<EligibilityState> {
	const events = await loadEventsViaClient(client);
	const phase = fold(INITIAL_PHASE, events, phaseReducer);
	const eligible = fold(INITIAL_ELIGIBILITY, events, eligibilityReducer);

	const candidateResult = await client.query(
		`select fantrax_player_id, player_name, source
		from (
			select distinct on (fantrax_player_id) fantrax_player_id, player_name, source
			from (
				select fantrax_player_id, player_name, 0 as source from ${FREE_AGENT_PLAYERS_TABLE}
				union all
				select fantrax_player_id, player_name, 1 as source from ${TEAM_ROSTERS_TABLE}
			) both_sources
			order by fantrax_player_id, source
		) deduped
		order by player_name asc`
	);

	// `source` was always selected in the inner query, to make `distinct on`
	// deterministic; it is carried out to the caller now because the phase gate
	// asks which table a candidate came from. `0` is the pool — the same tie
	// the `distinct on` resolves in the pool's favour above, read the same way
	// here, so one Player appearing in both tables is POOLED for the gate as
	// well as for the plan. That is the safe direction: a duplicate is refused
	// outside Setup rather than quietly changed.
	const candidates = candidateResult.rows.map((row) => {
		const fantraxPlayerId = String(row['fantrax_player_id']);
		return {
			fantraxPlayerId,
			playerName: String(row['player_name']),
			eligible: isEligible(eligible, fantraxPlayerId),
			pooled: Number(row['source']) === 0
		};
	});

	return { phase, candidates, eligible };
}

/**
 * The gates, in order: the empty selection, then unknown ids, then the phase.
 *
 * **Phase is LAST now, and the reorder is the point of this gate's narrowing.**
 * It used to run first on `refusePromotion`'s reasoning — "once the auction
 * has opened, which ids were submitted is beside the point". That reasoning
 * died with FR-44. Which ids were submitted is now exactly the point: the
 * phase refuses a POOLED Player, because FR-35 binds a pooled Player's flag to
 * the Committed Bids of an open Auction, and it refuses a rostered Contract
 * not at all, because `teamMoneyStateFor` partitions `auctions.byPlayer` and a
 * rostered Contract can never appear there. A gate that cannot answer without
 * knowing which ids were submitted cannot run before they are classified, and
 * an id that names nothing has no classification — so `unknown_players` is
 * resolved first and a ghost can never slip past the phase on its way to it.
 *
 * The empty selection stays ahead of both: it names no Player, so neither of
 * the other two has anything to look at.
 *
 * **Every phase gates pooled Players identically.** The narrowing is pooled
 * vs rostered, never Setup vs Auction vs Contract Assignment — a pooled Player
 * is refused in every phase but Setup, and a rostered Contract is refused in
 * none.
 *
 * Exported so a test can drive the ordering as pure logic rather than infer it.
 */
export function refuseEligibilityChange(
	state: EligibilityState,
	ids: readonly string[],
	plan: EligibilityPlan
): EligibilityRefusal | null {
	if (ids.length === 0) return { kind: 'empty_selection' };
	if (plan.unknownIds.length > 0) {
		return { kind: 'unknown_players', fantraxPlayerIds: plan.unknownIds };
	}
	if (state.phase !== 'Setup') {
		const pooled = pooledAmong(state.candidates, ids);
		if (pooled.length > 0) {
			return { kind: 'phase', phase: state.phase, fantraxPlayerIds: pooled };
		}
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
			const candidate = planEligibilityChanges(state.candidates, ids, target);
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
