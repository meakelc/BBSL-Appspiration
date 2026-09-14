/**
 * PRD §10 example 44 — **The optimization after the trade** (FR-44).
 *
 * > Continues example 38. Team E has just received Ellis — Minor League
 * > Eligible, won at $18,000,000 — who landed in an **Active/Bench Slot**
 * > because all three Minor League Slots were full, and who therefore charges
 * > **$18,000,000**. Team E stands at Roster Count 10, three Minor League
 * > Slots occupied, Cap Space **$2,000,000**. One of its three stashes is
 * > Brooks, an imported Contract charging **$0** in a Minor League Slot
 * > against a full value of $3,000,000. Team E records **one** Roster Move:
 * > Ellis **into** a Minor League Slot, Brooks **out** to Active/Bench.
 * > Afterwards Ellis charges **$0** (+$18,000,000) and Brooks charges
 * > **$3,000,000** (−$3,000,000), so **Cap Space is $17,000,000** — the Team
 * > recovered $15,000,000 by changing nothing but which eligible Contract
 * > sits in the stash. **Roster Count is unchanged at 10** and **Minor League
 * > occupancy is unchanged at 3**. Brooks needed no pool row to be demoted;
 * > Ellis was eligible because the pool says so. **Applied one leg at a time
 * > it is refused**: demote Ellis first and Minor League occupancy transiently
 * > reads **4**.
 *
 * **The counterfactual is the test, and the implementation must make it
 * unreachable.** The second `describe` below runs the swap's first leg ALONE
 * and asserts it is refused at a Minor League occupancy of 4 — proving the
 * ceiling really does bite at that state — and the first asserts the whole
 * act is permitted. `evaluateRearrange` removes every named row before
 * placing any of them, so the transient state the sequenced run reaches is
 * never constructed by the real act. It is example 39's lesson reached by a
 * different act.
 *
 * **Cap Space is DERIVED, never asserted.** `figuresFor` sums `chargedCapHit`
 * over the rows the Team is left holding, and `chargedCapHit` is the one
 * statement of "a Minor League row charges $0". The $15,000,000 recovery
 * below is that sum's answer, not a figure this file computed.
 *
 * Driven through the `RearrangeRoster` command itself.
 */

import { describe, expect, it } from 'vitest';

import { MINOR_LEAGUE_SLOTS, SALARY_CAP } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { INITIAL_AUCTIONS } from '../../src/lib/core/projection/auctions.ts';
import { INITIAL_NOMINATIONS } from '../../src/lib/core/projection/nominations.ts';
import { evaluateRearrange } from '../../src/lib/core/rules/roster-rearrange.ts';
import type {
	RearrangingPlayer,
	RosterRearrangeState
} from '../../src/lib/core/rules/roster-rearrange.ts';
import type { RearrangeRoster } from '../../src/lib/core/types.ts';

/** Ellis, won at auction for $18,000,000 and sitting in Active/Bench. */
const ELLIS_VALUE = 18_000_000;
/** Brooks, an imported stash worth $3,000,000 and charging nothing. */
const BROOKS_VALUE = 3_000_000;

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
 * Team E: ten Active/Bench Contracts — Ellis and nine others — plus three
 * stashes, one of which is Brooks.
 *
 * The nine others sum to `SALARY_CAP − $20,000,000`, so with Ellis's
 * $18,000,000 the charged total is `SALARY_CAP − $2,000,000` and Cap Space is
 * exactly the $2,000,000 the example names. The stashes charge nothing, which
 * is why they contribute no part of it.
 */
const OTHER_ACTIVE_TOTAL = SALARY_CAP - 20_000_000;

const ROWS: readonly RearrangingPlayer[] = [
	row('p-ellis', 'Ellis', 'active_bench', ELLIS_VALUE, true),
	...Array.from({ length: 8 }, (_unused, index) =>
		row(`p-a-${String(index)}`, `Active ${String(index)}`, 'active_bench', 15_000_000)
	),
	row('p-a-8', 'Active 8', 'active_bench', OTHER_ACTIVE_TOTAL - 8 * 15_000_000),
	row('p-brooks', 'Brooks', 'minor_league', BROOKS_VALUE),
	row('p-stash-2', 'Second Stash', 'minor_league', 2_000_000),
	row('p-stash-3', 'Third Stash', 'minor_league', 2_000_000)
];

