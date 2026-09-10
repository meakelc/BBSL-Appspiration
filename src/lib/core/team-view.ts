/**
 * One Team's position, in full — and every word the Team view says
 * (Story 4.5).
 *
 * **One computation, called per Team.** `epic-4-context.md:56` requires
 * Story 4.5's single-Team view and Story 4.6's thirty-row index to be produced
 * by ONE computation so they cannot disagree. This is that computation, and it
 * takes exactly one Team: the index is a `map` over it plus a League Median,
 * which makes the disagreement the requirement exists to prevent impossible by
 * construction rather than by discipline. A function over a LIST would have
 * been written now, guessed at, and rewritten by the story that actually needs
 * it.
 *
 * **Every figure is `evaluate()`'s, through the strip's own no-Auction probe.**
 * Cap Space, Committed Bids, of-which Minors Exposure, Available Cap Space,
 * Roster Reserve, Maximum Bid, Free Minor League Slots, Eligible Leading Bids
 * and Overflow Count are all fields on the `CapGateOutcome`
 * `baselineCapOutcome` returns (`core/strip.ts`). Nothing here adds, re-derives
 * or recomputes one (AD-7), and because the strip reads the identical
 * expression the two surfaces are structurally incapable of printing different
 * numbers.
 *
 * **Maximum Bid is the one field a rival's view does not carry, and it is
 * ABSENT rather than blanked** (`epic-4-context.md:20`). Everything else is
 * public: there is no partial-information layer and no fog of war, so every
 * other figure renders identically for every viewer on every Team. A blanked
 * field would still be a field, and a surface that renders a hole where a
 * figure would be invites the reader to wonder what is being withheld — so the
 * property is not on the object at all, which is what `tests/team-view.test.ts`
 * asserts of the serialised payload.
 *
 * **No comparison of any kind.** No League Median, no rank, no ordinal, no
 * colour by comparison, and no word calling a Team rich, poor, stacked or thin
 * (`EXPERIENCE.md:131-133`). The median is Story 4.6's and lives in
 * `core/money` when it arrives.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { auctionPathFor } from './auction-link.ts';
import { ACTIVE_BENCH_SLOTS, INJURY_RESERVE_SLOTS, MINOR_LEAGUE_SLOTS } from './constants.ts';
import type { Money } from './money.ts';
import { wonCardSentence } from './projection/closed.ts';
import type { OpenNomination } from './projection/nominations.ts';
import type { LeaguePhase } from './projection/phase.ts';
import { capBreakdown, describeAmount, outstandingBidFiguresFor } from './rules/bidding.ts';
import type { CapBreakdownLine, TeamMoneyState } from './rules/bidding.ts';
import { SLOT_LABELS, chargedCapHit } from './rules/roster-import.ts';
import {
	baselineCapOutcome,
	contentionEntriesSentence,
	outstandingBidsSentence,
	rosterCountSentence,
	stripShowsOutstandingBids
} from './strip.ts';
import { formatTeamManagers, teamManagerSuffix } from './team-identity.ts';
import type { CapGateOutcome, RosterSlotKind, SlotPlacement } from './types.ts';

/**
 * The order the roster is grouped in, declared rather than incidental (AD-1).
 *
 * Active/Bench first because it is the twelve the Roster Count is about;
 * Minor League second because it is the other occupancy a Cap figure depends
 * on; Injury Reserve last and visibly outside both, which is the arrangement
 * `DESIGN.md:183` asks for by name — IR "is the figure most often wrongly
 * folded into the twelve".
 */
export const ROSTER_GROUP_ORDER: readonly RosterSlotKind[] = Object.freeze([
	'active_bench',
	'minor_league',
	'injury_reserve'
]);

/**
 * Every label this surface prints, once.
 *
 * PRD §3 glossary terms verbatim on every money row — a synonym in UI copy is
 * a defect the same way a synonym in code is. No `.svelte` file under
 * `src/routes/teams/` words any of these.
 */
