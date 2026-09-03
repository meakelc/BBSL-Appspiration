/**
 * One Team's view: the whole published set for a named Team, from one fold.
 * Server-only (Story 4.5).
 *
 * **`loadStripTeam`'s assembly, generalised from the viewer's Team to a named
 * one** — one transaction, ONE `loadEventsViaClient`, every fold taken over
 * that single events array, `teamMoneyStateFor` at `NO_AUCTION_PROBE_ID` so
 * nothing is excluded, and always `rollback`. It takes NO advisory lock, for
 * `loadPositions`' reason: rendering a page is not a write, and a report torn
 * across a concurrent bid can only ever be stale, never authoritative.
 *
 * **It RETHROWS where the strip's own read returns `null`.** `loadStripTeam`
 * swallows every failure because its caller is `+layout.server.ts` and a throw
 * there would 500 every surface in the product over a strip. This module's
 * caller is a page whose entire content is the figures, so an unreachable
 * database must produce an error rather than a Team view full of zeroes —
 * `loadPositions`' posture exactly. The one `null` it does return is the
 * honest answer to "no such Team", which the route turns into a 404.
 *
 * **Nothing derived crosses the wire as authority.** Every money figure on the
 * returned `TeamView` is a rendered string produced by `teamViewFor` from
 * `evaluate()`'s own outcome at the database clock, and `maximumBid` is the
 * one integer — present only for the viewer's own Team, and a rendering rather
 * than a check (AD-7). This page authorises nothing; the Auction page's own
 * panel remains the authority for bidding.
 */

import { NO_AUCTION_PROBE_ID } from '../core/constants.ts';
import { fold } from '../core/projection/fold.ts';
import { INITIAL_AUCTIONS, auctionsReducer } from '../core/projection/auctions.ts';
import { INITIAL_CONTRACTS, contractsReducer } from '../core/projection/contracts.ts';
import {
	INITIAL_ELIGIBILITY,
	eligibilityReducer,
	isEligible
} from '../core/projection/eligibility.ts';
import {
	INITIAL_NOMINATIONS,
	nominationForPlayer,
	nominationForTeam,
	nominationsReducer
} from '../core/projection/nominations.ts';
import { INITIAL_PHASE, phaseReducer } from '../core/projection/phase.ts';
import { teamMoneyStateFor } from '../core/rules/bidding.ts';
import { teamViewFor } from '../core/team-view.ts';
import type { TeamView } from '../core/team-view.ts';
import { loadEventsViaClient } from './event-log.ts';
import { loadTeamRosterDetail } from './team-roster.ts';
import type { ConnectionGateway, TransactionalClient } from '../shell/write.ts';
import { requireDatabaseClock } from '../shell/write.ts';

const TEAMS_TABLE = 'teams';
const MANAGERS_TABLE = 'managers';

/** One Team's view, plus the instant every figure on it was read at. */
export type TeamViewState = TeamView & {
	readonly teamId: string;
	/**
	 * The database clock at the moment of the read — the ONE instant the
	 * probe was evaluated against and the anchor the page's freshness
	 * sentence is measured from. Read from Postgres and never from Node
	 * (AD-3).
	 */
	readonly figuresAt: string;
};

/** A Team's name and every Manager acting for it, or `null` for no such Team. */
type TeamIdentity = {
	readonly teamName: string;
	readonly managerNames: readonly string[];
};

/**
 * The Team and its Manager(s), in one statement.
 *
 * `server/auction-open.ts:87-115`'s `teams left join managers` with a
 * `where t.id = $1`, and its `Map` collapse in the form this single-Team read
 * needs: a LIST of display names rather than a boolean, because two `managers`
 * rows sharing one `team_id` is co-management rather than an error
 * (`20260821010000_teams.sql`) and `EXPERIENCE.md:127` says **Manager(s)**.
 * The Team is named once whatever the join returns.
 *
 * `left join`, so a Team with no Manager bound comes back with an empty name
 * list rather than vanishing — a Team that exists with nobody on it is a real
 * Setup-era state, and answering `null` for it would 404 a Team the League
 * genuinely holds.
 *
 * `::text = $1` rather than a `uuid` cast, `loadMetadata`'s rule: a malformed
 * id in the URL must produce a MISSING Team — and therefore a 404 — rather
 * than a failed query that 500s the page.
 *
 * `order by m.display_name asc` so the Managers of a co-managed Team are named
 * in a stated order rather than the planner's (AD-1 forbids incidental order).
 */
