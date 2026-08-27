/**
 * The bidding gate: the two entry points AD-1 fixes, the five gates they
 * decide through, the one sentence each refusal has, and the arithmetic the
 * refusal panel prints. Pure (Stories 2.5, 2.6).
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
 * **The gate set grew by one, exactly as designed.** Story 2.5 owned four
 * and said 2.6 would add `cap`, 2.7 `slots` and 3.1 `expiry`. `cap` is here
 * now, and adding it was the single edit to `PLACE_BID_GATES` in
 * `core/types.ts` that the design promised. The other two are not: this
 * module still cannot see roster CAPACITY as a refusal ground and still does
 * not compare `now` to a close instant. A gate this story does not own is
 * not stubbed, not half-written and not named.
 *
 * **What `cap` may see, and what it still may not.** Story 2.6 gives this
 * module a Team's Cap Space, its Roster Count and the open Auctions it
 * leads, because Maximum Bid cannot be derived without them (AD-7). It does
 * NOT give it Free Minor League Slots, Eligible Leading Bids or Overflow
 * Count — Minors Exposure is named in the arithmetic and is structurally
 * zero until Story 2.8 supplies the set it sums over. Roster Count arrives
 * for Roster Reserve alone; refusing on `Roster Count + Projected
 * Active/Bench Additions > 12` is Story 2.7's separate gate, and this module
 * carries no such comparison. Reporting a capacity refusal as a cap refusal
 * is a defect (AD-7), so the two gates share their arithmetic and never
 * their outcome.
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

import {
	ACTIVE_BENCH_SLOTS,
	AUCTION_CLOCK,
	MINIMUM_BID,
	MINIMUM_INCREMENT
} from '../constants.ts';
import type { Auction, OpenAuctions } from '../projection/auctions.ts';
import { BID_PLACED_EVENT, auctionForPlayer, closeInstantFor } from '../projection/auctions.ts';
import type { Money } from '../money.ts';
import {
	addMoney,
	compareMoney,
	formatMoney,
	isOnMoneyGrid,
	multiplyMoney,
	parseMoney,
	subtractMoney
} from '../money.ts';
import { PLACE_BID_GATES } from '../types.ts';
import type {
	Accepted,
	CapGateOutcome,
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

/**
 * `MINIMUM_BID` as `Money`. Branded once, here, never at a call site (AD-8).
 *
 * **One branded value, two jobs**, exactly as `core/constants.ts:24` declares
 * it: the least an Opening Bid may be, AND the per-hole figure Roster Reserve
 * holds back. It is not aliased to a second name for the second job — the
 * league minimum salary and the Opening Bid minimum are one rule stated
 * twice, and two names would invite two values that could drift apart while
 * every test stayed green.
 */
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
 * Two fields, and together the smallest shape that answers all five gates:
 * the leading Bid — `null` when the Player is nominated and nobody has bid —
 * and the bidding Team's own money facts.
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
 * `team` is Story 2.6's addition and the only thing on this shape that is
 * not about the Auction itself. It is `null` for a viewer bound to no Team —
 * a real supported state on the read path, and unreachable inside
 * `server/bidding.ts`, which cannot assemble a command without a Team.
 *
 * Still deliberately absent: Free Minor League Slots, Eligible Leading Bids
 * and any roster CAPACITY comparison. A gate that cannot see them cannot
 * refuse on them, which is what keeps "the exposure arithmetic is 2.8's" and
 * "the capacity gate is 2.7's" structural facts rather than promises — the
 * same argument `NominationState` makes for the nomination gate.
 */
export type BidState = {
	readonly leadingBid: LeadingBid | null;
	readonly team: TeamMoneyState | null;
};

/**
 * One open Auction the bidding Team already leads, as the money gate needs
 * it: the Player it is on and the amount held against the Cap.
 *
 * **Only non-eligible Auctions appear here, and the filtering happens in
 * `teamMoneyStateFor` rather than in the gate.** FR-14 puts a leading amount
 * on a Minor League Eligible Player into Minors Exposure instead of straight
 * into Committed Bids, so an eligible lead is not a smaller contribution to
 * this list — it is not on this list at all. Story 2.8 adds the eligible set
 * as its own field beside this one.
 *
 * `fantraxPlayerId` is carried so a refusal can NAME the Auctions holding
 * the money (§10 ex 19's refusal names the specific earlier Auction), not
 * because any comparison reads it.
 */
