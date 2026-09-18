/**
 * The persistent strip (Story 4.2).
 *
 * Every row of the I/O matrix is driven through `src/lib/core/strip.ts`,
 * which is where the phase table, the baseline derivation and every word the
 * strip says live. The surface claims are source-text assertions, in the
 * convention `tests/structure.test.ts:281-291` and `tests/freshness.test.ts`
 * already use: `vite.config.ts` pins `environment: 'node'` and no `.svelte`
 * file is renderable under this suite, so "renders `DestinationsList`",
 * "consumes `--strip-height`" and "contains no 52px literal" are properties of
 * the text rather than of a render — which is exactly as strong as a rendered
 * assertion for the absence claims, and the point of them.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTIVE_BENCH_SLOTS, NO_AUCTION_PROBE_ID, SALARY_CAP } from '../src/lib/core/constants.ts';
import { MAXIMUM_BID_LABELS } from '../src/lib/core/freshness.ts';
import { formatMoney, parseMoney } from '../src/lib/core/money.ts';
import type { Money } from '../src/lib/core/money.ts';
import { INITIAL_AUCTIONS, auctionsReducer, BID_PLACED_EVENT } from '../src/lib/core/projection/auctions.ts';
import { fold } from '../src/lib/core/projection/fold.ts';
import type { LeaguePhase } from '../src/lib/core/projection/phase.ts';
import { outstandingBidFiguresFor, teamMoneyStateFor } from '../src/lib/core/rules/bidding.ts';
import type { TeamMoneyState } from '../src/lib/core/rules/bidding.ts';
import {
	STRIP_REGION_LABEL,
	STRIP_SHEET_LABEL,
	baselineCapOutcome,
	baselineMaximumBid,
	contentionEntriesSentence,
	outstandingBidLines,
	outstandingBidsSentence,
	rosterCountSentence,
	stripPresent,
	stripShowsMaximumBid,
	stripShowsOutstandingBids
} from '../src/lib/core/strip.ts';
import type { AppendedEvent } from '../src/lib/core/types.ts';
import { loadStripTeam } from '../src/lib/server/strip.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');

const STRIP = read('src', 'lib', 'components', 'PersistentStrip.svelte');
const LAYOUT = read('src', 'routes', '+layout.svelte');
const LAYOUT_SERVER = read('src', 'routes', '+layout.server.ts');
const CORE_STRIP = read('src', 'lib', 'core', 'strip.ts');
const SERVER_STRIP = read('src', 'lib', 'server', 'strip.ts');
const GLOBAL_CSS = read('src', 'lib', 'styles', 'global.css');
const TOKENS_CSS = read('src', 'lib', 'styles', 'tokens.css');

/**
 * A source with its comments stripped.
 *
 * `tests/structure.test.ts` and `tests/layout.test.ts` both do this for the
 * same reason: prose ABOUT a construct is not that construct. Every file here
 * explains at length why no figure is memoised, why the 52px literal is
 * forbidden and why no `maximumBid` crosses the wire — and a text search for
 * an absence would otherwise find the explanation of it.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/(^|[^:/])\/\/[^\n]*/g, '$1');
}

const STRIP_MARKUP = stripComments(STRIP);
const LAYOUT_CODE = stripComments(LAYOUT);
const LAYOUT_SERVER_CODE = stripComments(LAYOUT_SERVER);
const CORE_STRIP_MARKUP = stripComments(CORE_STRIP);
const SERVER_STRIP_MARKUP = stripComments(SERVER_STRIP);
const GLOBAL_CSS_CODE = stripComments(GLOBAL_CSS);
const TOKENS_CSS_CODE = stripComments(TOKENS_CSS);

const NOW = '2026-09-01T12:00:00.000Z';

/** A Team with nothing committed anywhere — the plain case. */
function teamWith(overrides: Partial<TeamMoneyState> = {}): TeamMoneyState {
	return {
		capSpace: parseMoney(SALARY_CAP),
		rosterCount: 9,
		leading: [],
		eligibleLeading: [],
		minorLeagueOccupied: 0,
		...overrides
	};
}

/** A `BidPlaced` row, as the shell appends one. */
function bid(seq: number, fantraxPlayerId: string, teamId: string, amount: number): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt: '2026-09-01T09:00:00.000Z',
		schemaVersion: 1,
		coreVersion: 1,
		type: BID_PLACED_EVENT,
		payload: {
			fantraxPlayerId,
			teamId,
			teamName: teamId,
			managerId: 'm-1',
			amount,
			closesAt: '2026-09-02T09:00:00.000Z'
		},
		managerId: 'm-1',
		teamId,
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

// --- The phase table -------------------------------------------------------

