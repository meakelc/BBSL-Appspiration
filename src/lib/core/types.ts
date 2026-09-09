/**
 * Commands, events, rejections and state for the pure core.
 *
 * Story 1.5 adds only the generic event-log shapes the transactional shell
 * needs now — `EventEnvelope`, what a caller's `decide()` hands the shell to
 * persist, and `AppendedEvent`, what comes back once the database has
 * assigned it a place in the log. Epic 2 fills in the rest: domain-specific
 * command and event variants (`PlaceBid`, `NominatePlayer`, ...) on top of
 * `EventEnvelope`, unchanged, plus the rules engine that gives them meaning.
 *
 * Shape already settled: commands are present-tense imperatives (PlaceBid,
 * NominatePlayer). A rule violation is a returned Rejected value carrying a
 * machine-readable reason plus its arithmetic components — a thrown exception
 * signals a bug and nothing else.
 *
 * Two entry points only: evaluate(), returning a fixed gate set per command
 * type, and decide(), which calls evaluate() rather than re-deriving its
 * outcomes.
 *
 * **Story 2.5 makes good on that promise for the first command.** `PlaceBid`,
 * `GateOutcome`, `GateResults`, `PLACE_BID_GATES`, `Accepted` and `Rejected`
 * are declared at the bottom of this file, which is where AD-1 says the gate
 * set lives — "fixed per command type, declared in `core/types.ts`". They are
 * declared here rather than beside `core/rules/bidding.ts` so a later story
 * adding the `cap` or `slots` gate edits ONE list and every consumer becomes
 * a compile error until it handles the addition.
 *
 * **Story 2.6 is the first story to spend that.** Adding `'cap'` to
 * `PLACE_BID_GATES` and one key to `PlaceBidGateResults` is the whole
 * declaration change; the rules module, the transaction, the read path and
 * the surface each stopped compiling until they handled the money gate,
 * which is precisely the property the single list was bought for.
 *
 * **Story 2.8 spends nothing of it, and that is the point.** Minors Exposure
 * is not a seventh gate: it is arithmetic the `cap` gate already named and
 * the `slots` gate already needed, so 2.8 widens two outcome shapes and
 * leaves `PLACE_BID_GATES` untouched. A gate list that grew for every rule
 * would stop being the thing a caller can be made to handle exhaustively.
 *
 * Still true, and deliberately: **no domain EVENT type is named in this
 * file.** `NominationPlaced`, `AuctionClosed` and `BidPlaced` are each
 * declared beside the reducer that gives them meaning
 * (`projection/nominations.ts`, `projection/auctions.ts`), and
 * `EventEnvelope` is not widened for any of them.
 *
 * Story 1.7 adds `RosterSlotKind`/`ParsedRosterRow` — the domain shape the
 * Fantrax adapter (`adapters/fantrax/roster-file.ts`) emits and
 * `core/rules/roster-import.ts` consumes. Neither a file, a Team, nor a
 * Fantrax Team ID appears here: the adapter resolves or validates those
 * before a row becomes one of these (AD-24 — "the core receives domain
 * types with no notion of a file").
 *
 * Story 1.8 adds `ParsedPoolRow` — the Free Agent pool's domain shape, the
 * pool adapter's (`adapters/fantrax/pool-file.ts`) sole output. Deliberately
 * carries no eligibility flag: Minor League Eligibility is app-owned and
 * defaults to not-eligible as a database column default, never read from the
 * file.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness, stdlib
 * only, relative .ts imports only so Deno can load it (AD-2).
 */

import type { Money } from './money.ts';
import type { LeaguePhase } from './projection/phase.ts';

/**
 * What a caller's `decide()` hands the transactional shell to append.
 *
 * Deliberately generic: no domain event type is named here (Epic 2 owns
 * that). `payload` is `unknown` because this module has no notion of what any
 * particular event's shape is — the shell serialises it into `auction_events`
 * as-is, and whatever reads it back is the one place that knows what to
 * expect for a given `type`.
 *
 * `managerId`/`teamId` are `string | null` **as a pair** (Story 3.7). They
 * were required from the first event onward (AD-4) on the stated grounds that
 * no system-originated event existed yet; `ContractAssignmentOpened` is the
 * first, and `20260901000000_system_actor.sql` relaxes both columns together
 * behind a check constraint that makes a half-null actor unwritable. Null
 * means nobody acted — the tick read a clock and the log says the phase
 * ended — and it is never a stand-in for an actor that could not be
 * resolved. Every existing construction site still compiles: `string` is
 * assignable to `string | null`, so widening this type made no caller a
 * compile error and no caller needed to change.
 *
 * `deviceClass`/`dispatchOutcome`/`deliveryOutcome` are the
 * measurement fields NFR §5 requires and are optional here because most
 * events populate none of them; the column they land in is nullable for the
 * same reason.
 */
export type EventEnvelope = {
	readonly type: string;
	readonly payload: unknown;
	/** The acting Manager, or `null` for a system event. Null with `teamId`. */
	readonly managerId: string | null;
	/** The acting Team, or `null` for a system event. Null with `managerId`. */
	readonly teamId: string | null;
	readonly deviceClass?: string | null;
	readonly dispatchOutcome?: string | null;
	readonly deliveryOutcome?: string | null;
};

