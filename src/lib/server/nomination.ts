/**
 * The nomination gate: the read behind the page, and the one transaction
 * that places a nomination. Server-only (Story 2.1).
 *
 * **Nothing here is READ from a table.** Board occupancy, Nomination Slot
 * status and the League Clock are all folds of `auction_events`. Story 1.11's
 * own note anticipated a projection table here; the answer on arriving was
 * that nothing needs one, because the log already carries every fact the gate
 * asks about. There are now TWO tables — `open_nominations` (Story 2.2) and
 * `nomination_slots` (FR-9's amendment) — and neither is a projection in the
 * reading sense: nothing selects from either. They are write-side
 * constraints, registered through the `projections` hook because that hook is
 * the one seam that persists inside the appending transaction, and their only
 * job is to make a second writer's insert fail. Story 2.3's acceptance
 * criteria require Slot status to be a FOLD rather than a stored flag that is
 * read, and it still is.
 *
 * **Two claims now, with two lifetimes.** A nomination writes both: a board
 * seat keyed on the Player, and — unless the actor is exempt — a Nomination
 * Slot keyed on the Team. The seat is deleted when that Player's Auction
 * ENDS, either way it can end. The Slot is deleted only when that Team WINS a
 * Player, which is the amended FR-9 and the reason one row could no longer
 * carry both. Story 2.3 added `releaseNomination`, the delete that clears a
 * claim when a Player's Auction closes, and shipped it unregistered because no
 * `AuctionClosed` producer existed. Story 3.4 is that producer: `server/close.ts` registers
 * this exact updater, unchanged, in the transaction that appends the close.
 * It is still not on `placeNomination`'s `projections`, because that path
 * appends no close. The Slot's release itself is not this module's doing
 * either — `nominationsReducer` frees it by folding the same close event.
 *
 * **The gate re-derives every check under the lock, whatever the page
 * rendered.** `loadNominationState` runs inside `runTransactionalWrite`'s
 * transaction, after `pg_advisory_xact_lock` (AD-6), so a page rendered
 * before someone else nominated the same Player cannot race a second
 * nomination past the board. The page calls `loadNominatablePool` through
 * its own connection purely to render the list; that render is never the
 * check.
 *
 * **The two live tables answer two different questions.** `free_agent_players`
 * says whether the Player exists in the pool at all; `team_rosters` says
 * whether they are under contract. Both are mutable reference data, not
 * event-sourced (`20260824020000_live_reference_tables.sql`), and both are
 * read on the locked transaction's own client rather than trusted from the
 * render.
 *
 * **Under contract now has TWO sources, and one refusal** (Story 3.4).
 * `team_rosters` answers what a Team started the offseason with; the
 * `AuctionContracts` fold answers what it has won since. A Player is under
 * contract if EITHER says so, and `under_contract` — which has always been
 * this gate's answer to a rostered Player — is what a won Player is refused
 * as, naming the winning Team. No refusal was added: `refuseNomination` reads
 * one `contractHolderTeamName`, and this module is what resolves it from
 * whichever source holds one. The table wins a tie, because a Player who has
 * been promoted onto a roster is on it for real.
 *
 * **Device class rides the envelope, never the payload.** It is a
 * measurement column (`shell/write.ts:226`), not domain data — no reducer
 * and no gate reads it, or an NFR §5 measurement would quietly become a rule
 * input. The route classifies the header and passes the result in; the core
 * never sees a header.
 *
 * A refusal is a returned value, never a throw (AD-1). A throw out of the
 * transaction rolls it back, leaving no event and no clock reset.
 */

import {
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer
} from '../core/projection/auctions.ts';
import { fold } from '../core/projection/fold.ts';
import {
	AUCTION_CLOSED_EVENT,
	AUCTION_CLOSE_REVERSED_EVENT,
	AUCTION_TERMINATED_EVENT,
	INITIAL_NOMINATIONS,
	NOMINATION_PLACED_EVENT,
	nominationForPlayer,
	nominationForTeam,
	nominationsReducer,
	readClosedFacts,
	readReheldSlot,
	readTerminatedPlayerId
} from '../core/projection/nominations.ts';
import {
	INITIAL_CONTRACTS,
	contractForPlayer,
	contractsReducer
} from '../core/projection/contracts.ts';
import { INITIAL_PHASE, phaseReducer } from '../core/projection/phase.ts';
import {
	COMMISSIONER_SLOT_STATUS,
	commissionerConsequenceSentence,
	nominationConsequenceSentence,
	nominationPoolStatus,
	nominationRefusalDetail,
	nominationSlotStatus,
	refuseNomination
} from '../core/rules/nomination.ts';
import type { NominationRefusal, NominationState } from '../core/rules/nomination.ts';
import type { EventEnvelope } from '../core/types.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type {
	ConnectionGateway,
	ProjectionUpdater,
	TransactionalClient,
	WriteOutcome
} from '../shell/write.ts';
import { loadEventsViaClient } from './event-log.ts';
import { enqueueBroadcasts } from './outbox.ts';
import { constraintOf, isUniqueViolation } from './pg-errors.ts';

