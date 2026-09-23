/**
 * The Audit Log's normalisation, driven over every row of the story's I/O
 * matrix (Story 7.5).
 *
 * **EVERY fixture below is built from the DECLARED payload type**, with the
 * declaration imported as a `type` annotation so the compiler refuses a key
 * no emitter writes and refuses a missing one. That is the single discipline
 * the first iteration of this story lacked: `event_type` is free `text` and
 * `payload` is `jsonb`, so a renderer reading `teamIds` where the emitter
 * writes `teams` is not a type error, not a test failure and not visible in a
 * diff — and a fixture written to match the renderer would assert the renderer
 * against itself. Annotating each fixture with the emitter's own type makes
 * the mismatch unrepresentable instead.
 */

import { describe, expect, it } from 'vitest';

import {
	KNOWN_AUDIT_TYPES,
	NO_REFERENCES,
	SLOT_KIND_WORDS,
	SYSTEM_ACTOR,
	UNKNOWN_TYPE_REFUSAL,
	auditCountSentence,
	auditPartyIds,
	auditPlayerOptions,
	auditQueryString,
	auditRowsFor,
	auditTeamOptions,
	auditTypeOptions,
	filterAuditRows,
	parseAuditQuery,
	renderAuditAmount,
	renderAuditEvent,
	reversedClosesIn
} from '../../src/lib/core/audit-log.ts';
import type { AuditFilter, AuditReferences, AuditRow } from '../../src/lib/core/audit-log.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';

// The event-type constants, taken from the reducers that declare them rather
// than spelled as literals here — a renamed constant must break this suite.
import {
	BID_CANCELLED_EVENT,
	BID_PLACED_EVENT,
	CONTENTION_DISSOLVED_EVENT
} from '../../src/lib/core/projection/auctions.ts';
import {
	AUCTION_CLOSED_EVENT,
	AUCTION_TERMINATED_EVENT,
	NOMINATION_PLACED_EVENT
} from '../../src/lib/core/projection/nominations.ts';
import { CONTENTION_DRAWN_EVENT } from '../../src/lib/core/projection/draws.ts';
import {
	AUCTION_OPENED_EVENT,
	CONTRACT_ASSIGNMENT_OPENED_EVENT
} from '../../src/lib/core/projection/phase.ts';
import {
	AUCTION_CLOSE_REVERSED_EVENT,
	CONTRACT_LENGTH_ASSIGNED_EVENT,
	DROP_RECORDED_EVENT,
	ROSTER_REARRANGED_EVENT,
	ROSTER_TRADE_RECORDED_EVENT
} from '../../src/lib/core/projection/contracts.ts';
import { MINOR_LEAGUE_ELIGIBILITY_SET } from '../../src/lib/core/projection/eligibility.ts';
import { ASSIGNMENTS_SUBMITTED_EVENT } from '../../src/lib/core/projection/assignments.ts';
import {
	ASSIGNMENT_DEADLINE_PASSED_EVENT,
	ASSIGNMENT_DEADLINE_SET_EVENT,
	ASSIGNMENT_REMINDERS_SENT_EVENT,
	ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT
} from '../../src/lib/core/projection/assignment-deadline.ts';
import { IMPORT_PROMOTED_EVENT } from '../../src/lib/core/projection/promotion.ts';
import { BID_VOIDED_EVENT } from '../../src/lib/core/projection/league-clock.ts';

// The DECLARED payload types, each at the anchor the spec's Code Map names.
// `import type` erases at runtime, so naming a `$lib/server` module here pulls
// no server code into this suite.
import type {
	BidPlacedPayload,
	ContentionDissolvedPayload
} from '../../src/lib/core/rules/bidding.ts';
import type {
	AuctionClosedPayload,
	BidCancelledPayload,
	DrawnContentionPayload,
	UndrawnContentionPayload
} from '../../src/lib/core/rules/close.ts';
import type {
	AuctionTerminatedPayload,
	ContractAssignmentOpenedPayload
} from '../../src/lib/core/rules/phase-end.ts';
import type { NominationPlacedPayload } from '../../src/lib/server/nomination.ts';
import type { AuctionOpenedPayload } from '../../src/lib/server/auction-open.ts';
import type { ImportPromotedPayload } from '../../src/lib/server/import-promotion.ts';
import type {
	AuctionCloseReversedPayload,
	ContractLengthAssignedPayload,
	DropRecordedPayload,
	RosterRearrangedPayload,
	RosterTradeRecordedPayload,
	RosterActTeamFigures,
	RosterTradeTransfer
} from '../../src/lib/core/projection/contracts.ts';
import type { MinorLeagueEligibilitySetPayload } from '../../src/lib/core/projection/eligibility.ts';
import type { AssignmentsSubmittedPayload } from '../../src/lib/core/projection/assignments.ts';
import type {
	AssignmentDeadlineSetPayload,
	AssignmentMarkerPayload,
	AssignmentReminderIntervalSetPayload
} from '../../src/lib/core/projection/assignment-deadline.ts';

// --- Ids, names and the envelope ------------------------------------------

const TEAM_A = 'team-a';
const TEAM_B = 'team-b';
const TEAM_C = 'team-c';
const TEAM_OVERRIDE = 'team-override';
const MANAGER_A = 'manager-a';
const PLAYER_ONE = 'player-1';
const PLAYER_TWO = 'player-2';

const REFERENCES: AuditReferences = {
	teamNames: new Map([
		[TEAM_A, 'Lakers'],
		[TEAM_B, 'Celtics'],
		[TEAM_C, 'Bulls'],
		[TEAM_OVERRIDE, 'Kings']
	]),
	playerNames: new Map([
		[PLAYER_ONE, 'Jalen Green'],
		[PLAYER_TWO, 'Alperen Sengun']
	]),
	managerNames: new Map([[MANAGER_A, 'Meakel']]),
	reversedCloses: new Map()
};

let nextSeq = 0;

/**
 * One `auction_events` row, as `toAppendedEvent` shapes it.
 *
 * The actor pair defaults NON-NULL and to a real Manager and Team, because the
 * database constrains the two to be null together
 * (`20260901000000_system_actor.sql:43`) and an attributed event is the
 * ordinary case. The null pair is passed explicitly by the one test about it.
 */
