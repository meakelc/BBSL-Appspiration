/**
 * The verification page: the procedure a Manager runs, and its one gate
 * (Story 3.6, AD-14).
 *
 * `vite.config.ts` runs the suite under `environment: 'node'` and no `.svelte`
 * file can be rendered here, so the SURFACE assertions are source-text ones in
 * the established pattern (`tests/routes/auction-page.test.ts`'s own note
 * states why). Absence claims — no league data, no computation, no control —
 * are provable that way and are most of what this page promises.
 *
 * `+page.server.ts` is EXECUTED, because a source-text check can say the gate
 * call is present and cannot say it runs: `toContain` would stay green with
 * the check moved below a return.
 *
 * **The one thing NOT asserted here is the arithmetic**, and deliberately.
 * `tests/core/draw.test.ts` drives the same worked example through the real
 * `drawIndex`, so the printed procedure and the executed one are pinned to
 * each other there rather than restated here.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHttpError } from '@sveltejs/kit';

import {
	LIVE_DESTINATION_REFUSAL,
	LIVE_DESTINATION_REFUSAL_STATUS,
	resolveDestinations
} from '../../src/lib/server/destinations.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const at = (...parts: string[]): string => join(ROOT, ...parts);

const PAGE = readFileSync(at('src', 'routes', 'verify', '+page.svelte'), 'utf8');
/**
 * The page with every comment stripped — `tests/routes/auction-page.test.ts`'s
 * discipline for its reason: prose ABOUT a forbidden thing is not that thing,
 * and this page's script block explains at length which function it is NOT
 * calling.
 */
const PAGE_CODE = PAGE.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/^\s*\/\/.*$/gm, '');
const SERVER = readFileSync(at('src', 'routes', 'verify', '+page.server.ts'), 'utf8');

const route = await import('../../src/routes/verify/+page.server.ts');

const MANAGER: RegisteredManager = {
	id: 'm-2',
	discordUserId: '222',
	displayName: 'Alice',
	teamId: 't-2',
	teamName: 'Lakers',
	isCommissioner: false
};

const load = route.load as unknown as (event: { locals: unknown }) => unknown;

function expectRefusal(run: () => unknown, status: number): void {
	let thrown: unknown;
	try {
		run();
	} catch (caught) {
		thrown = caught;
	}
	expect(thrown, 'the call did not throw').toBeDefined();
	expect(isHttpError(thrown)).toBe(true);
	if (isHttpError(thrown)) expect(thrown.status).toBe(status);
}

