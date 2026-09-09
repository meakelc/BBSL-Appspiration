/**
 * The Teams index: every word it says, every order it may be read in, and the
 * League Median at its foot (Story 4.6).
 *
 * **Thirty renderings of `teamViewFor`, and not one second computation.**
 * `epic-4-context.md:56` requires the index and `/teams/[teamId]` to be
 * produced by ONE computation so they cannot disagree. Every figure on a row
 * below is a FIELD of the `TeamView` that function returned — read, never
 * re-derived — and this module builds no money and no slot count of its own.
 * The one thing it adds is the League Median, which is `core/money.ts`'
 * arithmetic over figures it was handed.
 *
 * **The index states figures and nothing about them.** There is no comparison
 * of any kind against the median: no colour, badge, rank, ordinal, arrow, chip
 * or annotation by a Team's position relative to it, and no word calling a
 * Team ahead, behind, rich, poor, stacked, thin or under pressure
 * (`EXPERIENCE.md:131-133`). The median earns its place as a bare fact. The
 * word is *median*, never *average*.
 *
 * **Sorting is view state and never changes a figure.** `sortTeamsIndex` is
 * generic over rows it does not construct — `board.ts`'s `sortBoard`, copied
 * rather than reinvented — so it is structurally incapable of touching one,
 * and every ordering is TOTAL so a list re-derived under a reader cannot
 * visibly reshuffle. The median is computed over the UNSORTED set and is
 * identical under every order.
 *
 * **Every string the index prints is here**, so `routes/teams/+page.svelte`
 * states nothing of its own. Where a word already exists in the core it is
 * IMPORTED rather than respelled: the money labels are `TEAM_VIEW_LABELS`',
 * the free-slot label is `core/team-view.ts`', the em dash of the own-row
 * marker is `core/team-identity.ts`'.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { MINIMUM_INCREMENT } from './constants.ts';
import { formatMoney, medianCount, medianMoney } from './money.ts';
import type { Money } from './money.ts';
import { teamManagerSuffix } from './team-identity.ts';
import {
	FIGURE_UNAVAILABLE,
	FREE_ACTIVE_BENCH_SLOTS_LABEL,
	TEAM_VIEW_LABELS
} from './team-view.ts';
import type { SlotSentenceHalves, TeamView } from './team-view.ts';

// --- The link --------------------------------------------------------------

/**
 * The path prefix every Team link carries, with its trailing slash.
 *
 * `auction-link.ts`'s shape, for its reason: a path spelled in each `.svelte`
 * file that happens to link to a Team is not one shape, it is several literals
 * that agree today. Exported beside the function so a test can assert the
 * shape without rebuilding it from a Team id, which would make the assertion
 * circular.
 */
export const TEAM_PATH_PREFIX = '/teams/';

/**
 * The path of one Team's page — `routes/teams/[teamId]`.
 *
 * Passed through unencoded, `auctionPathFor`'s rule: these ids are the
 * database's own keys and they already appear in the URL bar of every Team
 * page, so encoding one here would produce a path that does not match the link
 * the page itself was reached by.
 */
export function teamPathFor(teamId: string): string {
	return `${TEAM_PATH_PREFIX}${teamId}`;
}

// --- View state ------------------------------------------------------------

/**
 * The four orderings the index offers.
 *
 * Each names a figure already on the row. There is no ordering by anything the
 * reader cannot see, and none of them is advice — a Manager asked for the
 * order and nothing on any row moves with it.
 */
export type TeamsSort = 'name' | 'availableCapSpace' | 'freeActiveBenchSlots' | 'capSpace';

/** The sorts, in the order the control offers them. */
export const TEAMS_SORT_KEYS: readonly TeamsSort[] = Object.freeze([
	'name',
	'availableCapSpace',
	'freeActiveBenchSlots',
	'capSpace'
] as const);

