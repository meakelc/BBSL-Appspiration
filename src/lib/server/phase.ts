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

/** The phase and the sentence that states it, together, so they cannot drift. */
export type ResolvedPhase = {
	readonly name: LeaguePhase;
	readonly sentence: string;
};

/** Pair a phase with its sentence. */
export function phaseOf(name: LeaguePhase): ResolvedPhase {
	return { name, sentence: PHASE_SENTENCES[name] };
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
	const events = await loadAppendedEvents(client);
	const phase = fold(INITIAL_PHASE, events, phaseReducer);
	return phaseOf(phase);
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
	try {
		return await resolveLeaguePhase(client ?? serviceRoleClient());
	} catch {
		return phaseOf('Setup');
	}
}
