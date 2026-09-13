/**
 * The Roster Move command: one transaction, one `RosterRearranged`, and one
 * `UPDATE` per Existing Contract (Story 7.11, FR-44).
 *
 * **One transaction under the global write lock, and that is the requirement
 * rather than an implementation detail.** A Move that re-placed one leg of a
 * swap and not the other is never a reachable state, so the event and every
 * `team_rosters` row travel together through `runTransactionalWrite`: the
 * lock is taken before anything is read (AD-6), the gates are re-derived
 * inside it from the log and the tables the transaction itself read, and the
 * rows are written through the `ProjectionUpdater` seam before `COMMIT`.
 *
 * **One statement, and it names one column.** `roster_slot_kind` is the whole
 * of what a Move changes on a row: the Contract does not change hands, so
 * `team_id` stands; no amount is edited, so `cap_hit` stands — and what the
 * row CHARGES is `chargedCapHit`'s answer about the new Slot, computed on
 * every read rather than stored. Rewriting `cap_hit` here would be a second
 * spelling of that rule and the first to drift.
 *
 * **A won Contract has no row, and moves by the event alone.** It was never
 * imported into `team_rosters`; `contractsReducer`'s `RosterRearranged` case
 * is what re-places it, latest-wins, exactly as the Trade's case moves a won
 * Contract between Teams. The skip below mirrors `server/roster-trade.ts`.
 *
 * **No `enqueue`.** A Move is not broadcast to Discord — it is recorded in
 * the league-visible Audit Log instead, exactly as a Roster Trade and a Drop
 * are. Being off Discord is therefore a property of this file's shape rather
 * than a setting somebody could flip.
 *
 * The actor is resolved server-side from the session (AD-4/AD-15) and never
 * from a form field; the route is the one place that narrowing happens, and
 * for the Commissioner's branch the reason is validated there by
 * `requireOverrideReason` before this function is called.
 */

import { fold } from '../core/projection/fold.ts';
import { INITIAL_AUCTIONS, auctionsReducer } from '../core/projection/auctions.ts';
import {
	INITIAL_CONTRACTS,
	ROSTER_REARRANGED_EVENT,
	contractsReducer,
	contractsWonBy
} from '../core/projection/contracts.ts';
import type {
	AuctionContracts,
	RosterRearrangedMove,
	RosterRearrangedPayload
} from '../core/projection/contracts.ts';
import {
	INITIAL_ELIGIBILITY,
	eligibilityReducer,
	isEligible
} from '../core/projection/eligibility.ts';
import {
	hasEverOccupiedMinorLeague,
	minorsHistoryReducer,
	seedMinorsHistory
} from '../core/projection/minors-history.ts';
import {
	INITIAL_NOMINATIONS,
	nominationForPlayer,
	nominationsReducer
} from '../core/projection/nominations.ts';
import {
	allRearrangeGatesPassed,
	evaluateRearrange,
	rearrangeRefusalDetail
} from '../core/rules/roster-rearrange.ts';
import type {
	RearrangeOutcome,
	RearrangingPlayer,
	RearrangingTeam,
	RosterRearrangeRefusal,
	RosterRearrangeState
} from '../core/rules/roster-rearrange.ts';
import type { OverrideActor } from '../core/rules/override.ts';
import type {
	EventEnvelope,
	RearrangeRoster,
	RearrangeRosterGateResults,
	RosterSlotKind
} from '../core/types.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { loadEventsViaClient } from './event-log.ts';
import { loadTeamRosterDetail } from './team-roster.ts';
import type { TeamRecord } from './team-registry.ts';
import type { TeamRosterDetail } from './team-roster.ts';

export type { OverrideActor as RosterRearrangeActor };

/**
 * The one statement a Roster Move issues against `team_rosters`.
 *
 * **`roster_slot_kind` and nothing else.** The Contract stays with the Team
 * it is on, keeps its stored `cap_hit` and keeps whatever term Fantrax stated
 * — a Move re-places, it does not restructure. What the row charges after the
 * `UPDATE` is `chargedCapHit`'s answer about the new Slot, derived on every
 * read.
 */
export const REARRANGE_ROSTER_ROW_SQL =
	'update team_rosters set roster_slot_kind = $2 where fantrax_player_id = $1';

