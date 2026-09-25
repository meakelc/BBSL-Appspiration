/**
 * The `/bid-reinstatement` handlers, driven as MODULES (Story 7.14, FR-32).
 *
 * `tests/routes/close-reversal.test.ts`'s template: the REAL
 * `requireCommissioner`, `requireLiveDestination`, `requireOverridablePhase`
 * and `requireOverrideReason` all run — only `$lib/shell/db.ts` is faked, and
 * it answers the Knecht log. So "a non-Commissioner or a blank reason is
 * refused before any write" is a proof rather than a claim.
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
					return { rows: [{ locked: true, now: new Date('2026-09-25T18:00:00.000Z') }] };
				}
				if (/^select now\(\)/i.test(sql)) {
					return { rows: [{ now: new Date('2026-09-25T18:00:00.000Z') }] };
				}
				if (/^select \* from auction_events/i.test(sql)) return { rows: world.events };
				if (/^select[\s\S]*from team_rosters/i.test(sql)) return { rows: [] };
				if (/^insert into auction_events/i.test(sql)) {
					return {
						rows: [
							{
								seq: 6001,
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
				if (/^select coalesce\(discord_mention_user_id/i.test(sql)) return { rows: [] };
				if (/^insert into notification_outbox/i.test(sql)) return { rows: [] };
				throw new Error(`unexpected statement: ${sql}`);
			},
			release: () => {}
		})
	})
}));

const route = await import('../../src/routes/bid-reinstatement/+page.server.ts');
const fixture = await import('../fixtures/bid-reinstatement-log.ts');

world.events = fixture.knechtLog().map((event) => ({
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

const COMMISSIONER: RegisteredManager = {
	id: 'm-c',
	discordUserId: '111',
	displayName: 'Commissioner Bob',
	teamId: 't-cha',
	teamName: 'Charlotte',
	isCommissioner: true
};

const MANAGER: RegisteredManager = {
	id: 'm-det',
	discordUserId: '222',
	displayName: 'Alice',
	teamId: 't-det',
	teamName: 'Detroit',
	isCommissioner: false
};

const AUCTION: ResolvedPhase = { name: 'Auction', sentence: 'Auction.', announcement: null };
const CONTRACT_ASSIGNMENT: ResolvedPhase = {
	name: 'Contract Assignment',
	sentence: 'Contract Assignment.',
	announcement: null
};
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
	auctionHref: string | null;
};

async function loadAt(
	query: string,
	manager: RegisteredManager | null = COMMISSIONER,
	phase = AUCTION
): Promise<LoadResult> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (await route.load({
		locals: locals(manager, phase),
		url: new URL(`http://localhost/bid-reinstatement${query}`)
	} as any)) as unknown as LoadResult;
}

async function reinstate(
	query: string,
	reason: string | null,
	manager: RegisteredManager | null = COMMISSIONER,
	phase = AUCTION
) {
	const form = new FormData();
	if (reason !== null) form.set('reason', reason);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return await (route.actions as any).reinstate({
		locals: locals(manager, phase),
		url: new URL(`http://localhost/bid-reinstatement${query}`),
		request: new Request('http://localhost/bid-reinstatement', {
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

const Q = `?cancellation=${fixture.CANCELLATION_SEQ}`;

describe('/bid-reinstatement — the guards, on load AND on the action, before any write', () => {
	it('refuses a Manager who is not the Commissioner, both ways, writing nothing', async () => {
		world.statements.length = 0;
		await expectRefusal(() => loadAt(Q, MANAGER), COMMISSIONER_ONLY_STATUS);
		await expectRefusal(() => reinstate(Q, 'A reason.', MANAGER), COMMISSIONER_ONLY_STATUS);
		expect(world.statements).toEqual([]);
	});

	it('refuses a signed-out visitor, both ways', async () => {
		await expectRefusal(() => loadAt(Q, null), COMMISSIONER_ONLY_STATUS);
		await expectRefusal(() => reinstate(Q, 'A reason.', null), COMMISSIONER_ONLY_STATUS);
	});

	it('is not live outside the Auction Phase, both ways', async () => {
		for (const phase of [CONTRACT_ASSIGNMENT, ARCHIVED]) {
			await expectRefusal(() => loadAt(Q, COMMISSIONER, phase), LIVE_DESTINATION_REFUSAL_STATUS);
			await expectRefusal(
				() => reinstate(Q, 'A reason.', COMMISSIONER, phase),
				LIVE_DESTINATION_REFUSAL_STATUS
			);
		}
	});

	it('refuses a reasonless or blank POST with 400, before any transaction is opened', async () => {
		world.statements.length = 0;
		await expectRefusal(() => reinstate(Q, null), OVERRIDE_REASON_REQUIRED_STATUS);
		await expectRefusal(() => reinstate(Q, '   '), OVERRIDE_REASON_REQUIRED_STATUS);
		expect(world.statements).toEqual([]);
	});
});

describe('/bid-reinstatement — the sheet and the commit', () => {
	it('renders the reason sheet for a reinstatable cancellation', async () => {
		const data = await loadAt(Q);
		expect(data.refusal).toBeNull();
		expect(data.sheet?.act.startsWith("Reinstate Detroit's $2.0M Bid on Dalton Knecht")).toBe(true);
		expect(data.sheet?.commitLabel).toBe('Reinstate this Bid');
		expect(data.sheet?.reasonFieldName).toBe('reason');
		expect(data.commitAction).toBe(`?/reinstate&cancellation=${fixture.CANCELLATION_SEQ}`);
		expect(data.auctionHref).toBe(`/auction/${fixture.KNECHT}`);
	});

	it('states the core’s refusal for a seq that is no cancellation, and renders no sheet', async () => {
		for (const query of ['', '?cancellation=', '?cancellation=drop%20table']) {
			const data = await loadAt(query);
			expect(data.sheet).toBeNull();
			expect(data.refusal?.detail).toBe('No Bid Cancellation was named, so there is nothing to reinstate.');
		}
		const bid = await loadAt(`?cancellation=${fixture.DET_BID_SEQ}`);
		expect(bid.sheet).toBeNull();
		expect(bid.refusal?.detail).toContain('nothing to reinstate');
	});

	it('links a refusal back to the Auction whenever the log names its Player', async () => {
		const original = world.events;
		world.events = [
			...original,
			{
				seq: 6001,
				occurred_at: '2026-09-25T18:00:00.000Z',
				schema_version: 1,
				core_version: 1,
				manager_id: 'm-c',
				team_id: 't-cha',
				event_type: 'BidCancellationReversed',
				payload: { fantraxPlayerId: fixture.KNECHT, cancellationSeq: fixture.CANCELLATION_SEQ },
				device_class: null
			}
		];
		try {
			const data = await loadAt(Q);
			expect(data.sheet).toBeNull();
			expect(data.refusal?.detail).toContain('already reinstated');
			expect(data.auctionHref).toBe(`/auction/${fixture.KNECHT}`);
		} finally {
			world.events = original;
		}
		// No cancellation found: nothing to link back to.
		expect((await loadAt('')).auctionHref).toBeNull();
	});

	it('commits with a reason and appends one BidCancellationReversed, and no close', async () => {
		world.statements.length = 0;
		const result = await reinstate(Q, 'Butler was already on IR.');
		expect(result.notice).toContain('The Bid is reinstated');
		expect(result.appended?.seq).toBe('6001');
		expect(world.statements.filter((sql) => /^insert into auction_events/i.test(sql))).toHaveLength(1);
		expect(
			world.statements.filter((sql) => /^(update|delete from) auction_events/i.test(sql))
		).toEqual([]);
	});
});

describe('the Auction page control — placement, and the guard it does not replace', () => {
	const PAGE = readFileSync('src/routes/auction/[fantraxPlayerId]/+page.svelte', 'utf8');
	const SERVER = readFileSync('src/routes/auction/[fantraxPlayerId]/+page.server.ts', 'utf8');

	it('links a cancelled, non-entry row to the sheet with its cancellation seq, inside a Commissioner block', () => {
		expect(PAGE).toMatch(
			/\{#if data\.canReinstateBids && bid\.cancellation\.reinstatable\}[\s\S]*?<span class="commissioner-block">[\s\S]*?class="control-commissioner"[\s\S]*?href="\/bid-reinstatement\?cancellation=\{bid\.cancellation\.cancellationSeq\}"/
		);
	});

	it('offers it exactly where the destination is live — from the one catalog', () => {
		expect(SERVER).toContain('resolveDestinations(');
		expect(SERVER).toContain("'bid-reinstatement'");
	});
});
