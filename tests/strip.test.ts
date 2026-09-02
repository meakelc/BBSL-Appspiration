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
import { teamMoneyStateFor } from '../src/lib/core/rules/bidding.ts';
import type { TeamMoneyState } from '../src/lib/core/rules/bidding.ts';
import {
	STRIP_SHEET_LABEL,
	baselineMaximumBid,
	rosterCountSentence,
	stripPresent,
	stripShowsMaximumBid
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
const CORE_STRIP_CODE = stripComments(CORE_STRIP);
const SERVER_STRIP_CODE = stripComments(SERVER_STRIP);
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

	it('is built from the constant, so the twelve cannot be spelled twice', () => {
		expect(CORE_STRIP).toContain('ACTIVE_BENCH_SLOTS');
		expect(CORE_STRIP_CODE).not.toMatch(/of 12/);
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
		expect(CORE_STRIP).toContain('bidStateFor(null, team, false, phase)');
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
			isMinorLeagueEligible: () => false,
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
		expect(CORE_STRIP_CODE).not.toContain('allGatesPassed');
		expect(CORE_STRIP_CODE).not.toMatch(/\.passed\b/);
	});

	it('carries a named probe id rather than a literal or an empty string', () => {
		// AD-5's exposure tiebreak sorts on `fantraxPlayerId`, so the probe's
		// id participates in an ordering and is therefore a value the core
		// writes down once.
		expect(NO_AUCTION_PROBE_ID).toContain('no-auction');
		expect(CORE_STRIP).toContain('NO_AUCTION_PROBE_ID');
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
		// forces recomputes it, so there is nothing to invalidate.
		expect(STRIP).toMatch(/\$derived\(baselineMaximumBid/);
		expect(STRIP_MARKUP).not.toContain('maximumBid: ');
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
});

// --- The mount and the gate -------------------------------------------------

describe('the strip is mounted once, by the layout, and gated server-side', () => {
	it('mounts in +layout.svelte, so it reaches every surface rather than one', () => {
		expect(LAYOUT).toContain('<PersistentStrip');
		expect(LAYOUT).toContain('data.stripTeam !== null');
		expect(LAYOUT).toContain('{@render children()}');
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
					if (/^select cap_hit, roster_slot_kind/i.test(sql)) return { rows };
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
		expect(SERVER_STRIP).toContain('eligibilityReducer');
		expect(SERVER_STRIP).toContain('contractsReducer');
		expect(SERVER_STRIP).toContain('loadTeamRoster');
	});

	it('narrows through the core\'s one teamMoneyStateFor and derives no money itself', () => {
		expect(SERVER_STRIP).toContain('teamMoneyStateFor');
		expect(SERVER_STRIP_CODE).not.toContain('maximumBid');
		expect(SERVER_STRIP_CODE).not.toContain('subtractMoney');
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
	it('reserves --strip-height of bottom room on mobile and releases it at 640px', () => {
		expect(GLOBAL_CSS).toContain('padding-bottom: var(--strip-height)');
		expect(GLOBAL_CSS).toContain('@media (min-width: 640px)');
		expect(GLOBAL_CSS).toContain('padding-bottom: 0');
		expect(GLOBAL_CSS_CODE).not.toContain('52px');
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
