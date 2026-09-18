/**
 * Restoration: who leads an Auction once a cancellation has taken its leader
 * away (Story 10.4, FR-40, AR-36, AR-37).
 *
 * **One selector, and it decides nothing else.** `selectRestoration` walks a
 * cancelled Auction's surviving history downward by amount, re-evaluates each
 * candidate through the `RestoreLeadingBid` gate set, skips the ones that
 * fail, and stops at the first that passes. That answer rides the
 * `BidCancelled` event `rules/close.ts` appends, and `withBidCancelled` seats
 * whoever it names. This module appends NOTHING: `close.ts` stays the sole
 * appender and the fixed event order — `ContentionDrawn`, `AuctionClosed`,
 * then each `BidCancelled` — is untouched by anything here.
 *
 * **Why the walk skips rather than cancels.** A candidate that fails
 * re-validation is passed over and the next below is tried; it is never
 * cancelled, never marked, and stays a standing Bid in the history. That
 * bound is what terminates the cascade: restoration cannot be a cancellation
 * trigger, so a close can only ever fire the cascade once and the loop cannot
 * chase its own tail.
 *
 * **Why it is parameterised rather than duplicated (AR-36).** Two rules in
 * this product hand an Auction to its next-highest surviving Bid — FR-40's
 * cancellation cascade, and the Commissioner Bid void of Story 7.2 — and they
 * agree completely about WHO should lead and disagree about three things
 * either side of that question:
 *
 *  - `withdrawnBid` — a cancellation RETAINS the withdrawn Bid in the fold,
 *    struck through and labelled, because a cancellation says nothing about
 *    whether the Bid should have stood. A void ERASES it: a voided Bid is one
 *    the Commissioner has ruled should never have counted.
 *  - `auctionClock` — a cancellation LEAVES the Auction Clock exactly where it
 *    is, so a Restored Leading Bidder may inherit minutes. A void RESTORES the
 *    clock the voided Bid's own reset displaced.
 *  - `leagueClockReset` — a cancellation KEEPS the League Clock reset the
 *    withdrawn Bid earned, which is why `projection/league-clock.ts` has no
 *    `BidCancelled` case at all (AR-39). A void REMOVES it, which is exactly
 *    what `BidVoided` is for.
 *
 * FR-40 passes `retain`/`leave`/`keep`, which is `CANCELLATION_AXES` below.
 * Story 7.2 passes `erase`/`restore`/`remove` and writes no selector of its
 * own — the two clock answers come back on `RestorationOutcome` so that each
 * consumer applies them rather than restating them.
 *
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { compareMoney } from '../money.ts';
import type { Money } from '../money.ts';
import { auctionForPlayer, wasCancelled } from '../projection/auctions.ts';
import type { Bid, OpenAuctions, Restoration } from '../projection/auctions.ts';
import type { RestoreLeadingBid } from '../types.ts';
import {
	allRestoreGatesPassed,
	bidStateFor,
	evaluateRestore,
	teamMoneyStateFor
} from './bidding.ts';

/**
 * The three roster facts a candidate Team is judged against — `capSpace`,
 * `rosterCount` and the RAW `minorLeagueOccupied`.
 *
 * Structurally `server/team-roster.ts`'s `TeamRosterFigures`, restated here
 * because the core may not import the shell (AD-2). Stating it structurally
 * rather than importing it is also what lets a test hand the selector three
 * numbers with no database anywhere near it.
 *
 * **The figures are the PRE-CLOSE read, and that is correct as loaded.** A
 * Close changes the WINNER's roster and nobody else's, so a candidate's Slot
 * occupancy and Cap Space are the same before and after it. What does move
 * under a candidate is its COMMITTED capital, and that is derived from
 * `auctions` — which the cascade threads through `withBidCancelled` after
 * every cancellation and every restoration it decides. Hence one batched
 * roster read for the whole close and no per-candidate query.
 */
export type CandidateRosterFigures = {
	readonly capSpace: Money;
	readonly rosterCount: number;
	readonly minorLeagueOccupied: number;
};

