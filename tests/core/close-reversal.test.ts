/**
 * Reversing an Auction Close — the pure decision, the two folds that give the
 * event meaning, and the sheet's words (Story 7.13, FR-32, AD-33).
 *
 * One `describe` per row of the spec's I/O matrix, plus the fold's replay
 * properties (AD-5): a reversed close yields no Contract whatever order or
 * multiplicity it is folded in, and a later genuine close of the same Player
 * yields a fresh one.
 */

import { describe, expect, it } from 'vitest';

import { boardCardsFor, boardReversedStatement } from '../../src/lib/core/board.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { closedAuctionFor, REVERSED_LABEL } from '../../src/lib/core/projection/closed.ts';
import {
	INITIAL_CONTRACTS,
	ROSTER_TRADE_RECORDED_EVENT,
	DROP_RECORDED_EVENT,
	ROSTER_REARRANGED_EVENT,
	contractForPlayer,
	contractsReducer,
	reversalOfClose
} from '../../src/lib/core/projection/contracts.ts';
import type { AuctionCloseReversedPayload } from '../../src/lib/core/projection/contracts.ts';
import { INITIAL_DRAWS, drawsReducer } from '../../src/lib/core/projection/draws.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	INITIAL_NOMINATIONS,
	nominationForTeam,
	nominationsReducer
} from '../../src/lib/core/projection/nominations.ts';
import { INITIAL_AUCTIONS, auctionsReducer } from '../../src/lib/core/projection/auctions.ts';
import {
	closeReversalActSentence,
	closeReversalAttention,
	closeReversalFactsFor,
	closeReversalRefusalDetail,
	decideCloseReversal
} from '../../src/lib/core/rules/close-reversal.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';
import {
	CLOSE_REVERSAL_COMMIT_LABEL,
	closeReversalReasonRows,
	reasonSheetView,
	REASON_SHEET_TITLE
} from '../../src/lib/reason-sheet-view.ts';
import {
	CLOSE_SEQ,
	PLAYER_X,
	PLAYER_Y,
	PLAYER_Z,
	TEAM_R,
	TEAM_S,
	TEAM_T,
	WINNING_AMOUNT,
	baseLog,
	bid,
	closed,
	contractAssignmentOpened,
	ev,
	movedWithinTeam,
	nominated,
	reversalEvent,
	stateFor
} from '../fixtures/close-reversal-log.ts';

const REASON = 'Team R held an Injury Reserve Contract against the free-agency rule.';

function accepted(events: readonly AppendedEvent[]) {
	const outcome = decideCloseReversal(stateFor(events), REASON);
	if (outcome.kind !== 'accepted') {
		throw new Error(`refused: ${JSON.stringify(outcome.refusal)}`);
	}
	return outcome;
}

function refusal(events: readonly AppendedEvent[], closeSeq = CLOSE_SEQ) {
	const outcome = decideCloseReversal(stateFor(events, closeSeq), REASON);
	if (outcome.kind !== 'rejected') throw new Error('accepted');
	return outcome.refusal;
}

/** The log with the reversal appended at `seq`, as decided. */
function withReversal(events: readonly AppendedEvent[], seq = 20): AppendedEvent[] {
	return [...events, reversalEvent(seq, accepted(events).payload)];
}

