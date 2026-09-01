/**
 * `runTick` — the sweep, the drain and the heartbeat (Story 3.5).
 *
 * The stateful fake `ConnectionGateway` is `tests/server/close.test.ts`'s,
 * narrowed to what the sweep itself issues: a bare clock read, the full-log
 * read, and the heartbeat insert. It throws on any statement it does not
 * recognise, which is what makes "the sweep takes no lock" and "the sweep
 * writes nothing but a heartbeat" provable rather than merely unasserted.
 *
 * `closeOne` is a fake here, not the real `closeAuction`. That is the seam the
 * sweep is designed around — `runTick` decides WHICH Auctions to offer and in
 * what order, and `closeAuction` decides what a close IS — so these tests can
 * make a close throw, count, or observe the log as it stood when it was
 * called, none of which a real transaction would let them do. The two halves
 * meet for real in `tests/server/sweep-sequential.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { CORE_VERSION, MINIMUM_BID } from '../../src/lib/core/constants.ts';
import { BID_PLACED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { runTick } from '../../src/lib/server/sweep.ts';
import type { TickSummary } from '../../src/lib/server/sweep.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

const NOW = new Date('2026-08-27T12:00:00.000Z');

/** One heartbeat insert, as the fake recorded its parameters. */
type Heartbeat = {
	ranAt: unknown;
	outcome: unknown;
	closed: unknown;
	skipped: unknown;
	failed: unknown;
	tickCoreVersion: unknown;
	logCoreVersion: unknown;
	detail: unknown;
};

function fakeGateway(options: { events?: QueryResultRow[]; now?: Date; clockThrows?: boolean; logThrows?: boolean } = {}) {
	const order: string[] = [];
	const heartbeats: Heartbeat[] = [];
	// Mutable, so a `closeOne` can append to the log the way a committed
	// transaction would and the next pass sees it.
	const events: QueryResultRow[] = [...(options.events ?? [])];
	let connections = 0;
	let released = 0;

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, params: readonly unknown[] = []) {
			const sql = text.trim();
			if (/^select now\(\) as now$/i.test(sql)) {
				order.push('clock');
				if (options.clockThrows === true) throw new Error('the clock read failed');
				return { rows: [{ now: options.now ?? NOW }] };
			}
			if (/^select \* from auction_events/i.test(sql)) {
				order.push('read-log');
				if (options.logThrows === true) throw new Error('auction_events is unreadable');
				return { rows: [...events] };
			}
			if (/^insert into tick_heartbeats/i.test(sql)) {
				order.push('heartbeat');
				// **The fake refuses what Postgres refuses.** `closed`,
				// `skipped`, `failed`, `tick_core_version` and
				// `log_core_version` are `integer` columns in
				// 20260831000000_tick.sql. An untyped fake once accepted
				// `Number.NaN` here and the suite went green while the real
				// database answered `invalid input syntax for type integer:
				// "NaN"` — so the one refusal the version gate exists to record
				// was the one refusal that could not write its own row. A fake
				// looser than the schema it stands in for proves nothing.
				for (const [index, column] of [
					[2, 'closed'],
					[3, 'skipped'],
					[4, 'failed'],
					[5, 'tick_core_version'],
					[6, 'log_core_version']
				] as const) {
					const value = params[index];
					const nullable = column.endsWith('core_version');
					if (value === null && nullable) continue;
					if (typeof value !== 'number' || !Number.isInteger(value)) {
						throw new Error(
							`invalid input syntax for type integer: ${JSON.stringify(String(value))} ` +
								`(bound to ${column})`
						);
					}
				}
				heartbeats.push({
					ranAt: params[0],
					outcome: params[1],
					closed: params[2],
					skipped: params[3],
					failed: params[4],
					tickCoreVersion: params[5],
					logCoreVersion: params[6],
					detail: params[7]
				});
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
			connections += 1;
			return client;
		}
	};

	return {
		gateway,
		order,
		heartbeats,
		events,
		state: {
			get connections() {
				return connections;
			},
			get released() {
				return released;
			}
		}
	};
}

let nextSeq = 0;

function logEvent(type: string, payload: unknown, coreVersion = CORE_VERSION): QueryResultRow {
	nextSeq += 1;
	return {
		seq: nextSeq,
		occurred_at: new Date('2026-08-26T09:00:00.000Z'),
		schema_version: 1,
		core_version: coreVersion,
		manager_id: 'm-1',
		team_id: 't-1',
		event_type: type,
		payload
	};
}

