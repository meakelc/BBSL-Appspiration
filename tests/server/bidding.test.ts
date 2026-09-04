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

import { closedPayload } from '../fixtures/closed-event.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AUCTION_CLOCK, SALARY_CAP } from '../../src/lib/core/constants.ts';
import {
	AUCTION_EXPIRED,
	BID_PLACED_EVENT,
	CONTENTION_DISSOLVED_EVENT,
	SEED_COMMITMENT_UNVERIFIABLE,
	SEED_REVEALED
} from '../../src/lib/core/projection/auctions.ts';
import {
	AUCTION_CLOSED_EVENT,
	NOMINATION_PLACED_EVENT
} from '../../src/lib/core/projection/nominations.ts';
import { MINOR_LEAGUE_ELIGIBILITY_SET } from '../../src/lib/core/projection/eligibility.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { hash } from '../../src/lib/core/hash.ts';
import { bidRefusalDetail } from '../../src/lib/core/rules/bidding.ts';
import type {
	BidPlacedPayload,
	ContentionDissolvedPayload
} from '../../src/lib/core/rules/bidding.ts';
import { PLACE_BID_GATES } from '../../src/lib/core/types.ts';
import { loadAuctionPage } from '../../src/lib/server/auction-page.ts';
import { loadBidState, placeBid } from '../../src/lib/server/bidding.ts';
import { AUCTION_OPENED_EVENT } from '../../src/lib/core/projection/phase.ts';
import type { BidRejection } from '../../src/lib/server/bidding.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

const ACTOR = { managerId: 'm-2', teamId: 't-2', teamName: 'Rockets' };

const NOW = new Date('2026-08-26T12:00:00.000Z');

/**
 * The seed a live Minimum-Bid Contention sealed, as `auction_contention_seeds`
 * holds it (Story 3.3, AD-14).
 *
 * The commitment the log publishes is `hash(SEALED_SEED)`, DERIVED rather than
 * written out beside it — so a dissolution tested against it verifies for the
 * real reason rather than because two literals happened to be typed to match.
 */
const SEALED_SEED = '7b4e2a90c15d386f7b4e2a90c15d386f7b4e2a90c15d386f7b4e2a90c15d386f';

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

/**
 * The `AuctionOpened` every one of these logs carries (Story 3.7).
 *
 * The ninth `PLACE_BID_GATES` gate reads the folded phase, and a log with no
 * open folds to Setup — where no Bid is accepted at all. Every scenario in
 * this file is a Bid inside a running auction, so every fixture log opens the
 * auction first. It sits at `seq` 0, before the nomination and the Bids, which
 * is the only order the gates could ever have produced.
 */
function auctionOpened(occurredAt = '2026-08-25T09:00:00.000Z'): QueryResultRow {
	return {
		seq: 0,
		occurred_at: new Date(occurredAt),
		schema_version: 1,
		core_version: 1,
		manager_id: 'm-commissioner',
		team_id: 't-commissioner',
		event_type: AUCTION_OPENED_EVENT,
		payload: {}
	};
}

