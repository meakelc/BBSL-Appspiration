---
title: 'Story 2.2: Nomination refusals and concurrency'
type: 'feature'
created: '2026-08-25'
status: 'done'
review_loop_iteration: 0
baseline_commit: '9dcb9e2067ca58dd5fe86ed93c9599f9b02516f2'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 2.1's gate reads the board, decides, then appends — a check-then-write gap it deliberately left open, correct today only because one advisory lock serialises every writer. FR-8 requires uniqueness enforced *at the data layer* instead. Worse, nothing in `src/` inspects a Postgres SQLSTATE, so any constraint violation escapes `runTransactionalWrite` as a raw `pg` throw: the losing Manager would get a 500 rather than a sentence naming who beat them.

**Approach:** A tiny `open_nominations` claim table, written in the same transaction through the write pipeline's existing `projections` hook, whose two constraints make a second nomination of the same Player — or a second Slot spend by the same Team — physically impossible. `placeNomination` classifies SQLSTATE `23505` by constraint name and returns the pure core's existing `already_nominated` / `slot_in_use` refusal as a rejection, so the loser is told the fact and nothing else changes.

## Boundaries & Constraints

**Always:** The claim table is a **write-side constraint, never a read**. Every gate, the Slot, the board and the League Clock stay folds of `auction_events` — no code may `select` from `open_nominations` to answer a question. A `23505` is mapped to a refusal the pure core already words; no new refusal sentence is written anywhere. Uniqueness is proven by a test that races two real writers, not by asserting the DDL exists. Migration files only, applied dev-first (AD-26). A rejection is a returned value, never a throw.

**Ask First:** Any read of `open_nominations` by a gate, projection or surface. Any new refusal wording. Any change to `refuseNomination`'s check order. Any widening of `service_role`'s grants on `auction_events`.

