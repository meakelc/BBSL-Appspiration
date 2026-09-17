#!/usr/bin/env node
/**
 * Set Minor League Eligibility for the whole Free Agent pool from a CSV, in
 * bulk, through the application's own write path.
 *
 * **Why this exists.** `/minor-league-eligibility` is the sanctioned surface
 * and it works — but it renders the entire pool as one flat list with no
 * pagination, search or filter (a gap already logged in `deferred-work.md`),
 * and the real pool is 1,467 Players of whom roughly 950 are eligible.
 * Ticking 950 checkboxes on one page at midnight on setup day is the failure
 * mode this project designs against everywhere else — the same argument
 * `seed-league.js` makes for the thirty Teams.
 *
 * **This is NOT a second writer of `minor_league_eligible`.**
 * `src/lib/server/eligibility.ts` states that the column is written only
 * through `applyEligibilityProjection`, and that adding another path would be
 * the point at which "the column is the fold" stopped being true. So this
 * script does not write the column, append an event, or word a refusal. It
 * loads the real `setEligibility` through Vite's SSR module loader — the same
 * function `/minor-league-eligibility` calls, reached the way the dev server
 * reaches it, so `$env/dynamic/private` and the `$lib` alias resolve — and
 * hands it ids. Every gate is therefore the real one, re-derived inside the
 * real transaction under the real advisory lock:
 *
 *   - the phase, folded from the log. Outside Setup this refuses a POOLED
 *     Player, by FR-35 — that Player's flag is an input to cap arithmetic on
 *     every open Auction. It does NOT refuse a rostered Contract, which can
 *     have no open Auction, so a CSV naming only rostered Contracts runs in
 *     any phase. That is what the rostered-correction CSV is for;
 *   - the unknown-id check, against the live pool;
 *   - the no-op skip, so a Player already at the target value appends nothing.
 *
 * Vite is a devDependency, so this is a development/setup tool that a deploy
 * cannot run. That is the correct blast radius.
 *
 * **The CSV is the whole truth ABOUT THE PLAYERS IT NAMES.** For the pool CSV
 * that is the whole pool, which is what the paragraph below assumes. For a
 * CSV naming only rostered Contracts — the FR-44 correction path — it is the
 * whole truth about those Contracts and says nothing about the pool, so the
 * unset pass below touches only rows that CSV lists as `False` and `verify`
 * skips the column comparison entirely. Never mix the two populations in one
 * file: a pool CSV that omits a rostered Contract would not unset it, but a
 * reader would reasonably expect it to.
 *
 * Two
 * transactions run: one setting every `eligible=true` row, one unsetting every
 * `eligible=false` row. The second is not redundant — it is what makes a
 * re-run CORRECT a flag set wrongly by an earlier run or by hand, rather than
 * only ever adding. Both are idempotent: the no-op skip means a second run
 * over an unchanged CSV appends zero events. They are two transactions rather
 * than one because `setEligibility` takes a single direction; an interruption
 * between them leaves a state that is individually valid and that re-running
 * repairs.
 *
 * Usage:
 *   SUPABASE_DB_URL='postgresql://...' node scripts/set-minor-league-eligibility.js --as=Meakel
 *   SUPABASE_DB_URL='postgresql://...' node scripts/set-minor-league-eligibility.js --as=Meakel --confirm
 *
 * Without `--confirm` it reports what would change and writes nothing. Flags:
 *   --as=<display name>  the Commissioner the events are attributed to (required)
 *   --from=<path>        the CSV (default team_rosters/minor-league-eligibility.csv)
 *   --confirm            actually append the events
 *   --verbose            name every Player rather than counting them
 *
 * The CSV needs a header and two columns: `fantrax_id` and `eligible`
 * (`True`/`False`). Every other column is carried for the reader's benefit —
 * `career_gp` is why each row says what it says — and is ignored here.
 *
 * The default path sits under `team_rosters/`, which `.gitignore` excludes:
 * the file is keyed to one Fantrax pool export's ids, so it is league data on
 * that rule's own reasoning and goes stale when the pool is re-imported. It is
 * regenerated from the export plus career games played, not hand-maintained.
 *
 * PILOT/DEV ONLY by default. Refuses when SUPABASE_ENVIRONMENT is `prod`
 * unless `--allow-prod` is also passed, checked before connecting: a guard
 * that only fires after a successful connection fails open the moment the
 * network does.
 *
 * NOTE: `npm run check` does NOT type-check `scripts/`, so this is plain JS
 * written defensively rather than TypeScript leaning on the compiler.
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { createServer } from 'vite';

const DEFAULT_CSV = 'team_rosters/minor-league-eligibility.csv';

/** Read `--name=value` and bare `--name` flags. */
function readFlags(argv) {
	const flags = new Map();
	for (const arg of argv) {
		if (!arg.startsWith('--')) continue;
		const eq = arg.indexOf('=');
		if (eq === -1) flags.set(arg.slice(2), true);
		else flags.set(arg.slice(2, eq), arg.slice(eq + 1));
	}
	return flags;
}

