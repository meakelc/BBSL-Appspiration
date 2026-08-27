/**
 * The bidding gate: the two entry points AD-1 fixes, the four gates this
 * story owns, and the one sentence each refusal has. Pure (Story 2.5).
 *
 * **Two entry points and no others.**
 *
 *   - `evaluate(state, command, now)` returns the outcome of EVERY gate in
 *     `PLACE_BID_GATES`, each carrying `passed` and its own arithmetic. It is
 *     total: it never throws and never refuses to answer, in any state, for
 *     any amount.
 *   - `decide(state, command, now, seed)` obtains every gate outcome by
 *     CALLING `evaluate()` — never by re-deriving one — and answers
 *     `Accepted<EventEnvelope[]>` or `Rejected<PlaceBidGateResults>`.
 *
 * The read path calls the same `evaluate()` (`server/auction-page.ts`), so a
 * disabled control and the refusal that explains it cannot disagree. One
 * evaluator, two consumers: two functions that must merely agree would be
 * free to drift; one that the other calls cannot.
 *
 * **This is deliberately NOT shaped like `rules/nomination.ts`.**
 * `refuseNomination` returns the first refusal and stops, which is right for
 * a nomination and is exactly what AD-1 forbids here: `EXPERIENCE.md` reports
 * the passing gate beside the failing one, so short-circuiting would put a
 * fragment of the passed gate's arithmetic outside `core/`. What IS reused is
 * that module's WORDING discipline — one sentence per refusal, defined here,
 * and no route ever words its own.
 *
 * **Increment and granularity are two separately written gates**, even though
 * they coincide in Standard Contention: with a $500,000 grid the next legal
 * value above a $8,000,000 high is $8,500,000, which is exactly one
 * increment, so no on-grid sub-increment bid exists there (PRD §10 example 2
 * says so outright). Granularity earns its keep where the increment rule does
 * not apply — §10 example 26's `$1,000,001` in a Minimum-Bid Contention.
 *
 * **The gate set this story owns is four, and its growth is designed for.**
 * Story 2.6 adds `cap`, 2.7 adds `slots`, 3.1 adds `expiry`. None of them is
 * here, and neither is any of the arithmetic behind them: this module cannot
 * see a Team's cap figures, cannot see its roster occupancy, and does not
 * compare `now` to a close instant. A gate this story does not own is not
 * stubbed, not half-written and not named — adding one is a single edit to
 * `PLACE_BID_GATES` in `core/types.ts` when the story that owns it arrives.
 *
 * **No Minimum-Bid Contention is ever produced.** An Opening Bid of exactly
 * `MINIMUM_BID` is refused by the named `opening` gate, because the Contender
 * list, seed table, fixed clock and draw that make a lottery work are Stories
 * 3.2/3.3. The `minimum_bid` state literal exists in
 * `projection/auctions.ts` so a lottery can be FOLDED and reasoned about —
 * never so one can be created here.
 *
 * `seed` is declared on `decide()` and never read. AD-1 and the epic AC fix
 * that signature, and Story 3.6's draw is its first consumer — the same
 * ship-it-declared-and-unused discipline `releaseNomination` already follows.
 * Declaring it now means the draw does not change a signature every caller
 * in two runtimes already depends on.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2). It reads
 * no clock: `now` is an argument, and the only thing done with it is instant
 * arithmetic through `core/instant.ts`.
 */

import { AUCTION_CLOCK, MINIMUM_BID, MINIMUM_INCREMENT } from '../constants.ts';
import type { Auction } from '../projection/auctions.ts';
import { BID_PLACED_EVENT, closeInstantFor } from '../projection/auctions.ts';
import type { Money } from '../money.ts';
import { addMoney, compareMoney, formatMoney, isOnMoneyGrid, parseMoney } from '../money.ts';
import { PLACE_BID_GATES } from '../types.ts';
import type {
	Accepted,
	Decided,
	EventEnvelope,
	GranularityGateOutcome,
	IncrementGateOutcome,
	OpeningGateOutcome,
	PlaceBid,
	PlaceBidGate,
	PlaceBidGateResults,
	Rejected,
	SelfBidGateOutcome
} from '../types.ts';

/** `MINIMUM_BID` as `Money`. Branded once, here, never at a call site (AD-8). */
const MINIMUM_OPENING_BID: Money = parseMoney(MINIMUM_BID);

/** `MINIMUM_INCREMENT` as `Money` — the raise step AND the money grid. */
const INCREMENT: Money = parseMoney(MINIMUM_INCREMENT);

