/**
 * The nomination transaction and the render-path read. Server-only
 * (Story 2.1).
 *
 * The stateful fake `ConnectionGateway` is `tests/server/auction-open.test.ts`'s,
 * extended with the two live reference tables this gate reads: it records
 * every statement in order and keeps the appended events in memory, so "no
 * event was appended" and "everything rolled back on a throw" are observable
 * rather than assumed. The fake throws on any statement it does not
 * recognise, which is what makes "no projection table was written" provable
 * rather than merely unasserted.
 */

import { describe, expect, it } from 'vitest';

import { CORE_VERSION } from '../../src/lib/core/constants.ts';

import { CLOSED_TEAM_ID, closedPayload } from '../fixtures/closed-event.ts';

import {
	AUCTION_CLOSED_EVENT,
	AUCTION_TERMINATED_EVENT,
	NOMINATION_PLACED_EVENT
} from '../../src/lib/core/projection/nominations.ts';
import { BID_PLACED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import { AUCTION_OPENED_EVENT } from '../../src/lib/core/projection/phase.ts';
import {
	COMMISSIONER_SLOT_STATUS,
	commissionerConsequenceSentence,
	nominationPoolStatus,
	nominationRefusalDetail,
	nominationSlotStatus
} from '../../src/lib/core/rules/nomination.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';
import {
	loadNominatablePool,
	loadNominationState,
	placeNomination,
	releaseNomination
} from '../../src/lib/server/nomination.ts';
import type {
	NominationPlacedPayload,
	NominationRejection
} from '../../src/lib/server/nomination.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

const ACTOR = { managerId: 'm-1', teamId: 't-1', teamName: 'Lakers', spendsSlot: true };

/**
 * The same actor as a Commissioner: bound to the same Team, spending no
 * Nomination Slot (Story 9.8). Deliberately the SAME Team as `ACTOR`, so a
 * test can hold a Slot with one and prove the other nominates through it.
 */
const COMMISSIONER = { ...ACTOR, spendsSlot: false };

const NOW = new Date('2026-08-26T09:00:00.000Z');

const DEVICE_CLASS = 'mobile';

type FakePoolPlayer = {
	fantraxPlayerId: string;
	playerName: string;
	positions?: string;
	nbaTeam?: string;
	/** The Team holding this Player's contract, if any. */
	contractTeamName?: string | null;
};

/**
 * A synthetic Postgres error, shaped the way `pg` really shapes one: an
 * Error carrying `code` and `constraint` as plain properties. This is how a
 * `23505` is produced without a database — the real thing is proven against
 * real Postgres in tests/integration/auction-events.test.ts.
 */
function pgError(code: string, constraint?: string): Error {
	const error = new Error(`duplicate key value violates unique constraint "${constraint ?? '?'}"`);
	Object.assign(error, { code, constraint });
	return error;
}

function fakeGateway(options: {
	pool?: FakePoolPlayer[];
	events?: QueryResultRow[];
	throwOn?: RegExp;
	/** Throw a database-shaped error on the matching statement instead of a plain one. */
	throwPg?: { on: RegExp; code: string; constraint?: string };
	/** The log the SECOND connection sees — the loser's post-rollback naming re-read. */
	eventsAfterRollback?: QueryResultRow[];
	/**
	 * Make the SECOND `connect()` throw, so the post-rollback naming re-read
	 * fails outright rather than merely finding nothing. This is the only way
	 * to reach `nameTheHolder`'s outer `catch`: a `throwOn` regex matching the
	 * log read would fire on the FIRST, gate-side read too and never reach the
	 * claim insert at all.
	 */
	failNamingReRead?: boolean;
}) {
	const order: string[] = [];
	const params: unknown[][] = [];
	const appendedEvents: QueryResultRow[] = [];
	let seq = 40;
	let released = 0;
	let connects = 0;
	let committed = false;
	let rolledBack = false;

	const pool = options.pool ?? [];

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, queryParams: readonly unknown[] = []) {
			const sql = text.trim();
			if (options.throwOn !== undefined && options.throwOn.test(sql)) {
				order.push('throw');
				throw new Error('the insert failed partway');
			}
			if (options.throwPg !== undefined && options.throwPg.on.test(sql)) {
				order.push('throw');
				throw pgError(options.throwPg.code, options.throwPg.constraint);
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
				// After the losing transaction rolled back, the naming re-read
				// runs on a fresh connection and sees the WINNER's committed
				// event — which this fake models by switching the log it hands
				// back once a rollback has happened.
				if (rolledBack && options.eventsAfterRollback !== undefined) {
					return { rows: options.eventsAfterRollback };
				}
				return { rows: options.events ?? [] };
			}
			// The claim row, written through the projection seam INSIDE the
			// appending transaction (Story 2.2). Nothing ever selects from
			// this table — there is no read branch for it here, and the fake
			// throws on any statement it does not recognise, so a read would
			// fail the suite rather than pass unnoticed.
			if (/^insert into open_nominations/i.test(sql)) {
				order.push('claim-nomination');
				params.push([...queryParams]);
				return { rows: [] };
			}
			// The SLOT claim, in its own table since FR-9 was amended: a Slot
			// outlives the board seat, so one row deleted on close can no longer
			// carry both. Written only when the nomination spends a Slot, which
			// is why a Commissioner's nomination produces no `claim-slot` entry
			// in `order` at all.
			if (/^insert into nomination_slots/i.test(sql)) {
				order.push('claim-slot');
				params.push([...queryParams]);
				return { rows: [] };
			}
			// The claim row's deleter (Story 2.3). Registered by no production
			// call site — `releaseNomination` is driven directly by the tests
			// below — but the fake must recognise the statement, or the very
			// thing under test would read as "unexpected statement".
			if (/^delete from open_nominations/i.test(sql)) {
				order.push('release-nomination');
				params.push([...queryParams]);
				return { rows: [] };
			}
			// The Slot claim's deleter, keyed on the WINNING Team. Recorded
			// apart from the seat's delete because the two key on different
			// things and fire on different events.
			if (/^delete from nomination_slots/i.test(sql)) {
				order.push('release-slot');
				params.push([...queryParams]);
				return { rows: [] };
			}
			// The point read behind the gate.
			if (/^select fantrax_player_id, player_name\s+from free_agent_players/i.test(sql)) {
				order.push('read-pool-player');
				params.push([...queryParams]);
				const found = pool.find((p) => p.fantraxPlayerId === queryParams[0]);
				return {
					rows:
						found === undefined
							? []
							: [{ fantrax_player_id: found.fantraxPlayerId, player_name: found.playerName }]
				};
			}
			// The contract lookup behind the gate.
			if (/^select t\.name\s+from team_rosters r/i.test(sql)) {
				order.push('read-contract');
				const found = pool.find((p) => p.fantraxPlayerId === queryParams[0]);
				const holder = found?.contractTeamName ?? null;
				return { rows: holder === null ? [] : [{ name: holder }] };
			}
			// The whole-pool read behind the page.
			if (/^select p\.fantrax_player_id/i.test(sql)) {
				order.push('read-pool');
				return {
					rows: [...pool]
						.sort((a, b) => a.playerName.localeCompare(b.playerName))
						.map((p) => ({
							fantrax_player_id: p.fantraxPlayerId,
							player_name: p.playerName,
							positions: p.positions ?? 'SG',
							nba_team: p.nbaTeam ?? 'HOU',
							contract_team_name: p.contractTeamName ?? null
						}))
				};
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

	const gateway: ConnectionGateway = {
		connect: async () => {
			connects += 1;
			if (options.failNamingReRead === true && connects > 1) {
				throw new Error('the pool refused a connection for the naming re-read');
			}
			return client;
		}
	};
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
			}
		}
	};
}

