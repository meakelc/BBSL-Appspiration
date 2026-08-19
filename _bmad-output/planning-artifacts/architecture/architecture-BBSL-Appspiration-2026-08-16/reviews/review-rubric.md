---
review: rubric-walker
target: ARCHITECTURE-SPINE.md
artifact-type: architecture-spine
reviewer-stance: fixed checklist, judged as a spine (terse invariants), not as a solution design
date: 2026-08-16
verdict: PASS WITH FINDINGS
---

# Rubric Review — Architecture Spine, BBSL Offseason Free Agent Auction

**Verdict: PASS WITH FINDINGS.**

This is a strong spine. It is doing the actual job of the altitude — AD-6 supersedes a PRD NFR with a named counter-example, AD-10 is forced by invocation arithmetic rather than preference, AD-15 turns a platform weakness into a design obligation, and AD-7 pre-empts the addendum's hardest concurrency warning. Bloat is low and the Structural Seed / Invariants boundary is genuinely respected.

The findings are almost all **omissions with cheap fixes**, not wrong decisions. Three dimensions the altitude owns are silent or under-covered (secrets, read-side authorization, scheduled work other than auction close), one Deferred item is load-bearing for a stated invariant, and one class of data — instrumentation fields on events — becomes permanently unrecoverable if it is not decided before the first event is written, because AD-4 forbids backfill.

No finding rises to CRITICAL: nothing already decided is wrong.

---

## 1. Does it fix the real divergence points for the level below, and miss none?

**Verdict: MOSTLY — five genuine misses.**

What it correctly fixes, and would otherwise diverge: purity boundary, single-sourced core across two runtimes, time injection, event-log-as-truth, projection derivation, the locking discipline, non-storage of derived money, integer money, the absence of a client write path, where the sweep runs, pause semantics, seed protocol, outbox + idempotency, email capacity floor, dual-store durability, migration discipline, Fantrax containment, and the §10 examples as tests. Plus the Conventions table, which fixes the vocabulary, event/command naming, money/time/ID shapes, DB access direction, authz posture, audit contents, a11y floor and config location. That is a genuinely thorough sweep of the feature-level surface.

### Miss 1 — Scheduled work other than auction close has no home [HIGH]

AD-10 fixes *one* timer: "the close sweep… reconciling every overdue auction it finds." The source tree agrees — `functions/sweep/  # cron-invoked: close overdue auctions`. But the PRD contains at least five other time-triggered behaviours, and none of them is an auction close:

| Behaviour | FR | Homed in the spine? |
|---|---|---|
| League Clock (48h) expiry → end Auction Phase | FR-22 | Implied by the §4.5 map row, never stated |
| Dead-nomination 24h flag + notification | FR-10 | **No** — §4.3 row maps only to `core/rules/nomination`, `shell/` |
| Contract-assignment deadline enforcement (default to 1-year) | FR-29 | **No** — §4.8 row maps only to `core/rules/allotment`, `routes/` |
| Commissioner-configured assignment reminder emails | FR-29 | **No** |
| Scheduled event-log export outside Supabase | AD-15 | **No** — AD-15 mandates it, nothing says what runs it |

This is exactly the shape of divergence a spine exists to prevent. Three independent stories can each pick a different mechanism — extend the sweep, add a second Edge Function, add a Netlify scheduled function, or evaluate lazily on page render — and all four are defensible in isolation. The lazy-on-render option is silently wrong (FR-10's notification and FR-29's deadline must fire with nobody looking), and it is the cheapest to reach for.

**Fix (one clause):** widen AD-10 from "the close sweep" to "all time-triggered state transitions" — auction close, League Clock expiry, dead-nomination warning, assignment deadline and reminders — all reconciled by re-derivation from persisted absolute timestamps, all on Supabase Cron, none on Netlify, none lazy on render. The AD's *reasoning* (re-derive rather than remember; off the web host) already generalises perfectly; only its scope sentence is narrow.

### Miss 2 — The secrets / env boundary is silent [HIGH]

See §6 (Secrets management). This is a dimension miss and a divergence point simultaneously.

### Miss 3 — Read-side authorization is unspecified [HIGH]

See §6 (Security/authz).

### Miss 4 — Instrumentation fields on events [HIGH]

See §5 (NFR coverage) — PRD §5 "Measurability."

