/**
 * The transactional outbox and its dispatcher: insert the delivery intents an
 * appended event owes, and drain them once per tick. Story 5.1, AD-17, AD-18.
 *
 * **Two halves that never touch each other's failure modes**, which is the
 * whole of AD-17:
 *
 *  - `enqueueIntents` runs INSIDE the auction transaction, through the same
 *    `client` the events were appended with (`shell/write.ts`'s `EnqueueFn`).
 *    It writes rows and nothing else — no socket, no `fetch`, no retry. It can
 *    fail a write, and only by failing to record an obligation.
 *  - `drainOutbox` runs in the tick, after the sweep, in its own connection and
 *    its own transactions. It is the only thing here that talks to Discord, and
 *    a Discord outage costs a notification and never a bid — the closes it runs
 *    after are already committed and it holds nothing of theirs open.
 *
 * **Delivery state is not stored.** `notification_outbox` grants no role
 * `update` or `delete` (`20260903000000_notification_outbox.sql`), so a row
 * cannot be marked done. Whether an intent has been delivered is re-derived
 * from `NotificationDispatched` events in the log, which is the same
 * "re-derives, never remembers" discipline `server/sweep.ts` states for the
 * sweep — and it makes restart-safety structural rather than tested for. A pass
 * that dies between the POST and the outcome write simply re-derives the intent
 * as pending and tries again.
 *
 * **The outcome event is where NFR §5's measurement lands.** `auction_events`
 * carries `dispatch_outcome` and `delivery_outcome` as nullable columns that no
 * story populated until this one, and `service_role` holds `select, insert`
 * there and nothing more — so those columns can never be back-filled onto the
 * event that CAUSED the notice. They are populated on the dispatcher's own
 * appended event instead, which is the only place an insert-only log can put
 * them.
 *
 * **No feedback loop, and it is structural rather than conditional.** The
 * outcome events are appended through `runTransactionalWrite` with NO `enqueue`
 * argument, so a `NotificationDispatched` cannot spawn an intent for itself.
 * Belt as well as braces, it is also a system-originated event with a null
 * actor pair (`20260901000000_system_actor.sql`), and `enqueueIntents` skips
 * every event whose `team_id` is null — so even a future caller that wired
 * `enqueue` in here would still produce nothing.
 *
 * **The backoff and the budget live HERE, not in `core/`.** They are policy
 * about an external service's rate limit, not a rule of the auction — nothing
 * about who wins an Auction changes if the budget moves from five to six. AR-3
 * puts that in the shell, and `core/` stays free of any notion that Discord
 * exists.
 *
 * **One module, two runtimes** (AD-2). Relative `.ts` imports only, no `$env`,
 * no `$lib`, no Node builtin, no bare specifier — Deno loads this file through
 * `supabase/functions/tick/index.ts`, exactly as it loads `server/sweep.ts` and
 * `server/phase-end.ts`. The webhook URL and `fetch` are INJECTED by the caller
 * for that reason, and because the URL is a server-only secret that must never
 * take a `PUBLIC_` prefix (AD-16). `npx deno check --config
 * supabase/functions/tick/deno.json supabase/functions/tick/index.ts` is what
 * proves it, and `--config` is load-bearing.
 *
 * Not this story: no message composition, no event-type-to-copy mapping and no
 * mention text beyond the generic sentence below (5.2, 5.3); no mute or
 * settings logic (5.4); no Commissioner-visible failure screen (deferred,
 * 2026-09-03 — see `deferred-work.md`); no backlog detector (8.2).
 */

import type { AppendedEvent } from '../core/types.ts';
import { requireDatabaseClock, runTransactionalWrite } from '../shell/write.ts';
import type {
	ConnectionGateway,
	EnqueueFn,
	QueryResultRow,
	TransactionalClient
} from '../shell/write.ts';

// --- Names and policy -----------------------------------------------------

/** The outbox table (`20260903000000_notification_outbox.sql`). */
export const NOTIFICATION_OUTBOX_TABLE = 'notification_outbox';

