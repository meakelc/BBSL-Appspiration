/**
 * The Auction page's surface and absence claims, and its `load` executed
 * (Story 2.4).
 *
 * `vite.config.ts` runs tests under `environment: 'node'` and no `.svelte`
 * file can be rendered under this suite (`tests/signin-surface.test.ts`'s
 * own note states why), so the SURFACE assertions are source-text ones in
 * the established pattern — the regex idiom `tests/structure.test.ts` already
 * uses. Absence claims — no bid input, no cancel/edit/lower control, no
 * "time remaining" — are provable this way and are the whole point.
 *
 * `+page.server.ts` is a different matter and is EXECUTED, the way
 * `tests/routes/nominate.test.ts` executes its own. A source-text check can
 * say the gate call is present; it cannot say it runs first, because
 * `toContain` is not position-aware and would stay green if the read were
 * hoisted above the gate. Only the real `requireLiveDestination` (nothing
 * about it is mocked) driving the real `load` proves the ordering, the 403s
 * and the 404.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isHttpError } from '@sveltejs/kit';

import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const at = (...parts: string[]): string => join(ROOT, ...parts);

const ROUTE_DIR = ['src', 'routes', 'auction', '[fantraxPlayerId]'];

const PAGE = readFileSync(at(...ROUTE_DIR, '+page.svelte'), 'utf8');
const SERVER = readFileSync(at(...ROUTE_DIR, '+page.server.ts'), 'utf8');

const stub = vi.hoisted(() => ({
	auction: null as unknown,
	/** Every `loadAuctionPage` call, so "was it reached at all?" is answerable. */
	calls: [] as string[]
}));

vi.mock('$lib/server/auction-page.ts', () => ({
	loadAuctionPage: async (_gateway: unknown, fantraxPlayerId: string) => {
		stub.calls.push(fantraxPlayerId);
		return stub.auction;
	}
}));

vi.mock('$lib/shell/db.ts', () => ({
	writeGateway: () => ({
		connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} })
	})
}));

const route = await import('../../src/routes/auction/[fantraxPlayerId]/+page.server.ts');

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

const OPEN_AUCTION = {
	fantraxPlayerId: 'p-1',
	playerName: 'Jalen Green',
	metadata: { positions: 'SG', nbaTeam: 'HOU' },
	nominatingTeam: 'Lakers — Meakel',
	nominatedAt: '2026-08-25T19:00:00.000Z'
};

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
	stub.auction = OPEN_AUCTION;
	stub.calls.length = 0;
});

describe('the Auction page — what it renders', () => {
	it('renders Player identity from data, not a hardcoded literal', () => {
		expect(PAGE).toContain('auction.playerName');
	});

	it('renders the metadata line only when present, never blanked', () => {
		expect(PAGE).toContain('auction.metadata !== null');
		expect(PAGE).toContain('auction.metadata.nbaTeam');
		expect(PAGE).toContain('auction.metadata.positions');
	});

	it('renders the nominating Team through the one naming-convention renderer', () => {
		expect(PAGE).toContain('auction.nominatingTeam');
		// Never a raw abbreviation standing in for the fantasy Team.
		expect(PAGE).not.toMatch(/nominatingTeam.*\b[A-Z]{3}\b/);
	});

	it('states the phase from the server-resolved source', () => {
		expect(PAGE).toContain('data.phase.sentence');
		expect(SERVER).toContain('locals.phase');
	});

	it('renders an explicit "no bids" sentence rather than an empty price or history', () => {
		expect(PAGE).toMatch(/No bids yet/);
		expect(PAGE).toMatch(/No bids have been placed yet/);
	});

	it('renders the nomination time twice — a relative phrase and an absolute stamp', () => {
		expect(PAGE).toContain('relativePhrase');
		expect(PAGE).toContain('Intl.DateTimeFormat');
		expect(PAGE).toContain('id="auction-nominated-relative"');
		expect(PAGE).toContain('id="auction-nominated-absolute"');
	});

	it('computes the relative phrase through the pure, injected-now helper', () => {
		expect(PAGE).toContain("from '$lib/core/instant.ts'");
		expect(PAGE).toMatch(/relativePhrase\(auction\.nominatedAt,\s*nowIso\)/);
	});
});

