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
function fakeGateway(options: { readonly failOn?: RegExp } = {}) {
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
					if (/^select \* from auction_events/i.test(sql)) return { rows: [] };
					if (/^select now\(\) as now/i.test(sql)) return { rows: [{ now: new Date() }] };
					throw new Error(`unexpected statement: ${sql}`);
				},
				release: () => {
					released += 1;
				}
			})
		}
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
});
