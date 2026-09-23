/**
 * The Close-reversal command: one transaction, one `AuctionCloseReversed`,
 * and — only where the record says so — one re-inserted Nomination Slot claim
 * row (Story 7.13, FR-32, AD-33).
 *
 * **Mirrors `server/roster-drop.ts`**: one `load` that serves both the sheet
 * and the locked transaction, a preview that decides and writes nothing, and
 * a `record` through `runTransactionalWrite` — lock before any read (AD-6),
 * the decision re-derived inside the lock from the log the transaction itself
 * read, and the claim row written through the `ProjectionUpdater` seam before
 * `COMMIT` so it and the event commit together or not at all (AD-5).
 *
 * **Nothing in `auction_events` is updated or deleted** (AD-4). The reversal
 * is one appended event; the close it names and every `BidCancelled` that
 * close caused keep their places in the log.
 *
 * **It IS broadcast** — unlike a Trade, a Drop or a Move — naming the actor
 * and the reason and mentioning the winning Team's Managers, who have just
 * lost a Contract through no act of their own.
 *
 * The actor is resolved server-side from the session (AD-4/AD-15) and never
 * from a form field; the route narrows it and validates the reason with
 * `requireOverrideReason` before this is called.
 */

import { fold } from '../core/projection/fold.ts';
import { INITIAL_AUCTIONS, auctionsReducer } from '../core/projection/auctions.ts';
import {
	AUCTION_CLOSE_REVERSED_EVENT,
	INITIAL_CONTRACTS,
	contractsReducer
} from '../core/projection/contracts.ts';
import {
	INITIAL_NOMINATIONS,
	nominationForPlayer,
	nominationsReducer
} from '../core/projection/nominations.ts';
import { INITIAL_PHASE, phaseReducer } from '../core/projection/phase.ts';
import {
	closeReversalFactsFor,
	closeReversalRefusalDetail,
	decideCloseReversal
} from '../core/rules/close-reversal.ts';
import type {
	CloseReversalOutcome,
	CloseReversalRefusal,
	CloseReversalState
} from '../core/rules/close-reversal.ts';
import type { ActingRow } from '../core/rules/roster-act.ts';
import type { OverrideActor } from '../core/rules/override.ts';
import type { AppendedEvent, EventEnvelope } from '../core/types.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { loadEventsViaClient } from './event-log.ts';
import { reholdNominationSlot } from './nomination.ts';
import { enqueueBroadcastsAndMentions } from './outbox.ts';
import { loadTeamRosterDetail } from './team-roster.ts';

export type { OverrideActor as CloseReversalActor };

/** What the Commissioner submitted, once the route has narrowed it. */
export type CloseReversalInput = {
	readonly closeSeq: string;
	/** Already trimmed and non-blank — `requireOverrideReason` saw to that. */
	readonly reason: string;
};

/** What a rejection carries back to the route: the refusal and its one sentence. */
export type CloseReversalRejection = {
	readonly refusal: CloseReversalRefusal;
	readonly detail: string;
};

/**
 * Everything a reversal is judged against, from ONE read of the log plus one
 * roster read of the winning Team.
 *
 * The same function serves the route's `load` and the locked transaction,
 * `loadRosterDropState`'s discipline: the sheet and the decision cannot
 * disagree about what the log says, only about when they read it.
 */
export async function loadCloseReversalState(
	client: TransactionalClient,
	closeSeq: string
): Promise<CloseReversalState> {
	const events: readonly AppendedEvent[] = await loadEventsViaClient(client);
	const phase = fold(INITIAL_PHASE, events, phaseReducer);
	const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);
	const auctions = fold(INITIAL_AUCTIONS, events, auctionsReducer);
	const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);
	const facts = closeReversalFactsFor(events, closeSeq);

	const teamId = facts.close?.teamId ?? null;
	const teamName = facts.close?.teamName ?? '';
	const rows: ActingRow[] =
		teamId === null
			? []
			: (await loadTeamRosterDetail(client, teamId, contracts)).rows.map((row) => ({
					fantraxPlayerId: row.fantraxPlayerId,
					playerName: row.playerName,
					rosterSlotKind: row.rosterSlotKind,
					// `roster-drop.ts`'s reading: the stored figure, which is the
					// full value for every row whose charge it can differ from.
					value: row.capHit
				}));

	return {
		phase,
		facts,
		contracts,
		nominations,
		auctions,
		team: { teamId: teamId ?? '', teamName, rows },
		playerNameFor: (playerId) => nominationForPlayer(nominations, playerId)?.playerName ?? playerId
	};
}

