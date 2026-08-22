/**
 * The pooled direct-Postgres connection (AD-6), and the one place
 * `SUPABASE_DB_URL` is read.
 *
 * `pg`, not `supabase-js`: `write.ts`'s pipeline needs `BEGIN ...
 * pg_advisory_xact_lock ... COMMIT` held open across a load/decide/persist
 * sequence, and PostgREST — everything `supabase.ts` talks to — is stateless
 * per request and cannot do that. `SUPABASE_DB_URL` is a direct or pooled
 * Postgres connection string, distinct from `SUPABASE_URL`'s PostgREST
 * endpoint, and is read through `$env/dynamic/private`, mirroring
 * `supabase.ts`'s `required()` pattern: a missing variable fails at runtime
 * with a sentence in it, not a build that fails in Netlify's log at 2am.
 *
 * One pool per process, built lazily on first use and reused after that. A
 * route that wants a transactional write reaches it through `writeGateway()`,
 * never by importing `pg` directly.
 */

import { Pool } from 'pg';
import { env } from '$env/dynamic/private';

import type { ConnectionGateway } from './write.ts';

/** Read a required server-only variable, failing with the name that is missing. */
function required(name: string, value: string | undefined): string {
	if (value === undefined || value.trim() === '') {
		throw new Error(`${name} is not set. The transactional write path is unavailable.`);
	}
	return value;
}

let pool: Pool | undefined;

/** The shared connection pool, built once per process and reused. */
export function writePool(): Pool {
	if (pool === undefined) {
		pool = new Pool({ connectionString: required('SUPABASE_DB_URL', env['SUPABASE_DB_URL']) });
		// node-postgres requires an 'error' listener on a Pool: an idle client's
		// backend error (a dropped connection, a server restart, ...) emits an
		// unhandled 'error' event on the pool with none, which crashes the whole
		// process. This is not application logic to react to — the pool already
		// discards the broken client and hands the next `connect()` caller a
		// fresh one — it exists purely so that class of error surfaces as a log
		// line instead of taking the process down.
		pool.on('error', (error) => {
			console.error('writePool: an idle client emitted a backend error', error);
		});
	}
	return pool;
}

/**
 * Adapt a pool to `write.ts`'s `ConnectionGateway` port.
 *
 * A thin wrapper rather than handing the pool itself to `runTransactionalWrite`
 * — `Pool` carries far more surface (`query`, `end`, event emitters) than the
 * pipeline is allowed to reach for, and the port is what a test substitutes.
 */
export function writeGateway(sourcePool: Pool = writePool()): ConnectionGateway {
	return {
		connect: () => sourcePool.connect()
	};
}
