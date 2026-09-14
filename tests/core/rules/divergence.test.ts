/**
 * `compareMembership` — the I/O matrix, row by row (Story 7.9, FR-42).
 *
 * Pure, so this file drives the function directly with state literals and no
 * fake of anything. Every row of the story's matrix that is about the
 * COMPARISON is here: movement, departure, unknown arrival, won-Player
 * exclusion, placement-only silence, multi-Player Trade grouping, both halves
 * of the plausibility guard, and fingerprint stability across a re-read with
 * change on changed content. The rows about the READ — stopped, rate limited,
 * malformed, skipped — belong to `tests/server/divergence.test.ts`, because
 * none of them reaches this function at all.
 */

import { describe, expect, it } from 'vitest';

import { INITIAL_CONTRACTS } from '../../../src/lib/core/projection/contracts.ts';
import type { AuctionContract, AuctionContracts } from '../../../src/lib/core/projection/contracts.ts';
import { NO_DIVERGENCES_STATEMENT, compareMembership } from '../../../src/lib/core/rules/divergence.ts';
import type {
	AppRosterMember,
	DivergenceInput,
	DivergenceTeam,
	FantraxMember,
	ProposedDrop,
	ProposedTrade
} from '../../../src/lib/core/rules/divergence.ts';
import { parseMoney } from '../../../src/lib/core/money.ts';

/**
 * TWELVE Teams, not four, and the number matters.
 *
 * The plausibility guard trips at a quarter of the League, counted in Teams
 * TOUCHED. With four Teams a quarter is one, so a single Trade — which touches
 * two — would trip the guard in every test in this file and every assertion
 * below would be about the guard instead of about the comparison. Twelve makes
 * the quarter three, so an ordinary Trade or Drop passes and the volume tests
 * have to work to trip it, which is the real proportion of a thirty-Team
 * league.
 */
const TEAM_KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'] as const;

const TEAMS: readonly DivergenceTeam[] = TEAM_KEYS.map((key) => ({
	teamId: `t-${key}`,
	teamName: `Team ${key.toUpperCase()}`,
	fantraxTeamId: `ftx-${key}`
}));

const ALL_FANTRAX_TEAM_IDS: readonly string[] = TEAMS.map((team) => String(team.fantraxTeamId));

/**
 * Stored asterisk-wrapped, exactly as the FR-1 importer writes it — and handed
 * in with its CANONICAL form beside it.
 *
 * That pairing is the shell's job in production (`server/divergence.ts` applies
 * `adapters/fantrax`'s `normaliseFantraxPlayerId` to both sides), and this
 * helper stands in for it. `compareMembership` normalises nothing and knows no
 * Fantrax string format — AD-24 keeps that knowledge in the adapter — so every
 * test here supplies ids that are already canonical.
 */
function appMember(
	teamId: string,
	id: string,
	name: string,
	slot: AppRosterMember['rosterSlotKind'] = 'active_bench'
): AppRosterMember {
	return {
		teamId,
		playerId: id.toLowerCase(),
		fantraxPlayerId: `*${id}*`,
		playerName: name,
		rosterSlotKind: slot
	};
}

/** Bare, exactly as the API answers. */
function fantraxMember(
	fantraxTeamId: string,
	id: string,
	name: string,
	slot: FantraxMember['rosterSlotKind'] = 'active_bench'
): FantraxMember {
	return { fantraxTeamId, playerId: id, playerName: name, rosterSlotKind: slot };
}

function contractsFor(...playerIds: readonly string[]): AuctionContracts {
	const byPlayer: Record<string, AuctionContract> = {};
	for (const playerId of playerIds) {
		byPlayer[playerId] = {
			fantraxPlayerId: playerId,
			playerName: playerId,
			teamId: 't-a',
			teamName: 'Team A',
			winningAmount: parseMoney(5_000_000),
			capHit: parseMoney(5_000_000),
			placement: 'active_bench',
			contractYears: null,
			closedAt: '2026-09-10T00:00:00.000Z'
		};
	}
	return { byPlayer };
}