describe('the payload — one compensating event naming the close by seq (AD-33, AD-4)', () => {
	it('names the close, restates the Contract as it stands, and carries the reason', () => {
		const { payload } = accepted(baseLog());
		expect(payload.closeSeq).toBe(CLOSE_SEQ);
		expect(payload.fantraxPlayerId).toBe(PLAYER_X);
		expect(payload.teamId).toBe(TEAM_R);
		expect(payload.winningAmount).toBe(WINNING_AMOUNT);
		expect(payload.capHit).toBe(WINNING_AMOUNT);
		expect(payload.placement).toBe('active_bench');
		expect(payload.reason).toBe(REASON);
	});

	it('uses teamBefore/teamAfter and never a top-level before/after', () => {
		const { payload } = accepted(baseLog());
		expect(payload).not.toHaveProperty('before');
		expect(payload).not.toHaveProperty('after');
		expect(payload.teamBefore.rosterCount).toBe(12);
		expect(payload.teamAfter.rosterCount).toBe(11);
	});

	it('lists the cancellation the close caused as standing, with who it restored', () => {
		const { payload } = accepted(baseLog());
		expect(payload.standingCancellations).toEqual([
			expect.objectContaining({
				cancelledSeq: '6',
				fantraxPlayerId: PLAYER_Y,
				teamId: TEAM_R,
				amount: 3_000_000,
				restoredTeamId: TEAM_S,
				restoredTeamName: 'Team S'
			})
		]);
	});

	it('states Available Cap Space and Maximum Bid before and after', () => {
		const { payload } = accepted(baseLog());
		// Cap Space rises by the winning Cap Hit; nothing else Team R commits
		// changes, so Available Cap Space rises by exactly the same.
		expect(
			payload.solvencyAfter.availableCapSpace - payload.solvencyBefore.availableCapSpace
		).toBe(WINNING_AMOUNT);
		// The freed Active/Bench Slot must be reserved again, so the Maximum Bid
		// rises by less than the Cap Hit — the reserve's own arithmetic, called.
		expect(payload.solvencyAfter.maximumBid).toBeGreaterThan(payload.solvencyBefore.maximumBid);
	});
});

describe('Slot re-held — the close released it and Team R holds none now', () => {
	it('records slotReheld and the nomination that held it, with its own seq', () => {
		const { payload } = accepted(baseLog());
		expect(payload.slotReheld).toBe(true);
		expect(payload.reheldNomination).toEqual(
			expect.objectContaining({ seq: '2', fantraxPlayerId: PLAYER_X, teamId: TEAM_R })
		);
	});

	it('re-holds the Slot in the nominations fold from the record', () => {
		const before = fold(INITIAL_NOMINATIONS, baseLog(), nominationsReducer);
		expect(nominationForTeam(before, TEAM_R)).toBeNull();
		const after = fold(INITIAL_NOMINATIONS, withReversal(baseLog()), nominationsReducer);
		const held = nominationForTeam(after, TEAM_R);
		expect(held?.fantraxPlayerId).toBe(PLAYER_X);
		expect(held?.holdsSlot).toBe(true);
		// The board is untouched: the Auction is not reopened.
		expect(after.byPlayer).toEqual(before.byPlayer);
	});

	it('re-holds nothing when the record says slotReheld: false, whatever the fold holds', () => {
		const payload: AuctionCloseReversedPayload = {
			...accepted(baseLog()).payload,
			slotReheld: false
		};
		const after = fold(
			INITIAL_NOMINATIONS,
			[...baseLog(), reversalEvent(20, payload)],
			nominationsReducer
		);
		expect(nominationForTeam(after, TEAM_R)).toBeNull();
	});
});

describe('Slot not re-held — Team R has nominated since', () => {
	const log = (): AppendedEvent[] => [...baseLog(), nominated(9, PLAYER_Z, 'Player Z', TEAM_R)];

	it('leaves the new Nomination standing and records slotReheld: false', () => {
		const { payload, decision } = accepted(log());
		expect(payload.slotReheld).toBe(false);
		expect(payload.reheldNomination).toBeNull();
		expect(decision.slot.before?.fantraxPlayerId).toBe(PLAYER_Z);
		expect(decision.slot.after?.fantraxPlayerId).toBe(PLAYER_Z);
		const after = fold(INITIAL_NOMINATIONS, withReversal(log()), nominationsReducer);
		expect(nominationForTeam(after, TEAM_R)?.fantraxPlayerId).toBe(PLAYER_Z);
	});

	it('says so in words on the sheet', () => {
		const notes = closeReversalAttention(accepted(log()).decision);
		expect(notes.slot).toContain('has nominated since');
		expect(notes.slot).toContain('Player Z');
		expect(notes.slot).toContain('no Slot is re-held');
	});

	it('says so too when the close released no Slot at all', () => {
		const log = baseLog().map((event) =>
			event.seq === CLOSE_SEQ ? closed(7, PLAYER_X, 'Player X', TEAM_R, WINNING_AMOUNT, false) : event
		);
		const { payload, decision } = accepted(log);
		expect(payload.slotReheld).toBe(false);
		expect(closeReversalAttention(decision).slot).toContain('released no Nomination Slot');
	});
});