function logEvent(seq: number, type: string, payload: unknown, occurredAt = '2026-08-25T19:00:00.000Z'): QueryResultRow {
	return {
		seq,
		occurred_at: new Date(occurredAt),
		schema_version: 1,
		core_version: CORE_VERSION,
		manager_id: 'm-0',
		team_id: 't-0',
		event_type: type,
		payload
	};
}

function opened(seq = 1): QueryResultRow {
	return logEvent(seq, AUCTION_OPENED_EVENT, { teams: [], minorLeagueEligibleCount: 0 });
}

function nominated(
	seq: number,
	fantraxPlayerId: string,
	playerName: string,
	teamId: string,
	teamName: string,
	// Story 9.8. Defaults to the Manager rule, so every existing call still
	// writes a Slot-spending nomination and every existing assertion still
	// asserts about one.
	holdsSlot = true
): QueryResultRow {
	return logEvent(seq, NOMINATION_PLACED_EVENT, {
		fantraxPlayerId,
		playerName,
		teamId,
		teamName,
		managerId: 'm-9',
		holdsSlot
	});
}

const JALEN: FakePoolPlayer = { fantraxPlayerId: 'p-1', playerName: 'Jalen Green' };
const SENGUN: FakePoolPlayer = { fantraxPlayerId: 'p-2', playerName: 'Alperen Sengun' };
/** A third pool Player, for the Commissioner's third open nomination (Story 9.8). */
const BRIGHT: FakePoolPlayer = { fantraxPlayerId: 'p-3', playerName: 'Ausar Bright' };

function rejectionOf(outcome: { kind: string; reason?: unknown }): NominationRejection {
	expect(outcome.kind).toBe('rejected');
	return outcome.reason as NominationRejection;
}

// --- The happy path ---------------------------------------------------------

describe('placeNomination — the gate holds', () => {
	it('appends exactly one NominationPlaced event, stamped and naming the actor', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });

		const outcome = await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS);

		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;
		expect(outcome.events).toHaveLength(1);
		const event = outcome.events[0];
		expect(event?.type).toBe(NOMINATION_PLACED_EVENT);
		expect(event?.managerId).toBe(ACTOR.managerId);
		expect(event?.teamId).toBe(ACTOR.teamId);
		// The database clock, read once by the shell (AD-3) — never Date.now().
		expect(event?.occurredAt).toBe(NOW.toISOString());
		expect(event?.schemaVersion).toBe(1);
		expect(event?.coreVersion).toBe(CORE_VERSION);
		expect(harness.state.committed).toBe(true);
		expect(harness.state.released).toBe(1);
	});

	it('names the acting Manager, Team and Player in the payload — AC5', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });

		const outcome = await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS);
		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;

		const payload = outcome.events[0]?.payload as NominationPlacedPayload;
		expect(payload).toEqual({
			fantraxPlayerId: 'p-1',
			playerName: 'Jalen Green',
			teamId: 't-1',
			teamName: 'Lakers',
			managerId: 'm-1',
			// Story 9.8: whether this nomination spent a Slot, written down so
			// the fold decides the same thing forever rather than re-reading
			// `managers.is_commissioner` at replay time.
			holdsSlot: true
		});
	});

	it('carries the device class into params[7], the envelope column — AC5', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });

		const outcome = await placeNomination(harness.gateway, ACTOR, 'p-1', 'tablet');
		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;

		const insertParams = harness.params.find((p) => p.length === 10);
		expect(insertParams?.[7]).toBe('tablet');
		expect(outcome.events[0]?.deviceClass).toBe('tablet');
		expect(outcome.events[0]?.deviceClass).not.toBeNull();
	});

	it('keeps the device class OUT of the payload — a measurement is not a rule input', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });
		const outcome = await placeNomination(harness.gateway, ACTOR, 'p-1', 'mobile');
		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;
		expect(JSON.stringify(outcome.events[0]?.payload)).not.toContain('mobile');
	});

	it('writes "unknown" through unchanged — an absent User-Agent nominates normally', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });
		const outcome = await placeNomination(harness.gateway, ACTOR, 'p-1', 'unknown');
		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;
		expect(outcome.events[0]?.deviceClass).toBe('unknown');
	});

	it('takes the lock and folds the log BEFORE it reads any table — AC3', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });

		await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS);

		expect(harness.order.indexOf('begin')).toBeLessThan(harness.order.indexOf('lock'));
		expect(harness.order.indexOf('lock')).toBeLessThan(harness.order.indexOf('read-log'));
		expect(harness.order.indexOf('read-log')).toBeLessThan(harness.order.indexOf('read-pool-player'));
		expect(harness.order.indexOf('read-contract')).toBeLessThan(harness.order.indexOf('append-event'));
	});

	it('writes the claim row after the event and BEFORE the commit — Story 2.2 AC1', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });

		await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS);

		// Every statement the transaction issued. BOTH claim inserts sit
		// between the event and the commit, so all three commit together or
		// roll back together — and no board table or clock row is written
		// anywhere. The fake throws on any statement it does not recognise,
		// which is the other half of this.
		expect(harness.order).toEqual([
			'begin',
			'lock',
			'read-log',
			'read-pool-player',
			'read-contract',
			'append-event',
			'claim-nomination',
			// The Slot claim, since FR-9 was amended. A Manager's nomination
			// writes it; a Commissioner's does not, which is asserted in the
			// exemption describe below.
			'claim-slot',
			'commit'
		]);
	});

	it('writes the claim from the appended event — Player, Team, seq and clock', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });

		const outcome = await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS);
		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;

		const claimParams = harness.params.find((p) => p.length === 5);
		expect(claimParams).toEqual([
			'p-1',
			't-1',
			outcome.events[0]?.seq,
			outcome.events[0]?.occurredAt,
			// Story 9.8: the column the partial unique index is defined over.
			// `true` here is what makes this row collide with a second Slot
			// spend by the same Team.
			true
		]);
	});

	it('never READS the claim table — the Slot stays a fold of the log', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });
		await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS);
		// The claim table is a write-side constraint. The fake has no read
		// branch for it at all, so a select would have thrown; this states the
		// rule the order already proves.
		expect(harness.order.filter((s) => s === 'claim-nomination')).toHaveLength(1);
	});

	it('commits no cap space and no Auction Clock — the event is the whole write (AC1)', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });
		await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS);
		expect(harness.appendedEvents).toHaveLength(1);
		const payload = harness.appendedEvents[0]?.['payload'] as Record<string, unknown>;
		// No money, no bid, no clock, anywhere in what was written.
		expect(Object.keys(payload).sort()).toEqual([
			'fantraxPlayerId',
			// Story 9.8. A boolean about a Slot, which commits no money either:
			// the point of this assertion is what is ABSENT, and nothing about
			// cap space, bids or the clock has been added.
			'holdsSlot',
			'managerId',
			'playerName',
			'teamId',
			'teamName'
		]);
	});

	it('lets a second Team nominate a different Player', async () => {
		const harness = fakeGateway({
			pool: [JALEN, SENGUN],
			events: [opened(), nominated(2, 'p-1', 'Jalen Green', 't-9', 'Celtics')]
		});
		const outcome = await placeNomination(harness.gateway, ACTOR, 'p-2', DEVICE_CLASS);
		expect(outcome.kind).toBe('accepted');
	});
});

