/**
 * `recordRearrange` — the one transaction, the one statement, and the silence
 * (Story 7.11, FR-44).
 *
 * Five claims this file exists to hold, none of which is visible from the
 * pure core:
 *
 *  1. **An Existing Contract is one `UPDATE` of `roster_slot_kind` alone** —
 *     `team_id` and `cap_hit` are untouched, because a Move re-places and
 *     does not restructure.
 *  2. **A WON Contract gets no statement at all.** It has no `team_rosters`
 *     row; `contractsReducer` moves it when the event is appended, and a
 *     stray `UPDATE` for it would silently write nothing while looking like
 *     it worked.
 *  3. **One transaction, under the global lock.** Lock before any read
 *     (AD-6), event and rows inside the same `begin`…`commit`, and a refusal
 *     rolls back with nothing written.
 *  4. **Nothing on the outbox.** A Move is not broadcast, and `recordRearrange`
 *     passes no `enqueue` at all — so the claim is structural rather than a
 *     setting.
 *  5. **The reason is nullable, and the payload carries whichever it was.**
 *     A Manager's own Move records `null`; the Commissioner's records the
 *     text.
 *
 * The stateful fake `ConnectionGateway` is `tests/server/roster-drop.test.ts`'s:
 * it records every statement in order, keeps the appended events in memory and
 * discards them on a `rollback`, so "nothing was written" is observable rather
 * than assumed. It THROWS on any statement it does not recognise, which is what
 * makes "no `delete from team_rosters`, no outbox row" a failure rather than a
 * silence.
 */

import { describe, expect, it } from 'vitest';

import { CORE_VERSION } from '../../src/lib/core/constants.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	INITIAL_CONTRACTS,
	ROSTER_REARRANGED_EVENT
} from '../../src/lib/core/projection/contracts.ts';
import type { RosterRearrangedPayload } from '../../src/lib/core/projection/contracts.ts';
import {
	REARRANGE_ROSTER_ROW_SQL,
	rearrangingTeamFor,
	recordRearrange
} from '../../src/lib/server/roster-rearrange.ts';
import type { RosterRearrangeRejection } from '../../src/lib/server/roster-rearrange.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

const NOW = new Date('2026-09-12T19:00:00.000Z');

const COMMISSIONER = { managerId: 'm-commissioner', teamId: 't-e', displayName: 'The Commissioner' };
const MANAGER = { managerId: 'm-e', teamId: 't-e', displayName: 'Manager E' };

type RosterRow = {
	readonly teamId: string;
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly capHit: number;
	readonly rosterSlotKind: string;
};

