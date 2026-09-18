/**
 * `loadAuctionPage` against a fake gateway harness (Story 2.4).
 *
 * The fake mirrors `tests/server/nomination.test.ts`'s: it records every
 * statement issued, throws on any statement it does not recognise, and
 * always answers `begin`/`select * from auction_events`/`rollback` the way
 * a real `pg` client would. There is no `open_nominations` branch here on
 * purpose — this reader never touches it (spec's Boundaries: "Any read of
 * `open_nominations`" is an Ask First item, and this module reads none).
 */

import { describe, expect, it } from 'vitest';

import { CLOSED_TEAM_ID, closedPayload } from '../fixtures/closed-event.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
	AUCTION_EXPIRED,
	BID_CANCELLED_EVENT,
	BID_PLACED_EVENT,
	CONTENTION_DISSOLVED_EVENT
} from '../../src/lib/core/projection/auctions.ts';
import { AUCTION_CLOSED_EVENT, NOMINATION_PLACED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { AUCTION_OPENED_EVENT } from '../../src/lib/core/projection/phase.ts';
import { CONTENTION_DRAWN_EVENT } from '../../src/lib/core/projection/draws.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	BID_READY,
	bidControlState,
	bidRefusalDetail,
	bidStateFor,
	evaluate
} from '../../src/lib/core/rules/bidding.ts';
import { loadAuctionPage } from '../../src/lib/server/auction-page.ts';
import type {
	AuctionPageRead,
	AuctionPageState,
	ClosedAuctionPageState
} from '../../src/lib/server/auction-page.ts';

/**
 * The OPEN half of the read, asserted rather than cast.
 *
 * `loadAuctionPage` returns a discriminated read now — an open Auction or a
 * closed one — so every assertion about a price, a Bid history or a bid
 * control is a test stating "and this read found an OPEN Auction". Throwing on
 * the other case is the point: a test that silently narrowed would keep
 * passing if the branch it exercises started answering `closed`.
 *
 * `null` passes straight through, because a null read is a real answer these
 * tests assert on directly.
 */
function openPage(read: AuctionPageRead | null): AuctionPageState | null {
	if (read === null) return null;
	if (read.kind !== 'open') throw new Error(`expected an open Auction, received "${read.kind}"`);
	return read;
}

/** The CLOSED half, asserted rather than cast — `openPage`'s mirror. */
function closedPage(read: AuctionPageRead | null): ClosedAuctionPageState | null {
	if (read === null) return null;
	if (read.kind !== 'closed') {
		throw new Error(`expected a closed Auction, received "${read.kind}"`);
	}
	return read;
}

/** A seed and the commitment it was published against — 64 hex, as recorded. */
const SEED = '4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e';
const SEED_HASH = '0f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a6978';
import type { ConnectionGateway, QueryResultRow, TransactionalClient } from '../../src/lib/shell/write.ts';

function logEvent(
	seq: number,
	type: string,
	payload: unknown,
	occurredAt = '2026-08-25T19:00:00.000Z',
	envelope: { managerId?: string; teamId?: string } = {}
): QueryResultRow {
	return {
		seq,
		occurred_at: new Date(occurredAt),
		schema_version: 1,
		core_version: 1,
		manager_id: envelope.managerId ?? 'm-0',
		team_id: envelope.teamId ?? 't-0',
		event_type: type,
		payload
	};
}

/**
 * A `NominationPlaced` row with the acting Manager stamped on the ENVELOPE
 * as well as copied into the payload — which is how the real shell appends
 * one (`runTransactionalWrite` writes `manager_id`/`team_id` on every row),
 * and what `loadAuctionPage` now reads. A fixture that left the envelope on
 * a placeholder would test a log shape the product never produces.
 */
function nominated(
	seq: number,
	fantraxPlayerId: string,
	playerName: string,
	teamId: string,
	teamName: string,
	managerId: string,
	occurredAt = '2026-08-25T19:00:00.000Z'
): QueryResultRow {
	return logEvent(
		seq,
		NOMINATION_PLACED_EVENT,
		{ fantraxPlayerId, playerName, teamId, teamName, managerId },
		occurredAt,
		{ managerId, teamId }
	);
}

/**
 * A `BidPlaced` row exactly as `server/bidding.ts` appends one: the acting
 * Manager and Team stamped on the ENVELOPE by the shell, and the payload
 * carrying what `auctionsReducer` folds — including the absolute `closesAt`
 * the core computed from the transaction-start clock (AD-3).
 */
function bidPlaced(
	seq: number,
	fantraxPlayerId: string,
	teamId: string,
	teamName: string,
	managerId: string,
	amount: number,
	occurredAt: string,
	closesAt: string
): QueryResultRow {
	return logEvent(
		seq,
		BID_PLACED_EVENT,
		{ fantraxPlayerId, teamId, teamName, managerId, amount, closesAt },
		occurredAt,
		{ managerId, teamId }
	);
}

type FreeAgentRow = {
	fantraxPlayerId: string;
	playerName?: string;
	positions: string;
	nbaTeam: string;
};

type ManagerRow = {
	id: string;
	teamId: string;
	displayName: string;
};

/** The Team the VIEWER is bound to. Never the nominating or bidding Team
 *  unless a test says so, so `selfBid` does not fire by accident. */
const VIEWER_TEAM = 't-viewer';

/**
 * The `AuctionOpened` every one of these logs carries (Story 3.7).
 *
 * The ninth `PLACE_BID_GATES` gate reads the folded phase, and a log with no
 * open folds to Setup — where no Bid is accepted at all, so the control this
 * page renders would be disabled league-wide. Every scenario in this file is a
 * live auction, so every fixture log opens the auction first. It sits at `seq`
 * 0, before the nomination and the Bids, which is the only order the gates
 * could ever have produced.
 */
function auctionOpened(occurredAt = '2026-08-25T09:00:00.000Z'): QueryResultRow {
	return {
		seq: 0,
		occurred_at: new Date(occurredAt),
		schema_version: 1,
		core_version: 1,
		manager_id: 'm-commissioner',
		team_id: 't-commissioner',
		event_type: AUCTION_OPENED_EVENT,
		payload: {}
	};
}

function fakeGateway(options: {
	events?: QueryResultRow[];
	freeAgents?: FreeAgentRow[];
	managers?: ManagerRow[];
	/** Team ids that exist in `teams`. Defaults to "every Team the events name". */
	teams?: string[];
	/** Team id -> name, for the Closed state's Contender-list lookup. */
	teamNames?: Record<string, string>;
	/** The viewer Team's `team_rosters` rows. Defaults to nine $1.0M contracts. */
	roster?: QueryResultRow[];
	/**
	 * What `select now()` answers — the DATABASE clock (Story 3.1).
	 *
	 * A fixture, not a real clock: the `expiry` gate is decided against this
	 * instant, so a test that let the wall clock in would start refusing
	 * every Auction in this file the moment its fixtures aged. The default
	 * sits after the latest Bid below and comfortably before its close.
	 */
	now?: string;
	/**
	 * The rows `select now()` returns, overriding `now` entirely.
	 *
	 * The only way to reach `requireDatabaseClock`'s throw: the handler below
	 * otherwise always answers a valid `Date`, which would leave that branch
	 * unreachable and therefore unproven.
	 */
	clock?: QueryResultRow[];
}) {
	const order: string[] = [];
	let committed = false;
	let rolledBack = false;
	let released = 0;

	const events = options.events ?? [];
	const freeAgents = options.freeAgents ?? [];
	const managers = options.managers ?? [];
	// Cap Space $156.0M and Roster Count 9 — deliberately generous, so the
	// money gate is never the reason an assertion in this file changes
	// meaning. `tests/examples/example-03-*` and its neighbours are where the
	// arithmetic itself is the subject.
	const roster =
		options.roster ??
		Array.from({ length: 9 }, () => ({ cap_hit: '1000000', roster_slot_kind: 'active_bench' }));
	// The nominating Team exists unless a test says otherwise — the join's
	// driving table, so "no such Team" has to be expressible too.
	const teams =
		options.teams ??
		events.map((row) => String((row['payload'] as Record<string, unknown>)?.['teamId'] ?? ''));
	const now = new Date(options.now ?? '2026-08-26T13:00:00.000Z');

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, params: readonly unknown[] = []) {
			const sql = text.trim();
			if (/^begin/i.test(sql)) {
				order.push('begin');
				return { rows: [] };
			}
			if (/^select \* from auction_events/i.test(sql)) {
				order.push('read-log');
				// The auction is OPEN in every scenario here (Story 3.7): the ninth
				// gate reads the folded phase, and a log with no `AuctionOpened`
				// folds to Setup, where the control is disabled league-wide.
				return { rows: [auctionOpened(), ...events] };
			}
			// The ONE database clock read (Story 3.1). A label, not a loosened
			// fake: an unrecognised statement still throws below, so a second
			// clock read — or a Node clock quietly standing in for this one —
			// fails the suite rather than passing unnoticed. No lock: this
			// module deliberately takes none, and `now()` needs none.
			if (/^select now\(\) as now/i.test(sql)) {
				order.push('read-clock');
				return { rows: options.clock ?? [{ now }] };
			}
			if (/^select player_name, positions, nba_team\s+from free_agent_players/i.test(sql)) {
				order.push('read-reference');
				const found = freeAgents.find((row) => row.fantraxPlayerId === params[0]);
				return {
					rows:
						found === undefined
							? []
							: [
									{
										player_name: found.playerName ?? found.fantraxPlayerId,
										positions: found.positions,
										nba_team: found.nbaTeam
									}
								]
				};
			}
			// `teams t left join managers m on m.id = $1 and m.team_id = t.id
			//  where t.id = $2` — a row whenever the Team exists, with a null
			// display_name when no Manager row matches BOTH that id and that
			// Team. The fake reproduces the join, not just the projection.
			if (/^select m\.display_name\s+from teams t\s+left join managers m/i.test(sql)) {
				order.push('read-manager');
				if (!teams.includes(String(params[1]))) return { rows: [] };
				const found = managers.find((row) => row.id === params[0] && row.teamId === params[1]);
				return { rows: [{ display_name: found === undefined ? null : found.displayName }] };
			}
			// The ONE statement that resolves every bidding Manager's name
			// (Story 2.5). A label, not a loosened fake: an unrecognised
			// statement still throws, so a second query per Bid — or a read of
			// a table this module has no business touching — fails the suite.
			// The ONE statement that resolves a closed lottery's Contender NAMES
			// (the Closed state). A label, not a loosened fake: a name-per-
			// Contender read would be thirty queries and `order` is what proves
			// it is one.
			if (/^select id::text as id, name\s+from teams/i.test(sql)) {
				order.push('read-team-names');
				const wanted = (params[0] ?? []) as readonly string[];
				return {
					rows: Object.entries(options.teamNames ?? {})
						.filter(([id]) => wanted.includes(id))
						.map(([id, name]) => ({ id, name }))
				};
			}
			if (/^select m\.id::text as id, m\.team_id::text as team_id, m\.display_name/i.test(sql)) {
				order.push('read-bidders');
				const wanted = (params[0] ?? []) as readonly string[];
				return {
					rows: managers
						.filter((row) => wanted.includes(row.id))
						.map((row) => ({ id: row.id, team_id: row.teamId, display_name: row.displayName }))
				};
			}
			// The viewer Team's Cap figures (Story 2.6). A label, not a
			// loosened fake: the read is skipped entirely for a viewer bound
			// to no Team, and `order` is what proves it.
			// Matched on the TABLE rather than on the column list: Story 4.5
			// widened this select to carry the Player id and name the Team
			// view's roster listing needs from the same one read.
			if (/from team_rosters/i.test(sql)) {
				order.push('read-roster');
				return { rows: roster };
			}
			if (/^commit/i.test(sql)) {
				order.push('commit');
				committed = true;
				return { rows: [] };
			}
			if (/^rollback/i.test(sql)) {
				order.push('rollback');
				rolledBack = true;
				return { rows: [] };
			}
			throw new Error(`unexpected statement: ${sql}`);
		},
		release() {
			released += 1;
		}
	};

	const gateway: ConnectionGateway = {
		connect: async () => client
	};

	return {
		gateway,
		now,
		order,
		state: {
			get committed() {
				return committed;
			},
			get rolledBack() {
				return rolledBack;
			},
			get released() {
				return released;
			}
		}
	};
}

