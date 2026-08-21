/**
 * The skeleton page's server load.
 *
 * It exists for one reason: the Phase sentence this page shows and the one the
 * sign-in surface shows must be the same sentence from the same server-resolved
 * source. `hooks.server.ts` folds the phase once per request; every surface
 * reads it from `locals` and none of them types it out.
 */

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	return { phase: locals.phase };
};
