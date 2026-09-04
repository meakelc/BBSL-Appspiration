---
title: 'Story 5.2: Broadcast auction events to the league channel'
type: 'feature'
created: '2026-09-03'
status: 'done'
review_loop_iteration: 0
baseline_commit: '50a01d53c8876027b7f86b2c9287c821a39e6d56'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 5.1 built the outbox, the dispatcher and the webhook, but wired the enqueue seam to nothing and ships a placeholder body — `BBSL auction update — BidPlaced (event #1).` Nothing is broadcast today, and the drain cannot see an event's payload, so it could not say what happened even if it were wired.

**Approach:** Add a broadcast intent — one row per broadcast-worthy event, addressed to the channel rather than to a person — wire it into the five writes that append the broadcast set, widen the drain's read so the composer can see payloads and the league's names, and replace the placeholder with a pure per-event-type composer in `adapters/discord/`.

## Boundaries & Constraints

**Always:**
- One intent per broadcast event, recipient the sentinel `#channel`. The `(event_seq, channel, recipient)` key is unchanged, so 5.3 can later add per-Manager rows for the same event without colliding.
- The sentinel is never a mention: it must be filtered out of `recipients` before the payload is built, or `allowed_mentions.users` would carry a non-snowflake and the body would render `<@#channel>`.
- Money renders through `formatMoney` (`$14.5M`, one decimal). Its `DisplayMoney` brand is what keeps it out of a CSV cell — do not stringify an amount by hand.
- A fantasy Team is always `formatTeamManager` — `Lakers — Meakel`, U+2014. A three-letter capitalised abbreviation means a real-life NBA team and nothing else, so never abbreviate a Team.
- Composition is pure: every name and instant it needs is passed in. It performs no I/O and reads no clock.
- No exclamation mark, no urgency framing, no "ending soon"/"last chance", no suggested action, anywhere in composed copy.
- `outbox.ts` and anything it imports stay Deno-loadable (AD-2): relative `.ts` only, no `$lib`, no `$env`, no node builtin.
- Composition must not throw out of the drain. A malformed or unrecognised payload degrades to a plain factual line; it never fails a pass.

**Ask First:**
- Any change to `src/lib/core/**`. Adding `playerName` to `BidPlacedPayload` would be the tempting one — resolve it with the reference join instead.
- Any new migration. This story needs none.

**Never:**
- No mention text, no `@` of any Manager, no mute or settings logic — 5.3 and 5.4. `enqueueIntents` (the Manager-shaped enqueue) stays untouched and unwired.
- No absolute deep link. `auctionPathFor` yields a path and no origin is configured anywhere; the link belongs to 5.3's mention, with the origin decided there.
- No broadcast of `AuctionTerminated`, `ContentionDissolved`, eligibility, import or `NotificationDispatched` events. The broadcast set is the six named types and nothing else.
- No second cron schedule, no change to the tick's sweep-then-drain order.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| A Bid is placed | `BidPlaced`, amount 14_500_000, `closesAt` | One intent; post names Team — Manager, Player, `$14.5M` and the new close time as a Discord timestamp | N/A |
| A Minimum-Bid Contention closes | One transaction appends `ContentionDrawn` then `AuctionClosed` | Two intents, both due together, batched into ONE post; the draw line carries the revealed seed and the contenders in payload order, each spelled out | N/A |
| An eligibility or import write commits | Events appended by `eligibility.ts` / `import-promotion.ts` | No intent — those writes register no enqueue | N/A |
| The phase ends | `ContractAssignmentOpened`, `team_id` null | One intent — a broadcast is not keyed on a Team, unlike a mention | N/A |
| Retry after a delivered post | The pass above re-runs | Zero further posts; the delivered outcome retired both intents | N/A |
| A batch would exceed the message ceiling | More composed notices than fit | Whole notices posted up to the ceiling; the remainder stay pending and go next pass | Never dropped, never split mid-notice |
| One notice alone exceeds the ceiling | A draw with 30 contenders | That notice is truncated to fit and posted | Cannot stall the outbox |
| A payload is unrecognised or malformed | Broadcast type, missing field | A plain line naming the event and its `seq` | Never throws; the pass completes |

</frozen-after-approval>

## Code Map