// --- The happy path -----------------------------------------------------

describe('loadAuctionPage — an open Auction', () => {
	it('renders Player identity, metadata and the nominating Team spelled out with its Manager — AC1', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')],
			freeAgents: [{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }]
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction).toEqual({
			// The read is discriminated: this one found an OPEN Auction.
			kind: 'open',
			fantraxPlayerId: 'p-1',
			playerName: 'Jalen Green',
			metadata: { positions: 'SG', nbaTeam: 'HOU' },
			nominatingTeam: 'Lakers — Meakel',
			nominatedAt: '2026-08-25T19:00:00.000Z',
			// Story 2.5's half: nominated, nobody has bid. "No bids yet" is a
			// state of the Auction, never "there is no Auction".
			contention: 'Awaiting an Opening Bid.',
			// Story 3.2: no lottery is running, so there are no Contenders and
			// no published commitment. Empty and null rather than absent —
			// every key is always on the wire, whatever the state.
			contenders: [],
			contenderCount: 0,
			seedHash: null,
			// Story 3.3: nothing revealed either. No lottery ran here, so
			// there is no dissolution and no seed to publish.
			seed: null,
			price: null,
			leadingBidder: null,
			closesAt: null,
			bids: [],
			bidControl: {
				available: true,
				detail: BID_READY,
				// $1,000,000 opens a Minimum-Bid Contention since Story 3.2,
				// and the opening gate passes it — so the smallest legal
				// opening is the minimum itself rather than one grid step
				// above it.
				minimumLegal: 1_000_000,
				minimumLegalSentence: 'Whole dollars. The least this Auction will take is $1.0M.',
				// Story 3.7's ninth gate reads this and nothing else. A FACT, not a
				// verdict: no `biddingIsOpen` boolean crosses this wire, so the
				// browser asks the core exactly as the locked transaction does.
				phase: 'Auction',
				// The facts every gate decides from, serialised so the surface
				// can ask the same question about a TYPED amount.
				leadingAmount: null,
				leadingTeamId: null,
				// Story 3.2's two contention facts. A state literal and a list
				// of ids — never `isLottery` and never `youAreContending`,
				// which would be derivations the browser trusted instead of
				// making.
				contention: 'awaiting_opening_bid',
				contenderTeamIds: [],
				viewerTeamId: VIEWER_TEAM,
				// The viewer Team's money FACTS, and deliberately not its
				// Maximum Bid: AD-7 forbids a derived money figure being cached
				// client-side for validation, so the surface gets the inputs and
				// re-derives through the same `evaluate()` the lock calls.
				team: {
					capSpace: 156_000_000,
					rosterCount: 9,
					leading: [],
					// Story 2.8's two Team facts. Note what is NOT here: `M`,
					// Overflow Count, Minors Exposure and Maximum Bid are all
					// derived, and a derived figure never crosses the wire.
					eligibleLeading: [],
					minorLeagueOccupied: 0
				},
				figuresAt: expect.any(String)
			}
		});
	});

	it('omits the metadata line entirely, without throwing, when the reference row is missing', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')],
			freeAgents: [],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }]
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.playerName).toBe('Jalen Green');
		expect(auction?.metadata).toBeNull();
	});

	it('takes the Player name from free_agent_players, not from the fold, when the row exists', async () => {
		// The reference table is the source for Player reference fields
		// (Boundaries/Always). The fold's copy was stamped at nomination time
		// and can be stale; a corrected reference row must win.
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'J. Green', 't-1', 'Lakers', 'm-1')],
			freeAgents: [
				{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
			],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }]
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.playerName).toBe('Jalen Green');
	});

	it('renders the Team name ALONE when the Manager row cannot be resolved — never paired with itself', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-9')],
			freeAgents: [
				{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
			],
			managers: []
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		// `Lakers — Lakers` would read as a Manager literally called
		// "Lakers" — a name in neither the fold nor the reference table, and
		// exactly the invented figure the spec's Ask First list forbids.
		expect(auction?.nominatingTeam).toBe('Lakers');
		expect(auction?.nominatingTeam).not.toContain('—');
	});

	it('refuses a Manager who does not belong to the nominating Team — the join checks both', async () => {
		// `m-2` is a real Manager, but of a different Team. Keying on the id
		// alone would have named the wrong person on this Auction.
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-2')],
			freeAgents: [
				{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
			],
			managers: [{ id: 'm-2', teamId: 't-2', displayName: 'Someone Else' }]
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.nominatingTeam).toBe('Lakers');
	});

	it('renders the Team name alone when the Team row itself is gone — the join returns nothing', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')],
			freeAgents: [
				{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
			],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }],
			teams: []
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.nominatingTeam).toBe('Lakers');
	});

	it('takes no advisory lock and always rolls back — rendering is never the check', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')],
			freeAgents: [{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }]
		});

		await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

		expect(harness.order).not.toContain('lock');
		expect(harness.state.committed).toBe(false);
		expect(harness.state.rolledBack).toBe(true);
		expect(harness.state.released).toBe(1);
	});

	it('never reads open_nominations — this reader touches only the fold and the reference tables', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')],
			freeAgents: [{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }]
		});

		await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

		// The fake throws on any statement it does not recognise, so a read
		// of open_nominations would have failed the harness outright; this
		// also states the order actually taken.
		// No `read-bidders`: this Auction has no Bids, so the statement that
		// resolves bidding Managers is never issued at all.
		expect(harness.order).toEqual([
			'begin',
			'read-log',
			// Story 3.1's ONE database clock read, taken where the figures are
			// read and with no lock: it is both the `expiry` gate's `now` and
			// the `figuresAt` caption, so the two cannot describe different
			// moments. Exactly one appears in this list, on every path.
			'read-clock',
			// Story 2.6's read of the VIEWER's Cap figures. Still no
			// open_nominations and no `free_agent_players.minor_league_eligible`
			// — eligibility is folded from the events already read, so one
			// transaction cannot hold two answers about it.
			'read-roster',
			'read-reference',
			'read-manager',
			'rollback'
		]);
	});
});

// --- The 404 cases --------------------------------------------------------