/**
 * One Player per Team that AGREES on both sides, so every Team is covered and
 * holds somebody — the guard's first two halves pass and the test's own members
 * are the only thing under examination.
 *
 * Added unconditionally to both sides, never "only where a Team is not already
 * mentioned": padding one side and not the other is how a fixture silently
 * manufactures the very arrival or departure the test is trying to rule out.
 */
const PAD_APP: readonly AppRosterMember[] = TEAMS.map((team) =>
	appMember(team.teamId, `pad-${team.teamId}`, `Pad ${team.teamName}`)
);
const PAD_FANTRAX: readonly FantraxMember[] = TEAMS.map((team) =>
	fantraxMember(String(team.fantraxTeamId), `pad-${team.teamId}`, `Pad ${team.teamName}`)
);

function paddedApp(members: readonly AppRosterMember[]): readonly AppRosterMember[] {
	return [...PAD_APP, ...members];
}

function padded(members: readonly FantraxMember[]): readonly FantraxMember[] {
	return [...PAD_FANTRAX, ...members];
}

function compare(input: Partial<DivergenceInput>) {
	return compareMembership({
		teams: TEAMS,
		appMembers: paddedApp([]),
		fantraxMembers: padded([]),
		fantraxTeamIds: ALL_FANTRAX_TEAM_IDS,
		contracts: INITIAL_CONTRACTS,
		canonicalContractIds: [],
		volumeFraction: 0.25,
		dismissedFingerprints: [],
		...input
	});
}

describe('a Player moved', () => {
	it('proposes one Roster Trade for the pair, with the Player on the correct side', () => {
		const report = compare({
			appMembers: paddedApp([appMember('t-a', 'p1', 'Amir Powell')]),
			fantraxMembers: padded([fantraxMember('ftx-b', 'p1', 'Amir Powell')])
		});

		expect(report.proposals).toHaveLength(1);
		const proposal = report.proposals[0] as ProposedTrade;
		expect(proposal.kind).toBe('trade');
		expect(proposal.fromTeam.teamId).toBe('t-a');
		expect(proposal.toTeam.teamId).toBe('t-b');
		// The stored id travels, asterisks included, because that is what
		// /roster-trade must name to find the row.
		expect(proposal.sending.map((player) => player.fantraxPlayerId)).toEqual(['*p1*']);
		expect(proposal.receiving).toEqual([]);
	});

	it('builds a /roster-trade link the route can read verbatim', () => {
		const report = compare({
			appMembers: paddedApp([appMember('t-a', 'p1', 'Amir Powell')]),
			fantraxMembers: padded([fantraxMember('ftx-b', 'p1', 'Amir Powell')])
		});
		const proposal = report.proposals[0] as ProposedTrade;

		// The exact parameter names /roster-trade's load and action read off
		// url.searchParams: from, to, repeated send, repeated recv.
		const url = new URL(proposal.href, 'https://bbsl.example');
		expect(url.pathname).toBe('/roster-trade');
		expect(url.searchParams.get('from')).toBe('t-a');
		expect(url.searchParams.get('to')).toBe('t-b');
		expect(url.searchParams.getAll('send')).toEqual(['*p1*']);
		expect(url.searchParams.getAll('recv')).toEqual([]);
	});

	it('groups every movement between one pair into ONE proposal, both directions', () => {
		// Pairing is grouping, not matching: a movement is directly observed, and
		// the two directions are one Trade rather than two.
		const report = compare({
			appMembers: paddedApp([
				appMember('t-a', 'p1', 'Amir Powell'),
				appMember('t-a', 'p2', 'Bo Ellis'),
				appMember('t-b', 'p3', 'Cy Duren')
			]),
			fantraxMembers: padded([
				fantraxMember('ftx-b', 'p1', 'Amir Powell'),
				fantraxMember('ftx-b', 'p2', 'Bo Ellis'),
				fantraxMember('ftx-a', 'p3', 'Cy Duren')
			])
		});

		expect(report.proposals).toHaveLength(1);
		const proposal = report.proposals[0] as ProposedTrade;
		expect(proposal.sending.map((player) => player.playerName)).toEqual(['Amir Powell', 'Bo Ellis']);
		expect(proposal.receiving.map((player) => player.playerName)).toEqual(['Cy Duren']);
	});

	it('accepts a one-directional gift as a Trade with an empty side', () => {
		const report = compare({
			appMembers: paddedApp([appMember('t-a', 'p1', 'Amir Powell')]),
			fantraxMembers: padded([fantraxMember('ftx-b', 'p1', 'Amir Powell')])
		});
		expect((report.proposals[0] as ProposedTrade).receiving).toEqual([]);
	});
});

