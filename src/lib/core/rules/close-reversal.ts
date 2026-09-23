/**
 * Reversing an Auction Close: one compensating event naming the close it
 * reverses (Story 7.13, FR-32, AD-33, PRD §10 example 58).
 *
 * **A termination after the fact, and nothing else.** The winning Team's
 * Auction Contract is removed — its Cap Hit leaves Cap Space and, from
 * Active/Bench, Roster Count falls by one — and the Player returns to the pool,
 * nominatable by anyone. That is the whole act (AD-33):
 *
 *  - the FR-40 Bid Cancellations the close caused, and their restorations,
 *    STAND — nothing here writes a `BidCancelled` or reads one to undo it;
 *  - no League Clock reset is removed or recomputed;
 *  - the Auction is not reopened.
 *
 * **A Nomination Slot the close released is re-held only if the Team holds
 * none now** — a Nomination made with it stands. The decision is taken here,
 * once, and RECORDED on the payload with the nomination that held the Slot,
 * so every fold replays what the record says rather than re-deriving it
 * (AD-32).
 *
 * **Refusals are values, never throws** (AD-1): `phase`, `no_such_close`,
 * `already_reversed`, `traded` and `dropped`. A within-Team Move does NOT
 * block — the Contract is removed from whatever `placement` it holds now.
 *
 * **It does no affordability arithmetic of its own.** Before and after come
 * from `figuresFor` over the rows with and without the Contract; Available
 * Cap Space and Maximum Bid from `teamSolvencyFiguresFor`, called exactly as
 * `managerMaximumBidFor` calls it. The act only frees cap and capacity, so it
 * has no gate to fail on money or slots.
 *
 * Nothing in `auction_events` is updated or deleted (AD-4): the reversal is
 * an APPENDED event, and the close it names keeps its place in the log.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { ACTIVE_BENCH_SLOTS } from '../constants.ts';
import { parseMoney } from '../money.ts';
import type { Money } from '../money.ts';
import { BID_CANCELLED_EVENT } from '../projection/auctions.ts';
import type { OpenAuctions } from '../projection/auctions.ts';
import {
	AUCTION_CLOSE_REVERSED_EVENT,
	DROP_RECORDED_EVENT,
	ROSTER_TRADE_RECORDED_EVENT,
	contractForPlayer,
	reversalOfClose
} from '../projection/contracts.ts';
import type {
	AuctionCloseReversedPayload,
	AuctionContract,
	AuctionContracts,
	CloseReversalSolvency,
	ReheldNomination,
	RosterActTeamFigures,
	StandingCancellation
} from '../projection/contracts.ts';
import { fold } from '../projection/fold.ts';
import {
	AUCTION_CLOSED_EVENT,
	INITIAL_NOMINATIONS,
	NOMINATION_PLACED_EVENT,
	nominationForTeam,
	nominationsReducer,
	readClosedFacts,
	readClosedPlayerId
} from '../projection/nominations.ts';
import type { OpenNomination, OpenNominations } from '../projection/nominations.ts';
import type { LeaguePhase } from '../projection/phase.ts';
import type { AppendedEvent, SlotPlacement } from '../types.ts';
import { bidStateFor, teamSolvencyFiguresFor } from './bidding.ts';
import { NO_MONEY, describeActAmount, figuresFor, postActMoneyStateFor } from './roster-act.ts';
import type { ActingRow, ActingTeam } from './roster-act.ts';

// --- The facts one scan of the log yields -----------------------------------

/** The `AuctionClosed` a reversal names, as its payload recorded it. */
export type ReversibleClose = {
	readonly seq: string;
	readonly occurredAt: string;
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly teamId: string;
	readonly teamName: string;
	readonly winningAmount: Money;
	readonly capHit: Money;
	readonly placement: SlotPlacement;
	readonly closedAt: string;
	/** Whether the close released the winning Team's Nomination Slot (FR-9). */
	readonly releasedNominationSlot: boolean;
};