describe('the phase table — one place, every row of the matrix', () => {
	it('renders no strip at all in Setup', () => {
		// No roster has been promoted, so there is no count to state. A
		// `Roster 0 of 12` there would describe a Team whose roster has not
		// arrived rather than one that is empty.
		expect(stripPresent('Setup')).toBe(false);
	});

	it.each<LeaguePhase>(['Auction', 'Contract Assignment', 'Archived'])(
		'renders the strip in %s',
		(phase: LeaguePhase) => {
			expect(stripPresent(phase)).toBe(true);
		}
	);

	it('states Maximum Bid only in the Auction Phase', () => {
		expect(stripShowsMaximumBid('Auction')).toBe(true);
		// Contract Assignment and Archived carry the Roster Count alone: no
		// Bid is accepted at any amount, so a ceiling on bidding bounds
		// nothing. Contract Assignment's assignment progress is Story 6.1's —
		// the Year Allotment it would report against does not exist.
		expect(stripShowsMaximumBid('Contract Assignment')).toBe(false);
		expect(stripShowsMaximumBid('Archived')).toBe(false);
		expect(stripShowsMaximumBid('Setup')).toBe(false);
	});

	it('states the bids figure only in the Auction Phase', () => {
		// Outstanding Bids against the allowance is a figure about placing a
		// Bid, and outside the Auction Phase no Bid is accepted at any amount
		// — so `0 of 3 bids` in Archived would state something about
		// outstanding Bids in a phase where none can exist. The Roster Count
		// beside it stays: a Roster Count is true in every phase that has a
		// roster, which is what "the Roster Count alone" means.
		expect(stripShowsOutstandingBids('Auction')).toBe(true);
		expect(stripShowsOutstandingBids('Contract Assignment')).toBe(false);
		expect(stripShowsOutstandingBids('Archived')).toBe(false);
		// Setup is unchanged and is decided one level up: no strip renders
		// there at all, so this predicate is never reached.
		expect(stripShowsOutstandingBids('Setup')).toBe(false);
		expect(stripPresent('Setup')).toBe(false);
	});

	it('is its OWN predicate, never the money half read a second time', () => {
		// The two agree today and that is a coincidence of the rules rather
		// than a shared meaning: `stripShowsMaximumBid` is named for the money
		// half and is where Story 6.1's Contract Assignment figure would land.
		// Two declarations, and the surface calls the capacity one.
		expect(CORE_STRIP.match(/^export function stripShowsOutstandingBids/gm)).toHaveLength(1);
		expect(STRIP_MARKUP).toContain('stripShowsOutstandingBids(phase)');
		expect(STRIP_MARKUP.match(/stripShowsMaximumBid\(/g)).toHaveLength(1);
	});
});

// --- The Roster Count sentence ---------------------------------------------

describe('the Roster Count sentence', () => {
	it('states the count against ACTIVE_BENCH_SLOTS, never a literal twelve', () => {
		expect(rosterCountSentence(9)).toBe(`Roster 9 of ${String(ACTIVE_BENCH_SLOTS)}`);
		expect(rosterCountSentence(9)).toBe('Roster 9 of 12');
	});

	it('states a full roster and an empty one alike, without a special case', () => {
		expect(rosterCountSentence(0)).toBe('Roster 0 of 12');
		expect(rosterCountSentence(12)).toBe('Roster 12 of 12');
	});

	it('states an OVERFLOWING roster as the overflow it is, never clamped to twelve', () => {
		// A Team can genuinely hold more than ACTIVE_BENCH_SLOTS — that is
		// what `overflowCount` exists for — so `Roster 13 of 12` is a true
		// sentence about a real state. Clamping it would hide the overflow
		// from the one Manager who has to resolve it, exactly as clamping a
		// negative Maximum Bid to $0.0M would.
		expect(rosterCountSentence(13)).toBe('Roster 13 of 12');
		expect(rosterCountSentence(15)).toBe('Roster 15 of 12');
	});

	it('floors a corrupt negative count rather than stating a nonsense sentence', () => {
		// Unlike an overflow, a negative count is not a state the app can
		// reach — it is a bad read. `Roster -1 of 12` tells a Manager nothing
		// true and nothing actionable.
		expect(rosterCountSentence(-1)).toBe('Roster 0 of 12');
		expect(rosterCountSentence(Number.NaN)).toBe('Roster 0 of 12');
	});

	it('is built from the constant, so the twelve cannot be spelled twice', () => {
		expect(CORE_STRIP).toContain('ACTIVE_BENCH_SLOTS');
		expect(CORE_STRIP_MARKUP).not.toMatch(/of 12/);
	});
});

// --- The baseline figure ---------------------------------------------------

describe('the baseline Maximum Bid — evaluate() output, never a stored figure', () => {
	it('is an ordinary money figure for a Team with an untouched Cap', () => {
		const team = teamWith();
		const figure = baselineMaximumBid(team, 'Auction', NOW);
		expect(figure).not.toBeNull();
		// $165.0M cap, nothing committed, 9 of 12 filled — so three unfilled
		// Slots reserve $3.0M and the ceiling is $162.0M. Asserted as the
		// arithmetic rather than as a magic number.
		const reserve = (ACTIVE_BENCH_SLOTS - (9 + 1)) * 1_000_000;
		expect(figure).toBe(SALARY_CAP - reserve);
	});

	it('is never "unbounded" — the probe treats the Player as not eligible', () => {
		// A Free Minor League Slot absorbs an eligible Player at a $0 Cap Hit,
		// which would make the answer "no cap limit" rather than a number.
		// The baseline asks about a NON-eligible Player precisely so the strip
		// carries one figure with one meaning on every screen.
		const team = teamWith({ minorLeagueOccupied: 0 });
		const figure = baselineMaximumBid(team, 'Auction', NOW);
		expect(typeof figure).toBe('number');
		expect(CORE_STRIP).toContain('bidStateFor(null, team, phase)');
	});

	it('is null for a viewer bound to no Team', () => {
		// `evaluateCap`'s own answer for that state: every figure nulled
		// together, rather than a zero invented for a Team that does not exist.
		expect(baselineMaximumBid(null, 'Auction', NOW)).toBeNull();
	});

	it('renders a negative figure as the negative it is, never clamped to $0.0M', () => {
		// An overcommitted Team — a Commissioner override, or leads placed
		// before a roster correction. Stating $0.0M would tell the Team that
		// most needs told something false.
		const team = teamWith({ capSpace: parseMoney(1_000_000), rosterCount: 2 });
		const figure = baselineMaximumBid(team, 'Auction', NOW);
		expect(figure).not.toBeNull();
		expect(figure as Money).toBeLessThan(0);
		expect(formatMoney(figure as Money)).toContain('$');
	});

	it('holds this Team\'s own leads against it — the strip excludes no Auction', () => {
		// This is what makes the strip legitimately read LOWER than the
		// Auction page's own panel, which excludes that Auction's own lead
		// because a raise replaces it. The strip excludes nothing, which is
		// the true answer to "what can I spend on something new".
		const auctions = fold(INITIAL_AUCTIONS, [bid(1, 'p-1', 't-1', 5_000_000)], auctionsReducer);
		const withLead = teamMoneyStateFor({
			teamId: 't-1',
			fantraxPlayerId: NO_AUCTION_PROBE_ID,
			capSpace: parseMoney(SALARY_CAP),
			rosterCount: 9,
			minorLeagueOccupied: 0,
			auctions,
			playerNameFor: (id) => id
		});
		expect(withLead.leading).toHaveLength(1);

		const bare = baselineMaximumBid(teamWith(), 'Auction', NOW) as Money;
		const committed = baselineMaximumBid(withLead, 'Auction', NOW) as Money;
		expect(committed).toBeLessThan(bare);
		// The $5.0M lead lands in Committed Bids, and the same lead is also a
		// Projected Active/Bench Addition — so one of the unfilled Slots stops
		// being reserved and $1.0M of Roster Reserve is released against it.
		// The net is $5.0M − $1.0M, which is the two derivations agreeing
		// rather than one figure counted twice.
		expect(bare - committed).toBe(5_000_000 - 1_000_000);
	});

	it('ignores the probe\'s verdict — the strip authorises nothing', () => {
		// A probe reporting a refusal would answer a question nobody asked.
		// A Team at Roster Capacity with no room fails gates and still has a
		// figure, because the figure is arithmetic and not permission.
		const full = teamWith({ rosterCount: ACTIVE_BENCH_SLOTS });
		expect(baselineMaximumBid(full, 'Auction', NOW)).not.toBeNull();
		expect(CORE_STRIP_MARKUP).not.toContain('allGatesPassed');
		expect(CORE_STRIP_MARKUP).not.toMatch(/\.passed\b/);
	});

	it('carries a named probe id rather than a literal or an empty string', () => {
		// AD-5's exposure tiebreak sorts on `fantraxPlayerId`, so the probe's
		// id participates in an ordering and is therefore a value the core
		// writes down once.
		expect(NO_AUCTION_PROBE_ID).toContain('no-auction');
		expect(CORE_STRIP).toContain('NO_AUCTION_PROBE_ID');
	});

	it('is the SAME probe the Team view reads, so the two cannot fork (Story 4.5)', () => {
		// `baselineMaximumBid` is `baselineCapOutcome(...).maximumBid` and
		// nothing else. Asserted over a bounded state, an unbounded one and a
		// null-Team one, because a refactor that forked would most likely fork
		// on exactly one of the three branches.
		const bounded = teamWith();
		expect(baselineMaximumBid(bounded, 'Auction', NOW)).toBe(
			baselineCapOutcome(bounded, 'Auction', NOW).maximumBid
		);

		// The probe treats the Player as NOT eligible, so `unbounded` is false
		// for every state it can be handed — which is itself the claim, and it
		// is asserted here rather than assumed.
		const wouldBeUnbounded = teamWith({ minorLeagueOccupied: 0, eligibleLeading: [] });
		const outcome = baselineCapOutcome(wouldBeUnbounded, 'Auction', NOW);
		expect(outcome.unbounded).toBe(false);
		expect(baselineMaximumBid(wouldBeUnbounded, 'Auction', NOW)).toBe(outcome.maximumBid);

		// ...and the null-Team state, where every figure nulls together.
		expect(baselineMaximumBid(null, 'Auction', NOW)).toBe(
			baselineCapOutcome(null, 'Auction', NOW).maximumBid
		);
		expect(baselineCapOutcome(null, 'Auction', NOW).maximumBid).toBeNull();
	});

	it('exists exactly once in the source — one probe, not two', () => {
		// The refactor's whole point: the probe is CALLED from one place — the
		// declaration is the other match — and `baselineMaximumBid` reaches it
		// through `baselineCapOutcome`.
		expect(CORE_STRIP_MARKUP.match(/evaluate\(state, probeFor\(\), now\)/g)).toHaveLength(1);
		expect(CORE_STRIP_MARKUP).toContain('baselineCapOutcome(team, phase, now).maximumBid');
		expect(CORE_STRIP_MARKUP.match(/bidStateFor\(null, team, phase\)/g)).toHaveLength(1);
	});
});

// --- The non-Live labelling ------------------------------------------------

describe('non-Live labelling reuses the one existing wording', () => {
	it('labels the figure through MAXIMUM_BID_LABELS and words no second sentence', () => {
		expect(STRIP).toContain('MAXIMUM_BID_LABELS[freshness.state]');
		expect(STRIP_MARKUP).not.toContain('last known');
		expect(STRIP_MARKUP).not.toContain('Maximum Bid');
		// And no second freshness derivation: the component reads the state
		// the layout's one contract holds and compares no window itself.
		expect(STRIP_MARKUP).not.toMatch(/FRESHNESS_WINDOW|STALE_WINDOW|deriveFreshness/);
	});

	it('has a last-known wording to reach for in both non-Live states', () => {
		expect(MAXIMUM_BID_LABELS.reconnecting).toContain('last known');
		expect(MAXIMUM_BID_LABELS.stale).toContain('last known');
	});
});

// --- The component's own claims --------------------------------------------

describe('PersistentStrip.svelte — the surface, asserted against its source', () => {
	it('renders the SAME DestinationsList the header menu renders (AD-30)', () => {
		expect(STRIP).toContain("import DestinationsList from './DestinationsList.svelte'");
		expect(STRIP).toContain('<DestinationsList {destinations} />');
		// One list, two triggers — never a second resolution. The header menu
		// imports the identical component from the identical path.
		const header = read('src', 'lib', 'components', 'HeaderMenu.svelte');
		expect(header).toContain("import DestinationsList from './DestinationsList.svelte'");
	});

	it('uses the `<details>` disclosure, never a focus-trapping modal', () => {
		expect(STRIP).toContain('<details');
		expect(STRIP).toContain('<summary');
		expect(STRIP_MARKUP).not.toMatch(/role="dialog"|aria-modal|showModal|<dialog\b/);
	});

	it('closes the sheet on navigation, as the header menu does', () => {
		expect(STRIP).toContain('afterNavigate');
		expect(STRIP).toContain('detailsEl.open = false');
	});

	it('is sized from --strip-height and contains no 52px literal', () => {
		expect(STRIP).toContain('var(--strip-height)');
		expect(STRIP_MARKUP).not.toContain('52px');
		expect(TOKENS_CSS).toContain('--strip-height: 52px');
	});

	it('sizes its figure from the documented non-frontmatter token', () => {
		expect(STRIP).toContain('var(--strip-figure-size)');
		expect(TOKENS_CSS).toContain('--strip-figure-size: 17px');
		// `--size-17` would fail tests/tokens.test.ts's ten-step assertion
		// against a document no story may hand-edit.
		expect(TOKENS_CSS_CODE).not.toContain('--size-17');
	});

	it('puts Georgia `brand` on the words and the 17px figure in the `ui` face', () => {
		// DESIGN.md:222 and epics.md:1435 both read "*Maximum Bid* in Georgia
		// `brand`, the figure at 17px" — the display face and the brand colour
		// belong to the LABEL, and the figure is the `ui` face a size up.
		// House.dc.html:143-146 is the same pairing. An earlier revision had
		// these exactly inverted, which no behavioural test could see: both
		// orderings render, and only one of them is the design.
		const label = /\.strip-label\s*\{[^}]*\}/.exec(STRIP)?.[0] ?? '';
		const figure = /\.strip-figure\s*\{[^}]*\}/.exec(STRIP)?.[0] ?? '';

		expect(label).toContain('var(--font-display)');
		expect(label).toContain('var(--color-brand)');

		expect(figure).toContain('var(--strip-figure-size)');
		expect(figure).not.toContain('var(--font-display)');
		// `brand` is brand and never a state signal — DESIGN.md's do-not list.
		expect(figure).not.toContain('var(--color-brand)');
	});

	it('imports nothing from $lib/server and names no non-public variable', () => {
		expect(STRIP_MARKUP).not.toMatch(/\$lib\/server|\$env\/dynamic\/private|\$env\/static\/private/);
		expect(STRIP_MARKUP).not.toMatch(/SERVICE_ROLE|SUPABASE_DB_URL|DISCORD_WEBHOOK/);
	});

	it('words no figure and no label of its own', () => {
		// Every sentence is `src/lib/core/`'s. The component prints fields.
		expect(STRIP).toContain('rosterCountSentence');
		expect(STRIP).toContain('STRIP_SHEET_LABEL');
		expect(STRIP).toContain('describeAmount');
		expect(STRIP_MARKUP).not.toMatch(/Roster \d+ of/);
		expect(STRIP_MARKUP).not.toMatch(/\$\d/);
	});

	it('derives the figure in the browser rather than reading a transported one', () => {
		expect(STRIP).toContain('baselineMaximumBid(team, phase, now)');
		// A `$derived` and not a snapshot: every reload the freshness contract
		// forces recomputes it, so there is nothing to invalidate. `$derived.by`
		// because the call is guarded — a throw here would break the render of
		// every page in the product, not merely the strip — but it is still a
		// derivation and still holds no state of its own.
		expect(STRIP).toMatch(/\$derived\.by\(\(\) => \{\s*try \{\s*return baselineMaximumBid/);
		expect(STRIP).not.toMatch(/\$state\([^)]*baselineMaximumBid/);
		expect(STRIP_MARKUP).not.toContain('maximumBid: ');
	});

	it('guards the figure so a throw cannot take down every page', () => {
		// The server half of this discipline is `stripTeamFor`'s catch, which
		// resolves to `null` rather than 500ing the layout every route
		// inherits. This is the client half: the component is mounted by the
		// ROOT layout, so an unguarded throw in the derivation breaks the
		// render of the whole product rather than of one strip.
		const derivation = /const maximumBid = \$derived\.by\([\s\S]*?\n	\}\);/.exec(STRIP)?.[0] ?? '';
		expect(derivation).toContain('try {');
		expect(derivation).toContain('catch');
		expect(derivation).toMatch(/catch \{\s*return null;/);
	});

	it('carries no urgency device — no countdown, no ending soon, no suggestion', () => {
		expect(STRIP_MARKUP).not.toMatch(/countdown|ending soon|closesIn|closesAt|suggest/i);
		// And it borrows neither reserved device.
		expect(STRIP_MARKUP).not.toContain('--accent-bar-width');
		expect(STRIP_MARKUP).not.toContain('--color-attention');
	});

	it('moves out of the pinned position at the one breakpoint the repo uses', () => {
		expect(STRIP).toContain('@media (min-width: 640px)');
		expect(STRIP).toContain('position: fixed');
		expect(STRIP).toContain('position: static');
	});

	it('pins to the TOP on a phone, because the bottom edge belongs to the nav bar', () => {
		// The strip held the bottom edge until `MobileNav.svelte` took it. Two
		// fixed elements at one edge would cost 112px of a phone's height, and
		// of the two it is the five-button bar that earns the thumb's edge —
		// the strip is read, not pressed for its figures.
		//
		// Asserting the declaration inside `.strip` rather than anywhere in
		// the file, because `.mobile-nav`'s own `bottom: 0` is the correct
		// value on the correct element and a file-wide match would accept it.
		const strip = /\.strip\s*\{[^}]*\}/.exec(STRIP)?.[0] ?? '';
		expect(strip).toContain('top: 0');
		expect(strip, 'the strip is pinned to the edge the nav bar occupies').not.toMatch(
			/\sbottom:/
		);
	});

	it('keeps its 1px border inside the height the layout reserves for it', () => {
		// `global.css` reserves exactly `--strip-height`. A border added on
		// TOP of a `min-height` of the same token occupies one pixel more than
		// was reserved, so the strip covers a row of the page by that much —
		// the one thing the reservation exists to prevent.
		//
		// This test used to assert `box-sizing: border-box` on `.strip` and
		// stop there, and that assertion passed for a year while the strip
		// stood at 53px. `box-sizing` governs an element's OWN specified
		// height; `.strip` specifies none, because the `min-height` is on
		// `.strip-summary`, a child it cannot reach. The height is where the
		// subtraction has to happen, so that is what is asserted now.
		const strip = /\.strip\s*\{[^}]*\}/.exec(STRIP)?.[0] ?? '';
		// The rule faces the page, and the page is BELOW the strip at both
		// widths now, so the border is on the bottom and there is no longer a
		// top-pinned and a bottom-pinned case to keep in step.
		expect(strip).toContain('border-bottom: var(--border-width)');
		expect(strip).toContain('box-sizing: border-box');
		// `.strip` sets no height of its own — if it ever does, this test is
		// asserting the wrong element and should be rewritten, not deleted.
		expect(strip, 'the strip now sizes itself; move the subtraction').not.toMatch(
			/\s(min-)?height:/
		);

		const summary = /\.strip-summary\s*\{[^}]*\}/.exec(STRIP)?.[0] ?? '';
		expect(summary).toContain('min-height: calc(var(--strip-height) - var(--border-width))');
	});

	it('states one line only, so it cannot wrap past the room reserved for it', () => {
		// The reserved room is a fixed `--strip-height`. A summary free to
		// wrap grows past it at a narrow width and covers the last control.
		const summary = /\.strip-summary\s*\{[^}]*\}/.exec(STRIP)?.[0] ?? '';
		expect(summary).toContain('flex-wrap: nowrap');
		expect(summary).toContain('white-space: nowrap');
		// The label is what gives if something must; the facts never shrink.
		const figure = /\.strip-figure,\s*\n\s*\.strip-roster\s*\{[^}]*\}/.exec(STRIP)?.[0] ?? '';
		expect(figure).toContain('flex-shrink: 0');
	});

	it('gives its persistent trigger the same focus ring the rest of the app uses', () => {
		// A `<summary>` is not covered by global.css's
		// `:where(a, button, input, select, textarea):focus-visible` rule, so
		// without this the one control present on every page has no ring.
		expect(STRIP).toContain('.strip-summary:focus-visible');
		expect(STRIP).toContain('var(--color-border-interactive)');
	});

	it('names the region and the sheet separately, because they are different things', () => {
		// The landmark holds Maximum Bid and the Roster Count; the sheet is
		// one control inside it. Naming both "Destinations" announced a
		// landmark that then read out money.
		expect(STRIP_MARKUP).toContain('aria-label={STRIP_REGION_LABEL}');
		expect(STRIP).toContain('STRIP_SHEET_LABEL');
		expect(STRIP_REGION_LABEL).not.toBe(STRIP_SHEET_LABEL);
	});

	it('closes the sheet on Escape and on a click outside, not only on navigation', () => {
		// A `<details>` honours neither for free. Without them the sheet is a
		// panel that can be opened on every page and dismissed only by finding
		// the trigger again. Still a disclosure: nothing is trapped and
		// nothing is made modal.
		expect(STRIP).toContain('onWindowKeydown');
		expect(STRIP).toContain('onWindowPointerdown');
		expect(STRIP).toMatch(/event\.key !== 'Escape'/);
		expect(STRIP).toContain('detailsEl.contains(event.target)');
		expect(STRIP_MARKUP).not.toMatch(/aria-modal|role="dialog"|<dialog/);
	});
});

