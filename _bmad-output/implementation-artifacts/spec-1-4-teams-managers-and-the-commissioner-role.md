---
title: 'Story 1.4: Teams, Managers, and the Commissioner role'
type: 'feature'
created: '2026-08-21'
status: 'done'
baseline_commit: '66762e077368acc7429208ed602af63ab4614e00'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `managers` (Story 1.3) carries identity only — no Team, no co-management, no Commissioner flag. Nothing in the app yet knows which Team a Manager acts for or who may reach a Commissioner-only route, and `app.d.ts`'s own header comment says this story owes both.

**Approach:** Add a `teams` table and two `managers` columns (`team_id`, `is_commissioner`), extend the existing registry read path so `RegisteredManager` (and therefore `SessionState`) carries the binding, add a reusable server-side `requireCommissioner` guard, and add the pure `Team — Manager` display formatter the naming convention requires.

## Boundaries & Constraints

**Always:** Team binding and the Commissioner flag resolve **only** from `managers.team_id` / `managers.is_commissioner`, read server-side via the existing `ManagerRegistry` port — never from `user_metadata`, `app_metadata`, or any client-influenceable claim (AD-15). A test proves a forged `user_metadata.team_id` / `user_metadata.is_commissioner` changes nothing. `teams` follows the `managers.sql` RLS pattern exactly: `enable row level security` + `force row level security`, zero policies, explicit `revoke all from anon, authenticated`. Display of a Team always pairs the spelled-out name with the acting Manager (`Lakers — Meakel`), never a three-letter abbreviation. The Commissioner's own manager row resolves through the identical code path as any other — no special-casing.

