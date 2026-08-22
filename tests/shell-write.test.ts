import { describe, expect, it, vi } from 'vitest';

import { EnqueueError, runTransactionalWrite } from '../src/lib/shell/write.ts';
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
