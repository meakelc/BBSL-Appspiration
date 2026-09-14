/**
 * PRD §10 example 46 — **The promotion the app must refuse, and the one it
 * must allow** (FR-44).
 *
 * > Team M holds Vassell in an Active/Bench Slot, imported from Fantrax at a
 * > Cap Hit of $4,000,000. He is in fact minor-league eligible in the real
 * > league — but he was never in the Free Agent pool, so the pool holds no row
 * > for him, the roster table holds no eligibility column, and the app has
 * > never observed him in a Minor League Slot. The Move is **refused and he is
 * > named**, stating that *the app has never been told he is eligible* rather
 * > than that he is ineligible: the second would assert something the app does
 * > not know. **The converse must be allowed.** Team M also holds Thompson, an
 * > imported Contract it demoted out of a Minor League Slot an hour ago under
 * > FR-44. Thompson has no pool row either — but the app **has** observed him
 * > in a Minor League Slot, so he is eligible and may be promoted back,
 * > returning the roster to exactly the state it held before. **These two
 * > Contracts are indistinguishable in the roster table and must be
 * > distinguished by the log.**
 *
 * **The roster is the control and the log is the variable.** The two rows
 * below are byte-for-byte the same shape — imported, Active/Bench, no pool row
 * — and the ONLY thing that separates them is one `RosterRearranged` event in
 * the log. So this file does not hand `evaluateRearrange` a hand-written
 * predicate: it folds `projection/minors-history.ts` over a real log and hands
 * it the answer, which is the only way the claim "eligibility is remembered"
 * can actually be tested.
 *
 * **The refusal's WORDING is asserted, not just its kind.** "The app has never
 * been told he is eligible" and "he is ineligible" are different claims about
 * the world, and the example is explicit that only the first is honest.
 *
 * Driven through the `RearrangeRoster` command itself.
 */

import { describe, expect, it } from 'vitest';

import { SALARY_CAP } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { INITIAL_AUCTIONS } from '../../src/lib/core/projection/auctions.ts';
import { ROSTER_REARRANGED_EVENT } from '../../src/lib/core/projection/contracts.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	hasEverOccupiedMinorLeague,
	minorsHistoryReducer,
	seedMinorsHistory
} from '../../src/lib/core/projection/minors-history.ts';
import { INITIAL_NOMINATIONS } from '../../src/lib/core/projection/nominations.ts';
import {
	evaluateRearrange,
	rearrangeRefusalDetail
} from '../../src/lib/core/rules/roster-rearrange.ts';
import type {
	RearrangingPlayer,
	RosterRearrangeState
} from '../../src/lib/core/rules/roster-rearrange.ts';
import type { AppendedEvent, RearrangeRoster } from '../../src/lib/core/types.ts';

const VASSELL_VALUE = 4_000_000;
const THOMPSON_VALUE = 4_000_000;

function row(
	id: string,
	name: string,
	kind: RearrangingPlayer['rosterSlotKind'],
	value: number
): RearrangingPlayer {
	return {
		fantraxPlayerId: id,
		playerName: name,
		rosterSlotKind: kind,
		value: parseMoney(value),
		won: false
	};
}

/**
 * Team M: eight ordinary Active/Bench Contracts plus Vassell and Thompson,
 * and one Minor League Slot occupied so there is somewhere for a promotion to
 * land.
 *
 * **Vassell and Thompson are identical rows.** Same Slot, same Cap Hit, same
 * absence of a pool row. Anything that told them apart from the roster table
 * alone would be reading a column that does not exist.
 */
const ACTIVE_FILLER_TOTAL = SALARY_CAP - 60_000_000;

const ROWS: readonly RearrangingPlayer[] = [
	...Array.from({ length: 7 }, (_unused, index) =>
		row(`p-a-${String(index)}`, `Active ${String(index)}`, 'active_bench', 6_000_000)
	),
	row('p-a-7', 'Active 7', 'active_bench', ACTIVE_FILLER_TOTAL - 7 * 6_000_000 - 8_000_000),
	row('p-vassell', 'Vassell', 'active_bench', VASSELL_VALUE),
	row('p-thompson', 'Thompson', 'active_bench', THOMPSON_VALUE),
	row('p-stash', 'Stashed Player', 'minor_league', 2_000_000)
];

/**
 * The log: one Roster Move, an hour ago, that demoted Thompson OUT of a Minor
 * League Slot.
 *
 * This event is the whole difference between the two Contracts. It is the
 * exact payload `server/roster-rearrange.ts` appends, so the fold is reading
 * the real record rather than a fixture shaped to suit it.
 */