describe('loadAuctionPage — no open nomination', () => {
	it('returns null for a Player never nominated — AC4', async () => {
		const harness = fakeGateway({ events: [] });
		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));
		expect(auction).toBeNull();
	});

	it('returns null for an unknown Player id matching nothing anywhere', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')]
		});
		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-does-not-exist', VIEWER_TEAM));
		expect(auction).toBeNull();
	});

	// Matrix row "Closed", INVERTED. Until the Closed state existed this
	// asserted `null` and the route turned it into a 404, so an Auction with a
	// winner, a final amount and — for a lottery — a seed and an ordered
	// Contender list had no surface at all. It renders now, and what proves the
	// close still happened is the DISCRIMINANT: the nomination and the Auction
	// are gone from their folds, and the contract is what is left.
	it('renders the CLOSED state once the Auction has closed, not a 404', async () => {
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1'),
				logEvent(2, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1' }))
			],
			teams: [CLOSED_TEAM_ID],
			freeAgents: [
				{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
			],
			managers: [{ id: 'm-w', teamId: CLOSED_TEAM_ID, displayName: 'Sam' }]
		});
		const closed = closedPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(closed?.kind).toBe('closed');
		expect(closed?.playerName).toBe('Jalen Green');
		expect(closed?.metadata).toEqual({ positions: 'SG', nbaTeam: 'HOU' });
		// The winner and the final amount. The placement sentence beside them
		// was removed as redundant — on a standard close its Cap Hit restates
		// the amount directly above it.
		expect(closed?.winner).toBe('Team W');
		expect(closed?.winningAmount).toBe('$1.0M');
		// The Auction's own persisted expiry, never the transaction clock.
		expect(closed?.closedAt).toBe('2026-08-27T09:00:00.000Z');
		// No draw: this close was a Standard one.
		expect(closed?.draw).toBeNull();
		// A Standard close records the winning TEAM and no Manager, so the page
		// names the Team alone rather than borrowing a Manager id from
		// somewhere else. `m-w` is on the payload and is deliberately not read.
		expect(closed?.winner).not.toContain('Sam');
	});

	it('carries the Bid history the close left behind, named and in seq order', async () => {
		// The Bids are still in the log after the close — only the projection
		// entry went — so the Closed page prints the record the winner sits on
		// top of, with the same names the open page printed an hour earlier.
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1'),
				bidPlaced(
					2,
					'p-1',
					't-2',
					'Rockets',
					'm-2',
					6_000_000,
					'2026-08-26T09:00:00.000Z',
					'2026-08-27T09:00:00.000Z'
				),
				bidPlaced(
					3,
					'p-1',
					't-3',
					'Suns',
					'm-3',
					8_000_000,
					'2026-08-26T10:00:00.000Z',
					'2026-08-27T10:00:00.000Z'
				),
				logEvent(4, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1' }))
			],
			teams: [CLOSED_TEAM_ID, 't-2', 't-3'],
			managers: [
				{ id: 'm-2', teamId: 't-2', displayName: 'Ali' },
				{ id: 'm-3', teamId: 't-3', displayName: 'Bo' }
			]
		});

		const closed = closedPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		// Oldest first, in the log's own `seq` order, each naming the Team AND
		// the acting Manager — there is no anonymity on either side of a close.
		expect(closed?.bids.map((entry) => entry.seq)).toEqual(['2', '3']);
		expect(closed?.bids.map((entry) => entry.bidder)).toEqual([
			'Rockets — Ali',
			'Suns — Bo'
		]);
		expect(closed?.bids.map((entry) => entry.amount)).toEqual(['$6.0M', '$8.0M']);
		expect(closed?.bids[0]?.occurredAt).toBe('2026-08-26T09:00:00.000Z');
	});

	it('keeps a cancelled Bid in the closed history, still marked (FR-40)', async () => {
		// A cancellation withdraws a Bid's STANDING and never the Bid, and the
		// close must not be the thing that finally hides it.
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1'),
				bidPlaced(
					2,
					'p-1',
					't-2',
					'Rockets',
					'm-2',
					6_000_000,
					'2026-08-26T09:00:00.000Z',
					'2026-08-27T09:00:00.000Z'
				),
				logEvent(3, BID_CANCELLED_EVENT, {
					fantraxPlayerId: 'p-1',
					cancelledSeq: '2',
					causePlayerId: 'p-9',
					causePlayerName: 'Alperen Sengun'
				}),
				bidPlaced(
					4,
					'p-1',
					't-3',
					'Suns',
					'm-3',
					8_000_000,
					'2026-08-26T10:00:00.000Z',
					'2026-08-27T10:00:00.000Z'
				),
				logEvent(5, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1' }))
			],
			teams: [CLOSED_TEAM_ID, 't-2', 't-3']
		});

		const closed = closedPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(closed?.bids.map((entry) => entry.seq)).toEqual(['2', '4']);
		expect(closed?.bids[0]?.cancellation?.causePlayerName).toBe('Alperen Sengun');
		expect(closed?.bids[1]?.cancellation).toBeNull();
	});

	it('renders an empty history rather than none when no Bid survived the close', async () => {
		// A close with no `BidPlaced` behind it at all. Empty is a real recorded
		// answer — an emptied lottery reaches it — and the page states it.
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1'),
				logEvent(2, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1' }))
			],
			teams: [CLOSED_TEAM_ID]
		});

		const closed = closedPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(closed?.bids).toEqual([]);
	});

	// Matrix row "Draw with no contract". A `ContentionDrawn` alone is not a
	// closed Auction: it says a lottery selected somebody and the close was
	// never recorded, which is a corrupt or half-written log. Inventing a
	// winner from it would put a Player on a roster nothing says they are on.
	it('404s on a draw with no close behind it — a draw alone is not a Closed Auction', async () => {
		const harness = fakeGateway({
			events: [
				logEvent(1, CONTENTION_DRAWN_EVENT, {
					fantraxPlayerId: 'p-1',
					seed: SEED,
					seedHash: SEED_HASH,
					contenders: ['t-a', 't-b'],
					selectedIndex: 1,
					winningTeamId: 't-b',
					winningTeamName: 'Rockets',
					winningManagerId: 'm-b'
				})
			]
		});
		expect(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM)).toBeNull();
	});

	it('renders the lottery half: the commitment, the seed and the ordered list', async () => {
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1'),
				logEvent(2, CONTENTION_DRAWN_EVENT, {
					fantraxPlayerId: 'p-1',
					seed: SEED,
					seedHash: SEED_HASH,
					contenders: ['t-a', 't-b', 't-c'],
					selectedIndex: 1,
					winningTeamId: 't-b',
					winningTeamName: 'Rockets',
					winningManagerId: 'm-b'
				}),
				logEvent(
					3,
					AUCTION_CLOSED_EVENT,
					closedPayload({ fantraxPlayerId: 'p-1', teamId: 't-b', teamName: 'Rockets' })
				)
			],
			teams: ['t-b'],
			teamNames: { 't-a': 'Lakers', 't-b': 'Rockets' },
			managers: [{ id: 'm-b', teamId: 't-b', displayName: 'Sam' }]
		});
		const closed = closedPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(closed?.draw?.drawn).toBe(true);
		expect(closed?.draw?.seed).toBe(SEED);
		expect(closed?.draw?.seedHash).toBe(SEED_HASH);
		expect(closed?.draw?.selectedIndex).toBe(1);
		// The list is NAMES in the fold's own `seq` order and is never
		// re-sorted: AD-14 makes that order an input to the winner, so a
		// reordered list is not the list the draw ran over.
		expect(closed?.draw?.contenders.map((entry) => entry.teamName)).toEqual([
			'Lakers',
			'Rockets',
			// Matrix row "Contender id naming no Team": the id is printed AS
			// itself rather than the Contender being dropped, because dropping
			// one would shorten a list whose LENGTH decides the winner.
			't-c'
		]);
		expect(closed?.draw?.contenders.map((entry) => entry.selected)).toEqual([false, true, false]);
		// The sentence `/verify` is checked against, asserted for its VALUE and
		// not merely for being non-null. The formatter is unit-tested in
		// isolation, which proves it correct in the abstract; this is the only
		// assertion that the server hands it the right two arguments. An
		// off-by-one here — `selectedIndex + 1` on top of the formatter's own
		// increment, or `contenders.length - 1` — prints a position a Manager
		// running the published procedure would fail to reproduce, which is the
		// one failure AD-14 cannot absorb.
		expect(closed?.draw?.selectionSentence).toBe('The draw selected position 2 of 3.');
		// The draw records the winning Manager, so this page can name one.
		expect(closed?.winner).toBe('Rockets — Sam');
		// One statement for the whole list, never one per Contender.
		expect(harness.order.filter((label) => label === 'read-team-names')).toHaveLength(1);
	});

	// Matrix row "Emptied lottery" (Story 10.5). A real recorded outcome: the
	// commitment is discharged whatever the list came out as, so the seed is
	// revealed and the page states that no draw ran.
	it('renders an EMPTIED lottery: seed and commitment, and no selection', async () => {
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1'),
				logEvent(2, CONTENTION_DRAWN_EVENT, {
					fantraxPlayerId: 'p-1',
					seed: SEED,
					seedHash: SEED_HASH,
					contenders: []
				}),
				logEvent(3, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1' }))
			],
			teams: [CLOSED_TEAM_ID]
		});
		const closed = closedPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(closed?.draw?.drawn).toBe(false);
		expect(closed?.draw?.seed).toBe(SEED);
		expect(closed?.draw?.seedHash).toBe(SEED_HASH);
		expect(closed?.draw?.contenders).toEqual([]);
		// No position, because `drawIndex` was never reached. A `0` beside an
		// empty list would name a place that does not exist.
		expect(closed?.draw?.selectedIndex).toBeNull();
		expect(closed?.draw?.selectionSentence).toBeNull();
		// An empty list costs no `teams` statement at all.
		expect(harness.order).not.toContain('read-team-names');
	});

	// Matrix row "Missing free_agent_players row", on the closed path. The
	// close does NOT delete the reference row — only `import-promotion.ts`
	// does — so this is the same fallback the open branch takes, proven on the
	// branch that would otherwise never exercise it.
	it('falls back to the contract own name when the reference row is absent', async () => {
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1'),
				logEvent(2, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1' }))
			],
			teams: [CLOSED_TEAM_ID]
		});
		const closed = closedPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));
		expect(closed?.playerName).toBe('A Won Player');
		expect(closed?.metadata).toBeNull();
	});

	it('still renders a different Player whose Auction is still open', async () => {
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1'),
				nominated(2, 'p-2', 'Alperen Sengun', 't-2', 'Rockets', 'm-2'),
				logEvent(3, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1' }))
			],
			teams: [CLOSED_TEAM_ID, 't-2']
		});
		expect((await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM))?.kind).toBe('closed');
		expect((await loadAuctionPage(harness.gateway, 'p-2', VIEWER_TEAM))?.kind).toBe('open');
	});

	it('rolls back rather than commits on a null read', async () => {
		const harness = fakeGateway({ events: [] });
		await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);
		expect(harness.state.committed).toBe(false);
		expect(harness.state.rolledBack).toBe(true);
		expect(harness.state.released).toBe(1);
		// ONE database clock, on this path as on every other — it is what the
		// Closed state's relative phrase is measured from, so it is read above
		// the branch rather than in one arm of it. No reference, manager or
		// `teams` lookup runs when there is nothing to look up.
		expect(harness.order).toEqual(['begin', 'read-log', 'read-clock', 'rollback']);
	});

	it('reads the log ONCE and the clock ONCE on the closed path too', async () => {
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1'),
				logEvent(2, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1' }))
			],
			teams: [CLOSED_TEAM_ID]
		});
		await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);
		expect(harness.order.filter((label) => label === 'read-log')).toHaveLength(1);
		expect(harness.order.filter((label) => label === 'read-clock')).toHaveLength(1);
		expect(harness.order.at(-1)).toBe('rollback');
		expect(harness.state.committed).toBe(false);
		// No lock: rendering a page is not a write, on either branch.
		expect(harness.order.some((label) => /advisory/i.test(label))).toBe(false);
	});
});

