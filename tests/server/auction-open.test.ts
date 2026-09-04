import { describe, expect, it } from 'vitest';

import { IMPORT_PROMOTED_EVENT as WRITER_IMPORT_PROMOTED_EVENT } from '../../src/lib/server/import-promotion.ts';

import { AUCTION_OPENED_EVENT } from '../../src/lib/core/projection/phase.ts';
import { IMPORT_PROMOTED_EVENT } from '../../src/lib/core/projection/promotion.ts';
import { MINOR_LEAGUE_ELIGIBILITY_SET } from '../../src/lib/core/projection/eligibility.ts';
import { POOL_SOURCE_LABEL } from '../../src/lib/core/rules/pool-import.ts';
import { auctionOpenRefusalDetail } from '../../src/lib/core/rules/auction-open.ts';
import {
	loadAuctionOpenState,
	openAuction,
	readAuctionOpenReport
} from '../../src/lib/server/auction-open.ts';
import type { AuctionOpenRejection, AuctionOpenedPayload } from '../../src/lib/server/auction-open.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

const ACTOR = { managerId: 'm-1', teamId: 't-00' };

const NOW = new Date('2026-08-25T19:00:00.000Z');

type FakeTeam = { id: string; name: string; managerId?: string | null };

/**
 * A stateful fake `ConnectionGateway` in the style of
 * `tests/server/eligibility.test.ts`: it records every statement in order and
 * keeps the appended events in memory, so "no event was appended" and
 * "everything rolled back on a throw" are observable rather than assumed.
 */
