/**
 * The Auction page's read: fold the open nomination and the Auction's Bids
 * for one Player, then join Player and Manager reference data, and ask the
 * pure core what the bid control should say. Server-only (Stories 2.4, 2.5).
 *
 * **The Auction is still the nomination; the BIDS are a second fold.** Until
 * Epic 3 closes anything, "open Auction" and "open Nomination" are the same
 * row of the same fold — `nominationsReducer` / `nominationForPlayer`, the
 * identical accessor every other gate in Epic 2 uses. Story 2.5 adds
 * `auctionsReducer` beside it and Story 2.6 adds `eligibilityReducer`, all
 * over the SAME already-loaded events array, so the three projections cannot
 * disagree about which events they saw. A
 * nominated Player nobody has bid on folds to `null` there, which is "no bids
 * yet" and never "no Auction".
 *
 * **No write path.** This module opens a transaction only to get one
 * `TransactionalClient` for `loadEventsViaClient` plus the point reads that
 * follow, exactly as `readAuctionOpenReport`/`loadNominatablePool` do, and
 * always rolls back — rendering a page is not a write, and it deliberately
 * takes NO advisory lock: a report torn across a concurrent nomination, bid
 * or close is possible and harmless, since it can only ever be stale, never
 * authoritative.
 *
 * **The control's state is `evaluate()`'s answer, not a second rule.** AD-1
 * requires the read path to call `evaluate()` directly — the same function
 * `decide()` calls — so a control that says a Bid is impossible and the
 * refusal that explains why cannot disagree. It is asked about the PRE-FILLED
 * amount (`minimumLegalBid`), which is the only amount the page can honestly
 * ask about before anyone has typed anything; every gate but `selfBid` passes
 * by construction on that amount, which is precisely why `selfBid` is the
 * refusal a Manager sees on the board rather than at submission. A typed
 * amount is re-derived server-side under the lock, and the wording it comes
 * back with is `bidRefusalDetail`'s, the same one used here.
 *
 * **The viewer's cap figures — and the capacity gate rides the same read.**
 * Story 2.6 added the money half: one read of `team_rosters` for the viewer's
 * Team, narrowed through the core's own `teamMoneyStateFor` and serialised as
 * FACTS — Cap Space, Roster Count and the Auctions that Team leads. Maximum
 * Bid, Committed Bids, Available Cap Space and Roster Reserve are NOT
 * serialised, because AD-7 forbids a derived money figure being cached
 * client-side for validation and the surface is a client; it re-derives them
 * through the same `evaluate()` this module calls. Story 2.7's `slots` gate
 * needed NO change here at all: it decides from `rosterCount` and the leads
 * this read already carries, so a Team at Roster Capacity arrives on the
 * board with its control already disabled and the reason already worded —
 * and, like every other, the wording is `core/rules/bidding.ts`'s and never
 * this module's. Roster Count is a serialised FACT, never a derived figure
 * the surface compares against instead of re-deriving.
 *
 * **Story 2.8's exposure branch is built, and it is three more FACTS.** The
 * eligible Auctions the viewer's Team leads, how many Minor League Slots its
 * roster occupies, and whether THIS Player is Minor League Eligible — all
 * three off reads this module already made, narrowed through the same
 * `teamMoneyStateFor`. What is still not serialised is every figure derived
 * from them: not `minorsExposure`, not `overflowCount`, not
 * `freeMinorLeagueSlots`, not `maximumBid`. `M = max(0, 3 − occupied)` is a
 * derivation, so the occupancy crosses the wire and `M` does not — which is
 * what lets an eligible Auction arrive on the board with "no cap limit"
 * already shown and still leaves the browser deriving it from the same
 * `evaluate()` the lock calls.
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
 * The id then comes off the event ENVELOPE — `AppendedEvent.managerId`, the
 * acting Manager the shell stamped on the append — not off the payload's own
 * copy of it. The envelope is the same field for a `NominationPlaced`, is
 * typed `string` rather than `unknown`, and is the one the log guarantees for
 * every event regardless of what a payload happens to carry; reading the
 * payload copy made a third source for a field the loaded events already
 * expose.
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
 * **Bidding Managers resolve the same way, in ONE further read.** A Bid
 * carries its acting `managerId` in the payload (`BidPlacedPayload`), and Bid
 * history names the acting Manager with no anonymity at any point — so a
 * history of six Bids must not become six queries. One statement resolves
 * every distinct bidding Manager, and the Team pairing the nominating join
 * asserts in SQL is asserted here in code against the Bid's own `teamId`,
 * which the payload already carries. That read is issued only when the
 * Auction actually has Bids: a Player with none costs exactly the queries
 * Story 2.4 already made.
 *
 * When a Manager cannot be resolved the page renders the Team name ALONE.
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
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer,
	contentionOf,
	contentionSentence
} from '../core/projection/auctions.ts';
import type { Auction, Bid, ContentionState } from '../core/projection/auctions.ts';
import {
	INITIAL_NOMINATIONS,
	NOMINATION_PLACED_EVENT,
	nominationForPlayer,
	nominationsReducer
} from '../core/projection/nominations.ts';
import type { OpenNomination } from '../core/projection/nominations.ts';
import {
	INITIAL_ELIGIBILITY,
	eligibilityReducer,
	isEligible
} from '../core/projection/eligibility.ts';
import {
	bidControlState,
	bidStateFor,
	describeAmount,
	minimumLegalBid,
	minimumLegalSentence,
	teamMoneyStateFor
} from '../core/rules/bidding.ts';
import type { BidState, TeamMoneyState } from '../core/rules/bidding.ts';
import { formatTeamManager } from '../core/team-identity.ts';
import { loadEventsViaClient } from './event-log.ts';
import { loadTeamRoster } from './team-roster.ts';
import type { ConnectionGateway } from '../shell/write.ts';
import { requireDatabaseClock } from '../shell/write.ts';

const FREE_AGENT_PLAYERS_TABLE = 'free_agent_players';
const TEAMS_TABLE = 'teams';
const MANAGERS_TABLE = 'managers';

/** The Player metadata line, present only when the reference row exists. */
export type AuctionPageMetadata = {
	readonly positions: string;
	readonly nbaTeam: string;
};