// --- Story 2.5: the Bids, the price, the clock and the control ------------

const NOMINATED_AT = '2026-08-25T19:00:00.000Z';

/** An Auction with two raises: $8.0M by the Lakers, $8.5M by the Rockets. */
/**
 * A `BidCancelled` row exactly as `rules/close.ts` appends one inside a
 * closing transaction — the cascade's own record, folded here rather than
 * re-decided (AD-31).
 *
 * `restoration` is the whole point of the fixture: a Bid the cascade seated
 * beneath the cancelled one, or `null` when nothing survived. It is the only
 * thing separating the two sentences the Auction history can print.
 */
function bidCancelled(
	seq: number,
	fantraxPlayerId: string,
	cancelledSeq: string,
	teamId: string,
	causeFantraxPlayerId: string,
	causePlayerName: string,
	restoration: Record<string, unknown> | null,
	occurredAt = '2026-08-26T13:00:00.000Z'
): QueryResultRow {
	return logEvent(
		seq,
		BID_CANCELLED_EVENT,
		{
			fantraxPlayerId,
			cancelledSeq,
			teamId,
			causeFantraxPlayerId,
			causePlayerName,
			restoration
		},
		occurredAt,
		// No acting Manager or Team on the envelope: a cancellation is the
		// cascade's own act inside a close, not anybody's command. The
		// harness fills its own placeholder, which is all this fixture needs.
		{}
	);
}

function contestedAuction() {
	return fakeGateway({
		events: [
			nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1', NOMINATED_AT),
			bidPlaced(
				2,
				'p-1',
				't-1',
				'Lakers',
				'm-1',
				8_000_000,
				'2026-08-26T09:00:00.000Z',
				'2026-08-27T09:00:00.000Z'
			),
			bidPlaced(
				3,
				'p-1',
				't-2',
				'Rockets',
				'm-2',
				8_500_000,
				'2026-08-26T12:00:00.000Z',
				'2026-08-27T12:00:00.000Z'
			)
		],
		freeAgents: [
			{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
		],
		managers: [
			{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' },
			{ id: 'm-2', teamId: 't-2', displayName: 'Sam' }
		]
	});
}

describe('loadAuctionPage — the Auction with Bids on it (AC6)', () => {
	it('renders the current price, the Leading Bidder and the absolute close instant', async () => {
		const harness = contestedAuction();

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.price).toBe('$8.5M');
		expect(auction?.leadingBidder).toBe('Rockets — Sam');
		expect(auction?.contention).toBe('Standard Contention.');
		// The absolute close instant, straight off the leading Bid's payload —
		// never a duration, never "seconds remaining" (AD-3).
		expect(auction?.closesAt).toBe('2026-08-27T12:00:00.000Z');
	});

	it('renders every Bid in chronological order, each naming the acting Manager', async () => {
		const harness = contestedAuction();

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.bids).toEqual([
			{
				seq: '2',
				bidder: 'Lakers — Meakel',
				amount: '$8.0M',
				occurredAt: '2026-08-26T09:00:00.000Z',
				// Never cancelled, and the field says so rather than being
				// absent: `loadAuctionPage` states the fact in both directions
				// so the surface never has to distinguish "not cancelled" from
				// "not told" (Story 10.6).
				cancellation: null
			},
			{
				seq: '3',
				bidder: 'Rockets — Sam',
				amount: '$8.5M',
				occurredAt: '2026-08-26T12:00:00.000Z',
				cancellation: null
			}
		]);
	});

	it('resolves every bidding Manager in ONE further statement, never one per Bid', async () => {
		const harness = contestedAuction();

		await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

		expect(harness.order).toEqual([
			'begin',
			'read-log',
			'read-clock',
			'read-roster',
			'read-reference',
			'read-manager',
			'read-bidders',
			'rollback'
		]);
	});

	it('names the Team alone when a bidding Manager cannot be resolved — never paired with itself', async () => {
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1', NOMINATED_AT),
				bidPlaced(
					2,
					'p-1',
					't-2',
					'Rockets',
					'm-gone',
					8_000_000,
					'2026-08-26T09:00:00.000Z',
					'2026-08-27T09:00:00.000Z'
				)
			],
			freeAgents: [],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }]
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.leadingBidder).toBe('Rockets');
		expect(auction?.bids[0]?.bidder).toBe('Rockets');
	});

	it('refuses a bidding Manager who does not belong to the bidding Team', async () => {
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1', NOMINATED_AT),
				bidPlaced(
					2,
					'p-1',
					't-2',
					'Rockets',
					// A real Manager — of a different Team. Keying on the id alone
					// would have named the wrong person on this Bid.
					'm-1',
					8_000_000,
					'2026-08-26T09:00:00.000Z',
					'2026-08-27T09:00:00.000Z'
				)
			],
			freeAgents: [],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }]
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.leadingBidder).toBe('Rockets');
	});

	it('drops the Auction and its price once a close is folded, and keeps the history', async () => {
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1', NOMINATED_AT),
				bidPlaced(
					2,
					'p-1',
					't-2',
					'Rockets',
					'm-2',
					8_000_000,
					'2026-08-26T09:00:00.000Z',
					'2026-08-27T09:00:00.000Z'
				),
				logEvent(3, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1' }))
			],
			teams: [CLOSED_TEAM_ID]
		});

		// The Auction is gone from `auctionsReducer`, so the read no longer
		// finds an OPEN one — it finds the Closed state, which carries the
		// winner, the amount and the placement.
		const closed = closedPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));
		expect(closed?.kind).toBe('closed');
		// **And the Bid history comes with it.** What the close deleted is the
		// projection ENTRY; every `BidPlaced` is still in the log with its own
		// `seq`, so folding the same reducer up to the close returns the record
		// exactly as it stood when the Auction settled — a complete history
		// rather than a partial one, which is what the page's checkability
		// claim actually asked for.
		expect(closed?.bids).toHaveLength(1);
		expect(closed?.bids[0]?.bidder).toBe('Rockets');
		expect(closed?.bids[0]?.amount).toBe('$8.0M');
		// What is still structurally absent is the LIVE half: there is no
		// current price and no Leading Bidder on a settled Auction, and their
		// absence is the shape rather than a rendering choice a later edit
		// could reverse.
		expect(Object.keys(closed ?? {})).not.toContain('price');
		expect(Object.keys(closed ?? {})).not.toContain('leadingBidder');
		expect(Object.keys(closed ?? {})).not.toContain('bidControl');
		// And no nominating Team either: `nominationsReducer` deleted the
		// nomination, so naming one would be naming a Team nothing in the log
		// still says nominated this Player.
		expect(Object.keys(closed ?? {})).not.toContain('nominatingTeam');
	});
});

