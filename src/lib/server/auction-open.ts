/**
 * The auction-open gate: the read behind the page, and the one transaction
 * that opens the auction. Server-only (Story 1.11).
 *
 * **Nothing here is stored.** There is no migration in this story and no
 * `nomination_slots` table: the phase, promoted-ness and the League Clock are
 * all folds of `auction_events`, and "all 30 Teams receive an unused
 * Nomination Slot" is a statement about the fold, not about storage. A
 * projection table is created by the story that first READS it (AD-5), and
 * the first reader of the Slot projection is Story 2.1's nomination command.
 * This story appends the event 2.1 folds — hence no `projections` hook on the
 * write below.
 *
 * **Readiness is derived, never read from a status column.** Promoted-ness
 * comes from the latest `ImportPromoted` payload through
 * `promotedSourcesReducer`; `import_team_sources.status` stays `'staged'`
 * after a promotion and answers a different question
 * (`server/import-status.ts`'s `outstandingSourceNames` is deliberately not
 * reused here). Team/Manager binding comes from the live tables on the
 * locked transaction's own client.
 *
 * **The gate re-derives every check under the lock, whatever the page
 * rendered.** `loadAuctionOpenState` runs inside `runTransactionalWrite`'s
 * transaction, after `pg_advisory_xact_lock` (AD-6), so a page rendered
 * while a promotion was still outstanding cannot race an open past it. The
 * page calls the same loader through its own connection purely to render the
 * report; that render is never the check.
 *
 * A refusal is a returned value, never a throw (AD-1). A throw out of the
 * transaction rolls it back, leaving no event and no phase change.
 */

import { fold } from '../core/projection/fold.ts';
import { INITIAL_ELIGIBILITY, eligibilityReducer } from '../core/projection/eligibility.ts';
import { AUCTION_OPENED_EVENT, INITIAL_PHASE, phaseReducer } from '../core/projection/phase.ts';
import { INITIAL_PROMOTION, promotedSourcesReducer } from '../core/projection/promotion.ts';
import { auctionOpenRefusalDetail, preOpenReport, refuseAuctionOpen } from '../core/rules/auction-open.ts';
import type {
	AuctionOpenRefusal,
	AuctionOpenState,
	GateTeam,
	PreOpenReport
} from '../core/rules/auction-open.ts';
import type { EventEnvelope } from '../core/types.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { loadEventsViaClient } from './event-log.ts';

/** Who acted, resolved server-side from application tables (AD-4). */
export type AuctionOpenActor = {
	readonly managerId: string;
	readonly teamId: string;
};

/**
 * The `AuctionOpened` payload: what the League looked like at the moment it
 * opened, named. The actor, timestamp, `schemaVersion` and `coreVersion` are
 * columns `runTransactionalWrite` fills from the database clock and the
 * pinned constants — never restated here.
 *
 * The Teams are carried so Story 2.1 can fold thirty unused Nomination Slots
 * out of this one event without re-reading a table that may have changed by
 * then, and the eligible count because it is the number the Commissioner
 * confirmed against.
 */
export type AuctionOpenedPayload = {
	readonly teams: ReadonlyArray<{
		readonly teamId: string;
		readonly teamName: string;
	}>;
	readonly minorLeagueEligibleCount: number;
};

/**
 * Read the phase, promoted-ness, the eligible count and every Team's Manager
 * binding — all from ONE read of the log plus one join, on the given client.
 *
 * Three folds over a single `loadEventsViaClient` read: the three projections
 * cannot disagree about which events they saw, because they saw the same
 * array. The join is `teams left join managers`, so a Team with no Manager
 * row comes back with a null manager id rather than vanishing — the whole
 * point of the check.
 *
 * Sorted by Team name so the refusal sentences and the payload come out in a
 * stated order rather than the planner's (AD-1 forbids incidental order).
 */