describe('the verification page — the gate, executed', () => {
	it('serves a registered Manager', () => {
		expect(() =>
			load({ locals: { session: { kind: 'registered', manager: MANAGER } as SessionState } })
		).not.toThrow();
	});

	it.each([
		['signed out', { kind: 'signed-out' }],
		['expired', { kind: 'expired', returnTo: '/' }],
		['unregistered', { kind: 'unregistered' }]
	])('refuses a %s session with the app’s one refusal', (_label: string, session: unknown) => {
		expectRefusal(
			() => load({ locals: { session } }),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
	});

	it('reuses the app’s refusal constants rather than wording its own', () => {
		expect(SERVER).toContain('LIVE_DESTINATION_REFUSAL_STATUS');
		expect(SERVER).toContain('LIVE_DESTINATION_REFUSAL');
		expect(LIVE_DESTINATION_REFUSAL_STATUS).toBe(403);
		expect(SERVER).not.toContain('403');
		expect(SERVER).not.toContain(LIVE_DESTINATION_REFUSAL);
	});

	it('adds NO entry to the destinations catalog', () => {
		// The catalog is phase/role navigation. This page is reached from the
		// lottery block on an Auction page, by a Manager looking at a
		// commitment — putting "Verify" in every phase's nav would advertise
		// it where the question is not being asked.
		for (const phase of ['Setup', 'Auction', 'Contract Assignment', 'Archived'] as const) {
			const live = resolveDestinations(phase, {
				kind: 'registered',
				manager: { ...MANAGER, isCommissioner: true }
			});
			expect(live.some((entry) => entry.id.includes('verify')), phase).toBe(false);
			expect(live.some((entry) => entry.href === '/verify'), phase).toBe(false);
		}
	});

	it('loads nothing — no gateway, no fold, no table', () => {
		expect(SERVER).not.toContain('writeGateway');
		expect(SERVER).not.toContain('loadEventsViaClient');
		expect(SERVER).not.toMatch(/auction_events|auction_contention_seeds|team_rosters/);
	});
});

describe('the verification page — what it states', () => {
	it('states the procedure: the reduction, the counting base and the order', () => {
		expect(PAGE).toContain('r = (r × 16 + value of d) mod n');
		expect(PAGE).toMatch(/left to right/);
		// Counting is 0-based, and the list order is part of the answer.
		expect(PAGE).toMatch(/counting from 0|Counting starts at zero/);
		expect(PAGE).toMatch(/the order the Teams joined/);
	});

	it('prints the worked example the draw suite pins the code against', () => {
		// `tests/core/draw.test.ts` runs this seed through the real derivation
		// and asserts position 2. If the page and the code ever disagree, the
		// PAGE is the defect — it is the half a Manager can actually run.
		expect(PAGE).toContain(
			'4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e'
		);
		expect(PAGE).toMatch(/n = 4/);
		expect(PAGE).toMatch(/Team G<\/strong>|<strong>Team G/);
	});

	it('gives the spreadsheet formula and the sha256sum command', () => {
		expect(PAGE).toContain('MOD(B1*16 + HEX2DEC(MID($seed, ROW()-1, 1)), $n)');
		expect(PAGE).toContain('sha256sum');
		expect(PAGE).toMatch(/printf %s/);
	});

	it('says the winner is derived from the SEED and never from the hash', () => {
		// AD-14's stated prevention: a winner derived from the published
		// commitment could be predicted before joining.
		expect(PAGE).toMatch(/never derived from the published hash/i);
	});

	it('says what an unverifiable commitment means, rather than leaving it out', () => {
		expect(PAGE).toMatch(/no commitment was published/i);
	});

	it('carries no league data and no Auction of its own', () => {
		// A procedure that changed with the case would be a procedure nobody
		// could check twice. The worked example is invented Teams.
		expect(PAGE_CODE).not.toMatch(/\$lib\/server/);
		expect(PAGE_CODE).not.toMatch(/data\.|PageData|\$props\(\)/);
		expect(PAGE_CODE).not.toMatch(/fantraxPlayerId/);
	});

	it('computes nothing — it states arithmetic, it does not perform it', () => {
		expect(PAGE_CODE).not.toMatch(/\bhash\(/);
		expect(PAGE_CODE).not.toMatch(/drawIndex|drawnWinnerFor/);
		expect(PAGE_CODE).not.toMatch(/crypto|subtle/i);
		// No import of any kind: it states arithmetic and calls nothing.
		expect(PAGE_CODE).not.toMatch(/\bimport\b/);
	});

	it('offers no control at all', () => {
		expect(PAGE).not.toMatch(/<button\b/);
		expect(PAGE).not.toMatch(/<form\b/);
		expect(PAGE).not.toMatch(/<input\b/);
	});

	it('introduces no design token and no CSS sizing literal', () => {
		// Every declaration in the one class it adds is a token or a
		// non-sizing property; a raw px value here is an Ask First item.
		const style = PAGE.slice(PAGE.indexOf('<style>'));
		for (const declaration of style.matchAll(
			/^\s*(?:width|height|min-height|max-width|gap|padding|margin|font-size):\s*([^;]+);/gm
		)) {
			expect(declaration[1]?.trim(), declaration[0]).toMatch(/^var\(--[a-z0-9-]+\)$/);
		}
		expect(style).not.toMatch(/#[0-9a-f]{3,8}\b/i);
	});

	it('is excluded from indexing at the document level as well as at the edge', () => {
		expect(PAGE).toMatch(/name="robots"[^>]*noindex/);
	});
});
