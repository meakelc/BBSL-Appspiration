/**
 * The Roster Trade command: one transaction, one `RosterMoveRecorded`, and one
 * `UPDATE` per Existing Contract that changed hands (Story 7.7, FR-41).
 *
 * **The event type reads `RosterMoveRecorded` on purpose, not by oversight.**
 * Story 7.10 renamed the act; AD-4 makes `auction_events` insert-only, so the
 * wire name rows were already written under is frozen and only the constant
 * `ROSTER_TRADE_RECORDED_EVENT` moved. `core/projection/contracts.ts` declares
 * it and states the reason in full.
 *
 * **One transaction under the global write lock, and that is the requirement
 * rather than an implementation detail.** FR-41 says a Trade that moved three
 * Players of five is never a reachable state, so the event and every
 * `team_rosters` row travel together through `runTransactionalWrite`: the
 * lock is taken before anything is read (AD-6), the gates are re-derived
 * inside it from the log and the tables the transaction itself read, and the
 * rows are written through the `ProjectionUpdater` seam before `COMMIT`.
 *
 * **Two kinds of Contract, two mechanisms, one act.** An Auction Contract is
 * a fold of `AuctionClosed` and has no row anywhere, so it moves by the event
 * alone — `contractsReducer` rewrites its Team, re-derives its placement and
 * Cap Hit, and clears its assigned length. An Existing Contract IS a
 * `team_rosters` row, which is mutable reference data nothing rebuilds from
 * the log (`import-promotion.ts`'s header), so it moves by an `UPDATE` of
 * `team_id` and `roster_slot_kind`. **Never delete-then-insert**:
 * `fantrax_player_id` is unique across every Team (AR-41), so a delete and an
 * insert inside one statement pair is a window in which the Player exists
 * nowhere, and a failure between them is a Player who has left one roster and
 * arrived at none.
 *
 * **No `enqueue`.** `contract-assignment.ts` passes none because an
 * assignment is a Team talking to itself; this passes none because FR-41 says
 * so outright — a Roster Trade is the one Commissioner act that is not
 * broadcast to Discord, and it is recorded in the league-visible Audit Log
 * instead. Being off Discord is therefore a property of this file's shape
 * rather than a setting somebody could flip.
 *
 * The actor is resolved server-side from the session (AD-4/AD-15) and never
 * from a form field; the route is the one place that narrowing happens, and
 * the reason is validated there by `requireOverrideReason` before this
 * function is called.
 */

