/**
 * One Team's page and its `load`, executed (Story 4.5).
 *
 * `vite.config.ts` runs tests under `environment: 'node'` and no `.svelte`
 * file can be rendered under this suite, so the SURFACE assertions are
 * source-text ones in the established pattern — `tests/routes/positions.test.ts`'s
 * own idiom. Absence claims — no wording of its own, no `$lib/server` import,
 * no Maximum Bid on a rival's markup path — are provable this way and are the
 * whole point.
 *
 * `+page.server.ts` is a different matter and is EXECUTED. A source-text check
 * can say the gate call is present; it cannot say it runs FIRST, because
 * `toContain` is not position-aware and would stay green if the read were
 * hoisted above the guard. Only the real `requireLiveDestination` (nothing
 * about it is mocked) driving the real `load` proves the ordering, the 403 and
 * the 404.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isHttpError } from '@sveltejs/kit';

import { TEAM_VIEW_LABELS } from '../../src/lib/core/team-view.ts';
import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const at = (...parts: string[]): string => join(ROOT, ...parts);

const PAGE = readFileSync(at('src', 'routes', 'teams', '[teamId]', '+page.svelte'), 'utf8');
const SERVER = readFileSync(at('src', 'routes', 'teams', '[teamId]', '+page.server.ts'), 'utf8');

/**
 * A source with its comments stripped — `tests/structure.test.ts`'s
 * discipline, for the reason it states there: prose ABOUT a forbidden thing is
 * not that thing. This page explains at length why nothing is coloured by
 * comparison and why Maximum Bid is absent on a rival, and a text search for
 * an absence would otherwise find the explanation of it.
 */
function stripComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/^\s*\/\/.*$/gm, '');
}

const PAGE_CODE = stripComments(PAGE);
const SERVER_CODE = stripComments(SERVER);

const stub = vi.hoisted(() => ({
	team: null as Record<string, unknown> | null,
	/** Every `loadTeamView` call, so "was it reached at all?" is answerable. */
	calls: [] as Array<{ teamId: string; viewerTeamId: string | null }>
}));

vi.mock('$lib/server/team-view.ts', () => ({
	loadTeamView: async (_gateway: unknown, teamId: string, viewerTeamId: string | null) => {
		stub.calls.push({ teamId, viewerTeamId });
		return stub.team;
	}
}));

vi.mock('$lib/shell/db.ts', () => ({
	writeGateway: () => ({
		connect: async () => ({
			query: async () => ({ rows: [] }),
			release: () => {}
		})
	})
}));

const route = await import('../../src/routes/teams/[teamId]/+page.server.ts');

const MANAGER: RegisteredManager = {
	id: 'm-2',
	discordUserId: '222',
	displayName: 'Alice',
	teamId: 't-2',
	teamName: 'Lakers',
	isCommissioner: false
};

const UNBOUND_MANAGER: RegisteredManager = {
	id: 'm-3',
	discordUserId: '333',
	displayName: 'Bo',
	teamId: null,
	teamName: null,
	isCommissioner: false
};

const SETUP_PHASE: ResolvedPhase = { name: 'Setup', sentence: 'Setup.', announcement: null };
const AUCTION_PHASE: ResolvedPhase = { name: 'Auction', sentence: 'Auction.', announcement: null };
const ASSIGNMENT_PHASE: ResolvedPhase = {
	name: 'Contract Assignment',
	sentence: 'Contract Assignment.',
	announcement: null
};
const ARCHIVED_PHASE: ResolvedPhase = {
	name: 'Archived',
	sentence: 'Archived.',
	announcement: null
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
	stub.team = {
		teamId: 't-2',
		teamName: 'Lakers',
		identity: 'Lakers — Alice',
		managerNames: ['Alice'],
		viewerIsThisTeam: true,
		capSpaceLabel: '$165.0M',
		committedBidsLabel: '$0.0M',
		minorsExposureLabel: '$0.0M',
		availableCapSpaceLabel: '$165.0M',
		rosterCount: 0,
		rosterCountSentence: 'Roster 0 of 12',
		activeBenchSentence: 'Free Active/Bench Slots 12 of 12',
		minorLeagueSentence: 'Minor League 0 of 3, Free Minor League Slots 3',
		injuryReserveSentence: 'Injury Reserve 0 of 2, outside the 12',
		roster: [],
		nominationSlot: {
			used: false,
			fantraxPlayerId: null,
			playerName: null,
			sentence: 'The Nomination Slot is free.',
			href: null
		},
		figuresAt: '2026-09-03T12:00:00.000Z'
	};
	stub.calls.length = 0;
});

