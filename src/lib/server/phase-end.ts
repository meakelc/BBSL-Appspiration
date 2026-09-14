/**
 * The phase-end transaction: fold the League Clock, decide whether the Auction
 * Phase is over, and append what says so. Server-only (Story 3.7, FR-22,
 * AD-22).
 *
 * **Nothing here is stored but the events.** There is no `league_clock`
 * column, no stored countdown and no phase flag: the expiry is
 * `leagueClockExpiry` over the fold, the phase is `phaseReducer` over the
 * fold, and the freed board seats are `nominationsReducer` over the fold. The
 * one write outside `auction_events` is the claim-row delete
 * `releaseNomination` performs, and that is a WRITE-SIDE constraint nothing
 * reads (`20260825000000_open_nominations.sql`).
 *
 * **It frees no Nomination Slot, and must not.** A termination has no winner,
 * and since FR-9's amendment a Slot is released by winning a Player and by
 * nothing else. A Team whose nomination expires unbid keeps the Slot it spent
 * on that Player.
 *
 * **One module, two runtimes.** Relative `.ts` imports only, no Node builtin,
 * no `$env` and no bare specifier — Deno loads this file through
 * `server/sweep.ts` and `supabase/functions/tick/index.ts`, so it is under the
 * same constraint `server/contention-seed.ts` was extracted to protect (AD-2).
 * `npx deno check --config supabase/functions/tick/deno.json
 * supabase/functions/tick/index.ts` is what proves it, and `--config` is
 * load-bearing.
 *
 * **`evaluateLeagueClock` is called by the tick, once per pass, after the
 * closes and before the drain** — its own `runTransactionalWrite`, so a throw
 * here rolls back nothing that was already committed and is recorded on the
 * heartbeat like a failed close. It is the ONLY evaluator: there is no second
 * phase-end path, no route that ends the phase and no Commissioner override
 * (Epic 7).
 *
 * **It is safe to run on every pass forever.** `decidePhaseEnd` returns `null`
 * once the phase has folded to Contract Assignment, and the event that made it
 * fold is in the log this function reads — so a second evaluation appends
 * nothing, and a tick that restarts mid-pass needs no cursor and no memory.
 * That is the same "re-derive, never remember" property the sweep beside it
 * has, for the same reason.
 */

import {
	INITIAL_AUCTIONS,
	auctionsReducer
} from '../core/projection/auctions.ts';
import { fold } from '../core/projection/fold.ts';
import {
	INITIAL_LEAGUE_CLOCK,
	leagueClockReducer
} from '../core/projection/league-clock.ts';
import {
	AUCTION_TERMINATED_EVENT,
	INITIAL_NOMINATIONS,
	nominationsReducer,
	readTerminatedPlayerId
} from '../core/projection/nominations.ts';
import {
	CONTRACT_ASSIGNMENT_OPENED_EVENT,
	INITIAL_PHASE,
	phaseReducer
} from '../core/projection/phase.ts';
import { decidePhaseEnd, readPhaseEndInstants } from '../core/rules/phase-end.ts';
import type { PhaseEndState } from '../core/rules/phase-end.ts';
import { runTransactionalWrite } from '../shell/write.ts';
import type { ConnectionGateway, TransactionalClient } from '../shell/write.ts';
import { loadEventsViaClient } from './event-log.ts';
import { releaseNomination } from './nomination.ts';
import { EVERY_TEAM, enqueueBroadcastsAndMentions } from './outbox.ts';

/**
 * What one evaluation did, as the tick has to report it.
 *
 * `ended` is `true` only when this evaluation is the one that appended the
 * `ContractAssignmentOpened` — never when it merely observed a phase that had
 * already ended. That distinction is the whole point of recording it: a
 * heartbeat saying the phase ended on every pass for a week would be a
 * heartbeat nobody could read the transition out of.
 *
 * `terminated` is the Players this evaluation returned to the pool, in the
 * order the events were appended. Empty is an ordinary outcome — a league
 * where every nomination drew a Bid ends its phase with zero terminations, and
 * zero is not a failure.
 */
