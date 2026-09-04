/**
 * The close transaction. Server-only (Story 3.4, FR-21).
 *
 * The stateful fake `ConnectionGateway` is `tests/server/bidding.test.ts`'s:
 * it records every statement in order and keeps the appended events in memory,
 * so "exactly one event was appended", "the claim row was deleted in the same
 * transaction" and "everything rolled back on a throw" are observable rather
 * than assumed. It throws on any statement it does not recognise, which is
 * what makes "no `team_rosters` write, no `free_agent_players` write, no
 * contracts table" provable rather than merely unasserted.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_BID } from '../../src/lib/core/constants.ts';
import { hash } from '../../src/lib/core/hash.ts';
import { BID_PLACED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import { CONTENTION_DRAWN_EVENT } from '../../src/lib/core/projection/draws.ts';
import { MINOR_LEAGUE_ELIGIBILITY_SET } from '../../src/lib/core/projection/eligibility.ts';
import {
	AUCTION_CLOSED_EVENT,
	NOMINATION_PLACED_EVENT
} from '../../src/lib/core/projection/nominations.ts';
import type {
	AuctionClosedPayload,
	ContentionDrawnPayload
} from '../../src/lib/core/rules/close.ts';
import { closeAuction } from '../../src/lib/server/close.ts';
import type {
	ConnectionGateway,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';

const NOW = new Date('2026-08-27T09:00:00.000Z');
const CLOSES_AT = '2026-08-27T09:00:00.000Z';

/**
 * The winning Team's imported roster: nine $1.0M Active/Bench contracts and
 * two occupied Minor League Slots. Deliberately roomy — every assertion here is
 * about the close, not about the money.
 */
const ROSTER: QueryResultRow[] = [
	...Array.from({ length: 9 }, () => ({ cap_hit: '1000000', roster_slot_kind: 'active_bench' })),
	{ cap_hit: '30000000', roster_slot_kind: 'minor_league' },
	{ cap_hit: '20000000', roster_slot_kind: 'minor_league' }
];