// --- The refusals, every one re-derived inside the transaction ---------------

describe('placeNomination — the refusals', () => {
	it('refuses outside the Auction Phase, naming the folded phase', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [] });

		const rejection = rejectionOf(await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS));

		expect(rejection.refusal.kind).toBe('phase');
		if (rejection.refusal.kind !== 'phase') return;
		// The phase came from the log this transaction read, not from a column.
		expect(rejection.refusal.phase).toBe('Setup');
		expect(rejection.detail).toBe(nominationRefusalDetail(rejection.refusal));
		expect(rejection.detail).toContain('Setup');
		expect(harness.order).not.toContain('append-event');
		expect(harness.order).toContain('rollback');
		expect(harness.order).not.toContain('commit');
		expect(harness.appendedEvents).toEqual([]);
		expect(harness.state.released).toBe(1);
	});

	it('refuses an unknown Player, appending nothing', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });

		const rejection = rejectionOf(
			await placeNomination(harness.gateway, ACTOR, 'p-nope', DEVICE_CLASS)
		);

		expect(rejection.refusal.kind).toBe('unknown_player');
		expect(rejection.detail).toBe(nominationRefusalDetail(rejection.refusal));
		expect(harness.appendedEvents).toEqual([]);
		expect(harness.order).not.toContain('append-event');
	});

	it('refuses a Player under contract, NAMING the Team that holds them', async () => {
		const harness = fakeGateway({
			pool: [{ ...JALEN, contractTeamName: 'Celtics' }],
			events: [opened()]
		});

		const rejection = rejectionOf(await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS));

		expect(rejection.refusal.kind).toBe('under_contract');
		if (rejection.refusal.kind !== 'under_contract') return;
		expect(rejection.refusal.teamName).toBe('Celtics');
		expect(rejection.detail).toContain('Celtics');
		expect(rejection.detail).toContain('Jalen Green');
		expect(harness.appendedEvents).toEqual([]);
	});

	it('refuses a Player already on the board, NAMING the nominating Team', async () => {
		const harness = fakeGateway({
			pool: [JALEN],
			events: [opened(), nominated(2, 'p-1', 'Jalen Green', 't-9', 'Celtics')]
		});

		const rejection = rejectionOf(await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS));

		expect(rejection.refusal.kind).toBe('already_nominated');
		if (rejection.refusal.kind !== 'already_nominated') return;
		expect(rejection.refusal.teamName).toBe('Celtics');
		expect(rejection.detail).toContain('Celtics');
		expect(harness.appendedEvents).toEqual([]);
	});

	it('refuses when the actor’s Slot is in use, NAMING the Player holding it', async () => {
		const harness = fakeGateway({
			pool: [JALEN, SENGUN],
			events: [opened(), nominated(2, 'p-2', 'Alperen Sengun', 't-1', 'Lakers')]
		});

		const rejection = rejectionOf(await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS));

		expect(rejection.refusal.kind).toBe('slot_in_use');
		if (rejection.refusal.kind !== 'slot_in_use') return;
		expect(rejection.refusal.playerName).toBe('Alperen Sengun');
		expect(rejection.detail).toContain('Alperen Sengun');
		expect(harness.appendedEvents).toEqual([]);
		expect(harness.state.released).toBe(1);
	});

	it('holds the Slot against a SECOND nomination by the same Team, folded from the log', async () => {
		// The gate reads the Slot as a fold, not as a stored flag: there is no
		// statement in this fake that could set or read one.
		const harness = fakeGateway({ pool: [JALEN, SENGUN], events: [opened()] });

		const first = await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS);
		expect(first.kind).toBe('accepted');

		// The appended event is now part of the log the next transaction folds.
		const second = fakeGateway({
			pool: [JALEN, SENGUN],
			events: [opened(), nominated(2, 'p-1', 'Jalen Green', 't-1', 'Lakers')]
		});
		const rejection = rejectionOf(await placeNomination(second.gateway, ACTOR, 'p-2', DEVICE_CLASS));
		expect(rejection.refusal.kind).toBe('slot_in_use');
	});
});

// --- The constraint refuses what the gate let through (Story 2.2) -----------

