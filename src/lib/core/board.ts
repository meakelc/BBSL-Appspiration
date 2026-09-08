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
import { MINIMUM_LOTTERY_LABEL, auctionForPlayer } from './projection/auctions.ts';
import type { Auction, ContentionState, OpenAuctions } from './projection/auctions.ts';
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
export type BoardViewerState = 'you_lead' | 'outbid' | 'contender' | 'not_involved';

/** The three orderings the board offers. */
export type BoardSort = 'closing' | 'price' | 'name';

/** The three views the board offers. `all` hides nothing. */
export type BoardFilter = 'all' | 'leading' | 'contending';

/** The sorts, in the order the control offers them. */
export const SORT_KEYS: readonly BoardSort[] = Object.freeze(['closing', 'price', 'name'] as const);

/** The filters, in the order the control offers them. `all` is the default. */
export const FILTER_KEYS: readonly BoardFilter[] = Object.freeze([
	'all',
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
	/** The current price — the leading Bid's amount, or `null` before one. */
	readonly price: Money | null;
	readonly leadingTeamId: string | null;
	readonly leadingTeamName: string | null;
	readonly leadingManagerId: string | null;
	/** The Auction Clock's absolute expiry, or `null` before the first Bid. */
	readonly closesAt: string | null;
	readonly contention: ContentionState;
	readonly contenderCount: number;
	readonly nominatedByTeamId: string;
	readonly nominatedByTeamName: string;
	readonly nominatedByManagerId: string | null;
	readonly nominatedAt: string;
	readonly viewerState: BoardViewerState;
};

/**
 * The three Auction states, in words — and these three only.
 *
 * There is no Closed and no Terminated member because `ContentionState` has
 * none: a close removes the Auction from this projection entirely, so the
 * board cannot answer for one, and inventing a label here would promise a
 * card that can never be built.
 *
 * `minimum_bid` reuses `MINIMUM_LOTTERY_LABEL` from the fold that decides it
 * rather than respelling it — the card name, not the glossary term, because a
 * board card's identity row is scanned beside a Player's name and cannot carry
 * the full term at 375px. The term itself still stands on the Auction page
 * this card links to.
 */
export const AUCTION_STATE_LABELS: Readonly<Record<ContentionState, string>> = Object.freeze({
	awaiting_opening_bid: 'Awaiting Opening Bid',
	standard: 'Open',
	minimum_bid: MINIMUM_LOTTERY_LABEL
});

/**
 * The SHAPE beside each state's word.
 *
 * No state in this product may be conveyed by colour alone, so every chip
 * carries an icon and a word together and a greyscale screenshot reads
 * identically. They are declared here, beside the words, so the pairing is
 * one fact rather than two that could drift in a template.
 */
export const AUCTION_STATE_ICONS: Readonly<Record<ContentionState, string>> = Object.freeze({
	// An open circle: a clock that has not started.
	awaiting_opening_bid: '\u25CB',
	// A filled circle: an Auction that is running.
	standard: '\u25CF',
	// The diamond the Auction page already gives a Minimum-Bid Contention.
	minimum_bid: '\u25C6'
});

/** Where the viewer stands, in words. */
export const VIEWER_STATE_LABELS: Readonly<Record<BoardViewerState, string>> = Object.freeze({
	you_lead: 'You lead',
	outbid: 'Outbid',
	contender: 'Contender',
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
 */
export const VIEWER_STATE_ICONS: Readonly<Record<BoardViewerState, string>> = Object.freeze({
	you_lead: '\u25B2',
	outbid: '\u25BC',
	contender: '\u25E7',
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
	leading: 'You lead',
	contending: 'Contending'
});

/** The board's own furniture: the title, the two control legends, the labels. */
export const BOARD_TITLE = 'Bid Board';
export const BOARD_SORT_LEGEND = 'Sort';
export const BOARD_FILTER_LEGEND = 'Filter';
export const BOARD_PRICE_LABEL = 'Price';
export const BOARD_LEADING_LABEL = 'Leading Bidder';
export const BOARD_NOMINATED_LABEL = 'Nominated by';
export const BOARD_CLOSES_LABEL = 'Auction Clock';

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
 * The count of the WHOLE board, never of a filtered view — the filtered view
 * states its own count through `filteredNoticeSentence` above, and one
 * sentence that meant either depending on view state would be the figure that
 * silently changed when a Manager touched a control.
 */
export function boardCountSentence(count: number): string {
	if (count === 0) return 'No Auctions are open.';
	if (count === 1) return 'One Auction is open.';
	return `${String(count)} Auctions are open.`;
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
 * earliest joiner "You lead" would state a standing they do not hold and
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
	if (auction.leadingBid.teamId === viewerTeamId) return 'you_lead';
	if (auction.bids.some((bid) => bid.teamId === viewerTeamId)) return 'outbid';
	return 'not_involved';
}

/**
 * Every card on the board, one per open nomination.
 *
 * The set is `openNominations` and never `Object.values(auctions.byPlayer)`,
 * for the reason this module's header gives: a Player Awaiting an Opening Bid
 * has no Auction row, and iterating Auctions would drop exactly that state.
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
			price: auction === null ? null : auction.leadingBid.amount,
			leadingTeamId: auction?.leadingBid.teamId ?? null,
			leadingTeamName: auction?.leadingBid.teamName ?? null,
			leadingManagerId: auction?.leadingBid.managerId ?? null,
			// `null` is "no Opening Bid has started a clock", never "the clock ran
			// out" — a closed Auction is absent from this projection entirely.
			closesAt: auction?.closesAt ?? null,
			// The ONE mapping of "no Auction row" to a state, from the fold that
			// owns it. Never re-derived from `auction === null` here.
			contention: auction === null ? 'awaiting_opening_bid' : auction.contention,
			contenderCount: auction?.contenders.length ?? 0,
			nominatedByTeamId: nomination.teamId,
			nominatedByTeamName: nomination.teamName,
			nominatedByManagerId: nomination.managerId,
			nominatedAt: nomination.occurredAt,
			viewerState: viewerStateFor(auction, viewerTeamId)
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
type Filterable = { readonly viewerState: BoardViewerState };

/**
 * The board narrowed to one view, as a NEW array.
 *
 * `all` returns the whole board — not a copy that happens to match, the whole
 * board — because the unfiltered view is the board and hides nothing.
 *
 * `leading` and `contending` each name exactly one viewer state. Outbid is
 * deliberately NOT folded into `contending`: being outbid is a fact about an
 * Auction a Manager has left, and a view that mixed the two would answer
 * neither question. `epics.md` gives the board three filters and Your
 * Positions the grouping that separates them.
 */
export function filterBoard<T extends Filterable>(
	cards: readonly T[],
	filter: BoardFilter
): readonly T[] {
	if (filter === 'all') return cards;
	const wanted: BoardViewerState = filter === 'leading' ? 'you_lead' : 'contender';
	return cards.filter((card) => card.viewerState === wanted);
}