/**
 * Decide a reversal without committing it — the reason sheet's before → after.
 *
 * It opens a connection because `loadEventsViaClient` needs a
 * `TransactionalClient`; it takes no lock and writes nothing. **The render is
 * never the check** (AD-9): `recordCloseReversal` re-derives everything under
 * the lock.
 */
export async function previewCloseReversal(
	gateway: ConnectionGateway,
	input: CloseReversalInput
): Promise<CloseReversalOutcome> {
	const client = await gateway.connect();
	try {
		const state = await loadCloseReversalState(client, input.closeSeq);
		return decideCloseReversal(state, input.reason);
	} finally {
		try {
			client.release();
		} catch (error) {
			console.error('previewCloseReversal: releasing the read connection failed', error);
		}
	}
}

/**
 * The Team a reversal is about — the payload's `teamId`, `close.ts:335`'s
 * pattern. Read straight off the appended payload with no narrowing beyond a
 * string test: this runs INSIDE the write transaction, so a throw would have
 * to be caught, and a caught throw mentions nobody.
 */
export function affectedTeamsForReversal(event: AppendedEvent): readonly string[] {
	if (event.type !== AUCTION_CLOSE_REVERSED_EVENT) return [];
	const payload = event.payload;
	if (typeof payload !== 'object' || payload === null) return [];
	const teamId = (payload as Record<string, unknown>)['teamId'];
	return typeof teamId === 'string' && teamId !== '' ? [teamId] : [];
}

/**
 * Record one reversal: one transaction, one event, at most one claim row,
 * and the Discord broadcast and mention intents.
 *
 * Returns `accepted` with the single appended event, or `rejected` carrying a
 * `CloseReversalRejection`. A rejection is a RETURNED value, and
 * `runTransactionalWrite` has already rolled back by the time it arrives — so
 * a refused reversal has written no event, no row and no delivery intent.
 */
export async function recordCloseReversal(
	gateway: ConnectionGateway,
	actor: OverrideActor,
	input: CloseReversalInput,
	deviceClass: string
): Promise<WriteOutcome> {
	return await runTransactionalWrite<CloseReversalState>({
		gateway,
		load: (client) => loadCloseReversalState(client, input.closeSeq),
		decide: ({ state }) => {
			const outcome = decideCloseReversal(state, input.reason);
			if (outcome.kind === 'rejected') {
				const rejection: CloseReversalRejection = {
					refusal: outcome.refusal,
					detail: closeReversalRefusalDetail(outcome.refusal)
				};
				return { kind: 'rejected', reason: rejection };
			}
			const event: EventEnvelope = {
				type: AUCTION_CLOSE_REVERSED_EVENT,
				payload: outcome.payload,
				managerId: actor.managerId,
				teamId: actor.teamId,
				deviceClass
			};
			// ONE event. The close it names is not touched (AD-4).
			return { kind: 'accepted', events: [event] };
		},
		// **The claim row, re-inserted from the RECORD** (AD-32), through the
		// seam the nomination code already owns: `nomination_slots` has one
		// owner module, and the re-insert reads the appended payload through
		// the same core reader the fold does. Only a payload saying
		// `slotReheld: true` writes a row; the decision checked the fold says
		// the Team holds none, so the primary key is free.
		projections: [reholdNominationSlot],
		enqueue: enqueueBroadcastsAndMentions(affectedTeamsForReversal)
	});
}