describe('placeNomination — a claim-table conflict', () => {
	it('returns already_nominated, NAMING the Player and the winning Team, on the PK', async () => {
		// Both writers passed the gate: the log this transaction folded had no
		// nomination of p-1 in it. The winner committed between the read and
		// the claim insert, so the constraint — not the read — is what refuses.
		const harness = fakeGateway({
			pool: [JALEN],
			events: [opened()],
			throwPg: {
				on: /^insert into open_nominations/i,
				code: '23505',
				constraint: 'open_nominations_pkey'
			},
			// The naming re-read, on a fresh connection after the rollback,
			// sees the winner's now-committed event.
			eventsAfterRollback: [opened(), nominated(2, 'p-1', 'Jalen Green', 't-9', 'Celtics')]
		});

		const outcome = await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS);

		const rejection = rejectionOf(outcome);
		expect(rejection.refusal.kind).toBe('already_nominated');
		if (rejection.refusal.kind !== 'already_nominated') return;
		expect(rejection.refusal.playerName).toBe('Jalen Green');
		expect(rejection.refusal.teamName).toBe('Celtics');
		// The sentence is the pure core's, unchanged — no new wording exists.
		expect(rejection.detail).toBe(nominationRefusalDetail(rejection.refusal));
		expect(rejection.detail).toContain('Celtics');

		// Nothing survived: the event and the claim rolled back together.
		expect(harness.appendedEvents).toEqual([]);
		expect(harness.state.committed).toBe(false);
		expect(harness.order).toContain('rollback');
	});

	it('returns slot_in_use, NAMING the Player that won the Slot, on the team constraint', async () => {
		const harness = fakeGateway({
			pool: [JALEN, SENGUN],
			events: [opened()],
			// The Slot constraint moved to its own table when FR-9 was amended,
			// and so did the name `classifyNominationConflict` matches on.
			throwPg: {
				on: /^insert into nomination_slots/i,
				code: '23505',
				constraint: 'nomination_slots_pkey'
			},
			eventsAfterRollback: [opened(), nominated(2, 'p-2', 'Alperen Sengun', 't-1', 'Lakers')]
		});

		const rejection = rejectionOf(await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS));

		expect(rejection.refusal.kind).toBe('slot_in_use');
		if (rejection.refusal.kind !== 'slot_in_use') return;
		expect(rejection.refusal.playerName).toBe('Alperen Sengun');
		expect(rejection.detail).toBe(nominationRefusalDetail(rejection.refusal));
		expect(harness.appendedEvents).toEqual([]);
	});

	it('names the holder on a FRESH read after the rollback, not from the lost state', async () => {
		const harness = fakeGateway({
			pool: [JALEN],
			events: [opened()],
			throwPg: {
				on: /^insert into open_nominations/i,
				code: '23505',
				constraint: 'open_nominations_pkey'
			},
			eventsAfterRollback: [opened(), nominated(2, 'p-1', 'Jalen Green', 't-9', 'Celtics')]
		});

		await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS);

		// The re-read happened after the rollback, on its own transaction, and
		// took no lock — the winner already holds nothing this needs to wait
		// for.
		const rollbackAt = harness.order.indexOf('rollback');
		const reReadAt = harness.order.lastIndexOf('read-log');
		expect(reReadAt).toBeGreaterThan(rollbackAt);
		expect(harness.order.filter((s) => s === 'lock')).toHaveLength(1);
		expect(harness.state.released).toBe(2);
	});

	it('falls back to unrecorded when the naming re-read finds nothing', async () => {
		// The classified 23505 is still the truth: the refusal stands, only its
		// name is missing, and `unrecorded` is the honest sentence for that.
		const harness = fakeGateway({
			pool: [JALEN],
			events: [opened()],
			throwPg: {
				on: /^insert into open_nominations/i,
				code: '23505',
				constraint: 'open_nominations_pkey'
			},
			eventsAfterRollback: [opened()]
		});

		const rejection = rejectionOf(await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS));

		expect(rejection.refusal.kind).toBe('unrecorded');
		expect(rejection.detail).toBe(nominationRefusalDetail({ kind: 'unrecorded' }));
	});

	it('falls back to unrecorded when the naming re-read itself FAILS, rather than throwing', async () => {
		// Distinct from the test above: there the re-read succeeded and simply
		// found no winner. Here the re-read cannot even open a connection. The
		// refusal was already decided by the constraint, so a courtesy re-read
		// that fails must not turn a true refusal into a 500.
		const harness = fakeGateway({
			pool: [JALEN],
			events: [opened()],
			throwPg: {
				on: /^insert into open_nominations/i,
				code: '23505',
				constraint: 'open_nominations_pkey'
			},
			failNamingReRead: true
		});

		const rejection = rejectionOf(await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS));

		expect(rejection.refusal.kind).toBe('unrecorded');
		expect(rejection.detail).toBe(nominationRefusalDetail({ kind: 'unrecorded' }));
	});

	it('rethrows a 23505 on a constraint that is not one of ours — that is a bug', async () => {
		const harness = fakeGateway({
			pool: [JALEN],
			events: [opened()],
			throwPg: {
				on: /^insert into open_nominations/i,
				code: '23505',
				constraint: 'some_other_table_pkey'
			}
		});

		await expect(placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS)).rejects.toThrow(
			/duplicate key/
		);
	});

	it('rethrows a NON-23505 database error unchanged — AD-1', async () => {
		const harness = fakeGateway({
			pool: [JALEN],
			events: [opened()],
			throwPg: {
				on: /^insert into open_nominations/i,
				code: '23503',
				constraint: 'open_nominations_team_id_fkey'
			}
		});

		await expect(placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS)).rejects.toThrow();
		expect(harness.appendedEvents).toEqual([]);
		expect(harness.state.committed).toBe(false);
	});
});

// --- A failure mid-transaction ----------------------------------------------

describe('placeNomination — a failure mid-write', () => {
	it('rolls back and rethrows, leaving no event and no clock reset', async () => {
		const harness = fakeGateway({
			pool: [JALEN],
			events: [opened()],
			throwOn: /^insert into auction_events/i
		});

		await expect(placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS)).rejects.toThrow(
			/failed partway/
		);

		expect(harness.order).toContain('rollback');
		expect(harness.order).not.toContain('commit');
		expect(harness.appendedEvents).toEqual([]);
		expect(harness.state.released).toBe(1);
	});
});

// --- The read behind the gate -----------------------------------------------

