/**
 * One Team's view — every row of the I/O matrix, through
 * `src/lib/core/team-view.ts` (Story 4.5).
 *
 * The computation is pure, so every matrix row is driven directly rather than
 * through a fake database: a Team's whole published position is a function of
 * a `TeamMoneyState`, a roster row set, a phase and an instant, and that is
 * exactly what these tests supply.
 *
 * What this suite is FOR, above all, is the absence claim: a rival's Team view
 * carries no Maximum Bid field, no cap breakdown row, and nothing derived from
 * either. That is asserted of the object AND of its serialised form, because
 * the payload is what crosses the wire.
 */

import { describe, expect, it } from 'vitest';

import {
	ACTIVE_BENCH_SLOTS,
	INJURY_RESERVE_SLOTS,
	MINOR_LEAGUE_SLOTS,
	NO_AUCTION_PROBE_ID,
	SALARY_CAP
} from '../src/lib/core/constants.ts';
import { parseMoney } from '../src/lib/core/money.ts';
import { AUCTION_PATH_PREFIX } from '../src/lib/core/auction-link.ts';
import {
	INITIAL_AUCTIONS,
	auctionsReducer,
	BID_PLACED_EVENT
} from '../src/lib/core/projection/auctions.ts';
import { fold } from '../src/lib/core/projection/fold.ts';
import type { OpenNomination } from '../src/lib/core/projection/nominations.ts';
import { teamMoneyStateFor, describeAmount } from '../src/lib/core/rules/bidding.ts';
import type { TeamMoneyState } from '../src/lib/core/rules/bidding.ts';
import { baselineCapOutcome } from '../src/lib/core/strip.ts';
import {
	FIGURE_UNAVAILABLE,
	ROSTER_GROUP_ORDER,
	TEAM_VIEW_LABELS,
	TEAM_VIEW_TITLE,
	injuryReserveSentence,
	minorLeagueSlotSentence,
	nominationSlotStatusSentence,
	rosterSlotSentence,
	slotSentenceHalves,
	teamViewFor
} from '../src/lib/core/team-view.ts';
import type { TeamRosterRow, TeamView } from '../src/lib/core/team-view.ts';
import type { AppendedEvent } from '../src/lib/core/types.ts';

const NOW = '2026-09-03T12:00:00.000Z';
const VIEWER = 't-viewer';

/** A Team with nothing committed anywhere — the plain case. */
function teamWith(overrides: Partial<TeamMoneyState> = {}): TeamMoneyState {
	return {
		capSpace: parseMoney(SALARY_CAP),
		rosterCount: 9,
		leading: [],
		eligibleLeading: [],
		minorLeagueOccupied: 0,
		...overrides
	};
}

/** One imported roster row. */
function row(overrides: Partial<TeamRosterRow> = {}): TeamRosterRow {
	return {
		fantraxPlayerId: 'p-1',
		playerName: 'Imported Player',
		capHit: parseMoney(4_000_000),
		rosterSlotKind: 'active_bench',
		won: false,
		// Story 7.8 added both to the row. An ordinary imported Contract with
		// no rookie-scale designation is the default the Team view is about.
		contractYearsRemaining: 3,
		rookieScaleRound: null,
		...overrides
	};
}

/** A `BidPlaced` row, as the shell appends one. */
function bid(seq: number, fantraxPlayerId: string, teamId: string, amount: number): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt: '2026-09-03T09:00:00.000Z',
		schemaVersion: 1,
		coreVersion: 1,
		type: BID_PLACED_EVENT,
		payload: {
			fantraxPlayerId,
			teamId,
			teamName: teamId,
			managerId: 'm-1',
			amount,
			closesAt: '2026-09-04T09:00:00.000Z'
		},
		managerId: 'm-1',
		teamId,
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

function nominationOn(fantraxPlayerId: string, playerName: string): OpenNomination {
	return {
		fantraxPlayerId,
		playerName,
		teamId: VIEWER,
		teamName: 'Lakers',
		managerId: 'm-1',
		holdsSlot: true,
		occurredAt: '2026-09-03T08:00:00.000Z'
	};
}

function viewFor(overrides: Partial<Parameters<typeof teamViewFor>[0]> = {}): TeamView {
	return teamViewFor({
		teamName: 'Lakers',
		managerNames: ['Meakel'],
		rosterRows: [],
		team: teamWith(),
		phase: 'Auction',
		nomination: null,
		viewerIsThisTeam: false,
		now: NOW,
		...overrides
	});
}

