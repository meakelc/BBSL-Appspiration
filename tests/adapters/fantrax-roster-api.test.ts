/**
 * The Fantrax `getTeamRosters` reader (Story 7.9, FR-42).
 *
 * `tests/adapters/discord-webhook.test.ts`'s shape: a hand-built `FetchLike`
 * and a hand-built `HttpResponse`, with no `vi.mock` and no `vi.stubGlobal` —
 * there is none anywhere in this repository, and this adapter does not
 * introduce the need for one, because its transport is injected.
 *
 * **The fixture is the observed payload.** 2026-09-10, unauthenticated, 30
 * Teams, 303 rows: per Team a `teamName`, a Fantrax team id and `salaryCap`;
 * per row `{"contract":{"smallId","name"},"id":"01eon","position","salary":2.25E7,"status"}`.
 * The shape below is that, trimmed to the rows each claim needs.
 *
 * **Where hazard 2's proof lives.** `normaliseFantraxPlayerId` is this module's
 * — the shape of a Fantrax id is a fact about Fantrax (AD-24) — and it is
 * APPLIED by `server/divergence.ts`, to the API's ids and to `team_rosters`'
 * stored ids alike. So this file proves the function canonicalises both forms to
 * one string, and `tests/server/divergence.test.ts` proves the shell actually
 * applies it to both sides and that skipping it reads the whole league as
 * departed and arrived at once.
 */

import { describe, expect, it } from 'vitest';

import {
	FANTRAX_STATUS_SLOTS,
	createFantraxRosterPort,
	normaliseFantraxPlayerId,
	parseRosterPayload,
	rosterRequestUrl,
	roundedSalary
} from '../../src/lib/adapters/fantrax/roster-api.ts';
import type {
	FetchLike,
	HttpResponse
} from '../../src/lib/adapters/fantrax/roster-api.ts';
import { formatExactDollars, isOnMoneyGrid } from '../../src/lib/core/money.ts';

const BASE_URL = 'https://fantrax.example/fxea/general';
const LEAGUE_ID = 'league-abc';
const PERIOD = '1';

/** One recorded request, as the fake transport saw it. */
type Recorded = { url: string; method: string; headers: Record<string, string> };

/** A hand-built `Response`, structurally — exactly the four members read. */
function response(input: { status: number; body?: string }): HttpResponse {
	return {
		ok: input.status >= 200 && input.status < 300,
		status: input.status,
		headers: { get: () => null },
		text: async () => input.body ?? ''
	};
}

function fakeFetch(answer: HttpResponse | (() => never)): { fetch: FetchLike; sent: Recorded[] } {
	const sent: Recorded[] = [];
	const fetch: FetchLike = async (url, init) => {
		sent.push({ url, method: init.method, headers: init.headers });
		if (typeof answer === 'function') return answer();
		return answer;
	};
	return { fetch, sent };
}

function portWith(answer: HttpResponse | (() => never)) {
	const { fetch, sent } = fakeFetch(answer);
	return {
		port: createFantraxRosterPort({ baseUrl: BASE_URL, leagueId: LEAGUE_ID, period: PERIOD, fetch }),
		sent
	};
}

/** The observed payload, with two Teams and one row of each status. */
const FIXTURE = JSON.stringify({
	rosters: {
		'ftx-a': {
			teamName: 'Team A',
			salaryCap: 165000000,
			rosterItems: [
				{ contract: { smallId: 'c1', name: 'Amir Powell' }, id: '01eon', position: 'PG', salary: 2.25e7, status: 'ACTIVE' },
				{ contract: { smallId: 'c2', name: 'Bo Ellis' }, id: '04ewu', position: 'SF', salary: 3000000, status: 'RESERVE' }
			]
		},
		'ftx-b': {
			teamName: 'Team B',
			salaryCap: 165000000,
			rosterItems: [
				{ contract: { smallId: 'c3', name: 'Cy Duren' }, id: '0zzz1', position: 'C', salary: 2000000, status: 'MINORS' },
				{ contract: { smallId: 'c4', name: 'Dee Sharpe' }, id: '0yyy2', position: 'SG', salary: 1000000, status: 'INJURED_RESERVE' }
			]
		}
	}
});

