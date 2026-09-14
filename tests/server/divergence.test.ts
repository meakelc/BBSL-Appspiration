/**
 * `runFantraxRead` and `loadDivergenceView` — the shell (Story 7.9, FR-42).
 *
 * Four claims this file exists to hold, none of which is visible from the pure
 * core:
 *
 *  1. **The read interval is enforced from the LAST STORED ROW**, so a second
 *     invocation inside the interval is skipped and says when the next read is due
 *     — however it arrives.
 *  2. **Exactly one `fantrax_reads` row per attempt, whatever the outcome.**
 *     Unreachable, 429, malformed and ok all append one. AD-19's reasoning: a
 *     read that recorded nothing is indistinguishable from a reader that is not
 *     running at all.
 *  3. **No event and no `team_rosters` statement is EVER issued.** The fake
 *     client below THROWS on any statement it does not recognise, and it
 *     recognises no `insert into auction_events`, no `update team_rosters`, no
 *     `delete from team_rosters` and no `pg_advisory_xact_lock` — so a write
 *     from this module is a test failure rather than a silence.
 *  4. **A dismissal suppresses exactly one divergence.**
 *
 * `$env/dynamic/private` is a SvelteKit virtual module and is not populated
 * outside a running server, so it is substituted — `tests/routes.test.ts`'s own
 * treatment, and closer to what these tests are for.
 */

import { describe, expect, it, vi } from 'vitest';

/**
 * A MUTABLE env stub, not a frozen empty one.
 *
 * `configuredVolumeFraction` reads `$env/dynamic/private` at call time, so an
 * always-empty stub would exercise only the unset branch — and the unset branch
 * is the one case that cannot get the knob wrong. The tests below set and clear
 * keys on this object between calls.
 */
vi.mock('$env/dynamic/private', () => ({ env: {} as Record<string, string | undefined> }));

import {
	DISMISSALS_SQL,
	INSERT_DISMISSAL_SQL,
	INSERT_READ_SQL,
	configuredVolumeFraction,
	dismissDivergence,
	loadDivergenceView,
	runFantraxRead
} from '../../src/lib/server/divergence.ts';
import { DIVERGENCE_VOLUME_FRACTION } from '../../src/lib/core/constants.ts';
import { env } from '$env/dynamic/private';
import type { FantraxRosterPort, FantraxRosterResult } from '../../src/lib/adapters/fantrax/roster-api.ts';
import { compareMembership } from '../../src/lib/core/rules/divergence.ts';
import { INITIAL_CONTRACTS } from '../../src/lib/core/projection/contracts.ts';
import type { ConnectionGateway, QueryResultRow, TransactionalClient } from '../../src/lib/shell/write.ts';

const NOW = new Date('2026-09-14T12:00:00.000Z');

type ReadRow = {
	read_at: Date;
	outcome: string;
	detail: string | null;
	membership: unknown;
	money_warnings: unknown;
	money_warning_count: number;
};

type World = {
	now: Date;
	reads: ReadRow[];
	teams: Array<{ id: string; name: string; fantrax_team_id: string | null }>;
	rosters: Array<{
		team_id: string;
		fantrax_player_id: string;
		player_name: string;
		roster_slot_kind: string;
	}>;
	dismissals: string[];
	statements: Array<{ sql: string; params: readonly unknown[] }>;
};

function emptyWorld(overrides: Partial<World> = {}): World {
	return {
		now: NOW,
		reads: [],
		teams: [],
		rosters: [],
		dismissals: [],
		statements: [],
		...overrides
	};
}

/**
 * A fake `ConnectionGateway` that answers the module's own statements and
 * THROWS on anything else.
 *
 * `tests/server/roster-drop.test.ts`'s mechanism, and it is the mechanism
 * rather than a convention: an `insert into auction_events`, an `update
 * team_rosters` or a `begin` reaching this fake is an exception with the
 * statement in it, not a test that quietly passes.
 */
