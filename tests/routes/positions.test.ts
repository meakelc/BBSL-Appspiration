/**
 * Your Positions' surface and its `load`, executed (Story 4.4).
 *
 * `vite.config.ts` runs tests under `environment: 'node'` and no `.svelte`
 * file can be rendered under this suite, so the SURFACE assertions are
 * source-text ones in the established pattern — `tests/routes/board.test.ts`'s
 * own idiom, and its own note explains why. Absence claims — no wording of its
 * own, no `$lib/server` import, no tokenised value spelled as a literal — are
 * provable this way and are the whole point.
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

import { GROUP_HEADINGS, POSITIONS_GROUP_ORDER } from '../../src/lib/core/positions.ts';
import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const at = (...parts: string[]): string => join(ROOT, ...parts);

const PAGE = readFileSync(at('src', 'routes', 'positions', '+page.svelte'), 'utf8');
const SERVER = readFileSync(at('src', 'routes', 'positions', '+page.server.ts'), 'utf8');

/**
 * The page with every comment stripped — `tests/structure.test.ts`'s
 * discipline for the reason it states there: prose ABOUT a forbidden thing is
 * not that thing.
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
	positions: {} as Record<string, unknown>,
	/** Every `loadPositions` call, so "was it reached at all?" is answerable. */
	calls: [] as Array<string | null>
}));

