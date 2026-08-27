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

import { AUCTION_CLOSED_EVENT, NOMINATION_PLACED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { loadAuctionPage } from '../../src/lib/server/auction-page.ts';
import type { ConnectionGateway, QueryResultRow, TransactionalClient } from '../../src/lib/shell/write.ts';

function logEvent(
	seq: number,
	type: string,
	payload: unknown,
	occurredAt = '2026-08-25T19:00:00.000Z'
): QueryResultRow {
	return {
		seq,
		occurred_at: new Date(occurredAt),
		schema_version: 1,
		core_version: 1,
		manager_id: 'm-0',
		team_id: 't-0',
		event_type: type,
		payload
	};
}

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
		occurredAt
	);
}

type FreeAgentRow = {
	fantraxPlayerId: string;
	positions: string;
	nbaTeam: string;
};

type ManagerRow = {
	id: string;
	displayName: string;
};

function fakeGateway(options: {
	events?: QueryResultRow[];
	freeAgents?: FreeAgentRow[];
	managers?: ManagerRow[];
}) {
	const order: string[] = [];
	let committed = false;
	let rolledBack = false;
	let released = 0;

	const events = options.events ?? [];
	const freeAgents = options.freeAgents ?? [];
	const managers = options.managers ?? [];

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
			if (/^select positions, nba_team\s+from free_agent_players/i.test(sql)) {
				order.push('read-reference');
				const found = freeAgents.find((row) => row.fantraxPlayerId === params[0]);
				return {
					rows:
						found === undefined
							? []
							: [{ positions: found.positions, nba_team: found.nbaTeam }]
				};
			}
			if (/^select display_name from managers/i.test(sql)) {
				order.push('read-manager');
				const found = managers.find((row) => row.id === params[0]);
				return { rows: found === undefined ? [] : [{ display_name: found.displayName }] };
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
			freeAgents: [{ fantraxPlayerId: 'p-1', positions: 'SG', nbaTeam: 'HOU' }],
			managers: [{ id: 'm-1', displayName: 'Meakel' }]
		});

		const auction = await loadAuctionPage(harness.gateway, 'p-1');

		expect(auction).toEqual({
			fantraxPlayerId: 'p-1',
			playerName: 'Jalen Green',
			metadata: { positions: 'SG', nbaTeam: 'HOU' },
			nominatingTeam: 'Lakers — Meakel',
			nominatedAt: '2026-08-25T19:00:00.000Z'
		});
	});

	it('omits the metadata line entirely, without throwing, when the reference row is missing', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')],
			freeAgents: [],
			managers: [{ id: 'm-1', displayName: 'Meakel' }]
		});

		const auction = await loadAuctionPage(harness.gateway, 'p-1');

		expect(auction?.playerName).toBe('Jalen Green');
		expect(auction?.metadata).toBeNull();
	});

	it('falls back to the Team name as the display name when the Manager row cannot be resolved', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-9')],
			freeAgents: [{ fantraxPlayerId: 'p-1', positions: 'SG', nbaTeam: 'HOU' }],
			managers: []
		});

		const auction = await loadAuctionPage(harness.gateway, 'p-1');

		// formatTeamManager still pairs the Team name with SOME display
		// name — the honest fallback is the Team's own name, not a blank.
		expect(auction?.nominatingTeam).toBe('Lakers — Lakers');
	});

	it('takes no advisory lock and always rolls back — rendering is never the check', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')],
			freeAgents: [{ fantraxPlayerId: 'p-1', positions: 'SG', nbaTeam: 'HOU' }],
			managers: [{ id: 'm-1', displayName: 'Meakel' }]
		});

		await loadAuctionPage(harness.gateway, 'p-1');

		expect(harness.order).not.toContain('lock');
		expect(harness.state.committed).toBe(false);
		expect(harness.state.rolledBack).toBe(true);
		expect(harness.state.released).toBe(1);
	});

	it('never reads open_nominations — this reader touches only the fold and the reference tables', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')],
			freeAgents: [{ fantraxPlayerId: 'p-1', positions: 'SG', nbaTeam: 'HOU' }],
			managers: [{ id: 'm-1', displayName: 'Meakel' }]
		});

		await loadAuctionPage(harness.gateway, 'p-1');

		// The fake throws on any statement it does not recognise, so a read
		// of open_nominations would have failed the harness outright; this
		// also states the order actually taken.
		expect(harness.order).toEqual(['begin', 'read-log', 'read-reference', 'read-manager', 'rollback']);
	});
});

// --- The 404 cases --------------------------------------------------------

describe('loadAuctionPage — no open nomination', () => {
	it('returns null for a Player never nominated — AC4', async () => {
		const harness = fakeGateway({ events: [] });
		const auction = await loadAuctionPage(harness.gateway, 'p-1');
		expect(auction).toBeNull();
	});

	it('returns null for an unknown Player id matching nothing anywhere', async () => {
		const harness = fakeGateway({
			events: [nominated(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', 'm-1')]
		});
		const auction = await loadAuctionPage(harness.gateway, 'p-does-not-exist');
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
		const auction = await loadAuctionPage(harness.gateway, 'p-1');
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
		expect(await loadAuctionPage(harness.gateway, 'p-1')).toBeNull();
		expect(await loadAuctionPage(harness.gateway, 'p-2')).not.toBeNull();
	});

	it('rolls back rather than commits on a null read', async () => {
		const harness = fakeGateway({ events: [] });
		await loadAuctionPage(harness.gateway, 'p-1');
		expect(harness.state.committed).toBe(false);
		expect(harness.state.rolledBack).toBe(true);
		expect(harness.state.released).toBe(1);
		// No reference or manager lookup runs when there is nothing to look up.
		expect(harness.order).toEqual(['begin', 'read-log', 'rollback']);
	});
});
