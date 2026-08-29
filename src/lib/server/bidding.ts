/**
 * The bidding gate's one transaction: lock, load, decide, append the
 * `BidPlaced` — and, on a dissolution, the `ContentionDissolved` beside it.
 * Server-only (Stories 2.5, 3.2, 3.3).
 *
 * **Almost nothing here is stored but the event.** The price, the Leading
 * Bidder, the contention state, the Contender list, the absolute close
 * instant, the whole Bid history and the League Clock reset are all folds of
 * `auction_events` (`core/projection/auctions.ts`,
 * `core/projection/league-clock.ts`). There is no `auctions` table, no `bids`
 * table and no `contenders` table, and there is no claim row: a claim row
 * would be a write-side constraint for a uniqueness rule bidding does not
 * have, because two Bids on one Auction are not a collision, they are an
 * auction.
 *
 * **The one exception is the lottery SEED, and it is an exception because it
 * is the one fact that must never be foldable.** AD-14 requires it stored
 * outside the league-readable log, in a table no manager-facing role can
 * read; only `hash(seed)` is published, on the opening `BidPlaced` payload.
 * So `placeBid` generates the seed HERE — the shell may read randomness, the
 * core may not — hands it to `decide()`, and registers ONE `ProjectionUpdater`
 * that writes the row inside the appending transaction (AD-5), keyed on the
 * `seedHash` the core itself published.
 *
 * **Story 3.3 adds the READ of that table, and it is the only one that
 * exists.** A dissolution has to reveal what the opening sealed, so
 * `loadBidState` point-reads the seed on the transaction's own client
 * whenever the folded Auction is a live contention, and `placeBid` hands
 * `decide()` a `ContentionSeed` saying which half of the commit-reveal is in
 * play. The core verifies the seed against the published commitment before it
 * publishes the reveal, and appends `ContentionDissolved` beside the
 * converting `BidPlaced` — two events, one transaction, cause then
 * consequence. A dissolution writes NO second seed row: its `BidPlaced`
 * carries no `seedHash`, which is the only thing `recordContentionSeed` fires
 * on.
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
 * **Whether the Auction EXISTS is asked here, not by a gate.**
 * `PLACE_BID_GATES` is fixed at eight — `expiry`, `opening`, `contention`,
 * `selfBid`, `increment`, `granularity`, `cap` and `slots` — and none of them
 * is "does this Auction exist" — that is `nominationsReducer`'s fold, the identical
 * accessor `server/auction-page.ts` and `server/nomination.ts` already use.
 * It is answered before `decide()` is called, exactly as the route answers
 * `unconfirmed` and `unbound_actor` before this function is called: a
 * question with nothing for a rule to decide is not a rule.
 *
 * **Whether it has RUN OUT is a gate, and it is a different question.**
 * Story 3.1's `expiry` compares `now` — the transaction-start clock this
 * function already hands `decide()` — against the persisted absolute close
 * instant `loadBidState` already folds onto the `BidState`. So an Auction
 * whose close time has passed is refused under this same lock even though
 * the nomination fold still holds it and no `AuctionClosed` has been
 * appended (AD-12). It cost this file no executable line: `bidStateFor`
 * already received the `Auction` that carries `closesAt`, and `decide()`
 * already received `now.toISOString()`.
 *
 * **Device class rides the envelope, never the payload.** It is a measurement
 * column (`shell/write.ts`), not domain data — no reducer and no gate reads
 * it, or an NFR §5 measurement would quietly become a rule input. `decide()`
 * is pure and never sees a header, so the class is stamped onto the envelope
 * here, after the core has produced it.
 *
 * A refusal is a returned value, never a throw (AD-1).
 */

import { randomBytes } from 'node:crypto';

