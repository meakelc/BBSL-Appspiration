/**
 * The nomination gate: the read behind the page, and the one transaction
 * that places a nomination. Server-only (Story 2.1).
 *
 * **Nothing here is stored.** There is no migration in this story and no
 * `nomination_slots` table: board occupancy, Nomination Slot status and the
 * League Clock are all folds of `auction_events`. Story 1.11's own note
 * anticipated a projection table here; the answer on arriving is that
 * nothing needs one, because the log already carries every fact the gate
 * asks about. Story 2.2 adds ONE table, `open_nominations`, and it is not a
 * projection in the reading sense: nothing selects from it. It is a
 * write-side constraint, registered through the `projections` hook because
 * that hook is the one seam that persists inside the appending transaction,
 * and its only job is to make a second writer's insert fail. Story 2.3's
 * acceptance criteria require Slot status to be a FOLD rather than a stored
 * flag that is read, and it still is.
 *
 * **The claim row is written once and deleted once.** Story 2.3 adds
 * `releaseNomination`, the delete that clears a claim when a Player's
 * Auction closes. It ships tested and DELIBERATELY UNREGISTERED: no
 * `AuctionClosed` producer exists, Epic 3 owns closing, and the delete
 * belongs inside the transaction that appends the close (Story 3.4's), not
 * inside `placeNomination`'s. The Slot's release itself is not this
 * function's doing either — `nominationsReducer` frees it by folding the
 * same close event.
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
 * **Device class rides the envelope, never the payload.** It is a
 * measurement column (`shell/write.ts:226`), not domain data — no reducer
 * and no gate reads it, or an NFR §5 measurement would quietly become a rule
 * input. The route classifies the header and passes the result in; the core
 * never sees a header.
 *
 * A refusal is a returned value, never a throw (AD-1). A throw out of the
 * transaction rolls it back, leaving no event and no clock reset.
 */

import { fold } from '../core/projection/fold.ts';
import {
	AUCTION_CLOSED_EVENT,
	INITIAL_NOMINATIONS,
	NOMINATION_PLACED_EVENT,
	nominationForPlayer,
	nominationForTeam,
	nominationsReducer
} from '../core/projection/nominations.ts';
import { INITIAL_PHASE, phaseReducer } from '../core/projection/phase.ts';
import {
	nominationConsequenceSentence,
	nominationRefusalDetail,
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
import { constraintOf, isUniqueViolation } from './pg-errors.ts';

const FREE_AGENT_PLAYERS_TABLE = 'free_agent_players';

/** Who acted, resolved server-side from application tables (AD-4). */
export type NominationActor = {
	readonly managerId: string;
	readonly teamId: string;
	/** The acting Team's name — carried into the payload so a refusal can name it. */
	readonly teamName: string;
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
};

/**
 * Read the phase, the open nominations, the named pool Player and any
 * contract holder — all from ONE read of the log plus two point lookups, on
 * the given client.
 *
 * Two folds over a single `loadEventsViaClient` read: the two projections
 * cannot disagree about which events they saw, because they saw the same
 * array. The two table reads are both keyed on `fantrax_player_id`, which is
 * `unique` on both tables, so each returns at most one row.
 */
export async function loadNominationState(
	client: TransactionalClient,
	fantraxPlayerId: string
): Promise<NominationState> {
	const events = await loadEventsViaClient(client);
	const phase = fold(INITIAL_PHASE, events, phaseReducer);
	const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);

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
	const contractHolderTeamName = contractRow === undefined ? null : String(contractRow['name']);

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
	 * Why this Player is unavailable, worded by the pure core, or `null` when
	 * they are available. Never re-worded by the surface.
	 */
	readonly unavailableDetail: string | null;
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
	/** `NOMINATION_CONSEQUENCE` as a finished sentence, for beside the confirm. */
	readonly consequence: string;
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
	actorTeamId: string | null
): Promise<NominatablePool> {
	const client = await gateway.connect();
	try {
		await client.query('begin');

		const events = await loadEventsViaClient(client);
		const phase = fold(INITIAL_PHASE, events, phaseReducer);
		const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);

		// One statement, left joined, rather than one query per Player: the
		// contract holder is part of what makes a row unavailable, and asking
		// per row would be a query per pool Player on every page view.
		const poolResult = await client.query(
			`select p.fantrax_player_id, p.player_name, p.positions, p.nba_team,
				t.name as contract_team_name
			from ${FREE_AGENT_PLAYERS_TABLE} p
			left join team_rosters r on r.fantrax_player_id = p.fantrax_player_id
			left join teams t on t.id = r.team_id
			order by p.player_name asc`
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
					contractHolderTeamName:
						row.contract_team_name === null || row.contract_team_name === undefined
							? null
							: String(row.contract_team_name)
				},
				// The empty string is not a Team id, so a signed-in Manager
				// bound to no Team sees each Player's own availability rather
				// than every row collapsing to a Slot refusal.
				actorTeamId ?? ''
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
				unavailableDetail: playerRefusal === null ? null : nominationRefusalDetail(playerRefusal)
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
						actorTeamId
					);

		return {
			players,
			slotAvailable: teamRefusal === null,
			slotDetail: teamRefusal === null ? null : nominationRefusalDetail(teamRefusal),
			consequence: nominationConsequenceSentence(null)
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

/** The PK that makes a Player nominatable once (`20260825000000_open_nominations.sql`). */
const PLAYER_CLAIM_CONSTRAINT = 'open_nominations_pkey';

/** The unique constraint that makes a Team's Nomination Slot single. */
const TEAM_CLAIM_CONSTRAINT = 'open_nominations_team_id_key';

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
		await client.query(
			`insert into ${OPEN_NOMINATIONS_TABLE}
				(fantrax_player_id, team_id, seq, occurred_at)
			values ($1, $2, $3, $4)`,
			[payload.fantraxPlayerId, payload.teamId, event.seq, event.occurredAt]
		);
	}
};