/** Every string the view carries, flattened — for the absence assertions. */
function everyString(value: unknown, found: string[] = []): string[] {
	if (typeof value === 'string') found.push(value);
	else if (Array.isArray(value)) for (const item of value) everyString(item, found);
	else if (value !== null && typeof value === 'object') {
		for (const item of Object.values(value)) everyString(item, found);
	}
	return found;
}

// --- Any Team, any viewer: the published set -------------------------------

describe('the published set — every figure, for every viewer, on every Team', () => {
	it('states Cap Space, Committed Bids, Minors Exposure and Available Cap Space', () => {
		const view = viewFor();
		expect(view.capSpaceLabel).toBe('$165.0M');
		expect(view.committedBidsLabel).toBe('$0.0M');
		expect(view.minorsExposureLabel).toBe('$0.0M');
		expect(view.availableCapSpaceLabel).toBe('$165.0M');
	});

	it('states the Roster Count, the free Active/Bench Slots and the Minor League occupancy', () => {
		const view = viewFor({ team: teamWith({ rosterCount: 9, minorLeagueOccupied: 1 }) });
		expect(view.rosterCountSentence).toBe(`Roster 9 of ${String(ACTIVE_BENCH_SLOTS)}`);
		expect(view.activeBenchSentence).toContain(`Free Active/Bench Slots 3 of ${String(ACTIVE_BENCH_SLOTS)}`);
		// `N of 3` (DESIGN.md:183), with the free count the money gate itself
		// reported beside it — the clamped `M`, never re-derived here.
		expect(view.minorLeagueSentence).toContain(`Minor League 1 of ${String(MINOR_LEAGUE_SLOTS)}`);
		expect(view.minorLeagueSentence).toContain('Free Minor League Slots 2');
	});

	it('states Injury Reserve as visibly OUTSIDE the twelve', () => {
		// §10 example 23's rule, stated in words rather than implied by
		// layout: 11 Active/Bench plus 1 IR is a Roster Count of 11.
		const view = viewFor({
			team: teamWith({ rosterCount: 11 }),
			rosterRows: [row({ fantraxPlayerId: 'p-ir', rosterSlotKind: 'injury_reserve' })]
		});
		expect(view.injuryReserveSentence).toBe(
			`Injury Reserve 1 of ${String(INJURY_RESERVE_SLOTS)}, outside the ${String(ACTIVE_BENCH_SLOTS)}`
		);
		expect(view.rosterCountSentence).toBe('Roster 11 of 12');
	});

	it('every figure but Maximum Bid renders identically for a rival and for the owner', () => {
		// The whole of "there is no partial-information layer": one Team, two
		// viewers, and the ONLY difference is the four own-Team properties
		// plus the flag that decides them.
		const rival = viewFor({ viewerIsThisTeam: false });
		const own = viewFor({ viewerIsThisTeam: true });

		const ownAdditions = ['maximumBid', 'maximumBidLabel', 'capBreakdown', 'auctions'];
		expect(Object.keys(own).filter((key) => !Object.keys(rival).includes(key)).sort()).toEqual(
			[...ownAdditions].sort()
		);
		// ...and every key the two share carries an identical value, bar the
		// flag itself.
		for (const key of Object.keys(rival)) {
			if (key === 'viewerIsThisTeam') continue;
			expect(
				(own as Record<string, unknown>)[key],
				`${key} differs between a rival's view and the owner's`
			).toEqual((rival as Record<string, unknown>)[key]);
		}
	});

	it('reaches every figure through the SAME probe the strip reads', () => {
		// Acceptance criterion four, structurally: the page's figures and the
		// strip's Maximum Bid are fields of one outcome, so they cannot be
		// different numbers.
		const team = teamWith({ rosterCount: 7 });
		const outcome = baselineCapOutcome(team, 'Auction', NOW);
		const view = viewFor({ team, viewerIsThisTeam: true });
		expect(view.maximumBid).toBe(outcome.maximumBid);
	});
});

// --- A rival's view: the absence ------------------------------------------

