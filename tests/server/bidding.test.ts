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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AUCTION_CLOCK, SALARY_CAP } from '../../src/lib/core/constants.ts';
import { AUCTION_EXPIRED, BID_PLACED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import {
	AUCTION_CLOSED_EVENT,
	NOMINATION_PLACED_EVENT
} from '../../src/lib/core/projection/nominations.ts';
import { MINOR_LEAGUE_ELIGIBILITY_SET } from '../../src/lib/core/projection/eligibility.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { hash } from '../../src/lib/core/hash.ts';
import { bidRefusalDetail } from '../../src/lib/core/rules/bidding.ts';
import type { BidPlacedPayload } from '../../src/lib/core/rules/bidding.ts';
import { PLACE_BID_GATES } from '../../src/lib/core/types.ts';
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
	/**
	 * The sealed seed rows this transaction wrote (Story 3.2).
	 *
	 * Recorded rather than merely tolerated, so "no seed row on a raise" is
	 * observable rather than assumed — the fake throws on any statement it
	 * does not recognise, which is what makes the absence provable.
	 */
	let seedRows: unknown[][] = [];
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
			if (/^insert into auction_contention_seeds/i.test(sql)) {
				order.push('append-seed');
				seedRows.push([...queryParams]);
				return { rows: [] };
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
				// too, or "nothing was written" would be trivially true. The
				// seed row is discarded on the same terms: it is written
				// inside the appending transaction, so it cannot survive one
				// that rolls back.
				appendedEvents.length = 0;
				seedRows = [];
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
		get seedRows() {
			return seedRows;
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

function nominated(
	seq = 1,
	fantraxPlayerId = 'p-1',
	/** The name a refusal says out loud — `playerNameFor`'s source (Story 2.8). */
	playerName = 'Jalen Green',
	/**
	 * The NOMINATING Team, which must differ per Player: `nominationsReducer`
	 * drops a second nomination from a Team that already holds one, so two
	 * Players on the board need two nominators.
	 */
	teamId = 't-9'
): QueryResultRow {
	return logEvent(seq, NOMINATION_PLACED_EVENT, {
		fantraxPlayerId,
		playerName,
		teamId,
		teamName: teamId === 't-9' ? 'Celtics' : 'Bulls',
		managerId: teamId === 't-9' ? 'm-9' : 'm-8'
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
			'contention',
			'expiry',
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

	it('refuses a CONVERSION into a live contention, by name and appending nothing', async () => {
		// Story 2.5 refused the opening at exactly $1,000,000 here, because no
		// lottery could be run. Story 3.2 runs one — so the refusal by name
		// moved to the conversion, which is the half that cannot be done yet:
		// dissolution releases every Contender and reveals the seed (3.3).
		const harness = fakeGateway({
			events: [nominated(), bidLogged(2, 1_000_000, 't-1', 'm-1')]
		});

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(2_000_000),
			DEVICE_CLASS
		);

		expect(rejectionOf(outcome).detail).toContain('Minimum-Bid Contention');
		expect(rejectionOf(outcome).detail).toContain('convert');
		expect(harness.appendedEvents).toHaveLength(0);
		expect(harness.seedRows).toHaveLength(0);
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
			// Story 3.1: the persisted absolute close instant, folded from the
			// SAME log read and narrowed by the same `bidStateFor` — which is
			// why expiry-as-authority cost this transaction no second query
			// and no plumbing at all.
			closesAt: '2026-08-27T09:00:00.000Z',
			// Story 3.2: the fold's own contention state and Contender list,
			// off the SAME log read again. An $8.0M lead is Standard
			// Contention and has no Contenders, so the list is genuinely
			// empty rather than absent.
			contention: 'standard',
			contenders: [],
			team: {
				capSpace: 156_000_000,
				rosterCount: 9,
				leading: [],
				// Story 2.8's two Team facts, off the same single roster read
				// and the same single log read. Raw occupancy, never `M`.
				eligibleLeading: [],
				minorLeagueOccupied: 0
			},
			// The eligibility FOLD's answer about the Player being bid on —
			// no `select minor_league_eligible` was issued, which is why the
			// statement order below is still exactly two reads.
			playerIsMinorLeagueEligible: false
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
			leading: [],
			eligibleLeading: [],
			minorLeagueOccupied: 0
		});
	});
});

// --- Story 2.8: an overflow refusal under the lock -------------------------

describe('placeBid — Minors Exposure refuses under the lock, and writes nothing', () => {
	/**
	 * A roster of nine $1.0M Active/Bench contracts PLUS two Minor League
	 * rows, so `minorLeagueOccupied` is 2 and `M = 3 − 2 = 1`.
	 *
	 * The Minor League contracts carry a real Cap Hit in the file and count
	 * against neither the Cap nor Roster Count — `computeCapSpace` owns the
	 * first half and `loadTeamRoster`'s counter the second — so $50,000,000
	 * of stashed salary moves neither figure. What they change is occupancy,
	 * which is the only new fact this story reads.
	 *
	 * The eleven Active/Bench contracts are example 19's own setup, arriving
	 * through the table rather than as a literal: Roster Count 11 and
	 * $2,000,000 of room.
	 */
	const TWO_STASHED: QueryResultRow[] = [
		...Array.from({ length: 10 }, () => ({
			cap_hit: '1000000',
			roster_slot_kind: 'active_bench'
		})),
		{ cap_hit: '153000000', roster_slot_kind: 'active_bench' },
		{ cap_hit: '30000000', roster_slot_kind: 'minor_league' },
		{ cap_hit: '20000000', roster_slot_kind: 'minor_league' }
	];

	/** $165.0M − $163.0M of Active/Bench Cap Hits — example 19's own room. */
	const CAP_SPACE = SALARY_CAP - 163_000_000;

	/** `t-2` is Minor League Eligible on both Players, by fold and not by column. */
	function eligible(seq: number, fantraxPlayerId: string): QueryResultRow {
		return logEvent(seq, MINOR_LEAGUE_ELIGIBILITY_SET, {
			fantraxPlayerId,
			playerName: fantraxPlayerId === 'p-stash' ? 'Ausar Bright' : 'Second Prospect',
			before: false,
			after: true
		});
	}

	/**
	 * The log Team `t-2` bids into: it already leads an OPEN eligible Auction
	 * at $30.0M, and a second eligible Player is nominated with no Bid yet.
	 */
	const OVERFLOWING: QueryResultRow[] = [
		nominated(1, 'p-stash', 'Ausar Bright', 't-9'),
		nominated(2, 'p-second', 'Second Prospect', 't-8'),
		eligible(3, 'p-stash'),
		eligible(4, 'p-second'),
		logEvent(
			5,
			BID_PLACED_EVENT,
			{
				fantraxPlayerId: 'p-stash',
				teamId: 't-2',
				teamName: 'Rockets',
				managerId: 'm-2',
				amount: 30_000_000,
				closesAt: '2026-08-27T09:00:00.000Z'
			},
			'2026-08-26T09:00:00.000Z',
			{ managerId: 'm-2', teamId: 't-2' }
		)
	];

	it('folds the eligible lead and the roster occupancy from the same locked read', async () => {
		const harness = fakeGateway({ events: OVERFLOWING, roster: TWO_STASHED });
		await harness.client.query('begin');

		const loaded = await loadBidState(harness.client, 'p-second', 't-2');

		// The eligible lead is PARTITIONED, not dropped: it is out of
		// `leading` and into `eligibleLeading`, carrying the name a refusal
		// will use.
		expect(loaded.bid.team?.leading).toEqual([]);
		expect(loaded.bid.team?.eligibleLeading).toEqual([
			{ fantraxPlayerId: 'p-stash', playerName: 'Ausar Bright', amount: 30_000_000 }
		]);
		// Occupancy from `team_rosters`; Cap Space and Roster Count unmoved by
		// the two Minor League contracts.
		expect(loaded.bid.team?.minorLeagueOccupied).toBe(2);
		expect(loaded.bid.team?.capSpace).toBe(CAP_SPACE);
		expect(loaded.bid.team?.rosterCount).toBe(11);
		// The Auction's own eligibility, from the same fold.
		expect(loaded.bid.playerIsMinorLeagueEligible).toBe(true);
		// Still ONE log read and ONE roster read, both after the lock.
		expect(harness.order).toEqual(['begin', 'read-log', 'read-roster']);
	});

	it('refuses the later Bid with the transaction’s own gate set and clock', async () => {
		const harness = fakeGateway({ events: OVERFLOWING, roster: TWO_STASHED });

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-second',
			parseMoney(1_500_000),
			DEVICE_CLASS
		);

		const rejection = rejectionOf(outcome);
		expect(rejection.refusal.kind).toBe('gates');
		// FR-13: the figures the Bid was actually judged against, at the
		// instant the lock held them — not the ones some page rendered.
		expect(rejection.at).toBe(NOW.toISOString());
		expect(rejection.gates).not.toBeNull();
		expect(rejection.gates?.cap.overflowCount).toBe(1);
		expect(rejection.gates?.cap.freeMinorLeagueSlots).toBe(1);
		expect(rejection.gates?.cap.eligibleLeadingBids).toBe(2);
		expect(rejection.gates?.cap.minorsExposure).toBe(30_000_000);
		expect(rejection.gates?.cap.maximumBid).toBe(CAP_SPACE - 30_000_000);
		expect(rejection.gates?.cap.passed).toBe(false);
		// Capacity is NOT the ground — 11 + 1 = 12 — which is what isolates
		// Minors Exposure, and is reported beside the refusal rather than
		// left for a reader to wonder about.
		expect(rejection.gates?.slots.passed).toBe(true);
		expect(rejection.gates?.slots.overflowCount).toBe(1);
		// The sentence names the earlier Auction by Player and amount.
		expect(rejection.detail).toContain('Ausar Bright');
		expect(rejection.detail).toContain('$30.0M');

		// The roster and the folds were read AFTER the lock, and nothing was
		// appended: the log holds only what it held before.
		expect(harness.order.slice(0, 4)).toEqual(['begin', 'lock', 'read-log', 'read-roster']);
		expect(harness.order).not.toContain('append-event');
		expect(harness.appendedEvents).toHaveLength(0);
		expect(harness.state.committed).toBe(false);
	});

	it('leaves the earlier accepted Bid exactly where it was', async () => {
		const harness = fakeGateway({ events: OVERFLOWING, roster: TWO_STASHED });

		await placeBid(harness.gateway, ACTOR, 'p-second', parseMoney(1_500_000), DEVICE_CLASS);

		// An accepted Bid is never retroactively invalidated: only the new one
		// is refused. Re-loading proves the $30.0M lead is untouched, and that
		// it is still exactly what the exposure was computed from.
		await harness.client.query('begin');
		const loaded = await loadBidState(harness.client, 'p-second', 't-2');
		expect(loaded.bid.team?.eligibleLeading).toEqual([
			{ fantraxPlayerId: 'p-stash', playerName: 'Ausar Bright', amount: 30_000_000 }
		]);
	});
});

