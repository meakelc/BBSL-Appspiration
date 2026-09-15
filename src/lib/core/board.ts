/**
 * The Bid Board: every word it says and every order it may be read in
 * (Story 4.3).
 *
 * **Nominations are the spine, not Auctions.** `OpenAuctions.byPlayer` holds
 * only Players who have received a Bid, so a Player Awaiting an Opening Bid
 * has a nomination and no Auction row at all (`projection/auctions.ts`'s
 * `auctionForPlayer` returns `null` for them, and `contentionOf(null)` is
 * what maps that to `awaiting_opening_bid`). Iterating Auctions would
 * silently omit exactly the state the board is most useful for.
 * `openNominations()` returns every Player on the board and `auctionForPlayer`
 * decorates the ones that have Bids.
 *
 * **And the closed Auctions beside them.** A close deletes the Player from
 * both of those folds, so a board built from them alone answers for the three
 * live states and for nothing that has finished. The fourth set comes off
 * `projection/closed.ts` — the one composition of `contractsReducer` and
 * `drawsReducer` that the Auction page's Closed state and Your Positions' won
 * link read too, so the three surfaces cannot describe one outcome three ways.
 *
 * **Sorting and filtering are view state and never change a figure.** Both
 * are written here rather than in a `.svelte` file so a comparator is a thing
 * a test can call, and so the same list re-derived on every projection change
 * cannot visibly reshuffle: every sort is TOTAL, tie-breaking on the Player
 * name, for the reason `overdueAuctions`' `byCloseThenPlayer` already gives —
 * several Auctions legitimately share a close instant or a price, and a
 * comparator that returns 0 leaves `Array.prototype.sort` free to reorder
 * them between renders.
 *
 * **Every string the board prints is here.** The state labels, the icons that
 * ride beside them, the sort and filter labels, the empty screen, the filtered
 * notice and the unbid phrase — so `routes/board/+page.svelte` states nothing
 * of its own and a synonym cannot appear in markup. Where a word already
 * exists in the core it is IMPORTED rather than respelled:
 * `MINIMUM_LOTTERY_LABEL` is the contention's card name and this module
 * reuses it rather than respelling it, exactly as the Auction page reuses the
 * glossary term.
 *
 * **No urgency device of any kind.** No "ending soon", no ranking of what is
 * worth bidding on, no suggested amount. The three sorts are orderings a
 * Manager asked for; none of them is advice.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { parseInstant } from './instant.ts';
import type { Money } from './money.ts';
import {
	MINIMUM_LOTTERY_LABEL,
	MINIMUM_LOTTERY_LABEL_NARROW,
	auctionForPlayer
} from './projection/auctions.ts';
import type { Auction, ContentionState, OpenAuctions } from './projection/auctions.ts';
import {
	CLOSED_LABEL,
	CLOSED_LABEL_NARROW,
	closedAuctions
} from './projection/closed.ts';
import type { ClosedAuction } from './projection/closed.ts';
import type { AuctionContracts } from './projection/contracts.ts';
import type { Draws } from './projection/draws.ts';
import { openNominations } from './projection/nominations.ts';
import type { OpenNominations } from './projection/nominations.ts';
import { describeAmount } from './rules/bidding.ts';

const MS_PER_HOUR = 3_600_000;

/**
 * Where the viewer stands on one Auction — the four states, and no fifth.
 *
 * `outbid` is the ONE state `attention` marks anywhere in this product
 * (`DESIGN.md`), which is why `contender` is a separate member rather than a
 * shade of it: a Team inside a Minimum-Bid Contention has not been outbid,
 * it is waiting on a draw, and telling it otherwise would be false.
 */
export type BoardViewerState = 'you_lead' | 'outbid' | 'contender' | 'won' | 'not_involved';

/**
 * What a board CARD is in, which is one more thing than an Auction can be.
 *
 * `ContentionState` is the fold's answer about a LIVE Auction, and the close
 * deletes the Auction — so `closed` is a value that fold can never produce,
 * while the union itself is switched on inside the bidding gates. Widening it
 * would force a dead case into every one of them. The Closed state is
 * therefore card-level, declared here beside the labels it keys.
 *
 * A WIDENING, deliberately: every existing site that indexes the three
 * label/icon records with a `ContentionState` still type-checks unchanged.
 *
 * There is no `terminated` member. `AuctionTerminated` records a Player id and
 * no reason at all, so nothing durable distinguishes "nobody bid on them" from
 * a Commissioner override, and a card claiming either would invent the half
 * the log does not carry.
 */
export type BoardCardState = ContentionState | 'closed';

/** The three orderings the board offers. */
export type BoardSort = 'closing' | 'price' | 'name';

/**
 * The five views the board offers. `all` hides nothing.
 *
 * `open` and `closed` narrow on the CARD's own state and the other two on the
 * viewer's, which is why they are one control rather than two: a Manager
 * asking "what can I still bid on" and a Manager asking "what am I leading"
 * are both asking the board to show them fewer cards, and two independent
 * controls would let them be combined into views nobody asked for and the
 * filtered notice could not word.
 */
export type BoardFilter = 'all' | 'open' | 'closed' | 'leading' | 'contending';

/** The sorts, in the order the control offers them. */
export const SORT_KEYS: readonly BoardSort[] = Object.freeze(['closing', 'price', 'name'] as const);

