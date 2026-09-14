---
title: 'Story 7.9: Detect a Roster Divergence from Fantrax'
type: 'feature'
created: '2026-09-14'
status: 'done'
review_loop_iteration: 0
baseline_commit: '523a82aa2ef4d5d081ba1f5df8ca3cbbb3143250'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A trade executed in Fantrax and never reported to the Commissioner leaves the app charging the wrong Team for a Contract — and because every Cap Space, Maximum Bid and Roster Count is a function of the rosters at that instant, the arithmetic stays wrong for the rest of the auction with nothing on any screen saying so. Stories 7.7 and 7.8 gave the Commissioner the acts; nothing tells him an act is needed.

**Approach:** An hourly shell read of `getTeamRosters` whose only fact is **membership**, compared in the pure core against the app's Existing Contracts to produce **proposals** — a Roster Trade per Team pair that moved Players, a Drop per Player on no Fantrax roster, an unknown arrival as a prominent error. A proposal is a pre-filled link into the Story 7.7 and 7.8 routes; this story writes no Trade, no Drop and no event. A plausibility guard refuses to raise anything from an implausible payload, and a reader that has stopped answering renders as **stopped**, never as *no divergences*.

## Boundaries & Constraints

**Always:**
- **The reader never receives a database client** (AD-32). Every Fantrax field name, URL, id form and status string lives inside `src/lib/adapters/fantrax/`; nothing outside it knows the endpoint exists.
- **Ids are normalised inside the adapter, both directions** — the API returns `01eon`, the FR-1 importer stores `*04ewu*` verbatim. An unnormalised comparison reads all 303 rows as a departure and an unknown arrival at once: a silent total failure, and an automated test must catch it.
- **Teams map by an explicit stored Fantrax team id, never by `teamName`** (AD-24). Any Team lacking one makes the detector *not configured*, which renders like *stopped* and never like *no divergences*.
- **Any code reading `salary` rounds to the nearest dollar and asserts the $500,000 grid** (`isOnMoneyGrid`), never truncates. `int()` put 4 of 303 live rows a dollar low and off the grid.
- **Membership is the only fact compared.** A Slot kind is carried as advisory and never raised; a placement difference is the expected state between a Move and the next export, not drift.
- The read runs in the shell, outside the write lock, and **at most once per hour** — never on the 10-second tick.
- Divergences are Commissioner-only, in every phase where an override is permitted, and absent once Archived. Every guard is asserted server-side in `load` *and* in each action.

**Ask First:**
- Any change to `team_rosters`, `auction_events`, or any existing rules module. This story adds tables and reads; it amends no existing gate.
- Enabling the new `pg_cron` job against a project holding real rosters before the Fantrax team ids are seeded — until they are, every Team reads as unmapped.

**Never:**
- Never write an event, a `team_rosters` row, or a projection from a read. Never apply a Trade or a Drop automatically — every write goes through Story 7.7 or 7.8 with FR-32's mandatory reason.
- Never take money, contract length or Slot placement from the endpoint as authoritative.
- Never drop a Player from the membership set because his `salary` failed the grid — a membership-only detector that discards a row over an unused field manufactures a departure.
- Never let a read failure block, delay or reverse any auction action.
- Never render an empty proposal list when the last read failed or a guard tripped.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Player moved | App holds P on A; Fantrax holds P on B | One proposed Roster Trade for the pair {A,B}, every moved Player on the correct side, linking to `/roster-trade` pre-filled | N/A |
| Player gone | App holds P on A; P on no Fantrax roster | One proposed Drop for A, linking to `/roster-drop` pre-filled | N/A |
| Unknown arrival | Fantrax holds P; app holds him nowhere and he has no Auction Contract | Reported as a prominent **error**, never as a proposal | Stated as a fault: mis-set league id, wrong period, or out-of-band change |
| Won this auction | P has an Auction Contract | Excluded from both sides — neither a departure nor an arrival | N/A |
| Placement only | App holds P in a Minor League Slot, Fantrax `ACTIVE` | Nothing raised | N/A |
| Ids unnormalised | API `01eon` vs stored `*04ewu*` | Normalised to one form before comparison; a test proves the unnormalised path is caught | N/A |
| Float salary | `23499999.999999993` | Rounds to `$23,500,000` and passes the grid | Off-grid after rounding: a named money warning on the read; the Player stays a member |
| Implausible payload | HTTP 200 with 3 Teams, or any Team with an empty roster | Guard trips: **stopped**, nothing raised | Never clears itself; Commissioner acknowledges, then sees the proposals |
| Too much at once | Proposals touching more than a quarter of the League | Guard trips, same as above | Fraction tunable without a code change |
| Read fails | Unreachable, 429, 5xx, malformed JSON | Renders **stopped** with the reason and the time of the last good read | No auction action blocked; nothing raised |
| Unmapped Team | A Team has no Fantrax team id | Renders **not configured**, naming the Teams | Nothing raised |
| Called twice in an hour | A second invocation inside the interval | Skipped, stating when the next read is due | N/A |
| Dismissed | Commissioner dismisses a divergence | Suppressed until its content changes | A changed content is a new fingerprint and re-raises |

