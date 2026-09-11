/**
 * `recordRosterMove` — the one transaction, the `UPDATE`, and the silence
 * (Story 7.7, FR-41).
 *
 * Three claims this file exists to hold, none of which is visible from the
 * pure core:
 *
 *  1. **An Existing Contract moves by an `UPDATE` of `team_id` and
 *     `roster_slot_kind`, never by a delete and an insert.**
 *     `team_rosters.fantrax_player_id` is unique across every Team (AR-41), so
 *     a delete/insert pair is a window in which the Player is on no roster at
 *     all — and a failure between them leaves him there permanently.
 *  2. **One transaction, under the global lock.** Lock before any read (AD-6),
 *     event and rows inside the same `begin`…`commit`, and a refusal rolls
 *     back with nothing written — FR-41's "a Move that moved three Players of
 *     five is never a reachable state".
 *  3. **Nothing on the outbox.** A Roster Move is the one Commissioner act
 *     that is not broadcast, and `recordRosterMove` passes no `enqueue` at
 *     all — so the claim is structural rather than a setting.
 *
 * The stateful fake `ConnectionGateway` is `tests/server/auction-open.test.ts`'s:
 * it records every statement in order, keeps the appended events in memory and
 * discards them on a `rollback`, so "nothing was written" is observable rather
 * than assumed. It THROWS on any statement it does not recognise, which is what
 * makes "no `delete`, no `insert into team_rosters`, no outbox row" a failure
 * rather than a silence.
 */

import { describe, expect, it } from 'vitest';

import { CORE_VERSION } from '../../src/lib/core/constants.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { ROSTER_MOVE_RECORDED_EVENT } from '../../src/lib/core/projection/contracts.ts';
import type { RosterMoveRecordedPayload } from '../../src/lib/core/projection/contracts.ts';
import { MOVE_ROSTER_ROW_SQL, recordRosterMove } from '../../src/lib/server/roster-move.ts';
import type { RosterMoveRejection } from '../../src/lib/server/roster-move.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

const NOW = new Date('2026-09-10T19:00:00.000Z');

