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

import {
	AUCTION_CLOSED_EVENT,
	NOMINATION_PLACED_EVENT
} from '../../src/lib/core/projection/nominations.ts';
import { AUCTION_OPENED_EVENT } from '../../src/lib/core/projection/phase.ts';
import { nominationRefusalDetail } from '../../src/lib/core/rules/nomination.ts';
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

const ACTOR = { managerId: 'm-1', teamId: 't-1', teamName: 'Lakers' };

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
			// The claim row's deleter (Story 2.3). Registered by no production
			// call site — `releaseNomination` is driven directly by the tests
			// below — but the fake must recognise the statement, or the very
			// thing under test would read as "unexpected statement".
			if (/^delete from open_nominations/i.test(sql)) {
				order.push('release-nomination');
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
		core_version: 1,
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
	teamName: string
): QueryResultRow {
	return logEvent(seq, NOMINATION_PLACED_EVENT, {
		fantraxPlayerId,
		playerName,
		teamId,
		teamName,
		managerId: 'm-9'
	});
}

const JALEN: FakePoolPlayer = { fantraxPlayerId: 'p-1', playerName: 'Jalen Green' };
const SENGUN: FakePoolPlayer = { fantraxPlayerId: 'p-2', playerName: 'Alperen Sengun' };

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
		expect(event?.coreVersion).toBe(1);
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
			managerId: 'm-1'
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

		// Every statement the transaction issued. The claim insert sits
		// between the event and the commit, so the two commit together or roll
		// back together — and no slot table, board table or clock row is
		// written anywhere. The fake throws on any statement it does not
		// recognise, which is the other half of this.
		expect(harness.order).toEqual([
			'begin',
			'lock',
			'read-log',
			'read-pool-player',
			'read-contract',
			'append-event',
			'claim-nomination',
			'commit'
		]);
	});

	it('writes the claim from the appended event — Player, Team, seq and clock', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });

		const outcome = await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS);
		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;

		const claimParams = harness.params.find((p) => p.length === 4);
		expect(claimParams).toEqual([
			'p-1',
			't-1',
			outcome.events[0]?.seq,
			outcome.events[0]?.occurredAt
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
			throwPg: {
				on: /^insert into open_nominations/i,
				code: '23505',
				constraint: 'open_nominations_team_id_key'
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
		expect(pool.players.every((p) => p.unavailableDetail === null)).toBe(true);
		expect(pool.slotAvailable).toBe(true);
		expect(pool.slotDetail).toBeNull();
	});

	it('marks an already-nominated Player unavailable, in the core’s words', async () => {
		const harness = fakeGateway({
			pool: [JALEN, SENGUN],
			events: [opened(), nominated(2, 'p-1', 'Jalen Green', 't-9', 'Celtics')]
		});

		const pool = await loadNominatablePool(harness.gateway, 't-1');

		const jalen = pool.players.find((p) => p.fantraxPlayerId === 'p-1');
		expect(jalen?.available).toBe(false);
		expect(jalen?.unavailableDetail).toContain('Celtics');
		// The other Player is untouched.
		expect(pool.players.find((p) => p.fantraxPlayerId === 'p-2')?.available).toBe(true);
	});

	it('marks a Player under contract unavailable, naming the Team', async () => {
		const harness = fakeGateway({
			pool: [{ ...JALEN, contractTeamName: 'Bulls' }],
			events: [opened()]
		});
		const pool = await loadNominatablePool(harness.gateway, 't-1');
		expect(pool.players[0]?.available).toBe(false);
		expect(pool.players[0]?.unavailableDetail).toContain('Bulls');
	});

	it('reports a held Slot ONCE, not as every Player being unavailable', async () => {
		const harness = fakeGateway({
			pool: [JALEN, SENGUN],
			events: [opened(), nominated(2, 'p-2', 'Alperen Sengun', 't-1', 'Lakers')]
		});

		const pool = await loadNominatablePool(harness.gateway, 't-1');

		expect(pool.slotAvailable).toBe(false);
		expect(pool.slotDetail).toContain('Alperen Sengun');
		// Jalen Green is still an available Player — he is not the problem.
		expect(pool.players.find((p) => p.fantraxPlayerId === 'p-1')?.available).toBe(true);
	});

	it('reports the wrong phase as a Slot-level refusal, naming the phase', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [] });
		const pool = await loadNominatablePool(harness.gateway, 't-1');
		expect(pool.slotAvailable).toBe(false);
		expect(pool.slotDetail).toContain('Setup');
	});

	it('reports an unbound actor without inventing a Team id', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });
		const pool = await loadNominatablePool(harness.gateway, null);
		expect(pool.slotAvailable).toBe(false);
		expect(pool.slotDetail).toBe(nominationRefusalDetail({ kind: 'unbound_actor' }));
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

