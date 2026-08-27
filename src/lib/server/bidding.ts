/**
 * The bidding gate's one transaction: lock, load, decide, append one
 * `BidPlaced`. Server-only (Story 2.5).
 *
 * **Nothing here is stored but the event.** There is no migration in this
 * story, no `auctions` table, no `bids` table and — unlike `placeNomination`
 * — no `projections` hook of any kind. The price, the Leading Bidder, the
 * contention state, the absolute close instant, the whole Bid history and the
 * League Clock reset are all folds of `auction_events`
 * (`core/projection/auctions.ts`, `core/projection/league-clock.ts`). A claim
 * row would be a write-side constraint for a uniqueness rule bidding does not
 * have: two Bids on one Auction are not a collision, they are an auction.
 *
 * **The race is settled by the price, not by a constraint.** PRD §10 example
 * 15 — both Managers of one Team bidding within the same second — resolves
 * here without any new database object, because both transactions queue on
 * the single global advisory lock (AD-6). The first commits its `BidPlaced`;
 * the second then LOADS a log that already contains it, re-folds, and its
 * `evaluate()` refuses on the increment gate against the new high. Exactly
 * one is accepted, the other is told the price moved, and the log names the
 * Manager whose Bid landed. That is the check-then-write gap being closed by
 * serialisation rather than by a unique index — which is available here
 * precisely because the losing outcome is a legitimate refusal rather than a
 * duplicate.
 *
 * **The gate re-derives everything under the lock, whatever the page
 * rendered.** `loadBidState` runs inside `runTransactionalWrite`'s
 * transaction, after `pg_advisory_xact_lock`, so a page rendered before
 * somebody else raised cannot race a stale amount past the board. The read
 * path calls the SAME `evaluate()` to disable the control, but that render is
 * never the check (AD-9).
 *
 * **Whether the Auction is open is asked here, not by a gate.**
 * `PLACE_BID_GATES` is fixed at four and none of them is "does this Auction
 * exist" — that is `nominationsReducer`'s fold, the identical accessor
 * `server/auction-page.ts` and `server/nomination.ts` already use. It is
 * answered before `decide()` is called, exactly as the route answers
 * `unconfirmed` and `unbound_actor` before this function is called: a
 * question with nothing for a rule to decide is not a rule.
 *
 * **Device class rides the envelope, never the payload.** It is a measurement
 * column (`shell/write.ts`), not domain data — no reducer and no gate reads
 * it, or an NFR §5 measurement would quietly become a rule input. `decide()`
 * is pure and never sees a header, so the class is stamped onto the envelope
 * here, after the core has produced it.
 *
 * A refusal is a returned value, never a throw (AD-1).
 */

import { fold } from '../core/projection/fold.ts';
import {
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer
} from '../core/projection/auctions.ts';
import {
	INITIAL_NOMINATIONS,
	nominationForPlayer,
	nominationsReducer
} from '../core/projection/nominations.ts';
import type { OpenNomination } from '../core/projection/nominations.ts';
import type { Money } from '../core/money.ts';
import { bidRefusalDetail, bidStateFor, decide } from '../core/rules/bidding.ts';
import type { BidRefusal, BidState } from '../core/rules/bidding.ts';
import type { EventEnvelope, PlaceBid } from '../core/types.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { loadEventsViaClient } from './event-log.ts';

/** Who acted, resolved server-side from application tables (AD-4). */
export type BidActor = {
	readonly managerId: string;
	readonly teamId: string;
	/** The acting Team's name — carried into the payload so history can name it. */
	readonly teamName: string;
};

/**
 * What the transaction loads: the Auction's bid state for the core, and the
 * open nomination that establishes there is an Auction to bid on at all.
 *
 * Two folds over ONE `loadEventsViaClient` read, `loadNominationState`'s
 * discipline: the two projections cannot disagree about which events they
 * saw, because they saw the same array.
 *
 * `nomination` is deliberately NOT part of `BidState` — the core's gates
 * cannot see it and therefore cannot come to depend on it.
 */
export type LoadedBidState = {
	readonly bid: BidState;
	readonly nomination: OpenNomination | null;
};

