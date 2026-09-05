# Sprint Change Proposal — Thirty-eight stories done, and nothing has ever run

- **Date:** 2026-09-05
- **Raised by:** Meakel (Commissioner / builder)
- **Trigger:** Not a story. The gap between 38 completed stories and an application that has
  never executed against a real Supabase, a real Discord account, or a real Fantrax file.
- **Workflow:** bmad-correct-course, incremental mode
- **Scope classification:** **Moderate** — one epic added, one story promoted, the remainder
  resequenced. No completed story is modified, rolled back or invalidated. No FR, CAP or AD
  changes.

---

## 1. Issue Summary

**Problem statement.** `sprint-status.yaml` reads 38 of 50 stories `done` across six epics.
Epics 1 through 5 are complete: identity, the append-only log, the import pipeline, the
nomination and bidding engine, the self-resolving auction, every screen the league lives on, and
the Discord notification path. **None of it has ever been executed against real infrastructure.**
Every one of those stories was verified by a test suite running against `node`, an ephemeral
local Postgres, or nothing at all.

The immediate requirement is a **moderator pilot**: a group of league moderators signing in with
their own Discord accounts and manually driving a real Fantrax import and a real auction, before
the true auction opens later this week.

Two distinct problems sit underneath that, and they need separating because they resolve
differently:

**(a) An unowned category of work.** Account-side provisioning and league-data seeding belong to
no epic. They exist only as scattered `source_spec: none` entries in `deferred-work.md` — a file
`AGENTS.md` explicitly marks as *not* a backlog: *"do not build a deferred item unprompted."*
The work is therefore simultaneously mandatory and unbuildable, and invisible to
`sprint-status.yaml`.

**(b) Genuinely new scope.** A human-driven pilot is not Story 8.1. Story 8.1 specifies a
*synthetic* rehearsal — "driven", "no wall-clock waiting", "asserted, not eyeballed", against
"a fake 30-Team league" with "no code path special-cased for it". Real moderators clicking a real
Discord OAuth handshake is a different activity, and no story in the project describes it.

**How it was discovered.** Raised directly by the Commissioner while planning the auction date,
not surfaced by a story. That is consistent with the shape of the gap: no story could have
surfaced it, because every story's verification is a test suite, and the missing thing is
precisely what a test suite cannot prove.

### Evidence

| # | Finding | Source |
| --- | --- | --- |
| 1 | Neither Supabase project is provisioned. No migration has been applied anywhere. | `deferred-work.md:8`; reconfirmed in `netlify.toml`'s CSP comment as recently as Story 4.1 (2026-09-01): *"Neither project is provisioned, so there is still no ref to name"*; confirmed by the Commissioner 2026-09-05 |
| 2 | No Discord OAuth2 application, no league channel, no incoming webhook. The server exists. | AD-15 (identity) and AD-18 (notifications) both require account-side setup; confirmed by the Commissioner 2026-09-05 |
| 3 | The Fantrax column maps are unverified placeholders. | `src/lib/adapters/fantrax/roster-file.ts:37` and `pool-file.ts`, both `TODO-confirm`; `deferred-work.md:143` (AR-33) |
| 4 | CSP `connect-src 'self'` blocks the Realtime socket — **BLOCKING**, not anticipatory, since Story 4.1 landed the client. | `deferred-work.md:91`; `tests/headers.test.ts` pins the directive |
| 5 | **No admin UI exists to register a Manager or bind a Team.** | `supabase/migrations/20260821010000_teams.sql:14` — *"No admin UI ships for assigning either column. The Commissioner writes them directly, the same way `managers` rows were seeded in Story 1.3"*; restated in `spec-1-4`'s **Never** list |
| 6 | The tick's cron schedule ships `active = false`. Nothing closes until it is enabled. | `supabase/migrations/20260831000000_tick.sql:23` |
| 7 | No README, no `docs/`. The setup path for the OAuth app, the webhook, the recovery secret and the Edge Function deploy is undocumented. | `deferred-work.md:27` |
| 8 | `hermes.md` §3 is stale — it claims everything past Story 1.1 is `backlog`. | already logged at `deferred-work.md:210` |
| 9 | CI runs no Postgres, so **every integration test in the repository is silently skipped**. | `deferred-work.md:215` |

