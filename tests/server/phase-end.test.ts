/**
 * The phase-end transaction. Server-only (Story 3.7, FR-22).
 *
 * **This file exists because every sweep test stubs `endPhase`.** The sweep
 * owns WHEN the evaluation runs and what a failure of it means for the pass;
 * `evaluateLeagueClock` owns what ending the phase IS. Driving the real
 * transaction is the only way to prove the events that were actually appended,
 * the claim rows that were actually deleted, and that both happened inside one
 * committed transaction.
 *
 * The stateful fake `ConnectionGateway` is `tests/server/close.test.ts`'s: it
 * records every statement in order and keeps the appended events in memory, so
 * "the terminations came first", "the claim row was deleted in the same
 * transaction" and "everything rolled back on a throw" are observable rather
 * than assumed. It throws on any statement it does not recognise, which is what
 * makes "no roster read, no pool read, no `free_agent_players` write" provable
 * rather than merely unasserted.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { MINIMUM_BID } from '../../src/lib/core/constants.ts';
import { BID_PLACED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import {
	AUCTION_TERMINATED_EVENT,
	NOMINATION_PLACED_EVENT
} from '../../src/lib/core/projection/nominations.ts';
import {
	AUCTION_OPENED_EVENT,
	CONTRACT_ASSIGNMENT_OPENED_EVENT
} from '../../src/lib/core/projection/phase.ts';
import type {
	AuctionTerminatedPayload,
	ContractAssignmentOpenedPayload
} from '../../src/lib/core/rules/phase-end.ts';
import { evaluateLeagueClock, loadPhaseEndState,
	resetPhaseEndFoldCache
} from '../../src/lib/server/phase-end.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';



// The tick's loaders hold their folded state in a module-scoped slot, so a
// test inheriting the previous test's fold would be reading a log that this
// test's fake never served. Every test starts from a cold process.
beforeEach(() => resetPhaseEndFoldCache());

/**
 * The two helpers the log-read fakes below need now that the tick's loaders
 * read INCREMENTALLY (`loadEventsViaClientSince` / `maxSeqViaClient`).
 *
 * The bound is honoured rather than ignored on purpose: a fake that returned
 * the whole log for every `seq > $1` would let a cached loader fold the same
 * events twice and still pass, which is precisely the bug these fakes should
 * be able to catch.
 */
function maxSeqOf(rows: readonly QueryResultRow[]): bigint {
	return rows.reduce((highest, row) => {
		const seq = BigInt(String(row['seq']));
		return seq > highest ? seq : highest;
	}, 0n);
}

function rowsAbove(rows: readonly QueryResultRow[], since: unknown): QueryResultRow[] {
	const bound = since === undefined ? 0n : BigInt(String(since));
	return rows.filter((row) => BigInt(String(row['seq'])) > bound);
}

/** 08:00 Monday — the open. The League Clock therefore expires 08:00 Wednesday. */
const OPENED_AT = '2026-08-24T08:00:00.000Z';
const EXPIRES_AT = '2026-08-26T08:00:00.000Z';

/** The database's transaction-start clock, one second past the expiry. */
const NOW = new Date('2026-08-26T08:00:01.000Z');

/** ...and one second before it, for the pass that must do nothing. */
const TOO_EARLY = new Date('2026-08-26T07:59:59.000Z');

/**
 * What a pass that ended nothing reports: no phase end, no terminations, and
 * NEITHER instant.
 *
 * The instants are read back off the appended `ContractAssignmentOpened`, so a
 * pass that appended none has nothing to read and says so rather than
 * inventing a pair.
 */
const NOTHING_DUE = { ended: false, terminated: [], expiredAt: null, evaluatedAt: null };

/**
 * What the one pass that ends the phase reports.
 *
 * `expiredAt` is the League Clock's OWN expiry and `evaluatedAt` the
 * transaction clock it was compared against — the pair `server/sweep.ts`
 * states on the heartbeat so AD-10's "late, not wrong" is readable after the
 * fact. Both are read back off the payload that actually committed.
 */
function endedWith(terminated: readonly string[], evaluatedAt = NOW.toISOString()) {
	return { ended: true, terminated, expiredAt: EXPIRES_AT, evaluatedAt };
}

/**
 * The Teams `EVERY_TEAM` resolves to in this fake's league (Story 5.3).
 *
 * A constant rather than an option, because the one trigger that reaches it
 * is `ContractAssignmentOpened` and what matters about it is that the enqueue
 * asked the whole-league question at all.
 */