describe('loadAuctionPage — the bid control is evaluate() on the read path (AC7)', () => {
	it('pre-fills the minimum legal raise: the current high plus $500,000', async () => {
		const harness = contestedAuction();

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.bidControl.minimumLegal).toBe(9_000_000);
		expect(auction?.bidControl.minimumLegalSentence).toBe(
			'Whole dollars. The least this Auction will take is $9.0M.'
		);
		expect(auction?.bidControl.available).toBe(true);
		expect(auction?.bidControl.detail).toBe(BID_READY);
	});

	it('disables the control for the Team that already leads, and words it from the core', async () => {
		const harness = contestedAuction();

		// `t-2` holds the $8.5M leading Bid.
		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', 't-2'));

		expect(auction?.bidControl.available).toBe(false);
		expect(auction?.bidControl.detail).toContain('does not bid against itself');
		// Which gate refused is asserted where it is decided —
		// `tests/core/bidding.test.ts` on `bidControlState` — rather than
		// shipped to a client that renders no per-gate chip until Story 2.6.
		expect(auction?.bidControl.detail).toBe(
			bidRefusalDetail({
				kind: 'gates',
				gates: {
					// Story 3.7's ninth gate, and the first in the list. It passes:
					// the log this fake serves carries an `AuctionOpened`, so the
					// phase folds to Auction and bidding is open league-wide.
					phase: { passed: true, phase: 'Auction' },
					// Story 3.1's seventh gate, and the second in the list. It
					// passes: the leading Bid closes at noon on the 27th and the
					// fake's database clock reads 13:00 on the 26th. The two
					// instants are stated because they are the whole of what the
					// gate decides from — no amount, no money and no count.
					expiry: {
						passed: true,
						closesAt: '2026-08-27T12:00:00.000Z',
						evaluatedAt: '2026-08-26T13:00:00.000Z'
					},
					opening: {
						passed: true,
						opening: 'not_an_opening',
						offered: 9_000_000 as never,
						minimumOpening: 1_000_000 as never
					},
					// Story 3.2's eighth gate, immediately after `opening`. No
					// lottery is running on this Auction, so it has nothing to
					// decide and says so with a `contenderCount` of zero
					// rather than a figure it does not have.
					contention: {
						passed: true,
						entry: 'not_a_contention',
						offered: 9_000_000 as never,
						joinAmount: 1_000_000 as never,
						conversionAmount: 1_500_000 as never,
						contenderCount: 0
					},
					selfBid: { passed: false, actingTeamId: 't-2', leadingTeamId: 't-2' },
					increment: {
						passed: true,
						offered: 9_000_000 as never,
						currentHigh: 8_500_000 as never,
						minimumLegal: 9_000_000 as never
					},
					granularity: { passed: true, offered: 9_000_000 as never, grid: 500_000 as never },
					// The money gate passes and says so with its own figures.
					// The self-bid refusal is the only ground, which is exactly
					// what "every gate always reports" is for: a reader can see
					// the cap was checked and is not the obstacle.
					cap: {
						passed: true,
						offered: 9_000_000 as never,
						capSpace: 156_000_000 as never,
						committedBids: 0 as never,
						minorsExposure: 0 as never,
						availableCapSpace: 156_000_000 as never,
						rosterCount: 9,
						projectedAdditions: 1,
						rosterReserve: 2_000_000 as never,
						maximumBid: 154_000_000 as never,
						// Story 2.8's exposure arithmetic, reported on a PASSING
						// gate exactly as every other figure is: this Player is
						// not Minor League Eligible, so `N` is 0 against a full
						// three Free Minor League Slots, nothing overflows, and
						// Maximum Bid binds in the ordinary way.
						freeMinorLeagueSlots: 3,
						eligibleLeadingBids: 0,
						overflowCount: 0,
						unbounded: false,
						exposingBids: [],
						exposureIncludesThisBid: false
					},
					// And so does the capacity gate (Story 2.7), with its OWN
					// copy of the two counts rather than a pointer at `cap`'s:
					// nine held plus the one being bid is ten of twelve.
					slots: {
						passed: true,
						rosterCount: 9,
						projectedAdditions: 1,
						ceiling: 12,
						// Story 10.1's Outstanding Bid Allowance, reported on a
						// PASSING gate like everything else: three Slots stand
						// free, so this Team may hold four outstanding bids.
						freeActiveBenchSlots: 3,
						allowance: 4,
						// Counts only — the capacity gate still carries no money
						// field and no `offered` (FR-37).
						freeMinorLeagueSlots: 3,
						eligibleLeadingBidsExcludingEntries: 0,
						activeBenchOverflow: 0,
						// Story 10.2: an ordinary Bid on a Standard Contention,
						// so FR-37's branches decided it and not FR-18's.
						isContentionEntry: false
					}
				}
			})
		);
	});

	it('ships the two gate facts, so the surface can re-evaluate a TYPED amount', async () => {
		const harness = contestedAuction();

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		// Exactly `BidState`, serialised: the leading Team and the leading
		// amount. Without these the control could only ever know about the
		// pre-fill, and an illegal typed amount would be discovered at
		// submission.
		expect(auction?.bidControl.leadingAmount).toBe(8_500_000);
		expect(auction?.bidControl.leadingTeamId).toBe('t-2');
		expect(auction?.bidControl.viewerTeamId).toBe(VIEWER_TEAM);
	});

	it('omits the minimum-legal sentence when the figure has no lossless rendering', async () => {
		// Reachable only through a historical off-grid Bid, which this story
		// cannot write and the fold deliberately does not rewrite (AD-20): a
		// past event was produced under its own `coreVersion`. The correction
		// belongs at the render, and it is an omitted line rather than a
		// sentence whose figure is a phrase.
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1', NOMINATED_AT),
				bidPlaced(
					2,
					'p-1',
					't-1',
					'Lakers',
					'm-1',
					6_750_000,
					'2026-08-26T09:00:00.000Z',
					'2026-08-27T09:00:00.000Z'
				)
			],
			freeAgents: [],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }]
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.bidControl.minimumLegal).toBe(7_250_000);
		expect(auction?.bidControl.minimumLegalSentence).toBeNull();
		// The fold kept the historical amount exactly as it was recorded.
		expect(auction?.bidControl.leadingAmount).toBe(6_750_000);
	});

	it('disables the control for a Manager bound to no Team, with the unbound sentence', async () => {
		const harness = contestedAuction();

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', null));

		expect(auction?.bidControl.available).toBe(false);
		// No gate ran at all: an unbound actor has no Team for a command to
		// name, and `auction_events.team_id` is NOT NULL (AD-4).
		expect(auction?.bidControl.detail).toBe(bidRefusalDetail({ kind: 'unbound_actor' }));
	});

	it('serialises no DERIVED money figure anywhere in what it returns (AD-7)', async () => {
		const harness = contestedAuction();

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', 't-2'));

		// Narrowed to the DERIVED money figures in Story 2.7. `Roster Count` is
		// no longer forbidden here: a read path that refuses on capacity now
		// legitimately carries it in `detail`, worded by the core. What may
		// never be serialised is a figure the surface could compare against
		// instead of re-deriving — AD-7 forbids caching one client-side, and
		// the surface is a client.
		const rendered = JSON.stringify(auction);
		for (const forbidden of [
			'maximumBid',
			'committedBids',
			'minorsExposure',
			'rosterReserve',
			// Kept from the pre-2.7 list: `no money` is not a derived figure
			// and is not vocabulary this story earned, so the narrowing above
			// gives no ground to drop it. Nothing on the read path words it —
			// a cap refusal says "exceeds your Maximum Bid" — and this is what
			// would notice if something started to.
			'no money'
		]) {
			expect(rendered, `${forbidden} leaked into the Auction page read`).not.toContain(forbidden);
		}
	});
});

// --- Story 2.6: the money state on the read path --------------------------

describe('loadAuctionPage — the viewer Team money state (Story 2.6)', () => {
	it('skips the roster read entirely for a viewer bound to no Team', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')],
			freeAgents: [
				{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
			],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }]
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', null));

		// No Team, no roster to read and no arithmetic to show. A query keyed
		// on `null` would be a statement asking nothing.
		expect(harness.order).not.toContain('read-roster');
		expect(auction?.bidControl.team).toBeNull();
	});

	it('ships the FACTS, never the derived figure (AD-7)', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')],
			freeAgents: [
				{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
			],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }]
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));
		const control = auction?.bidControl as Record<string, unknown>;

		expect(control['team']).toEqual({
			capSpace: 156_000_000,
			rosterCount: 9,
			leading: [],
			eligibleLeading: [],
			minorLeagueOccupied: 0
		});
		// Story 2.8's derived figures are absent for the same reason the 2.6
		// ones are: a transported figure the surface could compare against
		// would BE the check (AD-7).
		expect(control['minorsExposure']).toBeUndefined();
		expect(control['overflowCount']).toBeUndefined();
		expect(control['freeMinorLeagueSlots']).toBeUndefined();
		// A derived money figure cached client-side for validation is exactly
		// what AD-7 forbids, and the surface is a client.
		expect(control['maximumBid']).toBeUndefined();
		expect(control['committedBids']).toBeUndefined();
		expect(control['rosterReserve']).toBeUndefined();
	});

	it('stamps when the figures were computed, for the arithmetic caption', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')],
			freeAgents: [
				{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
			],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }]
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(Number.isNaN(Date.parse(String(auction?.bidControl.figuresAt)))).toBe(false);
	});

	it('disables the control on the board when no legal Bid is affordable', async () => {
		// EXPERIENCE.md: the state is reachable straight from import, so it
		// must be visible on arrival rather than discovered at submission. A
		// Team whose Maximum Bid is below the minimum legal Bid has no amount
		// it could type, so the FIELD goes too, not only the submit.
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')],
			freeAgents: [
				{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
			],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }],
			// Eleven $15.0M contracts leave $0 of Cap Space against a $165.0M
			// cap, and the twelfth hole holds $1.0M of Roster Reserve back.
			roster: Array.from({ length: 11 }, () => ({
				cap_hit: '15000000',
				roster_slot_kind: 'active_bench'
			}))
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.bidControl.available).toBe(false);
		// Worded by the core, and it names the figure rather than saying "no".
		expect(auction?.bidControl.detail).toContain('Maximum Bid');
		expect(auction?.bidControl.detail).toContain('exceeds');
	});

	it('disables the control on the board for a Team at Roster Capacity (Story 2.7)', async () => {
		// The matrix's "announced on the board, not at submission", and a
		// state reachable straight from import: twelve $1.0M contracts leave
		// $153.0M of Cap Space, so nothing about the money is marginal and the
		// only possible reason is the roster.
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')],
			freeAgents: [
				{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
			],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }],
			roster: Array.from({ length: 12 }, () => ({
				cap_hit: '1000000',
				roster_slot_kind: 'active_bench'
			}))
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.bidControl.available).toBe(false);
		// Worded by the core, with the capacity arithmetic and no cap figure.
		expect(auction?.bidControl.detail).toContain('no roster slot');
		expect(auction?.bidControl.detail).toContain('Roster Capacity of 12');
		expect(auction?.bidControl.detail).not.toContain('Maximum Bid');
		// And the FACTS are shipped, not a derived verdict: the surface
		// re-derives the same gate on every keystroke (AD-7, AD-9).
		expect(auction?.bidControl.team?.rosterCount).toBe(12);
	});

	it('still offers the control when the money is there', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')],
			freeAgents: [
				{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
			],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }]
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.bidControl.available).toBe(true);
	});
});

