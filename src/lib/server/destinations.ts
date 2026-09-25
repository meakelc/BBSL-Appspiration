/**
 * The one destination catalog, gated by phase and role (AD-30). Server-only.
 *
 * `resolveDestinations` is the single function both the header menu and,
 * later, the persistent strip's sheet call — there is no second
 * implementation (AR-29/UX-DR19: one destination list, rendered twice, that
 * can never offer different sets). Every entry not live for the resolved
 * phase and role is simply absent from the returned array; nothing here
 * disables an entry instead of omitting it.
 *
 * The table below is copied verbatim from `EXPERIENCE.md`'s Information
 * Architecture table and epics.md's Story 1.6 acceptance criteria — this
 * module is the one place either is transcribed into code.
 *
 * Setup's Import, Minor League Eligibility, Manager registration and the
 * auction-open gate are Commissioner-only: `EXPERIENCE.md`'s "genuinely
 * global acts" list names exactly this kind of administrative action, the
 * same category Auction's three roster acts, and Contract Assignment's
 * assignment monitoring and export gate, already sit in.
 *
 * **Pause/Resume and Operational health are NOT in the table below**, though
 * `EXPERIENCE.md` lists them. Both were catalog rows with no route behind
 * them — a menu entry that 404s is worse than an absent one — so they were
 * removed on 2026-09-12 until Story 7.4 and Epic 8 build the surfaces. Add
 * each row back in the same change that adds its route.
 * Archived carries no Commissioner split — re-downloading the Export is for
 * every Manager, not an administrative act.
 *
 * A non-registered session — signed-out, unregistered, expired, or
 * Discord-unavailable alike — gets exactly `[Sign-in]`, in every phase. A
 * registered session, Commissioner or not, never sees Sign-in in its own
 * list: a signed-in Manager has no use for a link back to the surface they
 * are past.
 *
 * "Manager registration" is a stub catalog entry with no route behind it in
 * this story — logged in `deferred-work.md`, the same treatment Import,
 * Minor League Eligibility and the auction-open gate get from the stories
 * that build their routes (1.7-1.11).
 */

import { error } from '@sveltejs/kit';

import type { SessionState } from './auth.ts';
import type { LeaguePhase } from './phase.ts';

/** One entry in a destination list. */
export type Destination = {
	readonly id: string;
	readonly label: string;
	readonly href: string;
	readonly commissionerOnly: boolean;
	/**
	 * Whether this entry is RENDERED as a row in the destinations list.
	 *
	 * Every entry in this catalog is a permission — `requireLiveDestination`
	 * answers "may this viewer reach this destination in this phase" out of
	 * exactly this table, and routes call it before any read. Most permissions
	 * also have a menu row, and for those the two are the same thing.
	 *
	 * `auction` is the one that is not. It gates
	 * `routes/auction/[fantraxPlayerId]` on both the load and the bid action,
	 * so it MUST stay in the catalog — dropping it refuses every Auction and
	 * every Bid for everybody. But it has no page of its own to link to: the
	 * Auction surface is per-Player, reached from a Discord notification
	 * landing on the specific Auction (`EXPERIENCE.md:223`) or from the Bid
	 * Board, which "is one tap away and opens unfiltered" (`:50`) and links
	 * every card through `auctionPathFor`. The href `/auction` was
	 * transcribed from `EXPERIENCE.md:31`'s IA row by Story 1.6 and never had
	 * a route behind it, so the menu offered a 404 beside the Bid Board that
	 * is already the index.
	 *
	 * Splitting the two is what lets the permission stay while the dead row
	 * goes. The filter is `classifyDestinations`' in `lib/destinations-view.ts`
	 * — the view layer decides what renders, and this module keeps answering
	 * only what is live.
	 */
	readonly listed: boolean;
};

/**
 * Build one catalog entry, frozen individually so nothing can mutate it in
 * place. `listed` defaults to `true`, because a permission with no menu row
 * is the exception and should have to say so at its own call site.
 */
function destination(
	id: string,
	label: string,
	href: string,
	commissionerOnly: boolean,
	listed = true
): Destination {
	return Object.freeze({ id, label, href, commissionerOnly, listed });
}