const ACTOR = { managerId: 'm-commissioner', teamId: 't-j', displayName: 'The Commissioner' };

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
	let seq = 100;
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
			if (/from team_rosters/i.test(sql)) {
				order.push('read-roster');
				const teamId = String(params[0]);
				return {
					rows: (options.rosters ?? [])
						.filter((row) => row.teamId === teamId)
						.map((row) => ({
							fantrax_player_id: row.fantraxPlayerId,
							player_name: row.playerName,
							cap_hit: row.capHit,
							roster_slot_kind: row.rosterSlotKind
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
			// `insert into team_rosters`, an `insert into notification_outbox` —
			// fails the test by name rather than passing silently.
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

const TEAMS = [
	{ id: 't-j', name: 'Team J' },
	{ id: 't-k', name: 'Team K' }
];

/** Team J holds two Players; Team K holds one. Nothing is contested. */
const ROSTERS: readonly RosterRow[] = [
	{
		teamId: 't-j',
		fantraxPlayerId: 'p-1',
		playerName: 'Powell',
		capHit: 9_000_000,
		rosterSlotKind: 'active_bench'
	},
	{
		teamId: 't-j',
		fantraxPlayerId: 'p-2',
		playerName: 'Ellis',
		capHit: 3_000_000,
		rosterSlotKind: 'minor_league'
	},
	{
		teamId: 't-k',
		fantraxPlayerId: 'p-3',
		playerName: 'Sharpe',
		capHit: 4_000_000,
		rosterSlotKind: 'active_bench'
	}
];

const INPUT = {
	sendingTeamId: 't-j',
	receivingTeamId: 't-k',
	sendingPlayerIds: ['p-1'],
	receivingPlayerIds: ['p-3'],
	reason: 'Agreed in the league channel on the 10th.'
};

describe('recordRosterMove — one transaction, one UPDATE per row, and no outbox', () => {
	it('moves an Existing Contract by UPDATE, never by delete-then-insert', async () => {
		const harness = fakeGateway({ rosters: ROSTERS, teams: TEAMS });

		const outcome = await recordRosterMove(harness.gateway, ACTOR, INPUT, 'desktop');

		expect(outcome.kind).toBe('accepted');
		const moves = harness.statements.filter((statement) =>
			/^update team_rosters/i.test(statement.sql)
		);
		expect(moves).toHaveLength(2);
		// The statement itself, verbatim — one `UPDATE`, keyed on the Player,
		// setting the Team and the Slot and nothing else.
		expect(moves[0]?.sql).toBe(MOVE_ROSTER_ROW_SQL);
		expect(moves[0]?.sql).toMatch(
			/^update team_rosters set team_id = \$2, roster_slot_kind = \$3 where fantrax_player_id = \$1$/
		);

		// Sorted by `fantraxPlayerId` (AD-5), so a replay lands them identically.
		expect(moves.map((statement) => statement.params)).toEqual([
			['p-1', 't-k', 'active_bench'],
			['p-3', 't-j', 'active_bench']
		]);

		// And the two statements that must never appear.
		const sqls = harness.statements.map((statement) => statement.sql).join('\n');
		expect(sqls).not.toMatch(/delete from team_rosters/i);
		expect(sqls).not.toMatch(/insert into team_rosters/i);
	});

	it('runs ONE transaction: lock before any read, rows inside, then commit', async () => {
		const harness = fakeGateway({ rosters: ROSTERS, teams: TEAMS });

		await recordRosterMove(harness.gateway, ACTOR, INPUT, 'desktop');

		expect(harness.order).toEqual([
			'begin',
			// AD-6: the lock is taken before any state is read.
			'lock',
			'read-log',
			'read-teams',
			'read-roster',
			'read-roster',
			'append-event',
			'move-row',
			'move-row',
			'commit'
		]);
		expect(harness.state.committed).toBe(true);
		expect(harness.state.released).toBe(1);
		// Exactly one `begin` and one `commit`: a Move is never two transactions.
		expect(harness.order.filter((step) => step === 'begin')).toHaveLength(1);
		expect(harness.order.filter((step) => step === 'commit')).toHaveLength(1);
	});

	it('writes NO outbox row — a Roster Move is not broadcast', async () => {
		const harness = fakeGateway({ rosters: ROSTERS, teams: TEAMS });

		const outcome = await recordRosterMove(harness.gateway, ACTOR, INPUT, 'desktop');

		expect(outcome.kind).toBe('accepted');
		// The fake throws on any statement it does not recognise, and
		// `insert into notification_outbox` is not one of them — so reaching an
		// accepted outcome at all is the proof. Asserted explicitly too, because
		// the claim is the point of the test.
		const sqls = harness.statements.map((statement) => statement.sql).join('\n');
		expect(sqls).not.toMatch(/notification_outbox/i);
	});

	it('appends ONE event carrying the whole delta — both Teams, before and after', async () => {
		const harness = fakeGateway({ rosters: ROSTERS, teams: TEAMS });

		await recordRosterMove(harness.gateway, ACTOR, INPUT, 'desktop');

		expect(harness.appendedEvents).toHaveLength(1);
		const appended = harness.appendedEvents[0];
		expect(appended?.['event_type']).toBe(ROSTER_MOVE_RECORDED_EVENT);
		expect(appended?.['core_version']).toBe(CORE_VERSION);
		// The actor rides the envelope, never the payload's own field.
		expect(appended?.['manager_id']).toBe('m-commissioner');
		expect(appended?.['device_class']).toBe('desktop');

		const payload = appended?.['payload'] as RosterMoveRecordedPayload;
		expect(payload.sendingTeamName).toBe('Team J');
		expect(payload.receivingTeamName).toBe('Team K');
		expect(payload.reason).toBe(INPUT.reason);
		expect(payload.transfers.map((transfer) => transfer.fantraxPlayerId)).toEqual([
			'p-1',
			'p-3'
		]);
		// FR-41's record: Cap Space, Roster Count and all three occupancies, for
		// both Teams, before and after — one entry, not two.
		expect(payload.sendingBefore.rosterCount).toBe(1);
		expect(payload.sendingAfter.rosterCount).toBe(1);
		expect(payload.receivingBefore.rosterCount).toBe(1);
		expect(payload.receivingAfter.rosterCount).toBe(1);
		expect(payload.sendingBefore.minorLeagueOccupied).toBe(1);
	});

	it('writes NOTHING when a gate refuses — no event, no UPDATE, no commit', async () => {
		// Team K at the ceiling: twelve Active/Bench Players already, receiving
		// one more and sending nothing.
		const full: RosterRow[] = [
			...ROSTERS.filter((row) => row.teamId === 't-j'),
			...Array.from({ length: 12 }, (_unused, index) => ({
				teamId: 't-k',
				fantraxPlayerId: `p-k-${String(index)}`,
				playerName: `K ${String(index)}`,
				capHit: 1_000_000,
				rosterSlotKind: 'active_bench'
			}))
		];
		const harness = fakeGateway({ rosters: full, teams: TEAMS });

		const outcome = await recordRosterMove(
			harness.gateway,
			ACTOR,
			{ ...INPUT, receivingPlayerIds: [] },
			'desktop'
		);

		expect(outcome.kind).toBe('rejected');
		if (outcome.kind !== 'rejected') return;
		const rejection = outcome.reason as RosterMoveRejection;
		expect(rejection.refusal.kind).toBe('gates');
		expect(rejection.gates?.receivingSlots.passed).toBe(false);
		// The Team, the gate and the arithmetic, in the sentence the core wrote.
		expect(rejection.detail).toContain('Team K');
		expect(rejection.detail).toContain('Active/Bench');

		// And the transaction wrote nothing at all.
		expect(harness.appendedEvents).toEqual([]);
		expect(harness.order).toContain('rollback');
		expect(harness.order).not.toContain('append-event');
		expect(harness.order).not.toContain('move-row');
		expect(harness.state.committed).toBe(false);
		expect(harness.state.released).toBe(1);
	});

	it('issues NO UPDATE for an Auction Contract — the event alone moves it', async () => {
		// Team J's only Contract is one it WON, which has no `team_rosters` row.
		const close: QueryResultRow = {
			seq: 5,
			occurred_at: new Date('2026-09-09T09:00:00.000Z'),
			schema_version: 1,
			core_version: CORE_VERSION,
			manager_id: 'm-j',
			team_id: 't-j',
			event_type: AUCTION_CLOSED_EVENT,
			payload: {
				fantraxPlayerId: 'p-won',
				playerName: 'Wembanyama',
				teamId: 't-j',
				teamName: 'Team J',
				managerId: 'm-j',
				winningAmount: 12_000_000,
				capHit: 12_000_000,
				placement: 'active_bench',
				closedAt: '2026-09-09T09:00:00.000Z'
			}
		};
		const harness = fakeGateway({ rosters: [], teams: TEAMS, events: [close] });

		const outcome = await recordRosterMove(
			harness.gateway,
			ACTOR,
			{ ...INPUT, sendingPlayerIds: ['p-won'], receivingPlayerIds: [] },
			'desktop'
		);

		expect(outcome.kind).toBe('accepted');
		expect(harness.order.filter((step) => step === 'move-row')).toHaveLength(0);

		const payload = harness.appendedEvents[0]?.['payload'] as RosterMoveRecordedPayload;
		expect(payload.transfers[0]?.won).toBe(true);
		expect(payload.transfers[0]?.toTeamId).toBe('t-k');
	});
});
