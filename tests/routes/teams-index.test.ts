/**
 * The Teams index page and its `load`, executed (Story 4.6).
 *
 * `vite.config.ts` runs tests under `environment: 'node'` and no `.svelte`
 * file can be rendered under this suite, so the SURFACE assertions are
 * source-text ones in the established pattern — `tests/routes/team-view.test.ts`'s
 * own idiom. Absence claims — no wording of its own, no `$lib/server` import,
 * no Maximum Bid symbol, nothing coloured by comparison — are provable this way
 * and are the whole point.
 *
 * `+page.server.ts` is a different matter and is EXECUTED. A source-text check
 * can say the gate call is present; it cannot say it runs FIRST, because
 * `toContain` is not position-aware and would stay green if the read were
 * hoisted above the guard. Only the real `requireLiveDestination` (nothing
 * about it is mocked) driving the real `load` proves the ordering and the 403.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isHttpError } from '@sveltejs/kit';

import {
	MEDIAN_GRID_NOTE,
	MEDIAN_LABEL,
	TEAMS_INDEX_TITLE,
	TEAMS_SORT_LABELS,
	TEAMS_SORT_LEGEND
} from '../../src/lib/core/teams-index.ts';
import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const at = (...parts: string[]): string => join(ROOT, ...parts);

const PAGE = readFileSync(at('src', 'routes', 'teams', '+page.svelte'), 'utf8');
const SERVER = readFileSync(at('src', 'routes', 'teams', '+page.server.ts'), 'utf8');

/**
 * A source with its comments stripped — `tests/structure.test.ts`'s
 * discipline, for the reason it states there: prose ABOUT a forbidden thing is
 * not that thing. This page explains at length why nothing is coloured by
 * comparison, and a text search for an absence would otherwise find the
 * explanation of it.
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
	index: null as Record<string, unknown> | null,
	/** Every `loadTeamsIndex` call, so "was it reached at all?" is answerable. */
	calls: [] as Array<{ viewerTeamId: string | null }>
}));