</frozen-after-approval>

## Code Map

**The precedent to mirror — read these before writing anything.** Story 7.7's Trade and 7.8's Drop are the acts this story proposes into: `src/lib/core/rules/roster-trade.ts`, `src/lib/core/rules/roster-drop.ts`, `src/lib/server/roster-trade.ts`, `src/routes/roster-trade/`, `src/routes/roster-drop/`.

**The proposal is a link, not new plumbing — the story's largest saving:**
- `src/routes/roster-trade/+page.server.ts:234-237` — the action reads its selection from **`url.searchParams`**: `from`, `to`, repeated `send`, repeated `recv`. `src/routes/roster-drop/+page.server.ts:218-219` — `team`, repeated `drop`.
- The only POST field either reads is the reason, `OVERRIDE_REASON_FIELD` (`src/lib/core/rules/override.ts`), via `requireOverrideReason` (`src/lib/server/override-guard.ts:104`). **A proposal therefore needs no new form, no new sheet and no new write path** — it builds a query string and the existing route does the rest, reason sheet included.
- `src/routes/roster-trade/+page.server.ts:64-71` and `roster-drop/+page.server.ts:56-63` — the guard order to copy: `requireCommissioner` → `requireLiveDestination` → `requireOverridablePhase`, in `load` *and* in the action.

**The adapter (`src/lib/adapters/fantrax/roster-api.ts`, new):**
- `src/lib/adapters/fantrax/roster-file.ts:2-5,31-35` — the confinement rule, and the statement that the id is stored asterisk-wrapped verbatim; `:63-69` the exported column map, `:253` the single exported parse function, `:106-113` `ROSTER_SLOT_ALIASES`. **`INJURED_RESERVE` does not match the `injured reserve` alias** — the API needs its own map (`ACTIVE`/`RESERVE` → `active_bench`, `MINORS` → `minor_league`, `INJURED_RESERVE` → `injury_reserve`), declared separately and exhaustive over the union with no `default`.
- `src/lib/core/types.ts:162` — `RosterSlotKind`, the closed four-member union.
- `src/lib/core/money.ts:155-158` — `isOnMoneyGrid`, documented at `:144-149` as the predicate an imported figure must call; `:218-227` `formatExactDollars`, the off-grid-safe renderer for the warning text.
- `src/lib/adapters/discord/webhook.ts:319-322` — **the outbound-HTTP template**: `createDiscordWebhookPort({ webhookUrl, fetch })` takes both URL and a structural `FetchLike` (`:134-141`) as parameters, reads no `$env` itself, **never throws** (`:326-368`), returns a result union (`:99-107`); the URL never reaches a `detail` string (`:314-317`) and bodies truncate at 500 chars (`:297-301`). No timeout exists there — this reader adds an `AbortSignal`, because an undocumented third party can hang where a webhook does not.
- Observed live shape (2026-09-10, unauthenticated, 30 Teams, 303 rows): per Team a `teamName`, a Fantrax team id and `salaryCap`; per row `{"contract":{"smallId","name"},"id":"01eon","position","salary":2.25E7,"status"}`.

