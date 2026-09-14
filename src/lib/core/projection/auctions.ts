/**
 * Open Auctions, folded from the log (Story 2.5).
 *
 * **Nothing here is stored.** No `auctions` table, no `bids` table, no
 * migration: the leading Bid, the current price, the contention state, the
 * absolute close instant and the whole chronological Bid history are this
 * fold over `auction_events`. `projection/nominations.ts`'s own header states
 * the reasoning and it is unchanged here — the log already carries every
 * fact, and AD-5 makes a projection disposable and rebuildable, so a table
 * would only have to be undone.
 *
 * **The close instant rides the `BidPlaced` payload.** AD-3 requires the
 * server to persist ABSOLUTE close timestamps — never "seconds remaining" —
 * and AD-12 requires validation to compare `now` against a *persisted* one
 * rather than a projection's open flag. A projection table is the wrong home
 * for it precisely because AD-5 makes projections disposable. Carrying
 * `closesAt` on the payload persists it in the insert-only log, keeps it
 * foldable, and leaves AD-13's pause — which recomputes forward and never
 * shifts a close time in place — somewhere to stand.
 *
 * **This fold answers a bid question, never the "is there an Auction"
 * question.** An Auction exists because a Player was nominated, which is
 * `nominationsReducer`'s fold; this one only knows what has been BID. A
 * nominated Player nobody has bid on has no entry here at all, and
 * `auctionForPlayer` returns `null` for them — which is "no bids yet", not
 * "no Auction". Two folds over one loaded events array, exactly as
 * `server/nomination.ts` already runs phase and nominations together.
 *
 * **The highest Bid leads, and history keeps everything.** The gate refuses
 * anything at or below the current high, so in practice every `BidPlaced` in
 * the log is a raise and "latest leads" and "highest leads" agree. A reducer
 * must nonetheless be total over any log it is handed, and only "strictly
 * higher takes the lead" is idempotent under replay: folding the same log
 * twice converges, because a second fold of an already-leading Bid is not
 * strictly higher than itself. History appends unconditionally — an event
 * that happened, happened — and is de-duplicated on `seq`, which the
 * database assigns and never reissues.
 *
 * **`AuctionClosed` removes the Auction**, keyed on the Player and read
 * through `nominations.ts`'s own exported `readClosedPlayerId`, so this fold
 * and the Slot's release can never disagree about what a malformed close
 * means. **Nothing in this story appends one** — Epic 3 owns closing — so
 * the case ships proven against a synthetic event.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { MINIMUM_BID } from '../constants.ts';
import { formatInstant, parseInstant } from '../instant.ts';
import type { Money } from '../money.ts';
import { compareMoney, parseMoney } from '../money.ts';
import type { AppendedEvent } from '../types.ts';
import { fold } from './fold.ts';
import type { Reducer } from './fold.ts';
import {
	AUCTION_CLOSED_EVENT,
	AUCTION_TERMINATED_EVENT,
	readClosedPlayerId,
	readTerminatedPlayerId
} from './nominations.ts';

/**
 * The event type a successful Bid appends (`server/bidding.ts`).
 *
 * Declared here rather than beside the transaction that appends it, for
 * `NOMINATION_PLACED_EVENT`'s reason: this is the reducer that gives it
 * meaning. The price, the Leading Bidder, the contention state and the
 * Auction Clock ARE this fold.
 */
export const BID_PLACED_EVENT = 'BidPlaced';

/**
 * The event type a dissolution appends beside the converting `BidPlaced`
 * (Story 3.3, FR-19, AD-14).
 *
 * Declared here for `BID_PLACED_EVENT`'s reason, and the declaration is the
 * whole of the registration: there is no central event registry in this
 * codebase and no database check constraint on `event_type` —
 * `20260821020000_auction_events.sql` deliberately holds "no opinion on what
 * `event_type` values are legal" — so a const beside the reducer that gives
 * it meaning is where an event type comes into existence.
 *
 * **It carries the REVEALED seed, and that is why it exists at all.** A
 * contention that dissolved with its seed still sealed is the one outcome
 * AD-14 cannot survive: the commitment was published, the Contenders were
 * released, and nothing would ever open the envelope, because the draw that
 * would have opened it will never run. `decide()` verifies the seed against
 * the published commitment before it builds this payload, so a reveal that
 * does not match the commitment a Manager already recorded is foreclosed
 * rather than merely tested for.
 *
 * Appended SECOND, after the `BidPlaced` that caused it, in one transaction.
 * Cause then consequence: a log read in `seq` order states the Bid that
 * dissolved the contention before it states the dissolution.
 */
export const CONTENTION_DISSOLVED_EVENT = 'ContentionDissolved';

/**
 * The event type a cancellation appends — the compensating half of the
 * Outstanding Bid Allowance (Story 10.3, FR-40, AD-31).
 *
 * Declared here for `BID_PLACED_EVENT`'s reason, and the declaration is the
 * whole of the registration: `auction_events.event_type` is generic `text`
 * and this codebase has no central event registry, so a const beside the
 * reducer that gives it meaning is where an event type comes into existence.
 * No migration was needed and none was written.
 *
 * **It is a COMPENSATING event and emphatically not a correction.** The
 * `BidPlaced` it names is never deleted and never mutated: it stays a history
 * line, keeps its `seq`, and keeps its place in the order every other fold
 * reads. What this event withdraws is the Bid's STANDING — its leadership,
 * its place in a Contender list, and through both of those the capital the
 * Team had committed to it.
 *
 * **It is not a `BidVoided` and `league-clock.ts` must never treat it as
 * one.** A void says a Bid should not have stood and takes its League Clock
 * reset back with it; a cancellation says nothing of the kind — the Bid was
 * legal when it was placed and the Team simply ran out of room to land it. A
 * reducer that folded the two alike would end the Auction Phase early every
 * time a roster filled, which is why `league-clock.ts` has no case for this
 * type at all and its `default: return state` is the assertion.
 *
 * Appended LAST, after the `AuctionClosed` that caused it, in one
 * transaction: cause then consequence, the order `ContentionDrawn` already
 * keeps on the other side of the close.
 */
export const BID_CANCELLED_EVENT = 'BidCancelled';

/**
 * Which contention an Auction is in.
 *
 * `awaiting_opening_bid` is a nominated Player nobody has bid on. `standard`
 * is the ordinary case: one Leading Bidder, raises of at least the Minimum
 * Increment, a 24-hour clock from the latest Bid.
 *
 * **`minimum_bid` is produced for real since Story 3.2.** An Opening Bid of
 * exactly `MINIMUM_BID` opens a Minimum-Bid Contention: the `opening` gate
 * passes it, the `contention` gate owns every amount question inside it, and
 * `contenders` below is the Contender list folded from the Bids this log
 * already holds. Until 3.2 the literal existed only so the fold could be
 * total over a log carrying one — the opening gate refused the amount by name
 * and no path wrote a `BidPlaced` at it. That is no longer true, and the
 * state is now reached the ordinary way.
 *
 * A conversion OUT of it — a Bid of `MINIMUM_BID + MINIMUM_INCREMENT` or more
 * into a live contention — is ACCEPTED since Story 3.3, and the return to
 * `standard` is this fold's own arithmetic rather than a written transition:
 * the converting Bid is strictly higher, so it becomes `leadingBid`, and
 * `contentionForAmount` reads `standard` off its amount. The reveal rides the
 * `ContentionDissolved` event appended beside it.
 */
export type ContentionState = 'awaiting_opening_bid' | 'standard' | 'minimum_bid';

/**
 * One Contender in a Minimum-Bid Contention (Story 3.2, AD-14).
 *
 * **Ordered by ascending join `seq`, and that order is an input to the
 * winner**, not a rendering preference — AD-14 pins it outright, because the
 * seed→winner derivation has to be reproducible by hand from the published
 * commitment and a list whose order could differ between two readings would
 * make the draw uncheckable. `seq` is the log's own ordering column, assigned
 * by the database and never reissued, so it is the one ordering that cannot
 * drift.
 *
 * Carried here rather than derived by each caller for the reason every other
 * fact on this shape is: the gate, the read path and the Auction page all
 * read ONE derivation, and a second `filter(...).sort(...)` somewhere else
 * could disagree about which Bids counted.
 *
 * `teamName` rides along because the Auction page names the Contenders out
 * loud — there is no anonymity at any point — while `teamId` is what the
 * `contention` gate matches an acting Team against.
 *
 * `managerId` rides along for Story 3.6's draw. A `ClosedWinner` names the
 * Manager whose join put the Team in — `auction_events.manager_id` is
 * `not null` and references a real row — and the joining Bid this list is
 * built from already holds it. Reaching back through `bids` by `seq` to
 * recover it at the draw would be a second, failable derivation of a fact the
 * one loop below already had in hand.
 */
export type Contender = {
	/** The joining Bid's own log position. The order AD-14 pins. */
	readonly seq: string;
	readonly teamId: string;
	readonly teamName: string;
	/** The Manager who placed the joining Bid. The draw's winner names them. */
	readonly managerId: string;
};

/**
 * The mark a `BidCancelled` leaves on the Bid it names (Story 10.3, FR-40).
 *
 * **A marker, not a deletion.** The Bid stays in `bids`, in `seq` order, with
 * every field it was folded with; this says that its standing was withdrawn
 * and by what. The Auction history therefore still shows the Bid — struck
 * through, labelled, and naming the win that caused it (Story 10.6 words it)
 * — which is what FR-40 requires kept visible and what tells a cancellation
 * apart from a void on the page.
 *
 * The CAUSE is carried rather than looked up. It is the Close that filled the
 * Team's last Slot, and it is on a different Auction entirely — so a surface
 * that had to recover it would have to re-fold a second Auction from a `seq`,
 * which is a derivation that can fail on a surface that must not.
 */
