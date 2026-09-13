#!/usr/bin/env node
/**
 * Seed the league's Teams and Managers (Story 9.4).
 *
 * **There is no admin UI for this, by design.** `supabase/migrations/
 * 20260821010000_teams.sql:14` states it plainly: "No admin UI ships for
 * assigning either column. The Commissioner writes them directly." This script
 * is that direct write, made repeatable — thirty Team rows and their Manager
 * bindings typed by hand at midnight is exactly the failure mode this project
 * designs against everywhere else.
 *
 * `AGENTS.md` forbids typing SCHEMA into the Supabase dashboard. This is data,
 * not schema, so it is permitted — but it is checked in and re-runnable so that
 * what was seeded is reviewable, and so that wiping the pilot's data before the
 * real auction is one command rather than an afternoon.
 *
 * IDEMPOTENT. Re-running changes nothing that is already correct: Teams insert
 * on conflict-do-nothing against their unique name, and Managers upsert against
 * their unique Discord id, so a moderator's Team or Commissioner flag can be
 * corrected by editing the table below and running it again.
 *
 * Usage:
 *   SUPABASE_DB_URL='postgresql://...' node scripts/seed-league.js
 *   SUPABASE_DB_URL='postgresql://...' node scripts/seed-league.js --wipe
 *
 * The URL is read from the environment and never from a file this script finds
 * on its own, so pointing it at prod has to be a deliberate act — the same
 * discipline `scripts/verify-supabase.js` follows.
 *
 * NOTE: `npm run check` does NOT type-check `scripts/`, so this is plain JS
 * written defensively rather than TypeScript leaning on the compiler.
 */

import pg from 'pg';

/**
 * The thirty Teams, spelled out.
 *
 * Story 1.4's acceptance criteria fix this shape: displays render "the Team
 * name spelled out with the acting Manager attached — `Lakers — Meakel` —
 * never a three-letter abbreviation", because the glossary reserves a
 * three-letter capitalised abbreviation to mean a player's real-life NBA team
 * and nothing else. `UTA` is therefore what a Player's `Team` cell says, never
 * what a fantasy Team is called.
 *
 * The abbreviation is carried here only to key the moderator table below and to
 * make this list checkable against the league at a glance. It is never written
 * to the database.
 */
const TEAMS = Object.freeze([
	['ATL', 'Atlanta Hawks'],
	['BKN', 'Brooklyn Nets'],
	['BOS', 'Boston Celtics'],
	['CHA', 'Charlotte Hornets'],
	['CHI', 'Chicago Bulls'],
	['CLE', 'Cleveland Cavaliers'],
	['DAL', 'Dallas Mavericks'],
	['DEN', 'Denver Nuggets'],
	['DET', 'Detroit Pistons'],
	['GSW', 'Golden State Warriors'],
	['HOU', 'Houston Rockets'],
	['IND', 'Indiana Pacers'],
	['LAC', 'Los Angeles Clippers'],
	['LAL', 'Los Angeles Lakers'],
	['MEM', 'Memphis Grizzlies'],
	['MIA', 'Miami Heat'],
	['MIL', 'Milwaukee Bucks'],
	['MIN', 'Minnesota Timberwolves'],
	['NOP', 'New Orleans Pelicans'],
	['NYK', 'New York Knicks'],
	['ORL', 'Orlando Magic'],
	['PHI', 'Philadelphia 76ers'],
	['PHX', 'Phoenix Suns'],
	['POR', 'Portland Trail Blazers'],
	['SAC', 'Sacramento Kings'],
	['SAS', 'San Antonio Spurs'],
	// This league plays SEA, not OKC — "Bring Back the Sonics" is the league's
	// own name. Seeding the standard NBA thirty put an Oklahoma City Thunder row
	// here on 2026-09-06, and because `resolveTeamByFileName` matches a renamed
	// file to whatever Team bears that name, nine of thirty rosters imported
	// against the wrong Team and nothing detected it. SEA sorts after SAS by
	// abbreviation and after San Antonio by FULL NAME — the second of those is
	// what any download-ordering scheme has to use, and getting it wrong is
	// exactly how the first import shifted.
	['SEA', 'Seattle SuperSonics'],
	['TOR', 'Toronto Raptors'],
	['UTA', 'Utah Jazz'],
	['WAS', 'Washington Wizards']
]);