/**
 * Parse the CSV into the two id lists.
 *
 * A deliberately small parser rather than `csv-parse`: this file is written by
 * this repo, both fields it reads are opaque tokens with no commas or quotes,
 * and a row whose `eligible` column is neither `True` nor `False` is REFUSED
 * rather than defaulted. Defaulting it would silently unset a Player over a
 * typo, and the column is an input to cap arithmetic.
 */
function parseCsv(text, source) {
	const lines = text.trim().split(/\r?\n/);
	if (lines.length < 2) throw new Error(`${source} has a header and no rows`);

	const header = lines[0].split(',').map((cell) => cell.trim());
	const idAt = header.indexOf('fantrax_id');
	const eligibleAt = header.indexOf('eligible');
	if (idAt === -1 || eligibleAt === -1) {
		throw new Error(
			`${source} needs both a 'fantrax_id' and an 'eligible' column; found: ${header.join(', ')}`
		);
	}

	const eligible = [];
	const notEligible = [];
	const seen = new Set();
	for (let i = 1; i < lines.length; i += 1) {
		const cells = lines[i].split(',');
		const id = (cells[idAt] ?? '').trim();
		const flag = (cells[eligibleAt] ?? '').trim();
		if (id === '') throw new Error(`${source} line ${String(i + 1)} has no fantrax_id`);
		if (seen.has(id)) {
			throw new Error(`${source} names ${id} twice; which row is meant is unknowable`);
		}
		seen.add(id);
		if (flag === 'True') eligible.push(id);
		else if (flag === 'False') notEligible.push(id);
		else {
			throw new Error(
				`${source} line ${String(i + 1)} has eligible='${flag}', which is neither True nor False`
			);
		}
	}
	return { eligible, notEligible };
}

/**
 * Resolve the Commissioner the events are attributed to.
 *
 * Named on the command line and resolved against `managers` — never defaulted
 * to "the first Commissioner". `auction_events.manager_id`/`team_id` are NOT
 * NULL (AD-4) and every event in the Audit Log says who did this; a script
 * that picked the actor for you would put a name in the log that never agreed
 * to be there.
 */