/** A non-registered viewer's entire destination list, in every phase. */
export const SIGN_IN_DESTINATION: Destination = destination('sign-in', 'Sign-in', '/signin', false);

/** One literal table per phase, copied verbatim from the Information Architecture table. */
const CATALOG: Readonly<Record<LeaguePhase, readonly Destination[]>> = Object.freeze({
	Setup: [
		destination('import', 'Import', '/import', true),
		destination(
			'minor-league-eligibility',
			'Minor League Eligibility',
			'/minor-league-eligibility',
			true
		),
		destination('manager-registration', 'Manager registration', '/manager-registration', true),
		destination('auction-open-gate', 'Auction-open gate', '/auction-open', true)
	],
	Auction: [
		destination('your-positions', 'Your Positions', '/positions', false),
		destination('bid-board', 'Bid Board', '/board', false),
		// Not listed: a permission, not a menu row. `/auction` has no page —
		// only `/auction/[fantraxPlayerId]` does, and the Bid Board above is
		// the index that reaches it. See `Destination.listed`.
		destination('auction', 'Auction', '/auction', false, false),
		destination('nominate', 'Nominate', '/nominate', false),
		destination('teams', 'Teams', '/teams', false),
		destination('audit-log', 'Audit Log', '/audit-log', false),
		// Not listed: a permission, not a menu row. The surface holds a single
		// control — the nomination-slot notification toggle — which does not earn
		// a standing row beside the Bid Board and Nominate. The permission stays so
		// the route keeps working, but NOTHING links to it now — it is reachable by
		// URL alone, which is deliberate while the nomination-slot category's future
		// is open. Restore the row by dropping the trailing `false`.
		destination('notification-settings', 'Notification settings', '/notifications', false, false),
		// FR-44 correction path: live in the Auction and Contract Assignment
		// lists as well as Setup, Commissioner-only in all three. The surface
		// lists only ROSTERED Contracts outside Setup and says why, because
		// that is the only half `refuseEligibilityChange` accepts there — a
		// pooled Player's flag is an FR-35 input to an open Auction's cap
		// arithmetic, and a rostered Contract's cannot be, since
		// `teamMoneyStateFor` partitions `auctions.byPlayer` alone.
		destination(
			'minor-league-eligibility',
			'Minor League Eligibility',
			'/minor-league-eligibility',
			true
		),
		// The three roster acts, all Commissioner-only, all live in the two
		// phases FR-41 and FR-44 permit — this list and the Contract Assignment
		// one below — and all deliberately absent from `Archived`, where
		// `requireOverridablePhase` refuses them a second time.
		//
		// **The Move is Commissioner-only by OPERATOR DECISION, not by FR-44.**
		// FR-44 gives a Manager the Move on their own Team, and Story 7.11 built
		// that half: the session-resolved Team, the solid reasonless
		// `ManagerSheet`, and the route branch behind them are all still here and
		// still tested. Flipping this flag is what takes it away, because
		// `requireLiveDestination` resolves through the same filter — so a
		// Manager is refused server-side on `load` and on the action, not merely
		// shown no menu row. Re-enable by setting this one argument to `false` in
		// BOTH phase lists; nothing else has to change. See `deferred-work.md`.
		destination('roster-move', 'Roster Move', '/roster-move', true),
		// Story 7.7: recording a trade the League agreed elsewhere.
		destination('roster-trade', 'Trade', '/roster-trade', true),
		// Story 7.8: recording a release the Team made in Fantrax.
		destination('roster-drop', 'Drop', '/roster-drop', true),
		// Story 7.13: reversing a Close that should not have stood. NOT listed
		// — the control lives in place, on the won Contract's row on the Team
		// page — but registered, or `requireLiveDestination` refuses the
		// route. Absent from Archived, so `requireLiveDestination` refuses it
		// there (403) before the route's `requireOverridablePhase` is reached.
		destination('close-reversal', 'Reverse a Close', '/close-reversal', true, false),
		// Story 7.14: reinstating a Bid an FR-40 cancellation should not have
		// withdrawn. NOT listed — the control lives in place, on the cancelled
		// row of the Auction page's Bid history — but registered, or
		// `requireLiveDestination` refuses the route. Auction Phase ONLY: a
		// reinstated Bid must still be able to close, which needs the sweep.
		destination('bid-reinstatement', 'Reinstate a Bid', '/bid-reinstatement', true, false),
		// Story 7.9: the surface that says an act above is NEEDED. Live in the
		// same two phases the acts it proposes into are live in, and absent from
		// Archived for the same reason they are — `requireOverridablePhase`
		// refuses it a second time there.
		destination('divergence', 'Fantrax divergence', '/divergence', true)
	],
	'Contract Assignment': [
		destination('contract-assignment', 'Contract Assignment', '/contract-assignment', false),
		destination('teams', 'Teams', '/teams', false),
		destination('audit-log', 'Audit Log', '/audit-log', false),
		// FR-44 correction path: live in the Auction and Contract Assignment
		// lists as well as Setup, Commissioner-only in all three. The surface
		// lists only ROSTERED Contracts outside Setup and says why, because
		// that is the only half `refuseEligibilityChange` accepts there — a
		// pooled Player's flag is an FR-35 input to an open Auction's cap
		// arithmetic, and a rostered Contract's cannot be, since
		// `teamMoneyStateFor` partitions `auctions.byPlayer` alone.
		destination(
			'minor-league-eligibility',
			'Minor League Eligibility',
			'/minor-league-eligibility',
			true
		),
		// The same three acts, on the same terms as the Auction list above —
		// including the Move's operator-decision Commissioner flag.
		destination('roster-move', 'Roster Move', '/roster-move', true),
		destination('roster-trade', 'Trade', '/roster-trade', true),
		destination('roster-drop', 'Drop', '/roster-drop', true),
		// Story 7.13, on the same terms as the Auction list above. FR-32
		// permits a reversal in Contract Assignment; the sheet warns what it
		// costs there.
		destination('close-reversal', 'Reverse a Close', '/close-reversal', true, false),
		destination('assignment-monitoring', 'Assignment monitoring', '/assignment-monitoring', true),
		destination('export-gate', 'Export gate', '/export-gate', true),
		// Story 7.9, on the same terms as the Auction list above.
		destination('divergence', 'Fantrax divergence', '/divergence', true)
	],
	Archived: [
		destination('bid-board', 'Bid Board', '/board', false),
		destination('teams', 'Teams', '/teams', false),
		destination('audit-log', 'Audit Log', '/audit-log', false),
		destination('export', 'Export', '/export', false)
	]
});