describe('the request', () => {
	it('names the endpoint, the league and the period, and asks for JSON', async () => {
		const { port, sent } = portWith(response({ status: 200, body: FIXTURE }));
		await port.read();

		expect(sent).toHaveLength(1);
		expect(sent[0]?.url).toBe(
			`${BASE_URL}/getTeamRosters?leagueId=${LEAGUE_ID}&period=${PERIOD}`
		);
		expect(sent[0]?.method).toBe('GET');
		expect(sent[0]?.headers['accept']).toBe('application/json');
	});

	it('does not double the slash when the base URL carries a trailing one', () => {
		expect(rosterRequestUrl({ baseUrl: `${BASE_URL}/`, leagueId: 'x', period: '2' })).toBe(
			`${BASE_URL}/getTeamRosters?leagueId=x&period=2`
		);
	});
});

describe('id normalisation, in both directions', () => {
	it('canonicalises the API form and the stored asterisk-wrapped form to one string', () => {
		// The whole of hazard 2 in one assertion: the API answers `04ewu` and the
		// FR-1 importer stores `*04ewu*` verbatim. If these two stop agreeing,
		// every row in the league reads as a departure AND an arrival.
		expect(normaliseFantraxPlayerId('04ewu')).toBe(normaliseFantraxPlayerId('*04ewu*'));
		expect(normaliseFantraxPlayerId('*04ewu*')).toBe('04ewu');
	});

	it('is stable under case, whitespace and repeated asterisks', () => {
		expect(normaliseFantraxPlayerId('  **01EON**  ')).toBe('01eon');
	});

	it('canonicalises every id the parse produces', () => {
		const result = parseRosterPayload(
			JSON.stringify({
				rosters: {
					'ftx-a': {
						teamName: 'Team A',
						rosterItems: [
							{ contract: { name: 'Amir Powell' }, id: '*01EON*', salary: 2000000, status: 'ACTIVE' }
						]
					}
				}
			})
		);
		expect(result.kind).toBe('ok');
		if (result.kind !== 'ok') return;
		expect(result.snapshot.teams[0]?.members[0]?.playerId).toBe('01eon');
	});
});

describe('the status map', () => {
	it('maps all four observed statuses, folding ACTIVE and RESERVE together', () => {
		expect(FANTRAX_STATUS_SLOTS).toEqual({
			ACTIVE: 'active_bench',
			RESERVE: 'active_bench',
			MINORS: 'minor_league',
			INJURED_RESERVE: 'injury_reserve'
		});
	});

	it('carries each row into its Slot kind', () => {
		const result = parseRosterPayload(FIXTURE);
		expect(result.kind).toBe('ok');
		if (result.kind !== 'ok') return;
		const kinds = result.snapshot.teams.flatMap((team) =>
			team.members.map((member) => member.rosterSlotKind)
		);
		expect(kinds.sort()).toEqual(
			['active_bench', 'active_bench', 'injury_reserve', 'minor_league'].sort()
		);
	});

	it('refuses the same player id on two rosters, naming the id', () => {
		// Rows join on this id (AD-24) and the membership map is keyed by Team, so
		// last-one-wins would put the Player on whichever Team sorted later and
		// then propose a Roster Trade naming THE WRONG TEAM — with nothing on the
		// page to say the proposal was built on a coin toss.
		const result = parseRosterPayload(
			JSON.stringify({
				rosters: {
					'ftx-a': {
						teamName: 'Team A',
						rosterItems: [{ id: '01eon', salary: 1000000, status: 'ACTIVE' }]
					},
					'ftx-b': {
						teamName: 'Team B',
						// The SAME Player, in the other spelling — which is the shape
						// that would slip a check comparing raw strings.
						rosterItems: [{ id: '*01EON*', salary: 1000000, status: 'ACTIVE' }]
					}
				}
			})
		);
		expect(result.kind).toBe('malformed');
		if (result.kind !== 'malformed') return;
		expect(result.detail).toContain('01eon');
		expect(result.detail).toContain('more than one roster');
	});

	it('refuses an unrecognised status by NAMING it, rather than defaulting it', () => {
		// The CSV adapter's `injured reserve` alias deliberately does not match
		// this API's `INJURED_RESERVE`, and a loose map over a third party's enum
		// is how a new status silently becomes active_bench.
		const result = parseRosterPayload(
			JSON.stringify({
				rosters: {
					'ftx-a': {
						teamName: 'Team A',
						rosterItems: [{ id: 'p1', salary: 1000000, status: 'injured reserve' }]
					}
				}
			})
		);
		expect(result.kind).toBe('malformed');
		if (result.kind !== 'malformed') return;
		expect(result.detail).toContain('injured reserve');
	});
});

