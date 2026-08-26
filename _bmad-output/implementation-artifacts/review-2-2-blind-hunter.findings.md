## Findings

- `open_nominations` has no deletion path in this diff — Story 2.3's `AuctionClosed` event doesn't exist yet (confirmed by `src/lib/core/rules/nomination.ts:80-84`, which says "No close event exists yet — `AuctionClosed` is Story 2.3's"). Since the table's `team_id` and `fantrax_player_id` constraints are never cleared once written, every Team can only ever place one nomination, ever, and every Player can only ever be nominated once, ever, until Story 2.3 ships a delete. If this migration reaches production before 2.3, the auction is permanently exhausted after each team's first nomination.

- The migration and code repeatedly assert `open_nominations` is "never a read... nothing selects from it," yet the table stores `occurred_at` (and effectively `seq`) purely to reference the log — columns with no declared consumer given the write-only design. If nothing ever reads them, they're dead weight; if something eventually will, that's undocumented.

- `nameTheHolder` wraps a single read-only `SELECT * FROM auction_events` in an explicit `begin` / `rollback` pair. `loadEventsViaClient` needs no transaction — this adds two unnecessary round trips on every conflict path for no stated benefit.

- `nameTheHolder`'s outer `catch { return 'unrecorded' }` swallows every possible failure — connection exhaustion, a bug in `fold`/`nominationsReducer`, or any other unexpected throw — with no logging at all. A real defect in the re-read path becomes silently indistinguishable from a legitimately un-nameable holder, so this failure mode has zero observability.

- The `try { ... } catch` in `placeNomination` wraps the *entire* `runTransactionalWrite` call, not just the claim insert. Any other statement inside that transaction that happened to raise a `23505` matching `open_nominations_pkey` or `open_nominations_team_id_key` for an unrelated reason would be silently reclassified as a nomination refusal instead of surfacing as a bug — the catch is scoped far wider than the one insert it's meant to interpret.

- Neither `open_nominations.team_id references public.teams(id)` nor `seq references public.auction_events(seq)` specifies an `on delete` behavior, defaulting to `NO ACTION`. Nothing in the migration's extensive commentary calls out that this will block any future team deletion or (once possible) event pruning — a real operational constraint left unstated.

- `classifyNominationConflict` can only ever report one of the two refusal kinds, but a Team re-nominating a Player it already holds (or a Player it already claimed) could in principle collide with both the PK and the team-unique constraint simultaneously. Postgres surfaces only whichever constraint it checks first, so the refusal shown to the Manager may not reflect the more relevant violation, and there is no test exercising this doubly-conflicting case.

- The security-critical claim in the migration comment — "belt as well as braces: revoke the default grants" for `anon`/`authenticated` — is asserted only in a comment. The new integration test ("grants service_role select/insert/delete... and no update") checks `service_role`'s grants but never asserts `anon` and `authenticated` actually hold zero privileges on `open_nominations`, leaving the actual security property untested.

- `claimNomination` loops over `for (const event of appended)`, filtering for `NOMINATION_PLACED_EVENT`, even though `placeNomination` only ever appends exactly one event. The multi-event branch of this loop is therefore unexercised by any test, so its behavior (e.g., partial insert if a later event in the same batch fails) is unverified.

- In the unit-test fake (`tests/server/nomination.test.ts`), the `rolledBack` flag that switches `read-log` responses to `eventsAfterRollback` is set once and never reset. It works for the current one-call-per-test usage, but is a latent trap: any future test issuing two `placeNomination` calls against the same harness would silently get post-rollback data on the second call's normal read.

- The doc comment on `nameTheHolder` says it "can only be stale in the direction of being MORE correct," but this claim is never tested — there's no test where the log has changed *again* (a third writer) between the constraint violation and the naming re-read, which is exactly the scenario that comment is trying to reassure about.

- The new `pgError` helper is duplicated near-identically in both `tests/server/nomination.test.ts` and `tests/server/pg-errors.test.ts` (same shape, same `Object.assign` pattern, slightly different defaults) rather than shared — a missed opportunity that also risks the two copies drifting out of sync with what real `pg` errors look like.