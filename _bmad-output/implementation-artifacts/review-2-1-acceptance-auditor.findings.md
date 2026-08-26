## Acceptance Audit — Story 2.1: Nominate a Free Agent

Verdict: **no acceptance-criterion violations found.** All six ACs and all eleven I/O-matrix rows are implemented; the "Never" list is respected (no migration, no projection table, no `/board`, no uniqueness constraint, no `already_won` refusal, no cap arithmetic, no ranking affordance). Findings below are deviations and coverage gaps, in descending order of importance.

- **The "Cannot afford" matrix row has no test that exercises the scenario it states.**
  Violates: I/O matrix row *Cannot afford* → "Nominated normally"; AC1's clause "a Team with zero cap space nominates successfully".
  Evidence: the only test claiming this (`tests/core/nomination.test.ts`, `'nominates normally for a Team with no cap space — nothing here is arithmetic'`) asserts nothing about nominating — its body is `expect(Object.keys(readyState())).toEqual(['phase','nominations','poolPlayer','contractHolderTeamName'])`. That is a structural proxy ("no Money in `NominationState`"), and it is a defensible one, but no test in `tests/server/nomination.test.ts` places a nomination for a Team stated to have zero cap space. The matrix row is satisfied by construction, not by demonstration.

- **`leagueClockExpiry` is specified, built and unit-tested, but has no production consumer.**
  Relates to: AC4 ("when the League Clock is folded, then its expiry is 48 hours from that Nomination") and the Intent's stated problem ("the phase would expire 48 hours after the open no matter what the league did").
  Evidence: `grep` over `src/` shows `leagueClockExpiry`, `leagueClockReducer` and `INITIAL_LEAGUE_CLOCK` referenced only inside `src/lib/core/projection/league-clock.ts` itself and from tests. Nothing in `src/lib/server` or `src/routes` folds the clock or reads the expiry, so the reset the story exists to introduce changes no observable product behaviour yet. This is consistent with the spec's scope (no sweep, no surface for the clock is in the Code Map, and 1.11 shipped the reducer unused), so it is a boundary of the increment rather than a missed task — but AC4 is presently satisfied by unit test only.

- **`byTeam` holds a different shape than the Code Map specifies.**
  Deviates from: Code Map, `src/lib/core/projection/nominations.ts` — "`{ byPlayer: Record<fantraxPlayerId, {...}>, byTeam: Record<teamId, fantraxPlayerId> }`".
  Evidence: `OpenNominations.byTeam` is `Readonly<Record<string, OpenNomination>>` — the full nomination object, not the player id. The implementation's own comment justifies it ("both refusals name something individually rather than counting, and neither index can be derived from the other without a scan"), and it is what makes `slot_in_use` able to name the Player without a second lookup. A deviation in the code map's favour, not against AC2, but the Code Map line was not updated to match.

- **Two function signatures differ from the Code Map.**
  Deviates from: Code Map, `src/lib/server/nomination.ts`.
  Evidence: the spec states `loadNominationState(client, fantraxPlayerId, actorTeamId)` and `loadNominatablePool(gateway)`; the code ships `loadNominationState(client, fantraxPlayerId)` (the actor id is unused there — `refuseNomination` receives it in `decide`) and `loadNominatablePool(gateway, actorTeamId)` (needed to word `slotDetail` per AC2). Both changes are internally coherent; neither affects an AC.

- **A doc comment miscounts the refusals it then enumerates.**
  Contradiction internal to `src/lib/core/rules/nomination.ts` (the file the spec designates as the single definition of refusal wording).
  Evidence: "**Six of the eight** are re-derived INSIDE the transaction, under the lock: `phase`, `unknown_player`, `under_contract`, `already_nominated` and `slot_in_use`" — five are listed, and five is the correct number (`unconfirmed` and `unbound_actor` are route-level, `unrecorded` is defensive). Cosmetic, but it is the file a future story reads to learn where each gate lives.