export const TEAM_VIEW_LABELS = Object.freeze({
	phase: 'Phase',
	capSpace: 'Cap Space',
	committedBids: 'Committed Bids',
	minorsExposure: 'of which Minors Exposure',
	availableCapSpace: 'Available Cap Space',
	maximumBid: 'Maximum Bid',
	// **No Roster Reserve row, deliberately.** It was declared here and read
	// by nothing until Story 4.5's code review; publishing it would not merely
	// be an extra figure but would DEFEAT the one exception
	// `epic-4-context.md:20` carves out, because
	// `maximumBid = availableCapSpace − rosterReserve` and Available Cap Space
	// is public. Any Manager could then recover a rival's Maximum Bid by
	// subtraction. It reaches the viewer's own Team through `capBreakdown`,
	// which owns that label (`rules/bidding.ts:2048`) and is own-Team-gated.
	roster: 'Roster',
	slots: 'Slots',
	money: 'Money',
	nominationSlot: 'Nomination Slot',
	auctions: 'Auctions this Team leads or contends in',
	breakdown: 'How Maximum Bid is reached'
});

/** The page's own name. A Team is spelled out with its Manager(s) beneath it. */
export const TEAM_VIEW_TITLE = 'Team';

/**
 * A figure that could not be stated.
 *
 * Unreachable through `teamViewFor`, whose `team` is a `TeamMoneyState` and
 * never `null` — `evaluateCap` nulls every figure together only for a viewer
 * bound to no Team, and this function is always given the Team it describes.
 * It exists because the outcome's fields are legitimately nullable and a total
 * function may not pretend otherwise; stating a `$0.0M` there would describe a
 * broke Team rather than an unanswered question.
 */
export const FIGURE_UNAVAILABLE = 'not available';

/**
 * The ` of ` that separates a count from the ceiling it is against — spelled
 * ONCE, here, and used both to build a slot sentence and to split one.
 */
const CEILING_SEPARATOR = ' of ';

/**
 * A slot sentence in the two registers `DESIGN.md:183` sets: the count that
 * carries the information, and the ceiling it is measured against, which
 * reads second.
 *
 * `mockups/Teams.dc.html:41` draws exactly that — `9` at the row's own
 * strength, ` of 12` one step quieter — and a single joined string cannot
 * carry two colours. This is `teamManagerSuffix`'s problem and takes
 * `teamManagerSuffix`'s answer: the core supplies both halves, DERIVED from
 * the one sentence by slicing at the separator it spelled itself, so the
 * halves can never disagree with the whole and no `.svelte` file ever
 * searches a string for ` of `.
 *
 * `qualifier` is the empty string for any sentence with no ceiling in it, so
 * a surface may render it unconditionally.
 */
export type SlotSentenceHalves = {
	/** The whole sentence, for a screen reader and for any single-register use. */
	readonly full: string;
	/** Up to and including the count — `Roster 9`. */
	readonly lead: string;
	/** The ceiling and anything after it — ` of 12`. Empty when there is none. */
	readonly qualifier: string;
};

/** Split a slot sentence at its first ceiling, deriving both halves. */
export function slotSentenceHalves(sentence: string): SlotSentenceHalves {
	const at = sentence.indexOf(CEILING_SEPARATOR);
	if (at === -1) return { full: sentence, lead: sentence, qualifier: '' };
	return {
		full: sentence,
		lead: sentence.slice(0, at),
		qualifier: sentence.slice(at)
	};
}

/** One row of a Team's roster, as the surface renders it. */
export type TeamRosterEntry = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/**
	 * What this row CHARGES against the Cap — `$0.0M` on a minors row
	 * (AD-23), whatever `team_rosters.cap_hit` stores for it. The figure is
	 * `chargedCapHit`'s, the same one `computeCapSpace` sums.
	 */
	readonly capHitLabel: string;
	readonly slotKind: RosterSlotKind;
	/** Whether the row is an Auction Contract rather than an imported one. */
	readonly won: boolean;
	/**
	 * Where a WON Player landed and what it charges, in the words Your
	 * Positions already uses — `null` for an imported row, which was never
	 * placed by a close and has no such statement to make.
	 */
	readonly wonSentence: string | null;
};