const FREE_AGENT_PLAYERS_TABLE = 'free_agent_players';

/** Who acted, resolved server-side from application tables (AD-4). */
export type NominationActor = {
	readonly managerId: string;
	readonly teamId: string;
	/** The acting Team's name — carried into the payload so a refusal can name it. */
	readonly teamName: string;
	/**
	 * Whether this actor's nomination spends their Team's one Nomination Slot
	 * (Story 9.8).
	 *
	 * `false` for a Commissioner, who nominates without limit to keep the
	 * number of open Auctions high; `true` for every Manager. Resolved from
	 * `managers.is_commissioner` through the session (AD-15) and NEVER from a
	 * form field — this is the one flag that decides whether a gate applies,
	 * so a browser must not be able to assert it.
	 */
	readonly spendsSlot: boolean;
};

/**
 * The `NominationPlaced` payload: who nominated whom.
 *
 * The actor's manager id, team id, timestamp, `schemaVersion`,
 * `coreVersion` and `deviceClass` are columns `runTransactionalWrite` fills
 * from the envelope, the database clock and the pinned constants — never
 * restated here. `teamId` IS restated, because `nominationsReducer` folds
 * the payload and must not have to reach for an envelope column to know
 * whose Slot was spent.
 *
 * The names are carried so every refusal downstream can name the Player and
 * the Team without re-reading a table that may have changed by then — the
 * same reason `AuctionOpenedPayload` carries Team names.
 */
export type NominationPlacedPayload = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly teamId: string;
	readonly teamName: string;
	readonly managerId: string;
	/**
	 * Whether this nomination spent the Team's Nomination Slot (Story 9.8).
	 *
	 * Carried in the PAYLOAD rather than inferred at fold time for the reason
	 * `core/projection/nominations.ts` states at length: a fold must be a
	 * function of the log, so who is a Commissioner today cannot be allowed to
	 * change what a nomination placed last week meant. It is written on every
	 * event from here on; a payload without it folds to `true`, which is what
	 * every nomination before this story was.
	 */
	readonly holdsSlot: boolean;
};

/**
 * Read the phase, the open nominations, the Auction Contracts, the named pool
 * Player and any contract holder — all from ONE read of the log plus two point
 * lookups, on the given client.
 *
 * Three folds over a single `loadEventsViaClient` read: the projections cannot
 * disagree about which events they saw, because they saw the same array. The
 * two table reads are both keyed on `fantrax_player_id`, which is `unique` on
 * both tables, so each returns at most one row.
 */
export async function loadNominationState(
	client: TransactionalClient,
	fantraxPlayerId: string
): Promise<NominationState> {
	const events = await loadEventsViaClient(client);
	const phase = fold(INITIAL_PHASE, events, phaseReducer);
	const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);
	// What has been WON in this auction (Story 3.4) — the second source of
	// "under contract", folded from the same events the board came from.
	const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);

	const poolResult = await client.query(
		`select fantrax_player_id, player_name
		from ${FREE_AGENT_PLAYERS_TABLE}
		where fantrax_player_id = $1`,
		[fantraxPlayerId]
	);
	const poolRow = poolResult.rows[0];
	const poolPlayer =
		poolRow === undefined
			? null
			: {
					fantraxPlayerId: String(poolRow['fantrax_player_id']),
					playerName: String(poolRow['player_name'])
				};

	// A Player who was promoted into a roster is under contract even if a
	// stale pool row still names them — so this is asked regardless of what
	// the pool said, and answered by the live table rather than by absence
	// from the pool.
	const contractResult = await client.query(
		`select t.name
		from team_rosters r
		join teams t on t.id = r.team_id
		where r.fantrax_player_id = $1`,
		[fantraxPlayerId]
	);
	const contractRow = contractResult.rows[0];
	// Either source names the holder, and the ROSTER wins a tie: a Player the
	// import promoted onto a Team is on that Team for real, whereas a folded
	// Auction Contract is this auction's own output waiting to be exported. In
	// practice the two cannot both answer — a rostered Player is not in the
	// Free Agent pool and so was never nominatable — so the order states which
	// is authoritative rather than resolving a collision that arises.
	const contractHolderTeamName =
		contractRow !== undefined
			? String(contractRow['name'])
			: (contractForPlayer(contracts, fantraxPlayerId)?.teamName ?? null);

	return { phase, nominations, poolPlayer, contractHolderTeamName };
}

