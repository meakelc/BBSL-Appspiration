/**
 * The Teams index — every row of the I/O matrix, through
 * `src/lib/core/teams-index.ts` (Story 4.6).
 *
 * The index is pure, so every matrix row is driven directly rather than
 * through a fake database. The views it is given are REAL `teamViewFor`
 * output, never hand-built objects: the story's central claim is that the
 * index and `/teams/<id>` cannot disagree because they are the same function,
 * and a suite that fabricated the input would prove nothing about that.
 *
 * What this suite is FOR, above all, is the pair of absence claims: sorting
 * changes no figure and no median, and nothing on the surface says anything
 * ABOUT the median.
 */

import { describe, expect, it } from 'vitest';

import { SALARY_CAP } from '../src/lib/core/constants.ts';
import { parseMoney } from '../src/lib/core/money.ts';
import type { Money } from '../src/lib/core/money.ts';
import { teamViewFor } from '../src/lib/core/team-view.ts';
import type { TeamMoneyState } from '../src/lib/core/rules/bidding.ts';
import {
	DEFAULT_TEAMS_SORT,
	MEDIAN_GRID_NOTE,
	MEDIAN_LABEL,
	MEDIAN_UNAVAILABLE,
	OWN_ROW_MARKER,
	TEAMS_SORT_KEYS,
	TEAMS_SORT_LABELS,
	TEAM_PATH_PREFIX,
	medianCoverageSentence,
	medianFigureSentence,
	sortTeamsIndex,
	teamCountSentence,
	teamPathFor,
	teamsIndexFor
} from '../src/lib/core/teams-index.ts';
import type { TeamsIndexInput } from '../src/lib/core/teams-index.ts';
import * as teamsIndexModule from '../src/lib/core/teams-index.ts';

const NOW = '2026-09-03T12:00:00.000Z';
const VIEWER = 't-viewer';

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

/**
 * One Team's index input, built by the SAME `teamViewFor` the single-Team page
 * calls — with `viewerIsThisTeam: false`, which is what the index always
 * passes.
 */
function viewFor(options: {
	teamId: string;
	teamName: string;
	managerNames?: readonly string[];
	capSpace?: number;
	rosterCount?: number;
}): TeamsIndexInput {
	const view = teamViewFor({
		teamName: options.teamName,
		managerNames: options.managerNames ?? ['Meakel'],
		rosterRows: [],
		team: teamWith({
			capSpace: parseMoney(options.capSpace ?? SALARY_CAP),
			rosterCount: options.rosterCount ?? 9
		}),
		phase: 'Auction',
		nomination: null,
		viewerIsThisTeam: false,
		now: NOW
	});
	return { ...view, teamId: options.teamId };
}

/** Three Teams whose names, cap figures and free Slots all disagree. */
const THREE: TeamsIndexInput[] = [
	viewFor({ teamId: 't-bulls', teamName: 'Bulls', capSpace: 8_500_000, rosterCount: 12 }),
	viewFor({ teamId: VIEWER, teamName: 'Bucks', capSpace: 23_000_000, rosterCount: 9 }),
	viewFor({ teamId: 't-hawks', teamName: 'Hawks', capSpace: 30_500_000, rosterCount: 8 })
];