function fakeGateway(
	options: {
		events?: QueryResultRow[];
		roster?: QueryResultRow[];
		/**
		 * The SEALED seed row for this Player's contention (Story 3.6).
		 *
		 * `undefined` is a table with no row — which is what every close that
		 * is not a lottery wants, and what makes "a lottery with no sealed
		 * seed throws" reachable.
		 */
		sealedSeed?: string;
	} = {}
) {
	const order: string[] = [];
	const params: unknown[][] = [];
	const appendedEvents: QueryResultRow[] = [];
	let releasedClaims: unknown[][] = [];
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
			// Matched on the TABLE rather than on the column list: Story 4.5
			// widened this select to carry the Player id and name the Team
			// view's roster listing needs from the same one read.
			if (/from team_rosters/i.test(sql)) {
				order.push('read-roster');
				params.push([...queryParams]);
				return { rows: options.roster ?? ROSTER };
			}
			if (/^select seed from auction_contention_seeds/i.test(sql)) {
				// The sealed table's one reader (Story 3.6), on THIS client —
				// the connection that holds the lock and appends. Recorded in
				// `order` so "under the lock, before the roster read" is
				// observable rather than assumed.
				order.push('read-seed');
				params.push([...queryParams]);
				return { rows: options.sealedSeed === undefined ? [] : [{ seed: options.sealedSeed }] };
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
			if (/^delete from open_nominations/i.test(sql)) {
				order.push('release-claim');
				releasedClaims.push([...queryParams]);
				return { rows: [] };
			}
			if (/^commit/i.test(sql)) {
				order.push('commit');
				committed = true;
				return { rows: [] };
			}
			if (/^rollback/i.test(sql)) {
				order.push('rollback');
				rolledBack = true;
				// A real ROLLBACK discards every uncommitted write; the fake
				// must too, or "nothing was written" would be trivially true.
				appendedEvents.length = 0;
				releasedClaims = [];
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
		order,
		params,
		appendedEvents,
		get releasedClaims() {
			return releasedClaims;
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
	occurredAt = '2026-08-26T09:00:00.000Z',
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

const nominated = (fantraxPlayerId = 'p-1', playerName = 'Ausar Bright') =>
	logEvent(1, NOMINATION_PLACED_EVENT, {
		fantraxPlayerId,
		playerName,
		teamId: 't-n',
		teamName: 'Team N',
		managerId: 'm-n'
	});

const bidLogged = (
	seq: number,
	amount: number,
	fantraxPlayerId = 'p-1',
	teamId = 't-m',
	managerId = 'm-m',
	seedHash?: string
) =>
	logEvent(
		seq,
		BID_PLACED_EVENT,
		{
			fantraxPlayerId,
			teamId,
			teamName: 'Team M',
			managerId,
			amount,
			closesAt: CLOSES_AT,
			...(seedHash === undefined ? {} : { seedHash })
		},
		'2026-08-26T09:00:00.000Z',
		{ managerId, teamId }
	);

const eligible = (seq: number, fantraxPlayerId = 'p-1') =>
	logEvent(seq, MINOR_LEAGUE_ELIGIBILITY_SET, {
		fantraxPlayerId,
		playerName: 'Ausar Bright',
		before: false,
		after: true
	});

function acceptedPayload(harness: ReturnType<typeof fakeGateway>): AuctionClosedPayload {
	expect(harness.appendedEvents).toHaveLength(1);
	const row = harness.appendedEvents[0];
	if (row === undefined) throw new Error('no event appended');
	expect(row['event_type']).toBe(AUCTION_CLOSED_EVENT);
	return row['payload'] as AuctionClosedPayload;
}

/**
 * A real 64-hex-digit seed for the lottery closes below, with the commitment
 * DERIVED from it rather than written out beside it — so the verification
 * inside the transaction succeeds for the real reason.
 */
const SEALED_SEED = '4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e';

describe('closeAuction — one event, one transaction (AC3)', () => {
	it('appends exactly one AuctionClosed, acted by the WINNER', async () => {
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_500_000)] });

		const outcome = await closeAuction(harness.gateway, 'p-1');

		expect(outcome.kind).toBe('accepted');
		const payload = acceptedPayload(harness);
		expect(payload.teamId).toBe('t-m');
		expect(payload.winningAmount).toBe(8_500_000);
		// The envelope's columns, not just the payload's copy of them.
		expect(harness.appendedEvents[0]?.['manager_id']).toBe('m-m');
		expect(harness.appendedEvents[0]?.['team_id']).toBe('t-m');
		// A close is not a user action, so the measurement column stays null.
		expect(harness.appendedEvents[0]?.['device_class']).toBeNull();
		expect(harness.state.committed).toBe(true);
		expect(harness.state.released).toBe(1);
	});

	it('locks before it reads, reads the roster after the fold, and releases the claim before commit', async () => {
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_500_000)] });

		await closeAuction(harness.gateway, 'p-1');

		// The roster read follows the log read because the WINNING Team is not
		// known until the winner is derived from the fold.
		expect(harness.order).toEqual([
			'begin',
			'lock',
			'read-log',
			'read-roster',
			'append-event',
			'release-claim',
			'commit'
		]);
	});

	it('reads the roster of the WINNER, not of the nominator', async () => {
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_500_000)] });

		await closeAuction(harness.gateway, 'p-1');

		const rosterParams = harness.params.find((entry) => entry[0] === 't-m');
		expect(rosterParams).toEqual(['t-m']);
		expect(harness.params.some((entry) => entry[0] === 't-n')).toBe(false);
	});

	it('deletes the claim row for the closed Player, in the same transaction', async () => {
		// The one-line registration Story 2.3 wrote `releaseNomination` for.
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_500_000)] });

		await closeAuction(harness.gateway, 'p-1');

		expect(harness.releasedClaims).toEqual([['p-1']]);
	});

	it('states the Auction’s NOMINAL expiry as closedAt while the row records when it landed', async () => {
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_500_000)] });

		await closeAuction(harness.gateway, 'p-1');

		// `occurredAt` is the transaction clock; `closedAt` is what the Auction
		// was due at. Here they coincide, and the payload's value comes from
		// the persisted `closesAt` either way.
		expect(acceptedPayload(harness).closedAt).toBe(CLOSES_AT);
		expect(harness.appendedEvents[0]?.['occurred_at']).toBe(NOW);
	});
});

