/**
 * The nomination gate: the refusals it can return, the one sentence each of
 * them has, and the consequence of confirming. Pure (Story 2.1).
 *
 * Three rules live here and nowhere else:
 *
 *   1. **Everything blocking is NAMED, never counted.** A Manager refused at
 *      a nomination cannot act on "your Slot is in use"; they can act on
 *      "your Slot is held by your nomination of Jalen Green". Every refusal
 *      below names the Player, the Team, or both — `auction-open.ts`'s
 *      naming rule, applied to the first Manager-facing gate of the auction.
 *   2. **A nomination commits nothing.** No cap space is reserved, no
 *      Leading Bidder is set, no Auction Clock starts. That is why a Team
 *      with no cap space at all nominates successfully: there is no
 *      arithmetic here to fail. `NOMINATION_CONSEQUENCE` states the one
 *      thing that IS committed — the Slot.
 *   3. **The order of the gates is the order of the honest answer.** Phase
 *      first, because outside the Auction Phase which Player was named is
 *      beside the point; then the Player's existence, because everything
 *      after it names that Player; then the two ways a Player can be
 *      unavailable; then the actor's own Slot.
 *
 * `nominationRefusalDetail` mirrors `auction-open.ts`'s
 * `auctionOpenRefusalDetail` exactly: the route, the transaction and the
 * tests read ONE wording per refusal.
 *
 * **This gate deliberately admits a check-then-write gap.** It reads the
 * board, decides, and appends, all under the global advisory lock — which is
 * what makes it correct today, with one writer. Story 2.2 closes the gap at
 * the data layer with a uniqueness constraint and proves it with a
 * concurrency test; that is its build, not this one's.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import type { OpenNominations } from '../projection/nominations.ts';
import { nominationForPlayer, nominationForTeam } from '../projection/nominations.ts';
import type { LeaguePhase } from '../projection/phase.ts';

/** The Player being nominated, as the live pool states them. */
export type NominatablePlayer = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
};

/**
 * Everything the gate decides from.
 *
 * `phase` and `nominations` are folds of the log; `poolPlayer` and
 * `contractHolderTeamName` are reads of the live reference tables
 * (`free_agent_players`, `team_rosters`) — mutable data that is not
 * event-sourced (`20260824020000_live_reference_tables.sql`). All four are
 * gathered on the same locked transaction's client, so they cannot disagree
 * about the moment they describe.
 *
 * `poolPlayer` is `null` when the named `fantraxPlayerId` matches no pool
 * row at all; `contractHolderTeamName` is `null` when the Player sits on no
 * Team's roster AND has been won by nobody in this auction, which is the
 * ordinary case for a Free Agent. The caller resolves it from the two sources
 * — `team_rosters` and the `AuctionContracts` fold — so this gate reads one
 * answer and has no notion of which produced it (Story 3.4).
 */
export type NominationState = {
	readonly phase: LeaguePhase;
	readonly nominations: OpenNominations;
	readonly poolPlayer: NominatablePlayer | null;
	readonly contractHolderTeamName: string | null;
};

/**
 * Why a nomination was refused.
 *
 * Five of the eight are re-derived INSIDE the transaction, under the lock:
 * `phase`, `unknown_player`, `under_contract`, `already_nominated` and
 * `slot_in_use`. Two more are decided by the route before the
 * transaction opens — `unconfirmed`, because an unconfirmed submit has
 * nothing to decide about, and `unbound_actor`, because
 * `auction_events.manager_id`/`team_id` are NOT NULL (AD-4) so an unbound
 * actor has no event to append. `unrecorded` is the defensive case for a
 * rejection that arrived stating no reason. All eight are worded here
 * anyway, so no route ever words a refusal itself.
 *
 * **There is deliberately no separate "already won in this auction" refusal,
 * and since Story 3.4 that is because `under_contract` IS it.** A close
 * appends an `AuctionClosed` and `contractsReducer` folds it into an Auction
 * Contract, so a won Player is under contract to the winning Team — the same
 * fact `team_rosters` states about an imported Player, arriving from the
 * other of the two sources `server/nomination.ts` resolves. The sentence
 * already names the Player and the Team, which is what the refusal has to do,
 * and a second refusal saying the same thing in different words would be a
 * synonym rather than a distinction. (Until 3.4 the reason was that no close
 * event existed at all; `AUCTION_CLOSED_EVENT` arrived in Story 2.3 and its
 * producer in 3.4, so that reason is retired here rather than left standing.)
 */
