/**
 * Your Positions' pure core, driven directly (Story 4.4).
 *
 * Every row of the spec's I/O matrix that is decidable without a database is
 * decided here, through `src/lib/core/positions.ts` and nothing else: each of
 * the five groups, the three re-entry outcomes, the dissolved-contention
 * placement, both Nomination Slot states, the empty screen, and the group
 * order asserted as a literal sequence.
 *
 * Nothing here mocks anything. The module takes folds, a `Map` and a callback
 * and returns data — which is the whole reason the wording lives in the core
 * rather than in a `.svelte` file no test in this repository can render.
 *
 * The re-entry answers are computed through the REAL `reEntryFor`, over a real
 * `BidState` assembled by the real `bidStateFor`/`teamMoneyStateFor` — the
 * same narrowing `server/bidding.ts` uses under the lock. A stubbed answer
 * would prove the shape and nothing about the arithmetic, and the arithmetic
 * is the whole point of the group.
 */

import { describe, expect, it } from 'vitest';

import {
	EMPTY_POSITIONS_HEADING,
	EMPTY_POSITIONS_STATEMENT,
	GROUP_HEADINGS,
	POSITIONS_GROUP_ORDER,
	emptyPositionsSentence,
	leadCommitmentSentence,
	nominationSlotSentence,
	positionsFor,
	reEntryFor,
	reEntrySentence,
	wonCardSentence
} from '../src/lib/core/positions.ts';
import type { ReEntry } from '../src/lib/core/positions.ts';
import { AUCTION_PATH_PREFIX } from '../src/lib/core/auction-link.ts';
import { VIEWER_STATE_ICONS, VIEWER_STATE_LABELS } from '../src/lib/core/board.ts';
import type { BoardMetadata } from '../src/lib/core/board.ts';
import { MINIMUM_BID, SALARY_CAP } from '../src/lib/core/constants.ts';
import { parseMoney } from '../src/lib/core/money.ts';
import {
	BID_CANCELLED_EVENT,
	BID_PLACED_EVENT,
	INITIAL_AUCTIONS,
	MINIMUM_LOTTERY_LABEL,
	auctionForPlayer,
	auctionsReducer
} from '../src/lib/core/projection/auctions.ts';
import { INITIAL_CONTRACTS, contractsReducer } from '../src/lib/core/projection/contracts.ts';
import { fold } from '../src/lib/core/projection/fold.ts';
import {
	AUCTION_CLOSED_EVENT,
	INITIAL_NOMINATIONS,
	NOMINATION_PLACED_EVENT,
	nominationForPlayer,
	nominationsReducer
} from '../src/lib/core/projection/nominations.ts';
import { bidStateFor, teamMoneyStateFor } from '../src/lib/core/rules/bidding.ts';
import type { AppendedEvent } from '../src/lib/core/types.ts';

const NOW = '2026-08-27T12:00:00.000Z';
const CLOSES = '2026-08-28T00:00:00.000Z';
const VIEWER = 't-viewer';
const RIVAL = 't-rival';

let nextSeq = 0;

function event(type: string, payload: Record<string, unknown>, occurredAt: string): AppendedEvent {
	nextSeq += 1;
	return {
		seq: String(nextSeq),
		type,
		payload,
		occurredAt,
		managerId: String(payload['managerId'] ?? 'm-x'),
		teamId: String(payload['teamId'] ?? 't-x'),
		schemaVersion: 1,
		coreVersion: 'test',
		deviceClass: null
	} as unknown as AppendedEvent;
}

function nominated(
	fantraxPlayerId: string,
	playerName: string,
	teamId: string,
	occurredAt = '2026-08-26T00:00:00.000Z'
): AppendedEvent {
	return event(
		NOMINATION_PLACED_EVENT,
		{
			fantraxPlayerId,
			playerName,
			teamId,
			teamName: `Team ${teamId}`,
			managerId: 'm-nom'
		},
		occurredAt
	);
}

function bid(
	fantraxPlayerId: string,
	teamId: string,
	amount: number,
	occurredAt: string,
	closesAt: string = CLOSES,
	managerId = `m-${teamId}`
): AppendedEvent {
	return event(
		BID_PLACED_EVENT,
		{
			fantraxPlayerId,
			teamId,
			teamName: `Team ${teamId}`,
			managerId,
			amount,
			closesAt
		},
		occurredAt
	);
}

