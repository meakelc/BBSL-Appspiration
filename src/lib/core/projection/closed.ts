/**
 * The Closed state of an Auction — the ONE derivation the three surfaces that
 * render it all read.
 *
 * **A composition, never a fourth fold.** Everything a closed Auction is made
 * of is already folded: `contractsReducer` records the winner, the amount, the
 * Cap Hit, the placement and the Auction's own expiry, and `drawsReducer`
 * records the seed, the published commitment, the ordered Contender list and
 * the selection. Both survive the close that DELETES the Player from
 * `auctionsReducer` and `nominationsReducer` — that survival is the whole
 * reason `draws.ts` exists — so the Closed state needs no new event, no
 * migration and no change to either fold. What it needed was somewhere for the
 * two to be put together exactly once.
 *
 * **The contract is what makes an Auction closed; the draw is decoration.**
 * `closedAuctionFor` returns `null` unless a contract exists, so a
 * `ContentionDrawn` with no `AuctionClosed` behind it is not a Closed Auction
 * and no surface renders one. A draw alone means a lottery selected somebody
 * and the close never recorded — a corrupt or half-written log — and inventing
 * a winner from it would put a Player on a roster nothing says they are on.
 *
 * **Why this module and not `positions.ts`.** The placement wording lived
 * there, and `board.ts` needs it now: a Closed board card states where the
 * Player landed in the same sentence Your Positions has always used. But
 * `positions.ts` IMPORTS `board.ts`, so `board.ts` importing it back would
 * close a cycle. The wording therefore moves HERE, beside the composition
 * that is its subject, and `positions.ts` and `team-view.ts` import it from
 * here — one spelling of one sentence, reachable from every surface.
 *
 * **Terminated is not here.** `AuctionTerminated` records a Player id and no
 * reason at all, so nothing durable distinguishes "nobody bid" from an
 * override, and a card claiming either would be inventing the half the log
 * does not carry. It stays deferred until an override can append a reason.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import type { Money } from '../money.ts';
import { describeAmount } from '../rules/bidding.ts';
import type { RosterPlacement } from '../types.ts';
import { contractForPlayer } from './contracts.ts';
import type { AuctionContract, AuctionContracts } from './contracts.ts';
import { drawForPlayer } from './draws.ts';
import type { Draw, Draws } from './draws.ts';

/**
 * One Auction that has closed — the contract, and the draw if a lottery
 * decided it.
 *
 * **The two folds are carried whole rather than flattened.** Each already has
 * a documented shape a reader can check against the log, and re-spelling their
 * fields into a third would make three shapes that must be kept in step for no
 * gain. What this type adds is the JOIN and the two answers a surface would
 * otherwise re-derive: whether a lottery decided it, and which Manager to name
 * beside the winning Team.
 *
 * `contenders` is deliberately NOT here: it is on the draw, it is Team IDS
 * (`draws.ts:88`), and turning ids into names is a `teams` lookup, which is
 * I/O and cannot happen in the core. Every surface that prints the list
 * resolves the names itself and never re-orders what it gets back — AD-14
 * makes ascending join `seq` an input to the winner, so a re-sorted list is a
 * different list from the one the draw ran over.
 */
export type ClosedAuction = {
	readonly fantraxPlayerId: string;
	/** The close's own record: winner, amount, Cap Hit, placement, expiry. */
	readonly contract: AuctionContract;
	/**
	 * The lottery that decided it, or `null` for an ordinary Standard close.
	 *
	 * Both draw kinds reach here. `drawn` is the ordinary reveal; `undrawn` is
	 * the lottery FR-40's cascade emptied before it could run, which is a real
	 * recorded outcome and not a rejected row — the commitment is discharged
	 * whatever the list came out as, so the seed is shown either way.
	 */
	readonly draw: Draw | null;
	/**
	 * The Manager to name beside the winning Team, or `null`.
	 *
	 * A `DrawnDraw` carries the Manager whose joining Bid put the winning Team
	 * in the lottery, and `AuctionContract` carries none at all — the close
	 * records the winning TEAM, and `contracts.ts` is on this spec's reuse list
	 * rather than its change list. So a lottery win can name a Manager and a
	 * Standard win names the Team alone, which is the same "Team known, Manager
	 * unknown" fallback every other surface in this app already renders. It is
	 * never filled in from anywhere else: a Manager id borrowed from a
	 * different record would name a person who was not there.
	 */
	readonly winningManagerId: string | null;
};

/**
 * The Closed state of one Player's Auction, or `null` when there is none.
 *
 * `null` covers three different histories on purpose — never nominated,
 * nominated and still open, and drawn but never closed — because a surface
 * that could tell them apart would be telling a prober which one they hit. The
 * caller renders one 404 for all three.
 */
