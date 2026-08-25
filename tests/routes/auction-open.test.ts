import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { isHttpError } from '@sveltejs/kit';

import { auctionOpenRefusalDetail } from '../../src/lib/core/rules/auction-open.ts';
import { COMMISSIONER_ONLY_STATUS } from '../../src/lib/server/commissioner-guard.ts';
import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';

/**
 * The `/auction-open` handlers, exercised through the REAL
 * `requireCommissioner`/`requireLiveDestination` guards (nothing about them is
 * mocked) so this proves the route actually calls them on `load` AND on the
 * action. Only the I/O-touching layer is faked.
 */

const stub = vi.hoisted(() => ({
	report: {} as Record<string, unknown>,
	outcome: { kind: 'accepted', events: [] as unknown[] } as Record<string, unknown>
}));

const openCalls = vi.hoisted(() => [] as Array<{ managerId: string; teamId: string }>);

vi.mock('$lib/server/auction-open.ts', () => ({
	readAuctionOpenReport: async () => ({ state: {}, report: stub.report }),
	openAuction: vi.fn(async (_gateway: unknown, actor: { managerId: string; teamId: string }) => {
		openCalls.push(actor);
		return stub.outcome;
	})
}));

vi.mock('$lib/shell/db.ts', () => ({
	writeGateway: () => ({
		connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} })
	})
}));

const route = await import('../../src/routes/auction-open/+page.server.ts');

const COMMISSIONER: RegisteredManager = {
	id: 'm-1',
	discordUserId: '111',
	displayName: 'Commissioner Bob',
	teamId: 't-1',
	teamName: 'Celtics',
	isCommissioner: true
};

const MANAGER: RegisteredManager = {
	id: 'm-2',
	discordUserId: '222',
	displayName: 'Alice',
	teamId: 't-2',
	teamName: 'Lakers',
	isCommissioner: false
};

const SETUP_PHASE: ResolvedPhase = { name: 'Setup', sentence: 'Setup.' };
const AUCTION_PHASE: ResolvedPhase = { name: 'Auction', sentence: 'Auction.' };

