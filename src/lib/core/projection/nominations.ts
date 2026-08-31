/**
 * Open nominations, folded from the log (Story 2.1).
 *
 * **Nothing here is stored.** Neither "which Players are on the Bid Board"
 * nor "which Teams have spent their Nomination Slot" is a column anywhere:
 * both are this fold, taken inside the nomination transaction under the
 * global lock. Story 1.11's own note said the projection table would be
 * created by the story that first *reads* the Slot — and the answer, on
 * arriving here, is that nothing needs to read a table, because the log
 * already carries every fact. Story 2.3's acceptance criteria require Slot
 * status to be "a fold over the log … never a stored flag toggled by a
 * handler", so storing it now would only have to be undone.
 *
 * **Release is one case, and it keys on the Player** (Story 2.3). A
 * nomination is released when that Player's Auction closes: an
 * `AuctionClosed` for a nominated Player frees that Player's board seat and
 * the nominating Team's Nomination Slot together. The two are one fact read
 * two ways — `byTeam` indexes the same object `byPlayer` holds — so dropping
 * the Player's key and the holding Team's key in a single step keeps both
 * indexes consistent by construction. The Player is the key and nothing
 * else: the Slot frees whether the nominator won the auction, lost it, or
 * never bid at all. Keying on a Team would require the close to carry the
 * nominator, which it has no reason to know, and would free the wrong Slot
 * if it carried the winner instead.
 *
 * **The payload contract, fixed here — and it is now the WHOLE close.** This
 * fold uses only `fantraxPlayerId`, but it decides whether a payload is a
 * close at all through `readClosedFacts` below, which every reducer that
 * folds an `AuctionClosed` shares. Story 2.3 wrote the narrower rule — read
 * this one field, ignore winner, price and placement — because Story 3.4 had
 * not yet designed the rest of the payload and this reducer must not depend
 * on a field that did not exist.
 *
 * 3.4 designed it, and 3.4's code review found what the narrow rule cost:
 * `contractsReducer` validated the winner and both money fields while this
 * fold and `auctionsReducer` did not, so a close naming a real Player with a
 * corrupt `teamId` freed the Slot and dropped the Auction while recording no
 * contract — the won Player silently back in the pool, the winning Team's Cap
 * Space unmoved. One shared reader is the fix: what makes a close well formed
 * is one question with one answer, and a payload any of the three skips is
 * skipped by all three.
 *
 * **Nothing here APPENDS an `AuctionClosed`.** Epic 3 owns closing;
 * `server/close.ts` is the producer, and this reducer is a consumer of the
 * same event.
 *
 * **First nomination wins.** The gate refuses a Player already on the board
 * and a Team that already holds an open nomination, so in practice neither
 * collision reaches this reducer. A reducer must nonetheless be total over
 * any log it is handed, and "the earliest nomination is the one that holds"
 * is the only answer that is idempotent under replay: folding the same log
 * twice converges, because a second fold of an already-recorded nomination
 * changes nothing.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import type { Money } from '../money.ts';
import { parseMoney } from '../money.ts';
import type { SlotPlacement } from '../types.ts';
import { SLOT_PLACEMENTS } from '../types.ts';
import type { Reducer } from './fold.ts';

/**
 * The event type a successful nomination appends
 * (`server/nomination.ts`).
 *
 * Declared here rather than beside the transaction that appends it, for
 * `phase.ts`'s reason: this is the reducer that gives it meaning. Board
 * occupancy and Slot status ARE this fold.
 */
export const NOMINATION_PLACED_EVENT = 'NominationPlaced';

/**
 * The event type that closes a Player's Auction and, with it, releases the
 * nomination (Epic 3, Story 3.4).
 *
 * Declared here, beside the reducer that gives it meaning, for
 * `NOMINATION_PLACED_EVENT`'s reason — and declared in this story rather
 * than in 3.4 so that the release case and the event name it reads can
 * never be two independent literals that drift apart. **Nothing in this
 * story appends one.** Epic 3 owns closing; this name and the
 * `fantraxPlayerId` key below are the contract 3.4 inherits.
 */