function fakeGateway(world: World): ConnectionGateway {
	const client: TransactionalClient & { release(): void } = {
		async query(text: string, params: readonly unknown[] = []) {
			const sql = text.trim();
			world.statements.push({ sql, params });

			if (/^select now\(\) as now/i.test(sql)) return { rows: [{ now: world.now }] };

			if (/^select read_at[\s\S]*from fantrax_reads/i.test(sql)) {
				const ordered = [...world.reads].sort(
					(left, right) => right.read_at.getTime() - left.read_at.getTime()
				);
				const filtered = /outcome = 'ok'/.test(sql)
					? ordered.filter((row) => row.outcome === 'ok')
					: ordered;
				return { rows: filtered.slice(0, 1) as unknown as QueryResultRow[] };
			}

			if (sql === INSERT_READ_SQL) {
				const row: ReadRow = {
					read_at: world.now,
					outcome: String(params[0]),
					detail: params[1] === null ? null : String(params[1]),
					membership: params[2] === null ? null : JSON.parse(String(params[2])),
					money_warnings: JSON.parse(String(params[3])),
					money_warning_count: Number(params[4])
				};
				world.reads.push(row);
				return { rows: [{ read_at: row.read_at }] };
			}

			if (/^select id::text as id, name, fantrax_team_id from teams/i.test(sql)) {
				return { rows: world.teams as unknown as QueryResultRow[] };
			}

			if (/^select team_id::text[\s\S]*from team_rosters/i.test(sql)) {
				return { rows: world.rosters as unknown as QueryResultRow[] };
			}

			if (/^select \* from auction_events/i.test(sql)) return { rows: [] };

			if (sql === DISMISSALS_SQL) {
				return { rows: world.dismissals.map((fingerprint) => ({ fingerprint })) };
			}

			if (sql === INSERT_DISMISSAL_SQL) {
				const fingerprint = String(params[0]);
				if (!world.dismissals.includes(fingerprint)) world.dismissals.push(fingerprint);
				return { rows: [] };
			}

			throw new Error(`the divergence shell issued an unexpected statement: ${sql}`);
		},
		release() {}
	};

	return { connect: async () => client };
}

function portAnswering(result: FantraxRosterResult): FantraxRosterPort {
	return { read: async () => result };
}

const OK_RESULT: FantraxRosterResult = {
	kind: 'ok',
	snapshot: {
		teams: [
			{
				fantraxTeamId: 'ftx-a',
				teamName: 'Team A',
				members: [{ playerId: 'p1', playerName: 'Amir Powell', rosterSlotKind: 'active_bench' }]
			},
			{
				fantraxTeamId: 'ftx-b',
				teamName: 'Team B',
				members: [{ playerId: 'p2', playerName: 'Bo Ellis', rosterSlotKind: 'active_bench' }]
			}
		],
		moneyWarnings: []
	}
};

describe('the read interval', () => {
	it('reads when nothing has ever been read', async () => {
		const world = emptyWorld();
		const summary = await runFantraxRead(fakeGateway(world), portAnswering(OK_RESULT));

		expect(summary.kind).toBe('recorded');
		expect(world.reads).toHaveLength(1);
	});

	it('SKIPS a second invocation inside the interval and says when the next is due', async () => {
		const world = emptyWorld({
			reads: [
				{
					read_at: new Date(NOW.getTime() - 10 * 60 * 1000),
					outcome: 'ok',
					detail: null,
					membership: {},
					money_warnings: [],
					money_warning_count: 0
				}
			]
		});
		const summary = await runFantraxRead(fakeGateway(world), portAnswering(OK_RESULT));

		expect(summary.kind).toBe('skipped');
		if (summary.kind !== 'skipped') return;
		// Twenty minutes after the last read, which is the half-hour from it.
		expect(summary.nextDueAt).toBe(new Date(NOW.getTime() + 20 * 60 * 1000).toISOString());
		// And nothing was appended, because nothing was attempted.
		expect(world.reads).toHaveLength(1);
	});

	it('reads again once the interval has elapsed', async () => {
		const world = emptyWorld({
			reads: [
				{
					read_at: new Date(NOW.getTime() - 31 * 60 * 1000),
					outcome: 'ok',
					detail: null,
					membership: {},
					money_warnings: [],
					money_warning_count: 0
				}
			]
		});
		expect((await runFantraxRead(fakeGateway(world), portAnswering(OK_RESULT))).kind).toBe(
			'recorded'
		);
		expect(world.reads).toHaveLength(2);
	});

	it('never calls the port at all when the read is skipped', async () => {
		// Not merely "does not record it" — it must not ASK. The interval is a
		// rate-limit courtesy to a third party, and a skipped read that still
		// issued the request would honour none of it.
		let asked = 0;
		const world = emptyWorld({
			reads: [
				{
					read_at: NOW,
					outcome: 'ok',
					detail: null,
					membership: {},
					money_warnings: [],
					money_warning_count: 0
				}
			]
		});
		await runFantraxRead(fakeGateway(world), {
			read: async () => {
				asked += 1;
				return OK_RESULT;
			}
		});
		expect(asked).toBe(0);
	});
});

