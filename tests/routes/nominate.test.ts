import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { isHttpError } from '@sveltejs/kit';

import { classifyDeviceClass } from '../../src/lib/core/device-class.ts';
import { nominationRefusalDetail } from '../../src/lib/core/rules/nomination.ts';
import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';

/**
 * The `/nominate` handlers, exercised through the REAL
 * `requireLiveDestination` guard (nothing about it is mocked) so this proves
 * the route actually calls it on `load` AND on the action. Only the
 * I/O-touching layer is faked.
 */

const stub = vi.hoisted(() => ({
	pool: {} as Record<string, unknown>,
	outcome: { kind: 'accepted', events: [] as unknown[] } as Record<string, unknown>
}));

const placeCalls = vi.hoisted(
	() =>
		[] as Array<{
			actor: { managerId: string; teamId: string; teamName: string };
			fantraxPlayerId: string;
			deviceClass: string;
		}>
);

const loadCalls = vi.hoisted(() => [] as Array<string | null>);

vi.mock('$lib/server/nomination.ts', () => ({
	loadNominatablePool: async (_gateway: unknown, actorTeamId: string | null) => {
		loadCalls.push(actorTeamId);
		return stub.pool;
	},
	placeNomination: vi.fn(
		async (
			_gateway: unknown,
			actor: { managerId: string; teamId: string; teamName: string },
			fantraxPlayerId: string,
			deviceClass: string
		) => {
			placeCalls.push({ actor, fantraxPlayerId, deviceClass });
			return stub.outcome;
		}
	)
}));

vi.mock('$lib/shell/db.ts', () => ({
	writeGateway: () => ({
		connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} })
	})
}));

const route = await import('../../src/routes/nominate/+page.server.ts');

const MANAGER: RegisteredManager = {
	id: 'm-2',
	discordUserId: '222',
	displayName: 'Alice',
	teamId: 't-2',
	teamName: 'Lakers',
	isCommissioner: false
};

const COMMISSIONER: RegisteredManager = {
	id: 'm-1',
	discordUserId: '111',
	displayName: 'Commissioner Bob',
	teamId: 't-1',
	teamName: 'Celtics',
	isCommissioner: true
};

const SETUP_PHASE: ResolvedPhase = { name: 'Setup', sentence: 'Setup.' };
const AUCTION_PHASE: ResolvedPhase = { name: 'Auction', sentence: 'Auction.' };

function locals(session: SessionState, phase: ResolvedPhase = AUCTION_PHASE) {
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
	stub.pool = { players: [], slotAvailable: true, slotDetail: null, consequence: 'Consequence.' };
	stub.outcome = {
		kind: 'accepted',
		events: [
			{
				seq: '41',
				occurredAt: '2026-08-26T09:00:00.000Z',
				deviceClass: 'mobile',
				payload: { playerName: 'Jalen Green' }
			}
		]
	};
	placeCalls.length = 0;
	loadCalls.length = 0;
});