/** The filters, in the order the control offers them. `all` is the default. */
export const FILTER_KEYS: readonly BoardFilter[] = Object.freeze([
	'all',
	'open',
	'closed',
	'leading',
	'contending'
] as const);

/** The default ordering: what closes first, first. */
export const DEFAULT_SORT: BoardSort = 'closing';

/** The default view: the whole board, unfiltered. */
export const DEFAULT_FILTER: BoardFilter = 'all';

/**
 * The Player reference fields the board renders beside a name.
 *
 * `free_agent_players` carries `player_name`, `positions` and `nba_team` and
 * nothing else — no salary and no contract years — so the metadata line is
 * `NBA · POS` and cannot be more (`server/auction-page.ts` makes the same
 * narrowing for the same reason).
 */
export type BoardMetadata = {
	readonly playerName: string;
	readonly nbaTeam: string;
	readonly positions: string;
};

/**
 * One card on the board.
 *
 * **`price` is `Money | null` and never a derived figure.** It is the leading
 * Bid's own amount off the fold; a per-viewer Maximum Bid does not appear on
 * a card at all — the persistent strip owns that figure (AD-7), and one per
 * card would be thirty renderings of a number that authorises nothing here.
 *
 * `closesAt` is `null` for exactly one state: a nomination with no Bid, which
 * has no Auction Clock because no Opening Bid has started one. The card shows
 * no clock at all rather than a zeroed one.
 */
export type BoardCard = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** From the reference row, or `null` when the Player has none. */
	readonly nbaTeam: string | null;
	readonly positions: string | null;
	/**
	 * The card's one figure: the leading Bid's amount while the Auction runs,
	 * the WINNING amount once it has closed, and `null` before any Bid.
	 *
	 * One field for both because it is one question — what is this Auction
	 * worth — asked of a card at two moments, and the price sort orders the
	 * whole board on it. What differs is the WORD beside it, which is why
	 * `BOARD_PRICE_LABEL` and `BOARD_FINAL_LABEL` are two constants.
	 */
	readonly price: Money | null;
	readonly leadingTeamId: string | null;
	readonly leadingTeamName: string | null;
	readonly leadingManagerId: string | null;
	/** The Auction Clock's absolute expiry, or `null` before the first Bid. */
	readonly closesAt: string | null;
	/** What this card is: one of the three live states, or `closed`. */
	readonly state: BoardCardState;
	readonly contenderCount: number;
	/**
	 * The nomination that put this Player on the board — `null` on a closed
	 * card, and never invented.
	 *
	 * `nominationsReducer` DELETES the nomination at the close
	 * (`nominations.ts:458-473`), so the nominating Team is not durable past
	 * it. A closed card therefore carries no "Nominated by" line and no
	 * nominated instant, which is also why it can carry no unbid phrase.
	 */
	readonly nominatedByTeamId: string | null;
	readonly nominatedByTeamName: string | null;
	readonly nominatedByManagerId: string | null;
	readonly nominatedAt: string | null;
	/**
	 * The winning Team, `null` on every card that is not closed.
	 *
	 * The Manager is the one a `DrawnDraw` recorded, or `null` — a Standard
	 * close records the winning TEAM and no Manager, so those cards name the
	 * Team alone, which is the fallback every surface in this app already
	 * renders for "Team known, Manager unknown".
	 */
	readonly winningTeamId: string | null;
	readonly winningTeamName: string | null;
	readonly winningManagerId: string | null;
	/** The Auction's own persisted expiry, `null` on every card still open. */
	readonly closedAt: string | null;
	readonly viewerState: BoardViewerState;
};

/**
 * The four states a board card can be in, in words — and these four only.
 *
 * **Three of them are `ContentionState`'s and the fourth is not.** The fold
 * answers for a LIVE Auction, and a close deletes the Auction from it — so
 * `closed` can never come off `contentionOf`, and it is keyed here from
 * `BoardCardState` instead. The word itself is `projection/closed.ts`'s,
 * imported rather than respelled, because the Closed page at the other end of
 * this card's link says it too and a synonym between the two would be a
 * Manager reading one state under two names.
 *
 * **There is still no Terminated member.** `AuctionTerminated` yields a Player
 * id and no reason, so nothing durable distinguishes an unbid nomination the
 * phase end swept up from a Commissioner override, and a label here would
 * promise a card whose second half cannot be built.
 *
 * `minimum_bid` reuses `MINIMUM_LOTTERY_LABEL` from the fold that decides it
 * rather than respelling it — the card name, not the glossary term, because a
 * board card's identity row is scanned beside a Player's name and cannot carry
 * the full term at 375px. The term itself still stands on the Auction page
 * this card links to.
 */
export const AUCTION_STATE_LABELS: Readonly<Record<BoardCardState, string>> = Object.freeze({
	awaiting_opening_bid: 'Unbid',
	standard: 'Open',
	minimum_bid: MINIMUM_LOTTERY_LABEL,
	closed: CLOSED_LABEL
});

/**
 * The same record for a NARROW viewport, where only the lottery differs.
 *
 * A complete record rather than an override map, so a surface indexes ONE
 * thing by the state it holds and cannot fall through to a missing key. The
 * other three states are the same string in both: `Open`, `Closed` and
 * `Unbid` are already one word each, so there is nothing left to shorten and
 * a narrow spelling would only be a second name nothing asked for, which is
 * the whole cost the header above warns about.
 */