async function resolveActor(client, displayName) {
	const { rows } = await client.query(
		`select m.id, m.display_name, m.team_id, m.is_commissioner, t.name as team
		   from public.managers m
		   left join public.teams t on t.id = m.team_id
		  order by m.display_name`
	);

	const commissioners = rows
		.filter((row) => row['is_commissioner'] === true)
		.map((row) => `  --as=${String(row['display_name'])}`)
		.join('\n');

	if (typeof displayName !== 'string' || displayName === '') {
		throw new Error(
			`--as=<display name> is required: every appended event names its actor.\nCommissioners on this database:\n${commissioners}`
		);
	}

	const matches = rows.filter((row) => String(row['display_name']) === displayName);
	if (matches.length === 0) {
		throw new Error(
			`no Manager is named '${displayName}'.\nCommissioners on this database:\n${commissioners}`
		);
	}
	if (matches.length > 1) {
		throw new Error(
			`'${displayName}' names ${String(matches.length)} Managers; the actor would be a guess`
		);
	}

	// Both checks mirror the route's own guards rather than trusting the flag:
	// `requireCommissioner`, and the unbound-actor refusal it raises when a
	// Commissioner has no Team for the event to name.
	const actor = matches[0];
	if (actor['is_commissioner'] !== true) {
		throw new Error(`'${displayName}' is not a Commissioner; only a Commissioner may set this flag`);
	}
	if (actor['team_id'] === null) {
		throw new Error(`'${displayName}' is not bound to a Team, and every event must name one`);
	}
	return {
		managerId: String(actor['id']),
		teamId: String(actor['team_id']),
		team: String(actor['team'])
	};
}

/** Print a set of Players: counted by default, named under --verbose. */
function report(label, players, verbose, nameOf) {
	if (players.length === 0) return;
	process.stdout.write(`  ${label}: ${String(players.length)}\n`);
	if (!verbose) return;
	for (const player of players) process.stdout.write(`      ${nameOf(player)}\n`);
}

async function main() {
	const flags = readFlags(process.argv.slice(2));
	const confirm = flags.get('confirm') === true;
	const verbose = flags.get('verbose') === true;
	const fromFlag = flags.get('from');
	const csvPath = typeof fromFlag === 'string' ? fromFlag : DEFAULT_CSV;

	if (process.env['SUPABASE_ENVIRONMENT'] === 'prod' && flags.get('allow-prod') !== true) {
		process.stderr.write(
			'refusing: SUPABASE_ENVIRONMENT is prod. Pass --allow-prod if that is genuinely meant.\n'
		);
		process.exitCode = 1;
		return;
	}

	const { eligible, notEligible } = parseCsv(await readFile(csvPath, 'utf8'), csvPath);
	process.stdout.write(
		`${csvPath}: ${String(eligible.length + notEligible.length)} Players, ` +
			`${String(eligible.length)} Minor League Eligible, ${String(notEligible.length)} not\n\n`
	);

	// The dev server's own module graph, so `$env/dynamic/private` and `$lib`
	// resolve exactly as they do in the running app.
	const vite = await createServer({
		server: { middlewareMode: true },
		appType: 'custom',
		logLevel: 'warn'
	});

	try {
		const { setEligibility } = await vite.ssrLoadModule('/src/lib/server/eligibility.ts');
		const { writeGateway } = await vite.ssrLoadModule('/src/lib/shell/db.ts');

		const gateway = writeGateway();
		const client = await gateway.connect();
		let actor;
		try {
			actor = await resolveActor(client, flags.get('as'));
		} finally {
			client.release();
		}
		process.stdout.write(`acting as ${String(flags.get('as'))} — ${actor.team}\n\n`);

		if (!confirm) {
			// A dry run must not open the real transaction, so it cannot report the
			// phase — the phase is folded under the lock, which is the whole point.
			process.stdout.write(
				'DRY RUN — nothing was written.\n' +
					`Would submit ${String(eligible.length)} Players as Minor League Eligible and ` +
					`${String(notEligible.length)} as not, in two transactions.\n` +
					'A Player already at the requested value appends no event.\n' +
					'Re-run with --confirm to append. The phase is folded from the log inside the\n' +
					'transaction: that run refuses any POOLED Player named above unless the phase is\n' +
					'still Setup, and refuses no rostered Contract in any phase.\n'
			);
			return;
		}

		for (const [target, ids] of [
			[true, eligible],
			[false, notEligible]
		]) {
			const direction = target ? 'Minor League Eligible' : 'not Minor League Eligible';
			if (ids.length === 0) {
				process.stdout.write(`${direction}: no Player named, skipped.\n`);
				continue;
			}

			const { outcome, plan } = await setEligibility(gateway, actor, ids, target);

			if (outcome.kind === 'rejected') {
				// The sentence is the pure core's, carried through the rejection —
				// this script words no refusal of its own, as the route words none.
				process.stderr.write(
					`\n${direction}: REFUSED.\n${String(outcome.reason?.detail ?? 'The change was refused.')}\n`
				);
				process.exitCode = 1;
				return;
			}

			process.stdout.write(`${direction}: accepted.\n`);
			report(
				'changed, one event each',
				plan?.changes ?? [],
				verbose,
				(change) => `${change.playerName}: ${String(change.before)} -> ${String(change.after)}`
			);
			report('already at that value, no event', plan?.unchanged ?? [], verbose, (p) => p.playerName);
		}

		process.stdout.write('\n');
		await verify(gateway, eligible);
	} finally {
		await vite.close();
	}
}