export type LeadingBidElsewhere = {
	readonly fantraxPlayerId: string;
	readonly amount: Money;
};

/**
 * Everything the money gate decides from — the Team's side of the ledger.
 *
 * **Raw inputs, never a derived figure.** Cap Space, Roster Count and the
 * leading Auctions are facts; Committed Bids, Available Cap Space, Roster
 * Reserve and Maximum Bid are derived from them by `evaluateCap` on every
 * single evaluation and are stored on nothing. AD-7 forbids a derived money
 * figure being persisted on a Team row, memoised across transactions, or
 * cached client-side for validation — and the SURFACE is a client. Shipping
 * it `maximumBid` and letting it compare would make the transported number
 * the check; shipping it these three facts means the same derivation runs in
 * the browser, on the read path and inside the lock, and the only way for
 * them to disagree is for the state to have genuinely moved, which is
 * exactly the case a refusal reports.
 *
 * `capSpace` may legitimately be negative, and so may everything derived
 * from it — `subtractMoney` says so outright.
 */
export type TeamMoneyState = {
	readonly capSpace: Money;
	/** Active/Bench rows only. IR and Minor League are excluded (§10 ex 23). */
	readonly rosterCount: number;
	/** Sorted by `fantraxPlayerId`, because a sum's inputs are a sequence (AD-5). */
	readonly leading: readonly LeadingBidElsewhere[];
};

/**
 * The `BidState` for an Auction as `projection/auctions.ts` folded it,
 * plus the Team's money state.
 *
 * The one narrowing from the folds to the gates, so the transaction and the
 * read path cannot narrow them two different ways. A `null` Auction —
 * nominated, nobody has bid — is a state, not a failure, and so is a `null`
 * Team.
 */
export function bidStateFor(auction: Auction | null, team: TeamMoneyState | null): BidState {
	if (auction === null) return { leadingBid: null, team };
	return {
		leadingBid: { teamId: auction.leadingBid.teamId, amount: auction.leadingBid.amount },
		team
	};
}

/**
 * The Team's money state, narrowed from the same folds the Auction came from
 * plus the two figures only `team_rosters` can answer.
 *
 * **One narrowing, three callers**: the locked transaction, the read path and
 * — through what the read path serialises — the surface. A second narrowing
 * could disagree about which leads count, which is the disagreement AD-7's
 * "computed from committed state at validation time" exists to rule out.
 *
 * Three filters decide what lands in `leading`, and each is a rule:
 *
 *  - **the Auction being bid on is skipped.** The prospective Bid replaces
 *    any lead this Team holds there, so counting both would commit the Team
 *    twice for one Player — and Projected Active/Bench Additions counts the
 *    bid being placed exactly once (AD-7's post-bid basis).
 *  - **Auctions another Team leads are skipped**, which is what makes
 *    capital release the instant a Team is outbid: the lead moves in the
 *    fold and the amount simply stops appearing here. No sweep, no flag, no
 *    scheduled job (FR-14, §10 ex 5).
 *  - **Minor League Eligible Players are skipped** (FR-14). Their leading
 *    amounts reach Committed Bids only through Minors Exposure, which is
 *    Story 2.8's.
 *
 * A `minimum_bid` contention contributes `MINIMUM_OPENING_BID` — the branded
 * `MINIMUM_BID` — rather than the leading amount, because any Contender may win and they all hold the same
 * $1,000,000 (FR-14). Only the leader is visible in today's fold; Story 3.2
 * introduces the Contender list and must extend this one expression.
 *
 * Keys are iterated in sorted order (AD-5): a sum over an incidental key
 * order is a sum whose inputs are not a sequence.
 */