function closed(
	fantraxPlayerId: string,
	playerName: string,
	teamId: string,
	winningAmount: number,
	capHit: number,
	placement: 'active_bench' | 'minor_league',
	closedAt: string
): AppendedEvent {
	return event(
		AUCTION_CLOSED_EVENT,
		{
			fantraxPlayerId,
			playerName,
			teamId,
			teamName: `Team ${teamId}`,
			winningAmount,
			capHit,
			placement,
			closedAt,
			managerId: 'm-close'
		},
		closedAt
	);
}

function project(events: readonly AppendedEvent[]) {
	return {
		nominations: fold(INITIAL_NOMINATIONS, events, nominationsReducer),
		auctions: fold(INITIAL_AUCTIONS, events, auctionsReducer),
		contracts: fold(INITIAL_CONTRACTS, events, contractsReducer)
	};
}

function metadataFor(entries: Record<string, BoardMetadata>): Map<string, BoardMetadata> {
	return new Map(Object.entries(entries));
}

/**
 * The re-entry answer, assembled exactly as `server/positions.ts` assembles it
 * — `bidStateFor(auction, teamMoneyStateFor({...}), eligible, phase)`, then
 * `reEntryFor`. The roster figures are the arguments a test varies; everything
 * else is the production narrowing.
 */
function answerer(
	projections: ReturnType<typeof project>,
	viewerTeamId: string | null,
	roster: {
		capSpace: number;
		rosterCount: number;
		minorLeagueOccupied: number;
	} = {
		capSpace: Number(SALARY_CAP),
		rosterCount: 0,
		minorLeagueOccupied: 0
	},
	eligiblePlayers: readonly string[] = []
): (fantraxPlayerId: string) => ReEntry {
	return (fantraxPlayerId: string) => {
		const auction = auctionForPlayer(projections.auctions, fantraxPlayerId);
		const state = bidStateFor(
			auction,
			viewerTeamId === null
				? null
				: teamMoneyStateFor({
						teamId: viewerTeamId,
						fantraxPlayerId,
						capSpace: parseMoney(roster.capSpace),
						rosterCount: roster.rosterCount,
						minorLeagueOccupied: roster.minorLeagueOccupied,
						auctions: projections.auctions,
						isMinorLeagueEligible: (playerId) => eligiblePlayers.includes(playerId),
						playerNameFor: (playerId) =>
							nominationForPlayer(projections.nominations, playerId)?.playerName ?? playerId
					}),
			eligiblePlayers.includes(fantraxPlayerId),
			'Auction'
		);
		return reEntryFor({ state, fantraxPlayerId, viewerTeamId, now: NOW });
	};
}

function build(
	events: readonly AppendedEvent[],
	options: {
		viewerTeamId?: string | null;
		metadata?: Record<string, BoardMetadata>;
		roster?: {
			capSpace: number;
			rosterCount: number;
			minorLeagueOccupied: number;
		};
		eligible?: readonly string[];
	} = {}
) {
	const projections = project(events);
	const viewerTeamId = options.viewerTeamId === undefined ? VIEWER : options.viewerTeamId;
	return positionsFor({
		nominations: projections.nominations,
		auctions: projections.auctions,
		contracts: projections.contracts,
		metadata: metadataFor(options.metadata ?? {}),
		viewerTeamId,
		reEntryFor: answerer(projections, viewerTeamId, options.roster, options.eligible ?? [])
	});
}

// --- The order -------------------------------------------------------------

describe('the five groups, in the wake-up’s order and no other', () => {
	it('declares the order as a literal sequence', () => {
		// Asserted as a literal rather than derived from anything, because the
		// order IS the answer to "what happened while I slept, and what needs
		// me now" — a test that rebuilt it from the module would agree with
		// whatever the module said.
		expect([...POSITIONS_GROUP_ORDER]).toEqual([
			'won',
			'outbid',
			'you_lead',
			'contending',
			'nomination_slot'
		]);
	});

	it('is frozen, so nothing can splice a group out of the reading order', () => {
		expect(Object.isFrozen(POSITIONS_GROUP_ORDER)).toBe(true);
	});

	it('names every group, and reuses the board’s own words for the two states it shares', () => {
		for (const group of POSITIONS_GROUP_ORDER) {
			expect(GROUP_HEADINGS[group], group).not.toBe('');
		}
		// A heading that said "You're winning" over cards chipped "You lead"
		// would be two names for one state across two surfaces.
		expect(GROUP_HEADINGS.you_lead).toBe(VIEWER_STATE_LABELS.you_lead);
		expect(GROUP_HEADINGS.outbid).toBe(VIEWER_STATE_LABELS.outbid);
	});

	it('calls the first group Won and never "won while you slept"', () => {
		// Nothing in this codebase records when a Manager last looked, so a
		// "while you slept" framing would be a storage decision wearing a
		// presentation costume. Logged in deferred-work.md.
		expect(GROUP_HEADINGS.won).toBe('Won');
		expect(GROUP_HEADINGS.won.toLowerCase()).not.toContain('slept');
	});
});

