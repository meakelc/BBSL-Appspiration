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
 * **A live Minimum-Bid Contention is CLOSED like anything else** (Story 3.6).
 * It used to be filtered out by name, because no drawer existed and
 * `closedWinnerFor` threw on one. There is a drawer now: `closeAuction` reads
 * the sealed seed under its own lock, derives the winner from it and appends
 * the reveal before the close, so this loop needs no branch for a lottery and
 * has none. A lottery that throws is recorded as a failure like any other
 * failed close and retried next pass — which is the same protection the skip
 * used to give, without the sweep having to know what a lottery is.
 *
 * **`skipped` therefore stays, and stays EMPTY.** The field and the
 * `tick_heartbeats.skipped` column are kept rather than removed: the table is
 * append-only and holds real historical rows whose skip counts are facts about
 * passes that happened, and dropping a column off it for cosmetics is not
 * worth a migration. Nothing writes a non-zero value any more, and no code
 * path can.
 *
 * **The League Clock is evaluated after the closes and before the drain**
 * (Story 3.7). `server/phase-end.ts`'s `evaluateLeagueClock` is its own whole
 * `runTransactionalWrite` — lock, load, decide, persist, commit — so it folds
 * a log that already contains every close this pass committed, and a throw
 * inside it rolls back nothing that was already committed. It is recorded on
 * the heartbeat exactly as a failed close is, and retried on the next pass.
 *
 * The order is not arbitrary. A nomination whose Auction closed during THIS
 * pass must not then be terminated as though nobody had bid on it — and it
 * cannot be, because the close is committed before the evaluation folds the
 * log. Running the evaluation first would leave that window open for one pass.
 *
 * **The evaluation is re-derived like everything else**, so running it on
 * every pass forever is safe: once the phase has folded to Contract
 * Assignment, `decidePhaseEnd` answers "nothing to do" from the very event
 * that made it fold. There is no flag, no cursor and no memory.
 *
 * **The drain is `server/outbox.ts`'s dispatcher since Story 5.1**, ordered
 * after the sweep and after the League Clock, exactly as `enqueue` is ordered
 * inside the appending transaction in `shell/write.ts`. It re-derives which
 * delivery intents are still pending, posts at most the per-pass budget's worth
 * through the injected channel port and appends one `NotificationDispatched`
 * per attempt (AD-17, AD-18). Its throwing is recorded as `drainFailure` and
 * cannot undo a committed close — every close in the pass is already committed
 * by its own transaction before the drain opens a connection, which is the
 * whole of "a Discord outage costs a notification and never a bid".
 *
 * **This module still knows nothing about Discord**, and the seam is why: it
 * decides WHEN the drain runs and what a failure of it means for the pass, and
 * `drainOutbox` decides what draining IS. Injecting it is what lets these tests
 * make the drain throw or count without a transport.
 *
 * **Every pass writes exactly one heartbeat row**, refusals and failures
 * included (AD-19). A pass that recorded nothing is indistinguishable from a
 * dead tick, which is the one thing an operator most needs to be able to tell
 * apart.
 *
 * Not this story: no pause check (Epic 7 — no pause event or flag exists to
 * read), no message composition or mention copy (5.2, 5.3), no mute settings
 * (5.4), no external heartbeat detector and no outbox-backlog alert (8.2).
 * The League Clock evaluation and the terminated unbid Nominations arrived
 * with Story 3.7, and the drain stopped being a no-op with Story 5.1; both are
 * described above.
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
import type { AssignmentDeadlineOutcome } from './assignment-deadline.ts';
import type { PhaseEndOutcome } from './phase-end.ts';

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
	/**
	 * Auctions this pass passed over. **Always empty since Story 3.6.**
	 *
	 * It held live Minimum-Bid Contentions, which had no drawer and could not
	 * be closed. They can be now, and no other reason to skip an overdue
	 * Auction exists — so nothing writes to this and no path can. It is kept
	 * because `tick_heartbeats.skipped` is kept: the table is append-only and
	 * its historical rows record real skips, and dropping a column off it for
	 * cosmetics is not worth a migration.
	 */
	readonly skipped: readonly string[];
	/** Closes that threw. Each is recorded and the pass continues past it. */
	readonly failures: readonly TickFailure[];
	/** This tick's `CORE_VERSION`. */
	readonly tickCoreVersion: number;
	/** The newest `auction_events.core_version`, or `null` for an empty log. */
	readonly logCoreVersion: number | null;
	/**
	 * What the League Clock evaluation did on this pass (Story 3.7).
	 *
	 *  - `not_evaluated` — the pass refused on a version mismatch, or could not
	 *    run at all. The clock was never looked at, which is a different fact
	 *    from looking and finding it unexpired, and the heartbeat says which.
	 *  - `not_due` — evaluated, and nothing was appended: the clock has not run
	 *    out, it never started, or the phase had already ended. By far the
	 *    common answer, and a successful pass.
	 *  - `ended` — THIS pass appended the `ContractAssignmentOpened`. It reads
	 *    once in the history of a league, which is what makes it worth a word.
	 *  - `failed` — the evaluation threw. Every close above still stands; the
	 *    message is in `phaseEndFailure` and the next pass retries.
	 */
	readonly phaseEnd: PhaseEndStatus;
	/** The Players this pass returned to the pool, in appended order. */
	readonly terminated: readonly string[];
	/**
	 * The League Clock's own expiry and the instant it was compared against —
	 * both `null` unless THIS pass ended the phase (Story 3.7).
	 *
	 * The pair is the whole of AD-10's "late, not wrong" made visible: a pass
	 * that ran six hours after the clock expired records the identical
	 * `expiredAt` and a later `evaluatedAt`, and an operator reading only one of
	 * them cannot tell that pass from an on-time one.
	 */
	readonly phaseEndExpiredAt: string | null;
	readonly phaseEndEvaluatedAt: string | null;
	/** The evaluation's failure, if it had one. Never undoes a close. */
	readonly phaseEndFailure: string | null;
	/**
	 * What the assignment-deadline evaluation did on this pass (Story 6.2).
	 *
	 * `PhaseEndStatus`' four words for its reason: `not_evaluated` and
	 * `nothing_owed` are genuinely different facts, and a heartbeat that
	 * collapsed them would make a refused pass indistinguishable from a pass
	 * that looked and found the deadline unset.
	 */
	readonly assignmentDeadline: AssignmentDeadlineStatus;
	/** The deadline evaluation's failure, if it had one. Never undoes a close. */
	readonly assignmentDeadlineFailure: string | null;
	/** The drain seam's failure, if it had one. Never undoes a close. */
	readonly drainFailure: string | null;
	/** One human sentence naming what happened, for the heartbeat row. */
	readonly detail: string;
};