export const AUCTION_STATE_LABELS_NARROW: Readonly<Record<BoardCardState, string>> = Object.freeze({
	awaiting_opening_bid: AUCTION_STATE_LABELS.awaiting_opening_bid,
	standard: AUCTION_STATE_LABELS.standard,
	minimum_bid: MINIMUM_LOTTERY_LABEL_NARROW,
	closed: CLOSED_LABEL_NARROW
});

/**
 * The SHAPE beside each state's word.
 *
 * No state in this product may be conveyed by colour alone, so every chip
 * carries an icon and a word together and a greyscale screenshot reads
 * identically. They are declared here, beside the words, so the pairing is
 * one fact rather than two that could drift in a template.
 */
export const AUCTION_STATE_ICONS: Readonly<Record<BoardCardState, string>> = Object.freeze({
	// An open circle: a clock that has not started.
	awaiting_opening_bid: '\u25CB',
	// A filled circle: an Auction that is running.
	standard: '\u25CF',
	// The diamond the Auction page already gives a Minimum-Bid Contention.
	minimum_bid: '\u25C6',
	// A filled SQUARE: the stop mark, against three round or pointed shapes.
	// Distinct from `contender`'s half-filled square by being whole, and the
	// two can never appear on one card anyway — `viewerStateFor` gives a
	// closed card `won` or `not_involved` and nothing else.
	closed: '\u25A0'
});

/** Where the viewer stands, in words. */
export const VIEWER_STATE_LABELS: Readonly<Record<BoardViewerState, string>> = Object.freeze({
	// `Leading`, not `You lead`. The chip is only ever rendered to the Manager
	// it is about — `viewerStateFor` computes it against the reader's own Team
	// — so the pronoun stated a fact the surface had already established, and
	// cost the state a name that reads the same as a heading, as a filter and
	// as a chip. `won` keeps its pronoun: a Team's win is read beside other
	// Teams' wins, where whose it is has to be said.
	you_lead: 'Leading',
	outbid: 'Outbid',
	contender: 'Contender',
	// Stated, never congratulated. The card says whose Player this now is and
	// what it cost; an exclamation on a settled fact would be the one thing a
	// surface reading thirty Auctions at 4am must not do.
	won: 'You won',
	not_involved: 'Not involved'
});

/**
 * Where the viewer stands, in shapes — `AUCTION_STATE_ICONS`' reason.
 *
 * Deliberately DISJOINT from `AUCTION_STATE_ICONS`: a card in a Minimum-Bid
 * Contention renders both records side by side, so a glyph shared across the
 * two would put two identical shapes on one card and cost exactly the
 * greyscale distinction the pairing exists to guarantee. `contender` takes a
 * half-filled square — a Team that has joined and is waiting — rather than
 * repeating the contention's own diamond.
 *
 * `won` takes a check: a ledger mark stating this one is settled and it is
 * yours. It is not a trophy and not a star, because the card beside it states
 * a fact rather than celebrating one, and it is disjoint from the closed
 * square it always appears next to.
 */
export const VIEWER_STATE_ICONS: Readonly<Record<BoardViewerState, string>> = Object.freeze({
	you_lead: '\u25B2',
	outbid: '\u25BC',
	contender: '\u25E7',
	won: '\u2713',
	not_involved: '\u2013'
});

/** What each ordering is called on the control that chooses it. */
export const SORT_LABELS: Readonly<Record<BoardSort, string>> = Object.freeze({
	closing: 'Time remaining',
	price: 'Price',
	name: 'Player name'
});

/** What each view is called on the control that chooses it. */
export const FILTER_LABELS: Readonly<Record<BoardFilter, string>> = Object.freeze({
	all: 'All Auctions',
	open: 'Open Auctions',
	closed: 'Closed Auctions',
	// The same word the chip and the Positions heading use: one state, one
	// name, on every surface a Manager moves between.
	leading: 'Leading',
	contending: 'Contending'
});

/** The board's own furniture: the title, the two control legends, the labels. */
export const BOARD_TITLE = 'Bid Board';
export const BOARD_SORT_LEGEND = 'Sort';
export const BOARD_FILTER_LEGEND = 'Filter';
export const BOARD_PRICE_LABEL = 'Price';
export const BOARD_LEADING_LABEL = 'Leading Bidder';
export const BOARD_NOMINATED_LABEL = 'Nominated by';
/**
 * The same label abbreviated for narrow cards. A long `Team — Manager` pairing
 * beside the full spelling wraps the footnote onto a second line at 375px, and
 * the nominator is the quietest fact on the card — it is the label that gives
 * way, not the name.
 */
export const BOARD_NOMINATED_LABEL_NARROW = 'Nom. by';
export const BOARD_CLOSES_LABEL = 'Auction Clock';

/**
 * The three words a CLOSED card says where an open one says price, leading
 * bidder and clock.
 *
 * `Final amount` rather than `Price`, because the figure means something
 * different once it has been paid: a price is what an Auction is asking and a
 * final amount is what it went for, and the same number under the same word
 * would leave a Manager scanning a mixed board unable to tell which they were
 * reading. `Won by` for the Team, because nobody leads a settled Auction.
 */