**The pure comparison (`src/lib/core/rules/divergence.ts`, new):**
- `src/lib/core/projection/contracts.ts:212-218` — `contractForPlayer(contracts, fantraxPlayerId)`: non-null **is** "won in this auction". `:240-252` `contractRowsFor`. Won Players are excluded from both sides.
- `src/lib/core/types.ts:939-1021` — the `RecordRosterTrade` command/gate block, `:1023-1128` the outcome shapes. This story declares **no command and no gate set**: a divergence is not a rule and passes no gate. Declare the proposal types beside the comparison instead.
- `scripts/check-core-purity.js` — the comparison takes the instant and the fraction as parameters and reads no clock, no network and no `Intl`.

**Configuration and the explicit Team map:**
- `supabase/migrations/20260821010000_teams.sql:19-35` — `teams` is `id`/`name`/`created_at` and **carries no Fantrax identifier**; `:14-15` — "No admin UI ships for assigning either column. The Commissioner writes them directly." **That is the precedent: these ids are seeded by script, not by a screen.**
- `scripts/seed-league.js:50-56,358-362` — the 30-Team insert, and the shape a companion seeding script follows.
- `src/lib/server/team-registry.ts:61-79` — `resolveTeamByFileName`, the app's one name-based match. **It is the import path and must not be reused here**; AD-24 forbids name matching for this read.
- `src/lib/core/constants.ts:1-15` — the file states plainly that no env var or config edits these values; `:78` `LIVENESS_INTERVAL` is the doc-comment convention. The hourly interval belongs here. FR-42's tunable fraction cannot, so the **core default lives here and the shell may override it from `$env/dynamic/private`**, passing the effective value in as a parameter.
- `.env.example:1-11,75,91` — the name-only list and the rule that no secret takes a `PUBLIC_` prefix; `src/lib/server/supabase.ts:37-48` — the `required()` validation convention.

**The hourly trigger and the read record:**
- `supabase/migrations/20260831000000_tick.sql:180-233` — the `pg_cron` job: schedule, `net.http_post`, URL and secret both from `vault.decrypted_secrets`, never a literal; `:237` created `active := false`. `supabase/functions/tick/auth.ts:60-67,98-103` — the constant-time secret compare.
- `src/routes/api/watermark/+server.ts:59` — the shape of an unlocked API route.
- `supabase/migrations/20260831000000_tick.sql:75-105,138` — `tick_heartbeats`: **one row per pass regardless of outcome**, `grant select, insert` only. This is the precedent `fantrax_reads` copies, and AD-19's reasoning is the same — the dangerous state is the outage that looks like health.
- `src/lib/server/sweep.ts:32-38,377-381` — a module that takes no lock, and the unlocked `select now()`; `src/lib/shell/write.ts:235-241,247` — `runTransactionalWrite` and where the lock is taken, for contrast. **Nothing in this story calls it.**
- `supabase/migrations/20260914000000_nomination_slot_released_on_win.sql` — house style and the latest timestamp; a new migration sorts after it. Prose header, `if not exists` guards, `comment on table`/`on column`, RLS enabled and forced with no policy, `revoke all` then a narrow `grant`, and the closing "Applied dev-first (AD-26)" line.

**The surface:**
- `src/lib/server/destinations.ts:47-93` — the `Destination` shape and frozen factory; `:144,155` the `roster-trade` registrations to copy; `:175-212` `resolveDestinations` and `requireLiveDestination`.
- `src/lib/server/commissioner-guard.ts:45,50-53` — `requireCommissioner`, and the statement that hiding a control is never the check. `src/lib/server/override-guard.ts:120-123` — `requireOverridablePhase`, which refuses only `Archived`.
- `src/lib/core/freshness.ts:111-118,131-157` — `deriveFreshness` and its fixed heading/statement copy: **the app's one precedent for a surface that states a pipe is down rather than showing nothing**. The stopped banner is worded the same way.
- `src/routes/assignment-monitoring/+page.svelte:121-126` — the genuinely-empty state, a stated sentence rather than a blank list. The two must be visibly different.
- `src/lib/server/import-status.ts:113-115` — outstanding items **named, never counted**; unmapped Teams and unknown arrivals follow it.

