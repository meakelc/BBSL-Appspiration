import { describe, expect, it } from 'vitest';

import { SALARY_CAP } from '../../src/lib/core/constants.ts';
import {
	CURRENT_CONTRACT_YEAR,
	ROSTER_COLUMNS
} from '../../src/lib/adapters/fantrax/roster-file.ts';
import { poolConflictRefusalDetail } from '../../src/lib/core/rules/pool-import.ts';
import {
	fileAlreadySuppliedDetail,
	fileAmbiguousDetail,
	fileNoMatchDetail,
	stageRosterFile
} from '../../src/lib/server/roster-import.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

/** Built from `ROSTER_COLUMNS`, the same way `tests/adapters/fantrax-roster.test.ts` does,
 *  so a column-name change stays a one-file edit. Confirmed against a real
 *  export on 2026-09-05 (AR-33). */
const HEADER = Object.values(ROSTER_COLUMNS).join(',');

/** `Contract` holds an end year, not a count — so an end year `n` seasons out
 *  is what a fixture writes when it means "n years remaining". Derived rather
 *  than hardcoded so these rows do not expire when the constant moves on. */
function endYearIn(years: number): string {
	return String(CURRENT_CONTRACT_YEAR + years);
}

/**
 * A fake `ConnectionGateway` for `stageRosterFile`, in the style of
 * `shell-write.test.ts`'s `fakeGateway()` — a hand-rolled client recording
 * every query, in order, plus release calls, answering exactly the
 * statements `stageRosterFile`/`writeOutcome` are known to issue.
 *
 * `initialSources` seeds an in-memory `import_team_sources` map, and the
 * upsert query updates it as `writeOutcome` writes — so a test can run two
 * `stageRosterFile` calls against the SAME gateway and have the second call's
 * `select status from import_team_sources` see what the first call wrote,
 * the way two transactions against one real database would.
 */
function fakeGateway(
	teams: ReadonlyArray<{ id: string; name: string }>,
	initialSources: Record<string, { status: string }> = {},
	/** Staged pool Players, keyed by Fantrax Player ID -> Player name (Story 1.8). */
	stagedPoolPlayers: Record<string, string> = {}
): {
	gateway: ConnectionGateway;
	order: string[];
	queries: Array<{ sql: string; params: readonly unknown[] }>;
	released: boolean[];
	deletedTeamIds: string[];
	insertedRows: QueryResultRow[];
	upsertedSources: QueryResultRow[];
	sources: Map<string, { status: string }>;
} {
	const order: string[] = [];
	const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
	const released: boolean[] = [];
	const deletedTeamIds: string[] = [];
	const insertedRows: QueryResultRow[] = [];
	const upsertedSources: QueryResultRow[] = [];
	const sources = new Map(Object.entries(initialSources));

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, params: readonly unknown[] = []) {
			const sql = text.trim();
			queries.push({ sql, params });

			if (/^begin/i.test(sql)) {
				order.push('begin');
				return { rows: [] };
			}
			if (/^commit/i.test(sql)) {
				order.push('commit');
				return { rows: [] };
			}
			if (/^rollback/i.test(sql)) {
				order.push('rollback');
				return { rows: [] };
			}
			if (/^select id, name from teams/i.test(sql)) {
				order.push('select-teams');
				return { rows: teams.map((t) => ({ id: t.id, name: t.name })) };
			}
			if (/^select player_name from import_staged_pool_players/i.test(sql)) {
				order.push('select-pool-conflicts');
				const ids = (params[0] as string[]) ?? [];
				return {
					rows: ids
						.filter((id) => id in stagedPoolPlayers)
						.map((id) => ({ player_name: stagedPoolPlayers[id] }))
				};
			}
			if (/^select status from import_team_sources/i.test(sql)) {
				order.push('select-status');
				const existing = sources.get(String(params[0]));
				return { rows: existing ? [{ status: existing.status }] : [] };
			}
			if (/^delete from import_staged_rosters/i.test(sql)) {
				order.push('delete-rows');
				deletedTeamIds.push(String(params[0]));
				return { rows: [] };
			}
			if (/^insert into import_staged_rosters/i.test(sql)) {
				// ONE statement carrying every Player on the roster, six bind
				// parameters each (Story 9.7). It was one statement per row until
				// a real import showed what that costs: thirty rosters and a
				// ~1,470-Player pool, staged in a single request, exceeded
				// Netlify's 10-second function budget by an order of magnitude.
				// The params are unflattened here so the assertions below still
				// read one row at a time.
				order.push('insert-rows');
				expect(params.length % 6, 'params do not divide into six-column rows').toBe(0);
				for (let at = 0; at < params.length; at += 6) {
					insertedRows.push({
						team_id: params[at],
						fantrax_player_id: params[at + 1],
						player_name: params[at + 2],
						cap_hit: params[at + 3],
						roster_slot_kind: params[at + 4],
						contract_years_remaining: params[at + 5]
					} as QueryResultRow);
				}
				return { rows: [] };
			}
			if (/^insert into import_team_sources/i.test(sql)) {
				order.push('upsert-status');
				const row: QueryResultRow = {
					team_id: params[0],
					file_name: params[1],
					status: params[2],
					refusal_detail: params[3]
				};
				upsertedSources.push(row);
				sources.set(String(params[0]), { status: String(params[2]) });
				return { rows: [] };
			}
			throw new Error(`fakeGateway: unexpected query: ${sql}`);
		},
		release() {
			released.push(true);
		}
	};

	const gateway: ConnectionGateway = { connect: async () => client };

	return {
		gateway,
		order,
		queries,
		released,
		deletedTeamIds,
		insertedRows,
		upsertedSources,
		sources
	};
}