/**
 * The one transport there is (AD-18 — "Discord is the only notification
 * transport"). A constant rather than a literal at three call sites, because
 * the column is deliberately not enum-constrained and the second transport
 * AD-17 anticipates is a new value here plus a new port, not a migration.
 */
export const DISCORD_CHANNEL = 'discord';

/**
 * The dispatcher's own event type. Not declared in `core/types.ts` and not
 * folded by any reducer: it is a record OF an effect, not an auction fact, and
 * nothing in the domain reads it. The dispatcher itself is its only reader, and
 * it reads it to answer one question — has this intent been delivered?
 */
export const NOTIFICATION_DISPATCHED_EVENT = 'NotificationDispatched';

/** `dispatch_outcome` on the outcome event: the request was actually issued. */
export const DISPATCH_ATTEMPTED = 'attempted';

/** `delivery_outcome` on the outcome event. Only `delivered` retires an intent. */
export const DELIVERY_DELIVERED = 'delivered';
export const DELIVERY_RATE_LIMITED = 'rate_limited';
export const DELIVERY_FAILED = 'failed';

/**
 * How many INTENTS one pass may attempt. Not a request count — see below.
 *
 * **What the code actually does.** Every due intent on one channel is collapsed
 * into a SINGLE `post` call (AD-18 — "the dispatcher batches multiple events
 * into one message where it can"). With `discord` the only registered channel,
 * a pass therefore issues at most ONE request, whether it carries one intent or
 * five. The tick runs every 10 seconds, so the real worst case is six requests
 * a minute against AD-18's documented 30/minute webhook ceiling — a fifth of
 * it, and that margin is what the design rests on.
 *
 * The cap is on intents rather than requests because what it actually bounds is
 * message SIZE and blast radius: a sweep that closed twenty Auctions at once
 * would otherwise put twenty notices in one Discord message, and one rejected
 * message would then be twenty notices to redeliver. Five keeps a burst
 * draining in readable chunks, and the remainder is provably carried to the
 * next pass.
 *
 * **The arithmetic that is NOT the safety argument.** Five intents on five
 * distinct channels would be five requests, or 30 a minute — which EQUALS the
 * ceiling rather than staying under it. That case is unreachable today (one
 * channel exists) and the number would have to be revisited before a second
 * transport is registered, not after.
 *
 * Flagged for revisit at the Epic 8 rehearsal, which is when burst behaviour
 * first becomes observable (ARCHITECTURE-SPINE.md's own "Discord delivery
 * shape" open question).
 */
export const PER_PASS_BUDGET = 5;

/**
 * How long to wait after the Nth consecutive failed attempt, in milliseconds.
 *
 * Ten seconds is one tick, so a single blip retries on the very next pass; the
 * tail reaches an hour so a webhook that has been dead for a day is not being
 * hammered every ten seconds by a backlog. The last entry is reused for every
 * attempt beyond the list — the intent is never dropped (AD-17), it just stops
 * accelerating.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [
	10_000,
	30_000,
	120_000,
	600_000,
	3_600_000
];

/** The wait owed after `failures` consecutive failed attempts. */
export function backoffMsFor(failures: number): number {
	if (failures <= 0) return 0;
	const last = RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 0;
	return RETRY_BACKOFF_MS[failures - 1] ?? last;
}

// --- The intent side ------------------------------------------------------

/** One row of `notification_outbox`, joined to the event it describes. */
export type OutboxIntent = {
	/** `auction_events.seq`, as a string — `int8` (AD-8's boundary discipline). */
	readonly eventSeq: string;
	readonly channel: string;
	readonly recipient: string;
	/** The `event_type` of the event this notice is about. */
	readonly eventType: string;
};

/** Every Manager of one Team, in a total order. */
const MANAGERS_OF_TEAM_SQL = `
	select discord_user_id
	from managers
	where team_id = $1
	order by discord_user_id asc
`;

