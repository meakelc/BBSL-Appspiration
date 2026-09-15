/**
 * AD-11, proved twice over: the sequential sweep gets §10 example 17's answer,
 * and the batch shape gets a different one and is wrong (Story 3.5).
 *
 * The scenario is example 17's, driven end to end through the real
 * `closeAuction` rather than through a fake closer: Team M has ONE free Minor
 * League Slot and wins TWO Minor League Eligible Players whose Auctions expire
 * in order. The first stashes into the third Slot at a `$0` Cap Hit; the
 * second overflows into Active/Bench at the full winning amount — and it does
 * so ONLY because the first close was committed before the second was
 * evaluated.
 *
 * **The second half of this file is the point.** "Fold once, close many" is
 * the defect AD-11 names, and a story that merely avoided it would leave
 * nothing failing if somebody reintroduced it. So the batch shape is built
 * here explicitly — one loaded snapshot, two decisions — and asserted to place
 * BOTH Players in minors, which is the wrong answer and the one this design
 * exists to make unreachable.
 *
 * The stateful fake `ConnectionGateway` is `tests/server/close.test.ts`'s, with
 * the sweep's own two statements added: the bare clock read and the heartbeat
 * insert. It still throws on anything it does not recognise.
 */

import { describe, expect, it } from 'vitest';

