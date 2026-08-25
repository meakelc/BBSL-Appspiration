import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
	loadImportStatus,
	loadPoolStatus,
	outstandingSourceNames,
	outstandingTeamNames
} from '../../src/lib/server/import-status.ts';
import type { PoolImportStatus, TeamImportStatus } from '../../src/lib/server/import-status.ts';

function fakeClient(rows: unknown[]): SupabaseClient {
	const query = {
		select: () => query,
		order: async () => ({ data: rows, error: null })
	};
	return { from: () => query } as unknown as SupabaseClient;
}

function failingClient(message: string): SupabaseClient {
	const query = {
		select: () => query,
		order: async () => ({ data: null, error: { message } })
	};
	return { from: () => query } as unknown as SupabaseClient;
}

describe('loadImportStatus', () => {
	it('maps a staged Team, carrying its file name and updated_at', async () => {
		const client = fakeClient([
			{
				id: 't-1',
				name: 'Lakers',
				import_team_sources: {
					file_name: 'Lakers.csv',
					status: 'staged',
					refusal_detail: null,
					updated_at: '2026-08-24T00:00:00.000Z'
				}
			}
		]);
		expect(await loadImportStatus(client)).toEqual([
			{
				teamId: 't-1',
				teamName: 'Lakers',
				status: 'staged',
				fileName: 'Lakers.csv',
				refusalDetail: null,
				updatedAt: '2026-08-24T00:00:00.000Z'
			}
		]);
	});

	it('maps a Team with no import_team_sources row to outstanding, with every field null', async () => {
		const client = fakeClient([{ id: 't-1', name: 'Lakers', import_team_sources: null }]);
		expect(await loadImportStatus(client)).toEqual([
			{
				teamId: 't-1',
				teamName: 'Lakers',
				status: 'outstanding',
				fileName: null,
				refusalDetail: null,
				updatedAt: null
			}
		]);
	});

	it('maps a refused_content Team, carrying its refusal detail', async () => {
		const client = fakeClient([
			{
				id: 't-1',
				name: 'Lakers',
				import_team_sources: {
					file_name: 'Lakers.csv',
					status: 'refused_content',
					refusal_detail: 'Cap Space is negative.',
					updated_at: '2026-08-24T00:00:00.000Z'
				}
			}
		]);
		const [entry] = await loadImportStatus(client);
		expect(entry?.status).toBe('refused_content');
		expect(entry?.refusalDetail).toBe('Cap Space is negative.');
	});

	it('unwraps the defensive array-embed shape the same as a single object', async () => {
		const client = fakeClient([
			{
				id: 't-1',
				name: 'Lakers',
				import_team_sources: [
					{
						file_name: 'Lakers.csv',
						status: 'staged',
						refusal_detail: null,
						updated_at: '2026-08-24T00:00:00.000Z'
					}
				]
			}
		]);
		const [entry] = await loadImportStatus(client);
		expect(entry?.status).toBe('staged');
	});

	it('throws on a query failure rather than reporting an empty list', async () => {
		await expect(loadImportStatus(failingClient('connection refused'))).rejects.toThrow(
			/connection refused/
		);
	});
});

describe('outstandingTeamNames', () => {
	it('names every Team whose status is not staged, and none that are', () => {
		const statuses: TeamImportStatus[] = [
			{
				teamId: 't-1',
				teamName: 'Lakers',
				status: 'staged',
				fileName: 'Lakers.csv',
				refusalDetail: null,
				updatedAt: null
			},
			{
				teamId: 't-2',
				teamName: 'Celtics',
				status: 'outstanding',
				fileName: null,
				refusalDetail: null,
				updatedAt: null
			},
			{
				teamId: 't-3',
				teamName: 'Warriors',
				status: 'refused_content',
				fileName: 'Warriors.csv',
				refusalDetail: 'bad row',
				updatedAt: null
			}
		];
		expect(outstandingTeamNames(statuses)).toEqual(['Celtics', 'Warriors']);
	});

	it('returns empty when every Team has staged', () => {
		const statuses: TeamImportStatus[] = [
			{
				teamId: 't-1',
				teamName: 'Lakers',
				status: 'staged',
				fileName: 'Lakers.csv',
				refusalDetail: null,
				updatedAt: null
			}
		];
		expect(outstandingTeamNames(statuses)).toEqual([]);
	});
});


// --- Story 1.8: the Free Agent pool as the thirty-first source ------------

/**
 * `loadPoolStatus` issues TWO reads against different tables — the singleton
 * status row, then a head-only count of the staged Players — so this fake
 * answers per table rather than returning one canned row set.
 */