describe('loadNominationState', () => {
	it('folds the phase and the board from ONE read of the log', async () => {
		const harness = fakeGateway({
			pool: [JALEN],
			events: [opened(), nominated(2, 'p-9', 'Amen Thompson', 't-3', 'Bulls')]
		});
		await harness.client.query('begin');

		const state = await loadNominationState(harness.client, 'p-1');

		expect(state.phase).toBe('Auction');
		expect(state.poolPlayer).toEqual({ fantraxPlayerId: 'p-1', playerName: 'Jalen Green' });
		expect(state.contractHolderTeamName).toBeNull();
		expect(harness.order.filter((s) => s === 'read-log')).toHaveLength(1);
	});

	it('keys the pool read on the id it was given', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });
		await harness.client.query('begin');
		await loadNominationState(harness.client, 'p-1');
		expect(harness.params[0]).toEqual(['p-1']);
	});
});

// --- The render path never writes -------------------------------------------

describe('loadNominatablePool — the render path never writes', () => {
	it('lists the pool by name and rolls back, appending nothing and taking NO lock', async () => {
		const harness = fakeGateway({ pool: [JALEN, SENGUN], events: [opened()] });

		const pool = await loadNominatablePool(harness.gateway, 't-1');

		expect(pool.players.map((p) => p.playerName)).toEqual(['Alperen Sengun', 'Jalen Green']);
		expect(harness.order).toEqual(['begin', 'read-log', 'read-pool', 'rollback']);
		expect(harness.order).not.toContain('lock');
		expect(harness.order).not.toContain('append-event');
		expect(harness.order).not.toContain('commit');
		expect(harness.state.released).toBe(1);
	});

	it('reports every Player available with a free Slot in the Auction Phase', async () => {
		const harness = fakeGateway({ pool: [JALEN, SENGUN], events: [opened()] });
		const pool = await loadNominatablePool(harness.gateway, 't-1');
		expect(pool.players.every((p) => p.available)).toBe(true);
		expect(pool.players.every((p) => p.status === 'Available')).toBe(true);
		expect(pool.slotAvailable).toBe(true);
		expect(pool.slotDetail).toBeNull();
		// The panel prints a STATUS at rest, not a refusal: nothing has been
		// submitted, so there is nothing to say "Nothing was written" about.
		expect(pool.slotStatus).toBe(nominationSlotStatus(null));
		expect(pool.slotStatus).not.toContain('Nothing was written');
	});

	it('marks an already-nominated Player unavailable, in the core’s words', async () => {
		const harness = fakeGateway({
			pool: [JALEN, SENGUN],
			events: [opened(), nominated(2, 'p-1', 'Jalen Green', 't-9', 'Celtics')]
		});

		const pool = await loadNominatablePool(harness.gateway, 't-1');

		const jalen = pool.players.find((p) => p.fantraxPlayerId === 'p-1');
		expect(jalen?.available).toBe(false);
		// Nominated, and nobody has bid: the row says which stage the Auction
		// has reached, not why a submit would be refused.
		expect(jalen?.status).toBe('Nominated');
		// The other Player is untouched.
		expect(pool.players.find((p) => p.fantraxPlayerId === 'p-2')?.available).toBe(true);
	});

	it('separates a nominated Player from one whose Auction has a Bid', async () => {
		const harness = fakeGateway({
			pool: [JALEN, SENGUN],
			events: [
				opened(),
				nominated(2, 'p-1', 'Jalen Green', 't-9', 'Celtics'),
				nominated(3, 'p-2', 'Alperen Sengun', 't-8', 'Bulls'),
				logEvent(4, BID_PLACED_EVENT, {
					fantraxPlayerId: 'p-2',
					teamId: 't-8',
					teamName: 'Bulls',
					managerId: 'm-8',
					amount: '5',
					closesAt: '2026-08-25T21:00:00.000Z'
				})
			]
		});

		const pool = await loadNominatablePool(harness.gateway, 't-1');

		// Both are refused by the same gate; the row reports which stage the
		// Auction has reached, and the Bid is the only thing separating them.
		expect(pool.players.find((p) => p.fantraxPlayerId === 'p-1')?.status).toBe('Nominated');
		expect(pool.players.find((p) => p.fantraxPlayerId === 'p-2')?.status).toBe('In-Auction');
		expect(pool.players.every((p) => p.available)).toBe(false);
	});

	it('marks a Player under contract unavailable, naming the Team', async () => {
		const harness = fakeGateway({
			pool: [{ ...JALEN, contractTeamName: 'Bulls' }],
			events: [opened()]
		});
		const pool = await loadNominatablePool(harness.gateway, 't-1');
		expect(pool.players[0]?.available).toBe(false);
		expect(pool.players[0]?.status).toBe('Closed to Bulls');
	});

	it('reports a held Slot ONCE, not as every Player being unavailable', async () => {
		const harness = fakeGateway({
			pool: [JALEN, SENGUN],
			events: [opened(), nominated(2, 'p-2', 'Alperen Sengun', 't-1', 'Lakers')]
		});

		const pool = await loadNominatablePool(harness.gateway, 't-1');

		expect(pool.slotAvailable).toBe(false);
		expect(pool.slotDetail).toContain('Alperen Sengun');
		// The status NAMES the Player holding the Slot — the one fact a
		// Manager cannot derive from this page — in one line rather than in
		// the refusal's three.
		expect(pool.slotStatus).toBe(nominationSlotStatus('Alperen Sengun'));
		expect(pool.slotStatus).toContain('Alperen Sengun');
		// Jalen Green is still an available Player — he is not the problem.
		expect(pool.players.find((p) => p.fantraxPlayerId === 'p-1')?.available).toBe(true);
	});

	it('reports the wrong phase as a Slot-level refusal, naming the phase', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [] });
		const pool = await loadNominatablePool(harness.gateway, 't-1');
		expect(pool.slotAvailable).toBe(false);
		expect(pool.slotDetail).toContain('Setup');
		// The phase is a REFUSAL, not a state of the Slot, so the status stands
		// aside and `slotDetail` speaks. A Slot reported "open for nomination"
		// in Setup would be the page contradicting the gate.
		expect(pool.slotStatus).toBeNull();
	});

	it('reports an unbound actor without inventing a Team id', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });
		const pool = await loadNominatablePool(harness.gateway, null);
		expect(pool.slotAvailable).toBe(false);
		expect(pool.slotDetail).toBe(nominationRefusalDetail({ kind: 'unbound_actor' }));
		expect(pool.slotStatus).toBeNull();
		// Each Player's own availability is still stated.
		expect(pool.players[0]?.available).toBe(true);
	});

	it('renders the consequence sentence for the surface to print verbatim', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });
		const pool = await loadNominatablePool(harness.gateway, 't-1');
		expect(pool.consequence).toContain('Nomination Slot');
		expect(pool.consequence).toContain('No cap space is committed');
	});

	it('returns an empty pool as a state, not an error', async () => {
		const harness = fakeGateway({ pool: [], events: [opened()] });
		const pool = await loadNominatablePool(harness.gateway, 't-1');
		expect(pool.players).toEqual([]);
		expect(pool.slotAvailable).toBe(true);
	});

	it('releases the connection when the read throws', async () => {
		const harness = fakeGateway({
			pool: [JALEN],
			throwOn: /^select \* from auction_events/i
		});

		await expect(loadNominatablePool(harness.gateway, 't-1')).rejects.toThrow();
		expect(harness.state.released).toBe(1);
	});
});