import { fold } from '../core/projection/fold.ts';
import {
	BID_PLACED_EVENT,
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer
} from '../core/projection/auctions.ts';
import {
	INITIAL_CONTRACTS,
	contractsReducer
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
import type { Money } from '../core/money.ts';
import type { OpenNomination } from '../core/projection/nominations.ts';
import { bidRefusalDetail, bidStateFor, decide, teamMoneyStateFor } from '../core/rules/bidding.ts';
import type {
	BidPlacedPayload,
	BidRefusal,
	BidState,
	ContentionSeed
} from '../core/rules/bidding.ts';
import type { EventEnvelope, PlaceBid, PlaceBidGateResults } from '../core/types.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type {
	ConnectionGateway,
	ProjectionUpdater,
	TransactionalClient,
	WriteOutcome
} from '../shell/write.ts';
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
	/**
	 * The SEALED seed for a live Minimum-Bid Contention, read on this same
	 * transaction's client — `null` for every Auction that is not one, and
	 * `null` for a contention with no seed row behind it (Story 3.3, AD-14).
	 *
	 * Deliberately NOT part of `BidState`, exactly as `nomination` is not: no
	 * gate may see it and therefore none can come to depend on it. It reaches
	 * the core as `decide()`'s fourth argument, the way `now` does — a value
	 * the shell supplies rather than a fact the rules read.
	 *
	 * A `null` here on a Bid that turns out to DISSOLVE the contention is a
	 * `TypeError` out of `decide()` (AD-1), which aborts the transaction and
	 * appends nothing. That is the intended outcome: releasing a contention
	 * without opening its commitment is the one failure AD-14 cannot survive,
	 * so it must not be reachable by a Bid quietly succeeding.
	 */
	readonly sealedSeed: string | null;
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
 * **Story 3.4 puts half of it back into the log.** `team_rosters` still
 * answers what a Team STARTED with, but what it has WON since is folded from
 * `AuctionClosed` and handed to `loadTeamRoster` alongside the table read, so
 * the three figures include this Team's Auction Contracts through the one
 * derivation the read path shares. Nothing else moved: `teamMoneyStateFor`'s
 * inputs are already those three figures.
 *
 * Four folds now share the ONE `loadEventsViaClient` read, and eligibility
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
	// The FOURTH fold over the same events array (Story 3.4): what this Team
	// has already won. It reaches the gates only through `loadTeamRoster`,
	// which counts a contract row exactly as it counts an imported one — so
	// Cap Space, Roster Count and Minor League occupancy all move on a close
	// with no new term anywhere and no change to `teamMoneyStateFor`, whose
	// inputs are already those three figures.
	const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);

	const roster = await loadTeamRoster(client, teamId, contracts);

	const auction = auctionForPlayer(auctions, fantraxPlayerId);

	// **The sealed seed, read under the SAME lock that will append** — a point
	// read on the transaction's own client, exactly as `loadNominationState`
	// reads the pool row and the contract holder beside its folds. It must go
	// through THIS client and not `server/supabase.ts`, because
	// `20260828000000_contention_seeds.sql` grants `anon`, `authenticated` and
	// `service_role` nothing at all: the direct `SUPABASE_DB_URL` connection is
	// the only identity that can see this table, and it is the one the write
	// pipeline already holds.
	//
	// Asked ONLY inside a live contention, which is the only state a
	// dissolution can arrive from. Every other Bid reads nothing here, so the
	// overwhelming majority of Bids touch the sealed table not at all — and
	// a join reads it and ignores it, which is cheaper than a second load
	// after the core has decided.
	//
	// `fantrax_player_id` is the table's primary key, so this returns at most
	// one row.
	const sealedSeed =
		auction?.contention === 'minimum_bid' ? await readContentionSeed(client, fantraxPlayerId) : null;

	return {
		// `bidStateFor` and `teamMoneyStateFor` are the ONE narrowing from the
		// folds to the gates, shared with the read path, so the transaction and
		// the render cannot narrow the same state two different ways.
		bid: bidStateFor(
			auction,
			teamMoneyStateFor({
				teamId,
				fantraxPlayerId,
				capSpace: roster.capSpace,
				rosterCount: roster.rosterCount,
				// Story 2.8's third roster fact, off the SAME read — the raw
				// occupancy `M` is derived from, never `M`.
				minorLeagueOccupied: roster.minorLeagueOccupied,
				auctions,
				isMinorLeagueEligible: (playerId) => isEligible(eligibility, playerId),
				// The Player's name for an exposing Auction, from the fold
				// that already holds it. An Auction is open exactly when a
				// nomination is (Epic 3 owns closing), so every Auction in
				// `auctions` has a nomination to name it; the id is the
				// fallback for a state that fold cannot produce today rather
				// than an invented name.
				playerNameFor: (playerId) =>
					nominationForPlayer(nominations, playerId)?.playerName ?? playerId
			}),
			// The eligibility FOLD's answer about the Player being bid on —
			// the same fold `teamMoneyStateFor` partitions the leads with, so
			// the Auction and the Team's leads cannot disagree about what
			// "eligible" means inside one transaction.
			isEligible(eligibility, fantraxPlayerId)
		),
		nomination: nominationForPlayer(nominations, fantraxPlayerId),
		sealedSeed
	};
}

