/**
 * The Roster Trade's remaining grounds, and the surface that carries them
 * (Story 7.7, FR-41).
 *
 * The five §10 examples own the narrated cases. This file owns the rest of the
 * I/O matrix — the contested ground, a Player nobody holds, two eligible
 * minors arriving at one free Slot, the blank reason, the archived phase — and
 * the structural properties the gate set is supposed to have.
 *
 * `vite.config.ts` pins `environment: 'node'` and no `.svelte` file renders
 * under the suite, so the surface's claims are proven by **source-text
 * assertion**, which is `tests/structure.test.ts`'s own mechanism.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MINOR_LEAGUE_SLOTS } from '../src/lib/core/constants.ts';
import { parseMoney } from '../src/lib/core/money.ts';
import type { Auction, OpenAuctions } from '../src/lib/core/projection/auctions.ts';
import { INITIAL_AUCTIONS } from '../src/lib/core/projection/auctions.ts';
import { INITIAL_NOMINATIONS } from '../src/lib/core/projection/nominations.ts';
import type { OpenNominations } from '../src/lib/core/projection/nominations.ts';
import { OVERRIDE_ARCHIVED_STATUS, OVERRIDE_REASON_REQUIRED_STATUS } from '../src/lib/server/override-guard.ts';
import { requireOverridablePhase, requireOverrideReason } from '../src/lib/server/override-guard.ts';
import {
	allTradeGatesPassed,
	capHitChangeSentence,
	clearedLengthSentence,
	evaluateTrade,
	rosterTradeRefusalDetail,
	transferAttention
} from '../src/lib/core/rules/roster-trade.ts';
import { describeActAmount } from '../src/lib/core/rules/roster-act.ts';
import type { TradingPlayer, RosterTradeState } from '../src/lib/core/rules/roster-trade.ts';
import { rosterTradeActSentence, rosterTradeReasonRows } from '../src/lib/reason-sheet-view.ts';
import { RECORD_ROSTER_TRADE_GATES } from '../src/lib/core/types.ts';
import type { GateResults, RecordRosterTrade, RecordRosterTradeGateResults } from '../src/lib/core/types.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path: string): string => readFileSync(join(ROOT, ...path.split('/')), 'utf8');

const CLOSES_AT = '2026-09-11T09:00:00.000Z';

function player(
	id: string,
	name: string,
	kind: TradingPlayer['rosterSlotKind'],
	value: number
): TradingPlayer {
	return {
		fantraxPlayerId: id,
		playerName: name,
		rosterSlotKind: kind,
		value: parseMoney(value),
		won: false,
		contractYears: null
	};
}

function stateOf(
	sendingRows: readonly TradingPlayer[],
	receivingRows: readonly TradingPlayer[],
	extras: Partial<RosterTradeState> = {}
): RosterTradeState {
	return {
		sending: { teamId: 't-1', teamName: 'Team One', rows: sendingRows },
		receiving: { teamId: 't-2', teamName: 'Team Two', rows: receivingRows },
		auctions: INITIAL_AUCTIONS,
		nominations: INITIAL_NOMINATIONS,
		isMinorLeagueEligible: () => false,
		playerNameFor: (id) => id,
		...extras
	};
}

function tradeOf(sending: readonly string[], receiving: readonly string[] = []): RecordRosterTrade {
	return {
		kind: 'RecordRosterTrade',
		sendingTeamId: 't-1',
		sendingTeamName: 'Team One',
		receivingTeamId: 't-2',
		receivingTeamName: 'Team Two',
		sendingPlayerIds: sending,
		receivingPlayerIds: receiving,
		reason: 'Recorded from the league channel.'
	};
}

describe('the contested ground — checked before cap and slots', () => {
	const bidOn: Auction = {
		fantraxPlayerId: 'p-bid',
		contention: 'standard',
		leadingBid: {
			seq: '3',
			teamId: 't-9',
			teamName: 'Team Nine',
			managerId: 'm-9',
			amount: parseMoney(2_000_000),
			occurredAt: '2026-09-10T09:00:00.000Z',
			closesAt: CLOSES_AT,
			seedHash: null
		},
		closesAt: CLOSES_AT,
		bids: [],
		contenders: [],
		seedHash: null,
		seed: null
	};
	const auctions: OpenAuctions = { byPlayer: { 'p-bid': bidOn } };

	const nominated: OpenNominations = {
		byPlayer: {
			'p-nom': {
				fantraxPlayerId: 'p-nom',
				playerName: 'Nominee',
				teamId: 't-9',
				teamName: 'Team Nine',
				managerId: 'm-9',
				holdsSlot: true,
				occurredAt: '2026-09-10T09:00:00.000Z'
			}
		},
		byTeam: {}
	};

	it('refuses a Player being bid on, naming him and what contests him', () => {
		const outcome = evaluateTrade(
			stateOf([player('p-keep', 'Keeper', 'active_bench', 1_000_000)], [], {
				auctions,
				playerNameFor: (id) => (id === 'p-bid' ? 'Contested Player' : id)
			}),
			tradeOf(['p-bid'])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('gates');
		expect(outcome.gates?.contested.passed).toBe(false);
		expect(outcome.gates?.contested.contested).toEqual([
			{ fantraxPlayerId: 'p-bid', playerName: 'Contested Player', contest: 'bid' }
		]);

		const detail = rosterTradeRefusalDetail(outcome.refusal, outcome.gates);
		expect(detail).toContain('Contested Player');
		expect(detail).toContain('open Auction');
	});

	it('refuses a Player who is merely nominated — nobody holds him yet either', () => {
		const outcome = evaluateTrade(
			stateOf([], [], { nominations: nominated }),
			tradeOf(['p-nom'])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.gates?.contested.contested[0]?.contest).toBe('nomination');
		expect(rosterTradeRefusalDetail(outcome.refusal, outcome.gates)).toContain(
			'awaiting an opening Bid'
		);
	});

	it('is decided BEFORE "not held" — a contested Player is not reported as missing', () => {
		// The contested Player is on nobody's roster, which is exactly what being
		// contested means. Reporting that as "not a Contract this Team holds"
		// would send the Commissioner looking for a data problem.
		const outcome = evaluateTrade(stateOf([], [], { auctions }), tradeOf(['p-bid']));

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('gates');
		expect(outcome.gates?.contested.passed).toBe(false);
	});

	it('still returns all five gates — no gate short-circuits another (AD-7)', () => {
		const outcome = evaluateTrade(
			stateOf([player('p-keep', 'Keeper', 'active_bench', 1_000_000)], [], { auctions }),
			tradeOf(['p-bid'])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused' || outcome.gates === null) return;
		for (const gate of RECORD_ROSTER_TRADE_GATES) {
			expect(outcome.gates[gate]).toHaveProperty('passed');
		}
	});
});

describe('a Player the named Team does not hold', () => {
	it('is refused as malformed, with no figures to show', () => {
		const outcome = evaluateTrade(
			stateOf([player('p-1', 'Held', 'active_bench', 1_000_000)], []),
			tradeOf(['p-absent'])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('not_held');
		expect(outcome.gates).toBeNull();
		expect(rosterTradeRefusalDetail(outcome.refusal, outcome.gates)).toContain('Team One');
	});

	it('treats Dead Money as not a Contract — it is a charge, and it does not travel', () => {
		const outcome = evaluateTrade(
			stateOf([player('p-dead', 'Released', 'dead_money', 2_000_000)], []),
			tradeOf(['p-dead'])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('not_held');
	});

	it('still counts Dead Money against the Cap on both sides of the Trade', () => {
		const outcome = evaluateTrade(
			stateOf(
				[
					player('p-dead', 'Released', 'dead_money', 2_000_000),
					player('p-1', 'Held', 'active_bench', 1_000_000)
				],
				[]
			),
			tradeOf(['p-1'])
		);

		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;
		// The Dead Money charge stands after the Trade, unchanged: Cap Space is
		// `165,000,000 − 2,000,000`.
		expect(outcome.delta.sendingAfter.capSpace).toBe(163_000_000);
		expect(outcome.delta.sendingAfter.rosterCount).toBe(0);
	});
});

describe('two eligible minors arriving at one free Minor League Slot', () => {
	it('lands the first by fantraxPlayerId in the Slot and charges the second', () => {
		const sending = [
			player('p-bbb', 'Second Alphabetically', 'minor_league', 5_000_000),
			player('p-aaa', 'First Alphabetically', 'minor_league', 3_000_000)
		];
		// Team Two already holds two of its three Minor League Slots.
		const receiving = [
			player('p-r1', 'R One', 'minor_league', 1_000_000),
			player('p-r2', 'R Two', 'minor_league', 1_000_000)
		];

		const outcome = evaluateTrade(stateOf(sending, receiving), tradeOf(['p-aaa', 'p-bbb']));

		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		const [first, second] = outcome.delta.transfers;
		// **Sorted by `fantraxPlayerId`** (AD-5), so this is the same answer on
		// every replay rather than an accident of the form's field order.
		expect(first?.fantraxPlayerId).toBe('p-aaa');
		expect(first?.toPlacement).toBe('minor_league');
		expect(first?.capHitAfter).toBe(0);

		expect(second?.fantraxPlayerId).toBe('p-bbb');
		expect(second?.toPlacement).toBe('active_bench');
		expect(second?.capHitAfter).toBe(5_000_000);

		// The receiving Team ends at the ceiling, not above it.
		expect(outcome.delta.receivingAfter.minorLeagueOccupied).toBe(MINOR_LEAGUE_SLOTS);
		expect(outcome.delta.receivingAfter.rosterCount).toBe(1);
		expect(outcome.gates.receivingSlots.passed).toBe(true);
	});

	it('states the changed Cap Hit in words, and says nothing where it did not change', () => {
		const outcome = evaluateTrade(
			stateOf(
				[player('p-stash', 'Stashed', 'minor_league', 5_000_000)],
				[
					player('p-r1', 'R One', 'minor_league', 1_000_000),
					player('p-r2', 'R Two', 'minor_league', 1_000_000),
					player('p-r3', 'R Three', 'minor_league', 1_000_000)
				]
			),
			tradeOf(['p-stash'])
		);

		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		const sentence = capHitChangeSentence(outcome.delta.transfers[0]!);
		expect(sentence).toContain('Stashed');
		expect(sentence).toContain('Minor League');
		expect(sentence).toContain('Active/Bench');
		expect(sentence).toContain('$5.0M');
		expect(sentence).toContain('Team Two');

		// A Contract that did not change Slot carries no sentence: the amber
		// marker is the product's single attention colour.
		const unchanged = evaluateTrade(
			stateOf([player('p-plain', 'Plain', 'active_bench', 1_000_000)], []),
			tradeOf(['p-plain'])
		);
		expect(unchanged.kind).toBe('permitted');
		if (unchanged.kind !== 'permitted') return;
		expect(capHitChangeSentence(unchanged.delta.transfers[0]!)).toBeNull();
	});

	it('arrives an Injury Reserve row unchanged — IR is a Fantrax fact, not a placement', () => {
		const outcome = evaluateTrade(
			stateOf([player('p-ir', 'Injured', 'injury_reserve', 4_000_000)], []),
			tradeOf(['p-ir'])
		);

		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;
		expect(outcome.delta.transfers[0]?.toPlacement).toBe('injury_reserve');
		// IR is not zeroed by `chargedCapHit`, so it charges in full on arrival.
		expect(outcome.delta.transfers[0]?.capHitAfter).toBe(4_000_000);
		expect(outcome.delta.receivingAfter.injuryReserveOccupied).toBe(1);
		expect(outcome.delta.receivingAfter.rosterCount).toBe(0);
	});

	it('refuses a third Injury Reserve row — FR-1s ceiling of two, asked of a Trade', () => {
		const outcome = evaluateTrade(
			stateOf(
				[player('p-ir', 'Injured', 'injury_reserve', 4_000_000)],
				[
					player('p-r1', 'R One', 'injury_reserve', 1_000_000),
					player('p-r2', 'R Two', 'injury_reserve', 1_000_000)
				]
			),
			tradeOf(['p-ir'])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.gates?.receivingSlots.breaches).toEqual(['injury_reserve']);
		expect(rosterTradeRefusalDetail(outcome.refusal, outcome.gates)).toContain('Injury Reserve');
	});
});

describe('a Contract named twice', () => {
	it('travels once — a Trade cannot count one Player twice', () => {
		const outcome = evaluateTrade(
			stateOf([player('p-1', 'Powell', 'active_bench', 9_000_000)], []),
			tradeOf(['p-1', 'p-1'])
		);

		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;
		expect(outcome.delta.transfers).toHaveLength(1);
		// Counted once on both sides, which is what the dedup is for.
		expect(outcome.delta.sendingAfter.rosterCount).toBe(0);
		expect(outcome.delta.receivingAfter.rosterCount).toBe(1);
	});

	it('named in BOTH directions, REFUSES the whole Trade as incoherent', () => {
		const outcome = evaluateTrade(
			stateOf([player('p-1', 'Powell', 'active_bench', 9_000_000)], []),
			tradeOf(['p-1'], ['p-1'])
		);

		// He cannot travel both ways, and choosing one of them for the
		// Commissioner would commit a Trade nobody agreed. The two lists disagree
		// about who holds him, which is a mistake in the ACT.
		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('named_both_ways');
		// A shape refusal, so there are no figures to show: there is no coherent
		// post-Trade state for any gate to have been evaluated against.
		expect(outcome.gates).toBeNull();

		const detail = rosterTradeRefusalDetail(outcome.refusal, outcome.gates);
		expect(detail).toContain('Powell');
		expect(detail).toContain('both sides');
	});

	it('is refused BEFORE the contested ground, because no state can be built', () => {
		// Even when the Player named both ways is also contested, the shape
		// ground answers first: a Trade that says two contradictory things has
		// nothing for a gate to judge.
		const outcome = evaluateTrade(
			stateOf([player('p-1', 'Powell', 'active_bench', 9_000_000)], []),
			tradeOf(['p-1', 'p-9'], ['p-1'])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('named_both_ways');
	});
});

describe('the gate set', () => {
	it('is flat, frozen, and assignable to GateResults', () => {
		expect(Object.isFrozen(RECORD_ROSTER_TRADE_GATES)).toBe(true);
		expect([...RECORD_ROSTER_TRADE_GATES]).toEqual([
			'contested',
			'sendingCap',
			'sendingSlots',
			'receivingCap',
			'receivingSlots'
		]);

		const outcome = evaluateTrade(
			stateOf([player('p-1', 'Held', 'active_bench', 1_000_000)], []),
			tradeOf(['p-1'])
		);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		// The assignment is the assertion: a gate set with a nested per-Team
		// object would not compile here.
		const asGeneral: GateResults = outcome.gates;
		expect(Object.keys(asGeneral).sort()).toEqual([...RECORD_ROSTER_TRADE_GATES].sort());
	});

	it('reads the NAME LIST, so a missing key cannot pass by having nothing to fail', () => {
		const partial = {
			contested: { passed: true, contested: [] }
		} as unknown as RecordRosterTradeGateResults;

		// `gates[gate]` is `undefined` for the four absent names, so this throws
		// rather than answering `true`. A loop over the result's OWN keys would
		// have said the Trade passed.
		expect(() => allTradeGatesPassed(partial)).toThrow();
	});
});

describe('the reason sheet a Trade renders', () => {
	it('states five figures for BOTH Teams with the Players named between them', () => {
		const outcome = evaluateTrade(
			stateOf(
				[player('p-1', 'Powell', 'active_bench', 9_000_000)],
				[player('p-2', 'Sharpe', 'active_bench', 4_000_000)]
			),
			tradeOf(['p-1'], ['p-2'])
		);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		const rows = rosterTradeReasonRows(outcome.delta);
		const labels = rows.map((row) => row.label);

		expect(labels).toEqual([
			'Team One · Cap Space',
			'Team One · Roster Count',
			'Team One · Active/Bench',
			'Team One · Injury Reserve',
			'Team One · Minor League',
			// The moved Players, between the two Teams.
			'Powell',
			'Sharpe',
			'Team Two · Cap Space',
			'Team Two · Roster Count',
			'Team Two · Active/Bench',
			'Team Two · Injury Reserve',
			'Team Two · Minor League'
		]);

		// Every row states both sides, and the occupancies state their ceiling.
		expect(rows[0]?.before).toBe('$156.0M');
		expect(rows[0]?.after).toBe('$161.0M');
		expect(rows[2]?.after).toBe('1 of 12');
		expect(rows[4]?.after).toBe('0 of 3');
	});

	it('names an empty direction in words rather than leaving it unsaid', () => {
		const outcome = evaluateTrade(
			stateOf([player('p-1', 'Powell', 'active_bench', 9_000_000)], []),
			tradeOf(['p-1'])
		);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		expect(rosterTradeActSentence(outcome.delta)).toBe(
			'Record that Team One sends Powell to Team Two and receives nothing back.'
		);
	});
});

describe('the cleared contract length, stated in words before commit', () => {
	/** §10 example 42's shape: the Cap Hit does not move, but the length goes. */
	function powellWithALength(years: 1 | 2 | 3 | 4): RosterTradeState {
		return stateOf(
			[
				{
					fantraxPlayerId: 'p-powell',
					playerName: 'Powell',
					rosterSlotKind: 'active_bench',
					value: parseMoney(9_000_000),
					won: true,
					contractYears: years
				}
			],
			[]
		);
	}

	it('warns that the length is CLEARED even though the Cap Hit never moves', () => {
		const outcome = evaluateTrade(powellWithALength(3), tradeOf(['p-powell']));
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		const transfer = outcome.delta.transfers[0]!;
		// The Cap Hit is $9,000,000 on both sides, so the OTHER sentence says
		// nothing at all — which is exactly why this one has to exist.
		expect(transfer.capHitBefore).toBe(transfer.capHitAfter);
		expect(capHitChangeSentence(transfer)).toBeNull();

		const sentence = clearedLengthSentence(transfer);
		expect(sentence).toContain('Powell');
		expect(sentence).toContain('3-year');
		expect(sentence).toContain('CLEARS');
		expect(sentence).toContain('Year Allotment');
		expect(sentence).toContain('export stays blocked');
	});

	it('says nothing where no length was assigned', () => {
		const outcome = evaluateTrade(
			stateOf([player('p-1', 'Plain', 'active_bench', 1_000_000)], []),
			tradeOf(['p-1'])
		);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		expect(clearedLengthSentence(outcome.delta.transfers[0]!)).toBeNull();
		expect(transferAttention(outcome.delta.transfers[0]!)).toBeNull();
	});

	it('reaches the SHEET, on the moved Player’s own row', () => {
		const outcome = evaluateTrade(powellWithALength(3), tradeOf(['p-powell']));
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		const row = rosterTradeReasonRows(outcome.delta).find((entry) => entry.label === 'Powell');
		expect(row?.attention).toContain('CLEARS');
	});

	it('carries BOTH sentences when a stashed Player with a length is re-placed', () => {
		const state = stateOf(
			[
				{
					fantraxPlayerId: 'p-ellis',
					playerName: 'Ellis',
					rosterSlotKind: 'minor_league',
					value: parseMoney(18_000_000),
					won: true,
					contractYears: 2
				}
			],
			[
				player('p-r1', 'R One', 'minor_league', 1_000_000),
				player('p-r2', 'R Two', 'minor_league', 1_000_000),
				player('p-r3', 'R Three', 'minor_league', 1_000_000)
			]
		);
		const outcome = evaluateTrade(state, tradeOf(['p-ellis']));
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		const attention = transferAttention(outcome.delta.transfers[0]!);
		// One `attention` string per row, so the two sentences are joined rather
		// than one of them being chosen over the other.
		expect(attention).toContain('Cap Hit changes from');
		expect(attention).toContain('CLEARS');
	});
});