describe('load — a Manager destination, gated on the destination and NOT on the role', () => {
	it('serves an ordinary Manager — nominating is not an administrative act', async () => {
		const result = (await route.load({
			locals: locals({ kind: 'registered', manager: MANAGER })
		} as never)) as { pool: unknown };
		expect(result.pool).toEqual(stub.pool);
	});

	it('serves the Commissioner too — they are a Manager like any other', async () => {
		await route.load({ locals: locals({ kind: 'registered', manager: COMMISSIONER }) } as never);
		expect(loadCalls).toEqual(['t-1']);
	});

	it('refuses a Manager outside the Auction Phase — this destination is not live in Setup', async () => {
		await expectRefusal(
			() =>
				route.load({
					locals: locals({ kind: 'registered', manager: MANAGER }, SETUP_PHASE)
				} as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
	});

	it('refuses a signed-out session with 403', async () => {
		await expectRefusal(
			() => route.load({ locals: locals({ kind: 'signed-out' }) } as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
	});

	it('passes the acting Team from the session, never from anywhere else', async () => {
		await route.load({ locals: locals({ kind: 'registered', manager: MANAGER }) } as never);
		expect(loadCalls).toEqual(['t-2']);
	});

	it('passes null for a Manager bound to no Team, rather than inventing one', async () => {
		const unbound: RegisteredManager = { ...MANAGER, teamId: null };
		await route.load({ locals: locals({ kind: 'registered', manager: unbound }) } as never);
		expect(loadCalls).toEqual([null]);
	});

	it('returns the pool as the core worded it, without re-wording anything', async () => {
		stub.pool = {
			players: [
				{
					fantraxPlayerId: 'p-1',
					playerName: 'Jalen Green',
					positions: 'SG',
					nbaTeam: 'HOU',
					available: false,
					unavailableDetail: nominationRefusalDetail({
						kind: 'already_nominated',
						playerName: 'Jalen Green',
						teamName: 'Celtics'
					})
				}
			],
			slotAvailable: true,
			slotDetail: null,
			consequence: 'Consequence.'
		};
		const result = (await route.load({
			locals: locals({ kind: 'registered', manager: MANAGER })
		} as never)) as { pool: unknown };
		expect(result.pool).toEqual(stub.pool);
	});
});

describe('actions.nominate — gated the same way, and never the check itself', () => {
	const nominateAction = route.actions.nominate as unknown as (event: unknown) => unknown;

	function nominateEvent(
		fields: Array<[string, string]>,
		session: SessionState = { kind: 'registered', manager: MANAGER },
		phase: ResolvedPhase = AUCTION_PHASE,
		headers: Record<string, string> = {
			'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148'
		}
	) {
		const form = new FormData();
		for (const [key, value] of fields) form.append(key, value);
		return {
			request: new Request('https://app.example/nominate', {
				method: 'POST',
				body: form,
				headers
			}),
			locals: locals(session, phase)
		};
	}

	const CONFIRMED: Array<[string, string]> = [
		['fantraxPlayerId', 'p-1'],
		['confirm', 'yes']
	];

	it('refuses outside the Auction Phase — the destination guard runs on the action too', async () => {
		await expectRefusal(
			() =>
				nominateAction(
					nominateEvent(CONFIRMED, { kind: 'registered', manager: MANAGER }, SETUP_PHASE)
				),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(placeCalls).toEqual([]);
	});

	it('refuses a signed-out session with 403', async () => {
		await expectRefusal(
			() => nominateAction(nominateEvent(CONFIRMED, { kind: 'signed-out' })),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(placeCalls).toEqual([]);
	});

	it('serves an ordinary Manager — there is no Commissioner gate here', async () => {
		await nominateAction(nominateEvent(CONFIRMED));
		expect(placeCalls).toHaveLength(1);
	});

	it('refuses an unconfirmed submit with 400 in the core’s words, opening no transaction', async () => {
		const result = (await nominateAction(nominateEvent([['fantraxPlayerId', 'p-1']]))) as {
			status: number;
			data: { notice: string };
		};
		expect(result.status).toBe(400);
		expect(result.data.notice).toBe(
			nominationRefusalDetail({ kind: 'unconfirmed', playerName: 'a Player' })
		);
		expect(placeCalls).toEqual([]);
	});

	it.each(['no', 'true', 'YES', 'on'])(
		'refuses the confirmation value %s — only the exact word confirms',
		async (value: string) => {
			const result = (await nominateAction(
				nominateEvent([
					['fantraxPlayerId', 'p-1'],
					['confirm', value]
				])
			)) as { status: number };
			expect(result.status).toBe(400);
			expect(placeCalls).toEqual([]);
		}
	);

	it.each([
		['absent', [['confirm', 'yes']]],
		['empty', [['fantraxPlayerId', ''], ['confirm', 'yes']]],
		['whitespace', [['fantraxPlayerId', '   '], ['confirm', 'yes']]]
	] as ReadonlyArray<[string, [string, string][]]>)(
		'refuses a submit naming no Player (%s) with 400, opening no transaction',
		async (_label: string, fields: [string, string][]) => {
			// The point of the check is that it costs nothing: a request that
			// names nobody must never reach the global advisory lock and the
			// two lookups only to be told the Player is unknown.
			const result = (await nominateAction(nominateEvent(fields))) as {
				status: number;
				data: { notice: string };
			};

			expect(result.status).toBe(400);
			expect(result.data.notice).toBe(nominationRefusalDetail({ kind: 'unknown_player' }));
			expect(placeCalls).toEqual([]);
		}
	);

	it('refuses with 400 when the acting Manager is bound to no Team, opening no transaction', async () => {
		const unbound: RegisteredManager = { ...MANAGER, teamId: null };
		const result = (await nominateAction(
			nominateEvent(CONFIRMED, { kind: 'registered', manager: unbound })
		)) as { status: number; data: { notice: string } };

		expect(result.status).toBe(400);
		expect(result.data.notice).toBe(nominationRefusalDetail({ kind: 'unbound_actor' }));
		expect(placeCalls).toEqual([]);
	});

	it('passes the actor from the session, never from a form field', async () => {
		await nominateAction(
			nominateEvent([
				...CONFIRMED,
				['managerId', 'not-me'],
				['teamId', 'not-my-team'],
				['teamName', 'Not My Team']
			])
		);
		expect(placeCalls[0]?.actor).toEqual({
			managerId: MANAGER.id,
			teamId: MANAGER.teamId,
			teamName: MANAGER.teamName
		});
	});

	it('passes the chosen Player through from the form — that IS a form field', async () => {
		await nominateAction(nominateEvent(CONFIRMED));
		expect(placeCalls[0]?.fantraxPlayerId).toBe('p-1');
	});

	it('classifies the User-Agent header and passes the class, not the header', async () => {
		await nominateAction(nominateEvent(CONFIRMED));
		expect(placeCalls[0]?.deviceClass).toBe('mobile');
		expect(placeCalls[0]?.deviceClass).toBe(
			classifyDeviceClass('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148')
		);
	});

	it('passes "unknown" when the request carries no User-Agent — never null', async () => {
		await nominateAction(nominateEvent(CONFIRMED, undefined, undefined, {}));
		expect(placeCalls[0]?.deviceClass).toBe('unknown');
		expect(placeCalls[0]?.deviceClass).not.toBeNull();
	});

	it('renders the refusal sentence the transaction produced, without rewording it', async () => {
		const refusal = { kind: 'slot_in_use', playerName: 'Amen Thompson' } as const;
		stub.outcome = {
			kind: 'rejected',
			reason: { refusal, detail: nominationRefusalDetail(refusal) }
		};
		const result = (await nominateAction(nominateEvent(CONFIRMED))) as {
			status: number;
			data: { notice: string };
		};

		expect(result.status).toBe(409);
		expect(result.data.notice).toBe(nominationRefusalDetail(refusal));
	});

	it('falls back to the core’s unrecorded sentence for a rejection stating no reason', async () => {
		stub.outcome = { kind: 'rejected' };
		const result = (await nominateAction(nominateEvent(CONFIRMED))) as {
			status: number;
			data: { notice: string };
		};
		expect(result.status).toBe(409);
		expect(result.data.notice).toBe(nominationRefusalDetail({ kind: 'unrecorded' }));
	});

	it('reports the appended event, naming the Player and the device class', async () => {
		const result = (await nominateAction(nominateEvent(CONFIRMED))) as {
			notice: string;
			appended: { seq: string; deviceClass: string | null } | null;
		};
		expect(result.appended).toEqual({
			seq: '41',
			occurredAt: '2026-08-26T09:00:00.000Z',
			deviceClass: 'mobile'
		});
		expect(result.notice).toContain('The nomination is placed');
		expect(result.notice).toContain('Jalen Green');
		expect(result.notice).toContain('League Clock');
	});
});

// --- The surface -------------------------------------------------------------

describe('the nomination surface', () => {
	/**
	 * Asserted against the source text, not a render: `vite.config.ts` sets
	 * `environment: 'node'` and no component harness exists (deferred-work.md),
	 * so `tests/signin-surface.test.ts` established this discipline for every
	 * surface claim in the repository.
	 */
	const SOURCE = readFileSync(
		new URL('../../src/routes/nominate/+page.svelte', import.meta.url),
		'utf8'
	);

	/**
	 * The same source with every comment removed.
	 *
	 * A file's own explanation of why it offers no ranked list necessarily
	 * contains the word "ranked"; asserting against raw text would make the
	 * documentation fail the test it documents. Comments are not what a
	 * Manager sees.
	 */
	const MARKUP = SOURCE.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[^:/])\/\/.*/g, '$1');

	it('offers only MANAGER controls, in Manager blocks — AC6', () => {
		expect(SOURCE).toContain('class="manager-block"');
		expect(SOURCE).toContain('class="control-manager"');
		expect(SOURCE, 'a Commissioner control on a Manager surface').not.toContain(
			'control-commissioner'
		);
		expect(SOURCE, 'a Commissioner block on a Manager surface').not.toContain(
			'commissioner-block'
		);
	});

	it('is a TWO-PART act: a single-select list, then a separate confirm and submit — AC6', () => {
		// A radio, not a checkbox: a Team has one Nomination Slot, so two
		// selections are impossible in the markup rather than refused later.
		expect(SOURCE).toContain('type="radio"');
		expect(SOURCE).toContain('bind:group={selected}');
		// The confirm is its own control, and it is not the same control.
		expect(SOURCE).toContain('id="nominate-confirm"');
		expect(SOURCE).toContain('bind:checked={confirmed}');
		expect((SOURCE.match(/type="submit"/g) ?? []).length).toBe(1);
		// Selecting must not submit.
		expect(SOURCE, 'selecting a Player submits the form').not.toMatch(/onchange=\{[^}]*submit/i);
	});

	it('disables the submit from one flag and always states the reason, by a stable id', () => {
		expect(SOURCE).toContain('disabled={blocked}');
		expect(SOURCE).toContain('aria-describedby="nominate-availability"');
		expect(SOURCE).toContain('id="nominate-availability"');
		// Always present in the DOM, never inside an `{#if}` that could remove
		// it — otherwise `aria-describedby` would dangle.
		const availabilityAt = SOURCE.indexOf('id="nominate-availability"');
		const formAt = SOURCE.indexOf('<form');
		expect(availabilityAt).toBeGreaterThan(-1);
		expect(availabilityAt).toBeLessThan(formAt);
	});

	it('gives every disabled control a reason that actually resolves', () => {
		// Each disabled radio points at its own unavailability sentence, and
		// that id is generated from the same expression.
		const controls = [...SOURCE.matchAll(/<(?:button|input)\b[\s\S]*?>/g)].map((m) => m[0]);
		for (const control of controls) {
			if (!/\bdisabled[=\s>]/.test(control)) continue;
			expect(control, `a disabled control states no reason: ${control}`).toMatch(
				/aria-describedby/
			);
		}
		expect(SOURCE).toContain('id={`unavailable-${player.fantraxPlayerId}`}');
		expect(SOURCE).toContain('`unavailable-${player.fantraxPlayerId}`');
	});

	it('states the consequence in words beside the confirm', () => {
		expect(SOURCE).toContain('pool.consequence');
		const confirmAt = SOURCE.indexOf('id="nominate-confirm"');
		const consequenceInConfirm = SOURCE.indexOf('pool.consequence', confirmAt);
		expect(consequenceInConfirm).toBeGreaterThan(confirmAt);
	});

	it('words no refusal of its own — every sentence comes from the server', () => {
		expect(SOURCE).toContain('pool.slotDetail');
		expect(SOURCE).toContain('player.unavailableDetail');
		expect(SOURCE, 'a refusal sentence is written in the surface').not.toContain(
			'Nothing was written'
		);
		expect(SOURCE, 'the consequence is re-worded in the surface').not.toContain(
			'No cap space is committed'
		);
	});

	it('offers no suggested, ranked or similar Player — AC6', () => {
		expect(MARKUP.toLowerCase()).not.toMatch(/suggest|recommend|ranked|ranking|similar|top pick/);
		// The list is the pool in the order the server sorted it, and nothing
		// re-sorts or slices it here.
		expect(SOURCE).toMatch(/#each pool\.players as player/);
		expect(SOURCE).not.toMatch(/pool\.players\.(sort|slice|filter)\(/);
	});

	it('names Players rather than counting them', () => {
		expect(SOURCE).toContain('player.playerName');
		expect(SOURCE, 'the surface counts what it should name').not.toMatch(
			/pool\.players\.length\s*\}/
		);
	});

	it('reaches no server-only module', () => {
		expect(SOURCE).not.toMatch(/\$lib\/server/);
	});

	it('stacks at 375px and becomes a table at the 640px breakpoint', () => {
		expect(SOURCE).toContain('@media (min-width: 640px)');
		expect(SOURCE).toMatch(/\.pool-table\s*\{\s*display:\s*block/);
	});

	it('keeps every row target at the 46px control height for one-handed use', () => {
		expect(SOURCE).toMatch(/\.row-select\s*\{[\s\S]*?min-height:\s*var\(--control-height\)/);
		expect(SOURCE).toMatch(/\.confirm\s*\{[\s\S]*?min-height:\s*var\(--touch-min\)/);
	});
});
