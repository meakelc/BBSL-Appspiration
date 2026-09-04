/**
 * The generic transactional write pipeline (AD-1, AD-3, AD-4, AD-5, AD-6).
 *
 * Order, exactly: lock -> load -> decide -> persist -> enqueue. Every step
 * after `decide` returns a `Rejected` result never runs — the transaction
 * rolls back, nothing is persisted, and `enqueue` is never called.
 *
 * `load` and `decide` are injected, not imported. Epic 2 owns `core/rules`
 * and no domain `decide()` exists yet, so this module has nothing to say
 * about what a command or an event means — only the shape of the pipeline
 * and the plumbing around it: the lock, the transaction boundary, the
 * columns every persisted event carries, and the seam a projection folds
 * through.
 *
 * Why a direct Postgres connection (`pg`), not `supabase-js`: this pipeline
 * needs `BEGIN ... pg_advisory_xact_lock ... COMMIT` held open across the
 * whole load/decide/persist sequence, and PostgREST is stateless per request
 * and cannot do that. `db.ts` is the real `ConnectionGateway`; this module
 * only depends on the port below, so a unit test substitutes a fake client
 * the way `ManagerRegistry`/`DiscordOAuthPort` already do.
 *
 * `enqueue` is AD-17's transactional-outbox seam, and since Story 5.1 it runs
 * INSIDE the transaction — after the projections, before `COMMIT`, on
 * acceptance only. That placement is the whole of the AD: "the transaction
 * that appends events also inserts delivery intents". An enqueue that fired
 * after commit would leave a window in which the events are durable and the
 * notices they owe are not, and a crash inside that window would lose a notice
 * with nothing left to re-derive it from. Now the intents commit with the
 * events or neither does, and a throwing `enqueue` rolls the whole write back
 * exactly as a throwing projection does.
 *
 * **This is not the delivery.** Nothing here opens a socket. `enqueue` is
 * given the same `client` a `ProjectionUpdater` is given and does one thing
 * with it — INSERT rows into `notification_outbox`. The HTTP post lives in
 * `server/outbox.ts`'s drain, which runs in the tick long after this
 * transaction committed and therefore can never fail or reverse an auction
 * action (AD-17).
 */

import { CORE_VERSION, EVENT_SCHEMA_VERSION, GLOBAL_WRITE_LOCK_KEY } from '../core/constants.ts';
import type { AppendedEvent, EventEnvelope } from '../core/types.ts';

// --- The injected ports -------------------------------------------------

/** One row as `query()` returns it — columns as `pg` (or a fake) shapes them. */
export type QueryResultRow = Record<string, unknown>;

/** The minimal client surface the pipeline needs from a live connection. */
export type TransactionalClient = {
	query(
		text: string,
		params?: readonly unknown[]
	): Promise<{ readonly rows: readonly QueryResultRow[] }>;
};

/**
 * A source of transactional clients — the seam a unit test substitutes with a
 * fake, the way `ManagerRegistry`/`DiscordOAuthPort` already do. `db.ts`'s
 * pooled `pg.Pool`, adapted, is the real implementation.
 */
export type ConnectionGateway = {
	connect(): Promise<TransactionalClient & { release(): void }>;
};

/** Load whatever state `decide` needs, using the locked transaction's client. */
export type LoadFn<TState> = (client: TransactionalClient) => Promise<TState>;

/**
 * What `decide` may answer. A rejection is a returned value, never a throw
 * (AD-1) — a thrown exception out of `load` or `decide` is treated as a bug:
 * the transaction rolls back and the exception propagates to the caller.
 */
export type Decision =
	| { readonly kind: 'accepted'; readonly events: readonly EventEnvelope[] }
	| { readonly kind: 'rejected'; readonly reason?: unknown };

/** Decide what to do, given the loaded state and the transaction-start clock. */
export type DecideFn<TState> = (input: {
	readonly state: TState;
	readonly now: Date;
}) => Decision | Promise<Decision>;

/**
 * Fold the events just appended into one registered projection, and persist
 * the result — through `client`, so the write stays inside the same
 * transaction as the events it folds (AD-5). Story 1.5 defines this seam and
 * registers nothing against it: no projection table exists yet. The story
 * that first reads a projection (1.6, for phase) is the first to pass one.
 */
export type ProjectionUpdater = (
	client: TransactionalClient,
	appended: readonly AppendedEvent[]
) => Promise<void>;