/** One slot kind's rows, with the heading the group is named by. */
export type TeamRosterGroup = {
	readonly slotKind: RosterSlotKind;
	readonly label: string;
	readonly entries: readonly TeamRosterEntry[];
};

/** One open Auction this Team leads or contends in. Own-Team only. */
export type TeamAuctionEntry = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly amountLabel: string;
	readonly href: string;
};

/** The Nomination Slot's state, in words, with the Auction it was spent on. */
export type NominationSlotStatus = {
	readonly used: boolean;
	readonly fantraxPlayerId: string | null;
	readonly playerName: string | null;
	readonly sentence: string;
	readonly href: string | null;
};

/**
 * One Team's whole published position.
 *
 * `maximumBid`, `maximumBidLabel` and `capBreakdown` are OPTIONAL properties
 * and are absent — not null, not blank — on any Team but the viewer's own.
 */
export type TeamView = {
	readonly teamName: string;
	/** `Lakers — Meakel`, or `Lakers — Meakel & Dana` when co-managed. */
	readonly identity: string;
	/**
	 * The Manager half of `identity` alone — `` — Meakel ``, or `''`.
	 *
	 * The two halves take two colours (`DESIGN.md:187`: the Team name in
	 * `text`, the Manager beside it in `text-secondary`), which one joined
	 * string cannot carry. Both are supplied so the surface sets each in its
	 * own register without splitting a string on the em dash itself.
	 */
	readonly managerSuffix: string;
	readonly managerNames: readonly string[];
	readonly viewerIsThisTeam: boolean;

	readonly capSpaceLabel: string;
	readonly committedBidsLabel: string;
	readonly minorsExposureLabel: string;
	readonly availableCapSpaceLabel: string;

	/**
	 * The same four money figures as NUMBERS, beside the labels above
	 * (Story 4.6).
	 *
	 * The Teams index must sort on these and take a League Median of them, and
	 * a median needs the number rather than the rendering. The two ways to get
	 * one are to widen this type or to re-derive the figure in the index — and
	 * the second is exactly the second computation `epic-4-context.md:56`
	 * exists to forbid. Each is taken from the SAME `outcome` field its label
	 * is taken from, on one line, so the number and the rendering are provably
	 * one value.
	 *
	 * `Money | null` because the outcome's own fields are: `evaluateCap` nulls
	 * every figure together for a viewer bound to no Team, which is the
	 * condition `amountLabel` already answers with `FIGURE_UNAVAILABLE`. A
	 * Team contributing `null` contributes no value to the median, and the
	 * median line states the count it actually covers.
	 *
	 * **These are renderings of committed state, never an authority.** Nothing
	 * on this object decides anything; the gates remain `evaluate()`'s (AD-7).
	 */
	readonly capSpace: Money | null;
	readonly committedBids: Money | null;
	readonly minorsExposure: Money | null;
	readonly availableCapSpace: Money | null;

	readonly rosterCount: number;
	/**
	 * How many of the twelve are unfilled — the figure `activeBenchSentence`
	 * states in words, from the one `freeActiveBenchSlots` derivation, so the
	 * number the index sorts by cannot disagree with the words on the row.
	 */
	readonly freeActiveBenchSlots: number;
	readonly rosterCountSentence: string;
	readonly activeBenchSentence: string;
	readonly minorLeagueSentence: string;
	readonly injuryReserveSentence: string;

	/**
	 * What this Team holds against its Outstanding Bid Allowance, and how many
	 * open lotteries it has entered — THREE separately named figures, from the
	 * one `outstandingBidFiguresFor` derivation the persistent strip reads
	 * (Story 10.6).
	 *
	 * **The entries are never summed into the bids count** (UX-DR36). A
	 * lottery entry consumes no allowance and a Team may hold any number of
	 * them, so a combined figure would imply a ceiling that does not exist.
	 * They are carried here rather than re-derived in `teams-index.ts` for the
	 * reason every other figure on this object is: the index re-deriving is
	 * the second computation Epic 4 forbids.
	 */
	readonly outstandingBids: number;
	/** `Free Active/Bench Slots + OUTSTANDING_BID_ALLOWANCE`. */
	readonly bidAllowance: number;
	/** Open Minimum-Bid Contention entries. Bounded by money alone (FR-18). */
	readonly openContentionEntries: number;
	/**
	 * `2 of 4 bids` — the strip's own sentence, reused verbatim — or `null`
	 * outside the Auction Phase.
	 *
	 * **The three counts above are facts and stay; the sentences are what a
	 * surface prints, and they are gated** (resolved 2026-09-09). Outside the
	 * Auction Phase no Bid is accepted at any amount, so a figure about
	 * outstanding Bids describes an act nobody can perform —
	 * `stripShowsOutstandingBids` states the reason, and every surface reads
	 * that one predicate so the strip and this object can never disagree
	 * about the same Team at the same instant.
	 */
	readonly outstandingBidsSentence: string | null;
	/**
	 * `4 lottery entries` — its own figure, with no ceiling to state — or
	 * `null` outside the Auction Phase AND for a Team holding none. Entries
	 * have no ceiling (FR-18), so a zero states nothing worth a row.
	 */
	readonly contentionEntriesSentence: string | null;

	/**
	 * The same four sentences split into the two registers `DESIGN.md:183`
	 * sets — the count first, the ceiling one step quieter. The whole
	 * sentence stays on each so a screen reader reads it unbroken.
	 */
	readonly rosterCountHalves: SlotSentenceHalves;
	readonly activeBenchHalves: SlotSentenceHalves;
	readonly minorLeagueHalves: SlotSentenceHalves;
	readonly injuryReserveHalves: SlotSentenceHalves;
	/**
	 * The Minor League line WITHOUT its Free Minor League Slots clause, for
	 * the Teams index — `minorLeagueOccupancySentence`'s reason.
	 */
	readonly minorLeagueOccupancyHalves: SlotSentenceHalves;
	/** The bids sentence in the same two registers — `2` then ` of 4 bids`. */
	readonly outstandingBidsHalves: SlotSentenceHalves | null;
	/** The entries sentence. It has no ceiling half, so the qualifier is empty. */
	readonly contentionEntriesHalves: SlotSentenceHalves | null;

	readonly roster: readonly TeamRosterGroup[];
	readonly nominationSlot: NominationSlotStatus;

	/** Present only for the viewer's own Team (`epic-4-context.md:20`). */
	readonly maximumBid?: Money | null;
	/** Present only for the viewer's own Team. In words when unbounded (FR-35). */
	readonly maximumBidLabel?: string;
	/** Present only for the viewer's own Team. Empty for a null-Team outcome. */
	readonly capBreakdown?: readonly CapBreakdownLine[];
	/** Present only for the viewer's own Team. */
	readonly auctions?: readonly TeamAuctionEntry[];
};

