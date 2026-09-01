/**
 * The tick's sweep: re-derive what is overdue, close it one at a time, drain,
 * and write a heartbeat whatever happened (Story 3.5, AD-10, AD-11, AD-19,
 * AD-20).
 *
 * **One module, two runtimes.** This file is ordinary TypeScript with relative
 * `.ts` imports only, no Node builtins, no `$env` and no bare specifier it
 * needs at runtime — so Deno inside `supabase/functions/tick/` loads exactly
 * the file Node unit-tests, and the judgement about what to close lives in one
 * place rather than being restated on the other side of a runtime boundary
 * (AD-2). Everything runtime-specific — opening a connection, reading a
 * secret, answering an HTTP request — is the caller's, injected through the
 * `ConnectionGateway` port `shell/write.ts` already defines.
 *
 * **The sweep re-derives, never remembers.** The overdue set is a pure
 * function of the folded `auctionsReducer` state and the database clock, and
 * `auctionsReducer` removes an Auction from `byPlayer` the moment its
 * `AuctionClosed` is folded. So a pass that dies after two of three closes
 * loses nothing: the next pass folds the log as it now stands, sees the two
 * that closed are gone, and closes the third exactly once. There is no cursor,
 * no "last swept" column and no in-memory set to get out of step with the log
 * — restart-safety is structural rather than tested for.
 *
 * **Closes are SEQUENTIAL, each in its own transaction.** `closeOne` is one
 * whole `runTransactionalWrite` — lock, load, decide, persist, commit — so the
 * next close folds a log that already contains the previous one's event. That
 * is not an optimisation to skip: §10 example 17's second win lands in
 * Active/Bench precisely because the first close's effect on Minor League
 * occupancy was committed before it was evaluated, and a "fold once, close
 * many" sweep would put both in minors and be silently wrong (AD-11).
 *
 * **This module takes no lock.** `GLOBAL_WRITE_LOCK_KEY` is taken by
 * `runTransactionalWrite` inside each close and by no second mechanism (AD-6).
 * The read below is deliberately unlocked: it only decides which Auctions to
 * *offer* to `closeOne`, and each close re-reads the world under the lock and
 * re-checks expiry for itself. A sweep that held the lock across the whole
 * pass would block every Manager's Bid for the length of it, and would still
 * have to re-check inside each close anyway.
 *
 * **The version gate runs before anything is closed.** Every event carries the
 * `core_version` that produced it, so the newest row IS the Node deployment's
 * declared version. If it differs from this tick's `CORE_VERSION`, the pass
 * refuses, records the refusal and closes nothing — because an Auction closed
 * under different rules than its Bids were placed under cannot be undone, and
 * AD-4 forbids deleting the event (AD-20).
 *
 * **A live Minimum-Bid Contention is SKIPPED, not closed and not thrown on.**
 * No drawer exists until Story 3.6, and `closedWinnerFor` throws on one. The
 * sweep filters them out before calling `closeOne` so that one un-drawable
 * lottery cannot stall every other overdue close, and counts them on the
 * heartbeat so the skip is visible rather than silent.
 *
 * **The drain is a named no-op seam**, ordered after the sweep exactly as
 * `enqueue` is ordered after commit in `shell/write.ts`. Epic 5.1 gives it an
 * implementation; its throwing is recorded and cannot undo a committed close.
 *
 * **Every pass writes exactly one heartbeat row**, refusals and failures
 * included (AD-19). A pass that recorded nothing is indistinguishable from a
 * dead tick, which is the one thing an operator most needs to be able to tell
 * apart.
 *
 * Not this story: no draw (3.6), no pause check (Epic 7 — no pause event or
 * flag exists to read), no League Clock evaluation and no terminated unbid
 * Nominations (3.7), no outbox and no Discord (5.1), no external heartbeat
 * detector (8.2).
 */

import { CORE_VERSION } from '../core/constants.ts';
import {
	INITIAL_AUCTIONS,
	auctionsReducer,
	overdueAuctions
} from '../core/projection/auctions.ts';
import { fold } from '../core/projection/fold.ts';
import type { AppendedEvent } from '../core/types.ts';
import { requireDatabaseClock } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient } from '../shell/write.ts';
import { loadEventsViaClient } from './event-log.ts';

