/**
 * The Auction page's surface, its `load` and its `bid` action, executed
 * (Stories 2.4, 2.5).
 *
 * `vite.config.ts` runs tests under `environment: 'node'` and no `.svelte`
 * file can be rendered under this suite (`tests/signin-surface.test.ts`'s
 * own note states why), so the SURFACE assertions are source-text ones in
 * the established pattern — the regex idiom `tests/structure.test.ts` already
 * uses. Absence claims — no cancel/edit/lower control, no suggested amount,
 * no re-worded refusal — are provable this way and are the whole point.
 *
 * `+page.server.ts` is a different matter and is EXECUTED, the way
 * `tests/routes/nominate.test.ts` executes its own. A source-text check can
 * say the gate call is present; it cannot say it runs first, because
 * `toContain` is not position-aware and would stay green if the read were
 * hoisted above the gate. Only the real `requireLiveDestination` (nothing
 * about it is mocked) driving the real `load` and the real `bid` action
 * proves the ordering, the 403s and the 404.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isHttpError } from '@sveltejs/kit';

import { classifyDeviceClass } from '../../src/lib/core/device-class.ts';
import { formatInstant, parseInstant } from '../../src/lib/core/instant.ts';
import { hasExpired } from '../../src/lib/core/projection/auctions.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	BID_READY,
	bidGateReport,
	bidPlacedNotice,
	bidRefusalDetail,
	bidStateFor,
	evaluate
} from '../../src/lib/core/rules/bidding.ts';
import { PLACE_BID_GATES } from '../../src/lib/core/types.ts';
import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const at = (...parts: string[]): string => join(ROOT, ...parts);

const ROUTE_DIR = ['src', 'routes', 'auction', '[fantraxPlayerId]'];

const PAGE = readFileSync(at(...ROUTE_DIR, '+page.svelte'), 'utf8');
const SERVER = readFileSync(at(...ROUTE_DIR, '+page.server.ts'), 'utf8');

/**
 * The page with every comment stripped — `tests/structure.test.ts`'s own
 * discipline for the same reason it states there: prose ABOUT a forbidden
 * thing is not that thing. This page's header explains at length that no
 * control exists to cancel, edit or lower a Bid, and an absence check run
 * over the raw text would fail on the sentence that promises the absence.
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
	auction: null as unknown,
	outcome: { kind: 'accepted', events: [] as unknown[] } as Record<string, unknown>,
	/** Every `loadAuctionPage` call, so "was it reached at all?" is answerable. */
	calls: [] as Array<{ fantraxPlayerId: string; viewerTeamId: string | null }>,
	/** Every `placeBid` call, for the same reason. */
	bids: [] as Array<{
		actor: { managerId: string; teamId: string; teamName: string };
		fantraxPlayerId: string;
		amount: number;
		deviceClass: string;
	}>
}));

vi.mock('$lib/server/auction-page.ts', () => ({
	loadAuctionPage: async (
		_gateway: unknown,
		fantraxPlayerId: string,
		viewerTeamId: string | null
	) => {
		stub.calls.push({ fantraxPlayerId, viewerTeamId });
		return stub.auction;
	}
}));