// --- Won -------------------------------------------------------------------

describe('Won — every Auction the viewer’s Team has won this phase', () => {
	const events = [
		nominated('p-1', 'Jaden McDaniels', RIVAL),
		closed('p-1', 'Jaden McDaniels', VIEWER, 11_000_000, 11_000_000, 'active_bench', CLOSES)
	];

	it('names the Player, the amount, the placement and the Cap Hit', () => {
		const positions = build(events, {
			metadata: {
				'p-1': {
					playerName: 'Jaden McDaniels',
					nbaTeam: 'MIN',
					positions: 'F'
				}
			}
		});
		expect(positions.won).toHaveLength(1);
		const card = positions.won[0];
		expect(card?.playerName).toBe('Jaden McDaniels');
		// `NBA · POS` and nothing more: `free_agent_players` carries no salary
		// and no contract-years column, and `contractYears` is typed `null`.
		expect(card?.metadata).toBe('MIN · F');
		expect(card?.winningAmountLabel).toBe('$11.0M');
		expect(card?.placement).toBe('active_bench');
		expect(card?.closedAt).toBe(CLOSES);
		// **No link.** A close DELETES the Player from `auctionsReducer`, and
		// the Auction route 404s on that null read, so `auctionPathFor` on a
		// won Player is a link to a refusal — in the FIRST group on the
		// landing page. A review finding; `deferred-work.md`'s spec-3-6 entry
		// owns the closed-Auction surface that will restore it.
		expect(card?.href).toBeNull();
	});

	it('states the placement AND the Cap Hit, because they are independent (AD-23)', () => {
		// A minors placement carries a $0 Cap Hit while the winning amount
		// stands unchanged, so a card stating only the amount would let a $0
		// charge read as an $8.5M one.
		const minors = build(
			[
				nominated('p-2', 'Santi Aldama', RIVAL),
				closed('p-2', 'Santi Aldama', VIEWER, 8_500_000, 0, 'minor_league', CLOSES)
			],
			{}
		);
		const card = minors.won[0];
		expect(card?.winningAmountLabel).toBe('$8.5M');
		expect(card?.sentence).toBe(wonCardSentence('minor_league', parseMoney(0)));
		expect(card?.sentence).toContain('Minor League Slot');
		expect(card?.sentence).toContain('$0.0M');
	});

	it('orders newest closedAt first, tie-broken totally on the Player id', () => {
		const positions = build([
			closed('p-b', 'B', VIEWER, 1_000_000, 1_000_000, 'active_bench', '2026-08-27T00:00:00.000Z'),
			closed('p-a', 'A', VIEWER, 1_000_000, 1_000_000, 'active_bench', '2026-08-27T00:00:00.000Z'),
			closed('p-c', 'C', VIEWER, 1_000_000, 1_000_000, 'active_bench', '2026-08-28T00:00:00.000Z')
		]);
		// Newest first, then the total tie-break — a comparator returning 0 on
		// the shared instant would leave the two free to reorder between two
		// renders of the same state.
		expect(positions.won.map((card) => card.fantraxPlayerId)).toEqual(['p-c', 'p-a', 'p-b']);
	});

	it('carries no other Team’s contracts', () => {
		const positions = build([
			closed('p-1', 'Theirs', RIVAL, 5_000_000, 5_000_000, 'active_bench', CLOSES)
		]);
		expect(positions.won).toEqual([]);
	});

	it('states no celebration', () => {
		const positions = build(events);
		expect(positions.won[0]?.sentence).not.toMatch(/congratul|well done|nice|!/i);
	});
});

// --- Outbid and the re-entry answer ---------------------------------------