function fakeGateway(options: {
	teams?: FakeTeam[];
	events?: QueryResultRow[];
	/** The first statement matching this pattern throws. */
	throwOn?: RegExp;
}) {
	const order: string[] = [];
	const appendedEvents: QueryResultRow[] = [];
	let seq = 10;
	let released = 0;
	let committed = false;

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, params: readonly unknown[] = []) {
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
			if (/^select t\.id, t\.name/i.test(sql)) {
				order.push('read-teams');
				return {
					rows: (options.teams ?? []).map((team) => ({
						id: team.id,
						name: team.name,
						manager_id: team.managerId === undefined ? `mgr-${team.id}` : team.managerId
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

function thirtyTeams(): FakeTeam[] {
	return Array.from({ length: 30 }, (_unused, index) => ({
		id: `t-${String(index).padStart(2, '0')}`,
		name: `Team ${String(index).padStart(2, '0')}`
	}));
}

function logEvent(seq: number, type: string, payload: unknown): QueryResultRow {
	return {
		seq,
		occurred_at: new Date('2026-08-25T08:00:00.000Z'),
		schema_version: 1,
		core_version: 1,
		manager_id: 'm-1',
		team_id: 't-00',
		event_type: type,
		payload
	};
}

function promotionEvent(seq: number, teams: FakeTeam[], poolSize = 400): QueryResultRow {
	return logEvent(seq, IMPORT_PROMOTED_EVENT, {
		teams: teams.map((team) => ({ teamId: team.id, teamName: team.name, rosterCount: 12 })),
		poolSize
	});
}

function rejectionOf(outcome: { kind: string; reason?: unknown }): AuctionOpenRejection {
	expect(outcome.kind).toBe('rejected');
	return outcome.reason as AuctionOpenRejection;
}

// --- The happy path ---------------------------------------------------------

describe('openAuction — ready and confirmed', () => {
	it('appends exactly one AuctionOpened event, stamped and naming the actor', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({ teams, events: [promotionEvent(1, teams)] });

		const outcome = await openAuction(harness.gateway, ACTOR);

		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;
		expect(outcome.events).toHaveLength(1);
		const event = outcome.events[0];
		expect(event?.type).toBe(AUCTION_OPENED_EVENT);
		expect(event?.managerId).toBe(ACTOR.managerId);
		expect(event?.teamId).toBe(ACTOR.teamId);
		// The database clock, read once by the shell (AD-3) — never Date.now().
		expect(event?.occurredAt).toBe(NOW.toISOString());
		expect(event?.schemaVersion).toBe(1);
		expect(event?.coreVersion).toBe(1);
		expect(harness.state.committed).toBe(true);
		expect(harness.state.released).toBe(1);
	});

	it('carries every Team and the confirmed eligible count in the payload', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({
			teams,
			events: [
				promotionEvent(1, teams),
				logEvent(2, MINOR_LEAGUE_ELIGIBILITY_SET, {
					fantraxPlayerId: 'p-1',
					playerName: 'Alice',
					before: false,
					after: true
				})
			]
		});

		const outcome = await openAuction(harness.gateway, ACTOR);
		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;
		const payload = outcome.events[0]?.payload as AuctionOpenedPayload;
		expect(payload.teams).toHaveLength(30);
		expect(payload.teams[0]).toEqual({ teamId: 't-00', teamName: 'Team 00' });
		expect(payload.minorLeagueEligibleCount).toBe(1);
	});

	it('takes the lock and folds the log before it reads any table', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({ teams, events: [promotionEvent(1, teams)] });

		await openAuction(harness.gateway, ACTOR);

		expect(harness.order.indexOf('lock')).toBeLessThan(harness.order.indexOf('read-log'));
		expect(harness.order.indexOf('read-log')).toBeLessThan(harness.order.indexOf('read-teams'));
		expect(harness.order.indexOf('read-teams')).toBeLessThan(
			harness.order.indexOf('append-event')
		);
	});

	it('registers no projection — nothing about this event is persisted anywhere else', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({ teams, events: [promotionEvent(1, teams)] });

		await openAuction(harness.gateway, ACTOR);

		// Every statement the transaction issued, and not one of them writes a
		// slot table, a phase column or a clock row. The fake throws on any
		// statement it does not recognise, which is the other half of this.
		expect(harness.order).toEqual([
			'begin',
			'lock',
			'read-log',
			'read-teams',
			'append-event',
			'commit'
		]);
	});

	it('opens with zero Minor League Eligible Players', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({ teams, events: [promotionEvent(1, teams)] });

		const outcome = await openAuction(harness.gateway, ACTOR);
		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;
		expect((outcome.events[0]?.payload as AuctionOpenedPayload).minorLeagueEligibleCount).toBe(0);
	});
});

// --- The refusals, every one re-derived inside the transaction ---------------

describe('openAuction — the refusals', () => {
	it('refuses when nothing has ever been promoted, and appends nothing', async () => {
		const harness = fakeGateway({ teams: thirtyTeams(), events: [] });

		const rejection = rejectionOf(await openAuction(harness.gateway, ACTOR));

		expect(rejection.refusal.kind).toBe('not_promoted');
		expect(rejection.detail).toBe(auctionOpenRefusalDetail(rejection.refusal));
		expect(harness.order).not.toContain('append-event');
		expect(harness.order).toContain('rollback');
		expect(harness.order).not.toContain('commit');
		expect(harness.appendedEvents).toEqual([]);
		expect(harness.state.released).toBe(1);
	});

	it('refuses a partial promotion, naming each Team it left out', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({ teams, events: [promotionEvent(1, teams.slice(0, 28))] });

		const rejection = rejectionOf(await openAuction(harness.gateway, ACTOR));

		expect(rejection.refusal.kind).toBe('outstanding_sources');
		if (rejection.refusal.kind !== 'outstanding_sources') return;
		expect(rejection.refusal.sourceNames).toEqual(['Team 28', 'Team 29']);
		expect(rejection.detail).toContain('Team 28');
		expect(harness.appendedEvents).toEqual([]);
	});

	it('refuses a promotion that committed no pool Player, naming the pool', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({ teams, events: [promotionEvent(1, teams, 0)] });

		const rejection = rejectionOf(await openAuction(harness.gateway, ACTOR));
		expect(rejection.refusal.kind).toBe('outstanding_sources');
		if (rejection.refusal.kind !== 'outstanding_sources') return;
		expect(rejection.refusal.sourceNames).toEqual([POOL_SOURCE_LABEL]);
	});

	it('refuses a Team with no Manager, by name', async () => {
		const teams = thirtyTeams();
		teams[6] = { ...teams[6]!, managerId: null };
		const harness = fakeGateway({ teams, events: [promotionEvent(1, teams)] });

		const rejection = rejectionOf(await openAuction(harness.gateway, ACTOR));

		expect(rejection.refusal.kind).toBe('unbound_teams');
		if (rejection.refusal.kind !== 'unbound_teams') return;
		expect(rejection.refusal.teamNames).toEqual(['Team 06']);
		expect(rejection.detail).toContain('Team 06');
		expect(harness.appendedEvents).toEqual([]);
	});

	it('refuses once the auction has already opened, naming the folded phase', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({
			teams,
			events: [promotionEvent(1, teams), logEvent(2, AUCTION_OPENED_EVENT, { teams: [] })]
		});

		const rejection = rejectionOf(await openAuction(harness.gateway, ACTOR));

		expect(rejection.refusal.kind).toBe('phase');
		if (rejection.refusal.kind !== 'phase') return;
		// The phase came from the log this transaction read, not from a column.
		expect(rejection.refusal.phase).toBe('Auction');
		expect(rejection.detail).toContain('Auction');
		expect(harness.appendedEvents).toEqual([]);
		expect(harness.order).not.toContain('append-event');
	});

	it('treats a co-managed Team as bound once, not named twice', async () => {
		// Two managers rows may share one team_id — that is co-management.
		const teams = thirtyTeams();
		const harness = fakeGateway({
			teams: [...teams, { id: 't-00', name: 'Team 00', managerId: 'mgr-second' }],
			events: [promotionEvent(1, teams)]
		});

		const outcome = await openAuction(harness.gateway, ACTOR);
		expect(outcome.kind).toBe('accepted');
		if (outcome.kind !== 'accepted') return;
		expect((outcome.events[0]?.payload as AuctionOpenedPayload).teams).toHaveLength(30);
	});

	it('treats a Team whose only extra row has no Manager as bound', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({
			teams: [{ id: 't-00', name: 'Team 00', managerId: null }, ...teams],
			events: [promotionEvent(1, teams)]
		});

		const outcome = await openAuction(harness.gateway, ACTOR);
		expect(outcome.kind).toBe('accepted');
	});
});

