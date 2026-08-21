// See https://svelte.dev/docs/kit/types#app
//
// Locals are populated server-side only, once per request, by
// `src/hooks.server.ts`. No surface resolves identity for itself.
//
// Story 1.3 establishes the session state, the break-glass marker and the
// server-resolved phase. Story 1.4 adds the Team binding and the Commissioner
// flag — both of which resolve from application tables the Commissioner alone
// writes, never from auth metadata or any client-influenceable claim (AD-15).

import type { SessionState } from './lib/server/auth.ts';
import type { ResolvedPhase } from './lib/server/phase.ts';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/**
			 * The one session resolution for this request: signed-out, registered,
			 * unregistered, expired, or Discord unavailable. Never recomputed
			 * per surface.
			 */
			session: SessionState;
			/**
			 * Whether this request carries a valid Commissioner break-glass cookie
			 * (AD-27). Independent of Supabase Auth and of Discord — it is what
			 * keeps the pause control reachable when Discord is what failed.
			 */
			breakGlass: boolean;
			/**
			 * The League phase, folded server-side. Every surface — sign-in
			 * included — states it from this one source.
			 */
			phase: ResolvedPhase;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