/** The three axes that separate a cancellation from a Commissioner void. */
export type RestorationAxes = {
	/** Does the withdrawn Bid stay in `bids`, or leave the history entirely? */
	readonly withdrawnBid: 'retain' | 'erase';
	/** Is the Auction Clock left as it stands, or put back as it was? */
	readonly auctionClock: 'leave' | 'restore';
	/** Does the withdrawn Bid's League Clock reset stand, or come out? */
	readonly leagueClockReset: 'keep' | 'remove';
};

/**
 * FR-40's settings: retain, leave, keep.
 *
 * Frozen because it is a shared literal that decides an outcome, and a caller
 * that could edit it in place would change every cascade in the process.
 */
export const CANCELLATION_AXES: RestorationAxes = Object.freeze({
	withdrawnBid: 'retain',
	auctionClock: 'leave',
	leagueClockReset: 'keep'
});

/**
 * Everything the re-test needs about the world the candidates live in — one
 * snapshot, so no two candidates can be judged against different moments.
 *
 * `auctions` is the POST-CLOSE, POST-CASCADE fold: after the triggering
 * Close's placement, after the won Player left `byPlayer`, and after every
 * cancellation AND every restoration already decided in this cascade. A
 * second restoration to the same Team must see the first, and this field is
 * how it does. It still holds the Auction being restored — leaderless, with
 * its history intact — because `teamMoneyStateFor` excludes that Auction by
 * id and `evaluateSlots` counts the prospective win back in exactly once.
 */
export type RestorationBasis = {
	readonly auctions: OpenAuctions;
	/** The three figures for one Team, or `null` for a Team not read. */
	readonly rosterFiguresFor: (teamId: string) => CandidateRosterFigures | null;
	readonly playerNameFor: (fantraxPlayerId: string) => string;
	/** The closing instant — `evaluateRestore`'s `now`, which no gate reads. */
	readonly now: string;
};

/** What the selector decided, and what the two clock axes ask of the caller. */
export type RestorationOutcome = {
	/**
	 * The Bid this Auction is handed to, or `null` when nothing below survived
	 * re-validation.
	 *
	 * `null` is not "there was nobody": every candidate can fail while several
	 * un-cancelled Bids stand in the history. The Auction goes to Awaiting
	 * Opening Bid either way.
	 */
	readonly restored: Restoration | null;
	/** `true` only on the `restore` axis — a void puts the clock back. */
	readonly resetsAuctionClock: boolean;
	/** `true` only on the `remove` axis — a void withdraws the reset. */
	readonly removesLeagueClockReset: boolean;
};

/**
 * The next-highest surviving Bid that can still keep its commitment, or
 * `null`.
 *
 * **Descending by amount, earliest `seq` first on a tie.** The tiebreak is
 * `highestStandingBid`'s, restated so the two agree: a Bid takes the lead only
 * by being strictly higher, so the earliest of two equal amounts is the one
 * that was leading and the one that leads again.
 *
 * **A cancelled Bid is not a candidate, and neither is the one just
 * withdrawn.** The `retain` axis leaves the withdrawn Bid in `bids` carrying
 * its marker, so `wasCancelled` already excludes it; the explicit `seq` test
 * covers the `erase` axis and the caller who hands over a fold the withdrawal
 * has not yet been applied to. Nothing else is filtered — the winning Team's
 * own older, outbid Bid on this same Auction IS a candidate, judged by the
 * ordinary route rather than excluded by name. Handed that Team's post-close
 * figures it is normally refused, and refused for a stated reason: it is
 * re-tested against the roster and the committed capital the cancellation
 * just left the Team with, which is the basis that squeezed the Bid above it
 * out. Where the eligible carve-out applies — a Minor League Eligible Player
 * a free Minor League Slot can still absorb — it passes instead, which is the
 * correct answer and the same one `evaluateSlots` gives the cascade when it
 * walks past such a commitment.
 *
 * **Inside a Minimum-Bid Contention there is nothing to select.** A lottery's
 * `leadingBid` is a fold artifact over identical flat amounts — every
 * Contender holds the same $1,000,000 — so the artifact moving to the
 * earliest surviving join changes nobody's position, price or committed
 * capital. That is not restoration and re-validation does not apply to it;
 * `withBidCancelled` moves the artifact itself. This answers `null`.
 */