import { CORE_VERSION } from '../../src/lib/core/constants.ts';
import { BID_CANCELLED_EVENT, BID_PLACED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import { MINOR_LEAGUE_ELIGIBILITY_SET } from '../../src/lib/core/projection/eligibility.ts';
import {
	AUCTION_CLOSED_EVENT,
	NOMINATION_PLACED_EVENT
} from '../../src/lib/core/projection/nominations.ts';
import { decideClose } from '../../src/lib/core/rules/close.ts';
import type { AuctionClosedPayload, BidCancelledPayload } from '../../src/lib/core/rules/close.ts';
import { closeAuction, loadCloseState } from '../../src/lib/server/close.ts';
import { runTick } from '../../src/lib/server/sweep.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

/** Noon: both Auctions below are long past their close instants. */
const NOW = new Date('2026-08-27T12:00:00.000Z');

/** The Auction that expires FIRST, whose id sorts LAST. */
const FIRST = { id: 'p-9', closesAt: '2026-08-27T08:00:00.000Z', amount: 4_000_000 };
/** The Auction that expires SECOND, whose id sorts FIRST. */
const SECOND = { id: 'p-2', closesAt: '2026-08-27T09:00:00.000Z', amount: 3_000_000 };

/**
 * Team M's imported roster: nine Active/Bench contracts and TWO occupied Minor
 * League Slots, so exactly one of the three is free. That single free Slot is
 * what the two wins below compete for.
 */
const ROSTER: QueryResultRow[] = [
	...Array.from({ length: 9 }, () => ({ cap_hit: '1000000', roster_slot_kind: 'active_bench' })),
	{ cap_hit: '30000000', roster_slot_kind: 'minor_league' },
	{ cap_hit: '20000000', roster_slot_kind: 'minor_league' }
];

let nextSeq = 0;

function logEvent(type: string, payload: unknown): QueryResultRow {
	nextSeq += 1;
	return {
		seq: nextSeq,
		occurred_at: new Date('2026-08-26T09:00:00.000Z'),
		schema_version: 1,
		// This tick's own version: the sweep fail-stops on a mismatch
		// (AD-20), so a fixture pinned to a literal would break on the next
		// bump for a reason that has nothing to do with sequencing.
		core_version: CORE_VERSION,
		manager_id: 'm-m',
		team_id: 't-m',
		event_type: type,
		payload
	};
}

/** The log both halves of this file start from: two eligible Players, two Bids. */
function startingLog(): QueryResultRow[] {
	nextSeq = 0;
	const rows: QueryResultRow[] = [];
	for (const auction of [FIRST, SECOND]) {
		rows.push(
			logEvent(NOMINATION_PLACED_EVENT, {
				fantraxPlayerId: auction.id,
				playerName: `Player ${auction.id}`,
				teamId: 't-n',
				teamName: 'Team N',
				managerId: 'm-n'
			})
		);
		rows.push(
			logEvent(BID_PLACED_EVENT, {
				fantraxPlayerId: auction.id,
				teamId: 't-m',
				teamName: 'Team M',
				managerId: 'm-m',
				amount: auction.amount,
				closesAt: auction.closesAt
			})
		);
		rows.push(
			logEvent(MINOR_LEAGUE_ELIGIBILITY_SET, {
				fantraxPlayerId: auction.id,
				playerName: `Player ${auction.id}`,
				before: false,
				after: true
			})
		);
	}
	return rows;
}

/**
 * The Teams `EVERY_TEAM` resolves to in this fake's league (Story 5.3).
 *
 * A constant rather than an option, because the one trigger that reaches it
 * is `ContractAssignmentOpened` and what matters about it is that the enqueue
 * asked the whole-league question at all.
 */
const EVERY_LEAGUE_TEAM: readonly string[] = ['t-one', 't-two'];

function fakeGateway(seed: QueryResultRow[], roster: QueryResultRow[] = ROSTER) {
	const order: string[] = [];
	const appendedEvents: QueryResultRow[] = [];
	const heartbeats: unknown[][] = [];
	let committedThrough = 0;
	let seq = 100;

	/**
	 * The delivery intents this transaction filed (Story 5.3): the event they
	 * describe and who they address. Recorded rather than merely tolerated, so
	 * “this write mentioned exactly these Teams” is observable.
	 */
	const outboxIntents: Array<{ eventSeq: string; recipient: string }> = [];

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, params: readonly unknown[] = []) {
			const sql = text.trim();
			if (/^select now\(\) as now$/i.test(sql)) {
				order.push('clock');
				return { rows: [{ now: NOW }] };
			}
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
				return { rows: [...seed, ...appendedEvents] };
			}
			// Matched on the TABLE rather than on the column list: Story 4.5
			// widened this select to carry the Player id and name the Team
			// view's roster listing needs from the same one read.
			if (/from team_rosters/i.test(sql)) {
				order.push('read-roster');
				return { rows: roster };
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
			if (/^delete from open_nominations/i.test(sql)) {
				order.push('release-claim');
				return { rows: [] };
			}
			// The Slot claim, keyed on the winning Team (FR-9 amended): a close
			// frees the board seat and the WINNER's Nomination Slot, and the two
			// are separate deletes because they key on different things.
			if (/^delete from nomination_slots/i.test(sql)) {
				order.push('release-slot');
				return { rows: [] };
			}
			if (/^insert into tick_heartbeats/i.test(sql)) {
				order.push('heartbeat');
				heartbeats.push([...params]);
				return { rows: [] };
			}
			if (/^commit/i.test(sql)) {
				order.push('commit');
				committedThrough = appendedEvents.length;
				return { rows: [] };
			}
			if (/^rollback/i.test(sql)) {
				order.push('rollback');
				// A real ROLLBACK discards this transaction's uncommitted writes
				// and leaves every earlier COMMIT alone — which is the whole
				// property "each close in its own transaction" buys.
				appendedEvents.length = committedThrough;
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
				return { rows: [{ discord_user_id: `discord-${String(params[0])}` }] };
			}
			if (/^select coalesce\(.+\)\s+as discord_user_id\s+from managers\s+where team_id is not null/i.test(sql)) {
				return {
					rows: EVERY_LEAGUE_TEAM.map((teamId) => ({ discord_user_id: `discord-${teamId}` }))
				};
			}
			if (/^insert into notification_outbox/i.test(sql)) {
				outboxIntents.push({
					eventSeq: String(params[0]),
					recipient: String(params[2])
				});
				return { rows: [] };
			}
			throw new Error(`unexpected statement: ${sql}`);
		},
		release() {
			/* one client, reused — nothing to pool in a fake */
		}
	};

	const gateway: ConnectionGateway = { connect: async () => client };

	return { gateway, client, order, appendedEvents, heartbeats, outboxIntents };
}

