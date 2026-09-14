/**
 * The `deno-postgres` → `TransactionalClient` translation, on its own so a test
 * can execute it (Story 3.5).
 *
 * **Why this is not in `gateway.ts`.** Every close and every heartbeat write in
 * production goes through the four lines below — the parameterised call shape,
 * the `readonly` spread, the row mapping, the release. `gateway.ts` imports the
 * bare specifier `postgres`, which Vitest cannot resolve, so anything living
 * there is unreachable from `npm test`; and a `deno test` would not help,
 * because CI (`.github/workflows/ci.yml`) runs no Deno step, so it would be a
 * test that exists and never runs. This module names what it needs
 * STRUCTURALLY and imports nothing, which is the same move `auth.ts` makes for
 * the invocation check and `scripts/check-core-purity.js` makes for the purity
 * gate: the logic is a pure function so the suite can drive it.
 *
 * `gateway.ts` keeps what genuinely belongs to Deno — the `Pool`, the
 * environment read, the lifetime.
 */

import type { QueryResultRow, TransactionalClient } from '../../../src/lib/shell/write.ts';

/**
 * The minimum of `deno-postgres`' `PoolClient` this module needs.
 *
 * A real `PoolClient` satisfies it. Declaring it structurally rather than
 * importing the type is what keeps this file loadable under both runtimes —
 * and it is not a weaker claim, because `gateway.ts` passes a genuine
 * `PoolClient` and `deno check` still type-checks that call against the real
 * type.
 *
 * `release()` is typed as returning `unknown`: it answers a promise in this
 * driver and `void` in `pg`, and the adapter below deliberately accommodates
 * both rather than assuming either.
 */
export type PooledClient = {
	queryObject<T>(config: { text: string; args: unknown[] }): Promise<{ rows: T[] }>;
	release(): unknown;
};

/**
 * Present an `int8` the way `pg` does: as a string.
 *
 * **This is a driver difference, not a rule.** `deno-postgres` decodes `int8`
 * to a JavaScript `bigint`; `pg` decodes it to a `string`, and PostgREST hands
 * back a `number`. `src/lib/core/money.ts` states its contract in exactly
 * those two terms — "a `string` from node-postgres, a `number` from
 * PostgREST" — so a `bigint` reaching `parseMoney` throws `money must arrive
 * as a string or a number, received bigint` and the close fails. Observed on
 * the dev project on 2026-09-09, the first time the schedule was ever enabled
 * with overdue Auctions to close: every 10-second pass recorded
 * `completed_with_failures` against two Auctions and closed nothing. Story
 * 3.5's smoke test had passed only because it had nothing to close, so this
 * path had never once executed successfully.
 *
 * **Normalising HERE rather than widening the core is the whole point of this
 * file.** AD-2's property is that Deno loads the exact module Node
 * unit-tests; that only holds if the two runtimes hand those modules the same
 * SHAPES. A `bigint` branch in `parseMoney` would teach `src/lib/core` about
 * one driver's decoding, and would fix money alone — leaving every other
 * `int8` in the schema, ids and counts and versions, still differing between
 * the runtimes for the next caller to trip over.
 *
 * **No precision is lost.** `String(bigint)` is exact for every value an
 * `int8` can hold, which is why `pg` chose text in the first place: `Number`
 * rounds silently past 2^53. Whether a particular column's text then fits a
 * safe integer stays the consumer's decision, and `parseMoney` already refuses
 * the ones that do not, with a message naming the value.
 *
 * Arrays are mapped for `int8[]`. A `jsonb` column is left alone: its contents
 * arrive already parsed from text and can never hold a `bigint`.
 */
function normalise(value: unknown): unknown {
	if (typeof value === 'bigint') return String(value);
	if (Array.isArray(value)) return value.map(normalise);
	return value;
}

/** Apply {@link normalise} across one row's own columns. */
function normaliseRow(row: QueryResultRow): QueryResultRow {
	const normalised: QueryResultRow = {};
	for (const key of Object.keys(row)) normalised[key] = normalise(row[key]);
	return normalised;
}

/**
 * Adapt one pooled `deno-postgres` client to `TransactionalClient`.
 *
 * `queryObject({ text, args })` is the parameterised form — never string
 * interpolation, and never the template-literal form, both of which would put
 * the caller in charge of quoting. `args` is spread into a mutable array
 * because the driver's signature takes one, while every caller upstream hands
 * over a `readonly` tuple.
 *
 * Rows come back through {@link normaliseRow}, so what reaches `src/lib` from
 * Deno is shaped exactly as `pg` would have delivered it.
 */
export function adapt(client: PooledClient): TransactionalClient & { release(): void } {
	return {
		async query(text: string, params: readonly unknown[] = []) {
			const result = await client.queryObject<QueryResultRow>({
				text,
				args: [...params]
			});
			return { rows: result.rows.map(normaliseRow) };
		},
		release() {
			// **Both failure shapes, because the two drivers differ.**
			// `release()` returns a promise here and `void` in `pg`, so a
			// failure can arrive as a rejection OR as a synchronous throw. The
			// promise is deliberately not awaited — a failed release must not
			// become an unhandled rejection that outlives the invocation — and
			// the try/catch is what stops the synchronous half escaping past
			// `Promise.resolve`, which never sees it.
			try {
				void Promise.resolve(client.release()).catch((error: unknown) => {
					console.error('tick: releasing a pooled connection failed', error);
				});
			} catch (error) {
				console.error('tick: releasing a pooled connection threw', error);
			}
		}
	};
}
