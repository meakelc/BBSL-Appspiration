import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The layout load reaches the database since Story 4.2 — the persistent
// strip's FACTS ride on the ONE load every page inherits. Only the
// I/O-touching layer is faked, exactly as `tests/routes/nominate.test.ts`
// fakes it: the real `resolveDestinations`, the real phase pass-through and
// the real server-side gating all still run. The fake answers an empty log,
// which folds to a Team with no leads and no roster rows — a real state.
vi.mock('$lib/shell/db.ts', () => ({
	writeGateway: () => ({
		connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} })
	})
}));

const { load } = await import('../src/routes/+layout.server.ts');
import { SIGN_IN_DESTINATION } from '../src/lib/server/destinations.ts';
import type { Destination } from '../src/lib/server/destinations.ts';
import { PHASE_ANNOUNCEMENTS, phaseOf } from '../src/lib/server/phase.ts';
import type { ResolvedPhase } from '../src/lib/server/phase.ts';
import type { RegisteredManager, SessionState } from '../src/lib/server/auth.ts';
import { parseInstant } from '../src/lib/core/instant.ts';

/**
 * `load`'s declared `LayoutServerLoad` type widens its return to
 * `void | (Partial<PageData> & ...)` — SvelteKit's generic shape before
 * `./$types` narrows it for `+layout.svelte`'s actual consumption. The
 * function's real body never returns void; this recovers that shape for the
 * assertions below rather than fighting the generic type at every call site.
 */
type LoadResult = {
	phase: ResolvedPhase;
	destinations: readonly Destination[];
	watermark: string;
	serverInstant: string;
	stripTeam: unknown;
};

/** `load` is async since Story 4.2; every call awaits it. */
async function loadLayout(event: unknown): Promise<LoadResult> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (await load(event as any)) as unknown as LoadResult;
}

/**
 * `+layout.server.ts`'s `load`, asserting it returns `{ phase, destinations }`
 * built from `locals.phase`/`locals.session` — the one point every page's
 * `HeaderMenu` gets its list from.
 */

const SETUP_PHASE: ResolvedPhase = { name: 'Setup', sentence: 'Setup. ...' , announcement: null };
const AUCTION_PHASE: ResolvedPhase = { name: 'Auction', sentence: 'Auction. ...' , announcement: null };

