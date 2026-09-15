/**
 * The transactional outbox and its dispatcher: insert the delivery intents an
 * appended event owes, and drain them once per tick. Story 5.1, AD-17, AD-18.
 *
 * **Two halves that never touch each other's failure modes**, which is the
 * whole of AD-17:
 *
 *  - The enqueues — `enqueueBroadcasts`, and `enqueueMentions` /
 *    `enqueueBroadcastsAndMentions` — run INSIDE the auction transaction,
 *    through the same `client` the events were appended with
 *    (`shell/write.ts`'s `EnqueueFn`). They write rows and nothing else — no
 *    socket, no `fetch`, no retry. They can fail a write, and only by failing
 *    to record an obligation.
 *  - `drainOutbox` runs in the tick, after the sweep, in its own connection and
 *    its own transactions. It is the only thing here that talks to Discord, and
 *    a Discord outage costs a notification and never a bid — the closes it runs
 *    after are already committed and it holds nothing of theirs open.
 *
 * **Delivery state is not stored.** `notification_outbox` grants no role
 * `update` or `delete` (`20260903000000_notification_outbox.sql`), so a row
 * cannot be marked done. Whether an intent has been delivered is re-derived
 * from `NotificationDispatched` events in the log, which is the same
 * "re-derives, never remembers" discipline `server/sweep.ts` states for the
 * sweep — and it makes restart-safety structural rather than tested for. A pass
 * that dies between the POST and the outcome write simply re-derives the intent
 * as pending and tries again.
 *
 * **The outcome event is where NFR §5's measurement lands.** `auction_events`
 * carries `dispatch_outcome` and `delivery_outcome` as nullable columns that no
 * story populated until this one, and `service_role` holds `select, insert`
 * there and nothing more — so those columns can never be back-filled onto the
 * event that CAUSED the notice. They are populated on the dispatcher's own
 * appended event instead, which is the only place an insert-only log can put
 * them.
 *
 * **No feedback loop, and it is structural rather than conditional.** The
 * outcome events are appended through `runTransactionalWrite` with NO `enqueue`
 * argument, so a `NotificationDispatched` cannot spawn an intent for itself.
 * Belt as well as braces, it is also a system-originated event whose type is
 * in neither trigger set: `NotificationDispatched` is not in
 * `BROADCAST_EVENT_TYPES`, so `enqueueBroadcasts` skips it, and no write site
 * names an affected Team for it, so `enqueueMentions` files nothing either. A
 * future caller that wired `enqueue` in here would still produce nothing.
 *
 * **The backoff and the budget live HERE, not in `core/`.** They are policy
 * about an external service's rate limit, not a rule of the auction — nothing
 * about who wins an Auction changes if the budget moves from five to six. AR-3
 * puts that in the shell, and `core/` stays free of any notion that Discord
 * exists.
 *
 * **One module, two runtimes** (AD-2). Relative `.ts` imports only, no `$env`,
 * no `$lib`, no Node builtin, no bare specifier — Deno loads this file through
 * `supabase/functions/tick/index.ts`, exactly as it loads `server/sweep.ts` and
 * `server/phase-end.ts`. The webhook URL and `fetch` are INJECTED by the caller
 * for that reason, and because the URL is a server-only secret that must never
 * take a `PUBLIC_` prefix (AD-16). `npx deno check --config
 * supabase/functions/tick/deno.json supabase/functions/tick/index.ts` is what
 * proves it, and `--config` is load-bearing.
 *
 * **Story 5.2 wired the first enqueue and replaced the placeholder body.**
 * `enqueueBroadcasts` writes one channel-addressed intent per broadcast-worthy
 * event, and the drain composes through `adapters/discord/broadcast.ts` —
 * which is why this module now imports an adapter at all. The import is
 * one-directional and pure (`noticeFor`, `broadcastBodyFor`, the type list):
 * `NotificationChannelPort` below is still declared here rather than imported,
 * so the TRANSPORT stays anonymous and a second channel is still a second
 * entry in `channels`. What this file gained is a notion of what a notice
 * says, not a notion of how one is sent.
 *
 * **Story 5.3 wired the mentions, and the targeting moved to the write site.**
 * 5.1's `enqueueIntents` keyed recipients on the event's own `team_id` — the
 * ACTING Team — which is the wrong Team for every mention trigger there is, and
 * it was left unwired rather than wired wrongly. `enqueueMentions` takes an
 * `AffectedTeamsFn` from the caller instead: `server/bidding.ts` supplies the
 * displaced leader, `server/close.ts` the leader, the Contenders and the
 * nominating Team, `server/phase-end.ts` the whole league. The drain re-derives
 * nothing about who was affected. Composition of the mention line itself lives
 * in `adapters/discord/mention.ts`, beside the broadcast copy it rides on, for
 * `enqueueBroadcasts`' reason: deciding who hears about an event and deciding
 * what they are told is one decision.
 *
 * Not this story: no mute, no settings surface and no per-category suppression
 * (5.4); no 24-hour unbid-Nomination warning, which was removed from scope by
 * user decision on 2026-09-04 rather than deferred; no Commissioner-visible
 * failure screen (deferred, 2026-09-03 — see `deferred-work.md`); no backlog
 * detector (8.2).
 */

import {
	EMPTY_LEAGUE_DIRECTORY,
	broadcastBodyFor,
	isBroadcastEventType,
	noticeFor
} from '../adapters/discord/broadcast.ts';
import type { BroadcastEvent, LeagueDirectory } from '../adapters/discord/broadcast.ts';
import { mentionSuffixFor, mentionsPresentIn } from '../adapters/discord/mention.ts';
import type { AppendedEvent } from '../core/types.ts';
import { requireDatabaseClock, runTransactionalWrite } from '../shell/write.ts';
import type {
	ConnectionGateway,
	EnqueueFn,
	QueryResultRow,
	TransactionalClient
} from '../shell/write.ts';

// --- Names and policy -----------------------------------------------------

/** The outbox table (`20260903000000_notification_outbox.sql`). */
export const NOTIFICATION_OUTBOX_TABLE = 'notification_outbox';

/**
 * The one transport there is (AD-18 — "Discord is the only notification
 * transport"). A constant rather than a literal at three call sites, because
 * the column is deliberately not enum-constrained and the second transport
 * AD-17 anticipates is a new value here plus a new port, not a migration.
 */
export const DISCORD_CHANNEL = 'discord';

/**
 * The `recipient` of a BROADCAST intent: the league channel itself, not a
 * person (Story 5.2).
 *
 * **A sentinel rather than a nullable column.** `recipient` is `not null`,
 * carries a non-blank check, and sits in the unique key
 * (`20260903000000_notification_outbox.sql`) — so a broadcast needs no
 * migration, the idempotency key stays declarative, and Story 5.3's
 * per-Manager rows for the SAME event coexist with this one instead of
 * colliding with it.
 *
 * `#channel` specifically, because it can never collide with a Discord
 * snowflake: those are 64-bit integers serialised as digits, and this is
 * neither. It is NEVER a mention — `composeBatch` filters it out of
 * `recipients` before the payload is built, or `allowed_mentions.users` would
 * carry a non-snowflake and the message would render a literal `<@#channel>`.
 */
export const BROADCAST_RECIPIENT = '#channel';