/**
 * The leading Bid, as every gate in `PLACE_BID_GATES` needs it: who holds it
 * and for how much, and nothing else.
 *
 * Narrower than `projection/auctions.ts`'s `Bid` on purpose. A gate that
 * cannot see a Bid's `seq`, its instant or its close time cannot come to
 * depend on one, which keeps expiry-as-authority (Story 3.1) genuinely
 * outside this module rather than merely unwritten.
 */
export type LeadingBid = {
	readonly teamId: string;
	readonly amount: Money;
};

/**
 * Everything the bidding gates decide from — and it really is everything.
 *
 * One field, and it is the smallest shape that answers all four gates: the
 * leading Bid, or `null` when the Player is nominated and nobody has bid.
 * Whether an Auction is OPEN at all is not asked here — that is the
 * nomination fold, and `server/bidding.ts` answers it under the lock before
 * `decide()` is ever called.
 *
 * **Minimal because two callers must be able to build it.** The transaction
 * builds it from the fold under the lock; the SURFACE builds it from what the
 * read path serialised, so a control can be disabled against the amount
 * actually typed (AD-9: client-side validation exists to disable controls and
 * pre-fill amounts, and never to be the check). A state carrying a whole
 * `Auction` would have made the second caller reconstruct a Bid's `seq`,
 * instant and close time in order to ask a question that reads none of them.
 * `bidStateFor` is the bridge from the fold; the two fields below are the
 * bridge from the wire.
 *
 * Deliberately carries no cap figure and no roster figure. A gate that cannot
 * see a Team's budget cannot refuse on it, which is what makes "the money
 * gate is Story 2.6's" a structural fact rather than a promise — and it is
 * the same argument `NominationState` makes for the nomination gate.
 */
export type BidState = {
	readonly leadingBid: LeadingBid | null;
};

/**
 * The `BidState` for an Auction as `projection/auctions.ts` folded it.
 *
 * The one narrowing from the fold to the gates, so the transaction and the
 * read path cannot narrow it two different ways. `null` — nominated, nobody
 * has bid — is a state, not a failure.
 */
export function bidStateFor(auction: Auction | null): BidState {
	if (auction === null) return { leadingBid: null };
	return { leadingBid: { teamId: auction.leadingBid.teamId, amount: auction.leadingBid.amount } };
}

/**
 * The least a RAISE may be: the current high plus one Minimum Increment.
 *
 * The single definition of that arithmetic. `evaluateIncrement` reports it as
 * the gate's `minimumLegal` and `minimumLegalBid` pre-fills the control with
 * it, both by calling this — so the figure a Manager is handed and the figure
 * they are refused against are the same expression, not two that happen to
 * agree today. An earlier revision computed the sum independently in each
 * place while claiming in prose that it did not; a claim like that has to be
 * structural or it is not a claim.
 */
function minimumRaise(leading: LeadingBid): Money {
	return addMoney(leading.amount, INCREMENT);
}

/**
 * The smallest amount that would pass every gate this story owns, given the
 * Auction's current state.
 *
 * The read path pre-fills the bid control with it (AD-9: client-side
 * validation exists only to disable controls and pre-fill amounts, never to
 * be the check).
 *
 * With a leading Bid it is `minimumRaise`, which is the increment gate's own
 * `minimumLegal` — the identical call, so the two can never differ by a grid
 * step.
 *
 * **With no leading Bid there is no gate counterpart, and the figure is this
 * function's own.** `evaluateIncrement` reports `minimumLegal: null` for an
 * opening, because the increment rule genuinely does not apply to one and
 * stating a minimum raise over a high that does not exist would be inventing
 * arithmetic. The opening minimum is instead derived from the two gates that
 * DO apply: the `opening` gate refuses anything at or below `MINIMUM_BID`
 * (exactly `MINIMUM_BID` opens a lottery this story cannot create), and
 * `granularity` refuses anything off the `MINIMUM_INCREMENT` grid. The
 * smallest value satisfying both is `MINIMUM_BID + MINIMUM_INCREMENT` —
 * $1,500,000. `tests/core/bidding.test.ts` asserts the derivation rather than
 * the constant, by checking that every state's pre-fill passes every gate.
 */
export function minimumLegalBid(state: BidState): Money {
	const leading = state.leadingBid;
	if (leading === null) return addMoney(MINIMUM_OPENING_BID, INCREMENT);
	return minimumRaise(leading);
}

/**
 * What a submitted amount turned out to be.
 *
 * A union rather than `Money | null`, because the two ways an amount can be
 * unusable need different sentences and only the parse knows which one
 * happened. Returning `null` forced the caller either to re-parse or to word
 * both cases as one, and "the amount is not a whole number of dollars" is
 * simply false about `-500000`, which is a whole number of dollars.
 */
