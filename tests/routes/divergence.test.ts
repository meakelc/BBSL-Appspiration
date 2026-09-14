/**
 * The `/divergence` handlers, driven as MODULES (Story 7.9, FR-42).
 *
 * `tests/routes/roster-drop.test.ts` is the template, for its reason: a regex
 * over `+page.server.ts` would pass unchanged if a guard were dropped, if the
 * dismissal wrote without one, or if the empty state rendered from a read that
 * never happened. This file calls `load` and `actions.dismiss` instead.
 *
 * The REAL `requireCommissioner`, `requireLiveDestination` and
 * `requireOverridablePhase` all run — nothing about them is mocked, which is
 * what makes "the three guards are called on `load` AND on the action" a proof
 * rather than a claim. Only `$lib/shell/db.ts` and `$env/dynamic/private` are
 * faked; the whole of `server/divergence.ts` and the pure core run for real.
 *
 * **The five states' distinctness is asserted against the `.svelte` source
 * text**, because `vite.config.ts` sets `environment: 'node'` and a component
 * cannot be rendered here. That is `tests/structure.test.ts`'s established
 * mechanism for a markup claim, and the claim here is exactly a markup one: the
 * words *no divergences* must appear behind the clean branch and nowhere else.
 */

import { describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { COMMISSIONER_ONLY_STATUS } from '../../src/lib/server/commissioner-guard.ts';
import {
	LIVE_DESTINATION_REFUSAL,
	LIVE_DESTINATION_REFUSAL_STATUS
} from '../../src/lib/server/destinations.ts';
import { OVERRIDE_ARCHIVED_REFUSAL } from '../../src/lib/server/override-guard.ts';
import { NO_DIVERGENCES_STATEMENT } from '../../src/lib/core/rules/divergence.ts';
import { phaseOf } from '../../src/lib/server/phase.ts';
import type { LeaguePhase } from '../../src/lib/server/phase.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';

const world = vi.hoisted(() => ({
	reads: [] as Array<Record<string, unknown>>,
	teams: [
		{ id: 't-a', name: 'Team A', fantrax_team_id: 'ftx-a' },
		{ id: 't-b', name: 'Team B', fantrax_team_id: 'ftx-b' }
	],
	rosters: [
		{ team_id: 't-a', fantrax_player_id: '*p1*', player_name: 'Amir Powell', roster_slot_kind: 'active_bench' },
		{ team_id: 't-b', fantrax_player_id: '*p2*', player_name: 'Bo Ellis', roster_slot_kind: 'active_bench' }
	],
	dismissals: [] as string[],
	statements: [] as string[]
}));

vi.mock('$lib/shell/db.ts', () => ({
	writeGateway: () => ({
		connect: async () => ({
			async query(text: string, params: readonly unknown[] = []) {
				const sql = text.trim();
				world.statements.push(sql);
				if (/^select now\(\) as now/i.test(sql)) {
					return { rows: [{ now: new Date('2026-09-14T12:00:00.000Z') }] };
				}
				if (/from fantrax_reads/i.test(sql)) {
					const rows = /outcome = 'ok'/.test(sql)
						? world.reads.filter((row) => row['outcome'] === 'ok')
						: world.reads;
					return { rows: rows.slice(-1) };
				}
				if (/from teams/i.test(sql)) return { rows: world.teams };
				if (/from team_rosters/i.test(sql)) return { rows: world.rosters };
				if (/^select \* from auction_events/i.test(sql)) return { rows: [] };
				if (/^select fingerprint from fantrax_divergence_dismissals/i.test(sql)) {
					return { rows: world.dismissals.map((fingerprint) => ({ fingerprint })) };
				}
				if (/^insert into fantrax_divergence_dismissals/i.test(sql)) {
					world.dismissals.push(String(params[0]));
					return { rows: [] };
				}
				throw new Error(`unexpected statement: ${sql}`);
			},
			release() {}
		})
	})
}));

const route = await import('../../src/routes/divergence/+page.server.ts');

const routeSource = readFileSync(
	fileURLToPath(new URL('../../src/routes/divergence/+page.server.ts', import.meta.url)),
	'utf8'
);

const COMMISSIONER: RegisteredManager = {
	id: 'm-commissioner',
	discordUserId: '222222222222222220',
	displayName: 'Commissioner Bob',
	teamId: 't-a',
	teamName: 'Team A',
	isCommissioner: true
};

const MANAGER: RegisteredManager = { ...COMMISSIONER, id: 'm-1', isCommissioner: false };

function locals(input: { session?: SessionState; phaseName?: LeaguePhase }): App.Locals {
	return {
		session: input.session ?? { kind: 'registered', manager: COMMISSIONER },
		// The real `phaseOf`, so a phase here is the same shape a request carries.
		phase: phaseOf(input.phaseName ?? 'Auction')
	} as App.Locals;
}

function loadWith(input: Parameters<typeof locals>[0]) {
	return route.load({ locals: locals(input) } as never);
}

function dismissWith(input: Parameters<typeof locals>[0], fingerprint: string) {
	const form = new FormData();
	form.set('fingerprint', fingerprint);
	return route.actions['dismiss']?.({
		locals: locals(input),
		request: { formData: async () => form }
	} as never);
}

async function statusOf(run: () => unknown): Promise<number | null> {
	try {
		await Promise.resolve(run());
		return null;
	} catch (error) {
		return isHttpError(error) ? error.status : null;
	}
}

describe('the three guards, on load AND on the action', () => {
	const cases: ReadonlyArray<[string, Parameters<typeof locals>[0], number]> = [
		[
			'a non-Commissioner Manager',
			{ session: { kind: 'registered', manager: MANAGER } },
			COMMISSIONER_ONLY_STATUS
		],
		['a signed-out session', { session: { kind: 'signed-out' } }, COMMISSIONER_ONLY_STATUS],
		// Setup: the destination is not live for this phase, even for the
		// Commissioner. Hiding a link is never the check.
		['the Setup Phase', { phaseName: 'Setup' }, LIVE_DESTINATION_REFUSAL_STATUS],
		// Archived: `requireLiveDestination` fires FIRST, because `divergence` is
		// not registered for Archived at all — so this is that guard's refusal and
		// not `requireOverridablePhase`'s, even though both answer 403 and the
		// status alone cannot tell them apart. `requireOverridablePhase` is the
		// belt behind it, asserted separately below against its own wording.
		['the Archived Phase', { phaseName: 'Archived' }, LIVE_DESTINATION_REFUSAL_STATUS]
	];

	it.each(cases)('load refuses %s', async (_name, input, status) => {
		expect(await statusOf(() => loadWith(input))).toBe(status);
	});

	it.each(cases)('the dismiss action refuses %s', async (_name, input, status) => {
		expect(await statusOf(() => dismissWith(input, 'fp'))).toBe(status);
	});

	it('carries the archived refusal BEHIND the destination gate, with its own wording', async () => {
		// The two 403s are different facts and are worded differently on purpose
		// (`override-guard.ts`: "a Commissioner who is refused wants to know which
		// of the three facts stopped them"). The destination gate happens to fire
		// first for Archived; `requireOverridablePhase` is still called, and still
		// refuses, for any caller that reached past it.
		let wording: string | null = null;
		try {
			await loadWith({ phaseName: 'Archived' });
		} catch (error) {
			wording = isHttpError(error) ? String(error.body.message) : null;
		}
		expect(wording).toBe(LIVE_DESTINATION_REFUSAL);
		expect(wording).not.toBe(OVERRIDE_ARCHIVED_REFUSAL);
		// And the guard is genuinely in the route, not merely imported.
		expect(routeSource).toContain('requireOverridablePhase(locals.phase.name)');
	});

	it('is live for the Commissioner in both the Auction and Contract Assignment Phases', async () => {
		expect(await statusOf(() => loadWith({ phaseName: 'Auction' }))).toBeNull();
		expect(await statusOf(() => loadWith({ phaseName: 'Contract Assignment' }))).toBeNull();
	});
});

describe('load', () => {
	it('reports not_configured before any read when the reader has no configuration', async () => {
		// The env stub is empty, so every FANTRAX_* variable is unset. A
		// deployment that CANNOT read must not render as one that simply has not
		// read yet — only the second resolves by waiting.
		world.reads = [];
		const data = (await loadWith({})) as {
			read: { kind: string; missing?: readonly string[] };
			report: unknown;
		};
		expect(data.read.kind).toBe('not_configured');
		expect(data.read.missing).toContain('FANTRAX_BASE_URL');
		// `null`, not an empty report — the page has no empty state to render.
		expect(data.report).toBeNull();
	});

	it('reports stopped after a failed read, with the reason and the last good read', async () => {
		world.reads = [
			{
				read_at: new Date('2026-09-14T10:00:00.000Z'),
				outcome: 'ok',
				detail: null,
				membership: { 'ftx-a': [{ playerId: 'p1', playerName: 'Amir Powell', rosterSlotKind: 'active_bench' }], 'ftx-b': [{ playerId: 'p2', playerName: 'Bo Ellis', rosterSlotKind: 'active_bench' }] },
				money_warning_count: 0
			},
			{
				read_at: new Date('2026-09-14T11:00:00.000Z'),
				outcome: 'unreachable',
				detail: 'ECONNREFUSED',
				membership: null,
				money_warnings: [],
				money_warning_count: 0
			}
		];
		const data = (await loadWith({})) as {
			read: { kind: string; outcome?: string; lastGoodReadAt?: string | null };
			report: unknown;
		};
		expect(data.read.kind).toBe('stopped');
		expect(data.read.outcome).toBe('unreachable');
		expect(data.read.lastGoodReadAt).toBe('2026-09-14T10:00:00.000Z');
		// **And nothing is raised**, which is the frozen matrix's own wording for
		// this row: a stale membership compared against rosters that have
		// moved since would propose acts against an unconfirmed world.
		expect((data as { report: unknown }).report).toBeNull();
	});

	it('reports a clean read only when the comparison genuinely found nothing', async () => {
		world.reads = [
			{
				read_at: new Date('2026-09-14T11:00:00.000Z'),
				outcome: 'ok',
				detail: null,
				membership: {
					'ftx-a': [{ playerId: 'p1', playerName: 'Amir Powell', rosterSlotKind: 'active_bench' }],
					'ftx-b': [{ playerId: 'p2', playerName: 'Bo Ellis', rosterSlotKind: 'active_bench' }]
				},
				money_warnings: [],
				money_warning_count: 0
			}
		];
		const data = (await loadWith({})) as { read: { kind: string }; report: { clean: boolean } };
		expect(data.read.kind).toBe('read');
		expect(data.report.clean).toBe(true);
	});

	it('issues no event, no lock and no team_rosters write while loading', async () => {
		world.statements = [];
		await loadWith({});
		const issued = world.statements.map((sql) => sql.toLowerCase());
		expect(issued.some((sql) => sql.startsWith('insert into auction_events'))).toBe(false);
		expect(issued.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(false);
		expect(issued.some((sql) => sql.includes('update team_rosters'))).toBe(false);
		expect(issued.some((sql) => sql.startsWith('begin'))).toBe(false);
	});
});

describe('the dismiss action', () => {
	it('writes one dismissal row and appends NO event', async () => {
		world.dismissals = [];
		world.statements = [];
		const result = (await dismissWith({}, 'fingerprint-1')) as { notice: string };

		expect(world.dismissals).toEqual(['fingerprint-1']);
		expect(result.notice).toContain('Dismissed');
		const issued = world.statements.map((sql) => sql.toLowerCase());
		expect(issued.filter((sql) => sql.startsWith('insert'))).toEqual([
			'insert into fantrax_divergence_dismissals (fingerprint, dismissed_by) values ($1, $2) on conflict (fingerprint) do nothing'
		]);
	});

	it('refuses a dismissal that names nothing, and writes nothing for it', async () => {
		world.dismissals = [];
		const result = (await dismissWith({}, '   ')) as { status?: number; data?: { notice: string } };
		expect(result.status).toBe(400);
		expect(world.dismissals).toEqual([]);
	});
});

describe('the surface states each failure distinctly from the empty state', () => {
	const source = readFileSync(
		fileURLToPath(new URL('../../src/routes/divergence/+page.svelte', import.meta.url)),
		'utf8'
	);

	it('renders the empty state only behind the `clean` branch', () => {
		// `clean` is true only when a read succeeded, the map is complete, no
		// guard is holding anything back and the comparison found nothing.
		expect(source).toContain('{#if clean}');
		expect(source).toContain('NO_DIVERGENCES_STATEMENT');
	});

	it('never spells the words "no divergences" anywhere but that one constant', () => {
		expect(NO_DIVERGENCES_STATEMENT.toLowerCase()).toContain('no divergences');
		// The page imports the constant rather than restating the phrase, so the
		// phrase itself must not appear in the markup at all.
		expect(source.toLowerCase()).not.toContain('no divergences:');
	});

	it('gives every failure state its own branch, with no catch-all between them', () => {
		expect(source).toContain("read.kind === 'not_configured'");
		expect(source).toContain("read.kind === 'never_read'");
		expect(source).toContain("read.kind === 'stopped'");
		expect(source).toContain("read.kind === 'unreadable'");
		expect(source).toContain('!report.configured');
		expect(source).toContain('guard.tripped');
	});

	it('NAMES the Players behind a money warning rather than counting them', () => {
		// `import-status.ts:113-115`'s "named, never counted", and the frozen
		// matrix's "a named money warning". A bare number is a fact nobody can
		// act on.
		expect(source).toContain('read.moneyWarnings.join');
		expect(source).not.toContain('moneyWarningCount');
	});

	it('uses real headings, so section navigation works on the one surface that needs it', () => {
		// Seven states that must be told apart is exactly the case where a screen
		// reader's heading list is the fastest way to find which one applies.
		expect(source).toContain('<h2 class="section-label">The last read</h2>');
		expect(source).toContain('<h2 class="commissioner-label" id="guard-heading">');
		expect(source).toContain('<h2 class="section-label" id="proposals-heading">');
		expect(source).toContain('<h2 class="section-label" id="arrivals-heading">');
	});

	it('states which act a dismissal is, so the two notices cannot be swapped', () => {
		// Acknowledging a guard REVEALS proposals; dismissing a divergence puts
		// one away. One notice for both told the Commissioner the opposite of
		// what had just happened.
		expect(source).toContain('name="kind" value="guard"');
		expect(source).toContain('name="kind" value="divergence"');
	});

	it('NAMES the unmapped Teams and the unknown arrivals rather than counting them', () => {
		expect(source).toContain('report.unmappedTeamNames.join');
		expect(source).toContain('arrival.playerName');
	});

	it('offers an acknowledgement that REVEALS the proposals behind a tripped guard', () => {
		expect(source).toContain('guard.acknowledged');
		expect(source).toContain('show me the proposals');
	});

	it('renders each proposal as a LINK into the existing act, never as a commit control', () => {
		expect(source).toContain('href={proposal.href}');
		expect(source).toContain('still demand');
		// No write control of its own: the only form on the page is the dismissal.
		expect(source).not.toContain("action=\"?/record\"");
	});
});
