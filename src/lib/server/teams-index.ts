/**
 * The Teams index: all thirty Teams' published positions, from ONE fold.
 * Server-only (Story 4.6).
 *
 * **`loadTeamView`'s assembly, generalised from one Team to every Team** — one
 * transaction, ONE `loadEventsViaClient`, the same five folds over that single
 * events array, ONE `select now()`, and always `rollback`. The identity join
 * and the roster read become league-wide statements; only `teamMoneyStateFor`
 * and `teamViewFor` run per Team, which is the whole of "thirty renderings,
 * never a second computation" (`epic-4-context.md:56`). It takes NO advisory
 * lock, for `loadPositions`' reason: rendering a page is not a write.
 *
 * **Every figure is `teamViewFor`'s.** Nothing in this module or in
 * `core/teams-index.ts` computes a Cap figure or a slot count, so the index
 * and `/teams/<id>` cannot disagree — they are the same function over the same
 * fold at the same instant.
 *
 * **`viewerIsThisTeam` is `false` for every Team, including the viewer's own.**
 * The index publishes no Maximum Bid, no cap breakdown and no Roster Reserve
 * for anybody: those three are structurally absent from every row rather than
 * filtered out downstream, which is what keeps a rival's Maximum Bid
 * unrecoverable by subtraction (spec-4-5's Spec Change Log). The viewer's own
 * Maximum Bid is the persistent strip's and `/teams/<id>`'s.
 *
 * **It RETHROWS a read failure**, `loadTeamView`'s posture: this module's
 * caller is a page whose entire content is the figures, so an unreachable
 * database must produce an error rather than a short list or a page of zeroes.
 * Zero Teams is a real, empty ANSWER and never `null`.
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
import { teamsIndexFor } from '../core/teams-index.ts';
import type { TeamsIndex, TeamsIndexInput } from '../core/teams-index.ts';
import { loadEventsViaClient } from './event-log.ts';
import { loadLeagueRosterDetail } from './team-roster.ts';
import type { ConnectionGateway, TransactionalClient } from '../shell/write.ts';
import { requireDatabaseClock } from '../shell/write.ts';

const TEAMS_TABLE = 'teams';
const MANAGERS_TABLE = 'managers';

/** The index, plus the instant every figure on it was read at. */
export type TeamsIndexState = TeamsIndex & {
	/**
	 * The database clock at the moment of the read — the ONE instant every
	 * probe was evaluated against and the anchor the page's freshness sentence
	 * measures from. Read from Postgres and never from Node (AD-3).
	 */
	readonly figuresAt: string;
};

/** One Team's name and every Manager acting for it. */
type TeamIdentity = {
	readonly teamId: string;
	readonly teamName: string;
	readonly managerNames: readonly string[];
};

/**
 * Every Team and its Manager(s), in ONE statement.
 *
 * `server/auction-open.ts:93-98`'s league-wide `teams left join managers` with
 * no `where` and `order by t.name asc`, plus the `Map` collapse by team id
 * that keeps a co-managed Team from being named twice — two `managers` rows
 * sharing one `team_id` is co-management rather than an error
 * (`20260821010000_teams.sql`), so the join legitimately returns a Team more
 * than once.
 *
 * `left join`, so a Team with no Manager bound comes back with an empty name
 * list rather than vanishing. A Team that exists with nobody on it is a real
 * state, and dropping it would make the index a subset — which
 * `epic-4-context.md:26` forbids by name.
 *
 * The order is `t.name asc, m.display_name asc` — BOTH keys, matching
 * `server/team-view.ts:104`'s single-Team read exactly. The second key is not
 * decoration: it is what names a co-managed Team's Managers in a stated order
 * rather than the planner's (AD-1). Without it the identical Team could render
 * `— Dana & Meakel` here and `— Meakel & Dana` on its own page, and the index
 * and the Team view would disagree about a string — which is the one property
 * `epic-4-context.md:56` exists to make impossible.
 *
 * The Team-name key is likewise stated rather than incidental. It is not the
 * PAGE's ordering: the surface sorts through `sortTeamsIndex`, and this only
 * guarantees the payload itself is never arbitrary.
 */