/**
 * Read the column back, rather than trusting the writes above.
 *
 * **The column can only ever answer for POOLED Players.**
 * `minor_league_eligible` lives on `free_agent_players` and there is no such
 * column on `team_rosters`, so a CSV naming rostered Contracts — which FR-44
 * permits, and which the rostered-correction CSV is made entirely of — writes
 * a flag this check cannot see. Comparing the column against such a CSV's row
 * count compares two different populations and fails every time.
 *
 * So the expectation is computed from the ids the CSV names that ARE in the
 * pool, and a CSV naming none of them skips the comparison and says so. That
 * is not a weaker check, it is the only one the column can support: the
 * authority for a rostered Contract is the fold, and the run's own
 * accepted/changed report above is the fold's account of itself. Re-run the
 * script to confirm — a second pass over an unchanged CSV must report every
 * Player unchanged and append zero events.
 *
 * `eligible < named` rather than `!==`: the column legitimately holds MORE
 * eligible Players than this CSV names, because a rostered-correction CSV
 * names none of the 947 the pool run already set. Only a shortfall against
 * what this CSV asked for is a defect.
 */
async function verify(gateway, eligibleIds) {
	const client = await gateway.connect();
	try {
		const { rows } = await client.query(
			`select count(*)::int as pool,
			        count(*) filter (where minor_league_eligible)::int as eligible,
			        count(*) filter (where fantrax_player_id = any($1::text[]))::int as named
			   from public.free_agent_players`,
			[[...eligibleIds]]
		);
		const pool = Number(rows[0]['pool']);
		const eligible = Number(rows[0]['eligible']);
		const named = Number(rows[0]['named']);
		process.stdout.write(
			`free_agent_players: ${String(pool)} Players, ${String(eligible)} Minor League Eligible\n`
		);

		if (named === 0) {
			process.stdout.write(
				`  the CSV names ${String(eligibleIds.length)} eligible Players and NONE of them is in\n` +
					'  the pool, so every one is a rostered Contract and the column above says nothing\n' +
					'  about them. The fold is their authority; re-run this script to confirm it took —\n' +
					'  a second pass must report every Player unchanged and append no event.\n'
			);
			return;
		}

		if (named !== eligibleIds.length) {
			process.stdout.write(
				`  ${String(named)} of the CSV's ${String(eligibleIds.length)} eligible Players are pooled;\n` +
					'  the rest are rostered Contracts, which the column cannot hold.\n'
			);
		}

		if (eligible < named) {
			process.stdout.write(
				`\n  ⚠ the CSV names ${String(named)} eligible POOLED Players and the column holds only ` +
					`${String(eligible)}.\n` +
					'    An id in the CSV that is not in the live pool is refused before any write, so this\n' +
					'    means the pool and the CSV disagree about who is in it. Re-derive the CSV.\n'
			);
			process.exitCode = 1;
		}
	} finally {
		client.release();
	}
}

try {
	await main();
} catch (error) {
	// A refusal this script raises is a sentence for a person to read, not a
	// stack trace: every one of them names what to do instead.
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