export function closedAuctionFor(
	contracts: AuctionContracts,
	draws: Draws,
	fantraxPlayerId: string
): ClosedAuction | null {
	const contract = contractForPlayer(contracts, fantraxPlayerId);
	if (contract === null) return null;
	const draw = drawForPlayer(draws, fantraxPlayerId);
	return {
		fantraxPlayerId: contract.fantraxPlayerId,
		contract,
		draw,
		// **Two folds, cross-checked before they are composed.**
		// `winningManagerId` comes off `ContentionDrawn` and `teamId` off the
		// `AuctionClosed` beside it, so this is the one place two separately
		// read payloads are joined into a single claim about one person. The
		// SQL that resolves a bidder on the Auction page asserts the same
		// pairing in its join (`m.team_id = t.id`) rather than trusting two
		// ids to agree, and a pure composition owes the same check.
		//
		// A divergence is only reachable from a corrupt or hand-written log —
		// `decideClose` writes both events in one transaction from one
		// decision — but the consequence of trusting it is naming the WRONG
		// MANAGER as the winner of a Player, on the page a losing Manager
		// opened specifically to check who won. So the Manager is dropped
		// rather than the record: the Team still won, `contract.teamName`
		// still says so, and the surface falls back to naming the Team alone
		// exactly as it does for an ordinary Standard close that records no
		// Manager at all. Total and non-throwing, `readDrawnFacts`' own
		// discipline for a payload an insert-only log cannot correct.
		winningManagerId:
			draw !== null && draw.kind === 'drawn' && draw.winningTeamId === contract.teamId
				? draw.winningManagerId
				: null
	};
}

/**
 * Every closed Auction this log has produced, in ascending `fantraxPlayerId`.
 *
 * Deterministic and deliberately NOT a presentation order — `sortBoard` is
 * what decides the order a Manager reads, exactly as it is for the open cards
 * this list joins on the board. Keys are iterated sorted (AD-5) so the input
 * to that sort is itself a sequence rather than an incidental object key
 * order.
 *
 * The set is the CONTRACTS and never the draws, for `closedAuctionFor`'s
 * reason: a draw with no close behind it is not a closed Auction.
 */
export function closedAuctions(contracts: AuctionContracts, draws: Draws): readonly ClosedAuction[] {
	const closed: ClosedAuction[] = [];
	for (const playerId of Object.keys(contracts.byPlayer).sort()) {
		const one = closedAuctionFor(contracts, draws, playerId);
		if (one === null) continue;
		closed.push(one);
	}
	return closed;
}

// --- The wording -----------------------------------------------------------

/**
 * What a Closed Auction is called, on a card and at the head of its page.
 *
 * One word, and a plain one. A closed Auction is a settled fact, so nothing
 * here congratulates: `Won` would be a claim about the reader on a card thirty
 * Managers read, and `Sold` is a vocabulary this league does not use.
 */
export const CLOSED_LABEL = 'Closed';

/**
 * The same name for a NARROW viewport, where it does not change.
 *
 * A complete entry rather than an override, for `AUCTION_STATE_LABELS_NARROW`'s
 * reason — a surface indexes ONE record by the state it holds and cannot fall
 * through to a missing key. `Closed` is already as short as it goes, and
 * inventing a second spelling for it would be a synonym nobody asked for.
 */
export const CLOSED_LABEL_NARROW = 'Closed';

/**
 * What each placement is called, in the glossary's own words.
 *
 * Relocated here from `positions.ts` (unchanged) so `board.ts` can reach it
 * without the import cycle that module would close. A Team view lists a won
 * Player as a roster row and states where he landed, Your Positions states it
 * on the won card, and a Closed Auction states it on the card AND on the page
 * — one record, four readers.
 *
 * It is the article-form ("an Active/Bench Slot") a sentence needs; the
 * slot-kind HEADINGS a Team view groups by come from
 * `rules/roster-import.ts`'s `SLOT_LABELS`. Two spellings for two registers.
 *
 * **It holds all three placements, and the third is not reachable from a
 * close.** A won Contract lands in Active/Bench or Minor League and nothing
 * else; it reaches Injury Reserve only by a Roster Move recorded afterwards
 * (FR-44), and the sentence below is the one a Team view prints for that
 * Contract's row. Keyed on `RosterPlacement` rather than `SlotPlacement` so
 * the record is total over what a Contract can actually be sitting in —
 * `dead_money` is still absent, because it is a charge and not a Slot and
 * nothing was ever *placed* there.
 */
