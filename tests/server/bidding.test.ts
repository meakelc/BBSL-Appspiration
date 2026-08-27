/**
 * The bidding transaction. Server-only (Stories 2.5, 2.6).
 *
 * The stateful fake `ConnectionGateway` is `tests/server/nomination.test.ts`'s:
 * it records every statement in order and keeps the appended events in
 * memory, so "no event was appended" and "everything rolled back on a throw"
 * are observable rather than assumed. It throws on any statement it does not
 * recognise, which is what makes "no projection table was written" provable
 * rather than merely unasserted — there is no `open_nominations` branch here
 * and no branch for any other table beyond the one `team_rosters` READ Story
 * 2.6 added, because `placeBid` passes no `projections` array at all. The
 * distinction the fake preserves is exactly the one that matters: the money
 * gate reads a table, and still writes none.
 */

import { describe, expect, it } from 'vitest';

import { AUCTION_CLOCK, SALARY_CAP } from '../../src/lib/core/constants.ts';
import { BID_PLACED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import {
	AUCTION_CLOSED_EVENT,
	NOMINATION_PLACED_EVENT
} from '../../src/lib/core/projection/nominations.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { bidRefusalDetail } from '../../src/lib/core/rules/bidding.ts';
import type { BidPlacedPayload } from '../../src/lib/core/rules/bidding.ts';
import { loadBidState, placeBid } from '../../src/lib/server/bidding.ts';
import type { BidRejection } from '../../src/lib/server/bidding.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

const ACTOR = { managerId: 'm-2', teamId: 't-2', teamName: 'Rockets' };

const NOW = new Date('2026-08-26T12:00:00.000Z');

const DEVICE_CLASS = 'mobile';

/**
 * The acting Team's roster rows, as `team_rosters` returns them.
 *
 * Story 2.6 gave `loadBidState` its first table read, so the fake answers one
 * more statement. The default is a nine-player roster of $1.0M contracts: Cap
 * Space $156.0M and Roster Count 9, which is deliberately far more than any
 * amount bid in this file needs — every assertion here is about the four
 * gates that were already present, and a money gate that started refusing
 * them would be testing the wrong thing. `tests/examples/example-03-*` and
 * its neighbours are where the money arithmetic is the subject.
 */
const NINE_CHEAP_PLAYERS: QueryResultRow[] = Array.from({ length: 9 }, () => ({
	cap_hit: '1000000',
	roster_slot_kind: 'active_bench'
}));

function fakeGateway(
	options: { events?: QueryResultRow[]; roster?: QueryResultRow[] } = {}
) {
	const order: string[] = [];
	const params: unknown[][] = [];
	const appendedEvents: QueryResultRow[] = [];
	let seq = 40;
	let released = 0;
	let committed = false;
	let rolledBack = false;

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, queryParams: readonly unknown[] = []) {
			const sql = text.trim();
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
				return { rows: [...(options.events ?? []), ...appendedEvents] };
			}
			if (/^select cap_hit, roster_slot_kind\s+from team_rosters/i.test(sql)) {
				order.push('read-roster');
				params.push([...queryParams]);
				return { rows: options.roster ?? NINE_CHEAP_PLAYERS };
			}
			if (/^insert into auction_events/i.test(sql)) {
				order.push('append-event');
				params.push([...queryParams]);
				seq += 1;
				const row: QueryResultRow = {
					seq,
					occurred_at: queryParams[0],
					schema_version: queryParams[1],
					core_version: queryParams[2],
					manager_id: queryParams[3],
					team_id: queryParams[4],
					event_type: queryParams[5],
					payload: JSON.parse(String(queryParams[6])),
					device_class: queryParams[7],
					dispatch_outcome: queryParams[8],
					delivery_outcome: queryParams[9]
				};
				appendedEvents.push(row);
				return { rows: [row] };
			}
			if (/^commit/i.test(sql)) {
				order.push('commit');
				committed = true;
				return { rows: [] };
			}
			if (/^rollback/i.test(sql)) {
				order.push('rollback');
				rolledBack = true;
				// A real ROLLBACK discards every uncommitted write; the fake must
				// too, or "nothing was written" would be trivially true.
				appendedEvents.length = 0;
				return { rows: [] };
			}
			throw new Error(`unexpected statement: ${sql}`);
		},
		release() {
			released += 1;
		}
	};

	const gateway: ConnectionGateway = { connect: async () => client };

	return {
		gateway,
		client,
		order,
		params,
		appendedEvents,
		state: {
			get released() {
				return released;
			},
			get committed() {
				return committed;
			},
			get rolledBack() {
				return rolledBack;
			}
		}
	};
}