export type BidAmountReading =
	| { readonly kind: 'usable'; readonly amount: Money }
	| { readonly kind: 'unusable'; readonly refusal: BidRefusal };

/**
 * Read an amount arriving from a form field.
 *
 * The boundary parser for the bid control, living in the core so that
 * "empty, non-numeric, negative, or carrying a decimal" has ONE definition
 * and neither the route nor the surface grows a second one (the I/O matrix's
 * "Unusable amount" row).
 *
 * `parseMoney` is the parser; this wraps it. An unusable amount is not a rule
 * violation and not a bug either — it is a person who typed `8.5` or nothing
 * at all — so it comes back as a refusal this module already words, rather
 * than as the `TypeError` `parseMoney` raises for genuine corruption at a
 * database boundary (AD-1: a throw signals a bug and nothing else). Catching
 * that throw here is what keeps the distinction, and it is the only `try` in
 * this module.
 *
 * **The sign is its own refusal.** `parseMoney` accepts `-500000` —
 * legitimately, because Available Cap Space is legitimately negative — but a
 * negative BID is not an amount anybody meant. It is refused here rather than
 * left to the opening gate, because the matrix requires it refused before any
 * transaction opens, and it is refused with its own sentence, because the
 * remedy differs: a decimal point is a typing slip, a minus sign is a
 * misunderstanding of what the field is for.
 */
export function readBidAmount(text: string): BidAmountReading {
	const trimmed = text.trim();
	if (trimmed === '') return { kind: 'unusable', refusal: { kind: 'unusable_amount' } };
	let amount: Money;
	try {
		amount = parseMoney(trimmed);
	} catch {
		return { kind: 'unusable', refusal: { kind: 'unusable_amount' } };
	}
	if (amount < 0) return { kind: 'unusable', refusal: { kind: 'negative_amount' } };
	return { kind: 'usable', amount };
}

// --- The gates -------------------------------------------------------------

/**
 * The Opening Bid gate.
 *
 * Three questions in one, discriminated by `opening` so the wording and the
 * tests read a field rather than re-deriving a comparison:
 *
 *  - a Bid already leads → `not_an_opening`, passes. The increment gate owns
 *    the raise, and an opening rule applied to a raise would double-refuse.
 *  - above `MINIMUM_BID` → `above_the_minimum`, passes: Standard Contention.
 *  - exactly `MINIMUM_BID` → `at_the_minimum`, REFUSED. This is the amount
 *    that opens a Minimum-Bid Contention, and no Contender list, seed table,
 *    fixed clock or draw exists to run one (Stories 3.2/3.3). Refusing by
 *    name is the honest answer; silently promoting it to $1,500,000 or
 *    quietly accepting it into a lottery that cannot be drawn are both worse.
 *  - below `MINIMUM_BID` → `below_the_minimum`, refused: PRD §3, "Opening
 *    Bid — Minimum $1,000,000".
 */
function evaluateOpening(state: BidState, amount: Money): OpeningGateOutcome {
	const base = { offered: amount, minimumOpening: MINIMUM_OPENING_BID };
	if (state.leadingBid !== null) {
		return { ...base, passed: true, opening: 'not_an_opening' };
	}
	const order = compareMoney(amount, MINIMUM_OPENING_BID);
	if (order > 0) return { ...base, passed: true, opening: 'above_the_minimum' };
	if (order === 0) return { ...base, passed: false, opening: 'at_the_minimum' };
	return { ...base, passed: false, opening: 'below_the_minimum' };
}

/**
 * The self-bid gate: a Team cannot bid against itself.
 *
 * Matched on the Team, never on the Manager — a co-managed Team is one
 * bidder, so the second Manager raising their own Team's leading Bid is the
 * same refusal as the first Manager doing it. Passes with no leading Bid,
 * which is what makes an opening need no special case here.
 */
function evaluateSelfBid(state: BidState, actingTeamId: string): SelfBidGateOutcome {
	const leadingTeamId = state.leadingBid?.teamId ?? null;
	return {
		passed: leadingTeamId === null || leadingTeamId !== actingTeamId,
		actingTeamId,
		leadingTeamId
	};
}

/**
 * The Minimum Increment gate: at least `current high + MINIMUM_INCREMENT`.
 *
 * With no leading Bid the rule does not apply and both figures are `null`:
 * there is no current high to exceed, and stating a minimum legal raise over
 * a high that does not exist would be inventing arithmetic a refusal panel
 * would then print. The opening gate owns that case.
 *
 * "At least" — a Bid exactly one increment above the high is legal; a Bid AT
 * the high or below it is not, which is the same comparison and needs no
 * second gate (PRD §10, "at or below the current high" is refused here).
 */
