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
import { wonCardSentence } from './positions.ts';
import type { OpenNomination } from './projection/nominations.ts';
import type { LeaguePhase } from './projection/phase.ts';
import { capBreakdown, describeAmount } from './rules/bidding.ts';
import type { CapBreakdownLine, TeamMoneyState } from './rules/bidding.ts';
import { SLOT_LABELS } from './rules/roster-import.ts';
import { baselineCapOutcome, rosterCountSentence } from './strip.ts';
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
	rosterReserve: 'Roster Reserve',
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

/** One row of a Team's roster, as the surface renders it. */
export type TeamRosterEntry = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** What this row charges against the Cap — `$0.0M` on a minors row (AD-23). */
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

	readonly rosterCount: number;
	readonly rosterCountSentence: string;
	readonly activeBenchSentence: string;
	readonly minorLeagueSentence: string;
	readonly injuryReserveSentence: string;

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
 * A count, or the stated absence of one — `amountLabel`'s counterpart, for
 * the same reason and with the same unreachability.
 */
function countOf(value: number | null): number {
	return value ?? 0;
}

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
	const held = Number.isFinite(rosterCount) ? Math.max(0, Math.trunc(rosterCount)) : 0;
	const free = Math.max(0, ACTIVE_BENCH_SLOTS - held);
	return `Free Active/Bench Slots ${String(free)} of ${String(ACTIVE_BENCH_SLOTS)}`;
}

/**
 * The Minor League occupancy, rendered `N of 3` (`DESIGN.md:183`), with the
 * Free Minor League Slots the money gate itself reported beside it.
 *
 * `MINOR_LEAGUE_SLOTS` is the source of the three. The occupancy is the raw
 * fact off `team_rosters` plus the Team's won minors placements — never `M`,
 * which is the clamped derivation `evaluateCap` returns and which this
 * sentence prints as the separate figure it is.
 */
export function minorLeagueSlotSentence(occupied: number, freeMinorLeagueSlots: number): string {
	const held = Number.isFinite(occupied) ? Math.max(0, Math.trunc(occupied)) : 0;
	return (
		`Minor League ${String(held)} of ${String(MINOR_LEAGUE_SLOTS)}, ` +
		`Free Minor League Slots ${String(freeMinorLeagueSlots)}`
	);
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
		capHitLabel: describeAmount(row.capHit),
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

		rosterCount: input.team.rosterCount,
		// The strip's own sentence, reused verbatim — including its refusal to
		// clamp an overflowing count to twelve.
		rosterCountSentence: rosterCountSentence(input.team.rosterCount),
		activeBenchSentence: rosterSlotSentence(input.team.rosterCount),
		minorLeagueSentence: minorLeagueSlotSentence(
			input.team.minorLeagueOccupied,
			countOf(outcome.freeMinorLeagueSlots)
		),
		injuryReserveSentence: injuryReserveSentence(
			input.rosterRows.filter((row) => row.rosterSlotKind === 'injury_reserve').length
		),

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