describe('a Player gone', () => {
	it('proposes one Drop per Team, linking to /roster-drop pre-filled', () => {
		const report = compare({
			appMembers: paddedApp([
				appMember('t-a', 'p1', 'Amir Powell'),
				appMember('t-a', 'p2', 'Bo Ellis')
			]),
			// Neither is anywhere in Fantrax.
			fantraxMembers: padded([fantraxMember('ftx-a', 'keep', 'Keeper')])
		});

		expect(report.proposals).toHaveLength(1);
		const proposal = report.proposals[0] as ProposedDrop;
		expect(proposal.kind).toBe('drop');
		expect(proposal.team.teamId).toBe('t-a');

		const url = new URL(proposal.href, 'https://bbsl.example');
		expect(url.pathname).toBe('/roster-drop');
		expect(url.searchParams.get('team')).toBe('t-a');
		expect(url.searchParams.getAll('drop').sort()).toEqual(['*p1*', '*p2*']);
	});

	it('is a Drop only when the Player is on NO Fantrax roster at all', () => {
		// On another roster is a Trade; on none is a Drop. The two must not be
		// reachable from the same shape.
		const report = compare({
			appMembers: paddedApp([appMember('t-a', 'p1', 'Amir Powell')]),
			fantraxMembers: padded([fantraxMember('ftx-c', 'p1', 'Amir Powell')])
		});
		expect(report.proposals.map((proposal) => proposal.kind)).toEqual(['trade']);
	});
});

describe('a Dead Money row', () => {
	it('raises nothing — the Player is gone from Fantrax BY DESIGN', () => {
		// A released Contract keeps charging the Cap and keeps its `team_rosters`
		// row, but the Player left the Fantrax roster when he was dropped. That
		// absence is the CORRECT state, not drift, so reading it as a departure
		// would invite the Commissioner to drop a Player already dropped — every
		// pass, forever, because acting on the proposal cannot change the row.
		const report = compare({
			appMembers: paddedApp([appMember('t-a', 'p1', 'Amir Powell', 'dead_money')]),
			fantraxMembers: padded([])
		});
		expect(report.proposals).toEqual([]);
		expect(report.arrivals).toEqual([]);
		expect(report.clean).toBe(true);
	});

	it('still raises a Drop for a row that is NOT Dead Money', () => {
		// The guard above must turn on the Slot kind alone. An ordinary Contract
		// absent from Fantrax is a real Drop and stays one.
		const report = compare({
			appMembers: paddedApp([appMember('t-a', 'p1', 'Amir Powell', 'active_bench')]),
			fantraxMembers: padded([])
		});
		expect(report.proposals.map((proposal) => proposal.kind)).toEqual(['drop']);
	});

	it('raises nothing when the Player turns up on ANOTHER Fantrax roster', () => {
		// Expected, not drift: the Team carries his Dead Money precisely BECAUSE
		// he is no longer theirs, so another Team rostering him is the ordinary
		// consequence. Neither a Trade proposal nor an unknown arrival.
		const report = compare({
			appMembers: paddedApp([appMember('t-a', 'p1', 'Amir Powell', 'dead_money')]),
			fantraxMembers: padded([fantraxMember('ftx-c', 'p1', 'Amir Powell')])
		});
		expect(report.proposals).toEqual([]);
		expect(report.arrivals).toEqual([]);
		expect(report.clean).toBe(true);
	});
});

