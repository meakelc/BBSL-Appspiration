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
	EVERY_TEAM,
	enqueueBroadcasts,
	enqueueBroadcastsAndMentions,
	enqueueMentions
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
 * One `managers` row. `enqueueMentions` reads the snowflake to ADDRESS an
 * intent; the directory read reads the id, the display name, the Team and —
 * since Story 5.3 — the snowflake again, to say whose Team one acts for.
 */
type ManagerRow = {
	teamId: string | null;
	discordUserId: string;
	/**
	 * `managers.discord_mention_user_id` — the guild snowflake to @mention this
	 * Manager at, when it is not the account they sign in with.
	 *
	 * OMITTED is the common case and means a NULL column, which the `coalesce`
	 * in both real statements turns back into `discordUserId`. `addressOf`
	 * below resolves it exactly once, so a fixture cannot address an intent by
	 * one snowflake and name it by the other.
	 */
	discordMentionUserId?: string;
	id?: string;
	displayName?: string;
	/**
	 * Story 5.4's preference, as the LEFT JOIN delivers it. OMITTED is the
	 * common case and means "no row in `manager_notification_preferences`",
	 * which the `coalesce` in the real statement turns into `false`.
	 *
	 * A STRING is allowed because a driver is allowed to hand one back:
	 * `isTrueFlag` accepts `'t'`/`'true'` for exactly that reason, and a
	 * fixture that could only produce real booleans would leave that branch —
	 * the one whose failure silently unmutes the whole league — unrun.
	 */
	slotReleaseMuted?: boolean | string;
};

/**
 * The snowflake a Manager is ADDRESSED at, as `coalesce(discord_mention_user_id,
 * discord_user_id)` resolves it in `MANAGERS_OF_TEAM_SQL`,
 * `MANAGERS_OF_EVERY_TEAM_SQL` and `MANAGER_NAMES_SQL` alike.
 *
 * One function for all three, because the three agreeing is the invariant the
 * override depends on: the intent carries this value, and the directory's
 * reverse map is keyed on it. A fake that resolved them separately could pass
 * while the real statements disagreed.
 */
