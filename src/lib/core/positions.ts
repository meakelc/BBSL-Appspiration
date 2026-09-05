/**
 * Your Positions: the five groups a Manager wakes up to, and every word each
 * of them says (Story 4.4).
 *
 * **Five groups, in the wake-up's own order, and that order is not a sort.**
 * Won · Outbid · You lead · Contending · Nomination Slot. It is not viewer
 * configurable and there is no control that reorders it, because the order IS
 * the answer to "what happened while I was asleep, and what needs me now" —
 * a sort control would turn a designed reading order into thirty renderings
 * of a list.
 *
 * **The outbid card answers the question before it is asked.** A board card
 * says only *Outbid*; nothing on it tells a Manager whether a legal re-entry
 * even exists, so the only way to learn that a Player is arithmetically gone
 * is to open the Auction and be refused. `reEntryFor` computes that answer
 * per viewer per Auction through `bidControlState` at that Auction's own
 * `minimumLegalBid` — the SAME call `server/auction-page.ts`'s `readBidControl`
 * makes for one Auction, taken N times over one fold. It is AD-1's "one
 * evaluator, two consumers": a card, the Auction page's bid control and the
 * server's refusal cannot disagree, because there is no second predicate for
 * them to disagree through.
 *
 * **Both gates are always reported, never one standing in for the other**
 * (AD-7). `reEntryFor` carries the `cap` and `slots` rows off `bidGateReport`
 * unconditionally — refused and passed alike — so a capacity refusal can
 * never be read as a cap refusal, and a cap refusal always has the capacity
 * outcome stated beside it. That is structural here for the reason it is
 * structural on the Auction page's panel: the rows are built by iterating the
 * declared gate list, not by a template deciding what to show. **Any OTHER
 * gate that refuses is reported too** — a card whose sentence says the Bid is
 * impossible while every row on it says the Bid is fine states the truth and
 * argues with itself, which on a page whose whole purpose is to answer before
 * being asked is the same defect as being wrong.
 *
 * **Every figure is computed at read and transported as a rendering only**
 * (AD-7). Nothing in this module is stored, memoised or cached, and no
 * function here holds state between calls.
 *
 * **Every string the page prints is here.** Where a word already exists it is
 * IMPORTED rather than respelled — the viewer-state labels and icons, the
 * metadata line and the price come from `board.ts`; the contention label, the
 * clock statement and the Contender count come from the fold that decides
 * them; every refusal sentence comes from `rules/bidding.ts`. A synonym in UI
 * copy is a defect the same way a synonym in code is.
 *
 * **No urgency device of any kind.** No "ending soon", no one-tap raise, no
 * suggested amount, no ranking, and no celebration on a won card. The Won
 * group is called **Won** and not "won while you slept": nothing in this
 * codebase records when a Manager last looked, and inventing a last-seen
 * instant would be a storage decision wearing a presentation costume.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { auctionPathFor } from './auction-link.ts';
import {
	VIEWER_STATE_ICONS,
	VIEWER_STATE_LABELS,
	metadataLine,
	priceLabel,
	viewerStateFor
} from './board.ts';
import type { BoardMetadata } from './board.ts';
import { compareMoney } from './money.ts';
import type { Money } from './money.ts';
import {
	CONTENTION_CLOCK_UNMOVED,
	MINIMUM_BID_CONTENTION_LABEL,
	auctionForPlayer,
	contenderCountSentence
} from './projection/auctions.ts';
import type { Auction, ContentionState, OpenAuctions } from './projection/auctions.ts';
import { contractsWonBy } from './projection/contracts.ts';
import type { AuctionContract, AuctionContracts } from './projection/contracts.ts';
import {
	nominationForPlayer,
	nominationForTeam,
	openNominations
} from './projection/nominations.ts';
import type { OpenNominations } from './projection/nominations.ts';
import {
	bidControlState,
	bidGateReport,
	bidRefusalDelta,
	describeAmount,
	evaluate,
	minimumLegalBid
} from './rules/bidding.ts';
import type { BidState } from './rules/bidding.ts';
import { PLACE_BID_GATES } from './types.ts';
import type { PlaceBidGate, PlaceBidGateResults, SlotPlacement } from './types.ts';

/**
 * The five groups. `nomination_slot` is one of them rather than a footer,
 * because a free Nomination Slot is a position a Manager holds exactly as a
 * lead is — it is the one act available to them that costs nothing.
 */