function fakeGateway(options: {
	rosters?: readonly RosterRow[];
	events?: readonly QueryResultRow[];
	teams?: ReadonlyArray<{ id: string; name: string }>;
}) {
	const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
	const order: string[] = [];
	const appendedEvents: QueryResultRow[] = [];
	let seq = 300;
	let released = 0;
	let committed = false;

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, params: readonly unknown[] = []) {
			const sql = text.trim();
			statements.push({ sql, params });

			if (/^begin/i.test(sql)) {
				order.push('begin');
				return { rows: [] };
			}
			if (/pg_advisory_xact_lock/i.test(sql)) {
				order.push('lock');
				return { rows: [{ locked: true, now: NOW }] };
			}
			if (/^select \* from auction_events/i.test(sql)) {
				order.push('read-log');
				return { rows: [...(options.events ?? [])] };
			}
			if (/^select id::text as id, name from teams/i.test(sql)) {
				order.push('read-teams');
				return { rows: [...(options.teams ?? [])] };
			}
			if (/^select[\s\S]*from team_rosters/i.test(sql)) {
				order.push('read-roster');
				const teamId = String(params[0]);
				return {
					rows: (options.rosters ?? [])
						.filter((row) => row.teamId === teamId)
						.map((row) => ({
							fantrax_player_id: row.fantraxPlayerId,
							player_name: row.playerName,
							cap_hit: row.capHit,
							roster_slot_kind: row.rosterSlotKind,
							contract_years_remaining: 3,
							rookie_scale_round: null
						}))
				};
			}
			if (/^insert into auction_events/i.test(sql)) {
				order.push('append-event');
				seq += 1;
				const row: QueryResultRow = {
					seq,
					occurred_at: params[0],
					schema_version: params[1],
					core_version: params[2],
					manager_id: params[3],
					team_id: params[4],
					event_type: params[5],
					payload: JSON.parse(String(params[6])),
					device_class: params[7],
					dispatch_outcome: params[8],
					delivery_outcome: params[9]
				};
				appendedEvents.push(row);
				return { rows: [row] };
			}
			if (/^update team_rosters/i.test(sql)) {
				order.push('move-row');
				return { rows: [] };
			}
			if (/^commit/i.test(sql)) {
				order.push('commit');
				committed = true;
				return { rows: [] };
			}
			if (/^rollback/i.test(sql)) {
				order.push('rollback');
				// A real ROLLBACK discards every uncommitted write; the fake must
				// too, or "nothing was written" would be trivially true.
				appendedEvents.length = 0;
				return { rows: [] };
			}
			// Anything else — a `delete from team_rosters`, an
			// `insert into notification_outbox` — fails the test by name rather
			// than passing silently.
			throw new Error(`unexpected statement: ${sql}`);
		},
		release() {
			released += 1;
		}
	};

	return {
		gateway: { connect: async () => client } satisfies ConnectionGateway,
		statements,
		order,
		appendedEvents,
		state: {
			get released() {
				return released;
			},
			get committed() {
				return committed;
			}
		}
	};
}

const TEAMS = [{ id: 't-e', name: 'Team E' }];

/**
 * Team E: two Active/Bench Contracts and two stashes, comfortably inside
 * every ceiling and with Cap Space to spare, so nothing below is refused
 * unless the test means it to be.
 */
const ROSTERS: readonly RosterRow[] = [
	{
		teamId: 't-e',
		fantraxPlayerId: 'p-active',
		playerName: 'Active One',
		capHit: 5_000_000,
		rosterSlotKind: 'active_bench'
	},
	{
		teamId: 't-e',
		fantraxPlayerId: 'p-active-2',
		playerName: 'Active Two',
		capHit: 5_000_000,
		rosterSlotKind: 'active_bench'
	},
	{
		teamId: 't-e',
		fantraxPlayerId: 'p-stash',
		playerName: 'Stashed One',
		capHit: 3_000_000,
		rosterSlotKind: 'minor_league'
	},
	{
		teamId: 't-e',
		fantraxPlayerId: 'p-stash-2',
		playerName: 'Stashed Two',
		capHit: 2_000_000,
		rosterSlotKind: 'minor_league'
	}
];

const REASON = 'Recorded on behalf of the Manager, who is travelling.';

/** The demotion every test below drives, unless it says otherwise. */
const DEMOTE = [{ fantraxPlayerId: 'p-stash', toPlacement: 'active_bench' as const }];

function payloadOf(harness: ReturnType<typeof fakeGateway>): RosterRearrangedPayload {
	return harness.appendedEvents[0]?.['payload'] as unknown as RosterRearrangedPayload;
}