**Finding 5 is the one that bites hardest.** A moderator whose Discord snowflake is not already a
row in `managers` is refused at sign-in — and AD-15 requires that refusal reveal nothing about
whether the account or any team exists. So before any moderator can log in, each tester's Discord
user ID must be hand-seeded via SQL and bound to a hand-seeded `teams` row. There is no screen
for this, deliberately, and no script for it either.

**Finding 4 has a second-order consequence worth stating.** The pilot's testers will see the
freshness indicator sitting in `Reconnecting` rather than `Live` until Story 9.3 lands. That is
the honest degradation Story 4.1 designed for — the board still refreshes on the same-origin
liveness poll — but a tester who does not know that will report it as a bug, and it will consume
pilot time that should be spent on the auction rules.

---

## 2. Impact Analysis

### Epic impact

| Epic | Impact |
| --- | --- |
| Epic 1 — Setup day | **None to scope.** Its eleven stories are code-complete. But the *act* of setup day has never happened, on any project. Story 9.8 is that act. |
| Epic 2 — Nominate and bid | **None to scope.** Code-verified only; the pilot is its first real execution. |
| Epic 3 — The auction resolves itself | **None to scope.** Note the tick has never run on a schedule anywhere — `active = false` by design. |
| Epic 4 — The screens | **None to scope.** Realtime is blocked by the CSP until Story 9.3. |
| Epic 5 — Notifications | **None to scope.** The outbox has never dispatched to a real webhook, so the 30 req/min ceiling and the batching decision remain untested against reality. |
| Epic 6 — Close the books | **Deprioritized, not reduced.** 6.3–6.5 are Contract Assignment phase activities and cannot precede an auction. |
| Epic 7 — The referee's controls | **Split. Story 7.4 promoted.** See below. |
| Epic 8 — Ready to open | **Partially superseded, partially deferred.** 8.2, 8.3, 8.4 stand and are scheduled pre-auction. 8.1 is deferred as an accepted deviation, recorded in the go-live gate. |
| **Epic 9 — NEW** | Owns provisioning, seeding, the Fantrax confirmation, the runbook, the pilot, and prod setup day. |

No epic is removed, renumbered or invalidated. No completed story is modified.

### The Story 7.4 finding

Story 7.4 (pause and resume) was characterized at intake as part of "commissioner tools and other
redundancies." It is not redundant. **It is a mandatory mitigation of the project's largest
single point of failure.**

AD-27 names Discord as both the only identity provider and the only outbound transport, and
states three mandatory mitigations. Mitigation (2) is *"a commissioner break-glass sign-in that
does not depend on Discord must exist, so FR-34's pause remains reachable when Discord is the
thing that failed."*

Story 1.3 built the break-glass **door** — `src/lib/server/commissioner-recovery.ts`, with
constant-time comparison, sliding-window throttling and a signed 12-hour expiry. Story 7.4 builds
the **room behind it**, and it is unbuilt. The recovery sign-in currently leads to an auction that
cannot be stopped.

`hermes.md` §8 states the posture: *"Anything beyond 15 minutes is a pause plus a compensating
clock adjustment, not wait-and-see."* Without 7.4 there is no pause, so there is no procedure —
only waiting, with clocks running.