/**
 * What a pass did, as one word.
 *
 *  - `ok` — the pass ran and nothing inside it failed. Zero closes is `ok`:
 *    "nothing was overdue" is a successful pass, not a quiet one.
 *  - `completed_with_failures` — the pass ran to the end, but at least one
 *    close threw or the drain did. The closes that succeeded are committed and
 *    stand; the failures are named in `detail`.
 *  - `refused_version_mismatch` — the fail-stop. Nothing was closed (AD-20).
 *  - `failed` — the pass could not run at all: the clock read or the log read
 *    threw. Nothing was closed.
 */
export type TickOutcome = 'ok' | 'completed_with_failures' | 'refused_version_mismatch' | 'failed';

/** One Auction the sweep tried to close and could not. */
export type TickFailure = {
	readonly fantraxPlayerId: string;
	readonly message: string;
};

/** Everything one pass has to say for itself — the heartbeat row, in memory. */
export type TickSummary = {
	readonly outcome: TickOutcome;
	/** The database clock this pass derived its overdue set against. */
	readonly ranAt: string | null;
	/** The Players whose Auctions this pass closed, in the order it closed them. */
	readonly closed: readonly string[];
	/** Live Minimum-Bid Contentions passed over, awaiting Story 3.6's draw. */
	readonly skipped: readonly string[];
	/** Closes that threw. Each is recorded and the pass continues past it. */
	readonly failures: readonly TickFailure[];
	/** This tick's `CORE_VERSION`. */
	readonly tickCoreVersion: number;
	/** The newest `auction_events.core_version`, or `null` for an empty log. */
	readonly logCoreVersion: number | null;
	/** The drain seam's failure, if it had one. Never undoes a close. */
	readonly drainFailure: string | null;
	/** One human sentence naming what happened, for the heartbeat row. */
	readonly detail: string;
};

/** Close exactly one Auction, in its own locked transaction. */
export type CloseOneFn = (fantraxPlayerId: string) => Promise<unknown>;

/**
 * Epic 5.1's outbox drain (AD-17). Ordered after the sweep, always, and a
 * documented no-op until that story gives it an implementation — the same
 * shape and the same promise as `shell/write.ts`'s `EnqueueFn`.
 */
export type DrainFn = () => Promise<void> | void;

/**
 * The clock, on its own and unlocked. `write.ts` reads `now()` in the same
 * round trip as `pg_advisory_xact_lock` because it must lock before it reads
 * state (AD-6); this pass takes no lock, so it asks the plain question.
 * `requireDatabaseClock` is shared, so both call sites agree about what an
 * unusable answer is.
 */
const CLOCK_SQL = 'select now() as now';

/**
 * The heartbeat insert (AD-19).
 *
 * `ran_at` falls back to `now()` in SQL rather than to a clock read here,
 * because the one path that reaches this with a `null` instant is the pass
 * whose clock read is what failed — and a heartbeat stamped by the shell's own
 * `Date` would be the second clock AD-3 exists to forbid.
 */
const HEARTBEAT_SQL = `
	insert into tick_heartbeats
		(ran_at, outcome, closed, skipped, failed, tick_core_version, log_core_version, detail)
	values (coalesce($1::timestamptz, now()), $2, $3, $4, $5, $6, $7, $8)
`;

/**
 * One pass of the tick: version gate, sweep, drain, heartbeat.
 *
 * Returns the summary rather than throwing on a failed pass — the heartbeat is
 * the record, and the Deno entry point answers with this so an operator can
 * read the outcome off the HTTP response as well as out of the table. The one
 * thing that does throw is a heartbeat write that itself fails: at that point
 * there is nothing left to record it with.
 */
export async function runTick(input: {
	readonly gateway: ConnectionGateway;
	readonly closeOne: CloseOneFn;
	readonly drain?: DrainFn;
}): Promise<TickSummary> {
	const client = await input.gateway.connect();
	try {
		const summary = await sweepThenDrain(client, input.closeOne, input.drain);
		await writeHeartbeat(client, summary);
		return summary;
	} finally {
		// A `finally` that throws REPLACES the value the try block was about to
		// return, so an unguarded `release()` could discard a pass that swept,
		// drained and heartbeated successfully and surface it to the caller as
		// a connection-teardown error instead. Returning the connection to a
		// pool is never news worth losing a completed pass over.
		try {
			client.release();
		} catch (error) {
			console.error('runTick: releasing the sweep connection failed', error);
		}
	}
}

