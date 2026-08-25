/**
 * The auction-open gate: the four refusals it can return, the one sentence
 * each of them has, and the pre-open report. Pure (Story 1.11).
 *
 * Three rules live here and nowhere else:
 *
 *   1. **Everything outstanding is NAMED, never counted.** A Commissioner at
 *      11:55 with thirty managers waiting cannot act on "3 sources
 *      outstanding"; they can act on "Lakers, Celtics and the Free Agent
 *      pool". epic-1-context.md's naming rule, applied to the last gate in
 *      the epic.
 *   2. **Promoted-ness is not staged-ness.** The gate asks the promotion
 *      fold (`projection/promotion.ts`) which Teams a promotion actually
 *      committed — never `import_team_sources.status`, which stays
 *      `'staged'` forever after a promotion and would let a fully staged,
 *      never promoted League open.
 *   3. **The eligibility count reports, it does not gate.** Zero Minor
 *      League Eligible Players is a legitimate state and opens normally; the
 *      report states the number in words so the Commissioner can confirm it
 *      is what they meant.
 *
 * `auctionOpenRefusalDetail` mirrors `eligibility.ts`'s
 * `eligibilityRefusalDetail` exactly: the route, the transaction and the
 * tests read ONE wording per refusal.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import type { LeaguePhase } from '../projection/phase.ts';
import type { PromotedSources } from '../projection/promotion.ts';
import { POOL_SOURCE_LABEL } from './pool-import.ts';

/**
 * One Team as the gate sees it: identity, the name every refusal uses, and
 * whether a Manager is bound to it.
 *
 * `hasManager` comes from `teams left join managers`, live, inside the
 * transaction — a Team whose Manager row was deleted between the page render
 * and the confirm is caught by the gate re-deriving it, not by the page.
 */
export type GateTeam = {
	readonly teamId: string;
	readonly teamName: string;
	readonly hasManager: boolean;
};

/** Everything the gate decides from, and the only thing the report prints. */
export type AuctionOpenState = {
	/** The phase, folded from the log inside the transaction. */
	readonly phase: LeaguePhase;
	/** Promoted-ness, folded from the latest `ImportPromoted` payload. */
	readonly promotion: PromotedSources;
	/** Every Team in the live table, with its Manager binding. */
	readonly teams: readonly GateTeam[];
	/** How many Players are Minor League Eligible. Reported, never gated on. */
	readonly eligibleCount: number;
};

/**
 * Why opening the auction was refused.
 *
 * Four of the six are re-derived INSIDE the transaction, from the log and
 * the live tables: `phase`, `not_promoted`, `outstanding_sources` and
 * `unbound_teams`. The other two are decided by the route before the
 * transaction opens — `unconfirmed`, because an unconfirmed submit has
 * nothing to decide about, and `unbound_actor`, because
 * `auction_events.manager_id`/`team_id` are NOT NULL (AD-4) so an unbound
 * actor has no event to append. All six are worded here anyway, so the route
 * never words a refusal itself.
 */
export type AuctionOpenRefusal =
	| { readonly kind: 'phase'; readonly phase: LeaguePhase }
	| { readonly kind: 'not_promoted' }
	| { readonly kind: 'no_teams' }
	| { readonly kind: 'outstanding_sources'; readonly sourceNames: readonly string[] }
	| { readonly kind: 'unbound_teams'; readonly teamNames: readonly string[] }
	| { readonly kind: 'unconfirmed' }
	| { readonly kind: 'unrecorded' }
	| { readonly kind: 'unbound_actor' };

/** "a, b and c" — the list form every refusal sentence names its items in. */
function nameList(names: readonly string[]): string {
	if (names.length === 0) return '';
	if (names.length === 1) return names[0] ?? '';
	const head = names.slice(0, -1).join(', ');
	return `${head} and ${names[names.length - 1] ?? ''}`;
}

/**
 * The one refusal sentence for each case.
 *
 * Product voice: state the fact, then what is outstanding, by name. No
 * apology, no exclamation mark, no advice beyond naming the surface that
 * owns the outstanding work.
 *
 * Every sentence ends by saying nothing was written, because the whole point
 * of a refusal at this gate is that the League is still in Setup and every
 * earlier surface still works.
 */