describe('load — the destination guard runs FIRST', () => {
	it('serves the page to a Manager in the Auction Phase', async () => {
		const result = (await route.load({
			locals: locals({ kind: 'registered', manager: MANAGER }),
			params: { teamId: 't-2' }
		} as never)) as { team: unknown; phase: ResolvedPhase };
		expect(result.team).toEqual(stub.team);
		expect(result.phase).toEqual(AUCTION_PHASE);
	});

	it('serves the page in every phase whose catalog carries teams', async () => {
		// `teams` is live in Auction, Contract Assignment and Archived
		// (`destinations.ts:79,87,94`) — three of the four.
		for (const phase of [AUCTION_PHASE, ASSIGNMENT_PHASE, ARCHIVED_PHASE]) {
			stub.calls.length = 0;
			await route.load({
				locals: locals({ kind: 'registered', manager: MANAGER }, phase),
				params: { teamId: 't-2' }
			} as never);
			expect(stub.calls).toHaveLength(1);
		}
	});

	it('refuses with the guard’s 403 in Setup, whose catalog omits teams', async () => {
		await expectRefusal(
			() =>
				route.load({
					locals: locals({ kind: 'registered', manager: MANAGER }, SETUP_PHASE),
					params: { teamId: 't-2' }
				} as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		// FIRST, not merely present: the read is never reached.
		expect(stub.calls, 'the read ran before the guard refused').toEqual([]);
	});

	it('refuses a non-registered session, which resolves to Sign-in alone in every phase', async () => {
		await expectRefusal(
			() =>
				route.load({
					locals: locals({ kind: 'signed-out' }),
					params: { teamId: 't-2' }
				} as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(stub.calls).toEqual([]);
	});

	it('404s an unknown Team id — not an empty page', async () => {
		stub.team = null;
		await expectRefusal(
			() =>
				route.load({
					locals: locals({ kind: 'registered', manager: MANAGER }),
					params: { teamId: 't-nobody' }
				} as never),
			404
		);
	});

	it('reads the viewer’s Team from the SESSION and the Team from the PARAM', async () => {
		await route.load({
			locals: locals({ kind: 'registered', manager: MANAGER }),
			params: { teamId: 't-rival' }
		} as never);
		expect(stub.calls).toEqual([{ teamId: 't-rival', viewerTeamId: 't-2' }]);
	});

	it('passes null for a Manager bound to no Team — every Team still renders', async () => {
		await route.load({
			locals: locals({ kind: 'registered', manager: UNBOUND_MANAGER }),
			params: { teamId: 't-2' }
		} as never);
		expect(stub.calls).toEqual([{ teamId: 't-2', viewerTeamId: null }]);
	});

	it('has no action at all — a Team view is a read surface', () => {
		expect((route as Record<string, unknown>)['actions']).toBeUndefined();
	});

	it('names the destination by id and calls the real guard, not a local phase table', () => {
		expect(SERVER).toContain("'teams'");
		expect(SERVER).toContain('requireLiveDestination');
		// The guard call precedes the read in the source as well as at runtime.
		expect(SERVER.indexOf('requireLiveDestination(')).toBeLessThan(SERVER.indexOf('loadTeamView('));
		// No second phase table: the catalog is the one source (AD-30).
		expect(SERVER_CODE).not.toMatch(/'Setup'|'Archived'|'Contract Assignment'/);
	});
});

describe('the Team page — what it renders', () => {
	it('imports nothing from $lib/server', () => {
		// A `.svelte` file is reachable from the browser bundle; the
		// server-only library must never be.
		expect(PAGE).not.toMatch(/\$lib\/server/);
		expect(PAGE).not.toMatch(/\$env\/(dynamic|static)\/private/);
	});

	it('words nothing of its own — every label comes from the core', () => {
		expect(PAGE).toContain("from '$lib/core/team-view.ts'");
		for (const symbol of ['TEAM_VIEW_LABELS', 'TEAM_VIEW_TITLE']) {
			expect(PAGE, symbol).toContain(symbol);
		}
		// No literal spelling of any label the core already owns. Asserted
		// over the comment-stripped source, because the prose explains the
		// rule and naming a label there is not printing it.
		for (const label of Object.values(TEAM_VIEW_LABELS)) {
			expect(PAGE_CODE, `the page spells "${label}" itself`).not.toContain(`>${label}<`);
		}
	});

	it('carries the page-level figuresAgeSentence in anything but Live (AD-29)', () => {
		expect(PAGE).toContain('figuresAgeSentence');
		expect(PAGE).toContain("freshness.state === 'live'");
		expect(PAGE).toContain('team-figures-age');
		// The AGE branch, not the disable branch — there is no control here to
		// disable, because nothing on this surface authorises.
		expect(PAGE_CODE).not.toContain('disabled');
	});

	it('derives the absolute stamp inside an $effect, never during SSR', () => {
		// `Intl.DateTimeFormat(undefined, ...)` would otherwise ship the
		// SERVER's timezone in the delivered HTML.
		const effect = PAGE_CODE.indexOf('$effect(');
		const intl = PAGE_CODE.indexOf('Intl.DateTimeFormat');
		expect(effect).toBeGreaterThan(-1);
		expect(intl).toBeGreaterThan(-1);
		// The only Intl use is inside the function the effect calls, and the
		// stamp is state the effect writes.
		expect(PAGE_CODE).toContain('readAt = formatAbsolute(team.figuresAt)');
		expect(PAGE_CODE).toContain('let readAt = $state<string | null>(null)');
	});

	it('renders Maximum Bid and the breakdown behind the own-Team branch alone', () => {
		expect(PAGE).toContain('team.viewerIsThisTeam && team.maximumBidLabel !== undefined');
		expect(PAGE).toContain('team.viewerIsThisTeam && team.capBreakdown !== undefined');
		// The breakdown is the EXISTING component, unchanged.
		expect(PAGE).toContain("import CapBreakdown from '$lib/components/CapBreakdown.svelte'");
	});

	it('states no median, no rank, and colours nothing by comparison', () => {
		for (const forbidden of ['median', 'average', 'above', 'below', 'rank']) {
			expect(PAGE_CODE.toLowerCase(), forbidden).not.toContain(forbidden);
		}
		// `attention` marks Outbid and nothing else in the entire system, and
		// the 3px lottery bar belongs to Minimum-Bid Contention.
		expect(PAGE_CODE).not.toContain('--color-attention');
		expect(PAGE_CODE).not.toContain('--color-lottery');
		expect(PAGE_CODE).not.toContain('--accent-bar-width');
	});

	it('separates rows by a 1px border rule rather than by card gaps (DESIGN.md:179)', () => {
		expect(PAGE).toContain('border-bottom: var(--border-width) solid var(--color-border)');
	});

	it('sets the Team name in `ui`, not Georgia (DESIGN.md:181)', () => {
		expect(PAGE).toContain('.team-identity');
		const block = /\.team-identity\s*\{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';
		expect(block).toContain('var(--font-ui)');
		expect(block).toContain('var(--size-15)');
		expect(block).not.toContain('--font-display');
	});

	/*
	 * The two halves of the naming rule take two registers (DESIGN.md:187),
	 * and this is the pair of assertions that pins WHICH half gets which —
	 * a whole-file check that `--color-text-secondary` appears somewhere is
	 * satisfied by the inverted layout just as well, which is exactly the
	 * blindness a repo that cannot render a component has to test around.
	 */
	it('sets the Team name in `text` and the Manager beside it in `text-secondary`', () => {
		const identity = /\.team-identity\s*\{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';
		const manager = /\.team-manager\s*\{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';

		expect(identity).toContain('var(--color-text)');
		expect(identity, 'the Team name is the identity and is never dimmed').not.toContain(
			'var(--color-text-secondary)'
		);

		expect(manager).toContain('var(--color-text-secondary)');
		expect(manager, 'the quieter half must not restate the full-strength colour').not.toContain(
			'var(--color-text);'
		);
	});

	it('renders the two halves from the core, and never splits a joined string', () => {
		expect(PAGE).toContain('{team.teamName}');
		expect(PAGE).toContain('{team.managerSuffix}');

		// The em dash is the naming convention's own punctuation and is
		// spelled once, in `core/team-identity.ts`. A surface that carried it
		// inside the identity heading would be a second definition of the
		// pairing — scoped to that heading, because the page's prose comments
		// and its `<title>` separator legitimately use the character for
		// something that is not the naming rule.
		const heading = /<h1[\s\S]*?<\/h1\s*>/.exec(PAGE)?.[0] ?? '';
		expect(heading.length).toBeGreaterThan(0);
		expect(heading, 'the em dash must not be spelled in the identity heading').not.toContain(
			'—'
		);
		expect(heading).toContain('{team.teamName}');
		expect(heading).toContain('{team.managerSuffix}');
	});

	it('spells no size, colour or spacing literal — every value is a token', () => {
		const styles = /<style>[\s\S]*<\/style>/.exec(PAGE)?.[0] ?? '';
		expect(styles.length).toBeGreaterThan(0);
		expect(styles, 'a raw pixel size').not.toMatch(/:\s*\d+px/);
		expect(styles, 'a raw colour').not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
	});
});