describe('Outbid — the card answers whether a re-entry is legal before it is asked', () => {
	/** The viewer bid, then the rival raised: the viewer is outbid. */
	const outbidLog = [
		nominated('p-1', 'Jalen Duren', RIVAL),
		bid('p-1', VIEWER, 14_000_000, '2026-08-26T01:00:00.000Z'),
		bid('p-1', RIVAL, 14_500_000, '2026-08-26T02:00:00.000Z')
	];

	it('renders the viewer’s own last amount beside the current price', () => {
		const positions = build(outbidLog);
		expect(positions.outbid).toHaveLength(1);
		const card = positions.outbid[0];
		expect(card?.priceLabel).toBe('$14.5M');
		expect(card?.yourBidLabel).toBe('$14.0M');
		expect(card?.leadingTeamId).toBe(RIVAL);
		expect(card?.stateLabel).toBe(VIEWER_STATE_LABELS.outbid);
		expect(card?.stateIcon).toBe(VIEWER_STATE_ICONS.outbid);
	});

	it('states the next legal Bid as within reach when re-entry is legal', () => {
		// Cap Space is the whole Salary Cap and the roster is empty, so
		// $15.0M clears both gates.
		const positions = build(outbidLog);
		const reEntry = positions.outbid[0]?.reEntry;
		expect(reEntry?.blocked).toBe(false);
		expect(reEntry?.refusingGates).toEqual([]);
		// The minimum raise over a $14.5M high.
		expect(reEntry?.nextLegalBid).toBe(15_000_000);
		expect(reEntry?.nextLegalBidLabel).toBe('$15.0M');
		expect(reEntry?.sentence).toContain('$15.0M');
		// No amount is SUGGESTED — the sentence states the Auction's own
		// threshold and stops. Anything past it would be advice.
		expect(reEntry?.sentence).not.toMatch(/you should|we recommend|try|suggest/i);
	});

	it('names the next legal Bid AND the Maximum Bid when the cap refuses', () => {
		// The matrix row: refused on cap, both figures named in one sentence.
		// $14.0M of Cap Space against a $15.0M next legal Bid, with a Roster
		// Reserve for the eleven remaining Active/Bench Slots on top.
		const positions = build(outbidLog, {
			roster: { capSpace: 14_000_000, rosterCount: 0, minorLeagueOccupied: 0 }
		});
		const reEntry = positions.outbid[0]?.reEntry;
		expect(reEntry?.blocked).toBe(true);
		expect(reEntry?.refusingGates).toContain('cap');
		expect(reEntry?.maximumBidLabel).not.toBeNull();
		// Both figures, in the one sentence the card prints.
		expect(reEntry?.sentence).toContain('$15.0M');
		expect(reEntry?.sentence).toContain('Maximum Bid');
		expect(reEntry?.sentence).toContain(String(reEntry?.maximumBidLabel));
	});

	it('states the capacity refusal in its OWN words, with the cap outcome beside it', () => {
		// AD-7: reporting a capacity refusal as a cap refusal is a defect. A
		// full Active/Bench roster refuses on `slots` alone — the cap gate is
		// untouched and must still be reported.
		const positions = build(outbidLog, {
			roster: {
				capSpace: Number(SALARY_CAP),
				rosterCount: 12,
				minorLeagueOccupied: 0
			}
		});
		const reEntry = positions.outbid[0]?.reEntry;
		expect(reEntry?.blocked).toBe(true);
		expect(reEntry?.refusingGates).toContain('slots');
		// Its own words: counts and a Roster Capacity, no money at all.
		expect(reEntry?.sentence).toContain('Roster Count');
		expect(reEntry?.sentence).toContain('Roster Capacity');
		// And the cap gate's outcome is stated BESIDE it rather than instead
		// of it, which is what makes two rows unreadable as one.
		const gates = reEntry?.gateRows ?? [];
		expect(gates.map((row) => row.gate)).toEqual(['cap', 'slots']);
		const cap = gates.find((row) => row.gate === 'cap');
		expect(cap?.passed).toBe(true);
		expect(cap?.chip).toContain('Passed');
		expect(cap?.figure).not.toBe('');
	});

	it('reports BOTH gates on every card, refused and passed alike', () => {
		// Structural rather than conditional: the rows are built by filtering
		// the declared gate report, so no template decides what to show.
		for (const roster of [
			{ capSpace: Number(SALARY_CAP), rosterCount: 0, minorLeagueOccupied: 0 },
			{ capSpace: 0, rosterCount: 12, minorLeagueOccupied: 0 }
		]) {
			const positions = build(outbidLog, { roster });
			const gates = positions.outbid[0]?.reEntry.gateRows ?? [];
			expect(gates.map((row) => row.gate)).toEqual(['cap', 'slots']);
			for (const row of gates) expect(row.figure, row.gate).not.toBe('');
		}
	});

	it('reports the gate that ACTUALLY refused, beside the two that always show', () => {
		// A review finding. `bidControlState` blocks on any of the nine
		// `PLACE_BID_GATES`, but the card used to report `cap` and `slots`
		// alone — so an Auction that has passed its close renders "You cannot
		// re-enter at $15.0M" directly above `Cap · Passed` and
		// `Slots · Passed`: every row on the card agreeing the Bid is fine,
		// over a sentence saying it is not. The sentence was right, but a
		// Manager reading two passing rows under a refusal has been handed a
		// card that argues with itself, on the one surface built to answer
		// before being asked.
		const expired = '2026-08-27T00:00:00.000Z'; // twelve hours before NOW
		const positions = build([
			nominated('p-1', 'Jalen Duren', RIVAL),
			bid('p-1', VIEWER, 14_000_000, '2026-08-26T01:00:00.000Z', expired),
			bid('p-1', RIVAL, 14_500_000, '2026-08-26T02:00:00.000Z', expired)
		]);
		const reEntry = positions.outbid[0]?.reEntry;
		expect(reEntry?.blocked).toBe(true);
		expect(reEntry?.refusingGates).toContain('expiry');

		const gates = reEntry?.gateRows ?? [];
		// The refusing gate is ON the card...
		expect(gates.map((row) => row.gate)).toContain('expiry');
		expect(gates.find((row) => row.gate === 'expiry')?.passed).toBe(false);
		// ...and the AD-7 floor is untouched: both money and slots are still
		// stated, each with its own arithmetic, even though neither refused.
		const cap = gates.find((row) => row.gate === 'cap');
		const slots = gates.find((row) => row.gate === 'slots');
		expect(cap?.passed).toBe(true);
		expect(slots?.passed).toBe(true);
		for (const row of gates) expect(row.figure, row.gate).not.toBe('');
		// `PLACE_BID_GATES` order throughout, never the order they refused in.
		expect(gates.map((row) => row.gate)).toEqual(['expiry', 'cap', 'slots']);
		// No card can now say "cannot re-enter" with every row reading Passed.
		expect(gates.some((row) => !row.passed)).toBe(true);
	});

	it('orders by close instant, tie-broken totally on the Player id', () => {
		const positions = build([
			nominated('p-b', 'B', RIVAL),
			bid('p-b', VIEWER, 1_500_000, '2026-08-26T01:00:00.000Z', CLOSES),
			bid('p-b', RIVAL, 2_000_000, '2026-08-26T02:00:00.000Z', CLOSES),
			nominated('p-a', 'A', RIVAL),
			bid('p-a', VIEWER, 1_500_000, '2026-08-26T01:00:00.000Z', CLOSES),
			bid('p-a', RIVAL, 2_000_000, '2026-08-26T02:00:00.000Z', CLOSES)
		]);
		expect(positions.outbid.map((card) => card.fantraxPlayerId)).toEqual(['p-a', 'p-b']);
	});
});