**Ask First:** Any UI beyond the pure formatter (no new page or route is in this story's scope — say so rather than building one).

**Never:** No admin UI for assigning `team_id` or `is_commissioner` — the Commissioner writes these directly, same as `managers` rows were seeded in 1.3. No Cap Space, Maximum Bid, or Nomination Slot computation — those are projections built in 1.5/1.6+; this story only guarantees co-Managers resolve to one shared Team row so those figures are identical once they exist. No event log, no `auction_events` — Story 1.5. No new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Registered Manager, bound to a Team | `managers.team_id` set | `RegisteredManager.teamId`/`teamName` populated from the join | N/A |
| Registered Manager, no Team yet | `managers.team_id` null | `teamId`/`teamName` are `null`; no crash | N/A |
| Co-managed Team | two `managers` rows share one `team_id` | Both resolve `teamId`/`teamName` identically | N/A |
| Forged metadata claim | `user_metadata.team_id`/`is_commissioner` set on the Discord user, absent/different in `managers` | Resolved binding matches the `managers` row only | Forged claim has zero effect, proven by test |
| Non-Commissioner calls the guard | `session.manager.isCommissioner === false` | `requireCommissioner` refuses (403) | Refusal is server-side, not a hidden control |
| Commissioner calls the guard | `session.manager.isCommissioner === true` | `requireCommissioner` allows | N/A |
| Team display | teamName=`Lakers`, managerName=`Meakel` | Formatter returns `Lakers — Meakel` | N/A |

</frozen-after-approval>

## Code Map

- `supabase/migrations/20260821010000_teams.sql` -- new: `teams` table (`id uuid pk`, `name text not null unique` + blank-check, `created_at`), RLS enabled+forced, zero policies, explicit revokes, mirroring `managers.sql`'s exact pattern; same file also `alter table managers add column team_id uuid references teams(id)` and `add column is_commissioner boolean not null default false` -- nullable FK supports staged onboarding; a single column already makes "exactly one Team" structural.
- `src/lib/server/auth.ts:27` -- `RegisteredManager` type: add `readonly teamId: string | null`, `readonly teamName: string | null`, `readonly isCommissioner: boolean`. Update the docblock at `:20-25` (no longer "deliberately absent").
- `src/lib/server/supabase.ts:112-115` -- `managerRegistry().findByDiscordUserId` -- extend `.select('id, discord_user_id, display_name')` to include `team_id, is_commissioner, teams(name)` and map the embedded row into the new `RegisteredManager` fields.
- `src/lib/server/commissioner-guard.ts` -- new: `requireCommissioner(session: SessionState): void`, throwing SvelteKit `error(403, ...)` unless `session.kind === 'registered' && session.manager.isCommissioner` -- the reusable guard future Commissioner-only routes (1.7+, 1.10) call; no route exists yet to wire it into (see Design Notes).
- `src/lib/core/team-identity.ts` -- new: pure `formatTeamManager(teamName: string, managerDisplayName: string): string` returning `` `${teamName} — ${managerDisplayName}` `` -- sits beside `src/lib/core/money.ts` as the other structurally-pure renderer.
- `src/app.d.ts:6-9` -- amend the header comment: 1.4 now discharges the Team-binding/Commissioner-flag promise; no `Locals` shape change needed since `SessionState.registered.manager` already carries it.
- `tests/auth.test.ts` -- extend registry-shaped tests for the three new `RegisteredManager` fields.
- `tests/session.test.ts:78` -- extend the existing forged-metadata test to also forge `team_id`/`is_commissioner` and assert no effect.
- `tests/commissioner-guard.test.ts` -- new: guard refuses non-Commissioner, allows Commissioner, refuses signed-out/unregistered/expired states.
- `tests/team-identity.test.ts` -- new: formatter unit test, including an em-dash/whitespace edge case.

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260821010000_teams.sql` -- create `teams`, alter `managers` -- the schema this story owes per `app.d.ts`'s own comment.
- [x] `src/lib/server/auth.ts` -- extend `RegisteredManager`, amend docblock -- carries the binding through the existing generic `SessionState` plumbing untouched.
- [x] `src/lib/server/supabase.ts` -- extend the registry query/mapping -- the one place identity is read from the database.
- [x] `src/lib/server/commissioner-guard.ts` -- add `requireCommissioner` -- AC3's server-side refusal mechanism.
- [x] `src/lib/core/team-identity.ts` -- add `formatTeamManager` -- AC2's naming convention, structurally pure.
- [x] `src/app.d.ts` -- amend header comment -- discharges the 1.3-written promise.
- [x] `tests/auth.test.ts`, `tests/session.test.ts` -- extend for the new fields and the forged-claim case -- AC1.
- [x] `tests/commissioner-guard.test.ts` -- new -- AC3.
- [x] `tests/team-identity.test.ts` -- new -- AC2's format rule.

**Acceptance Criteria:**
- Given a Manager row with `team_id` and `is_commissioner` set, when the registry resolves that identity, then `SessionState.registered.manager` carries `teamId`, `teamName`, and `isCommissioner`, all read from `managers`/`teams` only.
- Given a Discord identity whose `user_metadata` claims a different `team_id` or `is_commissioner` than the `managers` row, when the session resolves, then the resolved binding matches the database row and the test proving this passes.
- Given `requireCommissioner(session)` called with a non-Commissioner, signed-out, unregistered, or expired session, when it runs, then it throws a 403 in every case.
- Given `requireCommissioner(session)` called with a Commissioner session, when it runs, then it does not throw.
- Given two `managers` rows sharing one `team_id`, when both resolve their session, then both carry the identical `teamId` and `teamName`.
- Given `npm test`, `npm run check`, and `npm run build`, when they run, then all three pass with zero errors.

## Spec Change Log

## Design Notes

**No Commissioner-only route ships here.** AC3 wants a test exercising "each Commissioner-only route" — none exist yet (confirmed by search); the first lands in 1.7-1.10. Building one with no product purpose would be scope invention, so this story ships `requireCommissioner`, unit-tested against synthetic `SessionState` values, for every future Commissioner-only route to call.

**AC2's Cap Space/Maximum Bid/Nomination Slot aren't computed here** — those are event-log projections (1.5/1.6+). The only testable claim available now is that co-Managers share one Team row, so those figures read identically once they exist, by construction.

## Verification

**Commands:**
- `npm test` -- expected: all suites pass, including the new registry, guard, and formatter tests.
- `npm run check` -- expected: zero errors, new modules type-checked under `strict`/`noUncheckedIndexedAccess`.
- `npm run build` -- expected: exit 0.
- `grep -rn "team_id\|is_commissioner" src/lib/server/auth.ts` -- expected: no read path other than the registry-sourced `RegisteredManager` fields.

## Suggested Review Order

**The schema — Team binding and the Commissioner flag**

- New `teams` table, mirroring `managers.sql`'s deny-by-default RLS exactly.
  [`20260821010000_teams.sql:19`](../../supabase/migrations/20260821010000_teams.sql#L19)

- RLS enabled and forced with zero policies — every role denied by construction.
  [`20260821010000_teams.sql:41`](../../supabase/migrations/20260821010000_teams.sql#L41)

- `managers` gains `team_id`/`is_commissioner`, both idempotent (`if not exists`).
  [`20260821010000_teams.sql:62`](../../supabase/migrations/20260821010000_teams.sql#L62)

**The registry read path — where the binding is proven, not just typed**

- `RegisteredManager` grows the three fields the whole story hangs off.
  [`auth.ts:33`](../../src/lib/server/auth.ts#L33)

- The query joins `teams(name)` in one round trip — the only place the DB is read.
  [`supabase.ts:117`](../../src/lib/server/supabase.ts#L117)

- Defensive array-vs-object unwrap for the Postgrest embed shape.
  [`supabase.ts:139`](../../src/lib/server/supabase.ts#L139)

- The mapping proven against a stub client, not a hand-built fixture — closes the gap review caught.
  [`supabase-registry.test.ts:177`](../../tests/supabase-registry.test.ts#L177)

**The Commissioner-only guard**

- `requireCommissioner` — one function every future Commissioner-only route calls.
  [`commissioner-guard.ts:50`](../../src/lib/server/commissioner-guard.ts#L50)

- Its docblock now says plainly what it does *not* cover: break-glass sessions.
  [`commissioner-guard.ts:1`](../../src/lib/server/commissioner-guard.ts#L1)

- The refusal matrix — every non-Commissioner `SessionState` kind, one parametrised test.
  [`commissioner-guard.test.ts:57`](../../tests/commissioner-guard.test.ts#L57)

**Non-enumeration — the forged-claim defense (AC1)**

- A forged `user_metadata.team_id`/`is_commissioner` on a genuinely registered account changes nothing.
  [`session.test.ts:151`](../../tests/session.test.ts#L151)

**Display — the naming convention (AC2)**

- `formatTeamManager` omits the em dash entirely when there is no Team yet.
  [`team-identity.ts:36`](../../src/lib/core/team-identity.ts#L36)

**Peripherals**

- The promise this file made in 1.3, discharged; no `Locals` shape change needed.
  [`app.d.ts:6`](../../src/app.d.ts#L6)
