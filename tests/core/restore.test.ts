/**
 * `core/rules/restore.ts` — the ONE selector, against its I/O matrix
 * (Story 10.4, FR-40, AR-36, AR-37).
 *
 * Every row of the story's matrix is a test here, plus the two-cancellations
 * accumulation and the winner-as-its-own-candidate case: the matrix is the
 * selector's contract, and a row without a test is a clause nothing holds to.
 *
 * Calls the core directly against state literals — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { parseMoney } from '../../src/lib/core/money.ts';
import type { Money } from '../../src/lib/core/money.ts';
import { withBidCancelled } from '../../src/lib/core/projection/auctions.ts';
import type { Auction, Bid, OpenAuctions } from '../../src/lib/core/projection/auctions.ts';
import { CANCELLATION_AXES, selectRestoration } from '../../src/lib/core/rules/restore.ts';
import type {
	CandidateRosterFigures,
	RestorationAxes
} from '../../src/lib/core/rules/restore.ts';

const CLOSES = '2026-08-28T06:00:00.000Z';
const NOW = '2026-08-27T11:00:00.000Z';
/** Nobody in this file is short of money; capacity is the ground throughout. */
const RICH: Money = parseMoney(60_000_000);

function bidBy(seq: string, teamId: string, amount: number, closesAt = CLOSES): Bid {
	return {
		seq,
		teamId,
		teamName: `Team ${teamId}`,
		managerId: `m-${teamId}`,
		amount: parseMoney(amount),
		occurredAt: '2026-08-26T09:00:00.000Z',
		closesAt,
		seedHash: null
	};
}

function standardAuction(fantraxPlayerId: string, bids: readonly Bid[]): Auction {
	const leadingBid = bids[bids.length - 1];
	if (leadingBid === undefined) throw new Error('restore.test: an Auction with no Bids');
	return {
		fantraxPlayerId,
		contention: 'standard',
		leadingBid,
		closesAt: leadingBid.closesAt,
		bids: [...bids],
		contenders: [],
		seedHash: null,
		seed: null
	};
}

function auctionsOf(entries: readonly Auction[]): OpenAuctions {
	return {
		byPlayer: Object.fromEntries(entries.map((auction) => [auction.fantraxPlayerId, auction]))
	};
}

/** The Auction as the cascade hands it over: the victim's lead withdrawn. */
function withdraw(auction: Auction, seq: string): Auction {
	return withBidCancelled(auction, seq, {
		seq: '',
		causeFantraxPlayerId: 'p-cause',
		causePlayerName: 'Dex Brooks',
		restoration: null
	});
}

function figures(rosterCount: number, capSpace: Money = RICH): CandidateRosterFigures {
	return { capSpace, rosterCount, minorLeagueOccupied: 0 };
}

/** Ask the selector, with FR-40's axes unless a test says otherwise. */
function select(input: {
	readonly auctions: OpenAuctions;
	readonly fantraxPlayerId: string;
	readonly withdrawnSeq: string;
	readonly rosters: Readonly<Record<string, CandidateRosterFigures>>;
	readonly axes?: RestorationAxes;
}) {
	return selectRestoration({
		fantraxPlayerId: input.fantraxPlayerId,
		withdrawnSeq: input.withdrawnSeq,
		basis: {
			auctions: input.auctions,
			rosterFiguresFor: (teamId: string) => input.rosters[teamId] ?? null,
			isMinorLeagueEligible: () => false,
			playerNameFor: (playerId: string) => `Player ${playerId}`,
			now: NOW
		},
		axes: input.axes ?? CANCELLATION_AXES
	});
}