export const BOARD_FINAL_LABEL = 'Final amount';
export const BOARD_WON_BY_LABEL = 'Won by';
export const BOARD_CLOSED_AT_LABEL = 'Closed';

/**
 * The heading over the count and the two controls.
 *
 * It read `Open Auctions` until the board gained its Closed cards, and that
 * word became false the moment the list below it could hold one — a heading
 * naming only half of what it covers is worse than none, because a Manager
 * who reads it and then sees a closed card has been told the screen is
 * something it is not. `Auctions` is what the panel is now over: every
 * Auction the board holds, open and closed together, with the count sentence
 * beneath it saying how many of them are still open.
 *
 * Worded here rather than in the markup for `BOARD_TITLE`'s reason — this
 * heading was the one string on this page a `.svelte` file still spelled
 * itself, which is exactly how it survived a change that falsified it.
 */
export const BOARD_PANEL_HEADING = 'Auctions';

/**
 * What a card says where a price would be, before any Bid.
 *
 * A blank is indistinguishable from a figure that failed to load, and `$0.0M`
 * would be a price nobody offered. The state is that no Opening Bid has been
 * placed, so that is what it says.
 */
export const NO_OPENING_BID = 'No opening bid';

/** What a card says where a Leading Bidder would be, before any Bid. */
export const NO_LEADING_BIDDER = 'No Team leads this Auction yet.';

/** The designed empty screen: what the state is, and where to go from it. */
export const EMPTY_BOARD_HEADING = 'Nothing is on the board yet.';
export const EMPTY_BOARD_STATEMENT =
	'No Player has been nominated, so there is no Auction to read. The board fills as Managers ' +
	'spend their Nomination Slots, and every Auction appears here the moment its nomination is ' +
	'placed — bid or not.';
export const EMPTY_BOARD_ACTION = 'Nominate a Free Agent';

/**
 * The empty screen once the Auction Phase is over.
 *
 * A frozen board with nothing on it is a different FACT from a board waiting
 * to fill, and it must not offer the act that fills one: `nominate` is absent
 * from the Archived catalog (`server/destinations.ts`), so the Auction Phase's
 * call to action would resolve to the guard's 403 — a designed empty state
 * whose one link refuses. This screen therefore states what happened and
 * offers nothing, which is honest rather than merely safe.
 */
export const ARCHIVED_EMPTY_BOARD_HEADING = 'The board is closed.';
export const ARCHIVED_EMPTY_BOARD_STATEMENT =
	'The Auction Phase is over and no Auction remains open, so there is nothing here to read. ' +
	'Nominating has closed with it.';

/**
 * What a filter is hiding, as a finished sentence — or `null` for the
 * unfiltered view, which hides nothing and therefore has nothing to state.
 *
 * A filtered view must be VISIBLY filtered: a Manager who left a filter on
 * and came back to a short board must be able to tell it from a quiet league.
 * The counts are the two the caller already holds — how many are shown and
 * how many exist — so no figure is invented and nothing on a card changes
 * with the filter.
 *
 * The singular is written out because "1 Auctions are hidden" is the kind of
 * sentence that tells a Manager at 4am that nobody proof-read the thing they
 * are being asked to trust.
 */
export function filteredNoticeSentence(
	filter: BoardFilter,
	shown: number,
	total: number
): string | null {
	if (filter === 'all') return null;
	const hidden = total - shown > 0 ? total - shown : 0;
	const view = `Filtered to ${FILTER_LABELS[filter]}.`;
	if (hidden === 0) return `${view} Nothing on the board is hidden by it.`;
	if (hidden === 1) {
		return `${view} ${String(shown)} of ${String(total)} shown; one Auction is hidden.`;
	}
	return `${view} ${String(shown)} of ${String(total)} shown; ${String(hidden)} Auctions are hidden.`;
}

/**
 * How many Auctions are on the board, as a finished sentence.
 *
 * The count of every OPEN Auction on the board, and never of a filtered view
 * — the filtered view states its own count through `filteredNoticeSentence`
 * above, and one sentence that meant either depending on view state would be
 * the figure that silently changed when a Manager touched a control.
 *
 * **Open, not "the whole board", since the board gained its Closed cards.**
 * This sentence says "N Auctions are open", which is a claim about what is
 * still biddable — the question a Manager scans the board to answer. Counting
 * the closed cards into it would make the figure grow all phase while the
 * number of Auctions anybody can act on fell, which is the one reading of it
 * that would be false. `openCardCount` is what the caller passes, so the
 * count and the wording are decided together rather than at the call site.
 */
export function boardCountSentence(count: number): string {
	if (count === 0) return 'No Auctions are open.';
	if (count === 1) return 'One Auction is open.';
	return `${String(count)} Auctions are open.`;
}

/**
 * How many of these cards are OPEN — `boardCountSentence`'s one input.
 *
 * A separate derivation rather than `cards.length`, because the board carries
 * closed cards now and the sentence beside the count says "are open". Counting
 * the whole board there would make the one figure on the page a claim that is
 * false the moment an Auction closes, which is the exact failure the sentence
 * was written to avoid.
 *
 * Structural in its parameter, for `Sortable`'s reason: the pure card and the
 * serialised one the browser holds must both be countable by the one function.
 */