/** One line of Bid history. Names the acting Manager — there is no anonymity. */
export type AuctionPageBid = {
	/** The log's own ordering column, and this line's key. */
	readonly seq: string;
	/** `Lakers — Meakel`, or the Team alone when the Manager cannot be resolved. */
	readonly bidder: string;
	/** The amount, rendered through the core's one money renderer. */
	readonly amount: string;
	/** The Bid's own instant, for the page to render twice. */
	readonly occurredAt: string;
};

/**
 * Everything the bid control needs, all of it decided by the pure core.
 *
 * `available` and `detail` are `bidControlState()`'s answer about the
 * PRE-FILLED amount — what a Manager sees on the board before typing
 * anything, which is what AC7 asks for "when the page renders". Every gate
 * but `selfBid` passes on that amount by construction, which is why "your
 * Team already leads" is a refusal read on the board rather than discovered
 * at submission.
 *
 * **The typed amount is a second question, and the surface asks it.**
 * `leadingAmount` and `leadingTeamId` are the two facts every gate in
 * `PLACE_BID_GATES` decides from (`BidState`), serialised so the page can
 * rebuild that state and call the SAME `bidControlState()` on every
 * keystroke. Shipping them is what lets a control disable itself against
 * `8400000` instead of waiting for the server to say so — and the server
 * still says so, under the lock, with the identical wording, because both
 * answers come out of one function (AD-9: client-side validation exists only
 * to disable controls and pre-fill amounts; it is never the check).
 *
 * `minimumLegalSentence` is `null` when the figure has no lossless rendering
 * — reachable only through a historical off-grid Bid this story cannot write
 * (see `minimumLegalSentence` in the core). The surface omits the line rather
 * than printing a sentence whose figure is a phrase.
 */