/**
 * The pass itself. Every failure inside becomes a summary rather than an
 * exception, so `runTick` above always reaches the heartbeat write.
 */
async function sweepThenDrain(
	client: TransactionalClient,
	closeOne: CloseOneFn,
	drain: DrainFn | undefined
): Promise<TickSummary> {
	let ranAt: string | null = null;
	let logCoreVersion: number | null = null;

	try {
		const clockResult = await client.query(CLOCK_SQL);
		const now = requireDatabaseClock(clockResult.rows[0]?.['now']);
		ranAt = now.toISOString();

		const events = await loadEventsViaClient(client);
		logCoreVersion = newestCoreVersion(events);

		// **The fail-stop, before anything is closed** (AD-20). An empty log has
		// no version to compare and nothing to close, so `null` passes through
		// to a pass that finds no overdue Auction — never to a refusal, which
		// would leave a brand-new deployment refusing forever.
		if (logCoreVersion !== null && logCoreVersion !== CORE_VERSION) {
			return {
				outcome: 'refused_version_mismatch',
				ranAt,
				closed: [],
				skipped: [],
				failures: [],
				tickCoreVersion: CORE_VERSION,
				logCoreVersion,
				drainFailure: null,
				// `logCoreVersion` is interpolated rather than only bound, so an
				// unreadable version — which `integerOrNull` writes to the column as
				// `null` — is still named here in full.
				detail:
					`refused: this tick carries CORE_VERSION ${CORE_VERSION} and the newest ` +
					`auction_events.core_version reads as ${JSON.stringify(logCoreVersion)}. Nothing was ` +
					'closed — an Auction closed under different rules than its Bids were placed under ' +
					'cannot be undone, because AD-4 forbids deleting the event (AD-20)'
			};
		}

		// **Re-derived from the folded log on every pass**, never remembered.
		const auctions = fold(INITIAL_AUCTIONS, events, auctionsReducer);
		const overdue = overdueAuctions(auctions, ranAt);

		const closed: string[] = [];
		const skipped: string[] = [];
		const failures: TickFailure[] = [];

		for (const auction of overdue) {
			// Story 3.6 owns the draw. Skipping is what keeps ONE un-drawable
			// lottery from stalling every other overdue close, and counting it
			// is what keeps the skip from being silent.
			if (auction.contention === 'minimum_bid') {
				skipped.push(auction.fantraxPlayerId);
				continue;
			}
			try {
				// One whole transaction, committed before the next is evaluated
				// (AD-11).
				await closeOne(auction.fantraxPlayerId);
				closed.push(auction.fantraxPlayerId);
			} catch (error) {
				// **One Auction's failure must not abort the pass.** It is
				// recorded and the sweep continues to the next — a single
				// corrupt Auction must not hold every other Player's close
				// hostage.
				failures.push({ fantraxPlayerId: auction.fantraxPlayerId, message: messageOf(error) });
			}
		}

		// **After the sweep, always**, and its throwing cannot undo a close:
		// every close above is already committed by its own transaction.
		let drainFailure: string | null = null;
		if (drain !== undefined) {
			try {
				await drain();
			} catch (error) {
				drainFailure = messageOf(error);
			}
		}

		const clean = failures.length === 0 && drainFailure === null;
		return {
			outcome: clean ? 'ok' : 'completed_with_failures',
			ranAt,
			closed,
			skipped,
			failures,
			tickCoreVersion: CORE_VERSION,
			logCoreVersion,
			drainFailure,
			detail: detailFor(closed, skipped, failures, drainFailure)
		};
	} catch (error) {
		// The pass could not run: the clock read or the log read threw. Nothing
		// was closed, and the heartbeat still gets written by the caller — a
		// tick that cannot read the log is exactly the state an operator must
		// be able to see rather than infer from silence.
		return {
			outcome: 'failed',
			ranAt,
			closed: [],
			skipped: [],
			failures: [],
			tickCoreVersion: CORE_VERSION,
			logCoreVersion,
			drainFailure: null,
			detail: `the pass could not run: ${messageOf(error)}`
		};
	}
}

