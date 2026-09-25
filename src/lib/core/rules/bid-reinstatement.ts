/**
 * Reinstating a cancelled Bid: one compensating event naming the
 * `BidCancelled` it reverses (Story 7.14, FR-32, FR-40; spine addendum AD-31).
 *
 * **A Commissioner override, and the reverse of exactly one cancellation.** An
 * FR-40 cancellation can withdraw a Bid that should have stood — the case that
 * prompted this is a lead cancelled because a Contract had not yet been moved
 * to Injury Reserve. Nothing undoes a cancellation, and the log is insert-only
 * (AD-4), so the remedy is one appended `BidCancellationReversed` naming the
 * cancellation's own `seq`. The fold (`withBidReinstated`) is the whole of
 * its effect:
 *
 *  - the cancelled Bid LEADS again, with its ORIGINAL Auction Clock;
 *  - every Bid placed on that Auction AFTER the cancellation is ERASED — a
 *    void's treatment: out of `bids`, its capital released, and its League
 *    Clock reset withdrawn (AD-22);
 *  - nothing is closed. Where the original clock has already passed, the next
 *    tick's ordinary sweep closes the Auction to the reinstated Team, so
 *    `rules/close.ts` stays the sole appender of `AuctionClosed` and of every
 *    `BidCancelled`, and the FR-40 cascade runs on THAT close.
 *
 * **The reinstated Team re-passes `RestoreLeadingBid` as of now, or the act is
 * refused** — never adapted, and never answered by cancelling something else
 * (AD-32's "refuse rather than cascade"). The gate re-test is
 * `rules/restore.ts`'s `restoreGateResultsFor`, the very evaluation the FR-40
 * restorer runs; there is no second selector and no arithmetic here.
 *
 * **Refusals are values, never throws** (AD-1): `phase`,
 * `no_such_cancellation`, `already_reinstated`, `contention_entry`,
 * `auction_ended`, `outbid` and `gates`. A cancelled Minimum-Bid Contention
 * entry is refused outright: reinstating a lottery ticket is out of scope.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2). `now` is
 * handed in (AD-3) and read by `hasExpired` alone.
 */

import { compareMoney, parseMoney } from '../money.ts';
import type { Money } from '../money.ts';
import {
	BID_CANCELLATION_REVERSED_EVENT,
	BID_CANCELLED_EVENT,
	CAUSE_UNNAMED,
	CONTENTION_DISSOLVED_EVENT,
	auctionForPlayer,
	contentionForAmount,
	hasExpired,
	wasCancelled,
	withBidReinstated
} from '../projection/auctions.ts';
import type { Bid, ContentionState, OpenAuctions } from '../projection/auctions.ts';
import { CONTENTION_DRAWN_EVENT } from '../projection/draws.ts';
import { leagueClockExpiry } from '../projection/league-clock.ts';
import type { LeagueClock } from '../projection/league-clock.ts';
import {
	AUCTION_CLOSED_EVENT,
	AUCTION_TERMINATED_EVENT,
	readClosedPlayerId,
	readTerminatedPlayerId
} from '../projection/nominations.ts';
import type { LeaguePhase } from '../projection/phase.ts';
import { RESTORE_LEADING_BID_GATES } from '../types.ts';
import type {
	AppendedEvent,
	RestoreLeadingBidGate,
	RestoreLeadingBidGateResults
} from '../types.ts';
import { restoreGateResultsFor } from './restore.ts';
import type { CandidateRosterFigures } from './restore.ts';
import { describeActAmount } from './roster-act.ts';

// --- The facts one scan of the log yields -----------------------------------

/** The `BidCancelled` a reinstatement names, as its payload recorded it. */
export type ReinstatableCancellation = {
	/** The `BidCancelled` event's own log position — what the reinstatement names. */
	readonly seq: string;
	readonly occurredAt: string;
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** The cancelled `BidPlaced`'s own `seq`. */
	readonly cancelledSeq: string;
	readonly teamId: string;
	readonly teamName: string;
	readonly managerId: string;
	readonly amount: Money;
	/** Whether it was a Minimum-Bid Contention entry — a refusal ground. */
	readonly wasContentionEntry: boolean;
	/** The Player whose Close caused the cancellation — a different Auction. */
	readonly causePlayerName: string;
};

/** How an Auction ended after the cancellation — the `auction_ended` ground. */
export type AuctionEnding = {
	readonly seq: string;
	readonly occurredAt: string;
	readonly how: 'closed' | 'terminated' | 'drawn' | 'dissolved';
};

