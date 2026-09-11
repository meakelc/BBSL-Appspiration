/**
 * `recordDrop` — the one transaction, the two statements, and the silence
 * (Story 7.8, FR-43).
 *
 * Four claims this file exists to hold, none of which is visible from the
 * pure core:
 *
 *  1. **A release that carries Dead Money is an `UPDATE` of
 *     `roster_slot_kind` alone** — `cap_hit` is untouched, because the row
 *     keeps charging exactly what it charged.
 *  2. **A release that carries nothing is a `DELETE`** — removing the row IS
 *     the release of its Cap Hit back to Cap Space.
 *  3. **One transaction, under the global lock.** Lock before any read
 *     (AD-6), event and rows inside the same `begin`…`commit`, and a refusal
 *     rolls back with nothing written — a Drop that released two Players of
 *     three is never a reachable state.
 *  4. **Nothing on the outbox.** A Drop is not broadcast, and `recordDrop`
 *     passes no `enqueue` at all — so the claim is structural rather than a
 *     setting.
 *
 * The stateful fake `ConnectionGateway` is `tests/server/roster-move.test.ts`'s:
 * it records every statement in order, keeps the appended events in memory and
 * discards them on a `rollback`, so "nothing was written" is observable rather
 * than assumed. It THROWS on any statement it does not recognise, which is what
 * makes "no `insert into team_rosters`, no outbox row" a failure rather than a
 * silence.
 */

import { describe, expect, it } from 'vitest';

import { CORE_VERSION } from '../../src/lib/core/constants.ts';
import { DROP_RECORDED_EVENT } from '../../src/lib/core/projection/contracts.ts';
import type { DropRecordedPayload } from '../../src/lib/core/projection/contracts.ts';
import {
	DROP_ROSTER_ROW_SQL,
	REMOVE_ROSTER_ROW_SQL,
	recordDrop
} from '../../src/lib/server/roster-drop.ts';
import type { RosterDropRejection } from '../../src/lib/server/roster-drop.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

const NOW = new Date('2026-09-11T19:00:00.000Z');

const ACTOR = { managerId: 'm-commissioner', teamId: 't-h', displayName: 'The Commissioner' };

type RosterRow = {
	readonly teamId: string;
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly capHit: number;
	readonly rosterSlotKind: string;
	readonly contractYearsRemaining?: number | null;
	readonly rookieScaleRound?: number | null;
};

