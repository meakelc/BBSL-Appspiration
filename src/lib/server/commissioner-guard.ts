/**
 * The reusable Commissioner-only guard. Server-only.
 *
 * AD-15: the Commissioner flag resolves only from `managers.is_commissioner`,
 * read server-side through the registry (`managerRegistry` in
 * `supabase.ts`) and carried on `SessionState.registered.manager` — never
 * from `user_metadata`, `app_metadata`, or any other client-influenceable
 * claim. `requireCommissioner` checks exactly that `SessionState`: a route
 * gated by *only* Supabase-Auth Commissioner identity should call this
 * rather than re-deriving the check.
 *
 * **This guard checks `SessionState` only — it does not know about
 * break-glass.** Story 1.3's break-glass Commissioner session (AD-27,
 * `locals.breakGlass`, verified from a signed cookie independent of Supabase
 * Auth so the pause control stays reachable when Discord is down) never
 * becomes a `registered` `SessionState`, so `requireCommissioner` can never
 * pass for a break-glass caller. A future route that must stay reachable via
 * *either* path — the pause control is the named example — needs to check
 * `locals.breakGlass` itself, in addition to (or instead of) calling this
 * guard; this function alone is not sufficient for that route.
 *
 * No Commissioner-only route ships in this story — the first lands in
 * 1.7-1.10. This guard is unit-tested against synthetic `SessionState`
 * values so those stories add a route rather than inventing a guard under
 * deadline.
 */

import { error } from '@sveltejs/kit';

import type { SessionState } from './auth.ts';

/** The refusal a non-Commissioner caller receives. States the fact, nothing else. */
export const COMMISSIONER_ONLY_REFUSAL = 'This route is Commissioner-only.';

/** The status every non-Commissioner caller receives. */
export const COMMISSIONER_ONLY_STATUS = 403;

/**
 * Refuse a request unless its session is a registered Manager whose
 * `managers` row carries `is_commissioner = true`.
 *
 * Throws SvelteKit's `error(403, ...)` for every other session kind —
 * signed-out, unregistered, expired, Discord-unavailable, and a registered
 * non-Commissioner Manager alike. The refusal happens here, server-side,
 * unconditionally: hiding a link or a button is never the check. The
 * Commissioner's own manager row reaches this function through the identical
 * `SessionState` shape as any other Manager's — there is no special case for
 * "the Commissioner" as an identity, only for the flag on their row.
 */
export function requireCommissioner(session: SessionState): void {
	if (session.kind === 'registered' && session.manager.isCommissioner) return;
	error(COMMISSIONER_ONLY_STATUS, COMMISSIONER_ONLY_REFUSAL);
}