vi.mock('$lib/server/positions.ts', () => ({
	loadPositions: async (_gateway: unknown, viewerTeamId: string | null) => {
		stub.calls.push(viewerTeamId);
		return stub.positions;
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

const route = await import('../../src/routes/positions/+page.server.ts');

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

const SETUP_PHASE: ResolvedPhase = {
	name: 'Setup',
	sentence: 'Setup.',
	announcement: null
};
const AUCTION_PHASE: ResolvedPhase = {
	name: 'Auction',
	sentence: 'Auction.',
	announcement: null
};
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
	stub.positions = {
		viewerTeamId: null,
		won: [],
		outbid: [],
		youLead: [],
		contending: [],
		nominationSlot: {
			used: false,
			fantraxPlayerId: null,
			playerName: null,
			sentence: '',
			href: null
		},
		empty: true,
		openAuctionCount: 0,
		figuresAt: '2026-08-27T12:00:00.000Z'
	};
	stub.calls.length = 0;
});

describe('load — the destination guard runs FIRST', () => {
	it('serves the page to a Manager in the Auction Phase', async () => {
		const result = (await route.load({
			locals: locals({ kind: 'registered', manager: MANAGER })
		} as never)) as { positions: unknown; phase: ResolvedPhase };
		expect(result.positions).toEqual(stub.positions);
		expect(result.phase).toEqual(AUCTION_PHASE);
	});

	it('refuses with the guard’s 403 in every phase whose catalog omits your-positions', async () => {
		// `your-positions` is live in the Auction Phase alone
		// (`destinations.ts:73`), so all three other phases refuse — and the
		// refusal is the guard's 403, never a redirect and never an empty page,
		// which would be indistinguishable from a Manager with nothing in play.
		for (const phase of [SETUP_PHASE, ASSIGNMENT_PHASE, ARCHIVED_PHASE]) {
			stub.calls.length = 0;
			await expectRefusal(
				() =>
					route.load({
						locals: locals({ kind: 'registered', manager: MANAGER }, phase)
					} as never),
				LIVE_DESTINATION_REFUSAL_STATUS
			);
			// FIRST, not merely present: the read is never reached.
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
		await route.load({
			locals: locals({ kind: 'registered', manager: MANAGER })
		} as never);
		expect(stub.calls).toEqual(['t-2']);
	});

	it('passes null for a Manager bound to no Team — no group renders against one', async () => {
		await route.load({
			locals: locals({ kind: 'registered', manager: UNBOUND_MANAGER })
		} as never);
		expect(stub.calls).toEqual([null]);
	});

	it('has no action at all — Your Positions is a read surface', () => {
		expect((route as Record<string, unknown>)['actions']).toBeUndefined();
	});

	it('names the destination by id and calls the real guard, not a local phase table', () => {
		expect(SERVER).toContain("'your-positions'");
		expect(SERVER).toContain('requireLiveDestination');
		// The guard call precedes the read in the source as well as at runtime.
		expect(SERVER.indexOf('requireLiveDestination(')).toBeLessThan(
			SERVER.indexOf('loadPositions(')
		);
		// No second phase table: the catalog is the one source (AD-30).
		expect(SERVER_CODE).not.toMatch(/'Setup'|'Archived'|'Contract Assignment'/);
	});
});

describe('the Positions page — what it renders', () => {
	it('imports nothing from $lib/server', () => {
		// A `.svelte` file is reachable from the browser bundle; the
		// server-only library must never be.
		expect(PAGE).not.toMatch(/\$lib\/server/);
		expect(PAGE).not.toMatch(/\$env\/(dynamic|static)\/private/);
	});

	it('words nothing of its own — every label and sentence comes from the core', () => {
		expect(PAGE).toContain("from '$lib/core/positions.ts'");
		for (const symbol of [
			'POSITIONS_TITLE',
			'GROUP_HEADINGS',
			'EMPTY_POSITIONS_HEADING',
			'EMPTY_POSITIONS_STATEMENT',
			'emptyPositionsSentence',
			'POSITIONS_NOMINATE_ACTION',
			'POSITIONS_BOARD_ACTION'
		]) {
			expect(PAGE, symbol).toContain(symbol);
		}
		// No literal spelling of any group heading, state or sentence: the
		// words arrive pre-chosen on the payload and this file prints fields.
		// Asserted over TEXT NODES and quoted strings rather than over the
		// whole source, because `OutbidCardView` is a type name declaring the
		// shape the server sends — an identifier is not a word a Manager reads,
		// and the board's own suite makes the same distinction by never having
		// had one to exclude.
		for (const heading of Object.values(GROUP_HEADINGS)) {
			expect(PAGE_CODE, heading).not.toContain(`>${heading}<`);
		}
		const textNodes = [...PAGE_CODE.matchAll(/>([^<>{}]+)</g)].map((match) => match[1] ?? '');
		const quoted = [...PAGE_CODE.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '');
		for (const candidate of [...textNodes, ...quoted]) {
			expect(candidate).not.toMatch(/You lead|Outbid|Contender|Minimum-Bid Contention/);
			expect(candidate).not.toMatch(/Maximum Bid|cannot re-enter|next legal/i);
			expect(candidate).not.toMatch(/Nomination Slot is|does not oblige/);
		}
		// And no route literal: even the deep link is a field on the card.
		expect(PAGE_CODE).not.toMatch(/`\/auction\//);
	});

	it('renders the five groups in the core’s fixed order and no other', () => {
		// The order IS the answer to the wake-up's question, so it is not a
		// sort and there is no control that changes it. The five section ids
		// appear in the source in exactly the declared sequence.
		const ids = [
			'group-won',
			'group-outbid',
			'group-you-lead',
			'group-contending',
			'group-nomination-slot'
		];
		expect(POSITIONS_GROUP_ORDER).toHaveLength(ids.length);
		let previous = -1;
		for (const id of ids) {
			const index = PAGE.indexOf(`id="${id}"`);
			expect(index, id).toBeGreaterThan(previous);
			previous = index;
		}
		// No sort or filter control of any kind on this surface.
		expect(PAGE_CODE).not.toMatch(/sortBoard|filterBoard|SORT_KEYS|FILTER_KEYS/);
	});

	it('renders each state’s icon AND its word — never colour alone', () => {
		// A greyscale screenshot must remain fully readable, and the pairing is
		// what makes it. Every group that carries a state reads both fields.
		expect([...PAGE.matchAll(/card\.stateIcon/g)].length).toBeGreaterThanOrEqual(3);
		expect([...PAGE.matchAll(/card\.stateLabel/g)].length).toBeGreaterThanOrEqual(3);
	});

	it('gives a chip to Outbid and You lead ONLY — ambient states stay plain', () => {
		// DESIGN.md:194 reserves the chip for the two states that concern the
		// reader: filled `attention` for Outbid, outlined `border-strong` for
		// You lead. A Contender is ambient — it has not been outbid, it is
		// waiting on a draw — and takes a plain label with no chip.
		expect(PAGE).toMatch(/class="state chip chip-outbid"/);
		expect(PAGE).toMatch(/class="state chip chip-lead"/);
		expect(PAGE).toMatch(/class="state state-ambient"/);
		expect(PAGE_CODE).not.toMatch(/chip-contender|chip-won/);
	});

	it('marks Outbid with attention and marks nothing else with it', () => {
		expect(PAGE).toMatch(/\.chip-outbid \{[\s\S]*?--color-attention[\s\S]*?\}/);
		// `attention` marks Outbid and nothing else in the entire system —
		// the fill and its ink, and no third use.
		const attentionRules = [...PAGE.matchAll(/var\(--color-attention[^)]*\)/g)];
		expect(attentionRules).toHaveLength(2);
		expect(PAGE).toMatch(/\.chip-lead \{[\s\S]*?--color-border-strong[\s\S]*?\}/);
	});

	it('gives the lottery bar to Minimum-Bid Contention and to nothing else', () => {
		expect(PAGE).toContain('border-left: var(--accent-bar-width) solid var(--color-lottery)');
		// The device is not borrowed by any other rule in this file.
		expect([...PAGE.matchAll(/--accent-bar-width/g)]).toHaveLength(1);
		// Every Contending card carries it, and an outbid or led lottery
		// carries it too — keyed on the contention state and on nothing else.
		expect(PAGE).toMatch(/class:lottery=\{card\.contention === 'minimum_bid'\}/);
		expect(PAGE).toMatch(/<li class="card lottery">/);
	});

	it('states the re-entry answer and reports BOTH gates on every outbid card', () => {
		// The acceptance criterion: the Manager never taps through to discover
		// that a Player is arithmetically gone. Both gate rows always render —
		// the surface iterates what it is given rather than deciding.
		expect(PAGE).toContain('card.reEntrySentence');
		expect(PAGE).toMatch(/\{#each card\.reEntryGates as gate \(gate\.gate\)\}/);
		expect(PAGE).toContain('gate.chip');
		expect(PAGE).toContain('gate.figure');
		// No conditional hiding a passing gate.
		expect(PAGE_CODE).not.toMatch(/\{#if gate\.passed/);
	});

	it('carries no per-Team Maximum Bid — the strip owns that figure', () => {
		expect(PAGE_CODE).not.toMatch(/maximumBid|capSpace|evaluate\(/i);
	});

	it('carries no urgency device of any kind', () => {
		expect(PAGE_CODE).not.toMatch(/ending soon|closing soon|hurry|last chance/i);
		expect(PAGE_CODE).not.toMatch(/animation|pulse|@keyframes/i);
		expect(PAGE_CODE).not.toMatch(/suggest|recommend|worth bidding|congratul/i);
		// No one-tap raise: no form, no action, no bid control on this surface.
		expect(PAGE_CODE).not.toMatch(/<form|method="POST"|action="\?\//);
	});

	it('derives the absolute stamp only inside $effect', () => {
		// `Intl.DateTimeFormat(undefined, ...)` resolves to the formatting
		// machine's timezone, so deriving it during SSR would ship the SERVER's
		// zone in the delivered HTML. It is computed in an effect, which never
		// runs during SSR, and omitted until it exists.
		expect(PAGE).toContain('Intl.DateTimeFormat');
		const effectStart = PAGE.search(/\$effect\(\(\) => \{\s*const stamps/);
		expect(effectStart).toBeGreaterThan(-1);
		expect(PAGE.indexOf('Intl.DateTimeFormat')).toBeLessThan(effectStart);
		expect(PAGE).toMatch(/absolute\[card\.fantraxPlayerId\] !== undefined/);
	});

	it('derives the countdown from the server-authoritative closesAt', () => {
		// The origin is the server's instant and only the elapsed delta is
		// local, so a skewed device crosses a close at the same real moment a
		// correct one does (AD-3). No "seconds remaining" field is ever sent.
		expect(PAGE).toMatch(/parseInstant\(positions\.figuresAt\)/);
		expect(PAGE).toMatch(/formatInstant\(anchor \+ elapsedMs\)/);
		expect(PAGE).toMatch(/elapsedMs = Math\.max\(0, Date\.now\(\) - startedAt\)/);
		expect(PAGE).toMatch(/closesInPhrase\(card\.closesAt, nowIso\)/);
		expect(PAGE_CODE).not.toMatch(/secondsRemaining|remainingSeconds|msRemaining/);
		expect(PAGE).toMatch(/return \(\) => \{\s*clearInterval\(ticking\);\s*\}/);
	});

	it('carries the age of its figures in anything but Live — AD-29', () => {
		// This page carries more than prices: the re-entry answer is
		// `evaluate()` output over a Cap Space read at `figuresAt`, so a stale
		// page can state that a Bid is within reach when the capital behind it
		// has since been committed elsewhere. Page-level, once — the 4.3 review
		// finding applied here.
		expect(PAGE).toContain('figuresAgeSentence');
		expect(PAGE).toMatch(/freshness\.state === 'live'\s*\?\s*null/);
		expect(PAGE).toMatch(/id="positions-figures-age"/);
		expect(PAGE).toMatch(/from '\$lib\/core\/freshness\.ts'/);
		expect(PAGE).toMatch(/from '\$lib\/client\/freshness\.svelte\.ts'/);
		expect(PAGE_CODE).not.toMatch(/deriveFreshness/);
	});

	it('renders the designed empty screen, pointing at the board and the free Slot', () => {
		expect(PAGE).toMatch(/\{#if positions\.empty\}/);
		expect(PAGE).toContain('id="positions-empty"');
		expect(PAGE).toContain('id="positions-empty-count"');
		expect(PAGE).toContain('id="positions-empty-board"');
		expect(PAGE).toContain('id="positions-empty-nominate"');
	});

	it('links to the full board, which opens unfiltered', () => {
		// The board link carries no query parameter at all: Your Positions is
		// a destination of its own and never a filter on the board.
		expect(PAGE).toContain('id="positions-board-link"');
		expect(PAGE).toMatch(/href=\{BOARD_PATH\}/);
		expect(PAGE_CODE).not.toMatch(/\/board\?/);
	});

	it('spells no tokenised value as a literal', () => {
		// Sizes, the touch floor, the strip height, the accent bar and the
		// palette all have tokens; a literal here would be a second source.
		expect(PAGE).not.toMatch(/\b(52|46|44|26|21|19|18|15|13|12\.5|11|10)px\b/);
		expect(PAGE).not.toMatch(/#[0-9a-fA-F]{6}\b/);
		// Every Manager surface is single-column at 375px; this needs no
		// breakpoint at all.
		expect(PAGE).not.toMatch(/@media \(min-width: (?!640px)/);
	});

	it('spells out the fantasy Team with its Manager, and never abbreviates one', () => {
		// The pairing is the server's, rendered through `formatTeamManager` and
		// never reassembled here; a three-letter capital on a card is the NBA
		// team on the metadata line and nothing else.
		expect(PAGE).toContain('card.leadingBidder');
		expect(PAGE_CODE).not.toMatch(/formatTeamManager/);
		expect(PAGE_CODE).not.toMatch(/\b[A-Z]{3}\b\s*—/);
	});
});