Story 7.4 also carries its own rehearsal requirement (*"a break-glass path independent of
Netlify exists — a flag settable directly in the database — and it is documented and rehearsed"*),
which is what lets it close its own human-verification loop without a second full pilot.

### Story impact

- **No story added, modified or removed in Epics 1–8**, with one exception: Story 8.4's go-live
  gate acceptance criterion is amended (Proposal C).
- **Eight stories added** under the new Epic 9.
- **Story 7.4 promoted** to run immediately after the pilot.
- **`sprint-status.yaml` requires three edits** — two of which are pre-existing hygiene defects
  unrelated to this correction: Epics 4 and 5 sit at `in-progress` though every one of their
  stories reads `done`.

### Artifact conflicts

| Artifact | Conflict | Action |
| --- | --- | --- |
| `epics.md` | No epic owns provisioning, seeding or a human pilot | **Amend** — Proposal A (new Epic 9), Proposal C (Story 8.4 gate) |
| `sprint-status.yaml` | Epic 9 absent; Epics 4 and 5 mis-stated as `in-progress` | **Amend** — Proposal B |
| `deferred-work.md` | Eight entries now owned by Epic 9 stories but unmarked | **Append** — Proposal D1 (append-only; originals untouched) |
| `hermes.md` §3 | Materially false since ~2026-08-21 | **Rewrite** — Proposal D2 |
| `hermes.md` §9 | Names the Fantrax action without an owner | **Amend** — Proposal D3 |
| `traceability.md` | No record of Epic 9 | **Amend** — Proposal D3, preamble line only |
| `netlify.toml` + `tests/headers.test.ts` | `connect-src 'self'` blocks Realtime | **Code — Story 9.3.** Not a proposal here; it is story work |
| `prd.md` | None. No FR changes; the pilot validates requirements, it does not alter them | No change |
| `ARCHITECTURE-SPINE.md` | **None. No AD is contradicted, amended or added.** Three ADs — AD-26, AD-15/AD-18, AD-10 — are exercised for the first time | No change |
| `SPEC.md` | None. Epic 9 adds no capability; it executes CAP-1 – CAP-14 | No change |
| `DESIGN.md`, `EXPERIENCE.md` | No conflict. One pre-existing gap becomes actionable: `deferred-work.md:166` flags the eligibility list has *"no design mock to build against"* and is *"worth revisiting with a real export in hand"* | No change — routed to Story 9.7 |

**That the architecture needs no amendment is itself a finding.** The spine anticipated this work:
AD-26 already fixes dev-first migrations, AD-19 already requires the external detector, AD-21
already requires the offsite restore. What was missing was never a decision — only an epic to
carry the doing.

### Technical impact

- **No behavioural code change is proposed by this document.** Stories 9.3, 9.4, 9.5 and 7.4 are
  code, but they are story work, planned and reviewed through `bmad-build` in the normal way.
- **AD-20 note:** Story 9.3 touches only `netlify.toml` and `tests/headers.test.ts`, neither in
  `core/`. Story 9.5 touches `src/lib/adapters/fantrax/`, also outside `core/`. AD-20's
  pause-required-for-a-core-commit rule is not triggered by anything in Epic 9, and the auction is
  not live in any case.
- **First real infrastructure cost.** Netlify credits (300/month; exhaustion pauses the site) and
  Supabase Edge invocations (500K/month, shared org-wide) begin burning during the pilot. Story
  8.1's guidance applies and is inherited by Story 9.7: the dev cron schedule is enabled **only**
  for the pilot and disabled again afterward, and its invocation cost counts against the same
  org-wide ceiling production will later share.

---

## 3. Recommended Approach

**Option 1 — Direct Adjustment, as a hybrid. Selected.**
Effort: **High**. Risk: **Medium**.

Add one epic, promote one story, and state an explicit execution order across the remainder.
Nothing built is wrong; the gap is that a whole category of required work was never given a place
to live. This is the narrowest change that makes that work visible, sequenceable, and legal to
build under `AGENTS.md`'s deferred-work rule.

**Option 2 — Potential Rollback. Not viable.**
There is nothing to roll back. Thirty-eight stories are code-correct and untested-in-anger;
reverting any of them makes the pilot less possible, not more. Rollback answers "we built the
wrong thing." This is "we never ran the right thing."

**Option 3 — PRD MVP Review. Not viable, and not needed.**
No FR changes, no PRD goal moves, no capability is dropped. What changes is *order*, plus the
addition of work that was always required but never written down. Deferring 6.3–6.5 is not scope
reduction — export is a Contract Assignment phase activity that cannot run before there is an
auction to export.

### Decisions taken at intake

| Decision | Choice | Consequence |
| --- | --- | --- |
| Pilot target | **Dev project, branch deploy** | Pilot data is wipeable; prod stays untouched per AD-26; `netlify.toml` already maps branch deploys to dev, so no config change. Requires Story 9.8 to provision prod separately. |
| Pilot scale | **Full 30 Teams, real Fantrax data** | The only option that tests the thirty-one-file import at true size and proves the column maps against every team's real export. |
| Pre-auction controls | **7.4, 8.2, 8.3 and 8.4 — all four** | Every one is load-bearing per AD-19, AD-21 and AD-27. Also the most ambitious of the three options offered. |

### Timeline risk, stated plainly

Epic 9 (eight stories) plus 7.4, 8.2, 8.3 and 8.4 in the same week as the pilot is a large
scope. Two specific pressures:

- **Story 8.2 needs a third-vendor account** that does not exist yet — AD-19 requires the detector
  run outside both Netlify and Supabase, in a third failure domain, not routed through Discord.
  That is the longest lead time in the plan, which is why it is sequenced first within Epic 8.
- **Story 7.4 is broad** — it touches the tick's paused check under the global lock, a refusal
  path worded distinctly from every rules refusal, a paused banner on every surface, and a
  database-level break-glass flag independent of Netlify.

The execution order below is arranged so that if something slips, it slips in the order that costs
least. **The item that must not slip is 7.4**: a running auction that cannot be stopped is the
failure mode with no recovery.

**One flag, not a request to revisit a settled decision.** Story 7.2 (void a Bid) is the most
valuable unbuilt story outside the selected set. Live auctions produce mistakes, and without 7.2
a bad bid is permanent. The Commissioner's selection stands; this is recorded so the trade-off is
visible if time appears.

### Execution order

| # | Work | Rationale |
| --- | --- | --- |
| 0 | **9.5 + 9.1 in parallel, immediately** | 9.5 is the only unbounded-risk item in the plan. Pull the real export first, so a surprise surfaces while there is still week left to absorb it. |
| 1 | 9.2, 9.3, 9.4, 9.6 | Everything else the pilot needs. 9.3 is a small change; 9.6 accretes as the others are done. |
| 2 | **9.7 — the moderator pilot** | Time-boxed, and needs moderator scheduling. Runs against what exists. |
| 3 | **7.4 — pause and resume** | Its own AC requires the break-glass path be rehearsed, closing the human-verification loop without a second pilot. |
| 4 | 8.2, then 8.3, with 8.4 drafted in parallel | 8.2 first for account lead time. 8.4 is cheap to write and is the artifact the gate blocks on. |
| 5 | **9.8 — provision prod and run setup day** | Last, so it runs against everything the pilot taught you. |
| 6 | *Real auction opens* | Gated on Story 8.4's amended go-live gate. |
| 7 | 6.3–6.5 | Contract Assignment phase. |
| 8 | 7.1–7.3, 7.5, then 8.1 | Post-auction. |

---

## 4. Detailed Change Proposals

All four proposals below were reviewed and approved individually in incremental mode on
2026-09-05.

### Proposal A — New Epic 9 in `epics.md`

**Rationale.** The provisioning, seeding and pilot work currently exists only as scattered
`source_spec: none` entries in `deferred-work.md`. `AGENTS.md` forbids building a deferred item
unprompted, so this work is simultaneously mandatory and unbuildable. An epic makes it visible in
`sprint-status.yaml`, sequenceable, and legal to build.

**Why Epic 9 and not Epic 0.** Appending avoids renumbering 50 stories across `sprint-status.yaml`,
`epics.md` and 44 spec files. Execution order is stated explicitly in Proposal B rather than
implied by number.

**NEW — appended to `epics.md` after Epic 8:**

> ## Epic 9: Stand it up and let the league in
>
> The app stops being code and becomes a thing people use: both vendors provisioned, the schema
> applied dev-first, the league's real data seeded, the Fantrax column maps confirmed against a
> real export, and a group of league moderators signed in with their own Discord accounts driving
> a real import and a real auction on the dev project — before thirty people depend on it.
>
> **FRs covered:** none new — this epic *executes* FR-1 through FR-27 for the first time against
> real infrastructure.
>
> **Also carries:** the two-vendor account setup no story owns, the hand-seeded `teams` and
> `managers` rows that exist because AD-15 ships no admin UI by design, the CSP widening Story 4.1
> left blocking, AR-33's real-export confirmation, the setup runbook the repository has never had,
> and the pilot's findings triaged back into the backlog.
>
> **Standalone:** the difference between an app that passes its tests and an app that works.

**Stories:**

| Story | Kind | Discharges |
| --- | --- | --- |
| **9.1** Provision Supabase dev and apply the schema | Human | `deferred-work.md:8`; exercises AD-26 dev-first for the first time |
| **9.2** Provision the Discord application, channel and webhook | Human | AD-15 + AD-18, account side |
| **9.3** Admit Realtime to the CSP | **Code** | `deferred-work.md:91` — the BLOCKING entry |
| **9.4** Seed thirty Teams and the moderator Managers | **Code** | The `teams.sql:14` no-admin-UI gap, as a repeatable script |
| **9.5** Confirm the Fantrax column maps against a real export | **Code** | AR-33 / `deferred-work.md:143` |
| **9.6** The setup runbook | **Docs** | `deferred-work.md:27` |
| **9.7** Run the moderator pilot | Human | The new requirement itself |
| **9.8** Provision prod and run setup day for real | Human | Closes the prod gap opened by choosing a dev-only pilot |

**Three constraints carried into story planning:**

1. **9.3 must edit `tests/headers.test.ts` in the same commit.** The test pins `connect-src` to
   exactly `["'self'"]`. That coupling is deliberate — `deferred-work.md:91`: *"the widening
   cannot happen silently."* Hosts are added as literals (`https://<ref>.supabase.co`,
   `wss://<ref>.supabase.co`), **never** `*.supabase.co`, which would admit every other tenant on
   the platform.