/**
 * An `EventEnvelope` once the database has assigned it a place in the log.
 *
 * `seq` is `string`, not `number` or `bigint`. `pg` returns Postgres' `int8`
 * as a JS string — `money.ts` already established this driver-boundary
 * discipline for dollar amounts, and this is the same discipline for the
 * column folds are ordered by. Compare orderings via `BigInt(seq)`, never
 * `Number(seq)` or `<`.
 *
 * `occurredAt` is an ISO-8601 string: the shell's one transaction-start clock
 * read (AD-3), reused for every event the transaction appends, never
 * `Date.now()`. `deviceClass`/`dispatchOutcome`/`deliveryOutcome` are always
 * present here, as `string | null` rather than optional — the database
 * column is nullable but the row always has it, unlike the envelope a caller
 * may simply omit the key from.
 */
export type AppendedEvent = {
	readonly seq: string;
	readonly occurredAt: string;
	readonly schemaVersion: number;
	readonly coreVersion: number;
	readonly type: string;
	readonly payload: unknown;
	/** The acting Manager, or `null` for a system event. Null with `teamId`. */
	readonly managerId: string | null;
	/** The acting Team, or `null` for a system event. Null with `managerId`. */
	readonly teamId: string | null;
	readonly deviceClass: string | null;
	readonly dispatchOutcome: string | null;
	readonly deliveryOutcome: string | null;
};

// --- Story 1.7: the Fantrax roster import's domain shape -------------------

/**
 * The three roster slot kinds a Fantrax roster export's "Roster Slot" column
 * maps to (addendum.md B: "Active/Bench, IR, Minor League"). Written
 * snake_case, verbatim, to match `import_staged_rosters.roster_slot_kind`'s
 * database check constraint — the adapter and the database agree on the same
 * three literal strings rather than translating between two vocabularies.
 */
export type RosterSlotKind = 'active_bench' | 'injury_reserve' | 'minor_league';

/**
 * Where a close puts the won Player (Story 3.4) — a NARROWING of
 * `RosterSlotKind`, and the narrowing is the point.
 *
 * A close can produce exactly two of the three roster slot kinds. Injury
 * Reserve is a state a Team's own roster moves a Player into afterwards, in
 * Fantrax; no rule in this product can place a Player there at a close, so
 * the type the contracts fold holds and the type `slotPlacementFor` returns
 * cannot express it. `CapHitRow` accepts a `RosterSlotKind`, and this union
 * is assignable to it, so the Cap arithmetic needs no widening in either
 * direction.
 *
 * **It lives here beside `RosterSlotKind` rather than in
 * `projection/contracts.ts`**, which is where Story 3.4 first declared it.
 * `projection/nominations.ts` validates an `AuctionClosed`'s placement for
 * all three of the reducers that fold that event, and `contracts.ts` imports
 * from `nominations.ts` — so the union has to sit upstream of both or the
 * import graph closes a cycle. The story's Code Map named this move as the
 * one permitted edit to this file if the type "proves to want a home beside
 * `RosterSlotKind`". It did.
 */
export type SlotPlacement = 'active_bench' | 'minor_league';

/** The two placements a close can produce, for a total check over a payload. */
export const SLOT_PLACEMENTS: readonly SlotPlacement[] = Object.freeze([
	'active_bench',
	'minor_league'
] as const);

/**
 * One roster row exactly as the Fantrax adapter emits it (AD-24) — the only
 * shape `core/rules/roster-import.ts` and `server/roster-import.ts` see.
 *
 * `capHit` is already `Money`: the adapter parses the CSV cell through
 * `core/money.ts`'s `parseMoney` before a row reaches this shape, so nothing
 * downstream ever re-parses a raw CSV string. A Minor League row's `capHit`
 * carries exactly what the file stated — `core/rules/roster-import.ts`'s
 * `computeCapSpace` is what treats it as $0 against the Cap, not the adapter.
 */
export type ParsedRosterRow = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly capHit: Money;
	readonly rosterSlotKind: RosterSlotKind;
	readonly contractYearsRemaining: number;
};

// --- Story 1.8: the Free Agent pool's domain shape -------------------------

/**
 * One Free Agent pool row exactly as the pool adapter
 * (`adapters/fantrax/pool-file.ts`) emits it (AD-24) — the only shape the
 * server layer sees.
 *
 * Four fields, and nothing else (addendum.md B): Fantrax player id, name,
 * position(s), NBA team. No `Money` and no roster slot kind — a pool Player
 * has no contract, so Cap Space and slot-ceiling arithmetic simply do not
 * apply to one. **No eligibility field either**: Minor League Eligibility is
 * app-owned, not imported, and defaults to *not* eligible as a database
 * column default on the staged row (`import_staged_pool_players
 * .minor_league_eligible`). The adapter never derives, infers, or fails on
 * it, so there is nothing here for it to put.
 *
 * `positions` is the export's own text, verbatim, however it separates
 * several positions; nothing in this story parses them apart. `nbaTeam`
 * carries the export's own cell verbatim — expected to be the three-letter
 * capitalised abbreviation, which per the glossary always and only means a
 * Player's real-life NBA team, never a fantasy Team.
 *
 * **That expectation is not enforced, deliberately.** The pool column shape
 * is an unconfirmed placeholder until a real export lands (1.9/AR-33), so a
 * parser that refused anything but three capitals would refuse the real file
 * on the strength of a guess. The adapter checks only that the cell is
 * present and non-blank; tighten this to a validated format once the export
 * is confirmed, not before.
 */
export type ParsedPoolRow = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly positions: string;
	readonly nbaTeam: string;
};

// --- Story 2.5: the PlaceBid command and its fixed gate set ----------------

