/**
 * The Bid Board's read: fold every open nomination and the Auctions over
 * them, then join the Player and Manager reference data one batch at a time.
 * Server-only (Story 4.3).
 *
 * **`loadAuctionPage`'s discipline, over a list instead of one Player.** One
 * transaction, ONE `loadEventsViaClient`, every fold taken over that single
 * events array so the board's states, prices and clocks cannot describe three
 * different moments; one `select now()` for the instant every phrase on the
 * page is derived from; always `rollback`, and a rethrow on failure. It takes
 * NO advisory lock, for that module's reason: rendering a board is not a
 * write, and a report torn across a concurrent bid can only ever be stale,
 * never authoritative.
 *
 * **Two batched reference reads and never one per card.** A thirty-Auction
 * board must not become sixty queries: one statement resolves every nominated
 * Player's reference row by id, and one resolves every Manager the board
 * names — the leading bidder of each Auction and the nominator of each
 * nomination together, because both are the same question asked of the same
 * table.
 *
 * **FACTS cross the wire, never a derived figure (AD-7).** The price is the
 * leading Bid's own amount, rendered through the core's one renderer; no
 * Maximum Bid appears on any card, because the persistent strip owns that
 * figure and a per-card copy would authorise nothing. Sorting and filtering
 * are view state and happen in the browser over the list this module
 * transports — so no ordering a Manager chooses can change what a figure says.
 *
 * **`Money` does not survive JSON.** The brand is a compile-time phantom, so
 * this module ships the rendered string the card prints AND the integer
 * dollars the price sort reads, rather than a branded value that would arrive
 * as a bare number anyway.
 */

import {
	AUCTION_STATE_ICONS,
	AUCTION_STATE_LABELS,
	AUCTION_STATE_LABELS_NARROW,
	NO_LEADING_BIDDER,
	VIEWER_STATE_ICONS,
	VIEWER_STATE_LABELS,
	boardCardsFor,
	metadataLine,
	priceLabel
} from '../core/board.ts';
import type { BoardCard, BoardMetadata, BoardViewerState } from '../core/board.ts';
import { fold } from '../core/projection/fold.ts';
import { INITIAL_AUCTIONS, auctionsReducer } from '../core/projection/auctions.ts';
import type { ContentionState } from '../core/projection/auctions.ts';
import { INITIAL_NOMINATIONS, nominationsReducer } from '../core/projection/nominations.ts';
import { formatTeamManager } from '../core/team-identity.ts';
import { loadEventsViaClient } from './event-log.ts';
import type { ConnectionGateway, TransactionalClient } from '../shell/write.ts';
import { requireDatabaseClock } from '../shell/write.ts';

const FREE_AGENT_PLAYERS_TABLE = 'free_agent_players';
const MANAGERS_TABLE = 'managers';

/**
 * One card, as the surface renders it.
 *
 * Every WORD on it is already chosen by `core/board.ts` — the two state
 * labels, the two icons, the metadata line, the price — so the `.svelte` file
 * prints fields and words nothing itself. What is NOT pre-worded is anything
 * that depends on the reader's own clock: the countdown, the unbid phrase and
 * the absolute stamp are all derived in the browser from `closesAt` and
 * `nominatedAt`, because a phrase computed here would be as old as the
 * response.
 */
export type BoardCardView = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** `HOU · SG`, or `null` when the Player has no reference row. */
	readonly metadata: string | null;
	/**
	 * The price in integer dollars, or `null` before any Bid — the FACT the
	 * price sort orders on, and the field `sortBoard`'s comparator reads.
	 * A rendered string cannot be compared numerically, and re-parsing `$8.5M`
	 * in the browser to sort it would be a second money parser in the file
	 * furthest from `money.ts`. The brand does not survive JSON, so this is a
	 * plain integer and never a `Money`.
	 */
	readonly price: number | null;
	/** `$8.5M`, or the statement that no Opening Bid has been placed. */
	readonly priceLabel: string;
	/** `Lakers — Meakel`, the Team alone, or the no-leader statement. */
	readonly leadingBidder: string;
	/** The absolute close instant, or `null` before the first Bid (AD-3). */
	readonly closesAt: string | null;
	readonly auctionStateLabel: string;
	/** The same name for a narrow viewport — see `AUCTION_STATE_LABELS_NARROW`. */
	readonly auctionStateLabelNarrow: string;
	readonly auctionStateIcon: string;
	/** The fold's own literal, for the one card treatment keyed on it. */
	readonly contention: ContentionState;
	/** How many Teams have joined a Minimum-Bid Contention. */
	readonly contenderCount: number;
	readonly viewerState: BoardViewerState;
	readonly viewerStateLabel: string;
	readonly viewerStateIcon: string;
	/** `Lakers — Meakel`, or the Team alone when the Manager is unresolved. */
	readonly nominatedBy: string;
	readonly nominatedAt: string;
};