export type AuctionPageBidControl = {
	/**
	 * Whether this Auction will take a Bid from the viewer's Team AT ALL.
	 *
	 * A standing condition no amount changes — the viewer's Team already
	 * leads, or they are bound to no Team — so the surface disables the
	 * amount field itself on it, not merely the submit. Typing your way out
	 * of leading an Auction is not a thing, and a live field that can only
	 * ever be refused is a worse answer than a disabled one.
	 */
	readonly available: boolean;
	/** The standing reason, or the statement that the Auction is ready for one. */
	readonly detail: string;
	/** The pre-filled minimum legal Bid, in integer dollars — the form's value. */
	readonly minimumLegal: number;
	/** That figure as a finished sentence, or `null` when it cannot be rendered. */
	readonly minimumLegalSentence: string | null;
	/** The leading Bid's amount, in integer dollars, or `null` when nothing leads. */
	readonly leadingAmount: number | null;
	/** The leading Bid's Team, or `null` when nothing leads. */
	readonly leadingTeamId: string | null;
	/**
	 * Which contention this Auction is in, as the fold decided it — a state
	 * literal, not a derived flag.
	 *
	 * `AuctionPageState.contention` above is the SENTENCE, for printing. This
	 * is the fact `BidState` carries, serialised so the surface rebuilds
	 * exactly the state the locked transaction will and calls the same
	 * `evaluate()` on every keystroke. There is deliberately no `isLottery`
	 * and no `youAreContending` on this wire: both are one comparison away
	 * from the facts beside them, and a transported boolean is a derivation
	 * the browser would then be trusting instead of making (AD-7, AD-9).
	 */
	readonly contention: ContentionState;
	/**
	 * The Teams already on the Contender list, in join order — IDS, because
	 * that is what the `contention` gate matches the viewer's Team against.
	 *
	 * The NAMES are on `AuctionPageState.contenders`, for printing. Two
	 * fields rather than one shape carrying both, for `leadingTeamId` and
	 * `leadingBidder`'s reason: what a gate decides from and what a page
	 * prints are different things, and merging them invites a gate that
	 * matches on a display string.
	 */
	readonly contenderTeamIds: readonly string[];
	/** The viewer's own Team, from the session and nothing else (AD-4). */
	readonly viewerTeamId: string | null;
	/**
	 * Whether the Player this page is about is Minor League Eligible — the
	 * fold's answer, serialised so the surface can rebuild `BidState` and
	 * re-evaluate a typed amount against the same eligibility the lock will.
	 *
	 * A FACT about the Auction, not a figure: it is the fold of
	 * `MinorLeagueEligibilitySet`, and everything it implies — Free Minor
	 * League Slots, Overflow Count, whether Maximum Bid binds at all — is
	 * derived from it in the core on every evaluation.
	 */
	readonly playerIsMinorLeagueEligible: boolean;
	/**
	 * The viewer Team's money FACTS — Cap Space, Roster Count, the open
	 * Auctions it leads (eligible and not, partitioned), and how many Minor
	 * League Slots its roster occupies. `null` for a viewer bound to no Team.
	 *
	 * **Facts, never the derived figure.** Maximum Bid, Committed Bids,
	 * Available Cap Space, Roster Reserve, Minors Exposure, Free Minor League
	 * Slots and Overflow Count are deliberately NOT here: AD-7
	 * forbids a derived money figure being cached client-side for validation,
	 * and the surface is a client. Shipping it `maximumBid` and letting it
	 * compare would make the transported number the check. Shipping these
	 * facts means `evaluateCap` runs again in the browser, on this read path
	 * and inside the lock, from the same inputs — so the breakdown a Manager
	 * reads and the arithmetic a refusal shows are one derivation with three
	 * callers, not three numbers that must be kept in step.
	 *
	 * Amounts cross as integer dollars and are re-branded by whoever reads
	 * them (AD-8); `Money` does not survive JSON.
	 */
	readonly team: TeamMoneyState | null;
	/**
	 * When these figures were computed, ISO-8601 — the arithmetic's timestamp
	 * caption ("Your figures at 2:14 AM Wed").
	 *
	 * **The DATABASE's instant, and the same one the `expiry` gate was
	 * evaluated at** (Story 3.1). The read path still takes no lock, but it
	 * now reads `now()` once — because a gate that decides on time must be
	 * handed a clock, and AD-3 makes that the server's, never Node's and
	 * never the viewer's. One instant serves both, so the caption and the
	 * gate can never describe two different moments.
	 *
	 * It remains a rendering fact on THIS shape: nothing compares it to
	 * anything here, and the surface anchors its own ticking `now` on it so a
	 * skewed device measures elapsed time without moving a close time
	 * (NFR §5). A refused SUBMIT replaces it with the transaction's clock,
	 * because those figures are the ones that Bid was actually judged
	 * against (FR-13).
	 */
	readonly figuresAt: string;
};

