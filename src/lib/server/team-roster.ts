/**
 * The roster figures the money and capacity gates cannot fold from the log
 * ALONE: a Team's Cap Space, its Roster Count and how many Minor League Slots
 * it occupies. Server-only (Stories 2.6, 2.8, 3.4).
 *
 * **Two sources, one derivation of each figure.** `team_rosters` is mutable
 * reference data promoted by the import, explicitly NOT an event-sourced
 * projection — its own migration says so and says nothing rebuilds it from
 * `auction_events`. That table is the WORLD a Team started the offseason with.
 * What it has WON since is the auction's own output, which is event-sourced
 * (AD-4): Story 3.4 folds `AuctionClosed` into `AuctionContracts` and this
 * module concatenates `contractRowsFor(...)` onto the rows it read, before the
 * one existing loop. So Cap Space, Roster Count and Minor League occupancy
 * each pick contracts up with no second counter, no second definition and no
 * migration — and a Team that has just won a Player is judged against the
 * roster it now has.
 *
 * Story 2.5's `loadBidState` header claimed "no table read at all"; that claim
 * ends with the money gate, because AD-7 requires Maximum Bid derived from
 * committed state at validation time and the imported half of that state lives
 * here.
 *
 * **One reader, two callers**, exactly as `bidStateFor` is one narrowing:
 * the locked transaction (`server/bidding.ts`) and the read path
 * (`server/auction-page.ts`) ask the same question with the same SQL, so the
 * figure a control is disabled against and the figure a Bid is refused
 * against cannot be computed two different ways.
 *
 * Nothing derived is stored. This module returns three numbers computed from
 * rows read a moment ago plus contracts folded a moment ago; Committed Bids,
 * Roster Reserve, Maximum Bid, Free Minor League Slots and Minors Exposure are
 * the core's, on every evaluation (AD-7). Note which side of that line
 * `minorLeagueOccupied` sits on: the OCCUPANCY is a fact about the rows, and
 * `M = max(0, 3 - occupied)` is a derivation the core runs — this module never
 * computes `M`.
 */

import { contractsWonBy } from '../core/projection/contracts.ts';
import type { AuctionContracts } from '../core/projection/contracts.ts';
import type { TeamRosterRow } from '../core/team-view.ts';
import { computeCapSpace } from '../core/rules/roster-import.ts';
import type { CapHitRow } from '../core/rules/roster-import.ts';
import { parseMoney } from '../core/money.ts';
import type { Money } from '../core/money.ts';
import type { RosterSlotKind } from '../core/types.ts';
import type { TransactionalClient } from '../shell/write.ts';

const TEAM_ROSTERS_TABLE = 'team_rosters';

/** The Cap and roster facts for one Team, as the money gate needs them. */
export type TeamRosterFigures = {
	readonly capSpace: Money;
	/**
	 * Active/Bench rows only. Injury Reserve and Minor League are excluded —
	 * PRD §3 "Roster Count" says so and §10 example 23 is the executable
	 * statement of it: 11 Active/Bench plus 1 IR is a Roster Count of 11.
	 *
	 * Note the asymmetry with Cap Space, which is deliberate and easy to get
	 * backwards: an IR contract DOES count against the Cap and does not count
	 * against the twelve, while a Minor League contract counts against
	 * neither. `computeCapSpace` owns the first half; this count owns the
	 * second.
	 */
	readonly rosterCount: number;
	/**
	 * Minor League rows, counted (Story 2.8) — the raw occupancy `M` is
	 * derived from, never `M` itself.
	 *
	 * The same loop that produces `rosterCount` produces this, from the same
	 * `roster_slot_kind` column and the same single statement: two counters
	 * over one read rather than a second query, because the two facts are
	 * about the same rows at the same instant and a second read could see
	 * them a moment apart.
	 *
	 * Story 1.7 enforces the ceiling of three on IMPORT. Nothing here does:
	 * a Commissioner override can legitimately leave this above three, and
	 * the core's clamp is what stops that from handing a Team extra spending
	 * power.
	 */
	readonly minorLeagueOccupied: number;
};

