/**
 * The transactional outbox and its dispatcher (Story 5.1, AD-17, AD-18).
 *
 * One local fake `ConnectionGateway`, `tests/server/sweep.test.ts`'s: it knows
 * only the statements these two functions issue and throws on anything else,
 * which is what makes "the drain writes nothing but outcome events" and "the
 * enqueue reads only `managers`" provable rather than merely unasserted.
 *
 * **The fake buffers writes until `commit` and discards them on `rollback`**,
 * unlike `shell-write.test.ts`'s, which only records statements. That is the
 * one property this story turns on: the intents and the events they describe
 * have to commit together or not at all, and a fake that persisted on INSERT
 * would report a rolled-back write as a durable one.
 *
 * The transport is a hand-built port, not the Discord adapter — `adapters` are
 * tested against their own wire shape in `tests/adapters/discord-webhook.test.ts`,
 * and everything here is about WHICH intents are attempted, in what order and
 * how often. There is no `vi.mock` and no `vi.stubGlobal`, as everywhere else
 * in this repository.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
	BROADCAST_RECIPIENT,
	DELIVERY_DELIVERED,
	DELIVERY_FAILED,
	DELIVERY_RATE_LIMITED,
	DISCORD_CHANNEL,
	DISPATCH_ATTEMPTED,
	NOTIFICATION_DISPATCHED_EVENT,
	PER_PASS_BUDGET,
	backoffMsFor,
	drainOutbox,
	duePendingIntents,
	enqueueBroadcasts,
	enqueueIntents
} from '../../src/lib/server/outbox.ts';
import type {
	ChannelPostResult,
	NotificationChannelPort,
	OutboxIntent
} from '../../src/lib/server/outbox.ts';
import { payloadFor } from '../../src/lib/adapters/discord/webhook.ts';
import { runTransactionalWrite } from '../../src/lib/shell/write.ts';
import type {
	ConnectionGateway,
	Decision,
	EnqueueFn,
	QueryResultRow,
	TransactionalClient
} from '../../src/lib/shell/write.ts';
import type { EventEnvelope } from '../../src/lib/core/types.ts';

const TEAM = 't-1';
const OTHER_TEAM = 't-2';
const MANAGER = 'm-1';
const ALICE = '1111';
const BOB = '2222';

/** One buffered intent row, as the fake stores it. */
type OutboxRow = {
	eventSeq: string;
	channel: string;
	recipient: string;
	createdAt: string;
};

/**
 * One `managers` row. `enqueueIntents` reads the snowflake; Story 5.2's
 * directory read reads the id, the display name and the Team.
 */
type ManagerRow = {
	teamId: string | null;
	discordUserId: string;
	id?: string;
	displayName?: string;
};

/** One `teams` row, as much of it as the directory read takes. */
type TeamRow = { id: string; name: string };

/** One `free_agent_players` row — the join that gives `BidPlaced` a name. */
type PlayerRow = { fantraxPlayerId: string; playerName: string };

function fakeGateway(
	options: {
		managers?: readonly ManagerRow[];
		teams?: readonly TeamRow[];
		players?: readonly PlayerRow[];
		now?: Date;
		/** Throw on the Nth outcome INSERT (1-based), as a lost connection would. */
		failOutcomeInsert?: number;
	} = {}
): {
	gateway: ConnectionGateway;
	statements: string[];
	events: QueryResultRow[];
	outbox: OutboxRow[];
	setNow(instant: Date): void;
	advance(ms: number): void;
} {
	const statements: string[] = [];
	const managers = options.managers ?? [];
	const teams = options.teams ?? [];
	const players = options.players ?? [];
	// Committed state.
	const events: QueryResultRow[] = [];
	const outbox: OutboxRow[] = [];
	// Uncommitted state, flushed on `commit` and dropped on `rollback`.
	let stagedEvents: QueryResultRow[] = [];
	let stagedOutbox: OutboxRow[] = [];
	let nextSeq = 1;
	let outcomeInserts = 0;
	let now = options.now ?? new Date('2026-09-03T12:00:00.000Z');

	const client: TransactionalClient & { release(): void } = {
		async query(text: string, params: readonly unknown[] = []) {
			const sql = text.trim().replace(/\s+/g, ' ');
			statements.push(sql);

			if (/^begin/i.test(sql)) {
				stagedEvents = [];
				stagedOutbox = [];
				return { rows: [] };
			}
			if (/^commit/i.test(sql)) {
				events.push(...stagedEvents);
				outbox.push(...stagedOutbox);
				stagedEvents = [];
				stagedOutbox = [];
				return { rows: [] };
			}
			if (/^rollback/i.test(sql)) {
				stagedEvents = [];
				stagedOutbox = [];
				return { rows: [] };
			}
			if (/pg_advisory_xact_lock/i.test(sql)) {
				return { rows: [{ locked: '', now }] };
			}
			if (/^select now\(\) as now$/i.test(sql)) {
				return { rows: [{ now }] };
			}
			if (/^insert into auction_events/i.test(sql)) {
				if (params[5] === NOTIFICATION_DISPATCHED_EVENT) {
					outcomeInserts += 1;
					if (outcomeInserts === options.failOutcomeInsert) {
						throw new Error('the connection died mid-outcome');
					}
				}
				const row: QueryResultRow = {
					seq: String(nextSeq++),
					occurred_at: params[0],
					schema_version: params[1],
					core_version: params[2],
					manager_id: params[3] ?? null,
					team_id: params[4] ?? null,
					event_type: params[5],
					payload: JSON.parse(String(params[6])),
					device_class: params[7] ?? null,
					dispatch_outcome: params[8] ?? null,
					delivery_outcome: params[9] ?? null
				};
				stagedEvents.push(row);
				return { rows: [row] };
			}
			if (/^select discord_user_id from managers where team_id = \$1/i.test(sql)) {
				return {
					rows: managers
						.filter((manager) => manager.teamId === params[0])
						.map((manager) => ({ discord_user_id: manager.discordUserId }))
						.sort((a, b) => (a.discord_user_id < b.discord_user_id ? -1 : 1))
				};
			}
			if (/^insert into notification_outbox/i.test(sql)) {
				const row: OutboxRow = {
					eventSeq: String(params[0]),
					channel: String(params[1]),
					recipient: String(params[2]),
					createdAt: String(params[3])
				};
				// The unique constraint, as `on conflict do nothing`.
				const clash = (candidate: OutboxRow): boolean =>
					candidate.eventSeq === row.eventSeq &&
					candidate.channel === row.channel &&
					candidate.recipient === row.recipient;
				if (!outbox.some(clash) && !stagedOutbox.some(clash)) stagedOutbox.push(row);
				return { rows: [] };
			}
			if (/^select o\.event_seq/i.test(sql)) {
				const rows = outbox
					.flatMap((intent) => {
						const event = events.find((candidate) => String(candidate['seq']) === intent.eventSeq);
						if (event === undefined) return [];
						// The left join on `payload ->> 'fantraxPlayerId'`, as the
						// real statement spells it.
						const payload = event['payload'];
						const fantraxPlayerId =
							typeof payload === 'object' && payload !== null
								? (payload as Record<string, unknown>)['fantraxPlayerId']
								: undefined;
						const player = players.find(
							(candidate) => candidate.fantraxPlayerId === fantraxPlayerId
						);
						return [
							{
								event_seq: intent.eventSeq,
								channel: intent.channel,
								recipient: intent.recipient,
								event_type: event['event_type'],
								payload: event['payload'],
								manager_id: event['manager_id'],
								occurred_at: event['occurred_at'],
								player_name: player?.playerName ?? null
							}
						];
					})
					.sort((a, b) => {
						if (a.event_seq !== b.event_seq) return Number(a.event_seq) - Number(b.event_seq);
						if (a.channel !== b.channel) return a.channel < b.channel ? -1 : 1;
						return a.recipient < b.recipient ? -1 : 1;
					});
				return { rows };
			}
			if (/^select id, name from teams$/i.test(sql)) {
				return { rows: teams.map((team) => ({ id: team.id, name: team.name })) };
			}
			if (/^select id, display_name, team_id from managers/i.test(sql)) {
				return {
					rows: managers.map((manager) => ({
						id: manager.id ?? manager.discordUserId,
						display_name: manager.displayName ?? manager.discordUserId,
						team_id: manager.teamId
					}))
				};
			}
			if (/^select occurred_at, payload, delivery_outcome from auction_events/i.test(sql)) {
				return {
					rows: events
						.filter((event) => event['event_type'] === params[0])
						.map((event) => ({
							occurred_at: event['occurred_at'],
							payload: event['payload'],
							delivery_outcome: event['delivery_outcome']
						}))
				};
			}
			throw new Error(`unexpected statement: ${sql}`);
		},
		release() {
			/* the pool is not what these tests are about */
		}
	};

	return {
		gateway: { connect: async () => client },
		statements,
		events,
		outbox,
		setNow: (instant: Date) => {
			now = instant;
		},
		advance: (ms: number) => {
			now = new Date(now.getTime() + ms);
		}
	};
}