// --- The mount and the gate -------------------------------------------------

describe('the strip is mounted once, by the layout, and gated server-side', () => {
	it('mounts in +layout.svelte, so it reaches every surface rather than one', () => {
		expect(LAYOUT).toContain('<PersistentStrip');
		expect(LAYOUT).toContain('data.stripTeam !== null');
		expect(LAYOUT).toContain('{@render children()}');
	});

	it('mounts BEFORE the page content, which is what puts it in the header on desktop', () => {
		// The Desktop matrix row is a DOM-ORDER requirement, not merely a CSS
		// one. At 640px the strip is `position: static`, so it renders exactly
		// where it sits in the document: mounted after `{@render children()}`
		// it lands at the FOOT of the page, and Maximum Bid is then reachable
		// on desktop only by scrolling to the bottom of every surface — the
		// inverse of "persistently visible at every width".
		//
		// Asserting the three positions rather than the strings, because the
		// earlier revision of this test checked only that `position: fixed`
		// and `position: static` appeared SOMEWHERE in the file, which is true
		// of both the correct and the broken arrangement.
		// Read from the comment-stripped source: prose explaining this very
		// arrangement mentions the render tag, and matching a comment instead
		// of the markup is how this assertion would quietly stop meaning
		// anything.
		const header = LAYOUT_CODE.indexOf('<HeaderMenu');
		const strip = LAYOUT_CODE.indexOf('<PersistentStrip');
		const children = LAYOUT_CODE.indexOf('{@render children()}');

		expect(header).toBeGreaterThan(-1);
		expect(strip).toBeGreaterThan(-1);
		expect(children).toBeGreaterThan(-1);

		expect(strip).toBeGreaterThan(header);
		expect(strip).toBeLessThan(children);
	});

	it('mounts the strip exactly once', () => {
		// Two mounts would put a second strip on every page — and, at 640px,
		// one in the header and one at the foot.
		expect(LAYOUT_CODE.match(/<PersistentStrip/g)).toHaveLength(1);
	});

	it('hands the strip FACTS and a server instant, never a derived figure', () => {
		expect(LAYOUT).toContain('team={data.stripTeam}');
		expect(LAYOUT).toContain('now={data.serverInstant}');
		expect(LAYOUT_CODE).not.toContain('maximumBid');
	});

	it('resolves stripTeam only for a signed-in Manager bound to a Team, in a phase that renders', () => {
		expect(LAYOUT_SERVER).toContain("locals.session.kind !== 'registered'");
		expect(LAYOUT_SERVER).toContain('teamId === null');
		expect(LAYOUT_SERVER).toContain('stripPresent(locals.phase.name)');
	});

	it('serialises no derived money at all — AD-7', () => {
		// The acceptance criterion, asserted as the absence it is: no
		// `maximumBid` field exists on anything the layout load returns.
		expect(LAYOUT_SERVER_CODE).not.toContain('maximumBid');
		expect(LAYOUT_SERVER_CODE).not.toContain('committedBids');
		expect(LAYOUT_SERVER_CODE).not.toContain('rosterReserve');
	});
});

