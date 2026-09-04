Conduct a review of CONTENT.
Look for what's missing, not only what's wrong.
Find at least ten issues to fix or improve.
Output a Markdown list of findings only — no severity, priority, or ranking.
If the content is empty, stop and say so.
If you have zero findings, re-check and keep thinking; do not stop with an empty list.

CONTENT:
diff --git a/_bmad-output/implementation-artifacts/deferred-work.md b/_bmad-output/implementation-artifacts/deferred-work.md
index 87609ce..5f54704 100644
--- a/_bmad-output/implementation-artifacts/deferred-work.md
+++ b/_bmad-output/implementation-artifacts/deferred-work.md
@@ -599,7 +599,8 @@
   evidence: `src/lib/server/outbox.ts`'s `genericBodyFor` performs no truncation and has no length ceiling; the batch it renders is capped only by `PER_PASS_BUDGET`. Surfaced by the step-04 Blind Hunter layer on 2026-09-03. Unreachable at today's generic one-line-per-event body and a budget of five, which is why it is recorded rather than fixed.
   deferred_reason: The limit binds on message COPY, and this story is forbidden by its own **Never** list from composing any. Whatever 5.2 writes determines how many events fit, so a truncation rule written now would be guessing at a body that does not exist yet.
   owner: Story 5.2 — it owns the post's content and is the first point at which a realistic character budget can be computed.
-  status: open
+  resolved: 2026-09-03 by Story 5.2. `genericBodyFor` is gone; `broadcastBodyFor` (`src/lib/adapters/discord/broadcast.ts`) replaces it and takes the ceiling as a parameter defaulting to `DISCORD_MESSAGE_CEILING = 2000`, Discord's own documented limit on `content`. It joins WHOLE notices, one per line, until the next would not fit, and reports how many it included. `composeBatch` in `src/lib/server/outbox.ts` records an outcome for only the intents behind the included notices, so an excluded notice has no `NotificationDispatched`, re-derives as pending, and goes out on the next pass — never dropped, never split mid-notice (AD-17). The one case that truncates is a SINGLE notice already over the ceiling (a draw with thirty contenders): it cannot be split and dropping it would stall the outbox forever, so it is cut to fit with one U+2026 and marked delivered. Both halves are proven in `tests/adapters/discord-broadcast.test.ts` ("posts whole notices up to the ceiling and leaves the remainder out", "truncates the ONE notice that alone exceeds the ceiling", and a real 30-contender draw asserted under the limit) and end to end in `tests/server/outbox.test.ts`.
+  status: closed
 
 - source_spec: `_bmad-output/implementation-artifacts/spec-5-1-the-transactional-outbox-and-its-dispatcher.md`
   summary: **A Team with no Manager rows produces no intent and no record that a notification was owed.** `enqueueIntents` inserts one row per Manager of the event's Team; a Team with none silently yields zero, and nothing anywhere observes that the notice went nowhere.
