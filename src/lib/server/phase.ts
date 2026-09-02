/**
 * The League phase, resolved server-side. Server-only.
 *
 * AD-24: phase is a projection folded from the event log, never a hand-set
 * flag, and with no events it folds to Setup. `resolveLeaguePhase` folds
 * `INITIAL_PHASE` over the *entire* `auction_events` log, ordered by `seq`
 * (AD-5), via the pure `phaseReducer` — the log and the fold are Story 1.5's
 * machinery, this module is what wires them to "the current phase".
 *
 * It exists as a module rather than as a sentence typed into two `.svelte`
 * files because every sign-in surface must state the phase from the same
 * server-resolved source as every other surface. Two copies of a sentence are
 * two sources, and they drift the first time one is edited.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { fold } from '../core/projection/fold.ts';
import { INITIAL_PHASE, phaseReducer } from '../core/projection/phase.ts';
import { INITIAL_WATERMARK, watermarkReducer } from '../core/projection/watermark.ts';
import { loadAppendedEvents } from './event-log.ts';
import { serviceRoleClient } from './supabase.ts';

/** The four phases, verbatim from the glossary. A synonym is a defect. */
export type LeaguePhase = 'Setup' | 'Auction' | 'Contract Assignment' | 'Archived';

/**
 * One sentence per phase, in the product voice: state the fact, then the
 * arithmetic. No apologies, no exclamation marks, no advice.
 */
export const PHASE_SENTENCES: Readonly<Record<LeaguePhase, string>> = Object.freeze({
	Setup:
		"Setup. The league's data is not yet imported and the auction is not open. Phase is folded from the event log, and with no events it folds to Setup.",
	Auction: 'Auction. Nominations and bidding are open.',
	'Contract Assignment': 'Contract Assignment. Bidding is closed and contracts are being assigned.',
	Archived: 'Archived. This offseason is closed and the record is read-only.'
});

/**
 * The transition announcement for a phase, or `null` for a phase that is not
 * one anybody arrives into (Story 3.7).
 *
 * **A standing statement, not a live one, and not the ambient sentence.**
 * `PHASE_SENTENCES` above says what the phase IS and has been printed in the
 * header on every page since Story 1.4; this says that it CHANGED. The two are
 * different claims and are worded separately so neither has to carry the
 * other's job.
 *
 * Only Contract Assignment carries one, and deliberately. `Setup` is where a
 * league begins rather than a place it arrives at; `Auction` opens by a
 * Commissioner's own deliberate act on a page they are already looking at; and
 * `Archived` is Epic 7's to word when it exists. Contract Assignment is the
 * one phase a Manager can find the league in without anyone having told them,
 * because the tick moved it there while nobody was watching — which is exactly
 * what makes the announcement worth rendering.
 */
export type PhaseAnnouncement = {
	/** The heading, naming the transition. */
	readonly heading: string;
	/** What it means for the Manager reading it, in the product voice. */
	readonly body: string;
};

/**
 * One announcement per phase, or `null` — worded HERE for `PHASE_SENTENCES`'
 * reason: two copies of a sentence are two sources, and they drift the first
 * time one is edited. No `.svelte` file words any of this.
 *
 * The Contract Assignment wording states the fact, then what changed, then
 * what the reader can still do. No apology, no exclamation mark, no advice
 * beyond naming what happens next (`EXPERIENCE.md`). It does not say when the
 * clock expired: the announcement is read for weeks after the transition, and
 * a relative time on a standing statement would go stale the moment it was
 * true.
 */
export const PHASE_ANNOUNCEMENTS: Readonly<Record<LeaguePhase, PhaseAnnouncement | null>> =
	Object.freeze({
		Setup: null,
		Auction: null,
		'Contract Assignment': Object.freeze({
			heading: 'The Auction Phase has ended',
			body:
				'The League Clock ran out and Contract Assignment has begun. No further Bids or ' +
				'nominations are accepted, and any Player still awaiting an Opening Bid when the ' +
				'clock expired has returned to the Free Agent pool along with the nominating ' +
				'Team’s Nomination Slot. Every Auction that was won still stands.'
		}),
		Archived: null
	});

/**
 * The phase, the sentence that states it and the announcement that it
 * changed, together, so they cannot drift.
 */
export type ResolvedPhase = {
	readonly name: LeaguePhase;
	readonly sentence: string;
	/** The transition announcement, or `null` for a phase that has none. */
	readonly announcement: PhaseAnnouncement | null;
};

/**
 * What one read of the event log resolves: the phase, and the global watermark
 * that read was folded to (AD-29).
 *
 * They ride together because they come from ONE array of events. A watermark
 * resolved separately from the phase would be a second read of the log and
 * therefore a second answer, and the whole of AD-29 is that there is one.
 */