/** The facts one roster row carries into the view. */
export type TeamRosterRow = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly capHit: Money;
	readonly rosterSlotKind: RosterSlotKind;
	/** Whether this row came from an `AuctionClosed` rather than the import. */
	readonly won: boolean;
};

// --- The wording -----------------------------------------------------------

/** A money figure, or the stated absence of one. Never an invented zero. */
function amountLabel(amount: Money | null): string {
	return amount === null ? FIGURE_UNAVAILABLE : describeAmount(amount);
}

/**
 * What the unfilled half of the twelve is CALLED — spelled once, here.
 *
 * It heads the sentence below and it names the same figure on Story 4.6's
 * sort control and median line, so the row, the chip and the foot of the
 * index cannot call one figure three things.
 */
export const FREE_ACTIVE_BENCH_SLOTS_LABEL = 'Free Active/Bench Slots';

/**
 * The Active/Bench occupancy, in words: the twelve, and how many are free.
 *
 * `ACTIVE_BENCH_SLOTS` is the source of the ceiling — never a literal — so the
 * one place Roster Capacity is declared is the one place this sentence can
 * disagree with, which is nowhere.
 *
 * **The free count is the ceiling minus the count, and is not a gate figure.**
 * `unfilledSlots` in `rules/bidding.ts` is a POST-BID derivation counting the
 * Bid being placed, which is the right figure for Roster Reserve and the wrong
 * one for a Team at rest; this states what a Team holds now. It is clamped at
 * zero for `rosterCountSentence`'s reason in the other direction: a Team over
 * the ceiling has no free Slots, and a negative count states nothing true.
 * The overflow itself is not hidden — `rosterCountSentence` says `Roster 13 of
 * 12` beside this.
 */
