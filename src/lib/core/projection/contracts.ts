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
 * `open_nominations` and `nomination_slots` are tables because each needs a
 * UNIQUENESS CONSTRAINT for a real race between two Managers. A close has no
 * such race: it is one writer under the global lock (AD-6), so a table here
 * would only have to be undone.
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
 * **First close wins, LATEST assignment wins**, and the two rules sit in one
 * reducer without contradicting each other because they are about different
 * events. Story 6.1 adds `ContractLengthAssigned`, which sets `contractYears`
 * on a contract this fold already holds; a Manager may correct a length until
 * their Team is submitted as final, so a later event for the same Player
 * overwrites the earlier one and the Year Allotment is a COUNT over the current
 * folded lengths rather than a ledger of what was spent. Replay still converges:
 * both rules are functions of the log's order alone.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { parseMoney } from '../money.ts';
import type { Money } from '../money.ts';
import type { CapHitRow } from '../rules/roster-import.ts';
import type { RosterSlotKind, SlotPlacement } from '../types.ts';
import type { Reducer } from './fold.ts';
import { AUCTION_CLOSED_EVENT, readClosedFacts } from './nominations.ts';

export type { SlotPlacement };

/**
 * The four contract lengths the Year Allotment can spend, and the only values
 * `AuctionContract.contractYears` may ever hold.
 *
 * A union of four literals rather than `number`, for `SlotPlacement`'s reason:
 * the set is closed by the PRD (§3 "Year Allotment") and a length outside it
 * is not a shorter or longer deal, it is a bug. Making `5` unwritable in the
 * type is what stops a route, a payload reader or a test fixture inventing one.
 *
 * `1` is in the union like any other length even though the allotment does not
 * count it: PRD §3 makes one-year deals unlimited, which is a statement about
 * how many may be spent, never about whether a one-year deal is a real length.
 */
export type ContractYears = 1 | 2 | 3 | 4;

/**
 * The event type that assigns a contract length to one Auction Contract
 * (Story 6.1, FR-21, PRD §10 example 14).
 *
 * Declared here, beside the reducer that gives it meaning, for
 * `nominations.ts`'s `AUCTION_CLOSED_EVENT` reason — the fold IS what a
 * contract length is. There is no `contract_length` column and no contracts
 * table: a length is `contractYears` on the contract this reducer already
 * folds, which is why every read surface and the export reach it without
 * learning a second source.
 *
 * **The LATEST assignment per Player wins**, which is the exact opposite of
 * `AUCTION_CLOSED_EVENT`'s first-wins rule, and both are right. A close is a
 * fact about an Auction that happened once; an assignment is the Manager's
 * current answer to a question they may change until they submit their Team as
 * final. A correction is therefore an APPENDED event and never an update, and
 * the length it previously held returns to the Year Allotment by arithmetic
 * rather than by a compensating event.
 */
export const CONTRACT_LENGTH_ASSIGNED_EVENT = 'ContractLengthAssigned';

/**
 * The payload a `ContractLengthAssigned` carries.
 *
 * `teamId` is on the payload as well as on the envelope, and that is not a
 * duplication this fold can do without: `readAssignmentPayload` refuses to move
 * a length onto a contract another Team holds, and it can only make that check
 * against a Team the payload itself names. The envelope's `team_id` is the
 * ACTOR; this is the contract's owner, and the rules gate has already
 * established they are the same Team.
 *
 * `playerName` and `teamName` are audit detail — what the Audit Log says out
 * loud — and nothing folds on either.
 */
export type ContractLengthAssignedPayload = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly teamId: string;
	readonly teamName: string;
	readonly managerId: string;
	readonly contractYears: ContractYears;
};

/**
 * Whether a value is one of the four legal lengths.
 *
 * Exported so no call site writes the four literals out again: a route parsing
 * a form field, a payload reader defending the fold and a test fixture all ask
 * this one question, and a fifth length could never be admitted by only one of
 * them.
 */
export function isContractYears(value: unknown): value is ContractYears {
	return value === 1 || value === 2 || value === 3 || value === 4;
}

