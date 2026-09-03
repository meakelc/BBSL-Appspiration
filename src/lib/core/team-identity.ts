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

/**
 * U+0026's spelled form, between two Managers of one co-managed Team.
 *
 * `server/auction-open.ts:99-110` records that two `managers` rows sharing one
 * `team_id` is co-management rather than an error, so a Team legitimately has
 * more than one Manager to name — and `epics.md:1569` and `EXPERIENCE.md:127`
 * both write **Manager(s)**. The separator is a constant for `EM_DASH`'s
 * reason: one definition, or two renderings drift.
 */
const MANAGER_SEPARATOR = ' & ';

/**
 * Format a Team with EVERY Manager acting for it: `Lakers — Meakel & Dana`.
 *
 * **It delegates for the single case rather than restating the pairing**, so
 * the em dash is still spelled exactly once in this repository and a Team with
 * one Manager renders through the identical expression every other surface
 * uses.
 *
 * An EMPTY list is the Team name alone. There is no Manager to pair it with,
 * and `formatTeamManager`'s own reasoning applies in the mirror: a trailing
 * em dash against a blank would read as a display bug rather than as "this
 * Team has no Manager bound yet", which is a real, supported state the
 * auction-open gate exists to name.
 *
 * Names are joined in the order supplied. The caller's order is a sequence it
 * decided (AD-5); re-sorting here would silently overrule it.
 */
export function formatTeamManagers(
	teamName: string | null,
	displayNames: readonly string[]
): string {
	const [first] = displayNames;
	if (first === undefined) return teamName ?? '';
	if (displayNames.length === 1) return formatTeamManager(teamName, first);
	return formatTeamManager(teamName, displayNames.join(MANAGER_SEPARATOR));
}

/**
 * The MANAGER HALF of that pairing alone — `` — Meakel & Dana `` — for a
 * surface that must set the two halves in two registers.
 *
 * `DESIGN.md:187` is explicit: every Team name sits in `text`, the viewer's
 * included, and the Manager name beside it takes `text-secondary`. And
 * `mockups/Teams.dc.html:40,62` draws exactly that — the Team in `text`, the
 * em dash and the Manager in `text-secondary`, inside one line. A single
 * joined string cannot carry two colours, so a surface handed only
 * `formatTeamManagers`' output must either render the pairing in one register
 * (losing the rule) or split the string by searching for the em dash, which
 * would put the naming convention's own punctuation into a `.svelte` file.
 *
 * So the core returns the half, and the em dash stays spelled exactly once:
 * this is `formatTeamManagers`' output with the Team name and its single
 * trailing space removed, derived rather than re-concatenated, so the two can
 * never disagree about the separator or the spacing.
 *
 * The empty string when there is no Manager to name — the mirror of
 * `formatTeamManager`'s omitted dash, and what lets a surface render it
 * unconditionally without emitting a stray dash against a blank.
 */
export function teamManagerSuffix(
	teamName: string | null,
	displayNames: readonly string[]
): string {
	if (displayNames.length === 0) return '';
	const full = formatTeamManagers(teamName, displayNames);
	if (teamName === null) return full;
	return full.slice(teamName.length);
}