export function rosterSlotSentence(rosterCount: number): string {
	const free = freeActiveBenchSlots(rosterCount);
	return `${FREE_ACTIVE_BENCH_SLOTS_LABEL} ${String(free)} of ${String(ACTIVE_BENCH_SLOTS)}`;
}

/**
 * How many of the twelve this Team has NOT filled, as a number (Story 4.6).
 *
 * The arithmetic `rosterSlotSentence` above states in words, extracted so the
 * sentence and the figure are the SAME derivation rather than two. Story 4.6's
 * index sorts on this and takes a League Median of it, and a second clamped
 * subtraction written beside the sentence is the first thing that would drift
 * from it — the figure would then disagree with the words printed on the same
 * row.
 *
 * Clamped at zero in both directions for the reasons above: a Team over the
 * ceiling has no free Slots rather than a negative number of them, and a
 * corrupt count is not a state to publish arithmetic about.
 */
export function freeActiveBenchSlots(rosterCount: number): number {
	const held = Number.isFinite(rosterCount) ? Math.max(0, Math.trunc(rosterCount)) : 0;
	return Math.max(0, ACTIVE_BENCH_SLOTS - held);
}

/**
 * The Minor League occupancy, rendered `N of 3` (`DESIGN.md:183`), with the
 * Free Minor League Slots the money gate itself reported beside it.
 *
 * `MINOR_LEAGUE_SLOTS` is the source of the three. The occupancy is the raw
 * fact off `team_rosters` plus the Team's won minors placements — never `M`,
 * which is the clamped derivation `evaluateCap` returns and which this
 * sentence prints as the separate figure it is.
 *
 * **A null Free Minor League Slots states its absence, never a `0`.** The
 * gate nulls every figure together for a viewer bound to no Team, and the
 * money labels on the same object already answer that condition with
 * `FIGURE_UNAVAILABLE`. Printing `Free Minor League Slots 0` there would
 * state a fact — that this Team has no room — where the truth is that the
 * question was never answered, and would leave two opposite policies for one
 * null in a single object literal.
 */
export function minorLeagueSlotSentence(
	occupied: number,
	freeMinorLeagueSlots: number | null
): string {
	const free = freeMinorLeagueSlots === null ? FIGURE_UNAVAILABLE : String(freeMinorLeagueSlots);
	return `${minorLeagueOccupancySentence(occupied)}, Free Minor League Slots ${free}`;
}

/**
 * The occupancy half of the sentence above, alone — `Minor League N of 3`.
 *
 * The Teams index prints THIS one. `N of 3` already tells a reader how much
 * room is left, so the clause naming the gate's own free count beside it says
 * the same thing twice on a card built to be scanned. The full sentence keeps
 * the clause where the free count is load-bearing.
 *
 * Extracted rather than respelled so the two renderings share one derivation
 * and cannot disagree about the occupancy or the ceiling.
 */