// --- Story 3.1: one database clock, two consumers -------------------------

describe('loadAuctionPage — the clock the expiry gate is decided against (Story 3.1)', () => {
	it('reads the DATABASE clock exactly once, with no lock', async () => {
		const harness = contestedAuction();

		await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

		// Exactly one, and no `pg_advisory_xact_lock` anywhere: the read path
		// deliberately takes no lock, and `now()` needs none — it is
		// Postgres' transaction-start timestamp.
		expect(harness.order.filter((statement) => statement === 'read-clock')).toHaveLength(1);
		expect(harness.order).not.toContain('lock');
	});

	it('uses that ONE instant for both the caption and the gate', async () => {
		const harness = contestedAuction();

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		// The caption's instant IS the database's, not Node's.
		expect(auction?.bidControl.figuresAt).toBe(harness.now.toISOString());
		// And it is the instant the gate was evaluated at. A caption and a
		// gate describing two different moments is precisely what one read
		// makes unreachable — the disabled control and the figures above it
		// are one evaluation.
		const gates = evaluate(
			bidStateFor(
				{
					fantraxPlayerId: 'p-1',
					contention: 'standard',
					leadingBid: {
						seq: '3',
						teamId: 't-2',
						teamName: 'Rockets',
						managerId: 'm-2',
						amount: parseMoney(8_500_000),
						occurredAt: '2026-08-26T12:00:00.000Z',
						closesAt: '2026-08-27T12:00:00.000Z',
						seedHash: null
					},
					closesAt: '2026-08-27T12:00:00.000Z',
					bids: [],
					contenders: [],
					seedHash: null,
					seed: null
				},
				null,
				'Auction'
			),
			{
				kind: 'PlaceBid',
				fantraxPlayerId: 'p-1',
				teamId: VIEWER_TEAM,
				teamName: '',
				managerId: '',
				amount: parseMoney(9_000_000)
			},
			String(auction?.bidControl.figuresAt)
		);
		expect(gates.expiry.evaluatedAt).toBe(auction?.bidControl.figuresAt);
		expect(gates.expiry.passed).toBe(true);
	});

	it('disables the control on the board once the Auction Clock has run out', async () => {
		// The sweep has NOT run: no `AuctionClosed` is in the log, so the
		// nomination fold still holds the Player and the Auction fold still
		// holds its price. The close instant is nonetheless past, and that is
		// the only authority (AD-12).
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1', NOMINATED_AT),
				bidPlaced(
					2,
					'p-1',
					't-1',
					'Lakers',
					'm-1',
					8_000_000,
					'2026-08-26T09:00:00.000Z',
					'2026-08-27T09:00:00.000Z'
				)
			],
			freeAgents: [],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }],
			now: '2026-08-27T11:00:00.000Z'
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.bidControl.available).toBe(false);
		// The core's sentence, and no other ground: the money and the roster
		// are both fine here.
		expect(auction?.bidControl.detail).toContain(AUCTION_EXPIRED);
		expect(auction?.bidControl.detail).not.toContain('Maximum Bid');
		// The Auction is still open as far as the folds are concerned — the
		// page renders, the price stands and the close instant is shipped.
		expect(auction?.price).toBe('$8.0M');
		expect(auction?.closesAt).toBe('2026-08-27T09:00:00.000Z');
	});

	it('leaves the control live for the same Auction one millisecond earlier', async () => {
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1', NOMINATED_AT),
				bidPlaced(
					2,
					'p-1',
					't-1',
					'Lakers',
					'm-1',
					8_000_000,
					'2026-08-26T09:00:00.000Z',
					'2026-08-27T09:00:00.000Z'
				)
			],
			freeAgents: [],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }],
			now: '2026-08-27T08:59:59.999Z'
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.bidControl.available).toBe(true);
		expect(auction?.bidControl.detail).toBe(BID_READY);
	});

	it('serialises no derived expired flag and no remaining duration', async () => {
		// The counterpart of the AD-7 money check above, applied to a clock.
		// What crosses the wire is the absolute close instant and the
		// server's instant; expiry is DERIVED from those two by the core, in
		// the browser and inside the lock alike, on every tick. A transported
		// verdict would be the check (AD-9), and "seconds remaining" is the
		// shape AD-3 forbids outright.
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1', NOMINATED_AT),
				bidPlaced(
					2,
					'p-1',
					't-1',
					'Lakers',
					'm-1',
					8_000_000,
					'2026-08-26T09:00:00.000Z',
					'2026-08-27T09:00:00.000Z'
				)
			],
			freeAgents: [],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }],
			now: '2026-08-27T11:00:00.000Z'
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		// Checked as KEYS rather than as raw text, because the core's own
		// refusal sentence legitimately contains the word "expired" — it is
		// the wording a Manager reads, not a flag a client could compare
		// against. What may never appear is a FIELD carrying the verdict.
		const keys = (value: unknown): string[] =>
			typeof value !== 'object' || value === null
				? []
				: Object.entries(value).flatMap(([key, child]) => [key, ...keys(child)]);
		const shipped = keys(auction);
		for (const forbidden of [
			'expired',
			'hasExpired',
			'remainingMs',
			'remaining',
			'secondsLeft',
			'closesIn',
			'timeLeft'
		]) {
			expect(shipped, `${forbidden} leaked onto the wire`).not.toContain(forbidden);
		}
		// The two facts that DO cross, and nothing derived from them.
		expect(auction?.closesAt).toBe('2026-08-27T09:00:00.000Z');
		expect(auction?.bidControl.figuresAt).toBe('2026-08-27T11:00:00.000Z');
	});
});

describe('loadAuctionPage — an unusable database clock (Story 3.1)', () => {
	/** The one message both clock readers state, shared from `shell/write.ts`. */
	const CLOCK_ERROR = 'the database clock read returned no usable "now" value';

	const withClock = (clock: QueryResultRow[]) =>
		fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1', NOMINATED_AT)],
			freeAgents: [],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }],
			clock
		});

	it('throws the stated error when the clock read returns no row at all', async () => {
		const harness = withClock([]);
		await expect(loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM)).rejects.toThrow(
			CLOCK_ERROR
		);
	});

	it('throws the stated error when the column is absent or not a Date', async () => {
		for (const clock of [[{}], [{ now: '2026-08-26T13:00:00.000Z' }], [{ now: null }]]) {
			const harness = withClock(clock);
			await expect(loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM)).rejects.toThrow(
				CLOCK_ERROR
			);
		}
	});

	it('throws the stated error — not a bare RangeError — on an INVALID Date', async () => {
		// `instanceof Date` alone passes `new Date('nonsense')`, and
		// `.toISOString()` on one throws `RangeError: Invalid time value`.
		// A driver handing back an unparseable timestamp is the same class of
		// failure as one handing back nothing, and must arrive as the same
		// message rather than as a stack trace from a formatter.
		const harness = withClock([{ now: new Date('nonsense') }]);
		const failure = await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM).catch(
			(error: unknown) => error
		);
		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(RangeError);
		expect((failure as Error).message).toBe(CLOCK_ERROR);
	});

	it('rolls back and releases the connection when the clock is unusable', async () => {
		// The `catch` in `loadAuctionPage` owns this: a throw between `begin`
		// and `rollback` must not leave a transaction open on a pooled client.
		const harness = withClock([{}]);
		await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM).catch(() => undefined);

		expect(harness.order).toContain('rollback');
		expect(harness.state.committed).toBe(false);
		expect(harness.state.released).toBe(1);
	});

	it('states the SAME message the locked write path states', async () => {
		// The validation is shared (`requireDatabaseClock`); only the query
		// differs, because `shell/write.ts` must read the clock in the same
		// round trip as the lock and this module takes no lock at all.
		const source = readFileSync(
			fileURLToPath(new URL('../../src/lib/server/auction-page.ts', import.meta.url)),
			'utf8'
		);
		expect(source).toContain('requireDatabaseClock(');
		// The message is not restated here — it is imported with the check.
		expect(source).not.toContain(CLOCK_ERROR);
	});
});