describe('Moved within Team — a Move does not block, and the Contract leaves where it sits', () => {
	const log = (): AppendedEvent[] => [...baseLog(), movedWithinTeam(9, 'injury_reserve')];

	it('is permitted, and removes the Contract from Injury Reserve', () => {
		const { payload, decision } = accepted(log());
		expect(payload.placement).toBe('injury_reserve');
		expect(decision.teamBefore.injuryReserveOccupied).toBe(2);
		expect(decision.teamAfter.injuryReserveOccupied).toBe(1);
		// Roster Count counts Active/Bench only: unchanged.
		expect(decision.teamBefore.rosterCount).toBe(11);
		expect(decision.teamAfter.rosterCount).toBe(11);
	});

	it('removes the live Contract in the fold', () => {
		const contracts = fold(INITIAL_CONTRACTS, withReversal(log()), contractsReducer);
		expect(contractForPlayer(contracts, PLAYER_X)).toBeNull();
		expect(reversalOfClose(contracts, CLOSE_SEQ)?.contract.placement).toBe('injury_reserve');
	});
});

describe('Traded — refused, naming the act, its date and the current holder', () => {
	const trade = ev(9, ROSTER_TRADE_RECORDED_EVENT, {
		sendingTeamId: TEAM_R,
		sendingTeamName: 'Team R',
		receivingTeamId: TEAM_T,
		receivingTeamName: 'Team T',
		transfers: [
			{
				fantraxPlayerId: PLAYER_X,
				playerName: 'Player X',
				fromTeamId: TEAM_R,
				fromTeamName: 'Team R',
				toTeamId: TEAM_T,
				toTeamName: 'Team T',
				won: true,
				fromPlacement: 'active_bench',
				toPlacement: 'active_bench',
				capHitBefore: WINNING_AMOUNT,
				capHitAfter: WINNING_AMOUNT,
				winningAmount: WINNING_AMOUNT,
				clearedContractYears: null
			}
		],
		reason: 'traded'
	});

	it('refuses with traded, the date and Team T', () => {
		const refused = refusal([...baseLog(), trade]);
		expect(refused).toEqual({
			kind: 'traded',
			playerName: 'Player X',
			tradedAt: trade.occurredAt,
			holderTeamId: TEAM_T,
			holderTeamName: 'Team T'
		});
		const detail = closeReversalRefusalDetail(refused);
		expect(detail).toContain('Team T');
		expect(detail).toContain(trade.occurredAt);
	});
});

describe('Dropped — refused, naming the act and its date', () => {
	it('refuses with dropped (unreachable today — a Drop refuses won rows)', () => {
		const drop = ev(9, DROP_RECORDED_EVENT, {
			teamId: TEAM_R,
			teamName: 'Team R',
			released: [{ fantraxPlayerId: PLAYER_X, playerName: 'Player X' }],
			reason: 'dropped'
		});
		const refused = refusal([...baseLog(), drop]);
		expect(refused).toEqual({ kind: 'dropped', playerName: 'Player X', droppedAt: drop.occurredAt });
		expect(closeReversalRefusalDetail(refused)).toContain('dropped');
	});
});

describe('Twice — a close is reversed once', () => {
	it('refuses already_reversed', () => {
		const refused = refusal(withReversal(baseLog()));
		expect(refused.kind).toBe('already_reversed');
	});
});