describe('money on a sheet a Commissioner is about to commit against', () => {
	it('states an OFF-GRID Cap Space exactly, rather than declining to name it', () => {
		// `rules/roster-import.ts` asserts no money grid, so an imported Cap Hit
		// is whatever Fantrax held — and $6,700,000 is not on the $500,000 grid.
		const outcome = evaluateTrade(
			stateOf([player('p-1', 'Odd', 'active_bench', 6_700_000)], []),
			tradeOf(['p-1'])
		);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		const rows = rosterTradeReasonRows(outcome.delta);
		const capSpace = rows.find((row) => row.label === 'Team One · Cap Space');
		expect(capSpace?.before).toBe('$158,300,000');
		expect(capSpace?.after).toBe('$165.0M');
		// The hedge `describeAmount` would have printed, absent from the sheet.
		expect(JSON.stringify(rows)).not.toContain('not on the grid');
	});

	it('keeps the abbreviated rendering where it is lossless', () => {
		expect(describeActAmount(parseMoney(6_500_000))).toBe('$6.5M');
		expect(describeActAmount(parseMoney(0))).toBe('$0.0M');
		// ...and falls back to exact grouped dollars where it is not.
		expect(describeActAmount(parseMoney(300_000))).toBe('$300,000');
		expect(describeActAmount(parseMoney(-300_000))).toBe('−$300,000');
	});
});