describe('the Teams index — every Team is a row', () => {
	it('carries every Team, in a row of its own, and paginates nothing', () => {
		const index = teamsIndexFor({ views: THREE, viewerTeamId: null });
		expect(index.rows).toHaveLength(3);
		expect(index.rows.map((row) => row.teamName)).toEqual(['Bulls', 'Bucks', 'Hawks']);
	});

	it('states the count of the list ACTUALLY read, with no constant thirty', () => {
		expect(teamsIndexFor({ views: THREE, viewerTeamId: null }).countSentence).toBe(
			teamCountSentence(3)
		);
		expect(teamCountSentence(0)).toBe('No Teams.');
		expect(teamCountSentence(1)).toBe('One Team.');
		expect(teamCountSentence(30)).toBe('30 Teams.');
	});

	it('links each row to that Team’s own page through the one path shape', () => {
		const index = teamsIndexFor({ views: THREE, viewerTeamId: null });
		for (const row of index.rows) {
			expect(row.href).toBe(teamPathFor(row.teamId));
			expect(row.href.startsWith(TEAM_PATH_PREFIX)).toBe(true);
		}
		expect(teamPathFor('t-bulls')).toBe('/teams/t-bulls');
	});

	/**
	 * The story's central claim, asserted rather than argued: every figure on a
	 * row is a FIELD of the `TeamView` it was built from, so the index and
	 * `/teams/<id>` are structurally incapable of printing different numbers.
	 */
	it('reads every figure off the TeamView and computes none of its own', () => {
		const [, bucks] = THREE;
		const index = teamsIndexFor({ views: THREE, viewerTeamId: null });
		const row = index.rows.find((entry) => entry.teamId === VIEWER);

		expect(row?.capSpaceLabel).toBe(bucks?.capSpaceLabel);
		expect(row?.committedBidsLabel).toBe(bucks?.committedBidsLabel);
		expect(row?.availableCapSpaceLabel).toBe(bucks?.availableCapSpaceLabel);
		expect(row?.rosterCountHalves).toEqual(bucks?.rosterCountHalves);
		expect(row?.minorLeagueHalves).toEqual(bucks?.minorLeagueOccupancyHalves);
		expect(row?.injuryReserveHalves).toEqual(bucks?.injuryReserveHalves);
		expect(row?.deadMoneyHalves).toEqual(bucks?.deadMoneyHalves);
		expect(row?.freeActiveBenchSlots).toBe(bucks?.freeActiveBenchSlots);
		expect(row?.nominationSlotSentence).toBe(bucks?.nominationSlot.sentence);
	});

	it('carries the roster, minors and Injury Reserve sentences a row needs', () => {
		const row = teamsIndexFor({ views: THREE, viewerTeamId: null }).rows[0];
		expect(row?.rosterCountHalves.full).toBe('Roster 12 of 12');
		expect(row?.minorLeagueHalves.full).toContain('Minor League 0 of 3');
		expect(row?.injuryReserveHalves.full).toContain('outside the 12');
	});

	/**
	 * A card lists no rows, so a Cap Space quietly reduced by Contracts
	 * belonging to players who are not on the Team has nothing on the card to
	 * reconcile against — unless the money is stated (Story 7.6, UX-DR40).
	 */
	it('states Dead Money on the row that carries it, and nowhere else', () => {
		const withDeadMoney: TeamsIndexInput = {
			...teamViewFor({
				teamName: 'Nets',
				managerNames: ['Meakel'],
				rosterRows: [
					{
						fantraxPlayerId: 'p-gone',
						playerName: 'Released Player',
						capHit: parseMoney(2_000_000),
						rosterSlotKind: 'dead_money',
						won: false,
						// Story 7.8's two columns. Dead Money is a charge and not a
						// Contract, so neither is a fact about it.
						contractYearsRemaining: null,
						rookieScaleRound: null
					}
				],
				team: teamWith({ capSpace: parseMoney(SALARY_CAP - 2_000_000), rosterCount: 9 }),
				phase: 'Auction',
				nomination: null,
				viewerIsThisTeam: false,
				now: NOW
			}),
			teamId: 't-nets'
		};

		const index = teamsIndexFor({ views: [...THREE, withDeadMoney], viewerTeamId: null });
		const nets = index.rows.find((entry) => entry.teamId === 't-nets');
		const bulls = index.rows.find((entry) => entry.teamId === 't-bulls');

		expect(nets?.deadMoneyHalves?.full).toContain('Dead Money $2.0M');
		// Absent rather than $0.0M for a Team carrying none: a zero on thirty
		// cards teaches a reader to stop seeing the line.
		expect(bulls?.deadMoneyHalves).toBeNull();
	});

	/**
	 * The withholding that makes the Maximum Bid exception hold: every view is
	 * built with `viewerIsThisTeam: false`, so the three fields are absent from
	 * the SOURCE rather than filtered downstream — and a published Roster
	 * Reserve cannot recover a rival's Maximum Bid by subtraction.
	 */
	it('carries no Maximum Bid, cap breakdown or Roster Reserve on ANY row', () => {
		const index = teamsIndexFor({ views: THREE, viewerTeamId: VIEWER });
		for (const row of index.rows) {
			expect(row).not.toHaveProperty('maximumBid');
			expect(row).not.toHaveProperty('maximumBidLabel');
			expect(row).not.toHaveProperty('capBreakdown');
			expect(row).not.toHaveProperty('rosterReserve');
		}
		const payload = JSON.stringify(index);
		expect(payload).not.toContain('Maximum Bid');
		expect(payload).not.toContain('Roster Reserve');
	});
});

