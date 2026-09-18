import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';

import { fold } from '../src/lib/core/projection/fold.ts';
import {
	INITIAL_WATERMARK,
	higherSeq,
	watermarkReducer
} from '../src/lib/core/projection/watermark.ts';
import type { AppendedEvent } from '../src/lib/core/types.ts';
import { resolveLeagueRead, resolveLeagueReadOrDefault } from '../src/lib/server/phase.ts';
import {
	WATERMARK_UNAUTHENTICATED_STATUS,
	WATERMARK_UNAVAILABLE_STATUS,
	readWatermark,
	serverInstant
} from '../src/lib/server/watermark.ts';
import { GET } from '../src/routes/api/watermark/+server.ts';

/**
 * The global watermark: the pure fold, the server resolution that carries it
 * onto every page, and the lightweight re-read the liveness endpoint answers
 * from.
 *
 * `seq` is a `bigint` column that arrives as a string at every runtime
 * boundary, so the comparisons below are deliberately driven past
 * `Number.MAX_SAFE_INTEGER` — the point where a `Number` comparison stops being
 * wrong in theory and starts being wrong in fact.
 */

/**
 * `server/phase.ts` and `server/watermark.ts` both import `serviceRoleClient`,
 * which reads `$env/dynamic/private` at module load. Every test below passes an
 * explicit fake client, so the real one is never built — this substitution is
 * only what lets the modules import at all, exactly as `tests/phase.test.ts`
 * does for the same reason.
 */
vi.mock('$env/dynamic/private', () => ({ env: {} }));

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');

/** One event, carrying nothing the watermark reducer reads except `seq`. */
function event(seq: string): AppendedEvent {
	return {
		seq,
		occurredAt: '2026-09-01T00:00:00.000Z',
		schemaVersion: 1,
		coreVersion: 1,
		type: 'Marker',
		payload: { marker: seq },
		managerId: 'm-1',
		teamId: 't-1',
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	} as unknown as AppendedEvent;
}

describe('INITIAL_WATERMARK', () => {
	it('is `\'0\'` — a value no row can hold', () => {
		// `seq` is `generated always as identity` and starts at 1, so '0' is
		// unambiguously "nothing yet" rather than "the first event".
		expect(INITIAL_WATERMARK).toBe('0');
	});

	it('is what an empty log folds to, with no special case', () => {
		expect(fold(INITIAL_WATERMARK, [], watermarkReducer)).toBe('0');
	});
});

describe('higherSeq', () => {
	it('takes the higher of two ordinary values', () => {
		expect(higherSeq('1', '2')).toBe('2');
		expect(higherSeq('2', '1')).toBe('2');
		expect(higherSeq('7', '7')).toBe('7');
	});

	it('compares beyond Number.MAX_SAFE_INTEGER, where `Number` stops working', () => {
		const safe = String(Number.MAX_SAFE_INTEGER); // 9007199254740991
		const above = '9007199254740993';
		const alsoAbove = '9007199254740992';

		// The failure this guards: both of these round to 9007199254740992 as
		// doubles, so a `Number` comparison reads them as EQUAL and the fold
		// silently keeps whichever it saw first.
		expect(Number(above) === Number(alsoAbove)).toBe(true);
		expect(higherSeq(alsoAbove, above)).toBe(above);
		expect(higherSeq(above, alsoAbove)).toBe(above);
		expect(higherSeq(safe, above)).toBe(above);
	});

	it('handles a seq far beyond any double, digit for digit', () => {
		const huge = '92233720368547758070';
		expect(higherSeq(huge, '9223372036854775807')).toBe(huge);
	});

	it('never lets an unreadable value win, and never lets it lower the answer', () => {
		expect(higherSeq('5', 'nonsense')).toBe('5');
		expect(higherSeq('nonsense', '5')).toBe('5');
		expect(higherSeq('5', '')).toBe('5');
		expect(higherSeq('5', '-1')).toBe('5');
		// Two unreadable values yield the first — in a fold, the state so far.
		expect(higherSeq('nonsense', 'also nonsense')).toBe('nonsense');
	});
});

