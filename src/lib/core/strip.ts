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
import { bidStateFor, evaluate, ordinal, outstandingBidFiguresFor } from './rules/bidding.ts';
import type { OutstandingBidFigures, TeamMoneyState } from './rules/bidding.ts';
import type { CapGateOutcome, PlaceBid, SlotsGateOutcome } from './types.ts';

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
 * alone — no Maximum Bid and no bids figure (see `stripShowsMaximumBid` and
 * `stripShowsOutstandingBids`, which are two predicates because they answer
 * two questions that happen to agree).
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
 * Whether the strip states the bids figure, given the phase (Story 10.6).
 *
 * **Auction Phase only, and for `stripShowsMaximumBid`'s reason rather than
 * by borrowing its predicate.** Outstanding Bids against the Outstanding Bid
 * Allowance is a figure about placing a Bid, and outside the Auction Phase no
 * Bid is accepted at any amount — so `0 of 3 bids` in Archived would state
 * something about outstanding Bids in a phase where none can exist. The
 * Roster Count beside it stays, because a Roster Count is true in every phase
 * that has a roster.
 *
 * **It is its own predicate on purpose.** The two currently return the same
 * answer, and that is a coincidence of the rules rather than a shared
 * meaning: `stripShowsMaximumBid` is named for the money half and is where
 * Story 6.1's Contract Assignment figure would land if it ever arrives. A
 * second caller reading it for the capacity half would make the name false of
 * one of them the first time the two phases diverge, which is exactly the
 * shared-name drift this module argues against everywhere else.
 *
 * **Every surface carrying the figure reads this one predicate**, the Teams
 * index and the Team view included (resolved 2026-09-09). It first gated the
 * strip alone, on the reasoning that a Team view is a record read on purpose
 * while the strip is inherited by every screen — but the divergence it
 * produced was worse than the asymmetry it defended: in Archived the strip
 * omitted the figure while the index still stated `0 of 3 bids` on every row,
 * so the two surfaces disagreed about the same Team at the same instant. The
 * figure is false in the same way wherever it is printed, so it is gated in
 * the same place.
 */
