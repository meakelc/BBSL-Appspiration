/**
 * `loadBoard` executed against a fake client (Story 4.3).
 *
 * Its own file rather than a section of `tests/routes/board.test.ts`, because
 * that suite mocks `$lib/server/board.ts` to prove the route's guard ordering
 * — an execution test living beside it would silently exercise the stub and
 * assert nothing. The transaction discipline is only provable by running the
 * real function.
 */

import { describe, expect, it } from 'vitest';

import { loadBoard } from '../../src/lib/server/board.ts';

// --- The server read, executed ----------------------------------------------

/**
 * A gateway over a fake client answering the four statements `loadBoard`
 * issues, recording every one of them. It throws on anything else, so a read
 * of a table the board has no business touching fails the suite rather than
 * passing silently — `tests/strip.test.ts:511-536`'s own discipline, which is
 * what makes "one read of the log" and "always rolls back" provable claims
 * rather than source-text ones.
 */
function fakeGateway(
	options: {
		readonly failOn?: RegExp;
		readonly events?: readonly unknown[];
		readonly players?: readonly Record<string, unknown>[];
		readonly managers?: readonly Record<string, unknown>[];
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
 * DATABASE column names, because `toAppendedEvent` (`shell/write.ts:201`) is
 * what maps them and it reads `event_type`, `occurred_at` and the snake-case
 * actor columns. Building the camelCase shape here instead would fold a log
 * of unrecognised events and quietly assert nothing.
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

describe('loadBoard — executed against a fake client', () => {
	it('reads the log exactly once, takes no lock, and always rolls back', async () => {
		const { gateway, statements } = fakeGateway();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const board = await loadBoard(gateway as any, 't-1');

		const eventReads = statements.filter((sql) => /from auction_events/i.test(sql));
		expect(eventReads).toHaveLength(1);
		expect(statements.at(-1)).toMatch(/^rollback$/i);
		// Rendering a board is not a write, so it contends for nothing (AD-6).
		expect(statements.some((sql) => /advisory/i.test(sql))).toBe(false);
		// An empty log is a real state — the designed empty board, not a failure.
		expect(board.cards).toEqual([]);
		expect(board.viewerTeamId).toBe('t-1');
	});

	it('issues no reference or manager statement when nothing is nominated', () => {
		// Both helpers return early on an empty id list, so an empty board costs
		// two statements plus the transaction, never a query with `any('{}')`.
		const { gateway, statements } = fakeGateway();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return loadBoard(gateway as any, null).then(() => {
			expect(statements.some((sql) => /free_agent_players/i.test(sql))).toBe(false);
			expect(statements.some((sql) => /display_name/i.test(sql))).toBe(false);
		});
	});

	it('anchors every phrase on the DATABASE clock, never on Node', async () => {
		const { gateway, statements } = fakeGateway();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const board = await loadBoard(gateway as any, null);
		expect(statements.some((sql) => /^select now\(\) as now/i.test(sql))).toBe(true);
		expect(Number.isNaN(Date.parse(board.figuresAt))).toBe(false);
	});

	it('rolls back and RETHROWS when the read fails — never an empty board', async () => {
		// The matrix row: an unreachable database and a league with nothing
		// nominated must never render the same screen, because the second is a
		// designed empty state saying the board is genuinely empty.
		const { gateway, statements, releases } = fakeGateway({ failOn: /auction_events/i });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await expect(loadBoard(gateway as any, 't-1')).rejects.toThrow('the read failed');
		expect(statements.at(-1)).toMatch(/^rollback$/i);
		expect(releases()).toBe(1);
	});

	it('rethrows the ORIGINAL failure even when the rollback itself fails', async () => {
		// `rollback` is swallowed deliberately: the caller needs the read's own
		// error, not the cleanup's, or the real cause is lost.
		const { gateway, releases } = fakeGateway({ failOn: /auction_events|^rollback$/i });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await expect(loadBoard(gateway as any, 't-1')).rejects.toThrow('the read failed');
		expect(releases()).toBe(1);
	});

	it('releases the client even on the happy path', async () => {
		const { gateway, releases } = fakeGateway();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await loadBoard(gateway as any, null);
		expect(releases()).toBe(1);
	});

	it('assembles a real card — the mapping every field on the board goes through', async () => {
		// The claims below were previously asserted only as source text: the
		// one executing test reached `cards` on an EMPTY log, so `priceLabel`,
		// `nameTeam`, `metadataLine` and the `pairKey` lookups never ran. A
		// populated log is what makes them provable.
		const { gateway } = fakeGateway({
			events: [
				row(
					'NominationPlaced',
					{
						fantraxPlayerId: 'p-1',
						playerName: 'Stale Fold Name',
						teamId: 't-1',
						teamName: 'Lakers',
						managerId: 'm-1'
					},
					'2026-08-26T00:00:00.000Z'
				),
				row(
					'BidPlaced',
					{
						fantraxPlayerId: 'p-1',
						teamId: 't-2',
						teamName: 'Rockets',
						managerId: 'm-2',
						amount: 8_500_000,
						closesAt: '2026-08-28T00:00:00.000Z'
					},
					'2026-08-26T12:00:00.000Z'
				)
			],
			players: [
				{
					fantrax_player_id: 'p-1',
					player_name: 'Jalen Green',
					positions: 'SG',
					nba_team: 'HOU'
				}
			],
			managers: [
				{ id: 'm-1', team_id: 't-1', display_name: 'Meakel' },
				{ id: 'm-2', team_id: 't-2', display_name: 'Dana' }
			]
		});

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const board = await loadBoard(gateway as any, 't-2');
		expect(board.cards).toHaveLength(1);
		const card = board.cards[0];

		// The reference row's name wins over the fold's copy.
		expect(card?.playerName).toBe('Jalen Green');
		// `NBA · POS`, and the abbreviation is the real NBA team.
		expect(card?.metadata).toBe('HOU · SG');
		// The price crosses the wire as the integer FACT the sort reads, beside
		// the rendering the card prints — one decimal, never dropped.
		expect(card?.price).toBe(8_500_000);
		expect(card?.priceLabel).toBe('$8.5M');
		// A fantasy Team is spelled out with its Manager, both for the leader
		// and for the nominator — the `pairKey` lookup resolving on (id, team).
		expect(card?.leadingBidder).toBe('Rockets — Dana');
		expect(card?.nominatedBy).toBe('Lakers — Meakel');
		expect(card?.closesAt).toBe('2026-08-28T00:00:00.000Z');
		// The viewer holds the leading Bid, so the state and its word agree.
		expect(card?.viewerState).toBe('you_lead');
		expect(card?.viewerStateLabel).toBe('You lead');
		expect(card?.auctionStateLabel).toBe('Open');
		// Every icon is non-empty, so no card can render a state as colour alone.
		expect(card?.viewerStateIcon).not.toBe('');
		expect(card?.auctionStateIcon).not.toBe('');
	});

	it('names the Team alone when the Manager cannot be resolved for that Team', async () => {
		// The pairing is the point: a `managerId` that does not belong to the
		// Team it is rendered beside must resolve to NO name rather than to
		// some other Team's Manager. Here the manager row exists but is bound
		// to a different Team, which is exactly the mismatch `pairKey` closes.
		const { gateway } = fakeGateway({
			events: [
				row(
					'NominationPlaced',
					{
						fantraxPlayerId: 'p-1',
						playerName: 'Jalen Green',
						teamId: 't-1',
						teamName: 'Lakers',
						managerId: 'm-1'
					},
					'2026-08-26T00:00:00.000Z'
				)
			],
			managers: [{ id: 'm-1', team_id: 'SOME-OTHER-TEAM', display_name: 'Meakel' }]
		});

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const board = await loadBoard(gateway as any, null);
		const card = board.cards[0];
		// The Team alone — never "Lakers — Lakers", and never another Team's
		// Manager attached to this one.
		expect(card?.nominatedBy).toBe('Lakers');
		// No Bid yet, so the board states the absence rather than a blank or
		// a price nobody offered.
		expect(card?.price).toBeNull();
		expect(card?.priceLabel).toBe('No opening bid');
		expect(card?.leadingBidder).toBe('No Team leads this Auction yet.');
		expect(card?.closesAt).toBeNull();
		expect(card?.auctionStateLabel).toBe('Awaiting Opening Bid');
		// No metadata row for this Player, so the line is omitted, not blanked.
		expect(card?.metadata).toBeNull();
	});
});