/**
 * One Auction Contract, as the close recorded it.
 *
 * What the Cap arithmetic and the `under_contract` refusal need without
 * re-folding the Auction it came from: the Team that owns it (id AND name,
 * because the refusal NAMES the holder and an id is not a name a Manager
 * recognises), the two AD-23 money fields, where the Player landed, and when
 * the Auction was due to close.
 *
 * **`contention` is deliberately not held here**, though `AuctionClosedPayload`
 * carries it. Nothing this story derives asks which contention an Auction
 * closed out of — the winner and the price are already settled by the time a
 * contract exists — and the log keeps the answer for whoever eventually wants
 * it. A consumer that needs to tell a lottery win from a standard one (Epic
 * 4's Your Positions, an audit view) should widen this type then, against a
 * real caller, rather than carrying a field no reader has.
 *
 * `contractYears` is `ContractYears | null`, and the `null` half is still the
 * absence rather than a placeholder. FR-21 says contract length is recorded
 * UNSET at a close, so a contract arrives here `null` and STAYS `null` until a
 * `ContractLengthAssigned` names a length for it (Story 6.1). A `0` would be a
 * length, and a wrong one; the union is deliberately the four legal lengths and
 * nothing else, so `contractYears: 5` cannot be written down anywhere.
 *
 * The widening was Story 3.4's own forecast — "a story that starts assigning
 * lengths widens the type and becomes a compile error at every reader" — and
 * `rules/close.ts` deliberately did NOT move with it: a close records UNSET and
 * its outcome type still says `null`, which is a narrower type and assigns
 * cleanly into this one.
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
	/** Recorded UNSET at a close; set by a `ContractLengthAssigned` (Story 6.1). */
	readonly contractYears: ContractYears | null;
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
 * One Team's Auction Contracts as CONTRACTS — newest close first (Story 4.4).
 *
 * **Beside `contractRowsFor`, never instead of it.** That one is the Cap
 * bridge and yields `CapHitRow`, which carries a cap hit and a slot kind and
 * nothing else: no Player name, no winning amount and no `closedAt`. Your
 * Positions' Won group names the Player, states what the Auction was won for
 * and states when it closed, so it needs the contract itself. Widening
 * `CapHitRow` to carry those three would push presentation fields into the
 * shape `computeCapSpace` sums over, which is the opposite of what makes the
 * Cap arithmetic have one definition.
 *
 * **Bounded by construction, which is why no time window is needed.** A Team
 * holds at most twelve Active/Bench Slots plus its Minor League Slots, so
 * this list cannot grow without limit however long the Auction Phase runs.
 * A "last 24 hours" cut would not be a rendering choice: it would be a
 * decision about when a Manager last looked, and nothing in the log records
 * that.
 *
 * **Newest `closedAt` first, tie-broken TOTALLY on `fantraxPlayerId`.**
 * Several Auctions legitimately share a close instant — a sweep closes every
 * expired Auction in one transaction, and `closedAt` is the Auction's own
 * nominal expiry rather than the transaction clock — so a comparator
 * returning 0 would leave `Array.prototype.sort` free to reorder them between
 * two renders of the same state. That is `sortBoard`'s and `byCloseThenPlayer`'s
 * rule, and it is why the instants are compared as STRINGS: `closedAt` is
 * ISO-8601 UTC as the payload persisted it, which sorts lexicographically in
 * instant order, and parsing it here would make an unreadable historical
 * value a reordering rather than a stable position.
 */
export function contractsWonBy(
	contracts: AuctionContracts,
	teamId: string
): readonly AuctionContract[] {
	const won: AuctionContract[] = [];
	// Sorted keys first (AD-5), so the input to the sort is itself a sequence
	// rather than an incidental object key order.
	for (const playerId of Object.keys(contracts.byPlayer).sort()) {
		const contract = contractForPlayer(contracts, playerId);
		if (contract === null) continue;
		if (contract.teamId !== teamId) continue;
		won.push(contract);
	}
	return won.sort((left, right) => {
		if (left.closedAt !== right.closedAt) return left.closedAt < right.closedAt ? 1 : -1;
		if (left.fantraxPlayerId === right.fantraxPlayerId) return 0;
		return left.fantraxPlayerId < right.fantraxPlayerId ? -1 : 1;
	});
}

/**
 * The `AuctionClosed` payload as this reducer needs it, read defensively.
 *
 * `AppendedEvent.payload` is `unknown` — whatever JSON the column holds — and
 * an insert-only log cannot be corrected in place, so a malformed historical
 * row must never crash the fold. Returning `null` rather than throwing is
 * `nominations.ts`'s and `auctions.ts`'s discipline for the same reason.
 *
 * **The rejections are not this module's, and that is the point.** Everything
 * a close must carry to mean anything — the Player, the winning Team, the
 * placement and both money figures — is validated by
 * `nominations.ts`'s `readClosedFacts`, the ONE definition of a well-formed
 * close that all three reducers folding this event share. So a payload this
 * fold skips is a payload `nominationsReducer` and `auctionsReducer` skip
 * too: the board seat, the Auction and the contract move together or not at
 * all. When they did not, a corrupt `teamId` released the seat and dropped
 * the Auction while recording no contract, and the won Player fell silently
 * back into the nominatable pool with the winning Team's Cap Space unmoved.
 *
 * What is left here is only what this fold REPAIRS, because it is audit
 * detail no fold decides on: the two names fall back to their ids, which
 * still identify the thing, and `closedAt` falls back to the event's own
 * instant. Dropping a real contract over a cosmetic field would be the very
 * failure the shared reader exists to prevent.
 */