export function minorLeagueOccupancySentence(occupied: number): string {
	const held = Number.isFinite(occupied) ? Math.max(0, Math.trunc(occupied)) : 0;
	return `Minor League ${String(held)} of ${String(MINOR_LEAGUE_SLOTS)}`;
}

/**
 * Injury Reserve, stated and visibly OUTSIDE the twelve.
 *
 * `DESIGN.md:183` puts IR outside the slot group because it is "the figure
 * most often wrongly folded into the twelve", and §10 example 23 is the
 * executable statement of the same rule: 11 Active/Bench plus 1 IR is a Roster
 * Count of 11. The sentence says so in words rather than relying on the layout
 * to imply it, so a greyscale screenshot and a screen reader both carry it.
 */
export function injuryReserveSentence(occupied: number): string {
	const held = Number.isFinite(occupied) ? Math.max(0, Math.trunc(occupied)) : 0;
	return (
		`Injury Reserve ${String(held)} of ${String(INJURY_RESERVE_SLOTS)}, ` +
		`outside the ${String(ACTIVE_BENCH_SLOTS)}`
	);
}

/**
 * The Nomination Slot's state, in words.
 *
 * **It never offers to nominate.** `positions.ts`'s `nominationSlotSentence`
 * is the viewer's own Slot and says the act obliges nothing, because that
 * screen is where a Manager spends it. This is a statement about A Team —
 * possibly a rival's — and an offer on a rival's page would be a control that
 * acts on somebody else's Slot.
 */
export function nominationSlotStatusSentence(playerName: string | null): string {
	if (playerName === null) return 'The Nomination Slot is free.';
	return `The Nomination Slot is spent on ${playerName}, and frees when that Auction ends.`;
}

// --- The assembly ----------------------------------------------------------

/**
 * Plain code-unit comparison, never `localeCompare` — `board.ts`'s
 * `compareText`, for its reason: `Intl`'s collation differs across runtimes
 * and AD-2 needs Node and Deno to agree on every ordering exactly.
 */
