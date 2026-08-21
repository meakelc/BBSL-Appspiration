/**
 * The League phase, resolved server-side. Server-only.
 *
 * AD-24: phase is a projection folded from the event log, never a hand-set
 * flag, and with no events it folds to Setup. The log and the fold are Story
 * 1.5; this module is the *one place* the current phase and its sentence come
 * from until that story replaces the body of `resolveLeaguePhase`.
 *
 * It exists as a module rather than as a sentence typed into two `.svelte`
 * files because every sign-in surface must state the phase from the same
 * server-resolved source as every other surface. Two copies of a sentence are
 * two sources, and they drift the first time one is edited.
 */

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

/**
 * Resolve the current phase.
 *
 * Story 1.5 replaces the body with a fold over the event log by `seq`. The
 * return type does not change, so no caller has to. Until then, no events
 * exist, and no events folds to Setup — which is the correct answer, not a
 * placeholder.
 */
export function resolveLeaguePhase(): ResolvedPhase {
	return phaseOf('Setup');
}

/** Pair a phase with its sentence. */
export function phaseOf(name: LeaguePhase): ResolvedPhase {
	return { name, sentence: PHASE_SENTENCES[name] };
}