export const AUCTION_CLOSED_EVENT = 'AuctionClosed';

/** One open nomination, as every refusal sentence needs to name it. */
export type OpenNomination = {
	/** The Player nominated. */
	readonly fantraxPlayerId: string;
	/** That Player's name — what a refusal says out loud. */
	readonly playerName: string;
	/** The Team holding the Slot this nomination spent. */
	readonly teamId: string;
	/** That Team's name — what a refusal says out loud. */
	readonly teamName: string;
	/** The nomination event's own instant, as the shell read the db clock. */
	readonly occurredAt: string;
};

/**
 * Every open nomination, indexed the two ways the gate asks about them.
 *
 * `byPlayer` answers "is this Player already on the board, and who put them
 * there"; `byTeam` answers "has this Team already spent its Slot, and on
 * whom". Both are needed because both refusals name something individually
 * rather than counting, and neither index can be derived from the other
 * without a scan the gate would then have to re-word.
 */
export type OpenNominations = {
	readonly byPlayer: Readonly<Record<string, OpenNomination>>;
	readonly byTeam: Readonly<Record<string, OpenNomination>>;
};

/** With no `NominationPlaced` event, nothing is on the board. */
export const INITIAL_NOMINATIONS: OpenNominations = Object.freeze({
	byPlayer: Object.freeze({}) as Readonly<Record<string, OpenNomination>>,
	byTeam: Object.freeze({}) as Readonly<Record<string, OpenNomination>>
});

/**
 * `Object.prototype.hasOwnProperty`, called against the record rather than
 * through it.
 *
 * The keys of both indexes are Fantrax player ids and Team ids — data, not
 * literals — so a key of `constructor` or `toString` would otherwise read
 * back as an inherited function and be mistaken for an open nomination. A
 * `Record` built from data must never be probed with `in` or with a bare
 * truthiness check.
 */
function hasOwn(record: Readonly<Record<string, OpenNomination>>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

/** The open nomination for a Player, or `null`. */
export function nominationForPlayer(
	nominations: OpenNominations,
	fantraxPlayerId: string
): OpenNomination | null {
	if (!hasOwn(nominations.byPlayer, fantraxPlayerId)) return null;
	return nominations.byPlayer[fantraxPlayerId] ?? null;
}

/** The open nomination holding a Team's Nomination Slot, or `null`. */
export function nominationForTeam(
	nominations: OpenNominations,
	teamId: string
): OpenNomination | null {
	if (!hasOwn(nominations.byTeam, teamId)) return null;
	return nominations.byTeam[teamId] ?? null;
}

/** Every open nomination, in no stated order. For a caller that wants the set. */
export function openNominations(nominations: OpenNominations): readonly OpenNomination[] {
	return Object.values(nominations.byPlayer);
}

/**
 * The `NominationPlaced` payload as this reducer needs it, read
 * defensively.
 *
 * `AppendedEvent.payload` is `unknown` — whatever JSON the column holds —
 * and an insert-only log cannot be corrected in place, so a malformed
 * historical row must never crash the fold. Returning `null` rather than
 * throwing is `promotion.ts`'s discipline for the same reason.
 *
 * Unlike a promotion payload, a nomination that names no Player is
 * *skipped* rather than folded to a nothing-shaped state: promoted-ness is
 * one flag that a malformed row is still evidence for, whereas an open
 * nomination is a statement about a specific Player and a specific Team, and
 * a nomination naming neither cannot hold a Slot or occupy a board seat.
 * Skipping it fails open on a row that could only ever have been written by
 * a bug, rather than blocking a real Team out of the auction forever.
 */
function readPayload(payload: unknown, event: { readonly occurredAt: string }): OpenNomination | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const record = payload as Record<string, unknown>;

	const fantraxPlayerId = record['fantraxPlayerId'];
	const teamId = record['teamId'];
	if (typeof fantraxPlayerId !== 'string' || fantraxPlayerId === '') return null;
	if (typeof teamId !== 'string' || teamId === '') return null;

	const playerName = record['playerName'];
	const teamName = record['teamName'];

	return {
		fantraxPlayerId,
		// The names are audit detail the refusals print; the ids are what the
		// gate matches on. A missing name falls back to the id, which still
		// identifies the thing, rather than dropping the nomination entirely
		// and freeing a Slot that was genuinely spent.
		playerName: typeof playerName === 'string' && playerName !== '' ? playerName : fantraxPlayerId,
		teamId,
		teamName: typeof teamName === 'string' && teamName !== '' ? teamName : teamId,
		occurredAt: event.occurredAt
	};
}

