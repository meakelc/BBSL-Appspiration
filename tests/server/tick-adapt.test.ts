/**
 * The Deno gateway's `deno-postgres` → `TransactionalClient` translation
 * (Story 3.5).
 *
 * Every close and every heartbeat write in production goes through `adapt`.
 * `gateway.ts` itself cannot be reached from here — it imports the bare
 * specifier `postgres` — so the translation lives in `adapt.ts`, typed
 * structurally against the client it needs, and this file drives it with a
 * fake shaped like `PoolClient`. A `deno test` would not substitute: CI runs no
 * Deno step, so it would be a test that exists and never runs.
 */

import { describe, expect, it, vi } from 'vitest';

import { adapt } from '../../supabase/functions/tick/adapt.ts';
import type { PooledClient } from '../../supabase/functions/tick/adapt.ts';

/** A `PoolClient`-shaped fake that records exactly how it was called. */
function fakeClient(
	options: { rows?: unknown[]; release?: () => unknown } = {}
): PooledClient & { calls: Array<{ text: string; args: unknown[] }>; released: number } {
	const calls: Array<{ text: string; args: unknown[] }> = [];
	let released = 0;
	return {
		calls,
		get released() {
			return released;
		},
		async queryObject<T>(config: { text: string; args: unknown[] }) {
			calls.push({ text: config.text, args: config.args });
			return { rows: (options.rows ?? []) as T[] };
		},
		release() {
			released += 1;
			return options.release?.();
		}
	};
}

describe('adapt — the parameterised call shape', () => {
	it('passes the SQL as `text` and the params as `args`, never interpolated', async () => {
		const client = fakeClient();
		await adapt(client).query('select now() as now');
		expect(client.calls).toEqual([{ text: 'select now() as now', args: [] }]);
	});

	it('forwards parameters in order, under `args`', async () => {
		const client = fakeClient();
		await adapt(client).query('insert into t values ($1, $2, $3)', ['a', 2, null]);
		expect(client.calls[0]?.args).toEqual(['a', 2, null]);
		// The values go in `args`, never spliced into the statement — a caller
		// in charge of its own quoting is how an injection gets written.
		expect(client.calls[0]?.text).toBe('insert into t values ($1, $2, $3)');
	});

	it('copies a readonly params tuple into a mutable array the driver can take', async () => {
		const client = fakeClient();
		const params: readonly unknown[] = Object.freeze(['frozen', 1]);
		// Passing the frozen array straight through would throw if the driver
		// mutated it; the adapter spreads it for exactly that reason.
		await expect(adapt(client).query('select $1, $2', params)).resolves.toBeDefined();
		expect(client.calls[0]?.args).toEqual(['frozen', 1]);
		expect(client.calls[0]?.args).not.toBe(params);
		expect(Object.isFrozen(client.calls[0]?.args)).toBe(false);
	});

	it('defaults to no parameters when the caller passes none', async () => {
		const client = fakeClient();
		await adapt(client).query('commit');
		expect(client.calls[0]?.args).toEqual([]);
	});
});

describe('adapt — the row mapping', () => {
	it('returns `{ rows }` and not the driver result itself', async () => {
		const rows = [{ seq: 1n, core_version: 1 }];
		const result = await adapt(fakeClient({ rows })).query('select * from auction_events');
		// `runTransactionalWrite` and `runTick` both read `result.rows`; handing
		// back the driver's own object would work by accident today and break
		// the moment the driver adds or renames a field.
		expect(result).toEqual({ rows });
		expect(result.rows).toBe(rows);
	});

	it('maps an empty result to an empty rows array, never undefined', async () => {
		const result = await adapt(fakeClient({ rows: [] })).query('select 1 where false');
		expect(result.rows).toEqual([]);
	});
});

describe('adapt — release never escapes the invocation', () => {
	it('releases the client exactly once', () => {
		const client = fakeClient();
		adapt(client).release();
		expect(client.released).toBe(1);
	});

	it('swallows a REJECTED release, as `deno-postgres` returns a promise', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const client = fakeClient({ release: () => Promise.reject(new Error('pool gone')) });
		expect(() => adapt(client).release()).not.toThrow();
		// Let the rejection settle: an unhandled one would outlive the pass.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});

	it('swallows a SYNCHRONOUS release throw, which `Promise.resolve` never sees', () => {
		// The half a bare `Promise.resolve(...).catch(...)` misses entirely: a
		// throw raised before the promise exists propagates straight out.
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const client = fakeClient({
			release: () => {
				throw new Error('released twice');
			}
		});
		expect(() => adapt(client).release()).not.toThrow();
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});
});