/**
 * The refusal a Manager naming somebody else's Team receives.
 *
 * **Declared here rather than on the route**, and not by preference: a
 * SvelteKit `+page.server.ts` may export only `load`, `actions` and a fixed
 * handful of options, so a constant a test needs to read has nowhere to live
 * there. It sits beside the write path the guard protects, which is where
 * `LIVE_DESTINATION_REFUSAL` and `OVERRIDE_ARCHIVED_REFUSAL` sit relative to
 * theirs.
 *
 * 403, matching every other role-shaped refusal in this codebase: the request
 * is well-formed and the caller cannot fix it by resubmitting.
 */
export const FOREIGN_TEAM_REFUSAL =
	'A Roster Move re-places one Team’s own Contracts. You may act on your own Team only.';
export const FOREIGN_TEAM_REFUSAL_STATUS = 403;

/** The refusal for a signed-in Manager whose account is bound to no Team. */
export const NO_TEAM_REFUSAL =
	'This account is not bound to a Team, so there is no Roster to rearrange.';

/**
 * The refusal a Team id no `teams` row answers to receives.
 *
 * 404, because the named Team genuinely does not exist — this is not a
 * permission answer, and a 403 would tell a Commissioner they lack an access
 * they in fact have.
 */
export const UNKNOWN_TEAM_REFUSAL = 'No Team by that name is in this League.';
export const UNKNOWN_TEAM_STATUS = 404;

/** Every Team, ordered by name — what the Commissioner's first step picks from. */
const TEAMS_SQL = 'select id::text as id, name from teams order by name';

/** What the route submitted, once it has narrowed it. */
export type RosterRearrangeInput = {
	readonly teamId: string;
	readonly moves: readonly {
		readonly fantraxPlayerId: string;
		readonly toPlacement: RosterSlotKind;
	}[];
	/**
	 * The Commissioner's stated reason — already trimmed and non-blank,
	 * `requireOverrideReason` saw to that — or `null` for a Manager acting on
	 * their own Team, which FR-44 requires no reason for.
	 */
	readonly reason: string | null;
};

/**
 * What a rejection carries back to the route: the refusal, its one sentence,
 * and — for a gate refusal — the figures it was judged against.
 *
 * `gates` is `null` for the refusals decided outside the gate set, exactly as
 * `RosterDropRejection.gates` is: a malformed act has no arithmetic to show.
 */
export type RosterRearrangeRejection = {
	readonly refusal: RosterRearrangeRefusal;
	readonly detail: string;
	readonly gates: RearrangeRosterGateResults | null;
};

/** Everything one transaction reads: the Team, and the League it sits in. */
export type LoadedRosterRearrangeState = {
	readonly teams: readonly TeamRecord[];
	readonly rearrange: RosterRearrangeState;
	readonly contracts: AuctionContracts;
};

/** A rejection, built once so the gate and the route read one wording. */
function rejectionFor(
	outcome: Extract<RearrangeOutcome, { kind: 'refused' }>
): RosterRearrangeRejection {
	return {
		refusal: outcome.refusal,
		detail: rearrangeRefusalDetail(outcome.refusal, outcome.gates),
		gates: outcome.gates
	};
}

/**
 * One Team's rows as the core re-places them — the roster read and the
 * contracts fold, joined on the Player.
 *
 * **The join is what recovers `winningAmount`**, and a Move needs it for the
 * identical reason a Trade does: `loadTeamRosterDetail` gives a won row its
 * CHARGED Cap Hit, which is `$0` for a stash, and §10 example 44's whole
 * point is that promoting Ellis into a Minor League Slot takes $18,000,000
 * off the Cap while demoting him puts it back. A charged figure carried into
 * the act would value the stash at nothing and compute a Cap Space nobody
 * has.
 *
 * A won row with no contract behind it is a THROW, not a fallback —
 * `tradingTeamFor`'s guard, for its stated reason: the silent alternative
 * would value an $18,000,000 Contract at `$0`. The throw aborts the
 * transaction, so nothing is written.
 *
 * **Exported for that guard's sake alone.** The desync it catches is
 * unreachable through `loadRosterRearrangeState` — `loadTeamRosterDetail`
 * builds its won rows from the same `contractsWonBy` call this function reads,
 * so the two cannot disagree — which means deleting the guard would leave
 * every end-to-end test green. `tests/server/roster-rearrange.test.ts` calls
 * this directly with a hand-built desync, which is the only way to hold a
 * claim about a state the public path cannot construct.
 */