2. **9.4 delivers a checked-in script, not typed SQL.** `AGENTS.md` forbids typing *schema* into
   the dashboard; data seeding is not schema, so it is permitted — but thirty Team rows plus
   Manager bindings typed by hand is exactly the failure mode this project designs against
   everywhere else. A script also makes the wipe-and-reseed before the real auction a one-command
   operation.
3. **9.5 is the only story with unbounded risk.** Every other story here has a knowable shape;
   this one depends on what Fantrax actually produces. `deferred-work.md:144` limits the blast
   radius to two objects by design — but if the real headers differ, *"every one of the
   thirty-one files will refuse at content altitude on setup day."* It is scheduled first for
   that reason.

**9.8 detail.** Create the prod project, apply migrations dev-first per AD-26, seed thirty Teams
and all 31 Managers (not just moderators), import the 31 real Fantrax files, set Minor League
Eligibility by hand, and confirm all 31 Managers hold Discord accounts — Story 8.4's go-live gate
requires that last item explicitly, *"since FR-4 makes Discord load-bearing for access rather than
convenience."*

---

### Proposal B — `sprint-status.yaml`

**Two hygiene fixes, unrelated to this correction.** Epics 4 and 5 have every story `done` but sit
at `in-progress`:

```yaml
  epic-4: done          # was: in-progress — all 6 stories done
  ...
  epic-5: done          # was: in-progress — all 4 stories done
```