function event(
	type: string,
	payload: unknown,
	actor?: { manager: null; team: null }
): AppendedEvent {
	nextSeq += 1;
	return {
		seq: String(nextSeq),
		occurredAt: '2026-09-01T12:00:00.000Z',
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: actor === undefined ? MANAGER_A : null,
		teamId: actor === undefined ? TEAM_A : null,
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

/** The whole of one row, as one searchable string. */
function rendered(entry: AuditRow): string {
	return [
		entry.headline,
		entry.actor.label,
		entry.typeLabel,
		...entry.details.map((detail) => `${detail.label} ${detail.value}`)
	].join(' | ');
}

function only(events: readonly AppendedEvent[]): AuditRow {
	const rows = auditRowsFor(events, REFERENCES);
	expect(rows).toHaveLength(1);
	return rows[0] as AuditRow;
}

const money = (dollars: number) => parseMoney(dollars);

// --- The nineteen fixtures, each from its declared type --------------------

const BID_PLACED: BidPlacedPayload = {
	fantraxPlayerId: PLAYER_ONE,
	teamId: TEAM_A,
	teamName: 'Lakers',
	managerId: MANAGER_A,
	amount: 8_500_000,
	closesAt: '2026-09-02T12:00:00.000Z',
	seedHash: 'commitment-hash'
};

const CONTENTION_DISSOLVED: ContentionDissolvedPayload = {
	fantraxPlayerId: PLAYER_ONE,
	seed: 'revealed-seed',
	seedHash: 'commitment-hash',
	formerContenders: [TEAM_B, TEAM_C],
	convertingTeamId: TEAM_A,
	amount: 1_500_000
};

const BID_CANCELLED: BidCancelledPayload = {
	fantraxPlayerId: PLAYER_ONE,
	playerName: 'Jalen Green',
	cancelledSeq: '41',
	teamId: TEAM_A,
	teamName: 'Lakers',
	managerId: MANAGER_A,
	amount: 8_500_000,
	wasContentionEntry: false,
	causeFantraxPlayerId: PLAYER_TWO,
	causePlayerName: 'Alperen Sengun',
	causeTeamId: TEAM_A,
	restoration: {
		seq: '30',
		teamId: TEAM_B,
		teamName: 'Celtics',
		managerId: 'manager-b',
		amount: 8_000_000
	}
};

const AUCTION_CLOSED: AuctionClosedPayload = {
	// The audit log does not read this field and has no line for it — the Slot
	// release is a Discord mention's fact, not a logged act (FR-9, amended).
	// It is stated here because the payload type requires it.
	releasedNominationSlot: false,
	fantraxPlayerId: PLAYER_ONE,
	playerName: 'Jalen Green',
	teamId: TEAM_A,
	teamName: 'Lakers',
	managerId: MANAGER_A,
	winningAmount: 8_500_000,
	capHit: 8_500_000,
	placement: 'minor_league',
	contention: 'minimum_bid',
	contractYears: null,
	closedAt: '2026-09-02T12:00:00.000Z'
};

const AUCTION_TERMINATED: AuctionTerminatedPayload = {
	fantraxPlayerId: PLAYER_ONE,
	playerName: 'Jalen Green',
	teamId: TEAM_A,
	teamName: 'Lakers',
	managerId: MANAGER_A,
	expiredAt: '2026-09-02T12:00:00.000Z',
	evaluatedAt: '2026-09-02T12:00:05.000Z'
};

const CONTENTION_DRAWN: DrawnContentionPayload = {
	fantraxPlayerId: PLAYER_ONE,
	seed: 'revealed-seed',
	seedHash: 'commitment-hash',
	contenders: [TEAM_B, TEAM_C],
	drawnAt: '2026-09-02T12:00:00.000Z',
	selectedIndex: 1,
	winningTeamId: TEAM_C,
	winningTeamName: 'Bulls',
	winningManagerId: 'manager-c'
};

const CONTENTION_UNDRAWN: UndrawnContentionPayload = {
	fantraxPlayerId: PLAYER_ONE,
	seed: 'revealed-seed',
	seedHash: 'commitment-hash',
	contenders: [],
	drawnAt: '2026-09-02T12:00:00.000Z'
};

const NOMINATION_PLACED: NominationPlacedPayload = {
	fantraxPlayerId: PLAYER_ONE,
	playerName: 'Jalen Green',
	teamId: TEAM_A,
	teamName: 'Lakers',
	managerId: MANAGER_A,
	holdsSlot: true
};

const AUCTION_OPENED: AuctionOpenedPayload = {
	teams: [
		{ teamId: TEAM_A, teamName: 'Lakers' },
		{ teamId: TEAM_B, teamName: 'Celtics' }
	],
	minorLeagueEligibleCount: 12
};

const CONTRACT_ASSIGNMENT_OPENED: ContractAssignmentOpenedPayload = {
	expiredAt: '2026-09-02T12:00:00.000Z',
	evaluatedAt: '2026-09-02T12:00:05.000Z',
	terminatedPlayerIds: [PLAYER_TWO]
};

const CONTRACT_LENGTH_ASSIGNED: ContractLengthAssignedPayload = {
	fantraxPlayerId: PLAYER_ONE,
	playerName: 'Jalen Green',
	teamId: TEAM_A,
	teamName: 'Lakers',
	managerId: MANAGER_A,
	contractYears: 3
};

const FIGURES = (teamId: string, teamName: string, capSpace: number): RosterActTeamFigures => ({
	teamId,
	teamName,
	capSpace: money(capSpace),
	rosterCount: 11,
	injuryReserveOccupied: 1,
	minorLeagueOccupied: 2
});

const TRANSFER: RosterTradeTransfer = {
	fantraxPlayerId: PLAYER_ONE,
	playerName: 'Jalen Green',
	fromTeamId: TEAM_A,
	fromTeamName: 'Lakers',
	toTeamId: TEAM_B,
	toTeamName: 'Celtics',
	won: true,
	fromPlacement: 'active_bench',
	toPlacement: 'minor_league',
	capHitBefore: money(18_000_000),
	capHitAfter: money(0),
	winningAmount: money(18_000_000),
	clearedContractYears: 2
};

const ROSTER_TRADE: RosterTradeRecordedPayload = {
	sendingTeamId: TEAM_A,
	sendingTeamName: 'Lakers',
	receivingTeamId: TEAM_B,
	receivingTeamName: 'Celtics',
	transfers: [TRANSFER],
	sendingBefore: FIGURES(TEAM_A, 'Lakers', 4_000_000),
	sendingAfter: FIGURES(TEAM_A, 'Lakers', 22_000_000),
	receivingBefore: FIGURES(TEAM_B, 'Celtics', 30_000_000),
	receivingAfter: FIGURES(TEAM_B, 'Celtics', 12_000_000),
	reason: 'Agreed in the league chat on 1 September.'
};

/**
 * A Drop that releases two Contracts (Story 7.8, FR-43): one Active/Bench
 * Player who leaves $2,000,000 of Dead Money behind, and one full-term
 * second-round rookie-scale deal that clears entirely.
 */
const DROP: DropRecordedPayload = {
	teamId: TEAM_A,
	teamName: 'Lakers',
	released: [
		{
			fantraxPlayerId: PLAYER_ONE,
			playerName: 'Jalen Green',
			fromPlacement: 'active_bench',
			chargedCapHit: parseMoney(2_000_000),
			value: parseMoney(2_000_000),
			deadMoney: parseMoney(2_000_000),
			removed: false,
			contractYearsRemaining: 3,
			rookieScaleRound: null
		},
		{
			fantraxPlayerId: PLAYER_TWO,
			playerName: 'Jalen Duren',
			fromPlacement: 'active_bench',
			chargedCapHit: parseMoney(2_000_000),
			value: parseMoney(2_000_000),
			deadMoney: parseMoney(0),
			removed: true,
			contractYearsRemaining: 5,
			rookieScaleRound: 2
		}
	],
	teamBefore: FIGURES(TEAM_A, 'Lakers', 5_000_000),
	teamAfter: FIGURES(TEAM_A, 'Lakers', 7_000_000),
	reason: 'Both released in Fantrax on the 11th.'
};

/**
 * A Roster Move that swaps two Contracts between the two participating Slots
 * (Story 7.11, FR-44, §10 example 44): a won stash promoted INTO a Minor
 * League Slot, which stops it charging, and an imported stash demoted OUT of
 * one, which starts it charging.
 */
const ROSTER_MOVE: RosterRearrangedPayload = {
	teamId: TEAM_A,
	teamName: 'Lakers',
	moves: [
		{
			fantraxPlayerId: PLAYER_ONE,
			playerName: 'Jalen Green',
			won: true,
			fromPlacement: 'active_bench',
			toPlacement: 'minor_league',
			capHitBefore: parseMoney(18_000_000),
			capHitAfter: parseMoney(0),
			value: parseMoney(18_000_000)
		},
		{
			fantraxPlayerId: PLAYER_TWO,
			playerName: 'Jalen Duren',
			won: false,
			fromPlacement: 'minor_league',
			toPlacement: 'active_bench',
			capHitBefore: parseMoney(0),
			capHitAfter: parseMoney(3_000_000),
			value: parseMoney(3_000_000)
		}
	],
	teamBefore: FIGURES(TEAM_A, 'Lakers', 2_000_000),
	teamAfter: FIGURES(TEAM_A, 'Lakers', 17_000_000),
	reason: 'Recorded on behalf of the Manager, who is travelling.'
};

/**
 * A reversed Close (Story 7.13, FR-32): Lakers' win of Jalen Green reversed,
 * the close's cancellation of Celtics on Alperen Sengun standing with Bulls
 * restored there, and the Slot re-held on the nomination that held it.
 */
const CLOSE_REVERSED: AuctionCloseReversedPayload = {
	closeSeq: '4',
	fantraxPlayerId: PLAYER_ONE,
	playerName: 'Jalen Green',
	teamId: TEAM_A,
	teamName: 'Lakers',
	winningAmount: parseMoney(4_000_000),
	capHit: parseMoney(4_000_000),
	placement: 'active_bench',
	closedAt: '2026-09-01T09:00:00.000Z',
	slotReheld: true,
	reheldNomination: {
		seq: '2',
		fantraxPlayerId: PLAYER_TWO,
		playerName: 'Alperen Sengun',
		teamId: TEAM_A,
		teamName: 'Lakers',
		managerId: MANAGER_A,
		occurredAt: '2026-08-30T09:00:00.000Z'
	},
	standingCancellations: [
		{
			cancelledSeq: '3',
			fantraxPlayerId: PLAYER_TWO,
			playerName: 'Alperen Sengun',
			teamId: TEAM_B,
			teamName: 'Celtics',
			amount: parseMoney(2_000_000),
			restoredTeamId: TEAM_C,
			restoredTeamName: 'Bulls'
		}
	],
	teamBefore: FIGURES(TEAM_A, 'Lakers', 5_000_000),
	teamAfter: FIGURES(TEAM_A, 'Lakers', 9_000_000),
	solvencyBefore: { availableCapSpace: parseMoney(5_000_000), maximumBid: parseMoney(4_000_000) },
	solvencyAfter: { availableCapSpace: parseMoney(9_000_000), maximumBid: parseMoney(7_000_000) },
	reason: 'Lakers held an IR Contract against the free-agency rule.'
};

const ELIGIBILITY_SET: MinorLeagueEligibilitySetPayload = {
	fantraxPlayerId: PLAYER_ONE,
	playerName: 'Jalen Green',
	before: false,
	after: true
};

const ASSIGNMENTS_SUBMITTED: AssignmentsSubmittedPayload = {
	teamId: TEAM_A,
	teamName: 'Lakers',
	managerId: MANAGER_A,
	assignedCount: 4
};

const DEADLINE_SET: AssignmentDeadlineSetPayload = {
	deadline: '2026-09-10T12:00:00.000Z',
	previousDeadline: null,
	managerId: MANAGER_A,
	teamId: TEAM_A,
	teamName: 'Lakers',
	setAt: '2026-09-01T12:00:00.000Z'
};

const INTERVAL_SET: AssignmentReminderIntervalSetPayload = {
	intervalHours: 24,
	previousIntervalHours: null,
	managerId: MANAGER_A,
	teamId: TEAM_A,
	teamName: 'Lakers'
};

const MARKER: AssignmentMarkerPayload = {
	deadline: '2026-09-10T12:00:00.000Z',
	outstandingTeamIds: [TEAM_B, TEAM_C],
	outstandingPlayerCount: 5,
	evaluatedAt: '2026-09-09T12:00:00.000Z'
};

const IMPORT_PROMOTED: ImportPromotedPayload = {
	teams: [
		{ teamId: TEAM_A, teamName: 'Lakers', rosterCount: 12 },
		{ teamId: TEAM_B, teamName: 'Celtics', rosterCount: 11 }
	],
	poolSize: 300
};

/** One event of every type the registry words, in a stable order. */
function everyKnownEvent(): AppendedEvent[] {
	return [
		event(BID_PLACED_EVENT, BID_PLACED),
		event(CONTENTION_DISSOLVED_EVENT, CONTENTION_DISSOLVED),
		event(BID_CANCELLED_EVENT, BID_CANCELLED),
		event(AUCTION_CLOSED_EVENT, AUCTION_CLOSED),
		event(AUCTION_TERMINATED_EVENT, AUCTION_TERMINATED),
		event(CONTENTION_DRAWN_EVENT, CONTENTION_DRAWN),
		event(NOMINATION_PLACED_EVENT, NOMINATION_PLACED),
		event(AUCTION_OPENED_EVENT, AUCTION_OPENED),
		event(CONTRACT_ASSIGNMENT_OPENED_EVENT, CONTRACT_ASSIGNMENT_OPENED, {
			manager: null,
			team: null
		}),
		event(CONTRACT_LENGTH_ASSIGNED_EVENT, CONTRACT_LENGTH_ASSIGNED),
		event(ROSTER_TRADE_RECORDED_EVENT, ROSTER_TRADE),
		event(DROP_RECORDED_EVENT, DROP),
		event(ROSTER_REARRANGED_EVENT, ROSTER_MOVE),
		event(AUCTION_CLOSE_REVERSED_EVENT, CLOSE_REVERSED),
		event(MINOR_LEAGUE_ELIGIBILITY_SET, ELIGIBILITY_SET),
		event(ASSIGNMENTS_SUBMITTED_EVENT, ASSIGNMENTS_SUBMITTED),
		event(ASSIGNMENT_DEADLINE_SET_EVENT, DEADLINE_SET),
		event(ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT, INTERVAL_SET),
		event(ASSIGNMENT_REMINDERS_SENT_EVENT, MARKER, {
			manager: null,
			team: null
		}),
		event(ASSIGNMENT_DEADLINE_PASSED_EVENT, MARKER, {
			manager: null,
			team: null
		}),
		event(IMPORT_PROMOTED_EVENT, IMPORT_PROMOTED),
		event(BID_VOIDED_EVENT, {})
	];
}

// --- The matrix ------------------------------------------------------------

describe('the full log', () => {
	it('renders one row per event, newest first, for every known type', () => {
		const events = everyKnownEvent();
		const rows = auditRowsFor(events, REFERENCES);

		expect(rows).toHaveLength(events.length);
		// Newest first, over `seq` — never `occurred_at`, which every fixture
		// here deliberately shares.
		expect(rows.map((entry) => Number(entry.seq))).toEqual(
			[...events].map((entry) => Number(entry.seq)).sort((a, b) => b - a)
		);
		for (const entry of rows) {
			expect(entry.headline.length).toBeGreaterThan(0);
			expect(entry.typeLabel).not.toBe(entry.type);
		}
	});

	it('covers every type the registry words', () => {
		const types = everyKnownEvent().map((entry) => entry.type);
		expect([...types].sort()).toEqual([...KNOWN_AUDIT_TYPES]);
	});

	it('never lets a machine token reach the reader', () => {
		const text = auditRowsFor(everyKnownEvent(), REFERENCES).map(rendered).join(' ');
		for (const token of ['active_bench', 'injury_reserve', 'minor_league', 'dead_money']) {
			expect(text).not.toContain(token);
		}
		expect(text).not.toContain('awaiting_opening_bid');
		expect(text).toContain(SLOT_KIND_WORDS.minor_league);
	});

	it('renders no raw party id anywhere on a log whose references all resolve', () => {
		const text = auditRowsFor(everyKnownEvent(), REFERENCES).map(rendered).join(' ');
		for (const id of [TEAM_A, TEAM_B, TEAM_C, MANAGER_A, PLAYER_ONE, PLAYER_TWO]) {
			expect(text).not.toContain(id);
		}
	});
});

describe('an unrecognised event type', () => {
	it('renders as the envelope plus the raw payload, and is still counted', () => {
		const events = [...everyKnownEvent(), event('SomethingNobodyWroteYet', { odd: 'shape' })];
		const rows = auditRowsFor(events, REFERENCES);

		expect(rows).toHaveLength(events.length);
		const unknown = rows.find((entry) => entry.type === 'SomethingNobodyWroteYet');
		expect(unknown).toBeDefined();
		expect(unknown?.typeLabel).toBe('SomethingNobodyWroteYet');
		expect(rendered(unknown as AuditRow)).toContain('"odd":"shape"');
	});

	it('survives a payload that is not an object', () => {
		for (const payload of [null, 'a string', 42, [1, 2, 3], undefined]) {
			const entry = only([event('Unworded', payload)]);
			expect(entry.details.length).toBeGreaterThan(0);
			expect(entry.headline).toContain('Unworded');
		}
	});

	it('stays selectable on the type control', () => {
		const rows = auditRowsFor([event('Unworded', {})], REFERENCES);
		const options = auditTypeOptions(rows);
		expect(options.some((option) => option.value === 'Unworded')).toBe(true);
		// The registry's own types stay selectable even on a log holding none.
		for (const type of KNOWN_AUDIT_TYPES) {
			expect(options.some((option) => option.value === type)).toBe(true);
		}
	});
});

describe('a draw', () => {
	it('states the revealed seed, the ordered list and the selection', () => {
		const entry = only([event(CONTENTION_DRAWN_EVENT, CONTENTION_DRAWN)]);
		const text = rendered(entry);
		expect(text).toContain('revealed-seed');
		expect(text).toContain('commitment-hash');
		// The payload's own order, which AD-14 makes an input to the winner.
		expect(text).toContain('Celtics, Bulls');
		expect(text).toContain('1');
		expect(entry.headline).toContain('Bulls');
	});

	it('states a dissolved lottery with no winner', () => {
		const entry = only([event(CONTENTION_DRAWN_EVENT, CONTENTION_UNDRAWN)]);
		expect(entry.headline).toContain('no winner');
		expect(rendered(entry)).toContain('revealed-seed');
		expect(rendered(entry)).not.toContain('Selected');
	});
});

describe('a Roster Trade', () => {
	it('is one entry carrying both Teams’ figures, the Players and the reason', () => {
		const entry = only([event(ROSTER_TRADE_RECORDED_EVENT, ROSTER_TRADE)]);
		const text = rendered(entry);

		// Story 7.10: the renderer is keyed by `ROSTER_TRADE_RECORDED_EVENT`,
		// whose value is still the pre-rename wire string — so an entry folded
		// from history written before the rename renders under the NEW label.
		expect(entry.typeLabel).toBe('Roster Trade recorded');
		expect(entry.headline).toContain('Lakers');
		expect(entry.headline).toContain('Celtics');
		expect(text).toContain(ROSTER_TRADE.reason);
		expect(text).toContain('Jalen Green');
		// The `won` distinction FR-41 requires be visible.
		expect(text).toContain('Auction Contract');
		expect(text).toContain('Won for $18.0M');
		expect(text).toContain('Cleared 2 years');
		// Both Teams' before/after figures, per side.
		expect(text).toContain('Lakers — Cap Space');
		expect(text).toContain('Celtics — Cap Space');
		expect(text).toContain('$4.0M → $22.0M');
		expect(text).toContain('$30.0M → $12.0M');
		// Both sides are parties, so either finds it under its own filter.
		expect(entry.teams).toContain(TEAM_A);
		expect(entry.teams).toContain(TEAM_B);
	});
});

describe('a Drop', () => {
	it('is one entry stating the reason, each released Player and the before → after', () => {
		const entry = only([event(DROP_RECORDED_EVENT, DROP)]);
		const text = rendered(entry);

		expect(entry.headline).toContain('Lakers');
		expect(entry.headline).toContain('Drop');
		// The Commissioner's stated reason, verbatim and first — it is what
		// FR-43 requires the record carry.
		expect(text).toContain(DROP.reason);
		expect(entry.details[0]?.label).toBe('Reason');
		expect(entry.details[0]?.value).toBe(DROP.reason);
		// The Team's five figures, before → after.
		expect(text).toContain('Lakers — Cap Space');
		expect(text).toContain('$5.0M → $7.0M');
		// Both released Players are parties, so either finds the entry under
		// its own filter, and the Team does too.
		expect(entry.teams).toEqual([TEAM_A]);
		expect(entry.players).toEqual([PLAYER_ONE, PLAYER_TWO]);
	});

	it('words the CARRIED release as Dead Money at the amount it was charging', () => {
		const entry = only([event(DROP_RECORDED_EVENT, DROP)]);
		const carried = entry.details.find((detail) => detail.label === 'Jalen Green');

		expect(carried).not.toBeUndefined();
		expect(carried?.value).toContain('Left Active/Bench');
		expect(carried?.value).toContain('Was charging $2.0M');
		expect(carried?.value).toContain('Dead Money $2.0M');
		// The exception did not apply, so nothing claims it did.
		expect(carried?.value).not.toContain('rookie scale');
		expect(carried?.value).not.toContain('returned to Cap Space');
		expect(carried?.value).toContain('3 years remaining');
	});

	it('words the CLEARED release as removed, and states the round and the term', () => {
		const entry = only([event(DROP_RECORDED_EVENT, DROP)]);
		const cleared = entry.details.find((detail) => detail.label === 'Jalen Duren');

		expect(cleared).not.toBeUndefined();
		expect(cleared?.value).toContain('Left Active/Bench');
		expect(cleared?.value).toContain('Was charging $2.0M');
		// Not "Dead Money $0.0M": the row was removed and the money went back.
		expect(cleared?.value).toContain('No Dead Money carried');
		expect(cleared?.value).toContain('returned to Cap Space');
		expect(cleared?.value).not.toMatch(/Dead Money \$/);
		// The two facts FR-43's exception turned on, so a later reading can see
		// WHY rather than take it on trust.
		expect(cleared?.value).toContain('Round 2 rookie scale');
		expect(cleared?.value).toContain('5 years remaining');
	});

	it('never renders the two releases the same way — the ternary is not invertible in silence', () => {
		const entry = only([event(DROP_RECORDED_EVENT, DROP)]);
		const carried = entry.details.find((detail) => detail.label === 'Jalen Green');
		const cleared = entry.details.find((detail) => detail.label === 'Jalen Duren');

		// Both released the same amount from the same Slot; only their FATE
		// differs, and it is the only thing on the entry that says so.
		expect(carried?.value).not.toBe(cleared?.value);
	});

	it('states an absence rather than an invented $0 when a release carries no amount', () => {
		// The defensive branch. `auction_events` is insert-only, so a payload
		// written by an older or broken build cannot be corrected in place —
		// the renderer states what it has and never repairs a missing figure
		// into a zero somebody could read as "nothing was carried".
		const malformed = {
			...DROP,
			released: [{ fantraxPlayerId: PLAYER_ONE, playerName: 'Jalen Green' }]
		};
		const entry = only([event(DROP_RECORDED_EVENT, malformed as unknown as DropRecordedPayload)]);
		const row = entry.details.find((detail) => detail.label === 'Jalen Green');

		expect(row?.value).toContain('Dead Money —');
		expect(row?.value).not.toContain('$0');
	});
});

describe('a Roster Move', () => {
	// **`RENDERERS` is OPEN.** A missing key is not a compile error — the entry
	// falls back to the envelope plus the raw payload and renders machine
	// tokens at a reader — so this block is the ONLY proof the renderer exists
	// and is wired to the event type the write path appends.
	it('is one entry stating the reason, each re-placed Contract and the before → after', () => {
		const entry = only([event(ROSTER_REARRANGED_EVENT, ROSTER_MOVE)]);
		const text = rendered(entry);

		expect(entry.typeLabel).toBe('Roster Move recorded');
		expect(entry.headline).toContain('Lakers');
		expect(entry.headline).toContain('Roster Move');
		// The Commissioner's stated reason, verbatim and first.
		expect(entry.details[0]?.label).toBe('Reason');
		expect(entry.details[0]?.value).toBe(ROSTER_MOVE.reason);
		// The Team's figures, before → after — §10 example 44's $2.0M → $17.0M.
		expect(text).toContain('Lakers — Cap Space');
		expect(text).toContain('$2.0M → $17.0M');
		expect(entry.teams).toEqual([TEAM_A]);
		expect(entry.players).toEqual([PLAYER_ONE, PLAYER_TWO]);
	});

	it('states both placements and both Cap Hits on each Contract, with the value beside them', () => {
		const entry = only([event(ROSTER_REARRANGED_EVENT, ROSTER_MOVE)]);
		const promoted = entry.details.find((detail) => detail.label === 'Jalen Green');
		const demoted = entry.details.find((detail) => detail.label === 'Jalen Duren');

		// The promotion: it stops charging, and its value is untouched (AD-23).
		expect(promoted?.value).toContain('Active/Bench → Minor League');
		expect(promoted?.value).toContain('Cap Hit $18.0M → $0.0M');
		expect(promoted?.value).toContain('Value $18.0M');
		// **Worded, never a boolean** — it is what says whether a `team_rosters`
		// row was updated or the Contract moved by this event alone.
		expect(promoted?.value).toContain('Auction Contract');

		// The demotion: the same act, the opposite direction.
		expect(demoted?.value).toContain('Minor League → Active/Bench');
		expect(demoted?.value).toContain('Cap Hit $0.0M → $3.0M');
		expect(demoted?.value).toContain('Existing Contract');
	});

	it('carries NO Reason row for a Manager acting on their own Team', () => {
		// FR-44 gives a Manager a confirmation and no justification, so the
		// payload's `reason` is `null` — and `rows()` drops a null rather than
		// rendering an empty Reason line.
		const own = { ...ROSTER_MOVE, reason: null };
		const entry = only([event(ROSTER_REARRANGED_EVENT, own)]);

		expect(entry.details.some((detail) => detail.label === 'Reason')).toBe(false);
		// Everything else is still there: the record is the same record.
		expect(rendered(entry)).toContain('Cap Hit $18.0M → $0.0M');
	});

	it('states an absence rather than an invented $0 when a move carries no amount', () => {
		const malformed = {
			...ROSTER_MOVE,
			moves: [{ fantraxPlayerId: PLAYER_ONE, playerName: 'Jalen Green' }]
		};
		const entry = only([
			event(ROSTER_REARRANGED_EVENT, malformed as unknown as RosterRearrangedPayload)
		]);
		const row = entry.details.find((detail) => detail.label === 'Jalen Green');

		expect(row?.value).not.toContain('$0');
		expect(row?.value).not.toContain('Cap Hit');
	});
});

describe('the actor', () => {
	it('attributes the null pair to the system and never to the Commissioner', () => {
		const entry = only([
			event(ASSIGNMENT_DEADLINE_PASSED_EVENT, MARKER, {
				manager: null,
				team: null
			})
		]);
		expect(entry.actor.isSystem).toBe(true);
		expect(entry.actor.label).toBe(SYSTEM_ACTOR);
		expect(rendered(entry)).not.toContain('Commissioner');
	});

	it('renders an attributed event as the Team paired with the Manager', () => {
		const entry = only([event(NOMINATION_PLACED_EVENT, NOMINATION_PLACED)]);
		expect(entry.actor.isSystem).toBe(false);
		expect(entry.actor.label).toBe('Lakers — Meakel');
	});

	it('states an absence rather than an id when the actor resolves to nothing', () => {
		const entry = only([event(NOMINATION_PLACED_EVENT, NOMINATION_PLACED)]);
		const unresolved = renderAuditEvent(
			event(NOMINATION_PLACED_EVENT, NOMINATION_PLACED),
			NO_REFERENCES
		);
		expect(entry.actor.label).not.toBe(unresolved.actor.label);
		expect(unresolved.actor.label).not.toContain(MANAGER_A);
		expect(unresolved.actor.label).not.toContain(TEAM_A);
	});
});

describe('money', () => {
	it('renders on the grid at one decimal', () => {
		expect(renderAuditAmount(8_500_000)).toBe('$8.5M');
	});

	it('falls back to exact dollars off the grid rather than throwing', () => {
		// `formatMoney` raises `RangeError` here; on this surface that would
		// take the whole page down rather than one cell.
		expect(() => renderAuditAmount(8_300_000)).not.toThrow();
		expect(renderAuditAmount(8_300_000)).toBe('$8,300,000');
	});

	it('renders an off-grid payload amount without taking the row down', () => {
		const offGrid: BidPlacedPayload = { ...BID_PLACED, amount: 8_300_001 };
		const entry = only([event(BID_PLACED_EVENT, offGrid)]);
		expect(rendered(entry)).toContain('$8,300,001');
	});
});

describe('an override', () => {
	/**
	 * Built as the `OverrideRecord` SHAPE (`rules/override.ts:131-172`) rather
	 * than as that branded type, which `buildOverrideRecord` is the only
	 * expression in the repository able to produce. What reaches this module is
	 * a `jsonb` payload, and the shape is what it carries.
	 */
	const overridePayload = {
		actor: {
			managerId: 'manager-x',
			teamId: TEAM_OVERRIDE,
			displayName: 'Dana'
		},
		before: { 'Leading Bid': '$8.5M', Placement: 'Active/Bench' },
		after: { 'Leading Bid': '$8.0M', Placement: 'Minor League' },
		reason: 'The bid was placed after the Auction had closed.'
	};

	it('renders the actor, the before/after rows and the reason verbatim', () => {
		const entry = only([event(BID_VOIDED_EVENT, overridePayload)]);
		const text = rendered(entry);
		expect(text).toContain('Kings — Dana');
		expect(text).toContain('$8.5M → $8.0M');
		expect(text).toContain('Active/Bench → Minor League');
		expect(text).toContain(overridePayload.reason);
	});

	it('makes the override actor’s Team a party the Team filter matches', () => {
		// A Team no base renderer and no id harvest already surfaces: this
		// payload names it nowhere else, and the envelope actor is a different
		// Team entirely.
		const entry = only([event(BID_VOIDED_EVENT, overridePayload)]);
		expect(entry.teams).toContain(TEAM_OVERRIDE);

		const rows = auditRowsFor([event(BID_VOIDED_EVENT, overridePayload)], REFERENCES);
		const filter: AuditFilter = {
			team: TEAM_OVERRIDE,
			player: null,
			type: null
		};
		expect(filterAuditRows(rows, filter)).toHaveLength(1);
	});

	it('renders exactly one Reason row when a state field is itself called Reason', () => {
		const collision = {
			...overridePayload,
			before: { Reason: 'the first reason' },
			after: { Reason: 'the second reason' }
		};
		const entry = only([event(BID_VOIDED_EVENT, collision)]);
		const reasonRows = entry.details.filter((detail) => detail.label === 'Reason');
		expect(reasonRows).toHaveLength(1);
		expect(reasonRows[0]?.value).toBe(overridePayload.reason);
		// And the changed field is still rendered, under a disambiguated label.
		expect(rendered(entry)).toContain('the first reason → the second reason');
	});

	it('renders on ANY event type carrying the shape, not on a named list', () => {
		const onAClose = { ...AUCTION_CLOSED, ...overridePayload };
		const entry = only([event(AUCTION_CLOSED_EVENT, onAClose)]);
		expect(rendered(entry)).toContain(overridePayload.reason);
		// The base renderer still ran.
		expect(entry.headline).toContain('Jalen Green');
	});
});

describe('the filters', () => {
	const events = everyKnownEvent();
	const rows = auditRowsFor(events, REFERENCES);

	it('finds a Team released by a dissolution under its own filter', () => {
		const matched = filterAuditRows(rows, {
			team: TEAM_C,
			player: null,
			type: null
		});
		expect(matched.some((entry) => entry.type === CONTENTION_DISSOLVED_EVENT)).toBe(true);
	});

	it('finds an outstanding Team under its own filter', () => {
		const matched = filterAuditRows(rows, {
			team: TEAM_B,
			player: null,
			type: null
		});
		expect(matched.some((entry) => entry.type === ASSIGNMENT_DEADLINE_PASSED_EVENT)).toBe(true);
	});

	it('finds an imported and an auction-opened Team under its own filter', () => {
		const matched = filterAuditRows(rows, {
			team: TEAM_B,
			player: null,
			type: null
		});
		expect(matched.some((entry) => entry.type === IMPORT_PROMOTED_EVENT)).toBe(true);
		expect(matched.some((entry) => entry.type === AUCTION_OPENED_EVENT)).toBe(true);
	});

	// A cancellation's OWN parties, isolated.
	//
	// Asserting these against the shared `everyKnownEvent()` log would prove
	// nothing: `TEAM_B` is independently contributed by the dissolution, the
	// deadline marker, the import and the auction-open fixtures, and
	// `PLAYER_TWO` by the phase boundary's terminated list — so deleting
	// `restoration.teamId` and `causeFantraxPlayerId` from `renderBidCancelled`
	// entirely would leave every aggregate assertion green. These two drive a
	// log holding the cancellation and nothing else.
	it('finds a Team handed the lead by a cancellation under its own filter', () => {
		const alone = auditRowsFor([event(BID_CANCELLED_EVENT, BID_CANCELLED)], REFERENCES);
		const matched = filterAuditRows(alone, { team: TEAM_B, player: null, type: null });
		expect(matched.some((entry) => entry.type === BID_CANCELLED_EVENT)).toBe(true);
	});

	it('finds the Player whose close CAUSED a cancellation under its own filter', () => {
		const alone = auditRowsFor([event(BID_CANCELLED_EVENT, BID_CANCELLED)], REFERENCES);
		const matched = filterAuditRows(alone, { team: null, player: PLAYER_TWO, type: null });
		expect(matched.some((entry) => entry.type === BID_CANCELLED_EVENT)).toBe(true);
	});

	it('filters by Player', () => {
		const matched = filterAuditRows(rows, {
			team: null,
			player: PLAYER_TWO,
			type: null
		});
		expect(matched.length).toBeGreaterThan(0);
		for (const entry of matched) expect(entry.players).toContain(PLAYER_TWO);
		// The cancellation is one of them, by its cause Player and not its own.
		expect(matched.some((entry) => entry.type === BID_CANCELLED_EVENT)).toBe(true);
		// The terminated Player on a phase boundary is one of them.
		expect(matched.some((entry) => entry.type === CONTRACT_ASSIGNMENT_OPENED_EVENT)).toBe(true);
	});

	it('filters by type', () => {
		const matched = filterAuditRows(rows, {
			team: null,
			player: null,
			type: BID_PLACED_EVENT
		});
		expect(matched).toHaveLength(1);
		expect(matched[0]?.type).toBe(BID_PLACED_EVENT);
	});

	it('conjoins all three', () => {
		const matched = filterAuditRows(rows, {
			team: TEAM_A,
			player: PLAYER_ONE,
			type: BID_PLACED_EVENT
		});
		expect(matched).toHaveLength(1);

		const contradiction = filterAuditRows(rows, {
			team: TEAM_C,
			player: PLAYER_ONE,
			type: BID_PLACED_EVENT
		});
		expect(contradiction).toHaveLength(0);
	});

	it('returns an empty result for an unknown Team or Player rather than refusing', () => {
		expect(filterAuditRows(rows, { team: 'nobody', player: null, type: null })).toHaveLength(0);
		expect(filterAuditRows(rows, { team: null, player: 'nobody', type: null })).toHaveLength(0);
	});

	it('refuses an unrecognised type rather than ignoring it', () => {
		const knownTypes = auditTypeOptions(rows).map((option) => option.value);
		const outcome = parseAuditQuery((key) => (key === 'type' ? 'NotAnEvent' : null), knownTypes);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.refusal).toBe(UNKNOWN_TYPE_REFUSAL);
	});

	it('accepts a type present in the log but unworded by the registry', () => {
		const withUnworded = auditRowsFor([...events, event('Unworded', {})], REFERENCES);
		const knownTypes = auditTypeOptions(withUnworded).map((option) => option.value);
		const outcome = parseAuditQuery((key) => (key === 'type' ? 'Unworded' : null), knownTypes);
		expect(outcome.ok).toBe(true);
	});

	it('treats a blank parameter as no filter at all', () => {
		const outcome = parseAuditQuery(() => '   ', KNOWN_AUDIT_TYPES);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.filter).toEqual({ team: null, player: null, type: null });
	});

	it('draws its options from the whole Log and not from the filtered rows', () => {
		// A single `BidPlaced` names one Team. Drawn from the filtered view, the
		// Team control would collapse to that one choice and a reader could
		// never widen the filter without clearing it first.
		const filtered = filterAuditRows(rows, {
			team: null,
			player: null,
			type: BID_PLACED_EVENT
		});
		expect(auditTeamOptions(filtered, REFERENCES)).toHaveLength(1);
		expect(auditTeamOptions(rows, REFERENCES).length).toBeGreaterThan(1);
	});

	it('labels an unresolved option as the id it is, and only there', () => {
		const rowsWithoutNames = auditRowsFor(events, NO_REFERENCES);
		const option = auditTeamOptions(rowsWithoutNames, NO_REFERENCES).find(
			(candidate) => candidate.value === TEAM_A
		);
		expect(option?.label).toContain('id');
		expect(option?.label).toContain(TEAM_A);
	});

	it('round-trips the filter into the export query string', () => {
		expect(auditQueryString({ team: TEAM_A, player: null, type: BID_PLACED_EVENT })).toBe(
			`?team=${TEAM_A}&type=${BID_PLACED_EVENT}`
		);
		expect(auditQueryString({ team: null, player: null, type: null })).toBe('');
	});
});