export function rearrangingTeamFor(
	teamId: string,
	teamName: string,
	detail: TeamRosterDetail,
	contracts: AuctionContracts
): RearrangingTeam {
	const won = new Map(
		contractsWonBy(contracts, teamId).map((contract) => [contract.fantraxPlayerId, contract])
	);
	const rows: RearrangingPlayer[] = detail.rows.map((row) => {
		const contract = won.get(row.fantraxPlayerId);
		if (row.won && contract === undefined) {
			throw new Error(
				`rearrangingTeamFor: ${row.fantraxPlayerId} is a won row on ${teamId} with no Auction Contract folded`
			);
		}
		return {
			fantraxPlayerId: row.fantraxPlayerId,
			playerName: row.playerName,
			rosterSlotKind: row.rosterSlotKind,
			// The FULL value either way (AD-23): an Auction Contract's winning
			// amount, and an imported row's own `team_rosters.cap_hit`, which is
			// stored in full whatever Slot the row sits in.
			value: contract === undefined ? row.capHit : contract.winningAmount,
			won: row.won
		};
	});
	return { teamId, teamName, rows };
}

/**
 * Everything a Move is judged against, from ONE read of the log plus one
 * roster read.
 *
 * Five folds share the single `loadEventsViaClient` read — the nominations
 * and the Auctions for the contested ground, the pool flag for the minors
 * arithmetic, the contracts because `loadTeamRosterDetail` needs them to
 * append what the Team has won, and the minors-occupancy history for
 * placement eligibility — so no two of them can disagree about which events
 * they saw.
 *
 * **The minors history is SEEDED from the roster read, not from the log.**
 * `ImportPromoted` carries per-Team counts and no per-Player slot detail, so
 * the import baseline is not reconstructible; the Team's current Minor League
 * occupancy is read from `team_rosters` and the three recorded acts are
 * folded on top of it. `projection/minors-history.ts` states why that is
 * complete.
 *
 * The same function serves the route's own `load` and the locked transaction,
 * `loadRosterDropState`'s discipline: the sheet and the gate cannot disagree
 * about what the log says, only about when they read it.
 */
export async function loadRosterRearrangeState(
	client: TransactionalClient,
	teamId: string
): Promise<LoadedRosterRearrangeState> {
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
	const minorsHistory = fold(seedMinorsHistory(detail.rows), events, minorsHistoryReducer);

	return {
		teams,
		contracts,
		rearrange: {
			team: rearrangingTeamFor(teamId, teamName, detail, contracts),
			auctions,
			nominations,
			// The POOL FLAG, handed straight through to `postActMoneyStateFor`.
			// It is never widened — placement eligibility is the core's own
			// separate predicate, which unions this with the observation fold.
			isMinorLeagueEligible: (playerId) => isEligible(eligibility, playerId),
			hasEverOccupiedMinorLeague: (playerId) =>
				hasEverOccupiedMinorLeague(minorsHistory, playerId),
			// The Player's name from the fold that already holds it, exactly as
			// `loadRosterDropState` sources it. A Player under contract has no
			// open nomination, so the id is the honest fallback rather than an
			// invented name.
			playerNameFor: (playerId) =>
				nominationForPlayer(nominations, playerId)?.playerName ?? playerId
		}
	};
}

/** The command the core decides from, built from the submitted input. */
function commandFor(
	state: LoadedRosterRearrangeState,
	input: RosterRearrangeInput
): RearrangeRoster {
	return {
		kind: 'RearrangeRoster',
		teamId: input.teamId,
		teamName: state.rearrange.team.teamName,
		moves: input.moves,
		reason: input.reason
	};
}

/** The sheet's read: what this Move would do, decided by the core, writing nothing. */
export type RosterRearrangePreview = {
	readonly teams: readonly TeamRecord[];
	readonly team: RearrangingTeam;
	readonly outcome: RearrangeOutcome;
};