/** The default ordering: Team name (`epic-4-context.md:26`). */
export const DEFAULT_TEAMS_SORT: TeamsSort = 'name';

/**
 * What each ordering is called on the control that chooses it.
 *
 * Three of the four are the label the figure already carries on the row, taken
 * from the module that owns it rather than respelled — a chip that said
 * "Available" beside a column headed "Available Cap Space" would be two names
 * for one figure on one screen.
 */
export const TEAMS_SORT_LABELS: Readonly<Record<TeamsSort, string>> = Object.freeze({
	name: 'Team name',
	availableCapSpace: TEAM_VIEW_LABELS.availableCapSpace,
	freeActiveBenchSlots: FREE_ACTIVE_BENCH_SLOTS_LABEL,
	capSpace: TEAM_VIEW_LABELS.capSpace
});

// --- The index's own furniture ---------------------------------------------

/** The index's own name — the destination's label (`destinations.ts:79`). */
export const TEAMS_INDEX_TITLE = 'Teams';

/** The sort control's legend. `board.ts`'s `BOARD_SORT_LEGEND`, in kind. */
export const TEAMS_SORT_LEGEND = 'Sort';

/**
 * The one word the foot of the list is labelled with — *median*, and never
 * *average* (`DESIGN.md:189`, `epic-4-context.md`).
 *
 * The distinction is not pedantry: the mean of two grid values lands off the
 * grid, and a line labelled *average* would be describing a figure this
 * product refuses to compute.
 */
export const MEDIAN_LABEL = 'Median';

/** The separator between the median's label and the count it covers. */
const MEDIAN_SEPARATOR = ' · ';

/**
 * The grid step written out in EXACT dollars with thousands separators —
 * `$500,000` — for this one sentence and nothing else.
 *
 * **It is deliberately not `formatMoney`.** That renderer answers `$0.5M`,
 * and a sentence explaining WHY the abbreviated one-decimal rendering is safe
 * cannot explain it using that same abbreviated rendering — the reader is
 * being told what the grid is, so the grid has to be spelled out.
 * `mockups/Teams.dc.html:202` writes `$500,000` for exactly that reason.
 *
 * **It is private, and that is what keeps it from becoming a second money
 * format.** No figure on any surface reaches this: it is applied to one
 * compile-time constant inside one sentence, never to a `Money` value off a
 * gate outcome. Every figure the index prints still goes through
 * `describeAmount`/`formatMoney` on the `TeamView` that produced it. Exporting
 * this would make it reachable as an alternative renderer, which is the thing
 * AD-8 forbids.
 *
 * Grouping is done by hand rather than through `Intl.NumberFormat`, because
 * `Intl` is a forbidden global in the pure core (`check-core-purity.js`): ICU
 * data differs across runtimes, which is the precise Node/Deno divergence AD-2
 * exists to close.
 */
function exactDollars(amount: number): string {
	if (!Number.isSafeInteger(amount) || amount < 0) {
		throw new RangeError(`the grid step must be a whole non-negative amount, received ${String(amount)}`);
	}
	const digits = String(amount);
	let grouped = '';
	for (let i = 0; i < digits.length; i += 1) {
		if (i > 0 && (digits.length - i) % 3 === 0) grouped += ',';
		grouped += digits[i];
	}
	return `$${grouped}`;
}

/**
 * Why the figure at the foot is the lower middle, in the reader's own terms.
 *
 * `mockups/Teams.dc.html:202` spells this out on the surface rather than
 * leaving it to a doc comment, because a Manager who adds the 15th and 16th
 * rows and halves them will get a different number and needs to know why. The
 * step comes from `MINIMUM_INCREMENT` and is never a literal.
 */
export const MEDIAN_GRID_NOTE =
	'The lower of the two middle values, so the figure always lands on the ' +
	`${exactDollars(MINIMUM_INCREMENT)} grid.`;

