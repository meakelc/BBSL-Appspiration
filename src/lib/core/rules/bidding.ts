/**
 * The bidding gate: the two entry points AD-1 fixes, the eight gates they
 * decide through, the one sentence each refusal has, and the arithmetic the
 * refusal panel prints. Pure (Stories 2.5, 2.6, 2.7, 3.1, 3.2).
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
 * **The gate set grew by one gate, four times, exactly as designed.** Story
 * 2.5 owned four and said 2.6 would add `cap`, 2.7 `slots` and 3.1 `expiry`.
 * All three are here, and 3.2 added `contention` — each was the single edit
 * to `PLACE_BID_GATES` in `core/types.ts` that the design promised, and each
 * time every consumer was a compile error until it handled the new gate.
 *
 * **`contention` is Story 3.2's, and it owns every amount question INSIDE a
 * lottery.** Joining, joining twice, the dead zone between the two thresholds
 * and the conversion this story deliberately does not build are one
 * classification of one amount, so they are one gate rather than four. It
 * sits immediately after `opening` because the two are one reading — what an
 * amount means when nothing leads, and what it means once a Minimum-Bid
 * Contention is running — and because `increment` steps aside entirely in a
 * lottery: there is no ascending raise to be short of when every Contender
 * holds the identical $1,000,000. `granularity` does NOT step aside, and
 * still reads the amount and nothing else.
 *
 * **`expiry` is Story 3.1's, and it is the only gate that asks what time it
 * is.** It compares the injected `now` against the PERSISTED absolute close
 * instant the `BidPlaced` payload carried and `auctionsReducer` folded
 * (AD-12), through the one `hasExpired` derivation in
 * `projection/auctions.ts`. It never reads whether a projection still holds
 * an Auction row, never reads a contention state and never reads the
 * nomination fold: an Auction whose close has passed refuses a Bid whether
 * or not Story 3.5's sweep has got round to recording the close, which is
 * what makes a stalled sweep produce LATE closes rather than wrong ones. It
 * goes FIRST in `PLACE_BID_GATES` because a clock that has run out is the
 * frame every other question sits inside.
 *
 * **What the two gates may see.** Story 2.6 gave this module a Team's Cap
 * Space, its Roster Count and the open Auctions it leads, because Maximum
 * Bid cannot be derived without them (AD-7). Story 2.8 gives it the three
 * facts Minors Exposure was missing: the eligible Auctions the Team leads,
 * how many Minor League Slots its roster occupies, and whether the Player
 * being bid on is Minor League Eligible. From those, ONE counts-only
 * expression (`minorsCountsFor`) derives `M`, `N` and `Overflow Count`, and
 * ONE money expression (`minorsExposureFor`) derives Minors Exposure and the
 * Auctions it sums over.
 *
 * **The split between those two is load-bearing.** `Overflow Count` is a
 * count, so `evaluateSlots` and `projectedAdditionsFor` reach it without
 * ever seeing an amount; only `evaluateCap` calls the money one. A single
 * function returning both would have handed the capacity gate a money figure
 * it must be unable to reach, and FR-37's independence would stop being a
 * property of the signatures.
 *
 * **Unbounded is not a waiver.** When this Player is Minor League Eligible
 * and `Overflow Count` is 0, a Free Minor League Slot absorbs the win at a
 * $0 Cap Hit and the offered amount is compared to nothing (FR-35, §10
 * example 18) — but `Available Cap Space − Roster Reserve ≥ 0` still
 * decides, which is PRD §3's "provided Roster Reserve remains coverable" and
 * FR-13's "only the Roster Reserve check and the ordinary increment rules
 * apply there". The figure renders in WORDS, never as a number.
 *
 * **`slots` is the second, independent ground** (Story 2.7, FR-37): it
 * refuses on `Roster Count + Projected Active/Bench Additions >
 * ACTIVE_BENCH_SLOTS`, that comparison lives in `evaluateSlots` below, and
 * it reads NO amount and NO Maximum Bid — so a Team can fail it with
 * unlimited Cap Space and pass it with none. Neither gate short-circuits,
 * subsumes or gates the other; `evaluate()` returns both outcomes with their
 * own arithmetic whether or not the other passed. Reporting a capacity
 * refusal as a cap refusal is a defect (AD-7), so the two share the
 * DERIVATION — `projectedAdditionsFor`, one expression — and never the
 * outcome.
 *
 * **The `+ 1` in `projectedAdditionsFor` is now conditional, and Overflow is
 * the hinge.** FR-37 lets a Team at Roster Count 12 bid on a Minor League
 * Eligible Player a Free Minor League Slot would absorb, because that win
 * adds nothing to Active/Bench — so the Bid being placed adds one only when
 * this Player is NOT eligible (PRD §3), and `Overflow Count` adds back the
 * eligible wins that have nowhere to land. One derivation therefore refuses
 * the cheap bid on money (§10 example 19) and the fourth stash on capacity
 * (§10 example 25) without either gate learning the other's ground.
 *
 * **A Minimum-Bid Contention is created here now, and dissolved nowhere.**
 * An Opening Bid of exactly `MINIMUM_BID` PASSES the `opening` gate and opens
 * one; `decide()` publishes `hash(seed)` on that Bid's payload and the shell
 * seals the seed in a table no role can read (AD-14). A Bid of $1,500,000 or
 * more into a live contention is REFUSED by name on `contention`, exactly as
 * 2.5 refused `at_the_minimum` by name rather than half-doing it: the
 * Contender release, the seed reveal and `ContentionDissolved` are Story 3.3,
 * and a conversion that silently released commitments while leaving the seed
 * sealed is the one outcome AD-14 forbids.
 *
 * **`seed` is read by `decide()` since Story 3.2**, through the fourth
 * parameter AD-1 fixed and 2.5 shipped declared-and-unused. It is never
 * generated here — the core reads no randomness (AD-2), so the shell makes it
 * and passes it in — and never stored here: the ONE thing done with it is
 * `hash(seed)`, which is `core/hash.ts`'s pure SHA-256 so that Node, Deno and
 * a Manager with `sha256sum` all compute the same commitment.
 *
 * **The fixed clock is `decide()`'s, not the fold's.** A join's `BidPlaced`
 * payload carries the contention's EXISTING `closesAt` verbatim; a fresh
 * `closeInstantFor(now, AUCTION_CLOCK)` is computed only for an opening or a
 * raise. That the fold also preserves the clock — a join is never strictly
 * higher, so it never becomes `leadingBid` — is a second guarantee resting on
 * an unrelated invariant, and a persisted payload claiming a join closes 24
 * hours from itself is a lie Story 3.5's sweep would act on.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2). It reads
 * no clock: `now` is an argument, and the only thing done with it is instant
 * arithmetic through `core/instant.ts` and `projection/auctions.ts`. That
 * sentence was true before `expiry` existed and is true with it — the gate
 * has a consumer for `now` now, and still no source for one.
 */

import {
	ACTIVE_BENCH_SLOTS,
	AUCTION_CLOCK,
	MINIMUM_BID,
	MINIMUM_INCREMENT,
	MINOR_LEAGUE_SLOTS
} from '../constants.ts';
import { hash } from '../hash.ts';
import { parseInstant, relativePhrase } from '../instant.ts';
import type { Auction, ContentionState, OpenAuctions } from '../projection/auctions.ts';
import {
	AUCTION_EXPIRED,
	BID_PLACED_EVENT,
	MINIMUM_BID_CONTENTION_LABEL,
	auctionForPlayer,
	closeInstantFor,
	closesInPhrase,
	contentionForAmount,
	hasExpired
} from '../projection/auctions.ts';
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
	ContentionGateOutcome,
	Decided,
	EventEnvelope,
	ExpiryGateOutcome,
	ExposingBid,
	GranularityGateOutcome,
	IncrementGateOutcome,
	OpeningGateOutcome,
	PlaceBid,
	PlaceBidGate,
	PlaceBidGateResults,
	Rejected,
	SelfBidGateOutcome,
	SlotsGateOutcome
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
 * Narrower than `projection/auctions.ts`'s `Bid` on purpose, and it stays
 * narrow now that `expiry` exists. A gate that cannot see a Bid's `seq` or
 * its own instant cannot come to depend on one.
 *
 * **The close instant deliberately did NOT arrive here.** Story 3.1 owns
 * expiry-as-authority, and the narrowing this header used to justify by
 * saying no gate could reach a close time still holds for the reason it was
 * made: an Auction's close is a fact about the AUCTION, not about whichever
 * Bid happens to lead it, and a gate reading it off the leading Bid would be
 * reading it out of a projection row. So `closesAt` went onto `BidState` —
 * one field, beside the other facts the gates decide from — and this shape
 * is unchanged. The `selfBid` gate still sees a Team and an amount and
 * nothing else.
 */
export type LeadingBid = {
	readonly teamId: string;
	readonly amount: Money;
};