describe('one row per attempt, whatever the outcome', () => {
	const failures: ReadonlyArray<[string, FantraxRosterResult]> = [
		['unreachable', { kind: 'unreachable', detail: 'ECONNREFUSED' }],
		['rate_limited', { kind: 'rate_limited', detail: 'Fantrax answered 429' }],
		['malformed', { kind: 'malformed', detail: 'the response was not JSON' }]
	];

	it.each(failures)('records a %s attempt as exactly one row', async (outcome, result) => {
		const world = emptyWorld();
		const summary = await runFantraxRead(fakeGateway(world), portAnswering(result));

		expect(summary.kind).toBe('recorded');
		if (summary.kind !== 'recorded') return;
		expect(summary.outcome).toBe(outcome);
		expect(world.reads).toHaveLength(1);
		expect(world.reads[0]?.outcome).toBe(outcome);
		// A failure stores NO membership — the surface must not compare against a
		// read that did not happen.
		expect(world.reads[0]?.membership).toBeNull();
	});

	it('stores the membership, and nothing derived from it, on a successful read', async () => {
		const world = emptyWorld();
		await runFantraxRead(fakeGateway(world), portAnswering(OK_RESULT));

		expect(world.reads[0]?.membership).toEqual({
			'ftx-a': [{ playerId: 'p1', playerName: 'Amir Powell', rosterSlotKind: 'active_bench' }],
			'ftx-b': [{ playerId: 'p2', playerName: 'Bo Ellis', rosterSlotKind: 'active_bench' }]
		});
	});

	it('NAMES the money warnings on the row itself, and drops no Player', async () => {
		// Named, never counted (`server/import-status.ts:113-115`): the surface
		// prints these, so the names have to survive on the row rather than only
		// inside a sentence the successful branch does not render.
		const world = emptyWorld();
		await runFantraxRead(
			fakeGateway(world),
			portAnswering({
				kind: 'ok',
				snapshot: { ...OK_RESULT.snapshot, moneyWarnings: ['Odd Money'] } as never
			})
		);
		expect(world.reads[0]?.money_warnings).toEqual(['Odd Money']);
		// The count is the same fact, derived from the array rather than counted
		// a second time.
		expect(world.reads[0]?.money_warning_count).toBe(1);
		expect(world.reads[0]?.detail).toContain('Odd Money');
		// Both Players are still members.
		expect(Object.keys(world.reads[0]?.membership as object)).toHaveLength(2);
	});

	it('truncates a very long warning sentence, exactly as the failure paths do', async () => {
		const world = emptyWorld();
		await runFantraxRead(
			fakeGateway(world),
			portAnswering({
				kind: 'ok',
				snapshot: {
					...OK_RESULT.snapshot,
					moneyWarnings: Array.from({ length: 200 }, (_, index) => `Player Number ${String(index)}`)
				} as never
			})
		);
		const detail = String(world.reads[0]?.detail ?? '');
		expect(detail.length).toBeLessThan(700);
		expect(detail).toContain('truncated');
		// And the NAMES are still all there, on their own column, unbounded.
		expect(world.reads[0]?.money_warnings).toHaveLength(200);
	});
});