/** The sealed seed table (`20260828000000_contention_seeds.sql`). */
const CONTENTION_SEEDS_TABLE = 'auction_contention_seeds';

/**
 * The sealed seed for one Player's Minimum-Bid Contention, or `null` when the
 * table holds none (Story 3.3, AD-14).
 *
 * **The first and only reader of `auction_contention_seeds` before the
 * draw**, and it exists because a dissolution has to reveal what the opening
 * sealed. Story 3.2 stated outright that nothing in this codebase selected
 * from this table; that changes here and nowhere else.
 *
 * It takes the transaction's own `client` rather than reaching for
 * `server/supabase.ts`, and that is not a style preference: the migration
 * grants `anon`, `authenticated` and `service_role` NOTHING, so the direct
 * `SUPABASE_DB_URL` connection is the only identity that can read a row at
 * all. The same connection appends the events, which is what makes the read
 * and the append one atomic act under the global lock (AD-6).
 *
 * `fantrax_player_id` is the primary key, so at most one row comes back. A
 * missing row is `null` rather than a throw: the caller decides what an
 * absent seed means, and only a DISSOLUTION treats it as the bug it is.
 *
 * The value never leaves the server except as the reveal `decide()`
 * publishes, and only after `decide()` has hashed it against the commitment
 * the log already carries.
 */
async function readContentionSeed(
	client: TransactionalClient,
	fantraxPlayerId: string
): Promise<string | null> {
	const result = await client.query(
		`select seed from ${CONTENTION_SEEDS_TABLE} where fantrax_player_id = $1`,
		[fantraxPlayerId]
	);
	const row = result.rows[0];
	if (row === undefined) return null;
	const seed = row['seed'];
	return typeof seed === 'string' && seed !== '' ? seed : null;
}

/**
 * How many random bytes a lottery seed is. 32 — a full 256 bits, matching the
 * digest that commits to it, so the commitment is never the narrower half of
 * the pair.
 */
const SEED_BYTES = 32;

/**
 * A fresh lottery seed: 32 random bytes as lowercase hex.
 *
 * **Generated in the SHELL because the core may not read randomness** (AD-2,
 * and `scripts/check-core-purity.js` enforces it by refusing `crypto` in
 * `core/`). `decide()` receives it as an argument, exactly as it receives
 * `now` — the same discipline for the same reason: a pure function's output
 * must be a function of its inputs, and both a clock and a random source are
 * ambient state.
 *
 * `randomBytes` and not `Math.random`: this value is what stands between a
 * Commissioner who is also a rival and a lottery nobody can trust (AD-14), so
 * it has to be unpredictable rather than merely arbitrary.
 *
 * Hex rather than base64, because the seed is revealed at the draw and
 * verified by hand — `printf %s "<seed>" | sha256sum` against the published
 * `hash(seed)` — and hex is the alphabet a Manager will be reading in.
 */
function generateSeed(): string {
	return randomBytes(SEED_BYTES).toString('hex');
}

/**
 * Insert the sealed seed row for a `BidPlaced` that OPENED a Minimum-Bid
 * Contention, on the appending transaction's own client (Story 3.2, AD-14).
 *
 * `claimNomination`'s shape and `claimNomination`'s discipline: a WRITE-SIDE
 * statement and nothing else — `readContentionSeed` above is the table's one
 * reader, and it is a separate function on purpose so this hook cannot grow
 * one — registered through `runTransactionalWrite`'s `projections` hook
 * because that is the one seam that persists INSIDE the appending transaction
 * (AD-5). The seed row and the opening event therefore commit together or
 * neither does, and a contention whose commitment was published without a
 * seed behind it is unreachable by construction.
 *
 * **A DISSOLUTION writes nothing here, and no `on conflict` was needed to
 * arrange that.** The condition below is "this `BidPlaced` carries a
 * `seedHash`", and `decide()` puts one there only on the Bid that OPENS a
 * contention; the converting Bid carries none, so this loop simply does not
 * fire for it. The seed a dissolution reveals is the one this row already
 * holds — it is read, never re-written — so the primary key is never
 * approached twice for one Player.
 *
 * **It keys on the core's own output, and re-derives no rule.** The condition
 * is "this payload carries a `seedHash`", which `decide()` put there and only
 * puts there on the Bid that opens a contention. Asking the question a second
 * way here — comparing the amount to `MINIMUM_BID`, or re-folding the
 * Auction — would be two judgements about one event, and the failure mode is
 * silent: a row written for a Bid whose payload published nothing, or a
 * published commitment with no seed to reveal.
 *
 * Deliberately NOT `on conflict do nothing`. The primary key is one seed per
 * Player's contention, and a collision means an opening was accepted for an
 * Auction that already had one — a state the gates make unreachable. Swallowing
 * it would leave the published commitment pointing at the WRONG seed, which is
 * the one failure AD-14 cannot survive; aborting the transaction refuses the
 * Bid instead.
 *
 * A factory rather than a bare `ProjectionUpdater` because the seed is per
 * transaction: `placeBid` generates one, passes it to `decide()` and closes
 * over it here, so the value hashed into the payload and the value stored are
 * the same string by construction rather than by two calls that agree.
 */