/** The whole board, as the route returns it. */
export type BoardState = {
	readonly cards: readonly BoardCardView[];
	/**
	 * The database clock at the moment of the read — the ONE instant every
	 * phrase on the page is anchored on, exactly as the Auction page anchors
	 * its own. Read from Postgres and never from Node (AD-3).
	 */
	readonly figuresAt: string;
	/** The viewer's Team, or `null`. What every card's viewer state was decided against. */
	readonly viewerTeamId: string | null;
};

/**
 * The reference rows for every nominated Player, in one statement.
 *
 * Keyed on `fantrax_player_id`, which is unique on `free_agent_players`.
 * `::text = any($1::text[])` rather than a typed array cast, for
 * `loadAuctionPage`'s reason: a malformed historical payload carrying a
 * non-conforming id must produce a MISSING metadata line, not a failed query
 * that 500s the whole board.
 *
 * A `Map`, not a `Record`: the keys are data, and a plain object probed with
 * `[key]` would read `constructor` back as an inherited function.
 */
async function loadMetadata(
	client: TransactionalClient,
	fantraxPlayerIds: readonly string[]
): Promise<Map<string, BoardMetadata>> {
	const metadata = new Map<string, BoardMetadata>();
	if (fantraxPlayerIds.length === 0) return metadata;

	const result = await client.query(
		`select fantrax_player_id::text as fantrax_player_id, player_name, positions, nba_team
		from ${FREE_AGENT_PLAYERS_TABLE}
		where fantrax_player_id::text = any($1::text[])`,
		[[...fantraxPlayerIds]]
	);
	for (const row of result.rows) {
		const id = row['fantrax_player_id'];
		if (typeof id !== 'string' || id === '') continue;
		metadata.set(id, {
			playerName: String(row['player_name']),
			positions: String(row['positions']),
			nbaTeam: String(row['nba_team'])
		});
	}
	return metadata;
}

/**
 * `JSON.stringify` of the (Manager, Team) pair rather than a delimiter-joined
 * string — `loadAuctionPage`'s key, for its reason: both halves are ids from
 * an insert-only log, and a `|` inside one would let `a|b` + `c` collide with
 * `a` + `b|c` and name the wrong Manager on a card.
 */
function pairKey(managerId: string, teamId: string): string {
	return JSON.stringify([managerId, teamId]);
}

/**
 * Every Manager the board names, in one statement — the leading bidders and
 * the nominators together.
 *
 * Keyed on manager id AND team id, the pairing `loadAuctionPage`'s nominating
 * join asserts in SQL: a `managerId` that does not belong to the Team it is
 * being rendered beside resolves to NO name rather than to some other Team's
 * Manager.
 */
async function loadManagerNames(
	client: TransactionalClient,
	managerIds: readonly string[]
): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	if (managerIds.length === 0) return names;

	const result = await client.query(
		`select m.id::text as id, m.team_id::text as team_id, m.display_name
		from ${MANAGERS_TABLE} m
		where m.id::text = any($1::text[])`,
		[[...managerIds]]
	);
	for (const row of result.rows) {
		const displayName = row['display_name'];
		if (typeof displayName !== 'string' || displayName === '') continue;
		names.set(pairKey(String(row['id']), String(row['team_id'])), displayName);
	}
	return names;
}

/**
 * `Lakers — Meakel`, or the Team alone when the Manager cannot be resolved.
 *
 * Never the Team paired with its own name, which would read as a Manager
 * literally called "Lakers" — a name present in neither the fold nor the
 * reference table. `loadAuctionPage`'s `nameBidder`, for its reason.
 */
function nameTeam(teamName: string, managerDisplayName: string | null): string {
	return managerDisplayName === null ? teamName : formatTeamManager(teamName, managerDisplayName);
}

/**
 * The distinct (Manager, Team) pairs a board names, in first-seen order.
 *
 * Explicitly ordered rather than handed back from a `Set` incidentally: it is
 * only a query parameter and affects no outcome, but AD-1's discipline about
 * incidental ordering is cheaper to keep than to argue about at each site.
 */
