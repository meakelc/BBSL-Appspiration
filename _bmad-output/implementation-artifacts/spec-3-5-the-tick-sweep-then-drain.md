---
title: 'Story 3.5: The tick — one cron, one function, sweep then drain'
type: 'feature'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'b3ec52e48889e92d2ec1b3a3f373cc390b149e27'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `closeAuction` (`src/lib/server/close.ts:146`) closes exactly one Auction and nothing calls it. There is no scheduled work in this repository at all — no `pg_cron` schedule, no `pg_net`, no Edge Function (`supabase/functions/tick/` holds only a `.gitkeep`), and `supabase/config.toml`'s `[edge_runtime] enabled = false` says so out loud. An expired Auction therefore stays expired-but-unrecorded forever: AD-12 keeps it *correct* — bids are refused as expired — but nobody is ever awarded the Player, which is the SM-1 failure. AD-10, AD-11, AD-19 and AD-20 own mechanisms that exist nowhere.

**Approach:** **One sweep module, two runtimes.** The sweep is ordinary TypeScript in `src/lib/server/sweep.ts` — relative `.ts` imports only, so Deno loads the same file Node unit-tests — and `supabase/functions/tick/` is a thin Deno entry point that supplies a `ConnectionGateway` over a direct Postgres connection and calls it. The sweep **re-derives** the overdue set from the folded log on every pass and closes one Auction at a time in AD-11's order, each through its own `closeAuction` transaction, so the next close sees the previous one committed and a crash mid-pass loses nothing. One `pg_cron` schedule at a 10-second interval — ~259K invocations/month, AD-10's own arithmetic — POSTs the function; the drain is ordered after the sweep as a named no-op seam, exactly as `enqueue` is in `shell/write.ts:22`.

## Boundaries & Constraints

**Always:** **The sweep re-derives, never remembers** — the overdue set is a pure function of the folded `auctionsReducer` state and the database clock, and a closed Auction leaves `auctions.byPlayer`, so restart-safety is structural rather than tested for. **Closes are sequential**: ascending `closesAt`, ties broken by `fantraxPlayerId`, each in its own locked transaction, each re-folding the log. **The `now` handed to the core is that Auction's own nominal expiry** — `decideClose(state, auction.closesAt, …)` — while the database clock stays the event's `occurredAt` and becomes the shell's explicit overdue guard through the same `hasExpired` (`projection/auctions.ts:906`); one derivation, two call sites, the way `closedWinnerFor` already is. **One schedule, one function, sweep THEN drain**, never on Netlify, no in-memory timer. **The lock is `GLOBAL_WRITE_LOCK_KEY` at one-argument arity**, taken by `runTransactionalWrite` per close and by no second mechanism. **Every pass writes a heartbeat row**, including a refused or failed pass — a pass that recorded nothing is indistinguishable from a dead tick. **The version gate runs before anything is closed**: the tick's `CORE_VERSION` must equal the `core_version` of the newest `auction_events` row, or the pass refuses, records the refusal on the heartbeat and closes nothing. **One Auction's failure must not abort the pass** — it is recorded and the sweep continues to the next.

**Ask First:** Any migration beyond the one this spec names. Any change to `runTransactionalWrite`'s pipeline or to `decideClose`'s signature. Enabling the cron schedule in any project, or creating the Vault secret it reads. Any new npm dependency. Adding an event type.