describe('the sealed seed', () => {
	// An OPEN Minimum-Bid Contention alongside a DRAWN one, in the same Log.
	//
	// The pairing is the point. A log holding only the open contention would
	// make the negative assertion unfalsifiable: `BidPlacedPayload` declares no
	// `seed` field at all, so no implementation of this surface could ever put
	// one on that row, and the test would pass against a renderer that leaked
	// every seed it was given. The drawn contention supplies a seed that IS in
	// the log, so the search is proven able to find one before it is asked to
	// find none.
	const OPEN_COMMITMENT = 'open-commitment-hash';
	const DRAWN_SEED = 'drawn-revealed-seed';

	const open: BidPlacedPayload = {
		...BID_PLACED,
		fantraxPlayerId: PLAYER_TWO,
		seedHash: OPEN_COMMITMENT
	};
	const drawn: DrawnContentionPayload = { ...CONTENTION_DRAWN, seed: DRAWN_SEED };

	const rows = auditRowsFor(
		[event(BID_PLACED_EVENT, open), event(CONTENTION_DRAWN_EVENT, drawn)],
		REFERENCES
	);
	const openRow = rows.find((entry) => entry.type === BID_PLACED_EVENT);
	const drawnRow = rows.find((entry) => entry.type === CONTENTION_DRAWN_EVENT);

	it('reveals the seed of a contention that HAS drawn', () => {
		// The control: this is what proves the assertions below can fail.
		expect(rendered(drawnRow as AuditRow)).toContain(DRAWN_SEED);
	});

	it('states the commitment for a contention still open', () => {
		expect(rendered(openRow as AuditRow)).toContain(OPEN_COMMITMENT);
	});

	it('attaches no revealed seed to the contention still open', () => {
		// The whole row is searched — headline, actor, labels and every detail
		// value — because the unrecognised-type fallback serialises payloads
		// verbatim and would carry a leaked seed straight through.
		expect(rendered(openRow as AuditRow)).not.toContain(DRAWN_SEED);
	});

	it('leaks no seed across rows anywhere in the response', () => {
		// The seed that exists belongs to exactly one entry. If any other row
		// carried it, the Log would be revealing a seed the log did not record
		// against that event.
		const carrying = rows.filter((entry) => rendered(entry).includes(DRAWN_SEED));
		expect(carrying).toHaveLength(1);
		expect(carrying[0]?.type).toBe(CONTENTION_DRAWN_EVENT);
	});
});

