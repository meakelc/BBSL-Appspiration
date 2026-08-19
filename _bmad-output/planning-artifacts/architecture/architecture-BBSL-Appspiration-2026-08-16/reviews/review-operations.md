---
title: Operations Review — BBSL Auction Architecture Spine
lens: operations / the 3am story
reviewer: operations reviewer
target: ARCHITECTURE-SPINE.md (draft, 2026-08-16)
sources:
  - _bmad-output/planning-artifacts/architecture/architecture-BBSL-Appspiration-2026-08-16/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/prds/prd-BBSL-Appspiration-2026-08-16/prd.md (§5 NFRs, §9 Risks)
  - _bmad-output/planning-artifacts/prds/prd-BBSL-Appspiration-2026-08-16/addendum.md
date: 2026-08-16
verdict: PASS WITH FINDINGS
---

# Operations Review — the 3am story

## Framing

This system runs for ~504 consecutive hours. It is operated by one person who is
also a competing participant and who is unconscious for roughly a third of every
cycle. Every clock in the product runs through the night by league rule (FR-16,
PRD §7.2 rejects an overnight freeze). The product's own vision statement names
the 4am loss as the emotional core of the thing.

So the operational question is not "is this well engineered." It mostly is. The
question is: **what happens between 02:00 and 07:00 when something breaks and
nobody is watching, and does the system degrade into *late* or into *wrong*?**

That distinction is the spine of this review. The architecture is extremely good
at making outcomes *correct* — pure core, event log, global lock, rebuildable
projections. It is systematically under-specified at making outcomes *survive
absence*. Almost every finding below is the same shape: a component that fails
silently, in a way only a human could notice, watched by a human who is asleep.

**Verdict: PASS WITH FINDINGS.** The paradigm is right and none of these findings
require re-architecting. But three are blocking before the auction opens, and one
of them is an arithmetic error in a note the spine presents as settled.

---

## Findings summary

| # | Severity | Finding | Bites when |
|---|---|---|---|
| OPS-1 | **CRITICAL** | Expiry is defined by the sweep having run, not by the clock. Bids after nominal expiry are not refused by any stated invariant. | Every sweep hiccup, every deploy, every 10s tick |
| OPS-2 | **CRITICAL** | Edge Function invocation arithmetic (AD-10 note) counts the sweep but not the dispatcher. Run-rate is ~518K/month against a 500K free-tier cap shared org-wide with the dev project and the mandated rehearsal. | Mid-auction, silently, once quota trips |
| OPS-3 | **CRITICAL** | A dead sweep is indistinguishable from a quiet 3am. Deferring "how the operator learns" is not acceptable — the mechanism has architectural placement consequences. | First overnight incident |
| OPS-4 | **HIGH** | FR-34 pause shares a failure domain (Netlify + Supabase Auth) with the outage it exists to escape, while the sweep does not. The escape hatch is unreachable in its primary scenario. | Any Netlify or Auth outage |
| OPS-5 | **HIGH** | No AD governs deploys, migrations, or rule changes during a live auction. AD-2's single-core guarantee is broken at deploy time across two independently deployed runtimes. | Certain — a solo builder will ship fixes mid-auction |
| OPS-6 | **HIGH** | AD-15 names two *records*, not a *restore path*. The Discord half is unreadable with the credential the system holds; reference data is not in the log; RTO is incompatible with the 15-minute NFR. | Low likelihood, total impact |
| OPS-7 | **HIGH** | §5's availability target (99.8%, no single outage >15 min) is unowned — no AD binds it, no row in the capability map — and is not achievable as a guarantee on two free tiers. | Continuously; it is already untrue |
| OPS-8 | **HIGH** | Commissioner overrides and pause/resume are not in FR-26's Discord broadcast set, and FR-34 pause requires no stated reason. The operator-is-a-participant risk is governed for the randomizer and nowhere else operationally. | Any override; and reputationally, forever |
| OPS-9 | **HIGH** | Pre-reveal lottery seeds are readable by the operator via the service role. Commit-reveal proves he didn't *change* the seed; it does not prove he didn't *see* it. | Every Minimum-Bid Contention he contends in |
| OPS-10 | **MEDIUM** | The sweep takes the global lock *blocking* on a 10s tick — convoy risk — and a single poison auction can block every other close in the pass. | Under any slow or buggy close |
| OPS-11 | **MEDIUM** | Secrets management is entirely absent. Service role in three places, no rotation, and a missing env var silently kills AD-15's durability record. | Any redeploy or env change |
| OPS-12 | **MEDIUM** | No continuous projection-integrity check and no shipped rebuild command. AD-5's strongest property is used as a repair tool but never as a detector. | Whenever a projection bug ships |
| OPS-13 | **MEDIUM** | Realtime/quota degradation yields a stale board with a convincing live countdown — actively misleading rather than merely broken. | Any Realtime disconnect |
| OPS-14 | **LOW** | Netlify build minutes (300/mo) and Supabase egress (5GB/mo) are unmeasured; the former can block a 3am hotfix. | Late in a debug-heavy build |

---

## 1. Can this hit the §5 availability target?

**The target.** ≤1 hour unplanned unavailability across ~504 hours (99.80%), no
single outage exceeding 15 minutes, and any outage >15 minutes requires a
commissioner pause plus a compensating clock adjustment.

**The honest answer: no, not as a guarantee, and the spine never says so.**

Two things are worth separating, because the spine's own design separates them and
then draws the wrong conclusion from it.

### 1a. The number itself is unowned

Search the spine for the availability NFR. AD-10 binds *"NFR timer reliability."*
Nothing binds *"NFR availability."* The Capability → Architecture Map has a row for
*"§5 Rule correctness"* and a row for *"§5 Durability & recovery"* — and no row for
§5 Availability. An NFR carrying two hard numbers has no owning decision anywhere in
the document. That is a traceability defect independent of whether the number is
achievable.

### 1b. The number is not achievable on this stack

- **Supabase free tier carries no SLA at all** — the spine says so itself in AD-15,
  admirably, but only in the context of *backups*. The same sentence is fatal to the
  availability NFR and is never applied there.
- **Free-tier support is community/best-effort.** There is no ticket the operator
  can file at 03:00 that shortens an incident. His only lever on a 40-minute vendor
  outage is to wait.
- **Two independent vendors compose multiplicatively.** Even if each were 99.9%
  (neither is contractually anything), the joint web-plus-database path lands near
  99.8% *by itself*, leaving zero budget for anything the operator does.
