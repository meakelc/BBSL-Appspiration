/**
 * The Drop command: one transaction, one `DropRecorded`, and one `UPDATE` or
 * one `DELETE` per released Contract (Story 7.8, FR-43).
 *
 * **One transaction under the global write lock, and that is the requirement
 * rather than an implementation detail.** A Drop that released two Players of
 * three is never a reachable state, so the event and every `team_rosters` row
 * travel together through `runTransactionalWrite`: the lock is taken before
 * anything is read (AD-6), the gates are re-derived inside it from the log
 * and the tables the transaction itself read, and the rows are written
 * through the `ProjectionUpdater` seam before `COMMIT`.
 *
 * **Two statements, one rule.** A released Contract is reclassified
 * `dead_money` if it carries anything and removed if it carries nothing, and
 * `rules/roster-drop.ts` is what decided which — this file applies the
 * payload verbatim and re-derives neither the amount nor the fate. The
 * `UPDATE` keeps the row's own `cap_hit`: a Dead Money row charges in full,
 * and the charged figure for the kinds that survive IS the stored figure, so
 * there is nothing to rewrite. A `minor_league` row never reaches the
 * `UPDATE` at all — it was charging `$0` and is removed.
 *
 * **Only an Existing Contract can be dropped, which is why there is no third
 * case.** `evaluateDrop` refuses a won Player as a shape refusal, so every
 * release has a `team_rosters` row. `contractsReducer` therefore needs no
 * `DropRecorded` case, and `projection/contracts.ts` states that dependency
 * at both ends.
 *
 * **No `enqueue`.** A Drop is not broadcast to Discord — it is recorded in
 * the league-visible Audit Log instead, exactly as a Roster Move is. Being
 * off Discord is therefore a property of this file's shape rather than a
 * setting somebody could flip.
 *
 * The actor is resolved server-side from the session (AD-4/AD-15) and never
 * from a form field; the route is the one place that narrowing happens, and
 * the reason is validated there by `requireOverrideReason` before this
 * function is called.
 */

import { fold } from '../core/projection/fold.ts';
import { INITIAL_AUCTIONS, auctionsReducer } from '../core/projection/auctions.ts';
import {
	DROP_RECORDED_EVENT,
	INITIAL_CONTRACTS,
	contractsReducer
} from '../core/projection/contracts.ts';
import type {
	AuctionContracts,
	DropRecordedPayload,
	DroppedContract
} from '../core/projection/contracts.ts';
import {
	INITIAL_ELIGIBILITY,
	eligibilityReducer,
	isEligible
} from '../core/projection/eligibility.ts';
import {
	INITIAL_NOMINATIONS,
	nominationForPlayer,
	nominationsReducer
} from '../core/projection/nominations.ts';
import { allDropGatesPassed, dropRefusalDetail, evaluateDrop } from '../core/rules/roster-drop.ts';
import type {
	DropOutcome,
	DroppablePlayer,
	DroppingTeam,
	RosterDropRefusal,
	RosterDropState
} from '../core/rules/roster-drop.ts';
import type { OverrideActor } from '../core/rules/override.ts';
import type { EventEnvelope, RecordDrop, RecordDropGateResults } from '../core/types.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { loadEventsViaClient } from './event-log.ts';
import { loadTeamRosterDetail } from './team-roster.ts';
import type { TeamRecord } from './team-registry.ts';
import type { TeamRosterDetail } from './team-roster.ts';

export type { OverrideActor as RosterDropActor };

/**
 * The statement a released Contract that still charges is converted by.
 *
 * **`cap_hit` is deliberately not touched.** The row keeps charging exactly
 * what it charged — that is what "Dead Money charges the Cap in full" means,
 * and §10 example 40's "Cap Space still $5,000,000" is the observable form of
 * it. Rewriting the column would be a second statement of `chargedCapHit`.
 */
export const DROP_ROSTER_ROW_SQL =
	"update team_rosters set roster_slot_kind = 'dead_money' where fantrax_player_id = $1";

/**
 * The statement a released Contract that carries nothing is removed by.
 *
 * A Minor League row was charging `$0`, and a full-term second-round
 * rookie-scale deal is released to `$0` by FR-43's exception. Removing the
 * row IS the release: Cap Space is a sum over the rows a Team holds, so a row
 * that is gone charges nothing without a second rule saying so.
 */
export const REMOVE_ROSTER_ROW_SQL = 'delete from team_rosters where fantrax_player_id = $1';

/** Every Team, ordered by name — what the destination's first step picks from. */
const TEAMS_SQL = 'select id::text as id, name from teams order by name';

/** What the Commissioner submitted, once the route has narrowed it. */
export type RosterDropInput = {
	readonly teamId: string;
	readonly fantraxPlayerIds: readonly string[];
	/** Already trimmed and non-blank — `requireOverrideReason` saw to that. */
	readonly reason: string;
};