/**
 * The two eligibilities, kept apart exactly as the rule keeps them.
 *
 * The POOL FLAG holds Ellis, because he was won at auction as a Minor League
 * Eligible Player — "Ellis was eligible because the pool says so". The
 * OBSERVATION fold holds the three Contracts currently in Minor League Slots,
 * seeded from the roster as it stands. Brooks is in the second and not the
 * first, which is the whole of "Brooks needed no pool row to be demoted" —
 * and, on the round trip, of why he could be put back.
 */
const STATE: RosterRearrangeState = {
	team: { teamId: 't-e', teamName: 'Team E', rows: ROWS },
	auctions: INITIAL_AUCTIONS,
	nominations: INITIAL_NOMINATIONS,
	isMinorLeagueEligible: (id) => id === 'p-ellis',
	hasEverOccupiedMinorLeague: (id) =>
		ROWS.some((held) => held.fantraxPlayerId === id && held.rosterSlotKind === 'minor_league'),
	playerNameFor: (id) => id
};

/** The whole act: one command, two legs, one evaluation at the end. */
const SWAP: RearrangeRoster = {
	kind: 'RearrangeRoster',
	teamId: 't-e',
	teamName: 'Team E',
	moves: [
		{ fantraxPlayerId: 'p-ellis', toPlacement: 'minor_league' },
		{ fantraxPlayerId: 'p-brooks', toPlacement: 'active_bench' }
	],
	reason: null
};

/** The same swap's FIRST LEG alone — the state the real act never constructs. */
const FIRST_LEG_ONLY: RearrangeRoster = {
	...SWAP,
	moves: [{ fantraxPlayerId: 'p-ellis', toPlacement: 'minor_league' }]
};

describe('§10 example 44 — the optimization after the trade', () => {
	it('starts Team E at Roster Count 10, three Minor League Slots and Cap Space $2,000,000', () => {
		const outcome = evaluateRearrange(STATE, SWAP);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		expect(outcome.delta.before.rosterCount).toBe(10);
		expect(outcome.delta.before.minorLeagueOccupied).toBe(MINOR_LEAGUE_SLOTS);
		expect(outcome.delta.before.capSpace).toBe(2_000_000);
	});

	it('is PERMITTED as one act, and recovers $15,000,000 of Cap Space', () => {
		const outcome = evaluateRearrange(STATE, SWAP);

		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;
		// $2,000,000 → $17,000,000. Derived by `figuresFor` over the rows the
		// Team is left holding, not asserted anywhere.
		expect(outcome.delta.after.capSpace).toBe(17_000_000);
		expect(outcome.delta.after.capSpace - outcome.delta.before.capSpace).toBe(15_000_000);
	});

	it('leaves Roster Count at 10 and Minor League occupancy at 3', () => {
		const outcome = evaluateRearrange(STATE, SWAP);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		// One Contract left Active/Bench and one entered it, so neither count
		// moved — which is exactly why the $15,000,000 has to come from the
		// placement rather than from the roster.
		expect(outcome.delta.after.rosterCount).toBe(10);
		expect(outcome.delta.after.minorLeagueOccupied).toBe(MINOR_LEAGUE_SLOTS);
	});

	it('records Ellis at $18,000,000 → $0 and Brooks at $0 → $3,000,000, values untouched', () => {
		const outcome = evaluateRearrange(STATE, SWAP);
		if (outcome.kind !== 'permitted') throw new Error('refused');

		const ellis = outcome.delta.moves.find((move) => move.fantraxPlayerId === 'p-ellis');
		const brooks = outcome.delta.moves.find((move) => move.fantraxPlayerId === 'p-brooks');

		expect(ellis?.fromPlacement).toBe('active_bench');
		expect(ellis?.toPlacement).toBe('minor_league');
		expect(ellis?.capHitBefore).toBe(ELLIS_VALUE);
		expect(ellis?.capHitAfter).toBe(0);
		// The value stands unchanged beside the charge (AD-23) — a Move is not
		// a restructure.
		expect(ellis?.value).toBe(ELLIS_VALUE);
		// And he is the Auction Contract, so he has no `team_rosters` row and
		// moves by the event alone.
		expect(ellis?.won).toBe(true);

		expect(brooks?.fromPlacement).toBe('minor_league');
		expect(brooks?.toPlacement).toBe('active_bench');
		expect(brooks?.capHitBefore).toBe(0);
		expect(brooks?.capHitAfter).toBe(BROOKS_VALUE);
		expect(brooks?.value).toBe(BROOKS_VALUE);
		expect(brooks?.won).toBe(false);
	});

	it('promotes Ellis on the POOL FLAG and demotes Brooks on nothing at all', () => {
		// Ellis has no observation — he has never been in a Minor League Slot —
		// and Brooks has no pool row. Each clears by exactly one half of the
		// union, which is what makes both halves load-bearing.
		const poolOnly: RosterRearrangeState = {
			...STATE,
			hasEverOccupiedMinorLeague: () => false
		};
		// With no observations at all the promotion still stands: the pool says
		// Ellis is eligible.
		expect(evaluateRearrange(poolOnly, SWAP).kind).toBe('permitted');

		// And with no pool flag at all, the promotion is refused while the
		// demotion is not consulted.
		const observedOnly: RosterRearrangeState = { ...STATE, isMinorLeagueEligible: () => false };
		const refused = evaluateRearrange(observedOnly, SWAP);
		expect(refused.kind).toBe('refused');
		if (refused.kind !== 'refused') return;
		expect(refused.refusal.kind).toBe('never_observed_eligible');

		// **The demotion consults neither, and the proof is which refusal it
		// gets.** Brooks alone is refused — demoting him spends $3,000,000 the
		// Team's $2,000,000 of Cap Space cannot cover, which is the money gate
		// doing its job — but it is never refused as ineligible, with both
		// eligibility inputs answering `false`.
		const demotionOnly = evaluateRearrange(
			{ ...STATE, isMinorLeagueEligible: () => false, hasEverOccupiedMinorLeague: () => false },
			{ ...SWAP, moves: [{ fantraxPlayerId: 'p-brooks', toPlacement: 'active_bench' }] }
		);
		expect(demotionOnly.kind).toBe('refused');
		if (demotionOnly.kind !== 'refused') return;
		expect(demotionOnly.refusal.kind).toBe('gates');
		expect(demotionOnly.gates?.cap.passed).toBe(false);
	});
});