describe('an unknown arrival', () => {
	it('is reported as an error and never as a proposal', () => {
		const report = compare({
			appMembers: paddedApp([]),
			fantraxMembers: padded([fantraxMember('ftx-a', 'stranger', 'Nobody Knows')])
		});

		expect(report.proposals).toEqual([]);
		expect(report.arrivals).toHaveLength(1);
		expect(report.arrivals[0]?.playerName).toBe('Nobody Knows');
		expect(report.arrivals[0]?.teamName).toBe('Team A');
		expect(report.clean).toBe(false);
	});
});

describe('a Player won in this auction', () => {
	it('is excluded from BOTH sides — neither a departure nor an arrival', () => {
		// The app holds him because the auction put him there and Fantrax has not
		// been told; neither word is a true description of that.
		const report = compare({
			appMembers: paddedApp([appMember('t-a', 'won1', 'Won Player')]),
			fantraxMembers: padded([]),
			// The contract is keyed on the asterisk-wrapped id the close recorded,
			// and the shell hands in its canonical form beside it — exactly as
			// `loadDivergenceView` does from `Object.keys(contracts.byPlayer)`.
			contracts: contractsFor('*won1*'),
			canonicalContractIds: [['*won1*', 'won1']]
		});
		expect(report.proposals).toEqual([]);
		expect(report.arrivals).toEqual([]);
		expect(report.clean).toBe(true);
	});

	it('is excluded on the Fantrax side too, whichever spelling the contract carries', () => {
		const report = compare({
			appMembers: paddedApp([]),
			fantraxMembers: padded([fantraxMember('ftx-a', 'won1', 'Won Player')]),
			contracts: contractsFor('*won1*'),
			canonicalContractIds: [['*won1*', 'won1']]
		});
		expect(report.arrivals).toEqual([]);
	});
});

describe('a placement difference', () => {
	it('raises nothing — a Slot kind is advisory and never compared', () => {
		// The expected state between a Roster Move and the next export. Raising it
		// would report the app working correctly as drift.
		const report = compare({
			appMembers: paddedApp([appMember('t-a', 'p1', 'Amir Powell', 'minor_league')]),
			fantraxMembers: padded([fantraxMember('ftx-a', 'p1', 'Amir Powell', 'active_bench')])
		});
		expect(report.proposals).toEqual([]);
		expect(report.arrivals).toEqual([]);
		expect(report.clean).toBe(true);
	});
});

describe('the Team map', () => {
	it('renders NOT CONFIGURED and raises nothing when a Team has no Fantrax id', () => {
		const report = compare({
			teams: [...TEAMS.slice(0, 11), { teamId: 't-l', teamName: 'Team L', fantraxTeamId: null }],
			appMembers: paddedApp([appMember('t-a', 'p1', 'Amir Powell')]),
			fantraxMembers: padded([fantraxMember('ftx-b', 'p1', 'Amir Powell')])
		});

		expect(report.configured).toBe(false);
		// NAMED, never counted.
		expect(report.unmappedTeamNames).toEqual(['Team L']);
		expect(report.proposals).toEqual([]);
		expect(report.arrivals).toEqual([]);
		// And crucially: never the empty state.
		expect(report.clean).toBe(false);
	});

	it('treats a blank id as the same absence as a null', () => {
		const report = compare({
			teams: [...TEAMS.slice(0, 11), { teamId: 't-l', teamName: 'Team L', fantraxTeamId: '  ' }]
		});
		expect(report.unmappedTeamNames).toEqual(['Team L']);
	});

	it('names a Fantrax roster no Team claims — the same fault from the other side', () => {
		const report = compare({
			fantraxMembers: padded([fantraxMember('ftx-nobody', 'p1', 'Amir Powell')]),
			fantraxTeamIds: [...ALL_FANTRAX_TEAM_IDS, 'ftx-nobody']
		});
		expect(report.configured).toBe(false);
		expect(report.unclaimedFantraxTeamIds).toEqual(['ftx-nobody']);
		expect(report.clean).toBe(false);
	});
});