### Miss 5 — The live-recomputation seam for derived money [MEDIUM-HIGH]

AD-7 forbids persisting Available Cap Space, Committed Bids, Minors Exposure, Roster Reserve and Maximum Bid. AD-5 says projections contain only what folds from the log. AD-9 gives the browser a read-only key "used solely for Realtime subscriptions to projection tables." FR-23 requires "the viewer's Maximum Bid is persistently visible on the board" and FR-12 requires it to recompute "within one second of any Bid, Auction Close, or Commissioner override."

Compose those and there is a hole: **the numbers that must update live are precisely the numbers that are not in the stream that updates live.** The spine never says how a Realtime projection event turns into a refreshed Maximum Bid. Three implementations are available and a story will pick one blind:

1. Realtime event → client invalidates → server round-trip recomputes (correct, and the only one consistent with AD-7);
2. client polls on an interval (works, violates the 1s figure, wastes the Realtime subscription);
3. client derives Maximum Bid from projection rows it already has (fast, and it re-creates exactly the client-trusted arithmetic AD-9 and FR-13 exist to forbid — the numbers would be *display-only*, so it would not breach the cap, but it would drift from the server figure and destroy the app's signature number).

Option 3 is the dangerous one and it is the one AD-7's current wording half-invites: "cached client-side for validation purposes" forbids *validation* use but is silent on *display* derivation, and the addendum calls Maximum Bid "the app's signature number." A displayed figure that disagrees with the refusal message is an SM-1 dispute.

**Fix:** one clause in AD-7 — derived money is computed server-side only, on every render and on every Realtime-triggered refresh; the client never computes it from projection data, for display or otherwise.

### Non-finding, recorded

Addendum §D.2 asks for nomination uniqueness "enforced at the data layer, not by a prior read." The spine drops that in favour of AD-6's global lock, which subsumes it correctly (read-then-write under a global lock cannot race). This is a good simplification, not a gap. A one-line note in AD-6 saying so would stop a reviewer re-raising it.

---

## 2. Is every AD's Rule enforceable, and does it prevent its stated divergence?

Walked individually. "Enforceable" = a reviewer can point at code and objectively say *this violates AD-n*.

| AD | Enforceable? | Prevents what it claims? | Note |
|---|---|---|---|
| AD-1 Pure core | **Yes** — greppable (`Date.now`, `Math.random`, `fetch`, import graph), lintable, and the signature is pinned | Yes | Pedantic: TypeScript has no "standard library"; intent is clear |
| AD-2 One core, two runtimes | **Yes** in outcome, **no** in mechanism | Yes — but see below | See finding below |
| AD-3 Injected time | **Yes** — no clock reads below the shell; wire carries absolute instants | Yes | Last sentence is a testing obligation, defensibly placed |
| AD-4 Append-only log | **Yes** — table grants are inspectable; `UPDATE`/`DELETE` greppable | Yes, strongly | Best AD in the set. The "world is not event-sourced, only the auction is" boundary is the sentence that stops the whole design metastasising |
| AD-5 Projections derived | **Mostly** | Yes | "byte-identical" overreaches — see below |
| AD-6 One global lock | **Yes** | Yes — and the supersede note is the single most valuable paragraph in the document | Lock *key* unpinned — see below |
| AD-7 Derived money never stored | **Yes** — schema inspection | Yes | Display-derivation loophole (Miss 5) |
| AD-8 Integer dollars | **Yes** | Yes | Clean |
| AD-9 No client write path | **Yes** for writes | Yes for writes | Silent on reads — see §6 |
| AD-10 Closes off the web host | **Yes** | Yes | Scope too narrow (Miss 1) |
| AD-11 Pause stores remaining | **Yes** — "absolute close times are never shifted in place" is directly checkable | Yes | Clean and precise |
| AD-12 Commit-reveal | **Partly** | **Partly** | Two gaps — see below |
| AD-13 Transactional outbox | **Yes** — same-tx insert, key derived from event identity, dispatcher separate | Yes | Strong. Second-best AD |
| AD-14 Burst capacity | **Yes** as a procurement gate (≥500/day, no hard cap) | Yes | Altitude dips; see §8 |
| AD-15 Two independent stores | **Partly** | **Partly** | Depends on a Deferred item — see §3 |
| AD-16 Migrations in repo | **Yes** — "nothing typed into the dashboard" is checkable by diff | Yes forward | Silent on rollback — see §6 |
| AD-17 Fantrax in one adapter | **Yes** — grep any column string outside the module; join-on-ID is inspectable | Yes | Clean, and the "core has no notion of a file" clause is the load-bearing half |
| AD-18 §10 examples executable | **Yes** — 21 named tests, deploy gate, PRD-in-same-commit rule | Yes | Excellent. The "no fixtures beyond a state literal" clause is what keeps it honest |

### AD-2 — the mechanism of single-sourcing is unfixed [MEDIUM-HIGH]

AD-2 is the highest-stakes invariant in the document ("an auction that closes under different rules than it bids under"), and it is the only one whose *violation is reached by friction rather than by choice*. Sharing `src/lib/core/**` between a Netlify Node build and a Supabase Edge Deno deploy is not free: Deno requires explicit `.ts` extensions in import specifiers where a SvelteKit/Vite build tolerates extensionless ones, and `supabase/functions/*` deploys bundle from their own root, so reaching up and out of that directory needs a deliberate import-map, symlink or pre-bundle step. A developer who hits that wall at 1am has one obvious escape: copy the core. AD-2 forbids the copy but does not remove the reason for it.

AD-1's stdlib-only rule is what makes this *possible*; it is not what makes it *ergonomic*.

**Fix:** pin the import convention (extensioned `.ts` specifiers throughout `core/`, consumed by both) and name the mechanism (import map / symlinked function root). One line. Optionally add the enforcement: a check that the deployed Edge bundle's core hash matches the repo's.

### AD-5 — "byte-identical" is not achievable as written [LOW]

Any projection row carrying a surrogate `id`, a `created_at`, or anything else not folded purely from the log will differ on rebuild, and a reviewer applying AD-5 literally will either weaken the rule ad hoc or add pointless determinism plumbing to serial IDs. The intended meaning is clearly *semantically identical modulo surrogate keys*. Say that, or forbid non-derived columns in projections outright (which AD-5's last sentence nearly does already).

### AD-6 — the lock key is not pinned [MEDIUM]

"Every mutating transaction acquires **the same** single `pg_advisory_xact_lock`." `pg_advisory_xact_lock` takes a caller-chosen integer key. If the bid path uses key `1` and the sweep uses key `2`, both transactions take *a* lock, both pass code review at a glance, and neither excludes the other. The failure is completely silent — no error, no contention, just the cross-auction cap breach AD-6 was written to eliminate, appearing only under concurrency, in production, in the one class the spine explicitly claims to have removed.

This is a two-word fix and it is the cheapest high-value change in this review: state that the key is a single named constant in `core/constants.ts` (or `shell/`), referenced everywhere, never inlined.

### AD-12 — two gaps [MEDIUM]

**(a) Nothing forbids the seed being readable before the draw.** AD-12 says the system "generates a seed, persists it, and publishes only `hash(seed)`." But AD-4 puts that seed in `auction_events`, AD-5 folds events into projections, and AD-9 hands the browser a read-only key over projection tables. If the seed lands in the auction projection — or if the events table itself is readable, which the audit log (FR-33, "any Manager can read the complete Audit Log") makes a live question — then commit-reveal is decorative: any manager can read the seed while the lottery is open and compute the winner in advance. The entire justification for AD-12 ("the builder is also a competing manager") collapses.

State it: **the seed is not readable by any client role until the draw event is appended.** This also forces a decision on where unrevealed seeds live, which is otherwise made by accident.

**(b) "A documented, deterministic procedure" names no document and pins no algorithm.** FR-20 requires a manager to reproduce the draw *by hand*. AD-2 means there is only one implementation, so this is not a unit-divergence risk — but the ordering basis of the contender list (bid timestamp? team ID?) and the seed→index derivation are unpinned, and a hand-reproducible procedure must be published somewhere specific. Route it the AD-18 way: make the derivation itself a named example test and name the file the procedure is published in.

### Binds / Prevents / Rule distinctness

**Genuinely distinct throughout.** This is unusual and worth saying — the common failure of this format is three restatements of the same sentence, and the spine avoids it. Binds consistently names scope (paths, FRs, NFRs), Prevents consistently names a *concrete failure* rather than the negation of the rule, and Rule states the constraint. AD-1 ("rules that cannot be tested… and therefore are not tested, and therefore are wrong") and AD-12 ("the one objection a losing manager can actually make") are the strongest examples — both Prevents lines carry information found nowhere else in the document.

Weakest: AD-5's Binds ("all current-state tables read by the UI") is a category rather than a scope, and AD-8's Prevents/Rule pair is nearly tautological — though at that AD's stakes, tautology is fine.

---

## 3. Could anything under Deferred let two units diverge right now?

**Verdict: ONE DOES.**

| Deferred item | Safe to defer now? |
|---|---|
| Email vendor | **Yes.** AD-14 fixes the binding constraint; vendor is genuinely a build-time pick. The SES 24h lead-time note correctly makes the trigger concrete |
| Archive reachability | **Yes, with a caveat.** Correctly timed. Caveat: it defers a case where v1 as designed cannot satisfy FR-31's "indefinitely" — honest, but it is an unmet FR sitting in a deferral bucket, and should be visible to whoever accepts FR-31 [LOW] |
| §5 outage recovery procedure | **Yes.** Operational document, mechanism (AD-11) already fixed, blocking gate stated |
| **Observability and alerting** | **NO** — see below [HIGH] |
| OQ-1 … OQ-6 | **Yes.** Correctly disowned; the impact analysis (OQ-2 → adapter only, OQ-1 → export validation) is right |
| Fantrax API / web push / multi-tenancy | **Yes.** Each names the seam that keeps it contained. Mildly redundant with PRD §7.2 |

### Observability is a Deferred item that a stated invariant depends on [HIGH]

AD-15 declares: "a sustained delivery failure is an incident, not a warning," and makes the Discord channel *load-bearing durability* — one of the two independent stores from which the auction must be reconstructible. AD-10's own note observes that "a stalled sweep is silent by nature — auctions simply stop closing."

So the spine asserts two conditions that must be detected, then defers the detection to "before the rehearsal," with no owner and no mechanism.

Two consequences, and only the second is a scheduling problem:

1. **AD-15's second store is unverified.** "Reconstructible from two stores at all times" is not a property you have; it is a property you *check*. With no detector, the failure mode is: Discord webhook silently 404s after a channel change on day 4, nobody notices, the DB is the only store for two weeks, and AD-15's entire premise is false without anyone knowing. This is the failure AD-15 exists to prevent, arriving through the door AD-15 left open.

2. **The detection *data* must be captured now, not at rehearsal.** Whether the dispatcher records per-attempt outcome (success / failure / attempt count / last error) on the outbox row is a **schema decision** — it belongs to AD-13, it must be made before the outbox is built, and it is currently inside the deferred bucket. Alerting policy can wait; the field cannot. Same point as §5's Measurability finding, from the other direction.

**Fix:** move the *recording* obligation out of Deferred and into AD-13 (delivery attempts and outcomes are persisted on the outbox entry). Leave the alerting channel and thresholds deferred — that part genuinely is operational.

---

## 4. Is named tech verified-current? (flag omissions only)

Stack table is dated and the pins are specific, with two active traps called out (SvelteKit 3 RC, `adapter-netlify` 7.0.0-next.0). Currency verification belongs to the other reviewer; **omissions** follow.

- **Node 26 "LTS" — verify.** Even-numbered Node majors ship in April and enter LTS in October. In August 2026, Node 26 would be *Current*, not yet LTS. Also worth confirming Netlify's supported function runtime actually offers it.
- **Svelte itself is unpinned.** Only SvelteKit is versioned. Svelte's own major (runes-era vs successor) is a real divergence axis for every component story.
- **`@supabase/supabase-js` unpinned.** It is the client library on both the Node and Deno sides of AD-2, and a major-version difference between the two runtimes is precisely the kind of skew AD-2 exists to stop.
- **Test runner unnamed.** AD-18 makes 21 tests a deploy gate without naming what runs them. At spine altitude that is arguably fine — except that the runner must import the same `core/` under the same module convention as both deploy targets, so it is coupled to the AD-2 mechanism finding above.
- **Deno version unpinned** (given as "Supabase Edge runtime"). Acceptable if the platform pins it; worth a note either way.
- **No CSV parser named** for AD-17. Genuinely seed-level — flagging only for completeness, not as a defect.

---

## 5. Does it cover the driving PRD's capabilities? (§4's ten groups, FR-1..FR-36)

**Verdict: COMPLETE at FR granularity. One NFR has no architectural home.**

Every one of FR-1 … FR-36 appears in the Capability → Architecture Map with a location and at least one governing AD. FR-35 and FR-36 are both correctly filed under their owning feature groups rather than appended, matching the PRD's own note about their numbering. I could not find an orphaned FR.

Detail notes:

- **FR-3 (open the auction)** sits in the §4.1 row governed by AD-17/AD-8/AD-16 — the import-side ADs. But opening the auction is a phase transition: a state mutation that must take the AD-6 lock and append an AD-4 event. AD-4's Binds does list "phase transitions," so the invariant is present; only the map row is inconsistent. Same for FR-31 (archive) in the §4.9 row. [LOW — add AD-4/AD-6 to those two rows]
- **FR-8's concurrent-nomination case** is covered by AD-6 rather than by a uniqueness constraint. Correct, but see §1's non-finding note.
- **FR-27's mute preferences** (three mutable categories per manager) are the one piece of user-owned mutable state in the app. AD-4's "the world is not event-sourced" boundary covers it implicitly. Fine at this altitude.
- **FR-13's refusal arithmetic** is unusually well served — AD-1 makes carrying the arithmetic a property of the core's return type rather than a UI courtesy. That is the right place for it.
- **FR-35 / examples 18–20** — the PRD's most dangerous rule is protected by three ADs at once (AD-7 no caching, AD-1 pure recomputation, AD-18 examples as tests). Good.

### The gap: PRD §5 "Measurability" has no architectural home [HIGH]

The NFR reads: *"Every Bid, Nomination, Auction Close, and notification dispatch must be recorded with enough context to compute the §8 metrics without retrofitting instrumentation — including, for Bids, the device class the bid was placed from (SM-4) and, for notifications, dispatch and delivery outcome (SM-3)."*

The spine's Events convention fixes exactly three fields: `occurredAt`, `actingManagerId`, `teamId`. No device class. AD-13 fixes the outbox's idempotency key and retry behaviour but not outcome recording. The Capability → Architecture Map has rows for "§5 Rule correctness" and "§5 Durability & recovery" but none for "§5 Measurability."

Why this is HIGH rather than LOW, despite SM-4 being only a *secondary* metric:

- **AD-4 makes it unbackfillable.** `auction_events` is insert-only with no `UPDATE` granted to any role including the service role. A field omitted from `BidPlaced` on day one cannot be added to the events already written. The metric is not "harder to compute later" — it is permanently uncomputable for every bid placed before the fix. This is the one category of omission that an event-sourced design converts from cheap to impossible, and the NFR says "without retrofitting instrumentation" in as many words.
- **SM-3 is a *primary* metric with a 100% target**, and it is AD-14's own stated Binds. It cannot be computed without per-notification dispatch and delivery outcome — which, per §3, currently lives inside a Deferred bucket.

**Fix:** two clauses. Add `deviceClass` (or a small client-context struct) to the Events convention's mandatory field list. Add delivery attempt/outcome persistence to AD-13. Both are schema decisions that must land before the first event and the first outbox row exist.

---

## 6. Is every dimension the altitude owns decided, deferred, or an open question?

| Dimension | Status | Assessment |
|---|---|---|
| Deployment & environments | **Decided** | AD-16 + deployment diagram + two-project/two-context split. Solid, and the "two projects exhaust the free tier's cap" note makes the discipline's cost explicit |
| Infra / provider strategy | **Decided** | Stack table + AD-10's invocation arithmetic + AD-14's capacity floor. Better than most spines — the provider split is *derived*, not asserted |
| Operations & observability | **Deferred — unsafely** | See §3. HIGH |
| Security / authz | **Partly decided** | Write path airtight (AD-9). **Read path silent.** See below. HIGH |
| Data model | **Decided (as seed)** | ERD + AD-4/5/7/8. Correctly terse |
| Testing | **Decided** | AD-18 + AD-3's replay rehearsal. The examples-as-deploy-gate is genuinely enforceable |
| Performance | **Decided by dismissal** | Legitimate: PRD says "scale is not a concern," and the spine argues the global lock's cost explicitly rather than hand-waving it. AD-5's "milliseconds at a few thousand events" is the same move. Adequate |
| Accessibility | **Decided, thin** | Conventions row covers colour-alone and 44×44px but **omits the WCAG 2.1 AA contrast ratios (4.5:1 / 3:1)** the NFR names. One clause. LOW |
| Error handling | **Decided** | Strong on the core side: `Rejected` as a value, arithmetic carried, "thrown exceptions signal bugs only." Shell/adapter side covered by AD-13 and AD-17's per-row import reporting |
| Migration / rollback | **Half-decided** | See below. MEDIUM |
| Secrets management | **SILENT** | See below. HIGH |

### Secrets management is entirely absent [HIGH]

Nothing in the spine mentions where the Supabase service-role key, the Discord webhook URL, or the SMTP credentials live, or who may read them. This matters more here than it would in most projects, because **AD-9's entire security model reduces to a single claim: the service role key never reaches the browser.** That claim is asserted and never protected.

SvelteKit has a specific, well-known trap on exactly this line: `$env/static/public` and `$env/dynamic/public` (and any `PUBLIC_`-prefixed variable) are inlined into the client bundle. One story author reaching for `PUBLIC_SUPABASE_SERVICE_KEY` because the private import threw a build error in a component gets a working app and a total compromise: with the service role key in the browser bundle, every AD-9 grant restriction is bypassed, every AD-4 append-only guarantee is bypassed (the service role can insert forged events), and the audit log becomes writable by any manager who opens devtools. In a money auction run by a builder who is also a competing manager, that is the worst available failure.

This is a spine-shaped invariant — one sentence, prevents a catastrophic divergence, cannot be recovered from later:

> Service-role credentials, the Discord webhook URL and SMTP credentials exist only in server-side environment (`$env/static/private` / Edge Function secrets) and in the deploy platforms' secret stores. No secret is ever imported through a `PUBLIC_`-prefixed variable or reaches a client bundle. The browser holds exactly one key: the anon read key.

### Read-side authorization is unspecified [HIGH]

AD-9 is precise about writes and silent about reads: *"The browser's key is read-only and used solely for Realtime subscriptions to projection tables."* On Supabase, an anon key is read-only **only if RLS is enabled with policies**; with RLS off, "read-only" means *read everything, from anywhere, unauthenticated*. The spine never says RLS is on, never says which tables are client-readable, and never distinguishes authenticated-manager reads from anonymous ones.

Three concrete consequences:

1. **PRD §6 forbids public access outright** — "No public/spectator access. Authentication required for everything." An anon Realtime key over unprotected projection tables is exactly a public read surface for the live bid board. The non-goal is violated by default, not by choice.
2. **The unrevealed lottery seed** (see §2, AD-12(a)) is readable through whatever this key can reach. Commit-reveal fails silently.
3. **Manager email addresses and mute preferences** are the app's only genuinely private data, and nothing scopes them away from the read key.

Most of the app *is* league-visible to all managers, which makes this easy to fix and easy to overlook: the rule is not "restrictive policies everywhere" but "authenticated-manager-only, with a named exception list for what is never client-readable (seeds pre-draw, contact details, secrets)." One clause in AD-9.

### Migration rollback is unaddressed, and AD-15 makes that sharper [MEDIUM]

AD-16 fixes migrations forward — repo-committed, dev-first, nothing by hand. It says nothing about reversibility. AD-15 says the production database has *no automatic backups and no point-in-time recovery*. Together: a migration that corrupts or drops a projection during a live three-week auction has no restore path, and the only stated repair tool is AD-5's rebuild-from-log — which works beautifully for *projections* and not at all for `auction_events` itself.

AD-5 is doing more load-bearing work here than it is credited with. Make the coupling explicit: migrations may drop or rewrite projection tables freely (AD-5 rebuilds them); no migration may alter, drop or destructively rewrite `auction_events`; and the AD-15 external export is the only rollback that exists for the log. That also gives the AD-15 scheduled export a stated purpose beyond disaster recovery.

---

## 7. Are the diagrams valid mermaid, and do they carry shape prose would carry worse?

**Verdict: all four valid; three earn their place, one is marginal.**

**Validity:** All four parse. Diagram 1 (`graph TD` with two `subgraph id["label"]` blocks, a `[( )]` cylinder, quoted labels containing `·` and `/`) is valid. Diagram 2 (`graph LR`, quoted `-->|"label"|` edges, `<br/>` in node text, an undirected `---` link) is valid. Diagram 3 (`erDiagram`, cardinality tokens `||--|{`, `||--o{`, `||--o|`, quoted relationship labels, no attribute blocks) is valid. Diagram 4 (`sequenceDiagram` with `alt`/`else`/`end`, `->>` and `-->>`) is valid. No unquoted-special-character hazards.

**Earning their place:**

- **Design Paradigm (TD).** Yes. Dependency *direction* and the I/O boundary are structural facts that prose states weakly and a picture states once. It is also the diagram AD-1 and AD-2 are checked against.
- **Bid acceptance (sequence).** **Strongest of the four.** It fixes an *ordering* — `BEGIN` → lock → read → decide → append+fold+enqueue → `COMMIT` — where every step's position is load-bearing (lock before read is AD-6's whole point; enqueue inside the transaction is AD-13's) and prose renders orderings badly. The closing sentence, that the sweep follows the identical path with a different command, is worth more than the diagram: it makes AD-2 visual.
- **Deployment (LR).** Yes, mostly because of the sentence beneath it — "the auction's most damaging failure depends only on the Supabase column of this diagram" — which is an observation the reader can only verify *against a picture*.
- **Core entities (ER).** **Marginal.** Eleven relationship lines, no attributes, and most cardinalities restate PRD §3's glossary. Its genuinely new content is the caption, not the diagram: which table is insert-only, which entities are projections, and that `CONTRACT` spans both Existing and Auction contracts. It also omits entities the glossary treats as first-class (Roster Slot, Nomination, Nomination Slot) while including derived ones, which will prompt "where is Nomination?" from every reader. Either add the missing entities, or cut to the caption. [LOW]

---

## 8. Is anything present that is not an invariant and should be cut?

**Verdict: bloat is LOW. This is a disciplined artifact.** The Structural Seed section is correctly labelled and quarantined — the source tree is presented as seed, not as law, and the ADs do not smuggle file layout into their Rules (AD-17 is about *knowledge* containment, not directory naming). That is the discipline most spines fail.

Trim candidates, all minor:

- **AD-14's operational to-do** — "Supabase's post-SMTP default auth-email limit of 30/hour must be raised before setup day, when 31 magic links go out at once." True, valuable, and *not an invariant* — it is a setup-day runbook line. It also has no owner here. Move it to the outage/setup operational document that Deferred already anticipates. [LOW]
- **AD-14 generally** is the most implementation-flavoured AD in the set (specific vendor tier limits, "2/hour," "30/hour"). It survives because the *number* — ≥500/day with no silent cap — is a genuine constraint a story would otherwise get wrong, and because the vendor sits in Deferred. Keep the number, shed the vendor trivia. [LOW]
- **Deferred's last three bullets** (Fantrax API, web push, multi-tenancy) largely restate PRD §7.2. Each does add the seam that contains it (AD-17, AD-13's outbox, `constants.ts`), which is the spine-relevant half — so compress to that half rather than cutting. [LOW]
- **The ER diagram** — see §7. [LOW]

Nothing else reads as padding. Notably, the two block-quoted asides that *look* like commentary (AD-6's supersede note, AD-10's invocation arithmetic) are the highest-value content in the document: each is the *derivation* of a decision that would otherwise read as arbitrary preference, and each pre-empts a reviewer or implementer "simplifying" the rule back to the wrong default. Keep both verbatim.

---

## Altitude consistency

**Consistent, with two deliberate dips.**

The spine holds feature altitude well — the ADs bind capability groups, not components, and epics built on §4's ten groups stay coherent under them. AD-1/4/6/8 sit *above* feature level (system-wide), which is correct: those are the invariants that would otherwise be re-decided per epic.

Two dips below feature altitude:

- **AD-10's `~10s` cadence and the invocation-budget arithmetic**, and **AD-14's specific per-hour vendor limits**. Both are implementation-grain. Both are justified: each is a value that the *default* choice gets wrong (an in-process timer; a 100/day free tier), and getting it wrong is discovered late and expensively.
- **The Stack table's version pins.** Correct as invariants — two units on different SvelteKit majors diverge — and correctly separated from the ADs.

The Conventions table's a11y row (44×44px) is UI-detail grain but cross-cutting, so it belongs.

No dip is a defect. AD-14 is the one place where the spine reads more like a research finding than an invariant, and it is close to the line.

---

## Summary of findings

| # | Severity | Finding |
|---|---|---|
| F1 | **HIGH** | Secrets management is entirely silent; AD-9's whole model rests on the service-role key never reaching the client bundle, and SvelteKit's `PUBLIC_`-prefix trap makes that a one-mistake catastrophe (§6) |
| F2 | **HIGH** | Read-side authorization / RLS is unspecified; the anon Realtime read key contradicts PRD §6's no-public-access non-goal by default, and would expose unrevealed lottery seeds, voiding AD-12 (§6, §2) |
| F3 | **HIGH** | AD-10 homes only the auction-close sweep; League Clock expiry, the FR-10 dead-nomination warning, FR-29's deadline and reminders, and AD-15's scheduled export have no scheduled execution home (§1) |
| F4 | **HIGH** | PRD §5 "Measurability" has no architectural home; AD-4's insert-only log makes omitted event fields (SM-4 device class, SM-3 delivery outcome) permanently unbackfillable (§5) |
| F5 | **HIGH** | Observability is deferred, but AD-15's "sustained delivery failure is an incident" and AD-10's silent sweep stall both depend on detection — and the *recording* half is a schema decision that cannot wait for the rehearsal (§3) |
| F6 | **MEDIUM-HIGH** | AD-7 vs FR-23/FR-12: derived money is excluded from projections, so the live-updating board has no specified recomputation seam, and the tempting implementation re-creates client-side derivation of Maximum Bid (§1) |
| F7 | **MEDIUM-HIGH** | AD-2 mandates a single core across Node and Deno without fixing the import mechanism; the friction (Deno extension specifiers, Edge bundle roots) is exactly what drives someone to copy the core (§2) |
| F8 | **MEDIUM** | AD-6 does not pin the advisory lock *key* to a single named constant; two different keys both "take a lock," excluding nothing, failing silently in the exact class AD-6 claims to eliminate (§2) |
| F9 | **MEDIUM** | AD-12 does not forbid the seed being client-readable before the draw, and pins neither the ordering basis nor the seed→winner derivation FR-20 requires managers to reproduce by hand (§2) |
| F10 | **MEDIUM** | Migration rollback unaddressed; AD-16 is forward-only and AD-15 states there are no backups, so a destructive migration against `auction_events` is unrecoverable (§6) |
| F11 | **LOW** | AD-5's "byte-identical" rebuild is unachievable with surrogate keys or timestamps in projections; intent is semantic identity (§2) |
| F12 | **LOW** | Conventions a11y row omits the WCAG 2.1 AA contrast ratios (4.5:1 / 3:1) the NFR names (§6) |
| F13 | **LOW** | §4.1 (FR-3 open) and §4.9 (FR-31 archive) map rows omit AD-4/AD-6 although both are lock-taking, event-appending phase transitions (§5) |
| F14 | **LOW** | Stack omits Svelte's own version, `@supabase/supabase-js`, the test runner, and the Deno version; "Node 26 LTS" needs checking against the October LTS cadence (§4) |
| F15 | **LOW** | Minor bloat: AD-14's setup-day runbook line and vendor trivia; Deferred's last three bullets restate PRD §7.2; the ER diagram is marginal and omits Nomination / Roster Slot (§7, §8) |

**Highest-value cheap fixes, in order:** F8 (two words), F1 (one sentence), F2 (one clause in AD-9), F3 (widen AD-10's scope sentence), F4 (two fields).

---

## What is strong, and should survive editing

Recorded so revision does not erode it:

- **AD-6's supersede block.** Overriding a PRD NFR with a named, concrete counter-example (two co-managers, two auctions, one team, both checks pass) and then costing the alternative out at this scale — that is the paragraph that proves the architect read the domain rather than the template.
- **AD-10's forcing arithmetic.** 181,000 invocations against a 125,000 budget converts a platform choice from taste into arithmetic. Unarguable, and unarguable is the point.
- **AD-4's scope boundary.** "The world is not event-sourced, only the auction is" is the sentence that stops event sourcing from consuming the import path and the roster tables.
- **AD-18.** Twenty-one PRD examples as named tests, with a deploy gate and a same-commit PRD rule, is the strongest available answer to "rule correctness is the product."
- **AD-1's rejection type.** Making the refusal *arithmetic* part of the core's return type rather than a UI concern is what makes FR-13 structurally satisfiable instead of aspirational.
- **The Binds/Prevents/Rule triples are genuinely three different things** on essentially every AD.