describe('recordRearrange — one transaction, one statement per Existing Contract', () => {
	it('UPDATEs `roster_slot_kind` alone, and touches no other column', async () => {
		const harness = fakeGateway({ rosters: ROSTERS, teams: TEAMS });

		const outcome = await recordRearrange(
			harness.gateway,
			MANAGER,
			{ teamId: 't-e', moves: DEMOTE, reason: null },
			'desktop'
		);

		expect(outcome.kind).toBe('accepted');
		const updates = harness.statements.filter((statement) =>
			/^update team_rosters/i.test(statement.sql)
		);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.sql).toBe(REARRANGE_ROSTER_ROW_SQL);
		// `team_id` and `cap_hit` are deliberately not in the statement: the
		// Contract does not change hands and no amount is edited. What it
		// CHARGES is `chargedCapHit`'s answer about the new Slot, derived on
		// every read.
		expect(updates[0]?.sql).toMatch(
			/^update team_rosters set roster_slot_kind = \$2 where fantrax_player_id = \$1$/
		);
		expect(updates[0]?.sql).not.toMatch(/cap_hit|team_id/);
		expect(updates[0]?.params).toEqual(['p-stash', 'active_bench']);
	});

	it('issues one statement per Contract in a REAL two-legged swap', async () => {
		// **Both legs must actually change Slot**, or the test proves only that
		// two `UPDATE`s were issued for two ids. `p-was-stashed` is an
		// Active/Bench Contract the log has observed in a Minor League Slot, so
		// he is promotable; `p-stash` goes the other way in the same act.
		const swappable: readonly RosterRow[] = [
			...ROSTERS,
			{
				teamId: 't-e',
				fantraxPlayerId: 'p-was-stashed',
				playerName: 'Was Stashed',
				capHit: 1_000_000,
				rosterSlotKind: 'active_bench'
			}
		];
		// The observation that makes the promotion legal, in the log where the
		// fold reads it — exactly the §10 example 46 round trip.
		const demotedEarlier: QueryResultRow = {
			seq: 4,
			occurred_at: new Date('2026-09-12T08:00:00.000Z'),
			schema_version: 1,
			core_version: CORE_VERSION,
			manager_id: 'm-e',
			team_id: 't-e',
			event_type: ROSTER_REARRANGED_EVENT,
			payload: {
				teamId: 't-e',
				teamName: 'Team E',
				moves: [
					{
						fantraxPlayerId: 'p-was-stashed',
						playerName: 'Was Stashed',
						won: false,
						fromPlacement: 'minor_league',
						toPlacement: 'active_bench',
						capHitBefore: 0,
						capHitAfter: 1_000_000,
						value: 1_000_000
					}
				],
				teamBefore: {},
				teamAfter: {},
				reason: null
			}
		};
		const harness = fakeGateway({
			rosters: swappable,
			teams: TEAMS,
			events: [demotedEarlier]
		});

		const outcome = await recordRearrange(
			harness.gateway,
			MANAGER,
			{
				teamId: 't-e',
				moves: [
					{ fantraxPlayerId: 'p-stash', toPlacement: 'active_bench' },
					{ fantraxPlayerId: 'p-was-stashed', toPlacement: 'minor_league' }
				],
				reason: null
			},
			'desktop'
		);

		expect(outcome.kind).toBe('accepted');
		expect(harness.order.filter((step) => step === 'move-row')).toHaveLength(2);
		// Each statement names the Slot that Contract is going TO, and the two
		// are different Slots — which is what makes it a swap.
		const updates = harness.statements.filter((statement) =>
			/^update team_rosters/i.test(statement.sql)
		);
		expect(updates.map((statement) => statement.params)).toEqual([
			['p-stash', 'active_bench'],
			['p-was-stashed', 'minor_league']
		]);
		// Both Contracts really changed Slot, and the occupancy is unchanged —
		// one left minors and one entered it.
		const payload = payloadOf(harness);
		for (const move of payload.moves) {
			expect(move.fromPlacement).not.toBe(move.toPlacement);
		}
		expect(payload.teamAfter.minorLeagueOccupied).toBe(payload.teamBefore.minorLeagueOccupied);
		expect(payload.teamAfter.rosterCount).toBe(payload.teamBefore.rosterCount);
		// ONE event for the whole act, however many Contracts moved.
		expect(harness.appendedEvents).toHaveLength(1);
		expect(harness.appendedEvents[0]?.['event_type']).toBe(ROSTER_REARRANGED_EVENT);
	});

	it('takes the lock before any read, and commits once', async () => {
		const harness = fakeGateway({ rosters: ROSTERS, teams: TEAMS });

		await recordRearrange(
			harness.gateway,
			MANAGER,
			{ teamId: 't-e', moves: DEMOTE, reason: null },
			'desktop'
		);

		expect(harness.order).toEqual([
			'begin',
			// AD-6: the lock is taken before any state is read.
			'lock',
			'read-log',
			'read-teams',
			'read-roster',
			'append-event',
			'move-row',
			'commit'
		]);
		expect(harness.state.committed).toBe(true);
		expect(harness.state.released).toBe(1);
		expect(harness.order.filter((step) => step === 'begin')).toHaveLength(1);
		expect(harness.order.filter((step) => step === 'commit')).toHaveLength(1);
	});

	it('writes NO outbox row — a Move is not broadcast', async () => {
		const harness = fakeGateway({ rosters: ROSTERS, teams: TEAMS });

		const outcome = await recordRearrange(
			harness.gateway,
			MANAGER,
			{ teamId: 't-e', moves: DEMOTE, reason: null },
			'desktop'
		);

		expect(outcome.kind).toBe('accepted');
		// The fake throws on any statement it does not recognise, and
		// `insert into notification_outbox` is not one of them.
		const sqls = harness.statements.map((statement) => statement.sql).join('\n');
		expect(sqls).not.toMatch(/notification_outbox/i);
		expect(sqls).not.toMatch(/delete from team_rosters/i);
		expect(sqls).not.toMatch(/insert into team_rosters/i);
	});

	it('issues NO UPDATE for an Auction Contract — the event alone moves it', async () => {
		// **A won Contract has no `team_rosters` row.** `contractsReducer`'s
		// `RosterRearranged` case re-places it when the event is appended, and
		// an `UPDATE` here would silently write nothing while looking like it
		// worked. Team E's only Contract below is one it WON, stashed at a
		// charged Cap Hit of $0 against a winning amount of $12,000,000 — the
		// AD-23 pair a Move must not collapse.
		const close: QueryResultRow = {
			seq: 5,
			occurred_at: new Date('2026-09-09T09:00:00.000Z'),
			schema_version: 1,
			core_version: CORE_VERSION,
			manager_id: 'm-e',
			team_id: 't-e',
			event_type: AUCTION_CLOSED_EVENT,
			payload: {
				fantraxPlayerId: 'p-won',
				playerName: 'Wembanyama',
				teamId: 't-e',
				teamName: 'Team E',
				managerId: 'm-e',
				winningAmount: 12_000_000,
				capHit: 0,
				placement: 'minor_league',
				closedAt: '2026-09-09T09:00:00.000Z'
			}
		};
		const harness = fakeGateway({ rosters: [], teams: TEAMS, events: [close] });

		const outcome = await recordRearrange(
			harness.gateway,
			MANAGER,
			{
				teamId: 't-e',
				moves: [{ fantraxPlayerId: 'p-won', toPlacement: 'active_bench' }],
				reason: null
			},
			'desktop'
		);

		expect(outcome.kind).toBe('accepted');
		expect(harness.order.filter((step) => step === 'move-row')).toHaveLength(0);

		const move = payloadOf(harness).moves[0];
		expect(move?.won).toBe(true);
		expect(move?.fromPlacement).toBe('minor_league');
		expect(move?.toPlacement).toBe('active_bench');
		// **The FULL value, recovered from the contracts fold.** The roster read
		// would have handed back the charged $0; carrying that into the act
		// would have demoted a $12,000,000 Contract for nothing.
		expect(move?.value).toBe(12_000_000);
		expect(move?.capHitBefore).toBe(0);
		expect(move?.capHitAfter).toBe(12_000_000);
	});
});

