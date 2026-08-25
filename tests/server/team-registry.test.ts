import { describe, expect, it } from 'vitest';

import { resolveTeamByFileName } from '../../src/lib/server/team-registry.ts';
import type { TeamRecord } from '../../src/lib/server/team-registry.ts';

const LAKERS: TeamRecord = { id: 't-1', name: 'Lakers' };
const CELTICS: TeamRecord = { id: 't-2', name: 'Celtics' };
const WARRIORS: TeamRecord = { id: 't-3', name: 'Warriors' };

describe('resolveTeamByFileName — pure, no I/O', () => {
	const teams = [LAKERS, CELTICS, WARRIORS];

	it('matches a file name equal to the Team name plus an extension', () => {
		expect(resolveTeamByFileName(teams, 'Lakers.csv')).toEqual({ kind: 'matched', team: LAKERS });
	});

	it('matches case-insensitively and ignoring punctuation/spacing', () => {
		expect(resolveTeamByFileName(teams, 'lakers_roster_2026.csv')).toEqual({
			kind: 'matched',
			team: LAKERS
		});
		expect(resolveTeamByFileName(teams, 'LAKERS - Roster.CSV')).toEqual({
			kind: 'matched',
			team: LAKERS
		});
	});

	it('falls back to substring containment when no exact match exists', () => {
		expect(resolveTeamByFileName(teams, 'Team_Celtics_Export.csv')).toEqual({
			kind: 'matched',
			team: CELTICS
		});
	});

	it('prefers an exact match over a substring match when both are available', () => {
		const withOverlap = [LAKERS, { id: 't-4', name: 'Lakers Export' }];
		expect(resolveTeamByFileName(withOverlap, 'Lakers.csv')).toEqual({ kind: 'matched', team: LAKERS });
	});

	it('reports unmatched when no Team name appears in the file name', () => {
		expect(resolveTeamByFileName(teams, 'Grizzlies.csv')).toEqual({ kind: 'unmatched' });
	});

	it('reports ambiguous when more than one Team name appears and no exact match resolves it', () => {
		const kingsAndWizards: TeamRecord[] = [
			{ id: 't-5', name: 'Kings' },
			{ id: 't-6', name: 'Wizards' }
		];
		const result = resolveTeamByFileName(kingsAndWizards, 'KingsWizards.csv');
		expect(result.kind).toBe('ambiguous');
	});

	it('never matches a blank-named Team', () => {
		const blank: TeamRecord[] = [{ id: 't-7', name: '   ' }];
		expect(resolveTeamByFileName(blank, 'anything.csv')).toEqual({ kind: 'unmatched' });
	});

	it('handles a file name with no extension', () => {
		expect(resolveTeamByFileName(teams, 'Lakers')).toEqual({ kind: 'matched', team: LAKERS });
	});
});

// `listOutstandingTeams` was removed from this module at review-loop-iteration
// 1 — it duplicated `import-status.ts`'s `loadImportStatus`/
// `outstandingTeamNames` against a separate query with no production caller.
// That logic, and its tests, now live only in
// `tests/server/import-status.test.ts`.
