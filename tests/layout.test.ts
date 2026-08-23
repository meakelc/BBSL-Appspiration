import { describe, expect, it } from 'vitest';

import { load } from '../src/routes/+layout.server.ts';
import { SIGN_IN_DESTINATION } from '../src/lib/server/destinations.ts';
import type { Destination } from '../src/lib/server/destinations.ts';
import type { ResolvedPhase } from '../src/lib/server/phase.ts';
import type { RegisteredManager, SessionState } from '../src/lib/server/auth.ts';

/**
 * `load`'s declared `LayoutServerLoad` type widens its return to
 * `void | (Partial<PageData> & ...)` — SvelteKit's generic shape before
 * `./$types` narrows it for `+layout.svelte`'s actual consumption. The
 * function's real body never returns void; this recovers that shape for the
 * assertions below rather than fighting the generic type at every call site.
 */
type LoadResult = { phase: ResolvedPhase; destinations: readonly Destination[] };

/**
 * `+layout.server.ts`'s `load`, asserting it returns `{ phase, destinations }`
 * built from `locals.phase`/`locals.session` — the one point every page's
 * `HeaderMenu` gets its list from.
 */

const SETUP_PHASE: ResolvedPhase = { name: 'Setup', sentence: 'Setup. ...' };
const AUCTION_PHASE: ResolvedPhase = { name: 'Auction', sentence: 'Auction. ...' };

const COMMISSIONER: RegisteredManager = {
	id: '00000000-0000-4000-8000-000000000002',
	discordUserId: '222222222222222220',
	displayName: 'Commissioner Bob',
	teamId: '00000000-0000-4000-8000-0000000000bb',
	teamName: 'Celtics',
	isCommissioner: true
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function layoutEvent(phase: ResolvedPhase, session: SessionState): any {
	return { locals: { phase, session } };
}

describe('+layout.server.ts load', () => {
	it('returns the phase straight from locals.phase, unmodified', () => {
		const result = load(layoutEvent(AUCTION_PHASE, { kind: 'signed-out' })) as LoadResult;
		expect(result.phase).toBe(AUCTION_PHASE);
	});

	it('resolves destinations from locals.phase.name and locals.session, via resolveDestinations', () => {
		const result = load(layoutEvent(SETUP_PHASE, { kind: 'signed-out' })) as LoadResult;
		expect(result.destinations).toEqual([SIGN_IN_DESTINATION]);
	});

	it('a registered Commissioner in Setup gets the Commissioner-only Setup catalog', () => {
		const result = load(
			layoutEvent(SETUP_PHASE, { kind: 'registered', manager: COMMISSIONER })
		) as LoadResult;
		expect(result.destinations.map((d) => d.id)).toEqual([
			'import',
			'minor-league-eligibility',
			'manager-registration',
			'auction-open-gate'
		]);
	});

	it('changing only locals.phase changes the returned destinations, with the same session', () => {
		const session: SessionState = { kind: 'registered', manager: COMMISSIONER };
		const setupResult = load(layoutEvent(SETUP_PHASE, session)) as LoadResult;
		const auctionResult = load(layoutEvent(AUCTION_PHASE, session)) as LoadResult;
		expect(setupResult.destinations).not.toEqual(auctionResult.destinations);
	});
});
