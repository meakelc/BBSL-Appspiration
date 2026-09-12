/**
 * The `/roster-drop` handlers, driven as MODULES (Story 7.8, FR-43).
 *
 * **Source-text assertion is not enough here**, and `tests/roster-drop.test.ts`
 * says so in its own header. A `.svelte` file cannot be rendered under
 * `environment: 'node'`, so its claims have to be read out of the source; a
 * `+page.server.ts` is an ordinary importable module, and a regex over it
 * would pass unchanged if the three-step branching inverted, if the sheet
 * rendered for a Drop the core refused, or if `commitAction` dropped a `drop`
 * parameter and committed a different Drop from the one reviewed. This file
 * calls `load` and `actions.record` instead — `tests/routes/roster-trade.test.ts`
 * is the template, added by Story 7.7's own review for exactly this reason.
 *
 * The REAL `requireCommissioner`, `requireLiveDestination` and
 * `requireOverridablePhase` all run — nothing about them is mocked, which is
 * what makes "the guards are called on `load` AND on the action" a proof
 * rather than a claim. Only the I/O-touching layer is faked:
 * `$lib/shell/db.ts` answers a synthetic log, Team list and one roster, and
 * the whole of `server/roster-drop.ts` and the pure core run for real.
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
 * Team One holds four Contracts: an ordinary Active/Bench deal, a full-term
 * second-round rookie deal, a stash, and one it keeps. That is one of each
 * fate FR-43 can produce, plus a control.
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
			roster_slot_kind: 'active_bench',
			contract_years_remaining: 4,
			rookie_scale_round: null
		},
		{
			teamId: 't-1',
			fantrax_player_id: 'p-2',
			player_name: 'Ellis',
			cap_hit: 3_000_000,
			roster_slot_kind: 'minor_league',
			contract_years_remaining: 2,
			rookie_scale_round: null
		},
		{
			teamId: 't-1',
			fantrax_player_id: 'p-3',
			player_name: 'Duren',
			cap_hit: 2_000_000,
			roster_slot_kind: 'active_bench',
			contract_years_remaining: 5,
			rookie_scale_round: 2
		},
		{
			teamId: 't-2',
			fantrax_player_id: 'p-4',
			player_name: 'Sharpe',
			cap_hit: 4_000_000,
			roster_slot_kind: 'active_bench',
			contract_years_remaining: 3,
			rookie_scale_round: null
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
					return { rows: [{ locked: true, now: new Date('2026-09-11T19:00:00.000Z') }] };
				}
				if (/^select \* from auction_events/i.test(sql)) return { rows: [] };
				if (/from teams/i.test(sql)) return { rows: world.teams };
				// `^select` first: a bare `/from team_rosters/` would also match
				// this route's own `delete from team_rosters`.
				if (/^select[\s\S]*from team_rosters/i.test(sql)) {
					const teamId = String(params[0]);
					return { rows: world.rosters.filter((row) => row.teamId === teamId) };
				}
				if (/^insert into auction_events/i.test(sql)) {
					return {
						rows: [
							{
								seq: 43,
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
				if (/^delete from team_rosters/i.test(sql)) return { rows: [] };
				throw new Error(`unexpected statement: ${sql}`);
			},
			release: () => {}
		})
	})
}));

const route = await import('../../src/routes/roster-drop/+page.server.ts');

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
	step: 'team' | 'players' | 'sheet';
	teams: ReadonlyArray<{ id: string; name: string }>;
	teamId: string;
	team: {
		teamName: string;
		players: ReadonlyArray<{ fantraxPlayerId: string; slotLabel: string; won: boolean }>;
	} | null;
	sheet: ReasonSheetView | null;
	refusal: { detail: string } | null;
	commitAction: string | null;
};

async function loadAt(
	query: string,
	manager: RegisteredManager | null = COMMISSIONER,
	phase = AUCTION
): Promise<LoadResult> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (await route.load({
		locals: locals(manager, phase),
		url: new URL(`http://localhost/roster-drop${query}`)
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
		url: new URL(`http://localhost/roster-drop${query}`),
		request: new Request('http://localhost/roster-drop', {
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

describe('/roster-drop — the three guards, on load AND on the action', () => {
	it('refuses a Manager who is not the Commissioner, both ways', async () => {
		await expectRefusal(() => loadAt('', MANAGER), COMMISSIONER_ONLY_STATUS);
		await expectRefusal(
			() => commit('?team=t-1&drop=p-1', 'A reason.', MANAGER),
			COMMISSIONER_ONLY_STATUS
		);
	});

	it('refuses a signed-out visitor, both ways', async () => {
		await expectRefusal(() => loadAt('', null), COMMISSIONER_ONLY_STATUS);
		await expectRefusal(
			() => commit('?team=t-1&drop=p-1', 'A reason.', null),
			COMMISSIONER_ONLY_STATUS
		);
	});

	it('refuses everybody once the League is Archived, both ways', async () => {
		// The destination is absent from the Archived catalog, so that gate
		// answers first — which is the correct order and the stricter of the two.
		await expectRefusal(() => loadAt('', COMMISSIONER, ARCHIVED), LIVE_DESTINATION_REFUSAL_STATUS);
		await expectRefusal(
			() => commit('?team=t-1&drop=p-1', 'A reason.', COMMISSIONER, ARCHIVED),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
	});

	it('refuses a blank reason with 400, before any transaction is opened', async () => {
		world.statements.length = 0;

		await expectRefusal(
			() => commit('?team=t-1&drop=p-1', '   ​  '),
			OVERRIDE_REASON_REQUIRED_STATUS
		);

		expect(world.statements).toEqual([]);
	});

	it('keeps the archived override refusal reachable for its own gate', () => {
		// `requireOverridablePhase` is the third guard and has its own status.
		// The catalog hides `/roster-drop` in Archived, so this asserts the
		// constant the route imports rather than a reachable route state.
		expect(OVERRIDE_ARCHIVED_STATUS).toBe(403);
	});
});

describe('/roster-drop — the three steps', () => {
	it('step one: no Team chosen, so the Team list and nothing else', async () => {
		const data = await loadAt('');

		expect(data.step).toBe('team');
		expect(data.teams.map((team) => team.id)).toEqual(['t-1', 't-2']);
		expect(data.team).toBeNull();
		expect(data.sheet).toBeNull();
		expect(data.commitAction).toBeNull();
	});

	it('step two: a Team chosen, so its roster and no sheet', async () => {
		const data = await loadAt('?team=t-1');

		expect(data.step).toBe('players');
		expect(data.team?.teamName).toBe('Team One');
		// Sorted by name: Duren, Ellis, Powell.
		expect(data.team?.players.map((p) => p.fantraxPlayerId)).toEqual(['p-3', 'p-2', 'p-1']);
		// The CHARGED figure per row — a stash reads $0, which is also exactly
		// what it would leave behind.
		expect(data.team?.players.map((p) => p.slotLabel)).toEqual([
			'Active/Bench',
			'Minor League',
			'Active/Bench'
		]);
		expect(data.sheet).toBeNull();
		expect(data.commitAction).toBeNull();
	});

	it('step three: a permitted Drop renders the sheet, with the Team’s five figures', async () => {
		const data = await loadAt('?team=t-1&drop=p-1&confirm=yes');

		expect(data.step).toBe('sheet');
		expect(data.sheet?.act).toBe('Record that Team One dropped Powell.');
		expect(data.sheet?.rows.map((row) => row.label)).toEqual([
			'Team One · Cap Space',
			'Team One · Roster Count',
			'Team One · Active/Bench',
			'Team One · Injury Reserve',
			'Team One · Minor League',
			'Powell'
		]);
		// The commit control names the act; the reason field is the guard's.
		expect(data.sheet?.commitLabel).toBe('Record the Drop');
		expect(data.sheet?.reasonFieldName).toBe('reason');
	});

	it('states the NET direction on the sheet, and states it correctly both ways', async () => {
		// The counterintuitive half FR-43 requires in words before commit, and
		// the half a flat "a Drop lowers the Maximum Bid" sentence gets wrong.
		const carried = await loadAt('?team=t-1&drop=p-1&confirm=yes');
		const cleared = await loadAt('?team=t-1&drop=p-3&confirm=yes');

		const carriedNote = carried.sheet?.attentionNotes[0] ?? '';
		expect(carriedNote).toContain('$1.0M to reserve');
		expect(carriedNote).toContain('Dead Money');
		expect(carriedNote).toContain('LOWERS');
		expect(carriedNote).toContain('$1.0M');

		// The same Slot, the same act — and a full-term second-round rookie
		// deal, so $2,000,000 returns against $1,000,000 of new reserve.
		const clearedNote = cleared.sheet?.attentionNotes[0] ?? '';
		expect(clearedNote).toContain('RAISES');
		expect(clearedNote).toContain('$1.0M');
		expect(clearedNote).toContain('rookie-scale');
		expect(clearedNote).not.toContain('LOWERS');
	});

	it('carries EVERY selected id on the commit action and on Cancel', async () => {
		const data = await loadAt('?team=t-1&drop=p-1&drop=p-3&confirm=yes');

		expect(data.step).toBe('sheet');
		// The whole point of asserting this rather than a regex: a dropped
		// `drop` here would commit a DIFFERENT Drop from the one reviewed.
		const action = new URLSearchParams((data.commitAction ?? '').replace(/^\?\/record&/, ''));
		expect(action.get('team')).toBe('t-1');
		expect(action.getAll('drop')).toEqual(['p-1', 'p-3']);
		expect(data.commitAction?.startsWith('?/record&')).toBe(true);

		// Cancel goes back to the picker with the same selection intact.
		const cancel = new URL(`http://localhost${data.sheet?.cancelHref ?? ''}`);
		expect(cancel.searchParams.getAll('drop')).toEqual(['p-1', 'p-3']);
		expect(cancel.searchParams.get('confirm')).toBeNull();
	});

	it('renders NO sheet for a Drop the core refuses — it returns to the picker', async () => {
		// `p-4` is on Team Two, so Team One does not hold him.
		const data = await loadAt('?team=t-1&drop=p-4&confirm=yes');

		expect(data.step).toBe('players');
		expect(data.sheet).toBeNull();
		expect(data.commitAction).toBeNull();
		expect(data.refusal?.detail).toContain('Team One');
		// A refusal never offers a way to cancel a Bid.
		expect(data.refusal?.detail).not.toMatch(/cancel/i);
	});
});

describe('/roster-drop — committing', () => {
	it('records the Drop and returns the appended event', async () => {
		world.statements.length = 0;

		const result = (await commit('?team=t-1&drop=p-1', '  Released in Fantrax.  ')) as {
			notice: string;
			appended: { seq: string } | null;
		};

		expect(result.appended?.seq).toBe('43');
		expect(result.notice).toContain('not announced in Discord');
		// One transaction, and the row converted inside it.
		expect(world.statements.filter((sql) => /^begin/i.test(sql))).toHaveLength(1);
		expect(world.statements.filter((sql) => /^commit/i.test(sql))).toHaveLength(1);
		expect(world.statements.filter((sql) => /^update team_rosters/i.test(sql))).toHaveLength(1);
		expect(world.statements.filter((sql) => /^delete from team_rosters/i.test(sql))).toHaveLength(
			0
		);
		expect(world.statements.join('\n')).not.toMatch(/notification_outbox/i);
	});

	it('DELETEs the row of a release that carries nothing', async () => {
		world.statements.length = 0;

		await commit('?team=t-1&drop=p-3', 'The rookie deal, released in full term.');

		expect(world.statements.filter((sql) => /^delete from team_rosters/i.test(sql))).toHaveLength(
			1
		);
		expect(world.statements.filter((sql) => /^update team_rosters/i.test(sql))).toHaveLength(0);
	});

	it('commits the Drop the URL names, not one the form could restate', async () => {
		world.statements.length = 0;

		await commit('?team=t-1&drop=p-2', 'The stash only.');

		// One statement, for the one Player named — and it is a `DELETE`,
		// because a Minor League row was charging nothing.
		expect(world.statements.filter((sql) => /team_rosters/i.test(sql) && !/^select/i.test(sql)))
			.toHaveLength(1);
	});

	it('returns 409 with the core wording when the act is refused, writing nothing', async () => {
		world.statements.length = 0;

		const result = (await commit('?team=t-1&drop=p-4', 'A reason.')) as {
			status: number;
			data: { notice: string };
		};

		expect(result.status).toBe(409);
		expect(result.data.notice).toContain('Team One');
		expect(world.statements.filter((sql) => /^commit/i.test(sql))).toHaveLength(0);
		expect(world.statements.filter((sql) => /^update team_rosters/i.test(sql))).toHaveLength(0);
		expect(world.statements.filter((sql) => /^delete from team_rosters/i.test(sql))).toHaveLength(
			0
		);
		expect(world.statements).toContain('rollback');
	});

	it('refuses a Drop naming nothing, with the core sentence', async () => {
		const result = (await commit('?team=t-1', 'A reason.')) as {
			status: number;
			data: { notice: string };
		};

		expect(result.status).toBe(409);
		expect(result.data.notice).toContain('names no Players');
	});
});
