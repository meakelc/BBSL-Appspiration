#!/usr/bin/env node
/**
 * Verify a provisioned Supabase project against what this repository says
 * should be true of it (Story 9.1 AC 2 and AC 3).
 *
 * `supabase db push` exiting 0 proves the CLI issued some statements. It does
 * not prove the schema this repository describes is the schema that now
 * exists — a partially-applied migration, a table someone created by hand in
 * the dashboard, or an RLS policy that silently failed to apply all leave a
 * zero exit code behind. AC 2 asks for the applied state to be **verified
 * against the repository**, and this is that verification.
 *
 * READ-ONLY. Every statement here is a `select`. This script must never be
 * able to change the thing it is inspecting — a verifier that can write is a
 * verifier you cannot trust against production, and Story 9.8 runs it there.
 *
 * Usage:
 *   SUPABASE_DB_URL='postgresql://...' node scripts/verify-supabase.js
 *
 * The URL is read from the environment, never from a file this script finds
 * on its own, so pointing it at prod has to be a deliberate act.
 *
 * Exit 0 when every check passes; 1 when any fails. Nothing is printed that
 * would leak a credential — the connection string is never echoed.
 *
 * NOTE: `npm run check` does NOT type-check `scripts/` (the resolved tsconfig
 * `include` is `src/**` and `tests/**`), so this file is plain JS written
 * defensively rather than TypeScript leaning on the compiler.
 */

import pg from 'pg';

/** The 13 migrations, in the order `supabase db push` applies them. */
const EXPECTED_MIGRATIONS = [
	'20260821000000',
	'20260821010000',
	'20260821020000',
	'20260824000000',
	'20260824010000',
	'20260824020000',
	'20260825000000',
	'20260828000000',
	'20260831000000',
	'20260901000000',
	'20260902000000',
	'20260903000000',
	'20260904000000'
];

/**
 * Every table the migrations create. AD-16: each carries RLS **enabled and
 * forced** — forced so the table owner is not silently exempt either.
 */
const EXPECTED_TABLES = [
	'auction_contention_seeds',
	'auction_events',
	'auction_watermark',
	'free_agent_players',
	'import_pool_source',
	'import_staged_pool_players',
	'import_staged_rosters',
	'import_team_sources',
	'manager_notification_preferences',
	'managers',
	'notification_outbox',
	'open_nominations',
	'team_rosters',
	'teams',
	'tick_heartbeats'
];

/**
 * The only row-level policy in the entire schema. `auction_watermark` is the
 * one table a browser reads directly, because Story 4.1's Realtime freshness
 * subscription needs it; everything else is reached server-side through the
 * service role or the direct connection. A second policy appearing here is
 * not a passing variation — it is a client-facing read path nobody designed.
 */
const EXPECTED_POLICIES = [
	{ table: 'auction_watermark', name: 'auction_watermark_select_authenticated', cmd: 'SELECT' }
];

/**
 * Tables the service role is explicitly revoked from, so that the only
 * identity that reaches them is the direct `SUPABASE_DB_URL` connection.
 * `auction_contention_seeds` is the sharpest case (AD-14): a lottery seed
 * readable before the draw defeats the commit-reveal entirely.
 */
const SERVICE_ROLE_REVOKED = [
	'auction_contention_seeds',
	'auction_events',
	'auction_watermark',
	'manager_notification_preferences',
	'notification_outbox',
	'open_nominations',
	'tick_heartbeats'
];

const checks = [];
function record(ok, label, detail) {
	checks.push({ ok, label, detail });
}