diff --git a/_bmad-output/implementation-artifacts/spec-5-2-broadcast-auction-events-to-the-league-channel.md b/_bmad-output/implementation-artifacts/spec-5-2-broadcast-auction-events-to-the-league-channel.md
new file mode 100644
index 0000000..bed7465
--- /dev/null
+++ b/_bmad-output/implementation-artifacts/spec-5-2-broadcast-auction-events-to-the-league-channel.md
@@ -0,0 +1,111 @@
+---
+title: 'Story 5.2: Broadcast auction events to the league channel'
+type: 'feature'
+created: '2026-09-03'
+status: 'in-review'
+review_loop_iteration: 0
+baseline_commit: '50a01d53c8876027b7f86b2c9287c821a39e6d56'
+context: []
+---
+
+<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">
+
+## Intent
+
+**Problem:** Story 5.1 built the outbox, the dispatcher and the webhook, but wired the enqueue seam to nothing and ships a placeholder body — `BBSL auction update — BidPlaced (event #1).` Nothing is broadcast today, and the drain cannot see an event's payload, so it could not say what happened even if it were wired.
+
+**Approach:** Add a broadcast intent — one row per broadcast-worthy event, addressed to the channel rather than to a person — wire it into the five writes that append the broadcast set, widen the drain's read so the composer can see payloads and the league's names, and replace the placeholder with a pure per-event-type composer in `adapters/discord/`.
+
+## Boundaries & Constraints
+
+**Always:**
+- One intent per broadcast event, recipient the sentinel `#channel`. The `(event_seq, channel, recipient)` key is unchanged, so 5.3 can later add per-Manager rows for the same event without colliding.
+- The sentinel is never a mention: it must be filtered out of `recipients` before the payload is built, or `allowed_mentions.users` would carry a non-snowflake and the body would render `<@#channel>`.
+- Money renders through `formatMoney` (`$14.5M`, one decimal). Its `DisplayMoney` brand is what keeps it out of a CSV cell — do not stringify an amount by hand.
+- A fantasy Team is always `formatTeamManager` — `Lakers — Meakel`, U+2014. A three-letter capitalised abbreviation means a real-life NBA team and nothing else, so never abbreviate a Team.
+- Composition is pure: every name and instant it needs is passed in. It performs no I/O and reads no clock.
+- No exclamation mark, no urgency framing, no "ending soon"/"last chance", no suggested action, anywhere in composed copy.
+- `outbox.ts` and anything it imports stay Deno-loadable (AD-2): relative `.ts` only, no `$lib`, no `$env`, no node builtin.
+- Composition must not throw out of the drain. A malformed or unrecognised payload degrades to a plain factual line; it never fails a pass.
+
+**Ask First:**
+- Any change to `src/lib/core/**`. Adding `playerName` to `BidPlacedPayload` would be the tempting one — resolve it with the reference join instead.
+- Any new migration. This story needs none.
+
+**Never:**
+- No mention text, no `@` of any Manager, no mute or settings logic — 5.3 and 5.4. `enqueueIntents` (the Manager-shaped enqueue) stays untouched and unwired.
+- No absolute deep link. `auctionPathFor` yields a path and no origin is configured anywhere; the link belongs to 5.3's mention, with the origin decided there.
+- No broadcast of `AuctionTerminated`, `ContentionDissolved`, eligibility, import or `NotificationDispatched` events. The broadcast set is the six named types and nothing else.
+- No second cron schedule, no change to the tick's sweep-then-drain order.
+
+## I/O & Edge-Case Matrix
+
+| Scenario | Input / State | Expected Output / Behavior | Error Handling |
+|---|---|---|---|
+| A Bid is placed | `BidPlaced`, amount 14_500_000, `closesAt` | One intent; post names Team — Manager, Player, `$14.5M` and the new close time as a Discord timestamp | N/A |
+| A Minimum-Bid Contention closes | One transaction appends `ContentionDrawn` then `AuctionClosed` | Two intents, both due together, batched into ONE post; the draw line carries the revealed seed and the contenders in payload order, each spelled out | N/A |
+| An eligibility or import write commits | Events appended by `eligibility.ts` / `import-promotion.ts` | No intent — those writes register no enqueue | N/A |
+| The phase ends | `ContractAssignmentOpened`, `team_id` null | One intent — a broadcast is not keyed on a Team, unlike a mention | N/A |
+| Retry after a delivered post | The pass above re-runs | Zero further posts; the delivered outcome retired both intents | N/A |
+| A batch would exceed the message ceiling | More composed notices than fit | Whole notices posted up to the ceiling; the remainder stay pending and go next pass | Never dropped, never split mid-notice |
+| One notice alone exceeds the ceiling | A draw with 30 contenders | That notice is truncated to fit and posted | Cannot stall the outbox |
+| A payload is unrecognised or malformed | Broadcast type, missing field | A plain line naming the event and its `seq` | Never throws; the pass completes |
+
+</frozen-after-approval>
+
+## Code Map
+
+- `src/lib/server/outbox.ts` -- `genericBodyFor` (:685-694) is the placeholder to replace, called from `postBatch` (:662). `PENDING_INTENTS_SQL` (:435-440) selects only `o.event_seq, o.channel, o.recipient, e.event_type` — this is why nothing can be composed today; widen it and `toOutboxIntent` (:593-602)/`OutboxIntent` (:158-165). `postBatch` (:652-671) builds `recipients` from every intent (:663) — filter the sentinel there. `drainOutbox` (:476-511) counts outcomes for the whole batch; it must count only what was posted. `DISCORD_CHANNEL` (:83) is the constant pattern for the new sentinel.
+- `src/lib/server/outbox.ts` -- `enqueueIntents` (:220-249) is the Manager-shaped enqueue: it skips `teamId === null` (:228, :239) and fans out per Manager. **Do not reuse or modify it** — a broadcast is one row keyed on type, not per Manager, and phase events carry a null `teamId`. Its header (:215-218) names this story as the one that wires an enqueue.
+- `src/lib/shell/write.ts` -- `enqueue` runs inside the transaction, after projections, before `COMMIT` (:294-305); `EnqueueFn` is `(client, appended)` (:240). A throwing enqueue rolls the write back, which is why composition never runs here.
+- Wiring points, all `runTransactionalWrite` calls: `src/lib/server/nomination.ts:585` (`NominationPlaced`), `src/lib/server/bidding.ts:443` (`BidPlaced`), `src/lib/server/close.ts:188` (`ContentionDrawn` + `AuctionClosed`), `src/lib/server/auction-open.ts:183` (`AuctionOpened`), `src/lib/server/phase-end.ts:159` (`ContractAssignmentOpened`). `eligibility.ts:272` and `import-promotion.ts:273` must stay unwired.
+- Event literals: `NominationPlaced` `src/lib/core/projection/nominations.ts:85`; `BidPlaced` `src/lib/core/projection/auctions.ts:64`; `AuctionClosed` `nominations.ts:98`; `ContentionDrawn` `src/lib/core/projection/draws.ts:60`; `AuctionOpened` `src/lib/core/projection/phase.ts:59`; `ContractAssignmentOpened` `phase.ts:80`. There is no DB check constraint on `event_type` (`20260821020000_auction_events.sql:60-64`).
+- Payloads: `NominationPlacedPayload` `src/lib/server/nomination.ts:121-127` (has `playerName`, no amount, **no close time**); `BidPlacedPayload` `src/lib/core/rules/bidding.ts:2753-2777` (`amount`, `closesAt`, **no `playerName`**); `AuctionClosedPayload` `src/lib/core/rules/close.ts:370-387` (`playerName`, `winningAmount`, `capHit`, `closedAt`); `ContentionDrawnPayload` `close.ts:416-442` (`seed`, `contenders: readonly string[]` of **team ids**, `winningTeamName`, `drawnAt`); `AuctionOpenedPayload` `src/lib/server/auction-open.ts:196-199`; `ContractAssignmentOpenedPayload` `src/lib/core/rules/phase-end.ts:149-156`.
+- Renderers, all pure and reachable by relative `.ts`: `formatMoney` `src/lib/core/money.ts:169` (throws `RangeError` off-grid — guard it); `DisplayMoney`/`ExportCell` brands :35,:38 with the compile-time separation test `tests/money.test.ts:210-236`; `formatTeamManager` + `EM_DASH` `src/lib/core/team-identity.ts:36,:18`; `auctionPathFor` `src/lib/core/auction-link.ts:44` (path only, :17-20).
+- `src/lib/adapters/discord/webhook.ts` -- `contentFor` (:183-189) prepends mentions to the body; `payloadFor` (:196-204) sets `allowed_mentions: { parse: [], users: addressees(message) }`; `addressees` (:166-174) de-dupes. `DiscordWebhookMessage` is `{ body, recipients }` (:54-68). Header (:11-15) names 5.2 as the owner of copy. No `.gitkeep` concern remains — `tests/structure.test.ts:220` already requires it absent.
+- Names not on any payload: Manager display names are `managers.display_name` (`20260821000000_managers.sql:35`); `managers.discord_user_id` (:31) is the snowflake and is not a display name. Contender team ids need `teams`. `free_agent_players.player_name` (`20260824020000_live_reference_tables.sql:107`) is stable for the whole auction — `close.ts:11` confirms a close writes neither table.
+- `tests/server/outbox.test.ts` -- content-asserting tests that must change: :640, :698, :749. Mechanism tests (:279, :457, :668, :807) must stay green. `readDueIntents` (:554-590) is the three-reads-in-one-transaction shape any new read joins.
+- `_bmad-output/implementation-artifacts/deferred-work.md` -- the open item "Nothing guards Discord's 2000-character message limit", owner Story 5.2. This story closes it.
+
+## Tasks & Acceptance
+
+**Execution:**
+- [x] `src/lib/adapters/discord/broadcast.ts` -- new, pure. Export `BROADCAST_EVENT_TYPES` (the six literals), a `LeagueDirectory` input type (team id → name, manager id → display name, team id → its Managers), `noticeFor(event, directory)` returning one line per event type, and `broadcastBodyFor(notices, ceiling)` joining whole notices up to the ceiling and reporting which were included. Render instants as Discord `<t:unix:f>` markup so every reader sees their own timezone. Money through `formatMoney`, Teams through `formatTeamManager`.
+- [x] `src/lib/server/outbox.ts` -- add `BROADCAST_RECIPIENT = '#channel'` and `enqueueBroadcasts: EnqueueFn` inserting one intent per event whose type is in the broadcast set, independent of `teamId`. Widen `PENDING_INTENTS_SQL`/`OutboxIntent` with `e.payload`, `e.manager_id`, `e.occurred_at` and a left join to `free_agent_players` for the Player name `BidPlaced` lacks. Read the league directory inside `readDueIntents`' existing transaction. Filter `BROADCAST_RECIPIENT` out of `postBatch`'s `recipients`. Compose through `broadcastBodyFor`, and record outcomes only for the intents actually posted.
+- [x] `src/lib/server/nomination.ts`, `bidding.ts`, `close.ts`, `auction-open.ts`, `phase-end.ts` -- pass `enqueue: enqueueBroadcasts` to `runTransactionalWrite`. One line each; state in a comment why this write broadcasts and `eligibility.ts` does not.
+- [x] `tests/adapters/discord-broadcast.test.ts` -- new. One case per event type against a literal payload and a fake directory, the ceiling cases from the matrix, the malformed-payload fallback, and an assertion over every composed sample that no `!` and no urgency word appears.
+- [x] `tests/server/outbox.test.ts` -- replace the three content assertions with real copy; add the batched draw-plus-close case, the null-`teamId` phase broadcast, the sentinel absent from `recipients`, and that an eligibility write enqueues nothing.
+- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- mark the 2000-character item `status: closed`, naming the ceiling this story implements.
+
+**Acceptance Criteria:**
+- Given a write that appends a broadcast event, when it commits, then exactly one intent committed with it, and a write outside the broadcast set committed none.
+- Given the drain, when it posts, then the payload's `allowed_mentions` names no user at all, because 5.2 mentions nobody.
+- Given the whole story, when `npm test`, `npm run check` and `npx deno check --config supabase/functions/tick/deno.json supabase/functions/tick/index.ts` are run, then all three pass.
+
+## Spec Change Log
+
+## Design Notes
+
+**Why a sentinel recipient rather than a nullable column.** `recipient` is `not null` with a non-blank check and sits in the unique key (`20260903000000_notification_outbox.sql:67,79,84`). A sentinel needs no migration, keeps the key declarative, and lets 5.3's per-Manager rows coexist with the broadcast for the same event. `#channel` is chosen because it can never collide with a Discord snowflake, which is numeric.
+
+**Why the ceiling drops whole notices instead of truncating the batch.** An intent with no recorded outcome is still pending, so an excluded notice is picked up next pass for free — the same "re-derives, never remembers" property the drain already has. Truncating the joined body would instead deliver a half-sentence and mark it delivered. A single notice over the ceiling is the one case that must truncate, or it would stall the outbox forever.
+
+**Golden examples** (`<t:…:f>` renders as the reader's local time):
+
+```
+Lakers — Meakel bid $14.5M on Anthony Davis. Closes <t:1789248600:f>.
+Anthony Davis to Lakers — Meakel for $14.5M.
+Anthony Davis drawn to Lakers — Meakel. Contenders, in order: Lakers — Meakel, Bulls — Ari. Seed: 9f3c8a1d
+```
+
+**The seed is posted in full, never abbreviated.** The draw post is where Story 3.6's commit-reveal is discharged: a Manager hashes the revealed seed and checks it against the `seedHash` published on the opening `BidPlaced`. A prefix hashes to nothing, so abbreviating it would leave the fairness premise unverifiable while looking correct. A real seed is 32 bytes as hex — 64 characters, which the ceiling absorbs without difficulty. The seed above is short only because it is an example.
+
+## Verification
+
+**Commands:**
+- `npm test` -- expected: all pass, including the 5.1 mechanism suites in `tests/server/outbox.test.ts`.
+- `npm run check` -- expected: no type errors; the `@ts-expect-error` pair in `tests/money.test.ts:226-230` still holds.
+- `npx deno check --config supabase/functions/tick/deno.json supabase/functions/tick/index.ts` -- expected: clean. Composition is now reachable from the tick, so a non-Deno import in `broadcast.ts` breaks production and CI's `src/lib/core`-only deno check would not catch it.
+
+**Manual checks:**
+- `git status --short` before review — confirm no new file is left untracked, so the whole diff reaches the reviewers.
diff --git a/_bmad-output/implementation-artifacts/sprint-status.yaml b/_bmad-output/implementation-artifacts/sprint-status.yaml
index 61b0a9a..12db59e 100644
--- a/_bmad-output/implementation-artifacts/sprint-status.yaml
+++ b/_bmad-output/implementation-artifacts/sprint-status.yaml
@@ -81,7 +81,7 @@ development_status:
 
   epic-5: in-progress
   5-1-the-transactional-outbox-and-its-dispatcher: done
-  5-2-broadcast-auction-events-to-the-league-channel: backlog
+  5-2-broadcast-auction-events-to-the-league-channel: in-progress
   5-3-notify-managers-by-discord-mention: backlog
   5-4-notification-settings-three-mutable-categories-and-only-thre: backlog
   epic-5-retrospective: optional
diff --git a/src/lib/adapters/discord/broadcast.ts b/src/lib/adapters/discord/broadcast.ts
new file mode 100644
index 0000000..853240a
--- /dev/null
+++ b/src/lib/adapters/discord/broadcast.ts
@@ -0,0 +1,456 @@
+/**
+ * What a broadcast notice SAYS. Story 5.2, AD-18.
+ *
+ * **The second file in `adapters/discord/`**, and the one AR-2's tree means by
+ * copy: `webhook.ts` knows the wire shape of a request and nothing about
+ * auctions; this knows what an auction event reads like in a Discord message
+ * and nothing about transports, outbox rows, retries or budgets. Story 5.1
+ * shipped `BBSL auction update — BidPlaced (event #1).` as a placeholder and
+ * named this story as the one that replaces it.
+ *
+ * **Addressed to the CHANNEL, never to a person.** Every line here is the
+ * league's public record of something that happened. There is no mention text,
+ * no `@`, and no Manager is singled out — Story 5.3 owns the mention and 5.4
+ * owns muting, and both of them work by adding a recipient beside this body
+ * rather than by changing a word of it (`DiscordWebhookMessage` keeps `body`
+ * and `recipients` separate all the way to the wire for exactly that reason).
+ *
+ * **Pure, and that is load-bearing twice over.** It performs no I/O and reads
+ * no clock: every name and every instant it needs is passed in, which is what
+ * lets `tests/adapters/discord-broadcast.test.ts` drive every event type
+ * against a literal payload with no database. And it is Deno-loadable (AD-2) —
+ * relative `.ts` imports only, no `$lib`, no `$env`, no Node builtin — because
+ * `server/outbox.ts` reaches it and the tick reaches `server/outbox.ts`.
+ *
+ * **Nothing here throws.** `noticeFor` degrades a malformed or unrecognised
+ * payload to a plain factual line naming the event and its `seq`. The log is
+ * insert-only, so a historical row cannot be corrected in place, and a reader
+ * that crashed on one would stall the outbox forever — the same defensive
+ * reading `core/projection/*.ts` applies to `AppendedEvent.payload`.
+ *
+ * **The copy rules, from the story's boundaries.** No exclamation mark, no
+ * urgency framing, no "ending soon" or "last chance", no suggested action.
+ * These are notices, not prompts. Money renders through `formatMoney` and a
+ * fantasy Team through `formatTeamManager`, never by hand — a three-letter
+ * capitalised abbreviation always and only means a real-life NBA team.
+ */
+
+import { formatMoney } from '../../core/money.ts';
+import type { Money } from '../../core/money.ts';
+import { formatTeamManager, formatTeamManagers } from '../../core/team-identity.ts';
+
+// --- What is broadcast ----------------------------------------------------
+
+/**
+ * The six event types the league channel hears about, and nothing else.
+ *
+ * Deliberately NOT every appended event. `AuctionTerminated` and
+ * `ContentionDissolved` are quiet outcomes nobody is waiting on; eligibility
+ * and import writes are Commissioner bookkeeping; and the dispatcher's own
+ * `NotificationDispatched` would notify the league that the league had been
+ * notified. Membership of this list is the whole of the broadcast decision,
+ * and `server/outbox.ts`'s `enqueueBroadcasts` is the only reader of it.
+ */
+export const BROADCAST_EVENT_TYPES: readonly string[] = [
+	'NominationPlaced',
+	'BidPlaced',
+	'AuctionClosed',
+	'ContentionDrawn',
+	'AuctionOpened',
+	'ContractAssignmentOpened'
+];
+
+/** Whether an appended event's type earns a line in the league channel. */
+export function isBroadcastEventType(eventType: string): boolean {
+	return BROADCAST_EVENT_TYPES.includes(eventType);
+}
+
+// --- The inputs -----------------------------------------------------------
+
+/**
+ * One appended event, as much of it as composition reads.
+ *
+ * `payload` is `unknown` because `AppendedEvent.payload` is: this module is
+ * handed whatever the log holds and narrows it itself, rather than trusting a
+ * cast made by the caller that read the row.
+ */
+export type BroadcastEvent = {
+	/** `auction_events.seq`, as a string — `int8` (AD-8). */
+	readonly seq: string;
+	readonly eventType: string;
+	readonly payload: unknown;
+	/** The acting Manager, or `null` for a system event. */
+	readonly managerId: string | null;
+	/** The event's own `occurred_at`, ISO-8601. Never used as "now". */
+	readonly occurredAt: string;
+	/**
+	 * The Player's name, resolved by the caller's join on the payload's
+	 * `fantraxPlayerId`. `BidPlaced` carries no `playerName` of its own and
+	 * adding one would mean editing `core/rules/bidding.ts`, so the name is
+	 * joined from `free_agent_players` — which a close writes neither of.
+	 */
+	readonly playerName: string | null;
+};
+
+/**
+ * Every name the league has, as composition needs them.
+ *
+ * Passed in whole rather than looked up, because purity is what makes this
+ * testable and Deno-loadable. `server/outbox.ts` reads it inside the same
+ * transaction as the intents, so one pass composes against one snapshot of
+ * the registry.
+ */
+export type LeagueDirectory = {
+	/** `teams.id` -> `teams.name`. */
+	readonly teamNames: ReadonlyMap<string, string>;
+	/** `managers.id` -> `managers.display_name`. Never the Discord snowflake. */
+	readonly managerNames: ReadonlyMap<string, string>;
+	/**
+	 * `teams.id` -> every Manager acting for it, in a stable order.
+	 *
+	 * Co-management is a supported state, so a Team legitimately has more than
+	 * one Manager to name — `formatTeamManagers` renders the pair.
+	 */
+	readonly managersOfTeam: ReadonlyMap<string, readonly string[]>;
+};
+
+/** An empty directory. Every notice it cannot name degrades rather than throws. */
+export const EMPTY_LEAGUE_DIRECTORY: LeagueDirectory = {
+	teamNames: new Map(),
+	managerNames: new Map(),
+	managersOfTeam: new Map()
+};
+
+// --- Rendering primitives -------------------------------------------------
+
+/**
+ * An instant as Discord's own timestamp markup, so every reader sees it in
+ * THEIR timezone rather than in the server's.
+ *
+ * `f` is Discord's "long date/time" style — `3 September 2026 14:30`. The
+ * league spans timezones and a bare UTC string would make half of it do
+ * arithmetic; this is the one piece of Discord message grammar besides
+ * `webhook.ts`'s `<@id>` that this application spells.
+ *
+ * `null` for an unparseable instant, which degrades the notice rather than
+ * rendering `<t:NaN:f>`.
+ */
+export function discordTimestamp(instant: string): string | null {
+	const ms = Date.parse(instant);
+	if (!Number.isFinite(ms)) return null;
+	return `<t:${String(Math.floor(ms / 1000))}:f>`;
+}
+
+/** U+2026 HORIZONTAL ELLIPSIS. One character, never three dots. */
+const ELLIPSIS = '…';
+
+/**
+ * An amount as `$14.5M`, or `null` if it is not renderable.
+ *
+ * `formatMoney` throws a `RangeError` for an amount off the `MINIMUM_INCREMENT`
+ * grid, and an insert-only log can hold a historical payload that predates a
+ * rule. Guarded here rather than at every call site, and a `null` degrades the
+ * notice — the alternative is a thrown exception in the drain.
+ */
+function displayMoney(value: unknown): string | null {
+	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
+	try {
+		return formatMoney(value as Money);
+	} catch {
+		return null;
+	}
+}
+
+// --- Reading a payload defensively ----------------------------------------
+
+/** A payload as an object, or an empty one. Never a throw. */
+function fields(payload: unknown): Record<string, unknown> {
+	return typeof payload === 'object' && payload !== null
+		? (payload as Record<string, unknown>)
+		: {};
+}
+
+/** A non-blank string field, or `null`. */
+function text(payload: Record<string, unknown>, key: string): string | null {
+	const value = payload[key];
+	if (typeof value !== 'string') return null;
+	const trimmed = value.trim();
+	return trimmed === '' ? null : trimmed;
+}
+
+/** A finite, non-negative integer field, or `null`. */
+function count(payload: Record<string, unknown>, key: string): number | null {
+	const value = payload[key];
+	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
+	return Math.trunc(value);
+}
+
+/** A string-array field, blanks removed, or `null` if it is not an array. */
+function ids(payload: Record<string, unknown>, key: string): readonly string[] | null {
+	const value = payload[key];
+	if (!Array.isArray(value)) return null;
+	return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
+}
+
+// --- Naming a Team --------------------------------------------------------
+
+/**
+ * Where the acting pair lives on an ordinary auction payload.
+ * `NominationPlacedPayload`, `BidPlacedPayload` and `AuctionClosedPayload` all
+ * spell it the same three ways, which is why one constant serves three cases.
+ */
+const ACTING_KEYS = { teamId: 'teamId', teamName: 'teamName', managerId: 'managerId' } as const;
+
+/**
+ * Where it lives on `ContentionDrawnPayload`, which names the WINNER rather
+ * than an actor — a draw has no acting Manager, so the pair is the Team the
+ * reduction selected and the Manager whose joining Bid put it in the draw.
+ */
+const DRAW_WINNER_KEYS = {
+	teamId: 'winningTeamId',
+	teamName: 'winningTeamName',
+	managerId: 'winningManagerId'
+} as const;
+
+/**
+ * The acting Team, paired with the ONE Manager who acted: `Lakers — Meakel`.
+ *
+ * The acting Manager rather than every Manager of the Team, because a Bid is
+ * placed by a person: a co-managed Team's notice should name who actually did
+ * it. `teamName` comes off the payload first — every one of these payloads
+ * carries it, recorded at the moment the event happened, so a Team renamed
+ * afterwards does not rewrite history — and falls back to the directory.
+ */
+function actingTeam(
+	payload: Record<string, unknown>,
+	directory: LeagueDirectory,
+	keys: { readonly teamId: string; readonly teamName: string; readonly managerId: string }
+): string | null {
+	const teamId = text(payload, keys.teamId);
+	const teamName =
+		text(payload, keys.teamName) ??
+		(teamId === null ? null : directory.teamNames.get(teamId) ?? null);
+	if (teamName === null) return null;
+
+	const managerId = text(payload, keys.managerId);
+	const managerName =
+		managerId === null ? null : directory.managerNames.get(managerId) ?? null;
+	// No Manager to name is not a failure: `formatTeamManagers` with an empty
+	// list is the Team name alone, which is honest rather than a stray dash.
+	return managerName === null
+		? formatTeamManagers(teamName, [])
+		: formatTeamManager(teamName, managerName);
+}
+
+/**
+ * A Team named by id alone, with EVERY Manager acting for it:
+ * `Lakers — Meakel & Dana`.
+ *
+ * The contender list is the only place a Team arrives as a bare id — AD-14
+ * makes the draw's order an input to the winner, so `contenders` is the fold's
+ * own list of ids in the fold's own order and nothing may re-sort or re-shape
+ * it. An id the directory cannot name is spelled as itself rather than
+ * dropped: the list a Manager checks the draw against must have the same
+ * length as the one the draw ran over.
+ */
+function contenderName(teamId: string, directory: LeagueDirectory): string {
+	const teamName = directory.teamNames.get(teamId);
+	if (teamName === undefined) return teamId;
+	const managerNames = (directory.managersOfTeam.get(teamId) ?? [])
+		.map((managerId) => directory.managerNames.get(managerId))
+		.filter((name): name is string => name !== undefined);
+	return formatTeamManagers(teamName, managerNames);
+}
+
+// --- The composer ---------------------------------------------------------
+
+/**
+ * The line for one event, or the plain fallback.
+ *
+ * **Never throws**, and the try/catch is the guarantee rather than the
+ * per-branch guards alone: the whole point of the fallback is that a payload
+ * shape nobody anticipated cannot fail a drain pass. Every branch that cannot
+ * name the facts its sentence needs returns `null` and lands in the same
+ * place.
+ */
+export function noticeFor(event: BroadcastEvent, directory: LeagueDirectory): string {
+	try {
+		return composed(event, directory) ?? fallbackNotice(event);
+	} catch {
+		return fallbackNotice(event);
+	}
+}
+
+/**
+ * The plain factual line: what happened and where to find it.
+ *
+ * It names the event type and its `seq` and claims nothing else. A reader with
+ * the log can look it up; a reader without one at least knows the league did
+ * something rather than seeing silence.
+ */
+function fallbackNotice(event: BroadcastEvent): string {
+	return `A ${event.eventType} was recorded (event #${event.seq}).`;
+}
+
+/** The per-type copy. `null` for "the facts this sentence needs are absent". */
+function composed(event: BroadcastEvent, directory: LeagueDirectory): string | null {
+	const payload = fields(event.payload);
+
+	switch (event.eventType) {
+		case 'NominationPlaced': {
+			const team = actingTeam(payload, directory, ACTING_KEYS);
+			const player = text(payload, 'playerName') ?? event.playerName;
+			if (team === null || player === null) return null;
+			return `${team} nominated ${player}.`;
+		}
+
+		case 'BidPlaced': {
+			const team = actingTeam(payload, directory, ACTING_KEYS);
+			// `BidPlacedPayload` carries no `playerName` — the joined name is
+			// the only source, and resolving it that way is what kept this
+			// story out of `core/rules/bidding.ts`.
+			const player = event.playerName ?? text(payload, 'playerName');
+			const amount = displayMoney(payload['amount']);
+			const closesAt = text(payload, 'closesAt');
+			const closes = closesAt === null ? null : discordTimestamp(closesAt);
+			if (team === null || player === null || amount === null || closes === null) return null;
+			return `${team} bid ${amount} on ${player}. Closes ${closes}.`;
+		}
+
+		case 'AuctionClosed': {
+			const team = actingTeam(payload, directory, ACTING_KEYS);
+			const player = text(payload, 'playerName') ?? event.playerName;
+			const amount = displayMoney(payload['winningAmount']);
+			if (team === null || player === null || amount === null) return null;
+			return `${player} to ${team} for ${amount}.`;
+		}
+
+		case 'ContentionDrawn': {
+			const winner = actingTeam(payload, directory, DRAW_WINNER_KEYS);
+			const player = event.playerName ?? text(payload, 'playerName');
+			const contenders = ids(payload, 'contenders');
+			const seed = text(payload, 'seed');
+			if (winner === null || player === null || contenders === null || seed === null) return null;
+			// In payload order, spelled out, every one of them. The order IS
+			// the draw's input (AD-14), so the list is a fact and not a
+			// presentation choice.
+			const listed = contenders.map((teamId) => contenderName(teamId, directory)).join(', ');
+			// **The seed in full, never a prefix.** The draw post is where the
+			// commit-reveal is discharged: a Manager hashes this string and
+			// checks it against the `seedHash` published on the opening
+			// `BidPlaced` (Story 3.6). A truncated seed hashes to nothing and
+			// makes the fairness premise theatre. 32 bytes as hex is 64
+			// characters, which the message ceiling absorbs without difficulty.
+			return `${player} drawn to ${winner}. Contenders, in order: ${listed}. Seed: ${seed}`;
+		}
+
+		case 'AuctionOpened': {
+			const teams = payload['teams'];
+			if (!Array.isArray(teams)) return null;
+			const eligible = count(payload, 'minorLeagueEligibleCount');
+			if (eligible === null) return null;
+			return (
+				`The Auction Phase is open with ${String(teams.length)} ${plural(teams.length, 'Team')} ` +
+				`and ${String(eligible)} Minor League eligible ${plural(eligible, 'Player')}.`
+			);
+		}
+
+		case 'ContractAssignmentOpened': {
+			const terminated = ids(payload, 'terminatedPlayerIds');
+			if (terminated === null) return null;
+			const unbid =
+				terminated.length === 0
+					? 'Every nominated Player drew a Bid.'
+					: `${String(terminated.length)} nominated ${plural(terminated.length, 'Player')} ended with no Bid.`;
+			return `The Auction Phase has ended and Contract Assignment is open. ${unbid}`;
+		}
+
+		default:
+			return null;
+	}
+}
+
+/**
+ * `Team` / `Teams`. The noun alone — every sentence here is built so the verb
+ * does not have to agree, which is what keeps the counted clauses readable at
+ * zero as well as at thirty.
+ */
+function plural(quantity: number, noun: string): string {
+	return quantity === 1 ? noun : `${noun}s`;
+}
+
+// --- The message ceiling --------------------------------------------------
+
+/**
+ * Discord's hard limit on `content`, in characters.
+ *
+ * A message over it is REJECTED, not truncated by Discord — so an unbounded
+ * batch would fail the whole post, back off, and fail again identically
+ * forever. `deferred-work.md` logged this as Story 5.1's open item and named
+ * this story as its owner.
+ */
+export const DISCORD_MESSAGE_CEILING = 2000;
+
+/** One notice per line. A wall of prose would be unreadable at a glance. */
+const NOTICE_SEPARATOR = '\n';
+
+/** What `broadcastBodyFor` composed, and how much of the batch it covers. */
+export type BroadcastBody = {
+	readonly body: string;
+	/**
+	 * How many of the notices, from the front, the body actually carries.
+	 *
+	 * The caller records an outcome for exactly these and leaves the rest
+	 * pending — an intent with no recorded outcome is still pending, so an
+	 * excluded notice goes out next pass for free. That is the same
+	 * "re-derives, never remembers" property the drain already has.
+	 */
+	readonly included: number;
+};
+
+/**
+ * Join whole notices up to the ceiling.
+ *
+ * **Whole notices, never a truncated batch.** Cutting the joined body at 2000
+ * characters would deliver a half-sentence AND mark every intent in it
+ * delivered, because the drain records an outcome per intent it posted.
+ * Dropping the overflow instead costs nothing: those intents have no outcome,
+ * so they are still pending and the next pass picks them up.
+ *
+ * **One notice that alone exceeds the ceiling is the one case that truncates**
+ * — a draw with thirty contenders, say. It cannot be split and it cannot be
+ * dropped, because an intent that can never be posted would stall the outbox
+ * forever, and AD-17's promise is that a notice is never dropped. So it is cut
+ * to fit and marked delivered, which is the only exit that terminates.
+ */
+export function broadcastBodyFor(
+	notices: readonly string[],
+	ceiling: number = DISCORD_MESSAGE_CEILING
+): BroadcastBody {
+	if (notices.length === 0) return { body: '', included: 0 };
+
+	const included: string[] = [];
+	let length = 0;
+	for (const notice of notices) {
+		const cost = (included.length === 0 ? 0 : NOTICE_SEPARATOR.length) + notice.length;
+		if (length + cost > ceiling) break;
+		included.push(notice);
+		length += cost;
+	}
+
+	if (included.length === 0) {
+		// The FIRST notice alone is over the ceiling. Truncate that one and
+		// count it as included — see the header.
+		return { body: truncateToFit(notices[0] ?? '', ceiling), included: 1 };
+	}
+
+	return { body: included.join(NOTICE_SEPARATOR), included: included.length };
+}
+
+/** Cut to at most `ceiling` characters, marking the cut with one ellipsis. */
+function truncateToFit(notice: string, ceiling: number): string {
+	if (ceiling <= 0) return '';
+	if (notice.length <= ceiling) return notice;
+	if (ceiling <= ELLIPSIS.length) return notice.slice(0, ceiling);
+	return `${notice.slice(0, ceiling - ELLIPSIS.length)}${ELLIPSIS}`;
+}
diff --git a/src/lib/server/auction-open.ts b/src/lib/server/auction-open.ts
index 6c535d2..1f70e6d 100644
--- a/src/lib/server/auction-open.ts
+++ b/src/lib/server/auction-open.ts
@@ -45,6 +45,7 @@ import type { EventEnvelope } from '../core/types.ts';
 import { runTransactionalWrite } from '../shell/write.ts';
 import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../shell/write.ts';
 import { loadEventsViaClient } from './event-log.ts';
+import { enqueueBroadcasts } from './outbox.ts';
 
 /** Who acted, resolved server-side from application tables (AD-4). */
 export type AuctionOpenActor = {
@@ -182,6 +183,13 @@ export async function openAuction(
 ): Promise<WriteOutcome> {
 	return runTransactionalWrite<AuctionOpenState>({
 		gateway,
+		// Story 5.2 broadcasts this write: `AuctionOpened` is the moment the
+		// league may start nominating, so nobody should have to poll for it.
+		// `enqueueBroadcasts` files one channel-addressed intent per event in the
+		// broadcast set. `eligibility.ts` and `import-promotion.ts` pass no
+		// `enqueue` at all: Commissioner bookkeeping is not league news, and a
+		// notice for it would be channel noise nothing can mute.
+		enqueue: enqueueBroadcasts,
 		load: (client) => loadAuctionOpenState(client),
 		decide: ({ state }) => {
 			const refusal = refuseAuctionOpen(state);
diff --git a/src/lib/server/bidding.ts b/src/lib/server/bidding.ts
index fe6aabd..f0d08c5 100644
--- a/src/lib/server/bidding.ts
+++ b/src/lib/server/bidding.ts
@@ -124,6 +124,7 @@ import type {
 } from '../shell/write.ts';
 import { CONTENTION_SEEDS_TABLE, readContentionSeed } from './contention-seed.ts';
 import { loadEventsViaClient } from './event-log.ts';
+import { enqueueBroadcasts } from './outbox.ts';
 import { loadTeamRoster } from './team-roster.ts';
 
 /** Who acted, resolved server-side from application tables (AD-4). */
@@ -442,6 +443,13 @@ export async function placeBid(
 
 	return await runTransactionalWrite<LoadedBidState>({
 		gateway,
+		// Story 5.2 broadcasts this write: a `BidPlaced` moves the price and
+		// resets the Auction Clock, which is the fact every other Team needs.
+		// `enqueueBroadcasts` files one channel-addressed intent per event in the
+		// broadcast set. `eligibility.ts` and `import-promotion.ts` pass no
+		// `enqueue` at all: Commissioner bookkeeping is not league news, and a
+		// notice for it would be channel noise nothing can mute.
+		enqueue: enqueueBroadcasts,
 		load: (client) => loadBidState(client, fantraxPlayerId, actor.teamId),
 		// The ONE projection, and it fires only when the core published a
 		// `seedHash` — which is only on the Bid that opens a Minimum-Bid
diff --git a/src/lib/server/close.ts b/src/lib/server/close.ts
index 1b68b5f..18c6b44 100644
--- a/src/lib/server/close.ts
+++ b/src/lib/server/close.ts
@@ -82,6 +82,7 @@ import type { ConnectionGateway, TransactionalClient, WriteOutcome } from '../sh
 import { readContentionSeed } from './contention-seed.ts';
 import { loadEventsViaClient } from './event-log.ts';
 import { releaseNomination } from './nomination.ts';
+import { enqueueBroadcasts } from './outbox.ts';
 import { loadTeamRoster } from './team-roster.ts';
 
 /**
@@ -187,6 +188,15 @@ export async function closeAuction(
 ): Promise<WriteOutcome> {
 	return await runTransactionalWrite<CloseState>({
 		gateway,
+		// Story 5.2 broadcasts this write: it appends the `ContentionDrawn` reveal
+		// and the `AuctionClosed` that awards the Player — the two events the
+		// league most needs stated out loud, and the pair that batches into one
+		// post because they commit together.
+		// `enqueueBroadcasts` files one channel-addressed intent per event in the
+		// broadcast set. `eligibility.ts` and `import-promotion.ts` pass no
+		// `enqueue` at all: Commissioner bookkeeping is not league news, and a
+		// notice for it would be channel noise nothing can mute.
+		enqueue: enqueueBroadcasts,
 		load: (client) => loadCloseState(client, fantraxPlayerId),
 		// The one-line registration Story 2.3 wrote `releaseNomination` for.
 		// It goes through the `projections` hook because that is the one seam
diff --git a/src/lib/server/nomination.ts b/src/lib/server/nomination.ts
index 2061b7a..032ce6b 100644
--- a/src/lib/server/nomination.ts
+++ b/src/lib/server/nomination.ts
@@ -92,6 +92,7 @@ import type {
 	WriteOutcome
 } from '../shell/write.ts';
 import { loadEventsViaClient } from './event-log.ts';
+import { enqueueBroadcasts } from './outbox.ts';
 import { constraintOf, isUniqueViolation } from './pg-errors.ts';
 
 const FREE_AGENT_PLAYERS_TABLE = 'free_agent_players';
@@ -584,7 +585,14 @@ export async function placeNomination(
 	try {
 		return await runTransactionalWrite<NominationState>({
 			gateway,
-			load: (client) => loadNominationState(client, fantraxPlayerId),
+			// Story 5.2 broadcasts this write: a `NominationPlaced` puts a Player on
+		// the Board, which is the whole league's business and the cue to bid.
+		// `enqueueBroadcasts` files one channel-addressed intent per event in the
+		// broadcast set. `eligibility.ts` and `import-promotion.ts` pass no
+		// `enqueue` at all: Commissioner bookkeeping is not league news, and a
+		// notice for it would be channel noise nothing can mute.
+		enqueue: enqueueBroadcasts,
+		load: (client) => loadNominationState(client, fantraxPlayerId),
 			// The claim row, written inside the appending transaction (Story
 			// 2.2). Nothing reads it; it exists so a second writer collides.
 			projections: [claimNomination],
diff --git a/src/lib/server/outbox.ts b/src/lib/server/outbox.ts
index ec286eb..f73386e 100644
--- a/src/lib/server/outbox.ts
+++ b/src/lib/server/outbox.ts
@@ -54,12 +54,28 @@
  * supabase/functions/tick/deno.json supabase/functions/tick/index.ts` is what
  * proves it, and `--config` is load-bearing.
  *
- * Not this story: no message composition, no event-type-to-copy mapping and no
- * mention text beyond the generic sentence below (5.2, 5.3); no mute or
- * settings logic (5.4); no Commissioner-visible failure screen (deferred,
- * 2026-09-03 — see `deferred-work.md`); no backlog detector (8.2).
+ * **Story 5.2 wired the first enqueue and replaced the placeholder body.**
+ * `enqueueBroadcasts` writes one channel-addressed intent per broadcast-worthy
+ * event, and the drain composes through `adapters/discord/broadcast.ts` —
+ * which is why this module now imports an adapter at all. The import is
+ * one-directional and pure (`noticeFor`, `broadcastBodyFor`, the type list):
+ * `NotificationChannelPort` below is still declared here rather than imported,
+ * so the TRANSPORT stays anonymous and a second channel is still a second
+ * entry in `channels`. What this file gained is a notion of what a notice
+ * says, not a notion of how one is sent.
+ *
+ * Not this story: no mention text and no `@` of any Manager — `enqueueIntents`
+ * stays exported and unwired for Story 5.3; no mute or settings logic (5.4);
+ * no Commissioner-visible failure screen (deferred, 2026-09-03 — see
+ * `deferred-work.md`); no backlog detector (8.2).
  */
 
+import {
+	broadcastBodyFor,
+	isBroadcastEventType,
+	noticeFor
+} from '../adapters/discord/broadcast.ts';
+import type { BroadcastEvent, LeagueDirectory } from '../adapters/discord/broadcast.ts';
 import type { AppendedEvent } from '../core/types.ts';
 import { requireDatabaseClock, runTransactionalWrite } from '../shell/write.ts';
 import type {
@@ -82,6 +98,25 @@ export const NOTIFICATION_OUTBOX_TABLE = 'notification_outbox';
  */
 export const DISCORD_CHANNEL = 'discord';
 
+/**
+ * The `recipient` of a BROADCAST intent: the league channel itself, not a
+ * person (Story 5.2).
+ *
+ * **A sentinel rather than a nullable column.** `recipient` is `not null`,
+ * carries a non-blank check, and sits in the unique key
+ * (`20260903000000_notification_outbox.sql`) — so a broadcast needs no
+ * migration, the idempotency key stays declarative, and Story 5.3's
+ * per-Manager rows for the SAME event coexist with this one instead of
+ * colliding with it.
+ *
+ * `#channel` specifically, because it can never collide with a Discord
+ * snowflake: those are 64-bit integers serialised as digits, and this is
+ * neither. It is NEVER a mention — `composeBatch` filters it out of
+ * `recipients` before the payload is built, or `allowed_mentions.users` would
+ * carry a non-snowflake and the message would render a literal `<@#channel>`.
+ */
+export const BROADCAST_RECIPIENT = '#channel';
+
 /**
  * The dispatcher's own event type. Not declared in `core/types.ts` and not
  * folded by any reducer: it is a record OF an effect, not an auction fact, and
@@ -162,6 +197,31 @@ export type OutboxIntent = {
 	readonly recipient: string;
 	/** The `event_type` of the event this notice is about. */
 	readonly eventType: string;
+	/**
+	 * That event's `payload`, verbatim and unnarrowed (Story 5.2).
+	 *
+	 * `unknown` for `AppendedEvent.payload`'s reason: the log is insert-only, a
+	 * historical row cannot be corrected in place, and the composer narrows it
+	 * itself rather than trusting a cast made by the code that read the row.
+	 * Without this the drain could not say what an event MEANT — which is why
+	 * 5.1 could only ship a placeholder body.
+	 */
+	readonly payload: unknown;
+	/** The acting Manager's id, or `null` for a system event. */
+	readonly managerId: string | null;
+	/** The event's own `occurred_at`, ISO-8601. Never read as "now". */
+	readonly occurredAt: string;
+	/**
+	 * The Player's name, left-joined off the payload's `fantraxPlayerId`.
+	 *
+	 * `BidPlacedPayload` carries no `playerName` and adding one would mean
+	 * editing `core/rules/bidding.ts` — which this story's boundaries put
+	 * behind an ask. The reference join resolves it instead:
+	 * `free_agent_players.player_name` is stable for the whole Auction, since a
+	 * close writes neither that table nor `teams`. `null` for an event that
+	 * names no Player at all, which is every phase event.
+	 */
+	readonly playerName: string | null;
 };
 
 /** Every Manager of one Team, in a total order. */
@@ -248,6 +308,45 @@ export const enqueueIntents: EnqueueFn = async (
 	}
 };
 
+/**
+ * Story 5.2's enqueue: ONE intent per broadcast-worthy event, addressed to the
+ * league channel.
+ *
+ * **Not `enqueueIntents`, and deliberately not built on it.** That one is
+ * Manager-shaped — it fans out per Manager of the event's Team and skips a null
+ * `team_id` entirely. A broadcast is neither: it is one row keyed on the event
+ * TYPE, addressed to `BROADCAST_RECIPIENT`, and `ContractAssignmentOpened`
+ * carries a null `team_id` precisely because nobody acted. Reusing the
+ * Manager-shaped enqueue would drop the phase events and duplicate the rest.
+ *
+ * **Membership of `BROADCAST_EVENT_TYPES` is the whole rule**, and it lives in
+ * `adapters/discord/broadcast.ts` beside the copy — because deciding which
+ * events deserve a notice and deciding what each one says is one decision, and
+ * splitting it across two modules is how a type gets an intent and no sentence.
+ *
+ * `created_at` is the event's own `occurredAt`: the transaction's single clock
+ * read (AD-3), never a second `now()`.
+ *
+ * Nothing here composes anything. Composition happens in the drain, in another
+ * process, at another time — a throw in here would roll back the auction
+ * transaction, and "a Discord outage costs a notification and never a bid" has
+ * to hold for a copy bug too.
+ */
+export const enqueueBroadcasts: EnqueueFn = async (
+	client: TransactionalClient,
+	appended: readonly AppendedEvent[]
+): Promise<void> => {
+	for (const event of appended) {
+		if (!isBroadcastEventType(event.type)) continue;
+		await client.query(INSERT_INTENT_SQL, [
+			event.seq,
+			DISCORD_CHANNEL,
+			BROADCAST_RECIPIENT,
+			event.occurredAt
+		]);
+	}
+};
+
 // --- The pending set, re-derived -----------------------------------------
 
 /** One recorded attempt, read back off a `NotificationDispatched` event. */
@@ -405,11 +504,26 @@ export type OutboxPorts = {
 	readonly channels: Readonly<Record<string, NotificationChannelPort>>;
 	/** Override `PER_PASS_BUDGET`. Tests use it; the tick does not. */
 	readonly budget?: number;
+	/**
+	 * Override `DISCORD_MESSAGE_CEILING`. Tests use it; the tick does not.
+	 *
+	 * It exists for the same reason `budget` does: the real ceiling is 2000
+	 * characters, and reaching it honestly takes three 30-contender draws in
+	 * one pass. That setup would make the test about its own fixtures rather
+	 * than about the property — that an excluded intent gets no outcome and is
+	 * re-offered next pass.
+	 */
+	readonly ceiling?: number;
 };
 
 /** What one drain pass did. Returned for tests and for the tick's log line. */
 export type DrainSummary = {
-	/** Intents this pass attempted — never more than the budget. */
+	/**
+	 * Intents this pass actually POSTED — never more than the budget, and
+	 * fewer when the message ceiling excluded a notice (Story 5.2). An excluded
+	 * intent is never counted here and never given an outcome, so it is
+	 * re-derived as pending on the next pass.
+	 */
 	readonly attempted: number;
 	readonly delivered: number;
 	readonly rateLimited: number;
@@ -424,7 +538,8 @@ export type DrainSummary = {
 const CLOCK_SQL = 'select now() as now';
 
 /**
- * Every intent, joined to the type of the event it describes.
+ * Every intent, joined to the EVENT it describes — type, payload, actor,
+ * instant — and to the Player its payload names.
  *
  * The whole table, unpaginated, for the reason `server/event-log.ts`'s
  * `loadEventsViaClient` reads the whole log: this is a 30-team private league,
@@ -433,12 +548,32 @@ const CLOCK_SQL = 'select now() as now';
  * cursor is the thing "re-derives, never remembers" exists to avoid.
  */
 const PENDING_INTENTS_SQL = `
-	select o.event_seq, o.channel, o.recipient, e.event_type
+	select o.event_seq, o.channel, o.recipient,
+	       e.event_type, e.payload, e.manager_id, e.occurred_at,
+	       p.player_name
 	from ${NOTIFICATION_OUTBOX_TABLE} o
 	join auction_events e on e.seq = o.event_seq
+	left join free_agent_players p
+	       on p.fantrax_player_id = e.payload ->> 'fantraxPlayerId'
 	order by o.event_seq asc, o.channel asc, o.recipient asc
 `;
 
+/**
+ * Every Team's name, and every Manager's display name and Team.
+ *
+ * Two statements rather than one join, because they answer two questions and a
+ * join would repeat every Team name once per Manager. Read inside the same
+ * transaction as the intents (see `readDueIntents`), so one pass composes
+ * against ONE snapshot of the registry and a rename landing mid-pass cannot
+ * put two spellings of a Team in one message.
+ *
+ * `managers.display_name`, never `managers.discord_user_id`: the snowflake is
+ * an address, not a name, and rendering it would put a bare integer where
+ * `Lakers — Meakel` belongs.
+ */
+const TEAM_NAMES_SQL = 'select id, name from teams';
+const MANAGER_NAMES_SQL = 'select id, display_name, team_id from managers order by id asc';
+
 /**
  * Every recorded dispatch attempt. Filtered by `event_type` in SQL rather than
  * in TypeScript, because this is the one read that grows with the number of
@@ -477,7 +612,7 @@ export async function drainOutbox(
 	gateway: ConnectionGateway,
 	ports: OutboxPorts
 ): Promise<DrainSummary> {
-	const due = await readDueIntents(gateway, ports.budget);
+	const { due, directory } = await readDueIntents(gateway, ports.budget);
 	if (due.length === 0) {
 		return { attempted: 0, delivered: 0, rateLimited: 0, failed: 0, failures: [] };
 	}
@@ -496,16 +631,23 @@ export async function drainOutbox(
 	let rateLimited = 0;
 	let failed = 0;
 
+	let attempted = 0;
 	for (const [channel, batch] of [...batches.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
-		const result = await postBatch(ports.channels[channel], channel, batch);
-		for (const intent of batch) outcomes.push({ intent, result });
+		// Composed BEFORE the post, so the message ceiling decides which intents
+		// this pass is even attempting. The ones it excluded are never posted
+		// and never given an outcome, which leaves them pending for the next
+		// pass — see `broadcastBodyFor`.
+		const message = composeBatch(batch, directory, ports.ceiling);
+		const result = await postBatch(ports.channels[channel], channel, message);
+		for (const intent of message.posted) outcomes.push({ intent, result });
+		attempted += message.posted.length;
 
 		if (result.kind === 'delivered') {
-			delivered += batch.length;
+			delivered += message.posted.length;
 		} else if (result.kind === 'rate_limited') {
-			rateLimited += batch.length;
+			rateLimited += message.posted.length;
 		} else {
-			failed += batch.length;
+			failed += message.posted.length;
 			failures.push(`${channel}: ${result.detail}`);
 		}
 	}
@@ -517,12 +659,12 @@ export async function drainOutbox(
 
 	if (failures.length > 0) {
 		throw new Error(
-			`the outbox drain could not deliver ${failed} of ${due.length} pending notice(s); ` +
+			`the outbox drain could not deliver ${failed} of ${attempted} attempted notice(s); ` +
 				`every attempt is recorded and will be retried: ${failures.join('; ')}`
 		);
 	}
 
-	return { attempted: due.length, delivered, rateLimited, failed, failures };
+	return { attempted, delivered, rateLimited, failed, failures };
 }
 
 /** One intent and the result of the batch it travelled in. */
@@ -554,7 +696,7 @@ const ROLLBACK_SQL = 'rollback';
 async function readDueIntents(
 	gateway: ConnectionGateway,
 	budget: number | undefined
-): Promise<readonly OutboxIntent[]> {
+): Promise<{ readonly due: readonly OutboxIntent[]; readonly directory: LeagueDirectory }> {
 	const client = await gateway.connect();
 	try {
 		await client.query(BEGIN_SQL);
@@ -567,8 +709,16 @@ async function readDueIntents(
 				await client.query(DISPATCH_ATTEMPTS_SQL, [NOTIFICATION_DISPATCHED_EVENT])
 			).rows.map(toDispatchAttempt);
 
+			// The league's names, in the SAME transaction and for the same
+			// reason the other three reads are in it: composition must see one
+			// consistent registry, not one snapshot per statement.
+			const directory = toLeagueDirectory(
+				(await client.query(TEAM_NAMES_SQL)).rows,
+				(await client.query(MANAGER_NAMES_SQL)).rows
+			);
+
 			await client.query(COMMIT_SQL);
-			return duePendingIntents({ intents, attempts, now, budget });
+			return { due: duePendingIntents({ intents, attempts, now, budget }), directory };
 		} catch (error) {
 			// Defensively wrapped, `shell/write.ts`'s pattern: the original read
 			// failure is what the caller needs to see, never a second error from
@@ -597,10 +747,53 @@ function toOutboxIntent(row: QueryResultRow): OutboxIntent {
 		eventSeq: String(row['event_seq']),
 		channel: String(row['channel']),
 		recipient: String(row['recipient']),
-		eventType: String(row['event_type'])
+		eventType: String(row['event_type']),
+		payload: row['payload'],
+		managerId: row['manager_id'] === null || row['manager_id'] === undefined
+			? null
+			: String(row['manager_id']),
+		// `timestamptz` arrives as a `Date` through `pg` and may arrive as text
+		// through another driver — `toDispatchAttempt`'s idiom, restated.
+		occurredAt:
+			row['occurred_at'] instanceof Date
+				? row['occurred_at'].toISOString()
+				: String(row['occurred_at'] ?? ''),
+		playerName:
+			typeof row['player_name'] === 'string' && row['player_name'].trim() !== ''
+				? row['player_name']
+				: null
 	};
 }
 
+/** The two registry reads, folded into what the composer takes. */
+function toLeagueDirectory(
+	teamRows: readonly QueryResultRow[],
+	managerRows: readonly QueryResultRow[]
+): LeagueDirectory {
+	const teamNames = new Map<string, string>();
+	for (const row of teamRows) {
+		teamNames.set(String(row['id']), String(row['name']));
+	}
+
+	const managerNames = new Map<string, string>();
+	const managersOfTeam = new Map<string, string[]>();
+	for (const row of managerRows) {
+		const managerId = String(row['id']);
+		managerNames.set(managerId, String(row['display_name']));
+		// A Manager with no Team yet is a real, supported state (a nullable
+		// `managers.team_id`), not an error — they simply appear in no Team's
+		// list.
+		const teamId = row['team_id'];
+		if (teamId === null || teamId === undefined) continue;
+		const key = String(teamId);
+		const bucket = managersOfTeam.get(key);
+		if (bucket === undefined) managersOfTeam.set(key, [managerId]);
+		else bucket.push(managerId);
+	}
+
+	return { teamNames, managerNames, managersOfTeam };
+}
+
 /** One `NotificationDispatched` row, read back as an attempt. */
 function toDispatchAttempt(row: QueryResultRow): DispatchAttempt {
 	const payload = readPayload(row['payload']);
@@ -652,16 +845,13 @@ function readPayload(value: unknown): Record<string, unknown> {
 async function postBatch(
 	port: NotificationChannelPort | undefined,
 	channel: string,
-	batch: readonly OutboxIntent[]
+	message: ComposedBatch
 ): Promise<ChannelPostResult> {
 	if (port === undefined) {
 		return { kind: 'failed', detail: `no port is registered for the "${channel}" channel` };
 	}
 	try {
-		return await port.post({
-			body: genericBodyFor(batch),
-			recipients: [...new Set(batch.map((intent) => intent.recipient))]
-		});
+		return await port.post({ body: message.body, recipients: message.recipients });
 	} catch (error) {
 		return {
 			kind: 'failed',
@@ -670,27 +860,86 @@ async function postBatch(
 	}
 }
 
+/** One channel's batch, composed: what to send, to whom, and for which intents. */
+type ComposedBatch = {
+	readonly body: string;
+	readonly recipients: readonly string[];
+	/**
+	 * The intents this message actually carries — never more than `batch`, and
+	 * fewer when the ceiling excluded a notice. Only these get an outcome.
+	 */
+	readonly posted: readonly OutboxIntent[];
+};
+
 /**
- * The GENERIC payload this story ships, and deliberately nothing more.
+ * Turn one channel's due intents into one message (Story 5.2).
+ *
+ * **Grouped by event, not by intent.** A single event can owe several intents
+ * — the broadcast row this story writes, and 5.3's per-Manager rows for the
+ * same event — and the message should state what happened ONCE. So the batch is
+ * folded into groups keyed on `event_seq`, in the order the reader produced,
+ * and each group composes to exactly one notice.
  *
- * It names the event types and their `seq`s and says nothing about what any of
- * them MEANS — there is no event-type-to-copy mapping here, no amount, no
- * Player name and no Team. Story 5.2 and 5.3 own what a notice says; this
- * sentence exists so the mechanism can be exercised end to end before they land,
- * and it is the first thing those stories replace.
+ * **The ceiling decides membership, and membership decides outcomes.** Whole
+ * notices go in until the next one would not fit; the intents behind the
+ * excluded ones are simply not returned, so they get no outcome event and are
+ * re-derived as pending next pass. Never dropped, never split mid-notice
+ * (AD-17).
  *
- * De-duplicated by `seq`: a co-managed Team contributes two intents for one
- * event, and the message should name that event once.
+ * **`BROADCAST_RECIPIENT` is filtered out of `recipients` here**, which is the
+ * one place it could otherwise leak: `recipients` becomes both the `<@id>`
+ * prefix and `allowed_mentions.users` in `adapters/discord/webhook.ts`, and a
+ * sentinel in either would render a literal `<@#channel>` and hand Discord a
+ * non-snowflake. Story 5.2 mentions nobody, so today this leaves the list
+ * empty for a pure-broadcast batch.
  */
-export function genericBodyFor(batch: readonly OutboxIntent[]): string {
-	const seen = new Set<string>();
-	const notices: string[] = [];
+function composeBatch(
+	batch: readonly OutboxIntent[],
+	directory: LeagueDirectory,
+	ceiling?: number
+): ComposedBatch {
+	const groups: Array<{ readonly intents: OutboxIntent[] }> = [];
+	const bySeq = new Map<string, { readonly intents: OutboxIntent[] }>();
 	for (const intent of batch) {
-		if (seen.has(intent.eventSeq)) continue;
-		seen.add(intent.eventSeq);
-		notices.push(`${intent.eventType} (event #${intent.eventSeq})`);
+		const existing = bySeq.get(intent.eventSeq);
+		if (existing === undefined) {
+			const group = { intents: [intent] };
+			bySeq.set(intent.eventSeq, group);
+			groups.push(group);
+		} else {
+			existing.intents.push(intent);
+		}
 	}
-	return `BBSL auction update — ${notices.join(', ')}.`;
+
+	const notices = groups.map((group) => {
+		// Every intent in a group describes the SAME event, so any of them
+		// carries the same joined columns. The first is as good as any.
+		const [first] = group.intents;
+		return first === undefined ? '' : noticeFor(broadcastEventOf(first), directory);
+	});
+
+	const { body, included } = broadcastBodyFor(notices, ceiling);
+	const posted = groups.slice(0, included).flatMap((group) => group.intents);
+
+	return {
+		body,
+		recipients: [...new Set(posted.map((intent) => intent.recipient))].filter(
+			(recipient) => recipient !== BROADCAST_RECIPIENT
+		),
+		posted
+	};
+}
+
+/** One intent's joined event columns, as the pure composer takes them. */
+function broadcastEventOf(intent: OutboxIntent): BroadcastEvent {
+	return {
+		seq: intent.eventSeq,
+		eventType: intent.eventType,
+		payload: intent.payload,
+		managerId: intent.managerId,
+		occurredAt: intent.occurredAt,
+		playerName: intent.playerName
+	};
 }
 
 /**
diff --git a/src/lib/server/phase-end.ts b/src/lib/server/phase-end.ts
index bcae047..852f9d0 100644
--- a/src/lib/server/phase-end.ts
+++ b/src/lib/server/phase-end.ts
@@ -60,6 +60,7 @@ import { runTransactionalWrite } from '../shell/write.ts';
 import type { ConnectionGateway, TransactionalClient } from '../shell/write.ts';
 import { loadEventsViaClient } from './event-log.ts';
 import { releaseNomination } from './nomination.ts';
+import { enqueueBroadcasts } from './outbox.ts';
 
 /**
  * What one evaluation did, as the tick has to report it.
@@ -158,6 +159,15 @@ export async function loadPhaseEndState(client: TransactionalClient): Promise<Ph
 export async function evaluateLeagueClock(gateway: ConnectionGateway): Promise<PhaseEndOutcome> {
 	const outcome = await runTransactionalWrite<PhaseEndState>({
 		gateway,
+		// Story 5.2 broadcasts this write: `ContractAssignmentOpened` ends the
+		// phase for everyone. Note it carries a NULL `team_id` — a broadcast is
+		// not keyed on a Team, which is exactly why `enqueueIntents` (which skips
+		// a null Team) could not have been reused here.
+		// `enqueueBroadcasts` files one channel-addressed intent per event in the
+		// broadcast set. `eligibility.ts` and `import-promotion.ts` pass no
+		// `enqueue` at all: Commissioner bookkeeping is not league news, and a
+		// notice for it would be channel noise nothing can mute.
+		enqueue: enqueueBroadcasts,
 		load: (client) => loadPhaseEndState(client),
 		projections: [releaseNomination],
 		decide: ({ state, now }) => {
diff --git a/tests/adapters/discord-broadcast.test.ts b/tests/adapters/discord-broadcast.test.ts
new file mode 100644
index 0000000..9972192
--- /dev/null
+++ b/tests/adapters/discord-broadcast.test.ts
@@ -0,0 +1,536 @@
+/**
+ * What a broadcast notice SAYS (Story 5.2, AD-18).
+ *
+ * Every case here is a literal payload and a hand-built directory against a
+ * pure function — no database, no transport, no clock. That is the whole point
+ * of composition being pure: the copy the league reads is decided by a function
+ * whose entire input is visible in the test that asserts it.
+ *
+ * The suite that covers WHICH intents are attempted, in what order and how
+ * often is `tests/server/outbox.test.ts`. This one covers only the words.
+ */
+
+import { describe, expect, it } from 'vitest';
+
+import {
+	BROADCAST_EVENT_TYPES,
+	DISCORD_MESSAGE_CEILING,
+	broadcastBodyFor,
+	discordTimestamp,
+	isBroadcastEventType,
+	noticeFor
+} from '../../src/lib/adapters/discord/broadcast.ts';
+import type {
+	BroadcastEvent,
+	LeagueDirectory
+} from '../../src/lib/adapters/discord/broadcast.ts';
+
+const LAKERS = 't-lakers';
+const BULLS = 't-bulls';
+const MEAKEL = 'm-meakel';
+const ARI = 'm-ari';
+const DANA = 'm-dana';
+
+const PLAYER = 'p-davis';
+const CLOSES_AT = '2026-09-04T02:30:00.000Z';
+const CLOSES_AT_MARKUP = `<t:${String(Math.floor(Date.parse(CLOSES_AT) / 1000))}:f>`;
+
+/** Two Teams, three Managers, one of the Teams co-managed. */
+const DIRECTORY: LeagueDirectory = {
+	teamNames: new Map([
+		[LAKERS, 'Lakers'],
+		[BULLS, 'Bulls']
+	]),
+	managerNames: new Map([
+		[MEAKEL, 'Meakel'],
+		[ARI, 'Ari'],
+		[DANA, 'Dana']
+	]),
+	managersOfTeam: new Map([
+		[LAKERS, [MEAKEL]],
+		[BULLS, [ARI]]
+	])
+};
+
+function event(
+	eventType: string,
+	payload: unknown,
+	overrides: Partial<BroadcastEvent> = {}
+): BroadcastEvent {
+	return {
+		seq: '1',
+		eventType,
+		payload,
+		managerId: MEAKEL,
+		occurredAt: CLOSES_AT,
+		playerName: 'Anthony Davis',
+		...overrides
+	};
+}
+
+// --- the broadcast set ----------------------------------------------------
+
+describe('BROADCAST_EVENT_TYPES — six types, and nothing else', () => {
+	it('names exactly the six the story enumerates', () => {
+		expect([...BROADCAST_EVENT_TYPES]).toEqual([
+			'NominationPlaced',
+			'BidPlaced',
+			'AuctionClosed',
+			'ContentionDrawn',
+			'AuctionOpened',
+			'ContractAssignmentOpened'
+		]);
+	});
+
+	it('excludes the quiet outcomes, the bookkeeping and its own dispatch record', () => {
+		for (const excluded of [
+			'AuctionTerminated',
+			'ContentionDissolved',
+			'MinorLeagueEligibilityChanged',
+			'RosterImportPromoted',
+			'NotificationDispatched'
+		]) {
+			expect(isBroadcastEventType(excluded)).toBe(false);
+		}
+	});
+});
+
+// --- one case per event type ----------------------------------------------
+
+describe('noticeFor — one line per event type', () => {
+	it('NominationPlaced names the Team, its Manager and the Player', () => {
+		expect(
+			noticeFor(
+				event('NominationPlaced', {
+					fantraxPlayerId: PLAYER,
+					playerName: 'Anthony Davis',
+					teamId: LAKERS,
+					teamName: 'Lakers',
+					managerId: MEAKEL
+				}),
+				DIRECTORY
+			)
+		).toBe('Lakers — Meakel nominated Anthony Davis.');
+	});
+
+	it('BidPlaced names the amount and the new close time, in the reader’s timezone', () => {
+		// The matrix's "A Bid is placed" row, and the story's first golden
+		// example. The Player name comes off the JOIN, not the payload —
+		// `BidPlacedPayload` has none, and adding one would have meant editing
+		// `core/rules/bidding.ts`.
+		expect(
+			noticeFor(
+				event('BidPlaced', {
+					fantraxPlayerId: PLAYER,
+					teamId: LAKERS,
+					teamName: 'Lakers',
+					managerId: MEAKEL,
+					amount: 14_500_000,
+					closesAt: CLOSES_AT
+				}),
+				DIRECTORY
+			)
+		).toBe(`Lakers — Meakel bid $14.5M on Anthony Davis. Closes ${CLOSES_AT_MARKUP}.`);
+	});
+
+	it('AuctionClosed names the winner and the price', () => {
+		expect(
+			noticeFor(
+				event('AuctionClosed', {
+					fantraxPlayerId: PLAYER,
+					playerName: 'Anthony Davis',
+					teamId: LAKERS,
+					teamName: 'Lakers',
+					managerId: MEAKEL,
+					winningAmount: 14_500_000,
+					capHit: 14_500_000,
+					contractYears: null,
+					closedAt: CLOSES_AT
+				}),
+				DIRECTORY
+			)
+		).toBe('Anthony Davis to Lakers — Meakel for $14.5M.');
+	});
+
+	it('ContentionDrawn spells out every contender, in payload order, plus the seed', () => {
+		// AD-14 makes the contender ORDER an input to the winner, so the list
+		// is a fact to be reproduced rather than a presentation choice. Every
+		// Team is spelled out — a three-letter abbreviation would mean an NBA
+		// team and nothing else.
+		expect(
+			noticeFor(
+				event('ContentionDrawn', {
+					fantraxPlayerId: PLAYER,
+					seed: '9f3c8a1d',
+					seedHash: 'h',
+					contenders: [LAKERS, BULLS],
+					selectedIndex: 0,
+					winningTeamId: LAKERS,
+					winningTeamName: 'Lakers',
+					winningManagerId: MEAKEL,
+					drawnAt: CLOSES_AT
+				}),
+				DIRECTORY
+			)
+		).toBe(
+			'Anthony Davis drawn to Lakers — Meakel. ' +
+				'Contenders, in order: Lakers — Meakel, Bulls — Ari. Seed: 9f3c8a1d'
+		);
+	});
+
+	it('carries a real 32-byte seed IN FULL, so the commitment can be re-hashed', () => {
+		// The seed as `contention-seed.ts` actually generates it: 32 random
+		// bytes as hex, 64 characters. A Manager discharges Story 3.6's
+		// commit-reveal by hashing this exact string and comparing it to the
+		// `seedHash` published on the opening `BidPlaced`. A prefix hashes to
+		// nothing, so any truncation here silently makes the fairness premise
+		// unverifiable — which is precisely what this test exists to catch.
+		const seed = 'a'.repeat(64);
+
+		const notice = noticeFor(
+			event('ContentionDrawn', {
+				fantraxPlayerId: PLAYER,
+				seed,
+				seedHash: 'h',
+				contenders: [LAKERS, BULLS],
+				selectedIndex: 0,
+				winningTeamId: LAKERS,
+				winningTeamName: 'Lakers',
+				winningManagerId: MEAKEL,
+				drawnAt: CLOSES_AT
+			}),
+			DIRECTORY
+		);
+
+		expect(notice).toContain(`Seed: ${seed}`);
+		expect(notice?.includes('…')).toBe(false);
+	});
+
+	it('names a co-managed contender with BOTH its Managers', () => {
+		const coManaged: LeagueDirectory = {
+			...DIRECTORY,
+			managersOfTeam: new Map([
+				[LAKERS, [MEAKEL, DANA]],
+				[BULLS, [ARI]]
+			])
+		};
+		expect(
+			noticeFor(
+				event('ContentionDrawn', {
+					fantraxPlayerId: PLAYER,
+					seed: 'abcd',
+					contenders: [LAKERS],
+					winningTeamId: BULLS,
+					winningTeamName: 'Bulls',
+					winningManagerId: ARI,
+					drawnAt: CLOSES_AT
+				}),
+				coManaged
+			)
+		).toContain('Contenders, in order: Lakers — Meakel & Dana.');
+	});
+
+	it('AuctionOpened states the league it opened with', () => {
+		expect(
+			noticeFor(
+				event('AuctionOpened', {
+					teams: [
+						{ teamId: LAKERS, teamName: 'Lakers' },
+						{ teamId: BULLS, teamName: 'Bulls' }
+					],
+					minorLeagueEligibleCount: 12
+				}),
+				DIRECTORY
+			)
+		).toBe('The Auction Phase is open with 2 Teams and 12 Minor League eligible Players.');
+	});
+
+	it('ContractAssignmentOpened is keyed on no Team at all', () => {
+		// The matrix's "The phase ends" row: a broadcast is not keyed on a
+		// Team, unlike a mention, so a null actor pair composes fine.
+		expect(
+			noticeFor(
+				event(
+					'ContractAssignmentOpened',
+					{
+						expiredAt: CLOSES_AT,
+						evaluatedAt: CLOSES_AT,
+						terminatedPlayerIds: ['p-9', 'p-8']
+					},
+					{ managerId: null, playerName: null }
+				),
+				DIRECTORY
+			)
+		).toBe(
+			'The Auction Phase has ended and Contract Assignment is open. ' +
+				'2 nominated Players ended with no Bid.'
+		);
+	});
+
+	it('says so plainly when every nominated Player drew a Bid', () => {
+		expect(
+			noticeFor(
+				event(
+					'ContractAssignmentOpened',
+					{ expiredAt: CLOSES_AT, evaluatedAt: CLOSES_AT, terminatedPlayerIds: [] },
+					{ managerId: null, playerName: null }
+				),
+				DIRECTORY
+			)
+		).toBe(
+			'The Auction Phase has ended and Contract Assignment is open. ' +
+				'Every nominated Player drew a Bid.'
+		);
+	});
+});
+
+// --- degrading rather than throwing ---------------------------------------
+
+describe('noticeFor — a payload it cannot read degrades, and never throws', () => {
+	it('falls back to a plain factual line for a missing field', () => {
+		// The matrix's "A payload is unrecognised or malformed" row.
+		expect(
+			noticeFor(event('BidPlaced', { teamId: LAKERS, teamName: 'Lakers' }, { seq: '42' }), DIRECTORY)
+		).toBe('A BidPlaced was recorded (event #42).');
+	});
+
+	it('falls back for an amount off the money grid rather than letting formatMoney throw', () => {
+		// `formatMoney` raises a `RangeError` off the `MINIMUM_INCREMENT` grid,
+		// and an insert-only log can hold a payload that predates a rule.
+		expect(
+			noticeFor(
+				event('AuctionClosed', {
+					playerName: 'Anthony Davis',
+					teamId: LAKERS,
+					teamName: 'Lakers',
+					managerId: MEAKEL,
+					winningAmount: 14_500_001
+				}),
+				DIRECTORY
+			)
+		).toBe('A AuctionClosed was recorded (event #1).');
+	});
+
+	it('falls back for an unparseable close instant rather than rendering <t:NaN:f>', () => {
+		expect(
+			noticeFor(
+				event('BidPlaced', {
+					teamId: LAKERS,
+					teamName: 'Lakers',
+					managerId: MEAKEL,
+					amount: 14_500_000,
+					closesAt: 'not an instant'
+				}),
+				DIRECTORY
+			)
+		).toBe('A BidPlaced was recorded (event #1).');
+	});
+
+	it('falls back for a type it does not recognise, and for a payload that is not an object', () => {
+		expect(noticeFor(event('SomethingNew', { anything: true }), DIRECTORY)).toBe(
+			'A SomethingNew was recorded (event #1).'
+		);
+		expect(noticeFor(event('BidPlaced', 'not an object'), DIRECTORY)).toBe(
+			'A BidPlaced was recorded (event #1).'
+		);
+		expect(noticeFor(event('BidPlaced', null), DIRECTORY)).toBe(
+			'A BidPlaced was recorded (event #1).'
+		);
+	});
+
+	it('names a Team the directory has never heard of by its id, so the draw still checks out', () => {
+		// A contender list shorter than the one the draw ran over would be a
+		// list nobody could verify the reduction against.
+		expect(
+			noticeFor(
+				event('ContentionDrawn', {
+					seed: 'abcd',
+					contenders: [LAKERS, 't-unknown'],
+					winningTeamId: LAKERS,
+					winningTeamName: 'Lakers',
+					winningManagerId: MEAKEL
+				}),
+				DIRECTORY
+			)
+		).toContain('Contenders, in order: Lakers — Meakel, t-unknown.');
+	});
+
+	it('names the Team alone when the acting Manager cannot be resolved', () => {
+		expect(
+			noticeFor(
+				event('NominationPlaced', {
+					playerName: 'Anthony Davis',
+					teamId: LAKERS,
+					teamName: 'Lakers',
+					managerId: 'm-nobody'
+				}),
+				DIRECTORY
+			)
+		).toBe('Lakers nominated Anthony Davis.');
+	});
+});
+
+// --- the timestamp --------------------------------------------------------
+
+describe('discordTimestamp — every reader sees their own timezone', () => {
+	it('renders <t:unix:f> in whole seconds', () => {
+		expect(discordTimestamp('1970-01-01T00:00:10.000Z')).toBe('<t:10:f>');
+	});
+
+	it('answers null for an instant it cannot parse', () => {
+		expect(discordTimestamp('yesterday')).toBeNull();
+	});
+});
+
+// --- the message ceiling --------------------------------------------------
+
+describe('broadcastBodyFor — whole notices, up to the ceiling', () => {
+	it('joins every notice one per line when they all fit', () => {
+		expect(broadcastBodyFor(['one.', 'two.'])).toEqual({ body: 'one.\ntwo.', included: 2 });
+	});
+
+	it('posts whole notices up to the ceiling and leaves the remainder out', () => {
+		// The matrix's "A batch would exceed the message ceiling" row. The
+		// excluded notice is NOT posted, gets no outcome, and is therefore
+		// still pending — never dropped, never split mid-notice.
+		const notices = ['aaaa', 'bbbb', 'cccc'];
+		// Two notices plus one separator is 9 characters; three would be 14.
+		expect(broadcastBodyFor(notices, 9)).toEqual({ body: 'aaaa\nbbbb', included: 2 });
+	});
+
+	it('truncates the ONE notice that alone exceeds the ceiling, rather than stalling forever', () => {
+		// The matrix's "One notice alone exceeds the ceiling" row. It cannot be
+		// split and it cannot be dropped: an intent that can never be posted
+		// would stall the outbox for good.
+		const huge = 'x'.repeat(50);
+		const { body, included } = broadcastBodyFor([huge, 'next.'], 10);
+		expect(included).toBe(1);
+		expect(body).toBe('xxxxxxxxx…');
+		expect(body.length).toBe(10);
+	});
+
+	it('keeps a real 30-contender draw under Discord’s own limit', () => {
+		const contenders = Array.from({ length: 30 }, (_unused, index) => `t-${String(index)}`);
+		const notice = noticeFor(
+			event('ContentionDrawn', {
+				seed: '9f3c8a1d',
+				contenders,
+				winningTeamId: LAKERS,
+				winningTeamName: 'Lakers',
+				winningManagerId: MEAKEL
+			}),
+			DIRECTORY
+		);
+		const { body, included } = broadcastBodyFor([notice]);
+		expect(included).toBe(1);
+		expect(body.length).toBeLessThanOrEqual(DISCORD_MESSAGE_CEILING);
+		expect(body).toBe(notice);
+	});
+
+	it('answers an empty body for an empty batch', () => {
+		expect(broadcastBodyFor([])).toEqual({ body: '', included: 0 });
+	});
+});
+
+// --- the copy rules -------------------------------------------------------
+
+describe('the composed copy carries no urgency and no exclamation', () => {
+	/** Every sample this suite composes, in one place. */
+	const samples: readonly string[] = [
+		noticeFor(
+			event('NominationPlaced', {
+				playerName: 'Anthony Davis',
+				teamId: LAKERS,
+				teamName: 'Lakers',
+				managerId: MEAKEL
+			}),
+			DIRECTORY
+		),
+		noticeFor(
+			event('BidPlaced', {
+				teamId: LAKERS,
+				teamName: 'Lakers',
+				managerId: MEAKEL,
+				amount: 14_500_000,
+				closesAt: CLOSES_AT
+			}),
+			DIRECTORY
+		),
+		noticeFor(
+			event('AuctionClosed', {
+				playerName: 'Anthony Davis',
+				teamId: LAKERS,
+				teamName: 'Lakers',
+				managerId: MEAKEL,
+				winningAmount: 14_500_000
+			}),
+			DIRECTORY
+		),
+		noticeFor(
+			event('ContentionDrawn', {
+				seed: '9f3c8a1d',
+				contenders: [LAKERS, BULLS],
+				winningTeamId: LAKERS,
+				winningTeamName: 'Lakers',
+				winningManagerId: MEAKEL
+			}),
+			DIRECTORY
+		),
+		noticeFor(
+			event('AuctionOpened', { teams: [{ teamId: LAKERS }], minorLeagueEligibleCount: 1 }),
+			DIRECTORY
+		),
+		noticeFor(
+			event('ContractAssignmentOpened', { terminatedPlayerIds: ['p-9'] }, { managerId: null }),
+			DIRECTORY
+		),
+		noticeFor(event('SomethingNew', {}), DIRECTORY)
+	];
+
+	it('composes a real sentence for every sample, so the assertions below mean something', () => {
+		expect(samples).toHaveLength(7);
+		for (const sample of samples) {
+			expect(sample.length).toBeGreaterThan(0);
+			expect(sample).not.toContain('undefined');
+			expect(sample).not.toContain('NaN');
+		}
+	});
+
+	it('contains no exclamation mark anywhere', () => {
+		for (const sample of samples) expect(sample).not.toContain('!');
+	});
+
+	it('contains no urgency framing, no countdown pressure and no suggested action', () => {
+		// The story's **Never** list, asserted rather than merely intended.
+		const forbidden = [
+			'hurry',
+			'soon',
+			'last chance',
+			'ending',
+			'ends soon',
+			'act now',
+			'don’t miss',
+			"don't miss",
+			'final call',
+			'quick',
+			'urgent',
+			'now is'
+		];
+		for (const sample of samples) {
+			const lowered = sample.toLowerCase();
+			for (const word of forbidden) expect(lowered).not.toContain(word);
+		}
+	});
+
+	it('never abbreviates a fantasy Team to three capitals', () => {
+		// The glossary rule: a three-letter capitalised abbreviation always and
+		// only means a player's real-life NBA team.
+		for (const sample of samples) expect(sample).not.toMatch(/\b[A-Z]{3}\b/);
+	});
+
+	it('mentions nobody: no `<@` appears in any composed line', () => {
+		// 5.2 is addressed to the channel. The mention is 5.3's, and it arrives
+		// as a recipient beside this body rather than as a word inside it.
+		for (const sample of samples) expect(sample).not.toContain('<@');
+	});
+});
diff --git a/tests/server/auction-open.test.ts b/tests/server/auction-open.test.ts
index 9a8fbde..8da78f8 100644
--- a/tests/server/auction-open.test.ts
+++ b/tests/server/auction-open.test.ts
@@ -103,6 +103,16 @@ function fakeGateway(options: {
 				appendedEvents.length = 0;
 				return { rows: [] };
 			}
+			// Story 5.2 registered `enqueueBroadcasts` on this write, so the
+			// appending transaction now also files one channel-addressed
+			// delivery intent per broadcast-worthy event (AD-17). It is
+			// recorded in `statements` like every other statement and asserted
+			// on in `tests/server/outbox.test.ts`, which owns the outbox; here
+			// it only has to be a statement the fake recognises rather than one
+			// it rejects.
+			if (/^insert into notification_outbox/i.test(sql)) {
+				return { rows: [] };
+			}
 			throw new Error(`unexpected statement: ${sql}`);
 		},
 		release() {
diff --git a/tests/server/bidding.test.ts b/tests/server/bidding.test.ts
index c2f1490..d028ca5 100644
--- a/tests/server/bidding.test.ts
+++ b/tests/server/bidding.test.ts
@@ -212,6 +212,16 @@ function fakeGateway(
 				seedRows = [];
 				return { rows: [] };
 			}
+			// Story 5.2 registered `enqueueBroadcasts` on this write, so the
+			// appending transaction now also files one channel-addressed
+			// delivery intent per broadcast-worthy event (AD-17). It is
+			// recorded in `statements` like every other statement and asserted
+			// on in `tests/server/outbox.test.ts`, which owns the outbox; here
+			// it only has to be a statement the fake recognises rather than one
+			// it rejects.
+			if (/^insert into notification_outbox/i.test(sql)) {
+				return { rows: [] };
+			}
 			throw new Error(`unexpected statement: ${sql}`);
 		},
 		release() {
diff --git a/tests/server/close.test.ts b/tests/server/close.test.ts
index ac5d106..41914b4 100644
--- a/tests/server/close.test.ts
+++ b/tests/server/close.test.ts
@@ -140,6 +140,16 @@ function fakeGateway(
 				releasedClaims = [];
 				return { rows: [] };
 			}
+			// Story 5.2 registered `enqueueBroadcasts` on this write, so the
+			// appending transaction now also files one channel-addressed
+			// delivery intent per broadcast-worthy event (AD-17). It is
+			// recorded in `statements` like every other statement and asserted
+			// on in `tests/server/outbox.test.ts`, which owns the outbox; here
+			// it only has to be a statement the fake recognises rather than one
+			// it rejects.
+			if (/^insert into notification_outbox/i.test(sql)) {
+				return { rows: [] };
+			}
 			throw new Error(`unexpected statement: ${sql}`);
 		},
 		release() {
diff --git a/tests/server/nomination.test.ts b/tests/server/nomination.test.ts
index 5f0e94a..7d5f53d 100644
--- a/tests/server/nomination.test.ts
+++ b/tests/server/nomination.test.ts
@@ -209,6 +209,16 @@ function fakeGateway(options: {
 				appendedEvents.length = 0;
 				return { rows: [] };
 			}
+			// Story 5.2 registered `enqueueBroadcasts` on this write, so the
+			// appending transaction now also files one channel-addressed
+			// delivery intent per broadcast-worthy event (AD-17). It is
+			// recorded in `statements` like every other statement and asserted
+			// on in `tests/server/outbox.test.ts`, which owns the outbox; here
+			// it only has to be a statement the fake recognises rather than one
+			// it rejects.
+			if (/^insert into notification_outbox/i.test(sql)) {
+				return { rows: [] };
+			}
 			throw new Error(`unexpected statement: ${sql}`);
 		},
 		release() {
diff --git a/tests/server/outbox.test.ts b/tests/server/outbox.test.ts
index 53e07af..1046a18 100644
--- a/tests/server/outbox.test.ts
+++ b/tests/server/outbox.test.ts
@@ -22,6 +22,7 @@
 import { describe, expect, it } from 'vitest';
 
 import {
+	BROADCAST_RECIPIENT,
 	DELIVERY_DELIVERED,
 	DELIVERY_FAILED,
 	DELIVERY_RATE_LIMITED,
@@ -32,18 +33,20 @@ import {
 	backoffMsFor,
 	drainOutbox,
 	duePendingIntents,
-	enqueueIntents,
-	genericBodyFor
+	enqueueBroadcasts,
+	enqueueIntents
 } from '../../src/lib/server/outbox.ts';
 import type {
 	ChannelPostResult,
 	NotificationChannelPort,
 	OutboxIntent
 } from '../../src/lib/server/outbox.ts';
+import { payloadFor } from '../../src/lib/adapters/discord/webhook.ts';
 import { runTransactionalWrite } from '../../src/lib/shell/write.ts';
 import type {
 	ConnectionGateway,
 	Decision,
+	EnqueueFn,
 	QueryResultRow,
 	TransactionalClient
 } from '../../src/lib/shell/write.ts';
@@ -63,12 +66,28 @@ type OutboxRow = {
 	createdAt: string;
 };
 
-/** One `managers` row, as much of it as `enqueueIntents` reads. */
-type ManagerRow = { teamId: string | null; discordUserId: string };
+/**
+ * One `managers` row. `enqueueIntents` reads the snowflake; Story 5.2's
+ * directory read reads the id, the display name and the Team.
+ */
+type ManagerRow = {
+	teamId: string | null;
+	discordUserId: string;
+	id?: string;
+	displayName?: string;
+};
+
+/** One `teams` row, as much of it as the directory read takes. */
+type TeamRow = { id: string; name: string };
+
+/** One `free_agent_players` row — the join that gives `BidPlaced` a name. */
+type PlayerRow = { fantraxPlayerId: string; playerName: string };
 
 function fakeGateway(
 	options: {
 		managers?: readonly ManagerRow[];
+		teams?: readonly TeamRow[];
+		players?: readonly PlayerRow[];
 		now?: Date;
 		/** Throw on the Nth outcome INSERT (1-based), as a lost connection would. */
 		failOutcomeInsert?: number;
@@ -83,6 +102,8 @@ function fakeGateway(
 } {
 	const statements: string[] = [];
 	const managers = options.managers ?? [];
+	const teams = options.teams ?? [];
+	const players = options.players ?? [];
 	// Committed state.
 	const events: QueryResultRow[] = [];
 	const outbox: OutboxRow[] = [];
@@ -172,12 +193,26 @@ function fakeGateway(
 					.flatMap((intent) => {
 						const event = events.find((candidate) => String(candidate['seq']) === intent.eventSeq);
 						if (event === undefined) return [];
+						// The left join on `payload ->> 'fantraxPlayerId'`, as the
+						// real statement spells it.
+						const payload = event['payload'];
+						const fantraxPlayerId =
+							typeof payload === 'object' && payload !== null
+								? (payload as Record<string, unknown>)['fantraxPlayerId']
+								: undefined;
+						const player = players.find(
+							(candidate) => candidate.fantraxPlayerId === fantraxPlayerId
+						);
 						return [
 							{
 								event_seq: intent.eventSeq,
 								channel: intent.channel,
 								recipient: intent.recipient,
-								event_type: event['event_type']
+								event_type: event['event_type'],
+								payload: event['payload'],
+								manager_id: event['manager_id'],
+								occurred_at: event['occurred_at'],
+								player_name: player?.playerName ?? null
 							}
 						];
 					})
@@ -188,6 +223,18 @@ function fakeGateway(
 					});
 				return { rows };
 			}
+			if (/^select id, name from teams$/i.test(sql)) {
+				return { rows: teams.map((team) => ({ id: team.id, name: team.name })) };
+			}
+			if (/^select id, display_name, team_id from managers/i.test(sql)) {
+				return {
+					rows: managers.map((manager) => ({
+						id: manager.id ?? manager.discordUserId,
+						display_name: manager.displayName ?? manager.discordUserId,
+						team_id: manager.teamId
+					}))
+				};
+			}
 			if (/^select occurred_at, payload, delivery_outcome from auction_events/i.test(sql)) {
 				return {
 					rows: events
@@ -241,21 +288,67 @@ function fakeChannel(
 	return { port, posts };
 }
 
-/** One accepted write, appending `events` and enqueuing their intents. */
+/**
+ * One accepted write, appending `events` and enqueuing their intents.
+ *
+ * `enqueue` defaults to `enqueueIntents` — Story 5.1's Manager-shaped enqueue,
+ * which every mechanism suite below drives. Story 5.2's cases pass
+ * `enqueueBroadcasts` explicitly, and the eligibility case passes `undefined`
+ * to model a write that registers no enqueue at all.
+ */
 async function write(
 	gateway: ConnectionGateway,
 	events: readonly EventEnvelope[],
-	kind: 'accepted' | 'rejected' = 'accepted'
+	kind: 'accepted' | 'rejected' = 'accepted',
+	enqueue: EnqueueFn | undefined = enqueueIntents
 ): Promise<void> {
 	await runTransactionalWrite({
 		gateway,
 		load: async () => ({}),
 		decide: (): Decision =>
 			kind === 'accepted' ? { kind: 'accepted', events } : { kind: 'rejected', reason: 'no' },
-		enqueue: enqueueIntents
+		enqueue
 	});
 }
 
+const PLAYER = 'p-1';
+const CLOSES_AT = '2026-09-04T02:30:00.000Z';
+/** Discord's own timestamp markup for `CLOSES_AT` — the reader's local time. */
+const CLOSES_AT_MARKUP = `<t:${String(Math.floor(Date.parse(CLOSES_AT) / 1000))}:f>`;
+
+/** A real `BidPlaced`, payload and all — Story 5.2 composes from the payload. */
+function bidPlaced(): EventEnvelope {
+	return {
+		type: 'BidPlaced',
+		payload: {
+			fantraxPlayerId: PLAYER,
+			teamId: TEAM,
+			teamName: 'Lakers',
+			managerId: MANAGER,
+			amount: 14_500_000,
+			closesAt: CLOSES_AT
+		},
+		managerId: MANAGER,
+		teamId: TEAM
+	};
+}
+
+/** A real `NominationPlaced` — a second broadcast whose copy differs from the Bid's. */
+function nominationPlaced(): EventEnvelope {
+	return {
+		type: 'NominationPlaced',
+		payload: {
+			fantraxPlayerId: PLAYER,
+			playerName: 'Anthony Davis',
+			teamId: TEAM,
+			teamName: 'Lakers',
+			managerId: MANAGER
+		},
+		managerId: MANAGER,
+		teamId: TEAM
+	};
+}
+
 /** A team-affecting event envelope. */
 function teamEvent(type: string, teamId: string | null = TEAM): EventEnvelope {
 	return {
@@ -404,7 +497,13 @@ describe('duePendingIntents — pending is re-derived, never remembered', () =>
 		eventSeq,
 		channel: DISCORD_CHANNEL,
 		recipient,
-		eventType: 'BidPlaced'
+		eventType: 'BidPlaced',
+		// The derivation reads none of the joined columns — it decides WHICH
+		// intents are due, never what they say.
+		payload: null,
+		managerId: MANAGER,
+		occurredAt: NOW.toISOString(),
+		playerName: null
 	});
 
 	it('treats an intent with no recorded attempt as due now', () => {
@@ -637,30 +736,29 @@ describe('drainOutbox — one pass', () => {
 		expect(harness.events).toEqual([]);
 	});
 
-	it('sends a generic body naming each event once, with no per-type copy', async () => {
-		// Story 5.1 ships the mechanism and a generic payload; 5.2/5.3 own what
-		// a notice says. The body names an event once even though a co-managed
-		// Team contributes two intents for it.
+	it('sends the composed copy, naming an event ONCE however many intents it owes', async () => {
+		// Story 5.2 replaced 5.1's placeholder. The body states what happened —
+		// and states it once even though a co-managed Team contributes two
+		// intents for the one event, because composition groups by `event_seq`.
 		const harness = fakeGateway({
 			managers: [
-				{ teamId: TEAM, discordUserId: ALICE },
-				{ teamId: TEAM, discordUserId: BOB }
-			]
+				{ teamId: TEAM, discordUserId: ALICE, id: MANAGER, displayName: 'Meakel' },
+				{ teamId: TEAM, discordUserId: BOB, id: 'm-2', displayName: 'Dana' }
+			],
+			teams: [{ id: TEAM, name: 'Lakers' }],
+			players: [{ fantraxPlayerId: PLAYER, playerName: 'Anthony Davis' }]
 		});
-		await write(harness.gateway, [teamEvent('BidPlaced')]);
+		await write(harness.gateway, [bidPlaced()]);
 		const channel = fakeChannel();
 
 		await drainOutbox(harness.gateway, {
 			channels: { [DISCORD_CHANNEL]: channel.port }
 		});
 
-		expect(channel.posts[0]?.body).toBe('BBSL auction update — BidPlaced (event #1).');
-		expect(
-			genericBodyFor([
-				{ eventSeq: '1', channel: DISCORD_CHANNEL, recipient: ALICE, eventType: 'BidPlaced' },
-				{ eventSeq: '1', channel: DISCORD_CHANNEL, recipient: BOB, eventType: 'BidPlaced' }
-			])
-		).toBe('BBSL auction update — BidPlaced (event #1).');
+		expect(channel.posts).toHaveLength(1);
+		expect(channel.posts[0]?.body).toBe(
+			`Lakers — Meakel bid $14.5M on Anthony Davis. Closes ${CLOSES_AT_MARKUP}.`
+		);
 	});
 });
 
@@ -730,7 +828,11 @@ describe('drainOutbox — the budget', () => {
 		// ONE request, carrying both Teams' notices and both Managers.
 		expect(channel.posts).toHaveLength(1);
 		expect(channel.posts[0]).toEqual({
-			body: 'BBSL auction update — BidPlaced (event #1), AuctionClosed (event #2).',
+			// Two unrecognised payloads, so two fallback lines — the point of
+			// this case is the GROUPING, and the fallback proves composition
+			// cannot fail a pass on a payload it does not understand.
+			body:
+				'A BidPlaced was recorded (event #1).\nA AuctionClosed was recorded (event #2).',
 			recipients: [ALICE, BOB]
 		});
 		expect(summary).toMatchObject({ attempted: 2, delivered: 2 });
@@ -916,3 +1018,273 @@ describe('drainOutbox — a failure is recorded first and reported second', () =
 		expect(summary.delivered).toBe(1);
 	});
 });
+
+
+// --- Story 5.2: the broadcast intent and the composed post -----------------
+
+describe('enqueueBroadcasts — one channel-addressed intent per broadcast event', () => {
+	it('files exactly one intent, keyed on the sentinel and not on a Manager (AC1)', async () => {
+		// The matrix's "A Bid is placed" row. One row, whatever the Team's
+		// Manager count — a broadcast is addressed to the channel.
+		const harness = fakeGateway({
+			managers: [
+				{ teamId: TEAM, discordUserId: ALICE, id: MANAGER, displayName: 'Meakel' },
+				{ teamId: TEAM, discordUserId: BOB, id: 'm-2', displayName: 'Dana' }
+			]
+		});
+
+		await write(harness.gateway, [bidPlaced()], 'accepted', enqueueBroadcasts);
+
+		expect(harness.outbox).toEqual([
+			{
+				eventSeq: '1',
+				channel: DISCORD_CHANNEL,
+				recipient: BROADCAST_RECIPIENT,
+				createdAt: expect.any(String)
+			}
+		]);
+		// And it never asked `managers` anything: the broadcast set is a
+		// property of the event TYPE, not of who is affected.
+		expect(harness.statements.filter((sql) => /where team_id = \$1/i.test(sql))).toEqual([]);
+	});
+
+	it('files one for a phase event carrying a NULL team_id', async () => {
+		// The matrix's "The phase ends" row, and the reason `enqueueIntents`
+		// could not have been reused: it skips a null `teamId` outright.
+		const harness = fakeGateway();
+
+		await write(
+			harness.gateway,
+			[
+				{
+					type: 'ContractAssignmentOpened',
+					payload: {
+						expiredAt: CLOSES_AT,
+						evaluatedAt: CLOSES_AT,
+						terminatedPlayerIds: ['p-9', 'p-8']
+					},
+					managerId: null,
+					teamId: null
+				}
+			],
+			'accepted',
+			enqueueBroadcasts
+		);
+
+		expect(harness.outbox).toHaveLength(1);
+		expect(harness.outbox[0]?.recipient).toBe(BROADCAST_RECIPIENT);
+	});
+
+	it('files nothing for a write outside the broadcast set (AC1, second half)', async () => {
+		// The matrix's "An eligibility or import write commits" row. Those
+		// writes register no `enqueue` at all, so the mechanism cannot fire —
+		// and even if one did, the type is not in the broadcast set.
+		const harness = fakeGateway();
+		const eligibility: EventEnvelope = {
+			type: 'MinorLeagueEligibilityChanged',
+			payload: {},
+			managerId: MANAGER,
+			teamId: TEAM
+		};
+
+		await write(harness.gateway, [eligibility], 'accepted', undefined);
+		await write(harness.gateway, [eligibility], 'accepted', enqueueBroadcasts);
+
+		expect(harness.outbox).toEqual([]);
+	});
+});
+
+describe('drainOutbox — the broadcast post', () => {
+	/** A league with one named Team, one named Manager and one named Player. */
+	function league(): Parameters<typeof fakeGateway>[0] {
+		return {
+			managers: [{ teamId: TEAM, discordUserId: ALICE, id: MANAGER, displayName: 'Meakel' }],
+			teams: [{ id: TEAM, name: 'Lakers' }],
+			players: [{ fantraxPlayerId: PLAYER, playerName: 'Anthony Davis' }]
+		};
+	}
+
+	it('mentions NOBODY: the sentinel never reaches recipients (AC2)', async () => {
+		// `recipients` becomes both the `<@id>` prefix and
+		// `allowed_mentions.users`, so a sentinel in it would render a literal
+		// `<@#channel>` and hand Discord a non-snowflake. 5.2 mentions nobody.
+		const harness = fakeGateway(league());
+		await write(harness.gateway, [bidPlaced()], 'accepted', enqueueBroadcasts);
+		const channel = fakeChannel();
+
+		await drainOutbox(harness.gateway, { channels: { [DISCORD_CHANNEL]: channel.port } });
+
+		expect(channel.posts[0]?.recipients).toEqual([]);
+		expect(channel.posts[0]?.body).not.toContain(BROADCAST_RECIPIENT);
+		expect(payloadFor({ body: channel.posts[0]?.body ?? '', recipients: [] })).toEqual({
+			content: `Lakers — Meakel bid $14.5M on Anthony Davis. Closes ${CLOSES_AT_MARKUP}.`,
+			allowed_mentions: { parse: [], users: [] }
+		});
+	});
+
+	it('batches a draw and the close it caused into ONE post', async () => {
+		// The matrix's "A Minimum-Bid Contention closes" row: one transaction
+		// appends `ContentionDrawn` then `AuctionClosed`, so both intents are
+		// due together and both lines go out in one message, cause first.
+		const harness = fakeGateway({
+			managers: [
+				{ teamId: TEAM, discordUserId: ALICE, id: MANAGER, displayName: 'Meakel' },
+				{ teamId: OTHER_TEAM, discordUserId: BOB, id: 'm-2', displayName: 'Ari' }
+			],
+			teams: [
+				{ id: TEAM, name: 'Lakers' },
+				{ id: OTHER_TEAM, name: 'Bulls' }
+			],
+			players: [{ fantraxPlayerId: PLAYER, playerName: 'Anthony Davis' }]
+		});
+
+		await write(
+			harness.gateway,
+			[
+				{
+					type: 'ContentionDrawn',
+					payload: {
+						fantraxPlayerId: PLAYER,
+						seed: '9f3c8a1d',
+						seedHash: 'h',
+						contenders: [TEAM, OTHER_TEAM],
+						selectedIndex: 0,
+						winningTeamId: TEAM,
+						winningTeamName: 'Lakers',
+						winningManagerId: MANAGER,
+						drawnAt: CLOSES_AT
+					},
+					managerId: MANAGER,
+					teamId: TEAM
+				},
+				{
+					type: 'AuctionClosed',
+					payload: {
+						fantraxPlayerId: PLAYER,
+						playerName: 'Anthony Davis',
+						teamId: TEAM,
+						teamName: 'Lakers',
+						managerId: MANAGER,
+						winningAmount: 14_500_000,
+						capHit: 14_500_000,
+						contractYears: null,
+						closedAt: CLOSES_AT
+					},
+					managerId: MANAGER,
+					teamId: TEAM
+				}
+			],
+			'accepted',
+			enqueueBroadcasts
+		);
+		const channel = fakeChannel();
+
+		const summary = await drainOutbox(harness.gateway, {
+			channels: { [DISCORD_CHANNEL]: channel.port }
+		});
+
+		expect(channel.posts).toHaveLength(1);
+		expect(channel.posts[0]?.body).toBe(
+			'Anthony Davis drawn to Lakers — Meakel. ' +
+				'Contenders, in order: Lakers — Meakel, Bulls — Ari. Seed: 9f3c8a1d\n' +
+				'Anthony Davis to Lakers — Meakel for $14.5M.'
+		);
+		expect(summary).toMatchObject({ attempted: 2, delivered: 2 });
+	});
+
+	it('names a phase end with no Team at all', async () => {
+		const harness = fakeGateway(league());
+		await write(
+			harness.gateway,
+			[
+				{
+					type: 'ContractAssignmentOpened',
+					payload: {
+						expiredAt: CLOSES_AT,
+						evaluatedAt: CLOSES_AT,
+						terminatedPlayerIds: ['p-9']
+					},
+					managerId: null,
+					teamId: null
+				}
+			],
+			'accepted',
+			enqueueBroadcasts
+		);
+		const channel = fakeChannel();
+
+		await drainOutbox(harness.gateway, { channels: { [DISCORD_CHANNEL]: channel.port } });
+
+		expect(channel.posts[0]?.body).toBe(
+			'The Auction Phase has ended and Contract Assignment is open. ' +
+				'1 nominated Player ended with no Bid.'
+		);
+		expect(channel.posts[0]?.recipients).toEqual([]);
+	});
+
+	it('leaves a notice the ceiling excluded PENDING, and posts it on the next pass', async () => {
+		// The second half of the matrix's "A batch would exceed the message
+		// ceiling" row, and the reason the ceiling drops whole notices instead
+		// of truncating the joined body: an excluded intent is given no
+		// outcome, so the next pass re-derives it as pending. Asserting this at
+		// the composer alone would prove the split and not the recovery.
+		const harness = fakeGateway(league());
+		await write(harness.gateway, [bidPlaced()], 'accepted', enqueueBroadcasts);
+		await write(harness.gateway, [nominationPlaced()], 'accepted', enqueueBroadcasts);
+		const channel = fakeChannel();
+
+		// A ceiling that fits the first notice and not both.
+		const first = await drainOutbox(harness.gateway, {
+			channels: { [DISCORD_CHANNEL]: channel.port },
+			ceiling: 80
+		});
+		expect(first.delivered).toBe(1);
+		expect(channel.posts).toHaveLength(1);
+
+		// Nothing recorded an outcome for the excluded one, so it is still owed.
+		const second = await drainOutbox(harness.gateway, {
+			channels: { [DISCORD_CHANNEL]: channel.port }
+		});
+		expect(second.delivered).toBe(1);
+		expect(channel.posts).toHaveLength(2);
+
+		// And the two passes together said everything exactly once.
+		expect(channel.posts[0]?.body).not.toEqual(channel.posts[1]?.body);
+
+		// A third pass owes nothing at all.
+		expect((await drainOutbox(harness.gateway, {
+			channels: { [DISCORD_CHANNEL]: channel.port }
+		})).attempted).toBe(0);
+	});
+
+	it('settles every posted intent, so a retry after a delivered post sends nothing', async () => {
+		// The matrix's "Retry after a delivered post" row, against real copy.
+		const harness = fakeGateway(league());
+		await write(harness.gateway, [bidPlaced()], 'accepted', enqueueBroadcasts);
+		const channel = fakeChannel();
+		const ports = { channels: { [DISCORD_CHANNEL]: channel.port } };
+
+		expect((await drainOutbox(harness.gateway, ports)).delivered).toBe(1);
+		expect((await drainOutbox(harness.gateway, ports)).attempted).toBe(0);
+		expect(channel.posts).toHaveLength(1);
+	});
+
+	it('degrades an unrecognised payload to a plain factual line, and never throws', async () => {
+		// The matrix's "A payload is unrecognised or malformed" row.
+		const harness = fakeGateway(league());
+		await write(
+			harness.gateway,
+			[{ type: 'BidPlaced', payload: { amount: 'not a number' }, managerId: null, teamId: null }],
+			'accepted',
+			enqueueBroadcasts
+		);
+		const channel = fakeChannel();
+
+		const summary = await drainOutbox(harness.gateway, {
+			channels: { [DISCORD_CHANNEL]: channel.port }
+		});
+
+		expect(channel.posts[0]?.body).toBe('A BidPlaced was recorded (event #1).');
+		expect(summary.delivered).toBe(1);
+	});
+});
diff --git a/tests/server/phase-end.test.ts b/tests/server/phase-end.test.ts
index 7460b35..3f477a5 100644
--- a/tests/server/phase-end.test.ts
+++ b/tests/server/phase-end.test.ts
@@ -134,6 +134,16 @@ function fakeGateway(options: { events?: QueryResultRow[]; now?: Date } = {}) {
 				releasedClaims = [];
 				return { rows: [] };
 			}
+			// Story 5.2 registered `enqueueBroadcasts` on this write, so the
+			// appending transaction now also files one channel-addressed
+			// delivery intent per broadcast-worthy event (AD-17). It is
+			// recorded in `statements` like every other statement and asserted
+			// on in `tests/server/outbox.test.ts`, which owns the outbox; here
+			// it only has to be a statement the fake recognises rather than one
+			// it rejects.
+			if (/^insert into notification_outbox/i.test(sql)) {
+				return { rows: [] };
+			}
 			throw new Error(`unexpected statement: ${sql}`);
 		},
 		release() {
diff --git a/tests/server/sweep-sequential.test.ts b/tests/server/sweep-sequential.test.ts
index 1a41e02..246f896 100644
--- a/tests/server/sweep-sequential.test.ts
+++ b/tests/server/sweep-sequential.test.ts
@@ -185,6 +185,16 @@ function fakeGateway(seed: QueryResultRow[]) {
 				appendedEvents.length = committedThrough;
 				return { rows: [] };
 			}
+			// Story 5.2 registered `enqueueBroadcasts` on this write, so the
+			// appending transaction now also files one channel-addressed
+			// delivery intent per broadcast-worthy event (AD-17). It is
+			// recorded in `statements` like every other statement and asserted
+			// on in `tests/server/outbox.test.ts`, which owns the outbox; here
+			// it only has to be a statement the fake recognises rather than one
+			// it rejects.
+			if (/^insert into notification_outbox/i.test(sql)) {
+				return { rows: [] };
+			}
 			throw new Error(`unexpected statement: ${sql}`);
 		},
 		release() {


Do not invoke any skill. Return only the review result.
