#!/usr/bin/env node
/**
 * Backfill `source_rank` on an ALREADY-PROMOTED Free Agent pool, from the CSV
 * that was promoted (Story 9.8).
 *
 * **Why this exists.** `source_rank` is the row's position in the supplied
 * Fantrax export, and `/nominate` orders the pool by it so a Manager reads the
 * list in the order they have been reading it in Fantrax all week. It is
 * written on the ordinary path by import staging and carried across by
 * promotion — and promotion is Setup-only, by a gate that is correct and must
 * not be worked around. A league that opened its Auction before this column
 * existed therefore has its whole pool sitting at the migration's `0` default,
 * and no path in the app that can ever fill it in.
 *
 * This script is that path, and NOTHING more than that path. It writes exactly
 * one column, on the two pool tables, matching each row by its Fantrax Player
 * ID. It appends no event, touches no auction state, and inserts and deletes
 * nothing — which is the whole reason it is safe to run against an open
 * Auction where a re-import is not. `minor_league_eligible` appears in no
 * statement here: that column is an event-sourced projection with exactly one
 * writer (Story 1.10), and this is not it.
 *
 * **It refuses unless the file IS the pool.** Every id in the CSV must be in
 * the live pool and every id in the live pool must be in the CSV, exactly.
 * That check is what makes a wrong file, a stale file, or a mis-read column a
 * refusal rather than a half-applied ordering nobody would notice until a
 * Manager could not find a Player.
 *
 * IDEMPOTENT. The rank is computed from the file's own row order, so running
 * it twice writes the same numbers twice. Re-supplying the same file through
 * the ordinary import path once the league is next in Setup produces exactly
 * these values too — this script is a shortcut to the same answer, never a
 * second definition of it.
 *
 * DRY BY DEFAULT. It reports what it would change and exits without writing
 * unless `--apply` is passed.
 *
 * Usage:
 *   SUPABASE_DB_URL='postgresql://...' node scripts/backfill-pool-source-rank.js <pool.csv>
 *   SUPABASE_DB_URL='postgresql://...' node scripts/backfill-pool-source-rank.js <pool.csv> --apply
 *
 * The URL is read from the environment and never from a file this script finds
 * on its own, so pointing it at prod has to be a deliberate act — the same
 * discipline `scripts/seed-league.js` and `scripts/verify-supabase.js` follow.
 *
 * NOTE: `npm run check` does NOT type-check `scripts/`, so this is plain JS
 * written defensively rather than TypeScript leaning on the compiler.
 */

import { readFileSync } from 'node:fs';

import { parse } from 'csv-parse/sync';
import pg from 'pg';

/**
 * The one column this script reads out of the export.
 *
 * `src/lib/adapters/fantrax/pool-file.ts` is "the only module in the
 * repository that knows this file's column names", and that rule is worth
 * keeping — but it is TypeScript with `.ts`-suffixed relative imports that
 * plain `node` cannot load, and `scripts/` is deliberately outside the build.
 * So the name is repeated here, once, and the id-set check below is what
 * protects the repetition: if this ever stops matching `POOL_COLUMNS`, every
 * row parses as `undefined`, the sets do not match, and the script refuses
 * before it writes anything.
 */
const ID_COLUMN = 'ID';

const STAGED_TABLE = 'import_staged_pool_players';
const LIVE_TABLE = 'free_agent_players';

function fail(message) {
	console.error(`backfill-pool-source-rank: ${message}`);
	process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const csvPath = args.find((arg) => !arg.startsWith('--'));

if (csvPath === undefined) {
	fail('name the pool CSV to read the order from. See the header of this file.');
}

const connectionString = process.env['SUPABASE_DB_URL'];
if (connectionString === undefined || connectionString.trim() === '') {
	fail('SUPABASE_DB_URL is not set. It is read from the environment, never from a file.');
}

/**
 * The file's rows, in file order. `columns: true` keeps the header's own
 * names; `bom: true` because a Fantrax export is UTF-8 with a BOM and the
 * first column name would otherwise carry it and never match.
 */
const rows = parse(readFileSync(csvPath, 'utf8'), {
	columns: true,
	skip_empty_lines: true,
	bom: true,
	trim: true
});

const ids = rows.map((row) => row[ID_COLUMN]);
if (ids.some((id) => typeof id !== 'string' || id.trim() === '')) {
	fail(`a row has no ${ID_COLUMN}. Is this the Free Agent pool export?`);
}

const duplicates = ids.filter((id, at) => ids.indexOf(id) !== at);
if (duplicates.length > 0) {
	fail(`the file names the same Player twice: ${duplicates.slice(0, 5).join(', ')}`);
}

const client = new pg.Client({ connectionString });
await client.connect();

try {
	const column = await client.query(
		`select table_name from information_schema.columns
		where table_schema = 'public' and column_name = 'source_rank'
		order by table_name`
	);
	const columned = column.rows.map((row) => row['table_name']);
	for (const table of [LIVE_TABLE, STAGED_TABLE]) {
		if (!columned.includes(table)) {
			fail(
				`${table}.source_rank does not exist. Apply the migration first:\n` +
					'  npx supabase db push --db-url "$SUPABASE_DB_URL"'
			);
		}
	}

	const live = await client.query(`select fantrax_player_id from ${LIVE_TABLE}`);
	const liveIds = new Set(live.rows.map((row) => String(row['fantrax_player_id'])));
	const fileIds = new Set(ids);

	// The file must BE the pool, in both directions. A file that is merely a
	// superset would leave real Players at rank 0 and sort them to the top of
	// the list, which is the failure this check exists to make impossible.
	const notInFile = [...liveIds].filter((id) => !fileIds.has(id));
	const notInPool = [...fileIds].filter((id) => !liveIds.has(id));
	if (notInFile.length > 0 || notInPool.length > 0) {
		fail(
			'this file is not the promoted pool.\n' +
				`  in the pool but not the file: ${String(notInFile.length)} ${notInFile.slice(0, 5).join(', ')}\n` +
				`  in the file but not the pool: ${String(notInPool.length)} ${notInPool.slice(0, 5).join(', ')}`
		);
	}

	console.log(`${String(rows.length)} Players, matched against the live pool exactly.`);
	console.log(`  rank 0: ${ids[0]}`);
	console.log(`  rank ${String(ids.length - 1)}: ${ids[ids.length - 1]}`);

	if (!apply) {
		console.log('Dry run. Nothing was written. Pass --apply to write.');
		process.exit(0);
	}

	// One statement per table, not one per Player: ~1,470 sequential round
	// trips is the exact shape that killed the first real import (Story 9.7).
	// `unnest` pairs each id with its position in the same select, so the
	// mapping cannot drift between the two parameters.
	const ranks = ids.map((_, at) => at);
	await client.query('begin');
	for (const table of [STAGED_TABLE, LIVE_TABLE]) {
		const result = await client.query(
			`update ${table} as p
			set source_rank = supplied.rank
			from (select unnest($1::text[]) as fantrax_player_id, unnest($2::int[]) as rank) as supplied
			where p.fantrax_player_id = supplied.fantrax_player_id
				and p.source_rank is distinct from supplied.rank`,
			[ids, ranks]
		);
		console.log(`  ${table}: ${String(result.rowCount)} rows changed`);
	}
	await client.query('commit');
	console.log('Committed.');
} catch (error) {
	try {
		await client.query('rollback');
	} catch {
		// The connection is already gone; the transaction died with it.
	}
	throw error;
} finally {
	await client.end();
}