/**
 * One intent. `on conflict do nothing` names AD-17's idempotency key at the
 * write site as well as in the schema.
 *
 * The conflict is unreachable today — `event_seq` comes off an `identity`
 * column that was assigned moments earlier in this same transaction, and
 * `managers.discord_user_id` is unique — so this clause changes no behaviour.
 * It is here because of what it must NEVER do: a duplicate intent is the same
 * intent, and raising a unique violation for it would roll back the auction
 * transaction and cost a Manager their Bid over a notice that was already
 * recorded. "A Discord outage costs a notification and never a bid" has to hold
 * for the outbox's own bookkeeping too.
 */
const INSERT_INTENT_SQL = `
	insert into ${NOTIFICATION_OUTBOX_TABLE} (event_seq, channel, recipient, created_at)
	values ($1::bigint, $2, $3, $4::timestamptz)
	on conflict (event_seq, channel, recipient) do nothing
`;

/**
 * AD-17's intent insert, as `shell/write.ts`'s `EnqueueFn`: one row per
 * appended event carrying a non-null `team_id`, per Manager of that Team.
 *
 * **`team_id` is the whole of the targeting rule, and its null case is not a
 * defensive branch.** Since Story 3.7 the actor pair may be null together, and
 * that means the SYSTEM acted — the tick read a clock and the log says the
 * phase ended. Nobody's Team is affected by a system event in the sense a
 * mention needs, so a null `team_id` yields no intent. `ContractAssignmentOpened`
 * is the live example; the dispatcher's own `NotificationDispatched` is the
 * second, which is why the no-feedback-loop property holds even here.
 *
 * **A co-managed Team yields TWO rows for ONE event, and that is the point of
 * the key.** FR-27 requires both Managers of a co-managed Team receive every
 * team-affecting notice (SM-3 targets 100%), and AD-17 keys on
 * `(event seq, channel, recipient)` precisely so the second Manager is not
 * deduplicated away by a key that stopped at the event.
 *
 * `created_at` is copied from the event's own `occurredAt` — the transaction's
 * single clock read (AD-3), never a second `now()`.
 *
 * **Registered by no domain write yet.** Story 5.1 builds the mechanism; the
 * story that decides WHICH events are worth a notice, and what one says, is the
 * story that passes this as `enqueue` (5.2/5.3). Wiring it here would post a
 * generic sentence for every appended event in the league.
 */
export const enqueueIntents: EnqueueFn = async (
	client: TransactionalClient,
	appended: readonly AppendedEvent[]
): Promise<void> => {
	// One lookup per distinct Team rather than one per event: a transaction
	// appending three events for one Team asks once.
	const recipientsByTeam = new Map<string, readonly string[]>();
	for (const event of appended) {
		if (event.teamId === null || recipientsByTeam.has(event.teamId)) continue;
		const result = await client.query(MANAGERS_OF_TEAM_SQL, [event.teamId]);
		recipientsByTeam.set(
			event.teamId,
			result.rows
				.map((row) => String(row['discord_user_id'] ?? '').trim())
				.filter((id) => id !== '')
		);
	}

	for (const event of appended) {
		if (event.teamId === null) continue;
		for (const recipient of recipientsByTeam.get(event.teamId) ?? []) {
			await client.query(INSERT_INTENT_SQL, [
				event.seq,
				DISCORD_CHANNEL,
				recipient,
				event.occurredAt
			]);
		}
	}
};

// --- The pending set, re-derived -----------------------------------------

/** One recorded attempt, read back off a `NotificationDispatched` event. */
export type DispatchAttempt = {
	readonly eventSeq: string;
	readonly channel: string;
	readonly recipient: string;
	/** `true` only for `delivery_outcome = 'delivered'`. Retires the intent. */
	readonly delivered: boolean;
	/** The attempt's `occurred_at` — the appending transaction's clock (AD-3). */
	readonly attemptedAt: string;
	/** What a 429 asked for, in milliseconds, or `null`. */
	readonly retryAfterMs: number | null;
};