/**
 * The dispatcher's own event type. Not declared in `core/types.ts` and not
 * folded by any reducer: it is a record OF an effect, not an auction fact, and
 * nothing in the domain reads it. The dispatcher itself is its only reader, and
 * it reads it to answer one question — has this intent been delivered?
 */
export const NOTIFICATION_DISPATCHED_EVENT = 'NotificationDispatched';

/** `dispatch_outcome` on the outcome event: the request was actually issued. */
export const DISPATCH_ATTEMPTED = 'attempted';

/** `delivery_outcome` on the outcome event. Only `delivered` retires an intent. */
export const DELIVERY_DELIVERED = 'delivered';
export const DELIVERY_RATE_LIMITED = 'rate_limited';
export const DELIVERY_FAILED = 'failed';

/**
 * How many INTENTS one pass may attempt. Not a request count — see below.
 *
 * **What the code actually does.** Every due intent on one channel is collapsed
 * into a SINGLE `post` call (AD-18 — "the dispatcher batches multiple events
 * into one message where it can"). With `discord` the only registered channel,
 * a pass therefore issues at most ONE request, whether it carries one intent or
 * five. The tick runs every 10 seconds, so the real worst case is six requests
 * a minute against AD-18's documented 30/minute webhook ceiling — a fifth of
 * it, and that margin is what the design rests on.
 *
 * The cap is on intents rather than requests because what it actually bounds is
 * message SIZE and blast radius: a sweep that closed twenty Auctions at once
 * would otherwise put twenty notices in one Discord message, and one rejected
 * message would then be twenty notices to redeliver. Five keeps a burst
 * draining in readable chunks, and the remainder is provably carried to the
 * next pass.
 *
 * **The arithmetic that is NOT the safety argument.** Five intents on five
 * distinct channels would be five requests, or 30 a minute — which EQUALS the
 * ceiling rather than staying under it. That case is unreachable today (one
 * channel exists) and the number would have to be revisited before a second
 * transport is registered, not after.
 *
 * **Story 5.3 made it a floor as well as a cap, for exactly one case.** The
 * budget now slices on EVENT boundaries so an event's broadcast row and its
 * mention rows are never split across two passes, and one event can owe more
 * than five intents on its own — `ContractAssignmentOpened` mentions every
 * Manager in the league. That single group is taken whole, over budget,
 * because taking whole groups ONLY would take nothing forever and stall the
 * outbox on the one notice the whole league is waiting for. See
 * `withinBudget`.
 *
 * Flagged for revisit at the Epic 8 rehearsal, which is when burst behaviour
 * first becomes observable (ARCHITECTURE-SPINE.md's own "Discord delivery
 * shape" open question).
 */
export const PER_PASS_BUDGET = 5;

/**
 * How long to wait after the Nth consecutive failed attempt, in milliseconds.
 *
 * Ten seconds is one tick, so a single blip retries on the very next pass; the
 * tail reaches an hour so a webhook that has been dead for a day is not being
 * hammered every ten seconds by a backlog. The last entry is reused for every
 * attempt beyond the list — the intent is never dropped (AD-17), it just stops
 * accelerating.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [
	10_000,
	30_000,
	120_000,
	600_000,
	3_600_000
];

/** The wait owed after `failures` consecutive failed attempts. */
export function backoffMsFor(failures: number): number {
	if (failures <= 0) return 0;
	const last = RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 0;
	return RETRY_BACKOFF_MS[failures - 1] ?? last;
}

// --- The intent side ------------------------------------------------------

/** One row of `notification_outbox`, joined to the event it describes. */
export type OutboxIntent = {
	/** `auction_events.seq`, as a string — `int8` (AD-8's boundary discipline). */
	readonly eventSeq: string;
	readonly channel: string;
	readonly recipient: string;
	/** The `event_type` of the event this notice is about. */
	readonly eventType: string;
	/**
	 * That event's `payload`, verbatim and unnarrowed (Story 5.2).
	 *
	 * `unknown` for `AppendedEvent.payload`'s reason: the log is insert-only, a
	 * historical row cannot be corrected in place, and the composer narrows it
	 * itself rather than trusting a cast made by the code that read the row.
	 * Without this the drain could not say what an event MEANT — which is why
	 * 5.1 could only ship a placeholder body.
	 */
	readonly payload: unknown;
	/** The acting Manager's id, or `null` for a system event. */
	readonly managerId: string | null;
	/** The event's own `occurred_at`, ISO-8601. Never read as "now". */
	readonly occurredAt: string;
	/**
	 * The Player's name, left-joined off the payload's `fantraxPlayerId`.
	 *
	 * `BidPlacedPayload` carries no `playerName` and adding one would mean
	 * editing `core/rules/bidding.ts` — which this story's boundaries put
	 * behind an ask. The reference join resolves it instead:
	 * `free_agent_players.player_name` is stable for the whole Auction, since a
	 * close writes neither that table nor `teams`. `null` for an event that
	 * names no Player at all, which is every phase event.
	 */
	readonly playerName: string | null;
};

/**
 * Every Manager of one Team, in a total order.
 *
 * **`coalesce(discord_mention_user_id, discord_user_id)` is the ADDRESS, and
 * the alias keeps that fact inside the SQL.** The two columns answer different
 * questions: `discord_user_id` is the account that SIGNS IN and is all
 * `server/supabase.ts` ever matches on, while the override — NULL for almost
 * every Manager — is the guild account to @mention when a Manager belongs to
 * the league server under a different Discord account than the one they
 * authenticate with. An intent is an address, so the address is what is
 * selected. See `20260917000000_manager_discord_mention_user_id.sql`.
 *
 * The order is by the resolved value, so it stays total.
 */
const MANAGERS_OF_TEAM_SQL = `
	select coalesce(discord_mention_user_id, discord_user_id) as discord_user_id
	from managers
	where team_id = $1
	order by 1 asc
`;

/**
 * Every Manager who acts for ANY Team, in a total order — the `EVERY_TEAM`
 * resolution.
 *
 * `team_id is not null` rather than the whole table: a Manager with no Team is
 * a supported state (a nullable FK) and is not a party to a league-wide
 * auction notice. `ContractAssignmentOpened` is the one trigger that uses it.
 */
const MANAGERS_OF_EVERY_TEAM_SQL = `
	select coalesce(discord_mention_user_id, discord_user_id) as discord_user_id
	from managers
	where team_id is not null
	order by 1 asc
`;

/**
 * One intent. `on conflict do nothing` names AD-17's idempotency key at the
 * write site as well as in the schema.
 *
 * The conflict is unreachable today — `event_seq` comes off an `identity`
 * column that was assigned moments earlier in this same transaction, and
 * `managers.discord_user_id` is unique — so this clause changes no behaviour.
 * It is here because of what it must NEVER do: a duplicate intent is the same
 * intent, and raising a unique violation for it would roll back the auction
 * transaction and cost a Manager their Bid over a notice that was already
 * recorded. "A Discord outage costs a notification and never a bid" has to hold
 * for the outbox's own bookkeeping too.
 */
const INSERT_INTENT_SQL = `
	insert into ${NOTIFICATION_OUTBOX_TABLE} (event_seq, channel, recipient, created_at)
	values ($1::bigint, $2, $3, $4::timestamptz)
	on conflict (event_seq, channel, recipient) do nothing
`;

