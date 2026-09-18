import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { fold } from '../../src/lib/core/projection/fold.ts';
import { INITIAL_PHASE, phaseReducer } from '../../src/lib/core/projection/phase.ts';
import { INITIAL_WATERMARK, watermarkReducer } from '../../src/lib/core/projection/watermark.ts';
import {
	resetLeagueReadCache,
	resolveLeagueReadCached,
	resolveLeagueReadCachedOrDefault
} from '../../src/lib/server/league-read-cache.ts';
import { toAppendedEvent } from '../../src/lib/shell/write.ts';

/**
 * The per-process fold cache behind `hooks.server.ts`.
 *
 * The property under test is NOT "it is faster". It is that a cached read and
 * a full replay are the same answer — AD-5's fold is still over the whole log,
 * and the cache only decides how much of the log crosses the wire. So nearly
 * every assertion below is a convergence assertion against a genuine full fold
 * of the same events, plus a count of the rows actually transferred.
 *
 * The one case with teeth of its own is the watermark going BACKWARDS.
 * `scripts/reset-pilot.js` deletes every row and restarts the identity at 1,
 * so a warm Function instance pointed at a wiped dev project must rebuild
 * rather than extend — otherwise it serves the phase of a league that no
 * longer exists and no event can ever correct it.
 */

/** One `auction_events` row, as Postgrest would shape it, for seq `n`. */
function row(n: number, type = 'Marker'): Record<string, unknown> {
	return {
		seq: String(n),
		occurred_at: '2026-08-22T00:00:00.000Z',
		schema_version: 1,
		core_version: 1,
		manager_id: 'm-1',
		team_id: 't-1',
		event_type: type,
		payload: { marker: n },
		device_class: null,
		dispatch_outcome: null,
		delivery_outcome: null
	};
}

/**
 * A fake `auction_events` whose rows can be appended to — and truncated —
 * between reads, serving both shapes this module issues: `readWatermark`'s
 * descending `limit(1)`, and `loadAppendedEventsSince`'s `gt` + `range`.
 *
 * The `gt` bound genuinely FILTERS here rather than passing through, which is
 * the whole point: a test that let it pass through would pass identically
 * against a cache that re-read the entire log every time.
 */
function fakeLog(initial: Record<string, unknown>[] = []) {
	let rows = [...initial];
	const calls = { watermarkReads: 0, eventRowsServed: 0, rangeCalls: 0 };
	let bound = INITIAL_WATERMARK;
	/** Rows appended by `betweenReads` on the next `range`, to race the reads. */
	let raceRows: Record<string, unknown>[] = [];

	const query = {
		select: () => query,
		gt: (_column: string, since: string) => {
			bound = since;
			return query;
		},
		order: () => query,
		async limit(count: number) {
			calls.watermarkReads += 1;
			const descending = [...rows].sort((a, b) =>
				BigInt(String(a['seq'])) < BigInt(String(b['seq'])) ? 1 : -1
			);
			return { data: descending.slice(0, count), error: null };
		},
		async range(from: number, to: number) {
			calls.rangeCalls += 1;
			if (raceRows.length > 0) {
				rows = [...rows, ...raceRows];
				raceRows = [];
			}
			const matching = rows
				.filter((r) => BigInt(String(r['seq'])) > BigInt(bound))
				.sort((a, b) => (BigInt(String(a['seq'])) < BigInt(String(b['seq'])) ? -1 : 1));
			const page = matching.slice(from, to + 1);
			calls.eventRowsServed += page.length;
			return { data: page, error: null };
		}
	};

	return {
		client: { from: () => query } as unknown as SupabaseClient,
		calls,
		/** Append rows, as a committed transaction would. */
		append(...added: Record<string, unknown>[]) {
			rows = [...rows, ...added];
		},
		/** Wipe and restart the identity, as `scripts/reset-pilot.js` does. */
		wipe() {
			rows = [];
		},
		/** Commit rows AFTER the `max(seq)` read but before the tail read. */
		betweenReads(...added: Record<string, unknown>[]) {
			raceRows = [...added];
		},
		/** The full replay this module's answer must always equal. */
		fullFold() {
			const events = [...rows]
				.sort((a, b) => (BigInt(String(a['seq'])) < BigInt(String(b['seq'])) ? -1 : 1))
				.map(toAppendedEvent);
			return {
				phase: fold(INITIAL_PHASE, events, phaseReducer),
				watermark: fold(INITIAL_WATERMARK, events, watermarkReducer)
			};
		}
	};
}