describe('an empty log', () => {
	it('renders no rows and is not an error', () => {
		expect(auditRowsFor([], REFERENCES)).toEqual([]);
		expect(auditCountSentence(0, 0)).toBe('0 entries.');
	});
});

describe('the party harvest', () => {
	it('names every id the server must resolve, including the ones only a list carries', () => {
		const rows = auditRowsFor(everyKnownEvent(), NO_REFERENCES);
		const { teamIds, playerIds, managerIds } = auditPartyIds(rows);

		expect(teamIds).toContain(TEAM_B);
		expect(teamIds).toContain(TEAM_C);
		expect(playerIds).toContain(PLAYER_ONE);
		expect(playerIds).toContain(PLAYER_TWO);
		expect(managerIds).toContain(MANAGER_A);

		// And the override actor's Manager, which no envelope carries.
		const overrideRows = auditRowsFor(
			[
				event(BID_VOIDED_EVENT, {
					actor: {
						managerId: 'manager-x',
						teamId: TEAM_OVERRIDE,
						displayName: 'Dana'
					},
					before: {},
					after: {},
					reason: 'because'
				})
			],
			NO_REFERENCES
		);
		expect(auditPartyIds(overrideRows).managerIds).toContain('manager-x');
	});

	it('offers a Player option for every Player the Log names', () => {
		const rows = auditRowsFor(everyKnownEvent(), REFERENCES);
		const labels = auditPlayerOptions(rows, REFERENCES).map((option) => option.label);
		expect(labels).toContain('Jalen Green');
		expect(labels).toContain('Alperen Sengun');
	});
});

