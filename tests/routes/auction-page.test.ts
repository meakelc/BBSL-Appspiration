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
import { BID_READY, bidPlacedNotice, bidRefusalDetail } from '../../src/lib/core/rules/bidding.ts';
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
		expect(PAGE).toMatch(/disabled=\{!control\.available\}/);
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

	it('names no money gate and no capacity gate — those are Stories 2.6 and 2.7', () => {
		for (const forbidden of [
			/maximumBid/i,
			/committedBids/i,
			/minorsExposure/i,
			/rosterReserve/i,
			/roster count/i,
			/no money/i,
			/roster slot/i,
			/cap space/i
		]) {
			expect(PAGE_CODE, String(forbidden)).not.toMatch(forbidden);
		}
	});

	it('shows no suggested amount, no recommended bid and no urgency styling', () => {
		expect(PAGE_CODE).not.toMatch(/suggested/i);
		expect(PAGE_CODE).not.toMatch(/recommended/i);
		expect(PAGE_CODE).not.toMatch(/hurry|act now|running out|urgent/i);
		// The single attention colour in the product marks Outbid and refusal
		// and is Story 2.6's; nothing here reaches for it.
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
		expect(combined).not.toMatch(
			/maximumBid|committedBids|minorsExposure|rosterReserve|Roster Count|no money|roster slot/i
		);
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