function readPayload(
	payload: unknown,
	event: { readonly occurredAt: string }
): AuctionContract | null {
	const facts = readClosedFacts(payload);
	if (facts === null) return null;

	const record = payload as Record<string, unknown>;
	const playerName = record['playerName'];
	const teamName = record['teamName'];
	const closedAt = record['closedAt'];

	return {
		fantraxPlayerId: facts.fantraxPlayerId,
		playerName:
			typeof playerName === 'string' && playerName !== '' ? playerName : facts.fantraxPlayerId,
		teamId: facts.teamId,
		teamName: typeof teamName === 'string' && teamName !== '' ? teamName : facts.teamId,
		winningAmount: facts.winningAmount,
		capHit: facts.capHit,
		placement: facts.placement,
		// Stated as the absence it is, never as a zero-length contract.
		contractYears: null,
		closedAt: typeof closedAt === 'string' && closedAt !== '' ? closedAt : event.occurredAt
	};
}

/**
 * The `ContractLengthAssigned` payload as this reducer needs it, read
 * defensively — `readPayload`'s discipline, for `readPayload`'s reason.
 *
 * Three fields, all REJECTED rather than repaired when absent or wrong, which
 * is the opposite balance from a close's two names. Every one of them decides
 * what the fold does: a missing `fantraxPlayerId` names no contract, a
 * `contractYears` outside the four legal lengths is not a shorter deal but a
 * bug, and a missing `teamId` leaves nothing to check the contract's owner
 * against. There is no cosmetic half to repair, so there is nothing here to
 * fall back to.
 */
function readAssignmentPayload(
	payload: unknown
): { readonly fantraxPlayerId: string; readonly teamId: string; readonly contractYears: ContractYears } | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const record = payload as Record<string, unknown>;
	const fantraxPlayerId = record['fantraxPlayerId'];
	const teamId = record['teamId'];
	const contractYears = record['contractYears'];
	if (typeof fantraxPlayerId !== 'string' || fantraxPlayerId === '') return null;
	if (typeof teamId !== 'string' || teamId === '') return null;
	if (!isContractYears(contractYears)) return null;
	return { fantraxPlayerId, teamId, contractYears };
}

/**
 * The event type that records one Roster Trade (Story 7.7, FR-41, PRD §10
 * examples 36–39 and 42).
 *
 * Declared here, beside the reducer that gives it meaning, for
 * `CONTRACT_LENGTH_ASSIGNED_EVENT`'s reason — and the payload types below
 * with it, because `rules/roster-trade.ts` builds exactly what this fold
 * reads and two structurally identical declarations are the drift Story 4.5's
 * review removed elsewhere.
 *
 * **It carries the WHOLE delta** — every Player, both Teams, both Slot kinds
 * and both Cap Hits — so a replay from zero reproduces the world without
 * reaching for `team_rosters`, which is mutable reference data nothing
 * rebuilds from the log (AD-4).
 *
 * **The LATEST transfer per Player wins**, which is `ContractLengthAssigned`'s
 * rule rather than `AuctionClosed`'s. A Player may be traded twice in one
 * offseason, and the second trade is not a duplicate of the first: it is
 * where he is now. First-wins here would strand him on the Team that traded
 * him away.
 *
 * **The string stays `'RosterMoveRecorded'` while the constant says Trade**
 * (Story 7.10). The act was called a Roster Move until that story renamed it,
 * and rows written under the old name are already in `auction_events`. AD-4
 * makes the log insert-only and forbids rewriting history, so the wire name
 * is frozen and only the identifier moved. `tests/projection-contracts.test.ts`
 * asserts the literal value, so a later rename of the constant cannot
 * silently change what a replay matches on.
 */
export const ROSTER_TRADE_RECORDED_EVENT = 'RosterMoveRecorded';

/**
 * One Contract's whole journey inside a Trade.
 *
 * `capHitBefore` and `capHitAfter` are both CHARGED figures — what the
 * Contract took off each Team's Cap Space — while `winningAmount` stands
 * unchanged beside them (AD-23). §10 example 38's `$0 → $18,000,000` is
 * therefore readable off the record without anybody deriving one from the
 * other.
 *
 * `won` is what tells an Auction Contract from an Existing one: this reducer
 * folds the `true` ones and ignores the rest, because an Existing Contract is
 * a `team_rosters` row that the same transaction `UPDATE`s (AR-41).
 */
export type RosterTradeTransfer = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly fromTeamId: string;
	readonly fromTeamName: string;
	readonly toTeamId: string;
	readonly toTeamName: string;
	/** `true` for an Auction Contract — moved by this event, never by an `UPDATE`. */
	readonly won: boolean;
	readonly fromPlacement: RosterSlotKind;
	readonly toPlacement: RosterSlotKind;
	readonly capHitBefore: Money;
	readonly capHitAfter: Money;
	readonly winningAmount: Money;
	/** The assigned length this Trade cleared, or `null` where there was none. */
	readonly clearedContractYears: ContractYears | null;
};

/**
 * One Team's five figures at one instant — FR-41's "before-state and
 * after-state for both Teams", per side.
 *
 * `rosterCount` IS the Active/Bench occupancy: PRD §3 defines Roster Count as
 * exactly that count, so a second field for it would be a second name for one
 * number and the first thing to disagree.
 */
export type RosterActTeamFigures = {
	readonly teamId: string;
	readonly teamName: string;
	readonly capSpace: Money;
	readonly rosterCount: number;
	readonly injuryReserveOccupied: number;
	readonly minorLeagueOccupied: number;
};

