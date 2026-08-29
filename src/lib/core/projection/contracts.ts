/**
 * Auction Contracts, folded from the log (Story 3.4, FR-21, AD-23).
 *
 * **An Auction Contract is a fold, not a table, and that is a conclusion
 * rather than a shortcut.** `team_rosters`' own migration states it is
 * written by exactly one path — `promoteImport` — and that nothing rebuilds
 * it from the log: it is the WORLD, imported reference data, and AD-4 says
 * the world is not event-sourced. An Auction Contract is not the world; it
 * is the auction's own OUTPUT, which is precisely the thing AD-4 says is
 * event-sourced. So it folds, it costs no migration, and it converges under
 * replay by construction — the stronger form of AD-5's "replaying
 * `AuctionClosed` must converge on the same contract rows rather than
 * duplicating them".
 *
 * `open_nominations` is a table because it needs a UNIQUENESS CONSTRAINT for
 * a real race between two Managers. A close has no such race: it is one
 * writer under the global lock (AD-6), so a table here would only have to be
 * undone.
 *
 * **The two money fields are distinct and neither is derived from the other**
 * (AD-23). `winningAmount` is the contract's value; `capHit` is what it
 * charges against the Cap. A Minor League placement yields a Cap Hit of `$0`
 * while the winning amount stands unchanged, and no expression in this module
 * — or anywhere else — reads one out of the other by assuming equality. They
 * arrive on the payload as two persisted fields and are folded as two.
 *
 * **`contractRowsFor` is the whole integration with the Cap arithmetic.**
 * `server/team-roster.ts` already loops `CapHitRow`s counting `active_bench`
 * and `minor_league`, and already hands the same rows to `computeCapSpace`,
 * which already treats a Minor League row's cap hit as `$0`. Returning that
 * exact shape makes Cap Space, Roster Count and Minor League occupancy all
 * pick contracts up through ONE derivation with no second counter and no
 * second definition of any of the three. A `+ wonCount` anywhere would be the
 * wrong shape.
 *
 * **First close wins.** A second `AuctionClosed` for one Player is a no-op —
 * the same discipline `nominationsReducer` and `auctionsReducer` already take
 * on the events they fold — which is what makes folding the same log twice
 * converge (AD-5). An insert-only log cannot be corrected in place, so a
 * malformed historical row is SKIPPED rather than thrown over, exactly as the
 * other two reducers skip it.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import type { Money } from '../money.ts';
import { parseMoney } from '../money.ts';
import type { CapHitRow } from '../rules/roster-import.ts';
import type { Reducer } from './fold.ts';
import { AUCTION_CLOSED_EVENT } from './nominations.ts';

/**
 * Where a close puts the won Player — a NARROWING of `RosterSlotKind`
 * (`types.ts`), and the narrowing is the point.
 *
 * A close can produce exactly two of the three roster slot kinds. Injury
 * Reserve is a state a Team's own roster moves a Player into afterwards, in
 * Fantrax; no rule in this product can place a Player there at a close, so
 * the type this module folds and the type `slotPlacementFor` returns cannot
 * express it. `CapHitRow` accepts a `RosterSlotKind`, and this union is
 * assignable to it, so the Cap arithmetic needs no widening in either
 * direction.
 */
export type SlotPlacement = 'active_bench' | 'minor_league';

/** The two placements a close can produce, for a total check over a payload. */
const SLOT_PLACEMENTS: readonly SlotPlacement[] = Object.freeze([
	'active_bench',
	'minor_league'
] as const);

/**
 * One Auction Contract, as the close recorded it.
 *
 * Everything a downstream reading needs without re-folding the Auction it
 * came from: the Team that owns it (id AND name, because the `under_contract`
 * refusal NAMES the holder and an id is not a name a Manager recognises), the
 * two AD-23 money fields, where the Player landed, and when the Auction was
 * due to close.
 *
 * `contractYears` is `null` and typed as `null` rather than
 * `number | null`. FR-21 says contract length is recorded UNSET at a close and
 * Epic 6 is what assigns it — so this field states the absence rather than
 * carrying a placeholder, and a story that starts assigning lengths widens the
 * type and becomes a compile error at every reader. A `0` here would be a
 * length, and a wrong one.
 *
 * `closedAt` is the Auction's own persisted NOMINAL expiry, never the
 * transaction clock. The event's `occurredAt` states when the system got round
 * to recording the close; this states when the Auction was due. Only the
 * second is an input to anything, which is what makes AD-10's "a late sweep
 * must produce exactly the outcome an on-time sweep would have" structural.
 */
