/**
 * PRD §10 example 18 — **Stashing beats the cap, on purpose** (AD-25).
 *
 * > Team P is $2,000,000 under the cap, occupies two of its three Minor
 * > League Slots, and has Roster Count 11 — so `M = 3 − 2 = 1` and one
 * > Active/Bench Slot stands empty. It bids $30,000,000 on a Minor League
 * > Eligible player. `N+1 = 1 ≤ M = 1`, so Minors Exposure is $0. Projected
 * > Active/Bench Additions is 0 (the win goes to minors), so Roster Reserve
 * > is `$1,000,000 × max(0, 12 − 11) = $1,000,000`, which its $2,000,000
 * > covers. Roster Capacity passes at `11 + 0 = 11 ≤ 12`. The bid is
 * > **permitted** — the auction page shows "no cap limit" rather than a
 * > figure. On close he is stashed at a $0 Cap Hit and Roster Count stays 11.
 *
 * **This is FR-35, the rule the PRD itself calls the one most likely to
 * surprise a reader**, and it is the example that proves the money gate can
 * decline to bound an amount at all. A Team with $2,000,000 of room is
 * permitted to offer $30,000,000, because the win costs the Cap nothing: a
 * Free Minor League Slot absorbs the Player at a $0 Cap Hit.
 *
 * **The half that is easy to get wrong is that unbounded is not a waiver.**
 * PRD §3 qualifies it "provided Roster Reserve remains coverable" and the
 * example narrates the check out loud — a reserve of $1,000,000, "which its
 * $2,000,000 covers". So the offered amount is compared to nothing while
 * `Available Cap Space − Roster Reserve ≥ 0` still decides. The last test
 * here is that check failing, which is the only state in which an unbounded
 * money gate refuses.
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

/** The Player is Minor League Eligible — the fact this whole example turns on. */
const STATE: BidState = bidStateFor(null, TEAM_P, true, 'Auction');

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

