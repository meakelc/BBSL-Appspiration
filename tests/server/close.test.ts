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
import { BID_CANCELLED_EVENT, BID_PLACED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import { CONTENTION_DRAWN_EVENT } from '../../src/lib/core/projection/draws.ts';
import { MINOR_LEAGUE_ELIGIBILITY_SET } from '../../src/lib/core/projection/eligibility.ts';
import {
	AUCTION_CLOSED_EVENT,
	AUCTION_TERMINATED_EVENT,
	NOMINATION_PLACED_EVENT
} from '../../src/lib/core/projection/nominations.ts';
import type {
	AuctionClosedPayload,
	BidCancelledPayload,
	ContentionDrawnPayload,
	UndrawnContentionPayload
} from '../../src/lib/core/rules/close.ts';
import type { AuctionTerminatedPayload } from '../../src/lib/core/rules/phase-end.ts';
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

/**
 * The Teams `EVERY_TEAM` resolves to in this fake's league (Story 5.3).
 *
 * A constant rather than an option, because the one trigger that reaches it
 * is `ContractAssignmentOpened` and what matters about it is that the enqueue
 * asked the whole-league question at all.
 */
const EVERY_LEAGUE_TEAM: readonly string[] = ['t-one', 't-two'];

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

	/**
	 * The delivery intents this transaction filed (Story 5.3): the event they
	 * describe and who they address. Recorded rather than merely tolerated, so
	 * “this write mentioned exactly these Teams” is observable.
	 */
	const outboxIntents: Array<{ eventSeq: string; recipient: string }> = [];

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
			// Story 5.3 registered a Manager-shaped enqueue beside the
			// broadcast one, so the transaction now also asks which Managers
			// act for each AFFECTED Team — the Team the write site named, never
			// the event's own. One synthetic snowflake per Team, so a test can
			// read the affected set straight off the intents it filed.
			if (/^select discord_user_id\s+from managers\s+where team_id = \$1/i.test(sql)) {
				return { rows: [{ discord_user_id: `discord-${String(queryParams[0])}` }] };
			}
			if (/^select discord_user_id\s+from managers\s+where team_id is not null/i.test(sql)) {
				return {
					rows: EVERY_LEAGUE_TEAM.map((teamId) => ({ discord_user_id: `discord-${teamId}` }))
				};
			}
			if (/^insert into notification_outbox/i.test(sql)) {
				outboxIntents.push({
					eventSeq: String(queryParams[0]),
					recipient: String(queryParams[2])
				});
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
		outboxIntents,
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

/**
 * The Team NAME is derived from the id rather than hardcoded (Story 10.4).
 *
 * It was the constant `'Team M'` for every Bid until a restoration assertion
 * had to name a Team: pairing `teamId: 't-r'` with `teamName: 'Team M'` in an
 * expectation means the name half passes whatever the code carries, which is
 * an assertion that cannot fail. One derivation, so every fixture Bid names
 * the Team it is actually from.
 */
const teamNameOf = (teamId: string) => `Team ${(teamId.split('-')[1] ?? teamId).toUpperCase()}`;

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
			teamName: teamNameOf(teamId),
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

describe('closeAuction — the mention intents it owes (Story 5.3, AC1)', () => {
	it('mentions the leader and the NOMINATING Team on the close', async () => {
		// Two matrix rows on one event: “An Auction the Team led closes” and
		// “The Nomination Slot is released”. `t-m` led and won; `t-n` nominated
		// and gets its Slot back. `AuctionClosedPayload` names the winner and
		// could never answer the second, which is why the nominations fold does.
		const harness = fakeGateway({ events: [nominated(), bidLogged(2, 8_500_000)] });

		await closeAuction(harness.gateway, 'p-1');

		expect(harness.outboxIntents).toEqual([
			{ eventSeq: expect.any(String), recipient: '#channel' },
			{ eventSeq: expect.any(String), recipient: 'discord-t-m' },
			{ eventSeq: expect.any(String), recipient: 'discord-t-n' }
		]);
	});

	it('files ONE intent when the winner IS the nominating Team', async () => {
		// A Team that nominated a Player and then won them holds BOTH roles on the
		// one `AuctionClosed`, so `affectedTeamsForClose` names it twice. One
		// Manager must still get one ping: two intents on the same
		// `(event_seq, channel, recipient)` are the same intent, and the outbox key
		// would absorb the second with `on conflict do nothing` — but the enqueue
		// should not be leaning on the constraint to be correct, and the composer
		// would otherwise be handed the same snowflake twice.
		const harness = fakeGateway({
			// `nominated()` nominates for `t-n`; this Bid wins it for `t-n` too.
			events: [nominated(), bidLogged(2, 8_500_000, 'p-1', 't-n', 'm-n')]
		});

		await closeAuction(harness.gateway, 'p-1');

		expect(harness.outboxIntents.map((intent) => intent.recipient)).toEqual([
			'#channel',
			'discord-t-n'
		]);
	});

	it('mentions every Contender on the DRAW, and the nominator on the close', async () => {
		// The matrix's “A contention closes” row. The draw is the event that can
		// tell a Contender how the lottery went; the close beside it addresses
		// the nominator alone, because a lottery has no Leading Bidder — the one
		// `auctionsReducer` reports is a fold artifact (`evaluateSelfBid`'s note).
		const harness = fakeGateway({
			events: [
				nominated(),
				bidLogged(2, MINIMUM_BID, 'p-1', 't-e', 'm-e', hash(SEALED_SEED)),
				bidLogged(3, MINIMUM_BID, 'p-1', 't-f', 'm-f')
			],
			sealedSeed: SEALED_SEED
		});

		await closeAuction(harness.gateway, 'p-1');

		const drawSeq = harness.outboxIntents[0]?.eventSeq;
		const onDraw = harness.outboxIntents
			.filter((intent) => intent.eventSeq === drawSeq)
			.map((intent) => intent.recipient);
		const onClose = harness.outboxIntents
			.filter((intent) => intent.eventSeq !== drawSeq)
			.map((intent) => intent.recipient);

		expect(onDraw).toEqual(['#channel', 'discord-t-e', 'discord-t-f']);
		expect(onClose).toEqual(['#channel', 'discord-t-n']);
	});
});

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
			// TWO roster reads since Story 10.4: the WINNER's, keyed on a Team
			// not known until the fold produced it, and then ONE batched read
			// over every Team holding a Bid — the candidates FR-40's restorer
			// re-validates. One statement for all of them, not a query each.
			'read-roster',
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
			// Two, for the reason above: the drawn winner's, then the batched
			// candidate read.
			'read-roster',
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


// --- FR-40 through the real transaction (Story 10.3) ----------------------

/**
 * Team M with ELEVEN Active/Bench contracts and no minors: Free Active/Bench
 * Slots 1, which one win takes to 0. The roomy roster above is deliberately
 * unusable here — the whole point is a Team the next close fills up.
 */
const FULL_ROSTER: QueryResultRow[] = Array.from({ length: 11 }, () => ({
	cap_hit: '1000000',
	roster_slot_kind: 'active_bench'
}));

/** Two nominated Players, both bid on by Team M, both due at the same instant. */
function twoCommitments(): QueryResultRow[] {
	return [
		logEvent(1, NOMINATION_PLACED_EVENT, {
			fantraxPlayerId: 'p-1',
			playerName: 'Ausar Bright',
			teamId: 't-n',
			teamName: 'Team N',
			managerId: 'm-n'
		}),
		bidLogged(2, 8_500_000, 'p-1'),
		// A DIFFERENT nominating Team: `nominationsReducer` holds one
		// Nomination Slot per Team, so Team N could not have nominated both.
		logEvent(3, NOMINATION_PLACED_EVENT, {
			fantraxPlayerId: 'p-2',
			playerName: 'Dex Brooks',
			teamId: 't-o',
			teamName: 'Team O',
			managerId: 'm-o'
		}),
		bidLogged(4, 2_000_000, 'p-2')
	];
}

describe('closeAuction — the cancellation cascade, in the transaction (Story 10.3, FR-40)', () => {
	it('appends AuctionClosed and then BidCancelled, in that order, in ONE transaction', async () => {
		const harness = fakeGateway({ events: twoCommitments(), roster: FULL_ROSTER });

		const outcome = await closeAuction(harness.gateway, 'p-1');
		expect(outcome.kind).toBe('accepted');

		// The fixed order (AD-31): the win that filled the Slot, then what it
		// cost. Both inside one `begin`/`commit`, with no second transaction.
		expect(harness.appendedEvents.map((row) => row['event_type'])).toEqual([
			AUCTION_CLOSED_EVENT,
			BID_CANCELLED_EVENT
		]);
		expect(harness.order.filter((statement) => statement === 'begin')).toHaveLength(1);
		expect(harness.order.filter((statement) => statement === 'commit')).toHaveLength(1);
		expect(harness.order.indexOf('append-event')).toBeLessThan(harness.order.indexOf('commit'));

		const cancelled = harness.appendedEvents[1]?.['payload'] as BidCancelledPayload;
		expect(cancelled.fantraxPlayerId).toBe('p-2');
		expect(cancelled.playerName).toBe('Dex Brooks');
		// The `seq` the log itself assigned to Team M's Bid on Brooks.
		expect(cancelled.cancelledSeq).toBe('4');
		expect(cancelled.causeFantraxPlayerId).toBe('p-1');
		expect(cancelled.causePlayerName).toBe('Ausar Bright');
		expect(cancelled.amount).toBe(2_000_000);
		expect(cancelled.restoration).toBeNull();
		// The envelope is the CANCELLED Team's — `auction_events.team_id` and
		// `.manager_id` are `not null` and reference real rows.
		expect(harness.appendedEvents[1]?.['team_id']).toBe('t-m');
		expect(harness.appendedEvents[1]?.['manager_id']).toBe('m-m');
	});

	it('mentions the cancelled Team, so the notice has somewhere to go', async () => {
		const harness = fakeGateway({ events: twoCommitments(), roster: FULL_ROSTER });
		await closeAuction(harness.gateway, 'p-1');

		const cancellationSeq = String(harness.appendedEvents[1]?.['seq']);
		const addressed = harness.outboxIntents
			.filter((intent) => intent.eventSeq === cancellationSeq)
			.map((intent) => intent.recipient);

		// One Manager-addressed intent for Team M — the Team that lost the
		// Bid. The copy itself is Story 10.6's; what this story owes is that
		// the intent exists at all.
		expect(addressed).toContain('discord-t-m');
	});

	it('records the restored Team on the event and mentions it too (Story 10.4)', async () => {
		// Team R bid $1,000,000 on Brooks before Team M outbid it. Closing
		// Bright fills Team M's last Slot, its Brooks commitment is cancelled,
		// and Team R's surviving Bid is re-validated and handed the Auction.
		const events = [
			...twoCommitments().slice(0, 3),
			bidLogged(4, 1_000_000, 'p-2', 't-r', 'm-r'),
			bidLogged(5, 2_000_000, 'p-2')
		];
		const harness = fakeGateway({ events, roster: FULL_ROSTER });

		await closeAuction(harness.gateway, 'p-1');

		const cancelled = harness.appendedEvents[1]?.['payload'] as BidCancelledPayload;
		expect(cancelled.cancelledSeq).toBe('5');
		// ONE event carries the cancellation AND the succession — no second
		// event is appended for a restoration.
		expect(harness.appendedEvents).toHaveLength(2);
		expect(cancelled.restoration).toEqual({
			seq: '4',
			teamId: 't-r',
			teamName: 'Team R',
			managerId: 'm-r',
			amount: 1_000_000
		});

		// Both Managers are addressed off the one event: the Team that lost the
		// Bid, and the Team that is leading again through no act of its own.
		const cancellationSeq = String(harness.appendedEvents[1]?.['seq']);
		const addressed = harness.outboxIntents
			.filter((intent) => intent.eventSeq === cancellationSeq)
			.map((intent) => intent.recipient);
		expect(addressed).toContain('discord-t-m');
		expect(addressed).toContain('discord-t-r');
	});

	it('commits the cancellation BEFORE the next close is evaluated (AD-11)', async () => {
		// The property AD-11 has always had, now load-bearing. Brooks' Auction
		// is due at the same instant, and by the time it is offered to a close
		// its only Bid has been cancelled and committed — so it has no Leading
		// Bidder, no clock, and refuses rather than awarding Team M a
		// thirteenth Player. A batched fold would have closed it.
		const harness = fakeGateway({ events: twoCommitments(), roster: FULL_ROSTER });
		await closeAuction(harness.gateway, 'p-1');

		// The first transaction's two events, committed.
		expect(harness.appendedEvents.map((row) => row['event_type'])).toEqual([
			AUCTION_CLOSED_EVENT,
			BID_CANCELLED_EVENT
		]);
		const appendsBefore = harness.order.filter((statement) => statement === 'append-event').length;

		await expect(closeAuction(harness.gateway, 'p-2')).rejects.toThrow(/no Leading Bidder/);

		// ...and the refusal appended nothing of its own. (This fake's
		// ROLLBACK clears its whole in-memory array rather than truncating to
		// the last COMMIT, so the count of insert statements is what states
		// "nothing more was written" here.)
		expect(harness.order.filter((statement) => statement === 'append-event')).toHaveLength(
			appendsBefore
		);
		expect(harness.state.rolledBack).toBe(true);
	});

	it('cancels nothing when the winning Team still has room afterwards', async () => {
		// The same two Auctions against the roomy roster: Free Active/Bench
		// Slots falls 3 → 2, the trigger fires, and the re-test finds Team M
		// well within its allowance. One event.
		const harness = fakeGateway({ events: twoCommitments() });

		await closeAuction(harness.gateway, 'p-1');

		expect(harness.appendedEvents.map((row) => row['event_type'])).toEqual([
			AUCTION_CLOSED_EVENT
		]);
	});
});

describe('closeAuction — a lottery every Contender was cancelled from (Story 10.5, FR-40)', () => {
	/**
	 * The log an earlier close in the same sweep leaves behind: two Teams
	 * joined the lottery, and FR-40's cascade cancelled both of their entries
	 * when their own wins filled their last Slots.
	 *
	 * The cancellations are LOGGED rather than produced here, because that is
	 * how this state actually arises — each close commits before the next is
	 * loaded (AD-11), so the emptied list is something `loadCloseState` folds,
	 * not something this transaction causes.
	 */
	const cancelledLogged = (seq: number, cancelledSeq: string, teamId: string, managerId: string) =>
		logEvent(
			seq,
			BID_CANCELLED_EVENT,
			{
				fantraxPlayerId: 'p-1',
				playerName: 'Ausar Bright',
				cancelledSeq,
				teamId,
				teamName: teamNameOf(teamId),
				managerId,
				amount: MINIMUM_BID,
				wasContentionEntry: true,
				causeFantraxPlayerId: 'p-9',
				causePlayerName: 'Someone Else',
				restoration: null
			},
			'2026-08-26T10:00:00.000Z',
			{ managerId, teamId }
		);

	const emptied = () =>
		fakeGateway({
			events: [
				nominated(),
				bidLogged(2, MINIMUM_BID, 'p-1', 't-e', 'm-e', hash(SEALED_SEED)),
				bidLogged(3, MINIMUM_BID, 'p-1', 't-f', 'm-f'),
				cancelledLogged(4, '3', 't-f', 'm-f'),
				cancelledLogged(5, '2', 't-e', 'm-e')
			],
			sealedSeed: SEALED_SEED
		});

	it('appends ContentionDrawn and then AuctionTerminated, and no close', async () => {
		const harness = emptied();

		const outcome = await closeAuction(harness.gateway, 'p-1');

		expect(outcome.kind).toBe('accepted');
		expect(harness.appendedEvents.map((row) => row['event_type'])).toEqual([
			CONTENTION_DRAWN_EVENT,
			AUCTION_TERMINATED_EVENT
		]);
		// Nobody won, so nothing is awarded and no Team's free Slots fell.
		expect(harness.appendedEvents.map((row) => row['event_type'])).not.toContain(
			AUCTION_CLOSED_EVENT
		);
		expect(harness.appendedEvents.map((row) => row['event_type'])).not.toContain(
			BID_CANCELLED_EVENT
		);
		expect(harness.state.committed).toBe(true);
		// The board seat goes back exactly as any close releases it.
		expect(harness.releasedClaims).toEqual([['p-1']]);
	});

	it('issues NO roster read — there is no winning Team to key one on', async () => {
		// The short-circuit in `loadCloseState`. Both roster reads are keyed on
		// a winner: the drawn Team's own, and the batched candidate read the
		// cascade would need. An undrawn lottery has neither, and reverting
		// either short-circuit dereferences `null` and rolls the transaction
		// back — the Auction could then never close and the sweep would
		// re-offer it every pass.
		const harness = emptied();

		await closeAuction(harness.gateway, 'p-1');

		expect(harness.order).toEqual([
			'begin',
			'lock',
			'read-log',
			'read-seed',
			'append-event',
			'append-event',
			'release-claim',
			'commit'
		]);
		expect(harness.order).not.toContain('read-roster');
	});

	it('reveals the seed and records the empty list, with no winner', async () => {
		const harness = emptied();

		await closeAuction(harness.gateway, 'p-1');

		const drawn = harness.appendedEvents[0]?.['payload'] as UndrawnContentionPayload;
		// A published commitment that never opens is the one outcome AD-14
		// cannot survive, and an empty list does not excuse it.
		expect(drawn.seed).toBe(SEALED_SEED);
		expect(drawn.seedHash).toBe(hash(SEALED_SEED));
		expect(drawn.contenders).toEqual([]);
		expect(drawn.selectedIndex).toBeUndefined();
		expect(drawn.winningTeamId).toBeUndefined();

		// The termination names the NOMINATOR, never a bidder — there is no
		// winner, which is the whole reason it is this event.
		const terminated = harness.appendedEvents[1]?.['payload'] as AuctionTerminatedPayload;
		expect(terminated.fantraxPlayerId).toBe('p-1');
		expect(terminated.teamId).toBe('t-n');
		expect(terminated.managerId).toBe('m-n');
		expect(harness.appendedEvents[1]?.['team_id']).toBe('t-n');
	});

	it('mentions the nominating Team, and nobody else', async () => {
		// The Manager whose Nomination Slot just came back is the one party to
		// this event. Dropping the `AuctionTerminated` branch in
		// `affectedTeamsForClose` files no intent at all and they are never
		// told; addressing the cancelled Contenders instead would notify two
		// Teams about an Auction they already left.
		const harness = emptied();

		await closeAuction(harness.gateway, 'p-1');

		const terminationSeq = String(harness.appendedEvents[1]?.['seq']);
		const addressed = harness.outboxIntents
			.filter((intent) => intent.eventSeq === terminationSeq)
			.map((intent) => intent.recipient);

		expect(addressed).toEqual(['discord-t-n']);
		expect(addressed).not.toContain('discord-t-e');
		expect(addressed).not.toContain('discord-t-f');
	});
});
