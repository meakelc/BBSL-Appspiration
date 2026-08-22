---
title: 'Story 1.5: The append-only log and the transactional write path'
type: 'feature'
created: '2026-08-21'
status: 'done'
baseline_commit: '38ecc44b56a8afcc9758947cb4b36aea1ccd5acd'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Every later story (1.6's phase fold, 1.10's eligibility events, 1.11's open event, all of Epic 2+) needs somewhere to append facts nobody can edit and a way to derive current state from them. Nothing exists yet: `core/rules`, `core/projection` and `shell/` are empty `.gitkeep` placeholders, no migration has ever run, and this repo has no local Postgres to prove RLS or lock behavior against — every DB-touching test so far stubs the client.

**Approach:** Add the insert-only `auction_events` table (deny-UPDATE/DELETE to every role including `service_role`), a generic pure fold/rebuild reducer in `core/projection`, and a generic transactional shell in `shell/` that runs lock → load → decide → persist → enqueue over a direct Postgres connection (needed for `pg_advisory_xact_lock` + explicit `BEGIN`, which PostgREST cannot do). Add `supabase/config.toml` and a real local Postgres via `supabase start` so the RLS-denial and lock-serialization claims are proven against Postgres, not asserted against a stub — new in this repo, run in CI where Docker exists, and auto-skipped locally where it doesn't.

## Boundaries & Constraints

**Always:** `auction_events` is RLS-enabled and forced, zero policies (mirrors `managers.sql`/`teams.sql`), `anon`/`authenticated` fully revoked, and `service_role` explicitly revoked `UPDATE`/`DELETE` and granted only `SELECT`/`INSERT` (AD-4) — an automated test proves the denial against real Postgres. Every row carries `seq` (identity, DB-assigned), `occurred_at` (the shell's captured transaction-start `now`, not a column default), `schema_version`, `core_version`, `manager_id`, `team_id` from the first row onward; `device_class`/`dispatch_outcome`/`delivery_outcome` are nullable, for future stories to populate (AD-4). The shell takes `pg_advisory_xact_lock(GLOBAL_WRITE_LOCK_KEY)` — the existing `core/constants.ts` value, verbatim, one-argument form — before reading any state, transaction-scoped (AD-6). `now` is read from the database clock at transaction start, once, and reused for both the lock's transaction and every event's `occurred_at` (AD-3). Folding is one pure, generic function ordered by `seq`, used identically for in-transaction fold and full rebuild from empty state (AD-5). RLS-denial and lock-serialization are integration tests against a real local Postgres (`supabase start`), `describe.skipIf`-guarded so `npm test` without Docker skips visibly rather than failing or silently passing.

**Ask First:** If CI's runner cannot run `supabase start` (Docker unavailable), stop and ask rather than quietly downgrading the concurrency/grant proofs to mocks.

**Never:** No domain event types (`BidPlaced`, etc.), no `core/rules`, no `evaluate()`/`decide()` implementation — Epic 2. No projection tables — created by the story that first reads them. No outbox table or dispatcher — Epic 5.1 (AD-17); `enqueue` is a documented no-op seam. No Deno-side shell — first needed by the tick function (Epic 3). No provisioning of the real cloud dev/prod Supabase projects — already a hand-task entry in `deferred-work.md`. No wiring of `commissioner-recovery`'s in-memory attempt ledger into this log — that is its own logged `deferred-work.md` entry, not this story's AC.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Command accepted | caller's `decide()` returns events | rows inserted with assigned `seq`, registered projections folded in-tx, `COMMIT` | N/A |
| Command rejected | caller's `decide()` returns `Rejected` | `ROLLBACK`, nothing persisted, `enqueue` never called | rejection is a return value, not a throw |
| Two writers race the lock | concurrent calls against real Postgres | second blocks until the first's transaction ends, then its own `load()` sees the first's committed row | second may itself then reject on what it now sees |
| Any role runs UPDATE/DELETE | incl. `service_role`, against real Postgres | Postgres denies with a permission error | test asserts the denial; no app-facing surface exists yet |
| Integration suite, no local Postgres | `supabase start` not run | suite skips with a visible reason | N/A |

</frozen-after-approval>

## Code Map

- `supabase/config.toml` -- new: local Supabase CLI project config (Postgres ≥15.1.1.61 to match prod, api/db/studio ports), discharging the `deferred-work.md` entry blocking `supabase start`/`db push` locally.
- `supabase/migrations/20260821020000_auction_events.sql` -- new: `auction_events` table per Boundaries; grants as specified (the `service_role` UPDATE/DELETE revoke is the new pattern beyond `managers.sql`/`teams.sql`, which never grant `service_role` write at all).
- `src/lib/core/constants.ts` -- add `CORE_VERSION` and `EVENT_SCHEMA_VERSION` (small integers, AD-20); first use of both.
- `src/lib/core/types.ts` -- replace the Epic-2 stub's placeholder with the generic `EventEnvelope`/`AppendedEvent` shapes the log needs now; Epic 2 adds domain-specific command/event variants on top, unchanged.
- `src/lib/core/projection/fold.ts` -- new: pure `fold(state, events, reducer)` — one function serving both "fold inside the append transaction" and "full rebuild from empty state," ordered by `seq`. First file in this directory.
- `src/lib/shell/db.ts` -- new: `pg` `Pool` from `SUPABASE_DB_URL` (`$env/dynamic/private`), mirroring `supabase.ts`'s `required()` pattern.
- `src/lib/shell/write.ts` -- new: the generic transactional pipeline (lock → load → decide → persist → enqueue) behind an injected gateway port, so unit tests substitute a fake client the way `SessionGateway`/`ManagerRegistry` already do. First file in this directory.
- `.env.example` -- add `SUPABASE_DB_URL` to the server-only block (direct/pooled Postgres connection, distinct from `SUPABASE_URL`'s PostgREST endpoint).
- `package.json` -- add `pg` + `@types/pg`, exact-pinned (architecture's adversarial review names this driver explicitly for `pg_advisory_xact_lock` + explicit `BEGIN`, which PostgREST cannot do).
- `.github/workflows/ci.yml` -- add a pinned-by-commit Supabase CLI setup + `supabase start` before the `Test` step, `supabase stop` after; exports local connection env vars.
- `tests/constants.test.ts` -- extend for the two new constants.
- `tests/projection-fold.test.ts` -- new: `fold`'s ordering, idempotent-rebuild and in-transaction-vs-full-rebuild equivalence.
- `tests/shell-write.test.ts` -- new: pipeline order and the Rejected/rollback path, against a fake gateway.
- `tests/integration/auction-events.test.ts` -- new: the two real-Postgres proofs (grants, lock serialization), `describe.skipIf` on a local-Supabase reachability probe.
- `tests/structure.test.ts` -- `src/lib/shell` and `src/lib/core/projection` move from the `.gitkeep`-presence list to a real-file assertion; delete both `.gitkeep`s. Leave every other AR-2 directory's marker untouched.

## Tasks & Acceptance

**Execution:**
- [x] `supabase/config.toml` -- add local CLI project config -- unblocks `supabase start`/`db push` for this story and every later one.
- [x] `supabase/migrations/20260821020000_auction_events.sql` -- create the table, grants, RLS -- AC1, AC2.
- [x] `src/lib/core/constants.ts` -- add `CORE_VERSION`, `EVENT_SCHEMA_VERSION` -- needed by the migration's NOT NULL columns and AD-20.
- [x] `src/lib/core/types.ts` -- add `EventEnvelope`/`AppendedEvent` -- the shell's persist step needs a shared shape.
- [x] `src/lib/core/projection/fold.ts` -- add the generic fold/rebuild reducer -- AC3, AC4.
- [x] `src/lib/shell/db.ts`, `src/lib/shell/write.ts` -- add the pooled connection and the lock→load→decide→persist→enqueue pipeline -- AC5, AC6.
- [x] `.env.example`, `package.json` -- add `SUPABASE_DB_URL`, `pg`, `@types/pg`.
- [x] `.github/workflows/ci.yml` -- start/stop local Supabase around `Test` -- makes the integration proofs real in CI.
- [x] `tests/constants.test.ts`, `tests/projection-fold.test.ts`, `tests/shell-write.test.ts`, `tests/integration/auction-events.test.ts` -- new/extended coverage per Code Map.
- [x] `tests/structure.test.ts` -- flip the two now-populated directories to a real-file assertion; delete their `.gitkeep`s.

**Acceptance Criteria:**
- Given `auction_events`, when grants are inspected against real Postgres, then no role — including `service_role` — holds `UPDATE` or `DELETE`, and an automated test proves it by attempting one as `service_role` and asserting failure.
- Given an appended event, when the row is written, then it carries `seq`, `occurred_at`, `schema_version`, `core_version`, `manager_id` and `team_id` from the first row onward, with `device_class`/`dispatch_outcome`/`delivery_outcome` present as nullable columns.
- Given a set of events and a reducer, when `fold` runs, then the result is ordered by `seq` (never `occurred_at`), a full rebuild from empty state converges on the same result as incremental folding, and replay is idempotent.
- Given two concurrent writers against real Postgres, when both attempt `pg_advisory_xact_lock(GLOBAL_WRITE_LOCK_KEY)`, then they serialize — the second's transaction does not proceed until the first's ends — proven by an automated concurrency test.
- Given the transactional shell processing a command, when it runs, then the order is exactly lock → load → decide → persist → enqueue, `now` comes from one database-clock read at transaction start (never `Date.now()`), a `Rejected` result rolls back with nothing persisted and `enqueue` never called, and an `Accepted` result commits with events persisted and registered projections folded in the same transaction.
- Given `npm test`, `npm run check`, and `npm run build`, when they run, then all three pass with zero errors; the two integration tests skip visibly without local Postgres and pass for real in CI.

## Spec Change Log

## Design Notes

**Why a direct Postgres connection, not `supabase-js`.** Every existing DB read (`supabase.ts`) goes through PostgREST, which is stateless per request and cannot hold `BEGIN … pg_advisory_xact_lock … COMMIT` open across the load/decide/persist sequence. The architecture's own adversarial review names `pg`/`postgres` over a direct connection as the needed client for exactly this reason. `pg` returns `int8` (so `seq`) as a JS `string`, matching the same driver-boundary discipline `money.ts` already established for dollar amounts — `seq` is typed as `string` in TS, not `number` or `bigint`, and compared via `BigInt()` only where ordering arithmetic is needed.

**Why `manager_id`/`team_id` are `NOT NULL` now.** The AC states every event carries the acting Manager and Team with no exception yet on record. A future system-originated event (the tick's `AuctionClosed`) will need to resolve who "acts" for it — deliberately left to whichever story first emits one, not decided here.

**Why the integration tests target Postgres directly, not the generic shell.** No domain `decide()` exists yet (Epic 2), so the lock-serialization proof drives two raw `pg` clients through `BEGIN; pg_advisory_xact_lock; …; COMMIT` directly — the primitive the AC is actually about — rather than round-tripping through an abstraction with nothing real behind it yet.

## Verification

**Commands:**
- `npm test` -- expected: all suites pass; the two `tests/integration/` cases skip with a stated reason when no local Postgres is reachable.
- `npm run check` -- expected: zero errors under `strict`/`noUncheckedIndexedAccess`.
- `npm run build` -- expected: exit 0, purity gate passes (`core/projection/fold.ts` and `core/types.ts` stay pure).
- `npx supabase start` then `npm test` -- expected: the two integration tests run for real and pass.
- `grep -rn "UPDATE\|DELETE" supabase/migrations/20260821020000_auction_events.sql` -- expected: no grant statement gives any role either privilege.

## Suggested Review Order

**The insert-only table and its privilege model (AC1, AC2)**

- Entry point — the table definition every other change exists to serve.
  [`20260821020000_auction_events.sql:34`](../../supabase/migrations/20260821020000_auction_events.sql#L34)

- RLS enabled and forced, zero policies — deny-by-default, mirroring `managers.sql`/`teams.sql`.
  [`20260821020000_auction_events.sql:83`](../../supabase/migrations/20260821020000_auction_events.sql#L83)

- The whole AC1 guarantee: `service_role` stripped to `SELECT`/`INSERT` only, UPDATE/DELETE absent from every grant.
  [`20260821020000_auction_events.sql:103`](../../supabase/migrations/20260821020000_auction_events.sql#L103)

**The transactional shell — lock, load, decide, persist, enqueue (AC4, AC5)**

- The AD-6 lock and the AD-3 clock read, in one round trip, before any state is loaded.
  [`write.ts:133`](../../src/lib/shell/write.ts#L133)

- `decide` runs on the locked, freshly-loaded state — the seam Epic 2's rules engine will fill.
  [`write.ts:193`](../../src/lib/shell/write.ts#L193)

- Registered projections fold inside the same transaction as the append, before commit (AD-5).
  [`write.ts:229`](../../src/lib/shell/write.ts#L229)

- `enqueue` moved outside the try/catch entirely — a post-commit failure must never trigger a rollback of an already-durable write.
  [`write.ts:260`](../../src/lib/shell/write.ts#L260)

- `EnqueueError` carries the accepted outcome forward so a throwing outbox seam doesn't erase proof the write succeeded — the fix for a review-caught bug.
  [`write.ts:107`](../../src/lib/shell/write.ts#L107)

**Proving it against real Postgres, not a stub (AC1, AC4, AC5, AC6)**

- The four-verb denial proof for `anon`/`authenticated` — extended from a review finding that only `SELECT` had been tested.
  [`auction-events.test.ts:89`](../../tests/integration/auction-events.test.ts#L89)

- The lock-serialization proof: a second writer provably blocks until the first's transaction ends.
  [`auction-events.test.ts:279`](../../tests/integration/auction-events.test.ts#L279)

- `runTransactionalWrite()` driven through `writeGateway()` against real Postgres — closes a review finding that the shell's actual SQL had never executed live.
  [`auction-events.test.ts:370`](../../tests/integration/auction-events.test.ts#L370)

**The pooled connection and the fold/rebuild reducer**

- The pool's required `'error'` listener — without it, a dropped idle connection crashes the process.
  [`db.ts:45`](../../src/lib/shell/db.ts#L45)

- One function serving both in-transaction fold and full rebuild, ordered by `seq` via `BigInt`.
  [`fold.ts:40`](../../src/lib/core/projection/fold.ts#L40)

**Peripherals**

- The pipeline-order unit test, rewritten onto one shared array so a lock-after-load regression would actually fail it.
  [`shell-write.test.ts:95`](../../tests/shell-write.test.ts#L95)

- `supabase start`/`stop` bracketing `Test`, so the integration proofs above run for real in CI.
  [`ci.yml:56`](../../.github/workflows/ci.yml#L56)

- `EVENT_SCHEMA_VERSION`/`CORE_VERSION` (AD-20), first use of both.
  [`constants.ts:92`](../../src/lib/core/constants.ts#L92)

- `EventEnvelope`/`AppendedEvent` — the generic shapes Epic 2 builds domain event types on top of.
  [`types.ts:41`](../../src/lib/core/types.ts#L41)
