import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
	NAV_DESTINATION_LIMIT,
	navDestinations
} from '../src/lib/destinations-view.ts';
import type { Destination } from '../src/lib/destinations-view.ts';
import { SIGN_IN_DESTINATION, resolveDestinations } from '../src/lib/server/destinations.ts';
import type { SessionState } from '../src/lib/server/auth.ts';

/**
 * The mobile destination bar: the selection it carries, and the source of the
 * surface that renders it.
 *
 * The selection half is the one that matters, and it is a plain function
 * precisely so it can be called here rather than inferred from markup. The
 * source half asserts the properties a rendered-markup test cannot see —
 * which edge the bar is pinned to, that it words nothing of its own, and that
 * it never resolves a destination the server did not already grant.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAV = readFileSync(join(ROOT, 'src/lib/components/MobileNav.svelte'), 'utf8');
const LAYOUT = readFileSync(join(ROOT, 'src/routes/+layout.svelte'), 'utf8');

/** The component source with comments stripped, for assertions that must not
 *  be satisfied by prose explaining the very thing being asserted. */
const NAV_CODE = NAV.replace(/\/\*[\s\S]*?\*\//g, ' ')
	.replace(/<!--[\s\S]*?-->/g, ' ')
	.replace(/(^|[^:/])\/\/[^\n]*/g, '$1');

function destination(id: string, commissionerOnly: boolean, listed = true): Destination {
	return { id, label: id, href: `/${id}`, commissionerOnly, listed };
}

const MANAGER: SessionState = {
	kind: 'registered',
	manager: { isCommissioner: false }
} as unknown as SessionState;

const COMMISSIONER: SessionState = {
	kind: 'registered',
	manager: { isCommissioner: true }
} as unknown as SessionState;

// --- The selection ----------------------------------------------------------

describe('navDestinations selects from the one list and never widens it', () => {
	it('carries a Manager entry', () => {
		const board = destination('bid-board', false);
		expect(navDestinations([board])).toContain(board);
	});

	it('never carries a Commissioner-only entry', () => {
		// Administrative acts are not thumb-bar navigation, and the Auction
		// phase alone holds six of them — there is no cap under which they and
		// a Manager's own five coexist. Every one stays in the sheet.
		const admin = destination('import', true);
		expect(navDestinations([admin])).toEqual([]);
	});

	it('never carries Sign-in', () => {
		// A one-button bar reading "Sign-in" beneath the Sign-in page is not
		// navigation. `classifyDestinations` holds it apart; this inherits that.
		expect(navDestinations([SIGN_IN_DESTINATION])).toEqual([]);
	});

	it('never carries an unlisted permission', () => {
		// `auction` and `notification-settings` are permissions with no page to
		// link to. A bar offering `/auction` would offer a 404 on every screen.
		const permission = destination('auction', false, false);
		expect(navDestinations([permission])).toEqual([]);
	});

	it('caps at five, keeping catalog order', () => {
		const many = [
			destination('a', false),
			destination('b', false),
			destination('c', false),
			destination('d', false),
			destination('e', false),
			destination('f', false)
		];
		const selected = navDestinations(many);
		expect(selected).toHaveLength(NAV_DESTINATION_LIMIT);
		expect(selected.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
	});

	it('offers nothing the resolved list did not already offer, in any phase or role', () => {
		// The property that makes this a SELECTION rather than a second
		// destination table (AD-30, AR-29/UX-DR19): every entry the bar shows
		// must be an entry `resolveDestinations` returned for that same viewer.
		for (const phase of ['Setup', 'Auction', 'Contract Assignment', 'Archived'] as const) {
			for (const session of [MANAGER, COMMISSIONER]) {
				const resolved = resolveDestinations(phase, session);
				for (const entry of navDestinations(resolved)) {
					expect(resolved).toContain(entry);
				}
			}
		}
	});

	it('gives the Auction phase exactly five, which is what the bar was sized for', () => {
		// Your Positions, Bid Board, Nominate, Teams, Audit Log — the phase the
		// product spends most of its life in, and nothing cut from it.
		const selected = navDestinations(resolveDestinations('Auction', MANAGER));
		expect(selected.map((entry) => entry.id)).toEqual([
			'your-positions',
			'bid-board',
			'nominate',
			'teams',
			'audit-log'
		]);
	});

	it('gives a Commissioner the same five, not five of their own', () => {
		// A Commissioner's resolved list is longer, and a cap applied before the
		// Commissioner filter would hand them a bar of Import and roster acts
		// with the Bid Board pushed off the end.
		const manager = navDestinations(resolveDestinations('Auction', MANAGER));
		const commissioner = navDestinations(resolveDestinations('Auction', COMMISSIONER));
		expect(commissioner.map((entry) => entry.id)).toEqual(manager.map((entry) => entry.id));
	});

	it('gives a Manager in Setup nothing, so the bar does not render at all', () => {
		// All four Setup entries are Commissioner-only. An empty bar would be
		// 60px of dead page, which is why the component gates on the count.
		expect(navDestinations(resolveDestinations('Setup', MANAGER))).toEqual([]);
	});
});

// --- The surface ------------------------------------------------------------

describe('MobileNav.svelte — the surface, asserted against its source', () => {
	it('pins to the bottom edge and is sized from --nav-height', () => {
		const nav = /\.mobile-nav\s*\{[^}]*\}/.exec(NAV)?.[0] ?? '';
		expect(nav).toContain('position: fixed');
		expect(nav).toContain('bottom: 0');
		expect(nav).toContain('min-height: var(--nav-height)');
		// The 60px literal lives in `tokens.css` and nowhere else, so the room
		// `global.css` reserves and the bar occupying it cannot drift apart.
		// Read from the stripped source: the prose above explains the height in
		// px, and matching a comment is how this would stop meaning anything.
		expect(NAV_CODE).not.toContain('60px');
	});

	it('keeps its 1px border inside the height the layout reserves for it', () => {
		// The strip's own hard-won lesson: a border added on top of the
		// reserved height covers the last row of the page by exactly that much.
		const nav = /\.mobile-nav\s*\{[^}]*\}/.exec(NAV)?.[0] ?? '';
		expect(nav).toContain('box-sizing: border-box');
		expect(nav).toContain('border-top: var(--border-width)');
	});

	it('does not render above the one breakpoint the repo uses', () => {
		expect(NAV).toContain('@media (min-width: 640px)');
		expect(NAV).toMatch(/@media \(min-width: 640px\)[\s\S]*display: none/);
	});

	it('renders nothing when the selection is empty', () => {
		// `global.css` reserves room by `body:has(.mobile-nav)`, so an empty
		// bar is also 60px of dead page.
		expect(NAV_CODE).toContain('entries.length > 0');
	});

	it('words nothing — every button is labelled by the catalog', () => {
		// A bar reading "Positions" beside a sheet reading "Your Positions"
		// would be two names for one page.
		expect(NAV_CODE).toContain('{destination.label}');
		for (const invented of ['Positions<', 'Board<', 'Log<', 'Bids<']) {
			expect(NAV_CODE).not.toContain(invented);
		}
	});

	it('never identifies a destination by picture or colour alone', () => {
		// Every icon is decoration behind a visible label, and the current page
		// is stated in the accessibility tree rather than only in `brand`.
		expect(NAV_CODE).toContain('aria-hidden="true"');
		expect(NAV_CODE).toContain('nav-label');
		expect(NAV_CODE).toContain("aria-current={current ? 'page' : undefined}");
		expect(NAV).toContain("[aria-current='page']");
	});

	it('names itself, and not with the sheet name', () => {
		// Two navigations on one page. Sharing a name tells a screen-reader
		// user there is one thing in two places.
		expect(NAV_CODE).toContain('aria-label={NAV_LABEL}');
		expect(NAV_CODE).toContain("const NAV_LABEL = 'Pages'");
		expect(NAV_CODE, 'the bar and the sheet share a name').not.toContain(
			"NAV_LABEL = 'Destinations'"
		);
	});

	it('clears the touch floor without relying on the bar being full height', () => {
		const button = /\.nav-button\s*\{[^}]*\}/.exec(NAV)?.[0] ?? '';
		expect(button).toContain('min-height: var(--touch-min)');
	});

	it('bounds its labels at two lines, so the bar cannot grow past its room', () => {
		const label = /\.nav-label\s*\{[^}]*\}/.exec(NAV)?.[0] ?? '';
		expect(label).toContain('line-clamp: 2');
		expect(label).toContain('font-size: var(--size-10)');
	});

	it('resolves nothing itself — it is handed the server-resolved list', () => {
		// Nothing server-only may be reachable from a `.svelte` file, and a
		// second resolution here would be exactly the divergence AD-30 forbids.
		expect(NAV_CODE).toContain("from '../destinations-view.ts'");
		expect(NAV_CODE).not.toContain('server/destinations');
		expect(NAV_CODE).not.toContain('commissionerOnly)');
	});
});