function evaluateIncrement(state: BidState, amount: Money): IncrementGateOutcome {
	const leading = state.leadingBid;
	if (leading === null) {
		return { passed: true, offered: amount, currentHigh: null, minimumLegal: null };
	}
	// The SAME expression `minimumLegalBid` pre-fills the control with.
	const minimumLegal = minimumRaise(leading);
	return {
		passed: compareMoney(amount, minimumLegal) >= 0,
		offered: amount,
		currentHigh: leading.amount,
		minimumLegal
	};
}

/**
 * The granularity gate: a whole multiple of `MINIMUM_INCREMENT`.
 *
 * Independent of contention state, by construction — it reads the amount and
 * nothing else, so it cannot be made to depend on whether a lottery is
 * running (AC3, and PRD §10 example 26's "the granularity check runs
 * independently of contention state"). `isOnMoneyGrid` is `money.ts`'s own
 * predicate, called rather than repeated: it is exactly the predicate
 * `formatMoney` throws on, so a gate that passed and a rendering that threw
 * could never disagree.
 */
function evaluateGranularity(amount: Money): GranularityGateOutcome {
	return { passed: isOnMoneyGrid(amount), offered: amount, grid: INCREMENT };
}

/**
 * Every gate for a `PlaceBid`, always all of them, whatever the state.
 *
 * Total. It never throws, never short-circuits, and returns exactly the keys
 * `PLACE_BID_GATES` names — so an accepted result and a refused one carry an
 * identical gate set and no caller is ever handed a partial record it has to
 * guess at (AD-1).
 *
 * `now` is declared because AD-1 and the epic AC fix the signature at
 * `evaluate(state, command, now)` and because Story 3.1's `expiry` gate is
 * the consumer that will need it: expiry-as-authority compares the injected
 * `now` against the persisted absolute close instant (AD-12), and none of
 * the four gates below asks what time it is. Nothing here reads a clock; if
 * this parameter were dropped now, 3.1 would have to change a signature both
 * runtimes and the read path already depend on.
 */
export function evaluate(state: BidState, command: PlaceBid, now: string): PlaceBidGateResults {
	void now;
	return {
		opening: evaluateOpening(state, command.amount),
		selfBid: evaluateSelfBid(state, command.teamId),
		increment: evaluateIncrement(state, command.amount),
		granularity: evaluateGranularity(command.amount)
	};
}

/**
 * Whether every gate in `PLACE_BID_GATES` passed.
 *
 * Iterated over `PLACE_BID_GATES` rather than over `Object.values(gates)`,
 * for AD-1's "iteration over any collection that can affect an outcome must
 * be over an explicitly sorted sequence": the declared list is the sequence,
 * fixed and ordered at the one place the gate set lives, whereas key order on
 * an object literal is an incidental property of how it was constructed.
 */
export function allGatesPassed(gates: PlaceBidGateResults): boolean {
	for (const gate of PLACE_BID_GATES) {
		if (!gates[gate].passed) return false;
	}
	return true;
}

/**
 * Every gate that failed, in `PLACE_BID_GATES` order.
 *
 * Exported so a caller can report the refusing gates without re-deriving
 * which they were, and ordered by the declared list for `allGatesPassed`'s
 * reason.
 */
export function failedGates(gates: PlaceBidGateResults): readonly PlaceBidGate[] {
	return PLACE_BID_GATES.filter((gate) => !gates[gate].passed);
}

// --- The wording -----------------------------------------------------------

/**
 * Why a Bid was refused.
 *
 * `gates` is the ordinary case: the pure gate set, refused by one or more of
 * the four. The other four are decided OUTSIDE the gate set, exactly as
 * `NominationRefusal`'s `unconfirmed`/`unbound_actor`/`unrecorded` are, and
 * for the same reasons:
 *
 *  - `unusable_amount` — an empty, non-numeric or decimal-carrying field has
 *    no amount for a gate to decide about, so no transaction opens.
 *  - `negative_amount` — the field held a whole number of dollars, but a
 *    negative one. Its own case rather than a second reading of the one
 *    above, because "that is not a whole number of dollars" is false about
 *    `-500000` and the remedy differs: a decimal point is a typing slip, a
 *    minus sign is a misunderstanding of what the field is for.
 *  - `unconfirmed` — bidding is a deliberate two-part act; an unconfirmed
 *    submit establishes only that this request did not mean to bid.
 *  - `unbound_actor` — `auction_events.manager_id`/`team_id` are NOT NULL
 *    (AD-4), so an unbound actor has no event to append.
 *  - `no_open_auction` — the Player's Auction closed, or never existed,
 *    between the render and the submit. Re-derived under the lock by
 *    `server/bidding.ts`, never by a gate: whether an Auction is OPEN is the
 *    nomination fold's answer, and `PLACE_BID_GATES` is fixed at four.
 *  - `unrecorded` — the defensive case for a rejection that arrived stating
 *    no reason.
 *
 * All of them are worded here anyway, so no route ever words a refusal
 * itself.
 */