/** A later Roster Trade that moved the won Contract — a `traded` ground. */
export type LaterTrade = {
	readonly seq: string;
	readonly occurredAt: string;
	readonly toTeamId: string;
	readonly toTeamName: string;
};

/** A later Drop that named the won Player — a `dropped` ground. */
export type LaterDrop = {
	readonly seq: string;
	readonly occurredAt: string;
};

/**
 * Everything the log says about one close that a reversal turns on — one pure
 * scan, so the sheet and the transaction read one answer.
 *
 * The window for "later" acts and for the close's own cancellations is
 * `(closeSeq, the Player's NEXT close)`: a Player won again after a reversal
 * starts a new Contract, and what happened to THAT one is not a ground for
 * refusing, or a consequence of, this one.
 */
export type CloseReversalFacts = {
	readonly closeSeq: string;
	/** The close, or `null` when no well-formed `AuctionClosed` has that `seq`. */
	readonly close: ReversibleClose | null;
	/** The reversal that already names this close, or `null`. */
	readonly reversedBy: { readonly seq: string; readonly occurredAt: string } | null;
	/** Later Trades moving this Contract, oldest first. */
	readonly trades: readonly LaterTrade[];
	/** Later Drops naming this Player, oldest first. */
	readonly drops: readonly LaterDrop[];
	/** The FR-40 Bid Cancellations this close caused, in `seq` order. */
	readonly cancellations: readonly StandingCancellation[];
	/**
	 * The nomination that held the winning Team's Slot immediately before the
	 * close, with its own `seq`, or `null` — `nominationForTeam` over the fold
	 * of the log's prefix, the pattern `auctionAtClose` uses.
	 */
	readonly slotNomination: ReheldNomination | null;
};

/** A canonical non-negative `seq` — digits, no sign, no leading zero. */
const CANONICAL_CLOSE_SEQ = /^(?:0|[1-9][0-9]*)$/;

/** A `seq`, compared as the `int8` it is — never as text (`fold.ts`). */
function seqOf(event: { readonly seq: string }): bigint {
	return BigInt(event.seq);
}