/**
 * Delete the claim row for every `AuctionClosed` in the batch just appended,
 * on the appending transaction's own client (Story 2.3).
 *
 * The mirror image of `claimNomination`, and for the same reasons: it is a
 * WRITE-SIDE statement, never a read, and it goes through the `projections`
 * hook so the delete commits with the close event or not at all (AD-5).
 * Removing the row is what returns the Player to the pool and the Team's
 * Nomination Slot to them at the data layer — the *answer* to "is this Slot
 * held" stays `nominationsReducer`'s fold over `auction_events`, which
 * releases on exactly the same event without consulting this table.
 *
 * Keyed on the Player alone, exactly as the fold is: the Slot frees whether
 * the nominator won, lost or never bid, and `open_nominations`' primary key
 * IS `fantrax_player_id`, so one statement clears one claim.
 *
 * Idempotent by construction. A close for a Player with no claim row —
 * already released, or never nominated — deletes zero rows and does not
 * raise; there is no `returning`, nothing asserts a row count, and no
 * refusal can come out of here. That is deliberate: unlike the insert, whose
 * collision IS the rule, a delete that finds nothing has already achieved
 * what it was asked to achieve.
 *
 * **Deliberately not registered.** No `AuctionClosed` producer exists — Epic
 * 3 owns closing — and the delete must run inside the transaction that
 * appends the close, which is Story 3.4's transaction, not `placeNomination`'s.
 * Adding it to `placeNomination`'s `projections` would issue a delete that
 * can never match, on a path that never appends a close. Shipping it tested
 * and unregistered makes 3.4 a one-line registration.
 */
export const releaseNomination: ProjectionUpdater = async (client, appended) => {
	for (const event of appended) {
		if (event.type !== AUCTION_CLOSED_EVENT) continue;
		const payload = event.payload as { readonly fantraxPlayerId: string };
		await client.query(
			`delete from ${OPEN_NOMINATIONS_TABLE}
			where fantrax_player_id = $1`,
			[payload.fantraxPlayerId]
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
			load: (client) => loadNominationState(client, fantraxPlayerId),
			// The claim row, written inside the appending transaction (Story
			// 2.2). Nothing reads it; it exists so a second writer collides.
			projections: [claimNomination],
			decide: ({ state }) => {
				const refusal = refuseNomination(state, actor.teamId);
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
					managerId: actor.managerId
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
