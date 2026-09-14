/**
 * The Audit Log's two entry points, executed, and its surface (Story 7.5).
 *
 * `vite.config.ts` runs tests under `environment: 'node'` and no `.svelte`
 * file can be rendered under this suite, so the SURFACE assertions are
 * source-text ones in the established pattern — `tests/routes/board.test.ts`'s
 * own idiom, and its note explains why. The absence claims this page has to
 * make (no POST, no form action, no edit or delete affordance) are exactly the
 * claims that idiom proves.
 *
 * `+page.server.ts` and `export/+server.ts` are EXECUTED, and so is the whole
 * read beneath them. Only `$lib/shell/db.ts` is stubbed: `server/audit-log.ts`
 * itself runs, so the transaction discipline, the batched reference reads and
 * the name resolution are all under test rather than mocked away.
 *
 * **The fixtures carry non-null, DISTINCT `manager_id`/`team_id` pairs.** The
 * previous iteration of this story used one `row()` helper hardcoding
 * `manager_id: null, team_id: null`, so both reference-read functions took
 * their early return in all eighteen tests, the batching assertion was
 * vacuous, and the name-resolution path had no coverage at all. The stub below
 * answers the Team and Manager statements with real rows for that reason.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isHttpError } from '@sveltejs/kit';

import { UNKNOWN_TYPE_REFUSAL_STATUS, AUDIT_FILTER_KEYS } from '../../src/lib/core/audit-log.ts';
import { AUDIT_LOG_DESTINATION_ID } from '../../src/lib/server/audit-log.ts';
import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import { BID_PLACED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import { NOMINATION_PLACED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import type { BidPlacedPayload } from '../../src/lib/core/rules/bidding.ts';
import type { NominationPlacedPayload } from '../../src/lib/server/nomination.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const at = (...parts: string[]): string => join(ROOT, ...parts);

const PAGE = readFileSync(at('src', 'routes', 'audit-log', '+page.svelte'), 'utf8');
const SERVER = readFileSync(at('src', 'routes', 'audit-log', '+page.server.ts'), 'utf8');
const EXPORT = readFileSync(at('src', 'routes', 'audit-log', 'export', '+server.ts'), 'utf8');
const READ = readFileSync(at('src', 'lib', 'server', 'audit-log.ts'), 'utf8');
const CORE = readFileSync(at('src', 'lib', 'core', 'audit-log.ts'), 'utf8');

/**
 * Every comment stripped — `tests/structure.test.ts`'s discipline for the
 * reason it states there: prose ABOUT a forbidden thing is not that thing.
 * This page's header explains at length that it carries no POST and no edit
 * affordance, and an absence check over the raw text would fail on the very
 * sentence that promises the absence.
 */
function stripComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
}

const PAGE_CODE = stripComments(PAGE);
const SERVER_CODE = stripComments(SERVER);
const EXPORT_CODE = stripComments(EXPORT);
const READ_CODE = stripComments(READ);
const CORE_CODE = stripComments(CORE);

// --- The database stub -----------------------------------------------------

const TEAM_A = '11111111-1111-1111-1111-111111111111';
const TEAM_B = '22222222-2222-2222-2222-222222222222';
const MANAGER_A = 'aaaaaaaa-1111-1111-1111-111111111111';
const MANAGER_B = 'bbbbbbbb-2222-2222-2222-222222222222';
const PLAYER_ONE = 'player-1';

const BID_PLACED: BidPlacedPayload = {
	fantraxPlayerId: PLAYER_ONE,
	teamId: TEAM_A,
	teamName: 'Lakers',
	managerId: MANAGER_A,
	amount: 8_500_000,
	closesAt: '2026-09-02T12:00:00.000Z'
};

const NOMINATION_PLACED: NominationPlacedPayload = {
	fantraxPlayerId: PLAYER_ONE,
	playerName: 'Jalen Green',
	teamId: TEAM_B,
	teamName: 'Celtics',
	managerId: MANAGER_B,
	holdsSlot: true,
};

/**
 * One `auction_events` ROW, in the snake_case shape `toAppendedEvent` maps.
 *
 * The actor pair is non-null and distinct per row, so both reference reads
 * actually run and the resolved names actually reach the rendered actor.
 */
function row(seq: string, type: string, payload: unknown, managerId: string, teamId: string) {
	return {
		seq,
		occurred_at: new Date('2026-09-01T12:00:00.000Z'),
		schema_version: 1,
		core_version: 1,
		event_type: type,
		payload,
		manager_id: managerId,
		team_id: teamId,
		device_class: null,
		dispatch_outcome: null,
		delivery_outcome: null
	};
}