/**
 * Resolve the one destination list for a request's phase and session.
 *
 * A non-registered session gets exactly `[Sign-in]`, regardless of phase. A
 * registered session gets its phase's catalog, filtered to the
 * Commissioner-only entries only when `session.manager.isCommissioner`.
 */
export function resolveDestinations(
	phase: LeaguePhase,
	session: SessionState
): readonly Destination[] {
	if (session.kind !== 'registered') return [SIGN_IN_DESTINATION];

	const isCommissioner = session.manager.isCommissioner;
	return CATALOG[phase].filter((entry) => isCommissioner || !entry.commissionerOnly);
}

/**
 * The refusal a `requireLiveDestination` call receives for a destination
 * absent from the resolved phase/role's set. Deliberately silent on *which*
 * of phase or role is the cause — a caller cannot always know, and naming
 * "the current phase" is demonstrably false wording for a role-caused
 * refusal in the correct phase.
 */
export const LIVE_DESTINATION_REFUSAL = 'This destination is not live for you right now.';

/** The status every refused caller receives. */
export const LIVE_DESTINATION_REFUSAL_STATUS = 403;

/**
 * Refuse a request for `destinationId` unless it is present in the caller's
 * resolved list for `phase`. Mirrors `commissioner-guard.ts`'s zero-call-site
 * precedent: no route calls this yet — only Sign-in exists today and it is
 * not phase-gated — but any future route can refuse server-side through it,
 * independently of whether any nav renders the destination.
 */
export function requireLiveDestination(
	session: SessionState,
	phase: LeaguePhase,
	destinationId: string
): void {
	const live = resolveDestinations(phase, session).some((entry) => entry.id === destinationId);
	if (live) return;
	error(LIVE_DESTINATION_REFUSAL_STATUS, LIVE_DESTINATION_REFUSAL);
}