// --- Story 3.2: the Minimum-Bid Contention on the wire ---------------------

/**
 * A live lottery: opened by the Lakers at exactly $1,000,000 at 09:00 Monday,
 * joined by the Rockets at 14:00 and by the Bulls at 20:00.
 *
 * Every join carries the OPENING's close instant on its own payload, which is
 * what `decide()` stamps — so this fixture is the log a real contention
 * produces rather than a shape assembled to make an assertion pass.
 */
function lotteryAuction() {
	// The fake's database clock reads 13:00 on the 26th, so the contention
	// opened that morning and closes the following one — live, not expired.
	const opened = '2026-08-26T09:00:00.000Z';
	const closes = '2026-08-27T09:00:00.000Z';
	return fakeGateway({
		events: [
			nominated(1, 'p-1', 'Jalen Green', 't-9', 'Celtics', 'm-9', NOMINATED_AT),
			{
				...bidPlaced(2, 'p-1', 't-1', 'Lakers', 'm-1', 1_000_000, opened, closes),
				// The published commitment rides the OPENING Bid and nothing
				// else. The seed behind it is in `auction_contention_seeds`,
				// which this read path holds no privilege on and never asks.
				payload: {
					fantraxPlayerId: 'p-1',
					teamId: 't-1',
					teamName: 'Lakers',
					managerId: 'm-1',
					amount: 1_000_000,
					closesAt: closes,
					seedHash: 'a'.repeat(64)
				}
			},
			bidPlaced(3, 'p-1', 't-2', 'Rockets', 'm-2', 1_000_000, '2026-08-26T10:00:00.000Z', closes),
			bidPlaced(4, 'p-1', 't-3', 'Bulls', 'm-3', 1_000_000, '2026-08-26T12:00:00.000Z', closes)
		],
		freeAgents: [
			{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
		],
		managers: [
			{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' },
			{ id: 'm-2', teamId: 't-2', displayName: 'Sam' },
			{ id: 'm-3', teamId: 't-3', displayName: 'Alex' }
		]
	});
}

describe('loadAuctionPage — a Minimum-Bid Contention (Story 3.2, AC7)', () => {
	it('serialises the Contender list by NAME, in join order, with its count', async () => {
		const harness = lotteryAuction();

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.contention).toBe('Minimum-Bid Contention.');
		// Ascending join `seq` (AD-14) — the fold's order, never re-sorted.
		expect(auction?.contenders).toEqual(['Lakers', 'Rockets', 'Bulls']);
		expect(auction?.contenderCount).toBe(3);
	});

	it('serialises the published commitment and nothing else about the seed', async () => {
		const harness = lotteryAuction();

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.seedHash).toBe('a'.repeat(64));
		// The read path issues no statement against the seed table at all —
		// it holds no privilege on it, and the value it needs is on the log.
		expect(harness.order).not.toContain('read-seeds');
	});

	it('serialises the contention FACTS the gates decide from, and no derived flag', async () => {
		const harness = lotteryAuction();

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		// The fold's own state literal, and the Contender Teams by id.
		expect(auction?.bidControl.contention).toBe('minimum_bid');
		expect(auction?.bidControl.contenderTeamIds).toEqual(['t-1', 't-2', 't-3']);
		// **No derived flag crosses this wire.** `isLottery` and
		// `youAreContending` are each one comparison away from the facts
		// beside them, and a transported boolean is a derivation the browser
		// would trust instead of making (AD-7, AD-9).
		const wire = JSON.stringify(auction);
		expect(wire).not.toContain('isLottery');
		expect(wire).not.toContain('youAreContending');
		expect(wire).not.toContain('contending');
	});

	it('pre-fills the join amount, not a raise over it', async () => {
		const harness = lotteryAuction();

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.bidControl.minimumLegal).toBe(1_000_000);
		expect(auction?.bidControl.minimumLegalSentence).toBe(
			'Whole dollars. The least this Auction will take is $1.0M.'
		);
		// A Team that has not joined can join, so the control is available.
		expect(auction?.bidControl.available).toBe(true);
	});

	it('pre-fills the CONVERSION amount for a Team already a Contender (Story 3.3)', async () => {
		const harness = lotteryAuction();

		// `t-2` joined at 10:00. Joining again is refused by name, so the
		// only amount left to them is the one that dissolves the contention —
		// and the pre-fill follows the gates rather than being adjusted to
		// match them. Story 3.2 disabled the control here, because there was
		// no legal amount at all for a Team already in.
		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', 't-2'));

		expect(auction?.bidControl.minimumLegal).toBe(1_500_000);
		expect(auction?.bidControl.available).toBe(true);
		expect(auction?.bidControl.detail).not.toContain('already a Contender');
		// The Contender list still renders for them: the lottery is a fact
		// about the Auction, not about who is looking at it.
		expect(auction?.contenders).toEqual(['Lakers', 'Rockets', 'Bulls']);
	});

	it('still refuses a SECOND JOIN from that Team, typed rather than pre-filled', async () => {
		// The pre-fill moved; the rule did not. `bidControlState` is the same
		// function the surface calls on every keystroke, and $1,000,000 from
		// a Team already in is still `already_contending`.
		const harness = lotteryAuction();
		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', 't-2'));
		const control = auction?.bidControl;
		if (control === undefined) throw new Error('no bid control');

		const typed = bidControlState({
			state: {
				// The ninth gate's one input (Story 3.7). The log this fake serves
				// opened the auction, so the phase folded to Auction — rebuilt here
				// exactly as the surface rebuilds every other field of this state.
				phase: 'Auction',
				leadingBid:
					control.leadingAmount === null || control.leadingTeamId === null
						? null
						: { teamId: control.leadingTeamId, amount: parseMoney(control.leadingAmount) },
				closesAt: auction?.closesAt ?? null,
				contention: control.contention,
				seedHash: auction?.seedHash ?? null,
				contenders: control.contenderTeamIds,
				team: null,
				// Always `false`, and no longer off the wire: an Auction win lands
				// in Active/Bench whatever the Player's eligibility.
				playerIsMinorLeagueEligible: false
			},
			fantraxPlayerId: 'p-1',
			viewerTeamId: 't-2',
			amountText: '1',
			confirmed: true,
			now: control.figuresAt
		});

		expect(typed.blocked).toBe(true);
		expect(typed.detail).toContain('already a Contender');
	});

	it('renders the whole lottery for a viewer bound to NO Team', async () => {
		const harness = lotteryAuction();

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', null));

		// Accent bar, icon, word, count and list are all facts about the
		// Auction, so they are here for every viewer.
		expect(auction?.contention).toBe('Minimum-Bid Contention.');
		expect(auction?.contenders).toEqual(['Lakers', 'Rockets', 'Bulls']);
		expect(auction?.contenderCount).toBe(3);
		expect(auction?.seedHash).toBe('a'.repeat(64));
		expect(auction?.bidControl.contention).toBe('minimum_bid');
		// ...and the CONTROL is refused, on the standing condition it always
		// was: no Team means no event to append (AD-4).
		expect(auction?.bidControl.available).toBe(false);
		expect(auction?.bidControl.detail).toContain('not bound to a Team');
	});

	it('reports the close as the OPENING’s, unmoved by three joins', async () => {
		const harness = lotteryAuction();

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.closesAt).toBe('2026-08-27T09:00:00.000Z');
		// The lead never moved either: a join is never strictly higher.
		expect(auction?.leadingBidder).toBe('Lakers — Meakel');
		expect(auction?.price).toBe('$1.0M');
	});

	it('carries an empty Contender list and a null commitment outside a lottery', async () => {
		const harness = contestedAuction();

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.contention).toBe('Standard Contention.');
		expect(auction?.contenders).toEqual([]);
		expect(auction?.contenderCount).toBe(0);
		expect(auction?.seedHash).toBeNull();
		expect(auction?.seed).toBeNull();
		expect(auction?.bidControl.contention).toBe('standard');
		expect(auction?.bidControl.contenderTeamIds).toEqual([]);
	});

	it('reports no reveal at all while the contention is still LIVE', async () => {
		// The seed is sealed in a table this read path holds no privilege on
		// and never queries. Until a dissolution puts it in the log, there is
		// nothing to serialise.
		const harness = lotteryAuction();

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.seedHash).toBe('a'.repeat(64));
		expect(auction?.seed).toBeNull();
	});
});

// --- Story 3.3: the dissolved contention on the wire (AC5) -----------------

