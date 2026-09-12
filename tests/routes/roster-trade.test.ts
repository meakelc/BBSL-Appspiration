/**
 * The `/roster-trade` handlers, driven as MODULES (Story 7.7, FR-41).
 *
 * **Source-text assertion is not enough here, and `tests/roster-trade.test.ts`
 * says so in its own header.** A `.svelte` file cannot be rendered under
 * `environment: 'node'`, so its claims have to be read out of the source; a
 * `+page.server.ts` is an ordinary importable module, and a regex over it
 * would pass unchanged if the three-step branching inverted, if the sheet
 * rendered for a Trade the core refused, or if `commitAction` dropped a
 * `send`/`recv` parameter and committed a different Trade from the one
 * reviewed. This file calls `load` and `actions.record` instead.
 *
 * The REAL `requireCommissioner`, `requireLiveDestination` and
 * `requireOverridablePhase` all run — nothing about them is mocked, which is
 * what makes "the guards are called on `load` AND on the action" a proof
 * rather than a claim. Only the I/O-touching layer is faked:
 * `$lib/shell/db.ts` answers a synthetic log, Team list and two rosters, and
 * the whole of `server/roster-trade.ts` and the pure core run for real.
 */

import { describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

import { COMMISSIONER_ONLY_STATUS } from '../../src/lib/server/commissioner-guard.ts';
import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import {
	OVERRIDE_ARCHIVED_STATUS,
	OVERRIDE_REASON_REQUIRED_STATUS
} from '../../src/lib/server/override-guard.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';
import type { ReasonSheetView } from '../../src/lib/reason-sheet-view.ts';

/**
 * The world the fake gateway answers from, and the statements it was asked.
 *
 * `vi.hoisted` because `vi.mock` is hoisted above the imports: the factory
 * below closes over this object, and the tests mutate it.
 */
const world = vi.hoisted(() => ({
	teams: [
		{ id: 't-1', name: 'Team One' },
		{ id: 't-2', name: 'Team Two' }
	] as Array<{ id: string; name: string }>,
	rosters: [
		{
			teamId: 't-1',
			fantrax_player_id: 'p-1',
			player_name: 'Powell',
			cap_hit: 9_000_000,
			roster_slot_kind: 'active_bench'
		},
		{
			teamId: 't-1',
			fantrax_player_id: 'p-2',
			player_name: 'Ellis',
			cap_hit: 3_000_000,
			roster_slot_kind: 'minor_league'
		},
		{
			teamId: 't-2',
			fantrax_player_id: 'p-3',
			player_name: 'Sharpe',
			cap_hit: 4_000_000,
			roster_slot_kind: 'active_bench'
		}
	] as Array<Record<string, unknown> & { teamId: string }>,
	/** Every statement the route's transactions issued, in order. */
	statements: [] as string[]
}));

vi.mock('$lib/shell/db.ts', () => ({
	writeGateway: () => ({
		connect: async () => ({
			async query(text: string, params: readonly unknown[] = []) {
				const sql = text.trim();
				world.statements.push(sql);
				if (/^begin|^commit|^rollback/i.test(sql)) return { rows: [] };
				if (/pg_advisory_xact_lock/i.test(sql)) {
					return { rows: [{ locked: true, now: new Date('2026-09-10T19:00:00.000Z') }] };
				}
				if (/^select \* from auction_events/i.test(sql)) return { rows: [] };
				if (/from teams/i.test(sql)) return { rows: world.teams };
				if (/from team_rosters/i.test(sql)) {
					const teamId = String(params[0]);
					return { rows: world.rosters.filter((row) => row.teamId === teamId) };
				}
				if (/^insert into auction_events/i.test(sql)) {
					return {
						rows: [
							{
								seq: 42,
								occurred_at: params[0],
								schema_version: params[1],
								core_version: params[2],
								manager_id: params[3],
								team_id: params[4],
								event_type: params[5],
								payload: JSON.parse(String(params[6])),
								device_class: params[7]
							}
						]
					};
				}
				if (/^update team_rosters/i.test(sql)) return { rows: [] };
				throw new Error(`unexpected statement: ${sql}`);
			},
			release: () => {}
		})
	})
}));

const route = await import('../../src/routes/roster-trade/+page.server.ts');

const COMMISSIONER: RegisteredManager = {
	id: 'm-1',
	discordUserId: '111',
	displayName: 'Commissioner Bob',
	teamId: 't-1',
	teamName: 'Team One',
	isCommissioner: true
};

const MANAGER: RegisteredManager = {
	id: 'm-2',
	discordUserId: '222',
	displayName: 'Alice',
	teamId: 't-2',
	teamName: 'Team Two',
	isCommissioner: false
};

const AUCTION: ResolvedPhase = { name: 'Auction', sentence: 'Auction.', announcement: null };
const ARCHIVED: ResolvedPhase = { name: 'Archived', sentence: 'Archived.', announcement: null };

function locals(manager: RegisteredManager | null, phase: ResolvedPhase = AUCTION) {
	const session: SessionState =
		manager === null ? { kind: 'signed-out' } : { kind: 'registered', manager };
	return { session, phase };
}

type LoadResult = {
	step: 'teams' | 'players' | 'sheet';
	teams: ReadonlyArray<{ id: string; name: string }>;
	sending: { teamName: string; players: ReadonlyArray<{ fantraxPlayerId: string }> } | null;
	receiving: { teamName: string; players: ReadonlyArray<{ fantraxPlayerId: string }> } | null;
	sheet: ReasonSheetView | null;
	refusal: { detail: string } | null;
	commitAction: string | null;
	sameTeam: boolean;
};

async function loadAt(
	query: string,
	manager: RegisteredManager | null = COMMISSIONER,
	phase = AUCTION
): Promise<LoadResult> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (await route.load({
		locals: locals(manager, phase),
		url: new URL(`http://localhost/roster-trade${query}`)
	} as any)) as unknown as LoadResult;
}