export function teamMoneyStateFor(input: {
	readonly teamId: string;
	/** The Auction being bid on — excluded from `leading`, per above. */
	readonly fantraxPlayerId: string;
	readonly capSpace: Money;
	readonly rosterCount: number;
	readonly auctions: OpenAuctions;
	readonly isMinorLeagueEligible: (fantraxPlayerId: string) => boolean;
}): TeamMoneyState {
	const leading: LeadingBidElsewhere[] = [];
	for (const playerId of Object.keys(input.auctions.byPlayer).sort()) {
		if (playerId === input.fantraxPlayerId) continue;
		const auction = auctionForPlayer(input.auctions, playerId);
		if (auction === null) continue;
		if (auction.leadingBid.teamId !== input.teamId) continue;
		if (input.isMinorLeagueEligible(playerId)) continue;
		leading.push({
			fantraxPlayerId: playerId,
			amount:
				auction.contention === 'minimum_bid' ? MINIMUM_OPENING_BID : auction.leadingBid.amount
		});
	}
	return { capSpace: input.capSpace, rosterCount: input.rosterCount, leading };
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

/** Zero, branded once. Minors Exposure is this until Story 2.8. */
const NO_MONEY: Money = parseMoney(0);

/**
 * The Active/Bench Slots a Team would still have to fill after this Bid —
 * the `max(0, 12 − (Roster Count + Projected Additions))` of Roster Reserve.
 *
 * One expression, two callers: `evaluateCap` multiplies it by the minimum
 * salary to get the reserve, and `capBreakdown` names it in the row that
 * shows the multiplication. Recomputing it in the renderer would be two
 * copies of a formula that must agree, which is the drift this module
 * refuses everywhere else.
 *
 * **The clamp is kept** although FR-37's ceiling makes it unreachable in
 * ordinary play, because a Commissioner override (Story 7.x) can still put a
 * Team above 12 — at which point an unclamped count would go negative and
 * hand that Team extra spending power as a reward for the override.
 */
function unfilledSlots(rosterCount: number, projectedAdditions: number): number {
	return Math.max(0, ACTIVE_BENCH_SLOTS - (rosterCount + projectedAdditions));
}

/**
 * The operator a subtracted breakdown row carries.
 *
 * The same U+2212 MINUS SIGN `formatMoney` prefixes a negative amount with,
 * so a column mixing the two does not mix a minus sign with a hyphen. It is
 * a constant rather than an inline literal for the reason every glyph in
 * this product is: one definition, or two renderings drift.
 */
const SUBTRACTED = '−';

/**
 * The money gate: a Bid may not exceed its Team's Maximum Bid (FR-12, FR-13).
 *
 * Every figure is derived here, on this call, from the facts on
 * `TeamMoneyState` — nothing is read from a cache, a column or the wire
 * (AD-7). The whole derivation is five lines because the narrowing did the
 * filtering; what those five lines must get right is the POST-BID basis:
 *
 *   Committed Bids       = Σ leading amounts (non-eligible) + Minors Exposure
 *   Available Cap Space  = Cap Space − Committed Bids
 *   Projected Additions  = leads elsewhere + 1, the bid being placed
 *   Roster Reserve       = $1M × max(0, 12 − (Roster Count + Projected))
 *   Maximum Bid          = Available Cap Space − Roster Reserve
 *
 * **The `+ 1` is the post-bid basis** and it is not optional: PRD FR-12 and
 * the §3 glossary both define Projected Active/Bench Additions as counting
 * the bid being placed, and AD-7 makes evaluating against the pre-bid state
 * the exact ambiguity that flips §10 example 19. §10 examples 3, 4, 5 and 23
 * are the executable statement of it.
 *
 * **`MINIMUM_BID` is the per-hole figure**, through the one
 * `MINIMUM_OPENING_BID` branding above: its declaration in
 * `core/constants.ts` already names both jobs, so there is no second
 * constant and nothing for a second constant to drift from.
 *
 * **The clamp is kept** although FR-37's ceiling makes it unreachable in
 * ordinary play, because a Commissioner override (Story 7.x) can still put a
 * Team above 12 — at which point an unclamped reserve would go NEGATIVE and
 * hand that Team extra spending power as a reward for the override.
 *
 * **"At or below" passes.** A Bid exactly equal to Maximum Bid is legal;
 * only one exceeding it is refused (FR-13, "any Bid exceeding").
 *
 * With no Team there is no arithmetic: every figure is `null` and the gate
 * passes, exactly as `evaluateIncrement` nulls its two figures on an opening
 * rather than inventing a high that does not exist. The refusal an unbound
 * Manager actually sees is `unbound_actor`.
 */
function evaluateCap(state: BidState, amount: Money): CapGateOutcome {
	const team = state.team;
	if (team === null) {
		return {
			passed: true,
			offered: amount,
			capSpace: null,
			committedBids: null,
			minorsExposure: null,
			availableCapSpace: null,
			rosterCount: null,
			projectedAdditions: null,
			rosterReserve: null,
			maximumBid: null
		};
	}

	// Story 2.8 replaces this constant with the sum of the Overflow Count
	// largest Eligible Leading Bids. It is a named term rather than an
	// omission because FR-13 requires the refusal to SHOW it, and a
	// breakdown missing a term would not sum.
	const minorsExposure: Money = NO_MONEY;

	let committedBids: Money = minorsExposure;
	for (const lead of team.leading) {
		committedBids = addMoney(committedBids, lead.amount);
	}

	const availableCapSpace = subtractMoney(team.capSpace, committedBids);
	const projectedAdditions = team.leading.length + 1;
	const rosterReserve = multiplyMoney(
		MINIMUM_OPENING_BID,
		unfilledSlots(team.rosterCount, projectedAdditions)
	);
	const maximumBid = subtractMoney(availableCapSpace, rosterReserve);

	return {
		passed: compareMoney(amount, maximumBid) <= 0,
		offered: amount,
		capSpace: team.capSpace,
		committedBids,
		minorsExposure,
		availableCapSpace,
		rosterCount: team.rosterCount,
		projectedAdditions,
		rosterReserve,
		maximumBid
	};
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
		granularity: evaluateGranularity(command.amount),
		cap: evaluateCap(state, command.amount)
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
		case 'cap': {
			const outcome = gates.cap;
			if (outcome.passed || outcome.maximumBid === null) return null;
			// EXPERIENCE.md's "the delta in one sentence" — the excess stated
			// as a figure rather than left for a Manager to subtract, because
			// the whole panel exists so nobody has to do arithmetic at 4am.
			// The subtraction is exact and lands on the grid: both operands do.
			const excess = subtractMoney(outcome.offered, outcome.maximumBid);
			return (
				`${describeAmount(outcome.offered)} exceeds your Maximum Bid of ` +
				`${describeAmount(outcome.maximumBid)} by ${describeAmount(excess)}.`
			);
		}
	}
}