export type NominationRefusal =
	| { readonly kind: 'phase'; readonly phase: LeaguePhase }
	| { readonly kind: 'unknown_player' }
	| {
			readonly kind: 'under_contract';
			readonly playerName: string;
			readonly teamName: string;
	  }
	| {
			readonly kind: 'already_nominated';
			readonly playerName: string;
			readonly teamName: string;
	  }
	| { readonly kind: 'slot_in_use'; readonly playerName: string }
	| { readonly kind: 'unconfirmed'; readonly playerName: string }
	| { readonly kind: 'unbound_actor' }
	| { readonly kind: 'unrecorded' };

/**
 * The pool row's own state, in the fewest words that still say which of the
 * ways a Player is out of reach applies to them.
 *
 * The pool page used to print "Not available" and then the whole refusal
 * sentence underneath every blocked row. That sentence is written for a
 * SUBMIT — it ends in "Nothing was written", because a refusal's job is to
 * say the Slot was not spent — and nobody had submitted anything. On a pool
 * of ~1,470 Players it was also a paragraph per row, repeated down the
 * column, saying the same thing about a hundred rows in turn. What a Manager
 * scanning the list needs is which state a row is IN, and that is one phrase.
 *
 * The distinction between the two nominated states is the Bid, not the
 * nomination: `projection/auctions.ts` holds nothing at all for a nominated
 * Player nobody has bid on, so `bidding` is that fold's answer and never a
 * second rule about it. Both are still refused by the same
 * `already_nominated` gate; the label reports which stage the Auction has
 * reached, and changes nothing about who may be nominated.
 *
 * `Closed to <Team>` is the `under_contract` case, and covers both of its
 * sources without distinguishing them, exactly as the refusal does: a Player
 * imported onto a roster and a Player won in this auction are equally out of
 * the pool, and the Team named is the one holding them.
 *
 * The last line is the fallback rather than an exhaustive switch on purpose.
 * A pool row can also be refused for the phase — every row at once, when the
 * auction is not running — and that is not a fact about the PLAYER, so it
 * gets the plain state and the panel above the list says the rest.
 */
export function nominationPoolStatus(
	refusal: NominationRefusal | null,
	bidding: boolean
): string {
	if (refusal === null) return 'Available';
	switch (refusal.kind) {
		case 'already_nominated':
			return bidding ? 'In-Auction' : 'Nominated';
		case 'under_contract':
			return `Closed to ${refusal.teamName}`;
		default:
			return 'Not available';
	}
}

/**
 * The one refusal sentence for each case.
 *
 * Product voice: state the fact, name the Player or the Team it is about,
 * then say what would change it. No apology, no exclamation mark, no advice
 * beyond naming the surface or the event that owns the block.
 *
 * Every sentence ends by saying nothing was written, because that is the
 * whole point of a refusal at this gate: the Slot is not spent, the board is
 * unchanged, and the League Clock did not move.
 */