describe('Archived, and any phase but Auction or Contract Assignment', () => {
	it('refuses phase from the core, whatever else is true', () => {
		const state = { ...stateFor(baseLog()), phase: 'Archived' as const };
		expect(decideCloseReversal(state, REASON)).toEqual({
			kind: 'rejected',
			refusal: { kind: 'phase', phase: 'Archived' }
		});
		const setup = { ...stateFor(baseLog()), phase: 'Setup' as const };
		expect(decideCloseReversal(setup, REASON).kind).toBe('rejected');
	});
});

describe('no_such_close', () => {
	it('refuses a seq that is not a close, one past the log, and one that is not a seq', () => {
		expect(refusal(baseLog(), '5').kind).toBe('no_such_close');
		expect(refusal(baseLog(), '999').kind).toBe('no_such_close');
		expect(refusal(baseLog(), 'abc').kind).toBe('no_such_close');
		expect(closeReversalFactsFor(baseLog(), 'abc').close).toBeNull();
	});
});

describe('Replay — the fold converges (AD-5)', () => {
	it('yields no Contract for X however the reversed close is duplicated or ordered', () => {
		const reversed = withReversal(baseLog());
		const close = reversed.find((event) => event.seq === CLOSE_SEQ);
		if (close === undefined) throw new Error('no close');
		const duplicated = [...reversed, close, close];
		const shuffled = [...duplicated].reverse();
		for (const events of [reversed, duplicated, shuffled]) {
			const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);
			expect(contractForPlayer(contracts, PLAYER_X)).toBeNull();
			expect(reversalOfClose(contracts, CLOSE_SEQ)?.reason).toBe(REASON);
		}
	});

	it('yields no Contract even when the reversal is REDUCED before its close', () => {
		const reversed = withReversal(baseLog());
		const reversal = reversed[reversed.length - 1] as AppendedEvent;
		const close = reversed.find((event) => event.seq === CLOSE_SEQ) as AppendedEvent;
		// Straight `reduce`, no sort: the reversal's own record stands in for
		// the Contract, and the close that follows is skipped by its seq.
		const contracts = [reversal, close].reduce(contractsReducer, INITIAL_CONTRACTS);
		expect(contractForPlayer(contracts, PLAYER_X)).toBeNull();
		expect(reversalOfClose(contracts, CLOSE_SEQ)?.contract.teamId).toBe(TEAM_R);
	});

	it('treats a second reversal of the same close as a no-op in both folds', () => {
		const reversed = withReversal(baseLog());
		const reversal = reversed[reversed.length - 1] as AppendedEvent;
		const twice = [...reversed, { ...reversal, seq: '21' }];
		const contracts = fold(INITIAL_CONTRACTS, twice, contractsReducer);
		expect(reversalOfClose(contracts, CLOSE_SEQ)?.reversalSeq).toBe(reversal.seq);
		expect(fold(INITIAL_NOMINATIONS, twice, nominationsReducer)).toEqual(
			fold(INITIAL_NOMINATIONS, reversed, nominationsReducer)
		);
	});
});

