/**
 * League constants and the AD-6 advisory lock key.
 *
 * These live in code and no admin UI, configuration file or environment
 * variable can edit them (PRD §7.2, §11). The league is not multi-tenant and
 * these values are not settings.
 *
 * This module is the leaf of the core: it imports nothing, so `money.ts` can
 * import the $500,000 grid from here without a cycle. Money amounts below are
 * plain integer dollars; brand them with `parseMoney()` where they enter a
 * calculation.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness, stdlib
 * only, relative .ts imports only so Deno can load it (AD-2).
 */

/** The Salary Cap. PRD §3 glossary; §11 "$165M cap". */
export const SALARY_CAP = 165_000_000;

/**
 * The least an Opening Bid may be. PRD §3 "Opening Bid — Minimum $1,000,000",
 * and the per-hole figure Roster Reserve holds back (PRD §3 "Roster Reserve").
 */
export const MINIMUM_BID = 1_000_000;

/**
 * **One constant, two jobs.** The Minimum Increment a Bid in Standard
 * Contention must exceed the current high by (PRD §3), *and* the granularity
 * every money value in the product sits on. They are the same $500,000 and the
 * epic AC requires one named value serving both — two constants could drift,
 * and the abbreviated `$14.5M` rendering is lossless only while every figure
 * sits on this grid (AD-8).
 */
export const MINIMUM_INCREMENT = 500_000;

/**
 * Durations, in milliseconds.
 *
 * These are lengths, never instants — nothing here reads a clock (AD-3). The
 * shell adds a duration to the database's transaction-start time to get an
 * absolute close timestamp; the core never learns what time it is.
 *
 * `FRESHNESS_WINDOW` and `STALE_WINDOW` are named verbatim as AD-29 and the
 * epic AC require. No planning artifact assigned them a number; 30s and 120s
 * are a human decision of 2026-08-20, taken against CAP-10's 5-second board
 * floor. Story 4.1 consumes them and may renegotiate.
 */

/** The Auction Clock: 24 hours. Its expiry closes an Auction (PRD §3). */
export const AUCTION_CLOCK = 24 * 60 * 60 * 1000;

/** The League Clock: 48 hours. Its expiry ends the Auction Phase (PRD §3). */
export const LEAGUE_CLOCK = 48 * 60 * 60 * 1000;

/** Live requires a liveness check succeeding within this window (AD-29). */
export const FRESHNESS_WINDOW = 30 * 1000;

/** No successful liveness check within this window is Stale (AD-29). */
export const STALE_WINDOW = 120 * 1000;

/**
 * How often the browser re-reads the watermark to ask "can I still reach the
 * server?" (AD-29, Story 4.1).
 *
 * **Named here rather than guessed at a call site**, for `FRESHNESS_WINDOW`'s
 * reason: an interval typed into the client module would be a second window
 * constant living outside this file, free to drift from the two above.
 *
 * Chosen AGAINST `FRESHNESS_WINDOW`, not independently. At 10s against a 30s
 * window, one missed poll leaves the last success 20s old and the client stays
 * Live; two consecutive misses put it at 30s and it degrades to Reconnecting.
 * That is the intended sensitivity — a single dropped request on mobile data is
 * not evidence of anything, and two in a row are. `STALE_WINDOW` is twelve
 * intervals, so reaching Stale takes a sustained outage rather than a blip.
 *
 * It is an interval, never an instant: nothing here reads a clock (AD-3).
 */
export const LIVENESS_INTERVAL = 10 * 1000;

/**
 * How long a single liveness re-read may take before it is abandoned
 * (Story 4.1).
 *
 * Named here for `LIVENESS_INTERVAL`'s reason, and chosen against it the same
 * way: 8s sits INSIDE the 10s interval, so a request that hangs is aborted
 * before the next tick rather than accumulating in flight. It is the same
 * arithmetic `supabase/migrations/20260831000000_tick.sql` does for pg_net's
 * response timeout against the 10-second cron interval, and for the same
 * reason.
 *
 * An abandoned request is a LAPSED check, never a failure worth reporting: it
 * does not move `lastLivenessOkAt`, so the state degrades on schedule exactly
 * as a refused or unreachable read does.
 */
export const LIVENESS_TIMEOUT = 8 * 1000;

/** Active/Bench Slots per Team. The Roster Capacity ceiling (FR-37). */
export const ACTIVE_BENCH_SLOTS = 12;

