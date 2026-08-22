/**
 * The Team display formatter (AD's naming convention).
 *
 * Glossary rule: a three-letter capitalised abbreviation always and only
 * means a player's real-life NBA team; a fantasy Team is spelled out with the
 * acting Manager attached, never abbreviated. This is the one place that
 * pairing is rendered, so every surface that displays a Team — the strip
 * sheet, the header, an event line — reads the identical string.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2). It sits
 * beside `money.ts` as the other structurally-pure renderer.
 */

/** U+2014 EM DASH. Not a hyphen — matches the convention money.ts sets for
 *  the minus sign: the exact character is part of the contract, not a detail
 *  an editor may normalise away. */
const EM_DASH = '—';

/**
 * Format a Team for display: `Lakers — Meakel`.
 *
 * `teamName` is `string | null` because `RegisteredManager.teamName` is: a
 * Manager with no Team yet is a real, supported state (a nullable
 * `managers.team_id`, staged onboarding), not an error. When `teamName` is
 * `null` there is no Team to pair the Manager with, so the em dash is
 * omitted entirely rather than rendered against a blank — `Meakel` reads as
 * "not yet on a Team"; `— Meakel` would read as a display bug.
 *
 * Neither non-null argument is trimmed or otherwise reshaped — both are
 * taken exactly as the caller supplies them, because trimming here would let
 * a blank or whitespace-only name pass silently instead of surfacing as the
 * caller's bug. Concatenation, not interpolation logic: the em dash, when
 * present, is always surrounded by exactly one space on each side.
 */
export function formatTeamManager(teamName: string | null, managerDisplayName: string): string {
	if (teamName === null) return managerDisplayName;
	return `${teamName} ${EM_DASH} ${managerDisplayName}`;
}