import { fold } from '../core/projection/fold.ts';
import { INITIAL_AUCTIONS, auctionsReducer } from '../core/projection/auctions.ts';
import {
	INITIAL_CONTRACTS,
	ROSTER_TRADE_RECORDED_EVENT,
	contractsReducer,
	contractsWonBy
} from '../core/projection/contracts.ts';
import type {
	AuctionContracts,
	RosterTradeRecordedPayload
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
import {
	allTradeGatesPassed,
	evaluateTrade,
	rosterTradeRefusalDetail
} from '../core/rules/roster-trade.ts';
import type {
	TradeOutcome,
	TradeTransfer,
	TradingPlayer,
	TradingTeam,
	RosterTradeRefusal,
	RosterTradeState
} from '../core/rules/roster-trade.ts';
import type { OverrideActor } from '../core/rules/override.ts';
import type {
	EventEnvelope,
	RecordRosterTrade,
	RecordRosterTradeGateResults
} from '../core/types.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { loadEventsViaClient } from './event-log.ts';
import { loadTeamRosterDetail } from './team-roster.ts';
import type { TeamRecord } from './team-registry.ts';
import type { TeamRosterDetail } from './team-roster.ts';

export type { OverrideActor as RosterTradeActor };

/** The statement one Existing Contract moves by. Never a delete and an insert. */
export const TRADE_ROSTER_ROW_SQL =
	'update team_rosters set team_id = $2, roster_slot_kind = $3 where fantrax_player_id = $1';

/** Every Team, ordered by name — what the destination's first step picks from. */
const TEAMS_SQL = 'select id::text as id, name from teams order by name';

/** What the Commissioner submitted, once the route has narrowed it. */
export type RosterTradeInput = {
	readonly sendingTeamId: string;
	readonly receivingTeamId: string;
	readonly sendingPlayerIds: readonly string[];
	readonly receivingPlayerIds: readonly string[];
	/** Already trimmed and non-blank — `requireOverrideReason` saw to that. */
	readonly reason: string;
};

/**
 * What a rejection carries back to the route: the refusal, its one sentence,
 * and — for a gate refusal — the figures it was judged against.
 *
 * `gates` is `null` for the refusals decided outside the gate set, exactly as
 * `BidRejection.gates` is: a malformed act has no arithmetic to show, and a
 * panel handed empty figures would print a breakdown of nothing.
 */
export type RosterTradeRejection = {
	readonly refusal: RosterTradeRefusal;
	readonly detail: string;
	readonly gates: RecordRosterTradeGateResults | null;
};

/** Everything one transaction reads: the two Teams, and the League they sit in. */
export type LoadedRosterTradeState = {
	readonly teams: readonly TeamRecord[];
	readonly move: RosterTradeState;
	readonly contracts: AuctionContracts;
};

/** A rejection, built once so the gate and the route read one wording. */
function rejectionFor(outcome: Extract<TradeOutcome, { kind: 'refused' }>): RosterTradeRejection {
	return {
		refusal: outcome.refusal,
		detail: rosterTradeRefusalDetail(outcome.refusal, outcome.gates),
		gates: outcome.gates
	};
}

/**
 * One Team's rows as the core moves them — the roster read and the contracts
 * fold, joined on the Player.
 *
 * **The join is what recovers `winningAmount` and `contractYears`.**
 * `loadTeamRosterDetail` returns the rows the Cap arithmetic is counted from,
 * and a won row carries the CHARGED Cap Hit — `$0` for a stash — because that
 * is what `computeCapSpace` sums. A Trade needs the full value instead: §10
 * example 38's Ellis charges `$0` on one Team and `$18,000,000` on the next,
 * and a charged figure carried across the transfer would lose the difference
 * silently. So the contract is read for its `winningAmount`, and an imported
 * row's own `cap_hit` — which is stored in full whatever Slot it sits in — is
 * the same fact for the other kind.
 */
function tradingTeamFor(
	teamId: string,
	teamName: string,
	detail: TeamRosterDetail,
	contracts: AuctionContracts
): TradingTeam {
	const won = new Map(
		contractsWonBy(contracts, teamId).map((contract) => [contract.fantraxPlayerId, contract])
	);
	const rows: TradingPlayer[] = detail.rows.map((row) => {
		const contract = won.get(row.fantraxPlayerId);
		// **A won row with no contract behind it is a THROW, not a fallback.**
		//
		// Unreachable by construction: `loadTeamRosterDetail` builds its `won`
		// rows from `contractsWonBy(contracts, teamId)` and this map is built
		// from the identical call over the identical fold, so the two cannot
		// disagree about membership. What made the guard necessary is what the
		// fallback would have DONE if they ever did: `row.capHit` on a won row
		// is the CHARGED figure, which is `$0` for a minors placement — so a
		// desync would silently value an $18,000,000 stash at nothing, move him
		// to a Team with no free Minor League Slot, and charge that Team $0 for
		// a Player who should have cost it the lot. That is precisely the AD-23
		// distinction this story exists to preserve, and it must fail loudly
		// rather than be quietly substituted. The throw aborts the transaction,
		// so nothing is written.
		if (row.won && contract === undefined) {
			throw new Error(
				`tradingTeamFor: ${row.fantraxPlayerId} is a won row on ${teamId} with no Auction Contract folded`
			);
		}
		return {
			fantraxPlayerId: row.fantraxPlayerId,
			playerName: row.playerName,
			rosterSlotKind: row.rosterSlotKind,
			// The FULL value either way: an Auction Contract's winning amount, and
			// an imported row's own `team_rosters.cap_hit`, which is stored in
			// full whatever Slot the row sits in. What either CHARGES is
			// `chargedCapHit`'s answer about that Slot, computed downstream.
			value: contract === undefined ? row.capHit : contract.winningAmount,
			won: row.won,
			contractYears: contract === undefined ? null : contract.contractYears
		};
	});
	return { teamId, teamName, rows };
}

/**
 * Everything a Trade is judged against, from ONE read of the log plus one
 * roster read per Team.
 *
 * Four folds share the single `loadEventsViaClient` read — the nominations
 * and the Auctions for the contested ground, the eligibility flag for the
 * minors arithmetic, and the contracts for what each Team has won — so no two
 * of them can disagree about which events they saw.
 *
 * The same function serves the route's own `load` and the locked transaction,
 * `loadBidState`'s discipline: the sheet and the gate cannot disagree about
 * what the log says, only about when they read it.
 */
export async function loadRosterTradeState(
	client: TransactionalClient,
	sendingTeamId: string,
	receivingTeamId: string
): Promise<LoadedRosterTradeState> {
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
	const nameOf = (teamId: string): string =>
		teams.find((team) => team.id === teamId)?.name ?? teamId;

	const sendingDetail = await loadTeamRosterDetail(client, sendingTeamId, contracts);
	const receivingDetail = await loadTeamRosterDetail(client, receivingTeamId, contracts);

	return {
		teams,
		contracts,
		move: {
			sending: tradingTeamFor(sendingTeamId, nameOf(sendingTeamId), sendingDetail, contracts),
			receiving: tradingTeamFor(
				receivingTeamId,
				nameOf(receivingTeamId),
				receivingDetail,
				contracts
			),
			auctions,
			nominations,
			isMinorLeagueEligible: (playerId) => isEligible(eligibility, playerId),
			// The Player's name from the fold that already holds it, exactly as
			// `loadBidState` sources it. A Player under contract has no open
			// nomination, so the id is the honest fallback rather than an
			// invented name — and every caller that has a name already passes it
			// rather than asking here.
			playerNameFor: (playerId) =>
				nominationForPlayer(nominations, playerId)?.playerName ?? playerId
		}
	};
}

/** The command the core decides from, built from the submitted input. */
function commandFor(state: LoadedRosterTradeState, input: RosterTradeInput): RecordRosterTrade {
	return {
		kind: 'RecordRosterTrade',
		sendingTeamId: input.sendingTeamId,
		sendingTeamName: state.move.sending.teamName,
		receivingTeamId: input.receivingTeamId,
		receivingTeamName: state.move.receiving.teamName,
		sendingPlayerIds: input.sendingPlayerIds,
		receivingPlayerIds: input.receivingPlayerIds,
		reason: input.reason
	};
}

/** The sheet's read: what this Trade would do, decided by the core, writing nothing. */
export type RosterTradePreview = {
	readonly teams: readonly TeamRecord[];
	readonly sending: TradingTeam;
	readonly receiving: TradingTeam;
	readonly outcome: TradeOutcome;
};

/**
 * Evaluate a Trade without committing it — the reason sheet's before → after.
 *
 * It opens a transaction because `loadEventsViaClient` needs a
 * `TransactionalClient`; it takes no advisory lock and decides nothing that
 * is written. **The render is never the check** (AD-9): `recordRosterTrade`
 * re-derives every gate under the lock, from the log as it stands then.
 */
export async function previewRosterTrade(
	gateway: ConnectionGateway,
	input: RosterTradeInput
): Promise<RosterTradePreview> {
	const client = await gateway.connect();
	try {
		const state = await loadRosterTradeState(client, input.sendingTeamId, input.receivingTeamId);
		return {
			teams: state.teams,
			sending: state.move.sending,
			receiving: state.move.receiving,
			outcome: evaluateTrade(state.move, commandFor(state, input))
		};
	} finally {
		try {
			client.release();
		} catch (error) {
			console.error('previewRosterTrade: releasing the read connection failed', error);
		}
	}
}

/** Every Team, for the destination's first step. One read, no lock, no decision. */
export async function loadRosterTradeTeams(
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
			console.error('loadRosterTradeTeams: releasing the read connection failed', error);
		}
	}
}