/**
 * What a rejection carries back to the route: the refusal, its one sentence,
 * and — for a gate refusal — the figures it was judged against.
 *
 * `gates` is `null` for the refusals decided outside the gate set, exactly as
 * `RosterMoveRejection.gates` is: a malformed act has no arithmetic to show.
 */
export type RosterDropRejection = {
	readonly refusal: RosterDropRefusal;
	readonly detail: string;
	readonly gates: RecordDropGateResults | null;
};

/** Everything one transaction reads: the Team, and the League it sits in. */
export type LoadedRosterDropState = {
	readonly teams: readonly TeamRecord[];
	readonly drop: RosterDropState;
	readonly contracts: AuctionContracts;
};

/** A rejection, built once so the gate and the route read one wording. */
function rejectionFor(outcome: Extract<DropOutcome, { kind: 'refused' }>): RosterDropRejection {
	return {
		refusal: outcome.refusal,
		detail: dropRefusalDetail(outcome.refusal, outcome.gates),
		gates: outcome.gates
	};
}

/**
 * One Team's rows as the core drops them — the roster read, with the won
 * rows marked so the core can refuse them.
 *
 * **A Drop does NOT need the contracts join a Move needs.** A Move recovers
 * `winningAmount` because a won stash charging `$0` must arrive on the next
 * Team charging its full value; a Drop releases a won Player over nothing at
 * all, because `evaluateDrop` refuses him outright. `row.capHit` is therefore
 * the right figure for every row this act can actually touch: an imported
 * row's `team_rosters.cap_hit` is stored in full whatever Slot it sits in.
 *
 * The won rows are still CARRIED, and that matters twice: they are part of
 * the Team's Cap Space and occupancy, so leaving them out would compute
 * figures the Teams page disagrees with — and `won: true` is the fact the
 * shape refusal is made on.
 */
function droppingTeamFor(teamId: string, teamName: string, detail: TeamRosterDetail): DroppingTeam {
	const rows: DroppablePlayer[] = detail.rows.map((row) => ({
		fantraxPlayerId: row.fantraxPlayerId,
		playerName: row.playerName,
		rosterSlotKind: row.rosterSlotKind,
		value: row.capHit,
		won: row.won,
		contractYearsRemaining: row.contractYearsRemaining,
		rookieScaleRound: row.rookieScaleRound
	}));
	return { teamId, teamName, rows };
}

/**
 * Everything a Drop is judged against, from ONE read of the log plus one
 * roster read.
 *
 * Four folds share the single `loadEventsViaClient` read — the nominations
 * and the Auctions for the contested ground, the eligibility flag for the
 * minors arithmetic, and the contracts because `loadTeamRosterDetail` needs
 * them to append what the Team has won — so no two of them can disagree
 * about which events they saw.
 *
 * The same function serves the route's own `load` and the locked transaction,
 * `loadRosterMoveState`'s discipline: the sheet and the gate cannot disagree
 * about what the log says, only about when they read it.
 */
export async function loadRosterDropState(
	client: TransactionalClient,
	teamId: string
): Promise<LoadedRosterDropState> {
	const events = await loadEventsViaClient(client);
	const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);
	const auctions = fold(INITIAL_AUCTIONS, events, auctionsReducer);
	const eligibility = fold(INITIAL_ELIGIBILITY, events, eligibilityReducer);
	const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);

	const teamsResult = await client.query(TEAMS_SQL);
	const teams: TeamRecord[] = teamsResult.rows.map((row) => ({
		id: String(row['id'] ?? ''),
		name: String(row['name'] ?? '')
	}));
	const teamName = teams.find((team) => team.id === teamId)?.name ?? teamId;

	const detail = await loadTeamRosterDetail(client, teamId, contracts);

	return {
		teams,
		contracts,
		drop: {
			team: droppingTeamFor(teamId, teamName, detail),
			auctions,
			nominations,
			isMinorLeagueEligible: (playerId) => isEligible(eligibility, playerId),
			// The Player's name from the fold that already holds it, exactly as
			// `loadRosterMoveState` sources it. A Player under contract has no
			// open nomination, so the id is the honest fallback rather than an
			// invented name.
			playerNameFor: (playerId) =>
				nominationForPlayer(nominations, playerId)?.playerName ?? playerId
		}
	};
}

/** The command the core decides from, built from the submitted input. */
function commandFor(state: LoadedRosterDropState, input: RosterDropInput): RecordDrop {
	return {
		kind: 'RecordDrop',
		teamId: input.teamId,
		teamName: state.drop.team.teamName,
		fantraxPlayerIds: input.fantraxPlayerIds,
		reason: input.reason
	};
}