/**
 * Which Teams one appended event AFFECTS — supplied by the write site, which
 * is the only code that knows (Story 5.3).
 *
 * **Not the event's own `team_id`, and that is the whole change from 5.1.**
 * The envelope's `team_id` is the ACTING Team, and every mention trigger names
 * somebody else: the outbid Manager is not the bidder, the Manager whose Slot
 * released is not the winner, and `ContractAssignmentOpened` carries no Team at
 * all. 5.1's `enqueueIntents` keyed on the acting Team and was left unwired
 * rather than wired wrongly; this is the replacement it named.
 *
 * The write site answers from the state it already folded before `decide()` —
 * the displaced leader, the Contender list, the nominating Team — so the drain
 * re-derives nothing about who was affected. An empty array is the honest
 * answer for an event with nobody to notify, and it is the common one.
 */
export type AffectedTeamsFn = (event: AppendedEvent) => readonly string[];

/**
 * The whole league, as an entry in an `AffectedTeamsFn`'s answer.
 *
 * `ContractAssignmentOpened` affects every Team at once, and enumerating them
 * at the write site would mean reading `teams` inside `evaluateLeagueClock`'s
 * `load` — on EVERY tick, ten seconds apart, forever, to answer a question
 * almost every pass has no events for. Resolved in the enqueue instead, which
 * runs only when something was actually appended.
 *
 * `*` specifically, for `BROADCAST_RECIPIENT`'s reason: `teams.id` is a uuid,
 * and this is not one, so it can never collide with a real Team.
 */
export const EVERY_TEAM = '*';

/**
 * Story 5.3's enqueue: one intent per Manager of every Team the event
 * AFFECTS, addressed to that Manager's Discord snowflake.
 *
 * A factory rather than an `EnqueueFn`, because the affected Teams are a fact
 * about the write and not about the event — see `AffectedTeamsFn`.
 *
 * **A co-managed Team yields TWO rows for ONE event, and that is the point of
 * the key.** FR-27 requires both Managers of a co-managed Team receive every
 * team-affecting notice (SM-3 targets 100%), and AD-17 keys on
 * `(event seq, channel, recipient)` precisely so the second Manager is not
 * deduplicated away by a key that stopped at the event. The composer renders
 * them as two distinct `<@id>` on one line; it does not collapse them either.
 *
 * **A Team with no Manager rows yields nothing, and nothing observes it.**
 * After 5.2 the broadcast post already names the Team and states what happened,
 * so the record exists and only the ping is absent — which is precisely what
 * 5.4 will make a Manager able to choose. An unmanaged Team is a supported
 * state and unreachable during a live auction.
 *
 * `created_at` is copied from the event's own `occurredAt` — the transaction's
 * single clock read (AD-3), never a second `now()`.
 *
 * Nothing here composes anything, and nothing here throws for a copy reason: a
 * throw would roll back the auction transaction, and "a Discord outage costs a
 * notification and never a bid" has to hold for the outbox's own bookkeeping.
 */
export function enqueueMentions(affectedTeams: AffectedTeamsFn): EnqueueFn {
	return async (client: TransactionalClient, appended: readonly AppendedEvent[]) => {
		// One lookup per distinct Team rather than one per event: a transaction
		// appending a draw and the close it caused asks about each Contender
		// once.
		const recipientsByTeam = new Map<string, readonly string[]>();
		const resolve = async (teamId: string): Promise<readonly string[]> => {
			const known = recipientsByTeam.get(teamId);
			if (known !== undefined) return known;
			const result = await client.query(
				teamId === EVERY_TEAM ? MANAGERS_OF_EVERY_TEAM_SQL : MANAGERS_OF_TEAM_SQL,
				teamId === EVERY_TEAM ? [] : [teamId]
			);
			const recipients = result.rows
				.map((row) => String(row['discord_user_id'] ?? '').trim())
				.filter((id) => id !== '');
			recipientsByTeam.set(teamId, recipients);
			return recipients;
		};

		for (const event of appended) {
			// De-duplicated per event, so a Team that is both the leader and the
			// nominator of one close is one intent rather than a unique
			// violation the `on conflict` would have to absorb.
			const teams = [...new Set(affectedTeams(event))].filter((teamId) => teamId !== '');
			const seen = new Set<string>();
			for (const teamId of teams) {
				for (const recipient of await resolve(teamId)) {
					if (seen.has(recipient)) continue;
					seen.add(recipient);
					await client.query(INSERT_INTENT_SQL, [
						event.seq,
						DISCORD_CHANNEL,
						recipient,
						event.occurredAt
					]);
				}
			}
		}
	};
}

/**
 * The two enqueues one write owes, in one `EnqueueFn` — the broadcast row and
 * the mention rows, for the same appended events.
 *
 * `runTransactionalWrite` takes ONE `enqueue`, and the three write sites that
 * trigger a mention also broadcast. Composed here rather than at each of them
 * so the ORDER is stated once: the broadcast row first, so it sorts ahead of
 * the mention rows under `(event_seq, channel, recipient)` when the sentinel
 * `#channel` happens to sort before a snowflake — and so a reader of a write
 * site sees one argument rather than two that must agree.
 */
export function enqueueBroadcastsAndMentions(affectedTeams: AffectedTeamsFn): EnqueueFn {
	const mentions = enqueueMentions(affectedTeams);
	return async (client: TransactionalClient, appended: readonly AppendedEvent[]) => {
		await enqueueBroadcasts(client, appended);
		await mentions(client, appended);
	};
}

/**
 * Story 5.2's enqueue: ONE intent per broadcast-worthy event, addressed to the
 * league channel.
 *
 * **Not `enqueueIntents`, and deliberately not built on it.** That one is
 * Manager-shaped — it fans out per Manager of the event's Team and skips a null
 * `team_id` entirely. A broadcast is neither: it is one row keyed on the event
 * TYPE, addressed to `BROADCAST_RECIPIENT`, and `ContractAssignmentOpened`
 * carries a null `team_id` precisely because nobody acted. Reusing the
 * Manager-shaped enqueue would drop the phase events and duplicate the rest.
 *
 * **Membership of `BROADCAST_EVENT_TYPES` is the whole rule**, and it lives in
 * `adapters/discord/broadcast.ts` beside the copy — because deciding which
 * events deserve a notice and deciding what each one says is one decision, and
 * splitting it across two modules is how a type gets an intent and no sentence.
 *
 * `created_at` is the event's own `occurredAt`: the transaction's single clock
 * read (AD-3), never a second `now()`.
 *
 * Nothing here composes anything. Composition happens in the drain, in another
 * process, at another time — a throw in here would roll back the auction
 * transaction, and "a Discord outage costs a notification and never a bid" has
 * to hold for a copy bug too.
 */
export const enqueueBroadcasts: EnqueueFn = async (
	client: TransactionalClient,
	appended: readonly AppendedEvent[]
): Promise<void> => {
	for (const event of appended) {
		if (!isBroadcastEventType(event.type)) continue;
		await client.query(INSERT_INTENT_SQL, [
			event.seq,
			DISCORD_CHANNEL,
			BROADCAST_RECIPIENT,
			event.occurredAt
		]);
	}
};

// --- The pending set, re-derived -----------------------------------------

/** One recorded attempt, read back off a `NotificationDispatched` event. */
export type DispatchAttempt = {
	readonly eventSeq: string;
	readonly channel: string;
	readonly recipient: string;
	/** `true` only for `delivery_outcome = 'delivered'`. Retires the intent. */
	readonly delivered: boolean;
	/** The attempt's `occurred_at` — the appending transaction's clock (AD-3). */
	readonly attemptedAt: string;
	/** What a 429 asked for, in milliseconds, or `null`. */
	readonly retryAfterMs: number | null;
};