describe('the own-row marker — marks a row, never moves one', () => {
	it('replaces the Manager half with `— you` on exactly one row', () => {
		const index = teamsIndexFor({ views: THREE, viewerTeamId: VIEWER });
		const marked = index.rows.filter((row) => row.isViewer);
		expect(marked).toHaveLength(1);
		expect(marked[0]?.teamId).toBe(VIEWER);
		expect(marked[0]?.managerSuffix).toBe(OWN_ROW_MARKER);
		expect(marked[0]?.managerSuffix).toBe(' — you');
		// The Team name itself is untouched — every Team name sits in `text`,
		// the viewer's included (DESIGN.md:187).
		expect(marked[0]?.teamName).toBe('Bucks');
		// ...and no other row is marked or renamed.
		for (const row of index.rows.filter((entry) => !entry.isViewer)) {
			expect(row.managerSuffix).toBe(' — Meakel');
		}
	});

	it('marks nothing at all for a viewer bound to no Team', () => {
		const index = teamsIndexFor({ views: THREE, viewerTeamId: null });
		expect(index.rows.some((row) => row.isViewer)).toBe(false);
		expect(index.rows.every((row) => row.managerSuffix === ' — Meakel')).toBe(true);
	});

	it('does not pin, reorder or exempt the marked row from any sort', () => {
		const marked = teamsIndexFor({ views: THREE, viewerTeamId: VIEWER });
		const unmarked = teamsIndexFor({ views: THREE, viewerTeamId: null });
		for (const key of TEAMS_SORT_KEYS) {
			expect(sortTeamsIndex(marked.rows, key).map((row) => row.teamId)).toEqual(
				sortTeamsIndex(unmarked.rows, key).map((row) => row.teamId)
			);
		}
	});

	it('names every Manager of a co-managed Team, and the Team once', () => {
		const co = viewFor({
			teamId: 't-co',
			teamName: 'Lakers',
			managerNames: ['Dana', 'Meakel']
		});
		const index = teamsIndexFor({ views: [co], viewerTeamId: null });
		expect(index.rows[0]?.teamName).toBe('Lakers');
		expect(index.rows[0]?.managerSuffix).toBe(' — Dana & Meakel');

		// ...unless it is the viewer's, where `— you` replaces the whole
		// Manager half rather than being appended to it.
		const own = teamsIndexFor({ views: [co], viewerTeamId: 't-co' });
		expect(own.rows[0]?.managerSuffix).toBe(OWN_ROW_MARKER);
		expect(own.rows[0]?.managerSuffix).not.toContain('Dana');
	});
});

