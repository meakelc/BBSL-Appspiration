/**
 * `recordCloseReversal` — the one transaction (Story 7.13, FR-32, AD-33).
 *
 * Claims only a transaction can show:
 *
 *  1. **Exactly one `AuctionCloseReversed` is appended, and nothing in
 *     `auction_events` is updated or deleted** (AD-4). The fake throws on any
 *     statement it does not recognise, so an `update auction_events` or a
 *     `delete from auction_events` is a failure by name.
 *  2. **One claim-row insert when the record re-holds a Slot**, carrying the
 *     re-held nomination's own `seq` and instant — and none when it does not.
 *  3. **A refusal rolls back with nothing written**: no event, no claim row,
 *     no outbox row.
 *  4. **It is broadcast and the winning Team is mentioned** — one channel row
 *     and one row per Manager of that Team, inside the transaction.
 *
 * The stateful fake is `tests/server/roster-drop.test.ts`'s pattern: it
 * records every statement in order, keeps appended rows in memory and
 * discards them on `rollback`.
 */

import { describe, expect, it } from 'vitest';

import { AUCTION_CLOSE_REVERSED_EVENT } from '../../src/lib/core/projection/contracts.ts';
import type { AuctionCloseReversedPayload } from '../../src/lib/core/projection/contracts.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';
import {
	affectedTeamsForReversal,
	previewCloseReversal,
	recordCloseReversal
} from '../../src/lib/server/close-reversal.ts';
import type { CloseReversalRejection } from '../../src/lib/server/close-reversal.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';
import {
	CLOSE_SEQ,
	PLAYER_Z,
	TEAM_R,
	baseLog,
	importedRowsR,
	nominated
} from '../fixtures/close-reversal-log.ts';

const NOW = new Date('2026-09-23T19:00:00.000Z');
const ACTOR = { managerId: 'm-c', teamId: 't-t', displayName: 'The Commissioner' };
const REASON = 'Team R held an Injury Reserve Contract against the free-agency rule.';

/** One appended event as the `auction_events` row the loader reads. */
function rowOf(event: AppendedEvent): QueryResultRow {
	return {
		seq: Number(event.seq),
		occurred_at: event.occurredAt,
		schema_version: event.schemaVersion,
		core_version: event.coreVersion,
		manager_id: event.managerId,
		team_id: event.teamId,
		event_type: event.type,
		payload: event.payload,
		device_class: null,
		dispatch_outcome: null,
		delivery_outcome: null
	};
}