**The new epic, appended after the `epic-8` block:**

```yaml
  epic-9: backlog
  9-1-provision-supabase-dev-and-apply-the-schema: backlog
  9-2-provision-the-discord-application-channel-and-webhook: backlog
  9-3-admit-realtime-to-the-csp: backlog
  9-4-seed-thirty-teams-and-the-moderator-managers: backlog
  9-5-confirm-the-fantrax-column-maps-against-a-real-export: backlog
  9-6-the-setup-runbook: backlog
  9-7-run-the-moderator-pilot: backlog
  9-8-provision-prod-and-run-setup-day-for-real: backlog
  epic-9-retrospective: optional
```

Plus `last_updated: 2026-09-05`. Slugs follow the file's existing 64-character truncation
convention.

---

### Proposal C — Amend Story 8.4's go-live gate

**Rationale.** The gate is the checklist actually run before opening. Three of its six clauses are
now owed by specific Epic 9 stories, and two new conditions exist that were not contemplated when
Epic 8 was written. Leaving it unamended means running the gate against a list that no longer
describes the project.

**Location:** `epics.md`, Story 8.4, final acceptance criterion.

**OLD:**

> **Given** the go-live gate
> **When** the Commissioner runs it before opening
> **Then** the **§10 suite is green** across all 28 examples
> **And** the **restore has been rehearsed** and its outcome recorded
> **And** the **liveness detector has been proven** to wake a sleeping operator
> **And** **`coreVersion` parity** holds between the Node and Deno deployments
> **And** a **real Fantrax export** has been obtained and the salary and roster-slot columns confirmed against the adapter
> **And** **all 31 Managers are confirmed to hold Discord accounts**, since FR-4 makes Discord load-bearing for access rather than convenience