describe('the plausibility guard', () => {
	it('trips when a mapped Team is missing from the payload', () => {
		// Team L is absent from the answer entirely: neither its id nor any of its
		// rows arrived. Without this half, its whole roster would read as departed.
		const report = compare({
			fantraxMembers: PAD_FANTRAX.filter((member) => member.fantraxTeamId !== 'ftx-l'),
			fantraxTeamIds: ALL_FANTRAX_TEAM_IDS.filter((id) => id !== 'ftx-l')
		});
		expect(report.guard.tripped).toBe(true);
		if (!report.guard.tripped) return;
		expect(report.guard.reason).toBe('missing_teams');
		expect(report.guard.detail).toContain('Team L');
		expect(report.proposals).toEqual([]);
		expect(report.clean).toBe(false);
	});

	it('trips on a Team that came back with an EMPTY roster, distinctly from a missing one', () => {
		// Team L's id IS in the payload and it carries no rows. No real roster is
		// empty, and an empty one manufactures a Drop of every Player on it — which
		// is exactly what would happen here without the guard, since Team L's
		// padded Player is still on the app's side.
		const report = compare({
			fantraxMembers: PAD_FANTRAX.filter((member) => member.fantraxTeamId !== 'ftx-l'),
			fantraxTeamIds: ALL_FANTRAX_TEAM_IDS
		});
		expect(report.guard.tripped).toBe(true);
		if (!report.guard.tripped) return;
		// The two are different facts and are reported as different reasons.
		expect(report.guard.reason).toBe('empty_roster');
		expect(report.guard.detail).toContain('Team L');
		expect(report.proposals).toEqual([]);
	});

	it('trips when a pass would touch more than the given fraction of the League', () => {
		// Twelve Teams, a quarter is three, and this pass touches four.
		const report = compare({
			appMembers: paddedApp([
				appMember('t-a', 'p1', 'One'),
				appMember('t-b', 'p2', 'Two'),
				appMember('t-c', 'p3', 'Three'),
				appMember('t-d', 'p4', 'Four')
			]),
			fantraxMembers: padded([fantraxMember('ftx-a', 'keep', 'Keeper')]),
			volumeFraction: 0.25
		});
		expect(report.guard.tripped).toBe(true);
		if (!report.guard.tripped) return;
		expect(report.guard.reason).toBe('volume');
		expect(report.proposals).toEqual([]);
		expect(report.suppressedCount).toBeGreaterThan(0);
	});

	it('does NOT trip at the same volume once the fraction is widened', () => {
		// FR-42's "fraction tunable without a code change", proven as a
		// parameter: the same inputs, a different number, a different verdict.
		const report = compare({
			appMembers: paddedApp([
				appMember('t-a', 'p1', 'One'),
				appMember('t-b', 'p2', 'Two'),
				appMember('t-c', 'p3', 'Three'),
				appMember('t-d', 'p4', 'Four')
			]),
			fantraxMembers: padded([fantraxMember('ftx-a', 'keep', 'Keeper')]),
			volumeFraction: 0.99
		});
		expect(report.guard.tripped).toBe(false);
		expect(report.proposals.length).toBeGreaterThan(0);
	});

	it('never clears itself, and acknowledging REVEALS the proposals rather than discarding them', () => {
		const inputs = {
			appMembers: paddedApp([
				appMember('t-a', 'p1', 'One'),
				appMember('t-b', 'p2', 'Two'),
				appMember('t-c', 'p3', 'Three'),
				appMember('t-d', 'p4', 'Four')
			]),
			fantraxMembers: padded([fantraxMember('ftx-a', 'keep', 'Keeper')]),
			volumeFraction: 0.25
		};

		const first = compare(inputs);
		const second = compare(inputs);
		// Reloading changes nothing. The verdict is a function of the content.
		expect(second.guard).toEqual(first.guard);
		expect(second.proposals).toEqual([]);

		if (!first.guard.tripped) throw new Error('expected a tripped guard');
		const acknowledged = compare({
			...inputs,
			dismissedFingerprints: [first.guard.fingerprint]
		});
		expect(acknowledged.guard.tripped).toBe(true);
		if (!acknowledged.guard.tripped) return;
		expect(acknowledged.guard.acknowledged).toBe(true);
		// Revealed, not discarded.
		expect(acknowledged.proposals.length).toBeGreaterThan(0);
		expect(acknowledged.suppressedCount).toBe(0);
	});
});