describe('recordRearrange — the payload is the whole delta', () => {
	it('carries every Contract, both placements, both Cap Hits and the value', async () => {
		const harness = fakeGateway({ rosters: ROSTERS, teams: TEAMS });
		await recordRearrange(
			harness.gateway,
			MANAGER,
			{ teamId: 't-e', moves: DEMOTE, reason: null },
			'desktop'
		);
		const payload = payloadOf(harness);

		expect(payload.teamId).toBe('t-e');
		expect(payload.teamName).toBe('Team E');
		expect(payload.moves).toHaveLength(1);
		const move = payload.moves[0];
		expect(move?.fantraxPlayerId).toBe('p-stash');
		expect(move?.playerName).toBe('Stashed One');
		expect(move?.fromPlacement).toBe('minor_league');
		expect(move?.toPlacement).toBe('active_bench');
		expect(move?.capHitBefore).toBe(0);
		expect(move?.capHitAfter).toBe(3_000_000);
		expect(move?.value).toBe(3_000_000);
		expect(move?.won).toBe(false);
	});

	it('names the figure blocks `teamBefore`/`teamAfter`, never `before`/`after`', async () => {
		// The Audit Log's `mergeOverride` reads a top-level `before`/`after`
		// pair as an `OverrideRecord`'s own state map and prints the Team
		// figures a second time, raw — machine tokens and all.
		const harness = fakeGateway({ rosters: ROSTERS, teams: TEAMS });
		await recordRearrange(
			harness.gateway,
			MANAGER,
			{ teamId: 't-e', moves: DEMOTE, reason: null },
			'desktop'
		);
		const payload = payloadOf(harness) as unknown as Record<string, unknown>;

		expect(payload['before']).toBeUndefined();
		expect(payload['after']).toBeUndefined();
		expect(payload['teamBefore']).toBeDefined();
		expect(payload['teamAfter']).toBeDefined();
		// Roster Count rose by one and minors occupancy fell by one.
		const before = payload['teamBefore'] as { rosterCount: number; minorLeagueOccupied: number };
		const after = payload['teamAfter'] as { rosterCount: number; minorLeagueOccupied: number };
		expect(after.rosterCount).toBe(before.rosterCount + 1);
		expect(after.minorLeagueOccupied).toBe(before.minorLeagueOccupied - 1);
	});

	it('records `null` for a Manager’s own Move and the text for the Commissioner’s', async () => {
		const own = fakeGateway({ rosters: ROSTERS, teams: TEAMS });
		await recordRearrange(
			own.gateway,
			MANAGER,
			{ teamId: 't-e', moves: DEMOTE, reason: null },
			'desktop'
		);
		expect(payloadOf(own).reason).toBeNull();
		// The actor rides the envelope, and it is the Manager.
		expect(own.appendedEvents[0]?.['manager_id']).toBe('m-e');

		const behalf = fakeGateway({ rosters: ROSTERS, teams: TEAMS });
		await recordRearrange(
			behalf.gateway,
			COMMISSIONER,
			{ teamId: 't-e', moves: DEMOTE, reason: REASON },
			'desktop'
		);
		expect(payloadOf(behalf).reason).toBe(REASON);
		expect(behalf.appendedEvents[0]?.['manager_id']).toBe('m-commissioner');
	});
});

