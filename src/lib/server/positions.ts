/**
 * Your Positions' read: one fold of the log, then the re-entry answer for
 * every Auction the viewer has been outbid on. Server-only (Story 4.4).
 *
 * **`loadBoard`'s transaction discipline, exactly.** One transaction, ONE
 * `loadEventsViaClient`, every fold taken over that single events array so
 * the five groups cannot describe five different moments; one `select now()`
 * for the instant every phrase and every gate on the page is decided against;
 * always `rollback`, and a rethrow on failure. It takes NO advisory lock, for
 * that module's reason: rendering a page is not a write, and a report torn
 * across a concurrent bid can only ever be stale, never authoritative.
 *
 * **This is the first read-path caller of `evaluate()` across MANY Auctions,
 * and the generalisation is N-at-once over one fold rather than a new rule.**
 * `server/auction-page.ts`'s `readBidControl` does it for one Player;
 * `server/bidding.ts`'s `loadBidState` assembles the narrowing for one Player
 * under the lock. Both reach the gates through `bidStateFor` +
 * `teamMoneyStateFor`, and so does this — per outbid Auction, over the same
 * folded state, with the log read once and `loadTeamRoster` called once. A
 * second narrowing here could disagree with the transaction's, which is the
 * disagreement AD-7's "computed from committed state at validation time"
 * exists to rule out.
 *
 * **Two batched reference reads and never one per card**, `loadBoard`'s rule:
 * one statement resolves every Player this page names — the won, the outbid,
 * the led, the contended and the nominated together — and one resolves every
 * Manager it names.
 *
 * **`Money` does not survive JSON.** The brand is a compile-time phantom, so
 * this module ships the rendered strings the cards print beside the integer
 * dollars, never a branded value that would arrive as a bare number anyway.
 */

import type { BoardMetadata } from '../core/board.ts';
import { positionsFor, reEntryFor } from '../core/positions.ts';
import type { NominationSlotCard, Positions, ReEntry, ReEntryGateRow } from '../core/positions.ts';
import { fold } from '../core/projection/fold.ts';
import {
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer
} from '../core/projection/auctions.ts';
import type { ContentionState } from '../core/projection/auctions.ts';
import { INITIAL_CONTRACTS, contractsReducer } from '../core/projection/contracts.ts';
import {
	INITIAL_NOMINATIONS,
	nominationForPlayer,
	nominationsReducer,
	openNominations
} from '../core/projection/nominations.ts';
import { INITIAL_PHASE, phaseReducer } from '../core/projection/phase.ts';
import { bidStateFor, teamMoneyStateFor } from '../core/rules/bidding.ts';
import { formatTeamManager } from '../core/team-identity.ts';
import type { SlotPlacement } from '../core/types.ts';
import { loadEventsViaClient } from './event-log.ts';
import { loadTeamRoster } from './team-roster.ts';
import type { ConnectionGateway, TransactionalClient } from '../shell/write.ts';
import { requireDatabaseClock } from '../shell/write.ts';

const FREE_AGENT_PLAYERS_TABLE = 'free_agent_players';
const MANAGERS_TABLE = 'managers';

/** One won Auction, as the surface renders it. */
export type WonCardView = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly metadata: string | null;
	readonly winningAmountLabel: string;
	readonly placement: SlotPlacement;
	readonly closedAt: string;
	/** `null` until a closed Auction has a page — see `core/positions.ts`. */
	readonly href: string | null;
};

/** One Auction the viewer has been outbid on, as the surface renders it. */
export type OutbidCardView = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly metadata: string | null;
	readonly priceLabel: string;
	readonly yourBidLabel: string;
	/** `Lakers — Meakel`, or the Team alone when the Manager is unresolved. */
	readonly leadingBidder: string;
	readonly closesAt: string;
	readonly contention: ContentionState;
	readonly stateLabel: string;
	readonly stateIcon: string;
	readonly reEntrySentence: string;
	readonly reEntryBlocked: boolean;
	readonly reEntryGates: readonly ReEntryGateRow[];
	readonly href: string;
};

/** One Auction the viewer leads, as the surface renders it. */
export type LeadCardView = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly metadata: string | null;
	readonly priceLabel: string;
	readonly closesAt: string;
	readonly contention: ContentionState;
	readonly stateLabel: string;
	readonly stateIcon: string;
	readonly commitmentSentence: string;
	readonly href: string;
};

/** One Minimum-Bid Contention the viewer has joined, as the surface renders it. */
export type ContendingCardView = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly metadata: string | null;
	readonly priceLabel: string;
	readonly closesAt: string;
	readonly contention: ContentionState;
	readonly contentionLabel: string;
	readonly stateLabel: string;
	readonly stateIcon: string;
	readonly contenderCountSentence: string;
	readonly clockSentence: string;
	readonly href: string;
};

