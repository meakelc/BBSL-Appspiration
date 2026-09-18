/**
 * The bidding gate: the two entry points AD-1 fixes, the eight gates they
 * decide through, the one sentence each refusal has, and the arithmetic the
 * refusal panel prints. Pure (Stories 2.5, 2.6, 2.7, 3.1, 3.2, 3.3).
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
 * and the conversion that dissolves the whole thing are one classification of
 * one amount, so they are one gate rather than four. It
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
 * **`slots` is the second, independent ground** (Story 2.7, FR-37, widened
 * by Story 10.1): it passes when Projected Active/Bench Additions is zero,
 * or when the Team holds a Free Active/Bench Slot and its projected
 * additions are within that free count plus the Outstanding Bid Allowance.
 * That comparison lives in `evaluateSlots` below, and it reads NO amount and NO Maximum Bid — so a Team can fail it with
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
 * **A Minimum-Bid Contention is both created and dissolved here.** An Opening
 * Bid of exactly `MINIMUM_BID` PASSES the `opening` gate and opens one;
 * `decide()` publishes `hash(seed)` on that Bid's payload and the shell seals
 * the seed in a table no role can read (AD-14). A Bid of $1,500,000 or more
 * into a live contention PASSES `contention` since Story 3.3 and dissolves it
 * — the refusal by name that 2.5 gave `at_the_minimum` and 3.2 gave the
 * conversion has now run out of stories to move to.
 *
 * **Dissolution is one written rule and three facts.** The written rule is the
 * reveal: `decide()` emits `ContentionDissolved` beside the converting
 * `BidPlaced`, carrying the sealed seed — and it VERIFIES before it reveals,
 * throwing unless `hash(seed)` equals the `seedHash` the log already
 * published, because a reveal contradicting the published commitment is the
 * one outcome AD-14 cannot survive. The three facts are consequences of
 * arithmetic that already existed: every Contender's capital releases because
 * `teamMoneyStateFor` tests the contention STATE and the fold reads
 * `standard` off the new leading amount; the Auction Clock restarts because a
 * dissolution is not a join, so the existing branch below computes a fresh
 * `closeInstantFor`; and the converting Team leads because its amount is
 * strictly higher. None of the three cost this module a line.
 *
 * **`selfBid` steps aside inside a lottery, for `increment`'s reason.** A
 * Minimum-Bid Contention has no Leading Bidder at all — the fold names one
 * because some Bid has to be highest — so there is nobody to be bidding
 * against, and FR-19's "a Team that was a Contender may itself be the
 * converting bidder" would otherwise be false for the one Team whose money
 * opened the lottery.
 *
 * **`seed` is read by `decide()` since Story 3.2, and is a `ContentionSeed`
 * union since 3.3**, through the fourth parameter AD-1 fixed and 2.5 shipped
 * declared-and-unused. It is never generated here — the core reads no
 * randomness (AD-2), so the shell makes it, or reads the sealed one under the
 * lock, and passes it in — and never stored here. Two things are done with
 * it, and `kind` decides which: a `fresh` seed is hashed onto the opening
 * Bid's payload, and a `sealed` one is verified and then REVEALED on
 * `ContentionDissolved`, which is the only path by which a seed ever enters
 * `auction_events`. Both go through `core/hash.ts`'s pure SHA-256, so that
 * Node, Deno and a Manager with `sha256sum` all compute the same commitment.
 *
 * **The fixed clock is `decide()`'s, not the fold's.** A join's `BidPlaced`
 * payload carries the contention's EXISTING `closesAt` verbatim; a fresh
 * `closeInstantFor(now, AUCTION_CLOCK)` is computed for everything that is
 * not a join — an opening, a raise, and a dissolution, which is where FR-19's
 * 24-hour reset comes from. That the fold also preserves the clock — a join
 * is never strictly higher, so it never becomes `leadingBid` — is a second
 * guarantee resting on an unrelated invariant, and a persisted payload
 * claiming a join closes 24 hours from itself is a lie Story 3.5's sweep
 * would act on.
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
	MINOR_LEAGUE_SLOTS,
	OUTSTANDING_BID_ALLOWANCE,
	SALARY_CAP
} from '../constants.ts';
import { hash } from '../hash.ts';
import { parseInstant, relativePhrase } from '../instant.ts';
import type { Auction, ContentionState, OpenAuctions } from '../projection/auctions.ts';
import {
	AUCTION_EXPIRED,
	BID_PLACED_EVENT,
	CONTENTION_DISSOLVED_EVENT,
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
import type { LeaguePhase } from '../projection/phase.ts';
import { PLACE_BID_GATES, RESTORE_LEADING_BID_GATES } from '../types.ts';
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
	PhaseGateOutcome,
	PlaceBid,
	PlaceBidGate,
	PlaceBidGateResults,
	Rejected,
	RestoreLeadingBid,
	RestoreLeadingBidGateResults,
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
	/**
	 * The folded League phase (Story 3.7) — `phaseReducer` over the whole log,
	 * never a route, never a destination list and never a flag.
	 *
	 * It is the ONE input to the ninth gate, and it is first on this shape as
	 * it is first in `PLACE_BID_GATES`: outside the Auction Phase there is no
	 * auction for any of the fields below to be about.
	 *
	 * "Bidding is disabled league-wide" is stated HERE, in the core, rather
	 * than left to fall out of `server/destinations.ts` refusing the route. The
	 * catalog would 403 a browser and the core would still accept a Bid handed
	 * to it directly; AD-1 fixes the gate set per command type precisely so a
	 * rule like this is one edit that makes every consumer a compile error.
	 */
	readonly phase: LeaguePhase;
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
	 * The published `hash(seed)` for this Auction's contention, as
	 * `auctionsReducer` folded it off the opening Bid's payload — `null` for
	 * every Auction that never opened one, and `null` for one whose opening
	 * event carried a malformed commitment.
	 *
	 * **Story 3.3's addition, and it is here so `decide()` can verify before
	 * it reveals.** A dissolution publishes the sealed seed; between the
	 * shell's read of it and the core's publication of it sits the only
	 * failure AD-14 cannot survive, which is a reveal that does not match the
	 * commitment a Manager already checked. `decide()` hashes what it was
	 * handed and compares it against THIS value before building the payload,
	 * so the mismatch is foreclosed structurally rather than tested for.
	 *
	 * It is a PUBLIC value — already serialised to the Auction page and
	 * already printed on it — so carrying it on the state both the transaction
	 * and the surface build costs nothing in secrecy. The raw seed never
	 * appears on this shape and never could: it reaches `decide()` as an
	 * argument, exactly as `now` does.
	 *
	 * No gate reads it. It is an input to the EVENT, not to a rule, which is
	 * why nothing in `PLACE_BID_GATES` grew for it.
	 */
	readonly seedHash: string | null;
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
 *
 * **`isContentionEntry` is carried because a NAME and an AMOUNT were not
 * enough to recover it** (Story 10.2, FR-18 as amended 2026-09-08). A
 * Minimum-Bid Contention entry is held at exactly `MINIMUM_OPENING_BID`, and
 * so is an ordinary Opening Bid nobody has raised — two facts this shape
 * would otherwise render identically, and only one of them is exempt from
 * Roster Capacity. Re-deriving it downstream would mean re-reading the
 * Auction fold outside the one loop that already walked it, which is a
 * second answer to a question `teamMoneyStateFor` has already asked. It is a
 * CLASSIFICATION rather than a magnitude, which is what keeps the capacity
 * gate structurally unable to see a price while still telling a lottery
 * entry apart from a commitment.
 */
export type LeadingBidElsewhere = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly amount: Money;
	/**
	 * Whether this is a Minimum-Bid Contention entry rather than a lead the
	 * Team holds alone. Set from the SAME `contends` test that put it in the
	 * list; never re-derived from `amount`.
	 */
	readonly isContentionEntry: boolean;
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
 *
 * **Story 3.7 is the first since 2.8 to change the signature, and it had to
 * be.** The phase is a fact about the LEAGUE, not about this Auction, so
 * unlike `closesAt`, the contention state and the Contender list it is not
 * already on the `Auction` this function receives — there is nowhere for it
 * to come from but a fourth argument. It is required rather than defaulted,
 * for `playerIsMinorLeagueEligible`'s reason: adding it made every caller a
 * compile error, which is how a fact that changes what a gate decides is
 * supposed to arrive. A default of `'Auction'` would have let a caller
 * silently keep the pre-3.7 behaviour — which is bidding after the phase
 * ended.
 */
