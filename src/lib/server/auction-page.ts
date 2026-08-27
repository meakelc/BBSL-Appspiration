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
 * `managerId`: only the raw `NominationPlaced` payload does
 * (`server/nomination.ts`'s `NominationPlacedPayload`), and the fold
 * narrows to what the Slot/board questions need. Rather than widen
 * `OpenNomination` — which every existing fold test asserts the exact shape
 * of via `toEqual` — this module re-reads the SAME already-loaded events
 * array for the one `NominationPlaced` row that produced the kept
 * nomination (matched on `fantraxPlayerId`, `teamId` and `occurredAt`,
 * exactly the fields the fold copied across), and takes `managerId` off its
 * payload. `formatTeamManager` (`core/team-identity.ts`) is the one
 * renderer for the pairing — never re-implemented here.
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
 * The `managerId` off the one `NominationPlaced` event that produced
 * `nomination`, read defensively — a malformed or absent payload returns
 * `null` rather than throwing, exactly `nominations.ts`'s own discipline
 * for a row an insert-only log cannot correct in place.
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
		const managerId = record['managerId'];
		return typeof managerId === 'string' && managerId !== '' ? managerId : null;
	}
	return null;
}

/**
 * Read the Auction page's state for one Player, or `null` when there is no
 * open nomination for them — the caller 404s on `null` (closed, or never
 * nominated).
 *
 * One `loadEventsViaClient` read folds the nomination; at most two further
 * point reads follow only when a nomination is found, keyed on
 * `fantrax_player_id` (unique on `free_agent_players`) and the nominating
 * event's own `managerId` (`managers.id`, primary key) — each returns at
 * most one row.
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
			`select positions, nba_team
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

		const managerId = findNominationManagerId(events, nomination);
		const managerResult =
			managerId === null
				? { rows: [] as ReadonlyArray<Record<string, unknown>> }
				: await client.query(`select display_name from managers where id = $1`, [managerId]);
		const managerRow = managerResult.rows[0];
		// A managerId that cannot be resolved to a live `managers` row still
		// names the Team; `formatTeamManager` needs a display name, and the
		// Team's own name is the only honest fallback for one that cannot be
		// found.
		const managerDisplayName =
			managerRow === undefined ? nomination.teamName : String(managerRow['display_name']);

		await client.query('rollback');

		return {
			fantraxPlayerId: nomination.fantraxPlayerId,
			playerName: nomination.playerName,
			metadata,
			nominatingTeam: formatTeamManager(nomination.teamName, managerDisplayName),
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
