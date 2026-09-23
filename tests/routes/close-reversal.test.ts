/**
 * The `/close-reversal` handlers, driven as MODULES (Story 7.13, FR-32).
 *
 * `tests/routes/roster-drop.test.ts`'s template: the REAL
 * `requireCommissioner`, `requireLiveDestination`, `requireOverridablePhase`
 * and `requireOverrideReason` all run — only `$lib/shell/db.ts` is faked, and
 * it answers the §10 example 58 log. So "a non-Commissioner is refused on
 * `load` and on the POST, whatever rendered" and "a reasonless POST is
 * refused server-side" are proofs rather than claims.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

import { COMMISSIONER_ONLY_STATUS } from '../../src/lib/server/commissioner-guard.ts';
import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import { OVERRIDE_REASON_REQUIRED_STATUS } from '../../src/lib/server/override-guard.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';
import type { ReasonSheetView } from '../../src/lib/reason-sheet-view.ts';

const world = vi.hoisted(() => ({
	/** The log the fake answers with, as `auction_events` rows. */
	events: [] as Array<Record<string, unknown>>,
	/** Team R's imported rows. */
	rosters: [] as Array<Record<string, unknown>>,
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
					return { rows: [{ locked: true, now: new Date('2026-09-23T19:00:00.000Z') }] };
				}
				if (/^select \* from auction_events/i.test(sql)) return { rows: world.events };
				if (/^select[\s\S]*from team_rosters/i.test(sql)) {
					return { rows: String(params[0]) === 't-r' ? world.rosters : [] };
				}
				if (/^insert into auction_events/i.test(sql)) {
					return {
						rows: [
							{
								seq: 50,
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
				if (/^insert into nomination_slots/i.test(sql)) return { rows: [] };
				if (/^select coalesce\(discord_mention_user_id/i.test(sql)) return { rows: [] };
				if (/^insert into notification_outbox/i.test(sql)) return { rows: [] };
				throw new Error(`unexpected statement: ${sql}`);
			},
			release: () => {}
		})
	})
}));

const route = await import('../../src/routes/close-reversal/+page.server.ts');
const fixture = await import('../fixtures/close-reversal-log.ts');

world.events = fixture.baseLog().map((event) => ({
	seq: Number(event.seq),
	occurred_at: event.occurredAt,
	schema_version: 1,
	core_version: 1,
	manager_id: event.managerId,
	team_id: event.teamId,
	event_type: event.type,
	payload: event.payload,
	device_class: null
}));
world.rosters = fixture.importedRowsR().map((row) => ({
	fantrax_player_id: row.fantraxPlayerId,
	player_name: row.playerName,
	cap_hit: row.value,
	roster_slot_kind: row.rosterSlotKind,
	contract_years_remaining: 3,
	rookie_scale_round: null
}));

const COMMISSIONER: RegisteredManager = {
	id: 'm-c',
	discordUserId: '111',
	displayName: 'Commissioner Bob',
	teamId: 't-t',
	teamName: 'Team T',
	isCommissioner: true
};

const MANAGER: RegisteredManager = {
	id: 'm-r',
	discordUserId: '222',
	displayName: 'Alice',
	teamId: 't-r',
	teamName: 'Team R',
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
	sheet: ReasonSheetView | null;
	refusal: { detail: string } | null;
	commitAction: string | null;
	teamHref: string | null;
};

async function loadAt(
	query: string,
	manager: RegisteredManager | null = COMMISSIONER,
	phase = AUCTION
): Promise<LoadResult> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (await route.load({
		locals: locals(manager, phase),
		url: new URL(`http://localhost/close-reversal${query}`)
	} as any)) as unknown as LoadResult;
}