describe('sorting is view state and never changes a figure', () => {
	it('defaults to Team name', () => {
		expect(DEFAULT_TEAMS_SORT).toBe('name');
		const index = teamsIndexFor({ views: THREE, viewerTeamId: null });
		expect(sortTeamsIndex(index.rows, DEFAULT_TEAMS_SORT).map((row) => row.teamName)).toEqual([
			'Bucks',
			'Bulls',
			'Hawks'
		]);
	});

	it('reorders under every key without touching a single figure', () => {
		const index = teamsIndexFor({ views: THREE, viewerTeamId: VIEWER });
		const baseline = sortTeamsIndex(index.rows, DEFAULT_TEAMS_SORT);

		for (const key of TEAMS_SORT_KEYS) {
			const sorted = sortTeamsIndex(index.rows, key);
			expect(sorted).toHaveLength(baseline.length);
			// Every row object is byte-identical to the one in the default
			// order — same identity, same labels, same figures.
			for (const row of sorted) {
				const original = baseline.find((entry) => entry.teamId === row.teamId);
				expect(JSON.stringify(row)).toBe(JSON.stringify(original));
			}
		}
	});

	it('orders by Cap Space and Available Cap Space largest first', () => {
		const index = teamsIndexFor({ views: THREE, viewerTeamId: null });
		expect(sortTeamsIndex(index.rows, 'capSpace').map((row) => row.teamName)).toEqual([
			'Hawks',
			'Bucks',
			'Bulls'
		]);
		expect(sortTeamsIndex(index.rows, 'availableCapSpace').map((row) => row.teamName)).toEqual([
			'Hawks',
			'Bucks',
			'Bulls'
		]);
	});

	it('orders by free Active/Bench Slots most first', () => {
		const index = teamsIndexFor({ views: THREE, viewerTeamId: null });
		expect(
			sortTeamsIndex(index.rows, 'freeActiveBenchSlots').map((row) => row.freeActiveBenchSlots)
		).toEqual([4, 3, 0]);
	});

	it('is TOTAL: two Teams with identical figures still have a stated order', () => {
		const twins = [
			viewFor({ teamId: 't-b', teamName: 'Twins', capSpace: 1_000_000, rosterCount: 9 }),
			viewFor({ teamId: 't-a', teamName: 'Twins', capSpace: 1_000_000, rosterCount: 9 })
		];
		const index = teamsIndexFor({ views: twins, viewerTeamId: null });
		for (const key of TEAMS_SORT_KEYS) {
			// The Team id ends every chain and is unique by construction, so
			// the answer is the same however the input happened to arrive.
			expect(sortTeamsIndex(index.rows, key).map((row) => row.teamId)).toEqual(['t-a', 't-b']);
			expect(sortTeamsIndex([...index.rows].reverse(), key).map((row) => row.teamId)).toEqual([
				't-a',
				't-b'
			]);
		}
	});

	it('sorts a COPY and leaves the caller’s array alone', () => {
		const index = teamsIndexFor({ views: THREE, viewerTeamId: null });
		const before = index.rows.map((row) => row.teamId);
		sortTeamsIndex(index.rows, 'capSpace');
		expect(index.rows.map((row) => row.teamId)).toEqual(before);
	});
});