describe('fingerprints', () => {
	const inputs = {
		appMembers: paddedApp([appMember('t-a', 'p1', 'Amir Powell')]),
		fantraxMembers: padded([fantraxMember('ftx-b', 'p1', 'Amir Powell')])
	};

	it('are stable across a re-read of the same content', () => {
		expect(compare(inputs).proposals[0]?.fingerprint).toBe(
			compare(inputs).proposals[0]?.fingerprint
		);
	});

	it('change when the Player changes', () => {
		const other = {
			appMembers: paddedApp([appMember('t-a', 'p9', 'Someone Else')]),
			fantraxMembers: padded([fantraxMember('ftx-b', 'p9', 'Someone Else')])
		};
		expect(compare(other).proposals[0]?.fingerprint).not.toBe(
			compare(inputs).proposals[0]?.fingerprint
		);
	});

	it('change when the DIRECTION changes', () => {
		// A → B and B → A are different divergences and must not share a
		// dismissal.
		const reversed = {
			appMembers: paddedApp([appMember('t-b', 'p1', 'Amir Powell')]),
			fantraxMembers: padded([fantraxMember('ftx-a', 'p1', 'Amir Powell')])
		};
		expect(compare(reversed).proposals[0]?.fingerprint).not.toBe(
			compare(inputs).proposals[0]?.fingerprint
		);
	});

	it('do not change because the same Player was STORED in a different spelling', () => {
		// The canonical id is what the fingerprint is built from, so a Player
		// whose `team_rosters` row is spelled differently — a re-import that
		// changed the wrapping, say — keeps the dismissal he already had. The
		// canonicalisation itself is the shell's and is proven in
		// `tests/server/divergence.test.ts`; what this asserts is that the core
		// fingerprints the canonical id rather than the stored one.
		const wrapped = {
			appMembers: paddedApp([
				{
					teamId: 't-a',
					playerId: 'p1',
					fantraxPlayerId: '**P1**',
					playerName: 'Amir Powell',
					rosterSlotKind: 'active_bench' as const
				}
			]),
			fantraxMembers: padded([fantraxMember('ftx-b', 'p1', 'Amir Powell')])
		};
		expect(compare(wrapped).proposals[0]?.fingerprint).toBe(
			compare(inputs).proposals[0]?.fingerprint
		);
	});

	it('cannot collide two different guard trips through a comma in a Team name', () => {
		// The fingerprint joins on U+001F precisely so that free text cannot make
		// two different sets render to one string. Team names ARE free text, so a
		// comma in one would otherwise let a dismissal of one guard trip silently
		// suppress a different one.
		const withComma = compare({
			teams: [
				{ teamId: 't-a', teamName: 'Team A, B', fantraxTeamId: 'ftx-a' },
				{ teamId: 't-b', teamName: 'Team C', fantraxTeamId: 'ftx-b' }
			],
			appMembers: [],
			fantraxMembers: [],
			fantraxTeamIds: []
		});
		const withoutComma = compare({
			teams: [
				{ teamId: 't-a', teamName: 'Team A', fantraxTeamId: 'ftx-a' },
				{ teamId: 't-b', teamName: 'B, Team C', fantraxTeamId: 'ftx-b' }
			],
			appMembers: [],
			fantraxMembers: [],
			fantraxTeamIds: []
		});

		expect(withComma.guard.tripped).toBe(true);
		expect(withoutComma.guard.tripped).toBe(true);
		if (!withComma.guard.tripped || !withoutComma.guard.tripped) return;
		// "Team A, B" + "Team C" and "Team A" + "B, Team C" join to the same
		// string under a comma, and to different strings under the separator.
		expect(withComma.guard.fingerprint).not.toBe(withoutComma.guard.fingerprint);
	});
});