function logEvent(
	seq: number,
	type: string,
	payload: unknown,
	occurredAt = '2026-08-26T08:00:00.000Z',
	envelope: { managerId?: string; teamId?: string } = {}
): QueryResultRow {
	return {
		seq,
		occurred_at: new Date(occurredAt),
		schema_version: 1,
		core_version: 1,
		manager_id: envelope.managerId ?? 'm-0',
		team_id: envelope.teamId ?? 't-0',
		event_type: type,
		payload
	};
}

function nominated(seq = 1, fantraxPlayerId = 'p-1'): QueryResultRow {
	return logEvent(seq, NOMINATION_PLACED_EVENT, {
		fantraxPlayerId,
		playerName: 'Jalen Green',
		teamId: 't-9',
		teamName: 'Celtics',
		managerId: 'm-9'
	});
}

function bidLogged(
	seq: number,
	amount: number,
	teamId = 't-1',
	managerId = 'm-1',
	occurredAt = '2026-08-26T09:00:00.000Z'
): QueryResultRow {
	return logEvent(
		seq,
		BID_PLACED_EVENT,
		{
			fantraxPlayerId: 'p-1',
			teamId,
			teamName: teamId === 't-1' ? 'Lakers' : 'Rockets',
			managerId,
			amount,
			closesAt: '2026-08-27T09:00:00.000Z'
		},
		occurredAt,
		{ managerId, teamId }
	);
}

function rejectionOf(outcome: { kind: string; reason?: unknown }): BidRejection {
	expect(outcome.kind).toBe('rejected');
	return outcome.reason as BidRejection;
}

// --- The happy path ---------------------------------------------------------

describe('placeBid — the gate holds (AC4)', () => {
	it('appends exactly one BidPlaced, stamped by the database clock and naming the actor', async () => {
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_000_000)] });

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(8_500_000),
			DEVICE_CLASS
		);

		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;
		expect(outcome.events).toHaveLength(1);
		const event = outcome.events[0];
		expect(event?.type).toBe(BID_PLACED_EVENT);
		expect(event?.managerId).toBe(ACTOR.managerId);
		expect(event?.teamId).toBe(ACTOR.teamId);
		// The database clock, read once by the shell (AD-3) — never Date.now().
		expect(event?.occurredAt).toBe(NOW.toISOString());
		expect(event?.schemaVersion).toBe(1);
		expect(event?.coreVersion).toBe(1);
		expect(harness.state.committed).toBe(true);
		expect(harness.state.released).toBe(1);
	});

	it('carries the device class on the ENVELOPE, never in the payload', async () => {
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_000_000)] });

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(8_500_000),
			DEVICE_CLASS
		);
		if (outcome.kind !== 'accepted') throw new Error('the Bid was refused');

		expect(outcome.events[0]?.deviceClass).toBe(DEVICE_CLASS);
		// A measurement column, not domain data: no reducer and no gate may
		// ever be able to read it.
		expect(JSON.stringify(outcome.events[0]?.payload)).not.toContain(DEVICE_CLASS);
	});

	it('names Team, acting Manager, amount and the absolute close instant in the payload', async () => {
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_000_000)] });

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(8_500_000),
			DEVICE_CLASS
		);
		if (outcome.kind !== 'accepted') throw new Error('the Bid was refused');

		expect(outcome.events[0]?.payload).toEqual({
			fantraxPlayerId: 'p-1',
			teamId: 't-2',
			teamName: 'Rockets',
			managerId: 'm-2',
			amount: 8_500_000,
			closesAt: '2026-08-27T12:00:00.000Z'
		} satisfies BidPlacedPayload);
	});

	it('sets the close to exactly AUCTION_CLOCK after the event’s OWN occurredAt', async () => {
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_000_000)] });

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(8_500_000),
			DEVICE_CLASS
		);
		if (outcome.kind !== 'accepted') throw new Error('the Bid was refused');
		const event = outcome.events[0];
		const payload = event?.payload as BidPlacedPayload;

		// One clock read, used for both — so these cannot drift by a
		// millisecond however long the transaction took.
		expect(Date.parse(payload.closesAt) - Date.parse(event?.occurredAt ?? '')).toBe(AUCTION_CLOCK);
	});

	it('runs lock -> load -> decide -> persist -> commit, and locks before it reads', async () => {
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_000_000)] });

		await placeBid(harness.gateway, ACTOR, 'p-1', parseMoney(8_500_000), DEVICE_CLASS);

		expect(harness.order).toEqual([
			'begin',
			'lock',
			'read-log',
			// Story 2.6's one table READ, and it is AFTER the lock — which is
			// what makes the Cap figures the gate decides from unable to move
			// between the read and the decision (AD-6, AD-7).
			'read-roster',
			'append-event',
			'commit'
		]);
	});

	it('writes NOTHING but the event — no claim row, no projection table, no derived figure', async () => {
		// The fake throws on any statement it does not recognise, and it
		// recognises only begin/lock/read/insert-event/commit/rollback. A
		// `projections` hook of any kind would fail this test outright.
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_000_000)] });

		await placeBid(harness.gateway, ACTOR, 'p-1', parseMoney(8_500_000), DEVICE_CLASS);

		expect(harness.order.filter((step) => step === 'append-event')).toHaveLength(1);
		expect(harness.order).not.toContain('claim');
		// Two parameterised statements now: the roster READ and the event
		// INSERT. The read is the point of the distinction — Story 2.6 reads a
		// table and still writes none, so no `insert`/`update`/`delete`
		// touches anything but `auction_events`.
		expect(harness.params).toHaveLength(2);
		const writes = harness.order.filter((step) => step !== 'read-log' && step !== 'read-roster');
		expect(writes).toEqual(['begin', 'lock', 'append-event', 'commit']);
	});

	it('opens an Auction that has no Bid yet, at the minimum legal opening', async () => {
		const harness = fakeGateway({ events: [nominated()] });

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(1_500_000),
			DEVICE_CLASS
		);

		expect(outcome.kind).toBe('accepted');
	});
});