describe('the two server-side guards this surface is the first to call', () => {
	it('refuses a blank reason with 400, before anything is written', () => {
		const blank = { get: () => '   ​  ' };
		expect(() => requireOverrideReason(blank)).toThrowError(
			expect.objectContaining({ status: OVERRIDE_REASON_REQUIRED_STATUS })
		);

		const absent = { get: () => null };
		expect(() => requireOverrideReason(absent)).toThrowError(
			expect.objectContaining({ status: OVERRIDE_REASON_REQUIRED_STATUS })
		);

		// A real reason comes back trimmed.
		expect(requireOverrideReason({ get: () => '  Agreed in Discord.\n' })).toBe(
			'Agreed in Discord.'
		);
	});

	it('refuses every Trade once the League is Archived, with 403', () => {
		expect(() => requireOverridablePhase('Archived')).toThrowError(
			expect.objectContaining({ status: OVERRIDE_ARCHIVED_STATUS })
		);
		expect(() => requireOverridablePhase('Auction')).not.toThrow();
		expect(() => requireOverridablePhase('Contract Assignment')).not.toThrow();
	});
});

describe('the /roster-trade surface, by source-text assertion', () => {
	/**
	 * Comments stripped — HTML, block and line alike.
	 *
	 * The guards below assert what the surface DOES, and a file that explains
	 * why it does not cancel a Bid would otherwise fail the test that says it
	 * does not cancel a Bid. `tests/reason-sheet.test.ts` strips the same way
	 * for the same reason.
	 */
	function code(path: string): string {
		return read(path)
			.replace(/<!--[\s\S]*?-->/g, '')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '');
	}

	const SERVER = code('src/routes/roster-trade/+page.server.ts');
	const PAGE = code('src/routes/roster-trade/+page.svelte');
	const MODULE = code('src/lib/server/roster-trade.ts');

	it('calls all three guards, in `load` AND in the action', () => {
		// One `guard(locals)` helper holding all three, called twice — so the
		// two cannot drift apart.
		expect(SERVER).toMatch(/requireCommissioner\(locals\.session\)/);
		expect(SERVER).toMatch(/requireLiveDestination\(/);
		expect(SERVER).toMatch(/requireOverridablePhase\(locals\.phase\.name\)/);
		expect(SERVER.match(/guard\(locals\);/g)).toHaveLength(2);
	});

	it('leaves NO redirect behind: /roster-move belongs to Story 7.11, not to this act', () => {
		// Story 7.10's rename freed the name and Story 7.11 claimed it: the
		// route now exists and serves FR-44's within-Team rearrangement. What
		// must still be true is that the Trade does not reach for it — a
		// redirect from here would keep the old vocabulary alive and would land
		// a Commissioner looking for a Trade on a different act entirely.
		expect(existsSync(join(ROOT, 'src', 'routes', 'roster-move'))).toBe(true);
		expect(read('src/routes/roster-move/+page.svelte')).toMatch(/Record a Roster Move/);
		expect(SERVER).not.toMatch(/roster-move/);
		expect(PAGE).not.toMatch(/roster-move/);
	});

	it('validates the reason server-side before the write', () => {
		expect(SERVER).toMatch(/requireOverrideReason\(form\)/);
		// And the actor is the session's, never a form field.
		expect(SERVER).not.toMatch(/form\.get\('managerId'\)|form\.get\('teamId'\)/);
	});

	it('passes NO enqueue — a Roster Trade is not broadcast', () => {
		expect(MODULE).not.toMatch(/^\s*enqueue:/m);
		expect(MODULE).not.toMatch(/enqueueBroadcasts|notification_outbox/);
	});

	it('offers no control that would cancel a Bid', () => {
		expect(PAGE).not.toMatch(/cancel.{0,20}bid|void.{0,20}bid/i);
	});

	it('uses no `<select>` — there is not one anywhere in `src/routes`', () => {
		expect(PAGE).not.toMatch(/<select/);
	});

	it('reaches for no server-only module from the component', () => {
		expect(PAGE).not.toMatch(/\$lib\/server|\$env\/(dynamic|static)\/private/);
	});

	it("leaves rules/close.ts's cancellation trigger untouched by this story", () => {
		// FR-40's trigger is a Close and only a Close. Nothing in this story's
		// diff names it, and nothing in this story's files reaches for it.
		expect(read('src/lib/core/rules/roster-trade.ts')).not.toMatch(
			/BidCancelled|selectRestoration|withBidCancelled/
		);
		expect(MODULE).not.toMatch(/BidCancelled|selectRestoration/);
	});
});
