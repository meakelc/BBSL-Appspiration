/**
 * The Bid Board's surface and its `load`, executed (Story 4.3).
 *
 * `vite.config.ts` runs tests under `environment: 'node'` and no `.svelte`
 * file can be rendered under this suite, so the SURFACE assertions are
 * source-text ones in the established pattern — `tests/routes/auction-page.test.ts`'s
 * own idiom, and its own note explains why. Absence claims — no wording of
 * its own, no `$lib/server` import, no tokenised value spelled as a literal —
 * are provable this way and are the whole point.
 *
 * `+page.server.ts` is a different matter and is EXECUTED. A source-text
 * check can say the gate call is present; it cannot say it runs FIRST,
 * because `toContain` is not position-aware and would stay green if the read
 * were hoisted above the guard. Only the real `requireLiveDestination`
 * (nothing about it is mocked) driving the real `load` proves the ordering
 * and the 403.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isHttpError } from '@sveltejs/kit';

import {
	AUCTION_STATE_ICONS,
	AUCTION_STATE_LABELS,
	BOARD_HIDE_ABOVE_CAP_LABEL,
	BOARD_HIDE_CLOSED_LABEL,
	SORT_KEYS,
	VIEWER_STATE_ICONS,
	VIEWER_STATE_LABELS
} from '../../src/lib/core/board.ts';
import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const at = (...parts: string[]): string => join(ROOT, ...parts);

const PAGE = readFileSync(at('src', 'routes', 'board', '+page.svelte'), 'utf8');
const SERVER = readFileSync(at('src', 'routes', 'board', '+page.server.ts'), 'utf8');

/**
 * The page with every comment stripped — `tests/structure.test.ts`'s
 * discipline for the reason it states there: prose ABOUT a forbidden thing is
 * not that thing. This page's header explains at length that it words nothing
 * itself and carries no urgency device, and an absence check over the raw
 * text would fail on the sentence that promises the absence.
 */
function stripComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
}

const PAGE_CODE = stripComments(PAGE);
const SERVER_CODE = stripComments(SERVER);

const stub = vi.hoisted(() => ({
	board: {} as Record<string, unknown>,
	/** Every `loadBoard` call, so "was it reached at all?" is answerable. */
	calls: [] as Array<string | null>
}));

vi.mock('$lib/server/board.ts', () => ({
	loadBoard: async (_gateway: unknown, viewerTeamId: string | null) => {
		stub.calls.push(viewerTeamId);
		return stub.board;
	}
}));

vi.mock('$lib/shell/db.ts', () => ({
	writeGateway: () => ({
		connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} })
	})
}));

const route = await import('../../src/routes/board/+page.server.ts');

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
	stub.board = { cards: [], figuresAt: '2026-08-27T12:00:00.000Z', viewerTeamId: null };
	stub.calls.length = 0;
});