export function openCardCount<T extends { readonly state: BoardCardState }>(
	cards: readonly T[]
): number {
	return cards.filter((card) => card.state !== 'closed').length;
}

/**
 * How long a nomination has stood with no Opening Bid, as of `now` — both
 * ISO-8601 UTC instants. Pure: the same two instants always give the same
 * phrase.
 *
 * Whole hours, and only hours: `EXPERIENCE.md` asks for "hours unbid" by
 * name, and a minute-precision figure on a 48-hour clock is false precision.
 * Under an hour is stated in words rather than as `0h unbid`, which reads as
 * "none" and is not what it means — `closesInPhrase`'s own band, pointed at
 * elapsed time instead of remaining time.
 *
 * A negative delta — a device whose clock is behind the server that stamped
 * the nomination — reads the same as the under-an-hour case rather than a
 * nonsensical negative count. Either instant failing to parse returns a
 * stated phrase rather than throwing, which is `relativePhrase`'s discipline
 * for the same input.
 */
export function unbidPhrase(nominatedAt: string, now: string): string {
	const then = parseInstant(nominatedAt);
	const current = parseInstant(now);
	if (then === null || current === null) return 'unbid for an unknown time';
	const elapsed = current - then;
	if (elapsed < MS_PER_HOUR) return 'unbid for less than an hour';
	return `${String(Math.floor(elapsed / MS_PER_HOUR))}h unbid`;
}

/**
 * The metadata line beside a Player's name: `HOU · SG`.
 *
 * The three-letter capital is the real NBA team and can be nothing else
 * (the naming convention is absolute), which is why a fantasy Team never
 * appears on this line. `null` when the reference row is missing entirely —
 * the line is omitted rather than blanked or invented, exactly as the Auction
 * page omits its own.
 *
 * No salary and no contract years: `free_agent_players` carries neither
 * column, so a line naming them would be a figure this app does not have.
 */
export function metadataLine(nbaTeam: string | null, positions: string | null): string | null {
	if (nbaTeam === null && positions === null) return null;
	if (nbaTeam === null) return positions;
	if (positions === null) return nbaTeam;
	return `${nbaTeam} \u00B7 ${positions}`;
}

/**
 * The price, rendered — or the statement that there is none.
 *
 * `describeAmount` is the core's one renderer for an amount that may not sit
 * on the $500,000 grid (only a historical off-grid Bid could, and the fold
 * deliberately does not rewrite it), so the board and the Auction page render
 * the identical string for the identical figure. Nothing here formats money
 * itself.
 */
export function priceLabel(price: Money | null): string {
	return price === null ? NO_OPENING_BID : describeAmount(price);
}

/**
 * Where the viewer stands on one Auction — the ONE derivation, so the card,
 * the filter and the tests cannot each answer it differently.
 *
 * `null` for the Auction is a nomination nobody has bid on: nobody leads it
 * and nobody is in it, so every viewer is Not involved. `null` for the viewer
 * is a signed-out visitor or a Manager bound to no Team — the board renders
 * in full and every card reads Not involved, because there is no Team for any
 * of the other three to be about.
 *
 * **Contender is tested BEFORE the other two, and only while the contention
 * is LIVE.** Both halves are the rule; the ordering alone is not enough.
 *
 * Ahead of outbid: a Team inside a Minimum-Bid Contention holds a Bid at
 * exactly `MINIMUM_BID` that is not the leading one, so the outbid test would
 * match it — and it has not been outbid, it is waiting on a draw. `attention`
 * marks Outbid and nothing else in this product, so a mislabel there would
 * put the one attention colour on a Team with nothing to answer.
 *
 * Ahead of you-lead: **nobody leads a lottery.** Every Bid in a contention is
 * the same amount, so `leadingBid` names whoever joined earliest purely as
 * the fold's `seq` tiebreak, and AD-14 decides the winner by a seeded draw
 * over the ordered Contender list rather than by that field. Telling the
 * earliest joiner "Leading" would state a standing they do not hold and
 * invite them not to act on an Auction they are no likelier to win than
 * anyone else — the Auction page never makes that claim either, swapping its
 * Leading Bidder line for the contention panel (`auction/[fantraxPlayerId]/+page.svelte:692`).
 *
 * And gated on `contention === 'minimum_bid'`, because `contenders` OUTLIVES
 * the contention: the reducer never clears the list, so a dissolved lottery
 * is `standard` with every former joiner still in it. Ungated, the Team whose
 * raise dissolved it — the Team that now actually leads — reads "Contender",
 * and so does the Team that raise genuinely outbid. The `leading` filter then
 * hides a card the viewer is winning and `contending` shows one with no
 * contention running. `wasDissolved` is the core's predicate for that state;
 * this asks the narrower question the label depends on.
 */
