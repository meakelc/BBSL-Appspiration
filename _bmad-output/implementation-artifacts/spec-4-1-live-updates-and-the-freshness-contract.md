---
title: 'Story 4.1: Live updates and the freshness contract'
type: 'feature'
created: '2026-09-01'
status: 'done'
baseline_commit: '123a1533aba4c603a341a5918d3a796ffc681e2a'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-BBSL-Appspiration-2026-08-16/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Every surface renders money computed at page load and then never says another word about it. A Manager whose connection dropped twenty minutes ago still reads `$14.0M` as though it were current, and bids against it. Nothing in the product today derives, renders or announces the age of what it shows, and there is no push channel at all — every figure is as old as the last manual refresh.

**Approach:** Give every projection read one global watermark — the highest `auction_events.seq` — published through a single client-readable row so a browser can both subscribe to it and re-read it. Derive exactly one of three freshness states in the pure core from channel status *and* a positive liveness check together, and make non-Live states change what the surface is allowed to claim: figures carry their age, and in Stale the bid and Nomination controls disable with the reason stated.

## Boundaries & Constraints

**Always:**
- One watermark, one source: the `seq` sequence on `auction_events`. Never a per-table stamp, never a second derivation.
- Liveness is an explicit periodic re-read that asks *"can I reach the server?"* — never *"has anything changed?"*. Silence is not evidence of staleness.
- `FRESHNESS_WINDOW` and `STALE_WINDOW` are consumed from `core/constants.ts`; any new window or interval is named there too.
- The three-state derivation is a pure function in `src/lib/core/` with `now` injected (AD-1, AD-3). No `Date`, no timers, no channel objects inside it.
- The client key stays read-only (AD-9). The browser subscribes and reads; it never writes.
- Countdowns keep running in every state — they derive from absolute close instants already held.
- Recovery to Live is silent: controls restore with no dialog and no announcement.
- The watermark row exposes one integer and nothing else. `select` goes to `authenticated` only — never to `anon`, and never on any other table (AD-16).
- Neither Supabase project is provisioned, so `connect-src` stays `'self'` and `tests/headers.test.ts` keeps pinning it. The socket host is derived from `PUBLIC_SUPABASE_URL` so that naming it later is a one-line widening; a wildcard host is never acceptable.
- A CSP-blocked socket must degrade, never crash. It presents as a channel error, the same-origin liveness poll keeps working, and the app sits honestly in Reconnecting.

**Ask First:**
- Any change to the 30s / 120s window values, which `core/constants.ts` invites this story to renegotiate.
- Any client-role grant beyond `select` on the single watermark row.

**Never:**
- The Bid Board (4.3), the persistent strip (4.2), Your Positions (4.4) or the Teams index (4.6). This story ships the contract and wires it into the surfaces that exist today — the Auction page and Nominate.
- Granting any client role `select` on `auction_events` or any projection table.
- Freezing a countdown, dropping a figure, or blanking a surface on degradation.
- Announcing Live, or announcing anything on recovery.
- Inferring staleness from the absence of pushed messages.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Live | channel `SUBSCRIBED`, last liveness ok 5s ago | `live`; nothing announced, controls unchanged | N/A |
| Quiet auction | channel `SUBSCRIBED`, liveness ok 5s ago, watermark unchanged for 6h | `live` — silence alone never degrades | N/A |
| Channel silently dead | channel `SUBSCRIBED`, last liveness ok 45s ago | `reconnecting`; figures carry their age | N/A |
| Channel dropped | channel `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED`, liveness ok 5s ago | `reconnecting` | N/A |
| Stale | no successful liveness within `STALE_WINDOW` | `stale`; bid + Nomination controls disabled with the reason stated; Maximum Bid labelled last-known; announced | N/A |
| Recovery | `stale` → channel `SUBSCRIBED` and liveness ok | `live` immediately, silently | N/A |
| Signed-out visitor | no session | the contract does not run at all — no channel, no poll, no notice, no announcement | N/A: there are no figures to protect and no controls to disable |
| Liveness endpoint, signed out | a session that lapsed mid-visit | `401`, no watermark disclosed | client treats as a lapsed check, not a crash — the figures on screen genuinely are no longer refreshable |
| Liveness endpoint, database unreachable | read throws | `503` | client treats as a lapsed check; state degrades on schedule |
| Socket blocked by CSP (production, until the projects exist) | subscribe rejected | channel error → `reconnecting`; poll still succeeds so it never reaches Stale | no crash, no unhandled rejection |
| Empty log | no `auction_events` rows | watermark `'0'`; freshness derives normally | N/A |

</frozen-after-approval>

## Code Map

