/**
 * `evaluateRearrange` and its wording (Story 7.11, FR-44).
 *
 * The three §10 examples live in `tests/examples/` and are the executable
 * specification (AD-25). This file holds everything BESIDE them: the shape
 * refusals, the contested ground, the gate refusal's own sentence, the
 * placement-from-the-command property, and the sheet's rows.
 *
 * **The one property no single assertion can state** is that this module
 * writes no arithmetic of its own (AR-42), so the last block reads the source
 * text for the expressions that would be a second spelling of a shared rule.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MINOR_LEAGUE_SLOTS, SALARY_CAP } from '../src/lib/core/constants.ts';
import { parseMoney } from '../src/lib/core/money.ts';
import { INITIAL_AUCTIONS } from '../src/lib/core/projection/auctions.ts';
import type { Auction, OpenAuctions } from '../src/lib/core/projection/auctions.ts';
import { INITIAL_NOMINATIONS } from '../src/lib/core/projection/nominations.ts';
import type { OpenNominations } from '../src/lib/core/projection/nominations.ts';
import {
	allRearrangeGatesPassed,
	evaluateRearrange,
	isRearrangeableSlot,
	mayOccupyMinorLeague,
	maximumBidDirectionSentence,
	moveAttention,
	rearrangeActSentence,
	rearrangeRefusalDetail
} from '../src/lib/core/rules/roster-rearrange.ts';
import type {
	RearrangingPlayer,
	RosterRearrangeState
} from '../src/lib/core/rules/roster-rearrange.ts';
import { rearrangeReasonRows } from '../src/lib/reason-sheet-view.ts';
import { REARRANGE_ROSTER_GATES } from '../src/lib/core/types.ts';
import type { RearrangeRoster } from '../src/lib/core/types.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function row(
	id: string,
	name: string,
	kind: RearrangingPlayer['rosterSlotKind'],
	value: number,
	won = false
): RearrangingPlayer {
	return {
		fantraxPlayerId: id,
		playerName: name,
		rosterSlotKind: kind,
		value: parseMoney(value),
		won
	};
}

/**
 * A modest Team with one of each Slot kind, well clear of every ceiling: two
 * Active/Bench Contracts, one stash, one on Injury Reserve and one Dead Money
 * charge. Cap Space is comfortable, so nothing below is refused by money
 * unless the test means it to be.
 */
const ROWS: readonly RearrangingPlayer[] = [
	row('p-active', 'Active One', 'active_bench', 5_000_000),
	row('p-active-2', 'Active Two', 'active_bench', 5_000_000),
	row('p-stash', 'Stashed One', 'minor_league', 3_000_000),
	row('p-ir', 'Injured One', 'injury_reserve', 4_000_000),
	row('p-dead', 'Departed One', 'dead_money', 2_000_000)
];

const STATE: RosterRearrangeState = {
	team: { teamId: 't-1', teamName: 'Team One', rows: ROWS },
	auctions: INITIAL_AUCTIONS,
	nominations: INITIAL_NOMINATIONS,
	isMinorLeagueEligible: (id) => id === 'p-active',
	hasEverOccupiedMinorLeague: (id) => id === 'p-stash',
	playerNameFor: (id) => `Named ${id}`
};

function command(
	moves: RearrangeRoster['moves'],
	reason: string | null = null
): RearrangeRoster {
	return { kind: 'RearrangeRoster', teamId: 't-1', teamName: 'Team One', moves, reason };
}