describe('releaseNomination — the claim row is deleted when the Auction closes', () => {
	it('issues exactly ONE delete for one close, keyed on the Player as a parameter', async () => {
		const harness = fakeGateway({});

		await releaseNomination(harness.client, [
			appended(50, AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'p-1' })
		]);

		expect(harness.order).toEqual(['release-nomination']);
		// The Player id is a bound parameter, never interpolated into the SQL
		// text — the same discipline every other statement in this module keeps.
		expect(harness.params).toEqual([['p-1']]);
	});

	it('keys on the Player ALONE — the Team is never named in the statement', async () => {
		const harness = fakeGateway({});

		await releaseNomination(harness.client, [
			appended(50, AUCTION_CLOSED_EVENT, {
				fantraxPlayerId: 'p-1',
				winningTeamId: 't-9',
				price: 42
			})
		]);

		// The Slot frees whoever won, so the delete carries one parameter and
		// it is the Player. A team id here would be the wrong key.
		expect(harness.params).toEqual([['p-1']]);
		expect(harness.params[0]).toHaveLength(1);
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
		'issues no statement for %s either — only a close releases',
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
			appended(50, AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'p-1' }),
			appended(51, NOMINATION_PLACED_EVENT, { fantraxPlayerId: 'p-3', teamId: 't-3' }),
			appended(52, AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'p-2' })
		]);

		expect(harness.order).toEqual(['release-nomination', 'release-nomination']);
		expect(harness.params).toEqual([['p-1'], ['p-2']]);
	});

	// The write half of the release must skip exactly what the fold skips.
	// Both read the close through the core's `readClosedPlayerId`, so this
	// table and the fold's malformed-close table in `tests/core/nomination.test.ts`
	// cannot drift apart: a close the fold tolerates must never abort the
	// transaction appending it, and one the fold skips must never delete a row.
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
		// One unusable row in the batch must not cost the Slot of a Player
		// whose close IS readable.
		const harness = fakeGateway({});

		await releaseNomination(harness.client, [
			appended(50, AUCTION_CLOSED_EVENT, null),
			appended(51, AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'p-2' })
		]);

		expect(harness.order).toEqual(['release-nomination']);
		expect(harness.params).toEqual([['p-2']]);
	});

	it('is idempotent: a Player with no claim row simply affects zero rows, no throw', async () => {
		// The fake returns `{ rows: [] }` for the delete, which is exactly what
		// Postgres gives for a delete that matched nothing. Nothing here reads
		// a row count, and nothing may: a delete that finds nothing has already
		// achieved what it was asked to achieve.
		const harness = fakeGateway({});

		await expect(
			releaseNomination(harness.client, [
				appended(50, AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'never-nominated' })
			])
		).resolves.toBeUndefined();

		await expect(
			releaseNomination(harness.client, [
				appended(51, AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'never-nominated' })
			])
		).resolves.toBeUndefined();

		expect(harness.order).toEqual(['release-nomination', 'release-nomination']);
	});

	it('never SELECTS from the claim table — the Slot stays a fold of the log', async () => {
		const harness = fakeGateway({});
		await releaseNomination(harness.client, [
			appended(50, AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'p-1' })
		]);
		// The fake has no read branch for `open_nominations` at all and throws
		// on any statement it does not recognise, so a select would have failed
		// this test rather than passing unnoticed.
		expect(harness.order.filter((s) => s === 'release-nomination')).toHaveLength(1);
		expect(harness.order).not.toContain('read-log');
	});

	it('is NOT registered on placeNomination — no production path issues the delete', async () => {
		// AC3: Epic 3 must need no change here, and the delete belongs inside
		// the transaction that appends the close — 3.4's, not this one's.
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });

		await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS);

		expect(harness.order).not.toContain('release-nomination');
		expect(harness.order).toEqual([
			'begin',
			'lock',
			'read-log',
			'read-pool-player',
			'read-contract',
			'append-event',
			'claim-nomination',
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
		expect(jalen?.unavailableDetail).toContain('under contract to Rockets');
		// The render and the submit word one refusal, from one core function.
		expect(jalen?.unavailableDetail).toBe(
			nominationRefusalDetail({
				kind: 'under_contract',
				playerName: 'Jalen Green',
				teamName: 'Rockets'
			})
		);
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
