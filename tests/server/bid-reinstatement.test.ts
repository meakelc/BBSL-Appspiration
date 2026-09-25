/**
 * `recordBidReinstatement` — the one transaction (Story 7.14, FR-32, FR-40).
 *
 * Claims only a transaction can show:
 *
 *  1. **Exactly one `BidCancellationReversed` is appended, and nothing in
 *     `auction_events` is updated or deleted** (AD-4). The fake throws on any
 *     statement it does not recognise, so an `update auction_events` or a
 *     `delete from auction_events` is a failure by name — and so is an
 *     appended `AuctionClosed`, which this override never writes.
 *  2. **The decision is re-derived under the lock**, against the lock's own
 *     clock: a refusal rolls back with nothing written.
 *  3. **It is broadcast, and the reinstated and erased Teams are mentioned.**
 *
 * The stateful fake is `tests/server/close-reversal.test.ts`'s pattern.
 */

import { describe, expect, it } from 'vitest';

import { BID_CANCELLATION_REVERSED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import type { BidCancellationReversedPayload } from '../../src/lib/core/rules/bid-reinstatement.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';
import {
	affectedTeamsForReinstatement,
	previewBidReinstatement,
	recordBidReinstatement
} from '../../src/lib/server/bid-reinstatement.ts';
import type { BidReinstatementRejection } from '../../src/lib/server/bid-reinstatement.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';
import {
	BOS,
	CANCELLATION_SEQ,
	DET,
	NYK,
	knechtLog,
	reinstatementEvent
} from '../fixtures/bid-reinstatement-log.ts';

const NOW = new Date('2026-09-25T18:00:00.000Z');
const ACTOR = { managerId: 'm-c', teamId: 't-cha', displayName: 'The Commissioner' };
const REASON = 'Butler was on IR in Fantrax; the cancellation should not have fired.';

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

/** DET's imported rows: nine Active/Bench at $1.0M — Roster Count 10 with Whitmore. */
function detRows(count = 9): QueryResultRow[] {
	return Array.from({ length: count }, (_unused, index) => ({
		fantrax_player_id: `p-det-${String(index)}`,
		player_name: `Rostered ${String(index)}`,
		cap_hit: 1_000_000,
		roster_slot_kind: 'active_bench',
		contract_years_remaining: 2,
		rookie_scale_round: null
	}));
}

function fakeGateway(events: readonly AppendedEvent[], rosterSize = 9) {
	const order: string[] = [];
	const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
	const appended: QueryResultRow[] = [];
	const intents: Array<readonly unknown[]> = [];
	let seq = 6000;

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
			if (/^select now\(\)/i.test(sql)) {
				order.push('read-clock');
				return { rows: [{ now: NOW }] };
			}
			if (/^select \* from auction_events/i.test(sql)) {
				order.push('read-log');
				return { rows: events.map(rowOf) };
			}
			if (/^select[\s\S]*from team_rosters/i.test(sql)) {
				order.push('read-roster');
				return { rows: String(params[0]) === DET ? detRows(rosterSize) : [] };
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
			if (/^select coalesce\(discord_mention_user_id/i.test(sql)) {
				order.push('read-managers');
				const team = String(params[0]);
				return team === DET
					? { rows: [{ discord_user_id: 'snowflake-det' }] }
					: team === NYK
						? { rows: [{ discord_user_id: 'snowflake-nyk' }] }
						: team === BOS
							? { rows: [{ discord_user_id: 'snowflake-bos' }] }
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
				intents.length = 0;
				return { rows: [] };
			}
			throw new Error(`unexpected statement: ${sql}`);
		},
		release() {}
	};

	return {
		gateway: { connect: async () => client } satisfies ConnectionGateway,
		order,
		statements,
		appended,
		intents
	};
}

describe('recordBidReinstatement — one event, and the notice', () => {
	it('appends exactly one BidCancellationReversed and touches no other event', async () => {
		const fake = fakeGateway(knechtLog());
		const outcome = await recordBidReinstatement(
			fake.gateway,
			ACTOR,
			{ cancellationSeq: CANCELLATION_SEQ, reason: REASON },
			'desktop'
		);
		expect(outcome.kind).toBe('accepted');
		expect(fake.appended).toHaveLength(1);
		expect(fake.appended[0]?.['event_type']).toBe(BID_CANCELLATION_REVERSED_EVENT);
		expect(fake.appended[0]?.['manager_id']).toBe(ACTOR.managerId);
		const payload = fake.appended[0]?.['payload'] as BidCancellationReversedPayload;
		expect(payload.cancellationSeq).toBe(CANCELLATION_SEQ);
		expect(payload.teamId).toBe(DET);
		expect(payload.clockExpired).toBe(true);
		expect(payload.reason).toBe(REASON);
		// AD-4: nothing in the log is updated or deleted.
		expect(
			fake.statements.filter((statement) =>
				/^(update|delete from)\s+auction_events/i.test(statement.sql)
			)
		).toEqual([]);
		expect(fake.order.slice(0, 5)).toEqual(['begin', 'lock', 'read-log', 'read-roster', 'append-event']);
		expect(fake.order[fake.order.length - 1]).toBe('commit');
	});

	it('broadcasts once and mentions the reinstated Team and each erased Team', async () => {
		const fake = fakeGateway(knechtLog());
		await recordBidReinstatement(
			fake.gateway,
			ACTOR,
			{ cancellationSeq: CANCELLATION_SEQ, reason: REASON },
			'desktop'
		);
		const recipients = fake.intents.map((params) => params[2]);
		expect(recipients).toHaveLength(4);
		expect(recipients).toEqual(
			expect.arrayContaining(['snowflake-det', 'snowflake-nyk', 'snowflake-bos'])
		);
	});

	it('rolls back on a refusal decided under the lock, with nothing written', async () => {
		const first = fakeGateway(knechtLog());
		await recordBidReinstatement(
			first.gateway,
			ACTOR,
			{ cancellationSeq: CANCELLATION_SEQ, reason: REASON },
			'desktop'
		);
		const payload = first.appended[0]?.['payload'];
		const fake = fakeGateway([...knechtLog(), reinstatementEvent(6001, payload)]);
		const outcome = await recordBidReinstatement(
			fake.gateway,
			ACTOR,
			{ cancellationSeq: CANCELLATION_SEQ, reason: REASON },
			'desktop'
		);
		expect(outcome.kind).toBe('rejected');
		if (outcome.kind !== 'rejected') return;
		const rejection = outcome.reason as BidReinstatementRejection;
		expect(rejection.refusal.kind).toBe('already_reinstated');
		expect(rejection.detail).toContain('already reinstated');
		expect(fake.order).toContain('rollback');
		expect(fake.order).not.toContain('append-event');
		expect(fake.order).not.toContain('enqueue');
		expect(fake.appended).toEqual([]);
	});

	it('refuses under the lock when the reinstated Team fails its gates now', async () => {
		// Eleven imported Active/Bench rows plus Whitmore: Roster Count 12.
		const fake = fakeGateway(knechtLog(), 11);
		const outcome = await recordBidReinstatement(
			fake.gateway,
			ACTOR,
			{ cancellationSeq: CANCELLATION_SEQ, reason: REASON },
			'desktop'
		);
		expect(outcome.kind).toBe('rejected');
		if (outcome.kind !== 'rejected') return;
		expect((outcome.reason as BidReinstatementRejection).refusal.kind).toBe('gates');
		expect(fake.appended).toEqual([]);
	});

	it('previews the same decision without a lock or a write', async () => {
		const fake = fakeGateway(knechtLog());
		const outcome = await previewBidReinstatement(fake.gateway, {
			cancellationSeq: CANCELLATION_SEQ,
			reason: 'x'
		});
		expect(outcome.kind).toBe('accepted');
		expect(fake.order).toEqual(['read-clock', 'read-log', 'read-roster']);
	});
});

describe('affectedTeamsForReinstatement — the payload’s Teams', () => {
	it('addresses the reinstated Team and every erased Team, once each', () => {
		const event: AppendedEvent = {
			...knechtLog()[0]!,
			type: BID_CANCELLATION_REVERSED_EVENT,
			payload: {
				teamId: DET,
				erasedBids: [{ teamId: NYK }, { teamId: BOS }, { teamId: NYK }, null]
			}
		};
		expect(affectedTeamsForReinstatement(event)).toEqual([DET, NYK, BOS]);
		expect(affectedTeamsForReinstatement({ ...event, payload: null })).toEqual([]);
		expect(affectedTeamsForReinstatement({ ...event, type: 'BidCancelled' })).toEqual([]);
	});
});
