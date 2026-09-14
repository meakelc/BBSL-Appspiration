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
 * **The board seat and the Nomination Slot are released by DIFFERENT
 * events, and that is the whole of FR-9's current rule.** They used to be one
 * fact read two ways — an `AuctionClosed` freed the seat and the nominating
 * Team's Slot together — and they are not.
 *
 *   - **The seat frees when the Auction ENDS**, either way it can end. An
 *     `AuctionClosed` ends it with a winner; an `AuctionTerminated` (Story
 *     3.7) ends it with none, when the Auction Phase expires on a Player
 *     still Awaiting an Opening Bid or FR-40's cascade cancels every
 *     Contender. Both key on the Player, and both put that Player back in the
 *     nominatable pool by this fold's arithmetic rather than by a write to
 *     `free_agent_players`.
 *   - **The Slot frees when the Team WINS a Player**, and by nothing else. It
 *     keys on the WINNING Team named by an `AuctionClosed`, which need not be
 *     — and usually is not — the Team that nominated. A Manager who
 *     nominates and is outbid keeps that Slot held: nominating is not the
 *     cost, winning is what pays it back. A termination frees no Slot at all,
 *     because nobody won.
 *
 * **The consequence is deliberate and is the point of the rule.** A Team that
 * never wins a Player nominates exactly once, for the whole auction. The Slot
 * is not a turn that comes round again; it is held until that Team takes a
 * Player off the board. What used to be an eventual, automatic return is now
 * something a Team has to earn, which is what stops one nomination being
 * parked on a Player nobody wants while its owner shops.
 *
 * It follows that a `byTeam` entry can OUTLIVE its `byPlayer` seat: the
 * Slot-holding nomination names a Player whose Auction closed long ago, and
 * every sentence that reports a held Slot still names that Player, because
 * naming what the Slot was spent on is what makes the refusal actionable.
 *
 * The two ending events are read separately rather than shared because what
 * makes each WELL FORMED differs: a close must name a winner, a price and a
 * placement — and the winner is exactly what the Slot release now needs —
 * whereas a termination names none of those and could not.
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

/**
 * The event type that ends a nominated Player's Auction with no Bid that still
 * stands, releasing the nomination (Story 3.7, FR-22).
 *
 * Declared here, beside the reducer that gives it meaning, for
 * `AUCTION_CLOSED_EVENT`'s reason. **Two producers.** `core/rules/phase-end.ts`
 * appends one for every nomination still in Awaiting Opening Bid when the
 * League Clock expires — no Bid was ever placed — inside the same transaction
 * as the `ContractAssignmentOpened` that follows them all. `core/rules/close.ts`
 * appends one for a Minimum-Bid Contention whose every Contender was cancelled
 * by FR-40's cascade (Story 10.5) — Teams did bid, and none of those joins
 * still stands — after the `ContentionDrawn` that reveals the seed over the
 * empty list.
 *
 * **A termination is not a close, appends no contract, and frees no
 * Nomination Slot.** Nobody was left to win: the Player simply stops being on
 * the board. `contractsReducer` has no case for this event and needs none,
 * which is what returns the Player to the Free Agent pool by arithmetic
 * rather than by a table write — and the absence of a winner is exactly why
 * no Slot is released, because since FR-9's amendment only a WIN releases
 * one. The nominating Team keeps the Slot it spent on a Player nobody bid
 * for.
 *
 * **It names the NOMINATING Team**, not a winner — there is no winner. That
 * is the one substantive difference from a close, and it is why the payload
 * this reducer reads is its own rather than `AuctionClosed`'s.
 */
export const AUCTION_TERMINATED_EVENT = 'AuctionTerminated';

