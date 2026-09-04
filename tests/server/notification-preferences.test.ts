/**
 * The SvelteKit-side preference read and upsert, EXECUTED (Story 5.4).
 *
 * `tests/routes/notifications.test.ts` replaces this whole module with
 * `vi.mock`, which is right for a route test and leaves the SQL itself unrun —
 * so a wrong column name or a broken conflict target would ship green. This
 * suite drives the real functions against a hand-rolled `ConnectionGateway`, in
 * `tests/server/roster-import.test.ts`'s style: a fake client that records every
 * statement and its params, answers exactly the two this module issues, and
 * keeps a tiny in-memory table so a write round-trips into the next read the way
 * two transactions against one real database would.
 *
 * What is NOT here: what a mute DOES. That is composition's, proved in
 * `tests/adapters/discord-mention.test.ts`, and the drain's own read is a left
 * join proved in `tests/server/outbox.test.ts`. This module only stores the
 * answer.
 */

import { describe, expect, it } from 'vitest';

import {
	DEFAULT_NOTIFICATION_PREFERENCES,
	loadNotificationPreferences,
	setSlotReleaseMuted
} from '../../src/lib/server/notification-preferences.ts';
import type {
	ConnectionGateway,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

const MANAGER = 'm-1';
const OTHER = 'm-2';

/**
 * A fake gateway over an in-memory `manager_notification_preferences`.
 *
 * `stored` may hold a driver's STRING spelling as well as a boolean, because
 * `isTrueFlag` accepts `'t'`/`'true'` and a fixture that could only produce real
 * booleans would leave that branch unrun here as it did in the drain.
 */
function fakeGateway(
	stored: Record<string, boolean | string> = {},
	options: { failEvery?: boolean } = {}
): {
	gateway: ConnectionGateway;
	queries: Array<{ sql: string; params: readonly unknown[] }>;
	released: number;
	rows: Map<string, boolean | string>;
	releasedCount(): number;
} {
	const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
	const rows = new Map<string, boolean | string>(Object.entries(stored));
	let released = 0;

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, params: readonly unknown[] = []) {
			const sql = text.trim().replace(/\s+/g, ' ');
			queries.push({ sql, params });
			if (options.failEvery === true) throw new Error('the read connection died');

			if (/^select slot_release_muted from manager_notification_preferences/i.test(sql)) {
				const managerId = String(params[0]);
				if (!rows.has(managerId)) return { rows: [] };
				return { rows: [{ slot_release_muted: rows.get(managerId) }] };
			}
			if (/^insert into manager_notification_preferences/i.test(sql)) {
				// The `on conflict (manager_id) do update`, as the real statement
				// spells it: last writer wins on the one key.
				rows.set(String(params[0]), params[1] as boolean);
				return { rows: [] };
			}
			throw new Error(`unexpected statement: ${sql}`);
		},
		release() {
			released += 1;
		}
	};

	return {
		gateway: { connect: async () => client },
		queries,
		get released() {
			return released;
		},
		rows,
		releasedCount: () => released
	};
}