describe('§10 example 18 — stashing beats the cap, on purpose', () => {
	it('derives M = 1, N = 1, Overflow 0 and Minors Exposure $0', () => {
		const cap = evaluate(STATE, bidOf(30_000_000), NOW).cap;

		// `M = 3 − 2`, and `N` is the POST-BID count: no eligible leads
		// elsewhere, plus the Bid being placed.
		expect(cap.freeMinorLeagueSlots).toBe(1);
		expect(cap.eligibleLeadingBids).toBe(1);
		expect(cap.overflowCount).toBe(0);
		// `N ≤ M`, so nothing overflows and nothing is exposed.
		expect(cap.minorsExposure).toBe(0);
		expect(cap.exposingBids).toEqual([]);
	});

	it('permits $30,000,000 against $2,000,000 of room — the amount is compared to nothing', () => {
		const gates = evaluate(STATE, bidOf(30_000_000), NOW);

		expect(gates.cap.unbounded).toBe(true);
		expect(gates.cap.passed).toBe(true);
		// The arithmetic still ran and is still reported — the flag says the
		// comparison did not happen, not that the figures do not exist.
		expect(gates.cap.committedBids).toBe(0);
		expect(gates.cap.availableCapSpace).toBe(2_000_000);
		expect(gates.cap.rosterReserve).toBe(1_000_000);
		expect(gates.cap.maximumBid).toBe(1_000_000);
		// And the offered amount is thirty times that, which is the point.
		expect(gates.cap.offered).toBe(30_000_000);
	});

	it('adds nothing to Active/Bench: capacity passes at 11 + 0 = 11', () => {
		const slots = evaluate(STATE, bidOf(30_000_000), NOW).slots;

		// "the win goes to minors" — Projected Active/Bench Additions is 0,
		// not 1, because the Bid being placed is one a Free Minor League Slot
		// absorbs.
		expect(slots.projectedAdditions).toBe(0);
		expect(slots.rosterCount).toBe(11);
		expect(slots.passed).toBe(true);
		// The capacity gate reaches the same counts, and no money.
		expect(slots.freeMinorLeagueSlots).toBe(1);
		expect(slots.eligibleLeadingBids).toBe(1);
		expect(slots.overflowCount).toBe(0);
	});

	it('is accepted through decide(), with every gate passing', () => {
		const decided = decide(STATE, bidOf(30_000_000), NOW, null);

		expect(decided.kind).toBe('accepted');
		expect(allGatesPassed(evaluate(STATE, bidOf(30_000_000), NOW))).toBe(true);
		expect(failedGates(evaluate(STATE, bidOf(30_000_000), NOW))).toEqual([]);
	});

	it('shows "no cap limit" rather than a figure, in words and with no number', () => {
		const cap = evaluate(STATE, bidOf(30_000_000), NOW).cap;

		const maximumBid = capBreakdown(cap).find((line) => line.label === 'Maximum Bid');
		expect(maximumBid?.figure).toBe('no cap limit');
		// The example says "rather than a figure": no digit, and certainly not
		// the $1.0M the ordinary subtraction produced.
		expect(maximumBid?.figure).not.toMatch(/\d/);

		// ...and the breakdown explains WHY, which is EXPERIENCE.md's own ask.
		const why = capBreakdown(cap).find((line) => line.label === 'Why there is no cap limit');
		expect(why?.kind).toBe('detail');
		expect(why?.figure).toContain('Free Minor League Slot');
		expect(why?.figure).toContain('$0 Cap Hit');
		expect(why?.figure).toContain('Roster Reserve');

		// Every label is distinct — the column keys its rows on them.
		const labels = capBreakdown(cap).map((line) => line.label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it('says it in words on the gate row too', () => {
		const row = bidGateReport(evaluate(STATE, bidOf(30_000_000), NOW)).find(
			(candidate) => candidate.gate === 'cap'
		);

		expect(row?.chip).toBe('Cap · Passed');
		expect(row?.figure).toContain('no cap limit');
		expect(row?.figure).not.toMatch(/\$\d/);
	});

	it('shows it on the BOARD, before anything is typed — the mirror of example 24', () => {
		// Example 24's full Team arrives with a disabled control and a stated
		// reason; this Team arrives with an ENABLED one and "no cap limit"
		// already shown. Both are the same design: a standing condition is
		// read on arrival, never discovered at submission.
		const control = bidControlState({
			state: STATE,
			fantraxPlayerId: 'p-stash',
			viewerTeamId: 't-p',
			amountText: '1500000',
			confirmed: true,
			now: ''
		});

		expect(control.blocked).toBe(false);
		expect(control.refusingGates).toEqual([]);
	});

	it('still refuses when Roster Reserve is not coverable — unbounded is not a waiver', () => {
		// PRD §3: "provided Roster Reserve remains coverable". A Team with
		// $1,000,000 of room and seven unfilled Active/Bench Slots owes a
		// $7,000,000 reserve it cannot cover, and no eligibility waives that.
		const short: TeamMoneyState = {
			capSpace: parseMoney(1_000_000),
			rosterCount: 5,
			leading: [],
			eligibleLeading: [],
			minorLeagueOccupied: 0
		};
		const gates = evaluate(bidStateFor(null, short, true, 'Auction'), bidOf(30_000_000), NOW);

		expect(gates.cap.unbounded).toBe(true);
		expect(gates.cap.rosterReserve).toBe(7_000_000);
		expect(gates.cap.availableCapSpace).toBe(1_000_000);
		expect(gates.cap.passed).toBe(false);

		const detail = bidRefusalDetail({ kind: 'gates', gates });
		expect(detail).toContain('Roster Reserve');
		expect(detail).toContain('$6.0M short');
		// It quotes no Maximum Bid, because there is no Maximum Bid to quote:
		// the offered amount was compared to nothing.
		expect(detail).not.toContain('Maximum Bid');
		expect(detail).not.toContain('exceeds');

		// The gate ROW says it too. `bidRefusalDetail` comes from `gateSentence`
		// and this comes from `gateFigure` — two renderers, and only this one is
		// reached on the panel's chip row. Narrowing `gateFigure`'s unbounded
		// branch to `unbounded && passed` would drop this row back to "Maximum
		// Bid $X, offered $Y", contradicting the delta sentence directly above
		// it, and every other assertion here would still hold.
		const row = bidGateReport(gates).find((candidate) => candidate.gate === 'cap');
		expect(row?.chip).toBe('Cap · Refused');
		expect(row?.figure).toContain('no cap limit');
	});
});
