/**
 * `loadPositions` executed against a fake client (Story 4.4).
 *
 * Its own file rather than a section of `tests/routes/positions.test.ts`,
 * because that suite mocks `$lib/server/positions.ts` to prove the route's
 * guard ordering — an execution test living beside it would silently exercise
 * the stub and assert nothing. The transaction discipline is only provable by
 * running the real function.
 *
 * `fakeGateway` is `tests/server/board.test.ts`'s, widened by the one table
 * this read touches that the board's does not: `team_rosters`, which
 * `loadTeamRoster` reads for the three figures every gate on every outbid card
 * is decided from. It still throws on anything else, so a read of a table this
 * page has no business touching fails the suite rather than passing silently.
 */

import { describe, expect, it } from 'vitest';

import { loadPositions } from '../../src/lib/server/positions.ts';

function fakeGateway(
	options: {
		readonly failOn?: RegExp;
		readonly events?: readonly unknown[];
		readonly players?: readonly Record<string, unknown>[];
		readonly managers?: readonly Record<string, unknown>[];
		readonly rosterRows?: readonly Record<string, unknown>[];
	} = {}
) {
	const statements: string[] = [];
	let released = 0;
	return {
		statements,
		releases: () => released,
		gateway: {
			connect: async () => ({
				async query(text: string) {
					const sql = text.trim();
					statements.push(sql);
					if (options.failOn !== undefined && options.failOn.test(sql)) {
						throw new Error('the read failed');
					}
					if (/^begin$|^rollback$/i.test(sql)) return { rows: [] };
					if (/^select \* from auction_events/i.test(sql)) {
						return { rows: options.events ?? [] };
					}
					if (/^select now\(\) as now/i.test(sql)) return { rows: [{ now: new Date() }] };
					if (/from team_rosters/i.test(sql)) return { rows: options.rosterRows ?? [] };
					if (/from free_agent_players/i.test(sql)) return { rows: options.players ?? [] };
					if (/from managers/i.test(sql)) return { rows: options.managers ?? [] };
					throw new Error(`unexpected statement: ${sql}`);
				},
				release: () => {
					released += 1;
				}
			})
		}
	};
}

/**
 * An `auction_events` row in the shape `loadEventsViaClient` returns — the
 * DATABASE column names, because `toAppendedEvent` is what maps them and it
 * reads `event_type`, `occurred_at` and the snake-case actor columns.
 */
let nextSeq = 0;
function row(eventType: string, payload: Record<string, unknown>, occurredAt: string) {
	nextSeq += 1;
	return {
		seq: String(nextSeq),
		event_type: eventType,
		payload,
		occurred_at: new Date(occurredAt),
		manager_id: payload['managerId'] ?? null,
		team_id: payload['teamId'] ?? null,
		schema_version: 1,
		core_version: 1,
		device_class: null
	};
}

const VIEWER = 't-viewer';
const RIVAL = 't-rival';

/** A nomination, a viewer Bid and a rival raise: the viewer is outbid. */
const OUTBID_LOG = [
	row(
		'NominationPlaced',
		{
			fantraxPlayerId: 'p-1',
			playerName: 'Stale Fold Name',
			teamId: RIVAL,
			teamName: 'Rockets',
			managerId: 'm-rival'
		},
		'2026-08-26T00:00:00.000Z'
	),
	row(
		'BidPlaced',
		{
			fantraxPlayerId: 'p-1',
			teamId: VIEWER,
			teamName: 'Lakers',
			managerId: 'm-viewer',
			amount: 14_000_000,
			closesAt: '2026-08-28T00:00:00.000Z'
		},
		'2026-08-26T01:00:00.000Z'
	),
	row(
		'BidPlaced',
		{
			fantraxPlayerId: 'p-1',
			teamId: RIVAL,
			teamName: 'Rockets',
			managerId: 'm-rival',
			amount: 14_500_000,
			closesAt: '2026-08-28T00:00:00.000Z'
		},
		'2026-08-26T02:00:00.000Z'
	)
];

