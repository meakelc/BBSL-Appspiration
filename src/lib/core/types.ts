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
 * This module is part of the PURE core: no I/O, no clock, no randomness, stdlib
 * only, relative .ts imports only so Deno can load it (AD-2).
 */

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