/**
 * The `PlaceBid` command (AD-1).
 *
 * Present-tense imperative, like `NominatePlayer`, and carrying nothing the
 * rules cannot decide from: the Auction it is aimed at, the Team acting, the
 * amount offered, and the acting Manager.
 *
 * `managerId` and `teamName` are on the command for the EVENT's sake, not
 * for any gate's. `auction_events.manager_id` is NOT NULL (AD-4) and the Bid
 * history names the acting Manager with no anonymity at any point, so
 * `decide()` must be able to build a `BidPlaced` naming both without reading
 * a table — the same reason `NominationPlacedPayload` carries `teamName`.
 * No gate in `PLACE_BID_GATES` reads either field; `evaluate()` decides from
 * `teamId` and `amount` alone.
 *
 * `amount` is already `Money`: it is branded at the runtime boundary that
 * received it (the form parse), never inside a rule (AD-8).
 */
export type PlaceBid = {
	readonly kind: 'PlaceBid';
	readonly fantraxPlayerId: string;
	readonly teamId: string;
	readonly teamName: string;
	readonly managerId: string;
	readonly amount: Money;
};

/**
 * What every gate reports, whatever arithmetic it carries beside it.
 *
 * `passed` and nothing else is common to all of them — a gate's own figures
 * are its own shape, because a caller rendering "Increment · Refused" beside
 * "Granularity · Passed" needs each gate's numbers, not a lowest common
 * denominator of them (AD-1's rejection of a singular `Rejected<reason>`).
 */
export type GateOutcome = { readonly passed: boolean };

/**
 * Every gate a command must pass, keyed by gate name.
 *
 * The general shape. A command type's own result — `PlaceBidGateResults`
 * below — is the specific one, and is assignable to this.
 */
export type GateResults = Readonly<Record<string, GateOutcome>>;

/**
 * The Opening Bid gate: an Auction with no Bid on it yet.
 *
 * `opening` states which of the four cases this is, so the wording and the
 * tests read one field rather than re-deriving the comparison:
 *
 *  - `not_an_opening` — a Bid already leads, so this gate has nothing to
 *    decide and passes. The increment gate owns the raise.
 *  - `above_the_minimum` — passes, and the Auction enters Standard Contention.
 *  - `at_the_minimum` — PASSES since Story 3.2, and the Auction enters a
 *    Minimum-Bid Contention. It was refused by name until then, because no
 *    Contender list, seed table or fixed clock existed to run one; all three
 *    exist now, and `contention` below owns every amount question inside the
 *    lottery this opening starts.
 *  - `below_the_minimum` — refused: an Opening Bid is at least `MINIMUM_BID`.
 */
export type OpeningGateOutcome = GateOutcome & {
	readonly opening: 'not_an_opening' | 'above_the_minimum' | 'at_the_minimum' | 'below_the_minimum';
	readonly offered: Money;
	readonly minimumOpening: Money;
};

/**
 * The Minimum-Bid Contention gate: every amount question INSIDE a lottery
 * (Story 3.2).
 *
 * **One gate, four questions, and they are one gate because they are one
 * rule.** Once an Auction sits at exactly `$1,000,000` the ordinary
 * arithmetic stops applying — there is no ascending raise to be short of, so
 * `increment` reports no rule applies — and what replaces it is a
 * classification of the offered amount against two fixed thresholds. Joining,
 * joining twice, the dead zone between the thresholds and the conversion that
 * dissolves the whole thing are all the same question asked of the same
 * amount, and splitting them across four gates would let a caller be handed
 * three passes and one refusal about a single comparison.
 *
 * `entry` states which case this is, so the wording and the tests read one
 * field rather than re-deriving the comparisons:
 *
 *  - `not_a_contention` — no lottery is running, so this gate has nothing to
 *    decide and passes. `contenderCount` is `0` because there are none, not
 *    because the figure is unknown.
 *  - `joins` — exactly `joinAmount`, from a Team not already on the list.
 *    Passes: this Bid joins the contention.
 *  - `already_contending` — exactly `joinAmount` from a Team that is already
 *    a Contender. Refused: a Team joins once, and every Contender holds the
 *    identical `$1,000,000`, so a second join would commit nothing new and
 *    buy a second chance at the draw.
 *  - `converts` — at or above `conversionAmount`. **PASSES since Story 3.3**:
 *    this is the Bid that dissolves the contention. It was refused by name
 *    until then, because accepting it as an ordinary raise would have
 *    released every Contender's commitment while leaving the seed sealed
 *    forever — exactly what AD-14's "no unopened commitment is left behind"
 *    forbids. `decide()` now appends `ContentionDissolved` beside the
 *    converting `BidPlaced`, revealing the seed against the published
 *    commitment, so the objection no longer holds. The comparison did not
 *    move and the case still names itself, so the panel's figure still says
 *    which case this was and the chip beside it states the outcome.
 *  - `neither` — strictly between the two thresholds. Refused: too high to
 *    join, too low to convert. §10 example 10's dead zone, which under the
 *    $500,000 grid contains no on-grid amount at all, so `granularity`
 *    refuses every member of it too.
 *
 * **No money figure beyond the two thresholds, and no close instant.** That
 * is `SlotsGateOutcome`'s and `ExpiryGateOutcome`'s structural discipline:
 * this gate decides what an amount MEANS inside a lottery, never whether a
 * Team can afford it (`cap`) and never whether the clock has run out
 * (`expiry`). `offered`, `joinAmount` and `conversionAmount` are the three
 * terms of its own comparison and nothing else is reachable from here.
 *
 * `contenderCount` is a COUNT, in the register `SlotsGateOutcome` already
 * uses: the refusal panel states how many Teams are in, which is the fact a
 * Manager reading "you are already a Contender" needs beside it.
 */