export type ResolvedLeagueRead = {
	readonly phase: ResolvedPhase;
	/** The highest `auction_events.seq` folded. `'0'` for an empty log. */
	readonly watermark: string;
};

/** Pair a phase with its sentence and its announcement. */
export function phaseOf(name: LeaguePhase): ResolvedPhase {
	return { name, sentence: PHASE_SENTENCES[name], announcement: PHASE_ANNOUNCEMENTS[name] };
}

/**
 * Resolve the current phase from the full event log.
 *
 * Throws on a read failure — this is the raw, undefaulted half of the pair.
 * `hooks.server.ts` never calls this directly; it calls
 * `resolveLeaguePhaseOrDefault` below, which fails closed. This function
 * stays exported, throwing, for any caller — a test, or a future admin
 * surface — that wants the raw failure rather than a defaulted answer.
 *
 * `client` is injectable, same shape as `managerRegistry(client =
 * serviceRoleClient())`, so a test drives it against a fake without a live
 * database.
 */
export async function resolveLeaguePhase(
	client: SupabaseClient = serviceRoleClient()
): Promise<ResolvedPhase> {
	return (await resolveLeagueRead(client)).phase;
}

/**
 * The phase and the global watermark, folded from ONE read of the log
 * (Story 4.1, AD-29).
 *
 * **One read, two folds, one watermark.** `hooks.server.ts` already folded the
 * whole log once per request to resolve the phase; the highest `seq` is
 * available in that same array for the cost of a second `fold()` over events
 * already in memory. Reading the log twice, or issuing a separate
 * `select max(seq)` beside it, would be two sources for a number AD-29 requires
 * to have one — and they could disagree by whatever committed between them.
 *
 * The two folds are deliberately not merged into one pass. `fold()` is the
 * function AD-5 fixes as "the fold", each reducer is pure and independently
 * testable, and a hand-written loop accumulating both would be a third
 * traversal implementation living in the shell.
 */
export async function resolveLeagueRead(
	client: SupabaseClient = serviceRoleClient()
): Promise<ResolvedLeagueRead> {
	const events = await loadAppendedEvents(client);
	return {
		phase: phaseOf(fold(INITIAL_PHASE, events, phaseReducer)),
		watermark: fold(INITIAL_WATERMARK, events, watermarkReducer)
	};
}

/**
 * Resolve the current phase, failing closed to Setup on any read failure.
 *
 * `Setup` is the same value an empty log already produces, so failing
 * closed to it on a read error is not a new behaviour to reason about — it
 * is the existing "no confirmed phase progression" answer, applied
 * uniformly whether the log is genuinely empty or merely unreachable right
 * now. `hooks.server.ts` calls this and never sees the throw, which keeps
 * Sign-in and the Commissioner break-glass path reachable through a
 * transient database outage rather than 500ing every request.
 *
 * This is split out from `hooks.server.ts` specifically so it is testable:
 * that file reads `$env/dynamic/private` at import time, which the test
 * suite cannot load (see its own module header), so a `try`/`catch` written
 * inline there could never be exercised by a test.
 *
 * `client` takes no default value on the parameter itself — a default
 * parameter expression runs before this function's own body, so a throwing
 * `serviceRoleClient()` there would reject before the `try` below ever ran,
 * defeating the whole point of this wrapper. Building the client inside the
 * `try`, via `??`, is what actually covers a missing or misconfigured
 * required server-only variable — the single most likely real failure this
 * function exists to catch, not just a network blip.
 */
export async function resolveLeaguePhaseOrDefault(
	client?: SupabaseClient
): Promise<ResolvedPhase> {
	return (await resolveLeagueReadOrDefault(client)).phase;
}

/**
 * The phase and the watermark together, failing closed on any read failure.
 *
 * The phase half fails closed to `Setup` for the reason
 * `resolveLeaguePhaseOrDefault` states above. The watermark half fails closed
 * to `INITIAL_WATERMARK` — `'0'` — which is the same value an empty log
 * produces and is a value no row can hold, so a surface can never mistake a
 * failed read for a real height. It cannot make a page look FRESHER than it is:
 * `'0'` is lower than every real `seq`, so the first successful liveness
 * re-read raises it and reloads, rather than the other way round.
 *
 * `client` takes no default parameter here for the reason spelled out above: a
 * default-parameter expression runs before this function's body, so a throwing
 * `serviceRoleClient()` there would reject before the `try` ever ran.
 */
export async function resolveLeagueReadOrDefault(
	client?: SupabaseClient
): Promise<ResolvedLeagueRead> {
	try {
		return await resolveLeagueRead(client ?? serviceRoleClient());
	} catch {
		return { phase: phaseOf('Setup'), watermark: INITIAL_WATERMARK };
	}
}