describe('selectRestoration — the next-highest surviving Bid that still stands', () => {
	it('names the next-highest when it passes both gates (matrix: clean restoration)', () => {
		// Example 31's second half. Team U's $2,000,000 lead on Carter is
		// cancelled; Team V's $1,500,000 survives, passes `cap` and `slots`,
		// and is handed the Auction at its own amount.
		const carter = standardAuction('p-carter', [
			bidBy('150', 't-v', 1_500_000),
			bidBy('190', 't-u', 2_000_000)
		]);
		const outcome = select({
			auctions: auctionsOf([withdraw(carter, '190')]),
			fantraxPlayerId: 'p-carter',
			withdrawnSeq: '190',
			rosters: { 't-v': figures(8), 't-u': figures(12) }
		});

		expect(outcome.restored).toEqual({
			seq: '150',
			teamId: 't-v',
			teamName: 'Team t-v',
			managerId: 'm-t-v',
			amount: 1_500_000
		});
	});

	it('skips a failing candidate and tries the next below it (matrix: ex. 32)', () => {
		// Team V is HIGHER than Team W and must not lead: it has reached
		// Roster Count 12 of its own accord, so it fails `slots`, is skipped,
		// and is never cancelled. W passes and the price falls to $1,000,000.
		const carter = standardAuction('p-carter', [
			bidBy('120', 't-w', 1_000_000),
			bidBy('150', 't-v', 1_500_000),
			bidBy('190', 't-u', 2_000_000)
		]);
		const withdrawn = withdraw(carter, '190');
		const outcome = select({
			auctions: auctionsOf([withdrawn]),
			fantraxPlayerId: 'p-carter',
			withdrawnSeq: '190',
			rosters: { 't-v': figures(12), 't-w': figures(9), 't-u': figures(12) }
		});

		expect(outcome.restored?.teamId).toBe('t-w');
		expect(outcome.restored?.seq).toBe('120');
		expect(outcome.restored?.amount).toBe(1_000_000);
		// Skipped is not cancelled: Team V's Bid is still standing, unmarked.
		expect(withdrawn.bids.find((entry) => entry.seq === '150')?.cancellation ?? null).toBeNull();
	});

	it('answers null when the cancelled Bid was the only one (matrix: ex. 33)', () => {
		const carter = standardAuction('p-carter', [bidBy('190', 't-u', 2_000_000)]);
		const outcome = select({
			auctions: auctionsOf([withdraw(carter, '190')]),
			fantraxPlayerId: 'p-carter',
			withdrawnSeq: '190',
			rosters: { 't-u': figures(12) }
		});

		expect(outcome.restored).toBeNull();
	});

	it('answers null when EVERY candidate fails, with survivors still standing', () => {
		// The row that separates 10.4 from 10.3: two un-cancelled Bids remain
		// and the Auction still goes leaderless. `highestStandingBid` would
		// have promoted one of them.
		const carter = standardAuction('p-carter', [
			bidBy('120', 't-w', 1_000_000),
			bidBy('150', 't-v', 1_500_000),
			bidBy('190', 't-u', 2_000_000)
		]);
		const withdrawn = withdraw(carter, '190');
		const outcome = select({
			auctions: auctionsOf([withdrawn]),
			fantraxPlayerId: 'p-carter',
			withdrawnSeq: '190',
			// V is full on slots; W has the room but not the money.
			rosters: { 't-v': figures(12), 't-w': figures(9, parseMoney(0)), 't-u': figures(12) }
		});

		expect(outcome.restored).toBeNull();
		expect(withdrawn.bids.filter((entry) => (entry.cancellation ?? null) === null)).toHaveLength(2);
	});

	it('judges a second candidacy against the state the FIRST restoration left', () => {
		// The only way one cascade can push a NON-winning Team over its own
		// allowance. Team Z is next-highest on both Auctions and has ONE free
		// Slot: the first restoration is permitted by the allowance, and the
		// second is not, so the next below is tried instead.
		const first = standardAuction('p-one', [
			bidBy('100', 't-z', 3_000_000),
			bidBy('180', 't-u', 4_000_000)
		]);
		const second = standardAuction('p-two', [
			bidBy('110', 't-y', 1_000_000),
			bidBy('120', 't-z', 3_000_000),
			bidBy('190', 't-u', 4_000_000)
		]);
		const rosters = { 't-z': figures(11), 't-y': figures(4), 't-u': figures(12) };

		let auctions = auctionsOf([withdraw(first, '180'), second]);
		const one = select({
			auctions,
			fantraxPlayerId: 'p-one',
			withdrawnSeq: '180',
			rosters
		});
		expect(one.restored?.teamId).toBe('t-z');

		// Thread it exactly as `cascadeFor` does — the same `withBidCancelled`
		// the reducer will fold — so the second candidacy sees the first.
		auctions = {
			byPlayer: {
				...auctions.byPlayer,
				'p-one': withBidCancelled(first, '180', {
					seq: '',
					causeFantraxPlayerId: 'p-cause',
					causePlayerName: 'Dex Brooks',
					restoration: one.restored
				}),
				'p-two': withdraw(second, '190')
			}
		};
		const two = select({
			auctions,
			fantraxPlayerId: 'p-two',
			withdrawnSeq: '190',
			rosters
		});

		// Z now leads `p-one` again, so a second lead is two projected additions
		// against an allowance of `1 + 1` — which passes.
		expect(two.restored?.teamId).toBe('t-z');

		// **And here is the accumulation, isolated.** Give Z a third Auction it
		// already leads and the arithmetic tips: WITHOUT the first restoration
		// counted, Z holds two projected additions against an allowance of two
		// and passes; WITH it, three against two, so it is skipped and Team Y
		// below is restored instead. The only difference between the two calls
		// below is whether `p-one` names Z as its restored leader.
		const third = standardAuction('p-three', [bidBy('90', 't-z', 2_000_000)]);
		const unrestored = select({
			auctions: {
				byPlayer: {
					'p-one': withdraw(first, '180'),
					'p-two': withdraw(second, '190'),
					'p-three': third
				}
			},
			fantraxPlayerId: 'p-two',
			withdrawnSeq: '190',
			rosters
		});
		expect(unrestored.restored?.teamId).toBe('t-z');

		const accumulated = select({
			auctions: { byPlayer: { ...auctions.byPlayer, 'p-three': third } },
			fantraxPlayerId: 'p-two',
			withdrawnSeq: '190',
			rosters
		});
		expect(accumulated.restored?.teamId).toBe('t-y');
	});

	it('skips the winner when it is its own next-highest — no special case', () => {
		// Team U holds an older, outbid Bid on the same Auction. It just
		// failed the same `slots` gate, so it fails it again and falls out of
		// re-validation by the ordinary route.
		const carter = standardAuction('p-carter', [
			bidBy('100', 't-u', 1_800_000),
			bidBy('190', 't-u', 2_000_000)
		]);
		const outcome = select({
			auctions: auctionsOf([withdraw(carter, '190')]),
			fantraxPlayerId: 'p-carter',
			withdrawnSeq: '190',
			// The POST-CLOSE figures `cascadeFor` substitutes for the winner.
			rosters: { 't-u': figures(12) }
		});

		expect(outcome.restored).toBeNull();
	});

	it('answers null inside a Minimum-Bid Contention — the lead is a fold artifact', () => {
		// A cancelled contention entry is not restored: every Contender holds
		// the identical flat $1,000,000, so the artifact moving to the earliest
		// surviving join changes nobody's position, price or capital.
		// `withBidCancelled` moves it; re-validation does not apply.
		const lottery: Auction = {
			fantraxPlayerId: 'p-lot',
			contention: 'minimum_bid',
			leadingBid: bidBy('200', 't-u', 1_000_000),
			closesAt: CLOSES,
			bids: [bidBy('200', 't-u', 1_000_000), bidBy('210', 't-v', 1_000_000)],
			contenders: [
				{ seq: '200', teamId: 't-u', teamName: 'Team t-u', managerId: 'm-t-u' },
				{ seq: '210', teamId: 't-v', teamName: 'Team t-v', managerId: 'm-t-v' }
			],
			seedHash: null,
			seed: null
		};
		const outcome = select({
			auctions: auctionsOf([withdraw(lottery, '200')]),
			fantraxPlayerId: 'p-lot',
			withdrawnSeq: '200',
			rosters: { 't-v': figures(4), 't-u': figures(12) }
		});

		expect(outcome.restored).toBeNull();
	});

	it('answers null for an Auction that is not in the fold at all', () => {
		const outcome = select({
			auctions: { byPlayer: {} },
			fantraxPlayerId: 'p-missing',
			withdrawnSeq: '190',
			rosters: {}
		});

		expect(outcome.restored).toBeNull();
	});

	it('skips a candidate Team the batched roster read did not cover', () => {
		// `null` figures are a state, not a throw: refusing to restore is the
		// conservative answer and the same one a failed gate gives.
		const carter = standardAuction('p-carter', [
			bidBy('150', 't-v', 1_500_000),
			bidBy('190', 't-u', 2_000_000)
		]);
		const outcome = select({
			auctions: auctionsOf([withdraw(carter, '190')]),
			fantraxPlayerId: 'p-carter',
			withdrawnSeq: '190',
			rosters: {}
		});

		expect(outcome.restored).toBeNull();
	});

	it('breaks a tie on the EARLIEST seq, as highestStandingBid does', () => {
		// Two equal amounts: a Bid takes the lead only by being strictly
		// higher, so the earliest of them is the one that was leading and the
		// one that leads again. A second expression of "highest surviving"
		// could disagree with `highestStandingBid` about exactly this.
		const carter = standardAuction('p-carter', [
			bidBy('130', 't-v', 1_500_000),
			bidBy('140', 't-w', 1_500_000),
			bidBy('190', 't-u', 2_000_000)
		]);
		const outcome = select({
			auctions: auctionsOf([withdraw(carter, '190')]),
			fantraxPlayerId: 'p-carter',
			withdrawnSeq: '190',
			rosters: { 't-v': figures(6), 't-w': figures(6), 't-u': figures(12) }
		});

		expect(outcome.restored?.seq).toBe('130');
		expect(outcome.restored?.teamId).toBe('t-v');
	});

	it('excludes the withdrawn Bid even when the caller has not marked it', () => {
		// The `erase` axis hands over a fold the withdrawal is already gone
		// from; the explicit `seq` test is what makes a caller who has not yet
		// applied it safe too. Without it the cancelled Bid would restore
		// itself.
		const carter = standardAuction('p-carter', [
			bidBy('150', 't-v', 1_500_000),
			bidBy('190', 't-u', 2_000_000)
		]);
		const outcome = selectRestoration({
			fantraxPlayerId: 'p-carter',
			withdrawnSeq: '190',
			basis: {
				// UNWITHDRAWN — Team U's $2,000,000 is still leading here.
				auctions: auctionsOf([carter]),
				rosterFiguresFor: (teamId: string) =>
					teamId === 't-v' ? figures(8) : teamId === 't-u' ? figures(4) : null,
				isMinorLeagueEligible: () => false,
				playerNameFor: (playerId: string) => `Player ${playerId}`,
				now: NOW
			},
			axes: CANCELLATION_AXES
		});

		// Team U would pass on those figures; it is excluded by `seq`.
		expect(outcome.restored?.teamId).toBe('t-v');
	});
});

