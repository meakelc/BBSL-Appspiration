/**
 * `loadTeamsIndex` executed against a fake client (Story 4.6).
 *
 * Its own file rather than a section of `tests/routes/teams-index.test.ts`,
 * because that suite mocks `$lib/server/teams-index.ts` to prove the route's
 * guard ordering — an execution test living beside it would silently exercise
 * the stub and assert nothing. The transaction discipline is only provable by
 * running the real function.
 *
 * `fakeGateway` is `tests/server/team-view.test.ts`'s, unchanged in shape. It
 * **throws on any unexpected statement**, so a read of a table this page has no
 * business touching fails the suite rather than passing silently — and the
 * league-wide roster read had to be added to it deliberately.
 *
 * What this suite is FOR, above all, is the no-second-computation guarantee:
 * thirty Teams cost exactly one log read, one `select now()`, one identity
 * join and one roster read, asserted by COUNTING statements rather than by
 * reading the source.
 */

import { describe, expect, it } from 'vitest';

import { SALARY_CAP } from '../../src/lib/core/constants.ts';
import { MEDIAN_UNAVAILABLE, OWN_ROW_MARKER } from '../../src/lib/core/teams-index.ts';
import { loadTeamsIndex } from '../../src/lib/server/teams-index.ts';

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

/** A nomination by the viewer's Team, and the lead that nomination became. */
const LOG = [
	row(
		'NominationPlaced',
		{
			fantraxPlayerId: 'p-1',
			playerName: 'Nominated Player',
			teamId: VIEWER,
			teamName: 'Bucks',
			managerId: 'm-viewer'
		},
		'2026-09-03T00:00:00.000Z'
	),
	row(
		'BidPlaced',
		{
			fantraxPlayerId: 'p-1',
			teamId: VIEWER,
			teamName: 'Bucks',
			managerId: 'm-viewer',
			amount: 14_000_000,
			closesAt: '2026-09-05T00:00:00.000Z'
		},
		'2026-09-03T01:00:00.000Z'
	)
];

/** The `teams left join managers` row set, one row per (Team, Manager) pair. */
const TWO_TEAMS = [
	{ id: VIEWER, team_name: 'Bucks', display_name: 'Meakel' },
	{ id: RIVAL, team_name: 'Bulls', display_name: 'Ana Ruiz' }
];

const CO_MANAGED = [
	{ id: VIEWER, team_name: 'Bucks', display_name: 'Dana' },
	{ id: VIEWER, team_name: 'Bucks', display_name: 'Meakel' },
	{ id: RIVAL, team_name: 'Bulls', display_name: 'Ana Ruiz' }
];

/**
 * The co-managed pair with the join's rows arriving in the OPPOSITE order to
 * the one the query asks for.
 *
 * The fixture cannot execute `order by`, so a suite whose only co-managed
 * fixture happened to be alphabetical would pass whether the query ordered by
 * `m.display_name` or not. This one is deliberately reversed: it pins that the
 * SQL states the order, which is the half a fake client can check.
 */
const CO_MANAGED_REVERSED = [
	{ id: VIEWER, team_name: 'Bucks', display_name: 'Meakel' },
	{ id: VIEWER, team_name: 'Bucks', display_name: 'Dana' },
	{ id: RIVAL, team_name: 'Bulls', display_name: 'Ana Ruiz' }
];

/**
 * A Team with NO Manager bound — the `left join`'s reason for existing.
 *
 * `managers.team_id` is nullable and a Team exists before anyone is bound to
 * it, so this is a real state rather than a defect. An inner join would drop
 * the row entirely and the index would silently become a SUBSET, which
 * `epic-4-context.md:26` forbids by name — and no fixture in this suite could
 * tell, because every other one gives every Team a Manager.
 */
const ONE_UNMANNED = [
	{ id: VIEWER, team_name: 'Bucks', display_name: 'Meakel' },
	{ id: RIVAL, team_name: 'Bulls', display_name: null }
];

