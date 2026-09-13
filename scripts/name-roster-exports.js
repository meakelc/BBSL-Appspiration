#!/usr/bin/env node
/**
 * Give each Fantrax roster export a filename the importer can resolve to a
 * Team (Story 9.4 / the deferred entry on file-to-Team resolution).
 *
 * **Why this exists.** Story 1.7 requires that "each file resolves
 * independently to exactly one of the 30 Teams by name", but Fantrax names a
 * team-roster export after the LEAGUE: a real download is thirty files called
 * `Fantrax-Team-Roster-<league>(n).csv`. `resolveTeamByFileName` matches a
 * Team whose normalised name is contained in the file stem, so no Team name
 * can tell those thirty apart. The export carries no team column either
 * (Story 9.5), so nothing inside the file resolves it. The ONLY signal is the
 * order the Commissioner downloaded them in.
 *
 * This script turns that order into names, once, in a declared and reviewable
 * place — rather than thirty manual renames per import, each of which can go
 * wrong silently.
 *
 * **READ THIS BEFORE TRUSTING THE OUTPUT.** The ordering below is asserted by
 * the Commissioner, not derived from the files. Nothing in the data can confirm
 * it: two rosters swapped here produce two Teams whose Cap Space, Roster Count
 * and every bid gate are computed against the wrong players, and every screen
 * will look entirely normal. The summary this prints exists to be checked by a
 * human who knows the league — spot-check several Teams against their most
 * expensive player before importing.
 *
 * Copies rather than moves, so the originals survive a wrong ordering and a
 * re-run is free.
 *
 * Usage:
 *   node scripts/name-roster-exports.js [sourceDir] [outDir]
 *
 * Defaults: `team_rosters/` -> `team_rosters/by-team/`.
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The download order, as stated by the Commissioner on 2026-09-05: the file
 * with no `(n)` suffix is their own Team, and `(1)` through `(29)` are the
 * remaining twenty-nine alphabetically **by full city name**.
 *
 * By city, not by abbreviation — the two differ, and the difference is not
 * cosmetic. By abbreviation `BKN` precedes `BOS`; by city Boston precedes
 * Brooklyn. Getting that backwards silently swaps two Teams' rosters, which is
 * exactly the failure this file's header warns about.
 *
 * Index 0 is the unsuffixed file. Index n is `(n)`.
 */
const ORDERED_TEAMS = Object.freeze([
	'Utah Jazz', // the unsuffixed export — the Commissioner's own Team
	'Atlanta Hawks', // (1)
	'Boston Celtics', // (2)
	'Brooklyn Nets', // (3)
	'Charlotte Hornets', // (4)
	'Chicago Bulls', // (5)
	'Cleveland Cavaliers', // (6)
	'Dallas Mavericks', // (7)
	'Denver Nuggets', // (8)
	'Detroit Pistons', // (9)
	'Golden State Warriors', // (10)
	'Houston Rockets', // (11)
	'Indiana Pacers', // (12)
	'Los Angeles Clippers', // (13)
	'Los Angeles Lakers', // (14)
	'Memphis Grizzlies', // (15)
	'Miami Heat', // (16)
	'Milwaukee Bucks', // (17)
	'Minnesota Timberwolves', // (18)
	'New Orleans Pelicans', // (19)
	'New York Knicks', // (20)
	// NO Oklahoma City Thunder. This league plays Seattle, and an OKC entry sat
	// here until 2026-09-12 — the same mistake `seed-league.js` records against
	// TEAMS, left uncorrected in this file after that one was fixed. It shifted
	// every entry from here down by one, so files (21) through (27) were each
	// named for the Team ABOVE their real owner, and the thirtieth file was
	// named for a Team that does not exist.
	//
	// Iteration 2 imported through that list and was corrected by hand
	// afterwards. `_bmad-output/pilot-2-archive/team_rosters.json` is therefore
	// evidence rather than assertion: the order below reproduces, for all thirty
	// Teams, the highest-paid player each Manager confirmed as their own.
	//
	// Seattle sorts by FULL NAME — after San Antonio, before Toronto. By
	// abbreviation SEA would follow SAS too, but that agreement is a coincidence
	// of these two names and not the rule this list follows.
	'Orlando Magic', // (21)
	'Philadelphia 76ers', // (22)
	'Phoenix Suns', // (23)
	'Portland Trail Blazers', // (24)
	'Sacramento Kings', // (25)
	'San Antonio Spurs', // (26)
	'Seattle SuperSonics', // (27)
	'Toronto Raptors', // (28)
	'Washington Wizards' // (29)
]);