export type ContentionGateOutcome = GateOutcome & {
	readonly entry: 'not_a_contention' | 'joins' | 'already_contending' | 'converts' | 'neither';
	readonly offered: Money;
	/** Exactly this amount joins a contention — `MINIMUM_BID`. */
	readonly joinAmount: Money;
	/** At or above this dissolves one — `MINIMUM_BID + MINIMUM_INCREMENT`. */
	readonly conversionAmount: Money;
	/** How many Teams are Contenders already. `0` when no lottery is running. */
	readonly contenderCount: number;
};

/**
 * The self-bid gate: a Team cannot bid against itself.
 *
 * `leadingTeamId` is `null` when nothing leads yet, which is what makes the
 * gate pass on an opening without a special case.
 */
export type SelfBidGateOutcome = GateOutcome & {
	readonly actingTeamId: string;
	readonly leadingTeamId: string | null;
};

/**
 * The Minimum Increment gate: at least `current high + MINIMUM_INCREMENT`.
 *
 * `currentHigh` and `minimumLegal` are both `null` exactly when no Bid leads
 * — the rule genuinely does not apply to an Opening Bid, and stating a
 * minimum legal raise over a high that does not exist would be inventing
 * arithmetic. The gate passes in that case and says why through the nulls.
 */
export type IncrementGateOutcome = GateOutcome & {
	readonly offered: Money;
	readonly currentHigh: Money | null;
	readonly minimumLegal: Money | null;
};

/**
 * The granularity gate: a whole multiple of `MINIMUM_INCREMENT`.
 *
 * Written separately from the increment gate even though the two coincide in
 * Standard Contention (PRD §10 example 2 says so outright), because this is
 * the one that catches an off-grid amount where the increment rule does not
 * apply — §10 example 26's `$1,000,001` in a Minimum-Bid Contention.
 */
export type GranularityGateOutcome = GateOutcome & {
	readonly offered: Money;
	readonly grid: Money;
};

/**
 * One earlier Auction whose leading amount is inside Minors Exposure —
 * carried so a refusal can NAME it (Story 2.8, PRD §10 example 19).
 *
 * The Player's NAME is on it, not only the id: §10 example 19 says "the
 * message names the $30,000,000 auction as the cause", and an id is not a
 * name a Manager recognises at 4am. The amount is the one actually held
 * against the Cap for that Auction — the leading amount, or the flat
 * `MINIMUM_BID` where a Minimum-Bid Contention is running.
 *
 * Only the OVERFLOWING Auctions appear, and only the earlier ones: the
 * prospective Bid may itself be the amount exposure sums (§10 example 20),
 * but naming the Auction a Manager is looking at as the cause of its own
 * refusal would be a sentence that explains nothing.
 */
export type ExposingBid = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly amount: Money;
};

/**
 * The money gate: a Bid may not exceed its Team's Maximum Bid (Story 2.6).
 *
 * Every figure the refusal panel prints is here, and they are here rather
 * than derived a second time by a caller because AD-7 makes the derivation
 * the core's — a displayed figure is a rendering, and only a freshly
 * computed one may authorise a Bid.
 *
 * **They sum, and the panel prints them summing.**
 * `capSpace − committedBids = availableCapSpace`, and
 * `availableCapSpace − rosterReserve = maximumBid`. `committedBids` itself
 * is the Team's leading amounts on open non-eligible Auctions plus
 * `minorsExposure`. Every one sits on the $500,000 grid, which is what makes
 * the abbreviated `$14.5M` rendering add up as displayed (AD-8).
 *
 * **All eleven nullable figures are `null` together, and only when the
 * acting party is bound to no Team.** There is no cap arithmetic for a
 * Manager who has no Team, and stating `$0` would be an invented figure a
 * refusal panel would then print — the same reason `IncrementGateOutcome`
 * nulls its two figures on an opening. The gate PASSES in that case: the
 * real refusal is `unbound_actor`, raised by the route before any
 * transaction opens, and `server/bidding.ts` always has a bound actor, so
 * the null case is reachable only on the read path. `unbounded` is `false`
 * there and `exposingBids` is empty, because neither is a figure — a
 * boolean that is absent and a boolean that is false are the same false, and
 * a list of Auctions nobody leads is genuinely empty.
 *
 * **Story 2.8's four exposure figures.** `freeMinorLeagueSlots` is `M`,
 * `eligibleLeadingBids` is `N` on the POST-BID basis, `overflowCount` is
 * `max(0, N − M)`, and `minorsExposure` — already named here since 2.6 — is
 * finally the sum of the `Overflow Count` largest amounts in that post-bid
 * set rather than a frozen zero. `exposingBids` names the earlier Auctions
 * that sum ran over, so §10 example 19's refusal can say which one.
 *
 * **`unbounded` is a flag beside the arithmetic, not a discriminated
 * `maximumBid`.** When a Free Minor League Slot absorbs this Player at a $0
 * Cap Hit (FR-35, PRD §3) the offered amount is compared to nothing at all,
 * and the figure is rendered IN WORDS — "no cap limit" — never as a number.
 * `maximumBid` still carries the ordinary subtraction, because unbounded is
 * not a waiver: `availableCapSpace − rosterReserve ≥ 0` still decides, which
 * is PRD §3's "provided Roster Reserve remains coverable" and FR-13's "only
 * the Roster Reserve check and the ordinary increment rules apply there".
 *
 * `rosterCount` and `projectedAdditions` are counts, not money, and are the
 * two inputs to `rosterReserve`. Story 2.7's `slots` gate refuses on those
 * same two figures and carries its OWN copy of them on `SlotsGateOutcome`:
 * reporting a capacity refusal as a cap refusal is a defect (AD-7), so the
 * two gates share the derivation — `projectedAdditionsFor` in
 * `rules/bidding.ts` — and never the outcome.
 *
 * **Story 10.2 changes what that shared derivation counts, on this side
 * too.** PRD §3 defines Projected Active/Bench Additions with Minimum-Bid
 * Contention entries excluded "however many the Team holds", and there is
 * one such definition rather than a money one and a slots one — so the
 * entries a Team already holds drop out of `projectedAdditions` here as
 * well, which makes `rosterReserve` LARGER and therefore stricter. What
 * this gate does not do is treat the Bid being PLACED as an entry: it calls
 * `projectedAdditionsFor` with one argument, the classification defaults to
 * `false`, and the prospective Bid is counted as an ordinary commitment.
 * That is the stricter reading of a Bid whose landing place is still
 * hypothetical, and it is why the two gates can now report different
 * `projectedAdditions` for one Team — §10 example 34's tenth entry is
 * refused on money at a Maximum Bid of $0 precisely because of it.
 */