/**
 * One line of a Maximum Bid breakdown: what it is called, what it is, and
 * what the column does with it.
 *
 * `kind` is the surface's whole instruction, so no component decides which
 * rows are arithmetic and which are commentary:
 *
 *  - `term` — subtracted from the running total when `operator` says so.
 *  - `detail` — commentary on the term above it, OUTSIDE the column sum.
 *    `minorsExposure` is one: it is a component of Committed Bids, already
 *    inside that figure, so subtracting it again would double-count it.
 *  - `subtotal` — a running total, ruled above in the design.
 */
export type CapBreakdownLine = {
	readonly label: string;
	/** Already rendered — the surface prints this and formats nothing itself. */
	readonly figure: string;
	/** `'−'` where the column subtracts this term, empty otherwise. */
	readonly operator: string;
	readonly kind: 'term' | 'detail' | 'subtotal';
};

/**
 * The Maximum Bid breakdown, as rows a surface prints in order.
 *
 * **Never a bare number** (FR-12): the figure is meaningless without the four
 * terms it came from, and a Manager checking the maths by hand must find
 * that it adds up. `EXPERIENCE.md` calls that the load-bearing property of
 * the whole product.
 *
 * **It sums exactly as displayed** whenever the Team's figures sit on the
 * $500,000 grid, which is the ordinary case: `formatMoney`'s one-decimal
 * rendering is lossless there, so `$12.0M − $5.0M = $7.0M` is true of the
 * printed strings and not only of the integers behind them (AD-8). That is
 * why this list is built in the core beside the arithmetic rather than
 * assembled by the surface: a breakdown that did not sum would be a
 * rendering bug with the authority of a rule.
 *
 * **Every figure renders through `describeAmount`, never `formatMoney`, and
 * that is not defensive padding.** Cap Space is `SALARY_CAP` minus imported
 * Cap Hits, and `money.ts`'s own `isOnMoneyGrid` states the premise
 * outright: "an imported Cap Hit is a real-world salary figure with no
 * guarantee it sits on the app's own $500,000 grid". `import-preview.ts`
 * agrees — it ASKS before rendering and shows exact dollars otherwise,
 * because an off-grid Cap Space is imported, flagged to the Commissioner and
 * allowed to stand. `formatMoney` THROWS on such a value by design, so
 * calling it here would turn a tolerated import into a `RangeError` on the
 * Auction page for every viewer on that Team — and, through
 * `bidControlState`, on every keystroke. Available Cap Space and Maximum Bid
 * inherit the same exposure, since both are derived from Cap Space.
 *
 * The labels are PRD §3 glossary terms verbatim on every `term` and
 * `subtotal` row. A synonym in UI copy is a defect, the same as a synonym in
 * code (`EXPERIENCE.md`). The two `detail` rows are commentary rather than
 * ledger lines, so they name an arithmetic step instead of a glossary term —
 * "of which Minors Exposure", and the multiplication behind Roster Reserve.
 *
 * Empty for a viewer with no Team — there is no arithmetic to show, and
 * rows of `$0.0M` would read as a Team that is broke rather than as one that
 * does not exist.
 */