**Never:** No `on conflict do nothing` — a swallowed collision is a silent wrong answer; the violation must abort and be classified. No release/delete case for a claim row: `AuctionClosed` does not exist and is Story 2.3's, override release is Epic 7.3's. No "already won in this auction" refusal — still unreachable, for Story 2.1's reason. No refusal-panel styling, accent bar or `attention` treatment: that is Story 2.6's build and no route has one yet. No retry loop around the losing writer. No hand-edit of `_bmad-output/planning-artifacts/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Accepted | Gate passes | `NominationPlaced` appended **and** one `open_nominations` row inserted in the same transaction, before commit | N/A |
| Same Player, second writer | Two nominations of one Player race the lock | Winner commits; loser's insert raises `23505` on the player constraint | Transaction rolls back; returned `rejected` carrying `already_nominated`, naming Player and winning Team |
| Same Team, second writer | One Team races two nominations of different Players | Winner commits; loser raises `23505` on the team constraint | Rolled back; returned `rejected` carrying `slot_in_use`, naming the Player that won the Slot |
| Loser names the holder | A `23505` was classified | The naming re-read runs on a fresh unlocked connection after rollback | If that re-read fails or finds nothing, refusal falls back to `unrecorded` |
| Gate refusal (unchanged) | Slot held / on board / under contract / wrong phase | Refused before any insert, exactly as Story 2.1 | Nothing written, no claim row |
| Non-unique DB error | Insert fails on anything but `23505` | Rethrown unchanged as a bug (AD-1) | Rollback; no event, no claim row |
| Route phase gate | Nominate requested outside the Auction Phase | `requireLiveDestination` refuses 403 server-side, independently of the rule | No transaction opened |
| Refusal wording | Any refusal in this story | States the fact then the reason; no exclamation mark, no apology; says nothing was written | N/A |

</frozen-after-approval>

## Code Map

Read Story 2.1's spec, Code Map and Design Notes first — the transactional shell, the core-worded refusal discipline and the fake-gateway test harness are reused, not re-derived. Nothing in this story changes `core/rules/nomination.ts` or `core/projection/nominations.ts`: both refusal kinds and both sentences already exist (`rules/nomination.ts:94-99`, `:135-146`) and this story only makes them reachable by a second route.

- `supabase/migrations/20260825000000_open_nominations.sql` -- new. `create table if not exists public.open_nominations (fantrax_player_id text primary key, team_id uuid not null unique references public.teams(id), seq bigint not null references public.auction_events(seq), occurred_at timestamptz not null)`. Two named constraints are the whole story: the PK on `fantrax_player_id` (a Player is nominated once) and the unique on `team_id` (a Team holds one Slot). **Name them explicitly** — `open_nominations_pkey` and `open_nominations_team_id_key` — because the classifier matches on the name. RLS enabled + forced, no policy, `revoke all` from `anon`/`authenticated`, and `grant select, insert, delete` to `service_role` — DELETE is granted here because 2.3's close and 7.3's release must remove the claim; `auction_events`'s own insert-only grants (`20260821020000_auction_events.sql:103-104`) are untouched. Follow `20260824020000_live_reference_tables.sql`'s comment style, which already argues uniqueness belongs "on the live table, where a violation aborts the transaction" (`:38-45`).
- `src/lib/server/nomination.ts` -- extend. Add a `projections: [claimNomination]` array to the `runTransactionalWrite` call at `:318` — the hook exists and is currently unused (`shell/write.ts:183`, `:238-240`), and runs after the insert and before `commit`, so the claim and the event commit or roll back together. `claimNomination: ProjectionUpdater` inserts one row from the single appended event. Wrap the `runTransactionalWrite` call in a `try`/`catch` that calls `classifyNominationConflict(error)`; on a match, name the holder via a fresh `loadNominatablePool`-style unlocked read and return `{kind:'rejected', reason: NominationRejection}`; on no match, rethrow. `placeNomination`'s signature and return type are unchanged, so `+page.server.ts:126-136` already maps the rejection to its `fail(409)` and needs **no edit**.
- `src/lib/server/pg-errors.ts` -- new, server-only. `isUniqueViolation(error): boolean` reading SQLSTATE `'23505'` and `constraintOf(error): string | null`. The first such reader in the repo — nothing in `src/` inspects `err.code` today, and `import-promotion.ts:257-260` merely narrates that a violation "propagates after the transaction has rolled back". Total, defensive, no throw: an error of any shape answers `false`/`null`.
- `src/routes/nominate/+page.server.ts` -- **no change.** AC3's independent route phase gate is already built at `:86` (`requireLiveDestination`, which `destinations.ts:136-144` refuses with a 403). This story asserts it rather than rebuilding it.
- `tests/server/nomination.test.ts` -- extend. The stateful fake gateway (`:45-175`) records statement order by regex and throws on any unrecognised SQL, so it needs a `'claim-nomination'` label; add `throwOn` support for a synthetic `23505` carrying a constraint name. Assert the new order `['begin','lock','read-log','read-pool-player','read-contract','append-event','claim-nomination','commit']`, that a `23505` on each constraint returns the matching refusal with `appendedEvents` empty, and that a non-`23505` error rethrows.
- `tests/server/pg-errors.test.ts` -- new. The classifier's table: a real-shaped `pg` error, a wrong SQLSTATE, an error with no `code`, a string, `null`.
- `tests/integration/auction-events.test.ts` -- extend. This file already holds the only real-Postgres harness, guarded by `describe.skipIf(!reachable)` (`:24-50`) and already races two writers on the advisory lock (`:278-326`). Add the **automated concurrency test AC4 requires**: two real `pg` clients, both passing the check-then-write gate against the same Player, serialised by the lock — the second commits its event only to fail on the claim insert. Assert exactly one `NominationPlaced` row and exactly one `open_nominations` row survive.

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260825000000_open_nominations.sql` -- the claim table and its two named constraints -- AC1
- [x] `src/lib/server/pg-errors.ts` -- SQLSTATE and constraint-name classification -- AC2
- [x] `src/lib/server/nomination.ts` -- register the claim projection, classify `23505`, name the holder -- AC1, AC2
- [x] `tests/server/pg-errors.test.ts` -- the classifier's table -- covers the I/O matrix
- [x] `tests/server/nomination.test.ts` -- extend: claim statement order, both conflicts, the rethrow -- covers the I/O matrix
- [x] `tests/integration/auction-events.test.ts` -- extend: the two-writer nomination race -- AC3

