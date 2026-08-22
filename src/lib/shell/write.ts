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
 * `enqueue` is Epic 5.1's outbox dispatcher seam (AD-17) and is a documented
 * no-op today: nothing calls it with an implementation. It fires once, after
 * commit, with the events just appended — never before, and never at all on
 * a `Rejected` result.
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
 * Epic 5.1's outbox seam (AD-17). Called once, after commit, with the events
 * just appended, on acceptance only. A documented no-op until that story
 * gives it an implementation.
 */
export type EnqueueFn = (appended: readonly AppendedEvent[]) => Promise<void> | void;

/** What `runTransactionalWrite` answers. */
export type WriteOutcome =
	| { readonly kind: 'accepted'; readonly events: readonly AppendedEvent[] }
	| { readonly kind: 'rejected'; readonly reason?: unknown };

/**
 * Thrown when `enqueue` itself throws. This is deliberately never a
 * `ROLLBACK` signal — by the time `enqueue` runs, the transaction has already
 * `COMMIT`ed and the events are durably persisted, so attempting a rollback
 * against it would be a no-op at best and a misleading second error at worst.
 *
 * The caller must not lose the fact that the write was accepted just because
 * the outbox seam blew up afterwards: `outcome` carries the same `Accepted`
 * `WriteOutcome` — persisted events, assigned `seq`s and all — that would have
 * been returned had `enqueue` not thrown. A caller that only checks `catch`
 * can still recover it from `error.outcome`.
 */
export class EnqueueError extends Error {
	readonly outcome: Extract<WriteOutcome, { kind: 'accepted' }>;

	constructor(outcome: Extract<WriteOutcome, { kind: 'accepted' }>, cause: unknown) {
		super('enqueue failed after a successful commit; the write was already accepted and persisted', {
			cause
		});
		this.name = 'EnqueueError';
		this.outcome = outcome;
	}
}

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

const INSERT_EVENT_SQL = `
	insert into auction_events
		(occurred_at, schema_version, core_version, manager_id, team_id,
		 event_type, payload, device_class, dispatch_outcome, delivery_outcome)
	values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	returning seq, occurred_at, schema_version, core_version, manager_id, team_id,
		event_type, payload, device_class, dispatch_outcome, delivery_outcome
`;

/** Map one `auction_events` row, as `pg` (or a fake) shapes it, to `AppendedEvent`. */
function toAppendedEvent(row: QueryResultRow): AppendedEvent {
	const occurredAt = row['occurred_at'];
	return {
		seq: String(row['seq']),
		occurredAt: occurredAt instanceof Date ? occurredAt.toISOString() : String(occurredAt),
		schemaVersion: Number(row['schema_version']),
		coreVersion: Number(row['core_version']),
		type: String(row['event_type']),
		payload: row['payload'],
		managerId: String(row['manager_id']),
		teamId: String(row['team_id']),
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
	let outcome: Extract<WriteOutcome, { kind: 'accepted' }> | undefined;
	try {
		await client.query(BEGIN_SQL);

		// lock, before any state is read (AD-6).
		const lockResult = await client.query(LOCK_AND_CLOCK_SQL, [GLOBAL_WRITE_LOCK_KEY.toString()]);
		const now = lockResult.rows[0]?.['now'];
		if (!(now instanceof Date)) {
			throw new Error('the database clock read returned no usable "now" value');
		}

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

		await client.query(COMMIT_SQL);

		outcome = { kind: 'accepted', events: appended };
	} catch (error) {
		await client.query(ROLLBACK_SQL).catch(() => {
			/* the original error is what the caller needs to see */
		});
		throw error;
	} finally {
		client.release();
	}

	if (outcome === undefined) {
		// Unreachable: every path through the try block above that does not
		// assign `outcome` either returns directly (the rejected branch) or
		// throws (rethrown from the catch block above). This guard exists only
		// to give TypeScript the narrowing it cannot otherwise prove through a
		// try/catch/finally, and to fail loudly instead of silently if that
		// invariant is ever broken by a future edit.
		throw new Error('runTransactionalWrite: reached the end with no outcome computed');
	}

	// enqueue — after commit, accepted only, and deliberately outside the
	// try/catch above: the transaction is already committed by this point, so
	// a throwing `enqueue` must never attempt a rollback against it, and must
	// never cause the caller to lose the fact that the write was accepted
	// (see `EnqueueError`).
	if (input.enqueue !== undefined) {
		try {
			await input.enqueue(outcome.events);
		} catch (error) {
			throw new EnqueueError(outcome, error);
		}
	}

	return outcome;
}