export async function loadAuctionOpenState(client: TransactionalClient): Promise<AuctionOpenState> {
	const events = await loadEventsViaClient(client);
	const phase = fold(INITIAL_PHASE, events, phaseReducer);
	const promotion = fold(INITIAL_PROMOTION, events, promotedSourcesReducer);
	const eligible = fold(INITIAL_ELIGIBILITY, events, eligibilityReducer);

	const teamsResult = await client.query(
		`select t.id, t.name, m.id as manager_id
		from teams t
		left join managers m on m.team_id = t.id
		order by t.name asc`
	);

	// Two managers rows may share one team_id — that is co-management, not an
	// error (`20260821010000_teams.sql`), so the join can return a Team twice.
	// Collapsing by id here is what keeps "Lakers" from being named twice in a
	// refusal, and keeps the payload one row per Team.
	const byId = new Map<string, GateTeam>();
	for (const row of teamsResult.rows) {
		const teamId = String(row['id']);
		const managerId = row['manager_id'];
		const hasManager = managerId !== null && managerId !== undefined;
		const existing = byId.get(teamId);
		if (existing === undefined) {
			byId.set(teamId, { teamId, teamName: String(row['name']), hasManager });
			continue;
		}
		if (hasManager && !existing.hasManager) {
			byId.set(teamId, { ...existing, hasManager: true });
		}
	}

	return {
		phase,
		promotion,
		teams: [...byId.values()],
		eligibleCount: eligible.size
	};
}

/**
 * The pre-open report, read through the gateway for the page.
 *
 * It opens a transaction because `loadEventsViaClient` and the join both need
 * one client, and then always rolls back, because rendering a report is not a
 * write. It deliberately takes NO advisory lock: the render is never the
 * check, and `openAuction` re-derives every gate under the lock on submit. A
 * report torn across a concurrent promotion is therefore possible and
 * harmless — it can only ever be stale, never authoritative.
 * `runTransactionalWrite` is deliberately NOT used: it exists to append
 * events, and a `decide` that always rejects in order to read would be a
 * second write path in everything but name.
 */
export async function readAuctionOpenReport(
	gateway: ConnectionGateway
): Promise<{ readonly state: AuctionOpenState; readonly report: PreOpenReport }> {
	const client = await gateway.connect();
	try {
		await client.query('begin');
		const state = await loadAuctionOpenState(client);
		await client.query('rollback');
		return { state, report: preOpenReport(state) };
	} catch (error) {
		await client.query('rollback').catch(() => {
			/* the original error is what the caller needs to see */
		});
		throw error;
	} finally {
		client.release();
	}
}

/** What a rejection carries back to the route: the refusal and its one sentence. */
export type AuctionOpenRejection = {
	readonly refusal: AuctionOpenRefusal;
	readonly detail: string;
};

/**
 * Open the auction: one transaction appending exactly one `AuctionOpened`
 * event, or nothing at all.
 *
 * The confirmation is checked by the route before this is called and is NOT
 * a rules gate — it establishes only that the request meant to open.
 * Everything that could make opening wrong is re-derived here, under the
 * lock, from the log and the live tables.
 *
 * Returns the pipeline's own `WriteOutcome`: `accepted` with the single
 * appended event, or `rejected` carrying an `AuctionOpenRejection`. No
 * projection is registered — nothing about this event is persisted anywhere
 * but the log, and the phase is the fold of it.
 */
export async function openAuction(
	gateway: ConnectionGateway,
	actor: AuctionOpenActor
): Promise<WriteOutcome> {
	return runTransactionalWrite<AuctionOpenState>({
		gateway,
		load: (client) => loadAuctionOpenState(client),
		decide: ({ state }) => {
			const refusal = refuseAuctionOpen(state);
			if (refusal !== null) {
				const rejection: AuctionOpenRejection = {
					refusal,
					detail: auctionOpenRefusalDetail(refusal)
				};
				return { kind: 'rejected', reason: rejection };
			}

			const payload: AuctionOpenedPayload = {
				teams: state.teams.map((team) => ({ teamId: team.teamId, teamName: team.teamName })),
				minorLeagueEligibleCount: state.eligibleCount
			};

			const event: EventEnvelope = {
				type: AUCTION_OPENED_EVENT,
				payload,
				managerId: actor.managerId,
				teamId: actor.teamId
			};
			return { kind: 'accepted', events: [event] };
		}
	});
}