const COMMISSIONER: RegisteredManager = {
	id: '00000000-0000-4000-8000-000000000002',
	discordUserId: '222222222222222220',
	displayName: 'Commissioner Bob',
	teamId: '00000000-0000-4000-8000-0000000000bb',
	teamName: 'Celtics',
	isCommissioner: true
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function layoutEvent(phase: ResolvedPhase, session: SessionState, watermark = '0'): any {
	// `watermark` rides on `locals` alongside the phase since Story 4.1 —
	// `hooks.server.ts` folds both from one read of the log.
	return { locals: { phase, session, watermark } };
}

describe('+layout.server.ts load', () => {
	it('returns the phase straight from locals.phase, unmodified', async () => {
		const result = await loadLayout(layoutEvent(AUCTION_PHASE, { kind: 'signed-out' }));
		expect(result.phase).toBe(AUCTION_PHASE);
	});

	it('carries the watermark straight from locals, unmodified — AD-29', async () => {
		// One watermark, from one read of the log, on the ONE load every page
		// inherits — so a surface built later is born carrying the contract
		// rather than retrofitting age labelling onto itself.
		const result = await loadLayout(layoutEvent(AUCTION_PHASE, { kind: 'signed-out' }, '4217'));
		expect(result.watermark).toBe('4217');
	});

	it('carries a server instant the core can parse — the seed a page is born with', async () => {
		// This is what `lastLivenessOkAt` is seeded from, which is why a freshly
		// loaded page is never born Stale: the load coming back IS proof the
		// server was reachable, written down.
		const result = await loadLayout(layoutEvent(AUCTION_PHASE, { kind: 'signed-out' }));
		expect(parseInstant(result.serverInstant)).not.toBeNull();
	});

	it('resolves destinations from locals.phase.name and locals.session, via resolveDestinations', async () => {
		const result = await loadLayout(layoutEvent(SETUP_PHASE, { kind: 'signed-out' }));
		expect(result.destinations).toEqual([SIGN_IN_DESTINATION]);
	});

	it('a registered Commissioner in Setup gets the Commissioner-only Setup catalog', async () => {
		const result = await loadLayout(
			layoutEvent(SETUP_PHASE, { kind: 'registered', manager: COMMISSIONER })
		);
		expect(result.destinations.map((d) => d.id)).toEqual([
			'import',
			'minor-league-eligibility',
			'manager-registration',
			'auction-open-gate'
		]);
	});

	it('changing only locals.phase changes the returned destinations, with the same session', async () => {
		const session: SessionState = { kind: 'registered', manager: COMMISSIONER };
		const setupResult = await loadLayout(layoutEvent(SETUP_PHASE, session));
		const auctionResult = await loadLayout(layoutEvent(AUCTION_PHASE, session));
		expect(setupResult.destinations).not.toEqual(auctionResult.destinations);
	});
});

// --- the persistent strip's gate (Story 4.2) -------------------------------

/**
 * A Manager bound to a Team — the only viewer the strip states figures about.
 */
const MANAGER: RegisteredManager = {
	id: '00000000-0000-4000-8000-000000000003',
	discordUserId: '333333333333333330',
	displayName: 'Alice',
	teamId: '00000000-0000-4000-8000-0000000000aa',
	teamName: 'Lakers',
	isCommissioner: false
};

/** A Commissioner bound to NO Team — a real, supported state. */
const UNBOUND: RegisteredManager = { ...COMMISSIONER, teamId: null, teamName: null };

describe('stripTeam — the gate, executed rather than read', () => {
	it('is null for a signed-out visitor, and costs no server read', async () => {
		const result = await loadLayout(layoutEvent(AUCTION_PHASE, { kind: 'signed-out' }));
		expect(result.stripTeam).toBeNull();
	});

	it('is null for a Manager bound to no Team — no figure and no Slots', async () => {
		const result = await loadLayout(
			layoutEvent(AUCTION_PHASE, { kind: 'registered', manager: UNBOUND })
		);
		expect(result.stripTeam).toBeNull();
	});

	it('is null in Setup, where no roster has been promoted', async () => {
		const result = await loadLayout(
			layoutEvent(SETUP_PHASE, { kind: 'registered', manager: MANAGER })
		);
		expect(result.stripTeam).toBeNull();
	});

	it('resolves FACTS for a bound Manager in the Auction Phase', async () => {
		const result = await loadLayout(
			layoutEvent(AUCTION_PHASE, { kind: 'registered', manager: MANAGER })
		);
		expect(result.stripTeam).not.toBeNull();
		// Facts only (AD-7): the money the core derives from, never a derived
		// figure. A `maximumBid` on this object would BE the check.
		expect(result.stripTeam).toHaveProperty('capSpace');
		expect(result.stripTeam).toHaveProperty('rosterCount');
		expect(result.stripTeam).toHaveProperty('leading');
		expect(result.stripTeam).not.toHaveProperty('maximumBid');
		expect(result.stripTeam).not.toHaveProperty('committedBids');
		expect(result.stripTeam).not.toHaveProperty('rosterReserve');
	});

});

// --- the phase-end announcement (Story 3.7, AC6) ---------------------------

/**
 * `+layout.svelte`'s source, for the surface assertions below.
 *
 * `vite.config.ts` pins `environment: 'node'` and no component harness exists
 * anywhere in `tests/` — `tests/signin-surface.test.ts` and
 * `tests/structure.test.ts` are the repo-wide precedent, and
 * `deferred-work.md` already carries the entry that calls for a harness. The
 * DECISIONS this file makes are asserted directly against
 * `PHASE_ANNOUNCEMENTS` above; only the markup is read as text.
 */
const LAYOUT_SOURCE = readFileSync(
	fileURLToPath(new URL('../src/routes/+layout.svelte', import.meta.url)),
	'utf8'
);

/**
 * The same file with its `<script>` comments stripped.
 *
 * `tests/structure.test.ts` and `tests/core/auction-open.test.ts` both do this
 * for the same reason: prose ABOUT a construct is not that construct. This
 * layout's own comment explains at length why `role="status"` would be wrong
 * here, and a text search for it would otherwise find the explanation.
 */
const LAYOUT_MARKUP = LAYOUT_SOURCE.replace(/^\s*\/\/.*$/gm, '');

describe('PHASE_ANNOUNCEMENTS — the transition is worded in one place', () => {
	it('states in words that the Auction Phase ended and Contract Assignment began', () => {
		const announcement = PHASE_ANNOUNCEMENTS['Contract Assignment'];

		expect(announcement).not.toBeNull();
		expect(announcement?.heading).toBe('The Auction Phase has ended');
		expect(announcement?.body).toContain('Contract Assignment has begun');
		// The two consequences a Manager most needs told, both stated:
		// bidding is over league-wide, and an unbid Player came back.
		expect(announcement?.body).toContain('No further Bids or nominations are accepted');
		expect(announcement?.body).toContain('returned to the Free Agent pool');
		expect(announcement?.body).toContain('Nomination Slot');
		// And the reassurance that nothing already won was undone.
		expect(announcement?.body).toContain('Every Auction that was won still stands');
	});

	it('carries none for the three phases nobody arrives into unannounced', () => {
		// Setup is where a league begins; Auction opens by a Commissioner's own
		// deliberate act on a page they are already looking at; Archived is
		// Epic 7's to word when it exists. Contract Assignment is the one phase
		// the tick moves a league into while nobody is watching.
		expect(PHASE_ANNOUNCEMENTS.Setup).toBeNull();
		expect(PHASE_ANNOUNCEMENTS.Auction).toBeNull();
		expect(PHASE_ANNOUNCEMENTS.Archived).toBeNull();
	});

	it('rides on `phaseOf`, so every surface reads it from the same fold', async () => {
		// `hooks.server.ts` resolves the phase once per request into
		// `locals.phase` and `+layout.server.ts` passes it straight through, so
		// the banner is decided by exactly the fold the header sentence and the
		// ninth bid gate read.
		expect(phaseOf('Contract Assignment').announcement).toBe(
			PHASE_ANNOUNCEMENTS['Contract Assignment']
		);
		expect(phaseOf('Auction').announcement).toBeNull();

		const result = await loadLayout(
			layoutEvent(phaseOf('Contract Assignment'), { kind: 'signed-out' })
		);
		expect(result.phase.announcement?.heading).toBe('The Auction Phase has ended');
	});
});

describe('+layout.svelte renders the announcement on every page, and borrows no device', () => {
	it('renders it from the layout, so it reaches every surface rather than one', () => {
		// The layout wraps `{@render children()}`, so a banner here is on every
		// page a Manager can open — which is what "when any page renders" means.
		expect(LAYOUT_SOURCE).toContain('data.phase.announcement !== null');
		expect(LAYOUT_SOURCE).toContain('data.phase.announcement.heading');
		expect(LAYOUT_SOURCE).toContain('data.phase.announcement.body');
		expect(LAYOUT_SOURCE).toContain('{@render children()}');
	});

	it('words none of it itself — every sentence comes from `server/phase.ts`', () => {
		expect(LAYOUT_MARKUP).not.toContain('Auction Phase has ended');
		expect(LAYOUT_MARKUP).not.toContain('Contract Assignment has begun');
	});

	it('mounts the freshness notice once, for every page beneath it (Story 4.1)', () => {
		// The layout wraps `{@render children()}`, so mounting the contract here
		// is what makes "one freshness state, one age, every surface" structural
		// rather than a habit each new screen has to remember.
		expect(LAYOUT_SOURCE).toContain('<FreshnessNotice');
		expect(LAYOUT_SOURCE).toContain('freshness.start()');
		expect(LAYOUT_SOURCE).toContain('freshness.stop()');
		// The channel effect reads nothing reactive, so navigation does not
		// reopen the socket; re-seeding is a separate effect that does.
		expect(LAYOUT_SOURCE).toContain('freshness.observeServerRead');
	});

	it('is a plain landmark with a heading, never a live region', () => {
		// `role="status"` would re-announce the identical sentence to a screen
		// reader on every navigation for the weeks Contract Assignment lasts.
		// A `region` named by its own heading is announced when a reader goes
		// looking for it.
		expect(LAYOUT_SOURCE).toContain('aria-labelledby="phase-announcement-heading"');
		expect(LAYOUT_SOURCE).toContain('id="phase-announcement-heading"');
		expect(LAYOUT_MARKUP).not.toMatch(/role="(status|alert|log)"/);
		expect(LAYOUT_MARKUP).not.toContain('aria-live');
	});

	it('borrows neither reserved device — no accent bar and no `attention`', () => {
		// `DESIGN.md:162` reserves the 3px bar for the Minimum-Bid Contention's
		// left bar and the refusal panel's top bar and says no other element
		// may borrow it; `:191` reserves `attention` for Outbid "and nothing
		// else in the entire system".
		expect(LAYOUT_MARKUP).not.toContain('--accent-bar-width');
		expect(LAYOUT_MARKUP).not.toContain('--color-attention');
		// It uses the shared primitives instead, so it introduces no token and
		// no CSS sizing literal of its own.
		expect(LAYOUT_SOURCE).toContain('class="panel"');
		expect(LAYOUT_SOURCE).not.toContain('<style>');
	});
});