export function viewerStateFor(
	auction: Auction | null,
	viewerTeamId: string | null
): BoardViewerState {
	if (auction === null || viewerTeamId === null) return 'not_involved';
	// Gated on the contention being LIVE, not merely on the list being
	// populated. `contendersFor` derives the Contender list from every
	// historical Bid at exactly `MINIMUM_BID` and the reducer deliberately
	// never clears it — `auctions.ts` says so outright, because the list is
	// what a reveal is about. So a DISSOLVED contention is `standard` with a
	// non-empty list, and an ungated test would tell the Team that converted
	// it, and now genuinely leads, that they are a Contender in a lottery
	// that is no longer running — hiding the card from the `leading` filter
	// on the one surface a Manager scans to decide where to act.
	if (
		auction.contention === 'minimum_bid' &&
		auction.contenders.some((contender) => contender.teamId === viewerTeamId)
	) {
		return 'contender';
	}
	// **A leaderless Auction, and the ONE reading of it every surface takes**
	// (Story 10.3, FR-40). `Auction.leadingBid` is nullable now: a cancellation
	// withdraws the leader's standing, and until Story 10.4 restores one
	// nothing leads even where lower Bids go on standing. There is therefore no
	// current price and no Leading Bidder, and the product already has a
	// treatment for exactly that — the unbid nomination (§10 example 33, which
	// asks for "an ordinary unbid nomination" and not a new "restarted"
	// state). So:
	//
	//  - the BOARD and the AUCTION PAGE print no price and name no bidder,
	//    which is what a null leader already made them do;
	//  - the POSITIONS page has no card to print at all, because every card
	//    there carries a price and there is none — `positions.ts` skips it;
	//  - and the viewer state below stays `outbid` for anyone holding a Bid,
	//    the cancelled ex-leader included. It is not a claim that somebody
	//    outbid them: the state's meaning here is "you bid and you are not
	//    leading", which is true of both, and the card names nobody because
	//    `leadingTeamName` is null. There is no fourth viewer state, and there
	//    must not be one — Story 10.6 words what a cancelled Manager is told,
	//    and it tells them in a notice rather than in a card label.
	if (auction.leadingBid?.teamId === viewerTeamId) return 'you_lead';
	if (auction.bids.some((bid) => bid.teamId === viewerTeamId)) return 'outbid';
	return 'not_involved';
}

/**
 * Where the viewer stands on a CLOSED Auction — and there are exactly two
 * answers.
 *
 * `won` or `not_involved`, and nothing else. "Leading" and "Contender"
 * describe standings a settled Auction no longer holds: nobody leads an
 * Auction that is over, and a Contender in a lottery that has drawn either won
 * it or did not. "Outbid" is the sharpest of the three to get wrong — it is
 * the ONE state `attention` marks anywhere in this product, and putting that
 * colour on a Team that lost an Auction days ago would mark as actionable the
 * one card on the board nobody can act on.
 *
 * This is why `contender`'s half-filled square can never co-occur with the
 * closed square: the only viewer glyphs a closed card can carry are the check
 * and the dash.
 */
export function closedViewerStateFor(
	closed: ClosedAuction,
	viewerTeamId: string | null
): BoardViewerState {
	if (viewerTeamId === null) return 'not_involved';
	return closed.contract.teamId === viewerTeamId ? 'won' : 'not_involved';
}

/**
 * Every card on the board: one per open nomination, plus one per closed
 * Auction.
 *
 * The open set is `openNominations` and never `Object.values(auctions.byPlayer)`,
 * for the reason this module's header gives: a Player Awaiting an Opening Bid
 * has no Auction row, and iterating Auctions would drop exactly that state.
 *
 * The closed set is `closedAuctions` — the CONTRACTS fold, joined to the draws
 * fold by `projection/closed.ts`, which is the same derivation the Auction
 * page's Closed state and Your Positions' won link read. The board does not
 * compose the two folds its own way, and could not: a second composition is a
 * second answer to "what did this Auction come out as".
 *
 * The two sets are disjoint by construction. A close deletes the nomination,
 * and the nomination gate refuses a Player already under contract, so no
 * Player can appear in both loops.
 *
 * `metadata` is a `Map` keyed on the Fantrax player id rather than a
 * `Record`, because the keys are DATA: a plain object probed with `[key]`
 * would read `constructor` back as an inherited function, the trap
 * `nominations.ts`'s own `hasOwn` exists to close. A Player present in the
 * fold but absent from the reference table still renders by name from the
 * fold, with the metadata line omitted.
 *
 * The returned order is ascending `fantraxPlayerId` — deterministic, and
 * deliberately not a presentation order: `sortBoard` is what decides the
 * order a Manager reads, and a caller that skipped it would still get the
 * same list twice rather than one that depends on how the log happened to
 * fold.
 */