/** A payload as a record, or an empty one. Never a throw. */
function fields(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** A non-empty string field, or `null`. */
function textOf(record: Readonly<Record<string, unknown>>, key: string): string | null {
	const value = record[key];
	return typeof value === 'string' && value !== '' ? value : null;
}

/** A list of records, or empty. */
function listOf(record: Readonly<Record<string, unknown>>, key: string): readonly Record<string, unknown>[] {
	const value = record[key];
	if (!Array.isArray(value)) return [];
	return value.map((entry) => fields(entry));
}

/** A whole-dollar amount off a payload, or `null` — `parseMoney` caught, never thrown. */
function moneyOf(value: unknown): Money | null {
	try {
		return parseMoney(value);
	} catch {
		return null;
	}
}

/** The close itself, read through the ONE definition of a well-formed close. */
function readClose(event: AppendedEvent): ReversibleClose | null {
	const facts = readClosedFacts(event.payload);
	if (facts === null) return null;
	const record = fields(event.payload);
	return {
		seq: event.seq,
		occurredAt: event.occurredAt,
		fantraxPlayerId: facts.fantraxPlayerId,
		playerName: textOf(record, 'playerName') ?? facts.fantraxPlayerId,
		teamId: facts.teamId,
		teamName: textOf(record, 'teamName') ?? facts.teamId,
		winningAmount: facts.winningAmount,
		capHit: facts.capHit,
		placement: facts.placement,
		closedAt: textOf(record, 'closedAt') ?? event.occurredAt,
		releasedNominationSlot: record['releasedNominationSlot'] === true
	};
}

/**
 * The `NominationPlaced` that produced `nomination`, located by the three
 * fields the fold copied across — Player, Team and instant — among the events
 * before the close. The LATEST match wins: a Player re-nominated after an
 * earlier termination has more than one such event, and the fold's answer is
 * the one standing when the close arrived.
 */
function nominationSeqFor(
	prefix: readonly AppendedEvent[],
	nomination: OpenNomination
): string | null {
	let found: AppendedEvent | null = null;
	for (const event of prefix) {
		if (event.type !== NOMINATION_PLACED_EVENT) continue;
		if (event.occurredAt !== nomination.occurredAt) continue;
		const record = fields(event.payload);
		if (textOf(record, 'fantraxPlayerId') !== nomination.fantraxPlayerId) continue;
		if (textOf(record, 'teamId') !== nomination.teamId) continue;
		if (found === null || seqOf(event) > seqOf(found)) found = event;
	}
	return found?.seq ?? null;
}

/**
 * Scan the log for everything a reversal of the close at `closeSeq` turns on.
 *
 * Pure and total: a `closeSeq` naming nothing, a malformed payload or an
 * unsorted log all produce facts rather than a throw.
 */
export function closeReversalFactsFor(
	events: readonly AppendedEvent[],
	closeSeq: string
): CloseReversalFacts {
	const empty: CloseReversalFacts = {
		closeSeq,
		close: null,
		reversedBy: null,
		trades: [],
		drops: [],
		cancellations: [],
		slotNomination: null
	};
	if (!CANONICAL_CLOSE_SEQ.test(closeSeq)) return empty;
	const cut = BigInt(closeSeq);

	// Sorted on a copy, exactly as `fold` sorts (AD-5).
	const ordered = [...events].sort((a, b) => {
		const left = seqOf(a);
		const right = seqOf(b);
		return left < right ? -1 : left > right ? 1 : 0;
	});

	const closeEvent = ordered.find(
		(event) => event.type === AUCTION_CLOSED_EVENT && event.seq === closeSeq
	);
	const close = closeEvent === undefined ? null : readClose(closeEvent);
	if (close === null) return empty;
	const playerId = close.fantraxPlayerId;

	// The Player's NEXT close bounds "later": a re-won Contract is another
	// Contract, and its history is not this one's.
	const next = ordered.find(
		(event) =>
			event.type === AUCTION_CLOSED_EVENT &&
			seqOf(event) > cut &&
			readClosedPlayerId(event.payload) === playerId
	);
	const bound = next === undefined ? null : seqOf(next);
	const inWindow = (event: AppendedEvent): boolean =>
		seqOf(event) > cut && (bound === null || seqOf(event) < bound);

	let reversedBy: CloseReversalFacts['reversedBy'] = null;
	const trades: LaterTrade[] = [];
	const drops: LaterDrop[] = [];
	const cancellations: StandingCancellation[] = [];

	for (const event of ordered) {
		if (seqOf(event) <= cut) continue;
		const record = fields(event.payload);

		// A reversal naming this close, wherever it falls after it.
		if (event.type === AUCTION_CLOSE_REVERSED_EVENT) {
			if (reversedBy === null && textOf(record, 'closeSeq') === closeSeq) {
				reversedBy = { seq: event.seq, occurredAt: event.occurredAt };
			}
			continue;
		}
		if (!inWindow(event)) continue;

		if (event.type === ROSTER_TRADE_RECORDED_EVENT) {
			for (const transfer of listOf(record, 'transfers')) {
				if (transfer['won'] !== true) continue;
				if (textOf(transfer, 'fantraxPlayerId') !== playerId) continue;
				const toTeamId = textOf(transfer, 'toTeamId') ?? '';
				trades.push({
					seq: event.seq,
					occurredAt: event.occurredAt,
					toTeamId,
					toTeamName: textOf(transfer, 'toTeamName') ?? toTeamId
				});
			}
			continue;
		}
		if (event.type === DROP_RECORDED_EVENT) {
			if (listOf(record, 'released').some((entry) => textOf(entry, 'fantraxPlayerId') === playerId)) {
				drops.push({ seq: event.seq, occurredAt: event.occurredAt });
			}
			continue;
		}
		if (event.type === BID_CANCELLED_EVENT) {
			if (textOf(record, 'causeFantraxPlayerId') !== playerId) continue;
			const cancelledPlayerId = textOf(record, 'fantraxPlayerId') ?? '';
			const teamId = textOf(record, 'teamId') ?? '';
			const restoration = fields(record['restoration']);
			const restoredTeamId = textOf(restoration, 'teamId');
			cancellations.push({
				cancelledSeq: textOf(record, 'cancelledSeq') ?? event.seq,
				fantraxPlayerId: cancelledPlayerId,
				playerName: textOf(record, 'playerName') ?? cancelledPlayerId,
				teamId,
				teamName: textOf(record, 'teamName') ?? teamId,
				amount: moneyOf(record['amount']) ?? NO_MONEY,
				restoredTeamId,
				restoredTeamName: textOf(restoration, 'teamName') ?? restoredTeamId
			});
		}
	}

	// The Slot-holding nomination as it stood the instant before the close —
	// the prefix fold `auctionAtClose` uses, then its own `seq` located.
	const prefix = ordered.filter((event) => seqOf(event) < cut);
	const held = nominationForTeam(fold(INITIAL_NOMINATIONS, prefix, nominationsReducer), close.teamId);
	const heldSeq = held === null ? null : nominationSeqFor(prefix, held);
	const slotNomination: ReheldNomination | null =
		held === null || heldSeq === null
			? null
			: {
					seq: heldSeq,
					fantraxPlayerId: held.fantraxPlayerId,
					playerName: held.playerName,
					teamId: held.teamId,
					teamName: held.teamName,
					managerId: held.managerId,
					occurredAt: held.occurredAt
				};

	return { closeSeq, close, reversedBy, trades, drops, cancellations, slotNomination };
}

// --- The decision ------------------------------------------------------------

/**
 * Everything a reversal is judged against — one snapshot, so the sheet and
 * the transaction cannot disagree about the rule, only about when they read.
 *
 * `team` is the WINNING Team as it stands now, every row it carries including
 * the won Contract, with `value` the full amount (`ActingRow`'s rule).
 */
export type CloseReversalState = {
	readonly phase: LeaguePhase;
	readonly facts: CloseReversalFacts;
	readonly contracts: AuctionContracts;
	readonly nominations: OpenNominations;
	readonly team: ActingTeam & { readonly rows: readonly ActingRow[] };
	readonly auctions: OpenAuctions;
	readonly playerNameFor: (fantraxPlayerId: string) => string;
};

/** Why a reversal was refused. A returned value, never a throw (AD-1). */
export type CloseReversalRefusal =
	| { readonly kind: 'phase'; readonly phase: LeaguePhase }
	| { readonly kind: 'no_such_close'; readonly closeSeq: string }
	| {
			readonly kind: 'already_reversed';
			readonly playerName: string;
			readonly reversalSeq: string;
			readonly reversedAt: string;
	  }
	| {
			readonly kind: 'traded';
			readonly playerName: string;
			readonly tradedAt: string;
			readonly holderTeamId: string;
			readonly holderTeamName: string;
	  }
	| { readonly kind: 'dropped'; readonly playerName: string; readonly droppedAt: string };

/** One Team's Nomination Slot either side of the act — the holding nomination, or none. */
export type SlotPair = {
	readonly before: OpenNomination | ReheldNomination | null;
	readonly after: OpenNomination | ReheldNomination | null;
};

/**
 * What a permitted reversal will do — everything the sheet states and the
 * payload records, decided once.
 */
export type CloseReversalDecision = {
	readonly phase: LeaguePhase;
	/** The Contract as it stands now — the one removed. */
	readonly contract: AuctionContract;
	readonly teamBefore: RosterActTeamFigures;
	readonly teamAfter: RosterActTeamFigures;
	readonly solvencyBefore: CloseReversalSolvency;
	readonly solvencyAfter: CloseReversalSolvency;
	/** Whether the close released the Team's Slot at all. */
	readonly releasedNominationSlot: boolean;
	readonly slotReheld: boolean;
	readonly reheldNomination: ReheldNomination | null;
	readonly slot: SlotPair;
	readonly standingCancellations: readonly StandingCancellation[];
};

/** What `decideCloseReversal` answered. */
export type CloseReversalOutcome =
	| {
			readonly kind: 'accepted';
			readonly decision: CloseReversalDecision;
			readonly payload: AuctionCloseReversedPayload;
	  }
	| { readonly kind: 'rejected'; readonly refusal: CloseReversalRefusal };

/**
 * Available Cap Space and Maximum Bid over one set of figures — a second
 * CALL, never a second expression (AR-42). `teamSolvencyFiguresFor` is asked
 * exactly as `managerMaximumBidFor` asks it: no Auction, no prospective Bid
 * exemption, the Auction phase's arithmetic.
 */
function solvencyFor(state: CloseReversalState, figures: RosterActTeamFigures): CloseReversalSolvency {
	const money = postActMoneyStateFor(state.team, figures, state);
	const solvency = teamSolvencyFiguresFor(bidStateFor(null, money, 'Auction'), '', NO_MONEY, false);
	// Unreachable: `postActMoneyStateFor` always carries a Team. The guard is
	// the narrowing, exactly as `managerMaximumBidFor`'s own is.
	if (solvency === null) {
		throw new Error('decideCloseReversal: the solvency figures came back with no Team');
	}
	return { availableCapSpace: solvency.availableCapSpace, maximumBid: solvency.maximumBid };
}

/**
 * Decide one reversal: refuse it as a value, or state exactly what it does.
 *
 * The order is the rule: the phase first (an Archived league is refused
 * whatever else is true), then whether the close exists, whether it is
 * already reversed, and whether the Contract has since left the Team — traded
 * or dropped. A Contract Moved within its Team is not a ground: it is removed
 * from wherever it sits now.
 */
export function decideCloseReversal(
	state: CloseReversalState,
	reason: string
): CloseReversalOutcome {
	if (state.phase !== 'Auction' && state.phase !== 'Contract Assignment') {
		return { kind: 'rejected', refusal: { kind: 'phase', phase: state.phase } };
	}
	const { facts } = state;
	const close = facts.close;
	if (close === null) {
		return { kind: 'rejected', refusal: { kind: 'no_such_close', closeSeq: facts.closeSeq } };
	}

	const reversal = reversalOfClose(state.contracts, close.seq);
	if (facts.reversedBy !== null || reversal !== null) {
		return {
			kind: 'rejected',
			refusal: {
				kind: 'already_reversed',
				playerName: close.playerName,
				reversalSeq: facts.reversedBy?.seq ?? reversal?.reversalSeq ?? '',
				reversedAt: facts.reversedBy?.occurredAt ?? reversal?.reversedAt ?? ''
			}
		};
	}

	const lastTrade = facts.trades[facts.trades.length - 1];
	if (lastTrade !== undefined) {
		const holder = contractForPlayer(state.contracts, close.fantraxPlayerId);
		return {
			kind: 'rejected',
			refusal: {
				kind: 'traded',
				playerName: close.playerName,
				tradedAt: lastTrade.occurredAt,
				holderTeamId: holder?.teamId ?? lastTrade.toTeamId,
				holderTeamName: holder?.teamName ?? lastTrade.toTeamName
			}
		};
	}

	const lastDrop = facts.drops[facts.drops.length - 1];
	if (lastDrop !== undefined) {
		return {
			kind: 'rejected',
			refusal: { kind: 'dropped', playerName: close.playerName, droppedAt: lastDrop.occurredAt }
		};
	}

	// The live Contract this close produced. Anything else — no Contract, or a
	// Contract from a different close — is a close there is nothing to reverse.
	const contract = contractForPlayer(state.contracts, close.fantraxPlayerId);
	if (contract === null || contract.closeSeq !== close.seq || contract.teamId !== close.teamId) {
		return { kind: 'rejected', refusal: { kind: 'no_such_close', closeSeq: facts.closeSeq } };
	}

	// Before and after, from the rows with and without the Contract — the ONE
	// figures expression every roster act uses.
	const teamBefore = figuresFor(state.team, state.team.rows);
	const teamAfter = figuresFor(
		state.team,
		state.team.rows.filter((row) => row.fantraxPlayerId !== close.fantraxPlayerId)
	);
	const solvencyBefore = solvencyFor(state, teamBefore);
	const solvencyAfter = solvencyFor(state, teamAfter);

	// **The Slot, re-held only from the record and only into an empty hand**
	// (AD-32, AD-33): the close must have released it AND the Team must hold
	// none now. A Nomination made with the released Slot stands.
	const heldNow = nominationForTeam(state.nominations, close.teamId);
	const slotReheld =
		close.releasedNominationSlot && heldNow === null && facts.slotNomination !== null;
	const reheldNomination = slotReheld ? facts.slotNomination : null;

	const decision: CloseReversalDecision = {
		phase: state.phase,
		contract,
		teamBefore,
		teamAfter,
		solvencyBefore,
		solvencyAfter,
		releasedNominationSlot: close.releasedNominationSlot,
		slotReheld,
		reheldNomination,
		slot: { before: heldNow, after: heldNow ?? reheldNomination },
		standingCancellations: facts.cancellations
	};

	const payload: AuctionCloseReversedPayload = {
		closeSeq: close.seq,
		fantraxPlayerId: contract.fantraxPlayerId,
		playerName: contract.playerName,
		teamId: contract.teamId,
		teamName: contract.teamName,
		winningAmount: contract.winningAmount,
		capHit: contract.capHit,
		placement: contract.placement,
		closedAt: contract.closedAt,
		slotReheld,
		reheldNomination,
		standingCancellations: facts.cancellations,
		// `teamBefore`/`teamAfter` and `solvency*`, never `before`/`after` —
		// the Audit Log's `mergeOverride` reads that pair as an override map.
		teamBefore,
		teamAfter,
		solvencyBefore,
		solvencyAfter,
		reason
	};

	return { kind: 'accepted', decision, payload };
}

// --- The wording -------------------------------------------------------------

/**
 * The one sentence a refused reversal is reported by — `dropRefusalDetail`'s
 * shape. Each names the act, the date and, for a Trade, the current holder.
 */
export function closeReversalRefusalDetail(refusal: CloseReversalRefusal): string {
	switch (refusal.kind) {
		case 'phase':
			return (
				`A Close can be reversed only in the Auction or Contract Assignment Phase, and the League ` +
				`is in ${refusal.phase}. Nothing was written.`
			);
		case 'no_such_close':
			// A position is named only when there is one to name: an empty or
			// non-numeric `?close=` is "no Close was named", not a blank in a
			// sentence about a position.
			return CANONICAL_CLOSE_SEQ.test(refusal.closeSeq)
				? `No Auction Close in the log has the position ${refusal.closeSeq}, or its Contract is not ` +
						`one the log still holds, so there is nothing to reverse.`
				: 'No Auction Close was named, so there is nothing to reverse.';
		case 'already_reversed':
			return (
				`The Close that gave ${refusal.playerName} a Contract was already reversed ` +
				`(${refusal.reversedAt}). A Close is reversed once; nothing was written.`
			);
		case 'traded':
			return (
				`${refusal.playerName}'s Contract was traded after the Close (${refusal.tradedAt}) and is now ` +
				`held by ${refusal.holderTeamName}. A traded Contract cannot be reversed; nothing was written.`
			);
		case 'dropped':
			return (
				`${refusal.playerName} was dropped after the Close (${refusal.droppedAt}). A dropped Contract ` +
				`cannot be reversed; nothing was written.`
			);
	}
}

/**
 * The consequence notes the reason sheet carries, in words — each one a
 * sentence the two states on the sheet do not show (UX: "where a figure moves
 * counterintuitively, say so").
 *
 * `irMove` is non-null only where the Team holds an Injury Reserve Contract
 * after the reversal: the Roster Move is the separate NEXT step, taken after
 * this one (§10 example 58 — done first, it is refused at thirteen).
 * `contractAssignment` is non-null only in that phase.
 */
export type CloseReversalNotes = {
	readonly pool: string;
	readonly nothingElse: string;
	readonly irMove: string | null;
	readonly contractAssignment: string | null;
	readonly slot: string;
};

export function closeReversalAttention(decision: CloseReversalDecision): CloseReversalNotes {
	const { contract } = decision;
	const player = contract.playerName;
	const team = contract.teamName;

	const pool =
		`${player} returns to the pool: the Contract leaves ${team}, its ` +
		`${describeActAmount(contract.capHit)} Cap Hit leaves Cap Space, and any Team may nominate ${player}.`;

	const cancelled = decision.standingCancellations.length;
	const nothingElse =
		(cancelled === 0
			? 'This Close cancelled no Bids. '
			: `The ${String(cancelled)} Bid ${cancelled === 1 ? 'Cancellation' : 'Cancellations'} this Close ` +
				`caused, and their restorations, stand. `) +
		'Nothing else is undone: no League Clock reset is removed or recomputed, and the Auction is not reopened.';

	// **The room claim only when the reversal made room.** A reversed
	// Contract that itself sat on Injury Reserve (or in the minors) leaves
	// Roster Count where it was, so saying the Team now has room for the IR
	// Move would be false — the sheet still says the Move is a separate step.
	const roomMade = decision.teamAfter.rosterCount < decision.teamBefore.rosterCount;
	const irMove =
		decision.teamAfter.injuryReserveOccupied === 0
			? null
			: roomMade
				? `${team} holds an Injury Reserve Contract. Moving it to Active/Bench is a separate Roster ` +
					`Move, taken after this reversal — at ${String(decision.teamAfter.rosterCount)} it has room ` +
					`the Move needs, which it did not have before.`
				: `${team} holds an Injury Reserve Contract. Moving it to Active/Bench is a separate Roster ` +
					`Move, taken after this reversal. This reversal leaves Roster Count at ` +
					`${String(decision.teamAfter.rosterCount)}, so it makes no Active/Bench room for that Move.`;

	// **Below twelve only when it is.** The Player cannot be nominated again in
	// this phase whatever happens to the Count; the export warning is owed
	// only when the reversal actually leaves the Team short of a full roster.
	const contractAssignment =
		decision.phase !== 'Contract Assignment'
			? null
			: `The League is in Contract Assignment, so the Auction Phase has ended and ${player} cannot be ` +
				`nominated again.` +
				(decision.teamAfter.rosterCount < ACTIVE_BENCH_SLOTS
					? ` ${team} falls to Roster Count ${String(decision.teamAfter.rosterCount)}, below ` +
						`twelve, and cannot export until it is back at twelve.`
					: '');

	const slot = !decision.releasedNominationSlot
		? `The Close released no Nomination Slot for ${team}, so none is re-held.`
		: decision.slotReheld && decision.reheldNomination !== null
			? `The Close released ${team}'s Nomination Slot, and ${team} holds none now, so it is re-held on ` +
				`${decision.reheldNomination.playerName}, the nomination that held it.`
			: decision.slot.before === null
				? `The Close released ${team}'s Nomination Slot and ${team} holds none now, but the ` +
					`nomination that held it cannot be found in the log, so the Slot cannot be re-held.`
				: `The Close released ${team}'s Nomination Slot, but ${team} has nominated since ` +
					`(${decision.slot.before.playerName}) — that Nomination stands, so no Slot is re-held.`;

	return { pool, nothingElse, irMove, contractAssignment, slot };
}

/**
 * The act, as one finished sentence — never assembled from a template the
 * sheet holds. The sheet's shared title stays; this is its per-act line.
 */
export function closeReversalActSentence(decision: CloseReversalDecision): string {
	const { contract } = decision;
	return (
		`Reverse this Close — ${contract.playerName}, won by ${contract.teamName} for ` +
		`${describeActAmount(contract.winningAmount)}. The Contract leaves ${contract.teamName} and ` +
		`${contract.playerName} returns to the pool.`
	);
}