/** One Player as the nomination surface prints them. */
export type NominatablePoolRow = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly positions: string;
	readonly nbaTeam: string;
	/** Whether this Player is selectable right now, as the render saw it. */
	readonly available: boolean;
	/**
	 * What state this Player is in, in the core's words — `Available`,
	 * `Nominated`, `In-Auction`, or `Closed to <Team>`. One phrase, printed in
	 * the row's own state cell; the refusal PARAGRAPH belongs to a submit and
	 * is not printed down a list of ~1,470 rows. Never re-worded by the
	 * surface.
	 */
	readonly status: string;
};

/** Everything the nomination page renders, all worded by the core. */
export type NominatablePool = {
	readonly players: readonly NominatablePoolRow[];
	/** Whether the acting Team's Slot is free, as the render saw it. */
	readonly slotAvailable: boolean;
	/**
	 * The refusal sentence the gate would give this Team right now regardless
	 * of which Player they pick — the held Slot, or the wrong phase — or
	 * `null` when the Team may nominate.
	 */
	readonly slotDetail: string | null;
	/**
	 * What the Slot is doing, in one line, for the panel that reports it at
	 * rest. `null` when the Slot is unavailable for a reason that is NOT the
	 * Team's own nomination — the wrong phase, an unbound actor — because
	 * those are refusals and `slotDetail` is the sentence that owns them.
	 */
	readonly slotStatus: string | null;
	/** `NOMINATION_CONSEQUENCE` as a finished sentence, for beside the confirm. */
	readonly consequence: string;
	/**
	 * Whether this actor's nomination spends their Team's Slot (Story 9.8).
	 *
	 * A RENDERING input and nothing else: the page needs it to ask the core
	 * for the one sentence that names the Player it chose client-side, which
	 * the server could not render without knowing the choice. The gate is
	 * `refuseNomination` under the lock, from the session's own
	 * `managers.is_commissioner`, so nothing a browser does with this value
	 * can change what it is allowed to nominate.
	 */
	readonly spendsSlot: boolean;
};

type PoolRow = {
	readonly fantrax_player_id: string;
	readonly player_name: string;
	readonly positions: string;
	readonly nba_team: string;
	readonly contract_team_name: string | null;
};

/**
 * The nominatable pool, read through the gateway for the page.
 *
 * It opens a transaction because `loadEventsViaClient` and the pool join
 * both need one client, and then always rolls back, because rendering a list
 * is not a write. It deliberately takes NO advisory lock: the render is
 * never the check, and `placeNomination` re-derives every gate under the
 * lock on submit. A list torn across a concurrent nomination is therefore
 * possible and harmless — it can only ever be stale, never authoritative.
 * `runTransactionalWrite` is deliberately NOT used, for
 * `readAuctionOpenReport`'s reason: it exists to append events, and a
 * `decide` that always rejects in order to read would be a second write path
 * in everything but name.
 *
 * Every sentence it returns comes from the pure core. The server renders;
 * the surface prints.
 */