/**
 * Evaluate a Move without committing it — the sheet's before → after.
 *
 * It takes a pooled connection because `loadEventsViaClient` is typed against
 * `TransactionalClient`, but it opens NO transaction: there is no `BEGIN`, no
 * advisory lock and nothing decided that is written. **The render is never
 * the check** (AD-9): `recordRearrange` re-derives every gate inside a real
 * transaction under the global lock, from the log as it stands then.
 */
export async function previewRosterRearrange(
	gateway: ConnectionGateway,
	input: RosterRearrangeInput
): Promise<RosterRearrangePreview> {
	const client = await gateway.connect();
	try {
		const state = await loadRosterRearrangeState(client, input.teamId);
		return {
			teams: state.teams,
			team: state.rearrange.team,
			outcome: evaluateRearrange(state.rearrange, commandFor(state, input))
		};
	} finally {
		try {
			client.release();
		} catch (error) {
			console.error('previewRosterRearrange: releasing the read connection failed', error);
		}
	}
}

/** Every Team, for the Commissioner's first step. One read, no lock, no decision. */
export async function loadRosterRearrangeTeams(
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
			console.error('loadRosterRearrangeTeams: releasing the read connection failed', error);
		}
	}
}

/**
 * Record one Roster Move: one transaction, one event, one statement per
 * Existing Contract, and nothing on the outbox.
 *
 * Returns `accepted` with the single appended event, or `rejected` carrying a
 * `RosterRearrangeRejection`. A rejection is a RETURNED value and never a
 * throw, and `runTransactionalWrite` has already rolled the transaction back
 * by the time it arrives — so a refused Move has written no event, no row and
 * no delivery intent.
 */
export async function recordRearrange(
	gateway: ConnectionGateway,
	actor: OverrideActor,
	input: RosterRearrangeInput,
	deviceClass: string
): Promise<WriteOutcome> {
	// What `decide` settled, read by the projection below. Assigned inside the
	// transaction and read inside the same one — `server/roster-trade.ts`'s
	// seam.
	let moves: readonly RosterRearrangedMove[] = [];

	return await runTransactionalWrite<LoadedRosterRearrangeState>({
		gateway,
		load: (client) => loadRosterRearrangeState(client, input.teamId),
		// **No `enqueue`.** A Move is not broadcast: it is recorded in the
		// Audit Log, where every Manager can read it and filter by Team.
		decide: ({ state }) => {
			const outcome = evaluateRearrange(state.rearrange, commandFor(state, input));
			if (outcome.kind === 'refused') {
				return { kind: 'rejected', reason: rejectionFor(outcome) };
			}
			// The gates are re-asserted rather than trusted: `evaluateRearrange`
			// already refuses a failing set, and this is what makes "nothing is
			// written when any gate fails" true of this file as well as of the
			// core it calls.
			if (!allRearrangeGatesPassed(outcome.gates)) {
				throw new Error('recordRearrange: a permitted Move carried a failing gate');
			}

			moves = outcome.delta.moves;

			const payload: RosterRearrangedPayload = {
				teamId: state.rearrange.team.teamId,
				teamName: state.rearrange.team.teamName,
				moves: outcome.delta.moves,
				// `teamBefore`/`teamAfter`, never `before`/`after`: the Audit Log's
				// `mergeOverride` reads a top-level `before`/`after` pair as an
				// `OverrideRecord`'s own state map and would print the Team figures
				// a second time, raw. See the payload's docblock.
				teamBefore: outcome.delta.before,
				teamAfter: outcome.delta.after,
				reason: input.reason
			};

			const event: EventEnvelope = {
				type: ROSTER_REARRANGED_EVENT,
				payload,
				managerId: actor.managerId,
				teamId: actor.teamId,
				deviceClass
			};
			// ONE event for the whole Move, however many Contracts it re-placed.
			return { kind: 'accepted', events: [event] };
		},
		projections: [
			async (client) => {
				// An Auction Contract has no row: it moved when the event was
				// appended a moment ago, and `contractsReducer` is what moves it.
				for (const move of moves) {
					if (move.won) continue;
					await client.query(REARRANGE_ROSTER_ROW_SQL, [
						move.fantraxPlayerId,
						move.toPlacement
					]);
				}
			}
		]
	});
}