describe('rearrangingTeamFor — a won row with no folded Contract fails LOUDLY', () => {
	it('throws rather than valuing an Auction Contract at its charged $0', async () => {
		// **Unreachable through the public path, which is exactly why it needs
		// its own test.** `loadTeamRosterDetail` builds its won rows from the
		// same `contractsWonBy` call this join reads, so the two cannot
		// disagree — and deleting the guard would therefore leave every
		// end-to-end test in this file green.
		//
		// What the guard prevents: `row.capHit` on a won row is the CHARGED
		// figure, which is $0 for a minors placement. A silent fallback would
		// value an $18,000,000 stash at nothing, demote it for free and charge
		// the Team nothing for it — precisely the AD-23 distinction this story
		// exists to preserve. It must fail loudly, and the throw aborts the
		// transaction so nothing is written.
		expect(() =>
			rearrangingTeamFor(
				't-e',
				'Team E',
				{
					capSpace: parseMoney(0),
					rosterCount: 0,
					minorLeagueOccupied: 1,
					rows: [
						{
							fantraxPlayerId: 'p-ghost',
							playerName: 'Ghost',
							capHit: parseMoney(0),
							rosterSlotKind: 'minor_league',
							won: true,
							contractYearsRemaining: null,
							rookieScaleRound: null
						}
					]
				},
				INITIAL_CONTRACTS
			)
		).toThrow(/p-ghost .* no Auction Contract folded/);
	});

	it('does NOT throw for an ordinary imported row, won or not', () => {
		const team = rearrangingTeamFor(
			't-e',
			'Team E',
			{
				capSpace: parseMoney(0),
				rosterCount: 1,
				minorLeagueOccupied: 0,
				rows: [
					{
						fantraxPlayerId: 'p-imported',
						playerName: 'Imported',
						capHit: parseMoney(5_000_000),
						rosterSlotKind: 'active_bench',
						won: false,
						contractYearsRemaining: 3,
						rookieScaleRound: null
					}
				]
			},
			INITIAL_CONTRACTS
		);

		// An imported row's own `cap_hit` is stored in FULL whatever Slot it
		// sits in, so it is the honest value with no contract to join to.
		expect(team.rows[0]?.value).toBe(5_000_000);
		expect(team.rows[0]?.won).toBe(false);
	});
});

