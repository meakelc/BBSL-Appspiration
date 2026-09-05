---
title: 'Track completion, and a deadline that resolves nothing'
type: 'feature'
created: '2026-09-05'
status: 'done'
baseline_commit: '68f184e5806122450cf04e76e3f4f9e89db88ca9'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 6.1 lets a Manager assign contract lengths, but nobody can see who has finished. `/assignment-monitoring` sits in the destination catalog with no route behind it, and the Contract Assignment Phase has no deadline construct at all — no instant, no reminder, no notice. So the Commissioner cannot tell a stalled league from a finished one, and the only nudge available is asking in Discord by hand.

**Approach:** The Commissioner sets an assignment deadline and a reminder interval, both appended events folded like everything else. On the existing tick, one reminder goes to Teams with unassigned Players when the deadline is one interval away, and at the deadline itself those Teams and the league channel are notified — and nothing else happens. A Commissioner-only monitoring page reads the fold: which Teams have submitted, which have not, and how many Players each still owes.

## Boundaries & Constraints

**Always:**
- The deadline exists only once the Commissioner sets it. Until then no reminder and no deadline notice can fire, and the monitoring page says the deadline is unset.
- Once set, the deadline may only move later. A set that does not move it later is refused, naming the standing deadline. This is the extension path; there is no separate extend command.
- Every reminder and every deadline notice appends an event in the same transaction as its enqueue, and the fold keys both markers to the deadline instant they fired for. The tick runs every ten seconds and must send each exactly once.
- Extending the deadline re-arms both markers, because the new deadline is a different instant. A Team that has since submitted is not reminded again.
- All deadline arithmetic is pure core over folded state with an injected `now`. `now` reaches it from the database server clock through the tick, never a client clock.
- Reminders and notices go through the existing outbox under the existing `contract_assignment` category. No new transport, no new schedule, no new category.
- Both Commissioner acts are two-part — a value and a separate confirmation — and the server refuses an unconfirmed post independently of the UI, as `nominate` and `/contract-assignment` already do.
- Voice: no exclamation marks, no urgency framing, no suggested action. The app states facts.

**Ask First:**
- Any change to the close, sweep-ordering or League Clock logic inside `src/lib/server/sweep.ts` beyond adding one optional injected step alongside `endPhase` and `drain`.
- Adding any table or column to hold the deadline, the interval, or reminder state.

**Never:**
- No contract length is written on any code path in this story. No default, no fallback, no "assign 1-year at the deadline". The Commissioner assigning on a Team's behalf is Story 7.3.
- The deadline passing changes no phase, blocks nothing new, and unlocks nothing. Unassigned Players stay unassigned; the export stays blocked by Story 6.3's own gate.
- No export, no export gate, no `/export-gate` route, no `/audit-log` route.
- No destination catalog change — `assignment-monitoring` is already registered as Commissioner-only.
- No change to `src/lib/core/rules/close.ts`, to the allotment arithmetic in `src/lib/core/rules/contract-assignment.ts`, or to the `/contract-assignment` Manager surface.
- No Year Allotment column swap on `/teams`, the persistent strip or `/teams/[teamId]`.
- No repeating nag. One reminder per deadline, one notice per deadline.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Set the first deadline | No deadline, Commissioner posts a future instant, confirmed | Accepted; event appended; monitoring page states it | N/A |
| Extend | Deadline stands, a later instant posted | Accepted; both markers re-armed | N/A |
| Shorten or repeat | Deadline stands, an equal or earlier instant posted | Refused, naming the standing deadline | `fail(409, { notice })` |
| Deadline in the past | Instant at or before `now` | Refused | `fail(400, { notice })` |
| Reminder fires | Deadline and interval set, `now` at or past `deadline − interval`, marker unset | One `AssignmentRemindersSent` appended; mentions enqueued for Teams with unset Players only | N/A |
| Reminder already sent | Same state, marker matches this deadline | Nothing appended, nothing enqueued | N/A |
| Interval unset | Deadline set, no interval | No reminder ever fires; the deadline notice still fires | N/A |
| Deadline passes | `now` at or past deadline, marker unset | One `AssignmentDeadlinePassed` appended; mentions to Teams still unset plus a league-channel line; no length written | N/A |
| Every Team submitted at the deadline | No Team has unset Players | Marker appended, no mentions; the league-channel line still records it | N/A |
| Unconfirmed post | Value present, confirm absent | Refused | `fail(400, { notice })` |
| Non-Commissioner | Any session without the role | Route refuses server-side before any read | `requireCommissioner` 403 |
| Wrong phase | Phase is Auction or Archived | Route refuses server-side before any read | `requireLiveDestination` 403 |

</frozen-after-approval>

## Code Map

