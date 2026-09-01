import { describe, expect, it, vi } from 'vitest';

import { EnqueueError, runTransactionalWrite, toAppendedEvent } from '../src/lib/shell/write.ts';
import type {
	ConnectionGateway,
	Decision,
	EnqueueFn,
	ProjectionUpdater,
	QueryResultRow,
	TransactionalClient
} from '../src/lib/shell/write.ts';
import type { AppendedEvent, EventEnvelope } from '../src/lib/core/types.ts';
import { CORE_VERSION, EVENT_SCHEMA_VERSION, GLOBAL_WRITE_LOCK_KEY } from '../src/lib/core/constants.ts';

const NOW = new Date('2026-08-21T12:00:00.000Z');

/**
 * A fake `ConnectionGateway`. Every query is recorded, in order, into
 * `order` (plus `queries`, the raw SQL, for the statements the order alone
 * does not distinguish) so a test can assert the pipeline's exact sequence
 * rather than merely that each step happened somewhere.
 */
function fakeGateway(): {
	gateway: ConnectionGateway;
	order: string[];
	queries: string[];
	released: boolean[];
} {
	const order: string[] = [];
	const queries: string[] = [];
	const released: boolean[] = [];
	let nextSeq = 1;

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, params?: readonly unknown[]) {
			const sql = text.trim();
			queries.push(sql);

			if (/^begin/i.test(sql)) {
				order.push('begin');
				return { rows: [] };
			}
			if (/^commit/i.test(sql)) {
				order.push('commit');
				return { rows: [] };
			}
			if (/^rollback/i.test(sql)) {
				order.push('rollback');
				return { rows: [] };
			}
			if (/pg_advisory_xact_lock/i.test(sql)) {
				order.push('lock');
				return { rows: [{ locked: '', now: NOW }] };
			}
			if (/insert into auction_events/i.test(sql)) {
				order.push('persist');
				const p = params ?? [];
				const row: QueryResultRow = {
					seq: String(nextSeq++),
					occurred_at: p[0],
					schema_version: p[1],
					core_version: p[2],
					manager_id: p[3],
					team_id: p[4],
					event_type: p[5],
					payload: JSON.parse(String(p[6])),
					device_class: p[7] ?? null,
					dispatch_outcome: p[8] ?? null,
					delivery_outcome: p[9] ?? null
				};
				return { rows: [row] };
			}
			throw new Error(`fakeGateway: unexpected query: ${sql}`);
		},
		release() {
			released.push(true);
		}
	};

	const gateway: ConnectionGateway = {
		connect: async () => client
	};

	return { gateway, order, queries, released };
}

const acceptedEvent: EventEnvelope = {
	type: 'Test.Event',
	payload: { note: 'hello' },
	managerId: 'm-1',
	teamId: 't-1'
};

