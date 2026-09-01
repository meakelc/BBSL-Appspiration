/**
 * The sealed lottery seed: the table's name, and its one reader. Server-only
 * (Stories 3.2, 3.3, 3.6, AD-14).
 *
 * **This module exists because of a runtime boundary, not because of a
 * layering preference.** `readContentionSeed` lived in `server/bidding.ts`
 * until Story 3.6, and could not stay there: that module imports
 * `node:crypto` for `randomBytes`, and `supabase/functions/tick/index.ts`
 * makes Deno load `server/close.ts`, which now needs to read the sealed seed
 * at a draw. A close that imported `bidding.ts` to reach the reader would pull
 * a Node built-in into the Deno graph and break AD-2 at the one place it is
 * checked — `npx deno check --config supabase/functions/tick/deno.json
 * supabase/functions/tick/index.ts`. Re-exporting from `bidding.ts` would not
 * help: the import graph is what Deno resolves, not the names used from it.
 *
 * So the table and its reader move here, to a module with relative `.ts`
 * imports only and no Node builtin anywhere in its chain, and BOTH callers
 * import it: `server/bidding.ts` for the dissolution, `server/close.ts` for
 * the draw. One statement of the table's name, one statement of how a seed is
 * read, and a graph Deno can load.
 *
 * The WRITE side stays in `server/bidding.ts`, where it belongs: only a Bid
 * ever seals a seed, `recordContentionSeed` is a `ProjectionUpdater` closing
 * over the value `decide()` hashed, and nothing in a close writes here.
 */

import type { TransactionalClient } from '../shell/write.ts';

/** The sealed seed table (`20260828000000_contention_seeds.sql`). */
export const CONTENTION_SEEDS_TABLE = 'auction_contention_seeds';

/**
 * The sealed seed for one Player's Minimum-Bid Contention, or `null` when the
 * table holds none (Stories 3.3 and 3.6, AD-14).
 *
 * **The only reader of `auction_contention_seeds` there is**, and it exists
 * because both exits from a contention have to open what the opening sealed: a
 * dissolution reveals it beside the converting Bid (3.3), and a draw reveals
 * it beside the close (3.6). Story 3.2 stated outright that nothing in this
 * codebase selected from this table; 3.3 changed that, and 3.6 adds a second
 * caller rather than a second reader.
 *
 * It takes the transaction's own `client` rather than reaching for
 * `server/supabase.ts`, and that is not a style preference: the migration
 * grants `anon`, `authenticated` and `service_role` NOTHING, so the direct
 * `SUPABASE_DB_URL` connection is the only identity that can read a row at
 * all. The same connection appends the events, which is what makes the read
 * and the append one atomic act under the global lock (AD-6).
 *
 * `fantrax_player_id` is the primary key, so at most one row comes back. A
 * missing row is `null` rather than a throw: the caller decides what an absent
 * seed means, and both a DISSOLUTION and a DRAW treat it as the bug it is —
 * in the core, at the rule that can say what was missing.
 *
 * The value never leaves the server except as the reveal a core `decide()`
 * publishes, and only after that function has hashed it against the commitment
 * the log already carries.
 */
export async function readContentionSeed(
	client: TransactionalClient,
	fantraxPlayerId: string
): Promise<string | null> {
	const result = await client.query(
		`select seed from ${CONTENTION_SEEDS_TABLE} where fantrax_player_id = $1`,
		[fantraxPlayerId]
	);
	const row = result.rows[0];
	if (row === undefined) return null;
	const seed = row['seed'];
	return typeof seed === 'string' && seed !== '' ? seed : null;
}