export type BidCancellation = {
	/** The `BidCancelled` event's own log position. */
	readonly seq: string;
	/** The Player whose Close caused it — a DIFFERENT Auction to this one. */
	readonly causeFantraxPlayerId: string;
	/** That Player's name, so the history line can say the cause out loud. */
	readonly causePlayerName: string;
	/**
	 * Who leads this Auction now, as `rules/restore.ts` decided it inside the
	 * closing transaction — or `null` when nothing survived re-validation
	 * (Story 10.4, FR-40).
	 *
	 * **A decision this fold READS and never makes** (AD-31). Choosing the
	 * successor means running the cap and slots gates over a candidate Team's
	 * roster and committed capital, which is a picture no projection can see;
	 * so the answer rides the event and `withBidCancelled` seats whoever it
	 * names. `null` is not "there is nobody below" — it is "nobody below could
	 * still keep the Bid", and an Auction can go leaderless with a shelf full
	 * of surviving Bids in `bids`.
	 *
	 * It is `null` for every cancelled Minimum-Bid Contention entry, where the
	 * lead is a fold artifact over identical flat amounts and moves with no
	 * re-validation at all.
	 */
	readonly restoration: Restoration | null;
};

/**
 * The Bid a cancellation handed this Auction to (Story 10.4, FR-40).
 *
 * **`seq` is the identity and the other three are the notice.** The fold
 * seats the restored leader by finding `seq` in `bids` — never by trusting
 * the recorded `amount`, which would let a malformed payload put a price on
 * an Auction that no Bid in its history ever offered. The Team, its name and
 * the Manager ride along because the restored Manager is owed a notice
 * naming what they now lead and for how much, and a dispatcher reading one
 * event must not have to re-fold an Auction to address it.
 *
 * `amount` is therefore a stated figure rather than a load-bearing one: it is
 * the same number the Bid at `seq` carries, recorded so the Audit Log and the
 * notice can quote it without the fold.
 */
export type Restoration = {
	/** The restored Bid's own log position — its identity in `bids`. */
	readonly seq: string;
	/**
	 * The Team handed the lead.
	 *
	 * **Usually not the cancelled Team, and nothing here guarantees it.** The
	 * selector considers the cancelled Team's own older, outbid Bids on this
	 * same Auction like any other candidate — they are surviving Bids — and
	 * what keeps them out is that they are re-evaluated against that Team's
	 * POST-CLOSE roster and committed capital, which is the state that just
	 * refused the Bid above them. A Team over its allowance fails `slots`
	 * again; a Team whose eligible win a free Minor League Slot still absorbs
	 * does not, and would legitimately be restored here. Neither this type nor
	 * the fold treats the identity as a rule.
	 */
	readonly teamId: string;
	/** That Team's name, so one row names the new Leading Bidder out loud. */
	readonly teamName: string;
	/** The Manager who placed the restored Bid, and who the notice is owed to. */
	readonly managerId: string;
	/** What that Bid offered — re-committed as a consequence, not as a write. */
	readonly amount: number;
};

/** One Bid, as the history line and the Leading Bidder both need it. */
export type Bid = {
	/** The log's own ordering column. Also this Bid's identity in history. */
	readonly seq: string;
	/** The bidding Team. */
	readonly teamId: string;
	/** That Team's name — what the Leading Bidder line says out loud. */
	readonly teamName: string;
	/** The acting Manager. Bid history names them; there is no anonymity. */
	readonly managerId: string;
	/** The amount offered, in integer dollars (AD-8). */
	readonly amount: Money;
	/** The Bid's own instant, as the shell read the database clock (AD-3). */
	readonly occurredAt: string;
	/** `AUCTION_CLOCK` after `occurredAt`, absolute, as the payload persisted it. */
	readonly closesAt: string;
	/**
	 * `hash(seed)` — the commit half of AD-14's commit-reveal — present only
	 * on the Bid that OPENED a Minimum-Bid Contention, and `null` on every
	 * other Bid in the log.
	 *
	 * The raw seed is never here and never anywhere in `auction_events`: it is
	 * sealed in `auction_contention_seeds`, which grants no Postgres role
	 * anything. This is the published commitment a Manager checks the reveal
	 * against at the draw (Story 3.6).
	 */
	readonly seedHash: string | null;
	/**
	 * The mark a `BidCancelled` left on this Bid, or `null`/absent on the
	 * overwhelming majority that were never cancelled (Story 10.3, FR-40).
	 *
	 * **Optional rather than required, and that is a statement about the
	 * log.** Every other field on this shape is read off a `BidPlaced`
	 * payload, so a `Bid` literal that omitted one would be describing an
	 * event that could not exist. This one is written by a LATER event onto a
	 * Bid already folded, so its absence is the ordinary case rather than a
	 * missing fact — and every reader takes it as `bid.cancellation ?? null`.
	 */
	readonly cancellation?: BidCancellation | null;
};

/** Whether this Bid's standing was withdrawn by a `BidCancelled` (FR-40). */
export function wasCancelled(bid: Bid): boolean {
	return (bid.cancellation ?? null) !== null;
}

/**
 * One Auction's bid state. Absent entirely until its first Bid.
 *
 * **`leadingBid` and `closesAt` are NULLABLE, and FR-40 is why.** The
 * invariant that stood here until Story 10.3 was "an entry exists if and only
 * if at least one `BidPlaced` was folded, and any non-empty set of Bids has a
 * highest one". A cancellation falsifies the second half without touching the
 * first: a non-empty set of Bids can have no *surviving* highest one, because
 * `BidCancelled` withdraws a Bid's standing while leaving the Bid in
 * `bids` as the history line FR-40 requires kept visible.
 *
 * So the invariant is restated rather than removed:
 *
 *  - an entry exists if and only if at least one `BidPlaced` was folded for
 *    that Player. "No Auction row" is still the no-Bid state, and
 *    `auctionForPlayer` returning `null` is still how a caller reads it.
 *  - `leadingBid` is the Bid that currently LEADS, and `null` when none does.
 *    That is deliberately weaker than "the highest Bid still standing", and
 *    the gap is the whole of Story 10.4: cancelling the leader of a Standard
 *    Contention leaves `null` even though lower Bids go on standing, because
 *    handing the Auction to the next of them is RESTORATION — it re-validates
 *    the candidate against gates a fold may not run — and until 10.4 appends
 *    one nothing leads. §10 example 31 is that state exactly: Team U's
 *    cancelled Bid, Team V's still standing beneath it, and no leader between
 *    the two. A LEADERLESS Auction renders as the ordinary unbid nomination
 *    the board already has.
 *  - `closesAt` is cleared only when NOTHING survives. A cancellation resets
 *    no clock and removes none: where a Bid still stands, the Auction Clock is
 *    untouched, and a restored bidder may inherit very little of it (Story
 *    10.4). Where none does, a `null` clock is what stops the Auction closing
 *    at its old expiry with no winner.
 *
 * Deleting the entry instead would clear the clock correctly and erase the
 * history, which is the one thing FR-40 forbids.
 */
export type Auction = {
	readonly fantraxPlayerId: string;
	readonly contention: ContentionState;
	/**
	 * The Bid that currently leads — the current price and the Leading Bidder
	 * — or `null` when none does. Not "the highest standing Bid": see the
	 * invariant above, and `highestStandingBid` for the other question.
	 */
	readonly leadingBid: Bid | null;
	/**
	 * The Auction Clock's absolute expiry: the leading Bid's own `closesAt`,
	 * and `null` only when no Bid survives at all.
	 */
	readonly closesAt: string | null;
	/** Every Bid, oldest first. Ordered by `seq`, never by `occurredAt` (AD-5). */
	readonly bids: readonly Bid[];
	/**
	 * The Contenders in a Minimum-Bid Contention, in ascending join `seq`
	 * (AD-14) — folded from the Bids this log already holds, deduplicated on
	 * `teamId` keeping the EARLIEST join.
	 *
	 * Empty for an Auction that is not a lottery. Nothing is stored: a
	 * Contender is a Bid of exactly `MINIMUM_BID`, which the log already
	 * records, so a `contenders` table would only have to be undone (AD-5).
	 *
	 * The dedup keeps the earliest because a Team joins ONCE — the
	 * `contention` gate refuses a second join by name — and because AD-14
	 * makes the order an input to the winner: a Team that somehow appeared
	 * twice in a historical log must not get two chances at the draw.
	 */
	readonly contenders: readonly Contender[];
	/**
	 * The published `hash(seed)` for this contention, off the opening Bid's
	 * payload — `null` for an Auction that is not a lottery, and `null` for
	 * one whose opening event predates the commitment or carries a malformed
	 * one.
	 *
	 * The FIRST one seen wins, which is what makes replay converge: a fold of
	 * the same log twice cannot swap one commitment for another.
	 */
	readonly seedHash: string | null;
	/**
	 * The REVEALED seed, off a `ContentionDissolved` event — `null` for every
	 * Auction whose contention has not dissolved, which is almost all of them.
	 *
	 * Non-`null` beside a `standard` contention is what a dissolution looks
	 * like in the fold, and `wasDissolved` is the one derivation that says so.
	 * It is deliberately NOT cleared by anything: an insert-only log states
	 * what happened, and a reveal that could be un-revealed would make the
	 * published commitment uncheckable after the fact.
	 *
	 * The FIRST one seen wins, mirroring `seedHash` exactly and for the
	 * identical reason: replay must converge, and a second reveal must not be
	 * able to replace the value a Manager already hashed.
	 */
	readonly seed: string | null;
};