/** A fake whose reads always fail, Postgrest-shaped. */
function failingClient(): SupabaseClient {
	const query = {
		select: () => query,
		gt: () => query,
		order: () => query,
		async range() {
			return { data: null, error: { message: 'connection refused' } };
		},
		async limit() {
			return { data: null, error: { message: 'connection refused' } };
		}
	};
	return { from: () => query } as unknown as SupabaseClient;
}

// The cache is module state, so every test starts from a cold process.
beforeEach(() => resetLeagueReadCache());

describe('resolveLeagueReadCached — a cold process', () => {
	it('folds the whole log and answers exactly what a full replay answers', async () => {
		const log = fakeLog([row(1), row(2, 'AuctionOpened'), row(3)]);

		const read = await resolveLeagueReadCached(log.client);

		expect(read.phase.name).toBe('Auction');
		expect(read.watermark).toBe('3');
		expect(read).toMatchObject(
			expect.objectContaining({ watermark: log.fullFold().watermark })
		);
		expect(read.phase.name).toBe(log.fullFold().phase);
	});

	it('resolves an empty log to Setup and `\'0\'`, the same pair an empty fold produces', async () => {
		const read = await resolveLeagueReadCached(fakeLog().client);

		expect(read.phase.name).toBe('Setup');
		expect(read.watermark).toBe(INITIAL_WATERMARK);
	});
});

describe('resolveLeagueReadCached — a warm process', () => {
	it('transfers NOT ONE event row when `max(seq)` is unchanged', async () => {
		const log = fakeLog([row(1), row(2, 'AuctionOpened')]);
		await resolveLeagueReadCached(log.client);
		const afterColdRead = { ...log.calls };

		const second = await resolveLeagueReadCached(log.client);

		expect(second.phase.name).toBe('Auction');
		expect(second.watermark).toBe('2');
		// The whole saving, asserted as a number rather than implied: the
		// second read issued no event query at all, so it moved the one
		// watermark row and nothing else. Deltas, not totals — the cold read
		// above legitimately paged the log and its counts are the baseline.
		expect(log.calls.eventRowsServed - afterColdRead.eventRowsServed).toBe(0);
		expect(log.calls.rangeCalls - afterColdRead.rangeCalls).toBe(0);
		expect(log.calls.watermarkReads - afterColdRead.watermarkReads).toBe(1);
	});

	it('still reads `max(seq)` on a hit — a phase is never reported from a database this request could not reach', async () => {
		const log = fakeLog([row(1)]);
		await resolveLeagueReadCached(log.client);
		await resolveLeagueReadCached(log.client);
		await resolveLeagueReadCached(log.client);

		expect(log.calls.watermarkReads).toBe(3);
	});

	it('fetches only the events above the cached `seq`, and converges on the full replay', async () => {
		const log = fakeLog([row(1), row(2)]);
		await resolveLeagueReadCached(log.client);
		const servedByTheFullRead = log.calls.eventRowsServed;

		log.append(row(3, 'AuctionOpened'), row(4));
		const second = await resolveLeagueReadCached(log.client);

		// Two new rows, not four — the tail, not the log.
		expect(log.calls.eventRowsServed - servedByTheFullRead).toBe(2);
		expect(second.phase.name).toBe(log.fullFold().phase);
		expect(second.watermark).toBe(log.fullFold().watermark);
		expect(second.phase.name).toBe('Auction');
	});

	it('folds a transition that arrives in the tail, not only one present at the cold read', async () => {
		const log = fakeLog([row(1)]);
		expect((await resolveLeagueReadCached(log.client)).phase.name).toBe('Setup');

		log.append(row(2, 'AuctionOpened'));
		expect((await resolveLeagueReadCached(log.client)).phase.name).toBe('Auction');

		log.append(row(3, 'ContractAssignmentOpened'));
		expect((await resolveLeagueReadCached(log.client)).phase.name).toBe('Contract Assignment');
	});

	it('picks up a transaction that commits BETWEEN the watermark read and the tail read', async () => {
		const log = fakeLog([row(1)]);
		await resolveLeagueReadCached(log.client);

		// `max(seq)` will answer 2; row 3 commits before the tail read runs.
		log.append(row(2));
		log.betweenReads(row(3, 'AuctionOpened'));
		const second = await resolveLeagueReadCached(log.client);

		// The tail is bounded by the CACHED seq, never by the watermark just
		// read, so the later row is included rather than skipped — and the
		// state is recorded as folded through what actually arrived.
		expect(second.watermark).toBe('3');
		expect(second.phase.name).toBe('Auction');

		const third = await resolveLeagueReadCached(log.client);
		expect(third.watermark).toBe('3');
		expect(third.phase.name).toBe('Auction');
	});
});