export function auctionOpenRefusalDetail(refusal: AuctionOpenRefusal): string {
	switch (refusal.kind) {
		case 'phase':
			return (
				`The auction was not opened: the phase is ${refusal.phase}, not Setup. ` +
				`${
					refusal.phase === 'Auction'
						? 'The auction is already open, and it opens once — it cannot be re-opened or un-opened.'
						: 'The auction opens only out of Setup, and this League has already moved past it.'
				} The phase was folded from the event log inside this transaction. ` +
				'Nothing was written.'
			);
		case 'not_promoted':
			return (
				'The auction was not opened: no import has been promoted. Staging a source ' +
				'is not promoting it, so the League has no live rosters and no Free Agent ' +
				'pool to auction. Promote every source — one roster file per Team, plus the ' +
				'Free Agent pool — on the Import screen. Nothing was written.'
			);
		case 'no_teams':
			return (
				'The auction was not opened: the League has no Teams. An auction with no ' +
				'Team has nobody to nominate, bid or be acted for, so there is nothing to ' +
				'open. Nothing was written.'
			);
		case 'outstanding_sources':
			return (
				'The auction was not opened: the last promotion did not commit ' +
				`${nameList(refusal.sourceNames)}. Promotion is all-or-nothing, so re-run it ` +
				'on the Import screen once every source is staged. Nothing was written.'
			);
		case 'unbound_teams':
			return (
				`The auction was not opened: ${nameList(refusal.teamNames)} ` +
				`${refusal.teamNames.length === 1 ? 'has' : 'have'} no Manager bound, and a ` +
				'Team with no Manager cannot nominate, bid or be acted for once the auction ' +
				'is running. Nothing was written.'
			);
		case 'unconfirmed':
			return (
				'The auction was not opened: the confirmation was not given. Opening the ' +
				'auction cannot be undone, so it is never inferred from a submit. Tick the ' +
				'confirmation and submit again. Nothing was written.'
			);
		case 'unrecorded':
			return (
				'The auction was not opened: the write was refused and stated no reason. ' +
				'Nothing was written.'
			);
		case 'unbound_actor':
			return (
				'The auction was not opened: the acting Manager is not bound to a Team, ' +
				'and every event must name one.'
			);
	}
}

/**
 * The gates, in order: phase, then whether anything was promoted at all,
 * then which sources that promotion left outstanding, then which Teams have
 * no Manager. Returns the refusal, or `null` when every gate holds.
 *
 * Phase goes first for `refusePromotion`'s reason — once the auction has
 * opened, the state of staging is beside the point and "the phase is
 * Auction" is the honest answer. `not_promoted` precedes
 * `outstanding_sources` because "no import has been promoted" and "the
 * promotion left the Lakers out" are different facts, and listing all thirty
 * Teams as outstanding when none was ever promoted names the wrong problem.
 *
 * Exported so the ordering is assertable as pure logic rather than inferred
 * from a transaction.
 */
export function refuseAuctionOpen(state: AuctionOpenState): AuctionOpenRefusal | null {
	if (state.phase !== 'Setup') return { kind: 'phase', phase: state.phase };

	if (!state.promotion.promoted) return { kind: 'not_promoted' };

	// Every other source check below derives "outstanding" from the live
	// `teams` table, so an empty table has nothing to be outstanding ABOUT and
	// would sail through into an irreversible open with `payload.teams = []`.
	// No count is asserted — thirty is the league's size today, not a rule the
	// core owns — but zero Teams is refused outright.
	if (state.teams.length === 0) return { kind: 'no_teams' };

	const outstanding = outstandingSources(state);
	if (outstanding.length > 0) {
		return { kind: 'outstanding_sources', sourceNames: outstanding };
	}

	const unbound = unboundTeamNames(state);
	if (unbound.length > 0) return { kind: 'unbound_teams', teamNames: unbound };

	return null;
}