/**
 * Everything the log says about one cancellation that a reinstatement turns
 * on — one pure scan, so the sheet and the transaction read one answer.
 */
export type BidReinstatementFacts = {
	readonly cancellationSeq: string;
	/** The cancellation, or `null` when no well-formed `BidCancelled` has that `seq`. */
	readonly cancellation: ReinstatableCancellation | null;
	/** The reinstatement that already names this cancellation, or `null`. */
	readonly reinstatedBy: { readonly seq: string; readonly occurredAt: string } | null;
	/** The first close, termination, draw or dissolution of this Auction after it. */
	readonly endedBy: AuctionEnding | null;
};

/** A canonical non-negative `seq` — digits, no sign, no leading zero. */
const CANONICAL_SEQ = /^(?:0|[1-9][0-9]*)$/;

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

/** A whole-dollar amount off a payload, or `null` — `parseMoney` caught, never thrown. */
function moneyOf(value: unknown): Money | null {
	try {
		return parseMoney(value);
	} catch {
		return null;
	}
}

/** The `BidCancelled` itself, or `null` for a payload naming no Bid. */
function readCancellation(event: AppendedEvent): ReinstatableCancellation | null {
	const record = fields(event.payload);
	const fantraxPlayerId = textOf(record, 'fantraxPlayerId');
	const cancelledSeq = textOf(record, 'cancelledSeq');
	const teamId = textOf(record, 'teamId');
	const amount = moneyOf(record['amount']);
	if (fantraxPlayerId === null || cancelledSeq === null || teamId === null || amount === null) {
		return null;
	}
	return {
		seq: event.seq,
		occurredAt: event.occurredAt,
		fantraxPlayerId,
		playerName: textOf(record, 'playerName') ?? fantraxPlayerId,
		cancelledSeq,
		teamId,
		teamName: textOf(record, 'teamName') ?? teamId,
		managerId: textOf(record, 'managerId') ?? '',
		amount,
		wasContentionEntry: record['wasContentionEntry'] === true,
		causePlayerName:
			textOf(record, 'causePlayerName') ?? textOf(record, 'causeFantraxPlayerId') ?? CAUSE_UNNAMED
	};
}

/** Which ending, if any, this event is for the named Player. */
function endingOf(event: AppendedEvent, fantraxPlayerId: string): AuctionEnding['how'] | null {
	switch (event.type) {
		case AUCTION_CLOSED_EVENT:
			return readClosedPlayerId(event.payload) === fantraxPlayerId ? 'closed' : null;
		case AUCTION_TERMINATED_EVENT:
			return readTerminatedPlayerId(event.payload) === fantraxPlayerId ? 'terminated' : null;
		case CONTENTION_DRAWN_EVENT:
			return textOf(fields(event.payload), 'fantraxPlayerId') === fantraxPlayerId ? 'drawn' : null;
		case CONTENTION_DISSOLVED_EVENT:
			return textOf(fields(event.payload), 'fantraxPlayerId') === fantraxPlayerId
				? 'dissolved'
				: null;
		default:
			return null;
	}
}

/**
 * Scan the log for everything a reinstatement of the cancellation at
 * `cancellationSeq` turns on.
 *
 * Pure and total: a `seq` naming nothing, a malformed payload or an unsorted
 * log all produce facts rather than a throw.
 */
export function bidReinstatementFactsFor(
	events: readonly AppendedEvent[],
	cancellationSeq: string
): BidReinstatementFacts {
	const empty: BidReinstatementFacts = {
		cancellationSeq,
		cancellation: null,
		reinstatedBy: null,
		endedBy: null
	};
	if (!CANONICAL_SEQ.test(cancellationSeq)) return empty;
	const cut = BigInt(cancellationSeq);

	// Sorted on a copy, exactly as `fold` sorts (AD-5).
	const ordered = [...events].sort((a, b) => {
		const left = BigInt(a.seq);
		const right = BigInt(b.seq);
		return left < right ? -1 : left > right ? 1 : 0;
	});

	const cancelledEvent = ordered.find(
		(event) => event.type === BID_CANCELLED_EVENT && event.seq === cancellationSeq
	);
	const cancellation = cancelledEvent === undefined ? null : readCancellation(cancelledEvent);
	if (cancellation === null) return empty;

	let reinstatedBy: BidReinstatementFacts['reinstatedBy'] = null;
	let endedBy: AuctionEnding | null = null;
	for (const event of ordered) {
		if (BigInt(event.seq) <= cut) continue;
		if (event.type === BID_CANCELLATION_REVERSED_EVENT) {
			if (
				reinstatedBy === null &&
				textOf(fields(event.payload), 'cancellationSeq') === cancellationSeq
			) {
				reinstatedBy = { seq: event.seq, occurredAt: event.occurredAt };
			}
			continue;
		}
		if (endedBy !== null) continue;
		const how = endingOf(event, cancellation.fantraxPlayerId);
		if (how !== null) endedBy = { seq: event.seq, occurredAt: event.occurredAt, how };
	}

	return { cancellationSeq, cancellation, reinstatedBy, endedBy };
}