/** A transport that records what it was asked to send and answers `answers`. */
function fakeChannel(
	answers: readonly (ChannelPostResult | 'throw')[] = [{ kind: 'delivered' }]
): {
	port: NotificationChannelPort;
	posts: Array<{ body: string; recipients: readonly string[] }>;
} {
	const posts: Array<{ body: string; recipients: readonly string[] }> = [];
	let call = 0;
	const port: NotificationChannelPort = {
		async post(message) {
			posts.push({ body: message.body, recipients: [...message.recipients] });
			const answer = answers[Math.min(call, answers.length - 1)] ?? { kind: 'delivered' };
			call += 1;
			if (answer === 'throw') throw new Error('the webhook socket died');
			return answer;
		}
	};
	return { port, posts };
}

/**
 * One accepted write, appending `events` and enqueuing their intents.
 *
 * `enqueue` defaults to `enqueueIntents` — Story 5.1's Manager-shaped enqueue,
 * which every mechanism suite below drives. Story 5.2's cases pass
 * `enqueueBroadcasts` explicitly, and the eligibility case passes `undefined`
 * to model a write that registers no enqueue at all.
 */
async function write(
	gateway: ConnectionGateway,
	events: readonly EventEnvelope[],
	kind: 'accepted' | 'rejected' = 'accepted',
	enqueue: EnqueueFn | undefined = enqueueIntents
): Promise<void> {
	await runTransactionalWrite({
		gateway,
		load: async () => ({}),
		decide: (): Decision =>
			kind === 'accepted' ? { kind: 'accepted', events } : { kind: 'rejected', reason: 'no' },
		enqueue
	});
}

const PLAYER = 'p-1';
const CLOSES_AT = '2026-09-04T02:30:00.000Z';
/** Discord's own timestamp markup for `CLOSES_AT` — the reader's local time. */
const CLOSES_AT_MARKUP = `<t:${String(Math.floor(Date.parse(CLOSES_AT) / 1000))}:f>`;

/** A real `BidPlaced`, payload and all — Story 5.2 composes from the payload. */
function bidPlaced(): EventEnvelope {
	return {
		type: 'BidPlaced',
		payload: {
			fantraxPlayerId: PLAYER,
			teamId: TEAM,
			teamName: 'Lakers',
			managerId: MANAGER,
			amount: 14_500_000,
			closesAt: CLOSES_AT
		},
		managerId: MANAGER,
		teamId: TEAM
	};
}

/** A real `NominationPlaced` — a second broadcast whose copy differs from the Bid's. */
function nominationPlaced(): EventEnvelope {
	return {
		type: 'NominationPlaced',
		payload: {
			fantraxPlayerId: PLAYER,
			playerName: 'Anthony Davis',
			teamId: TEAM,
			teamName: 'Lakers',
			managerId: MANAGER
		},
		managerId: MANAGER,
		teamId: TEAM
	};
}

/** A real `AuctionClosed`, for a Team and Player the caller names. */
function auctionClosed(input: {
	readonly teamId: string;
	readonly teamName: string;
	readonly managerId: string;
	readonly playerName: string;
	readonly winningAmount: number;
}): EventEnvelope {
	return {
		type: 'AuctionClosed',
		payload: {
			fantraxPlayerId: `p-${input.playerName}`,
			playerName: input.playerName,
			teamId: input.teamId,
			teamName: input.teamName,
			managerId: input.managerId,
			winningAmount: input.winningAmount,
			capHit: input.winningAmount,
			contractYears: null,
			closedAt: CLOSES_AT
		},
		managerId: input.managerId,
		teamId: input.teamId
	};
}

/** A real `NominationPlaced` naming one Player, so a backlog reads in order. */
function nominationOf(playerName: string): EventEnvelope {
	return {
		type: 'NominationPlaced',
		payload: {
			fantraxPlayerId: `p-${playerName}`,
			playerName,
			teamId: TEAM,
			teamName: 'Lakers',
			managerId: MANAGER
		},
		managerId: MANAGER,
		teamId: TEAM
	};
}

/** A team-affecting event envelope. */
function teamEvent(type: string, teamId: string | null = TEAM): EventEnvelope {
	return {
		type,
		payload: { note: type },
		managerId: teamId === null ? null : MANAGER,
		teamId
	};
}