/**
 * AD-17's outbox seam: insert the delivery intents the events just appended
 * owe, THROUGH `client`, so they commit in the same transaction as the events
 * that produced them (Story 5.1). Called once, on acceptance only, after every
 * registered projection and before `COMMIT`.
 *
 * **Structurally identical to `ProjectionUpdater` above, and deliberately a
 * separate name.** Both write inside the transaction through the same client;
 * they differ in what they mean. A projection folds the events into state the
 * app READS back. The outbox records an obligation the app OWES the outside
 * world, and the dispatcher that discharges it is a different process at a
 * different time (`server/outbox.ts`). Collapsing the two into one list would
 * make the ordering guarantee — projections first, then intents — an accident
 * of array position rather than something stated.
 *
 * A throw here rolls the whole write back and persists nothing, which is the
 * correct direction: an event whose notice could not even be RECORDED is an
 * event the log should not carry, because nothing downstream could ever
 * re-derive the notice it owed. That is the opposite of a DELIVERY failure,
 * which happens in the tick and can never reach this transaction at all.
 */
export type EnqueueFn = (
	client: TransactionalClient,
	appended: readonly AppendedEvent[]
) => Promise<void> | void;

/** What `runTransactionalWrite` answers. */
export type WriteOutcome =
	| { readonly kind: 'accepted'; readonly events: readonly AppendedEvent[] }
	| { readonly kind: 'rejected'; readonly reason?: unknown };

// --- The pipeline ---------------------------------------------------------

const BEGIN_SQL = 'begin';
const COMMIT_SQL = 'commit';
const ROLLBACK_SQL = 'rollback';

/**
 * Take the global write lock and read the transaction-start clock, in one
 * round trip. `pg_advisory_xact_lock` must run before any state is read
 * (AD-6); `now()` is Postgres' transaction-start timestamp regardless of when
 * within the transaction it is called, so reading it here — before `load` —
 * satisfies both "at transaction start" and "before any state is read" with
 * a single statement.
 */
const LOCK_AND_CLOCK_SQL = 'select pg_advisory_xact_lock($1::bigint) as locked, now() as now';

/**
 * The database clock, validated — the one place a `now` column read off a
 * result row becomes a `Date` this codebase will act on.
 *
 * **The VALIDATION is shared; the QUERY deliberately is not.** This module
 * must read the clock in the SAME round trip as the lock
 * (`LOCK_AND_CLOCK_SQL`), because `pg_advisory_xact_lock` has to run before
 * any state is read (AD-6) and a second statement would be a second round
 * trip for a value one already returns. `server/auction-page.ts` takes no
 * lock at all and issues a bare `select now()`. Two different statements,
 * one identical question about what came back — so the statement stays with
 * each caller and only the check lives here. `server/` already depends on
 * `shell/`, so importing it there is the existing direction and not an
 * inversion.
 *
 * `instanceof Date` alone is NOT enough: `new Date('nonsense')` is a `Date`,
 * and calling `toISOString()` on one throws a bare `RangeError` instead of
 * the stated error below. A driver that hands back an unparseable timestamp
 * is the same class of failure as one that hands back nothing, and both must
 * arrive as this message rather than as a stack trace from a formatter.
 */
export function requireDatabaseClock(value: unknown): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new Error('the database clock read returned no usable "now" value');
	}
	return value;
}

const INSERT_EVENT_SQL = `
	insert into auction_events
		(occurred_at, schema_version, core_version, manager_id, team_id,
		 event_type, payload, device_class, dispatch_outcome, delivery_outcome)
	values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	returning seq, occurred_at, schema_version, core_version, manager_id, team_id,
		event_type, payload, device_class, dispatch_outcome, delivery_outcome
`;

/**
 * One actor column, read WITHOUT inventing a value for an absent one.
 *
 * `String(null)` is `"null"` — a four-character string that is truthy, that
 * every `!== null` check passes, and that would reach the Audit Log as an
 * actor named "null" rather than as the system. Since Story 3.7
 * `auction_events.manager_id`/`team_id` are nullable as a pair
 * (`20260901000000_system_actor.sql`), so `null` is a real value this mapping
 * has to carry through rather than a defensive branch.
 *
 * `undefined` maps to `null` as well, for `deviceClass`'s reason: a driver
 * that omits a column is saying the same thing as one that returns it null,
 * and the two must not read back differently.
 */
function actorId(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return String(value);
}