**Never:** **No draw** (3.6) — an expired Minimum-Bid Contention is **skipped** with a recorded reason rather than closed or thrown on, because `closedWinnerFor` has no drawer and one un-drawable lottery must not stall every other close. **No pause check** — Epic 7 owns pause, and no pause event or flag exists to read, so a check written now would be unverifiable; log it to `deferred-work.md` with AD-13 named. **No outbox and no Discord** (Epic 5.1): the drain is a documented seam that runs after the sweep and whose throwing cannot undo a committed close. **No League Clock evaluation and no phase end** (3.7). **No terminated unbid Nominations** (3.7 — they are not in `auctions.byPlayer` at all). **No §10 example is added**, and that is recorded in `tests/structure.test.ts` the way Story 3.1's absence was: 8 and 11 are 3.6's, 13 and 27 are 3.7's. **No secret in a migration or in any committed file.** No external heartbeat detector (8.2). No surface. No hand-edit of `planning-artifacts/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Nothing overdue | No Auction's `closesAt` has passed | Zero closes. One heartbeat row, `outcome: 'ok'`, `closed: 0` | N/A |
| Two overdue, out of order | A closes 09:00, B closes 08:00 | B closes first, then A — two transactions, two commits, B's event `seq` lower | N/A |
| Tie on expiry | A and B share `closesAt`; ids `p-9`, `p-2` | `p-2` closes first. Ties break on `fantraxPlayerId` ascending, never on map order (AD-1) | N/A |
| AD-11 sequential proof | Team M has 1 free Minor League Slot and wins 2 eligible Players expiring in order | First → `minor_league` at `$0` Cap Hit; second → `active_bench` at the full amount | N/A |
| `now` for the core | Sweep runs six hours late | `decideClose` receives `auction.closesAt`; payload byte-identical to an on-time close. The event's `occurredAt` is the transaction clock | N/A |
| Not actually overdue | A selected Auction's `closesAt` has not passed at its own transaction's clock | **Throws** out of `closeAuction` before any event is built; recorded, pass continues | throws, caught per-Auction |
| Restart mid-sweep | Pass aborts after the first of three closes | The next pass re-derives: the closed one is gone from `byPlayer`, the other two close exactly once each. No duplicate, no miss | N/A |
| Live lottery expired | `contention: 'minimum_bid'`, overdue | **Skipped** and counted on the heartbeat with Story 3.6 named. Every other overdue Auction still closes | N/A |
| Core version drift | Newest `auction_events.core_version` is 2, tick carries 1 | Pass refuses before any close. Heartbeat `outcome: 'refused_version_mismatch'`, naming both numbers | N/A |
| Empty log | No `auction_events` rows | No version to compare and nothing to close. Heartbeat `outcome: 'ok'` | N/A |
| Drain throws | Sweep closed 2, drain seam throws | Both closes stand — they are committed. The heartbeat records the sweep result and the drain failure | caught, recorded |
| Bad invocation secret | Request lacks or mismatches `TICK_INVOCATION_SECRET` | `401`. No connection opened, no heartbeat, no close | rejected |

</frozen-after-approval>

## Code Map

