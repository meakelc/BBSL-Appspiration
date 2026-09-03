/**
 * The Teams index page — its `load`, and nothing else (Story 4.6).
 *
 * `requireLiveDestination` FIRST, before any read, copying
 * `teams/[teamId]/+page.server.ts:51`. The `teams` destination is live in the
 * Auction, Contract Assignment and Archived phases
 * (`server/destinations.ts:79,87,94`) and not in Setup, so a request from Setup
 * receives the guard's 403 — and so does a non-registered session, whose
 * catalog is `[Sign-in]` alone in every phase. Hiding a link is never the
 * check.
 *
 * **There is no 404 here.** A League with no Teams is a real state and the
 * core words it as a designed empty screen; `loadTeamsIndex` returns an empty
 * answer rather than `null`, which is the difference between "nothing to list"
 * and "no such thing".
 *
 * **The viewer's Team comes from the session and nothing else** (AD-4). It
 * decides exactly one thing: which row carries the own-row marker. It changes
 * no figure and moves no row.
 *
 * **There is no action here at all.** The route reads and rolls back.
 */

import { requireLiveDestination } from '$lib/server/destinations.ts';
import { loadTeamsIndex } from '$lib/server/teams-index.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { PageServerLoad } from './$types';

const TEAMS_DESTINATION_ID = 'teams';

/**
 * The viewing Team, from the session and nothing else (AD-4).
 *
 * `teams/[teamId]/+page.server.ts:43`'s `actorFrom`: `null` for any session
 * that is not a registered Manager bound to a Team. A viewer bound to no Team
 * reads thirty ordinary rows with no marker anywhere, and an identical median.
 */
function actorFrom(session: App.Locals['session']) {
	if (session.kind !== 'registered') return null;
	const { manager } = session;
	if (manager.teamId === null) return null;
	return { managerId: manager.id, teamId: manager.teamId };
}

export const load: PageServerLoad = async ({ locals }) => {
	requireLiveDestination(locals.session, locals.phase.name, TEAMS_DESTINATION_ID);

	const index = await loadTeamsIndex(writeGateway(), actorFrom(locals.session)?.teamId ?? null);

	return {
		phase: locals.phase,
		// Every label, sentence and ordering on the page is already chosen by
		// `core/teams-index.ts` — the surface prints them and words nothing
		// itself.
		index
	};
};
