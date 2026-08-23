/**
 * One destination list for every page (AD-30).
 *
 * Phase and the viewer's role are already resolved once per request into
 * `locals` by `hooks.server.ts`; this load does nothing but pass them
 * through `resolveDestinations`, the single function both `HeaderMenu` here
 * and, later, the persistent strip's sheet (Story 4.2) call — there is no
 * second implementation.
 */

import { resolveDestinations } from '$lib/server/destinations.ts';

import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	return {
		phase: locals.phase,
		destinations: resolveDestinations(locals.phase.name, locals.session)
	};
};