// --- The claim row's deleter, unregistered (Story 2.3) ----------------------

/** One appended event, as `runTransactionalWrite` would hand a projection. */
function appended(seq: number, type: string, payload: unknown): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt: '2026-08-26T09:00:00.000Z',
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: 'm-1',
		teamId: 't-1',
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

describe('releaseNomination — a close ends the seat, a win ends the Slot', () => {
	it('issues ONE delete per claim for one close — the seat by Player, the Slot by winner', async () => {
		const harness = fakeGateway({});

		await releaseNomination(harness.client, [
			appended(50, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1' }))
		]);

		expect(harness.order).toEqual(['release-nomination', 'release-slot']);
		// Both ids are bound parameters, never interpolated into the SQL text —
		// the same discipline every other statement in this module keeps.
		expect(harness.params).toEqual([['p-1'], [CLOSED_TEAM_ID]]);
	});

	it('keys the seat delete on the Player ALONE and the Slot delete on the WINNER', async () => {
		const harness = fakeGateway({});

		await releaseNomination(harness.client, [
			appended(
				50,
				AUCTION_CLOSED_EVENT,
				closedPayload({ fantraxPlayerId: 'p-1', teamId: 't-9', winningAmount: 42, capHit: 42 })
			)
		]);

		// One parameter each, and they are different keys into different
		// tables: the board seat belongs to the Player, the Nomination Slot to
		// the Team that won. Neither statement names the NOMINATOR, who is not
		// on the close at all and whose Slot this does not touch.
		expect(harness.params).toEqual([['p-1'], ['t-9']]);
		expect(harness.params[0]).toHaveLength(1);
		expect(harness.params[1]).toHaveLength(1);
	});

	it('issues NO statement for a NominationPlaced — a claim is not released by being written', async () => {
		const harness = fakeGateway({});

		await releaseNomination(harness.client, [
			appended(50, NOMINATION_PLACED_EVENT, {
				fantraxPlayerId: 'p-1',
				playerName: 'Jalen Green',
				teamId: 't-1',
				teamName: 'Lakers',
				managerId: 'm-1'
			})
		]);

		expect(harness.order).toEqual([]);
		expect(harness.params).toEqual([]);
	});

	it.each([AUCTION_OPENED_EVENT, 'BidPlaced', 'ImportPromoted'])(
		'issues no statement for %s either — only an ending event releases',
		async (type: string) => {
			const harness = fakeGateway({});
			await releaseNomination(harness.client, [appended(50, type, { fantraxPlayerId: 'p-1' })]);
			expect(harness.order).toEqual([]);
		}
	);

	it('issues nothing at all for an empty batch', async () => {
		const harness = fakeGateway({});
		await releaseNomination(harness.client, []);
		expect(harness.order).toEqual([]);
	});

	it('deletes once per close when a batch carries several', async () => {
		const harness = fakeGateway({});

		await releaseNomination(harness.client, [
			appended(50, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1', teamId: 't-a' })),
			appended(51, NOMINATION_PLACED_EVENT, { fantraxPlayerId: 'p-3', teamId: 't-3' }),
			appended(52, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-2', teamId: 't-b' }))
		]);

		expect(harness.order).toEqual([
			'release-nomination',
			'release-slot',
			'release-nomination',
			'release-slot'
		]);
		expect(harness.params).toEqual([['p-1'], ['t-a'], ['p-2'], ['t-b']]);
	});

	it('deletes the SEAT but no Slot for a termination — nobody won, so nobody pays one back', async () => {
		// The whole shape of the amended FR-9 at the data layer. A Slot row
		// deleted here would put the table and the fold in permanent
		// disagreement: `nominationsReducer` leaves `byTeam` untouched on a
		// termination, and an insert-only log can never be replayed to put a
		// deleted claim back.
		const harness = fakeGateway({});

		await releaseNomination(harness.client, [
			appended(50, AUCTION_TERMINATED_EVENT, { fantraxPlayerId: 'p-1' })
		]);

		expect(harness.order).toEqual(['release-nomination']);
		expect(harness.order).not.toContain('release-slot');
		expect(harness.params).toEqual([['p-1']]);
	});

	// The write half of the release must skip exactly what the fold skips.
	// Both read the close through the core's `readClosedFacts`, so this table
	// and the fold's malformed-close table in `tests/core/nomination.test.ts`
	// cannot drift apart: a close the fold tolerates must never abort the
	// transaction appending it, and one the fold skips must never delete a row
	// — of either kind.
	it.each([
		['not an object', 'nonsense'],
		['null', null],
		['a number', 7],
		['no fantraxPlayerId', { winningTeamId: 't-2' }],
		['a blank fantraxPlayerId', { fantraxPlayerId: '' }],
		['a non-string fantraxPlayerId', { fantraxPlayerId: 7 }]
	])('issues NO statement for a close whose payload is %s', async (_label, payload) => {
		const harness = fakeGateway({});

		await expect(
			releaseNomination(harness.client, [appended(50, AUCTION_CLOSED_EVENT, payload)])
		).resolves.toBeUndefined();

		expect(harness.order).toEqual([]);
		expect(harness.params).toEqual([]);
	});

	it('skips a malformed close but still releases a well-formed one in the same batch', async () => {
		// One unusable row in the batch must not cost the release of a Player
		// whose close IS readable.
		const harness = fakeGateway({});

		await releaseNomination(harness.client, [
			appended(50, AUCTION_CLOSED_EVENT, null),
			appended(51, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-2', teamId: 't-b' }))
		]);

		expect(harness.order).toEqual(['release-nomination', 'release-slot']);
		expect(harness.params).toEqual([['p-2'], ['t-b']]);
	});

	it('is idempotent: a Player with no claim row simply affects zero rows, no throw', async () => {
		// The fake returns `{ rows: [] }` for the delete, which is exactly what
		// Postgres gives for a delete that matched nothing. Nothing here reads
		// a row count, and nothing may: a delete that finds nothing has already
		// achieved what it was asked to achieve.
		const harness = fakeGateway({});

		await expect(
			releaseNomination(harness.client, [
				appended(50, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'never-nominated' }))
			])
		).resolves.toBeUndefined();

		await expect(
			releaseNomination(harness.client, [
				appended(51, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'never-nominated' }))
			])
		).resolves.toBeUndefined();

		expect(harness.order).toEqual([
			'release-nomination',
			'release-slot',
			'release-nomination',
			'release-slot'
		]);
	});

	it('never SELECTS from either claim table — the Slot stays a fold of the log', async () => {
		const harness = fakeGateway({});
		await releaseNomination(harness.client, [
			appended(50, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId: 'p-1' }))
		]);
		// The fake has no read branch for `open_nominations` or
		// `nomination_slots` at all and throws on any statement it does not
		// recognise, so a select would have failed this test rather than
		// passing unnoticed.
		expect(harness.order.filter((entry) => entry === 'release-nomination')).toHaveLength(1);
		expect(harness.order.filter((entry) => entry === 'release-slot')).toHaveLength(1);
		expect(harness.order).not.toContain('read-log');
	});

	it('is NOT registered on placeNomination — no production path issues the delete', async () => {
		// AC3: Epic 3 must need no change here, and the delete belongs inside
		// the transaction that appends the close — 3.4's, not this one's.
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });

		await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS);

		expect(harness.order).not.toContain('release-nomination');
		expect(harness.order).not.toContain('release-slot');
		expect(harness.order).toEqual([
			'begin',
			'lock',
			'read-log',
			'read-pool-player',
			'read-contract',
			'append-event',
			'claim-nomination',
			'claim-slot',
			'commit'
		]);
	});
});