describe('the Auction page — what it never renders (Never list, AC2)', () => {
	it('has no bid input, no submit control, and no form at all', () => {
		expect(PAGE).not.toMatch(/<input\b/);
		expect(PAGE).not.toMatch(/<form\b/);
		expect(PAGE).not.toMatch(/<button\b/);
	});

	it('never mentions a minimum-legal-Bid or maximumBid figure', () => {
		expect(PAGE).not.toMatch(/maximumBid/i);
		expect(PAGE).not.toMatch(/minimum legal/i);
		expect(PAGE).not.toMatch(/minimum-legal/i);
	});

	it('offers no control to cancel, edit or lower a Bid — absent, not disabled', () => {
		expect(PAGE).not.toMatch(/cancel/i);
		expect(PAGE).not.toMatch(/\bedit\b/i);
		expect(PAGE).not.toMatch(/\blower\b/i);
	});

	it('states no disabled-reason wording, because there is no control to disable', () => {
		expect(PAGE).not.toMatch(/disabled/i);
		expect(PAGE).not.toMatch(/aria-describedby/i);
	});

	it('shows no close timestamp, no auction clock, no time remaining — no close exists', () => {
		expect(PAGE).not.toMatch(/time remaining/i);
		expect(PAGE).not.toMatch(/countdown/i);
		expect(PAGE).not.toMatch(/closes? at/i);
		expect(PAGE).not.toMatch(/auction clock/i);
	});

	it('renders no salary figure and no contract-length field — those columns do not exist for a Free Agent', () => {
		expect(PAGE).not.toMatch(/\$\d/);
		expect(PAGE).not.toMatch(/contract.?length/i);
		expect(PAGE).not.toMatch(/capHit/i);
		expect(PAGE).not.toMatch(/formatMoney/);
	});

	it('shows no suggested amount, no recommended bid, no anonymity-breaking figure', () => {
		expect(PAGE).not.toMatch(/suggested/i);
		expect(PAGE).not.toMatch(/recommended/i);
	});

	it('manual check (Verification section): no maximumBid|minimum legal|cancel|lower anywhere in the route', () => {
		const combined = `${PAGE}\n${SERVER}`;
		expect(combined).not.toMatch(/maximumBid|minimum legal|cancel|lower/i);
	});
});

