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
 * Adapt one pooled `deno-postgres` client to `TransactionalClient`.
 *
 * `queryObject({ text, args })` is the parameterised form — never string
 * interpolation, and never the template-literal form, both of which would put
 * the caller in charge of quoting. `args` is spread into a mutable array
 * because the driver's signature takes one, while every caller upstream hands
 * over a `readonly` tuple.
 */
export function adapt(client: PooledClient): TransactionalClient & { release(): void } {
	return {
		async query(text: string, params: readonly unknown[] = []) {
			const result = await client.queryObject<QueryResultRow>({
				text,
				args: [...params]
			});
			return { rows: result.rows };
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