export type BidRefusal =
	| { readonly kind: 'gates'; readonly gates: PlaceBidGateResults }
	| { readonly kind: 'unusable_amount' }
	| { readonly kind: 'negative_amount' }
	| { readonly kind: 'unconfirmed' }
	| { readonly kind: 'unbound_actor' }
	| { readonly kind: 'no_open_auction' }
	| { readonly kind: 'unrecorded' };

/**
 * The one sentence for a single failed gate, with that gate's own arithmetic
 * spelled out.
 *
 * Product voice, `rules/nomination.ts`'s: state the fact, show the figures it
 * was decided from, then say what would change it. No apology, no exclamation
 * mark, no advice. Every amount renders through `formatMoney` and nothing
 * else (AD-8) — which is lossless here because every figure quoted is either
 * on the grid already or is the offered amount, and the offered amount is
 * checked before it is rendered.
 *
 * `null` for a gate that passed: this function words refusals, and a passed
 * gate has none.
 */
function gateSentence(gates: PlaceBidGateResults, gate: PlaceBidGate): string | null {
	switch (gate) {
		case 'opening': {
			const outcome = gates.opening;
			if (outcome.passed) return null;
			if (outcome.opening === 'at_the_minimum') {
				return (
					`An Opening Bid of exactly ${formatMoney(outcome.minimumOpening)} would open a ` +
					'Minimum-Bid Contention, and this auction does not run one yet. Open above ' +
					`${formatMoney(outcome.minimumOpening)} instead.`
				);
			}
			return (
				`An Opening Bid is at least ${formatMoney(outcome.minimumOpening)}. ` +
				`You offered ${describeAmount(outcome.offered)}.`
			);
		}
		case 'selfBid': {
			const outcome = gates.selfBid;
			if (outcome.passed) return null;
			return (
				'Your Team already holds the leading Bid on this Auction, and a Team does not bid ' +
				'against itself. You may bid again once another Team leads.'
			);
		}
		case 'increment': {
			const outcome = gates.increment;
			if (outcome.passed || outcome.minimumLegal === null || outcome.currentHigh === null) {
				return null;
			}
			return (
				`A Bid is at least the current high plus ${formatMoney(INCREMENT)}. The high is ` +
				`${formatMoney(outcome.currentHigh)}, so the least you may offer is ` +
				`${formatMoney(outcome.minimumLegal)}. You offered ${describeAmount(outcome.offered)}.`
			);
		}
		case 'granularity': {
			const outcome = gates.granularity;
			if (outcome.passed) return null;
			return (
				`Every amount in this league is a whole multiple of ${formatMoney(outcome.grid)}, and ` +
				'yours is not. This check runs in every contention state, so an off-grid amount is ' +
				'refused whether or not it clears the increment.'
			);
		}
	}
}

/**
 * An amount, described for a refusal sentence or a rendered figure.
 *
 * Exported because the read path renders the same figures the refusals do —
 * the current price, the minimum legal Bid, a history line's amount — and a
 * second "render money unless it is off the grid" helper in
 * `server/auction-page.ts` is exactly the drift AD-8 forbids.
 *
 * `formatMoney` is the ONE money renderer (AD-8) and it throws on an off-grid
 * amount by design — the abbreviated `$14.5M` rendering is lossless only on
 * the $500,000 grid. The offered amount is precisely the value that may be
 * off it, so `money.ts`'s own `isOnMoneyGrid` is asked first, exactly as
 * `formatMoney`'s own header says a caller should.
 *
 * An off-grid amount is DESCRIBED rather than rendered — no second money
 * renderer is invented here to print it, because a second renderer is what
 * AD-8 exists to forbid, and the granularity sentence beside this one already
 * states what is wrong with it. The machine-readable figure is still on the
 * gate outcome for any caller that needs it; only the prose declines to
 * spell a number the product has no lossless spelling for.
 */
export function describeAmount(amount: Money): string {
	if (isOnMoneyGrid(amount)) return formatMoney(amount);
	return 'an amount that is not on the grid';
}