/** Every `NotificationDispatched` the log holds, oldest first. */
function outcomes(harness: ReturnType<typeof fakeGateway>): QueryResultRow[] {
	return harness.events.filter(
		(event) => event['event_type'] === NOTIFICATION_DISPATCHED_EVENT
	);
}

// --- the intent side ------------------------------------------------------

describe('enqueueIntents — the intents commit with the events they describe', () => {
	it('inserts one intent per Manager of the Team, inside the SAME transaction (AC1)', async () => {
		// The matrix's first row: one appended event with `team_id` T, two
		// `managers` rows sharing T — co-management. AD-17 keys on
		// `(event seq, channel, recipient)` precisely so the second Manager is
		// not deduplicated away, and FR-27 requires both receive it.
		const harness = fakeGateway({
			managers: [
				{ teamId: TEAM, discordUserId: ALICE },
				{ teamId: TEAM, discordUserId: BOB },
				{ teamId: OTHER_TEAM, discordUserId: '9999' }
			]
		});

		await write(harness.gateway, [teamEvent('BidPlaced')]);

		expect(harness.outbox).toEqual([
			{ eventSeq: '1', channel: DISCORD_CHANNEL, recipient: ALICE, createdAt: expect.any(String) },
			{ eventSeq: '1', channel: DISCORD_CHANNEL, recipient: BOB, createdAt: expect.any(String) }
		]);

		// The intent INSERTs are between the event INSERT and the COMMIT —
		// which is what "in the same transaction" means operationally.
		const shape = harness.statements.map((sql) =>
			/^insert into auction_events/i.test(sql)
				? 'event'
				: /^insert into notification_outbox/i.test(sql)
					? 'intent'
					: /^commit/i.test(sql)
						? 'commit'
						: /^begin/i.test(sql)
							? 'begin'
							: 'other'
		);
		expect(shape.filter((step) => step !== 'other')).toEqual([
			'begin',
			'event',
			'intent',
			'intent',
			'commit'
		]);
	});

	it('stamps created_at from the event’s own clock read, never a second now()', async () => {
		const harness = fakeGateway({ managers: [{ teamId: TEAM, discordUserId: ALICE }] });

		await write(harness.gateway, [teamEvent('BidPlaced')]);

		const occurredAt = harness.events[0]?.['occurred_at'];
		expect(occurredAt).toBeInstanceOf(Date);
		expect(harness.outbox[0]?.createdAt).toBe((occurredAt as Date).toISOString());
	});

	it('creates no intent for an event with a null team_id — a system event mentions nobody', async () => {
		// The matrix's "Event with a null `team_id`" row. Since Story 3.7 the
		// actor pair may be null together, and that means the tick read a clock
		// rather than a Manager acting.
		const harness = fakeGateway({ managers: [{ teamId: TEAM, discordUserId: ALICE }] });

		await write(harness.gateway, [teamEvent('ContractAssignmentOpened', null)]);

		expect(harness.events).toHaveLength(1);
		expect(harness.outbox).toEqual([]);
	});

	it('persists neither events nor intents when the write is rejected', async () => {
		// The matrix's "A rejected write" row: `decide` returns `rejected`, the
		// transaction rolls back, and there is nothing left to drain.
		const harness = fakeGateway({ managers: [{ teamId: TEAM, discordUserId: ALICE }] });

		await write(harness.gateway, [teamEvent('BidPlaced')], 'rejected');

		expect(harness.events).toEqual([]);
		expect(harness.outbox).toEqual([]);
	});

	it('asks the registry once per distinct Team, not once per event', async () => {
		const harness = fakeGateway({ managers: [{ teamId: TEAM, discordUserId: ALICE }] });

		await write(harness.gateway, [
			teamEvent('BidPlaced'),
			teamEvent('AuctionClosed'),
			teamEvent('NominationPlaced')
		]);

		const lookups = harness.statements.filter((sql) => /from managers/i.test(sql));
		expect(lookups).toHaveLength(1);
		expect(harness.outbox).toHaveLength(3);
	});

	it('is idempotent on the key, so a duplicate intent can never fail an auction write', async () => {
		const harness = fakeGateway({ managers: [{ teamId: TEAM, discordUserId: ALICE }] });

		await write(harness.gateway, [teamEvent('BidPlaced')]);
		// Re-running the enqueue against the SAME appended event is what a
		// retried transaction would do. `on conflict do nothing` means a second
		// intent is the same intent, never a unique violation that would roll
		// back a Manager's Bid.
		const client = await harness.gateway.connect();
		await client.query('begin');
		await enqueueIntents(client, [
			{
				seq: '1',
				occurredAt: (harness.events[0]?.['occurred_at'] as Date).toISOString(),
				schemaVersion: 1,
				coreVersion: 1,
				type: 'BidPlaced',
				payload: null,
				managerId: MANAGER,
				teamId: TEAM,
				deviceClass: null,
				dispatchOutcome: null,
				deliveryOutcome: null
			}
		]);
		await client.query('commit');

		expect(harness.outbox).toHaveLength(1);
	});
});

// --- the pending derivation ----------------------------------------------