// --- The decision ------------------------------------------------------------

/**
 * Everything a reinstatement is judged against — one snapshot, so the sheet
 * and the transaction cannot disagree about the rule, only about when they
 * read.
 *
 * `rosterFigures` are the REINSTATED Team's three roster figures as they stand
 * now, or `null` when the cancellation names no Team the shell could read.
 */
export type BidReinstatementState = {
	readonly phase: LeaguePhase;
	readonly facts: BidReinstatementFacts;
	readonly auctions: OpenAuctions;
	readonly leagueClock: LeagueClock;
	readonly rosterFigures: CandidateRosterFigures | null;
	readonly playerNameFor: (fantraxPlayerId: string) => string;
};

/** Why a reinstatement was refused. A returned value, never a throw (AD-1). */
export type BidReinstatementRefusal =
	| { readonly kind: 'phase'; readonly phase: LeaguePhase }
	| { readonly kind: 'no_such_cancellation'; readonly cancellationSeq: string }
	| {
			readonly kind: 'already_reinstated';
			readonly playerName: string;
			readonly teamName: string;
			readonly reinstatedAt: string;
	  }
	| { readonly kind: 'contention_entry'; readonly playerName: string; readonly teamName: string }
	| {
			readonly kind: 'auction_ended';
			readonly playerName: string;
			readonly how: AuctionEnding['how'];
			readonly endedAt: string;
	  }
	| {
			readonly kind: 'outbid';
			/**
			 * Which Bid stands above the reinstated one: a `later` raise on a
			 * clock still running, or an `earlier` Bid that still stands — a
			 * history this product cannot write, refused whatever the clock.
			 */
			readonly by: 'later' | 'earlier';
			readonly playerName: string;
			readonly teamName: string;
			readonly amount: Money;
			readonly byTeamName: string;
			readonly byAmount: Money;
	  }
	| {
			/**
			 * The reinstated Team's roster figures could not be read, so neither
			 * gate could be asked. Its own kind rather than a `gates` refusal
			 * claiming both gates failed, which nothing established.
			 */
			readonly kind: 'figures_unreadable';
			readonly playerName: string;
			readonly teamName: string;
	  }
	| {
			readonly kind: 'gates';
			readonly playerName: string;
			readonly teamName: string;
			/** The failing gates, in `RESTORE_LEADING_BID_GATES` order. Never empty. */
			readonly failing: readonly RestoreLeadingBidGate[];
	  };

/** One erased Bid, as the payload records it. */
export type ErasedBid = {
	readonly seq: string;
	readonly teamId: string;
	readonly teamName: string;
	readonly managerId: string;
	readonly amount: number;
	/**
	 * Whether an unrelated `BidCancelled` had already withdrawn this Bid's
	 * standing before the reinstatement. It is erased all the same — out of
	 * the fold, its League Clock reset withdrawn — but it committed no capital
	 * to release, and its Team is neither told nor mentioned that it lost one.
	 */
	readonly wasCancelled: boolean;
};

/**
 * The payload a `BidCancellationReversed` carries — the whole act, in the log.
 *
 * `cancellationSeq` and `fantraxPlayerId` are the two fields the fold acts on;
 * `erasedBids` is what `league-clock.ts` withdraws resets by. Everything else
 * is the record the Audit Log, the broadcast and the mentions read without
 * re-folding. The League Clock pair is `leagueClockExpiryBefore`/`After`,
 * never `before`/`after` — the Audit Log's `mergeOverride` reads that pair as
 * an override map.
 */