function compareText(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** A roster row, rendered. */
function entryFor(row: TeamRosterRow): TeamRosterEntry {
	return {
		fantraxPlayerId: row.fantraxPlayerId,
		playerName: row.playerName,
		// **What the row CHARGES, not what the column stores.** A Minor
		// League row's stated hit is preserved on `team_rosters.cap_hit` and
		// zeroed only by the Cap rule, so rendering the stored figure here
		// would print `$3.0M` beside a Cap Space that never counted him and
		// the sum a Manager does by hand would not reconcile (AC #5). The
		// rule is asked for rather than restated: `chargedCapHit` is the one
		// `computeCapSpace` sums over, so the listing and the figure above it
		// cannot disagree.
		capHitLabel: describeAmount(chargedCapHit(row)),
		slotKind: row.rosterSlotKind,
		won: row.won,
		// A won Player is a roster row on the same footing as an imported one,
		// and the sentence saying where he landed is the one Your Positions
		// already prints — `PLACEMENT_LABELS` through `wonCardSentence`, not a
		// second spelling here. `injury_reserve` is not a `SlotPlacement`: no
		// close can produce one, so a won row is always one of the two.
		wonSentence:
			row.won && row.rosterSlotKind !== 'injury_reserve'
				? wonCardSentence(row.rosterSlotKind as SlotPlacement, row.capHit)
				: null
	};
}

/**
 * The roster, grouped by slot kind in the declared order.
 *
 * Every group is present even when empty, so the three ceilings are legible
 * from the page whether or not a Team occupies them — an absent Minor League
 * group and an empty one say different things, and only the second is true of
 * a Team holding none.
 *
 * Rows are sorted by Player name, tie-broken TOTALLY on the Player id: several
 * roster rows can legitimately share a name, and a comparator returning 0
 * leaves `Array.prototype.sort` free to reorder them between two renders of
 * the same state (AD-1, `sortBoard`'s rule).
 */
function groupRoster(rows: readonly TeamRosterRow[]): readonly TeamRosterGroup[] {
	return ROSTER_GROUP_ORDER.map((slotKind) => ({
		slotKind,
		label: SLOT_LABELS[slotKind],
		entries: rows
			.filter((row) => row.rosterSlotKind === slotKind)
			.map(entryFor)
			.sort((left, right) => {
				const byName = compareText(left.playerName, right.playerName);
				return byName === 0 ? compareText(left.fantraxPlayerId, right.fantraxPlayerId) : byName;
			})
	}));
}

/**
 * The Auctions this Team holds capital in — its leads AND its contentions.
 *
 * **Not a fourth traversal.** `teamMoneyStateFor` has already partitioned
 * exactly this set onto `leading` and `eligibleLeading` (`bidding.ts:610-645`),
 * including every Minimum-Bid Contention this Team has joined, because any
 * Contender can win and therefore every Contender commits. Re-deriving the set
 * from `OpenAuctions` here would be a second answer to "where is this Team's
 * money", and the first to drift.
 *
 * Sorted by Player id, which is what makes one ordered sequence out of two
 * already-sorted lists (AD-5).
 */
function auctionsFor(team: TeamMoneyState): readonly TeamAuctionEntry[] {
	return [...team.leading, ...team.eligibleLeading]
		.map((lead) => ({
			fantraxPlayerId: lead.fantraxPlayerId,
			playerName: lead.playerName,
			amountLabel: describeAmount(lead.amount),
			href: auctionPathFor(lead.fantraxPlayerId)
		}))
		.sort((left, right) => compareText(left.fantraxPlayerId, right.fantraxPlayerId));
}

/** The Nomination Slot's state, as the surface renders it. */
function nominationStatusFor(nomination: OpenNomination | null): NominationSlotStatus {
	if (nomination === null) {
		return {
			used: false,
			fantraxPlayerId: null,
			playerName: null,
			sentence: nominationSlotStatusSentence(null),
			href: null
		};
	}
	return {
		used: true,
		fantraxPlayerId: nomination.fantraxPlayerId,
		playerName: nomination.playerName,
		sentence: nominationSlotStatusSentence(nomination.playerName),
		href: auctionPathFor(nomination.fantraxPlayerId)
	};
}

/**
 * One Team's whole published position, from one folded state.
 *
 * `viewerIsThisTeam` decides exactly three properties and nothing else: every
 * other figure on the returned object is identical for every viewer, because
 * everything but Maximum Bid is public (`epic-4-context.md:20`).
 *
 * `now` is the database clock the read path already holds — the same instant
 * the strip's own probe is evaluated against, which is what makes the fourth
 * acceptance criterion (the strip and this page agreeing on Maximum Bid) hold
 * rather than merely usually hold.
 */
export function teamViewFor(input: {
	readonly teamName: string;
	readonly managerNames: readonly string[];
	readonly rosterRows: readonly TeamRosterRow[];
	readonly team: TeamMoneyState;
	readonly phase: LeaguePhase;
	readonly nomination: OpenNomination | null;
	readonly viewerIsThisTeam: boolean;
	readonly now: string;
}): TeamView {
	// The ONE probe. Every money figure below is a field of this outcome; not
	// one of them is computed here (AD-7).
	const outcome: CapGateOutcome = baselineCapOutcome(input.team, input.phase, input.now);

	const rosterCountLine = rosterCountSentence(input.team.rosterCount);
	const activeBenchLine = rosterSlotSentence(input.team.rosterCount);
	const minorLeagueLine = minorLeagueSlotSentence(
		input.team.minorLeagueOccupied,
		outcome.freeMinorLeagueSlots
	);
	const injuryReserveLine = injuryReserveSentence(
		input.rosterRows.filter((row) => row.rosterSlotKind === 'injury_reserve').length
	);

	// The ONE bids derivation, and the two sentences worded off it. The strip
	// calls the same function over the same `TeamMoneyState`, which is what
	// makes this page and that strip incapable of stating different counts.
	//
	// The counts stay whatever they are; the SENTENCES are gated on the phase
	// through the one predicate the strip reads, so no two surfaces can ever
	// disagree about whether the figure is sayable (resolved 2026-09-09).
	const bidFigures = outstandingBidFiguresFor(input.team);
	const saysBids = stripShowsOutstandingBids(input.phase);
	const outstandingBidsLine = saysBids ? outstandingBidsSentence(bidFigures) : null;
	const contentionEntriesLine = saysBids ? contentionEntriesSentence(bidFigures) : null;

	const published = {
		teamName: input.teamName,
		identity: formatTeamManagers(input.teamName, input.managerNames),
		managerSuffix: teamManagerSuffix(input.teamName, input.managerNames),
		managerNames: input.managerNames,
		viewerIsThisTeam: input.viewerIsThisTeam,

		capSpaceLabel: amountLabel(outcome.capSpace),
		committedBidsLabel: amountLabel(outcome.committedBids),
		minorsExposureLabel: amountLabel(outcome.minorsExposure),
		availableCapSpaceLabel: amountLabel(outcome.availableCapSpace),

		// The identical `outcome` fields the four labels above are taken
		// from, on the four lines beneath them — which is what makes the
		// number and its rendering incapable of describing different values
		// (Story 4.6). Nothing is computed here.
		capSpace: outcome.capSpace,
		committedBids: outcome.committedBids,
		minorsExposure: outcome.minorsExposure,
		availableCapSpace: outcome.availableCapSpace,

		rosterCount: input.team.rosterCount,
		freeActiveBenchSlots: freeActiveBenchSlots(input.team.rosterCount),
		// The strip's own sentence, reused verbatim — including its refusal to
		// clamp an overflowing count to twelve.
		rosterCountSentence: rosterCountLine,
		activeBenchSentence: activeBenchLine,
		minorLeagueSentence: minorLeagueLine,
		injuryReserveSentence: injuryReserveLine,

		outstandingBids: bidFigures.outstandingBids,
		bidAllowance: bidFigures.allowance,
		openContentionEntries: bidFigures.openContentionEntries,
		outstandingBidsSentence: outstandingBidsLine,
		contentionEntriesSentence: contentionEntriesLine,

		rosterCountHalves: slotSentenceHalves(rosterCountLine),
		activeBenchHalves: slotSentenceHalves(activeBenchLine),
		minorLeagueHalves: slotSentenceHalves(minorLeagueLine),
		minorLeagueOccupancyHalves: slotSentenceHalves(
			minorLeagueOccupancySentence(input.team.minorLeagueOccupied)
		),
		injuryReserveHalves: slotSentenceHalves(injuryReserveLine),
		outstandingBidsHalves:
			outstandingBidsLine === null ? null : slotSentenceHalves(outstandingBidsLine),
		contentionEntriesHalves:
			contentionEntriesLine === null ? null : slotSentenceHalves(contentionEntriesLine),

		roster: groupRoster(input.rosterRows),
		nominationSlot: nominationStatusFor(input.nomination)
	};

	if (!input.viewerIsThisTeam) return published;

	const breakdown = capBreakdown(outcome);

	return {
		...published,
		maximumBid: outcome.maximumBid,
		// **The breakdown's own Maximum Bid row, read rather than respelled.**
		// That row already renders the figure IN WORDS when it is unbounded
		// (FR-35, "no cap limit", never a number) and as the negative it is
		// when a Team is overcommitted, so taking the string from it is what
		// makes the figure at the head of the page and the figure at the foot
		// of the breakdown incapable of saying different things. The fallback
		// is unreachable here — `capBreakdown` is empty only for a null-Team
		// outcome — and states the absence rather than inventing a number.
		maximumBidLabel:
			breakdown.find((line) => line.label === TEAM_VIEW_LABELS.maximumBid)?.figure ??
			amountLabel(outcome.maximumBid),
		capBreakdown: breakdown,
		auctions: auctionsFor(input.team)
	};
}