describe('duePendingIntents — pending is re-derived, never remembered', () => {
	const NOW = new Date('2026-09-03T12:00:00.000Z');
	const intent = (eventSeq: string, recipient: string): OutboxIntent => ({
		eventSeq,
		channel: DISCORD_CHANNEL,
		recipient,
		eventType: 'BidPlaced',
		// The derivation reads none of the joined columns — it decides WHICH
		// intents are due, never what they say.
		payload: null,
		managerId: MANAGER,
		occurredAt: NOW.toISOString(),
		playerName: null
	});

	it('treats an intent with no recorded attempt as due now', () => {
		const due = duePendingIntents({ intents: [intent('1', ALICE)], attempts: [], now: NOW });
		expect(due).toHaveLength(1);
	});

	it('retires an intent the moment a delivered attempt exists for its key', () => {
		const due = duePendingIntents({
			intents: [intent('1', ALICE), intent('1', BOB)],
			attempts: [
				{
					eventSeq: '1',
					channel: DISCORD_CHANNEL,
					recipient: ALICE,
					delivered: true,
					attemptedAt: NOW.toISOString(),
					retryAfterMs: null
				}
			],
			now: NOW
		});

		// Alice's is settled; Bob's — the co-manager's — is emphatically not.
		expect(due.map((pending) => pending.recipient)).toEqual([BOB]);
	});

	it('orders by seq then channel then recipient, with no incidental order left', () => {
		const due = duePendingIntents({
			intents: [intent('2', ALICE), intent('1', BOB), intent('1', ALICE)],
			attempts: [],
			now: NOW
		});
		expect(due.map((pending) => `${pending.eventSeq}:${pending.recipient}`)).toEqual([
			`1:${ALICE}`,
			`1:${BOB}`,
			`2:${ALICE}`
		]);
	});

	it('compares seq as BigInt, so a 10-digit log does not sort lexically', () => {
		const due = duePendingIntents({
			intents: [intent('10', ALICE), intent('9', ALICE)],
			attempts: [],
			now: NOW
		});
		expect(due.map((pending) => pending.eventSeq)).toEqual(['9', '10']);
	});

	it('waits the backoff after a failure, and stops waiting once it has elapsed', () => {
		const attempts = [
			{
				eventSeq: '1',
				channel: DISCORD_CHANNEL,
				recipient: ALICE,
				delivered: false,
				attemptedAt: NOW.toISOString(),
				retryAfterMs: null
			}
		];
		const tooSoon = new Date(NOW.getTime() + backoffMsFor(1) - 1);
		const due = new Date(NOW.getTime() + backoffMsFor(1));

		expect(duePendingIntents({ intents: [intent('1', ALICE)], attempts, now: tooSoon })).toEqual(
			[]
		);
		expect(
			duePendingIntents({ intents: [intent('1', ALICE)], attempts, now: due })
		).toHaveLength(1);
	});

	it('honours a 429’s retryAfterMs when it is longer than the backoff', () => {
		const retryAfterMs = backoffMsFor(1) * 10;
		const attempts = [
			{
				eventSeq: '1',
				channel: DISCORD_CHANNEL,
				recipient: ALICE,
				delivered: false,
				attemptedAt: NOW.toISOString(),
				retryAfterMs
			}
		];

		expect(
			duePendingIntents({
				intents: [intent('1', ALICE)],
				attempts,
				now: new Date(NOW.getTime() + retryAfterMs - 1)
			})
		).toEqual([]);
		expect(
			duePendingIntents({
				intents: [intent('1', ALICE)],
				attempts,
				now: new Date(NOW.getTime() + retryAfterMs)
			})
		).toHaveLength(1);
	});

	it('never lets a retry_after of zero collapse the backoff below it', () => {
		const attempts = [
			{
				eventSeq: '1',
				channel: DISCORD_CHANNEL,
				recipient: ALICE,
				delivered: false,
				attemptedAt: NOW.toISOString(),
				retryAfterMs: 0
			}
		];
		expect(
			duePendingIntents({
				intents: [intent('1', ALICE)],
				attempts,
				now: new Date(NOW.getTime() + backoffMsFor(1) - 1)
			})
		).toEqual([]);
	});

	it('caps at the budget and leaves the rest pending', () => {
		const intents = Array.from({ length: PER_PASS_BUDGET + 3 }, (_unused, index) =>
			intent(String(index + 1), ALICE)
		);
		expect(duePendingIntents({ intents, attempts: [], now: NOW })).toHaveLength(PER_PASS_BUDGET);
	});

	it('backs off further with each failure and then stops accelerating', () => {
		expect(backoffMsFor(0)).toBe(0);
		expect(backoffMsFor(1)).toBeLessThan(backoffMsFor(2));
		expect(backoffMsFor(2)).toBeLessThan(backoffMsFor(3));
		// Beyond the table, the last wait is reused forever — never dropped,
		// never accelerating.
		expect(backoffMsFor(50)).toBe(backoffMsFor(5));
	});
});

// --- the drain ------------------------------------------------------------

describe('drainOutbox — one pass', () => {
	it('dispatches both co-managers in one batched message and records both outcomes', async () => {
		const harness = fakeGateway({
			managers: [
				{ teamId: TEAM, discordUserId: ALICE },
				{ teamId: TEAM, discordUserId: BOB }
			]
		});
		await write(harness.gateway, [teamEvent('BidPlaced')]);
		const channel = fakeChannel();

		const summary = await drainOutbox(harness.gateway, {
			channels: { [DISCORD_CHANNEL]: channel.port }
		});

		// AD-18: batched into one request, both Managers mentioned.
		expect(channel.posts).toHaveLength(1);
		expect(channel.posts[0]?.recipients).toEqual([ALICE, BOB]);
		expect(summary).toEqual({
			attempted: 2,
			delivered: 2,
			rateLimited: 0,
			failed: 0,
			failures: []
		});

		// One outcome event per INTENT, not per request — the log records what
		// each Manager was owed, which is what the next pass derives from.
		const recorded = outcomes(harness);
		expect(recorded).toHaveLength(2);
		for (const event of recorded) {
			expect(event['dispatch_outcome']).toBe(DISPATCH_ATTEMPTED);
			expect(event['delivery_outcome']).toBe(DELIVERY_DELIVERED);
			// System-originated: nobody acted (Story 3.7's null actor pair).
			expect(event['manager_id']).toBeNull();
			expect(event['team_id']).toBeNull();
		}
		expect(
			recorded.map((event) => (event['payload'] as Record<string, unknown>)['recipient'])
		).toEqual([ALICE, BOB]);
	});

	it('dispatches nothing on a re-run of the same tick', async () => {
		// The matrix's "Retry of the same tick" row. The successful outcome
		// events remove both intents from the derived pending set, so this is
		// structural rather than guarded by a cursor.
		const harness = fakeGateway({
			managers: [
				{ teamId: TEAM, discordUserId: ALICE },
				{ teamId: TEAM, discordUserId: BOB }
			]
		});
		await write(harness.gateway, [teamEvent('BidPlaced')]);
		const channel = fakeChannel();
		const ports = { channels: { [DISCORD_CHANNEL]: channel.port } };

		await drainOutbox(harness.gateway, ports);
		const second = await drainOutbox(harness.gateway, ports);

		expect(second.attempted).toBe(0);
		expect(channel.posts).toHaveLength(1);
		expect(outcomes(harness)).toHaveLength(2);
	});

	it('creates no intent for its own NotificationDispatched — no feedback loop', async () => {
		// The matrix's "A `NotificationDispatched` event is appended" row. The
		// outcome write passes no `enqueue` at all, so this cannot happen by
		// construction rather than by a filter somebody could forget.
		const harness = fakeGateway({ managers: [{ teamId: TEAM, discordUserId: ALICE }] });
		await write(harness.gateway, [teamEvent('BidPlaced')]);
		const before = harness.outbox.length;

		await drainOutbox(harness.gateway, {
			channels: { [DISCORD_CHANNEL]: fakeChannel().port }
		});

		expect(outcomes(harness)).toHaveLength(1);
		expect(harness.outbox).toHaveLength(before);
	});

	it('does nothing at all, and issues no request, when nothing is pending', async () => {
		const harness = fakeGateway();
		const channel = fakeChannel();

		const summary = await drainOutbox(harness.gateway, {
			channels: { [DISCORD_CHANNEL]: channel.port }
		});

		expect(summary.attempted).toBe(0);
		expect(channel.posts).toEqual([]);
		expect(harness.events).toEqual([]);

		// **And it read no names.** The tick fires every ten seconds forever
		// and this is by far its commonest outcome, so an unconditional
		// directory read would cost an idle league two full-table reads 8,640
		// times a day to compose nothing. `readDueIntents` derives the due set
		// first — inside the same transaction, so the snapshot property still
		// holds for the reads that do run.
		expect(harness.statements.filter((sql) => /from teams|from managers/i.test(sql))).toEqual(
			[]
		);
	});

	it('sends the composed copy, naming an event ONCE however many intents it owes', async () => {
		// Story 5.2 replaced 5.1's placeholder. The body states what happened —
		// and states it once even though a co-managed Team contributes two
		// intents for the one event, because composition groups by `event_seq`.
		const harness = fakeGateway({
			managers: [
				{ teamId: TEAM, discordUserId: ALICE, id: MANAGER, displayName: 'Meakel' },
				{ teamId: TEAM, discordUserId: BOB, id: 'm-2', displayName: 'Dana' }
			],
			teams: [{ id: TEAM, name: 'Lakers' }],
			players: [{ fantraxPlayerId: PLAYER, playerName: 'Anthony Davis' }]
		});
		await write(harness.gateway, [bidPlaced()]);
		const channel = fakeChannel();

		await drainOutbox(harness.gateway, {
			channels: { [DISCORD_CHANNEL]: channel.port }
		});

		expect(channel.posts).toHaveLength(1);
		expect(channel.posts[0]?.body).toBe(
			`Lakers — Meakel bid $14.5M on Anthony Davis. Closes ${CLOSES_AT_MARKUP}.`
		);
	});
});