/**
 * The key AD-17 names: `(event seq, channel, recipient)`, as one string.
 *
 * `JSON.stringify` of the triple rather than a joined string, because the join
 * has to be INJECTIVE: two different intents must never produce one key, or the
 * derivation would retire the wrong one. Any single-character separator can
 * appear inside a `text` column, so `1|discord|a` and `1|discord|a` could be
 * reached from two different triples — JSON quoting and escaping rule that out
 * without needing an assumption about what a recipient may contain.
 *
 * An earlier draft used a literal NUL, which IS injective (Postgres `text`
 * cannot store one) but made this file binary to git and ripgrep: `git diff`
 * would not render it and a search would silently skip it. A key nobody can
 * read in review is not worth the two bytes it saves.
 */
function keyOf(intent: {
	readonly eventSeq: string;
	readonly channel: string;
	readonly recipient: string;
}): string {
	return JSON.stringify([intent.eventSeq, intent.channel, intent.recipient]);
}

/**
 * Which intents are due for an attempt right now, in a total order, capped.
 *
 * Pure: given the intents, the attempts and the database clock, the answer is
 * fixed. That is what makes every I/O-matrix row about retry behaviour testable
 * without a transport at all.
 *
 * An intent is pending unless a `delivered` attempt exists for its key. Since a
 * successful attempt is an appended event, the "retry of the same tick" case is
 * answered structurally: re-running the pass finds the two successes in the log
 * and dispatches nothing further.
 *
 * The wait after N failures is `max(backoff(N), the last 429's retryAfterMs)`.
 * Both, not either: Discord's number is a floor it asked for, and the backoff is
 * this application's own restraint. Taking the larger honours the 429 without
 * letting a `retry_after: 0` collapse the backoff.
 */
export function duePendingIntents(input: {
	readonly intents: readonly OutboxIntent[];
	readonly attempts: readonly DispatchAttempt[];
	readonly now: Date;
	readonly budget?: number;
}): readonly OutboxIntent[] {
	const attemptsByKey = new Map<string, DispatchAttempt[]>();
	for (const attempt of input.attempts) {
		const key = keyOf(attempt);
		const bucket = attemptsByKey.get(key);
		if (bucket === undefined) attemptsByKey.set(key, [attempt]);
		else bucket.push(attempt);
	}

	const nowMs = input.now.getTime();
	const due: OutboxIntent[] = [];

	for (const intent of input.intents) {
		const attempts = attemptsByKey.get(keyOf(intent)) ?? [];
		if (attempts.some((attempt) => attempt.delivered)) continue;
		if (attempts.length === 0) {
			due.push(intent);
			continue;
		}

		// The most recent attempt decides when the next one may run. Compared by
		// instant rather than by array position: the reader orders by `seq`, but
		// nothing in this function should depend on that holding.
		let lastMs = Number.NEGATIVE_INFINITY;
		let lastRetryAfterMs = 0;
		for (const attempt of attempts) {
			const at = Date.parse(attempt.attemptedAt);
			if (!Number.isFinite(at) || at < lastMs) continue;
			lastMs = at;
			lastRetryAfterMs = attempt.retryAfterMs ?? 0;
		}
		if (!Number.isFinite(lastMs)) {
			// Every recorded attempt carried an unreadable instant. Treating that
			// as "due now" is the safe direction: AD-17's promise is that an
			// intent is never dropped, and an unreadable timestamp must not
			// become an unbounded silence.
			due.push(intent);
			continue;
		}

		const wait = Math.max(backoffMsFor(attempts.length), lastRetryAfterMs);
		if (nowMs >= lastMs + wait) due.push(intent);
	}

	// Oldest event first, then a total tie-break — AD-1 forbids incidental
	// order, and two intents for one event differ only by recipient. `BigInt`
	// rather than `Number`, because `seq` is `int8` (`core/types.ts`).
	due.sort((a, b) => {
		if (a.eventSeq !== b.eventSeq) return BigInt(a.eventSeq) < BigInt(b.eventSeq) ? -1 : 1;
		if (a.channel !== b.channel) return a.channel < b.channel ? -1 : 1;
		if (a.recipient === b.recipient) return 0;
		return a.recipient < b.recipient ? -1 : 1;
	});

	// `Math.max(0, ...)`: `slice(0, -2)` returns everything BUT the last two,
	// so a negative budget would silently dispatch almost the whole backlog
	// rather than nothing at all.
	return withinBudget(due, Math.max(0, input.budget ?? PER_PASS_BUDGET));
}

/**
 * The budget, applied on EVENT boundaries: whole events only, never a group
 * split across two passes (Story 5.3).
 *
 * **Why the boundary matters now.** Before 5.3 every event owed exactly one
 * intent — the broadcast row — so the cut could only ever fall between events.
 * A co-managed outbid owes three: the broadcast and two mentions. Cutting
 * inside that group would post the FACT this pass and the mention next pass, as
 * a second Discord message repeating the same line with a ping bolted on.
 *
 * Costs nothing: an excluded group has no recorded outcome, so the next pass
 * re-derives it as pending, whole. That is the same "re-derives, never
 * remembers" property the ceiling already relies on.
 *
 * **The first group is always taken, even when it alone exceeds the budget.**
 * `ContractAssignmentOpened` mentions every Manager in the league — thirty-odd
 * intents on one event against a budget of five — and a rule that took whole
 * groups only would take nothing, forever, and stall the outbox on the one
 * notice the whole league is waiting for. `broadcastBodyFor` makes the identical
 * exception at the message ceiling for the identical reason: it is the only
 * exit that terminates (AD-17 — a notice is never dropped).
 */
function withinBudget(
	due: readonly OutboxIntent[],
	budget: number
): readonly OutboxIntent[] {
	const taken: OutboxIntent[] = [];
	let index = 0;
	while (index < due.length) {
		// `due` is sorted by `eventSeq` first, so one event's intents are
		// contiguous and the group is found by scanning forward.
		const seq = due[index]?.eventSeq;
		let end = index;
		while (end < due.length && due[end]?.eventSeq === seq) end += 1;
		const size = end - index;
		// The first group goes whether it fits or not; every later one must.
		if (taken.length > 0 && taken.length + size > budget) break;
		taken.push(...due.slice(index, end));
		if (taken.length >= budget) break;
		index = end;
	}
	// A budget of zero attempts nothing at all — the caller asked for a pass
	// that posts nothing, and taking "the first group anyway" would make the
	// override unable to express it.
	return budget <= 0 ? [] : taken;
}

// --- The transport port ---------------------------------------------------

/** What one batched post amounted to. `adapters/discord`'s result, generalised. */
export type ChannelPostResult =
	| { readonly kind: 'delivered' }
	| {
			readonly kind: 'rate_limited';
			readonly retryAfterMs: number;
			readonly detail: string;
	  }
	| { readonly kind: 'failed'; readonly detail: string };

/**
 * A transport, as the dispatcher needs it — declared HERE rather than imported
 * from `adapters/discord/webhook.ts`, so this module carries no notion of
 * Discord at all and a second channel (AD-17 names web push) is a second entry
 * in `channels` rather than an edit to this file.
 *
 * `server/auth.ts`'s `DiscordOAuthPort` is the same pattern: the consumer
 * declares what it needs and the adapter satisfies it structurally.
 * `DiscordWebhookPort` is assignable to this, and
 * `tests/adapters/discord-webhook.test.ts` asserts that assignment so the two
 * declarations cannot drift apart unnoticed.
 */