export function boardCardsFor(
	nominations: OpenNominations,
	auctions: OpenAuctions,
	contracts: AuctionContracts,
	draws: Draws,
	metadata: ReadonlyMap<string, BoardMetadata>,
	viewerTeamId: string | null
): readonly BoardCard[] {
	const cards: BoardCard[] = [];
	for (const nomination of openNominations(nominations)) {
		const auction = auctionForPlayer(auctions, nomination.fantraxPlayerId);
		const reference = metadata.get(nomination.fantraxPlayerId) ?? null;
		cards.push({
			fantraxPlayerId: nomination.fantraxPlayerId,
			// The reference row's name when there is one; the fold's copy is the
			// fallback for a Player absent from the pool table, which still
			// identifies them rather than dropping the card.
			playerName: reference?.playerName ?? nomination.playerName,
			nbaTeam: reference?.nbaTeam ?? null,
			positions: reference?.positions ?? null,
			// `null` on a leaderless Auction exactly as on an unbid one: the
			// board already renders "no Opening Bid has started a clock" and
			// FR-40's leaderless Auction is that same treatment rather than a
			// new "restarted" state.
			price: auction?.leadingBid?.amount ?? null,
			leadingTeamId: auction?.leadingBid?.teamId ?? null,
			leadingTeamName: auction?.leadingBid?.teamName ?? null,
			leadingManagerId: auction?.leadingBid?.managerId ?? null,
			// `null` is "no clock is running", which is "no Opening Bid has
			// started one" and — since Story 10.3 — "every Bid on this Auction
			// was cancelled, so FR-40 cleared it". It is never "the clock ran
			// out": a closed Auction reaches this list through the loop below,
			// not through this one.
			closesAt: auction?.closesAt ?? null,
			// The ONE mapping of "no Auction row" to a state, from the fold that
			// owns it. Never re-derived from `auction === null` here.
			state: auction === null ? 'awaiting_opening_bid' : auction.contention,
			contenderCount: auction?.contenders.length ?? 0,
			nominatedByTeamId: nomination.teamId,
			nominatedByTeamName: nomination.teamName,
			nominatedByManagerId: nomination.managerId,
			nominatedAt: nomination.occurredAt,
			winningTeamId: null,
			winningTeamName: null,
			winningManagerId: null,
			closedAt: null,
			viewerState: viewerStateFor(auction, viewerTeamId)
		});
	}

	// The closed half, from the ONE derivation every closed surface reads. A
	// second loop rather than a branch inside the first, because the two sets
	// are disjoint by construction and come off different folds: a Player under
	// contract cannot be nominated again (the gate refuses it), and a close
	// deletes the nomination that would otherwise put them in the loop above.
	for (const closed of closedAuctions(contracts, draws)) {
		const reference = metadata.get(closed.fantraxPlayerId) ?? null;
		cards.push({
			fantraxPlayerId: closed.fantraxPlayerId,
			// The reference row survives the close — only `import-promotion.ts`
			// deletes one — so the same precedence applies here, with the
			// CONTRACT's own copy as the fallback rather than the nomination's,
			// which is gone.
			playerName: reference?.playerName ?? closed.contract.playerName,
			nbaTeam: reference?.nbaTeam ?? null,
			positions: reference?.positions ?? null,
			// The winning amount, under `BOARD_FINAL_LABEL` rather than
			// `BOARD_PRICE_LABEL` — the same field so one price sort orders the
			// whole board, a different word because it means something else now.
			price: closed.contract.winningAmount,
			leadingTeamId: null,
			leadingTeamName: null,
			leadingManagerId: null,
			// No clock, and no countdown anywhere on this card. The Auction is
			// over; a timer on it would be an urgency device pointed at nothing.
			closesAt: null,
			state: 'closed',
			contenderCount: 0,
			// Not durable past the close, and never invented — see `BoardCard`.
			nominatedByTeamId: null,
			nominatedByTeamName: null,
			nominatedByManagerId: null,
			nominatedAt: null,
			winningTeamId: closed.contract.teamId,
			winningTeamName: closed.contract.teamName,
			winningManagerId: closed.winningManagerId,
			closedAt: closed.contract.closedAt,
			viewerState: closedViewerStateFor(closed, viewerTeamId)
		});
	}

	return cards.sort((left, right) => compareText(left.fantraxPlayerId, right.fantraxPlayerId));
}

/**
 * Plain code-unit comparison, never `localeCompare`.
 *
 * `Intl` is forbidden in the core precisely because its collation differs
 * across runtimes and versions, and AD-2 needs Node and Deno to agree on
 * every ordering exactly — the reason `byCloseThenPlayer` already gives.
 */
function compareText(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/**
 * The fields a sort reads. Structural, so the pure card and the serialised
 * one the browser holds can both be sorted by this one comparator — `Money`
 * is a compile-time brand that does not survive JSON, and a second sort
 * written for the wire shape would be a second ordering rule.
 */
type Sortable = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly closesAt: string | null;
	readonly price: number | null;
	/** Which TIER the card sorts in — closed is always the last one. */
	readonly state: BoardCardState;
};

/**
 * The board in one of three orders, as a NEW array — the caller's is never
 * sorted in place, because a surface re-deriving on every projection change
 * must not mutate the list it was handed.
 *
 * **Every comparator is total and every one tie-breaks on the Player name,
 * then on the Player id.** Two Auctions legitimately share a close instant
 * (two Bids inside one transaction clock, or a contention's fixed clock) and
 * legitimately share a price (the $500,000 grid makes collisions ordinary),
 * and two different Players can legitimately share a NAME — so a comparator
 * returning 0 would leave the order to `Array.prototype.sort` and, through
 * it, to whatever order the list happened to arrive in. On a surface that
 * re-derives while a Manager is reading it, that is a list that visibly
 * shuffles. The Player id is unique by construction and ends every chain.
 *
 * `closing` is ascending time REMAINING as of `now`, which for a fixed `now`
 * is the same order as ascending close instant — stated in the terms the
 * control offers rather than in the fold's, so the label and the arithmetic
 * agree. A card with no clock (Awaiting an Opening Bid) sorts LAST in that
 * view: it has no time remaining rather than none left, and burying the
 * running Auctions beneath it would be the opposite of what was asked for.
 *
 * `price` is DESCENDING, and a card with no price sorts last for the same
 * reason: a Manager asking to order by price is asking which Auctions are
 * large, and every unbid nomination sharing one absent price would otherwise
 * fill the top of the list. This is an ordering the viewer chose and not a
 * ranking of what is worth bidding on — nothing here says an Auction is worth
 * more attention than another, and no figure on any card moves with it.
 *
 * An unreadable instant sorts as though it had no clock, which is the same
 * direction `hasExpired` takes: an Auction whose close cannot be read is not
 * given a better position than one whose can.
 */