function fakePoolClient(options: {
	source?: Record<string, unknown> | null;
	count?: number | null;
	sourceError?: string;
}) {
	// ONE query against the `import_pool_status` view, which carries the
	// status and the size in a single row -- so a fake that answered two
	// separate reads could no longer represent what the code does
	// (review-loop-iteration 1).
	return {
		from(table: string) {
			if (table !== 'import_pool_status') {
				throw new Error(`unexpected table read: ${table}`);
			}
			const query = {
				select: () => query,
				maybeSingle: async () => {
					if (options.sourceError !== undefined) {
						return { data: null, error: { message: options.sourceError } };
					}
					const source = options.source ?? null;
					if (source === null) return { data: null, error: null };
					return {
						data: { ...source, player_count: options.count ?? 0 },
						error: null
					};
				}
			};
			return query;
		}
	} as unknown as SupabaseClient;
}

const STAGED_POOL: PoolImportStatus = {
	status: 'staged',
	fileName: 'free-agents.csv',
	refusalDetail: null,
	updatedAt: null,
	playerCount: 214
};

const OUTSTANDING_POOL: PoolImportStatus = {
	status: 'outstanding',
	fileName: null,
	refusalDetail: null,
	updatedAt: null,
	playerCount: 0
};

describe('loadPoolStatus', () => {
	it('maps a staged pool, carrying its file name and its player count', async () => {
		const client = fakePoolClient({
			source: {
				file_name: 'free-agents.csv',
				status: 'staged',
				refusal_detail: null,
				updated_at: '2026-08-24T00:00:00.000Z'
			},
			count: 214
		});
		expect(await loadPoolStatus(client)).toEqual({
			status: 'staged',
			fileName: 'free-agents.csv',
			refusalDetail: null,
			updatedAt: '2026-08-24T00:00:00.000Z',
			playerCount: 214
		});
	});

	it('maps a missing status row to outstanding, every field null, count zero', async () => {
		expect(await loadPoolStatus(fakePoolClient({ source: null, count: 0 }))).toEqual({
			status: 'outstanding',
			fileName: null,
			refusalDetail: null,
			updatedAt: null,
			playerCount: 0
		});
	});

	it('maps a refused pool, carrying its refusal detail', async () => {
		const client = fakePoolClient({
			source: {
				file_name: 'pool.csv',
				status: 'refused_content',
				refusal_detail: 'A Player cannot be both a Free Agent and on a Team roster: Bob is on Lakers.',
				updated_at: '2026-08-24T00:00:00.000Z'
			},
			count: 0
		});
		const status = await loadPoolStatus(client);
		expect(status.status).toBe('refused_content');
		expect(status.refusalDetail).toContain('Bob');
	});

	it('throws on a status read failure rather than reporting an empty pool', async () => {
		await expect(loadPoolStatus(fakePoolClient({ sourceError: 'connection refused' }))).rejects.toThrow(
			/connection refused/
		);
	});

	it('falls back to outstanding rather than trusting an unknown status string', () => {
		// An unrecognised status is a defect upstream, not a new state. Falling
		// back to 'outstanding' under-claims: the pool stays named on the
		// outstanding list instead of silently passing a gate.
		return expect(
			loadPoolStatus(
				fakePoolClient({
					source: {
						file_name: 'free-agents.csv',
						status: 'not-a-real-status',
						refusal_detail: null,
						updated_at: null
					},
					count: 3
				})
			)
		).resolves.toMatchObject({ status: 'outstanding' });
	});
});

describe('outstandingSourceNames — one list, thirty-one sources', () => {
	const LAKERS_STAGED: TeamImportStatus = {
		teamId: 't-1',
		teamName: 'Lakers',
		status: 'staged',
		fileName: 'Lakers.csv',
		refusalDetail: null,
		updatedAt: null
	};
	const CELTICS_OUTSTANDING: TeamImportStatus = {
		teamId: 't-2',
		teamName: 'Celtics',
		status: 'outstanding',
		fileName: null,
		refusalDetail: null,
		updatedAt: null
	};

	it('names the Free Agent pool alongside outstanding Teams', () => {
		expect(outstandingSourceNames([LAKERS_STAGED, CELTICS_OUTSTANDING], OUTSTANDING_POOL)).toEqual([
			'Celtics',
			'Free Agent pool'
		]);
	});

	it('omits the pool once it is staged', () => {
		expect(outstandingSourceNames([LAKERS_STAGED, CELTICS_OUTSTANDING], STAGED_POOL)).toEqual([
			'Celtics'
		]);
	});

	it('returns empty only when every Team and the pool have staged', () => {
		expect(outstandingSourceNames([LAKERS_STAGED], STAGED_POOL)).toEqual([]);
	});

	it('names the pool when every Team has staged but the pool has not', () => {
		expect(outstandingSourceNames([LAKERS_STAGED], OUTSTANDING_POOL)).toEqual(['Free Agent pool']);
	});

	it('agrees with outstandingTeamNames on the Team half — one rule, not two', () => {
		const statuses = [LAKERS_STAGED, CELTICS_OUTSTANDING];
		expect(outstandingSourceNames(statuses, STAGED_POOL)).toEqual(outstandingTeamNames(statuses));
	});
});