export type AuctionContract = {
	readonly fantraxPlayerId: string;
	/** The Player's name — what an `under_contract` refusal says out loud. */
	readonly playerName: string;
	/** The winning Team. */
	readonly teamId: string;
	/** That Team's name — the second half of the refusal sentence. */
	readonly teamName: string;
	/** What the Player was won for. Stands unchanged on a minors placement. */
	readonly winningAmount: Money;
	/** What it charges against the Cap. `$0` on a minors placement (AD-23). */
	readonly capHit: Money;
	/** Where the Player landed — the one thing Roster Count moves on. */
	readonly placement: SlotPlacement;
	/** Recorded UNSET at a close. Epic 6 assigns it. */
	readonly contractYears: null;
	/** The Auction's own persisted expiry — never the transaction clock. */
	readonly closedAt: string;
};

/** Every Auction Contract this log has produced, keyed on the Player. */
export type AuctionContracts = {
	readonly byPlayer: Readonly<Record<string, AuctionContract>>;
};

/** With no `AuctionClosed` event, no Auction has produced a contract. */
export const INITIAL_CONTRACTS: AuctionContracts = Object.freeze({
	byPlayer: Object.freeze({}) as Readonly<Record<string, AuctionContract>>
});

/**
 * `Object.prototype.hasOwnProperty`, called against the record rather than
 * through it — `nominations.ts`'s `hasOwn`, for its reason: the keys are
 * Fantrax player ids, which are data, so a key of `constructor` must not read
 * back as an inherited function and be mistaken for a contract.
 */