describe('drainOutbox — the budget', () => {
	it('attempts at most the budget’s worth and carries the remainder to the next pass', async () => {
		// The matrix's "Sweep closes many Auctions at once" row.
		const harness = fakeGateway({ managers: [{ teamId: TEAM, discordUserId: ALICE }] });
		const overflow = 3;
		await write(
			harness.gateway,
			Array.from({ length: PER_PASS_BUDGET + overflow }, (_unused, index) =>
				teamEvent(`Event${index}`)
			)
		);
		expect(harness.outbox).toHaveLength(PER_PASS_BUDGET + overflow);

		const channel = fakeChannel();
		const ports = { channels: { [DISCORD_CHANNEL]: channel.port } };

		const first = await drainOutbox(harness.gateway, ports);
		expect(first.attempted).toBe(PER_PASS_BUDGET);

		const second = await drainOutbox(harness.gateway, ports);
		expect(second.attempted).toBe(overflow);

		const third = await drainOutbox(harness.gateway, ports);
		expect(third.attempted).toBe(0);

		// Every intent eventually delivered, and never more than one request
		// per pass — batching keeps a burst well under AD-18's 30/min ceiling.
		expect(outcomes(harness)).toHaveLength(PER_PASS_BUDGET + overflow);
		expect(channel.posts).toHaveLength(2);
	});

	it('puts TWO Teams’ notices in ONE message, addressed to every Manager of both', async () => {
		// **Recording the shape, not choosing it.** The drain batches by
		// CHANNEL, so two different Teams' due intents collapse into a single
		// Discord message that mentions all of their Managers — Alice sees
		// Bob's Team's notice in the same message as her own, and both are
		// pinged by it. That falls straight out of AD-18's "the dispatcher
		// batches multiple events into one message where it can", and with a
		// generic payload it is unambiguous. It becomes a real question once
		// 5.2/5.3 write copy addressed to a particular Manager, and it is
		// logged as a design question for those stories. This test exists so
		// that the grouping is a decision somebody made rather than something
		// nobody noticed, and so a change to it goes red here first.
		const harness = fakeGateway({
			managers: [
				{ teamId: TEAM, discordUserId: ALICE, id: MANAGER, displayName: 'Meakel' },
				{ teamId: OTHER_TEAM, discordUserId: BOB, id: 'm-2', displayName: 'Ari' }
			],
			teams: [
				{ id: TEAM, name: 'Lakers' },
				{ id: OTHER_TEAM, name: 'Bulls' }
			],
			players: [{ fantraxPlayerId: PLAYER, playerName: 'Anthony Davis' }]
		});
		await write(harness.gateway, [
			bidPlaced(),
			auctionClosed({
				teamId: OTHER_TEAM,
				teamName: 'Bulls',
				managerId: 'm-2',
				playerName: 'Kevin Durant',
				winningAmount: 3_000_000
			})
		]);
		expect(harness.outbox).toEqual([
			{ eventSeq: '1', channel: DISCORD_CHANNEL, recipient: ALICE, createdAt: expect.any(String) },
			{ eventSeq: '2', channel: DISCORD_CHANNEL, recipient: BOB, createdAt: expect.any(String) }
		]);

		const channel = fakeChannel();
		const summary = await drainOutbox(harness.gateway, {
			channels: { [DISCORD_CHANNEL]: channel.port }
		});

		// ONE request, carrying both Teams' notices and both Managers.
		expect(channel.posts).toHaveLength(1);
		expect(channel.posts[0]).toEqual({
			// Real composed copy for both, one line each, in log order — which
			// is what makes the grouping question `deferred-work.md` raises
			// visible: Alice is pinged by a message whose second line is about
			// Bob's Team, and nothing in the text says which line is whose.
			body:
				`Lakers — Meakel bid $14.5M on Anthony Davis. Closes ${CLOSES_AT_MARKUP}.\n` +
				'Kevin Durant to Bulls — Ari for $3.0M.',
			recipients: [ALICE, BOB]
		});
		expect(summary).toMatchObject({ attempted: 2, delivered: 2 });

		// Still one outcome event per INTENT, each carrying its own Manager —
		// the batching is a transport decision and never collapses the record.
		const recorded = outcomes(harness);
		expect(
			recorded.map((event) => {
				const payload = event['payload'] as Record<string, unknown>;
				return `${String(payload['eventSeq'])}:${String(payload['recipient'])}`;
			})
		).toEqual([`1:${ALICE}`, `2:${BOB}`]);
	});

	it('takes the oldest events first, so a backlog drains in log order', async () => {
		// Asserted on the composed SENTENCES rather than on `event #n`: the
		// Player named in each line is the only thing that ties a notice back to
		// the event it came from now that the placeholder body is gone.
		const harness = fakeGateway({
			managers: [{ teamId: TEAM, discordUserId: ALICE, id: MANAGER, displayName: 'Meakel' }],
			teams: [{ id: TEAM, name: 'Lakers' }]
		});
		await write(harness.gateway, [
			nominationOf('Anthony Davis'),
			nominationOf('Kevin Durant'),
			nominationOf('Jayson Tatum')
		]);
		const channel = fakeChannel();

		await drainOutbox(harness.gateway, {
			channels: { [DISCORD_CHANNEL]: channel.port },
			budget: 2
		});

		expect(channel.posts[0]?.body).toBe(
			'Lakers — Meakel nominated Anthony Davis.\nLakers — Meakel nominated Kevin Durant.'
		);
		expect(channel.posts[0]?.body).not.toContain('Jayson Tatum');
	});
});