**NEW:**

> **Given** the go-live gate
> **When** the Commissioner runs it before opening
> **Then** the **§10 suite is green** across all 28 examples
> **And** the **restore has been rehearsed** and its outcome recorded (Story 8.3)
> **And** the **liveness detector has been proven** to wake a sleeping operator (Story 8.2)
> **And** **`coreVersion` parity** holds between the Node and Deno deployments
> **And** a **real Fantrax export** has been obtained and the salary and roster-slot columns confirmed against the adapter (Story 9.5)
> **And** **all 31 Managers are confirmed to hold Discord accounts**, since FR-4 makes Discord load-bearing for access rather than convenience (Story 9.8)
> **And** the **moderator pilot has been run** against the dev project and every finding it produced is triaged — fixed, or logged in `deferred-work.md` with the risk of opening without it stated (Story 9.7)
> **And** the **pause control has been exercised** against a running auction, including the break-glass path independent of Netlify, because pause is the one control whose first use must not be during the outage it exists for (Story 7.4)
> **And** where the gate is opened with a condition unmet, the **unmet condition is named in writing** alongside the decision to proceed — the gate may be knowingly overridden, but never silently
>
> **Given** Story 8.1's time-compressed synthetic rehearsal has **not** been run
> **When** the gate is evaluated
> **Then** this is recorded as an **accepted deviation**, not an oversight
> **And** the substitution is stated plainly: the moderator pilot exercised the real code paths with real people and real data, but **not** against a compressed clock — so the 24-hour and 48-hour clock paths remain first exercised in production
> **And** the §10 suite's clock examples are the only standing evidence for those paths

**On the accepted-deviation clause.** It is deliberately uncomfortable. `hermes.md` §8 records
that this project names its single points of failure rather than hiding them, and Story 8.1's own
premise is that the clock paths *"are not first exercised in production with thirty people
watching."* Deferring 8.1 reverses that. Writing it into the gate keeps the decision visible at
the moment it would be acted on, and costs nothing to reverse if time appears for a narrow 8.1
slice.

**On the never-silently clause.** Given the timeline, the realistic case is not that every gate
condition is met — it is that one or two are not and the auction opens anyway. That clause makes
it a recorded decision rather than a thing that merely happened.

---

### Proposal D — Record-keeping across three files

#### D1 — `deferred-work.md`: append `assigned:` lines

New status key, consistent with the file's existing `partial:` / `escalated:` / `verified:` /
`resolved:` pattern. **Append-only: no original entry text is edited or deleted.**