/**
 * The one refusal sentence for each case.
 *
 * `rules/nomination.ts`'s `nominationRefusalDetail`, applied to bidding: the
 * route, the transaction, the disabled control and the tests all read ONE
 * wording per refusal, and no surface re-words a rule to work around not
 * being able to import a server module.
 *
 * The `gates` case is the one that differs in shape, and deliberately: AD-1
 * forbids short-circuiting, so a Bid refused on BOTH increment and
 * granularity (PRD §10 example 2) states both grounds, in
 * `PLACE_BID_GATES` order, one sentence each. Reporting only the first would
 * put a fragment of the second gate's arithmetic outside the core.
 *
 * Every sentence ends by saying nothing was written, because that is the
 * whole point of a refusal at this gate: nothing is committed, the Leading
 * Bidder is unchanged, the Auction Clock did not move and the League Clock
 * did not reset.
 */
export function bidRefusalDetail(refusal: BidRefusal): string {
	const closing = 'Nothing was written.';
	switch (refusal.kind) {
		case 'gates': {
			const sentences: string[] = [];
			for (const gate of PLACE_BID_GATES) {
				const sentence = gateSentence(refusal.gates, gate);
				if (sentence !== null) sentences.push(sentence);
			}
			if (sentences.length === 0) {
				// Unreachable through `decide()`, which only builds this refusal
				// when a gate failed — but a caller may hand this function any
				// gate set, and "no Bid was placed and every gate passed" is not
				// a sentence anybody should ever be shown as though it were true.
				return `No Bid was placed: the write was refused and stated no reason. ${closing}`;
			}
			return `No Bid was placed. ${sentences.join(' ')} ${closing}`;
		}
		case 'unusable_amount':
			return (
				'No Bid was placed: the amount is not a whole number of dollars. Enter it in whole ' +
				'dollars, with no decimal point, no comma and no currency symbol. ' +
				closing
			);
		case 'negative_amount':
			return (
				'No Bid was placed: the amount is negative, and a Bid is what you are offering to ' +
				`pay. Enter it as a positive whole number of dollars. ${closing}`
			);
		case 'unconfirmed':
			return (
				'No Bid was placed: the confirmation was not given. A Bid commits your Team to the ' +
				'amount for as long as it leads, so it is never inferred from a submit. Tick the ' +
				`confirmation and submit again. ${closing}`
			);
		case 'unbound_actor':
			return (
				'No Bid was placed: you are not bound to a Team, and every event must name one. ' +
				`Ask the Commissioner to bind your Team. ${closing}`
			);
		case 'no_open_auction':
			return (
				'No Bid was placed: there is no open Auction for this Player. The Auction was ' +
				'folded from the event log inside this transaction, so reload the page to see the ' +
				`board as it stands now. ${closing}`
			);
		case 'unrecorded':
			return `No Bid was placed: the write was refused and stated no reason. ${closing}`;
	}
}

// --- The consequence -------------------------------------------------------

/**
 * The one statement of what confirming a Bid does. Every sentence the surface
 * prints beside the confirm is built from this string, so the consequence has
 * exactly one wording.
 *
 * It states what this story actually commits and nothing more: the amount
 * stands as the Leading Bid, the Auction Clock restarts at 24 hours from the
 * Bid, and the League Clock resets. It says nothing about cap space, because
 * `BidState` cannot see any — Story 2.6 owns that sentence along with the
 * arithmetic behind it, and claiming a commitment this core cannot compute
 * would be the invented figure the refusal design exists to prevent.
 */
export const BID_CONSEQUENCE =
	'your Team becomes the Leading Bidder at that amount, the Auction Clock restarts at 24 ' +
	'hours from your Bid, and the League Clock resets — and a Bid cannot be cancelled, ' +
	'amended or lowered once it is placed';

/**
 * `BID_CONSEQUENCE` as a finished sentence about a named amount, for the
 * surface to print beside the confirm.
 *
 * Rendered here rather than in `+page.svelte` for the reason Story 1.9
 * settled: the server renders, the surface prints. Amount-free when no usable
 * amount has been entered, rather than printing a placeholder figure.
 */
export function bidConsequenceSentence(amount: Money | null): string {
	const subject =
		amount === null || !isOnMoneyGrid(amount) ? 'A Bid' : `Bidding ${formatMoney(amount)}`;
	return `${subject} cannot be undone: ${BID_CONSEQUENCE}.`;
}

// --- What the control says, and what a placed Bid did ---------------------