describe('selectRestoration — the three axes, which is why there is one selector', () => {
	const carter = standardAuction('p-carter', [
		bidBy('150', 't-v', 1_500_000),
		bidBy('190', 't-u', 2_000_000)
	]);
	const rosters = { 't-v': figures(8), 't-u': figures(12) };

	it('answers FR-40 retain/leave/keep: the clocks are not touched', () => {
		expect(CANCELLATION_AXES).toEqual({
			withdrawnBid: 'retain',
			auctionClock: 'leave',
			leagueClockReset: 'keep'
		});
		const outcome = select({
			auctions: auctionsOf([withdraw(carter, '190')]),
			fantraxPlayerId: 'p-carter',
			withdrawnSeq: '190',
			rosters
		});

		expect(outcome.resetsAuctionClock).toBe(false);
		expect(outcome.removesLeagueClockReset).toBe(false);
	});

	it('answers a void’s erase/restore/remove with the SAME selection', () => {
		// Story 7.2 consumes this function and writes no selector of its own:
		// the Bid it picks is identical and only the two clock instructions
		// differ, which is the whole of AR-36.
		const outcome = select({
			auctions: auctionsOf([withdraw(carter, '190')]),
			fantraxPlayerId: 'p-carter',
			withdrawnSeq: '190',
			rosters,
			axes: { withdrawnBid: 'erase', auctionClock: 'restore', leagueClockReset: 'remove' }
		});

		expect(outcome.restored?.teamId).toBe('t-v');
		expect(outcome.resetsAuctionClock).toBe(true);
		expect(outcome.removesLeagueClockReset).toBe(true);
	});

	it('is frozen, so no caller can change what a cancellation means', () => {
		expect(Object.isFrozen(CANCELLATION_AXES)).toBe(true);
	});
});
