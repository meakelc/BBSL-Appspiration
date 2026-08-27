/**
 * The Auction page's read: fold the open nomination for one Player, then
 * join Player and Manager reference data. Server-only (Story 2.4).
 *
 * **This IS a nomination.** Until Epic 3 closes anything, "open Auction" and
 * "open Nomination" are the same row of the same fold — `nominationsReducer`
 * / `nominationForPlayer`, the identical accessor every other gate in Epic 2
 * uses (`server/nomination.ts`, `server/auction-open.ts`'s sibling reads).
 * Nothing here invents a second projection.
 *
 * **No write path.** This module opens a transaction only to get one
 * `TransactionalClient` for `loadEventsViaClient` plus the point reads that
 * follow, exactly as `readAuctionOpenReport`/`loadNominatablePool` do, and
 * always rolls back — rendering a page is not a write, and it deliberately
 * takes NO advisory lock: a report torn across a concurrent nomination or
 * close is possible and harmless, since it can only ever be stale, never
 * authoritative.
 *
 * **Reference fields come from `free_agent_players` and nothing else** — no
 * salary or contract-length column exists on that table
 * (`20260824020000_live_reference_tables.sql:94-125`), which is exactly why
 * this story's metadata line carries only `positions`/`nba_team`. A Player
 * present in the fold but absent from the reference table (a stale or
 * mid-import row) still renders by name from the fold; the metadata line is
 * simply omitted, never blanked or invented.
 *
 * **The nominating Manager's name.** `OpenNomination` — the fold's own
 * output type (`core/projection/nominations.ts`) — deliberately carries no
 * `managerId`, and the fold narrows to what the Slot/board questions need.
 * Rather than widen `OpenNomination` — which every existing fold test
 * asserts the exact shape of via `toEqual` — this module re-reads the SAME
 * already-loaded events array for the one `NominationPlaced` row that
 * produced the kept nomination (matched on `fantraxPlayerId`, `teamId` and
 * `occurredAt`, exactly the fields the fold copied across).
 *
 * The id then comes off the event ENVELOPE — `AppendedEvent.managerId`
 * (`core/types.ts:89`), the acting Manager the shell stamped on the append —
 * not off the payload's own copy of it. The envelope is the same field for
 * a `NominationPlaced`, is typed `string` rather than `unknown`, and is the
 * one the log guarantees for every event regardless of what a payload
 * happens to carry; reading the payload copy made a third source for a
 * field the loaded events already expose.
 *
 * The name resolves through a `teams left join managers` keyed on that id,
 * the shape `auction-open.ts:93-98` establishes and for the reason it
 * states — a Team whose Manager row is missing comes back with a null name
 * rather than vanishing. The join also checks `m.team_id = t.id`, so a
 * `managerId` that does not actually belong to the nominating Team resolves
 * to null rather than to some other Team's Manager. The Team's own NAME is
 * still the fold's (`nomination.teamName`) and is never re-read from
 * `teams`: the spec pins the nominating Team to the fold, and a second
 * source for it could disagree.
 *
 * When the Manager cannot be resolved the page renders the Team name ALONE.
 * `formatTeamManager` (`core/team-identity.ts`) is the one renderer for the
 * pairing and is never re-implemented here, but it has no shape for "Team
 * known, Manager unknown" — and pairing the Team with its own name produced
 * `Lakers — Lakers`, which reads as a Manager literally called "Lakers".
 * That is a name present in neither the fold nor the reference table, which
 * the spec's Ask First list forbids inventing. An unpaired Team name states
 * exactly what is known and nothing more.
 */

import type { AppendedEvent } from '../core/types.ts';
import { fold } from '../core/projection/fold.ts';
import {
	INITIAL_NOMINATIONS,
	NOMINATION_PLACED_EVENT,
	nominationForPlayer,
	nominationsReducer
} from '../core/projection/nominations.ts';
import type { OpenNomination } from '../core/projection/nominations.ts';
import { formatTeamManager } from '../core/team-identity.ts';
import { loadEventsViaClient } from './event-log.ts';
import type { ConnectionGateway } from '../shell/write.ts';

const FREE_AGENT_PLAYERS_TABLE = 'free_agent_players';
const TEAMS_TABLE = 'teams';
const MANAGERS_TABLE = 'managers';

/** The Player metadata line, present only when the reference row exists. */
export type AuctionPageMetadata = {
	readonly positions: string;
	readonly nbaTeam: string;
};

/** Everything the Auction page renders. Read-only — no bid, no figure. */
export type AuctionPageState = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** `null` when the Player is absent from `free_agent_players` (I/O matrix: "Missing reference row"). */
	readonly metadata: AuctionPageMetadata | null;
	/** The nominating Team, spelled out with its acting Manager — `formatTeamManager`'s one rendering. */
	readonly nominatingTeam: string;
	/** The nomination's own instant, for the page to render twice. */
	readonly nominatedAt: string;
};