/** What a rejection carries back to the route: the refusal and its one sentence. */
export type BidRejection = {
	readonly refusal: BidRefusal;
	readonly detail: string;
};

/**
 * Fold the open nomination and the Auction's bid state from one read of the
 * log, on the given client.
 *
 * No table read at all, unlike `loadNominationState`: every fact a bid gate
 * decides from is in `auction_events`. The Player's name, their pool row and
 * their contract holder are nomination questions, already answered when the
 * Player reached the board.
 */
export async function loadBidState(
	client: TransactionalClient,
	fantraxPlayerId: string
): Promise<LoadedBidState> {
	const events = await loadEventsViaClient(client);
	const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);
	const auctions = fold(INITIAL_AUCTIONS, events, auctionsReducer);

	return {
		// `bidStateFor` is the ONE narrowing from the fold to the gates, shared
		// with the read path, so the transaction and the render cannot narrow
		// the same Auction two different ways.
		bid: bidStateFor(auctionForPlayer(auctions, fantraxPlayerId)),
		nomination: nominationForPlayer(nominations, fantraxPlayerId)
	};
}

/**
 * Place a Bid: one transaction appending exactly one `BidPlaced` event, or
 * nothing at all.
 *
 * The confirmation and the amount's usability are checked by the route before
 * this is called and are NOT rules gates — they establish only that the
 * request meant to bid, and with what. Everything that could make a Bid wrong
 * is re-derived here, under the lock, from the log.
 *
 * `now` is the database's transaction-start clock, read once by
 * `runTransactionalWrite` (AD-3) and handed to the core as an ISO-8601 string
 * — the core may not so much as name `Date`. It is the same instant the shell
 * then stamps on the appended row, so the event's `occurredAt` and the
 * `closesAt` the core computed from it are exactly `AUCTION_CLOCK` apart by
 * construction rather than by two clock reads that could differ.
 *
 * `seed` is passed as `null`: a `PlaceBid` has no randomness in it. The
 * parameter exists because AD-1 fixes `decide()`'s signature and Story 3.6's
 * draw is its first consumer.
 *
 * Returns the pipeline's own `WriteOutcome`: `accepted` with the single
 * appended event, or `rejected` carrying a `BidRejection`.
 */
export async function placeBid(
	gateway: ConnectionGateway,
	actor: BidActor,
	fantraxPlayerId: string,
	amount: Money,
	deviceClass: string
): Promise<WriteOutcome> {
	return await runTransactionalWrite<LoadedBidState>({
		gateway,
		load: (client) => loadBidState(client, fantraxPlayerId),
		// No `projections` array, deliberately: nothing derived is stored, and
		// there is no uniqueness constraint for a Bid to collide with.
		decide: ({ state, now }) => {
			// Asked before `decide()`, never as a gate: `PLACE_BID_GATES` is fixed
			// at four and "is there an open Auction" is the nomination fold's
			// question. A Player whose Auction closed between the render and this
			// submit lands here.
			if (state.nomination === null) {
				const refusal: BidRefusal = { kind: 'no_open_auction' };
				const rejection: BidRejection = { refusal, detail: bidRefusalDetail(refusal) };
				return { kind: 'rejected', reason: rejection };
			}

			const command: PlaceBid = {
				kind: 'PlaceBid',
				fantraxPlayerId,
				teamId: actor.teamId,
				teamName: actor.teamName,
				managerId: actor.managerId,
				amount
			};

			const decided = decide(state.bid, command, now.toISOString(), null);

			if (decided.kind === 'rejected') {
				const refusal: BidRefusal = { kind: 'gates', gates: decided.gates };
				const rejection: BidRejection = { refusal, detail: bidRefusalDetail(refusal) };
				return { kind: 'rejected', reason: rejection };
			}

			// The measurement column, stamped onto the envelope the pure core
			// produced. The core cannot see a header and must not: `deviceClass`
			// is NFR §5 measurement, and a payload copy of it would let a gate
			// come to read it.
			const events: EventEnvelope[] = decided.events.map((event) => ({
				...event,
				deviceClass
			}));
			return { kind: 'accepted', events };
		}
	});
}