// --- The event type has exactly one definition -------------------------------

describe('the nomination event type has exactly one definition', () => {
	it('pins the writer and the fold to the same string', async () => {
		// Two independent literals is how these drift: rename one and every
		// nomination appends an event the fold does not recognise, so every
		// Team's Slot would read as free forever — with a green suite,
		// because each side asserts its own constant.
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });
		const outcome = await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS);
		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;
		expect(outcome.events[0]?.type).toBe(NOMINATION_PLACED_EVENT);
	});
});

/**
 * A Player WON in this auction is under contract (Story 3.4, AC5).
 *
 * `under_contract` has two sources now and one refusal. `team_rosters` answers
 * what a Team started the offseason with; the `AuctionContracts` fold answers
 * what it has won since — and a won Player has NO roster row, because nothing
 * writes `team_rosters` but the import. So a stale pool row for a won Player
 * would be nominatable again if the close were not folded, which is exactly
 * the state this suite pins shut.
 */
describe('under contract, from the contracts fold (Story 3.4)', () => {
	const won = (seq: number, fantraxPlayerId: string, teamName: string) =>
		logEvent(seq, AUCTION_CLOSED_EVENT, {
			fantraxPlayerId,
			playerName: 'Jalen Green',
			teamId: 't-w',
			teamName,
			managerId: 'm-w',
			winningAmount: 8_000_000,
			capHit: 8_000_000,
			placement: 'active_bench',
			contention: 'standard',
			contractYears: null,
			closedAt: '2026-08-26T09:00:00.000Z'
		});

	it('names the WINNING Team as the contract holder, with no roster row at all', async () => {
		const harness = fakeGateway({
			pool: [JALEN],
			events: [opened(), nominated(2, 'p-1', 'Jalen Green', 't-9', 'Celtics'), won(3, 'p-1', 'Rockets')]
		});

		const client = await harness.gateway.connect();
		try {
			await client.query('begin');
			const state = await loadNominationState(client, 'p-1');
			await client.query('rollback');
			// The roster join found nothing — `read-contract` still ran and
			// still came back empty — and the fold answered instead.
			expect(harness.order).toContain('read-contract');
			expect(state.contractHolderTeamName).toBe('Rockets');
		} finally {
			client.release();
		}
	});

	it('refuses the nomination as under_contract, naming that Team', async () => {
		const harness = fakeGateway({
			pool: [JALEN],
			events: [opened(), nominated(2, 'p-1', 'Jalen Green', 't-9', 'Celtics'), won(3, 'p-1', 'Rockets')]
		});

		const outcome = await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS);
		const rejection = rejectionOf(outcome);

		expect(rejection.refusal.kind).toBe('under_contract');
		if (rejection.refusal.kind !== 'under_contract') return;
		expect(rejection.refusal.playerName).toBe('Jalen Green');
		expect(rejection.refusal.teamName).toBe('Rockets');
		// Nothing was written: no event, no claim row.
		expect(harness.appendedEvents).toEqual([]);
		expect(harness.order).not.toContain('claim-nomination');
	});

	it('greys the won Player out on the pool page with the same sentence', async () => {
		const harness = fakeGateway({
			pool: [JALEN, SENGUN],
			events: [opened(), nominated(2, 'p-1', 'Jalen Green', 't-9', 'Celtics'), won(3, 'p-1', 'Rockets')]
		});

		const pool = await loadNominatablePool(harness.gateway, ACTOR.teamId);
		const jalen = pool.players.find((row) => row.fantraxPlayerId === 'p-1');
		const sengun = pool.players.find((row) => row.fantraxPlayerId === 'p-2');

		expect(jalen?.available).toBe(false);
		// The render states the Team holding them; the submit still refuses in
		// `nominationRefusalDetail`'s words, and both come from one core.
		expect(jalen?.status).toBe(
			nominationPoolStatus(
				{ kind: 'under_contract', playerName: 'Jalen Green', teamName: 'Rockets' },
				false
			)
		);
		expect(jalen?.status).toBe('Closed to Rockets');
		// The Player nobody won is untouched.
		expect(sengun?.available).toBe(true);
	});

	it('lets the ROSTER win a tie, because a promoted Player is on a Team for real', async () => {
		const harness = fakeGateway({
			pool: [{ ...JALEN, contractTeamName: 'Lakers' }],
			events: [opened(), nominated(2, 'p-1', 'Jalen Green', 't-9', 'Celtics'), won(3, 'p-1', 'Rockets')]
		});

		const client = await harness.gateway.connect();
		try {
			await client.query('begin');
			const state = await loadNominationState(client, 'p-1');
			await client.query('rollback');
			expect(state.contractHolderTeamName).toBe('Lakers');
		} finally {
			client.release();
		}
	});

	it('leaves an unwon Player nominatable, with neither source naming a holder', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });

		const client = await harness.gateway.connect();
		try {
			await client.query('begin');
			const state = await loadNominationState(client, 'p-1');
			await client.query('rollback');
			expect(state.contractHolderTeamName).toBeNull();
		} finally {
			client.release();
		}
	});
});