/** The sheet's read: what this Drop would do, decided by the core, writing nothing. */
export type RosterDropPreview = {
	readonly teams: readonly TeamRecord[];
	readonly team: DroppingTeam;
	readonly outcome: DropOutcome;
};

/**
 * Evaluate a Drop without committing it — the reason sheet's before → after.
 *
 * It opens a transaction because `loadEventsViaClient` needs a
 * `TransactionalClient`; it takes no advisory lock and decides nothing that
 * is written. **The render is never the check** (AD-9): `recordDrop`
 * re-derives every gate under the lock, from the log as it stands then.
 */
export async function previewRosterDrop(
	gateway: ConnectionGateway,
	input: RosterDropInput
): Promise<RosterDropPreview> {
	const client = await gateway.connect();
	try {
		const state = await loadRosterDropState(client, input.teamId);
		return {
			teams: state.teams,
			team: state.drop.team,
			outcome: evaluateDrop(state.drop, commandFor(state, input))
		};
	} finally {
		try {
			client.release();
		} catch (error) {
			console.error('previewRosterDrop: releasing the read connection failed', error);
		}
	}
}

/** Every Team, for the destination's first step. One read, no lock, no decision. */
export async function loadRosterDropTeams(
	gateway: ConnectionGateway
): Promise<readonly TeamRecord[]> {
	const client = await gateway.connect();
	try {
		const result = await client.query(TEAMS_SQL);
		return result.rows.map((row) => ({
			id: String(row['id'] ?? ''),
			name: String(row['name'] ?? '')
		}));
	} finally {
		try {
			client.release();
		} catch (error) {
			console.error('loadRosterDropTeams: releasing the read connection failed', error);
		}
	}
}

/**
 * Record one Drop: one transaction, one event, one statement per released
 * Contract, and nothing on the outbox.
 *
 * Returns `accepted` with the single appended event, or `rejected` carrying a
 * `RosterDropRejection`. A rejection is a RETURNED value and never a throw,
 * and `runTransactionalWrite` has already rolled the transaction back by the
 * time it arrives — so a refused Drop has written no event, no row and no
 * delivery intent.
 */
export async function recordDrop(
	gateway: ConnectionGateway,
	actor: OverrideActor,
	input: RosterDropInput,
	deviceClass: string
): Promise<WriteOutcome> {
	// What `decide` settled, read by the projection below. Assigned inside the
	// transaction and read inside the same one — `import-promotion.ts`'s seam,
	// which is the only precedent in this codebase for mutating a live
	// reference table alongside an appended event.
	let released: readonly DroppedContract[] = [];

	return await runTransactionalWrite<LoadedRosterDropState>({
		gateway,
		load: (client) => loadRosterDropState(client, input.teamId),
		// **No `enqueue`.** A Drop is not broadcast: it is recorded in the
		// Audit Log, where every Manager can read it and filter by Team.
		decide: ({ state }) => {
			const outcome = evaluateDrop(state.drop, commandFor(state, input));
			if (outcome.kind === 'refused') {
				return { kind: 'rejected', reason: rejectionFor(outcome) };
			}
			// The gates are re-asserted rather than trusted: `evaluateDrop`
			// already refuses a failing set, and this is what makes "nothing is
			// written when any gate fails" true of this file as well as of the
			// core it calls.
			if (!allDropGatesPassed(outcome.gates)) {
				throw new Error('recordDrop: a permitted Drop carried a failing gate');
			}

			released = outcome.delta.released;

			const payload: DropRecordedPayload = {
				teamId: state.drop.team.teamId,
				teamName: state.drop.team.teamName,
				released: outcome.delta.released,
				// `teamBefore`/`teamAfter`, never `before`/`after`: the Audit
				// Log's `mergeOverride` reads a top-level `before`/`after` pair
				// as an `OverrideRecord`'s own state map and would print the
				// Team figures a second time, raw. See the payload's docblock.
				teamBefore: outcome.delta.before,
				teamAfter: outcome.delta.after,
				reason: input.reason
			};

			const event: EventEnvelope = {
				type: DROP_RECORDED_EVENT,
				payload,
				managerId: actor.managerId,
				teamId: actor.teamId,
				deviceClass
			};
			// ONE event for the whole Drop, however many Players it released.
			return { kind: 'accepted', events: [event] };
		},
		projections: [
			async (client) => {
				// **The payload, applied verbatim.** `removed` was decided by the
				// one expression in `rules/roster-drop.ts`; re-deriving it here
				// from the Slot kind or the amount would be the second spelling
				// that acceptance criterion forbids.
				for (const release of released) {
					await client.query(
						release.removed ? REMOVE_ROSTER_ROW_SQL : DROP_ROSTER_ROW_SQL,
						[release.fantraxPlayerId]
					);
				}
			}
		]
	});
}