const sourceDir = process.argv[2] ?? 'team_rosters';
const outDir = process.argv[3] ?? join(sourceDir, 'by-team');

/** `...Sonics(12).csv` -> 12; `...Sonics.csv` -> 0. Null if not a roster export. */
function suffixIndexOf(fileName) {
	if (!/^Fantrax-Team-Roster-/i.test(fileName)) return null;
	const match = /\((\d+)\)\.csv$/i.exec(fileName);
	if (match !== null) return Number(match[1]);
	return /\.csv$/i.test(fileName) ? 0 : null;
}

/**
 * The most expensive player on a roster, as the human-checkable fingerprint of
 * whose team this is. Parsed crudely and deliberately: this script must not
 * depend on the adapter, whose job is the real import.
 */
function headlinePlayer(csvText) {
	const lines = csvText.split(/\r?\n/).filter((l) => l.trim() !== '');
	let best = { name: '(none)', salary: -1 };
	// Row 0 is the preamble, row 1 the header, so data starts at index 2.
	for (const line of lines.slice(2)) {
		const cells = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
		const name = cells[2] ?? '';
		const salary = Number((cells[8] ?? '').replace(/,/g, ''));
		if (Number.isFinite(salary) && salary > best.salary) best = { name, salary };
	}
	return { ...best, rows: Math.max(0, lines.length - 2) };
}

function main() {
	if (!existsSync(sourceDir)) {
		process.stderr.write(`Source directory not found: ${sourceDir}\n`);
		process.exitCode = 1;
		return;
	}

	const byIndex = new Map();
	let poolFile = null;
	for (const fileName of readdirSync(sourceDir)) {
		if (/^Fantrax-Players-/i.test(fileName)) {
			poolFile = fileName;
			continue;
		}
		const index = suffixIndexOf(fileName);
		if (index === null) continue;
		if (byIndex.has(index)) {
			process.stderr.write(`Two files claim suffix (${String(index)}) — cannot proceed.\n`);
			process.exitCode = 1;
			return;
		}
		byIndex.set(index, fileName);
	}

	const missing = ORDERED_TEAMS.map((_, i) => i).filter((i) => !byIndex.has(i));
	if (missing.length > 0) {
		process.stderr.write(
			`Expected ${String(ORDERED_TEAMS.length)} roster exports, indexes 0-${String(ORDERED_TEAMS.length - 1)}.\n` +
				`Missing: ${missing.join(', ')}\n`
		);
		process.exitCode = 1;
		return;
	}
	if (byIndex.size !== ORDERED_TEAMS.length) {
		process.stderr.write(
			`Found ${String(byIndex.size)} roster exports, expected exactly ${String(ORDERED_TEAMS.length)}.\n`
		);
		process.exitCode = 1;
		return;
	}

	mkdirSync(outDir, { recursive: true });

	process.stdout.write(
		`${'source'.padEnd(12)} ${'Team'.padEnd(24)} ${'rows'.padEnd(5)} highest-paid player\n` +
			`${'-'.repeat(78)}\n`
	);

	for (const [index, teamName] of ORDERED_TEAMS.entries()) {
		const sourceName = byIndex.get(index);
		const text = readFileSync(join(sourceDir, sourceName), 'utf8');
		writeFileSync(join(outDir, `${teamName}.csv`), text);

		const { name, salary, rows } = headlinePlayer(text);
		const label = index === 0 ? '(none)' : `(${String(index)})`;
		const money = salary >= 0 ? `$${(salary / 1_000_000).toFixed(1)}M` : '—';
		process.stdout.write(
			`${label.padEnd(12)} ${teamName.padEnd(24)} ${String(rows).padEnd(5)} ${name} ${money}\n`
		);
	}

	if (poolFile !== null) {
		writeFileSync(join(outDir, 'Free Agent Pool.csv'), readFileSync(join(sourceDir, poolFile), 'utf8'));
		process.stdout.write(`\npool export copied as "Free Agent Pool.csv"\n`);
	} else {
		process.stdout.write(`\nNo Fantrax-Players-*.csv found — the pool export is missing.\n`);
	}

	process.stdout.write(
		`\n${String(ORDERED_TEAMS.length)} roster files written to ${outDir}\n\n` +
			'CHECK THE TABLE ABOVE BEFORE IMPORTING. The ordering is asserted, not\n' +
			'derived — nothing in these files says which Team they belong to. Two rows\n' +
			'swapped here produce two Teams whose Cap Space and bid gates are computed\n' +
			'against the wrong players, and every screen will look normal.\n'
	);
}

main();