export function capBreakdown(outcome: CapGateOutcome): readonly CapBreakdownLine[] {
	if (
		outcome.capSpace === null ||
		outcome.committedBids === null ||
		outcome.minorsExposure === null ||
		outcome.availableCapSpace === null ||
		outcome.rosterReserve === null ||
		outcome.maximumBid === null ||
		outcome.rosterCount === null ||
		outcome.projectedAdditions === null
	) {
		return [];
	}
	const holes = unfilledSlots(outcome.rosterCount, outcome.projectedAdditions);
	return [
		{ label: 'Cap Space', figure: describeAmount(outcome.capSpace), operator: '', kind: 'term' },
		{
			label: 'Committed Bids',
			figure: describeAmount(outcome.committedBids),
			operator: SUBTRACTED,
			kind: 'term'
		},
		{
			// Inside Committed Bids already — commentary, never a second
			// subtraction. Story 2.8 gives it a non-zero value; the row is here
			// now because FR-13 requires the refusal to show the term and a
			// breakdown missing one of its components would not sum.
			label: 'of which Minors Exposure',
			figure: describeAmount(outcome.minorsExposure),
			operator: '',
			kind: 'detail'
		},
		{
			label: 'Available Cap Space',
			figure: describeAmount(outcome.availableCapSpace),
			operator: '',
			kind: 'subtotal'
		},
		{
			label: 'Roster Reserve',
			figure: describeAmount(outcome.rosterReserve),
			operator: SUBTRACTED,
			kind: 'term'
		},
		{
			label: `${formatMoney(MINIMUM_OPENING_BID)} × ${String(holes)} unfilled Active/Bench Slots`,
			// `MINIMUM_OPENING_BID` is a league constant on the grid by
			// construction, so this one is safe to render outright.
			figure:
				`Roster Count ${String(outcome.rosterCount)}, Projected Active/Bench Additions ` +
				`${String(outcome.projectedAdditions)}, of ${String(ACTIVE_BENCH_SLOTS)}`,
			operator: '',
			kind: 'detail'
		},
		{
			label: 'Maximum Bid',
			figure: describeAmount(outcome.maximumBid),
			operator: '',
			kind: 'subtotal'
		}
	];
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
 * The figure a gate's chip row carries — passed or refused alike.
 *
 * **A figure, not a sentence, and that distinction is the design's.**
 * `EXPERIENCE.md` shows the row as `Slots · Passed — Roster Count would be 10
 * of 12`: the chip states the outcome and this states the arithmetic behind
 * it, in the register of a readout. The full sentence lives one part further
 * up the panel, in the delta, so a row that repeated it would print the same
 * words twice on the most carefully-worded surface in the product.
 *
 * Reporting a PASSING gate is the part that exceeds the SPEC, deliberately:
 * it proves every check ran and this is the only obstacle, which forecloses
 * "what else is it not telling me". It costs one line per gate on every
 * refusal, and auditability over convenience is the stated tiebreaker.
 */
function gateFigure(gates: PlaceBidGateResults, gate: PlaceBidGate): string {
	switch (gate) {
		case 'opening': {
			const outcome = gates.opening;
			switch (outcome.opening) {
				case 'not_an_opening':
					return 'a Bid already leads, so no opening minimum applies';
				case 'above_the_minimum':
					return `above the ${formatMoney(outcome.minimumOpening)} minimum`;
				case 'at_the_minimum':
					return `exactly ${formatMoney(outcome.minimumOpening)}, which opens a contention`;
				case 'below_the_minimum':
					return `under the ${formatMoney(outcome.minimumOpening)} minimum`;
			}
			break;
		}
		case 'selfBid': {
			const outcome = gates.selfBid;
			if (outcome.leadingTeamId === null) return 'no Team leads yet';
			return outcome.passed ? 'another Team leads' : 'your Team leads';
		}
		case 'increment': {
			const outcome = gates.increment;
			if (outcome.minimumLegal === null || outcome.currentHigh === null) {
				return 'no current high to raise';
			}
			return (
				`least ${formatMoney(outcome.minimumLegal)} over a ` +
				`${formatMoney(outcome.currentHigh)} high, offered ${describeAmount(outcome.offered)}`
			);
		}
		case 'granularity': {
			const outcome = gates.granularity;
			return `${outcome.passed ? 'on' : 'off'} the ${formatMoney(outcome.grid)} grid`;
		}
		case 'cap': {
			const outcome = gates.cap;
			if (outcome.maximumBid === null) return 'no Team, so no Maximum Bid';
			return (
				`Maximum Bid ${describeAmount(outcome.maximumBid)}, offered ` +
				`${describeAmount(outcome.offered)}`
			);
		}
	}
	// Unreachable: every gate above returns. Present so a gate added to
	// `PLACE_BID_GATES` without a case here produces a plain row rather than
	// `undefined` rendered into the most important surface in the product.
	return 'reported without a figure';
}

/**
 * The refusing gates' sentences, joined — the panel's part two.
 *
 * `bidRefusalDetail` is the ONE-line form, for a notice with no panel around
 * it: it opens "No Bid was placed" and closes "Nothing was written", because
 * a bare sentence has to carry its own framing. The panel already has a
 * headline saying the first and a reassurance saying the second, so this
 * returns the middle — the same `gateSentence` output, unframed, so the two
 * renderings cannot state the arithmetic differently.
 *
 * Empty when nothing refused, which is the caller's cue that there is no
 * panel to draw.
 */


// --- The refusal panel's own furniture -------------------------------------

/**
 * The refusal panel's headline, verbatim from `EXPERIENCE.md`.
 *
 * Georgia 19px on the panel, and the first of its six parts. Stated here
 * rather than in the component for the reason every sentence in this module
 * is: one definition, so the headline a test asserts and the headline a
 * Manager reads cannot drift apart.
 */
export const REFUSAL_HEADLINE = 'This bid was not placed.';

/**
 * Part three of the panel: reassurance of state, after the delta.
 *
 * It is not decoration. A Manager refused at 4am needs to know the refusal
 * cost them nothing before they will read the arithmetic — which is the
 * whole reason a Bid is refused at submission rather than accepted and
 * reversed later. No apology, no exclamation mark (`EXPERIENCE.md`).
 */
export const REFUSAL_REASSURANCE =
	'Nothing has been committed and the Auction is unchanged. No event was written, the ' +
	'Leading Bidder has not moved, and neither clock has been touched.';

/**
 * The arithmetic's timestamp caption — part five's first line.
 *
 * `EXPERIENCE.md` shows it as "Your figures at 2:14 AM Wed". The instant is
 * rendered by the SURFACE, because an absolute time must be shown in the
 * viewer's own timezone and this module may not so much as name `Date`
 * (AD-2). The caption around it is worded here so no component writes one.
 *
 * It matters more than a caption usually would: these figures are the ones
 * the Bid was actually judged against, and after a refused submit that is
 * the transaction's clock, not the moment the page was rendered.
 */
export function figuresAtCaption(renderedInstant: string): string {
	return `Your figures at ${renderedInstant}`;
}

/** The name a gate goes by on the refusal panel. */
const GATE_LABELS: Readonly<Record<PlaceBidGate, string>> = Object.freeze({
	opening: 'Opening Bid',
	selfBid: 'Self-bid',
	increment: 'Minimum Increment',
	granularity: 'Granularity',
	cap: 'Cap'
});

/** One gate's row on the refusal panel: the chip, and the figure beside it. */
export type BidGateReportRow = {
	readonly gate: PlaceBidGate;
	/** The gate's name alone, for a caller laying the row out itself. */
	readonly label: string;
	readonly passed: boolean;
	/**
	 * The chip's finished text — `Cap · Refused`, verbatim from
	 * `EXPERIENCE.md`.
	 *
	 * Composed here rather than in the component, because "no route,
	 * component or test words a refusal" admits no exception for two words
	 * and a separator. A component choosing between "Passed" and "Refused"
	 * would be the one string on this panel the core does not own, and the
	 * one a redesign could change without a test noticing.
	 */
	readonly chip: string;
	/** That gate's own arithmetic, as a readout. Never empty. */
	readonly figure: string;
};

/** What a chip says about a gate that passed, and about one that did not. */
const GATE_OUTCOMES = Object.freeze({ passed: 'Passed', refused: 'Refused' });

/** The separator between a gate's name and its outcome (`EXPERIENCE.md`). */
const CHIP_SEPARATOR = '·';

/**
 * Every gate's row, in `PLACE_BID_GATES` order — the refusing ones and the
 * passing ones alike.
 *
 * **Built by iterating the declared list**, so Story 2.7's `slots` gate
 * appears on this panel the moment it is added to `PLACE_BID_GATES` and
 * nobody has to remember to render it. That is what makes "both gates always
 * reported" a structural property of the panel rather than a thing a
 * component has to be trusted to do — and it is why each row carries its
 * OWN figure: reporting a capacity refusal as a cap refusal is a defect
 * (AD-7), and two rows each stating their own arithmetic cannot be read as
 * one.
 */
export function bidGateReport(gates: PlaceBidGateResults): readonly BidGateReportRow[] {
	return PLACE_BID_GATES.map((gate) => {
		const passed = gates[gate].passed;
		const outcome = passed ? GATE_OUTCOMES.passed : GATE_OUTCOMES.refused;
		return {
			gate,
			label: GATE_LABELS[gate],
			passed,
			chip: `${GATE_LABELS[gate]} ${CHIP_SEPARATOR} ${outcome}`,
			figure: gateFigure(gates, gate)
		};
	});
}

/**
 * `rules/nomination.ts`'s `nominationRefusalDetail` discipline, applied to
 * bidding: the route, the transaction, the disabled control, the panel and
 * the tests all read ONE wording per refusal, and no surface re-words a rule
 * to work around not being able to import a server module.
 */
/**
 * What a refusal SAYS, unframed — the sentences without "No Bid was placed"
 * in front or "Nothing was written" behind.
 *
 * **The panel's part two.** `bidRefusalDetail` is the one-line form, for a
 * notice with no panel around it: a bare sentence has to carry its own
 * framing, so it opens by saying no Bid was placed and closes by saying
 * nothing was written. The panel already has a headline saying the first and
 * a reassurance saying the second, so it needs the middle alone — and takes
 * it from here rather than re-wording it, which is what keeps the two
 * renderings unable to state the arithmetic differently.
 *
 * Answers for EVERY refusal kind, not only `gates`. The matrix requires the
 * panel on any refused submit, and a refusal decided before a transaction
 * opens has a sentence even though it has no arithmetic.
 *
 * Empty only for a `gates` refusal in which nothing actually failed, which
 * `decide()` never builds — the caller's cue that there is no panel to draw.
 */
export function bidRefusalDelta(refusal: BidRefusal): string {
	switch (refusal.kind) {
		case 'gates': {
			const sentences: string[] = [];
			for (const gate of PLACE_BID_GATES) {
				const sentence = gateSentence(refusal.gates, gate);
				if (sentence !== null) sentences.push(sentence);
			}
			return sentences.join(' ');
		}
		case 'unusable_amount':
			return (
				'the amount is not a whole number of dollars. Enter it in whole dollars, with no ' +
				'decimal point, no comma and no currency symbol.'
			);
		case 'negative_amount':
			return (
				'the amount is negative, and a Bid is what you are offering to pay. Enter it as a ' +
				'positive whole number of dollars.'
			);
		case 'unconfirmed':
			return (
				'the confirmation was not given. A Bid commits your Team to the amount for as long ' +
				'as it leads, so it is never inferred from a submit. Tick the confirmation and ' +
				'submit again.'
			);
		case 'unbound_actor':
			return (
				'you are not bound to a Team, and every event must name one. Ask the Commissioner ' +
				'to bind your Team.'
			);
		case 'no_open_auction':
			return (
				'there is no open Auction for this Player. The Auction was folded from the event ' +
				'log inside this transaction, so reload the page to see the board as it stands now.'
			);
		case 'unrecorded':
			return 'the write was refused and stated no reason.';
	}
}

/**
 * The one refusal sentence for each case — the framed, one-line form.
 *
 * Composed FROM `bidRefusalDelta` rather than restating it, so a refusal has
 * exactly one wording however it is displayed. The framing is all this adds:
 * the fact that no Bid was placed, and the closing statement that nothing was
 * written — which is the whole point of a refusal at this gate, since nothing
 * is committed, the Leading Bidder is unchanged, the Auction Clock did not
 * move and the League Clock did not reset.
 *
 * The `gates` case joins with a full stop rather than a colon, because its
 * body is one or more complete sentences — AD-1 forbids short-circuiting, so
 * a Bid refused on BOTH increment and granularity (PRD §10 example 2) states
 * both grounds in `PLACE_BID_GATES` order. Every other case is a clause.
 */
export function bidRefusalDetail(refusal: BidRefusal): string {
	const closing = 'Nothing was written.';
	const body = bidRefusalDelta(refusal);
	if (refusal.kind === 'gates') {
		if (body === '') {
			// Unreachable through `decide()`, which only builds this refusal
			// when a gate failed — but a caller may hand this function any gate
			// set, and "no Bid was placed and every gate passed" is not a
			// sentence anybody should ever be shown as though it were true.
			return `No Bid was placed: ${bidRefusalDelta({ kind: 'unrecorded' })} ${closing}`;
		}
		return `No Bid was placed. ${body} ${closing}`;
	}
	return `No Bid was placed: ${body} ${closing}`;
}

// --- The consequence -------------------------------------------------------

/**
 * The one statement of what confirming a Bid does. Every sentence the surface
 * prints beside the confirm is built from this string, so the consequence has
 * exactly one wording.
 *
 * It states what this story actually commits and nothing more: the amount
 * stands as the Leading Bid, it is held against the Team's Cap Space for as
 * long as that Bid leads, the Auction Clock restarts at 24 hours from the
 * Bid, and the League Clock resets.
 *
 * **The commitment clause is Story 2.6's.** Story 2.5 deliberately left it
 * out, because `BidState` could not then see a cap figure and claiming a
 * commitment the core could not compute would have been the invented figure
 * the refusal design exists to prevent. `evaluateCap` computes it now, so
 * the sentence may finally be said — including the release, which is the
 * half a Manager needs to hear before pressing the button (FR-14: capital is
 * released the instant the Team ceases to lead, not at close).
 */
export const BID_CONSEQUENCE =
	'your Team becomes the Leading Bidder at that amount, the amount is committed against ' +
	'your Cap Space for as long as your Bid leads and released the instant another Team ' +
	'takes the lead, the Auction Clock restarts at 24 hours from your Bid, and the League ' +
	'Clock resets — and a Bid cannot be cancelled, amended or lowered once it is placed';

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