const LAKERS = { id: 't-lakers', name: 'Lakers' };
const CELTICS = { id: 't-celtics', name: 'Celtics' };

const HAPPY_CSV = [
	HEADER,
	`P1,Alice,10000000,Act,${endYearIn(2)}`,
	`P2,Bob,0,IR,${endYearIn(1)}`
].join('\n');

describe('stageRosterFile — the happy path', () => {
	it('stages: resolves the Team, parses, validates, deletes+inserts+upserts, then commits', async () => {
		const { gateway, order, deletedTeamIds, insertedRows, upsertedSources, released } = fakeGateway([
			LAKERS,
			CELTICS
		]);

		const outcome = await stageRosterFile(gateway, 'Lakers.csv', HAPPY_CSV);

		expect(outcome).toEqual({
			kind: 'staged',
			source: 'team',
			teamId: LAKERS.id,
			teamName: LAKERS.name,
			fileName: 'Lakers.csv',
			rowCount: 2
		});
		expect(order).toEqual([
			'begin',
			'select-teams',
			'select-pool-conflicts',
			'delete-rows',
			'insert-rows',
			'upsert-status',
			'commit'
		]);
		expect(deletedTeamIds).toEqual([LAKERS.id]);
		expect(insertedRows).toHaveLength(2);
		expect(insertedRows[0]).toMatchObject({ team_id: LAKERS.id, fantrax_player_id: 'P1' });
		expect(upsertedSources).toEqual([
			{ team_id: LAKERS.id, file_name: 'Lakers.csv', status: 'staged', refusal_detail: null }
		]);
		expect(released).toEqual([true]);
	});

	it('adds the resolved Team to claimedInBatch', async () => {
		const { gateway } = fakeGateway([LAKERS]);
		const claimed = new Set<string>();
		await stageRosterFile(gateway, 'Lakers.csv', HAPPY_CSV, claimed);
		expect(claimed.has(LAKERS.id)).toBe(true);
	});
});