describe('drainOutbox — a 429 backs off and never drops the notice', () => {
	it('leaves the intent pending, records retryAfterMs, and waits at least that long', async () => {
		// The matrix's "Discord returns 429" row, all three halves.
		const harness = fakeGateway({ managers: [{ teamId: TEAM, discordUserId: ALICE }] });
		await write(harness.gateway, [teamEvent('BidPlaced')]);

		const retryAfterMs = 60_000;
		const channel = fakeChannel([
			{ kind: 'rate_limited', retryAfterMs, detail: 'Discord answered 429' },
			{ kind: 'delivered' }
		]);
		const ports = { channels: { [DISCORD_CHANNEL]: channel.port } };

		// A 429 is an expected outcome of a burst, not a fault: the drain
		// returns rather than throwing, so a rate-limit window does not paint
		// every heartbeat `completed_with_failures`.
		const first = await drainOutbox(harness.gateway, ports);
		expect(first).toMatchObject({ attempted: 1, delivered: 0, rateLimited: 1, failed: 0 });

		const recorded = outcomes(harness);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.['delivery_outcome']).toBe(DELIVERY_RATE_LIMITED);
		expect((recorded[0]?.['payload'] as Record<string, unknown>)['retryAfterMs']).toBe(
			retryAfterMs
		);

		// Still pending, and not yet due.
		harness.advance(retryAfterMs - 1);
		expect((await drainOutbox(harness.gateway, ports)).attempted).toBe(0);
		expect(channel.posts).toHaveLength(1);

		// The moment the wait has elapsed, it goes out.
		harness.advance(1);
		expect((await drainOutbox(harness.gateway, ports)).attempted).toBe(1);
		expect(channel.posts).toHaveLength(2);
		expect(outcomes(harness)[1]?.['delivery_outcome']).toBe(DELIVERY_DELIVERED);
	});
});

describe('drainOutbox — a failure is recorded first and reported second', () => {
	it('records the failed attempt, then throws so the heartbeat carries drainFailure', async () => {
		// The matrix's "Delivery throws or returns 5xx" row. Both halves: the
		// attempt is recorded and retried with backoff, AND the failure reaches
		// `tick_heartbeats` via the throw `server/sweep.ts` catches.
		const harness = fakeGateway({ managers: [{ teamId: TEAM, discordUserId: ALICE }] });
		await write(harness.gateway, [teamEvent('BidPlaced')]);
		const channel = fakeChannel([{ kind: 'failed', detail: 'Discord answered 503' }]);

		await expect(
			drainOutbox(harness.gateway, { channels: { [DISCORD_CHANNEL]: channel.port } })
		).rejects.toThrow('503');

		// Recorded BEFORE the throw — the backoff is already in effect.
		const recorded = outcomes(harness);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.['delivery_outcome']).toBe(DELIVERY_FAILED);
		expect(recorded[0]?.['dispatch_outcome']).toBe(DISPATCH_ATTEMPTED);

		// The auction event itself is untouched: appended, unmodified, and
		// carrying no dispatch columns of its own — `auction_events` grants no
		// UPDATE, so the outcome could only ever live on the new event.
		const bid = harness.events[0];
		expect(bid?.['event_type']).toBe('BidPlaced');
		expect(bid?.['dispatch_outcome']).toBeNull();
		expect(bid?.['delivery_outcome']).toBeNull();
	});

	it('treats a transport that throws exactly as a 5xx, and still records it', async () => {
		const harness = fakeGateway({ managers: [{ teamId: TEAM, discordUserId: ALICE }] });
		await write(harness.gateway, [teamEvent('BidPlaced')]);
		const channel = fakeChannel(['throw']);

		await expect(
			drainOutbox(harness.gateway, { channels: { [DISCORD_CHANNEL]: channel.port } })
		).rejects.toThrow('socket died');

		expect(outcomes(harness)).toHaveLength(1);
		expect(outcomes(harness)[0]?.['delivery_outcome']).toBe(DELIVERY_FAILED);
	});

	it('retries the failure on a later pass and delivers it', async () => {
		const harness = fakeGateway({ managers: [{ teamId: TEAM, discordUserId: ALICE }] });
		await write(harness.gateway, [teamEvent('BidPlaced')]);
		const channel = fakeChannel([{ kind: 'failed', detail: 'boom' }, { kind: 'delivered' }]);
		const ports = { channels: { [DISCORD_CHANNEL]: channel.port } };

		await expect(drainOutbox(harness.gateway, ports)).rejects.toThrow('boom');

		// Not yet: the backoff is in effect.
		harness.advance(backoffMsFor(1) - 1);
		expect((await drainOutbox(harness.gateway, ports)).attempted).toBe(0);

		harness.advance(1);
		expect((await drainOutbox(harness.gateway, ports)).delivered).toBe(1);
		expect(outcomes(harness)).toHaveLength(2);
	});

	it('commits each outcome in its OWN transaction, so a partial failure loses one', async () => {
		// **The blast radius, asserted.** One transaction for the whole pass
		// would fail as a unit: Discord has already accepted the batch, so a
		// single throw would leave none of the outcomes recorded and the next
		// pass would redeliver every one of them. Per intent — `sweep.ts`'s
		// one-transaction-per-close discipline (AD-11) applied to the other
		// side of the tick — the outcome written before the failure stands,
		// and only the intent whose own write died goes out again.
		const harness = fakeGateway({
			managers: [
				{ teamId: TEAM, discordUserId: ALICE },
				{ teamId: TEAM, discordUserId: BOB }
			],
			failOutcomeInsert: 2
		});
		await write(harness.gateway, [teamEvent('BidPlaced')]);
		const channel = fakeChannel();
		const ports = { channels: { [DISCORD_CHANNEL]: channel.port } };

		// Both were delivered; recording the second is what failed.
		await expect(drainOutbox(harness.gateway, ports)).rejects.toThrow('connection died');

		const recorded = outcomes(harness);
		expect(recorded).toHaveLength(1);
		expect((recorded[0]?.['payload'] as Record<string, unknown>)['recipient']).toBe(ALICE);

		// The next pass redelivers exactly the ONE whose outcome was lost —
		// the honest floor for a non-idempotent HTTP sink, and one message
		// rather than the whole pass.
		const second = await drainOutbox(harness.gateway, ports);
		expect(second.attempted).toBe(1);
		expect(channel.posts[1]?.recipients).toEqual([BOB]);
	});

	it('records — rather than raises — an intent for a channel with no port', async () => {
		// A configuration error must not drop the notice: it stays pending and
		// goes out the moment the port is wired (AD-17's "never dropped").
		const harness = fakeGateway({ managers: [{ teamId: TEAM, discordUserId: ALICE }] });
		await write(harness.gateway, [teamEvent('BidPlaced')]);

		await expect(drainOutbox(harness.gateway, { channels: {} })).rejects.toThrow(
			'no port is registered'
		);

		expect(outcomes(harness)[0]?.['delivery_outcome']).toBe(DELIVERY_FAILED);

		harness.advance(backoffMsFor(1));
		const channel = fakeChannel();
		const summary = await drainOutbox(harness.gateway, {
			channels: { [DISCORD_CHANNEL]: channel.port }
		});
		expect(summary.delivered).toBe(1);
	});
});


