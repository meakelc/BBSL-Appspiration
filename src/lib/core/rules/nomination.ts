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
				`nomination of ${refusal.playerName}. The Slot is returned when that Player\u2019s ` +
				'Auction closes, and you may nominate again then. Nothing was written.'
			);
		case 'unconfirmed':
			return (
				`No nomination was placed: the confirmation was not given. Nominating ` +
				`${refusal.playerName} holds your Team\u2019s only Nomination Slot until that ` +
				'Auction closes, so it is never inferred from a submit. Tick the confirmation ' +
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
 * Player's unavailability is news.
 *
 * Exported so the ordering is assertable as pure logic rather than inferred
 * from a transaction. Takes no clock, no database and no random source — the
 * whole state arrives as an argument.
 */
export function refuseNomination(
	state: NominationState,
	actorTeamId: string
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

	const slotHolder = nominationForTeam(state.nominations, actorTeamId);
	if (slotHolder !== null) {
		return { kind: 'slot_in_use', playerName: slotHolder.playerName };
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
 */
export const NOMINATION_CONSEQUENCE =
	'your Team\u2019s only Nomination Slot is held until that Player\u2019s Auction closes, ' +
	'and you cannot nominate anyone else until then. No cap space is committed, no bid ' +
	'is placed, and your Team does not become the Leading Bidder';

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