/** Every Auction that has seen a Bid, keyed on the Player. */
export type OpenAuctions = {
	readonly byPlayer: Readonly<Record<string, Auction>>;
};

/** With no `BidPlaced` event, no Auction has a price. */
export const INITIAL_AUCTIONS: OpenAuctions = Object.freeze({
	byPlayer: Object.freeze({}) as Readonly<Record<string, Auction>>
});

/**
 * `Object.prototype.hasOwnProperty`, called against the record rather than
 * through it — `nominations.ts`'s `hasOwn`, for its reason: the keys are
 * Fantrax player ids, which are data, so a key of `constructor` must not read
 * back as an inherited function.
 */
function hasOwn(record: Readonly<Record<string, Auction>>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

/** The Auction for a Player, or `null` when nobody has bid on them. */
export function auctionForPlayer(auctions: OpenAuctions, fantraxPlayerId: string): Auction | null {
	if (!hasOwn(auctions.byPlayer, fantraxPlayerId)) return null;
	return auctions.byPlayer[fantraxPlayerId] ?? null;
}

/**
 * The Auction one Player's Bids left behind, as it stood the instant before
 * its close — the history a Closed Auction page renders.
 *
 * **The Bids are durable; only the PROJECTION drops them.** `auctionsReducer`
 * deletes the entry on `AuctionClosed`, which is what stops a settled Auction
 * being offered a Bid or swept up as overdue, and for a long time the Closed
 * page read that deletion as "the Bids are gone" and printed nothing. They are
 * not gone: every `BidPlaced` is still in `auction_events` with its own `seq`,
 * and so is every `BidCancelled` that marked one. Folding the same reducer
 * over the log UP TO the close reconstructs the Auction exactly as it was when
 * it closed — nothing assembled from leftovers and nothing invented, which is
 * what the page's checkability claim actually requires.
 *
 * **The FIRST close for the Player is the cut**, which is `contractsReducer`'s
 * own rule for which close produced the contract — so the history this returns
 * and the winner printed above it can never describe two different Auctions.
 * Everything before that point is folded in full, so a Player whose earlier
 * nomination was terminated and who was nominated again contributes no Bids
 * from the abandoned round: this reducer's own `AuctionTerminated` case
 * cleared them inside the prefix.
 *
 * Comparison is on `seq` as `BigInt` rather than on array position — `fold`
 * sorts a copy for exactly this reason, and a caller handing over an unsorted
 * array must not get a different history from one that sorted first.
 *
 * `null` when the log holds no close for this Player, which on a Closed page
 * cannot happen: `closedAuctionFor` requires the contract that only a close
 * writes. It is `null` rather than an empty Auction so a caller cannot mistake
 * "never closed" for "closed with no Bids" — the second is real (a lottery
 * whose every Contender was cancelled) and reads as an empty history.
 */
export function auctionAtClose(
	events: readonly AppendedEvent[],
	fantraxPlayerId: string
): Auction | null {
	let closeSeq: bigint | null = null;
	for (const event of events) {
		if (event.type !== AUCTION_CLOSED_EVENT) continue;
		if (readClosedPlayerId(event.payload) !== fantraxPlayerId) continue;
		const seq = BigInt(event.seq);
		if (closeSeq === null || seq < closeSeq) closeSeq = seq;
	}
	if (closeSeq === null) return null;

	const cut = closeSeq;
	const before = events.filter((event) => BigInt(event.seq) < cut);
	return auctionForPlayer(fold(INITIAL_AUCTIONS, before, auctionsReducer), fantraxPlayerId);
}

/**
 * The contention state of an Auction that may not have one yet.
 *
 * The one place `null` — "nominated, no Bid" — is mapped to
 * `awaiting_opening_bid`, so the read path, the gate and the tests cannot
 * each answer it differently.
 */
export function contentionOf(auction: Auction | null): ContentionState {
	return auction === null ? 'awaiting_opening_bid' : auction.contention;
}

/**
 * The one wording for each contention state, for a surface to print.
 *
 * The Auction page shows "state" among the things `epics.md` lists for it,
 * and a state is a fact about the Auction — so it is worded here, beside the
 * fold that decides it, rather than in a `.svelte` file where a second
 * spelling could drift from the literal. A plain sentence and no chip:
 * `DESIGN.md` assigns ambient states a plain label, and the one attention
 * colour in the product marks Outbid and refusal and nothing else.
 *
 * `minimum_bid` is a state this codebase produces since Story 3.2, and the
 * Auction page prints THIS sentence above the lottery's own label, accent
 * bar, Contender count and list — the sentence states which contention is
 * running; `MINIMUM_BID_CONTENTION_LABEL` names it beside the icon.
 */
export function contentionSentence(state: ContentionState): string {
	switch (state) {
		case 'awaiting_opening_bid':
			return 'Awaiting an Opening Bid.';
		case 'standard':
			return 'Standard Contention.';
		case 'minimum_bid':
			return 'Minimum-Bid Contention.';
	}
}

/**
 * The Minimum-Bid Contention's own label — the WORD that rides beside the
 * icon and the `lottery` accent bar on the Auction page.
 *
 * The PRD §3 glossary term verbatim, and worded here rather than in
 * `+page.svelte` for `contentionSentence`'s reason: a synonym in UI copy is a
 * defect, the same as a synonym in code (`EXPERIENCE.md`), and a second
 * spelling in a `.svelte` file is exactly where one would appear. It is the
 * label rather than the sentence because the panel already carries
 * `contentionSentence` above it, and a chip that ended in a full stop would
 * read as prose.
 *
 * It is also the name the `contention` gate goes by on the refusal panel, so
 * the chip and the accent bar name one thing.
 */
export const MINIMUM_BID_CONTENTION_LABEL = 'Minimum-Bid Contention';

/**
 * The same contention's CARD name — the word that rides the identity row of a
 * Bid Board card and a Your Positions card, where the glossary term does not
 * fit.
 *
 * A deliberate second name for one thing, and the only one in the product.
 * `MINIMUM_BID_CONTENTION_LABEL` is the PRD §3 term and stays everywhere the
 * contention is DEFINED or ACTED ON — the Auction page's chip, the refusal
 * panel's `contention` gate, every sentence `rules/bidding.ts` words. This is
 * the name on a surface that is scanned rather than read, where a 22-character
 * term set at `--size-10` beside a Player's name wraps the identity row on
 * every lottery card at 375px.
 *
 * Worded HERE, beside the term it shortens, for that term's own reason: the
 * two cards that print it must print the same string, and a second spelling in
 * a `.svelte` file is exactly where a third would appear.
 */
export const MINIMUM_LOTTERY_LABEL = 'Minimum Lottery';

/**
 * The same name again, for a NARROW viewport — the third and last spelling of
 * one thing.
 *
 * `MINIMUM_LOTTERY_LABEL` already shortens the PRD §3 term for a surface that
 * is scanned rather than read, and at 640px and up it fits. Below that it does
 * not: `Minimum Lottery` set at `--size-10` beside a Player's name still wraps
 * a Bid Board card's identity row on a phone, which is the width most of this
 * product is read at.
 *
 * `Minimum` alone is unambiguous where it appears — a card carries exactly one
 * state marker, and no other state in `AUCTION_STATE_LABELS` begins with the
 * word — and the diamond beside it is what carries the state in greyscale
 * either way.
 *
 * Worded HERE for the two labels above it's own reason: a second spelling in a
 * `.svelte` file is exactly where a third would appear.
 */
export const MINIMUM_LOTTERY_LABEL_NARROW = 'Minimum';

/**
 * The statement, in words, that joining does not restart the Auction Clock.
 *
 * `EXPERIENCE.md` asks for it by name — the lottery's card "states in words
 * that the clock will not reset on a join" — and DESIGN.md's rule that no
 * state may be conveyed by colour alone is why it is words rather than the
 * absence of a moving countdown. A Manager watching a lottery has to be able
 * to tell "the clock did not move" from "the page did not update", and only a
 * sentence does that.
 *
 * It quotes the clock's LENGTH but no instant: the absolute close renders
 * beside it from the fold's own `closesAt`, and a duration stated here that
 * disagreed with the persisted instant would be the invented figure the
 * refusal design exists to prevent.
 */
export const CONTENTION_CLOCK_UNMOVED =
	'The Auction Clock will not reset on a join. It closes 24 hours after the Opening Bid ' +
	'that started this contention, however many Teams join and however late they join.';

/**
 * What the published commitment IS, in words — the sentence the Auction page
 * prints above `hash(seed)` itself.
 *
 * A 64-character hex string on a page with no explanation beside it is a
 * figure a Manager cannot act on. This says what it commits to, that the
 * value behind it is sealed, and what they will be able to do with it at the
 * draw — which is the whole of why AD-14 publishes it this early.
 *
 * It quotes NO figure: the digest renders beside it from the fold's own
 * `seedHash`, so a sentence that named one would be a second copy of a value
 * that must be checkable character by character.
 */
export const SEED_COMMITMENT =
	'The seed for this draw was generated when the contention opened and sealed where no role ' +
	'can read it. Only its SHA-256 is published, and it is published now rather than at the ' +
	'draw — so when the seed is revealed you can hash it yourself and check it against this ' +
	'value.';

/**
 * What a dissolution IS, in words — the sentence the Auction page prints at
 * the head of the dissolution block (Story 3.3, FR-19).
 *
 * Worded here, beside the fold that produces the state, for
 * `contentionSentence`'s reason: a Manager returning to a page that used to
 * carry a lottery badge and a Contender list must be told what became of
 * them, and a second spelling of that in a `.svelte` file is exactly where a
 * synonym would appear.
 *
 * **It quotes no figure at all.** The amount that converted, the count that
 * was released and the new close instant all render beside it from the fold's
 * own values, and a figure restated in this string would be a second copy of
 * a number that must agree with the arithmetic beside it.
 */
export const CONTENTION_DISSOLVED =
	'This Minimum-Bid Contention dissolved. A converting Bid returned the Auction to Standard ' +
	'Contention, every former Contender was released, and the Auction Clock restarted from that ' +
	'Bid. Ordinary ascending rules apply from here: the next Bid must beat the current high by at ' +
	'least the Minimum Increment.';

/**
 * What the revealed seed IS, in words — the sentence printed above the seed
 * itself, beside the commitment published when the contention opened.
 *
 * `SEED_COMMITMENT`'s counterpart, one story on: that one says the value is
 * sealed and will be revealed, this one says it has been. It states what a
 * Manager can now DO with the pair, because a 64-character hex string and a
 * second one beside it explain nothing on their own.
 *
 * **No draw ran, and this says so.** A revealed seed on a page that also
 * shows a Contender list would otherwise read as a draw result; the seed is
 * revealed here precisely because this contention will never draw.
 */
export const SEED_REVEALED =
	'The seed sealed when this contention opened is revealed below, beside the commitment that ' +
	'was published at the time. Hash the seed yourself and the two must match. No draw was run ' +
	'and no winner was selected — the contention dissolved instead, so the sealed value is opened ' +
	'here rather than left behind.';

/**
 * The statement that a revealed seed has nothing to check it against.
 *
 * Reachable only from a log whose opening Bid carried no commitment or a
 * malformed one — a state this codebase cannot write and `readPayload` folds
 * to a `null` `seedHash` rather than crashing over. The dissolution still
 * proceeds and still reveals, because refusing would strand the Auction in a
 * contention forever; what it must not do is imply a verification that is not
 * available.
 *
 * Printed INSTEAD of `SEED_REVEALED`, never beside it: two sentences making
 * opposite claims about the same value is the one thing a page stating facts
 * may never do.
 */
export const SEED_COMMITMENT_UNVERIFIABLE =
	'No commitment was published when this contention opened, so there is nothing to check this ' +
	'seed against. It is stated for the record rather than as something you can verify.';

/**
 * How many Teams were Contenders when the contention dissolved, as a finished
 * sentence.
 *
 * `contenderCountSentence`'s counterpart in the past tense, and a second
 * function rather than a tense parameter because "so far" is simply the wrong
 * words for a list that is over: a dissolved contention takes no further
 * join, so a sentence implying more may arrive would be false.
 *
 * **It says these Teams CONTENDED, and does not say each was released.** FR-19
 * permits a Contender to be the converting bidder, and the count this sentence
 * words is the whole list — so on the page it can sit directly above a Leading
 * Bidder line naming one of the very Teams it is describing. "3 former
 * Contenders, released" would then be false about one of the three, beside the
 * evidence that it is false. What every Team on the list has in common is that
 * it contended; what became of each is the Leading Bidder line's to say.
 *
 * Zero is a real state a total function must answer for — a lottery whose
 * only Bids were malformed, in a log this codebase cannot write.
 */
export function formerContenderSentence(count: number): string {
	if (count === 0) return 'No Teams had joined this contention when it dissolved.';
	if (count === 1) return 'One Team contended before this contention dissolved.';
	return `${String(count)} Teams contended before this contention dissolved.`;
}

/**
 * Whether this Auction's Minimum-Bid Contention dissolved — the ONE
 * derivation of it, so no surface assembles the two-fact test itself.
 *
 * A revealed seed and a `standard` contention, together. Neither alone is the
 * answer: a live lottery has a sealed seed this fold has never seen, and an
 * Auction that was never a lottery is `standard` with no seed at all. Only a
 * contention that ran and then converted produces both.
 *
 * Structural in its parameter so the read path can ask it of a whole
 * `Auction` and the surface can ask it of the two fields it was handed —
 * neither has to reach for the other's shape, and there is still only one
 * expression of the rule.
 */
export function wasDissolved(auction: {
	readonly contention: ContentionState;
	readonly seed: string | null;
}): boolean {
	return auction.seed !== null && auction.contention === 'standard';
}

/**
 * How many Teams have joined, as a finished sentence.
 *
 * A count is a figure, and `EXPERIENCE.md` requires the lottery's card to
 * carry one — so it is worded here beside the fold that derives the list,
 * rather than left to a surface to interpolate into prose of its own. The
 * singular is written out because "1 Contenders" is the kind of sentence that
 * tells a Manager at 4am that nobody proof-read the thing they are being
 * asked to trust.
 *
 * Zero is a real state a total function must answer for: an Auction that is
 * not a lottery has no Contenders, and so — briefly, in a log this codebase
 * cannot write — would a lottery whose only Bids were malformed.
 */
export function contenderCountSentence(count: number): string {
	if (count === 0) return 'No Teams have joined this contention yet.';
	if (count === 1) return 'One Contender so far.';
	return `${String(count)} Contenders so far.`;
}

/**
 * Which contention an amount puts an Auction in.
 *
 * Exactly `MINIMUM_BID` is a Minimum-Bid Contention; anything above it is
 * Standard. Derived from the leading amount rather than stored on the event,
 * because a stored contention state could disagree with the price beside it
 * and AD-5 makes the fold the answer.
 *
 * **Exported since Story 3.2, and the export is the point.** `decide()` has
 * to know whether the Bid it is authorising OPENS a contention, because that
 * is the one Bid that carries `hash(seed)` and the one opening that writes a
 * seed row. Asking this function is what keeps the payload's commitment and
 * the fold's contention state from being two independent judgements about the
 * same amount — a rule stated in `rules/bidding.ts` and re-stated here could
 * drift, and a contention that folded without a published commitment is
 * exactly the state AD-14 cannot survive.
 *
 * Takes an AMOUNT rather than a `Bid`, so the caller that has only a
 * prospective amount can ask it as easily as the reducer that has a folded
 * one.
 */
export function contentionForAmount(amount: Money): ContentionState {
	return compareMoney(amount, parseMoney(MINIMUM_BID)) === 0 ? 'minimum_bid' : 'standard';
}

/**
 * The highest Bid in a history whose standing has not been withdrawn, or
 * `null` when none stands (Story 10.3, FR-40).
 *
 * **The reducer's own "strictly higher takes the lead", stated once.** A Bid
 * only displaces the current highest by being strictly greater, so the
 * EARLIEST of two equal amounts wins — which is what makes replay converge and
 * what makes a lottery, where every join is the identical flat amount, keep
 * the first join it folded.
 *
 * Two callers, and they have to agree: `auctionsReducer` asks it for the
 * incumbent a new Bid must beat when the leader has been cancelled out from
 * under it, and `withBidCancelled` asks it for the successor to a lottery's
 * fold artifact. A second expression of "highest surviving" could disagree
 * with this one about a tie.
 */
function highestStandingBid(bids: readonly Bid[]): Bid | null {
	let highest: Bid | null = null;
	for (const bid of bids) {
		if (wasCancelled(bid)) continue;
		if (highest === null || compareMoney(bid.amount, highest.amount) > 0) highest = bid;
	}
	return highest;
}

/**
 * The Contenders a Bid history yields, in ascending `seq`, one per Team.
 *
 * A Contender is a Bid of EXACTLY `MINIMUM_BID` — the join amount — and
 * nothing else. A malformed historical `BidPlaced` at `$1,000,001` on a
 * lottery folds into `bids` and into the visible history exactly as it does
 * today, and is NOT a Contender: it did not join, and AD-14's draw runs over
 * the Teams that did.
 *
 * `bids` is already in `seq` order by construction — `fold()` guarantees it
 * (AD-5) and this reducer appends in fold order — so nothing here sorts. The
 * dedup keeps the earliest join per Team, which is both what "ascending join
 * `seq`" means and what stops a Team appearing twice in the ordered list the
 * winner is derived from.
 */
function contendersFor(bids: readonly Bid[]): readonly Contender[] {
	const contenders: Contender[] = [];
	const joined = new Set<string>();
	for (const bid of bids) {
		// **A cancelled Contender leaves the list here, and only here**
		// (Story 10.3, FR-40). The joining Bid stays in `bids` and stays in
		// the visible history; what it stops being is a ticket in the draw.
		// This is the whole of "a cancelled Contender cannot be drawn" —
		// `contendersFor` is recomputed from `bids` on every fold, AD-14's
		// ordered list is derived from it, and `teamMoneyStateFor` reads the
		// same list to decide whose capital is still committed. One skip, and
		// the draw, the exposure and the page all agree.
		if (wasCancelled(bid)) continue;
		if (contentionForAmount(bid.amount) !== 'minimum_bid') continue;
		if (joined.has(bid.teamId)) continue;
		joined.add(bid.teamId);
		contenders.push({
			seq: bid.seq,
			teamId: bid.teamId,
			teamName: bid.teamName,
			// The JOINING Bid's Manager, kept because a drawn winner names
			// them and this loop is the one place that already holds the pair.
			managerId: bid.managerId
		});
	}
	return contenders;
}

/**
 * The `BidPlaced` payload as this reducer needs it, read defensively.
 *
 * `AppendedEvent.payload` is `unknown` — whatever JSON the column holds — and
 * an insert-only log cannot be corrected in place, so a malformed historical
 * row must never crash the fold. Returning `null` rather than throwing is
 * `nominations.ts`'s discipline for the same reason, and a Bid naming no
 * Player, no Team or no amount is *skipped*: it cannot be a price, cannot be
 * a Leading Bidder, and cannot be a history line naming who acted.
 *
 * The amount is the one field parsed rather than trusted. `parseMoney`
 * accepts both shapes an `int8` arrives as and throws on everything else
 * (AD-8); that throw is caught here and turned into a skip, because a
 * corrupt payload in an insert-only log is not this fold's to crash over —
 * the same trade `readPayload` already makes for a missing Player id.
 *
 * `closesAt` falls back to the event's own `occurredAt` when absent or
 * unparseable, which is the conservative direction: an Auction whose close
 * cannot be read reads as already due rather than as running forever. It
 * never invents a later one.
 */
function readPayload(
	payload: unknown,
	event: { readonly seq: string; readonly occurredAt: string }
): { readonly fantraxPlayerId: string; readonly bid: Bid } | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const record = payload as Record<string, unknown>;

	const fantraxPlayerId = record['fantraxPlayerId'];
	const teamId = record['teamId'];
	const managerId = record['managerId'];
	if (typeof fantraxPlayerId !== 'string' || fantraxPlayerId === '') return null;
	if (typeof teamId !== 'string' || teamId === '') return null;
	if (typeof managerId !== 'string' || managerId === '') return null;

	let amount: Money;
	try {
		amount = parseMoney(record['amount']);
	} catch {
		return null;
	}
	// A negative amount is skipped for the same reason a missing Team id is:
	// it cannot be a price. `parseMoney` accepts an optionally-signed digit
	// run — legitimately, because Available Cap Space is legitimately
	// negative — so the sign has to be refused HERE, exactly as
	// `readBidAmount` refuses it at the form boundary. Without this a
	// malformed historical row carrying `-500000` would fold in as a Bid, and
	// while it could never take the lead from a positive one, it would become
	// the leading Bid of an Auction whose only Bids were negative.
	if (amount < 0) return null;

	const teamName = record['teamName'];
	const rawClosesAt = record['closesAt'];
	const closesAt =
		typeof rawClosesAt === 'string' && parseInstant(rawClosesAt) !== null
			? rawClosesAt
			: event.occurredAt;

	// The commit half of AD-14, read DEFENSIVELY: absent is `null`, and so is
	// anything that is not a non-empty string. It is never validated as a
	// digest and never re-derived here — this fold has no seed to hash and no
	// business deciding whether a published commitment is well formed. A
	// malformed one is a fact about the log for Story 3.6's reveal to refuse,
	// not a reason for the price and the Leading Bidder to stop folding.
	const rawSeedHash = record['seedHash'];
	const seedHash = typeof rawSeedHash === 'string' && rawSeedHash !== '' ? rawSeedHash : null;

	return {
		fantraxPlayerId,
		bid: {
			seq: event.seq,
			teamId,
			// The Team's name is audit detail the Leading Bidder line prints; the
			// id is what the self-bid gate matches on. A missing name falls back
			// to the id, which still identifies the Team, rather than dropping a
			// Bid that was genuinely placed.
			teamName: typeof teamName === 'string' && teamName !== '' ? teamName : teamId,
			managerId,
			amount,
			occurredAt: event.occurredAt,
			closesAt,
			seedHash
		}
	};
}