describe('stageRosterFile — file-altitude refusals: nothing is written, nothing is staged', () => {
	it('refuses a file matching no Team, naming the file, without writing anything', async () => {
		const { gateway, order, deletedTeamIds, insertedRows, upsertedSources } = fakeGateway([CELTICS]);

		const outcome = await stageRosterFile(gateway, 'Grizzlies.csv', HAPPY_CSV);

		expect(outcome).toEqual({
			kind: 'refused_file',
			source: 'unknown',
			fileName: 'Grizzlies.csv',
			detail: fileNoMatchDetail('Grizzlies.csv')
		});
		expect(order).toEqual(['begin', 'select-teams', 'rollback']);
		expect(deletedTeamIds).toEqual([]);
		expect(insertedRows).toEqual([]);
		expect(upsertedSources).toEqual([]);
	});

	it('refuses a file matching more than one Team, without writing anything', async () => {
		const { gateway, order } = fakeGateway([
			{ id: 't-1', name: 'Kings' },
			{ id: 't-2', name: 'Wizards' }
		]);

		// "KingsWizards.csv" -> stem "kingswizards" exactly equals neither Team's
		// normalised name, but contains both "kings" and "wizards" as
		// substrings — ambiguous by construction, and resolved via the
		// substring fallback pass since no exact match exists.
		const outcome = await stageRosterFile(gateway, 'KingsWizards.csv', HAPPY_CSV);

		expect(outcome).toEqual({
			kind: 'refused_file',
			source: 'unknown',
			fileName: 'KingsWizards.csv',
			detail: fileAmbiguousDetail('KingsWizards.csv')
		});
		expect(order).toEqual(['begin', 'select-teams', 'rollback']);
	});

	it('refuses a second file in the same batch matching an already-claimed Team, without touching its status', async () => {
		const { gateway, order, upsertedSources } = fakeGateway([LAKERS]);
		const claimed = new Set<string>([LAKERS.id]);

		const outcome = await stageRosterFile(gateway, 'Lakers-2.csv', HAPPY_CSV, claimed);

		expect(outcome).toEqual({
			kind: 'refused_file',
			source: 'unknown',
			fileName: 'Lakers-2.csv',
			detail: fileAlreadySuppliedDetail('Lakers-2.csv', LAKERS.name)
		});
		expect(order).toEqual(['begin', 'select-teams', 'rollback']);
		expect(upsertedSources).toEqual([]);
	});

	it('the first file in a batch stages normally; only a later duplicate is refused', async () => {
		const { gateway: firstGateway } = fakeGateway([LAKERS]);
		const claimed = new Set<string>();
		const first = await stageRosterFile(firstGateway, 'Lakers.csv', HAPPY_CSV, claimed);
		expect(first.kind).toBe('staged');

		const { gateway: secondGateway } = fakeGateway([LAKERS]);
		const second = await stageRosterFile(secondGateway, 'Lakers-again.csv', HAPPY_CSV, claimed);
		expect(second.kind).toBe('refused_file');
	});
});