const bid = (
	fantraxPlayerId: string,
	closesAt: string,
	amount = 2_000_000,
	extra: Record<string, unknown> = {}
): QueryResultRow =>
	logEvent(BID_PLACED_EVENT, {
		fantraxPlayerId,
		teamId: 't-1',
		teamName: 'Team One',
		managerId: 'm-1',
		amount,
		closesAt,
		...extra
	});

const closeEvent = (fantraxPlayerId: string): QueryResultRow =>
	logEvent(AUCTION_CLOSED_EVENT, {
		fantraxPlayerId,
		playerName: fantraxPlayerId,
		teamId: 't-1',
		teamName: 'Team One',
		managerId: 'm-1',
		winningAmount: 2_000_000,
		capHit: 2_000_000,
		placement: 'active_bench',
		contention: 'standard',
		contractYears: null,
		closedAt: '2026-08-27T08:00:00.000Z'
	});

/** The one heartbeat a pass owes, asserted to be exactly one. */
function soleHeartbeat(harness: ReturnType<typeof fakeGateway>): Heartbeat {
	expect(harness.heartbeats).toHaveLength(1);
	const row = harness.heartbeats[0];
	if (row === undefined) throw new Error('no heartbeat written');
	return row;
}

/** A `closeOne` that records what it was asked to close and always succeeds. */
function recordingCloser() {
	const asked: string[] = [];
	return {
		asked,
		closeOne: async (fantraxPlayerId: string) => {
			asked.push(fantraxPlayerId);
		}
	};
}

describe('runTick — nothing to do is still a pass (AD-19)', () => {
	it('writes one heartbeat with outcome ok and zero closes when nothing is overdue', async () => {
		const harness = fakeGateway({ events: [bid('p-1', '2026-08-27T18:00:00.000Z')] });
		const closer = recordingCloser();

		const summary = await runTick({ gateway: harness.gateway, closeOne: closer.closeOne });

		expect(summary.outcome).toBe('ok');
		expect(summary.closed).toEqual([]);
		expect(closer.asked).toEqual([]);
		const heartbeat = soleHeartbeat(harness);
		expect(heartbeat.outcome).toBe('ok');
		expect(heartbeat.closed).toBe(0);
		expect(heartbeat.skipped).toBe(0);
		expect(heartbeat.failed).toBe(0);
		expect(heartbeat.ranAt).toBe(NOW.toISOString());
	});

	it('treats an empty log as ok with no version to compare', async () => {
		const harness = fakeGateway({ events: [] });

		const summary = await runTick({ gateway: harness.gateway, closeOne: async () => {} });

		expect(summary.outcome).toBe('ok');
		expect(summary.logCoreVersion).toBeNull();
		expect(soleHeartbeat(harness).logCoreVersion).toBeNull();
	});

	it('takes no lock and writes nothing but the heartbeat', async () => {
		// The fake throws on any statement it does not recognise, so this
		// assertion is exhaustive: no `begin`, no `pg_advisory_xact_lock`, no
		// insert into auction_events. The lock is taken inside each close, by
		// `runTransactionalWrite`, and by no second mechanism (AD-6).
		const harness = fakeGateway({ events: [bid('p-1', '2026-08-27T08:00:00.000Z')] });

		await runTick({ gateway: harness.gateway, closeOne: async () => {} });

		expect(harness.order).toEqual(['clock', 'read-log', 'heartbeat']);
	});

	it('releases the connection it opened', async () => {
		const harness = fakeGateway({ events: [] });
		await runTick({ gateway: harness.gateway, closeOne: async () => {} });
		expect(harness.state.connections).toBe(1);
		expect(harness.state.released).toBe(1);
	});
});

describe('runTick — AD-11’s order, one close at a time', () => {
	it('closes the earlier expiry first, whatever order the log holds them in', async () => {
		const harness = fakeGateway({
			events: [bid('p-a', '2026-08-27T09:00:00.000Z'), bid('p-b', '2026-08-27T08:00:00.000Z')]
		});
		const closer = recordingCloser();

		const summary = await runTick({ gateway: harness.gateway, closeOne: closer.closeOne });

		expect(closer.asked).toEqual(['p-b', 'p-a']);
		expect(summary.closed).toEqual(['p-b', 'p-a']);
		expect(soleHeartbeat(harness).closed).toBe(2);
	});

	it('breaks a tie on fantraxPlayerId ascending', async () => {
		const shared = '2026-08-27T08:00:00.000Z';
		const harness = fakeGateway({ events: [bid('p-9', shared), bid('p-2', shared)] });
		const closer = recordingCloser();

		await runTick({ gateway: harness.gateway, closeOne: closer.closeOne });

		expect(closer.asked).toEqual(['p-2', 'p-9']);
	});

	it('awaits each close before it starts the next', async () => {
		// Sequential, never `Promise.all`: §10 example 17's second win must be
		// evaluated against a log that already contains the first close.
		const harness = fakeGateway({
			events: [bid('p-a', '2026-08-27T08:00:00.000Z'), bid('p-b', '2026-08-27T09:00:00.000Z')]
		});
		const trace: string[] = [];

		await runTick({
			gateway: harness.gateway,
			closeOne: async (id) => {
				trace.push(`start ${id}`);
				await Promise.resolve();
				trace.push(`end ${id}`);
			}
		});

		expect(trace).toEqual(['start p-a', 'end p-a', 'start p-b', 'end p-b']);
	});
});