/**
 * Read one Team's roster rows, append the Auction Contracts it has won, and
 * reduce the lot to the three figures.
 *
 * **`contracts` is a required third parameter and not an optional one**,
 * deliberately: adding it made every caller a compile error, which is how a
 * fact that changes what a gate decides is supposed to arrive. A default of
 * "no contracts" would have let a caller silently keep the pre-3.4 behaviour
 * and judge a Bid against a roster the Team no longer has.
 *
 * The contract rows are concatenated onto the imported ones BEFORE the one
 * loop below, which is the whole integration: there is no `+ wonCount` and no
 * second Cap term anywhere, because a won Player is simply another row.
 *
 * **No rows is a real state, not an error.** A Team exists before the import
 * promotes anything, and `computeCapSpace` over zero rows already returns
 * exactly `SALARY_CAP` with a Roster Count of 0 — so that case needs no
 * branch here, and adding one would be a second definition of an answer the
 * core already gives.
 *
 * `cap_hit` arrives as a Postgres `int8`, which the driver hands back as a
 * string through one client and a number through the other — `parseMoney` is
 * the boundary brand that settles it (AD-8), called here rather than deeper
 * so nothing past this function sees an unbranded amount.
 *
 * A row whose `roster_slot_kind` is not one of the three known kinds is
 * counted against the Cap but not against Roster Count. The column carries a
 * check constraint, so this is unreachable through the database; treating it
 * as non-Active/Bench is the conservative reading if it ever were reached,
 * because it cannot then silently consume one of the twelve.
 */
/**
 * One roster row, NAMED — the shape a roster LISTING needs and the Cap
 * arithmetic does not (Story 4.5).
 *
 * `CapHitRow` carries a cap hit and a slot kind and nothing else, because that
 * is all `computeCapSpace` sums over. A Team view lists the Players, so it
 * needs the name and the id beside those two — and `won` beside them again,
 * because a won Player is a roster row on the same footing as an imported one
 * and the surface still states where the close placed him.
 *
 * It is returned from the SAME read and the SAME concatenation the three
 * figures are counted from. A second query for the names would produce a row
 * set that could disagree with the counted one at the moment a close commits.
 *
 * **It is the CORE's `TeamRosterRow`, re-exported rather than restated.**
 * Story 4.5's code review found the same five fields declared twice, here and
 * in `core/team-view.ts` — two structurally identical types that nothing
 * forces to stay identical, which is the drift this story removed for
 * `PLACEMENT_LABELS`/`SLOT_LABELS` in the same diff. The core owns the shape
 * because the core is what consumes it; this alias keeps the server-side name
 * every call site already reads.
 */
export type TeamRosterEntryRow = TeamRosterRow;

/** The three figures, plus the rows they were counted from. */
export type TeamRosterDetail = TeamRosterFigures & {
	readonly rows: readonly TeamRosterEntryRow[];
};

/**
 * Read one Team's roster rows, append the Auction Contracts it has won, and
 * return BOTH the named rows and the three figures — one read, one
 * concatenation, one loop.
 *
 * **The contract half's names come from `contractsWonBy`, not
 * `contractRowsFor`.** The Cap bridge yields `CapHitRow`, which has no name;
 * `contractsWonBy` yields the contracts themselves, newest close first, and
 * carries `playerName`, `capHit` and `placement` together. Using the second
 * for both halves is what keeps the counted rows and the listed rows the same
 * rows: `contractRowsFor` and `contractsWonBy` filter the identical fold by
 * the identical Team id, so the two projections of one contract set cannot
 * differ in membership — and taking only one of them here means nothing has to
 * verify that they do not.
 *
 * `loadTeamRoster` below keeps its signature and delegates, so the locked
 * transaction and the read path are unchanged and the gates see exactly the
 * figures they saw before.
 */