/**
 * The Outstanding Bid Allowance: the ONE extra outstanding Bid a Team may
 * hold beyond its Free Active/Bench Slots (FR-37, amended 2026-09-08).
 *
 * **It is not a thirteenth Slot.** `ACTIVE_BENCH_SLOTS` is unchanged and
 * still hard; what widened is the BIDDING rule built on it, so a Manager
 * with one free Slot may chase two Players at once instead of idling a day
 * waiting on a close they cannot influence. The surplus commitment is taken
 * back automatically at the Close that fills the Slot (FR-40) — which is why
 * the allowance is safe, and why it is exactly one rather than a number.
 *
 * **It is a named constant rather than an inline `+ 1`** for the reason
 * every figure in this product is: the slots gate adds it, the refusal
 * wording quotes what it permits, and the row figure states the same count
 * again. Three readings of one literal is three places for it to drift.
 *
 * **The allowance never applies without a free Slot to extend.** The gate
 * tests that precondition BEFORE this arithmetic — see `evaluateSlots` —
 * because `0 + 1 = 1` would otherwise admit a Bid that wins a thirteenth
 * Player with no other Close available to cancel it (§10 example 30).
 */
export const OUTSTANDING_BID_ALLOWANCE = 1;

/**
 * The `fantraxPlayerId` the persistent strip's baseline probe carries
 * (Story 4.2).
 *
 * The strip's Maximum Bid is `evaluate()`'s own output, and `evaluate()` takes
 * a `PlaceBid` — which needs a Player id. The baseline addresses NO Auction:
 * it is the money ceiling that applies to every non-eligible Auction, not to
 * any particular one. So the probe carries this id rather than a real one.
 *
 * **It is a named constant rather than an empty string or a literal** because
 * it is not inert: AD-5 sorts the Minors Exposure sequence by
 * `fantraxPlayerId` as its tiebreak, so the probe's id participates in an
 * ordering and must therefore be a value written down once, in the core, where
 * anybody reading the sort can see what it is. The `no-auction:` prefix is a
 * shape no Fantrax id has, so it can never collide with a Player and be
 * excluded from a Team's own leads by `teamMoneyStateFor`.
 */
export const NO_AUCTION_PROBE_ID = 'no-auction:strip-baseline';

/** Injury Reserve Slots per Team. PRD §11 "2 IR"; ARCHITECTURE-SPINE Config row. */
export const INJURY_RESERVE_SLOTS = 2;

/**
 * Minor League Slots per Team. PRD §11 "3 minors"; PRD §3 "Slot Placement" —
 * only a Minor League Eligible Player may occupy one.
 */
export const MINOR_LEAGUE_SLOTS = 3;

/**
 * The Year Allotment: each Team's per-offseason budget of contract lengths
 * (PRD §3). One-year deals are unlimited and therefore have no count — the
 * absence is deliberate, not an omission.
 */
export const YEAR_ALLOTMENT = Object.freeze({
	fourYear: 1,
	threeYear: 1,
	twoYear: 2
});

/**
 * The schema version stamped onto every `auction_events` row (AD-20).
 *
 * Bumped whenever the shape of a row changes. An insert-only log cannot be
 * backfilled, so a fold can only tell which shape produced an older event by
 * reading this column — never by inferring it from what happens to be
 * present.
 */
export const EVENT_SCHEMA_VERSION = 1;

/**
 * The rules-core version that produced an event (AD-20).
 *
 * Bumped whenever `core/rules` changes in a way that could alter an outcome.
 * The Node and Deno deployments must carry the same version or the tick
 * refuses to run and alerts rather than proceeding — because AD-4 forbids
 * deleting events, a bad rules deploy cannot be rolled back by reverting
 * code alone.
 */
export const CORE_VERSION = 2;

/**
 * The single global write lock (AD-6). Every mutating transaction takes this
 * before reading any state.
 *
 * **One key, one arity.** Postgres' `pg_advisory_xact_lock(bigint)` and
 * `pg_advisory_xact_lock(int, int)` occupy disjoint lock spaces and do not
 * exclude one another, so a caller using the two-argument form while another
 * uses the one-argument form takes a lock that excludes nothing — a silent,
 * total failure of this AD. This value is a single `bigint` and is passed to
 * the one-argument form, verbatim, by every caller in both runtimes.
 *
 * The value is ASCII `BBSL` in the high 32 bits and a sequence number in the
 * low, so it is recognisable in `pg_locks` and cannot collide by accident with
 * a key anyone else picks.
 */
export const GLOBAL_WRITE_LOCK_KEY = 0x4242534c00000001n;