- **The 15-minute single-outage clause is the binding constraint, not the 1-hour
  budget.** One 40-minute regional incident — well within normal vendor behaviour —
  blows the single-outage clause by 2.7x and consumes two-thirds of the entire
  three-week budget in one event. The probability of at least one such incident
  across 504 hours on two no-SLA free tiers is not small; it is closer to likely.

### 1c. The decoupling in AD-10 makes an outage *worse*, not better

This is the sharpest operational point in this section and the spine gets it exactly
backwards.

AD-10 states as a *consequence and benefit*: **"closes continue to fire during a
Netlify outage."** Read that through the 3am lens. Netlify is down for 40 minutes at
03:00. Managers cannot reach the board. They cannot bid. And the sweep — running
happily on the Supabase side — closes every auction whose 24-hour clock expires in
that window.

A manager who intended to raise at 23h58m loses a player because the *app* was
unreachable, not because he was inattentive. That is a wrong outcome produced by an
outage, which is SM-1 ("zero disputed outcomes") and is the single failure the PRD
says the league will not forgive. The architecture has converted an availability
problem into a *fairness* problem, and has described the conversion as a feature.

PRD §5 already knows the right answer — *"any outage longer than 15 minutes requires
a Commissioner pause and a compensating clock adjustment."* But that answer requires
a conscious commissioner. At 03:00 there isn't one. See OPS-4.

### Recommendation (OPS-7)

Two moves, both cheap:

1. **Renegotiate the NFR into something the architecture can actually guarantee.**
   The achievable promise is not an uptime number; it is a *correctness under
   unavailability* promise: *"unavailability may delay the auction but must never
   change an outcome. No auction closes during a window in which the league could not
   bid."* That is enforceable in code. 99.8% is not.
2. **Add an AD binding it.** Proposed: **AD-19 — Unavailability pauses the auction, it
   does not resolve it.** The close sweep must verify, before closing anything, that
   the bidding surface has been observed healthy within the last N minutes; if not, it
   closes nothing, appends a `AuctionAutoPaused` event, and alerts. Mechanism in
   OPS-3/OPS-4 below — the external monitor you need anyway is the natural heartbeat
   writer.

Note the pleasing consequence: with AD-19 plus OPS-1's fix, the operator can sleep
through a four-hour vendor outage and wake up to a *paused, correct* auction plus an
alert history, rather than to nine disputed results.

---

## 2. The close sweep dies silently. Is deferring observability acceptable?

**No. "How the operator learns the sweep died" is an invariant and must be fixed now.**
Three separate arguments, and then a fourth finding that changes what "died" costs.

### 2a. Argument from indistinguishability

A dead sweep produces *exactly* the observable signature of a healthy quiet night:
no closes, no Discord posts, no emails. The modal 3am is a quiet 3am. There is no
natural signal, no user complaint, and no error anyone sees. Every other component
in this system announces its own failure to someone — a broken page 500s at a
manager, a failed bid shows a refusal. The sweep is the one component whose failure
mode is *silence that looks like health*. The spine's own Deferred entry says this
("a stalled sweep is silent by nature") and then defers it anyway. Correctly
diagnosing the most dangerous property in the system is not a reason to postpone.

### 2b. Argument from blast radius growth

Time-to-detect is the whole variable, and cost grows superlinearly in it:

- Each auction whose clock passes during the outage is a *late* close at best.
- Each late close is potentially an FR-32 override to unwind — and SM-2 targets
  **fewer than 5 overrides across the entire auction**. An eight-hour overnight
  stall against ~30 concurrent auctions on rolling 24h clocks plausibly produces
  5–15 overdue closes in a single incident, blowing a primary success metric in one
  night.
- Late closes cascade: a close releases Committed Bids, releases Minors Exposure
  (FR-35), and releases a Nomination Slot (FR-9). Every one of those changes *other
  teams' Maximum Bid*. So a stalled close doesn't just delay one auction — it holds
  capital hostage league-wide and silently suppresses bids that would otherwise be
  legal. Managers experience this as "the app says I can't afford that" with no
  explanation. Nobody reports it as a bug; they report it as the app being wrong.

### 2c. Argument from architectural placement

The deferral says "revisit before the rehearsal." That is too late, because the fix
is not a config tweak — it is three structural commitments:

1. **A heartbeat has to be written by the sweep, inside its own transaction, into a
   table.** That is schema, governed by AD-16, and AD-16 says schema changes are
   migrations applied dev-first. Adding it after the schema is frozen and the
   rehearsal is running is exactly the "dashboard fiddling under pressure" AD-16
   exists to prevent.
2. **The detector must live outside both Netlify and Supabase.** This is the
   non-negotiable one and it is an architecture statement, not an ops chore: *no
   component may be responsible for reporting its own death.* A monitor inside
   Supabase cannot report Supabase being down. A monitor on Netlify cannot report
   Netlify being down. It needs a third party.
3. **The alert channel must share no component with the auction's own notification
   path.** If the alarm rides the outbox (AD-13), then an outbox stall — one of the
   two things you most need alerting on — takes the alarm with it. If it rides SMTP,
   AD-14's provider is a shared dependency. If it rides the Discord webhook, a
   Discord incident silences both. This constraint is invisible unless you write it
   down, and it is the difference between an alerting system and a decoration.

### 2d. The finding that changes everything: OPS-1

**A sweep outage should degrade to "closes are late." Under the spine as written, it
degrades to "closes are wrong."** Here is the trace.

During a sweep stall, the *web tier is up*. Managers keep bidding. Consider an auction
whose 24h clock nominally expired at 03:00 while the sweep was dead:

- Team A was leading at 03:00 and should have won.
- At 06:00, Team B — looking at a board that still shows the auction open — bids
  higher. Does the core refuse that bid?

**The spine never says.** AD-3 says the server emits absolute close timestamps. AD-10
says the sweep "reconciles every overdue auction it finds." Nowhere is there an
invariant stating that *an auction whose close time has passed is closed for
validation purposes, regardless of whether the sweep has materialised the close.*

If the core does not encode that, Team B's 06:00 bid is accepted, the sweep comes
back at 06:30, and Team B wins a player that Team A won at 03:00. The event log
faithfully records a wrong outcome. That is SM-1, and it is unrecoverable except by
commissioner override, in public, against a participant-operator.

There is a second, quieter version of the same defect even when the sweep is
perfectly healthy: on a 10-second tick there is always a **0–10 second window after
nominal expiry** in which a bid can land before the close is materialised. Every
single close in the auction passes through that window. Whether the last bid of a
$14M auction counts should not depend on cron scheduling jitter.