/**
 * Map one `auction_events` row, as `pg` (or a fake) shapes it, to
 * `AppendedEvent`.
 *
 * Exported so `server/event-log.ts`'s full-log reader reuses this exact
 * row-mapping discipline — via the Supabase/PostgREST client rather than
 * `pg` — instead of a second, potentially drifting copy. `QueryResultRow`'s
 * `Record<string, unknown>` shape covers a Postgrest row equally well: both
 * clients hand back the same snake_case columns.
 */
export function toAppendedEvent(row: QueryResultRow): AppendedEvent {
	const occurredAt = row['occurred_at'];
	return {
		seq: String(row['seq']),
		occurredAt: occurredAt instanceof Date ? occurredAt.toISOString() : String(occurredAt),
		schemaVersion: Number(row['schema_version']),
		coreVersion: Number(row['core_version']),
		type: String(row['event_type']),
		payload: row['payload'],
		// Null-preserving, never `String(...)`: a system-originated event has no
		// actor and `"null"` is not one (Story 3.7).
		managerId: actorId(row['manager_id']),
		teamId: actorId(row['team_id']),
		deviceClass: (row['device_class'] as string | null | undefined) ?? null,
		dispatchOutcome: (row['dispatch_outcome'] as string | null | undefined) ?? null,
		deliveryOutcome: (row['delivery_outcome'] as string | null | undefined) ?? null
	};
}

/**
 * Run one command through the pipeline: lock -> load -> decide -> persist ->
 * enqueue.
 *
 * `now` is read from the database clock exactly once (AD-3) and reused for
 * every appended event's `occurredAt` — this function itself never
 * constructs a `Date` or calls `Date.now()`.
 */
export async function runTransactionalWrite<TState>(input: {
	readonly gateway: ConnectionGateway;
	readonly load: LoadFn<TState>;
	readonly decide: DecideFn<TState>;
	readonly projections?: readonly ProjectionUpdater[];
	readonly enqueue?: EnqueueFn;
}): Promise<WriteOutcome> {
	const client = await input.gateway.connect();
	try {
		await client.query(BEGIN_SQL);

		// lock, before any state is read (AD-6).
		const lockResult = await client.query(LOCK_AND_CLOCK_SQL, [GLOBAL_WRITE_LOCK_KEY.toString()]);
		const now = requireDatabaseClock(lockResult.rows[0]?.['now']);

		// load
		const state = await input.load(client);

		// decide
		const decision = await input.decide({ state, now });

		if (decision.kind === 'rejected') {
			// Defensively wrapped, same as the catch block's rollback below: a
			// throw here must never break the "rejection is a return value, never
			// a throw" contract by escaping to the outer catch and triggering a
			// second, misleading rollback attempt.
			await client.query(ROLLBACK_SQL).catch(() => {
				/* the rejection is what the caller needs to see */
			});
			return { kind: 'rejected', reason: decision.reason };
		}

		// persist
		const appended: AppendedEvent[] = [];
		for (const event of decision.events) {
			const result = await client.query(INSERT_EVENT_SQL, [
				now,
				EVENT_SCHEMA_VERSION,
				CORE_VERSION,
				event.managerId,
				event.teamId,
				event.type,
				JSON.stringify(event.payload ?? null),
				event.deviceClass ?? null,
				event.dispatchOutcome ?? null,
				event.deliveryOutcome ?? null
			]);
			const row = result.rows[0];
			if (row === undefined) {
				throw new Error('auction_events insert returned no row');
			}
			appended.push(toAppendedEvent(row));
		}

		// registered projections, folded in the same transaction (AD-5).
		for (const updateProjection of input.projections ?? []) {
			await updateProjection(client, appended);
		}

		// enqueue — INSIDE the transaction, after the projections and before
		// `COMMIT` (AD-17, Story 5.1). The delivery intents this inserts commit
		// with the events that owe them or roll back with them; there is no
		// window in which the log carries an event whose notice was never
		// recorded. Nothing here talks to Discord: the HTTP post is the tick's
		// drain, which cannot reach this transaction.
		if (input.enqueue !== undefined) {
			await input.enqueue(client, appended);
		}

		await client.query(COMMIT_SQL);

		// Returned from inside the `try`, so the `finally` below still releases
		// the client. Nothing runs after the commit any more — `enqueue` used to,
		// and moving it above the commit is what let this become a plain return
		// instead of an outcome variable plus an unreachable narrowing guard.
		return { kind: 'accepted', events: appended };
	} catch (error) {
		await client.query(ROLLBACK_SQL).catch(() => {
			/* the original error is what the caller needs to see */
		});
		throw error;
	} finally {
		client.release();
	}
}