/** One open nomination, as every refusal sentence needs to name it. */
export type OpenNomination = {
	/** The Player nominated. */
	readonly fantraxPlayerId: string;
	/** That Player's name — what a refusal says out loud. */
	readonly playerName: string;
	/**
	 * The Team that nominated — and so, while `holdsSlot`, the Team whose
	 * Nomination Slot this holds until that Team wins a Player.
	 */
	readonly teamId: string;
	/** That Team's name — what a refusal says out loud. */
	readonly teamName: string;
	/**
	 * The Manager who nominated, or `null` when the payload named none
	 * (Story 3.7).
	 *
	 * No gate reads it and no refusal prints it. It is here because an
	 * `AuctionTerminated` must carry the NOMINATING Manager and Team on its
	 * envelope, exactly as an `AuctionClosed` carries the winner's, and this
	 * fold is the only thing that still knows who nominated by the time the
	 * League Clock expires.
	 *
	 * `null` rather than a fallback to the id: `auction_events.manager_id`
	 * references `managers(id)`, so an invented value would be a foreign-key
	 * violation rather than a cosmetic blemish, and the two names above fall
	 * back precisely because they reference nothing. A nomination whose payload
	 * named no Manager still holds its Slot and still frees it —
	 * `rules/phase-end.ts` is what decides what to write on an envelope that
	 * has no Manager to name.
	 */
	readonly managerId: string | null;
	/**
	 * Whether this nomination spends the nominating Team's one Nomination
	 * Slot (Story 9.8).
	 *
	 * `true` for every Manager nomination, which is the rule FR-8 states and
	 * the only case that existed before this field. `false` for a
	 * Commissioner's, because a Commissioner nominates to keep the board
	 * full rather than to spend a Slot they happen to own, and the League
	 * cannot wait on seven people to each spend one.
	 *
	 * **Recorded on the event, never looked up at fold time.** A fold must be
	 * a function of the log alone (AD-2): asking `managers.is_commissioner`
	 * here would make replay depend on who is a Commissioner TODAY, so a
	 * Manager promoted after the auction would retroactively un-spend a Slot
	 * they really did spend. The payload states what was true when the
	 * nomination was placed, and stays true forever.
	 *
	 * A payload with no such field folds to `true` — every nomination written
	 * before this field existed was a Slot-spending one.
	 */
	readonly holdsSlot: boolean;
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
 *
 * **`byTeam` indexes only Slot-spending nominations, and that is the whole
 * of the Commissioner exemption** (Story 9.8). A Commissioner's nomination
 * takes a board seat in `byPlayer` exactly as any other does — the Player is
 * nominated, and nobody may nominate them twice — and is simply absent from
 * `byTeam`, so `nominationForTeam` keeps answering the one question it was
 * ever asked: has this Team spent its Slot. That is why no gate, surface or
 * card downstream needed a second rule about Commissioners: a Slot that is
 * never held reads as open, which is what it is.
 *
 * It follows that `byTeam` is no longer a subset-by-key of `byPlayer`'s
 * values, and that the two indexes can hold different numbers of entries.
 * Since FR-9's amendment it follows a second time and much more commonly: a
 * `byTeam` entry survives its own `byPlayer` seat, because the seat ends with
 * the Auction and the Slot ends only when that Team wins a Player. Most held
 * Slots, late in an auction, name a Player who is no longer on the board.
 * Nothing may therefore assume a `byTeam` nomination is still live — read
 * `byPlayer`, or the Auctions fold, to ask that.
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
	const managerId = record['managerId'];
	const holdsSlot = record['holdsSlot'];

	return {
		fantraxPlayerId,
		// The names are audit detail the refusals print; the ids are what the
		// gate matches on. A missing name falls back to the id, which still
		// identifies the thing, rather than dropping the nomination entirely
		// and freeing a Slot that was genuinely spent.
		playerName: typeof playerName === 'string' && playerName !== '' ? playerName : fantraxPlayerId,
		teamId,
		teamName: typeof teamName === 'string' && teamName !== '' ? teamName : teamId,
		// No fallback, unlike the two names above: this id becomes an
		// `auction_events.manager_id`, which references `managers(id)`, so an
		// invented value would fail a foreign key rather than merely read oddly.
		// A nomination that named no Manager is still a nomination.
		managerId: typeof managerId === 'string' && managerId !== '' ? managerId : null,
		// Absent reads as `true`, and only an explicit `false` exempts. Every
		// nomination written before Story 9.8 spent a Slot, so the missing
		// field is not an unknown to be guessed at — it is the old rule,
		// stated by its absence. Requiring the literal `false` also means a
		// payload corrupted into some other shape falls back to the STRICTER
		// answer, which is the direction a gate should fail in.
		holdsSlot: holdsSlot !== false,
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
 * frees the Player's board seat; `server/nomination.ts`'s `releaseNomination`
 * deletes the matching claim row. Both read the same event through this one
 * function rather than through two literals that could come to disagree about
 * what a malformed close means — a close the fold skipped but the delete acted
 * on (or the reverse) would leave the log and the claim table saying different
 * things about the same Player.
 *
 * It answers for the SEAT only. The Slot half of a close keys on the winning
 * Team, so `releaseNomination` reads that through `readClosedFacts` directly,
 * exactly as `nominationsReducer` does.
 */
export function readClosedPlayerId(payload: unknown): string | null {
	return readClosedFacts(payload)?.fantraxPlayerId ?? null;
}

/**
 * The Player a well-formed `AuctionTerminated` names, or `null` when the
 * payload is not one (Story 3.7).
 *
 * `readClosedPlayerId`'s shape and `readClosedPlayerId`'s reason, for its own
 * event — including the reason it is EXPORTED. The release has two halves
 * that must agree: this fold frees the Player's board seat, and
 * `server/nomination.ts`'s `releaseNomination` deletes the claim row. A
 * termination frees no Nomination Slot at all, so unlike a close it has only
 * the one half. Both read the same event through
 * this one function rather than through two literals that could come to
 * disagree about what a malformed termination means. A termination the fold
 * skipped but the delete acted on — or the reverse — would leave the log and
 * the claim table saying different things about the same Slot, and an
 * insert-only log can never be replayed to clear a stale claim row.
 *
 * **Strictly less demanding than `readClosedFacts`, and that is correct
 * rather than lax.** A close is well formed only if it names a winner, a
 * placement and two parseable amounts, because three folds act on it and one
 * of them records ownership. A termination records no ownership at all: it
 * names a Player and ends their Auction, and this fold is the only one that
 * acts on it. Requiring fields the event has no reason to carry would refuse
 * well-formed terminations and strand Slots forever.
 */
export function readTerminatedPlayerId(payload: unknown): string | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const record = payload as Record<string, unknown>;
	const fantraxPlayerId = record['fantraxPlayerId'];
	if (typeof fantraxPlayerId !== 'string' || fantraxPlayerId === '') return null;
	return fantraxPlayerId;
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
 * Drop a Player's board seat — the release both ending events share.
 *
 * **It no longer touches `byTeam`, and that is the rule change.** A seat and
 * a Slot were one fact read two ways until FR-9 was amended; now the seat
 * ends with the Auction and the Slot ends with a win, so releasing them
 * together would hand a Slot back to a Manager who was outbid. The Slot
 * release lives in `releaseSlot` below and keys on the WINNER.
 *
 * Returns `null` when no seat is held, so both callers keep the no-op that
 * makes a double replay converge.
 */
function releaseSeat(
	state: OpenNominations,
	fantraxPlayerId: string
): OpenNominations | null {
	if (!hasOwn(state.byPlayer, fantraxPlayerId)) return null;
	return {
		byPlayer: omitKey(state.byPlayer, fantraxPlayerId),
		byTeam: state.byTeam
	};
}

/**
 * Free the winning Team's Nomination Slot — the ONE thing that frees one.
 *
 * Keyed on the Team that WON, never on the Team that nominated, and it is
 * deliberately blind to WHICH Player the released Slot was spent on: a Team
 * holds at most one Slot, so winning any Player at all returns it. That is
 * the whole of the amended FR-9, and the reason it is worth stating twice:
 * the Slot a Manager gets back on winning Kevin Durant is very often the one
 * they spent nominating somebody else entirely, weeks earlier.
 *
 * Consequently there is **no identity check** of the kind the old combined
 * release needed. That check existed because a Commissioner's exempt
 * nomination could otherwise free a Slot-spending one held by the same Team;
 * it cannot arise here, because this release is not reached from a
 * nomination at all. A win frees whatever Slot the winner holds, and a winner
 * holding none — a Commissioner, or a Team that has not nominated — is the
 * no-op that makes replay converge.
 *
 * Returns `null` when that Team holds no Slot.
 */
function releaseSlot(state: OpenNominations, winningTeamId: string): OpenNominations | null {
	if (!hasOwn(state.byTeam, winningTeamId)) return null;
	return {
		byPlayer: state.byPlayer,
		byTeam: omitKey(state.byTeam, winningTeamId)
	};
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
 * Player nobody nominated, or won by a Team holding no Slot, leaves the
 * corresponding index untouched for the same reason, which is also what makes
 * both releases converge on a double replay: the second fold of a close is a
 * no-op on an absent key, twice over.
 */
export const nominationsReducer: Reducer<OpenNominations> = (state, event) => {
	switch (event.type) {
		case NOMINATION_PLACED_EVENT: {
			const nomination = readPayload(event.payload, event);
			if (nomination === null) return state;
			if (hasOwn(state.byPlayer, nomination.fantraxPlayerId)) return state;
			// **The Slot check gates only the Slot index** (Story 9.8). A
			// Commissioner's nomination holds no Slot, so there is no Slot for a
			// second one to collide with, and it is folded onto the board beside
			// however many others that Commissioner has open. The Player check
			// above is untouched and still absolute: exemption is from the Team's
			// one-Slot rule, never from "a Player is nominated once".
			if (!nomination.holdsSlot) {
				return {
					byPlayer: { ...state.byPlayer, [nomination.fantraxPlayerId]: nomination },
					byTeam: state.byTeam
				};
			}
			if (hasOwn(state.byTeam, nomination.teamId)) return state;
			return {
				byPlayer: { ...state.byPlayer, [nomination.fantraxPlayerId]: nomination },
				byTeam: { ...state.byTeam, [nomination.teamId]: nomination }
			};
		}
		case AUCTION_TERMINATED_EVENT: {
			// **The `AuctionClosed` case below, for the other way an Auction
			// ends** (Story 3.7). The League Clock expired with this Player still
			// Awaiting an Opening Bid, so the board seat and the nominating Team's
			// Slot are released exactly as a close releases them — and, exactly as
			// with a close, this fold records no contract, so the Player is back in
			// the nominatable pool by arithmetic rather than by a table write.
			//
			// A termination for a Player who holds no board seat is a no-op, which
			// is what makes replay converge and what makes a second evaluation of
			// an already-ended phase harmless.
			const terminated = readTerminatedPlayerId(event.payload);
			if (terminated === null) return state;
			// The SEAT only. A termination has no winner, and since FR-9's
			// amendment only a win frees a Slot — so the nominating Team keeps
			// theirs, spent on a Player who is now back in the pool for somebody
			// else to nominate.
			return releaseSeat(state, terminated) ?? state;
		}
		case AUCTION_CLOSED_EVENT: {
			// **The one event that touches both indexes, for two unrelated
			// reasons.** The close ends an Auction, which frees that Player's
			// board seat; the close also names a WINNER, which frees that Team's
			// Nomination Slot. The two are read off the same payload and applied
			// in sequence, but they are not one fact: the Player whose seat drops
			// and the Team whose Slot drops are usually nothing to do with each
			// other.
			//
			// Read through `readClosedFacts` rather than `readClosedPlayerId`
			// because the winner is now load-bearing here — and reading the whole
			// close keeps this fold refusing exactly the payloads
			// `contractsReducer` refuses, which is the invariant that reader
			// exists for.
			const closed = readClosedFacts(event.payload);
			if (closed === null) return state;
			// Either half may be a no-op and both commonly are: a close for a
			// Player who holds no board seat — one that arrived before any
			// nomination, or a second fold of one already applied — drops no
			// seat, and a winner who holds no Slot frees none. That is what makes
			// replay converge.
			const afterSeat = releaseSeat(state, closed.fantraxPlayerId) ?? state;
			return releaseSlot(afterSeat, closed.teamId) ?? afterSeat;
		}
		default:
			return state;
	}
};
