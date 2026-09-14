/**
 * The Minor League occupancy fold: every Contract the app has EVER observed
 * in a Minor League Slot (Story 7.11, FR-44, PRD §10 example 46).
 *
 * **It answers a different question from `projection/eligibility.ts`, and the
 * two must never be merged.** That projection folds the POOL FLAG — whether a
 * contested Player, if won, could be stashed — and a Commissioner may unset
 * it. This one folds HISTORY: whether the app has ever been told, by anybody,
 * that this Contract may occupy a Minor League Slot. §10 example 46 is the
 * case that separates them: Vassell and Thompson are indistinguishable in
 * `team_rosters` — both imported, both Active/Bench, neither with a pool row
 * — and only the log says that Thompson was in a Minor League Slot an hour
 * ago and Vassell never was.
 *
 * **Union, never replace.** `eligibilityReducer` deletes on `after: false`
 * because the flag is a current state. Nothing removes an id from this set:
 * an observation cannot be un-observed, and a fold that removed one would
 * make demoting an imported stash destroy the only fact the app held saying
 * he may be stashed — which is exactly the irreversibility FR-44 forbids.
 *
 * **Why three event types and a live seed are complete.**
 * `ImportPromotedPayload` carries per-Team counts and no per-Player slot
 * detail, so the import baseline is not reconstructible from the log and must
 * be SEEDED from `team_rosters` as it stands. That is sound: a re-import
 * replaces live state wholesale and happens only in Setup, while a Roster
 * Move is live only from the Auction Phase on. Everything that has moved a
 * Contract out of a Minor League Slot SINCE the import is one of three
 * recorded acts — a Roster Trade, a Roster Move or a Drop — so the union of
 * (current minors occupancy) and (every `minor_league` placement those three
 * events carry) is complete. An Auction Close needs no entry: a Close can
 * only place in minors because the POOL FLAG said so, and that flag is folded
 * independently — and if the Commissioner later unsets it, the Contract is
 * either still in minors (seeded) or was moved out by one of the three acts
 * (folded).
 *
 * Folded by the existing `fold()` (`projection/fold.ts`), so the
 * in-transaction fold and a full rebuild are literally one function (AD-5),
 * and the reducer never mutates the state it is handed.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import type { RosterSlotKind } from '../types.ts';
import {
	DROP_RECORDED_EVENT,
	ROSTER_REARRANGED_EVENT,
	ROSTER_TRADE_RECORDED_EVENT
} from './contracts.ts';
import type { Reducer } from './fold.ts';

/**
 * The Slot kind a placement must be for this fold to record it — the one
 * literal, named rather than repeated at each of the five read sites.
 */
const MINOR_LEAGUE: RosterSlotKind = 'minor_league';

/**
 * Every Contract the app has ever observed in a Minor League Slot, by Fantrax
 * player id.
 *
 * A set of the observed ids, not a map of every Contract to a boolean:
 * absence means "never observed", which is the honest answer for a Contract
 * this fold has never seen and the one §10 example 46 requires the refusal to
 * word as *the app has never been told he is eligible*.
 */
export type MinorsHistory = ReadonlySet<string>;

/** With no events and no seed, the app has observed nothing. */
export const INITIAL_MINORS_HISTORY: MinorsHistory = new Set<string>();

/**
 * The seed: the Team's CURRENT Minor League occupancy, which the log cannot
 * reconstruct.
 *
 * Read from `team_rosters` by the caller and handed in as the starting state
 * of the fold, rather than folded from an `ImportPromoted` — see the module
 * header for why that event cannot serve.
 */
export function seedMinorsHistory(
	rows: readonly {
		readonly fantraxPlayerId: string;
		readonly rosterSlotKind: RosterSlotKind;
	}[]
): MinorsHistory {
	const seeded = new Set<string>();
	for (const row of rows) {
		if (row.rosterSlotKind === MINOR_LEAGUE) seeded.add(row.fantraxPlayerId);
	}
	return seeded;
}

/**
 * Whether the app has ever observed this Contract in a Minor League Slot.
 *
 * Exported so no call site writes `state.has(id)` itself — "absence is never
 * observed" has one expression, exactly as `isEligible` gives the pool flag
 * one.
 */
export function hasEverOccupiedMinorLeague(
	state: MinorsHistory,
	fantraxPlayerId: string
): boolean {
	return state.has(fantraxPlayerId);
}

/** One entry off a payload list, or `null` when it is not an object. */
function asRecord(entry: unknown): Record<string, unknown> | null {
	if (typeof entry !== 'object' || entry === null) return null;
	return entry as Record<string, unknown>;
}

/** The named array off a payload, defensively — `[]` for anything else. */
function listOf(payload: unknown, key: string): readonly unknown[] {
	const record = asRecord(payload);
	if (record === null) return [];
	const value = record[key];
	return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/**
 * Add every `minor_league` placement one payload list carries.
 *
 * `fields` names which placement keys to read: a transfer and a move carry
 * both a `fromPlacement` and a `toPlacement`, a release carries only the Slot
 * it left. A malformed entry is SKIPPED rather than thrown over — an
 * insert-only log cannot be corrected in place, and nothing here can throw.
 */
function observe(
	into: Set<string>,
	entries: readonly unknown[],
	fields: readonly string[]
): void {
	for (const entry of entries) {
		const row = asRecord(entry);
		if (row === null) continue;
		const fantraxPlayerId = row['fantraxPlayerId'];
		if (typeof fantraxPlayerId !== 'string' || fantraxPlayerId === '') continue;
		for (const field of fields) {
			if (row[field] === MINOR_LEAGUE) into.add(fantraxPlayerId);
		}
	}
}

/**
 * Fold one event onto the observed set.
 *
 * The `default: return state` discipline is `phase.ts`'s, for the same
 * reason: an event type this reducer has not been taught is not an error, it
 * is simply not an observation of a Minor League Slot.
 *
 * A new `Set` is only ever built when something is actually added, so folding
 * the same log twice converges rather than accumulating — and an event that
 * observes nothing returns the caller's own state unchanged.
 */
export const minorsHistoryReducer: Reducer<MinorsHistory> = (state, event) => {
	const observed = new Set(state);

	switch (event.type) {
		case ROSTER_TRADE_RECORDED_EVENT:
			observe(observed, listOf(event.payload, 'transfers'), ['fromPlacement', 'toPlacement']);
			break;
		case ROSTER_REARRANGED_EVENT:
			observe(observed, listOf(event.payload, 'moves'), ['fromPlacement', 'toPlacement']);
			break;
		case DROP_RECORDED_EVENT:
			// A release carries only the Slot it LEFT. Where it went is not a
			// Slot at all — Dead Money, or removed outright.
			observe(observed, listOf(event.payload, 'released'), ['fromPlacement']);
			break;
		default:
			return state;
	}

	// Nothing is ever removed, so a set that did not GROW observed nothing new
	// — and returning the caller's own state for that case is what keeps a
	// second fold of the same log from allocating a new set per event.
	return observed.size === state.size ? state : observed;
};