/**
 * The `ContentionDissolved` payload as this reducer needs it, read
 * defensively — `readPayload`'s idiom, for `readPayload`'s reason: the column
 * holds whatever JSON was written and an insert-only log cannot be corrected
 * in place, so a malformed historical row must never crash the fold.
 *
 * An event naming no Player is SKIPPED outright: there is no Auction it could
 * be about. A malformed or absent `seed` folds to `null` rather than to a
 * skip, which is the honest reading of the two facts separately — the
 * dissolution happened, and the reveal on it is unusable. Nothing here
 * validates the seed against the commitment; `decide()` did that before the
 * event was ever appended, and a fold has no seed of its own to compare.
 *
 * The three fields this reducer does NOT read — the ordered former
 * Contenders, the converting Team and the amount — ride the payload for
 * Epic 5's dispatcher, which must notify every former Contender from one
 * event without re-folding. They are deliberately not narrowed here.
 */
function readDissolvedPayload(
	payload: unknown
): { readonly fantraxPlayerId: string; readonly seed: string | null } | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const record = payload as Record<string, unknown>;
	const fantraxPlayerId = record['fantraxPlayerId'];
	if (typeof fantraxPlayerId !== 'string' || fantraxPlayerId === '') return null;
	const rawSeed = record['seed'];
	return {
		fantraxPlayerId,
		seed: typeof rawSeed === 'string' && rawSeed !== '' ? rawSeed : null
	};
}