export type PositionsGroup = 'won' | 'outbid' | 'you_lead' | 'contending' | 'nomination_slot';

/**
 * The wake-up's order, frozen. Iterated by the surface, so the page cannot
 * hold an order of its own and a test can assert the sequence as a literal.
 */
export const POSITIONS_GROUP_ORDER: readonly PositionsGroup[] = Object.freeze([
	'won',
	'outbid',
	'you_lead',
	'contending',
	'nomination_slot'
] as const);

/**
 * What each group is called.
 *
 * `outbid` and `you_lead` take `VIEWER_STATE_LABELS`' own words rather than
 * respelling them: the board already calls those two states exactly this, and
 * a heading that said "You're winning" over cards chipped "You lead" would be
 * two names for one state on two surfaces a Manager moves between.
 */
export const GROUP_HEADINGS: Readonly<Record<PositionsGroup, string>> = Object.freeze({
	won: 'Won',
	outbid: VIEWER_STATE_LABELS.outbid,
	you_lead: VIEWER_STATE_LABELS.you_lead,
	contending: 'Contending',
	nomination_slot: 'Nomination Slot'
});

/** The page's own furniture. */
export const POSITIONS_TITLE = 'Your Positions';
export const POSITIONS_WON_LABEL = 'Won for';
export const POSITIONS_PRICE_LABEL = 'Price';
export const POSITIONS_YOUR_BID_LABEL = 'Your Bid';
export const POSITIONS_LEADING_LABEL = 'Leading Bidder';
export const POSITIONS_CLOSES_LABEL = 'Auction Clock';
export const POSITIONS_CLOSED_LABEL = 'Closed';

/** Where the board is, named once, so the page carries no route literal. */
export const BOARD_PATH = '/board';
/** Where nominating is, likewise. */
export const NOMINATE_PATH = '/nominate';

/** What the two links off this page are called. */
export const POSITIONS_BOARD_ACTION = 'Open the board';
export const POSITIONS_NOMINATE_ACTION = 'Nominate a Free Agent';

// --- The re-entry answer ---------------------------------------------------

/**
 * One gate's outcome as this card reports it — the shape `bidGateReport`
 * already returns, narrowed to the two gates a re-entry answer turns on.
 */
export type ReEntryGateRow = {
	readonly gate: PlaceBidGate;
	readonly label: string;
	readonly passed: boolean;
	/** `Cap · Refused`, composed by the core and never by a template. */
	readonly chip: string;
	/** That gate's own arithmetic, as a readout. Never empty. */
	readonly figure: string;
};

/**
 * The two gates every re-entry answer reports, in `PLACE_BID_GATES` order.
 *
 * Both, always: AD-7 forbids reporting a capacity refusal as a cap refusal,
 * and two rows each stating their own arithmetic cannot be read as one.
 */
const ALWAYS_REPORTED_GATES: readonly PlaceBidGate[] = Object.freeze(['cap', 'slots'] as const);

/**
 * The rows one card carries: `cap` and `slots` unconditionally, plus **any
 * other gate that actually refused**.
 *
 * The floor is AD-7's and never moves. The addition closes a contradiction:
 * `bidControlState` blocks on any of the nine `PLACE_BID_GATES`
 * (`types.ts:654-664`), so a paused Phase or an expired-but-unswept Auction
 * used to render "You cannot re-enter at $15.0M" directly above `Cap · Passed`
 * and `Slots · Passed` — every row on the card agreeing the Bid was fine, over
 * a sentence saying it was not. The sentence was right (`bidRefusalDelta`
 * iterates every gate), but a Manager reading two passing rows under a refusal
 * has been shown a card that argues with itself, and this page exists to state
 * the answer rather than to be interpreted.
 *
 * Adding the refusing gate rather than replacing the two keeps the floor
 * intact: the capacity outcome is still stated beside the cap outcome even
 * when neither is the ground of the refusal.
 */
function reportedGates(gates: PlaceBidGateResults): readonly PlaceBidGate[] {
	return PLACE_BID_GATES.filter(
		(gate) => ALWAYS_REPORTED_GATES.includes(gate) || !gates[gate].passed
	);
}