/** The `AuctionClosed` payloads appended, in the order they were appended. */
function closedPayloads(appended: QueryResultRow[]): AuctionClosedPayload[] {
	return appended
		.filter((row) => row['event_type'] === AUCTION_CLOSED_EVENT)
		.map((row) => row['payload'] as AuctionClosedPayload);
}

describe('the sequential sweep — AD-11 through the real closeAuction', () => {
	it('stashes the FIRST win in minors at $0 and overflows the SECOND into Active/Bench', async () => {
		const harness = fakeGateway(startingLog());

		const summary = await runTick({
			gateway: harness.gateway,
			closeOne: (fantraxPlayerId) => closeAuction(harness.gateway, fantraxPlayerId)
		});

		// The order is the CLOSE order, not the id order: `p-9` expires an hour
		// before `p-2` and closes first despite sorting last.
		expect(summary.closed).toEqual([FIRST.id, SECOND.id]);

		const payloads = closedPayloads(harness.appendedEvents);
		expect(payloads).toHaveLength(2);

		expect(payloads[0]?.fantraxPlayerId).toBe(FIRST.id);
		expect(payloads[0]?.placement).toBe('minor_league');
		expect(payloads[0]?.winningAmount).toBe(FIRST.amount);
		// The stash costs nothing against the Cap (FR-35, §10 example 16).
		expect(payloads[0]?.capHit).toBe(0);

		expect(payloads[1]?.fantraxPlayerId).toBe(SECOND.id);
		// The overflow, and it happens ONLY because the close above was
		// committed before this one was evaluated (§10 example 17).
		expect(payloads[1]?.placement).toBe('active_bench');
		expect(payloads[1]?.winningAmount).toBe(SECOND.amount);
		expect(payloads[1]?.capHit).toBe(SECOND.amount);
	});

	it('runs each close in its OWN transaction, committed before the next begins', async () => {
		const harness = fakeGateway(startingLog());

		await runTick({
			gateway: harness.gateway,
			closeOne: (fantraxPlayerId) => closeAuction(harness.gateway, fantraxPlayerId)
		});

		expect(harness.order).toEqual([
			// The sweep's own unlocked read.
			'clock',
			'read-log',
			// The first close: a whole transaction.
			'begin',
			'lock',
			'read-log',
			// TWO roster reads since Story 10.4: the WINNER's, then ONE batched
			// read over every Team holding a Bid — the candidates FR-40's
			// restorer re-validates.
			'read-roster',
			'read-roster',
			'append-event',
			'release-claim',
			// The winner's Nomination Slot, freed by the win itself (FR-8
			// amended) — a second delete, keyed on the Team rather than the
			// Player, inside the same transaction.
			'release-slot',
			'commit',
			// The second, which re-folds a log that now contains the first.
			'begin',
			'lock',
			'read-log',
			'read-roster',
			'read-roster',
			'append-event',
			'release-claim',
			'release-slot',
			'commit',
			// One heartbeat, last.
			'heartbeat'
		]);
	});

	it('gives the core each Auction’s OWN expiry while the row records when it landed', async () => {
		// The sweep runs at noon, hours after both Auctions were due. The
		// payloads must be what an on-time close would have produced.
		const harness = fakeGateway(startingLog());

		await runTick({
			gateway: harness.gateway,
			closeOne: (fantraxPlayerId) => closeAuction(harness.gateway, fantraxPlayerId)
		});

		const payloads = closedPayloads(harness.appendedEvents);
		expect(payloads[0]?.closedAt).toBe(FIRST.closesAt);
		expect(payloads[1]?.closedAt).toBe(SECOND.closesAt);
		// ...while `occurred_at` is the transaction clock, which is noon.
		for (const row of harness.appendedEvents) {
			expect(row['occurred_at']).toBe(NOW);
		}
	});

	it('appends a payload byte-identical to the one an on-time close would append', async () => {
		// AD-10's "late, not wrong", as an equality rather than an argument.
		// The same close, at a clock one minute past the Auction's own expiry
		// instead of four hours past it.
		const late = fakeGateway(startingLog());
		await closeAuction(late.gateway, FIRST.id);

		const onTimeSeed = startingLog();
		const onTime = fakeGateway(onTimeSeed);
		// Re-point the fake's clock by closing through the same path; the only
		// thing that differs is what `now()` answers, which reaches the payload
		// nowhere.
		const onTimeClient = onTime.client;
		const originalQuery = onTimeClient.query.bind(onTimeClient);
		onTimeClient.query = async (text: string, params?: readonly unknown[]) => {
			if (/pg_advisory_xact_lock/i.test(text.trim())) {
				return { rows: [{ locked: true, now: new Date(FIRST.closesAt) }] };
			}
			return await originalQuery(text, params);
		};
		await closeAuction(onTime.gateway, FIRST.id);

		const [latePayload] = closedPayloads(late.appendedEvents);
		const [onTimePayload] = closedPayloads(onTime.appendedEvents);
		expect(JSON.stringify(latePayload)).toBe(JSON.stringify(onTimePayload));
		// ...and only the row's own clock differs.
		expect(late.appendedEvents[0]?.['occurred_at']).toEqual(NOW);
		expect(onTime.appendedEvents[0]?.['occurred_at']).toEqual(new Date(FIRST.closesAt));
	});
});