describe('the count sentence', () => {
	it('says how many of how many when a filter is in force', () => {
		expect(auditCountSentence(3, 19)).toBe('3 of 19 entries.');
		expect(auditCountSentence(1, 1)).toBe('1 entry.');
	});
});

describe('a Close Reversal (Story 7.13, FR-32, FR-33)', () => {
	it('is its own entry, labelled Close Reversal, with the reason first', () => {
		const entry = only([event(AUCTION_CLOSE_REVERSED_EVENT, CLOSE_REVERSED)]);
		expect(entry.typeLabel).toBe('Close Reversal');
		expect(entry.headline).toBe('The Close that gave Jalen Green to Lakers was reversed.');
		expect(entry.details[0]).toEqual({
			label: 'Reason',
			value: 'Lakers held an IR Contract against the free-agency rule.'
		});
		// Printed once: the base renderer files the reason, and the override
		// merge does not file it a second time.
		expect(entry.details.filter((detail) => detail.label === 'Reason')).toHaveLength(1);
	});

	it('states the close it names, the Slot, and every cancellation that stands', () => {
		const text = rendered(only([event(AUCTION_CLOSE_REVERSED_EVENT, CLOSE_REVERSED)]));
		expect(text).toContain('Reversed close 4');
		expect(text).toContain('Nomination Slot Re-held — Alperen Sengun');
		expect(text).toContain('Celtics on Alperen Sengun (Bulls still leads)');
		expect(text).toContain('Lakers — Cap Space $5.0M → $9.0M');
		expect(text).toContain('Lakers — Maximum Bid $4.0M → $7.0M');
		// No raw token and no `before`/`after` override map printed raw.
		expect(text).not.toContain('active_bench');
		expect(text).not.toContain(TEAM_A);
	});

	it('makes the cancelled and restored Teams parties, so their filters find it', () => {
		const entry = only([event(AUCTION_CLOSE_REVERSED_EVENT, CLOSE_REVERSED)]);
		expect(entry.teams).toEqual(expect.arrayContaining([TEAM_A, TEAM_B, TEAM_C]));
		expect(entry.players).toEqual(expect.arrayContaining([PLAYER_ONE, PLAYER_TWO]));
	});

	it('marks the reversed AuctionClosed Reversed on its own row, and leaves it in the Log', () => {
		const closed = event(AUCTION_CLOSED_EVENT, AUCTION_CLOSED);
		const reversal = event(AUCTION_CLOSE_REVERSED_EVENT, { ...CLOSE_REVERSED, closeSeq: closed.seq });
		const events = [closed, reversal];
		const refs: AuditReferences = { ...REFERENCES, reversedCloses: reversedClosesIn(events) };
		const rows = auditRowsFor(events, refs);
		expect(rows).toHaveLength(2);
		const closeRow = rows.find((entry) => entry.seq === closed.seq);
		expect(closeRow?.details.at(-1)).toEqual({
			label: 'Outcome',
			value: `Reversed — see entry ${reversal.seq}`
		});
		// An un-reversed close carries no Outcome row.
		const standing = auditRowsFor([closed], REFERENCES)[0];
		expect(standing?.details.some((detail) => detail.label === 'Outcome')).toBe(false);
	});

	it('maps a reversed close to the FIRST reversal naming it', () => {
		const first = event(AUCTION_CLOSE_REVERSED_EVENT, { ...CLOSE_REVERSED, closeSeq: '77' });
		const second = event(AUCTION_CLOSE_REVERSED_EVENT, { ...CLOSE_REVERSED, closeSeq: '77' });
		expect(reversedClosesIn([second, first]).get('77')).toBe(first.seq);
	});
});