/**
 * What a cancellation's cause is called when the log names neither a Player
 * nor an id for it — a corrupt-payload state this codebase cannot write.
 *
 * Worded here, beside the fold that produces it, for `contentionSentence`'s
 * reason: it is a sentence fragment a surface prints verbatim, and a second
 * spelling in a `.svelte` file is exactly where a synonym would appear. It
 * claims nothing it cannot support — least of all a Player nobody can look up.
 */
export const CAUSE_UNNAMED = 'a win this log does not name';

/**
 * The `BidCancelled` payload as this reducer needs it, read defensively —
 * `readPayload`'s idiom for `readPayload`'s reason.
 *
 * An event naming no Player or no cancelled `seq` is SKIPPED outright: there
 * is no Bid it could be about, and inventing one would withdraw the standing
 * of whichever Bid happened to sort first. The CAUSE falls back rather than
 * skipping — a cancellation whose cause cannot be read still happened, and
 * the history line names the Player by id, which is the fallback every
 * `readPayload` in this core already makes.
 *
 * The fields this reducer does NOT read — the cancelled Team and the amount
 * released — ride the payload for the dispatcher, which must notify the
 * cancelled Manager from one event without re-folding. They are deliberately
 * not narrowed here.
 *
 * **`restoration` IS read, since Story 10.4**, and it is the one field on this
 * payload the fold acts on rather than merely carries: it says who leads the
 * Auction now. It degrades to `null` rather than throwing, exactly as the
 * cause degrades to a sentence — a fold that threw on a malformed payload
 * would take the whole projection down over one bad row, and `null` is a real
 * state this fold already models (nothing survived re-validation) rather than
 * an invented one.
 */
function readCancelledPayload(payload: unknown): {
	readonly fantraxPlayerId: string;
	readonly cancelledSeq: string;
	readonly causeFantraxPlayerId: string;
	readonly causePlayerName: string;
	readonly restoration: Restoration | null;
} | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const record = payload as Record<string, unknown>;
	const fantraxPlayerId = record['fantraxPlayerId'];
	const cancelledSeq = record['cancelledSeq'];
	if (typeof fantraxPlayerId !== 'string' || fantraxPlayerId === '') return null;
	if (typeof cancelledSeq !== 'string' || cancelledSeq === '') return null;
	const rawCause = record['causeFantraxPlayerId'];
	const causeFantraxPlayerId = typeof rawCause === 'string' && rawCause !== '' ? rawCause : '';
	const rawCauseName = record['causePlayerName'];
	// **The name falls back to the id, and the id falls back to a SENTENCE.**
	// Naming the cause by id is `readPayload`'s fallback everywhere in this
	// core; falling through to the empty string when there is no id either
	// would put a history line on the page reading "cancelled by the win on"
	// and then nothing at all. A cancellation whose cause the log cannot name
	// still happened, and saying so is the honest rendering — the same trade
	// `SEED_COMMITMENT_UNVERIFIABLE` makes for a reveal with nothing to check.
	const causePlayerName =
		typeof rawCauseName === 'string' && rawCauseName !== ''
			? rawCauseName
			: causeFantraxPlayerId !== ''
				? causeFantraxPlayerId
				: CAUSE_UNNAMED;
	return {
		fantraxPlayerId,
		cancelledSeq,
		causeFantraxPlayerId,
		causePlayerName,
		restoration: readRestoration(record['restoration'])
	};
}

/**
 * The `restoration` half of a `BidCancelled` payload, read defensively —
 * `null` for the ordinary "nothing survived" case and `null` again for any
 * shape this fold cannot use (Story 10.4).
 *
 * **All five fields or none.** A restoration naming a `seq` but no Team
 * cannot address the notice it exists to send, and one naming a Team but no
 * `seq` names no Bid for `withBidCancelled` to seat — so a partial record is
 * treated as the absent one rather than half-applied. Degrading here is what
 * keeps the fold total: `auctionsReducer` runs on every read path in the
 * product, and a throw inside it over one malformed row would take out the
 * board, the Auction page and every close after it.
 *
 * The amount is required to be a whole number of dollars above zero —
 * `Money`'s own domain, which `parseMoney` states as a safe integer, narrowed
 * by the fact that no Bid this product accepts is zero or negative (the
 * opening minimum is $1,000,000). A fractional or negative figure is not a
 * Bid amount at all, so a record carrying one is not a restoration this fold
 * can report.
 *
 * It is still not what seats the leader — `withBidCancelled` finds the Bid at
 * `seq` and uses that Bid — so even a plausible-but-wrong figure here is a
 * wrong figure in a notice, never a wrong price on an Auction. The check is
 * about not carrying nonsense into a Manager's notice, not about the fold.
 */