/**
 * Whether a Manager can legally re-enter one Auction, and at what.
 *
 * `nextLegalBid` is an INTEGER rather than a `Money`, for `BoardCardView`'s
 * reason: the brand is a compile-time phantom that does not survive JSON, and
 * a branded field would arrive in the browser as a bare number anyway. The
 * rendering beside it is what the card prints.
 */
export type ReEntry = {
	/** The least this Auction will take from this viewer, in whole dollars. */
	readonly nextLegalBid: number;
	/** That amount, rendered — `describeAmount`, so an off-grid historical high is described rather than mis-spelled. */
	readonly nextLegalBidLabel: string;
	/** Whether the control would refuse to act at that amount. */
	readonly blocked: boolean;
	/** Which gates refused it, in `PLACE_BID_GATES` order. Empty when none did. */
	readonly refusingGates: readonly PlaceBidGate[];
	/** The `cap` and `slots` rows — always both, refused and passed alike. */
	readonly gateRows: readonly ReEntryGateRow[];
	/** The viewer's Maximum Bid, rendered, or `null` when the gate could not compute one. */
	readonly maximumBidLabel: string | null;
	/** The whole answer as one sentence. Never empty. */
	readonly sentence: string;
};

/** Everything `reEntrySentence` words the answer from. */
type ReEntryFacts = Omit<ReEntry, 'sentence'> & { readonly delta: string };

/**
 * The re-entry answer as one finished sentence.
 *
 * **Refused: the delta, verbatim from the core's own refusal wording.**
 * `bidRefusalDelta` is the unframed form — the sentences without "No Bid was
 * placed" in front and "Nothing was written" behind — and it is exactly right
 * here, because on a card nothing was attempted: a Manager reading this has
 * not submitted anything, so the framed form would state two things that did
 * not happen. The cap gate's own sentence already names the offered amount
 * and the Maximum Bid together, which is the matrix's "both figures named, in
 * one sentence"; the capacity gate's own sentence names counts and no money,
 * which is what keeps the two from being read as one.
 *
 * **Legal: the amount, and nothing more.** It states that the Auction will
 * take that amount and stops. No suggestion, no "you should", no second
 * figure a Manager did not ask for — the next legal Bid is a fact about the
 * Auction, and any sentence past it would be advice.
 */
export function reEntrySentence(facts: ReEntryFacts): string {
	if (!facts.blocked) {
		return `The next legal Bid is ${facts.nextLegalBidLabel}, and it is within reach for your Team.`;
	}
	return `You cannot re-enter at ${facts.nextLegalBidLabel}. ${facts.delta}`;
}

/**
 * Whether a Manager may re-enter this Auction, computed the ONE way.
 *
 * `minimumLegalBid` then `bidControlState` at exactly that amount, with
 * `confirmed: true` — `readBidControl`'s call, argument for argument. The
 * confirmation is asserted because a card is not a submit: the question is
 * whether the RULES permit re-entry, and leaving `confirmed` false would
 * answer "no" on every card in the group for a reason that is about a
 * checkbox rather than about the Auction.
 *
 * **`evaluate()` is called a second time and that is not a second
 * derivation.** `bidControlState` runs the gates and reports which refused;
 * the two rows this card must always carry need the gates' own arithmetic,
 * which that shape deliberately does not expose. Both calls take the identical
 * `BidState`, the identical command and the identical `now`, and `evaluate` is
 * pure — so they cannot disagree, and the alternative was a "can they
 * re-enter" predicate of this module's own, which would be the third statement
 * of the gate set and the first to fall out of step with a gate change.
 *
 * A viewer bound to no Team is refused `unbound_actor` by `bidControlState`
 * itself, and no gate runs for them at all — there is no Team for a command to
 * name (AD-4) — so the rows report nothing rather than reporting a Team's
 * arithmetic with no Team.
 */