describe('runTick — restart safety comes from re-deriving, not remembering', () => {
	it('closes each exactly once across a pass that got through only the first of three', async () => {
		// The matrix row: a pass aborts after the first of three closes. Modelled
		// as the connection going away after that close COMMITTED — the first
		// close appends its event and the next two cannot run at all.
		const harness = fakeGateway({
			events: [
				bid('p-1', '2026-08-27T07:00:00.000Z'),
				bid('p-2', '2026-08-27T08:00:00.000Z'),
				bid('p-3', '2026-08-27T09:00:00.000Z')
			]
		});
		const firstPass: string[] = [];

		const aborted = await runTick({
			gateway: harness.gateway,
			closeOne: async (id) => {
				if (firstPass.length > 0) throw new Error('the connection went away mid-sweep');
				firstPass.push(id);
				// A committed close, as the log would then hold it.
				harness.events.push(closeEvent(id));
			}
		});

		expect(firstPass).toEqual(['p-1']);
		expect(aborted.closed).toEqual(['p-1']);
		expect(aborted.failures.map((failure) => failure.fantraxPlayerId)).toEqual(['p-2', 'p-3']);

		// The next pass re-derives from the log as it now stands. p-1 has left
		// `byPlayer`, so it is not offered a second time; p-2 and p-3 are still
		// there and close exactly once each. No duplicate, no miss, and no
		// cursor anywhere that could have got this wrong.
		const second = fakeGateway({ events: harness.events });
		const secondCloser = recordingCloser();
		const summary = await runTick({ gateway: second.gateway, closeOne: secondCloser.closeOne });

		expect(secondCloser.asked).toEqual(['p-2', 'p-3']);
		expect(summary.outcome).toBe('ok');
		expect(summary.closed).toEqual(['p-2', 'p-3']);
	});

	it('does not offer an Auction whose close is already in the log', async () => {
		const harness = fakeGateway({
			events: [
				bid('p-1', '2026-08-27T07:00:00.000Z'),
				bid('p-2', '2026-08-27T08:00:00.000Z'),
				closeEvent('p-1')
			]
		});
		const closer = recordingCloser();

		await runTick({ gateway: harness.gateway, closeOne: closer.closeOne });

		expect(closer.asked).toEqual(['p-2']);
	});
});

describe('runTick — a live Minimum-Bid Contention is SKIPPED, not closed (Story 3.6)', () => {
	it('passes over the lottery and closes every other overdue Auction', async () => {
		const harness = fakeGateway({
			events: [
				bid('p-lottery', '2026-08-27T07:00:00.000Z', MINIMUM_BID, { seedHash: 'a-commitment' }),
				bid('p-normal', '2026-08-27T08:00:00.000Z')
			]
		});
		const closer = recordingCloser();

		const summary = await runTick({ gateway: harness.gateway, closeOne: closer.closeOne });

		// The lottery expires FIRST and is skipped anyway: one un-drawable
		// Auction must not stall every other close.
		expect(closer.asked).toEqual(['p-normal']);
		expect(summary.skipped).toEqual(['p-lottery']);
		expect(summary.closed).toEqual(['p-normal']);
		expect(summary.outcome).toBe('ok');

		const heartbeat = soleHeartbeat(harness);
		expect(heartbeat.skipped).toBe(1);
		expect(heartbeat.closed).toBe(1);
		expect(String(heartbeat.detail)).toContain('p-lottery');
		expect(String(heartbeat.detail)).toContain('Story 3.6');
	});

	it('never calls closeOne for it — the skip happens BEFORE the transaction', async () => {
		// `closedWinnerFor` throws on a live lottery with no drawn winner. The
		// sweep must not reach that throw and then catch it: a skip and a
		// failure are different facts and the heartbeat says which.
		const harness = fakeGateway({
			events: [bid('p-lottery', '2026-08-27T07:00:00.000Z', MINIMUM_BID, { seedHash: 'a-commitment' })]
		});

		const summary = await runTick({
			gateway: harness.gateway,
			closeOne: async () => {
				throw new Error('closeOne must not be called for a live lottery');
			}
		});

		expect(summary.skipped).toEqual(['p-lottery']);
		expect(summary.failures).toEqual([]);
		expect(summary.outcome).toBe('ok');
	});
});