export type PhaseEndOutcome = {
	readonly ended: boolean;
	readonly terminated: readonly string[];
	/**
	 * The League Clock's own expiry, and the instant it was compared against —
	 * both `null` unless THIS evaluation ended the phase.
	 *
	 * The pair is what makes AD-10's "late, not wrong" readable on the
	 * heartbeat: a tick that ran six hours after the clock expired appends the
	 * identical `expiredAt` and a later `evaluatedAt`, and without both an
	 * operator cannot tell that pass from an on-time one. Read back off the
	 * appended payload through the core's own `readPhaseEndInstants`, never
	 * recomputed here.
	 */
	readonly expiredAt: string | null;
	readonly evaluatedAt: string | null;
};

/**
 * Fold everything the phase end is decided from out of ONE read of the log.
 *
 * Four folds over a single `loadEventsViaClient` read — `server/close.ts`'s
 * discipline: the projections cannot disagree about which events they saw,
 * because they saw the same array. There is no table read here at all, and no
 * point read: ending the phase records that a clock ran out and frees the
 * Slots still held, and neither is a fact about a roster or the pool.
 *
 * **The auctions fold is the one that is easy to leave out and cannot be.**
 * `openNominations()` answers which Players hold a board seat, never which of
 * them took a Bid — so without it, a nomination whose Auction is contested but
 * STUCK (a close that keeps throwing) is indistinguishable from an unbid one,
 * and would be terminated as though nobody had ever bid. `decidePhaseEnd`
 * terminates only where `auctionForPlayer(...) === null`, and this is where
 * that fold comes from.
 */
export async function loadPhaseEndState(client: TransactionalClient): Promise<PhaseEndState> {
	const events = await loadEventsViaClient(client);
	return {
		clock: fold(INITIAL_LEAGUE_CLOCK, events, leagueClockReducer),
		nominations: fold(INITIAL_NOMINATIONS, events, nominationsReducer),
		auctions: fold(INITIAL_AUCTIONS, events, auctionsReducer),
		phase: fold(INITIAL_PHASE, events, phaseReducer)
	};
}

/**
 * Evaluate the League Clock and, if it has run out, end the Auction Phase:
 * one transaction, one `AuctionTerminated` per still-unbid nomination, one
 * `ContractAssignmentOpened` last.
 *
 * **Two clocks, and which is which matters here as it does at a close.**
 * `runTransactionalWrite` reads the database's transaction-start clock once
 * (AD-3) and this function hands it to the core as `now` — the instant the
 * expiry is COMPARED against. The expiry itself is derived from instants the
 * log already carries, so a tick running six hours late appends a
 * byte-identical `expiredAt` and only the row's `occurred_at` records when it
 * actually landed (AD-10).
 *
 * **`releaseNomination` is registered, and it has to be.** `open_nominations`
 * is a real claim table with a primary key on the Player, written inside the
 * nomination's own transaction. The fold frees that board seat on an
 * `AuctionTerminated`; if the claim row stayed behind, the table and the log
 * would disagree about that Player PERMANENTLY — an insert-only log can never
 * be replayed to clear a row, and the Player would be back in the pool by the
 * fold and still un-nominatable by `open_nominations_pkey`. It goes through
 * the `projections` hook because that is the one seam that persists INSIDE the
 * appending transaction (AD-5), so the deletes and the events commit together
 * or neither does.
 *
 * On this path it issues exactly that one delete. `releaseNomination`'s Slot
 * delete fires on an `AuctionClosed`, keyed on the winner, and a termination
 * is not a close and names none.
 *
 * **No `deviceClass`.** A phase end is not a user action: no browser submitted
 * it and no header describes it, so the NFR §5 measurement column stays null
 * rather than carrying an invented class.
 *
 * **A phase end cannot be refused**, so there is no rejection shape.
 * `decidePhaseEnd` answers `null` for "nothing to do", which becomes an
 * accepted decision appending zero events — the transaction still opens, takes
 * the lock and commits, which is what makes the read it did a consistent one.
 * Every failure it can reach is a bug and arrives as a throw (AD-1), which
 * rolls back with nothing appended.
 */