describe('the League Median — a bare fact at the foot', () => {
	it('is identical under every sort order, because it is taken over the unsorted set', () => {
		const answer = JSON.stringify(teamsIndexFor({ views: THREE, viewerTeamId: VIEWER }).median);

		for (const key of TEAMS_SORT_KEYS) {
			// The views are put into the order each sort would place them in —
			// `sortTeamsIndex` is structural, so it orders views as readily as
			// rows — and the index is built again from that order. The median
			// must not move, in either direction.
			const forwards = sortTeamsIndex(THREE, key);
			const backwards = [...forwards].reverse();
			expect(
				JSON.stringify(teamsIndexFor({ views: forwards, viewerTeamId: VIEWER }).median),
				key
			).toBe(answer);
			expect(
				JSON.stringify(teamsIndexFor({ views: backwards, viewerTeamId: VIEWER }).median),
				key
			).toBe(answer);
		}
	});

	it('states the middle Team’s own figures for an odd count', () => {
		const index = teamsIndexFor({ views: THREE, viewerTeamId: null });
		expect(index.median.availableCapSpace.figure).toBe('$23.0M');
		expect(index.median.freeActiveBenchSlots.figure).toBe('3');
		expect(index.median.label).toBe(MEDIAN_LABEL);
	});

	it('states one Team’s own figures as the median when there is one Team', () => {
		const [bulls] = THREE;
		const index = teamsIndexFor({ views: [bulls as TeamsIndexInput], viewerTeamId: null });
		expect(index.median.availableCapSpace.figure).toBe(bulls?.availableCapSpaceLabel);
		expect(index.median.availableCapSpace.coverage).toBe(1);
		expect(index.median.availableCapSpace.coverageSentence).toBe(medianCoverageSentence(1));
	});

	it('states the median UNAVAILABLE for no Teams — never $0.0M and never 0', () => {
		const index = teamsIndexFor({ views: [], viewerTeamId: null });
		expect(index.rows).toEqual([]);
		expect(index.median.availableCapSpace.figure).toBe(MEDIAN_UNAVAILABLE);
		expect(index.median.freeActiveBenchSlots.figure).toBe(MEDIAN_UNAVAILABLE);
		expect(index.median.availableCapSpace.figure).not.toBe('$0.0M');
		expect(index.median.freeActiveBenchSlots.figure).not.toBe('0');
		expect(index.countSentence).toBe(teamCountSentence(0));
	});

	/**
	 * A Team whose figure could not be answered contributes no VALUE, and the
	 * stated coverage shrinks with it. A median captioned 3 while computed
	 * over 2 would be the quietest lie on the surface.
	 */
	it('shrinks its stated coverage when a Team answers no figure', () => {
		const unanswered: TeamsIndexInput = {
			...(THREE[0] as TeamsIndexInput),
			teamId: 't-null',
			teamName: 'Nulls',
			availableCapSpace: null as Money | null
		};
		const index = teamsIndexFor({ views: [...THREE, unanswered], viewerTeamId: null });
		expect(index.rows).toHaveLength(4);
		expect(index.median.availableCapSpace.coverage).toBe(3);
		expect(index.median.availableCapSpace.coverageSentence).toBe(medianCoverageSentence(3));
		// The slot half is still answered by all four.
		expect(index.median.freeActiveBenchSlots.coverage).toBe(4);
	});

	/**
	 * The printed phrase exists in the CORE, not in a template. `label` and
	 * `figure` are the two visual registers; `sentence` is what a screen
	 * reader gets, and what makes "every string originates in
	 * `src/lib/core/`" true of the median line as well as of the rows.
	 */
	it('composes each median figure into one sentence, beside its two registers', () => {
		const index = teamsIndexFor({ views: THREE, viewerTeamId: null });

		expect(index.median.availableCapSpace.sentence).toBe('Available Cap Space $23.0M');
		expect(index.median.freeActiveBenchSlots.sentence).toBe('Free Active/Bench Slots 3');

		// The sentence is the two registers joined by the core's own
		// separator, so a surface can never disagree with it.
		for (const figure of [index.median.availableCapSpace, index.median.freeActiveBenchSlots]) {
			expect(figure.sentence).toBe(medianFigureSentence(figure.label, figure.figure));
			expect(figure.sentence).toContain(figure.label);
			expect(figure.sentence).toContain(figure.figure);
		}
	});

	it('composes the unavailable case into a sentence too, never a bare label', () => {
		const index = teamsIndexFor({ views: [], viewerTeamId: null });
		expect(index.median.availableCapSpace.sentence).toBe(
			`Available Cap Space ${MEDIAN_UNAVAILABLE}`
		);
		expect(index.median.freeActiveBenchSlots.sentence).toBe(
			`Free Active/Bench Slots ${MEDIAN_UNAVAILABLE}`
		);
	});

	/**
	 * The note explains why the abbreviated one-decimal rendering is SAFE, so
	 * it cannot explain it using that same abbreviated rendering: `$0.5M` is
	 * circular and tells a Manager nothing about the step. The mockup writes
	 * `$500,000` for the same reason.
	 */
	it('spells the grid step in exact dollars, never as an abbreviated figure', () => {
		expect(MEDIAN_GRID_NOTE).toBe(
			'The lower of the two middle values, so the figure always lands on the $500,000 grid.'
		);
		expect(MEDIAN_GRID_NOTE).toContain('$500,000');
		expect(MEDIAN_GRID_NOTE, 'the note explains the grid with the rendering it justifies')
			.not.toContain('$0.5M');
	});

	it('captions the coverage the way DESIGN.md:189 asks, and says median not average', () => {
		expect(medianCoverageSentence(30)).toBe('Median · 30 Teams');
		expect(medianCoverageSentence(1)).toBe('Median · one Team');
		expect(medianCoverageSentence(0)).toBe('Median · no Teams');
	});
});