| Entry | Annotation |
| --- | --- |
| `:8` Supabase provisioning | `assigned: 2026-09-05 to Story 9.1 (dev) and Story 9.8 (prod), Epic 9.` |
| `:12` Netlify branch mapping + credit cost | `assigned: 2026-09-05 to Story 9.1 — the outstanding half only; the site itself has been live since 2026-08-20.` |
| `:27` README / setup path | `assigned: 2026-09-05 to Story 9.6.` |
| `:91` CSP `connect-src` (BLOCKING) | `assigned: 2026-09-05 to Story 9.3, unblocked by 9.1 giving it a ref to name.` |
| `:143` AR-33 Fantrax export | `assigned: 2026-09-05 to Story 9.5, scheduled first in Epic 9 as the only unbounded-risk item.` |
| `:166` Eligibility list UX | `assigned: 2026-09-05 to Story 9.7 — revisit with the real pool in hand, per this entry's own recommendation.` |
| `:210` Stale `hermes.md` §3/§7 | `resolved: 2026-09-05 by the §3 rewrite in Proposal D2.` |
| `:215` CI runs no Postgres | `unblocked: 2026-09-05 — Story 9.1 creates the first real database. Not a pilot blocker; recommended immediately after.` |

`:215` warrants a second look when there is air. `npm test` currently reports green while every
integration assertion in the repository is silently skipped — including the one that surfaced a
genuine order-dependence defect the moment a real Postgres appeared.

#### D2 — `hermes.md` §3, replacing the stale block

**OLD** opens *"Epic 1, Story 1.1 … is the next thing to finish"* and *"Everything else — Epics 1.2
through 8.4, 52 stories — is `backlog`."* Both false since approximately 2026-08-21.

**NEW:**

> ## 3. Current state
>
> **Epics 1–5 are complete — 36 stories, all `done`.** Epic 6 is 2 of 5. Epics 7 and 8 are
> untouched. **Epic 9 (added 2026-09-05 by sprint change proposal) is the active epic** and the
> current priority: provisioning, seeding, and a moderator pilot.
>
> **The load-bearing fact: none of the 38 completed stories has ever run against real
> infrastructure.** Everything is code-verified only. Epic 9 is where that changes.
>
> `sprint-status.yaml` is the authority on what is done, not this file.
>
> ### Branches in flight
>
> `feat/6-2-track-completion-and-a-deadline-that-resolves-nothing`, merge pending. CI green on main.
>
> ### Infrastructure
>
> - **Netlify: live.** `bbslapp` serving at `https://bbslapp.netlify.app`. Branch-to-environment
>   mapping committed in `netlify.toml`; **not confirmed account-side**, and no Supabase project
>   exists for it to map to yet.
> - **CI: live.** `npm ci` / `npm test` / `npm run check` on every push and PR. **Runs no
>   Postgres**, so every integration test is silently skipped.
> - **Supabase: NOT provisioned — confirmed 2026-09-05.** Neither dev nor prod exists. No migration
>   has ever been applied anywhere. Story 9.1 is the first.
> - **Discord: NOT provisioned — confirmed 2026-09-05.** The server exists; there is no OAuth2
>   application, no league channel and no webhook. Story 9.2 owns all three.
> - **Cron: ships inactive.** `20260831000000_tick.sql` creates `bbsl-tick` with `active = false`
>   deliberately. Nothing closes until it is enabled, and it is disabled again after the pilot.

#### D3 — `hermes.md` §9 and `traceability.md`

- **`hermes.md` §9** — "Open action before setup day" is now Story 9.5. Add the pointer; keep the
  existing text, whose thirty-one-files insight remains the sharpest statement of that trap in the
  repository.
- **`traceability.md`** — one line in the "Updated" preamble, following the file's own convention:
  Epic 9 added 2026-09-05; **no capability changed, no FR moved, no AD touched**, because Epic 9
  executes existing capabilities rather than adding one.

---

## 5. Implementation Handoff

**Scope: Moderate.** Backlog reorganization plus story execution. Route to **Product Owner /
Developer**.

