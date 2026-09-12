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

/**
 * Every migration this checkout expects, in the order `supabase db push`
 * applies them.
 *
 * Transcribed deliberately rather than read from `supabase/migrations/`: the
 * point is an INDEPENDENT statement of what should be there, so a file
 * deleted from the repository still shows up as missing from the database.
 * Reading the directory would compare the database to itself.
 *
 * No count is stated here on purpose. This comment said "13" while three
 * later migrations existed, and the check passed anyway -- `missing` is
 * `EXPECTED_MIGRATIONS` minus `applied`, so a version absent from this array
 * is not required of the database AT ALL. A database missing two migrations
 * the checkout needed reported PASS and named neither. Add the version here
 * in the same commit that adds the file.
 */
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
	'20260904000000',
	'20260907000000',
	'20260910000000',
	'20260911000000'
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
 * `auction_watermark` is the one table with RLS **enabled but not forced**, and
 * that is deliberate rather than an oversight — `20260902000000_watermark.sql`
 * argues it at length. Forcing subjects the table OWNER to its policies, and
 * the owner is exactly who `raise_auction_watermark()` runs as, so the trigger's
 * UPDATE would then need an update policy — "and an update policy is a thing
 * that can be granted to a role by mistake". Leaving the owner unforced keeps
 * the write path a `security definer` function and nothing else. Client roles
 * are subject to RLS either way, since neither is the owner.
 *
 * Asserted by name so that a *second* unforced table is a failure rather than
 * something this check quietly tolerates.
 */
const RLS_ENABLED_NOT_FORCED = 'auction_watermark';

/**
 * The exact privileges each deliberately-narrowed table grants, by role.
 *
 * Several migrations follow a revoke-then-grant-back pattern, because Supabase's
 * default privileges hand `service_role` ALL on a newly created table: every
 * privilege is revoked outright and precisely what the server needs is granted
 * back. Checking only for the revoke — as an earlier version of this script did
 * — would have called that pattern a failure. What matters is the *resulting*
 * set, and the omissions in it are load-bearing:
 *
 *   - `auction_events` grants SELECT and INSERT and **deliberately not UPDATE
 *     or DELETE**. That is the append-only log enforced at the grant, not only
 *     by convention — the single most valuable assertion in this file.
 *   - `auction_contention_seeds` grants **nothing to anybody** (AD-14). A
 *     lottery seed readable before the draw defeats the commit-reveal entirely,
 *     so the only identity that reaches it is the direct connection.
 *   - `auction_watermark` grants `authenticated` SELECT and `service_role`
 *     nothing at all — not even SELECT, because the server answers liveness
 *     from `auction_events`' own `max(seq)` (AD-29) and never reads this cache.
 *
 * Tables absent from this map keep Supabase's platform defaults for
 * `service_role`, which the migrations knowingly rely on. Their exact default
 * set is the platform's to change, so it is not pinned here — but the
 * anon/authenticated check below still applies to every table in the schema.
 */