function hasOwn(record: Readonly<Record<string, AuctionContract>>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

/** The Auction Contract for a Player, or `null` when no close produced one. */
export function contractForPlayer(
	contracts: AuctionContracts,
	fantraxPlayerId: string
): AuctionContract | null {
	if (!hasOwn(contracts.byPlayer, fantraxPlayerId)) return null;
	return contracts.byPlayer[fantraxPlayerId] ?? null;
}

/** Every Auction Contract, in no stated order. For a caller that wants the set. */
export function auctionContracts(contracts: AuctionContracts): readonly AuctionContract[] {
	return Object.values(contracts.byPlayer);
}

/**
 * One Team's Auction Contracts as `CapHitRow`s — the ONE bridge between this
 * fold and the Cap arithmetic.
 *
 * It returns `rules/roster-import.ts`'s existing shape rather than a new one,
 * so `server/team-roster.ts` concatenates these rows onto the ones it read
 * from `team_rosters` and its single existing loop produces Cap Space, Roster
 * Count and Minor League occupancy with contracts included. `computeCapSpace`
 * needs no change and the "$0 for a Minor League row" rule stays written
 * exactly once, where it already was.
 *
 * `capHit` is carried through as the close PERSISTED it, never recomputed
 * from `winningAmount` (AD-23). `computeCapSpace` will zero a `minor_league`
 * row again, and that redundancy is deliberate: the two statements of the
 * rule agree because the close applied the same rule, and if a historical
 * payload ever disagreed the Cap arithmetic would still be right.
 *
 * Keys are iterated in sorted order (AD-5): the rows feed a sum, and a sum
 * over an incidental key order is a sum whose inputs are not a sequence.
 */
export function contractRowsFor(
	contracts: AuctionContracts,
	teamId: string
): readonly CapHitRow[] {
	const rows: CapHitRow[] = [];
	for (const playerId of Object.keys(contracts.byPlayer).sort()) {
		const contract = contractForPlayer(contracts, playerId);
		if (contract === null) continue;
		if (contract.teamId !== teamId) continue;
		rows.push({ capHit: contract.capHit, rosterSlotKind: contract.placement });
	}
	return rows;
}

/**
 * The `AuctionClosed` payload as this reducer needs it, read defensively.
 *
 * `AppendedEvent.payload` is `unknown` — whatever JSON the column holds — and
 * an insert-only log cannot be corrected in place, so a malformed historical
 * row must never crash the fold. Returning `null` rather than throwing is
 * `nominations.ts`'s and `auctions.ts`'s discipline for the same reason, and
 * the other two reducers already skip the same event.
 *
 * The fields split the way `eligibility.ts` splits its own, and for its
 * reason:
 *
 *   - **Rejected, because they cannot be guessed.** The Player, the winning
 *     Team, both money fields and the placement are what this fold IS. A
 *     close naming no Player identifies no contract; one naming no Team
 *     records an ownership nobody holds; an unparseable amount is not a
 *     price; and a placement that is neither of the two kinds decides both
 *     Roster Count and the Cap treatment, so guessing at it would move a
 *     Team's spending power on the strength of a corrupt row.
 *   - **Repaired, because they are audit detail this fold never decides on.**
 *     The two names fall back to their ids, which still identify the thing,
 *     and `closedAt` falls back to the event's own instant — dropping a real
 *     contract over a cosmetic field would silently return a won Player to
 *     the pool, which is far the worse failure.
 *
 * A negative amount is rejected on `readPayload`'s grounds in `auctions.ts`:
 * `parseMoney` accepts an optionally-signed digit run legitimately, because
 * Available Cap Space is legitimately negative, so a price has to refuse the
 * sign here.
 */
function readPayload(
	payload: unknown,
	event: { readonly occurredAt: string }
): AuctionContract | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const record = payload as Record<string, unknown>;

	const fantraxPlayerId = record['fantraxPlayerId'];
	const teamId = record['teamId'];
	if (typeof fantraxPlayerId !== 'string' || fantraxPlayerId === '') return null;
	if (typeof teamId !== 'string' || teamId === '') return null;

	const placement = record['placement'];
	if (typeof placement !== 'string') return null;
	if (!SLOT_PLACEMENTS.includes(placement as SlotPlacement)) return null;

	// Both amounts are parsed rather than trusted, and parsed SEPARATELY —
	// neither is read out of the other (AD-23). `parseMoney` accepts the two
	// shapes an `int8` arrives as and throws on everything else (AD-8); that
	// throw is caught and turned into a skip, because a corrupt payload in an
	// insert-only log is not this fold's to crash over.
	let winningAmount: Money;
	let capHit: Money;
	try {
		winningAmount = parseMoney(record['winningAmount']);
		capHit = parseMoney(record['capHit']);
	} catch {
		return null;
	}
	if (winningAmount < 0 || capHit < 0) return null;

	const playerName = record['playerName'];
	const teamName = record['teamName'];
	const closedAt = record['closedAt'];

	return {
		fantraxPlayerId,
		playerName: typeof playerName === 'string' && playerName !== '' ? playerName : fantraxPlayerId,
		teamId,
		teamName: typeof teamName === 'string' && teamName !== '' ? teamName : teamId,
		winningAmount,
		capHit,
		placement: placement as SlotPlacement,
		// Stated as the absence it is, never as a zero-length contract.
		contractYears: null,
		closedAt: typeof closedAt === 'string' && closedAt !== '' ? closedAt : event.occurredAt
	};
}

/**
 * Fold one event onto the Auction Contracts.
 *
 * The `default: return state` discipline is `phase.ts`'s, for the same
 * reason: an event type this reducer has not been taught is not an error, it
 * is simply not about contracts.
 *
 * **The FIRST close for a Player wins.** A second `AuctionClosed` naming a
 * Player who already holds a contract changes nothing, which is what makes
 * folding the same log twice converge on the identical state (AD-5) — and it
 * is the same answer the other two reducers give a double close, so all three
 * agree about what a repeated event means. In practice one cannot arrive: an
 * Auction leaves `auctionsReducer` and `nominationsReducer` on its close, so
 * nothing can produce a second one for the same Player.
 */
export const contractsReducer: Reducer<AuctionContracts> = (state, event) => {
	switch (event.type) {
		case AUCTION_CLOSED_EVENT: {
			const contract = readPayload(event.payload, event);
			if (contract === null) return state;
			if (hasOwn(state.byPlayer, contract.fantraxPlayerId)) return state;
			return { byPlayer: { ...state.byPlayer, [contract.fantraxPlayerId]: contract } };
		}
		default:
			return state;
	}
};
