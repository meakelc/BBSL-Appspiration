/**
 * The Bid-reinstatement command: one transaction, one
 * `BidCancellationReversed` (Story 7.14, FR-32, FR-40).
 *
 * **Mirrors `server/close-reversal.ts`**: one `load` that serves both the
 * sheet and the locked transaction, a preview that decides and writes
 * nothing, and a `record` through `runTransactionalWrite` — lock before any
 * read (AD-6), and the decision re-derived inside the lock from the log the
 * transaction itself read (AD-9). No projection row is written: the fold is
 * the whole effect, and an erased Minimum-Bid Contention's sealed seed row is
 * left where it is — dead weight the next opening's upsert overwrites
 * (`server/bidding.ts`), never revealed, because that lottery is ruled never
 * to have run.
 *
 * **Nothing in `auction_events` is updated or deleted** (AD-4). The
 * cancellation it reverses and every Bid it erases keep their places in the
 * log.
 *
 * **It IS broadcast**, naming the actor and the reason, and it mentions the
 * reinstated Team and every Team whose Bid it erased — none of them acted.
 *
 * The actor is resolved server-side from the session (AD-4/AD-15) and never
 * from a form field; the route narrows it and validates the reason with
 * `requireOverrideReason` before this is called.
 */

import { fold } from '../core/projection/fold.ts';
import {
	BID_CANCELLATION_REVERSED_EVENT,
	INITIAL_AUCTIONS,
	auctionsReducer
} from '../core/projection/auctions.ts';
import { INITIAL_CONTRACTS, contractsReducer } from '../core/projection/contracts.ts';
import { INITIAL_LEAGUE_CLOCK, leagueClockReducer } from '../core/projection/league-clock.ts';
import {
	INITIAL_NOMINATIONS,
	nominationForPlayer,
	nominationsReducer
} from '../core/projection/nominations.ts';
import { INITIAL_PHASE, phaseReducer } from '../core/projection/phase.ts';
import {
	bidReinstatementFactsFor,
	bidReinstatementRefusalDetail,
	decideBidReinstatement
} from '../core/rules/bid-reinstatement.ts';
import type {
	BidReinstatementOutcome,
	BidReinstatementRefusal,
	BidReinstatementState
} from '../core/rules/bid-reinstatement.ts';
import type { OverrideActor } from '../core/rules/override.ts';
import type { AppendedEvent, EventEnvelope } from '../core/types.ts';
import { requireDatabaseClock, runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { loadEventsViaClient } from './event-log.ts';
import { enqueueBroadcastsAndMentions } from './outbox.ts';
import { loadTeamRoster } from './team-roster.ts';

export type { OverrideActor as BidReinstatementActor };

/** What the Commissioner submitted, once the route has narrowed it. */
export type BidReinstatementInput = {
	/** The `BidCancelled` event's own `seq`. */
	readonly cancellationSeq: string;
	/** Already trimmed and non-blank — `requireOverrideReason` saw to that. */
	readonly reason: string;
};

/** What a rejection carries back to the route: the refusal and its one sentence. */
export type BidReinstatementRejection = {
	readonly refusal: BidReinstatementRefusal;
	readonly detail: string;
};

/**
 * A preview's outcome, plus the Player the named cancellation is about when
 * the log identifies one — so a refused sheet can still link back to its
 * Auction rather than being a dead end. `null` when no cancellation was found.
 */
export type BidReinstatementPreview = BidReinstatementOutcome & {
	readonly fantraxPlayerId: string | null;
};

/**
 * Everything a reinstatement is judged against, from ONE read of the log plus
 * one roster read of the reinstated Team.
 *
 * The same function serves the route's `load` and the locked transaction, so
 * the sheet and the decision cannot disagree about what the log says, only
 * about when they read it.
 */
export async function loadBidReinstatementState(
	client: TransactionalClient,
	cancellationSeq: string
): Promise<BidReinstatementState> {
	const events: readonly AppendedEvent[] = await loadEventsViaClient(client);
	const phase = fold(INITIAL_PHASE, events, phaseReducer);
	const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);
	const auctions = fold(INITIAL_AUCTIONS, events, auctionsReducer);
	const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);
	const leagueClock = fold(INITIAL_LEAGUE_CLOCK, events, leagueClockReducer);
	const facts = bidReinstatementFactsFor(events, cancellationSeq);

	const teamId = facts.cancellation?.teamId ?? null;
	const rosterFigures = teamId === null ? null : await loadTeamRoster(client, teamId, contracts);

	return {
		phase,
		facts,
		auctions,
		leagueClock,
		rosterFigures,
		playerNameFor: (playerId) => nominationForPlayer(nominations, playerId)?.playerName ?? playerId
	};
}

