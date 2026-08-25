import { describe, expect, it } from 'vitest';

import {
	isPoolFileName,
	poolFileNameShadowsTeam,
	poolShadowsTeamDetail,
	poolShadowsTeamsDetail
} from '../../src/lib/server/pool-registry.ts';
import type { TeamRecord } from '../../src/lib/server/team-registry.ts';

const LAKERS: TeamRecord = { id: 't-1', name: 'Lakers' };
const CELTICS: TeamRecord = { id: 't-2', name: 'Celtics' };
const TEAMS = [LAKERS, CELTICS];

describe('isPoolFileName — pure, no I/O', () => {
	it.each([
		'free-agents.csv',
		'FreeAgents.csv',
		'Free Agent Pool 2026.csv',
		'BBSL_free_agents_export.CSV',
		'pool.csv',
		'POOL.CSV',
		'pool'
	])('recognises %s as the Free Agent pool file', (fileName: string) => {
		expect(isPoolFileName(fileName)).toBe(true);
	});

	it.each(['Lakers.csv', 'Celtics_roster.csv', 'rosters.csv', 'agents.csv'])(
		'does not recognise %s as the pool file',
		(fileName: string) => {
			expect(isPoolFileName(fileName)).toBe(false);
		}
	);

	it('matches "pool" only as the whole stem, never as a substring', () => {
		// A real Team could plausibly be named something containing "Pool"; a
		// substring rule there would let this function shadow that Team's roster
		// file silently, which is a data-loss shape.
		expect(isPoolFileName('Liverpool.csv')).toBe(false);
		expect(isPoolFileName('pool-2026.csv')).toBe(false);
	});
});

describe('poolFileNameShadowsTeam — refuse, never guess', () => {
	it('returns null for a pool name that resolves to no Team', () => {
		expect(poolFileNameShadowsTeam(TEAMS, 'free-agents.csv')).toBeNull();
	});

	it('returns null for a file that is not a pool name at all', () => {
		expect(poolFileNameShadowsTeam(TEAMS, 'Lakers.csv')).toBeNull();
	});

	it('returns the Team a pool-looking name would also resolve to', () => {
		const teams = [...TEAMS, { id: 't-3', name: 'Free Agents' }];
		expect(poolFileNameShadowsTeam(teams, 'Free Agents.csv')).toEqual({
			kind: 'shadowed',
			team: { id: 't-3', name: 'Free Agents' }
		});
	});

	it('refuses an ambiguous match rather than reading it as no shadow', () => {
		// `resolveTeamByFileName` reports `ambiguous` when a name resolves to
		// more than one Team. Treating that as "no shadow" would stage as the
		// pool exactly the file whose Team is least certain -- the data-loss
		// shape this function exists to prevent, reached by the one path that
		// looked safe (review-loop-iteration 1).
		const teams = [
			{ id: 't-3', name: 'Free Agents' },
			{ id: 't-4', name: 'Free Agents' }
		];
		const result = poolFileNameShadowsTeam(teams, 'Free Agents.csv');
		expect(result).not.toBeNull();
		expect(result).toMatchObject({ kind: 'ambiguous' });
	});

	it('names every candidate Team when the match is ambiguous', () => {
		const detail = poolShadowsTeamsDetail('Free Agents.csv', [
			{ id: 't-3', name: 'Free Agents' },
			{ id: 't-4', name: 'Free Agents East' }
		]);
		expect(detail).toContain('Free Agents.csv');
		expect(detail).toContain('Free Agents East');
		expect(detail).toContain('more than one Team');
	});

	it('names both the file and the shadowed Team in its refusal sentence', () => {
		const detail = poolShadowsTeamDetail('Free Agents.csv', 'Free Agents');
		expect(detail).toContain('Free Agents.csv');
		expect(detail).toContain('Free Agent pool');
	});
});