And a third: what timestamp does the close event carry? If it carries the sweep's
wall clock rather than the nominal expiry, then after any stall the audit log, the
Discord record (AD-15, load-bearing durability) and the countdown managers watched
all disagree about when the auction ended. Replay against the log then produces
different clock arithmetic than the live run did, breaking AD-5's byte-identical
rebuild promise.

### Recommendation (OPS-1, OPS-3)

**New invariant — AD-20: Expiry is a property of the clock, not of the sweep.**

- `decide(state, command, now, seed)` refuses any bid, join, or dissolve on an
  auction whose persisted absolute close time is `<= now`. The refusal reason is
  "auction closed at *T*," and it is correct whether the sweep ran or not. This
  costs one comparison in the pure core and is trivially testable — and note it
  fits AD-1 perfectly, because `now` is already an argument.
- The sweep **materialises** a close; it does not **cause** one. `AuctionClosed`
  carries `occurredAt = nominal expiry`, not the sweep's wall clock. Add a separate
  `materialisedAt` field if the operational delta is worth recording (it is —
  it is the evidence trail for every late close).
- The UI must render "closing — awaiting settlement" rather than a negative
  countdown for an auction past expiry that has not yet been materialised.

This one invariant simultaneously: makes a sweep outage safe, eliminates the 10s
race on every close, removes the operator's tick-phase timing edge (see §8), and
keeps replay honest. It is the highest-value single line in this review.

**New invariant — AD-21: No component reports its own death.**

- The sweep writes `sweep_heartbeat(last_pass_at, auctions_closed, core_version)`
  inside every pass, successful or not-yet-successful.
- The dispatcher writes the same for the outbox, plus `oldest_undelivered_at`.
- A **public health endpoint** on Netlify returns non-200 when any of: sweep
  heartbeat older than 90s, oldest undelivered outbox entry older than 5 minutes,
  live projection hash diverges from a shadow re-fold (OPS-12), or the league is
  paused.
- Two **external** monitors, crossed: one hitting the Netlify health endpoint (so
  Supabase-down is visible), one hitting a Supabase Edge health function directly
  (so Netlify-down is visible). Free tiers of UptimeRobot / Better Stack /
  cron-job.org do 1-minute checks. Prefer these over GitHub Actions schedules,
  whose firing is routinely delayed by 5–15 minutes under load — useless for a
  90-second staleness threshold.
- The alert must be a **phone-waking push or a phone call** — not email, per 2c.
  Pushover, ntfy, or a dedicated Discord channel with notification override, all
  free.
- Make the monitor's **status page public to the league.** This costs nothing and
  buys the single best governance control available to a participant-operator: it
  makes his outage claims falsifiable by the people most inclined to doubt them
  (see OPS-8).

---

## 3. Deploys and migrations during a live auction

Nothing in the spine addresses deploying while clocks run. This is not a gap of
emphasis; it is a whole missing dimension, and it is **certain** to be exercised —
a solo builder shipping a three-week live product will deploy mid-auction, probably
several times, probably at night, probably under stress.

### 3a. AD-2's guarantee is broken at deploy time

AD-2 is one of the strongest decisions in the document: *one rules core, one source
location, two runtimes*, preventing "an auction that closes under different rules
than it bids under — the most dangerous divergence available in this design."

It guarantees this at the **source** level. It is silent at the **deployment**
level, where the guarantee does not hold:

- The SvelteKit bundle (bidding path) deploys to Netlify via git push.
- The sweep bundle (closing path) deploys to Supabase via `supabase functions deploy`.

These are **two independent, non-atomic operations**. Between them — seconds if
things go well, minutes if a build queues, indefinitely if one fails and the
operator doesn't notice — bids are validated by core version *N+1* while closes are
computed by core version *N*. That is precisely the divergence AD-2 names as the
most dangerous available, reintroduced by the deployment topology AD-10 mandates.

**Recommendation:** stamp `coreVersion` (a content hash of `src/lib/core/**`) on
every appended event. Then:
- Divergence is *detectable after the fact* in the log, forever, for free.
- The sweep can refuse to close an auction whose accepted bids carry a different
  `coreVersion` than the sweep is running, failing safe into "late" rather than
  "wrong."
- The health endpoint compares the two deployed versions and goes red on mismatch,
  which turns a silent window into a paged alert.

### 3b. Rule changes mid-auction are a governance question, not just a safety one

The operator is a competing manager. A change to `core/rules/bidding` deployed at
11pm, unannounced, that later turns out to have favoured his team — even entirely
innocently — is indefensible after the fact. AD-12 recognises this exact dynamic for
the randomizer and solves it beautifully with commit-reveal. The same reasoning
applies with equal force to the rules themselves and is not applied.

**Recommendation — AD-22: A live rules change is an override.** Any production deploy
touching `src/lib/core/**` during the Auction Phase requires, in order: pause
(FR-34) → deploy both runtimes → verify `coreVersion` match → resume; plus a Discord
announcement naming what changed and why, and an audit-log entry with actor,
timestamp and reason — the identical treatment FR-32 gives a commissioner override,
because it *is* one, at larger scale. Deploys touching only `routes/` (view layer)
or `adapters/` need none of this.

This is mechanically enforceable and worth enforcing: CI diffs `src/lib/core/**`
against the deployed `coreVersion` and refuses a production deploy unless the league
is currently paused. That converts a discipline into a gate, which matters because
discipline is what fails at 3am.

### 3c. Migration safety while the sweep runs every 10 seconds

AD-16 says migrations are files applied dev-first. It says nothing about **when**,
and the "when" is where the damage is. Concretely:

- **Lock contention.** A migration taking `ACCESS EXCLUSIVE` on a projection table
  (`ALTER COLUMN TYPE`, adding a validated constraint, `CREATE INDEX` without
  `CONCURRENTLY`) queues against the sweep's read. Postgres lock queues are FIFO and
  *blocking* — the migration waits behind the sweep, and every subsequent bid then
  waits behind the migration. A 90-second index build becomes a 90-second total
  auction outage in which bids hang rather than fail. That is an operator-caused
  outage against a 15-minute NFR.
- **Shape drift.** Renaming a projection column while the previous sweep bundle is
  still deployed breaks every close until the function is redeployed. Nothing in the
  spine mandates expand/contract (add nullable → backfill → deploy code → contract in
  a *later* migration), and the naive path is the tempting one under pressure.