describe('loadNotificationPreferences', () => {
	it('reads the one column, keyed on the Manager, and nothing else', async () => {
		const harness = fakeGateway({ [MANAGER]: true });

		const preferences = await loadNotificationPreferences(harness.gateway, MANAGER);

		expect(preferences).toEqual({ slotReleaseMuted: true });
		expect(harness.queries).toHaveLength(1);
		// The column and the table, spelled — this is the assertion a wrong
		// name fails, and the route test cannot make it.
		expect(harness.queries[0]?.sql).toBe(
			'select slot_release_muted from manager_notification_preferences where manager_id = $1'
		);
		// Parameterised, never interpolated.
		expect(harness.queries[0]?.params).toEqual([MANAGER]);
	});

	it('reads a Manager with NO row as the default, not as an error', async () => {
		const harness = fakeGateway({ [OTHER]: true });

		expect(await loadNotificationPreferences(harness.gateway, MANAGER)).toEqual(
			DEFAULT_NOTIFICATION_PREFERENCES
		);
		expect(DEFAULT_NOTIFICATION_PREFERENCES).toEqual({ slotReleaseMuted: false });
	});

	it('reads a stored false as not muted', async () => {
		const harness = fakeGateway({ [MANAGER]: false });
		expect(await loadNotificationPreferences(harness.gateway, MANAGER)).toEqual({
			slotReleaseMuted: false
		});
	});

	it.each([
		['t', true],
		['true', true],
		['T', true],
		['f', false],
		['false', false],
		['', false]
	])('reads a driver’s %s as %s', async (spelling: string, expected: boolean) => {
		// `isTrueFlag`'s string branch — ONE copy of it now, imported from
		// `outbox.ts`, so this and the drain cannot disagree about a row.
		const harness = fakeGateway({ [MANAGER]: spelling });
		expect(await loadNotificationPreferences(harness.gateway, MANAGER)).toEqual({
			slotReleaseMuted: expected
		});
	});

	it('releases the connection, and releases it after a failure too', async () => {
		const ok = fakeGateway({ [MANAGER]: true });
		await loadNotificationPreferences(ok.gateway, MANAGER);
		expect(ok.releasedCount()).toBe(1);

		// Throws on a read failure rather than answering the default: an
		// unreachable database and a Manager who has muted nothing must never
		// render the same screen.
		const broken = fakeGateway({}, { failEvery: true });
		await expect(loadNotificationPreferences(broken.gateway, MANAGER)).rejects.toThrow(
			'the read connection died'
		);
		expect(broken.releasedCount()).toBe(1);
	});
});

describe('setSlotReleaseMuted', () => {
	it('upserts on (manager_id), so a second change updates rather than collides', async () => {
		const harness = fakeGateway();

		const result = await setSlotReleaseMuted(harness.gateway, MANAGER, true);

		expect(result).toEqual({ slotReleaseMuted: true });
		expect(harness.queries).toHaveLength(1);
		expect(harness.queries[0]?.sql).toBe(
			'insert into manager_notification_preferences (manager_id, slot_release_muted) ' +
				'values ($1, $2) on conflict (manager_id) do update set ' +
				'slot_release_muted = excluded.slot_release_muted'
		);
		expect(harness.queries[0]?.params).toEqual([MANAGER, true]);
	});

	it('round-trips: what was written is what the next read answers', async () => {
		const harness = fakeGateway();

		expect(await loadNotificationPreferences(harness.gateway, MANAGER)).toEqual({
			slotReleaseMuted: false
		});

		await setSlotReleaseMuted(harness.gateway, MANAGER, true);
		expect(await loadNotificationPreferences(harness.gateway, MANAGER)).toEqual({
			slotReleaseMuted: true
		});

		// Unmuting is a VALUE and not the absence of a row — there is no delete
		// path, so the state has exactly one spelling.
		await setSlotReleaseMuted(harness.gateway, MANAGER, false);
		expect(await loadNotificationPreferences(harness.gateway, MANAGER)).toEqual({
			slotReleaseMuted: false
		});
		expect(harness.rows.has(MANAGER)).toBe(true);
	});

	it('writes only the Manager it was given', async () => {
		const harness = fakeGateway({ [OTHER]: true });

		await setSlotReleaseMuted(harness.gateway, MANAGER, true);

		expect(await loadNotificationPreferences(harness.gateway, OTHER)).toEqual({
			slotReleaseMuted: true
		});
		expect([...harness.rows.keys()].sort()).toEqual([MANAGER, OTHER]);
	});

	it('releases the connection, and releases it after a failure too', async () => {
		const ok = fakeGateway();
		await setSlotReleaseMuted(ok.gateway, MANAGER, true);
		expect(ok.releasedCount()).toBe(1);

		const broken = fakeGateway({}, { failEvery: true });
		await expect(setSlotReleaseMuted(broken.gateway, MANAGER, true)).rejects.toThrow(
			'the read connection died'
		);
		expect(broken.releasedCount()).toBe(1);
	});
});
