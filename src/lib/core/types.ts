/**
 * Commands, events, rejections and state for the pure core.
 *
 * Stub. Epic 2 fills this in, with the rules engine that gives these
 * shapes meaning; Story 1.2 deliberately left it alone rather than declaring
 * a gate set before any gate existed.
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
 * This module is part of the PURE core: no I/O, no clock, no randomness, stdlib
 * only, relative .ts imports only so Deno can load it (AD-2).
 */

export {};