/**
 * The key AD-17 names: `(event seq, channel, recipient)`, as one string.
 *
 * `JSON.stringify` of the triple rather than a joined string, because the join
 * has to be INJECTIVE: two different intents must never produce one key, or the
 * derivation would retire the wrong one. Any single-character separator can
 * appear inside a `text` column, so `1|discord|a` and `1|discord|a` could be
 * reached from two different triples — JSON quoting and escaping rule that out
 * without needing an assumption about what a recipient may contain.
 *
 * An earlier draft used a literal NUL, which IS injective (Postgres `text`
 * cannot store one) but made this file binary to git and ripgrep: `git diff`
 * would not render it and a search would silently skip it. A key nobody can
 * read in review is not worth the two bytes it saves.
 */
function keyOf(intent: {
	readonly eventSeq: string;
	readonly channel: string;
	readonly recipient: string;
}): string {
	return JSON.stringify([intent.eventSeq, intent.channel, intent.recipient]);
}

/**
 * Which intents are due for an attempt right now, in a total order, capped.
 *
 * Pure: given the intents, the attempts and the database clock, the answer is
 * fixed. That is what makes every I/O-matrix row about retry behaviour testable
 * without a transport at all.
 *
 * An intent is pending unless a `delivered` attempt exists for its key. Since a
 * successful attempt is an appended event, the "retry of the same tick" case is
 * answered structurally: re-running the pass finds the two successes in the log
 * and dispatches nothing further.
 *
 * The wait after N failures is `max(backoff(N), the last 429's retryAfterMs)`.
 * Both, not either: Discord's number is a floor it asked for, and the backoff is
 * this application's own restraint. Taking the larger honours the 429 without
 * letting a `retry_after: 0` collapse the backoff.
 */
export function duePendingIntents(input: {
	readonly intents: readonly OutboxIntent[];
	readonly attempts: readonly DispatchAttempt[];
	readonly now: Date;
	readonly budget?: number;
}): readonly OutboxIntent[] {
	const attemptsByKey = new Map<string, DispatchAttempt[]>();
	for (const attempt of input.attempts) {
		const key = keyOf(attempt);
		const bucket = attemptsByKey.get(key);
		if (bucket === undefined) attemptsByKey.set(key, [attempt]);
		else bucket.push(attempt);
	}

	const nowMs = input.now.getTime();
	const due: OutboxIntent[] = [];

	for (const intent of input.intents) {
		const attempts = attemptsByKey.get(keyOf(intent)) ?? [];
		if (attempts.some((attempt) => attempt.delivered)) continue;
		if (attempts.length === 0) {
			due.push(intent);
			continue;
		}

		// The most recent attempt decides when the next one may run. Compared by
		// instant rather than by array position: the reader orders by `seq`, but
		// nothing in this function should depend on that holding.
		let lastMs = Number.NEGATIVE_INFINITY;
		let lastRetryAfterMs = 0;
		for (const attempt of attempts) {
			const at = Date.parse(attempt.attemptedAt);
			if (!Number.isFinite(at) || at < lastMs) continue;
			lastMs = at;
			lastRetryAfterMs = attempt.retryAfterMs ?? 0;
		}
		if (!Number.isFinite(lastMs)) {
			// Every recorded attempt carried an unreadable instant. Treating that
			// as "due now" is the safe direction: AD-17's promise is that an
			// intent is never dropped, and an unreadable timestamp must not
			// become an unbounded silence.
			due.push(intent);
			continue;
		}

		const wait = Math.max(backoffMsFor(attempts.length), lastRetryAfterMs);
		if (nowMs >= lastMs + wait) due.push(intent);
	}

	// Oldest event first, then a total tie-break — AD-1 forbids incidental
	// order, and two intents for one event differ only by recipient. `BigInt`
	// rather than `Number`, because `seq` is `int8` (`core/types.ts`).
	due.sort((a, b) => {
		if (a.eventSeq !== b.eventSeq) return BigInt(a.eventSeq) < BigInt(b.eventSeq) ? -1 : 1;
		if (a.channel !== b.channel) return a.channel < b.channel ? -1 : 1;
		if (a.recipient === b.recipient) return 0;
		return a.recipient < b.recipient ? -1 : 1;
	});

	// `Math.max(0, ...)`: `slice(0, -2)` returns everything BUT the last two,
	// so a negative budget would silently dispatch almost the whole backlog
	// rather than nothing at all.
	return due.slice(0, Math.max(0, input.budget ?? PER_PASS_BUDGET));
}