describe('the BATCH shape — one snapshot, two decisions — gets it wrong', () => {
	it('places BOTH eligible wins in minors, which is the AD-11 defect', async () => {
		// "Fold once, close many": load the state for both Auctions against the
		// SAME pre-close log, then decide both. This is the shape the design
		// forbids, written out so that reintroducing it fails a test rather
		// than merely being discouraged in a comment.
		const harness = fakeGateway(startingLog());
		const client = harness.client;

		const firstState = await loadCloseState(client, FIRST.id);
		const secondState = await loadCloseState(client, SECOND.id);

		// Both snapshots saw the same roster: two Minor League Slots occupied,
		// one free. Neither can see the other's win, because neither happened.
		expect(firstState.minorLeagueOccupied).toBe(2);
		expect(secondState.minorLeagueOccupied).toBe(2);

		const batch = [
			decideClose(firstState, FIRST.closesAt, null),
			decideClose(secondState, SECOND.closesAt, null)
		].map((accepted) => accepted.events[0]?.payload as AuctionClosedPayload);

		// The wrong answer: one free Slot, two Players stashed into it, and
		// neither win charged against the Cap.
		expect(batch.map((payload) => payload.placement)).toEqual(['minor_league', 'minor_league']);
		expect(batch.map((payload) => payload.capHit)).toEqual([0, 0]);

		// Nothing was appended: the batch above never went through a
		// transaction. It is the arithmetic that is being proven wrong, not a
		// write path.
		expect(harness.appendedEvents).toEqual([]);
	});

	it('disagrees with the sequential sweep about the SECOND win, which is the whole point', async () => {
		const sequential = fakeGateway(startingLog());
		await runTick({
			gateway: sequential.gateway,
			closeOne: (fantraxPlayerId) => closeAuction(sequential.gateway, fantraxPlayerId)
		});
		const sequentialSecond = closedPayloads(sequential.appendedEvents)[1];

		const batched = fakeGateway(startingLog());
		const batchedSecondState = await loadCloseState(batched.client, SECOND.id);
		const batchedSecond = decideClose(batchedSecondState, SECOND.closesAt, null).events[0]
			?.payload as AuctionClosedPayload;

		expect(sequentialSecond?.placement).toBe('active_bench');
		expect(batchedSecond.placement).toBe('minor_league');
		expect(sequentialSecond?.capHit).toBe(SECOND.amount);
		expect(batchedSecond.capHit).toBe(0);
		// The two shapes produce different contracts for the same Auction. Only
		// one of them can be right, and AD-11 says which.
		expect(sequentialSecond?.placement).not.toBe(batchedSecond.placement);
	});
});


// --- AD-11 with a cascade in it (Story 10.3, FR-40) -----------------------