function readRestoration(value: unknown): Restoration | null {
	if (typeof value !== 'object' || value === null) return null;
	const record = value as Record<string, unknown>;
	const seq = record['seq'];
	const teamId = record['teamId'];
	const teamName = record['teamName'];
	const managerId = record['managerId'];
	const amount = record['amount'];
	if (typeof seq !== 'string' || seq === '') return null;
	if (typeof teamId !== 'string' || teamId === '') return null;
	if (typeof teamName !== 'string' || teamName === '') return null;
	if (typeof managerId !== 'string' || managerId === '') return null;
	if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return null;
	return { seq, teamId, teamName, managerId, amount };
}

/**
 * One Auction with one Bid's standing withdrawn — the WHOLE of what a
 * cancellation does to the fold (Story 10.3, FR-40).
 *
 * Exported because two callers must produce byte-identical state from one
 * decision: `auctionsReducer` folding the appended `BidCancelled`, and
 * `rules/close.ts`'s cascade, which has to see the effect of each
 * cancellation before it decides whether a further one is owed. A cascade
 * that modelled the effect itself would be a second statement of this rule,
 * and the two could disagree about the state the next iteration tests.
 *
 * Four things happen and no fifth:
 *
 *  - the named Bid gains its `cancellation` marker. It is NOT removed from
 *    `bids`, not reordered, and not otherwise touched — the history line FR-40
 *    requires kept visible is the same object with one more field.
 *  - `contenders` is recomputed from `bids`, which drops the cancelled Team
 *    from the draw and from its own committed capital (`contendersFor`).
 *  - the LEAD is withdrawn if the cancelled Bid held it, and left alone if it
 *    did not. In Standard Contention it is handed to whoever
 *    `cancellation.restoration` NAMES, and to nobody otherwise. **The
 *    recorded decision is read and never re-derived** (Story 10.4, AD-31):
 *    `rules/restore.ts` walked the surviving history inside the closing
 *    transaction, re-ran the cap and slots gates over each candidate's roster
 *    and committed capital, skipped the ones that failed and stopped at the
 *    first pass. A skipped candidate is a surviving Bid that must NOT lead,
 *    which is exactly what `highestStandingBid` would make it — so that
 *    derivation is not asked here, and the leaderless branch is
 *    `restoration === null` rather than "no Bid stands".
 *  - **inside a Minimum-Bid Contention the lead MOVES, and that is not
 *    restoration.** `rules/bidding.ts` says outright that a lottery's
 *    `leadingBid` is a fold artifact — some Bid has to be the highest, and
 *    every Contender holds the identical flat `MINIMUM_BID` — so the artifact
 *    moving to the earliest surviving join changes nobody's position, nobody's
 *    committed capital and nobody's price. Withdrawing it to `null` instead
 *    would take the lottery's fixed Auction Clock with it and strand a
 *    contention that is still running, which is the opposite of what FR-40
 *    asks for.
 *  - `closesAt` is cleared, and `contention` returns to `awaiting_opening_bid`,
 *    only when a STANDARD Auction is left with no leader. A cancellation
 *    resets no clock and removes none: where a Bid is restored the Auction
 *    Clock is untouched and the Restored Leading Bidder inherits whatever is
 *    left of it — possibly minutes — and where none is, a cleared clock is
 *    what stops the Auction closing at its old expiry with no winner. Note
 *    that "no leader" is not "no surviving Bid": every candidate can fail
 *    re-validation while `bids` still holds several standing offers, and that
 *    Auction goes back to Awaiting Opening Bid with the Player still on the
 *    Board and the nominator's Nomination Slot still held (FR-9).
 *  - **inside a Minimum-Bid Contention neither happens, however many joins
 *    are cancelled — including the last** (Story 10.5). The contention stays
 *    `minimum_bid` and keeps its fixed `closesAt` even with `contenders`
 *    empty and `leadingBid` null. A lottery's clock is the CONTENTION's, not
 *    any bidder's, so no Team's departure earns it: "a cancellation resets
 *    nothing and removes nothing" applies to the clock too. And an emptied
 *    lottery has a definite outcome that must be RECORDED — the empty list,
 *    the revealed seed, the Player back in the pool and the nominator's Slot
 *    released — which only an expiry the sweep still offers can reach.
 *    `rules/close.ts` decides that outcome as a `ContentionDrawn` over an
 *    empty list followed by an `AuctionTerminated`; clearing the clock here
 *    would strand the sealed seed unopened, which is the one thing AD-14
 *    cannot survive.
 *
 * Idempotent: a Bid already carrying a marker, or a `seq` this Auction has
 * never held, returns the Auction unchanged, so a second fold of the same log
 * converges.
 */
export function withBidCancelled(
	auction: Auction,
	cancelledSeq: string,
	cancellation: BidCancellation
): Auction {
	const target = auction.bids.find((bid) => bid.seq === cancelledSeq) ?? null;
	if (target === null || wasCancelled(target)) return auction;

	const bids = auction.bids.map((bid) =>
		bid.seq === cancelledSeq ? { ...bid, cancellation } : bid
	);
	const leaderWasCancelled = auction.leadingBid !== null && auction.leadingBid.seq === cancelledSeq;
	// The artifact's successor, and it exists only inside a lottery, where
	// every join is the identical flat amount so "highest standing" is simply
	// the earliest one still in. Outside a lottery it is never asked for:
	// promoting a strictly LOWER Bid is RESTORATION, and restoration is a
	// decision, not a derivation.
	const artifactSuccessor =
		auction.contention === 'minimum_bid' ? highestStandingBid(bids) : null;
	// The RECORDED decision, looked up in this Auction's own history. The
	// `seq` is the identity; the payload's `amount` is not consulted, so a
	// malformed figure cannot put a price on this Auction that no Bid ever
	// offered. A `seq` naming no Bid here, or one this very event cancelled,
	// degrades to leaderless — the state the fold already models — rather
	// than seating something that is not in `bids`.
	const restored =
		auction.contention === 'minimum_bid'
			? null
			: restoredBidFor(bids, cancellation.restoration, cancelledSeq);

	// A cancellation that did not take the lead leaves the lead exactly where
	// it was: only the leader's own withdrawal can hand the Auction on.
	const leadingBid = leaderWasCancelled
		? (auction.contention === 'minimum_bid' ? artifactSuccessor : restored)
		: auction.leadingBid;

	// **A lottery keeps both, always** (Story 10.5). Inside a Minimum-Bid
	// Contention the clock belongs to the contention rather than to any
	// bidder, so an emptied Contender list leaves it exactly where it was and
	// the Auction goes on being a lottery with nobody in it — one the sweep
	// still offers, and that `decideClose` ends by revealing the seed over an
	// empty list and terminating. Only a STANDARD Auction withdraws to
	// Awaiting Opening Bid with its clock cleared, which is Story 10.4's
	// branch and is untouched here.
	const leaderless = leadingBid === null && auction.contention !== 'minimum_bid';

	return {
		...auction,
		contention: leaderless ? 'awaiting_opening_bid' : auction.contention,
		leadingBid,
		// Untouched wherever a leader stands — restored or never withdrawn —
		// and cleared only where a Standard Auction has none.
		closesAt: leaderless ? null : auction.closesAt,
		bids,
		contenders: contendersFor(bids)
	};
}

/**
 * The Bid a recorded `Restoration` names, or `null` (Story 10.4).
 *
 * Three ways to `null`, and each is a state rather than a failure: nothing was
 * restored, the named `seq` is not in this Auction's history, or it names a
 * Bid whose own standing has been withdrawn. The last covers the `seq` this
 * very cancellation just marked, so a payload that restored its own victim
 * cannot loop the lead back onto it.
 *
 * The Bid itself is returned — the object already in `bids`, with its own
 * amount, Team and clock — rather than one built from the payload, which is
 * what keeps a malformed record from inventing a Leading Bidder.
 */
function restoredBidFor(
	bids: readonly Bid[],
	restoration: Restoration | null,
	cancelledSeq: string
): Bid | null {
	if (restoration === null) return null;
	if (restoration.seq === cancelledSeq) return null;
	const bid = bids.find((candidate) => candidate.seq === restoration.seq) ?? null;
	if (bid === null || wasCancelled(bid)) return null;
	return bid;
}

/**
 * Every entry of a record except the named key, built through
 * `Object.entries`/`Object.fromEntries` for `hasOwn`'s reason: the keys are
 * data, and `record[key] = value` on `__proto__` would set a prototype.
 */
function omitKey(
	record: Readonly<Record<string, Auction>>,
	key: string
): Readonly<Record<string, Auction>> {
	return Object.fromEntries(Object.entries(record).filter(([existing]) => existing !== key));
}

/**
 * Fold one event onto the open Auctions.
 *
 * The `default: return state` discipline is `phase.ts`'s, for the same
 * reason: an event type this reducer has not been taught is not an error, it
 * is simply not about bidding.
 *
 * Replay converges. A `BidPlaced` already in history — same `seq` — is
 * ignored outright, and a Bid that is not strictly higher than the current
 * leader never takes the lead, so a second fold of the same log produces the
 * identical state. A close for a Player with no Auction changes nothing, for
 * the reason `nominationsReducer` gives.
 */