export function nominationRefusalDetail(refusal: NominationRefusal): string {
	switch (refusal.kind) {
		case 'phase':
			return (
				`No nomination was placed: the phase is ${refusal.phase}, not Auction. ` +
				'Players are nominated only while the auction is running, and the phase was ' +
				'folded from the event log inside this transaction. Nothing was written.'
			);
		case 'unknown_player':
			return (
				'No nomination was placed: the Player named is not in the Free Agent pool. ' +
				'The pool this page was rendered from is live and may have been re-imported ' +
				'since, so reload the page and choose again. Nothing was written.'
			);
		case 'under_contract':
			return (
				`No nomination was placed: ${refusal.playerName} is under contract to ` +
				`${refusal.teamName}. Only a Free Agent can be nominated, and a Player on a ` +
				'roster is not one. Nothing was written.'
			);
		case 'already_nominated':
			return (
				`No nomination was placed: ${refusal.playerName} is already on the Bid Board — ` +
				`${refusal.teamName} nominated them and that Auction has not closed. A Player ` +
				'is nominated once. Nothing was written.'
			);
		case 'slot_in_use':
			return (
				'No nomination was placed: your Team\u2019s Nomination Slot is held by your ' +
				`nomination of ${refusal.playerName}. The Slot is returned when your Team wins a ` +
				'Player \u2014 not when that Auction closes \u2014 so win one and you may nominate ' +
				'again. Nothing was written.'
			);
		case 'unconfirmed':
			// **States the board, not the Slot** (Story 9.8). This sentence used
			// to say the Team's only Nomination Slot was held until that Auction
			// closed — true of a Manager and false of a Commissioner, who spends
			// none. What makes a nomination worth confirming is the same for both:
			// the Player goes on the Bid Board and no event takes them back off it.
			// Saying THAT keeps one wording per refusal, which is this module's
			// rule, rather than splitting a refusal on a property of the actor.
			return (
				`No nomination was placed: the confirmation was not given. Nominating ` +
				`${refusal.playerName} puts that Player on the Bid Board until their Auction ` +
				'closes, so it is never inferred from a submit. Tick the confirmation ' +
				'and submit again. Nothing was written.'
			);
		case 'unbound_actor':
			return (
				'No nomination was placed: you are not bound to a Team, and every event must ' +
				'name one. Ask the Commissioner to bind your Team. Nothing was written.'
			);
		case 'unrecorded':
			return (
				'No nomination was placed: the write was refused and stated no reason. ' +
				'Nothing was written.'
			);
	}
}

/**
 * The gates, in order: phase, then the Player's existence, then the two ways
 * a Player can be unavailable, then the actor's own Slot. Returns the first
 * refusal, or `null` when every gate holds.
 *
 * Phase goes first for `refuseAuctionOpen`'s reason — outside the Auction
 * Phase, which Player was named is beside the point and "the phase is Setup"
 * is the honest answer. `unknown_player` follows immediately because every
 * sentence after it names the Player, and a gate cannot name a Player the
 * pool has never heard of.
 *
 * `under_contract` precedes `already_nominated` because a Player on a roster
 * should never have been nominatable in the first place: if both somehow
 * hold, "they are under contract to the Lakers" is the fact that explains
 * the other one, not the other way round. Since Story 3.4 a Player WON in
 * this auction reaches the same refusal, and the ordering matters there for
 * the same reason: a close drops the board seat and awards the contract in
 * one event, so the contract is the fact that explains any stale board state
 * beside it.
 *
 * `slot_in_use` goes LAST of the five, which is a deliberate choice about
 * whose problem is named first. A Manager whose Slot is held and who has
 * also picked an unavailable Player is told about the Player: the Slot is a
 * standing condition they can already see on their own page, whereas the
 * Player's unavailability is news. That reasoning got stronger with the
 * amended FR-9, under which a held Slot is a condition that can stand for the
 * whole auction rather than one that clears itself in an hour.
 *
 * Exported so the ordering is assertable as pure logic rather than inferred
 * from a transaction. Takes no clock, no database and no random source — the
 * whole state arrives as an argument.
 */
