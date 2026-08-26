## Findings

- The live deployment hazard at `deferred-work.md:216-217` is not actually closed by this story, and nothing says so. The existing entry reads "Assigned to Story 2.3, which must land the release path before any deploy carrying this migration." This diff ships `releaseNomination` but explicitly does not wire it up, and the added test `'is NOT registered on placeNomination — no production path issues the delete'` proves it. A reader of `deferred-work.md` alone would believe the hazard is resolved by 2.3, but a deploy of `20260825000000_open_nominations.sql` before Story 3.4 still permanently exhausts nominations exactly as the original entry warned.

- `releaseNomination` trusts its payload with an unchecked cast, unlike the core fold's defensive reader. `const payload = event.payload as { readonly fantraxPlayerId: string };` has no runtime validation, while the parallel core-side `readClosedPlayerId` explicitly guards `typeof fantraxPlayerId !== 'string' || fantraxPlayerId === ''`. A malformed close payload would bind `undefined`/wrong-typed value as the SQL parameter and likely silently match zero rows rather than surfacing the malformation.

- No malformed-payload test exists for `releaseNomination` at the server layer. `tests/core/nomination.test.ts` has a thorough `it.each` matrix, but the new `releaseNomination` describe block only ever supplies well-formed string `fantraxPlayerId`s — the write-side function's own claimed robustness is untested.

- No test covers two `AuctionClosed` events for the same Player in one batch. `'deletes once per close when a batch carries several'` only exercises distinct players `p-1`/`p-2`.

- `releaseNomination` issues one round-trip per event, undocumented as a deliberate tradeoff. The choice to loop `await client.query(...)` per event instead of a single `where fantrax_player_id = any($1::text[])` batched delete is not addressed at all.

- Stale line citation in the new `deferred-work.md` entry. It cites "the release case in `src/lib/core/projection/nominations.ts:170-185`", but as shipped the case sits at lines 252-268.

- "AC1/AC2/AC3" is used with two unrelated meanings across artifacts in this diff. `deferred-work.md`'s new entry references "AC2 and AC3 of `epics.md:838-846`", while the shipped tests reuse the same tokens for an unrelated, spec-local scheme.

- The escalated DESIGN.md/epics.md conflict is filed as prose only, with no enforceable follow-up. Nothing links a task, updates `DESIGN.md`, or adds an acceptance criterion that would block the follow-on visibility story from silently picking one of the three conflicting treatments.

- `omitKey` rebuilds both index objects in full on every release, with no cost/scale note. O(n) per release for both `byPlayer` and `byTeam`.

- The task list claims coverage for "AC1, AC2" but no artifact anywhere is labeled AC2. Its coverage is implicit only.

- A test's name/comment mismatches what it actually exercises. `it('converges when the same close is folded twice — a no-op on an absent key', ...)` re-folds the entire log a second time, not the close event alone. It passes, but for a different reason than the label claims.

- No test drives `releaseNomination` with an empty-string `fantraxPlayerId`. The core fold treats `''` as unidentifiable and skips; the unchecked cast has no equivalent skip logic and no test shows what happens.
