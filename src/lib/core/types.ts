/**
 * Commands, events, rejections and state for the pure core.
 *
 * Story 1.5 adds only the generic event-log shapes the transactional shell
 * needs now — `EventEnvelope`, what a caller's `decide()` hands the shell to
 * persist, and `AppendedEvent`, what comes back once the database has
 * assigned it a place in the log. Epic 2 fills in the rest: domain-specific
 * command and event variants (`PlaceBid`, `NominatePlayer`, ...) on top of
 * `EventEnvelope`, unchanged, plus the rules engine that gives them meaning.
 * Nothing here names a domain event type on purpose.
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
