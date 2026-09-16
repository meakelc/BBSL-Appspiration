import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { isHttpError } from '@sveltejs/kit';

import { classifyDeviceClass } from '../../src/lib/core/device-class.ts';
import {
	nominationPoolStatus,
	nominationRefusalDetail
} from '../../src/lib/core/rules/nomination.ts';
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
			actor: { managerId: string; teamId: string; teamName: string; spendsSlot: boolean };
			fantraxPlayerId: string;
			deviceClass: string;
		}>
);

const loadCalls = vi.hoisted(() => [] as Array<string | null>);

/** The exemption flag the `load` passed through, per call (Story 9.8). */
const loadSpendsSlot = vi.hoisted(() => [] as boolean[]);

vi.mock('$lib/server/nomination.ts', () => ({
	loadNominatablePool: async (
		_gateway: unknown,
		actorTeamId: string | null,
		actorSpendsSlot: boolean
	) => {
		loadCalls.push(actorTeamId);
		loadSpendsSlot.push(actorSpendsSlot);
		return stub.pool;
	},
	placeNomination: vi.fn(
		async (
			_gateway: unknown,
			actor: { managerId: string; teamId: string; teamName: string; spendsSlot: boolean },
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

const SETUP_PHASE: ResolvedPhase = { name: 'Setup', sentence: 'Setup.' , announcement: null };
const AUCTION_PHASE: ResolvedPhase = { name: 'Auction', sentence: 'Auction.' , announcement: null };

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
	stub.pool = {
		players: [],
		slotAvailable: true,
		slotDetail: null,
		slotStatus: 'Open for nomination.',
		consequence: 'Consequence.'
	};
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
	loadSpendsSlot.length = 0;
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

	it('tells the pool a Commissioner spends no Slot, off the session flag (Story 9.8)', async () => {
		await route.load({ locals: locals({ kind: 'registered', manager: COMMISSIONER }) } as never);
		expect(loadSpendsSlot).toEqual([false]);
	});

	it('tells the pool an ordinary Manager DOES spend theirs', async () => {
		await route.load({ locals: locals({ kind: 'registered', manager: MANAGER }) } as never);
		expect(loadSpendsSlot).toEqual([true]);
	});

	it('defaults an unbound Manager to the strict rule rather than exempting them', async () => {
		// There is no actor at all, so there is no exemption to read. The
		// Manager rule is what a missing answer means.
		const unbound: RegisteredManager = { ...COMMISSIONER, teamId: null };
		await route.load({ locals: locals({ kind: 'registered', manager: unbound }) } as never);
		expect(loadSpendsSlot).toEqual([true]);
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
					status: nominationPoolStatus(
						{ kind: 'already_nominated', playerName: 'Jalen Green', teamName: 'Celtics' },
						false
					)
				}
			],
			slotAvailable: true,
			slotDetail: null,
			slotStatus: 'Open for nomination.',
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
			teamName: MANAGER.teamName,
			// Story 9.8: resolved from the session's `isCommissioner`, and in
			// this fixture that is an ordinary Manager, who spends their Slot.
			spendsSlot: true
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
		// The reason travels WITH the control it describes: both live inside
		// the form, in the one branch that renders when the pool is non-empty,
		// so `aria-describedby` cannot dangle — the button does not exist in
		// any branch the sentence is missing from.
		//
		// This is what the sticky action bar is for. The sentence used to sit
		// above the list, which for a ~1,470-Player pool meant the reason a
		// control was disabled was an entire pool's worth of scrolling away
		// from the control.
		const availabilityAt = SOURCE.indexOf('id="nominate-availability"');
		const formAt = SOURCE.indexOf('<form');
		const buttonAt = SOURCE.indexOf('type="submit"');
		const formEndAt = SOURCE.indexOf('</form>');
		expect(availabilityAt).toBeGreaterThan(formAt);
		expect(availabilityAt).toBeLessThan(buttonAt);
		expect(buttonAt).toBeLessThan(formEndAt);
	});

	it('narrows the list with controls that cannot submit it', () => {
		// Both controls change what is RENDERED and nothing else. They sit
		// OUTSIDE the form because a text input inside a form submits it on
		// Enter — and on this form that key press is a nomination, the one act
		// that must never happen by accident.
		const searchAt = SOURCE.indexOf('id="pool-search"');
		const formAt = SOURCE.indexOf('<form');
		expect(searchAt).toBeGreaterThan(-1);
		expect(searchAt).toBeLessThan(formAt);
		expect(SOURCE.indexOf('class="filter-positions"')).toBeLessThan(formAt);
		// Neither control is posted: a `name` on either would put filter state
		// into the payload the server gates on.
		const filterBlock = SOURCE.slice(SOURCE.indexOf('class="pool-filter"'), formAt);
		expect(filterBlock, 'a filter control carries a name and would be posted').not.toMatch(
			/\sname=/
		);
	});

	it('keeps the live region mounted while it has nothing to say', () => {
		// The pool size is not printed at rest, but the region that will carry
		// "No Player matches" must already exist when the Manager starts
		// typing: a live region added to the DOM is not announced by every
		// screen reader, and that sentence is the one this page cannot do
		// without.
		expect(SOURCE).toMatch(/<p class="prose" role="status">\s*\{poolCountSentence\(/);
		expect(SOURCE, 'the count is rendered conditionally and would go unannounced').not.toMatch(
			/\{#if[^}]*\}\s*<p class="prose" role="status">/
		);
		// And nothing explains the chips' resting state back to the Manager.
		expect(MARKUP, 'the page restates a control the Manager is looking at').not.toMatch(
			/No position is picked/
		);
	});

	it('decides what matches in the core, never in the surface', () => {
		// The page holds the two controls' state and prints what comes back.
		// A second predicate here is how a list and its own count disagree.
		expect(SOURCE).toContain("from '$lib/core/pool-filter.ts'");
		expect(SOURCE).toContain('filterPool(');
		expect(SOURCE).toContain('poolCountSentence(');
		expect(MARKUP, 'the surface words the count itself').not.toMatch(/Showing \d/);
	});

	it('renders the filtered rows, and never the chosen Player out from under them', () => {
		// The radio is the only thing carrying the selection, so a chosen
		// Player who stops matching must still be rendered — otherwise the
		// form posts no `fantraxPlayerId` at all.
		expect(SOURCE).toContain('{#each shown as player (player.fantraxPlayerId)}');
		expect(SOURCE, 'the list ignores the filter').not.toContain('{#each pool.players as player');
		expect(SOURCE).toContain("selected === '' ? [] : [selected]");
	});

	it('offers every position the export uses, from the core vocabulary', () => {
		// Iterated from `POOL_POSITIONS`, never a literal list in the markup —
		// a second vocabulary is a chip that can never match a row.
		expect(SOURCE).toContain('{#each POOL_POSITIONS as position (position)}');
		expect(SOURCE).toContain('POOL_POSITION_NAMES[position]');
		// Multi-select: the tokens are ORed, so `PG` and `SG` asks for either.
		const chipBlock = SOURCE.slice(
			SOURCE.indexOf('class="filter-positions"'),
			SOURCE.indexOf('</fieldset>')
		);
		expect(chipBlock).toContain('type="checkbox"');
		expect(chipBlock, 'the chips are single-select').not.toContain('type="radio"');
	});

	it('states the Slot at rest as a status, not as a refusal', () => {
		// The panel used to print `slotDetail` — a reply, ending in "Nothing
		// was written", to a submit nobody had made. Three lines of it pushed
		// the filter, the list and the control off a 375px first screen.
		//
		// `slotDetail` still speaks for every reason that IS a refusal: the
		// wrong phase, an unbound actor. Both branches are here, in that order.
		const slotAt = SOURCE.indexOf('id="nominate-slot"');
		const block = SOURCE.slice(slotAt, SOURCE.indexOf('</section>', slotAt));
		expect(block).toContain('pool.slotStatus');
		expect(block).toContain('pool.slotDetail');
		// And the surface writes neither of them.
		expect(block, 'the surface words the Slot itself').not.toMatch(/Nomination Slot is free/);
	});

	it('never outranks the persistent strip, whose menu opens over this page', () => {
		// The strip is `z-index: 1` and the layout mounts it BEFORE the page
		// content, so a bar at the same z-index wins by DOM order and paints
		// over the open menu — which expands upward to as much as 60svh.
		// `position: sticky` alone already puts this above the pool rows.
		// MARKUP, not SOURCE: this file EXPLAINS the missing z-index at length
		// right inside the rule, and a scan of the raw text would match the
		// explanation rather than a declaration.
		const bar = /\.action-bar \{[^}]*\}/.exec(MARKUP)?.[0] ?? '';
		expect(bar).toContain('position: sticky');
		expect(bar, 'the action bar outranks the strip and covers its menu').not.toMatch(
			/z-index:/
		);
	});

	it('marks the cost disclosure with an icon, not a sentence', () => {
		// The mark is the sighted affordance; a screen reader is already told
		// this is a disclosure and whether it is expanded, so the icon is
		// hidden from it and the words it stands in for are carried in text.
		expect(SOURCE).toContain('class="explainer-mark"');
		expect(SOURCE).toMatch(/class="explainer-mark" aria-hidden="true"/);
		expect(SOURCE).toContain('What does nominating cost?');
		expect(SOURCE, 'the icon is drawn at a literal size instead of tracking the text').toMatch(
			/\.explainer-mark svg \{[^}]*width: 1\.1em/
		);
	});

	it('puts the cost behind the Slot heading, without hiding it from the act', () => {
		// A `<details>`, not a hover tooltip: this page is designed for a phone
		// and there is no hover there. It opens on tap and on Enter, announces
		// its own expanded state, and needs no script.
		expect(SOURCE).toContain('<details class="explainer">');
		expect(SOURCE).toContain('<summary>');
		// It hangs off "Your Nomination Slot", beside the Slot a nomination
		// spends — not off a second heading over the list. There is no second
		// heading: "Nominate a Player" named the page a Manager is already on,
		// between a title and a submit button that both say it.
		expect(MARKUP, 'the list carries a heading that restates the page').not.toContain(
			'Nominate a Player'
		);
		const disclosureAt = SOURCE.indexOf('<details class="explainer">');
		expect(SOURCE.indexOf('Your Nomination Slot')).toBeGreaterThan(disclosureAt);
		expect(SOURCE.indexOf('id="nominate-slot"')).toBeGreaterThan(disclosureAt);
		expect(SOURCE, 'a hover-only affordance on a phone-first page').not.toMatch(
			/title=|role="tooltip"/
		);
		expect(SOURCE, 'the disclosure is open by default').not.toContain('<details class="explainer" open');
		// The confirmation no longer repeats the sentence; what it must still
		// do is be a separate, deliberate tick, which the two-part-act test
		// above asserts. All that is checked here is that the duplicate is
		// gone and has not crept back beneath the checkbox.
		const confirmAt = SOURCE.indexOf('id="nominate-confirm"');
		expect(SOURCE.indexOf('pool.consequence', confirmAt)).toBe(-1);
	});

	it('clears the whole mobile nav bar, never the bar minus a pixel', () => {
		// The mobile destination bar is fixed to the bottom of the same
		// viewport a sticky offset is measured against, and it occupies
		// exactly `--nav-height`. A negative offset here is what put this bar
		// ON the thing below it.
		expect(SOURCE).toMatch(/:global\(body:has\(\.mobile-nav\)\) \.action-bar \{\s*bottom: var\(--nav-height\);/);
		expect(SOURCE, 'a negative sticky offset overlaps whatever is below').not.toMatch(
			/\.action-bar[^}]*bottom:\s*-/
		);
		// And it clears the NAV's token, not the strip's. The strip is pinned
		// to the top now and nothing of it is down here; clearing 52px against
		// a 60px bar would leave the submit eight pixels under it — which is
		// exactly the failure this file's sticky offset exists to prevent, and
		// which the two tokens being interchangeable-looking makes easy.
		expect(SOURCE, 'the action bar clears the strip, which is no longer at this edge').not.toContain(
			'var(--strip-height)'
		);
	});

	it('keeps the confirm and the submit reachable from anywhere in the list', () => {
		// A Manager who ticks a Player at row 900 must not have to scroll to
		// the end of the pool to find the second half of the act. The bar is
		// `sticky`, not `fixed`: it belongs to the form, so it settles into
		// place at the end of the list rather than sitting over a short page.
		const barAt = SOURCE.indexOf('class="action-bar"');
		expect(barAt).toBeGreaterThan(SOURCE.indexOf('<form'));
		expect(barAt).toBeLessThan(SOURCE.indexOf('</form>'));
		expect(SOURCE).toMatch(/\.action-bar\s*\{[^}]*position:\s*sticky/);
		expect(SOURCE, 'the bar is fixed rather than sticky').not.toMatch(
			/\.action-bar\s*\{[^}]*position:\s*fixed/
		);
		// The confirm and the submit are both inside it — moving only one
		// would leave the act half-reachable.
		const confirmAt = SOURCE.indexOf('id="nominate-confirm"');
		const submitAt = SOURCE.indexOf('type="submit"');
		expect(confirmAt).toBeGreaterThan(barAt);
		expect(submitAt).toBeGreaterThan(barAt);
		// It clears the mobile destination bar, which is fixed to the bottom of
		// the same viewport a sticky offset is measured against.
		expect(SOURCE).toContain('var(--nav-height)');
	});

	it('gives every disabled control a reason that actually resolves', () => {
		// Each disabled radio points at its own state — `Nominated`,
		// `In-Auction`, `Closed to <Team>` — and that id is generated from the
		// same expression that stamps it on the label.
		const controls = [...SOURCE.matchAll(/<(?:button|input)\b[\s\S]*?>/g)].map((m) => m[0]);
		for (const control of controls) {
			if (!/\bdisabled[=\s>]/.test(control)) continue;
			expect(control, `a disabled control states no reason: ${control}`).toMatch(
				/aria-describedby/
			);
		}
		expect(SOURCE).toContain('`state-${player.fantraxPlayerId}`');
		// The id is stamped on the state label only when the row is disabled:
		// an available row has no reason to describe and nothing points at it.
		expect(SOURCE).toContain(
			'id={player.available ? undefined : `state-${player.fantraxPlayerId}`}'
		);
	});

	it('states the consequence in words, and states it exactly once', () => {
		// It used to be printed twice — behind the heading AND beneath the
		// confirmation — which put the same ~40 words on one screen and made
		// the second copy read as small print. The sentence is still the
		// core's and is still on the page; there is one of it.
		expect(SOURCE).toContain('pool.consequence');
		expect(SOURCE.match(/pool\.consequence/g)?.length).toBe(1);
		// And it lives behind the heading of the panel that states the Slot it
		// is charged against.
		const disclosureAt = SOURCE.indexOf('<details class="explainer">');
		expect(SOURCE.indexOf('pool.consequence')).toBeGreaterThan(disclosureAt);
	});

	it('words no refusal of its own — every sentence comes from the server', () => {
		expect(SOURCE).toContain('pool.slotDetail');
		expect(SOURCE).toContain('pool.slotStatus');
		expect(SOURCE).toContain('player.status');
		expect(SOURCE, 'a refusal sentence is written in the surface').not.toContain(
			'Nothing was written'
		);
		expect(SOURCE, 'the consequence is re-worded in the surface').not.toContain(
			'No cap space is committed'
		);
	});

	it('offers no suggested, ranked or similar Player — AC6', () => {
		expect(MARKUP.toLowerCase()).not.toMatch(/suggest|recommend|ranked|ranking|similar|top pick/);
		// The list is the pool in the order the SERVER sorted it, and nothing
		// re-sorts or slices it here.
		//
		// Narrowing is not reordering: `shown` is `filterPool`'s output, which
		// is a subsequence of its input in its input's order — asserted as
		// pure logic in `tests/core/pool-filter.test.ts` rather than inferred
		// from the markup. What this asserts is that the surface reaches for
		// that one function and holds no ordering of its own.
		expect(SOURCE).toMatch(/#each shown as player/);
		expect(SOURCE).toMatch(/const shown = \$derived\(filterPool\(pool\.players,/);
		expect(SOURCE, 'the surface orders or truncates the pool itself').not.toMatch(
			/pool\.players\.(sort|slice|reverse)\(/
		);
		expect(SOURCE, 'the surface filters the pool with a predicate of its own').not.toMatch(
			/pool\.players\.filter\(/
		);
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

	it('labels the detail cells for a screen reader without printing the labels', () => {
		// `PG,SG,G` and `BOS` say what they are; a visible label in front of
		// each is clutter on a phone and a second copy of the column header at
		// 640px. Below 640px the table is laid out as blocks, which strips its
		// table semantics — and so its headers — from the accessibility tree,
		// so the words are carried in hidden text at that width only.
		expect(SOURCE).toContain('<span class="visually-hidden cell-label">Positions: </span>');
		expect(SOURCE).toContain('<span class="visually-hidden cell-label">NBA team: </span>');
		expect(MARKUP, 'the label is printed beside the value').not.toMatch(
			/>Positions: \{player\.positions\}/
		);
		// And they are dropped where the real headers are announced again,
		// rather than saying the column's name twice on every one of 1,467 rows.
		const desktop = MARKUP.slice(MARKUP.indexOf('@media (min-width: 640px)'));
		expect(desktop).toMatch(/\.cell-label \{\s*display: none;/);
	});

	it('reads as one line per Player at 375px and becomes a table at 640px', () => {
		expect(SOURCE).toContain('@media (min-width: 640px)');
		expect(SOURCE).toMatch(/\.pool-table\s*\{\s*display:\s*block/);
		// A row was the radio, the name, the positions, the team and the state
		// each on its own line — ~120px of card for four short facts, three
		// Players to a 375px screen out of 1,467. It is a wrapping ROW now.
		const row = /\.pool-table tr \{[^}]*\}/.exec(MARKUP)?.[0] ?? '';
		expect(row).toContain('flex-direction: row');
		expect(row).toContain('flex-wrap: wrap');
		expect(row, 'the row stacks its cells again').not.toContain('flex-direction: column');
		// Nothing is truncated to achieve it, and no padding spaces a card
		// that no longer exists — `.row-select` holds the row open instead.
		expect(row, 'a row padded as though it were still a card').not.toMatch(/\spadding:/);
		expect(MARKUP, 'a Player name is truncated to fit the line').not.toMatch(
			/text-overflow:\s*ellipsis/
		);
	});

	it('states a row’s availability as a phrase, never a paragraph', () => {
		// It used to print "Not available" and then the SUBMIT's refusal
		// sentence under it — a paragraph ending in "Nothing was written"
		// about a submit nobody had made, repeated down ~1,470 rows. The state
		// is one phrase now, so the cell rides the row instead of claiming a
		// line of its own.
		expect(SOURCE, 'the refusal paragraph is back in the row').not.toContain(
			'unavailableDetail'
		);
		expect(SOURCE).not.toMatch(/\.cell-state:has\(\.prose\)/);
		expect(SOURCE).toMatch(/\.pool-table \.cell-state \{\s*flex: 0 1 auto;/);
	});

	it('recedes an unavailable Player’s name without making colour the message', () => {
		// The name is what a Manager scans, so a row they cannot pick greys it.
		expect(SOURCE).toContain('<tr class:unavailable={!player.available}>');
		expect(SOURCE).toMatch(
			/\.pool-table tr\.unavailable \.cell-player \{\s*color: var\(--color-text-secondary\);/
		);
		// `--color-text-disabled` is 2.7:1 and exempt from 1.4.3 only for a
		// CONTROL's label. A Player's name is content and stays legible.
		expect(MARKUP, 'a Player name is greyed to a disabled control’s contrast').not.toContain(
			'--color-text-disabled'
		);
		// And the state is still said in words on the same row, so nothing is
		// known only by being grey.
		expect(SOURCE).toContain('player.status');
	});

	it('keeps every row target at the 46px control height for one-handed use', () => {
		expect(SOURCE).toMatch(/\.row-select\s*\{[\s\S]*?min-height:\s*var\(--control-height\)/);
		expect(SOURCE).toMatch(/\.confirm\s*\{[\s\S]*?min-height:\s*var\(--touch-min\)/);
	});

	it('spends the touch floor on the controls that spend something, and not elsewhere', () => {
		// `--control-height` is the BID control's height and carries the 44px
		// floor with it. That is right where a mis-tap is unrecoverable — a
		// row radio, the confirmation, the submit — and wrong for a filter
		// chip and a disclosure, where a mis-tap changes what is on screen and
		// is undone by tapping again. Seven 46px slabs for two-letter words
		// made the filter heavier than the list it filters.
		const chip = /\.chip \{[^}]*\}/.exec(MARKUP)?.[0] ?? '';
		expect(chip).toContain('min-width: var(--touch-min)');
		expect(chip, 'the chips carry the bid control height again').not.toContain('min-height');

		const summary = /\.explainer > summary \{[^}]*\}/.exec(MARKUP)?.[0] ?? '';
		expect(summary, 'a 46px row around a 12px label').not.toContain('min-height');
	});
});

// --- The Commissioner exemption is a session fact (Story 9.8) ---------------

describe('actions.nominate — the Commissioner exemption', () => {
	const nominateAction = route.actions.nominate as unknown as (event: unknown) => unknown;

	function submit(
		fields: Array<[string, string]>,
		session: SessionState
	) {
		const form = new FormData();
		for (const [key, value] of fields) form.append(key, value);
		return {
			request: new Request('https://app.example/nominate', { method: 'POST', body: form }),
			locals: locals(session)
		};
	}

	const CONFIRMED_FIELDS: Array<[string, string]> = [
		['fantraxPlayerId', 'p-1'],
		['confirm', 'yes']
	];

	it('passes spendsSlot false for a Commissioner', async () => {
		await nominateAction(submit(CONFIRMED_FIELDS, { kind: 'registered', manager: COMMISSIONER }));
		expect(placeCalls[0]?.actor.spendsSlot).toBe(false);
	});

	it('passes spendsSlot true for an ordinary Manager', async () => {
		await nominateAction(submit(CONFIRMED_FIELDS, { kind: 'registered', manager: MANAGER }));
		expect(placeCalls[0]?.actor.spendsSlot).toBe(true);
	});

	it('ignores a form field claiming the exemption — it is never a posted value', async () => {
		await nominateAction(
			submit(
				[...CONFIRMED_FIELDS, ['spendsSlot', 'false'], ['isCommissioner', 'true']],
				{ kind: 'registered', manager: MANAGER }
			)
		);
		expect(placeCalls[0]?.actor.spendsSlot).toBe(true);
	});
});