export async function loadNominatablePool(
	gateway: ConnectionGateway,
	actorTeamId: string | null,
	actorSpendsSlot: boolean = true
): Promise<NominatablePool> {
	const client = await gateway.connect();
	try {
		await client.query('begin');

		const events = await loadEventsViaClient(client);
		const phase = fold(INITIAL_PHASE, events, phaseReducer);
		const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);
		// The won Players (Story 3.4). The pool query's left join answers who
		// is on a ROSTER; this answers who has been won in this auction, and
		// the two are resolved per row below exactly as `loadNominationState`
		// resolves them for the one Player it is asked about.
		const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);
		// A third fold over the SAME loaded events, for one distinction the
		// row's state makes and the gate does not: whether a nominated
		// Player's Auction has had a Bid yet. `auctionForPlayer` is `null`
		// until one lands, which is exactly "Nominated" rather than
		// "In-Auction". It gates nothing — `refuseNomination` is untouched.
		const auctions = fold(INITIAL_AUCTIONS, events, auctionsReducer);

		// One statement, left joined, rather than one query per Player: the
		// contract holder is part of what makes a row unavailable, and asking
		// per row would be a query per pool Player on every page view.
		//
		// THE ORDER IS THE EXPORT'S, not this app's. `source_rank` is the
		// row's position in the supplied Fantrax CSV, which arrives in
		// Fantrax's own default order — the order every Manager has been
		// reading all week in Fantrax itself. Alphabetical, which this query
		// used until Story 9.8, was never neutral: it silently substituted a
		// second ranking for the one the file states, and made a Manager scan
		// ~1,470 names for one they could have found by position.
		//
		// This is NOT the app ranking Players. It repeats the file's order and
		// holds no opinion about it — nothing here reads a Score, and there is
		// still no suggested Player and no "similar players".
		//
		// `player_name` is the tie-break, and it is what makes the list stable
		// rather than left to the planner (AD-1): a pool staged before the
		// rank column existed has every row at 0, and falls back to exactly
		// the alphabetical list this query returned before.
		const poolResult = await client.query(
			`select p.fantrax_player_id, p.player_name, p.positions, p.nba_team,
				t.name as contract_team_name
			from ${FREE_AGENT_PLAYERS_TABLE} p
			left join team_rosters r on r.fantrax_player_id = p.fantrax_player_id
			left join teams t on t.id = r.team_id
			order by p.source_rank asc, p.player_name asc`
		);

		await client.query('rollback');

		const players = (poolResult.rows as unknown as PoolRow[]).map((row) => {
			const fantraxPlayerId = String(row.fantrax_player_id);
			const playerName = String(row.player_name);

			// The SAME `refuseNomination` the transaction calls, per row, so
			// the page can never offer a Player the gate would refuse. A
			// per-row state is built rather than a second availability rule
			// being written here — there is one definition of unavailable.
			const refusal = refuseNomination(
				{
					phase,
					nominations,
					poolPlayer: { fantraxPlayerId, playerName },
					// The roster join's answer, or the Auction Contract's own
					// `teamName` — the identical resolution, in the identical
					// order, that `loadNominationState` makes under the lock.
					// A Player won in this auction is greyed out on the page
					// with the same `under_contract` sentence the submit would
					// refuse them with.
					contractHolderTeamName:
						row.contract_team_name === null || row.contract_team_name === undefined
							? (contractForPlayer(contracts, fantraxPlayerId)?.teamName ?? null)
							: String(row.contract_team_name)
				},
				// The empty string is not a Team id, so a signed-in Manager
				// bound to no Team sees each Player's own availability rather
				// than every row collapsing to a Slot refusal.
				actorTeamId ?? '',
				actorSpendsSlot
			);

			// A held Slot is not a property of a Player and must not grey out
			// the whole list as though every Player were unavailable: it is
			// reported once, as `slotDetail` below.
			const playerRefusal = refusal?.kind === 'slot_in_use' ? null : refusal;

			return {
				fantraxPlayerId,
				playerName,
				positions: String(row.positions),
				nbaTeam: String(row.nba_team),
				available: playerRefusal === null,
				status: nominationPoolStatus(
					playerRefusal,
					auctionForPlayer(auctions, fantraxPlayerId) !== null
				)
			};
		});

		// Whether this Team may nominate AT ALL, asked with a Player that
		// passes every Player-shaped gate, so the only refusals that can come
		// back are the phase and the Team's own Slot.
		const teamRefusal =
			actorTeamId === null
				? ({ kind: 'unbound_actor' } as NominationRefusal)
				: refuseNomination(
						{
							phase,
							nominations,
							poolPlayer: { fantraxPlayerId: '', playerName: '' },
							contractHolderTeamName: null
						},
						actorTeamId,
						actorSpendsSlot
					);

		// The Player holding this Team's Slot, from the SAME fold every gate
		// above reads. The panel names them rather than printing the refusal
		// sentence at rest: a refusal is a reply to an act, and opening the
		// page is not an act.
		//
		// A Commissioner is never asked: they hold no Slot, so there is no
		// holder to name, and `COMMISSIONER_SLOT_STATUS` is what the panel
		// prints instead.
		const held =
			actorTeamId === null || !actorSpendsSlot
				? null
				: nominationForTeam(nominations, actorTeamId);

		return {
			players,
			slotAvailable: teamRefusal === null,
			slotDetail: teamRefusal === null ? null : nominationRefusalDetail(teamRefusal),
			// Stated for the two cases the Slot itself is the answer to — free,
			// or held by a named Player. Every other reason the Slot is
			// unavailable is a refusal, and `slotDetail` is its sentence. A
			// Commissioner gets the third case (Story 9.8): not a Slot state but
			// the absence of one, said plainly, because "Open for nomination."
			// would describe a rule that does not apply to them.
			slotStatus: !actorSpendsSlot
				? COMMISSIONER_SLOT_STATUS
				: teamRefusal === null || teamRefusal.kind === 'slot_in_use'
					? nominationSlotStatus(held?.playerName ?? null)
					: null,
			consequence: actorSpendsSlot
				? nominationConsequenceSentence(null)
				: commissionerConsequenceSentence(null),
			// Passed through so the page can ask the CORE for the one sentence
			// that names the chosen Player — which it only knows client-side
			// (Story 9.8). It is a rendering input, never a gate: the gate is
			// `refuseNomination`, re-derived under the lock, and a browser that
			// lies about this changes only what it prints to itself.
			spendsSlot: actorSpendsSlot
		};
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
export type NominationRejection = {
	readonly refusal: NominationRefusal;
	readonly detail: string;
};