// --- The refusals -----------------------------------------------------------

describe('placeBid — the gate refuses (AC1, AC2, AC3)', () => {
	it('refuses a Bid below the current high plus the increment, and appends nothing', async () => {
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_000_000)] });

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(8_400_000),
			DEVICE_CLASS
		);

		const rejection = rejectionOf(outcome);
		expect(rejection.refusal.kind).toBe('gates');
		expect(rejection.detail).toBe(bidRefusalDetail(rejection.refusal));
		expect(harness.order).toEqual(['begin', 'lock', 'read-log', 'read-roster', 'rollback']);
		expect(harness.appendedEvents).toHaveLength(0);
		expect(harness.state.committed).toBe(false);
	});

	it('carries the FULL gate set back, passed gates and all', async () => {
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_000_000)] });

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(8_400_000),
			DEVICE_CLASS
		);
		const rejection = rejectionOf(outcome);
		if (rejection.refusal.kind !== 'gates') throw new Error('expected a gate refusal');

		expect(Object.keys(rejection.refusal.gates).sort()).toEqual([
			'cap',
			'granularity',
			'increment',
			'opening',
			'selfBid',
			'slots'
		]);
		expect(rejection.refusal.gates.increment.passed).toBe(false);
		expect(rejection.refusal.gates.granularity.passed).toBe(false);
		expect(rejection.refusal.gates.selfBid.passed).toBe(true);
		// The money gate passed and carries its own arithmetic anyway — an
		// $8.4M bid is well inside a $154.0M Maximum Bid. Reporting it is what
		// forecloses "what else is it not telling me".
		expect(rejection.refusal.gates.cap.passed).toBe(true);
		expect(rejection.refusal.gates.cap.maximumBid).toBe(154_000_000);
		// And so does the capacity gate, with its own two counts: nine held
		// plus the one being bid is ten of twelve.
		expect(rejection.refusal.gates.slots.passed).toBe(true);
		expect(rejection.refusal.gates.slots.rosterCount).toBe(9);
		expect(rejection.refusal.gates.slots.projectedAdditions).toBe(1);

		// And the rejection carries the figures back with the clock they were
		// decided at, so the panel shows what THIS transaction judged (FR-13).
		expect(rejection.gates).toBe(rejection.refusal.gates);
		expect(rejection.at).toBe(NOW.toISOString());
	});

	it('refuses the Team that already leads, with its own distinct wording', async () => {
		const harness = fakeGateway({
			events: [nominated(), bidLogged(2, 8_000_000, 't-2', 'm-2')]
		});

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(8_500_000),
			DEVICE_CLASS
		);

		const rejection = rejectionOf(outcome);
		expect(rejection.detail).toContain('does not bid against itself');
		expect(harness.appendedEvents).toHaveLength(0);
	});

	it('refuses an Opening Bid of exactly $1,000,000 — no contention is created', async () => {
		const harness = fakeGateway({ events: [nominated()] });

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(1_000_000),
			DEVICE_CLASS
		);

		expect(rejectionOf(outcome).detail).toContain('Minimum-Bid Contention');
		expect(harness.appendedEvents).toHaveLength(0);
	});

	it('refuses when the Player’s Auction is not open — re-derived under the lock', async () => {
		for (const events of [
			// Never nominated.
			[],
			// Nominated, then closed (Story 2.3's release fold).
			[nominated(), logEvent(2, AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'p-1' })]
		]) {
			const harness = fakeGateway({ events });
			const outcome = await placeBid(
				harness.gateway,
				ACTOR,
				'p-1',
				parseMoney(8_500_000),
				DEVICE_CLASS
			);
			const rejection = rejectionOf(outcome);
			expect(rejection.refusal.kind).toBe('no_open_auction');
			expect(rejection.detail).toBe(bidRefusalDetail({ kind: 'no_open_auction' }));
			expect(harness.appendedEvents).toHaveLength(0);
		}
	});

	it('refuses on capacity under the lock, against roster figures read after it', async () => {
		// Story 2.7's row of the matrix. The roster is read INSIDE the
		// transaction, after `pg_advisory_xact_lock` — the order below is the
		// assertion, not a description of it — so a page rendered before a
		// Commissioner filled the twelfth Slot cannot race a stale count past
		// the board.
		const harness = fakeGateway({
			events: [nominated(), bidLogged(2, 8_000_000)],
			roster: Array.from({ length: 12 }, () => ({
				cap_hit: '1000000',
				roster_slot_kind: 'active_bench'
			}))
		});

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(8_500_000),
			DEVICE_CLASS
		);

		const rejection = rejectionOf(outcome);
		if (rejection.refusal.kind !== 'gates') throw new Error('expected a gate refusal');

		expect(rejection.refusal.gates.slots.passed).toBe(false);
		expect(rejection.refusal.gates.slots.rosterCount).toBe(12);
		expect(rejection.refusal.gates.slots.projectedAdditions).toBe(1);
		expect(rejection.refusal.gates.slots.ceiling).toBe(12);
		// $153.0M of Cap Space against an $8.5M Bid: the money is not the
		// obstacle, and the panel says so rather than leaving it ambiguous.
		expect(rejection.refusal.gates.cap.passed).toBe(true);
		expect(rejection.detail).toContain('no roster slot');
		expect(rejection.detail).not.toContain('Maximum Bid');
		// The transaction's own gate set and its own stamp.
		expect(rejection.gates).toBe(rejection.refusal.gates);
		expect(rejection.at).toBe(NOW.toISOString());
		// The lock came first, the roster read after it, and no BidPlaced.
		expect(harness.order).toEqual(['begin', 'lock', 'read-log', 'read-roster', 'rollback']);
		expect(harness.appendedEvents).toHaveLength(0);
		expect(harness.state.committed).toBe(false);
	});

	it('always rolls back and releases the connection on a refusal', async () => {
		const harness = fakeGateway({ events: [] });
		await placeBid(harness.gateway, ACTOR, 'p-1', parseMoney(8_500_000), DEVICE_CLASS);
		expect(harness.state.rolledBack).toBe(true);
		expect(harness.state.released).toBe(1);
	});
});