export type CapGateOutcome = GateOutcome & {
	readonly offered: Money;
	readonly capSpace: Money | null;
	readonly committedBids: Money | null;
	readonly minorsExposure: Money | null;
	readonly availableCapSpace: Money | null;
	readonly rosterCount: number | null;
	readonly projectedAdditions: number | null;
	readonly rosterReserve: Money | null;
	readonly maximumBid: Money | null;
	/** Free Minor League Slots (`M`) — `max(0, 3 − occupied)`. */
	readonly freeMinorLeagueSlots: number | null;
	/**
	 * Eligible Leading Bids (`N`), counting the Bid being placed.
	 *
	 * **Unchanged by Story 10.2 — the arithmetic here is exactly what it
	 * was.** It has always included Minimum-Bid Contention entries and it
	 * still does, because a Contender who wins pays and the cap must carry
	 * that exposure (FR-14, FR-18). What 10.2 added is a COUNTERPART on the
	 * other gate, not an amendment to this one: `SlotsGateOutcome` reports
	 * `eligibleLeadingBidsExcludingEntries`, one subtraction away, and the
	 * two are legitimately different numbers for one Team at one instant
	 * (§10 example 35: 3 here against 0 there). The name on this field was
	 * left alone deliberately — renaming a figure whose value did not move
	 * would imply a change to the cap that has not happened.
	 */
	readonly eligibleLeadingBids: number | null;
	/**
	 * `max(0, N − M)` — how many eligible wins have nowhere to land.
	 *
	 * **Overflow Count, the money-side figure, and Story 10.2 left its
	 * arithmetic alone.** It feeds Minors Exposure and nothing else. What
	 * changed is that the slots gate stopped reading it: that gate now has
	 * `activeBenchOverflow` — one subtraction away, entries removed — and
	 * must never quote this one (PRD §3, FR-18).
	 */
	readonly overflowCount: number | null;
	/**
	 * Whether Maximum Bid does not bound the offered amount at all: a Free
	 * Minor League Slot absorbs this Player at a $0 Cap Hit. Rendered in
	 * words, never as a number — and never a waiver of Roster Reserve.
	 */
	readonly unbounded: boolean;
	/** The EARLIER Auctions inside Minors Exposure. Empty when there are none. */
	readonly exposingBids: readonly ExposingBid[];
	/**
	 * Whether the Bid being placed is itself one of the amounts Minors
	 * Exposure summed.
	 *
	 * The refusal never NAMES this Auction — telling a Manager that the
	 * Auction they are looking at causes its own refusal explains nothing —
	 * but it must still ACCOUNT for it. When the overflow slice holds both
	 * this Bid and an earlier lead, naming only the earlier one prints a
	 * figure the named amounts do not add up to, and a breakdown that does
	 * not sum is the one thing the panel may never be.
	 */
	readonly exposureIncludesThisBid: boolean;
};