export function bidStateFor(
	auction: Auction | null,
	team: TeamMoneyState | null,
	playerIsMinorLeagueEligible: boolean,
	phase: LeaguePhase
): BidState {
	if (auction === null) {
		return {
			phase,
			leadingBid: null,
			closesAt: null,
			contention: 'awaiting_opening_bid',
			// No Auction, so no opening Bid, so no commitment to publish.
			seedHash: null,
			contenders: [],
			team,
			playerIsMinorLeagueEligible
		};
	}
	return {
		phase,
		// **Nullable since Story 10.3, and the `null` reads as the state
		// `bidStateFor` already models.** FR-40 can leave an Auction leaderless
		// — every Bid on it cancelled, or the leader cancelled and no
		// restoration recorded yet — while its history stands. That is the same
		// "there is nobody to bid against" the `auction === null` branch above
		// returns, so `selfBid` steps aside, `increment` reports that no rule
		// applies, and the pre-fill falls back to the opening minimum. Not one
		// gate needed a branch of its own: `BidState.leadingBid` has been
		// nullable since Story 2.5 for the no-Auction case.
		leadingBid:
			auction.leadingBid === null
				? null
				: { teamId: auction.leadingBid.teamId, amount: auction.leadingBid.amount },
		closesAt: auction.closesAt,
		contention: auction.contention,
		// The published commitment, straight off the fold — never re-derived
		// and never hashed here. `decide()` is the one caller, and it compares
		// rather than computes.
		seedHash: auction.seedHash,
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
		// Minimum-Bid Contention any Contender can. `contenders` is folded from
		// every Bid at `MINIMUM_BID` the log holds and is NOT cleared when a
		// contention ends, so the contention state is TESTED here rather than
		// inferred from the list being empty. A dissolved contention (3.3)
		// keeps its Contenders — the draw and the reveal are derived from them
		// — while committing nobody, and this is the line that makes that safe.
		//
		// **Split by contention since Story 10.3, and only so the amount can
		// be narrowed without an assertion.** `Auction.leadingBid` is nullable
		// now — FR-40 leaves a leaderless Auction behind — and the two branches
		// answer the two halves of the same test the one expression used to:
		// inside a lottery the commitment is the flat `MINIMUM_OPENING_BID`
		// every Contender holds, and a null leader there does not release
		// anybody; outside one the commitment IS the leading amount, so a Team
		// leads or it has no commitment at all. A leaderless Standard Auction
		// therefore commits nobody, which is precisely the capital release
		// FR-40 requires and never writes.
		const leader = auction.leadingBid;
		const contends =
			auction.contention === 'minimum_bid' &&
			auction.contenders.some((contender) => contender.teamId === input.teamId);
		const leads = leader !== null && leader.teamId === input.teamId;
		let amount: Money;
		if (auction.contention === 'minimum_bid') {
			if (!leads && !contends) continue;
			amount = MINIMUM_OPENING_BID;
		} else {
			if (leader === null || leader.teamId !== input.teamId) continue;
			amount = leader.amount;
		}
		const entry: LeadingBidElsewhere = {
			fantraxPlayerId: playerId,
			playerName: input.playerNameFor(playerId),
			amount,
			// Story 10.2: the SAME `contends` above, recorded rather than asked
			// again. `contends` is already `contention === 'minimum_bid'` AND
			// this Team on the Contender list, which is exactly FR-18's "is this
			// a lottery entry" — so the slots side gets the classification for
			// free, and no downstream caller has to compare an amount to
			// `MINIMUM_OPENING_BID` and guess. An Opening Bid of $1,000,000 on a
			// Standard Contention is `false` here, which is the whole point.
			isContentionEntry: contends
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
 * **Inside a live contention the figure depends on who is asking, and that is
 * Story 3.3's change.** A lottery takes exactly two amounts, and which of
 * them is legal for a given Team is a fact about that Team: one not yet on
 * the Contender list can JOIN at `MINIMUM_BID`, and one already on it cannot
 * — a second join is `already_contending` — but can DISSOLVE the contention
 * at `CONVERSION_AMOUNT`. So the acting Team id is a parameter, sourced at
 * the one production call site from the `viewerTeamId` the read path already
 * holds. `null` — a viewer bound to no Team — is not on any list, so it reads
 * the join amount; their control is refused as `unbound_actor` regardless,
 * and the field states the amount the contention actually takes.
 *
 * **The state with no legal amount at all is gone, and that is what 3.3
 * reopened.** Until dissolution existed, a Team already contending was
 * refused at `$1,000,000` on `already_contending` and at everything above it
 * on `converts`, so no figure passed every gate for them; the pre-fill was
 * the join amount beside a disabled control. `converts` passes now, so the
 * general invariant — every state's pre-fill passes every gate — holds again
 * without an exception carved out of it.
 */
export function minimumLegalBid(state: BidState, actingTeamId: string | null): Money {
	if (state.contention === 'minimum_bid') {
		// Already in: joining again is refused by name, and the only amount
		// left to them is the one that dissolves the contention.
		return actingTeamId !== null && state.contenders.includes(actingTeamId)
			? CONVERSION_AMOUNT
			: MINIMUM_OPENING_BID;
	}
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
	const written = FIELD_TEXT.exec(text.trim());
	if (written === null) return { kind: 'unusable', refusal: { kind: 'unusable_amount' } };

	const [, sign, millions, fraction = ''] = written;
	if (millions === undefined) return { kind: 'unusable', refusal: { kind: 'unusable_amount' } };

	// More than six decimal places is a fraction of one dollar, and there is
	// no such thing here: integer dollars end to end (AD-8).
	if (fraction.length > MILLION_DECIMALS) {
		return { kind: 'unusable', refusal: { kind: 'unusable_amount' } };
	}

	let amount: Money;
	try {
		amount = parseMoney(toDollarDigits(millions, fraction));
	} catch {
		return { kind: 'unusable', refusal: { kind: 'unusable_amount' } };
	}

	// The sign is read before the unit: a minus is never a unit mistake, and
	// it keeps its own sentence for the reason given above.
	if (sign === '-' && amount > 0) return { kind: 'unusable', refusal: { kind: 'negative_amount' } };

	if (Number(millions) > MOST_MILLIONS) {
		return { kind: 'unusable', refusal: { kind: 'dollars_not_millions' } };
	}
	return { kind: 'usable', amount };
}

/**
 * Exactly what the bid field's language allows: an optional sign, an optional
 * currency symbol, a canonical run of digits, an optional decimal part, and an
 * optional `m`.
 *
 * The digits are a figure in MILLIONS — `10.5` is $10,500,000 — because that
 * is what the field beside them now reads as, `$10.5m`. Leading zeros are
 * refused here as they are in `money.ts`: `007.5` is not a figure a person
 * means, and accepting it would mean the zeros carry no information.
 *
 * The `$` and the `m` are the field's own adornments and a Manager never types
 * either. They are accepted anyway because the figure they frame is the one
 * this product prints everywhere else — `$10.5M` in a Discord broadcast, in
 * the Bid history, on the board — and a figure pasted out of one of those into
 * the field should be the figure the field then holds.
 */
const FIELD_TEXT = /^(-?)\$?(0|[1-9][0-9]*)(?:\.([0-9]+))?[mM]?$/;

/** Dollars in one million. The unit the bid field is denominated in. */
const DOLLARS_PER_MILLION = 1_000_000;

/** Decimal places of one million that one whole dollar occupies. */
const MILLION_DECIMALS = 6;

/**
 * The largest figure the field's language can express — the whole Salary Cap,
 * `165`, as a count of millions.
 *
 * **This is a unit check and not the Cap rule.** The Cap is a gate's question
 * and it stays one; what this bounds is the LANGUAGE. The field used to take
 * whole dollars, so `10500000` is what a Manager's hands will type into it out
 * of habit for some time yet, and read as millions that is $10.5 trillion — a
 * figure no gate can word usefully, because every sentence it could produce
 * would be about a Cap breach rather than about the mistake that was actually
 * made. Nothing above the Cap can ever be a legal Bid, so refusing it HERE
 * costs no legal figure and lets the refusal name the unit instead.
 */
const MOST_MILLIONS = SALARY_CAP / DOLLARS_PER_MILLION;

/**
 * Compose the canonical integer-dollar text `parseMoney` takes from a figure
 * written in millions: `10` and `5` become `10500000`.
 *
 * **By text, never by multiplication.** `10.5 * 1_000_000` happens to be exact,
 * but `0.1 * 1_000_000` is `100000.00000000001`, and a field that takes one
 * decimal place would produce an amount off by a dollar at some figures and
 * not at others. Padding the decimal part out to six digits and concatenating
 * is exact at every figure, and it is the same reason `money.ts` renders by
 * remainder and exact division rather than with a float (AD-8: integer dollars
 * end to end, no float, no decimal library).
 *
 * The leading zeros a small figure picks up are stripped rather than left for
 * `parseMoney` to refuse: `0` and `5` compose `0500000`, whose value is
 * $500,000 and whose spelling is one `money.ts` rejects as non-canonical.
 */
function toDollarDigits(millions: string, fraction: string): string {
	const digits = millions + fraction.padEnd(MILLION_DECIMALS, '0');
	return digits.replace(/^0+(?=[0-9])/, '');
}

/**
 * Write an amount the way the bid field holds it: `$10.5m` is `10.5`, and
 * `$1.0M` is `1`.
 *
 * The inverse of `readBidAmount`, and the pair is the point — every string
 * this returns is one that parser reads back as the same amount, so the field
 * can never be seeded with a figure it would then refuse.
 *
 * **The trailing `.0` is dropped, and this is the one place in the product
 * that drops it.** `formatMoney` renders `$1.0M` and must keep doing so: it is
 * a RENDERING, one figure among many in a column of them, and a column where
 * some rows have a decimal and others do not is a column that reads as
 * ragged. This is not a rendering — it is editable text, and the next thing
 * that happens to it is a Manager typing into it. Seeding `1.0` would put the
 * caret after a decimal place nobody asked for and make `12` take a deletion
 * to reach.
 *
 * The `$` and the `m` are not here, because they are not part of the value:
 * the field wears them as fixed adornments beside the text, so they cannot be
 * deleted, retyped, or accidentally submitted as part of the figure.
 */
export function bidAmountField(amount: Money): string {
	const negative = amount < 0;
	const digits = String(negative ? -amount : amount).padStart(MILLION_DECIMALS + 1, '0');
	const whole = digits.slice(0, digits.length - MILLION_DECIMALS);
	const fraction = digits.slice(digits.length - MILLION_DECIMALS).replace(/0+$/, '');
	return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
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
 *  - at or above the conversion amount → `converts`, PASSES since Story 3.3:
 *    this Bid dissolves the contention. Until then it was refused by name,
 *    because accepting it as an ordinary raise would have produced most of
 *    dissolution for free — the fold going `standard`, the clock resetting,
 *    every Contender's commitment quietly releasing because
 *    `teamMoneyStateFor` stops seeing them — while leaving the seed sealed
 *    forever, which is precisely what AD-14's "no unopened commitment is left
 *    behind" forbids. `decide()` appends `ContentionDissolved` beside the
 *    converting `BidPlaced` and reveals the seed against the published
 *    commitment, so nothing is left behind and the verdict could move.
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
	// The comparison is UNCHANGED from Story 3.2 and only the verdict moved,
	// which is what makes dissolution a one-line edit here rather than a
	// rewrite. `decide()` asks this gate whether a Bid dissolves a contention
	// rather than re-deriving the comparison, so there is one judgement.
	if (compareMoney(amount, CONVERSION_AMOUNT) >= 0) {
		return { ...base, passed: true, entry: 'converts', contenderCount };
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
 *
 * **It steps aside inside a Minimum-Bid Contention, exactly as
 * `evaluateIncrement` already does, and for the identical reason: a lottery
 * has no Leading Bidder at all.** `auctionsReducer` reports one because some
 * Bid has to be the highest and a join is never strictly higher than the
 * `$1,000,000` already there — so `leadingBid` in a contention is a fold
 * artifact rather than a Team holding the Auction against the field. Reading
 * it as one would freeze exactly one Team out of dissolving: the Team whose
 * money opened the lottery, which is Contender #1 and unavoidably the fold's
 * leader, and which FR-19's own scenario ("a Team that was a Contender may
 * itself be the converting bidder") is about.
 *
 * `leadingTeamId` is therefore reported as `null` there rather than as the
 * opener's id, which is the honest report and not a convenience: the field's
 * meaning is "the Team you would be bidding against", and in a lottery there
 * is none. `evaluateIncrement` nulls `currentHigh` on the same grounds.
 *
 * The consequence is deliberate and visible: the opener re-bidding
 * `$1,000,000` is now refused on `already_contending` ALONE, where Story 3.2
 * refused it on `selfBid` as well. That is not a suppressed ground — it is a
 * ground that was never true, reported because the gate could not yet see it.
 */
function evaluateSelfBid(state: BidState, actingTeamId: string): SelfBidGateOutcome {
	const leadingTeamId =
		state.contention === 'minimum_bid' ? null : (state.leadingBid?.teamId ?? null);
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
 * **The clamp is now REACHABLE IN ORDINARY PLAY**, which it was not before
 * Story 10.1. The Outstanding Bid Allowance (FR-37, amended 2026-09-08) lets
 * a Team hold one outstanding Bid beyond its free Slots, so §10 example 29
 * evaluates `max(0, 12 − 13)` with no Commissioner override anywhere near
 * it. A Commissioner override (Story 7.x) can still put a Team above 12 as
 * well, and the clamp answers both: an unclamped count would go negative and
 * hand that Team extra spending power.
 *
 * **`unfilledSlots(rosterCount, 0)` IS Free Active/Bench Slots** — the same
 * clamped subtraction evaluated with no additions — and `evaluateSlots`
 * reads its `F` from exactly that call rather than writing a second one. The
 * clamp is what stops a Team overridden to Roster Count 13 from computing a
 * negative `F`, an allowance of 0, and passing the precondition by
 * arithmetic accident.
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
 * **This is the MONEY side, and since Story 10.2 that is a restriction
 * rather than a description.** `Overflow Count` INCLUDES Minimum-Bid
 * Contention entries, because a Contender who wins costs real money and the
 * cap must carry that exposure however unlikely each win is (PRD §3,
 * FR-18). It is therefore NOT the figure Roster Capacity may read: FR-18
 * exempts entries from Roster Capacity but not from the cap, so the slots
 * side calls `activeBenchOverflowFor` below instead. `evaluateCap` is the
 * only gate that calls this one, and calling it from the slots path — which
 * an earlier revision did, deliberately, with a comment saying the two
 * counts could not disagree — is now the defect.
 *
 * **It deliberately cannot see a dollar.** `evaluateCap` and
 * `activeBenchOverflowFor` both call it; only `evaluateCap` goes on to call
 * `minorsExposureFor` for the money. Splitting the derivation in two is what keeps `SlotsGateOutcome`
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
 * **Active/Bench Overflow** — the SLOTS-side counterpart to `Overflow
 * Count`, and the only overflow figure that reaches Projected Active/Bench
 * Additions (Story 10.2, PRD §3).
 *
 * The two derivations are one subtraction apart and they are two functions
 * on purpose:
 *
 *   N_money = eligibleLeading.length                    + (eligible ? 1 : 0)
 *   N_slots = eligibleLeading.filter(!entry).length     + (eligible ∧ ¬entry ? 1 : 0)
 *   Overflow Count        = max(0, N_money − M)   → Minors Exposure, `evaluateCap`
 *   Active/Bench Overflow = max(0, N_slots − M)   → this gate's projection
 *
 * **Why they must differ, and why a shared call is the defect.** FR-18 as
 * amended on 2026-09-08 exempts a Minimum-Bid Contention entry from Roster
 * Capacity entirely — the expected outcome of a lottery is losing, and a
 * capacity rule sized as though a Team would win them all rations entries
 * against an outcome that will probably not happen. It grants no such
 * exemption from the cap: a Contender who DOES win pays, so every entry
 * stays inside `Overflow Count` and inside Minors Exposure. §10 example 35
 * is where the two are visibly different numbers for one Team at one
 * instant — `Overflow Count 2` against `Active/Bench Overflow 0` — and both
 * are correct. Computing one and using it for both would either ration
 * lotteries the PRD unlimits, or under-commit capital the cap requires.
 *
 * `thisBidIsEntry` is the contention gate's own verdict, threaded down from
 * `evaluateSlots`. It is never re-derived from the amount here — this
 * function, like everything on the slots path, cannot see one.
 *
 * `M` comes from `minorsCountsFor` — the same FUNCTION the money side
 * calls, though not the same call: this is its own invocation, and what is
 * shared is the expression rather than the result. That is deliberate.
 * `max(0, 3 − occupied)` is written once and both figures read it, so the
 * two overflows differ in their NUMERATOR alone; a second subtraction
 * spelled out here would be a second thing to keep in step. The function is
 * pure and takes three integers, so calling it twice cannot disagree with
 * calling it once.
 */
type ActiveBenchOverflowCounts = {
	readonly freeMinorLeagueSlots: number;
	readonly eligibleLeadingBidsExcludingEntries: number;
	readonly activeBenchOverflow: number;
};

function activeBenchOverflowFor(
	state: BoundBidState,
	thisBidIsEntry: boolean
): ActiveBenchOverflowCounts {
	const { freeMinorLeagueSlots } = minorsCountsFor(state);
	const eligibleLeadingBidsExcludingEntries =
		state.team.eligibleLeading.filter((lead) => !lead.isContentionEntry).length +
		(state.playerIsMinorLeagueEligible && !thisBidIsEntry ? 1 : 0);
	return {
		freeMinorLeagueSlots,
		eligibleLeadingBidsExcludingEntries,
		activeBenchOverflow: Math.max(
			0,
			eligibleLeadingBidsExcludingEntries - freeMinorLeagueSlots
		)
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
 * already leads, MINUS its Minimum-Bid Contention entries, plus the
 * Active/Bench Overflow, plus the Bid being placed when it is neither one a
 * Minor League Slot can absorb nor an entry of its own.
 *
 * **One expression, two gates — and since Story 10.2 the two gates may
 * legitimately hand it different arguments.** The comment that stood here
 * said the two could not disagree about the count. That is no longer the
 * claim to make, and stating it while it was false would be worse than
 * saying nothing: FR-18 exempts a lottery entry from Roster Capacity and
 * from nothing else, so the money side and the slots side are asking two
 * different questions of one Team.
 *
 * **This is the CAPACITY side, and `evaluateSlots` is now its only caller.**
 * It excludes the entries the Team already holds, which is PRD §3's
 * "however many the Team holds" and FR-18's exemption exactly: a lottery
 * entry is not rationed against the ceiling, because the expected outcome of
 * a lottery is losing. `thisBidIsEntry` is `evaluateContention`'s verdict on
 * the Bid in front of the gate, threaded down so the prospective Bid is
 * exempted on the same ground the held ones are.
 *
 * **Roster Reserve does NOT read this figure — see `reserveAdditionsFor`.**
 * It did until 2026-09-18, and that was the defect: an entry's $1,000,000 is
 * already inside `committedBids`, so excluding it here left the reserve
 * still holding back another $1,000,000 for the very Slot that money would
 * fill. One Slot, funded twice. The exemption is a capacity rule and it was
 * being spent as a money rule.
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
 * **`activeBenchOverflow` is what keeps that from being a carve-out.** An
 * eligible win with no Free Minor League Slot to land in takes an
 * Active/Bench Slot at full price, so it is counted here exactly as a
 * non-eligible win is — which is §10 example 25's fourth stash being refused
 * on capacity, `12 + 1 = 13`, even though the money is there. There is no
 * automatic Slot Placement to wait for: an overflow with nowhere to land is
 * refused at the Bid. It is the SLOTS-side overflow and never
 * `minorsCountsFor`'s: an eligible ENTRY that overflows on the money side
 * still lands nothing on Active/Bench until it is drawn, and §10 example 35
 * is a Team for which the two figures are 2 and 0.
 *
 * **Story 10.2's two subtractions.** `team.leading` is already the
 * non-eligible leads alone — `teamMoneyStateFor` skips the Auction being bid
 * on and the Auctions another Team leads, and routes the eligible ones into
 * `eligibleLeading`, so no eligible lead is ever counted twice — but it is
 * no longer the non-eligible COMMITMENTS alone, because a non-eligible
 * lottery entry sits in it too. `isContentionEntry` is what takes them back
 * out, and the `+ 1` is suppressed for an entry for the same reason: an
 * entry contributes nothing to this count and spends no allowance, however
 * many of them a Team holds (FR-18, §10 example 34).
 */
function projectedAdditionsFor(
	state: BoundBidState,
	thisBidIsEntry = false,
	// **The counts, injected so ONE derivation serves the whole gate.**
	// `evaluateSlots` needs these figures for its own outcome as well as for
	// this sum, and computing them twice from the same arguments is the
	// duplication this module argues against everywhere else. The default is
	// what keeps a single-argument call site available to `evaluateActSlots`,
	// which wants only the number.
	counts: ActiveBenchOverflowCounts = activeBenchOverflowFor(state, thisBidIsEntry)
): number {
	const { activeBenchOverflow } = counts;
	return (
		state.team.leading.filter((lead) => !lead.isContentionEntry).length +
		(state.playerIsMinorLeagueEligible || thisBidIsEntry ? 0 : 1) +
		activeBenchOverflow
	);
}

/**
 * Reserve Additions — the MONEY side's count of Active/Bench Slots this
 * Team's outstanding commitments will fill, and the only figure Roster
 * Reserve may read (2026-09-18).
 *
 * The third member of a family this module already has two of. Written out
 * beside its capacity counterpart so the one term they differ on is visible:
 *
 *   Projected Active/Bench Additions = leading.filter(¬entry) + (¬elig ∧ ¬entry ? 1 : 0) + Active/Bench Overflow
 *   Reserve Additions                = leading                + (¬elig            ? 1 : 0) + Overflow Count
 *
 * **Entries are counted here, and excluded there, because the two figures
 * answer two questions.** Capacity asks "how many Slots may this Team be
 * rationed against", and FR-18 answers that a lottery entry is rationed
 * against none. Roster Reserve asks "how many Slots does this Team still
 * have to FUND at the minimum", and a held entry funds one already: its
 * $1,000,000 is inside `committedBids`, charged against Available Cap Space
 * from the instant it is placed. Reserving a second $1,000,000 for the Slot
 * that money would fill charges the same hole twice, and the Team's Maximum
 * Bid falls by the entry's full amount rather than by nothing.
 *
 * Read the two outcomes and see that neither wants the second charge. If the
 * entry WINS, the committed $1,000,000 is what bought the Slot and one fewer
 * hole remains. If it LOSES, the $1,000,000 is released and the hole is
 * reserved again. The Team needs $1,000,000 for that Slot in both branches
 * and never $2,000,000, so the exclusion was over-strict by exactly one
 * minimum salary per held entry.
 *
 * **The inversion it produced is how it was found.** A Team at Roster Count
 * 9 with $20,000,000 bidding $1,000,000 lost $1,000,000 of Maximum Bid; the
 * same Team bidding $1,100,000 lost $100,000. Offering $100,000 more left it
 * $900,000 richer in bidding power, which is not a rule anyone wrote.
 *
 * **`Overflow Count` and not `Active/Bench Overflow`**, for the same reason
 * and by the same symmetry. The money-side overflow counts eligible entries
 * because `minorsExposureFor` charges them; so the Slot an overflowing
 * eligible entry would take is funded already, and this count must see it.
 * The pair now reads cleanly: every commitment `committedBids` charges is a
 * commitment this count projects, and `minorsCountsFor` serves both halves.
 *
 * `noProspectiveBid` is `teamSolvencyFiguresFor`'s own parameter, and it
 * says what it means — a Roster Trade or Drop places no Bid, so there is
 * nothing to project for one (§10 examples 37 and 40). It is deliberately
 * NOT `thisBidIsEntry`: a prospective ENTRY commits its $1,000,000 the
 * moment it lands, so the money side counts it exactly as it counts an
 * ordinary Bid. `evaluateCap` passes `false` and is unchanged — §10 example
 * 34's ninth entry still passes on money at exactly `Maximum Bid =
 * $1,000,000` and its tenth is still refused there rather than on capacity.
 */
function reserveAdditionsFor(
	state: BoundBidState,
	noProspectiveBid: boolean,
	// The money-side counts, injected rather than re-derived:
	// `teamSolvencyFiguresFor` already holds them for Minors Exposure, and a
	// second `minorsCountsFor` call here would be a second thing to keep in
	// step with the exposure it must agree with.
	counts: MinorsCounts
): number {
	return (
		state.team.leading.length +
		(state.playerIsMinorLeagueEligible || noProspectiveBid ? 0 : 1) +
		counts.overflowCount
	);
}

/**
 * What a Team holds RIGHT NOW against its Outstanding Bid Allowance, and how
 * many open lotteries it has entered (Story 10.6, FR-37, FR-18).
 *
 * **One derivation, two surfaces.** The persistent strip and the Teams index
 * both state this figure, and `teamViewFor` reads it from here rather than
 * spelling it a second time — which is what makes the strip and the row
 * structurally incapable of disagreeing.
 *
 * **It is deliberately NOT `projectedAdditions`.** That figure counts a
 * PROSPECTIVE Bid: it answers "if I bid now, what would this be", which is
 * the question the gate asks and not the question a standing figure asks.
 * This is the same expression WITHOUT its prospective `+ 1` — built from the
 * same parts rather than by probing the gate and subtracting one, because a
 * subtraction is something a reader has to justify every time they meet it.
 *
 * The `max(0, N_slots − M)` half is `activeBenchOverflowFor`'s own call, not
 * a second subtraction written out here, so the two figures differ in nothing
 * at all. The state it is called with is the no-prospective-Bid one — the
 * SAME `false` the strip's baseline passes for `playerIsMinorLeagueEligible`
 * (`strip.ts`) — under which both of that function's prospective terms
 * contribute zero whatever `thisBidIsEntry` says.
 *
 * **Entries are counted SEPARATELY and never summed in** (UX-DR36). A
 * Minimum-Bid Contention entry consumes no allowance and a Team may hold any
 * number of them, so folding them into the bids figure would state a ceiling
 * that does not exist. `isContentionEntry` is the classification
 * `teamMoneyStateFor` already recorded per Bid, so this is a filter and never
 * a comparison against an amount.
 *
 * **Every figure is nulled TOGETHER for a viewer bound to no Team**, the way
 * `evaluateCap` nulls its own: a Team that does not exist holds no bids
 * against no allowance, and `0 of 0` would be an invented figure rather than
 * an absent one.
 */
export type OutstandingBidFigures = {
	/**
	 * Outstanding NON-ENTRY Bids — the slots-side count, which is what the
	 * allowance bounds. Never `overflowCount`, which counts entries because
	 * the cap must carry them (see `minorsCountsFor`).
	 */
	readonly outstandingBids: number;
	/** `Free Active/Bench Slots + OUTSTANDING_BID_ALLOWANCE` — what is permitted. */
	readonly allowance: number;
	/** Open Minimum-Bid Contention entries. Bounded by money alone (FR-18). */
	readonly openContentionEntries: number;
};

export function outstandingBidFiguresFor(team: TeamMoneyState): OutstandingBidFigures;
export function outstandingBidFiguresFor(team: TeamMoneyState | null): OutstandingBidFigures | null;
export function outstandingBidFiguresFor(
	team: TeamMoneyState | null
): OutstandingBidFigures | null {
	if (team === null) return null;
	// The no-prospective-Bid state: there is no Player being bid on here, so
	// nothing is eligible and nothing is an entry.
	const bound: BoundBidState = { team, playerIsMinorLeagueEligible: false };
	const { activeBenchOverflow } = activeBenchOverflowFor(bound, false);
	return {
		outstandingBids:
			team.leading.filter((lead) => !lead.isContentionEntry).length + activeBenchOverflow,
		// `unfilledSlots` with no additions IS Free Active/Bench Slots, clamp
		// and all — the same one expression `evaluateSlots` reads its `F` from.
		allowance: unfilledSlots(team.rosterCount, 0) + OUTSTANDING_BID_ALLOWANCE,
		openContentionEntries:
			team.leading.filter((lead) => lead.isContentionEntry).length +
			team.eligibleLeading.filter((lead) => lead.isContentionEntry).length
	};
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
 * **The clamp is kept, and since Story 10.1 it is reachable in ORDINARY
 * play**: the Outstanding Bid Allowance lets a Team hold one Bid beyond its
 * free Slots, so §10 example 29's Roster Count 11 with two projected
 * additions computes `max(0, 12 − 13)` and a $0 reserve with no override
 * involved. A Commissioner override (Story 7.x) can still put a Team above
 * 12 too. Either way an unclamped reserve would go NEGATIVE and hand that
 * Team extra spending power.
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
	const figures = teamSolvencyFiguresFor(state, fantraxPlayerId, amount);
	if (figures === null) {
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

	return {
		// **The one expression in this function that is about the AMOUNT**, and
		// everything above it is about the Team. `teamSolvencyFiguresFor` holds
		// the arithmetic; this holds FR-13's comparison, unchanged in meaning
		// from the day it was written.
		passed: figures.unbounded
			? compareMoney(figures.maximumBid, NO_MONEY) >= 0
			: compareMoney(amount, figures.maximumBid) <= 0,
		offered: amount,
		...figures
	};
}

/**
 * A Team's SOLVENCY, as the money gate computes it — everything
 * `CapGateOutcome` carries except the offer and the verdict on it (Story
 * 7.7, AR-42).
 *
 * **Extracted rather than copied, because a second Team-solvency arithmetic
 * is the one thing this module refuses everywhere else.** `evaluateCap` is
 * the only gate that decides from an amount; every figure below it —
 * Committed Bids, Minors Exposure, Available Cap Space, Projected
 * Active/Bench Additions, Roster Reserve and Maximum Bid — answers "what can
 * this Team still carry", which is a question a Roster Trade asks with no
 * amount at all (FR-41). `rules/roster-trade.ts` reads `maximumBid` from here
 * and compares it to nothing but zero, which is the identical test the
 * `unbounded` branch below already makes.
 *
 * `null` for a Team that is not bound, exactly as the gate answers `null`
 * figures: there is no arithmetic to do, and inventing zeroes for one would
 * be inventing a Team.
 *
 * `noProspectiveBid` says the one thing it is ever used to say: a Roster
 * Trade or Drop places no Bid, so nothing is projected for one (§10 examples
 * 37 and 40). It was `prospectiveBidIsExempt` until 2026-09-18, a name that
 * carried `projectedAdditionsFor`'s `thisBidIsEntry` meaning as well — "this
 * Bid is a lottery entry" — and the two readings are not the same fact. No
 * caller ever passed it for the entry meaning, but the name invited a future
 * one to, and on the money side that reading is wrong: a prospective entry
 * commits its $1,000,000 like any other Bid (see `reserveAdditionsFor`).
 * `evaluateCap` passes `false` and is unchanged.
 */
export type TeamSolvencyFigures = {
	readonly capSpace: Money;
	readonly committedBids: Money;
	readonly minorsExposure: Money;
	readonly availableCapSpace: Money;
	readonly rosterCount: number;
	readonly projectedAdditions: number;
	readonly rosterReserve: Money;
	readonly maximumBid: Money;
	readonly freeMinorLeagueSlots: number;
	readonly eligibleLeadingBids: number;
	readonly overflowCount: number;
	readonly unbounded: boolean;
	readonly exposingBids: readonly ExposingBid[];
	readonly exposureIncludesThisBid: boolean;
};

export function teamSolvencyFiguresFor(
	state: BidState,
	fantraxPlayerId: string,
	amount: Money,
	noProspectiveBid = false
): TeamSolvencyFigures | null {
	const team = state.team;
	if (team === null) return null;

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
	// **`reserveAdditionsFor` and NOT `projectedAdditionsFor`** — the money
	// side's own count, reading the same `counts` the exposure above read, so
	// every commitment charged to `committedBids` is a commitment this
	// projects. See that function for why the capacity figure cannot serve
	// here.
	const projectedAdditions = reserveAdditionsFor(bound, noProspectiveBid, counts);
	const rosterReserve = multiplyMoney(
		MINIMUM_OPENING_BID,
		unfilledSlots(team.rosterCount, projectedAdditions)
	);
	const maximumBid = subtractMoney(availableCapSpace, rosterReserve);

	// A Free Minor League Slot absorbs this Player at a $0 Cap Hit, so no
	// amount is too large — but the reserve must still be coverable.
	const unbounded = state.playerIsMinorLeagueEligible && counts.overflowCount === 0;

	return {
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
 * **Two branches, and the ORDER between them is the rule** (FR-37, amended
 * 2026-09-08 by the Outstanding Bid Allowance):
 *
 *   F = max(0, 12 − Roster Count)          — Free Active/Bench Slots
 *   A = F + OUTSTANDING_BID_ALLOWANCE      — outstanding Bids permitted
 *
 *   pass  ⟺  P = 0                         — the Minor-League carve-out
 *         ∨  (F ≥ 1  ∧  P ≤ A)             — the allowance, and its guard
 *
 * **The precondition `F ≥ 1` is tested before the arithmetic `P ≤ A`, and
 * that is not a micro-optimisation.** At `F = 0` the allowance is still 1,
 * so a full roster placing its first Bid has `P = 1 ≤ 1` and would be
 * ADMITTED — it would go on to win a thirteenth Player, with no other Close
 * available to cancel the surplus first. §10 example 30 is that
 * counterfactual stated as arithmetic and §10 example 24 is it stated in
 * play. Reordering the two conjuncts breaks the ceiling this gate exists to
 * defend, silently, in the ordinary case.
 *
 * **The ceiling of 12 is UNCHANGED.** What widened is how many outstanding
 * Bids may stand against it, not how many Players may land. §10 example 29's
 * pass leaves `11 + 2 = 13`, which is legal precisely because FR-40 cancels
 * the surplus commitment at the Close that fills the Slot — so `ceiling` is
 * still reported on every evaluation, pass and refusal alike. A refusal
 * quoting only the allowance would imply thirteen players are legal.
 *
 * `F` comes from `unfilledSlots(rosterCount, 0)` — the SAME clamped
 * subtraction Roster Reserve does, evaluated with no additions — rather than
 * from a second expression that must agree with it. The clamp matters here:
 * a Team a Commissioner override put at Roster Count 13 gets `F = 0` and
 * fails the precondition, instead of a negative `F` that would compute an
 * allowance of 0 and pass by accident.
 *
 * The counts are on the same POST-BID basis Roster Reserve uses:
 * `projectedAdditionsFor` counts the Bid being placed. It is the same
 * FUNCTION `evaluateCap` calls, but since Story 10.2 it is no longer the
 * identical CALL and the two gates may report different counts — this one
 * passes `isContentionEntry`, so a lottery entry adds nothing here while
 * still costing the cap a commitment (FR-18). The old claim that the two
 * "cannot disagree about the count" has been removed rather than softened,
 * because it is now false in exactly the case this story exists for. What
 * they still do NOT share is the outcome: this returns its own
 * `rosterCount`, its own `projectedAdditions` and its own `ceiling`,
 * because reporting a capacity refusal as a cap refusal is a defect (AD-7)
 * and two rows each stating their own arithmetic cannot be read as one.
 *
 * **FR-18's landing test comes FIRST and is the whole verdict for an
 * entry** (Story 10.2). A Minimum-Bid Contention entry is permitted iff
 * `freeActiveBenchSlots >= 1` OR (`playerIsMinorLeagueEligible` AND
 * `freeMinorLeagueSlots >= 1`). Roster Count, the allowance and
 * `projectedAdditions` bear on it not at all — which is why the branch
 * cannot simply fall through to `P = 0`: an entry at a full roster with no
 * minors room has `P = 0` too, and the zero branch would ADMIT it. §10
 * example 34 is the pass at `F = 1` however many entries are already held;
 * §10 example 35 is the pass on the eligible branch at `F = 0`.
 *
 * **The entry verdict is an INPUT, never a short-circuit** (AD-7). Both
 * gates are still evaluated on every Bid and both outcomes are returned;
 * `evaluate` hoists the contention outcome and hands this one its `entry`
 * classification, so the judgement is made once, by the gate that owns it.
 * The signature still takes no amount, and `SlotsGateOutcome` still carries
 * no money field.
 *
 * **"At the ceiling" passes, and now with room to spare.** A Bid that fills
 * the twelfth hole leaves `F = 1` and `P = 1 ≤ 2`, so §10 example 23's Team
 * could hold a SECOND outstanding Bid as well. §10 example 24 is the other
 * side: a Team already at twelve has `F = 0` and no allowance at all.
 *
 * **An overridden Team above the ceiling is REFUSED rather than rewarded.**
 * `unfilledSlots`' clamp gives it `F = 0`, the precondition fails, and it
 * gets no allowance — the same answer a Team at exactly twelve gets, which
 * is the only defensible one.
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
function evaluateSlots(state: BidState, entry: ContentionGateOutcome['entry']): SlotsGateOutcome {
	// The contention gate's own classification, narrowed to the one bit this
	// gate may act on. `converts` is NOT an entry — a $5,000,000 conversion
	// takes an Active/Bench commitment like any other raise — and
	// `not_a_contention` covers the Opening Bid at exactly $1,000,000, which
	// this gate cannot see the amount of and therefore gates as an ordinary
	// Bid. `already_contending` is an entry that the contention gate itself
	// refuses; it is classified honestly here anyway, because neither gate
	// short-circuits the other (AD-7).
	const isContentionEntry = entry === 'joins' || entry === 'already_contending';
	const figures = slotCapacityFiguresFor(state, isContentionEntry);
	if (figures === null) {
		return {
			passed: true,
			rosterCount: null,
			projectedAdditions: null,
			ceiling: ACTIVE_BENCH_SLOTS,
			freeActiveBenchSlots: null,
			allowance: null,
			freeMinorLeagueSlots: null,
			eligibleLeadingBidsExcludingEntries: null,
			activeBenchOverflow: null,
			// Not a count, so not nulled with them: the classification is true
			// of a Bid whether or not a Team is bound to place it.
			isContentionEntry
		};
	}

	return {
		// FR-18's landing test, then FR-37's two branches — and the entry
		// branch REPLACES them rather than joining them. An entry at a full
		// roster has `P = 0`, so falling through would let the zero branch
		// admit a win with nowhere to land.
		passed: isContentionEntry
			? figures.freeActiveBenchSlots >= 1 ||
				(state.playerIsMinorLeagueEligible && figures.freeMinorLeagueSlots >= 1)
			: // FR-37's two branches, in the ONE expression `activeBenchCapacityHolds`
				// holds — read here and read again by `rules/roster-trade.ts`, so the
				// two commands cannot drift apart about what a full roster is.
				activeBenchCapacityHolds(figures),
		...figures,
		isContentionEntry
	};
}

/**
 * A Team's CAPACITY, as the slots gate computes it — everything
 * `SlotsGateOutcome` carries except the classification and the verdict
 * (Story 7.7, AR-42).
 *
 * `teamSolvencyFiguresFor`'s counterpart, extracted for its reason and in the
 * same diff: FR-41 asks "has this Team still got somewhere to put what it
 * holds" of two Teams at once and with no Bid anywhere in sight, and a second
 * spelling of `F`, `A` or Active/Bench Overflow would be the first thing to
 * drift from the rule that admits a Bid.
 *
 * **It still cannot see an amount**, which is the property FR-37 asks of the
 * gate and is preserved here structurally: the signature takes a `BidState`
 * and a boolean, exactly as `evaluateSlots` does.
 *
 * `ceiling` is stated even for an unbound Team, which is why the gate's own
 * `null` branch restates it rather than reading it from a `null` figure set:
 * `ACTIVE_BENCH_SLOTS` is a league constant and is true of a Team that does
 * not exist.
 */
export type SlotCapacityFigures = {
	readonly rosterCount: number;
	readonly projectedAdditions: number;
	readonly ceiling: number;
	readonly freeActiveBenchSlots: number;
	readonly allowance: number;
	readonly freeMinorLeagueSlots: number;
	readonly eligibleLeadingBidsExcludingEntries: number;
	readonly activeBenchOverflow: number;
};

/**
 * FR-37's two branches, as ONE expression both commands read (Story 7.7).
 *
 *   pass  ⟺  P = 0                         — the Minor-League carve-out
 *         ∨  (F ≥ 1  ∧  P ≤ A)             — the allowance, and its guard
 *
 * **The precondition `F ≥ 1` is tested before the arithmetic `P ≤ A`**, and
 * `&&` is what enforces that ordering: at `F = 0` the allowance is still 1, so
 * a full roster placing its first Bid would compute `P = 1 ≤ 1` and be
 * ADMITTED — it would go on to win a thirteenth Player with no Close available
 * to cancel the surplus first. §10 example 30 is that counterfactual as
 * arithmetic and §10 example 24 is it in play.
 *
 * **Extracted because a Roster Trade asks the identical question** (FR-41).
 * `rules/roster-trade.ts` judges two Teams against this expression with no Bid
 * anywhere in sight, and a character-for-character second copy of it is the
 * one thing that could let a Trade admit a roster a Bid would be refused for.
 * The cap side avoided the same duplication by reading `maximumBid` off
 * `teamSolvencyFiguresFor`; this is the capacity side's equivalent.
 *
 * It takes the three FIGURES rather than a `BidState`, so it cannot see an
 * amount, cannot see a Team and cannot acquire a second job. FR-18's entry
 * branch is deliberately NOT here: an entry REPLACES these branches rather
 * than joining them, and folding the two into one predicate is what would
 * make an entry at a full roster fall through to `P = 0` and be admitted.
 */
export function activeBenchCapacityHolds(figures: {
	readonly projectedAdditions: number;
	readonly freeActiveBenchSlots: number;
	readonly allowance: number;
}): boolean {
	return (
		figures.projectedAdditions === 0 ||
		(figures.freeActiveBenchSlots >= 1 && figures.projectedAdditions <= figures.allowance)
	);
}

export function slotCapacityFiguresFor(
	state: BidState,
	isContentionEntry: boolean
): SlotCapacityFigures | null {
	const team = state.team;
	if (team === null) return null;

	const bound = boundStateFor(state, team);
	// The SLOTS-side overflow — entries removed. `evaluateCap` calls
	// `minorsCountsFor` for the money-side pair, and §10 example 35 is the
	// Team for which the two figures are 2 and 0.
	const counts = activeBenchOverflowFor(bound, isContentionEntry);
	// The SAME counts, handed on rather than derived a second time from the
	// same two arguments.
	const projectedAdditions = projectedAdditionsFor(bound, isContentionEntry, counts);
	// `unfilledSlots` with no additions IS Free Active/Bench Slots, clamp and
	// all — one expression, not a second subtraction that has to agree.
	const freeActiveBenchSlots = unfilledSlots(team.rosterCount, 0);
	const allowance = freeActiveBenchSlots + OUTSTANDING_BID_ALLOWANCE;
	return {
		rosterCount: team.rosterCount,
		projectedAdditions,
		ceiling: ACTIVE_BENCH_SLOTS,
		freeActiveBenchSlots,
		// Raw `F + 1` even at `F = 0`: §10 example 30's lesson IS that
		// counterfactual. The precondition sentence must never quote it, and
		// the entry sentence must not either — an entry spends none of it.
		allowance,
		freeMinorLeagueSlots: counts.freeMinorLeagueSlots,
		eligibleLeadingBidsExcludingEntries: counts.eligibleLeadingBidsExcludingEntries,
		activeBenchOverflow: counts.activeBenchOverflow
	};
}

/**
 * The phase gate: no Bid is accepted outside the Auction Phase (Story 3.7,
 * FR-22, AD-22).
 *
 * **The whole rule is one comparison against the folded phase.** It reads no
 * route, no destination catalog, no clock and no Auction. `state.phase` is
 * `phaseReducer` over the whole log — the same value every other surface
 * reads — so "bidding is disabled league-wide" is a rule the core states
 * rather than a side effect of a navigation table.
 *
 * **It cannot see the League Clock, and its refusal must not claim to.** The
 * Auction Phase ends when the clock runs out, but `Setup` and `Archived` fail
 * this gate too and in neither case did any clock expire. So the outcome
 * carries the phase and nothing else, and `gateSentence` words the refusal
 * from the phase alone — the same discipline `rules/nomination.ts` keeps for
 * its own phase refusal, and AD-7's "a gate that cannot see a figure cannot
 * quote one" applied to a cause rather than to a number.
 *
 * It is handed no `now` and no `command`. Which amount was offered, by whom,
 * and how long an Auction Clock had left are all questions that only mean
 * something inside the Auction Phase.
 */
function evaluatePhase(state: BidState): PhaseGateOutcome {
	return {
		passed: state.phase === 'Auction',
		phase: state.phase
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
 * Story 3.7's `phase` gate takes neither `now` nor `command`, and it still
 * runs on every evaluation like every other: AD-1 forbids short-circuiting,
 * so a Bid submitted after the phase ended still reports its own increment,
 * cap and slots arithmetic beside the phase refusal, and none of the nine
 * suppresses another.
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
	// Hoisted because the slots gate reads its `entry` classification (Story
	// 10.2). ONE judgement, made by the gate that owns it: re-deriving "is
	// this a lottery entry" beside the capacity arithmetic would be a second
	// answer to a question already answered, and would have to compare an
	// amount inside a gate that must stay unable to see one. The verdict is
	// an INPUT, not a skip — both gates are still evaluated and both outcomes
	// are still returned, whichever way each of them goes (AD-7).
	const contention = evaluateContention(state, command.amount, command.teamId);
	return {
		// First in `PLACE_BID_GATES` and first here, so the declared order and
		// the construction order agree on sight (Story 3.7). It is handed
		// neither `now` nor `command`: outside the Auction Phase, when it is and
		// what was offered are both beside the point.
		phase: evaluatePhase(state),
		// Second in both, and it is handed `now` where the others are not:
		// expiry is the only time question in the set.
		expiry: evaluateExpiry(state, now),
		opening: evaluateOpening(state, command.amount),
		// Immediately after `opening` here as well as in `PLACE_BID_GATES`, so
		// the declared order and the construction order agree on sight. It is
		// handed the acting Team because "are you already a Contender" is the
		// one question in the set that is about WHO is bidding as well as how
		// much — the same pair `selfBid` reads, for a different rule.
		contention,
		selfBid: evaluateSelfBid(state, command.teamId),
		increment: evaluateIncrement(state, command.amount),
		granularity: evaluateGranularity(command.amount),
		// The Auction's own id reaches the money gate because the exposure sum
		// includes the prospective Bid, and AD-5 needs every entry in that
		// sequence to carry the id its tiebreak sorts on. No comparison reads
		// it.
		cap: evaluateCap(state, command.fantraxPlayerId, command.amount),
		// No amount is passed, and that is the whole design: neither gate
		// short-circuits the other and neither can see the other's ground. The
		// contention verdict that IS passed is a classification, not a
		// magnitude — `SlotsGateOutcome` still carries no money field.
		slots: evaluateSlots(state, contention.entry)
	};
}

/**
 * Run `RESTORE_LEADING_BID_GATES` over a candidate for restoration — the
 * total function for the SECOND fixed gate set (Story 10.4, FR-40, AR-37).
 *
 * **The same two gates `evaluate` runs last, and no arithmetic of its own.**
 * `evaluateCap` and `evaluateSlots` are called here exactly as they are
 * called there, with the identical arguments, so a Team judged able to keep a
 * commitment is judged by the rule that admitted it. There is no second
 * statement of the allowance, of Minors Exposure or of the eligible carve-out
 * anywhere in `rules/restore.ts`, and there could not be: this is the only
 * door.
 *
 * **`evaluateContention` is asked, and its verdict is not a gate here.**
 * `evaluateSlots` reads the contention gate's own `entry` classification to
 * know whether the commitment is a lottery entry — FR-18's exemption — so the
 * classification has to be OBTAINED rather than invented. Asking the gate is
 * how `evaluate` obtains it, and asking it a second way here would be a
 * second answer to a question `rules/bidding.ts` already owns. Its `passed`
 * is deliberately discarded: `already_contending` refuses a Team joining a
 * lottery twice, which is a rule about the ACT of joining and says nothing
 * about a join already made.
 *
 * **`now` is accepted and read by nothing**, and that is the point rather
 * than an oversight. The signature is `evaluate`'s — `(state, command, now)`
 * — because a caller must not have to remember which of the two evaluators
 * takes an instant, and because `expiry` is the one gate that asks what time
 * it is and this set does not contain it. A restored Bidder inherits whatever
 * is left of the Auction Clock, including very little (FR-40); refusing the
 * restoration because that clock is nearly out would strand the Auction
 * leaderless for the one reason FR-40 rules out.
 *
 * Every key is always present with its own outcome and its own arithmetic,
 * whether or not that gate passed, exactly as `PlaceBidGateResults` is
 * (AD-1). Neither gate short-circuits the other.
 */
export function evaluateRestore(
	state: BidState,
	command: RestoreLeadingBid,
	/** Unread, and declared anyway — see above. */
	now: string
): RestoreLeadingBidGateResults {
	void now;
	const contention = evaluateContention(state, command.amount, command.teamId);
	return {
		cap: evaluateCap(state, command.fantraxPlayerId, command.amount),
		slots: evaluateSlots(state, contention.entry)
	};
}

/**
 * Whether every gate in `RESTORE_LEADING_BID_GATES` passed.
 *
 * Iterated over the declared list rather than over `Object.values`, for
 * `allGatesPassed`'s reason: the list is the sequence, fixed and ordered at
 * the one place the gate set lives.
 */
export function allRestoreGatesPassed(gates: RestoreLeadingBidGateResults): boolean {
	for (const gate of RESTORE_LEADING_BID_GATES) {
		if (!gates[gate].passed) return false;
	}
	return true;
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
 *  - `negative_amount` — the field held a figure, but a negative one. Its own
 *    case rather than a second reading of the one above, because "that is not
 *    a figure in millions" is false about `-1.5` and the remedy differs: a
 *    stray character is a typing slip, a minus sign is a misunderstanding of
 *    what the field is for.
 *  - `dollars_not_millions` — the field held a figure larger than the whole
 *    Salary Cap expressed in millions, which is what a full dollar amount
 *    typed into a millions field looks like. Its own case for
 *    `negative_amount`'s reason, and a strong one: the field took whole
 *    dollars until this change, so `10500000` is the shape of an old habit
 *    rather than of a mistake, and the gates cannot name it — read as
 *    millions it is a Cap breach of $10.5 trillion, and every sentence they
 *    could produce would be about the Cap instead of about the unit.
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
	| { readonly kind: 'dollars_not_millions' }
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
		case 'phase': {
			const outcome = gates.phase;
			if (outcome.passed) return null;
			// **Worded from the phase ALONE.** This gate compared
			// `state.phase === 'Auction'` and knows nothing else — in particular
			// it does not know whether the League Clock ran out, which is false
			// in `Setup` and in `Archived`. A sentence naming a cause the gate
			// cannot see would be AD-7's "a gate that cannot see a figure cannot
			// quote one" broken in words instead of in numbers, on the one
			// surface in the product that may never be wrong.
			//
			// It quotes no amount, no clock and no count, for the same reason:
			// this Bid was not too small, too late or too expensive.
			//
			// **And it claims nothing about a transaction.**
			// `rules/nomination.ts`'s phase refusal says "folded from the event
			// log inside this transaction" truthfully, because `refuseNomination`
			// runs only inside the write path. This sentence is read on three:
			// the locked transaction, `server/auction-page.ts`'s render — which
			// deliberately takes no lock — and the browser, which re-evaluates it
			// off the wire on every keystroke. A borrowed clause that is false on
			// two of the three is the same defect as a quoted figure the gate
			// cannot see.
			return (
				'Bidding is open only during the Auction Phase, and the league is in ' +
				`${outcome.phase}. The phase is folded from the event log, and it is the ` +
				'same phase every other surface reads.'
			);
		}
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
			// `converts` has no branch here at all since Story 3.3: it passes,
			// and `if (outcome.passed) return null` above already covered it
			// the moment the verdict moved. The branch that stood here worded
			// the deferral, and a deferral that is over is a sentence no
			// Manager can ever be shown again.
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
				outcome.projectedAdditions === null ||
				outcome.freeActiveBenchSlots === null ||
				outcome.allowance === null
			) {
				return null;
			}
			// No money anywhere in either sentence, and that is the point: a
			// capacity refusal that quoted a cap figure as its ground would be
			// the defect AD-7 names. The counts are stated, then the sum they
			// make, then the ceiling — nobody has to add at 4am.
			// **FR-18's refusal, and it comes first because its GROUND is
			// different** (Story 10.2). A lottery entry spends no allowance and
			// is not measured against Roster Capacity at all; what it lacks is
			// somewhere for a win to land. Telling this Manager their allowance
			// is spent, or quoting a projection the rule never read, would send
			// them after the wrong remedy — and the remedy here is the same one
			// the precondition has, which is exactly why the two sentences must
			// not be the same sentence.
			if (outcome.isContentionEntry) {
				return (
					'A lottery entry needs somewhere for the win to land: your Team has no ' +
					'Active/Bench Slot free, and no Minor League Slot this Player could take. ' +
					`Roster Count is ${String(outcome.rosterCount)} against a Roster Capacity of ` +
					`${String(outcome.ceiling)}. Entering a lottery spends none of your ` +
					'Outstanding Bid Allowance, so it is the landing place you lack rather than ' +
					'the room to bid. You may enter again once a Slot frees up.'
				);
			}

			const projected = outcome.rosterCount + outcome.projectedAdditions;
			// §10 example 25's overflow, named in COUNTS alone — there is no
			// amount on this outcome to name it in anything else. It rides
			// BOTH refusals: an overflow can be what spent the allowance just
			// as easily as what met a full roster. It is the SLOTS-side figure
			// (Story 10.2): quoting the money side's Overflow Count here would
			// state a number this gate never read.
			const overflow =
				outcome.activeBenchOverflow === null || outcome.activeBenchOverflow === 0
					? ''
					: `Eligible Leading Bids ${String(outcome.eligibleLeadingBidsExcludingEntries)} ` +
						`against Free Minor League Slots ${String(outcome.freeMinorLeagueSlots)} leaves ` +
						`an Active/Bench Overflow of ${String(outcome.activeBenchOverflow)}, and an ` +
						'eligible win with no Free Minor League Slot to land in takes an ' +
						'Active/Bench Slot. ';
			const arithmetic =
				`Roster Count is ${String(outcome.rosterCount)} and Projected Active/Bench ` +
				`Additions is ${String(outcome.projectedAdditions)}, so winning would put your ` +
				`Team at ${String(projected)} against a Roster Capacity of ` +
				`${String(outcome.ceiling)}. ` +
				overflow;

			// **The PRECONDITION refusal** (§10 examples 24, 25, 30): no Free
			// Active/Bench Slot at all, so the allowance never applies. It
			// must NOT quote `allowance` — that figure is still 1 here, and
			// saying "1 permitted" while permitting none is precisely the
			// confusion two separate sentences exist to avoid. The remedy is
			// a Slot freeing up, and it lasts until one does.
			if (outcome.freeActiveBenchSlots === 0) {
				return (
					'Your Team has no roster slot for this Player: with no free Active/Bench Slot, ' +
					`no bid on this Player is permitted. ${arithmetic}` +
					'You may bid again once a Slot frees up.'
				);
			}

			// **The ALLOWANCE refusal** (§10 example 29's tail): the Team has
			// room and has already used it plus its one extra outstanding
			// Bid. A different fact and a different remedy — this one
			// resolves itself at the next close — so UX-DR32 requires it
			// never collapse into the sentence above.
			const slots =
				outcome.freeActiveBenchSlots === 1
					? '1 free Active/Bench Slot permits'
					: `${String(outcome.freeActiveBenchSlots)} free Active/Bench Slots permit`;
			return (
				`This would be your ${ordinal(outcome.projectedAdditions)} outstanding bid, and ` +
				`${slots} ${String(outcome.allowance)}. ${arithmetic}` +
				'You may bid again once one of your bids closes or a Slot frees up.'
			);
		}
	}
}

/**
 * `1` as `1st` — the ordinal a bid count is spoken in.
 *
 * The slots wording counts outstanding bids in both directions ("your 2nd of
 * 2 permitted bids", "this would be your 3rd outstanding bid"), and a
 * Manager reads a position, not a cardinal. One function rather than two
 * inline expressions, for the reason every glyph here is one: the passing
 * figure and the refusing sentence must not spell the same number two ways.
 *
 * **The caller only ever passes 1 or more, and that is an invariant rather
 * than a coincidence.** `projectedAdditions` of 0 is the zero branch, which
 * both `gateSentence` and `gateFigure` answer BEFORE reaching an ordinal:
 * the gate passes there and the row prints the bare roster figure, so
 * `your 0th of 3 permitted bids` is unreachable. Anything that moves those
 * branch tests has to keep that true, because `0th` is the one reading this
 * function has no sensible answer for.
 *
 * **The 11–13 exception is real English, and it is reachable without a
 * Commissioner override.** Story 10.2 took Minimum-Bid Contention entries
 * out of `projectedAdditions`, so the old justification — eleven open
 * lotteries — no longer reaches these values. Ordinary leads still do, and
 * more directly: `allowance` is `max(0, 12 − rosterCount) + 1`, so a Team at
 * Roster Count 0 may hold 13 outstanding bids and its passing row reads
 * `your 13th of 13 permitted bids`, with `11th` and `12th` on the way there.
 * A fourteenth is refused and prints `your 14th outstanding bid`. Without
 * the exception those three would read `11st`, `12nd` and `13rd`.
 */
export function ordinal(value: number): string {
	const suffix =
		value % 100 >= 11 && value % 100 <= 13
			? 'th'
			: ['th', 'st', 'nd', 'rd'][value % 10] ?? 'th';
	return `${String(value)}${suffix}`;
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
	/**
	 * Whether this row stands while the column is COLLAPSED.
	 *
	 * The column is the answer to "how much may I bid", and the whole ledger
	 * is how that answer is checked. Most Managers, most of the time, want the
	 * answer: what they started from and what they arrived at. So a collapsed
	 * column carries `Cap Space` and `Maximum Bid` always, and a term that is
	 * ACTUALLY BITING — a non-zero `Committed Bids` or `Roster Reserve` —
	 * because a figure that moved the answer may not be hidden behind a
	 * control. A term at $0 moved nothing and states nothing by standing
	 * there.
	 *
	 * Decided HERE and not by the surface, for `kind`'s reason: this is a
	 * judgement about the arithmetic, made beside the arithmetic, and a
	 * component reading `$0.0M` back out of a rendered string to make it
	 * would be formatting money in the one place that must not.
	 *
	 * Expanding is always available and never lossy — every row is still
	 * there, in ledger order, and the column still sums as displayed once it
	 * is open. A surface that shows the column WHOLE (the refusal panel,
	 * where a breakdown a Manager has to ask for is a breakdown they will not
	 * check) simply ignores this field.
	 */
	readonly summary: boolean;
};

/**
 * The two words the collapsed column's own control goes by.
 *
 * Here rather than in the component for every other sentence's reason: one
 * definition, so the control a test asserts and the control a Manager reads
 * cannot drift apart.
 */
export const CAP_BREAKDOWN_EXPAND = 'Show the full calculation';
export const CAP_BREAKDOWN_COLLAPSE = 'Hide the full calculation';

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
		{
			label: 'Cap Space',
			figure: describeAmount(outcome.capSpace),
			operator: '',
			kind: 'term',
			// Where the answer starts. Always stands.
			summary: true
		},
		{
			label: 'Committed Bids',
			figure: describeAmount(outcome.committedBids),
			operator: SUBTRACTED,
			kind: 'term',
			// Stands when it BIT. A Team with nothing committed learns nothing
			// from a row saying so.
			summary: outcome.committedBids > 0
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
			kind: 'detail',
			summary: false
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
			kind: 'detail',
			summary: false
		},
		{
			label: 'Available Cap Space',
			figure: describeAmount(outcome.availableCapSpace),
			operator: '',
			kind: 'subtotal',
			// A step ON the way, not the answer: it is what the full column is
			// opened to read.
			summary: false
		},
		{
			label: 'Roster Reserve',
			figure: describeAmount(outcome.rosterReserve),
			operator: SUBTRACTED,
			kind: 'term',
			// Stands when it BIT — a Reserve of $0 held nothing back.
			summary: outcome.rosterReserve > 0
		},
		{
			label: `${formatMoney(MINIMUM_OPENING_BID)} × ${String(holes)} unfilled Active/Bench Slots`,
			// `MINIMUM_OPENING_BID` is a league constant on the grid by
			// construction, so this one is safe to render outright.
			figure:
				`Roster Count ${String(outcome.rosterCount)}, Projected Active/Bench Additions ` +
				`${String(outcome.projectedAdditions)}, of ${String(ACTIVE_BENCH_SLOTS)}`,
			operator: '',
			kind: 'detail',
			summary: false
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
			kind: 'subtotal',
			// The answer. Always stands.
			summary: true
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
						kind: 'detail' as const,
						// The reason the answer is what it is — read on opening the
						// column, beside the terms it is about.
						summary: false
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
 * **Story 10.1 puts a clause in front of the slots row** — `your 2nd of 2
 * permitted bids; Roster Count would be 13 of 12` — because the Outstanding
 * Bid Allowance made the roster arithmetic ambiguous on its own: at the
 * allowance a PASS and a refused thirteenth Player both read `13 of 12`. It
 * is still a readout and still not the sentence; it just names one more
 * count, which is what the gate now decides on.
 *
 * Reporting a PASSING gate is the part that exceeds the SPEC, deliberately:
 * it proves every check ran and this is the only obstacle, which forecloses
 * "what else is it not telling me". It costs one line per gate on every
 * refusal, and auditability over convenience is the stated tiebreaker.
 */
function gateFigure(gates: PlaceBidGateResults, gate: PlaceBidGate): string {
	switch (gate) {
		case 'phase':
			// ONE branch for passed and refused alike, the `slots` figure's
			// discipline: this row states the arithmetic and the chip beside it
			// states the outcome, so a second branch would be a second place for
			// the two to disagree. `the league is in Auction` beside a `Passed`
			// chip reads exactly as truly as it does beside a refused one.
			return `the league is in ${gates.phase.phase}`;
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
					// **States what this Bid DOES, not what it would do.** The
					// row sits beside a `Passed` chip now, and a figure written
					// in the conditional would read as a warning about an
					// outcome that is in fact being authorised.
					//
					// **It claims NO release, and that is a correction rather
					// than a trim.** `contenderCount` is the count BEFORE this
					// Bid, so it INCLUDES the acting Team whenever a Contender
					// converts its own lottery (FR-19 permits exactly that) —
					// and that Team is not released, it becomes the Leading
					// Bidder. "releasing 3 Contenders" is therefore false on
					// the one surface in the product that may never be, and
					// the count is not this row's to explain.
					//
					// It quotes the offered amount and the threshold it
					// cleared, which is what its `neither` sibling does with
					// the same two terms: a figure states the arithmetic the
					// gate was judged from, and this gate's judgement is one
					// comparison between exactly those two amounts.
					return (
						`${describeAmount(outcome.offered)} is at or above the ` +
						`${formatMoney(outcome.conversionAmount)} that dissolves this ` +
						`${MINIMUM_BID_CONTENTION_LABEL}`
					);
				case 'neither':
					// `neither` is EVERY amount that is not a join and not a
					// conversion, which includes amounts below the join as well as
					// the dead zone between the two thresholds. A figure states
					// what the gate was judged from, so it cannot claim an
					// interval the offered amount does not sit in.
					return compareMoney(outcome.offered, outcome.joinAmount) < 0
						? `below the ${formatMoney(outcome.joinAmount)} it takes to join`
						: `between ${formatMoney(outcome.joinAmount)} and ` +
							`${formatMoney(outcome.conversionAmount)}, which is neither a join nor a conversion`;
			}
			break;
		}
		case 'selfBid': {
			const outcome = gates.selfBid;
			if (outcome.leadingTeamId === null) {
				// Two reasons for one null, and the row must state the right
				// one — `increment`'s discipline immediately below, for the
				// same pair of causes. Awaiting an Opening Bid nobody leads
				// yet; inside a Minimum-Bid Contention a `$1,000,000` Bid IS
				// the fold's leader, so "no Team leads yet" would be a
				// falsehood on a panel whose whole purpose is to be true. The
				// question is asked of the gate that owns it rather than
				// re-derived from an amount.
				return gates.contention.entry === 'not_a_contention'
					? 'no Team leads yet'
					: `no Team leads a ${MINIMUM_BID_CONTENTION_LABEL}`;
			}
			return outcome.passed ? 'another Team leads' : 'your Team leads';
		}
		case 'increment': {
			const outcome = gates.increment;
			if (outcome.minimumLegal === null || outcome.currentHigh === null) {
				// Both figures are nulled for two different reasons and the row
				// must state the right one. Awaiting an Opening Bid there is
				// genuinely no high; inside a Minimum-Bid Contention a
				// `MINIMUM_BID` Bid IS leading, so "no current high" would be a
				// falsehood on a panel whose whole purpose is to be true.
				return gates.contention.entry === 'not_a_contention'
					? 'no current high to raise'
					: `no raise applies in a ${MINIMUM_BID_CONTENTION_LABEL}`;
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
			if (
				outcome.rosterCount === null ||
				outcome.projectedAdditions === null ||
				outcome.freeActiveBenchSlots === null ||
				outcome.allowance === null ||
				// Read by the entry form, and null with the rest of them.
				outcome.freeMinorLeagueSlots === null
			) {
				return 'no Team, so no Roster Count';
			}
			// **The one-branch rule no longer holds, and it is the rule that
			// changed rather than the rendering.** Until Story 10.1 the gate
			// was a single comparison, so the row could state that one
			// arithmetic and let the chip beside it state the verdict. FR-37
			// now decides on one of THREE — the allowance met, the allowance
			// spent, or the precondition failed before the allowance is
			// reached — and a row stating only `Roster Count would be 13 of
			// 12` cannot tell a permitted second bid apart from a refused
			// thirteenth Player. Each form names the figure its own branch
			// actually read.
			const projected = outcome.rosterCount + outcome.projectedAdditions;
			const roster = `Roster Count would be ${String(projected)} of ${String(outcome.ceiling)}`;
			// Counts only — this outcome carries no amount to name it in
			// anything else, which is exactly the design (FR-37). The SLOTS-side
			// overflow, never the money side's (Story 10.2).
			const overflow =
				outcome.activeBenchOverflow === null || outcome.activeBenchOverflow === 0
					? ''
					: `, Active/Bench Overflow ${String(outcome.activeBenchOverflow)}`;

			// **The fifth form: a lottery entry, passing or refused.** It names
			// the two figures FR-18's branch actually read and no others —
			// quoting a permitted-bid count would be false in both directions,
			// since an entry neither spends the allowance nor is bounded by it.
			// One form for both verdicts, because the chip beside it already
			// states which, and the arithmetic a Manager needs is the same
			// either way.
			if (outcome.isContentionEntry) {
				return (
					`a lottery entry against ${String(outcome.freeActiveBenchSlots)} free ` +
					`Active/Bench and ${String(outcome.freeMinorLeagueSlots)} free Minor League ` +
					`Slots; ${roster}${overflow}`
				);
			}

			if (outcome.passed) {
				// The `P = 0` branch needs no free Slot and spends no
				// allowance, so counting it as a permitted bid would print
				// `your 0th of 3` on a stash. `EXPERIENCE.md`'s original row,
				// unchanged, is the honest figure there.
				if (outcome.projectedAdditions === 0) return `${roster}${overflow}`;
				// The allowance met. The permitted-bid count comes FIRST
				// because at the allowance `projected` legitimately exceeds
				// the ceiling — §10 example 29 passes at 13 of 12 — and a
				// row opening on that number beside a `Passed` chip reads as
				// a contradiction until the clause before it explains why.
				return (
					`your ${ordinal(outcome.projectedAdditions)} of ` +
					`${String(outcome.allowance)} permitted bids; ${roster}${overflow}`
				);
			}

			// Refused on the precondition: no free Slot, so the allowance
			// never applied. The figure does not quote it, for the same
			// reason the sentence does not.
			if (outcome.freeActiveBenchSlots === 0) {
				return `no free Active/Bench Slot; ${roster}${overflow}`;
			}

			// Refused at the allowance: there was room, and this bid is one
			// past what it permits.
			return (
				`your ${ordinal(outcome.projectedAdditions)} outstanding bid against ` +
				`${String(outcome.allowance)} permitted; ${roster}${overflow}`
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
	// The glossary term for the LEAGUE-wide state, so the chip reads
	// `Auction Phase · Refused` and is never read as the `Auction Clock ·
	// Refused` row directly beneath it. One is about this Auction's 24 hours;
	// the other is about whether the league is bidding at all.
	phase: 'Auction Phase',
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
				'the amount is not a figure the field can read. It is read in millions, so enter ' +
				'$10.5M as 10.5 — digits and at most one decimal point, with no comma.'
			);
		case 'negative_amount':
			return (
				'the amount is negative, and a Bid is what you are offering to pay. Enter it as a ' +
				'positive figure in millions.'
			);
		case 'dollars_not_millions':
			return (
				`the amount is read in millions, so the whole Salary Cap — ${formatMoney(parseMoney(SALARY_CAP))} — ` +
				'is entered as 165, and nothing larger can be a Bid. This looks like a figure in ' +
				'whole dollars: enter $10.5M as 10.5, not as 10500000.'
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

/**
 * The one word an Auction history row carries when the Bid on it was
 * cancelled (Story 10.6, FR-40).
 *
 * **It is not "void", and the distinction is the whole point** (UX-DR38). A
 * void says somebody decided the Bid should not have stood. A cancellation
 * says nothing of the kind: the Bid was good, it stood, and it was taken back
 * automatically when the bidding Team's roster filled elsewhere. One word here
 * and one sentence below, so no surface has to choose between two framings.
 */
export const BID_CANCELLED_LABEL = 'cancelled';

/**
 * Why a Bid in this Auction's history no longer stands, naming the win that
 * caused it.
 *
 * **The cause is named by its PLAYER.** `BidCancellation` carries
 * `causeFantraxPlayerId` and `causePlayerName` and no cause Team name
 * (`projection/auctions.ts`) — and it needs none, because the Team that won
 * elsewhere is the same Team this cancelled row already names as its bidder.
 * The cascade only ever takes back the WINNING Team's own leftover
 * commitments.
 *
 * `restored` is `cancellation.restoration !== null` — whether anyone took the
 * lead behind it. `false` is never "there was nobody below": it is "nobody
 * below could still keep it", which is why the second form states the
 * consequence for the Auction rather than the state of its history. The
 * Auction then renders as the unbid nomination the board already has, with
 * this history intact.
 *
 * No apology, no alarm, and no verb suggesting anyone judged the Bid.
 */
export function bidCancelledSentence(causePlayerName: string, restored: boolean): string {
	const cause = `Cancelled when this Team won ${causePlayerName}.`;
	return restored
		? `${cause} The next-highest Bid now leads.`
		: `${cause} No surviving Bid could take the lead.`;
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
 * The `ContentionDissolved` payload: which Auction dissolved, the seed it
 * reveals, the commitment that seed was published against, and who was in
 * (Story 3.3, FR-19, AD-14).
 *
 * **The reveal is the reason this event exists.** A dissolved contention will
 * never draw, so nothing later would ever open the envelope: the seed would
 * stay sealed in a table no role can read, behind a commitment a Manager
 * recorded and could never check. That is the one outcome AD-14 cannot
 * survive. `decide()` therefore hashes the sealed seed it was handed and
 * compares it against `state.seedHash` BEFORE building this payload — a
 * mismatch throws and no event reaches the log.
 *
 * `seedHash` is restated here rather than left to be looked up on the opening
 * `BidPlaced`: the reveal and the commitment it answers belong in one event,
 * so a Manager checking the pair reads one row rather than joining two, and
 * `null` states honestly that there was nothing to check against.
 *
 * **Three fields no reducer reads, on purpose.** `auctionsReducer` folds
 * `fantraxPlayerId` and `seed` and nothing else. `formerContenders`,
 * `convertingTeamId` and `amount` ride along because Epic 5's dispatcher must
 * reach every Team that was in from ONE event without re-folding the log, and
 * Story 3.6 will append the ordered list at expiry for the same reason. A
 * field nothing reads yet is worth flagging; these are named so a reviewer
 * sees the choice rather than the omission.
 *
 * `formerContenders` are Team IDS in ascending join `seq` — the fold's own
 * order, which AD-14 pins as an input to a winner. Ids and not names because
 * that is what a dispatcher resolves a destination from, and because
 * `BidState` narrows the Contender list to ids precisely so no rule can come
 * to depend on a Team's display name.
 *
 * **It is the whole list, unfiltered, and it is not a list of Teams that were
 * released.** FR-19 permits a Contender to be the converting bidder, and that
 * Team is on this list — it was not released, it became the Leading Bidder.
 * The list is not filtered to exclude it, because what this field records is
 * the Contender list as it STOOD when the contention dissolved: that is the
 * historical record the reveal is about, it is the ordered list Story 3.6
 * needs, and a list quietly missing whoever converted would not be the list
 * anybody checks the commitment against. `convertingTeamId` beside it is how
 * a consumer excludes the converter, so the two together answer both
 * questions and neither field has to lie about the other.
 */
export type ContentionDissolvedPayload = {
	readonly fantraxPlayerId: string;
	/** The seed, revealed. The one place it ever enters `auction_events`. */
	readonly seed: string;
	/** The commitment it was published against, or `null` if none ever was. */
	readonly seedHash: string | null;
	/**
	 * The Contender list as it stood when the contention dissolved, in
	 * ascending join `seq` (AD-14) — ids, unfiltered.
	 *
	 * NOT "the Teams released": the converting Team is on it whenever a
	 * Contender converts its own lottery, and that Team came out of this
	 * leading rather than released. See the header above.
	 */
	readonly formerContenders: readonly string[];
	/** The Team whose Bid dissolved it — the new Leading Bidder. */
	readonly convertingTeamId: string;
	/** The converting amount, in integer dollars (AD-8). */
	readonly amount: number;
};

/**
 * The seed `decide()` is handed, and which half of the commit-reveal it is
 * for (Story 3.3).
 *
 * **A union, and not two adjacent nullable strings.** The two are never both
 * meaningful: `fresh` is the seed a lottery-OPENING commits to and needs
 * `leadingBid === null`, `sealed` is the seed a DISSOLUTION reveals and needs
 * `contention === 'minimum_bid'`. Two parameters would have made "both
 * supplied" and "the wrong one supplied" expressible states that `decide()`
 * would then have had to rule out by hand; one discriminated value makes the
 * question `kind` and nothing else.
 *
 * `null` is the third case and by far the commonest: an ordinary raise, an
 * opening above the minimum, a join. Every call site that passed `null`
 * before Story 3.3 still passes `null` and is unchanged, so the diff lands
 * exactly where the rule changed.
 *
 * The shell chooses which: `server/bidding.ts` generates a fresh seed on
 * every call and reads the sealed one under the lock when the folded Auction
 * is a live contention. The core never generates and never stores — it
 * hashes a `fresh` one onto the opening payload, and verifies then publishes
 * a `sealed` one on a dissolution.
 */
export type ContentionSeed =
	| { readonly kind: 'fresh'; readonly seed: string }
	| { readonly kind: 'sealed'; readonly seed: string };

/**
 * The seed of the required kind, or a `TypeError` naming what was missing.
 *
 * The ONE narrowing from `ContentionSeed | null` to the `string` the two
 * commit-reveal branches need, so neither branch below carries a `null` case
 * the invariant has already ruled out — a dead branch hides the real
 * invariant instead of stating it.
 *
 * It THROWS rather than returning `null`, and that is AD-1's distinction: a
 * shell that reached an opening or a dissolution without the right seed in
 * hand is a bug, not something a Manager did, and a Manager-facing refusal
 * would send them away to fix something that is not theirs. The message names
 * the kind that was required and the kind that arrived; neither is secret.
 */
function seedFor(seed: ContentionSeed | null, kind: ContentionSeed['kind'], what: string): string {
	if (seed === null || seed.kind !== kind) {
		throw new TypeError(
			`decide: ${what} (AD-14); received ${seed === null ? 'null' : `kind "${seed.kind}"`}`
		);
	}
	return seed.seed;
}

/**
 * Authorise a `PlaceBid`, or refuse it with the full gate set.
 *
 * **Every gate outcome comes from `evaluate()`**, called once, here. Nothing
 * below re-derives a comparison the evaluator already made — that is AD-1's
 * "one evaluator, two consumers" holding structurally rather than by
 * convention.
 *
 * On acceptance it emits ONE `BidPlaced` envelope — or, on a dissolution,
 * TWO: the `BidPlaced` that caused it and the `ContentionDissolved` that
 * follows from it, in that order. Cause then consequence, appended by the one
 * `runTransactionalWrite` loop that has always supported N events. Their
 * `occurredAt` is not set here: `runTransactionalWrite` stamps every appended
 * event with the database's transaction-start clock (AD-3), and `now` — the
 * same instant, handed in as a string — is what the close instant is computed
 * from, so the event's timestamp and its `closesAt` are exactly
 * `AUCTION_CLOCK` apart by construction.
 *
 * **`seed` is read since Story 3.2 and is a `ContentionSeed` union since
 * 3.3.** Nothing here generates it — the core reads no randomness (AD-2) —
 * and nothing here stores it. Two things are done with it, and which one
 * depends on `kind`:
 *
 *  - `fresh`, on the Bid that OPENS a Minimum-Bid Contention: `hash(seed)`
 *    goes onto the payload and the raw string appears nowhere. The shell
 *    writes it to `auction_contention_seeds` in the same transaction by
 *    reading the `seedHash` this function published, never by re-deriving the
 *    rule.
 *  - `sealed`, on the Bid that DISSOLVES one: the seed is verified against
 *    the published commitment and then REVEALED, on `ContentionDissolved`.
 *    This is the only path by which a seed ever enters `auction_events`.
 *
 * **Verify, then reveal.** A dissolution whose seed does not hash to
 * `state.seedHash` throws before any payload is built, so publishing a reveal
 * that contradicts the commitment a Manager already checked is foreclosed
 * structurally rather than merely tested for. A commitment that folded to
 * `null` — a corrupt log — reveals anyway: there is nothing to verify
 * against, and refusing would strand the Auction in a contention forever.
 *
 * **A missing or wrong-kinded seed THROWS**, on an opening and on a
 * dissolution alike, and that is AD-1's distinction rather than strictness
 * for its own sake: a shell that failed to supply a seed is a bug, not
 * something a Manager did, and a Manager-facing refusal would send them away
 * to fix something that is not theirs. Every other Bid ignores the parameter
 * entirely, so a caller with genuinely no randomness in hand — a test of a
 * raise, say — passes `null` and is unaffected.
 *
 * **The close instant is the contention's own on a join.** A join stamps
 * `state.closesAt` verbatim; an opening, a raise or a DISSOLUTION computes a
 * fresh `closeInstantFor(now, AUCTION_CLOCK)` — which is FR-19's "the Auction
 * Clock is reset to 24 hours from the converting Bid", and it needed no line
 * of its own, because a dissolution is not a join. See the fixed-clock note
 * below.
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
	seed: ContentionSeed | null
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
	// An opening, a raise or a DISSOLUTION computes a fresh one, which is the
	// 24-hour restart `BID_CONSEQUENCE` promises — and which, for a
	// dissolution, is FR-19's "the Auction Clock is reset to 24 hours from the
	// converting Bid", arrived at with no branch of its own because a
	// dissolution is simply not a join.
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
	//
	// **A lottery ALREADY running is not one about to start** (Story 10.5).
	// Until 10.5 the two halves could not disagree: an Auction with no leader
	// was never in a Minimum-Bid Contention, so `leadingBid === null` alone
	// meant `contention !== 'minimum_bid'` too. 10.5 created the pairing —
	// FR-40's cascade can cancel every join, and the lottery keeps its
	// contention and its fixed clock so the empty outcome can be recorded. A
	// Team bidding `MINIMUM_BID` into that Auction is JOINING it, not opening
	// a second one: the commitment was published at the real opening and the
	// sealed seed row still exists. Without this clause the join would demand
	// a fresh seed the shell correctly did not supply — it passes the SEALED
	// one inside a live contention — and throw, and a second `seedHash` on the
	// payload would fire `recordContentionSeed` against a primary key that
	// already holds a row.
	const opensContention =
		state.contention !== 'minimum_bid' &&
		state.leadingBid === null &&
		contentionForAmount(command.amount) === 'minimum_bid';
	// **A missing or wrong-kinded seed is a shell bug and THROWS** (AD-1), on
	// both halves of the commit-reveal. `seedFor` is the one narrowing, so the
	// two branches below hold a `string` rather than a union nothing has ruled
	// out — no dead `null` branch stands where an invariant should.
	const freshSeed = opensContention
		? seedFor(
				seed,
				'fresh',
				'an Opening Bid that opens a Minimum-Bid Contention requires a fresh seed; the shell ' +
					'must supply one'
			)
		: null;

	// Does this Bid DISSOLVE a Minimum-Bid Contention? Asked off the gate that
	// already classified the amount rather than re-derived from the two
	// thresholds — `evaluateContention` owns every amount question inside a
	// lottery, and a second comparison here would be a second judgement about
	// one Bid. `converts` is only ever reported inside a live contention, so
	// this is the whole test.
	//
	// A shell that reached here without the sealed seed is a bug, and the
	// failure it would otherwise cause is the one AD-14 cannot survive: a
	// contention released with its commitment never opened. The throw aborts
	// the transaction and appends nothing.
	const sealedSeed =
		gates.contention.entry === 'converts'
			? seedFor(
					seed,
					'sealed',
					'a Bid that dissolves a Minimum-Bid Contention requires the sealed seed; the shell ' +
						'must read it under the lock'
				)
			: null;

	// **Verify, then reveal.** The published commitment is what a Manager
	// recorded when the lottery opened; a reveal that does not hash to it is
	// the failure the whole commit-reveal exists to make impossible, so it is
	// refused HERE rather than detected later. Both digests are named, because
	// the point of the message is to let whoever reads it see which value went
	// wrong — and both are public, so naming them leaks nothing.
	//
	// A `null` `seedHash` on a live contention is a corrupt log, and the reveal
	// proceeds regardless: there is nothing to verify against, and refusing
	// would leave the Auction in a contention forever with nothing able to
	// dissolve it. The page states that the reveal is unverifiable.
	if (sealedSeed !== null && state.seedHash !== null) {
		const revealed = hash(sealedSeed);
		if (revealed !== state.seedHash) {
			throw new TypeError(
				'decide: the sealed seed does not match the published commitment; hash(seed) is ' +
					`${revealed} and the log published ${state.seedHash} (AD-14)`
			);
		}
	}

	const payload: BidPlacedPayload = {
		fantraxPlayerId: command.fantraxPlayerId,
		teamId: command.teamId,
		teamName: command.teamName,
		managerId: command.managerId,
		amount: command.amount,
		closesAt,
		// `hash(seed)` and never the seed. Spread rather than set to `null`, so
		// the overwhelming majority of Bids carry no such key at all — and a
		// DISSOLUTION carries none either, which is what keeps
		// `recordContentionSeed` from writing a second seed row for one.
		...(freshSeed !== null ? { seedHash: hash(freshSeed) } : {})
	};

	const bidPlaced: EventEnvelope = {
		type: BID_PLACED_EVENT,
		payload,
		managerId: command.managerId,
		teamId: command.teamId
	};

	if (sealedSeed === null) {
		const accepted: Accepted<readonly EventEnvelope[]> = { kind: 'accepted', events: [bidPlaced] };
		return accepted;
	}

	// Cause, then consequence. `runTransactionalWrite` has always appended N
	// events in order under one lock, so two is no new machinery — and the
	// order is the rule: a log read in `seq` order states the Bid that
	// dissolved the contention before it states the dissolution.
	const dissolved: ContentionDissolvedPayload = {
		fantraxPlayerId: command.fantraxPlayerId,
		// The seed, revealed — the one place it ever enters the log, and only
		// after the comparison above.
		seed: sealedSeed,
		seedHash: state.seedHash,
		// The fold's own order, never re-sorted and never filtered: AD-14 makes
		// it an input to a winner, and it is carried WHOLE so Epic 5 can reach
		// every Team that was in without re-folding the log. A Contender that
		// converted its own lottery is on it, and `convertingTeamId` below is
		// how a consumer tells that Team apart from the ones that were
		// released.
		formerContenders: state.contenders,
		convertingTeamId: command.teamId,
		amount: command.amount
	};

	const accepted: Accepted<readonly EventEnvelope[]> = {
		kind: 'accepted',
		events: [
			bidPlaced,
			{
				type: CONTENTION_DISSOLVED_EVENT,
				payload: dissolved,
				managerId: command.managerId,
				teamId: command.teamId
			}
		]
	};
	return accepted;
}
