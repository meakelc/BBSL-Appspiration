/**
 * The Drop's grounds, its one conversion, and the surface that carries them
 * (Story 7.8, FR-43).
 *
 * §10 examples 40, 41 and 43 own the narrated cases. This file owns the rest
 * of the I/O matrix — Injury Reserve, a first-round rookie deal, a
 * part-served second-round one, the contested ground, a won Player, Dead
 * Money named, an act naming nothing, a Player the Team does not hold, the
 * same id twice, the blank reason and the archived phase — plus the
 * structural properties the gate set is supposed to have.
 *
 * `vite.config.ts` pins `environment: 'node'` and no `.svelte` file renders
 * under the suite, so the surface's claims are proven by **source-text
 * assertion**, which is `tests/structure.test.ts`'s own mechanism.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseMoney } from '../src/lib/core/money.ts';
import { INITIAL_AUCTIONS } from '../src/lib/core/projection/auctions.ts';
import type { Auction, OpenAuctions } from '../src/lib/core/projection/auctions.ts';
import { INITIAL_NOMINATIONS } from '../src/lib/core/projection/nominations.ts';
import type { OpenNominations } from '../src/lib/core/projection/nominations.ts';
import {
	OVERRIDE_ARCHIVED_STATUS,
	OVERRIDE_REASON_REQUIRED_STATUS,
	requireOverridablePhase,
	requireOverrideReason
} from '../src/lib/server/override-guard.ts';
import {
	allDropGatesPassed,
	dropActSentence,
	dropAttention,
	dropRefusalDetail,
	evaluateDrop
} from '../src/lib/core/rules/roster-drop.ts';
import type { DroppablePlayer, RosterDropState } from '../src/lib/core/rules/roster-drop.ts';
import { dropReasonRows } from '../src/lib/reason-sheet-view.ts';
import { RECORD_DROP_GATES } from '../src/lib/core/types.ts';
import type { GateResults, RecordDrop, RecordDropGateResults } from '../src/lib/core/types.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path: string): string => readFileSync(join(ROOT, ...path.split('/')), 'utf8');

const CLOSES_AT = '2026-09-11T09:00:00.000Z';

function player(
	id: string,
	name: string,
	kind: DroppablePlayer['rosterSlotKind'],
	value: number,
	extras: Partial<DroppablePlayer> = {}
): DroppablePlayer {
	return {
		fantraxPlayerId: id,
		playerName: name,
		rosterSlotKind: kind,
		value: parseMoney(value),
		won: false,
		contractYearsRemaining: 3,
		rookieScaleRound: null,
		...extras
	};
}

function stateOf(
	rows: readonly DroppablePlayer[],
	extras: Partial<RosterDropState> = {}
): RosterDropState {
	return {
		team: { teamId: 't-1', teamName: 'Team One', rows },
		auctions: INITIAL_AUCTIONS,
		nominations: INITIAL_NOMINATIONS,
		isMinorLeagueEligible: () => false,
		playerNameFor: (id) => id,
		...extras
	};
}

function dropOf(ids: readonly string[]): RecordDrop {
	return {
		kind: 'RecordDrop',
		teamId: 't-1',
		teamName: 'Team One',
		fantraxPlayerIds: ids,
		reason: 'Released in Fantrax on the 11th.'
	};
}

/** The one released Contract of a permitted single-Player Drop. */
function releaseOf(state: RosterDropState, id: string) {
	const outcome = evaluateDrop(state, dropOf([id]));
	expect(outcome.kind).toBe('permitted');
	if (outcome.kind !== 'permitted') throw new Error('refused');
	return { outcome, release: outcome.delta.released[0], delta: outcome.delta };
}

