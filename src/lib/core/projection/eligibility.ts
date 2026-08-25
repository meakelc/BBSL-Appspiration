/**
 * The Minor League Eligibility projection: the pure reducer that folds
 * `MinorLeagueEligibilitySet` events into the set of eligible Players
 * (Story 1.10).
 *
 * **This is the first projection in the codebase with a PERSISTED backing
 * column.** `phaseReducer` is folded from real events exactly as this one is
 * — by `resolveLeaguePhase`, and inside both write transactions — but the
 * phase is derived on demand and stored nowhere. `free_agent_players` holds
 * one app-owned column — `minor_league_eligible` — and that column is the
 * fold of these events, written only through the one projection updater and
 * reproducible from the log at any point. Every other column of that table
 * remains imported reference data and is NOT rebuildable from the log; the
 * two halves live in one table on purpose and neither generalises to the
 * other.
 *
 * The `default: return state` discipline is `phase.ts`'s, for the same
 * reason: an event type this reducer has not been taught is not an error, it
 * is simply not about eligibility.
 *
 * Folded by the existing `fold()` (`projection/fold.ts`), so the
 * in-transaction fold and a full rebuild from an empty state are literally
 * one function (AD-5), and replaying the same events twice converges on the
 * same set — the reducer never mutates the state it is handed.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import type { Reducer } from './fold.ts';

/** The event type appended once per Player whose flag actually changed. */
export const MINOR_LEAGUE_ELIGIBILITY_SET = 'MinorLeagueEligibilitySet';

/**
 * Which Players are Minor League Eligible, by Fantrax player id.
 *
 * A set of the eligible ids, not a map of every Player to a boolean: the
 * default is *not* eligible (epic-1-context.md — "omission fails safe"), so
 * absence is the safe answer for a Player this fold has never seen,
 * including one who has just arrived in the pool from a re-import.
 */
export type EligibilitySet = ReadonlySet<string>;

/** With no events appended, no Player is Minor League Eligible. */
export const INITIAL_ELIGIBILITY: EligibilitySet = new Set<string>();

/** The payload every `MinorLeagueEligibilitySet` event carries. */
export type MinorLeagueEligibilitySetPayload = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly before: boolean;
	readonly after: boolean;
};

/**
 * Whether one Player is eligible under a folded state.
 *
 * Exported so no call site writes `state.has(id)` itself — the "absence is
 * not eligible" rule has one expression, and the promotion path and the
 * change path ask the same question the same way.
 */
export function isEligible(state: EligibilitySet, fantraxPlayerId: string): boolean {
	return state.has(fantraxPlayerId);
}

/**
 * Read a `MinorLeagueEligibilitySet` payload defensively.
 *
 * `AppendedEvent.payload` is `unknown` — it arrives as whatever JSON the
 * database column holds. An insert-only log cannot be corrected in place, so
 * a single malformed historical row must never crash the fold and make the
 * whole projection unrebuildable.
 *
 * The two fields are treated differently, on purpose:
 *
 *   - `fantraxPlayerId` and `after` are the fold's only inputs. Neither can
 *     be guessed — a missing id names no Player and a missing `after` states
 *     no outcome — so an event lacking either is REJECTED (`null` is
 *     returned) and skipped entirely, leaving that Player at whatever the
 *     rest of the log says.
 *   - `playerName` and `before` are audit detail this reducer never folds on.
 *     They are REPAIRED rather than rejected: the name falls back to the id,
 *     which still identifies the Player, and `before` to `false`, the safe
 *     default. Dropping a legitimate set/unset over a cosmetic field would
 *     silently change what the projection reproduces, which is the worse
 *     failure.
 *
 * Returns `null` only in the reject case.
 */
function readPayload(payload: unknown): MinorLeagueEligibilitySetPayload | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const record = payload as Record<string, unknown>;
	const id = record['fantraxPlayerId'];
	const after = record['after'];
	if (typeof id !== 'string' || id === '') return null;
	if (typeof after !== 'boolean') return null;
	return {
		fantraxPlayerId: id,
		playerName: typeof record['playerName'] === 'string' ? record['playerName'] : id,
		before: record['before'] === true,
		after
	};
}

/**
 * Fold one event onto the eligible set.
 *
 * `after` alone decides membership — `before` is carried in the payload for
 * the Audit Log ("every appended event names the actor, the Player and the
 * before and after values"), not for the fold. A reducer that trusted
 * `before` would make replay depend on the log agreeing with itself; reading
 * only `after` makes replay idempotent by construction.
 */
export const eligibilityReducer: Reducer<EligibilitySet> = (state, event) => {
	switch (event.type) {
		case MINOR_LEAGUE_ELIGIBILITY_SET: {
			const payload = readPayload(event.payload);
			if (payload === null) return state;
			// A new Set every time: the caller's state is never mutated, which is
			// what makes folding the same events twice converge rather than
			// accumulate.
			const next = new Set(state);
			if (payload.after) next.add(payload.fantraxPlayerId);
			else next.delete(payload.fantraxPlayerId);
			return next;
		}
		default:
			return state;
	}
};
