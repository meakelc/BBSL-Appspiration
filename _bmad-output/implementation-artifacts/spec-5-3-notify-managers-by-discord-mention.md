---
title: 'Story 5.3: Notify Managers by Discord mention'
type: 'feature'
created: '2026-09-04'
status: 'done'
review_loop_iteration: 0
baseline_commit: '9422a6b72c14cd813b2a470dfa404fb99a3366a6'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The channel now carries a complete public record and mentions nobody. `enqueueIntents` — the per-Manager enqueue built in 5.1 — is registered by no production write, so a Manager outbid at work learns nothing until they next open the app. That is the trap the rolling 24-hour clock was supposed to stop being.

**Approach:** Wire a Manager-shaped enqueue at each write that affects a Team, with the affected Team supplied by the write site rather than read off the payload, and compose the mention inline on the notice for its own event, carrying an absolute deep link to the Auction.

## Boundaries & Constraints

**Always:**
- The mention is `<@discord_user_id>`, the snowflake captured at sign-in (`managers.discord_user_id`). Never a display name, never a Team name.
- Both Managers of a co-managed Team are mentioned individually, as two intents on the same event. The `(event_seq, channel, recipient)` key already makes this the natural shape — do not collapse them.
- A mention is rendered **inline on the notice for its own event**, never prepended to the head of the message. A batch covers several events and the reader must be able to tell which line is theirs.
- Mentions and broadcasts share the one channel and the one post. The mention rides the existing broadcast notice; it is never a second message.
- `allowed_mentions` stays `{ parse: [], users: <exactly the addressees> }`. No `@everyone`, no roles, ever.
- The affected Team is decided at **write time** by the code that knows it, and passed to the enqueue. The drain re-derives nothing about who was affected.
- Composition stays pure and total: no I/O, no clock, and it never throws out of the drain. A missing name, a missing origin or an unrecognised payload degrades to a plain factual line.
- Voice unchanged: no exclamation mark, no urgency framing, no "ending soon", no suggested action, in mention copy as in broadcast copy.
- `outbox.ts`, the composer, and anything either imports stay Deno-loadable (AD-2): relative `.ts` only, no `$lib`, no `$env`, no node builtin.

**Ask First:**
- Any change to `src/lib/core/**`. The affected Team is available in the shell at every write site; adding a displaced-leader field to `BidPlacedPayload` is the tempting one and is not this story's to make.
- Any second cron schedule, or any change to the tick's sweep → clock → drain order.

**Never:**
- **No 24-hour unbid-Nomination warning.** FR-27 names it as a fifth trigger; it was **removed from scope by user decision on 2026-09-04**, not deferred, so no `deferred-work.md` entry records it and no code here derives Nomination age. Reviewers should read its absence as intended. Consequence to be aware of and not to fix here: Story 5.4's second mutable category will have no trigger behind it, and `epics.md` / FR-27 still name it.
- No mute, no settings surface, no per-category suppression — that is 5.4. Every trigger here fires unconditionally.
- No new outbox column and no migration. The idempotency key is unchanged.
- No mention on `AuctionOpened`, `NominationPlaced`, `BidVoided`, `ContentionDissolved`, `AuctionTerminated`, or any import/eligibility write.
- No dead-letter state, no Commissioner failure screen, no change to the backoff ladder — those remain 8.2's.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| A Manager is outbid | `BidPlaced` displaces a leading Bid held by another Team | One intent per Manager of the displaced Team; the notice carries `<@id>` and the absolute Auction link | N/A |
| A co-managed Team is outbid | The displaced Team has two `managers` rows | Two intents, two distinct `<@id>` on the one notice, both in `allowed_mentions.users` | N/A |
| A Team outbids itself | The displacing and displaced Team are the same | No mention intent — nobody is notified of their own act | N/A |
| The first Bid on an Auction | `BidPlaced` with no prior leading Bid | No mention intent; the broadcast notice posts alone | N/A |
| An Auction the Team led closes | `AuctionClosed`, leader and winner known | One intent per Manager of the leader | N/A |
| A contention closes | `ContentionDrawn` then `AuctionClosed` in one transaction | Every Contender's Managers mentioned, deduped per event by the outbox key | N/A |
| The Nomination Slot is released | The same `AuctionClosed`; the nominating Team differs from the winner | The nominating Team's Managers are mentioned on that same notice | N/A |
| The phase opens | `ContractAssignmentOpened`, `team_id` null | Every Manager of every Team is mentioned | N/A |
| A Team has no Manager rows | The affected Team resolves to zero recipients | No mention intent; the broadcast notice still posts and names the Team, which is the record | Never throws, never loses the broadcast |
| The app origin is unset | No `APP_ORIGIN` in the environment | The mention posts without a link rather than not at all | Never throws; an idle pass never evaluates it |
| The per-pass budget cuts mid-event | More due intents than the budget, the boundary inside one event's group | Whole events only; the split event goes entirely next pass | An event is never posted twice |
| An unrecognised event carries a mention intent | A snowflake recipient on a type with no mention clause | A plain line naming the addressees and the event | Never throws; the pass completes |