// --- Story 3.1: expiry, re-derived under the lock -------------------------

describe('placeBid — an expired Auction is refused under the lock (AC7)', () => {
	/**
	 * A Player nominated and bid on, whose close instant is in the PAST
	 * relative to the transaction clock — and no `AuctionClosed` anywhere.
	 *
	 * That combination is the whole point: the nomination fold still holds
	 * the Player, so `no_open_auction` does not fire and the gates actually
	 * run; the Auction fold still holds the price, so a projection asked
	 * "is this open" would say yes. The only thing that has happened is that
	 * the clock ran out and Story 3.5's sweep has not recorded it.
	 */
	const EXPIRED = [
		nominated(1),
		logEvent(
			2,
			BID_PLACED_EVENT,
			{
				fantraxPlayerId: 'p-1',
				teamId: 't-1',
				teamName: 'Lakers',
				managerId: 'm-1',
				amount: 8_000_000,
				// NOW is 2026-08-26T12:00:00.000Z, so this closed an hour ago.
				closesAt: '2026-08-26T11:00:00.000Z'
			},
			'2026-08-25T11:00:00.000Z',
			{ managerId: 'm-1', teamId: 't-1' }
		)
	];

	it('refuses with the transaction’s own gate set and stamp, appending nothing', async () => {
		const harness = fakeGateway({ events: EXPIRED });

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(8_500_000),
			DEVICE_CLASS
		);

		const rejection = rejectionOf(outcome);
		expect(rejection.refusal.kind).toBe('gates');
		expect(rejection.gates?.expiry.passed).toBe(false);
		// The close instant was folded AFTER the lock, and compared against
		// the transaction-start clock the lock itself returned.
		expect(rejection.gates?.expiry.closesAt).toBe('2026-08-26T11:00:00.000Z');
		expect(rejection.gates?.expiry.evaluatedAt).toBe(NOW.toISOString());
		expect(rejection.at).toBe(NOW.toISOString());
		// The full gate set, not only the refusing one — the other six report
		// their own arithmetic and none of them is the ground here.
		expect(Object.keys(rejection.gates ?? {}).sort()).toEqual([...PLACE_BID_GATES].sort());
		expect(rejection.gates?.cap.passed).toBe(true);
		expect(rejection.gates?.slots.passed).toBe(true);
		expect(rejection.gates?.increment.passed).toBe(true);
		expect(rejection.detail).toContain(AUCTION_EXPIRED);

		// Locked, then read, then nothing.
		expect(harness.order.slice(0, 4)).toEqual(['begin', 'lock', 'read-log', 'read-roster']);
		expect(harness.order).not.toContain('append-event');
		expect(harness.appendedEvents).toHaveLength(0);
		expect(harness.state.committed).toBe(false);
	});

	it('leaves the earlier Bid exactly where it was', async () => {
		const harness = fakeGateway({ events: EXPIRED });

		await placeBid(harness.gateway, ACTOR, 'p-1', parseMoney(8_500_000), DEVICE_CLASS);

		await harness.client.query('begin');
		const loaded = await loadBidState(harness.client, 'p-1', 't-2');
		expect(loaded.bid.leadingBid).toEqual({ teamId: 't-1', amount: 8_000_000 });
		expect(loaded.bid.closesAt).toBe('2026-08-26T11:00:00.000Z');
	});

	it('is refused as expired, NOT as no_open_auction — the two are different questions', async () => {
		// The nomination fold still holds this Player: nothing closed it. So
		// the pre-gate check passes and the gate set runs, which is what
		// AD-12 asks for — expiry is decided by comparing instants, never by
		// reading whether a projection still holds an Auction row.
		const harness = fakeGateway({ events: EXPIRED });

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(8_500_000),
			DEVICE_CLASS
		);

		const rejection = rejectionOf(outcome);
		expect(rejection.refusal.kind).not.toBe('no_open_auction');
		expect(rejection.gates).not.toBeNull();
	});

	it('accepts the same Bid on the same Auction when its clock has NOT run out', async () => {
		const harness = fakeGateway({
			events: [
				nominated(1),
				logEvent(
					2,
					BID_PLACED_EVENT,
					{
						fantraxPlayerId: 'p-1',
						teamId: 't-1',
						teamName: 'Lakers',
						managerId: 'm-1',
						amount: 8_000_000,
						// One millisecond after NOW rather than one hour before.
						closesAt: '2026-08-26T12:00:00.001Z'
					},
					'2026-08-25T12:00:00.001Z',
					{ managerId: 'm-1', teamId: 't-1' }
				)
			]
		});

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(8_500_000),
			DEVICE_CLASS
		);

		expect(outcome.kind).toBe('accepted');
		expect(harness.appendedEvents).toHaveLength(1);
	});

	it('needed no executable change in server/bidding.ts to get any of this', () => {
		// The claim worth testing rather than asserting (Design Notes). The
		// transaction hands `decide()` the lock's own clock and hands
		// `bidStateFor` the folded `Auction` — both since Story 2.5 — so
		// expiry-as-authority arrived with no plumbing, no second query and
		// no migration.
		const source = readFileSync(
			fileURLToPath(new URL('../../src/lib/server/bidding.ts', import.meta.url)),
			'utf8'
		);

		// Asserting those two call sites are still present is necessary but
		// not sufficient: an executable edit that PRESERVED both substrings
		// would slide past it. So the claim itself is tested — with every
		// comment stripped, the remaining code must not name expiry at all.
		// `tests/routes/auction-page.test.ts`'s own discipline, for its
		// reason: prose ABOUT a thing is not that thing, and this file's
		// header explains expiry-as-authority at length precisely because the
		// code below it does not implement any of it.
		const code = source
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/(^|[^:])\/\/.*$/gm, '$1');

		expect(code).toContain('decide(state.bid, command, now.toISOString(), seed)');
		expect(code).toContain('bidStateFor(');
		// The whole vocabulary of the gate this module never learned about.
		// If any of it appears in executable code here, expiry stopped being
		// something the core decides from state this file already loaded.
		for (const forbidden of [
			/\bexpiry\b/i,
			/\bexpired\b/i,
			/hasExpired/,
			/AUCTION_EXPIRED/,
			/closesAt/,
			/closesInPhrase/,
			/evaluatedAt/,
			/parseInstant/
		]) {
			expect(code, String(forbidden)).not.toMatch(forbidden);
		}
		// And no clock of its own: `now` comes from the lock, never from Node.
		expect(code).not.toMatch(/new Date\(\)|Date\.now\(\)/);
		// The strip is doing real work — the header genuinely discusses all of
		// this, so a broken stripper would make the loop above vacuous by
		// failing rather than by passing. Stated so the guard cannot silently
		// become a no-op if the comments are ever moved.
		expect(source).toMatch(/\bexpiry\b/i);
		expect(code.length).toBeLessThan(source.length);
	});
});