- **No down-migrations.** AD-16 requires migrations exist; it does not require they be
  reversible. See OPS-15 in §9.

**Recommendation — extend AD-16 with a live-auction migration procedure**, and note
that the architecture already contains its own answer, unused:

> **pause → migrate → rebuild projections from the log → verify byte-identical →
> resume.**

AD-5 already guarantees projections are disposable and rebuildable from the log and
calls rebuild *"the primary repair tool for a solo operator."* Nobody has connected
AD-5 to AD-16. That connection **is** the deploy story, and it makes migration risk
almost entirely disappear: if the migration mangles a projection, throw the
projection away and refold. Write it down.

Additionally: every migration sets `lock_timeout` (e.g. 3s) and `statement_timeout`
so a migration that *would* block the auction fails fast and visibly instead of
silently freezing bidding.

---

## 4. Secrets — a silent dimension

The spine never mentions secrets. Inventory of what actually exists:

| Secret | Lives in | Blast radius if lost |
|---|---|---|
| Supabase **service role key** | Netlify env, Edge Function secrets, operator's laptop `.env` | **Total.** Under AD-9 it is the *only* write path — it is the master key to the auction |
| Supabase anon key | shipped to the browser | None by design (read-only, AD-9) — correct |
| SMTP credentials | Edge Function secrets | Mail spoofed as the league; AD-14's path lost |
| Discord webhook URL | Edge Function secrets | Bearer-equivalent — anyone holding it posts *as the app* into the league channel, forging the AD-15 durability record |
| Supabase DB password | operator's machine, CI | Total |
| Netlify / GitHub deploy tokens | CI | Arbitrary code into production |
| **Pre-reveal lottery seeds** | a Postgres row | See OPS-9 — this one is *competitive*, not just security |

Why this is more than hygiene here:

- **Three copies of the service role key, one person, no rotation plan.** The most
  likely leak vector is not an attacker; it is the operator screenshotting a terminal
  into Discord at 3am while asking for help, or committing a `.env`.
- **AD-4's insert-only guarantee must be a real GRANT, not a convention.** AD-4 says
  "no `UPDATE` or `DELETE` is granted to any role, including the service role." Good —
  but that is a claim about database privileges that nothing verifies. It should be an
  automated test that asserts `UPDATE auction_events` fails for the service role, run
  in CI against the dev project. Otherwise the append-only property — which the entire
  audit and durability story rests on — is a comment.
- **A missing env var silently kills AD-15.** If a redeploy loses `DISCORD_WEBHOOK_URL`,
  every dispatch fails. AD-15 says a sustained delivery failure is *an incident, not a
  warning*. Nothing detects it. The outbox quietly accumulates, the league's "public
  permanent record" stops mid-auction, and the operator finds out from a manager
  asking why the channel went quiet — possibly days later, by which point the second
  independent store has a multi-day hole in it.

**Recommendation (OPS-11):**
- A committed `.env.example` listing every required name (values never), and a
  **startup assertion that fails loudly and refuses to serve** if any is missing —
  fail fast, not silently degraded.
- Outbox depth and oldest-undelivered age surface on the health endpoint (OPS-3), so
  a broken webhook pages within minutes.
- Secrets rotation and the Supabase 30/hr auth-email raise (AD-14) belong on a
  **written pre-flight checklist** completed before setup day. AD-14 already
  identified one instance of "config that must exist before the day"; it is a class,
  not an instance.

---

## 5. AD-15 — is that a restore path, or just a record?

**It is a record. There is no restore path, and the two named stores cannot produce
one as specified.** AD-15 is simultaneously the most honest AD in the document and
the least operationally complete.

### 5a. Discord is not a restorable store

- **The credential is write-only.** AD-15 leans on FR-26's Discord channel as the
  second independent store. But an *incoming webhook* cannot read anything back. To
  rebuild from Discord you need the Discord REST API with a bot token and
  `Read Message History` — a completely different credential the system does not
  hold and the architecture never mentions. **The second independent store is not
  readable by the system that depends on it.** This alone proves the restore path has
  never been walked.
- **It is not append-only.** Anyone with Manage Messages — including the operator,
  who is presumably a server admin — can edit or delete history. AD-4 goes to great
  lengths to make the primary store immutable and then designates a mutable channel
  as the durability backstop.