export type NotificationChannelPort = {
	post(message: {
		readonly body: string;
		readonly recipients: readonly string[];
	}): Promise<ChannelPostResult>;
};

/** Everything `drainOutbox` needs from the runtime around it. */
export type OutboxPorts = {
	/** One port per `notification_outbox.channel` value. */
	readonly channels: Readonly<Record<string, NotificationChannelPort>>;
	/** Override `PER_PASS_BUDGET`. Tests use it; the tick does not. */
	readonly budget?: number;
	/**
	 * Override `DISCORD_MESSAGE_CEILING`. Tests use it; the tick does not.
	 *
	 * It exists for the same reason `budget` does: the real ceiling is 2000
	 * characters, and reaching it honestly takes three 30-contender draws in
	 * one pass. That setup would make the test about its own fixtures rather
	 * than about the property — that an excluded intent gets no outcome and is
	 * re-offered next pass.
	 */
	readonly ceiling?: number;
	/**
	 * The app's absolute origin — `https://bbsl.example` — for the deep link a
	 * mention carries (Story 5.3). `core/auction-link.ts` answers a PATH and
	 * explicitly no origin, because a host is deployment configuration the core
	 * may not read.
	 *
	 * **A thunk, not a string, and the laziness is the point.** The tick reads
	 * `APP_ORIGIN` from the environment, and the overwhelmingly common outcome
	 * of a pass is that nothing is pending. This is called once, after the due
	 * set is known to be non-empty — the same discipline
	 * `supabase/functions/tick/index.ts` applies to the webhook URL, and for the
	 * same reason: an idle pass must not evaluate a notification setting at all.
	 *
	 * Absent, or answering nothing, is not a failure: the mention posts without
	 * a link rather than not at all.
	 */
	readonly origin?: () => string | null | undefined;
};

/** What one drain pass did. Returned for tests and for the tick's log line. */
export type DrainSummary = {
	/**
	 * Intents this pass actually POSTED — fewer than the budget when the
	 * message ceiling excluded a notice (Story 5.2), and MORE than it when a
	 * single event owed more intents than the budget allows (Story 5.3 — see
	 * `PER_PASS_BUDGET`). An excluded intent is never counted here and never
	 * given an outcome, so it is re-derived as pending on the next pass.
	 */
	readonly attempted: number;
	readonly delivered: number;
	readonly rateLimited: number;
	readonly failed: number;
	/** One sentence per batch that did not deliver. Empty on a clean pass. */
	readonly failures: readonly string[];
};

// --- The drain ------------------------------------------------------------

/** The clock, unlocked and on its own — `server/sweep.ts`'s statement. */
const CLOCK_SQL = 'select now() as now';

/**
 * Every intent, joined to the EVENT it describes — type, payload, actor,
 * instant — and to the Player its payload names.
 *
 * The whole table, unpaginated, for the reason `server/event-log.ts`'s
 * `loadEventsViaClient` reads the whole log: this is a 30-team private league,
 * and the pending derivation has to see every row to be able to say an intent
 * is NOT pending. A bounded read here would be a cursor by another name, and a
 * cursor is the thing "re-derives, never remembers" exists to avoid.
 */
const PENDING_INTENTS_SQL = `
	select o.event_seq, o.channel, o.recipient,
	       e.event_type, e.payload, e.manager_id, e.occurred_at,
	       p.player_name
	from ${NOTIFICATION_OUTBOX_TABLE} o
	join auction_events e on e.seq = o.event_seq
	left join free_agent_players p
	       on p.fantrax_player_id = e.payload ->> 'fantraxPlayerId'
	order by o.event_seq asc, o.channel asc, o.recipient asc
`;

/**
 * Every Team's name, and every Manager's display name and Team.
 *
 * Two statements rather than one join, because they answer two questions and a
 * join would repeat every Team name once per Manager. Read inside the same
 * transaction as the intents (see `readDueIntents`), so one pass composes
 * against ONE snapshot of the registry and a rename landing mid-pass cannot
 * put two spellings of a Team in one message.
 *
 * `display_name` is the only thing ever RENDERED as a name: the snowflake is an
 * address, and printing one would put a bare integer where `Lakers — Meakel`
 * belongs. Story 5.3 selects `discord_user_id` beside it all the same, because
 * an intent is ADDRESSED by the snowflake and the composer has to be able to
 * ask whose Team one acts for. The two uses stay separate on `LeagueDirectory`
 * (`managerNames` versus `managerIdsByDiscordUserId`) so neither can be reached
 * for the other's job.
 *
 * **The snowflake selected here is the resolved ADDRESS, and it has to be.**
 * `managerIdsByDiscordUserId` is the reverse of the value an intent was
 * ADDRESSED with, and intents are addressed with
 * `coalesce(discord_mention_user_id, discord_user_id)` — see
 * `MANAGERS_OF_TEAM_SQL`. Keying this map on the raw `discord_user_id` instead
 * would make that lookup MISS for exactly the Manager whose two accounts
 * differ, and a miss is silent: the composer cannot name whose Team acted, so
 * the notice degrades to a plain factual line and the ping the override exists
 * to fix disappears again. The two sites resolve identically or neither works.
 */
const TEAM_NAMES_SQL = 'select id, name from teams';

/**
 * Story 5.4 adds the mute as a LEFT JOIN, and the join is the whole design.
 *
 * `coalesce(..., false)` over a left join is what makes an ABSENT preference
 * row read as not muted: a Manager who has never opened the settings page has
 * no row, and "absence is the default, not an error" then holds without a
 * backfill and without a trigger keeping a second table in step with
 * `managers`. It also keeps the cost where the story argued it belongs — one
 * join on a read that happens once per pass, and nothing at all on the auction
 * write path.
 */
const MANAGER_NAMES_SQL = `
	select
		m.id,
		m.display_name,
		m.team_id,
		coalesce(m.discord_mention_user_id, m.discord_user_id) as discord_user_id,
		coalesce(p.slot_release_muted, false) as slot_release_muted
	from managers m
	left join manager_notification_preferences p on p.manager_id = m.id
	order by m.id asc
`;

/**
 * Every recorded dispatch attempt. Filtered by `event_type` in SQL rather than
 * in TypeScript, because this is the one read that grows with the number of
 * NOTICES rather than with the number of auction events.
 */
const DISPATCH_ATTEMPTS_SQL = `
	select occurred_at, payload, delivery_outcome
	from auction_events
	where event_type = $1
	order by seq asc
`;

/**
 * Drain the outbox: derive what is pending, attempt at most the budget's worth,
 * and append one `NotificationDispatched` per attempt.
 *
 * **Ordered after the sweep, inside the same tick** (AD-10, AD-17). It opens
 * its own connection and takes no auction lock until the outcome write, so the
 * closes it runs after are committed and untouchable by anything here.
 *
 * **Batched by channel** (AD-18 — "the dispatcher batches multiple events into
 * one message where it can and backs off on 429 — a sweep closing many auctions
 * at once is the case that hits it"). Today that means every due intent becomes
 * ONE Discord request, so a pass costs one request rather than five.
 *
 * **Throws only after everything is recorded, and only for a real failure.** A
 * batch that failed has already been written to the log as a failed attempt by
 * the time this throws, so the backoff is already in effect and the intents are
 * still pending; the throw exists so `server/sweep.ts` records `drainFailure` on
 * the heartbeat and an operator can see it. A 429 does NOT throw: it is the
 * documented, expected behaviour of a rate-limited webhook under a burst, and a
 * heartbeat reading `completed_with_failures` for every pass of a rate-limit
 * window would be noise rather than signal.
 */