export type BidCancellationReversedPayload = {
	readonly cancellationSeq: string;
	/** The reinstated `BidPlaced`'s own `seq`. */
	readonly reinstatedSeq: string;
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly teamId: string;
	readonly teamName: string;
	readonly managerId: string;
	readonly amount: number;
	/** The reinstated Bid's ORIGINAL Auction Clock, which the Auction takes back. */
	readonly closesAt: string;
	/** Whether that clock had already passed when the reinstatement was decided. */
	readonly clockExpired: boolean;
	readonly causePlayerName: string;
	readonly erasedBids: readonly ErasedBid[];
	/** Who led the Auction immediately before, or `null` for nobody. */
	readonly leaderBefore: {
		readonly seq: string;
		readonly teamId: string;
		readonly teamName: string;
		readonly amount: number;
	} | null;
	readonly leagueClockExpiryBefore: string | null;
	readonly leagueClockExpiryAfter: string | null;
	readonly reason: string;
};

/**
 * What a permitted reinstatement will do — everything the sheet states and
 * the payload records, decided once.
 */
export type BidReinstatementDecision = {
	readonly phase: LeaguePhase;
	readonly cancellation: ReinstatableCancellation;
	/** The Bid as it will lead: marker removed, original clock. */
	readonly reinstated: Bid;
	readonly leaderBefore: Bid | null;
	readonly closesAtBefore: string | null;
	readonly contentionBefore: ContentionState;
	/** The Bids placed after the cancellation, erased, in `seq` order. */
	readonly erased: readonly Bid[];
	readonly clockExpired: boolean;
	readonly leagueClockExpiryBefore: string | null;
	readonly leagueClockExpiryAfter: string | null;
	/** The reinstated Team's `RestoreLeadingBid` gates as of now — all passed. */
	readonly gates: RestoreLeadingBidGateResults;
};

/** What `decideBidReinstatement` answered. */
export type BidReinstatementOutcome =
	| {
			readonly kind: 'accepted';
			readonly decision: BidReinstatementDecision;
			readonly payload: BidCancellationReversedPayload;
	  }
	| { readonly kind: 'rejected'; readonly refusal: BidReinstatementRefusal };

function rejected(refusal: BidReinstatementRefusal): BidReinstatementOutcome {
	return { kind: 'rejected', refusal };
}

/** Strictly greater, or `null` — the highest of `bids` above `amount`. */
function highestAbove(bids: readonly Bid[], amount: Money): Bid | null {
	let highest: Bid | null = null;
	for (const bid of bids) {
		if (compareMoney(bid.amount, amount) <= 0) continue;
		if (highest === null || compareMoney(bid.amount, highest.amount) > 0) highest = bid;
	}
	return highest;
}

/**
 * Decide one reinstatement: refuse it as a value, or state exactly what it
 * does.
 *
 * The order is the rule: the phase first, then whether the cancellation
 * exists, whether it is already reinstated, whether it was a lottery entry,
 * whether the Auction has since ended — and only then the two questions about
 * the Auction and the Team as they stand NOW: has a fair Bid overtaken the
 * reinstated one on a clock that is still running, and can the reinstated
 * Team still keep it.
 *
 * **"Outbid fairly" is a question only while the clock runs.** Where the
 * reinstated Bid's own Auction Clock has passed, the Auction would have closed
 * to it before any later Bid could count, so every later Bid is erased
 * whatever it offered. Where the clock is still running, a later Bid strictly
 * above it is a fair raise the Commissioner cannot take back by this act. A
 * surviving EARLIER Bid above it — a history this product cannot write — is
 * refused the same way, clock or no clock, rather than seated below a higher
 * standing offer.
 */