/**
 * The acting `managerId` of the one `NominationPlaced` event that produced
 * `nomination`, read off the event ENVELOPE.
 *
 * The event is located by the three fields the fold copied across — the
 * payload's `fantraxPlayerId` and `teamId`, and the envelope's `occurredAt`
 * — which is the only way back to it, since `OpenNomination` carries no
 * seq. Locating it is defensive (a malformed payload is skipped rather than
 * thrown over, `nominations.ts`'s own discipline for a row an insert-only
 * log cannot correct in place); reading the id off it is not, because
 * `AppendedEvent.managerId` is a `string` the shell stamps on every append.
 *
 * `null` therefore means "no such event in the log", not "the event had no
 * Manager" — the second case cannot arise.
 */
function findNominationManagerId(
	events: readonly AppendedEvent[],
	nomination: OpenNomination
): string | null {
	for (const candidate of events) {
		if (candidate.type !== NOMINATION_PLACED_EVENT) continue;
		if (candidate.occurredAt !== nomination.occurredAt) continue;
		if (typeof candidate.payload !== 'object' || candidate.payload === null) continue;
		const record = candidate.payload as Record<string, unknown>;
		if (record['fantraxPlayerId'] !== nomination.fantraxPlayerId) continue;
		if (record['teamId'] !== nomination.teamId) continue;
		return candidate.managerId !== '' ? candidate.managerId : null;
	}
	return null;
}

/**
 * Read the Auction page's state for one Player, or `null` when there is no
 * open nomination for them — the caller 404s on `null` (closed, or never
 * nominated).
 *
 * One `loadEventsViaClient` read folds the nomination; at most two further
 * reads follow only when a nomination is found — one keyed on
 * `fantrax_player_id` (unique on `free_agent_players`), one a join keyed on
 * `teams.id` (primary key) and the nominating event's own `managerId`
 * (`managers.id`, primary key). Each returns at most one row.
 */
export async function loadAuctionPage(
	gateway: ConnectionGateway,
	fantraxPlayerId: string
): Promise<AuctionPageState | null> {
	const client = await gateway.connect();
	try {
		await client.query('begin');

		const events = await loadEventsViaClient(client);
		const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);
		const nomination = nominationForPlayer(nominations, fantraxPlayerId);

		if (nomination === null) {
			await client.query('rollback');
			return null;
		}

		const referenceResult = await client.query(
			`select player_name, positions, nba_team
			from ${FREE_AGENT_PLAYERS_TABLE}
			where fantrax_player_id = $1`,
			[fantraxPlayerId]
		);
		const referenceRow = referenceResult.rows[0];
		const metadata: AuctionPageMetadata | null =
			referenceRow === undefined
				? null
				: {
						positions: String(referenceRow['positions']),
						nbaTeam: String(referenceRow['nba_team'])
					};
		// Player reference fields come from `free_agent_players` and nothing
		// else (Boundaries/Always), so the name is the reference row's when
		// there is one. The fold's copy is the fallback for the "Missing
		// reference row" matrix row alone — which is what makes that row a
		// distinct behaviour rather than the same path twice.
		const playerName =
			referenceRow === undefined ? nomination.playerName : String(referenceRow['player_name']);

		const managerId = findNominationManagerId(events, nomination);
		const managerResult =
			managerId === null
				? { rows: [] as ReadonlyArray<Record<string, unknown>> }
				: await client.query(
						`select m.display_name
						from ${TEAMS_TABLE} t
						left join ${MANAGERS_TABLE} m on m.id = $1 and m.team_id = t.id
						where t.id = $2`,
						[managerId, nomination.teamId]
					);
		const managerRow = managerResult.rows[0];
		const rawDisplayName = managerRow === undefined ? null : managerRow['display_name'];
		// The left join returns a row whenever the Team exists, with a null
		// name when no live `managers` row matches BOTH the acting id and
		// that Team — so `null` here covers the missing Team, the missing
		// Manager and the mismatched pairing alike.
		const managerDisplayName = typeof rawDisplayName === 'string' ? rawDisplayName : null;

		await client.query('rollback');

		return {
			fantraxPlayerId: nomination.fantraxPlayerId,
			playerName,
			metadata,
			// Team alone when the Manager cannot be resolved — never the Team
			// paired with its own name, which would read as a Manager called
			// "Lakers" and invent a figure the spec forbids inventing.
			nominatingTeam:
				managerDisplayName === null
					? nomination.teamName
					: formatTeamManager(nomination.teamName, managerDisplayName),
			nominatedAt: nomination.occurredAt
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