describe('recordRearrange — a refusal writes nothing at all', () => {
	it('rolls back with no event and no row on a shape refusal', async () => {
		const harness = fakeGateway({ rosters: ROSTERS, teams: TEAMS });

		const outcome = await recordRearrange(
			harness.gateway,
			MANAGER,
			{
				teamId: 't-e',
				moves: [{ fantraxPlayerId: 'p-active', toPlacement: 'minor_league' }],
				reason: null
			},
			'desktop'
		);

		expect(outcome.kind).toBe('rejected');
		const rejection = outcome.kind === 'rejected' ? (outcome.reason as RosterRearrangeRejection) : null;
		// `p-active` has no pool row and has never been observed in minors.
		expect(rejection?.refusal.kind).toBe('never_observed_eligible');
		expect(rejection?.gates).toBeNull();
		expect(rejection?.detail).toContain('never been told');

		expect(harness.appendedEvents).toEqual([]);
		expect(harness.order).toContain('rollback');
		expect(harness.order).not.toContain('commit');
		expect(harness.order.filter((step) => step === 'move-row')).toHaveLength(0);
	});

	it('rolls back with no event and no row on a gate refusal', async () => {
		// A Team with no Cap Space left and a stash worth more than it has:
		// demoting the stash makes it charge, and the money gate refuses. The
		// Contract is sitting in a Minor League Slot right now, so it clears
		// every shape check and the refusal really is the gates'.
		const broke: readonly RosterRow[] = [
			{
				teamId: 't-e',
				fantraxPlayerId: 'p-whole-cap',
				playerName: 'Whole Cap',
				capHit: 165_000_000,
				rosterSlotKind: 'active_bench'
			},
			{
				teamId: 't-e',
				fantraxPlayerId: 'p-stash',
				playerName: 'Stashed One',
				capHit: 5_000_000,
				rosterSlotKind: 'minor_league'
			}
		];
		const harness = fakeGateway({ rosters: broke, teams: TEAMS });

		const outcome = await recordRearrange(
			harness.gateway,
			MANAGER,
			{ teamId: 't-e', moves: DEMOTE, reason: null },
			'desktop'
		);

		expect(outcome.kind).toBe('rejected');
		const rejection =
			outcome.kind === 'rejected' ? (outcome.reason as RosterRearrangeRejection) : null;
		expect(rejection?.refusal.kind).toBe('gates');
		// A gate refusal DOES carry its arithmetic — the figures it was judged
		// against — which is the difference from a shape refusal.
		expect(rejection?.gates).not.toBeNull();
		expect(rejection?.gates?.cap.passed).toBe(false);
		expect(rejection?.gates?.cap.shortfall).not.toBeNull();

		// Nothing was written: no event, no row, and the transaction rolled back.
		expect(harness.appendedEvents).toEqual([]);
		expect(harness.order).toContain('rollback');
		expect(harness.order).not.toContain('commit');
		expect(harness.order.filter((step) => step === 'move-row')).toHaveLength(0);
	});
});