/**
 * Every source the last promotion did not commit, by name: each live Team
 * absent from the promotion's payload, then the Free Agent pool when that
 * promotion committed no Player.
 *
 * The live `teams` table is the truth about which Teams exist; the payload
 * is the truth about which of them were promoted. Comparing the two is what
 * makes a partial promotion — a payload naming twenty-nine Teams — name the
 * thirtieth rather than pass unnoticed.
 *
 * A pool of zero Players is stated as the pool being outstanding rather than
 * as a count, because a promoted-but-empty pool is indistinguishable from a
 * never-promoted one from the auction's point of view: there is nothing to
 * nominate either way.
 */
export function outstandingSources(state: AuctionOpenState): readonly string[] {
	const promoted = new Set(state.promotion.teamIds);
	const names = state.teams
		.filter((team) => !promoted.has(team.teamId))
		.map((team) => team.teamName);
	if (state.promotion.poolSize <= 0) names.push(POOL_SOURCE_LABEL);
	return names;
}

/** Every Team with no Manager bound, by name, in the order the Teams arrived. */
export function unboundTeamNames(state: AuctionOpenState): readonly string[] {
	return state.teams.filter((team) => !team.hasManager).map((team) => team.teamName);
}

/**
 * What the pre-open report states: the named outstanding items, whether the
 * gate holds, and the eligible-Player count as a finished sentence.
 *
 * `ready` is `refuseAuctionOpen(state) === null` and nothing else — the page
 * and the transaction cannot disagree about what "ready" means, because
 * there is one definition of it.
 */
export type PreOpenReport = {
	readonly ready: boolean;
	/** The refusal the gate would give right now, or `null`. */
	readonly refusal: AuctionOpenRefusal | null;
	/** That refusal's one sentence, or `null` when the gate holds. */
	readonly refusalDetail: string | null;
	/** Every source the last promotion did not commit, by name. */
	readonly outstandingSources: readonly string[];
	/** Every Team with no Manager bound, by name. */
	readonly unboundTeams: readonly string[];
	/** The Minor League Eligible count, in words, stated as a finished sentence. */
	readonly eligibilitySentence: string;
	/** What confirming will do, in words, so the confirm is never a bare tick. */
	readonly consequence: string;
};

/**
 * The one statement of what opening the auction does. Every sentence the
 * surface prints beside the confirm is built from this string, so the
 * consequence has exactly one wording.
 */
export const AUCTION_OPEN_CONSEQUENCE =
	'the League leaves Setup for the Auction Phase, the League Clock starts its ' +
	'48 hours, and every Team receives its unused Nomination Slot';

/**
 * The eligible-Player count, as a sentence that says the number in words and
 * states plainly that it does not block.
 *
 * Zero is stated as "no Player", not as "0" — the I/O matrix's zero-eligible
 * row is a legitimate opening state and reads as a fact rather than as a
 * missing value.
 */
export function eligibilitySentence(count: number): string {
	const subject =
		count <= 0
			? 'No Player is'
			: count === 1
				? 'One Player is'
				: `${String(count)} Players are`;
	return (
		`${subject} marked Minor League Eligible. This is stated for confirmation ` +
		'only: whatever the number, it does not stop the auction opening, and it ' +
		'cannot be changed once it has.'
	);
}

/**
 * Build the pre-open report from the state the server loaded.
 *
 * Pure, and derived from the same `refuseAuctionOpen` the transaction uses,
 * so the page can never report ready for a state the gate would refuse.
 */
export function preOpenReport(state: AuctionOpenState): PreOpenReport {
	const refusal = refuseAuctionOpen(state);
	return {
		ready: refusal === null,
		refusal,
		refusalDetail: refusal === null ? null : auctionOpenRefusalDetail(refusal),
		outstandingSources: outstandingSources(state),
		unboundTeams: unboundTeamNames(state),
		eligibilitySentence: eligibilitySentence(state.eligibleCount),
		consequence: `Opening the auction cannot be undone: ${AUCTION_OPEN_CONSEQUENCE}.`
	};
}
