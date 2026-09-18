/**
 * PRD §10 example 18 — **RETIRED on 2026-09-18**, and this file is the record
 * of that plus the regression that keeps it retired.
 *
 * Example 18 existed to state FR-35, the rule the PRD itself called the one
 * most likely to surprise a reader:
 *
 * > Team P is $2,000,000 under the cap, occupies two of its three Minor
 * > League Slots, and has Roster Count 11 […] It bids $30,000,000 on a Minor
 * > League Eligible player. […] The bid is **permitted** — the auction page
 * > shows "no cap limit" rather than a figure. On close he is stashed at a $0
 * > Cap Hit and Roster Count stays 11.
 *
 * **A Team cannot win a Free Agent straight into its minors.** It has to be
 * able to fit him on its active roster first, and only then may it move him
 * down under FR-44. The $0 Cap Hit that made the amount unbounded arrives only
 * AFTER the Manager moves him, and until the Auction closes he cannot be moved
 * at all — so the money is held for the whole life of the Auction exactly as
 * a non-eligible lead's is.
 *
 * So Team P is now **refused** at $30,000,000, against a Maximum Bid of
 * $2,000,000. Everything the example turned on is gone with it: the
 * `unbounded` flag is unreachable, "no cap limit" is never rendered, Minors
 * Exposure is a permanent $0 over an empty set, and the win projects an
 * Active/Bench addition like any other.
 *
 * **What this file pins is the ABSENCE of the unbounded branch.** The branch
 * still exists in `evaluateCap` — it is reached through
 * `playerIsMinorLeagueEligible`, which `bidStateFor` no longer accepts from
 * anyone and holds at `false`. Deleting it is the follow-up sweep's job; until
 * then the assertions below are what fail if anything ever makes it reachable
 * again, whether by restoring the parameter or by re-partitioning the leads.
 *
 * **The Roster Reserve half of the old example survives on its own terms.**
 * "Unbounded is not a waiver" was always a statement that
 * `Available Cap Space − Roster Reserve ≥ 0` still decides, and it still does
 * — it is simply the ordinary money gate now, with nothing special about an
 * eligible Player. The last test keeps that arithmetic and drops the flag.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { parseMoney } from '../../src/lib/core/money.ts';
import {
	allGatesPassed,
	bidControlState,
	bidGateReport,
	bidRefusalDetail,
	bidStateFor,
	capBreakdown,
	decide,
	evaluate,
	failedGates
} from '../../src/lib/core/rules/bidding.ts';
import type { BidState, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-27T09:00:00.000Z';

/**
 * Team P: $2,000,000 under the cap, Roster Count 11, two of three Minor
 * League Slots occupied, leading nothing at all.
 *
 * `minorLeagueOccupied: 2` is the example's own setup and is the value the
 * whole 18/19/20 sequence coheres at — the PRD records the correction: the
 * Glossary's `M = 3 − occupied` was tested and kept, and the examples' setup
 * was fixed to two occupied Slots.
 */
const TEAM_P: TeamMoneyState = {
	capSpace: parseMoney(2_000_000),
	rosterCount: 11,
	leading: [],
	eligibleLeading: [],
	minorLeagueOccupied: 2
};

/**
 * The Player is Minor League Eligible — the fact this whole example used to
 * turn on, and which no gate can see any more. `bidStateFor` takes no
 * eligibility argument: there is nothing to pass and nothing to vary.
 */
const STATE: BidState = bidStateFor(null, TEAM_P, 'Auction');

function bidOf(amount: number): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId: 'p-stash',
		teamId: 't-p',
		teamName: 'Team P',
		managerId: 'm-p',
		amount: parseMoney(amount)
	};
}