/**
 * A display name nobody has supplied yet.
 *
 * `managers.display_name` is `not null` with a not-blank check, and it is what
 * every surface renders — "Lakers — Meakel" in the Teams index, the actor on
 * every Audit Log line, the name beside a bid. There is no sensible default: a
 * Team named after itself ("Boston Celtics — Boston") tells a Manager nothing
 * and tells the log less. So an unfilled name is a REFUSAL rather than a
 * fallback, checked before the script connects — seeding thirty Managers and
 * then finding out is the expensive order to discover it in.
 */
const PENDING_NAME = '<pending>';

/**
 * The league's Managers — all thirty, one per Team.
 *
 * `discordUserId` is the account's own snowflake, which is what AD-15 binds
 * identity to: an account absent from this table is refused at sign-in without
 * the refusal revealing whether it, or any Team, exists.
 *
 * **The third pilot iteration admits every Manager.** Iterations 1 and 2 seeded
 * the seven moderators and gave the other 23 Teams inert placeholder Managers
 * (see `seedPlaceholders`) so the auction could open at all. That tested the
 * mechanics against thin competition: 23 of 30 Teams could neither nominate nor
 * bid, so no gate that only fires under real contention — a bid war, a
 * simultaneous nomination, a Team running out of cap mid-auction — was ever
 * exercised. This table is the fix, and placeholders are no longer used.
 *
 * The first seven keep `isCommissioner`, so any moderator can still drive
 * import, eligibility and auction-open during the test. Note the consequence:
 * any of the seven can open or RESET the auction, with 29 other people's work
 * inside it. Narrow this to one before the real auction (Story 9.8).
 *
 * The remaining 23 snowflakes came from `team_rosters/discord-ids/
 * 2026-snowflakes.txt` (collected 2026-09-12). Each decodes to a plausible
 * account-creation date, which is the only check possible from here — a
 * mistyped-but-well-formed snowflake is indistinguishable from a real one until
 * its owner tries to sign in and is refused. That refusal is the pilot's first
 * useful signal, so it is cheap to discover.
 */
const MANAGERS = Object.freeze([
	// The seven moderators, carrying the Commissioner flag.
	['UTA', 'Meakel', '184532951688675328', true],
	['ATL', 'Slothington', '634191652470390821', true],
	['CLE', 'George', '618505612053184518', true],
	['LAC', 'Michael', '475140401012015124', true],
	['DAL', 'Dustin', '360095790565294080', true],
	['DEN', 'Patton', '141642526531518464', true],
	['DET', 'Tchoy', '294127376927817729', true],
	// The other 23, as ordinary Managers.
	['BOS', 'foxforce', '1070324943579000943', false],
	['BKN', 'rc73', '404376181010333708', false],
	['CHA', 'Alex', '693636065717780500', false],
	['CHI', 'Tukeduke', '644271167200297023', false],
	['GSW', 'gauchovic', '1131102481963831296', false],
	['HOU', 'KDizzle', '698660868413587466', false],
	['IND', 'SteveX', '611987528236400650', false],
	['LAL', 'msaggio', '1261028905608020000', false],
	['MEM', 'Colby', '598363157622292482', false],
	['MIA', 'Mikkiel', '1150143448091983983', false],
	['MIL', 'Damian', '789320957343825940', false],
	['MIN', 'Row', '608152289236090881', false],
	['NOP', 'Captain Sprinkles', '606885233735893012', false],
	['NYK', 'Stered', '388499745745797121', false],
	['ORL', 'Kostas', '777613302310240277', false],
	// The snowflake file spells this one PHO; TEAMS keys it PHX, which is the
	// abbreviation the Phoenix Suns carry everywhere else in this repository.
	['PHX', 'guacmode', '500869116920594442', false],
	['PHI', 'BC55', '818338971078623256', false],
	['POR', 'Huskies', '818528555814092811', false],
	['SAC', 'Nik', '310908140478660608', false],
	['SAS', 'Polish Thunder', '508344019714310144', false],
	['SEA', 'baselinehammer', '843377633588543528', false],
	['TOR', 'Cobra', '609909836146147348', false],
	['WAS', 'PFru', '468421644164268032', false]
]);