/**
 * The slots gate: a Bid may not take a Team past Roster Capacity (Story 2.7,
 * FR-37).
 *
 * A SECOND, INDEPENDENT ground beside `cap`, and independent structurally
 * rather than by convention: there is no `offered` field and no money figure
 * on this shape at all, so a gate that cannot see the amount has no way to be
 * quietly folded into the money one. A Team can fail this with unlimited Cap
 * Space and pass it with none.
 *
 * **A lottery entry is gated by FR-18 and not by FR-37 at all (Story
 * 10.2).** A Minimum-Bid Contention entry contributes nothing to
 * `projectedAdditions`, spends no Outstanding Bid Allowance, and is asked
 * one question instead: has the win somewhere to land — a free Active/Bench
 * Slot, or an eligible Player with a free Minor League Slot. Cap space is
 * the only quantitative limit on how many a Team may hold, so a tenth entry
 * is refused on money and never here. `isContentionEntry` records that the
 * entry branch was the one that decided.
 *
 * **The gate learns that from the CONTENTION gate's verdict, never from an
 * amount.** `evaluateContention` classifies the Bid as `joins`,
 * `already_contending`, `converts`, `neither` or `not_a_contention`, and
 * only the first two are entries. A $5,000,000 conversion into a live
 * lottery is an ordinary Active/Bench commitment and is gated as one — which
 * a naive `contention === 'minimum_bid'` test would have got wrong, letting
 * a Team at its allowance take a third.
 *
 * **The rule has TWO branches for every other Bid (FR-37, amended
 * 2026-09-08).** It passes when
 * `projectedAdditions` is zero — the Minor-League carve-out, where the win
 * lands in a Free Minor League Slot and adds nothing to Active/Bench — OR
 * when the Team holds at least one Free Active/Bench Slot AND
 * `projectedAdditions <= freeActiveBenchSlots + OUTSTANDING_BID_ALLOWANCE`.
 * Everything else is refused.
 *
 * **The free-Slot precondition is tested BEFORE the allowance arithmetic,
 * and the ordering is the rule rather than an implementation detail.** With
 * `freeActiveBenchSlots` at 0 the allowance still evaluates to 1, so a Team
 * with a full roster would be admitted at `1 <= 1` and would go on to win a
 * thirteenth Player with no other Close available to cancel the surplus
 * (§10 example 30). The precondition is what makes the allowance safe.
 *
 * **`ceiling` is reported on every evaluation, pass and refusal alike**, and
 * it is still 12. The allowance is one extra outstanding BID, never a
 * thirteenth Slot; a refusal quoting only the allowance would imply thirteen
 * players are legal, which is the one thing this shape may never say. So the
 * outcome carries all five figures — `rosterCount`, `projectedAdditions`,
 * `freeActiveBenchSlots`, `allowance` and `ceiling` — and the wording picks
 * which of them a given sentence needs.
 *
 * The counts are on the same POST-BID basis Roster Reserve uses —
 * `projectedAdditions` counts the Bid being placed. The two figures are
 * `CapGateOutcome`'s two counts
 * over again, deliberately copied rather than pointed at: two rows each
 * stating their own arithmetic cannot be read as one, and reporting a
 * capacity refusal as a cap refusal is a defect (AD-7). The shared
 * DERIVATION is `projectedAdditionsFor` in `rules/bidding.ts` — but since
 * Story 10.2 the two gates hand it different arguments and may report
 * different counts, because a lottery entry is an Active/Bench addition to
 * the cap and to nothing else. Neither figure is wrong; they answer two
 * questions.
 *
 * **Story 2.8 adds three COUNTS and no money, which is what lets the
 * capacity gate see Minors Exposure without seeing a dollar.** An eligible
 * win that overflows has to land in an Active/Bench Slot, so
 * `projectedAdditions` includes `activeBenchOverflow` — and that is
 * `max(0, N_slots − M)`, two integers. `freeMinorLeagueSlots` and
 * `eligibleLeadingBidsExcludingEntries` ride along so a capacity refusal can
 * name the overflow in counts alone (§10 example 25). There is still no
 * `offered` field and still no money field on this shape, so FR-37's "fails
 * with unlimited Cap Space, passes with none" remains a property of the
 * signature rather than a claim to verify by reading.
 *
 * `rosterCount`, `projectedAdditions`, `freeActiveBenchSlots`, `allowance`
 * and the three Minors counts are `null` together, and only for an actor
 * bound to no Team — exactly as
 * `CapGateOutcome`'s nullable figures are, and for the same reason: stating
 * `0` would be an invented figure a refusal panel would then print. The gate
 * PASSES in that case, because the real refusal is `unbound_actor`.
 * `ceiling` is never null: `ACTIVE_BENCH_SLOTS` is a league constant, true
 * of a Team that does not exist.
 */
export type SlotsGateOutcome = GateOutcome & {
	readonly rosterCount: number | null;
	readonly projectedAdditions: number | null;
	readonly ceiling: number;
	/**
	 * Free Active/Bench Slots (`F`) — `max(0, 12 − rosterCount)`, the room
	 * the Team has BEFORE this Bid. Both the precondition (`F >= 1`) and the
	 * allowance (`F + 1`) are read off it, and the refusal wording names it,
	 * so it is reported rather than left for a surface to re-derive.
	 *
	 * **It counts FILLED roster slots only, and deliberately ignores the
	 * slots the Team's other outstanding Bids would claim** — `rosterCount`
	 * alone, never `rosterCount + projectedAdditions`. That asymmetry IS the
	 * mechanism of §10 example 29: the Team's one free Slot is what earns it
	 * the allowance, and the second outstanding Bid it then holds must not
	 * consume the very figure that permitted it. Netting the leads out here
	 * would collapse the allowance back into the ceiling comparison it
	 * replaced.
	 */
	readonly freeActiveBenchSlots: number | null;
	/**
	 * `F + OUTSTANDING_BID_ALLOWANCE` — the outstanding Active/Bench Bids
	 * this Team may hold.
	 *
	 * **Raw, and unclamped by the precondition**: at `F = 0` this is still 1,
	 * because §10 example 30's whole lesson is the counterfactual arithmetic
	 * that would have admitted a thirteenth Player. The precondition refusal
	 * must therefore never QUOTE it — saying "1 permitted" while permitting
	 * none is exactly the confusion the two separate sentences exist to
	 * avoid.
	 */
	readonly allowance: number | null;
	/** Free Minor League Slots (`M`). A count — this gate reads no amount. */
	readonly freeMinorLeagueSlots: number | null;
	/**
	 * `N` on the SLOTS side: eligible leads elsewhere with Minimum-Bid
	 * Contention entries removed, plus the Bid being placed when it is
	 * eligible and is not itself an entry.
	 *
	 * Deliberately NOT `CapGateOutcome.eligibleLeadingBids`, which counts the
	 * entries. The name carries the difference because a wording that quoted
	 * the money-side figure inside a capacity refusal would state a count the
	 * capacity rule never read.
	 */
	readonly eligibleLeadingBidsExcludingEntries: number | null;
	/**
	 * **Active/Bench Overflow** — `max(0, N_slots − M)`, the eligible wins
	 * that must land in Active/Bench, and the only overflow figure that
	 * reaches `projectedAdditions` (PRD §3, Story 10.2).
	 *
	 * §10 example 35 is the pair disagreeing on purpose: `Overflow Count 2`
	 * on `CapGateOutcome` against `Active/Bench Overflow 0` here, same Team,
	 * same instant, both correct.
	 */
	readonly activeBenchOverflow: number | null;
	/**
	 * Whether this Bid was gated as a Minimum-Bid Contention entry — FR-18's
	 * landing test rather than FR-37's two branches.
	 *
	 * **Recorded because it decides which sentence the panel may say.** An
	 * entry refused for want of a landing place has not spent an allowance
	 * and has not met a full roster in the ordinary way, and a refusal
	 * telling a Manager otherwise would be false. Not nullable: the
	 * classification comes from `evaluateContention`, which knows nothing
	 * about the Team, so it is as true of an unbound actor as of a bound one.
	 */
	readonly isContentionEntry: boolean;
};