/** Everything the Auction page renders. */
export type AuctionPageState = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** `null` when the Player is absent from `free_agent_players` (I/O matrix: "Missing reference row"). */
	readonly metadata: AuctionPageMetadata | null;
	/** The nominating Team, spelled out with its acting Manager — `formatTeamManager`'s one rendering. */
	readonly nominatingTeam: string;
	/** The nomination's own instant, for the page to render twice. */
	readonly nominatedAt: string;
	/** Which contention this Auction is in, worded by the fold that decides it. */
	readonly contention: string;
	/**
	 * The Contenders in a Minimum-Bid Contention — Team NAMES, in ascending
	 * join `seq` (AD-14). Empty for every Auction that is not a lottery.
	 *
	 * Names rather than ids because this is what the page PRINTS: there is no
	 * anonymity at any point on this page, and a list of uuids names nobody.
	 * The ids the `contention` gate matches on ride `bidControl` instead,
	 * where every other gate fact lives.
	 *
	 * The ORDER is the fold's and is never re-sorted here: AD-14 makes it an
	 * input to the winner, so a surface that reordered it would be showing a
	 * different list from the one the draw will run over.
	 */
	readonly contenders: readonly string[];
	/** How many Contenders, as a count. `0` when no lottery is running. */
	readonly contenderCount: number;
	/**
	 * The published `hash(seed)` for this contention, or `null`.
	 *
	 * The COMMIT half of AD-14, shown on the page from the moment the lottery
	 * opens so a Manager can record it and check the reveal against it at the
	 * draw (Story 3.6). It is the fold's own value, off the opening Bid's
	 * payload — nothing is hashed here, and the seed it commits to is not
	 * reachable from this process's queries at all.
	 */
	readonly seedHash: string | null;
	/** The current price, rendered, or `null` when there are no Bids. */
	readonly price: string | null;
	/** The Leading Bidder, Team spelled out with acting Manager, or `null`. */
	readonly leadingBidder: string | null;
	/** The Auction Clock's absolute expiry, or `null` when there are no Bids. */
	readonly closesAt: string | null;
	/** Every Bid, oldest first. Empty when there are none. */
	readonly bids: readonly AuctionPageBid[];
	/** The bid control's state, worded by the core. */
	readonly bidControl: AuctionPageBidControl;
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
 * `formatTeamManager` when the Manager is known, the Team's name alone when
 * they are not.
 *
 * One helper for the nominating Team, the Leading Bidder and every history
 * line, so the "Team known, Manager unknown" fallback cannot be spelled three
 * different ways.
 */
function nameBidder(teamName: string, managerDisplayName: string | null): string {
	return managerDisplayName === null ? teamName : formatTeamManager(teamName, managerDisplayName);
}

/**
 * The distinct acting Manager ids across a Bid history, in first-seen order.
 *
 * Explicitly ordered rather than handed back from a `Set`'s iteration
 * incidentally: it is only a query parameter and affects no outcome, but
 * AD-1's discipline about incidental ordering is cheaper to keep than to
 * argue about at each site.
 */
function distinctManagerIds(bids: readonly Bid[]): readonly string[] {
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const bid of bids) {
		if (bid.managerId === '' || seen.has(bid.managerId)) continue;
		seen.add(bid.managerId);
		ids.push(bid.managerId);
	}
	return ids;
}

/**
 * Read the Auction page's state for one Player, or `null` when there is no
 * open nomination for them — the caller 404s on `null` (closed, or never
 * nominated).
 *
 * `viewerTeamId` is the Team the VIEWER is bound to, resolved from the
 * session by the route and never from a form field or a query parameter
 * (AD-4). `null` is a registered Manager bound to no Team, which is a real
 * supported state: they see the whole Auction and a control disabled with the
 * core's `unbound_actor` sentence.
 *
 * One `loadEventsViaClient` read serves both folds; at most three further
 * reads follow, and only when a nomination is found — one keyed on
 * `fantrax_player_id` (unique on `free_agent_players`), one a join keyed on
 * `teams.id` (primary key) and the nominating event's own `managerId`
 * (`managers.id`, primary key), and one resolving the distinct bidding
 * Managers, issued only when the Auction has Bids.
 */