export function selectRestoration(input: {
	/** The Auction whose leader was withdrawn. */
	readonly fantraxPlayerId: string;
	/** The withdrawn Bid's own `seq`, excluded from its own succession. */
	readonly withdrawnSeq: string;
	readonly basis: RestorationBasis;
	readonly axes: RestorationAxes;
}): RestorationOutcome {
	const clocks = {
		resetsAuctionClock: input.axes.auctionClock === 'restore',
		removesLeagueClockReset: input.axes.leagueClockReset === 'remove'
	};
	const auction = auctionForPlayer(input.basis.auctions, input.fantraxPlayerId);
	if (auction === null) return { restored: null, ...clocks };
	if (auction.contention === 'minimum_bid') return { restored: null, ...clocks };

	for (const candidate of candidatesFor(auction.bids, input.withdrawnSeq)) {
		if (!candidateStands(candidate, input.fantraxPlayerId, input.basis)) continue;
		return {
			restored: {
				seq: candidate.seq,
				teamId: candidate.teamId,
				teamName: candidate.teamName,
				managerId: candidate.managerId,
				amount: candidate.amount
			},
			...clocks
		};
	}
	return { restored: null, ...clocks };
}

/** The surviving Bids, highest first, earliest `seq` first on a tie (AD-5). */
function candidatesFor(bids: readonly Bid[], withdrawnSeq: string): readonly Bid[] {
	const surviving = bids.filter((bid) => !wasCancelled(bid) && bid.seq !== withdrawnSeq);
	return [...surviving].sort((left, right) => {
		const byAmount = compareMoney(right.amount, left.amount);
		if (byAmount !== 0) return byAmount;
		// `seq` is an `int8` that arrives as a string (AD-8), compared through
		// `BigInt` exactly as `fold()` compares it: `Number` would misorder a
		// log this league will never reach and `<` would misorder one it
		// reaches on the tenth event.
		const a = BigInt(left.seq);
		const b = BigInt(right.seq);
		if (a === b) return 0;
		return a < b ? -1 : 1;
	});
}

/**
 * Whether one candidate could still keep this Bid — `evaluateRestore`, and no
 * arithmetic of this module's own.
 *
 * The state is built exactly as `close.ts`'s `commitmentStands` builds the
 * winner's, and for the same reason: "is this Team still within capacity and
 * still able to afford it" is a question the gates own, and a hand-rolled
 * version of either would drift from the rule that admitted the Bid in the
 * first place. What differs is the Team it is about — a candidate, not the
 * winner — and that BOTH gates are read rather than one, because a
 * restoration re-commits capital and a cancellation only ever released it.
 *
 * **A Team with no roster figures is skipped, not thrown over.** `null` means
 * the batched read did not cover that Team, which is a state a candidate can
 * legitimately be in on a partial basis; refusing to restore is the
 * conservative answer, and it is the same answer a failed gate gives.
 */
function candidateStands(
	candidate: Bid,
	fantraxPlayerId: string,
	basis: RestorationBasis
): boolean {
	const figures = basis.rosterFiguresFor(candidate.teamId);
	if (figures === null) return false;
	const team = teamMoneyStateFor({
		teamId: candidate.teamId,
		// The Auction being restored, excluded from both lists exactly as a
		// prospective Bid's own Auction is — `evaluateSlots` counts it back in
		// once, on the post-bid basis AD-7 requires.
		fantraxPlayerId,
		capSpace: figures.capSpace,
		rosterCount: figures.rosterCount,
		minorLeagueOccupied: figures.minorLeagueOccupied,
		auctions: basis.auctions,
		playerNameFor: basis.playerNameFor
	});
	const state = bidStateFor(
		auctionForPlayer(basis.auctions, fantraxPlayerId),
		team,
		// A close happens inside the Auction Phase by construction — the sweep
		// runs nowhere else — and `phase` is not one of the two gates this
		// re-test reads anyway.
		'Auction'
	);
	const command: RestoreLeadingBid = {
		kind: 'RestoreLeadingBid',
		fantraxPlayerId,
		teamId: candidate.teamId,
		teamName: candidate.teamName,
		managerId: candidate.managerId,
		amount: candidate.amount
	};
	return allRestoreGatesPassed(evaluateRestore(state, command, basis.now));
}