- `src/lib/core/constants.ts:56-59` -- `FRESHNESS_WINDOW` (30s) and `STALE_WINDOW` (120s) already exist, named for AD-29, and the docstring invites this story to renegotiate them. Add the poll interval here.
- `src/lib/core/instant.ts:88,133,173` -- `parseInstant` / `formatInstant` / `relativePhrase`. `relativePhrase(figuresAt, now)` is exactly the "as of 2 minutes ago" rendering; do not write a second one.
- `src/lib/core/projection/fold.ts:41` -- `fold(state, events, reducer)`, ordered by `seq` via `BigInt`. The watermark reducer follows this shape; the `BigInt` comparison is the pattern to copy (`seq` is a string).
- `src/lib/server/phase.ts` + `src/hooks.server.ts:44` -- `resolveLeaguePhaseOrDefault()` already folds the whole log once per request into `locals.phase`. The watermark comes off that same events array — one read, no extra query.
- `src/routes/+layout.server.ts:16-19` -- the one load every page inherits. Watermark and the server instant ride here.
- `src/lib/server/event-log.ts:63,124` -- `loadAppendedEvents` (PostgREST, paginated) and `loadEventsViaClient` (in-transaction). The liveness endpoint must use neither: it needs `select max(seq)`, not a full-log read.
- `src/lib/server/supabase.ts:45,56,77` -- `supabaseUrl()`, `serviceRoleClient()`, `requestClient()`. `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` are declared in `.env.example` but no browser client exists yet.
- `src/routes/auction/[fantraxPlayerId]/+page.svelte:265-320` -- the existing client tick: `elapsedMs` `$state` plus a `$effect` interval anchored on `control.figuresAt`, deliberately never reading the device wall clock for the origin. Reuse this anchoring discipline; do not disturb the countdown.
- `src/routes/auction/[fantraxPlayerId]/+page.svelte:322-400` -- `gateState` / `blocked` / `reason`: the existing disabled-control-with-stated-reason pattern the Stale gate must join rather than duplicate.
- `src/routes/nominate/+page.svelte` + `+page.server.ts` -- the second control the AC names.
- `src/lib/shell/write.ts:164-200` -- the single `insert into auction_events`. The Deno tick (`supabase/functions/tick/`) inserts through its own gateway, so a **database trigger** is the only mechanism that covers both runtimes by construction.
- `supabase/config.toml:52-53` -- `[realtime] enabled = false`. Must become `true` or nothing can be exercised locally.
- `netlify.toml:84-90,105` -- `connect-src 'self'`, with a comment already describing exactly how the socket is admitted later; `tests/headers.test.ts:160-166` pins it. `deferred-work.md:91` stays OPEN — both projects are still unprovisioned, so this story updates the two comments to name it as blocking rather than merely anticipated, and changes neither the policy nor the assertion.
- `supabase/migrations/20260901000000_system_actor.sql` -- newest migration; the new one sorts after it.
- `src/lib/components/` -- existing home for shared components (`RefusalPanel.svelte`, `CapBreakdown.svelte`). `tests/structure.test.ts:239` records it as a legitimate addition outside the AR-2 tree; a new `src/lib/client/` follows the same precedent.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/constants.ts` -- add `LIVENESS_INTERVAL` (10s), documented against `FRESHNESS_WINDOW` so one missed poll stays Live and two do not -- the poll must be a named constant, not a caller's guess.
- [x] `src/lib/core/freshness.ts` -- new pure module: `ChannelStatus`, `FreshnessState`, and `deriveFreshness({ channel, lastLivenessOkAt, now })`. Stale is decided first, then channel-or-lapsed, then Live -- the whole rule in one testable place, with `now` injected.
- [x] `src/lib/core/projection/watermark.ts` -- new pure fold: `INITIAL_WATERMARK`, `watermarkReducer`, `higherSeq(a, b)` comparing via `BigInt` -- the highest `seq` folded, derived by the same `fold()` every other projection uses.
- [x] `supabase/migrations/20260902000000_watermark.sql` -- single-row `public.auction_watermark(seq bigint)`, an `after insert on auction_events` trigger that raises it, RLS with `select` to `authenticated` only, and membership in the `supabase_realtime` publication -- one integer, readable by signed-in Managers, covering both write runtimes.
- [x] `supabase/config.toml` -- enable `[realtime]` -- the local stack cannot serve a channel while it is off.
- [x] `src/lib/server/phase.ts` + `src/hooks.server.ts` + `src/app.d.ts` -- return the watermark alongside the phase from the events array already folded, into `locals` -- one read per request, one watermark.
- [x] `src/routes/+layout.server.ts` -- expose `watermark` and the server instant to every page -- so a surface built later inherits the contract instead of retrofitting it.
- [x] `src/routes/api/watermark/+server.ts` -- new `GET`, session-guarded, answering `{ watermark, at }` from `select max(seq)` -- the lightweight liveness re-read; never a full-log fold.
- [x] `src/lib/client/freshness.svelte.ts` -- new runes module owning the browser Supabase client, the `auction_watermark` subscription, the `LIVENESS_INTERVAL` poll and `invalidateAll()` on a raised watermark; it holds no rule, only feeds `deriveFreshness`.
- [x] `src/lib/components/FreshnessNotice.svelte` -- renders the non-Live statement and the age via `relativePhrase`; the Stale transition is announced through an assertive live region, and recovery renders nothing.
- [x] `src/routes/+layout.svelte` -- mount the notice once for the whole app -- one freshness state, one age, every surface.
- [x] `src/routes/auction/[fantraxPlayerId]/+page.svelte` -- join Stale into the existing disabled-reason path and label Maximum Bid as last-known when not Live; leave the countdown untouched.
- [x] `src/routes/nominate/+page.svelte` -- same disable-with-reason treatment for the Nomination control.
- [x] `netlify.toml` + `tests/headers.test.ts` -- leave `connect-src 'self'` and its pinning assertion UNCHANGED; update both comments to record that the socket is now shipped and blocked in production pending the project refs -- the widening cannot be written without a host to name, and must not be faked with a wildcard.
- [x] `tests/freshness.test.ts` -- unit-test every I/O matrix row, including the named six-hour-silence case -- the invariant is a negation and nothing in a diff shows it holding.
- [x] `tests/watermark.test.ts` -- fold ordering, the empty log, and `seq` beyond `Number.MAX_SAFE_INTEGER`.

**Acceptance Criteria:**
- Given a page rendered on any route, when its data is inspected, then it carries one watermark from one source and no per-table stamp exists anywhere.
- Given the client is Live, when six hours pass with no event and the liveness check keeps succeeding, then it stays Live and an automated test asserts silence alone can never produce Stale.
- Given the client is Stale, when the surface renders, then bid and Nomination controls are disabled with their reason stated, Maximum Bid is labelled last-known, and the transition was announced.
- Given any non-Live state, when countdowns render, then they continue running from the absolute close instant.
- Given the client returns to Live, when the surface re-renders, then controls restore with no dialog and nothing is announced.
- Given a Bid is placed by another Manager and the socket is admitted, when the watermark row is raised, then subscribed clients reload within 5 seconds without a manual refresh. Verified against the local Supabase stack; production meets it only once `connect-src` is widened.
- Given the socket is blocked, when the client starts, then it reports Reconnecting, keeps polling, never reaches Stale on that account, and throws nothing.
- Given the deployed CSP, when it is read, then `connect-src` is still `'self'` and no wildcard host appears anywhere in the policy.

## Spec Change Log

- **2026-09-01 — the contract does not run for a signed-out visitor.**
  - *Finding:* Acceptance Auditor. `freshness.start()` and `<FreshnessNotice>` were mounted unconditionally in `+layout.svelte`, and the client treats the endpoint's `401` identically to an outage. A signed-out visitor on `/signin` was therefore shown the Stale statement — and an assertive `role="alert"` announcement — two minutes in, claiming the app could not reach a server that was demonstrably reachable.
  - *Root cause:* inside `<frozen-after-approval>`. The I/O matrix specified the `401`-is-a-lapsed-check behaviour and never asked whether the contract should run for a viewer with no session, so the implementation followed the spec faithfully into a false statement.
  - *Amended:* the signed-out matrix row is split in two. A visitor with no session runs no contract at all; the `401` row now governs only a session that lapsed mid-visit, where "these figures are no longer refreshable" is true and worth saying.
  - *Known-bad state avoided:* a surface with no figures and no controls asserting an outage, and firing a screen-reader alert, on the sign-in page.
  - *Resolution:* human chose to amend the spec and keep the code rather than revert and re-derive (2026-09-01). The fix ships as a patch in the same review round.
  - *KEEP:* `deriveFreshness` taking no watermark or event-count input at all — silence is unrepresentable, which is the strongest available form of "silence alone can never produce Stale". The core owning every sentence, so no `.svelte` file words a refusal. `resolveLeagueRead` returning phase and watermark from one log read and two folds. The trigger-maintained watermark row covering both write runtimes. Stale joining the existing `blocked`/`reason` path rather than duplicating it.

## Design Notes

**Why a watermark row rather than subscribing to `auction_events`.** AD-16 revokes every client grant on every table, and the log carries bid amounts, actors and payloads. A single-row table holding one monotonic integer is the smallest thing a browser can subscribe to that still answers "has anything happened", and it makes AD-29's "one source" literally one row. A trigger — not the shell — maintains it, because the Deno tick appends through a different gateway and anything written in `shell/write.ts` alone would miss every close.

**Why the liveness endpoint is same-origin.** It must fail exactly when the app's own figures would be unrefreshable, so it reads through the same Supabase connection the read path uses. A same-origin `GET` also needs no CSP widening of its own, which keeps the `connect-src` change scoped to the socket.

**What production actually gets, until the projects exist.** The socket is blocked by `connect-src 'self'`, so a deployed client sits in Reconnecting: figures carry their age, controls stay enabled, and the board refreshes on the poll rather than the push — honest, degraded, and never wrong about itself. This is why the blocked-socket row is an I/O case rather than a footnote, and why the poll is same-origin: it is the half that still works. Naming the two hosts is the one line that closes it, and `deferred-work.md:91` remains the open record.

**Ordering inside `deriveFreshness`.** Stale is tested before channel status, so a `SUBSCRIBED` channel delivering nothing still degrades — the AC requires insufficiency in both directions. `lastLivenessOkAt` is seeded from the server instant at SSR, so it is never null and a freshly loaded page is never born Stale.

## Verification

**Commands:**
- `npm test` -- expected: all suites pass, including the new freshness and watermark tests, with `tests/headers.test.ts` still green on its unchanged `connect-src` assertion.
- `npm run check` -- expected: 0 errors.
- `npm run check:purity` -- expected: passes with `core/freshness.ts` and `core/projection/watermark.ts` present — no `Date`, no `$lib`, explicit `.ts` specifiers.

**Manual checks (if no CLI):**
- Realtime cannot be exercised by the Vitest suite (node environment, no DOM, and no `.svelte` file is renderable). With `supabase start` and `[realtime]` enabled, place a bid in one browser and confirm a second reloads within 5 seconds; kill the socket and confirm the Reconnecting age appears, then Stale disables the control and announces itself, then recovery is silent.

## Suggested Review Order

**The rule, and why it cannot lie**

- Start here: the whole contract in one pure function, `now` injected, Stale decided first.
  [`freshness.ts:111`](../../src/lib/core/freshness.ts#L111)

- No watermark or event-count input exists, so silence is unrepresentable — the negation made structural.
  [`freshness.ts:111`](../../src/lib/core/freshness.ts#L111)

- The highest `seq` folded, compared as `BigInt` because `seq` crosses `MAX_SAFE_INTEGER`.
  [`watermark.ts:61`](../../src/lib/core/projection/watermark.ts#L61)

- No `switch`, deliberately: an event type it ignored would be an event that happened invisibly.
  [`watermark.ts:76`](../../src/lib/core/projection/watermark.ts#L76)

**One watermark, one source**

- A trigger, not the shell — it is the only thing both write runtimes pass through.
  [`20260902000000_watermark.sql:80`](../../supabase/migrations/20260902000000_watermark.sql#L80)

- Phase and watermark from one log read and two folds; the old resolvers became wrappers.
  [`phase.ts:156`](../../src/lib/server/phase.ts#L156)

- One row read, never the full-log fold — this runs every ten seconds per connected Manager.
  [`watermark.ts:91`](../../src/lib/server/watermark.ts#L91)

- Session-guarded and same-origin, so the liveness half needs no CSP widening.
  [`+server.ts:48`](../../src/routes/api/watermark/+server.ts#L48)

**The two bugs review round 1 caught**

- The fix: the raise decision is taken against the watermark held *before* this response.
  [`freshness.svelte.ts:389`](../../src/lib/client/freshness.svelte.ts#L389)

- Recovery from a backgrounded tab cannot wait on a throttled interval.
  [`freshness.svelte.ts:302`](../../src/lib/client/freshness.svelte.ts#L302)

**The contract does not run for a signed-out visitor**

- A boolean and nothing more; no manager, no team, no role reaches the browser.
  [`+layout.server.ts:47`](../../src/routes/+layout.server.ts#L47)

- Both the mount and `start()` are gated — there are no figures to protect.
  [`+layout.svelte:76`](../../src/routes/+layout.svelte#L76)

**What the surfaces are allowed to claim**

- Stale joins the existing `blocked`/`reason` path rather than duplicating it.
  [`+page.svelte:394`](../../src/routes/auction/[fantraxPlayerId]/+page.svelte#L394)

- The region is always present and empty except in Stale, so recovery announces nothing.
  [`FreshnessNotice.svelte:85`](../../src/lib/components/FreshnessNotice.svelte#L85)

**Tests, config and the peripherals**

- The poll driven through injected ports; the regression guard for the reload bug.
  [`freshness.test.ts:514`](../../tests/freshness.test.ts#L514)

- Channel callbacks invoked directly — status mapping, and a throw that must not escape.
  [`freshness.test.ts:635`](../../tests/freshness.test.ts#L635)

- The endpoint's 401 and 503 rows driven through the handler, not matched in source.
  [`watermark.test.ts:356`](../../tests/watermark.test.ts#L356)

- `connect-src` and its pinning assertion unchanged; only the comments now say "blocking".
  [`netlify.toml:105`](../../netlify.toml#L105)
