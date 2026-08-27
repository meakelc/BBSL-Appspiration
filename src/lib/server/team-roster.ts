/**
 * The two roster figures the money gate cannot fold from the log: a Team's
 * Cap Space and its Roster Count. Server-only (Story 2.6).
 *
 * **Why this is a table read and not a projection.** `team_rosters` is
 * mutable reference data promoted by the import, explicitly NOT an
 * event-sourced projection — its own migration says so and says nothing
 * rebuilds it from `auction_events`. Cap Space and Roster Count are
 * therefore facts about the world, and only the auction's own commitments on
 * top of them are folded. Story 2.5's `loadBidState` header claimed "no
 * table read at all"; that claim ends with the money gate, because AD-7
 * requires Maximum Bid derived from committed state at validation time and
 * the Cap half of that state lives here.
 *
 * **One reader, two callers**, exactly as `bidStateFor` is one narrowing:
 * the locked transaction (`server/bidding.ts`) and the read path
 * (`server/auction-page.ts`) ask the same question with the same SQL, so the
 * figure a control is disabled against and the figure a Bid is refused
 * against cannot be computed two different ways.
 *
 * Nothing derived is stored. This module returns two numbers computed from
 * rows read a moment ago; Committed Bids, Roster Reserve and Maximum Bid are
 * the core's, on every evaluation (AD-7).
 */

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
};

/**
 * Read one Team's roster rows and reduce them to the two figures.
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
export async function loadTeamRoster(
	client: TransactionalClient,
	teamId: string
): Promise<TeamRosterFigures> {
	const result = await client.query(
		`select cap_hit, roster_slot_kind
		from ${TEAM_ROSTERS_TABLE}
		where team_id = $1`,
		[teamId]
	);

	const rows: CapHitRow[] = result.rows.map((row) => ({
		capHit: parseMoney(row['cap_hit']),
		rosterSlotKind: String(row['roster_slot_kind']) as RosterSlotKind
	}));

	let rosterCount = 0;
	for (const row of rows) {
		if (row.rosterSlotKind === 'active_bench') rosterCount += 1;
	}

	return { capSpace: computeCapSpace(rows).capSpace, rosterCount };
}