export function refuseNomination(
	state: NominationState,
	actorTeamId: string,
	actorSpendsSlot: boolean = true
): NominationRefusal | null {
	if (state.phase !== 'Auction') return { kind: 'phase', phase: state.phase };

	if (state.poolPlayer === null) {
		// The one refusal that names nothing, because there is nothing to name:
		// the pool has no row for this id, so it has no Player name, no Team
		// and no contract. Echoing the raw id back would be naming the
		// submission rather than naming a Player.
		return { kind: 'unknown_player' };
	}
	const player = state.poolPlayer;

	if (state.contractHolderTeamName !== null) {
		return {
			kind: 'under_contract',
			playerName: player.playerName,
			teamName: state.contractHolderTeamName
		};
	}

	const onBoard = nominationForPlayer(state.nominations, player.fantraxPlayerId);
	if (onBoard !== null) {
		return {
			kind: 'already_nominated',
			playerName: player.playerName,
			teamName: onBoard.teamName
		};
	}

	// **The Commissioner exemption, and the whole of it** (Story 9.8). An
	// actor who spends no Slot has no Slot to be held, so this gate — the
	// last of the five, and the only one about the ACTOR rather than the
	// Player — simply does not apply to them. Every gate above still does: a
	// Commissioner cannot nominate outside the Auction Phase, cannot nominate
	// a Player the pool has never heard of, cannot nominate one under
	// contract, and cannot nominate one already on the board.
	//
	// The default is `true` because the Manager rule is the rule: an exemption
	// has to be asked for explicitly, by a caller that has resolved who is
	// acting from `managers.is_commissioner` server-side (AD-15). A caller
	// that forgets gets the strict answer.
	if (actorSpendsSlot) {
		const slotHolder = nominationForTeam(state.nominations, actorTeamId);
		if (slotHolder !== null) {
			return { kind: 'slot_in_use', playerName: slotHolder.playerName };
		}
	}

	return null;
}

/**
 * The one statement of what confirming a nomination does. Every sentence the
 * surface prints beside the confirm is built from this string, so the
 * consequence has exactly one wording.
 *
 * It states the Slot and ONLY the Slot, because the Slot is the only thing a
 * nomination commits. Saying anything about money here would be false: no
 * cap space is reserved, the nominating Team is not the Leading Bidder, and
 * no Auction Clock starts.
 *
 * **It says explicitly that losing does not give the Slot back**, because
 * that is the half of the amended FR-9 a Manager will otherwise assume the
 * old way round. Under the previous rule the Slot returned when the nominated
 * Player's Auction closed, however it closed — so nominating cost nothing a
 * Manager had to plan around. It now costs the Slot until they WIN something,
 * and a confirm that did not say so would be inviting a commitment under the
 * old terms.
 */
export const NOMINATION_CONSEQUENCE =
	'your Team\u2019s only Nomination Slot is held until your Team wins a Player, and you ' +
	'cannot nominate anyone else until then. Losing that Auction does not give it back. ' +
	'No cap space is committed, no bid is placed, and your Team does not become the ' +
	'Leading Bidder';

/**
 * What the Team's Nomination Slot is doing right now, in one line.
 *
 * This is a STATUS, not a refusal, and that distinction is the reason it
 * exists. `nominationRefusalDetail` answers "why was that submit refused" and
 * ends every sentence with "Nothing was written", because a refusal is a
 * reply to an act. `/nominate` was printing that reply at rest, before any
 * act, so a Manager opening the page read three lines of exculpation about a
 * submit they had not made — and on a phone those lines pushed the list, the
 * filter and the control itself off the first screen.
 *
 * A held Slot names the PLAYER holding it, because that is the fact the
 * Manager actually wants and the only one they cannot derive from the page:
 * "held" without a name sends them to the Bid Board to find out by whom. It
 * names that Player even once their Auction is long closed, which is the
 * amended FR-9 showing through: the Slot outlives the Auction it was spent
 * on, and what a Manager needs to know is what they spent it on.
 *
 * The second clause is when it comes back, and it is no longer a date — it is
 * a condition the Manager controls. "until your Team wins a Player" is the
 * whole rule, and it is the one line on the page that says the Slot is not
 * waiting on a clock.
 *
 * The refusal sentence is not replaced anywhere it is a reply: a refused
 * submit still gets `nominationRefusalDetail` in full.
 */
export function nominationSlotStatus(heldPlayerName: string | null): string {
	if (heldPlayerName === null || heldPlayerName === '') return 'Open for nomination.';
	return `Held by your nomination of ${heldPlayerName} until your Team wins a Player.`;
}