describe('the one conversion — no Slot kind is a special case', () => {
	it('carries an Active/Bench Contract in full and keeps the row', () => {
		const { release, delta } = releaseOf(stateOf([player('p-1', 'Green', 'active_bench', 2_000_000)]), 'p-1');

		expect(release?.deadMoney).toBe(2_000_000);
		expect(release?.removed).toBe(false);
		expect(release?.chargedCapHit).toBe(2_000_000);
		expect(release?.fromPlacement).toBe('active_bench');
		// Cap Space stands still — the row keeps charging exactly what it
		// charged — while the Slot is freed.
		expect(delta.after.capSpace).toBe(delta.before.capSpace);
		expect(delta.after.rosterCount).toBe(delta.before.rosterCount - 1);
	});

	it('carries an Injury Reserve Contract in full, and Roster Count does not move', () => {
		const { release, delta } = releaseOf(
			stateOf([player('p-ir', 'Hurt', 'injury_reserve', 1_500_000)]),
			'p-ir'
		);

		expect(release?.deadMoney).toBe(1_500_000);
		expect(release?.removed).toBe(false);
		// IR never counted against the twelve, so nothing is freed — and the
		// charge is unchanged, so nothing moves at all.
		expect(delta.after.rosterCount).toBe(delta.before.rosterCount);
		expect(delta.after.capSpace).toBe(delta.before.capSpace);
		expect(delta.after.injuryReserveOccupied).toBe(delta.before.injuryReserveOccupied - 1);
	});

	it('leaves nothing behind for a Minor League Contract, and removes the row', () => {
		const { release, delta } = releaseOf(
			stateOf([player('p-m', 'Stashed', 'minor_league', 3_000_000)]),
			'p-m'
		);

		// It was charging $0, so there is nothing to carry — and the row is
		// removed because the amount is $0, not because the Slot kind was
		// tested.
		expect(release?.chargedCapHit).toBe(0);
		expect(release?.deadMoney).toBe(0);
		expect(release?.removed).toBe(true);
		// The full value is still recorded beside the charge (AD-23).
		expect(release?.value).toBe(3_000_000);
		expect(delta.after.capSpace).toBe(delta.before.capSpace);
		expect(delta.after.minorLeagueOccupied).toBe(0);
	});

	it('carries a full-term SECOND-round rookie deal in full - there is no exception', () => {
		// **The regression for the removal.** This is the exact row that used to
		// clear entirely under FR-43's rookie-scale exception, and it fired once
		// in production before the exception was removed (Washington, Malique
		// Lewis, $1,000,000, 2026-09-16). The League waives Dead Money only in an
		// amnesty period BEFORE the auction opens, settled in Fantrax and already
		// reflected in the imported rosters - so nothing this app records ever
		// waives it, and Cap Space must not move.
		const { release, delta } = releaseOf(
			stateOf([
				player('p-rk', 'Rookie', 'active_bench', 2_000_000, {
					rookieScaleRound: 2,
					contractYearsRemaining: 5
				})
			]),
			'p-rk'
		);

		expect(release?.deadMoney).toBe(2_000_000);
		expect(release?.removed).toBe(false);
		// The row keeps charging what it charged, so Cap Space stands still.
		expect(delta.after.capSpace).toBe(delta.before.capSpace);
	});

	it('carries a FIRST-round rookie deal in full', () => {
		const { release } = releaseOf(
			stateOf([
				player('p-1rk', 'First Rounder', 'active_bench', 2_000_000, {
					rookieScaleRound: 1,
					contractYearsRemaining: 5
				})
			]),
			'p-1rk'
		);

		expect(release?.deadMoney).toBe(2_000_000);
		expect(release?.removed).toBe(false);
	});

	it('carries a PART-SERVED second-round rookie deal in full', () => {
		const { release } = releaseOf(
			stateOf([
				player('p-2rk', 'Third Year', 'active_bench', 2_000_000, {
					rookieScaleRound: 2,
					contractYearsRemaining: 3
				})
			]),
			'p-2rk'
		);

		// Round 2 but not this draft class — two years of the five are served.
		expect(release?.deadMoney).toBe(2_000_000);
		expect(release?.removed).toBe(false);
	});

	it('reads NEITHER rookie fact to decide the amount', () => {
		// The designation is still parsed and still written into the
		// `DropRecorded` payload - it is a fact about the Contract - but no
		// combination of round and term changes what is carried.
		for (const rookieScaleRound of [null, 1, 2, 3]) {
			for (const contractYearsRemaining of [null, 0, 3, 4, 5]) {
				const { release } = releaseOf(
					stateOf([
						player('p-any', 'Any', 'active_bench', 2_000_000, {
							rookieScaleRound,
							contractYearsRemaining
						})
					]),
					'p-any'
				);
				expect(release?.deadMoney).toBe(2_000_000);
				expect(release?.removed).toBe(false);
			}
		}
	});

	it('writes the conversion ONCE — no branch on the Slot kind decides the amount', () => {
		// The second acceptance criterion, held by reading the source: exactly
		// one expression decides the amount and exactly one decides whether the
		// row survives, and neither tests `rosterSlotKind`.
		const source = read('src/lib/core/rules/roster-drop.ts')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '');
		expect(source).not.toMatch(/rosterSlotKind\s*===\s*'minor_league'/);
		expect(source).not.toMatch(/rosterSlotKind\s*===\s*'injury_reserve'/);
		// One `deadMoneyFor`, and it is `chargeOf` alone - no waiver, no ternary,
		// nothing that could grow a second answer.
		expect(source).not.toMatch(/releasesToNothing|ROOKIE_SCALE_EXEMPT/);
		expect(source.match(/return chargeOf\(row\);/g)).toHaveLength(1);
		expect(source.match(/const removed = compareMoney\(deadMoney, NO_MONEY\) === 0;/g)).toHaveLength(
			1
		);
	});
});