describe('closeAuction — Slot Placement against the roster at this close (AC2)', () => {
	it('stashes an eligible Player in the third Minor League Slot at a $0 Cap Hit', async () => {
		const harness = fakeGateway({
			events: [nominated(), bidLogged(2, 4_000_000), eligible(3)]
		});

		await closeAuction(harness.gateway, 'p-1');

		const payload = acceptedPayload(harness);
		expect(payload.placement).toBe('minor_league');
		expect(payload.winningAmount).toBe(4_000_000);
		expect(payload.capHit).toBe(0);
	});

	it('overflows an eligible Player into Active/Bench once all three are occupied', async () => {
		const harness = fakeGateway({
			events: [nominated(), bidLogged(2, 3_000_000), eligible(3)],
			roster: [
				{ cap_hit: '30000000', roster_slot_kind: 'minor_league' },
				{ cap_hit: '20000000', roster_slot_kind: 'minor_league' },
				{ cap_hit: '10000000', roster_slot_kind: 'minor_league' }
			]
		});

		await closeAuction(harness.gateway, 'p-1');

		const payload = acceptedPayload(harness);
		expect(payload.placement).toBe('active_bench');
		expect(payload.capHit).toBe(3_000_000);
	});

	it('sees a contract this same Team won EARLIER in the log, with no roster row for it', async () => {
		// AD-11's arithmetic through the shell: the first close occupies the
		// third Slot, and `team_rosters` says nothing about it — the fold does.
		const harness = fakeGateway({
			events: [
				nominated('p-2', 'Someone Else'),
				logEvent(2, NOMINATION_PLACED_EVENT, {
					fantraxPlayerId: 'p-1',
					playerName: 'Ausar Bright',
					teamId: 't-x',
					teamName: 'Team X',
					managerId: 'm-x'
				}),
				bidLogged(3, 3_000_000, 'p-1'),
				eligible(4, 'p-1'),
				logEvent(5, AUCTION_CLOSED_EVENT, {
					fantraxPlayerId: 'p-2',
					playerName: 'Someone Else',
					teamId: 't-m',
					teamName: 'Team M',
					managerId: 'm-m',
					winningAmount: 4_000_000,
					capHit: 0,
					placement: 'minor_league',
					contention: 'standard',
					contractYears: null,
					closedAt: CLOSES_AT
				})
			]
		});

		await closeAuction(harness.gateway, 'p-1');

		// Two imported Minor League rows plus one won one is three occupied,
		// so this eligible win overflows into Active/Bench at full price.
		const payload = acceptedPayload(harness);
		expect(payload.placement).toBe('active_bench');
		expect(payload.capHit).toBe(3_000_000);
	});

	it('places a Player who is not eligible in Active/Bench however empty the minors are', async () => {
		const harness = fakeGateway({
			events: [nominated(), bidLogged(2, 8_500_000)],
			roster: []
		});

		await closeAuction(harness.gateway, 'p-1');

		expect(acceptedPayload(harness).placement).toBe('active_bench');
		// The roster read still happened — against an EMPTY roster, so all
		// three Minor League Slots were free and the placement was decided on
		// eligibility alone rather than on occupancy.
		expect(harness.order).toContain('read-roster');
		// An Active/Bench placement charges the full winning amount (AD-23).
		expect(acceptedPayload(harness).winningAmount).toBe(8_500_000);
		expect(acceptedPayload(harness).capHit).toBe(8_500_000);
	});
});