// --- The server read --------------------------------------------------------

/**
 * A gateway over a fake client that answers the two statements this module
 * issues and records every statement it was asked. It throws on anything
 * else, so a read of a table the strip has no business touching fails the
 * suite rather than passing silently — `tests/server/team-roster.test.ts`'s
 * own discipline.
 */
function fakeGateway(rows: ReadonlyArray<Record<string, unknown>> = []) {
	const statements: string[] = [];
	return {
		statements,
		gateway: {
			connect: async () => ({
				async query(text: string) {
					const sql = text.trim();
					statements.push(sql);
					if (/^begin$|^rollback$/i.test(sql)) return { rows: [] };
					if (/^select \* from auction_events/i.test(sql)) return { rows: [] };
					// Matched on the TABLE rather than on the column list, so
					// widening the select (Story 4.5 adds the Player id and
					// name for the Team view's roster listing, from the same
					// one read) does not silently turn this fake's answer into
					// an "unexpected statement" throw. It still throws on any
					// OTHER table, which is what the discipline is for.
					if (/from team_rosters/i.test(sql)) return { rows };
					throw new Error(`unexpected statement: ${sql}`);
				},
				release: () => {}
			})
		}
	};
}

describe('loadStripTeam — executed against a fake client', () => {
	it('returns the FACTS a Team with no rows genuinely has', async () => {
		// No rows is a real state, not an error: a Team exists before the
		// import promotes anything, and the core already words that answer.
		const { gateway } = fakeGateway();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const team = await loadStripTeam(gateway as any, 't-1');
		expect(team).not.toBeNull();
		expect(team?.capSpace).toBe(SALARY_CAP);
		expect(team?.rosterCount).toBe(0);
		expect(team?.leading).toEqual([]);
		// And no derived money is on the object that crosses the wire (AD-7).
		expect(team).not.toHaveProperty('maximumBid');
	});

	it('reads the log exactly once and always rolls back', async () => {
		const { gateway, statements } = fakeGateway();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await loadStripTeam(gateway as any, 't-1');
		const eventReads = statements.filter((sql) => /from auction_events/i.test(sql));
		expect(eventReads).toHaveLength(1);
		expect(statements.at(-1)).toMatch(/^rollback$/i);
		// It takes NO lock: rendering a strip is not a write.
		expect(statements.some((sql) => /advisory/i.test(sql))).toBe(false);
	});

	it('answers null rather than throwing when the connection fails', async () => {
		const gateway = {
			connect: async () => {
				throw new Error('the database is unreachable');
			}
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await expect(loadStripTeam(gateway as any, 't-1')).resolves.toBeNull();
	});

	it('answers null rather than throwing when a statement fails', async () => {
		const gateway = {
			connect: async () => ({
				async query(text: string) {
					if (/^begin$|^rollback$/i.test(text.trim())) return { rows: [] };
					throw new Error('relation "auction_events" does not exist');
				},
				release: () => {}
			})
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await expect(loadStripTeam(gateway as any, 't-1')).resolves.toBeNull();
	});
});

describe('loadStripTeam — one read, facts only, and it cannot 500 a page', () => {
	it('folds over ONE loadEventsViaClient read, as the Auction page does', () => {
		const reads = SERVER_STRIP.match(/loadEventsViaClient\(/g) ?? [];
		expect(reads).toHaveLength(1);
		expect(SERVER_STRIP).toContain('auctionsReducer');
		// No `eligibilityReducer` (corrected 2026-09-18): the strip's figures
		// no longer turn on Minor League Eligibility, so folding it here would
		// be computing a projection nothing reads.
		expect(SERVER_STRIP).not.toContain('eligibilityReducer');
		expect(SERVER_STRIP).toContain('contractsReducer');
		expect(SERVER_STRIP).toContain('loadTeamRoster');
	});

	it('narrows through the core\'s one teamMoneyStateFor and derives no money itself', () => {
		expect(SERVER_STRIP).toContain('teamMoneyStateFor');
		expect(SERVER_STRIP_MARKUP).not.toContain('maximumBid');
		expect(SERVER_STRIP_MARKUP).not.toContain('subtractMoney');
	});

	it('excludes no Auction — the probe id is what makes the figure the baseline', () => {
		expect(SERVER_STRIP).toContain('fantraxPlayerId: NO_AUCTION_PROBE_ID');
	});

	it('answers null on a read failure rather than throwing at the layout', () => {
		// The layout is the one load every page inherits: a throw here would
		// 500 every surface in the product over a strip.
		expect(SERVER_STRIP).toContain('return null;');
		expect(SERVER_STRIP).toContain('catch');
		expect(SERVER_STRIP).toContain("client.query('rollback')");
	});
});

// --- The bottom room --------------------------------------------------------

describe('the strip never covers the last control', () => {
	it('reserves --strip-height of TOP room on mobile and releases it at 640px', () => {
		// The strip is pinned to the top now, so the room it needs is above
		// the page and not below it. Reserved at the bottom instead, the page
		// would begin underneath the strip — the first heading of every
		// surface covered — while 52px of nothing sat at the foot.
		expect(GLOBAL_CSS).toContain('padding-top: var(--strip-height)');
		expect(GLOBAL_CSS).toContain('@media (min-width: 640px)');
		expect(GLOBAL_CSS).toContain('padding-top: 0');
		expect(GLOBAL_CSS_CODE).not.toContain('52px');
	});

	it('reserves the bottom room for the nav bar instead, on its own gate', () => {
		// The bottom edge is the mobile destination bar's now, and it is a
		// different height and a different mount condition — a Manager can
		// have the strip without the bar. One `:has()` gate each, never one
		// shared between them.
		expect(GLOBAL_CSS).toContain('padding-bottom: var(--nav-height)');
		expect(GLOBAL_CSS).toContain('padding-bottom: 0');
		expect(GLOBAL_CSS_CODE).toContain('body:has(.mobile-nav)');
		expect(GLOBAL_CSS_CODE).not.toContain('60px');
	});

	it('reserves each room only where that element actually mounts', () => {
		// The strip does not mount for a signed-out visitor, a Manager bound
		// to no Team, or in Setup; the nav bar does not mount for a viewer
		// with no listed destination of their own. Reserving either room
		// unconditionally holds dead space on every one of those pages for
		// something that is not there.
		expect(GLOBAL_CSS_CODE).toContain('body:has(.strip)');
		expect(GLOBAL_CSS_CODE).not.toMatch(/\nbody \{\s*padding-bottom/);
	});
});

// --- The sheet label --------------------------------------------------------

describe('the sheet names itself from the core', () => {
	it('has one label, exported once', () => {
		expect(STRIP_SHEET_LABEL).toBe('Destinations');
		const declarations = CORE_STRIP.match(/^export const STRIP_SHEET_LABEL/gm) ?? [];
		expect(declarations).toHaveLength(1);
	});
});


// --- The bids figure (Story 10.6) -------------------------------------------

describe('the bids sentence and the lottery-entries sentence', () => {
	const lead = (fantraxPlayerId: string, amount: number, isContentionEntry = false) => ({
		fantraxPlayerId,
		playerName: fantraxPlayerId,
		amount: parseMoney(amount),
		isContentionEntry
	});

	const team = (input: {
		rosterCount: number;
		leading?: readonly ReturnType<typeof lead>[];
		eligibleLeading?: readonly ReturnType<typeof lead>[];
	}): TeamMoneyState => ({
		capSpace: parseMoney(SALARY_CAP),
		rosterCount: input.rosterCount,
		leading: input.leading ?? [],
		eligibleLeading: input.eligibleLeading ?? [],
		minorLeagueOccupied: 0
	});

	it('states the parity row exactly as the matrix words it', () => {
		const lines = outstandingBidLines(
			team({ rosterCount: 9, leading: [lead('p-1', 3_000_000), lead('p-2', 4_000_000)] })
		);

		expect(lines.bids).toBe('2 of 4 bids');
		// The strip's two segments, in the order the strip renders them.
		expect(rosterCountSentence(9)).toBe(`Roster 9 of ${String(ACTIVE_BENCH_SLOTS)}`);
	});

	it('never sums lottery entries into the bids figure', () => {
		const lines = outstandingBidLines(
			team({
				rosterCount: 10,
				leading: [lead('p-1', 3_000_000), lead('lot-1', 1_000_000, true)],
				eligibleLeading: [lead('lot-2', 1_000_000, true)]
			})
		);

		expect(lines.bids).toBe('1 of 3 bids');
		expect(lines.entries).toBe('2 lottery entries');
	});

	it('has no ceiling half on the entries sentence, because FR-18 imposes none', () => {
		const figures = outstandingBidFiguresFor(
			team({ rosterCount: 9, leading: [lead('lot-1', 1_000_000, true)] })
		);

		expect(contentionEntriesSentence(figures)).toBe('1 lottery entry');
		expect(contentionEntriesSentence(figures)).not.toContain(' of ');
	});

	it('is absent outside the Auction Phase, with the Roster Count left standing', () => {
		// The strip is inherited by every screen, so a figure about an act
		// nobody can perform would be a false statement on all of them. The
		// segment is gated in the surface on the core's predicate; the Roster
		// Count segment is not gated at all.
		expect(STRIP_MARKUP).toContain(
			'stripShowsOutstandingBids(phase) ? outstandingBidLines(team).bids : null'
		);
		expect(STRIP_MARKUP).toContain('{#if bids !== null}');
		// The Roster Count rides no condition.
		expect(STRIP_MARKUP).toContain('<span class="strip-roster">{roster}</span>');
		expect(STRIP_MARKUP).not.toMatch(/{#if[^}]*}\s*<span class="strip-roster">/);
	});

	it('says nothing at all for a viewer bound to no Team — never 0 of 0', () => {
		expect(outstandingBidsSentence(null)).toBeNull();
		expect(contentionEntriesSentence(null)).toBeNull();
		const lines = outstandingBidLines(null);
		expect(lines.figures).toBeNull();
		expect(lines.bids).toBeNull();
		expect(lines.entries).toBeNull();
	});

	it('gives the figure no colour, badge or warning treatment at parity (UX-DR35)', () => {
		// At parity the figure alone is the signal. The strip renders the
		// sentence into one plain span behind the `·` it already uses, and
		// nothing conditions a class on the count.
		expect(outstandingBidLines(team({ rosterCount: 11, leading: [lead('p-1', 3_000_000), lead('p-2', 3_000_000)] })).bids).toBe(
			'2 of 2 bids'
		);
		expect(STRIP).toContain('<span class="strip-bids">{bids}</span>');
		expect(STRIP_MARKUP).not.toMatch(/class:.*bids/);
		expect(STRIP_MARKUP).not.toContain('color-warning');
	});

	it('words nothing in the surface — the strip prints the core sentence', () => {
		expect(STRIP_MARKUP).toContain('outstandingBidLines(team).bids');
		expect(STRIP_MARKUP).not.toContain(' of ');
		expect(STRIP_MARKUP).not.toContain('bids`');
	});
});