async function loadTeamIdentity(
	client: TransactionalClient,
	teamId: string
): Promise<TeamIdentity | null> {
	const result = await client.query(
		`select t.name as team_name, m.display_name
		from ${TEAMS_TABLE} t
		left join ${MANAGERS_TABLE} m on m.team_id = t.id
		where t.id::text = $1
		order by m.display_name asc`,
		[teamId]
	);

	let teamName: string | null = null;
	const managerNames: string[] = [];
	for (const row of result.rows) {
		if (teamName === null) teamName = String(row['team_name'] ?? '');
		const displayName = row['display_name'];
		if (typeof displayName !== 'string' || displayName === '') continue;
		if (managerNames.includes(displayName)) continue;
		managerNames.push(displayName);
	}
	if (teamName === null) return null;
	return { teamName, managerNames };
}

/**
 * Read one Team's whole published position.
 *
 * `viewerTeamId` is the Team the VIEWER is bound to, resolved from the session
 * by the route and never from a query parameter (AD-4). It decides exactly one
 * thing: whether Maximum Bid and its breakdown are on the answer at all.
 *
 * `null` means no such Team — the route's 404. Every other failure throws.
 */
export async function loadTeamView(
	gateway: ConnectionGateway,
	teamId: string,
	viewerTeamId: string | null
): Promise<TeamViewState | null> {
	const client = await gateway.connect();
	try {
		await client.query('begin');

		// ONE read, five folds over the same array — `loadPositions`' set.
		// Eligibility is folded rather than read off
		// `free_agent_players.minor_league_eligible` for `server/bidding.ts`'s
		// reason: the column IS the fold of those events, and asking both
		// would make two answers possible inside one transaction at the moment
		// a Commissioner is changing it.
		const events = await loadEventsViaClient(client);
		const auctions = fold(INITIAL_AUCTIONS, events, auctionsReducer);
		const eligibility = fold(INITIAL_ELIGIBILITY, events, eligibilityReducer);
		const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);
		const phase = fold(INITIAL_PHASE, events, phaseReducer);
		const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);

		// The DATABASE clock, read exactly once and with no lock (AD-3): both
		// the `now` the probe is evaluated against and the anchor the page's
		// freshness sentence measures from, so the figures and their age
		// describe one moment.
		const clockResult = await client.query('select now() as now');
		const figuresAt = requireDatabaseClock(clockResult.rows[0]?.['now']).toISOString();

		const identity = await loadTeamIdentity(client, teamId);
		if (identity === null) {
			await client.query('rollback');
			return null;
		}

		// ONE roster read, yielding the rows the page LISTS and the three
		// figures every gate is decided from — the same rows, the same
		// concatenation and the same loop, so the listing and the counts
		// cannot describe two different rosters.
		const roster = await loadTeamRosterDetail(client, teamId, contracts);

		const team = teamMoneyStateFor({
			teamId,
			// No Auction is being bid on, so nothing is excluded. That is what
			// makes these figures about the TEAM rather than about a screen.
			fantraxPlayerId: NO_AUCTION_PROBE_ID,
			capSpace: roster.capSpace,
			rosterCount: roster.rosterCount,
			minorLeagueOccupied: roster.minorLeagueOccupied,
			auctions,
			isMinorLeagueEligible: (playerId) => isEligible(eligibility, playerId),
			// The name an exposing Auction would be refused by, from the fold
			// that already holds it — the identical expression the read path
			// and the locked transaction both use.
			playerNameFor: (playerId) =>
				nominationForPlayer(nominations, playerId)?.playerName ?? playerId
		});

		const view = teamViewFor({
			teamName: identity.teamName,
			managerNames: identity.managerNames,
			rosterRows: roster.rows,
			team,
			phase,
			nomination: nominationForTeam(nominations, teamId),
			viewerIsThisTeam: viewerTeamId !== null && viewerTeamId === teamId,
			now: figuresAt
		});

		await client.query('rollback');

		return { ...view, teamId, figuresAt };
	} catch (error) {
		await client.query('rollback').catch(() => {
			/* the original error is what the caller needs to see */
		});
		throw error;
	} finally {
		client.release();
	}
}
