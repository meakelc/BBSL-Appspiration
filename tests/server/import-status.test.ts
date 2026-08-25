import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadImportStatus, outstandingTeamNames } from '../../src/lib/server/import-status.ts';
import type { TeamImportStatus } from '../../src/lib/server/import-status.ts';

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