/**
 * Decide a reinstatement without committing it — the reason sheet's
 * before → after.
 *
 * It takes no lock and writes nothing; it reads the database clock with a
 * bare `select now()`, as `server/auction-page.ts` does, because whether the
 * reinstated clock has passed is part of what the sheet states. **The render
 * is never the check** (AD-9): `recordBidReinstatement` re-derives everything
 * under the lock, against the lock's own clock.
 */
export async function previewBidReinstatement(
	gateway: ConnectionGateway,
	input: BidReinstatementInput
): Promise<BidReinstatementPreview> {
	const client = await gateway.connect();
	try {
		const clock = await client.query('select now() as now');
		const now = requireDatabaseClock(clock.rows[0]?.['now']).toISOString();
		const state = await loadBidReinstatementState(client, input.cancellationSeq);
		return {
			...decideBidReinstatement(state, input.reason, now),
			fantraxPlayerId: state.facts.cancellation?.fantraxPlayerId ?? null
		};
	} finally {
		try {
			client.release();
		} catch (error) {
			console.error('previewBidReinstatement: releasing the read connection failed', error);
		}
	}
}

/**
 * The Teams a reinstatement is about — the reinstated Team and every Team
 * whose Bid it erased, read straight off the appended payload. No narrowing
 * beyond string tests: this runs INSIDE the write transaction, so a throw
 * would have to be caught, and a caught throw mentions nobody.
 */
export function affectedTeamsForReinstatement(event: AppendedEvent): readonly string[] {
	if (event.type !== BID_CANCELLATION_REVERSED_EVENT) return [];
	const payload = event.payload;
	if (typeof payload !== 'object' || payload === null) return [];
	const record = payload as Record<string, unknown>;
	const teams: string[] = [];
	const add = (value: unknown): void => {
		if (typeof value === 'string' && value !== '' && !teams.includes(value)) teams.push(value);
	};
	add(record['teamId']);
	const erased = record['erasedBids'];
	if (Array.isArray(erased)) {
		for (const entry of erased) {
			if (typeof entry !== 'object' || entry === null) continue;
			const bid = entry as Record<string, unknown>;
			// A Bid another Close had already cancelled committed nothing, so its
			// Team lost nothing by this act and is not mentioned.
			if (bid['wasCancelled'] === true) continue;
			add(bid['teamId']);
		}
	}
	return teams;
}

/**
 * Record one reinstatement: one transaction, one event, and the Discord
 * broadcast and mention intents.
 *
 * Returns `accepted` with the single appended event, or `rejected` carrying a
 * `BidReinstatementRejection`. A rejection is a RETURNED value, and
 * `runTransactionalWrite` has already rolled back by the time it arrives — so
 * a refused reinstatement has written no event and no delivery intent.
 */
export async function recordBidReinstatement(
	gateway: ConnectionGateway,
	actor: OverrideActor,
	input: BidReinstatementInput,
	deviceClass: string
): Promise<WriteOutcome> {
	return await runTransactionalWrite<BidReinstatementState>({
		gateway,
		load: (client) => loadBidReinstatementState(client, input.cancellationSeq),
		decide: ({ state, now }) => {
			const outcome = decideBidReinstatement(state, input.reason, now.toISOString());
			if (outcome.kind === 'rejected') {
				const rejection: BidReinstatementRejection = {
					refusal: outcome.refusal,
					detail: bidReinstatementRefusalDetail(outcome.refusal)
				};
				return { kind: 'rejected', reason: rejection };
			}
			const event: EventEnvelope = {
				type: BID_CANCELLATION_REVERSED_EVENT,
				payload: outcome.payload,
				managerId: actor.managerId,
				teamId: actor.teamId,
				deviceClass
			};
			// ONE event. The cancellation and every erased Bid are not touched
			// (AD-4), and no close is appended: an expired clock is the sweep's.
			return { kind: 'accepted', events: [event] };
		},
		enqueue: enqueueBroadcastsAndMentions(affectedTeamsForReinstatement)
	});
}