function appended(payload: unknown): AppendedEvent {
	return {
		seq: '1',
		occurredAt: '2026-09-12T08:00:00.000Z',
		schemaVersion: 1,
		coreVersion: 1,
		managerId: 'm-m',
		teamId: 't-m',
		type: ROSTER_REARRANGED_EVENT,
		payload,
		deviceClass: 'desktop',
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

const THE_DEMOTION = appended({
	teamId: 't-m',
	teamName: 'Team M',
	moves: [
		{
			fantraxPlayerId: 'p-thompson',
			playerName: 'Thompson',
			won: false,
			fromPlacement: 'minor_league',
			toPlacement: 'active_bench',
			capHitBefore: 0,
			capHitAfter: THOMPSON_VALUE,
			value: THOMPSON_VALUE
		}
	],
	teamBefore: {},
	teamAfter: {},
	reason: null
});

/**
 * The observation fold, seeded from the roster as it stands and folded over
 * the log — which is exactly how `server/roster-rearrange.ts` builds it.
 *
 * The seed holds only the Contract sitting in a Minor League Slot right now;
 * Thompson is added by the event, and Vassell is added by nothing.
 */
const HISTORY = fold(seedMinorsHistory(ROWS), [THE_DEMOTION], minorsHistoryReducer);

const STATE: RosterRearrangeState = {
	team: { teamId: 't-m', teamName: 'Team M', rows: ROWS },
	auctions: INITIAL_AUCTIONS,
	nominations: INITIAL_NOMINATIONS,
	// **No pool row for either.** Neither Contract was ever in the Free Agent
	// pool, so the flag is `false` for both — which is what leaves the log as
	// the only thing that can tell them apart.
	isMinorLeagueEligible: () => false,
	hasEverOccupiedMinorLeague: (id) => hasEverOccupiedMinorLeague(HISTORY, id),
	playerNameFor: (id) => id
};

function promotionOf(fantraxPlayerId: string): RearrangeRoster {
	return {
		kind: 'RearrangeRoster',
		teamId: 't-m',
		teamName: 'Team M',
		moves: [{ fantraxPlayerId, toPlacement: 'minor_league' }],
		reason: null
	};
}

describe('§10 example 46 — the promotion the app must refuse', () => {
	it('refuses Vassell, and NAMES him', () => {
		const outcome = evaluateRearrange(STATE, promotionOf('p-vassell'));

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('never_observed_eligible');
		if (outcome.refusal.kind !== 'never_observed_eligible') return;
		expect(outcome.refusal.playerName).toBe('Vassell');
		// A shape refusal: there is no arithmetic to show for an act that could
		// not be built.
		expect(outcome.gates).toBeNull();
	});

	it('states what the app has NOT been told, never that he is ineligible', () => {
		const outcome = evaluateRearrange(STATE, promotionOf('p-vassell'));
		if (outcome.kind !== 'refused') throw new Error('permitted');
		const detail = rearrangeRefusalDetail(outcome.refusal, outcome.gates);

		expect(detail).toContain('Vassell');
		expect(detail).toContain('the app has never been told he is eligible');
		// **The claim the example forbids, DISCLAIMED rather than merely
		// omitted.** Vassell may well be eligible in the real league; the app
		// has no way to know. The sentence says so out loud, because a reader
		// who is told only "cannot be promoted" will supply "is ineligible"
		// themselves — which is the wrong conclusion this refusal exists to
		// head off.
		expect(detail).toContain('not the same as saying he is ineligible');
		expect(detail).toContain('something this app does not know');
		// It never asserts it as a fact about the Player.
		expect(detail).not.toMatch(/Vassell is ineligible|Vassell is not eligible/i);
		// And it says what to do about it rather than leaving a dead end.
		expect(detail).toContain('pool');
	});
});

describe('§10 example 46 — and the one it must allow', () => {
	it('the log is the ONLY thing that separates the two Contracts', () => {
		const vassell = ROWS.find((held) => held.fantraxPlayerId === 'p-vassell');
		const thompson = ROWS.find((held) => held.fantraxPlayerId === 'p-thompson');

		// Byte-for-byte the same row but for the id and the name: same Slot,
		// same Cap Hit, same imported origin, and no pool row for either.
		expect(vassell?.rosterSlotKind).toBe(thompson?.rosterSlotKind);
		expect(vassell?.value).toBe(thompson?.value);
		expect(vassell?.won).toBe(thompson?.won);
		expect(STATE.isMinorLeagueEligible('p-vassell')).toBe(false);
		expect(STATE.isMinorLeagueEligible('p-thompson')).toBe(false);

		// The fold is what tells them apart, and it tells them apart because of
		// one event.
		expect(hasEverOccupiedMinorLeague(HISTORY, 'p-thompson')).toBe(true);
		expect(hasEverOccupiedMinorLeague(HISTORY, 'p-vassell')).toBe(false);
	});

	it('PERMITS Thompson back into a Minor League Slot', () => {
		const outcome = evaluateRearrange(STATE, promotionOf('p-thompson'));

		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;
		const move = outcome.delta.moves[0];
		expect(move?.fantraxPlayerId).toBe('p-thompson');
		expect(move?.fromPlacement).toBe('active_bench');
		expect(move?.toPlacement).toBe('minor_league');
		// He stops charging, and his value is untouched (AD-23).
		expect(move?.capHitBefore).toBe(THOMPSON_VALUE);
		expect(move?.capHitAfter).toBe(0);
		expect(move?.value).toBe(THOMPSON_VALUE);
	});

	it('returns the roster to exactly the state it held before the demotion', () => {
		const outcome = evaluateRearrange(STATE, promotionOf('p-thompson'));
		if (outcome.kind !== 'permitted') throw new Error('refused');

		// One Contract left Active/Bench and entered minors: Roster Count falls
		// by one, minors occupancy rises by one, and Cap Space recovers exactly
		// what the demotion had spent.
		expect(outcome.delta.after.rosterCount).toBe(outcome.delta.before.rosterCount - 1);
		expect(outcome.delta.after.minorLeagueOccupied).toBe(
			outcome.delta.before.minorLeagueOccupied + 1
		);
		expect(outcome.delta.after.capSpace - outcome.delta.before.capSpace).toBe(THOMPSON_VALUE);
	});

	it('would refuse Thompson too if the log had never recorded the demotion', () => {
		// The counterfactual that proves the fold is what is doing the work: the
		// same roster, the same pool, and an EMPTY log.
		const forgotten = fold(seedMinorsHistory(ROWS), [], minorsHistoryReducer);
		const outcome = evaluateRearrange(
			{ ...STATE, hasEverOccupiedMinorLeague: (id) => hasEverOccupiedMinorLeague(forgotten, id) },
			promotionOf('p-thompson')
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('never_observed_eligible');
	});
});
