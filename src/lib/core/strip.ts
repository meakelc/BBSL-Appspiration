/**
 * The persistent strip's whole phase table, and every word it says
 * (Story 4.2).
 *
 * **One number, one meaning, every screen.** The strip carries the figure the
 * whole app exists to compute onto surfaces that could not previously state
 * it — Nominate, the import screen, the eligibility list — and the only way
 * that is worth doing is if the figure means the same thing on all of them.
 * So the strip's Maximum Bid is the BASELINE: `evaluate()` run against a
 * no-Auction state with the Player treated as NOT Minor League Eligible. That
 * is the money ceiling applying to every non-eligible Auction, which is the
 * one answer to "what can I spend on something new".
 *
 * **It is deliberately not the Auction page's figure, and may read lower.**
 * `teamMoneyStateFor` excludes the Auction being bid on from `leading`,
 * because a raise replaces that Team's own lead rather than adding to it. The
 * baseline excludes nothing, so a Team leading elsewhere sees its own
 * commitments held against it. The Auction page's panel keeps the per-Auction
 * arithmetic and remains the authority for bidding; the strip is orientation.
 *
 * **Nothing here is memoised, stored or transported.** The figure is
 * `evaluate()`'s own output, derived in the browser from the FACTS the layout
 * ships (AD-7): shipping a `maximumBid` field would make the transported
 * number the check. Every projection change the freshness contract already
 * reloads for therefore recomputes it, because there is nothing to
 * invalidate.
 *
 * **Every sentence the strip says is worded here.** No `.svelte` file words a
 * figure or a label — the non-Live labelling is `MAXIMUM_BID_LABELS`'
 * (`core/freshness.ts`), reused rather than restated, and the Roster Count
 * sentence is below.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { ACTIVE_BENCH_SLOTS, MINIMUM_BID, NO_AUCTION_PROBE_ID } from './constants.ts';
import { parseMoney } from './money.ts';
import type { Money } from './money.ts';
import type { LeaguePhase } from './projection/phase.ts';
import { bidStateFor, evaluate } from './rules/bidding.ts';
import type { TeamMoneyState } from './rules/bidding.ts';
import type { PlaceBid } from './types.ts';

/**
 * The strip's own trigger label — the one word on the control that opens the
 * destinations sheet.
 *
 * It is the SHEET that is named, not the list: `DestinationsList` is rendered
 * unchanged from the header menu (AD-30), and this is the second trigger
 * pointed at it rather than a second resolution of what a Manager may reach.
 */
export const STRIP_SHEET_LABEL = 'Destinations';

/**
 * The strip REGION's name, which is not the sheet's.
 *
 * The landmark contains Maximum Bid and the Roster Count; the sheet it also
 * carries is one control inside it. Naming the region `STRIP_SHEET_LABEL`
 * announced a landmark called "Destinations" that then read out money, which
 * mis-orients the one user who navigates by landmark and cannot see the strip.
 * Two things are named because two things exist.
 */
export const STRIP_REGION_LABEL = 'Your Team';

/**
 * Whether the strip renders at all, given the phase.
 *
 * Setup is the one phase with nothing to state: no roster has been promoted,
 * so there is no Slot count and no Cap Space — a strip there would report
 * `Roster 0 of 12` about a Team whose roster simply has not arrived yet, which
 * is a false statement rather than an empty one.
 *
 * Contract Assignment and Archived both render, carrying the Roster Count
 * alone (see `stripShowsMaximumBid`).
 */
export function stripPresent(phase: LeaguePhase): boolean {
	return phase !== 'Setup';
}

/**
 * Whether the strip states a Maximum Bid, given the phase.
 *
 * Only in the Auction Phase, and for the reason the `phase` gate itself
 * gives: outside it no Bid is accepted at any amount, so a money ceiling on
 * bidding is a figure about an act nobody can perform. The strip states the
 * Roster Count in those phases and omits the money half entirely rather than
 * printing a ceiling that bounds nothing.
 *
 * **Contract Assignment is the phase that would report assignment progress**,
 * per `epics.md:1450`'s own reading of the strip — and it does not, because
 * the Year Allotment it would report against does not exist anywhere in this
 * repository yet (deferred to Story 6.1, recorded in `deferred-work.md`).
 * Reporting the Roster Count alone is honest about what the app knows;
 * inventing a progress figure would not be.
 */
export function stripShowsMaximumBid(phase: LeaguePhase): boolean {
	return phase === 'Auction';
}