// --- A failure mid-transaction ----------------------------------------------

describe('openAuction — a failure mid-write', () => {
	it('rolls back and rethrows, leaving no event and no phase change', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({
			teams,
			events: [promotionEvent(1, teams)],
			throwOn: /^insert into auction_events/i
		});

		await expect(openAuction(harness.gateway, ACTOR)).rejects.toThrow(/failed partway/);

		expect(harness.order).toContain('rollback');
		expect(harness.order).not.toContain('commit');
		expect(harness.appendedEvents).toEqual([]);
		expect(harness.state.released).toBe(1);
	});
});

// --- The read behind the page ----------------------------------------------

describe('readAuctionOpenReport — the render path never writes', () => {
	it('reports ready and rolls back, appending nothing', async () => {
		const teams = thirtyTeams();
		const harness = fakeGateway({ teams, events: [promotionEvent(1, teams)] });

		const { report } = await readAuctionOpenReport(harness.gateway);

		expect(report.ready).toBe(true);
		expect(harness.order).toEqual(['begin', 'read-log', 'read-teams', 'rollback']);
		expect(harness.order).not.toContain('append-event');
		expect(harness.order).not.toContain('commit');
		expect(harness.state.released).toBe(1);
	});

	it('names every outstanding item for the page', async () => {
		const teams = thirtyTeams();
		teams[2] = { ...teams[2]!, managerId: null };
		const harness = fakeGateway({ teams, events: [promotionEvent(1, teams.slice(0, 29), 0)] });

		const { report } = await readAuctionOpenReport(harness.gateway);

		expect(report.ready).toBe(false);
		expect(report.outstandingSources).toEqual(['Team 29', POOL_SOURCE_LABEL]);
		expect(report.unboundTeams).toEqual(['Team 02']);
		expect(report.eligibilitySentence).toContain('No Player is marked');
	});

	it('releases the connection when the read throws', async () => {
		const harness = fakeGateway({ teams: thirtyTeams(), throwOn: /^select \* from auction_events/i });

		await expect(readAuctionOpenReport(harness.gateway)).rejects.toThrow();
		expect(harness.state.released).toBe(1);
	});
});

describe('the promotion event type has exactly one definition', () => {
	it('pins the writer and the fold to the same string', () => {
		// Two independent literals is how these drift: rename one and every
		// promotion appends an event the gate does not recognise, so a fully
		// promoted League refuses forever with "no import has been promoted"
		// — with a green suite, because each side asserts its own constant.
		expect(WRITER_IMPORT_PROMOTED_EVENT).toBe(IMPORT_PROMOTED_EVENT);
	});
});

describe('loadAuctionOpenState — the promoted-ness question', () => {
	it('never reads a status column: staged is not promoted', async () => {
		// Every source `'staged'` and nothing promoted must still refuse. The
		// fake has no `import_team_sources` statement at all, so a loader that
		// tried to read one would fail loudly rather than pass by accident.
		const harness = fakeGateway({ teams: thirtyTeams(), events: [] });
		await harness.client.query('begin');
		const state = await loadAuctionOpenState(harness.client);
		expect(state.promotion.promoted).toBe(false);
		expect(state.phase).toBe('Setup');
		expect(state.teams).toHaveLength(30);
	});
});
