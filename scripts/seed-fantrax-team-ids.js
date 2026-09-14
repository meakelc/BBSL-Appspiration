#!/usr/bin/env node
/**
 * Seed `teams.fantrax_team_id` — the explicit Team map the divergence detector
 * runs on (Story 7.9, FR-42, AD-24).
 *
 * **There is no admin UI for this, by design.**
 * `supabase/migrations/20260821010000_teams.sql:14` states it plainly of that
 * table's own columns — "No admin UI ships for assigning either column. The
 * Commissioner writes them directly" — and this column is the same kind of
 * thing: a binding between this app and a third party, written once per
 * offseason by the one person who can read both. `scripts/seed-league.js` is
 * the shape this follows.
 *
 * **Why an id and never a name.** AD-24 forbids matching Teams by `teamName`
 * here. `src/lib/server/team-registry.ts`'s `resolveTeamByFileName` is the
 * app's one name-based match and it belongs to the IMPORT path, where a human
 * is looking at a preview. Nothing looks at this comparison: a Team renamed in
 * Fantrax would silently read as its entire roster departing and its entire
 * roster arriving at the same instant, and the app would confidently propose
 * thirty acts that would each be wrong.
 *
 * **Where to get the ids.** They are the keys of the `rosters` object in
 * `getTeamRosters`' own answer — the same call the reader makes. Fetch it once
 * by hand for your league, read off the thirty `teamName`/key pairs, and fill
 * the table below. That is a deliberate manual step: a script that matched them
 * up by name would be the exact thing AD-24 forbids, wearing a seeding script's
 * clothes.
 *
 * IDEMPOTENT and SAFE, and both words are load-bearing. A row is written only
 * when its Team name resolves to EXACTLY ONE Team; anything else is refused and
 * named, and nothing is written for it. The whole loop runs in ONE transaction
 * with a SAVEPOINT per row, so a collision with an id a prior partial run
 * already wrote is reported beside the other refusals rather than aborting
 * mid-way and leaving the League half-mapped. Re-running corrects an id rather
 * than failing or duplicating. Teams still unmapped at the end are reported BY
 * NAME, never counted (`src/lib/server/import-status.ts:113-115`).
 *
 * Usage:
 *   SUPABASE_DB_URL='postgresql://...' node scripts/seed-fantrax-team-ids.js
 *   SUPABASE_DB_URL='postgresql://...' node scripts/seed-fantrax-team-ids.js --dry-run
 *
 * The URL is read from the environment and never from a file this script finds
 * on its own, so pointing it at prod has to be a deliberate act.
 *
 * DO NOT enable the `bbsl-fantrax-read` cron job against a project holding real
 * rosters until this has run and reports nothing unmapped: until then every
 * Team reads as unmapped and the surface says *not configured*, which is
 * correct but useless.
 *
 * NOTE: `npm run check` does NOT type-check `scripts/`, so this is plain JS
 * written defensively rather than TypeScript leaning on the compiler.
 */

import pg from 'pg';

/**
 * Team name -> Fantrax team id.
 *
 * **Ships EMPTY on purpose.** The thirty names below are `seed-league.js`'s own
 * list, so the two cannot drift; the ids are blank because they are specific to
 * one Fantrax league and this repository is not the place for one league's
 * identifiers to be guessed. Fill them in, commit them if your league is the
 * only one this deployment ever serves, and run this.
 *
 * A blank id is SKIPPED rather than written: writing `''` would bind the Team
 * to a roster that does not exist, and because the column is unique it would
 * bind at most one Team and fail for the rest — a confusing half-map instead of
 * an honest empty one.
 */
const FANTRAX_TEAM_IDS = Object.freeze([
	['Atlanta Hawks', 'b78jbjximo8qu3i0'],
	['Brooklyn Nets', 'bdnt4y7wmo8qu3i1'],
	['Boston Celtics', '75zuuvlrmo8qu3i1'],
	['Charlotte Hornets', 'rll1ri51mo8qu3i1'],
	['Chicago Bulls', '0t0pgtaimo8qu3i1'],
	['Cleveland Cavaliers', '7ymaebkxmo8qu3i1'],
	['Dallas Mavericks', 'byrw2ai0mo8qu3i1'],
	['Denver Nuggets', 'pxrm4ix1mo8qu3i2'],
	['Detroit Pistons', 'xzmftrwsmo8qu3i2'],
	['Golden State Warriors', '0qpbjpwwmo8qu3i1'],
	['Houston Rockets', 'wb9w6d7kmo8qu3i2'],
	['Indiana Pacers', 'gwik4v8umo8qu3i2'],
	['Los Angeles Clippers', 'mvc0lt08mo8qu3i1'],
	['Los Angeles Lakers', '09a6i7pmmo8qu3i1'],
	['Memphis Grizzlies', 'vf29dv72mo8qu3i1'],
	['Miami Heat', 'ry0t2mpemo8qu3i1'],
	['Milwaukee Bucks', 'pc1ynaiumo8qu3i1'],
	['Minnesota Timberwolves', 'edrjvjllmo8qu3i0'],
	['New Orleans Pelicans', 'dpr3u1bnmo8qu3i2'],
	['New York Knicks', 'grpbw2wnmo8qu3i1'],
	['Orlando Magic', 'uveloqa3mo8qu3i1'],
	['Philadelphia 76ers', 'zhaj4m9bmo8qu3i1'],
	['Phoenix Suns', '3a3140ozmo8qu3i2'],
	['Portland Trail Blazers', 'kuudmgp1mo8qu3i1'],
	['Sacramento Kings', 'z5aqgj5ymo8qu3i1'],
	['San Antonio Spurs', 'rbssaiv0mo8qu3i1'],
	// This league plays SEA, not OKC — see `scripts/seed-league.js`, which
	// carries the same correction and the story of how it was found.
	['Seattle SuperSonics', 'azhzcmxbmo8qu3i1'],
	['Toronto Raptors', 'pdna5lr8mo8qu3i1'],
	['Utah Jazz', 'ouid6ygqmo8qu3i1'],
	['Washington Wizards', 'f6rn8exomo8qu3i1']
]);