describe('§10 example 18 — RETIRED: stashing no longer beats the cap', () => {
	it('counts NO Eligible Leading Bids, whatever the Player is', () => {
		const cap = evaluate(STATE, bidOf(30_000_000), NOW).cap;

		// `M = 3 − 2` still derives, because Minor League occupancy is still a
		// real fact about the Team — it just decides nothing here now.
		expect(cap.freeMinorLeagueSlots).toBe(1);
		// The Bid is NOT counted as an eligible lead: `N` is 0, not 1.
		expect(cap.eligibleLeadingBids).toBe(0);
		expect(cap.overflowCount).toBe(0);
		// Minors Exposure is a permanent $0 over an empty set — not "nothing
		// overflowed", but nothing to overflow.
		expect(cap.minorsExposure).toBe(0);
		expect(cap.exposingBids).toEqual([]);
	});

	it('REFUSES $30,000,000 against $2,000,000 of room', () => {
		const gates = evaluate(STATE, bidOf(30_000_000), NOW);

		// The branch the whole example rested on is unreachable.
		expect(gates.cap.unbounded).toBe(false);
		expect(gates.cap.passed).toBe(false);
		expect(gates.cap.committedBids).toBe(0);
		expect(gates.cap.availableCapSpace).toBe(2_000_000);
		// Roster Count 11 plus the one projected addition reaches the ceiling,
		// so the reserve holds nothing back and Maximum Bid is the whole room.
		expect(gates.cap.rosterReserve).toBe(0);
		expect(gates.cap.maximumBid).toBe(2_000_000);
		expect(gates.cap.offered).toBe(30_000_000);
	});

	it('adds ONE to Active/Bench: capacity passes at 11 + 1 = 12', () => {
		const slots = evaluate(STATE, bidOf(30_000_000), NOW).slots;

		// The win no longer "goes to minors", so it projects an addition like
		// any other Bid. It still fits — twelve is the ceiling, not eleven —
		// which is what makes the refusal above a MONEY refusal alone.
		expect(slots.projectedAdditions).toBe(1);
		expect(slots.rosterCount).toBe(11);
		expect(slots.passed).toBe(true);
		expect(slots.freeMinorLeagueSlots).toBe(1);
		expect(slots.eligibleLeadingBidsExcludingEntries).toBe(0);
		expect(slots.activeBenchOverflow).toBe(0);
	});

	it('is REFUSED through decide(), on the cap gate and that gate alone', () => {
		const decided = decide(STATE, bidOf(30_000_000), NOW, null);

		expect(decided.kind).toBe('rejected');
		expect(allGatesPassed(evaluate(STATE, bidOf(30_000_000), NOW))).toBe(false);
		// Exactly one ground. Capacity passes, which is the assertion that keeps
		// the two gates independent in the retirement as they were in the example.
		expect(failedGates(evaluate(STATE, bidOf(30_000_000), NOW))).toEqual(['cap']);
	});

	it('shows a REAL figure, and never the words "no cap limit"', () => {
		const cap = evaluate(STATE, bidOf(30_000_000), NOW).cap;

		const maximumBid = capBreakdown(cap).find((line) => line.label === 'Maximum Bid');
		// The ordinary subtraction, rendered. The words are gone because the
		// state that produced them cannot be reached.
		expect(maximumBid?.figure).toBe('$2.0M');
		expect(maximumBid?.figure).toMatch(/\d/);

		// ...and there is no "why" row, because there is no absence to explain.
		expect(
			capBreakdown(cap).find((line) => line.label === 'Why there is no cap limit')
		).toBeUndefined();
		// Nothing anywhere in the breakdown says it.
		expect(capBreakdown(cap).some((line) => line.figure.includes('no cap limit'))).toBe(false);

		// Every label is distinct — the column keys its rows on them.
		const labels = capBreakdown(cap).map((line) => line.label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it('says the figure on the gate row too, and refuses there', () => {
		const row = bidGateReport(evaluate(STATE, bidOf(30_000_000), NOW)).find(
			(candidate) => candidate.gate === 'cap'
		);

		expect(row?.chip).toBe('Cap · Refused');
		expect(row?.figure).not.toContain('no cap limit');
		expect(row?.figure).toMatch(/\$\d/);
	});

	it("BLOCKS the control on the board — now example 24's case, not its mirror", () => {
		// The old example arrived with an ENABLED control and "no cap limit"
		// already shown. A $30,000,000 offer against $2,000,000 of room is
		// refused on arrival now, which is the same design read the other way:
		// a standing condition is shown before submission, not discovered at it.
		const control = bidControlState({
			state: STATE,
			fantraxPlayerId: 'p-stash',
			viewerTeamId: 't-p',
			amountText: '30',
			confirmed: true,
			now: ''
		});

		expect(control.blocked).toBe(true);
		expect(control.refusingGates).toContain('cap');
	});

	it('still refuses when Roster Reserve is not coverable — the half that survived', () => {
		// PRD §3: "provided Roster Reserve remains coverable". A Team with
		// $1,000,000 of room and unfilled Active/Bench Slots owes a reserve it
		// cannot cover. This was the "unbounded is not a waiver" case; it is
		// simply the ordinary money gate now, and it reads the same.
		const short: TeamMoneyState = {
			capSpace: parseMoney(1_000_000),
			rosterCount: 5,
			leading: [],
			eligibleLeading: [],
			minorLeagueOccupied: 0
		};
		const gates = evaluate(bidStateFor(null, short, 'Auction'), bidOf(30_000_000), NOW);

		expect(gates.cap.unbounded).toBe(false);
		// Roster Count 5 plus the one projected addition leaves six holes, so
		// the reserve is $6,000,000 — the old example read $7,000,000 because
		// an eligible win projected no addition at all.
		expect(gates.cap.rosterReserve).toBe(6_000_000);
		expect(gates.cap.availableCapSpace).toBe(1_000_000);
		expect(gates.cap.maximumBid).toBe(-5_000_000);
		expect(gates.cap.passed).toBe(false);

		// The refusal quotes a Maximum Bid now, because there is one to quote:
		// the offered amount was compared, and a negative ceiling is rendered as
		// the fact it is rather than floored at zero.
		const detail = bidRefusalDetail({ kind: 'gates', gates });
		expect(detail).toContain('Maximum Bid');

		// The gate ROW agrees. `bidRefusalDetail` comes from `gateSentence` and
		// this comes from `gateFigure` — two renderers, and only this one is
		// reached on the panel's chip row.
		const row = bidGateReport(gates).find((candidate) => candidate.gate === 'cap');
		expect(row?.chip).toBe('Cap · Refused');
		expect(row?.figure).not.toContain('no cap limit');
		expect(row?.figure).toMatch(/\$/);
	});
});