export function reEntryFor(input: {
	readonly state: BidState;
	readonly fantraxPlayerId: string;
	readonly viewerTeamId: string | null;
	readonly now: string;
}): ReEntry {
	const nextLegal = minimumLegalBid(input.state, input.viewerTeamId);
	const control = bidControlState({
		state: input.state,
		fantraxPlayerId: input.fantraxPlayerId,
		viewerTeamId: input.viewerTeamId,
		amountText: String(nextLegal),
		confirmed: true,
		now: input.now
	});

	const nextLegalBidLabel = describeAmount(nextLegal);

	if (input.viewerTeamId === null) {
		// No Team, so no gate ran and there is no arithmetic to report. The
		// control's own sentence is the whole honest answer.
		const facts: ReEntryFacts = {
			nextLegalBid: Number(nextLegal),
			nextLegalBidLabel,
			blocked: control.blocked,
			refusingGates: control.refusingGates,
			gateRows: [],
			maximumBidLabel: null,
			delta: bidRefusalDelta({ kind: 'unbound_actor' })
		};
		return { ...withoutDelta(facts), sentence: reEntrySentence(facts) };
	}

	const gates = evaluate(
		input.state,
		{
			kind: 'PlaceBid',
			fantraxPlayerId: input.fantraxPlayerId,
			teamId: input.viewerTeamId,
			// Neither is read by any gate — both ride on the command for the
			// event's sake — so a render passes placeholders rather than
			// resolving names for a command it will never append. This is
			// `bidControlState`'s own treatment of the same two fields.
			teamName: '',
			managerId: '',
			amount: nextLegal
		},
		input.now
	);

	const rows = bidGateReport(gates).filter((row) => reportedGates(gates).includes(row.gate));
	const maximumBid = gates.cap.maximumBid;

	const facts: ReEntryFacts = {
		nextLegalBid: Number(nextLegal),
		nextLegalBidLabel,
		blocked: control.blocked,
		refusingGates: control.refusingGates,
		gateRows: rows.map((row) => ({
			gate: row.gate,
			label: row.label,
			passed: row.passed,
			chip: row.chip,
			figure: row.figure
		})),
		// Rendered through `describeAmount` rather than `formatMoney`: a
		// Maximum Bid derived over an off-grid historical amount is off-grid
		// too, and AD-8 has no lossless spelling for one.
		maximumBidLabel: maximumBid === null ? null : describeAmount(maximumBid),
		delta: bidRefusalDelta({ kind: 'gates', gates })
	};
	return { ...withoutDelta(facts), sentence: reEntrySentence(facts) };
}

/** `delta` is an input to the sentence, not a field a surface prints twice. */
function withoutDelta(facts: ReEntryFacts): Omit<ReEntry, 'sentence'> {
	return {
		nextLegalBid: facts.nextLegalBid,
		nextLegalBidLabel: facts.nextLegalBidLabel,
		blocked: facts.blocked,
		refusingGates: facts.refusingGates,
		gateRows: facts.gateRows,
		maximumBidLabel: facts.maximumBidLabel
	};
}

// --- The cards -------------------------------------------------------------

/**
 * What a won Auction says.
 *
 * **No contract years and no salary**: `free_agent_players` carries
 * `player_name`, `positions` and `nba_team` and nothing else, so there is no
 * salary to show. Contract years are absent for a different reason since Story
 * 6.1 widened `AuctionContract.contractYears` to `ContractYears | null`: a
 * length now EXISTS on the contract, but it is the Contract Assignment Phase's
 * business and `/contract-assignment` is the surface that states and changes
 * it. Your Positions is an AUCTION-phase card about what a Team won and what it
 * cost, and a length rendered here would be a fact from the next phase shown
 * beside one from this one. The metadata line is `NBA · POS`, as 4.3 already
 * narrowed it.
 */
export type WonCard = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** `HOU · SG`, or `null` when the Player has no reference row. */
	readonly metadata: string | null;
	/** What the Player was won for. */
	readonly winningAmount: Money;
	readonly winningAmountLabel: string;
	/** What it charges against the Cap. `$0` on a minors placement (AD-23). */
	readonly capHit: Money;
	readonly placement: SlotPlacement;
	/** The placement and the Cap Hit, in words. */
	readonly sentence: string;
	/** The Auction's own persisted expiry — the surface renders it absolutely. */
	readonly closedAt: string;
	/**
	 * **`null` until a closed Auction has a page.**
	 *
	 * A close DELETES the Player from `auctionsReducer` and
	 * `nominationsReducer` (`projection/auctions.ts:806-815`), and
	 * `routes/auction/[fantraxPlayerId]/+page.server.ts:93` raises `error(404)`
	 * on that null read — so `auctionPathFor(...)` on a won Player is a link
	 * to a 404, and the Won group is the FIRST group on the landing page. A
	 * card that names the Player, the amount, the placement and the Cap Hit
	 * already carries everything the close produced; a link that refuses adds
	 * nothing to it and costs the tap that discovers so.
	 *
	 * `deferred-work.md`'s spec-3-6 entry assigns the closed-Auction surface
	 * (winner, amount, placement, and the lottery's seed and Contender list)
	 * to Epic 4. When it exists this becomes `auctionPathFor(...)` and the
	 * surface's `{#if}` falls away — the one place either changes.
	 */
	readonly href: string | null;
};