describe('runTick — the version fail-stop (AD-20)', () => {
	it('refuses the pass and closes nothing when the newest core_version differs', async () => {
		const harness = fakeGateway({
			events: [bid('p-1', '2026-08-27T08:00:00.000Z'), logEvent(BID_PLACED_EVENT, {
				fantraxPlayerId: 'p-2',
				teamId: 't-1',
				teamName: 'Team One',
				managerId: 'm-1',
				amount: 2_000_000,
				closesAt: '2026-08-27T08:00:00.000Z'
			}, CORE_VERSION + 1)]
		});
		const closer = recordingCloser();

		const summary = await runTick({ gateway: harness.gateway, closeOne: closer.closeOne });

		expect(summary.outcome).toBe('refused_version_mismatch');
		expect(closer.asked).toEqual([]);
		expect(summary.closed).toEqual([]);
		expect(summary.skipped).toEqual([]);
	});

	it('names BOTH numbers on the heartbeat', async () => {
		const harness = fakeGateway({
			events: [logEvent(BID_PLACED_EVENT, {
				fantraxPlayerId: 'p-1',
				teamId: 't-1',
				teamName: 'Team One',
				managerId: 'm-1',
				amount: 2_000_000,
				closesAt: '2026-08-27T08:00:00.000Z'
			}, 2)]
		});

		const summary = await runTick({ gateway: harness.gateway, closeOne: async () => {} });

		expect(summary.tickCoreVersion).toBe(CORE_VERSION);
		expect(summary.logCoreVersion).toBe(2);
		const heartbeat = soleHeartbeat(harness);
		expect(heartbeat.outcome).toBe('refused_version_mismatch');
		expect(heartbeat.tickCoreVersion).toBe(CORE_VERSION);
		expect(heartbeat.logCoreVersion).toBe(2);
		expect(String(heartbeat.detail)).toContain(String(CORE_VERSION));
		expect(String(heartbeat.detail)).toContain('2');
	});

	it('reads the NEWEST row’s version, by seq — an older matching row does not rescue the pass', async () => {
		const harness = fakeGateway({
			events: [
				bid('p-1', '2026-08-27T08:00:00.000Z'),
				logEvent(AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'p-other' }, 7)
			]
		});

		const summary = await runTick({ gateway: harness.gateway, closeOne: async () => {} });

		expect(summary.outcome).toBe('refused_version_mismatch');
		expect(summary.logCoreVersion).toBe(7);
	});

	it('refuses on an unreadable core_version rather than reading it as a match', async () => {
		const harness = fakeGateway({
			events: [logEvent(BID_PLACED_EVENT, {
				fantraxPlayerId: 'p-1',
				teamId: 't-1',
				teamName: 'Team One',
				managerId: 'm-1',
				amount: 2_000_000,
				closesAt: '2026-08-27T08:00:00.000Z'
			}, Number.NaN)]
		});

		const summary = await runTick({ gateway: harness.gateway, closeOne: async () => {} });

		expect(summary.outcome).toBe('refused_version_mismatch');
	});

	it('still writes exactly one heartbeat for a refused pass', async () => {
		const harness = fakeGateway({
			events: [logEvent(AUCTION_CLOSED_EVENT, { fantraxPlayerId: 'p-1' }, 99)]
		});
		await runTick({ gateway: harness.gateway, closeOne: async () => {} });
		expect(harness.heartbeats).toHaveLength(1);
	});
});