function fakeGateway(
	options: {
		events?: QueryResultRow[];
		roster?: QueryResultRow[];
		/**
		 * The SEALED seed row for this Player's contention (Story 3.3).
		 *
		 * `undefined` is a table with no row for them, which is what every
		 * test that is not about a dissolution wants: the read still happens
		 * inside a live contention and simply comes back empty.
		 */
		sealedSeed?: string;
	} = {}
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
				// The auction is OPEN in every scenario here (Story 3.7): the ninth
				// gate reads the folded phase, and a log with no `AuctionOpened`
				// folds to Setup, where no Bid is accepted at all. Served by the
				// fake rather than repeated in thirty `events:` arrays.
				return { rows: [auctionOpened(), ...(options.events ?? []), ...appendedEvents] };
			}
			// Matched on the TABLE rather than on the column list: Story 4.5
			// widened this select to carry the Player id and name the Team
			// view's roster listing needs from the same one read.
			if (/from team_rosters/i.test(sql)) {
				order.push('read-roster');
				params.push([...queryParams]);
				return { rows: options.roster ?? NINE_CHEAP_PLAYERS };
			}
			if (/^select seed from auction_contention_seeds/i.test(sql)) {
				// The sealed table's ONE reader (Story 3.3), on this same
				// client — the connection that holds the lock and appends. It
				// is recorded in `order` so "under the lock, before the
				// decision" is observable rather than assumed.
				order.push('read-seed');
				params.push([...queryParams]);
				return { rows: options.sealedSeed === undefined ? [] : [{ seed: options.sealedSeed }] };
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
			// Story 5.2 registered `enqueueBroadcasts` on this write, so the
			// appending transaction now also files one channel-addressed
			// delivery intent per broadcast-worthy event (AD-17). It is
			// recorded in `statements` like every other statement and asserted
			// on in `tests/server/outbox.test.ts`, which owns the outbox; here
			// it only has to be a statement the fake recognises rather than one
			// it rejects.
			if (/^insert into notification_outbox/i.test(sql)) {
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

/**
 * A READ-path gateway over a fixed log, for the one assertion in this file
 * that has to cross from `placeBid` to `loadAuctionPage`.
 *
 * Deliberately permissive where `fakeGateway` above is strict: nothing here is
 * asserting which statements the reader issues — `tests/server/auction-page.test.ts`
 * owns that, with a fake that throws on anything it does not recognise. This
 * one exists so a log this transaction actually WROTE can be handed to the
 * reader that renders it, which is the join the deferred entry asked for.
 */
function pageGateway(events: QueryResultRow[]): ConnectionGateway {
	const client: TransactionalClient & { release(): void } = {
		async query(text: string) {
			const sql = text.trim();
			if (/^select \* from auction_events/i.test(sql))
				return { rows: [auctionOpened(), ...events] };
			if (/^select now\(\) as now/i.test(sql)) return { rows: [{ now: NOW }] };
			// Everything else — the reference row, the two Manager joins, the
			// roster — answers empty, which the reader already has a stated
			// fallback for and which no assertion here depends on.
			return { rows: [] };
		},
		release() {
			// Nothing to return: this fake holds no pool.
		}
	};
	return { connect: async () => client };
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
	occurredAt = '2026-08-26T09:00:00.000Z',
	/**
	 * The published commitment, present only on the Bid that OPENED a
	 * Minimum-Bid Contention (Story 3.2) — and the value a dissolution's
	 * reveal is verified against (Story 3.3).
	 *
	 * Spread rather than set to `null`, so an ordinary Bid's payload carries
	 * no such key at all, exactly as `decide()` builds it.
	 */
	seedHash?: string
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
			closesAt: '2026-08-27T09:00:00.000Z',
			...(seedHash === undefined ? {} : { seedHash })
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
			// Story 3.7's ninth gate. It passes here — the log opens the auction
			// — and it is reported anyway, which is the whole property: an
			// accepted result and a refused one carry the identical gate set.
			'phase',
			'selfBid',
			'slots'
		]);
		expect(rejection.refusal.gates.phase.passed).toBe(true);
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

	it('THROWS on a dissolution whose sealed seed is missing, rather than refusing', async () => {
		// Story 2.5 refused the opening at exactly $1,000,000 here, because no
		// lottery could be run; Story 3.2 refused the conversion, because no
		// lottery could yet be dissolved. Both are accepted now, so the only
		// thing left to refuse at this amount is a SHELL BUG — a dissolution
		// reached with no sealed seed in hand — and a bug is a throw rather
		// than a Manager-facing refusal (AD-1). The transaction rolls back and
		// nothing reaches the log, which is the outcome AD-14 requires: a
		// contention is never released with its commitment still sealed.
		const harness = fakeGateway({
			events: [nominated(), bidLogged(2, 1_000_000, 't-1', 'm-1', undefined, hash(SEALED_SEED))]
		});

		await expect(
			placeBid(harness.gateway, ACTOR, 'p-1', parseMoney(2_000_000), DEVICE_CLASS)
		).rejects.toThrow(TypeError);

		expect(harness.appendedEvents).toHaveLength(0);
		expect(harness.seedRows).toHaveLength(0);
		expect(harness.state.committed).toBe(false);
		expect(harness.state.rolledBack).toBe(true);
	});

	it('refuses when the Player’s Auction is not open — re-derived under the lock', async () => {
		for (const events of [
			// Never nominated.
			[],
			// Nominated, then closed (Story 2.3's release fold).
			[nominated(), logEvent(2, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1' }))]
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
			// Story 3.7: the folded League phase, off the SAME log read again —
			// the fifth fold, and the ninth gate's one input. `Auction`, because
			// this log opens the auction before it nominates anybody.
			phase: 'Auction',
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
			// Story 3.3: the published commitment, off the same log read
			// again — `null` here because no lottery ever opened on this
			// Auction. It is what `decide()` verifies a revealed seed
			// against, and no gate reads it.
			seedHash: null,
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
		// Story 3.3: no sealed seed, because this Auction is not a lottery —
		// and the read is not issued at all, which is why the statement order
		// below is unchanged.
		expect(loaded.sealedSeed).toBeNull();
		// The log is read once and the roster once, and BOTH after the lock —
		// which is what makes the figures the gate decides from unable to move
		// between the read and the decision (AD-6, AD-7).
		expect(harness.order).toEqual(['begin', 'read-log', 'read-roster']);
	});

	it('reads the SEALED seed only inside a live contention, and on this same client', async () => {
		// Story 3.3, AD-14. The seed table grants `anon`, `authenticated` and
		// `service_role` nothing, so the direct connection this transaction
		// already holds is the ONLY identity that can see a row — and reading
		// it here, after the lock, is what makes the read and the append one
		// atomic act.
		const harness = fakeGateway({
			events: [nominated(), bidLogged(2, 1_000_000)],
			sealedSeed: 'c'.repeat(64)
		});
		await harness.client.query('begin');

		const loaded = await loadBidState(harness.client, 'p-1', 't-2');

		expect(loaded.bid.contention).toBe('minimum_bid');
		expect(loaded.sealedSeed).toBe('c'.repeat(64));
		// After the lock, and on the client that holds it.
		expect(harness.order).toEqual(['begin', 'read-log', 'read-roster', 'read-seed']);
	});

	it('reads no seed at all when the Auction is not a lottery', async () => {
		const harness = fakeGateway({
			events: [nominated(), bidLogged(2, 8_000_000)],
			sealedSeed: 'c'.repeat(64)
		});
		await harness.client.query('begin');

		const loaded = await loadBidState(harness.client, 'p-1', 't-2');

		expect(loaded.sealedSeed).toBeNull();
		expect(harness.order).not.toContain('read-seed');
	});

	it('answers null for a live contention whose seed row is missing', async () => {
		// A corrupt log rather than anything this codebase can write. A join
		// is unaffected; a DISSOLUTION throws out of `decide()` rather than
		// releasing every Contender with the commitment still sealed.
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 1_000_000)] });
		await harness.client.query('begin');

		const loaded = await loadBidState(harness.client, 'p-1', 't-2');

		expect(loaded.bid.contention).toBe('minimum_bid');
		expect(loaded.sealedSeed).toBeNull();
		expect(harness.order).toContain('read-seed');
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

		expect(code).toContain('decide(state.bid, command, now.toISOString(), contentionSeed)');
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
		// A Bid in the dead zone: refused on `contention` and `granularity`,
		// so `decide()` never reaches the payload and the projection never
		// runs.
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 1_000_000)] });

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(1_200_000),
			DEVICE_CLASS
		);

		expect(outcome.kind).toBe('rejected');
		expect(harness.seedRows).toHaveLength(0);
		expect(harness.state.committed).toBe(false);
	});

	it('writes NO SECOND seed row on a dissolution, and reveals the sealed one (Story 3.3)', async () => {
		// **The whole shape of a dissolution at the transaction.** The
		// contention opened with a published commitment; the sealed seed sits
		// in the table this transaction is the only reader of; a $2,000,000
		// Bid converts it.
		const harness = fakeGateway({
			events: [nominated(), bidLogged(2, 1_000_000, 't-1', 'm-1', undefined, hash(SEALED_SEED))],
			sealedSeed: SEALED_SEED
		});

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(2_000_000),
			DEVICE_CLASS
		);
		if (outcome.kind !== 'accepted') throw new Error('the dissolution was refused');

		// TWO events, in ONE transaction, cause then consequence.
		expect(outcome.events).toHaveLength(2);
		expect(harness.appendedEvents).toHaveLength(2);
		expect(harness.appendedEvents.map((row) => row['event_type'])).toEqual([
			BID_PLACED_EVENT,
			CONTENTION_DISSOLVED_EVENT
		]);
		expect(harness.order.filter((step) => step === 'append-event')).toHaveLength(2);
		expect(harness.order.filter((step) => step === 'commit')).toHaveLength(1);
		// The seed was READ under the lock, before anything was appended.
		expect(harness.order.indexOf('read-seed')).toBeLessThan(
			harness.order.indexOf('append-event')
		);

		// No second seed row: the converting `BidPlaced` publishes no
		// commitment, which is the only thing `recordContentionSeed` fires on.
		expect(harness.seedRows).toHaveLength(0);
		expect(harness.order).not.toContain('append-seed');

		// The raw seed is in the DISSOLUTION and in nothing else — never in a
		// `BidPlaced` payload, at any depth.
		const bidPayload = harness.appendedEvents[0]?.['payload'] as BidPlacedPayload;
		expect(Object.keys(bidPayload)).not.toContain('seedHash');
		expect(JSON.stringify(bidPayload)).not.toContain(SEALED_SEED);

		const dissolved = harness.appendedEvents[1]?.['payload'] as ContentionDissolvedPayload;
		expect(dissolved.seed).toBe(SEALED_SEED);
		expect(dissolved.seedHash).toBe(hash(SEALED_SEED));
		expect(dissolved.fantraxPlayerId).toBe('p-1');
		expect(dissolved.convertingTeamId).toBe('t-2');
		expect(dissolved.amount).toBe(2_000_000);
		// The Contenders released, in the fold's own join order (AD-14).
		expect(dissolved.formerContenders).toEqual(['t-1']);
		// The measurement column rides BOTH envelopes, never a payload.
		expect(harness.appendedEvents[1]?.['device_class']).toBe(DEVICE_CLASS);
	});

	it('THROWS rather than revealing a seed that does not match the commitment', async () => {
		// The one failure AD-14 cannot survive: a reveal that contradicts the
		// commitment a Manager already recorded. `decide()` hashes what it was
		// handed and compares before it builds a payload, so nothing reaches
		// the log at all.
		const harness = fakeGateway({
			events: [
				nominated(),
				bidLogged(2, 1_000_000, 't-1', 'm-1', undefined, hash('a different seed'))
			],
			sealedSeed: SEALED_SEED
		});

		await expect(
			placeBid(harness.gateway, ACTOR, 'p-1', parseMoney(2_000_000), DEVICE_CLASS)
		).rejects.toThrow(TypeError);

		expect(harness.appendedEvents).toHaveLength(0);
		expect(harness.state.committed).toBe(false);
		expect(harness.state.rolledBack).toBe(true);
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

	it('dissolves a contention with NO commitment, commits, and the page says so', async () => {
		// **The end-to-end assertion Story 3.3's deferred entry asked for.**
		// `decide()`'s "reveal against a commitment that folded to null rather
		// than stranding the Auction" branch was proven at the core, and
		// `readContentionSeed`'s null answer at the transaction, and nothing
		// joined the two. This does: a lottery whose opening `BidPlaced` carries
		// no `seedHash` at all — reachable only from a corrupt or hand-written
		// log, which AD-4 forbids correcting in place — is dissolved through
		// `placeBid`, the transaction COMMITS, and `loadAuctionPage` then
		// serialises exactly what the Auction page renders as
		// `SEED_COMMITMENT_UNVERIFIABLE`.
		const harness = fakeGateway({
			// No sixth argument: the opening publishes no commitment.
			events: [nominated(), bidLogged(2, 1_000_000)],
			sealedSeed: SEALED_SEED
		});

		const outcome = await placeBid(
			harness.gateway,
			ACTOR,
			'p-1',
			parseMoney(2_000_000),
			DEVICE_CLASS
		);
		if (outcome.kind !== 'accepted') throw new Error('the dissolution was refused');

		// It committed rather than stranding the Auction in a contention.
		expect(harness.state.committed).toBe(true);
		expect(harness.state.rolledBack).toBe(false);

		const dissolved = harness.appendedEvents[1]?.['payload'] as ContentionDissolvedPayload;
		expect(dissolved.seed).toBe(SEALED_SEED);
		// Stated as the absence it is, never as a check that was made.
		expect(dissolved.seedHash).toBeNull();

		// ...and the READ path, over the log this transaction produced.
		const view = await loadAuctionPage(
			pageGateway([nominated(), bidLogged(2, 1_000_000), ...harness.appendedEvents]),
			'p-1',
			null
		);

		expect(view?.seed).toBe(SEALED_SEED);
		expect(view?.seedHash).toBeNull();
		// The page prints ONE sentence or the other off exactly this pair, and
		// with a null commitment it is the unverifiable one — two sentences
		// making opposite claims about one value is the thing it may never do.
		expect(view?.seedHash === null ? SEED_COMMITMENT_UNVERIFIABLE : SEED_REVEALED).toBe(
			SEED_COMMITMENT_UNVERIFIABLE
		);
	});

	it('touches the seed table exactly twice: one insert and one select (Story 3.3)', () => {
		// `recordContentionSeed` is a WRITE-SIDE statement, exactly as
		// `claimNomination` is, and `readContentionSeed` is the table's one
		// reader — added by dissolution, because a reveal has to open what
		// the opening sealed. Both go through the transaction's own client,
		// which is the only identity the migration grants anything at all.
		//
		// **Story 3.6 moved the READER out of this module**, to
		// `server/contention-seed.ts`, because `supabase/functions/tick`
		// makes Deno load `server/close.ts` and a close now needs to read a
		// sealed seed at the draw. This file imports `node:crypto`, so a
		// close reaching the reader through it would pull a Node built-in
		// into the Deno graph and break AD-2. The two statements are counted
		// across BOTH modules here, so "exactly one insert and one select"
		// stays a property of the codebase rather than of one file.
		const read = (path: string) =>
			readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/(^|[^:])\/\/.*$/gm, '$1');
		const writer = read('../../src/lib/server/bidding.ts');
		const reader = read('../../src/lib/server/contention-seed.ts');
		const code = `${writer}
${reader}`;

		expect(writer).toContain('insert into ${CONTENTION_SEEDS_TABLE}');
		expect(reader).toContain('select seed from ${CONTENTION_SEEDS_TABLE}');
		// The writer names it twice — the import and the insert — and the
		// reader twice: its own declaration and the select. A fifth is a
		// statement nobody reviewed.
		expect([...writer.matchAll(/CONTENTION_SEEDS_TABLE/g)]).toHaveLength(2);
		expect([...reader.matchAll(/CONTENTION_SEEDS_TABLE/g)]).toHaveLength(2);
		// The interpolated form, which is how every statement in these two
		// modules names the table — so `ProjectionUpdater` sitting near the
		// import is not mistaken for an UPDATE against it.
		expect(code).not.toMatch(/update[\s\S]{0,80}\$\{CONTENTION_SEEDS_TABLE\}/i);
		expect(code).not.toMatch(/delete[\s\S]{0,80}\$\{CONTENTION_SEEDS_TABLE\}/i);
		// Both go through the transaction's own client — never through
		// `server/supabase.ts`, whose roles hold nothing on this table.
		expect(code).not.toContain('supabase.ts');
		// ...and the module the tick's Deno graph reaches imports no Node
		// built-in, which is the whole reason it exists.
		expect(reader).not.toMatch(/from 'node:/);
	});
});