describe('Re-won — a later genuine close of X yields a fresh Contract', () => {
	const reWon = (): AppendedEvent[] => [
		...withReversal(baseLog(), 9),
		nominated(10, PLAYER_X, 'Player X', TEAM_T),
		bid(11, PLAYER_X, TEAM_S, 6_000_000),
		closed(12, PLAYER_X, 'Player X', TEAM_S, 6_000_000, true)
	];

	it('gives Team S a Contract carrying the new closeSeq', () => {
		const contracts = fold(INITIAL_CONTRACTS, reWon(), contractsReducer);
		const contract = contractForPlayer(contracts, PLAYER_X);
		expect(contract?.teamId).toBe(TEAM_S);
		expect(contract?.closeSeq).toBe('12');
		// The reversed close is still remembered, separately.
		expect(reversalOfClose(contracts, CLOSE_SEQ)?.contract.teamId).toBe(TEAM_R);
	});

	it('shows Closed, not Reversed, and the reversed close stays reversed', () => {
		const events = reWon();
		const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);
		const draws = fold(INITIAL_DRAWS, events, drawsReducer);
		expect(closedAuctionFor(contracts, draws, PLAYER_X)?.reversal).toBeNull();
		const cards = boardCardsFor(
			fold(INITIAL_NOMINATIONS, events, nominationsReducer),
			fold(INITIAL_AUCTIONS, events, auctionsReducer),
			contracts,
			draws,
			new Map(),
			TEAM_S
		);
		const card = cards.find((one) => one.fantraxPlayerId === PLAYER_X);
		expect(card?.state).toBe('closed');
		expect(card?.reversed).toBe(false);
		expect(card?.winningTeamId).toBe(TEAM_S);
	});

	it('cannot reverse the new close on the grounds of the old one', () => {
		const outcome = decideCloseReversal(stateFor(reWon(), '12'), REASON);
		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;
		// The earlier close's cancellation is not this close's.
		expect(outcome.payload.standingCancellations).toEqual([]);
	});
});

describe('the Board reads Reversed (Story 7.13)', () => {
	it('shows one reversed closed card, with no won glyph', () => {
		const events = withReversal(baseLog());
		const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);
		const draws = fold(INITIAL_DRAWS, events, drawsReducer);
		expect(closedAuctionFor(contracts, draws, PLAYER_X)?.reversal?.reason).toBe(REASON);
		const cards = boardCardsFor(
			fold(INITIAL_NOMINATIONS, events, nominationsReducer),
			fold(INITIAL_AUCTIONS, events, auctionsReducer),
			contracts,
			draws,
			new Map(),
			TEAM_R
		);
		const forX = cards.filter((one) => one.fantraxPlayerId === PLAYER_X);
		expect(forX).toHaveLength(1);
		expect(forX[0]?.state).toBe('closed');
		expect(forX[0]?.reversed).toBe(true);
		// Team R won it, and it is NOT theirs: no won glyph.
		expect(forX[0]?.viewerState).toBe('not_involved');
		expect(REVERSED_LABEL).toBe('Reversed');
	});

	it('gives way to the open card when X is nominated again — one card per Player', () => {
		const events = [...withReversal(baseLog(), 9), nominated(10, PLAYER_X, 'Player X', TEAM_T)];
		const cards = boardCardsFor(
			fold(INITIAL_NOMINATIONS, events, nominationsReducer),
			fold(INITIAL_AUCTIONS, events, auctionsReducer),
			fold(INITIAL_CONTRACTS, events, contractsReducer),
			fold(INITIAL_DRAWS, events, drawsReducer),
			new Map(),
			null
		);
		const forX = cards.filter((one) => one.fantraxPlayerId === PLAYER_X);
		expect(forX).toHaveLength(1);
		expect(forX[0]?.state).toBe('awaiting_opening_bid');
	});
});

describe('Contract Assignment — permitted, with the warning', () => {
	it('is permitted, and warns the Team falls below twelve, cannot export, and X cannot be re-nominated', () => {
		const { decision } = accepted([...baseLog(), contractAssignmentOpened(9)]);
		const notes = closeReversalAttention(decision);
		expect(notes.contractAssignment).not.toBeNull();
		expect(notes.contractAssignment).toContain('below twelve');
		expect(notes.contractAssignment).toContain('cannot export');
		expect(notes.contractAssignment).toContain('cannot be nominated again');
	});

	it('carries no such warning in the Auction Phase', () => {
		expect(closeReversalAttention(accepted(baseLog()).decision).contractAssignment).toBeNull();
	});
});