export function stripShowsOutstandingBids(phase: LeaguePhase): boolean {
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
 * The Team's outstanding Bids against its allowance, in words (Story 10.6).
 *
 * The neighbour of `rosterCountSentence` and worded here for the same reason:
 * the strip states it beside the Roster Count, the Teams index states it on a
 * row, and one wording is one thing to keep in step. Neither surface builds a
 * string — `PersistentStrip.svelte` and `routes/teams/+page.svelte` print this
 * one.
 *
 * **`null` for a viewer bound to no Team**, which is what makes the segment
 * ABSENT rather than `0 of 0`: a Team that does not exist holds no Bids
 * against no allowance, and an invented zero on the strip every screen
 * inherits would be a false statement on all of them.
 *
 * The shape mirrors the Roster Count's — count, ceiling, noun — so the two
 * read as one register with the `·` between them, and `slotSentenceHalves`
 * splits it at the same ` of ` every other slot sentence is split at.
 *
 * **At parity the figure alone is the signal** (UX-DR35). There is no word
 * here for "at your allowance", no punctuation that escalates and nothing for
 * a surface to hang a colour on: `2 of 2 bids` says it.
 */
export function outstandingBidsSentence(figures: OutstandingBidFigures): string;
export function outstandingBidsSentence(figures: OutstandingBidFigures | null): string | null;
export function outstandingBidsSentence(figures: OutstandingBidFigures | null): string | null {
	if (figures === null) return null;
	return `${String(figures.outstandingBids)} of ${String(figures.allowance)} bids`;
}

/**
 * The Team's open lottery entries, in their own words and never in the
 * sentence above (UX-DR36).
 *
 * **A count with no ceiling, deliberately.** A Minimum-Bid Contention entry
 * consumes no allowance and a Team may hold as many as its Cap Space allows,
 * so this sentence has no `of n` half to give: writing one would state a
 * limit FR-18 does not impose, and summing these into the bids figure would
 * do the same thing more quietly.
 *
 * `null` for a viewer bound to no Team, with the figure above it.
 */
// No non-null overload, unlike its sibling: this sentence is absent for a
// bound Team holding no entries as well as for no Team at all, so a caller
// that knows it has figures still has to handle `null`.
export function contentionEntriesSentence(figures: OutstandingBidFigures | null): string | null {
	if (figures === null) return null;
	const count = figures.openContentionEntries;
	// **A Team holding none gets no sentence, not `0 lottery entries`.**
	// Resolved 2026-09-09: the bids figure reads `0 of n` because the
	// allowance exists whether or not it is spent, and a Manager needs the
	// denominator. Entries have no ceiling at all (FR-18), so a zero there
	// states nothing and, on a thirty-row index, states it thirty times. The
	// figure appears when there is something to report and is absent
	// otherwise — the same rule the null-Team case follows one line above.
	if (count === 0) return null;
	return `${String(count)} lottery ${count === 1 ? 'entry' : 'entries'}`;
}

/**
 * The two sentences the strip and the Teams index both state, from ONE
 * derivation over the Team's own facts.
 *
 * Callers pass a `TeamMoneyState` and get the words; nobody else calls
 * `outstandingBidFiguresFor` and words the result a second time.
 */
export function outstandingBidLines(team: TeamMoneyState | null): {
	readonly figures: OutstandingBidFigures | null;
	readonly bids: string | null;
	readonly entries: string | null;
} {
	const figures = outstandingBidFiguresFor(team);
	return {
		figures,
		bids: outstandingBidsSentence(figures),
		entries: contentionEntriesSentence(figures)
	};
}

/**
 * The trade the bid control names ONCE, before the confirm step (UX-DR34),
 * or `null` when this Bid is not the one at risk.
 *
 * **It is stated on exactly one condition: this prospective Bid IS the
 * allowance Bid.** The three absences are as load-bearing as the presence:
 *
 *  - under the allowance, this Bid is not the one a later win would take
 *    back, so there is no trade to name;
 *  - at `freeActiveBenchSlots === 0` the precondition has failed and NO Bid
 *    is permitted at all, so a sentence about what this one costs would be
 *    describing an act the gate refuses outright;
 *  - a lottery entry spends no allowance however many are held (FR-18), so
 *    the sentence would be false about it in both directions.
 *
 * `isContentionEntry` is read rather than inferred from the amount — the
 * contention gate already decided it, and this module can no more see a
 * dollar than the slots gate can.
 *
 * **Plain prose, and no alarm.** It is not a dialog, not a checkbox and not a
 * warning; the cancellation it names is automatic and ordinary, which is
 * exactly why a Manager is told about it before rather than after. The
 * ordinal and the permitted count are `gateFigure`'s own — the same `ordinal`
 * renderer and the same `allowance` field — so the sentence above the control
 * and the row inside the panel cannot quote different figures.
 */
export function allowanceTradeSentence(slots: SlotsGateOutcome): string | null {
	if (slots.isContentionEntry) return null;
	const { projectedAdditions, freeActiveBenchSlots, allowance } = slots;
	if (projectedAdditions === null || freeActiveBenchSlots === null || allowance === null) {
		return null;
	}
	if (freeActiveBenchSlots < 1) return null;
	if (projectedAdditions !== allowance) return null;
	return (
		`This would be your ${ordinal(projectedAdditions)} of ${String(allowance)} permitted ` +
		'bids. If you win another Auction first, this Bid is cancelled and the next-highest Bid ' +
		'leads.'
	);
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
 * `bidStateFor(null, team, phase)` is the whole of the baseline's
 * definition, and each argument is a decision:
 *
 *  - `null` for the Auction, which is the no-Auction state `bidStateFor`
 *    already answers — no leading Bid, no clock, no contention. That is what
 *    makes this figure about the Team rather than about a screen.
 *  - **no eligibility argument at all**, since 2026-09-18. There used to be a
 *    `false` here, and a note explaining that it kept the figure a single
 *    NUMBER rather than sometimes unbounded. The unbounded branch it was
 *    steering around no longer has a way to arise: an Auction win always
 *    lands in Active/Bench, so an eligible Player bounds like any other and
 *    `bidStateFor` no longer accepts the flag from anyone.
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
export function baselineCapOutcome(
	team: TeamMoneyState | null,
	phase: LeaguePhase,
	now: string
): CapGateOutcome {
	const state = bidStateFor(null, team, phase);
	return evaluate(state, probeFor(), now).cap;
}

/**
 * The strip's Maximum Bid — the one field of the outcome above the strip
 * reads.
 *
 * **One probe, not two.** Story 4.5 needed the whole `CapGateOutcome` for a
 * Team view, and the choice was a second probe beside this one or lifting the
 * outcome out of it. A second probe would be a second answer to "what does
 * this Team hold", and the first to drift when a gate changes; this way the
 * strip and the Team view are structurally incapable of printing different
 * numbers, because there is one expression and both read fields off it.
 */
export function baselineMaximumBid(
	team: TeamMoneyState | null,
	phase: LeaguePhase,
	now: string
): Money | null {
	return baselineCapOutcome(team, phase, now).maximumBid;
}