/**
 * The payload a `RosterMoveRecorded` carries — the whole act, in the log.
 *
 * FR-41's "written to the Audit Log with actor, timestamp, before-state and
 * after-state for both Teams, and the reason" IS this payload: AD-4 makes the
 * Audit Log a read of `auction_events` rather than a second table, so
 * everything a later reading needs is here. **One entry, not two**, which is
 * why both Teams' figures sit on one payload rather than on an event each.
 *
 * The actor rides the envelope's `manager_id`/`team_id` as every other event's
 * does; `reason` is on the payload because there is no column for it.
 */
export type RosterTradeRecordedPayload = {
	readonly sendingTeamId: string;
	readonly sendingTeamName: string;
	readonly receivingTeamId: string;
	readonly receivingTeamName: string;
	readonly transfers: readonly RosterTradeTransfer[];
	readonly sendingBefore: RosterActTeamFigures;
	readonly sendingAfter: RosterActTeamFigures;
	readonly receivingBefore: RosterActTeamFigures;
	readonly receivingAfter: RosterActTeamFigures;
	/** The Commissioner's stated reason — non-blank, trimmed, permanent. */
	readonly reason: string;
};

// --- Story 7.8: the Drop, recorded but never folded -----------------------

/**
 * The event type that records one Drop (Story 7.8, FR-43, PRD §10 examples
 * 40, 41 and 43).
 *
 * Declared here, beside `ROSTER_TRADE_RECORDED_EVENT` and for the same reason,
 * with its payload types alongside it — `rules/roster-drop.ts` builds exactly
 * what the Audit Log reads, and two structurally identical declarations are
 * the drift Story 4.5's review removed elsewhere.
 *
 * **It carries the WHOLE delta** — every released Player, the Slot he left,
 * what he was charging, what is carried as Dead Money and whether his row
 * survived, plus the Team's five figures before and after — so a replay from
 * zero reproduces the world without reaching for `team_rosters`, which is
 * mutable reference data nothing rebuilds from the log (AD-4).
 *
 * **There is deliberately NO `contractsReducer` case for it, and the absence
 * is load-bearing.** `contractsReducer` folds Auction Contracts and nothing
 * else, and a Player held by an Auction Contract CANNOT be dropped —
 * `rules/roster-drop.ts` refuses him as a shape refusal, because he is not in
 * Fantrax until the FR-30/31 export and so cannot have been released there.
 * Every released Contract is therefore a `team_rosters` row that the same
 * transaction `UPDATE`s or `DELETE`s. The event exists for replay and the
 * Audit Log, not for a projection.
 *
 * **If the won refusal is ever lifted, THIS is what breaks.** A dropped
 * Auction Contract would need a fold — it has no row to mutate — and its
 * absence here is silent rather than a compile error. The dependency is
 * stated on the payload below as well as here, so it is read at both ends.
 */
export const DROP_RECORDED_EVENT = 'DropRecorded';

/**
 * One Contract's release, as the record states it.
 *
 * **`deadMoney` and `removed` are ONE decision stated twice, not two.**
 * `rules/roster-drop.ts` computes `deadMoney = chargedCapHit(row)` and removes
 * the row if and only if that amount is `$0`; both fields are written from
 * that one expression, and nothing re-derives either from the Slot kind. A
 * Minor League row was charging `$0` and so leaves nothing behind; everything
 * else is reclassified at the amount it was already charging. There is no
 * third case (AD-32).
 *
 * `chargedCapHit` is what the row took off Cap Space the day before, and
 * `value` stands unchanged beside it (AD-23) — a Minor League release reads
 * `$0` against a `value` of whatever Fantrax stated, and the pair is readable
 * off the record without anybody deriving one from the other.
 *
 * **A reading of this record trusts what it says** (AD-32). Rows written
 * before 2026-09-16 were decided under FR-43's since-removed rookie-scale
 * exception and can carry `removed: true` against a non-`$0` `chargedCapHit`
 * — an outcome no current rule produces. That is history, not corruption, and
 * re-deriving `deadMoney` from today's `chargeOf` would silently rewrite it.
 *
 * `contractYearsRemaining` and `rookieScaleRound` are the two facts that
 * exception turned on. They are still recorded — the events already in the
 * log carry them, and they remain facts about the Contract — but **nothing
 * reads either to decide anything.** The remaining years also travel with
 * Dead Money for the FR-30/31 export's sake; **within this auction the term
 * computes nothing.**
 */
export type DroppedContract = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** The Slot the Contract occupied before the Drop. */
	readonly fromPlacement: RosterSlotKind;
	/** What the row was charging Cap Space before the Drop. */
	readonly chargedCapHit: Money;
	/** The full value of the Contract, unchanged by the act (AD-23). */
	readonly value: Money;
	/** What the Team keeps carrying. `$0` exactly when the row is removed. */
	readonly deadMoney: Money;
	/** `true` when the `team_rosters` row is DELETEd rather than reclassified. */
	readonly removed: boolean;
	/** Years still to run, as Fantrax stated them, or `null`. */
	readonly contractYearsRemaining: number | null;
	/** The draft round of a rookie-scale Contract, or `null` for an ordinary one. */
	readonly rookieScaleRound: number | null;
};