describe('reEntrySentence — the two shapes and no third', () => {
	it('states the amount and its reach when nothing blocks', () => {
		const sentence = reEntrySentence({
			nextLegalBid: 15_000_000,
			nextLegalBidLabel: '$15.0M',
			blocked: false,
			refusingGates: [],
			gateRows: [],
			maximumBidLabel: '$20.0M',
			delta: 'unused'
		});
		expect(sentence).toContain('$15.0M');
		// It does NOT quote the Maximum Bid on a legal card: the strip owns
		// the team-level figure and a card states only the per-Auction
		// consequence.
		expect(sentence).not.toContain('$20.0M');
	});

	it('leads with the refusal and then the core’s own delta, unframed', () => {
		const sentence = reEntrySentence({
			nextLegalBid: 15_000_000,
			nextLegalBidLabel: '$15.0M',
			blocked: true,
			refusingGates: ['cap'],
			gateRows: [],
			maximumBidLabel: '$14.0M',
			delta: 'the arithmetic goes here.'
		});
		expect(sentence).toBe('You cannot re-enter at $15.0M. the arithmetic goes here.');
		// Never the FRAMED form: nothing was submitted from a card, so "No Bid
		// was placed" and "Nothing was written" would state two things that
		// did not happen.
		expect(sentence).not.toContain('No Bid was placed');
		expect(sentence).not.toContain('Nothing was written');
	});
});

// --- You lead --------------------------------------------------------------

