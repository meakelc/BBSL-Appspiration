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
			'FILTER_LABELS',
			'EMPTY_BOARD_HEADING',
			'EMPTY_BOARD_STATEMENT',
			'EMPTY_BOARD_ACTION',
			'boardCountSentence',
			'filteredNoticeSentence',
			'unbidPhrase'
		]) {
			expect(PAGE, symbol).toContain(symbol);
		}
		// The two state labels and the two icons arrive pre-chosen on the card —
		// `server/board.ts` reads them out of `core/board.ts`'s own records, so
		// the word still originates in `src/lib/core/` and this file prints a
		// field. No literal spelling of any state, count or notice appears here.
		expect(PAGE_CODE).not.toMatch(/You lead|Outbid|Contender|Not involved/);
		expect(PAGE_CODE).not.toMatch(/Awaiting Opening Bid|Minimum-Bid Contention/);
		expect(PAGE_CODE).not.toMatch(/No opening bid/);
		expect(PAGE_CODE).not.toMatch(/Auctions are (open|hidden)/);
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
		expect(PAGE).toMatch(/class:lottery=\{card\.contention === 'minimum_bid'\}/);
		expect(PAGE).toContain('border-left: var(--accent-bar-width) solid var(--color-lottery)');
		// The device is not borrowed by any other rule in this file.
		expect([...PAGE.matchAll(/--accent-bar-width/g)]).toHaveLength(1);
	});

	it('marks Outbid with attention and marks nothing else with it', () => {
		expect(PAGE).toMatch(/\.chip-outbid \{[\s\S]*?--color-attention[\s\S]*?\}/);
		expect(PAGE).toMatch(/--color-attention-ink/);
		// `attention` marks Outbid and nothing else in the entire system.
		const attentionRules = [...PAGE.matchAll(/var\(--color-attention[^)]*\)/g)];
		expect(attentionRules).toHaveLength(2);
		expect(PAGE.indexOf('.chip-lead')).toBeLessThan(PAGE.indexOf('.chip-outbid'));
		expect(PAGE).toMatch(/\.chip-lead \{[\s\S]*?--color-border-strong[\s\S]*?\}/);
	});

	it('gives a chip to You lead and Outbid ONLY — ambient states stay plain', () => {
		// DESIGN.md:194 reserves the chip for the two states that concern the
		// reader: filled `attention` for Outbid, outlined `border-strong` for
		// You lead. Open, Awaiting Opening Bid, Contender and Not involved are
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
		expect(PAGE).toMatch(/unbidPhrase\(card\.nominatedAt, nowIso\)/);
	});

	it('sorts and filters through the core, in the browser, over the transported list', () => {
		expect(PAGE).toMatch(/sortBoard\(filterBoard\(board\.cards, filter\), sort, nowIso\)/);
		// Neither control posts anything or reloads anything.
		expect(PAGE).toMatch(/let sort = \$state<BoardSort>\(DEFAULT_SORT\)/);
		expect(PAGE).toMatch(/let filter = \$state<BoardFilter>\(DEFAULT_FILTER\)/);
		expect(PAGE_CODE).not.toMatch(/invalidate|goto\(|fetch\(/);
		// No comparator or predicate of its own — the ordering rules are the
		// core's, so a re-derived list cannot reshuffle differently here.
		expect(PAGE_CODE).not.toMatch(/\.sort\(|localeCompare/);
	});

	it('states the whole board’s count, and the filtered view’s separately', () => {
		// The count sentence is about the WHOLE board; a filtered view states
		// its own, so no figure silently changes when a control is touched.
		expect(PAGE).toMatch(/boardCountSentence\(board\.cards\.length\)/);
		expect(PAGE).toMatch(/filteredNoticeSentence\(filter, shown\.length, board\.cards\.length\)/);
		expect(PAGE).toContain('id="board-filtered-notice"');
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

	it('carries no per-viewer Maximum Bid — the strip owns that figure', () => {
		expect(PAGE_CODE).not.toMatch(/maximumBid|capSpace|evaluate\(/i);
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
