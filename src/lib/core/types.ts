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

/**
 * What a caller's `decide()` hands the transactional shell to append.
 *
 * Deliberately generic: no domain event type is named here (Epic 2 owns
 * that). `payload` is `unknown` because this module has no notion of what any
 * particular event's shape is — the shell serialises it into `auction_events`
 * as-is, and whatever reads it back is the one place that knows what to
 * expect for a given `type`.
 *
 * `managerId`/`teamId` are required from the first event onward (AD-4): no
 * system-originated event exists yet that would need to resolve who "acts"
 * for it. `deviceClass`/`dispatchOutcome`/`deliveryOutcome` are the
 * measurement fields NFR §5 requires and are optional here because most
 * events populate none of them; the column they land in is nullable for the
 * same reason.
 */
export type EventEnvelope = {
	readonly type: string;
	readonly payload: unknown;
	readonly managerId: string;
	readonly teamId: string;
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
	readonly managerId: string;
	readonly teamId: string;
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
 *  - `at_the_minimum` — refused. Exactly `MINIMUM_BID` would open a
 *    Minimum-Bid Contention, whose Contender list, seed table, fixed clock
 *    and draw are Stories 3.2/3.3. Nothing here may create one.
 *  - `below_the_minimum` — refused: an Opening Bid is at least `MINIMUM_BID`.
 */
export type OpeningGateOutcome = GateOutcome & {
	readonly opening: 'not_an_opening' | 'above_the_minimum' | 'at_the_minimum' | 'below_the_minimum';
	readonly offered: Money;
	readonly minimumOpening: Money;
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
	/** Eligible Leading Bids (`N`), counting the Bid being placed. */
	readonly eligibleLeadingBids: number | null;
	/** `max(0, N − M)` — how many eligible wins have nowhere to land. */
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
 * It refuses exactly when `rosterCount + projectedAdditions > ceiling`, on
 * the same POST-BID basis Roster Reserve uses — `projectedAdditions` counts
 * the Bid being placed. The two figures are `CapGateOutcome`'s two counts
 * over again, deliberately copied rather than pointed at: two rows each
 * stating their own arithmetic cannot be read as one, and reporting a
 * capacity refusal as a cap refusal is a defect (AD-7). The shared
 * DERIVATION is `projectedAdditionsFor` in `rules/bidding.ts`, so the two
 * gates can never disagree about the count while agreeing they describe the
 * same roster.
 *
 * **Story 2.8 adds three COUNTS and no money, which is what lets the
 * capacity gate see Minors Exposure without seeing a dollar.** An eligible
 * win that overflows has to land in an Active/Bench Slot, so
 * `projectedAdditions` includes `overflowCount` — and `Overflow Count` is
 * `max(0, N − M)`, two integers. `freeMinorLeagueSlots` and
 * `eligibleLeadingBids` ride along so a capacity refusal can name the
 * overflow in counts alone (§10 example 25). There is still no `offered`
 * field and still no money field on this shape, so FR-37's "fails with
 * unlimited Cap Space, passes with none" remains a property of the
 * signature rather than a claim to verify by reading.
 *
 * `rosterCount`, `projectedAdditions` and the three counts are `null`
 * together, and only for an actor bound to no Team — exactly as
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
	/** Free Minor League Slots (`M`). A count — this gate reads no amount. */
	readonly freeMinorLeagueSlots: number | null;
	/** Eligible Leading Bids (`N`), counting the Bid being placed. */
	readonly eligibleLeadingBids: number | null;
	/** `max(0, N − M)` — the eligible wins that must land in Active/Bench. */
	readonly overflowCount: number | null;
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
 * arithmetic and left this list exactly as it was. 3.1 adds `expiry`.
 *
 * Frozen at runtime as well as `as const`, because this list is what
 * `evaluate()`'s totality is asserted against — a caller that could splice
 * an entry out of it could make a partial result look complete.
 */
export const PLACE_BID_GATES = Object.freeze([
	'opening',
	'selfBid',
	'increment',
	'granularity',
	'cap',
	'slots'
] as const);

/** One of the six gate names above. */
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
	readonly opening: OpeningGateOutcome;
	readonly selfBid: SelfBidGateOutcome;
	readonly increment: IncrementGateOutcome;
	readonly granularity: GranularityGateOutcome;
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
