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

import { BID_PLACED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import { AUCTION_CLOSED_EVENT, NOMINATION_PLACED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { BID_READY, bidRefusalDetail } from '../../src/lib/core/rules/bidding.ts';
import { loadAuctionPage } from '../../src/lib/server/auction-page.ts';
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

function fakeGateway(options: {
	events?: QueryResultRow[];
	freeAgents?: FreeAgentRow[];
	managers?: ManagerRow[];
	/** Team ids that exist in `teams`. Defaults to "every Team the events name". */
	teams?: string[];
}) {
	const order: string[] = [];
	let committed = false;
	let rolledBack = false;
	let released = 0;

	const events = options.events ?? [];
	const freeAgents = options.freeAgents ?? [];
	const managers = options.managers ?? [];
	// The nominating Team exists unless a test says otherwise — the join's
	// driving table, so "no such Team" has to be expressible too.
	const teams =
		options.teams ??
		events.map((row) => String((row['payload'] as Record<string, unknown>)?.['teamId'] ?? ''));

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, params: readonly unknown[] = []) {
			const sql = text.trim();
			if (/^begin/i.test(sql)) {
				order.push('begin');
				return { rows: [] };
			}
			if (/^select \* from auction_events/i.test(sql)) {
				order.push('read-log');
				return { rows: events };
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
			if (/^select m\.id::text as id, m\.team_id::text as team_id, m\.display_name/i.test(sql)) {
				order.push('read-bidders');
				const wanted = (params[0] ?? []) as readonly string[];
				return {
					rows: managers
						.filter((row) => wanted.includes(row.id))
						.map((row) => ({ id: row.id, team_id: row.teamId, display_name: row.displayName }))
				};
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

		const auction = await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

		expect(auction).toEqual({
			fantraxPlayerId: 'p-1',
			playerName: 'Jalen Green',
			metadata: { positions: 'SG', nbaTeam: 'HOU' },
			nominatingTeam: 'Lakers — Meakel',
			nominatedAt: '2026-08-25T19:00:00.000Z',
			// Story 2.5's half: nominated, nobody has bid. "No bids yet" is a
			// state of the Auction, never "there is no Auction".
			contention: 'Awaiting an Opening Bid.',
			price: null,
			leadingBidder: null,
			closesAt: null,
			bids: [],
			bidControl: {
				available: true,
				detail: BID_READY,
				// $1,000,000 is refused outright (it would open a lottery) and
				// the grid is $500,000, so the smallest legal opening is $1.5M.
				minimumLegal: 1_500_000,
				minimumLegalSentence: 'Whole dollars. The least this Auction will take is $1.5M.',
				// The two facts every gate decides from, serialised so the
				// surface can ask the same question about a TYPED amount.
				leadingAmount: null,
				leadingTeamId: null,
				viewerTeamId: VIEWER_TEAM
			}
		});
	});

	it('omits the metadata line entirely, without throwing, when the reference row is missing', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')],
			freeAgents: [],
			managers: [{ id: 'm-1', teamId: 't-1', displayName: 'Meakel' }]
		});

		const auction = await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

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

		const auction = await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

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

		const auction = await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

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

		const auction = await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

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

		const auction = await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

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
		expect(harness.order).toEqual(['begin', 'read-log', 'read-reference', 'read-manager', 'rollback']);
	});
});

// --- The 404 cases --------------------------------------------------------

describe('loadAuctionPage — no open nomination', () => {
	it('returns null for a Player never nominated — AC4', async () => {
		const harness = fakeGateway({ events: [] });
		const auction = await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);
		expect(auction).toBeNull();
	});

	it('returns null for an unknown Player id matching nothing anywhere', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')]
		});
		const auction = await loadAuctionPage(harness.gateway, 'p-does-not-exist', VIEWER_TEAM);
		expect(auction).toBeNull();
	});

	// Matrix row "Closed / never nominated", the close half. Story 2.3 shipped
	// the release fold (`nominations.ts:260-276`) and no producer, so a close is
	// only ever synthetic until Story 3.4 — which is exactly how 2.3 proved it.
	// Without this the row is covered on its never-nominated half only, and the
	// page would keep rendering a Player whose Auction is over.
	it('returns null once the Auction has closed, through the Story 2.3 release fold', async () => {
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1'),
				logEvent(2, AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'p-1' })
			]
		});
		const auction = await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);
		expect(auction).toBeNull();
	});

	it('still renders a different Player whose Auction is still open', async () => {
		const harness = fakeGateway({
			events: [
				nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1'),
				nominated(2, 'p-2', 'Alperen Sengun', 't-2', 'Rockets', 'm-2'),
				logEvent(3, AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'p-1' })
			]
		});
		expect(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM)).toBeNull();
		expect(await loadAuctionPage(harness.gateway, 'p-2', VIEWER_TEAM)).not.toBeNull();
	});

	it('rolls back rather than commits on a null read', async () => {
		const harness = fakeGateway({ events: [] });
		await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);
		expect(harness.state.committed).toBe(false);
		expect(harness.state.rolledBack).toBe(true);
		expect(harness.state.released).toBe(1);
		// No reference or manager lookup runs when there is nothing to look up.
		expect(harness.order).toEqual(['begin', 'read-log', 'rollback']);
	});
});