**Tests:**
- `tests/structure.test.ts:88-241,277-288` — `SECTION_10_EXAMPLES`; `tests/examples/` must hold **exactly** the registered set. **This story adds no §10 example** — §10 stops at 46 and none concerns divergence — so `tests/examples/` and that list are untouched.
- `tests/adapters/discord-webhook.test.ts` — the structural `FetchLike`/`HttpResponse` fake, built by hand with no `vi.mock`. The Fantrax reader is tested the same way.
- `tests/server/roster-drop.test.ts` — the `TransactionalClient` fake that throws on unexpected SQL: the mechanism for proving this story writes **no** event and **no** `team_rosters` row.
- `vite.config.ts:6-9` — `environment: 'node'`; markup claims are proven by source-text assertion.

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260915000000_fantrax_divergence.sql` (new) — add nullable `teams.fantrax_team_id text unique`; create `fantrax_reads` (append-only: `read_at`, `outcome`, `detail`, normalised `membership jsonb`, money-warning count) and `fantrax_divergence_dismissals` (`fingerprint` primary key, `dismissed_at`, `dismissed_by`); and the hourly `pg_cron` job, `active := false`, URL and secret from Vault with no literal — the Team map must be explicit (AD-24), the read record is what makes *stopped* renderable (AD-19), and the read must not ride the 10-second tick.
- [x] `scripts/seed-fantrax-team-ids.js` (new) — write the 30 Fantrax team ids onto `teams`, refusing any that does not resolve to exactly one Team, and reporting Teams still unmapped **by name** — `teams.sql:14` says no admin UI ships for this column, and `seed-league.js` is the shape.
- [x] `src/lib/adapters/fantrax/roster-api.ts` (new) — the reader: a pure `createFantraxRosterPort({ baseUrl, leagueId, period, fetch, signal })` that never receives a database client, returning a result union (`ok` | `unreachable` | `rate_limited` | `malformed`); normalises player ids in both directions; maps `status` to `RosterSlotKind` exhaustively with `INJURED_RESERVE` mapped separately; exports the rounding-and-grid helper for `salary`. Every Fantrax name stays here (AD-24).
- [x] `src/lib/core/constants.ts` — `DIVERGENCE_READ_INTERVAL` (one hour) and the default implausible-volume fraction (a quarter), each with the doc comment stating its source and why — the interval is a rate-limit courtesy to an undocumented third party, not a freshness figure.
- [x] `src/lib/core/rules/divergence.ts` (new) — `compareMembership`: exclude every Player with an Auction Contract; classify each app-held Player as unchanged, moved or departed; group movements by unordered Team pair into one proposed Trade each; departures into one proposed Drop per Team; every remaining Fantrax-held Player as an unknown arrival error. Then the plausibility guard — all 30 Teams present, no empty roster, and no pass touching more than the given fraction of the League — returning a tripped verdict that suppresses every proposal. Plus a stable `fingerprint` per divergence and per tripped guard, derived from content alone.
- [x] `src/lib/server/divergence.ts` (new) — the shell: enforce the hourly interval from the last `fantrax_reads` row, call the port, insert exactly one `fantrax_reads` row per attempt whatever the outcome, and — separately — read the latest row, load rosters and contracts, apply dismissals, and hand the core its inputs for the surface. Reads unlocked; **calls `runTransactionalWrite` nowhere**.
- [x] `src/routes/api/fantrax-read/+server.ts` (new) — the hourly invocation, guarded by a constant-time compare of a shared secret exactly as the tick is, answering 2xx for a recorded failure and non-2xx only when the record itself could not be written.
- [x] `src/lib/server/destinations.ts` — one Commissioner-only destination in the `Auction` and `Contract Assignment` arrays, absent from `Archived`.
- [x] `src/routes/divergence/+page.server.ts` + `+page.svelte` (new) — `load` and a `dismiss` action, both calling the three guards in the established order; proposals rendered as pre-filled links into `/roster-trade` and `/roster-drop`; unknown arrivals and unmapped Teams **named**; stopped, not-configured and tripped-guard states each stated distinctly from *no divergences*; an acknowledgement that reveals the proposals behind a tripped guard; operable at 375px.
- [x] `.env.example` + the reader's configuration — the league id, period, base URL, invocation secret and the optional volume-fraction override, each named with its rationale and no `PUBLIC_` prefix.
- [x] `tests/adapters/fantrax-roster-api.test.ts` (new) — the hand-built `FetchLike` fake over a fixture of the observed payload: id normalisation in both directions **and a test that fails if the comparison is fed unnormalised ids**, the four `status` mappings, `23499999.999999993` → `$23,500,000` on the grid, truncation rejected, and every failure mode returning a union member rather than throwing.
- [x] `tests/core/rules/divergence.test.ts` (new) — the I/O matrix rows: movement, departure, unknown arrival, won-Player exclusion, placement-only silence, multi-Player Trade grouping, both halves of the guard, and fingerprint stability across a re-read with change on changed content.
- [x] `tests/server/divergence.test.ts` (new) — the interval is enforced, one `fantrax_reads` row per attempt including failures, **no event and no `team_rosters` statement ever issued**, and a dismissal suppressing exactly one divergence.
- [x] `tests/routes/divergence.test.ts` (new) + `tests/destinations.test.ts` — the three guards on `load` and on the action, the destination absent for a Manager and once Archived, and the stopped/not-configured/tripped states each distinct from the empty state in the rendered source.

**Acceptance Criteria:**
- Given the reader module, when it is type-checked, then no signature accepts a database or transactional client — a write from inside it is a type error, not a discipline (AD-32).
- Given a read of any outcome, when `auction_events`, `team_rosters` and every projection are inspected, then none has changed, and exactly one `fantrax_reads` row was appended.
- Given the last read failed, or a guard tripped, or any Team is unmapped, when the Commissioner opens the surface, then it states that plainly with the time of the last good read and **never** the words *no divergences*; and given a genuinely clean read, then the empty state is visibly and textually different.
- Given a tripped guard, when the page is reloaded any number of times, then it stays tripped until the Commissioner acknowledges it — it never clears itself — and acknowledging reveals the proposals rather than discarding them.
- Given a proposed Trade or Drop, when the Commissioner follows it, then the existing Story 7.7 or 7.8 route opens pre-filled and still demands its own reason before writing anything.
- Given a Trade is recorded in the app, when the next comparison runs against the same payload, then that divergence is gone with no dismissal needed.
- Given a dismissed divergence, when the comparison runs again unchanged, then it stays suppressed; and when any Player, Team or direction in it changes, then it raises again.
- Given the volume fraction is changed by configuration alone, when the app restarts, then the guard trips at the new threshold with no code change.
- Given a Fantrax read that hangs, is refused, or returns malformed JSON, when an auction close or a bid is attempted in the same window, then neither is blocked, delayed or reversed.

## Spec Change Log

## Design Notes

**Why membership is stored and the comparison runs at render.** The hourly job stores exactly what Fantrax said — the normalised Team → Players map — and derives nothing. Comparing at render rather than at read time is what makes "once recorded, the divergence resolves on the next read" arrive immediately instead of up to an hour later, and it keeps the stored row a transcript of a third party rather than an opinion about the league. The row is never folded, never read by a rule, and never consulted for money; it is the same shape as `tick_heartbeats` and exists for the same reason AD-19 gives.

**Why a money rule in a story that takes no money.** The rounding-and-grid helper ships and is tested now because the hazard goes live the moment anything reads `salary`, and the next reader will then be reaching for an existing helper rather than writing `int()`. But a failed grid check refuses **the figure, not the Player**: dropping a row from the membership set over an unused field would manufacture a departure — hazard 2's silent-total-failure shape arriving through the door built to prevent it. The Player stays a member and the read carries a named warning.

**Why a dismissal is a row and not an event.** Every Epic 7 override appends an event because it changes what the arithmetic computes. A dismissal changes nothing the app computes — it says "not now" about an unconfirmed reading of a third-party system, and it undoes itself the moment the underlying difference changes. Giving it an event and a reason sheet would put auction-grade ceremony on a "seen it" click, and a third party's noise in the league-visible log.

**Pairing is grouping, not matching.** A movement is directly observable — the app says P is on A, Fantrax says P is on B — so no reverse movement has to be found for it to be a Trade. Grouping every movement by unordered Team pair gives one proposal per pair, and a one-directional gift is a Trade with an empty side, which `/roster-trade` already accepts. A departure is a Drop only when the Player is on **no** Fantrax roster at all.

## Verification

**Commands:**
- `npm run check` — expected: zero errors.
- `npm test` — expected: full suite green, every pre-existing test unchanged.
- `npm run build` — expected: passes, including `scripts/check-core-purity.js` (`core/rules/divergence.ts` imports only relative `.ts` paths and touches no forbidden global).

**Manual checks:**
- Apply the migration to **dev**, run the seeding script, and confirm all 30 Teams carry a Fantrax team id and the surface stops saying *not configured*.
- Call `/api/fantrax-read` with a wrong secret and confirm a bare 401 before any connection opens; call it twice inside the hour and confirm the second is skipped and says when the next read is due.
- Point the reader at an unreachable host and confirm the surface reads **stopped** with the last good read's time, that a bid and a close both still work, and that the wording could not be mistaken for *no divergences*.
- Hand-edit a dev `team_rosters` row to a different Team, run a read, and confirm one proposed Trade appears, opens `/roster-trade` pre-filled, and still demands a reason.
- Confirm the destination is absent for a Manager and absent for everyone once Archived, and that the page is operable at 375px.

## Suggested Review Order

**The comparison, and what it refuses to say**

- Start here: the whole comparison in order — exclude won, classify, group, guard.
  [`divergence.ts:459`](../../src/lib/core/rules/divergence.ts#L459)

- The plausibility guard: 30 Teams, no empty roster, no pass over the fraction.
  [`divergence.ts:710`](../../src/lib/core/rules/divergence.ts#L710)

- Content-only fingerprints, separated by U+001F so two sets cannot collide.
  [`divergence.ts:436`](../../src/lib/core/rules/divergence.ts#L436)

**The reader, confined to one module**

- The port: no database client in any signature, so a write is a type error.
  [`roster-api.ts:490`](../../src/lib/adapters/fantrax/roster-api.ts#L490)

- The id form lives here, not in the core — the core compares opaque strings.
  [`roster-api.ts:89`](../../src/lib/adapters/fantrax/roster-api.ts#L89)

- Rounds and asserts the grid; a failure warns and keeps the Player a member.
  [`roster-api.ts:270`](../../src/lib/adapters/fantrax/roster-api.ts#L270)

- `INJURED_RESERVE` mapped separately from the CSV alias, exhaustive, no default.
  [`roster-api.ts:126`](../../src/lib/adapters/fantrax/roster-api.ts#L126)

**The shell: reads unlocked, records every attempt**

- The interval decided on a short connection, released before the HTTP read.
  [`divergence.ts:169`](../../src/lib/server/divergence.ts#L169)

- Canonicalises all three sides, then compares; a failed read raises nothing.
  [`divergence.ts:348`](../../src/lib/server/divergence.ts#L348)

- A typo'd fraction is ignored and logged — it can never disarm the guard.
  [`divergence.ts:662`](../../src/lib/server/divergence.ts#L662)

**The trigger and the record**

- 401 before any connection; a recorded failure is 2xx, 503 says unconfigured.
  [`+server.ts:62`](../../src/routes/api/fantrax-read/+server.ts#L62)

- Hourly as a five-field expression — an interval string would raise on apply.
  [`20260915000000_fantrax_divergence.sql:246`](../../supabase/migrations/20260915000000_fantrax_divergence.sql#L246)

- The append-only read record: one row per attempt, whatever the outcome.
  [`20260915000000_fantrax_divergence.sql:83`](../../supabase/migrations/20260915000000_fantrax_divergence.sql#L83)

- The explicit Team map AD-24 requires, with its not-blank constraint.
  [`20260915000000_fantrax_divergence.sql:53`](../../supabase/migrations/20260915000000_fantrax_divergence.sql#L53)

**The surface**

- Three guards on `load`, and again on the action — visibility is never the check.
  [`+page.server.ts:60`](../../src/routes/divergence/+page.server.ts#L60)

- The dismiss action: one row, no event, and a notice true for both kinds.
  [`+page.server.ts:73`](../../src/routes/divergence/+page.server.ts#L73)

- Commissioner-only, in the two phases the acts are live, absent from Archived.
  [`destinations.ts:151`](../../src/lib/server/destinations.ts#L151)

**Peripherals**

- The hourly interval and the default volume fraction, with their reasoning.
  [`constants.ts:221`](../../src/lib/core/constants.ts#L221)

- The endpoint's own contract, proven against the real handler.
  [`fantrax-read.test.ts:1`](../../tests/routes/api/fantrax-read.test.ts#L1)

- The hazard-2 proof: unnormalised ids read the whole League as departed.
  [`divergence.test.ts:1`](../../tests/server/divergence.test.ts#L1)
