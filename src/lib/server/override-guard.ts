/**
 * The reusable Commissioner-override guard. Server-only (Story 7.1).
 *
 * Mirrors `commissioner-guard.ts` exactly, including its zero-call-site
 * shape: **no override route, control or event exists yet.** The first lands
 * in Story 7.2, and it adds a route rather than inventing a guard under
 * deadline. This module is unit-tested against synthetic form data and
 * synthetic phases, which is where the two refusals below are proven.
 *
 * **Two refusals, because there are two different facts.**
 *
 *   1. `requireOverrideReason` — the submission carried no reason, or a
 *      whitespace-only one. This is the server-side half of "no Commissioner
 *      act is ever a single tap": the sheet is what makes the reason easy to
 *      give, and this is what makes it impossible to skip. A hidden control,
 *      a disabled button and a `required` attribute are each a courtesy; only
 *      this refusal is the check.
 *   2. `requireOverridablePhase` — the League is Archived. This is NOT
 *      covered by `requireLiveDestination`: `destinations.ts:126-131` lists
 *      `/board` and `/teams` as live in Archived, so an override control
 *      placed in place on one of those pages passes that gate. The archived
 *      refusal is therefore its own gate, and its own wording.
 *
 * **Both are worded distinctly from `COMMISSIONER_ONLY_REFUSAL`**, and from
 * each other. A Commissioner who is refused wants to know which of the three
 * facts stopped them; "forbidden" three times over is not an answer.
 * `tests/server/override-guard.test.ts` asserts the distinctness rather than
 * trusting it.
 *
 * **Placement is a convention, not code here.** "In place, on the object
 * acted on", and global acts get an admin destination — those admin
 * destinations already exist in `destinations.ts`. The rule binds the
 * stories that add controls; this module asserts nothing about controls that
 * do not exist yet.
 *
 * **The Commissioner's own Team gets nothing from this file.** It reaches
 * every function here through the identical shapes any other Manager's would,
 * and no override in this epic gives it a different Cap Space, Maximum Bid or
 * Nomination Slot.
 */

import { error } from '@sveltejs/kit';

import type { LeaguePhase } from '../core/projection/phase.ts';
import { OVERRIDE_REASON_FIELD, validateReason } from '../core/rules/override.ts';

/**
 * The refusal a reasonless override submission receives.
 *
 * States the requirement and nothing else — it is not a scolding, and it does
 * not distinguish an absent field from a whitespace-only one, because the
 * Commissioner who typed three spaces and the one whose form lost the field
 * both need the same next action.
 */
export const OVERRIDE_REASON_REQUIRED_REFUSAL =
	'An override records why it happened. Enter a reason before committing.';

/**
 * The status a reasonless submission receives.
 *
 * 400, not 403: the caller is permitted to act and their submission was
 * incomplete. The Commissioner-only refusal is the one that is about
 * permission, and it keeps 403.
 */
export const OVERRIDE_REASON_REQUIRED_STATUS = 400;

/**
 * The refusal every override attempt receives once the League is Archived.
 *
 * Worded around the record rather than around permission: the Commissioner
 * still *is* the Commissioner in Archived, and no amount of re-authenticating
 * will change the answer. What has changed is that the season's log is closed.
 */
export const OVERRIDE_ARCHIVED_REFUSAL =
	'This League is archived. Its record is closed, and no override can change it now.';

/**
 * The status an archived override attempt receives.
 *
 * 403, matching `LIVE_DESTINATION_REFUSAL_STATUS`: like that gate this is a
 * phase-shaped refusal of a well-formed request, and the caller cannot fix it
 * by resubmitting.
 */
export const OVERRIDE_ARCHIVED_STATUS = 403;

/**
 * The minimum of `FormData` this guard reads.
 *
 * Declared structurally so a test can drive the guard without constructing a
 * `Request`, and so the guard cannot quietly start reading anything else off
 * a form. `FormData` satisfies it.
 */
export type SubmittedForm = { readonly get: (name: string) => unknown };

/**
 * Refuse a submission unless it carries a non-blank reason; return the
 * trimmed reason otherwise.
 *
 * Throws SvelteKit's `error(400, ...)` for an absent field, a non-string
 * field, and a field of whitespace alike. The validation itself is the pure
 * core's (`core/rules/override.ts`) — this function is the shell's half:
 * where the value comes from, and what happens when it is not there.
 */
export function requireOverrideReason(form: SubmittedForm): string {
	const outcome = validateReason(form.get(OVERRIDE_REASON_FIELD));
	if (outcome.ok) return outcome.reason;
	error(OVERRIDE_REASON_REQUIRED_STATUS, OVERRIDE_REASON_REQUIRED_REFUSAL);
}

/**
 * Refuse any override once the League is Archived.
 *
 * Every other phase passes, Setup included. Setup is not carved out here
 * because an override in Setup is not a phase problem: there is nothing to
 * override yet, so the override's own preconditions refuse it, and inventing
 * a second Setup refusal in this guard would put the same fact in two places
 * that could disagree. Archived is different in kind — there is plenty to
 * override, and the answer is still no.
 */
export function requireOverridablePhase(phase: LeaguePhase): void {
	if (phase !== 'Archived') return;
	error(OVERRIDE_ARCHIVED_STATUS, OVERRIDE_ARCHIVED_REFUSAL);
}