- `src/lib/server/outbox.ts` -- `genericBodyFor` (:685-694) is the placeholder to replace, called from `postBatch` (:662). `PENDING_INTENTS_SQL` (:435-440) selects only `o.event_seq, o.channel, o.recipient, e.event_type` — this is why nothing can be composed today; widen it and `toOutboxIntent` (:593-602)/`OutboxIntent` (:158-165). `postBatch` (:652-671) builds `recipients` from every intent (:663) — filter the sentinel there. `drainOutbox` (:476-511) counts outcomes for the whole batch; it must count only what was posted. `DISCORD_CHANNEL` (:83) is the constant pattern for the new sentinel.
- `src/lib/server/outbox.ts` -- `enqueueIntents` (:220-249) is the Manager-shaped enqueue: it skips `teamId === null` (:228, :239) and fans out per Manager. **Do not reuse or modify it** — a broadcast is one row keyed on type, not per Manager, and phase events carry a null `teamId`. Its header (:215-218) names this story as the one that wires an enqueue.
- `src/lib/shell/write.ts` -- `enqueue` runs inside the transaction, after projections, before `COMMIT` (:294-305); `EnqueueFn` is `(client, appended)` (:240). A throwing enqueue rolls the write back, which is why composition never runs here.
- Wiring points, all `runTransactionalWrite` calls: `src/lib/server/nomination.ts:585` (`NominationPlaced`), `src/lib/server/bidding.ts:443` (`BidPlaced`), `src/lib/server/close.ts:188` (`ContentionDrawn` + `AuctionClosed`), `src/lib/server/auction-open.ts:183` (`AuctionOpened`), `src/lib/server/phase-end.ts:159` (`ContractAssignmentOpened`). `eligibility.ts:272` and `import-promotion.ts:273` must stay unwired.
- Event literals: `NominationPlaced` `src/lib/core/projection/nominations.ts:85`; `BidPlaced` `src/lib/core/projection/auctions.ts:64`; `AuctionClosed` `nominations.ts:98`; `ContentionDrawn` `src/lib/core/projection/draws.ts:60`; `AuctionOpened` `src/lib/core/projection/phase.ts:59`; `ContractAssignmentOpened` `phase.ts:80`. There is no DB check constraint on `event_type` (`20260821020000_auction_events.sql:60-64`).
- Payloads: `NominationPlacedPayload` `src/lib/server/nomination.ts:121-127` (has `playerName`, no amount, **no close time**); `BidPlacedPayload` `src/lib/core/rules/bidding.ts:2753-2777` (`amount`, `closesAt`, **no `playerName`**); `AuctionClosedPayload` `src/lib/core/rules/close.ts:370-387` (`playerName`, `winningAmount`, `capHit`, `closedAt`); `ContentionDrawnPayload` `close.ts:416-442` (`seed`, `contenders: readonly string[]` of **team ids**, `winningTeamName`, `drawnAt`); `AuctionOpenedPayload` `src/lib/server/auction-open.ts:196-199`; `ContractAssignmentOpenedPayload` `src/lib/core/rules/phase-end.ts:149-156`.
- Renderers, all pure and reachable by relative `.ts`: `formatMoney` `src/lib/core/money.ts:169` (throws `RangeError` off-grid — guard it); `DisplayMoney`/`ExportCell` brands :35,:38 with the compile-time separation test `tests/money.test.ts:210-236`; `formatTeamManager` + `EM_DASH` `src/lib/core/team-identity.ts:36,:18`; `auctionPathFor` `src/lib/core/auction-link.ts:44` (path only, :17-20).
- `src/lib/adapters/discord/webhook.ts` -- `contentFor` (:183-189) prepends mentions to the body; `payloadFor` (:196-204) sets `allowed_mentions: { parse: [], users: addressees(message) }`; `addressees` (:166-174) de-dupes. `DiscordWebhookMessage` is `{ body, recipients }` (:54-68). Header (:11-15) names 5.2 as the owner of copy. No `.gitkeep` concern remains — `tests/structure.test.ts:220` already requires it absent.
- Names not on any payload: Manager display names are `managers.display_name` (`20260821000000_managers.sql:35`); `managers.discord_user_id` (:31) is the snowflake and is not a display name. Contender team ids need `teams`. `free_agent_players.player_name` (`20260824020000_live_reference_tables.sql:107`) is stable for the whole auction — `close.ts:11` confirms a close writes neither table.
- `tests/server/outbox.test.ts` -- content-asserting tests that must change: :640, :698, :749. Mechanism tests (:279, :457, :668, :807) must stay green. `readDueIntents` (:554-590) is the three-reads-in-one-transaction shape any new read joins.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- the open item "Nothing guards Discord's 2000-character message limit", owner Story 5.2. This story closes it.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/adapters/discord/broadcast.ts` -- new, pure. Export `BROADCAST_EVENT_TYPES` (the six literals), a `LeagueDirectory` input type (team id → name, manager id → display name, team id → its Managers), `noticeFor(event, directory)` returning one line per event type, and `broadcastBodyFor(notices, ceiling)` joining whole notices up to the ceiling and reporting which were included. Render instants as Discord `<t:unix:f>` markup so every reader sees their own timezone. Money through `formatMoney`, Teams through `formatTeamManager`.
- [x] `src/lib/server/outbox.ts` -- add `BROADCAST_RECIPIENT = '#channel'` and `enqueueBroadcasts: EnqueueFn` inserting one intent per event whose type is in the broadcast set, independent of `teamId`. Widen `PENDING_INTENTS_SQL`/`OutboxIntent` with `e.payload`, `e.manager_id`, `e.occurred_at` and a left join to `free_agent_players` for the Player name `BidPlaced` lacks. Read the league directory inside `readDueIntents`' existing transaction. Filter `BROADCAST_RECIPIENT` out of `postBatch`'s `recipients`. Compose through `broadcastBodyFor`, and record outcomes only for the intents actually posted.
- [x] `src/lib/server/nomination.ts`, `bidding.ts`, `close.ts`, `auction-open.ts`, `phase-end.ts` -- pass `enqueue: enqueueBroadcasts` to `runTransactionalWrite`. One line each; state in a comment why this write broadcasts and `eligibility.ts` does not.
- [x] `tests/adapters/discord-broadcast.test.ts` -- new. One case per event type against a literal payload and a fake directory, the ceiling cases from the matrix, the malformed-payload fallback, and an assertion over every composed sample that no `!` and no urgency word appears.
- [x] `tests/server/outbox.test.ts` -- replace the three content assertions with real copy; add the batched draw-plus-close case, the null-`teamId` phase broadcast, the sentinel absent from `recipients`, and that an eligibility write enqueues nothing.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- mark the 2000-character item `status: closed`, naming the ceiling this story implements.

**Acceptance Criteria:**
- Given a write that appends a broadcast event, when it commits, then exactly one intent committed with it, and a write outside the broadcast set committed none.
- Given the drain, when it posts, then the payload's `allowed_mentions` names no user at all, because 5.2 mentions nobody.
- Given the whole story, when `npm test`, `npm run check` and `npx deno check --config supabase/functions/tick/deno.json supabase/functions/tick/index.ts` are run, then all three pass.

## Spec Change Log

## Design Notes

**Why a sentinel recipient rather than a nullable column.** `recipient` is `not null` with a non-blank check and sits in the unique key (`20260903000000_notification_outbox.sql:67,79,84`). A sentinel needs no migration, keeps the key declarative, and lets 5.3's per-Manager rows coexist with the broadcast for the same event. `#channel` is chosen because it can never collide with a Discord snowflake, which is numeric.