// --- §10 example 15, driven through the real transaction --------------------

describe('placeBid — the co-manager race, serialised by the lock (§10 example 15)', () => {
	it('accepts exactly one and refuses the other because the price moved', async () => {
		// ONE gateway, so the second call loads a log that already contains the
		// first call's committed event — which is what the global advisory lock
		// guarantees in production (AD-6).
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_000_000, 't-1', 'm-1')] });

		const first = await placeBid(
			harness.gateway,
			{ managerId: 'm-l1', teamId: 't-l', teamName: 'Team L' },
			'p-1',
			parseMoney(8_500_000),
			DEVICE_CLASS
		);
		const second = await placeBid(
			harness.gateway,
			{ managerId: 'm-l2', teamId: 't-l', teamName: 'Team L' },
			'p-1',
			parseMoney(8_500_000),
			DEVICE_CLASS
		);

		expect(first.kind).toBe('accepted');
		expect(second.kind).toBe('rejected');
		expect(rejectionOf(second).detail).toContain('the least you may offer is $9.0M');

		// Exactly one event landed, and the log names the Manager who placed it.
		if (first.kind !== 'accepted') return;
		expect(first.events).toHaveLength(1);
		expect(first.events[0]?.managerId).toBe('m-l1');
		expect(harness.order.filter((step) => step === 'append-event')).toHaveLength(1);
	});
});