/** The whole page, as the route returns it. */
export type PositionsState = {
	readonly viewerTeamId: string | null;
	readonly won: readonly WonCardView[];
	readonly outbid: readonly OutbidCardView[];
	readonly youLead: readonly LeadCardView[];
	readonly contending: readonly ContendingCardView[];
	readonly nominationSlot: NominationSlotCard;
	readonly empty: boolean;
	readonly openAuctionCount: number;
	/**
	 * The database clock at the moment of the read — the ONE instant every
	 * phrase on the page is anchored on AND the `now` every gate above was
	 * decided against. Read from Postgres and never from Node (AD-3).
	 */
	readonly figuresAt: string;
};

/**
 * The reference rows for every Player this page names, in one statement.
 *
 * `loadBoard`'s own query, for its reasons: keyed on `fantrax_player_id`;
 * `::text = any($1::text[])` rather than a typed array cast, so a malformed
 * historical id produces a MISSING metadata line rather than a failed query
 * that 500s the page; and a `Map` rather than a `Record`, because the keys are
 * data.
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
 * `JSON.stringify` of the (Manager, Team) pair — `loadBoard`'s key, for its
 * reason: both halves are ids from an insert-only log, and a `|` inside one
 * would let `a|b` + `c` collide with `a` + `b|c` and name the wrong Manager.
 */
function pairKey(managerId: string, teamId: string): string {
	return JSON.stringify([managerId, teamId]);
}

/** Every Manager this page names, in one statement. `loadBoard`'s query. */
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
 * literally called "Lakers". `loadBoard`'s `nameTeam`, for its reason.
 */
function nameTeam(teamName: string, managerDisplayName: string | null): string {
	return managerDisplayName === null ? teamName : formatTeamManager(teamName, managerDisplayName);
}

/**
 * The empty answer, for a viewer bound to no Team.
 *
 * `requireLiveDestination` refuses such a request before this module is
 * reached, so it is unreachable through the route — but `loadPositions` is a
 * total function and a `null` Team has no positions rather than no answer.
 * No group is ever rendered against a null Team.
 */
function emptySlot(): NominationSlotCard {
	return positionsFor({
		nominations: INITIAL_NOMINATIONS,
		auctions: INITIAL_AUCTIONS,
		contracts: INITIAL_CONTRACTS,
		metadata: new Map(),
		viewerTeamId: null,
		reEntryFor: () => {
			throw new Error('unreachable: no Auction is asked about for a viewer with no Team');
		}
	}).nominationSlot;
}

/**
 * Read Your Positions for one viewer.
 *
 * `viewerTeamId` is the Team the VIEWER is bound to, resolved from the session
 * by the route and never from a query parameter (AD-4).
 *
 * Throws on a read failure rather than returning empty groups —
 * `loadBoard`'s posture exactly. An unreachable database and a Manager with
 * nothing in play must never render the same screen, because the second is a
 * designed empty state saying so out loud.
 */
