---
title: 'Story 5.1: The transactional outbox and its dispatcher'
type: 'feature'
created: '2026-09-03'
status: 'done'
review_loop_iteration: 0
baseline_commit: '834743261ddca4bfe914f8e9350eb569b519a06a'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Every notification obligation in the product is currently deferred, because the seam that would carry one does not exist: `enqueue` in `shell/write.ts` and `drain` in `server/sweep.ts` are documented no-ops. Discord is a knowingly accepted single point of failure, so the mechanism must be built such that a Discord outage costs a notification and never a bid.

**Approach:** Add a `notification_outbox` table whose rows are inserted in the same transaction that appends the events they describe, and a dispatcher that drains it inside the existing tick, after the sweep. Delivery state is not stored on the outbox row — it is re-derived from `NotificationDispatched` events appended to the log, which is also how NFR11's dispatch and delivery outcome get recorded from the first notification onward.

## Boundaries & Constraints

**Always:**
- The intent INSERT happens inside the auction transaction; the HTTP delivery never does, and can never fail or reverse an auction action.
- The idempotency key is `(event_seq, channel, recipient)`, enforced by a database `unique` constraint. A co-managed Team therefore yields two intent rows, one per Manager.
- `src/lib/server/outbox.ts` must stay Deno-loadable exactly as `sweep.ts` is (AD-2): relative `.ts` imports only, no `$env`, no `$lib`, no node builtins, no bare runtime specifier. Secrets and `fetch` are injected by the caller.
- The drain never throws out of the tick: its failure is captured as `drainFailure` on the heartbeat, and every close in the pass still stands.
- Retry backoff and the per-pass request budget live in the shell, never in `src/lib/core/` (AR-3).
- Every outbound payload sets `allowed_mentions` explicitly.

**Ask First:**
- Any change to `src/lib/core/**`. This story should need none.
- Granting `update` or `delete` on any table — no table in this repo does, and the design is built to avoid needing it.

**Never:**
- No pgmq, and no second cron schedule or Edge Function (AD-10) — the drain runs in the existing tick.
- No message composition, no mention text, no event-type-to-copy mapping: that is 5.2 and 5.3. This story ships the mechanism and a generic payload.
- No mute/settings logic (5.4), no Commissioner screen (deferred by user decision 2026-09-03), no backlog detector (8.2).
- No `PUBLIC_`-prefixed name for the webhook URL.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Team-affecting event, co-managed Team | One appended event with `team_id` T; two `managers` rows share T | Two intent rows inserted in the same transaction; the drain dispatches two mentions | N/A |
| Retry of the same tick | The pass above re-runs | Zero further dispatches — the successful `NotificationDispatched` events remove both from the pending set | N/A |
| Discord returns 429 | Pending intent, response carries `Retry-After` | Intent stays pending; a failed `NotificationDispatched` records `retryAfterMs`; the next attempt waits at least that long | Never dropped |
| Delivery throws or returns 5xx | Pending intent, webhook unreachable | Auction events and closes stand unchanged; the attempt is recorded as failed and retried with backoff | `drainFailure` on the heartbeat |
| Sweep closes many Auctions at once | More pending intents than the per-pass budget | At most the budget's worth of requests this pass; the remainder stay pending and go next pass | Every intent eventually delivered |
| A `NotificationDispatched` event is appended | The dispatcher's own outcome write | No intent is created for it — no feedback loop | Structural, not conditional |
| Event with a null `team_id` | A system-originated event | No mention intent | N/A |
| A rejected write | `decide` returns `rejected` | Neither events nor intents are persisted | Transaction rolls back |

</frozen-after-approval>

## Code Map

