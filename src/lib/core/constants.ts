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

/** Active/Bench Slots per Team. The Roster Capacity ceiling (FR-37). */
export const ACTIVE_BENCH_SLOTS = 12;

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