describe('the index states figures and nothing ABOUT them', () => {
	/**
	 * No comparison of any kind against the median (`EXPERIENCE.md:131-133`).
	 * Asserted over EVERY exported string in the module, so a word cannot
	 * arrive later in a label nobody re-read.
	 */
	it('exports no word that compares, ranks or judges a Team', () => {
		const forbidden = [
			'average',
			'above',
			'below',
			'rank',
			'rich',
			'poor',
			'stacked',
			'ahead',
			'behind',
			'best',
			'worst',
			'leader'
		];
		const strings: string[] = [];
		for (const value of Object.values(teamsIndexModule)) {
			if (typeof value === 'string') strings.push(value);
			else if (Array.isArray(value)) {
				for (const entry of value) if (typeof entry === 'string') strings.push(entry);
			} else if (value !== null && typeof value === 'object') {
				for (const entry of Object.values(value)) {
					if (typeof entry === 'string') strings.push(entry);
				}
			}
		}
		expect(strings.length).toBeGreaterThan(0);
		for (const text of strings) {
			for (const word of forbidden) {
				expect(text.toLowerCase(), `"${text}" contains "${word}"`).not.toContain(word);
			}
		}
	});

	it('produces no row field and no median field naming a comparison', () => {
		const index = teamsIndexFor({ views: THREE, viewerTeamId: VIEWER });
		const payload = JSON.stringify(index).toLowerCase();
		for (const word of ['average', 'rank', 'above', 'below', 'ahead', 'behind']) {
			expect(payload, word).not.toContain(word);
		}
	});

	it('names each sort by the label the figure already carries on the row', () => {
		expect(TEAMS_SORT_LABELS.availableCapSpace).toBe('Available Cap Space');
		expect(TEAMS_SORT_LABELS.capSpace).toBe('Cap Space');
		expect(TEAMS_SORT_LABELS.freeActiveBenchSlots).toBe('Free Active/Bench Slots');
		expect(TEAMS_SORT_LABELS.name).toBe('Team name');
	});
});

// --- The bids figures on a row (Story 10.6) ---------------------------------

describe('the Teams index row — bids against the allowance, entries beside them', () => {
	const lead = (fantraxPlayerId: string, amount: number, isContentionEntry = false) => ({
		fantraxPlayerId,
		playerName: fantraxPlayerId,
		amount: parseMoney(amount),
		isContentionEntry
	});

	function rowWith(team: TeamMoneyState) {
		const view = teamViewFor({
			teamName: 'Bulls',
			managerNames: ['Meakel'],
			rosterRows: [],
			team,
			phase: 'Auction',
			nomination: null,
			viewerIsThisTeam: false,
			now: NOW
		});
		return teamsIndexFor({
			views: [{ ...view, teamId: 't-bulls' }],
			viewerTeamId: null
		}).rows[0];
	}

	it('reads the row figures off the view, never re-deriving them', () => {
		const row = rowWith(
			teamWith({ rosterCount: 9, leading: [lead('p-1', 3_000_000), lead('p-2', 4_000_000)] })
		);

		expect(row?.outstandingBidsHalves?.full).toBe('2 of 4 bids');
		expect(row?.outstandingBids).toBe(2);
		expect(row?.bidAllowance).toBe(4);
		expect(row?.openContentionEntries).toBe(0);
		// The count is still a fact on the row; the SENTENCE is what is
		// absent, because a Team holding no entries has nothing to report.
		expect(row?.contentionEntriesHalves).toBeNull();
	});

	it('keeps the two figures separate — one non-entry Bid, four entries held', () => {
		// The matrix row: bids `1 of 3`, and the four entries stated on their
		// own and never summed into it.
		const row = rowWith(
			teamWith({
				rosterCount: 10,
				leading: [
					lead('p-1', 3_000_000),
					lead('lot-1', 1_000_000, true),
					lead('lot-2', 1_000_000, true),
					lead('lot-3', 1_000_000, true)
				],
				eligibleLeading: [lead('lot-4', 1_000_000, true)]
			})
		);

		expect(row?.outstandingBidsHalves?.full).toBe('1 of 3 bids');
		expect(row?.contentionEntriesHalves?.full).toBe('4 lottery entries');
		// The two are never one figure: neither sentence contains the other's
		// count, and 1 + 4 = 5 appears in neither.
		expect(row?.outstandingBidsHalves?.full).not.toContain('4');
		expect(row?.contentionEntriesHalves?.full).not.toContain('5');
	});

	it('reads 0 of n for a Team whose only commitments are entries', () => {
		const row = rowWith(
			teamWith({
				rosterCount: 9,
				leading: [lead('lot-1', 1_000_000, true), lead('lot-2', 1_000_000, true)]
			})
		);

		expect(row?.outstandingBidsHalves?.full).toBe('0 of 4 bids');
		expect(row?.contentionEntriesHalves?.full).toBe('2 lottery entries');
	});
});