/**
 * Everything the bidding gates decide from — and it really is everything.
 *
 * The smallest shape that answers every gate: the leading Bid — `null` when
 * the Player is nominated and nobody has bid — the Auction's own persisted
 * close instant, and the bidding Team's money facts.
 * Whether an Auction is OPEN at all is not asked here — that is the
 * nomination fold, and `server/bidding.ts` answers it under the lock before
 * `decide()` is ever called. Whether it has RUN OUT is asked here, and only
 * from `closesAt` below: the two questions are different, and AD-12 is the
 * rule that keeps the second from being answered with the first.
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
 * Roster CAPACITY is decided from this same shape: Story 2.7's `slots` gate
 * reads `team.rosterCount` and `team.leading`, and Story 2.8 adds the
 * Overflow term to it from the two fields below.
 *
 * `playerIsMinorLeagueEligible` is Story 2.8's addition, and it is a fact
 * about the AUCTION rather than about the Team — which is why it sits here
 * and not on `TeamMoneyState`. It is what decides whether the prospective
 * Bid joins the eligible set at all, and therefore whether a Free Minor
 * League Slot can absorb it. The Team's own occupancy and eligible leads are
 * on `TeamMoneyState`, where every other Team fact lives.
 */
export type BidState = {
	readonly leadingBid: LeadingBid | null;
	/**
	 * The Auction's persisted absolute close instant, exactly as the
	 * `BidPlaced` payload carried it and `auctionsReducer` folded it — never
	 * recomputed here, and never derived from the leading Bid's own instant.
	 *
	 * `null` is a nominated Player nobody has bid on: no Opening Bid, so no
	 * Auction Clock, so nothing for `expiry` to run out. It is the ONE input
	 * to expiry-as-authority (AD-12), which is why it sits on the state both
	 * the transaction and the SURFACE build rather than on `LeadingBid`.
	 */
	readonly closesAt: string | null;
	/**
	 * Which contention this Auction is in, as `auctionsReducer` folded it —
	 * `awaiting_opening_bid` for a nominated Player nobody has bid on.
	 *
	 * Story 3.2's addition, and it is READ off the fold rather than re-derived
	 * from `leadingBid.amount` here. The reducer decides an Auction's
	 * contention through `contentionForAmount`, and a gate that re-derived it
	 * from the leading amount would be a second answer to a question the fold
	 * already answers — the drift AD-5 makes the fold the authority to
	 * prevent.
	 */
	readonly contention: ContentionState;
	/**
	 * The Teams already on the Contender list, in ascending join `seq`
	 * (AD-14) — ids only.
	 *
	 * Ids and not names, for `LeadingBid`'s reason: the `contention` gate
	 * matches an acting Team against this list and reads nothing else off it,
	 * so a gate that cannot see a Team's NAME cannot come to depend on one.
	 * The Auction page names the Contenders out loud from the fold's own
	 * `Contender[]`, which carries both.
	 *
	 * Empty for every Auction that is not a Minimum-Bid Contention.
	 */
	readonly contenders: readonly string[];
	readonly team: TeamMoneyState | null;
	/**
	 * Whether the Player being bid on is Minor League Eligible — the fold of
	 * `MinorLeagueEligibilitySet` (`projection/eligibility.ts`), never a
	 * column read at bid time.
	 */
	readonly playerIsMinorLeagueEligible: boolean;
};

/**
 * One open Auction the bidding Team already leads, as the money gate needs
 * it: the Player it is on and the amount held against the Cap.
 *
 * **ONE shape, two lists, and the PARTITION happens in `teamMoneyStateFor`
 * rather than in a gate.** FR-14 puts a leading amount on a Minor League
 * Eligible Player into Minors Exposure instead of straight into Committed
 * Bids, so an eligible lead is not a smaller contribution to `leading` — it
 * is not in `leading` at all, it is in `eligibleLeading`. Both lists carry
 * this shape: two shapes differing by one field would invite a second
 * narrowing, and the two lists are the same fact routed two ways.
 *
 * `fantraxPlayerId` is carried so a refusal can NAME the Auctions holding
 * the money, and `playerName` so it can name them in words a Manager
 * recognises — §10 example 19's refusal names the specific earlier Auction.
 * Neither is read by any comparison; `fantraxPlayerId` is also the AD-5
 * tiebreak that makes the exposure sum's input an ordered sequence.
 */
export type LeadingBidElsewhere = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
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
	/**
	 * The NON-eligible open Auctions this Team leads — the ones whose amounts
	 * go straight into Committed Bids.
	 *
	 * Sorted by `fantraxPlayerId`, because a sum's inputs are a sequence
	 * (AD-5).
	 */
	readonly leading: readonly LeadingBidElsewhere[];
	/**
	 * The Minor League Eligible open Auctions this Team leads — the ones
	 * whose amounts reach the Cap only through Minors Exposure (FR-14), and
	 * only when they overflow.
	 *
	 * Excludes the Auction being bid on, exactly as `leading` does: the
	 * prospective Bid replaces any lead held there, and the post-bid count
	 * adds it back once.
	 *
	 * Sorted by `fantraxPlayerId` for `leading`'s reason. The exposure sum
	 * re-sorts by AMOUNT before it slices, because the largest amounts are
	 * what it takes — but it re-sorts an already-ordered sequence, so the
	 * result is deterministic at both steps.
	 */
	readonly eligibleLeading: readonly LeadingBidElsewhere[];
	/**
	 * How many of this Team's three Minor League Slots its roster occupies —
	 * the RAW count from `team_rosters`, never `M`.
	 *
	 * `M = max(0, 3 − occupied)` is a derived figure, and a derived figure on
	 * this shape is exactly what the header above forbids: the whole point of
	 * carrying facts is that the derivation runs on every evaluation, in the
	 * browser and inside the lock alike, and cannot be transported
	 * pre-computed. A Commissioner override can legitimately put this ABOVE
	 * three, which is why the clamp lives in the derivation.
	 */
	readonly minorLeagueOccupied: number;
};

/**
 * The `BidState` for an Auction as `projection/auctions.ts` folded it,
 * plus the Team's money state.
 *
 * The one narrowing from the folds to the gates, so the transaction and the
 * read path cannot narrow them two different ways. A `null` Auction —
 * nominated, nobody has bid — is a state, not a failure, and so is a `null`
 * Team.
 *
 * `playerIsMinorLeagueEligible` is required rather than defaulted, and that
 * is deliberate: adding it made every caller a compile error, which is how a
 * fact that changes what a gate decides is supposed to arrive. A default of
 * `false` would have let a caller silently keep the pre-2.8 behaviour.
 *
 * Story 3.1 changed NO caller signature: `closesAt` comes off the `Auction`
 * this function already receives, so the transaction needed no plumbing at
 * all to give `expiry` its authority. The `null`-Auction branch passes
 * `null` through, which is the no-clock state rather than a missing one.
 *
 * Story 3.2 changed none either, for the same reason twice over: the
 * contention state and the Contender list are both already on the `Auction`
 * this function receives, so the `contention` gate cost the transaction and
 * the read path no plumbing at all. The `null`-Auction branch answers
 * `awaiting_opening_bid` and an empty list, which is what a nominated Player
 * nobody has bid on genuinely is.
 */