// --- The Commissioner exemption, through the transaction (Story 9.8) --------

describe('placeNomination — the Commissioner exemption', () => {
	it('nominates through a Slot its own Team is already holding', async () => {
		// The identical log that refuses `ACTOR` at `slot_in_use` above. The
		// only difference is who is asking.
		const harness = fakeGateway({
			pool: [JALEN, SENGUN],
			events: [opened(), nominated(2, 'p-2', 'Alperen Sengun', 't-1', 'Lakers')]
		});

		const outcome = await placeNomination(harness.gateway, COMMISSIONER, 'p-1', DEVICE_CLASS);

		expect(outcome.kind).toBe('accepted');
		expect(harness.order).toContain('append-event');
		expect(harness.order).toContain('commit');
	});

	it('writes holdsSlot false on the payload, so the fold agrees forever', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });

		const outcome = await placeNomination(harness.gateway, COMMISSIONER, 'p-1', DEVICE_CLASS);
		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;

		const payload = outcome.events[0]?.payload as NominationPlacedPayload;
		expect(payload.holdsSlot).toBe(false);
		// Everything else is an ordinary nomination. The exemption is one
		// boolean, not a second kind of event.
		expect(payload.teamId).toBe('t-1');
		expect(payload.managerId).toBe('m-1');
	});

	it('writes holds_slot false on the claim row, so the index skips it', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });

		const outcome = await placeNomination(harness.gateway, COMMISSIONER, 'p-1', DEVICE_CLASS);
		expect(outcome.kind).toBe('accepted');

		const claimParams = harness.params.find((p) => p.length === 5);
		expect(claimParams?.[4]).toBe(false);
	});

	it('still claims the PLAYER — a Commissioner may not nominate one already on the board', async () => {
		const harness = fakeGateway({
			pool: [JALEN],
			events: [opened(), nominated(2, 'p-1', 'Jalen Green', 't-9', 'Celtics')]
		});

		const rejection = rejectionOf(
			await placeNomination(harness.gateway, COMMISSIONER, 'p-1', DEVICE_CLASS)
		);

		expect(rejection.refusal.kind).toBe('already_nominated');
		expect(rejection.detail).toContain('Celtics');
		expect(harness.appendedEvents).toEqual([]);
	});

	it('is still refused outside the Auction Phase', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [] });

		const rejection = rejectionOf(
			await placeNomination(harness.gateway, COMMISSIONER, 'p-1', DEVICE_CLASS)
		);

		expect(rejection.refusal.kind).toBe('phase');
		expect(harness.appendedEvents).toEqual([]);
	});

	it('is still refused a Player under contract', async () => {
		const harness = fakeGateway({
			pool: [{ ...JALEN, contractTeamName: 'Bulls' }],
			events: [opened()]
		});

		const rejection = rejectionOf(
			await placeNomination(harness.gateway, COMMISSIONER, 'p-1', DEVICE_CLASS)
		);

		expect(rejection.refusal.kind).toBe('under_contract');
		expect(rejection.detail).toContain('Bulls');
	});

	it('holds several open nominations at once, each folded from the log', async () => {
		// Two already placed by this Commissioner's own Team; a third is still
		// accepted, which is the whole ask.
		const harness = fakeGateway({
			pool: [JALEN, SENGUN, BRIGHT],
			events: [
				opened(),
				nominated(2, 'p-1', 'Jalen Green', 't-1', 'Lakers', false),
				nominated(3, 'p-2', 'Alperen Sengun', 't-1', 'Lakers', false)
			]
		});

		const outcome = await placeNomination(harness.gateway, COMMISSIONER, 'p-3', DEVICE_CLASS);
		expect(outcome.kind).toBe('accepted');
	});

	it('does not exempt an ordinary Manager on the same Team', async () => {
		// `ACTOR` and `COMMISSIONER` share a Team on purpose. A Commissioner's
		// open nominations hold no Slot, so they do not block the Manager
		// either — and the Manager's own one still does.
		const harness = fakeGateway({
			pool: [JALEN, SENGUN],
			events: [opened(), nominated(2, 'p-2', 'Alperen Sengun', 't-1', 'Lakers')]
		});

		const rejection = rejectionOf(await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS));
		expect(rejection.refusal.kind).toBe('slot_in_use');
	});
});

describe('loadNominatablePool — the Commissioner exemption', () => {
	it('offers the pool to a Commissioner whose Team already has an open nomination', async () => {
		const harness = fakeGateway({
			pool: [JALEN, SENGUN],
			events: [opened(), nominated(2, 'p-2', 'Alperen Sengun', 't-1', 'Lakers')]
		});

		const pool = await loadNominatablePool(harness.gateway, 't-1', false);

		expect(pool.slotAvailable).toBe(true);
		expect(pool.slotDetail).toBeNull();
		expect(pool.players.find((p) => p.fantraxPlayerId === 'p-1')?.available).toBe(true);
	});

	it('states the absence of a Slot rather than an open one', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });

		const pool = await loadNominatablePool(harness.gateway, 't-1', false);

		expect(pool.slotStatus).toBe(COMMISSIONER_SLOT_STATUS);
		expect(pool.consequence).toBe(commissionerConsequenceSentence(null));
	});

	it('refuses the same Team as a Manager — the default is the Manager rule', async () => {
		const harness = fakeGateway({
			pool: [JALEN, SENGUN],
			events: [opened(), nominated(2, 'p-2', 'Alperen Sengun', 't-1', 'Lakers')]
		});

		const pool = await loadNominatablePool(harness.gateway, 't-1');

		expect(pool.slotAvailable).toBe(false);
		expect(pool.slotStatus).toBe(nominationSlotStatus('Alperen Sengun'));
	});
});
