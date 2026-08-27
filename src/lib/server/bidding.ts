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
	INITIAL_ELIGIBILITY,
	eligibilityReducer,
	isEligible
} from '../core/projection/eligibility.ts';
import {
	INITIAL_NOMINATIONS,
	nominationForPlayer,
	nominationsReducer
} from '../core/projection/nominations.ts';
import type { Money } from '../core/money.ts';
import type { OpenNomination } from '../core/projection/nominations.ts';
import { bidRefusalDetail, bidStateFor, decide, teamMoneyStateFor } from '../core/rules/bidding.ts';
import type { BidRefusal, BidState } from '../core/rules/bidding.ts';
import type { EventEnvelope, PlaceBid, PlaceBidGateResults } from '../core/types.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
import { loadEventsViaClient } from './event-log.ts';
import { loadTeamRoster } from './team-roster.ts';

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

/**
 * What a rejection carries back to the route: the refusal, its one sentence,
 * and — for a gate refusal — the figures it was actually judged against.
 *
 * `gates` and `at` are Story 2.6's, and they are what make FR-13's "a Bid
 * valid when composed but invalid by the time it lands is refused **with the
 * current figures shown**" true rather than merely intended. The panel must
 * print the arithmetic the transaction used, under the lock, at the
 * transaction's own clock — not the arithmetic the page rendered some
 * seconds earlier against a Cap Space that has since moved. Reconstructing
 * them on the route would be a second evaluation of a state that no longer
 * exists.
 *
 * Both are `null` for the refusals decided outside the gate set —
 * `no_open_auction` here, and the route's own `unusable_amount`,
 * `unconfirmed` and `unbound_actor`. None of those has arithmetic, and a
 * panel handed empty figures would print a breakdown of nothing.
 */
export type BidRejection = {
	readonly refusal: BidRefusal;
	readonly detail: string;
	readonly gates: PlaceBidGateResults | null;
	/** The transaction-start clock, ISO-8601 — the instant these figures held. */
	readonly at: string | null;
};

/**
 * Fold the open nomination and the Auction's bid state from one read of the
 * log, on the given client, plus the bidding Team's Cap figures.
 *
 * **Story 2.5 said "no table read at all"; the money gate ends that.** Every
 * fact the first four gates decide from is in `auction_events`, and still
 * is. Cap Space and Roster Count are not: `team_rosters` is mutable
 * reference data that nothing rebuilds from the log, so AD-7's "computed
 * from committed state at validation time" requires reading it here — inside
 * the transaction, after `pg_advisory_xact_lock`, so the figures cannot
 * move between the read and the decision.
 *
 * Three folds now share the ONE `loadEventsViaClient` read, and eligibility
 * is one of them rather than a `select minor_league_eligible` on
 * `free_agent_players`. That is deliberate: the flag is the fold of
 * `MinorLeagueEligibilitySet` events, and asking the table instead would
 * make two answers possible inside one transaction — the fold's and the
 * projection column's — at the exact moment a Commissioner is changing it.
 */
export async function loadBidState(
	client: TransactionalClient,
	fantraxPlayerId: string,
	teamId: string
): Promise<LoadedBidState> {
	const events = await loadEventsViaClient(client);
	const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);
	const auctions = fold(INITIAL_AUCTIONS, events, auctionsReducer);
	const eligibility = fold(INITIAL_ELIGIBILITY, events, eligibilityReducer);

	const roster = await loadTeamRoster(client, teamId);

	return {
		// `bidStateFor` and `teamMoneyStateFor` are the ONE narrowing from the
		// folds to the gates, shared with the read path, so the transaction and
		// the render cannot narrow the same state two different ways.
		bid: bidStateFor(
			auctionForPlayer(auctions, fantraxPlayerId),
			teamMoneyStateFor({
				teamId,
				fantraxPlayerId,
				capSpace: roster.capSpace,
				rosterCount: roster.rosterCount,
				auctions,
				isMinorLeagueEligible: (playerId) => isEligible(eligibility, playerId)
			})
		),
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
		load: (client) => loadBidState(client, fantraxPlayerId, actor.teamId),
		// No `projections` array, deliberately: nothing derived is stored, and
		// there is no uniqueness constraint for a Bid to collide with.
		decide: ({ state, now }) => {
			// Asked before `decide()`, never as a gate: `PLACE_BID_GATES` is fixed
			// at four and "is there an open Auction" is the nomination fold's
			// question. A Player whose Auction closed between the render and this
			// submit lands here.
			if (state.nomination === null) {
				const refusal: BidRefusal = { kind: 'no_open_auction' };
				// No gates and no stamp: this refusal has no arithmetic behind
				// it, and a panel handed empty figures would print a breakdown
				// of nothing.
				const rejection: BidRejection = {
					refusal,
					detail: bidRefusalDetail(refusal),
					gates: null,
					at: null
				};
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
				// The gate set and the clock it was decided at, carried back so
				// the refusal panel prints the arithmetic this transaction
				// actually used rather than what the page rendered (FR-13).
				const rejection: BidRejection = {
					refusal,
					detail: bidRefusalDetail(refusal),
					gates: decided.gates,
					at: now.toISOString()
				};
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