export async function loadPositions(
	gateway: ConnectionGateway,
	viewerTeamId: string | null
): Promise<PositionsState> {
	const client = await gateway.connect();
	try {
		await client.query('begin');

		// ONE read, five folds over the same array — `loadBidState`'s set,
		// because the gates this page runs need every one of them. Eligibility
		// is folded rather than read off `free_agent_players.minor_league_eligible`
		// for `server/bidding.ts`'s reason: the column IS the fold of those
		// events, and asking both would make two answers possible inside one
		// transaction at the moment a Commissioner is changing it.
		const events = await loadEventsViaClient(client);
		const nominations = fold(INITIAL_NOMINATIONS, events, nominationsReducer);
		const auctions = fold(INITIAL_AUCTIONS, events, auctionsReducer);
		const phase = fold(INITIAL_PHASE, events, phaseReducer);
		const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);

		// The DATABASE clock, read exactly once and with no lock (AD-3). It is
		// both the caption's instant and the `now` every gate below is decided
		// against, which is what makes the re-entry answer and the freshness
		// sentence describe one moment.
		const clockResult = await client.query('select now() as now');
		const figuresAt = requireDatabaseClock(clockResult.rows[0]?.['now']).toISOString();

		if (viewerTeamId === null) {
			await client.query('rollback');
			return {
				viewerTeamId: null,
				won: [],
				outbid: [],
				youLead: [],
				contending: [],
				nominationSlot: emptySlot(),
				empty: true,
				openAuctionCount: openNominations(nominations).length,
				figuresAt
			};
		}

		// ONE roster read for the whole page — the three figures every gate on
		// every card is decided from, with this Team's Auction Contracts folded
		// in through `contractRowsFor` exactly as `loadBidState` folds them.
		const roster = await loadTeamRoster(client, viewerTeamId, contracts);

		/**
		 * The re-entry answer for one Auction — `server/bidding.ts:274-302`'s
		 * narrowing, per Auction, over the one folded state.
		 *
		 * `fantraxPlayerId` is passed to `teamMoneyStateFor` so THIS Auction is
		 * excluded from the Team's own leads: the prospective Bid replaces any
		 * position the Team holds here, and counting both would commit the Team
		 * twice for one Player. That is the same exclusion the locked
		 * transaction makes when the Bid is actually placed, which is what lets
		 * the card and the eventual refusal state one figure.
		 */
		const answerFor = (fantraxPlayerId: string): ReEntry => {
			const auction = auctionForPlayer(auctions, fantraxPlayerId);
			const state = bidStateFor(
				auction,
				teamMoneyStateFor({
					teamId: viewerTeamId,
					fantraxPlayerId,
					capSpace: roster.capSpace,
					rosterCount: roster.rosterCount,
					minorLeagueOccupied: roster.minorLeagueOccupied,
					auctions,
					playerNameFor: (playerId) =>
						nominationForPlayer(nominations, playerId)?.playerName ?? playerId
				}),
				phase
			);
			return reEntryFor({
				state,
				fantraxPlayerId,
				viewerTeamId,
				now: figuresAt
			});
		};

		// Assembled once WITHOUT metadata to learn which Players and which
		// Managers the page names, then again with the reference rows in hand.
		// Two passes over lists already in memory, rather than a statement per
		// card — `loadBoard`'s own two-pass shape.
		const bare = positionsFor({
			nominations,
			auctions,
			contracts,
			metadata: new Map(),
			viewerTeamId,
			reEntryFor: answerFor
		});

		const metadata = await loadMetadata(client, playerIdsNamed(bare));
		const managerNames = await loadManagerNames(client, managerIdsNamed(bare));

		const positions = positionsFor({
			nominations,
			auctions,
			contracts,
			metadata,
			viewerTeamId,
			reEntryFor: answerFor
		});

		await client.query('rollback');

		return {
			viewerTeamId,
			figuresAt,
			empty: positions.empty,
			openAuctionCount: positions.openAuctionCount,
			nominationSlot: positions.nominationSlot,
			won: positions.won.map((card) => ({
				fantraxPlayerId: card.fantraxPlayerId,
				playerName: card.playerName,
				metadata: card.metadata,
				winningAmountLabel: card.winningAmountLabel,
				placement: card.placement,
				closedAt: card.closedAt,
				href: card.href
			})),
			outbid: positions.outbid.map((card) => ({
				fantraxPlayerId: card.fantraxPlayerId,
				playerName: card.playerName,
				metadata: card.metadata,
				priceLabel: card.priceLabel,
				yourBidLabel: card.yourBidLabel,
				leadingBidder: nameTeam(
					card.leadingTeamName,
					card.leadingManagerId === null
						? null
						: (managerNames.get(pairKey(card.leadingManagerId, card.leadingTeamId)) ?? null)
				),
				closesAt: card.closesAt,
				contention: card.contention,
				stateLabel: card.stateLabel,
				stateIcon: card.stateIcon,
				reEntrySentence: card.reEntry.sentence,
				reEntryBlocked: card.reEntry.blocked,
				// Both gates, always — refused and passed alike (AD-7). The
				// surface prints the rows it is given and decides nothing.
				reEntryGates: card.reEntry.gateRows,
				href: card.href
			})),
			youLead: positions.youLead.map((card) => ({
				fantraxPlayerId: card.fantraxPlayerId,
				playerName: card.playerName,
				metadata: card.metadata,
				priceLabel: card.priceLabel,
				closesAt: card.closesAt,
				contention: card.contention,
				stateLabel: card.stateLabel,
				stateIcon: card.stateIcon,
				commitmentSentence: card.commitmentSentence,
				href: card.href
			})),
			contending: positions.contending.map((card) => ({
				fantraxPlayerId: card.fantraxPlayerId,
				playerName: card.playerName,
				metadata: card.metadata,
				priceLabel: card.priceLabel,
				closesAt: card.closesAt,
				contention: card.contention,
				contentionLabel: card.contentionLabel,
				stateLabel: card.stateLabel,
				stateIcon: card.stateIcon,
				contenderCountSentence: card.contenderCountSentence,
				clockSentence: card.clockSentence,
				href: card.href
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

/**
 * Every Player this page names, in first-seen group order.
 *
 * Explicitly ordered rather than handed back from a `Set` incidentally: it is
 * only a query parameter and affects no outcome, but AD-1's discipline about
 * incidental ordering is cheaper to keep than to argue about at each site.
 */
function playerIdsNamed(positions: Positions): readonly string[] {
	const seen = new Set<string>();
	const ids: string[] = [];
	const push = (id: string | null) => {
		if (id === null || id === '' || seen.has(id)) return;
		seen.add(id);
		ids.push(id);
	};
	for (const card of positions.won) push(card.fantraxPlayerId);
	for (const card of positions.outbid) push(card.fantraxPlayerId);
	for (const card of positions.youLead) push(card.fantraxPlayerId);
	for (const card of positions.contending) push(card.fantraxPlayerId);
	push(positions.nominationSlot.fantraxPlayerId);
	return ids;
}

/**
 * Every Manager this page names — the leading bidder of each outbid Auction,
 * which is the one place a Manager's name appears on this surface.
 *
 * The viewer's own name is never one of them: the page is about their Team and
 * naming them back to themselves says nothing.
 */
function managerIdsNamed(positions: Positions): readonly string[] {
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const card of positions.outbid) {
		const managerId = card.leadingManagerId;
		if (managerId === null || managerId === '' || seen.has(managerId)) continue;
		seen.add(managerId);
		ids.push(managerId);
	}
	return ids;
}