/**
 * A Team's next Bid, judged against what it has already WON (Story 3.4, AC4).
 *
 * `team_rosters` is unchanged by a close — nothing writes it but the import —
 * so every figure below moves because `loadBidState` folds `AuctionClosed`
 * into `AuctionContracts` and hands them to `loadTeamRoster`, which counts a
 * contract row exactly as it counts an imported one. There is no second Cap
 * term and no `+ wonCount` anywhere; a won Player is one more `CapHitRow`.
 */
describe('loadBidState — a won contract is in the three figures (AC4)', () => {
	const won = (
		seq: number,
		fantraxPlayerId: string,
		teamId: string,
		winningAmount: number,
		capHit: number,
		placement: 'active_bench' | 'minor_league'
	) =>
		logEvent(
			seq,
			AUCTION_CLOSED_EVENT,
			{
				fantraxPlayerId,
				playerName: fantraxPlayerId,
				teamId,
				teamName: teamId,
				managerId: 'm-w',
				winningAmount,
				capHit,
				placement,
				contention: 'standard',
				contractYears: null,
				closedAt: '2026-08-26T09:00:00.000Z'
			},
			'2026-08-26T09:00:00.000Z',
			{ managerId: 'm-w', teamId }
		);

	async function bidStateWith(events: QueryResultRow[]) {
		const harness = fakeGateway({ events });
		let loaded: Awaited<ReturnType<typeof loadBidState>> | null = null;
		const client = await harness.gateway.connect();
		try {
			await client.query('begin');
			loaded = await loadBidState(client, 'p-1', ACTOR.teamId);
			await client.query('rollback');
		} finally {
			client.release();
		}
		return { harness, loaded };
	}

	it('charges an Active/Bench win against Cap Space and Roster Count', async () => {
		const { loaded } = await bidStateWith([
			nominated(),
			bidLogged(2, 8_000_000),
			won(3, 'p-won', ACTOR.teamId, 8_000_000, 8_000_000, 'active_bench')
		]);

		// Nine imported $1.0M contracts is $156.0M of room; the win takes $8.0M.
		expect(loaded?.bid.team?.capSpace).toBe(SALARY_CAP - 9_000_000 - 8_000_000);
		expect(loaded?.bid.team?.rosterCount).toBe(10);
		expect(loaded?.bid.team?.minorLeagueOccupied).toBe(0);
	});

	it('leaves Cap Space and Roster Count alone on a Minor League win, and occupies a Slot', async () => {
		const { loaded } = await bidStateWith([
			nominated(),
			bidLogged(2, 8_000_000),
			won(3, 'p-stash', ACTOR.teamId, 4_000_000, 0, 'minor_league')
		]);

		// AD-23: the contract says $4,000,000 and charges $0.
		expect(loaded?.bid.team?.capSpace).toBe(SALARY_CAP - 9_000_000);
		expect(loaded?.bid.team?.rosterCount).toBe(9);
		expect(loaded?.bid.team?.minorLeagueOccupied).toBe(1);
	});

	it('counts no other Team’s contract', async () => {
		const { loaded } = await bidStateWith([
			nominated(),
			bidLogged(2, 8_000_000),
			won(3, 'p-won', 't-someone-else', 30_000_000, 30_000_000, 'active_bench')
		]);

		expect(loaded?.bid.team?.capSpace).toBe(SALARY_CAP - 9_000_000);
		expect(loaded?.bid.team?.rosterCount).toBe(9);
	});

	it('drops the won Auction out of the eligible leads it was exposure for (§10 ex 20)', async () => {
		// Nothing sweeps: the close removes the Auction from
		// `auctionsReducer`'s fold, so the amount simply stops appearing.
		const stashEvents: QueryResultRow[] = [
			nominated(),
			bidLogged(2, 8_000_000),
			nominated(3, 'p-stash', 'Ausar Bright', 't-8'),
			logEvent(4, MINOR_LEAGUE_ELIGIBILITY_SET, {
				fantraxPlayerId: 'p-stash',
				playerName: 'Ausar Bright',
				before: false,
				after: true
			}),
			logEvent(
				5,
				BID_PLACED_EVENT,
				{
					fantraxPlayerId: 'p-stash',
					teamId: ACTOR.teamId,
					teamName: ACTOR.teamName,
					managerId: ACTOR.managerId,
					amount: 30_000_000,
					closesAt: '2026-08-27T09:00:00.000Z'
				},
				'2026-08-26T09:00:00.000Z',
				{ managerId: ACTOR.managerId, teamId: ACTOR.teamId }
			)
		];

		const open = await bidStateWith(stashEvents);
		expect(open.loaded?.bid.team?.eligibleLeading).toEqual([
			{ fantraxPlayerId: 'p-stash', playerName: 'Ausar Bright', amount: 30_000_000 }
		]);

		const closed = await bidStateWith([
			...stashEvents,
			won(6, 'p-stash', ACTOR.teamId, 30_000_000, 0, 'minor_league')
		]);
		expect(closed.loaded?.bid.team?.eligibleLeading).toEqual([]);
		// ...and the Slot it took is now occupied, which is the other half of
		// example 20: the exposure went away because the Player is placed.
		expect(closed.loaded?.bid.team?.minorLeagueOccupied).toBe(1);
	});
});