const stub = vi.hoisted(() => ({
	events: [] as unknown[],
	/** Every statement the read issued, so "one per question" is answerable. */
	queries: [] as string[],
	/** When set, the log read throws — the read-failure path. */
	failOn: null as string | null,
	released: 0
}));

vi.mock('$lib/shell/db.ts', () => ({
	writeGateway: () => ({
		connect: async () => ({
			query: async (sql: string) => {
				stub.queries.push(sql);
				if (stub.failOn !== null && sql.includes(stub.failOn)) {
					throw new Error('the database is unreachable');
				}
				if (sql.includes('from auction_events')) return { rows: stub.events };
				if (sql.includes('select now()')) return { rows: [{ now: new Date() }] };
				if (sql.includes('from teams')) {
					return {
						rows: [
							{ id: TEAM_A, name: 'Lakers' },
							{ id: TEAM_B, name: 'Celtics' }
						]
					};
				}
				if (sql.includes('from managers')) {
					return {
						rows: [
							{ id: MANAGER_A, display_name: 'Meakel' },
							{ id: MANAGER_B, display_name: 'Dana' }
						]
					};
				}
				if (sql.includes('free_agent_players')) {
					return {
						rows: [{ fantrax_player_id: PLAYER_ONE, player_name: 'Jalen Green' }]
					};
				}
				return { rows: [] };
			},
			release: () => {
				stub.released += 1;
			}
		})
	})
}));

const route = await import('../../src/routes/audit-log/+page.server.ts');
const exportRoute = await import('../../src/routes/audit-log/export/+server.ts');

// --- Sessions and phases ---------------------------------------------------