</frozen-after-approval>

## Code Map

- `src/lib/server/outbox.ts` -- `enqueueIntents` (:281-310) reads `MANAGERS_OF_TEAM_SQL` (:229-234, returns `discord_user_id`), skips `event.teamId === null` (:289, :300) and inserts via `INSERT_INTENT_SQL` (:249-253). **It keys recipients on the event's own `team_id` — the acting Team, which is the wrong Team for every trigger here.** Replace it with an affected-Team-driven variant taking the Teams from the call site. `DISCORD_CHANNEL` (:100) and `BROADCAST_RECIPIENT` (:119) are unchanged; `enqueueBroadcasts` (:336-349) keeps working beside it on the same write.
- `src/lib/server/outbox.ts` -- `composeBatch` (:912-947) already groups by `event_seq` and its header (:890-910) anticipates this story's per-Manager rows. `noticeFor` is called once per group (:934) — append the mention suffix there. `recipients` filters the sentinel (:941-943). `duePendingIntents` slices `due` by budget (:468) — make it slice on **event boundaries** so a group is never split across passes. `PER_PASS_BUDGET` (:165) is 5, and a co-managed outbid is three intents on one event.
- `src/lib/server/outbox.ts` -- `PENDING_INTENTS_SQL` (:551-559) and `OutboxIntent` (:193-225) carry payload, `manager_id`, `occurred_at` and the joined `player_name`. `MANAGER_NAMES_SQL` (:575) selects `id, display_name, team_id` and **not `discord_user_id`** — widen it and add the snowflake to `LeagueDirectory`, or a recipient cannot be named. `toLeagueDirectory` (:784-810) is the fold; it already tolerates a Manager with no Team. `readDueIntents` (:707-755) reads the directory only when `due.length > 0` (:727-733) — keep that.
- `src/lib/adapters/discord/broadcast.ts` -- `noticeFor` (:276-282) never throws; per-type composers (:296-387); `discordTimestamp` (:138-142); `broadcastBodyFor` (:442-469) and `truncateToFit` (:486-498) against `DISCORD_MESSAGE_CEILING = 2000` (:408). `LeagueDirectory` (:103-115) is the type to widen. Imports are relative `.ts` only (:38-40); the Deno constraint is doc-stated (:21-23), not test-enforced.
- `src/lib/adapters/discord/webhook.ts` -- `mentionFor` (:153-155) is the only `<@id>` formatter; `contentFor` (:183-189) **prepends** mentions ahead of the body, which this story replaces with inline placement; `payloadFor` (:196-204) sets `allowed_mentions` (:202) and must keep doing so; `addressees` (:166-174) de-dupes. The prepend path is unreachable in production today — 5.2 leaves `recipients` empty — so changing it breaks no shipped behaviour.
- `src/lib/core/auction-link.ts` -- `auctionPathFor` (:44-46) returns a path and explicitly no origin (:17-20). **No env var anywhere supplies an app origin**: `.env.example` has `SUPABASE_URL` (:22) and `PUBLIC_SUPABASE_URL` (:64) only, and `src/lib/server/supabase.ts:163` takes its origin from the request — which the tick does not have. A new server-only `APP_ORIGIN` is required.
- Write sites, all `runTransactionalWrite` calls now passing `enqueueBroadcasts`: `bidding.ts:444` (:452), `close.ts:189` (:199), `phase-end.ts:160` (:170). `nomination.ts:586` (:595) and `auction-open.ts:184` (:192) broadcast but trigger no mention. `eligibility.ts:272` and `import-promotion.ts:273` pass no enqueue and must stay that way (`tests/server/outbox.test.ts:1172` locks it).
- The affected Team, per trigger: the displaced leader is `state.leadingBid?.teamId` on the state `loadBidState` already folded (`src/lib/server/bidding.ts:249`, via `auctionForPlayer` `src/lib/core/projection/auctions.ts:266`) — it exists only transiently inside `evaluateSelfBid` (`src/lib/core/rules/bidding.ts:934-942`) and is on **no payload**. Contenders are `Auction.contenders` (`auctions.ts:217`), derived by `contendersFor` (`src/lib/core/rules/bidding.ts:528`). `close.ts:131` folds the same state before closing. `AuctionClosedPayload` (`src/lib/core/rules/close.ts:370-387`) names the **winner**, not the nominator, so the nominating Team comes from the nominations fold in that same state.
- Nomination Slot release is **not an event** — `nominationsReducer` (`src/lib/core/projection/nominations.ts:420-474`) drops the key on `AuctionClosed` (:455-471) and `AuctionTerminated` (:432-454). This story triggers on the `AuctionClosed` case only; a release at phase end is already covered by the Contract Assignment mention every Manager receives.
- `supabase/functions/tick/index.ts` -- `drainOutbox(gateway, { channels })` (:190-194); `discordChannel()` (:133-148) builds the port lazily on the first message, and the header (:115-132) explains why an idle pass must not evaluate a `required(...)`. The origin must reach the drain under that same discipline.
- Schema: `managers.discord_user_id` (`20260821000000_managers.sql:31`), `display_name` (:35); `managers.team_id` is a nullable FK and two rows sharing one — co-management — is explicitly supported (`20260821010000_teams.sql:61-70`, comment at :70). `notification_outbox` key `(event_seq, channel, recipient)` (`20260903000000_notification_outbox.sql:79`), `recipient` checked only non-blank (:84), so a snowflake needs no migration.
- `tests/server/outbox.test.ts` -- the `enqueueIntents` suite (:416-520) is the shape to follow and to rewrite; `write()` (:302-315) defaults `enqueue` to `enqueueIntents` (:306); `fakeGateway` (:89). `tests/adapters/discord-broadcast.test.ts` -- `event()` (:55-69) and the literal `DIRECTORY` (:39-53) are the fixtures to extend. `tests/adapters/discord-webhook.test.ts:181-230` asserts the prepend that changes. `tests/examples/example-15-co-manager-race.test.ts` is the existing co-managed-Team fixture.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- three open items name 5.3 as owner and this story closes all three: `enqueueIntents` unwired (spec 5.1), the channel-only batching granularity (spec 5.1), the unmanaged-Team silence (spec 5.1); plus the phase-end item from spec 3.7, "the Auction Phase ends and no Manager is notified".

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/adapters/discord/mention.ts` -- new, pure. `mentionSuffixFor(event, recipients, directory, origin)` returns the inline mention line for one event: the `<@id>`s, one factual clause naming what happened to them, and the absolute Auction link when an origin is given. One clause per trigger; a plain line for anything unrecognised; never throws.
- [x] `src/lib/server/outbox.ts` -- replace `enqueueIntents` with an affected-Team-driven enqueue that takes the Teams each event affects and inserts one intent per Manager of each, keeping the sentinel and the key untouched. Widen `MANAGER_NAMES_SQL` and `LeagueDirectory` with `discord_user_id`. Make `duePendingIntents` slice on event boundaries. Thread an optional `origin` through `DrainPorts` into `composeBatch`, and call `mentionSuffixFor` for each group's non-sentinel recipients.
- [x] `src/lib/adapters/discord/webhook.ts` -- stop prepending mentions in `contentFor`; leave `payloadFor`'s `allowed_mentions.users` exactly as it is. State in the header that placement is now the composer's and addressing is still this file's.
- [x] `src/lib/server/bidding.ts` -- supply the displaced leading Team for `BidPlaced`, from the state already folded before `decide()`. Nothing when the Bid leads from nothing, and nothing when a Team displaces itself.
- [x] `src/lib/server/close.ts` -- supply the leader, every Contender, and the nominating Team for `AuctionClosed`/`ContentionDrawn`, from the state already folded before the close.
- [x] `src/lib/server/phase-end.ts` -- supply every Team for `ContractAssignmentOpened`, whose `team_id` is null.
- [x] `supabase/functions/tick/index.ts`, `.env.example` -- read `APP_ORIGIN` and pass it to the drain without making an idle pass evaluate it; document it as server-only and never `PUBLIC_`-prefixed.
- [x] `tests/adapters/discord-mention.test.ts` -- new. Every matrix row that is composition: the co-manager case asserted as two distinct `<@id>`, the self-outbid silence, the absent origin, the unrecognised event, and no `!` or urgency word in any composed sample.
- [x] `tests/server/outbox.test.ts`, `tests/adapters/discord-webhook.test.ts` -- rewrite the enqueue and prepend suites; add the budget-boundary case, the sentinel still absent from `recipients`, and that eligibility and import writes still enqueue nothing.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- mark the four items named in the Code Map `status: closed`, naming what resolved each.

**Acceptance Criteria:**
- Given a Team-affecting event, when the write commits, then its mention intents committed in the same transaction, and a write outside the four triggers committed none.
- Given a posted message, when its payload is inspected, then `allowed_mentions.users` is exactly the set of snowflakes appearing as `<@id>` in the body, with no role and no `parse` entry.
- Given an outbidding Bid, when the next tick pass runs, then the mention is posted well inside 60 seconds of that Bid at the schedule's 10-second cadence.
- Given the whole story, when `npm test`, `npm run check` and `npx deno check --config supabase/functions/tick/deno.json supabase/functions/tick/index.ts` are run, then all three pass.

## Spec Change Log

## Design Notes

**Why `enqueueIntents` cannot simply be registered.** It keys recipients on the event's own `team_id` — the **acting** Team. Every trigger here names somebody else: the outbid Manager is not the bidder, the Manager whose Slot released is not the winner, and `ContractAssignmentOpened` carries no Team at all. Registering it as-is would mention the wrong person on three of four triggers and nobody on the fourth, which is why 5.1 left it unwired rather than wiring it wrongly.

**Why the mention is inline rather than prepended.** `contentFor` puts every `<@id>` at the head of the message, and the drain batches by channel, so one post can cover several events. A Manager pinged at the top of a five-event post cannot tell which line is theirs, and with several links in one body "links directly to the relevant Auction" stops being true. Placing the mention on its own event's notice makes the addressing and the fact one sentence, and closes the batching-granularity item 5.1 deferred without having to regroup the batch by `(channel, recipient)`.

**Golden example** (one post, one batch, two events):

```
Lakers — Meakel bid $14.5M on Anthony Davis. Closes <t:1789248600:f>.
<@456> — Bulls — Ari no longer hold the leading Bid. https://bbsl.example/auction/1234
Jrue Holiday to Heat — Dana for $3.0M.
<@789> <@790> — Suns — Kai led this Auction at its close. https://bbsl.example/auction/5678
```

**Why the budget must slice on event boundaries.** `duePendingIntents` currently takes the first five intents in `(event_seq, channel, recipient)` order. A co-managed outbid is three intents on one event, so the boundary can fall between an event's broadcast row and its mention rows — posting the fact this pass and the mention next pass, as a second post repeating the same line. Slicing whole groups makes that unreachable, and costs nothing: an excluded group is already re-derived as pending.

**Why a Team with no Managers stays silent.** After 5.2 the broadcast post already names the Team and states what happened, so the record exists and only the ping is absent — which is precisely what 5.4 will make a Manager able to choose. An unmanaged Team is a supported state (`managers.team_id` is nullable) and unreachable during a live auction, so a second observability mechanism here would be dead code.

## Verification

**Commands:**
- `npm test` -- expected: all pass, including the 5.1 mechanism suites and 5.2's broadcast suites.
- `npm run check` -- expected: no type errors.
- `npx deno check --config supabase/functions/tick/deno.json supabase/functions/tick/index.ts` -- expected: clean; the mention composer is reachable from the tick.

**Manual checks:**
- The co-manager spot-check `BMAD-EFFORT-TRIAGE.md` names for this story: read the composed body for a co-managed Team and confirm two distinct `<@id>` appear, not one Team name.
- `git status --short` before review — confirm no new file is left untracked, so the whole diff reaches the reviewers.

## Suggested Review Order

**What a mention says, and why it sits where it does**

- The entry point: one line per affected Team, appended under that event's own notice.
  [`mention.ts:204`](../../src/lib/adapters/discord/mention.ts#L204)

- The reason the whole story exists — the clause a displaced Manager actually reads.
  [`mention.ts:142`](../../src/lib/adapters/discord/mention.ts#L142)

- Grouped per Team so a five-event post says which line is whose; flat for the phase.
  [`mention.ts:245`](../../src/lib/adapters/discord/mention.ts#L245)

- The suffix joined to the notice it belongs to — the placement decision, in code.
  [`outbox.ts:1142`](../../src/lib/server/outbox.ts#L1142)

**Who was affected, decided where it is known**

- The displaced leader, on no payload and alive only in the folded state.
  [`bidding.ts:427`](../../src/lib/server/bidding.ts#L427)

- The leader and the nominating Team; `AuctionClosedPayload` names the winner and could not answer this.
  [`close.ts:195`](../../src/lib/server/close.ts#L195)

- Optional-chained because a throw in `enqueue` would roll back a valid close.
  [`close.ts:205`](../../src/lib/server/close.ts#L205)

- The whole league, as a sentinel expanded inside the same transaction — never in the drain.
  [`phase-end.ts:184`](../../src/lib/server/phase-end.ts#L184)

**The outbox: one intent per Manager, keyed as 5.1 shaped it**

- The replacement for `enqueueIntents`, taking affected Teams from the write site.
  [`outbox.ts:355`](../../src/lib/server/outbox.ts#L355)

- `EVERY_TEAM`, resolved by SQL rather than enumerated on a tick that usually appends nothing.
  [`outbox.ts:270`](../../src/lib/server/outbox.ts#L270)

- Whole event groups only, so a broadcast row and its mentions never split across passes.
  [`outbox.ts:597`](../../src/lib/server/outbox.ts#L597)

- The snowflake the directory gained, without which a recipient cannot be named.
  [`broadcast.ts:130`](../../src/lib/adapters/discord/broadcast.ts#L130)

**Addressing stayed here; placement left**

- The prepend is gone — the one change that made a batched post legible.
  [`webhook.ts:215`](../../src/lib/adapters/discord/webhook.ts#L215)

- `allowed_mentions` untouched, and narrowed to what the body actually spells.
  [`webhook.ts:228`](../../src/lib/adapters/discord/webhook.ts#L228)

- Truncation cannot leave a ping the body no longer contains.
  [`mention.ts:305`](../../src/lib/adapters/discord/mention.ts#L305)

**The link, and the origin the tick has no request to take**

- A throwing origin costs the link, never the pass.
  [`outbox.ts:1181`](../../src/lib/server/outbox.ts#L1181)

- Read lazily, exactly as the webhook port is, so an idle pass evaluates nothing.
  [`tick/index.ts:217`](../../supabase/functions/tick/index.ts#L217)

**Peripherals**

- The co-manager spot-check this story's triage row names: two snowflakes, not one Team.
  [`discord-mention.test.ts:127`](../../tests/adapters/discord-mention.test.ts#L127)

- The self-displacement silence, asserted on the rule because the gate makes it unreachable.
  [`bidding.test.ts:438`](../../tests/server/bidding.test.ts#L438)

- Winner and nominator as one Team, collapsing to one intent.
  [`close.test.ts:310`](../../tests/server/close.test.ts#L310)