describe('loadTeamsIndex — executed against a fake client', () => {
	/**
	 * The no-second-computation guarantee, counted rather than argued: however
	 * many Teams the index carries, the log is folded ONCE and the clock is
	 * read ONCE, so every row describes the same instant and the same state.
	 */
	it('reads the log once and the clock once, for every Team on the index', async () => {
		const { gateway, statements, releases } = fakeGateway({ events: LOG, teams: TWO_TEAMS });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const index = await loadTeamsIndex(gateway as any, VIEWER);

		expect(index.rows).toHaveLength(2);
		expect(statements.filter((sql) => /from auction_events/i.test(sql))).toHaveLength(1);
		expect(statements.filter((sql) => /select now\(\)/i.test(sql))).toHaveLength(1);
		expect(statements.filter((sql) => /from teams/i.test(sql))).toHaveLength(1);
		expect(statements.filter((sql) => /from team_rosters/i.test(sql))).toHaveLength(1);
		expect(releases()).toBe(1);
	});

	it('reads the whole League’s rosters in ONE statement, not one per Team', async () => {
		const { gateway, statements } = fakeGateway({ events: LOG, teams: CO_MANAGED });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await loadTeamsIndex(gateway as any, VIEWER);
		const rosterReads = statements.filter((sql) => /from team_rosters/i.test(sql));
		expect(rosterReads).toHaveLength(1);
		// The batch shape `server/positions.ts:164-169` established.
		expect(rosterReads[0]).toContain('any($1::text[])');
	});

	it('takes no advisory lock and always rolls back', async () => {
		const { gateway, statements } = fakeGateway({ events: LOG, teams: TWO_TEAMS });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await loadTeamsIndex(gateway as any, VIEWER);
		// Rendering a page is not a write, so it contends for nothing (AD-6).
		expect(statements.some((sql) => /advisory/i.test(sql))).toBe(false);
		expect(statements.at(-1)).toMatch(/^rollback$/i);
	});

	it('reads no table this page has no business touching', async () => {
		const { gateway } = fakeGateway({ events: LOG, teams: TWO_TEAMS });
		// The fake throws on anything else, so completing IS the assertion.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await expect(loadTeamsIndex(gateway as any, VIEWER)).resolves.toBeDefined();
	});

	it('rethrows a read failure rather than serving a short list', async () => {
		const { gateway, statements, releases } = fakeGateway({
			events: LOG,
			teams: TWO_TEAMS,
			failOn: /from team_rosters/i
		});
		await expect(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			loadTeamsIndex(gateway as any, VIEWER)
		).rejects.toThrow('the read failed');
		expect(statements.at(-1)).toMatch(/^rollback$/i);
		expect(releases()).toBe(1);
	});

	/**
	 * Zero Teams is a real, empty ANSWER — never `null`, which the route would
	 * have to turn into something. The median states its own absence.
	 */
	it('answers a real empty index for a League with no Teams', async () => {
		const { gateway, statements } = fakeGateway({ events: LOG, teams: [] });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const index = await loadTeamsIndex(gateway as any, VIEWER);
		expect(index).not.toBeNull();
		expect(index.rows).toEqual([]);
		expect(index.median.availableCapSpace.figure).toBe(MEDIAN_UNAVAILABLE);
		expect(index.median.freeActiveBenchSlots.figure).toBe(MEDIAN_UNAVAILABLE);
		expect(statements.at(-1)).toMatch(/^rollback$/i);
	});

	it('assembles the real thing: identity, figures, rosters and the median', async () => {
		const { gateway } = fakeGateway({
			events: LOG,
			teams: TWO_TEAMS,
			rosterRows: [
				{
					team_id: VIEWER,
					fantrax_player_id: 'p-100',
					player_name: 'Imported Player',
					cap_hit: '4000000',
					roster_slot_kind: 'active_bench'
				},
				{
					team_id: VIEWER,
					fantrax_player_id: 'p-101',
					player_name: 'Stashed Player',
					cap_hit: '0',
					roster_slot_kind: 'minor_league'
				},
				{
					team_id: RIVAL,
					fantrax_player_id: 'p-200',
					player_name: 'Rival Player',
					cap_hit: '10000000',
					roster_slot_kind: 'active_bench'
				}
			]
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const index = await loadTeamsIndex(gateway as any, VIEWER);

		const bucks = index.rows.find((entry) => entry.teamId === VIEWER);
		const bulls = index.rows.find((entry) => entry.teamId === RIVAL);

		// **The grouping is the whole difference from the single-Team read.**
		// Each Team's Cap Space is its OWN rows' arithmetic; ungrouped, both
		// would have reported the League's total.
		expect(bucks?.capSpaceLabel).toBe('$161.0M');
		expect(bulls?.capSpaceLabel).toBe('$155.0M');
		expect(bucks?.rosterCountHalves.full).toBe('Roster 1 of 12');
		expect(bulls?.rosterCountHalves.full).toBe('Roster 1 of 12');
		expect(bucks?.minorLeagueHalves.full).toContain('Minor League 1 of 3');
		expect(bulls?.minorLeagueHalves.full).toContain('Minor League 0 of 3');

		// The $14.0M lead is Committed Bids rather than a Cap charge.
		expect(bucks?.committedBidsLabel).toBe('$14.0M');
		expect(bulls?.committedBidsLabel).toBe('$0.0M');

		// The Nomination Slot this Team spent, named on its row.
		expect(bucks?.nominationSlotSentence).toContain('Nominated Player');
		expect(bulls?.nominationSlotSentence).toBe('The Nomination Slot is free.');

		// Two Teams, so the median is the LOWER of the two — Bucks' $147.0M
		// against Bulls' $155.0M.
		expect(index.median.availableCapSpace.figure).toBe('$147.0M');
		expect(index.median.availableCapSpace.coverage).toBe(2);

		// ...and the figures were read at the database clock.
		expect(index.figuresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('answers a Team with no roster rows at exactly the Salary Cap', async () => {
		const { gateway } = fakeGateway({ teams: TWO_TEAMS });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const index = await loadTeamsIndex(gateway as any, null);
		expect(index.rows.every((entry) => entry.capSpaceLabel === '$165.0M')).toBe(true);
		expect(SALARY_CAP).toBe(165_000_000);
	});

	it('names every Manager of a co-managed Team, and the Team once', async () => {
		const { gateway } = fakeGateway({ events: LOG, teams: CO_MANAGED });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const index = await loadTeamsIndex(gateway as any, null);
		expect(index.rows).toHaveLength(2);
		const bucks = index.rows.find((entry) => entry.teamId === VIEWER);
		expect(bucks?.teamName).toBe('Bucks');
		expect(bucks?.managerSuffix).toBe(' — Dana & Meakel');
	});

	/**
	 * The co-managed order must be STATED, and must be the same order
	 * `/teams/[teamId]` states (`server/team-view.ts:104`). Without
	 * `order by m.display_name asc` the identical Team could render
	 * `— Dana & Meakel` here and `— Meakel & Dana` on its own page, from
	 * planner order — incidental order (AD-1), and a disagreement between the
	 * two surfaces `epic-4-context.md:56` requires to agree.
	 *
	 * The fake cannot sort, so the assertion is on the SQL: both keys are
	 * named, in that order. The fixture below is reversed so the two halves
	 * cannot both be satisfied by luck.
	 */
	it('states the co-manager order in the SQL, matching the single-Team read', async () => {
		const { gateway, statements } = fakeGateway({
			events: LOG,
			teams: CO_MANAGED_REVERSED
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await loadTeamsIndex(gateway as any, null);

		const identityRead = statements.find((sql) => /from teams/i.test(sql)) ?? '';
		expect(identityRead).toContain('order by t.name asc, m.display_name asc');
		// The Manager key must not be missing, and must come after the Team's.
		expect(identityRead.indexOf('t.name asc')).toBeLessThan(
			identityRead.indexOf('m.display_name asc')
		);
	});

	/**
	 * The `left join`, driven. Every other fixture gives every Team a Manager,
	 * so swapping the join for an inner one would produce an identical row set
	 * and the suite would stay green — while a Manager-less Team vanished from
	 * production, making the index a subset.
	 */
	it('keeps a Team with NO Manager on the index, named alone', async () => {
		const { gateway } = fakeGateway({ events: LOG, teams: ONE_UNMANNED });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const index = await loadTeamsIndex(gateway as any, null);

		expect(index.rows, 'a Manager-less Team was dropped from the index').toHaveLength(2);
		const bulls = index.rows.find((entry) => entry.teamId === RIVAL);
		expect(bulls?.teamName).toBe('Bulls');
		// The Team name alone — no trailing em dash against a blank.
		expect(bulls?.managerSuffix).toBe('');
		// ...and it is counted by the median like any other Team.
		expect(index.median.availableCapSpace.coverage).toBe(2);
		expect(index.countSentence).toBe('2 Teams.');
	});

	it('marks the viewer’s own row and no other, from the SESSION’s Team', async () => {
		const { gateway } = fakeGateway({ events: LOG, teams: TWO_TEAMS });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const index = await loadTeamsIndex(gateway as any, VIEWER);
		expect(index.rows.filter((entry) => entry.isViewer)).toHaveLength(1);
		expect(index.rows.find((entry) => entry.isViewer)?.managerSuffix).toBe(OWN_ROW_MARKER);
	});

	/**
	 * The withholding, at the assembly. `teamViewFor` is called with
	 * `viewerIsThisTeam: false` for EVERY Team including the viewer's own, so
	 * the three fields never reach the payload at all and a rival's Maximum Bid
	 * cannot be recovered by subtraction.
	 */
	it('publishes no Maximum Bid, cap breakdown or Roster Reserve for anybody', async () => {
		const { gateway } = fakeGateway({ events: LOG, teams: TWO_TEAMS });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const index = await loadTeamsIndex(gateway as any, VIEWER);
		for (const entry of index.rows) {
			expect(entry).not.toHaveProperty('maximumBid');
			expect(entry).not.toHaveProperty('capBreakdown');
		}
		const payload = JSON.stringify(index);
		expect(payload).not.toContain('Maximum Bid');
		expect(payload).not.toContain('Roster Reserve');
	});
});