/**
 * What one pass's League Clock evaluation amounted to (Story 3.7).
 *
 * Four words rather than a boolean, because `not_evaluated` and `not_due` are
 * genuinely different facts and collapsing them would make a refused pass
 * indistinguishable from a pass that looked and found nothing due — the same
 * distinction `TickOutcome` draws between `refused_version_mismatch` and `ok`.
 */
export type PhaseEndStatus = 'not_evaluated' | 'not_due' | 'ended' | 'failed';

/**
 * What one pass's assignment-deadline evaluation amounted to (Story 6.2).
 *
 *  - `not_evaluated` — the pass refused on a version mismatch, could not run
 *    at all, or was given no step to run. The deadline was never looked at.
 *  - `nothing_owed` — evaluated, and nothing was appended: no deadline is set,
 *    nothing is due yet, or both markers already fired for the standing
 *    deadline. By far the common answer, and a successful pass.
 *  - `reminded` — THIS pass appended the one `AssignmentRemindersSent`.
 *  - `passed` — THIS pass appended the `AssignmentDeadlinePassed`. It also
 *    covers the pass that appended BOTH, which is what a tick that was down
 *    across the reminder window comes back to: the later fact is the one the
 *    word states, and `detail` names them individually.
 *  - `failed` — the evaluation threw. Every close above still stands.
 */
export type AssignmentDeadlineStatus =
	| 'not_evaluated'
	| 'nothing_owed'
	| 'reminded'
	| 'passed'
	| 'failed';