export async function evaluateLeagueClock(gateway: ConnectionGateway): Promise<PhaseEndOutcome> {
	const outcome = await runTransactionalWrite<PhaseEndState>({
		gateway,
		// Story 5.2 broadcasts this write: `ContractAssignmentOpened` ends the
		// phase for everyone. Note it carries a NULL `team_id` — a broadcast is
		// not keyed on a Team, which is exactly why `enqueueIntents` (which skips
		// a null Team) could not have been reused here.
		// `enqueueBroadcasts` files one channel-addressed intent per event in the
		// broadcast set. `eligibility.ts` and `import-promotion.ts` pass no
		// `enqueue` at all: Commissioner bookkeeping is not league news, and a
		// notice for it would be channel noise nothing can mute.
		//
		// Story 5.3 mentions EVERY Manager of every Team on the phase open, and
		// this is the one trigger where that is the honest answer: the phase
		// ends for the whole league at once, and until now the transition was
		// stated only to a Manager who happened to open the app
		// (`deferred-work.md`, from spec 3.7). `EVERY_TEAM` is resolved inside
		// the enqueue rather than enumerated here — this function runs on every
		// tick and appends nothing on almost all of them, and reading `teams`
		// in `load` would cost a full-table read 8,640 times a day.
		//
		// `AuctionTerminated` gets no mention: it carries no Team, it is one
		// row per unbid nomination, and the phase notice every Manager receives
		// already states how many there were.
		enqueue: enqueueBroadcastsAndMentions((event) =>
			event.type === CONTRACT_ASSIGNMENT_OPENED_EVENT ? [EVERY_TEAM] : []
		),
		load: (client) => loadPhaseEndState(client),
		projections: [releaseNomination],
		decide: ({ state, now }) => {
			// The database's transaction-start instant, never `Date.now()`
			// (AD-3). It is the ONLY thing the core is handed beyond the folds.
			const decision = decidePhaseEnd(state, now.toISOString());
			// `null` is "the clock has not run out" or "the phase already
			// ended" — by far the common answer, and not a refusal. An accepted
			// decision with no events appends nothing and commits.
			if (decision === null) return { kind: 'accepted', events: [] };
			return decision;
		}
	});

	if (outcome.kind !== 'accepted') {
		// Unreachable: `decidePhaseEnd` has no `Rejected` half, so the pipeline
		// can only answer `accepted` here or throw. The guard exists to give
		// TypeScript the narrowing it cannot prove through the pipeline's own
		// union, not to handle a reachable state.
		return { ended: false, terminated: [], expiredAt: null, evaluatedAt: null };
	}

	// The two instants, off the payload that was actually appended and through
	// the core's own reader — so what the heartbeat states and what the log
	// records cannot diverge. `null` for every pass that ended nothing.
	const opened = outcome.events.find(
		(event) => event.type === CONTRACT_ASSIGNMENT_OPENED_EVENT
	);
	const instants = opened === undefined ? null : readPhaseEndInstants(opened.payload);

	// **Derived from what was actually appended**, not from what was decided.
	// The events came back off the `returning` clause of the inserts that
	// committed, so this reports the transaction's real effect rather than the
	// core's intention.
	return {
		ended: opened !== undefined,
		expiredAt: instants?.expiredAt ?? null,
		evaluatedAt: instants?.evaluatedAt ?? null,
		// Filtered on the TYPE first and then read through the core's own
		// reader — `releaseNomination` reads the identical pair, so what this
		// reports and what the claim delete acted on cannot diverge.
		terminated: outcome.events
			.filter((event) => event.type === AUCTION_TERMINATED_EVENT)
			.map((event) => readTerminatedPlayerId(event.payload))
			.filter((fantraxPlayerId): fantraxPlayerId is string => fantraxPlayerId !== null)
	};
}