export function sortBoard<T extends Sortable>(
	cards: readonly T[],
	key: BoardSort,
	now: string
): readonly T[] {
	const current = parseInstant(now);
	const remaining = (card: Sortable): number | null => {
		if (card.closesAt === null || current === null) return null;
		const close = parseInstant(card.closesAt);
		return close === null ? null : close - current;
	};

	return [...cards].sort((left, right) => {
		// **Closed is an explicit final tier, and it has to be.** `closing` is
		// ascending time REMAINING, and a closed card carries no clock — so
		// under `compareNullsLast` it would land beside the unbid nominations
		// rather than at the end, and under `price` a large settled Auction
		// would sort straight to the top of a board a Manager is scanning for
		// somewhere to bid. Neither is an ordering anybody asked for. A card
		// that is over sorts beneath every card that is not, in all three
		// views, and the chosen key then orders the closed cards among
		// themselves exactly as it orders the open ones.
		const tier = tierOf(left) - tierOf(right);
		if (tier !== 0) return tier;
		if (key === 'closing') {
			const order = compareNullsLast(remaining(left), remaining(right), 'ascending');
			if (order !== 0) return order;
		} else if (key === 'price') {
			const order = compareNullsLast(left.price, right.price, 'descending');
			if (order !== 0) return order;
		}
		// `name` reaches here directly; the other two reach it as the tie-break
		// that makes them total. One expression, so the fallback cannot differ
		// between the sort that is the Player name and the sorts that end in it.
		const byName = compareText(left.playerName, right.playerName);
		if (byName !== 0) return byName;
		// Two DIFFERENT Players can share a name — the league has had them —
		// and a comparator returning 0 there would hand the pair back to
		// `Array.prototype.sort`, which is free to order them by whatever the
		// input order happened to be. That is the visible reshuffle this
		// module exists to prevent, so the last tie-break is the one key that
		// is unique by construction: `fantrax_player_id` is `unique` on
		// `free_agent_players` and is the id every card is already keyed on.
		return compareText(left.fantraxPlayerId, right.fantraxPlayerId);
	});
}

/**
 * Compare two keys either of which may be absent, with absent always LAST
 * regardless of direction.
 *
 * "Last" rather than "smallest": a card with no clock and a card with no
 * price are both cards with no key at all, and sorting them by direction
 * would put them at the top of one view and the bottom of another for no
 * reason a reader could name.
 */
/** Open cards first, closed cards last. The only two tiers there are. */
function tierOf(card: Sortable): number {
	return card.state === 'closed' ? 1 : 0;
}

function compareNullsLast(
	left: number | null,
	right: number | null,
	direction: 'ascending' | 'descending'
): number {
	if (left === null && right === null) return 0;
	if (left === null) return 1;
	if (right === null) return -1;
	if (left === right) return 0;
	const ascending = left < right ? -1 : 1;
	return direction === 'ascending' ? ascending : -ascending;
}

/** The fields a filter reads. Structural, for `Sortable`'s reason. */
type Filterable = {
	readonly viewerState: BoardViewerState;
	readonly state: BoardCardState;
};

/**
 * The board narrowed to one view, as a NEW array.
 *
 * `all` returns the whole board — not a copy that happens to match, the whole
 * board — because the unfiltered view is the board and hides nothing.
 *
 * `leading` and `contending` each name exactly one viewer state. Outbid is
 * deliberately NOT folded into `contending`: being outbid is a fact about an
 * Auction a Manager has left, and a view that mixed the two would answer
 * neither question. `epics.md` gives the board those filters and Your
 * Positions the grouping that separates them.
 *
 * `open` and `closed` are the two that narrow on the card's own state, added
 * when closed cards arrived on this board: a Manager scanning for somewhere to
 * bid and a Manager looking for a draw to check are asking opposite questions
 * of one list, and neither wants the other's cards in the way.
 */
export function filterBoard<T extends Filterable>(
	cards: readonly T[],
	filter: BoardFilter
): readonly T[] {
	if (filter === 'all') return cards;
	// The two views that narrow on the CARD's state rather than the viewer's.
	// `open` hides closed cards ENTIRELY — it is what a Manager selects to get
	// back the board they had before anything closed, and a "mostly open" view
	// would not be that. `closed` is its complement, which is where a losing
	// Manager goes to find the draw they want to check.
	if (filter === 'open') return cards.filter((card) => card.state !== 'closed');
	if (filter === 'closed') return cards.filter((card) => card.state === 'closed');
	const wanted: BoardViewerState = filter === 'leading' ? 'you_lead' : 'contender';
	return cards.filter((card) => card.viewerState === wanted);
}