### Deliverables

1. Apply Proposals A and C to `epics.md`.
2. Apply Proposal B to `sprint-status.yaml`.
3. Apply Proposal D1 (append-only), D2 and D3.
4. Run `bmad-sprint-planning` to validate the amended `sprint-status.yaml`.
5. Begin Story 9.5 and Story 9.1 in parallel, immediately.
6. Commit on a branch and PR to `main` — never commit to `main` directly (`AGENTS.md`).

### Responsibilities

| Owner | Work |
| --- | --- |
| **Commissioner (human, non-delegable)** | 9.1, 9.2, 9.7, 9.8 — every account-side action requires credentials no agent holds. Also: obtaining the real Fantrax export that 9.5 depends on, and collecting each moderator's Discord snowflake for 9.4. |
| **Developer agent (`bmad-build`)** | 9.3, 9.4, 9.5, 9.6, then 7.4, 8.2, 8.3, 8.4 — planned, built and reviewed in the normal way. |
| **Product Owner** | The artifact edits above; sprint-status validation. |

### Success criteria

- Epic 9 exists in `epics.md` with all eight stories, and in `sprint-status.yaml` as `backlog`.
- Epics 4 and 5 read `done`.
- Story 8.4's go-live gate names the pilot, the pause rehearsal, the never-silently clause, and
  the 8.1 accepted deviation.
- All eight `deferred-work.md` entries carry a dated annotation, and every original entry's text
  is intact.
- `hermes.md` §3 describes the project as it is on 2026-09-05.
- `npm test` and `npm run check` pass unchanged — no proposal in this document alters behaviour.
- **The pilot's exit criterion:** every finding is triaged before the real auction opens — fixed,
  or logged with the risk of opening without it stated.

### Explicitly not in scope

- Story 8.1's synthetic rehearsal — deferred, recorded as an accepted deviation in the amended
  gate.
- Stories 7.1, 7.2, 7.3, 7.5 — post-auction. 7.2 (void a Bid) is flagged in §3 as the most
  valuable of these.
- Stories 6.3–6.5 — Contract Assignment phase.
- `deferred-work.md:215` (Postgres in CI) — unblocked by 9.1, recommended immediately after, not a
  pilot blocker.

---

## Checklist Record

| § | Item | Status |
| --- | --- | --- |
| 1.1 | Triggering story identified | Done — none; raised directly, and that is itself the finding |
| 1.2 | Problem categorised | Done — technical limitation + new requirement, separated |
| 1.3 | Evidence gathered | Done — 9 cited findings |
| 2.1 | Current epic completable as planned | Done — Epic 6 unaffected in scope |
| 2.2 | Epic-level changes required | Done — one epic added (Epic 9); none removed or redefined |
| 2.3 | Remaining epics reviewed | Done — 6 deprioritized, 7 split, 8 partially deferred |
| 2.4 | Epics invalidated or newly needed | Done — none invalidated; Epic 9 newly needed |
| 2.5 | Epic order or priority | Done — full execution order stated in §3 |
| 3.1 | PRD conflicts | N/A — no FR changes, MVP unaffected |
| 3.2 | Architecture conflicts | N/A — no AD contradicted, amended or added |
| 3.3 | UI/UX conflicts | Done — no conflict; one pre-existing gap routed to Story 9.7 |
| 3.4 | Other artifacts | Done — sprint-status, deferred-work, hermes, traceability |
| 4.1 | Option 1 Direct Adjustment | Viable — selected as hybrid. Effort High, Risk Medium |
| 4.2 | Option 2 Rollback | Not viable — nothing to roll back |
| 4.3 | Option 3 MVP Review | Not viable — no scope reduced or redefined |
| 4.4 | Path selected | Done — Option 1, hybrid |
| 5.1–5.5 | Proposal components | Done — §§1–5 above |
| 6.4 | `sprint-status.yaml` update | Action-needed — Proposal B, plus two pre-existing hygiene fixes |