- `src/lib/server/close.ts:146` — `closeAuction(gateway, fantraxPlayerId)`. Line 161 passes the database clock to `decideClose`; that is the line that becomes the Auction's own `closesAt`, plus a shell-side `hasExpired` guard on the database clock.
- `src/lib/core/rules/close.ts:361` — `decideClose(state, now, winner)`. Its comment at `:389` already states that `now >= closesAt` is "Story 3.5 handing an Auction its own nominal expiry". Signature unchanged.
- `src/lib/core/rules/close.ts:185` — `closedWinnerFor`; throws on a live `minimum_bid` with `winner: null`. The sweep must skip those *before* calling `closeAuction`.
- `src/lib/core/projection/auctions.ts:906` — `hasExpired(closesAt, now)`, `now >= closesAt`. `:185` the `Auction` type (`fantraxPlayerId`, `contention`, `closesAt`); `:237` `OpenAuctions.byPlayer`; a closed Auction leaves the record (3.4). The new `overdueAuctions()` belongs here, beside them.
- `src/lib/shell/write.ts:207` — `runTransactionalWrite`. `:133` `LOCK_AND_CLOCK_SQL` takes `GLOBAL_WRITE_LOCK_KEY` at one-argument arity and reads `now()` in the same round trip; `:88` `EnqueueFn` is the precedent for a documented no-op seam. This module imports only `core/`, so it is already Deno-loadable.
- `src/lib/shell/db.ts:35` — `writePool`/`writeGateway`, the Node `ConnectionGateway`. Node-only (`pg`, `$env/dynamic/private`), so the Deno side needs its own implementation of the same port.
- `src/lib/server/event-log.ts:25` — `loadEventsViaClient`, and the close chain's one bare specifier: a type-only `import type { SupabaseClient } from '@supabase/supabase-js'`, erased at transpile. Map it in `deno.json` as insurance.
- `src/lib/core/constants.ts:103` — `CORE_VERSION = 1`, whose doc comment already states this story's fail-stop; `:120` `GLOBAL_WRITE_LOCK_KEY` and its one-arity rule.
- `supabase/migrations/20260828000000_contention_seeds.sql` — the migration house style: reasoning in comments, RLS forced, `revoke all` from `anon` and `authenticated`, then an explicit `service_role` grant.
- `supabase/config.toml` — `[edge_runtime] enabled = false`, with a comment naming "Epic 3's tick, which does not exist yet". Both change.
- `supabase/functions/tick/.gitkeep` — delete. `tests/structure.test.ts:133` lists the directory under `wouldBeEmpty`; `:158` is the list it moves to.
- `tests/structure.test.ts:40,58` — where each story records which §10 examples it added. 3.5 adds none.
- `tests/server/close.test.ts:43` — `fakeGateway`, the stateful recording `ConnectionGateway` the sweep tests reuse.
- `tests/integration/auction-events.test.ts:33` — the `describe.skipIf` real-Postgres pattern and `LOCAL_DB_URL`.
- `scripts/check-pins.js:27` — `PINNED_PACKAGES`, exact literals only. Extend to the Deno import map.
- `.env.example:48` — `TICK_INVOCATION_SECRET`, already named and unused; `:30` `SUPABASE_DB_URL`.
- Read-only evidence: `deferred-work.md` records the League Clock fold as having "the Epic 3 close sweep" as its first reader. **That reader is Story 3.7, not this story** — this sweep never evaluates the League Clock.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/auctions.ts` — add `overdueAuctions(auctions, now): readonly Auction[]`, every entry with `hasExpired(closesAt, now)`, sorted ascending `closesAt` then `fantraxPlayerId` — AD-11's order is an input to the outcome, so it is derived once, purely, over an explicitly sorted sequence (AD-1).
- [x] `src/lib/server/close.ts` — hand `decideClose` the Auction's own `closesAt`, and guard overdue-ness inside `decide` against the transaction clock with the same `hasExpired` — the AC's "`now` is that Auction's own nominal expiry" made structural without duplicating the rule.
- [x] `src/lib/server/sweep.ts` — new. `runTick({ gateway, closeOne, drain })`: version gate, re-derive the overdue set, close one at a time recording per-Auction outcomes, skip live lotteries, then drain, then write the heartbeat — one sweep loaded unchanged by both runtimes (AD-2), so relative `.ts` imports only, no Node builtins, no `$env`.
- [x] `supabase/migrations/20260831000000_tick.sql` — new. The `pg_cron` and `pg_net` extensions, the `tick_heartbeats` append-only table (RLS forced, `anon`/`authenticated` revoked, `service_role` granted `select, insert`), and one `cron.schedule` at a 10-second interval created **inactive**, POSTing the function with the invocation secret read from Vault by name — AD-19's heartbeat and AD-10's single schedule; inactive-by-default is the AC's "dev's schedule is disabled by default".
- [x] `supabase/functions/tick/index.ts` — new. Verify `TICK_INVOCATION_SECRET`, build the gateway, call `runTick`, answer with the pass summary — the thin Deno shell; all judgement stays in `sweep.ts`.
- [x] `supabase/functions/tick/gateway.ts` — new. A `ConnectionGateway`/`TransactionalClient` over a Deno Postgres client on `SUPABASE_DB_URL` — `shell/db.ts`'s Node-only twin, implementing the identical port so `runTransactionalWrite` is untouched.
- [x] `supabase/functions/tick/deno.json` — new. An exactly-pinned import map for the Postgres driver and `@supabase/supabase-js` — this repository does not float pins.
- [x] `supabase/functions/tick/.gitkeep` — delete. The directory now holds real files (AGENTS.md's named pitfall).
- [x] `supabase/config.toml` — set `[edge_runtime] enabled = true` and replace the comment saying the tick does not exist — `supabase functions serve` is now a real local workflow.
- [x] `scripts/check-pins.js` — assert every version in the tick's `deno.json` is an exact literal — a ranged Deno dependency is the same drift this gate exists to stop.
- [x] `tests/structure.test.ts` — move `supabase/functions/tick` from `wouldBeEmpty` to the marker-deleted list, and record that 3.5 added no §10 example — both halves of the `.gitkeep` trap move together or neither does.
- [x] `tests/core/auctions-overdue.test.ts` — new. Ordering, ties, the boundary instant, and that a closed Auction is absent — the ordering is an input to the outcome.
- [x] `tests/server/sweep.test.ts` — new. Every I/O Matrix row over `tests/server/close.test.ts`'s fake gateway: the restart-mid-sweep pass, the version fail-stop, the lottery skip, the drain-after-sweep ordering, and the heartbeat on every path.
- [x] `tests/server/sweep-sequential.test.ts` — new. The AD-11 proof: the sequential sweep places the second eligible win in Active/Bench, **and the same set folded against one loaded snapshot places both in minors and fails** — the AC requires the batch shape to fail a test, not merely to be avoided.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` — append the pause-check entry (AD-13) and the external-detector entry (AD-19, Story 8.2) — known gaps are logged with evidence, never built unprompted.
- [x] `supabase/functions/tick/auth.ts` — new, added during the step-03 matrix audit. The invocation-secret comparison, extracted out of `index.ts` and taking both secrets as arguments — `index.ts` calls `Deno.serve` at module scope, so Vitest cannot import it, and the tick's one security boundary would otherwise ship with no automated proof. `index.ts` keeps the two genuinely Deno-specific reads.
- [x] `supabase/functions/tick/adapt.ts` + `tests/server/tick-adapt.test.ts` — new, added in step-04 review (Verification Gap layer). The `deno-postgres` → `TransactionalClient` translation, extracted out of `gateway.ts` and typed structurally so it imports nothing — every close and every heartbeat write goes through it, and `gateway.ts`'s bare `postgres` specifier put it out of Vitest's reach entirely. Not solved with a `deno test`: CI runs no Deno step, so that would be a test that never runs.
- [x] `tests/server/tick-auth.test.ts` — new, added during the step-03 matrix audit. Covers the I/O Matrix's "bad invocation secret" row, which no test reached: wrong/short/absent/empty secrets, an unset variable never reading as "no secret required", the absence of an early return in the comparison loop, and the ordering claim that the 401 precedes `tickGateway()` and `runTick()`.