export const PLACEMENT_LABELS: Readonly<Record<RosterPlacement, string>> = Object.freeze({
	active_bench: 'an Active/Bench Slot',
	injury_reserve: 'an Injury Reserve Slot',
	minor_league: 'a Minor League Slot'
});

/**
 * Where a won Player landed and what it charges, in words.
 *
 * Both facts, always, because they are independent (AD-23): a Minor League
 * placement carries a `$0` Cap Hit while the winning amount stands unchanged,
 * and a sentence that stated only the amount would let a Manager read a $0
 * charge as an $11.0M one. No celebration and no exclamation — this is a
 * statement of what the roster now holds.
 */
export function wonCardSentence(placement: RosterPlacement, capHit: Money): string {
	return `Placed in ${PLACEMENT_LABELS[placement]} at a ${describeAmount(capHit)} Cap Hit.`;
}

/**
 * What a lottery whose every Contender was cancelled before it drew says.
 *
 * The record is real and the page must not hide it (`draws.ts`'s `UndrawnDraw`
 * says why): a Manager who wrote down the commitment when the lottery opened
 * is owed the revealed seed whatever the list came out as, and a surface that
 * dropped an emptied lottery would leave them with nothing to check it
 * against. So the seed and the commitment are printed exactly as they are for
 * a drawn lottery, and this sentence states the one thing that differs.
 *
 * It states what happened and nothing about why: FR-40's cascade is what
 * empties a lottery, and naming the causing Auction here would be a second
 * telling of a story the cancelled Managers were already told on their own
 * cards.
 */
export const EMPTIED_LOTTERY_STATEMENT =
	'Every Contender was cancelled before the draw ran, so the list was empty and no Team was ' +
	'selected. The seed is revealed anyway: the commitment stands whatever the list came out as.';

/**
 * The three labels the lottery block on a Closed page puts beside its values.
 *
 * Named for what each IS rather than for where it came from: a Manager
 * checking a draw is holding a hash they wrote down when the lottery opened
 * and looking for the value it commits to, so the two lines say `Published
 * commitment` and `Revealed seed` in that order and in those words. `Selected`
 * marks the one position the reduction produced.
 */
export const SEED_COMMITMENT_LABEL = 'Published commitment';
export const SEED_REVEALED_LABEL = 'Revealed seed';
export const SELECTED_CONTENDER_LABEL = 'Selected';

/**
 * The shape beside `SELECTED_CONTENDER_LABEL`, and emphatically NOT the won
 * glyph.
 *
 * `VIEWER_STATE_ICONS.won` is a ledger mark meaning "this one is settled and
 * IT IS YOURS" — a claim about the READER. This mark says something else
 * entirely: "the reduction landed here", a fact about the LIST. The two are
 * one tap apart, because a closed lottery is reached from a board card that
 * carries the won glyph, and the Manager most likely to make that journey is
 * the one who LOST — AD-14's whole reader. Printing `✓` against another
 * Team's row would tell them they won a Player they did not.
 *
 * A right-pointing triangle: the position the draw arrived at, pointing INTO
 * the row rather than ticking it off. Disjoint from every glyph it can appear
 * near — `AUCTION_STATE_ICONS`' `○ ● ◆ ■` and `VIEWER_STATE_ICONS`'
 * `▲ ▼ ◧ – ✓` — so a greyscale reading of the list is unambiguous, and
 * deliberately not `▲`, which already means "you lead" one surface away.
 */
export const SELECTED_CONTENDER_ICON = '▶';

/** The path of the page that states how to check a draw by hand. */
export const VERIFY_PATH = '/verify';

/**
 * The invitation to check the draw — the link a losing Manager came for.
 *
 * `/verify` states the procedure and holds no league data at all, so it can
 * only ever be run against values a Manager reads somewhere else. Until this
 * page existed there was nowhere to read them: the open Auction page prints
 * neither the seed nor the commitment, and a closed Auction had no page. This
 * is the sentence that joins the two.
 */
export const VERIFY_INVITATION = 'How to check this draw yourself';

/**
 * Which position in the Contender list the draw selected, as a sentence.
 *
 * Stated as a POSITION and not only as a name, because the number is what a
 * Manager running the procedure has in hand: `/verify` produces an index, and
 * the record they check it against must be an index too rather than a lookup
 * they have to perform correctly first (`draws.ts` says exactly this about
 * `selectedIndex`). One-based in the sentence and zero-based in the record,
 * because the list beside it is read by eye and nobody counts from zero.
 */
export function selectedPositionSentence(selectedIndex: number, total: number): string {
	return `The draw selected position ${String(selectedIndex + 1)} of ${String(total)}.`;
}