const EXPECTED_GRANTS = {
	auction_events: { service_role: 'INSERT,SELECT' },
	auction_contention_seeds: {},
	auction_watermark: { authenticated: 'SELECT' },
	open_nominations: { service_role: 'DELETE,INSERT,SELECT' },
	tick_heartbeats: { service_role: 'INSERT,SELECT' },
	notification_outbox: { service_role: 'INSERT,SELECT' },
	manager_notification_preferences: { service_role: 'INSERT,SELECT,UPDATE' }
};

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
		await checkPoolStatusView(client);
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
		record(
			false,
			`All ${String(EXPECTED_MIGRATIONS.length)} migrations applied`,
			'supabase_migrations.schema_migrations is unreadable'
		);
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

	// RLS enabled everywhere, no exceptions.
	const rlsOff = EXPECTED_TABLES.filter((name) => found.get(name)?.['enabled'] !== true);
	record(
		rlsOff.length === 0,
		'RLS enabled on every table (AD-16)',
		rlsOff.length === 0 ? '' : `not enabled: ${rlsOff.join(', ')}`
	);

	// Forced everywhere except the one table that documents why it must not be.
	const shouldForce = EXPECTED_TABLES.filter((name) => name !== RLS_ENABLED_NOT_FORCED);
	const notForced = shouldForce.filter((name) => found.get(name)?.['forced'] !== true);
	record(
		notForced.length === 0,
		`RLS forced on all ${String(shouldForce.length)} tables that take it (AD-16)`,
		notForced.length === 0 ? '' : `not forced: ${notForced.join(', ')}`
	);

	// And the exception is still the exception. If this ever starts passing by
	// being forced, the security-definer trigger argument needs revisiting; if
	// another table joins it, that is a silent widening.
	record(
		found.get(RLS_ENABLED_NOT_FORCED)?.['forced'] === false,
		`${RLS_ENABLED_NOT_FORCED} is enabled but NOT forced, as its migration argues`,
		'the security-definer trigger owns the write path'
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
	const { rows } = await client.query(
		`select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
		   from information_schema.role_table_grants
		  where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')
		  group by table_name, grantee`
	);

	/** table -> role -> comma-joined privileges, as they actually are. */
	const actual = new Map();
	for (const row of rows) {
		const table = String(row['table_name']);
		if (!actual.has(table)) actual.set(table, {});
		actual.get(table)[String(row['grantee'])] = String(row['privs']);
	}

	// `anon` is the browser before sign-in. It holds nothing, anywhere, full
	// stop — there is no table in this schema it is meant to read.
	const anonGrants = rows.filter((row) => String(row['grantee']) === 'anon');
	record(
		anonGrants.length === 0,
		'anon holds no privilege on any table, anywhere',
		anonGrants.length === 0
			? ''
			: anonGrants.map((r) => `${String(r['table_name'])}:${String(r['privs'])}`).join(', ')
	);

	// Each deliberately-narrowed table matches its intended set exactly. An
	// extra privilege is a widening; a missing one breaks a write path.
	for (const [table, expected] of Object.entries(EXPECTED_GRANTS)) {
		const got = actual.get(table) ?? {};
		const roles = [...new Set([...Object.keys(expected), ...Object.keys(got)])].sort();
		const differences = roles
			.filter((role) => (expected[role] ?? '') !== (got[role] ?? ''))
			.map((role) => `${role}: expected '${expected[role] ?? 'none'}', got '${got[role] ?? 'none'}'`);
		record(
			differences.length === 0,
			`${table} grants exactly what its migration intends`,
			differences.length === 0
				? Object.entries(expected)
						.map(([role, privs]) => `${role}=${privs}`)
						.join(' ') || 'nothing to any client-facing role'
				: differences.join('; ')
		);
	}
}

/**
 * `import_pool_status` is a view, not a table, so the table checks skip it.
 * It carries `security_invoker = on`, which makes it run with the querying
 * role's privileges rather than its definer's — without that, a view over
 * RLS-protected staging tables would hand its reader the definer's access.
 */
async function checkPoolStatusView(client) {
	const { rows } = await client.query(
		`select c.reloptions
		   from pg_class c
		   join pg_namespace n on n.oid = c.relnamespace
		  where n.nspname = 'public' and c.relname = 'import_pool_status' and c.relkind = 'v'`
	);
	if (rows.length === 0) {
		record(false, 'View import_pool_status exists', 'absent');
		return;
	}
	const options = rows[0]?.['reloptions'] ?? [];
	record(
		// Postgres records the option as written, so both `on` and `true` are
		// the same setting and either must satisfy this check.
		Array.isArray(options) &&
			options.some((o) => /^security_invoker=(on|true)$/i.test(String(o).replace(/\s/g, ''))),
		'View import_pool_status has security_invoker = on',
		Array.isArray(options) && options.length > 0 ? options.join(', ') : 'no reloptions set'
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