/** Close exactly one Auction, in its own locked transaction. */
export type CloseOneFn = (fantraxPlayerId: string) => Promise<unknown>;

/**
 * Evaluate the League Clock and end the Auction Phase if it has run out
 * (Story 3.7) — `server/phase-end.ts`'s `evaluateLeagueClock`, injected here
 * for `CloseOneFn`'s reason.
 *
 * This module decides WHEN the evaluation runs (after the closes, before the
 * drain) and what a failure of it means for the pass; `evaluateLeagueClock`
 * decides what ending the phase IS. Injecting the seam is what lets these
 * tests make the evaluation throw, count, or observe the log as it stood when
 * it was called — none of which a real transaction would let them do. The two
 * halves meet for real in `tests/server/phase-end.test.ts`.
 *
 * Optional, exactly as `drain` is: a caller that omits it gets a pass that
 * records `not_evaluated`, which is honest rather than silent.
 */
export type EndPhaseFn = () => Promise<PhaseEndOutcome>;

/**
 * Evaluate the assignment deadline and send the one reminder or the one notice
 * it owes (Story 6.2) — `server/assignment-deadline.ts`'s
 * `evaluateAssignmentDeadline`, injected here for `EndPhaseFn`'s reason.
 *
 * This module decides WHEN it runs — after the phase end, before the drain —
 * and what a failure of it means for the pass; `evaluateAssignmentDeadline`
 * decides what the deadline IS. It is deliberately NOT a new schedule: the
 * deadline is evaluated on the existing ten-second tick, so nothing about the
 * deployment changes and a marker's transaction commits beside the closes it
 * followed.
 *
 * Optional, exactly as `endPhase` and `drain` are: a caller that omits it gets
 * a pass that records `not_evaluated`, which is honest rather than silent.
 */
export type AssignmentDeadlineFn = () => Promise<AssignmentDeadlineOutcome>;