export function decideBidReinstatement(
	state: BidReinstatementState,
	reason: string,
	now: string
): BidReinstatementOutcome {
	if (state.phase !== 'Auction') return rejected({ kind: 'phase', phase: state.phase });

	const { facts } = state;
	const cancellation = facts.cancellation;
	if (cancellation === null) {
		return rejected({ kind: 'no_such_cancellation', cancellationSeq: facts.cancellationSeq });
	}
	if (facts.reinstatedBy !== null) {
		return rejected({
			kind: 'already_reinstated',
			playerName: cancellation.playerName,
			teamName: cancellation.teamName,
			reinstatedAt: facts.reinstatedBy.occurredAt
		});
	}
	if (cancellation.wasContentionEntry) {
		return rejected({
			kind: 'contention_entry',
			playerName: cancellation.playerName,
			teamName: cancellation.teamName
		});
	}
	if (facts.endedBy !== null) {
		return rejected({
			kind: 'auction_ended',
			playerName: cancellation.playerName,
			how: facts.endedBy.how,
			endedAt: facts.endedBy.occurredAt
		});
	}

	// The Auction as the fold holds it, and the Bid still carrying THIS
	// cancellation's mark. Anything else — no Auction, or no such mark — is a
	// cancellation there is nothing to reinstate.
	const auction = auctionForPlayer(state.auctions, cancellation.fantraxPlayerId);
	const target =
		auction?.bids.find((bid) => (bid.cancellation ?? null)?.seq === cancellation.seq) ?? null;
	if (auction === null || target === null) {
		return rejected({ kind: 'no_such_cancellation', cancellationSeq: facts.cancellationSeq });
	}

	const cut = BigInt(cancellation.seq);
	const later = auction.bids.filter((bid) => BigInt(bid.seq) > cut);
	const clockExpired = hasExpired(target.closesAt, now);
	const earlierStanding = auction.bids.filter(
		(bid) => BigInt(bid.seq) < cut && bid.seq !== target.seq && !wasCancelled(bid)
	);
	const earlierAbove = highestAbove(earlierStanding, target.amount);
	const laterAbove = clockExpired
		? null
		: highestAbove(
				later.filter((bid) => !wasCancelled(bid)),
				target.amount
			);
	const overtaking = earlierAbove ?? laterAbove;
	if (overtaking !== null) {
		return rejected({
			kind: 'outbid',
			by: earlierAbove !== null ? 'earlier' : 'later',
			playerName: cancellation.playerName,
			teamName: target.teamName,
			amount: target.amount,
			byTeamName: overtaking.teamName,
			byAmount: overtaking.amount
		});
	}

	// The Auctions as the reinstatement will leave them — the SAME
	// `withBidReinstated` the reducer folds — so the gate re-test sees the
	// erased Bids gone and the reinstated one leading.
	const reinstatedAuction = withBidReinstated(auction, cancellation.seq);
	const reinstated = reinstatedAuction.leadingBid;
	if (reinstated === null) {
		// Unreachable: `target` carries the mark, so the fold seats it.
		return rejected({ kind: 'no_such_cancellation', cancellationSeq: facts.cancellationSeq });
	}
	const after: OpenAuctions = {
		byPlayer: { ...state.auctions.byPlayer, [cancellation.fantraxPlayerId]: reinstatedAuction }
	};
	const figures = state.rosterFigures;
	const gates = restoreGateResultsFor(reinstated, cancellation.fantraxPlayerId, {
		auctions: after,
		rosterFiguresFor: (teamId) => (teamId === reinstated.teamId ? figures : null),
		playerNameFor: state.playerNameFor,
		now
	});
	if (gates === null) {
		return rejected({
			kind: 'figures_unreadable',
			playerName: cancellation.playerName,
			teamName: reinstated.teamName
		});
	}
	const failing = RESTORE_LEADING_BID_GATES.filter((gate) => !gates[gate].passed);
	if (failing.length > 0) {
		return rejected({
			kind: 'gates',
			playerName: cancellation.playerName,
			teamName: reinstated.teamName,
			failing
		});
	}

	// The League Clock with the erased Bids' resets withdrawn — the same
	// membership `leagueClockReducer` records for the appended event.
	const erasedSeqs = later.map((bid) => bid.seq);
	const leagueClockExpiryBefore = leagueClockExpiry(state.leagueClock);
	const leagueClockExpiryAfter = leagueClockExpiry({
		...state.leagueClock,
		voidedSeqs: [
			...state.leagueClock.voidedSeqs,
			...erasedSeqs.filter((seq) => !state.leagueClock.voidedSeqs.includes(seq))
		]
	});

	const decision: BidReinstatementDecision = {
		phase: state.phase,
		cancellation,
		reinstated,
		leaderBefore: auction.leadingBid,
		closesAtBefore: auction.closesAt,
		contentionBefore: auction.contention,
		erased: later,
		clockExpired,
		leagueClockExpiryBefore,
		leagueClockExpiryAfter,
		gates
	};

	const leader = auction.leadingBid;
	const payload: BidCancellationReversedPayload = {
		cancellationSeq: cancellation.seq,
		reinstatedSeq: reinstated.seq,
		fantraxPlayerId: cancellation.fantraxPlayerId,
		playerName: cancellation.playerName,
		teamId: reinstated.teamId,
		teamName: reinstated.teamName,
		managerId: reinstated.managerId,
		amount: reinstated.amount,
		closesAt: reinstated.closesAt,
		clockExpired,
		causePlayerName: cancellation.causePlayerName,
		erasedBids: later.map((bid) => ({
			seq: bid.seq,
			teamId: bid.teamId,
			teamName: bid.teamName,
			managerId: bid.managerId,
			amount: bid.amount,
			wasCancelled: wasCancelled(bid)
		})),
		leaderBefore:
			leader === null
				? null
				: { seq: leader.seq, teamId: leader.teamId, teamName: leader.teamName, amount: leader.amount },
		leagueClockExpiryBefore,
		leagueClockExpiryAfter,
		reason
	};

	return { kind: 'accepted', decision, payload };
}