// --- The transport port ---------------------------------------------------

/** What one batched post amounted to. `adapters/discord`'s result, generalised. */
export type ChannelPostResult =
	| { readonly kind: 'delivered' }
	| {
			readonly kind: 'rate_limited';
			readonly retryAfterMs: number;
			readonly detail: string;
	  }
	| { readonly kind: 'failed'; readonly detail: string };

/**
 * A transport, as the dispatcher needs it — declared HERE rather than imported
 * from `adapters/discord/webhook.ts`, so this module carries no notion of
 * Discord at all and a second channel (AD-17 names web push) is a second entry
 * in `channels` rather than an edit to this file.
 *
 * `server/auth.ts`'s `DiscordOAuthPort` is the same pattern: the consumer
 * declares what it needs and the adapter satisfies it structurally.
 * `DiscordWebhookPort` is assignable to this, and
 * `tests/adapters/discord-webhook.test.ts` asserts that assignment so the two
 * declarations cannot drift apart unnoticed.
 */
export type NotificationChannelPort = {
	post(message: {
		readonly body: string;
		readonly recipients: readonly string[];
	}): Promise<ChannelPostResult>;
};

/** Everything `drainOutbox` needs from the runtime around it. */
export type OutboxPorts = {
	/** One port per `notification_outbox.channel` value. */
	readonly channels: Readonly<Record<string, NotificationChannelPort>>;
	/** Override `PER_PASS_BUDGET`. Tests use it; the tick does not. */
	readonly budget?: number;
};

/** What one drain pass did. Returned for tests and for the tick's log line. */
export type DrainSummary = {
	/** Intents this pass attempted — never more than the budget. */
	readonly attempted: number;
	readonly delivered: number;
	readonly rateLimited: number;
	readonly failed: number;
	/** One sentence per batch that did not deliver. Empty on a clean pass. */
	readonly failures: readonly string[];
};

// --- The drain ------------------------------------------------------------

/** The clock, unlocked and on its own — `server/sweep.ts`'s statement. */
const CLOCK_SQL = 'select now() as now';

/**
 * Every intent, joined to the type of the event it describes.
 *
 * The whole table, unpaginated, for the reason `server/event-log.ts`'s
 * `loadEventsViaClient` reads the whole log: this is a 30-team private league,
 * and the pending derivation has to see every row to be able to say an intent
 * is NOT pending. A bounded read here would be a cursor by another name, and a
 * cursor is the thing "re-derives, never remembers" exists to avoid.
 */
const PENDING_INTENTS_SQL = `
	select o.event_seq, o.channel, o.recipient, e.event_type
	from ${NOTIFICATION_OUTBOX_TABLE} o
	join auction_events e on e.seq = o.event_seq
	order by o.event_seq asc, o.channel asc, o.recipient asc
`;

/**
 * Every recorded dispatch attempt. Filtered by `event_type` in SQL rather than
 * in TypeScript, because this is the one read that grows with the number of
 * NOTICES rather than with the number of auction events.
 */
const DISPATCH_ATTEMPTS_SQL = `
	select occurred_at, payload, delivery_outcome
	from auction_events
	where event_type = $1
	order by seq asc
`;

/**
 * Drain the outbox: derive what is pending, attempt at most the budget's worth,
 * and append one `NotificationDispatched` per attempt.
 *
 * **Ordered after the sweep, inside the same tick** (AD-10, AD-17). It opens
 * its own connection and takes no auction lock until the outcome write, so the
 * closes it runs after are committed and untouchable by anything here.
 *
 * **Batched by channel** (AD-18 — "the dispatcher batches multiple events into
 * one message where it can and backs off on 429 — a sweep closing many auctions
 * at once is the case that hits it"). Today that means every due intent becomes
 * ONE Discord request, so a pass costs one request rather than five.
 *
 * **Throws only after everything is recorded, and only for a real failure.** A
 * batch that failed has already been written to the log as a failed attempt by
 * the time this throws, so the backoff is already in effect and the intents are
 * still pending; the throw exists so `server/sweep.ts` records `drainFailure` on
 * the heartbeat and an operator can see it. A 429 does NOT throw: it is the
 * documented, expected behaviour of a rate-limited webhook under a burst, and a
 * heartbeat reading `completed_with_failures` for every pass of a rate-limit
 * window would be noise rather than signal.
 */