/**
 * The payload a `DropRecorded` carries — the whole act, in the log.
 *
 * FR-43's record IS this payload: AD-4 makes the Audit Log a read of
 * `auction_events` rather than a second table, so everything a later reading
 * needs is here. One entry however many Players were released, because a Drop
 * is one act evaluated once.
 *
 * `teamBefore` and `teamAfter` are `RosterActTeamFigures`, reused unchanged:
 * a Drop's five figures are a Trade's five figures asked of one Team, and a
 * parallel type would be a second name for one shape.
 *
 * **They are NOT called `before` and `after`, and the prefix is load-bearing.**
 * `core/audit-log.ts`'s `mergeOverride` renders the `OverrideRecord` SHAPE off
 * any payload that carries it, and that shape's own state pair is top-level
 * `before`/`after`. A payload using those two names has its Team figures read
 * a second time as an override state map and printed raw — `teamId team-a →
 * team-a`, machine tokens and all. `RosterTradeRecordedPayload` avoids the
 * collision by naming its four figure blocks per side; this avoids it the same
 * way.
 *
 * **No reducer folds this.** See `DROP_RECORDED_EVENT` above: a won Contract
 * cannot be dropped, so every release is a `team_rosters` row the same
 * transaction mutates or removes. Lifting that refusal is what would make a
 * fold necessary, and the fold is where it would break.
 *
 * The actor rides the envelope's `manager_id`/`team_id` as every other event's
 * does; `reason` is on the payload because there is no column for it.
 */
export type DropRecordedPayload = {
	readonly teamId: string;
	readonly teamName: string;
	readonly released: readonly DroppedContract[];
	readonly teamBefore: RosterActTeamFigures;
	readonly teamAfter: RosterActTeamFigures;
	/** The Commissioner's stated reason — non-blank, trimmed, permanent. */
	readonly reason: string;
};

// --- Story 7.11: the Roster Move, recorded and folded ---------------------

/**
 * The event type that records one Roster Move (Story 7.11, FR-44, PRD §10
 * examples 44, 45 and 46).
 *
 * **It is NOT `ROSTER_TRADE_RECORDED_EVENT`, and the separation is frozen.**
 * `'RosterMoveRecorded'` is the TRADE's persisted wire name — rows are
 * already in `auction_events` under it and AD-4 forbids rewriting history, so
 * Story 7.10 renamed the identifier and left the string alone. The act this
 * constant names is the within-Team rearrangement FR-44 defines, which is a
 * different act with a different payload, so it takes a new string of its
 * own: `'RosterRearranged'`.
 *
 * **It carries the WHOLE delta** — every Contract, both placements, both Cap
 * Hits, the value, and the Team's five figures before and after — so a replay
 * from zero reproduces the world without reaching for `team_rosters`, which
 * is mutable reference data nothing rebuilds from the log (AD-4).
 *
 * **The LATEST move per Player wins**, which is the Trade's rule and not
 * `AuctionClosed`'s. A Contract may be demoted and promoted back within the
 * hour (§10 example 46's round trip), and the second Move is not a duplicate
 * of the first — it is where the Contract is now.
 */
export const ROSTER_REARRANGED_EVENT = 'RosterRearranged';

/**
 * One Contract's re-placement inside a Roster Move.
 *
 * `capHitBefore` and `capHitAfter` are both CHARGED figures — what the
 * Contract took off the Team's Cap Space on each side of the act — while
 * `value` stands unchanged beside them (AD-23). §10 example 44's Ellis reads
 * `$18,000,000 → $0` against a value of `$18,000,000`, and Brooks reads
 * `$0 → $3,000,000` against a value of `$3,000,000`; both pairs are readable
 * off the record without anybody deriving one from the other.
 *
 * `won` is what tells an Auction Contract from an Existing one: the reducer
 * below folds the `true` ones and ignores the rest, because an Existing
 * Contract is a `team_rosters` row that the same transaction `UPDATE`s.
 *
 * **There is no `clearedContractYears`.** A Move is not a transfer: the
 * Contract does not change hands, so §10 example 42's reasoning does not
 * apply and the Year Allotment is untouched (FR-44).
 */
export type RosterRearrangedMove = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** `true` for an Auction Contract — moved by this event, never by an `UPDATE`. */
	readonly won: boolean;
	readonly fromPlacement: RosterSlotKind;
	readonly toPlacement: RosterSlotKind;
	readonly capHitBefore: Money;
	readonly capHitAfter: Money;
	/** The full value of the Contract, unchanged by the act (AD-23). */
	readonly value: Money;
};