// --- loadBidState -----------------------------------------------------------

describe('loadBidState — three folds over ONE read of the log, plus one roster read', () => {
	it('reads the log exactly once and the roster exactly once', async () => {
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_000_000)] });
		await harness.client.query('begin');

		const loaded = await loadBidState(harness.client, 'p-1', 't-2');

		expect(loaded.nomination?.fantraxPlayerId).toBe('p-1');
		// Narrowed to exactly what the gates decide from: the leading Team and
		// amount for the first four, and the acting Team's money facts for the
		// fifth. Nothing derived — no Committed Bids, no Maximum Bid (AD-7).
		expect(loaded.bid).toEqual({
			leadingBid: { teamId: 't-1', amount: 8_000_000 },
			team: { capSpace: 156_000_000, rosterCount: 9, leading: [] }
		});
		// The log is read once and the roster once, and BOTH after the lock —
		// which is what makes the figures the gate decides from unable to move
		// between the read and the decision (AD-6, AD-7).
		expect(harness.order).toEqual(['begin', 'read-log', 'read-roster']);
	});

	it('keys the roster read on the ACTING Team, never on the leading one', async () => {
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_000_000)] });
		await harness.client.query('begin');

		await loadBidState(harness.client, 'p-1', 't-2');

		// `t-1` leads this Auction; `t-2` is bidding. A roster read keyed on
		// the leader would compute the wrong Team's Maximum Bid and refuse the
		// bidder on somebody else's arithmetic.
		expect(harness.params.at(-1)).toEqual(['t-2']);
	});

	it('excludes the Auction being bid on from that Team’s own commitments', async () => {
		// `t-2` already leads p-1 at $8.0M and is bidding on p-1 again. The
		// prospective Bid REPLACES that lead, so counting both would commit
		// the Team twice for one Player.
		const harness = fakeGateway({
			events: [nominated(), bidLogged(2, 8_000_000, 't-2')]
		});
		await harness.client.query('begin');

		const loaded = await loadBidState(harness.client, 'p-1', 't-2');
		expect(loaded.bid.team?.leading).toEqual([]);
	});

	it('separates "no Auction" from "no Bids yet"', async () => {
		const harness = fakeGateway({ events: [nominated()] });
		await harness.client.query('begin');

		const loaded = await loadBidState(harness.client, 'p-1', 't-2');
		expect(loaded.nomination).not.toBeNull();
		expect(loaded.bid.leadingBid).toBeNull();

		const missing = await loadBidState(harness.client, 'p-nobody', 't-2');
		expect(missing.nomination).toBeNull();
		expect(missing.bid.leadingBid).toBeNull();
	});

	it('answers with the full Salary Cap and Roster Count 0 for a Team with no rows', async () => {
		// A real state, reachable before the import promotes anything — not an
		// error, and not a refusal for a reason no rule states.
		const harness = fakeGateway({ events: [nominated()], roster: [] });
		await harness.client.query('begin');

		const loaded = await loadBidState(harness.client, 'p-1', 't-2');
		expect(loaded.bid.team).toEqual({
			capSpace: SALARY_CAP,
			rosterCount: 0,
			leading: []
		});
	});
});