**Why the ceiling drops whole notices instead of truncating the batch.** An intent with no recorded outcome is still pending, so an excluded notice is picked up next pass for free — the same "re-derives, never remembers" property the drain already has. Truncating the joined body would instead deliver a half-sentence and mark it delivered. A single notice over the ceiling is the one case that must truncate, or it would stall the outbox forever.

**Golden examples** (`<t:…:f>` renders as the reader's local time):

```
Lakers — Meakel bid $14.5M on Anthony Davis. Closes <t:1789248600:f>.
Anthony Davis to Lakers — Meakel for $14.5M.
Anthony Davis drawn to Lakers — Meakel. Seed: 9f3c8a1d. Contenders, in order: Lakers — Meakel, Bulls — Ari.
```

**The seed leads the contender list, and that ordering is load-bearing.** Truncation cuts from the tail, so whatever sits last is what a ceiling destroys. Putting the seed before the contenders makes the commitment structurally unreachable by the truncator: the contender list is what gets eaten, and it is recoverable from the `ContentionDrawn` event, where the seed's verifiability would not be. A full 30-Team draw renders at roughly 670 characters against a 2000 ceiling, so this is defensive rather than live — but it is the exact case the matrix names as the truncation scenario.

**The seed is posted in full, never abbreviated.** The draw post is where Story 3.6's commit-reveal is discharged: a Manager hashes the revealed seed and checks it against the `seedHash` published on the opening `BidPlaced`. A prefix hashes to nothing, so abbreviating it would leave the fairness premise unverifiable while looking correct. A real seed is 32 bytes as hex — 64 characters, which the ceiling absorbs without difficulty. The seed above is short only because it is an example.

## Verification

**Commands:**
- `npm test` -- expected: all pass, including the 5.1 mechanism suites in `tests/server/outbox.test.ts`.
- `npm run check` -- expected: no type errors; the `@ts-expect-error` pair in `tests/money.test.ts:226-230` still holds.
- `npx deno check --config supabase/functions/tick/deno.json supabase/functions/tick/index.ts` -- expected: clean. Composition is now reachable from the tick, so a non-Deno import in `broadcast.ts` breaks production and CI's `src/lib/core`-only deno check would not catch it.

**Manual checks:**
- `git status --short` before review — confirm no new file is left untracked, so the whole diff reaches the reviewers.

## Suggested Review Order

**What is broadcast, and how one intent becomes a post**

- The whole story in one list: the six types, and the only reader of it.
  [`broadcast.ts:54`](../../src/lib/adapters/discord/broadcast.ts#L54)

- One intent per broadcast event, keyed on the type — not per Manager, and not on a Team.
  [`outbox.ts:336`](../../src/lib/server/outbox.ts#L336)

- The sentinel: a broadcast is addressed to the channel, and needs no migration to be.
  [`outbox.ts:119`](../../src/lib/server/outbox.ts#L119)

- The first wiring point; the other four read identically.
  [`bidding.ts:452`](../../src/lib/server/bidding.ts#L452)

**The seed, and why its position is load-bearing**

- Seed before contenders, so tail-truncation can only ever reach the recoverable half.
  [`broadcast.ts:360`](../../src/lib/adapters/discord/broadcast.ts#L360)

- The commitment survives a ceiling that eats the rest of the line.
  [`discord-broadcast.test.ts:181`](../../tests/adapters/discord-broadcast.test.ts#L181)

**Composition, which never throws and never mentions**

- One line per type, degrading to a plain fact rather than failing a pass.
  [`broadcast.ts:276`](../../src/lib/adapters/discord/broadcast.ts#L276)

- An empty contender list is malformed, not an empty sentence.
  [`broadcast.ts:340`](../../src/lib/adapters/discord/broadcast.ts#L340)

- The sentinel filtered out here is the one place it could reach `allowed_mentions`.
  [`outbox.ts:911`](../../src/lib/server/outbox.ts#L911)

**The ceiling: whole notices, and what a pass leaves behind**

- Whole notices up to the ceiling; the excluded ones simply stay pending.
  [`broadcast.ts:442`](../../src/lib/adapters/discord/broadcast.ts#L442)

- A non-positive ceiling includes nothing, so no intent is settled having said nothing.
  [`broadcast.ts:451`](../../src/lib/adapters/discord/broadcast.ts#L451)

- Truncation cuts between whole characters, never through a surrogate pair.
  [`broadcast.ts:486`](../../src/lib/adapters/discord/broadcast.ts#L486)

- The recovery proved end to end: excluded, then posted next pass, then nothing owed.
  [`outbox.test.ts:1334`](../../tests/server/outbox.test.ts#L1334)

**What the drain had to learn to see**

- The widened read, and the join that gives `BidPlaced` the Player name it lacks.
  [`outbox.ts:554`](../../src/lib/server/outbox.ts#L554)

- The directory is read only when something is due, so an idle tick pays nothing.
  [`outbox.ts:729`](../../src/lib/server/outbox.ts#L729)

**Peripherals**

- AC2, asserted against the post's own recipients rather than a literal.
  [`outbox.test.ts:1209`](../../tests/server/outbox.test.ts#L1209)

- The Never-list item, locked against a future re-wiring.
  [`outbox.test.ts:1172`](../../tests/server/outbox.test.ts#L1172)