- `src/lib/shell/write.ts` -- `EnqueueFn` (:88) fires AFTER `COMMIT` (:315-321), which contradicts AD-17. Move the call inside the transaction, after the projections loop (:284-286) and before `COMMIT` (:288); widen the signature to `(client, appended)` matching `ProjectionUpdater` (:78-81). `EnqueueError` (:107-117) becomes meaningless once the call is transactional — delete it; nothing outside `tests/shell-write.test.ts` references it.
- `src/lib/server/sweep.ts` -- `DrainFn` (:223), invoked at :400-407 with its failure captured into `drainFailure` (:425) and reported by `detailFor` (:548-550). **No change needed** — the seam already matches AC-2. Its header (:80-90) and the dual-runtime rule (:6-13) are the constraints to honour.
- `supabase/functions/tick/index.ts` -- the empty `drain: () => {}` at :127-129 is the one wiring point. Reads secrets via `Deno.env.get` (:81); `gateway.ts:53-60` `required()` is the pattern for a mandatory variable.
- `supabase/migrations/20260821020000_auction_events.sql` -- **insert-only**: `service_role` holds `select, insert` only (:103-104), so `dispatch_outcome`/`delivery_outcome` (:71-73) can never be back-filled onto an existing row. They are populated on the dispatcher's own appended event instead.
- `supabase/migrations/20260821000000_managers.sql` -- `discord_user_id text not null unique` (:31). `managers.team_id` is nullable, and two rows may share one `team_id` — that is co-management, per the column comment in the teams migration (:70).
- `supabase/migrations/20260828000000_contention_seeds.sql` -- the new-table template: `create table if not exists` (:42), `comment on` (:61-65), RLS enable and force (:67-68), then `revoke all` from `anon`/`authenticated` (:77-78) and from `service_role` (:88) before granting back. No `create policy`.
- `supabase/migrations/20260831000000_tick.sql` -- one `cron.schedule`, 10 seconds, created inactive (:180-237). Do not add another.
- `tests/structure.test.ts` -- `src/lib/adapters/discord` is in `wouldBeEmpty` (:174-178), so its `.gitkeep` is REQUIRED until a real file lands; the deletes-the-marker list is :198-217. Moving the entry and deleting the marker happen together, or the suite fails either way (the AGENTS.md pitfall).
- `tests/shell-write.test.ts` -- local `fakeGateway()` (:23-85) regex-matches SQL and records step order; the pipeline-order assertion is :95-120, the `EnqueueError` suite :376-410.
- `tests/server/sweep.test.ts` -- drain ordering (:609-627) and `drainFailure` (:629-651) are already asserted; keep them green.
- `tests/adapters/fantrax-pool.test.ts` -- the adapter-test shape: flattened filename, pure string-in/struct-out, zero I/O.
- `src/lib/server/auth.ts` -- `DiscordOAuthPort` (:142-152) is the house injected-port pattern; `tests/auth.test.ts:83-103` fakes it by hand. There is no `vi.mock` or `vi.stubGlobal` anywhere in the repo — follow suit.
- `.env.example` -- `DISCORD_WEBHOOK_URL` (:39) and `DISCORD_GUILD_ID` (:40) are already declared.

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260903000000_notification_outbox.sql` -- create `notification_outbox` on the contention-seeds template: identity PK, `event_seq bigint not null references auction_events(seq)`, `channel text not null`, `recipient text not null`, `created_at timestamptz not null`, `unique (event_seq, channel, recipient)`, non-blank checks, RLS enabled and forced, no policy, `revoke all` from all three roles then `grant select, insert to service_role`. Comment the table with why it is insert-only and where delivery state lives.
- [x] `src/lib/shell/write.ts` -- move `enqueue` inside the transaction (after projections, before `COMMIT`), widen it to `(client, appended)`, delete `EnqueueError`, and rewrite the header comment so it states the AD-17 contract it now actually implements.
- [x] `src/lib/server/outbox.ts` -- new, Deno-loadable. `enqueueIntents(client, appended)`: one row per appended event carrying a non-null `team_id`, per Manager of that Team. `drainOutbox(gateway, ports)`: select pending intents (outbox rows with no successful `NotificationDispatched` whose backoff has elapsed), cap at the per-pass budget, batch by channel, deliver through the injected port, then append one `NotificationDispatched` per intent — via `runTransactionalWrite` with **no** `enqueue` argument, so an outcome event can never spawn its own intent.
- [x] `src/lib/adapters/discord/webhook.ts` -- new. A `DiscordWebhookPort` interface plus a `fetch`-backed implementation: POST the batched content, always set `allowed_mentions`, and translate a 429 into a typed result carrying `retryAfterMs` rather than throwing.
- [x] `src/lib/adapters/discord/.gitkeep` -- delete, and in the SAME change move `'src/lib/adapters/discord'` in `tests/structure.test.ts` from `wouldBeEmpty` (:174-178) to the deletes-the-marker list (:198-217).
- [x] `supabase/functions/tick/index.ts` -- replace the empty `drain` with `drainOutbox`, reading `DISCORD_WEBHOOK_URL` through `required()`, and restate the sweep-then-drain order in the comment.
- [x] `tests/shell-write.test.ts` -- update the order assertion to `enqueue` before `commit`, prove a throwing enqueue now rolls back and persists nothing, and delete the `EnqueueError` suite.
- [x] `tests/server/outbox.test.ts` -- new. Cover every I/O Matrix row against a local fake gateway in the `sweep.test.ts` style, including the co-manager pair, the same-tick retry, the 429 backoff and the budget cap.
- [x] `tests/adapters/discord-webhook.test.ts` -- new. Payload shape, `allowed_mentions` always present, and 429 to `retryAfterMs`, with a hand-built `Response` stub and no global patching.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- append one entry: the Commissioner-visible screen for dispatcher failures, owned by 7.5/8.2, with the evidence that failures are already durably recorded and structurally unreadable by Managers.

**Acceptance Criteria:**
- Given an accepted write, when it commits, then its intent rows committed with it in the same transaction.
- Given a delivery that fails for any reason, when the tick completes, then every Auction closed in that pass still stands, and the failure appears only in `tick_heartbeats` and the event log — neither readable by `anon` or `authenticated`.
- Given the whole story, when `npm test`, `npm run check` and the tick's `deno check` are run, then all three pass.

## Spec Change Log

## Design Notes

**Why a hand-rolled table, not pgmq (AC-6, recorded).** pgmq is not installed, and every extension here is justified in the migration that adds it. Decisively: the AC's key is a declarative `unique (event_seq, channel, recipient)`, which a table expresses and pgmq's visibility-timeout lease cannot. AD-17's contract holds unchanged either way.

**Why delivery state is not a column.** No table in this repo grants `update` to any role. Re-deriving pending state from the log instead is the discipline `sweep.ts` already states — "re-derives, never remembers" — which makes restart-safety structural rather than tested for. It also satisfies NFR11 for free, since the outcome has to be an appended event anyway: `auction_events` cannot be back-filled.

**The exactly-once boundary, stated honestly.** Exactly-once holds at the intent level: the unique constraint prevents duplicate intents and the derived pending set prevents re-dispatch. A crash between a successful POST and its recorded outcome can still redeliver one message — the standard floor for a non-idempotent HTTP sink. Epic 8's rehearsal is where that becomes observable.

**Batched, with a per-pass budget (AC-7, recorded).** The tick runs every 10 seconds, so six passes a minute. The budget caps **intents** drained per pass at five; because the drain collapses every due intent on a channel into one POST, the resulting **request** rate is at most one per channel per pass — six a minute with the single `discord` channel, well under the documented 30/min ceiling rather than merely equal to it.

*Corrected at step-04 review, 2026-09-03.* This note originally read "five requests per pass stays under 30/min", which conflated the intent cap with a request cap and computed a rate the code does not produce (5 x 6 = 30 is also not *under* 30). No code changed for this correction — the implementation was always the more conservative of the two readings. The looser figure becomes load-bearing only if a later story batches per recipient instead of per channel, which is recorded in `deferred-work.md` as 5.2/5.3's to revisit; the ceiling must be re-derived at that point, and again at the Epic 8 rehearsal where burst behaviour first becomes observable.

## Verification

**Commands:**
- `npm test` -- expected: all pass, including the existing drain-ordering and `drainFailure` suites in `tests/server/sweep.test.ts`.
- `npm run check` -- expected: no type errors.
- `npx deno check --config supabase/functions/tick/deno.json supabase/functions/tick/index.ts` -- expected: clean. **CI does not run this** (`.github/workflows/ci.yml` deno-checks `src/lib/core` only), so a Deno-breaking import in `outbox.ts` would otherwise reach production unnoticed.

**Manual checks:**
- `git status --short` before review — confirm no new file is left untracked, so the whole diff reaches the reviewers.

## Suggested Review Order

**The contract: intents commit with their events**

- The whole story in one line — the outbox insert now happens before `COMMIT`, not after.
  [`write.ts:301`](../../src/lib/shell/write.ts#L301)

- The seam's new signature, widened to take the transaction's own client.
  [`write.ts:116`](../../src/lib/shell/write.ts#L116)

- One intent per Manager of the event's Team; two rows for a co-managed Team.
  [`outbox.ts:220`](../../src/lib/server/outbox.ts#L220)

**The idempotency key, enforced by the database**

- AD-17's key as a real constraint — `recipient` is in it so a co-Manager is never deduplicated away.
  [`20260903000000_notification_outbox.sql:79`](../../supabase/migrations/20260903000000_notification_outbox.sql#L79)

- Insert-only, like every other table here: no `update`, no `delete`, so no delivery state lives on the row.
  [`20260903000000_notification_outbox.sql:132`](../../supabase/migrations/20260903000000_notification_outbox.sql#L132)

- The same key in TypeScript, injective and printable after review replaced a NUL separator.
  [`outbox.ts:281`](../../src/lib/server/outbox.ts#L281)

**Pending is re-derived, never remembered**

- The pure derivation: what is due now, given intents, prior attempts and the clock.
  [`outbox.ts:306`](../../src/lib/server/outbox.ts#L306)

- Three reads in one transaction, so the snapshot the docstring promises is real.
  [`outbox.ts:554`](../../src/lib/server/outbox.ts#L554)

- Why the cap is five, and why that bounds message size rather than request rate.
  [`outbox.ts:129`](../../src/lib/server/outbox.ts#L129)

**Delivery, and why it can never fail an auction**

- The drain itself: read, batch, post, record — none of it inside the auction transaction.
  [`outbox.ts:476`](../../src/lib/server/outbox.ts#L476)

- One transaction per outcome, so a partial failure redelivers one message and not the pass.
  [`outbox.ts:744`](../../src/lib/server/outbox.ts#L744)

- NFR11's dispatch and delivery outcome, appended — the insert-only log cannot be back-filled.
  [`outbox.ts:685`](../../src/lib/server/outbox.ts#L685)

**The Discord boundary**

- `allowed_mentions` unconditional, so a message body can never decide who gets pinged.
  [`webhook.ts:196`](../../src/lib/adapters/discord/webhook.ts#L196)

- A 429 becomes a typed result carrying `retryAfterMs`, never a throw.
  [`webhook.ts:287`](../../src/lib/adapters/discord/webhook.ts#L287)

**Wiring, and the gate that proves it loads**

- The drain wired into the existing tick — no second schedule, no second function.
  [`index.ts:190`](../../supabase/functions/tick/index.ts#L190)

- The port built lazily, so an unset webhook URL cannot fail a pass with nothing to send.
  [`index.ts:134`](../../supabase/functions/tick/index.ts#L134)

- The tick's Deno check, added to CI — previously nothing machine-verified AD-2 outside `core/`.
  [`ci.yml:127`](../../.github/workflows/ci.yml#L127)

**Peripherals**

- The `.gitkeep` trap: the marker moves lists and is deleted in the same change.
  [`structure.test.ts:215`](../../tests/structure.test.ts#L215)

- An expiring "is the last migration" assertion replaced by the dependency it stood for.
  [`watermark.test.ts:458`](../../tests/watermark.test.ts#L458)
