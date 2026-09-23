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
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { CONTENTION_DRAWN_EVENT } from '../../src/lib/core/projection/draws.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { closedPayload } from '../fixtures/closed-event.ts';

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
		expect(card?.viewerStateLabel).toBe('Leading');
		expect(card?.auctionStateLabel).toBe('Open');
		expect(card?.state).toBe('standard');
		// An open card carries none of the closed fields, so a surface that
		// printed one would print an absence rather than a wrong figure.
		expect(card?.wonBy).toBeNull();
		expect(card?.closedAt).toBeNull();
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
		expect(card?.auctionStateLabel).toBe('Unbid');
		// No metadata row for this Player, so the line is omitted, not blanked.
		expect(card?.metadata).toBeNull();
	});
});

describe('loadBoard — the closed cards, off the two folds that survive a close', () => {
	const CLOSED_AT = '2026-08-27T09:00:00.000Z';

	it('emits a closed card, resolving the winner in the SAME manager statement', async () => {
		const { gateway, statements } = fakeGateway({
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
					CONTENTION_DRAWN_EVENT,
					{
						fantraxPlayerId: 'p-1',
						seed: '4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e',
						seedHash: '0f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a6978',
						contenders: ['t-1', 't-2'],
						selectedIndex: 1,
						winningTeamId: 't-2',
						winningTeamName: 'Rockets',
						winningManagerId: 'm-2'
					},
					CLOSED_AT
				),
				row(
					AUCTION_CLOSED_EVENT,
					closedPayload({
						fantraxPlayerId: 'p-1',
						playerName: 'Fold Copy',
						teamId: 't-2',
						teamName: 'Rockets',
						winningAmount: 8_500_000,
						capHit: 8_500_000,
						closedAt: CLOSED_AT
					}),
					CLOSED_AT
				)
			],
			players: [
				{ fantrax_player_id: 'p-1', player_name: 'Jalen Green', positions: 'SG', nba_team: 'HOU' }
			],
			managers: [{ id: 'm-2', team_id: 't-2', display_name: 'Dana' }]
		});

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const board = await loadBoard(gateway as any, 't-2');
		expect(board.cards).toHaveLength(1);
		const card = board.cards[0];

		expect(card?.state).toBe('closed');
		expect(card?.auctionStateLabel).toBe('Closed');
		expect(card?.auctionStateIcon).not.toBe('');
		// The reference row survives a close, so the metadata line does too.
		expect(card?.playerName).toBe('Jalen Green');
		expect(card?.metadata).toBe('HOU · SG');
		// The final amount, through the core's one money renderer.
		expect(card?.price).toBe(8_500_000);
		expect(card?.priceLabel).toBe('$8.5M');
		// The winner, spelled out with the Manager the DRAW recorded — resolved
		// in the statement that already resolves leaders and nominators.
		expect(card?.wonBy).toBe('Rockets — Dana');
		expect(card?.closedAt).toBe(CLOSED_AT);
		// The viewer holds the contract.
		expect(card?.viewerState).toBe('won');
		expect(card?.viewerStateLabel).toBe('You won');
		// Neither is durable past a close, and neither is invented.
		expect(card?.nominatedBy).toBeNull();
		expect(card?.nominatedAt).toBeNull();
		expect(card?.closesAt).toBeNull();

		// Still ONE read of the log and ONE manager statement — a board
		// carrying closed cards costs no extra round trip.
		expect(statements.filter((sql) => /from auction_events/i.test(sql))).toHaveLength(1);
		expect(statements.filter((sql) => /display_name/i.test(sql))).toHaveLength(1);
		expect(statements.at(-1)).toMatch(/^rollback$/i);
	});

	it('names the winning Team ALONE when the close recorded no Manager', async () => {
		// A Standard close records the winning Team and no Manager at all, so
		// the card names the Team — never the Team paired with its own name,
		// which would read as a Manager literally called "Rockets".
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
				),
				row(
					AUCTION_CLOSED_EVENT,
					closedPayload({
						fantraxPlayerId: 'p-1',
						teamId: 't-2',
						teamName: 'Rockets',
						closedAt: CLOSED_AT
					}),
					CLOSED_AT
				)
			],
			managers: [{ id: 'm-w', team_id: 't-2', display_name: 'Dana' }]
		});

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const board = await loadBoard(gateway as any, null);
		expect(board.cards[0]?.wonBy).toBe('Rockets');
		expect(board.cards[0]?.viewerState).toBe('not_involved');
	});
});

describe('loadBoard — a reversed Close (Story 7.13)', () => {
	it('labels the card Reversed in both widths and states the actor and the reason', async () => {
		const close = row(
			AUCTION_CLOSED_EVENT,
			closedPayload({ fantraxPlayerId: 'p-rev', teamId: 't-won', teamName: 'Rockets' }),
			'2026-09-02T00:00:00.000Z'
		);
		const reversal = {
			...row(
				'AuctionCloseReversed',
				{
					closeSeq: close.seq,
					fantraxPlayerId: 'p-rev',
					teamId: 't-won',
					reason: 'Won with an illegal IR designation.'
				},
				'2026-09-03T00:00:00.000Z'
			),
			// The ENVELOPE names the acting Commissioner, not the payload.
			manager_id: 'm-comm',
			team_id: 't-comm'
		};
		const { gateway } = fakeGateway({
			events: [close, reversal],
			managers: [{ id: 'm-comm', team_id: 't-comm', display_name: 'Dana' }]
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const board = await loadBoard(gateway as any, 't-won');
		const card = board.cards.find((one) => one.fantraxPlayerId === 'p-rev');
		expect(card?.reversed).toBe(true);
		expect(card?.auctionStateLabel).toBe('Reversed');
		expect(card?.auctionStateLabelNarrow).toBe('Reversed');
		// The Team that won it is still named, and it is not theirs any more.
		expect(card?.wonBy).toBe('Rockets');
		expect(card?.viewerState).toBe('not_involved');
		expect(card?.reversalStatement).toBe(
			'Reversed by the Commissioner, Dana. The Player is back in the pool. Reason: Won with an ' +
				'illegal IR designation.'
		);
	});

	it('carries no reversal statement on a close that stands', async () => {
		const { gateway } = fakeGateway({
			events: [row(AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-kept' }), '2026-09-02T00:00:00.000Z')]
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const board = await loadBoard(gateway as any, null);
		expect(board.cards[0]?.reversed).toBe(false);
		expect(board.cards[0]?.reversalStatement).toBeNull();
		expect(board.cards[0]?.auctionStateLabel).toBe('Closed');
	});
});