describe('closeAuction — the bugs it refuses to paper over (AD-1, AD-14)', () => {
	it('throws on a lottery with NO sealed seed, and appends nothing', async () => {
		// The one outcome AD-14 cannot survive: a draw with no seed to open.
		// The Auction stays open and visibly unclosed rather than being
		// awarded to whichever Team happened to open the lottery.
		const harness = fakeGateway({
			events: [nominated(), bidLogged(2, MINIMUM_BID, 'p-1', 't-e', 'm-e', hash(SEALED_SEED))]
		});

		await expect(closeAuction(harness.gateway, 'p-1')).rejects.toThrow(/no sealed seed exists/);

		expect(harness.appendedEvents).toEqual([]);
		expect(harness.releasedClaims).toEqual([]);
		expect(harness.state.rolledBack).toBe(true);
		expect(harness.state.committed).toBe(false);
		expect(harness.state.released).toBe(1);
	});

	it('throws before it reads a roster, so a failed draw touches no other table', async () => {
		const harness = fakeGateway({
			events: [nominated(), bidLogged(2, MINIMUM_BID, 'p-1', 't-e', 'm-e', hash(SEALED_SEED))]
		});

		await expect(closeAuction(harness.gateway, 'p-1')).rejects.toThrow(TypeError);

		expect(harness.order).toEqual(['begin', 'lock', 'read-log', 'read-seed', 'rollback']);
	});

	it('throws when the sealed seed does not answer the published commitment', async () => {
		const harness = fakeGateway({
			events: [
				nominated(),
				bidLogged(2, MINIMUM_BID, 'p-1', 't-e', 'm-e', hash('a-completely-different-seed'))
			],
			sealedSeed: SEALED_SEED
		});

		await expect(closeAuction(harness.gateway, 'p-1')).rejects.toThrow(
			/does not match the published commitment/
		);

		expect(harness.appendedEvents).toEqual([]);
		expect(harness.state.rolledBack).toBe(true);
	});

	it('throws on a malformed sealed seed, naming what was required', async () => {
		const harness = fakeGateway({
			events: [nominated(), bidLogged(2, MINIMUM_BID, 'p-1', 't-e', 'm-e', hash(SEALED_SEED))],
			sealedSeed: 'NOT-HEX'
		});

		await expect(closeAuction(harness.gateway, 'p-1')).rejects.toThrow(
			/64 lowercase hex digits/
		);
		expect(harness.appendedEvents).toEqual([]);
	});

	it('throws when nobody ever bid, and appends nothing', async () => {
		const harness = fakeGateway({ events: [nominated()] });

		await expect(closeAuction(harness.gateway, 'p-1')).rejects.toThrow(/no Auction to close/);
		expect(harness.appendedEvents).toEqual([]);
		expect(harness.state.rolledBack).toBe(true);
	});

	it('throws when the Auction Clock has not run out, and appends nothing', async () => {
		const harness = fakeGateway({
			events: [
				nominated(),
				logEvent(
					2,
					BID_PLACED_EVENT,
					{
						fantraxPlayerId: 'p-1',
						teamId: 't-m',
						teamName: 'Team M',
						managerId: 'm-m',
						amount: 8_500_000,
						// An hour past the transaction clock: still live.
						closesAt: '2026-08-27T10:00:00.000Z'
					},
					'2026-08-26T10:00:00.000Z',
					{ managerId: 'm-m', teamId: 't-m' }
				)
			]
		});

		await expect(closeAuction(harness.gateway, 'p-1')).rejects.toThrow(/has not reached it/);
		expect(harness.appendedEvents).toEqual([]);
		expect(harness.releasedClaims).toEqual([]);
		expect(harness.state.rolledBack).toBe(true);
	});
});

// --- Story 3.6: the lottery closes, through the whole transaction -----------