describe('the fold', () => {
	it('reaches the highest seq in the log', () => {
		const events = ['1', '2', '3', '4'].map(event);
		expect(fold(INITIAL_WATERMARK, events, watermarkReducer)).toBe('4');
	});

	it('is ordered by seq via BigInt, through the same `fold()` every projection uses', () => {
		// `fold()` sorts by BigInt before reducing (AD-5), so a shuffled array
		// is folded in log order. The watermark would be right either way — see
		// the next test — but it must be reached through the ONE fold, not a
		// hand-rolled traversal in the shell.
		const shuffled = ['3', '10', '1', '2'].map(event);
		expect(fold(INITIAL_WATERMARK, shuffled, watermarkReducer)).toBe('10');
	});

	it('is order-independent in value, so an out-of-order array cannot lower it', () => {
		const forwards = ['1', '9007199254740993', '2'].map(event);
		const backwards = [...forwards].reverse();
		expect(fold(INITIAL_WATERMARK, forwards, watermarkReducer)).toBe(
			fold(INITIAL_WATERMARK, backwards, watermarkReducer)
		);
		expect(fold(INITIAL_WATERMARK, forwards, watermarkReducer)).toBe('9007199254740993');
	});

	it('converges the same way whether folded whole or incrementally (AD-5)', () => {
		const all = ['1', '2', '3', '4', '5'].map(event);
		const whole = fold(INITIAL_WATERMARK, all, watermarkReducer);
		const prefix = fold(INITIAL_WATERMARK, all.slice(0, 2), watermarkReducer);
		const incremental = fold(prefix, all.slice(2), watermarkReducer);
		expect(incremental).toBe(whole);
	});

	it('is raised by EVERY event type — there is no switch to forget one in', () => {
		// The watermark answers "has anything happened at all", so an event
		// type it ignored would be an event that happened invisibly.
		const source = read('src', 'lib', 'core', 'projection', 'watermark.ts');
		expect(source).not.toMatch(/switch\s*\(|case '/);
		const mixed = [event('1'), event('2'), event('3')];
		expect(fold(INITIAL_WATERMARK, mixed, watermarkReducer)).toBe('3');
	});

	it('is pure — no clock, no `$lib`, relative `.ts` imports only (AD-2)', () => {
		const source = read('src', 'lib', 'core', 'projection', 'watermark.ts');
		expect(source).not.toMatch(/from '\$lib|from '[a-z@]/);
		expect(source).toContain("from './fold.ts'");
	});
});

// --- The server side --------------------------------------------------------

/** One `auction_events` row as Postgrest would shape it. */
function row(n: string): Record<string, unknown> {
	return {
		seq: n,
		occurred_at: '2026-09-01T00:00:00.000Z',
		schema_version: 1,
		core_version: 1,
		manager_id: 'm-1',
		team_id: 't-1',
		event_type: 'Marker',
		payload: {},
		device_class: null,
		dispatch_outcome: null,
		delivery_outcome: null
	};
}

/** A fake backing `auction_events` with `seqs`, serving both read shapes. */
function fakeClient(seqs: string[]): {
	client: SupabaseClient;
	calls: { ranges: number; limits: number };
} {
	const calls = { ranges: 0, limits: 0 };
	const query = {
		select: () => query,
		gt: () => query,
		order: () => query,
		async range(from: number, to: number) {
			calls.ranges += 1;
			return { data: seqs.slice(from, to + 1).map(row), error: null };
		},
		async limit(count: number) {
			calls.limits += 1;
			// `order('seq', { ascending: false })` then `limit(1)`.
			const descending = [...seqs].sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1));
			return { data: descending.slice(0, count).map(row), error: null };
		}
	};
	return { client: { from: () => query } as unknown as SupabaseClient, calls };
}

