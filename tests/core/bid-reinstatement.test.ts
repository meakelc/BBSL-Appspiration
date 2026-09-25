/**
 * `decideBidReinstatement` and the fold it drives (Story 7.14, FR-32, FR-40).
 *
 * Every row of the story's I/O matrix, fold replay convergence, the League
 * Clock void, capital release, and a golden replay of the production Knecht
 * log ending in `overdueAuctions` offering the Auction led by DET at
 * $2,000,000 — which is how the next tick's ordinary close awards it.
 */

import { describe, expect, it } from 'vitest';

import { noticeFor } from '../../src/lib/adapters/discord/broadcast.ts';
import type { LeagueDirectory } from '../../src/lib/adapters/discord/broadcast.ts';
import { mentionSuffixFor } from '../../src/lib/adapters/discord/mention.ts';
import { affectedTeamsForReinstatement } from '../../src/lib/server/bid-reinstatement.ts';
import { NO_REFERENCES, auditRowsFor } from '../../src/lib/core/audit-log.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	CONTENTION_DISSOLVED_EVENT,
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer,
	overdueAuctions,
	readErasedSeqs,
	withBidReinstated
} from '../../src/lib/core/projection/auctions.ts';
import { CONTENTION_DRAWN_EVENT } from '../../src/lib/core/projection/draws.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	INITIAL_LEAGUE_CLOCK,
	leagueClockExpiry,
	leagueClockReducer
} from '../../src/lib/core/projection/league-clock.ts';
import { AUCTION_TERMINATED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import {
	bidReinstatementActSentence,
	bidReinstatementAttention,
	bidReinstatementFactsFor,
	bidReinstatementRefusalDetail,
	decideBidReinstatement
} from '../../src/lib/core/rules/bid-reinstatement.ts';
import type {
	BidCancellationReversedPayload,
	BidReinstatementOutcome
} from '../../src/lib/core/rules/bid-reinstatement.ts';
import { closedWinnerFor } from '../../src/lib/core/rules/close.ts';
import { teamMoneyStateFor } from '../../src/lib/core/rules/bidding.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';
import { bidReinstatementReasonRows } from '../../src/lib/reason-sheet-view.ts';
import {
	BOS,
	BOS_BID_SEQ,
	CANCELLATION_SEQ,
	DET,
	DET_BID_SEQ,
	DET_CLOSES_AT,
	DET_FIGURES_FULL,
	KNECHT,
	LOTTERY_CLOSES_AT,
	NOW_AFTER_CLOCK,
	NOW_BEFORE_CLOCK,
	NYK,
	NYK_BID_SEQ,
	detCancelled,
	nestedLog,
	knechtLog,
	placed,
	reinstatementEvent,
	stateFor
} from '../fixtures/bid-reinstatement-log.ts';
import { contractAssignmentOpened, ev } from '../fixtures/close-reversal-log.ts';

const REASON = 'Butler was on IR in Fantrax; the cancellation should not have fired.';

function accepted(outcome: BidReinstatementOutcome) {
	if (outcome.kind !== 'accepted') {
		throw new Error(`expected accepted, got ${JSON.stringify(outcome.refusal)}`);
	}
	return outcome;
}

function refusalOf(outcome: BidReinstatementOutcome) {
	if (outcome.kind !== 'rejected') throw new Error('expected a refusal');
	return outcome.refusal;
}

/** The log with the reinstatement appended, exactly as the shell appends it. */
function reinstated(events: readonly AppendedEvent[], payload: BidCancellationReversedPayload) {
	return [...events, reinstatementEvent(6000, payload)];
}

describe('clock passed — the Knecht case, replayed (golden)', () => {
	const outcome = accepted(decideBidReinstatement(stateFor(knechtLog()), REASON, NOW_AFTER_CLOCK));
	const log = reinstated(knechtLog(), outcome.payload);
	const auctions = fold(INITIAL_AUCTIONS, log, auctionsReducer);
	const knecht = auctionForPlayer(auctions, KNECHT);

	it('records the decision on one payload', () => {
		expect(outcome.payload).toMatchObject({
			cancellationSeq: CANCELLATION_SEQ,
			reinstatedSeq: DET_BID_SEQ,
			fantraxPlayerId: KNECHT,
			teamId: DET,
			amount: 2_000_000,
			closesAt: DET_CLOSES_AT,
			clockExpired: true,
			causePlayerName: 'Cam Whitmore',
			reason: REASON
		});
		expect(outcome.payload.erasedBids.map((bid) => [bid.seq, bid.teamId, bid.amount])).toEqual([
			[NYK_BID_SEQ, NYK, 1_000_000],
			[BOS_BID_SEQ, BOS, 1_000_000]
		]);
		expect(outcome.payload.leaderBefore).toMatchObject({ seq: NYK_BID_SEQ, teamId: NYK });
	});

	it('leads on the reinstated Bid with its ORIGINAL, expired clock, and erases the later Bids', () => {
		expect(knecht?.leadingBid?.teamId).toBe(DET);
		expect(knecht?.leadingBid?.amount).toBe(2_000_000);
		expect(knecht?.leadingBid?.cancellation ?? null).toBeNull();
		expect(knecht?.closesAt).toBe(DET_CLOSES_AT);
		expect(knecht?.contention).toBe('standard');
		expect(knecht?.bids.map((bid) => bid.seq)).toEqual([DET_BID_SEQ]);
		expect(knecht?.contenders).toEqual([]);
	});

	it('is offered to the next sweep, which closes it to DET at $2,000,000', () => {
		const due = overdueAuctions(auctions, NOW_AFTER_CLOCK);
		expect(due.map((auction) => auction.fantraxPlayerId)).toEqual([KNECHT]);
		const party = closedWinnerFor(due[0] ?? null, null);
		expect(party).toMatchObject({ teamId: DET, winningAmount: 2_000_000, contention: 'standard' });
	});

	it('refolds to identical state, twice, and in any input order', () => {
		const again = fold(INITIAL_AUCTIONS, log, auctionsReducer);
		expect(again).toEqual(auctions);
		expect(fold(INITIAL_AUCTIONS, [...log].reverse(), auctionsReducer)).toEqual(auctions);
		const clock = fold(INITIAL_LEAGUE_CLOCK, log, leagueClockReducer);
		expect(fold(INITIAL_LEAGUE_CLOCK, [...log].reverse(), leagueClockReducer)).toEqual(clock);
		// The erased events are still in the log — nothing was deleted (AD-4).
		expect(log.filter((event) => event.seq === NYK_BID_SEQ)).toHaveLength(1);
		expect(log.filter((event) => event.seq === CANCELLATION_SEQ)).toHaveLength(1);
	});

	it('withdraws each erased Bid’s League Clock reset — the void’s treatment', () => {
		const before = fold(INITIAL_LEAGUE_CLOCK, knechtLog(), leagueClockReducer);
		const after = fold(INITIAL_LEAGUE_CLOCK, log, leagueClockReducer);
		expect(after.voidedSeqs).toEqual([NYK_BID_SEQ, BOS_BID_SEQ]);
		expect(leagueClockExpiry(before)).toBe('2026-09-27T17:30:00.000Z');
		// Back to DET's own Knecht Bid, the latest surviving reset.
		expect(leagueClockExpiry(after)).toBe('2026-09-26T15:15:01.801Z');
		expect(outcome.payload.leagueClockExpiryBefore).toBe(leagueClockExpiry(before));
		expect(outcome.payload.leagueClockExpiryAfter).toBe(leagueClockExpiry(after));
		expect(readErasedSeqs(outcome.payload)).toEqual([NYK_BID_SEQ, BOS_BID_SEQ]);
	});

	it('releases every erased Team’s capital, and commits DET’s again', () => {
		const leadsOn = (teamId: string, folded: typeof auctions) =>
			teamMoneyStateFor({
				teamId,
				fantraxPlayerId: '',
				capSpace: parseMoney(50_000_000),
				rosterCount: 5,
				minorLeagueOccupied: 0,
				auctions: folded,
				playerNameFor: (id) => id
			}).leading.map((lead) => lead.fantraxPlayerId);
		const before = fold(INITIAL_AUCTIONS, knechtLog(), auctionsReducer);
		expect(leadsOn(NYK, before)).toEqual([KNECHT]);
		expect(leadsOn(BOS, before)).toEqual([KNECHT]);
		expect(leadsOn(DET, before)).toEqual([]);
		expect(leadsOn(NYK, auctions)).toEqual([]);
		expect(leadsOn(BOS, auctions)).toEqual([]);
		expect(leadsOn(DET, auctions)).toEqual([KNECHT]);
	});

	it('states the act and its consequences in words', () => {
		expect(bidReinstatementActSentence(outcome.decision)).toContain(
			"Reinstate Detroit's $2.0M Bid on Dalton Knecht"
		);
		const notes = bidReinstatementAttention(outcome.decision);
		expect(notes.clock).toContain('already passed');
		expect(notes.clock).toContain('appends no close itself');
		expect(notes.erased).toContain('ruled never to have run');
		expect(notes.leagueClock).toContain('2026-09-27T17:30:00.000Z');
		expect(notes.leagueClock).toContain('2026-09-26T15:15:01.801Z');
		const rows = bidReinstatementReasonRows(outcome.decision);
		expect(rows[0]).toMatchObject({ before: 'New York · $1.0M', after: 'Detroit · $2.0M' });
		expect(rows[1]).toMatchObject({ before: LOTTERY_CLOSES_AT, after: DET_CLOSES_AT });
		expect(rows[2]?.after).toBe('Erased');
	});
});

describe('clock running — later Bids all at or below the reinstated amount', () => {
	it('reinstates with the original clock still running', () => {
		const outcome = accepted(
			decideBidReinstatement(stateFor(knechtLog()), REASON, NOW_BEFORE_CLOCK)
		);
		expect(outcome.payload.clockExpired).toBe(false);
		const auctions = fold(INITIAL_AUCTIONS, reinstated(knechtLog(), outcome.payload), auctionsReducer);
		expect(auctionForPlayer(auctions, KNECHT)?.closesAt).toBe(DET_CLOSES_AT);
		expect(overdueAuctions(auctions, NOW_BEFORE_CLOCK)).toEqual([]);
		expect(bidReinstatementAttention(outcome.decision).clock).toContain(
			`closes at ${DET_CLOSES_AT}`
		);
	});

	it('reinstates over a later Bid of exactly the same amount', () => {
		const log = [
			...knechtLog().slice(0, 7),
			placed(5534, KNECHT, NYK, 2_000_000, '2026-09-24T21:00:00.000Z', '2026-09-25T21:00:00.000Z')
		];
		expect(decideBidReinstatement(stateFor(log), REASON, NOW_BEFORE_CLOCK).kind).toBe('accepted');
	});
});

describe('the refusals — each a value, and nothing written', () => {
	it('outbid: a later Bid above the amount on a clock still running', () => {
		const log = [
			...knechtLog().slice(0, 7),
			placed(5534, KNECHT, NYK, 3_000_000, '2026-09-24T21:00:00.000Z', '2026-09-25T21:00:00.000Z')
		];
		const refusal = refusalOf(decideBidReinstatement(stateFor(log), REASON, NOW_BEFORE_CLOCK));
		expect(refusal).toMatchObject({ kind: 'outbid', byTeamName: 'New York' });
		expect(bidReinstatementRefusalDetail(refusal)).toContain("New York's $3.0M Bid");
		// The same log once DET's clock has passed: the raise is erased with the rest.
		expect(decideBidReinstatement(stateFor(log), REASON, NOW_AFTER_CLOCK).kind).toBe('accepted');
	});

	it('gates: the reinstated Team fails the re-test as of now, and names the gate', () => {
		const refusal = refusalOf(
			decideBidReinstatement(
				stateFor(knechtLog(), CANCELLATION_SEQ, DET_FIGURES_FULL),
				REASON,
				NOW_AFTER_CLOCK
			)
		);
		expect(refusal).toMatchObject({ kind: 'gates', failing: ['slots'] });
		expect(bidReinstatementRefusalDetail(refusal)).toContain('fails the Slots gate as of now');

		const broke = refusalOf(
			decideBidReinstatement(
				stateFor(knechtLog(), CANCELLATION_SEQ, {
					capSpace: parseMoney(0),
					rosterCount: 10,
					minorLeagueOccupied: 3
				}),
				REASON,
				NOW_AFTER_CLOCK
			)
		);
		expect(broke).toMatchObject({ kind: 'gates' });
		expect(broke.kind === 'gates' && broke.failing.includes('cap')).toBe(true);
	});

	it('contention_entry: a cancelled lottery ticket is never reinstated', () => {
		const log = knechtLog().map((event) =>
			event.seq === CANCELLATION_SEQ ? detCancelled(Number(CANCELLATION_SEQ), true) : event
		);
		const refusal = refusalOf(decideBidReinstatement(stateFor(log), REASON, NOW_AFTER_CLOCK));
		expect(refusal.kind).toBe('contention_entry');
		expect(bidReinstatementRefusalDetail(refusal)).toContain('lottery entry cannot be reinstated');
	});

	it('already_reinstated: a reinstatement already names this cancellation', () => {
		const first = accepted(decideBidReinstatement(stateFor(knechtLog()), REASON, NOW_AFTER_CLOCK));
		const log = reinstated(knechtLog(), first.payload);
		const refusal = refusalOf(decideBidReinstatement(stateFor(log), REASON, NOW_AFTER_CLOCK));
		expect(refusal.kind).toBe('already_reinstated');
		expect(bidReinstatementRefusalDetail(refusal)).toContain('already reinstated');
	});

	it('auction_ended: closed, terminated, drawn or dissolved after the cancellation', () => {
		const endings: Array<[string, unknown, string]> = [
			[
				'AuctionClosed',
				{
					fantraxPlayerId: KNECHT,
					playerName: 'Dalton Knecht',
					teamId: NYK,
					teamName: 'New York',
					managerId: `m-${NYK}`,
					winningAmount: 1_000_000,
					capHit: 1_000_000,
					placement: 'active_bench',
					contention: 'minimum_bid',
					contractYears: null,
					closedAt: LOTTERY_CLOSES_AT,
					releasedNominationSlot: false
				},
				'closed'
			],
			[AUCTION_TERMINATED_EVENT, { fantraxPlayerId: KNECHT }, 'terminated'],
			[CONTENTION_DRAWN_EVENT, { fantraxPlayerId: KNECHT }, 'drawn'],
			[CONTENTION_DISSOLVED_EVENT, { fantraxPlayerId: KNECHT, seed: 'b'.repeat(64) }, 'dissolved']
		];
		for (const [type, payload, how] of endings) {
			const log = [...knechtLog(), ev(5600, type, payload, '2026-09-26T17:00:00.000Z')];
			const facts = bidReinstatementFactsFor(log, CANCELLATION_SEQ);
			expect(facts.endedBy?.how, type).toBe(how);
			const refusal = refusalOf(decideBidReinstatement(stateFor(log), REASON, NOW_AFTER_CLOCK));
			expect(refusal.kind, type).toBe('auction_ended');
		}
	});

	it('phase: nothing is reinstated outside the Auction Phase', () => {
		const log = [...knechtLog(), contractAssignmentOpened(5700)];
		const refusal = refusalOf(decideBidReinstatement(stateFor(log), REASON, NOW_AFTER_CLOCK));
		expect(refusal).toEqual({ kind: 'phase', phase: 'Contract Assignment' });
		expect(bidReinstatementRefusalDetail(refusal)).toContain('only in the Auction Phase');
	});

	it('no_such_cancellation: a seq that is no BidCancelled, or no seq at all', () => {
		for (const seq of [DET_BID_SEQ, '999999', '', 'drop table', '007']) {
			const refusal = refusalOf(decideBidReinstatement(stateFor(knechtLog(), seq), REASON, NOW_AFTER_CLOCK));
			expect(refusal.kind, seq).toBe('no_such_cancellation');
		}
		expect(
			bidReinstatementRefusalDetail({ kind: 'no_such_cancellation', cancellationSeq: '' })
		).toBe('No Bid Cancellation was named, so there is nothing to reinstate.');
	});
});

describe('withBidReinstated — the fold’s whole effect', () => {
	it('is idempotent, and ignores a seq no Bid in this Auction carries', () => {
		const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, knechtLog(), auctionsReducer), KNECHT);
		if (auction === null) throw new Error('no Auction');
		const once = withBidReinstated(auction, CANCELLATION_SEQ);
		expect(once).not.toBe(auction);
		expect(withBidReinstated(once, CANCELLATION_SEQ)).toBe(once);
		expect(withBidReinstated(auction, '12345')).toBe(auction);
	});

	it('skips a malformed reinstatement payload rather than crashing the fold', () => {
		const before = fold(INITIAL_AUCTIONS, knechtLog(), auctionsReducer);
		for (const payload of [null, 'x', {}, { fantraxPlayerId: KNECHT }, { fantraxPlayerId: KNECHT, cancellationSeq: 'abc' }]) {
			const after = fold(INITIAL_AUCTIONS, [...knechtLog(), reinstatementEvent(6000, payload)], auctionsReducer);
			expect(after).toEqual(before);
		}
		expect(readErasedSeqs({ erasedBids: [{ seq: 5 }, null, { seq: '7' }, { seq: '7' }] })).toEqual(['7']);
	});
});