describe('closeAuction — a Minimum-Bid Contention is drawn and closed (AC2, AC4)', () => {
	/** §10 example 8's lottery: E opened it, F, G and H joined, seed sealed. */
	const lottery = (overrides: { sealedSeed?: string } = {}) =>
		fakeGateway({
			events: [
				nominated(),
				bidLogged(2, MINIMUM_BID, 'p-1', 't-e', 'm-e', hash(SEALED_SEED)),
				bidLogged(3, MINIMUM_BID, 'p-1', 't-f', 'm-f'),
				bidLogged(4, MINIMUM_BID, 'p-1', 't-g', 'm-g'),
				bidLogged(5, MINIMUM_BID, 'p-1', 't-h', 'm-h')
			],
			sealedSeed: SEALED_SEED,
			...overrides
		});

	it('appends ContentionDrawn and then AuctionClosed, in one transaction', async () => {
		const harness = lottery();

		const outcome = await closeAuction(harness.gateway, 'p-1');

		expect(outcome.kind).toBe('accepted');
		expect(harness.appendedEvents).toHaveLength(2);
		// Cause then consequence, in `seq` order.
		expect(harness.appendedEvents[0]?.['event_type']).toBe(CONTENTION_DRAWN_EVENT);
		expect(harness.appendedEvents[1]?.['event_type']).toBe(AUCTION_CLOSED_EVENT);
		expect(harness.state.committed).toBe(true);
		expect(harness.releasedClaims).toEqual([['p-1']]);
	});

	it('reads the sealed seed under the lock, BEFORE the winning Team’s roster', async () => {
		// The roster read is keyed on the Team that won, and who won is not
		// known until the seed has been read and the winner derived.
		const harness = lottery();

		await closeAuction(harness.gateway, 'p-1');

		expect(harness.order).toEqual([
			'begin',
			'lock',
			'read-log',
			'read-seed',
			'read-roster',
			'append-event',
			'append-event',
			'release-claim',
			'commit'
		]);
		expect(harness.params.some((entry) => entry[0] === 'p-1')).toBe(true);
	});

	it('awards the flat $1,000,000 to the Contender the seed selects', async () => {
		const harness = lottery();

		await closeAuction(harness.gateway, 'p-1');

		const drawn = harness.appendedEvents[0]?.['payload'] as ContentionDrawnPayload;
		const closed = harness.appendedEvents[1]?.['payload'] as AuctionClosedPayload;

		// Four Contenders in join order, and the seed reduces to position 2.
		expect(drawn.contenders).toEqual(['t-e', 't-f', 't-g', 't-h']);
		expect(drawn.selectedIndex).toBe(2);
		expect(drawn.winningTeamId).toBe('t-g');
		expect(drawn.seed).toBe(SEALED_SEED);
		expect(drawn.seedHash).toBe(hash(SEALED_SEED));

		// The FLAT join amount, never the opener's leading Bid.
		expect(closed.teamId).toBe('t-g');
		expect(closed.winningAmount).toBe(MINIMUM_BID);
		expect(closed.contention).toBe('minimum_bid');
		// Both events are acted by the winner, not by the opener.
		expect(harness.appendedEvents[0]?.['team_id']).toBe('t-g');
		expect(harness.appendedEvents[1]?.['team_id']).toBe('t-g');
	});

	it('reads the roster of the DRAWN Team, not of the opener or the nominator', async () => {
		const harness = lottery();

		await closeAuction(harness.gateway, 'p-1');

		expect(harness.params.some((entry) => entry[0] === 't-g')).toBe(true);
		expect(harness.params.some((entry) => entry[0] === 't-e')).toBe(false);
		expect(harness.params.some((entry) => entry[0] === 't-n')).toBe(false);
	});

	it('closes a ONE-Contender lottery on that Contender, with a one-team list', async () => {
		// §10 example 11. `seed mod 1 = 0` needs no special case, and the list
		// is recorded rather than omitted.
		const harness = fakeGateway({
			events: [nominated(), bidLogged(2, MINIMUM_BID, 'p-1', 't-e', 'm-e', hash(SEALED_SEED))],
			sealedSeed: SEALED_SEED
		});

		await closeAuction(harness.gateway, 'p-1');

		const drawn = harness.appendedEvents[0]?.['payload'] as ContentionDrawnPayload;
		expect(drawn.contenders).toEqual(['t-e']);
		expect(drawn.selectedIndex).toBe(0);
		expect(drawn.winningTeamId).toBe('t-e');
		expect((harness.appendedEvents[1]?.['payload'] as AuctionClosedPayload).winningAmount).toBe(
			MINIMUM_BID
		);
	});
});
