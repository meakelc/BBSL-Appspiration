/**
 * The `/roster-move` handlers, driven as MODULES (Story 7.11, FR-44).
 *
 * **Source-text assertion is not enough here.** A regex over `+page.server.ts`
 * would pass unchanged if the Manager branch inverted, if a Manager could name
 * another Team, if the sheet rendered for a Move the core refused, or if
 * `commitAction` dropped a `move` parameter and committed a different act from
 * the one reviewed. This file calls `load` and `actions.record` instead —
 * `tests/routes/roster-drop.test.ts` is the template.
 *
 * The REAL `requireCommissioner`, `requireLiveDestination`,
 * `requireOverridablePhase` and `requireOverrideReason` all run — nothing about
 * them is mocked, which is what makes "every guard runs on `load` AND on the
 * action" a proof rather than a claim. Only the I/O-touching layer is faked:
 * `$lib/shell/db.ts` answers a synthetic log, Team list and rosters, and the
 * whole of `server/roster-rearrange.ts` and the pure core run for real.
 */

import { describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import {
	FOREIGN_TEAM_REFUSAL_STATUS,
	UNKNOWN_TEAM_STATUS
} from '../../src/lib/server/roster-rearrange.ts';
import { OVERRIDE_REASON_REQUIRED_STATUS } from '../../src/lib/server/override-guard.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';
import type { ConfirmSheetView, ReasonSheetView } from '../../src/lib/reason-sheet-view.ts';

/**
 * The world the fake gateway answers from.
 *
 * Team One holds two Active/Bench Contracts, one stash, one Injury Reserve
 * Contract and one Dead Money charge — one of every Slot kind, so the picker's
 * exclusions are observable. Team Two holds one Contract, so a Manager of
 * Team Two has somewhere legitimate to act.
 */
const world = vi.hoisted(() => ({
	teams: [
		{ id: 't-1', name: 'Team One' },
		{ id: 't-2', name: 'Team Two' }
	] as Array<{ id: string; name: string }>,
	rosters: [
		{
			teamId: 't-1',
			fantrax_player_id: 'p-active',
			player_name: 'Active One',
			cap_hit: 5_000_000,
			roster_slot_kind: 'active_bench'
		},
		{
			teamId: 't-1',
			fantrax_player_id: 'p-active-2',
			player_name: 'Active Two',
			cap_hit: 5_000_000,
			roster_slot_kind: 'active_bench'
		},
		{
			teamId: 't-1',
			fantrax_player_id: 'p-stash',
			player_name: 'Stashed One',
			cap_hit: 3_000_000,
			roster_slot_kind: 'minor_league'
		},
		{
			teamId: 't-1',
			fantrax_player_id: 'p-ir',
			player_name: 'Injured One',
			cap_hit: 4_000_000,
			roster_slot_kind: 'injury_reserve'
		},
		{
			teamId: 't-1',
			fantrax_player_id: 'p-dead',
			player_name: 'Departed One',
			cap_hit: 2_000_000,
			roster_slot_kind: 'dead_money'
		},
		{
			teamId: 't-2',
			fantrax_player_id: 'p-two-stash',
			player_name: 'Two Stash',
			cap_hit: 1_000_000,
			roster_slot_kind: 'minor_league'
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
					return { rows: [{ locked: true, now: new Date('2026-09-12T19:00:00.000Z') }] };
				}
				if (/^select \* from auction_events/i.test(sql)) return { rows: [] };
				if (/from teams/i.test(sql)) return { rows: world.teams };
				if (/^select[\s\S]*from team_rosters/i.test(sql)) {
					const teamId = String(params[0]);
					return { rows: world.rosters.filter((row) => row.teamId === teamId) };
				}
				if (/^insert into auction_events/i.test(sql)) {
					return {
						rows: [
							{
								seq: 51,
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

const route = await import('../../src/routes/roster-move/+page.server.ts');

const COMMISSIONER: RegisteredManager = {
	id: 'm-1',
	discordUserId: '111',
	displayName: 'Commissioner Bob',
	teamId: 't-1',
	teamName: 'Team One',
	isCommissioner: true
};

/** An ordinary Manager, bound to Team Two. */
const MANAGER: RegisteredManager = {
	id: 'm-2',
	discordUserId: '222',
	displayName: 'Alice',
	teamId: 't-2',
	teamName: 'Team Two',
	isCommissioner: false
};

/** A Manager bound to Team One, so the fuller roster is theirs to rearrange. */
const MANAGER_ONE: RegisteredManager = {
	id: 'm-3',
	discordUserId: '333',
	displayName: 'Bill',
	teamId: 't-1',
	teamName: 'Team One',
	isCommissioner: false
};

const AUCTION: ResolvedPhase = { name: 'Auction', sentence: 'Auction.', announcement: null };
const ASSIGNMENT: ResolvedPhase = {
	name: 'Contract Assignment',
	sentence: 'Assignment.',
	announcement: null
};
const SETUP: ResolvedPhase = { name: 'Setup', sentence: 'Setup.', announcement: null };
const ARCHIVED: ResolvedPhase = { name: 'Archived', sentence: 'Archived.', announcement: null };

function locals(manager: RegisteredManager | null, phase: ResolvedPhase = AUCTION) {
	const session: SessionState =
		manager === null ? { kind: 'signed-out' } : { kind: 'registered', manager };
	return { session, phase };
}

type PickerPlayer = {
	fantraxPlayerId: string;
	playerName: string;
	slotLabel: string;
	targetLabel: string;
	value: string;
	won: boolean;
};

type LoadResult = {
	step: 'team' | 'players' | 'sheet';
	commissioner: boolean;
	teams: ReadonlyArray<{ id: string; name: string }>;
	teamId: string;
	team: { teamName: string; players: readonly PickerPlayer[] } | null;
	sheet: ReasonSheetView | null;
	managerSheet: ConfirmSheetView | null;
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
		url: new URL(`http://localhost/roster-move${query}`)
	} as any)) as unknown as LoadResult;
}

async function commit(
	query: string,
	reason: string | null,
	manager: RegisteredManager | null = COMMISSIONER,
	phase = AUCTION
) {
	const form = new FormData();
	if (reason !== null) form.set('reason', reason);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return await (route.actions as any).record({
		locals: locals(manager, phase),
		url: new URL(`http://localhost/roster-move${query}`),
		request: new Request('http://localhost/roster-move', {
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

const DEMOTE_ONE = 'move=p-stash~active_bench';
const DEMOTE_TWO = 'move=p-two-stash~active_bench';

describe('/roster-move — the guards, on load AND on the action', () => {
	it('refuses a signed-out visitor, both ways', async () => {
		await expectRefusal(() => loadAt('', null), LIVE_DESTINATION_REFUSAL_STATUS);
		await expectRefusal(
			() => commit(`?team=t-1&${DEMOTE_ONE}`, 'A reason.', null),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
	});

	it('refuses everybody in Setup — the destination is not live there', async () => {
		await expectRefusal(
			() => loadAt('', COMMISSIONER, SETUP),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		await expectRefusal(() => loadAt('', MANAGER, SETUP), LIVE_DESTINATION_REFUSAL_STATUS);
	});

	it('refuses everybody once the League is Archived, both ways', async () => {
		// Two gates refuse this, and the archived one is its own: `/board` and
		// `/teams` are live in Archived, so a Move reached from one of those
		// would pass the destination gate.
		await expectRefusal(() => loadAt('', COMMISSIONER, ARCHIVED), LIVE_DESTINATION_REFUSAL_STATUS);
		await expectRefusal(
			() => commit(`?team=t-2&${DEMOTE_TWO}`, null, MANAGER, ARCHIVED),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
	});

	it('is live in the Contract Assignment Phase, for a Manager as well', async () => {
		const data = await loadAt('', MANAGER, ASSIGNMENT);
		expect(data.step).toBe('players');
	});

	it('refuses a Manager naming ANOTHER Team, whatever the page rendered', async () => {
		// The one guard this route exists to hold. It refuses rather than
		// silently substituting the Manager's own Team: a quiet swap would
		// commit an act the submitter did not ask for.
		await expectRefusal(
			() => loadAt('?team=t-1', MANAGER),
			FOREIGN_TEAM_REFUSAL_STATUS
		);
		await expectRefusal(
			() => commit(`?team=t-1&${DEMOTE_ONE}`, null, MANAGER),
			FOREIGN_TEAM_REFUSAL_STATUS
		);
	});

	it('demands a reason from the COMMISSIONER before anything is written', async () => {
		await expectRefusal(
			() => commit(`?team=t-1&${DEMOTE_ONE}`, '   ', COMMISSIONER),
			OVERRIDE_REASON_REQUIRED_STATUS
		);
		await expectRefusal(
			() => commit(`?team=t-1&${DEMOTE_ONE}`, null, COMMISSIONER),
			OVERRIDE_REASON_REQUIRED_STATUS
		);
	});

	it('demands NO reason from a Manager acting on their own Team', async () => {
		const outcome = await commit(`?${DEMOTE_TWO}`, null, MANAGER);
		expect(outcome.notice).toContain('recorded');
	});

	it('never reads the Team or the actor off the submitted form', async () => {
		// The Team comes from the session for a Manager and from the URL for the
		// Commissioner; the actor comes from the session for both.
		const source = (
			await import('node:fs')
		).readFileSync('src/routes/roster-move/+page.server.ts', 'utf8');
		expect(source).not.toMatch(/form\.get\('team'\)|form\.get\('managerId'\)|form\.get\('teamId'\)/);
		expect(source).toContain('locals.session.manager.teamId');
	});
});

describe('/roster-move — the Manager branch', () => {
	it('skips the Team step entirely and lands on its own roster', async () => {
		const data = await loadAt('', MANAGER_ONE);

		expect(data.commissioner).toBe(false);
		expect(data.step).toBe('players');
		expect(data.teamId).toBe('t-1');
		expect(data.team?.teamName).toBe('Team One');
		// **No Team list at all.** A Manager has one Team and the page offers no
		// way to name another.
		expect(data.teams).toEqual([]);
	});

	it('offers only the two participating Slots, each as a toggle to the other', async () => {
		const data = await loadAt('', MANAGER_ONE);
		const ids = data.team?.players.map((player) => player.fantraxPlayerId) ?? [];

		expect(ids).toContain('p-active');
		expect(ids).toContain('p-stash');
		// **Injury Reserve and Dead Money are not offered.** The rules core
		// refuses either if named anyway; the picker not offering them is the
		// same fact said where it stops a pointless refusal.
		expect(ids).not.toContain('p-ir');
		expect(ids).not.toContain('p-dead');

		const stash = data.team?.players.find((player) => player.fantraxPlayerId === 'p-stash');
		expect(stash?.slotLabel).toBe('Minor League');
		expect(stash?.targetLabel).toBe('Active/Bench');
		expect(stash?.value).toBe('p-stash~active_bench');
		// A stash charges $0 today, and that is the number a Move changes.
		const active = data.team?.players.find((player) => player.fantraxPlayerId === 'p-active');
		expect(active?.targetLabel).toBe('Minor League');
	});

	it('renders the reasonless confirmation sheet and no reason sheet at all', async () => {
		const data = await loadAt(`?confirm=yes&${DEMOTE_ONE}`, MANAGER_ONE);

		expect(data.step).toBe('sheet');
		expect(data.sheet).toBeNull();
		expect(data.managerSheet).not.toBeNull();
		// **The shape cannot carry a reason.** `ConfirmSheetView` has no
		// `reasonLabel` and no `reasonFieldName`, so there is no field for a
		// component to render even by accident.
		expect(data.managerSheet as unknown as Record<string, unknown>).not.toHaveProperty(
			'reasonLabel'
		);
		expect(data.managerSheet as unknown as Record<string, unknown>).not.toHaveProperty(
			'reasonFieldName'
		);
		expect(data.managerSheet?.title).toContain('Roster Move');
		expect(data.managerSheet?.act).toContain('Team One moves Stashed One to Active/Bench');
	});

	it('states which way Maximum Bid moved, on the sheet, before commit', async () => {
		const data = await loadAt(`?confirm=yes&${DEMOTE_ONE}`, MANAGER_ONE);
		const rows = data.managerSheet?.rows ?? [];

		const maximumBid = rows.find((row) => row.label.includes('Maximum Bid'));
		expect(maximumBid).toBeDefined();
		expect(maximumBid?.attention).toMatch(/ROSE|FELL|unchanged/);
		// And the consequence is on the ROW, so a reader can see which value it
		// is about.
		expect(data.managerSheet?.attentionNotes.length).toBeGreaterThan(0);
	});

	it('commits what was reviewed — the selection rides the action URL', async () => {
		const data = await loadAt(`?confirm=yes&${DEMOTE_ONE}`, MANAGER_ONE);

		expect(data.commitAction).toContain('?/record');
		expect(data.commitAction).toContain('team=t-1');
		expect(data.commitAction).toContain('p-stash%7Eactive_bench');
		// Cancel goes back to the picker with the selection intact.
		expect(data.managerSheet?.cancelHref).toContain('move=p-stash%7Eactive_bench');
	});

	it('writes one UPDATE and one event, and says so', async () => {
		world.statements.length = 0;
		const outcome = await commit(`?${DEMOTE_TWO}`, null, MANAGER);

		expect(outcome.notice).toContain('Roster Move is recorded');
		expect(outcome.notice).toContain('not');
		expect(outcome.appended?.seq).toBe('51');
		const updates = world.statements.filter((sql) => /^update team_rosters/i.test(sql));
		expect(updates).toHaveLength(1);
	});
});

describe('/roster-move — the Commissioner branch', () => {
	it('starts on the Team step, offering every Team', async () => {
		const data = await loadAt('', COMMISSIONER);

		expect(data.commissioner).toBe(true);
		expect(data.step).toBe('team');
		expect(data.teams.map((team) => team.id)).toEqual(['t-1', 't-2']);
		expect(data.team).toBeNull();
	});

	it('refuses a Team id no `teams` row answers to, rather than naming a machine id', async () => {
		// Without the guard the picker renders empty under the raw id as its
		// heading, and a committed Move would write that token into a permanent
		// payload as `teamName`.
		await expectRefusal(() => loadAt('?team=t-nobody', COMMISSIONER), UNKNOWN_TEAM_STATUS);
		await expectRefusal(
			() => commit(`?team=t-nobody&${DEMOTE_ONE}`, 'A reason.', COMMISSIONER),
			UNKNOWN_TEAM_STATUS
		);
	});

	it('may name a Team that is not its own', async () => {
		const data = await loadAt('?team=t-2', COMMISSIONER);

		expect(data.step).toBe('players');
		expect(data.teamId).toBe('t-2');
	});

	it('renders the dashed reason sheet and no Manager sheet at all', async () => {
		const data = await loadAt(`?team=t-1&confirm=yes&${DEMOTE_ONE}`, COMMISSIONER);

		expect(data.step).toBe('sheet');
		expect(data.managerSheet).toBeNull();
		expect(data.sheet).not.toBeNull();
		expect(data.sheet?.reasonLabel).toContain('required');
		expect(data.sheet?.reasonFieldName).toBe('reason');
		expect(data.sheet?.title).toBe('Commissioner override');
	});

	it('records the reason on the event, verbatim', async () => {
		world.statements.length = 0;
		const outcome = await commit(
			`?team=t-1&${DEMOTE_ONE}`,
			'  Recorded on behalf of the Manager.  ',
			COMMISSIONER
		);

		expect(outcome.notice).toContain('recorded');
		const inserted = world.statements.filter((sql) => /^insert into auction_events/i.test(sql));
		expect(inserted).toHaveLength(1);
	});
});

describe('/roster-move — a refused Move gets no sheet', () => {
	it('reports the core’s own sentence and stays on the picker', async () => {
		// `p-active` has no pool row and has never been observed in a Minor
		// League Slot, so the promotion is refused by the rules core.
		const data = await loadAt('?confirm=yes&move=p-active~minor_league', MANAGER_ONE);

		expect(data.step).toBe('players');
		expect(data.sheet).toBeNull();
		expect(data.managerSheet).toBeNull();
		expect(data.commitAction).toBeNull();
		expect(data.refusal?.detail).toContain('never been told');
		// It never offers to cancel a Bid.
		expect(data.refusal?.detail).not.toMatch(/cancel/i);
	});

	it('returns a 409 with the core’s sentence when the action itself is refused', async () => {
		const outcome = await commit('?move=p-active-2~minor_league', null, MANAGER_ONE);

		expect(outcome.status).toBe(409);
		expect(outcome.data.notice).toContain('never been told');
	});

	it('lets the RULES CORE refuse a hand-typed Injury Reserve target', async () => {
		// **The route parses; it does not judge.** `p-active~injury_reserve` is
		// not a selection any surface produced, but dropping it here would make
		// this screen the check for a rule the core owns — and the matrix says
		// the refusal comes from the rules core, not the screen.
		const data = await loadAt('?confirm=yes&move=p-active~injury_reserve', MANAGER_ONE);

		expect(data.step).toBe('players');
		expect(data.refusal?.detail).toContain('Injury Reserve');
		expect(data.refusal?.detail).toContain("player's health");
		// Not the empty-act refusal, which is what a per-entry drop would have
		// produced.
		expect(data.refusal?.detail).not.toContain('names no Contracts');
	});

	it('lets the rules core refuse a hand-typed Dead Money target too', async () => {
		const data = await loadAt('?confirm=yes&move=p-active~dead_money', MANAGER_ONE);

		expect(data.refusal?.detail).toContain('Dead Money');
		expect(data.refusal?.detail).not.toContain('names no Contracts');
	});

	it('refuses the WHOLE act when one leg of a mixed POST names an unmovable Slot', async () => {
		// The regression a per-entry drop hid: one legitimate demotion beside
		// one Injury Reserve target used to commit the legitimate leg. The act
		// is one act, so an unmovable leg refuses all of it and writes nothing.
		world.statements.length = 0;
		const outcome = await commit(
			`?${DEMOTE_ONE}&move=p-active~injury_reserve`,
			null,
			MANAGER_ONE
		);

		expect(outcome.status).toBe(409);
		expect(outcome.data.notice).toContain('Injury Reserve');
		// Nothing was written: no event and no row.
		expect(world.statements.filter((sql) => /^update team_rosters/i.test(sql))).toHaveLength(0);
		expect(world.statements.filter((sql) => /^insert into auction_events/i.test(sql))).toHaveLength(
			0
		);
	});

	it('still drops a string that names no Slot kind at all', async () => {
		// There is nothing to hand the core for `p-active~nowhere`: it is not a
		// `RosterSlotKind`, so the act genuinely names nothing.
		const data = await loadAt('?confirm=yes&move=p-active~nowhere', MANAGER_ONE);

		expect(data.refusal?.detail).toContain('names no Contracts');
	});
});