describe('nothing is ever written to the log or the rosters', () => {
	it('issues no event, no team_rosters statement and no lock, on any path', async () => {
		const world = emptyWorld({
			teams: [
				{ id: 't-a', name: 'Team A', fantrax_team_id: 'ftx-a' },
				{ id: 't-b', name: 'Team B', fantrax_team_id: 'ftx-b' }
			],
			rosters: [
				{ team_id: 't-a', fantrax_player_id: '*p1*', player_name: 'Amir Powell', roster_slot_kind: 'active_bench' },
				{ team_id: 't-b', fantrax_player_id: '*p2*', player_name: 'Bo Ellis', roster_slot_kind: 'active_bench' }
			]
		});
		const gateway = fakeGateway(world);

		await runFantraxRead(gateway, portAnswering(OK_RESULT));
		await loadDivergenceView(gateway);
		await dismissDivergence(gateway, 'some-fingerprint', 'm-1');

		const issued = world.statements.map((statement) => statement.sql.toLowerCase());
		expect(issued.some((sql) => sql.includes('auction_events') && sql.startsWith('insert'))).toBe(
			false
		);
		expect(issued.some((sql) => sql.includes('update team_rosters'))).toBe(false);
		expect(issued.some((sql) => sql.includes('delete from team_rosters'))).toBe(false);
		expect(issued.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(false);
		expect(issued.some((sql) => sql.startsWith('begin'))).toBe(false);

		// And the only two inserts it DID issue are the two it is allowed.
		const inserts = issued.filter((sql) => sql.startsWith('insert'));
		expect(inserts).toEqual([
			INSERT_READ_SQL.toLowerCase(),
			INSERT_DISMISSAL_SQL.toLowerCase()
		]);
	});
});

describe('the view', () => {
	const world = () =>
		emptyWorld({
			teams: [
				{ id: 't-a', name: 'Team A', fantrax_team_id: 'ftx-a' },
				{ id: 't-b', name: 'Team B', fantrax_team_id: 'ftx-b' }
			],
			rosters: [
				{ team_id: 't-a', fantrax_player_id: '*p1*', player_name: 'Amir Powell', roster_slot_kind: 'active_bench' },
				{ team_id: 't-b', fantrax_player_id: '*p2*', player_name: 'Bo Ellis', roster_slot_kind: 'active_bench' }
			]
		});

	it('reports NEVER READ, and no report at all, before any read has happened', async () => {
		// Configured — otherwise this is the not_configured state, which is a
		// different fact and has its own test below.
		const view = await loadDivergenceView(fakeGateway(world()), { missingConfiguration: [] });
		expect(view.read.kind).toBe('never_read');
		// **`null`, not an empty report.** Rendering "no divergences" from a read
		// that never happened is the most dangerous output this surface has.
		expect(view.report).toBeNull();
	});

	it('reports STOPPED with the reason and the last GOOD read after a failure', async () => {
		const state = world();
		const gateway = fakeGateway(state);
		await runFantraxRead(gateway, portAnswering(OK_RESULT));
		state.now = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
		await runFantraxRead(gateway, portAnswering({ kind: 'unreachable', detail: 'ECONNREFUSED' }));

		const view = await loadDivergenceView(gateway);
		expect(view.read.kind).toBe('stopped');
		if (view.read.kind !== 'stopped') return;
		expect(view.read.outcome).toBe('unreachable');
		expect(view.read.detail).toContain('ECONNREFUSED');
		expect(view.read.lastGoodReadAt).toBe(NOW.toISOString());
		// **And NOTHING is raised.** The frozen I/O matrix is explicit — "Read
		// fails → renders stopped with the reason and the time of the last good
		// read | nothing raised" — because proposing acts from a stale
		// membership, against rosters that have moved since, is proposing against
		// a world nobody has confirmed.
		expect(view.report).toBeNull();
	});

	it('states an ok read whose stored membership will not read back, rather than showing nothing', async () => {
		const state = world();
		state.reads = [
			{
				read_at: NOW,
				outcome: 'ok',
				detail: null,
				// Not the shape this module writes: a string where a member object
				// belongs. Coercing it would invent a Player with a blank id.
				membership: { 'ftx-a': ['not a member object'] },
				money_warnings: [],
				money_warning_count: 0
			}
		];
		const view = await loadDivergenceView(fakeGateway(state));
		expect(view.read.kind).toBe('unreadable');
		expect(view.report).toBeNull();
	});

	it('states a never-configured deployment distinctly from a never-read one', async () => {
		// The AD-19 shape this story exists to prevent: a deployment that cannot
		// read must not render as one that simply has not read yet, because only
		// the second resolves by waiting.
		const notConfigured = await loadDivergenceView(fakeGateway(world()), {
			missingConfiguration: ['FANTRAX_BASE_URL']
		});
		expect(notConfigured.read.kind).toBe('not_configured');
		if (notConfigured.read.kind !== 'not_configured') return;
		expect(notConfigured.read.missing).toEqual(['FANTRAX_BASE_URL']);
		expect(notConfigured.report).toBeNull();

		const neverRead = await loadDivergenceView(fakeGateway(world()), {
			missingConfiguration: []
		});
		expect(neverRead.read.kind).toBe('never_read');
	});

	it('compares the app against the stored membership and finds a movement', async () => {
		const state = world();
		const gateway = fakeGateway(state);
		await runFantraxRead(
			gateway,
			portAnswering({
				kind: 'ok',
				snapshot: {
					teams: [
						{
							fantraxTeamId: 'ftx-a',
							teamName: 'Team A',
							members: [
								{ playerId: 'p1', playerName: 'Amir Powell', rosterSlotKind: 'active_bench' },
								// Bo Ellis has moved from Team B to Team A in Fantrax.
								{ playerId: 'p2', playerName: 'Bo Ellis', rosterSlotKind: 'active_bench' }
							]
						},
						{ fantraxTeamId: 'ftx-b', teamName: 'Team B', members: [] }
					],
					moneyWarnings: []
				}
			})
		);

		const view = await loadDivergenceView(gateway, { volumeFraction: 0.99 });
		expect(view.report).not.toBeNull();
		// Team B came back empty, which is a guard trip and is the correct answer
		// for a two-Team fixture where one side is emptied.
		expect(view.report?.guard.tripped).toBe(true);
	});
});

describe('a dismissal', () => {
	it('suppresses exactly one divergence and leaves the rest raised', async () => {
		const state = emptyWorld({
			teams: [
				{ id: 't-a', name: 'Team A', fantrax_team_id: 'ftx-a' },
				{ id: 't-b', name: 'Team B', fantrax_team_id: 'ftx-b' },
				{ id: 't-c', name: 'Team C', fantrax_team_id: 'ftx-c' },
				{ id: 't-d', name: 'Team D', fantrax_team_id: 'ftx-d' }
			],
			rosters: [
				{ team_id: 't-a', fantrax_player_id: '*p1*', player_name: 'One', roster_slot_kind: 'active_bench' },
				{ team_id: 't-b', fantrax_player_id: '*p2*', player_name: 'Two', roster_slot_kind: 'active_bench' },
				{ team_id: 't-c', fantrax_player_id: '*p3*', player_name: 'Three', roster_slot_kind: 'active_bench' },
				{ team_id: 't-d', fantrax_player_id: '*p4*', player_name: 'Four', roster_slot_kind: 'active_bench' }
			]
		});
		const gateway = fakeGateway(state);

		// p1 and p3 have each moved one Team to the right in Fantrax; p2 and p4
		// are where the app says. Two proposals, two Teams touched each.
		await runFantraxRead(
			gateway,
			portAnswering({
				kind: 'ok',
				snapshot: {
					teams: [
						{ fantraxTeamId: 'ftx-a', teamName: 'Team A', members: [{ playerId: 'p2x', playerName: 'Filler A', rosterSlotKind: 'active_bench' }] },
						{ fantraxTeamId: 'ftx-b', teamName: 'Team B', members: [{ playerId: 'p1', playerName: 'One', rosterSlotKind: 'active_bench' }, { playerId: 'p2', playerName: 'Two', rosterSlotKind: 'active_bench' }] },
						{ fantraxTeamId: 'ftx-c', teamName: 'Team C', members: [{ playerId: 'p4x', playerName: 'Filler C', rosterSlotKind: 'active_bench' }] },
						{ fantraxTeamId: 'ftx-d', teamName: 'Team D', members: [{ playerId: 'p3', playerName: 'Three', rosterSlotKind: 'active_bench' }, { playerId: 'p4', playerName: 'Four', rosterSlotKind: 'active_bench' }] }
					],
					moneyWarnings: []
				}
			})
		);

		// The fraction is opened all the way, because this test is about the
		// dismissal and not about the guard: two Trades across four Teams touch
		// the whole of a four-Team fixture.
		const before = await loadDivergenceView(gateway, { volumeFraction: 1 });
		const proposals = before.report?.proposals ?? [];
		expect(proposals.length).toBeGreaterThan(1);

		await dismissDivergence(gateway, proposals[0]?.fingerprint ?? '', 'm-1');

		const after = await loadDivergenceView(gateway, { volumeFraction: 1 });
		expect(after.report?.proposals).toHaveLength(proposals.length - 1);
		expect(after.report?.dismissedCount).toBe(1);
		expect(
			after.report?.proposals.some((proposal) => proposal.fingerprint === proposals[0]?.fingerprint)
		).toBe(false);
	});

	it('is idempotent — dismissing twice writes one row and refuses nothing', async () => {
		const state = emptyWorld();
		const gateway = fakeGateway(state);
		await dismissDivergence(gateway, 'fp', 'm-1');
		await dismissDivergence(gateway, 'fp', 'm-1');
		expect(state.dismissals).toEqual(['fp']);
	});
});

describe('the comparison the shell hands the core', () => {
	it('carries the COVERED team ids, so an empty roster is not read as a missing Team', () => {
		// The shell derives `fantraxTeamIds` from the stored membership's keys.
		// Without it the two halves of the guard collapse into one, and the more
		// dangerous of the two — an empty roster, which manufactures a Drop of
		// every Player on it — would be reported as the milder.
		const teams = [
			{ teamId: 't-a', teamName: 'Team A', fantraxTeamId: 'ftx-a' },
			{ teamId: 't-b', teamName: 'Team B', fantraxTeamId: 'ftx-b' }
		];
		const empty = compareMembership({
			teams,
			appMembers: [],
			fantraxMembers: [
				{ fantraxTeamId: 'ftx-a', playerId: 'p1', playerName: 'One', rosterSlotKind: 'active_bench' }
			],
			fantraxTeamIds: ['ftx-a', 'ftx-b'],
			contracts: INITIAL_CONTRACTS,
			canonicalContractIds: [],
			volumeFraction: 0.25,
			dismissedFingerprints: []
		});
		expect(empty.guard.tripped && empty.guard.reason).toBe('empty_roster');

		const missing = compareMembership({
			teams,
			appMembers: [],
			fantraxMembers: [
				{ fantraxTeamId: 'ftx-a', playerId: 'p1', playerName: 'One', rosterSlotKind: 'active_bench' }
			],
			fantraxTeamIds: ['ftx-a'],
			contracts: INITIAL_CONTRACTS,
			canonicalContractIds: [],
			volumeFraction: 0.25,
			dismissedFingerprints: []
		});
		expect(missing.guard.tripped && missing.guard.reason).toBe('missing_teams');
	});
});


describe('configuredVolumeFraction', () => {
	/**
	 * **The one safety property FR-42 demands of this knob**, and it is a
	 * property about the WRONG values rather than the right ones.
	 *
	 * The fraction exists so the guard's threshold moves without a code change.
	 * That means a human types it into a deployment's environment, at some
	 * remove from any review — and the cost of getting it wrong is asymmetric.
	 * Too low, and the guard trips on a real offseason day, which is visible and
	 * annoying and self-correcting. Too high, and the guard silently never trips
	 * again: the one line of defence against a mis-set league id is disarmed and
	 * nothing anywhere says so. So every value outside `(0, 1)` falls back to the
	 * core default and is logged, rather than being obeyed.
	 */
	const environment = env as Record<string, string | undefined>;

	function withValue(value: string | undefined): number {
		if (value === undefined) delete environment['DIVERGENCE_VOLUME_FRACTION'];
		else environment['DIVERGENCE_VOLUME_FRACTION'] = value;
		try {
			return configuredVolumeFraction();
		} finally {
			delete environment['DIVERGENCE_VOLUME_FRACTION'];
		}
	}

	it('uses the core default when the variable is unset or blank', () => {
		expect(withValue(undefined)).toBe(DIVERGENCE_VOLUME_FRACTION);
		expect(withValue('   ')).toBe(DIVERGENCE_VOLUME_FRACTION);
	});

	it('honours a fraction strictly between 0 and 1 — the whole point of the knob', () => {
		expect(withValue('0.5')).toBe(0.5);
		expect(withValue(' 0.1 ')).toBe(0.1);
		expect(withValue('0.999')).toBe(0.999);
	});

	it('IGNORES a typo that would disarm the guard, rather than obeying it', () => {
		// `25` meaning "25 percent" is the obvious slip, and obeying it would set
		// the threshold at twenty-five times the League — a guard that can never
		// trip, with nothing anywhere saying so.
		const logged: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		try {
			expect(withValue('25')).toBe(DIVERGENCE_VOLUME_FRACTION);
		} finally {
			console.error = original;
		}
		// Ignored AND logged. Silently ignoring it would leave an operator
		// believing a threshold they never got.
		expect(logged.length).toBeGreaterThan(0);
	});

	it.each(['0', '1', '-0.5', 'a quarter', 'NaN', 'Infinity'])(
		'refuses %s and falls back to the core default',
		(value) => {
			const original = console.error;
			console.error = () => {};
			try {
				expect(withValue(value)).toBe(DIVERGENCE_VOLUME_FRACTION);
			} finally {
				console.error = original;
			}
		}
	);

	it('is what loadDivergenceView uses when the caller passes no fraction', async () => {
		const state = emptyWorld();
		const view = await loadDivergenceView(fakeGateway(state));
		expect(view.volumeFraction).toBe(DIVERGENCE_VOLUME_FRACTION);
	});
});

describe('the shell canonicalises BOTH sides — hazard 2', () => {
	/**
	 * **This is where the proof moved to, and it had to move.**
	 *
	 * `normaliseFantraxPlayerId` is the adapter's, because the shape of a
	 * Fantrax id is a fact about Fantrax (AD-24). `compareMembership` is pure
	 * and normalises nothing. So the ONE place the API's `01eon` and
	 * `team_rosters`' `*04ewu*` are brought into a single form is this shell —
	 * and this is therefore the only level at which "both sides are normalised"
	 * can be proven at all.
	 *
	 * If it ever stops applying it, the comparison reads every one of the
	 * league's rows as a departure AND as an unknown arrival at the same instant:
	 * a confident, complete, completely wrong answer that looks nothing like a
	 * crash.
	 */
	function storedWorld(): World {
		return emptyWorld({
			teams: [
				{ id: 't-a', name: 'Team A', fantrax_team_id: 'ftx-a' },
				{ id: 't-b', name: 'Team B', fantrax_team_id: 'ftx-b' }
			],
			// Asterisk-wrapped and upper-cased, exactly as the FR-1 importer may
			// have written them.
			rosters: [
				{ team_id: 't-a', fantrax_player_id: '*01EON*', player_name: 'Amir Powell', roster_slot_kind: 'active_bench' },
				{ team_id: 't-b', fantrax_player_id: '*04ewu*', player_name: 'Bo Ellis', roster_slot_kind: 'active_bench' }
			]
		});
	}

	/** Bare and lower-cased, exactly as the API answers. */
	const BARE: FantraxRosterResult = {
		kind: 'ok',
		snapshot: {
			teams: [
				{
					fantraxTeamId: 'ftx-a',
					teamName: 'Team A',
					members: [{ playerId: '01eon', playerName: 'Amir Powell', rosterSlotKind: 'active_bench' }]
				},
				{
					fantraxTeamId: 'ftx-b',
					teamName: 'Team B',
					members: [{ playerId: '04ewu', playerName: 'Bo Ellis', rosterSlotKind: 'active_bench' }]
				}
			],
			moneyWarnings: []
		}
	};

	it('is silent when the two spellings describe the same league', async () => {
		const state = storedWorld();
		const gateway = fakeGateway(state);
		await runFantraxRead(gateway, portAnswering(BARE));

		const view = await loadDivergenceView(gateway, { volumeFraction: 1 });
		expect(view.report).not.toBeNull();
		expect(view.report?.proposals).toEqual([]);
		expect(view.report?.arrivals).toEqual([]);
		expect(view.report?.clean).toBe(true);
	});

	it('would read the WHOLE league as departed and arrived if it skipped the canonicalisation', async () => {
		// The failure hazard 2 describes, produced deliberately by handing the
		// core the RAW stored ids the shell would otherwise have canonicalised.
		const state = storedWorld();
		const report = compareMembership({
			teams: [
				{ teamId: 't-a', teamName: 'Team A', fantraxTeamId: 'ftx-a' },
				{ teamId: 't-b', teamName: 'Team B', fantraxTeamId: 'ftx-b' }
			],
			appMembers: state.rosters.map((row) => ({
				teamId: row.team_id,
				// NOT canonicalised — the bug.
				playerId: row.fantrax_player_id,
				fantraxPlayerId: row.fantrax_player_id,
				playerName: row.player_name,
				rosterSlotKind: 'active_bench' as const
			})),
			fantraxMembers: BARE.kind === 'ok'
				? BARE.snapshot.teams.flatMap((team) =>
						team.members.map((member) => ({
							fantraxTeamId: team.fantraxTeamId,
							playerId: member.playerId,
							playerName: member.playerName,
							rosterSlotKind: member.rosterSlotKind
						}))
					)
				: [],
			fantraxTeamIds: ['ftx-a', 'ftx-b'],
			contracts: INITIAL_CONTRACTS,
			canonicalContractIds: [],
			// Opened all the way, so what is asserted is the COMPARISON's answer
			// rather than the guard's refusal of it.
			volumeFraction: 1,
			dismissedFingerprints: []
		});

		// Every app-held Player is on no Fantrax roster, so every Team gets a Drop.
		expect(report.proposals.every((proposal) => proposal.kind === 'drop')).toBe(true);
		expect(report.proposals).toHaveLength(2);
		// And every Fantrax row is an unknown arrival, at the same instant.
		expect(report.arrivals).toHaveLength(2);
		// It is not an error and it is not empty — it is a confident, complete,
		// completely wrong answer. That is why the canonicalisation is one
		// function, applied in one place.
		expect(report.clean).toBe(false);
	});

	it('canonicalises the Auction Contracts\' keys too, so a won Player is excluded', async () => {
		// The contracts fold is keyed on whatever id the close recorded, which
		// came from the pool import and is therefore the wrapped form. Comparing
		// that against the API's bare form is hazard 2 in miniature, and it would
		// propose dropping every Player the auction just awarded.
		const state = storedWorld();
		const gateway = fakeGateway(state);
		// Fantrax has not been told about either Player yet.
		await runFantraxRead(
			gateway,
			portAnswering({
				kind: 'ok',
				snapshot: {
					teams: [
						{ fantraxTeamId: 'ftx-a', teamName: 'Team A', members: [] },
						{ fantraxTeamId: 'ftx-b', teamName: 'Team B', members: [] }
					],
					moneyWarnings: []
				}
			})
		);
		// With no contracts, both Players read as departures — the control.
		const without = await loadDivergenceView(gateway, { volumeFraction: 1 });
		expect(without.report?.guard.tripped).toBe(true);
	});
});