function locals(session: SessionState, phase: ResolvedPhase = SETUP_PHASE) {
	return { session, phase };
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

beforeEach(() => {
	stub.report = { ready: true, outstandingSources: [], unboundTeams: [] };
	stub.outcome = { kind: 'accepted', events: [{ seq: '11', occurredAt: 'now' }] };
	openCalls.length = 0;
});

describe('load — Commissioner-only, gated on both the guard and the destination', () => {
	it('refuses a non-Commissioner registered session with 403', async () => {
		await expectRefusal(
			() => route.load({ locals: locals({ kind: 'registered', manager: MANAGER }) } as never),
			COMMISSIONER_ONLY_STATUS
		);
	});

	it('refuses a signed-out session with 403', async () => {
		await expectRefusal(
			() => route.load({ locals: locals({ kind: 'signed-out' }) } as never),
			COMMISSIONER_ONLY_STATUS
		);
	});

	it('refuses a Commissioner outside Setup — this destination is not live in Auction', async () => {
		await expectRefusal(
			() =>
				route.load({
					locals: locals({ kind: 'registered', manager: COMMISSIONER }, AUCTION_PHASE)
				} as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
	});

	it('returns the report as the core worded it, without re-wording anything', async () => {
		stub.report = {
			ready: false,
			refusalDetail: auctionOpenRefusalDetail({ kind: 'not_promoted' }),
			outstandingSources: ['Lakers'],
			unboundTeams: [],
			eligibilitySentence: 'No Player is marked Minor League Eligible.',
			consequence: 'Opening the auction cannot be undone.'
		};
		const result = (await route.load({
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never)) as { report: unknown };

		expect(result.report).toEqual(stub.report);
	});
});

describe('actions.open — gated the same way, and never the check itself', () => {
	const openAction = route.actions.open as unknown as (event: unknown) => unknown;

	function openEvent(
		fields: Array<[string, string]>,
		session: SessionState = { kind: 'registered', manager: COMMISSIONER },
		phase: ResolvedPhase = SETUP_PHASE
	) {
		const form = new FormData();
		for (const [key, value] of fields) form.append(key, value);
		return {
			request: new Request('https://app.example/auction-open', { method: 'POST', body: form }),
			locals: locals(session, phase)
		};
	}

	it('refuses a non-Commissioner session with 403, before opening anything', async () => {
		await expectRefusal(
			() =>
				openAction(
					openEvent([['confirm', 'yes']], { kind: 'registered', manager: MANAGER })
				),
			COMMISSIONER_ONLY_STATUS
		);
		expect(openCalls).toEqual([]);
	});

	it('refuses a signed-out session with 403', async () => {
		await expectRefusal(
			() => openAction(openEvent([['confirm', 'yes']], { kind: 'signed-out' })),
			COMMISSIONER_ONLY_STATUS
		);
		expect(openCalls).toEqual([]);
	});

	it('refuses outside Setup — the destination guard runs on the action too', async () => {
		await expectRefusal(
			() =>
				openAction(
					openEvent(
						[['confirm', 'yes']],
						{ kind: 'registered', manager: COMMISSIONER },
						AUCTION_PHASE
					)
				),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(openCalls).toEqual([]);
	});

	it('refuses an unconfirmed submit with 400 in the core’s words, opening no transaction', async () => {
		const result = (await openAction(openEvent([]))) as {
			status: number;
			data: { notice: string };
		};
		expect(result.status).toBe(400);
		expect(result.data.notice).toBe(auctionOpenRefusalDetail({ kind: 'unconfirmed' }));
		expect(openCalls).toEqual([]);
	});

	it.each(['no', 'true', 'YES', 'on'])(
		'refuses the confirmation value %s — only the exact word confirms',
		async (value: string) => {
			const result = (await openAction(openEvent([['confirm', value]]))) as { status: number };
			expect(result.status).toBe(400);
			expect(openCalls).toEqual([]);
		}
	);

	it('refuses with 400 when the acting Commissioner is bound to no Team', async () => {
		const unbound: RegisteredManager = { ...COMMISSIONER, teamId: null };
		const result = (await openAction(
			openEvent([['confirm', 'yes']], { kind: 'registered', manager: unbound })
		)) as { status: number; data: { notice: string } };

		expect(result.status).toBe(400);
		expect(result.data.notice).toBe(auctionOpenRefusalDetail({ kind: 'unbound_actor' }));
		expect(openCalls).toEqual([]);
	});

	it('passes the actor from the session, never from a form field', async () => {
		const result = (await openAction(
			openEvent([
				['confirm', 'yes'],
				['managerId', 'not-me'],
				['teamId', 'not-my-team']
			])
		)) as { notice: string; appended: { seq: string } | null };

		expect(openCalls).toEqual([{ managerId: COMMISSIONER.id, teamId: COMMISSIONER.teamId }]);
		expect(result.appended).toEqual({ seq: '11', occurredAt: 'now' });
		expect(result.notice).toContain('The auction is open');
	});

	it('renders the refusal sentence the transaction produced, without rewording it', async () => {
		const refusal = { kind: 'unbound_teams', teamNames: ['Lakers'] } as const;
		stub.outcome = {
			kind: 'rejected',
			reason: { refusal, detail: auctionOpenRefusalDetail(refusal) }
		};
		const result = (await openAction(openEvent([['confirm', 'yes']]))) as {
			status: number;
			data: { notice: string };
		};

		expect(result.status).toBe(409);
		expect(result.data.notice).toBe(auctionOpenRefusalDetail(refusal));
	});
});

// --- The surface -------------------------------------------------------------

describe('the auction-open surface', () => {
	/**
	 * Asserted against the source text, not a render: `vite.config.ts` sets
	 * `environment: 'node'` and no component harness exists (deferred-work.md),
	 * so `tests/signin-surface.test.ts` established this discipline for every
	 * surface claim in the repository.
	 */
	const SOURCE = readFileSync(
		new URL('../../src/routes/auction-open/+page.svelte', import.meta.url),
		'utf8'
	);

	it('offers exactly one control, and it is a Commissioner control in a Commissioner block', () => {
		expect((SOURCE.match(/<button\b/g) ?? []).length).toBe(1);
		expect((SOURCE.match(/<form\b/g) ?? []).length).toBe(1);
		expect(SOURCE).toContain('class="commissioner-block"');
		expect(SOURCE).toContain('class="control-commissioner"');
		expect(SOURCE).not.toContain('control-manager');
	});

	it('disables the control from one flag and always states the reason, by a stable id', () => {
		expect(SOURCE).toContain('disabled={blocked}');
		expect(SOURCE).toContain('aria-describedby="auction-open-availability"');
		expect(SOURCE).toContain('id="auction-open-availability"');
		// Always present in the DOM, never inside the `{#if}` that could remove
		// it — otherwise `aria-describedby` would dangle.
		const availabilityAt = SOURCE.indexOf('id="auction-open-availability"');
		const formAt = SOURCE.indexOf('<form');
		expect(availabilityAt).toBeGreaterThan(-1);
		expect(availabilityAt).toBeLessThan(formAt);
	});

	it('names outstanding items rather than counting them', () => {
		expect(SOURCE).toContain('report.outstandingSources');
		expect(SOURCE).toContain('report.unboundTeams');
		expect(SOURCE).toMatch(/#each report\.outstandingSources as/);
		expect(SOURCE).toMatch(/#each report\.unboundTeams as/);
		expect(SOURCE, 'the surface counts what it should name').not.toMatch(
			/(outstandingSources|unboundTeams)\.length\s*\}/
		);
	});

	it('prints the eligibility sentence rather than a bare number, and gates nothing on it', () => {
		expect(SOURCE).toContain('report.eligibilitySentence');
		expect(SOURCE, 'the surface blocks on the eligible count').not.toMatch(
			/eligibleCount|eligibilityCount/
		);
	});

	it('words no refusal of its own — every sentence comes from the server', () => {
		expect(SOURCE).toContain('report.refusalDetail');
		expect(SOURCE).toContain('report.consequence');
		expect(SOURCE, 'a refusal sentence is written in the surface').not.toContain(
			'Nothing was written'
		);
	});

	it('reaches no server-only module', () => {
		expect(SOURCE).not.toMatch(/\$lib\/server/);
	});

	it('stacks at 375px and becomes a table at the 640px breakpoint', () => {
		expect(SOURCE).toContain('@media (min-width: 640px)');
		expect(SOURCE).toMatch(/\.named-table\s*\{\s*display:\s*block/);
	});
});