describe('the reason sheet', () => {
	const sheet = () => {
		const { decision } = accepted(baseLog());
		return reasonSheetView({
			act: closeReversalActSentence(decision),
			commitLabel: CLOSE_REVERSAL_COMMIT_LABEL,
			rows: closeReversalReasonRows(decision),
			cancelHref: `/teams/${TEAM_R}`
		});
	};

	it('keeps the shared title and states the act as "Reverse this Close — …"', () => {
		const view = sheet();
		expect(view.title).toBe(REASON_SHEET_TITLE);
		expect(view.act.startsWith('Reverse this Close — Player X')).toBe(true);
		expect(view.commitLabel).toBe('Reverse this Close');
	});

	it('shows before → after for the five figures FR-32 names', () => {
		const labels = sheet().rows.map((row) => row.label);
		for (const figure of [
			'Cap Space',
			'Available Cap Space',
			'Maximum Bid',
			'Roster Count',
			'Nomination Slot'
		]) {
			expect(labels).toContain(`Team R · ${figure}`);
		}
		const roster = sheet().rows.find((row) => row.label === 'Team R · Roster Count');
		expect(roster?.change).toBe('12 → 11');
		const slot = sheet().rows.find((row) => row.label === 'Team R · Nomination Slot');
		expect(slot?.change).toBe('Open → Held — Player X');
	});

	it('lists each standing Bid Cancellation as not undone', () => {
		const row = sheet().rows.find((one) => one.label === 'Bid Cancellation · Player Y');
		expect(row?.change).toContain('Team S leads');
		expect(row?.change).toContain('Stands — not undone');
	});

	it('carries the attention notes: pool, nothing else undone, and the IR Move after', () => {
		const notes = sheet().attentionNotes.join(' ');
		expect(notes).toContain('Player X returns to the pool');
		expect(notes).toContain('Nothing else is undone');
		expect(notes).toContain('no League Clock reset is removed');
		expect(notes).toContain('Injury Reserve');
		expect(notes).toContain('after this reversal');
	});
});

// --- Review findings (Story 7.13) -------------------------------------------

/** A state with one more imported Active/Bench row on Team R — Count 12 without X. */
function withExtraActiveRow(events: readonly AppendedEvent[]) {
	const state = stateFor(events);
	return {
		...state,
		team: {
			...state.team,
			rows: [
				...state.team.rows,
				{
					fantraxPlayerId: 'p-r-extra',
					playerName: 'Rostered Extra',
					rosterSlotKind: 'active_bench' as const,
					value: parseMoney(1_000_000)
				}
			]
		}
	};
}

describe('the IR note makes the room claim only when the reversal made room', () => {
	it('does not claim room when the reversed Contract itself sat on IR (Count unchanged)', () => {
		const { decision } = accepted([...baseLog(), movedWithinTeam(9, 'injury_reserve')]);
		expect(decision.teamBefore.rosterCount).toBe(decision.teamAfter.rosterCount);
		const note = closeReversalAttention(decision).irMove;
		expect(note).toContain('separate Roster Move, taken after this reversal');
		expect(note).toContain('makes no Active/Bench room');
		expect(note).not.toContain('which it did not have before');
	});

	it('claims the room when Roster Count falls', () => {
		const note = closeReversalAttention(accepted(baseLog()).decision).irMove;
		expect(note).toContain('at 11 it has room the Move needs, which it did not have before');
	});
});

describe('the Contract Assignment note says "below twelve" only when it is', () => {
	it('keeps the nomination sentence and drops the export warning when Count stays 12', () => {
		const events = [...baseLog(), movedWithinTeam(9, 'injury_reserve'), contractAssignmentOpened(10)];
		const outcome = decideCloseReversal(withExtraActiveRow(events), REASON);
		if (outcome.kind !== 'accepted') throw new Error('refused');
		expect(outcome.decision.teamAfter.rosterCount).toBe(12);
		const note = closeReversalAttention(outcome.decision).contractAssignment;
		expect(note).toContain('Player X cannot be nominated again');
		expect(note).not.toContain('below twelve');
		expect(note).not.toContain('cannot export');
	});
});