export async function loadTeamRosterDetail(
	client: TransactionalClient,
	teamId: string,
	contracts: AuctionContracts
): Promise<TeamRosterDetail> {
	const result = await client.query(
		// **Six columns since Story 7.8**, and the last two are the Drop's
		// exception: FR-43 releases a second-round rookie-scale Contract to
		// nothing only while its full term is unelapsed, so the rule needs the
		// round AND the years and cannot ask its question without either.
		`select fantrax_player_id::text as fantrax_player_id, player_name, cap_hit, roster_slot_kind,
			contract_years_remaining, rookie_scale_round
		from ${TEAM_ROSTERS_TABLE}
		where team_id = $1`,
		[teamId]
	);

	return detailFor(teamId, importedRowsFrom(result.rows), contracts);
}

/**
 * One nullable whole-number column, read rather than cast.
 *
 * **The test is `typeof`, not `Number()`.** `Number(null)`, `Number('')`,
 * `Number(false)` and `Number([])` are all `0` and `Number.isInteger(0)` is
 * `true`, so a `Number()`-first guard would state a draft round of zero and a
 * term of zero years — both of them facts nobody imported. Anything that is
 * not already a whole number reads as absent, which is what a nullable column
 * means.
 */
function wholeNumberOf(value: unknown): number | null {
	if (typeof value !== 'number') return null;
	return Number.isInteger(value) ? value : null;
}

/**
 * The `team_rosters` half of one read, mapped — the imported rows only.
 *
 * Split out because the league-wide read below runs the identical mapping over
 * rows it has already grouped by `team_id`. Two spellings of the same five
 * fields is exactly the duplication Story 4.5's review removed for
 * `TeamRosterEntryRow`.
 */
function importedRowsFrom(rows: readonly Record<string, unknown>[]): TeamRosterEntryRow[] {
	return rows.map((row) => ({
		fantraxPlayerId: String(row['fantrax_player_id'] ?? ''),
		playerName: String(row['player_name'] ?? ''),
		capHit: parseMoney(row['cap_hit']),
		rosterSlotKind: String(row['roster_slot_kind']) as RosterSlotKind,
		won: false,
		// FR-43's exception, carried rather than re-read (Story 7.8). Both are
		// nullable on the table: `rookie_scale_round` is `null` for an ordinary
		// Contract and for every row imported before the designation was
		// persisted, and `contract_years_remaining` is `not null` but is read
		// defensively for the same reason nothing else here is cast.
		contractYearsRemaining: wholeNumberOf(row['contract_years_remaining']),
		rookieScaleRound: wholeNumberOf(row['rookie_scale_round'])
	}));
}

/**
 * The concatenation and the ONE counting loop, for one Team.
 *
 * **Extracted rather than copied for the league-wide read.** The loop sums
 * across all the rows it is given into one Team's three figures, so a
 * league-wide read must group by `team_id` BEFORE reaching it — calling this
 * once per Team, over that Team's rows, is what makes the grouping structural
 * instead of a comment. One Team's answer is therefore computed by the
 * identical expression whether it was read alone or with twenty-nine others.
 */