export async function drainOutbox(
	gateway: ConnectionGateway,
	ports: OutboxPorts
): Promise<DrainSummary> {
	const due = await readDueIntents(gateway, ports.budget);
	if (due.length === 0) {
		return { attempted: 0, delivered: 0, rateLimited: 0, failed: 0, failures: [] };
	}

	// Batch by channel, preserving `duePendingIntents`' total order within each.
	const batches = new Map<string, OutboxIntent[]>();
	for (const intent of due) {
		const batch = batches.get(intent.channel);
		if (batch === undefined) batches.set(intent.channel, [intent]);
		else batch.push(intent);
	}

	const outcomes: OutcomeFor[] = [];
	const failures: string[] = [];
	let delivered = 0;
	let rateLimited = 0;
	let failed = 0;

	for (const [channel, batch] of [...batches.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const result = await postBatch(ports.channels[channel], channel, batch);
		for (const intent of batch) outcomes.push({ intent, result });

		if (result.kind === 'delivered') {
			delivered += batch.length;
		} else if (result.kind === 'rate_limited') {
			rateLimited += batch.length;
		} else {
			failed += batch.length;
			failures.push(`${channel}: ${result.detail}`);
		}
	}

	// **Recorded before anything is reported.** The outcome write is what makes
	// the next pass's derivation correct, so it happens whatever the results
	// were — including for the batch that is about to make this function throw.
	await appendOutcomes(gateway, outcomes);

	if (failures.length > 0) {
		throw new Error(
			`the outbox drain could not deliver ${failed} of ${due.length} pending notice(s); ` +
				`every attempt is recorded and will be retried: ${failures.join('; ')}`
		);
	}

	return { attempted: due.length, delivered, rateLimited, failed, failures };
}

/** One intent and the result of the batch it travelled in. */
type OutcomeFor = { readonly intent: OutboxIntent; readonly result: ChannelPostResult };

/** The read transaction's boundary statements. `shell/write.ts`'s, restated. */
const BEGIN_SQL = 'begin';
const COMMIT_SQL = 'commit';
const ROLLBACK_SQL = 'rollback';

/**
 * The clock, the intents and the attempts, off ONE connection and inside ONE
 * transaction — then the pure derivation.
 *
 * **The transaction is what makes the three reads agree.** Three autocommit
 * statements get three snapshots, and a close committing between the second and
 * the third would let this pass see an intent whose delivery it cannot see, or
 * a clock from before an intent it can. Wrapped, all three read the same
 * instant of the database, which is what `server/close.ts`'s "fold everything
 * out of ONE read" discipline means when the reads are separate statements
 * rather than one.
 *
 * **No lock, deliberately** — `server/sweep.ts`'s reasoning, unchanged. This
 * read only decides which intents to OFFER; the outcome writes take
 * `GLOBAL_WRITE_LOCK_KEY` for themselves, and an intent that was delivered
 * between this read and its own outcome write is re-derived as settled on the
 * next pass rather than dispatched twice by this one.
 */
async function readDueIntents(
	gateway: ConnectionGateway,
	budget: number | undefined
): Promise<readonly OutboxIntent[]> {
	const client = await gateway.connect();
	try {
		await client.query(BEGIN_SQL);
		try {
			const clock = await client.query(CLOCK_SQL);
			const now = requireDatabaseClock(clock.rows[0]?.['now']);

			const intents = (await client.query(PENDING_INTENTS_SQL)).rows.map(toOutboxIntent);
			const attempts = (
				await client.query(DISPATCH_ATTEMPTS_SQL, [NOTIFICATION_DISPATCHED_EVENT])
			).rows.map(toDispatchAttempt);

			await client.query(COMMIT_SQL);
			return duePendingIntents({ intents, attempts, now, budget });
		} catch (error) {
			// Defensively wrapped, `shell/write.ts`'s pattern: the original read
			// failure is what the caller needs to see, never a second error from
			// the rollback attempting to describe it.
			await client.query(ROLLBACK_SQL).catch(() => {
				/* the read failure is what the caller needs to see */
			});
			throw error;
		}
	} finally {
		// Guarded exactly as `runTick`'s is: returning a connection to a pool is
		// never news worth losing a completed read over.
		try {
			client.release();
		} catch (error) {
			console.error('drainOutbox: releasing the read connection failed', error);
		}
	}
}

/** One `notification_outbox` row, joined to its event's type. */
function toOutboxIntent(row: QueryResultRow): OutboxIntent {
	return {
		// `int8` arrives as a string through `pg` and as a `BigInt` through
		// deno-postgres; `String` is what makes both read the same (AD-8).
		eventSeq: String(row['event_seq']),
		channel: String(row['channel']),
		recipient: String(row['recipient']),
		eventType: String(row['event_type'])
	};
}

/** One `NotificationDispatched` row, read back as an attempt. */
function toDispatchAttempt(row: QueryResultRow): DispatchAttempt {
	const payload = readPayload(row['payload']);
	const occurredAt = row['occurred_at'];
	const retryAfter = payload['retryAfterMs'];
	return {
		eventSeq: String(payload['eventSeq'] ?? ''),
		channel: String(payload['channel'] ?? ''),
		recipient: String(payload['recipient'] ?? ''),
		delivered: row['delivery_outcome'] === DELIVERY_DELIVERED,
		attemptedAt:
			occurredAt instanceof Date ? occurredAt.toISOString() : String(occurredAt ?? ''),
		retryAfterMs: typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? retryAfter : null
	};
}

/**
 * A `jsonb` payload as an object, whichever way the driver handed it over.
 *
 * `pg` parses `jsonb` into a JS value; a fake or another driver may hand back
 * the text. Anything unreadable becomes an empty object rather than a throw —
 * an unparseable outcome event must not stop the whole drain, and an attempt
 * whose key cannot be read simply matches no intent, which leaves that intent
 * pending. Never dropped (AD-17).
 */
function readPayload(value: unknown): Record<string, unknown> {
	if (typeof value === 'string') {
		try {
			const parsed: unknown = JSON.parse(value);
			return typeof parsed === 'object' && parsed !== null
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Post one channel's batch, turning a missing port and a thrown transport into
 * the same `failed` result a 5xx produces.
 *
 * A channel with no port is a configuration error, and it is recorded as a
 * failed attempt rather than raised: the intents stay pending, back off, and are
 * delivered the moment the port is wired — which is what AD-17's "never dropped"
 * requires of a notice nobody has a transport for yet.
 */
async function postBatch(
	port: NotificationChannelPort | undefined,
	channel: string,
	batch: readonly OutboxIntent[]
): Promise<ChannelPostResult> {
	if (port === undefined) {
		return { kind: 'failed', detail: `no port is registered for the "${channel}" channel` };
	}
	try {
		return await port.post({
			body: genericBodyFor(batch),
			recipients: [...new Set(batch.map((intent) => intent.recipient))]
		});
	} catch (error) {
		return {
			kind: 'failed',
			detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
		};
	}
}

/**
 * The GENERIC payload this story ships, and deliberately nothing more.
 *
 * It names the event types and their `seq`s and says nothing about what any of
 * them MEANS — there is no event-type-to-copy mapping here, no amount, no
 * Player name and no Team. Story 5.2 and 5.3 own what a notice says; this
 * sentence exists so the mechanism can be exercised end to end before they land,
 * and it is the first thing those stories replace.
 *
 * De-duplicated by `seq`: a co-managed Team contributes two intents for one
 * event, and the message should name that event once.
 */
export function genericBodyFor(batch: readonly OutboxIntent[]): string {
	const seen = new Set<string>();
	const notices: string[] = [];
	for (const intent of batch) {
		if (seen.has(intent.eventSeq)) continue;
		seen.add(intent.eventSeq);
		notices.push(`${intent.eventType} (event #${intent.eventSeq})`);
	}
	return `BBSL auction update — ${notices.join(', ')}.`;
}

/**
 * Append one `NotificationDispatched` per attempted intent — **one transaction
 * each, in order.**
 *
 * **Not one transaction for the whole pass, and that is the blast radius.** A
 * single transaction covering five outcomes fails as a unit: if Discord had
 * already accepted the batch and the outcome write then threw, the log would
 * record none of the five as delivered and the next pass would redeliver all
 * five. Per intent, a failure loses at most the ONE outcome it was writing —
 * every outcome recorded before it stands, and only its own intent redelivers.
 * That is the standard floor for a non-idempotent HTTP sink, and it is exactly
 * `server/sweep.ts`'s one-transaction-per-close discipline (AD-11) applied to
 * the other side of the tick.
 *
 * A throw propagates: the caller is `drainOutbox`, whose failure becomes
 * `drainFailure` on the heartbeat, and the outcomes already committed are not
 * rolled back with it.
 *
 * **`runTransactionalWrite` with NO `enqueue`, and that omission is the whole
 * no-feedback-loop property.** An outcome event that enqueued its own intent
 * would notify a Manager that they had been notified, forever. It is structural
 * here rather than a filter somewhere downstream, so no future edit can
 * reintroduce it by forgetting a condition.
 *
 * The actor pair is null: nobody acted (`20260901000000_system_actor.sql`). The
 * dispatcher read a table and posted a message; attributing that to the
 * Commissioner or to the notified Manager would put a person in the Audit Log
 * who did nothing.
 *
 * `dispatchOutcome`/`deliveryOutcome` are NFR §5's measurement columns,
 * populated here for the first time in the product's history — and only ever
 * here, because `auction_events` grants no `update` and the event that CAUSED
 * the notice can therefore never carry them.
 */
async function appendOutcomes(
	gateway: ConnectionGateway,
	outcomes: readonly OutcomeFor[]
): Promise<void> {
	// Sequential, never `Promise.all`: each is its own locked transaction and
	// they would queue on `GLOBAL_WRITE_LOCK_KEY` anyway (AD-6). Awaiting each
	// in turn is what makes "every outcome before the failure is committed" a
	// statement about the log's order rather than about scheduling luck.
	for (const outcome of outcomes) {
		await appendOneOutcome(gateway, outcome);
	}
}

/** One outcome, one whole transaction. */
async function appendOneOutcome(
	gateway: ConnectionGateway,
	{ intent, result }: OutcomeFor
): Promise<void> {
	const outcome = deliveryOutcomeOf(result);
	await runTransactionalWrite({
		gateway,
		// Nothing is decided from state: the outcome was decided by Discord.
		load: async () => ({}),
		decide: () => ({
			kind: 'accepted',
			events: [
				{
					type: NOTIFICATION_DISPATCHED_EVENT,
					payload: {
						// AD-17's key, verbatim, so the next pass's derivation can
						// match this outcome back to the intent it settles.
						eventSeq: intent.eventSeq,
						channel: intent.channel,
						recipient: intent.recipient,
						aboutEventType: intent.eventType,
						outcome,
						// Present only on a 429, and the number the next attempt
						// must wait at least as long as.
						retryAfterMs: result.kind === 'rate_limited' ? result.retryAfterMs : null,
						detail: result.kind === 'delivered' ? null : result.detail
					},
					// System-originated: nobody acted. Null as a pair, enforced by
					// `auction_events_actor_pair_null_together`.
					managerId: null,
					teamId: null,
					dispatchOutcome: DISPATCH_ATTEMPTED,
					deliveryOutcome: outcome
				}
			]
		})
	});
}

/** The `delivery_outcome` column value for one transport result. */
function deliveryOutcomeOf(result: ChannelPostResult): string {
	switch (result.kind) {
		case 'delivered':
			return DELIVERY_DELIVERED;
		case 'rate_limited':
			return DELIVERY_RATE_LIMITED;
		case 'failed':
			return DELIVERY_FAILED;
	}
}