const OPEN_NOMINATIONS_TABLE = 'open_nominations';

/**
 * The Slot claims, in their own table since FR-9 was amended
 * (`20260914000000_nomination_slot_released_on_win.sql`).
 *
 * Separate from `open_nominations` because the two claims no longer end at the
 * same moment: the board seat ends when the Auction ends, and the Slot ends
 * when the nominating Team WINS a Player. One row deleted on close cannot
 * express a claim that survives the close.
 */
const NOMINATION_SLOTS_TABLE = 'nomination_slots';

/** The PK that makes a Player nominatable once (`20260825000000_open_nominations.sql`). */
const PLAYER_CLAIM_CONSTRAINT = 'open_nominations_pkey';

/** The PK that makes a Team's Nomination Slot single. */
const TEAM_CLAIM_CONSTRAINT = 'nomination_slots_pkey';

/**
 * Insert the claim row for the nomination just appended, on the appending
 * transaction's own client.
 *
 * This is a WRITE-SIDE CONSTRAINT, never a read: nothing anywhere selects
 * from `open_nominations`, and the Slot, the board and the League Clock stay
 * folds of `auction_events`. The row exists solely so that a second writer
 * collides with it.
 *
 * Registered through `runTransactionalWrite`'s `projections` hook because
 * that is the one seam that persists INSIDE the appending transaction
 * (AD-5) — so the claim and the event commit together, or neither does.
 *
 * Deliberately NOT `on conflict do nothing`: a swallowed collision is a
 * silent wrong answer. The violation must abort the transaction and be
 * classified into a refusal that names who won.
 */
export const claimNomination: ProjectionUpdater = async (client, appended) => {
	for (const event of appended) {
		if (event.type !== NOMINATION_PLACED_EVENT) continue;
		const payload = event.payload as NominationPlacedPayload;
		// `!== false` mirrors the fold's own reading of the same field, so the
		// rows and the event can never disagree about whether a Slot was spent —
		// and a payload from some future path that omits it claims a Slot, which
		// is the stricter answer (Story 9.8).
		const holdsSlot = payload.holdsSlot !== false;
		await client.query(
			`insert into ${OPEN_NOMINATIONS_TABLE}
				(fantrax_player_id, team_id, seq, occurred_at, holds_slot)
			values ($1, $2, $3, $4, $5)`,
			[payload.fantraxPlayerId, payload.teamId, event.seq, event.occurredAt, holdsSlot]
		);
		// **The second claim, and the one with a different lifetime.** The row
		// above is deleted when this Player's Auction ends; this one is deleted
		// only when this Team wins a Player, which is the amended FR-9. A
		// Commissioner's nomination writes none at all — the exemption is the
		// absence of the row, exactly as it is the absence of a `byTeam` entry
		// in the fold, rather than a flag some later statement has to remember
		// to consult.
		if (!holdsSlot) continue;
		await client.query(
			`insert into ${NOMINATION_SLOTS_TABLE}
				(team_id, fantrax_player_id, seq, occurred_at)
			values ($1, $2, $3, $4)`,
			[payload.teamId, payload.fantraxPlayerId, event.seq, event.occurredAt]
		);
	}
};

