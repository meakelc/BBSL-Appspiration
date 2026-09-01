/**
 * Minimum-Bid Contention draws, folded from the log (Story 3.6, FR-19, AD-14).
 *
 * **This fold exists because the Auction does not outlive the close.**
 * `auctionsReducer` removes a Player from `auctions.byPlayer` the moment their
 * `AuctionClosed` is folded — that is what makes the sweep re-derivable and
 * what makes a won Player stop being Minors Exposure — so the seed, the
 * ordered Contender list and the selection would leave with it. AD-14's whole
 * premise is that a losing Manager can check the draw afterwards, and
 * "afterwards" is exactly when the Auction is gone. So the three facts fold
 * into a projection of their own and NOTHING removes an entry from it.
 *
 * `CONTENTION_DRAWN_EVENT` is declared here rather than beside the transaction
 * that appends it, for `CONTENTION_DISSOLVED_EVENT`'s reason
 * (`projection/auctions.ts`): this is the reducer that gives it meaning, there
 * is no central event registry in this codebase, and no database check
 * constraint on `event_type` — so a const beside its reducer is where an event
 * type comes into existence.
 *
 * **The two exits from a Minimum-Bid Contention are read the same way.** A
 * dissolution reveals through `ContentionDissolved` and a draw reveals through
 * this event, and both carry the same four things: the revealed seed, the
 * commitment it answers, the ordered Contender ids as they stood, and what
 * became of the contention. Putting the seed on `AuctionClosed` instead would
 * have made one exit a payload field and the other an event.
 *
 * **First draw wins.** A second `ContentionDrawn` for one Player changes
 * nothing, which is what makes folding the same log twice converge on the same
 * winner (AD-5) — the same answer `contractsReducer`, `nominationsReducer` and
 * `auctionsReducer` all give a repeated event. In practice one cannot arrive:
 * the Auction leaves `auctions.byPlayer` on its close, so nothing can produce
 * a second draw for the same Player.
 *
 * A malformed historical payload is SKIPPED rather than thrown over — an
 * insert-only log cannot be corrected in place (AD-4), so a reducer must be
 * total over any log it is handed. `readDrawnFacts` is that reader.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import type { Reducer } from './fold.ts';

/**
 * The event type a draw appends, BEFORE the `AuctionClosed` it causes.
 *
 * Cause then consequence, `ContentionDissolved`'s own idiom: a log read in
 * `seq` order states the draw that selected the winner before it states the
 * close that awarded the Player to them. Both are appended in one transaction
 * by the one `runTransactionalWrite` loop that has always supported N events.
 *
 * **It carries the REVEALED seed, and that is why it exists at all.** A
 * contention that closed with its seed still sealed is the outcome AD-14
 * cannot survive: the commitment was published, a Team was awarded a Player,
 * and nothing would ever open the envelope. `decideClose` verifies the seed
 * against the published commitment before it builds this payload, so a reveal
 * that does not match what a Manager already recorded is foreclosed rather
 * than merely tested for.
 */
export const CONTENTION_DRAWN_EVENT = 'ContentionDrawn';

/**
 * One draw, as the reveal recorded it — the three facts PRD SS10 example 8 asks
 * to be "recorded and displayed", plus the commitment they answer.
 *
 * `seedHash` is `null` only for a lottery whose opening published no readable
 * commitment, which is reachable from a corrupt or hand-written log alone. It
 * is carried as the absence it is rather than omitted, so a reading of this
 * projection never has to decide whether a missing field means "unverifiable"
 * or "not looked up".
 *
 * `selectedIndex` is the position the reduction produced. It is redundant with
 * `contenders[selectedIndex] === winningTeamId` BY CONSTRUCTION, and that is
 * the point: a Manager who runs the 64-row spreadsheet has a number in hand,
 * and the record they check it against is a number rather than a lookup they
 * have to perform correctly first.
 */
export type Draw = {
	readonly fantraxPlayerId: string;
	/** The seed, revealed. The one place a drawn seed enters `auction_events`. */
	readonly seed: string;
	/** The commitment it was published against, or `null` if none ever was. */
	readonly seedHash: string | null;
	/** The Contender list the draw ran over, ascending join `seq` — ids. */
	readonly contenders: readonly string[];
	/** The 0-based position `seed mod contenders.length` produced. */
	readonly selectedIndex: number;
	/** The Team at that position. */
	readonly winningTeamId: string;
	/** That Team's name, so a reading names the winner without a second lookup. */
	readonly winningTeamName: string;
	/**
	 * The Manager whose joining Bid put that Team in the draw, or `null` when
	 * the recorded payload carried none.
	 *
	 * Nullable rather than falling back, unlike the two names beside it: a name
	 * standing in for its own id still points at the same thing, while a
	 * Manager id filled in from anywhere else would name a person who was not
	 * there. `decideClose` always writes it, so `null` means a corrupt or
	 * hand-written row and says exactly that.
	 */
	readonly winningManagerId: string | null;
};

/** Every draw this log has recorded, keyed on the Player. */
export type Draws = {
	readonly byPlayer: Readonly<Record<string, Draw>>;
};

/** With no `ContentionDrawn` event, no lottery has drawn. */
export const INITIAL_DRAWS: Draws = Object.freeze({
	byPlayer: Object.freeze({}) as Readonly<Record<string, Draw>>
});

/**
 * `Object.prototype.hasOwnProperty`, called against the record rather than
 * through it — `contracts.ts`'s `hasOwn`, for its reason: the keys are Fantrax
 * player ids, which are data, so a key of `constructor` must not read back as
 * an inherited function and be mistaken for a draw.
 */