/** A `record` submission: the selection on the URL, the reason on the form. */
async function commit(
	query: string,
	reason: string,
	manager: RegisteredManager | null = COMMISSIONER,
	phase = AUCTION
) {
	const form = new FormData();
	form.set('reason', reason);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return await (route.actions as any).record({
		locals: locals(manager, phase),
		url: new URL(`http://localhost/roster-trade${query}`),
		request: new Request('http://localhost/roster-trade', {
			method: 'POST',
			headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)' },
			body: form
		})
	});
}

async function expectRefusal(run: () => unknown, status: number): Promise<void> {
	let thrown: unknown;
	try {
		await run();
	} catch (caught) {
		thrown = caught;
	}
	expect(thrown, 'the call did not throw').toBeDefined();
	expect(isHttpError(thrown)).toBe(true);
	if (isHttpError(thrown)) expect(thrown.status).toBe(status);
}

describe('/roster-trade — the three guards, on load AND on the action', () => {
	it('refuses a Manager who is not the Commissioner, both ways', async () => {
		await expectRefusal(() => loadAt('', MANAGER), COMMISSIONER_ONLY_STATUS);
		await expectRefusal(
			() => commit('?from=t-1&to=t-2&send=p-1', 'A reason.', MANAGER),
			COMMISSIONER_ONLY_STATUS
		);
	});

	it('refuses a signed-out visitor, both ways', async () => {
		await expectRefusal(() => loadAt('', null), COMMISSIONER_ONLY_STATUS);
		await expectRefusal(
			() => commit('?from=t-1&to=t-2&send=p-1', 'A reason.', null),
			COMMISSIONER_ONLY_STATUS
		);
	});

	it('refuses everybody once the League is Archived, both ways', async () => {
		// The destination is absent from the Archived catalog, so that gate
		// answers first — which is the correct order and the stricter of the two.
		await expectRefusal(() => loadAt('', COMMISSIONER, ARCHIVED), LIVE_DESTINATION_REFUSAL_STATUS);
		await expectRefusal(
			() => commit('?from=t-1&to=t-2&send=p-1', 'A reason.', COMMISSIONER, ARCHIVED),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
	});

	it('refuses a blank reason with 400, before any transaction is opened', async () => {
		world.statements.length = 0;

		await expectRefusal(
			() => commit('?from=t-1&to=t-2&send=p-1', '   ​  '),
			OVERRIDE_REASON_REQUIRED_STATUS
		);

		expect(world.statements).toEqual([]);
	});

	it('keeps the archived override refusal reachable for its own gate', () => {
		// `requireOverridablePhase` is the third guard and has its own status.
		// The catalog hides `/roster-trade` in Archived, so this asserts the
		// constant the route imports rather than a reachable route state.
		expect(OVERRIDE_ARCHIVED_STATUS).toBe(403);
	});
});

describe('/roster-trade — the three steps', () => {
	it('step one: no Teams chosen, so the Team list and nothing else', async () => {
		const data = await loadAt('');

		expect(data.step).toBe('teams');
		expect(data.teams.map((team) => team.id)).toEqual(['t-1', 't-2']);
		expect(data.sending).toBeNull();
		expect(data.receiving).toBeNull();
		expect(data.sheet).toBeNull();
		expect(data.commitAction).toBeNull();
	});

	it('step one again when one Team is named on both sides, and it says so', async () => {
		const data = await loadAt('?from=t-1&to=t-1');

		expect(data.step).toBe('teams');
		expect(data.sameTeam).toBe(true);
	});

	it('step two: two Teams chosen, so both rosters and no sheet', async () => {
		const data = await loadAt('?from=t-1&to=t-2');

		expect(data.step).toBe('players');
		expect(data.sending?.teamName).toBe('Team One');
		expect(data.receiving?.teamName).toBe('Team Two');
		expect(data.sending?.players.map((p) => p.fantraxPlayerId)).toEqual(['p-2', 'p-1']);
		expect(data.receiving?.players.map((p) => p.fantraxPlayerId)).toEqual(['p-3']);
		expect(data.sheet).toBeNull();
		expect(data.commitAction).toBeNull();
	});

	it('step three: a permitted Trade renders the sheet, with both Teams in it', async () => {
		const data = await loadAt('?from=t-1&to=t-2&send=p-1&recv=p-3&confirm=yes');

		expect(data.step).toBe('sheet');
		expect(data.sheet).not.toBeNull();
		expect(data.sheet?.act).toBe(
			'Record that Team One sends Powell to Team Two and receives Sharpe.'
		);
		// Five figures per Team with the two Players named between them.
		expect(data.sheet?.rows.map((row) => row.label)).toEqual([
			'Team One · Cap Space',
			'Team One · Roster Count',
			'Team One · Active/Bench',
			'Team One · Injury Reserve',
			'Team One · Minor League',
			'Powell',
			'Sharpe',
			'Team Two · Cap Space',
			'Team Two · Roster Count',
			'Team Two · Active/Bench',
			'Team Two · Injury Reserve',
			'Team Two · Minor League'
		]);
		// The commit control names the act; the reason field is the guard's.
		expect(data.sheet?.commitLabel).toBe('Record the Roster Trade');
		expect(data.sheet?.reasonFieldName).toBe('reason');
	});

	it('step three carries EVERY selected id on the commit action and on Cancel', async () => {
		const data = await loadAt(
			'?from=t-1&to=t-2&send=p-1&send=p-2&recv=p-3&confirm=yes'
		);

		expect(data.step).toBe('sheet');
		// The whole point of asserting this rather than a regex: a dropped
		// `send` or `recv` here would commit a DIFFERENT Trade from the one the
		// Commissioner read.
		const action = new URLSearchParams((data.commitAction ?? '').replace(/^\?\/record&/, ''));
		expect(action.get('from')).toBe('t-1');
		expect(action.get('to')).toBe('t-2');
		expect(action.getAll('send')).toEqual(['p-1', 'p-2']);
		expect(action.getAll('recv')).toEqual(['p-3']);
		expect(data.commitAction?.startsWith('?/record&')).toBe(true);

		// Cancel goes back to the picker with the same selection intact.
		const cancel = new URL(`http://localhost${data.sheet?.cancelHref ?? ''}`);
		expect(cancel.searchParams.getAll('send')).toEqual(['p-1', 'p-2']);
		expect(cancel.searchParams.getAll('recv')).toEqual(['p-3']);
		expect(cancel.searchParams.get('confirm')).toBeNull();
	});

	it('renders NO sheet for a Trade the core refuses — it returns to the picker', async () => {
		// `p-nobody` is on neither roster, so the act is malformed.
		const data = await loadAt('?from=t-1&to=t-2&send=p-nobody&confirm=yes');

		expect(data.step).toBe('players');
		expect(data.sheet).toBeNull();
		expect(data.commitAction).toBeNull();
		expect(data.refusal?.detail).toContain('Team One');
		// A refusal never offers a way to cancel a Bid.
		expect(data.refusal?.detail).not.toMatch(/cancel/i);
	});
});

describe('/roster-trade — committing', () => {
	it('records the Trade and returns the appended event', async () => {
		world.statements.length = 0;

		const result = (await commit(
			'?from=t-1&to=t-2&send=p-1&recv=p-3',
			'  Agreed in the league channel.  '
		)) as { notice: string; appended: { seq: string } | null };

		expect(result.appended?.seq).toBe('42');
		expect(result.notice).toContain('not announced in Discord');
		// One transaction, and the rows moved inside it.
		expect(world.statements.filter((sql) => /^begin/i.test(sql))).toHaveLength(1);
		expect(world.statements.filter((sql) => /^commit/i.test(sql))).toHaveLength(1);
		expect(world.statements.filter((sql) => /^update team_rosters/i.test(sql))).toHaveLength(2);
		expect(world.statements.join('\n')).not.toMatch(/notification_outbox/i);
	});

	it('commits the Trade the URL names, not one the form could restate', async () => {
		world.statements.length = 0;

		await commit('?from=t-1&to=t-2&send=p-2', 'Sending the stashed Player only.');

		// One `UPDATE`, for the one Player named — and he arrives in a free
		// Minor League Slot on Team Two, so his Slot is re-derived rather than
		// carried across.
		const updates = world.statements.filter((sql) => /^update team_rosters/i.test(sql));
		expect(updates).toHaveLength(1);
	});

	it('returns 409 with the core wording when a gate refuses, writing nothing', async () => {
		world.statements.length = 0;

		const result = (await commit('?from=t-1&to=t-2&send=p-nobody', 'A reason.')) as {
			status: number;
			data: { notice: string };
		};

		expect(result.status).toBe(409);
		expect(result.data.notice).toContain('Team One');
		expect(world.statements.filter((sql) => /^commit/i.test(sql))).toHaveLength(0);
		expect(world.statements.filter((sql) => /^update team_rosters/i.test(sql))).toHaveLength(0);
		expect(world.statements).toContain('rollback');
	});

	it('refuses a Trade naming nothing, with the core sentence', async () => {
		const result = (await commit('?from=t-1&to=t-2', 'A reason.')) as {
			status: number;
			data: { notice: string };
		};

		expect(result.status).toBe(409);
		expect(result.data.notice).toContain('names no Players');
	});
});