**Acceptance Criteria:**
- Given two Managers nominating the same Player, when both requests land, then exactly one Nomination exists in the log and exactly one claim row exists, and the loser is refused a sentence naming the Player and the winning Team — with uniqueness enforced by a constraint the second writer cannot pass, not by the read that preceded it.
- Given a nomination is refused by a constraint, when the outcome reaches the route, then it is a returned rejection carrying a sentence the pure core already words, never a thrown error and never a new wording.
- Given a nomination is attempted outside the Auction Phase, when the request lands, then the route refuses server-side under the destination guard independently of the rule, and no transaction is opened.
- Given the claim table exists, when the codebase is inspected, then no gate, projection or surface reads it — the Slot, the board and the League Clock remain folds of `auction_events`.

### Review Findings

bmad-code-review, 2026-08-26. Four layers ran against the `9dcb9e2..31d94f0` diff (Blind Hunter, Edge Case Hunter, Verification Gap, Acceptance Auditor). The Acceptance Auditor found no AC, Boundary or I/O-matrix violation.

- [x] [Review][Patch] `nameTheHolder`'s catch is a regression gap — no test makes the naming re-read itself FAIL [tests/server/nomination.test.ts] — the existing `unrecorded` tests all succeed at reading and merely find nothing, so removing the `catch` at `src/lib/server/nomination.ts:415` would break nothing. Fixed: the fake gateway now supports `failNamingReRead`, making the second `connect()` throw, and a new test asserts `placeNomination` still resolves `rejected`/`unrecorded`.
- [x] [Review][Patch] The migration's `anon`/`authenticated` revoke was asserted only in a comment [tests/integration/auction-events.test.ts] — the grant test covered `service_role` only. Fixed: a new integration test asserts both client-facing roles hold zero privileges on `open_nominations`.
- [x] [Review][Defer] `open_nominations` has no deletion path until Story 2.3 — deferred, deployment hazard logged in `deferred-work.md`.
- [x] [Review][Defer] `nameTheHolder` swallows every failure with no logging and no timeout — deferred, awaits a server-logging convention; logged in `deferred-work.md`.

Dismissed as noise: the `seq`/`occurred_at` "dead columns" reading (both are audit provenance, and `seq` is the FK that ties the claim to its event); the `try` scoped wider than the claim insert (no other statement in that transaction touches `open_nominations`, so no other statement can raise its constraint names); the `on delete` behaviour note (`NO ACTION` on a Team reference is correct — a Team is never deleted); the double-conflict ordering case (Postgres reports one, and both refusals are true); the `claimNomination` multi-event loop (defensive shape over a single-event caller); the `rolledBack` fake-harness latent trap (no test issues two calls); the duplicated `pgError` test helper (two lines, two files); and the two round-trips in `nameTheHolder`'s explicit `begin`/`rollback` (deliberate — every read in this repo runs in a transaction it rolls back).

## Spec Change Log

## Design Notes

**Why a claim table and not a partial unique index on `auction_events`.** An index predicate over `payload->>'fantraxPlayerId'` would enforce *one nomination per Player ever*, and an index cannot see a later event that undoes an earlier one. Story 2.3 releases the Slot on `AuctionClosed`, and Epic 7.3 returns a terminated Auction's Player to the pool (`epics.md:2063`, `:2067-2070`) — both would then be blocked by a constraint that was correct only for the length of this story. A row that a later story deletes expresses "open right now", which is the fact being constrained. The log itself stays untouched and insert-only.

**Why this does not violate Story 2.3's "never a stored flag".** 2.3's AC forbids Slot status being *read* from a stored flag toggled by a handler. Nothing reads this table: it is written and then only ever collided with. The gate that answers "is this Slot held" is still `nominationForTeam` over the fold. That distinction is load-bearing enough to be an **Always** above.

**Why the loser re-reads to name the holder.** By the time `23505` arrives, the transaction is rolled back and its folded state is gone, so the winner's Team name is not in hand. Naming is not optional — `rules/nomination.ts:7-11` makes "everything blocking is NAMED, never counted" the module's first rule — so an unlocked read after rollback buys the name. It can only be stale in the direction of being *more* correct, and `unrecorded` (`:159-163`) is the honest fallback if it finds nothing.

## Verification

**Commands:**
- `npm test` -- all pass, including purity, pins and structure gates. The integration suite skips unless local Supabase is running; run it with `supabase start` before calling the concurrency AC proven.
- `npm run check` -- clean

**Manual checks (if no CLI):**
- Apply the migration to the dev project and confirm `\d open_nominations` reports both constraints under the exact names the classifier matches, and that `service_role` holds select/insert/delete on it and still holds only select/insert on `auction_events`.