/**
 * The minimum legal Bid as a finished sentence, or `null` when there is no
 * honest way to state the figure.
 *
 * `null` is reachable only through a log this story cannot write: if a
 * historical `BidPlaced` ever carried an off-grid amount, the minimum raise
 * over it is off-grid too, and `formatMoney` has no lossless rendering for
 * one (AD-8). The fold deliberately does NOT correct such an event — under
 * AD-20 it was produced under its own `coreVersion` and today's granularity
 * rule is not retroactive — so the correction belongs at the RENDER, and it
 * is this: the surface omits the line rather than printing a sentence whose
 * figure is a phrase.
 */
export function minimumLegalSentence(amount: Money): string | null {
	if (!isOnMoneyGrid(amount)) return null;
	return `Whole dollars. The least this Auction will take is ${formatMoney(amount)}.`;
}

/**
 * What the bid control should say, and whether it should act.
 *
 * **One function, two callers, and that is the whole point.** The read path
 * calls it with the pre-filled amount to decide what a Manager sees on the
 * board before typing anything; the SURFACE calls it again on every
 * keystroke, with the amount actually typed, to decide what the control says
 * then. Both reach their answer through `evaluate()` — the same `evaluate()`
 * `decide()` calls inside the locked transaction — so a control that says a
 * Bid is impossible, the sentence under it, and the server's refusal cannot
 * disagree (AD-1's "one evaluator, two consumers"; AD-9's "client-side
 * validation exists only to disable controls and pre-fill amounts").
 *
 * Before this existed the surface disabled only on a whole-number shape
 * check, so a Manager could type `8400000` against an `$8.0M` high, see an
 * enabled control and a sentence saying they were ready, and learn otherwise
 * only from the server. That is the "discovered at submission" failure the
 * refusal design exists to prevent.
 *
 * **`detail` is never `null`.** A control states its reason when it is
 * blocked and states its readiness when it is not, and both are sentences —
 * so the surface prints this field unconditionally and words nothing itself.
 *
 * The order of the reasons is the order of the honest answer: being unbound
 * from a Team is a standing condition no amount will change; then whether
 * there is an amount at all; then what the rules make of it; then the
 * confirmation, which is the last thing left to do. `confirmed` is a
 * surface fact rather than a rule, exactly as it is for a nomination — it
 * establishes only that this submit meant to bid — but its sentence is the
 * core's like every other.
 */
export type BidControlState = {
	/** Whether the control must refuse to act. */
	readonly blocked: boolean;
	/** The reason it is blocked, or the statement that it is ready. Never empty. */
	readonly detail: string;
	/** Which gates refused this amount, in `PLACE_BID_GATES` order. Empty if none ran. */
	readonly refusingGates: readonly PlaceBidGate[];
};

/** What a ready control says. Stated here so no surface writes its own. */
export const BID_READY =
	'The amount is entered and the confirmation has been given. Every gate is re-derived from ' +
	'the event log when you submit.';

export function bidControlState(input: {
	readonly state: BidState;
	readonly fantraxPlayerId: string;
	/** The viewer's own Team, from the session and nothing else (AD-4). */
	readonly viewerTeamId: string | null;
	/** The field's raw text, exactly as it stands. */
	readonly amountText: string;
	readonly confirmed: boolean;
	readonly now: string;
}): BidControlState {
	if (input.viewerTeamId === null) {
		// No Team for a command to name, so no gate can run: an unbound actor
		// has no event to append (AD-4).
		return {
			blocked: true,
			detail: bidRefusalDetail({ kind: 'unbound_actor' }),
			refusingGates: []
		};
	}

	const reading = readBidAmount(input.amountText);
	if (reading.kind === 'unusable') {
		return { blocked: true, detail: bidRefusalDetail(reading.refusal), refusingGates: [] };
	}

	const gates = evaluate(
		input.state,
		{
			kind: 'PlaceBid',
			fantraxPlayerId: input.fantraxPlayerId,
			teamId: input.viewerTeamId,
			// Neither is read by any gate — both are on the command for the
			// event's sake — so a render passes placeholders rather than
			// resolving names for a command it will never append.
			teamName: '',
			managerId: '',
			amount: reading.amount
		},
		input.now
	);

	const refusingGates = failedGates(gates);
	if (refusingGates.length > 0) {
		return { blocked: true, detail: bidRefusalDetail({ kind: 'gates', gates }), refusingGates };
	}

	if (!input.confirmed) {
		return { blocked: true, detail: bidRefusalDetail({ kind: 'unconfirmed' }), refusingGates: [] };
	}

	return { blocked: false, detail: BID_READY, refusingGates: [] };
}

/**
 * The notice a Manager reads when their Bid landed.
 *
 * Composed FROM `BID_CONSEQUENCE` rather than restated, the way
 * `nominate/+page.server.ts` composes its own notice from
 * `nominationConsequenceSentence`: the confirm and the outcome describe the
 * same commitment, so they must be the same words. A route that wrote this
 * sentence itself would be a second definition of what a Bid does.
 */