describe('stageRosterFile — content-altitude refusals over a Team with nothing currently staged', () => {
	it('refuses a bad-column file at content altitude, upserting refused_content (nothing was staged to protect)', async () => {
		const badCsv = `${ROSTER_COLUMNS.fantraxPlayerId},${ROSTER_COLUMNS.playerName}\nP1,Alice`;
		const { gateway, order, deletedTeamIds, insertedRows, upsertedSources } = fakeGateway([LAKERS]);

		const outcome = await stageRosterFile(gateway, 'Lakers.csv', badCsv);

		expect(outcome.kind).toBe('refused_content');
		expect(outcome.kind).toBe('refused_content');
		expect(outcome).toMatchObject({ source: 'team' });
		if (outcome.kind !== 'refused_content' || outcome.source !== 'team') return;
		expect(outcome.teamId).toBe(LAKERS.id);
		expect(outcome.detail).toContain(ROSTER_COLUMNS.capHit);
		// The refusal path always reads current status first now — here it
		// finds no row (the Team has never been staged), so it falls through to
		// the existing delete(no-op)+upsert(refused_content) behaviour.
		expect(order).toEqual([
			'begin',
			'select-teams',
			'select-status',
			'delete-rows',
			'upsert-status',
			'commit'
		]);
		expect(deletedTeamIds).toEqual([LAKERS.id]);
		expect(insertedRows).toEqual([]);
		expect(upsertedSources).toEqual([
			{
				team_id: LAKERS.id,
				file_name: 'Lakers.csv',
				status: 'refused_content',
				refusal_detail: outcome.detail
			}
		]);
	});

	it('refuses negative Cap Space, stating the arithmetic with a true minus sign', async () => {
		const bigCsv = [
			HEADER,
			`P1,Alice,${String(SALARY_CAP + 1_000_000)},Act,${endYearIn(1)}`
		].join('\n');
		const { gateway } = fakeGateway([LAKERS]);

		const outcome = await stageRosterFile(gateway, 'Lakers.csv', bigCsv);

		expect(outcome.kind).toBe('refused_content');
		expect(outcome.kind).toBe('refused_content');
		expect(outcome).toMatchObject({ source: 'team' });
		if (outcome.kind !== 'refused_content' || outcome.source !== 'team') return;
		expect(outcome.detail).toContain(String(SALARY_CAP));
		// U+2212 MINUS SIGN, not a hyphen.
		expect(outcome.detail).toContain('−$1000000');
		expect(outcome.detail).not.toContain('$-1000000');
	});

	it('refuses a breached slot ceiling, stating the arithmetic', async () => {
		const rows = Array.from(
			{ length: 13 },
			(_, i) => `P${String(i)},Player ${String(i)},0,Act,${endYearIn(0)}`
		);
		const overCsv = [HEADER, ...rows].join('\n');
		const { gateway } = fakeGateway([LAKERS]);

		const outcome = await stageRosterFile(gateway, 'Lakers.csv', overCsv);

		expect(outcome.kind).toBe('refused_content');
		expect(outcome.kind).toBe('refused_content');
		expect(outcome).toMatchObject({ source: 'team' });
		if (outcome.kind !== 'refused_content' || outcome.source !== 'team') return;
		expect(outcome.detail).toContain('Active/Bench');
		expect(outcome.detail).toContain('13');
		expect(outcome.detail).toContain('12');
	});

	it('re-supply after fix: a second, valid call for the same Team stages and replaces its rows', async () => {
		const badCsv = `${ROSTER_COLUMNS.fantraxPlayerId},${ROSTER_COLUMNS.playerName}\nP1,Alice`;
		const { gateway: firstGateway } = fakeGateway([LAKERS]);
		const first = await stageRosterFile(firstGateway, 'Lakers.csv', badCsv);
		expect(first.kind).toBe('refused_content');

		const { gateway: secondGateway, order, deletedTeamIds } = fakeGateway([LAKERS]);
		const second = await stageRosterFile(secondGateway, 'Lakers-fixed.csv', HAPPY_CSV);

		expect(second.kind).toBe('staged');
		// Each call's own transaction still deletes before inserting — the
		// "old rows replaced" guarantee is per-call, one team_id, one delete,
		// then the new rows.
		expect(order).toContain('delete-rows');
		expect(deletedTeamIds).toEqual([LAKERS.id]);
	});
});

describe('stageRosterFile — a refused re-supply over an already-staged Team leaves it untouched', () => {
	it('a Team already staged keeps its rows and status when a later re-supply attempt is refused', async () => {
		const { gateway: firstGateway } = fakeGateway([LAKERS]);
		const first = await stageRosterFile(firstGateway, 'Lakers.csv', HAPPY_CSV);
		expect(first.kind).toBe('staged');

		// Same Team, seeded as already `staged`, in a fresh gateway/transaction —
		// this is what a second, later upload attempt looks like.
		const badCsv = `${ROSTER_COLUMNS.fantraxPlayerId},${ROSTER_COLUMNS.playerName}\nP1,Alice`;
		const { gateway, order, deletedTeamIds, insertedRows, upsertedSources } = fakeGateway([LAKERS], {
			[LAKERS.id]: { status: 'staged' }
		});

		const outcome = await stageRosterFile(gateway, 'Lakers-bad.csv', badCsv);

		// The refusal is still reported to the caller...
		expect(outcome.kind).toBe('refused_content');
		expect(outcome.kind).toBe('refused_content');
		expect(outcome).toMatchObject({ source: 'team' });
		if (outcome.kind !== 'refused_content' || outcome.source !== 'team') return;
		expect(outcome.teamId).toBe(LAKERS.id);
		expect(outcome.detail).toContain(ROSTER_COLUMNS.capHit);

		// ...but nothing at all is written: the status read finds `staged` and
		// the function returns before any delete, insert, or upsert.
		expect(order).toEqual(['begin', 'select-teams', 'select-status', 'commit']);
		expect(deletedTeamIds).toEqual([]);
		expect(insertedRows).toEqual([]);
		expect(upsertedSources).toEqual([]);
	});

	it('a Team with a prior non-staged status (e.g. refused_content) still has the refusal recorded', async () => {
		const badCsv = `${ROSTER_COLUMNS.fantraxPlayerId},${ROSTER_COLUMNS.playerName}\nP1,Alice`;
		const { gateway, order, upsertedSources } = fakeGateway([LAKERS], {
			[LAKERS.id]: { status: 'refused_content' }
		});

		const outcome = await stageRosterFile(gateway, 'Lakers.csv', badCsv);

		expect(outcome.kind).toBe('refused_content');
		expect(order).toEqual([
			'begin',
			'select-teams',
			'select-status',
			'delete-rows',
			'upsert-status',
			'commit'
		]);
		expect(upsertedSources).toHaveLength(1);
	});
});