/**
 * The Roster Count, in the strip's own words.
 *
 * `ACTIVE_BENCH_SLOTS` is the source of the twelve — never a literal — so the
 * one place Roster Capacity is declared is the one place this sentence can
 * disagree with, which is nowhere.
 *
 * **The count is stated as it is, including over twelve.** A Team CAN hold
 * more than `ACTIVE_BENCH_SLOTS` — `overflowCount` exists precisely because
 * an import or a Contract expiry can leave one over the ceiling — so
 * `Roster 13 of 12` is a true sentence about a real state, and clamping it to
 * `Roster 12 of 12` would hide the overflow from the Manager who has to
 * resolve it. This mirrors the negative Maximum Bid, which is likewise
 * rendered as the fact it is rather than floored at zero.
 *
 * A NEGATIVE count is different: it is not a state the app can reach, it is a
 * corrupt read. It is floored at zero because `Roster -1 of 12` tells a
 * Manager nothing true and nothing actionable.
 */
export function rosterCountSentence(rosterCount: number): string {
	const stated = Number.isFinite(rosterCount) ? Math.max(0, Math.trunc(rosterCount)) : 0;
	return `Roster ${String(stated)} of ${String(ACTIVE_BENCH_SLOTS)}`;
}

/**
 * The probe command the baseline evaluates.
 *
 * `evaluate()` takes a `PlaceBid` because the figure IS a bid gate's
 * arithmetic (`epics.md:1450` fixes it as `evaluate()` output), so the
 * baseline builds one. Three of its fields deserve their reason written down:
 *
 *  - `fantraxPlayerId` is `NO_AUCTION_PROBE_ID`, a named constant rather than
 *    a real id or an empty string, because AD-5's Minors Exposure tiebreak
 *    sorts on this field — the probe's id participates in an ordering, so it
 *    is a value the core writes down once.
 *  - `teamId` is that same probe id rather than the Team's own, because the
 *    Team's id is not among the FACTS the layout transports: `TeamMoneyState`
 *    carries money and counts, and nothing else. No gate reads it in the
 *    no-Auction state regardless — `selfBid` compares against a `leadingBid`
 *    that is `null`, and `contention` answers `not_a_contention` — so
 *    supplying one would be inventing a fact rather than using it.
 *  - `amount` is `MINIMUM_BID`, the least a Bid may ever be. Only `cap` is
 *    read, and its `maximumBid` is a subtraction over the Team's own state
 *    that does not depend on the offered amount at all; the minimum is the
 *    one value that cannot itself be the reason a probe looks odd in a
 *    debugger.
 *
 * `teamName` and `managerId` are the two fields `PlaceBid` requires that no
 * gate reads (`types.ts:249-256`), so they carry the probe id too: a probe
 * that named a real Manager would be a command that looked appendable, and
 * this one is never appended anywhere.
 */
function probeFor(): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId: NO_AUCTION_PROBE_ID,
		teamId: NO_AUCTION_PROBE_ID,
		teamName: NO_AUCTION_PROBE_ID,
		managerId: NO_AUCTION_PROBE_ID,
		amount: parseMoney(MINIMUM_BID)
	};
}

/**
 * The strip's Maximum Bid: `evaluate()`'s `cap.maximumBid` against a
 * no-Auction state.
 *
 * `bidStateFor(null, team, false, phase)` is the whole of the baseline's
 * definition, and each argument is a decision:
 *
 *  - `null` for the Auction, which is the no-Auction state `bidStateFor`
 *    already answers — no leading Bid, no clock, no contention. That is what
 *    makes this figure about the Team rather than about a screen.
 *  - `false` for `playerIsMinorLeagueEligible`, which is what makes the
 *    figure a single NUMBER rather than sometimes unbounded: a Free Minor
 *    League Slot absorbs an eligible Player at a $0 Cap Hit, and "no cap
 *    limit" is not a figure a strip can carry onto every screen.
 *  - the real `phase`, because the ninth gate reads it — even though this
 *    function ignores the verdict.
 *
 * **`passed` is deliberately ignored.** The strip authorises nothing; a probe
 * reporting a refusal would answer a question nobody asked. Only the
 * arithmetic is read.
 *
 * `null` for a viewer with no Team, which is `evaluateCap`'s own answer for
 * that state — every figure nulled together rather than a zero invented for
 * a Team that does not exist. A NEGATIVE figure is returned as the negative
 * it is: an overcommitted Team is over its Cap, and clamping that to `$0.0M`
 * would state something false about a Team that most needs told.
 */
export function baselineMaximumBid(
	team: TeamMoneyState | null,
	phase: LeaguePhase,
	now: string
): Money | null {
	const state = bidStateFor(null, team, false, phase);
	return evaluate(state, probeFor(), now).cap.maximumBid;
}