describe('the Audit Log entry — a distinct Bid Reinstatement', () => {
	it('states the reason first, the erased Bids, the lottery ruling and the League Clock', () => {
		const outcome = accepted(decideBidReinstatement(stateFor(knechtLog()), REASON, NOW_AFTER_CLOCK));
		const [row] = auditRowsFor([reinstatementEvent(6000, outcome.payload)], NO_REFERENCES);
		expect(row?.typeLabel).toBe('Bid Reinstatement');
		expect(row?.headline).toBe("Detroit's cancelled bid on Dalton Knecht was reinstated.");
		expect(row?.details[0]).toEqual({ label: 'Reason', value: REASON });
		const byLabel = new Map(row?.details.map((detail) => [detail.label, detail.value]));
		expect(byLabel.get('Reversed cancellation')).toBe(CANCELLATION_SEQ);
		expect(byLabel.get('Bids erased')).toBe('New York at $1.0M, Boston at $1.0M');
		expect(byLabel.get('Minimum-Bid Contention erased')).toContain('sealed seed is not revealed');
		expect(byLabel.get('League Clock expiry')).toBe(
			'2026-09-27T17:30:00.000Z → 2026-09-26T15:15:01.801Z'
		);
		// Every erased Team is a party, beside the reinstated one (the actor's
		// own Team rides the envelope and is a party too).
		expect(row?.teams).toEqual(expect.arrayContaining([DET, NYK, BOS]));
	});
});