/**
 * The Discord id prefix every placeholder Manager carries.
 *
 * Deliberately NOT a number. A Discord snowflake is an unbroken run of digits,
 * so a value starting with letters cannot collide with any real account —
 * nobody can ever sign in as a placeholder, whatever they hold. That property
 * is what makes seeding them safe rather than a back door: `managers` is the
 * registry AD-15 gates on, and adding a row that no Discord identity can match
 * adds a Team binding without adding an identity.
 */
const PLACEHOLDER_PREFIX = 'pilot-placeholder-';

/**
 * Give every Manager-less Team an inert Manager, so `refuseAuctionOpen`'s
 * unbound-Teams gate passes during a pilot.
 *
 * **Why this exists.** One Discord account is one `managers` row is one Team —
 * co-management shares a Team rather than giving one person two — so seven
 * moderators cannot cover thirty Teams, and the auction cannot open with any
 * Team unbound. That gate is correct: an unbound Team can neither nominate nor
 * bid, so its roster and cap space would sit inert while the auction ran around
 * it, and opening is irreversible.
 *
 * **What it costs.** Those Teams are inert anyway. A pilot run this way tests
 * the mechanics with however many real bidders there are, against a full-size
 * league and real rosters — thinner competition than the real auction, and
 * every gate, refusal, close and draw still exercised.
 *
 * PILOT ONLY. Story 9.8 seeds all thirty-one real Managers against prod, and
 * this function refuses to run there.
 *
 * **Unused from pilot iteration 3 (2026-09-12).** `MANAGERS` now names a real
 * Manager for every one of the thirty Teams, so `--placeholders` finds nothing
 * to do and says so. It is kept rather than deleted because the situation it
 * answers — a pilot that has to open with Teams nobody has claimed — recurs the
 * moment a Manager drops out and the auction still has to open on a schedule.
 */
async function seedPlaceholders(client) {
	const { rows } = await client.query(
		`select t.id, t.name
		   from public.teams t
		   left join public.managers m on m.team_id = t.id
		  where m.id is null
		  order by t.name`
	);
	if (rows.length === 0) {
		process.stdout.write('placeholders: every Team already has a Manager; nothing to do\n\n');
		return;
	}

	for (const row of rows) {
		const abbrev = TEAMS.find(([, name]) => name === String(row['name']))?.[0];
		if (abbrev === undefined) throw new Error(`Team "${String(row['name'])}" is not in TEAMS`);
		await client.query(
			`insert into public.managers (discord_user_id, display_name, team_id, is_commissioner)
			 values ($1, $2, $3, false)
			 on conflict (discord_user_id) do update
			   set team_id = excluded.team_id, is_commissioner = false`,
			[`${PLACEHOLDER_PREFIX}${abbrev.toLowerCase()}`, 'Unclaimed', String(row['id'])]
		);
	}

	process.stdout.write(
		`placeholders: ${String(rows.length)} inert Manager(s) seeded so the auction can open.\n` +
			`  These carry non-numeric Discord ids and CANNOT sign in. They are a pilot\n` +
			`  device only — wipe before the real auction, and never seed them on prod.\n\n`
	);
}