describe('a rival Team — Maximum Bid is ABSENT, not blanked', () => {
	it('carries no maximumBid, no label and no breakdown property at all', () => {
		const view = viewFor({ viewerIsThisTeam: false });
		expect(view).not.toHaveProperty('maximumBid');
		expect(view).not.toHaveProperty('maximumBidLabel');
		expect(view).not.toHaveProperty('capBreakdown');
		expect(view).not.toHaveProperty('auctions');
	});

	it('carries no cap breakdown row, and no Roster Reserve figure, in its PAYLOAD', () => {
		// Searched over the serialised form, because that is what crosses the
		// wire and what a rival could read out of the page's data.
		const payload = JSON.stringify(viewFor({ viewerIsThisTeam: false }));
		expect(payload).not.toContain('Maximum Bid');
		expect(payload).not.toContain('Roster Reserve');
		expect(payload).not.toContain('no cap limit');
		expect(payload).not.toContain('maximumBid');
	});

	it('states the Nomination Slot without offering to nominate', () => {
		// A Nominate offer on a rival's page would be a control acting on
		// somebody else's Slot.
		const view = viewFor({ viewerIsThisTeam: false, nomination: null });
		expect(view.nominationSlot.sentence).toBe('The Nomination Slot is free.');
		// It STATES the Slot's condition and offers nothing: no invitation, no
		// path to `/nominate`, and no second-person address on a page that may
		// be about somebody else's Team.
		const payload = JSON.stringify(view);
		expect(payload).not.toContain('/nominate');
		expect(payload).not.toContain('Nominate a');
		expect(view.nominationSlot.sentence).not.toContain('Your');
		expect(view.nominationSlot.href).toBeNull();
	});
});

// --- The viewer's own Team: the two additions ------------------------------