/**
 * The payload a `RosterRearranged` carries — the whole act, in the log.
 *
 * FR-44's record IS this payload: AD-4 makes the Audit Log a read of
 * `auction_events` rather than a second table, so everything a later reading
 * needs is here. ONE entry however many Contracts moved, because a Move is
 * one act evaluated once.
 *
 * **They are `teamBefore`/`teamAfter`, and the prefix is load-bearing** —
 * `DropRecordedPayload`'s note, restated because this story tried the other
 * spelling first and the suite caught it. `core/audit-log.ts`'s
 * `mergeOverride` renders the `OverrideRecord` SHAPE off any payload carrying
 * a top-level `before`/`after`, with NO second condition: it does not require
 * an `override` block and it does not check the value types. A payload using
 * those two names has its Team figures read a second time as an override
 * state map and printed raw — `teamId team-a → team-a`, machine tokens and
 * all, which `tests/core/audit-log.test.ts`'s "no raw party id" assertion
 * fails on. `RosterTradeRecordedPayload` avoids the collision by naming its
 * four figure blocks per side; this avoids it the same way the Drop does.
 *
 * `reason` is `null` for a Manager acting on their own Team — FR-44 requires
 * a confirmation sheet and NO reason there, because it is an ordinary
 * strategic decision and not a referee intervention — and a non-blank trimmed
 * string for the Commissioner acting on any Team's behalf.
 */
export type RosterRearrangedPayload = {
	readonly teamId: string;
	readonly teamName: string;
	readonly moves: readonly RosterRearrangedMove[];
	readonly teamBefore: RosterActTeamFigures;
	readonly teamAfter: RosterActTeamFigures;
	/** The Commissioner's stated reason, or `null` for a Manager's own Move. */
	readonly reason: string | null;
};

/** Whether a value is one of the two Slot Placements an Auction Contract may hold. */
function isSlotPlacement(value: unknown): value is SlotPlacement {
	return value === 'active_bench' || value === 'minor_league';
}

/**
 * One money field off a payload, VALIDATED BY VALUE before it is branded —
 * or `null` when the column holds something that is not an amount.
 *
 * **`parseMoney` THROWS**, and a throw inside a reducer is the one failure an
 * insert-only log cannot recover from: it does not lose one event, it makes
 * every future fold of the whole log raise, which is this module's stated
 * discipline turned inside out ("a malformed historical row is SKIPPED rather
 * than thrown over"). A type test alone is not enough to prevent it —
 * `capHitAfter: "abc"` is a `string` and `capHitAfter: 1.5` is a `number`, and
 * both reach `parseMoney` and throw — so the VALUE is checked here, by the
 * same two rules `parseMoney` itself applies, and a failure is returned as
 * `null` for the caller to skip past.
 *
 * A number must be a safe integer; a string must be an optionally-signed run
 * of digits that survives the same safe-integer test. Nothing is coerced,
 * rounded or defaulted.
 */
function readMoney(value: unknown): Money | null {
	if (typeof value === 'number') {
		return Number.isSafeInteger(value) ? parseMoney(value) : null;
	}
	if (typeof value === 'string') {
		const text = value.trim();
		if (!/^[+-]?\d+$/.test(text)) return null;
		const parsed = Number(text);
		return Number.isSafeInteger(parsed) ? parseMoney(parsed) : null;
	}
	return null;
}

/**
 * The `RosterMoveRecorded` payload as this reducer needs it, read
 * defensively — `readAssignmentPayload`'s discipline, for its reason.
 *
 * Only the transfers matter to this fold, and only the `won` ones: an
 * Existing Contract has no contract row here and moved by an `UPDATE` in the
 * same transaction. Everything else on the payload is the audit record, which
 * no fold decides on.
 *
 * A transfer is REJECTED rather than repaired when any field it folds on is
 * absent or wrong — a missing id names no contract, a placement outside the
 * two legal ones is not a Slot, and a Cap Hit that is not a whole number of
 * dollars is not a charge. Individual bad transfers are skipped rather than
 * dropping the whole Trade: an insert-only log cannot be corrected in place,
 * and losing four good transfers over a fifth would be worse than losing the
 * fifth.
 *
 * **Nothing here can throw**, which is the property that matters most: a
 * `parseMoney` raised inside this loop would not lose one transfer, it would
 * make every future fold of the entire log raise. `readMoney` is what keeps
 * the validation on this side of the brand.
 */