// --- Story 2.5: the Bids, the price, the clock and the control ------------

const NOMINATED_AT = '2026-08-25T19:00:00.000Z';

/** An Auction with two raises: $8.0M by the Lakers, $8.5M by the Rockets. */
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

		const auction = await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

		expect(auction?.price).toBe('$8.5M');
		expect(auction?.leadingBidder).toBe('Rockets — Sam');
		expect(auction?.contention).toBe('Standard Contention.');
		// The absolute close instant, straight off the leading Bid's payload —
		// never a duration, never "seconds remaining" (AD-3).
		expect(auction?.closesAt).toBe('2026-08-27T12:00:00.000Z');
	});

	it('renders every Bid in chronological order, each naming the acting Manager', async () => {
		const harness = contestedAuction();

		const auction = await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

		expect(auction?.bids).toEqual([
			{
				seq: '2',
				bidder: 'Lakers — Meakel',
				amount: '$8.0M',
				occurredAt: '2026-08-26T09:00:00.000Z'
			},
			{
				seq: '3',
				bidder: 'Rockets — Sam',
				amount: '$8.5M',
				occurredAt: '2026-08-26T12:00:00.000Z'
			}
		]);
	});

	it('resolves every bidding Manager in ONE further statement, never one per Bid', async () => {
		const harness = contestedAuction();

		await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

		expect(harness.order).toEqual([
			'begin',
			'read-log',
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

		const auction = await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

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

		const auction = await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

		expect(auction?.leadingBidder).toBe('Rockets');
	});

	it('drops the Auction, price and all, once a close is folded', async () => {
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
				logEvent(3, AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'p-1' })
			]
		});

		expect(await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM)).toBeNull();
	});
});

describe('loadAuctionPage — the bid control is evaluate() on the read path (AC7)', () => {
	it('pre-fills the minimum legal raise: the current high plus $500,000', async () => {
		const harness = contestedAuction();

		const auction = await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

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
		const auction = await loadAuctionPage(harness.gateway, 'p-1', 't-2');

		expect(auction?.bidControl.available).toBe(false);
		expect(auction?.bidControl.detail).toContain('does not bid against itself');
		// Which gate refused is asserted where it is decided —
		// `tests/core/bidding.test.ts` on `bidControlState` — rather than
		// shipped to a client that renders no per-gate chip until Story 2.6.
		expect(auction?.bidControl.detail).toBe(
			bidRefusalDetail({
				kind: 'gates',
				gates: {
					opening: {
						passed: true,
						opening: 'not_an_opening',
						offered: 9_000_000 as never,
						minimumOpening: 1_000_000 as never
					},
					selfBid: { passed: false, actingTeamId: 't-2', leadingTeamId: 't-2' },
					increment: {
						passed: true,
						offered: 9_000_000 as never,
						currentHigh: 8_500_000 as never,
						minimumLegal: 9_000_000 as never
					},
					granularity: { passed: true, offered: 9_000_000 as never, grid: 500_000 as never }
				}
			})
		);
	});

	it('ships the two gate facts, so the surface can re-evaluate a TYPED amount', async () => {
		const harness = contestedAuction();

		const auction = await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

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

		const auction = await loadAuctionPage(harness.gateway, 'p-1', VIEWER_TEAM);

		expect(auction?.bidControl.minimumLegal).toBe(7_250_000);
		expect(auction?.bidControl.minimumLegalSentence).toBeNull();
		// The fold kept the historical amount exactly as it was recorded.
		expect(auction?.bidControl.leadingAmount).toBe(6_750_000);
	});

	it('disables the control for a Manager bound to no Team, with the unbound sentence', async () => {
		const harness = contestedAuction();

		const auction = await loadAuctionPage(harness.gateway, 'p-1', null);

		expect(auction?.bidControl.available).toBe(false);
		// No gate ran at all: an unbound actor has no Team for a command to
		// name, and `auction_events.team_id` is NOT NULL (AD-4).
		expect(auction?.bidControl.detail).toBe(bidRefusalDetail({ kind: 'unbound_actor' }));
	});

	it('names no money or capacity figure anywhere in what it returns — those are 2.6 and 2.7', async () => {
		const harness = contestedAuction();

		const auction = await loadAuctionPage(harness.gateway, 'p-1', 't-2');

		const rendered = JSON.stringify(auction);
		for (const forbidden of [
			'maximumBid',
			'committedBids',
			'minorsExposure',
			'rosterReserve',
			'Roster Count',
			'no money',
			'roster slot'
		]) {
			expect(rendered, `${forbidden} leaked into the Auction page read`).not.toContain(forbidden);
		}
	});
});