describe('You lead — the price, the close, and what the lead commits', () => {
	it('states the commitment and the release, per Auction and never per Team', () => {
		const positions = build([
			nominated('p-1', 'Isaiah Hartenstein', RIVAL),
			bid('p-1', VIEWER, 9_000_000, '2026-08-26T01:00:00.000Z')
		]);
		expect(positions.youLead).toHaveLength(1);
		const card = positions.youLead[0];
		expect(card?.priceLabel).toBe('$9.0M');
		expect(card?.closesAt).toBe(CLOSES);
		expect(card?.stateLabel).toBe(VIEWER_STATE_LABELS.you_lead);
		expect(card?.stateIcon).toBe(VIEWER_STATE_ICONS.you_lead);
		expect(card?.commitmentSentence).toBe(leadCommitmentSentence(parseMoney(9_000_000)));
		expect(card?.commitmentSentence).toContain('$9.0M');
		// FR-14's other half: capital is released the instant the Team ceases
		// to lead, not at close.
		expect(card?.commitmentSentence).toContain('released');
		// No per-Team Maximum Bid on a card — the strip owns that figure.
		expect(card?.commitmentSentence).not.toContain('Maximum Bid');
	});

	it('appears in no other group', () => {
		const positions = build([
			nominated('p-1', 'Isaiah Hartenstein', RIVAL),
			bid('p-1', VIEWER, 9_000_000, '2026-08-26T01:00:00.000Z')
		]);
		expect(positions.outbid).toEqual([]);
		expect(positions.contending).toEqual([]);
	});
});

// --- Contending ------------------------------------------------------------

describe('Contending — a live Minimum-Bid Contention the viewer has joined', () => {
	const lottery = [
		nominated('p-1', 'Naz Reid', RIVAL),
		bid('p-1', RIVAL, Number(MINIMUM_BID), '2026-08-26T01:00:00.000Z'),
		bid('p-1', VIEWER, Number(MINIMUM_BID), '2026-08-26T02:00:00.000Z')
	];

	it('carries the lottery label, the Contender count and the unmoved-clock statement', () => {
		const positions = build(lottery);
		expect(positions.contending).toHaveLength(1);
		const card = positions.contending[0];
		expect(card?.contention).toBe('minimum_bid');
		// The contention's card name from the fold that owns it, never
		// respelled — the same string the Bid Board card prints.
		expect(card?.contentionLabel).toBe(MINIMUM_LOTTERY_LABEL);
		expect(card?.stateLabel).toBe(VIEWER_STATE_LABELS.contender);
		expect(card?.stateIcon).toBe(VIEWER_STATE_ICONS.contender);
		expect(card?.contenderCount).toBe(2);
		expect(card?.contenderCountSentence).toBe('2 Contenders so far.');
		expect(card?.clockSentence).toContain('will not reset on a join');
	});

	it('is Contending and never Outbid — a Contender is waiting on a draw', () => {
		// The viewer holds a Bid at exactly MINIMUM_BID that is not the
		// leading one, so an ungated outbid test would match it — and
		// `attention` marks Outbid and nothing else in this product.
		const positions = build(lottery);
		expect(positions.outbid).toEqual([]);
		expect(positions.youLead).toEqual([]);
	});
});

describe('a DISSOLVED contention places the viewer under You lead or Outbid, never Contending', () => {
	// `contenders` OUTLIVES the contention: the reducer never clears the list,
	// so a dissolved lottery is `standard` with every former joiner still in
	// it. `board.ts:385-408`'s gate is the reasoning this reuses.
	const base = [
		nominated('p-1', 'Naz Reid', RIVAL),
		bid('p-1', RIVAL, Number(MINIMUM_BID), '2026-08-26T01:00:00.000Z'),
		bid('p-1', VIEWER, Number(MINIMUM_BID), '2026-08-26T02:00:00.000Z')
	];

	it('puts the Team whose raise dissolved it under You lead', () => {
		const positions = build([...base, bid('p-1', VIEWER, 5_000_000, '2026-08-26T03:00:00.000Z')]);
		expect(positions.contending).toEqual([]);
		expect(positions.youLead.map((card) => card.fantraxPlayerId)).toEqual(['p-1']);
		expect(positions.outbid).toEqual([]);
	});

	it('puts the Team that raise outbid under Outbid', () => {
		const positions = build([...base, bid('p-1', RIVAL, 5_000_000, '2026-08-26T03:00:00.000Z')]);
		expect(positions.contending).toEqual([]);
		expect(positions.youLead).toEqual([]);
		expect(positions.outbid.map((card) => card.fantraxPlayerId)).toEqual(['p-1']);
	});
});

// --- Nomination Slot -------------------------------------------------------