function fakeGateway(options: {
	rosters?: readonly RosterRow[];
	events?: readonly QueryResultRow[];
	teams?: ReadonlyArray<{ id: string; name: string }>;
}) {
	const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
	const order: string[] = [];
	const appendedEvents: QueryResultRow[] = [];
	let seq = 200;
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
			// **`^select` first, and it is load-bearing.** A bare
			// `/from team_rosters/` would also match this Drop's own
			// `delete from team_rosters`, answer it as a roster read and never
			// reach the branch that records the removal.
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
							contract_years_remaining: row.contractYearsRemaining ?? 3,
							rookie_scale_round: row.rookieScaleRound ?? null
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
				order.push('carry-row');
				return { rows: [] };
			}
			if (/^delete from team_rosters/i.test(sql)) {
				order.push('remove-row');
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
			// Anything else — an `insert into team_rosters`, an
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

const TEAMS = [{ id: 't-h', name: 'Team H' }];

/**
 * Team H holds four Contracts: an ordinary Active/Bench deal, a full-term
 * second-round rookie deal, a stash and one it keeps.
 */
const ROSTERS: readonly RosterRow[] = [
	{
		teamId: 't-h',
		fantraxPlayerId: 'p-plain',
		playerName: 'Plain Deal',
		capHit: 2_000_000,
		rosterSlotKind: 'active_bench',
		contractYearsRemaining: 5,
		rookieScaleRound: null
	},
	{
		teamId: 't-h',
		fantraxPlayerId: 'p-rookie',
		playerName: 'Rookie Deal',
		capHit: 2_000_000,
		rosterSlotKind: 'active_bench',
		contractYearsRemaining: 5,
		rookieScaleRound: 2
	},
	{
		teamId: 't-h',
		fantraxPlayerId: 'p-stash',
		playerName: 'Stashed',
		capHit: 3_000_000,
		rosterSlotKind: 'minor_league',
		contractYearsRemaining: 2,
		rookieScaleRound: null
	},
	{
		teamId: 't-h',
		fantraxPlayerId: 'p-kept',
		playerName: 'Kept',
		capHit: 5_000_000,
		rosterSlotKind: 'active_bench',
		contractYearsRemaining: 4,
		rookieScaleRound: null
	}
];

const REASON = 'Released in Fantrax on the 11th.';

describe('recordDrop — one transaction, one statement per release, and no outbox', () => {
	it('UPDATEs the row that carries Dead Money, and touches no other column', async () => {
		const harness = fakeGateway({ rosters: ROSTERS, teams: TEAMS });

		const outcome = await recordDrop(
			harness.gateway,
			ACTOR,
			{ teamId: 't-h', fantraxPlayerIds: ['p-plain'], reason: REASON },
			'desktop'
		);

		expect(outcome.kind).toBe('accepted');
		const updates = harness.statements.filter((statement) =>
			/^update team_rosters/i.test(statement.sql)
		);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.sql).toBe(DROP_ROSTER_ROW_SQL);
		// `cap_hit` is deliberately not in the statement: the row keeps charging
		// what it charged, which is what makes Cap Space stand still.
		expect(updates[0]?.sql).toMatch(
			/^update team_rosters set roster_slot_kind = 'dead_money' where fantrax_player_id = \$1$/
		);
		expect(updates[0]?.params).toEqual(['p-plain']);

		const sqls = harness.statements.map((statement) => statement.sql).join('\n');
		expect(sqls).not.toMatch(/delete from team_rosters/i);
		expect(sqls).not.toMatch(/insert into team_rosters/i);
	});

	it('DELETEs the row that carries nothing — a full-term second-round rookie deal', async () => {
		const harness = fakeGateway({ rosters: ROSTERS, teams: TEAMS });

		const outcome = await recordDrop(
			harness.gateway,
			ACTOR,
			{ teamId: 't-h', fantraxPlayerIds: ['p-rookie'], reason: REASON },
			'desktop'
		);

		expect(outcome.kind).toBe('accepted');
		const deletes = harness.statements.filter((statement) =>
			/^delete from team_rosters/i.test(statement.sql)
		);
		expect(deletes).toHaveLength(1);
		expect(deletes[0]?.sql).toBe(REMOVE_ROSTER_ROW_SQL);
		expect(deletes[0]?.params).toEqual(['p-rookie']);
		// Nothing was reclassified: the exception removes rather than converts.
		expect(harness.statements.map((s) => s.sql).join('\n')).not.toMatch(/^update team_rosters/im);
	});

	it('DELETEs a Minor League release too, by the SAME rule — it was charging $0', async () => {
		const harness = fakeGateway({ rosters: ROSTERS, teams: TEAMS });

		await recordDrop(
			harness.gateway,
			ACTOR,
			{ teamId: 't-h', fantraxPlayerIds: ['p-stash'], reason: REASON },
			'desktop'
		);

		expect(harness.order.filter((step) => step === 'remove-row')).toHaveLength(1);
		expect(harness.order.filter((step) => step === 'carry-row')).toHaveLength(0);
	});

	it('issues both statements in ONE transaction: lock before any read, then commit', async () => {
		const harness = fakeGateway({ rosters: ROSTERS, teams: TEAMS });

		await recordDrop(
			harness.gateway,
			ACTOR,
			{ teamId: 't-h', fantraxPlayerIds: ['p-plain', 'p-rookie'], reason: REASON },
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
			'carry-row',
			'remove-row',
			'commit'
		]);
		expect(harness.state.committed).toBe(true);
		expect(harness.state.released).toBe(1);
		// Exactly one `begin` and one `commit`: a Drop is never two transactions.
		expect(harness.order.filter((step) => step === 'begin')).toHaveLength(1);
		expect(harness.order.filter((step) => step === 'commit')).toHaveLength(1);
	});

	it('writes NO outbox row — a Drop is not broadcast', async () => {
		const harness = fakeGateway({ rosters: ROSTERS, teams: TEAMS });

		const outcome = await recordDrop(
			harness.gateway,
			ACTOR,
			{ teamId: 't-h', fantraxPlayerIds: ['p-plain'], reason: REASON },
			'desktop'
		);

		expect(outcome.kind).toBe('accepted');
		// The fake throws on any statement it does not recognise, and
		// `insert into notification_outbox` is not one of them — so reaching an
		// accepted outcome at all is the proof. Asserted explicitly too, because
		// the claim is the point of the test.
		const sqls = harness.statements.map((statement) => statement.sql).join('\n');
		expect(sqls).not.toMatch(/notification_outbox/i);
	});

	it('appends ONE event carrying the whole delta — every Player, before and after', async () => {
		const harness = fakeGateway({ rosters: ROSTERS, teams: TEAMS });

		await recordDrop(
			harness.gateway,
			ACTOR,
			{ teamId: 't-h', fantraxPlayerIds: ['p-plain', 'p-rookie'], reason: REASON },
			'desktop'
		);

		expect(harness.appendedEvents).toHaveLength(1);
		const appended = harness.appendedEvents[0];
		expect(appended?.['event_type']).toBe(DROP_RECORDED_EVENT);
		expect(appended?.['core_version']).toBe(CORE_VERSION);
		// The actor rides the envelope, never the payload's own field.
		expect(appended?.['manager_id']).toBe('m-commissioner');
		expect(appended?.['device_class']).toBe('desktop');

		const payload = appended?.['payload'] as DropRecordedPayload;
		expect(payload.teamName).toBe('Team H');
		expect(payload.reason).toBe(REASON);
		expect(payload.released.map((release) => release.fantraxPlayerId)).toEqual([
			'p-plain',
			'p-rookie'
		]);
		// Each carried amount, and the fate that followed from it.
		expect(payload.released[0]?.deadMoney).toBe(2_000_000);
		expect(payload.released[0]?.removed).toBe(false);
		expect(payload.released[1]?.deadMoney).toBe(0);
		expect(payload.released[1]?.removed).toBe(true);
		// Roster Count falls by two; Cap Space rises by only the rookie's.
		expect(payload.teamBefore.rosterCount - payload.teamAfter.rosterCount).toBe(2);
		expect(payload.teamAfter.capSpace - payload.teamBefore.capSpace).toBe(2_000_000);
	});

	it('writes NOTHING when a gate refuses — no event, no row, no commit', async () => {
		// Team H leads an Auction it can barely cover; freeing a Slot costs
		// $1,000,000 of reserve and pushes it under.
		const events: QueryResultRow[] = [];
		const harness = fakeGateway({
			// One Contract, and it eats the whole Cap — so the Team has no room
			// for the reserve on the Slot the Drop would free.
			rosters: [
				{
					teamId: 't-h',
					fantraxPlayerId: 'p-plain',
					playerName: 'Plain Deal',
					capHit: 2_000_000,
					rosterSlotKind: 'active_bench'
				},
				...Array.from({ length: 13 }, (_unused, index) => ({
					teamId: 't-h',
					fantraxPlayerId: `p-x-${String(index)}`,
					playerName: `X ${String(index)}`,
					capHit: 1_000_000,
					rosterSlotKind: 'active_bench'
				}))
			],
			teams: TEAMS,
			events
		});

		const outcome = await recordDrop(
			harness.gateway,
			ACTOR,
			{ teamId: 't-h', fantraxPlayerIds: ['p-plain'], reason: REASON },
			'desktop'
		);

		expect(outcome.kind).toBe('rejected');
		if (outcome.kind !== 'rejected') return;
		const rejection = outcome.reason as RosterDropRejection;
		expect(rejection.refusal.kind).toBe('gates');
		expect(rejection.gates?.slots.passed).toBe(false);
		// The Team, the gate and the arithmetic, in the sentence the core wrote.
		expect(rejection.detail).toContain('Team H');
		expect(rejection.detail).toContain('Active/Bench');

		// And nothing at all was written.
		expect(harness.appendedEvents).toHaveLength(0);
		expect(harness.state.committed).toBe(false);
		expect(harness.order).toContain('rollback');
		expect(harness.order).not.toContain('carry-row');
		expect(harness.order).not.toContain('remove-row');
	});
});