/** The same lottery, converted by Team I at $1,500,000 and dissolved. */
function dissolvedAuction() {
	const opened = '2026-08-26T09:00:00.000Z';
	const closes = '2026-08-27T09:00:00.000Z';
	const convertedAt = '2026-08-26T12:30:00.000Z';
	const resetClose = '2026-08-27T12:30:00.000Z';
	return fakeGateway({
		events: [
			nominated(1, 'p-1', 'Jalen Green', 't-9', 'Celtics', 'm-9', NOMINATED_AT),
			{
				...bidPlaced(2, 'p-1', 't-1', 'Lakers', 'm-1', 1_000_000, opened, closes),
				payload: {
					fantraxPlayerId: 'p-1',
					teamId: 't-1',
					teamName: 'Lakers',
					managerId: 'm-1',
					amount: 1_000_000,
					closesAt: closes,
					seedHash: 'a'.repeat(64)
				}
			},
			bidPlaced(3, 'p-1', 't-2', 'Rockets', 'm-2', 1_000_000, '2026-08-26T10:00:00.000Z', closes),
			// The converting Bid: strictly higher, so it takes the lead and
			// the fold reads `standard` off its amount.
			bidPlaced(4, 'p-1', 't-3', 'Bulls', 'm-3', 1_500_000, convertedAt, resetClose),
			logEvent(
				5,
				CONTENTION_DISSOLVED_EVENT,
				{
					fantraxPlayerId: 'p-1',
					seed: 'the-revealed-seed',
					seedHash: 'a'.repeat(64),
					formerContenders: ['t-1', 't-2'],
					convertingTeamId: 't-3',
					amount: 1_500_000
				},
				convertedAt,
				{ managerId: 'm-3', teamId: 't-3' }
			)
		],
		freeAgents: [
			{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
		],
		managers: [
			{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' },
			{ id: 'm-2', teamId: 't-2', displayName: 'Sam' },
			{ id: 'm-3', teamId: 't-3', displayName: 'Alex' }
		]
	});
}

describe('loadAuctionPage — a dissolved Minimum-Bid Contention (Story 3.3)', () => {
	it('serialises the revealed seed beside the commitment it answers', async () => {
		const auction = openPage(await loadAuctionPage(dissolvedAuction().gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.seed).toBe('the-revealed-seed');
		expect(auction?.seedHash).toBe('a'.repeat(64));
		// The state, the lead and the clock are the converting Bid's own
		// arithmetic — the reveal wrote none of them.
		expect(auction?.contention).toBe('Standard Contention.');
		expect(auction?.leadingBidder).toBe('Bulls — Alex');
		expect(auction?.price).toBe('$1.5M');
		expect(auction?.closesAt).toBe('2026-08-27T12:30:00.000Z');
	});

	it('keeps the former Contenders on the wire, in join order', async () => {
		// "The Contender list is discarded" is about commitment and the draw.
		// The page names the Teams that were released beside the seed that
		// will now never be drawn from.
		const auction = openPage(await loadAuctionPage(dissolvedAuction().gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.contenders).toEqual(['Lakers', 'Rockets']);
		expect(auction?.contenderCount).toBe(2);
	});

	it('renders the whole thing for a viewer bound to NO Team', async () => {
		// A dissolution is a fact about the Auction, not about who is looking
		// at it. The control is the only thing their session changes.
		const auction = openPage(await loadAuctionPage(dissolvedAuction().gateway, 'p-1', null));

		expect(auction?.seed).toBe('the-revealed-seed');
		expect(auction?.seedHash).toBe('a'.repeat(64));
		expect(auction?.contenders).toEqual(['Lakers', 'Rockets']);
		expect(auction?.bidControl.available).toBe(false);
		// The ACTUAL unbound refusal, from the core's own wording — not a
		// substring almost any sentence in the panel's vocabulary satisfies.
		expect(auction?.bidControl.detail).toBe(bidRefusalDetail({ kind: 'unbound_actor' }));
	});

	it('pre-fills one Minimum Increment over the converting amount', async () => {
		// Ordinary ascending rules from here: $1.5M + $0.5M. A former
		// Contender gets the identical figure — there is no lottery left for
		// them to be already in.
		for (const viewer of [VIEWER_TEAM, 't-1', 't-2']) {
			const auction = openPage(await loadAuctionPage(dissolvedAuction().gateway, 'p-1', viewer));
			expect(auction?.bidControl.minimumLegal, viewer).toBe(2_000_000);
			expect(auction?.bidControl.contention, viewer).toBe('standard');
			expect(auction?.bidControl.contenderTeamIds, viewer).toEqual(['t-1', 't-2']);
		}
	});
});

/**
 * The Auction Contracts fold, on the READ path (Story 3.4).
 *
 * The page derives Cap Space, Roster Count and Minor League occupancy through
 * the identical `loadTeamRoster` the locked transaction uses, so a Team that
 * has just won a Player sees the figures its next Bid will actually be judged
 * against — AD-9's "the render is never the check" holds only while the two
 * are the SAME derivation.
 */
describe('loadAuctionPage — a won Player is in the viewer’s figures (AC4)', () => {
	const won = (
		seq: number,
		fantraxPlayerId: string,
		teamId: string,
		winningAmount: number,
		capHit: number,
		placement: 'active_bench' | 'minor_league'
	) =>
		logEvent(
			seq,
			AUCTION_CLOSED_EVENT,
			{
				fantraxPlayerId,
				playerName: fantraxPlayerId,
				teamId,
				teamName: teamId,
				managerId: 'm-w',
				winningAmount,
				capHit,
				placement,
				contention: 'standard',
				contractYears: null,
				closedAt: '2026-08-26T09:00:00.000Z'
			},
			'2026-08-26T09:00:00.000Z',
			{ managerId: 'm-w', teamId }
		);

	it('charges an Active/Bench win against Cap Space and Roster Count', async () => {
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1'),
				won(2, 'p-won', VIEWER_TEAM, 8_000_000, 8_000_000, 'active_bench')
			],
			freeAgents: [
				{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
			],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }]
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		// The nine imported $1.0M contracts plus the $8.0M win.
		expect(auction?.bidControl.team?.capSpace).toBe(156_000_000 - 8_000_000);
		expect(auction?.bidControl.team?.rosterCount).toBe(10);
		expect(auction?.bidControl.team?.minorLeagueOccupied).toBe(0);
		// Still ONE roster statement: a contract is a fold, not a second read.
		expect(harness.order.filter((step) => step === 'read-roster')).toHaveLength(1);
	});

	it('occupies a Minor League Slot at a $0 Cap Hit and leaves Roster Count alone (AD-23)', async () => {
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1'),
				won(2, 'p-stash', VIEWER_TEAM, 4_000_000, 0, 'minor_league')
			],
			freeAgents: [
				{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
			],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }]
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.bidControl.team?.capSpace).toBe(156_000_000);
		expect(auction?.bidControl.team?.rosterCount).toBe(9);
		expect(auction?.bidControl.team?.minorLeagueOccupied).toBe(1);
	});

	it('ignores another Team’s contracts', async () => {
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1'),
				won(2, 'p-won', 't-other', 30_000_000, 30_000_000, 'active_bench')
			],
			freeAgents: [
				{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
			],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }]
		});

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.bidControl.team?.capSpace).toBe(156_000_000);
		expect(auction?.bidControl.team?.rosterCount).toBe(9);
	});
});

describe('loadAuctionPage — a cancelled Bid carries its cause to the wire (Story 10.6)', () => {
	/**
	 * The cascade took Team 1's $8.0M Bid back because Team 1 won a DIFFERENT
	 * Player, and seated Team 2 beneath it. The page needs two facts and only
	 * two: what the causing win was called, and whether anybody now leads.
	 */
	function cancelledAuction(restoration: Record<string, unknown> | null) {
		return fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1', NOMINATED_AT),
				bidPlaced(
					2,
					'p-1',
					't-2',
					'Rockets',
					'm-2',
					8_000_000,
					'2026-08-26T09:00:00.000Z',
					'2026-08-27T09:00:00.000Z'
				),
				bidPlaced(
					3,
					'p-1',
					't-1',
					'Lakers',
					'm-1',
					8_500_000,
					'2026-08-26T12:00:00.000Z',
					'2026-08-27T12:00:00.000Z'
				),
				bidCancelled(4, 'p-1', '3', 't-1', 'p-9', 'Stephen Curry', restoration)
			],
			freeAgents: [
				{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', positions: 'SG', nbaTeam: 'HOU' }
			],
			managers: [
				{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' },
				{ id: 'm-2', teamId: 't-2', displayName: 'Sam' }
			]
		});
	}

	const SURVIVOR = {
		seq: '2',
		teamId: 't-2',
		teamName: 'Rockets',
		managerId: 'm-2',
		amount: 8_000_000
	};

	it('names the causing PLAYER and reports a survivor, on the cancelled Bid alone', async () => {
		const harness = cancelledAuction(SURVIVOR);

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		// The cancelled Bid — the causing Player by NAME, not by id, and a
		// successor was seated.
		expect(auction?.bids.find((bid) => bid.seq === '3')?.cancellation).toEqual({
			causePlayerName: 'Stephen Curry',
			restored: true
		});
		// The Bid the cascade seated is untouched: a restoration is not a
		// cancellation, and nothing marks it.
		expect(auction?.bids.find((bid) => bid.seq === '2')?.cancellation).toBeNull();
		// Still both Bids, in log order. Nothing is filtered, hidden or moved.
		expect(auction?.bids.map((bid) => bid.seq)).toEqual(['2', '3']);
	});

	it('reports no survivor when nothing was restored — the other sentence entirely', async () => {
		const harness = cancelledAuction(null);

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		expect(auction?.bids.find((bid) => bid.seq === '3')?.cancellation).toEqual({
			causePlayerName: 'Stephen Curry',
			restored: false
		});
	});

	it('carries the cause NAME rather than the cause id — they are different strings', async () => {
		const harness = cancelledAuction(SURVIVOR);

		const auction = openPage(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM));

		const cancellation = auction?.bids.find((bid) => bid.seq === '3')?.cancellation ?? null;
		// `causeFantraxPlayerId` is `p-9` and the name is `Stephen Curry`. A
		// mapping that reached for the wrong field would render an id into the
		// history sentence, and both fields are on the payload to reach for.
		expect(cancellation?.causePlayerName).toBe('Stephen Curry');
		expect(cancellation?.causePlayerName).not.toBe('p-9');
	});
});