/**
 * The `core_version` of the newest event, or `null` for an empty log.
 *
 * `loadEventsViaClient` orders by `seq` ascending, which is the fold order
 * AD-5 requires and never `occurred_at` — a transaction queued on the global
 * lock commits later while holding an earlier timestamp, so the last row by
 * time is not necessarily the last row written.
 *
 * A non-numeric `core_version` reads back as `NaN`, which is neither `null`
 * nor `CORE_VERSION` and therefore refuses the pass. That is the correct
 * direction: an unreadable version is not a matching one. `integerOrNull`
 * below is what lets that refusal still write its own heartbeat row — `NaN`
 * cannot be bound to an `integer` column.
 */
function newestCoreVersion(events: readonly AppendedEvent[]): number | null {
	const newest = events[events.length - 1];
	if (newest === undefined) return null;
	return newest.coreVersion;
}

/**
 * A value fit to bind to an `integer` column, or `null`.
 *
 * **This exists because of the one path the version gate is proudest of.**
 * `newestCoreVersion` can answer `NaN` for a `core_version` that will not read
 * as a number, and the gate correctly refuses that pass — `NaN !== null` and
 * `NaN !== CORE_VERSION`. But `log_core_version` is declared `integer`, and
 * binding `NaN` to it fails with `invalid input syntax for type integer:
 * "NaN"`, which throws out of `writeHeartbeat` and leaves the refusal with NO
 * ROW AT ALL — precisely the "indistinguishable from a dead tick" state AD-19
 * exists to prevent, reached by the code that was trying to prevent it.
 *
 * So the column takes `null` and `detail` carries the unreadable value
 * verbatim. `null` in that column already means "no version to compare"; a
 * version that cannot be read is honestly a member of that set, and the
 * sentence beside it says which kind it was.
 *
 * `auction_events.core_version` is `integer not null`, so this is defensive
 * rather than live. It is here anyway, because the alternative is a comment
 * asserting a refusal path that cannot actually record itself.
 */
function integerOrNull(value: number | null): number | null {
	if (value === null) return null;
	return Number.isInteger(value) ? value : null;
}

/** Write the one heartbeat row this pass owes (AD-19). */
async function writeHeartbeat(client: TransactionalClient, summary: TickSummary): Promise<void> {
	await client.query(HEARTBEAT_SQL, [
		summary.ranAt,
		summary.outcome,
		summary.closed.length,
		summary.skipped.length,
		summary.failures.length,
		// Both version columns go through the same guard. Only the log's is
		// reachable today — the tick's is a module constant — but a guard that
		// covered one of two identically-typed columns would be an invitation
		// to bind the wrong one later.
		integerOrNull(summary.tickCoreVersion),
		integerOrNull(summary.logCoreVersion),
		summary.detail
	]);
}

/** One sentence naming what a completed pass did, for the heartbeat row. */
function detailFor(
	closed: readonly string[],
	skipped: readonly string[],
	failures: readonly TickFailure[],
	drainFailure: string | null
): string {
	const parts = [
		`closed ${closed.length}${closed.length === 0 ? '' : ` (${closed.join(', ')})`}`,
		`skipped ${skipped.length}${skipped.length === 0 ? '' : ` (${skipped.join(', ')}) — a live Minimum-Bid Contention has no drawer until Story 3.6`}`
	];
	for (const failure of failures) {
		parts.push(`failed to close ${failure.fantraxPlayerId}: ${failure.message}`);
	}
	if (drainFailure !== null) {
		parts.push(`the drain threw after the sweep, and every close above still stands: ${drainFailure}`);
	}
	return parts.join('; ');
}

/**
 * How much of one error's text may reach the heartbeat.
 *
 * `detail` is unbounded `text`, so nothing in the database stops a driver
 * error carrying a whole serialized query — or a whole failed INSERT's
 * parameters — into a row that is written on every single pass, ten seconds
 * apart. Truncating here bounds the row rather than the diagnosis: the message
 * a human reads leads with what threw, and the tail of a very long one is
 * never the informative part.
 */
const MAX_MESSAGE_LENGTH = 500;

/**
 * A thrown value's message, without assuming it is an `Error` and without
 * assuming it is short. A rejected promise can carry anything, and the
 * heartbeat's job is to record what happened rather than to crash a second
 * time working out how to describe it.
 */
function messageOf(error: unknown): string {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	if (text.length <= MAX_MESSAGE_LENGTH) return text;
	return `${text.slice(0, MAX_MESSAGE_LENGTH)}… [truncated, ${text.length} characters]`;
}