describe('runTransactionalWrite — the accepted path', () => {
	it('runs the pipeline in exactly the order lock -> load -> decide -> persist -> enqueue', async () => {
		// `load`/`decide`/`enqueue` push into the SAME `order` array the SQL-level
		// steps (`begin`/`lock`/`persist`/`commit`) push into, rather than a
		// separate array asserted independently. Two arrays asserted separately
		// would stay green even if, say, `load` ran before `lock` — each array's
		// own internal order would still look right in isolation. One shared
		// array spanning both is what actually proves AD-6's guarantee: the lock
		// strictly precedes any state read, and the whole pipeline runs in
		// exactly this order end to end.
		const { gateway, order } = fakeGateway();

		const load = async () => {
			order.push('load');
			return { anything: true };
		};
		const decide = async (): Promise<Decision> => {
			order.push('decide');
			return { kind: 'accepted', events: [acceptedEvent] };
		};
		const enqueue: EnqueueFn = async () => {
			order.push('enqueue');
		};

		await runTransactionalWrite({ gateway, load, decide, enqueue });

		expect(order).toEqual(['begin', 'lock', 'load', 'decide', 'persist', 'commit', 'enqueue']);
	});

	it('takes the lock with the exact GLOBAL_WRITE_LOCK_KEY constant, verbatim', async () => {
		const { gateway, queries } = fakeGateway();
		let capturedParams: readonly unknown[] | undefined;
		const originalConnect = gateway.connect.bind(gateway);
		const spiedGateway: ConnectionGateway = {
			connect: async () => {
				const client = await originalConnect();
				const originalQuery = client.query.bind(client);
				return {
					...client,
					query: async (text: string, params?: readonly unknown[]) => {
						if (/pg_advisory_xact_lock/i.test(text)) capturedParams = params;
						return originalQuery(text, params);
					}
				};
			}
		};

		await runTransactionalWrite({
			gateway: spiedGateway,
			load: async () => ({}),
			decide: async (): Promise<Decision> => ({ kind: 'accepted', events: [acceptedEvent] })
		});

		expect(queries.some((q) => /pg_advisory_xact_lock/i.test(q))).toBe(true);
		expect(capturedParams).toEqual([GLOBAL_WRITE_LOCK_KEY.toString()]);
	});

	it('reads now from the database clock once, and stamps every appended event with it', async () => {
		const { gateway } = fakeGateway();
		let sawNow: Date | undefined;

		const result = await runTransactionalWrite({
			gateway,
			load: async () => ({}),
			decide: async (input): Promise<Decision> => {
				sawNow = input.now;
				return { kind: 'accepted', events: [acceptedEvent, acceptedEvent] };
			}
		});

		expect(sawNow).toEqual(NOW);
		expect(result.kind).toBe('accepted');
		if (result.kind === 'accepted') {
			for (const appended of result.events) {
				expect(appended.occurredAt).toBe(NOW.toISOString());
			}
		}
	});

	it('stamps schemaVersion and coreVersion from the core constants, never from the caller', async () => {
		const { gateway } = fakeGateway();
		const result = await runTransactionalWrite({
			gateway,
			load: async () => ({}),
			decide: async (): Promise<Decision> => ({ kind: 'accepted', events: [acceptedEvent] })
		});

		expect(result.kind).toBe('accepted');
		if (result.kind === 'accepted') {
			expect(result.events[0]?.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
			expect(result.events[0]?.coreVersion).toBe(CORE_VERSION);
		}
	});

	it('assigns each persisted event a distinct database seq, in insertion order', async () => {
		const { gateway } = fakeGateway();
		const result = await runTransactionalWrite({
			gateway,
			load: async () => ({}),
			decide: async (): Promise<Decision> => ({
				kind: 'accepted',
				events: [
					{ ...acceptedEvent, type: 'First' },
					{ ...acceptedEvent, type: 'Second' }
				]
			})
		});

		expect(result.kind).toBe('accepted');
		if (result.kind === 'accepted') {
			expect(result.events.map((e) => e.type)).toEqual(['First', 'Second']);
			expect(result.events.map((e) => e.seq)).toEqual(['1', '2']);
		}
	});

	it('folds every registered projection, in the same transaction, after persist and before commit', async () => {
		const { gateway, order } = fakeGateway();
		const seenByProjection: readonly AppendedEvent[][] = [];
		const projection: ProjectionUpdater = async (_client, appended) => {
			order.push('projection');
			(seenByProjection as AppendedEvent[][]).push([...appended]);
		};

		await runTransactionalWrite({
			gateway,
			load: async () => ({}),
			decide: async (): Promise<Decision> => ({ kind: 'accepted', events: [acceptedEvent] }),
			projections: [projection]
		});

		expect(order).toEqual(['begin', 'lock', 'persist', 'projection', 'commit']);
		expect(seenByProjection).toHaveLength(1);
		expect(seenByProjection[0]).toHaveLength(1);
	});

	it('releases the client after a successful commit', async () => {
		const { gateway, released } = fakeGateway();
		await runTransactionalWrite({
			gateway,
			load: async () => ({}),
			decide: async (): Promise<Decision> => ({ kind: 'accepted', events: [acceptedEvent] })
		});
		expect(released).toEqual([true]);
	});
});

describe('runTransactionalWrite — the rejected path', () => {
	it('rolls back, persists nothing, and never calls enqueue', async () => {
		const { gateway, order } = fakeGateway();
		const enqueue = vi.fn();

		const result = await runTransactionalWrite({
			gateway,
			load: async () => ({}),
			decide: async (): Promise<Decision> => ({ kind: 'rejected', reason: 'cap exceeded' }),
			enqueue
		});

		expect(result).toEqual({ kind: 'rejected', reason: 'cap exceeded' });
		expect(order).toEqual(['begin', 'lock', 'rollback']);
		expect(enqueue).not.toHaveBeenCalled();
	});

	it('never runs a registered projection on rejection', async () => {
		const { gateway } = fakeGateway();
		const projection = vi.fn(async () => {});

		await runTransactionalWrite({
			gateway,
			load: async () => ({}),
			decide: async (): Promise<Decision> => ({ kind: 'rejected' }),
			projections: [projection]
		});

		expect(projection).not.toHaveBeenCalled();
	});

	it('releases the client after a rollback', async () => {
		const { gateway, released } = fakeGateway();
		await runTransactionalWrite({
			gateway,
			load: async () => ({}),
			decide: async (): Promise<Decision> => ({ kind: 'rejected' })
		});
		expect(released).toEqual([true]);
	});

	it('rejection is a returned value: decide is never made to throw to express it', async () => {
		// This is a documentation-style assertion: the Decision type itself has
		// no throwing variant, so a rejection can only ever reach the caller as
		// the returned { kind: 'rejected' } shape asserted above.
		const decision: Decision = { kind: 'rejected', reason: 'because' };
		expect(decision.kind).toBe('rejected');
	});
});

describe('runTransactionalWrite — a thrown error is a bug, not a rejection', () => {
	it('rolls back and propagates when load throws', async () => {
		const { gateway, order, released } = fakeGateway();

		await expect(
			runTransactionalWrite({
				gateway,
				load: async () => {
					throw new Error('load exploded');
				},
				decide: async (): Promise<Decision> => ({ kind: 'accepted', events: [acceptedEvent] })
			})
		).rejects.toThrow('load exploded');

		expect(order).toEqual(['begin', 'lock', 'rollback']);
		expect(released).toEqual([true]);
	});

	it('rolls back and propagates when decide throws', async () => {
		const { gateway, order } = fakeGateway();

		await expect(
			runTransactionalWrite({
				gateway,
				load: async () => ({}),
				decide: async (): Promise<Decision> => {
					throw new Error('decide exploded');
				}
			})
		).rejects.toThrow('decide exploded');

		expect(order).toEqual(['begin', 'lock', 'rollback']);
	});

	it('rolls back and propagates when a registered projection updater throws, after persist and before commit', async () => {
		const { gateway, order } = fakeGateway();
		const projection: ProjectionUpdater = async () => {
			order.push('projection');
			throw new Error('projection exploded');
		};

		await expect(
			runTransactionalWrite({
				gateway,
				load: async () => ({}),
				decide: async (): Promise<Decision> => ({ kind: 'accepted', events: [acceptedEvent] }),
				projections: [projection]
			})
		).rejects.toThrow('projection exploded');

		// persist already ran (the events were inserted against the client) but
		// commit never did — the projection failure rolls the whole transaction
		// back, discarding the insert along with the projection's own write.
		expect(order).toEqual(['begin', 'lock', 'persist', 'projection', 'rollback']);
	});

	it('releases the client even when rollback itself fails', async () => {
		const { gateway, released } = fakeGateway();
		const originalConnect = gateway.connect.bind(gateway);
		const brokenRollbackGateway: ConnectionGateway = {
			connect: async () => {
				const client = await originalConnect();
				return {
					...client,
					query: async (text: string, params?: readonly unknown[]) => {
						if (/^rollback/i.test(text.trim())) throw new Error('connection already gone');
						return client.query(text, params);
					}
				};
			}
		};

		await expect(
			runTransactionalWrite({
				gateway: brokenRollbackGateway,
				load: async () => {
					throw new Error('load exploded');
				},
				decide: async (): Promise<Decision> => ({ kind: 'accepted', events: [acceptedEvent] })
			})
		).rejects.toThrow('load exploded');

		expect(released).toEqual([true]);
	});
});

describe('runTransactionalWrite — a throwing enqueue, after a successful commit', () => {
	it('never attempts a rollback against the already-committed transaction, and lets the caller recover the accepted outcome', async () => {
		const { gateway, order } = fakeGateway();
		const enqueue: EnqueueFn = async () => {
			throw new Error('outbox unreachable');
		};

		let thrown: unknown;
		try {
			await runTransactionalWrite({
				gateway,
				load: async () => ({}),
				decide: async (): Promise<Decision> => ({ kind: 'accepted', events: [acceptedEvent] }),
				enqueue
			});
		} catch (error) {
			thrown = error;
		}

		// commit already happened, and nothing after it attempts a rollback —
		// a `ROLLBACK` against an already-committed transaction would be the
		// bug this test exists to catch.
		expect(order).toEqual(['begin', 'lock', 'persist', 'commit']);

		expect(thrown).toBeInstanceOf(EnqueueError);
		const enqueueError = thrown as EnqueueError;
		expect(enqueueError.cause).toBeInstanceOf(Error);
		expect((enqueueError.cause as Error).message).toBe('outbox unreachable');

		// the caller does not lose the fact that the write was accepted: the
		// persisted, seq-assigned events are still reachable off the thrown
		// error.
		expect(enqueueError.outcome.kind).toBe('accepted');
		expect(enqueueError.outcome.events).toHaveLength(1);
		expect(enqueueError.outcome.events[0]?.type).toBe('Test.Event');
	});
});

// --- the actor pair, which may be null TOGETHER (Story 3.7) ----------------

/**
 * `toAppendedEvent`'s row mapping for the two actor columns.
 *
 * **Tested directly because nothing else can catch a regression here yet.** No
 * consumer reads `AppendedEvent.managerId` today — the Audit Log that will
 * (Story 7.5) does not exist — so a return to `String(row['manager_id'])`
 * would map a null column to the four-character string `"null"`, which is
 * truthy, passes every `!== null` check, and would surface as an actor
 * literally named "null" on the first surface that ever renders one. Nothing
 * in the suite would go red in between.
 *
 * `20260901000000_system_actor.sql` made the pair nullable together, and
 * `ContractAssignmentOpened` is the first event that writes it that way.
 */
describe('toAppendedEvent — the actor pair', () => {
	/** One `auction_events` row, as `pg` or a fake hands it back. */
	function row(overrides: Partial<QueryResultRow> = {}): QueryResultRow {
		return {
			seq: 7,
			occurred_at: NOW,
			schema_version: EVENT_SCHEMA_VERSION,
			core_version: CORE_VERSION,
			manager_id: 'm-1',
			team_id: 't-1',
			event_type: 'Test.Event',
			payload: { fantraxPlayerId: 'p-1' },
			device_class: null,
			dispatch_outcome: null,
			delivery_outcome: null,
			...overrides
		};
	}

	it('carries a Manager’s act through unchanged', () => {
		const event = toAppendedEvent(row());
		expect(event.managerId).toBe('m-1');
		expect(event.teamId).toBe('t-1');
	});

	it('maps a null actor pair to null, and NEVER to the string "null"', () => {
		const event = toAppendedEvent(row({ manager_id: null, team_id: null }));

		expect(event.managerId).toBeNull();
		expect(event.teamId).toBeNull();
		// Stated separately, because this is the specific regression: `String`
		// on a null column produces text that every null check passes.
		expect(event.managerId).not.toBe('null');
		expect(event.teamId).not.toBe('null');
	});

	it('maps an ABSENT actor column to null too, as it does for the measurement columns', () => {
		// A driver that omits a column is saying the same thing as one that
		// returns it null, and the two must not read back differently.
		const { manager_id: _m, team_id: _t, ...withoutActor } = row();
		const event = toAppendedEvent(withoutActor);

		expect(event.managerId).toBeNull();
		expect(event.teamId).toBeNull();
	});

	it('leaves every other field of the mapping alone', () => {
		// `seq` is still stringified — `pg` returns `int8` as a string and the
		// fold orders by `BigInt(seq)` — and the payload is passed through as
		// the driver handed it over.
		const event = toAppendedEvent(row({ manager_id: null, team_id: null }));

		expect(event.seq).toBe('7');
		expect(event.occurredAt).toBe(NOW.toISOString());
		expect(event.type).toBe('Test.Event');
		expect(event.payload).toEqual({ fantraxPlayerId: 'p-1' });
		expect(event.deviceClass).toBeNull();
	});
});
