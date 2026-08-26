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

import { NOMINATION_PLACED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { AUCTION_OPENED_EVENT } from '../../src/lib/core/projection/phase.ts';
import { nominationRefusalDetail } from '../../src/lib/core/rules/nomination.ts';
import { loadNominatablePool, loadNominationState, placeNomination } from '../../src/lib/server/nomination.ts';
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

function fakeGateway(options: {
	pool?: FakePoolPlayer[];
	events?: QueryResultRow[];
	throwOn?: RegExp;
}) {
	const order: string[] = [];
	const params: unknown[][] = [];
	const appendedEvents: QueryResultRow[] = [];
	let seq = 40;
	let released = 0;
	let committed = false;

	const pool = options.pool ?? [];

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, queryParams: readonly unknown[] = []) {
			const sql = text.trim();
			if (options.throwOn !== undefined && options.throwOn.test(sql)) {
				order.push('throw');
				throw new Error('the insert failed partway');
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
				return { rows: options.events ?? [] };
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

	it('registers no projection — nothing about this event is persisted anywhere else', async () => {
		const harness = fakeGateway({ pool: [JALEN], events: [opened()] });

		await placeNomination(harness.gateway, ACTOR, 'p-1', DEVICE_CLASS);

		// Every statement the transaction issued, and not one of them writes a
		// slot table, a board table or a clock row. The fake throws on any
		// statement it does not recognise, which is the other half of this.
		expect(harness.order).toEqual([
			'begin',
			'lock',
			'read-log',
			'read-pool-player',
			'read-contract',
			'append-event',
			'commit'
		]);
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