describe('loadPositions — executed against a fake client', () => {
	it('reads the log exactly once, takes no lock, and always rolls back', async () => {
		const { gateway, statements } = fakeGateway({ events: OUTBID_LOG });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const positions = await loadPositions(gateway as any, VIEWER);

		// ONE read, however many Auctions the page asks a gate about — the
		// generalisation is N-at-once over one fold, not N reads.
		const eventReads = statements.filter((sql) => /from auction_events/i.test(sql));
		expect(eventReads).toHaveLength(1);
		expect(statements.at(-1)).toMatch(/^rollback$/i);
		// Rendering a page is not a write, so it contends for nothing (AD-6).
		expect(statements.some((sql) => /advisory/i.test(sql))).toBe(false);
		expect(positions.viewerTeamId).toBe(VIEWER);
	});

	it('reads the roster ONCE for the whole page, not once per card', async () => {
		const { gateway, statements } = fakeGateway({ events: OUTBID_LOG });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await loadPositions(gateway as any, VIEWER);
		const rosterReads = statements.filter((sql) => /from team_rosters/i.test(sql));
		expect(rosterReads).toHaveLength(1);
	});

	it('anchors every phrase and every gate on the DATABASE clock, never on Node', async () => {
		const { gateway, statements } = fakeGateway({ events: OUTBID_LOG });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const positions = await loadPositions(gateway as any, VIEWER);
		expect(statements.some((sql) => /^select now\(\) as now/i.test(sql))).toBe(true);
		expect(Number.isNaN(Date.parse(positions.figuresAt))).toBe(false);
	});

	it('rolls back and RETHROWS when the read fails — never an empty page', async () => {
		// The matrix row: an unreachable database and a Manager with nothing in
		// play must never render the same screen, because the second is a
		// designed empty state saying so out loud.
		const { gateway, statements, releases } = fakeGateway({
			failOn: /auction_events/i
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await expect(loadPositions(gateway as any, VIEWER)).rejects.toThrow('the read failed');
		expect(statements.at(-1)).toMatch(/^rollback$/i);
		expect(releases()).toBe(1);
	});

	it('rethrows the ORIGINAL failure even when the rollback itself fails', async () => {
		const { gateway, releases } = fakeGateway({
			failOn: /auction_events|^rollback$/i
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await expect(loadPositions(gateway as any, VIEWER)).rejects.toThrow('the read failed');
		expect(releases()).toBe(1);
	});

	it('releases the client even on the happy path', async () => {
		const { gateway, releases } = fakeGateway();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await loadPositions(gateway as any, VIEWER);
		expect(releases()).toBe(1);
	});

	it('issues no reference or manager statement when the page names nobody', async () => {
		const { gateway, statements } = fakeGateway();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await loadPositions(gateway as any, VIEWER);
		expect(statements.some((sql) => /free_agent_players/i.test(sql))).toBe(false);
		expect(statements.some((sql) => /display_name/i.test(sql))).toBe(false);
	});

	it('assembles a real outbid card — the metadata and manager lookups both run', async () => {
		const { gateway } = fakeGateway({
			events: OUTBID_LOG,
			players: [
				{
					fantrax_player_id: 'p-1',
					player_name: 'Jalen Duren',
					positions: 'C',
					nba_team: 'DET'
				}
			],
			managers: [{ id: 'm-rival', team_id: RIVAL, display_name: 'Dana' }]
		});

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const positions = await loadPositions(gateway as any, VIEWER);
		expect(positions.outbid).toHaveLength(1);
		const card = positions.outbid[0];

		// The reference row's name wins over the fold's copy.
		expect(card?.playerName).toBe('Jalen Duren');
		// `NBA · POS`, and the abbreviation is the real NBA team.
		expect(card?.metadata).toBe('DET · C');
		expect(card?.priceLabel).toBe('$14.5M');
		expect(card?.yourBidLabel).toBe('$14.0M');
		// A fantasy Team is spelled out with its Manager — the `pairKey`
		// lookup resolving on (id, team).
		expect(card?.leadingBidder).toBe('Rockets — Dana');
		expect(card?.closesAt).toBe('2026-08-28T00:00:00.000Z');
		expect(card?.stateIcon).not.toBe('');
		expect(card?.stateLabel).not.toBe('');
		expect(card?.href).toBe('/auction/p-1');
		// The re-entry answer ran: a real sentence and BOTH gates, always.
		expect(card?.reEntrySentence).not.toBe('');
		expect(card?.reEntryGates.map((gate) => gate.gate)).toEqual(['cap', 'slots']);
		for (const gate of card?.reEntryGates ?? []) expect(gate.figure).not.toBe('');
	});

	it('names the Team alone when the Manager cannot be resolved for that Team', async () => {
		// The pairing is the point: a `managerId` that does not belong to the
		// Team it is rendered beside must resolve to NO name rather than to
		// some other Team's Manager.
		const { gateway } = fakeGateway({
			events: OUTBID_LOG,
			managers: [{ id: 'm-rival', team_id: 'SOME-OTHER-TEAM', display_name: 'Dana' }]
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const positions = await loadPositions(gateway as any, VIEWER);
		expect(positions.outbid[0]?.leadingBidder).toBe('Rockets');
		// No metadata row, so the line is omitted rather than blanked.
		expect(positions.outbid[0]?.metadata).toBeNull();
		// The fold's own copy of the name still identifies the Player.
		expect(positions.outbid[0]?.playerName).toBe('Stale Fold Name');
	});

	it('folds contracts into the Won group and into the roster figures together', async () => {
		const { gateway } = fakeGateway({
			events: [
				row(
					'AuctionClosed',
					{
						fantraxPlayerId: 'p-9',
						playerName: 'Jaden McDaniels',
						teamId: VIEWER,
						teamName: 'Lakers',
						managerId: 'm-viewer',
						winningAmount: 11_000_000,
						capHit: 11_000_000,
						placement: 'active_bench',
						closedAt: '2026-08-27T00:00:00.000Z'
					},
					'2026-08-27T00:05:00.000Z'
				)
			]
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const positions = await loadPositions(gateway as any, VIEWER);
		expect(positions.won).toHaveLength(1);
		expect(positions.won[0]?.winningAmountLabel).toBe('$11.0M');
		expect(positions.won[0]?.placement).toBe('active_bench');
		// `closedAt` is the Auction's own nominal expiry, never the event's
		// own instant — the difference AD-10 makes structural.
		expect(positions.won[0]?.closedAt).toBe('2026-08-27T00:00:00.000Z');
		// A won Auction is a position, so the page is not the empty screen.
		expect(positions.empty).toBe(false);
	});

	it('answers five empty groups for a viewer bound to no Team, and reads no roster', async () => {
		// The route refuses such a request with the guard's 403, so this is
		// unreachable in production — but a total function must answer, and no
		// group may render against a Team that does not exist.
		const { gateway, statements } = fakeGateway({ events: OUTBID_LOG });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const positions = await loadPositions(gateway as any, null);
		expect(positions.viewerTeamId).toBeNull();
		expect(positions.won).toEqual([]);
		expect(positions.outbid).toEqual([]);
		expect(positions.youLead).toEqual([]);
		expect(positions.contending).toEqual([]);
		expect(positions.empty).toBe(true);
		// One Auction is on the board and the empty screen states the count.
		expect(positions.openAuctionCount).toBe(1);
		// No Team, so no roster to read and no gate to decide.
		expect(statements.some((sql) => /from team_rosters/i.test(sql))).toBe(false);
		expect(statements.at(-1)).toMatch(/^rollback$/i);
	});

	it('carries the viewer’s lead and its commitment sentence', async () => {
		const { gateway } = fakeGateway({
			events: [
				row(
					'NominationPlaced',
					{
						fantraxPlayerId: 'p-2',
						playerName: 'Isaiah Hartenstein',
						teamId: RIVAL,
						teamName: 'Rockets',
						managerId: 'm-rival'
					},
					'2026-08-26T00:00:00.000Z'
				),
				row(
					'BidPlaced',
					{
						fantraxPlayerId: 'p-2',
						teamId: VIEWER,
						teamName: 'Lakers',
						managerId: 'm-viewer',
						amount: 9_000_000,
						closesAt: '2026-08-28T00:00:00.000Z'
					},
					'2026-08-26T01:00:00.000Z'
				)
			]
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const positions = await loadPositions(gateway as any, VIEWER);
		expect(positions.youLead).toHaveLength(1);
		expect(positions.youLead[0]?.priceLabel).toBe('$9.0M');
		expect(positions.youLead[0]?.commitmentSentence).toContain('$9.0M');
		expect(positions.outbid).toEqual([]);
	});

	it('states the Nomination Slot, spent, and names the Player', async () => {
		const { gateway } = fakeGateway({
			events: [
				row(
					'NominationPlaced',
					{
						fantraxPlayerId: 'p-3',
						playerName: 'Naz Reid',
						teamId: VIEWER,
						teamName: 'Lakers',
						managerId: 'm-viewer'
					},
					'2026-08-26T00:00:00.000Z'
				)
			]
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const positions = await loadPositions(gateway as any, VIEWER);
		expect(positions.nominationSlot.used).toBe(true);
		expect(positions.nominationSlot.playerName).toBe('Naz Reid');
		expect(positions.nominationSlot.href).toBe('/auction/p-3');
		expect(positions.nominationSlot.sentence).toContain('Naz Reid');
	});
});