describe('the Auction page server load — gate, load, 404', () => {
	it('gates on the auction destination before anything else', () => {
		expect(SERVER).toContain("requireLiveDestination(locals.session, locals.phase.name, AUCTION_DESTINATION_ID)");
		expect(SERVER).toContain("AUCTION_DESTINATION_ID = 'auction'");
		// Presence is not order. `toContain` would stay green with the read
		// hoisted above the gate, so the ordering is stated here as well and
		// executed in the suite below.
		expect(SERVER.indexOf('requireLiveDestination(')).toBeLessThan(
			SERVER.indexOf('loadAuctionPage(writeGateway()')
		);
	});

	it('404s on a null read rather than rendering an empty Auction', () => {
		expect(SERVER).toMatch(/if \(auction === null\)/);
		expect(SERVER).toMatch(/error\(404,/);
	});

	it('exports load only — no actions, no write path', () => {
		expect(SERVER).not.toMatch(/export const actions/);
		expect(SERVER).toContain('export const load');
	});

	it('reaches the reader through writeGateway(), like every other route', () => {
		expect(SERVER).toContain('writeGateway()');
	});

	it('never imports a server-only module into the .svelte file', () => {
		expect(PAGE).not.toMatch(/\$lib\/server/);
		expect(PAGE).not.toMatch(/\$env\/(static|dynamic)\/private/);
	});

	it('never reads open_nominations directly', () => {
		expect(SERVER).not.toMatch(/open_nominations/);
		expect(PAGE).not.toMatch(/open_nominations/);
	});
});

// --- `load`, executed --------------------------------------------------
//
// The real `requireLiveDestination` runs here; only the I/O-touching layer
// is faked. `stub.calls` is what makes "the gate ran BEFORE the read"
// falsifiable: a refused request must leave it empty.

describe('load — gated on the destination before the database is touched', () => {
	it('serves a Manager in the Auction Phase, returning the phase and the auction', async () => {
		const result = (await route.load({
			locals: locals({ kind: 'registered', manager: MANAGER }),
			params: { fantraxPlayerId: 'p-1' }
		} as never)) as { phase: ResolvedPhase; auction: unknown };

		expect(result.auction).toEqual(OPEN_AUCTION);
		expect(result.phase).toEqual(AUCTION_PHASE);
		expect(stub.calls).toEqual(['p-1']);
	});

	it('refuses a Manager outside the Auction Phase with 403 — and never reads', async () => {
		await expectRefusal(
			() =>
				route.load({
					locals: locals({ kind: 'registered', manager: MANAGER }, SETUP_PHASE),
					params: { fantraxPlayerId: 'p-1' }
				} as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		// The whole point of the ordering: a wrong-phase request must not
		// reach the log fold or the reference tables at all.
		expect(stub.calls).toEqual([]);
	});

	it('refuses a signed-out session with 403 — and never reads', async () => {
		await expectRefusal(
			() =>
				route.load({
					locals: locals({ kind: 'signed-out' }),
					params: { fantraxPlayerId: 'p-1' }
				} as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(stub.calls).toEqual([]);
	});

	it('404s on a null read rather than rendering an empty Auction — AC4', async () => {
		stub.auction = null;
		await expectRefusal(
			() =>
				route.load({
					locals: locals({ kind: 'registered', manager: MANAGER }),
					params: { fantraxPlayerId: 'p-gone' }
				} as never),
			404
		);
		// It got past the gate and did the read — this is a 404, not a 403.
		expect(stub.calls).toEqual(['p-gone']);
	});

	it('passes the id straight from the route param, never from the session', async () => {
		await route.load({
			locals: locals({ kind: 'registered', manager: MANAGER }),
			params: { fantraxPlayerId: 'p-77' }
		} as never);
		expect(stub.calls).toEqual(['p-77']);
	});
});

// --- AC5: single column, touch targets, tokens, greyscale ----------------
//
// AC5 was previously listed against this file with nothing asserting it.
// Every clause is checked here against the page source, which is where each
// one is decidable: the page has no interactive targets at all, so the
// ≥44x44px clause is satisfied by absence rather than by measurement, and
// that absence is exactly what must not silently change.

describe('the Auction page — AC5, layout and token discipline', () => {
	it('has no interactive target at all, so the >=44x44px floor is met by absence', () => {
		expect(PAGE).not.toMatch(/<(button|input|select|textarea|a)\b/i);
		expect(PAGE).not.toMatch(/\bon(click|change|submit|input)\b/i);
	});

	it('is single-column — no grid, no multi-column row, no horizontal track', () => {
		expect(PAGE).not.toMatch(/display:\s*grid/);
		expect(PAGE).not.toMatch(/grid-template-columns/);
		expect(PAGE).not.toMatch(/flex-direction:\s*row/);
		// The one flex container it does declare stacks.
		expect(PAGE).toMatch(/flex-direction:\s*column/);
	});

	it('styles only through existing design tokens — no raw colour or size literal', () => {
		const style = PAGE.slice(PAGE.indexOf('<style>'));
		expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(style).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
		// Every declared value is a token reference.
		for (const declaration of style.matchAll(/^\s*(?:color|font-size|gap|background-color|border):\s*([^;]+);/gm)) {
			expect(declaration[1]?.trim()).toMatch(/^var\(--[a-z0-9-]+\)$/);
		}
	});

	it('conveys no state by colour alone — every fact on the page is a sentence', () => {
		// No conditional class or colour keyed on state anywhere: the price,
		// the history and the metadata are all plain prose.
		expect(PAGE).not.toMatch(/class=["'][^"']*\{/);
		expect(PAGE).toMatch(/No bids yet\./);
		expect(PAGE).toMatch(/No bids have been placed yet\./);
	});
});

// --- The absolute stamp is the VIEWER's timezone -------------------------

describe('the Auction page — the absolute stamp resolves client-side', () => {
	it('never formats the absolute stamp during SSR, which would use the server timezone', () => {
		// Derived in an effect, which runs only in the browser — not in a
		// `$derived`, which would also run during server rendering and ship
		// the server's timezone in the delivered HTML.
		expect(PAGE).toMatch(/\$effect\(\(\)\s*=>\s*\{\s*absolute\s*=\s*formatAbsolute\(/);
		expect(PAGE).not.toMatch(/\$derived\([^)]*Intl\.DateTimeFormat/);
	});

	it('guards an unparseable instant rather than throwing RangeError out of format()', () => {
		expect(PAGE).toContain('Number.isNaN(parsed.getTime())');
		// The same stated phrase the pure helper returns for the same input.
		expect(PAGE).toContain("return 'at an unknown time'");
	});

	it('still renders the absolute stamp — it is omitted before hydration, never dropped for space', () => {
		expect(PAGE).toContain('id="auction-nominated-absolute"');
		expect(PAGE).toMatch(/\{#if absolute !== null\}/);
	});
});