describe('the Slot note when the nomination that held the Slot cannot be found', () => {
	it('says so, rather than claiming the Team has nominated since', () => {
		const state = stateFor(baseLog());
		const outcome = decideCloseReversal(
			{ ...state, facts: { ...state.facts, slotNomination: null } },
			REASON
		);
		if (outcome.kind !== 'accepted') throw new Error('refused');
		expect(outcome.payload.slotReheld).toBe(false);
		const note = closeReversalAttention(outcome.decision).slot;
		expect(note).toContain('cannot be found in the log');
		expect(note).not.toContain('nominated since');
	});
});

describe('no_such_close names no position when none was given', () => {
	it('reads cleanly for an empty or non-numeric close', () => {
		for (const closeSeq of ['', 'abc']) {
			const detail = closeReversalRefusalDetail({ kind: 'no_such_close', closeSeq });
			expect(detail).toBe('No Auction Close was named, so there is nothing to reverse.');
		}
		expect(closeReversalRefusalDetail({ kind: 'no_such_close', closeSeq: '5' })).toContain(
			'has the position 5'
		);
	});
});

describe('a Trade or a Move folded AFTER a reversal keeps the reversal (the `...state` spread)', () => {
	it('keeps it through a RosterMoveRecorded (Trade)', () => {
		const trade = ev(30, ROSTER_TRADE_RECORDED_EVENT, {
			transfers: [
				{
					fantraxPlayerId: 'p-other',
					won: true,
					toTeamId: TEAM_T,
					toTeamName: 'Team T',
					toPlacement: 'active_bench',
					capHitBefore: 1_000_000,
					capHitAfter: 1_000_000,
					winningAmount: 1_000_000
				}
			]
		});
		const events = [
			...withReversal(baseLog(), 20),
			closed(25, 'p-other', 'Other', TEAM_S, 1_000_000, false),
			trade
		];
		const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);
		expect(contractForPlayer(contracts, 'p-other')?.teamId).toBe(TEAM_T);
		expect(reversalOfClose(contracts, CLOSE_SEQ)).not.toBeNull();
	});

	it('keeps it through a RosterRearranged (Move)', () => {
		const move = ev(30, ROSTER_REARRANGED_EVENT, {
			teamId: TEAM_S,
			moves: [
				{
					fantraxPlayerId: 'p-other',
					won: true,
					fromPlacement: 'active_bench',
					toPlacement: 'injury_reserve',
					capHitBefore: 1_000_000,
					capHitAfter: 1_000_000,
					value: 1_000_000
				}
			]
		});
		const events = [
			...withReversal(baseLog(), 20),
			closed(25, 'p-other', 'Other', TEAM_S, 1_000_000, false),
			move
		];
		const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);
		expect(contractForPlayer(contracts, 'p-other')?.placement).toBe('injury_reserve');
		expect(reversalOfClose(contracts, CLOSE_SEQ)).not.toBeNull();
	});
});

describe('the Board carries who reversed and why (Story 7.13)', () => {
	it('puts the reason and the acting Commissioner onto the reversed card', () => {
		const events = withReversal(baseLog());
		const cards = boardCardsFor(
			fold(INITIAL_NOMINATIONS, events, nominationsReducer),
			fold(INITIAL_AUCTIONS, events, auctionsReducer),
			fold(INITIAL_CONTRACTS, events, contractsReducer),
			fold(INITIAL_DRAWS, events, drawsReducer),
			new Map(),
			null
		);
		const card = cards.find((one) => one.fantraxPlayerId === PLAYER_X);
		expect(card?.reversalReason).toBe(REASON);
		expect(card?.reversedByManagerId).toBe('m-c');
		expect(card?.reversedByTeamId).toBe(TEAM_T);
		expect(boardReversedStatement('Dana', REASON)).toBe(
			`Reversed by the Commissioner, Dana. The Player is back in the pool. Reason: ${REASON}`
		);
		expect(boardReversedStatement(null, REASON)).toContain('Reversed by the Commissioner.');
	});
});
