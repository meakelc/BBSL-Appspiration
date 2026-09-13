#!/usr/bin/env node
/**
 * Archive and wipe a pilot's data, so the next pilot iteration starts clean.
 *
 * **Why this exists separately from `seed-league.js --wipe`.** That flag clears
 * `managers` and `teams` only, and deliberately refuses to touch
 * `auction_events`: "if the delete fails on that foreign key, the auction has
 * real history and wiping the league out from under it is not something this
 * script should do quietly." That is the right default for a re-seed. It is the
 * wrong tool for ending a pilot, where the whole point is that the history goes
 * too — bids, closes, heartbeats, staged imports, promoted rosters, the lot.
 *
 * So this script does the loud version: it writes every table out to JSON
 * first, then deletes in foreign-key order inside one transaction. The archive
 * is not a courtesy — a pilot's value is in what it recorded, and pilot 1's
 * dump is the only surviving evidence of how the first iteration behaved.
 *
 * Usage:
 *   SUPABASE_DB_URL='postgresql://...' node scripts/reset-pilot.js --archive-to=_bmad-output/pilot-2-archive
 *   SUPABASE_DB_URL='postgresql://...' node scripts/reset-pilot.js --archive-to=... --confirm-wipe
 *
 * Without `--confirm-wipe` it reports the row count per table and changes
 * nothing, locally or in the database. That is the intended first run: read the
 * counts, confirm they are the pilot you think they are, then run it again with
 * the flag. The dry run deliberately writes NO archive — an archive it left
 * behind would trip the "refusing to overwrite an existing archive" guard on
 * the very run it exists to precede.
 *
 * Afterwards, re-seed:
 *   npm run seed:league -- --wipe
 *
 * PILOT ONLY. Refuses to run when SUPABASE_ENVIRONMENT is `prod`, checked
 * before connecting — a guard that only fires after a successful connection is
 * a guard that fails open the moment the network does.
 *
 * NOTE: `npm run check` does NOT type-check `scripts/`, so this is plain JS
 * written defensively rather than TypeScript leaning on the compiler.
 */

import { mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

/**
 * Every table in the schema, in the order they must be DELETED — children
 * before parents.
 *
 * Spelled out rather than derived from `information_schema` on purpose, then
 * cross-checked against it below: a table added by a later migration and not
 * added here is a hard failure rather than a table quietly left holding a
 * previous pilot's rows.
 *
 * `auction_watermark` is absent, and that is deliberate — see `WATERMARK`.
 */
const DELETE_ORDER = Object.freeze([
	// References auction_events(seq).
	'notification_outbox',
	// References auction_events(seq) and teams(id).
	'open_nominations',
	// References managers(id) on delete cascade — deleted explicitly anyway, so
	// the row count is reported rather than disappearing silently.
	'manager_notification_preferences',
	// References managers(id) and teams(id). Everything above pointed here.
	'auction_events',
	// All three reference teams(id).
	'import_staged_rosters',
	'import_team_sources',
	'team_rosters',
	// Free-standing: keyed by Fantrax player id, not by Team.
	'import_staged_pool_players',
	'import_pool_source',
	'free_agent_players',
	'auction_contention_seeds',
	'tick_heartbeats',
	// The two parents, last. Managers before Teams, because managers.team_id
	// references teams(id).
	'managers',
	'teams'
]);

/**
 * The watermark is RESET, never deleted.
 *
 * `20260902000000_watermark.sql` makes it a singleton whose primary key is a
 * boolean constrained to `true`, maintained by an after-insert trigger on
 * `auction_events` that does `update ... where seq < new.seq`. Delete the row
 * and that UPDATE matches nothing, forever: no INSERT re-creates it, so the
 * next pilot would run with no watermark at all and every browser's freshness
 * subscription would read an empty table. Setting it back to 0 is what an empty
 * log means — the migration says so: "0 for an empty log, which is a value no
 * row can hold".
 *
 * **This already happened.** `pilot-1-archive/auction_watermark.json` holds one
 * row at `seq 386`; the dev project held NO row on 2026-09-12 with the log at
 * `seq 483`. Whatever cleared the league between iterations 1 and 2 deleted the
 * singleton, so the whole of iteration 2 ran with the freshness subscription
 * watching an empty table. Hence the INSERT below rather than an UPDATE: the
 * reset heals a missing row instead of quietly matching zero of them.
 */
const WATERMARK = 'auction_watermark';

/**
 * Reset the watermark to 0, re-creating the singleton if a previous wipe took it.
 *
 * `on conflict do update` rather than `do nothing`: the row is supposed to be
 * there, and when it is, 0 is the value this reset means.
 */
const RESET_WATERMARK = `insert into public.${WATERMARK} (id, seq) values (true, 0)
	 on conflict (id) do update set seq = 0`;

/**
 * `auction_events.seq` is `generated always as identity`, so deleting every row
 * leaves the next event numbered after the last pilot's. Nothing breaks if it
 * does — folds order by `seq` and never assume a starting value — but a fresh
 * pilot whose first event is `seq 4127` is a pilot whose log is needlessly hard
 * to read against the previous one's.
 */
const RESTART_IDENTITY = 'alter table public.auction_events alter column seq restart with 1';

/** Read a `--name=value` argument, or undefined when it is absent. */
function arg(name) {
	const prefix = `--${name}=`;
	const found = process.argv.find((a) => a.startsWith(prefix));
	return found === undefined ? undefined : found.slice(prefix.length);
}

async function main() {
	const url = process.env['SUPABASE_DB_URL'];
	if (url === undefined || url.trim() === '') {
		process.stderr.write(
			'SUPABASE_DB_URL is not set.\n' +
				"Run as: SUPABASE_DB_URL='postgresql://...' node scripts/reset-pilot.js --archive-to=DIR\n"
		);
		process.exitCode = 1;
		return;
	}

	if (process.env['SUPABASE_ENVIRONMENT'] === 'prod') {
		process.stderr.write(
			'Refusing to wipe prod.\n' +
				'This script exists to end a pilot on the dev project. Prod holds the real\n' +
				"auction's history, and AD-4 makes that log insert-only for a reason.\n"
		);
		process.exitCode = 1;
		return;
	}

	const archiveTo = arg('archive-to');
	if (archiveTo === undefined || archiveTo.trim() === '') {
		process.stderr.write(
			'--archive-to=DIR is required.\n' +
				'Every table is written there as JSON before anything is deleted. A pilot\n' +
				'that leaves no record behind is a pilot you cannot answer questions about.\n'
		);
		process.exitCode = 1;
		return;
	}

	// Refuse to write into a directory that already holds an archive. Overwriting
	// pilot 1's dump with pilot 2's rows would destroy the only copy of the first
	// iteration while looking like a successful run.
	try {
		const existing = await readdir(archiveTo);
		const jsons = existing.filter((f) => f.endsWith('.json'));
		if (jsons.length > 0) {
			process.stderr.write(
				`${archiveTo} already holds ${String(jsons.length)} .json file(s).\n` +
					'Refusing to overwrite an existing archive. Pick a new directory.\n'
			);
			process.exitCode = 1;
			return;
		}
	} catch {
		/* does not exist yet, which is the normal case */
	}

	const confirmed = process.argv.includes('--confirm-wipe');

	const client = new pg.Client({ connectionString: url });
	try {
		await client.connect();
	} catch (error) {
		process.stderr.write(
			`Could not connect: ${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exitCode = 1;
		return;
	}

	try {
		// Cross-check the table list against the schema before trusting it.
		const { rows: present } = await client.query(
			`select table_name from information_schema.tables
			  where table_schema = 'public' and table_type = 'BASE TABLE'
			  order by table_name`
		);
		const known = new Set([...DELETE_ORDER, WATERMARK]);
		const unknown = present.map((r) => String(r['table_name'])).filter((name) => !known.has(name));
		if (unknown.length > 0) {
			process.stderr.write(
				`The schema holds table(s) this script does not know about:\n  ${unknown.join(', ')}\n` +
					'Add them to DELETE_ORDER (in foreign-key order) and run again.\n'
			);
			process.exitCode = 1;
			return;
		}

		const tables = [...DELETE_ORDER, WATERMARK];

		if (!confirmed) {
			process.stdout.write('DRY RUN — nothing is written or deleted.\n\n');
			let total = 0;
			for (const table of tables) {
				const { rows } = await client.query(`select count(*) as n from public.${table}`);
				const n = Number(rows[0]['n']);
				total += n;
				process.stdout.write(`  ${table.padEnd(34)} ${String(n).padStart(7)} row(s)\n`);
			}
			process.stdout.write(
				`\n${String(total)} row(s) across ${String(tables.length)} tables\n\n` +
					'If that is the pilot you mean to end, run again with\n' +
					`  --confirm-wipe\n` +
					'which archives to the directory above and then deletes.\n\n' +
					'Disable the tick schedule first — a sweep landing mid-wipe writes events\n' +
					'against Teams the transaction is deleting.\n'
			);
			return;
		}

		await mkdir(archiveTo, { recursive: true });

		process.stdout.write(`archiving to ${archiveTo}\n\n`);
		let archived = 0;
		for (const table of tables) {
			const { rows } = await client.query(`select * from public.${table}`);
			archived += rows.length;
			await writeFile(
				path.join(archiveTo, `${table}.json`),
				`${JSON.stringify(rows, null, 2)}\n`,
				'utf8'
			);
			process.stdout.write(`  ${table.padEnd(34)} ${String(rows.length).padStart(7)} row(s)\n`);
		}

		process.stdout.write(
			`\n${String(archived)} row(s) archived across ${String(tables.length)} tables\n\n`
		);

		// One transaction: a half-wiped league is worse than an un-wiped one,
		// because it looks finished.
		await client.query('begin');
		for (const table of DELETE_ORDER) {
			const result = await client.query(`delete from public.${table}`);
			process.stdout.write(`  deleted ${String(result.rowCount ?? 0).padStart(7)} from ${table}\n`);
		}
		const watermark = await client.query(RESET_WATERMARK);
		await client.query(RESTART_IDENTITY);
		await client.query('commit');

		process.stdout.write(
			`\nwatermark: ${String(watermark.rowCount ?? 0)} row at seq 0\n` +
				'wiped. auction_events.seq restarted at 1.\n\n' +
				'Next:\n' +
				'  1. Confirm the tick schedule is inactive before re-seeding.\n' +
				'  2. npm run seed:league -- --wipe\n' +
				'  3. Re-import the Fantrax exports through /import (npm run name:rosters first,\n' +
				'     and check the highest-paid players against the league — that gate is the\n' +
				'     only cheap way to catch a wrong roster ordering).\n'
		);
	} catch (error) {
		await client.query('rollback').catch(() => {
			/* the connection may already be gone; the original error is what matters */
		});
		process.stderr.write(
			`reset failed and rolled back: ${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exitCode = 1;
	} finally {
		await client.end();
	}
}

await main();