/**
 * The outbox drain (AD-17) — `server/outbox.ts`'s `drainOutbox`, injected here
 * for `CloseOneFn`'s and `EndPhaseFn`'s reason: the pass has to be able to make
 * it throw, count and run against a log this test controls, none of which a
 * real transport would allow.
 *
 * Ordered after the sweep, always. Optional, exactly as `endPhase` is: a caller
 * that omits it gets a pass that drains nothing and records `null` for
 * `drainFailure`, which is what every unit test of the sweep itself does.
 *
 * Answers `void`: whatever the drain has to say for itself goes into the log it
 * writes, not into the heartbeat. Only its FAILURE is the pass's business, and
 * that arrives as a throw.
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
	readonly endPhase?: EndPhaseFn;
	readonly assignmentDeadline?: AssignmentDeadlineFn;
	readonly drain?: DrainFn;
}): Promise<TickSummary> {
	const client = await input.gateway.connect();
	try {
		const summary = await sweepThenDrain(
			client,
			input.closeOne,
			input.endPhase,
			input.assignmentDeadline,
			input.drain
		);
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
	endPhase: EndPhaseFn | undefined,
	assignmentDeadline: AssignmentDeadlineFn | undefined,
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
				// **The League Clock is not evaluated either** (Story 3.7). The
				// fail-stop is about the whole pass, not only about closing: ending
				// the Auction Phase under different rules than the league bid under
				// is exactly as undoable as closing an Auction under them, which is
				// to say not at all (AD-4, AD-20).
				phaseEnd: 'not_evaluated',
				terminated: [],
				phaseEndExpiredAt: null,
				phaseEndEvaluatedAt: null,
				phaseEndFailure: null,
				// **The assignment deadline is not evaluated either** (Story
				// 6.2), and for the fail-stop's own reason: it is about the whole
				// pass rather than only about closing. A reminder or a notice
				// sent under different rules than the league assigned under is as
				// undoable as a close under them, which is to say not at all.
				assignmentDeadline: 'not_evaluated',
				assignmentDeadlineFailure: null,
				drainFailure: null,
				// `logCoreVersion` is interpolated rather than only bound, so an
				// unreadable version — which `integerOrNull` writes to the column as
				// `null` — is still named here in full.
				detail:
					`refused: this tick carries CORE_VERSION ${CORE_VERSION} and the newest ` +
					`auction_events.core_version reads as ${JSON.stringify(logCoreVersion)}. Nothing was ` +
					'closed — an Auction closed under different rules than its Bids were placed under ' +
					'cannot be undone, because AD-4 forbids deleting the event (AD-20)' +
					PHASE_END_NOT_EVALUATED_CLAUSE +
					ASSIGNMENT_DEADLINE_NOT_EVALUATED_CLAUSE
			};
		}

		// **Re-derived from the folded log on every pass**, never remembered.
		const auctions = fold(INITIAL_AUCTIONS, events, auctionsReducer);
		const overdue = overdueAuctions(auctions, ranAt);

		const closed: string[] = [];
		// Declared, never pushed to. See `TickSummary.skipped`: the column is
		// kept for the historical rows that carry real counts, and there is no
		// longer any reason for a pass to skip an overdue Auction.
		const skipped: readonly string[] = [];
		const failures: TickFailure[] = [];

		for (const auction of overdue) {
			// **No branch on contention state** (Story 3.6). Every overdue
			// Auction is offered to `closeOne`, lottery or not: the draw lives
			// inside that transaction, where the sealed seed can be read under
			// the same lock that appends. A lottery that cannot be drawn throws
			// there and is caught below like any other failure, so one broken
			// lottery still cannot stall the rest of the pass.
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

		// **The League Clock, after every close and before the drain** (Story
		// 3.7). It is its own whole `runTransactionalWrite`, so it folds a log
		// that already contains this pass's closes — which is what stops a
		// nomination whose Auction closed moments ago from being terminated as
		// though nobody had bid on it — and a throw here rolls back nothing that
		// is already committed.
		let phaseEnd: PhaseEndStatus = 'not_evaluated';
		let terminated: readonly string[] = [];
		let phaseEndExpiredAt: string | null = null;
		let phaseEndEvaluatedAt: string | null = null;
		let phaseEndFailure: string | null = null;
		if (endPhase !== undefined) {
			try {
				const outcome = await endPhase();
				phaseEnd = outcome.ended ? 'ended' : 'not_due';
				terminated = outcome.terminated;
				phaseEndExpiredAt = outcome.expiredAt;
				phaseEndEvaluatedAt = outcome.evaluatedAt;
			} catch (error) {
				// Recorded like a failed close and for the same reason: the closes
				// above are committed and stand, the drain below still runs, and the
				// next pass re-derives the whole question from the log.
				phaseEnd = 'failed';
				phaseEndFailure = messageOf(error);
			}
		}

		// **The assignment deadline, after the phase end and before the drain**
		// (Story 6.2). Its own whole `runTransactionalWrite`, so it folds a log
		// that already carries this pass's closes and any phase end — which is
		// what lets the deadline's markers commit beside them — and a throw here
		// rolls back nothing that is already committed. It runs BEFORE the drain
		// so the intents it files are delivered on the same pass rather than
		// waiting ten seconds for the next.
		let assignmentDeadlineStatus: AssignmentDeadlineStatus = 'not_evaluated';
		let assignmentDeadlineFailure: string | null = null;
		let assignmentDeadlineInstant: string | null = null;
		let assignmentDeadlineReminded = false;
		let assignmentDeadlineOutstanding: readonly string[] = [];
		if (assignmentDeadline !== undefined) {
			try {
				const outcome = await assignmentDeadline();
				assignmentDeadlineStatus = outcome.passed
					? 'passed'
					: outcome.reminded
						? 'reminded'
						: 'nothing_owed';
				assignmentDeadlineFailure = null;
				assignmentDeadlineInstant = outcome.deadline;
				assignmentDeadlineReminded = outcome.reminded;
				assignmentDeadlineOutstanding = outcome.outstandingTeamIds;
			} catch (error) {
				// Recorded like a failed close and for the same reason: the closes
				// above are committed and stand, the drain below still runs, and
				// the next pass re-derives the whole question from the log.
				assignmentDeadlineStatus = 'failed';
				assignmentDeadlineFailure = messageOf(error);
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

		// A failed evaluation counts exactly as a failed close does: the pass
		// ran to the end, something inside it threw, and what committed stands.
		const clean =
			failures.length === 0 &&
			phaseEndFailure === null &&
			assignmentDeadlineFailure === null &&
			drainFailure === null;
		return {
			outcome: clean ? 'ok' : 'completed_with_failures',
			ranAt,
			closed,
			skipped,
			failures,
			tickCoreVersion: CORE_VERSION,
			logCoreVersion,
			phaseEnd,
			terminated,
			phaseEndExpiredAt,
			phaseEndEvaluatedAt,
			phaseEndFailure,
			assignmentDeadline: assignmentDeadlineStatus,
			assignmentDeadlineFailure,
			drainFailure,
			detail:
				detailFor(closed, skipped, failures, drainFailure) +
				phaseEndClause({
					status: phaseEnd,
					terminated,
					expiredAt: phaseEndExpiredAt,
					evaluatedAt: phaseEndEvaluatedAt,
					failure: phaseEndFailure
				}) +
				assignmentDeadlineClause({
					status: assignmentDeadlineStatus,
					deadline: assignmentDeadlineInstant,
					reminded: assignmentDeadlineReminded,
					outstanding: assignmentDeadlineOutstanding,
					failure: assignmentDeadlineFailure
				})
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
			// The clock read or the log read threw, so nothing downstream ran at
			// all — including the evaluation. Saying so is not noise: a heartbeat
			// silent about the League Clock would read as "evaluated, nothing due"
			// on the one pass where that is least true.
			phaseEnd: 'not_evaluated',
			terminated: [],
			phaseEndExpiredAt: null,
			phaseEndEvaluatedAt: null,
			phaseEndFailure: null,
			// The clock read or the log read threw, so nothing downstream ran at
			// all — the deadline evaluation included. Saying so is not noise: a
			// heartbeat silent about it would read as "evaluated, nothing owed"
			// on the one pass where that is least true.
			assignmentDeadline: 'not_evaluated',
			assignmentDeadlineFailure: null,
			drainFailure: null,
			detail:
				`the pass could not run: ${messageOf(error)}` +
				PHASE_END_NOT_EVALUATED_CLAUSE +
				ASSIGNMENT_DEADLINE_NOT_EVALUATED_CLAUSE
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
	// `skipped` is always empty since Story 3.6 — nothing writes to it and no
	// path can. The count is still stated, because a heartbeat that stopped
	// naming a column the table still carries would read as a missing fact
	// rather than as a zero.
	const parts = [
		`closed ${closed.length}${closed.length === 0 ? '' : ` (${closed.join(', ')})`}`,
		`skipped ${skipped.length}${skipped.length === 0 ? '' : ` (${skipped.join(', ')})`}`
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
 * The clause for a pass that never reached the evaluation.
 *
 * A constant rather than three call sites building the same string, because
 * two of them are the branches that never call `phaseEndClause` at all — the
 * version refusal and the pass that could not run — and a heartbeat silent
 * about the League Clock there would read as "evaluated, nothing due", which
 * is exactly the wrong thing to infer.
 */
