/**
 * One Team's page — its `load`, and nothing else (Story 4.5).
 *
 * `requireLiveDestination` FIRST, before any read, mirroring
 * `auction/[fantraxPlayerId]/+page.server.ts:80`. The `teams` destination is
 * live in the Auction, Contract Assignment and Archived phases
 * (`server/destinations.ts:79,87,94`) and not in Setup, so a request from
 * Setup receives the guard's 403 — and so does a non-registered session, whose
 * catalog is `[Sign-in]` alone in every phase. Hiding a link is never the
 * check.
 *
 * A `null` read is a 404, not an empty page: a Team view with nothing on it is
 * not "a Team with nothing", it is an id matching no Team at all. A Team that
 * genuinely holds no roster rows is a real state the core already words — Cap
 * Space exactly `SALARY_CAP`, Roster Count 0 — and reaches this route as an
 * ordinary answer.
 *
 * **The viewer's Team comes from the session and nothing else** (AD-4). It
 * decides exactly one thing: whether Maximum Bid is on the payload. A Team
 * named in a query parameter would let anyone read another Manager's.
 *
 * **There is no action here at all.** The route reads and rolls back.
 *
 * **`isCommissioner` decides one more thing** (Story 7.13): whether a won
 * Contract's row carries the dashed Reverse-this-Close link. It is a RENDER
 * decision only — `/close-reversal` refuses a non-Commissioner on `load` and
 * on the action whatever this page showed — and it is offered only in the two
 * phases a reversal is permitted in, so an Archived page shows no control the
 * route would refuse.
 */

import { error } from '@sveltejs/kit';

import { requireLiveDestination, resolveDestinations } from '$lib/server/destinations.ts';
import { loadTeamView } from '$lib/server/team-view.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { PageServerLoad } from './$types';

const TEAMS_DESTINATION_ID = 'teams';

/** The destination the won row's Commissioner control links to (Story 7.13). */
const CLOSE_REVERSAL_DESTINATION_ID = 'close-reversal';

/**
 * The viewing Team, from the session and nothing else (AD-4).
 *
 * `auction/[fantraxPlayerId]/+page.server.ts`'s `actorFrom`, in shape: `null`
 * for any session that is not a registered Manager bound to a Team. A viewer
 * bound to no Team still reads every Team in full — no page shows them a
 * Maximum Bid, because there is no Team for one to be about.
 */
function actorFrom(session: App.Locals['session']) {
	if (session.kind !== 'registered') return null;
	const { manager } = session;
	if (manager.teamId === null) return null;
	return { managerId: manager.id, teamId: manager.teamId };
}

export const load: PageServerLoad = async ({ locals, params }) => {
	requireLiveDestination(locals.session, locals.phase.name, TEAMS_DESTINATION_ID);

	const team = await loadTeamView(
		writeGateway(),
		params.teamId,
		actorFrom(locals.session)?.teamId ?? null
	);
	if (team === null) {
		error(404, 'There is no Team with that id.');
	}

	const isCommissioner =
		locals.session.kind === 'registered' && locals.session.manager.isCommissioner;

	return {
		phase: locals.phase,
		isCommissioner,
		// Asked of the ONE catalog rather than of a phase list here (AD-30):
		// the control shows exactly where `/close-reversal` is live for this
		// session — a Commissioner, in a phase that permits a reversal.
		canReverseCloses: resolveDestinations(locals.phase.name, locals.session).some(
			(entry) => entry.id === CLOSE_REVERSAL_DESTINATION_ID
		),
		// Every label and sentence on the page is already chosen by
		// `core/team-view.ts` — the surface prints them and words nothing
		// itself.
		team
	};
};