export async function loadAuctionPage(
	gateway: ConnectionGateway,
	fantraxPlayerId: string,
	viewerTeamId: string | null
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

		// The second and third folds, over the SAME events array — so the
		// board, the price and the money cannot describe three different
		// moments. Eligibility is folded rather than read off
		// `free_agent_players.minor_league_eligible` for the reason
		// `server/bidding.ts` gives: the column is the fold of those events,
		// and asking both would make two answers possible at the moment a
		// Commissioner is changing one.
		const auctions = fold(INITIAL_AUCTIONS, events, auctionsReducer);
		const auction = auctionForPlayer(auctions, fantraxPlayerId);
		const eligibility = fold(INITIAL_ELIGIBILITY, events, eligibilityReducer);

		// The DATABASE clock, read exactly once and with no lock — this module
		// deliberately takes none, and `now()` needs none: it is Postgres'
		// transaction-start timestamp, so it is the same instant for every
		// statement in this transaction whenever it is asked for.
		//
		// ONE instant, two jobs (Story 3.1): it is the `expiry` gate's `now`
		// and it is the `figuresAt` caption. Reading Node's clock for the
		// caption and the database's for the gate would let the caption and
		// the gate describe two different moments, and the caption is the
		// line that claims the figures beside it held then.
		//
		// Stamped HERE, beside the reads it describes, rather than at the end
		// of the load: three further statements run before the page state is
		// built.
		// The check is `shell/write.ts`'s, imported rather than copied: the
		// STATEMENT differs (that module reads the clock in the same round
		// trip as the lock, this one takes no lock at all), but "is what came
		// back a usable instant" is one question and must have one answer.
		// `server/` already depends on `shell/`, so this is the existing
		// direction of the dependency and not an inversion.
		const clockResult = await client.query('select now() as now');
		const figuresAt = requireDatabaseClock(clockResult.rows[0]?.['now']).toISOString();
		const team =
			viewerTeamId === null
				? null
				: teamMoneyStateFor({
						teamId: viewerTeamId,
						fantraxPlayerId,
						// The spread carries Story 2.8's `minorLeagueOccupied`
						// through with the two figures 2.6 added, so the new fact
						// reached the core with no third call site.
						...(await loadTeamRoster(client, viewerTeamId)),
						auctions,
						isMinorLeagueEligible: (playerId) => isEligible(eligibility, playerId),
						// The name an exposing Auction is refused by, from the fold
						// that already holds it — the identical expression
						// `server/bidding.ts` uses under the lock.
						playerNameFor: (playerId) =>
							nominationForPlayer(nominations, playerId)?.playerName ?? playerId
					});

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

		// One statement for every bidding Manager, and only when there is at
		// least one Bid. `::text` on both sides rather than a `uuid[]` cast: a
		// malformed historical payload carrying a non-uuid id must produce a
		// missing NAME, not a failed query that 500s the whole page.
		const bids = auction?.bids ?? [];
		const bidderIds = distinctManagerIds(bids);
		const bidderResult =
			bidderIds.length === 0
				? { rows: [] as ReadonlyArray<Record<string, unknown>> }
				: await client.query(
						`select m.id::text as id, m.team_id::text as team_id, m.display_name
						from ${MANAGERS_TABLE} m
						where m.id::text = any($1::text[])`,
						[[...bidderIds]]
					);
		// Keyed on manager id AND team id together, which is the same pairing
		// the nominating join asserts in SQL: a `managerId` that does not
		// belong to the bidding Team resolves to no name rather than to some
		// other Team's Manager.
		// `JSON.stringify` of the pair rather than a delimiter-joined string:
		// the two halves are ids from an insert-only log, and a `|` inside one
		// would let `a|b` + `c` collide with `a` + `b|c` and name the wrong
		// Manager on a Bid. This module already tolerates a malformed id
		// through the `::text` cast above; tolerating one here costs a
		// function call.
		const pairKey = (managerId: string, teamId: string): string =>
			JSON.stringify([managerId, teamId]);
		const bidderNames = new Map<string, string>();
		for (const row of bidderResult.rows) {
			const displayName = row['display_name'];
			if (typeof displayName !== 'string' || displayName === '') continue;
			bidderNames.set(pairKey(String(row['id']), String(row['team_id'])), displayName);
		}
		const nameOf = (bid: Bid): string | null =>
			bidderNames.get(pairKey(bid.managerId, bid.teamId)) ?? null;

		await client.query('rollback');

		return {
			fantraxPlayerId: nomination.fantraxPlayerId,
			playerName,
			metadata,
			// Team alone when the Manager cannot be resolved — never the Team
			// paired with its own name, which would read as a Manager called
			// "Lakers" and invent a figure the spec forbids inventing.
			nominatingTeam: nameBidder(nomination.teamName, managerDisplayName),
			nominatedAt: nomination.occurredAt,
			contention: contentionSentence(contentionOf(auction)),
			// The fold's own ordered list, names only, never re-sorted (AD-14).
			contenders: (auction?.contenders ?? []).map((contender) => contender.teamName),
			contenderCount: auction?.contenders.length ?? 0,
			// The published commitment, straight off the fold. The seed it
			// commits to is in `auction_contention_seeds`, which this
			// connection's role holds no privilege on.
			seedHash: auction?.seedHash ?? null,
			price: auction === null ? null : describeAmount(auction.leadingBid.amount),
			leadingBidder:
				auction === null
					? null
					: nameBidder(auction.leadingBid.teamName, nameOf(auction.leadingBid)),
			closesAt: auction?.closesAt ?? null,
			bids: bids.map((bid) => ({
				seq: bid.seq,
				bidder: nameBidder(bid.teamName, nameOf(bid)),
				amount: describeAmount(bid.amount),
				occurredAt: bid.occurredAt
			})),
			bidControl: readBidControl(
				auction,
				team,
				viewerTeamId,
				nomination.fantraxPlayerId,
				figuresAt,
				isEligible(eligibility, fantraxPlayerId)
			)
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

/**
 * The bid control's state, from the pure core and nowhere else.
 *
 * `bidControlState()` is the one decision function, shared with the surface:
 * this call asks it about the PRE-FILLED amount, and the page asks it again
 * about whatever a Manager types. Neither re-implements a gate.
 *
 * `confirmed: true` is passed deliberately. This answer is about whether the
 * Auction and the viewer's Team allow a Bid at all — the board-level question
 * AC7 asks "when the page renders" — and a control reported as unavailable
 * merely because a checkbox has not been ticked yet would say the Auction
 * refused something it did not.
 *
 * **`now` is the database's instant, and it is the same one the caption
 * carries** (Story 3.1). Until `expiry` existed this argument was the empty
 * string, on the stated grounds that no gate in `PLACE_BID_GATES` looked at
 * it and this module had no clock in hand. The gate exists now, so the
 * argument had to become real — and the pressure landed exactly where it was
 * meant to: `loadAuctionPage` sources it from `select now()` rather than
 * inventing one from Node, because AD-3 makes the server's clock the only
 * one a rule may be decided against.
 *
 * `figuresAt` is therefore not merely the caption's instant any more; it is
 * the instant this evaluation happened at, and passing it twice is what
 * makes the disabled control and the caption above it describe one moment.
 */
function readBidControl(
	auction: Auction | null,
	team: TeamMoneyState | null,
	viewerTeamId: string | null,
	fantraxPlayerId: string,
	/** When the roster and the folds were read — the caption's instant. */
	figuresAt: string,
	/** The eligibility fold's answer about THIS Player (Story 2.8). */
	playerIsMinorLeagueEligible: boolean
): AuctionPageBidControl {
	const state: BidState = bidStateFor(auction, team, playerIsMinorLeagueEligible);
	const minimumLegal = minimumLegalBid(state);

	const control = bidControlState({
		state,
		fantraxPlayerId,
		viewerTeamId,
		amountText: String(minimumLegal),
		confirmed: true,
		now: figuresAt
	});

	return {
		available: !control.blocked,
		detail: control.detail,
		minimumLegal,
		minimumLegalSentence: minimumLegalSentence(minimumLegal),
		leadingAmount: state.leadingBid?.amount ?? null,
		leadingTeamId: state.leadingBid?.teamId ?? null,
		// The two contention facts, off the SAME `BidState` the gates were
		// just evaluated against — so what the browser rebuilds is what this
		// module decided from, not a second narrowing of the fold.
		contention: state.contention,
		contenderTeamIds: state.contenders,
		viewerTeamId,
		playerIsMinorLeagueEligible,
		team,
		// The database's instant, taken where the figures were actually read
		// and handed to `evaluate()` above as its `now`. Serialised as the
		// caption AND as the anchor the surface measures elapsed time from —
		// but never as a derived verdict: no `expired` flag and no remaining
		// duration crosses this wire, for AD-7's reason applied to a clock.
		// The surface re-derives expiry from `closesAt` and this instant on
		// every tick, exactly as it re-derives Maximum Bid on every keystroke.
		figuresAt
	};
}