describe('runTick — one Auction’s failure does not abort the pass', () => {
	it('records the failure, continues, and closes the rest', async () => {
		const harness = fakeGateway({
			events: [
				bid('p-1', '2026-08-27T07:00:00.000Z'),
				bid('p-2', '2026-08-27T08:00:00.000Z'),
				bid('p-3', '2026-08-27T09:00:00.000Z')
			]
		});
		const asked: string[] = [];

		const summary = await runTick({
			gateway: harness.gateway,
			closeOne: async (id) => {
				asked.push(id);
				if (id === 'p-2') throw new TypeError('this Auction closes at ... which has not reached it');
			}
		});

		expect(asked).toEqual(['p-1', 'p-2', 'p-3']);
		expect(summary.closed).toEqual(['p-1', 'p-3']);
		expect(summary.failures).toEqual([
			{ fantraxPlayerId: 'p-2', message: 'TypeError: this Auction closes at ... which has not reached it' }
		]);
		expect(summary.outcome).toBe('completed_with_failures');

		const heartbeat = soleHeartbeat(harness);
		expect(heartbeat.closed).toBe(2);
		expect(heartbeat.failed).toBe(1);
		expect(String(heartbeat.detail)).toContain('p-2');
		expect(String(heartbeat.detail)).toContain('has not reached it');
	});

	it('records a thrown non-Error without crashing a second time', async () => {
		const harness = fakeGateway({ events: [bid('p-1', '2026-08-27T08:00:00.000Z')] });

		const summary = await runTick({
			gateway: harness.gateway,
			closeOne: async () => {
				throw 'a bare string';
			}
		});

		expect(summary.failures).toEqual([{ fantraxPlayerId: 'p-1', message: 'a bare string' }]);
		expect(soleHeartbeat(harness).failed).toBe(1);
	});
});

describe('runTick — the drain runs AFTER the sweep and cannot undo a close', () => {
	it('drains once, after every close', async () => {
		const harness = fakeGateway({
			events: [bid('p-1', '2026-08-27T07:00:00.000Z'), bid('p-2', '2026-08-27T08:00:00.000Z')]
		});
		const trace: string[] = [];

		await runTick({
			gateway: harness.gateway,
			closeOne: async (id) => {
				trace.push(`close ${id}`);
			},
			drain: () => {
				trace.push('drain');
			}
		});

		expect(trace).toEqual(['close p-1', 'close p-2', 'drain']);
	});

	it('keeps both closes and records the drain failure when the drain throws', async () => {
		const harness = fakeGateway({
			events: [bid('p-1', '2026-08-27T07:00:00.000Z'), bid('p-2', '2026-08-27T08:00:00.000Z')]
		});

		const summary = await runTick({
			gateway: harness.gateway,
			closeOne: async () => {},
			drain: () => {
				throw new Error('the outbox dispatcher fell over');
			}
		});

		// The closes are committed. Nothing the drain does can reach back.
		expect(summary.closed).toEqual(['p-1', 'p-2']);
		expect(summary.drainFailure).toBe('Error: the outbox dispatcher fell over');
		expect(summary.outcome).toBe('completed_with_failures');

		const heartbeat = soleHeartbeat(harness);
		expect(heartbeat.closed).toBe(2);
		expect(String(heartbeat.detail)).toContain('the outbox dispatcher fell over');
		expect(String(heartbeat.detail)).toContain('still stands');
	});

	it('is optional — a caller that passes none still sweeps and heartbeats', async () => {
		const harness = fakeGateway({ events: [bid('p-1', '2026-08-27T08:00:00.000Z')] });
		const summary = await runTick({ gateway: harness.gateway, closeOne: async () => {} });
		expect(summary.closed).toEqual(['p-1']);
		expect(summary.drainFailure).toBeNull();
		expect(harness.heartbeats).toHaveLength(1);
	});
});

describe('runTick — a pass that cannot run still says so (AD-19)', () => {
	it('writes a failed heartbeat when the log read throws', async () => {
		const harness = fakeGateway({ logThrows: true });

		const summary: TickSummary = await runTick({
			gateway: harness.gateway,
			closeOne: async () => {
				throw new Error('closeOne must not be reached');
			}
		});

		expect(summary.outcome).toBe('failed');
		expect(summary.closed).toEqual([]);
		const heartbeat = soleHeartbeat(harness);
		expect(heartbeat.outcome).toBe('failed');
		expect(String(heartbeat.detail)).toContain('auction_events is unreadable');
		// The clock was read before the log, so the pass can still stamp itself.
		expect(heartbeat.ranAt).toBe(NOW.toISOString());
	});

	it('writes a failed heartbeat, stamped by the DATABASE, when the clock read throws', async () => {
		const harness = fakeGateway({ clockThrows: true });

		const summary = await runTick({ gateway: harness.gateway, closeOne: async () => {} });

		expect(summary.outcome).toBe('failed');
		expect(summary.ranAt).toBeNull();
		// `null` here, and the insert coalesces to `now()` in SQL — never to a
		// `Date` constructed in application code (AD-3).
		expect(soleHeartbeat(harness).ranAt).toBeNull();
	});

	it('refuses an unusable clock value rather than inventing one', async () => {
		const harness = fakeGateway({ now: new Date('nonsense') });

		const summary = await runTick({ gateway: harness.gateway, closeOne: async () => {} });

		expect(summary.outcome).toBe('failed');
		expect(String(summary.detail)).toContain('no usable "now" value');
	});
});