// --- Story 5.2: the broadcast intent and the composed post -----------------

describe('enqueueBroadcasts — one channel-addressed intent per broadcast event', () => {
	it('files exactly one intent, keyed on the sentinel and not on a Manager (AC1)', async () => {
		// The matrix's "A Bid is placed" row. One row, whatever the Team's
		// Manager count — a broadcast is addressed to the channel.
		const harness = fakeGateway({
			managers: [
				{ teamId: TEAM, discordUserId: ALICE, id: MANAGER, displayName: 'Meakel' },
				{ teamId: TEAM, discordUserId: BOB, id: 'm-2', displayName: 'Dana' }
			]
		});

		await write(harness.gateway, [bidPlaced()], 'accepted', enqueueBroadcasts);

		expect(harness.outbox).toEqual([
			{
				eventSeq: '1',
				channel: DISCORD_CHANNEL,
				recipient: BROADCAST_RECIPIENT,
				createdAt: expect.any(String)
			}
		]);
		// And it never asked `managers` anything: the broadcast set is a
		// property of the event TYPE, not of who is affected.
		expect(harness.statements.filter((sql) => /where team_id = \$1/i.test(sql))).toEqual([]);
	});

	it('files one for a phase event carrying a NULL team_id', async () => {
		// The matrix's "The phase ends" row, and the reason `enqueueIntents`
		// could not have been reused: it skips a null `teamId` outright.
		const harness = fakeGateway();

		await write(
			harness.gateway,
			[
				{
					type: 'ContractAssignmentOpened',
					payload: {
						expiredAt: CLOSES_AT,
						evaluatedAt: CLOSES_AT,
						terminatedPlayerIds: ['p-9', 'p-8']
					},
					managerId: null,
					teamId: null
				}
			],
			'accepted',
			enqueueBroadcasts
		);

		expect(harness.outbox).toHaveLength(1);
		expect(harness.outbox[0]?.recipient).toBe(BROADCAST_RECIPIENT);
	});

	it('files nothing for a write outside the broadcast set (AC1, second half)', async () => {
		// The matrix's "An eligibility or import write commits" row. Those
		// writes register no `enqueue` at all, so the mechanism cannot fire —
		// and even if one did, the type is not in the broadcast set.
		const harness = fakeGateway();
		const eligibility: EventEnvelope = {
			type: 'MinorLeagueEligibilityChanged',
			payload: {},
			managerId: MANAGER,
			teamId: TEAM
		};

		await write(harness.gateway, [eligibility], 'accepted', undefined);
		await write(harness.gateway, [eligibility], 'accepted', enqueueBroadcasts);

		expect(harness.outbox).toEqual([]);
	});

	it('leaves eligibility.ts and import-promotion.ts registering NO enqueue at all', async () => {
		// The case above drives this suite's own `write()` helper, which proves
		// the broadcast SET excludes those event types — but it says nothing
		// about the two production call sites, and the spec's **Never** list is
		// about the call sites: "eligibility.ts:272 and import-promotion.ts:273
		// must stay unwired". Wiring either one would enqueue an intent for
		// Commissioner bookkeeping and post it to the league channel, and no
		// other test in this repository would go red.
		//
		// Asserted against the source text because there is nothing else to
		// assert against: an enqueue that is never registered leaves no runtime
		// trace to observe. `tests/structure.test.ts` reads source the same way
		// for the same reason. Two independent checks, because wiring one needs
		// BOTH the symbol and the property — either alone catches it.
		for (const name of ['eligibility', 'import-promotion']) {
			const source = readFileSync(
				fileURLToPath(new URL(`../../src/lib/server/${name}.ts`, import.meta.url)),
				'utf8'
			);
			expect(source, `${name}.ts must register no enqueue`).not.toMatch(/\benqueue\s*:/);
			expect(source, `${name}.ts must import no enqueue function`).not.toMatch(
				/\benqueue(Broadcasts|Intents)\b/
			);
		}
	});
});