/**
 * Clear the claims an ending Auction ends, on the appending transaction's own
 * client (Story 2.3; FR-9's amendment splits it in two).
 *
 * The mirror image of `claimNomination`, and for the same reasons: these are
 * WRITE-SIDE statements, never reads, and they go through the `projections`
 * hook so each delete commits with its event or not at all (AD-5). The
 * *answers* — is this Player on the board, is this Team's Slot held — stay
 * `nominationsReducer`'s fold over `auction_events`, which releases on exactly
 * the same events without consulting either table.
 *
 * **Two claims, two keys, two lifetimes.** They used to be one row deleted by
 * one statement, because a board seat and a Nomination Slot ended at the same
 * moment. They do not any more:
 *
 *   - `open_nominations`, keyed on the PLAYER, is deleted when that Player's
 *     Auction ENDS — by an `AuctionClosed` or an `AuctionTerminated` alike.
 *     That is what returns the Player to the nominatable pool.
 *   - `nomination_slots`, keyed on the TEAM, is deleted only by an
 *     `AuctionClosed`, and keyed on the Team that WON it. Nominating spends
 *     the Slot; winning a Player is the only thing that gives it back. A
 *     termination deletes no Slot row at all, because nobody won.
 *
 * **Story 3.7's argument for widening to `AuctionTerminated` still stands,
 * and now applies to exactly one of the two deletes.** A claim row left behind
 * makes the table and the log disagree PERMANENTLY: an insert-only log can
 * never be replayed to clear a stale row, so the Player would be back in the
 * pool by the fold and still un-nominatable by `open_nominations_pkey`. The
 * same reasoning is what forbids deleting the Slot row on a termination — the
 * fold keeps that Slot held, so a delete here would strand the disagreement in
 * the other direction and hand a Team a nomination the gate would then refuse.
 *
 * **The payloads are read through the core's own readers, not cast.** A close
 * arrives from Story 3.4, not from this module — unlike `claimNomination`,
 * whose payload `placeNomination` builds three lines earlier and therefore
 * knows to be well formed. `readClosedFacts` is the same function
 * `nominationsReducer` folds through, so a close naming no Player, no winner
 * or no parseable price is skipped here exactly as it is skipped there.
 * Casting instead would diverge two ways on a malformed close: a null payload
 * would throw a `TypeError` inside the appending transaction, rolling back a
 * close the fold would have tolerated, and a missing id would bind null and
 * silently delete nothing while the fold released anyway — leaving the log and
 * the claim tables disagreeing about a Player or a Slot forever.
 *
 * Idempotent by construction. A close for a Player with no claim row, or won
 * by a Team holding no Slot, deletes zero rows and does not raise; there is no
 * `returning`, nothing asserts a row count, and no refusal can come out of
 * here. That is deliberate: unlike the inserts, whose collision IS the rule, a
 * delete that finds nothing has already achieved what it was asked to achieve.
 *
 * **Registered by `server/close.ts` and by `server/phase-end.ts`, and by
 * nothing else.** It is still NOT on `placeNomination`'s `projections`: that
 * path appends neither event type, so the deletes could only ever issue
 * against nothing.
 */
export const releaseNomination: ProjectionUpdater = async (client, appended) => {
	for (const event of appended) {
		// **Two event types, two readers, and now two different deletes.** Each
		// payload is read through the CORE's own reader for its own event — the
		// same functions `nominationsReducer` folds through — so what makes each
		// event well formed is decided in one place and this delete can never
		// act on an event the fold skipped, or skip one the fold acted on.
		//
		// A close is read through `readClosedFacts` rather than
		// `readClosedPlayerId` because the WINNER is load-bearing here since
		// FR-9's amendment: the Player says which board seat to free, and the
		// winning Team says whose Slot to free. `nominationsReducer` reads the
		// identical pair off the identical reader.
		if (event.type === AUCTION_CLOSED_EVENT) {
			const closed = readClosedFacts(event.payload);
			// A close naming no Player, no winner or no parseable price is not a
			// well-formed close, identifies no claim row, and is skipped by the
			// fold for the same reason.
			if (closed === null) continue;
			await client.query(
				`delete from ${OPEN_NOMINATIONS_TABLE}
				where fantrax_player_id = $1`,
				[closed.fantraxPlayerId]
			);
			// **The Slot, keyed on the WINNER and on nothing else.** Not on the
			// nominator, and not on the Player: a Team holds at most one Slot, so
			// winning any Player at all returns whichever Slot they hold — very
			// often one spent nominating somebody else entirely. A winner holding
			// no Slot deletes nothing, which is the ordinary case for a
			// Commissioner and for a Team that has not nominated.
			await client.query(
				`delete from ${NOMINATION_SLOTS_TABLE}
				where team_id = $1`,
				[closed.teamId]
			);
			continue;
		}
		if (event.type !== AUCTION_TERMINATED_EVENT) continue;
		const terminated = readTerminatedPlayerId(event.payload);
		// A termination naming no Player identifies no claim row, so there is
		// nothing to delete and no statement to issue.
		if (terminated === null) continue;
		// **The board seat ONLY.** Nobody won, so no Slot is released — the
		// nominating Team keeps the one they spent on a Player nobody bid for,
		// and `nominationsReducer` leaves `byTeam` untouched on exactly this
		// event. Deleting the Slot row here would put the table and the fold in
		// permanent disagreement, and an insert-only log can never be replayed
		// to put a deleted claim back.
		await client.query(
			`delete from ${OPEN_NOMINATIONS_TABLE}
			where fantrax_player_id = $1`,
			[terminated]
		);
	}
};

