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
 * The download order, as stated by the Commissioner on **2026-09-14** for the
 * setup-day export: **plain alphabetical by full team name, with no special
 * first file.** The unsuffixed export is Atlanta, `(1)` is Boston, and so on
 * through `(29)` Washington.
 *
 * **This CHANGED on 2026-09-14 and the change is the dangerous kind.** The
 * 2026-09-05 pilot download put the Commissioner's own Team (Utah Jazz) in the
 * unsuffixed slot and ran the other twenty-nine alphabetically from `(1)`. The
 * fresh export does not: Utah sits in its alphabetical position between Toronto
 * and Washington like everyone else. Re-running the old list against the new
 * files would have named thirty files for the wrong Teams — Utah's roster onto
 * Atlanta, and every Team from Atlanta to Toronto shifted one slot early.
 *
 * Nothing in the data would have objected. That is why this list is the only
 * place the order is written, and why it carries a date.
 *
 * By full team name, not by abbreviation — the two differ and the difference is
 * not cosmetic. By abbreviation `BKN` precedes `BOS`; by name Boston precedes
 * Brooklyn. The spellings below are the ones Fantrax itself returns from
 * `getTeamRosters`, so sorting them here and sorting them there agree.
 *
 * Index 0 is the unsuffixed file. Index n is `(n)`.
 */
const ORDERED_TEAMS = Object.freeze([
	'Atlanta Hawks', // the unsuffixed export
	'Boston Celtics', // (1)
	'Brooklyn Nets', // (2)
	'Charlotte Hornets', // (3)
	'Chicago Bulls', // (4)
	'Cleveland Cavaliers', // (5)
	'Dallas Mavericks', // (6)
	'Denver Nuggets', // (7)
	'Detroit Pistons', // (8)
	'Golden State Warriors', // (9)
	'Houston Rockets', // (10)
	'Indiana Pacers', // (11)
	'Los Angeles Clippers', // (12)
	'Los Angeles Lakers', // (13)
	'Memphis Grizzlies', // (14)
	'Miami Heat', // (15)
	'Milwaukee Bucks', // (16)
	'Minnesota Timberwolves', // (17)
	'New Orleans Pelicans', // (18)
	'New York Knicks', // (19)
	// NO Oklahoma City Thunder. This league plays Seattle, and an OKC entry sat
	// here until 2026-09-12 — the same mistake `seed-league.js` records against
	// TEAMS, left uncorrected in this file after that one was fixed. It shifted
	// every entry from here down by one, so files (21) through (27) were each
	// named for the Team ABOVE their real owner, and the thirtieth file was
	// named for a Team that does not exist.
	//
	// Iteration 2 imported through that list and was corrected by hand
	// afterwards. That correction is no longer what validates this list: the
	// 2026-09-14 re-export changed the order, so `pilot-2-archive` now attests
	// to the PREVIOUS arrangement and cannot vouch for this one. What validates
	// this list is the check described below, run against the fresh files.
	//
	// Seattle sorts by FULL NAME — after San Antonio, before Toronto. By
	// abbreviation SEA would follow SAS too, but that agreement is a coincidence
	// of these two names and not the rule this list follows.
	'Orlando Magic', // (20)
	'Philadelphia 76ers', // (21)
	'Phoenix Suns', // (22)
	'Portland Trail Blazers', // (23)
	'Sacramento Kings', // (24)
	'San Antonio Spurs', // (25)
	'Seattle SuperSonics', // (26)
	'Toronto Raptors', // (27)
	// Utah in its alphabetical place. It was index 0 for the pilot download and
	// is not special any more; this single line is the whole difference between
	// the two orderings, and it shifts every Team above it by one.
	'Utah Jazz', // (28)
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