- **Messages truncate.** 2000 characters per message, 4096 per embed description. A
  close post carrying "enough detail to rebuild the event" (AD-15's words) including
  full bid history will not fit for a contested auction.
- **Rate limits create gaps exactly when they hurt most.** Roughly 5 requests/second
  per webhook and ~30 messages/minute per channel (verify against current Discord
  limits). One sweep pass closing six auctions plus concurrent bids will hit this.
  AD-13's idempotency key makes *retry* safe, which is right — but delayed or dropped
  posts mean the durability record has holes during the busiest moments of the
  auction.

### 5b. The scheduled export is unspecified in every dimension that matters

AD-15 says "a scheduled export of the event log to storage outside Supabase must run
for the duration of the Auction Phase." Missing: **where**, **how often**, **what's
in it**, **is it verified**, **has anyone ever restored from it**.

Each of those is load-bearing:

- **What's in it is wrong as stated.** AD-4 explicitly excludes reference data:
  *"Imported reference data (teams, players, existing contracts, roster slots) stays
  in ordinary mutable tables; the world is not event-sourced, only the auction is."*
  And AD-5 says projections derive from *log **plus** imported reference data*.
  Therefore **an event-log-only export cannot rebuild anything.** The export must
  include the reference tables, or the restore produces an auction of ghosts. This is
  a direct internal contradiction between AD-15 and AD-4/AD-5.
- **Cadence sets RPO, and RPO here is measured in decided auctions.** With 24h clocks
  and $500k increments, an hour of lost events can contain several decisive bids and
  one or more closes. Hourly is arguably the floor; 15 minutes is defensible and
  costs nothing at this volume.
- **Destination.** "Outside Supabase" is not a destination. A concrete, free, durable,
  versioned option the operator already has credentials for: **commit the export to a
  private GitHub repository via the API**, or have a scheduled GitHub Actions workflow
  pull and commit it. Versioned history, off-vendor, and diffable — which incidentally
  gives you a tamper-evidence property for free.
- **Verification.** A backup nobody has restored is not a backup. The exporter should
  re-fold the exported log plus reference data and compare a hash against the live
  projection, alerting on mismatch. Otherwise you learn your exports were empty on the
  day you need them.
- **Rehearsal.** AD-3 already *mandates* a time-compressed full-auction rehearsal
  against a fake 30-team league. That is the natural place to also rehearse: export →
  restore into the dev project → rebuild projections → compare. If the restore has
  never been executed once, it does not exist.

### 5c. RTO is flatly incompatible with the 15-minute NFR

Even with a perfect export, "restore" means: create a new Supabase project (the free
tier's two-project cap is **already exhausted** — AD-16 says so explicitly, so this
means deleting dev or paying), apply all migrations, import the export, rebuild
projections, re-add every secret, redeploy both edge functions, re-register the cron
schedule, repoint Netlify, redeploy. That is an hours-long operation for a rested
expert. For someone woken at 3am it is a night.

**The spine never connects "no backups, no PITR, no SLA" (AD-15) to "no single outage
over 15 minutes" (§5). They cannot both be true.** Say it out loud. The honest
resolution is the same as §1: accept a long RTO, and make the *auction* survive it by
pausing automatically. Correctness survives a four-hour restore. Availability does
not, and pretending otherwise is how the operator ends up improvising at 3am against
a target he was never going to hit.

### 5d. Restore is itself a rules event

After a restore that loses N minutes of events, clocks are wrong, some managers'
accepted bids have vanished, and the league must be told. That is exactly the §5
"compensating clock adjustment" procedure the spine defers to "blocking on auction
open." Given that the restore path makes partial data loss *likely* rather than
hypothetical, this procedure is more urgent than its deferral implies — and it needs
a specific clause the current framing lacks: **how a manager whose accepted bid was
lost in a restore is made whole**, given FR-15 (no retraction) and AD-4 (no deletion).
Replaying a lost bid means appending it with a *past* `occurredAt`, which the append-
only log permits but which the projection fold must handle without breaking clock
arithmetic. That is a design question, not a runbook question.

---

## 6. Can FR-34 pause be triggered when the web host is down?

**Trace it. No.** And this is a clean single point of failure on the PRD's own
designated universal mitigation.

The trace, from the spine's own Capability → Architecture Map:

1. §4.10 Commissioner controls (FR-32–FR-34) → `routes/admin`.
2. `routes/` is SvelteKit → deployed to **Netlify**.
3. Pause is an event (AD-11) appended through the transactional shell (`shell/`),
   which runs in the Netlify Node function.
4. Reaching `routes/admin` requires a session, which requires **Supabase Auth**
   (magic link, FR-4).

Therefore:

- **Netlify down → pause is unreachable.** And per AD-10, the sweep — on Supabase, in
  a different failure domain — **keeps closing auctions**. The escape hatch is in the
  one failure domain the sweep does not share. The mitigation is void in precisely
  the scenario §1c identified as the most damaging.
- **Supabase Auth degraded but Postgres healthy → same shape.** The commissioner
  cannot obtain a session (his 30-day session may also have lapsed, FR-4), so he
  cannot pause, while the service-role sweep needs no auth and closes on schedule.
  This one is nastier because it presents as "I can't log in," which reads as a
  personal problem rather than an incident.
- **Supabase Postgres down → pause is also impossible** (it is an event in Postgres),
  but so is the sweep, so the auction is inert rather than progressing wrongly. Safe
  by accident, not by design.

PRD §9 names pause as the mitigation for **both** "solo-builder bus factor" **and**
every >15-minute outage. It is load-bearing twice over and it is unreachable in its
primary scenario.

### Recommendation (OPS-4) — two paths, one automatic

**1. A second, independent manual trigger.** A Supabase Edge Function `admin-pause`
authenticated by a static shared secret (a long random bearer token in the URL),
which appends the same `AuctionPaused` event through the same core. Different host
(Supabase, not Netlify), different auth (a bookmarked URL, not magic-link email),
same invariant (AD-11 remaining-duration semantics). The operator bookmarks it on his
phone home screen. Roughly 30 lines. This closes the hole completely for the Netlify
and Auth cases.

*Security note:* this is a static-secret admin endpoint. It must be rate-limited, its
use must append an audit event and post to Discord (OPS-8), and the token must be
distinct from every other secret so it can be rotated alone.

**2. The automatic one, which is worth more.** For a solo operator who sleeps, a
dead-man's switch beats any alert, because it works when he does not wake up.
Per AD-19/OPS-3: the sweep refuses to close and auto-pauses when its preconditions
are unmet — bidding surface unobserved for >5 minutes, outbox stalled beyond
threshold, or projection hash divergence.

**The graduated response matters.** Auto-pausing on an outbox stall means a Discord or
SMTP outage halts the auction, which sounds aggressive — but SM-3 is a *primary*
metric at a 100% target ("every outbid manager received a notification before the
auction closed against them"), and AD-15 makes Discord load-bearing durability. A
close that nobody was warned about is exactly the failure the product exists to
prevent. So: **stall >5 min → alert; stall >20 min → auto-pause.** Make it a stated
decision rather than an accident.

**And critically:** an auto-pause must itself be an event (AD-11), must be announced
to Discord and email, and must render on the board with a plain-language reason.
Otherwise you have traded a silent wrong outcome for a silently frozen board at 3am,
which is a different bad night.

---

## 7. Rate limits and quotas as an outage source

This is where the largest *concrete, quantified* defect in the spine sits.

### 7a. OPS-2 — the AD-10 invocation arithmetic is wrong

The spine's note under AD-10, presented as decisive ("Forced by arithmetic"):

> *"a 10-second sweep over three weeks is ~181,000 invocations against Netlify's
> 125,000/month free budget, versus Supabase Edge's 500,000/month."*

The **conclusion** (put it on Supabase, not Netlify) is right. The **arithmetic** is
incomplete in two ways that matter:

1. **It counts one cron function. There are two.** AD-13 mandates a separate outbox
   dispatcher, and the Structural Seed lists `functions/dispatch/` as cron-invoked
   alongside `functions/sweep/`. If the dispatcher also runs on ~10s (and it will,
   because FR-27 requires outbid emails within 60 seconds and nobody tunes this
   under pressure), the real figure is **362,880 over 21 days**.
2. **It compares a 3-week total against a monthly budget.** The correct comparison is
   run-rate: 8,640/day × 2 functions × 30 days = **~518,400/month against a 500,000
   cap.** The auction only fits *because it is shorter than a month*.

Then the headroom evaporates further:

- Supabase free-tier usage limits are assessed **per organization**, and the free plan
  allows two projects per org — which is exactly the dev/prod pair AD-16 mandates.
  **Dev and prod share the 500K.** (Verify against current Supabase terms; the
  consequence is severe either way and the spine assumes per-project without saying so.)
- **AD-3 mandates a time-compressed full-auction rehearsal.** Time-compressed means the
  sweep runs at accelerated cadence — a rehearsal that compresses three weeks into a
  few hours can burn tens of thousands of invocations in an afternoon, from the same
  pool.
- Ordinary dev iteration burns the rest.

**What happens at the cap:** Supabase restricts the service on the free plan. Edge
Functions stop being invocable. **The sweep dies. Silently. At whatever hour it
happens.** Combined with OPS-1 and OPS-3, this is plausibly the single most likely
catastrophic failure in the entire design, and it is hiding inside a note the spine
presents as settled arithmetic.

**Recommendation — merge the two cron functions into one entry point, two phases.**
One invocation per tick: phase 1 runs the sweep transactions; phase 2 drains the
outbox *outside* those transactions (fully compatible with AD-13, which forbids
delivery *inside* the auction transaction, not inside the same *process*). This:

- Halves the invocation budget to ~181K/3 weeks (~36% of cap), restoring real headroom.
- Removes an entire independent failure mode — you can no longer have a live sweep and
  a dead dispatcher.
- Guarantees dispatch runs whenever the sweep runs, which is exactly when notifications
  matter most (a close just happened).
- Halves the number of things needing heartbeats.

Failing that, at minimum run the dispatcher at 20–30s (still inside FR-27's 60-second
outbid SLA) and **state the budget arithmetic including both functions, the
rehearsal, and the shared-org assumption, in the spine**.

### 7b. The full quota surface

Every one of these fails **silently and asymmetrically**: the vendor restricts, the app
has no code path that notices, and the operator learns from a manager on Discord.

| Limit | Free tier (verify current) | Estimate | Failure mode |
|---|---|---|---|
| Supabase Edge invocations | 500K/mo, per org | ~363K–518K, see 7a | **Sweep dies silently.** CRITICAL |
| Supabase Realtime concurrent peak | 200 | 31 users × tabs/devices — comfortable | Board stops updating live |
| Supabase Realtime messages | 2M/mo | ~5K events × 31 subscribers + per-row churn — probably fine, unmeasured | As above |
| Supabase egress | 5GB/mo | **Unmeasured and never mentioned.** Every SSR board render pulls projections server-side; 31 users refreshing over 3 weeks | Project restricted → total outage |
| Supabase DB size | 500MB | a few thousand events — trivial | — |
| Supabase project pause | 7 days inactivity | not during the auction; **but between build-complete and auction-open, and for dev during a quiet stretch** | Dev project paused on setup day |
| Netlify function invocations | 125K/mo | ~30–40K; ~3–4x headroom | Site errors → web tier down while sweep closes |
| Netlify bandwidth | 100GB/mo | trivial | — |
| Netlify build minutes | 300/mo | ~2–3 min/build → ~100 builds; a debug-heavy fortnight approaches it | **Cannot deploy a hotfix.** Notably bad at 3am |
| Discord webhook | ~5/s per webhook, ~30/min per channel | burst on multi-close passes | 429s; AD-13 handles retry safety but not rate *budgeting* |
| Supabase Auth emails | 30/hr default post-SMTP | 31 magic links at once on setup day | **Caught by AD-14** — good |
| SMTP provider | ≥500/day per AD-14 | ~1,500–2,500 total | **Caught by AD-14** — good |

AD-14 is the proof this reasoning is within the spine's reach — it does exactly this
analysis for one dependency and reaches a hard, binding requirement. The same treatment
is owed to the other eleven rows.

### 7c. Graceful degradation is absent

Nothing in the spine describes what the product *does* when a limit trips. One case is
worse than merely broken:

**A stale board with a running countdown is actively dangerous.** Per AD-3, the client
renders countdowns from absolute close timestamps — which means that when the Realtime
subscription drops, the countdown **keeps ticking convincingly and correctly** while the
price, the leading bidder and the auction state are frozen at whatever they were when
the socket died. A manager watches a healthy-looking clock tick to zero on a $12M
auction he believes he leads, and he does not. FR-23 requires 5-second freshness and
says nothing about what happens when it cannot be met.

**Recommendation:** subscription health is a first-class UI state. The board shows a
"last synced" indicator, marks itself visibly stale when the subscription drops, falls
back to polling the projections, and — this is the important part — **disables or warns
on bid controls when the state backing them is known-stale**, because a bid composed
against stale state will be refused server-side anyway (AD-9, FR-13) and the manager
will experience that as the app being broken at the worst possible moment.

---

## 8. The operator is a competing manager — operational asymmetries

The spine governs this in exactly two places: AD-12 (randomizer commit-reveal, with the
excellent note *"The builder of this app is also the commissioner and a competing
manager. Commit-reveal is what makes that acceptable."*) and the Authorisation
convention (*"The commissioner's own team is subject to every ordinary rule with no
exception"*).

Both govern **domain** capability. Neither governs **operational** capability, which is
where the remaining asymmetries live.

Credit where due first: the *domain* data surface is genuinely symmetric by design.
FR-24 makes full bid history visible to all managers with no anonymity; FR-25 makes
every team's cap position, committed bids and nomination status visible to all. So the
operator's database access confers almost no informational advantage — almost.

### 8a. OPS-9 — the pre-reveal lottery seed (HIGH)

AD-12 generates a seed when a Minimum-Bid Contention opens, persists it, and publishes
only `hash(seed)`. The seed sits in a Postgres row. The operator holds the service role
and the Supabase dashboard.

**Commit-reveal proves he did not *change* the seed. It does not prove he did not *see*
it.** And seeing it early is worth something concrete:

Per FR-19, any bid of ≥$1.5M **dissolves** the lottery, discards the contender list, and
converts to Standard Contention. So an operator contending in a lottery who can compute
the draw in advance knows whether he is going to lose — and if he is, he can bid $1.5M
to dissolve it and take the player under ascending rules instead. That is a real,
exercisable, one-sided advantage over exactly the mechanism the spine identifies as
"the one objection a losing manager can actually make."

It is not fully closed by the ordering, either: even if the seed is committed before any
contender exists, he can compute "I win if the final list is [E,F,me]" and steer his
own behaviour accordingly as the list fills.

**Recommendation, in order of preference:**
1. **Bind the draw to a public value nobody controls, revealed only after expiry.**
   Derive the selection from `hash(seed || ordered contender list at expiry || beacon)`
   where `beacon` is an external public randomness value published after the close time
   — a drand round, or something as simple and league-legible as the ID of the first
   Discord message posted in the channel after expiry. Cheap, and it makes the advantage
   mathematically unavailable rather than merely discouraged.
2. Failing that, **state the limitation explicitly in the spine and to the league.** An
   acknowledged, documented residual asymmetry is survivable; an undocumented one
   discovered later is not. Do not let AD-12 imply a property it does not have.

### 8b. OPS-8 — overrides and pauses are not broadcast (HIGH)

FR-26 enumerates what reaches Discord: *"Nominations, Bids, Auction Closes, Randomizer
draws, Auction Phase start, and Auction Phase end."* **Commissioner overrides are not on
that list.** FR-34 requires pause/resume be "announced to all Managers and posted to
Discord" — good — but FR-32 overrides get only an audit-log entry.

So an override is discoverable **only if someone goes and reads the audit log**. SM-6
treats the audit log being read *even once by anyone other than the commissioner* as an
aspirational secondary metric. The system is therefore *auditable* but not *audited*, and
the single highest-trust-risk action in the product is the one on the pull path rather
than the push path.

**Recommendation:** every FR-32 override, every pause and resume, and every manual
production intervention posts to Discord with actor, before-state, after-state and the
mandatory reason — through the same AD-13 outbox as everything else. This is one line in
the outbox enqueue and it is the difference between "we kept a record" and "the league
saw it happen."

### 8c. FR-34 pause has no required reason (HIGH, and it compounds 8b)

FR-32 requires a free-text reason before *any* override commits — including "extend or
expire any Clock." FR-34 pause, which stops **every** clock in the league, requires no
reason at all. That is an inconsistency with a competitive edge attached: a commissioner
about to lose a player at 03:00 can pause at 02:55 citing an outage, and nothing
independently corroborates that an outage occurred.

**Recommendation:** pause requires a stated reason like any other override — *and* make
the public status page from OPS-3 visible to the league. A pause with no corresponding
red on an independently-hosted status page is visible to anyone who cares to look. This
is the most elegant control available here: it costs nothing, it is external to the
operator, and it makes his claims falsifiable by the people inclined to doubt them.

### 8d. Timing edge on the sweep tick (MEDIUM — closed by OPS-1)

The operator deploys the sweep and therefore knows its tick phase to the second. On a
10-second cadence there is always a window after nominal expiry in which a bid still
lands. In a league whose defining emotional event is losing by $500k at 4am, this is
exactly the kind of thing that becomes an accusation, whether or not it is ever used.

**It is closed for free by OPS-1's AD-20** — if the core refuses any bid at
`closeTime <= now`, the tick phase becomes irrelevant to every participant including the
operator. Nice convergence: one invariant fixes the sweep-outage fairness hole, the
universal 0–10s race, and this asymmetry.

### 8e. 3am production debugging (MEDIUM)

At 3am with a broken auction, the operator will be reading and quite possibly writing
production data by hand. AD-4's insert-only grant protects `auction_events` — but he can
`ALTER` that grant away from the dashboard in fifteen seconds. AD-16's "nothing is typed
into the Supabase dashboard" is the control, and it is the control most likely to be
broken, under pressure, by the person who wrote it.

**Recommendation:** make manual production intervention a *declared* act — any hands-on
prod session is posted to Discord within the hour with what was done and why. It is weak
enforcement, but it is non-zero, and combined with 8b it means the league's picture of
what happened is complete rather than selective.

---

## 9. Rollback when a bad deploy corrupts projections

**This is the best-answered question in the spine, largely by construction** — and it is
worth saying clearly, because it is a real strength.

AD-5 makes projections **derived, transactional and disposable**, rebuildable from the
log at any time, "byte-identical," in milliseconds at this volume, and explicitly names
rebuild as *"the primary repair tool for a solo operator."* AD-4 makes the log immutable.
Together they mean **projection corruption is recoverable by construction**, which is
more than most systems of this size can say and is exactly the right property for a
sleeping operator.

Four gaps stand between that property and an actual 3am rollback.

### 9a. There is no rebuild *command* (MEDIUM)

AD-5 says a rebuild "must be possible at any time." *Possible* is not *available, in one
action, to a frightened person at 3am*. If the rebuild has to be written during the
incident, it does not exist.

**Recommendation:** ship `rebuild-projections` as a first-class, tested artifact — an
Edge Function or npm script that takes the AD-6 global lock, truncates the projections,
refolds the log plus reference data, and reports a diff against what it replaced. It gets
its own test and it is exercised during the AD-3 rehearsal. Bonus: this is also the
migration procedure from §3c, so it earns its keep twice.

### 9b. Corrupt *projections* and corrupt *events* are different problems, and the spine
never distinguishes them (HIGH)

- **Bad projection** → rebuild. Cheap, safe, seconds. Fully solved by AD-5.
- **Bad events** → **there is no rollback, by design.** If a regression in
  `core/rules/bidding` accepts a bid that should have been refused, the log now
  permanently contains a wrong event, and AD-4 forbids deleting it. The only remedy is
  compensating events (FR-32 voids) applied by hand, one per bad event, each with a
  mandatory reason, each notified, each cascading — because every accepted bid also reset
  a clock (FR-16), released the prior leader's Committed Bids (FR-11), recomputed every
  other team's Minors Exposure (FR-35), and may have triggered a close.

A bad core deploy at 11pm running for six hours does not produce a rollback; it produces
an archaeology project, executed by an exhausted participant-operator, in public, against
a metric (SM-2) that budgets **fewer than five overrides for the entire auction**.

**This is the strongest possible argument for OPS-5's deploy gate.** State it plainly in
the spine: *the event log has no rollback. The only defence against event corruption is
not deploying rules changes during a live auction.* That sentence turns AD-22 from
process hygiene into the load-bearing control it actually is.

### 9c. Nothing *detects* a corrupt projection (MEDIUM)

AD-5 promises a rebuild is byte-identical. That is a **continuously testable property**
that is currently only ever exercised as a repair.

**Recommendation:** in the same cron pass (§7a), every N minutes, shadow-refold into a
temp table and hash-compare against the live projection. AD-5's own claim is that this
takes milliseconds at a few thousand events. On divergence: alert (OPS-3) and auto-pause
(OPS-4). This converts AD-5 from a repair tool into a **detector**, nearly free, and it
is the only thing in this entire review that would catch a subtle projection bug *before*
a manager loses a player to it.

### 9d. Rollback mechanics are wildly asymmetric across the three tiers (OPS-15, MEDIUM)

| Tier | Rollback | Time at 3am |
|---|---|---|
| Netlify | one-click atomic rollback to a previous deploy | ~10 seconds |
| Supabase Edge Functions | **no rollback UI** — redeploy previous source via CLI | find laptop, find git ref, working auth, remember incantation |
| Migrations | **none unless down-migrations were written** — AD-16 does not require them | not possible |

And AD-2 pins the first two together: rolling back one *requires* rolling back the other,
or you are back in the split-brain of §3a.

**Recommendations:**
- Every migration ships with a tested down-migration, or an explicit "irreversible,
  expand-only" annotation forcing the author to notice.
- A committed one-command `rollback.sh` that redeploys the previous edge-function bundle
  *and* pins Netlify to the matching deploy, keyed by `coreVersion`.
- Prefer expand-only migrations during the Auction Phase precisely because they need no
  rollback.

---

## 10. Additional finding: sweep concurrency mechanics (OPS-10, MEDIUM)

Two details in AD-6/AD-10 that are correct for bids and wrong for the sweep.

**Convoy.** AD-6 says every mutating transaction "acquires the same single
`pg_advisory_xact_lock`" — a *blocking* acquire. For a manager's bid that is right; he
waits 50ms and never notices. For a sweep firing every 10 seconds it is dangerous: if one
pass takes longer than the tick (a slow close, a lock held by a burst of bids, a migration
in flight), the next invocation fires anyway and **queues on the lock**. Invocations pile
up, each burning Edge Function wall-clock time (and invocation quota, per OPS-2) waiting
for a lock, and the convoy can outlive the condition that caused it.

**Fix:** the sweep uses `pg_try_advisory_xact_lock` and **exits immediately** if it cannot
acquire — never queue. It is restart-safe by construction (AD-10), so the next tick, 10
seconds later, re-derives exactly the same overdue set. This is a one-word change with
real consequences and it is not stated anywhere.

**Poison pill.** AD-10 says the sweep "reconcil[es] every overdue auction it finds on each
pass" without specifying transaction granularity. If a pass is one transaction over all
overdue auctions, then **one auction that trips a core bug fails the entire pass — and
every subsequent pass, forever**, because the same poison auction is still overdue. That
is a total, permanent, silent close outage caused by a single bad row, and it will be
discovered by a manager in the morning.

**Fix:** one transaction per auction, each taking and releasing the lock, with per-auction
error isolation. A failing auction is skipped, counted, and surfaced on the health
endpoint (OPS-3); the other twenty-nine still close. Record the failure count in the
heartbeat so a poison pill pages the operator rather than hiding.

---

## What must be fixed before the auction opens

Ordered by expected damage over three weeks.

**Blocking — architectural invariants, add now:**

1. **OPS-1 / AD-20 — expiry is a property of the clock, not of the sweep.** Bids at
   `closeTime <= now` are refused by the pure core. Close events carry nominal expiry as
   `occurredAt`. Fixes the sweep-outage fairness hole, the universal 0–10s race, the
   operator's timing edge, and replay honesty. One comparison in the core.
2. **OPS-2 — restate the AD-10 invocation arithmetic including the dispatcher, the
   rehearsal, and the shared-org quota; merge sweep and dispatch into one cron entry
   point.** The current note understates the run-rate by roughly 2x and the design as
   written may not fit the free tier at all.
3. **OPS-3 / AD-21 — no component reports its own death.** Sweep + outbox heartbeats, a
   public health endpoint, two crossed external monitors, and an alert channel sharing no
   component with the auction's own notification path. This cannot be deferred to "before
   the rehearsal" because it is schema plus a third-party dependency plus a stated
   constraint, not a config tweak.

**Blocking — should be ADs before build starts:**

4. **OPS-4 / AD-19 — pause must be reachable and automatic.** A Supabase-hosted,
   shared-secret pause endpoint outside the Netlify/Auth failure domain, plus an automatic
   fail-safe pause when the sweep's preconditions are unmet.
5. **OPS-5 / AD-22 — governed deploys.** `coreVersion` stamped on every event; a live
   `core/` change is treated as an override (pause, announce, log); migrations follow
   pause → migrate → rebuild → verify → resume with `lock_timeout` set.
6. **OPS-7 — renegotiate the §5 availability NFR** from an uptime percentage the stack
   cannot guarantee into a correctness-under-unavailability promise it can, and bind it to
   an AD with a row in the capability map.

**Before setup day:**

7. **OPS-6 — make AD-15 a real restore path**: include reference data (currently
   contradicted by AD-4), name the destination and cadence, add export verification, and
   rehearse a full restore during the AD-3 rehearsal. Acknowledge that Discord is not
   machine-readable with the credential held.
8. **OPS-8 / OPS-9 — govern the participant-operator operationally**: broadcast overrides
   and pauses to Discord, require a reason for pause, publish the status page to the
   league, and either bind the lottery draw to an external post-expiry beacon or state
   the residual asymmetry openly.
9. **OPS-11 — a secrets inventory, a fail-fast startup assertion on missing env vars, an
   automated test proving the service role cannot `UPDATE auction_events`, and a
   pre-flight checklist** (AD-14 already found one member of this class; formalise it).
10. **OPS-10 / OPS-12 — `pg_try_advisory_xact_lock` in the sweep, per-auction transaction
    isolation, a shipped `rebuild-projections` command, and continuous projection hash
    verification in the cron pass.**

---

## Closing note

The correctness architecture here is genuinely strong, and several decisions — AD-4's
insert-only log, AD-5's disposable projections, AD-6's global lock superseding the PRD's
weaker per-auction serialization, AD-12's commit-reveal, AD-15's refusal to trust the
platform — are better than this project needed them to be.

The operational architecture is, by contrast, mostly absent, and it is absent in a very
specific pattern: **every deferred or unstated concern resolves to "a human will notice."**
The sweep dying, the outbox stalling, a quota tripping, a webhook env var going missing, a
projection drifting, a deploy splitting the core across two runtimes — the implied detector
in every case is the operator's attention, and the operator is asleep for a third of the
auction and playing in it for the rest.

The single highest-leverage change is not any one of the fourteen findings. It is a posture
change that OPS-1, OPS-4 and OPS-12 all express: **make the system fail safe rather than
fail silent.** An auction that pauses itself and pages someone is a bad night. An auction
that keeps confidently closing on stale, wrong, or unwatched state is the end of a
six-year league.