describe('resolveLeagueReadCached — the watermark goes backwards', () => {
	it('rebuilds from empty after a wipe rather than serving a league that no longer exists', async () => {
		const log = fakeLog([row(1), row(2, 'AuctionOpened')]);
		expect((await resolveLeagueReadCached(log.client)).phase.name).toBe('Auction');

		// `reset-pilot.js`: every row deleted, `seq` restarted at 1.
		log.wipe();

		const afterWipe = await resolveLeagueReadCached(log.client);
		expect(afterWipe.phase.name).toBe('Setup');
		expect(afterWipe.watermark).toBe(INITIAL_WATERMARK);
	});

	it('rebuilds rather than extends when the restarted log is SHORTER than the cached one', async () => {
		const log = fakeLog([row(1), row(2, 'AuctionOpened'), row(3), row(4)]);
		await resolveLeagueReadCached(log.client);

		// Wiped, then re-seeded to a lower height with no transition in it.
		// Extending the cache here would answer Auction off rows that are gone.
		log.wipe();
		log.append(row(1), row(2));

		const rebuilt = await resolveLeagueReadCached(log.client);
		expect(rebuilt.phase.name).toBe('Setup');
		expect(rebuilt.watermark).toBe('2');
		expect(rebuilt).toMatchObject({ watermark: log.fullFold().watermark });
	});
});

describe('the fail-closed pair', () => {
	it('throws on a read failure rather than answering from the cache', async () => {
		const log = fakeLog([row(1), row(2, 'AuctionOpened')]);
		await resolveLeagueReadCached(log.client);

		// A warm cache holding "Auction" must not satisfy a request whose own
		// read failed: "the last phase I saw" is not an answer to "what is the
		// phase", and AD-29 requires an unrefreshable figure to say so.
		await expect(resolveLeagueReadCached(failingClient())).rejects.toThrow(
			/watermark read failed/
		);
	});

	it('fails closed to Setup and `\'0\'`, never to the cached phase', async () => {
		const log = fakeLog([row(1), row(2, 'AuctionOpened')]);
		await resolveLeagueReadCached(log.client);

		const read = await resolveLeagueReadCachedOrDefault(failingClient());
		expect(read.phase.name).toBe('Setup');
		expect(read.watermark).toBe(INITIAL_WATERMARK);
	});

	it('resolves normally when the read succeeds', async () => {
		const log = fakeLog([row(1, 'AuctionOpened')]);

		const read = await resolveLeagueReadCachedOrDefault(log.client);
		expect(read.phase.name).toBe('Auction');
		expect(read.watermark).toBe('1');
	});
});