function readTransfers(payload: unknown): readonly RosterTradeTransfer[] {
	if (typeof payload !== 'object' || payload === null) return [];
	const record = payload as Record<string, unknown>;
	const transfers = record['transfers'];
	if (!Array.isArray(transfers)) return [];

	const read: RosterTradeTransfer[] = [];
	for (const entry of transfers as readonly unknown[]) {
		if (typeof entry !== 'object' || entry === null) continue;
		const row = entry as Record<string, unknown>;
		if (row['won'] !== true) continue;
		const fantraxPlayerId = row['fantraxPlayerId'];
		const toTeamId = row['toTeamId'];
		const toTeamName = row['toTeamName'];
		const toPlacement = row['toPlacement'];
		if (typeof fantraxPlayerId !== 'string' || fantraxPlayerId === '') continue;
		if (typeof toTeamId !== 'string' || toTeamId === '') continue;
		if (typeof toTeamName !== 'string' || toTeamName === '') continue;
		if (!isSlotPlacement(toPlacement)) continue;

		// **All three money fields are REJECTED rather than repaired**, and that
		// is AD-23 rather than strictness for its own sake. `winningAmount` used
		// to fall back to `capHitAfter` and `capHitBefore` to `0`; both of those
		// read one money field out of the other, or invent one, in a fold whose
		// entire job is to keep the contract's value and its charge distinct —
		// a stashed win of $18,000,000 charging $0 is the case that makes them
		// different numbers, and a "repair" would silently make them the same.
		// There is no cosmetic half here to fall back to.
		const capHitBefore = readMoney(row['capHitBefore']);
		const capHitAfter = readMoney(row['capHitAfter']);
		const winningAmount = readMoney(row['winningAmount']);
		if (capHitBefore === null || capHitAfter === null || winningAmount === null) continue;

		read.push({
			fantraxPlayerId,
			playerName: typeof row['playerName'] === 'string' ? row['playerName'] : fantraxPlayerId,
			fromTeamId: typeof row['fromTeamId'] === 'string' ? row['fromTeamId'] : '',
			fromTeamName: typeof row['fromTeamName'] === 'string' ? row['fromTeamName'] : '',
			toTeamId,
			toTeamName,
			won: true,
			fromPlacement: isSlotPlacement(row['fromPlacement']) ? row['fromPlacement'] : toPlacement,
			toPlacement,
			capHitBefore,
			capHitAfter,
			winningAmount,
			clearedContractYears: isContractYears(row['clearedContractYears'])
				? row['clearedContractYears']
				: null
		});
	}
	return read;
}

/**
 * The `RosterRearranged` payload as this reducer needs it, read defensively
 * — `readTransfers`' discipline, for its reason.
 *
 * Only the moves matter to this fold, and only the `won` ones: an Existing
 * Contract has no contract row here and moved by an `UPDATE` in the same
 * transaction. Everything else on the payload is the audit record, which no
 * fold decides on.
 *
 * A move is REJECTED rather than repaired when any field it folds on is
 * absent or wrong. Individual bad moves are skipped rather than dropping the
 * whole act, and **nothing here can throw** — `readMoney` is what keeps the
 * validation on this side of the brand, exactly as it does for a transfer.
 *
 * **`fromPlacement` is rejected too, and that is the difference from
 * `readTransfers`.** That reader substitutes `toPlacement` for a missing
 * `fromPlacement`, which is survivable there because nothing folds on it. It
 * is NOT survivable here: `projection/minors-history.ts` reads exactly this
 * field to decide whether the app has ever observed a Contract in a Minor
 * League Slot, so a substitution would silently erase the observation that
 * makes a demoted stash promotable again — §10 example 46's Thompson turning
 * into its Vassell. A move whose origin is unreadable is skipped, and the
 * Contract stays where the rest of the log says it is.
 */