/**
 * What a median figure says when there is none to state.
 *
 * `FIGURE_UNAVAILABLE`, imported rather than respelled: a median over no
 * values and a Cap figure that could not be answered are the same kind of
 * absence, and `$0.0M` or `0` would both be a figure — a broke League, or one
 * where every Team is full — where the truth is that nothing was there to
 * measure.
 */
export const MEDIAN_UNAVAILABLE = FIGURE_UNAVAILABLE;

/**
 * The marker that replaces the Manager half on the viewer's own row —
 * `` — you `` (`DESIGN.md:185`).
 *
 * **Derived, not spelled.** It sits exactly where `TeamView.managerSuffix`
 * sits, so it must carry the identical em dash and the identical spacing;
 * building it through `teamManagerSuffix` is what guarantees that, and keeps
 * the naming convention's own punctuation spelled once in this repository
 * (`core/team-identity.ts`). The empty Team name is the whole point: the
 * suffix is what remains once the name is taken off, and here there is no name
 * to take off.
 *
 * It is a MARKER and not a rank. The row it lands on is not pinned, not
 * reordered and not exempted from the sort.
 */
export const OWN_ROW_MARKER = teamManagerSuffix('', ['you']);

/**
 * The designed empty screen: what the state is, and why there is no median.
 *
 * A League with no Teams is a real state — the roster import is what creates
 * them — and stating it is not the same as rendering thirty blank rows.
 */
export const EMPTY_TEAMS_HEADING = 'No Team has been created yet.';
export const EMPTY_TEAMS_STATEMENT =
	'The League holds no Teams, so there is nothing to list and no League Median to state. ' +
	'Teams arrive with the roster import.';

/**
 * How many Teams the index is listing, as a finished sentence.
 *
 * `board.ts`'s `boardCountSentence` pattern, including its singular: "1 Teams"
 * is the kind of sentence that tells a Manager nobody proof-read the thing
 * they are being asked to trust. The count is of the list ACTUALLY read —
 * there is no constant thirty in this codebase and none is added.
 */
export function teamCountSentence(count: number): string {
	if (count <= 0) return 'No Teams.';
	if (count === 1) return 'One Team.';
	return `${String(count)} Teams.`;
}

/**
 * What the median covers, as the caption `DESIGN.md:189` asks for —
 * `Median · 30 Teams`.
 *
 * **The count is the one the figure was actually computed over**, which is not
 * always the number of rows: a Team whose figure could not be answered
 * contributes no value, and a median that silently covered 28 while captioned
 * 30 would be the quietest lie on the surface.
 */
export function medianCoverageSentence(count: number): string {
	if (count <= 0) return `${MEDIAN_LABEL}${MEDIAN_SEPARATOR}no Teams`;
	if (count === 1) return `${MEDIAN_LABEL}${MEDIAN_SEPARATOR}one Team`;
	return `${MEDIAN_LABEL}${MEDIAN_SEPARATOR}${String(count)} Teams`;
}

// --- The rows --------------------------------------------------------------

/**
 * One Team's view with the id it was read under.
 *
 * The id is not on `TeamView` because a Team view is about a Team rather than
 * about a row; the index needs it to link and to recognise the viewer's own.
 */
export type TeamsIndexInput = TeamView & { readonly teamId: string };

/**
 * One row of the index.
 *
 * Every field is READ off the `TeamView` it was built from. Nothing here is
 * computed, which is what makes the row and `/teams/<id>` incapable of
 * printing different numbers.
 *
 * **No Maximum Bid, no cap breakdown and no Roster Reserve, on any row —
 * including the viewer's own.** `teamViewFor` is called with
 * `viewerIsThisTeam: false` for every Team, so those fields are structurally
 * absent rather than filtered out here, and a published Roster Reserve cannot
 * recover a rival's Maximum Bid by subtraction (spec-4-5's Spec Change Log).
 */