/**
 * Record one Roster Trade: one transaction, one event, one `UPDATE` per moved
 * Existing Contract, and nothing on the outbox.
 *
 * Returns `accepted` with the single appended event, or `rejected` carrying a
 * `RosterTradeRejection`. A rejection is a RETURNED value and never a throw,
 * and `runTransactionalWrite` has already rolled the transaction back by the
 * time it arrives — so a refused Trade has written no event, no row and no
 * delivery intent.
 */
export async function recordRosterTrade(
	gateway: ConnectionGateway,
	actor: OverrideActor,
	input: RosterTradeInput,
	deviceClass: string
): Promise<WriteOutcome> {
	// What `decide` settled, read by the projection below. Assigned inside the
	// transaction and read inside the same one — `import-promotion.ts`'s seam,
	// which is the only precedent in this codebase for mutating a live
	// reference table alongside an appended event.
	let transfers: readonly TradeTransfer[] = [];

	return await runTransactionalWrite<LoadedRosterTradeState>({
		gateway,
		load: (client) => loadRosterTradeState(client, input.sendingTeamId, input.receivingTeamId),
		// **No `enqueue`, by FR-41.** A Roster Trade is the one Commissioner act
		// that is not broadcast: it is recorded in the Audit Log, where every
		// Manager can read it and filter by Team.
		decide: ({ state }) => {
			const outcome = evaluateTrade(state.move, commandFor(state, input));
			if (outcome.kind === 'refused') {
				return { kind: 'rejected', reason: rejectionFor(outcome) };
			}
			// The gates are re-asserted rather than trusted: `evaluateTrade`
			// already refuses a failing set, and this is what makes "nothing is
			// written when any gate fails" true of this file as well as of the
			// core it calls.
			if (!allTradeGatesPassed(outcome.gates)) {
				throw new Error('recordRosterTrade: a permitted Trade carried a failing gate');
			}

			transfers = outcome.delta.transfers;

			const payload: RosterTradeRecordedPayload = {
				sendingTeamId: state.move.sending.teamId,
				sendingTeamName: state.move.sending.teamName,
				receivingTeamId: state.move.receiving.teamId,
				receivingTeamName: state.move.receiving.teamName,
				transfers: outcome.delta.transfers,
				sendingBefore: outcome.delta.sendingBefore,
				sendingAfter: outcome.delta.sendingAfter,
				receivingBefore: outcome.delta.receivingBefore,
				receivingAfter: outcome.delta.receivingAfter,
				reason: input.reason
			};

			const event: EventEnvelope = {
				type: ROSTER_TRADE_RECORDED_EVENT,
				payload,
				managerId: actor.managerId,
				teamId: actor.teamId,
				deviceClass
			};
			// ONE event for the whole Trade — FR-41's "one entry, not two".
			return { kind: 'accepted', events: [event] };
		},
		projections: [
			async (client) => {
				// An Auction Contract has no row: it moved when the event was
				// appended a moment ago, and `contractsReducer` is what moves it.
				for (const transfer of transfers) {
					if (transfer.won) continue;
					await client.query(TRADE_ROSTER_ROW_SQL, [
						transfer.fantraxPlayerId,
						transfer.toTeamId,
						transfer.toPlacement
					]);
				}
			}
		]
	});
}