export function bidStateFor(
	auction: Auction | null,
	team: TeamMoneyState | null,
	playerIsMinorLeagueEligible: boolean
): BidState {
	if (auction === null) {
		return {
			leadingBid: null,
			closesAt: null,
			contention: 'awaiting_opening_bid',
			contenders: [],
			team,
			playerIsMinorLeagueEligible
		};
	}
	return {
		leadingBid: { teamId: auction.leadingBid.teamId, amount: auction.leadingBid.amount },
		closesAt: auction.closesAt,
		contention: auction.contention,
		// Ids alone, in the fold's own order. The narrowing is what keeps the
		// gate from reaching a Contender's name or join instant.
		contenders: auction.contenders.map((contender) => contender.teamId),
		team,
		playerIsMinorLeagueEligible
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
 * Two filters decide what is collected at all, and each is a rule:
 *
 *  - **the Auction being bid on is skipped.** The prospective Bid replaces
 *    any lead this Team holds there, so counting both would commit the Team
 *    twice for one Player — and Projected Active/Bench Additions counts the
 *    bid being placed exactly once (AD-7's post-bid basis).
 *  - **Auctions another Team leads are skipped**, which is what makes
 *    capital release the instant a Team is outbid: the lead moves in the
 *    fold and the amount simply stops appearing here. No sweep, no flag, no
 *    scheduled job (FR-14, §10 ex 5).
 *
 * What is left is then **PARTITIONED, not filtered** (Story 2.8). Until 2.8
 * this loop `continue`d on a Minor League Eligible Player and the set Minors
 * Exposure sums over simply did not exist. It now routes that entry into
 * `eligibleLeading` instead of dropping it: FR-14 puts an eligible lead into
 * Minors Exposure rather than into Committed Bids, and "into" is not "away".
 * Every open Auction this Team leads lands in exactly one of the two lists,
 * which is what makes the two counts add up to the leads the fold actually
 * holds.
 *
 * A `minimum_bid` contention contributes `MINIMUM_OPENING_BID` — the branded
 * `MINIMUM_BID` — rather than the leading amount, because any Contender may
 * win and they all hold the same $1,000,000 (FR-14). That substitution is
 * written ONCE, before the routing, so it applies to an eligible contention
 * exactly as it does to a non-eligible one: an eligible Minimum-Bid
 * Contention contributes an Eligible Leading Bid of $1,000,000, and commits
 * nothing at all while a Free Minor League Slot absorbs it.
 *
 * **Story 3.2 widens the LEADER filter to every Contender, and that one
 * change is §10 examples 21 and 22.** Until 3.2 a Team's capital was held
 * only where it held `leadingBid`, which in a lottery is whichever Team
 * opened it — so three Teams who joined a contention showed no commitment at
 * all while the opener showed the whole $1,000,000. Any Contender may win,
 * so every Contender commits, and the amount each commits is the same flat
 * `MINIMUM_OPENING_BID` the substitution below already produced. The
 * partition by eligibility is untouched: an eligible contention still routes
 * into `eligibleLeading` through the single existing branch, which is what
 * makes §10 example 21's join commit nothing while a Free Minor League Slot
 * can absorb it and §10 example 22's overflowing join commit $5,000,000.
 *
 * `playerNameFor` answers what a Player is called, because §10 example 19's
 * refusal names an Auction and an id is not a name. It is a function rather
 * than a map so the caller can source it from whatever fold already holds
 * the name — `nominationForPlayer`, on the read path and under the lock
 * alike — without this module learning about nominations.
 *
 * Keys are iterated in sorted order (AD-5): a sum over an incidental key
 * order is a sum whose inputs are not a sequence.
 */
export function teamMoneyStateFor(input: {
	readonly teamId: string;
	/** The Auction being bid on — excluded from both lists, per above. */
	readonly fantraxPlayerId: string;
	readonly capSpace: Money;
	readonly rosterCount: number;
	/** Minor League rows on `team_rosters`. Raw occupancy, never `M`. */
	readonly minorLeagueOccupied: number;
	readonly auctions: OpenAuctions;
	readonly isMinorLeagueEligible: (fantraxPlayerId: string) => boolean;
	/** That Player's name, for a refusal that must name an Auction. */
	readonly playerNameFor: (fantraxPlayerId: string) => string;
}): TeamMoneyState {
	const leading: LeadingBidElsewhere[] = [];
	const eligibleLeading: LeadingBidElsewhere[] = [];
	for (const playerId of Object.keys(input.auctions.byPlayer).sort()) {
		if (playerId === input.fantraxPlayerId) continue;
		const auction = auctionForPlayer(input.auctions, playerId);
		if (auction === null) continue;
		// The Team commits where it LEADS, and — since Story 3.2 — where it
		// CONTENDS. The two are the same question asked of two contention
		// states: in Standard Contention exactly one Team can win, and in a
		// Minimum-Bid Contention any Contender can. `contenders` is empty for
		// every Auction that is not a lottery, so this reads as the leader
		// filter it used to be wherever no lottery is running.
		const leads = auction.leadingBid.teamId === input.teamId;
		const contends = auction.contenders.some((contender) => contender.teamId === input.teamId);
		if (!leads && !contends) continue;
		const entry: LeadingBidElsewhere = {
			fantraxPlayerId: playerId,
			playerName: input.playerNameFor(playerId),
			amount:
				auction.contention === 'minimum_bid' ? MINIMUM_OPENING_BID : auction.leadingBid.amount
		};
		// The partition, and the only place either list is written.
		if (input.isMinorLeagueEligible(playerId)) eligibleLeading.push(entry);
		else leading.push(entry);
	}
	return {
		capSpace: input.capSpace,
		rosterCount: input.rosterCount,
		leading,
		eligibleLeading,
		minorLeagueOccupied: input.minorLeagueOccupied
	};
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
 * arithmetic. The opening minimum is instead derived from the gates that DO
 * apply: `opening` refuses anything BELOW `MINIMUM_BID`, `contention` has
 * nothing to decide before a lottery exists, and `granularity` refuses
 * anything off the `MINIMUM_INCREMENT` grid. The smallest value satisfying
 * all three is `MINIMUM_BID` itself.
 *
 * **It was `MINIMUM_BID + MINIMUM_INCREMENT` until Story 3.2, and the
 * derivation is what changed rather than the constant.** The opening gate
 * used to refuse exactly `MINIMUM_BID` by name, because no Contender list,
 * seed or fixed clock existed to run the lottery it opens; all three exist
 * now, the gate passes that amount, and the pre-fill follows the gates rather
 * than being adjusted to match them. `tests/core/bidding.test.ts` asserts the
 * derivation rather than the constant, by checking that every state's
 * pre-fill passes every gate.
 *
 * **Inside a live contention the figure is `MINIMUM_BID`**, which is the join
 * amount and the ONLY amount `contention` accepts: a raise does not exist in
 * a lottery, so `minimumRaise` would pre-fill a conversion the gate refuses.
 *
 * **One state has no legal amount at all, and this function still answers.**
 * A Team already on the Contender list is refused at `$1,000,000` on
 * `already_contending` and at everything above it on `converts` — there is no
 * figure that passes every gate for them until Story 3.3 builds dissolution.
 * The pre-fill is still the join amount, because a field pre-filled with the
 * amount the contention actually takes, beside a control disabled with the
 * reason, is the honest rendering; inventing a figure that passes nothing
 * would not be.
 */
export function minimumLegalBid(state: BidState): Money {
	// A lottery takes exactly one amount, whoever is asking.
	if (state.contention === 'minimum_bid') return MINIMUM_OPENING_BID;
	const leading = state.leadingBid;
	if (leading === null) return MINIMUM_OPENING_BID;
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
 * Four questions in one, discriminated by `opening` so the wording and the
 * tests read a field rather than re-deriving a comparison:
 *
 *  - a Bid already leads → `not_an_opening`, passes. The increment gate owns
 *    the raise in Standard Contention and the `contention` gate owns the
 *    amount in a lottery; an opening rule applied to either would
 *    double-refuse.
 *  - above `MINIMUM_BID` → `above_the_minimum`, passes: Standard Contention.
 *  - exactly `MINIMUM_BID` → `at_the_minimum`, PASSES since Story 3.2: this
 *    is the amount that opens a Minimum-Bid Contention, and the Contender
 *    list, the seed and the fixed clock that make one work all exist now.
 *    `decide()` is what stamps `hash(seed)` onto this Bid's payload; nothing
 *    is decided about the lottery HERE, because this gate asks one question
 *    and it is about the minimum.
 *  - below `MINIMUM_BID` → `below_the_minimum`, refused: PRD §3, "Opening
 *    Bid — Minimum $1,000,000".
 *
 * **The comparison is unchanged and only the verdict moved**, which is what
 * makes this a one-line edit rather than a rewrite. `at_the_minimum` still
 * names itself, so the panel's figure still says which case this was, and a
 * later story that needed to refuse it again would have the branch to do it
 * in.
 */
function evaluateOpening(state: BidState, amount: Money): OpeningGateOutcome {
	const base = { offered: amount, minimumOpening: MINIMUM_OPENING_BID };
	if (state.leadingBid !== null) {
		return { ...base, passed: true, opening: 'not_an_opening' };
	}
	const order = compareMoney(amount, MINIMUM_OPENING_BID);
	if (order > 0) return { ...base, passed: true, opening: 'above_the_minimum' };
	if (order === 0) return { ...base, passed: true, opening: 'at_the_minimum' };
	return { ...base, passed: false, opening: 'below_the_minimum' };
}

/**
 * The amount at which a Bid stops joining a Minimum-Bid Contention and starts
 * trying to convert it — `MINIMUM_BID + MINIMUM_INCREMENT`, $1,500,000.
 *
 * Branded once here, from the two constants it is made of, rather than
 * written as a literal: it is the SAME expression `minimumLegalBid` used for
 * an opening before Story 3.2, and a second spelling of the sum is a second
 * value that could drift from the grid it sits on.
 */
const CONVERSION_AMOUNT: Money = addMoney(MINIMUM_OPENING_BID, INCREMENT);

/**
 * The Minimum-Bid Contention gate: every amount question inside a lottery
 * (Story 3.2, FR-18, AD-14).
 *
 * **It owns the amount once a lottery is running, and `increment` steps
 * aside.** There is no ascending raise in a Minimum-Bid Contention to be
 * short of — every Contender holds the identical $1,000,000 — so the
 * increment rule reports that no rule applies, exactly as it already does for
 * an opening, and this gate classifies the offered amount instead.
 *
 * Four outcomes and one pass:
 *
 *  - no lottery → `not_a_contention`, passes with no Contenders. Every
 *    Auction on the board that is not at exactly $1,000,000 reads this, and
 *    every other gate behaves exactly as it did before this one existed.
 *  - exactly the join amount, from a Team not yet in → `joins`, passes.
 *  - exactly the join amount, from a Team already in → `already_contending`,
 *    REFUSED. A Team joins once: every Contender holds the same amount, so a
 *    second join would commit nothing new and buy a second chance at a draw
 *    whose ordered Contender list is an input to the winner (AD-14).
 *  - at or above the conversion amount → `converts`, REFUSED and named as
 *    Story 3.3's. Accepting it as an ordinary raise would produce most of
 *    dissolution for free — the fold would go `standard`, the clock would
 *    reset, and every Contender's commitment would quietly release, because
 *    `teamMoneyStateFor` would stop seeing them — while leaving the seed
 *    sealed forever. AD-14's "no unopened commitment is left behind" is
 *    precisely what that silently breaks.
 *  - strictly between the two → `neither`, refused. §10 example 10's dead
 *    zone: too high to join, too low to convert. Under the $500,000 grid it
 *    contains no on-grid amount at all, so `granularity` refuses every
 *    member of it too and the two grounds are reported together.
 *
 * **The acting Team is matched by id and nothing else**, which is
 * `evaluateSelfBid`'s discipline for the same reason: a co-managed Team is
 * one Contender, so the second Manager submitting $1,000,000 for a Team
 * already in gets the same refusal the first would.
 *
 * Reads no clock, no Cap figure and no roster. A Bid can be refused here with
 * unlimited Cap Space and accepted here with none — `cap` is the gate that
 * decides whether a Team can afford the join, and it reports its own
 * arithmetic beside this one whichever way each of them goes.
 */
function evaluateContention(
	state: BidState,
	amount: Money,
	actingTeamId: string
): ContentionGateOutcome {
	const base = {
		offered: amount,
		joinAmount: MINIMUM_OPENING_BID,
		conversionAmount: CONVERSION_AMOUNT
	};
	// The fold's own state literal, read rather than re-derived from the
	// leading amount — `auctionsReducer` decides this through
	// `contentionForAmount` and AD-5 makes that answer the answer.
	if (state.contention !== 'minimum_bid') {
		return { ...base, passed: true, entry: 'not_a_contention', contenderCount: 0 };
	}

	const contenderCount = state.contenders.length;
	if (compareMoney(amount, MINIMUM_OPENING_BID) === 0) {
		if (state.contenders.includes(actingTeamId)) {
			return { ...base, passed: false, entry: 'already_contending', contenderCount };
		}
		return { ...base, passed: true, entry: 'joins', contenderCount };
	}
	if (compareMoney(amount, CONVERSION_AMOUNT) >= 0) {
		return { ...base, passed: false, entry: 'converts', contenderCount };
	}
	return { ...base, passed: false, entry: 'neither', contenderCount };
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
 * **Two states report that no rule applies, and both null their figures
 * together.** With no leading Bid there is no current high to exceed; inside
 * a Minimum-Bid Contention there is no ascending raise at all, because every
 * Contender holds the identical $1,000,000 and joining is not raising. In
 * either case stating a minimum legal raise over a high that does not
 * function as one would be inventing arithmetic a refusal panel would then
 * print. The `opening` gate owns the first case and the `contention` gate
 * owns the second.
 *
 * **`currentHigh` is nulled in a contention even though a leading Bid
 * exists**, and that is the honest report rather than a convenience: the
 * figure's meaning is "the amount you must beat", and in a lottery there is
 * no amount to beat. Reporting $1,000,000 there would put a number on the
 * panel that no comparison was made against.
 *
 * "At least" — a Bid exactly one increment above the high is legal; a Bid AT
 * the high or below it is not, which is the same comparison and needs no
 * second gate (PRD §10, "at or below the current high" is refused here).
 */
function evaluateIncrement(state: BidState, amount: Money): IncrementGateOutcome {
	const leading = state.leadingBid;
	if (leading === null || state.contention === 'minimum_bid') {
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
 * Zero, branded once.
 *
 * Two jobs, both real: the empty sum Minors Exposure starts from when no
 * Eligible Leading Bid overflows, and the figure an unbounded Maximum Bid is
 * compared against to decide whether Roster Reserve is still coverable. It
 * is not a placeholder for arithmetic that does not exist — that is what it
 * was until Story 2.8, and it is not that any more.
 */
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
 * A `BidState` whose Team is known — everything the exposure arithmetic
 * decides from, and nothing that can be `null`.
 *
 * `BidState.team` is legitimately `null` for a viewer bound to no Team, and
 * both gates answer that case with their figures nulled TOGETHER before any
 * of the derivations below runs. Narrowing it into its own type here is what
 * lets those derivations be total: they return counts and money, never
 * `null`, so no caller can forget which half of an optional pair it is
 * holding.
 */
type BoundBidState = {
	readonly team: TeamMoneyState;
	readonly playerIsMinorLeagueEligible: boolean;
};

/** `BidState`, narrowed once the Team is known to be present. */
function boundStateFor(state: BidState, team: TeamMoneyState): BoundBidState {
	return { team, playerIsMinorLeagueEligible: state.playerIsMinorLeagueEligible };
}

/**
 * The Minors arithmetic, in COUNTS ALONE — `M`, `N` and `Overflow Count`.
 *
 * **This is the single hinge of Story 2.8, and it deliberately cannot see a
 * dollar.** `evaluateSlots`, `projectedAdditionsFor` and `evaluateCap` all
 * call it; only `evaluateCap` goes on to call `minorsExposureFor` for the
 * money. Splitting the derivation in two is what keeps `SlotsGateOutcome`
 * free of an `offered` field and of any money figure at all, so FR-37's "a
 * Team can fail it with unlimited Cap Space and pass it with none" stays a
 * property of the signatures rather than a claim to verify by reading. A
 * single function returning both would have handed the capacity gate a money
 * figure it must be unable to reach.
 *
 *   M = max(0, MINOR_LEAGUE_SLOTS − occupied)   — PRD §3 "Free Minor League Slots"
 *   N = eligible leads elsewhere + (1 if this Player is eligible)
 *   Overflow Count = max(0, N − M)              — PRD §3, FR-35
 *
 * **`N` is the POST-BID count**, the same basis Roster Reserve and Roster
 * Capacity use: `teamMoneyStateFor` excludes the Auction being bid on from
 * `eligibleLeading`, and this adds the prospective Bid back exactly once.
 * §10 example 18's `N + 1 = 1 ≤ M = 1` is that arithmetic with no leads
 * elsewhere at all.
 *
 * **`M` is clamped at zero** because a Commissioner override (Story 7.x) can
 * leave a Team with four occupied Minor League Slots, and an unclamped `M`
 * would go negative — which would then SUBTRACT from Overflow Count and hand
 * that Team extra spending power as a reward for the override. It is the
 * same clamp, for the same reason, as `unfilledSlots`'.
 */
type MinorsCounts = {
	readonly freeMinorLeagueSlots: number;
	readonly eligibleLeadingBids: number;
	readonly overflowCount: number;
};

function minorsCountsFor(state: BoundBidState): MinorsCounts {
	const freeMinorLeagueSlots = Math.max(0, MINOR_LEAGUE_SLOTS - state.team.minorLeagueOccupied);
	const eligibleLeadingBids =
		state.team.eligibleLeading.length + (state.playerIsMinorLeagueEligible ? 1 : 0);
	return {
		freeMinorLeagueSlots,
		eligibleLeadingBids,
		overflowCount: Math.max(0, eligibleLeadingBids - freeMinorLeagueSlots)
	};
}

/**
 * Minors Exposure, and the earlier Auctions it sums over.
 *
 * **The money half of the split, and `evaluateCap`'s alone.** Nothing else in
 * this module calls it, which is what stops the capacity gate from ever
 * reaching an amount.
 *
 * The set is the POST-BID one: the Team's Eligible Leading Bids elsewhere,
 * plus the Bid being placed when this Player is eligible. Exposure is the sum
 * of the `Overflow Count` LARGEST amounts in it — the worst case, because any
 * `Overflow Count` of these wins could be the ones that land in Active/Bench
 * at full price and a Team must be able to cover whichever they are.
 *
 * **The prospective Bid is in the set it is judged against, and that is the
 * PRD's arithmetic.** §10 example 20 is explicit: exposure is $1,000,000,
 * "the bid's own amount", so Maximum Bid is `$2.0M − $1.0M = $1.0M` and the
 * $1.0M Bid is permitted at exactly the ceiling. The effective bound on a
 * sole overflowing eligible Bid is therefore half the Team's room. That is
 * conservative rather than wrong, it is what §10 states, and §10 is the
 * executable specification (AD-25).
 *
 * **The sequence is sorted explicitly before it is sliced** — amount
 * descending, `fantraxPlayerId` ascending as the tiebreak (AD-5). Two
 * exposing Auctions at the same amount would otherwise make both the figure
 * and the naming depend on an incidental input order, and a refusal that
 * names a different Auction on two evaluations of the same state is a
 * refusal a Manager cannot check.
 *
 * `exposingBids` reports the EARLIER Auctions in that slice and never the
 * prospective Bid: naming the Auction a Manager is looking at as the cause of
 * its own refusal explains nothing. It is therefore legitimately empty even
 * when exposure is non-zero (§10 example 20).
 */
type MinorsExposure = {
	readonly minorsExposure: Money;
	readonly exposingBids: readonly ExposingBid[];
	readonly exposureIncludesThisBid: boolean;
};

function minorsExposureFor(
	state: BoundBidState,
	/** The Auction being bid on — the prospective entry's own id, for the tiebreak. */
	fantraxPlayerId: string,
	amount: Money
): MinorsExposure {
	const { overflowCount } = minorsCountsFor(state);
	if (overflowCount <= 0) {
		return { minorsExposure: NO_MONEY, exposingBids: [], exposureIncludesThisBid: false };
	}

	type Entry = ExposingBid & { readonly isThisAuction: boolean };
	const postBid: Entry[] = state.team.eligibleLeading.map((lead) => ({
		fantraxPlayerId: lead.fantraxPlayerId,
		playerName: lead.playerName,
		amount: lead.amount,
		isThisAuction: false
	}));
	if (state.playerIsMinorLeagueEligible) {
		// The Bid being placed. Its name is never printed — `exposingBids`
		// drops it — so it carries its id and nothing invented.
		postBid.push({ fantraxPlayerId, playerName: '', amount, isThisAuction: true });
	}

	// Amount descending, id ascending. Sorted before it is summed OR sliced,
	// so the figure and the naming are the same on every evaluation (AD-5).
	const sorted = [...postBid].sort((left, right) => {
		const byAmount = compareMoney(right.amount, left.amount);
		if (byAmount !== 0) return byAmount;
		if (left.fantraxPlayerId < right.fantraxPlayerId) return -1;
		if (left.fantraxPlayerId > right.fantraxPlayerId) return 1;
		return 0;
	});

	const overflowing = sorted.slice(0, overflowCount);
	let minorsExposure: Money = NO_MONEY;
	for (const entry of overflowing) {
		minorsExposure = addMoney(minorsExposure, entry.amount);
	}
	return {
		minorsExposure,
		exposingBids: overflowing
			.filter((entry) => !entry.isThisAuction)
			.map((entry) => ({
				fantraxPlayerId: entry.fantraxPlayerId,
				playerName: entry.playerName,
				amount: entry.amount
			})),
		// Whether the Bid being placed is one of the amounts the figure summed.
		// The refusal never NAMES this Auction, but it must still account for
		// it: a sentence naming $5.0M against a stated $11.0M is a breakdown
		// that does not sum, which is the one thing the panel may never be.
		exposureIncludesThisBid: overflowing.some((entry) => entry.isThisAuction)
	};
}

/**
 * Projected Active/Bench Additions — the non-eligible Auctions this Team
 * already leads, plus the Overflow, plus the Bid being placed when it is not
 * one a Minor League Slot can absorb.
 *
 * **One expression, two gates**, the discipline `unfilledSlots` above already
 * sets. `evaluateCap` feeds it to Roster Reserve and `evaluateSlots` compares
 * it to the ceiling; if either recomputed it the two could disagree about the
 * count while agreeing they describe the same roster, which is the defect
 * "reporting a capacity refusal as a cap refusal" (AD-7) arriving from the
 * other direction.
 *
 * **The POST-BID basis is not optional**: PRD FR-12 and the §3 glossary both
 * define Projected Active/Bench Additions as counting the bid being placed,
 * and AD-7 makes evaluating against the pre-bid state the exact ambiguity
 * that flips §10 example 19.
 *
 * **What Story 2.8 changed is that the `+ 1` is now conditional.** FR-37 lets
 * a Team at Roster Count 12 bid on a Minor League Eligible Player a Free
 * Minor League Slot would absorb, because that win adds nothing to
 * Active/Bench — so the Bid being placed adds one only when this Player is
 * NOT eligible (PRD §3). Until 2.8 the term was unconditional and such a Bid
 * was refused on capacity, which `deferred-work.md` logged as a boundary
 * rather than a branch written against figures that did not exist.
 *
 * **`overflowCount` is what keeps that from being a carve-out.** An eligible
 * win with no Free Minor League Slot to land in takes an Active/Bench Slot at
 * full price, so it is counted here exactly as a non-eligible win is — which
 * is §10 example 25's fourth stash being refused on capacity, `12 + 1 = 13`,
 * even though the money is there. There is no automatic Slot Placement to
 * wait for: an overflow with nowhere to land is refused at the Bid.
 *
 * `team.leading` is already the non-eligible leads alone: `teamMoneyStateFor`
 * skips the Auction being bid on and the Auctions another Team leads, and
 * routes the eligible ones into `eligibleLeading` — so the count needs no
 * filtering of its own, and no eligible lead is ever counted twice.
 */
function projectedAdditionsFor(state: BoundBidState): number {
	const { overflowCount } = minorsCountsFor(state);
	return (
		state.team.leading.length + (state.playerIsMinorLeagueEligible ? 0 : 1) + overflowCount
	);
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
 * **Story 2.8 adds Minors Exposure and the unbounded branch.** The exposure
 * term stops being a frozen zero and becomes `minorsExposureFor`'s sum, so
 * an Eligible Leading Bid that overflows finally reaches Committed Bids
 * (§10 example 19). And when this Player is eligible with `Overflow Count`
 * 0, a Free Minor League Slot absorbs the win at a $0 Cap Hit and the
 * offered amount is compared to NOTHING (FR-35, §10 example 18).
 *
 * **Unbounded is not a waiver, and getting that wrong is silent.** PRD §3
 * qualifies it "provided Roster Reserve remains coverable", FR-13 says "only
 * the Roster Reserve check and the ordinary increment rules apply there",
 * and §10 example 18 narrates the check out loud — a reserve of $1,000,000
 * "which its $2,000,000 covers". So `availableCapSpace − rosterReserve ≥ 0`
 * still decides, which is exactly `maximumBid ≥ 0`. Every owned example
 * passes either way except a Team whose reserve is short, which is why the
 * I/O matrix carries that row on purpose.
 *
 * `maximumBid` is still the ordinary subtraction even when unbounded. The
 * flag says the comparison did not run; it does not delete the arithmetic,
 * and the RENDERERS — `capBreakdown` and `gateFigure` — are what print the
 * figure in words instead of as a number.
 *
 * With no Team there is no arithmetic: every figure is `null` and the gate
 * passes, exactly as `evaluateIncrement` nulls its two figures on an opening
 * rather than inventing a high that does not exist. The refusal an unbound
 * Manager actually sees is `unbound_actor`. `unbounded` is `false` and
 * `exposingBids` empty there, because neither is a figure: an absent boolean
 * and a false one are the same false.
 */
function evaluateCap(state: BidState, fantraxPlayerId: string, amount: Money): CapGateOutcome {
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
			maximumBid: null,
			freeMinorLeagueSlots: null,
			eligibleLeadingBids: null,
			overflowCount: null,
			unbounded: false,
			exposingBids: [],
			exposureIncludesThisBid: false
		};
	}

	const bound = boundStateFor(state, team);
	// The ONE counts expression both gates read — `evaluateSlots` calls the
	// identical function, so neither can hold a different `M`, `N` or
	// Overflow Count while describing the same Team.
	const counts = minorsCountsFor(bound);
	// ...and the money expression only this gate calls.
	const { minorsExposure, exposingBids, exposureIncludesThisBid } = minorsExposureFor(
		bound,
		fantraxPlayerId,
		amount
	);

	let committedBids: Money = minorsExposure;
	for (const lead of team.leading) {
		committedBids = addMoney(committedBids, lead.amount);
	}

	const availableCapSpace = subtractMoney(team.capSpace, committedBids);
	const projectedAdditions = projectedAdditionsFor(bound);
	const rosterReserve = multiplyMoney(
		MINIMUM_OPENING_BID,
		unfilledSlots(team.rosterCount, projectedAdditions)
	);
	const maximumBid = subtractMoney(availableCapSpace, rosterReserve);

	// A Free Minor League Slot absorbs this Player at a $0 Cap Hit, so no
	// amount is too large — but the reserve must still be coverable.
	const unbounded = state.playerIsMinorLeagueEligible && counts.overflowCount === 0;

	return {
		passed: unbounded
			? compareMoney(maximumBid, NO_MONEY) >= 0
			: compareMoney(amount, maximumBid) <= 0,
		offered: amount,
		capSpace: team.capSpace,
		committedBids,
		minorsExposure,
		availableCapSpace,
		rosterCount: team.rosterCount,
		projectedAdditions,
		rosterReserve,
		maximumBid,
		freeMinorLeagueSlots: counts.freeMinorLeagueSlots,
		eligibleLeadingBids: counts.eligibleLeadingBids,
		overflowCount: counts.overflowCount,
		unbounded,
		exposingBids,
		exposureIncludesThisBid
	};
}

/**
 * The slots gate: a Bid may not take a Team past Roster Capacity (FR-37).
 *
 * **A second, independent ground — structurally, not by convention.** It
 * takes the `BidState` and NOT the amount, so it cannot read a Bid's size,
 * cannot read a Maximum Bid, and has no way to be quietly folded into the
 * money gate. FR-37's "a Team can fail it with unlimited Cap Space and pass
 * it with none" is then a property of the signature rather than a claim a
 * reviewer has to verify by reading the body.
 *
 *   Roster Count + Projected Active/Bench Additions > 12  →  refused
 *
 * on the same POST-BID basis Roster Reserve uses: `projectedAdditionsFor`
 * counts the Bid being placed, and it is the identical call `evaluateCap`
 * makes, so the two gates cannot disagree about the count while agreeing
 * they describe the same roster. What they do NOT share is the outcome:
 * this returns its own `rosterCount`, its own `projectedAdditions` and its
 * own `ceiling`, because reporting a capacity refusal as a cap refusal is a
 * defect (AD-7) and two rows each stating their own arithmetic cannot be
 * read as one.
 *
 * **"At the ceiling" passes.** A Bid that fills the twelfth hole leaves
 * `12 ≤ 12` and is legal; only one that would take a Team past it is
 * refused. §10 example 23 is that case and §10 example 24 is the other.
 *
 * **No clamp here, deliberately** — `unfilledSlots` keeps its `max(0, …)`
 * so a Commissioner override (Story 7.x) cannot hand a Team extra spending
 * power, and this gate is the other half of that pairing: an overridden Team
 * above the ceiling is REFUSED on capacity rather than rewarded, and the
 * comparison has to see the true count to say so.
 *
 * **Story 2.8 gives it the Overflow term, in COUNTS, and no more.** An
 * eligible win a Free Minor League Slot absorbs adds nothing to
 * Active/Bench, so the Bid being placed no longer adds one unconditionally;
 * an eligible win that OVERFLOWS has to land in an Active/Bench Slot, so
 * `Overflow Count` adds back exactly as many as have nowhere else to go.
 * That is §10 example 25 in both directions — a full Team stashing at
 * `12 + 0`, and the same Team refused at `12 + 1` on the fourth. It reaches
 * all of it through `minorsCountsFor`, which returns three integers and no
 * money, so this gate still cannot see an amount.
 *
 * **No Slot Placement carve-out.** An overflow with nowhere to land is
 * refused at the Bid, not resolved at the close: the close that would place
 * it is Epic 3's, and a gate that assumed it would go well would be
 * authorising a Bid on a promise.
 *
 * With no Team there is no roster: the counts are `null` together and the
 * gate passes, exactly as `evaluateCap` nulls its own. The refusal an
 * unbound Manager actually sees is `unbound_actor`. `ceiling` is stated even
 * then, because `ACTIVE_BENCH_SLOTS` is a league constant and is true of a
 * Team that does not exist.
 */
function evaluateSlots(state: BidState): SlotsGateOutcome {
	const team = state.team;
	if (team === null) {
		return {
			passed: true,
			rosterCount: null,
			projectedAdditions: null,
			ceiling: ACTIVE_BENCH_SLOTS,
			freeMinorLeagueSlots: null,
			eligibleLeadingBids: null,
			overflowCount: null
		};
	}

	const bound = boundStateFor(state, team);
	// The IDENTICAL call `evaluateCap` makes — counts only, no amount.
	const counts = minorsCountsFor(bound);
	const projectedAdditions = projectedAdditionsFor(bound);
	return {
		passed: team.rosterCount + projectedAdditions <= ACTIVE_BENCH_SLOTS,
		rosterCount: team.rosterCount,
		projectedAdditions,
		ceiling: ACTIVE_BENCH_SLOTS,
		freeMinorLeagueSlots: counts.freeMinorLeagueSlots,
		eligibleLeadingBids: counts.eligibleLeadingBids,
		overflowCount: counts.overflowCount
	};
}

/**
 * The expiry gate: an Auction whose Auction Clock has run out takes no
 * further Bid (Story 3.1, FR-13, AD-12).
 *
 * **It derives nothing itself.** The whole comparison is `hasExpired` in
 * `projection/auctions.ts`, beside the fold that owns `closesAt` — so the
 * gate, the transaction and the Auction page all read ONE derivation and
 * cannot disagree about whether a given Auction has run out. There is no
 * second `parseInstant` comparison written inline here, and that absence is
 * the design rather than a coincidence.
 *
 * **Authority is the persisted absolute instant and nothing else.** This
 * function is handed a `BidState` and a `now`; it reads no `OpenAuctions`,
 * no nomination and no contention state. AD-12's "never reads a projection's
 * open flag as authority" is therefore a property of what is in scope. A
 * sweep that has stalled for a month leaves the Auction sitting in the fold
 * looking open, and this gate still refuses — a late close is Story 3.5's
 * problem to record, and nothing may be accepted in the gap it leaves.
 *
 * At the close instant itself the Auction is closed (`now >= closesAt`), and
 * `hasExpired`'s own header states why: 3.5 hands each Auction its own
 * nominal expiry as `now`.
 *
 * `closesAt` `null` passes — no Opening Bid, so no clock — and the `opening`
 * gate is the one that decides such a Bid. An unreadable `now` passes too,
 * so `decide()` still reaches its `TypeError` at `closeInstantFor` rather
 * than converting a shell bug into a Manager-facing refusal.
 *
 * The outcome carries the two instants and no third thing: no amount, no
 * money field and no count. A refusal that quoted a figure would be
 * describing a ground it did not decide on (AD-7).
 */
function evaluateExpiry(state: BidState, now: string): ExpiryGateOutcome {
	return {
		passed: !hasExpired(state.closesAt, now),
		closesAt: state.closesAt,
		evaluatedAt: now
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
 * `now` was declared from Story 2.5 onward against the day a gate would need
 * it, because AD-1 and the epic AC fix the signature at
 * `evaluate(state, command, now)` and changing it later would have moved a
 * signature both runtimes and the read path already depend on. Story 3.1 is
 * that day: `expiry` is the ONE gate that asks what time it is, and it is
 * the only one this parameter is handed to. Nothing here reads a clock — the
 * instant is injected, and the six gates below still decide from committed
 * state alone.
 */
export function evaluate(state: BidState, command: PlaceBid, now: string): PlaceBidGateResults {
	return {
		// First in `PLACE_BID_GATES` and first here, so the declared order and
		// the construction order agree on sight. It is handed `now` and the
		// others are not: expiry is the only time question in the set.
		expiry: evaluateExpiry(state, now),
		opening: evaluateOpening(state, command.amount),
		// Immediately after `opening` here as well as in `PLACE_BID_GATES`, so
		// the declared order and the construction order agree on sight. It is
		// handed the acting Team because "are you already a Contender" is the
		// one question in the set that is about WHO is bidding as well as how
		// much — the same pair `selfBid` reads, for a different rule.
		contention: evaluateContention(state, command.amount, command.teamId),
		selfBid: evaluateSelfBid(state, command.teamId),
		increment: evaluateIncrement(state, command.amount),
		granularity: evaluateGranularity(command.amount),
		// The Auction's own id reaches the money gate because the exposure sum
		// includes the prospective Bid, and AD-5 needs every entry in that
		// sequence to carry the id its tiebreak sorts on. No comparison reads
		// it.
		cap: evaluateCap(state, command.fantraxPlayerId, command.amount),
		// No amount is passed, and that is the whole design: neither gate
		// short-circuits the other and neither can see the other's ground.
		slots: evaluateSlots(state)
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
 * the eight. The other six are decided OUTSIDE the gate set, exactly as
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
 *    nomination fold's answer, and `PLACE_BID_GATES` names no such
 *    question at any size.
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
 * How many Contenders there are, as a fragment a sentence can carry.
 *
 * `projection/auctions.ts`'s `contenderCountSentence` is the finished
 * sentence the Auction page prints; this is the clause a refusal embeds, and
 * it is written here rather than reused from there because the two sit in
 * different grammar and a sentence spliced into the middle of another
 * sentence reads as a defect. The singular is written out for the same reason
 * it is there: "1 Contenders" is what tells a Manager at 4am that nobody
 * proof-read the thing they are being asked to trust.
 */
function contenderPhrase(count: number): string {
	return count === 1 ? 'one Contender in total' : `${String(count)} Contenders in total`;
}

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
		case 'expiry': {
			const outcome = gates.expiry;
			// `closesAt` cannot be null on a refusal — `hasExpired` passes a
			// null clock — but the narrowing is what lets the phrase below be
			// built from a string rather than from a check a reader has to
			// take on trust.
			if (outcome.passed || outcome.closesAt === null) return null;
			// `AUCTION_EXPIRED` verbatim, then the elapsed time. The phrase
			// comes from `relativePhrase`, which answers `at an unknown time`
			// for an instant it cannot read — so the unparseable close needs
			// no second wording, and the sentence stays true either way.
			//
			// It names a CLOCK and an elapsed time and quotes no money figure
			// and no count, which is what keeps it from reading as a cap or a
			// capacity refusal: this Bid was not too large and the roster was
			// not too full, the Auction was simply over.
			return (
				`${AUCTION_EXPIRED} Its Auction Clock ran out ` +
				`${relativePhrase(outcome.closesAt, outcome.evaluatedAt)}, and a Bid at or after the ` +
				'close instant is not accepted however long ago that instant was. You may bid on any ' +
				'Auction that is still running.'
			);
		}
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
		case 'contention': {
			const outcome = gates.contention;
			if (outcome.passed) return null;
			if (outcome.entry === 'already_contending') {
				// The count is stated because it is the fact a Manager reading
				// "you are already in" needs beside it, and because it is the
				// one figure this gate has that is not a threshold.
				return (
					`Your Team is already a Contender in this ${MINIMUM_BID_CONTENTION_LABEL}, and a ` +
					`Team joins once. Your ${formatMoney(outcome.joinAmount)} already stands, alongside ` +
					`${contenderPhrase(outcome.contenderCount)}. Every Contender holds the same amount, ` +
					'so there is nothing further to offer here.'
				);
			}
			if (outcome.entry === 'converts') {
				// Named as deferred, in words, rather than accepted as a raise.
				// Story 2.5 made exactly this trade for the opening at
				// $1,000,000, and for the same reason: the machinery that makes
				// the outcome correct does not exist yet, and half-doing it is
				// worse than saying so.
				return (
					`${describeAmount(outcome.offered)} would convert this ` +
					`${MINIMUM_BID_CONTENTION_LABEL} into Standard Contention, releasing every ` +
					`Contender's commitment, and this Auction cannot do that yet. Joining takes ` +
					`exactly ${formatMoney(outcome.joinAmount)}.`
				);
			}
			return (
				`${describeAmount(outcome.offered)} is neither a join nor a conversion. Joining this ` +
				`${MINIMUM_BID_CONTENTION_LABEL} takes exactly ${formatMoney(outcome.joinAmount)}, and ` +
				`converting it takes at least ${formatMoney(outcome.conversionAmount)} — there is no ` +
				'amount between the two this Auction will take.'
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
			if (
				outcome.passed ||
				outcome.maximumBid === null ||
				outcome.availableCapSpace === null ||
				outcome.rosterReserve === null ||
				outcome.minorsExposure === null
			) {
				return null;
			}
			if (outcome.unbounded) {
				// The ONLY way an unbounded money gate refuses: the offered
				// amount was compared to nothing, and Roster Reserve was not
				// coverable. It quotes no Maximum Bid, because there is no
				// Maximum Bid to quote — PRD §3's "provided Roster Reserve
				// remains coverable" is the whole of what failed.
				const shortfall = subtractMoney(outcome.rosterReserve, outcome.availableCapSpace);
				return (
					'A Free Minor League Slot absorbs this Player at a $0 Cap Hit, so there is no cap ' +
					`limit on what you may offer — but your Available Cap Space of ` +
					`${describeAmount(outcome.availableCapSpace)} does not cover your Roster Reserve of ` +
					`${describeAmount(outcome.rosterReserve)}, and is ${describeAmount(shortfall)} short of it. ` +
					'You may bid again once capital is released or a Slot fills.'
				);
			}
			// EXPERIENCE.md's "the delta in one sentence" — the excess stated
			// as a figure rather than left for a Manager to subtract, because
			// the whole panel exists so nobody has to do arithmetic at 4am.
			// The subtraction is exact and lands on the grid: both operands do.
			const excess = subtractMoney(outcome.offered, outcome.maximumBid);
			const delta =
				`${describeAmount(outcome.offered)} exceeds your Maximum Bid of ` +
				`${describeAmount(outcome.maximumBid)} by ${describeAmount(excess)}.`;
			if (outcome.overflowCount === null || outcome.overflowCount === 0) return delta;
			// §10 example 19: "the message names the $30,000,000 auction as
			// the cause". A Manager refused on money they cannot see spent
			// has no way to check the figure without being told where it went.
			return `${delta} ${exposureClause(outcome)}`;
		}
		case 'slots': {
			const outcome = gates.slots;
			if (
				outcome.passed ||
				outcome.rosterCount === null ||
				outcome.projectedAdditions === null
			) {
				return null;
			}
			// No money anywhere in it, and that is the point: a capacity
			// refusal that quoted a cap figure as its ground would be the
			// defect AD-7 names. The counts are stated, then the sum they
			// make, then the ceiling it passes — nobody has to add at 4am.
			const projected = outcome.rosterCount + outcome.projectedAdditions;
			// §10 example 25's overflow, named in COUNTS alone — there is no
			// amount on this outcome to name it in anything else.
			const overflow =
				outcome.overflowCount === null || outcome.overflowCount === 0
					? ''
					: `Eligible Leading Bids ${String(outcome.eligibleLeadingBids)} against Free ` +
						`Minor League Slots ${String(outcome.freeMinorLeagueSlots)} leaves an Overflow ` +
						`Count of ${String(outcome.overflowCount)}, and an eligible win with no Free ` +
						'Minor League Slot to land in takes an Active/Bench Slot. ';
			return (
				'Your Team has no roster slot for this Player. Roster Count is ' +
				`${String(outcome.rosterCount)} and Projected Active/Bench Additions is ` +
				`${String(outcome.projectedAdditions)}, so winning would put your Team at ` +
				`${String(projected)} against a Roster Capacity of ${String(outcome.ceiling)}. ` +
				overflow +
				'You may bid again once a Slot frees up.'
			);
		}
	}
}

/**
 * The clause a cap refusal adds when Minors Exposure is what spent the money
 * — the counts, and the earlier Auctions holding it, by name and amount.
 *
 * Separate from `gateSentence`'s `cap` case only because that case now has
 * three shapes and one of them is this; it is not a second wording. The names
 * come off `exposingBids`, which `minorsExposureFor` filled from the same
 * sorted sequence the figure was summed over — so the Auction a refusal names
 * is provably one of the Auctions the figure counted.
 *
 * `exposingBids` is legitimately EMPTY while exposure is non-zero: §10
 * example 20's exposure is the Bid's own amount, and naming the Auction a
 * Manager is looking at as the cause of its own refusal explains nothing. The
 * sentence says so in words rather than trailing off.
 *
 * **Three shapes, because the overflow slice has three compositions**, and
 * the third is the one that must not be forgotten. When the slice holds an
 * earlier lead AND this Bid — reachable whenever Overflow Count is two or
 * more, or one where this Bid outbids the lead — naming only the earlier
 * Auction prints amounts that add up to LESS than the figure above them. A
 * Manager checking the exposure by hand would find the arithmetic short with
 * no way to discover why, which is the exact failure the panel exists to
 * prevent. So this Bid is accounted for in words without being named as a
 * cause.
 */
function exposureClause(outcome: CapGateOutcome): string {
	const counts =
		`Eligible Leading Bids ${String(outcome.eligibleLeadingBids)} against Free Minor League ` +
		`Slots ${String(outcome.freeMinorLeagueSlots)} leaves an Overflow Count of ` +
		`${String(outcome.overflowCount)}`;
	const exposure =
		outcome.minorsExposure === null
			? 'Minors Exposure'
			: `Minors Exposure of ${describeAmount(outcome.minorsExposure)}`;
	if (outcome.exposingBids.length === 0) {
		return `${exposure} is held against your Cap Space: ${counts}, which this Bid's own amount fills.`;
	}
	const named = outcome.exposingBids
		.map((bid) => `${bid.playerName} at ${describeAmount(bid.amount)}`)
		.join(', ');
	if (outcome.exposureIncludesThisBid) {
		return (
			`${exposure} is held against your Cap Space: ${counts}, held by your leading Bid on ` +
			`${named} and by this Bid's own amount.`
		);
	}
	return `${exposure} is held against your Cap Space: ${counts}, held by your leading Bid on ${named}.`;
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
 * code (`EXPERIENCE.md`). The `detail` rows are commentary rather than
 * ledger lines, so they name an arithmetic step instead of a glossary term —
 * "of which Minors Exposure" and the `N`/`M`/Overflow counts behind it, the
 * multiplication behind Roster Reserve, and — only when it is true — why
 * there is no cap limit at all.
 *
 * **Labels must stay unique.** `CapBreakdown.svelte` keys its `{#each}` on
 * `label`, so two rows sharing one would collapse into a single rendered
 * line and the column would silently stop summing.
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
		outcome.projectedAdditions === null ||
		outcome.freeMinorLeagueSlots === null ||
		outcome.eligibleLeadingBids === null ||
		outcome.overflowCount === null
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
			// subtraction. Story 2.6 put the row here because FR-13 requires
			// the refusal to show the term and a breakdown missing one of its
			// components would not sum; Story 2.8 is what finally gives it a
			// non-zero value.
			label: 'of which Minors Exposure',
			figure: describeAmount(outcome.minorsExposure),
			operator: '',
			kind: 'detail'
		},
		{
			// The three counts the figure above came from, in the shape the
			// Roster Reserve row already uses — the arithmetic as the label,
			// the term it produces as the figure. A Manager checking the
			// exposure by hand needs `N` and `M`, or the sum is a number they
			// have to take on trust.
			label:
				`Eligible Leading Bids ${String(outcome.eligibleLeadingBids)} of ` +
				`${String(outcome.freeMinorLeagueSlots)} Free Minor League Slots`,
			figure: `Overflow Count ${String(outcome.overflowCount)}`,
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
			// **In words when it is unbounded, never as a number** (FR-35,
			// EXPERIENCE.md: "rendered in words per CAP-4 ... a stated
			// outcome, not a large number"). The subtraction still ran and is
			// still on the outcome — it is what decides whether Roster
			// Reserve is coverable — but printing it here would tell a
			// Manager they may bid $1.0M on a Player they may bid anything on.
			figure: outcome.unbounded ? 'no cap limit' : describeAmount(outcome.maximumBid),
			operator: '',
			kind: 'subtotal'
		},
		// ...and the breakdown says WHY, which is the half EXPERIENCE.md asks
		// for by name. Present only when it is true: a row explaining an
		// absent outcome would be commentary on nothing.
		...(outcome.unbounded
			? [
					{
						label: 'Why there is no cap limit',
						figure:
							'A Free Minor League Slot absorbs this Player at a $0 Cap Hit, so no amount ' +
							'is too large — but Roster Reserve must still be covered.',
						operator: '',
						kind: 'detail' as const
					}
				]
			: [])
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
		case 'expiry': {
			const outcome = gates.expiry;
			if (outcome.closesAt === null) return 'no Bids yet, so no Auction Clock';
			// **Keyed on READABILITY, never on the verdict.** `hasExpired`
			// fails CLOSED on a close instant it cannot read — an Auction
			// whose close cannot be read reads as already due — while
			// `closesInPhrase` answers `an unknown time left` for that same
			// input. Printing that phrase beside a `Refused` chip would put
			// "time may still remain" next to a verdict saying it does not,
			// on the one surface in the product that may never contradict
			// itself. So an unreadable instant gets its own figure, stating
			// the fact the chip was actually decided from.
			//
			// This is the only `parseInstant` in this module, and it is a
			// RENDERING test rather than a second expiry comparison: the
			// close instant is never compared to `now` here, and
			// `evaluateExpiry` still reaches its answer through `hasExpired`
			// alone.
			if (parseInstant(outcome.closesAt) === null) return 'the close time cannot be read';
			// For every clock that IS readable, ONE branch serves passed and
			// refused alike, which is the `slots` figure's discipline: the row
			// states the arithmetic and the chip beside it states the outcome,
			// so a second branch would be a second place for the two to
			// disagree. `closesInPhrase` answers `no time left` once a clock
			// has run out, which agrees with a `Refused` chip exactly.
			return closesInPhrase(outcome.closesAt, outcome.evaluatedAt);
		}
		case 'opening': {
			const outcome = gates.opening;
			switch (outcome.opening) {
				case 'not_an_opening':
					return 'a Bid already leads, so no opening minimum applies';
				case 'above_the_minimum':
					return `above the ${formatMoney(outcome.minimumOpening)} minimum`;
				case 'at_the_minimum':
					return `exactly ${formatMoney(outcome.minimumOpening)}, which opens a contention`;
				// (unchanged wording, and it is now a PASSING row: the figure
				// states what the amount is, and the chip beside it states the
				// outcome — the one-branch discipline `slots` already keeps.)
				case 'below_the_minimum':
					return `under the ${formatMoney(outcome.minimumOpening)} minimum`;
			}
			break;
		}
		case 'contention': {
			const outcome = gates.contention;
			switch (outcome.entry) {
				case 'not_a_contention':
					return 'no Minimum-Bid Contention is running';
				case 'joins':
					// The count is the one BEFORE this Bid, because that is what
					// the gate was decided against — a row claiming the Bid had
					// already landed would be a figure nothing was judged from.
					return `joins at ${formatMoney(outcome.joinAmount)}, ${contenderPhrase(
						outcome.contenderCount
					)} so far`;
				case 'already_contending':
					return `your Team is already a Contender, ${contenderPhrase(outcome.contenderCount)}`;
				case 'converts':
					return (
						`at or above ${formatMoney(outcome.conversionAmount)}, which would convert the ` +
						'contention'
					);
				case 'neither':
					return (
						`between ${formatMoney(outcome.joinAmount)} and ` +
						`${formatMoney(outcome.conversionAmount)}, which is neither a join nor a conversion`
					);
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
			// **In words, never a number** (FR-35, EXPERIENCE.md): an
			// unbounded Maximum Bid is a stated outcome, not a large figure.
			// Printing the underlying subtraction here would tell a Manager
			// they may bid $1.0M on a Player they may bid anything on.
			if (outcome.unbounded) return 'no cap limit — a Free Minor League Slot absorbs this Player';
			const figure =
				`Maximum Bid ${describeAmount(outcome.maximumBid)}, offered ` +
				`${describeAmount(outcome.offered)}`;
			if (outcome.overflowCount === null || outcome.overflowCount === 0) return figure;
			return `${figure}, Overflow Count ${String(outcome.overflowCount)}`;
		}
		case 'slots': {
			const outcome = gates.slots;
			if (outcome.rosterCount === null || outcome.projectedAdditions === null) {
				return 'no Team, so no Roster Count';
			}
			// `EXPERIENCE.md`'s shape verbatim — `Roster Count would be 10 of
			// 12` — and ONE branch serving passed and refused alike, because
			// the row states the arithmetic and the chip beside it states the
			// outcome. A second branch would be a second place for the two to
			// disagree.
			const projected = outcome.rosterCount + outcome.projectedAdditions;
			const figure = `Roster Count would be ${String(projected)} of ${String(outcome.ceiling)}`;
			// Counts only — this outcome carries no amount to name it in
			// anything else, which is exactly the design (FR-37).
			if (outcome.overflowCount === null || outcome.overflowCount === 0) return figure;
			return `${figure}, Overflow Count ${String(outcome.overflowCount)}`;
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
	// The glossary term, so the chip reads `Auction Clock · Refused` and
	// cannot be mistaken for `Cap · Refused` or `Slots · Refused`.
	expiry: 'Auction Clock',
	opening: 'Opening Bid',
	// The glossary term verbatim, from the fold that owns the wording — so the
	// chip, the accent bar's label on the Auction page and the sentence a
	// refusal states all name ONE thing, and the row cannot be mistaken for
	// `Opening Bid · Refused` beside it.
	contention: MINIMUM_BID_CONTENTION_LABEL,
	selfBid: 'Self-bid',
	increment: 'Minimum Increment',
	granularity: 'Granularity',
	cap: 'Cap',
	slots: 'Slots'
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
 * **Built by iterating the declared list**, which is how Story 2.7's `slots`
 * gate reached this panel: adding it to `PLACE_BID_GATES` was the whole
 * change, and no component or route was edited to make the sixth row appear.
 * That is what makes "both gates always reported" a structural property of
 * the panel rather than a thing a component has to be trusted to do — and it
 * is why each row carries its OWN figure: reporting a capacity refusal as a
 * cap refusal is a defect (AD-7), and two rows each stating their own
 * arithmetic cannot be read as one.
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
	/**
	 * `hash(seed)` — the COMMIT half of AD-14's commit-reveal, present on
	 * exactly one Bid per Minimum-Bid Contention: the one that opened it.
	 *
	 * Optional rather than nullable, because the overwhelming majority of
	 * `BidPlaced` events have no seed to commit to and a `"seedHash": null`
	 * on every one of them would be a field claiming an absence rather than
	 * simply not being there. `auctionsReducer` reads it defensively either
	 * way.
	 *
	 * **The raw seed is never here**, and this is the only thing derived from
	 * it that ever reaches `auction_events`. The seed itself lands in
	 * `auction_contention_seeds`, in the same transaction, behind a table that
	 * grants no Postgres role anything — and reaches the log only at the draw
	 * (Story 3.6), where the reveal is checked against this string.
	 */
	readonly seedHash?: string;
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
 * **`seed` is read since Story 3.2**, through the fourth parameter AD-1 fixed
 * and 2.5 shipped declared-and-`void`ed. Nothing here generates it — the core
 * reads no randomness (AD-2) — and nothing here stores it: the ONE thing done
 * with it is `hash(seed)` onto the payload of the Bid that OPENS a
 * Minimum-Bid Contention. The raw string never appears in an event, and the
 * shell writes it to `auction_contention_seeds` in the same transaction by
 * reading the `seedHash` this function published, never by re-deriving the
 * rule.
 *
 * **A `null` seed on such an opening THROWS**, and that is AD-1's distinction
 * rather than strictness for its own sake: a shell that failed to supply a
 * seed is a bug, not something a Manager did, and a Manager-facing refusal
 * would send them away to fix something that is not theirs. Every other Bid
 * ignores the parameter entirely, so a caller with genuinely no randomness in
 * hand — a test of a raise, say — passes `null` and is unaffected.
 *
 * **The close instant is the contention's own on a join.** A join stamps
 * `state.closesAt` verbatim; an opening or a raise computes a fresh
 * `closeInstantFor(now, AUCTION_CLOCK)`. See the fixed-clock note below.
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
	const gates = evaluate(state, command, now);

	if (!allGatesPassed(gates)) {
		const rejected: Rejected<PlaceBidGateResults> = { kind: 'rejected', gates };
		return rejected;
	}

	// **The fixed clock is enforced HERE, and this is the rule.**
	// `auctionsReducer` also keeps `closesAt` on a join, because a join is
	// never strictly higher than the leading Bid and so never becomes
	// `leadingBid` — but that is true by way of an unrelated invariant, and if
	// a later story ever makes joins visible in the lead the clock would
	// silently start moving. Stamping the contention's EXISTING close instant
	// onto the join's own payload makes the persisted log honest on its own
	// terms: every `BidPlaced` in a contention states the same close instant,
	// and Story 3.5's sweep — which reads persisted instants and nothing else
	// (AD-12) — cannot be handed a join claiming to close 24 hours after
	// itself.
	//
	// An opening or a raise computes a fresh one, which is the 24-hour restart
	// `BID_CONSEQUENCE` promises.
	const closesAt =
		gates.contention.entry === 'joins'
			? state.closesAt
			: closeInstantFor(now, AUCTION_CLOCK);
	if (closesAt === null) {
		// Two unreachable-together causes, one message: an unreadable `now`,
		// or a join into a contention with no persisted close. The second
		// cannot arise — `contention` reads `minimum_bid` only off a folded
		// Auction, and an Auction that exists has a close — and both are shell
		// bugs rather than anything a Manager did (AD-1).
		throw new TypeError(
			`decide: "now" must be an ISO-8601 UTC instant, received ${JSON.stringify(now)}`
		);
	}

	// Does this Bid OPEN a Minimum-Bid Contention? Asked through the same
	// `contentionForAmount` the reducer folds with, so the published
	// commitment and the contention state the fold arrives at are one
	// judgement rather than two that must agree. `leadingBid === null` is the
	// opening half; the `contention` gate cannot answer this, because it
	// reports on the contention already running rather than the one about to
	// start.
	const opensContention =
		state.leadingBid === null && contentionForAmount(command.amount) === 'minimum_bid';
	if (opensContention && seed === null) {
		throw new TypeError(
			'decide: an Opening Bid that opens a Minimum-Bid Contention requires a seed; the ' +
				'shell must supply one (AD-14)'
		);
	}

	const payload: BidPlacedPayload = {
		fantraxPlayerId: command.fantraxPlayerId,
		teamId: command.teamId,
		teamName: command.teamName,
		managerId: command.managerId,
		amount: command.amount,
		closesAt,
		// `hash(seed)` and never the seed. Spread rather than set to `null`,
		// so the overwhelming majority of Bids carry no such key at all.
		...(opensContention && seed !== null ? { seedHash: hash(seed) } : {})
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
