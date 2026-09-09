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
		//
		// The rows are no longer the driver's ARRAY either, and that is now
		// deliberate rather than incidental: `normaliseRow` rebuilds every row
		// so an `int8` reaches `src/lib` as the string `pg` would have handed
		// over. This fixture's `seq: 1n` is the precise shape that threw
		// `money must arrive as a string or a number, received bigint` on the
		// dev project, and it is asserted here as `'1'` rather than passed
		// through — which is what this file previously, wrongly, required.
		expect(result).toEqual({ rows: [{ seq: '1', core_version: 1 }] });
		expect(result.rows).not.toBe(rows);
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

describe('adapt — an int8 arrives as `pg` would deliver it', () => {
	it('renders a bigint column as a string, which is what `parseMoney` accepts', async () => {
		// The live failure this covers: `deno-postgres` decodes `int8` to a
		// bigint, `money.ts` accepts only a string or a number, and every
		// close on the dev project threw `money must arrive as a string or a
		// number, received bigint` once the schedule was first enabled.
		const client = fakeClient({ rows: [{ amount: 42n }] });
		const { rows } = await adapt(client).query('select amount from bids');
		expect(rows).toEqual([{ amount: '42' }]);
		expect(typeof rows[0]?.amount).toBe('string');
	});

	it('is exact past 2^53, which is why the text form is the right one', async () => {
		// `Number(9007199254740993n)` is 9007199254740992 — the rounding `pg`
		// avoids by handing back text, and the reason this converts through
		// `String` rather than `Number`.
		const client = fakeClient({ rows: [{ id: 9007199254740993n }] });
		const { rows } = await adapt(client).query('select id from auction_events');
		expect(rows[0]?.id).toBe('9007199254740993');
	});

	it('maps a bigint inside an array, for an int8[] column', async () => {
		const client = fakeClient({ rows: [{ ids: [1n, 2n, 3n] }] });
		const { rows } = await adapt(client).query('select ids from t');
		expect(rows[0]?.ids).toEqual(['1', '2', '3']);
	});

	it('leaves every other column shape exactly as the driver gave it', async () => {
		// Including a jsonb payload: its contents arrive already parsed from
		// text and can never hold a bigint, so it must pass through untouched
		// rather than being walked and rebuilt.
		const when = new Date('2026-09-09T17:11:43.241Z');
		const payload = { nested: { deep: 1 } };
		const client = fakeClient({
			rows: [{ name: 'a', count: 3, missing: null, ran_at: when, payload }]
		});
		const { rows } = await adapt(client).query('select * from t');
		expect(rows[0]).toEqual({ name: 'a', count: 3, missing: null, ran_at: when, payload });
		expect(rows[0]?.ran_at).toBe(when);
		expect(rows[0]?.payload).toBe(payload);
	});

	it('does not mutate the row the driver handed over', async () => {
		const driverRow = { amount: 42n };
		const client = fakeClient({ rows: [driverRow] });
		await adapt(client).query('select amount from bids');
		expect(driverRow.amount).toBe(42n);
	});
});