/**
 * Everything about `MANAGERS` that can be checked without a database.
 *
 * Returns every complaint rather than throwing on the first, so that filling in
 * twenty-three display names is one pass over one list instead of twenty-three
 * runs of the script.
 *
 * `discord_user_id` is the unique natural key the upsert below turns on, so two
 * rows sharing one snowflake do not fail — the second silently RE-BINDS the
 * first Manager to a different Team, leaving one Team unbound and one person
 * holding somebody else's roster. That is the one error here a database
 * constraint cannot catch, which is why it is checked here.
 */
function validateManagers() {
	const complaints = [];

	const pending = MANAGERS.filter(([, name]) => name === PENDING_NAME).map(([abbrev]) => abbrev);
	if (pending.length > 0) {
		complaints.push(
			`${String(pending.length)} Manager(s) have no display name yet: ${pending.join(', ')}`,
			'Fill them into the MANAGERS table in this file and run again.'
		);
	}

	const seenSnowflake = new Map();
	const seenTeam = new Map();
	for (const [abbrev, displayName, discordUserId] of MANAGERS) {
		if (TEAMS.find(([a]) => a === abbrev) === undefined) {
			complaints.push(`${abbrev} is not a Team abbreviation in TEAMS`);
		}
		if (!/^[0-9]{17,20}$/.test(discordUserId)) {
			complaints.push(
				`${abbrev}'s Discord id "${discordUserId}" is not a snowflake (17-20 digits)`
			);
		}
		const priorSnowflake = seenSnowflake.get(discordUserId);
		if (priorSnowflake !== undefined) {
			complaints.push(`${abbrev} and ${priorSnowflake} share the Discord id ${discordUserId}`);
		}
		seenSnowflake.set(discordUserId, abbrev);

		const priorTeam = seenTeam.get(abbrev);
		if (priorTeam !== undefined) {
			complaints.push(`${abbrev} appears twice (${priorTeam}, ${displayName})`);
		}
		seenTeam.set(abbrev, displayName);
	}

	return complaints;
}

