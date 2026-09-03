/**
 * `loadTeamView` executed against a fake client (Story 4.5).
 *
 * Its own file rather than a section of `tests/routes/team-view.test.ts`,
 * because that suite mocks `$lib/server/team-view.ts` to prove the route's
 * guard ordering — an execution test living beside it would silently exercise
 * the stub and assert nothing. The transaction discipline is only provable by
 * running the real function.
 *
 * `fakeGateway` is `tests/server/positions.test.ts`'s, widened by the one
 * table this read touches that Your Positions' does not: `teams`, joined to
 * `managers` so a co-managed Team is named once. It still throws on anything
 * else, so a read of a table this page has no business touching fails the
 * suite rather than passing silently.
 */

import { describe, expect, it } from 'vitest';

import { SALARY_CAP } from '../../src/lib/core/constants.ts';
import { loadTeamView } from '../../src/lib/server/team-view.ts';

const VIEWER = 't-viewer';
const RIVAL = 't-rival';

function fakeGateway(
	options: {
		readonly failOn?: RegExp;
		readonly events?: readonly unknown[];
		readonly teams?: readonly Record<string, unknown>[];
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
					if (/from teams/i.test(sql)) return { rows: options.teams ?? [] };
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
 * DATABASE column names, because `toAppendedEvent` is what maps them.
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

/** A nomination by the viewer's Team, and a lead it holds on another Player. */
const LOG = [
	row(
		'NominationPlaced',
		{
			fantraxPlayerId: 'p-1',
			playerName: 'Nominated Player',
			teamId: VIEWER,
			teamName: 'Lakers',
			managerId: 'm-viewer'
		},
		'2026-09-03T00:00:00.000Z'
	),
	row(
		'BidPlaced',
		{
			fantraxPlayerId: 'p-1',
			teamId: VIEWER,
			teamName: 'Lakers',
			managerId: 'm-viewer',
			amount: 14_000_000,
			closesAt: '2026-09-05T00:00:00.000Z'
		},
		'2026-09-03T01:00:00.000Z'
	)
];

const LAKERS = [
	{ team_name: 'Lakers', display_name: 'Meakel' }
];

const CO_MANAGED = [
	{ team_name: 'Lakers', display_name: 'Dana' },
	{ team_name: 'Lakers', display_name: 'Meakel' }
];

describe('loadTeamView — executed against a fake client', () => {
	it('reads the log exactly once, takes no lock, and always rolls back', async () => {
		const { gateway, statements, releases } = fakeGateway({ events: LOG, teams: LAKERS });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const view = await loadTeamView(gateway as any, VIEWER, VIEWER);

		const eventReads = statements.filter((sql) => /from auction_events/i.test(sql));
		expect(eventReads).toHaveLength(1);
		expect(statements.at(-1)).toMatch(/^rollback$/i);
		// Rendering a page is not a write, so it contends for nothing (AD-6).
		expect(statements.some((sql) => /advisory/i.test(sql))).toBe(false);
		expect(releases()).toBe(1);
		expect(view).not.toBeNull();
	});

	it('reads the roster ONCE, and reads no table this page has no business touching', async () => {
		const { gateway, statements } = fakeGateway({ events: LOG, teams: LAKERS });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await loadTeamView(gateway as any, VIEWER, VIEWER);
		expect(statements.filter((sql) => /from team_rosters/i.test(sql))).toHaveLength(1);
		expect(statements.filter((sql) => /from teams/i.test(sql))).toHaveLength(1);
		// The fake throws on anything else, so reaching here IS the assertion
		// that no other table was touched.
	});

	it('answers null for an unknown Team — the route’s 404, never an empty page', async () => {
		const { gateway, statements } = fakeGateway({ events: LOG, teams: [] });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const view = await loadTeamView(gateway as any, 't-nobody', VIEWER);
		expect(view).toBeNull();
		// ...and it still rolls back and still releases.
		expect(statements.at(-1)).toMatch(/^rollback$/i);
	});

	/**
	 * The reason `loadTeamIdentity` compares `t.id::text = $1` rather than
	 * casting the parameter to `uuid`: a malformed id in the URL must produce
	 * a MISSING Team — and therefore a 404 — rather than a failed cast that
	 * 500s the page. The claim was documented but nothing drove it, so the
	 * cast could have been "corrected" to `$1::uuid` with every test green.
	 *
	 * The fake cannot reproduce Postgres' cast error, so this asserts the
	 * half that is observable here: the id reaches the query as text, the
	 * read completes, and the answer is the same `null` an unknown-but-valid
	 * id gets. `tests/routes/team-view.test.ts` then turns that `null` into
	 * the 404.
	 */
	it('answers null for a MALFORMED id rather than failing the query', async () => {
		const { gateway, statements } = fakeGateway({ events: LOG, teams: [] });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const view = await loadTeamView(gateway as any, 'not-a-uuid-at-all', VIEWER);
		expect(view).toBeNull();
		// The comparison is against `::text`, so no cast of the parameter can
		// throw before the row set comes back empty.
		const identityRead = statements.find((sql) => /from teams/i.test(sql)) ?? '';
		expect(identityRead).toContain('t.id::text = $1');
		expect(identityRead).not.toMatch(/\$1::uuid/);
		expect(statements.at(-1)).toMatch(/^rollback$/i);
	});

	it('rethrows a read failure rather than rendering a page of zeroes', async () => {
		const { gateway, statements, releases } = fakeGateway({
			events: LOG,
			teams: LAKERS,
			failOn: /from team_rosters/i
		});
		await expect(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			loadTeamView(gateway as any, VIEWER, VIEWER)
		).rejects.toThrow('the read failed');
		// The rollback still runs, and the client is still released.
		expect(statements.at(-1)).toMatch(/^rollback$/i);
		expect(releases()).toBe(1);
	});

	it('assembles the real thing: identity, figures, roster and the Nomination Slot', async () => {
		const { gateway } = fakeGateway({
			events: LOG,
			teams: LAKERS,
			rosterRows: [
				{
					fantrax_player_id: 'p-100',
					player_name: 'Imported Player',
					cap_hit: '4000000',
					roster_slot_kind: 'active_bench'
				},
				{
					fantrax_player_id: 'p-101',
					player_name: 'Stashed Player',
					cap_hit: '0',
					roster_slot_kind: 'minor_league'
				}
			]
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const view = await loadTeamView(gateway as any, VIEWER, VIEWER);

		expect(view?.teamId).toBe(VIEWER);
		expect(view?.identity).toBe('Lakers — Meakel');
		// Cap Space is the imported rows' own arithmetic; the $14.0M lead is
		// Committed Bids rather than a Cap charge, because it has not closed.
		expect(view?.capSpaceLabel).toBe('$161.0M');
		expect(view?.committedBidsLabel).toBe('$14.0M');
		expect(view?.rosterCountSentence).toBe('Roster 1 of 12');
		expect(view?.minorLeagueSentence).toContain('Minor League 1 of 3');
		// The Nomination Slot this Team spent, named and linked.
		expect(view?.nominationSlot.used).toBe(true);
		expect(view?.nominationSlot.playerName).toBe('Nominated Player');
		expect(view?.nominationSlot.href).toBe('/auction/p-1');
		// The roster listing carries the NAMES the widened select returned.
		const active = view?.roster.find((group) => group.slotKind === 'active_bench');
		expect(active?.entries.map((entry) => entry.playerName)).toEqual(['Imported Player']);
		// ...and the figures were read at the database clock.
		expect(view?.figuresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('names every Manager of a co-managed Team, and the Team once', async () => {
		const { gateway } = fakeGateway({ events: LOG, teams: CO_MANAGED });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const view = await loadTeamView(gateway as any, VIEWER, VIEWER);
		expect(view?.identity).toBe('Lakers — Dana & Meakel');
		expect(view?.managerNames).toEqual(['Dana', 'Meakel']);
	});

	it('answers a Team with no roster rows at exactly the Salary Cap', async () => {
		const { gateway } = fakeGateway({ teams: LAKERS });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const view = await loadTeamView(gateway as any, RIVAL, VIEWER);
		expect(view?.capSpaceLabel).toBe('$165.0M');
		expect(view?.rosterCount).toBe(0);
		expect(SALARY_CAP).toBe(165_000_000);
	});

	it('carries Maximum Bid for the viewer’s own Team and for no other', async () => {
		const own = fakeGateway({ events: LOG, teams: LAKERS });
		const rival = fakeGateway({ events: LOG, teams: LAKERS });

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const mine = await loadTeamView(own.gateway as any, VIEWER, VIEWER);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const theirs = await loadTeamView(rival.gateway as any, VIEWER, RIVAL);

		expect(mine).toHaveProperty('maximumBid');
		expect(mine).toHaveProperty('capBreakdown');
		expect(theirs).not.toHaveProperty('maximumBid');
		expect(theirs).not.toHaveProperty('capBreakdown');
		expect(JSON.stringify(theirs)).not.toContain('Maximum Bid');
	});

	it('shows no Maximum Bid to a viewer bound to no Team, and still renders in full', async () => {
		const { gateway } = fakeGateway({ events: LOG, teams: LAKERS });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const view = await loadTeamView(gateway as any, VIEWER, null);
		expect(view).not.toHaveProperty('maximumBid');
		expect(view?.capSpaceLabel).toBe('$165.0M');
		expect(view?.committedBidsLabel).toBe('$14.0M');
	});
});