function requireDatabaseUrl() {
	const url = process.env['SUPABASE_DB_URL'];
	if (url === undefined || url.trim() === '') {
		process.stderr.write(
			'SUPABASE_DB_URL is not set. Point it at the project you mean to seed, deliberately.\n'
		);
		process.exitCode = 1;
		return null;
	}
	return url;
}

async function main() {
	const url = requireDatabaseUrl();
	if (url === null) return;

	const dryRun = process.argv.includes('--dry-run');

	const client = new pg.Client({ connectionString: url });
	await client.connect();

	try {
		// Read the Teams first, so every decision below is made against what is
		// actually in the table rather than against what this file assumes.
		const { rows } = await client.query(
			'select id::text as id, name, fantrax_team_id from public.teams'
		);

		/** @type {Map<string, Array<{id: string, name: string, fantraxTeamId: string | null}>>} */
		const byName = new Map();
		for (const row of rows) {
			const name = String(row['name'] ?? '');
			const list = byName.get(name) ?? [];
			list.push({
				id: String(row['id'] ?? ''),
				name,
				fantraxTeamId: row['fantrax_team_id'] === null ? null : String(row['fantrax_team_id'])
			});
			byName.set(name, list);
		}

		/** @type {string[]} */
		const refused = [];
		/** @type {string[]} */
		const seenIds = [];
		let written = 0;
		let skipped = 0;

		// **One transaction around the whole loop, and a catch around each row.**
		//
		// Without both, the header's "IDEMPOTENT and SAFE" is not true. A prior
		// partial run leaves some ids written, so a re-run can collide with the
		// unique index on `teams.fantrax_team_id` — and an uncaught collision
		// aborts the loop mid-way with a raw stack trace, having written some
		// Teams and not others. The operator is then in a worse position than
		// before they ran it: a half-mapped League, which is exactly the state
		// this column exists to make impossible.
		//
		// The SAVEPOINT is what lets a single row fail without poisoning the
		// transaction: in Postgres any error inside a transaction block aborts the
		// whole block, so catching the exception is not enough on its own — every
		// later statement would fail with "current transaction is aborted".
		//
		// A dry run opens no transaction at all, because it writes nothing.
		if (!dryRun) await client.query('begin');
		try {
			for (const [teamName, fantraxTeamId] of FANTRAX_TEAM_IDS) {
				const id = String(fantraxTeamId).trim();
				if (id === '') {
					skipped += 1;
					continue;
				}

				const matches = byName.get(teamName) ?? [];
				// **Exactly one, or nothing.** Zero means the name in this file is
				// not the name in the table; two would mean the table's unique
				// constraint is gone, which is a bigger problem than this script.
				if (matches.length !== 1) {
					refused.push(
						`${teamName}: resolves to ${String(matches.length)} Team(s) in the table, not exactly one.`
					);
					continue;
				}

				if (seenIds.includes(id)) {
					refused.push(
						`${teamName}: the Fantrax team id ${id} is already claimed by another Team in this file.`
					);
					continue;
				}
				seenIds.push(id);

				if (dryRun) {
					process.stdout.write(`would set ${teamName} -> ${id}\n`);
					written += 1;
					continue;
				}

				const match = matches[0];
				if (match === undefined) continue;

				await client.query('savepoint one_team');
				try {
					await client.query('update public.teams set fantrax_team_id = $2 where id = $1::uuid', [
						match.id,
						id
					]);
					await client.query('release savepoint one_team');
					written += 1;
				} catch (error) {
					// Roll this ROW back and carry on. A collision with an id another
					// Team already holds — from a prior partial run, or from two
					// Teams typed with one id — is reported beside every other
					// refusal rather than ending the run.
					await client.query('rollback to savepoint one_team');
					refused.push(
						`${teamName}: the database refused the id ${id} — ${error instanceof Error ? error.message : String(error)}`
					);
				}
			}

			if (!dryRun) await client.query('commit');
		} catch (error) {
			// Anything the per-row catch did not cover: lose the whole run rather
			// than leave the League half-mapped.
			if (!dryRun) await client.query('rollback');
			throw error;
		}

		// Re-read, so the unmapped report is what the DATABASE says rather than
		// what this run believes it did.
		const after = await client.query(
			"select name from public.teams where fantrax_team_id is null or btrim(fantrax_team_id) = '' order by name"
		);
		const unmapped = after.rows.map((row) => String(row['name'] ?? ''));

		process.stdout.write(
			`\n${dryRun ? 'dry run: ' : ''}${String(written)} Team(s) mapped, ${String(skipped)} left blank in this file.\n`
		);

		if (refused.length > 0) {
			process.stdout.write(`\nrefused, and nothing was written for these:\n`);
			for (const line of refused) process.stdout.write(`  - ${line}\n`);
		}

		if (unmapped.length === 0) {
			process.stdout.write('\nEvery Team carries a Fantrax team id. The detector is configured.\n');
		} else {
			// NAMED, never counted.
			process.stdout.write(`\nstill unmapped — the detector reads as *not configured* for these:\n`);
			for (const name of unmapped) process.stdout.write(`  - ${name}\n`);
		}

		if (refused.length > 0) process.exitCode = 1;
	} finally {
		await client.end();
	}
}

await main();