/** What an Auction the viewer has been outbid on says. */
export type OutbidCard = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly metadata: string | null;
	/** The current price — the leading Bid's own amount. */
	readonly price: Money;
	readonly priceLabel: string;
	/** The viewer's own highest Bid on this Auction, rendered beside the price. */
	readonly yourBid: Money;
	readonly yourBidLabel: string;
	readonly leadingTeamId: string;
	readonly leadingTeamName: string;
	readonly leadingManagerId: string | null;
	readonly closesAt: string;
	readonly contention: ContentionState;
	readonly stateLabel: string;
	readonly stateIcon: string;
	/** Whether a legal re-entry exists, stated before it is asked. */
	readonly reEntry: ReEntry;
	readonly href: string;
};

/** What an Auction the viewer leads says. */
export type LeadCard = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly metadata: string | null;
	readonly price: Money;
	readonly priceLabel: string;
	readonly closesAt: string;
	readonly contention: ContentionState;
	readonly stateLabel: string;
	readonly stateIcon: string;
	/** What the lead commits against the Cap, and when it is released. */
	readonly commitmentSentence: string;
	readonly href: string;
};

/** What a Minimum-Bid Contention the viewer has joined says. */
export type ContendingCard = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly metadata: string | null;
	readonly price: Money;
	readonly priceLabel: string;
	readonly closesAt: string;
	/** Always `minimum_bid` — a dissolved contention is not this group. */
	readonly contention: ContentionState;
	/** The glossary term, from the fold that owns it. */
	readonly contentionLabel: string;
	readonly stateLabel: string;
	readonly stateIcon: string;
	readonly contenderCount: number;
	readonly contenderCountSentence: string;
	/** The statement, in words, that joining does not restart the clock. */
	readonly clockSentence: string;
	readonly href: string;
};

/**
 * The Nomination Slot, used or free.
 *
 * One shape for both states rather than two, because the group renders in
 * both and a `null` card would leave the surface to decide what an absent
 * Nomination Slot means. `nominated` non-`null` is the slot spent.
 */
export type NominationSlotCard = {
	readonly used: boolean;
	readonly fantraxPlayerId: string | null;
	readonly playerName: string | null;
	readonly sentence: string;
	/** The Auction deep link when the slot is spent, `null` when it is free. */
	readonly href: string | null;
};

/** Every group, assembled. The five are always present; any may be empty. */
export type Positions = {
	readonly viewerTeamId: string | null;
	readonly won: readonly WonCard[];
	readonly outbid: readonly OutbidCard[];
	readonly youLead: readonly LeadCard[];
	readonly contending: readonly ContendingCard[];
	readonly nominationSlot: NominationSlotCard;
	/**
	 * Whether the viewer holds nothing at all — no won Auction, no lead, no
	 * outbid and no contention. The Nomination Slot is deliberately NOT part
	 * of this test: a free Slot is what the empty screen points AT, so a
	 * Manager holding only a free Slot is exactly the case the screen is for.
	 */
	readonly empty: boolean;
	/** How many Auctions are open on the whole board — the empty screen's figure. */
	readonly openAuctionCount: number;
};

// --- The wording -----------------------------------------------------------

/**
 * What each placement is called, in the glossary's own words.
 *
 * Exported since Story 4.5. A Team view lists a won Player as a roster row and
 * states where he landed, and `wonCardSentence` below is the sentence that
 * says it — but the Team view also groups its roster by slot kind, and the
 * headings for THAT come from `rules/roster-import.ts`'s `SLOT_LABELS`,
 * because this record is the article-form ("an Active/Bench Slot") a sentence
 * needs and holds no `injury_reserve` entry at all. Two spellings already
 * existed for two registers; Story 4.5 adds neither.
 */
export const PLACEMENT_LABELS: Readonly<Record<SlotPlacement, string>> = Object.freeze({
	active_bench: 'an Active/Bench Slot',
	minor_league: 'a Minor League Slot'
});

