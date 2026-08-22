import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { managerRegistry } from '../src/lib/server/supabase.ts';

/**
 * `managerRegistry().findByDiscordUserId`, exercised against a stub
 * `SupabaseClient` rather than a hand-built `ManagerRegistry` fixture.
 *
 * Every other test in this suite (`auth.test.ts`, `session.test.ts`) injects
 * a `ManagerRegistry` object literal directly, which proves the *consumers*
 * of a `RegisteredManager` behave correctly but never runs the actual
 * `.select(...)` query string or the `teams` embed unwrap in `supabase.ts`.
 * A wrong embed key, a swapped `team_id`/`is_commissioner` mapping, or a
 * broken array-unwrap would ship green under those tests alone. This file
 * drives the real mapping function against representative Postgrest response
 * shapes — the best available proof of the mapping without a live Postgres
 * instance.
 */

/** What the fake client recorded about the call it received. */
type RecordedCall = {
	table?: string;
	select?: string;
	eqColumn?: string;
	eqValue?: string;
};

/**
 * A minimal stand-in for the one chain `findByDiscordUserId` calls:
 * `client.from('managers').select(...).eq('discord_user_id', id).maybeSingle()`.
 * Records what it was asked so a test can assert the query shape, and hands
 * back exactly the Postgrest-shaped response the test wants.
 */
function fakeClient(response: {
	data: unknown;
	error: { message: string } | null;
}): { client: SupabaseClient; calls: RecordedCall } {
	const calls: RecordedCall = {};
	const chain = {
		select(columns: string) {
			calls.select = columns;
			return chain;
		},
		eq(column: string, value: string) {
			calls.eqColumn = column;
			calls.eqValue = value;
			return chain;
		},
		async maybeSingle() {
			return response;
		}
	};
	const client = {
		from(table: string) {
			calls.table = table;
			return chain;
		}
	};
	return { client: client as unknown as SupabaseClient, calls };
}

describe('managerRegistry().findByDiscordUserId — the real query and mapping', () => {
	it('queries the managers table by discord_user_id, selecting the Team-binding columns', async () => {
		const { client, calls } = fakeClient({
			data: {
				id: 'm-1',
				discord_user_id: '111111111111111111',
				display_name: 'Alice',
				team_id: null,
				is_commissioner: false,
				teams: null
			},
			error: null
		});
		await managerRegistry(client).findByDiscordUserId('111111111111111111');

		expect(calls.table).toBe('managers');
		expect(calls.select).toContain('team_id');
		expect(calls.select).toContain('is_commissioner');
		expect(calls.select).toContain('teams(name)');
		expect(calls.eqColumn).toBe('discord_user_id');
		expect(calls.eqValue).toBe('111111111111111111');
	});

	it('maps a Team embedded as a single object (the ordinary Postgrest shape)', async () => {
		const { client } = fakeClient({
			data: {
				id: 'm-1',
				discord_user_id: '111111111111111111',
				display_name: 'Alice',
				team_id: 't-1',
				is_commissioner: false,
				teams: { name: 'Lakers' }
			},
			error: null
		});
		const manager = await managerRegistry(client).findByDiscordUserId('111111111111111111');

		expect(manager).toEqual({
			id: 'm-1',
			discordUserId: '111111111111111111',
			displayName: 'Alice',
			teamId: 't-1',
			teamName: 'Lakers',
			isCommissioner: false
		});
	});

	it('maps a Team embedded as a single-element array, the defensive shape', async () => {
		const { client } = fakeClient({
			data: {
				id: 'm-2',
				discord_user_id: '222222222222222222',
				display_name: 'Bob',
				team_id: 't-2',
				is_commissioner: true,
				teams: [{ name: 'Celtics' }]
			},
			error: null
		});
		const manager = await managerRegistry(client).findByDiscordUserId('222222222222222222');

		expect(manager).toEqual({
			id: 'm-2',
			discordUserId: '222222222222222222',
			displayName: 'Bob',
			teamId: 't-2',
			teamName: 'Celtics',
			isCommissioner: true
		});
	});

	it('maps no Team yet (team_id and the embed both null) to teamId/teamName null, without crashing', async () => {
		const { client } = fakeClient({
			data: {
				id: 'm-3',
				discord_user_id: '333333333333333333',
				display_name: 'Cara',
				team_id: null,
				is_commissioner: false,
				teams: null
			},
			error: null
		});
		const manager = await managerRegistry(client).findByDiscordUserId('333333333333333333');

		expect(manager).toEqual({
			id: 'm-3',
			discordUserId: '333333333333333333',
			displayName: 'Cara',
			teamId: null,
			teamName: null,
			isCommissioner: false
		});
	});

	it('correctly keeps is_commissioner and team_id independent — a Commissioner with no Team maps both correctly', async () => {
		const { client } = fakeClient({
			data: {
				id: 'm-4',
				discord_user_id: '444444444444444444',
				display_name: 'Dana',
				team_id: null,
				is_commissioner: true,
				teams: null
			},
			error: null
		});
		const manager = await managerRegistry(client).findByDiscordUserId('444444444444444444');

		expect(manager?.isCommissioner).toBe(true);
		expect(manager?.teamId).toBeNull();
		expect(manager?.teamName).toBeNull();
	});

	it('derives an identical teamName for two managers sharing one team_id (AC5, against the real mapping)', async () => {
		const sharedTeam = { name: 'Warriors' };
		const { client: firstClient } = fakeClient({
			data: {
				id: 'm-5',
				discord_user_id: '555555555555555555',
				display_name: 'Eve',
				team_id: 't-shared',
				is_commissioner: false,
				teams: sharedTeam
			},
			error: null
		});
		const { client: secondClient } = fakeClient({
			data: {
				id: 'm-6',
				discord_user_id: '666666666666666666',
				display_name: 'Frank',
				team_id: 't-shared',
				is_commissioner: false,
				teams: sharedTeam
			},
			error: null
		});

		const first = await managerRegistry(firstClient).findByDiscordUserId('555555555555555555');
		const second = await managerRegistry(secondClient).findByDiscordUserId('666666666666666666');

		expect(first?.teamId).toBe(second?.teamId);
		expect(first?.teamName).toBe(second?.teamName);
		expect(first?.teamName).toBe('Warriors');
	});

	it('returns null for no matching row, rather than throwing', async () => {
		const { client } = fakeClient({ data: null, error: null });
		const manager = await managerRegistry(client).findByDiscordUserId('999999999999999999');
		expect(manager).toBeNull();
	});

	it('throws on a query error rather than returning null — an outage is not "unregistered"', async () => {
		const { client } = fakeClient({ data: null, error: { message: 'connection refused' } });
		await expect(managerRegistry(client).findByDiscordUserId('111111111111111111')).rejects.toThrow(
			/connection refused/
		);
	});
});