/**
 * The facts an `AuctionClosed` must carry to mean anything at all — the ONE
 * definition of a well-formed close, shared by every reducer that folds one.
 *
 * **Why one reader rather than three.** An `AuctionClosed` is folded in three
 * places that must agree: `nominationsReducer` frees the board seat and the
 * nominating Team's Slot, `auctionsReducer` drops the Auction, and
 * `projection/contracts.ts`'s `contractsReducer` records who now owns the
 * Player and at what price. Those three are two halves of one fact plus the
 * fact itself — the Player left the pool AND landed on a Team — so a payload
 * that any of them skips must be skipped by all of them.
 *
 * The alternative was measured and rejected: when the first two gated only on
 * `fantraxPlayerId` while the third also required a Team, a placement and two
 * parseable amounts, a payload naming a valid Player with a corrupt `teamId`
 * released the seat and removed the Auction while recording NO contract. The
 * won Player was then in no auction, no nomination, no contract and no
 * `team_rosters` row — silently back in the nominatable pool, with the
 * winning Team's Cap Space and Roster Count never moving. Skipping such a
 * payload in all three leaves the Auction standing and visible instead, which
 * is the loud failure rather than the silent one (NFR1, AD-5).
 *
 * The fields split the way every `readPayload` in this core splits its own:
 *
 *   - **Here, because they cannot be guessed.** The Player, the winning Team,
 *     the placement and both money figures are what a close IS. A close
 *     naming no Player identifies no board seat; one naming no Team records
 *     an ownership nobody holds; an unparseable amount is not a price; and a
 *     placement that is neither kind decides both Roster Count and the Cap
 *     treatment.
 *   - **Not here, because they are audit detail no fold decides on.** The two
 *     names and `closedAt` are repaired by `contracts.ts` against their ids
 *     and the event's own instant. Dropping a real contract over a cosmetic
 *     field would be the very failure this reader exists to prevent.
 *
 * A negative amount is rejected on `auctions.ts`'s grounds: `parseMoney`
 * accepts an optionally-signed digit run legitimately, because Available Cap
 * Space is legitimately negative, so a PRICE has to refuse the sign here.
 */
export type ClosedFacts = {
	readonly fantraxPlayerId: string;
	readonly teamId: string;
	readonly placement: SlotPlacement;
	readonly winningAmount: Money;
	readonly capHit: Money;
};

export function readClosedFacts(payload: unknown): ClosedFacts | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const record = payload as Record<string, unknown>;

	const fantraxPlayerId = record['fantraxPlayerId'];
	if (typeof fantraxPlayerId !== 'string' || fantraxPlayerId === '') return null;

	const teamId = record['teamId'];
	if (typeof teamId !== 'string' || teamId === '') return null;

	const placement = record['placement'];
	if (typeof placement !== 'string') return null;
	if (!SLOT_PLACEMENTS.includes(placement as SlotPlacement)) return null;

	// Both amounts are parsed rather than trusted, and parsed SEPARATELY —
	// neither is read out of the other (AD-23). `parseMoney` accepts the two
	// shapes an `int8` arrives as and throws on everything else (AD-8); that
	// throw is caught and turned into a skip, because a corrupt payload in an
	// insert-only log is not a fold's to crash over.
	let winningAmount: Money;
	let capHit: Money;
	try {
		winningAmount = parseMoney(record['winningAmount']);
		capHit = parseMoney(record['capHit']);
	} catch {
		return null;
	}
	if (winningAmount < 0 || capHit < 0) return null;

	return { fantraxPlayerId, teamId, placement: placement as SlotPlacement, winningAmount, capHit };
}