/**
 * Team M with ELEVEN Active/Bench contracts: Free Active/Bench Slots 1, and
 * one win takes it to 0. The roster above is deliberately unusable here.
 */
const FULL_ROSTER: QueryResultRow[] = Array.from({ length: 11 }, () => ({
	cap_hit: '1000000',
	roster_slot_kind: 'active_bench'
}));

/**
 * The same two overdue Auctions, both NON-eligible and both led by Team M —
 * so the first win fills its last Slot and FR-40 has to take the second back.
 *
 * A different nominating Team for each: `nominationsReducer` holds one
 * Nomination Slot per Team.
 */
function twoLeadsLog(): QueryResultRow[] {
	nextSeq = 0;
	const rows: QueryResultRow[] = [];
	for (const [index, auction] of [FIRST, SECOND].entries()) {
		rows.push(
			logEvent(NOMINATION_PLACED_EVENT, {
				fantraxPlayerId: auction.id,
				playerName: `Player ${auction.id}`,
				teamId: `t-n${String(index)}`,
				teamName: `Team N${String(index)}`,
				managerId: `m-n${String(index)}`
			})
		);
		rows.push(
			logEvent(BID_PLACED_EVENT, {
				fantraxPlayerId: auction.id,
				teamId: 't-m',
				teamName: 'Team M',
				managerId: 'm-m',
				amount: auction.amount,
				closesAt: auction.closesAt
			})
		);
	}
	return rows;
}

describe('the sequential sweep — a cancellation commits before the next close', () => {
	it('closes the FIRST, cancels the Bid on the SECOND, and does not award it', async () => {
		// AD-11 is now load-bearing rather than merely correct. Team M's win
		// on `p-9` fills its twelfth Slot, so the cascade cancels its Bid on
		// `p-2` inside that same transaction — and `p-2` is then offered to a
		// close with no Leading Bidder and refuses. A batched fold, closing
		// both against one snapshot, would have handed Team M a thirteenth
		// Player, which is the exact invariant the roster ceiling exists to
		// protect.
		const harness = fakeGateway(twoLeadsLog(), FULL_ROSTER);

		const summary = await runTick({
			gateway: harness.gateway,
			closeOne: (fantraxPlayerId) => closeAuction(harness.gateway, fantraxPlayerId)
		});

		expect(summary.closed).toEqual([FIRST.id]);
		expect(summary.failures.map((failure) => failure.fantraxPlayerId)).toEqual([SECOND.id]);
		expect(summary.failures[0]?.message).toMatch(/no Leading Bidder/);

		// One close and one cancellation, in that order, and no second close.
		expect(harness.appendedEvents.map((row) => row['event_type'])).toEqual([
			AUCTION_CLOSED_EVENT,
			BID_CANCELLED_EVENT
		]);
		const cancelled = harness.appendedEvents[1]?.['payload'] as BidCancelledPayload;
		expect(cancelled.fantraxPlayerId).toBe(SECOND.id);
		expect(cancelled.causeFantraxPlayerId).toBe(FIRST.id);
		expect(cancelled.amount).toBe(SECOND.amount);
	});

	it('commits the cancellation inside the FIRST close’s own transaction', async () => {
		// Both appends land between one `begin` and one `commit`: the
		// cancellation is not a second transaction that could be lost while
		// the close it compensates for stood.
		const harness = fakeGateway(twoLeadsLog(), FULL_ROSTER);
		await runTick({
			gateway: harness.gateway,
			closeOne: (fantraxPlayerId) => closeAuction(harness.gateway, fantraxPlayerId)
		});

		const firstBegin = harness.order.indexOf('begin');
		const firstCommit = harness.order.indexOf('commit');
		const appends = harness.order
			.map((statement, index) => ({ statement, index }))
			.filter((entry) => entry.statement === 'append-event');

		expect(appends).toHaveLength(2);
		for (const append of appends) {
			expect(append.index).toBeGreaterThan(firstBegin);
			expect(append.index).toBeLessThan(firstCommit);
		}
	});
});