/**
 * Where a won Player landed and what it charges, in words.
 *
 * Both facts, always, because they are independent (AD-23): a Minor League
 * placement carries a `$0` Cap Hit while the winning amount stands unchanged,
 * and a card that stated only the amount would let a Manager read a $0 charge
 * as an $11.0M one. No celebration and no exclamation — this is a statement
 * of what the roster now holds.
 */
export function wonCardSentence(placement: SlotPlacement, capHit: Money): string {
	return `Placed in ${PLACEMENT_LABELS[placement]} at a ${describeAmount(capHit)} Cap Hit.`;
}

/**
 * What a lead commits, and when it is released.
 *
 * The release is the half a Manager needs beside the commitment (FR-14:
 * capital is released the instant the Team ceases to lead, not at close), and
 * it is stated on the card rather than left to be inferred from a strip
 * figure that moved.
 *
 * **A per-Auction consequence, never a per-Team figure.** The persistent strip
 * owns Maximum Bid; a card states only what THIS Auction holds.
 */
export function leadCommitmentSentence(amount: Money): string {
	return (
		`${describeAmount(amount)} of your Cap Space is committed while your Bid leads, and ` +
		'released the instant another Team takes the lead.'
	);
}

/**
 * What the Nomination Slot says, spent or free.
 *
 * The free case states the act is free of obligation, because the one thing
 * that stops a Manager spending a Slot at 7:40am is the belief that
 * nominating commits them to bidding. It does not, and FR says so.
 */
export function nominationSlotSentence(playerName: string | null): string {
	if (playerName === null) {
		return 'Your Nomination Slot is free. Nominating a Free Agent does not oblige you to bid on them.';
	}
	return `Your Nomination Slot is spent on ${playerName}, and frees when that Auction ends.`;
}

/** The designed empty screen: what the state is, and where to go from it. */
export const EMPTY_POSITIONS_HEADING = 'You have nothing in play.';
export const EMPTY_POSITIONS_STATEMENT =
	'You lead no Auctions, have not been outbid on any, and are in no Minimum-Bid Contention. ' +
	'Nothing here is wrong — this is what a quiet morning looks like.';

/**
 * The empty screen's own figure: the Nomination Slot's state and how many
 * Auctions are open, in one sentence.
 *
 * The count is of the WHOLE board, which is what makes the screen point
 * somewhere: "nothing of yours, and fourteen Auctions you have not looked at"
 * is a different fact from "nothing of yours, and an empty league".
 */