const PHASE_END_NOT_EVALUATED_CLAUSE = '; the League Clock was not evaluated';

/**
 * What the League Clock evaluation contributes to the heartbeat's sentence
 * (Story 3.7).
 *
 * **Appended to EVERY branch's detail, including the two that never ran it.**
 * A heartbeat silent about the evaluation reads as "evaluated, nothing due" —
 * which is exactly the wrong thing to infer about a pass that refused on a
 * version mismatch or could not read the log at all. Naming
 * `not_evaluated` out loud on those two branches costs six words and closes
 * the one gap where absence and a negative look identical.
 *
 * Leads with a semicolon and a space so it composes onto `detailFor`'s
 * `join('; ')` output and onto the two bespoke sentences alike, without any
 * caller having to know which shape it is extending.
 */
function phaseEndClause(input: {
	readonly status: PhaseEndStatus;
	readonly terminated: readonly string[];
	readonly expiredAt: string | null;
	readonly evaluatedAt: string | null;
	readonly failure: string | null;
}): string {
	switch (input.status) {
		case 'not_evaluated':
			return PHASE_END_NOT_EVALUATED_CLAUSE;
		case 'not_due':
			return '; the League Clock was evaluated and the Auction Phase continues';
		case 'ended': {
			// The terminated Players are NAMED rather than counted, `closed`'s
			// discipline: this line is written once in the history of a league and
			// it is the record of which nominations the phase end returned to the
			// pool.
			const players = `${input.terminated.length}${
				input.terminated.length === 0 ? '' : ` (${input.terminated.join(', ')})`
			}`;
			// **BOTH instants, and the pair is the point.** The payloads carry
			// `expiredAt` and `evaluatedAt` precisely so AD-10's "late, not wrong"
			// is readable after the fact: a tick six hours behind appends the
			// identical `expiredAt` and a later `evaluatedAt`, and the row's own
			// `occurred_at` records when it landed. Stating only one of them would
			// leave an operator unable to tell a punctual pass from a stalled one
			// — which is the single most useful thing this line can say.
			//
			// Guarded rather than assumed: `readPhaseEndInstants` answers `null`
			// for a payload it cannot read, and a heartbeat that printed
			// "due at null" would be worse than one that says it could not tell.
			const when =
				input.expiredAt === null || input.evaluatedAt === null
					? ' (the due and evaluated instants could not be read off the appended event)'
					: ` — due at ${input.expiredAt}, evaluated at ${input.evaluatedAt}`;
			return (
				'; the League Clock expired and the Auction Phase ended, terminating ' +
				`${players}${when}`
			);
		}
		case 'failed':
			return (
				'; the League Clock evaluation threw, and every close above still stands: ' +
				`${input.failure ?? 'no message'}`
			);
	}
}