/**
 * What a Commissioner's Nomination Slot is doing: nothing, ever (Story 9.8).
 *
 * `nominationSlotStatus`'s third case, kept as its own name rather than a
 * `null` argument, because it is not a Slot state at all — it is the absence
 * of one. A Commissioner reading "Open for nomination." would be told the
 * truth about a rule that does not apply to them, and would have no way to
 * know that the line will still say "Open" after they nominate.
 *
 * It says WHY, in the League's terms rather than the schema's: Commissioners
 * nominate to keep Auctions open so the phase finishes, and waiting on thirty
 * Managers to each spend one Slot is what makes it not finish.
 */
export const COMMISSIONER_SLOT_STATUS =
	'Unlimited — Commissioner nominations hold no Nomination Slot.';

/**
 * `NOMINATION_CONSEQUENCE` as a finished sentence about a named Player, for
 * the surface to print beside the confirm.
 *
 * Rendered here rather than in `+page.svelte` for the reason Story 1.9
 * settled: the server renders, the surface prints. A `.svelte` file may not
 * reach a server-only module, and it equally must not re-word a rule to work
 * around that.
 */
export function nominationConsequenceSentence(playerName: string | null): string {
	const subject = playerName === null || playerName === '' ? 'A nomination' : `Nominating ${playerName}`;
	return `${subject} cannot be undone: ${NOMINATION_CONSEQUENCE}.`;
}

/**
 * What confirming commits when the actor holds no Slot (Story 9.8).
 *
 * `NOMINATION_CONSEQUENCE`'s counterpart, and it exists for the same reason
 * that constant does: the sentence beside a confirm must be TRUE. Printing
 * "your Team's only Nomination Slot is held until that Player's Auction
 * closes" to a Commissioner would state a consequence that will not happen,
 * and the one thing a confirm must not do is misdescribe what it does.
 *
 * The irreversibility stays, because that is the part that is still true and
 * the reason a confirm is asked for at all: the Player goes on the Board and
 * no event takes them back off it. The three denials are `NOMINATION_CONSEQUENCE`'s
 * own, word for word — a nomination commits no money whoever places it.
 */
export const COMMISSIONER_NOMINATION_CONSEQUENCE =
	'that Player goes on the Bid Board and their Auction runs to the League Clock. As ' +
	'Commissioner you hold no Nomination Slot, so this does not use one and does not stop ' +
	'you nominating again. No cap space is committed, no bid is placed, and your Team does ' +
	'not become the Leading Bidder';

/**
 * Why the submit control is still disabled when a Player is chosen and the
 * confirmation is not yet ticked, naming the Player and what confirming does.
 *
 * Worded HERE rather than in `+page.svelte` (Story 9.8). The page was
 * carrying this sentence as literal markup — "nominating X holds your Slot
 * until that Auction closes" — which is a rule re-worded in a surface, and
 * the Commissioner exemption is exactly what makes that cost something: it
 * states a consequence that does not happen to seven of the thirty-seven
 * people who read it. The page prints what the core says and decides nothing.
 *
 * FR-9's amendment is the second vindication of that move, and a plainer one:
 * the sentence quoted above is now simply FALSE — a Slot is held until the
 * Team WINS a Player, not until that Auction closes — and correcting it took
 * one edit here rather than a hunt through the markup.
 *
 * Short on purpose: it sits inside the action bar beside the control, not in
 * the consequence panel, so it says the one thing that changes rather than
 * repeating `NOMINATION_CONSEQUENCE` in full.
 */
export function nominationConfirmPrompt(playerName: string, spendsSlot: boolean): string {
	const lead = 'The confirmation has not been given. Tick it to enable the control: ';
	return spendsSlot
		? `${lead}nominating ${playerName} holds your Slot until your Team wins a Player.`
		: `${lead}nominating ${playerName} puts them on the Bid Board and holds no Slot.`;
}

/**
 * `COMMISSIONER_NOMINATION_CONSEQUENCE` as a finished sentence about a named
 * Player — `nominationConsequenceSentence`'s shape, for its own consequence.
 */
export function commissionerConsequenceSentence(playerName: string | null): string {
	const subject = playerName === null || playerName === '' ? 'A nomination' : `Nominating ${playerName}`;
	return `${subject} cannot be undone: ${COMMISSIONER_NOMINATION_CONSEQUENCE}.`;
}