function distinctManagerIds(cards: readonly BoardCard[]): readonly string[] {
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const card of cards) {
		for (const managerId of [card.leadingManagerId, card.nominatedByManagerId]) {
			if (managerId === null || managerId === '' || seen.has(managerId)) continue;
			seen.add(managerId);
			ids.push(managerId);
		}
	}
	return ids;
}

/**
 * Read the whole Bid Board for one viewer.
 *
 * `viewerTeamId` is the Team the VIEWER is bound to, resolved from the
 * session by the route and never from a query parameter (AD-4). `null` is a
 * signed-out visitor or a Manager bound to no Team: the board renders in full
 * and every card reads Not involved, because there is no Team for any other
 * viewer state to be about.
 *
 * Throws on a read failure rather than returning an empty board —
 * `loadAuctionPage:668-672`'s posture exactly. An unreachable database and a
 * league with nothing nominated must never render the same screen, because
 * the second is a designed empty state saying the board is genuinely empty.
 */
export async function loadBoard(
	gateway: ConnectionGateway,
	viewerTeamId: string | null
): Promise<BoardState> {
	const client = await gateway.connect();
	try {
		await client.query('begin');

		// ONE read, two folds over the same array — the discipline
		// `loadAuctionPage` sets. The nominations fold is the board's spine:
		// every Player on the board has a nomination, bid or not, and the
		// Auctions fold decorates the ones that have Bids.
		const events = await loadEventsViaClient(client);
		const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);
		const auctions = fold(INITIAL_AUCTIONS, events, auctionsReducer);

		// The DATABASE clock, read exactly once and with no lock — Postgres'
		// transaction-start timestamp, so it is the same instant for every
		// statement in this transaction. It is what the browser anchors every
		// countdown and every unbid phrase on, so a device with a skewed clock
		// reads the same close time a correct one does (AD-3).
		const clockResult = await client.query('select now() as now');
		const figuresAt = requireDatabaseClock(clockResult.rows[0]?.['now']).toISOString();

		// Built once WITHOUT metadata to learn which Players and which Managers
		// the board names, then rebuilt with the reference rows in hand. Two
		// passes over a list already in memory, rather than a statement per card.
		const bare = boardCardsFor(nominations, auctions, new Map(), viewerTeamId);
		const metadata = await loadMetadata(
			client,
			bare.map((card) => card.fantraxPlayerId)
		);
		const managerNames = await loadManagerNames(client, distinctManagerIds(bare));

		const cards = boardCardsFor(nominations, auctions, metadata, viewerTeamId);

		await client.query('rollback');

		return {
			figuresAt,
			viewerTeamId,
			cards: cards.map((card) => ({
				fantraxPlayerId: card.fantraxPlayerId,
				playerName: card.playerName,
				metadata: metadataLine(card.nbaTeam, card.positions),
				// The FACT the price sort orders on, beside the rendering the card
				// prints. Both come off the one leading amount.
				price: card.price === null ? null : Number(card.price),
				priceLabel: priceLabel(card.price),
				// The core's own statement when nobody leads — never an empty
				// string, which a surface would then have to have an opinion about.
				leadingBidder:
					card.leadingTeamName === null
						? NO_LEADING_BIDDER
						: nameTeam(
								card.leadingTeamName,
								card.leadingManagerId === null
									? null
									: (managerNames.get(pairKey(card.leadingManagerId, card.leadingTeamId ?? '')) ??
										null)
							),
				closesAt: card.closesAt,
				auctionStateLabel: AUCTION_STATE_LABELS[card.contention],
				auctionStateLabelNarrow: AUCTION_STATE_LABELS_NARROW[card.contention],
				auctionStateIcon: AUCTION_STATE_ICONS[card.contention],
				contention: card.contention,
				contenderCount: card.contenderCount,
				viewerState: card.viewerState,
				viewerStateLabel: VIEWER_STATE_LABELS[card.viewerState],
				viewerStateIcon: VIEWER_STATE_ICONS[card.viewerState],
				nominatedBy: nameTeam(
					card.nominatedByTeamName,
					card.nominatedByManagerId === null
						? null
						: (managerNames.get(pairKey(card.nominatedByManagerId, card.nominatedByTeamId)) ??
							null)
				),
				nominatedAt: card.nominatedAt
			}))
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