/**
 * The Player a well-formed `AuctionClosed` names, or `null` when the payload
 * is not one.
 *
 * A thin reading of `readClosedFacts` above, kept as its own name because two
 * of the three folds need only this field. It inherits that reader's full
 * strictness deliberately: what makes a close well formed is one question
 * with one answer, not a per-caller one.
 *
 * **Exported because the release has two halves that must agree.** The fold
 * frees the Slot; `server/nomination.ts`'s `releaseNomination` deletes the
 * claim row. Both read the same event through this one function rather than
 * through two literals that could come to disagree about what a malformed
 * close means — a close the fold skipped but the delete acted on (or the
 * reverse) would leave the log and the claim table saying different things
 * about the same Slot.
 */
export function readClosedPlayerId(payload: unknown): string | null {
	return readClosedFacts(payload)?.fantraxPlayerId ?? null;
}

/**
 * Every entry of a record except the named key.
 *
 * Built through `Object.entries`/`Object.fromEntries` rather than by
 * assignment, for `hasOwn`'s reason: the keys are data, and
 * `record[key] = value` on a key of `__proto__` would set a prototype
 * instead of an entry. `fromEntries` defines own properties and cannot be
 * subverted that way.
 */
function omitKey(
	record: Readonly<Record<string, OpenNomination>>,
	key: string
): Readonly<Record<string, OpenNomination>> {
	return Object.fromEntries(Object.entries(record).filter(([existing]) => existing !== key));
}

/**
 * Fold one event onto the open nominations.
 *
 * The `default: return state` discipline is `phase.ts`'s, for the same
 * reason: an event type this reducer has not been taught is not an error, it
 * is simply not about nominations.
 *
 * A nomination whose Player is already on the board, or whose Team already
 * holds an open nomination, leaves the state untouched — which is what makes
 * folding the same log twice converge on the identical result. A close for a
 * Player nobody nominated leaves it untouched for the same reason, which is
 * also what makes the release converge on a double replay: the second fold
 * of a close is a no-op on an absent key.
 */
export const nominationsReducer: Reducer<OpenNominations> = (state, event) => {
	switch (event.type) {
		case NOMINATION_PLACED_EVENT: {
			const nomination = readPayload(event.payload, event);
			if (nomination === null) return state;
			if (hasOwn(state.byPlayer, nomination.fantraxPlayerId)) return state;
			if (hasOwn(state.byTeam, nomination.teamId)) return state;
			return {
				byPlayer: { ...state.byPlayer, [nomination.fantraxPlayerId]: nomination },
				byTeam: { ...state.byTeam, [nomination.teamId]: nomination }
			};
		}
		case AUCTION_CLOSED_EVENT: {
			const fantraxPlayerId = readClosedPlayerId(event.payload);
			if (fantraxPlayerId === null) return state;
			// A close for a Player who holds no board seat — one that arrived
			// before any nomination, or a second fold of one already applied —
			// changes nothing. That is what makes replay converge.
			if (!hasOwn(state.byPlayer, fantraxPlayerId)) return state;
			const released = state.byPlayer[fantraxPlayerId];
			if (released === undefined) return state;
			// Both indexes drop together, keyed off the ONE nomination object
			// they share: the board seat and the nominating Team's Slot are two
			// readings of a single fact, so they can never be released apart.
			return {
				byPlayer: omitKey(state.byPlayer, fantraxPlayerId),
				byTeam: omitKey(state.byTeam, released.teamId)
			};
		}
		default:
			return state;
	}
};