/** A fake whose reads always fail, Postgrest-shaped. */
function failingClient(): SupabaseClient {
	const query = {
		select: () => query,
		gt: () => query,
		order: () => query,
		async range() {
			return { data: null, error: { message: 'connection refused' } };
		},
		async limit() {
			return { data: null, error: { message: 'connection refused' } };
		}
	};
	return { from: () => query } as unknown as SupabaseClient;
}

describe('resolveLeagueRead — one read of the log, two folds', () => {
	it('returns the phase and the watermark from the same events array', async () => {
		const { client, calls } = fakeClient(['1', '2', '3']);
		const resolved = await resolveLeagueRead(client);
		expect(resolved.phase.name).toBe('Setup');
		expect(resolved.watermark).toBe('3');
		// Paginated reads only — no second query for the watermark. Two sources
		// for one number could disagree by whatever committed between them.
		expect(calls.limits).toBe(0);
	});

	it('resolves an empty log to `\'0\'` and Setup together', async () => {
		const { client } = fakeClient([]);
		const resolved = await resolveLeagueRead(client);
		expect(resolved.watermark).toBe('0');
		expect(resolved.phase.name).toBe('Setup');
	});

	it('rejects on a read failure — the throw the defaulted wrapper depends on', async () => {
		await expect(resolveLeagueRead(failingClient())).rejects.toThrow(/connection refused/);
	});
});

describe('resolveLeagueReadOrDefault — failing closed', () => {
	it('fails closed to Setup and `\'0\'`, never to a stale height', async () => {
		const resolved = await resolveLeagueReadOrDefault(failingClient());
		expect(resolved.phase.name).toBe('Setup');
		expect(resolved.watermark).toBe(INITIAL_WATERMARK);
		// The safe direction: '0' is LOWER than every real seq, so the first
		// successful liveness re-read raises it and reloads the page. A failed
		// read can never make a surface look fresher than it is.
		expect(higherSeq(resolved.watermark, '1')).toBe('1');
	});

	it('resolves normally when the read succeeds', async () => {
		const { client } = fakeClient(['1', '2']);
		const resolved = await resolveLeagueReadOrDefault(client);
		expect(resolved.watermark).toBe('2');
	});
});