function readMoves(payload: unknown): readonly RosterRearrangedMove[] {
	if (typeof payload !== 'object' || payload === null) return [];
	const record = payload as Record<string, unknown>;
	const moves = record['moves'];
	if (!Array.isArray(moves)) return [];

	const read: RosterRearrangedMove[] = [];
	for (const entry of moves as readonly unknown[]) {
		if (typeof entry !== 'object' || entry === null) continue;
		const row = entry as Record<string, unknown>;
		if (row['won'] !== true) continue;
		const fantraxPlayerId = row['fantraxPlayerId'];
		const toPlacement = row['toPlacement'];
		const fromPlacement = row['fromPlacement'];
		if (typeof fantraxPlayerId !== 'string' || fantraxPlayerId === '') continue;
		if (!isSlotPlacement(toPlacement)) continue;
		// Rejected, never substituted — see the docblock: this field is what
		// `minors-history.ts` folds placement eligibility from.
		if (!isSlotPlacement(fromPlacement)) continue;

		// **All three money fields are REJECTED rather than repaired** (AD-23),
		// for `readTransfers`' reason: a stashed win of $18,000,000 charging $0
		// is exactly the case that makes the value and the charge different
		// numbers, and a "repair" reading one out of the other would silently
		// make them the same.
		const capHitBefore = readMoney(row['capHitBefore']);
		const capHitAfter = readMoney(row['capHitAfter']);
		const value = readMoney(row['value']);
		if (capHitBefore === null || capHitAfter === null || value === null) continue;

		read.push({
			fantraxPlayerId,
			playerName: typeof row['playerName'] === 'string' ? row['playerName'] : fantraxPlayerId,
			won: true,
			fromPlacement,
			toPlacement,
			capHitBefore,
			capHitAfter,
			value
		});
	}
	return read;
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
		// **The LATEST assignment for a Player wins** (Story 6.1). A Manager may
		// change a length until their Team is submitted as final, and a change
		// is an APPENDED event — nothing is updated and nothing is deleted — so
		// the last one this fold sees is the Team's current answer and the
		// earlier length is simply no longer counted against the Year Allotment.
		case CONTRACT_LENGTH_ASSIGNED_EVENT: {
			const assignment = readAssignmentPayload(event.payload);
			if (assignment === null) return state;
			const contract = contractForPlayer(state, assignment.fantraxPlayerId);
			// An assignment for a Player who holds no Auction Contract sets
			// nothing: there is no contract to carry the length, and inventing
			// one out of an assignment payload would manufacture a Player a Team
			// never won. The rules gate refuses this before it is ever appended.
			if (contract === null) return state;
			// A length may only be set on a contract the NAMED Team holds. The
			// gate has already established the actor owns it; this is the second
			// statement of the same rule, in the fold, where a historical row
			// that disagreed would otherwise move a length onto somebody else's
			// Player.
			if (contract.teamId !== assignment.teamId) return state;
			return {
				byPlayer: {
					...state.byPlayer,
					[assignment.fantraxPlayerId]: { ...contract, contractYears: assignment.contractYears }
				}
			};
		}
		// **The LATEST transfer for a Player wins** (Story 7.7, FR-41), which is
		// `ContractLengthAssigned`'s rule and not `AuctionClosed`'s. A Player
		// may change hands twice in one offseason and the second Trade is not a
		// duplicate of the first — it is where he is now.
		//
		// Four fields are rewritten and one is CLEARED. The Team and its name
		// are the transfer; `placement` and `capHit` are re-derived by the Trade
		// against the receiving Team's occupancy, because a stash landing where
		// there is no Minor League Slot starts charging its full amount (§10
		// example 38); and `contractYears` goes back to `null`, which returns
		// the year to the sending Team's Year Allotment by arithmetic rather
		// than by a compensating event (§10 example 42).
		//
		// **`winningAmount` is not touched.** A Trade is not a restructure: the
		// Contract travels unchanged in value, and no expression here reads one
		// money field out of the other (AD-23).
		case ROSTER_TRADE_RECORDED_EVENT: {
			let byPlayer = state.byPlayer;
			for (const transfer of readTransfers(event.payload)) {
				const contract = contractForPlayer({ byPlayer }, transfer.fantraxPlayerId);
				// A transfer naming a Player who holds no Auction Contract folds
				// nothing: an Existing Contract moved by the `UPDATE` this event
				// commits beside, and inventing a contract out of a transfer
				// payload would manufacture a Player nobody won.
				if (contract === null) continue;
				// Narrowed again at the point of use: `RosterTradeTransfer` carries
				// a `RosterSlotKind` because an Existing Contract may sit on IR,
				// while an `AuctionContract`'s `placement` is the two-member
				// `SlotPlacement` — and a close can only ever have produced one of
				// those two. `readTransfers` has already refused anything else; this
				// is what lets the type say so.
				if (!isSlotPlacement(transfer.toPlacement)) continue;
				byPlayer = {
					...byPlayer,
					[transfer.fantraxPlayerId]: {
						...contract,
						teamId: transfer.toTeamId,
						teamName: transfer.toTeamName,
						placement: transfer.toPlacement,
						capHit: transfer.capHitAfter,
						contractYears: null
					}
				};
			}
			return byPlayer === state.byPlayer ? state : { byPlayer };
		}
		// **The LATEST move for a Player wins** (Story 7.11, FR-44), which is
		// the Trade's rule and not `AuctionClosed`'s. A Contract may be demoted
		// and promoted back within the hour — §10 example 46's round trip — and
		// the second Move is not a duplicate of the first: it is where the
		// Contract is now.
		//
		// TWO fields are rewritten and no other is touched. `placement` is what
		// the Move commanded — never re-derived, because re-deriving it would
		// take a demotion the Manager just asked for and put the Contract
		// straight back in the Slot it left — and `capHit` is what that
		// placement charges. The Team does not change, because a Move has no
		// counterparty; `winningAmount` does not change, because a Move is not
		// a restructure; and `contractYears` does not change, because the
		// Contract did not change hands and §10 example 42's reasoning does not
		// apply (FR-44).
		case ROSTER_REARRANGED_EVENT: {
			let byPlayer = state.byPlayer;
			for (const move of readMoves(event.payload)) {
				const contract = contractForPlayer({ byPlayer }, move.fantraxPlayerId);
				// A move naming a Player who holds no Auction Contract folds
				// nothing: an Existing Contract moved by the `UPDATE` this event
				// commits beside, and inventing a contract out of a move payload
				// would manufacture a Player nobody won.
				if (contract === null) continue;
				// Narrowed again at the point of use, exactly as the Trade's case
				// narrows: `RosterRearrangedMove` carries a `RosterSlotKind`
				// because an Existing Contract may sit on IR, while an
				// `AuctionContract`'s `placement` is the two-member
				// `SlotPlacement`. `readMoves` has already refused anything else;
				// this is what lets the type say so.
				if (!isSlotPlacement(move.toPlacement)) continue;
				byPlayer = {
					...byPlayer,
					[move.fantraxPlayerId]: {
						...contract,
						placement: move.toPlacement,
						capHit: move.capHitAfter
					}
				};
			}
			return byPlayer === state.byPlayer ? state : { byPlayer };
		}
		default:
			return state;
	}
};