describe('evaluateRearrange — the shape refusals', () => {
	it('refuses an act that names nothing', () => {
		const outcome = evaluateRearrange(STATE, command([]));

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('names_nothing');
		// A malformed act has no arithmetic to show.
		expect(outcome.gates).toBeNull();
		expect(rearrangeRefusalDetail(outcome.refusal, null)).toContain('names no Contracts');
	});

	it('refuses a Contract this Team does not hold, and names it from the fold', () => {
		const outcome = evaluateRearrange(
			STATE,
			command([{ fantraxPlayerId: 'p-nobody', toPlacement: 'minor_league' }])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('not_held');
		expect(outcome.gates).toBeNull();
		// The name comes from `playerNameFor`, not from an invented string.
		expect(rearrangeRefusalDetail(outcome.refusal, null)).toContain('Named p-nobody');
	});

	it('refuses Injury Reserve as a SOURCE — the rules core, not the screen', () => {
		const outcome = evaluateRearrange(
			STATE,
			command([{ fantraxPlayerId: 'p-ir', toPlacement: 'active_bench' }])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('unmovable_slot');
		expect(outcome.gates).toBeNull();
		const detail = rearrangeRefusalDetail(outcome.refusal, null);
		expect(detail).toContain('Injury Reserve');
		expect(detail).toContain("player's health");
	});

	it('refuses Injury Reserve as a TARGET', () => {
		const outcome = evaluateRearrange(
			STATE,
			command([{ fantraxPlayerId: 'p-active', toPlacement: 'injury_reserve' }])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('unmovable_slot');
	});

	it('refuses Dead Money as a source and as a target alike', () => {
		for (const move of [
			{ fantraxPlayerId: 'p-dead', toPlacement: 'active_bench' as const },
			{ fantraxPlayerId: 'p-active', toPlacement: 'dead_money' as const }
		]) {
			const outcome = evaluateRearrange(STATE, command([move]));
			expect(outcome.kind).toBe('refused');
			if (outcome.kind !== 'refused') continue;
			expect(outcome.refusal.kind).toBe('unmovable_slot');
			expect(rearrangeRefusalDetail(outcome.refusal, null)).toContain('Dead Money');
		}
	});

	it('names exactly the two participating Slots, in one place', () => {
		expect(isRearrangeableSlot('active_bench')).toBe(true);
		expect(isRearrangeableSlot('minor_league')).toBe(true);
		expect(isRearrangeableSlot('injury_reserve')).toBe(false);
		expect(isRearrangeableSlot('dead_money')).toBe(false);
	});
});

describe('evaluateRearrange — placement eligibility, and only for a promotion', () => {
	it('is the UNION of the pool flag and the observation fold', () => {
		// `p-active` is in the pool and has never been observed; `p-stash` is
		// observed and has no pool row. Both may occupy a Minor League Slot.
		expect(mayOccupyMinorLeague(STATE, 'p-active')).toBe(true);
		expect(mayOccupyMinorLeague(STATE, 'p-stash')).toBe(true);
		expect(mayOccupyMinorLeague(STATE, 'p-active-2')).toBe(false);
	});

	it('refuses a promotion the app has never been told about', () => {
		const outcome = evaluateRearrange(
			STATE,
			command([{ fantraxPlayerId: 'p-active-2', toPlacement: 'minor_league' }])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('never_observed_eligible');
	});

	it('does NOT consult eligibility for a demotion', () => {
		// The same Contract the promotion refuses, moved the other way from a
		// Minor League Slot, with both inputs answering `false`.
		const blind: RosterRearrangeState = {
			...STATE,
			isMinorLeagueEligible: () => false,
			hasEverOccupiedMinorLeague: () => false
		};
		const outcome = evaluateRearrange(
			blind,
			command([{ fantraxPlayerId: 'p-stash', toPlacement: 'active_bench' }])
		);

		expect(outcome.kind).toBe('permitted');
	});

	it('never widens the pool flag handed to the money arithmetic', () => {
		// The observation fold says everything is observed; the pool flag still
		// says only `p-active` is eligible, and Minors Exposure is computed from
		// the flag alone. If the two were merged, this Team's exposure would
		// change — and the assertion below is that it does not.
		const observedEverything: RosterRearrangeState = {
			...STATE,
			hasEverOccupiedMinorLeague: () => true
		};
		const narrow = evaluateRearrange(
			STATE,
			command([{ fantraxPlayerId: 'p-stash', toPlacement: 'active_bench' }])
		);
		const wide = evaluateRearrange(
			observedEverything,
			command([{ fantraxPlayerId: 'p-stash', toPlacement: 'active_bench' }])
		);
		if (narrow.kind !== 'permitted' || wide.kind !== 'permitted') throw new Error('refused');
		expect(wide.gates.cap.minorsExposure).toBe(narrow.gates.cap.minorsExposure);
		expect(wide.gates.cap.maximumBid).toBe(narrow.gates.cap.maximumBid);
	});
});

describe('evaluateRearrange — the contested ground', () => {
	const CLOSES_AT = '2026-09-12T09:00:00.000Z';

	const CONTESTED: OpenAuctions = {
		byPlayer: {
			'p-active': {
				fantraxPlayerId: 'p-active',
				contention: 'standard',
				leadingBid: {
					seq: '5',
					teamId: 't-2',
					teamName: 'Team Two',
					managerId: 'm-2',
					amount: parseMoney(2_000_000),
					occurredAt: '2026-09-11T09:00:00.000Z',
					closesAt: CLOSES_AT,
					seedHash: null
				},
				closesAt: CLOSES_AT,
				bids: [],
				contenders: [],
				seedHash: null,
				seed: null
			} satisfies Auction
		}
	};

	it('fails the contested gate and still reports cap and slots', () => {
		const outcome = evaluateRearrange(
			{ ...STATE, auctions: CONTESTED },
			command([{ fantraxPlayerId: 'p-active', toPlacement: 'minor_league' }])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('gates');
		// **No gate short-circuits another** (AD-7): all three ran and all three
		// are reported.
		expect(outcome.gates).not.toBeNull();
		expect(outcome.gates?.contested.passed).toBe(false);
		expect(outcome.gates?.cap).toBeDefined();
		expect(outcome.gates?.slots).toBeDefined();
		expect(outcome.gates?.contested.contested[0]?.contest).toBe('bid');
	});

	it('excludes the contested Contract from the act rather than moving it', () => {
		const outcome = evaluateRearrange(
			{ ...STATE, auctions: CONTESTED },
			command([{ fantraxPlayerId: 'p-active', toPlacement: 'minor_league' }])
		);
		if (outcome.kind !== 'refused') throw new Error('permitted');

		// Nothing moved, so the post-act figures are the pre-act figures.
		expect(outcome.gates?.slots.minorLeagueOccupied).toBe(1);
	});

	it('words the refusal without ever offering to cancel a Bid', () => {
		const outcome = evaluateRearrange(
			{ ...STATE, auctions: CONTESTED },
			command([{ fantraxPlayerId: 'p-active', toPlacement: 'minor_league' }])
		);
		if (outcome.kind !== 'refused') throw new Error('permitted');
		const detail = rearrangeRefusalDetail(outcome.refusal, outcome.gates);

		expect(detail).toContain('open Auction');
		expect(detail).toContain('until that Auction closes');
		expect(detail).not.toMatch(/cancel/i);
	});

	it('reports a nomination as a nomination, not as a Bid', () => {
		const nominations: OpenNominations = {
			byPlayer: {
				'p-active': {
					fantraxPlayerId: 'p-active',
					playerName: 'Active One',
					teamId: 't-2',
					teamName: 'Team Two',
					managerId: 'm-2',
					nominatedAt: '2026-09-11T09:00:00.000Z',
					state: 'awaiting_opening_bid'
				}
			}
		} as unknown as OpenNominations;
		const outcome = evaluateRearrange(
			{ ...STATE, nominations },
			command([{ fantraxPlayerId: 'p-active', toPlacement: 'minor_league' }])
		);
		if (outcome.kind !== 'refused') throw new Error('permitted');

		expect(outcome.gates?.contested.contested[0]?.contest).toBe('nomination');
		expect(rearrangeRefusalDetail(outcome.refusal, outcome.gates)).toContain(
			'awaiting an opening Bid'
		);
	});
});

describe('evaluateRearrange — the gates, and the whole act refused with them', () => {
	/** A Team already at three of three, so a fourth promotion breaches. */
	const FULL_MINORS: readonly RearrangingPlayer[] = [
		row('p-active', 'Active One', 'active_bench', 5_000_000),
		row('p-s1', 'Stash One', 'minor_league', 1_000_000),
		row('p-s2', 'Stash Two', 'minor_league', 1_000_000),
		row('p-s3', 'Stash Three', 'minor_league', 1_000_000)
	];

	it('refuses the WHOLE act on a slots breach, and names the ceiling', () => {
		const outcome = evaluateRearrange(
			{ ...STATE, team: { teamId: 't-1', teamName: 'Team One', rows: FULL_MINORS } },
			command([{ fantraxPlayerId: 'p-active', toPlacement: 'minor_league' }])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('gates');
		expect(outcome.gates?.slots.breaches).toContain('minor_league');
		const detail = rearrangeRefusalDetail(outcome.refusal, outcome.gates);
		expect(detail).toContain('Team One would stand at');
		expect(detail).toContain(`ceiling of ${String(MINOR_LEAGUE_SLOTS)}`);
	});

	it('refuses on money, naming the gate, the Auction and the arithmetic', () => {
		// A Team with no Cap Space left and a stash worth more than it has:
		// demoting the stash makes it charge, and the Team cannot cover it.
		const broke: readonly RearrangingPlayer[] = [
			row('p-a', 'Active One', 'active_bench', SALARY_CAP),
			row('p-stash', 'Stashed One', 'minor_league', 5_000_000)
		];
		const outcome = evaluateRearrange(
			{ ...STATE, team: { teamId: 't-1', teamName: 'Team One', rows: broke } },
			command([{ fantraxPlayerId: 'p-stash', toPlacement: 'active_bench' }])
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.gates?.cap.passed).toBe(false);
		expect(outcome.gates?.cap.shortfall).not.toBeNull();
		const detail = rearrangeRefusalDetail(outcome.refusal, outcome.gates);
		expect(detail).toContain('Cap Space');
		expect(detail).toContain('Roster Reserve');
		expect(detail).toContain('shortfall');
		// The Auctions it leads, or the stated absence of any.
		expect(detail).toContain('It leads no open Auction.');
		// **And then it stops.** Appending "wait for it to close" after that
		// sentence would tell the reader to wait for an Auction the line before
		// has just said does not exist. The shortfall here is the Team's own
		// committed capital, and the figures are the whole story.
		expect(detail).not.toContain('Wait for it to close');
		expect(detail).not.toMatch(/cancel/i);
	});

	it('DOES offer the remedy when the Team actually leads an Auction', () => {
		// The other half of the same branch: the sentence is suppressed by the
		// absence of a lead, never by a flat rule. A Team with a lead is told
		// what to wait for — and is still never offered a cancellation, because
		// FR-40's trigger is a Close and only a Close.
		const CLOSES_AT = '2026-09-12T09:00:00.000Z';
		const leading: OpenAuctions = {
			byPlayer: {
				'p-elsewhere': {
					fantraxPlayerId: 'p-elsewhere',
					contention: 'standard',
					leadingBid: {
						seq: '9',
						teamId: 't-1',
						teamName: 'Team One',
						managerId: 'm-1',
						amount: parseMoney(20_000_000),
						occurredAt: '2026-09-11T09:00:00.000Z',
						closesAt: CLOSES_AT,
						seedHash: null
					},
					closesAt: CLOSES_AT,
					bids: [],
					contenders: [],
					seedHash: null,
					seed: null
				} satisfies Auction
			}
		};
		const broke: readonly RearrangingPlayer[] = [
			row('p-a', 'Active One', 'active_bench', SALARY_CAP - 1_000_000),
			row('p-stash', 'Stashed One', 'minor_league', 5_000_000)
		];
		const outcome = evaluateRearrange(
			{
				...STATE,
				team: { teamId: 't-1', teamName: 'Team One', rows: broke },
				auctions: leading
			},
			command([{ fantraxPlayerId: 'p-stash', toPlacement: 'active_bench' }])
		);
		if (outcome.kind !== 'refused') throw new Error('permitted');
		const detail = rearrangeRefusalDetail(outcome.refusal, outcome.gates);

		expect(outcome.gates?.cap.passed).toBe(false);
		expect(detail).toContain('It leads');
		expect(detail).not.toContain('It leads no open Auction.');
		expect(detail).toContain('Wait for it to close');
		expect(detail).toContain('the Move will not cancel it');
	});

	it('checks every name in the frozen gate list, not the result object’s keys', () => {
		expect([...REARRANGE_ROSTER_GATES]).toEqual(['contested', 'cap', 'slots']);
		const permitted = evaluateRearrange(
			STATE,
			command([{ fantraxPlayerId: 'p-stash', toPlacement: 'active_bench' }])
		);
		if (permitted.kind !== 'permitted') throw new Error('refused');
		expect(allRearrangeGatesPassed(permitted.gates)).toBe(true);

		for (const gate of REARRANGE_ROSTER_GATES) {
			const broken = {
				...permitted.gates,
				[gate]: { ...permitted.gates[gate], passed: false }
			};
			expect(allRearrangeGatesPassed(broken)).toBe(false);
		}
	});
});

describe('evaluateRearrange — placement comes from the command', () => {
	it('demotes a Contract that FR-21’s automatic rule would have re-stashed', () => {
		// One free Minor League Slot stands open, so `slotPlacementFor` would
		// place this Contract straight back in minors. The command says
		// Active/Bench, and the command is what happens.
		const outcome = evaluateRearrange(
			STATE,
			command([{ fantraxPlayerId: 'p-stash', toPlacement: 'active_bench' }])
		);

		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;
		expect(outcome.delta.after.minorLeagueOccupied).toBeLessThan(MINOR_LEAGUE_SLOTS);
		expect(outcome.delta.moves[0]?.toPlacement).toBe('active_bench');
	});

	it('deduplicates on the Player and keeps the first entry', () => {
		const outcome = evaluateRearrange(
			STATE,
			command([
				{ fantraxPlayerId: 'p-stash', toPlacement: 'active_bench' },
				{ fantraxPlayerId: 'p-stash', toPlacement: 'active_bench' }
			])
		);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		// One Contract, one Slot, one record — never the row departed twice.
		expect(outcome.delta.moves).toHaveLength(1);
	});

	it('records a Move that changes nothing without pretending it did', () => {
		const outcome = evaluateRearrange(
			STATE,
			command([{ fantraxPlayerId: 'p-stash', toPlacement: 'minor_league' }])
		);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		const move = outcome.delta.moves[0];
		expect(move?.fromPlacement).toBe('minor_league');
		expect(move?.toPlacement).toBe('minor_league');
		expect(move?.capHitBefore).toBe(move?.capHitAfter);
		// The amber marker is the product's one attention colour, so a row with
		// nothing non-obvious to say carries no sentence.
		expect(move === undefined ? null : moveAttention(move)).toBeNull();
	});
});

describe('the Roster Move’s wording', () => {
	const PERMITTED = evaluateRearrange(
		STATE,
		command([{ fantraxPlayerId: 'p-stash', toPlacement: 'active_bench' }])
	);

	it('states the act as one finished sentence naming the Team and every Slot', () => {
		if (PERMITTED.kind !== 'permitted') throw new Error('refused');
		const sentence = rearrangeActSentence(PERMITTED.delta);

		expect(sentence).toBe('Record that Team One moves Stashed One to Active/Bench.');
	});

	it('states what a demotion does to the charge, with the value unchanged beside it', () => {
		if (PERMITTED.kind !== 'permitted') throw new Error('refused');
		const move = PERMITTED.delta.moves[0];
		const attention = move === undefined ? null : moveAttention(move);

		expect(attention).toContain('starts charging');
		expect(attention).toContain('$3.0M');
		expect(attention).toContain("value is unchanged");
	});

	it('states what a promotion does to the charge, the other way', () => {
		const promotion = evaluateRearrange(
			STATE,
			command([{ fantraxPlayerId: 'p-active', toPlacement: 'minor_league' }])
		);
		if (promotion.kind !== 'permitted') throw new Error('refused');
		const move = promotion.delta.moves[0];
		const attention = move === undefined ? null : moveAttention(move);

		expect(attention).toContain('stops charging');
		expect(attention).toContain('$5.0M');
	});

	it('builds the sheet’s rows with a Maximum Bid row carrying the direction sentence', () => {
		if (PERMITTED.kind !== 'permitted') throw new Error('refused');
		const rows = rearrangeReasonRows(
			PERMITTED.delta,
			PERMITTED.capBefore,
			PERMITTED.gates.cap,
			PERMITTED.maximumBid
		);

		const maximumBid = rows.find((entry) => entry.label.includes('Maximum Bid'));
		expect(maximumBid).toBeDefined();
		expect(maximumBid?.attention).toBe(
			maximumBidDirectionSentence(PERMITTED.capBefore, PERMITTED.gates.cap, PERMITTED.maximumBid)
		);

		// The five figures are the Trade's, and the moved Contract is named
		// under them.
		expect(rows.some((entry) => entry.label === 'Team One · Cap Space')).toBe(true);
		expect(rows.some((entry) => entry.label === 'Stashed One')).toBe(true);
		// Every AMOUNT goes through the core's one renderer, so no money row
		// prints a raw figure. The occupancy rows are counts and print as
		// counts.
		for (const entry of rows.filter(
			(candidate) => candidate.label.includes('Cap Space') || candidate.label.includes('Maximum Bid')
		)) {
			expect(entry.before).toMatch(/^\$/);
			expect(entry.after).toMatch(/^\$/);
		}
	});

	it('never says a Move is unchanged when it is not, nor changed when it is not', () => {
		if (PERMITTED.kind !== 'permitted') throw new Error('refused');
		const moved = maximumBidDirectionSentence(
			PERMITTED.capBefore,
			PERMITTED.gates.cap,
			PERMITTED.maximumBid
		);
		// The same figure either side is the unchanged case, stated as such.
		const still = maximumBidDirectionSentence(PERMITTED.gates.cap, PERMITTED.gates.cap, {
			before: PERMITTED.maximumBid.after,
			after: PERMITTED.maximumBid.after
		});

		expect(still).toContain('unchanged');
		expect(still).not.toContain('ROSE');
		expect(still).not.toContain('FELL');
		expect(moved).not.toBe(still);
	});
});

describe('the module writes no arithmetic of its own (AR-42)', () => {
	const SOURCE = readFileSync(
		join(ROOT, 'src', 'lib', 'core', 'rules', 'roster-rearrange.ts'),
		'utf8'
	);
	const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

	it('never derives placement — `slotPlacementFor` is not reachable from here', () => {
		// The one thing in this story that reads like a bug if you do not know
		// why. Re-deriving placement would take the demotion the Manager just
		// asked for and put the Contract straight back in the Slot it left.
		// Read from the COMMENT-STRIPPED source: the module header names the
		// function in order to say it is not called, and a scan that could not
		// tell the two apart would fail on the very docblock that states the
		// rule.
		expect(CODE).not.toContain('slotPlacementFor');
		expect(SOURCE).toContain('slotPlacementFor');
	});

	it('writes no second Cap Space, Roster Reserve, Minors Exposure or charge expression', () => {
		expect(CODE).not.toContain('SALARY_CAP');
		expect(CODE).not.toContain('MINIMUM_BID');
		expect(CODE).not.toContain('chargedCapHit');
		expect(CODE).not.toContain('computeCapSpace');
		expect(CODE).not.toMatch(/minorsExposure\s*=/);
		expect(CODE).not.toMatch(/rosterReserve\s*=/);
	});

	it('calls the shared evaluator rather than copying it', () => {
		expect(CODE).toContain('evaluateActCap(');
		expect(CODE).toContain('evaluateActSlots(');
		expect(CODE).toContain('figuresFor(');
		expect(CODE).toContain('postActMoneyStateFor(');
		// `figuresFor` is called exactly twice — once for the before and once
		// for the after — and never per row.
		expect(CODE.match(/figuresFor\(/g)).toHaveLength(2);
	});

	it('is pure: no clock, no randomness, no I/O', () => {
		expect(CODE).not.toMatch(/\bDate\b|Math\.random|fetch\(|process\./);
		expect(CODE).not.toMatch(/from '\$lib|from '\.\.\/\.\.\/server/);
	});
});