// --- The wording -------------------------------------------------------------

/** The name each re-tested gate goes by — the refusal panel's own labels. */
const GATE_WORDS: Readonly<Record<RestoreLeadingBidGate, string>> = Object.freeze({
	cap: 'Cap',
	slots: 'Slots'
});

const ENDING_WORDS: Readonly<Record<AuctionEnding['how'], string>> = Object.freeze({
	closed: 'closed',
	terminated: 'ended with no winner',
	drawn: 'had its Minimum-Bid Contention drawn',
	dissolved: 'had its Minimum-Bid Contention dissolved'
});

/**
 * The one sentence a refused reinstatement is reported by —
 * `closeReversalRefusalDetail`'s shape. Each ends by saying nothing was written.
 */
export function bidReinstatementRefusalDetail(refusal: BidReinstatementRefusal): string {
	switch (refusal.kind) {
		case 'phase':
			return (
				`A cancelled Bid can be reinstated only in the Auction Phase, and the League is in ` +
				`${refusal.phase}. Nothing was written.`
			);
		case 'no_such_cancellation':
			return CANONICAL_SEQ.test(refusal.cancellationSeq)
				? `No Bid Cancellation in the log has the position ${refusal.cancellationSeq}, or the Bid it ` +
						`cancelled is no longer in an open Auction, so there is nothing to reinstate.`
				: 'No Bid Cancellation was named, so there is nothing to reinstate.';
		case 'already_reinstated':
			return (
				`${refusal.teamName}'s cancelled Bid on ${refusal.playerName} was already reinstated ` +
				`(${refusal.reinstatedAt}). A cancellation is reversed once; nothing was written.`
			);
		case 'contention_entry':
			return (
				`${refusal.teamName}'s cancelled Bid on ${refusal.playerName} was a Minimum-Bid Contention ` +
				`entry. A lottery entry cannot be reinstated; nothing was written.`
			);
		case 'auction_ended':
			return (
				`The Auction for ${refusal.playerName} ${ENDING_WORDS[refusal.how]} after the cancellation ` +
				`(${refusal.endedAt}), so the Bid cannot be reinstated. Nothing was written.`
			);
		case 'outbid':
			if (refusal.by === 'earlier') {
				return (
					`${refusal.byTeamName}'s ${describeActAmount(refusal.byAmount)} Bid on ${refusal.playerName}, ` +
					`placed before the cancellation, still stands above ${refusal.teamName}'s ` +
					`${describeActAmount(refusal.amount)}, so the cancelled Bid cannot be reinstated beneath ` +
					`it. Nothing was written.`
				);
			}
			return (
				`${refusal.byTeamName}'s ${describeActAmount(refusal.byAmount)} Bid on ${refusal.playerName} ` +
				`beats ${refusal.teamName}'s ${describeActAmount(refusal.amount)} on a clock that is still ` +
				`running, so the cancelled Bid cannot be reinstated over it. Nothing was written.`
			);
		case 'figures_unreadable':
			return (
				`${refusal.teamName}'s roster figures could not be read, so the reinstatement is refused. ` +
				`Nothing was written.`
			);
		case 'gates': {
			const names = refusal.failing.map((gate) => GATE_WORDS[gate]);
			const gatesWords =
				names.length === 1 ? `the ${names[0] ?? ''} gate` : `the ${names.join(' and ')} gates`;
			return (
				`${refusal.teamName} fails ${gatesWords} as of now, so it could not keep the reinstated ` +
				`Bid on ${refusal.playerName}. A reinstatement is refused rather than cancelling anything ` +
				`else; nothing was written.`
			);
		}
	}
}