/**
 * Re-insert the Slot claim a reversed Close hands back, on the appending
 * transaction's own client (Story 7.13, FR-32, AD-32, AD-33).
 *
 * **The only other way a Slot claim is written, and it lives HERE** — the one
 * module that owns `nomination_slots` — rather than beside the reversal. A
 * close that released the winning Team's Slot deleted this row; reversing the
 * close puts it back only when the reversal's RECORD says so
 * (`slotReheld: true`), which the core decided only when the Team held no Slot
 * at that moment. The row carries the RE-HELD nomination's own `seq` and
 * instant, because the claim belongs to that nomination exactly as the
 * original did.
 *
 * Read through `readReheldSlot`, the core's own reader for this event — the
 * same function `nominationsReducer` folds through — so the table and the
 * fold cannot disagree about which reversals re-held a Slot.
 *
 * Deliberately NOT `on conflict do nothing`, for `claimNomination`'s reason: a
 * collision means the fold and the table disagree, and a swallowed one is a
 * silent wrong answer. It aborts the transaction instead.
 *
 * Registered by `server/close-reversal.ts` and by nothing else.
 */
export const reholdNominationSlot: ProjectionUpdater = async (client, appended) => {
	for (const event of appended) {
		if (event.type !== AUCTION_CLOSE_REVERSED_EVENT) continue;
		const reheld = readReheldSlot(event.payload);
		if (reheld === null) continue;
		await client.query(
			`insert into ${NOMINATION_SLOTS_TABLE}
				(team_id, fantrax_player_id, seq, occurred_at)
			values ($1, $2, $3, $4)`,
			[
				reheld.nomination.teamId,
				reheld.nomination.fantraxPlayerId,
				reheld.seq,
				reheld.nomination.occurredAt
			]
		);
	}
};

/**
 * Which refusal a `23505` on this table means, by constraint name — or
 * `null` when the error is not one of ours and must be rethrown as a bug
 * (AD-1).
 *
 * The name is the whole signal: the two constraints answer two different
 * questions ("was this Player already nominated" versus "was this Team's
 * Slot already spent"), and a refusal that named the wrong one would be a
 * confidently wrong sentence.
 */
export function classifyNominationConflict(
	error: unknown
): 'already_nominated' | 'slot_in_use' | null {
	if (!isUniqueViolation(error)) return null;
	switch (constraintOf(error)) {
		case PLAYER_CLAIM_CONSTRAINT:
			return 'already_nominated';
		case TEAM_CLAIM_CONSTRAINT:
			return 'slot_in_use';
		default:
			return null;
	}
}

/**
 * Name the holder for a refusal the constraint produced, on a FRESH unlocked
 * connection after the rollback.
 *
 * By the time `23505` arrives the transaction is rolled back and its folded
 * state is gone, so the winner is not in hand. Naming is not optional —
 * `rules/nomination.ts`'s first rule is that everything blocking is NAMED,
 * never counted — so this buys the name from the log, which is still the
 * only source of truth. It can only be stale in the direction of being MORE
 * correct, and `unrecorded` is the honest fallback if it finds nothing or
 * itself fails.
 *
 * It reads `auction_events`, never `open_nominations`.
 */
async function nameTheHolder(
	gateway: ConnectionGateway,
	kind: 'already_nominated' | 'slot_in_use',
	actorTeamId: string,
	fantraxPlayerId: string
): Promise<NominationRefusal> {
	try {
		const client = await gateway.connect();
		try {
			await client.query('begin');
			const events = await loadEventsViaClient(client);
			await client.query('rollback');
			const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);

			if (kind === 'already_nominated') {
				const onBoard = nominationForPlayer(nominations, fantraxPlayerId);
				if (onBoard === null) return { kind: 'unrecorded' };
				return {
					kind: 'already_nominated',
					playerName: onBoard.playerName,
					teamName: onBoard.teamName
				};
			}

			const slotHolder = nominationForTeam(nominations, actorTeamId);
			if (slotHolder === null) return { kind: 'unrecorded' };
			return { kind: 'slot_in_use', playerName: slotHolder.playerName };
		} finally {
			client.release();
		}
	} catch {
		// The re-read is a courtesy on top of an already-decided refusal; if
		// it fails, the Manager still gets a true sentence rather than a 500.
		return { kind: 'unrecorded' };
	}
}