async function main() {
	const url = process.env['SUPABASE_DB_URL'];
	if (url === undefined || url.trim() === '') {
		process.stderr.write(
			'SUPABASE_DB_URL is not set.\n' +
				"Run as: SUPABASE_DB_URL='postgresql://...' node scripts/verify-supabase.js\n"
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
		await checkServerVersion(client);
		await checkMigrations(client);
		await checkTables(client);
		await checkPolicies(client);
		await checkGrants(client);
		await checkExtensions(client);
		await checkTick(client);
	} finally {
		await client.end();
	}

	report();
}

async function checkServerVersion(client) {
	const { rows } = await client.query('show server_version');
	const version = String(rows[0]?.['server_version'] ?? '');
	const major = Number.parseInt(version, 10);
	// The spine pins ">=15.1.1.61 — required for sub-minute Supabase Cron".
	record(
		Number.isFinite(major) && major >= 15,
		`Postgres >= 15 (spine pin)`,
		`server_version ${version}`
	);
}

async function checkMigrations(client) {
	let applied;
	try {
		const { rows } = await client.query(
			'select version from supabase_migrations.schema_migrations order by version'
		);
		applied = rows.map((row) => String(row['version']));
	} catch {
		record(false, 'All 13 migrations applied', 'supabase_migrations.schema_migrations is unreadable');
		return;
	}

	const missing = EXPECTED_MIGRATIONS.filter((version) => !applied.includes(version));
	const unexpected = applied.filter((version) => !EXPECTED_MIGRATIONS.includes(version));

	record(
		missing.length === 0,
		`All ${String(EXPECTED_MIGRATIONS.length)} migrations applied`,
		missing.length === 0 ? `${String(applied.length)} recorded` : `missing: ${missing.join(', ')}`
	);
	// Not a failure: a later story legitimately adds migrations. It is still
	// worth naming, because an unrecognised version is also what a hand-edited
	// migrations table looks like.
	if (unexpected.length > 0) {
		record(true, 'Extra migrations present (newer than this checkout)', unexpected.join(', '));
	}
}

async function checkTables(client) {
	const { rows } = await client.query(
		`select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
		   from pg_class c
		   join pg_namespace n on n.oid = c.relnamespace
		  where n.nspname = 'public' and c.relkind = 'r'`
	);
	const found = new Map(rows.map((row) => [String(row['name']), row]));

	const missing = EXPECTED_TABLES.filter((name) => !found.has(name));
	record(
		missing.length === 0,
		`All ${String(EXPECTED_TABLES.length)} tables present`,
		missing.length === 0 ? '' : `missing: ${missing.join(', ')}`
	);

	const unprotected = EXPECTED_TABLES.filter((name) => {
		const row = found.get(name);
		return row !== undefined && !(row['enabled'] === true && row['forced'] === true);
	});
	record(
		unprotected.length === 0,
		'RLS enabled AND forced on every table (AD-16)',
		unprotected.length === 0 ? '' : `not forced: ${unprotected.join(', ')}`
	);

	const strays = [...found.keys()].filter((name) => !EXPECTED_TABLES.includes(name));
	if (strays.length > 0) {
		record(false, 'No tables beyond those the migrations create', `unexpected: ${strays.join(', ')}`);
	}
}

async function checkPolicies(client) {
	const { rows } = await client.query(
		`select tablename, policyname, cmd from pg_policies where schemaname = 'public'`
	);

	const actual = rows.map((row) => ({
		table: String(row['tablename']),
		name: String(row['policyname']),
		cmd: String(row['cmd'])
	}));

	const missing = EXPECTED_POLICIES.filter(
		(want) => !actual.some((got) => got.table === want.table && got.name === want.name)
	);
	const extra = actual.filter(
		(got) => !EXPECTED_POLICIES.some((want) => want.table === got.table && want.name === got.name)
	);

	record(
		missing.length === 0,
		'The one expected RLS policy exists (auction_watermark select)',
		missing.length === 0 ? '' : `missing: ${missing.map((p) => p.name).join(', ')}`
	);
	record(
		extra.length === 0,
		'No unexpected RLS policy — no undesigned client read path',
		extra.length === 0 ? '' : `unexpected: ${extra.map((p) => `${p.table}.${p.name}`).join(', ')}`
	);
}

async function checkGrants(client) {
	// `anon` and `authenticated` must hold no privilege on any table. The one
	// read the browser performs goes through the policy checked above, which
	// still requires the grant to be absent everywhere else.
	const { rows: clientGrants } = await client.query(
		`select table_name, grantee, privilege_type
		   from information_schema.role_table_grants
		  where table_schema = 'public' and grantee in ('anon', 'authenticated')`
	);
	// The watermark SELECT grant is the single legitimate exception.
	const offending = clientGrants.filter(
		(row) =>
			!(String(row['table_name']) === 'auction_watermark' && String(row['privilege_type']) === 'SELECT')
	);
	record(
		offending.length === 0,
		'anon/authenticated hold no table privilege beyond the watermark read',
		offending.length === 0
			? ''
			: offending
					.map((r) => `${String(r['table_name'])}:${String(r['grantee'])}:${String(r['privilege_type'])}`)
					.join(', ')
	);

	const { rows: serviceGrants } = await client.query(
		`select distinct table_name
		   from information_schema.role_table_grants
		  where table_schema = 'public' and grantee = 'service_role'`
	);
	const stillGranted = serviceGrants
		.map((row) => String(row['table_name']))
		.filter((name) => SERVICE_ROLE_REVOKED.includes(name));
	record(
		stillGranted.length === 0,
		'service_role revoked from the tables reached only by the direct connection',
		stillGranted.length === 0 ? '' : `still granted: ${stillGranted.join(', ')}`
	);
}

async function checkExtensions(client) {
	const { rows } = await client.query(
		`select extname, extversion from pg_extension where extname in ('pg_cron', 'pg_net')`
	);
	const found = new Map(rows.map((row) => [String(row['extname']), String(row['extversion'])]));
	for (const name of ['pg_cron', 'pg_net']) {
		record(found.has(name), `Extension ${name} installed`, found.get(name) ?? 'absent');
	}
}

async function checkTick(client) {
	let rows;
	try {
		({ rows } = await client.query(
			`select jobname, schedule, active from cron.job where jobname = 'bbsl-tick'`
		));
	} catch (error) {
		record(
			false,
			"cron.job readable and 'bbsl-tick' present",
			error instanceof Error ? error.message : String(error)
		);
		return;
	}

	const job = rows[0];
	record(job !== undefined, "The 'bbsl-tick' cron job exists (AD-10: exactly one)", `${String(rows.length)} found`);
	if (job === undefined) return;

	// AC 3, and the check that matters most on a fresh project: applying the
	// migrations must not start closing Auctions before anybody has said so.
	// Story 9.7 enables this for the pilot and disables it again afterward.
	record(
		job['active'] === false,
		"'bbsl-tick' is INACTIVE, as the migration creates it",
		`active=${String(job['active'])}, schedule='${String(job['schedule'])}'`
	);

	const { rows: allJobs } = await client.query('select count(*)::int as n from cron.job');
	record(
		Number(allJobs[0]?.['n'] ?? 0) === 1,
		'Exactly one cron job in the project (AD-10)',
		`${String(allJobs[0]?.['n'] ?? 0)} job(s)`
	);
}

function report() {
	let failed = 0;
	for (const check of checks) {
		const mark = check.ok ? 'PASS' : 'FAIL';
		if (!check.ok) failed += 1;
		const detail = check.detail === '' ? '' : `  — ${check.detail}`;
		process.stdout.write(`${mark}  ${check.label}${detail}\n`);
	}
	process.stdout.write(
		`\n${String(checks.length - failed)}/${String(checks.length)} checks passed.\n`
	);
	if (failed > 0) {
		process.stdout.write(
			'\nDo NOT fix a failure in the Supabase dashboard. Every schema change is a\n' +
				'migration file in supabase/migrations/, applied dev-first (AD-26).\n'
		);
		process.exitCode = 1;
	}
}

await main();