describe('drainOutbox — the broadcast post', () => {
	/** A league with one named Team, one named Manager and one named Player. */
	function league(): Parameters<typeof fakeGateway>[0] {
		return {
			managers: [{ teamId: TEAM, discordUserId: ALICE, id: MANAGER, displayName: 'Meakel' }],
			teams: [{ id: TEAM, name: 'Lakers' }],
			players: [{ fantraxPlayerId: PLAYER, playerName: 'Anthony Davis' }]
		};
	}

	it('mentions NOBODY: the sentinel never reaches recipients (AC2)', async () => {
		// `recipients` becomes both the `<@id>` prefix and
		// `allowed_mentions.users`, so a sentinel in it would render a literal
		// `<@#channel>` and hand Discord a non-snowflake. 5.2 mentions nobody.
		const harness = fakeGateway(league());
		await write(harness.gateway, [bidPlaced()], 'accepted', enqueueBroadcasts);
		const channel = fakeChannel();

		await drainOutbox(harness.gateway, { channels: { [DISCORD_CHANNEL]: channel.port } });

		expect(channel.posts[0]?.recipients).toEqual([]);
		expect(channel.posts[0]?.body).not.toContain(BROADCAST_RECIPIENT);
		// The POST's own recipients, never a literal `[]` — handing `payloadFor`
		// an empty list would feed it the answer this case exists to prove.
		expect(
			payloadFor({
				body: channel.posts[0]?.body ?? '',
				recipients: channel.posts[0]?.recipients ?? ['a sentinel that must not survive']
			})
		).toEqual({
			content: `Lakers — Meakel bid $14.5M on Anthony Davis. Closes ${CLOSES_AT_MARKUP}.`,
			allowed_mentions: { parse: [], users: [] }
		});
	});

	it('batches a draw and the close it caused into ONE post', async () => {
		// The matrix's "A Minimum-Bid Contention closes" row: one transaction
		// appends `ContentionDrawn` then `AuctionClosed`, so both intents are
		// due together and both lines go out in one message, cause first.
		const harness = fakeGateway({
			managers: [
				{ teamId: TEAM, discordUserId: ALICE, id: MANAGER, displayName: 'Meakel' },
				{ teamId: OTHER_TEAM, discordUserId: BOB, id: 'm-2', displayName: 'Ari' }
			],
			teams: [
				{ id: TEAM, name: 'Lakers' },
				{ id: OTHER_TEAM, name: 'Bulls' }
			],
			players: [{ fantraxPlayerId: PLAYER, playerName: 'Anthony Davis' }]
		});

		await write(
			harness.gateway,
			[
				{
					type: 'ContentionDrawn',
					payload: {
						fantraxPlayerId: PLAYER,
						seed: '9f3c8a1d',
						seedHash: 'h',
						contenders: [TEAM, OTHER_TEAM],
						selectedIndex: 0,
						winningTeamId: TEAM,
						winningTeamName: 'Lakers',
						winningManagerId: MANAGER,
						drawnAt: CLOSES_AT
					},
					managerId: MANAGER,
					teamId: TEAM
				},
				{
					type: 'AuctionClosed',
					payload: {
						fantraxPlayerId: PLAYER,
						playerName: 'Anthony Davis',
						teamId: TEAM,
						teamName: 'Lakers',
						managerId: MANAGER,
						winningAmount: 14_500_000,
						capHit: 14_500_000,
						contractYears: null,
						closedAt: CLOSES_AT
					},
					managerId: MANAGER,
					teamId: TEAM
				}
			],
			'accepted',
			enqueueBroadcasts
		);
		const channel = fakeChannel();

		const summary = await drainOutbox(harness.gateway, {
			channels: { [DISCORD_CHANNEL]: channel.port }
		});

		expect(channel.posts).toHaveLength(1);
		expect(channel.posts[0]?.body).toBe(
			'Anthony Davis drawn to Lakers — Meakel. Seed: 9f3c8a1d. ' +
				'Contenders, in order: Lakers — Meakel, Bulls — Ari.\n' +
				'Anthony Davis to Lakers — Meakel for $14.5M.'
		);
		expect(summary).toMatchObject({ attempted: 2, delivered: 2 });
	});

	it('names a phase end with no Team at all', async () => {
		const harness = fakeGateway(league());
		await write(
			harness.gateway,
			[
				{
					type: 'ContractAssignmentOpened',
					payload: {
						expiredAt: CLOSES_AT,
						evaluatedAt: CLOSES_AT,
						terminatedPlayerIds: ['p-9']
					},
					managerId: null,
					teamId: null
				}
			],
			'accepted',
			enqueueBroadcasts
		);
		const channel = fakeChannel();

		await drainOutbox(harness.gateway, { channels: { [DISCORD_CHANNEL]: channel.port } });

		expect(channel.posts[0]?.body).toBe(
			'The Auction Phase has ended and Contract Assignment is open. ' +
				'1 nominated Player ended with no Bid.'
		);
		expect(channel.posts[0]?.recipients).toEqual([]);
	});

	it('leaves a notice the ceiling excluded PENDING, and posts it on the next pass', async () => {
		// The second half of the matrix's "A batch would exceed the message
		// ceiling" row, and the reason the ceiling drops whole notices instead
		// of truncating the joined body: an excluded intent is given no
		// outcome, so the next pass re-derives it as pending. Asserting this at
		// the composer alone would prove the split and not the recovery.
		const harness = fakeGateway(league());
		await write(harness.gateway, [bidPlaced()], 'accepted', enqueueBroadcasts);
		await write(harness.gateway, [nominationPlaced()], 'accepted', enqueueBroadcasts);
		const channel = fakeChannel();

		// A ceiling that fits the first notice and not both.
		const first = await drainOutbox(harness.gateway, {
			channels: { [DISCORD_CHANNEL]: channel.port },
			ceiling: 80
		});
		// BOTH counters, because they are four independent statements now
		// counting `message.posted.length`: asserting only `delivered` would let
		// a revert of the `attempted` line ship silently, and `attempted` is the
		// number the tick puts in its JSON response for an operator to read.
		expect(first.attempted).toBe(1);
		expect(first.delivered).toBe(1);
		expect(channel.posts).toHaveLength(1);

		// Nothing recorded an outcome for the excluded one, so it is still owed.
		const second = await drainOutbox(harness.gateway, {
			channels: { [DISCORD_CHANNEL]: channel.port }
		});
		expect(second.delivered).toBe(1);
		expect(channel.posts).toHaveLength(2);

		// And the two passes together said everything exactly once.
		expect(channel.posts[0]?.body).not.toEqual(channel.posts[1]?.body);

		// A third pass owes nothing at all.
		expect((await drainOutbox(harness.gateway, {
			channels: { [DISCORD_CHANNEL]: channel.port }
		})).attempted).toBe(0);
	});

	it('settles every posted intent, so a retry after a delivered post sends nothing', async () => {
		// The matrix's "Retry after a delivered post" row, against real copy.
		const harness = fakeGateway(league());
		await write(harness.gateway, [bidPlaced()], 'accepted', enqueueBroadcasts);
		const channel = fakeChannel();
		const ports = { channels: { [DISCORD_CHANNEL]: channel.port } };

		expect((await drainOutbox(harness.gateway, ports)).delivered).toBe(1);
		expect((await drainOutbox(harness.gateway, ports)).attempted).toBe(0);
		expect(channel.posts).toHaveLength(1);
	});

	it('degrades an unrecognised payload to a plain factual line, and never throws', async () => {
		// The matrix's "A payload is unrecognised or malformed" row.
		const harness = fakeGateway(league());
		await write(
			harness.gateway,
			[{ type: 'BidPlaced', payload: { amount: 'not a number' }, managerId: null, teamId: null }],
			'accepted',
			enqueueBroadcasts
		);
		const channel = fakeChannel();

		const summary = await drainOutbox(harness.gateway, {
			channels: { [DISCORD_CHANNEL]: channel.port }
		});

		expect(channel.posts[0]?.body).toBe('A BidPlaced was recorded (event #1).');
		expect(summary.delivered).toBe(1);
	});
});