vi.mock('$lib/server/bidding.ts', () => ({
	placeBid: async (
		_gateway: unknown,
		actor: { managerId: string; teamId: string; teamName: string },
		fantraxPlayerId: string,
		amount: number,
		deviceClass: string
	) => {
		stub.bids.push({ actor, fantraxPlayerId, amount, deviceClass });
		return stub.outcome;
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

const UNBOUND_MANAGER: RegisteredManager = {
	id: 'm-3',
	discordUserId: '333',
	displayName: 'Bo',
	teamId: null,
	teamName: null,
	isCommissioner: false
};

const SETUP_PHASE: ResolvedPhase = { name: 'Setup', sentence: 'Setup.' };
const AUCTION_PHASE: ResolvedPhase = { name: 'Auction', sentence: 'Auction.' };

const OPEN_AUCTION = {
	fantraxPlayerId: 'p-1',
	playerName: 'Jalen Green',
	metadata: { positions: 'SG', nbaTeam: 'HOU' },
	nominatingTeam: 'Lakers — Meakel',
	nominatedAt: '2026-08-25T19:00:00.000Z',
	contention: 'Standard Contention.',
	price: '$8.5M',
	leadingBidder: 'Rockets — Sam',
	closesAt: '2026-08-27T12:00:00.000Z',
	bids: [
		{
			seq: '3',
			bidder: 'Rockets — Sam',
			amount: '$8.5M',
			occurredAt: '2026-08-26T12:00:00.000Z'
		}
	],
	bidControl: {
		available: true,
		detail: BID_READY,
		minimumLegal: 9_000_000,
		minimumLegalSentence: 'Whole dollars. The least this Auction will take is $9.0M.',
		leadingAmount: 8_500_000,
		leadingTeamId: 't-2',
		viewerTeamId: 't-2'
	}
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

/** A `bid` submission, shaped the way SvelteKit hands one to an action. */
function bidEvent(
	fields: Record<string, string>,
	session: SessionState = { kind: 'registered', manager: MANAGER },
	phase: ResolvedPhase = AUCTION_PHASE,
	headers: Record<string, string> = {}
) {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.append(key, value);
	return {
		request: {
			formData: async () => form,
			headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }
		},
		locals: locals(session, phase),
		params: { fantraxPlayerId: 'p-1' }
	};
}

const bidAction = route.actions.bid as unknown as (event: unknown) => Promise<
	Record<string, unknown>
>;

beforeEach(() => {
	stub.auction = OPEN_AUCTION;
	stub.outcome = {
		kind: 'accepted',
		events: [
			{
				seq: '41',
				occurredAt: '2026-08-26T12:00:00.000Z',
				payload: { closesAt: '2026-08-27T12:00:00.000Z' },
				deviceClass: 'mobile'
			}
		]
	};
	stub.calls.length = 0;
	stub.bids.length = 0;
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

	it('renders the price and the Leading Bidder from the fold, with an honest empty state — AC6', () => {
		expect(PAGE).toContain('auction.price');
		expect(PAGE).toContain('auction.leadingBidder');
		expect(PAGE).toMatch(/No bids yet/);
		expect(PAGE).toMatch(/No bids have been placed yet/);
	});

	it('renders the contention state, worded by the fold that decides it', () => {
		// Every field on the page contract is read by the template; a field
		// shipped and never rendered is dead weight on the wire.
		expect(PAGE).toContain('auction.contention');
		expect(PAGE_CODE).not.toMatch(/Standard Contention|Minimum-Bid Contention/);
	});

	it('renders every Bid in chronological order, each naming its Team and Manager — AC6', () => {
		expect(PAGE).toMatch(/\{#each auction\.bids as bid \(bid\.seq\)\}/);
		expect(PAGE).toContain('bid.bidder');
		expect(PAGE).toContain('bid.amount');
		expect(PAGE).toContain('bid.occurredAt');
		// The server hands the list back already in seq order; the surface
		// must not re-sort it into some other order.
		expect(PAGE).not.toMatch(/auction\.bids\.(sort|reverse|toSorted)/);
	});

	it('renders no anonymity anywhere — every history line carries a named bidder', () => {
		expect(PAGE_CODE).not.toMatch(/anonymous/i);
		expect(PAGE_CODE).not.toMatch(/a rival|someone else/i);
	});

	it('renders the nomination time twice — a relative phrase and an absolute stamp', () => {
		expect(PAGE).toContain('relativePhrase');
		expect(PAGE).toContain('Intl.DateTimeFormat');
		expect(PAGE).toContain('id="auction-nominated-relative"');
		expect(PAGE).toContain('id="auction-nominated-absolute"');
	});

	it('renders the close time twice as well, and never as a duration on the wire — AC6', () => {
		expect(PAGE).toContain('closesInPhrase');
		expect(PAGE).toContain('id="auction-closes-relative"');
		expect(PAGE).toContain('id="auction-closes-absolute"');
		// The server sends an ABSOLUTE instant; the client derives the
		// countdown from it (AD-3). Nothing reads a "seconds remaining" field
		// because none is ever sent.
		expect(PAGE).not.toMatch(/secondsRemaining|remainingSeconds|msRemaining/);
	});

	it('computes both relative phrases through the pure, injected-now helpers', () => {
		expect(PAGE).toContain("from '$lib/core/instant.ts'");
		expect(PAGE).toContain("from '$lib/core/projection/auctions.ts'");
		expect(PAGE).toMatch(/relativePhrase\(auction\.nominatedAt,\s*nowIso\)/);
		expect(PAGE).toMatch(/closesInPhrase\(auction\.closesAt,\s*nowIso\)/);
	});
});

describe('the Auction page — the bid control (AC7)', () => {
	it('renders a pre-filled amount field and a submit beside it', () => {
		expect(PAGE).toMatch(/<input[\s\S]*?name="amount"/);
		expect(PAGE).toMatch(/<button[\s\S]*?type="submit"/);
		expect(PAGE).toContain('control.minimumLegal');
		expect(PAGE).toContain('action="?/bid"');
	});

	it('sizes the control from tokens, at the 46px height on the sunken surface', () => {
		expect(PAGE).toContain('min-height: var(--control-height)');
		expect(PAGE).toContain('background-color: var(--color-surface-sunken)');
		expect(PAGE).toContain('solid var(--color-border-interactive)');
	});

	it('is a two-part act: entering an amount is not bidding it', () => {
		expect(PAGE).toMatch(/name="confirm"/);
		expect(PAGE).toMatch(/type="checkbox"/);
		// The confirmation is one of the inputs the core weighs, so the
		// submit cannot be enabled without it.
		expect(PAGE).toMatch(/bidControlState\(\{[\s\S]*?confirmed[\s\S]*?\}\)/);
	});

	it('disables against the amount actually TYPED, by calling the core — AC7', () => {
		// The failure this replaces: a whole-number shape check enabled the
		// control for `8400000`, and the Manager learned otherwise from the
		// server. The page now asks the same function the read path and the
		// locked transaction ask.
		expect(PAGE).toContain('bidControlState');
		expect(PAGE).toMatch(/amountText:\s*amount/);
		expect(PAGE).toMatch(/blocked = \$derived\(typed\.blocked\)/);
		// The gate facts it evaluates against come from the server, and are
		// re-branded at this boundary rather than cast (AD-8).
		expect(PAGE).toContain('control.leadingAmount');
		expect(PAGE).toContain('control.leadingTeamId');
		expect(PAGE).toContain('parseMoney(control.leadingAmount)');
	});

	it('re-implements no gate arithmetic of its own', () => {
		// No comparison against an increment, a grid or a minimum anywhere in
		// the component: it has two facts and a function that reads them.
		expect(PAGE_CODE).not.toMatch(/500_?000/);
		expect(PAGE_CODE).not.toMatch(/1_?000_?000/);
		expect(PAGE_CODE).not.toMatch(/%\s*(MINIMUM|grid)/i);
		expect(PAGE_CODE).not.toMatch(/isOnMoneyGrid/);
		// And it never re-derives "is this a usable amount" with a regex, the
		// way it used to — `readBidAmount` is the one definition.
		expect(PAGE_CODE).not.toMatch(/test\(amount/);
		expect(PAGE_CODE).toContain('readBidAmount');
	});

	it('reads every field the server ships it — nothing dead on the wire', () => {
		// `available` disables the FIELD on a standing condition; `detail` is
		// the sentence for that condition. A field shipped and never rendered
		// is weight on every page view for nobody's benefit.
		for (const field of [
			'control.available',
			'control.detail',
			'control.minimumLegal',
			'control.minimumLegalSentence',
			'control.leadingAmount',
			'control.leadingTeamId',
			'control.viewerTeamId'
		]) {
			expect(PAGE, field).toContain(field);
		}
	});

	it('disables the field itself, not just the submit, on a standing condition', () => {
		expect(PAGE).toMatch(/disabled=\{!control\.available \|\| expired\}/);
		expect(PAGE).toMatch(/disabled=\{blocked\}/);
	});

	it('states ONE reason beneath the control, never the same refusal twice', () => {
		expect(PAGE).toMatch(/const reason = \$derived\(control\.available \? typed\.detail : control\.detail\)/);
		expect(PAGE).toContain('id="auction-bid-availability">{reason}');
	});

	it('states the disabled reason BENEATH the control, always in the DOM — AC7', () => {
		expect(PAGE).toContain('id="auction-bid-availability"');
		expect(PAGE).toMatch(/aria-describedby="auction-bid-availability"/);
		// Beneath: after the form closes, not before it opens.
		expect(PAGE.indexOf('</form>')).toBeLessThan(PAGE.indexOf('id="auction-bid-availability">'));
		// Unconditional, so the two `aria-describedby` references can never
		// dangle — which is the whole justification for a disabled control's
		// label being exempt from WCAG 1.4.3.
		expect(PAGE).toMatch(/<p class="prose" id="auction-bid-availability">\{reason\}<\/p>/);
	});

	it('words no sentence of its own — every one arrives from the core', () => {
		// The availability line, the consequence and the appended statement
		// are all core functions. A literal here would be a second wording of
		// a rule.
		expect(PAGE_CODE).not.toMatch(/No Bid was placed/);
		expect(PAGE_CODE).not.toMatch(/not a whole multiple/i);
		expect(PAGE_CODE).not.toMatch(/bid against itself/i);
		expect(PAGE_CODE).not.toMatch(/BidPlaced event was appended/);
		expect(PAGE).toContain('bidAppendedSentence(appended.seq)');
		expect(PAGE).toContain('bidConsequenceSentence(');
	});

	it('names the amount being confirmed, not a fixed figure', () => {
		// A deliberate two-part act that never states the dollar amount is
		// the weaker half of the pattern. The consequence tracks the field.
		expect(PAGE).toMatch(/reading\.kind === 'usable' \? reading\.amount : null/);
		expect(PAGE).toMatch(/I confirm this Bid\. \{consequence\}/);
	});

	it('omits the minimum-legal line rather than printing an unrenderable figure', () => {
		expect(PAGE).toMatch(/\{#if control\.minimumLegalSentence !== null\}/);
	});
});

describe('the Auction page — the clock it counts down on (Story 3.1)', () => {
	it('anchors its instant on the SERVER’s, never on the device’s', () => {
		// NFR §5: a skewed client must neither see a different close time nor
		// bid after expiry. Both hold only if the ORIGIN is the server's
		// instant and the device contributes nothing but elapsed time.
		expect(PAGE).toMatch(/parseInstant\(control\.figuresAt\)/);
		expect(PAGE).toMatch(/formatInstant\(anchor \+ elapsedMs\)/);
		// The page used to derive `now` from the device, which froze at load
		// because `$derived(new Date())` depends on nothing reactive. Neither
		// spelling survives.
		expect(PAGE_CODE).not.toMatch(/\$derived\(new Date\(\)/);
		expect(PAGE_CODE).not.toMatch(/new Date\(\)\.toISOString\(\)/);
	});

	it('uses Date.now() for the elapsed DELTA and nothing else', () => {
		// Two readings of the same clock make a duration, which is the one
		// thing a client clock may be trusted with (AD-3, AD-29). Both
		// occurrences are inside the tick, and both are subtracted.
		const uses = [...PAGE_CODE.matchAll(/Date\.now\(\)/g)];
		expect(uses).toHaveLength(2);
		expect(PAGE).toMatch(/const startedAt = Date\.now\(\)/);
		expect(PAGE).toMatch(/elapsedMs = Math\.max\(0, Date\.now\(\) - startedAt\)/);
	});

	it('ticks once a second inside an $effect, and clears the interval', () => {
		const intervals = [...PAGE_CODE.matchAll(/setInterval\(/g)];
		expect(intervals).toHaveLength(1);
		// Inside an effect, so it never runs during SSR — and cleaned up by
		// the function the effect returns, so a re-run cannot leave two.
		const effectStart = PAGE.search(/\$effect\(\(\) => \{\s*void control\.figuresAt;/);
		expect(effectStart).toBeGreaterThan(-1);
		expect(PAGE.indexOf('setInterval(')).toBeGreaterThan(effectStart);
		expect(PAGE).toMatch(/return \(\) => \{\s*clearInterval\(ticking\);\s*\}/);
		// A named constant, not a bare literal buried in the call.
		expect(PAGE).toMatch(/const TICK_MS = 1000/);
		expect(PAGE).toMatch(/\}, TICK_MS\)/);
	});

	it('re-anchors on a fresh server instant rather than adding it to an old count', () => {
		// A refused submit reloads, and `figuresAt` moves with it. The effect
		// depends on it and resets the measurement, so the page can never run
		// ahead of the server by however long the tab had been open.
		expect(PAGE).toMatch(/void control\.figuresAt;\s*elapsedMs = 0;/);
	});

	it('feeds that one instant to both gate calls, and passes the empty string to neither', () => {
		expect(PAGE).toMatch(/now: nowIso/);
		expect(PAGE_CODE).not.toMatch(/now: ''/);
		// `liveGates` takes it positionally as `evaluate`'s third argument, and
		// the page passes `nowIso` exactly twice: once named, once positional.
		expect([...PAGE_CODE.matchAll(/nowIso/g)].length).toBeGreaterThanOrEqual(2);
		expect(PAGE_CODE).toMatch(/nowIso\s*\)\s*\);/);
	});

	it('disables the amount FIELD as the clock runs out, not only the submit', () => {
		// `control.available` is the server's answer at LOAD and cannot change
		// in place, so the field alone would stay typable on the exact case
		// AC6 is about: a tab left open that crosses its close with no update.
		// The submit already follows `nowIso` through `blocked`; the field has
		// to name `expired` to move with it. A clock that has run out is a
		// standing condition no amount will change, which is what that
		// binding is for.
		expect(PAGE).toMatch(/disabled=\{!control\.available \|\| expired\}/);
		// Both controls, and both reachable from the ticking instant: `expired`
		// and `blocked` are each derived from `nowIso`.
		expect(PAGE).toMatch(/disabled=\{blocked\}/);
		expect(PAGE).toMatch(/const blocked = \$derived\(typed\.blocked\)/);
		expect(PAGE).toMatch(/const expired = \$derived\(hasExpired\(auction\.closesAt, nowIso\)\)/);
	});

	it('clamps the elapsed delta at zero, so a backward clock cannot revive an expired Auction', () => {
		// `Date.now()` is a wall clock: an NTP correction or a user changing
		// the system time mid-interval yields a negative delta, which would
		// pull `nowIso` BEHIND the server's anchor and let an expired Auction
		// read as live. The page may run late, never early.
		expect(PAGE).toMatch(/elapsedMs = Math\.max\(0, Date\.now\(\) - startedAt\)/);

		// The same expression the page evaluates, exercised directly: a
		// negative raw delta clamps to the anchor itself, never before it.
		const figuresAt = '2026-08-27T09:00:00.000Z';
		const anchor = parseInstant(figuresAt);
		expect(anchor).not.toBeNull();
		const nowIsoFor = (rawDeltaMs: number) =>
			formatInstant((anchor ?? 0) + Math.max(0, rawDeltaMs));
		expect(nowIsoFor(-3_600_000)).toBe(figuresAt);
		expect(nowIsoFor(-1)).toBe(figuresAt);
		expect(nowIsoFor(0)).toBe(figuresAt);
		// And an Auction already expired at the anchor stays expired however
		// far the device's clock is wound back.
		expect(hasExpired(figuresAt, nowIsoFor(-86_400_000))).toBe(true);
		expect(hasExpired(figuresAt, nowIsoFor(1000))).toBe(true);
	});

	it('ships the absolute close instant into the gate state — never a duration', () => {
		expect(PAGE).toMatch(/closesAt: auction\.closesAt/);
		expect(PAGE_CODE).not.toMatch(/remainingMs|secondsLeft|remainingSeconds/i);
	});

	it('states expiry on the Auction Clock panel, in the core’s words, for every viewer', () => {
		// `hasExpired` is the core's one derivation — the same function the
		// gate calls — and `AUCTION_EXPIRED` is the core's sentence, printed.
		// The statement sits on the panel rather than on the control, so a
		// viewer bound to no Team reads it too.
		expect(PAGE).toMatch(/const expired = \$derived\(hasExpired\(auction\.closesAt, nowIso\)\)/);
		expect(PAGE).toContain('{#if expired}');
		expect(PAGE).toContain('id="auction-expired">{AUCTION_EXPIRED}');
		// Not worded here: the sentence is imported, never spelled.
		expect(PAGE_CODE).not.toMatch(/This Auction expired/);
		// The statement is inside the Auction Clock panel, which is itself
		// conditional on a close instant existing — no clock, no expiry.
		expect(PAGE.indexOf('{#if auction.closesAt !== null}')).toBeLessThan(
			PAGE.indexOf('{#if expired}')
		);
	});

	it('still words no gate — the core hands it every sentence (§Verification)', () => {
		// The seventh gate reached the refusal panel by `PLACE_BID_GATES`
		// growing, exactly as the sixth did, so the vocabulary guards below
		// hold unweakened. This page names no gate field and no gate name.
		for (const forbidden of [
			/evaluatedAt/,
			/Auction Clock ·/,
			/ran out/i,
			/expiry gate/i
		]) {
			expect(PAGE_CODE, String(forbidden)).not.toMatch(forbidden);
		}
	});
});

describe('the Auction page — what it never renders', () => {
	it('offers no control to cancel, edit or lower a Bid — absent, not disabled', () => {
		// Every control on the page, checked by markup rather than by prose:
		// there is exactly one, and it places a Bid.
		const controls = [...PAGE_CODE.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0]);
		expect(controls).toHaveLength(1);
		expect(controls[0]).toContain('type="submit"');
		for (const forbidden of [/cancel/i, /withdraw/i, /\bretract\b/i, /\blower\b/i, /\bamend/i]) {
			expect(PAGE_CODE, String(forbidden)).not.toMatch(forbidden);
		}
	});

	it('words no gate itself — the page renders what the core hands it', () => {
		// Stories 2.6 and 2.7 built the money gate and the capacity gate, and
		// neither needed an edit here: the page prints `bidGateReport`'s rows
		// and `bidControlState`'s sentence. So the vocabulary below is still
		// absent from this file — not because the rules do not exist, but
		// because this file states none of them.
		for (const forbidden of [
			/maximumBid/i,
			/committedBids/i,
			/minorsExposure/i,
			/rosterReserve/i,
			/roster count/i,
			/no money/i,
			/roster slot/i,
			/cap space/i,
			// The `slots` gate's own internals, guarded the same way `cap`'s
			// have been since 2.6. The page never names a gate's fields — it
			// prints `bidGateReport`'s finished rows — and the sixth gate is
			// entitled to the same regression guard as the fifth.
			/projectedAdditions/i,
			/\bceiling\b/i
		]) {
			expect(PAGE_CODE, String(forbidden)).not.toMatch(forbidden);
		}
	});

	it('shows no suggested amount, no recommended bid and no urgency styling', () => {
		expect(PAGE_CODE).not.toMatch(/suggested/i);
		expect(PAGE_CODE).not.toMatch(/recommended/i);
		expect(PAGE_CODE).not.toMatch(/hurry|act now|running out|urgent/i);
		// The single attention colour marks Outbid and refusal and nothing
		// else. Story 2.6 brought the refusal panel, and it lives in its own
		// component — so this page still never reaches for the token, and the
		// one place that does is the one surface entitled to.
		expect(PAGE).not.toContain('--color-attention');
	});

	it('renders no salary figure and no contract-length field — those columns do not exist for a Free Agent', () => {
		expect(PAGE_CODE).not.toMatch(/contract.?length/i);
		expect(PAGE_CODE).not.toMatch(/capHit/i);
		// Money renders through the core's one renderer, on the server. The
		// surface prints the string it is handed and formats nothing.
		expect(PAGE_CODE).not.toMatch(/formatMoney/);
		expect(PAGE_CODE).not.toMatch(/\$\d/);
	});

	it('manual check (Verification section): the forbidden vocabulary is in neither route file', () => {
		const combined = `${PAGE}\n${SERVER}`;
		// Story 2.5 forbade the money vocabulary here because the gate behind
		// it did not exist and a rendered figure would have been invented.
		// Story 2.6 built the gate, so `Maximum Bid` is now rendered — from
		// `capBreakdown()`, whose labels and figures are the core's.
		//
		// Story 2.7 built the capacity gate, so "Roster Capacity" and "no
		// roster slot" are now real wordings — but they are the CORE's, and
		// this check is about what these two route files say for themselves.
		// The sixth chip reached the panel by `PLACE_BID_GATES` growing, with
		// no markup change here, which is exactly what these assertions prove
		// by still holding. Story 2.8 then built the exposure branch, so "no
		// cap limit" IS now a real wording — and it is the core's, reached
		// through `capBreakdown()`. That is precisely why this check survived
		// 2.8 unweakened: the rule exists, and these two files still do not
		// state it.
		// `Overflow Count`, not bare "overflow": the CSS property is not the
		// domain term, and a check that cannot tell them apart would have to
		// be either loosened or worked around the first time a panel needed to
		// clip. The glossary terms are capitalised multi-word names, so
		// matching them as such is the precise test rather than the lucky one.
		expect(combined).not.toMatch(
			/Roster Capacity|no roster slot|no cap limit|unbounded|Overflow Count|Eligible Leading Bid|Minor League Slot/i
		);
		// And no figure is computed here: the surface calls the core and
		// prints what it returns.
		expect(combined).not.toMatch(/const\s+maximumBid\s*=/);
		expect(combined).not.toMatch(/SALARY_CAP|ACTIVE_BENCH_SLOTS/);
	});
});

describe('the Auction page server load — gate, load, 404', () => {
	it('gates on the auction destination before anything else', () => {
		expect(SERVER).toContain(
			"requireLiveDestination(locals.session, locals.phase.name, AUCTION_DESTINATION_ID)"
		);
		expect(SERVER).toContain("AUCTION_DESTINATION_ID = 'auction'");
		// Presence is not order. `toContain` would stay green with the read
		// hoisted above the gate, so the ordering is stated here as well and
		// executed in the suite below.
		expect(SERVER.indexOf('requireLiveDestination(')).toBeLessThan(
			SERVER.indexOf('loadAuctionPage(')
		);
	});

	it('gates the action too — hiding a form is never the check', () => {
		const actionStart = SERVER.indexOf('bid: async');
		expect(actionStart).toBeGreaterThan(-1);
		const action = SERVER.slice(actionStart);
		expect(action).toContain('requireLiveDestination(');
		expect(action.indexOf('requireLiveDestination(')).toBeLessThan(action.indexOf('placeBid('));
	});

	it('404s on a null read rather than rendering an empty Auction', () => {
		expect(SERVER).toMatch(/if \(auction === null\)/);
		expect(SERVER).toMatch(/error\(404,/);
	});

	it('reaches the reader and the writer through writeGateway(), like every other route', () => {
		expect(SERVER).toContain('writeGateway()');
	});

	it('resolves the actor from the session and never from a form field (AD-4)', () => {
		expect(SERVER).toContain('actorFrom(locals.session)');
		expect(SERVER).not.toMatch(/form\.get\(['"](teamId|managerId)['"]\)/);
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
		expect(stub.calls).toEqual([{ fantraxPlayerId: 'p-1', viewerTeamId: 't-2' }]);
	});

	it('passes the viewer’s own Team id, so the control is decided for the right Team — AC7', async () => {
		await route.load({
			locals: locals({ kind: 'registered', manager: UNBOUND_MANAGER }),
			params: { fantraxPlayerId: 'p-1' }
		} as never);
		expect(stub.calls).toEqual([{ fantraxPlayerId: 'p-1', viewerTeamId: null }]);
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

	it('404s on a null read rather than rendering an empty Auction', async () => {
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
		expect(stub.calls).toEqual([{ fantraxPlayerId: 'p-gone', viewerTeamId: 't-2' }]);
	});

	it('passes the id straight from the route param, never from the session', async () => {
		await route.load({
			locals: locals({ kind: 'registered', manager: MANAGER }),
			params: { fantraxPlayerId: 'p-77' }
		} as never);
		expect(stub.calls[0]?.fantraxPlayerId).toBe('p-77');
	});
});

// --- the `bid` action, executed ----------------------------------------

describe('actions.bid — gated the same way, and never the check itself', () => {
	it('places a Bid for a confirmed submission, and reports what landed', async () => {
		const result = await bidAction(bidEvent({ amount: '9000000', confirm: 'yes' }));

		expect(stub.bids).toEqual([
			{
				actor: { managerId: 'm-2', teamId: 't-2', teamName: 'Lakers' },
				fantraxPlayerId: 'p-1',
				amount: 9_000_000,
				deviceClass: 'unknown'
			}
		]);
		// The notice is composed from the core's own statement of what a Bid
		// does, never written by the route.
		expect(result['notice']).toBe(bidPlacedNotice());
		// `seq` and nothing else: the close instant, the timestamp and the
		// device class were shipped and rendered nowhere, and the first two
		// are already on the page because a form action re-runs `load`.
		expect(result['appended']).toEqual({ seq: '41' });
	});

	it('refuses outside the Auction Phase with 403, and never opens a transaction', async () => {
		await expectRefusal(
			() => bidAction(bidEvent({ amount: '9000000', confirm: 'yes' }, undefined, SETUP_PHASE)),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(stub.bids).toEqual([]);
	});

	it('refuses a signed-out session with 403, and never opens a transaction', async () => {
		await expectRefusal(
			() =>
				bidAction(
					bidEvent({ amount: '9000000', confirm: 'yes' }, { kind: 'signed-out' }, AUCTION_PHASE)
				),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(stub.bids).toEqual([]);
	});

	it('refuses an unusable amount with 400, worded by the core, before any transaction opens', async () => {
		for (const amount of ['', '   ', 'abc', '8.5', '8,500,000', '$9000000']) {
			stub.bids.length = 0;
			const result = await bidAction(bidEvent({ amount, confirm: 'yes' }));
			expect(result['status'], amount).toBe(400);
			expect((result['data'] as { notice: string }).notice, amount).toBe(
				bidRefusalDetail({ kind: 'unusable_amount' })
			);
			expect(stub.bids, amount).toEqual([]);
		}
	});

	it('refuses a NEGATIVE amount with its own sentence — it is a whole number of dollars', async () => {
		const result = await bidAction(bidEvent({ amount: '-500000', confirm: 'yes' }));
		expect(result['status']).toBe(400);
		expect((result['data'] as { notice: string }).notice).toBe(
			bidRefusalDetail({ kind: 'negative_amount' })
		);
		expect(stub.bids).toEqual([]);
	});

	it('refuses an unconfirmed submit with 400 — bidding is a deliberate two-part act', async () => {
		const result = await bidAction(bidEvent({ amount: '9000000' }));
		expect(result['status']).toBe(400);
		expect((result['data'] as { notice: string }).notice).toBe(
			bidRefusalDetail({ kind: 'unconfirmed' })
		);
		expect(stub.bids).toEqual([]);
	});

	it('refuses an unbound actor with 400, and never opens a transaction', async () => {
		const result = await bidAction(
			bidEvent({ amount: '9000000', confirm: 'yes' }, { kind: 'registered', manager: UNBOUND_MANAGER })
		);
		expect(result['status']).toBe(400);
		expect((result['data'] as { notice: string }).notice).toBe(
			bidRefusalDetail({ kind: 'unbound_actor' })
		);
		expect(stub.bids).toEqual([]);
	});

	it('classifies the device class from the header, at the transport boundary', async () => {
		const agent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
		await bidAction(
			bidEvent({ amount: '9000000', confirm: 'yes' }, undefined, AUCTION_PHASE, {
				'user-agent': agent
			})
		);
		expect(stub.bids[0]?.deviceClass).toBe(classifyDeviceClass(agent));
		expect(stub.bids[0]?.deviceClass).toBe('mobile');
	});

	it('returns the core’s own sentence on a rejection, at 409 — never one of its own', async () => {
		const refusal = { kind: 'no_open_auction' } as const;
		stub.outcome = {
			kind: 'rejected',
			reason: { refusal, detail: bidRefusalDetail(refusal) }
		};
		const result = await bidAction(bidEvent({ amount: '9000000', confirm: 'yes' }));
		expect(result['status']).toBe(409);
		expect((result['data'] as { notice: string }).notice).toBe(bidRefusalDetail(refusal));
	});

	it('falls back to the stated no-reason sentence when a rejection carries none', async () => {
		stub.outcome = { kind: 'rejected' };
		const result = await bidAction(bidEvent({ amount: '9000000', confirm: 'yes' }));
		expect(result['status']).toBe(409);
		expect((result['data'] as { notice: string }).notice).toBe(
			bidRefusalDetail({ kind: 'unrecorded' })
		);
	});

	it('takes the Team from the session, never from a posted field', async () => {
		await bidAction(
			bidEvent({ amount: '9000000', confirm: 'yes', teamId: 't-999', managerId: 'm-999' })
		);
		expect(stub.bids[0]?.actor).toEqual({ managerId: 'm-2', teamId: 't-2', teamName: 'Lakers' });
	});
});

// --- AC5 carried forward: layout, targets, tokens, greyscale -------------

describe('the Auction page — layout and token discipline', () => {
	it('keeps every interactive target at or above the 44px touch floor', () => {
		// Three targets exist now: the amount field, the submit, and the
		// confirm. Each is sized from a token at or above `--touch-min`.
		expect(PAGE).toContain('min-height: var(--control-height)');
		expect(PAGE).toContain('min-height: var(--touch-min)');
	});

	it('is single-column apart from the one row the control deliberately occupies', () => {
		expect(PAGE).not.toMatch(/display:\s*grid/);
		expect(PAGE).not.toMatch(/grid-template-columns/);
		// The only horizontal pairing: the amount field and its submit. It
		// wraps rather than shrinking below the touch floor at 375px.
		expect(PAGE).toMatch(/\.bid-row \{[\s\S]*?flex-wrap:\s*wrap/);
		expect(PAGE).not.toMatch(/flex-direction:\s*row/);
		expect(PAGE).toMatch(/flex-direction:\s*column/);
	});

	it('styles only through existing design tokens — no raw colour literal anywhere', () => {
		const style = PAGE.slice(PAGE.indexOf('<style>'));
		expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(style).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
		// Every colour, font size and radius is a token reference.
		for (const declaration of style.matchAll(
			/^\s*(?:color|background-color|font-size|font-family|border-radius|accent-color):\s*([^;]+);/gm
		)) {
			expect(declaration[1]?.trim(), declaration[0]).toMatch(/^var\(--[a-z0-9-]+\)$/);
		}
	});

	it('uses a token for every sizing and spacing value, and names the few that have none', () => {
		// The colour check above scanned only colour-ish properties, so a raw
		// `gap: 2px` slipped past it entirely. This one covers the layout
		// properties, and it is an EXACT list rather than a floor: a new
		// literal fails here and has to be justified, which is what stops the
		// token system eroding one declaration at a time.
		const style = PAGE.slice(PAGE.indexOf('<style>'));
		const literals = new Set<string>();
		for (const declaration of style.matchAll(
			/^\s*(?:width|height|min-height|max-width|gap|padding|padding-top|margin|margin-top):\s*([^;]+);/gm
		)) {
			for (const part of (declaration[1] ?? '').trim().split(/\s+/)) {
				if (/^var\(--[a-z0-9-]+\)$/.test(part)) continue;
				if (part === '0' || part === 'auto' || part === '100%') continue;
				literals.add(part);
			}
		}
		// 22px and its 2px optical nudge size a native checkbox's own box;
		// 1px and -1px are the visually-hidden clipping rectangle. Neither has
		// a token in tokens.css, and inventing one is an Ask First item.
		expect([...literals].sort()).toEqual(['-1px', '1px', '22px', '2px'].sort());
	});

	it('conveys no state by colour alone — every fact on the page is a sentence', () => {
		// No conditional class keyed on state anywhere: the price, the
		// Leading Bidder, the clock and the disabled reason are all prose.
		expect(PAGE).not.toMatch(/class=["'][^"']*\{/);
		expect(PAGE).toMatch(/No bids yet\./);
		expect(PAGE).toMatch(/No bids have been placed yet\./);
	});
});

// --- The absolute stamps are the VIEWER's timezone -----------------------

describe('the Auction page — the absolute stamps resolve client-side', () => {
	it('never formats an absolute stamp during SSR, which would use the server timezone', () => {
		// Derived in effects, which run only in the browser — not in a
		// `$derived`, which would also run during server rendering and ship
		// the server's timezone in the delivered HTML.
		expect(PAGE).toMatch(/\$effect\(\(\)\s*=>\s*\{\s*nominatedAbsolute\s*=\s*formatAbsolute\(/);
		expect(PAGE).toMatch(/\$effect\(\(\)\s*=>\s*\{\s*closesAtAbsolute\s*=/);
		expect(PAGE).not.toMatch(/\$derived\([^)]*Intl\.DateTimeFormat/);
	});

	it('guards an unparseable instant rather than throwing RangeError out of format()', () => {
		expect(PAGE).toContain('Number.isNaN(parsed.getTime())');
		// The same stated phrase the pure helper returns for the same input.
		expect(PAGE).toContain("return 'at an unknown time'");
	});

	it('still renders both absolute stamps — omitted before hydration, never dropped for space', () => {
		expect(PAGE).toContain('id="auction-nominated-absolute"');
		expect(PAGE).toContain('id="auction-closes-absolute"');
		expect(PAGE).toMatch(/\{#if nominatedAbsolute !== null\}/);
		expect(PAGE).toMatch(/\{#if closesAtAbsolute !== null\}/);
	});
});

// --- Story 2.6: the refusal panel and the Maximum Bid breakdown ------------

const PANEL = readFileSync(at('src', 'lib', 'components', 'RefusalPanel.svelte'), 'utf8');
// Prose ABOUT a forbidden thing is not that thing - the same discipline
// `PAGE_CODE` applies above. This component's header explains at length why it
// uses `role="alert"` rather than `role="status"`, why there is no `<details>`
// and why no red appears, and an absence check run over the raw text would fail
// on every sentence that promises the absence.
const PANEL_CODE = stripComments(PANEL);

const BREAKDOWN = readFileSync(at('src', 'lib', 'components', 'CapBreakdown.svelte'), 'utf8');

describe('the refusal panel — the only surface with a dedicated anatomy', () => {
	it('is the one place in the product with a top accent bar, in attention', () => {
		expect(PANEL).toContain('border-top: var(--accent-bar-width) solid var(--color-attention)');
		// Nothing else may borrow the device. The page that renders the panel
		// still never reaches for the token itself.
		expect(PAGE).not.toContain('--color-attention');
	});

	it('presents the six parts in EXPERIENCE.md order', () => {
		// All six, in order. An earlier version of this test checked four and
		// would have stayed green while the reassurance drifted above the
		// delta — the two shared a CSS class at the time, which is exactly the
		// kind of slip a partial order check cannot see.
		const order = [
			'refusal-headline',
			'refusal-delta',
			'refusal-reassurance',
			'class="gates"',
			'class="arithmetic"',
			'class="caption"'
		];
		let cursor = -1;
		for (const marker of order) {
			const found = PANEL.indexOf(marker);
			expect(found, marker).toBeGreaterThan(cursor);
			cursor = found;
		}
		// The control and its reason are the markup that FOLLOWS the panel on
		// the page — part six, and the reason the panel does not render one.
		expect(PANEL_CODE).not.toContain('<form');
		expect(PANEL_CODE).not.toContain('<button');
		expect(PAGE.indexOf('<RefusalPanel')).toBeLessThan(PAGE.indexOf('<form method="POST"'));
		expect(PAGE.indexOf('<form method="POST"')).toBeLessThan(
			PAGE.indexOf('id="auction-bid-availability">{reason}')
		);
	});

	it('gives the delta and the reassurance separate classes — they are separate parts', () => {
		// One shared class would let a styling change aimed at "the delta"
		// silently restyle the reassurance, and would make the order check
		// above unable to tell the two apart.
		expect(PANEL_CODE).toContain('class="refusal-delta"');
		expect(PANEL_CODE).toContain('class="refusal-reassurance"');
	});

	it('takes focus when it appears, so a full page load announces it', () => {
		// `role="alert"` alone is not enough: this form posts without
		// `use:enhance`, so a refusal arrives as a full page load and the
		// panel is in the document at parse time — and a live region that
		// already exists when a screen reader registers it is not reliably
		// announced, because announcement fires on MUTATION.
		expect(PANEL_CODE).toContain('tabindex="-1"');
		expect(PANEL_CODE).toContain('bind:this={panel}');
		expect(PANEL_CODE).toContain('panel?.focus()');
	});

	it('renders for a refusal that has no arithmetic at all', () => {
		// The matrix says "any refused submit" — a mis-typed amount deserves
		// the same surface as an overrun cap. The gate list and the breakdown
		// are what fall away, not the panel.
		expect(PANEL_CODE).toContain('{#if gates.length > 0}');
		expect(PANEL_CODE).toContain('{#if breakdown.length > 0}');
		expect(PAGE_CODE).toContain('{#if refusalDelta !== null}');
	});

	it('takes the chip text from the core, and does not word the outcome itself', () => {
		expect(PANEL_CODE).toContain('{row.chip}');
		expect(PANEL_CODE).not.toMatch(/'Passed'|'Refused'|Passed\s*:\s*|·/);
	});

	it('sets the headline in the display face at 19px, per the anatomy table', () => {
		expect(PANEL).toMatch(/\.refusal-headline\s*\{[^}]*--font-display/);
		expect(PANEL).toMatch(/\.refusal-headline\s*\{[^}]*--size-19/);
	});

	it('distinguishes the gates by FILL, so the difference survives greyscale', () => {
		// The passing chip is outlined and the refusing chip filled. A colour
		// difference alone would fail exactly the colourblind manager the
		// design exists to protect.
		expect(PANEL).toMatch(/\.chip\s*\{[^}]*border:\s*var\(--border-width\) solid/);
		expect(PANEL).toMatch(/\.chip\.refused\s*\{[^}]*background:\s*var\(--color-attention\)/);
		expect(PANEL).toMatch(/\.chip\.refused\s*\{[^}]*color:\s*var\(--color-attention-ink\)/);
	});

	it('announces itself to assistive technology rather than merely rendering', () => {
		// `alert`, not `status`: a refusal is assertive, and it must be
		// ANNOUNCED as it appears.
		expect(PANEL).toContain('role="alert"');
		expect(PANEL_CODE).not.toContain('role="status"');
	});

	it('puts the arithmetic behind no disclosure', () => {
		expect(PANEL_CODE).not.toContain('<details');
		expect(PANEL_CODE).not.toContain('<summary');
		expect(PANEL_CODE).not.toMatch(/show (the )?(working|maths|math|arithmetic)/i);
	});

	it('uses no red, and no raw colour of any kind', () => {
		expect(PANEL_CODE).not.toMatch(/#[0-9a-f]{3,8}\b/i);
		expect(PANEL_CODE).not.toMatch(/\b(red|crimson|#ff0000|rgb\()/i);
	});

	it('grew a sixth row for the capacity gate with no markup change (Story 2.7)', () => {
		// The claim the Code Map made and this test is here to PROVE rather
		// than assert: the panel `{#each}`es whatever `bidGateReport` returns,
		// and that function maps `PLACE_BID_GATES` — so declaring `slots`
		// was the whole change and no component or route was edited.
		expect(PANEL_CODE).toContain('{#each gates as row (row.gate)}');
		expect(PANEL_CODE).not.toContain("'cap'");
		expect(PANEL_CODE).not.toContain("'slots'");

		// A Team at Roster Count 12 with $40.0M spare — refused on capacity,
		// passed on money — rendered as the rows the panel would receive.
		const rows = bidGateReport(
			evaluate(
				bidStateFor(null, {
					capSpace: parseMoney(40_000_000),
					rosterCount: 12,
					leading: [],
					// Story 2.8: no eligible leads and no occupied Minor League
					// Slots, so `N` is the bid alone and `M` is the full three.
					eligibleLeading: [],
					minorLeagueOccupied: 0
				}, false),
				{
					kind: 'PlaceBid',
					fantraxPlayerId: 'p-1',
					teamId: 't-r',
					teamName: 'Team R',
					managerId: 'm-r',
					amount: parseMoney(5_000_000)
				},
				'2026-08-27T09:00:00.000Z'
			)
		);

		expect(rows).toHaveLength(PLACE_BID_GATES.length);
		// Seven since Story 3.1. The literal is kept beside the derived length
		// deliberately: it is what notices a gate arriving without anybody
		// deciding to add one.
		expect(rows).toHaveLength(7);
		expect(rows.map((row) => row.gate)).toEqual([...PLACE_BID_GATES]);
		// The refusing row is filled — `class:refused={!row.passed}` — and
		// every other row is outlined and carries its own figure.
		expect(rows.filter((row) => !row.passed).map((row) => row.gate)).toEqual(['slots']);
		for (const row of rows) {
			expect(row.figure.length, row.gate).toBeGreaterThan(0);
			expect(row.chip, row.gate).toContain('·');
		}
	});

	it('words nothing of its own — every sentence comes from the core', () => {
		expect(PANEL).toContain("from '$lib/core/rules/bidding.ts'");
		expect(PANEL).toContain('REFUSAL_HEADLINE');
		expect(PANEL).toContain('REFUSAL_REASSURANCE');
		// No money is formatted here, and no figure is computed here.
		expect(PANEL_CODE).not.toMatch(/formatMoney|parseMoney|\$\d/);
	});
});

describe('the Maximum Bid breakdown on the page', () => {
	it('renders the components rather than a bare number', () => {
		expect(PAGE).toContain('capBreakdown(');
		expect(PAGE).toContain('id="auction-maximum-bid"');
		// The labels and figures are the core's; the column prints rows.
		expect(BREAKDOWN).toContain('{line.label}');
		expect(BREAKDOWN).toContain('{line.figure}');
	});

	it('is ONE column definition, shared by the page and the refusal panel', () => {
		// A Manager who reads the standing figures and then reads a refusal
		// must see the same ledger, or the refusal looks like a different
		// claim about a different thing. Two copies could drift into exactly
		// that.
		expect(PAGE).toContain("import CapBreakdown from '$lib/components/CapBreakdown.svelte'");
		expect(PANEL).toContain("import CapBreakdown from './CapBreakdown.svelte'");
		// Neither surface keeps a private copy of the column's markup or CSS.
		expect(PAGE_CODE).not.toContain('class="breakdown"');
		expect(PANEL_CODE).not.toContain('class="breakdown"');
	});

	it('lets a detail row wrap rather than pushing the column into a scroll', () => {
		// A detail row carries a sentence, not a figure, and cannot sit on one
		// line beside its label at 375px. Hiding the arithmetic behind a
		// horizontal scroll on the most important surface in the product is
		// the failure this prevents.
		expect(BREAKDOWN).toMatch(/\.line\.detail\s*\{[^}]*flex-wrap:\s*wrap/);
		expect(BREAKDOWN).toMatch(/\.line\.detail dd\s*\{[^}]*white-space:\s*normal/);
	});

	it('formats no money and computes nothing of its own', () => {
		expect(stripComments(BREAKDOWN)).not.toMatch(/formatMoney|parseMoney|Math\.|\$\d/);
	});

	it('re-derives through evaluate() on every keystroke, and caches no figure', () => {
		// AD-7: derived money is never cached client-side for validation. The
		// page holds the INPUTS and calls the core; it never receives a
		// `maximumBid` to compare against.
		expect(PAGE).toContain('evaluate(');
		expect(PAGE).toMatch(/capSpace:\s*parseMoney\(/);
		expect(PAGE_CODE).not.toMatch(/maximumBid:\s*\w/);
	});

	it('omits the whole panel for a viewer bound to no Team', () => {
		expect(PAGE).toContain('{#if standingBreakdown.length > 0}');
	});
});

describe('the bid action — a refusal carries the figures it was judged against', () => {
	/** A gate set shaped as the locked transaction would return it. */
	const REFUSED_GATES = {
		// Story 3.1's seventh gate, passing: this Auction's clock has not run
		// out, and the money is the only obstacle. The route passes the whole
		// set through untouched whatever is in it.
		expiry: { passed: true, closesAt: '2026-08-28T02:14:00.000Z', evaluatedAt: '2026-08-27T02:14:00.000Z' },
		opening: {
			passed: true,
			opening: 'not_an_opening',
			offered: 10_500_000,
			minimumOpening: 1_000_000
		},
		selfBid: { passed: true, actingTeamId: 't-2', leadingTeamId: 't-9' },
		increment: {
			passed: true,
			offered: 10_500_000,
			currentHigh: 8_500_000,
			minimumLegal: 9_000_000
		},
		granularity: { passed: true, offered: 10_500_000, grid: 500_000 },
		cap: {
			passed: false,
			offered: 10_500_000,
			capSpace: 12_000_000,
			committedBids: 0,
			minorsExposure: 0,
			availableCapSpace: 12_000_000,
			rosterCount: 9,
			projectedAdditions: 1,
			rosterReserve: 2_000_000,
			maximumBid: 10_000_000,
			// Story 2.8's exposure figures, present on the shape the
			// transaction returns whether or not anything overflowed.
			freeMinorLeagueSlots: 3,
			eligibleLeadingBids: 0,
			overflowCount: 0,
			unbounded: false,
			exposingBids: []
		},
		// The capacity gate passes and reports anyway (Story 2.7): the money
		// is the only obstacle, and the panel says so rather than leaving a
		// reader to wonder what else was not checked.
		slots: {
			passed: true,
			rosterCount: 9,
			projectedAdditions: 1,
			ceiling: 12,
			freeMinorLeagueSlots: 3,
			eligibleLeadingBids: 0,
			overflowCount: 0
		}
	};

	const TRANSACTION_CLOCK = '2026-08-27T02:14:00.000Z';

	it('passes the transaction gate set and its clock through untouched', async () => {
		stub.outcome = {
			kind: 'rejected',
			reason: {
				refusal: { kind: 'gates', gates: REFUSED_GATES },
				detail: 'No Bid was placed. …',
				gates: REFUSED_GATES,
				at: TRANSACTION_CLOCK
			}
		};

		const result = await bidAction(bidEvent({ amount: '10500000', confirm: 'yes' }));
		const data = result['data'] as { gates: unknown; figuresAt: unknown; delta: string };

		// FR-13: refused with the CURRENT figures shown — the ones the locked
		// transaction judged the Bid against, not the ones the page rendered.
		expect(data.gates).toBe(REFUSED_GATES);
		expect(data.figuresAt).toBe(TRANSACTION_CLOCK);
		expect(result['status']).toBe(409);
	});

	it('sends no arithmetic for a refusal that has none', async () => {
		stub.outcome = {
			kind: 'rejected',
			reason: {
				refusal: { kind: 'no_open_auction' },
				detail: 'No Bid was placed: there is no open Auction for this Player.',
				gates: null,
				at: null
			}
		};

		const result = await bidAction(bidEvent({ amount: '10500000', confirm: 'yes' }));
		const data = result['data'] as { gates: unknown; figuresAt: unknown; delta: string };

		// A panel handed empty figures would print a breakdown of nothing.
		expect(data.gates).toBeNull();
		expect(data.figuresAt).toBeNull();
		// But it still gets a sentence, so the panel renders. The matrix
		// requires it on ANY refused submit.
		expect(data.delta.length).toBeGreaterThan(20);
	});

	it('words the refusal in the core, never in the route', async () => {
		// The route reads `detail` off the rejection and never composes one.
		expect(SERVER_CODE).not.toMatch(/Maximum Bid|exceeds your/);
		expect(SERVER_CODE).toContain('rejection?.gates ?? null');
		expect(SERVER_CODE).toContain('rejection?.at ?? null');
		// Both strings come from the core, through one helper.
		expect(SERVER_CODE).toContain('bidRefusalDetail(refusal)');
		expect(SERVER_CODE).toContain('bidRefusalDelta(refusal)');
	});
});