describe('review patches (Story 7.14)', () => {
	it('figures_unreadable: an unreadable roster is its own refusal, not two failed gates', () => {
		const refusal = refusalOf(
			decideBidReinstatement(stateFor(knechtLog(), CANCELLATION_SEQ, null), REASON, NOW_AFTER_CLOCK)
		);
		expect(refusal).toEqual({
			kind: 'figures_unreadable',
			playerName: 'Dalton Knecht',
			teamName: 'Detroit'
		});
		expect(bidReinstatementRefusalDetail(refusal)).toBe(
			"Detroit's roster figures could not be read, so the reinstatement is refused. Nothing was written."
		);
	});

	it('outbid by an EARLIER standing Bid: refused whatever the clock, and worded as such', () => {
		// A hand-written history: NYK's $3.0M stands BELOW DET's cancelled Bid in seq.
		const log = knechtLog().flatMap((event) =>
			event.seq === DET_BID_SEQ
				? [
						placed(5210, KNECHT, NYK, 3_000_000, '2026-09-24T12:00:00.000Z', '2026-09-25T12:00:00.000Z'),
						event
					]
				: [event]
		);
		for (const now of [NOW_AFTER_CLOCK, NOW_BEFORE_CLOCK]) {
			const refusal = refusalOf(decideBidReinstatement(stateFor(log), REASON, now));
			expect(refusal).toMatchObject({ kind: 'outbid', by: 'earlier', byTeamName: 'New York' });
			const detail = bidReinstatementRefusalDetail(refusal);
			expect(detail).toContain('placed before the cancellation, still stands above');
			expect(detail).not.toContain('still running');
		}
	});

	it('a later Bid raise is worded as a running-clock outbid', () => {
		const log = [
			...knechtLog().slice(0, 7),
			placed(5534, KNECHT, NYK, 3_000_000, '2026-09-24T21:00:00.000Z', '2026-09-25T21:00:00.000Z')
		];
		const refusal = refusalOf(decideBidReinstatement(stateFor(log), REASON, NOW_BEFORE_CLOCK));
		expect(refusal).toMatchObject({ kind: 'outbid', by: 'later' });
		expect(bidReinstatementRefusalDetail(refusal)).toContain('on a clock that is still running');
	});

	describe('a later Bid already cancelled by an unrelated close', () => {
		const outcome = accepted(decideBidReinstatement(stateFor(nestedLog()), REASON, NOW_AFTER_CLOCK));
		const log = reinstated(nestedLog(), outcome.payload);

		it('is still erased, flagged, and its League Clock reset still voided', () => {
			expect(
				outcome.payload.erasedBids.map((bid) => [bid.seq, bid.teamId, bid.wasCancelled])
			).toEqual([
				[NYK_BID_SEQ, NYK, true],
				[BOS_BID_SEQ, BOS, false]
			]);
			const knecht = auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), KNECHT);
			expect(knecht?.bids.map((bid) => bid.seq)).toEqual([DET_BID_SEQ]);
			expect(fold(INITIAL_LEAGUE_CLOCK, log, leagueClockReducer).voidedSeqs).toEqual([
				NYK_BID_SEQ,
				BOS_BID_SEQ
			]);
		});

		it('is not said to release capital in the notes or the Audit Log', () => {
			const erased = bidReinstatementAttention(outcome.decision).erased;
			expect(erased).toContain("The Bid placed after the cancellation is erased — Boston's $1.0M.");
			expect(erased).toContain('Its capital is released');
			expect(erased).toContain("A later Bid already cancelled by another Close (New York's $1.0M)");
			expect(erased).toContain('committed no capital, so nothing is released');
			const [row] = auditRowsFor([reinstatementEvent(6000, outcome.payload)], NO_REFERENCES);
			const byLabel = new Map(row?.details.map((detail) => [detail.label, detail.value]));
			expect(byLabel.get('Bids erased')).toBe('New York at $1.0M (already cancelled), Boston at $1.0M');
		});

		it('is neither mentioned nor enqueued for, nor named in the broadcast', () => {
			const event = reinstatementEvent(6000, outcome.payload);
			expect(affectedTeamsForReinstatement(event)).toEqual([DET, BOS]);
			const directory: LeagueDirectory = {
				teamNames: new Map([
					[DET, 'Detroit'],
					[NYK, 'New York'],
					[BOS, 'Boston']
				]),
				managerNames: new Map(),
				managersOfTeam: new Map(),
				managerIdsByDiscordUserId: new Map([
					['s-det', 'm-det'],
					['s-nyk', 'm-nyk'],
					['s-bos', 'm-bos']
				]),
				teamOfManager: new Map([
					['m-det', DET],
					['m-nyk', NYK],
					['m-bos', BOS]
				])
			};
			const broadcastEvent = {
				seq: '6000',
				eventType: event.type,
				payload: event.payload,
				managerId: null,
				occurredAt: event.occurredAt,
				playerName: 'Dalton Knecht'
			};
			const suffix = mentionSuffixFor(broadcastEvent, ['s-det', 's-nyk', 's-bos'], directory);
			expect(suffix).toContain('<@s-det>');
			expect(suffix).toContain('<@s-bos>');
			expect(suffix).not.toContain('<@s-nyk>');
			const notice = noticeFor(broadcastEvent, directory);
			expect(notice).toContain('Erased: the later Bid by Boston.');
			expect(notice).not.toContain('New York');
		});
	});
});