vi.mock('$lib/server/teams-index.ts', () => ({
	loadTeamsIndex: async (_gateway: unknown, viewerTeamId: string | null) => {
		stub.calls.push({ viewerTeamId });
		return stub.index;
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

const route = await import('../../src/routes/teams/+page.server.ts');

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
	stub.index = {
		rows: [],
		countSentence: 'No Teams.',
		median: {
			label: MEDIAN_LABEL,
			availableCapSpace: {
				label: 'Available Cap Space',
				figure: 'not available',
				sentence: 'Available Cap Space not available',
				coverage: 0,
				coverageSentence: 'Median · no Teams'
			},
			freeActiveBenchSlots: {
				label: 'Free Active/Bench Slots',
				figure: 'not available',
				sentence: 'Free Active/Bench Slots not available',
				coverage: 0,
				coverageSentence: 'Median · no Teams'
			},
			gridNote: MEDIAN_GRID_NOTE
		},
		figuresAt: '2026-09-03T12:00:00.000Z'
	};
	stub.calls.length = 0;
});

describe('load — the destination guard runs FIRST', () => {
	it('serves the page to a Manager in the Auction Phase', async () => {
		const result = (await route.load({
			locals: locals({ kind: 'registered', manager: MANAGER })
		} as never)) as { index: unknown; phase: ResolvedPhase };
		expect(result.index).toEqual(stub.index);
		expect(result.phase).toEqual(AUCTION_PHASE);
	});

	it('serves the page in every phase whose catalog carries teams', async () => {
		// `teams` is live in Auction, Contract Assignment and Archived
		// (`destinations.ts:79,87,94`) — three of the four. Contract Assignment
		// renders its cap and slot columns unchanged; the Year Allotment column
		// swap is Epic 6's and is recorded in deferred-work.md.
		for (const phase of [AUCTION_PHASE, ASSIGNMENT_PHASE, ARCHIVED_PHASE]) {
			stub.calls.length = 0;
			await route.load({
				locals: locals({ kind: 'registered', manager: MANAGER }, phase)
			} as never);
			expect(stub.calls, phase.name).toHaveLength(1);
		}
	});

	it('refuses with the guard’s 403 in Setup, whose catalog omits teams', async () => {
		await expectRefusal(
			() =>
				route.load({
					locals: locals({ kind: 'registered', manager: MANAGER }, SETUP_PHASE)
				} as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		// FIRST, not merely present: the read is never reached.
		expect(stub.calls, 'the read ran before the guard refused').toEqual([]);
	});

	it('refuses a non-registered session, which resolves to Sign-in alone in every phase', async () => {
		await expectRefusal(
			() => route.load({ locals: locals({ kind: 'signed-out' }) } as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(stub.calls).toEqual([]);
	});

	it('reads the viewer’s Team from the SESSION and from nothing else', async () => {
		await route.load({ locals: locals({ kind: 'registered', manager: MANAGER }) } as never);
		expect(stub.calls).toEqual([{ viewerTeamId: 't-2' }]);
	});

	it('passes null for a Manager bound to no Team — every Team still renders', async () => {
		await route.load({
			locals: locals({ kind: 'registered', manager: UNBOUND_MANAGER })
		} as never);
		expect(stub.calls).toEqual([{ viewerTeamId: null }]);
	});

	it('has no action at all — the index is a read surface', () => {
		expect((route as Record<string, unknown>)['actions']).toBeUndefined();
	});

	it('never 404s: an empty League is an answer, not a missing thing', () => {
		expect(SERVER_CODE).not.toContain('error(404');
		expect(SERVER_CODE).not.toContain('@sveltejs/kit');
	});

	it('names the destination by id and calls the real guard, not a local phase table', () => {
		expect(SERVER).toContain("'teams'");
		expect(SERVER).toContain('requireLiveDestination');
		// The guard call precedes the read in the source as well as at runtime.
		expect(SERVER.indexOf('requireLiveDestination(')).toBeLessThan(
			SERVER.indexOf('loadTeamsIndex(')
		);
		// No second phase table: the catalog is the one source (AD-30).
		expect(SERVER_CODE).not.toMatch(/'Setup'|'Archived'|'Contract Assignment'/);
	});
});

describe('the Teams index page — what it renders', () => {
	it('imports nothing from $lib/server', () => {
		// A `.svelte` file is reachable from the browser bundle; the
		// server-only library must never be.
		expect(PAGE).not.toMatch(/\$lib\/server/);
		expect(PAGE).not.toMatch(/\$env\/(dynamic|static)\/private/);
	});

	it('words nothing of its own — every label comes from the core', () => {
		expect(PAGE).toContain("from '$lib/core/teams-index.ts'");
		for (const symbol of [
			'TEAMS_INDEX_TITLE',
			'TEAMS_SORT_LEGEND',
			'TEAMS_SORT_LABELS',
			'TEAMS_SORT_KEYS',
			'EMPTY_TEAMS_HEADING',
			'EMPTY_TEAMS_STATEMENT'
		]) {
			expect(PAGE, symbol).toContain(symbol);
		}
		// No literal spelling of any string the core already owns. Asserted
		// over the comment-stripped source, because the prose explains the
		// rule and naming a label there is not printing it.
		for (const label of [
			TEAMS_INDEX_TITLE,
			TEAMS_SORT_LEGEND,
			MEDIAN_LABEL,
			MEDIAN_GRID_NOTE,
			...Object.values(TEAMS_SORT_LABELS)
		]) {
			expect(PAGE_CODE, `the page spells "${label}" itself`).not.toContain(`>${label}<`);
		}
	});

	it('carries the page-level figuresAgeSentence in anything but Live (AD-29)', () => {
		expect(PAGE).toContain('figuresAgeSentence');
		expect(PAGE).toContain("freshness.state === 'live'");
		expect(PAGE).toContain('teams-figures-age');
		// The AGE branch, not the disable branch — there is no control here to
		// disable, because nothing on this surface authorises.
		expect(PAGE_CODE).not.toContain('disabled');
	});

	it('derives the absolute stamp inside an $effect, never during SSR', () => {
		// `Intl.DateTimeFormat(undefined, ...)` would otherwise ship the
		// SERVER's timezone in the delivered HTML.
		expect(PAGE_CODE).toContain('$effect(');
		expect(PAGE_CODE).toContain('readAt = formatAbsolute(index.figuresAt)');
		expect(PAGE_CODE).toContain('let readAt = $state<string | null>(null)');
	});

	/**
	 * The rendered payload and the page source are both searched: neither may
	 * contain a Maximum Bid figure, a cap breakdown row or a Roster Reserve
	 * figure for any Team — including the viewer's own.
	 */
	it('carries no Maximum Bid, cap breakdown or Roster Reserve symbol at all', () => {
		for (const symbol of [
			'maximumBid',
			'maximumBidLabel',
			'capBreakdown',
			'CapBreakdown',
			'rosterReserve',
			'Maximum Bid'
		]) {
			expect(PAGE_CODE, symbol).not.toContain(symbol);
		}
	});

	it('states no comparison, and colours nothing by it', () => {
		for (const forbidden of ['average', 'above', 'below', 'rank', 'rich', 'poor']) {
			expect(PAGE_CODE.toLowerCase(), forbidden).not.toContain(forbidden);
		}
		// `attention` marks Outbid and nothing else in the entire system, and
		// the 3px lottery bar belongs to Minimum-Bid Contention — the own-row
		// edge must not borrow either.
		expect(PAGE_CODE).not.toContain('--color-attention');
		expect(PAGE_CODE).not.toContain('--color-lottery');
		expect(PAGE_CODE).not.toContain('--color-brand');
		expect(PAGE_CODE).not.toContain('--accent-bar-width');
	});

	it('sorts through the core’s own function, held in one piece of view state', () => {
		expect(PAGE).toContain('let sort = $state<TeamsSort>(DEFAULT_TEAMS_SORT)');
		expect(PAGE).toContain('$derived(sortTeamsIndex(index.rows, sort))');
		// Native radios in a fieldset — `board/+page.svelte`'s pattern, which
		// makes "sorting is view state" visible in the markup.
		expect(PAGE).toContain('<fieldset class="controls">');
		expect(PAGE).toContain('bind:group={sort}');
		expect(PAGE).toContain("type=\"radio\"");
		// No form, no navigation: a sort posts nothing and reloads nothing.
		expect(PAGE_CODE).not.toContain('goto(');
		expect(PAGE_CODE).not.toMatch(/<form/);
	});

	it('holds the sort behind the board’s collapsible control, closed and naming the order in force', () => {
		// `<details>`/`<summary>`, the board's own disclosure — not a custom
		// button: it opens on tap AND on Enter and is announced expanded or
		// collapsed without a line of script.
		expect(PAGE).toContain('<details class="controls-disclosure" bind:open={sortOpen}>');
		// CLOSED to begin with. The first screen of the index is the index.
		expect(PAGE).toContain('let sortOpen = $state(false)');
		// The closed row still says which order is in force, so nothing the
		// radios used to answer is hidden by the control that holds them.
		expect(PAGE).toContain('<span class="prose controls-current">{TEAMS_SORT_LABELS[sort]}</span>');
		// The legend is not printed twice: the summary names the control on
		// screen, the legend names it for a screen reader reading the radios.
		expect(PAGE).toContain('<legend class="visually-hidden">{TEAMS_SORT_LEGEND}</legend>');
		expect(PAGE).not.toContain('<legend class="section-label">');
		// Choosing closes it — the choice is the whole reason it was opened.
		expect(PAGE).toContain('onchange={() => (sortOpen = false)}');
	});

	it('pairs the roster count with Bids and the Minor League count with Injury Reserve, on one line each', () => {
		// Two figures read as one phrase behind a `·`, on the card's own left
		// margin — `PersistentStrip.svelte`'s construction, down to the
		// separator's two declarations, so the dot between two figures is the
		// same dot in both places it appears in the product.
		expect(PAGE).toContain('<div class="row-line">');
		expect(PAGE).toContain('justify-content: flex-start');
		expect(PAGE).toContain('flex-wrap: wrap');
		expect(PAGE).toContain('<span class="row-separator" aria-hidden="true">·</span>');
		// The separator LEADS the optional Bids figure, so the pair carries a
		// single `·` whether or not that half is present — and none at all when
		// it is absent. The strip's arrangement, for the strip's reason.
		expect(PAGE).toMatch(
			/{#if row\.outstandingBidsHalves !== null}\s*<span class="row-separator"/
		);
		// The open-entries figure is NOT in a pair: two bid figures at the two
		// ends of one line is the single combined reading UX-DR36 forbids.
		const pairs = PAGE.split('<div class="row-line">')
			.slice(1)
			.map((segment) => segment.slice(0, segment.indexOf('</div>')));
		expect(pairs).toHaveLength(2);
		expect(pairs[0]).toContain('row.rosterCountHalves');
		expect(pairs[0]).toContain('row.outstandingBidsHalves');
		expect(pairs[0]).not.toContain('row.contentionEntriesHalves');
		expect(pairs[1]).toContain('row.minorLeagueHalves');
		expect(pairs[1]).toContain('row.injuryReserveHalves');
		// Pairing is layout and nothing else: every figure keeps its own
		// unbroken sentence for a screen reader.
		for (const half of [
			'rosterCountHalves',
			'outstandingBidsHalves',
			'minorLeagueHalves',
			'injuryReserveHalves'
		]) {
			expect(PAGE).toContain(`aria-label={row.${half}.full}`);
		}
	});

	it('links every row to that Team’s page through the core’s href', () => {
		expect(PAGE).toContain('href={row.href}');
		// The path shape is the core's; the surface never spells `/teams/`.
		expect(PAGE_CODE).not.toContain("'/teams/");
	});

	it('separates rows by a 1px border rule rather than by card gaps (DESIGN.md:179)', () => {
		expect(PAGE).toContain('border-bottom: var(--border-width) solid var(--color-border)');
	});

	it('sets the Team name in `ui`, not Georgia (DESIGN.md:181)', () => {
		const block = /\.team-identity\s*\{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';
		expect(block).toContain('var(--font-ui)');
		expect(block).not.toContain('--font-display');
	});

	it('gives the Team name the section-label treatment of Your Positions’ group headers', () => {
		const block = /\.team-identity\s*\{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';
		// `global.css:175`'s own three properties. A deliberate departure from
		// DESIGN.md:181's 15px sentence case: the name reads as the heading the
		// row hangs off, so the figures beneath it carry the weight.
		expect(block).toContain('var(--size-10)');
		expect(block).toContain('text-transform: uppercase');
		expect(block).toContain('letter-spacing: 0.16em');
		// The COLOUR half of that treatment is deliberately NOT taken — the
		// group headers are `text-tertiary`, and DESIGN.md:187 keeps every Team
		// name in `text`. The name takes the label's shape, not its quietness.
		expect(block).not.toContain('var(--color-text-tertiary)');
	});

	/*
	 * The two halves of the naming rule take two registers (DESIGN.md:187),
	 * and this is the pair of assertions that pins WHICH half gets which — a
	 * whole-file check that `--color-text-secondary` appears somewhere is
	 * satisfied by the inverted layout just as well, which is exactly the
	 * blindness a repo that cannot render a component has to test around.
	 */
	it('sets EVERY Team name in `text` — the viewer’s included — and the Manager beside it quieter', () => {
		const identity = /\.team-identity\s*\{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';
		const manager = /\.team-manager\s*\{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';
		const own = /\.own\s*\{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';

		expect(identity).toContain('var(--color-text)');
		expect(identity, 'the Team name is the row’s identity and is never dimmed').not.toContain(
			'var(--color-text-secondary)'
		);
		expect(manager).toContain('var(--color-text-secondary)');

		// The own row is marked by the EDGE alone: no fill, no text colour.
		//
		// `color:` is matched as a DECLARATION — anchored to a `{` or `;` —
		// rather than as a substring, because the marker legitimately sets
		// `border-left-color` and a bare `.toContain('color:')` reads that as
		// a text colour. The rule being pinned is that the viewer's name is
		// never re-coloured (DESIGN.md:187), so it is the `color` property
		// itself that must be absent, not the six letters.
		expect(own).toContain('var(--color-border-strong)');
		expect(own).not.toContain('background');
		expect(own, 'the own row must not re-colour its text').not.toMatch(/[{;]\s*color\s*:/);
	});

	it('marks the viewer’s own row with a 2px edge, never the 3px lottery bar (DESIGN.md:185)', () => {
		expect(PAGE).toContain('class:own={row.isViewer}');
		const own = /\.own\s*\{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';
		const rowBlock = /\.row\s*\{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';
		expect(rowBlock).toContain('var(--own-row-edge-width)');
		expect(own).not.toContain('--accent-bar-width');
		expect(rowBlock).not.toContain('--accent-bar-width');
		// ...and `— you` comes from the core, never spelled here.
		expect(PAGE).toContain('{row.managerSuffix}');
		const identityBlock = /<span class="team-identity"[\s\S]*?<\/span\s*>/.exec(PAGE)?.[0] ?? '';
		expect(identityBlock.length).toBeGreaterThan(0);
		expect(identityBlock, 'the em dash must not be spelled on the row').not.toContain('—');
	});

	/**
	 * Marking a row must change its APPEARANCE and never its layout. A border
	 * and a padding applied to one row alone would inset it by their own
	 * width, and on a ruled comparison list the marked Team's figures would
	 * then sit out of column with every other row — working against the whole
	 * job of the surface.
	 */
	it('reserves the own-row edge on EVERY row, so marking one never moves it', () => {
		const rowBlock = /\.row\s*\{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';
		const own = /\.own\s*\{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';
		expect(rowBlock.length).toBeGreaterThan(0);
		expect(own.length).toBeGreaterThan(0);

		// The edge and its padding are declared once, on every row.
		expect(rowBlock).toContain('border-left: var(--own-row-edge-width) solid transparent');
		expect(rowBlock).toContain('padding-left: var(--space-row-gap)');

		// ...and the marked row changes NOTHING but the colour: no width, no
		// padding, no fill, no text colour, so it cannot shift.
		expect(own).toContain('border-left-color: var(--color-border-strong)');
		expect(own, 'the marker must not restate the width').not.toContain('border-left:');
		expect(own, 'the marker must not add padding').not.toContain('padding');
		expect(own, 'the marker must not fill the row').not.toContain('background');
		expect(own, 'the marker must not recolour the text').not.toContain('color: var(--color-text');
		expect(own, 'the marker must not resize the row').not.toContain('margin');
	});

	it('sets the slot count at full strength and the `of 12` beside it one step quieter', () => {
		const qualifier = /\.figure-qualifier\s*\{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';
		const figure = /\.figure\s*\{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';

		expect(qualifier).toContain('var(--color-text-secondary)');
		expect(figure).toContain('var(--color-text)');
		expect(figure, 'the count carries the information and is never dimmed').not.toContain(
			'var(--color-text-secondary)'
		);
		for (const half of ['rosterCountHalves', 'minorLeagueHalves', 'injuryReserveHalves']) {
			expect(PAGE, half).toContain(`row.${half}.lead`);
			expect(PAGE, half).toContain(`row.${half}.qualifier`);
		}
		// The page never searches a sentence for the separator itself.
		expect(PAGE_CODE, 'the page splits a sentence itself').not.toMatch(/indexOf\(|\.split\(/);
		expect(PAGE).toContain('aria-label={row.rosterCountHalves.full}');
	});

	it('sets the median line behind a border-strong rule and quieter than every row (DESIGN.md:189)', () => {
		const median = /\.median\s*\{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';
		const figure = /\.median-figure\s*\{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';

		expect(median).toContain('border-top: var(--border-width) solid var(--color-border-strong)');
		// Quieter than every row above it: `text-secondary` against the rows'
		// `text`. It is context, not a verdict.
		expect(figure).toContain('var(--color-text-secondary)');
		expect(figure).not.toContain('var(--color-text);');
		// Both figures and their coverage come from the core.
		expect(PAGE).toContain('index.median.availableCapSpace.figure');
		expect(PAGE).toContain('index.median.freeActiveBenchSlots.figure');
		expect(PAGE).toContain('coverageSentence');
		expect(PAGE).toContain('index.median.gridNote');
	});

	/**
	 * The printed phrase is the CORE's, not a template join — the same rule the
	 * rows already follow with `SlotSentenceHalves`, and the same accessibility
	 * reason: two fragments read as two facts.
	 */
	it('takes the composed median phrase from the core and joins nothing itself', () => {
		expect(PAGE).toContain('aria-label={index.median.availableCapSpace.sentence}');
		expect(PAGE).toContain('aria-label={index.median.freeActiveBenchSlots.sentence}');
		// The two registers are set separately but never concatenated in
		// markup: no template puts a label and a figure inside one expression
		// pair with a space between them.
		expect(PAGE).not.toMatch(/\{index\.median\.\w+\.label\}\s+\{index\.median\.\w+\.figure\}/);
	});

	/**
	 * The grid note is about the $500,000 MONEY grid. Rendered after both
	 * cells it would read as an explanation of the free-Slot count too, which
	 * has no grid and no decimal.
	 */
	it('attaches the money grid note to Available Cap Space and to nothing else', () => {
		const cells = PAGE.split('<div class="cell">');
		const withNote = cells.filter((cell) => cell.includes('index.median.gridNote'));
		expect(withNote, 'the grid note is not inside exactly one cell').toHaveLength(1);
		expect(withNote[0]).toContain('index.median.availableCapSpace');
		expect(withNote[0], 'the note sits with the slot figure too').not.toContain(
			'index.median.freeActiveBenchSlots'
		);
	});

	it('spells no colour literal — every value is a token', () => {
		const styles = /<style>[\s\S]*<\/style>/.exec(PAGE)?.[0] ?? '';
		expect(styles.length).toBeGreaterThan(0);
		expect(styles, 'a raw colour').not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
	});
});

describe('the Teams index row — the two bids figures (Story 10.6)', () => {
	it('renders them as TWO figures, in the established register', () => {
		// Both in `.figure`/`.figure-qualifier`, like the slot sentences above
		// them, and each reading its own halves off the row.
		expect(PAGE).toContain('row.outstandingBidsHalves.lead');
		expect(PAGE).toContain('row.outstandingBidsHalves.qualifier');
		expect(PAGE).toContain('row.outstandingBidsHalves.full');
		expect(PAGE).toContain('row.contentionEntriesHalves.lead');
		expect(PAGE).toContain('row.contentionEntriesHalves.qualifier');
		expect(PAGE).toContain('row.contentionEntriesHalves.full');
	});

	it('never sums them, and never words either one itself', () => {
		// A combined figure would state a ceiling on lottery entries that does
		// not exist (UX-DR36). The page has no arithmetic for it and no
		// vocabulary of its own: nothing adds the two counts, the raw counts
		// are not even read, and every word on the two figures arrives inside
		// a `Halves` object the core built.
		expect(PAGE_CODE).not.toContain('outstandingBids +');
		expect(PAGE_CODE).not.toContain('openContentionEntries');
		expect(PAGE_CODE).not.toContain('row.outstandingBids}');
		for (const forbidden of ['lottery', 'allowance', 'permitted']) {
			expect(PAGE_CODE.toLowerCase(), forbidden).not.toContain(forbidden);
		}
	});

	it('gives the figures no colour, badge or warning treatment (UX-DR35)', () => {
		// At parity the figure alone is the signal. Nothing on the row is
		// conditioned on the count.
		expect(PAGE_CODE).not.toMatch(/class:.*[Bb]ids/);
		expect(PAGE_CODE).not.toMatch(/outstandingBids\s*[<>=]/);
	});
});
