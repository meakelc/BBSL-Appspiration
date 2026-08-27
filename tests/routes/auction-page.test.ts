/**
 * The Auction page's surface and absence claims (Story 2.4).
 *
 * `vite.config.ts` runs tests under `environment: 'node'` and no `.svelte`
 * file can be rendered under this suite (`tests/signin-surface.test.ts`'s
 * own note states why), so these are source-text assertions in the
 * established pattern — the regex idiom `tests/structure.test.ts` already
 * uses. Absence claims — no bid input, no cancel/edit/lower control, no
 * "time remaining" — are provable this way and are the whole point.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const at = (...parts: string[]): string => join(ROOT, ...parts);

const ROUTE_DIR = ['src', 'routes', 'auction', '[fantraxPlayerId]'];

const PAGE = readFileSync(at(...ROUTE_DIR, '+page.svelte'), 'utf8');
const SERVER = readFileSync(at(...ROUTE_DIR, '+page.server.ts'), 'utf8');

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