describe('the Nomination Slot, free and used', () => {
	it('states the slot is free, and that nominating does not oblige a Bid', () => {
		const positions = build([]);
		expect(positions.nominationSlot.used).toBe(false);
		expect(positions.nominationSlot.fantraxPlayerId).toBeNull();
		expect(positions.nominationSlot.href).toBeNull();
		expect(positions.nominationSlot.sentence).toBe(nominationSlotSentence(null));
		expect(positions.nominationSlot.sentence).toContain('free');
		expect(positions.nominationSlot.sentence).toContain('does not oblige');
	});

	it('names the Player nominated and links to that Auction when the slot is spent', () => {
		const positions = build([nominated('p-9', 'Naz Reid', VIEWER)], {
			metadata: {
				'p-9': { playerName: 'Naz Reid', nbaTeam: 'MIN', positions: 'F/C' }
			}
		});
		expect(positions.nominationSlot.used).toBe(true);
		expect(positions.nominationSlot.playerName).toBe('Naz Reid');
		expect(positions.nominationSlot.href).toBe(`${AUCTION_PATH_PREFIX}p-9`);
		expect(positions.nominationSlot.sentence).toContain('Naz Reid');
	});
});

// --- The empty screen ------------------------------------------------------

describe('the designed empty screen', () => {
	it('is empty when the viewer holds no won, no lead, no outbid and no contention', () => {
		const positions = build([nominated('p-1', 'Somebody Else', RIVAL)]);
		expect(positions.empty).toBe(true);
		// One Auction is on the board, and the screen states the count.
		expect(positions.openAuctionCount).toBe(1);
		expect(emptyPositionsSentence(true, positions.openAuctionCount)).toContain(
			'One Auction is open'
		);
	});

	it('is NOT emptied by a free Nomination Slot — the slot is what the screen points at', () => {
		const positions = build([nominated('p-1', 'Somebody', RIVAL)]);
		expect(positions.nominationSlot.used).toBe(false);
		expect(positions.empty).toBe(true);
	});

	it('is not empty once anything is held, including a won Auction alone', () => {
		const positions = build([
			closed('p-1', 'Won', VIEWER, 1_000_000, 1_000_000, 'active_bench', CLOSES)
		]);
		expect(positions.empty).toBe(false);
	});

	it('states the board’s count in the singular and the plural, and for zero', () => {
		// "1 Auctions are open" is the kind of sentence that tells a Manager at
		// 4am that nobody proof-read the thing they are being asked to trust.
		expect(emptyPositionsSentence(true, 0)).toContain('No Auctions are open');
		expect(emptyPositionsSentence(true, 1)).toContain('One Auction is open');
		expect(emptyPositionsSentence(true, 14)).toContain('14 Auctions are open');
		expect(emptyPositionsSentence(false, 3)).toContain('already spent');
	});

	it('words the screen without an urgency device', () => {
		expect(EMPTY_POSITIONS_HEADING).not.toMatch(/!|hurry|now/i);
		expect(EMPTY_POSITIONS_STATEMENT).not.toMatch(/ending soon|hurry|should/i);
	});
});

// --- A viewer bound to no Team --------------------------------------------

describe('a viewer bound to no Team', () => {
	it('renders no group at all rather than a group against a null Team', () => {
		// The route refuses such a request with the guard's 403 before this is
		// reached; a total function must still answer, and the honest answer is
		// that a viewer with no Team holds no positions.
		const positions = build([nominated('p-1', 'Somebody', RIVAL)], {
			viewerTeamId: null
		});
		expect(positions.viewerTeamId).toBeNull();
		expect(positions.won).toEqual([]);
		expect(positions.outbid).toEqual([]);
		expect(positions.youLead).toEqual([]);
		expect(positions.contending).toEqual([]);
		expect(positions.nominationSlot.used).toBe(false);
		expect(positions.empty).toBe(true);
	});

	it('refuses re-entry as unbound_actor when asked directly, with no gate arithmetic', () => {
		const projections = project([
			nominated('p-1', 'Jalen Duren', RIVAL),
			bid('p-1', RIVAL, 14_500_000, '2026-08-26T02:00:00.000Z')
		]);
		const answer = answerer(projections, null)('p-1');
		expect(answer.blocked).toBe(true);
		expect(answer.gateRows).toEqual([]);
		expect(answer.maximumBidLabel).toBeNull();
		expect(answer.sentence).toContain('not bound to a Team');
	});
});


// --- A leaderless Auction (Story 10.3, FR-40) -----------------------------