/**
 * The expiry gate: an Auction whose Auction Clock has run out takes no
 * further Bid (Story 3.1, AD-12).
 *
 * **Two instants and nothing else.** `closesAt` is the persisted absolute
 * close instant the `BidPlaced` payload carried and `auctionsReducer`
 * folded; `evaluatedAt` is the `now` the shell injected and it was compared
 * against. There is no `offered` field, no money field and no count on this
 * shape at all — the same structural discipline `SlotsGateOutcome` uses to
 * keep a capacity refusal from being read as a cap refusal, applied to a
 * refusal that is about neither. A gate that cannot see an amount cannot
 * quote one.
 *
 * **The pair is what makes a refusal checkable.** A Manager reading "this
 * Auction expired two hours ago" can see both the instant it was due and the
 * instant it was judged at, which is the same reason `CapGateOutcome`
 * carries its terms rather than only its verdict.
 *
 * `closesAt` is `null` for a nominated Player nobody has bid on — no Opening
 * Bid, so no clock — and the gate PASSES in that case. `evaluatedAt` is
 * never null: it is whatever string the caller passed, including the empty
 * one, because reporting what was compared is the point.
 */
export type ExpiryGateOutcome = GateOutcome & {
	/** The persisted absolute close instant, or `null` when no Bid leads. */
	readonly closesAt: string | null;
	/** The injected `now` this gate compared against. Never derived here. */
	readonly evaluatedAt: string;
};

/**
 * The phase gate: no Bid is accepted outside the Auction Phase (Story 3.7,
 * FR-22, AD-22).
 *
 * **One field, and it is the only thing the gate looked at.** `phase` is the
 * folded `LeaguePhase` — `phaseReducer` over the whole log — and the verdict
 * is `phase === 'Auction'` and nothing else. There is no expiry instant on
 * this shape, no clock and no count, which is `ExpiryGateOutcome`'s discipline
 * applied to a refusal that is about neither: a gate that cannot see a figure
 * cannot quote one (AD-7).
 *
 * **It carries no League Clock expiry deliberately.** The Auction Phase ends
 * when the League Clock runs out, but `Setup` and `Archived` fail this gate
 * too and in neither case did any clock expire. A shape carrying an expiry
 * would invite a refusal sentence asserting a cause this gate cannot see, and
 * that sentence would be false in two of the three states that fail it.
 */
export type PhaseGateOutcome = GateOutcome & {
	/** The folded League phase this gate was decided from. Never re-derived. */
	readonly phase: LeaguePhase;
};

/**
 * The gate set for `PlaceBid`, **fixed per command type** (AD-1).
 *
 * Declared here, in one place, so a later story adds a gate with a single
 * edit and every caller is a compile error until it handles the new one.
 * "Fixed" means fixed at any given commit, not frozen forever: Story 2.6
 * added `cap` and Story 2.7 added `slots` — each was that one edit, and each
 * is what made every consumer stop compiling until it handled the new gate.
 * Story 2.8 added NONE: Minors Exposure widened `cap`'s and `slots`'
 * arithmetic and left this list exactly as it was. Story 3.1 added `expiry`,
 * and it cost the same ONE edit — the list below, plus the key on
 * `PlaceBidGateResults`; every consumer, the refusal panel's seventh chip
 * included, followed from it. Story 3.2 added `contention` and spent the
 * edit a fourth time: the eighth chip reached the panel because this list
 * grew, and no component or route was touched to make it appear.
 *
 * **The ORDER is the reading order.** `allGatesPassed`, `failedGates`,
 * `bidRefusalDelta` and `bidGateReport` all iterate this list, so it is the
 * order a Manager reads the refusal panel in. `expiry` is FIRST because a
 * clock that has run out is the frame every other question sits inside:
 * offering, raising and affording are all moot once it has. `contention`
 * sits IMMEDIATELY AFTER `opening`, because the two are one reading:
 * `opening` says what an amount means when nothing leads yet, and
 * `contention` says what it means once a lottery is running — so a Bid
 * refused on both `contention` and `selfBid` states the lottery's ground
 * before the ordinary auction's.
 *
 * **Story 3.7 added `phase`, and it goes FIRST — ahead of `expiry`.** Outside
 * the Auction Phase there is no auction for a clock to belong to, so which
 * amount was offered and how long an Auction Clock had left are both beside
 * the point; "the league is in Contract Assignment" is the honest answer and
 * every other row sits inside it. That is exactly the ordering
 * `rules/nomination.ts:182` argues for its own phase refusal, applied to the
 * ninth gate. It is the fifth time this one-edit mechanism has been spent:
 * adding the name below and the key on `PlaceBidGateResults` made every
 * consumer a compile error until it handled the new gate, and the ninth chip
 * reached the refusal panel because this list grew rather than because a
 * component was edited.
 *
 * Frozen at runtime as well as `as const`, because this list is what
 * `evaluate()`'s totality is asserted against — a caller that could splice
 * an entry out of it could make a partial result look complete.
 */