function hasOwn(record: Readonly<Record<string, Draw>>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

/** The draw recorded for a Player, or `null` when no lottery drew for them. */
export function drawForPlayer(draws: Draws, fantraxPlayerId: string): Draw | null {
	if (!hasOwn(draws.byPlayer, fantraxPlayerId)) return null;
	return draws.byPlayer[fantraxPlayerId] ?? null;
}

/**
 * The `ContentionDrawn` payload as this reducer needs it, read defensively.
 *
 * `AppendedEvent.payload` is `unknown` — whatever JSON the column holds — and
 * an insert-only log cannot be corrected in place, so a malformed historical
 * row must never crash the fold. Returning `null` rather than throwing is
 * `readPayload`'s discipline everywhere else in the core, for the same reason.
 *
 * **What is required is what makes a draw MEAN anything**: the Player it is
 * about, the seed it revealed, the list it ran over and the Team it selected.
 * A payload short any of those is not a partial draw to be repaired — it is a
 * row that cannot answer the question this projection exists to answer, and
 * recording it would put a half-draw on a verification surface.
 *
 * `seedHash` is the one field allowed to be absent, because `null` is a real
 * value it can honestly hold. The two names fall back to their ids, which
 * still identify the thing — dropping a real draw over a cosmetic field would
 * be the failure this reader exists to prevent. `selectedIndex` falls back to
 * the winner's own position in the recorded list, which is where it came from.
 */
export function readDrawnFacts(payload: unknown): Draw | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const record = payload as Record<string, unknown>;

	const fantraxPlayerId = record['fantraxPlayerId'];
	if (typeof fantraxPlayerId !== 'string' || fantraxPlayerId === '') return null;

	const seed = record['seed'];
	if (typeof seed !== 'string' || seed === '') return null;

	const winningTeamId = record['winningTeamId'];
	if (typeof winningTeamId !== 'string' || winningTeamId === '') return null;

	const rawContenders = record['contenders'];
	if (!Array.isArray(rawContenders)) return null;
	// Every entry, or none: a list with a hole in it is not the ordered list
	// AD-14 makes an input to the winner, and silently dropping the hole would
	// renumber every position after it.
	if (!rawContenders.every((entry) => typeof entry === 'string' && entry !== '')) return null;
	const contenders = rawContenders as readonly string[];
	if (contenders.length === 0) return null;

	// **The winner must be ON the list the draw ran over**, and this is the one
	// cross-FIELD check in this reader. Every test above asks whether a field
	// is well formed by itself; this one asks whether two of them describe the
	// same event. A payload naming a winner absent from its own Contender list
	// is not a draw with a bad field — it is a record inviting a Manager to
	// reproduce a derivation that could not have produced it, which is the
	// exact opposite of what this projection exists for. `readClosedFacts`
	// (`projection/nominations.ts`) took the same posture for the same reason:
	// partial validation split across readers is what lets a half-formed row
	// through one door and not another.
	const winnerPosition = contenders.indexOf(winningTeamId);
	if (winnerPosition < 0) return null;

	const seedHash = record['seedHash'];
	const winningTeamName = record['winningTeamName'];
	const winningManagerId = record['winningManagerId'];
	const selectedIndex = record['selectedIndex'];

	return {
		fantraxPlayerId,
		seed,
		seedHash: typeof seedHash === 'string' && seedHash !== '' ? seedHash : null,
		contenders,
		// **In range, or recovered from the list.** An integer alone is not a
		// position: a negative or past-the-end value would put the recorded
		// selection outside the very list it indexes, which is the one thing a
		// verification surface must never show. The fallback is the winner's
		// own place in the recorded list, which is where the number came from.
		selectedIndex:
			typeof selectedIndex === 'number' &&
			Number.isInteger(selectedIndex) &&
			selectedIndex >= 0 &&
			selectedIndex < contenders.length
				? selectedIndex
				: winnerPosition,
		winningTeamId,
		winningTeamName:
			typeof winningTeamName === 'string' && winningTeamName !== ''
				? winningTeamName
				: winningTeamId,
		// **No fallback, and emphatically not to the Team id.** A name falling
		// back to its own id still identifies the thing it names; a MANAGER id
		// filled in with a TEAM id is a value from another namespace wearing
		// this field's label, and a surface printing it would attribute the
		// draw to a Manager who does not exist. `null` is the honest record of
		// an absence, and `decideClose` always writes the field, so only a
		// corrupt or hand-written row reaches it.
		winningManagerId:
			typeof winningManagerId === 'string' && winningManagerId !== '' ? winningManagerId : null
	};
}

/**
 * Fold one event onto the draws.
 *
 * The `default: return state` discipline is `phase.ts`'s, for the same reason:
 * an event type this reducer has not been taught is not an error, it is simply
 * not about draws.
 *
 * **There is no removal case, and that is the whole design.** `AuctionClosed`
 * is not folded here: the close is what makes the Auction disappear, and this
 * projection exists precisely so the draw does not disappear with it. A
 * reducer that dropped an entry on any event would be a verification surface
 * that erases the thing being verified.
 */
export const drawsReducer: Reducer<Draws> = (state, event) => {
	switch (event.type) {
		case CONTENTION_DRAWN_EVENT: {
			const draw = readDrawnFacts(event.payload);
			if (draw === null) return state;
			// The FIRST draw seen, kept — what makes a second fold of one log
			// converge on the same winner (AD-5).
			if (hasOwn(state.byPlayer, draw.fantraxPlayerId)) return state;
			return { byPlayer: { ...state.byPlayer, [draw.fantraxPlayerId]: draw } };
		}
		default:
			return state;
	}
};