export type TeamsIndexRow = {
	readonly teamId: string;
	readonly teamName: string;
	/**
	 * The Manager half of the identity, or `OWN_ROW_MARKER` in its place on
	 * the viewer's own row (`DESIGN.md:185`). Two registers, one line: the
	 * Team name in `text` — the viewer's included — and this beside it in
	 * `text-secondary` (`DESIGN.md:187`).
	 */
	readonly managerSuffix: string;
	/** Whether this is the viewer's own Team. Marks a row; never moves one. */
	readonly isViewer: boolean;
	readonly href: string;

	readonly rosterCountHalves: SlotSentenceHalves;
	/**
	 * The Minor League OCCUPANCY — `Minor League N of 3`, without the Free
	 * Minor League Slots clause the full sentence carries. There is no
	 * Free Active/Bench Slots line on a card either: `Roster N of 12` one
	 * line above already states the same occupancy, and a card that repeats
	 * a figure in two spellings is a card a reader has to reconcile.
	 */
	readonly minorLeagueHalves: SlotSentenceHalves;
	readonly injuryReserveHalves: SlotSentenceHalves;
	/**
	 * Outstanding non-entry Bids against the allowance — `2 of 4 bids` — and
	 * the open lottery entries beside it, as TWO figures (Story 10.6).
	 *
	 * **They are two because entries consume no allowance** (UX-DR36).
	 * Summing them would state a ceiling on lottery entries that FR-18 does
	 * not impose. Both are read off the `TeamView`, which read them off the
	 * one `outstandingBidFiguresFor` derivation the persistent strip reads —
	 * so a row and the strip above it cannot disagree.
	 */
	/**
	 * Both `null` outside the Auction Phase, and the entries figure `null`
	 * again for a Team holding none — `teamViewFor` decides, so a row and the
	 * strip above it can never disagree about whether the figure is sayable.
	 */
	readonly outstandingBidsHalves: SlotSentenceHalves | null;
	readonly contentionEntriesHalves: SlotSentenceHalves | null;
	/** The three figures behind the two sentences, read and never computed. */
	readonly outstandingBids: number;
	readonly bidAllowance: number;
	readonly openContentionEntries: number;

	readonly capSpaceLabel: string;
	readonly committedBidsLabel: string;
	readonly availableCapSpaceLabel: string;
	readonly nominationSlotSentence: string;

	/** The sort keys — the same figures the labels above render. */
	readonly capSpace: Money | null;
	readonly availableCapSpace: Money | null;
	readonly freeActiveBenchSlots: number;
};

/**
 * One figure at the foot, with the count it was actually computed over.
 *
 * **`sentence` is the composed phrase, and the core owns it.** `label` and
 * `figure` are the two visual registers the surface sets separately, exactly
 * as `SlotSentenceHalves` gives a row its count and its ceiling — but a
 * template that joined them would be the one place the printed phrase existed,
 * and no `.svelte` file may word anything. It is also what a screen reader
 * needs: the rows already ride the whole sentence on `aria-label`, and two
 * fragments read as two facts.
 */
export type MedianFigure = {
	readonly label: string;
	/** The rendering, or `MEDIAN_UNAVAILABLE` when there was nothing to median. */
	readonly figure: string;
	/** The two registers as one phrase — `Available Cap Space $4.0M`. */
	readonly sentence: string;
	readonly coverage: number;
	readonly coverageSentence: string;
};

/**
 * The median's label and its figure as ONE phrase — spelled here, so the
 * separator between them has exactly one definition.
 *
 * `slotSentenceHalves` derives its halves from a whole sentence; this composes
 * a whole sentence from two halves. Either direction is fine, and both put the
 * punctuation in the core rather than in markup — which is the rule.
 */
export function medianFigureSentence(label: string, figure: string): string {
	return `${label} ${figure}`;
}

/** The median line at the foot of the list — context, never a verdict. */
export type MedianLine = {
	readonly label: string;
	readonly availableCapSpace: MedianFigure;
	readonly freeActiveBenchSlots: MedianFigure;
	readonly gridNote: string;
};