export function emptyPositionsSentence(slotIsFree: boolean, openAuctionCount: number): string {
	const slot = slotIsFree
		? 'Your Nomination Slot is free.'
		: 'Your Nomination Slot is already spent.';
	if (openAuctionCount === 0) return `${slot} No Auctions are open on the board.`;
	if (openAuctionCount === 1) return `${slot} One Auction is open on the board.`;
	return `${slot} ${String(openAuctionCount)} Auctions are open on the board.`;
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

/**
 * Ascending close instant, tie-broken TOTALLY on the Player id.
 *
 * Every comparator in this codebase is total for `sortBoard`'s reason:
 * several Auctions legitimately share a close instant, and a comparator
 * returning 0 leaves `Array.prototype.sort` free to reorder them between two
 * renders of the same state.
 */
function byCloseThenPlayer(
	left: { readonly closesAt: string; readonly fantraxPlayerId: string },
	right: { readonly closesAt: string; readonly fantraxPlayerId: string }
): number {
	if (left.closesAt !== right.closesAt) return compareText(left.closesAt, right.closesAt);
	return compareText(left.fantraxPlayerId, right.fantraxPlayerId);
}

/** The Player's name: the reference row's, then the fold's, then the id. */
function nameFor(
	metadata: ReadonlyMap<string, BoardMetadata>,
	nominations: OpenNominations,
	fantraxPlayerId: string,
	fallback: string | null
): string {
	const reference = metadata.get(fantraxPlayerId);
	if (reference !== undefined) return reference.playerName;
	const nomination = nominationForPlayer(nominations, fantraxPlayerId);
	if (nomination !== null) return nomination.playerName;
	return fallback ?? fantraxPlayerId;
}

/** `HOU · SG`, or `null` when the Player has no reference row. */
function metadataFor(
	metadata: ReadonlyMap<string, BoardMetadata>,
	fantraxPlayerId: string
): string | null {
	const reference = metadata.get(fantraxPlayerId) ?? null;
	if (reference === null) return null;
	return metadataLine(reference.nbaTeam, reference.positions);
}

/**
 * The viewer's own highest Bid on one Auction, or `null` when they have none.
 *
 * The HIGHEST rather than the latest: a Team's standing offer on an Auction it
 * no longer leads is the most it put up, and `bids` is ordered by `seq` rather
 * than by amount, so "the last one they placed" and "the most they offered"
 * are only the same number by coincidence of the increment rule.
 */
function highestBidBy(auction: Auction, teamId: string): Money | null {
	let highest: Money | null = null;
	for (const bid of auction.bids) {
		if (bid.teamId !== teamId) continue;
		if (highest === null || compareMoney(bid.amount, highest) > 0) highest = bid.amount;
	}
	return highest;
}

/**
 * Where the viewer stands on one Auction — `board.ts`'s `viewerStateFor`
 * itself, mapped onto the group this module places a card in.
 *
 * It DELEGATES rather than restating the three ordered tests, because that
 * ordering is a rule with a review finding behind it: `contenders` OUTLIVES
 * the contention, so a dissolved lottery is `standard` with every former
 * joiner still listed, and the contention test is therefore gated on the
 * contention being LIVE. Ungated, the Team whose raise dissolved it would
 * appear under Contending rather than under You lead, and the Team that raise
 * genuinely outbid would appear there too — both waiting on a draw that is
 * not running. Restating those tests here would put two copies of that
 * ordering in the core, and a later correction to one would silently leave
 * the other wrong. The board and this surface now cannot disagree about where
 * a Manager stands, by construction.
 *
 * `not_involved` maps to `null`: the viewer holds nothing on this Auction, so
 * it belongs in no group at all.
 */
function groupFor(auction: Auction, viewerTeamId: string): PositionsGroup | null {
	switch (viewerStateFor(auction, viewerTeamId)) {
		case 'contender':
			return 'contending';
		case 'you_lead':
			return 'you_lead';
		case 'outbid':
			return 'outbid';
		case 'not_involved':
			return null;
	}
}

/**
 * Every group, for one viewer, off one fold.
 *
 * `reEntryFor` is a CALLBACK rather than something this module computes,
 * because the answer needs `TeamMoneyState` — Cap Space, Roster Count and
 * Minor League occupancy — which only `team_rosters` can answer and which the
 * core may never read (AD-2). The server hands in a function that narrows the
 * folds exactly as `server/bidding.ts:274-302` does and calls `reEntryFor`
 * above; this module decides only which Auctions to ask about.
 *
 * **`viewerTeamId` of `null` yields five empty groups.** The route refuses
 * such a request with `requireLiveDestination`'s 403 before this is reached,
 * so it is unreachable in production — but a total function must answer, and
 * the honest answer is that a viewer with no Team holds no positions. It is
 * never a group rendered against a null Team.
 */
export function positionsFor(input: {
	readonly nominations: OpenNominations;
	readonly auctions: OpenAuctions;
	readonly contracts: AuctionContracts;
	readonly metadata: ReadonlyMap<string, BoardMetadata>;
	readonly viewerTeamId: string | null;
	/** The re-entry answer for one outbid Auction, computed by the caller. */
	readonly reEntryFor: (fantraxPlayerId: string) => ReEntry;
}): Positions {
	const openAuctionCount = openNominations(input.nominations).length;
	const viewerTeamId = input.viewerTeamId;

	if (viewerTeamId === null) {
		return {
			viewerTeamId: null,
			won: [],
			outbid: [],
			youLead: [],
			contending: [],
			nominationSlot: {
				used: false,
				fantraxPlayerId: null,
				playerName: null,
				sentence: nominationSlotSentence(null),
				href: null
			},
			empty: true,
			openAuctionCount
		};
	}

	const won: WonCard[] = contractsWonBy(input.contracts, viewerTeamId).map(
		(contract: AuctionContract) => ({
			fantraxPlayerId: contract.fantraxPlayerId,
			// The reference row's name wins; the contract's own copy is the
			// fallback for a Player absent from the pool table, which still
			// identifies them rather than dropping a Player the Team owns.
			playerName: nameFor(
				input.metadata,
				input.nominations,
				contract.fantraxPlayerId,
				contract.playerName
			),
			metadata: metadataFor(input.metadata, contract.fantraxPlayerId),
			winningAmount: contract.winningAmount,
			winningAmountLabel: describeAmount(contract.winningAmount),
			capHit: contract.capHit,
			placement: contract.placement,
			sentence: wonCardSentence(contract.placement, contract.capHit),
			closedAt: contract.closedAt,
			// No link: a closed Auction has no page yet, and the Won group is
			// the first thing on the landing. See `WonCard.href`.
			href: null
		})
	);

	const outbid: OutbidCard[] = [];
	const youLead: LeadCard[] = [];
	const contending: ContendingCard[] = [];

	// Sorted keys (AD-5): the iteration feeds three ordered lists, and an
	// incidental key order would be an incidental input to each of them.
	for (const playerId of Object.keys(input.auctions.byPlayer).sort()) {
		const auction = auctionForPlayer(input.auctions, playerId);
		if (auction === null) continue;
		const group = groupFor(auction, viewerTeamId);
		if (group === null) continue;

		const playerName = nameFor(input.metadata, input.nominations, playerId, null);
		const metadata = metadataFor(input.metadata, playerId);
		const price = auction.leadingBid.amount;

		if (group === 'contending') {
			contending.push({
				fantraxPlayerId: playerId,
				playerName,
				metadata,
				price,
				priceLabel: priceLabel(price),
				closesAt: auction.closesAt,
				contention: auction.contention,
				contentionLabel: MINIMUM_BID_CONTENTION_LABEL,
				stateLabel: VIEWER_STATE_LABELS.contender,
				stateIcon: VIEWER_STATE_ICONS.contender,
				contenderCount: auction.contenders.length,
				contenderCountSentence: contenderCountSentence(auction.contenders.length),
				clockSentence: CONTENTION_CLOCK_UNMOVED,
				href: auctionPathFor(playerId)
			});
			continue;
		}

		if (group === 'you_lead') {
			youLead.push({
				fantraxPlayerId: playerId,
				playerName,
				metadata,
				price,
				priceLabel: priceLabel(price),
				closesAt: auction.closesAt,
				contention: auction.contention,
				stateLabel: VIEWER_STATE_LABELS.you_lead,
				stateIcon: VIEWER_STATE_ICONS.you_lead,
				commitmentSentence: leadCommitmentSentence(price),
				href: auctionPathFor(playerId)
			});
			continue;
		}

		// `outbid` is reached only when the viewer holds a Bid on this
		// Auction, so `highestBidBy` cannot be null here — the fallback keeps
		// the function total without inventing an amount nobody offered.
		const yourBid = highestBidBy(auction, viewerTeamId);
		if (yourBid === null) continue;
		outbid.push({
			fantraxPlayerId: playerId,
			playerName,
			metadata,
			price,
			priceLabel: priceLabel(price),
			yourBid,
			yourBidLabel: describeAmount(yourBid),
			leadingTeamId: auction.leadingBid.teamId,
			leadingTeamName: auction.leadingBid.teamName,
			leadingManagerId: auction.leadingBid.managerId,
			closesAt: auction.closesAt,
			contention: auction.contention,
			stateLabel: VIEWER_STATE_LABELS.outbid,
			stateIcon: VIEWER_STATE_ICONS.outbid,
			reEntry: input.reEntryFor(playerId),
			href: auctionPathFor(playerId)
		});
	}

	const nomination = nominationForTeam(input.nominations, viewerTeamId);
	const nominationSlot: NominationSlotCard =
		nomination === null
			? {
					used: false,
					fantraxPlayerId: null,
					playerName: null,
					sentence: nominationSlotSentence(null),
					href: null
				}
			: {
					used: true,
					fantraxPlayerId: nomination.fantraxPlayerId,
					playerName: nameFor(
						input.metadata,
						input.nominations,
						nomination.fantraxPlayerId,
						nomination.playerName
					),
					sentence: nominationSlotSentence(
						nameFor(
							input.metadata,
							input.nominations,
							nomination.fantraxPlayerId,
							nomination.playerName
						)
					),
					href: auctionPathFor(nomination.fantraxPlayerId)
				};

	return {
		viewerTeamId,
		won,
		outbid: outbid.sort(byCloseThenPlayer),
		youLead: youLead.sort(byCloseThenPlayer),
		contending: contending.sort(byCloseThenPlayer),
		nominationSlot,
		empty:
			won.length === 0 && outbid.length === 0 && youLead.length === 0 && contending.length === 0,
		openAuctionCount
	};
}