async function loadTeamIdentities(client: TransactionalClient): Promise<readonly TeamIdentity[]> {
	const result = await client.query(
		`select t.id::text as id, t.name as team_name, m.display_name
		from ${TEAMS_TABLE} t
		left join ${MANAGERS_TABLE} m on m.team_id = t.id
		order by t.name asc, m.display_name asc`
	);

	const byId = new Map<string, { teamName: string; managerNames: string[] }>();
	for (const row of result.rows) {
		const teamId = String(row['id'] ?? '');
		if (teamId === '') continue;
		let entry = byId.get(teamId);
		if (entry === undefined) {
			entry = { teamName: String(row['team_name'] ?? ''), managerNames: [] };
			byId.set(teamId, entry);
		}
		const displayName = row['display_name'];
		if (typeof displayName !== 'string' || displayName === '') continue;
		if (entry.managerNames.includes(displayName)) continue;
		entry.managerNames.push(displayName);
	}

	return [...byId.entries()].map(([teamId, entry]) => ({
		teamId,
		teamName: entry.teamName,
		managerNames: entry.managerNames
	}));
}

/**
 * Read every Team's published position and the League Median over them.
 *
 * `viewerTeamId` is the Team the VIEWER is bound to, resolved from the session
 * by the route and never from a query parameter (AD-4). It decides exactly one
 * thing: which row carries the own-row marker. It changes no figure and moves
 * no row.
 */
export async function loadTeamsIndex(
	gateway: ConnectionGateway,
	viewerTeamId: string | null
): Promise<TeamsIndexState> {
	const client = await gateway.connect();
	try {
		await client.query('begin');

		// ONE read, five folds over the same array — `loadTeamView`'s set,
		// unchanged. Thirty Teams share it, which is what makes "one
		// computation" a property of the assembly rather than a claim.
		const events = await loadEventsViaClient(client);
		const auctions = fold(INITIAL_AUCTIONS, events, auctionsReducer);
		const eligibility = fold(INITIAL_ELIGIBILITY, events, eligibilityReducer);
		const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);
		const phase = fold(INITIAL_PHASE, events, phaseReducer);
		const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);

		// The DATABASE clock, read exactly once and with no lock (AD-3): the
		// `now` every probe is evaluated against and the anchor the page's
		// freshness sentence measures from, so thirty Teams' figures and their
		// stated age describe one moment.
		const clockResult = await client.query('select now() as now');
		const figuresAt = requireDatabaseClock(clockResult.rows[0]?.['now']).toISOString();

		const identities = await loadTeamIdentities(client);
		const rosters = await loadLeagueRosterDetail(
			client,
			identities.map((identity) => identity.teamId),
			contracts
		);

		const views: TeamsIndexInput[] = identities.map((identity) => {
			const roster = rosters.get(identity.teamId);
			// `loadLeagueRosterDetail` returns an entry for EVERY id it was
			// given, including a Team holding no rows — so a miss here is a
			// wiring bug and nothing else, and AD-1 says a bug throws. The
			// alternative, substituting an empty roster, would silently render
			// a Team at exactly the Salary Cap and look entirely plausible.
			if (roster === undefined) {
				throw new Error(`no roster detail was read for team ${identity.teamId}`);
			}
			const team = teamMoneyStateFor({
				teamId: identity.teamId,
				// No Auction is being bid on, so nothing is excluded. That is
				// what makes these figures about the TEAM rather than about a
				// screen.
				fantraxPlayerId: NO_AUCTION_PROBE_ID,
				capSpace: roster.capSpace,
				rosterCount: roster.rosterCount,
				minorLeagueOccupied: roster.minorLeagueOccupied,
				auctions,
				isMinorLeagueEligible: (playerId) => isEligible(eligibility, playerId),
				playerNameFor: (playerId) =>
					nominationForPlayer(nominations, playerId)?.playerName ?? playerId
			});

			const view = teamViewFor({
				teamName: identity.teamName,
				managerNames: identity.managerNames,
				rosterRows: roster.rows,
				team,
				phase,
				// The fold's own accessor rather than a `byTeam` lookup written
				// here: it guards the record with `hasOwnProperty` for the
				// reason `projection/nominations.ts` states — the keys are Team
				// ids, so a key of `constructor` would otherwise read back as an
				// inherited function and be mistaken for an open nomination —
				// and a second spelling of that guard is the one that drifts.
				nomination: nominationForTeam(nominations, identity.teamId),
				// **Never true, on any row.** Maximum Bid, the cap breakdown
				// and Roster Reserve are structurally absent from the index
				// for every Team including the viewer's own.
				viewerIsThisTeam: false,
				now: figuresAt
			});

			return { ...view, teamId: identity.teamId };
		});

		const index = teamsIndexFor({ views, viewerTeamId });

		await client.query('rollback');

		return { ...index, figuresAt };
	} catch (error) {
		await client.query('rollback').catch(() => {
			/* the original error is what the caller needs to see */
		});
		throw error;
	} finally {
		client.release();
	}
}