describe('dismissals', () => {
	const inputs = {
		appMembers: paddedApp([appMember('t-a', 'p1', 'Amir Powell')]),
		fantraxMembers: padded([fantraxMember('ftx-b', 'p1', 'Amir Powell')])
	};

	it('suppress exactly the divergence they were taken against', () => {
		const fingerprint = compare(inputs).proposals[0]?.fingerprint ?? '';
		const after = compare({ ...inputs, dismissedFingerprints: [fingerprint] });

		expect(after.proposals).toEqual([]);
		expect(after.dismissedCount).toBe(1);
		// A suppressed divergence is NOT a clean read — it is still true.
		expect(after.clean).toBe(false);
	});

	it('stop suppressing the moment the content changes', () => {
		const fingerprint = compare(inputs).proposals[0]?.fingerprint ?? '';
		const changed = compare({
			appMembers: paddedApp([
				appMember('t-a', 'p1', 'Amir Powell'),
				appMember('t-a', 'p2', 'Bo Ellis')
			]),
			fantraxMembers: padded([
				fantraxMember('ftx-b', 'p1', 'Amir Powell'),
				fantraxMember('ftx-b', 'p2', 'Bo Ellis')
			]),
			dismissedFingerprints: [fingerprint]
		});
		expect(changed.proposals).toHaveLength(1);
		expect(changed.dismissedCount).toBe(0);
	});

	it('do not lower the guard: a dismissed proposal still counts toward the volume', () => {
		const inputsFour = {
			// Four Teams touched against a quarter of twelve — over the line.
			appMembers: paddedApp([
				appMember('t-a', 'p1', 'One'),
				appMember('t-b', 'p2', 'Two'),
				appMember('t-c', 'p3', 'Three'),
				appMember('t-d', 'p4', 'Four')
			]),
			fantraxMembers: padded([fantraxMember('ftx-a', 'keep', 'Keeper')]),
			volumeFraction: 0.25
		};
		const fingerprints = compare({ ...inputsFour, volumeFraction: 0.99 }).proposals.map(
			(proposal) => proposal.fingerprint
		);
		const after = compare({ ...inputsFour, dismissedFingerprints: fingerprints });
		expect(after.guard.tripped).toBe(true);
	});
});

describe('a Trade recorded in the app', () => {
	it('resolves the divergence on the next comparison with no dismissal needed', () => {
		const before = compare({
			appMembers: paddedApp([appMember('t-a', 'p1', 'Amir Powell')]),
			fantraxMembers: padded([fantraxMember('ftx-b', 'p1', 'Amir Powell')])
		});
		expect(before.proposals).toHaveLength(1);

		// The same Fantrax payload, and `team_rosters` now agreeing with it.
		const after = compare({
			appMembers: paddedApp([appMember('t-b', 'p1', 'Amir Powell')]),
			fantraxMembers: padded([fantraxMember('ftx-b', 'p1', 'Amir Powell')])
		});
		expect(after.proposals).toEqual([]);
		expect(after.dismissedCount).toBe(0);
		expect(after.clean).toBe(true);
	});
});

describe('the wording', () => {
	it('puts the words "no divergences" in exactly one constant', () => {
		// Every other state — stopped, not configured, tripped — words itself
		// differently on purpose, so a failure can never read as a clean read.
		expect(NO_DIVERGENCES_STATEMENT).toContain('no divergences');
	});
});