export async function drainOutbox(
	gateway: ConnectionGateway,
	ports: OutboxPorts
): Promise<DrainSummary> {
	const { due, directory } = await readDueIntents(gateway, ports.budget);
	if (due.length === 0) {
		return { attempted: 0, delivered: 0, rateLimited: 0, failed: 0, failures: [] };
	}

	// Batch by channel, preserving `duePendingIntents`' total order within each.
	const batches = new Map<string, OutboxIntent[]>();
	for (const intent of due) {
		const batch = batches.get(intent.channel);
		if (batch === undefined) batches.set(intent.channel, [intent]);
		else batch.push(intent);
	}

	// Read ONCE, and only now that a notice is known to be owed — see
	// `OutboxPorts.origin`. An idle pass returned above without touching it.
	const origin = readOrigin(ports.origin);

	const outcomes: OutcomeFor[] = [];
	const failures: string[] = [];
	let delivered = 0;
	let rateLimited = 0;
	let failed = 0;

	let attempted = 0;
	for (const [channel, batch] of [...batches.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
		// Composed BEFORE the post, so the message ceiling decides which intents
		// this pass is even attempting. The ones it excluded are never posted
		// and never given an outcome, which leaves them pending for the next
		// pass — see `broadcastBodyFor`.
		const message = composeBatch(batch, directory, origin, ports.ceiling);
		const result = await postBatch(ports.channels[channel], channel, message);
		for (const intent of message.posted) outcomes.push({ intent, result });
		attempted += message.posted.length;

		if (result.kind === 'delivered') {
			delivered += message.posted.length;
		} else if (result.kind === 'rate_limited') {
			rateLimited += message.posted.length;
		} else {
			failed += message.posted.length;
			failures.push(`${channel}: ${result.detail}`);
		}
	}

	// **Recorded before anything is reported.** The outcome write is what makes
	// the next pass's derivation correct, so it happens whatever the results
	// were — including for the batch that is about to make this function throw.
	await appendOutcomes(gateway, outcomes);

	if (failures.length > 0) {
		throw new Error(
			`the outbox drain could not deliver ${failed} of ${attempted} attempted notice(s); ` +
				`every attempt is recorded and will be retried: ${failures.join('; ')}`
		);
	}

	return { attempted, delivered, rateLimited, failed, failures };
}

/** One intent and the result of the batch it travelled in. */
type OutcomeFor = { readonly intent: OutboxIntent; readonly result: ChannelPostResult };

/** The read transaction's boundary statements. `shell/write.ts`'s, restated. */
const BEGIN_SQL = 'begin';
const COMMIT_SQL = 'commit';
const ROLLBACK_SQL = 'rollback';

/**
 * The clock, the intents and the attempts, off ONE connection and inside ONE
 * transaction — then the pure derivation.
 *
 * **The transaction is what makes the reads agree.** Separate autocommit
 * statements get separate snapshots, and a close committing between two of them
 * would let this pass see an intent whose delivery it cannot see, or a clock
 * from before an intent it can. Wrapped, every one of them reads the same
 * instant of the database — the registry reads included, so composition cannot
 * see a Team renamed halfway through its own pass. That is what
 * `server/close.ts`'s "fold everything out of ONE read" discipline means when
 * the reads are separate statements rather than one.
 *
 * **The registry is read only when something is actually due**, and the
 * conditional is a real cost rather than a micro-optimisation: the tick fires
 * every ten seconds forever, and the overwhelmingly common outcome is that
 * nothing is pending. Two unconditional full-table reads would make an idle
 * league pay for a directory no notice will ever be composed against — 8,640
 * pairs of reads a day to answer "nothing to do". The derivation is pure, so
 * asking it first costs nothing, and it happens INSIDE the transaction so the
 * snapshot property above still holds for the reads that do run.
 *
 * **No lock, deliberately** — `server/sweep.ts`'s reasoning, unchanged. This
 * read only decides which intents to OFFER; the outcome writes take
 * `GLOBAL_WRITE_LOCK_KEY` for themselves, and an intent that was delivered
 * between this read and its own outcome write is re-derived as settled on the
 * next pass rather than dispatched twice by this one.
 */
async function readDueIntents(
	gateway: ConnectionGateway,
	budget: number | undefined
): Promise<{ readonly due: readonly OutboxIntent[]; readonly directory: LeagueDirectory }> {
	const client = await gateway.connect();
	try {
		await client.query(BEGIN_SQL);
		try {
			const clock = await client.query(CLOCK_SQL);
			const now = requireDatabaseClock(clock.rows[0]?.['now']);

			const intents = (await client.query(PENDING_INTENTS_SQL)).rows.map(toOutboxIntent);
			const attempts = (
				await client.query(DISPATCH_ATTEMPTS_SQL, [NOTIFICATION_DISPATCHED_EVENT])
			).rows.map(toDispatchAttempt);

			// Derived before the registry is read, so an idle pass asks for no
			// names at all. Pure, and still inside the transaction.
			const due = duePendingIntents({ intents, attempts, now, budget });

			const directory =
				due.length === 0
					? EMPTY_LEAGUE_DIRECTORY
					: toLeagueDirectory(
							(await client.query(TEAM_NAMES_SQL)).rows,
							(await client.query(MANAGER_NAMES_SQL)).rows
						);

			await client.query(COMMIT_SQL);
			return { due, directory };
		} catch (error) {
			// Defensively wrapped, `shell/write.ts`'s pattern: the original read
			// failure is what the caller needs to see, never a second error from
			// the rollback attempting to describe it.
			await client.query(ROLLBACK_SQL).catch(() => {
				/* the read failure is what the caller needs to see */
			});
			throw error;
		}
	} finally {
		// Guarded exactly as `runTick`'s is: returning a connection to a pool is
		// never news worth losing a completed read over.
		try {
			client.release();
		} catch (error) {
			console.error('drainOutbox: releasing the read connection failed', error);
		}
	}
}

/** One `notification_outbox` row, joined to its event's type. */
function toOutboxIntent(row: QueryResultRow): OutboxIntent {
	return {
		// `int8` arrives as a string through `pg` and as a `BigInt` through
		// deno-postgres; `String` is what makes both read the same (AD-8).
		eventSeq: String(row['event_seq']),
		channel: String(row['channel']),
		recipient: String(row['recipient']),
		eventType: String(row['event_type']),
		payload: row['payload'],
		managerId: row['manager_id'] === null || row['manager_id'] === undefined
			? null
			: String(row['manager_id']),
		// `timestamptz` arrives as a `Date` through `pg` and may arrive as text
		// through another driver — `toDispatchAttempt`'s idiom, restated.
		occurredAt:
			row['occurred_at'] instanceof Date
				? row['occurred_at'].toISOString()
				: String(row['occurred_at'] ?? ''),
		playerName:
			typeof row['player_name'] === 'string' && row['player_name'].trim() !== ''
				? row['player_name']
				: null
	};
}

/** The two registry reads, folded into what the composer takes. */
function toLeagueDirectory(
	teamRows: readonly QueryResultRow[],
	managerRows: readonly QueryResultRow[]
): LeagueDirectory {
	const teamNames = new Map<string, string>();
	for (const row of teamRows) {
		teamNames.set(String(row['id']), String(row['name']));
	}

	const managerNames = new Map<string, string>();
	const managersOfTeam = new Map<string, string[]>();
	const managerIdsByDiscordUserId = new Map<string, string>();
	const teamOfManager = new Map<string, string>();
	const mutedSlotReleaseManagerIds = new Set<string>();
	for (const row of managerRows) {
		const managerId = String(row['id']);
		managerNames.set(managerId, String(row['display_name']));
		// Folded BEFORE the no-Team `continue` below, so the set is a fact about
		// the Manager rather than about their Team binding. Only a Manager who
		// is explicitly muted is added: the coalesce in the SQL already turned
		// an absent preference row into `false`, and anything a driver hands
		// back that is not recognisably true reads as not muted — the same
		// direction absence reads in.
		if (isTrueFlag(row['slot_release_muted'])) mutedSlotReleaseManagerIds.add(managerId);
		// `discord_user_id` is `not null` and non-blank by check constraint, so
		// a blank here means a driver handed back something unexpected — and a
		// blank key would make every unnameable snowflake resolve to one
		// arbitrary Manager. Skipped rather than trusted.
		const discordUserId = String(row['discord_user_id'] ?? '').trim();
		if (discordUserId !== '') managerIdsByDiscordUserId.set(discordUserId, managerId);
		// A Manager with no Team yet is a real, supported state (a nullable
		// `managers.team_id`), not an error — they simply appear in no Team's
		// list and in no reverse entry.
		const teamId = row['team_id'];
		if (teamId === null || teamId === undefined) continue;
		const key = String(teamId);
		teamOfManager.set(managerId, key);
		const bucket = managersOfTeam.get(key);
		if (bucket === undefined) managersOfTeam.set(key, [managerId]);
		else bucket.push(managerId);
	}

	return {
		teamNames,
		managerNames,
		managersOfTeam,
		managerIdsByDiscordUserId,
		teamOfManager,
		mutedSlotReleaseManagerIds
	};
}

/**
 * A `boolean` column, read the way AD-8's `int8` note reads a bigint.
 *
 * `pg` and deno-postgres both hand back a real `boolean` for `bool`, so the
 * first comparison is the whole of it in practice. The two text spellings are
 * there because this value decides whether somebody is PINGED, and a driver
 * returning `'t'` would otherwise silently unmute every Manager in the league
 * — a failure that looks like nothing at all until somebody says they are
 * still being pinged.
 *
 * **Exported, and the ONE copy.** `server/notification-preferences.ts` reads the
 * same column for the settings page and imports this rather than restating it:
 * a driver fix has to have exactly one place to land, and two coercions that
 * disagreed would let the page and the drain read one row two ways. It lives
 * here rather than there because this module is the Deno-loadable one (AD-2) and
 * the dependency may only point this way.
 */
export function isTrueFlag(value: unknown): boolean {
	if (value === true) return true;
	if (typeof value !== 'string') return false;
	const normalised = value.trim().toLowerCase();
	return normalised === 't' || normalised === 'true';
}

/** One `NotificationDispatched` row, read back as an attempt. */
function toDispatchAttempt(row: QueryResultRow): DispatchAttempt {
	const payload = readPayload(row['payload']);
	const occurredAt = row['occurred_at'];
	const retryAfter = payload['retryAfterMs'];
	return {
		eventSeq: String(payload['eventSeq'] ?? ''),
		channel: String(payload['channel'] ?? ''),
		recipient: String(payload['recipient'] ?? ''),
		delivered: row['delivery_outcome'] === DELIVERY_DELIVERED,
		attemptedAt:
			occurredAt instanceof Date ? occurredAt.toISOString() : String(occurredAt ?? ''),
		retryAfterMs: typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? retryAfter : null
	};
}

/**
 * A `jsonb` payload as an object, whichever way the driver handed it over.
 *
 * `pg` parses `jsonb` into a JS value; a fake or another driver may hand back
 * the text. Anything unreadable becomes an empty object rather than a throw —
 * an unparseable outcome event must not stop the whole drain, and an attempt
 * whose key cannot be read simply matches no intent, which leaves that intent
 * pending. Never dropped (AD-17).
 */
function readPayload(value: unknown): Record<string, unknown> {
	if (typeof value === 'string') {
		try {
			const parsed: unknown = JSON.parse(value);
			return typeof parsed === 'object' && parsed !== null
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Post one channel's batch, turning a missing port and a thrown transport into
 * the same `failed` result a 5xx produces.
 *
 * A channel with no port is a configuration error, and it is recorded as a
 * failed attempt rather than raised: the intents stay pending, back off, and are
 * delivered the moment the port is wired — which is what AD-17's "never dropped"
 * requires of a notice nobody has a transport for yet.
 */
async function postBatch(
	port: NotificationChannelPort | undefined,
	channel: string,
	message: ComposedBatch
): Promise<ChannelPostResult> {
	if (port === undefined) {
		return { kind: 'failed', detail: `no port is registered for the "${channel}" channel` };
	}
	try {
		return await port.post({ body: message.body, recipients: message.recipients });
	} catch (error) {
		return {
			kind: 'failed',
			detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
		};
	}
}

/** One channel's batch, composed: what to send, to whom, and for which intents. */
type ComposedBatch = {
	readonly body: string;
	readonly recipients: readonly string[];
	/**
	 * The intents this message actually carries — never more than `batch`, and
	 * fewer when the ceiling excluded a notice. Only these get an outcome.
	 */
	readonly posted: readonly OutboxIntent[];
};

/**
 * Turn one channel's due intents into one message (Story 5.2).
 *
 * **Grouped by event, not by intent.** A single event can owe several intents
 * — the broadcast row this story writes, and 5.3's per-Manager rows for the
 * same event — and the message should state what happened ONCE. So the batch is
 * folded into groups keyed on `event_seq`, in the order the reader produced,
 * and each group composes to exactly one notice.
 *
 * **The ceiling decides membership, and membership decides outcomes.** Whole
 * notices go in until the next one would not fit; the intents behind the
 * excluded ones are simply not returned, so they get no outcome event and are
 * re-derived as pending next pass. Never dropped, never split mid-notice
 * (AD-17).
 *
 * **`BROADCAST_RECIPIENT` is filtered out of `recipients` here**, which is the
 * one place it could otherwise leak: `recipients` becomes
 * `allowed_mentions.users` in `adapters/discord/webhook.ts`, and a sentinel in
 * it would hand Discord a non-snowflake. Every other recipient IS a snowflake,
 * and the mention rows are exactly the ones that carry one.
 *
 * **The mention rides the notice for its own event** (Story 5.3).
 * `mentionSuffixFor` is asked once per group, for that group's non-sentinel
 * recipients, and its lines are appended UNDER the notice — so the fact and the
 * addressing travel together through the ceiling as one unit. A batch covering
 * five events therefore says which line is whose, which is what prepending at
 * the head of the message could never do.
 *
 * **`recipients` is then narrowed to the snowflakes the BODY actually spells.**
 * `allowed_mentions.users` must be exactly the set of `<@id>` in the message, or
 * the payload claims to ping somebody it does not — and the one case where they
 * could differ is a single notice over the ceiling, which `broadcastBodyFor`
 * truncates rather than drops. Filtering through the composed body closes it by
 * construction.
 */
function composeBatch(
	batch: readonly OutboxIntent[],
	directory: LeagueDirectory,
	origin: string | null,
	ceiling?: number
): ComposedBatch {
	const groups: Array<{ readonly intents: OutboxIntent[] }> = [];
	const bySeq = new Map<string, { readonly intents: OutboxIntent[] }>();
	for (const intent of batch) {
		const existing = bySeq.get(intent.eventSeq);
		if (existing === undefined) {
			const group = { intents: [intent] };
			bySeq.set(intent.eventSeq, group);
			groups.push(group);
		} else {
			existing.intents.push(intent);
		}
	}

	const notices = groups.map((group) => {
		// Every intent in a group describes the SAME event, so any of them
		// carries the same joined columns. The first is as good as any.
		const [first] = group.intents;
		if (first === undefined) return '';
		const event = broadcastEventOf(first);
		const notice = noticeFor(event, directory);
		// The mention rows of THIS event, sentinel excluded — the broadcast row
		// addresses the channel and is never a `<@id>`.
		const addressed = group.intents
			.map((intent) => intent.recipient)
			.filter((recipient) => recipient !== BROADCAST_RECIPIENT);
		const suffix = mentionSuffixFor(event, addressed, directory, origin);
		return suffix === '' ? notice : `${notice}\n${suffix}`;
	});

	const { body, included } = broadcastBodyFor(notices, ceiling);
	const posted = groups.slice(0, included).flatMap((group) => group.intents);

	return {
		body,
		recipients: mentionsPresentIn(
			body,
			[...new Set(posted.map((intent) => intent.recipient))].filter(
				(recipient) => recipient !== BROADCAST_RECIPIENT
			)
		),
		posted
	};
}

/**
 * An `APP_ORIGIN` as the composer takes it: absolute, no trailing slash, or
 * `null`.
 *
 * The trailing slash is stripped because `auctionPathFor` answers a path with a
 * LEADING one, and `https://bbsl.example//auction/x` is a different URL that
 * some hosts 404. Blank or absent is `null` — the mention posts without a link
 * rather than with a broken one.
 */
/**
 * The configured origin, or `null` — and a THROWING port is `null` too.
 *
 * The thunk reaches an environment this module cannot see, and a deployment
 * could hand over one that raises rather than one that answers nothing. An
 * unguarded call would fail the whole drain pass, posting neither the mentions
 * nor the broadcasts — and the matrix is explicit that an origin problem costs
 * the LINK and never the pass. The failure is logged rather than swallowed
 * silently, because a misconfigured origin is worth an operator seeing once per
 * pass that had something to send.
 */
function readOrigin(origin: (() => string | null | undefined) | undefined): string | null {
	if (origin === undefined) return null;
	try {
		return normaliseOrigin(origin());
	} catch (error) {
		console.error('drainOutbox: reading the app origin failed; posting without a link', error);
		return null;
	}
}

function normaliseOrigin(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim().replace(/\/+$/, '');
	return trimmed === '' ? null : trimmed;
}

/** One intent's joined event columns, as the pure composer takes them. */
function broadcastEventOf(intent: OutboxIntent): BroadcastEvent {
	return {
		seq: intent.eventSeq,
		eventType: intent.eventType,
		payload: intent.payload,
		managerId: intent.managerId,
		occurredAt: intent.occurredAt,
		playerName: intent.playerName
	};
}

/**
 * Append one `NotificationDispatched` per attempted intent — **one transaction
 * each, in order.**
 *
 * **Not one transaction for the whole pass, and that is the blast radius.** A
 * single transaction covering five outcomes fails as a unit: if Discord had
 * already accepted the batch and the outcome write then threw, the log would
 * record none of the five as delivered and the next pass would redeliver all
 * five. Per intent, a failure loses at most the ONE outcome it was writing —
 * every outcome recorded before it stands, and only its own intent redelivers.
 * That is the standard floor for a non-idempotent HTTP sink, and it is exactly
 * `server/sweep.ts`'s one-transaction-per-close discipline (AD-11) applied to
 * the other side of the tick.
 *
 * A throw propagates: the caller is `drainOutbox`, whose failure becomes
 * `drainFailure` on the heartbeat, and the outcomes already committed are not
 * rolled back with it.
 *
 * **`runTransactionalWrite` with NO `enqueue`, and that omission is the whole
 * no-feedback-loop property.** An outcome event that enqueued its own intent
 * would notify a Manager that they had been notified, forever. It is structural
 * here rather than a filter somewhere downstream, so no future edit can
 * reintroduce it by forgetting a condition.
 *
 * The actor pair is null: nobody acted (`20260901000000_system_actor.sql`). The
 * dispatcher read a table and posted a message; attributing that to the
 * Commissioner or to the notified Manager would put a person in the Audit Log
 * who did nothing.
 *
 * `dispatchOutcome`/`deliveryOutcome` are NFR §5's measurement columns,
 * populated here for the first time in the product's history — and only ever
 * here, because `auction_events` grants no `update` and the event that CAUSED
 * the notice can therefore never carry them.
 */
async function appendOutcomes(
	gateway: ConnectionGateway,
	outcomes: readonly OutcomeFor[]
): Promise<void> {
	// Sequential, never `Promise.all`: each is its own locked transaction and
	// they would queue on `GLOBAL_WRITE_LOCK_KEY` anyway (AD-6). Awaiting each
	// in turn is what makes "every outcome before the failure is committed" a
	// statement about the log's order rather than about scheduling luck.
	for (const outcome of outcomes) {
		await appendOneOutcome(gateway, outcome);
	}
}

/** One outcome, one whole transaction. */
async function appendOneOutcome(
	gateway: ConnectionGateway,
	{ intent, result }: OutcomeFor
): Promise<void> {
	const outcome = deliveryOutcomeOf(result);
	await runTransactionalWrite({
		gateway,
		// Nothing is decided from state: the outcome was decided by Discord.
		load: async () => ({}),
		decide: () => ({
			kind: 'accepted',
			events: [
				{
					type: NOTIFICATION_DISPATCHED_EVENT,
					payload: {
						// AD-17's key, verbatim, so the next pass's derivation can
						// match this outcome back to the intent it settles.
						eventSeq: intent.eventSeq,
						channel: intent.channel,
						recipient: intent.recipient,
						aboutEventType: intent.eventType,
						outcome,
						// Present only on a 429, and the number the next attempt
						// must wait at least as long as.
						retryAfterMs: result.kind === 'rate_limited' ? result.retryAfterMs : null,
						detail: result.kind === 'delivered' ? null : result.detail
					},
					// System-originated: nobody acted. Null as a pair, enforced by
					// `auction_events_actor_pair_null_together`.
					managerId: null,
					teamId: null,
					dispatchOutcome: DISPATCH_ATTEMPTED,
					deliveryOutcome: outcome
				}
			]
		})
	});
}

/** The `delivery_outcome` column value for one transport result. */
function deliveryOutcomeOf(result: ChannelPostResult): string {
	switch (result.kind) {
		case 'delivered':
			return DELIVERY_DELIVERED;
		case 'rate_limited':
			return DELIVERY_RATE_LIMITED;
		case 'failed':
			return DELIVERY_FAILED;
	}
}