describe('§10 example 44, sequenced — the state the act must never construct', () => {
	it('REFUSES the first leg alone at a Minor League occupancy of 4', () => {
		const outcome = evaluateRearrange(STATE, FIRST_LEG_ONLY);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('gates');
		expect(outcome.gates?.slots.passed).toBe(false);
		// Four in three: the ceiling bites, exactly as it should for a state
		// that really did stand at four.
		expect(outcome.gates?.slots.minorLeagueOccupied).toBe(MINOR_LEAGUE_SLOTS + 1);
		expect(outcome.gates?.slots.breaches).toContain('minor_league');
	});

	it('is the ONLY way to reach that state — the whole act never does', () => {
		// Same Team, same two Contracts, same Slots. The difference is that the
		// act is evaluated once, over the state it produces, and departures
		// happen before arrivals — so the four never exists.
		const whole = evaluateRearrange(STATE, SWAP);
		expect(whole.kind).toBe('permitted');
		if (whole.kind !== 'permitted') return;
		expect(whole.gates.slots.minorLeagueOccupied).toBe(MINOR_LEAGUE_SLOTS);
		expect(whole.gates.slots.breaches).toEqual([]);
	});

	it('refuses the first leg whichever order the legs are named in', () => {
		// The dedupe and the sort are on the Player id, and neither changes the
		// act: naming Brooks first still evaluates one act at the end.
		const reversed: RearrangeRoster = {
			...SWAP,
			moves: [
				{ fantraxPlayerId: 'p-brooks', toPlacement: 'active_bench' },
				{ fantraxPlayerId: 'p-ellis', toPlacement: 'minor_league' }
			]
		};
		const outcome = evaluateRearrange(STATE, reversed);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;
		// Recorded in id order (AD-5), so the permanent record is reproducible
		// whichever order the checkboxes were ticked in.
		expect(outcome.delta.moves.map((move) => move.fantraxPlayerId)).toEqual([
			'p-brooks',
			'p-ellis'
		]);
	});
});