**Acceptance Criteria:**
- Given the deployed configuration, when it is inspected, then exactly one `cron.schedule` invokes exactly one Edge Function that sweeps and then drains, at a sub-minute interval, created inactive, with no Netlify scheduled function anywhere and no in-memory timer.
- Given a sweep pass, when it runs, then it writes exactly one `tick_heartbeats` row whatever the outcome, and that row states the pass's result, the number closed and the number skipped.
- Given the tick's `CORE_VERSION` and the newest `auction_events.core_version`, when they differ, then no Auction is closed and the heartbeat names both numbers.
- Given an Auction closed by the sweep, when its event is compared against one an on-time close would have produced, then the payload is byte-identical and only `occurred_at` differs.
- Given a close that throws, when the pass continues, then the remaining overdue Auctions still close and the failure is recorded on the heartbeat.
- Given `npm run check` and `npm test`, when they run, then both pass, and nothing `src/lib/server/sweep.ts` imports is unresolvable under Deno.

## Spec Change Log

## Design Notes

**Why the version gate reads the log rather than a registry.** AD-20's fail-stop needs the Node deployment's version at tick time. A `runtime_versions` table would need Node to write it, and Netlify has no reliable per-deploy startup hook — an unvisited site would leave a stale row and the tick would refuse forever. Every event already carries the `core_version` that produced it (`write.ts:245`), so the newest row *is* the Node deployment's declared version whenever Node has written at all. Drift in the dangerous direction — the tick behind, closing under older rules than bids were placed under — is caught immediately. Drift the other way resolves on Netlify's first write under the new version, which is exactly the state AD-20's pause-and-redeploy procedure produces. An empty log has nothing to compare and nothing to close.

**Why each close re-folds the log.** The alternative — fold once, close many — is the defect AD-11 names. `closeAuction` reads the winning Team's roster *inside* its own locked transaction (`close.ts:115`), which is what lets §10 example 17's second win see the first's occupancy. Re-deriving per close costs a full log read each time and is correct by construction; at this league's volume that is the right trade.

```ts
// sweep.ts — the shape, not the implementation
const overdue = overdueAuctions(fold(INITIAL_AUCTIONS, events, auctionsReducer), now);
for (const auction of overdue) {
  if (auction.contention === 'minimum_bid') { skipped.push(auction); continue; } // 3.6
  try { await closeOne(auction.fantraxPlayerId); closed += 1; }
  catch (error) { failures.push({ id: auction.fantraxPlayerId, error }); }
}
await drain();             // after the sweep, always, and it cannot undo a close
await writeHeartbeat(...); // on every path, the refusals above included
```

## Verification