function detailFor(
	teamId: string,
	importedRows: readonly TeamRosterEntryRow[],
	contracts: AuctionContracts
): TeamRosterDetail {
	const rows: TeamRosterEntryRow[] = [
		...importedRows,
		// What this Team has WON, folded from the log — the auction's own
		// output, on the same footing as an imported row and counted by the
		// same loop (Story 3.4). A `minor_league` placement carries a `$0` Cap
		// Hit and occupies a Minor League Slot; an `active_bench` one carries
		// the winning amount and takes one of the twelve.
		...contractsWonBy(contracts, teamId).map((contract) => ({
			fantraxPlayerId: contract.fantraxPlayerId,
			playerName: contract.playerName,
			// The Cap Hit the close PERSISTED, never re-derived from the
			// winning amount (AD-23) — `contractRowsFor` carries the identical
			// field through to `computeCapSpace`.
			capHit: contract.capHit,
			// No cast: `RosterPlacement` is a narrowing of `RosterSlotKind` by
			// exactly `dead_money`, so a Contract's placement IS a roster slot
			// kind. It used to need one, and the cast outlived its reason.
			rosterSlotKind: contract.placement,
			won: true,
			// **Both `null`, and that is the honest answer rather than a gap.**
			// An Auction Contract has no imported term and no draft round: it
			// was won in this auction, it is not in Fantrax until the FR-30/31
			// export, and FR-43's exception is about a Contract the League
			// already had. A Drop refuses a won Player outright for the same
			// reason, so nothing downstream ever reads these two off a won row.
			contractYearsRemaining: null,
			rookieScaleRound: null
		}))
	];

	let rosterCount = 0;
	let minorLeagueOccupied = 0;
	for (const row of rows) {
		if (row.rosterSlotKind === 'active_bench') rosterCount += 1;
		if (row.rosterSlotKind === 'minor_league') minorLeagueOccupied += 1;
	}

	// `CapHitRow` is the shape the Cap arithmetic sums over, and these rows are
	// a widening of it — narrowed back here rather than kept as two arrays, so
	// the figures are still computed from exactly the rows the surface lists.
	const capHitRows: CapHitRow[] = rows.map((row) => ({
		capHit: row.capHit,
		rosterSlotKind: row.rosterSlotKind
	}));

	return {
		rows,
		capSpace: computeCapSpace(capHitRows).capSpace,
		rosterCount,
		minorLeagueOccupied
	};
}

/**
 * Every named Team's roster detail, from ONE statement (Story 4.6).
 *
 * `server/positions.ts:164-169`'s batch shape — `::text = any($1::text[])` —
 * for its reason: thirty single-Team reads inside one transaction is thirty
 * round trips answering one question, and the Teams index must be able to
 * claim that one fold and one set of reads produced all thirty rows.
 *
 * **Rows are grouped by `team_id` BEFORE the counting loop.** That loop sums
 * across everything it is handed into a single Team's figures, so a league-wide
 * row set reaching it ungrouped would report the whole League's Cap Space as
 * one Team's. The grouping is the whole difference between this function and
 * `loadTeamRosterDetail`, and it happens here.
 *
 * **A Team with no rows yields a real empty detail, never a missing entry.**
 * `computeCapSpace` over zero rows already returns exactly `SALARY_CAP` with a
 * Roster Count of 0 — a real state a Team is in before the import promotes
 * anything — and a caller that had to distinguish "absent from the map" from
 * "holds nothing" would be re-deriving that answer for itself. Every requested
 * id is in the returned map.
 */
export async function loadLeagueRosterDetail(
	client: TransactionalClient,
	teamIds: readonly string[],
	contracts: AuctionContracts
): Promise<Map<string, TeamRosterDetail>> {
	const details = new Map<string, TeamRosterDetail>();
	if (teamIds.length === 0) return details;

	const result = await client.query(
		`select team_id::text as team_id, fantrax_player_id::text as fantrax_player_id,
			player_name, cap_hit, roster_slot_kind, contract_years_remaining, rookie_scale_round
		from ${TEAM_ROSTERS_TABLE}
		where team_id::text = any($1::text[])`,
		[[...teamIds]]
	);

	const byTeam = new Map<string, Record<string, unknown>[]>();
	for (const row of result.rows) {
		const teamId = String(row['team_id'] ?? '');
		const existing = byTeam.get(teamId);
		if (existing === undefined) byTeam.set(teamId, [row]);
		else existing.push(row);
	}

	for (const teamId of teamIds) {
		details.set(teamId, detailFor(teamId, importedRowsFrom(byTeam.get(teamId) ?? []), contracts));
	}
	return details;
}

export async function loadTeamRoster(
	client: TransactionalClient,
	teamId: string,
	contracts: AuctionContracts
): Promise<TeamRosterFigures> {
	const { capSpace, rosterCount, minorLeagueOccupied } = await loadTeamRosterDetail(
		client,
		teamId,
		contracts
	);
	return { capSpace, rosterCount, minorLeagueOccupied };
}