async function main() {
	const url = process.env['SUPABASE_DB_URL'];
	if (url === undefined || url.trim() === '') {
		process.stderr.write(
			'SUPABASE_DB_URL is not set.\n' +
				"Run as: SUPABASE_DB_URL='postgresql://...' node scripts/seed-league.js\n"
		);
		process.exitCode = 1;
		return;
	}

	// Checked BEFORE connecting, for the same reason the prod guard below is: a
	// malformed MANAGERS table is a fact about this file, and finding out about
	// it from a constraint violation halfway through a transaction is strictly
	// worse than finding out before a socket is opened.
	const complaints = validateManagers();
	if (complaints.length > 0) {
		process.stderr.write(`MANAGERS is not seedable:\n  ${complaints.join('\n  ')}\n`);
		process.exitCode = 1;
		return;
	}

	const wipe = process.argv.includes('--wipe');
	const placeholders = process.argv.includes('--placeholders');

	// Checked BEFORE connecting. Refusing prod must not depend on reaching a
	// database — a guard that only fires after a successful connection is a
	// guard that fails open the moment the network does.
	if (placeholders && process.env['SUPABASE_ENVIRONMENT'] === 'prod') {
		process.stderr.write(
			'Refusing to seed placeholder Managers against prod.\n' +
				'Placeholders are a pilot device: they let the auction open with Teams nobody\n' +
				'owns. Story 9.8 seeds all thirty-one real Managers instead.\n'
		);
		process.exitCode = 1;
		return;
	}
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
		// One transaction: a half-seeded league is worse than an unseeded one,
		// because it looks finished.
		await client.query('begin');

		if (wipe) {
			// Managers first — `managers.team_id` references `teams(id)`, so the
			// Teams cannot go while a Manager still points at one. Rows in
			// `auction_events` reference both and are NOT deleted here: if the
			// delete fails on that foreign key, the auction has real history and
			// wiping the league out from under it is not something this script
			// should do quietly.
			const m = await client.query('delete from public.managers');
			const t = await client.query('delete from public.teams');
			process.stdout.write(
				`wiped: ${String(m.rowCount ?? 0)} manager(s), ${String(t.rowCount ?? 0)} team(s)\n\n`
			);
		}

		let teamsInserted = 0;
		for (const [, name] of TEAMS) {
			const result = await client.query(
				`insert into public.teams (name) values ($1)
				 on conflict (name) do nothing`,
				[name]
			);
			teamsInserted += result.rowCount ?? 0;
		}

		// Resolve every Team name to its id in one read, so the Manager loop
		// below binds against what is actually in the table rather than what
		// this script assumed it wrote.
		const { rows: teamRows } = await client.query('select id, name from public.teams');
		const idByName = new Map(teamRows.map((row) => [String(row['name']), String(row['id'])]));

		let managersWritten = 0;
		for (const [abbrev, displayName, discordUserId, isCommissioner] of MANAGERS) {
			const teamName = TEAMS.find(([a]) => a === abbrev)?.[1];
			if (teamName === undefined) throw new Error(`No Team in TEAMS for abbreviation ${abbrev}`);
			const teamId = idByName.get(teamName);
			if (teamId === undefined) throw new Error(`Team "${teamName}" is missing after seeding`);

			// Upsert on the Discord id, which is the unique natural key. A
			// re-run therefore corrects a display name, a Team binding or a
			// Commissioner flag rather than failing or duplicating.
			const result = await client.query(
				`insert into public.managers (discord_user_id, display_name, team_id, is_commissioner)
				 values ($1, $2, $3, $4)
				 on conflict (discord_user_id) do update
				   set display_name = excluded.display_name,
				       team_id = excluded.team_id,
				       is_commissioner = excluded.is_commissioner`,
				[discordUserId, displayName, teamId, isCommissioner]
			);
			managersWritten += result.rowCount ?? 0;
		}

		if (placeholders) await seedPlaceholders(client);

		await client.query('commit');

		process.stdout.write(
			`teams:    ${String(TEAMS.length)} expected, ${String(teamsInserted)} newly inserted\n` +
				`managers: ${String(MANAGERS.length)} expected, ${String(managersWritten)} written\n\n`
		);

		await report(client);
	} catch (error) {
		await client.query('rollback').catch(() => {
			/* the connection may already be gone; the original error is what matters */
		});
		process.stderr.write(
			`seed failed and rolled back: ${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exitCode = 1;
	} finally {
		await client.end();
	}
}

/** Read back what is actually there, rather than trusting the writes above. */
async function report(client) {
	const { rows } = await client.query(
		`select t.name as team, m.display_name, m.discord_user_id, m.is_commissioner
		   from public.teams t
		   left join public.managers m on m.team_id = t.id
		  order by t.name`
	);

	const managed = rows.filter((r) => r['display_name'] !== null);
	process.stdout.write(`${String(rows.length)} Teams, ${String(managed.length)} with a Manager\n\n`);
	for (const row of managed) {
		const flag = row['is_commissioner'] === true ? ' [commissioner]' : '';
		process.stdout.write(
			`  ${String(row['team']).padEnd(24)} ${String(row['display_name']).padEnd(14)} ${String(row['discord_user_id'])}${flag}\n`
		);
	}

	const unmanaged = rows.filter((r) => r['display_name'] === null).map((r) => String(r['team']));
	if (unmanaged.length > 0) {
		process.stdout.write(
			// From iteration 3 on, MANAGERS covers all thirty Teams, so this list
			// should be empty — and an unbound Team refuses `auctionOpen`, which
			// is a thing to learn here rather than at the moment of opening.
			`\n  ⚠ ${String(unmanaged.length)} Team(s) with no Manager — the auction cannot open until each is bound:\n  ${unmanaged.join(', ')}\n`
		);
	}
}

await main();