export const auctionsReducer: Reducer<OpenAuctions> = (state, event) => {
	switch (event.type) {
		case BID_PLACED_EVENT: {
			const read = readPayload(event.payload, event);
			if (read === null) return state;
			const { fantraxPlayerId, bid } = read;

			const existing = hasOwn(state.byPlayer, fantraxPlayerId)
				? (state.byPlayer[fantraxPlayerId] ?? null)
				: null;

			if (existing === null) {
				const auction: Auction = {
					fantraxPlayerId,
					contention: contentionForAmount(bid.amount),
					leadingBid: bid,
					closesAt: bid.closesAt,
					bids: [bid],
					contenders: contendersFor([bid]),
					seedHash: bid.seedHash,
					// No reveal can precede the first Bid: a `ContentionDissolved`
					// for a Player with no Auction is skipped below, so the only
					// way here is with nothing revealed yet.
					seed: null
				};
				return { byPlayer: { ...state.byPlayer, [fantraxPlayerId]: auction } };
			}

			// `seq` is database-assigned and never reissued, so it is the one
			// field that identifies a Bid across two folds of the same log.
			if (existing.bids.some((recorded) => recorded.seq === bid.seq)) return state;

			// **The question is unchanged — is this Bid strictly higher? — but
			// since Story 10.3 it is asked of the highest STANDING Bid rather
			// than of the leader.** The two are the same Bid in every Auction
			// that has never seen a cancellation. They part company in exactly
			// one state: FR-40 withdraws a leader's standing while lower Bids
			// go on standing, which leaves `leadingBid` null over a history
			// that is emphatically not empty. Leaderless is not bidless, and
			// treating it as bidless here would let a new Bid BELOW a surviving
			// one take the lead — a price that falls because somebody else's
			// Bid was cancelled, which no rule in this product permits.
			//
			// A Bid that fails to beat the highest survivor leaves the Auction
			// exactly as it found it: still leaderless, and still with whatever
			// clock the cancellation left it — which since Story 10.4 is no
			// clock at all, an Auction back at Awaiting Opening Bid.
			//
			// **Story 10.4 audited this fallback and KEPT it, deliberately.**
			// After a restoration `leadingBid` is set, so the `??` never
			// reaches the second operand and nothing here changed. After a
			// FAILED restoration it falls back to a Bid the restorer SKIPPED —
			// and that is the intended answer, because the two questions are
			// different ones. "Who may lead" is decided by the gates, and a
			// skipped candidate failed them. "What must a NEW Bid beat" is
			// decided by the history, and a skipped candidate is still a
			// standing, un-cancelled, publicly visible offer at that amount.
			// Letting a fresh Bid take the lead BELOW it would be a price that
			// fell because somebody else's Bid was cancelled — which no rule in
			// this product permits, and which is the very failure the paragraph
			// above added this expression to prevent.
			const standing = existing.leadingBid ?? highestStandingBid(existing.bids);
			const leadingBid =
				standing === null || compareMoney(bid.amount, standing.amount) > 0
					? bid
					: existing.leadingBid;

			// Appended in fold order, which `fold()` guarantees is `seq` order
			// (AD-5) — so the history is chronological by construction and
			// nothing here sorts by `occurredAt`, which under the global lock
			// can run backwards relative to commit order.
			const bids = [...existing.bids, bid];

			const auction: Auction = {
				// Both read off the leader, and both stand still when there is
				// none: an Auction that stays leaderless keeps the contention
				// and the clock it already had, which is the same "a
				// cancellation resets nothing" the cancellation itself keeps.
				contention:
					leadingBid === null ? existing.contention : contentionForAmount(leadingBid.amount),
				fantraxPlayerId,
				leadingBid,
				closesAt: leadingBid === null ? existing.closesAt : leadingBid.closesAt,
				bids,
				// **A join never moves the lead, so it never moves the clock —
				// and that is a second guarantee, not the rule.** A Bid of
				// exactly `MINIMUM_BID` into a live contention is not strictly
				// higher than the `MINIMUM_BID` already leading, so `leadingBid`
				// and `closesAt` above are unchanged by construction. Story 3.2
				// does not rely on that: `decide()` stamps the contention's
				// EXISTING `closesAt` onto every join's own payload, so the
				// persisted log states one close instant per contention whether
				// or not this fold happens to preserve it.
				contenders: contendersFor(bids),
				// The FIRST commitment seen, kept. A second `seedHash` in the
				// same Auction cannot replace the published one — replay would
				// otherwise be able to swap the commitment a Manager already
				// checked.
				seedHash: existing.seedHash,
				// A Bid never reveals anything. The reveal is `ContentionDissolved`'s
				// alone, and it is carried across here unchanged so a Bid placed
				// AFTER a dissolution — an ordinary ascending raise — cannot
				// erase the seed the dissolution published.
				seed: existing.seed
			};
			return { byPlayer: { ...state.byPlayer, [fantraxPlayerId]: auction } };
		}
		case CONTENTION_DISSOLVED_EVENT: {
			// **This case records the reveal and NOTHING else.** The return to
			// `standard`, the new Leading Bidder, the restarted clock and the
			// released commitments are all consequences of the converting
			// `BidPlaced` folded above — a strictly higher amount, read through
			// `contentionForAmount` — and re-deriving any of them here would be
			// a second judgement about one event pair. `contenders` in
			// particular is NOT cleared: the list is what the reveal is about,
			// and `teamMoneyStateFor` tests the contention STATE rather than
			// the list being empty, which is the line that makes a dissolved
			// contention commit nobody while keeping its history.
			const read = readDissolvedPayload(event.payload);
			if (read === null) return state;
			const { fantraxPlayerId, seed } = read;
			if (!hasOwn(state.byPlayer, fantraxPlayerId)) return state;
			const existing = state.byPlayer[fantraxPlayerId] ?? null;
			if (existing === null) return state;
			// **An Auction that never ran a lottery has no reveal to record.**
			// A hand-written or corrupt `ContentionDissolved` naming an
			// ordinary Auction would otherwise set `seed`, which would make
			// `wasDissolved` true and put a dissolution block — former
			// Contenders, a revealed seed, a published hash — on a page whose
			// Auction had none of those things.
			//
			// The test is the CONTENDER LIST and emphatically not the
			// contention state: by the time this case runs, the converting
			// `BidPlaced` has already folded and moved the Auction to
			// `standard`, so `existing.contention !== 'minimum_bid'` would
			// reject every genuine dissolution there is. A Contender is a Bid
			// at exactly `MINIMUM_BID` that the log already holds, and
			// `contenders` is never cleared — so a non-empty list is the one
			// durable evidence that a lottery ran here, before and after the
			// dissolution alike.
			if (existing.contenders.length === 0) return state;
			// The FIRST reveal seen, kept — `seedHash`'s rule, and what makes a
			// second fold of the same log converge on the same seed.
			if (existing.seed !== null) return state;
			if (seed === null) return state;
			return {
				byPlayer: { ...state.byPlayer, [fantraxPlayerId]: { ...existing, seed } }
			};
		}
		case BID_CANCELLED_EVENT: {
			// **This case READS a decision it does not make** (AD-31). Which
			// Bid was cancelled, and why, were decided by `rules/close.ts`
			// running the gate suite inside the closing transaction; re-deriving
			// either here would mean re-running `evaluateSlots` inside a fold,
			// over a Team whose roster this projection cannot see.
			const read = readCancelledPayload(event.payload);
			if (read === null) return state;
			const { fantraxPlayerId, cancelledSeq, causeFantraxPlayerId, causePlayerName, restoration } =
				read;
			if (!hasOwn(state.byPlayer, fantraxPlayerId)) return state;
			const existing = state.byPlayer[fantraxPlayerId] ?? null;
			if (existing === null) return state;
			const cancelled = withBidCancelled(existing, cancelledSeq, {
				// The CANCELLING event's own position, so the history line can
				// be looked up in the Audit Log from the Bid it struck through.
				seq: event.seq,
				causeFantraxPlayerId,
				causePlayerName,
				// Passed straight through, already narrowed and already degraded
				// to `null` if the payload could not be read. This reducer makes
				// no restoration decision of its own and could not: the gates
				// that made this one ran over a roster no projection can see.
				restoration
			});
			// Unchanged when the `seq` names no Bid here or one already
			// cancelled — the identity check that makes replay converge.
			if (cancelled === existing) return state;
			return { byPlayer: { ...state.byPlayer, [fantraxPlayerId]: cancelled } };
		}
		case AUCTION_CLOSED_EVENT: {
			// The SAME reader `nominationsReducer` folds a close through, so a
			// close naming no Player is skipped here exactly as it is skipped
			// there — the board seat, the Nomination Slot and the Auction can
			// never be released apart from one another.
			const fantraxPlayerId = readClosedPlayerId(event.payload);
			if (fantraxPlayerId === null) return state;
			if (!hasOwn(state.byPlayer, fantraxPlayerId)) return state;
			return { byPlayer: omitKey(state.byPlayer, fantraxPlayerId) };
		}
		case AUCTION_TERMINATED_EVENT: {
			// **The close case, for the other way an Auction ends** (Story
			// 10.5). Until now no terminated Player had an Auction at all —
			// `phase-end.ts` terminates nominations that never drew a Bid — so
			// this fold had nothing to drop and needed no case. A lottery whose
			// every Contender was cancelled does: it keeps its clock, expires,
			// reveals its seed over an empty list and terminates with no
			// winner. Without this case that Auction would survive its own
			// termination and be offered to `overdueAuctions` again on every
			// sweep, closing forever over the same empty list.
			//
			// The SAME reader `nominationsReducer` folds a termination through,
			// for the close case's reason: the board seat, the Nomination Slot
			// and the Auction can never be released apart from one another.
			// A termination naming a Player with no Auction — every one
			// `phase-end.ts` appends — changes nothing, which is what makes a
			// second fold of the same log converge.
			const terminated = readTerminatedPlayerId(event.payload);
			if (terminated === null) return state;
			if (!hasOwn(state.byPlayer, terminated)) return state;
			return { byPlayer: omitKey(state.byPlayer, terminated) };
		}
		default:
			return state;
	}
};