describe('readWatermark — the liveness re-read, and not the fold', () => {
	it('answers `{ watermark, at }` from one descending row, never a full-log read', async () => {
		const { client, calls } = fakeClient(['1', '2', '3']);
		const reading = await readWatermark(client);
		expect(reading.watermark).toBe('3');
		expect(reading.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		// The whole point: one row, and `loadAppendedEvents`'s pagination is
		// never entered. Polling this every ten seconds per Manager must not
		// page through the entire log.
		expect(calls.limits).toBe(1);
		expect(calls.ranges).toBe(0);
	});

	it('reads an empty log as `\'0\'` rather than as a failure', async () => {
		const { client } = fakeClient([]);
		const reading = await readWatermark(client);
		expect(reading.watermark).toBe('0');
	});

	it('agrees with the fold on the same log — one source, two readers', async () => {
		const seqs = ['1', '2', '9007199254740993'];
		const { client } = fakeClient(seqs);
		const folded = await resolveLeagueRead(fakeClient(seqs).client);
		const polled = await readWatermark(client);
		expect(polled.watermark).toBe(folded.watermark);
	});

	it('throws on a read failure, which the endpoint turns into a 503', async () => {
		await expect(readWatermark(failingClient())).rejects.toThrow(/watermark read failed/);
	});
});

describe('serverInstant', () => {
	it('is an ISO-8601 UTC instant the core can parse', async () => {
		const { parseInstant } = await import('../src/lib/core/instant.ts');
		expect(parseInstant(serverInstant())).not.toBeNull();
	});
});

// --- The endpoint and the migration ----------------------------------------

describe('the liveness endpoint', () => {
	const source = read('src', 'routes', 'api', 'watermark', '+server.ts');
	const module = read('src', 'lib', 'server', 'watermark.ts');
	/**
	 * The same source with its prose stripped, for the assertions that must be
	 * about what the file DOES rather than about what it explains — this
	 * module's own docstring names `resolveLeagueRead` in order to say it is
	 * deliberately not called.
	 */
	const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

	it('is session-guarded and discloses no watermark to a caller without one', () => {
		expect(source).toContain("locals.session.kind !== 'registered'");
		// The two statuses live in `server/watermark.ts`: SvelteKit permits only
		// its own named exports from a `+server.ts`, which the build enforces.
		expect(module).toContain('WATERMARK_UNAUTHENTICATED_STATUS = 401');
		// The refusal body carries a sentence and no figure.
		expect(code).toMatch(/status: WATERMARK_UNAUTHENTICATED_STATUS/);
		// The refusal returns a `detail` sentence and no figure of any kind: the
		// guard returns before `readWatermark` is ever called, which is what
		// "no watermark disclosed" means mechanically rather than by wording.
		const guardIndex = code.indexOf('status: WATERMARK_UNAUTHENTICATED_STATUS');
		const firstRead = code.indexOf('await readWatermark(');
		expect(guardIndex).toBeGreaterThan(-1);
		expect(firstRead).toBeGreaterThan(guardIndex);
	});

	it('answers 503 on a read failure rather than throwing', () => {
		expect(module).toContain('WATERMARK_UNAVAILABLE_STATUS = 503');
		expect(code).toContain('status: WATERMARK_UNAVAILABLE_STATUS');
		expect(code).toMatch(/catch\s*\{/);
	});

	it('is never cached — a cached liveness check is a lie about reachability', () => {
		expect(code).toContain("'cache-control': 'no-store'");
	});

	it('uses the one-row read, never the full-log fold', () => {
		expect(code).toContain('readWatermark');
		expect(code).not.toMatch(/loadAppendedEvents|resolveLeagueRead/);
	});
});

/**
 * The two endpoint rows of the I/O matrix, driven through the handler itself.
 *
 * The assertions above are about what the file SAYS; these are about what it
 * DOES. A handler that kept the constant names and lost the guard would pass
 * every one of them and fail every one of these — which is the whole reason
 * both exist rather than only the cheaper kind.
 *
 * `GET` is a plain exported function over `{ locals }`, so it needs no adapter
 * and no server: the two refusal paths are reachable with nothing but a locals
 * object. `$env/dynamic/private` is already mocked empty at the top of this
 * file, so the `503` path is reached honestly — `serviceRoleClient()` cannot
 * be built without `SUPABASE_URL`, which is exactly the shape of the outage
 * this row describes.
 */
describe('the liveness endpoint, invoked', () => {
	/** Only the field the handler reads. */
	const localsWith = (kind: string) =>
		({ session: { kind } }) as unknown as Parameters<typeof GET>[0]['locals'];

	const invoke = async (kind: string): Promise<Response> =>
		(await GET({ locals: localsWith(kind) } as Parameters<typeof GET>[0])) as Response;

	it('answers 401 to a signed-out caller and discloses no figure', async () => {
		const response = await invoke('signed-out');
		expect(response.status).toBe(WATERMARK_UNAUTHENTICATED_STATUS);

		const body = (await response.json()) as Record<string, unknown>;
		// Not "no `watermark` key" — no figure of ANY kind. A `seq` disclosed
		// under another name would be the same disclosure.
		expect(body['watermark']).toBeUndefined();
		expect(JSON.stringify(body)).not.toMatch(/\d/);
	});

	it('refuses every session kind that is not `registered`', async () => {
		for (const kind of ['signed-out', 'unregistered', 'expired', 'discord-unavailable']) {
			const response = await invoke(kind);
			expect(response.status, `${kind} was not refused`).toBe(
				WATERMARK_UNAUTHENTICATED_STATUS
			);
		}
	});

	it('answers 503 when the watermark cannot be read, and throws nothing', async () => {
		// Registered, so the guard passes and the read is genuinely attempted.
		const response = await invoke('registered');
		expect(response.status).toBe(WATERMARK_UNAVAILABLE_STATUS);
		expect((await response.json())['watermark']).toBeUndefined();
	});

	it('never caches either refusal', async () => {
		for (const kind of ['signed-out', 'registered']) {
			const response = await invoke(kind);
			expect(response.headers.get('cache-control')).toBe('no-store');
		}
	});
});

describe('the migration', () => {
	const sql = read('supabase', 'migrations', '20260902000000_watermark.sql');
	/** The statements alone — this file explains its grants at length above them. */
	const statements = sql.replace(/^\s*--.*$/gm, '');

	it('creates a single-row table holding one integer', () => {
		expect(sql).toContain('create table if not exists public.auction_watermark');
		expect(sql).toContain('seq bigint not null default 0');
		// The singleton is enforced by the schema, not by convention.
		expect(sql).toContain('constraint auction_watermark_single_row check (id)');
	});

	it('maintains it from a trigger, so BOTH write runtimes are covered', () => {
		// `shell/write.ts` is not the only appender: the Deno tick inserts
		// through its own gateway, so anything maintained in the shell alone
		// would miss every close.
		expect(sql).toContain('after insert on public.auction_events');
		expect(sql).toContain('execute function public.raise_auction_watermark()');
		// Monotonic: it can never go backwards.
		expect(sql).toContain('where seq < new.seq');
	});

	it('seeds from the log as it stands, so an existing database is not reset', () => {
		expect(sql).toContain('coalesce((select max(seq) from public.auction_events), 0)');
		expect(sql).toContain('on conflict (id) do nothing');
	});

	it('grants `select` to `authenticated` only — never to `anon`, never a write', () => {
		expect(sql).toContain('grant select on table public.auction_watermark to authenticated');
		expect(sql).toContain('revoke all on table public.auction_watermark from anon');
		expect(statements).not.toMatch(/grant[^;]*(insert|update|delete)[^;]*auction_watermark/i);
		// And no client grant leaks onto the log or a projection table.
		expect(statements).not.toMatch(/grant[^;]*auction_events/i);
	});

	it('enables row-level security with exactly one select policy', () => {
		expect(sql).toContain('alter table public.auction_watermark enable row level security');
		expect(sql).toContain('create policy auction_watermark_select_authenticated');
		const policies = statements.match(/create policy/g) ?? [];
		expect(policies).toHaveLength(1);
		expect(sql).toMatch(/for select/);
	});

	it('joins the supabase_realtime publication, guarded against re-application', () => {
		expect(sql).toContain('alter publication supabase_realtime add table public.auction_watermark');
		expect(sql).toContain('pg_publication_tables');
	});

	it('sorts after every migration it depends on', () => {
		// Read the directory, never two literals. Comparing hardcoded strings
		// asserts something about this test file and nothing whatever about the
		// repository — it would pass with the migration deleted, renamed, or
		// dated before every other file in the tree.
		const names = readdirSync(join(ROOT, 'supabase', 'migrations'))
			.filter((name) => name.endsWith('.sql'))
			.sort();
		const mine = '20260902000000_watermark.sql';

		expect(names, 'the migration is missing from the tree').toContain(mine);

		// **This used to assert `mine` was the LAST file in the tree**, which
		// was a proxy for the real requirement and expired the moment any later
		// migration landed — Story 5.1's `20260903000000_notification_outbox.sql`
		// is the first. The requirement itself is a DEPENDENCY: this migration
		// creates a trigger on `public.auction_events` and seeds itself from
		// `max(seq)`, so the log's own migration and every migration that alters
		// it must be applied first. That is what is asserted now, and unlike
		// "is last" it stays true for every migration that ever follows.
		const before = names.slice(0, names.indexOf(mine));
		for (const dependency of [
			'20260821020000_auction_events.sql',
			'20260901000000_system_actor.sql'
		]) {
			expect(before, `${dependency} must be applied before ${mine}`).toContain(dependency);
		}
	});
});

describe('the local stack can actually serve a channel', () => {
	it('turns Realtime on', () => {
		const config = read('supabase', 'config.toml');
		expect(config).toMatch(/\[realtime\]\s*\nenabled = true/);
	});
});