describe('the shape refusals — nothing is written and no gate runs', () => {
	it('refuses a Drop that names nothing', () => {
		const outcome = evaluateDrop(stateOf([player('p-1', 'Green', 'active_bench', 2_000_000)]), dropOf([]));

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('names_nothing');
		expect(outcome.gates).toBeNull();
		expect(dropRefusalDetail(outcome.refusal, outcome.gates)).toContain('names no Players');
	});

	it('refuses a Player the named Team does not hold, naming him and the Team', () => {
		const outcome = evaluateDrop(
			stateOf([player('p-1', 'Green', 'active_bench', 2_000_000)], {
				playerNameFor: () => 'Somebody Else'
			}),
			dropOf(['p-elsewhere'])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('not_held');
		expect(outcome.gates).toBeNull();
		const detail = dropRefusalDetail(outcome.refusal, outcome.gates);
		expect(detail).toContain('Somebody Else');
		expect(detail).toContain('Team One');
	});

	it('refuses a Dead Money row — it is a charge, not a Player', () => {
		const outcome = evaluateDrop(
			stateOf([player('p-dead', 'Already Gone', 'dead_money', 2_000_000)]),
			dropOf(['p-dead'])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('dead_money');
		expect(outcome.gates).toBeNull();
		const detail = dropRefusalDetail(outcome.refusal, outcome.gates);
		expect(detail).toContain('Already Gone');
		expect(detail).toContain('Dead Money');
	});

	it('refuses a Player held by an Auction Contract, naming him and the Team', () => {
		const outcome = evaluateDrop(
			stateOf([player('p-won', 'Just Won', 'active_bench', 8_000_000, { won: true })]),
			dropOf(['p-won'])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('won');
		expect(outcome.gates).toBeNull();
		const detail = dropRefusalDetail(outcome.refusal, outcome.gates);
		expect(detail).toContain('Just Won');
		// The Auction he was won in, named explicitly — it is the Auction on
		// him, and the refusal says so rather than leaving it to be inferred.
		expect(detail).toContain('The Auction on Just Won closed to Team One');
		expect(detail).toContain('the Auction on Just Won');
		// The remedy named is the void, never a Drop and never a cancellation.
		expect(detail).toContain('voiding the Bid');
	});

	it('deduplicates the same id posted twice — the act is unchanged', () => {
		const state = stateOf([
			player('p-1', 'Green', 'active_bench', 2_000_000),
			player('p-2', 'Other', 'active_bench', 2_000_000)
		]);
		const once = evaluateDrop(state, dropOf(['p-1']));
		const twice = evaluateDrop(state, dropOf(['p-1', 'p-1']));

		expect(twice.kind).toBe('permitted');
		if (once.kind !== 'permitted' || twice.kind !== 'permitted') return;
		expect(twice.delta.released).toHaveLength(1);
		expect(twice.delta).toEqual(once.delta);
	});
});

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

	it('refuses a Player being bid on, and still runs the other two gates', () => {
		const outcome = evaluateDrop(
			stateOf([player('p-bid', 'Contested', 'active_bench', 2_000_000)], {
				auctions,
				playerNameFor: () => 'Contested'
			}),
			dropOf(['p-bid'])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('gates');
		expect(outcome.gates?.contested.passed).toBe(false);
		expect(outcome.gates?.contested.contested[0]?.contest).toBe('bid');
		// No gate short-circuits another (AD-7): the other two still answered.
		expect(outcome.gates?.cap).not.toBeUndefined();
		expect(outcome.gates?.slots).not.toBeUndefined();
		const detail = dropRefusalDetail(outcome.refusal, outcome.gates);
		expect(detail).toContain('Contested');
		expect(detail).toContain('cannot be dropped until that Auction closes');
	});

	it('refuses a nominated Player awaiting an opening Bid', () => {
		const outcome = evaluateDrop(
			stateOf([player('p-nom', 'Nominee', 'active_bench', 2_000_000)], {
				nominations: nominated
			}),
			dropOf(['p-nom'])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.gates?.contested.contested[0]?.contest).toBe('nomination');
	});
});

describe('the cap gate — a Drop can refuse on the money it did not release', () => {
	/**
	 * §10 example 37's shape with one Team instead of two, reached by a Drop.
	 *
	 * Team One stands at Cap Space $7,000,000 and Roster Count 11, leading one
	 * open Auction at $6,500,000 on a Player who is NOT Minor League eligible.
	 * At 11 it reserves nothing — the lead's own addition fills the twelfth —
	 * so it is solvent by $500,000. Dropping an Active/Bench Contract frees a
	 * Slot that costs $1,000,000 to reserve while the Cap Hit stays on the
	 * books as Dead Money, and the Team ends $500,000 short.
	 *
	 * **The point is that the cap gate is exercised to FAILURE.** A slots
	 * refusal cannot reach the matrix row's "names the Auction and the
	 * arithmetic" clause: only a cap refusal names an Auction and states a
	 * shortfall. This is example 40's arithmetic pushed one step past solvency.
	 */
	const LED_AUCTION: Auction = {
		fantraxPlayerId: 'p-led',
		contention: 'standard',
		leadingBid: {
			seq: '7',
			teamId: 't-1',
			teamName: 'Team One',
			managerId: 'm-1',
			amount: parseMoney(6_500_000),
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

	/** Eleven Active/Bench Contracts summing to $158,000,000. */
	const ELEVEN: readonly DroppablePlayer[] = [
		...Array.from({ length: 10 }, (_unused, index) =>
			player(`p-k-${String(index)}`, `Kept ${String(index)}`, 'active_bench', 15_000_000)
		),
		player('p-drop', 'Released', 'active_bench', 8_000_000)
	];

	const stateWithLead = stateOf(ELEVEN, {
		auctions: { byPlayer: { 'p-led': LED_AUCTION } },
		playerNameFor: (id) => (id === 'p-led' ? 'Led Player' : id)
	});

	it('refuses the whole Drop on the money, and reports it as a gate refusal', () => {
		const outcome = evaluateDrop(stateWithLead, dropOf(['p-drop']));

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('gates');
		expect(outcome.gates?.cap.passed).toBe(false);
		// The contested and slots gates still answered — no gate short-circuits
		// another (AD-7) — and neither is what failed.
		expect(outcome.gates?.contested.passed).toBe(true);
		expect(outcome.gates?.slots.passed).toBe(true);
	});

	it('states the arithmetic: Cap Space, Committed Bids, Roster Reserve and the shortfall', () => {
		const outcome = evaluateDrop(stateWithLead, dropOf(['p-drop']));
		if (outcome.kind !== 'refused' || outcome.gates === null) throw new Error('permitted');
		const gate = outcome.gates.cap;

		// Cap Space did not move: the $8,000,000 is Dead Money and charges on.
		expect(gate.capSpace).toBe(7_000_000);
		expect(gate.committedBids).toBe(6_500_000);
		expect(gate.availableCapSpace).toBe(500_000);
		// Roster Count 10 plus the one projected addition leaves one hole to
		// reserve — the hole the Drop freed.
		expect(gate.rosterCount).toBe(10);
		expect(gate.rosterReserve).toBe(1_000_000);
		expect(gate.maximumBid).toBe(-500_000);
		// Stated as a positive size, so no surface has to negate a Money.
		expect(gate.shortfall).toBe(500_000);
	});

	it('names the Team, the gate, the Auction and the arithmetic in one sentence', () => {
		const outcome = evaluateDrop(stateWithLead, dropOf(['p-drop']));
		if (outcome.kind !== 'refused') throw new Error('permitted');
		const detail = dropRefusalDetail(outcome.refusal, outcome.gates);

		expect(detail).toContain('Team One');
		expect(detail).toContain('Led Player');
		expect(detail).toContain('$7,000,000');
		expect(detail).toContain('$6,500,000');
		expect(detail).toContain('$1,000,000');
		expect(detail).toContain('a shortfall of $500,000');
		// Refuse, never cancel: FR-40's cancellation trigger is a Close.
		expect(detail).toContain('the Drop will not cancel it');
	});

	it('is solvent BEFORE the Drop — the act is what breaks it', () => {
		// Nothing is wrong with this Team until the Slot is freed, which is the
		// whole counterintuitive claim FR-43 makes.
		const outcome = evaluateDrop(stateWithLead, dropOf(['p-nobody']));
		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		// Refused on the SHAPE (nobody holds `p-nobody`), never reaching a gate.
		expect(outcome.refusal.kind).toBe('not_held');

		// Asked of the untouched roster instead: at Roster Count 11 the lead's
		// own addition fills the twelfth, so nothing is reserved and the Team
		// covers its commitment with $500,000 to spare.
		const untouched = evaluateDrop(stateOf([...ELEVEN, player('p-spare', 'Spare', 'injury_reserve', 0)], {
			auctions: { byPlayer: { 'p-led': LED_AUCTION } }
		}), dropOf(['p-spare']));
		if (untouched.kind !== 'permitted') throw new Error('refused');
		expect(untouched.gates.cap.rosterCount).toBe(11);
		expect(untouched.gates.cap.rosterReserve).toBe(0);
		expect(untouched.gates.cap.maximumBid).toBe(500_000);
		expect(untouched.gates.cap.passed).toBe(true);
	});
});

describe('the gate set', () => {
	it('is flat, frozen and in reading order', () => {
		expect([...RECORD_DROP_GATES]).toEqual(['contested', 'cap', 'slots']);
		expect(Object.isFrozen(RECORD_DROP_GATES)).toBe(true);
	});

	it('is assignable to the general `GateResults` shape', () => {
		const outcome = evaluateDrop(
			stateOf([player('p-1', 'Green', 'active_bench', 2_000_000)]),
			dropOf(['p-1'])
		);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;
		const asGeneral: GateResults = outcome.gates;
		// Every name in the frozen list is present and carries a `passed`.
		for (const gate of RECORD_DROP_GATES) {
			expect(typeof asGeneral[gate]?.passed).toBe('boolean');
		}
	});

	it('reads the frozen NAME LIST, so a lost key cannot pass by having nothing to fail', () => {
		const outcome = evaluateDrop(
			stateOf([player('p-1', 'Green', 'active_bench', 2_000_000)]),
			dropOf(['p-1'])
		);
		if (outcome.kind !== 'permitted') throw new Error('refused');
		expect(allDropGatesPassed(outcome.gates)).toBe(true);

		const missing = { ...outcome.gates } as Record<string, { passed: boolean }>;
		delete missing['slots'];
		expect(() => allDropGatesPassed(missing as unknown as RecordDropGateResults)).toThrow();
	});
});

describe('the sheet', () => {
	it('states the Team before → after, then one row per released Player', () => {
		const { delta } = releaseOf(
			stateOf([
				player('p-1', 'Green', 'active_bench', 2_000_000),
				player('p-2', 'Kept', 'active_bench', 5_000_000)
			]),
			'p-1'
		);
		const rows = dropReasonRows(delta);

		// Five figures, then the one Player.
		expect(rows).toHaveLength(6);
		expect(rows[0]?.label).toBe('Team One · Cap Space');
		expect(rows[5]?.label).toBe('Green');
		expect(rows[5]?.before).toContain('Active/Bench');
		expect(rows[5]?.after).toContain('Dead Money');
	});

	it('says IN WORDS that a CARRIED Active/Bench Drop lowers the Maximum Bid', () => {
		const { release } = releaseOf(
			stateOf([player('p-1', 'Green', 'active_bench', 2_000_000)]),
			'p-1'
		);
		if (release === undefined) throw new Error('no release');
		const sentence = dropAttention(release);

		expect(sentence).not.toBeNull();
		// The reserve on the freed hole, as one fact...
		expect(sentence).toContain('$1.0M to reserve');
		// ...then what comes back, ...
		expect(sentence).toContain('Dead Money');
		// ...then the NET direction for this release.
		expect(sentence).toContain('LOWERS');
		expect(sentence).toContain('Maximum Bid');
		expect(sentence).toContain('Green');
		// Nothing cleared, so FR-43's exception is not cited.
		expect(sentence).not.toContain('rookie-scale');
		// New user-facing copy: no gendered pronouns about real league players.
		expect(sentence).not.toMatch(/(his|him|he)/i);
	});

	it('says the SAME for a full-term 2RK release - no waiver, so it still LOWERS', () => {
		// The row that used to be example 41, asserting its inverse. Same Slot,
		// same amount and same act as the case above, and now the same answer
		// too: the Contract carries its Dead Money, nothing returns to Cap
		// Space, and the reserve on the freed hole is the whole of the move.
		const { release } = releaseOf(
			stateOf([
				player('p-rk', 'Rookie', 'active_bench', 2_000_000, {
					rookieScaleRound: 2,
					contractYearsRemaining: 5
				})
			]),
			'p-rk'
		);
		if (release === undefined) throw new Error('no release');
		const sentence = dropAttention(release);

		expect(sentence).toContain('$1.0M to reserve');
		expect(sentence).toContain('LOWERS');
		expect(sentence).toContain('$1.0M');
		expect(sentence).not.toContain('RAISES');
		// No waiver is cited, because none was applied.
		expect(sentence).not.toContain('rookie-scale');
		expect(sentence).not.toContain('FR-43');
	});

	it('cites no waiver for a $0-charged release that merely `removed`', () => {
		// `removed` says only that the carried Dead Money is $0, which an
		// ordinary Active/Bench Contract charging $0 satisfies. There is no
		// waiver in this product for it to cite.
		const { release } = releaseOf(
			stateOf([player('p-free', 'Free Agent Deal', 'active_bench', 0)]),
			'p-free'
		);
		if (release === undefined) throw new Error('no release');
		expect(release.removed).toBe(true);
		const sentence = dropAttention(release);

		expect(sentence).not.toContain('rookie-scale');
		expect(sentence).not.toContain('FR-43');
		// Nothing comes back, so the freed Slot's reserve is the whole of it.
		expect(sentence).toContain('LOWERS');
		expect(sentence).toContain('$1.0M');
	});

	it('carries no attention sentence for an IR or Minor League release', () => {
		const ir = releaseOf(stateOf([player('p-ir', 'Hurt', 'injury_reserve', 1_500_000)]), 'p-ir');
		const minors = releaseOf(
			stateOf([player('p-m', 'Stashed', 'minor_league', 3_000_000)]),
			'p-m'
		);

		if (ir.release === undefined || minors.release === undefined) throw new Error('no release');
		// Neither frees an Active/Bench Slot, so neither moves Maximum Bid by
		// that route — and the amber marker means something only while it is
		// not on every row.
		expect(dropAttention(ir.release)).toBeNull();
		expect(dropAttention(minors.release)).toBeNull();
	});

	it('orders the releases by `fantraxPlayerId`, whatever order they were named in', () => {
		// AD-5. The gates do not care — the act is judged once over the state it
		// produces — but `released[]` is written verbatim into a permanent
		// `DropRecorded` payload and read back by the Audit Log, so an order
		// that came from the form's field order would make the RECORD
		// unreproducible.
		const state = stateOf([
			player('p-c', 'Charlie', 'active_bench', 2_000_000),
			player('p-a', 'Alice', 'active_bench', 2_000_000),
			player('p-b', 'Bob', 'active_bench', 2_000_000)
		]);
		const forwards = evaluateDrop(state, dropOf(['p-a', 'p-b', 'p-c']));
		const backwards = evaluateDrop(state, dropOf(['p-c', 'p-a', 'p-b']));

		if (forwards.kind !== 'permitted' || backwards.kind !== 'permitted') {
			throw new Error('refused');
		}
		expect(forwards.delta.released.map((release) => release.fantraxPlayerId)).toEqual([
			'p-a',
			'p-b',
			'p-c'
		]);
		expect(backwards.delta).toEqual(forwards.delta);
	});

	it('names the Team and every Player in the act sentence', () => {
		const state = stateOf([
			player('p-1', 'Green', 'active_bench', 2_000_000),
			player('p-2', 'Duren', 'active_bench', 2_000_000)
		]);
		const outcome = evaluateDrop(state, dropOf(['p-1', 'p-2']));
		if (outcome.kind !== 'permitted') throw new Error('refused');

		expect(dropActSentence(outcome.delta)).toBe(
			'Record that Team One dropped Green and Duren.'
		);
	});
});

describe('the surface', () => {
	const server = read('src/routes/roster-drop/+page.server.ts');
	const page = read('src/routes/roster-drop/+page.svelte');

	it('guards `load` AND the action with all three guards', () => {
		expect(server).toContain('requireCommissioner');
		expect(server).toContain('requireLiveDestination');
		expect(server).toContain('requireOverridablePhase');
		// One `guard` helper, called in both places, so the two cannot drift.
		expect(server.match(/\bguard\(locals\);/g)).toHaveLength(2);
	});

	it('validates the reason server-side before the write, and fails 409 on a refusal', () => {
		expect(server).toContain('requireOverrideReason(form)');
		expect(server).toContain('fail(409, { notice:');
	});

	it('takes the actor from the session and never from a form field', () => {
		expect(server).toContain('actorFrom(locals.session)');
		expect(server).not.toMatch(/form\.get\(['"](managerId|teamId|actor)['"]\)/);
	});

	it('offers no `<select>` and states the Drop is not announced in Discord', () => {
		// Comments are stripped first: the page's own comment explains WHY
		// there is no `<select>`, and naming it is not using it.
		const markup = page.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/.*$/gm, '');
		expect(markup).not.toContain('<select');
		expect(server).toContain('not announced in Discord');
	});

	it('words no refusal of its own — the sentence is the pure core’s', () => {
		expect(server).toContain('dropRefusalDetail(');
		expect(page).toContain('refusal.detail');
	});
});

describe('the two guards the matrix names', () => {
	it('refuses a blank reason server-side with a 400', () => {
		const form = { get: () => '   ' };
		let status: number | null = null;
		try {
			requireOverrideReason(form);
		} catch (error) {
			status = (error as { status?: number }).status ?? null;
		}
		expect(status).toBe(OVERRIDE_REASON_REQUIRED_STATUS);
	});

	it('refuses a Drop once the League is Archived', () => {
		let status: number | null = null;
		try {
			requireOverridablePhase('Archived');
		} catch (error) {
			status = (error as { status?: number }).status ?? null;
		}
		expect(status).toBe(OVERRIDE_ARCHIVED_STATUS);
		// Every other phase passes; the destination catalog is what keeps a
		// Drop inside the two phases that offer it.
		expect(() => requireOverridablePhase('Auction')).not.toThrow();
		expect(() => requireOverridablePhase('Contract Assignment')).not.toThrow();
	});
});
