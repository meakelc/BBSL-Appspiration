/**
 * The Cap and roster figures read from `team_rosters`. Server-only (Story 2.6).
 *
 * One reader, two callers — the locked transaction and the read path — so the
 * figure a control is disabled against and the figure a Bid is refused
 * against cannot be computed two different ways. What this file pins is the
 * asymmetry between the two figures, which is the part that is easy to get
 * backwards: an Injury Reserve contract counts against the CAP and not
 * against the TWELVE, and a Minor League contract counts against neither.
 */

import { describe, expect, it } from 'vitest';

import { SALARY_CAP } from '../../src/lib/core/constants.ts';
import { loadTeamRoster } from '../../src/lib/server/team-roster.ts';
import type { QueryResultRow, TransactionalClient } from '../../src/lib/shell/write.ts';

/**
 * A client that answers the one statement and records what it was asked.
 *
 * It throws on anything else, so a second query — or a read of a table this
 * module has no business touching — fails the suite rather than passing
 * silently.
 */
function fakeClient(rows: QueryResultRow[]) {
	const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
	const client: TransactionalClient = {
		async query(text: string, params: readonly unknown[] = []) {
			const sql = text.trim();
			statements.push({ sql, params });
			if (/^select cap_hit, roster_slot_kind\s+from team_rosters/i.test(sql)) {
				return { rows };
			}
			throw new Error(`unexpected statement: ${sql}`);
		}
	};
	return { client, statements };
}

const row = (capHit: string | number, kind: string): QueryResultRow => ({
	cap_hit: capHit,
	roster_slot_kind: kind
});

describe('loadTeamRoster — Cap Space and Roster Count from one statement', () => {
	it('reads one statement, keyed on the Team', async () => {
		const harness = fakeClient([]);

		await loadTeamRoster(harness.client, 't-7');

		expect(harness.statements).toHaveLength(1);
		expect(harness.statements[0]?.params).toEqual(['t-7']);
	});

	it('answers a Team with no rows with the full Salary Cap and Roster Count 0', async () => {
		// Reachable before the import promotes anything. A real state, not an
		// error — and not a refusal for a reason no rule states.
		const harness = fakeClient([]);

		expect(await loadTeamRoster(harness.client, 't-7')).toEqual({
			capSpace: SALARY_CAP,
			rosterCount: 0
		});
	});

	it('counts an Injury Reserve contract against the Cap but NOT against the twelve', async () => {
		const harness = fakeClient([
			row('4000000', 'active_bench'),
			row('3000000', 'injury_reserve')
		]);

		expect(await loadTeamRoster(harness.client, 't-7')).toEqual({
			capSpace: SALARY_CAP - 7_000_000,
			rosterCount: 1
		});
	});

	it('counts a Minor League contract against NEITHER', async () => {
		const harness = fakeClient([
			row('4000000', 'active_bench'),
			row('30000000', 'minor_league')
		]);

		expect(await loadTeamRoster(harness.client, 't-7')).toEqual({
			capSpace: SALARY_CAP - 4_000_000,
			rosterCount: 1
		});
	});

	it('brands the amount at the boundary, whichever shape the driver returns it in', async () => {
		// The same `int8` arrives as a string through one client and a number
		// through the other; `parseMoney` is what settles it (AD-8).
		const asString = fakeClient([row('4000000', 'active_bench')]);
		const asNumber = fakeClient([row(4_000_000, 'active_bench')]);

		expect(await loadTeamRoster(asString.client, 't-7')).toEqual(
			await loadTeamRoster(asNumber.client, 't-7')
		);
	});

	it('does not let an unknown slot kind silently consume one of the twelve', async () => {
		// Unreachable through the database, which carries a check constraint.
		// If it ever were reached, counting it against the Cap and not against
		// Roster Count is the conservative reading.
		const harness = fakeClient([row('4000000', 'something_else')]);

		expect(await loadTeamRoster(harness.client, 't-7')).toEqual({
			capSpace: SALARY_CAP - 4_000_000,
			rosterCount: 0
		});
	});
});