/**
 * Place a nomination: one transaction appending exactly one
 * `NominationPlaced` event, or nothing at all.
 *
 * The confirmation is checked by the route before this is called and is NOT
 * a rules gate — it establishes only that the request meant to nominate.
 * Everything that could make a nomination wrong is re-derived here, under
 * the lock, from the log and the live tables.
 *
 * Returns the pipeline's own `WriteOutcome`: `accepted` with the single
 * appended event, or `rejected` carrying a `NominationRejection`. The Slot,
 * the board and the League Clock reset are all folds of the log; the one
 * registered projection, `claimNomination`, is a write-side constraint that
 * nothing ever reads (Story 2.2).
 *
 * Two writers that both pass the gate under the lock are separated by that
 * constraint rather than by the read that preceded it: the loser's claim
 * insert raises SQLSTATE `23505`, the transaction rolls back, and the
 * violation is classified into the `already_nominated` or `slot_in_use`
 * refusal the pure core already words — returned, never thrown.
 */
export async function placeNomination(
	gateway: ConnectionGateway,
	actor: NominationActor,
	fantraxPlayerId: string,
	deviceClass: string
): Promise<WriteOutcome> {
	try {
		return await runTransactionalWrite<NominationState>({
			gateway,
			// Story 5.2 broadcasts this write: a `NominationPlaced` puts a Player
			// on the Board, which is the whole league's business and the cue to
			// bid. `enqueueBroadcasts` files one channel-addressed intent per
			// event in the broadcast set. `eligibility.ts` and
			// `import-promotion.ts` pass no `enqueue` at all: Commissioner
			// bookkeeping is not league news, and a notice for it would be channel
			// noise nothing can mute.
			enqueue: enqueueBroadcasts,
			load: (client) => loadNominationState(client, fantraxPlayerId),
			// The claim row, written inside the appending transaction (Story
			// 2.2). Nothing reads it; it exists so a second writer collides.
			projections: [claimNomination],
			decide: ({ state }) => {
				const refusal = refuseNomination(state, actor.teamId, actor.spendsSlot);
				if (refusal !== null) {
					const rejection: NominationRejection = {
						refusal,
						detail: nominationRefusalDetail(refusal)
					};
					return { kind: 'rejected', reason: rejection };
				}

				// Non-null by construction: `refuseNomination` returns
				// `unknown_player` for a null `poolPlayer`, so reaching here means
				// the pool row was read. The guard exists to give TypeScript the
				// narrowing rather than to handle a reachable state.
				const player = state.poolPlayer;
				if (player === null) {
					throw new Error('placeNomination: the gate passed with no pool Player loaded');
				}

				const payload: NominationPlacedPayload = {
					fantraxPlayerId: player.fantraxPlayerId,
					playerName: player.playerName,
					teamId: actor.teamId,
					teamName: actor.teamName,
					managerId: actor.managerId,
					// What the gate just decided, written down so the fold decides
					// the same thing forever (Story 9.8).
					holdsSlot: actor.spendsSlot
				};

				const event: EventEnvelope = {
					type: NOMINATION_PLACED_EVENT,
					payload,
					managerId: actor.managerId,
					teamId: actor.teamId,
					// The measurement column, populated from the first event of this
					// type onward: an insert-only log cannot be backfilled.
					deviceClass
				};
				return { kind: 'accepted', events: [event] };
			}
		});
	} catch (error) {
		// A `23505` from the claim insert is the data layer answering the very
		// question the gate asked a moment earlier, and losing. It is not a
		// bug: it is a refusal the pure core already words, arriving late.
		// Anything else is a bug and is rethrown unchanged (AD-1).
		//
		// By this point `runTransactionalWrite` has already rolled the
		// transaction back, so no event and no claim row survive.
		const kind = classifyNominationConflict(error);
		if (kind === null) throw error;

		const refusal = await nameTheHolder(gateway, kind, actor.teamId, fantraxPlayerId);
		const rejection: NominationRejection = {
			refusal,
			detail: nominationRefusalDetail(refusal)
		};
		// A rejection is a RETURNED value, never a throw — the same shape the
		// gate's own refusals take, so `+page.server.ts` needs no new branch.
		return { kind: 'rejected', reason: rejection };
	}
}