/** The whole index: the rows, their count, and the line beneath them. */
export type TeamsIndex = {
	readonly rows: readonly TeamsIndexRow[];
	readonly countSentence: string;
	readonly median: MedianLine;
};

/**
 * Plain code-unit comparison, never `localeCompare` — `board.ts`'s
 * `compareText`, for its reason: `Intl`'s collation differs across runtimes and
 * AD-2 needs Node and Deno to agree on every ordering exactly.
 */
function compareText(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/**
 * Compare two keys either of which may be absent, with absent always LAST
 * regardless of direction — `board.ts`'s `compareNullsLast`, verbatim in
 * behaviour.
 *
 * A Team whose figure could not be answered is a Team with no key at all, and
 * sorting it by direction would put it at the top of one view and the bottom
 * of another for no reason a reader could name.
 */
function compareNullsLast(left: number | null, right: number | null): number {
	if (left === null && right === null) return 0;
	if (left === null) return 1;
	if (right === null) return -1;
	if (left === right) return 0;
	// Every figure sort on this surface is DESCENDING: a Manager who asks to
	// order by Available Cap Space is asking who has room, and burying the
	// Teams that have it beneath the ones that do not is the opposite of what
	// was asked for. This is an ordering, not a ranking — no figure moves.
	return left < right ? 1 : -1;
}

/** The fields a sort reads. Structural, so it cannot construct a row. */
type TeamsSortable = {
	readonly teamName: string;
	readonly teamId: string;
	readonly capSpace: Money | null;
	readonly availableCapSpace: Money | null;
	readonly freeActiveBenchSlots: number;
};

/**
 * The index in one stated order, as a NEW array.
 *
 * **Generic over rows it does not build** — `sortBoard`'s shape, and the whole
 * of why sorting cannot change a figure: this function receives rows, reorders
 * a copy of them and returns them, and there is no expression in it that could
 * produce a number.
 *
 * **Every ordering is TOTAL.** Two Teams legitimately share an Available Cap
 * Space (the $500,000 grid makes collisions ordinary) and two Teams could
 * share a name, so every chain ends on the Team id, which is unique by
 * construction. A comparator returning 0 would leave the pair to
 * `Array.prototype.sort` and, on a surface that re-derives while a Manager is
 * reading it, that is a list that visibly shuffles (AD-1 forbids incidental
 * order).
 *
 * The viewer's own row is sorted exactly like every other: it is marked, not
 * pinned (`DESIGN.md:185`).
 */
export function sortTeamsIndex<T extends TeamsSortable>(
	rows: readonly T[],
	key: TeamsSort
): readonly T[] {
	return [...rows].sort((left, right) => {
		if (key === 'availableCapSpace') {
			const order = compareNullsLast(left.availableCapSpace, right.availableCapSpace);
			if (order !== 0) return order;
		} else if (key === 'capSpace') {
			const order = compareNullsLast(left.capSpace, right.capSpace);
			if (order !== 0) return order;
		} else if (key === 'freeActiveBenchSlots') {
			const order = compareNullsLast(left.freeActiveBenchSlots, right.freeActiveBenchSlots);
			if (order !== 0) return order;
		}
		// `name` reaches here directly; the other three reach it as the
		// tie-break that makes them total. One expression, so the fallback
		// cannot differ between the sort that IS the Team name and the sorts
		// that end in it.
		const byName = compareText(left.teamName, right.teamName);
		if (byName !== 0) return byName;
		return compareText(left.teamId, right.teamId);
	});
}

/** One `TeamView`, as a row. Read, never computed. */
function rowFor(view: TeamsIndexInput, viewerTeamId: string | null): TeamsIndexRow {
	const isViewer = viewerTeamId !== null && viewerTeamId === view.teamId;
	return {
		teamId: view.teamId,
		teamName: view.teamName,
		// `— you` in PLACE of the Manager name, not beside it (`DESIGN.md:185`).
		managerSuffix: isViewer ? OWN_ROW_MARKER : view.managerSuffix,
		isViewer,
		href: teamPathFor(view.teamId),

		rosterCountHalves: view.rosterCountHalves,
		minorLeagueHalves: view.minorLeagueOccupancyHalves,
		injuryReserveHalves: view.injuryReserveHalves,
		outstandingBidsHalves: view.outstandingBidsHalves,
		contentionEntriesHalves: view.contentionEntriesHalves,
		outstandingBids: view.outstandingBids,
		bidAllowance: view.bidAllowance,
		openContentionEntries: view.openContentionEntries,

		capSpaceLabel: view.capSpaceLabel,
		committedBidsLabel: view.committedBidsLabel,
		availableCapSpaceLabel: view.availableCapSpaceLabel,
		nominationSlotSentence: view.nominationSlot.sentence,

		capSpace: view.capSpace,
		availableCapSpace: view.availableCapSpace,
		freeActiveBenchSlots: view.freeActiveBenchSlots
	};
}

/**
 * The median of the money figures a set of Teams actually answered.
 *
 * `formatMoney` rather than `describeAmount`, deliberately: the lower middle is
 * always a value some real Team holds, so it is always on the
 * `MINIMUM_INCREMENT` grid and the renderer cannot throw. Reaching for the
 * off-grid-tolerant describer here would quietly accept a mean if one ever
 * arrived.
 */
function moneyMedianFigure(values: readonly Money[]): MedianFigure {
	const median = medianMoney(values);
	const label = TEAM_VIEW_LABELS.availableCapSpace;
	const figure = median === null ? MEDIAN_UNAVAILABLE : formatMoney(median);
	return {
		label,
		figure,
		sentence: medianFigureSentence(label, figure),
		coverage: values.length,
		coverageSentence: medianCoverageSentence(values.length)
	};
}

/** The median of the free-Slot counts. The same rule, a different comparator. */
function slotMedianFigure(values: readonly number[]): MedianFigure {
	const median = medianCount(values);
	const label = FREE_ACTIVE_BENCH_SLOTS_LABEL;
	const figure = median === null ? MEDIAN_UNAVAILABLE : String(median);
	return {
		label,
		figure,
		sentence: medianFigureSentence(label, figure),
		coverage: values.length,
		coverageSentence: medianCoverageSentence(values.length)
	};
}

/**
 * The whole index from a set of already-computed Team views.
 *
 * **The median is taken over the UNSORTED set**, from the views as they
 * arrived, which is what makes it identical under every sort order rather than
 * merely usually identical. Sorting is the surface's own view state and
 * happens after this, over the rows this returns.
 *
 * `viewerTeamId` decides exactly one thing: which row carries the marker. It
 * changes no figure, moves no row, and is never read from a query parameter —
 * the route resolves it from the session (AD-4).
 */
export function teamsIndexFor(input: {
	readonly views: readonly TeamsIndexInput[];
	readonly viewerTeamId: string | null;
}): TeamsIndex {
	const rows = input.views.map((view) => rowFor(view, input.viewerTeamId));

	// A Team whose figure could not be answered contributes no VALUE, and the
	// coverage count below therefore shrinks with it rather than the median
	// silently absorbing a zero.
	const available: Money[] = [];
	for (const view of input.views) {
		if (view.availableCapSpace !== null) available.push(view.availableCapSpace);
	}
	const freeSlots = input.views.map((view) => view.freeActiveBenchSlots);

	return {
		rows,
		countSentence: teamCountSentence(rows.length),
		median: {
			label: MEDIAN_LABEL,
			availableCapSpace: moneyMedianFigure(available),
			freeActiveBenchSlots: slotMedianFigure(freeSlots),
			gridNote: MEDIAN_GRID_NOTE
		}
	};
}
