/**
 * League constants and the AD-6 advisory lock key.
 *
 * Stub. Story 1.2 fills this in.
 *
 * These live in code and no admin UI can edit them (PRD §7.2). The set is
 * already settled: the salary cap, the minimum bid, the increment — which is
 * also the granularity, one constant serving both — the two clock durations,
 * the Active, Bench, Injury Reserve and Minor League slot counts, the allotment
 * counts, and the single lock key.
 *
 * One global advisory transaction lock, one named constant, one arity. The one-
 * and two-argument forms of pg_advisory_xact_lock occupy disjoint lock spaces,
 * so mixing them is a silent total failure.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness, stdlib
 * only, relative .ts imports only so Deno can load it (AD-2).
 */

export {};