/**
 * The clause for a pass that never reached the deadline evaluation.
 *
 * `PHASE_END_NOT_EVALUATED_CLAUSE`'s twin, for its reason: two branches never
 * call `assignmentDeadlineClause` at all — the version refusal and the pass
 * that could not run — and a heartbeat silent about the deadline there would
 * read as "evaluated, nothing owed", which is exactly the wrong thing to infer.
 */
const ASSIGNMENT_DEADLINE_NOT_EVALUATED_CLAUSE = '; the assignment deadline was not evaluated';

/**
 * What the assignment-deadline evaluation contributes to the heartbeat's
 * sentence (Story 6.2).
 *
 * Leads with a semicolon and a space so it composes onto `detailFor`'s
 * `join('; ')` output and onto the two bespoke sentences alike, exactly as
 * `phaseEndClause` does.
 *
 * The addressed Teams are NAMED rather than counted, `closed`'s discipline:
 * a reminder and a notice are each written once per deadline in the history of
 * a league, and this line is the record of who they went to.
 */
function assignmentDeadlineClause(input: {
	readonly status: AssignmentDeadlineStatus;
	readonly deadline: string | null;
	readonly reminded: boolean;
	readonly outstanding: readonly string[];
	readonly failure: string | null;
}): string {
	const who =
		input.outstanding.length === 0
			? 'no Team was outstanding'
			: `${String(input.outstanding.length)} outstanding (${input.outstanding.join(', ')})`;
	const when = input.deadline ?? 'an unreadable instant';

	switch (input.status) {
		case 'not_evaluated':
			return ASSIGNMENT_DEADLINE_NOT_EVALUATED_CLAUSE;
		case 'nothing_owed':
			return '; the assignment deadline was evaluated and owed nothing';
		case 'reminded':
			return `; the assignment reminder for ${when} was sent, ${who}`;
		case 'passed':
			// A pass that appended BOTH markers says so: a tick down across the
			// reminder window comes back owing them together, and reporting only
			// the later one would hide that the reminder ever went out.
			return (
				`; the assignment deadline ${when} passed and its notice was sent, ${who}` +
				(input.reminded ? ', and the reminder for it was sent on this same pass' : '')
			);
		case 'failed':
			return (
				'; the assignment deadline evaluation threw, and every close above still stands: ' +
				`${input.failure ?? 'no message'}`
			);
	}
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