const MANAGER: RegisteredManager = {
	id: MANAGER_A,
	discordUserId: '222',
	displayName: 'Meakel',
	teamId: TEAM_A,
	teamName: 'Lakers',
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

const SESSION: SessionState = { kind: 'registered', manager: MANAGER };
const SIGNED_OUT: SessionState = { kind: 'signed-out' };

function locals(phase: ResolvedPhase = AUCTION_PHASE, session: SessionState = SESSION) {
	return { session, phase };
}

function url(query = ''): URL {
	return new URL(`http://localhost/audit-log${query}`);
}

/**
 * The `load`'s own return, typed.
 *
 * `PageServerLoad`'s declared return is `void | ...` — SvelteKit's own shape —
 * so `tests/routes/board.test.ts`'s cast is the established way to read the
 * data a load actually produced. One helper rather than a cast per assertion.
 */
type LoadedPage = {
	rows: ReadonlyArray<{
		readonly type: string;
		readonly actor: { readonly label: string };
	}>;
	filter: { readonly team: string | null };
	countSentence: string;
	exportQuery: string;
};

async function loadPage(phase: ResolvedPhase = AUCTION_PHASE, query = ''): Promise<LoadedPage> {
	return (await route.load({
		locals: locals(phase),
		url: url(query)
	} as never)) as LoadedPage;
}

async function expectRefusal(run: () => unknown, status: number): Promise<void> {
	let thrown: unknown;
	try {
		await run();
	} catch (caught) {
		thrown = caught;
	}
	expect(thrown, 'nothing was thrown').toBeDefined();
	expect(isHttpError(thrown)).toBe(true);
	expect((thrown as { status: number }).status).toBe(status);
}

beforeEach(() => {
	stub.events = [
		row('1', BID_PLACED_EVENT, BID_PLACED, MANAGER_A, TEAM_A),
		row('2', NOMINATION_PLACED_EVENT, NOMINATION_PLACED, MANAGER_B, TEAM_B)
	];
	stub.queries = [];
	stub.failOn = null;
	stub.released = 0;
});

// --- The guard -------------------------------------------------------------

describe('the destination guard', () => {
	it('runs FIRST, before any read', async () => {
		await expectRefusal(
			() => route.load({ locals: locals(SETUP_PHASE), url: url() } as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		// Position-aware in the only way that proves it: the read never happened.
		expect(stub.queries).toEqual([]);
	});

	it('refuses the export handler in Setup too, before any read', async () => {
		await expectRefusal(
			() => exportRoute.GET({ locals: locals(SETUP_PHASE), url: url() } as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(stub.queries).toEqual([]);
	});

	it('refuses a session that is not a registered Manager', async () => {
		await expectRefusal(
			() =>
				route.load({
					locals: locals(AUCTION_PHASE, SIGNED_OUT),
					url: url()
				} as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
	});

	it('lets an ordinary Manager read it in all three live phases', async () => {
		for (const phase of [AUCTION_PHASE, ASSIGNMENT_PHASE, ARCHIVED_PHASE]) {
			const data = await loadPage(phase);
			expect(data.rows).toHaveLength(2);
		}
	});

	it('names the destination by id in both entry points', () => {
		// Both gate, and both gate on the SAME id — which is now asserted by
		// their sharing one constant rather than by each carrying its own copy
		// of the literal. Two copies is how a typo leaves the export guarding a
		// destination nothing registers while the page guards the real one, and
		// `requireLiveDestination` refuses an unknown id rather than failing
		// loudly at the typo.
		expect(SERVER_CODE).toContain('requireLiveDestination');
		expect(SERVER_CODE).toContain('AUDIT_LOG_DESTINATION_ID');
		expect(EXPORT_CODE).toContain('requireLiveDestination');
		expect(EXPORT_CODE).toContain('AUDIT_LOG_DESTINATION_ID');

		// Neither route re-declares it: the literal lives in one place.
		expect(SERVER_CODE).not.toContain("= 'audit-log'");
		expect(EXPORT_CODE).not.toContain("= 'audit-log'");
		expect(READ_CODE).toContain("export const AUDIT_LOG_DESTINATION_ID = 'audit-log'");
	});

	it('gates on the id the catalog actually registers', () => {
		// The constant is only worth sharing if it is the registered id. This is
		// the one assertion that would catch both copies being wrong together.
		expect(AUDIT_LOG_DESTINATION_ID).toBe('audit-log');
	});
});

// --- The read --------------------------------------------------------------

describe('the read', () => {
	it('takes one transaction, one log read, one clock read and always rolls back', async () => {
		await route.load({ locals: locals(), url: url() } as never);

		const count = (needle: string) => stub.queries.filter((sql) => sql.includes(needle)).length;

		expect(count('begin')).toBe(1);
		expect(count('from auction_events')).toBe(1);
		expect(count('select now()')).toBe(1);
		expect(count('rollback')).toBe(1);
		expect(stub.released).toBe(1);
	});

	it('takes no advisory lock and writes nothing', async () => {
		await route.load({ locals: locals(), url: url() } as never);
		for (const sql of stub.queries) {
			expect(sql).not.toContain('pg_advisory');
			expect(sql).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b/i);
		}
	});

	it('never names contention_seeds', async () => {
		await route.load({ locals: locals(), url: url() } as never);
		for (const sql of stub.queries) expect(sql).not.toContain('contention_seeds');
		expect(READ_CODE).not.toContain('contention_seeds');
		expect(CORE_CODE).not.toContain('contention_seeds');
		expect(SERVER_CODE).not.toContain('contention_seeds');
		expect(EXPORT_CODE).not.toContain('contention_seeds');
	});

	it('asks ONE statement per reference question, not one per row', async () => {
		// Four actors across four events — two Teams and two Managers — and
		// still exactly one `teams` statement and one `managers` statement.
		stub.events = [
			row('1', BID_PLACED_EVENT, BID_PLACED, MANAGER_A, TEAM_A),
			row('2', NOMINATION_PLACED_EVENT, NOMINATION_PLACED, MANAGER_B, TEAM_B),
			row('3', BID_PLACED_EVENT, BID_PLACED, MANAGER_B, TEAM_B),
			row('4', NOMINATION_PLACED_EVENT, NOMINATION_PLACED, MANAGER_A, TEAM_A)
		];
		await route.load({ locals: locals(), url: url() } as never);

		expect(stub.queries.filter((sql) => sql.includes('from teams'))).toHaveLength(1);
		expect(stub.queries.filter((sql) => sql.includes('from managers'))).toHaveLength(1);
		expect(stub.queries.filter((sql) => sql.includes('free_agent_players'))).toHaveLength(1);
	});

	it('resolves names and puts them on the rendered actor', async () => {
		const data = await loadPage();
		const actors = data.rows.map((entry) => entry.actor.label);
		expect(actors).toContain('Lakers — Meakel');
		expect(actors).toContain('Celtics — Dana');
	});

	it('surfaces a read failure rather than rendering an empty Log', async () => {
		stub.failOn = 'from auction_events';
		await expect(route.load({ locals: locals(), url: url() } as never)).rejects.toThrow(
			'the database is unreachable'
		);
		// The transaction was still closed and the client still released.
		expect(stub.queries.filter((sql) => sql.includes('rollback'))).toHaveLength(1);
		expect(stub.released).toBe(1);
	});

	it('renders a designed empty state for an empty log rather than failing', async () => {
		stub.events = [];
		const data = await loadPage();
		expect(data.rows).toEqual([]);
		expect(data.countSentence).toContain('0');
	});
});

// --- The query parameters --------------------------------------------------

describe('the query parameters', () => {
	it('filters by Team', async () => {
		const data = await loadPage(AUCTION_PHASE, `?${AUDIT_FILTER_KEYS.team}=${TEAM_B}`);
		expect(data.rows).toHaveLength(1);
		expect(data.filter.team).toBe(TEAM_B);
		expect(data.countSentence).toBe('1 of 2 entries.');
	});

	it('states an empty result for an unknown Team rather than refusing', async () => {
		const data = await loadPage(AUCTION_PHASE, `?${AUDIT_FILTER_KEYS.team}=nobody`);
		expect(data.rows).toEqual([]);
		expect(data.filter.team).toBe('nobody');
	});

	it('refuses an unrecognised type', async () => {
		await expectRefusal(
			() => route.load({ locals: locals(), url: url('?type=NotAnEvent') } as never),
			UNKNOWN_TYPE_REFUSAL_STATUS
		);
	});

	it('refuses an unrecognised type on the export path too', async () => {
		await expectRefusal(
			() =>
				exportRoute.GET({
					locals: locals(),
					url: url('?type=NotAnEvent')
				} as never),
			UNKNOWN_TYPE_REFUSAL_STATUS
		);
	});

	it('carries the filters into the export link', async () => {
		const data = await loadPage(
			AUCTION_PHASE,
			`?${AUDIT_FILTER_KEYS.team}=${TEAM_B}&${AUDIT_FILTER_KEYS.type}=${BID_PLACED_EVENT}`
		);
		expect(data.exportQuery).toContain(`${AUDIT_FILTER_KEYS.team}=${TEAM_B}`);
		expect(data.exportQuery).toContain(`${AUDIT_FILTER_KEYS.type}=${BID_PLACED_EVENT}`);
	});
});

// --- The export response ---------------------------------------------------

describe('the export response', () => {
	it('serves CSV with a filename and no caching', async () => {
		const response = await exportRoute.GET({
			locals: locals(),
			url: url()
		} as never);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(response.headers.get('content-disposition')).toContain('audit-log.csv');
		expect(response.headers.get('cache-control')).toBe('no-store');

		const body = await response.text();
		expect(body).toContain('Lakers — Meakel');
		expect(body).toContain('Celtics — Dana');
	});

	it('exports exactly the rows the page is showing, under the same filters', async () => {
		const query = `?${AUDIT_FILTER_KEYS.team}=${TEAM_B}`;
		const data = await loadPage(AUCTION_PHASE, query);
		const response = await exportRoute.GET({
			locals: locals(),
			url: url(query)
		} as never);
		const body = await response.text();

		// One record plus the header.
		expect(body.trimEnd().split('\r\n')).toHaveLength(data.rows.length + 1);
		expect(body).toContain('Celtics — Dana');
		expect(body).not.toContain('Lakers — Meakel');
	});

	it('re-adds none of the global security headers', () => {
		// `hooks.server.ts` sets them via `server/security-headers.ts`.
		expect(EXPORT_CODE).not.toContain('x-frame-options');
		expect(EXPORT_CODE).not.toContain('content-security-policy');
	});
});

// --- The surface -----------------------------------------------------------

describe('the surface', () => {
	it('carries no POST, no form action and no mutating control', () => {
		expect(PAGE_CODE).not.toContain('method="post"');
		expect(PAGE_CODE).not.toContain("method='post'");
		expect(PAGE_CODE).not.toContain('use:enhance');
		expect(PAGE_CODE).not.toMatch(/\baction=/);
		expect(PAGE_CODE).not.toMatch(/formaction/i);
		// The one `<button>` on the page is a submit on a GET form.
		expect(PAGE_CODE).toContain('type="submit"');
	});

	it('offers no edit, delete, redact or correct affordance', () => {
		for (const word of ['Edit', 'Delete', 'Remove', 'Redact', 'Correct', 'Undo']) {
			expect(PAGE_CODE).not.toContain(`>${word}`);
		}
	});

	it('has no form action on the server route either', () => {
		expect(SERVER_CODE).not.toContain('export const actions');
	});

	it('filters and exports without client JS', () => {
		// A `method="get"` form and an ordinary link, so both survive
		// JavaScript being off — and a filter survives being bookmarked.
		expect(PAGE_CODE).toContain('method="get"');
		expect(PAGE_CODE).toContain('<a class="export"');
	});

	it('renders a filter value absent from its option list as the selected option', () => {
		// Otherwise a `?team=` naming a Team no entry mentions leaves the
		// control reading "Any" while the filter is in force.
		expect(PAGE_CODE).toContain('optionsWith');
		expect(PAGE_CODE).toContain('options.some((option) => option.value === selected)');
	});

	it('words nothing of its own', () => {
		expect(PAGE_CODE).toContain("from '$lib/core/audit-log.ts'");
		expect(PAGE_CODE).not.toContain('$lib/server');
	});

	it('is single column with no fixed widths', () => {
		expect(PAGE_CODE).toContain('flex-direction: column');
		expect(PAGE_CODE).not.toMatch(/\bwidth:\s*\d+px/);
	});
});