export function bidPlacedNotice(): string {
	return `The Bid is placed: ${BID_CONSEQUENCE}.`;
}

/**
 * What was appended, as a finished sentence naming the log position.
 *
 * The event TYPE comes from `BID_PLACED_EVENT` rather than from a literal, so
 * a surface can never name an event type the log does not carry. `seq` is a
 * shell fact and arrives as an argument — nothing here reads a database.
 */
export function bidAppendedSentence(seq: string): string {
	return (
		`One ${BID_PLACED_EVENT} event was appended, at sequence ${seq}, naming you, your Team ` +
		'and the amount. The price, the Leading Bidder, the Auction Clock and the League Clock ' +
		'are folds of that event; no flag was set anywhere.'
	);
}

// --- decide() --------------------------------------------------------------

/**
 * The `BidPlaced` payload: who bid how much on whom, and when it closes.
 *
 * The acting Manager id, Team id, timestamp, `schemaVersion`, `coreVersion`
 * and `deviceClass` are columns `runTransactionalWrite` fills from the
 * envelope, the database clock and the pinned constants — never restated
 * here. `teamId` and `managerId` ARE restated, because `auctionsReducer`
 * folds the PAYLOAD and must not have to reach for an envelope column to know
 * who leads and who acted.
 *
 * `closesAt` is the reason this payload exists in this shape. AD-3 requires
 * an absolute close timestamp persisted server-side and rendered as a
 * countdown by the client, never "seconds remaining"; AD-12 requires
 * validation to compare `now` against a *persisted* close instant rather than
 * a projection's open flag. A projection table is the wrong home for it —
 * AD-5 makes projections disposable and rebuildable — so it rides the payload
 * into the insert-only log, where it is both durable and foldable.
 *
 * Declared here rather than in `server/bidding.ts` because `decide()` is what
 * builds it and `auctionsReducer` is what reads it, and both are in the core.
 */
export type BidPlacedPayload = {
	readonly fantraxPlayerId: string;
	readonly teamId: string;
	readonly teamName: string;
	readonly managerId: string;
	readonly amount: number;
	readonly closesAt: string;
};

/**
 * Authorise a `PlaceBid`, or refuse it with the full gate set.
 *
 * **Every gate outcome comes from `evaluate()`**, called once, here. Nothing
 * below re-derives a comparison the evaluator already made — that is AD-1's
 * "one evaluator, two consumers" holding structurally rather than by
 * convention.
 *
 * On acceptance it emits exactly ONE `BidPlaced` envelope. Its `occurredAt`
 * is not set here: `runTransactionalWrite` stamps every appended event with
 * the database's transaction-start clock (AD-3), and `now` — the same instant,
 * handed in as a string — is what the close instant is computed from, so the
 * event's timestamp and its `closesAt` are exactly `AUCTION_CLOCK` apart by
 * construction.
 *
 * `seed` is declared and never read (see the module header). A `PlaceBid` has
 * no randomness in it; Story 3.6's draw is the first command that does.
 *
 * A malformed `now` THROWS rather than returning a refusal, and that is the
 * AD-1 distinction rather than an oversight: a rule violation is a returned
 * value, and a transaction-start clock that is not an instant is a bug in the
 * shell, not something a Manager did. `evaluate()` above stays total
 * regardless — the read path can call it with any `now` and still get every
 * gate.
 */
export function decide(
	state: BidState,
	command: PlaceBid,
	now: string,
	seed: string | null
): Decided<readonly EventEnvelope[], PlaceBidGateResults> {
	void seed;

	const gates = evaluate(state, command, now);

	if (!allGatesPassed(gates)) {
		const rejected: Rejected<PlaceBidGateResults> = { kind: 'rejected', gates };
		return rejected;
	}

	const closesAt = closeInstantFor(now, AUCTION_CLOCK);
	if (closesAt === null) {
		throw new TypeError(
			`decide: "now" must be an ISO-8601 UTC instant, received ${JSON.stringify(now)}`
		);
	}

	const payload: BidPlacedPayload = {
		fantraxPlayerId: command.fantraxPlayerId,
		teamId: command.teamId,
		teamName: command.teamName,
		managerId: command.managerId,
		amount: command.amount,
		closesAt
	};

	const accepted: Accepted<readonly EventEnvelope[]> = {
		kind: 'accepted',
		events: [
			{
				type: BID_PLACED_EVENT,
				payload,
				managerId: command.managerId,
				teamId: command.teamId
			}
		]
	};
	return accepted;
}