async function reverse(
	query: string,
	reason: string | null,
	manager: RegisteredManager | null = COMMISSIONER,
	phase = AUCTION
) {
	const form = new FormData();
	if (reason !== null) form.set('reason', reason);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return await (route.actions as any).reverse({
		locals: locals(manager, phase),
		url: new URL(`http://localhost/close-reversal${query}`),
		request: new Request('http://localhost/close-reversal', {
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

describe('/close-reversal — the guards, on load AND on the action', () => {
	it('refuses a Manager who is not the Commissioner, both ways', async () => {
		await expectRefusal(() => loadAt('?close=7', MANAGER), COMMISSIONER_ONLY_STATUS);
		await expectRefusal(() => reverse('?close=7', 'A reason.', MANAGER), COMMISSIONER_ONLY_STATUS);
	});

	it('refuses a signed-out visitor, both ways', async () => {
		await expectRefusal(() => loadAt('?close=7', null), COMMISSIONER_ONLY_STATUS);
		await expectRefusal(() => reverse('?close=7', 'A reason.', null), COMMISSIONER_ONLY_STATUS);
	});

	it('refuses everybody once the League is Archived, both ways', async () => {
		await expectRefusal(() => loadAt('?close=7', COMMISSIONER, ARCHIVED), LIVE_DESTINATION_REFUSAL_STATUS);
		await expectRefusal(
			() => reverse('?close=7', 'A reason.', COMMISSIONER, ARCHIVED),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
	});

	it('refuses a reasonless POST with 400, before any transaction is opened', async () => {
		world.statements.length = 0;
		await expectRefusal(() => reverse('?close=7', null), OVERRIDE_REASON_REQUIRED_STATUS);
		await expectRefusal(() => reverse('?close=7', '   '), OVERRIDE_REASON_REQUIRED_STATUS);
		expect(world.statements).toEqual([]);
	});
});

describe('/close-reversal — the sheet and the commit', () => {
	it('renders the reason sheet for a reversible Close', async () => {
		const data = await loadAt('?close=7');
		expect(data.refusal).toBeNull();
		expect(data.sheet?.act.startsWith('Reverse this Close — Player X')).toBe(true);
		expect(data.sheet?.commitLabel).toBe('Reverse this Close');
		expect(data.sheet?.reasonFieldName).toBe('reason');
		expect(data.commitAction).toBe('?/reverse&close=7');
		expect(data.teamHref).toBe('/teams/t-r');
	});

	it('states the core’s refusal for a seq that is not a Close, and renders no sheet', async () => {
		const data = await loadAt('?close=5');
		expect(data.sheet).toBeNull();
		expect(data.refusal?.detail).toContain('nothing to reverse');
		const garbage = await loadAt('?close=drop%20table');
		expect(garbage.sheet).toBeNull();
	});

	it('commits with a reason and appends one AuctionCloseReversed', async () => {
		world.statements.length = 0;
		const result = await reverse('?close=7', 'Illegal IR designation.');
		expect(result.notice).toContain('The Close is reversed');
		expect(result.appended?.seq).toBe('50');
		expect(
			world.statements.filter((sql) => /^insert into auction_events/i.test(sql))
		).toHaveLength(1);
		expect(world.statements.filter((sql) => /^(update|delete from) auction_events/i.test(sql))).toEqual(
			[]
		);
	});
});

describe('the Team page control — placement, and the guard it does not replace', () => {

	const PAGE = readFileSync('src/routes/teams/[teamId]/+page.svelte', 'utf8');
	const SERVER = readFileSync('src/routes/teams/[teamId]/+page.server.ts', 'utf8');

	it('links a WON row to the sheet with its closeSeq, dashed, inside a Commissioner block', () => {
		expect(PAGE).toMatch(
			/\{#if data\.canReverseCloses && entry\.won && entry\.closeSeq !== null\}[\s\S]*?<div class="commissioner-block">[\s\S]*?class="control-commissioner"[\s\S]*?href="\/close-reversal\?close=\{entry\.closeSeq\}"/
		);
	});

	it('offers it exactly where the destination is live — from the one catalog', () => {
		expect(SERVER).toContain('resolveDestinations(');
		expect(SERVER).toContain("'close-reversal'");
	});
});

describe('/close-reversal — no Close named', () => {
	it('reads cleanly with no ?close= or a non-numeric one', async () => {
		for (const query of ['', '?close=', '?close=drop%20table']) {
			const data = await loadAt(query);
			expect(data.sheet).toBeNull();
			expect(data.refusal?.detail).toBe('No Auction Close was named, so there is nothing to reverse.');
		}
	});
});