export const PLACE_BID_GATES = Object.freeze([
	'phase',
	'expiry',
	'opening',
	'contention',
	'selfBid',
	'increment',
	'granularity',
	'cap',
	'slots'
] as const);

/** One of the nine gate names above. */
export type PlaceBidGate = (typeof PLACE_BID_GATES)[number];

/**
 * What `evaluate()` returns for a `PlaceBid`, in any state.
 *
 * Every key is always present with its own outcome and its own arithmetic,
 * whether or not that gate passed — an accepted result and a refused one
 * carry the identical gate set, so a caller can never be handed a partial
 * record it has to guess at.
 */
export type PlaceBidGateResults = {
	readonly phase: PhaseGateOutcome;
	readonly expiry: ExpiryGateOutcome;
	readonly opening: OpeningGateOutcome;
	readonly contention: ContentionGateOutcome;
	readonly selfBid: SelfBidGateOutcome;
	readonly increment: IncrementGateOutcome;
	readonly granularity: GranularityGateOutcome;
	readonly cap: CapGateOutcome;
	readonly slots: SlotsGateOutcome;
};

// --- Story 10.4: the RestoreLeadingBid command and its fixed gate set ------

/**
 * The `RestoreLeadingBid` command (Story 10.4, FR-40, AR-37).
 *
 * **A distinct command type, and that is the whole point.** Restoration hands
 * an Auction to the next-highest surviving Bid after the leader's commitment
 * was cancelled, and the candidate has to be re-validated before it may lead
 * — but only against the two questions a commitment already made can still
 * fail: can this Team still afford it, and has it still got somewhere to put
 * the win. Every other gate in `PLACE_BID_GATES` is about the act of
 * OFFERING, and re-asking one of them here would refuse a Bid that was
 * lawfully placed and never withdrawn by its own Manager.
 *
 * **`increment` is the one that makes this a separate type rather than a
 * synthetic `PlaceBid`.** The price has just FALLEN — the leader above this
 * candidate is gone — so a re-run of "strictly higher than the leading Bid"
 * would compare the candidate's own amount against a leading amount that no
 * longer exists, or against the candidate itself, and refuse every
 * restoration that mattered. `expiry` is the second: a restored Bidder may
 * inherit minutes of a clock that is nearly out, and refusing on that would
 * strand the Auction leaderless for a reason FR-40 explicitly rejects.
 *
 * The field list is `PlaceBid`'s exactly, and deliberately: `teamName` and
 * `managerId` are on the command for the EVENT's sake — the restoration
 * rides `BidCancelledPayload` and the notice must name the Team and reach
 * the Manager — while `RESTORE_LEADING_BID_GATES` decides from `teamId` and
 * `amount` alone.
 */
export type RestoreLeadingBid = {
	readonly kind: 'RestoreLeadingBid';
	readonly fantraxPlayerId: string;
	readonly teamId: string;
	readonly teamName: string;
	readonly managerId: string;
	readonly amount: Money;
};

/**
 * The gate set for `RestoreLeadingBid`, **fixed per command type** (AD-1),
 * and the SECOND fixed gate set this codebase declares.
 *
 * Two gates, and the pair is the answer to one question: is this Team still
 * able to keep the commitment it already made? `cap` says whether the money
 * is still there and `slots` says whether the win still has a Slot to land
 * in — which are exactly the two grounds a Close elsewhere can have moved
 * under a Bid nobody touched.
 *
 * **The ORDER is the reading order**, as `PLACE_BID_GATES`' is: money before
 * capacity, matching the last two entries of that list so a reader who knows
 * one knows the other. Neither short-circuits the other and both outcomes are
 * always returned (AD-7).
 *
 * Frozen at runtime as well as `as const`, for `PLACE_BID_GATES`' reason: this
 * list is what `evaluateRestore()`'s totality is asserted against, and a
 * caller that could splice an entry out of it could make a partial result
 * look complete.
 */
export const RESTORE_LEADING_BID_GATES = Object.freeze(['cap', 'slots'] as const);

/** One of the two gate names above. */
export type RestoreLeadingBidGate = (typeof RESTORE_LEADING_BID_GATES)[number];

/**
 * What `evaluateRestore()` returns for a `RestoreLeadingBid`, in any state.
 *
 * **`CapGateOutcome` and `SlotsGateOutcome` are reused verbatim.** They are
 * the same gates over the same arithmetic asked of a narrower set, so a
 * parallel pair of outcome shapes would be two spellings of one answer — and
 * the refusal panel, `gateFigure` and `capBreakdown` all already read these.
 */
export type RestoreLeadingBidGateResults = {
	readonly cap: CapGateOutcome;
	readonly slots: SlotsGateOutcome;
};

/**
 * `decide()` authorised the command: here are the events to append.
 *
 * Generic in what it carries so the shape reads as AD-1 writes it —
 * `Accepted<Event[]>`.
 */
export type Accepted<TEvents> = {
	readonly kind: 'accepted';
	readonly events: TEvents;
};

/**
 * `decide()` refused: here is the SAME `GateResults` shape `evaluate()`
 * returns, so a refusal reports every gate that ran and not only the first
 * that failed (AD-1).
 */
export type Rejected<TGates> = {
	readonly kind: 'rejected';
	readonly gates: TGates;
};

/** What `decide()` answers: authorised, or refused with the full gate set. */
export type Decided<TEvents, TGates> = Accepted<TEvents> | Rejected<TGates>;