function fakeGateway(events: readonly AppendedEvent[]) {
	const order: string[] = [];
	const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
	const appended: QueryResultRow[] = [];
	const claims: Array<readonly unknown[]> = [];
	const intents: Array<readonly unknown[]> = [];
	let seq = 100;

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
				return { rows: events.map(rowOf) };
			}
			if (/^select[\s\S]*from team_rosters/i.test(sql)) {
				order.push('read-roster');
				if (String(params[0]) !== TEAM_R) return { rows: [] };
				return {
					rows: importedRowsR().map((row) => ({
						fantrax_player_id: row.fantraxPlayerId,
						player_name: row.playerName,
						cap_hit: row.value,
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
				appended.push(row);
				return { rows: [row] };
			}
			if (/^insert into nomination_slots/i.test(sql)) {
				order.push('rehold-slot');
				claims.push(params);
				return { rows: [] };
			}
			if (/^select coalesce\(discord_mention_user_id/i.test(sql)) {
				order.push('read-managers');
				return String(params[0]) === TEAM_R
					? { rows: [{ discord_user_id: 'snowflake-r1' }, { discord_user_id: 'snowflake-r2' }] }
					: { rows: [] };
			}
			if (/^insert into notification_outbox/i.test(sql)) {
				order.push('enqueue');
				intents.push(params);
				return { rows: [] };
			}
			if (/^commit/i.test(sql)) {
				order.push('commit');
				return { rows: [] };
			}
			if (/^rollback/i.test(sql)) {
				order.push('rollback');
				appended.length = 0;
				claims.length = 0;
				intents.length = 0;
				return { rows: [] };
			}
			// An `update auction_events`, a `delete from auction_events`, a
			// `delete from nomination_slots` — anything else fails by name.
			throw new Error(`unexpected statement: ${sql}`);
		},
		release() {}
	};

	return {
		gateway: { connect: async () => client } satisfies ConnectionGateway,
		order,
		statements,
		appended,
		claims,
		intents
	};
}

describe('recordCloseReversal — one event, one claim row, and the notice', () => {
	it('appends exactly one AuctionCloseReversed and touches no other event', async () => {
		const fake = fakeGateway(baseLog());
		const outcome = await recordCloseReversal(
			fake.gateway,
			ACTOR,
			{ closeSeq: CLOSE_SEQ, reason: REASON },
			'desktop'
		);
		expect(outcome.kind).toBe('accepted');
		expect(fake.appended).toHaveLength(1);
		expect(fake.appended[0]?.['event_type']).toBe(AUCTION_CLOSE_REVERSED_EVENT);
		expect(fake.appended[0]?.['manager_id']).toBe(ACTOR.managerId);
		const payload = fake.appended[0]?.['payload'] as AuctionCloseReversedPayload;
		expect(payload.closeSeq).toBe(CLOSE_SEQ);
		expect(payload.reason).toBe(REASON);
		// AD-4: nothing in the log is updated or deleted.
		expect(
			fake.statements.filter((statement) =>
				/^(update|delete from)\s+auction_events/i.test(statement.sql)
			)
		).toEqual([]);
	});

	it('re-inserts one claim row with the re-held nomination’s own seq, in order', async () => {
		const fake = fakeGateway(baseLog());
		await recordCloseReversal(fake.gateway, ACTOR, { closeSeq: CLOSE_SEQ, reason: REASON }, 'desktop');
		expect(fake.claims).toHaveLength(1);
		const nomination = baseLog().find((event) => event.seq === '2');
		expect(fake.claims[0]).toEqual([TEAM_R, 'p-x', '2', nomination?.occurredAt]);
		expect(fake.order).toEqual([
			'begin',
			'lock',
			'read-log',
			'read-roster',
			'append-event',
			'rehold-slot',
			'enqueue',
			'read-managers',
			'enqueue',
			'enqueue',
			'commit'
		]);
	});

	it('writes no claim row when Team R has nominated since', async () => {
		const fake = fakeGateway([...baseLog(), nominated(9, PLAYER_Z, 'Player Z', TEAM_R)]);
		const outcome = await recordCloseReversal(
			fake.gateway,
			ACTOR,
			{ closeSeq: CLOSE_SEQ, reason: REASON },
			'desktop'
		);
		expect(outcome.kind).toBe('accepted');
		expect(fake.claims).toEqual([]);
		expect((fake.appended[0]?.['payload'] as AuctionCloseReversedPayload).slotReheld).toBe(false);
	});

	it('broadcasts once and mentions each Manager of the winning Team', async () => {
		const fake = fakeGateway(baseLog());
		await recordCloseReversal(fake.gateway, ACTOR, { closeSeq: CLOSE_SEQ, reason: REASON }, 'desktop');
		const recipients = fake.intents.map((params) => params[2]);
		expect(recipients).toHaveLength(3);
		expect(recipients).toEqual(expect.arrayContaining(['snowflake-r1', 'snowflake-r2']));
	});

	it('rolls back on a refusal with nothing written', async () => {
		// Reversed once already: the second attempt is refused under the lock.
		const first = fakeGateway(baseLog());
		await recordCloseReversal(first.gateway, ACTOR, { closeSeq: CLOSE_SEQ, reason: REASON }, 'desktop');
		const reversal = first.appended[0];
		if (reversal === undefined) throw new Error('no reversal');
		const reversed: AppendedEvent = {
			seq: String(reversal['seq']),
			occurredAt: NOW.toISOString(),
			schemaVersion: 1,
			coreVersion: 1,
			type: AUCTION_CLOSE_REVERSED_EVENT,
			payload: reversal['payload'],
			managerId: ACTOR.managerId,
			teamId: ACTOR.teamId,
			deviceClass: null,
			dispatchOutcome: null,
			deliveryOutcome: null
		};

		const fake = fakeGateway([...baseLog(), reversed]);
		const outcome = await recordCloseReversal(
			fake.gateway,
			ACTOR,
			{ closeSeq: CLOSE_SEQ, reason: REASON },
			'desktop'
		);
		expect(outcome.kind).toBe('rejected');
		if (outcome.kind !== 'rejected') return;
		const rejection = outcome.reason as CloseReversalRejection;
		expect(rejection.refusal.kind).toBe('already_reversed');
		expect(rejection.detail).toContain('already reversed');
		expect(fake.order).toContain('rollback');
		expect(fake.order).not.toContain('append-event');
		expect(fake.order).not.toContain('rehold-slot');
		expect(fake.order).not.toContain('enqueue');
		expect(fake.appended).toEqual([]);
	});

	it('previews the same decision without a lock or a write', async () => {
		const fake = fakeGateway(baseLog());
		const outcome = await previewCloseReversal(fake.gateway, { closeSeq: CLOSE_SEQ, reason: 'x' });
		expect(outcome.kind).toBe('accepted');
		expect(fake.order).toEqual(['read-log', 'read-roster']);
	});
});

describe('affectedTeamsForReversal — the payload’s Team, close.ts’s pattern', () => {
	it('addresses the winning Team and nobody else', () => {
		const event: AppendedEvent = {
			...baseLog()[0]!,
			type: AUCTION_CLOSE_REVERSED_EVENT,
			payload: { teamId: TEAM_R }
		};
		expect(affectedTeamsForReversal(event)).toEqual([TEAM_R]);
		expect(affectedTeamsForReversal({ ...event, payload: null })).toEqual([]);
		expect(affectedTeamsForReversal({ ...event, type: 'AuctionClosed' })).toEqual([]);
	});
});