- `src/lib/core/projection/assignments.ts` -- `ASSIGNMENTS_SUBMITTED_EVENT` `:41`, `SubmittedTeams = ReadonlySet<string>` `:54`, `hasSubmittedAssignments` `:66-68`, `assignmentsReducer` `:92-107`. `:37-39` names this story as its consumer. READ-ONLY: fold it, do not change it.
- `src/lib/core/rules/contract-assignment.ts` -- `unassignedContracts(contracts, teamId)` `:182-187` returns a Team's won contracts with `contractYears === null`; this is the per-Team unset count. `ContractAssignmentRefusal` `:213-245` and `contractAssignmentRefusalDetail` `:256-301` are the refusal-union and wording split to copy. `assignmentBoardFor` `:433-482` is the view-model pattern. READ-ONLY: the allotment arithmetic is Story 6.1's.
- `src/lib/core/projection/contracts.ts` -- `AuctionContract` `:170-188` (`teamId`, `teamName`, `contractYears: ContractYears | null` `:185`), `contractsWonBy` `:283-301`, `contractsReducer` `:396-434`.
- `src/lib/core/projection/phase.ts` -- `LeaguePhase` `:45`, `CONTRACT_ASSIGNMENT_OPENED_EVENT` `:80`, `phaseReducer` `:99-108`.
- `src/lib/core/rules/phase-end.ts:258-333` -- `decidePhaseEnd(state, now)`: the model for a pure tick decision returning events or `null`. `readPhaseEndInstants` `:174-184` is the payload-reader pattern.
- `src/lib/core/projection/nominations.ts:98` -- the house pattern for declaring an event constant beside the reducer that owns it.
- `src/lib/core/types.ts` -- `EventEnvelope` `:91-101`, `AppendedEvent` `:119-133`. `managerId` and `teamId` on the envelope carry the acting actor.
- `src/lib/server/phase-end.ts:159-232` -- `evaluateLeagueClock`: THE template for this story's tick step. One `runTransactionalWrite`, `load` folding off one log read `:114-122`, `decide` delegating to the core rule `:188-197`, `enqueue` `:183-185`, outcome read back off `outcome.events` `:211-231`.
- `src/lib/server/sweep.ts:279-284` -- `runTick({ gateway, closeOne, endPhase?, drain? })`. Add one optional step in the same shape, called after `endPhase` `:393-418` and before `drain` `:420-429`. `CLOCK_SQL` `:254` and `:318-319` are where `now` enters.
- `supabase/functions/tick/index.ts:184-220` -- where `closeOne`, `endPhase` and `drain` are wired; wire the new step here too.
- `src/lib/server/outbox.ts` -- `enqueueMentions(affectedTeams)` `:355-395` (mentions only — use for reminders), `enqueueBroadcastsAndMentions` `:408-414` (use for the deadline notice), `AffectedTeamsFn` `:312`, dedupe `on conflict (event_seq, channel, recipient)` `:290-294`. `MANAGERS_OF_TEAM_SQL` `:255-260` resolves co-Managers to one intent each.
- `src/lib/adapters/discord/mention.ts` -- `CONTRACT_ASSIGNMENT_CLAUSE` `:97`, clause map `:159`, `categoryFor` `:175-190` already maps `ContractAssignmentOpened` to `contract_assignment`, `flatLine` use `:371-373`. Add the two new event types in the same shape.
- `src/lib/adapters/discord/broadcast.ts:55-66` -- `BROADCAST_EVENT_TYPES` and `isBroadcastEventType`; `:427` the `ContractAssignmentOpened` notice. Add `AssignmentDeadlinePassed` only.
- `src/lib/core/notification-categories.ts:47-52` -- `contract_assignment` already exists and is unmutable. READ-ONLY: no new category.
- `src/lib/server/destinations.ts:85-91` -- `assignment-monitoring` ALREADY registered, `commissionerOnly: true` `:89`; `requireLiveDestination` `:136-144`. READ-ONLY.
- `src/lib/server/commissioner-guard.ts:50-53` -- `requireCommissioner`.
- `src/routes/import/+page.server.ts:52-79, :146-147` -- both guards in `load` AND re-called in every action. `+page.svelte:275-330` and `:515-569` -- the house responsive technique: a stacked `<ul>` at 375px and a `<table>` from the same data, swapped by `display: none` at `min-width: 640px`.
- `src/lib/server/teams-index.ts:103-131` -- `loadTeamIdentities`, the every-Team read (`teamId`, `teamName`, `managerNames`).
- `src/lib/core/team-identity.ts:36-39` -- `formatTeamManager` produces `Lakers — Meakel`; `:69-77` for multiple Managers.
- `src/lib/server/contract-assignment.ts:82-90` -- `loadContractAssignmentState`: one `loadEventsViaClient` read folded twice. Extend the same shape for this story's folds.
- `src/routes/contract-assignment/+page.server.ts:110` and `+page.svelte:205` -- the two-part act and the `role="status"` refusal prose to copy.
- `tests/routes/import.test.ts:10-17` -- house route-test pattern: guards left REAL, only the I/O module mocked.
- `tests/server/sweep.test.ts:32, :46-80` -- the fake gateway that pattern-matches SQL and injects `now`.
- `tests/core/phase-end.test.ts` and `tests/server/phase-end.test.ts` -- the closest existing tick-rule test pair.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/assignment-deadline.ts` -- new: declare `ASSIGNMENT_DEADLINE_SET_EVENT`, `ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT`, `ASSIGNMENT_REMINDERS_SENT_EVENT` and `ASSIGNMENT_DEADLINE_PASSED_EVENT`, and fold `{ deadline, reminderIntervalHours, remindedFor, passedFor }` -- the two markers hold the deadline instant each fired for, which is what makes the tick idempotent and an extension re-arming.
- [x] `src/lib/core/rules/assignment-deadline.ts` -- new: refuse a deadline that is unconfirmed, unparseable, at or before `now`, or not later than the standing one; refuse an interval that is not a whole number of hours from 1 to 168; and `decideAssignmentDeadlineTick(state, now)` returning the marker events to append or `null` -- one pure decision, no I/O, mirroring `decidePhaseEnd`.
- [x] `src/lib/core/rules/assignment-monitor.ts` -- new: build the monitoring view model from folded contracts, submissions, deadline state and the Team identities -- per-Team submitted/unset rows, the completion count, and the deadline and interval sentences, all worded by the core.
- [x] `src/lib/server/assignment-deadline.ts` -- new: `setAssignmentDeadline` and `setReminderInterval` through `runTransactionalWrite` re-deriving every gate under the lock; `evaluateAssignmentDeadline(gateway)` as the tick step, enqueueing mentions for reminders and broadcasts-plus-mentions for the deadline notice; `loadAssignmentMonitor(gateway)` for the page.
- [x] `src/lib/server/sweep.ts` + `supabase/functions/tick/index.ts` -- add one optional injected step in the shape of `endPhase`, called after it and before `drain`, and wire `evaluateAssignmentDeadline` to it -- the deadline is evaluated on the existing tick, not a new schedule.
- [x] `src/lib/adapters/discord/mention.ts` + `src/lib/adapters/discord/broadcast.ts` -- word the reminder and the deadline notice under the existing `contract_assignment` category; broadcast only `AssignmentDeadlinePassed`.
- [x] `src/routes/assignment-monitoring/+page.server.ts` -- new: `requireCommissioner` and `requireLiveDestination(..., 'assignment-monitoring')` in `load` and re-called in both actions; `load` returns the monitor view model.
- [x] `src/routes/assignment-monitoring/+page.svelte` -- new: stacked list at 375px and a table at 640px from the same data; both Commissioner acts two-part; refusals as prose in a `role="status"` div.
- [x] `tests/core/assignment-deadline.test.ts` and `tests/core/assignment-monitor.test.ts` -- new: the fold, every refusal, the tick decision and the view model, with no database, covering every I/O Matrix row.
- [x] `tests/server/assignment-deadline.test.ts`, `tests/routes/assignment-monitoring.test.ts` and `tests/server/sweep.test.ts` -- new and extended: the commands' gates inside the transaction, the tick step's placement and its idempotency across repeated passes, and the route's real guards across all four phases.

**Acceptance Criteria:**
- Given the Contract Assignment Phase, when the Commissioner opens `/assignment-monitoring`, then every Team is listed as submitted or not with how many Players it still owes, operable at 375px and tabular on desktop.
- Given a deadline and an interval are set, when the tick first runs at or after `deadline − interval`, then Teams with unassigned Players are mentioned once and no further tick re-sends.
- Given the deadline passes, when the tick evaluates it, then the affected Teams and the league channel are notified, no contract length is written on any code path, unassigned Players stay unassigned, and no phase changes.
- Given the Commissioner extends the deadline, when it is accepted, then the extension is recorded as an appended event and the reminder and the notice both re-arm for the new instant.
- Given any accepted act, when it is recorded, then an event is appended carrying the acting Manager, and an automated test asserts no code path in this story writes a contract length.

## Spec Change Log

## Design Notes

**The markers are the idempotency.** The tick fires every ten seconds. `remindedFor` and `passedFor` hold the deadline instant each marker fired for, not a boolean, so re-sending is impossible while the deadline stands and automatic once it moves. Appending the marker in the same transaction as the enqueue means a crash between the two is impossible; the outbox's own `(event_seq, channel, recipient)` conflict clause is the second line of defence, not the first.

**Why a set-only-later rule.** FR-29 grants an extension, not a rescheduling. One event type covers both the first set and every extension, and refusing a non-later instant means the log reads as a monotonic record of a deadline that only ever moved outward — which is what "the extension is logged" is asking for.

**Nothing here is a gate.** The deadline passing appends a marker and sends messages. It does not change phase, does not mark a Team delinquent, and does not touch the export gate, which is Story 6.3's own check over `unassignedContracts`.

## Verification

**Commands:**
- `npm test` -- expected: all suites green, including the extended `tests/server/sweep.test.ts`.
- `npm run check` -- expected: clean.
- `git diff --stat` -- expected: nothing under `supabase/migrations/`, nothing in `src/lib/core/rules/close.ts`, nothing in `src/lib/server/destinations.ts`, and no change to the allotment arithmetic in `src/lib/core/rules/contract-assignment.ts`.

## Suggested Review Order

**The fold — a deadline, and two markers that key on it**

- The whole story in one type: the markers hold an instant, not a boolean.
  [`assignment-deadline.ts:116`](../../src/lib/core/projection/assignment-deadline.ts#L116)

- Latest set wins, markers carried through unchanged — which is what re-arms them.
  [`assignment-deadline.ts:185`](../../src/lib/core/projection/assignment-deadline.ts#L185)

- Review-added: an unreadable instant is rejected, so the gate can always compare.
  [`assignment-deadline.ts:152`](../../src/lib/core/projection/assignment-deadline.ts#L152)

**The tick decision — where nothing is the usual answer**

- Four ways to `null`, each a state rather than a failure; both may fire in one pass.
  [`assignment-deadline.ts:396`](../../src/lib/core/rules/assignment-deadline.ts#L396)

- Who is owed, from the contracts fold alone — never asked of two folds.
  [`assignment-deadline.ts:308`](../../src/lib/core/rules/assignment-deadline.ts#L308)

- The one derivation of the reminder instant, so no two surfaces differ by an hour.
  [`assignment-deadline.ts:356`](../../src/lib/core/rules/assignment-deadline.ts#L356)

**The gates — a deadline that only ever moves outward**

- Past checked before monotonic; one event type covers set and extension alike.
  [`assignment-deadline.ts:183`](../../src/lib/core/rules/assignment-deadline.ts#L183)

- Whole hours, 1 to 168, and why each bound is where it is.
  [`assignment-deadline.ts:212`](../../src/lib/core/rules/assignment-deadline.ts#L212)

**The write path — markers and their intents commit together**

- The tick step: one read, three folds, every gate re-derived under the lock.
  [`assignment-deadline.ts:228`](../../src/lib/server/assignment-deadline.ts#L228)

- The Commissioner act, refused against the database clock and never a client one.
  [`assignment-deadline.ts:121`](../../src/lib/server/assignment-deadline.ts#L121)

- One optional step in `endPhase`'s shape, after it and before the drain.
  [`sweep.ts:334`](../../src/lib/server/sweep.ts#L334)

- Where it is actually wired into the existing ten-second tick.
  [`index.ts:201`](../../supabase/functions/tick/index.ts#L201)

**The surface — worded entirely by the core**

- Rows, completion and every sentence, from one derivation shared with the tick.
  [`assignment-monitor.ts:98`](../../src/lib/core/rules/assignment-monitor.ts#L98)

- Review-added: a past instant answers 400, a non-later one 409.
  [`+page.server.ts:74`](../../src/routes/assignment-monitoring/+page.server.ts#L74)

- Stacked list at 375px, real table at 640px, from the same data.
  [`+page.svelte:132`](../../src/routes/assignment-monitoring/+page.svelte#L132)

**The copy — what the league channel actually sees**

- The reminder states the deadline and names nobody; the tally waits for the notice.
  [`broadcast.ts:446`](../../src/lib/adapters/discord/broadcast.ts#L446)

- It no longer claims the deadline is "one reminder interval away".
  [`mention.ts:125`](../../src/lib/adapters/discord/mention.ts#L125)

**Tests**

- The gap the review found: the first mention-only group ever drained.
  [`outbox.test.ts:936`](../../tests/server/outbox.test.ts#L936)

- The fold, every refusal and every tick branch, with no database.
  [`assignment-deadline.test.ts:170`](../../tests/core/assignment-deadline.test.ts#L170)

- The gates inside the transaction, and that no table but the outbox is touched.
  [`assignment-deadline.test.ts:1`](../../tests/server/assignment-deadline.test.ts#L1)

- Both guards, for real, on `load` and both actions across all four phases.
  [`assignment-monitoring.test.ts:1`](../../tests/routes/assignment-monitoring.test.ts#L1)