// --- Story 3.2: the seed, sealed in the same transaction as the event ------

describe('placeBid — the lottery seed (AC5, AD-14)', () => {
	it('writes ONE seed row in the same transaction as the opening event', async () => {
		const harness = fakeGateway({ events: [nominated()] });

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(1_000_000),
			DEVICE_CLASS
		);

		expect(outcome.kind).toBe('accepted');
		expect(harness.appendedEvents).toHaveLength(1);
		expect(harness.seedRows).toHaveLength(1);
		// **Inside the transaction, before the commit.** The seed row and the
		// event commit together or neither does (AD-5), so a published
		// commitment with no seed behind it is unreachable by construction.
		expect(harness.order).toEqual([
			'begin',
			'lock',
			'read-log',
			'read-roster',
			'append-event',
			'append-seed',
			'commit'
		]);
	});

	it('keys the seed row on the Player and stamps it with the EVENT’s own instant', async () => {
		const harness = fakeGateway({ events: [nominated()] });

		await placeBid(harness.gateway, ACTOR, 'p-1', parseMoney(1_000_000), DEVICE_CLASS);

		const [fantraxPlayerId, seed, createdAt] = harness.seedRows[0] ?? [];
		expect(fantraxPlayerId).toBe('p-1');
		// 32 random bytes as lowercase hex — the alphabet a Manager verifying
		// the reveal by hand will be reading in.
		expect(seed).toMatch(/^[0-9a-f]{64}$/);
		// The database's transaction-start clock (AD-3), never a second read.
		expect(createdAt).toBe(NOW.toISOString());
	});

	it('publishes hash(seed) on the payload and the seed itself in NO event', async () => {
		const harness = fakeGateway({ events: [nominated()] });

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(1_000_000),
			DEVICE_CLASS
		);
		if (outcome.kind !== 'accepted') throw new Error('the Opening Bid was refused');

		const seed = String(harness.seedRows[0]?.[1]);
		const payload = outcome.events[0]?.payload as BidPlacedPayload;
		expect(payload.seedHash).toBe(hash(seed));

		// **The assertion AD-14 lives or dies on**, made against the whole
		// appended log rather than one field: the raw seed appears nowhere in
		// anything that reaches `auction_events`.
		expect(JSON.stringify(outcome.events)).not.toContain(seed);
		expect(JSON.stringify(harness.appendedEvents)).not.toContain(seed);
	});

	it('generates a DIFFERENT seed for every contention', async () => {
		const seeds = new Set<string>();
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const harness = fakeGateway({ events: [nominated()] });
			await placeBid(harness.gateway, ACTOR, 'p-1', parseMoney(1_000_000), DEVICE_CLASS);
			seeds.add(String(harness.seedRows[0]?.[1]));
		}
		expect(seeds.size).toBe(5);
	});

	it('writes NO seed row on an ordinary opening, a raise or a join', async () => {
		const cases: Array<[label: string, events: QueryResultRow[], amount: number]> = [
			['an opening above the minimum', [nominated()], 1_500_000],
			['a raise', [nominated(), bidLogged(2, 8_000_000)], 8_500_000],
			// A join into a contention another Team opened. It is accepted,
			// and it publishes nothing: the commitment was made when the
			// lottery opened and cannot be replaced.
			['a join', [nominated(), bidLogged(2, 1_000_000)], 1_000_000]
		];
		for (const [label, events, amount] of cases) {
			const harness = fakeGateway({ events });
			const outcome = await placeBid(
				harness.gateway,
				ACTOR,
				'p-1',
				parseMoney(amount),
				DEVICE_CLASS
			);

			expect(outcome.kind, label).toBe('accepted');
			expect(harness.appendedEvents, label).toHaveLength(1);
			expect(harness.seedRows, label).toHaveLength(0);
			expect(harness.order, label).not.toContain('append-seed');
			const payload = harness.appendedEvents[0]?.['payload'] as BidPlacedPayload;
			expect(Object.keys(payload), label).not.toContain('seedHash');
		}
	});

	it('writes NO seed row when the Bid is refused — the transaction rolled back', async () => {
		// A conversion into a live contention: refused on `contention`, so
		// `decide()` never reaches the payload and the projection never runs.
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 1_000_000)] });

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(2_000_000),
			DEVICE_CLASS
		);

		expect(outcome.kind).toBe('rejected');
		expect(harness.seedRows).toHaveLength(0);
		expect(harness.state.committed).toBe(false);
	});

	it('stamps the contention’s OWN close instant on a join, never a fresh one', async () => {
		// PRD §10 example 7, at the transaction. The contention opened at
		// 09:00 on the 26th and closes at 09:00 on the 27th; this join is
		// decided at the fake's clock of 12:00 on the 26th, and a fresh
		// 24-hour clock would have said 12:00 on the 27th.
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 1_000_000)] });

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(1_000_000),
			DEVICE_CLASS
		);
		if (outcome.kind !== 'accepted') throw new Error('the join was refused');

		const payload = outcome.events[0]?.payload as BidPlacedPayload;
		expect(payload.closesAt).toBe('2026-08-27T09:00:00.000Z');
		expect(payload.closesAt).not.toBe(
			new Date(NOW.getTime() + AUCTION_CLOCK).toISOString()
		);
	});

	it('computes a FRESH close for an opening and a raise, as it always has', async () => {
		for (const [label, events, amount] of [
			['an opening', [nominated()], 1_500_000],
			['a raise', [nominated(), bidLogged(2, 8_000_000)], 8_500_000]
		] as Array<[string, QueryResultRow[], number]>) {
			const harness = fakeGateway({ events });
			const outcome = await placeBid(
				harness.gateway,
				ACTOR,
				'p-1',
				parseMoney(amount),
				DEVICE_CLASS
			);
			if (outcome.kind !== 'accepted') throw new Error(`${label} was refused`);
			const payload = outcome.events[0]?.payload as BidPlacedPayload;
			expect(Date.parse(payload.closesAt) - NOW.getTime(), label).toBe(AUCTION_CLOCK);
		}
	});

	it('never reads the seed table — it is written and never selected from', () => {
		// `recordContentionSeed` is a WRITE-SIDE statement, exactly as
		// `claimNomination` is. Story 3.6's draw is the first reader, and it
		// reaches the row through the direct connection rather than through
		// this module.
		const source = readFileSync(
			fileURLToPath(new URL('../../src/lib/server/bidding.ts', import.meta.url)),
			'utf8'
		);
		const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
		expect(code).toContain('insert into ${CONTENTION_SEEDS_TABLE}');
		expect(code).not.toMatch(/select[\s\S]{0,80}auction_contention_seeds/i);
		expect(code).not.toMatch(/CONTENTION_SEEDS_TABLE[\s\S]{0,40}select/i);
	});
});