const EVERY_LEAGUE_TEAM: readonly string[] = ['t-one', 't-two'];

function fakeGateway(options: { events?: QueryResultRow[]; now?: Date } = {}) {
	const order: string[] = [];
	const appendedEvents: QueryResultRow[] = [];
	let releasedClaims: unknown[][] = [];
	let seq = 40;
	let released = 0;
	let committed = false;
	let rolledBack = false;

	/**
	 * The delivery intents this transaction filed (Story 5.3): the event they
	 * describe and who they address. Recorded rather than merely tolerated, so
	 * “this write mentioned exactly these Teams” is observable.
	 */
	const outboxIntents: Array<{ eventSeq: string; recipient: string }> = [];

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, queryParams: readonly unknown[] = []) {
			const sql = text.trim();
			if (/^begin/i.test(sql)) {
				order.push('begin');
				return { rows: [] };
			}
			if (/pg_advisory_xact_lock/i.test(sql)) {
				order.push('lock');
				return { rows: [{ locked: true, now: options.now ?? NOW }] };
			}
			if (/coalesce\(max\(seq\)/i.test(sql)) {
				// `maxSeqViaClient`. Deliberately NOT pushed onto `order`: it is
				// the cache key `foldIncrementally` compares, not a step of the
				// pipeline these tests assert the shape of.
				return { rows: [{ seq: String(maxSeqOf([...(options.events ?? []), ...appendedEvents])) }] };
			}
			if (/^select \* from auction_events/i.test(sql)) {
				order.push('read-log');
				return { rows: rowsAbove([...(options.events ?? []), ...appendedEvents], queryParams[0]) };
			}
			if (/^insert into auction_events/i.test(sql)) {
				order.push('append-event');
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
			if (/^delete from open_nominations/i.test(sql)) {
				order.push('release-claim');
				releasedClaims.push([...queryParams]);
				return { rows: [] };
			}
			if (/^commit/i.test(sql)) {
				order.push('commit');
				committed = true;
				return { rows: [] };
			}
			if (/^rollback/i.test(sql)) {
				order.push('rollback');
				rolledBack = true;
				// A real ROLLBACK discards every uncommitted write; the fake
				// must too, or "nothing was written" would be trivially true.
				appendedEvents.length = 0;
				releasedClaims = [];
				return { rows: [] };
			}
			// Story 5.2 registered `enqueueBroadcasts` on this write, so the
			// appending transaction now also files one channel-addressed
			// delivery intent per broadcast-worthy event (AD-17). It is
			// recorded in `statements` like every other statement and asserted
			// on in `tests/server/outbox.test.ts`, which owns the outbox; here
			// it only has to be a statement the fake recognises rather than one
			// it rejects.
			// Story 5.3 registered a Manager-shaped enqueue beside the
			// broadcast one, so the transaction now also asks which Managers
			// act for each AFFECTED Team — the Team the write site named, never
			// the event's own. One synthetic snowflake per Team, so a test can
			// read the affected set straight off the intents it filed.
			if (/^select coalesce\(.+\)\s+as discord_user_id\s+from managers\s+where team_id = \$1/i.test(sql)) {
				return { rows: [{ discord_user_id: `discord-${String(queryParams[0])}` }] };
			}
			if (/^select coalesce\(.+\)\s+as discord_user_id\s+from managers\s+where team_id is not null/i.test(sql)) {
				return {
					rows: EVERY_LEAGUE_TEAM.map((teamId) => ({ discord_user_id: `discord-${teamId}` }))
				};
			}
			if (/^insert into notification_outbox/i.test(sql)) {
				outboxIntents.push({
					eventSeq: String(queryParams[0]),
					recipient: String(queryParams[2])
				});
				return { rows: [] };
			}
			throw new Error(`unexpected statement: ${sql}`);
		},
		release() {
			released += 1;
		}
	};

	return {
		outboxIntents,
		gateway: { connect: async () => client } satisfies ConnectionGateway,
		client,
		order,
		appendedEvents,
		get releasedClaims() {
			return releasedClaims;
		},
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

function logEvent(seq: number, type: string, occurredAt: string, payload: unknown): QueryResultRow {
	return {
		seq,
		occurred_at: new Date(occurredAt),
		schema_version: 1,
		core_version: 1,
		manager_id: 'm-actor',
		team_id: 't-actor',
		event_type: type,
		payload
	};
}

const opened = () => logEvent(1, AUCTION_OPENED_EVENT, OPENED_AT, {});

const nominated = (
	seq: number,
	fantraxPlayerId: string,
	playerName: string,
	teamId: string,
	teamName: string,
	managerId: string
) =>
	logEvent(seq, NOMINATION_PLACED_EVENT, OPENED_AT, {
		fantraxPlayerId,
		playerName,
		teamId,
		teamName,
		managerId
	});

const bidOn = (seq: number, fantraxPlayerId: string, amount: number) =>
	logEvent(seq, BID_PLACED_EVENT, OPENED_AT, {
		fantraxPlayerId,
		teamId: 't-bidder',
		teamName: 'Team Bidder',
		managerId: 'm-bidder',
		amount,
		closesAt: '2026-08-25T08:00:00.000Z',
		contention: amount === MINIMUM_BID ? 'minimum_bid' : 'standard'
	});

// --- loadPhaseEndState ------------------------------------------------------

describe('loadPhaseEndState — four folds over ONE read of the log', () => {
	it('reads the log exactly once and reads no table at all', async () => {
		const harness = fakeGateway({
			events: [opened(), nominated(2, 'p-a', 'Ausar Bright', 't-1', 'Lakers', 'm-1'), bidOn(3, 'p-a', 8_000_000)]
		});

		const state = await loadPhaseEndState(harness.client);

		// One read, and nothing else. A roster read or a pool read would throw
		// in the fake above, which is what makes this provable rather than
		// merely unasserted.
		expect(harness.order).toEqual(['read-log']);
		expect(state.phase).toBe('Auction');
		expect(state.clock.origin).toBe(OPENED_AT);
		expect(state.nominations.byPlayer['p-a']?.managerId).toBe('m-1');
		// **The fourth fold, and the one the story turns on.** Without it,
		// "Awaiting Opening Bid" would be assumed from the nominations fold.
		expect(state.auctions.byPlayer['p-a']?.leadingBid?.amount).toBe(8_000_000);
	});
});

// --- evaluateLeagueClock ----------------------------------------------------

describe('evaluateLeagueClock — the clock has not run out', () => {
	it('appends nothing, deletes nothing, and still commits', async () => {
		const harness = fakeGateway({ events: [opened()], now: TOO_EARLY });

		const outcome = await evaluateLeagueClock(harness.gateway);

		expect(outcome).toEqual(NOTHING_DUE);
		expect(harness.appendedEvents).toHaveLength(0);
		expect(harness.releasedClaims).toEqual([]);
		// It still takes the lock, reads and commits: the read has to be a
		// consistent one, and a transaction that decided nothing is not a
		// transaction that failed.
		expect(harness.order).toEqual(['begin', 'lock', 'read-log', 'commit']);
		expect(harness.state.committed).toBe(true);
		expect(harness.state.rolledBack).toBe(false);
		expect(harness.state.released).toBe(1);
	});

	it('appends nothing for a league that never opened the auction', async () => {
		const harness = fakeGateway({ events: [] });

		expect(await evaluateLeagueClock(harness.gateway)).toEqual(NOTHING_DUE);
		expect(harness.appendedEvents).toHaveLength(0);
	});
});

describe('evaluateLeagueClock — the clock has run out', () => {
	it('appends the terminations FIRST and ContractAssignmentOpened LAST, in ONE transaction', async () => {
		const harness = fakeGateway({
			events: [
				opened(),
				nominated(2, 'p-a', 'Ausar Bright', 't-1', 'Lakers', 'm-1'),
				nominated(3, 'p-b', 'Malik Rowe', 't-2', 'Celtics', 'm-2')
			]
		});

		const outcome = await evaluateLeagueClock(harness.gateway);

		expect(outcome).toEqual(endedWith(['p-a', 'p-b']));
		expect(harness.appendedEvents.map((row) => row['event_type'])).toEqual([
			AUCTION_TERMINATED_EVENT,
			AUCTION_TERMINATED_EVENT,
			CONTRACT_ASSIGNMENT_OPENED_EVENT
		]);
		// One transaction: one begin, one commit, and every insert between
		// them.
		expect(harness.order).toEqual([
			'begin',
			'lock',
			'read-log',
			'append-event',
			'append-event',
			'append-event',
			'release-claim',
			'release-claim',
			'commit'
		]);
	});

	it('deletes the claim row for every terminated Player, inside that transaction', async () => {
		// **The registration this story could not skip.** `open_nominations`
		// is a claim table with a unique constraint on the Team; a row left
		// behind would make the table and the log disagree about a freed Slot
		// permanently, and an insert-only log can never be replayed to clear
		// it.
		const harness = fakeGateway({
			events: [
				opened(),
				nominated(2, 'p-a', 'Ausar Bright', 't-1', 'Lakers', 'm-1'),
				nominated(3, 'p-b', 'Malik Rowe', 't-2', 'Celtics', 'm-2')
			]
		});

		await evaluateLeagueClock(harness.gateway);

		expect(harness.releasedClaims).toEqual([['p-a'], ['p-b']]);
		// After the appends and before the commit — the `projections` seam is
		// the one hook that persists INSIDE the appending transaction (AD-5).
		expect(harness.order.indexOf('release-claim')).toBeGreaterThan(
			harness.order.lastIndexOf('append-event')
		);
		expect(harness.order.lastIndexOf('release-claim')).toBeLessThan(harness.order.indexOf('commit'));
	});

	it('appends ContractAssignmentOpened alone when nothing is unbid, and deletes no claim', async () => {
		const harness = fakeGateway({ events: [opened()] });

		const outcome = await evaluateLeagueClock(harness.gateway);

		expect(outcome).toEqual(endedWith([]));
		expect(harness.appendedEvents.map((row) => row['event_type'])).toEqual([
			CONTRACT_ASSIGNMENT_OPENED_EVENT
		]);
		expect(harness.releasedClaims).toEqual([]);
	});

	it('binds a NULL Manager and Team for the phase end, and the nominator’s for a termination', async () => {
		const harness = fakeGateway({
			events: [opened(), nominated(2, 'p-a', 'Ausar Bright', 't-1', 'Lakers', 'm-1')]
		});

		await evaluateLeagueClock(harness.gateway);

		const [terminated, ended] = harness.appendedEvents;
		expect(terminated?.['manager_id']).toBe('m-1');
		expect(terminated?.['team_id']).toBe('t-1');
		// The first genuinely system-originated event in the product. Nobody
		// acted: a clock ran out (`20260901000000_system_actor.sql`).
		expect(ended?.['manager_id']).toBeNull();
		expect(ended?.['team_id']).toBeNull();
		// And no device class on either: neither is a user action.
		expect(terminated?.['device_class']).toBeNull();
		expect(ended?.['device_class']).toBeNull();
	});

	it('stamps the League Clock’s own expiry on the payloads, not the transaction clock', async () => {
		const harness = fakeGateway({
			events: [opened(), nominated(2, 'p-a', 'Ausar Bright', 't-1', 'Lakers', 'm-1')],
			// Six hours late. AD-10: late, not wrong.
			now: new Date('2026-08-26T14:00:00.000Z')
		});

		const outcome = await evaluateLeagueClock(harness.gateway);

		// **The pair comes back to the caller**, read off the payload that
		// actually committed rather than recomputed — which is what lets
		// `server/sweep.ts` state both instants on the heartbeat, so an operator
		// can tell this six-hour-late pass from an on-time one.
		expect(outcome).toEqual(endedWith(['p-a'], '2026-08-26T14:00:00.000Z'));

		const terminated = harness.appendedEvents[0]?.['payload'] as AuctionTerminatedPayload;
		const ended = harness.appendedEvents[1]?.['payload'] as ContractAssignmentOpenedPayload;

		expect(terminated.expiredAt).toBe(EXPIRES_AT);
		expect(ended.expiredAt).toBe(EXPIRES_AT);
		// The instant it was actually judged at is recorded beside it, which is
		// what makes a late evaluation readable rather than invisible.
		expect(ended.evaluatedAt).toBe('2026-08-26T14:00:00.000Z');
		expect(ended.terminatedPlayerIds).toEqual(['p-a']);
	});

	it('is a no-op the SECOND time — which is what makes a restart-safe tick safe', async () => {
		const harness = fakeGateway({
			events: [opened(), nominated(2, 'p-a', 'Ausar Bright', 't-1', 'Lakers', 'm-1')]
		});

		expect(await evaluateLeagueClock(harness.gateway)).toEqual(endedWith(['p-a']));
		// The fake serves the events the first pass appended, exactly as a
		// committed transaction would — so the second evaluation folds a log
		// whose phase has already ended.
		expect(await evaluateLeagueClock(harness.gateway)).toEqual(NOTHING_DUE);
		expect(harness.appendedEvents).toHaveLength(2);
		expect(harness.releasedClaims).toEqual([['p-a']]);
	});
});

describe('evaluateLeagueClock — the mention intents it owes (Story 5.3, AC1)', () => {
	it('mentions every Manager of every Team when Contract Assignment opens', async () => {
		// The matrix's “The phase opens” row, and the `deferred-work.md` item
		// from spec 3.7 this closes: the phase ends for the whole league at once
		// and, until now, was stated only to a Manager who happened to open the
		// app. `ContractAssignmentOpened` carries a NULL `team_id`, so the
		// affected set could never have come off the event.
		const harness = fakeGateway({
			events: [opened(), nominated(2, 'p-a', 'Ausar Bright', 't-1', 'Lakers', 'm-1')]
		});

		await evaluateLeagueClock(harness.gateway);

		const opening = harness.outboxIntents.filter(
			(intent) => intent.eventSeq === harness.outboxIntents.at(-1)?.eventSeq
		);
		expect(opening.map((intent) => intent.recipient)).toEqual([
			'#channel',
			'discord-t-one',
			'discord-t-two'
		]);
	});

	it('mentions nobody for an AuctionTerminated', async () => {
		// It carries no Team, it is one row per unbid nomination, and the phase
		// notice every Manager receives already states how many there were. It
		// is also outside the broadcast set, so it owes no intent at all.
		const harness = fakeGateway({
			events: [opened(), nominated(2, 'p-a', 'Ausar Bright', 't-1', 'Lakers', 'm-1')]
		});

		await evaluateLeagueClock(harness.gateway);

		const terminatedSeq = harness.appendedEvents.find(
			(row) => row['event_type'] === AUCTION_TERMINATED_EVENT
		)?.['seq'];
		expect(
			harness.outboxIntents.filter((intent) => intent.eventSeq === String(terminatedSeq))
		).toEqual([]);
	});
});

describe('evaluateLeagueClock — a contested Auction that will not close (AC7)', () => {
	/**
	 * `p-stuck` took a real Bid; `p-unbid` never did. This is exactly the log a
	 * close that keeps throwing leaves behind, pass after pass.
	 */
	const CONTESTED_AND_UNBID = [
		opened(),
		nominated(2, 'p-stuck', 'Ausar Bright', 't-1', 'Lakers', 'm-1'),
		nominated(3, 'p-unbid', 'Malik Rowe', 't-2', 'Celtics', 'm-2'),
		bidOn(4, 'p-stuck', 8_000_000)
	];

	it('terminates only the unbid Player, ends the phase, and frees only that claim', async () => {
		const harness = fakeGateway({ events: CONTESTED_AND_UNBID });

		const outcome = await evaluateLeagueClock(harness.gateway);

		expect(outcome).toEqual(endedWith(['p-unbid']));
		expect(harness.appendedEvents.map((row) => row['event_type'])).toEqual([
			AUCTION_TERMINATED_EVENT,
			CONTRACT_ASSIGNMENT_OPENED_EVENT
		]);
		// The contested Team's claim row is KEPT: its nomination is still open,
		// the sweep keeps retrying that close, and a close is not phase-gated,
		// so the rightful winner can still be awarded afterwards. Deleting it
		// would let another Team nominate into a Slot that is still held.
		expect(harness.releasedClaims).toEqual([['p-unbid']]);
	});
});

describe('evaluateLeagueClock — a failure appends nothing', () => {
	it('rolls back and rethrows when an append fails mid-transaction', async () => {
		const harness = fakeGateway({
			events: [
				opened(),
				nominated(2, 'p-a', 'Ausar Bright', 't-1', 'Lakers', 'm-1'),
				nominated(3, 'p-b', 'Malik Rowe', 't-2', 'Celtics', 'm-2')
			]
		});

		// Break the second insert, so the failure lands between two events of
		// one transaction — the exact shape the ordering argument is about.
		const realQuery = harness.client.query.bind(harness.client);
		let appends = 0;
		harness.client.query = async (text: string, params?: readonly unknown[]) => {
			if (/^insert into auction_events/i.test(text.trim())) {
				appends += 1;
				if (appends === 2) throw new Error('the log is unwritable');
			}
			return await realQuery(text, params ?? []);
		};

		await expect(evaluateLeagueClock(harness.gateway)).rejects.toThrow('the log is unwritable');

		expect(harness.state.rolledBack).toBe(true);
		expect(harness.state.committed).toBe(false);
		// Nothing partial survives: no lone termination, and above all no
		// `ContractAssignmentOpened` without the terminations before it.
		expect(harness.appendedEvents).toHaveLength(0);
		expect(harness.releasedClaims).toEqual([]);
	});
});