/**
 * The consequence notes the reason sheet carries, in words — each a sentence
 * the two states on the sheet do not show.
 */
export type BidReinstatementNotes = {
	readonly leader: string;
	readonly clock: string;
	readonly erased: string;
	readonly leagueClock: string;
};

export function bidReinstatementAttention(decision: BidReinstatementDecision): BidReinstatementNotes {
	const { reinstated, cancellation } = decision;
	const player = cancellation.playerName;
	const team = reinstated.teamName;
	const amount = describeActAmount(reinstated.amount);

	const leader =
		decision.leaderBefore === null
			? `Nobody leads ${player} now. ${team} leads again at ${amount}, and that capital is committed again.`
			: `${decision.leaderBefore.teamName} leads ${player} now at ` +
				`${describeActAmount(decision.leaderBefore.amount)}. ${team} leads again at ${amount}, and ` +
				`that capital is committed again.`;

	const clock = decision.clockExpired
		? `The Bid's original Auction Clock (${reinstated.closesAt}) has already passed, so the next tick ` +
			`closes this Auction to ${team} at ${amount} — this reinstatement appends no close itself, and the ` +
			`FR-40 cascade runs on that close.`
		: `The Bid's original Auction Clock returns: the Auction closes at ${reinstated.closesAt}.`;

	// A later Bid an unrelated cancellation had ALREADY withdrawn is erased
	// too, but it committed nothing — so it is stated apart, and nothing is
	// said to be released for it.
	const live = decision.erased.filter((bid) => !wasCancelled(bid));
	const alreadyCancelled = decision.erased.filter((bid) => wasCancelled(bid));
	const count = live.length;
	const openedLottery = live.some((bid) => contentionForAmount(bid.amount) === 'minimum_bid');
	const bidsWords = (bids: readonly Bid[]): string =>
		bids.map((bid) => `${bid.teamName}'s ${describeActAmount(bid.amount)}`).join(', ');
	const liveSentence =
		count === 0
			? ''
			: `The ${count === 1 ? 'Bid' : `${String(count)} Bids`} placed after the cancellation ` +
				`${count === 1 ? 'is' : 'are'} erased — ${bidsWords(live)}. ` +
				`${count === 1 ? 'Its capital is released and its League Clock reset is' : 'Their capital is released and their League Clock resets are'} withdrawn.` +
				(openedLottery
					? ' The Minimum-Bid Contention they opened is ruled never to have run: no draw is owed and ' +
						'its sealed seed is not revealed.'
					: '');
	const cancelledSentence =
		alreadyCancelled.length === 0
			? ''
			: `${alreadyCancelled.length === 1 ? 'A later Bid' : `${String(alreadyCancelled.length)} later Bids`} ` +
				`already cancelled by another Close (${bidsWords(alreadyCancelled)}) ` +
				`${alreadyCancelled.length === 1 ? 'is' : 'are'} erased as well: ` +
				`${alreadyCancelled.length === 1 ? 'it committed' : 'they committed'} no capital, so nothing ` +
				'is released, and only the League Clock reset is withdrawn.';
	const erased =
		decision.erased.length === 0
			? 'No Bid was placed after the cancellation, so nothing is erased.'
			: [liveSentence, cancelledSentence].filter((part) => part !== '').join(' ');

	const before = decision.leagueClockExpiryBefore ?? 'no expiry';
	const after = decision.leagueClockExpiryAfter ?? 'no expiry';
	const leagueClock =
		before === after
			? `The League Clock is unchanged: it expires at ${before}.`
			: `The League Clock recomputes from ${before} to ${after}, because the erased Bids' resets no ` +
				`longer count. If that is already past, the Auction Phase ends at the next tick.`;

	return { leader, clock, erased, leagueClock };
}

/**
 * The act, as one finished sentence — never assembled from a template the
 * sheet holds.
 */
export function bidReinstatementActSentence(decision: BidReinstatementDecision): string {
	const { reinstated, cancellation } = decision;
	return (
		`Reinstate ${reinstated.teamName}'s ${describeActAmount(reinstated.amount)} Bid on ` +
		`${cancellation.playerName}, cancelled by the Close of ${cancellation.causePlayerName}. It leads ` +
		`again with its original Auction Clock, and every Bid placed after the cancellation is erased.`
	);
}