**Commands:**
- `npm test` — expected: green, including the new sweep, ordering and AD-11 sequential suites.
- `npm run check` — expected: no type errors.
- `npm run check:purity` — expected: green; `core/` gained only `overdueAuctions`.
- `npm run check:pins` — expected: green against the new `deno.json` assertion.
- `npx supabase start && npx supabase db reset` — expected: the migration applies, and `select jobname, schedule, active from cron.job` shows exactly one row, inactive.
- `npx deno check --config supabase/functions/tick/deno.json supabase/functions/tick/index.ts` — expected: the whole import chain resolves under Deno, `src/lib/server/sweep.ts` included. **This is the one check that proves AD-2 holds across the runtime boundary; it is not optional.** `--config` is load-bearing and was missing from this spec as written: Deno discovers a config file by walking up from the CWD, not from the entry module, so the bare form run at the repository root finds no import map and fails on `Import "postgres" not a dependency`.
- `npm test` requires `SUPABASE_DB_URL` to be set, exactly as `.github/workflows/ci.yml:74` sets it. Without it, and with a local Postgres reachable, `tests/integration/auction-events.test.ts` fails on `SUPABASE_DB_URL is not set` — a pre-existing environmental condition this story does not touch, not a regression.

**Manual checks (if no CLI):**
- `supabase/migrations/20260831000000_tick.sql` contains no secret literal — the invocation secret is read from Vault by name.
- `grep -rn "schedule" netlify.toml` returns nothing: the tick does not run on Netlify.

## Suggested Review Order

**The sweep — what the tick decides**

- The whole pass in one function: version gate, sweep, drain, heartbeat, in that order.
  [`sweep.ts:191`](../../src/lib/server/sweep.ts#L191)

- AD-20's fail-stop, before anything is closed. Refuses in both directions.
  [`sweep.ts:211`](../../src/lib/server/sweep.ts#L211)

- The newest event IS the Node deployment's declared version — no registry needed.
  [`sweep.ts:318`](../../src/lib/server/sweep.ts#L318)

- A live lottery is skipped, not thrown on; one un-drawable Auction cannot stall the pass.
  [`sweep.ts:244`](../../src/lib/server/sweep.ts#L244)

- The drain, ordered after the sweep, its failure unable to undo a committed close.
  [`sweep.ts:267`](../../src/lib/server/sweep.ts#L267)

- Exactly one heartbeat per pass. Non-finite versions never reach the integer column.
  [`sweep.ts:351`](../../src/lib/server/sweep.ts#L351)

**The two clocks — AD-10's "late, not wrong"**

- The shell's overdue guard, against the DATABASE clock. The check the core can no longer make.
  [`close.ts:190`](../../src/lib/server/close.ts#L190)

- The core gets the Auction's OWN expiry, so a late close appends a byte-identical payload.
  [`close.ts:205`](../../src/lib/server/close.ts#L205)

- AD-11's order, derived purely and sorted explicitly: expiry, then player id.
  [`auctions.ts:964`](../../src/lib/core/projection/auctions.ts#L964)

**The Deno half — one sweep, two runtimes**

- The thin entry point. Secret first; the gateway is built inside the try on purpose.
  [`index.ts:75`](../../supabase/functions/tick/index.ts#L75)

- The security boundary entire, shaped so the argument inversion cannot type-check.
  [`auth.ts:98`](../../supabase/functions/tick/auth.ts#L98)

- The production data path, typed structurally so `npm test` can execute it.
  [`adapt.ts:49`](../../supabase/functions/tick/adapt.ts#L49)

- `shell/db.ts`'s Deno twin: same port, so the pipeline above is untouched.
  [`gateway.ts:70`](../../supabase/functions/tick/gateway.ts#L70)

**The schedule and its heartbeat**

- One schedule, 10 seconds, created INACTIVE; the secret comes from Vault, never the file.
  [`20260831000000_tick.sql:180`](../../supabase/migrations/20260831000000_tick.sql#L180)

- AD-19's heartbeat table: RLS forced, `service_role` granted only select and insert.
  [`20260831000000_tick.sql:75`](../../supabase/migrations/20260831000000_tick.sql#L75)

- What the pg_net timeout actually bounds, and why overlapping passes stay safe.
  [`20260831000000_tick.sql:230`](../../supabase/migrations/20260831000000_tick.sql#L230)

**Supporting — tests and gates**

- AD-11 proven both ways: the sequential shape is right and the batch shape fails.
  [`sweep-sequential.test.ts:1`](../../tests/server/sweep-sequential.test.ts#L1)

- Every I/O-matrix row, over a fake that now refuses what Postgres refuses.
  [`sweep.test.ts:67`](../../tests/server/sweep.test.ts#L67)

- The invocation secret, driven with a real `Request` rather than a stand-in.
  [`tick-auth.test.ts:1`](../../tests/server/tick-auth.test.ts#L1)

- The lockfile is what Deno loads, so the pins gate now reads it too.
  [`check-pins.js:363`](../../scripts/check-pins.js#L363)
