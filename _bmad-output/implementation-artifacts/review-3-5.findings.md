# Story 3.5 — review findings and triage

Four layers ran against the complete change set (20 files, tracked and untracked)
on 2026-08-31, against baseline `b3ec52e48889e92d2ec1b3a3f373cc390b149e27`.

Layers: Blind Hunter (14 findings), Edge Case Hunter (5), Verification Gap (2 plus
a note), Acceptance Auditor (3). The Acceptance Auditor ran on the **opus** tier —
story 3.5 is Tier A in `BMAD-EFFORT-TRIAGE.md` *and* the diff touches
`src/lib/core/**`, either of which alone forbids the lite variant.

**Outcome: no `intent_gap`, no `bad_spec`, so no loopback.** The design was not
challenged by any layer. 11 patches applied, 3 deferred, 6 rejected.

## The one confirmed bug

**A refused pass on an unreadable `core_version` could not write its own heartbeat.**
Found independently by Blind Hunter and the Acceptance Auditor. `newestCoreVersion`
returns `NaN` for a non-numeric version, which correctly refuses the pass; the
refusal then bound `NaN` to `log_core_version`, an `integer` column. Confirmed
against the live local Postgres rather than by reading:

```
insert into tick_heartbeats (... log_core_version ...) values (..., NaN, ...)
-> invalid input syntax for type integer: "NaN"
```

So the fail-stop refused correctly and left **no trace** — the dead-tick
indistinguishability AD-19 exists to prevent. Reachability is bounded by
`auction_events.core_version integer not null`, making it defensive rather than
live, but the code asserted something untrue and a test claimed to prove it.

Fixed by never binding a non-finite value to those columns, keeping the raw value
named in `detail`. The reason it shipped green is fixed too: the sweep test's fake
`TransactionalClient` stored parameters untyped and accepted what the database
rejects. It now refuses a non-integer bound to an integer column, reproducing the
real error text. Verified load-bearing — removing the guard fails the suite.

## Patches applied

| # | File | Finding |
|---|---|---|
| 1 | `src/lib/server/sweep.ts` | `NaN` version bound to an `integer` column (above) |
| 2 | `tests/server/sweep.test.ts` | The fake accepted what Postgres rejects |
| 3 | `supabase/functions/tick/index.ts` | `tickGateway()` sat outside the `try`, so a missing `SUPABASE_DB_URL` bypassed the structured 500 |
| 4 | `auth.ts`, `index.ts`, `tests/server/tick-auth.test.ts` | The invocation-secret **wiring** was untested — swapping two arguments would invert the boundary with every test green. The wiring moved into `auth.ts` behind a signature where the swap does not type-check |
| 5 | `adapt.ts` (new), `tests/server/tick-adapt.test.ts` (new) | `adapt()` — the whole production data path — had no coverage |
| 6 | `adapt.ts` | `Promise.resolve(client.release()).catch(...)` misses a *synchronous* throw |
| 7 | `src/lib/server/sweep.ts` | A throwing `finally` could discard a completed pass's summary |
| 8 | `scripts/check-pins.js`, `tests/pins.test.ts` | The pins gate read `deno.json` only; `deno.lock` is committed and is what Deno actually resolves |
| 9 | `tests/structure.test.ts` | The file inventory omitted `auth.ts` and `deno.lock` |
| 10 | `supabase/migrations/20260831000000_tick.sql` | The comment claimed `timeout_milliseconds` stops a stuck invocation piling up; it bounds the *response*, not the function |
| 11 | `src/lib/server/sweep.ts`, `tests/pins.test.ts` | Unbounded error text into `detail`; a stray double blank line |

## Deferred

Recorded in `deferred-work.md` with evidence: overlapping passes reporting benign
contention as close failures; unbounded growth of `tick_heartbeats` and
`cron.job_run_details`; the heartbeat holding no structured list of what failed.

The overlap finding was the closest call. Both clean fixes are out of bounds — a
pass-level advisory lock contradicts the spec's **frozen** "taken by
`runTransactionalWrite` per close and by no second mechanism", and discriminating
the benign case by matching a `TypeError`'s message text is brittle. It costs
monitoring noise, never a wrong close.

## Rejected

- **`deno.land/x` specifier regex misses a bare, path-less form.** It fails
  *closed* — reported as "cannot vouch that it is pinned" — which is the correct
  direction for a drift gate.
- **"One corrupt event aborts the pass."** Already caught and recorded as
  `outcome: 'failed'`. A sweep that cannot derive the overdue set must not guess.
- **Error-precedence change in `close.ts`.** The reviewer said themselves it is
  not a functional regression; both paths throw and roll back.
- **`deno.land/x` is soft-deprecated versus JSR** — opinion, and the dependency is
  pinned and working.
- **Which role bypasses RLS on `tick_heartbeats`** — the grants are what control
  access and they are asserted; this matches the precedent set by
  `20260828000000_contention_seeds.sql`.
- **`POOL_SIZE` forward-compatibility note** — speculative about Epic 5.1.

One finding was noise from the review packaging rather than the code: the wrapper
file's header said untracked files were "the bulk of this story" while the tracked
diff also contained three new files. That was the orchestrator's framing, not the
implementation's.

## Verification after patching

- `npm test` — **2064 passed / 2064**, exit 0 (with `SUPABASE_DB_URL` set, as `ci.yml:74` sets it)
- `npm run check` — 572 files, 0 errors
- `npm run check:purity`, `npm run check:pins` — green
- `npx deno check --config supabase/functions/tick/deno.json supabase/functions/tick/index.ts` — exit 0
- Migration applied against live Postgres in a rolled-back transaction: one `cron.job`
  (`bbsl-tick`, `10 seconds`, inactive), idempotent, RLS enabled and forced,
  `service_role` holding only `SELECT`/`INSERT`
