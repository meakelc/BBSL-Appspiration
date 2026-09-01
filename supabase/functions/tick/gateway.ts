/**
 * `src/lib/shell/db.ts`'s Deno twin: a `ConnectionGateway` over a direct
 * Postgres connection, for the Edge Runtime. Story 3.5.
 *
 * **The port is identical, so nothing upstream changes.** `runTransactionalWrite`
 * and `runTick` both depend on `ConnectionGateway`/`TransactionalClient` and on
 * nothing else about how a connection is made — that is exactly why those types
 * exist as a port rather than as `pg.Pool` (`shell/write.ts`'s own note: "a unit
 * test substitutes a fake client the way `ManagerRegistry`/`DiscordOAuthPort`
 * already do"). So this file is the whole of the Deno-side plumbing: the
 * pipeline, the sweep and the core are untouched and are literally the same
 * files Node loads (AD-2).
 *
 * **Why a second implementation exists at all.** `shell/db.ts` imports `pg` and
 * `$env/dynamic/private` — a Node package and a SvelteKit build-time alias,
 * neither of which exists under Deno. It is the ONE module in the write path
 * that is runtime-specific, which is what makes one twin enough.
 *
 * **`pg`, not PostgREST, for the same reason as Node.** Every close holds
 * `BEGIN ... pg_advisory_xact_lock ... COMMIT` open across a load/decide/persist
 * sequence (AD-6), and PostgREST is stateless per request and cannot do that.
 * `SUPABASE_DB_URL` is the direct or pooled Postgres connection string, distinct
 * from `SUPABASE_URL`'s PostgREST endpoint.
 *
 * **One connection at a time, and it is released.** The sweep opens one
 * connection for its own read and heartbeat, and each `closeAuction` opens
 * another for its transaction — sequentially, never concurrently, because
 * AD-11 requires each close committed before the next is evaluated. The pool is
 * sized accordingly: an Edge Function invocation is short-lived and a wide pool
 * against a pooled Supabase connection string buys nothing.
 *
 * **Row shapes.** `queryObject` hands back plain objects keyed by column name,
 * which is exactly `QueryResultRow`. `timestamptz` decodes to a `Date`, which
 * `requireDatabaseClock` requires; `int8` decodes to a `BigInt`, which
 * `toAppendedEvent`'s `String(row['seq'])` and `parseMoney`'s boundary brand
 * already handle — the same "the same int8 arrives as a string through one
 * client and a number through the other" the money brand exists for (AD-8).
 */

import { Pool } from 'postgres';

import { adapt } from './adapt.ts';

import type { ConnectionGateway } from '../../../src/lib/shell/write.ts';

/**
 * How many connections one invocation may hold. Two: the sweep's own, and the
 * one close in flight. `true` makes them lazy, so a pass that finds nothing
 * overdue never opens the second.
 */
const POOL_SIZE = 2;

/** Read a required variable, failing with the name that is missing. */
function required(name: string): string {
	const value = Deno.env.get(name);
	if (value === undefined || value.trim() === '') {
		throw new Error(`${name} is not set. The tick cannot open a connection.`);
	}
	return value;
}

/**
 * The gateway the tick hands to `runTick` and to `closeAuction`.
 *
 * One pool per invocation, built here and passed down — the module-level
 * singleton `shell/db.ts` keeps is right for a long-lived Node process and
 * wrong for an Edge Function, whose isolate may be torn down at any point
 * between requests.
 */
export function tickGateway(): { gateway: ConnectionGateway; close(): Promise<void> } {
	const pool = new Pool(required('SUPABASE_DB_URL'), POOL_SIZE, true);

	return {
		gateway: {
			connect: async () => adapt(await pool.connect())
		},
		// Drained explicitly at the end of the invocation. An Edge isolate that
		// is reused would otherwise accumulate a pool per request.
		close: () => pool.end()
	};
}