/** A `BidCancelled` naming one Bid's `seq`, as `rules/close.ts` writes it. */
function cancelledBid(
	fantraxPlayerId: string,
	cancelledSeq: string,
	teamId: string,
	amount: number
): AppendedEvent {
	return event(
		BID_CANCELLED_EVENT,
		{
			fantraxPlayerId,
			playerName: `Player ${fantraxPlayerId}`,
			cancelledSeq,
			teamId,
			teamName: `Team ${teamId}`,
			managerId: `m-${teamId}`,
			amount,
			wasContentionEntry: false,
			causeFantraxPlayerId: 'p-cause',
			causePlayerName: 'Dex Brooks',
			causeTeamId: teamId,
			restoration: null
		},
		'2026-08-27T10:00:00.000Z'
	);
}

describe('a leaderless Auction holds no position — for EITHER Team (Story 10.3)', () => {
	/**
	 * The §10 example 31 shape, on this page: the viewer leads at $4,000,000
	 * over a rival's standing $2,000,000, and the viewer's Bid is then
	 * cancelled by a Close elsewhere. Nothing leads until Story 10.4 restores
	 * the rival, and every card in this module carries a price.
	 */
	function leaderlessLog() {
		nextSeq = 0;
		return [
			nominated('p-1', 'Ellis Carter', 't-nom'),
			bid('p-1', RIVAL, 2_000_000, '2026-08-26T09:00:00.000Z'),
			bid('p-1', VIEWER, 4_000_000, '2026-08-26T10:00:00.000Z'),
			// The viewer's own Bid — `seq` 3 — withdrawn.
			cancelledBid('p-1', '3', VIEWER, 4_000_000)
		];
	}

	it('leaves the fold leaderless with both Bids still standing in history', () => {
		// The premise, stated before the page is asked about it: this is the
		// state, not a state the test invented.
		const auctions = project(leaderlessLog()).auctions;
		const auction = auctionForPlayer(auctions, 'p-1');

		expect(auction?.leadingBid).toBeNull();
		expect(auction?.bids).toHaveLength(2);
		// The clock is untouched — a Bid survives, so nothing cleared it.
		expect(auction?.closesAt).toBe(CLOSES);
	});

	it('gives the cancelled ex-leader no card at all', () => {
		// The Team whose Bid was cancelled. It holds nothing here: there is no
		// price to state and no lead to report, and the board and the Auction
		// page are where it still sees the Auction meanwhile.
		const groups = build(leaderlessLog(), { viewerTeamId: VIEWER });

		expect(groups.youLead).toEqual([]);
		expect(groups.outbid).toEqual([]);
		expect(groups.contending).toEqual([]);
	});

	it('gives the rival whose own Bid still stands no card either', () => {
		// The other half, and the one that is easy to get wrong: the rival was
		// never cancelled and its $2,000,000 is still in the history — but
		// nothing leads, so there is no price for its card either, and it must
		// not be shown as leading a Player nobody currently leads.
		const groups = build(leaderlessLog(), { viewerTeamId: RIVAL });

		expect(groups.youLead).toEqual([]);
		expect(groups.outbid).toEqual([]);
		expect(groups.contending).toEqual([]);
	});

	it('comes back the moment a Bid leads again', () => {
		// The skip is about "no current price", not about the cancellation —
		// so a fresh Bid above the survivor restores the card. (Story 10.4
		// gets there the other way, by restoring the survivor itself.)
		const groups = build(
			[...leaderlessLog(), bid('p-1', VIEWER, 5_000_000, '2026-08-27T11:00:00.000Z')],
			{ viewerTeamId: VIEWER }
		);

		expect(groups.youLead.map((card) => card.fantraxPlayerId)).toEqual(['p-1']);
		expect(groups.youLead[0]?.price).toBe(5_000_000);
	});

	it('keeps a Contender’s card when a lottery’s artifact lead is cancelled', () => {
		// The exception that needs no branch. In a lottery the lead is a fold
		// artifact — every Contender holds the identical flat amount — so
		// cancelling the opener moves it to the next surviving join and the
		// contention goes on. The viewer joined and is still in it.
		nextSeq = 0;
		const groups = build(
			[
				nominated('p-lot', 'Ray Anderson', 't-nom'),
				bid('p-lot', RIVAL, MINIMUM_BID, '2026-08-26T09:00:00.000Z'),
				bid('p-lot', VIEWER, MINIMUM_BID, '2026-08-26T10:00:00.000Z'),
				// The OPENER's Bid, which is the fold's artifact leader.
				cancelledBid('p-lot', '2', RIVAL, MINIMUM_BID)
			],
			{ viewerTeamId: VIEWER }
		);

		expect(groups.contending.map((card) => card.fantraxPlayerId)).toEqual(['p-lot']);
		expect(groups.contending[0]?.price).toBe(MINIMUM_BID);
		expect(groups.contending[0]?.closesAt).toBe(CLOSES);
	});
});