// --- Rendering the Auction Clock -------------------------------------------

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * How much of the Auction Clock is left, as of `now` — both ISO-8601 UTC
 * instants. Pure: the same two instants always produce the same phrase.
 *
 * The counterpart of `instant.ts`'s `relativePhrase`, which words a PAST
 * instant ("4 hours ago") and would read a future close as "moments ago".
 * A close time is always ahead of the reader, so it needs its own phrasing,
 * and it lives here — beside the fold that owns `closesAt` — rather than
 * being re-worded in a `.svelte` file where a second definition could drift.
 *
 * **This is a rendering, not authority.** AD-12 makes the persisted absolute
 * close instant the thing validation compares `now` against, and `hasExpired`
 * below is the ONE derivation that makes that comparison — Story 3.1's
 * `expiry` gate reads it, and so does the Auction page. This function is
 * still only a rendering: it words how much clock is left, and no gate in
 * `PLACE_BID_GATES` decides anything from the phrase it returns. The phrase
 * carries no urgency styling and no pressure — it is one plain sentence
 * fragment, and the absolute stamp renders beside it regardless.
 *
 * Either instant failing to parse returns a stated phrase rather than
 * throwing, which is `relativePhrase`'s discipline for the same input: a
 * malformed instant is not this function's business to crash over.
 */
export function closesInPhrase(closesAt: string, now: string): string {
	const close = parseInstant(closesAt);
	const current = parseInstant(now);
	if (close === null || current === null) return 'an unknown time left';

	const remaining = close - current;
	if (remaining <= 0) return 'no time left';

	// Under a minute is stated in words rather than as `0m left`, which reads
	// as "none" beside the `no time left` above it and is not what it means.
	// This is `relativePhrase`'s "moments ago" band, pointed the other way.
	if (remaining < MS_PER_MINUTE) return 'less than a minute left';

	if (remaining < MS_PER_HOUR) {
		return `${String(Math.floor(remaining / MS_PER_MINUTE))}m left`;
	}
	if (remaining < MS_PER_DAY) {
		const hours = Math.floor(remaining / MS_PER_HOUR);
		const minutes = Math.floor((remaining % MS_PER_HOUR) / MS_PER_MINUTE);
		return `${String(hours)}h ${String(minutes)}m left`;
	}
	const days = Math.floor(remaining / MS_PER_DAY);
	const hours = Math.floor((remaining % MS_PER_DAY) / MS_PER_HOUR);
	return `${String(days)}d ${String(hours)}h left`;
}

/**
 * The one sentence the board states about an Auction whose clock has run out.
 *
 * Worded here, beside the fold that owns `closesAt` and beside `hasExpired`
 * which decides it, so the gate's refusal and the Auction page's panel
 * compose from ONE string rather than spelling the same fact twice — the way
 * `bidPlacedNotice()` composes from `BID_CONSEQUENCE`. A complete sentence,
 * so a surface prints it verbatim and words nothing itself.
 *
 * It quotes no figure of any kind. An expiry is a fact about a clock, and a
 * money figure or a count on this sentence would be the invented figure the
 * refusal design exists to prevent.
 */
export const AUCTION_EXPIRED = 'This Auction expired.';

/**
 * Whether an Auction's persisted absolute close instant has been reached, as
 * of `now` — the ONE derivation of expiry-as-authority (AD-12).
 *
 * **The persisted instant is the authority and nothing else.** This function
 * is handed two instants and reads no projection, no contention state and no
 * nomination: an Auction whose close has passed is expired whether or not a
 * fold still holds a row for it, which is exactly AD-12's "never reads a
 * projection's open flag as authority". Story 3.5's sweep records the close
 * LATE when it stalls; nothing may be accepted in the gap it leaves.
 *
 * **At the close instant the Auction is closed.** `now >= closesAt`, not `>`:
 * Story 3.5 hands each Auction its own nominal expiry as `now`, so a Bid at
 * that exact instant must not beat the close it is being compared against.
 *
 * `null` PASSES — it is a nominated Player nobody has bid on, and no clock
 * exists until an Opening Bid starts one (`EXPERIENCE.md`'s Awaiting Opening
 * Bid card has no clock at all).
 *
 * **The two unreadable cases go opposite ways, deliberately.** An unreadable
 * `closesAt` reads as EXPIRED, which is the trade `readPayload` above already
 * makes in words: "an Auction whose close cannot be read reads as already due
 * rather than as running forever". An unreadable or empty `now` reads as NOT
 * expired, because `now` is the shell's to supply and AD-1 makes a shell bug
 * a throw rather than a returned refusal — passing keeps `decide()`'s
 * existing `TypeError` at `closeInstantFor` reachable, where refusing would
 * swallow it into a Manager-facing statement that is not true.
 *
 * Pure: the same two instants always give the same answer, and nothing here
 * reads a clock.
 */
export function hasExpired(closesAt: string | null, now: string): boolean {
	if (closesAt === null) return false;
	const close = parseInstant(closesAt);
	if (close === null) return true;
	const current = parseInstant(now);
	if (current === null) return false;
	return current >= close;
}

/**
 * `AUCTION_CLOCK` after a Bid's own instant, as an ISO-8601 UTC string.
 *
 * The one definition of an Auction's close instant, so `decide()` (which
 * stamps it onto the payload) and any later story that recomputes one cannot
 * disagree by a millisecond. Pure arithmetic on an instant the caller
 * supplies — nothing here reads a clock (AD-3).
 *
 * Returns `null` when `occurredAt` is not an instant this core can read,
 * rather than inventing one. `decide()` treats that as the bug it is.
 */
export function closeInstantFor(occurredAt: string, auctionClockMs: number): string | null {
	const start = parseInstant(occurredAt);
	if (start === null) return null;
	return formatInstant(start + auctionClockMs);
}

/**
 * Every Auction whose close instant has passed, in the ONE order a sweep may
 * close them in: ascending `closesAt`, ties broken on `fantraxPlayerId`
 * (Story 3.5, AD-11).
 *
 * **The order is an input to the outcome, not a presentation choice.** §10
 * example 17 is the whole reason: a Team with one Free Minor League Slot that
 * wins two eligible Players gets the first into minors at a `$0` Cap Hit and
 * the second into Active/Bench at full price, and which Player is "first" is
 * decided here. So it is derived once, purely, over an explicitly sorted
 * sequence — never over `Object.keys` insertion order, which is a property of
 * how the log happened to fold rather than of the Auctions themselves (AD-1).
 *
 * **Ties break on `fantraxPlayerId` ascending** because two Auctions CAN share
 * a close instant — two Bids inside the same transaction clock, or a
 * contention's fixed clock — and a comparator that returned 0 there would
 * leave the outcome to the engine's sort stability and, through that, to map
 * order again.
 *
 * **`hasExpired` is the only expiry rule**, called here exactly as the
 * `expiry` gate and `decideClose` call it, so the set the sweep closes and the
 * set validation refuses Bids against cannot drift apart (AD-12). An
 * unreadable `closesAt` therefore counts as overdue, and sorts FIRST — it is
 * already past due by that rule, and an ordering that buried it would be a
 * second, quieter answer to a question `hasExpired` has already answered.
 *
 * **A closed Auction is simply absent**: `auctionsReducer` removes the entry
 * on `AuctionClosed`, so the sweep re-deriving this set on every pass is
 * restart-safe by construction rather than by remembering what it did.
 *
 * Pure: two arguments in, a new array out, and nothing here reads a clock.
 */
export function overdueAuctions(auctions: OpenAuctions, now: string): readonly Auction[] {
	const due: Auction[] = [];
	// Sorted keys first, so the array handed to `sort` is itself deterministic
	// rather than merely sorted afterwards by a comparator that must then be
	// trusted to be total.
	for (const fantraxPlayerId of Object.keys(auctions.byPlayer).sort()) {
		if (!hasOwn(auctions.byPlayer, fantraxPlayerId)) continue;
		const auction = auctions.byPlayer[fantraxPlayerId];
		if (auction === undefined) continue;
		if (!hasExpired(auction.closesAt, now)) continue;
		due.push(auction);
	}
	return due.sort(byCloseThenPlayer);
}

/**
 * The sort key for an Auction's close: its instant, or negative infinity when
 * the stored value cannot be read. `hasExpired` already treats an unreadable
 * `closesAt` as expired, so the earliest position is the reading that agrees
 * with it.
 */
function closeOrderOf(closesAt: string | null): number {
	// A leaderless Auction has no clock and `hasExpired` never calls it
	// overdue, so it cannot reach this comparator through `overdueAuctions`.
	// It is ordered LAST rather than first all the same: "no clock" is the
	// opposite of "already past due", and the unreadable case above is the
	// one this function reads as earliest.
	if (closesAt === null) return Number.POSITIVE_INFINITY;
	return parseInstant(closesAt) ?? Number.NEGATIVE_INFINITY;
}

/** AD-11's order, total: close instant ascending, then `fantraxPlayerId`. */
function byCloseThenPlayer(left: Auction, right: Auction): number {
	const leftClose = closeOrderOf(left.closesAt);
	const rightClose = closeOrderOf(right.closesAt);
	if (leftClose !== rightClose) return leftClose < rightClose ? -1 : 1;
	if (left.fantraxPlayerId === right.fantraxPlayerId) return 0;
	// Plain code-unit comparison, never `localeCompare`: `Intl` is forbidden in
	// the core precisely because its collation differs across runtimes, and
	// AD-2 needs Node and Deno to agree on this order exactly.
	return left.fantraxPlayerId < right.fantraxPlayerId ? -1 : 1;
}