export function recordContentionSeed(seed: string): ProjectionUpdater {
	return async (client, appended) => {
		for (const event of appended) {
			if (event.type !== BID_PLACED_EVENT) continue;
			// The payload `decide()` built three lines earlier in this same
			// transaction, so — unlike `releaseNomination`'s close, which
			// arrives from elsewhere — it is known to be well formed. The
			// narrowing below is what keeps the insert from firing on a
			// payload shape a later story changes.
			const payload = event.payload as BidPlacedPayload;
			if (typeof payload.seedHash !== 'string' || payload.seedHash === '') continue;
			await client.query(
				`insert into ${CONTENTION_SEEDS_TABLE}
					(fantrax_player_id, seed, created_at)
				values ($1, $2, $3)`,
				// The EVENT's own instant, not a second clock read: the row and
				// the event it belongs to state the same moment (AD-3).
				[payload.fantraxPlayerId, seed, event.occurredAt]
			);
		}
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
 * **A seed is generated on every call and stored on almost none.** It is
 * cheap, and generating it unconditionally is what keeps the SHELL from
 * deciding whether a lottery is opening: `decide()` makes that judgement,
 * publishes `hash(seed)` when it is true, and `recordContentionSeed` writes
 * the row by reading that output. A shell that decided for itself would be a
 * second statement of the rule, and the two could disagree about the one
 * event that matters.
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
	// Generated before the transaction opens and used in exactly two places:
	// hashed into the payload by `decide()`, and stored raw by the projection
	// below. One value, so the published commitment and the sealed seed are
	// the same string by construction.
	const seed = generateSeed();

	return await runTransactionalWrite<LoadedBidState>({
		gateway,
		load: (client) => loadBidState(client, fantraxPlayerId, actor.teamId),
		// The ONE projection, and it fires only when the core published a
		// `seedHash` — which is only on the Bid that opens a Minimum-Bid
		// Contention. Nothing else derived is stored: there is still no
		// `auctions` table, no `bids` table and no claim row, because there is
		// still no uniqueness constraint for an ordinary Bid to collide with.
		projections: [recordContentionSeed(seed)],
		decide: ({ state, now }) => {
			// Asked before `decide()`, never as a gate: "is there an open
			// Auction" is the nomination fold's question, and `PLACE_BID_GATES`
			// names no such question at any size. A Player whose Auction closed
			// between the render and this submit lands here — whereas one whose
			// clock merely ran out reaches the gates and is refused on `expiry`,
			// which is precisely the distinction AD-12 draws.
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

			// **Which half of the commit-reveal this Bid needs, chosen from the
			// state the lock just loaded.** Inside a live contention the only
			// seed that can matter is the SEALED one — a dissolution reveals
			// it, and a join ignores it. Everywhere else the only seed that
			// can matter is the FRESH one, which an opening at exactly
			// $1,000,000 commits to and every other Bid ignores.
			//
			// A live contention with no seed row passes `null`, and that is
			// deliberate rather than defensive: a join is unaffected, and a
			// dissolution throws out of `decide()` (AD-1) rather than
			// releasing every Contender with the commitment still sealed.
			const contentionSeed: ContentionSeed | null =
				state.bid.contention === 'minimum_bid'
					? state.sealedSeed === null
						? null
						: { kind: 'sealed', seed: state.sealedSeed }
					: { kind: 'fresh', seed };

			const decided = decide(state.bid, command, now.toISOString(), contentionSeed);

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