const addressOf = (manager: ManagerRow): string =>
	manager.discordMentionUserId ?? manager.discordUserId;

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
			if (/^select coalesce\(.+\) as discord_user_id from managers where team_id is not null/i.test(sql)) {
				return {
					rows: managers
						.filter((manager) => manager.teamId !== null)
						.map((manager) => ({ discord_user_id: addressOf(manager) }))
						.sort((a, b) => (a.discord_user_id < b.discord_user_id ? -1 : 1))
				};
			}
			if (/^select coalesce\(.+\) as discord_user_id from managers where team_id = \$1/i.test(sql)) {
				return {
					rows: managers
						.filter((manager) => manager.teamId === params[0])
						.map((manager) => ({ discord_user_id: addressOf(manager) }))
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
			if (/left join manager_notification_preferences/i.test(sql)) {
				return {
					// The LEFT JOIN and its `coalesce`, as the real statement
					// spells them (Story 5.4): a Manager with NO preference row
					// arrives as `false`, never as `null`, which is what makes
					// "absence is the default" true in the fold rather than in a
					// comment. A fixture row that states nothing is such a
					// Manager.
					rows: managers.map((manager) => ({
						id: manager.id ?? manager.discordUserId,
						display_name: manager.displayName ?? manager.discordUserId,
						team_id: manager.teamId,
						// The ADDRESS, not the identity — the real statement
						// selects the same `coalesce` under the same alias, so
						// that `managerIdsByDiscordUserId` is the reverse of
						// what an intent was addressed with.
						discord_user_id: addressOf(manager),
						slot_release_muted: manager.slotReleaseMuted ?? false
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
 * The Manager-shaped enqueue the mechanism suites drive: one intent per Manager
 * of the event's OWN Team.
 *
 * **Not a production shape, and deliberately so.** Story 5.3 moved targeting to
 * the write site precisely because the event's own `team_id` is the ACTING Team
 * and every mention trigger names somebody else. Nothing in `src/` asks for
 * this. It is reconstructed here from the same factory because the mechanism
 * suites below are about WHICH intents are attempted, in what order and how
 * often — questions that need Manager-addressed intents and care nothing about
 * who deserved one. The trigger rules are proved at the write sites instead.
 */
const enqueueActingTeam = enqueueMentions((event) =>
	event.teamId === null ? [] : [event.teamId]
);

/**
 * One accepted write, appending `events` and enqueuing their intents.
 *
 * `enqueue` defaults to `enqueueActingTeam` above. Story 5.2's cases pass
 * `enqueueBroadcasts` explicitly, and the eligibility case passes `undefined`
 * to model a write that registers no enqueue at all.
 */
async function write(
	gateway: ConnectionGateway,
	events: readonly EventEnvelope[],
	kind: 'accepted' | 'rejected' = 'accepted',
	enqueue: EnqueueFn | undefined = enqueueActingTeam
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

describe('enqueueMentions — the intents commit with the events they describe', () => {
	it('inserts one intent per Manager of the AFFECTED Team, inside the SAME transaction (AC1)', async () => {
		// The matrix's co-managed row. One appended event, two `managers` rows
		// sharing the affected Team — co-management. AD-17 keys on
		// `(event seq, channel, recipient)` precisely so the second Manager is
		// not deduplicated away, and FR-27 requires both receive it.
		//
		// **The affected Team is not the acting one**, which is the whole of
		// this story's change: the event is appended for `TEAM` (the bidder)
		// and the intents are filed for `OTHER_TEAM` (the Team it outbid).
		const harness = fakeGateway({
			managers: [
				{ teamId: OTHER_TEAM, discordUserId: ALICE },
				{ teamId: OTHER_TEAM, discordUserId: BOB },
				{ teamId: TEAM, discordUserId: '9999' }
			]
		});

		await write(
			harness.gateway,
			[teamEvent('BidPlaced')],
			'accepted',
			enqueueMentions(() => [OTHER_TEAM])
		);

		expect(harness.outbox).toEqual([
			{ eventSeq: '1', channel: DISCORD_CHANNEL, recipient: ALICE, createdAt: expect.any(String) },
			{ eventSeq: '1', channel: DISCORD_CHANNEL, recipient: BOB, createdAt: expect.any(String) }
		]);
		// The bidder's own Manager is NOT notified of their own act.
		expect(harness.outbox.map((row) => row.recipient)).not.toContain('9999');

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

	it('files nothing when the write site names no affected Team', async () => {
		// Three matrix rows at once, and all three reach here identically: a
		// Team outbidding ITSELF, the FIRST Bid on an Auction, and any event
		// outside the trigger set. The write site answered with an empty list,
		// so the broadcast posts alone and nobody is pinged.
		const harness = fakeGateway({ managers: [{ teamId: TEAM, discordUserId: ALICE }] });

		await write(
			harness.gateway,
			[teamEvent('BidPlaced')],
			'accepted',
			enqueueMentions(() => [])
		);

		expect(harness.events).toHaveLength(1);
		expect(harness.outbox).toEqual([]);
		// And it asked the registry nothing: no affected Team, no lookup.
		expect(harness.statements.filter((sql) => /from managers/i.test(sql))).toEqual([]);
	});

	it('files nothing for a Team with no Manager rows, and never loses the broadcast', async () => {
		// The matrix's "A Team has no Manager rows" row. An unmanaged Team is a
		// supported state (a nullable `managers.team_id`); the broadcast still
		// posts and still names the Team, which IS the record. Only the ping is
		// absent — which is precisely what 5.4 will let a Manager choose.
		const harness = fakeGateway({ managers: [{ teamId: TEAM, discordUserId: ALICE }] });

		await write(
			harness.gateway,
			[bidPlaced()],
			'accepted',
			enqueueBroadcastsAndMentions(() => [OTHER_TEAM])
		);

		expect(harness.outbox).toEqual([
			{
				eventSeq: '1',
				channel: DISCORD_CHANNEL,
				recipient: BROADCAST_RECIPIENT,
				createdAt: expect.any(String)
			}
		]);
	});

	it('resolves EVERY_TEAM to every Manager who acts for any Team', async () => {
		// The matrix's "The phase opens" row: `ContractAssignmentOpened` carries
		// a null `team_id` and affects the whole league. Resolved in the enqueue
		// rather than enumerated at the write site, because `evaluateLeagueClock`
		// runs every ten seconds and appends nothing on almost all of them.
		const harness = fakeGateway({
			managers: [
				{ teamId: TEAM, discordUserId: ALICE },
				{ teamId: OTHER_TEAM, discordUserId: BOB },
				// A Manager with no Team: a supported state, and not a party to
				// a league-wide auction notice.
				{ teamId: null, discordUserId: '9999' }
			]
		});

		await write(
			harness.gateway,
			[teamEvent('ContractAssignmentOpened', null)],
			'accepted',
			enqueueMentions(() => [EVERY_TEAM])
		);

		expect(harness.outbox.map((row) => row.recipient)).toEqual([ALICE, BOB]);
	});

	it('stamps created_at from the event’s own clock read, never a second now()', async () => {
		const harness = fakeGateway({ managers: [{ teamId: TEAM, discordUserId: ALICE }] });

		await write(harness.gateway, [teamEvent('BidPlaced')]);

		const occurredAt = harness.events[0]?.['occurred_at'];
		expect(occurredAt).toBeInstanceOf(Date);
		expect(harness.outbox[0]?.createdAt).toBe((occurredAt as Date).toISOString());
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

	it('files ONE intent for a Manager named by two affected Teams on one event', async () => {
		// A close whose leader and nominator are the same Team, or a Manager who
		// somehow acts for two affected Teams. `on conflict do nothing` would
		// absorb the duplicate, but the enqueue should not be relying on it —
		// and the composer would otherwise be handed the same snowflake twice.
		const harness = fakeGateway({ managers: [{ teamId: TEAM, discordUserId: ALICE }] });

		await write(
			harness.gateway,
			[teamEvent('AuctionClosed')],
			'accepted',
			enqueueMentions(() => [TEAM, TEAM, OTHER_TEAM])
		);

		expect(harness.outbox.map((row) => row.recipient)).toEqual([ALICE]);
	});

	it('files the broadcast row BESIDE the mention rows, on the one write', async () => {
		// The two coexist on the same event rather than colliding, which is what
		// the sentinel bought (`BROADCAST_RECIPIENT`'s own note in 5.2). One
		// event, three intents: the channel and both co-managers.
		const harness = fakeGateway({
			managers: [
				{ teamId: OTHER_TEAM, discordUserId: ALICE },
				{ teamId: OTHER_TEAM, discordUserId: BOB }
			]
		});

		await write(
			harness.gateway,
			[bidPlaced()],
			'accepted',
			enqueueBroadcastsAndMentions(() => [OTHER_TEAM])
		);

		expect(harness.outbox.map((row) => row.recipient)).toEqual([
			BROADCAST_RECIPIENT,
			ALICE,
			BOB
		]);
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
		await enqueueActingTeam(client, [
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

	it('slices on EVENT boundaries, never inside one event’s group', () => {
		// **The property Story 5.3 needed.** Before it, every event owed one
		// intent and the cut could only fall between events. A co-managed
		// outbid owes three — the broadcast and two mentions — and a cut
		// inside that group would post the FACT this pass and the mention next
		// pass, as a second message repeating the same line with a ping on it.
		const intents = [
			intent('1', BROADCAST_RECIPIENT),
			intent('1', ALICE),
			intent('1', BOB),
			intent('2', BROADCAST_RECIPIENT),
			intent('2', ALICE),
			intent('2', BOB)
		];

		// Four would land in the middle of event 2's group. Three go instead.
		const due = duePendingIntents({ intents, attempts: [], now: NOW, budget: 4 });

		expect(due.map((pending) => pending.eventSeq)).toEqual(['1', '1', '1']);
	});

	it('takes a whole event even when that ONE event exceeds the budget', () => {
		// `ContractAssignmentOpened` mentions every Manager in the league —
		// thirty-odd intents on one event against a budget of five. A rule
		// that took whole groups ONLY would take nothing, forever, and stall
		// the outbox on the one notice the whole league is waiting for.
		// `broadcastBodyFor` makes the identical exception at the message
		// ceiling: it is the only exit that terminates (AD-17).
		const intents = Array.from({ length: PER_PASS_BUDGET + 3 }, (_unused, index) =>
			intent('1', `recipient-${String(index)}`)
		);

		const due = duePendingIntents({ intents, attempts: [], now: NOW });

		expect(due).toHaveLength(PER_PASS_BUDGET + 3);
	});

	it('attempts nothing at all when the budget is zero or negative', () => {
		// The override has to be able to express “post nothing”, or the
		// first-group exception above would make a zero budget dispatch a
		// whole group.
		const intents = [intent('1', ALICE), intent('1', BOB)];

		expect(duePendingIntents({ intents, attempts: [], now: NOW, budget: 0 })).toEqual([]);
		expect(duePendingIntents({ intents, attempts: [], now: NOW, budget: -2 })).toEqual([]);
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

	it('composes and posts a MENTION-ONLY group, with no channel-addressed intent', async () => {
		// `AssignmentRemindersSent` (Story 6.2) is the first event type ever
		// enqueued for mentions that is NOT also in `BROADCAST_EVENT_TYPES`, so
		// this is the first group `composeBatch` has ever built with no
		// `BROADCAST_RECIPIENT` row in it. Every earlier drain test used an event
		// that was broadcast and mentioned at once, which means the notice was
		// always owed for a reason independent of the mentions. Here the notice
		// is composed ONLY because a mention rides it — remove that and the
		// reminder silently stops reaching Discord while its intents still look
		// correctly filed in `notification_outbox`.
		const harness = fakeGateway({
			managers: [{ teamId: TEAM, discordUserId: ALICE }],
			// The directory needs the Team's name: `mentionSuffixFor` addresses
			// `<@id> — Lakers — Meakel` and falls back to the bare "was recorded"
			// line without it.
			teams: [{ id: TEAM, name: 'Lakers' }]
		});
		const reminder: EventEnvelope = {
			type: 'AssignmentRemindersSent',
			payload: {
				deadline: '2026-09-10T17:00:00.000Z',
				outstandingTeamIds: [TEAM],
				outstandingPlayerCount: 2,
				evaluatedAt: '2026-09-09T17:00:00.000Z'
			},
			// The tick compared a clock; nobody acted.
			managerId: null,
			teamId: null
		};

		await write(harness.gateway, [reminder], 'accepted', enqueueMentions(() => [TEAM]));

		// No sentinel row was filed — the event is deliberately not broadcast.
		expect(harness.outbox.map((intent) => intent['recipient'])).toEqual([ALICE]);

		const channel = fakeChannel();
		await drainOutbox(harness.gateway, { channels: { [DISCORD_CHANNEL]: channel.port } });

		// It still reaches the channel, because a mention IS a channel post.
		expect(channel.posts).toHaveLength(1);
		expect(channel.posts[0]?.recipients).toEqual([ALICE]);
		const body = channel.posts[0]?.body ?? '';
		expect(body).toContain('The contract assignment deadline is 2026-09-10T17:00:00.000Z.');
		expect(body).toContain(`<@${ALICE}>`);
		expect(body).toContain('still have Players with no contract length.');
		// The fallback line would mean `noticeFor` never learned this type.
		expect(body).not.toContain('was recorded (event #');
		// And the tally of who is late stays with the deadline notice.
		expect(body).not.toContain('2 Teams');
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
		// The fact once, the mention once, and both Managers of the co-managed
		// Team on the one line as two distinct `<@id>` (Story 5.3). The mention
		// rides its own event's notice rather than the head of the message,
		// which is what lets a reader of a five-event post tell which line is
		// theirs.
		expect(channel.posts[0]?.body).toBe(
			`Lakers — Meakel bid $14.5M on Anthony Davis. Closes ${CLOSES_AT_MARKUP}.
` +
				`<@${ALICE}> <@${BOB}> — Lakers — Meakel & Dana were outbid.`
		);
		expect(channel.posts[0]?.recipients).toEqual([ALICE, BOB]);
	});

	it('joins the origin onto the Auction path, and posts without a link when there is none', async () => {
		// The matrix's "The app origin is unset" row, both halves. The origin
		// is a THUNK the drain calls only once a notice is owed, and
		// `core/auction-link.ts` is the one place the path shape is spelled.
		const league = {
			managers: [{ teamId: TEAM, discordUserId: ALICE, id: MANAGER, displayName: 'Meakel' }],
			teams: [{ id: TEAM, name: 'Lakers' }],
			players: [{ fantraxPlayerId: PLAYER, playerName: 'Anthony Davis' }]
		};

		const linked = fakeGateway(league);
		await write(linked.gateway, [bidPlaced()]);
		const withOrigin = fakeChannel();
		await drainOutbox(linked.gateway, {
			channels: { [DISCORD_CHANNEL]: withOrigin.port },
			// A trailing slash, because a deployment variable arrives however
			// somebody typed it and `/auction/x` already carries a leading one.
			origin: () => 'https://bbsl.example/'
		});
		expect(withOrigin.posts[0]?.body).toContain(`https://bbsl.example/auction/${PLAYER}`);

		const bare = fakeGateway(league);
		await write(bare.gateway, [bidPlaced()]);
		const withoutOrigin = fakeChannel();
		await drainOutbox(bare.gateway, {
			channels: { [DISCORD_CHANNEL]: withoutOrigin.port },
			origin: () => undefined
		});
		// The mention still posts — without a link rather than not at all.
		expect(withoutOrigin.posts[0]?.body).toContain(`<@${ALICE}>`);
		expect(withoutOrigin.posts[0]?.body).not.toContain('http');
	});

	it('never evaluates the origin on an idle pass', async () => {
		// `readDueIntents` returns before anything is composed, and the tick
		// fires every ten seconds forever: an idle league must not pay for a
		// notification setting it has no notice to use.
		const harness = fakeGateway();
		let reads = 0;

		await drainOutbox(harness.gateway, {
			channels: { [DISCORD_CHANNEL]: fakeChannel().port },
			origin: () => {
				reads += 1;
				return 'https://bbsl.example';
			}
		});

		expect(reads).toBe(0);
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
			// Real composed copy for both, in log order — and since Story 5.3
			// each mention sits UNDER the notice for its own event. That closes
			// the batching-granularity item `deferred-work.md` raised against 5.1
			// without regrouping the batch by `(channel, recipient)`: Alice is
			// still pinged by a message that also carries Bob's Team's notice, but
			// the text now says which line is whose.
			body:
				`Lakers — Meakel bid $14.5M on Anthony Davis. Closes ${CLOSES_AT_MARKUP}.\n` +
				`<@${ALICE}> — Lakers — Meakel were outbid.\n` +
				'Kevin Durant to Bulls — Ari for $3.0M.\n' +
				`<@${BOB}> — Bulls — Ari led this Auction at its close.`,
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
		// Broadcast intents only: this case is about the ORDER a backlog
		// drains in, and a `NominationPlaced` triggers no mention.
		await write(
			harness.gateway,
			[
				nominationOf('Anthony Davis'),
				nominationOf('Kevin Durant'),
				nominationOf('Jayson Tatum')
			],
			'accepted',
			enqueueBroadcasts
		);
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
				/\benqueue(Broadcasts|Mentions|BroadcastsAndMentions|Intents)\b/
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

// --- the mute, through the directory read (Story 5.4) ----------------------

describe('the directory fold carries the mute, and absence reads as not muted', () => {
	const CAROL = '3333';

	/**
	 * A close that RELEASES the Lakers' Nomination Slot: the Bulls won, so the
	 * addressed Team's clause is `slot_release` — the one mutable category.
	 * The Lakers are co-managed, which is the case the mute has to get right.
	 */
	function slotReleasedForLakers(): EventEnvelope {
		return auctionClosed({
			teamId: OTHER_TEAM,
			teamName: 'Bulls',
			managerId: 'm-3',
			playerName: 'Kevin Durant',
			winningAmount: 3_000_000
		});
	}

	function coManagedLeague(
		mutes: { alice?: boolean | string; bob?: boolean | string } = {}
	): Parameters<typeof fakeGateway>[0] {
		return {
			managers: [
				{
					teamId: TEAM,
					discordUserId: ALICE,
					id: MANAGER,
					displayName: 'Meakel',
					...(mutes.alice === undefined ? {} : { slotReleaseMuted: mutes.alice })
				},
				{
					teamId: TEAM,
					discordUserId: BOB,
					id: 'm-2',
					displayName: 'Dana',
					...(mutes.bob === undefined ? {} : { slotReleaseMuted: mutes.bob })
				},
				{ teamId: OTHER_TEAM, discordUserId: CAROL, id: 'm-3', displayName: 'Ari' }
			],
			teams: [
				{ id: TEAM, name: 'Lakers' },
				{ id: OTHER_TEAM, name: 'Bulls' }
			]
		};
	}

	async function drainSlotRelease(harness: ReturnType<typeof fakeGateway>) {
		await write(
			harness.gateway,
			[slotReleasedForLakers()],
			'accepted',
			enqueueMentions(() => [TEAM])
		);
		const channel = fakeChannel();
		await drainOutbox(harness.gateway, { channels: { [DISCORD_CHANNEL]: channel.port } });
		return channel;
	}

	const NOTICE = 'Kevin Durant to Bulls — Ari for $3.0M.';

	it('reads a Manager with NO preference row as not muted', async () => {
		// The matrix's "Default state" row, through the real left join: the
		// fixture states nothing for either Manager, the `coalesce` answers
		// `false`, and both are mentioned.
		const channel = await drainSlotRelease(fakeGateway(coManagedLeague()));

		expect(channel.posts[0]).toEqual({
			body:
				`${NOTICE}\n` +
				`<@${ALICE}> <@${BOB}> — Lakers — Meakel & Dana no longer hold this Nomination Slot.`,
			recipients: [ALICE, BOB]
		});
	});

	it('withholds one co-Manager’s mention and posts the notice in full', async () => {
		// The story's acceptance criterion, end to end: the notice appears in
		// full, and neither the body nor `allowed_mentions.users` — which is
		// what `recipients` becomes — names the muted Manager.
		const channel = await drainSlotRelease(fakeGateway(coManagedLeague({ bob: true })));

		expect(channel.posts[0]).toEqual({
			body: `${NOTICE}\n<@${ALICE}> — Lakers — Meakel no longer hold this Nomination Slot.`,
			recipients: [ALICE]
		});
		expect(channel.posts[0]?.body).toContain(NOTICE);
		expect(channel.posts[0]?.body).not.toContain(BOB);
	});

	it('posts the notice alone when every recipient in the batch has muted', async () => {
		// The matrix's last row. `recipients` empties, the batch posts as
		// broadcast only, and the pass completes without throwing.
		const harness = fakeGateway(coManagedLeague({ alice: true, bob: true }));
		const channel = await drainSlotRelease(harness);

		expect(channel.posts).toHaveLength(1);
		expect(channel.posts[0]).toEqual({ body: NOTICE, recipients: [] });

		// The intents were still FILED and still recorded as dispatched — the
		// suppression is at composition and never at enqueue, so NFR11's
		// measurement can tell a muted notice from a failed one.
		expect(harness.outbox).toHaveLength(2);
		expect(outcomes(harness)).toHaveLength(2);
	});

	it('leaves an OUTBID notice for the same muted Manager untouched', async () => {
		// The matrix's "A mute never touches an unmutable notice" row, through
		// the real SQL: the mute is per category, not per Manager.
		const harness = fakeGateway({
			...coManagedLeague({ alice: true, bob: true }),
			players: [{ fantraxPlayerId: PLAYER, playerName: 'Anthony Davis' }]
		});
		await write(harness.gateway, [bidPlaced()], 'accepted', enqueueMentions(() => [TEAM]));
		const channel = fakeChannel();

		await drainOutbox(harness.gateway, { channels: { [DISCORD_CHANNEL]: channel.port } });

		expect(channel.posts[0]).toEqual({
			body:
				`Lakers — Meakel bid $14.5M on Anthony Davis. Closes ${CLOSES_AT_MARKUP}.\n` +
				`<@${ALICE}> <@${BOB}> — Lakers — Meakel & Dana were outbid.`,
			recipients: [ALICE, BOB]
		});
	});

	it.each([
		['t', 'f'],
		['true', 'false'],
		['T', 'FALSE']
	])(
		'reads a driver’s %s/%s strings as the booleans they are',
		async (yes: string, no: string) => {
			// `isTrueFlag`'s string branch, run for real. Postgres' text output
			// for `bool` is `t`/`f`, and a coercion that read `'t'` as falsy
			// would unmute every Manager in the league — a failure that looks
			// like nothing at all from the outside.
			const channel = await drainSlotRelease(
				fakeGateway(coManagedLeague({ alice: no, bob: yes }))
			);

			expect(channel.posts[0]).toEqual({
				body: `${NOTICE}
<@${ALICE}> — Lakers — Meakel no longer hold this Nomination Slot.`,
				recipients: [ALICE]
			});
		}
	);

	it('reads the mute in ONE statement, joined onto the registry read', async () => {
		// The directory is read once per pass, off one snapshot — the property
		// `LeagueDirectory` states and the reason the mute rides the directory
		// rather than being looked up beside `mention.ts`. A second read would
		// let one message carry two spellings of the league.
		const harness = fakeGateway(coManagedLeague({ bob: true }));
		await drainSlotRelease(harness);

		expect(
			harness.statements.filter((sql) => /manager_notification_preferences/i.test(sql))
		).toHaveLength(1);
	});
});

// --- the guild account, when it is not the login account ------------------

describe('the mention address is discord_mention_user_id, and NULL means discord_user_id', () => {
	/**
	 * The snowflake the GSW Manager SIGNS IN with. It is a real Discord account
	 * and a perfectly good identity; it is simply not a member of the league
	 * server, so Discord cannot resolve `<@GUEST_LOGIN>` to anybody and renders
	 * it as the literal text `@unknown-user`.
	 */
	const GUEST_LOGIN = '3333';
	/** The snowflake the same person is a MEMBER of the league server as. */
	const GUEST_GUILD = '4444';

	/** One Team, one Manager, whose two Discord accounts differ. */
	const splitAccount = () => ({
		managers: [
			{
				teamId: TEAM,
				discordUserId: GUEST_LOGIN,
				discordMentionUserId: GUEST_GUILD,
				id: MANAGER,
				displayName: 'Victor'
			}
		],
		// `Lakers` because `bidPlaced()` spells it in its own payload, and the
		// broadcast line composes from the payload while the mention line
		// composes from the directory. Two Team names here would make this test
		// about the composer's sources rather than about the address.
		teams: [{ id: TEAM, name: 'Lakers' }],
		players: [{ fantraxPlayerId: PLAYER, playerName: 'Anthony Davis' }]
	});

	it('addresses the intent at the guild snowflake, never at the login one', async () => {
		const harness = fakeGateway(splitAccount());
		await write(harness.gateway, [bidPlaced()], 'accepted', enqueueMentions(() => [TEAM]));

		// The intent is an ADDRESS, and `notification_outbox.recipient` is
		// copied at insert and never joined at dispatch. If the login snowflake
		// reached this row, no later fix could redirect it.
		expect(harness.outbox).toEqual([
			{
				eventSeq: '1',
				channel: DISCORD_CHANNEL,
				recipient: GUEST_GUILD,
				createdAt: expect.any(String)
			}
		]);
	});

	it('spells the guild snowflake in the body AND whitelists it, and still names the Team', async () => {
		const harness = fakeGateway(splitAccount());
		await write(
			harness.gateway,
			[
				bidPlaced(),
				auctionClosed({
					teamId: TEAM,
					teamName: 'Lakers',
					managerId: MANAGER,
					playerName: 'Kevin Durant',
					winningAmount: 3_000_000
				})
			],
			'accepted',
			enqueueMentions(() => [TEAM])
		);

		const channel = fakeChannel();
		await drainOutbox(harness.gateway, { channels: { [DISCORD_CHANNEL]: channel.port } });

		expect(channel.posts).toHaveLength(1);
		expect(channel.posts[0]).toEqual({
			// **`Lakers — Victor` is the half that proves the reverse map.** It
			// takes BOTH halves to ping: the `<@id>` in the text and the id in
			// `allowed_mentions.users`. But the composer can only write the Team
			// and the name if `managerIdsByDiscordUserId` resolved the recipient
			// back to a Manager — and that map is built from the same
			// `coalesce`. Key it on the raw `discord_user_id` instead and this
			// line degrades to the bare notice with no mention at all, which is
			// the silent failure the override exists to end.
			body:
				`Lakers — Victor bid $14.5M on Anthony Davis. Closes ${CLOSES_AT_MARKUP}.\n` +
				`<@${GUEST_GUILD}> — Lakers — Victor were outbid.\n` +
				'Kevin Durant to Lakers — Victor for $3.0M.\n' +
				`<@${GUEST_GUILD}> — Lakers — Victor led this Auction at its close.`,
			recipients: [GUEST_GUILD]
		});

		// Nothing anywhere on the wire carries the login snowflake.
		expect(JSON.stringify(channel.posts)).not.toContain(GUEST_LOGIN);
	});

	it('leaves every other Manager addressed at discord_user_id — absence is the default', async () => {
		// The twenty-nine rows that set nothing. A `not null` column with a
		// backfill would have made the exception look like the rule; this is the
		// assertion that it did not.
		const harness = fakeGateway({
			managers: [
				{ teamId: TEAM, discordUserId: ALICE, id: MANAGER, displayName: 'Meakel' },
				{
					teamId: TEAM,
					discordUserId: GUEST_LOGIN,
					discordMentionUserId: GUEST_GUILD,
					id: 'm-2',
					displayName: 'Victor'
				}
			],
			teams: [{ id: TEAM, name: 'Lakers' }],
			players: [{ fantraxPlayerId: PLAYER, playerName: 'Anthony Davis' }]
		});
		await write(harness.gateway, [bidPlaced()], 'accepted', enqueueMentions(() => [TEAM]));

		// Alice by her login snowflake, Victor by his guild one — one co-managed
		// Team, two rules, resolved by the same `coalesce`.
		expect(harness.outbox.map((row) => row.recipient).sort()).toEqual([ALICE, GUEST_GUILD].sort());
	});
});