describe('the salary rounding and the grid', () => {
	it('rounds 23499999.999999993 to $23,500,000 and passes the grid', () => {
		const salary = roundedSalary(23499999.999999993);
		expect(salary).not.toBeNull();
		if (salary === null) return;
		expect(salary.amount).toBe(23_500_000);
		expect(formatExactDollars(salary.amount)).toBe('$23,500,000');
		expect(salary.onGrid).toBe(true);
		expect(isOnMoneyGrid(salary.amount)).toBe(true);
	});

	it('refuses truncation: Math.trunc would put that figure a dollar low and off the grid', () => {
		// The defect this helper exists to prevent, asserted directly — 4 of 303
		// live rows took this path under `int()`.
		const truncated = Math.trunc(23499999.999999993);
		expect(truncated).toBe(23_499_999);
		expect(isOnMoneyGrid(truncated as never)).toBe(false);
		expect(roundedSalary(23499999.999999993)?.amount).not.toBe(truncated);
	});

	it('warns about an off-grid figure and keeps the Player a MEMBER', () => {
		// Dropping a row over an unused field would manufacture a departure — the
		// silent-total-failure shape arriving through the door built to stop it.
		const result = parseRosterPayload(
			JSON.stringify({
				rosters: {
					'ftx-a': {
						teamName: 'Team A',
						rosterItems: [
							{ contract: { name: 'Odd Money' }, id: 'p1', salary: 1_234_567, status: 'ACTIVE' }
						]
					}
				}
			})
		);
		expect(result.kind).toBe('ok');
		if (result.kind !== 'ok') return;
		expect(result.snapshot.moneyWarnings).toEqual(['Odd Money']);
		expect(result.snapshot.teams[0]?.members).toHaveLength(1);
	});

	it('answers null for a salary that is not a finite number at all', () => {
		// Malformed is not the same fact as off-grid, and the two must not be
		// reported as one.
		expect(roundedSalary('lots')).toBeNull();
		expect(roundedSalary(Number.NaN)).toBeNull();
	});
});

describe('every failure mode is a union member, never a throw', () => {
	it('answers unreachable when the transport throws', async () => {
		const { port } = portWith(() => {
			throw new Error('ECONNREFUSED');
		});
		const result = await port.read();
		expect(result.kind).toBe('unreachable');
	});

	it('answers rate_limited on a 429', async () => {
		const { port } = portWith(response({ status: 429, body: 'slow down' }));
		expect((await port.read()).kind).toBe('rate_limited');
	});

	it('answers unreachable on a 5xx', async () => {
		const { port } = portWith(response({ status: 503, body: 'upstream down' }));
		expect((await port.read()).kind).toBe('unreachable');
	});

	it('answers malformed on a body that is not JSON', async () => {
		const { port } = portWith(response({ status: 200, body: '<html>nope</html>' }));
		expect((await port.read()).kind).toBe('malformed');
	});

	it('answers malformed on JSON with no rosters object', async () => {
		const { port } = portWith(response({ status: 200, body: '{"ok":true}' }));
		expect((await port.read()).kind).toBe('malformed');
	});

	it('never lets the league id or the URL into a detail string', async () => {
		// The URL identifies a private league and the base URL is configuration;
		// neither belongs in a row the Commissioner's browser will render.
		const { port } = portWith(response({ status: 503, body: 'upstream down' }));
		const result = await port.read();
		if (result.kind === 'ok') throw new Error('expected a failure');
		expect(result.detail).not.toContain(LEAGUE_ID);
		expect(result.detail).not.toContain(BASE_URL);
	});
});