describe('load — the destination guard runs FIRST', () => {
	it('shortens the lottery name below 640px, and never in script', () => {
		// `Minimum Lottery` at `--size-10` beside a Player's name wraps this
		// card's identity row on a phone. Both spellings are the core's, and
		// the CHOICE is CSS: a viewport question answered by the only thing
		// that can see a viewport. A `matchMedia` here would answer it wrong
		// for one paint during SSR and re-answer it on every resize.
		expect(PAGE).toContain('{card.auctionStateLabelNarrow}');
		expect(PAGE).toContain('{card.auctionStateLabel}');
		expect(PAGE_CODE).not.toMatch(/matchMedia|innerWidth/);
		// The same breakpoint the app already changes its mind at.
		expect(PAGE).toMatch(/@media \(min-width: 640px\)/);
		// Exactly one of the two is displayed at any width, so a screen reader
		// reads the name that is on screen and never both.
		const style = PAGE.slice(PAGE.indexOf('<style>'));
		expect(style).toMatch(/\.chip-word-wide \{\s*display: none;/);
		expect(style).toMatch(/\.chip-word-narrow \{\s*display: none;/);
	});

	it('sets a long Player name a step down the scale, and never truncates one', () => {
		// `Giannis Antetokounmpo` at `--size-18` takes the whole identity row on
		// a 375px phone and pushes the Auction state onto a line of its own. The
		// name drops to the adjacent step above a named length — a LENGTH and not
		// a viewport, because the longest names are long at every width.
		expect(PAGE).toContain('const LONG_NAME_LENGTH = 18;');
		expect(PAGE).toMatch(
			/class:card-player-long=\{card\.playerName\.length > LONG_NAME_LENGTH\}/
		);
		const style = PAGE.slice(PAGE.indexOf('<style>'));
		expect(style).toMatch(/\.card-player-long \{\s*font-size: var\(--size-15\);/);
		// It VARIES the name rather than clipping it: the Player's name is the
		// one thing on this card that may never be cut off.
		// Comments stripped: the rule's own commentary NAMES the device it
		// rejects, and a raw substring search would read that as the device.
		expect(PAGE_CODE.slice(PAGE_CODE.indexOf('<style>'))).not.toContain('text-overflow');
		expect(PAGE_CODE).not.toMatch(/\.slice\(0,|substring\(|\.\.\.'/);
	});

	it('serves the board to a Manager in the Auction Phase', async () => {
		const result = (await route.load({
			locals: locals({ kind: 'registered', manager: MANAGER })
		} as never)) as { board: unknown; phase: ResolvedPhase };
		expect(result.board).toEqual(stub.board);
		expect(result.phase).toEqual(AUCTION_PHASE);
	});

	it('serves the frozen board in Archived — the phase this story adopts', async () => {
		// `EXPERIENCE.md:32` and `:320` disagree about where the frozen readable
		// board lives; `destinations.ts:93` already implements the Archived
		// reading, so that is the one built to and the document fix is
		// escalated in deferred-work.md rather than decided in code.
		await route.load({
			locals: locals({ kind: 'registered', manager: MANAGER }, ARCHIVED_PHASE)
		} as never);
		expect(stub.calls).toHaveLength(1);
	});

	it('refuses with the guard’s 403 in a phase whose catalog omits bid-board — not a redirect', async () => {
		for (const phase of [SETUP_PHASE, ASSIGNMENT_PHASE]) {
			stub.calls.length = 0;
			await expectRefusal(
				() =>
					route.load({
						locals: locals({ kind: 'registered', manager: MANAGER }, phase)
					} as never),
				LIVE_DESTINATION_REFUSAL_STATUS
			);
			// FIRST, not merely present: the read is never reached, so no empty
			// board can be returned in place of the refusal.
			expect(stub.calls, 'the read ran before the guard refused').toEqual([]);
		}
	});

	it('refuses a non-registered session, which resolves to Sign-in alone in every phase', async () => {
		await expectRefusal(
			() => route.load({ locals: locals({ kind: 'signed-out' }) } as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(stub.calls).toEqual([]);
	});

	it('reads the viewer’s Team from the SESSION and nothing else', async () => {
		await route.load({ locals: locals({ kind: 'registered', manager: MANAGER }) } as never);
		expect(stub.calls).toEqual(['t-2']);
	});

	it('passes null for a Manager bound to no Team — the board still renders in full', async () => {
		const result = (await route.load({
			locals: locals({ kind: 'registered', manager: UNBOUND_MANAGER })
		} as never)) as { board: unknown };
		expect(stub.calls).toEqual([null]);
		expect(result.board).toEqual(stub.board);
	});

	it('has no action at all — the board is a read surface', () => {
		expect((route as Record<string, unknown>)['actions']).toBeUndefined();
	});

	it('names the destination by id and calls the real guard, not a local phase table', () => {
		expect(SERVER).toContain("'bid-board'");
		expect(SERVER).toContain('requireLiveDestination');
		// The guard call precedes the read in the source as well as at runtime.
		expect(SERVER.indexOf('requireLiveDestination(')).toBeLessThan(SERVER.indexOf('loadBoard('));
		// No second phase table: the catalog is the one source (AD-30).
		expect(SERVER_CODE).not.toMatch(/'Setup'|'Archived'|'Contract Assignment'/);
	});
});

describe('the board page — what it renders', () => {
	it('imports nothing from $lib/server', () => {
		// A `.svelte` file is reachable from the browser bundle; the server-only
		// library must never be.
		expect(PAGE).not.toMatch(/\$lib\/server/);
		expect(PAGE).not.toMatch(/\$env\/(dynamic|static)\/private/);
	});

	it('words nothing of its own — every label and sentence comes from the core', () => {
		expect(PAGE).toContain("from '$lib/core/board.ts'");
		// The furniture and the view-state sentences it prints directly.
		for (const symbol of [
			'BOARD_TITLE',
			'SORT_LABELS',
			'SORT_DIRECTION_LABELS',
			'SORT_DIRECTION_ICONS',
			'BOARD_HIDE_CLOSED_LABEL',
			'BOARD_HIDE_ABOVE_CAP_LABEL',
			'sortSummary',
			'EMPTY_BOARD_HEADING',
			'EMPTY_BOARD_STATEMENT',
			'EMPTY_BOARD_ACTION',
			'boardCountSentence',
			'unbidPhrase'
		]) {
			expect(PAGE, symbol).toContain(symbol);
		}
		// The two state labels and the two icons arrive pre-chosen on the card —
		// `server/board.ts` reads them out of `core/board.ts`'s own records, so
		// the word still originates in `src/lib/core/` and this file prints a
		// field. No literal spelling of any state, count or notice appears here.
		expect(PAGE_CODE).not.toMatch(/You lead|Outbid|Contender|Not involved/);
		expect(PAGE_CODE).not.toMatch(/'Unbid'|Minimum-Bid Contention/);
		expect(PAGE_CODE).not.toMatch(/No opening bid/);
		expect(PAGE_CODE).not.toMatch(/Auctions are (open|hidden)/);
		// Both switch names and both direction words are the core's too — the
		// page prints the constants, never the sentences in them.
		expect(PAGE_CODE).not.toContain(BOARD_HIDE_CLOSED_LABEL);
		expect(PAGE_CODE).not.toContain(BOARD_HIDE_ABOVE_CAP_LABEL);
		expect(PAGE_CODE).not.toMatch(/Highest first|Lowest first|Closing first|A to Z/);
		expect(PAGE_CODE).not.toMatch(/Ascending|Descending/);
		expect(PAGE_CODE).not.toMatch(/h unbid|unbid for/);
	});

	it('renders each state’s icon AND its word — never colour alone', () => {
		// A greyscale screenshot must remain fully readable, and the pairing is
		// what makes it: both fields of both records are read by the template.
		expect(PAGE).toContain('card.auctionStateIcon');
		expect(PAGE).toContain('card.auctionStateLabel');
		expect(PAGE).toContain('card.viewerStateIcon');
		expect(PAGE).toContain('card.viewerStateLabel');
		// And the records themselves cover every state, so no card can render a
		// chip with no word.
		expect(Object.keys(AUCTION_STATE_LABELS).sort()).toEqual(
			Object.keys(AUCTION_STATE_ICONS).sort()
		);
		expect(Object.keys(VIEWER_STATE_LABELS).sort()).toEqual(Object.keys(VIEWER_STATE_ICONS).sort());
	});

	it('gives the lottery bar to Minimum-Bid Contention and to nothing else', () => {
		expect(PAGE).toMatch(/class:lottery=\{card\.state === 'minimum_bid'\}/);
		expect(PAGE).toContain('border-left: var(--accent-bar-width) solid var(--color-lottery)');
		// The device is not borrowed by any other rule in this file.
		expect([...PAGE.matchAll(/--accent-bar-width/g)]).toHaveLength(1);
	});

	it('drops the Outbid chip on a card dismissed from Your Positions', () => {
		expect(PAGE).toContain("from '$lib/client/dismissals.svelte.ts'");
		expect(PAGE).toMatch(/\{#if card\.viewerState !== 'not_involved' && !outbidDismissed\(card\)\}/);
	});

	it('marks Outbid with attention and marks nothing else with it', () => {
		expect(PAGE).toMatch(/\.chip-outbid \{[\s\S]*?--color-attention[\s\S]*?\}/);
		expect(PAGE).toMatch(/--color-attention-ink/);
		// `attention` marks Outbid and nothing else in the entire system.
		const attentionRules = [...PAGE.matchAll(/var\(--color-attention[^)]*\)/g)];
		expect(attentionRules).toHaveLength(2);
		expect(PAGE.indexOf('.chip-lead')).toBeLessThan(PAGE.indexOf('.chip-outbid'));
		// You lead takes its OWN colour — never attention, and never brand,
		// which DESIGN.md:47 forbids from signalling leading.
		expect(PAGE).toMatch(/\.chip-lead \{[\s\S]*?--color-leading[\s\S]*?\}/);
		expect(PAGE).not.toMatch(/\.chip-lead \{[\s\S]*?--color-brand[\s\S]*?\}/);
	});

	it('marks a card the VIEWER leads with the leading edge, and only that viewer', () => {
		// The edge is keyed on `viewerState`, which is computed for the
		// signed-in Manager — so nobody else's board carries the mark.
		expect(PAGE).toMatch(/class:leading=\{card\.viewerState === 'you_lead'\}/);
		expect(PAGE).toContain('border-left: var(--leading-edge-width) solid var(--color-leading)');
		// It is NOT the lottery bar: that 3px device is exclusive to a
		// Minimum-Bid Contention, and the leading rule is declared first so a
		// card that is both takes the lottery bar.
		const leadingBlock = /\.card\.leading \{[\s\S]*?\}/.exec(PAGE)?.[0] ?? '';
		expect(leadingBlock).not.toContain('--accent-bar-width');
		expect(PAGE.indexOf('.card.leading')).toBeLessThan(PAGE.indexOf('.card.lottery'));
		// And it never carries the state alone — the chip beside it has the
		// icon and the word.
		expect(PAGE).toMatch(/class:chip-lead=\{card\.viewerState === 'you_lead'\}/);
	});

	it('gives a chip to You lead and Outbid ONLY — ambient states stay plain', () => {
		// DESIGN.md:194 reserves the chip for the two states that concern the
		// reader: filled `attention` for Outbid, outlined `border-strong` for
		// You lead. Open, Unbid, Contender and Not involved are
		// ambient and take a plain `text-secondary` label with no chip — so
		// the chip keeps meaning "this one is about you" instead of
		// decorating every line on the card.
		expect(PAGE).toMatch(
			/class:chip=\{card\.viewerState === 'you_lead' \|\| card\.viewerState === 'outbid'\}/
		);
		// The Auction state line is never a chip: it describes the Auction,
		// never the reader. It rides the identity row rather than a row of its
		// own — `card-state` is the placement, `state-ambient` is the treatment,
		// and the treatment is what this asserts.
		expect(PAGE).toMatch(/<p class="state state-ambient card-state">/);
		// `not_involved` prints no marker at all: it is the state of most cards
		// on most boards, and the absence already says what a label would.
		expect(PAGE).toMatch(/\{#if card\.viewerState !== 'not_involved'\}/);
		// The ambient treatment is the plain secondary label, with the fill
		// and the outline living only on the two chip rules.
		expect(PAGE).toMatch(/\.state-ambient \{\s*color: var\(--color-text-secondary\);\s*\}/);
		expect(PAGE_CODE).not.toMatch(/chip-contender/);
		// The icon-and-word pairing is NOT what was made conditional: every
		// state, chip or not, still carries both.
		expect(PAGE).toContain('card.viewerStateIcon');
		expect(PAGE).toContain('card.auctionStateIcon');
	});

	it('spells no tokenised value as a literal', () => {
		// Sizes, the touch floor, the strip height, the accent bar and the
		// palette all have tokens; a literal here would be a second source.
		expect(PAGE).not.toMatch(/\b(52|46|44|26|21|19|18|15|13|12\.5|11|10)px\b/);
		expect(PAGE).not.toMatch(/#[0-9a-fA-F]{6}\b/);
		// The only breakpoint permitted is 640px, and this page needs none —
		// every Manager surface is single-column at 375px.
		expect(PAGE).not.toMatch(/@media \(min-width: (?!640px)/);
	});

	it('carries no urgency device of any kind', () => {
		expect(PAGE_CODE).not.toMatch(/ending soon|closing soon|hurry|last chance/i);
		expect(PAGE_CODE).not.toMatch(/animation|pulse|@keyframes/i);
		expect(PAGE_CODE).not.toMatch(/suggest|recommend|worth bidding/i);
		// No one-tap raise: no form, no action, no bid control on this surface.
		expect(PAGE_CODE).not.toMatch(/<form|method="POST"|action="\?\//);
	});

	it('renders time twice, with the absolute stamp derived only inside $effect', () => {
		// `Intl.DateTimeFormat(undefined, ...)` resolves to the formatting
		// machine's timezone, so deriving it during SSR would ship the SERVER's
		// zone in the delivered HTML. It is computed in an effect, which never
		// runs during SSR, and omitted until it exists.
		expect(PAGE).toContain('closesInPhrase');
		expect(PAGE).toContain('Intl.DateTimeFormat');
		const effectStart = PAGE.search(/\$effect\(\(\) => \{\s*const closes/);
		expect(effectStart).toBeGreaterThan(-1);
		expect(PAGE.indexOf('Intl.DateTimeFormat')).toBeLessThan(effectStart);
		expect(PAGE).toMatch(/closesAtAbsolute\[card\.fantraxPlayerId\] !== undefined/);
		expect(PAGE).toMatch(/nominatedAbsolute\[card\.fantraxPlayerId\] !== undefined/);
	});

	it('derives the countdown from the server-authoritative closesAt, never from client arithmetic', () => {
		// The origin is the server's instant and only the elapsed delta is
		// local, so a skewed device crosses a close at the same real moment a
		// correct one does (AD-3). No "seconds remaining" field is ever sent.
		expect(PAGE).toMatch(/parseInstant\(board\.figuresAt\)/);
		expect(PAGE).toMatch(/formatInstant\(anchor \+ elapsedMs\)/);
		expect(PAGE).toMatch(/elapsedMs = Math\.max\(0, Date\.now\(\) - startedAt\)/);
		expect(PAGE_CODE).not.toMatch(/secondsRemaining|remainingSeconds|msRemaining/);
		// Countdowns are exempt from freshness (AD-29) — they derive from the
		// absolute close timestamps this page already holds, so nothing here
		// freezes on a disconnect. The exemption is the COUNTDOWN's, not the
		// page's: the prices carry their age (see the AD-29 test below).
		expect(PAGE).not.toMatch(/freshness\.state[^\n]*closesInPhrase/);
		expect(PAGE).toMatch(/closesInPhrase\(card\.closesAt, nowIso\)/);
		expect(PAGE).toMatch(/const TICK_MS = 1000/);
		expect(PAGE).toMatch(/return \(\) => \{\s*clearInterval\(ticking\);\s*\}/);
	});

	it('carries the age of its prices in anything but Live — AD-29', () => {
		// The board renders up to thirty prices and authorises nothing, so the
		// "disable the control" half of AD-29 has nothing to disable and the
		// "money carries its age" half is the whole obligation. Without this
		// the worst failure AD-29 names is exactly what ships: a stale board
		// that still looks live, read by a Manager deciding where to bid.
		expect(PAGE).toContain('figuresAgeSentence');
		expect(PAGE).toMatch(/freshness\.state === 'live'\s*\?\s*null/);
		expect(PAGE).toMatch(/id="board-figures-age"/);
		// The sentence is the core's, shared with the strip and the notice —
		// an age is worded once in this codebase, not respelled here.
		expect(PAGE).toMatch(/from '\$lib\/core\/freshness\.ts'/);
		// Read from the ONE contract the layout mounts, never derived here.
		expect(PAGE).toMatch(/from '\$lib\/client\/freshness\.svelte\.ts'/);
		expect(PAGE_CODE).not.toMatch(/deriveFreshness/);
	});

	it('shows no clock at all on a nomination with no Opening Bid', () => {
		expect(PAGE).toMatch(/\{#if card\.closesAt === null\}/);
		// The unbid phrase stands where the clock would be, from the core.
		// `?? ''` because `nominatedAt` is nullable now — a closed card has no
		// nomination — and the phrase helper answers an unreadable instant with
		// a stated phrase rather than a throw. A closed card never reaches this
		// branch: it is rendered by the other half of `{#if card.state ===
		// 'closed'}` and carries no clock line at all.
		expect(PAGE).toMatch(/unbidPhrase\(card\.nominatedAt \?\? '', nowIso\)/);
	});

	it('sorts and filters through the core, in the browser, over the transported list', () => {
		expect(PAGE).toMatch(/hideClosed: boardView\.hideClosed/);
		expect(PAGE).toMatch(/hideAboveCap: boardView\.hideAboveCap/);
		// ONE filter call taking both switches and the ceiling, then the sort
		// over its result: the two narrowings compose to a single question and
		// are answered in one place.
		expect(PAGE).toMatch(/filterBoard\(board\.cards, \{/);
		expect(PAGE).toMatch(/sortBoard\(\s*filterBoard\(/);
		// Neither control posts anything or reloads anything.
		expect(PAGE).toMatch(/let sort = \$state<BoardSort>\(DEFAULT_SORT\)/);
		expect(PAGE).toMatch(
			/let direction = \$state<BoardSortDirection>\(DEFAULT_SORT_DIRECTION\[DEFAULT_SORT\]\)/
		);
		expect(PAGE_CODE).not.toMatch(/invalidate|goto\(|fetch\(/);
		// No comparator or predicate of its own — the ordering rules are the
		// core's, so a re-derived list cannot reshuffle differently here.
		expect(PAGE_CODE).not.toMatch(/\.sort\(|localeCompare/);
	});

	it('states the whole board’s count, and the filtered view’s separately', () => {
		// The count sentence is about the WHOLE board; a filtered view states
		// its own, so no figure silently changes when a control is touched.
		// The count is of the OPEN cards, from the core's own `openCardCount`:
		// the sentence beside it says "are open", so counting the closed cards
		// into it would make the one figure on the page false the moment an
		// Auction closes. The filtered notice still measures the whole board.
		expect(PAGE).toMatch(/boardCountSentence\(openCardCount\(board\.cards\)\)/);
		// ONE figure on that line, and nothing else on it at all. A closed count
		// stood beside it and is gone, and so are the switches: on a phone, where
		// this board is read, two sentences took the row onto a second line and a
		// control at the trailing edge dropped off it onto a third.
		expect(PAGE).toContain('<p class="prose" id="board-count">{countSentence}</p>');
		expect(PAGE).not.toContain('closedCountSentence');
		expect(PAGE).not.toContain('board-closed-count');
		// The separate notice line is GONE: it led with the switch's own name
		// and then restated, one row lower, the figure the count line already
		// carried. The `and hidden` half of the closed sentence is what says
		// the switch is on now.
		expect(PAGE).not.toContain('filteredNoticeSentence');
		expect(PAGE).not.toContain('board-filtered-notice');
	});

	it('renders the designed empty screen and points it at Nominate', () => {
		expect(PAGE).toMatch(/\{#if board\.cards\.length === 0\}/);
		expect(PAGE).toContain('id="board-empty"');
		expect(PAGE).toContain('EMPTY_BOARD_HEADING');
		expect(PAGE).toContain('EMPTY_BOARD_STATEMENT');
		expect(PAGE).toMatch(/href="\/nominate"/);
	});

	it('offers no Nominate link on the ARCHIVED empty board — the link would 403', () => {
		// The board is live in two phases and the act exists in only one:
		// `nominate` is absent from the Archived catalog, so the Auction
		// Phase's call to action would answer with `requireLiveDestination`'s
		// 403 — a designed empty state whose one link refuses. The frozen
		// board states what happened and offers nothing.
		expect(PAGE).toMatch(/\{#if data\.phase\.name === 'Archived'\}/);
		expect(PAGE).toContain('ARCHIVED_EMPTY_BOARD_HEADING');
		expect(PAGE).toContain('ARCHIVED_EMPTY_BOARD_STATEMENT');
		// The Archived branch carries no action at all — the `/nominate`
		// anchor lives only in the `:else`, which is the Auction Phase's.
		const archivedBranch = PAGE.slice(
			PAGE.indexOf("{#if data.phase.name === 'Archived'}"),
			PAGE.indexOf('{:else}', PAGE.indexOf("{#if data.phase.name === 'Archived'}"))
		);
		expect(archivedBranch).not.toMatch(/href="\/nominate"/);
		expect(archivedBranch).not.toContain('EMPTY_BOARD_ACTION');
		// And both screens are still the core's words, not the page's.
		expect(PAGE_CODE).not.toMatch(/The Auction Phase is over/);
	});

	it('spells out the fantasy Team with its Manager, and never abbreviates one', () => {
		// The pairing is the server's, rendered through `formatTeamManager` and
		// never reassembled here; a three-letter capital on a card is the NBA
		// team on the metadata line and nothing else.
		expect(PAGE).toContain('card.leadingBidder');
		expect(PAGE).toContain('card.nominatedBy');
		expect(PAGE_CODE).not.toMatch(/formatTeamManager/);
		expect(PAGE_CODE).not.toMatch(/\b[A-Z]{3}\b\s*—/);
	});

	it('PRINTS no per-viewer Maximum Bid — the strip owns that figure', () => {
		// The page derives one, and only to decide which cards to show: the Cap
		// switch has to measure against something, and the something is the
		// strip's own `baselineMaximumBid` over the facts the layout already
		// ships. Nothing about it reaches a card — no figure, no label, no money
		// renderer — so the board still carries no per-card ceiling (AD-7) and
		// there is still exactly one Maximum Bid in this product.
		expect(PAGE_CODE).not.toMatch(/capSpace|evaluate\(/i);
		expect(PAGE_CODE).not.toContain('describeAmount');
		expect(PAGE_CODE).not.toContain('MAXIMUM_BID_LABELS');
		// It is read in the script and never rendered: no `maximumBid` appears
		// anywhere in the markup above the `<style>` block.
		const markup = PAGE.slice(PAGE.indexOf('</script>'), PAGE.indexOf('<style>'));
		expect(markup).not.toContain('maximumBid');
	});

	it('underlines the Player name, because the name is the card’s one control', () => {
		// A link identifiable only by its cursor is not identifiable on a phone.
		// Thickness and offset come from `global.css`'s own `a` rule; the colour
		// stays `text`, so the name reads as the card's identity and not as a
		// call to act.
		const style = PAGE_CODE.slice(PAGE_CODE.indexOf('<style>'));
		expect(style).toMatch(/\.card-link \{[^}]*text-decoration: underline;/);
		expect(style).toMatch(
			/\.card-link \{[^}]*text-decoration-color: var\(--color-text-secondary\);/
		);
		expect(style).not.toMatch(/\.card-link \{[^}]*text-decoration: none;/);
	});

	it('links each card to its own Auction, through the core’s one shape', () => {
		// The literal `/auction/${...}` template that stood here is gone: the
		// deep-link shape is written once in `core/auction-link.ts`, so
		// `/board`, `/positions` and Story 5.3's Discord notification cannot
		// emit three shapes that agree only by coincidence.
		expect(PAGE).toMatch(/href=\{auctionPathFor\(card\.fantraxPlayerId\)\}/);
		expect(PAGE).toContain("from '$lib/core/auction-link.ts'");
		expect(PAGE_CODE).not.toMatch(/`\/auction\//);
	});
});

describe('the board gains no state for a leaderless Auction (Story 10.6)', () => {
	it('renders one treatment for a null leader, with no restarted branch', () => {
		// FR-40 can leave an Auction with no surviving Bid. The card for it is
		// the unbid nomination the board already draws, so this page needed no
		// edit at all — and that is the property worth pinning: no new state,
		// no cancellation vocabulary, no branch on a leader that is null.
		expect(PAGE_CODE.toLowerCase()).not.toContain('restart');
		expect(PAGE_CODE.toLowerCase()).not.toContain('cancel');
		// A null price already has exactly ONE treatment on this page — the
		// unbid nomination's — and a leaderless Auction inherits it rather
		// than adding a second.
		expect(PAGE_CODE.match(/card\.price === null/g)).toHaveLength(1);
		expect(PAGE_CODE).toContain('card-price-absent');
	});
});

describe('the board page — the Closed card', () => {
	/**
	 * The `{#if card.state === 'closed'}` arm, and only that arm.
	 *
	 * Bounded by its own `{:else}` rather than by a comment in the branch after
	 * it: the Closed arm is now the FIRST of the two — it draws its whole body
	 * itself, the open card's price row included in the else — so a slice that
	 * ran to some later landmark would sweep the open card's markup in with it
	 * and every negative assertion below would be testing nothing.
	 */
	const CLOSED_ARM = (() => {
		const opens = "{#if card.state === 'closed'}";
		const from = PAGE.indexOf(opens);
		// Bounded by the `{:else}` at the arm's OWN indentation, found from the
		// arm itself rather than written as a tab count here: the card markup
		// moved a level when it became a snippet, and a hard-coded depth turned
		// this slice into the empty string while every negative assertion below
		// went on passing.
		const depth = PAGE.slice(0, from).split('\n').pop() ?? '';
		return PAGE.slice(from, PAGE.indexOf(`\n${depth}{:else}`, from));
	})();

	it('renders a Closed arm at all, keyed on the card’s own state literal', () => {
		expect(CLOSED_ARM.length).toBeGreaterThan(0);
		expect(PAGE).toContain("{#if card.state === 'closed'}");
	});

	it('states who won, what it went for and where the Player landed', () => {
		// `EXPERIENCE.md:168` asks a Closed state for the winner, the final
		// amount and the Slot placement. All three are pre-worded fields; the
		// surface prints them and words nothing.
		// ANCHORED to its own label rather than asserted as a loose substring of
		// the arm: containment alone would still pass if `card.wonBy` drifted
		// into some other line.
		expect(CLOSED_ARM).toMatch(
			/\{BOARD_WON_BY_LABEL\}<\/span>\s*\{card\.wonBy\}/
		);
		// No placement line: removed as redundant beside the final amount.
		expect(CLOSED_ARM).not.toContain('placementSentence');
		// The figure carries a different WORD here, because a price and a final
		// amount are not the same claim about a number. The Closed arm now draws
		// its own figure rather than sharing the open card's price row — it sits
		// at the card's trailing edge, beside the two lines above — so the word
		// is asserted INSIDE the arm, and the open card's word outside it.
		expect(CLOSED_ARM).toContain('{BOARD_FINAL_LABEL}');
		expect(CLOSED_ARM).not.toContain('BOARD_PRICE_LABEL');
		expect(CLOSED_ARM).toMatch(/\{card\.priceLabel\}/);
		expect(PAGE).toContain('{BOARD_PRICE_LABEL}');
	});

	it('carries NO countdown, NO unbid phrase and NO nominated-by', () => {
		// A closed Auction has no clock — a timer on it would be an urgency
		// device pointed at nothing — and `nominationsReducer` deleted the
		// nomination, so the nominating Team is not durable and is not invented.
		expect(CLOSED_ARM).not.toContain('closesInPhrase');
		expect(CLOSED_ARM).not.toContain('unbidPhrase');
		expect(CLOSED_ARM).not.toContain('BOARD_NOMINATED_LABEL');
		expect(CLOSED_ARM).not.toContain('card.nominatedBy');
		expect(CLOSED_ARM).not.toContain('BOARD_CLOSES_LABEL');
	});

	it('states the closed instant absolutely, in the viewer’s own timezone', () => {
		expect(CLOSED_ARM).toContain('BOARD_CLOSED_AT_LABEL');
		expect(CLOSED_ARM).toContain('closedAtAbsolute[card.fantraxPlayerId]');
		// Derived in an `$effect`, so it never ships the SERVER's timezone in
		// server-rendered HTML — the rule every stamp on this page follows.
		expect(PAGE).toMatch(/closed\[card\.fantraxPlayerId\] = formatAbsolute\(card\.closedAt\)/);
	});

	it('never congratulates — a win is stated', () => {
		// `!==` is the language's, not the copy's, so it is taken out before
		// the sentence-level check — an exclamation mark that survives this is
		// one somebody typed at a Manager.
		const prose = stripComments(CLOSED_ARM).replace(/!==?/g, '');
		expect(prose).not.toMatch(/[!]/);
		expect(prose.toLowerCase()).not.toMatch(/congratulat|trophy|celebrat/);
	});

	it('prints the viewer’s own state BESIDE the amount, not beneath it', () => {
		// The state prints on some closed cards and not others, so stacked it
		// gave a won card an extra line and left a column of closed cards with
		// two heights. On one row every closed card sets the same height, which
		// is what lets the final amounts line up down the board.
		//
		// Asserted as ORDER inside the figure, because containment alone would
		// pass with the two in either arrangement: the state's arm opens before
		// the amount's paragraph.
		const figure = CLOSED_ARM.slice(
			CLOSED_ARM.indexOf('card-closed-figure'),
			CLOSED_ARM.indexOf('{BOARD_FINAL_LABEL}')
		);
		expect(figure).toContain('card.viewerStateLabel');
		// And the row is a row: a column here is what stacked them.
		expect(PAGE).toMatch(/\.card-closed-figure \{[^}]*display: flex;/);
		expect(PAGE).not.toMatch(/\.card-closed-figure \{[^}]*flex-direction: column;/);
	});

	it('sets the closed card’s name and figure in the grey its edge takes', () => {
		// The Player name and the final amount are the two things on any card
		// set in full-strength `text`, which on a closed card made a settled
		// record the brightest ink on the board — shouting over the Auctions a
		// Manager can still act on.
		expect(PAGE).toMatch(
			/\.card\.closed \.card-link,\s*\n\s*\.card\.closed \.card-player,\s*\n\s*\.card\.closed \.card-price \{\s*\n\s*color: var\(--color-text-secondary\);/
		);
		// From the token, never a literal — the same grey the closed edge, the
		// labels and the secondary text already take.
		expect(PAGE).not.toMatch(/#[0-9a-fA-F]{6}\b/);
		// Colour is not carrying the state. The card says it is closed in the
		// state word, in both labelled lines and in its edge, so a greyscale
		// screenshot loses nothing — the rule this whole page is built on.
		// The state word rides the shared identity row above the arm, so it is
		// asserted on the page rather than inside it.
		expect(PAGE).toContain('card.auctionStateLabel');
		expect(CLOSED_ARM).toContain('{BOARD_WON_BY_LABEL}');
		expect(CLOSED_ARM).toContain('{BOARD_CLOSED_AT_LABEL}');
	});
});

describe('the two view controls', () => {
	it('labels the panel in the singular, and each half where its list starts', () => {
		// `Auction`, singular, is the EVENT — the one this league is running,
		// not one of the Auctions counted inside it. A plural here would have
		// been a third label in a column that already says `Open` and `Closed`
		// at the point each list starts, naming lists that do not begin until
		// after the second.
		expect(PAGE).toContain('{BOARD_PANEL_HEADING}');
		expect(PAGE).not.toContain('BOARD_CARDS_HEADING');
		expect(PAGE).toContain('{BOARD_OPEN_HEADING}');
		expect(PAGE).toContain('{BOARD_CLOSED_HEADING}');
		expect(PAGE.indexOf('id="board-panel-heading"')).toBeLessThan(
			PAGE.indexOf('id="board-count"')
		);
		expect(PAGE.indexOf('id="board-open-heading"')).toBeGreaterThan(
			PAGE.indexOf('id="board-count"')
		);
		expect(PAGE.indexOf('id="board-open-heading"')).toBeLessThan(
			PAGE.indexOf('id="board-closed-heading"')
		);
		// All three take the Positions groups' own treatment, from
		// `global.css`'s own class rather than a size or a face respelled here:
		// one heading style for one kind of thing, across the two surfaces a
		// Manager moves between.
		// An `h2`, like the two below it and like `/positions`' own groups.
		// `.section-label` sets no font-weight, so the element decides one: a
		// `<p>` here rendered a shade lighter than the `OPEN` and `CLOSED` it
		// is meant to match, which is what this assertion forecloses.
		expect(PAGE).toMatch(/<h2 class="section-label" id="board-panel-heading">/);
		// And it is wrapped WITH its panel in the shared `group`, so it sits a
		// card gap above it rather than the section gap that divides the blocks
		// of a page — the same closeness `OPEN` and `CLOSED` have to their lists.
		expect(PAGE).toMatch(
			/<section class="group">\s*<h2 class="section-label" id="board-panel-heading">/
		);
		expect(PAGE).toMatch(/<h2 class="section-label" id="board-open-heading">/);
		expect(PAGE).toMatch(/<h2 class="section-label" id="board-closed-heading">/);
		// `display` was tried and does not hold — this page already spends the
		// serif on the masthead above and every Player name below, and a third
		// serif line between them reads as neither title nor furniture.
		expect(PAGE).not.toContain('board-heading"');
		// The `group` shape is `global.css`'s now, shared with `/positions`
		// rather than copied into each page.
		expect(PAGE).not.toMatch(/\n\t\.group \{/);
	});

	it('renders each group only when it HAS cards, and the card once', () => {
		// An empty `CLOSED` on the first morning of the phase would be a label
		// over nothing, and `OPEN` alone over a settled board would be the
		// same. The page's own empty screen covers no cards at all.
		expect(PAGE).toMatch(/\{#if openCards\.length > 0\}/);
		expect(PAGE).toMatch(/\{#if closedCards\.length > 0\}/);
		// Both groups are windows onto the ONE sorted list, partitioned on the
		// card's own state — so the ordering a Manager chose is applied once.
		expect(PAGE).toMatch(
			/const openCards = \$derived\(shown\.filter\(\(card\) => card\.state !== 'closed'\)\)/
		);
		expect(PAGE).toMatch(
			/const closedCards = \$derived\(shown\.filter\(\(card\) => card\.state === 'closed'\)\)/
		);
		// And the card markup exists ONCE, as a snippet both groups render.
		// Two copies of two hundred lines is two places for a chip to be added
		// to one of them.
		expect(PAGE).toContain('{#snippet boardCard(card: BoardCardView)}');
		expect([...PAGE.matchAll(/\{@render boardCard\(card\)\}/g)]).toHaveLength(2);
		expect([...PAGE.matchAll(/\{#if card\.state === 'closed'\}/g)]).toHaveLength(1);
	});

	it('offers every ordering as a radio, from the core’s own key list', () => {
		expect(PAGE).toMatch(/\{#each SORT_KEYS as key \(key\)\}/);
		expect(PAGE).toContain('SORT_LABELS[key]');
		expect([...SORT_KEYS]).toEqual(['closing', 'price', 'name']);
	});

	it('flips the direction when the ordering already in force is tapped again', () => {
		// `onclick`, not `onchange`: a radio already selected fires no `change`
		// event, so the flip — which is by definition a tap on the selected one —
		// would never reach the page. This is the assertion that fails if anybody
		// "tidies" it back to `bind:group`.
		expect(PAGE).toMatch(/onclick=\{\(\) => chooseSort\(key\)\}/);
		expect(PAGE).toMatch(/checked=\{sort === key\}/);
		expect(PAGE_CODE).not.toContain('bind:group={sort}');
		// And the decision itself is one function: same key flips, different key
		// chooses and opens at that key's own default end.
		expect(PAGE).toMatch(/if \(key === sort\) \{\s*direction = flipDirection\(direction\);/);
		expect(PAGE).toMatch(/direction = DEFAULT_SORT_DIRECTION\[key\];/);
	});

	it('states the direction in WORDS beside its arrow, never the arrow alone', () => {
		// The greyscale rule every state on a card follows, applied to the
		// control: an arrow carrying the direction by itself is a shape with no
		// word, and this page has none of those.
		expect(PAGE).toContain('SORT_DIRECTION_LABELS[key][direction]');
		expect(PAGE).toMatch(/\{SORT_DIRECTION_ICONS\[direction\]\}/);
		expect(PAGE).toMatch(/aria-hidden="true">\{SORT_DIRECTION_ICONS\[direction\]\}/);
		// The closed row states both halves too, so a Manager who opens nothing
		// still knows which board they are looking at.
		expect(PAGE).toContain('{sortSummary(sort, direction)}');
	});

	it('is TWO switches for the filters, and both persist across navigation', () => {
		// Five radios in a disclosure became one switch, and a second joined it.
		// Each is a native checkbox with `role="switch"`, so it announces as on
		// or off and keeps the browser's own label, focus ring and Space key.
		expect(PAGE).toContain('id="board-hide-closed"');
		expect(PAGE).toContain('id="board-hide-above-cap"');
		expect([...PAGE.matchAll(/type="checkbox"\s*\n\s*role="switch"/g)]).toHaveLength(2);
		expect(PAGE).toContain('{BOARD_HIDE_CLOSED_LABEL}');
		expect(PAGE).toContain('{BOARD_HIDE_ABOVE_CAP_LABEL}');
		// The box LEADS its name on both — the sort radios' own order directly
		// above, and the reason the two blocks read as one column of controls:
		// every box on this panel starts at the same left edge, so what is set
		// and what is not is one scan down that edge.
		const pairs: readonly (readonly [string, string])[] = [
			['id="board-hide-closed"', '{BOARD_HIDE_CLOSED_LABEL}'],
			['id="board-hide-above-cap"', '{BOARD_HIDE_ABOVE_CAP_LABEL}']
		];
		for (const [id, label] of pairs) {
			expect(PAGE.indexOf(id)).toBeLessThan(PAGE.indexOf(label));
		}
		// The old control is gone entirely — not hidden, gone.
		expect(PAGE).not.toContain('FILTER_KEYS');
		expect(PAGE).not.toContain('name="board-filter"');
		expect(PAGE).not.toContain('board-filter-');
		// They stick because they are held OUTSIDE the component: a `$state` in
		// this file is destroyed with the page, so a setting would last one
		// screen.
		expect(PAGE).toContain("from '$lib/client/board-view.svelte.ts'");
		expect(PAGE).toMatch(/checked=\{boardView\.hideClosed\}/);
		expect(PAGE).toMatch(/boardView\.set\(event\.currentTarget\.checked\)/);
		expect(PAGE).toMatch(/checked=\{boardView\.hideAboveCap\}/);
		expect(PAGE).toMatch(/boardView\.setAboveCap\(event\.currentTarget\.checked\)/);
		// And they are READ in an `$effect`, so storage is never touched during
		// SSR and the server-rendered HTML agrees with the first client paint.
		expect(PAGE).toMatch(/\$effect\(\(\) => \{\s*boardView\.load\(\);\s*\}\);/);
	});

	it('puts both switches BELOW the sort, side by side, off the count sentence', () => {
		// They stood at the trailing edge of the count row, which held one and
		// wrapped at 375px with two. Below the sort — where the filter lived
		// before it became a switch — they are a block of view controls read in
		// the order a Manager sets them: order the board, then narrow it.
		expect(PAGE.indexOf('<div class="switches">')).toBeGreaterThan(
			PAGE.indexOf('<details class="controls-disclosure"')
		);
		expect(PAGE.indexOf('id="board-count"')).toBeLessThan(PAGE.indexOf('<div class="switches">'));
		// The count row is gone as a ROW: the sentence is a bare child of the
		// panel now, with nothing beside it to wrap against.
		expect(PAGE).not.toContain('<div class="panel-top">');
		expect(PAGE).not.toMatch(/\.panel-top \{/);
		// Each switch carries its tap area as padding the BLOCK then cancels,
		// rather than as a touch floor: the checkbox is half the floor's height,
		// so two floored controls were a band of empty panel between the sort
		// and the board. This is `/nominate`'s explainer-mark idiom — the hit
		// area grows, the row does not.
		const switchRule = PAGE.slice(PAGE.indexOf('.switch {'), PAGE.indexOf(".switch input"));
		expect(switchRule).toContain('padding: var(--space-row-gap);');
		expect(switchRule).not.toContain('--touch-min');
		const switchesRule = PAGE.slice(PAGE.indexOf('.switches {'), PAGE.indexOf('.switch {'));
		expect(switchesRule).toContain('margin: calc(-1 * var(--space-row-gap));');
		// SIDE BY SIDE on one line, which is the sort radios' own shape directly
		// above them: stacked, the pair cost a row of a screen whose whole job is
		// the cards beneath it. They wrap only when the two names are wider than
		// the panel — and the two axes are `.controls`' own, because a row gap on
		// top of each switch's own padding stacks two separations where the eye
		// sees one.
		expect(switchesRule).not.toContain('flex-direction: column;');
		expect(switchesRule).toContain('flex-wrap: wrap;');
		expect(switchesRule).toContain('column-gap: var(--space-row-gap);');
		expect(switchesRule).toContain('row-gap: 0;');
		// At the panel's LEADING edge, like the sort radios above and the count
		// sentence above that — nothing on this panel is pushed to the far side,
		// so the boxes and the words that name them start on the one left edge
		// a Manager scans down.
		expect(switchesRule).not.toContain('justify-content');
		// Each box sits beside its OWN name, not pushed to an edge: sharing a
		// line, neither switch has a far edge of its own, and a box driven to one
		// would sit against its neighbour's name.
		const boxRule = PAGE.slice(
			PAGE.indexOf(".switch input[type='checkbox']"),
			PAGE.indexOf('.switch-label')
		);
		expect(boxRule).not.toContain('margin-left: auto;');
		// And the floor is untouched everywhere it belongs — on the controls
		// that spend something. The sort radios still carry it.
		expect(PAGE).toMatch(/\.choice \{[\s\S]*?min-height: var\(--touch-min\);[\s\S]*?\n\t\}/);
	});

	it('offers the Cap switch only where there IS a Maximum Bid, and never derives a second one', () => {
		// The figure is the STRIP's, from the strip's own module, over the facts
		// the layout already ships (AD-7) — the board adds no read, no field on
		// the wire, and no second expression that could print a different
		// number.
		expect(PAGE).toContain("from '$lib/core/strip.ts'");
		expect(PAGE).toMatch(/baselineMaximumBid\(data\.stripTeam, data\.phase\.name, nowIso\)/);
		// Gated on the same phase table the strip gates on: the board is live in
		// Archived too, where no Bid is accepted at any amount and a ceiling
		// would bound nothing. Absent rather than disabled — a switch that could
		// narrow nothing would describe an act it cannot perform.
		expect(PAGE).toMatch(/stripShowsMaximumBid\(data\.phase\.name\)/);
		expect(PAGE).toMatch(/if \(data\.stripTeam === null\) return null;/);
		expect(PAGE).toMatch(/\{#if capSwitchShown\}/);
		// Absent, not disabled: no control on this page carries the attribute.
		expect(PAGE).not.toMatch(/disabled(=|\s*\/?>)/);
		// The derivation is guarded, for `PersistentStrip`'s reason: a throw over
		// an unexpected shape must cost a filter, never the whole board.
		expect(PAGE).toMatch(/\} catch \{\s*return null;\s*\}/);
		// And the figure never reaches the markup — the board prints no per-card
		// Maximum Bid and no ceiling of its own.
		expect(PAGE).not.toContain('{maximumBid}');
		expect(PAGE).not.toContain('describeAmount');
	});
});