// --- The mount --------------------------------------------------------------

describe('the nav bar is mounted once, by the layout', () => {
	it('mounts exactly once, so it reaches every surface rather than one', () => {
		expect(LAYOUT.match(/<MobileNav/g)).toHaveLength(1);
	});

	it('mounts AFTER the page content, so it is not read before it', () => {
		// It is `fixed` below 640px and `display: none` above, so DOM order
		// never places it visually. What it does decide is reading order: five
		// destinations announced before the page would sit between a Manager
		// and the content on every surface.
		const children = LAYOUT.indexOf('{@render children()}');
		const nav = LAYOUT.indexOf('<MobileNav');
		expect(children).toBeGreaterThan(-1);
		expect(nav).toBeGreaterThan(children);
	});

	it('is handed the same resolved list the sheet is handed', () => {
		expect(LAYOUT).toContain('<MobileNav destinations={data.destinations} />');
	});

	it('is gated on the session, not on the strip', () => {
		// A Manager bound to no Team gets no strip — no figures to state — but
		// still has destinations and still deserves them in one tap.
		const nav = LAYOUT.indexOf('<MobileNav');
		const gate = LAYOUT.lastIndexOf('{#if data.signedIn}', nav);
		expect(gate).toBeGreaterThan(LAYOUT.indexOf('{@render children()}'));
	});
});