describe('stageRosterFile — the pool/roster conflict, roster-last direction (Story 1.8)', () => {
	it('refuses a roster whose Player is already in the staged pool, naming the Player and the Team', async () => {
		const { gateway, order, insertedRows, upsertedSources } = fakeGateway(
			[LAKERS],
			{},
			{ P2: 'Bob' }
		);

		const outcome = await stageRosterFile(gateway, 'Lakers.csv', HAPPY_CSV);

		expect(outcome.kind).toBe('refused_content');
		expect(outcome.kind).toBe('refused_content');
		expect(outcome).toMatchObject({ source: 'team' });
		if (outcome.kind !== 'refused_content' || outcome.source !== 'team') return;
		expect(outcome.teamName).toBe(LAKERS.name);
		// The SAME sentence the pool direction produces — both call the one
		// pure function, so the two paths cannot word it differently.
		expect(outcome.detail).toBe(
			poolConflictRefusalDetail([{ playerName: 'Bob', teamName: LAKERS.name }])
		);
		expect(outcome.detail).toContain('Bob');
		expect(outcome.detail).toContain('Lakers');
		expect(order).toEqual([
			'begin',
			'select-teams',
			'select-pool-conflicts',
			'select-status',
			'delete-rows',
			'upsert-status',
			'commit'
		]);
		expect(insertedRows).toEqual([]);
		expect(upsertedSources).toHaveLength(1);
	});

	it('names the pool row Player name, so both directions name the Player identically', async () => {
		const { gateway } = fakeGateway([LAKERS], {}, { P1: 'Alice' });
		const outcome = await stageRosterFile(gateway, 'Lakers.csv', HAPPY_CSV);
		expect(outcome.kind).toBe('refused_content');
		if (outcome.kind !== 'refused_content') return;
		expect(outcome.detail).toContain('Alice');
	});

	it('stages normally when the staged pool holds none of these Players', async () => {
		const { gateway } = fakeGateway([LAKERS], {}, { P99: 'Someone Else' });
		const outcome = await stageRosterFile(gateway, 'Lakers.csv', HAPPY_CSV);
		expect(outcome.kind).toBe('staged');
	});

	it('a conflict over an already-staged Team leaves that Team untouched', async () => {
		const { gateway, order, deletedTeamIds, upsertedSources } = fakeGateway(
			[LAKERS],
			{ [LAKERS.id]: { status: 'staged' } },
			{ P2: 'Bob' }
		);

		const outcome = await stageRosterFile(gateway, 'Lakers-bad.csv', HAPPY_CSV);

		expect(outcome.kind).toBe('refused_content');
		expect(order).toEqual([
			'begin',
			'select-teams',
			'select-pool-conflicts',
			'select-status',
			'commit'
		]);
		expect(deletedTeamIds).toEqual([]);
		expect(upsertedSources).toEqual([]);
	});
});