describe('the viewer’s own Team — Maximum Bid and the Auctions it holds capital in', () => {
	it('states Maximum Bid and the breakdown that reaches it', () => {
		const view = viewFor({ viewerIsThisTeam: true });
		// $165.0M cap, nothing committed, 9 of 12 filled — the probe's own Bid
		// is a Projected Active/Bench Addition, so two holes remain and
		// $2.0M of Roster Reserve stands. Asserted as the arithmetic rather
		// than as a magic number.
		const reserve = (ACTIVE_BENCH_SLOTS - (9 + 1)) * 1_000_000;
		expect(view.maximumBid).toBe(SALARY_CAP - reserve);
		expect(view.maximumBidLabel).toBe('$163.0M');
		expect(view.capBreakdown?.length).toBeGreaterThan(0);
		expect(view.capBreakdown?.some((line) => line.label === 'Maximum Bid')).toBe(true);
	});

	it('keeps every breakdown label unique — CapBreakdown.svelte keys its each on it', () => {
		const labels = (viewFor({ viewerIsThisTeam: true }).capBreakdown ?? []).map(
			(line) => line.label
		);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it('lists the Auctions this Team leads or contends in, from the two partitioned lists', () => {
		// Not a fourth traversal: `teamMoneyStateFor` already partitioned this
		// set, and both halves land in the list.
		const auctions = fold(
			INITIAL_AUCTIONS,
			[bid(1, 'p-2', VIEWER, 5_000_000), bid(2, 'p-1', VIEWER, 6_000_000)],
			auctionsReducer
		);
		const team = teamMoneyStateFor({
			teamId: VIEWER,
			fantraxPlayerId: NO_AUCTION_PROBE_ID,
			capSpace: parseMoney(SALARY_CAP),
			rosterCount: 9,
			minorLeagueOccupied: 0,
			auctions,
			isMinorLeagueEligible: (playerId) => playerId === 'p-2',
			playerNameFor: (playerId) => `Player ${playerId}`
		});
		expect(team.leading).toHaveLength(1);
		expect(team.eligibleLeading).toHaveLength(1);

		const view = viewFor({ team, viewerIsThisTeam: true });
		expect(view.auctions?.map((entry) => entry.fantraxPlayerId)).toEqual(['p-1', 'p-2']);
		expect(view.auctions?.[0]?.href).toBe(`${AUCTION_PATH_PREFIX}p-1`);
		expect(view.auctions?.[0]?.amountLabel).toBe('$6.0M');
	});

	it('states an UNBOUNDED Maximum Bid in words, never as a number (FR-35)', () => {
		// The probe treats the Player as not eligible, so the baseline is
		// never unbounded through `teamViewFor`'s own path — the guarantee
		// asserted here is that the label follows `capBreakdown`'s row, which
		// is the one place the words are chosen.
		const view = viewFor({ viewerIsThisTeam: true });
		const breakdownFigure = view.capBreakdown?.find(
			(line) => line.label === 'Maximum Bid'
		)?.figure;
		expect(view.maximumBidLabel).toBe(breakdownFigure);
	});

	it('renders a NEGATIVE Maximum Bid as the negative it is, never floored', () => {
		// An overcommitted Team — a Commissioner override, or leads placed
		// before a roster correction. Stating $0.0M would tell the Team that
		// most needs told something false.
		const view = viewFor({
			team: teamWith({ capSpace: parseMoney(1_000_000), rosterCount: 2 }),
			viewerIsThisTeam: true
		});
		expect(view.maximumBid).toBeLessThan(0);
		expect(view.maximumBidLabel).toContain('$');
		expect(view.maximumBidLabel).not.toBe('$0.0M');
	});
});

// --- The roster listing ----------------------------------------------------

describe('the roster listing — grouped by slot kind, IR outside the twelve', () => {
	it('always renders every group, in the declared order', () => {
		const view = viewFor();
		expect(view.roster.map((group) => group.slotKind)).toEqual([...ROSTER_GROUP_ORDER]);
		// An absent Minor League group and an empty one say different things,
		// and only the second is true of a Team holding none.
		expect(view.roster.every((group) => group.entries.length === 0)).toBe(true);
	});

	it('carries a dead_money GROUP, last and outside the roster proper (Story 7.6)', () => {
		// `ROSTER_GROUP_ORDER` is an array rather than a total `Record`, so
		// adding `dead_money` to `RosterSlotKind` did NOT make this file fail
		// to compile — a Dead Money row omitted from the order would have
		// vanished from the Team view while still charging the Cap Space at
		// the head of the same page (AD-32). This is the test that stands in
		// for the compiler.
		expect(ROSTER_GROUP_ORDER).toContain('dead_money');
		expect(ROSTER_GROUP_ORDER[ROSTER_GROUP_ORDER.length - 1]).toBe('dead_money');

		const view = viewFor({
			rosterRows: [
				row({ fantraxPlayerId: 'p-live', playerName: 'Still Here' }),
				row({
					fantraxPlayerId: 'p-gone',
					playerName: 'Released Player',
					capHit: parseMoney(2_000_000),
					rosterSlotKind: 'dead_money'
				})
			]
		});

		const group = view.roster.find((candidate) => candidate.slotKind === 'dead_money');
		expect(group?.label).toBe('Dead Money');
		expect(group?.entries.map((entry) => entry.playerName)).toEqual(['Released Player']);
		// Charged in full — the same $2.0M `computeCapSpace` sums, so the
		// listing and the Cap Space above it reconcile (UX-DR40).
		expect(group?.entries[0]?.capHitLabel).toBe('$2.0M');
		// And it says nothing about a placement: no close can produce one.
		expect(group?.entries[0]?.wonSentence).toBeNull();
	});

	it('states no placement for a WON row that is Dead Money, even with `won: true` set', () => {
		// **This is the assertion the `placementOf` narrowing exists for.**
		// `entryFor` used to read `rosterSlotKind !== 'injury_reserve'` and
		// then cast to `SlotPlacement` — true of a three-member union, and a
		// lie the moment `dead_money` joined it. Under that cast this row
		// would have been handed to `wonCardSentence` as a placement it cannot
		// express, and the page would have printed a stashed-or-rostered
		// sentence about a Player the Team no longer holds.
		//
		// The row sets `won: true` deliberately: with `won: false` the null
		// comes from `row.won` and proves nothing about the narrowing. A close
		// cannot in fact produce Dead Money — `SlotPlacement` is a two-member
		// union and says so — but a Contract WON at auction can be released
		// later, and the reclassified row keeps the `won` flag it was created
		// with.
		const view = viewFor({
			rosterRows: [
				row({
					fantraxPlayerId: 'p-won-then-gone',
					playerName: 'Won Then Released',
					capHit: parseMoney(2_000_000),
					rosterSlotKind: 'dead_money',
					won: true
				})
			]
		});

		const entry = view.roster.find((group) => group.slotKind === 'dead_money')?.entries[0];
		expect(entry?.playerName).toBe('Won Then Released');
		expect(entry?.won).toBe(true);
		expect(entry?.wonSentence).toBeNull();
		// The same row on Injury Reserve — the other non-placement kind — has
		// always behaved this way, and still does.
		const onIr = viewFor({
			rosterRows: [row({ rosterSlotKind: 'injury_reserve', won: true })]
		});
		expect(
			onIr.roster.find((group) => group.slotKind === 'injury_reserve')?.entries[0]?.wonSentence
		).toBeNull();
	});

	it('states Dead Money as MONEY beside the figures, and omits it for a Team carrying none', () => {
		const none = viewFor();
		expect(none.deadMoneySentence).toBeNull();
		expect(none.deadMoneyHalves).toBeNull();

		const view = viewFor({
			rosterRows: [
				row({
					fantraxPlayerId: 'p-gone',
					capHit: parseMoney(2_000_000),
					rosterSlotKind: 'dead_money'
				}),
				row({
					fantraxPlayerId: 'p-gone-2',
					capHit: parseMoney(500_000),
					rosterSlotKind: 'dead_money'
				})
			]
		});

		// Summed through `chargedCapHit`, the function `computeCapSpace` sums.
		expect(view.deadMoneySentence).toBe(`Dead Money $2.5M, charged and outside the ${String(ACTIVE_BENCH_SLOTS)}`);
		// No ceiling in the sentence, so the quiet half is empty and a surface
		// may still render it unconditionally.
		expect(view.deadMoneyHalves?.full).toBe(view.deadMoneySentence);
		expect(view.deadMoneyHalves?.qualifier).toBe('');
	});

	it('puts a WON Player on the roster in his placement slot kind, with the placement stated', () => {
		const view = viewFor({
			team: teamWith({ rosterCount: 1, minorLeagueOccupied: 1 }),
			rosterRows: [
				row({ fantraxPlayerId: 'p-import', playerName: 'Imported', rosterSlotKind: 'active_bench' }),
				row({
					fantraxPlayerId: 'p-won',
					playerName: 'Won Player',
					capHit: parseMoney(0),
					rosterSlotKind: 'minor_league',
					won: true
				})
			]
		});
		const minors = view.roster.find((group) => group.slotKind === 'minor_league');
		expect(minors?.entries.map((entry) => entry.playerName)).toEqual(['Won Player']);
		// The sentence is Your Positions', reused — the placement AND the Cap
		// Hit, because the two are independent (AD-23).
		expect(minors?.entries[0]?.wonSentence).toBe(
			'Placed in a Minor League Slot at a $0.0M Cap Hit.'
		);
		// An imported row was never placed by a close and makes no such
		// statement.
		const active = view.roster.find((group) => group.slotKind === 'active_bench');
		expect(active?.entries[0]?.wonSentence).toBeNull();
	});

	/**
	 * The imported half of the roster, where the stored figure and the
	 * charged one genuinely differ. The won-minors case above cannot catch
	 * this: a close persists `$0` for a minors placement, so its stored and
	 * charged figures agree by construction and the row renders correctly
	 * either way.
	 */
	it('charges $0.0M for an IMPORTED minors row, whatever the column stores', () => {
		const view = viewFor({
			team: teamWith({ rosterCount: 0, minorLeagueOccupied: 1 }),
			rosterRows: [
				row({
					fantraxPlayerId: 'p-minors',
					playerName: 'Imported Minors',
					// `team_rosters.cap_hit` carries exactly what the file
					// stated, even for a Minor League row.
					capHit: parseMoney(3_000_000),
					rosterSlotKind: 'minor_league'
				})
			]
		});
		const minors = view.roster.find((group) => group.slotKind === 'minor_league');
		// The Cap Space above the listing never counted him, so the listing
		// must not charge him either — AC #5, reproduce it by hand.
		expect(minors?.entries[0]?.capHitLabel).toBe('$0.0M');
		expect(view.capSpaceLabel).toBe(describeAmount(parseMoney(SALARY_CAP)));
	});

	it('still states an Active/Bench row at the figure it genuinely charges', () => {
		const view = viewFor({
			rosterRows: [row({ capHit: parseMoney(4_000_000), rosterSlotKind: 'active_bench' })]
		});
		const active = view.roster.find((group) => group.slotKind === 'active_bench');
		expect(active?.entries[0]?.capHitLabel).toBe('$4.0M');
	});

	it('sorts rows by Player name, tie-broken totally on the Player id', () => {
		const view = viewFor({
			rosterRows: [
				row({ fantraxPlayerId: 'p-b', playerName: 'Same Name' }),
				row({ fantraxPlayerId: 'p-a', playerName: 'Same Name' }),
				row({ fantraxPlayerId: 'p-c', playerName: 'Another Name' })
			]
		});
		const active = view.roster.find((group) => group.slotKind === 'active_bench');
		expect(active?.entries.map((entry) => entry.fantraxPlayerId)).toEqual(['p-c', 'p-a', 'p-b']);
	});
});

// --- The over-ceiling and no-rows states -----------------------------------

describe('the states that are facts rather than errors', () => {
	it('states a roster OVER the ceiling as the overflow it is, never clamped', () => {
		const view = viewFor({ team: teamWith({ rosterCount: 13 }) });
		expect(view.rosterCountSentence).toBe('Roster 13 of 12');
		// ...and no free Slots, which is the true reading of an overflow.
		expect(view.activeBenchSentence).toContain('Free Active/Bench Slots 0 of 12');
	});

	it('states a Team with no roster rows at exactly the Salary Cap and Roster Count 0', () => {
		const view = viewFor({ team: teamWith({ rosterCount: 0 }), rosterRows: [] });
		expect(view.capSpaceLabel).toBe('$165.0M');
		expect(view.rosterCount).toBe(0);
		expect(view.rosterCountSentence).toBe('Roster 0 of 12');
		expect(view.injuryReserveSentence).toContain('Injury Reserve 0 of 2');
	});
});

// --- The Nomination Slot ---------------------------------------------------

describe('the Nomination Slot — both states', () => {
	it('names the Player and links to that Auction when the Slot is spent', () => {
		const view = viewFor({ nomination: nominationOn('p-9', 'Nominated Player') });
		expect(view.nominationSlot.used).toBe(true);
		expect(view.nominationSlot.playerName).toBe('Nominated Player');
		expect(view.nominationSlot.href).toBe(`${AUCTION_PATH_PREFIX}p-9`);
		expect(view.nominationSlot.sentence).toContain('Nominated Player');
	});

	it('states the Slot is free when it is, with no link', () => {
		const view = viewFor({ nomination: null });
		expect(view.nominationSlot.used).toBe(false);
		expect(view.nominationSlot.href).toBeNull();
		expect(view.nominationSlot.sentence).toBe(nominationSlotStatusSentence(null));
	});
});

// --- Naming ----------------------------------------------------------------

describe('naming — a Team is spelled out with its Manager(s)', () => {
	it('names one Manager beside the Team', () => {
		expect(viewFor({ managerNames: ['Meakel'] }).identity).toBe('Lakers — Meakel');
	});

	it('names EVERY Manager of a co-managed Team, and the Team once', () => {
		const identity = viewFor({ managerNames: ['Dana', 'Meakel'] }).identity;
		expect(identity).toBe('Lakers — Dana & Meakel');
		expect(identity.match(/Lakers/g)).toHaveLength(1);
	});

	it('names the Team alone when no Manager is bound to it', () => {
		expect(viewFor({ managerNames: [] }).identity).toBe('Lakers');
	});

	/*
	 * The two halves are supplied separately because they take two colours
	 * (`DESIGN.md:187`), and the suffix is DERIVED from the joined string
	 * rather than re-concatenated — so a change to the em dash or its spacing
	 * cannot make the two disagree. These assert exactly that relationship.
	 */
	it('supplies the Manager half alone, carrying the em dash and its spacing', () => {
		const view = viewFor({ managerNames: ['Meakel'] });
		expect(view.managerSuffix).toBe(' — Meakel');
		expect(view.teamName + view.managerSuffix).toBe(view.identity);
	});

	it('keeps the two halves consistent for a co-managed Team', () => {
		const view = viewFor({ managerNames: ['Dana', 'Meakel'] });
		expect(view.managerSuffix).toBe(' — Dana & Meakel');
		expect(view.teamName + view.managerSuffix).toBe(view.identity);
	});

	it('supplies an EMPTY suffix when no Manager is bound — never a stray dash', () => {
		const view = viewFor({ managerNames: [] });
		expect(view.managerSuffix).toBe('');
		expect(view.teamName + view.managerSuffix).toBe(view.identity);
	});
});

// --- The sentences ---------------------------------------------------------

describe('the sentences, built from the constants and never a literal', () => {
	it('derives both slot ceilings from the constants', () => {
		expect(rosterSlotSentence(9)).toContain(String(ACTIVE_BENCH_SLOTS));
		expect(minorLeagueSlotSentence(1, 2)).toContain(String(MINOR_LEAGUE_SLOTS));
		expect(injuryReserveSentence(1)).toContain(String(INJURY_RESERVE_SLOTS));
	});

	it('floors a corrupt negative count rather than stating a nonsense sentence', () => {
		expect(rosterSlotSentence(-1)).toContain('Free Active/Bench Slots 12 of 12');
		expect(minorLeagueSlotSentence(-1, 3)).toContain('Minor League 0 of 3');
		expect(injuryReserveSentence(Number.NaN)).toContain('Injury Reserve 0 of 2');
	});
});

// --- No comparison, anywhere ----------------------------------------------

describe('slot sentences carry their two registers', () => {
	it('splits a sentence at its ceiling, and the halves rebuild the whole', () => {
		const view = viewFor({ team: teamWith({ rosterCount: 9 }) });
		for (const halves of [
			view.rosterCountHalves,
			view.activeBenchHalves,
			view.minorLeagueHalves,
			view.injuryReserveHalves
		]) {
			// The relationship is what makes the split safe — and unlike the
			// colours, it is checkable in a repo that cannot render.
			expect(halves.lead + halves.qualifier).toBe(halves.full);
			expect(halves.qualifier.startsWith(' of ')).toBe(true);
		}
	});

	it('puts the COUNT in the lead half and the ceiling in the qualifier', () => {
		const view = viewFor({ team: teamWith({ rosterCount: 9 }) });
		expect(view.rosterCountHalves.lead).toBe('Roster 9');
		expect(view.rosterCountHalves.qualifier).toBe(' of 12');
		expect(view.rosterCountHalves.full).toBe(view.rosterCountSentence);
	});

	it('leaves the qualifier empty for a sentence with no ceiling in it', () => {
		expect(slotSentenceHalves('The Nomination Slot is free.')).toEqual({
			full: 'The Nomination Slot is free.',
			lead: 'The Nomination Slot is free.',
			qualifier: ''
		});
	});

	it('states an unanswered Free Minor League Slots rather than inventing a 0', () => {
		// The gate nulls every figure together for a viewer bound to no Team.
		// The money labels answer that with `not available`; this sentence
		// must not answer the same null with a fact.
		expect(minorLeagueSlotSentence(1, null)).toContain(FIGURE_UNAVAILABLE);
		expect(minorLeagueSlotSentence(1, null)).not.toMatch(/Free Minor League Slots 0/);
		expect(minorLeagueSlotSentence(1, 2)).toContain('Free Minor League Slots 2');
	});
});

describe('no comparison, no median, no verdict', () => {
	it('exports no string containing median, average, above or below', () => {
		const view = viewFor({ viewerIsThisTeam: true, nomination: nominationOn('p-9', 'A Player') });
		const strings = [
			...everyString(view),
			...Object.values(TEAM_VIEW_LABELS),
			TEAM_VIEW_TITLE,
			FIGURE_UNAVAILABLE,
			rosterSlotSentence(9),
			minorLeagueSlotSentence(1, 2),
			injuryReserveSentence(1),
			nominationSlotStatusSentence(null),
			nominationSlotStatusSentence('A Player')
		];
		for (const forbidden of ['median', 'average', 'above', 'below']) {
			for (const value of strings) {
				expect(value.toLowerCase(), `"${value}" contains "${forbidden}"`).not.toContain(forbidden);
			}
		}
	});

	it('names no Team rich, poor, stacked or thin, and states no rank', () => {
		const strings = everyString(viewFor({ viewerIsThisTeam: true }));
		for (const forbidden of ['rich', 'poor', 'stacked', 'thin', 'rank', 'best', 'worst']) {
			for (const value of strings) {
				expect(value.toLowerCase()).not.toContain(forbidden);
			}
		}
	});
});

// --- The bids figures (Story 10.6) ------------------------------------------

describe('the bids figures on a Team view', () => {
	const lead = (fantraxPlayerId: string, amount: number, isContentionEntry = false) => ({
		fantraxPlayerId,
		playerName: fantraxPlayerId,
		amount: parseMoney(amount),
		isContentionEntry
	});

	it('carries the three figures and the two sentences from the one derivation', () => {
		const view = viewFor({
			team: teamWith({
				rosterCount: 9,
				leading: [lead('p-1', 3_000_000), lead('p-2', 4_000_000)]
			})
		});

		expect(view.outstandingBids).toBe(2);
		expect(view.bidAllowance).toBe(4);
		expect(view.openContentionEntries).toBe(0);
		expect(view.outstandingBidsSentence).toBe('2 of 4 bids');
		// No entries held, so no entries sentence at all — the bids figure
		// keeps its `0 of n` because the allowance exists whether or not it is
		// spent, while entries have no ceiling and a zero states nothing.
		expect(view.contentionEntriesSentence).toBeNull();
	});

	it('splits the bids sentence into the same two registers every slot sentence uses', () => {
		const view = viewFor({
			team: teamWith({ rosterCount: 9, leading: [lead('p-1', 3_000_000)] })
		});

		expect(view.outstandingBidsHalves).toEqual(slotSentenceHalves('1 of 4 bids'));
		expect(view.outstandingBidsHalves?.lead).toBe('1');
		expect(view.outstandingBidsHalves?.qualifier).toBe(' of 4 bids');
		// The entries sentence has no ceiling, so there is no quieter half to
		// step back — the whole sentence reads in one register.
		const held = viewFor({
			team: teamWith({ rosterCount: 9, leading: [lead('lot-1', 1_000_000, true)] })
		});
		expect(held.contentionEntriesHalves?.qualifier).toBe('');
	});

	it('keeps lottery entries out of the bids figure entirely', () => {
		const view = viewFor({
			team: teamWith({
				rosterCount: 10,
				leading: [
					lead('p-1', 3_000_000),
					lead('lot-1', 1_000_000, true),
					lead('lot-2', 1_000_000, true),
					lead('lot-3', 1_000_000, true)
				],
				eligibleLeading: [lead('lot-4', 1_000_000, true)]
			})
		});

		expect(view.outstandingBidsSentence).toBe('1 of 3 bids');
		expect(view.openContentionEntries).toBe(4);
		expect(view.contentionEntriesSentence).toBe('4 lottery entries');
	});

	it('states neither figure outside the Auction Phase, as the strip does not', () => {
		// One predicate for every surface. The counts stay on the object — they
		// are facts — but the SENTENCES go, because outside the Auction Phase no
		// Bid is accepted at any amount and a figure about outstanding Bids
		// describes an act nobody can perform. Gating the strip alone was the
		// worse bug: in Archived it fell silent while this row still read
		// `0 of n bids`, so two surfaces disagreed about one Team at one instant.
		const held = { rosterCount: 9, leading: [lead('p-1', 3_000_000), lead('lot-1', 1_000_000, true)] };

		for (const phase of ['Contract Assignment', 'Archived'] as const) {
			const view = viewFor({ phase, team: teamWith(held) });
			expect(view.outstandingBidsSentence).toBeNull();
			expect(view.contentionEntriesSentence).toBeNull();
			expect(view.outstandingBidsHalves).toBeNull();
			expect(view.contentionEntriesHalves).toBeNull();
			// The facts survive the silence.
			expect(view.outstandingBids).toBe(1);
			expect(view.openContentionEntries).toBe(1);
		}

		const auction = viewFor({ phase: 'Auction', team: teamWith(held) });
		expect(auction.outstandingBidsSentence).toBe('1 of 4 bids');
		expect(auction.contentionEntriesSentence).toBe('1 lottery entry');
	});

	it('is published on every Team, not just the viewer own — the figure is public', () => {
		// The rival must HOLD an entry for the entries sentence to exist at
		// all — absence there is the zero rule, not a visibility rule, and
		// this test is about visibility.
		const rival = viewFor({
			viewerIsThisTeam: false,
			team: teamWith({
				rosterCount: 9,
				leading: [lead('p-1', 3_000_000), lead('lot-1', 1_000_000, true)]
			})
		});

		expect(rival.outstandingBidsSentence).toBeTypeOf('string');
		expect(rival.contentionEntriesSentence).toBeTypeOf('string');
	});
});
