---
stepsCompleted: [1, 2, 3]
updated: 2026-09-08
amendments:
  - '2026-09-08 — Epic 10 (the Outstanding Bid Allowance) appended after the approved Sprint Change Proposal 2026-09-07. Requirements inventory amended in place: FR-15 narrowed, FR-37 rewritten, FR-40 added, AR-36 … AR-40 added, UX-DR32 … UX-DR38 added. Epics 1–9 and their stories are untouched; the shipped ones remain the record their code was verified against.'
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-BBSL-Appspiration-2026-08-16/prd.md
  - _bmad-output/planning-artifacts/prds/prd-BBSL-Appspiration-2026-08-16/addendum.md
  - _bmad-output/planning-artifacts/architecture/architecture-BBSL-Appspiration-2026-08-16/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/ux-designs/ux-BBSL-Appspiration-2026-08-17/DESIGN.md
  - _bmad-output/planning-artifacts/ux-designs/ux-BBSL-Appspiration-2026-08-17/EXPERIENCE.md
  - _bmad-output/specs/spec-BBSL-Appspiration/SPEC.md
  - _bmad-output/specs/spec-BBSL-Appspiration/traceability.md
---

# BBSL-Appspiration - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for BBSL-Appspiration (the BBSL Offseason Free Agent Auction, product name **Appspiration**), decomposing the requirements from the PRD, UX Design and Architecture into implementable stories.

**Vocabulary is fixed.** Every capitalised domain term used below is defined in PRD §3 and is used here with exactly that meaning. A synonym is a defect — in this document, in UI copy, and in code identifiers alike.

## Requirements Inventory

### Functional Requirements

*Extracted from PRD §4 (FR-1 – FR-40). Numbering is the PRD's own and is non-contiguous by feature because FR-35 – FR-40 were appended as they arrived; each is grouped under the feature it belongs to.*

**§4.1 League Setup and Fantrax Import**

FR-1: Commissioner can upload thirty Fantrax-exported Team roster/salary files as one batch, establishing every Team's Existing Contracts, Cap Hits and Roster Slot kinds — with per-file Team resolution, file-level and row-level refusals, outstanding Teams named not counted, single-Team re-supply, a per-Team preview of Roster Count and Cap Space before commit, and an all-or-nothing commit.
FR-2: Commissioner can upload the Fantrax free agent pool export, establishing the set of Players eligible for Nomination, each carrying a stable Fantrax player ID, name, position and NBA team; a Player present both in the pool and on a roster is rejected as a named conflict.
FR-3: Commissioner can transition the League from Setup to Auction Phase, refused (with whatever is outstanding named) unless the pool import and all thirty Team imports are committed and every Team has a bound Manager; the count of Minor League Eligible Players is reported for confirmation but does not block.
FR-38: Commissioner can mark which pooled Players are Minor League Eligible — app-owned data defaulting to *not* eligible, settable individually and in bulk until open, locked afterward except by override, every change recorded as an event, each row stating the consequence in words.

**§4.2 Identity, Teams, and Roles**

FR-4: A Manager can sign in via Discord OAuth without a password and reach their Team's auction view; only Commissioner-pre-registered Discord accounts can obtain a session, sessions persist ≥30 days, no email is sent by this system for any purpose, and a Commissioner sign-in path exists that does not depend on Discord.
FR-5: A Manager acts on behalf of exactly one Team and a Team may have more than one Manager; co-Managers see identical Team state, every Nomination and Bid records the acting Manager alongside the Team, public displays show both, and neither co-Manager can outbid their own Team.
FR-6: The Commissioner holds league-administrative privileges on top of full ordinary Manager rights; Commissioner-only capabilities are unreachable by a non-Commissioner by UI and by direct request alike; the Commissioner's own Team is subject to every ordinary rule; every administrative act is logged with actor, timestamp and stated reason.

**§4.3 Nomination**

FR-7: A Manager can nominate any Free Agent to the Bid Board while their Team's Nomination Slot is unused — the Player appears in Awaiting Opening Bid with no clock, the Slot is marked used, no cap space is committed, the League Clock resets to 48 hours, and the act is logged and broadcast.
FR-8: The system refuses a Nomination when the Team's Slot is in use (naming the holding Player), when the Player is already on the board, already won, or under Contract, or when the League is not in Auction Phase; two concurrent Nominations of one Player produce exactly one.
FR-9: A Team's Nomination Slot is released at the Auction Close of the Player it nominated — regardless of winner, regardless of whether the nominator ever bid, and on no timer of its own; its Managers are notified.
FR-10: The system makes an unbid Nomination visible — flagged on the board past 24 hours, stated plainly in the nominating Team's own view as holding their Slot, notified to its Managers at the 24-hour mark, with no automatic expiry or return-to-pool.

**§4.4 Bidding and Cap Enforcement**

FR-11: A Manager can bid on any Auction their Team is not leading; a Bid must be a whole multiple of $500,000 and, in Standard Contention, at least current high + $500,000; a Bid at or below the current high is refused; the previous Leading Bidder's capital releases immediately and they are notified; the League Clock resets to 48 hours; the Bid is logged with Team, Manager, amount and timestamp.
FR-12: The system continuously computes and displays each Team's Maximum Bid **per open Auction** — `Available Cap Space − Roster Reserve` for a non-eligible Player, unbounded in words for an eligible Player a Free Minor League Slot can absorb — with components broken out, recomputed within one second of any Bid, Close or override, and controls disabled with a stated reason where the figure is below the minimum legal Bid.
FR-13: The system refuses any Bid exceeding the bidding Team's Maximum Bid before it enters the Auction, showing the full arithmetic; validation is server-side against committed state at submission, so a Bid valid when composed but stale on arrival is refused with current figures.
FR-14: The system holds a Team's leading money against its cap for the life of an Auction — leading amounts on non-eligible Auctions, $1,000,000 per Contender position in a non-eligible Minimum-Bid Contention, and Minors Exposure for eligible ones — releasing the instant the Team stops leading or loses a draw, and converting to a Cap Hit at Close.
FR-15: A Bid, once accepted, cannot be withdrawn **by the Team that placed it** — no user-facing control to cancel, edit or lower one exists; a Commissioner override can void it, and the system itself can cancel it under FR-40. *(Retitled and narrowed 2026-09-08.)*
FR-35: A Team may bid without cap limit on a Minor League Eligible Player its Free Minor League Slots can absorb, constrained only by Minors Exposure — the sum of the Overflow Count largest Eligible Leading Bids; exposure recomputes on every bid so a later cheap eligible bid can be refused for exposing an earlier expensive one, naming the Auction that causes it, and an accepted Bid is never retroactively invalidated.
FR-37: A Team has exactly 12 Active/Bench Slots, and a Bid is refused unless `Projected Active/Bench Additions = 0` **or** the Team holds at least one Free Active/Bench Slot and `Projected Active/Bench Additions ≤ Free Active/Bench Slots + 1` — the **Outstanding Bid Allowance**, which lets a Manager chase one more Player than they have room for. A second refusal ground independent of Maximum Bid, with no carve-out for eligible overflow, carrying its own arithmetic (roster count, projected additions, free slots *and* the allowance), and disabling controls across the board (not only at submission). Minimum-Bid Contention entries are exempt entirely. *(Rewritten 2026-09-08; the ceiling of 12 is unchanged and the allowance is never a thirteenth Slot — FR-40 takes the surplus back.)*

**§4.5 Auction Clock, Contention, and Closing**

FR-16: In Standard Contention the Auction Clock is set to exactly 24 hours by each valid Bid, runs continuously with no pause or business-hours adjustment, and displays its absolute close time in the viewer's local timezone alongside the countdown.
FR-17: An Auction whose Opening Bid is exactly $1,000,000 enters Minimum-Bid Contention — clock fixed at 24 hours from that Bid, opening bidder recorded as first Contender, state visually distinct and stating the lottery mechanic and the non-resetting clock in plain language.
FR-18: A Manager can join an open Minimum-Bid Contention by bidding exactly $1,000,000 — added to the Contender list, clock untouched, no joining twice, a Bid strictly between $1,000,000 and $1,500,000 refused, and the League Clock reset to 48 hours.
FR-19: A Bid of $1,500,000 or more converts a Minimum-Bid Contention to Standard Contention — Contender list discarded, every commitment released, clock reset to 24 hours, converting Team becomes Leading Bidder, regardless of Contender count, with every former Contender notified.
FR-20: At Clock expiry in Minimum-Bid Contention the winner is drawn uniformly at `1/n` by Randomizer, recording seed, ordered Contender list as it stood at expiry and selection — permanently visible and sufficient for any Manager to reproduce independently; losing commitments release at the draw.
FR-21: At Auction Clock expiry the system closes the Auction and awards the Player, applying Slot Placement automatically, recording winning amount and Cap Hit, incrementing Roster Count only on an Active/Bench placement, releasing the nominator's Slot, not resetting the League Clock, and firing within 60 seconds with no user present.
FR-22: The system ends the Auction Phase when the League Clock expires — a clock reset only by a Nomination or a valid Bid, derived from surviving reset events rather than stored as a countdown, disabling Nomination and bidding league-wide on expiry, terminating Awaiting-Opening-Bid Auctions with no winner, and notifying all Managers.
FR-40: When an Auction Close leaves a Team holding commitments with no Roster Slot to receive them, the system cancels them **most recent first** — appending a compensating event that never deletes the original Bid, releasing the capital, and notifying the Team with the win that caused it named — then **restores each affected Auction to its next-highest surviving Bid**, re-validating that Team against the money and capacity gates and cascading down on failure; where nothing survives the Auction returns to Awaiting Opening Bid with its Clock cleared. Neither Clock is reset and no prior reset is removed. The trigger is any Close reducing the winning Team's free Slots, Active/Bench **or** Minor League. *(New 2026-09-08 — the other half of FR-37's allowance.)*

**§4.6 The Bid Board**

FR-23: Any Manager can view all open Auctions with live state — identity, price, Leading Bidder, state and time remaining per Auction; sortable and filterable; updating within 5 seconds without manual refresh; countdowns second-accurate and derived from server-authoritative close times; the viewer's Maximum Bid persistently visible on the board itself.
FR-24: Any Manager can open a single Auction and see its complete history — full Bid history with Team, acting Manager, amount and timestamp and no anonymity; live Contender list and non-resetting-clock wording for a lottery; a bid control pre-filled to the minimum legal Bid that never offers an amount above the viewer's Maximum Bid, says "no cap limit" in words where unbounded, and disables with three distinctly worded reasons (already leading / insufficient Maximum Bid / Roster Capacity exhausted).
FR-25: Any Manager can view any Team's roster, cap position and auction activity — every Team's Cap Space, Committed Bids, Available Cap Space, Roster Count by Slot kind, Free Active/Bench Slots, Free Minor League Slots, Minors Exposure and Nomination Slot status visible to all Managers, with Maximum Bid alone remaining the viewer's-own-Team figure; won Players appear on the roster at Close before length is assigned.
FR-39: Any Manager can see all 30 Teams in one index with remaining roster slots and cap position — never paginated, own Team marked but not moved, IR shown visibly outside the twelve, one *median* line (never *average*) taking the lower of the two middle values, no Team coloured/badged/ranked against it, sortable with a Team-name default, columns shifting by phase, computed from the same source as FR-25 so the two cannot disagree, carrying the age of its figures rather than disabling a control it does not have, single-column at 375px and a real table on desktop.

**§4.7 Notifications**

FR-26: The system posts league-wide auction events to a configured Discord channel — Nominations, Bids, Closes, draws (with seed and Contender list), and phase start/end — each naming Team, acting Manager, Player, amount and new close time; a delivery failure never blocks or reverses the underlying action and is surfaced to the Commissioner; at most one post per event even under retry.
FR-27: The system alerts Managers about Team-affecting events by Discord `@mention` — outbid within 60 seconds, Close of an Auction they lead or contend in, Nomination Slot release, the 24-hour unbid-Nomination warning, and Contract Assignment opening; both co-Managers mentioned individually; exactly three mutable categories where muting suppresses the mention but not the post; outbid and phase notices never mutable; every payload declaring its permitted mentions.

**§4.8 Contract Assignment**

FR-28: A Manager can assign a contract length to each Player their Team won from a Year Allotment of one 4-year, one 3-year, two 2-year and unlimited 1-year deals — remaining allotment displayed as they go, an over-allotment assignment refused, changes free until submitted final, unused allotment expiring, Existing Contracts untouchable, and no future-year escalation computed.
FR-29: The system tracks per-Team completion and enforces a deadline that **resolves nothing by itself** — a live Commissioner roster of who has submitted, Discord reminders at a configured interval, no default length ever assigned, the export blocked until every Auction Contract has a length, an unresponsive Team resolved only by a visible Commissioner override, and a loggable deadline extension.

**§4.9 Export to Fantrax**

FR-30: Commissioner can review the complete auction outcome on screen and download it in Fantrax's import shape — blocked with offending Teams named if any Team's salary exceeds $165,000,000, any Roster Count is other than exactly 12, or any Auction Contract lacks a length; unwon Free Agents omitted entirely; stable Fantrax player IDs carried; re-downloadable and logged each time; upload stated plainly as a manual Commissioner step.
FR-36: Commissioner can additionally export each Team's complete post-auction roster — Existing and Auction Contracts alike with Fantrax team ID, player ID, Cap Hit, length and Roster Slot — as a separate download that reconciles exactly with the FR-30 export.
FR-31: Commissioner can mark the auction archived — read-only thereafter, accepting no Bids, Nominations, assignments or overrides, with board, Audit Log and export remaining viewable by all Managers indefinitely.

**§4.10 Commissioner Controls and Audit**

FR-32: Commissioner can void a Bid, adjust Cap Space, terminate an Auction, release a Nomination Slot, extend or expire any Clock, and assign a contract length on a Team's behalf — each requiring a free-text reason before commit, each logged with before-state and after-state; voiding a Bid restores the prior Leading Bidder and prior Auction Clock **and** recomputes the League Clock without that Bid's reset, prospectively only; refused once archived.
FR-33: Any Manager can read the complete Audit Log — append-only and uneditable by any role including the Commissioner, covering every Nomination, Bid, Close, draw with seed, override, import and export, filterable by Team, Player and event type, and exportable.
FR-34: Commissioner can pause and resume the entire auction — every Clock stops advancing, Bids and Nominations are refused with the pause stated as the reason, each Clock resumes with exactly the remaining time it held, and both acts are announced to Managers and posted to Discord.

### NonFunctional Requirements

*Extracted from PRD §5. Numbered here for story traceability; the PRD carries them as prose bullets.*

NFR1: **Rule correctness is the product.** Every bid-validity, clock and cap computation is deterministic and covered by automated tests, with PRD §10 examples 1–28 as executable cases. A rules bug is a worse failure than an outage.
NFR2: **Concurrency safety — global serialization.** State mutation is serialized globally, not per Auction. Two Bids arriving in the same instant produce one winner and one clear rejection, never two accepted Bids, a lost Bid, or a double-counted Committed Bids figure. Per-Auction serialization is explicitly insufficient: the Team is raced, not the Auction.
NFR3: **Server-authoritative time.** All clock arithmetic derives from server time; a client with a skewed clock must not see a different close time or be able to bid after expiry.
NFR4: **Timer reliability.** Auction Close fires within 60 seconds of nominal expiry with no user present and survives process restarts.
NFR5: **Availability is a posture, not a percentage.** No uptime figure is committed to. An outage must be survivable rather than decisive — late closes never wrong ones, a reachable Commissioner pause, and an auction restorable from outside Supabase. Any outage beyond 15 minutes is a pause plus a compensating clock adjustment, and the recovery procedure must be **written down before the auction opens** (auction open is blocked on it).
NFR6: **Mobile-first responsive.** Bidding, nominating and reading the board work one-handed on a phone at 375px. Desktop gains density; mobile loses nothing.
NFR7: **Performance floors.** Board and Auction views interactive within 2 seconds on mobile data; a Bid acknowledged within 1 second; Maximum Bid recomputed within 1 second of any state change; a board change reflected within 5 seconds of the originating action. Floors, not optimisation targets.
NFR8: **Auditability over convenience.** Where a design choice trades away a record for a simpler flow, keep the record. This is the standing tiebreaker.
NFR9: **Scale is not a concern.** 31 users, ~30 concurrent Auctions, a few thousand events across three weeks. Design for correctness, not load.
NFR10: **Accessibility.** WCAG 2.1 AA contrast (4.5:1 text, 3:1 UI components), touch targets ≥44×44px on every bidding and nomination control, and Auction state never conveyed by colour alone — every state carries a word and a shape.
NFR11: **Measurability.** Every Bid, Nomination, Close and notification dispatch is recorded with enough context to compute the §8 metrics without retrofitting — including device class on Bids (SM-4) and dispatch plus delivery outcome on notifications (SM-3). Because the log is append-only these fields must be captured from the first event onward and cannot be backfilled.

### Additional Requirements

*Extracted from `ARCHITECTURE-SPINE.md` (AD-1 – AD-30, Stack, Structural Seed) and the architecture-owned capabilities CAP-15 – CAP-17 that no FR realizes. These are binding technical requirements that shape epic and story structure.*

**Starter template — none.** The Architecture specifies **no starter/greenfield template**. Epic 1 Story 1 is therefore a from-scratch scaffold against a pinned stack, not a template clone.

- **AR-1 — Pinned stack, exactly.** SvelteKit **2.70.2** (the 2.x line, *not* 3.x), `@sveltejs/adapter-netlify` **6.0.4** with `edge: false` (Node functions, not 7.0.0-next.0), TypeScript strict with `noUncheckedIndexedAccess`, Node **24 Active LTS**, Deno for the Supabase Edge runtime, Supabase-managed Postgres **≥15.1.1.61** (required for sub-minute Cron), Supabase free tier ×2 projects (dev + prod, no third environment), Netlify free tier on the credit model. **No email dependency of any kind.**
- **AR-2 — Source tree as specified.** `src/lib/core/{rules,projection,money.ts,constants.ts,types.ts}`, `src/lib/shell/`, `src/lib/adapters/{fantrax,discord}/`, `src/lib/server/`, `src/routes/`, `supabase/{migrations,functions/tick}/`, `tests/examples/`.
- **AR-3 — The rules core is pure (AD-1, AD-2).** Exactly two rules entry points: `evaluate(state, command, now) → GateResults` (total, fixed gate set per command type, every gate's outcome with its own arithmetic) and `decide(state, command, now, seed) → Accepted<Event[]> | Rejected<GateResults>`. `decide()` obtains gates by calling `evaluate()`, never re-deriving. No `Date.now()`, `Math.random()`, `fetch`, database client, or import outside the TypeScript stdlib. Rejections are returned values, never thrown. Iteration is over explicitly sorted sequences only. One core directory imported by both runtimes, using **relative `.ts` imports only** so Deno can load it — never copied, never forked, never re-implemented in SQL.
- **AR-4 — Time is injected, never ambient (AD-3).** `now` enters the core as a parameter sourced from the database server clock at transaction start. Absolute close timestamps are persisted and emitted; clients never receive "seconds remaining." In a close sweep, `now` for each Auction is **that Auction's own nominal expiry**, not the sweep's wall time.
- **AR-5 — Append-only event log (AD-4).** `auction_events` is insert-only for every role including service role and Commissioner; no `UPDATE`/`DELETE` granted. Every event carries database-assigned monotonic `seq`, `occurredAt`, `schemaVersion`, `coreVersion`, acting manager and team, plus NFR11's measurement fields. Corrections append compensating events. Only the auction is event-sourced; imported reference data lives in ordinary mutable tables.
- **AR-6 — Projections are derived, deterministic, disposable (AD-5).** Written only by folding events inside the appending transaction, **ordered by `seq` never `occurredAt`**. Full rebuild possible at any time and deterministic given the same log plus reference-data snapshot; reference-data mutations (cap hits, eligibility flags, corrections) are themselves events. Rebuild is idempotent.
- **AR-7 — One global write lock, one key, one arity (AD-6).** Every mutating transaction calls `pg_advisory_xact_lock` **before reading any state**, with a single named constant of one fixed arity defined once in `core/constants.ts`. Transaction-scoped, never session-scoped (survives Supavisor transaction-mode pooling). Mixing one-arg and two-arg forms is a silent total failure.
- **AR-8 — Derived money is never stored, and is evaluated post-bid (AD-7).** Available Cap Space, Committed Bids, Minors Exposure, Overflow Count, Roster Reserve, Projected Active/Bench Additions, Maximum Bid and Roster Capacity are computed at validation time against the hypothetical state that would exist **if the prospective Bid were accepted**. Never persisted on a team row, memoised across transactions, or cached client-side for validation.
- **AR-9 — Money is integer dollars, branded at every boundary (AD-8).** `bigint` in Postgres, integer arithmetic in TypeScript, no floats/decimal library/cents. Every runtime boundary parses money into a branded integer type at the edge (`int8` arrives as `string` via node-postgres and `number` via PostgREST). The abbreviated `$14.5M` rendering is permitted in the UI **and Discord payloads** and **never in a CSV cell**. The $500,000 grid binds every derived figure including aggregates.
- **AR-10 — No client write path (AD-9, AD-16).** No client-facing database role holds INSERT/UPDATE/DELETE on any table; the browser key is read-only and used solely for Realtime. Every table carries an explicit RLS policy; anonymous roles read nothing; pre-reveal seed tables are readable by no client-facing role. Service-role key, Discord OAuth secret and webhook URL are server-only and never behind a `PUBLIC_` name.
- **AR-11 — One cron, one tick (AD-10).** A single Supabase Cron schedule invokes a single Edge Function that sweeps closes **then** drains the outbox, at a sub-minute interval chosen against remaining free-tier headroom (two 10s schedules would be ~518K invocations/month against a 500K org-wide cap; one combined tick is ~259K). Never on Netlify, no in-memory timer, overdue work re-derived rather than remembered. The dev schedule is disabled by default.
- **AR-12 — Closes are sequential and deterministically ordered (AD-11).** Within one sweep pass, overdue Auctions close one at a time in ascending nominal expiry, ties broken by auction id, each close's effect committed to the state the next close is evaluated against. Folding an overdue set against one snapshot is a defect.
- **AR-13 — Expiry is authoritative for validation (AD-12).** An Auction past its close time is closed for validation from that instant regardless of whether the sweep recorded it. A stalled sweep produces *late* closes, never *wrong* ones.
- **AR-14 — Pause stores remaining duration and halts the sweep (AD-13).** Pausing persists each clock's remaining duration and the pause instant; resume recomputes absolute close times forward. Absolute close times are never shifted in place. The sweep checks paused state under the same lock and closes nothing while paused. A **break-glass pause path independent of Netlify** (a database-settable flag) must exist.
- **AR-15 — Commit-reveal randomizer (AD-14).** A seed is generated when a Minimum-Bid Contention opens and stored **outside the league-readable log**, in a table no manager-facing role can read; only `hash(seed)` is published until the draw. Contender order is pinned to ascending join `seq`. The seed→winner derivation is documented, deterministic and hand-reproducible. A dissolved contention reveals its seed at dissolution.
- **AR-16 — Identity is Discord OAuth, bound server-side (AD-15, AD-27).** `signInWithOAuth({ provider: 'discord' })` through Supabase Auth. The Manager→Team binding, Commissioner flag and Discord user id live in application tables written only by the Commissioner and resolved server-side per request — **never** from JWT app-metadata (self-writable via `updateUser`). An unregistered account is refused without enumerating the league; an expired session is a distinct outcome from one that never existed.
- **AR-17 — Transactional outbox (AD-17).** The transaction that appends events also inserts delivery intents; a separate dispatcher drains with retry and backoff inside the same tick. Delivery never runs inside the auction transaction and can never fail it. The idempotency key is **`(event seq, channel, recipient)`** — keying on the event alone would deduplicate the second co-Manager's mention.
- **AR-18 — Discord is the only notification transport (AD-18).** Every notification is a Discord message in the league channel; a directed notice carries an `@mention` of the Manager's Discord id. Muting posts the event without the mention. Every payload sets `allowed_mentions` explicitly. The webhook limit is **30 requests/minute**, so the dispatcher batches where it can and backs off on 429 — a sweep closing many Auctions at once is the case that hits it.
- **AR-19 — Liveness and quota monitored from outside both vendors (AD-19; CAP-16).** Every tick writes a heartbeat. A detector **outside both Netlify and Supabase, sharing no component with the outbox path and not routed through Discord** alerts on a stale heartbeat, a growing outbox backlog, and a projection-integrity mismatch against a rebuild. Netlify credit burn (300/month) and Supabase Edge invocation burn (500K/month, org-wide) are alerted on well before their ceilings. The alert must reach a sleeping operator.
- **AR-20 — Rule changes are versioned and fail-stopped (AD-20).** Every event records the `coreVersion` that produced it; Node and Deno deployments carry the same version or the tick **refuses to run and alerts**. Any deploy touching `core/` during a live Auction Phase requires a pause, a green §10 suite, and a recorded reason.
- **AR-21 — Offsite restore path (AD-21; CAP-17).** The free tier has no automatic backups, no PITR and no SLA. A scheduled export of the event log **plus the reference data a fold needs** runs for the duration of the Auction Phase to storage in a third failure domain, and the restore is **rehearsed at least once before the auction opens**. A Discord incoming webhook is write-only and is not a restore path.
- **AR-22 — The League Clock is a fold with one origin and exactly two reset event types (AD-22).** Its **origin** is `AuctionOpened` — an origin, not a third reset, because the open can never be unwound. Reset by a Nomination and an accepted Bid (lottery join included) and nothing else; new event types default to not resetting it. Derived as 48 hours from the later of the origin and the latest surviving reset event, so a `BidVoided` compensating event removes that reset and the clock recomputes shorter — prospectively only, and never back past the origin. The fold must treat a voided Bid as a non-reset rather than expecting the original event to be gone.
- **AR-23 — Winning amount and Cap Hit are distinct persisted fields (AD-23).** A Minor League placement yields a Cap Hit of `$0` while the winning amount stands unchanged. No code path derives one from the other by assuming equality; both exports emit both.
- **AR-24 — Fantrax knowledge is confined to one adapter (AD-24).** CSV column names, header shapes and Fantrax quirks appear in exactly one module; nothing outside it knows Fantrax exists. Rows join on the **stable Fantrax player ID, never on name**. The import is **thirty-one files** with two refusal altitudes (a *file* refused by name; a *row* refused by row) and Teams outstanding **named, never counted**. Minor League Eligible is never derived, inferred, or failed on. Exports emit exact integer dollars.
- **AR-25 — The §10 examples are the executable specification (AD-25).** Each of examples 1–28 exists as a named test calling the core directly — no database, no HTTP, no clock mocking, no fixtures beyond a state literal. A rule change altering any example's outcome changes the PRD in the same commit. The suite is green before any production deploy.
- **AR-26 — Schema changes are migrations in the repository (AD-26).** Every change is a migration file committed to the repo and applied dev-first. Nothing is typed into the Supabase dashboard. A migration applied while the tick is running must be safe against a concurrent sweep, or the tick is paused for it.
- **AR-27 — The import is staged, then promoted in one transaction (AD-28).** Parsed rows land in staging keyed by Team (the pool as its own distinguished source), never straight into live reference tables. Per-file parse status **persists between requests** so the import survives a refresh, a closed tab, or being resumed an hour later. Re-supplying one Team's file replaces only that Team's staged rows. Promotion is one all-or-nothing transaction across all thirty-one sources.
- **AR-28 — Read freshness is explicit, and stale money disables (AD-29).** Every projection read carries a **single global watermark** — the highest event `seq` folded, read from one source, never a per-table stamp. The client derives exactly one of Live / Reconnecting / Stale from connection status **and** a positive periodic liveness check; `FRESHNESS_WINDOW` and `STALE_WINDOW` are named constants in `core/constants.ts`. **A stalled watermark must never imply staleness** — the question is "can I still reach the server?", never "has anything changed?". Countdowns are exempt.
- **AR-29 — Phase and role gate the surface from one server-resolved source (AD-30).** League phase (Setup / Auction / Contract Assignment / Archived) and viewer role resolve server-side per request from the same application tables identity binds to, producing **one destination list** rendered in two places. A destination not live in the current phase is not rendered **and its route refuses server-side**. Phase is a projection folded from the log, never a hand-set flag.
- **AR-30 — Synthetic-clock replay is a required capability (CAP-15, AD-3).** A rehearsal drives a full auction — nomination, bidding, lottery, closes, phase end, assignment, export — end to end against an injected clock at arbitrary speed with no wall-clock waiting and **no code path special-cased for the rehearsal**.
- **AR-31 — The outage recovery procedure is scheduled build work and blocks auction open.** How a >15-minute outage maps onto a pause plus a compensating clock adjustment, written before the auction opens (PRD OQ-9; SPEC constraint).
- **AR-32 — League constants live in `core/constants.ts`.** $165M cap, $1M minimum, $500k increment **and** granularity (one constant serves both), 24h, 48h, 12 Active/Bench, 2 IR, 3 Minor League, allotment counts, the AD-6 lock key, and the AD-29 freshness windows. No admin UI edits them.
- **AR-33 — Obtain a real Fantrax export and confirm the salary and roster-slot columns.** Open action, owned by CAP-1, required **before setup day**. The minor-league flag no longer needs confirming (settled as absent).
- **AR-34 — Two build-time decisions deferred by the architecture.** (a) Discord delivery shape — one message per event or batched against the 30 req/min ceiling, revisited at the rehearsal; (b) outbox implementation — Supabase Queues (pgmq) versus a hand-rolled table. AD-17's contract is unchanged either way.
- **AR-35 — Archive reachability across the dormant year.** A free-tier project pauses after a week idle and this app idles ~11 months, while FR-31 requires an archived auction remain viewable indefinitely. Options: a paid month, a static export of final state, or accepted manual resume. Revisit at archive time.

- **AR-36 — A cancellation is compensating, records its own restoration, and shares one restorer with the void (AD-31).** `BidCancelled` carries the decision it made — cancelled `seq`, cause, and either the restored Team/`seq`/amount or `null` — and the projection **reads** it rather than re-deriving; re-deriving would mean re-running the gate suite over candidate bidders inside a fold. `close.ts` is the **sole appender**: `AuctionClosed` first, then each `BidCancelled` in cascade order; `restore.ts` decides and appends nothing. Restoration is evaluated against **post-close** state. The selection algorithm lives in **one** pure function consumed by both FR-40 and Story 7.2's void, which differ only in three parameters (erase-vs-retain in the fold, restore-vs-leave the Auction Clock, remove-vs-keep the League Clock reset). Cancellation is triggered only by a Close and never by a restoration — that is what bounds the cascade. **No migration:** `event_type` is a generic `text` column.
- **AR-37 — The gate set is fixed per command type, and restoration is the second (AD-2).** `RestoreLeadingBid` declares `{cap, slots}` and nothing else. Implementing it as a synthetic `PlaceBid` would re-run the increment rule against a price that has just *fallen* and refuse every restoration that mattered.
- **AR-38 — Sequential closing is now load-bearing for unlimited lotteries (AD-11).** Each Close commits its cancellations and restorations before the next Close is evaluated. A Team in several simultaneously-expiring lotteries that wins the first is removed from the remainder before they are drawn; under a batched fold it wins two.
- **AR-39 — A cancellation resets nothing and removes nothing (AD-22).** `BidVoided` and `BidCancelled` are one line apart in any reducer and have **opposite** League Clock semantics: a void removes that Bid's reset (clock recomputes shorter), a cancellation leaves it standing. A reducer treating them alike ends the Auction Phase early every time a roster fills.
- **AR-40 — Two overflow figures, not one (PRD §3).** `Overflow Count` (money side) counts lottery entries and feeds Minors Exposure; `Active/Bench Overflow` (slots side) excludes them and is the only overflow reaching Projected Active/Bench Additions. They were one figure until 2026-09-08 and are one subtraction apart, so compute-once-use-twice is now wrong in a way no single test announces.

### UX Design Requirements

*Extracted from the bmad-ux spine pair — `DESIGN.md` (visual identity, tokens, component anatomy) and `EXPERIENCE.md` (information architecture, behaviour, states, flows). Each is scoped to be story-generating.*

**Foundation and identity**

UX-DR1: Implement the **design token set** verbatim from `DESIGN.md` frontmatter — 20 colour tokens (dark only, no light theme, none planned), two type families (Georgia `display` / system-ui `ui`, no third) with the 10-step scale and `tabular-nums`, a uniform `3px` radius, and the named spacing and component dimensions (`control-height 46px`, `touch-min 44px`, `strip-height 52px`, `border-width 1px`, `accent-bar-width 3px`).
UX-DR2: Enforce the **two colour laws** in code and review: green (`brand`) is brand only and never signals leading/winning/safe/approved; `attention` (amber, never red) is the single attention colour and marks **Outbid and nothing else** in the entire system.
UX-DR3: Enforce the **border discipline**: `border-interactive` (#5E7568, 3.34:1) is mandatory on every input, button and meaning-carrying chip outline; `border` (#24332A, 1.25:1) is decorative panel edging and **must never bound a control**.
UX-DR4: Implement the **money renderer** — abbreviated everywhere (`$14.5M`), **always exactly one decimal, never dropped**, `tabular-nums`, true minus sign (U+2212) for negatives, unbounded Maximum Bid rendered **in words** ("no cap limit") and never as a number. Permitted in the UI and Discord payloads; forbidden in any CSV cell.
UX-DR5: Implement the **naming rule, app-wide**: a three-letter capitalised abbreviation always means a player's real-life NBA team and never anything else; a fantasy Team is always spelled out plus the acting Manager (`Lakers — Meakel`). Holds on the board, the Auction, bid history, the Audit Log, Team views, Discord posts and both exports.
UX-DR6: Implement the **voice rules** as microcopy constraints: no exclamation marks anywhere in the product; refusals state the fact then the arithmetic; reassure about state not feelings; state non-obvious rules consequences in a sentence rather than implying them by control; never advise; never manufacture urgency.
UX-DR7: Enforce the **urgency-design ban list** as a build rule: no pulsing or reddening countdown, no one-tap raise, no suggested bid amount, no "hurry"/"ending soon"/"last chance" copy, no spending leaderboard, no celebration animation on winning. No elevation, no drop shadows, no glows — depth is a 1px border plus one surface step. No emoji anywhere; icons never appear without an accompanying word.

**Components**

UX-DR8: **Board card** — flat panel; player name Georgia 18px; metadata line `NBA · POS · $0.0M · Nyr` in `text-secondary` 12px; price at 26px with the state chip opposite; leading Team and Manager; time remaining **and** absolute close time in the viewer's timezone.
UX-DR9: **State chip** — uppercase 9.5px, `0.09em` tracking, 3px radius, **always carrying an icon and a word**. Filled `attention`/`attention-ink` for Outbid; outlined `border-strong`/`text` for You lead; plain `text-secondary` label with no chip for ambient states (Open, Awaiting bid).
UX-DR10: **Arithmetic breakdown** — label left `text-secondary`, figure right `text`, `tabular-nums`, 7px row gap, subtotals ruled with `border`, final total ruled with `border-strong` and its label in Georgia. **Every breakdown must visibly sum** — this is the load-bearing property of the product.
UX-DR11: **Bid control** — 46px input on `surface-sunken` bounded by `border-interactive`, pre-filled with the minimum legal Bid, never offering an amount above the viewer's Maximum Bid; submit button beside it at the same height; when unavailable both disable **with the reason stated in words beneath them**. Submission is a deliberate two-part act. **No control to cancel, edit or lower an accepted Bid exists — not disabled, absent.**
UX-DR12: **Refusal panel** — the most important surface in the product, with a dedicated anatomy: `surface` panel with a **3px top accent bar in `attention`** (the sole use of a top bar in the system), padding `13px 12px 12px`, internal gap 11px, and six parts in order — Georgia 19px headline ("This bid was not placed."), the delta in one sentence, reassurance of state, **both gates always** (refusing gate = filled `attention` chip; passing gate = outlined `border-interactive` chip, chip left / sentence right, top-aligned, neither collapsed behind a disclosure), the full timestamped arithmetic, and the disabled bid control with its reason. Reporting a capacity refusal as a cap refusal is a defect.
UX-DR13: **Persistent strip** — 52px, full-bleed, `surface`, `border-strong` top edge, showing *Maximum Bid* in Georgia `brand`, the figure and Roster Count **at all times on every surface**, recomputing within one second of any Bid, Close or override, and doubling as navigation. On desktop it moves into the header rather than pinning to the bottom of a 1400px viewport; Maximum Bid stays persistently visible at every width.
UX-DR14: **Teams row** (FR-39 / CAP-20) — flat `surface` rows separated by a 1px `border` rule rather than card gaps; Team name and Manager(s) in **`ui` 15px, not Georgia**; figures in `ui tabular-nums` 15px under 10px uppercase `0.16em` `text-tertiary` labels; slot counts as `9 of 12` with `of 12` in `text-secondary`; Injury Reserve in `text-tertiary` and visibly outside the slot group; the viewer's own row marked by a **2px `border-strong` left edge plus `— you`** (never the 3px bar, which belongs to Minimum-Bid Contention) with **every Team name staying in `text`**. **Nothing in this component is ever coloured by comparison** — a greyscale screenshot of it is identical.
UX-DR15: **Median line** — at the foot of the Teams list, separated by a `border-strong` rule, labelled *median* (never *average*) at 10px uppercase with figures in `text-secondary` 15px, visually quieter than every row above it. No colour, badge, rank, arrow, ordinal, or copy characterising any Team as ahead, behind, rich, poor, stacked or thin.
UX-DR16: **Commissioner control class** — distinguished from Manager controls by **four independent differences, not colour**: never filled, dashed 1px `admin` border, its own recessed `admin-ground` behind a dashed rule, and a persistent *"Commissioner · visible only to you"* label. Inline and content-width rather than full-width. Controls live **in place on the object being acted on**; genuinely global acts get their own admin destination.
UX-DR17: **Override reason sheet** — **no Commissioner act is ever a single tap.** The sheet names the act in Georgia, shows **before → after** for every affected value including both Clocks, states any non-obvious downstream consequence in words (voiding a Bid removes its League Clock reset and can end the Auction Phase sooner) with an `attention` note where non-obvious, and requires free text with no placeholder, no default and no skip. The commit control is itself dashed.
UX-DR18: **Paused banner** — `attention` border on a warm ground, present on every surface, stating that Clocks are stopped, that Bids and Nominations are refused, and that each Clock resumes with exactly the time it held, plus who paused it, when, and their reason.

**Information architecture and behaviour**

UX-DR19: **One destination list, two affordances** — the persistent strip's sheet (mobile primary) and the header menu (desktop primary) are one list rendered twice, filtered by phase and role, and can never offer different sets. Live destinations per phase are specified per `EXPERIENCE.md` § Phases for Setup, Auction, Contract Assignment and Archived.
UX-DR20: **Landing is Your Positions** — a destination of its own, not a board filter and not a pinned group — grouped in the order the wake-up asks: *won while you slept · outbid · you lead · contending · Nomination Slot*. An outbid card carries whether a legal re-entry exists at all, so nobody taps into an Auction to discover it is arithmetically gone. The full Bid Board is one tap away and **opens unfiltered**.
UX-DR21: **Auction state treatments** — five distinct presentations: Awaiting Opening Bid (no clock at all, "No opening bid" in `text-tertiary`, states that it holds the nominator's Slot, shows hours unbid and is publicly visible so the dead Slot stings); Open; Minimum-Bid Contention (`lottery` 3px left accent bar, icon, label, Contender count, and the words *the clock will not reset on a join*); Closed (winner, amount, Slot placement, and for a lottery the seed and ordered Contender list); Terminated (no winner, Player returned, reason if by override).
UX-DR22: **Viewer-relative states** — You lead · Outbid · Contender · Not involved, each carrying a word and a shape, with `attention` marking Outbid only.
UX-DR23: **Connection and freshness, three states** — Live (nothing said), Reconnecting (the strip states figures may be stale and gives the age of the last update), Stale (**bid and Nomination controls disable with the reason stated**; Maximum Bid renders as a last-known figure explicitly labelled). The transition to Stale is **announced, not merely rendered**; recovery is silent and immediate; countdowns never freeze on disconnect; an Auction that expires while the client is Stale displays as expired and refuses bids.
UX-DR24: **Sign-in states, four** — Signed out (a single Discord action, one sentence, **no email field anywhere**); Not registered (states plainly, names the Commissioner as the route, discloses nothing about whether the account or any Team exists, offers no retry loop); Session expired (reads as expired rather than a fresh sign-out and returns to the surface they were on); Commissioner fallback (independent of Discord, unadvertised but reachable). Every sign-in surface renders the phase the league is currently in.
UX-DR25: **Empty and first-run states** — the board at auction open is empty and that is a **designed screen**: it explains the state and points at Nominate. Your Positions when empty points at the board and at the unused Nomination Slot.
UX-DR26: **Timezone and clock presentation** — every time is shown twice, relative ("4h 12m left") and absolute in the viewer's own timezone ("closes 2:14 AM Wed"); the absolute time is never omitted to save space. The interface states plainly that the Auction Clock never pauses for hours of day.
UX-DR27: **Interaction primitives** — confirm before commit on Bids, Nominations, contract assignments and every override; client-side logic only disables controls and pre-fills amounts; a notification link lands on the specific Auction, already signed in, with the manager's position visible without a further tap.

**Accessibility and responsive**

UX-DR28: **Accessibility floor, enforced as acceptance tests** — WCAG 2.1 AA with `DESIGN.md`'s measured ratio table as the reference (two failures already corrected: `text-tertiary` 3.59 → 4.98, control boundaries 2.18 → 3.34); touch targets ≥44×44px with the bid control at 46px; **a greyscale screenshot of any surface must remain fully readable — that is the acceptance test**; `text-disabled` (2.44:1) is legitimate *only* because a disabled control always carries its reason beside it in `text-prose`, so a disabled control without a stated reason is a defect; money `tabular-nums` throughout; **refusals announced to assistive technology as they appear**, not merely rendered.
UX-DR29: **Responsive contract** — 375px is the design width and the smallest supported; Manager surfaces are single-column throughout; the Teams index is a single-column list at 375px (never a horizontally scrolling table) and a genuine table on desktop; Commissioner surfaces (31-file import status, per-Team preview, assignment monitoring, export) gain multi-column layouts on desktop but stay **fully operable at 375px**, because a pause during an outage happens wherever the Commissioner physically is.
UX-DR30: **Surfaces with no mock, specified by table and rule only** — Sign-in, Nominate, Audit Log, Notification settings, Import and its 30-Team preview, Minor League Eligibility, the auction-open gate, assignment monitoring, Contract Assignment, Export and archive, and operational health. These carry the highest drift risk and may need a visual reference raised before they are built. (Mocked surfaces: `House`, `Positions`, `Board`, `Auction`, `Commissioner`, `Teams`.)
UX-DR31: **Deferred UX findings, documented and unfixed** (nine medium, eight low from `review-rubric.md`) — chiefly no Key Flow for override (CAP-14), export (CAP-13) or operational alerting (CAP-16); no cold-load, Contract Assignment or import-error states in State Patterns; the destinations sheet and filter chips unspecified; no flow→capability traceability; and no Inspiration & Anti-patterns section. Carry as known gaps to close during story work.

**The Outstanding Bid Allowance and Bid Cancellation** *(added 2026-09-08)*

UX-DR32: **The refusal panel's slots row carries two figures and three distinct strings.** Passed reads *"Slots · Passed — your 2nd of 2 permitted bids; Roster Count would be 10 of 12"*; refused on the allowance reads *"this would be your 3rd outstanding bid; 1 free slot permits 2"*; refused on the precondition reads *"no free Active/Bench slot, so no bid is permitted"*. The last two must not collapse into one string — "at your allowance" resolves itself at the next close, "no room at all" lasts the whole auction, and the remedies differ.
UX-DR33: **The gate row wraps rather than truncates** (`DESIGN.md` → Components → Refusal panel). Line-height `1.6`, aligned to the sentence's first line, never centred on the chip. A truncated gate sentence is a gate that did not report.
UX-DR34: **The bid control names the allowance trade before confirm, once.** *"This is your 2nd of 2 permitted bids. If you win a player before this auction closes, this bid is cancelled and the next highest bid leads."* Not a warning dialog, not a checkbox, and not repeated on later views. This is where the product's obligation is discharged — Key Flow 6 puts its climax here deliberately.
UX-DR35: **The persistent strip carries bids against the allowance** — `Roster 9 of 12 · 2 of 4 bids`. At parity the figure alone is the signal: no colour, no badge, no warning treatment, because the strip is inherited by every screen and a nag here is a nag everywhere.
UX-DR36: **The Teams index row gains a bids column**, with open lottery entries counted **separately**. The roster column alone now answers the screen's own question wrongly in both directions. Folding lotteries into one figure would imply a ceiling that does not exist.
UX-DR37: **"Cancelled and restored" — one event, three notices.** The cancelled Manager gets cause-before-effect, no apology, no alarm styling, no congratulation wrapped around it. The restored Manager gets context re-established, then what it costs their cap and how long they have (the clock did not reset — it may be minutes). The league gets one line in the existing register.
UX-DR38: **The cancelled Bid stays in the visible Auction history**, struck through and labelled *cancelled*, with the causing win named — never deleted, hidden or reordered. Copy must distinguish it from a void: a void says someone decided the Bid should not have stood; a cancellation says nothing of the kind. An Auction where nothing survived renders as an unbid nomination, not a new "restarted" state.

### FR Coverage Map

*Every FR-1 … FR-40 appears exactly once **as an owning epic**. Order follows the PRD's own numbering, not epic order, so a gap is visible at a glance. Rows marked **amended by Epic 10** keep their original owner — the shipped stories under it are the record their code was verified against — and Epic 10 supersedes named clauses within them rather than taking ownership.*

| FR | Epic | Coverage |
| --- | --- | --- |
| FR-1 | Epic 1 | 31-file Team roster import, staged then promoted atomically |
| FR-2 | Epic 1 | Free Agent pool import with stable Fantrax player IDs |
| FR-3 | Epic 1 | Auction-open gate, naming whatever is outstanding |
| FR-4 | Epic 1 | Discord OAuth, pre-registered accounts only, Commissioner fallback path |
| FR-5 | Epic 1 | Manager→Team binding and co-management |
| FR-6 | Epic 1 | Commissioner role, server-side capability checks |
| FR-38 | Epic 1 | Commissioner-set Minor League Eligibility, defaulting to *not* eligible (Story 1.10) — *row restored 2026-09-08; the story shipped, the map row had been missing since the map was written* |
| FR-7 | Epic 2 | Nominate a Free Agent onto the Bid Board |
| FR-8 | Epic 2 | Nomination eligibility enforcement and concurrent-nomination uniqueness |
| FR-9 | Epic 2 | Nomination Slot release at Auction Close |
| FR-10 | Epic 2 | Dead-nomination visibility at 24 hours |
| FR-11 | Epic 2 | Place a Bid — increment, granularity, no self-outbidding · **amended by Epic 10** (the control names the allowance bid before confirm) |
| FR-12 | Epic 2 | Compute and display Maximum Bid per Auction with components broken out |
| FR-13 | Epic 2 | Reject over-cap Bids at submission with the full arithmetic |
| FR-14 | Epic 2 | Commit and release capital, including Minors Exposure · **amended by Epic 10** (release on cancellation, re-commit on restoration) |
| FR-15 | Epic 2 | No *voluntary* bid retraction — the control is absent, not disabled · **narrowed by Epic 10** (the system may cancel; the Team still may not) |
| FR-16 | Epic 2 | Standard Contention clock set to 24h by each valid Bid |
| FR-24 | Epic 2 | The Auction detail page — bid control, refusal panel, full history. *One clause carries over: its live Contender list and non-resetting-clock wording have no subject until Minimum-Bid Contention exists, and are completed by Story 3.2.* |
| FR-35 | Epic 2 | Unbounded eligible bidding bounded by Overflow and Minors Exposure |
| FR-37 | Epic 2 | Roster Capacity as the second, independent refusal ground · **rewritten by Epic 10** (the Outstanding Bid Allowance and its free-slot precondition) |
| FR-17 | Epic 3 | Enter Minimum-Bid Contention on a $1,000,000 Opening Bid |
| FR-18 | Epic 3 | Join a Minimum-Bid Contention; the clock does not reset · **amended by Epic 10** (unlimited entries; cap space the only limit) |
| FR-19 | Epic 3 | Dissolve a contention on a Bid of $1,500,000 or more |
| FR-20 | Epic 3 | Commit-reveal Randomizer draw, independently reproducible · **amended by Epic 10** (list excludes cancelled Contenders; an empty list closes with no winner) |
| FR-21 | Epic 3 | Close an Auction with automatic Slot Placement, within 60 seconds · **amended by Epic 10** (the Close applies the FR-40 cascade before the next Close is evaluated) |
| FR-22 | Epic 3 | League Clock expiry ends the Auction Phase |
| FR-23 | Epic 4 | View the Bid Board with live state and persistent Maximum Bid |
| FR-25 | Epic 4 | View any Team's roster, cap position and auction activity |
| FR-39 | Epic 4 | The 30-Team index with its League Median · **amended by Epic 10** (rows publish bids against the allowance) |
| FR-26 | Epic 5 | Broadcast auction events to the league Discord channel |
| FR-27 | Epic 5 | Notify Managers by Discord `@mention` within 60 seconds |
| FR-28 | Epic 6 | Assign contract lengths against the Year Allotment |
| FR-29 | Epic 6 | Track completion; the deadline notifies but resolves nothing |
| FR-30 | Epic 6 | Review and export Auction Contracts in Fantrax's import shape |
| FR-36 | Epic 6 | Export full post-auction rosters, reconciling with FR-30 |
| FR-31 | Epic 6 | Archive the auction — read-only, viewable indefinitely |
| FR-32 | Epic 7 | Commissioner overrides, each with a mandatory reason |
| FR-33 | Epic 7 | League-visible append-only Audit Log |
| FR-34 | Epic 7 | Pause and resume the entire auction |
| FR-40 | **Epic 10** | Cancel a surplus commitment at Close and restore the Auction to its next-highest bidder |

**Requirements with no FR, mapped to an owning epic.** These are NFR- and AD-driven and must not be orphaned:

| Requirement | Epic | Note |
| --- | --- | --- |
| NFR1 rule correctness / AR-25 §10 suite | Epics 2, 3 | Examples 1–5, 12, 15–20, 23–26 land in Epic 2; 6–11, 13, 21, 22, 27 in Epic 3; 28 in Epic 4. Green before any production deploy. |
| NFR2 global serialization / AR-7 | Epic 1 | The lock is built with the substrate and used by every later mutation. |
| NFR3 server-authoritative time / AR-4 | Epic 1 | `now` injected from transaction start; exercised end-to-end in Epic 8. |
| NFR4 timer reliability / AR-11, AR-12 | Epic 3 | The tick, and expiry-authoritative validation. |
| NFR5 availability posture / AR-31 | Epic 8 | The written recovery procedure blocks auction open. |
| NFR6 mobile-first 375px / UX-DR29 | Epics 2, 4 | Every Manager surface; Commissioner surfaces stay operable at 375px in Epic 1. |
| NFR7 performance floors | Epic 4 | 2s interactive, 1s bid ack, 1s Maximum Bid recompute, 5s board reflection. |
| NFR8 auditability over convenience | Epic 7 | The standing tiebreaker; the Audit Log is where it is demonstrated. |
| NFR9 scale is not a concern | — | A design constraint, not deliverable work. |
| NFR10 accessibility / UX-DR28 | Epics 1, 2, 4 | Tokens and contrast in Epic 1; the greyscale acceptance test applies to every surface thereafter. |
| NFR11 measurability | Epics 2, 3, 5 | Device class on Bids and Nominations; dispatch and delivery outcome on notifications. **Cannot be backfilled** — captured from the first event onward. |
| CAP-15 synthetic-clock replay / AR-30 | Epic 8 | The capability is an Epic 1 architectural property (AD-3); Epic 8 is where it is exercised. |
| CAP-16 liveness and quota alerting / AR-19 | Epic 8 | External detector in a third failure domain, not routed through Discord. |
| CAP-17 offsite export and restore / AR-21 | Epic 8 | Restore **rehearsed** before open — an untested restore is not a restore. |
| AR-33 confirm real Fantrax columns | Epic 1 | Open action, required before setup day. |
| AR-34 Discord delivery shape; outbox implementation | Epic 5 | Build-time decisions; revisit delivery shape at the Epic 8 rehearsal. |
| AR-35 archive reachability across the dormant year | Epic 6 | Revisit at archive time. |
| UX-DR30 spec-only surfaces (no mock) | Epics 1, 6, 7, 8 | Highest drift risk; raise a visual reference before building if one turns out to be needed. |
| UX-DR31 deferred UX review findings | All | 17 documented, unfixed findings carried as known gaps to close during story work. |

## Epic List

### Epic 1: Setup day — the league's data in, the auction open

The Commissioner can stand up the app, load all thirty-one Fantrax exports, set Minor League Eligibility by hand, and open the auction; every Manager can sign in with Discord and find their Team bound to them. Realizes EXPERIENCE Key Flow 1 — *"the climax is the moment the app refuses him."*

**FRs covered:** FR-1, FR-2, FR-3, FR-38, FR-4, FR-5, FR-6

**Also carries:** a from-scratch scaffold on the pinned stack (the Architecture specifies **no starter template**), the append-only event log and projection substrate, the one global advisory lock, branded integer money, RLS with no client write path, migrations applied dev-first, the staged-then-promoted 31-file import, server-resolved phase-and-role gating, and the design token foundation.

**Standalone:** a league that exists, with people who can sign in, and an auction that has opened.

### Epic 2: Nominate and bid — the engine and the refusal

A Manager can put a Free Agent on the board and bid on him, with Maximum Bid always visible and broken into its components, and an illegal Bid refused at submission — both gates reported, arithmetic that visibly sums. Realizes Key Flow 3, and PRD UJ-1 and UJ-3.

**FRs covered:** FR-7, FR-8, FR-9, FR-10, FR-11, FR-12, FR-13, FR-14, FR-15, FR-16, FR-24, FR-35, FR-37

**Also carries:** the pure `evaluate()` / `decide()` rules core, Minors Exposure and Overflow, Roster Capacity as the second independent gate, the refusal panel, and §10 examples 1–5, 12, 15–20, 23–26.

**Standalone:** a working ascending auction. Auctions do not close yet — deliberately, and nothing here depends on the epic that makes them.

### Epic 3: The auction resolves itself — lottery, close, and phase end

Auctions close within 60 seconds of expiry with nobody watching, the $1,000,000 lottery draws a winner any losing Manager can reproduce, and the auction ends itself after 48 hours of league silence. Realizes Key Flows 4 and 5, and PRD UJ-2.

**FRs covered:** FR-17, FR-18, FR-19, FR-20, FR-21, FR-22

**Also carries:** the Deno tick (one cron schedule, one Edge Function, sweep **then** drain), sequential deterministic closes, expiry-authoritative validation, the commit-reveal Randomizer with its seed unreadable before the draw, the League Clock as a fold, automatic Slot Placement, and dual-runtime `coreVersion` parity fail-stop.

**Standalone:** the auction now runs itself end to end.

### Epic 4: The screens the league lives on

A Manager opening the app lands on what they lead, have been outbid on, and are contending in; can read the whole board unfiltered; can read any Team's cap position; and can see all thirty Teams at once against a League Median — one-handed at 375px, and never shown a stale figure as though it were live. Realizes Key Flow 2.

**FRs covered:** FR-23, FR-25, FR-39

**Also carries:** the Your Positions landing destination, board card anatomy, sorting and filtering, Supabase Realtime, the single global freshness watermark with Live / Reconnecting / Stale, the Teams index and its median line, and §10 example 28.

**Standalone:** the league can read everything the auction knows.

### Epic 5: Nobody loses a player to inattention

Every auction event reaches the league Discord channel, and every Manager affected by one gets an `@mention` that pushes to their phone within 60 seconds. Validates SM-3 — a **primary** success metric with a target of 100%.

**FRs covered:** FR-26, FR-27

**Also carries:** the transactional outbox with its `(event seq, channel, recipient)` idempotency key, explicit `allowed_mentions` on every payload, batching and 429 backoff against the 30 requests/minute webhook ceiling, mute-suppresses-the-mention-not-the-post semantics, and individual mentions for both co-Managers.

**Standalone:** the 24-hour clock stops being a trap.

### Epic 6: Close the books — assignment, export, archive

Every Manager assigns contract lengths against their Year Allotment, and the Commissioner reviews the complete outcome on screen and downloads both Fantrax files, then marks the auction archived. Realizes PRD UJ-4's back half.

**FRs covered:** FR-28, FR-29, FR-30, FR-36, FR-31

**Also carries:** the export gate (salary ceiling, Roster Count exactly 12, every Auction Contract lengthed), winning amount and Cap Hit as distinct exported values, reconciliation between the two exports, and exact integer dollars in every CSV cell.

**Standalone:** the auction's result leaves the app.

### Epic 7: The referee's controls and the record

The Commissioner can void a Bid, adjust Cap Space, terminate an Auction, release a Nomination Slot, extend or expire any Clock, assign a length on a Team's behalf, and pause and resume the whole auction — every act carrying a mandatory free-text reason and a before/after — and any Manager can read the complete append-only Audit Log.

**FRs covered:** FR-32, FR-33, FR-34

**Also carries:** the Commissioner control class separated by **form not colour**, the override reason sheet, League Clock recomputation on a void (prospective only), pause storing remaining duration with a break-glass path independent of Netlify, and the paused banner on every surface.

**Standalone:** rules meet reality, visibly.

### Epic 8: Ready to open — rehearsal, liveness, and restore

The Commissioner can open the auction knowing an outage is survivable rather than decisive: the whole auction has been run once end to end against a compressed clock, a dead tick alerts a sleeping operator, the auction is restorable from outside Supabase, and the recovery procedure is written down.

**FRs covered:** none — realizes CAP-15, CAP-16, CAP-17 and NFR5.

**Also carries:** the time-compressed full rehearsal against a fake 30-Team league with **no code path special-cased for it**, the external heartbeat detector in a third failure domain not routed through Discord, Netlify credit and Supabase invocation burn alerting, the scheduled offsite export of the event log plus the reference data a fold needs, a **rehearsed** restore, and the >15-minute-outage recovery procedure that **blocks auction open** (PRD OQ-9 placed this inside the build epics rather than up front).

**Standalone:** this epic is the gate on opening the auction for real.

### Epic 9: Stand it up and let the league in

The app stops being code and becomes a thing people use: both vendors provisioned, the schema applied dev-first, the league's real data seeded, the Fantrax column maps confirmed against a real export, and a group of league moderators signed in with their own Discord accounts driving a real import and a real auction on the dev project — before thirty people depend on it. Added 2026-09-05 by `sprint-change-proposal-2026-09-05.md`.

**FRs covered:** none new — this epic *executes* FR-1 through FR-27 for the first time against real infrastructure.

**Also carries:** the two-vendor account setup no story owns, the hand-seeded `teams` and `managers` rows that exist because AD-15 ships no admin UI by design, the CSP widening Story 4.1 left blocking, AR-33's real-export confirmation, the setup runbook the repository has never had, and the pilot's findings triaged back into the backlog.

**Standalone:** the difference between an app that passes its tests and an app that works.

### Epic 10: Chase two players with one slot

A Manager can hold one more outstanding Bid than they have room for, and enter as many minimum lotteries as their cap space allows — because the auction has to *finish*, and a league where every Manager is serialised behind their own wins does not. The surplus is taken back automatically: when a win fills the last Slot, the leftover Bid is cancelled and the Auction it was on returns to whoever bid under it.

**FRs covered:** FR-40 (new). Supersedes named clauses in FR-11, FR-14, FR-15, FR-18, FR-20, FR-21, FR-35, FR-37 and FR-39 — see the Coverage Map.

**Also carries:** AR-36 … AR-40 and UX-DR32 … UX-DR38; PRD §10 examples 29–35 as new tests, with 23–25 rewritten and 18–25 re-verified as a block.

**Why one epic and not two.** Every story here edits the same three or four core files — `rules/bidding.ts`, `rules/close.ts`, `projection/auctions.ts` — which is the file-churn pattern the epic-design rules say to consolidate. More decisively, **the allowance and the cancellation are not separately shippable**: an allowance without the cascade lets a Team win a thirteenth player, which is the exact invariant FR-37 exists to protect. Splitting them would create a state where shipping half the epic breaks the product. They go together or not at all.

**Standalone:** it builds on Epics 2 and 3 and requires nothing after it. Story 7.2 (void a Bid) will *consume* the restorer this epic builds, but Epic 10 does not depend on Epic 7 in either direction — 7.2 gets cheaper, not enabled.

**Sequencing:** must land **before** Story 9.7 (moderator pilot) and 9.8 (prod setup day). AD-20 fail-stops `core/` changes during a live Auction Phase, and the pilot exists to measure exactly the property this rule targets — auction speed. Piloting the old rules would be piloting rules the league will not play under.

---

## Epic 1: Setup day — the league's data in, the auction open

The Commissioner can stand up the app, load all thirty-one Fantrax exports, set Minor League Eligibility by hand, and open the auction; every Manager can sign in with Discord and find their Team bound to them. Realizes EXPERIENCE Key Flow 1, whose climax is the moment the app refuses the Commissioner's own import and names the row.

*Every surface in this epic is spec-only with no mock (UX-DR30) — the highest drift risk in the build. Raise a visual reference before building if one turns out to be needed.*

### Story 1.1: Deployable skeleton on the pinned stack

As the Commissioner-builder,
I want a deployable application skeleton on exactly the pinned stack, with the design tokens in place,
So that every story after this one ships to a real URL and looks like one product from the first screen.

**Acceptance Criteria:**

**Given** an empty repository
**When** the project is scaffolded
**Then** it runs SvelteKit **2.70.2** (the 2.x line, not 3.x) with `@sveltejs/adapter-netlify` **6.0.4** configured `edge: false`
**And** TypeScript is strict with `noUncheckedIndexedAccess` enabled
**And** the Node version is pinned to **24 Active LTS**
**And** a build fails if any of these versions drifts from the pinned value

**Given** the scaffolded project
**When** the source tree is inspected
**Then** it matches AR-2 exactly — `src/lib/core/{rules,projection,money.ts,constants.ts,types.ts}`, `src/lib/shell/`, `src/lib/adapters/{fantrax,discord}/`, `src/lib/server/`, `src/routes/`, `supabase/{migrations,functions/tick}/`, `tests/examples/`

**Given** two Supabase projects exist (one freely wipeable dev, one production never touched by hand)
**When** a schema change is required
**Then** it exists only as a migration file committed to the repository and applied dev-first
**And** no schema change is ever typed into the Supabase dashboard
**And** the production project's connection details are server-only environment variables never behind a `PUBLIC_`-prefixed name

**Given** `DESIGN.md`'s frontmatter token set
**When** the global stylesheet is built
**Then** all 20 colour tokens, both type families, the 10-step type scale, the 3px radius, and every named spacing and component dimension are declared as CSS custom properties with the values from `DESIGN.md` verbatim
**And** `font-variant-numeric: tabular-nums` is the default for every numeric context
**And** there is no light-theme declaration of any kind

**Given** the Commissioner surfaces that begin in this epic
**When** the **Commissioner control class** is declared as part of the visual foundation
**Then** it differs from a Manager control by four independent, non-colour properties — **never filled**, a **dashed 1px `admin` border**, its own recessed **`admin-ground`** behind a dashed rule, and a persistent ***"Commissioner · visible only to you"*** label
**And** it is inline and content-width rather than full-width
**And** an automated greyscale check confirms the two remain distinguishable with all colour removed
**And** it is established here because the first Commissioner surface arrives in Story 1.7; the **reason sheet** that every override commits through is a separate concern delivered in Story 7.1

**Given** the deployed skeleton
**When** a Netlify production deploy runs
**Then** the site is reachable over HTTPS
**And** deploy previews and branch deploys are configured against the dev Supabase project and the production branch against prod
**And** the Netlify credit cost of the configuration is recorded, since deploy previews cost 0 and only promotion is metered

### Story 1.2: The pure core boundary and integer money

As the Commissioner-builder,
I want the rules core sealed behind an automated purity check, with money as a branded integer type from the very first line,
So that no rule can ever depend on a clock, a database or a float, and the divergence AD-2 exists to prevent is impossible rather than merely discouraged.

**Acceptance Criteria:**

**Given** `src/lib/core/`
**When** the purity check runs in CI
**Then** it fails if any file under `core/` imports anything outside the TypeScript standard library, references `Date.now()`, `Math.random()`, `fetch`, `process`, a Node built-in, a `$lib` alias, or a bare specifier
**And** it fails if any import inside `core/` omits an explicit `.ts` extension or uses a non-relative path
**And** it fails if the core cannot be resolved and type-checked under Deno

**Given** `core/constants.ts`
**When** it is inspected
**Then** it holds every league constant as a named value — $165,000,000 Salary Cap, $1,000,000 minimum, **one** constant serving both the $500,000 Minimum Increment and the $500,000 granularity, 24 hours, 48 hours, 12 Active/Bench Slots, 2 Injury Reserve, 3 Minor League, and the Year Allotment counts
**And** it holds the single global advisory lock key as one named constant of one fixed arity
**And** it holds `FRESHNESS_WINDOW` and `STALE_WINDOW`
**And** no administrative UI anywhere in the product can edit any of them

**Given** `core/money.ts`
**When** a money value crosses any runtime boundary
**Then** it is parsed explicitly into a branded integer-dollar type at the edge, so that `int8` arriving as a `string` through node-postgres and as a `number` through PostgREST both converge on one type
**And** arithmetic on an unparsed value fails to compile
**And** no float, decimal library, or cents representation exists anywhere in the codebase

**Given** a branded money value
**When** it is rendered for display
**Then** it renders abbreviated as `$14.5M` with **exactly one decimal place, never dropped** — `$12.0M`, not `$12M`
**And** a negative amount uses a true minus sign (U+2212), not a hyphen
**And** a value not sitting on the $500,000 grid causes the renderer to fail loudly rather than round silently
**And** the renderer is reachable from the UI and from Discord payloads and is structurally unable to be called by the CSV export path

### Story 1.3: Sign in with Discord

As a Manager,
I want to sign in with one tap of my Discord account and stay signed in,
So that I can place a bid from a hallway in ninety seconds without ever meeting a password or an email.

**Acceptance Criteria:**

**Given** a Discord account the Commissioner has pre-registered
**When** the Manager signs in via `signInWithOAuth({ provider: 'discord' })`
**Then** a session is established and persists for **at least 30 days**
**And** the Manager's Discord user ID is recorded, because authentication and notification addressing are the same fact captured once

**Given** a Discord account the Commissioner has **not** pre-registered
**When** that account attempts to sign in
**Then** no session is issued
**And** the refusal states only that the Commissioner must add the account
**And** it does **not** disclose whether that Discord identity, or any Team, exists in the league
**And** it offers no retry loop that could be used to probe for membership

**Given** a session that has expired
**When** the Manager returns to the app
**Then** the screen states that the session expired and returns them to the surface they were on
**And** it does not present as a fresh sign-out, because a ≥30-day session makes expiry rare enough to be disorienting

**Given** any sign-in surface
**When** it renders
**Then** it offers a single Discord action and one sentence of explanation
**And** **no email field exists anywhere in the product**, because this system sends no email for any purpose

**Given** Discord is unavailable
**When** the Commissioner needs to reach the pause control
**Then** a Commissioner sign-in path that does not depend on Discord is reachable
**And** it is not advertised on the Manager sign-in screen
**And** it is exercised by an automated test that simulates the Discord provider being down

### Story 1.4: Teams, Managers, and the Commissioner role

As a Manager,
I want to act on behalf of exactly one Team, with my own name attached to everything I do,
So that a co-managed Team can reconstruct who did what, and so that nobody can reassign themselves to another Team.

**Acceptance Criteria:**

**Given** the Manager, Team and Commissioner tables
**When** a request resolves the acting Manager's Team binding and Commissioner flag
**Then** both are read **server-side from application tables written only by the Commissioner**
**And** neither is ever read from JWT app-metadata or any claim the client can influence, because Supabase's `updateUser` makes user metadata self-writable
**And** an automated test asserts that a client-forged metadata claim changes nothing

**Given** a Team with two Managers
**When** either co-Manager views Team state
**Then** both see identical Cap Space, identical Maximum Bid and identical Nomination Slot status
**And** every action either takes records the acting Manager's identity alongside the Team's
**And** public-facing displays render the Team name spelled out with the acting Manager attached — `Lakers — Meakel` — never a three-letter abbreviation, which always and only means a player's real-life NBA team

**Given** a Manager who is not the Commissioner
**When** they request a Commissioner-only route by direct URL, form post, or any other direct request
**Then** the server refuses it
**And** the refusal is server-side authorisation, not a hidden control — hiding UI is never the check
**And** an automated test exercises each Commissioner-only route as a non-Commissioner and asserts refusal

**Given** the Commissioner's own Team
**When** it participates in the auction
**Then** it is subject to every ordinary rule without exception
**And** no Commissioner privilege alters its Cap Space, Maximum Bid or Nomination Slot

### Story 1.5: The append-only log and the transactional write path

As a Manager,
I want every state change in this auction recorded once, in one place, that nobody can edit,
So that when I lose a player by $500k at 4am I can reconstruct exactly what happened rather than take somebody's word for it.

**Acceptance Criteria:**

**Given** the `auction_events` table
**When** database grants are inspected
**Then** no role holds `UPDATE` or `DELETE` on it — **not the service role, and not the Commissioner**
**And** an automated test attempts an update as the service role and asserts it fails
**And** correcting anything is done by appending a compensating event, never by mutating history

**Given** an event being appended
**When** it is written
**Then** it carries a database-assigned monotonic `seq`, an `occurredAt`, a `schemaVersion`, a `coreVersion`, the acting Manager and Team
**And** it carries the measurement fields NFR11 requires — device class on Bid and Nomination events, dispatch and delivery outcome on notification events — **from the first event onward**, because an insert-only log cannot be backfilled

**Given** a set of events and a reference-data snapshot
**When** projections are folded
**Then** the fold is ordered by **`seq`, never by `occurredAt`**, because a transaction queued on the lock commits later while holding an earlier timestamp
**And** projections are written only inside the same transaction that appends the events
**And** a full rebuild from the log is possible at any time and produces identical state
**And** the rebuild is idempotent — replaying a close converges on the same rows rather than duplicating them

**Given** the projection mechanism
**When** it is built here
**Then** it delivers the **fold-and-rebuild machinery only** — individual projection tables are created by the story that first reads them, not upfront
**And** no story creates a table it does not itself need

**Given** any state-mutating transaction
**When** it begins
**Then** it calls `pg_advisory_xact_lock` with the single named constant from `core/constants.ts` **before reading any state**
**And** the lock is transaction-scoped, never session-scoped, so it survives Supavisor transaction-mode pooling
**And** every caller in both runtimes uses that constant verbatim at the same arity, because Postgres' one-argument and two-argument forms occupy disjoint lock spaces and mixing them is a silent total failure
**And** a concurrency test issues two simultaneous mutations and asserts they serialize, producing one success and one clean rejection

**Given** the transactional shell
**When** it processes a command
**Then** it follows lock → load → decide → persist → enqueue in that order
**And** the injected `now` is sourced from the database server's clock at transaction start, never from a client or an application-process clock

### Story 1.6: One destination list, gated by phase and role

As a Manager,
I want to only ever be offered destinations that are actually live right now,
So that the app changing shape between phases is legible rather than a set of controls that quietly stop working.

**Acceptance Criteria:**

**Given** the League phase
**When** it is determined
**Then** it is a **projection folded from the event log**, never a flag anyone sets by hand
**And** with no events yet appended it folds to **Setup**
**And** a Commissioner cannot flip it directly; they append the event that causes it
**And** it obeys the rebuild rule like any other projection

**Given** a request from a signed-in Manager
**When** the surface is rendered
**Then** the phase and the viewer's role resolve **server-side per request** from the same application tables identity is bound to
**And** they produce **one destination list**
**And** that single list is rendered twice — in the persistent strip's sheet and in the header menu — and the two can never offer different sets, because there is only one list

**Given** a destination not live in the current phase or not permitted to the viewer's role
**When** the Manager attempts to reach it
**Then** it is not rendered in either navigation surface
**And** its route **refuses server-side**, independently of the navigation not offering it

**Given** each of the four phases
**When** the destination list is computed
**Then** Setup offers Sign-in, Import, Minor League Eligibility, Manager registration and the auction-open gate
**And** Auction offers Your Positions, Bid Board, Auction, Nominate, Teams, Audit Log and Notification settings, with Commissioner admin destinations added for the Commissioner
**And** Contract Assignment offers Contract Assignment, Teams and Audit Log, with assignment monitoring and the export gate for the Commissioner
**And** Archived offers the frozen Bid Board, Teams, Audit Log and the re-downloadable Export

**Given** any sign-in surface
**When** it renders
**Then** it states which phase the League is currently in, so a Manager arriving during Setup or Archived is not left wondering whether the app is broken
**And** it reads that phase from the same server-resolved source as every other surface

### Story 1.7: Import thirty Team roster files

As the Commissioner,
I want to drop all thirty Fantrax Team roster exports at once and be told precisely what is wrong with which ones,
So that setup day is a morning of fixing named problems rather than an afternoon guessing at a failure count.

**Acceptance Criteria:**

**Given** the Fantrax adapter
**When** the codebase is inspected
**Then** CSV column names, header shapes and Fantrax-specific quirks appear in **exactly one module**, and nothing outside it knows Fantrax exists
**And** rows join on the **stable Fantrax player ID, never on name**
**And** the adapter never derives, infers, or fails on Minor League Eligibility, because the export does not carry it
**And** the core receives parsed domain types and has no notion of a file

**Given** thirty Team roster files supplied as one batch
**When** they are parsed
**Then** each file resolves independently to exactly one of the 30 Teams by name
**And** parsed rows land in **staging tables keyed by Team**, never directly in live reference tables
**And** each Team's Cap Space is computed as `$165,000,000 − Σ(Cap Hits)`, treating Minor League Slot players as $0

**Given** a file that resolves to no Team, or to a Team already supplied
**When** it is processed
**Then** it is refused at **file altitude — naming the file, not a row**

**Given** a file whose contents are invalid
**When** it is processed
**Then** it is refused at **row altitude — naming the offending row** — when a required column is absent, a Team ID does not resolve, a computed Cap Space is negative, or a starting state breaches a slot ceiling of more than 12 Active/Bench, more than 2 Injury Reserve, or more than 3 Minor League players
**And** the two refusal altitudes are visibly distinct in the status list

**Given** the import status surface
**When** it reports progress
**Then** it shows parse status per file across all thirty-one rows
**And** every Team still outstanding is **named, never counted** — "3 files missing" is useless at 11am on setup day
**And** the surface is fully operable at 375px and expands to multiple columns on desktop

**Given** an in-progress import
**When** the browser is refreshed, the tab is closed, or the Commissioner returns an hour later
**Then** per-file parse status has persisted and the import resumes where it was
**And** re-supplying one Team's corrected file replaces **only that Team's staged rows**, leaving the other twenty-nine untouched

### Story 1.8: Import the Free Agent pool

As the Commissioner,
I want to load the Fantrax free agent export as its own source,
So that the set of Players available for Nomination is established without touching the thirty Team files.

**Acceptance Criteria:**

**Given** the Free Agent pool export
**When** it is uploaded
**Then** it stages as a **single distinguished source keyed by pool** — not exempt from staging just because it has no Team
**And** re-supplying it replaces the pool alone, leaving all thirty Team sources untouched

**Given** a parsed pool row
**When** it is staged
**Then** it carries a stable Fantrax player ID, name, position and NBA team
**And** it defaults to **not** Minor League Eligible, because the export does not carry the flag and an unset flag must never grant unbounded bidding by omission

**Given** a Player appearing both in the free agent pool and on a Team's roster
**When** the conflict is detected
**Then** the import is refused, **naming the Player and the Team**

**Given** a successfully staged pool
**When** the Commissioner reviews it
**Then** the imported pool size is reported for explicit confirmation before commit

### Story 1.9: Per-Team preview and atomic promotion

As the Commissioner,
I want to see Roster Count and Cap Space for all thirty Teams before anything commits, and then commit all thirty-one sources at once,
So that a silently wrong cap figure is caught on setup day rather than discovered mid-auction, when it is unrecoverable.

**Acceptance Criteria:**

**Given** all thirty-one sources staged
**When** the Commissioner opens the preview
**Then** it reads from staging and reports **Roster Count and Cap Space for all 30 Teams**
**And** money renders through the `$14.5M` renderer at exactly one decimal
**And** the preview is legible at 375px without lateral scrolling and becomes a genuine table on desktop

**Given** a staged Team whose starting state breaches a slot ceiling
**When** the Commissioner attempts to commit
**Then** the commit is refused and the offending Team is named
**And** the refusal states the arithmetic rather than reporting a bare failure

**Given** a preview the Commissioner confirms
**When** promotion runs
**Then** it is **one transaction covering all thirty-one sources — all-or-nothing**
**And** a partially imported League is never a reachable state
**And** there is no partial commit and no resumable half-promotion

**Given** a committed import
**When** the League is still in Setup
**Then** re-importing is permitted and replaces prior state entirely
**And** once the auction has opened, re-import is **refused**
**And** the import and its outcome are written to the Audit Log with actor and timestamp

**Given** the column mapping in the adapter
**When** the build is prepared for a real setup day
**Then** a real BBSL Fantrax export has been obtained and the salary and roster-slot columns confirmed against it (AR-33)

### Story 1.10: Set Minor League Eligibility by hand

As the Commissioner,
I want to mark which pooled Players can be stashed at a $0 Cap Hit, and be told in words what that means as I do it,
So that the flag carrying the most economic weight in the product is set deliberately rather than clicked through.

**Acceptance Criteria:**

**Given** the imported Free Agent pool
**When** the eligibility screen renders
**Then** every Player defaults to **not** eligible
**And** each row states the Team-facing consequence in words — *"this Player can be stashed at a $0 Cap Hit"* — rather than presenting an unexplained checkbox
**And** the controls carry the Commissioner control class: never filled, dashed border, recessed ground, and a persistent *"Commissioner · visible only to you"* label

**Given** the League is in Setup
**When** the Commissioner sets or unsets the flag
**Then** it can be changed on any pooled Player individually and in bulk
**And** every change is written to the Audit Log with actor, Player, and before and after values

**Given** the auction has opened
**When** the Commissioner attempts to change the flag
**Then** it is **locked** — the controls disable with the reason stated, and a direct request is refused server-side
**And** the screen states that changing it after open requires a Commissioner override, because the change alters cap arithmetic under FR-35 for every open Auction on that Player
**And** the override path itself is **not built here** — it is delivered in Story 7.3 through the reason sheet of Story 7.1, so this story has no dependency on either

**Given** eligibility is mutable reference data that cap arithmetic folds against
**When** a change is made
**Then** it is recorded as an **event**, not merely as a column update
**And** a projection rebuild reproduces the flag as it stood at each point in the log, not as it is now

### Story 1.11: Open the auction

As the Commissioner,
I want a gate that refuses to open the auction until everything it needs is genuinely present, naming whatever is missing,
So that thirty managers waiting on a 12:00pm start are never let into a half-configured auction.

**Acceptance Criteria:**

**Given** the auction-open gate
**When** the Commissioner attempts to open
**Then** it refuses unless the pool import and **all thirty** Team imports are promoted and every Team has at least one bound Manager
**And** anything outstanding is **named**, never counted

**Given** the gate's pre-open report
**When** it renders
**Then** it reports the count of Players marked Minor League Eligible for explicit Commissioner confirmation
**And** it does **not** block on that count, because nothing external defines completeness and the default of *not* eligible is the safe direction

**Given** a gate that passes and a Commissioner who confirms
**When** the auction opens
**Then** an `AuctionOpened` event is appended, carrying actor, timestamp, `schemaVersion` and `coreVersion`
**And** all 30 Teams receive an unused Nomination Slot
**And** the League Clock starts at 48 hours
**And** the phase projection folds to **Auction**, and the destination list changes accordingly for every Manager without anyone setting a flag

**Given** the auction has just opened
**When** a Manager arrives
**Then** the Bid Board is empty, and that is a designed screen — it explains the state and points at Nominate
**And** every Manager is notified that the auction has opened

---

## Epic 2: Nominate and bid — the engine and the refusal

A Manager can put a Free Agent on the board and bid on him, with Maximum Bid always visible and broken into its components, and an illegal Bid refused at submission — both gates reported, arithmetic that visibly sums. Realizes EXPERIENCE Key Flow 3, and PRD UJ-1 and UJ-3.

*Auctions do not close in this epic. That is deliberate: nothing here depends on Epic 3, and the Nomination Slot fold in Story 2.3 is written so that Epic 3's closes require no rework.*

### Story 2.1: Nominate a Free Agent

As a Manager,
I want to put any Free Agent on the Bid Board without committing to bid on him,
So that I can shake loose a rival's cap space by making them defend a player I do not actually want.

**Acceptance Criteria:**

**Given** a Manager whose Team's Nomination Slot is unused, during the Auction Phase
**When** they nominate a Free Agent
**Then** the Player appears on the Bid Board in **Awaiting Opening Bid** state with **no Auction Clock running**
**And** the Team's Nomination Slot is marked used and shows which Player holds it
**And** a `NominationPlaced` event is appended carrying acting Manager, Team, Player, timestamp and **device class** (NFR11 — captured from the first event, never backfillable)

**Given** a nomination is accepted
**When** the Team's cap position is recomputed
**Then** **no cap space is committed** and the nominating Team is **not** made Leading Bidder
**And** a Team may nominate a Player it could not afford to bid on

**Given** a nomination is accepted
**When** the League Clock is folded
**Then** it resets to 48 hours from that Nomination

**Given** the nomination command
**When** it is processed
**Then** it runs through the transactional shell — lock → load → decide → persist — taking the global advisory lock before reading any state
**And** the rule lives in `core/rules/nomination` and reads no clock, no database and no random source

**Given** the Nominate surface
**When** it renders
**Then** it is operable one-handed at 375px
**And** nomination is a **two-part act** — select, then confirm — never a single tap
**And** it offers no suggested player, no ranking, and no "similar players" affordance

### Story 2.2: Nomination refusals and concurrency

As a Manager,
I want an invalid nomination refused before it happens, with the actual reason named,
So that I am never left guessing why the app said no.

**Acceptance Criteria:**

**Given** a Team whose Nomination Slot is already in use
**When** that Team attempts a Nomination
**Then** it is refused, **naming the Player currently holding the Slot**

**Given** a Player already on the Bid Board, already won in this auction, or under Contract to any Team
**When** a Manager attempts to nominate him
**Then** it is refused with that specific reason stated

**Given** the League is not in Auction Phase
**When** a Nomination is attempted
**Then** it is refused with the phase stated as the reason
**And** the Nominate route also refuses server-side under the phase gate, independently of the rule

**Given** two Managers nominating the **same Player** concurrently
**When** both requests land
**Then** exactly **one** Nomination results
**And** uniqueness is enforced **at the data layer**, not by a prior read that admits a check-then-write gap
**And** the loser is told the Player is already on the board
**And** an automated concurrency test asserts this

**Given** any refusal in this story
**When** it renders
**Then** it states the fact and then the reason, with no exclamation marks and no apology
**And** it reassures that nothing was committed and the board is unchanged

### Story 2.3: Nomination Slot lifecycle and dead-nomination visibility

As a Manager who nominated a player nobody has bid on,
I want to be told plainly that my Slot is stuck and will stay stuck,
So that the consequence of the rules as written is something I saw coming rather than something I discovered.

**Acceptance Criteria:**

**Given** the event log
**When** a Team's Nomination Slot status is computed
**Then** it is a **fold over the log** — the Slot is held while the Player it nominated has an open Auction — never a stored flag toggled by a handler
**And** the fold releases the Slot on an `AuctionClosed` event for that Player **regardless of which Team won and regardless of whether the nominating Team ever bid**
**And** the Slot is released at Auction Close and **not before** — not when the nominating Team is outbid, and on no timer of its own
**And** an automated test appends a synthetic `AuctionClosed` and asserts the Slot frees, so Epic 3 requires no change here

**Given** an Auction in Awaiting Opening Bid for more than 24 hours
**When** the Bid Board renders it
**Then** it is visually flagged as having attracted no bids, carrying a **word and a shape**, never colour alone
**And** the flag is **derived on read** from the Nomination timestamp against server time, requiring no scheduled job

**Given** the nominating Team's own view
**When** it renders that Auction
**Then** it states plainly that this Nomination is holding their Slot and will continue to until someone bids
**And** the public board shows the nominating Team and the hours unbid, so a dead Slot is visible to the whole league

**Given** an unbid Nomination
**When** any amount of time passes
**Then** **no automatic expiry, withdrawal, or return-to-pool occurs**
**And** the only path to clearing it is a Commissioner override

### Story 2.4: The Auction page and its bid control

As a Manager,
I want a single page showing an Auction's complete history and a bid control that already knows what I am allowed to do,
So that I can act in ninety seconds standing in a hallway without deriving anything.

**Acceptance Criteria:**

**Given** any open Auction
**When** a Manager opens its page
**Then** it shows Player identity, current price, Leading Bidder, Auction state and time remaining
**And** the player metadata line reads `NBA · POS · $0.0M · Nyr`, carrying real-life team, position, existing salary and contract length
**And** a three-letter capitalised abbreviation means the player's **real-life NBA team and nothing else**; the fantasy Team is spelled out with the acting Manager attached — `Lakers — Meakel`
**And** time is shown **twice** — relative ("4h 12m left") and absolute in the viewer's own timezone ("closes 2:14 AM Wed") — with the absolute time never omitted to save space

**Given** the Auction page
**When** the bid history renders
**Then** it lists every Bid in chronological order with Team name, **acting Manager name**, amount and timestamp
**And** it is visible to all Managers with **no anonymity at any point**

**Given** the bid control
**When** it renders for a Manager whose Team may bid
**Then** the input is 46px tall on `surface-sunken`, bounded by `border-interactive`, pre-filled with the **minimum legal Bid**
**And** the submit button sits beside it at the same height
**And** submission is a **deliberate two-part act** — enter an amount, then confirm — never a one-tap raise
**And** no suggested amount, no recommended bid, and no countdown pressure appears anywhere on the page

**Given** a Manager whose Team cannot bid on this Auction
**When** the page renders
**Then** both control and button are disabled **with the reason stated in words beneath them**, never discovered at submission
**And** the reason is worded distinctly for each cause, because "you are already leading", "you have no money" and "you have no roster slot" call for different responses

**Given** an accepted Bid
**When** the Manager looks for a way to change it
**Then** **no control to cancel, edit or lower it exists — absent, not disabled**
**And** the only path to reversing one is a Commissioner override, which is out of scope here

**Given** the Auction page at 375px
**When** it renders
**Then** it is single-column and fully operable one-handed
**And** touch targets on every bidding control are ≥44×44px
**And** a greyscale screenshot of the page remains fully readable

### Story 2.5: Place a Bid — increment, granularity, and the 24-hour clock

As a Manager,
I want my bid checked against the auction's rules the instant I submit it,
So that an illegal amount never appears on the board for everyone to see and then get reversed.

**Acceptance Criteria:**

**Given** `core/rules/bidding`
**When** the bidding rules are implemented
**Then** the core exposes exactly two rules entry points — `evaluate(state, command, now) → GateResults`, total and never refusing to answer, and `decide(state, command, now, seed) → Accepted<Event[]> | Rejected<GateResults>`
**And** `decide()` obtains its gate outcomes by **calling `evaluate()`**, never by re-deriving them
**And** the gate set is **fixed per command type**, declared in `core/types.ts`, so a `PlaceBid` result always carries every gate whether or not each passed
**And** a rule violation is a **returned `Rejected` value**, never a thrown exception
**And** iteration over any collection affecting an outcome is over an explicitly sorted sequence

**Given** an Auction in Standard Contention at a current high Bid
**When** a Manager submits a Bid
**Then** it is valid only if it is at least `current high + $500,000`
**And** it is valid only if it is a **whole multiple of $500,000**
**And** both checks are implemented separately even though they coincide here, because the granularity check is what catches an off-grid amount in Minimum-Bid Contention where the increment rule does not apply
**And** §10 example 1 (a $8.5M raise over $8.0M is valid) and example 2 (a $8.4M bid is refused on **both** grounds) pass as named tests calling the core directly

**Given** a Bid at or below the current high Bid
**When** it is submitted
**Then** it is refused

**Given** a Team already holding the leading Bid on an Auction
**When** either of its Managers attempts to bid
**Then** the control is disabled and a direct submission is refused — a Team cannot bid against itself

**Given** a valid Bid in Standard Contention
**When** it is accepted
**Then** the Auction Clock is set to **exactly 24 hours from that Bid's timestamp**
**And** the Clock runs continuously with no pause, freeze window or business-hours adjustment
**And** the server persists an **absolute close timestamp**; the client renders a countdown from it and never receives "seconds remaining"
**And** the League Clock resets to 48 hours
**And** a `BidPlaced` event is appended with Team, acting Manager, amount, timestamp and **device class**

**Given** both Managers of one co-managed Team submitting a Bid on the same Auction within the same second
**When** both land
**Then** exactly one is accepted and the other is refused because the price moved
**And** the Audit Log names which Manager placed the accepted Bid
**And** §10 example 15 passes as a named test

**Given** an off-grid amount
**When** it is submitted in any contention state
**Then** it is refused — §10 example 26 passes, covering both a $6,750,000 bid that clears the increment and a $1,000,001 bid in a lottery

### Story 2.6: The money gate and the refusal panel

As a Manager,
I want to see exactly what I can afford right now, and to be shown the arithmetic when I am refused,
So that I put the phone down annoyed at myself rather than suspicious of the rival manager who built this app.

**Acceptance Criteria:**

**Given** a Team's committed state
**When** its money figures are computed
**Then** `Committed Bids` = its leading amounts on open Standard Contention Auctions for non-eligible Players, plus $1,000,000 per Contender position in a non-eligible Minimum-Bid Contention, plus Minors Exposure
**And** `Available Cap Space` = `Cap Space − Committed Bids`
**And** `Roster Reserve` = `$1,000,000 × max(0, 12 − (Roster Count + Projected Active/Bench Additions))`
**And** `Maximum Bid` = `Available Cap Space − Roster Reserve` for a non-eligible Player
**And** the `max(0, …)` clamp is **kept** even though the FR-37 ceiling makes it unreachable in ordinary play, because a Commissioner override can still produce a Team above 12

**Given** any of these figures
**When** they are computed
**Then** they are derived by the core from **committed state at validation time**, on every evaluation
**And** they are **never persisted on a Team row, never memoised across transactions, and never cached client-side for validation**
**And** they are evaluated against the **hypothetical state that would exist if the prospective Bid were accepted** — Projected Active/Bench Additions counts the bid being placed

**Given** a Team leading nothing, with $12,000,000 Cap Space and Roster Count 9, bidding on a non-eligible Player
**When** Maximum Bid is computed
**Then** Projected Active/Bench Additions is 1, Roster Reserve is $2,000,000, and Maximum Bid is $10,000,000
**And** §10 examples 3, 4, 5 and 23 pass as named tests calling the core directly

**Given** capital movement
**When** a Team becomes Leading Bidder
**Then** its leading amount joins Committed Bids
**And** the instant it ceases to be Leading Bidder, that capital is **released immediately** — not at close, not on a sweep
**And** the previous Leading Bidder is marked outbid for notification

**Given** a Manager viewing an Auction
**When** Maximum Bid is displayed
**Then** it is shown **with its components broken out** — Cap Space, Committed Bids, Minors Exposure, Roster Reserve — never as a bare number
**And** the breakdown **visibly sums** as displayed, which the $500,000 grid makes possible at one decimal
**And** it is produced by the **read path calling `evaluate()` directly** — the same function `decide()` calls — so a control that says a bid is impossible and a refusal that explains why cannot disagree
**And** it recomputes within **one second** of any Bid, Auction Close or override

**Given** a Bid exceeding the bidding Team's Maximum Bid
**When** it is submitted
**Then** it is refused **before it enters the Auction** — it never appears on the Bid Board or in the Audit Log as a valid Bid
**And** validation runs **server-side against committed state at the moment of submission**, not against state the client held at page render
**And** a Bid valid when composed but invalid on arrival is refused **with the current figures shown**

**Given** a refusal
**When** the refusal panel renders
**Then** it is a `surface` panel with a **3px top accent bar in `attention`** — the only top bar in the system, so a refusal is identifiable before a word is read
**And** it presents, in order: a Georgia 19px headline ("This bid was not placed."), the delta in one sentence, reassurance that nothing was committed and the Auction is unchanged, the gate report, the full timestamped arithmetic, and the disabled bid control with its reason
**And** the arithmetic is never hidden behind a disclosure
**And** the refusal is **announced to assistive technology as it appears**, not merely rendered
**And** no red is used anywhere — `attention` amber is the only attention colour, and it marks Outbid and refusal and nothing else

### Story 2.7: The slots gate — Roster Capacity, and both gates always reported

As a Manager with a full roster and money to burn,
I want to be told on the board that I have no slot, in different words from being told I have no money,
So that I understand the remedy is a different one and do not spend the auction thinking the app miscounted my cap.

**Acceptance Criteria:**

**Given** a prospective Bid
**When** Roster Capacity is evaluated
**Then** it refuses when `Roster Count + Projected Active/Bench Additions > 12`, computed **as though the prospective Bid were already placed** — the same post-bid basis Roster Reserve uses
**And** it is a **second, independent refusal ground alongside Maximum Bid**: a Team can fail it with unlimited cap space and pass it with none, and neither check subsumes the other

**Given** any Bid
**When** it is evaluated
**Then** **both** the money gate and the slots gate run, and **neither short-circuits the other**
**And** `evaluate()` returns both outcomes with their own arithmetic whether or not the first passed
**And** the two carry **distinct machine-readable reasons** — reporting a capacity refusal as a cap refusal is a defect

**Given** a refusal on either ground
**When** the refusal panel renders
**Then** it reports **both gates, always** — the refusing gate as a filled `attention` chip with `attention-ink`, the passing gate as an outlined `border-interactive` chip with `text-secondary`, chip left and sentence right, top-aligned
**And** neither is collapsed behind a disclosure
**And** the passing gate carries its figure — e.g. *"Slots · Passed — Roster Count would be 10 of 12"* — proving every check ran and this is the only obstacle
**And** the filled-versus-outlined contrast survives greyscale, which a colour difference alone would not

**Given** a Team at Roster Count 12 with $40,000,000 of Cap Space
**When** it bids $5,000,000 on a non-eligible Player
**Then** the Bid is **refused on capacity**, stating Roster Count, Projected Active/Bench Additions and the ceiling of 12 — not a cap figure
**And** §10 example 24 passes as a named test

**Given** a Team that reaches Roster Count 12
**When** the Bid Board renders
**Then** its bidding controls are **disabled on every non-eligible Auction with the reason stated on the board**, not discovered at submission
**And** this holds when the state is reachable straight from import, so it is announced rather than found

**Given** slot ceilings
**When** they are enforced
**Then** they hold on import as well as on bid — a starting state above 12 Active/Bench, 2 Injury Reserve or 3 Minor League players is already refused by Story 1.7

### Story 2.8: Minors Exposure — unbounded eligible bidding bounded by overflow

As a Manager two million under the cap,
I want to bid thirty million on a stashable rookie and be told "no cap limit" rather than shown a suspicious number,
So that the rule that looks most like a bug is the one the app is most explicit about.

**Acceptance Criteria:**

**Given** a Minor League Eligible Player and a Team with a Free Minor League Slot to absorb him
**When** Maximum Bid is evaluated (`N + 1 ≤ M`, counting the prospective bid)
**Then** Maximum Bid is **unbounded**, and the Auction page says so **in words — "no cap limit"** — rather than displaying a number
**And** the bid control accepts a free-entry amount
**And** the app neither refuses nor warns about the bid on cap grounds
**And** the breakdown explains **why** — a Free Minor League Slot can absorb this Player at a $0 Cap Hit

**Given** a Team's eligible positions
**When** exposure is computed
**Then** `Free Minor League Slots (M)` = `3 − currently occupied`
**And** `Eligible Leading Bids (N)` = its leading amounts on open eligible Auctions, including $1,000,000 for each open Minimum-Bid Contention on an eligible Player it is a Contender in
**And** `Overflow Count` = `max(0, N − M)`
**And** `Minors Exposure` = the sum of the **Overflow Count largest** Eligible Leading Bids, zero when `N ≤ M`
**And** the worst case is sized to the *largest* surplus bids, because Slot Placement follows close order and no bidder can steer which of its wins overflows

**Given** exposure is a function of the *set* of eligible Auctions a Team leads
**When** any of those change
**Then** exposure is **derived from committed state at validation time and never cached on the Team record**
**And** a later cheap eligible bid can be refused because it pushes the Team into Overflow and exposes an earlier expensive one
**And** the app refuses the **new** bid and **never retroactively invalidates an accepted one**
**And** the refusal **names the specific earlier eligible Auction creating the exposure**

**Given** a Minimum-Bid Contention on a Minor League Eligible Player
**When** capital is committed
**Then** it contributes an **Eligible Leading Bid of $1,000,000** feeding Minors Exposure — **not** the flat $1,000,000 commitment, which applies only to contentions on non-eligible Players
**And** it therefore commits nothing while the Team has a Free Minor League Slot to absorb the win

**Given** the worked cases
**When** the test suite runs
**Then** §10 examples 18, 19 and 20 pass as named tests calling the core directly, each a `PlaceBid` against a state literal
**And** example 19 confirms money is the refusal ground while capacity passes at `11 + 1`
**And** example 20 confirms an *open* leading bid creates exposure at full price while a *closed* one creates none
**And** examples 16, 17, 21 and 22 are **not** owned here — 16 and 17 are `CloseAuction` commands and 21 and 22 require Minimum-Bid Contention to exist, so all four land in Epic 3

**Given** an eligible Bid that would create Overflow with nowhere to land
**When** Roster Capacity is evaluated
**Then** it is **refused on capacity** — there is **no carve-out** for automatic Slot Placement
**And** the refusal names the overflow, exactly as an exposure refusal does
**And** §10 example 25 passes, covering a Team at Roster Count 12 that may stash three eligible Players and is refused on the fourth

**Given** activation
**When** any part of this epic is implemented
**Then** the app **never models it, never warns about it, and never blocks a Bid on account of it** — moving a stashed Player to Active/Bench is enforced in Fantrax, not here

---

## Epic 3: The auction resolves itself — lottery, close, and phase end

Auctions close within 60 seconds of expiry with nobody watching, the $1,000,000 lottery draws a winner any losing Manager can reproduce, and the auction ends itself after 48 hours of league silence. Realizes EXPERIENCE Key Flows 4 and 5, and PRD UJ-2.

### Story 3.1: Expiry is authoritative for validation

As a Manager,
I want an Auction that has run out of time to stop accepting bids the instant it runs out,
So that a slow sweep can only ever make a close *late*, never *wrong*.

**Acceptance Criteria:**

**Given** an Auction whose persisted absolute close time has passed
**When** a Bid arrives, whether or not the sweep has yet recorded the close
**Then** the Bid is **refused as expired** — it is never accepted and later reversed
**And** the refusal is worded distinctly from a cap refusal and a capacity refusal

**Given** validation of any Bid
**When** the Auction's open/closed status is determined
**Then** it compares the injected `now` against the **persisted absolute close time**
**And** it **never reads a projection's "open" flag as authority**, because a projection can lag a stalled sweep

**Given** a client in any connection state, including Stale
**When** an Auction it is displaying passes its close time
**Then** the Auction displays as expired and its bid control is disabled
**And** this holds whether or not the client has received any update, because the countdown derives from an absolute close time the client already holds

**Given** a sweep that stalls for an extended period
**When** it eventually runs
**Then** every affected Auction closes late with the outcome an on-time sweep would have produced
**And** no Bid placed after nominal expiry has been accepted in the interim

### Story 3.2: Enter and join a Minimum-Bid Contention

As a Manager who needs bodies at the minimum,
I want a $1,000,000 opening to become a lottery I can join, with the clock visibly frozen,
So that I understand I am buying a ticket rather than leading an auction, before I misplay it.

**Acceptance Criteria:**

**Given** an Auction in Awaiting Opening Bid
**When** an Opening Bid of **exactly $1,000,000** is placed
**Then** the Auction enters **Minimum-Bid Contention**
**And** the Auction Clock is set to 24 hours from that Opening Bid and is **thereafter fixed**
**And** the opening bidder is recorded as the first Contender
**And** §10 example 6 passes as a named test

**Given** an Opening Bid **above** $1,000,000
**When** it is placed
**Then** the Auction enters **Standard Contention** under the ordinary rules of Story 2.5

**Given** a Minimum-Bid Contention opening
**When** the contention is created
**Then** a **seed is generated and stored in a table readable by no client-facing role**
**And** only `hash(seed)` is published to the Auction page, the Audit Log and the notification payload
**And** an automated test asserts that every manager-facing role, **including the Commissioner's**, is denied read access to the seed table before the draw

**Given** an open Minimum-Bid Contention
**When** a Manager bids **exactly $1,000,000**
**Then** the Team joins the Contender list
**And** the Auction Clock is **not reset, extended, or otherwise altered**
**And** the League Clock **does** reset to 48 hours
**And** a Team already a Contender cannot join twice
**And** §10 example 7 passes — three joins across a day leave the close time untouched

**Given** a join on a Player who is **not** Minor League Eligible
**When** capital is committed
**Then** $1,000,000 is added to the Team's Committed Bids, because any Contender may win

**Given** a join on a Player who **is** Minor League Eligible
**When** capital is committed
**Then** the $1,000,000 becomes an **Eligible Leading Bid** feeding Minors Exposure, and commits nothing while a Free Minor League Slot can absorb the win
**And** §10 example 21 passes — a Team with $0 Available Cap Space and three free Minor League Slots may join
**And** §10 example 22 passes — the same Team already leading three eligible Auctions against three slots is **refused**, naming the $5,000,000 Auction

**Given** a Bid strictly between $1,000,000 and $1,500,000
**When** it is submitted into a Minimum-Bid Contention
**Then** it is refused as **neither a valid lottery entry nor a valid ascending Bid**
**And** §10 example 10 passes, noting that under $500,000 granularity the dead zone contains no grid-valid amount at all, so it is reachable only by an off-grid submission

**Given** an Auction in Minimum-Bid Contention
**When** it renders on the board and on its own page
**Then** it carries the `lottery` 3px left accent bar, an icon **and** a word — never colour alone
**And** it shows the **live Contender list** and the Contender count
**And** it states **in words, not iconography**, that the clock will not reset on a join
**And** this completes the clause carried over from FR-24 in Story 2.4

### Story 3.3: Dissolve a Minimum-Bid Contention

As a Manager willing to pay above the minimum,
I want a $1,500,000 bid to end the lottery and return the auction to ordinary rules,
So that a player I actually want cannot be taken from me by a coin flip.

**Acceptance Criteria:**

**Given** an open Minimum-Bid Contention with any number of Contenders
**When** a Bid of **$1,500,000 or more** is placed
**Then** the Auction converts to **Standard Contention**
**And** the Contender list is discarded and **every Contender's $1,000,000 commitment is released immediately**
**And** the Auction Clock is **reset to 24 hours from the converting Bid**
**And** the converting Team becomes Leading Bidder and all ordinary rules apply from that point, including the $500,000 Minimum Increment
**And** §10 example 9 passes — the next valid bid after a $1,500,000 conversion is $2,000,000

**Given** conversion
**When** it occurs
**Then** it happens **regardless of Contender count** — one Contender or twenty, the result is identical
**And** a Team that was itself a Contender may be the converting bidder

**Given** a contention that dissolves and therefore never draws
**When** it converts
**Then** its **seed is revealed at dissolution**, so no unopened commitment is left behind

**Given** dissolution
**When** it completes
**Then** every former Contender is notified that the lottery dissolved and the auction is now ascending
**And** a `ContentionDissolved` event is appended

### Story 3.4: Close an Auction and place the Player

As a Manager who won a player overnight,
I want him on my roster in the right slot at the right cap hit the moment the clock expires,
So that my next bid is computed against what I actually own.

**Acceptance Criteria:**

**Given** an Auction reaching its close
**When** the winner is determined
**Then** in Standard Contention the Leading Bidder wins at their bid amount
**And** in Minimum-Bid Contention the drawn Contender wins at $1,000,000

**Given** a winning Team
**When** the Contract is written
**Then** it records the **winning amount** and the **Cap Hit** as **separate persisted fields**
**And** no code path derives one from the other by assuming equality
**And** contract length is recorded as unset

**Given** Slot Placement
**When** it is applied
**Then** a Minor League Eligible Player takes a free Minor League Slot if one exists, and an Active/Bench Slot otherwise
**And** every Player who is not Minor League Eligible takes an Active/Bench Slot
**And** **no Manager or Commissioner choice is involved**
**And** the Cap Hit recorded is the winning amount for an Active/Bench placement and **$0** for a Minor League placement
**And** the winning Team's Roster Count increases by one **only if** the placement was Active/Bench
**And** §10 example 16 passes — a $4,000,000 eligible win takes the third minor slot at $0 with Roster Count unchanged
**And** §10 example 17 passes — the next eligible win, with all three slots occupied, takes Active/Bench at a $3,000,000 Cap Hit and increments Roster Count

**Given** a close
**When** downstream state is folded
**Then** the Player is removed from the Bid Board and from the Free Agent pool
**And** any Minors Exposure the Team was carrying **for this Auction** is released and exposure is recomputed across its remaining eligible bids
**And** the nominating Team's Nomination Slot releases through the fold built in Story 2.3, with no new handler
**And** the **League Clock is not reset** by the close

**Given** a close
**When** it is recorded
**Then** an `AuctionClosed` event is appended carrying winner, price, placement and the full bid history reference
**And** the outcome is written to the Audit Log

### Story 3.5: The tick — one cron, one function, sweep then drain

As a Manager asleep in Melbourne,
I want auctions to close on time without anyone watching,
So that a deploy, a restart or a quiet 4am cannot silently extend an auction and change who wins.

**Acceptance Criteria:**

**Given** the scheduled work
**When** it is configured
**Then** a **single** Supabase Cron schedule invokes a **single** Deno Edge Function that performs the close sweep and **then** drains the outbox
**And** it runs at a sub-minute interval chosen against remaining free-tier headroom, not against the SLA alone — two 10-second schedules would be ~518K invocations/month against a 500K org-wide cap, one combined tick is ~259K
**And** it **never runs on Netlify** and holds no in-memory timer
**And** the dev project's schedule is **disabled by default** and enabled only for a rehearsal

**Given** a sweep pass
**When** overdue Auctions are found
**Then** they are found by **re-deriving what has expired**, never by remembering what is pending, so the sweep is restart-safe by construction
**And** they are closed **one at a time, in ascending nominal expiry time, ties broken by auction id**
**And** each close's effect on slot occupancy, Roster Count, Cap Hit and Minors Exposure is committed to the state the **next** close is evaluated against
**And** folding an overdue set against one loaded snapshot fails an automated test — a batch sweep must never place four eligible Players into three Minor League Slots

**Given** a close being decided inside a sweep
**When** `now` is supplied to the core
**Then** it is **that Auction's own nominal expiry**, not the sweep's wall time
**And** a sweep running late produces exactly the outcome an on-time sweep would have

**Given** the tick
**When** it runs
**Then** it takes the global advisory lock before reading state, using the same named constant at the same arity as every Node caller
**And** it writes a **heartbeat row** on every pass
**And** an Auction closes within **60 seconds** of its nominal expiry with no user present
**And** an automated test forces a process restart mid-sweep and asserts no close is missed or duplicated

**Given** the Node deployment and the Deno deployment
**When** their `coreVersion` values differ
**Then** the tick **refuses to run and alerts** rather than proceeding
**And** any deploy touching `core/` during a live Auction Phase requires a pause, a green §10 suite, and a recorded reason

### Story 3.6: Draw a Minimum-Bid Contention winner

As a Manager who just lost a $1,000,000 coin flip at 4am,
I want the seed, the ordered contender list and the selection handed to me,
So that I can check the draw myself and be annoyed rather than suspicious.

**Acceptance Criteria:**

**Given** a Minimum-Bid Contention reaching Clock expiry
**When** the tick closes it
**Then** the winner is drawn **uniformly at random from the Contender list**, every Contender having probability `1/n`
**And** the seed is supplied to the core as an **argument** — the core reads no random source
**And** a single-Contender lottery resolves to that Contender without ambiguity, recorded with a one-team list
**And** §10 examples 8 and 11 pass as named tests

**Given** the draw
**When** it is recorded
**Then** the **seed is revealed** and appended to the event log alongside the **ordered Contender list as it stood at expiry** and the **selection**
**And** all three are permanently visible on the closed Auction and in the Audit Log
**And** **Contender order is pinned to ascending join `seq`**, because it is an input to the winner

**Given** the recorded seed and Contender list
**When** a Manager attempts to verify the result
**Then** the seed→winner derivation is a **documented, deterministic procedure** they can run by hand or in a spreadsheet
**And** the documentation ships with the app rather than living only in a commit message — a seed nobody can apply is theatre

**Given** the draw completes
**When** capital is settled
**Then** every losing Contender's committed capital is released at the draw
**And** the winner holds an Auction Contract at $1,000,000, subject to the Slot Placement rules of Story 3.4

### Story 3.7: The League Clock and the end of the Auction Phase

As the Commissioner,
I want the auction to end itself after 48 hours of league silence,
So that closing the books is something the app decides rather than something I have to adjudicate.

**Acceptance Criteria:**

**Given** the event log
**When** the League Clock is computed
**Then** it is a **fold — 48 hours from the latest surviving reset event — never a stored countdown**
**And** it is reset by **exactly two event types**: a Nomination, and an accepted Bid including a lottery join
**And** it is **not** reset by an Auction Close, a Randomizer draw, a contention dissolution, a bid void, an override, or a pause/resume
**And** a new event type defaults to **not** resetting it; extending the set requires changing AD-22
**And** §10 example 13 passes — an Auction closing at 12:00 Saturday does not reset a clock last reset at 12:00 Friday

**Given** a `BidVoided` compensating event matching an earlier `BidPlaced`
**When** the fold runs
**Then** it treats that bid as a **non-reset**, rather than expecting the original event to be gone — the log is insert-only and the `BidPlaced` still exists
**And** the League Clock recomputes **shorter**
**And** §10 example 27 passes as a named test against a state literal containing both events, so Epic 7 need only append the void

**Given** a recomputation that lands the League Clock's expiry in the past
**When** the next clock evaluation runs
**Then** the Auction Phase ends **at that evaluation, prospectively only**
**And** nothing accepted between the recomputed expiry and the void is invalidated — a void produces a *sooner* phase end, never a rewritten history

**Given** the League Clock expires
**When** the tick evaluates it
**Then** Nomination and bidding are **disabled league-wide**
**And** any Auction still in **Awaiting Opening Bid** is terminated with no winner and its Player returns to the Free Agent pool unclaimed
**And** the phase projection folds to **Contract Assignment**, changing the destination list for every Manager without anyone setting a flag
**And** all Managers are notified

**Given** the phase transition
**When** Managers next open the app
**Then** the change is **announced in the app**, not merely reflected by controls quietly ceasing to work
**And** the Bid Board is frozen and readable
**And** the phase projection is the single source every surface reads to change shape, so no surface built later needs its own transition logic

---

## Epic 4: The screens the league lives on

A Manager opening the app lands on what they lead, have been outbid on, and are contending in; can read the whole board unfiltered; can read any Team's cap position; and can see all thirty Teams at once against a League Median — one-handed at 375px, and never shown a stale figure as though it were live. Realizes EXPERIENCE Key Flow 2.

### Story 4.1: Live updates and the freshness contract

As a Manager,
I want the app to tell me when it can no longer promise a figure is current,
So that I never read $14.0M, believe it, and bid against a number that moved twenty minutes ago.

**Acceptance Criteria:**

**Given** any projection read
**When** it is served
**Then** it carries a **single global watermark — the highest event `seq` folded — read from one source**
**And** it is **not** a per-table stamp, because the board and the Maximum Bid strip must never report different ages

**Given** the client
**When** it derives its freshness state
**Then** it produces exactly one of three states from **connection status and a positive liveness check together**
**And** **Live** requires the channel `SUBSCRIBED` *and* a liveness check succeeding within `FRESHNESS_WINDOW`
**And** **Reconnecting** follows a `CHANNEL_ERROR`, `TIMED_OUT` or `CLOSED`, or one lapsed liveness check
**And** **Stale** follows no successful liveness check within `STALE_WINDOW`
**And** both windows are named constants in `core/constants.ts`, never per-caller guesses

**Given** a genuinely quiet auction with no events for hours
**When** the liveness check keeps succeeding
**Then** the client remains **Live**
**And** an automated test asserts that **silence alone can never produce Stale** — the question is *"can I still reach the server?"*, never *"has anything changed?"*
**And** liveness is an explicit lightweight periodic re-read of the watermark, not the absence of pushed messages

**Given** a channel reporting `SUBSCRIBED` while delivering nothing
**When** the liveness check lapses
**Then** the client still degrades out of Live, because connection status alone is insufficient in that direction too

**Given** the **Reconnecting** state
**When** money is displayed
**Then** every figure **carries its age** ("as of 2 minutes ago")

**Given** the **Stale** state
**When** the surface renders
**Then** **bid and Nomination controls disable with the reason stated**, exactly as any other unavailable-control case
**And** Maximum Bid renders as a **last-known figure, explicitly labelled**, never as a current one
**And** the transition into Stale is **announced, not merely rendered** — a Manager who set the phone down must not have to notice a subtle label

**Given** any non-Live state
**When** countdowns render
**Then** they **continue running**, because they derive from absolute close timestamps the client already holds
**And** freezing them on disconnect would invent a problem that does not exist

**Given** recovery
**When** the client returns to Live
**Then** controls are restored **silently and immediately**, with no dialog — no one needs congratulating for a network

**Given** the performance floors
**When** they are measured
**Then** a board change is reflected within **5 seconds** of the originating action without a manual refresh
**And** Maximum Bid recomputes within **1 second** of any Bid, Auction Close or override
**And** board and Auction views are interactive within **2 seconds** on mobile data
**And** a Bid submission is acknowledged within **1 second**

### Story 4.2: The persistent strip

As a Manager,
I want my Maximum Bid and roster count in front of me on every screen,
So that I never have to go and look up the one number the whole app exists to compute.

**Acceptance Criteria:**

**Given** any surface in the app
**When** it renders on mobile
**Then** the persistent strip is present at the bottom of the thumb zone at **52px, full-bleed, `surface`, with a `border-strong` top edge**
**And** it shows *Maximum Bid* in Georgia `brand`, the figure at 17px, and Roster Count — **at all times**

**Given** the desktop breakpoint
**When** the layout adapts
**Then** the strip **moves into the header** rather than pinning to the bottom of a 1400px viewport
**And** **Maximum Bid remains persistently visible at every width** — a requirement, not a mobile convenience

**Given** the strip
**When** a Manager taps it
**Then** it opens the destinations sheet, rendering the **same single server-resolved list** as the header menu from Story 1.6
**And** the two can never offer different sets, because there is one list

**Given** any Bid, Auction Close or Commissioner override
**When** it commits
**Then** the strip's figure recomputes within **one second**
**And** the figure is `evaluate()` output on the read path, never a memoised or stored value

**Given** a non-Live freshness state
**When** the strip renders
**Then** it carries the age of its figure or labels it last-known, per Story 4.1
**And** in Contract Assignment Phase it reports assignment progress rather than Maximum Bid

### Story 4.3: View the Bid Board

As a Manager,
I want the whole board in one scrollable list that tells me what is closing, who is leading and what state each auction is in,
So that I can pick a target on a phone without opening a laptop.

**Acceptance Criteria:**

**Given** the Bid Board
**When** it renders
**Then** every open Auction shows Player identity, current price, Leading Bidder team name, Auction state and time remaining
**And** each card follows the board card anatomy — player name Georgia 18px, metadata line `NBA · POS · $0.0M · Nyr` in `text-secondary` 12px, price at 26px with the state chip opposite
**And** time is shown twice, relative and absolute in the viewer's own timezone
**And** the viewer's **Maximum Bid is persistently visible on the board itself**, via the Story 4.2 strip

**Given** the five Auction states
**When** each renders
**Then** **Awaiting Opening Bid** shows no clock at all, reads "No opening bid" in `text-tertiary`, states that it holds the nominator's Nomination Slot, and shows hours unbid
**And** **Open** shows price, Leading Bidder, countdown and absolute close time
**And** **Minimum-Bid Contention** carries the `lottery` left accent bar, an icon, a label, the Contender count, and the words that the clock will not reset on a join
**And** **Closed** shows winner, final amount, Slot placement, and for a lottery the seed and ordered Contender list
**And** **Terminated** shows no winner, the Player returned to the pool, and the reason if by override

**Given** the four viewer-relative states
**When** they render
**Then** **You lead** takes an outlined `border-strong` chip with `text`
**And** **Outbid** takes a filled `attention` chip with `attention-ink` — and `attention` marks Outbid and nothing else in the entire system
**And** **Contender** and **Not involved** each carry their own word and shape
**And** every state chip carries an **icon and a word**, never colour alone
**And** a greyscale screenshot of the board remains fully readable — the acceptance test

**Given** the board
**When** a Manager organises it
**Then** it is sortable by time remaining, price and Player name
**And** filterable to Auctions the viewer's Team is leading or contending in
**And** a filtered view is visibly filtered, so it can never be mistaken for the whole board

**Given** countdown timers
**When** they render
**Then** they are accurate to the second and derived from a **server-authoritative absolute close time**, never from client clock arithmetic against page load

**Given** the moment the auction opens with nothing nominated
**When** the board renders
**Then** the empty board is a **designed screen, not an edge case** — it explains the state and points at Nominate
**And** it manufactures no urgency: no "ending soon", no "last chance", no pulsing or reddening countdown, no one-tap raise, no suggested amount

### Story 4.4: Your Positions — the landing

As a Manager waking up in Melbourne at 7:40am,
I want the app to open on what happened to me overnight,
So that the dominant session of this whole auction takes one tap rather than a hunt through thirty auctions.

**Acceptance Criteria:**

**Given** a Manager opening the app mid-auction
**When** they land
**Then** they land on **Your Positions** — a destination of its own, **not** a filter on the board and not a pinned group
**And** it is reachable from the destination list like any other destination

**Given** Your Positions
**When** it renders
**Then** it groups in the order the wake-up actually asks: **won while you slept · outbid · you lead · contending · Nomination Slot**

**Given** an outbid card
**When** it renders
**Then** it carries the answer to the next question **before it is asked** — whether a legal re-entry exists at all
**And** where the next legal Bid exceeds the viewer's Maximum Bid, it says so in words rather than letting them tap through to discover the player is arithmetically gone

**Given** Your Positions for a Manager leading nothing and contending in nothing
**When** it renders
**Then** the empty state points at the board and at their unused Nomination Slot

**Given** Your Positions
**When** a Manager moves to the full board
**Then** the Bid Board is **one tap away and opens unfiltered**

**Given** a deep link to a specific Auction
**When** it is opened by a signed-in Manager
**Then** it lands on **that Auction**, not on a list, with the viewer's own position on it visible without a further tap
**And** the link shape is stable and addressable, so Story 5.3 can emit it in a Discord mention without this story knowing Discord exists

### Story 4.5: View any Team

As a Manager,
I want to read any rival's cap position and roster in full,
So that I can work out whether they can actually chase this player without doing arithmetic in my head.

**Acceptance Criteria:**

**Given** any Team, viewed by any Manager
**When** its view renders
**Then** **Cap Space, Committed Bids, Available Cap Space, Roster Count by Slot kind, Free Active/Bench Slots, Free Minor League Slots, Minors Exposure and Nomination Slot status** are all visible
**And** this holds for **every** Team, to **all** Managers — there is no partial-information layer and no fog of war
**And** every one of these figures is reproducible by hand from figures already on the Bid Board, and none is presented as privileged information

**Given** the viewer's **own** Team
**When** its view renders
**Then** it additionally shows **Maximum Bid with its components broken out** and the list of Auctions they lead or contend in
**And** Maximum Bid remains **the one figure shown for the viewer's Team only**, because it is per-Auction and a team-level rendering of it would authorise nothing

**Given** an Auction that closes
**When** the winning Team's view is next read
**Then** the won Player appears on the roster **immediately, in his assigned Roster Slot**, before contract length is assigned

**Given** every figure on this view
**When** it is produced
**Then** it is computed from committed state on read and **none is stored**
**And** it is produced by the same computation the Teams index uses, so the two cannot disagree

**Given** the Team view at 375px
**When** it renders
**Then** it is single-column and legible without lateral scrolling
**And** the Team is named per the naming rule — spelled out with its Manager(s), never a three-letter abbreviation

### Story 4.6: The Teams index and the League Median

As a Manager deciding whether $6.0M of room is a lot or a little this offseason,
I want all thirty Teams in one list with a median to compare against,
So that I can answer "who else can actually chase this player" by reading rather than by arithmetic.

**Acceptance Criteria:**

**Given** the Teams index
**When** it renders
**Then** it lists **all 30 Teams, never a subset and never paginated**
**And** the viewer's own Team is **marked but not pinned, reordered, or exempted from the sort** — it sits wherever the figures put it, which is the point of the screen
**And** the own-row marker is a **2px `border-strong` left edge plus `— you`** in place of a Manager name — never the 3px bar, which belongs to Minimum-Bid Contention and which nothing may borrow
**And** **every Team name sits in `text`, the viewer's included**; the Manager name beside it takes `text-secondary`

**Given** a Teams row
**When** it renders
**Then** it carries Team name and Manager(s) in **`ui` 15px — not Georgia**, because a fantasy Team is an entity, not a name a manager is shopping for
**And** **Free Active/Bench Slots** as `Roster Count of 12` with the `of 12` in `text-secondary`
**And** **Free Minor League Slots** as `occupied of 3`
**And** **Injury Reserve occupancy shown in `text-tertiary` and visibly outside the slot group**, because it is the arithmetic managers most often get wrong by hand
**And** **Cap Space, Committed Bids, Available Cap Space** and **Nomination Slot status** (free, or the Player holding it)
**And** rows are separated by a 1px `border` rule rather than card gaps, because thirty cards at 8px apart is a scroll nobody finishes

**Given** the median line
**When** it renders
**Then** it sits at the foot of the list behind a `border-strong` rule, labelled ***median*, never *average***
**And** it reports the League Median of **Free Active/Bench Slots** and of **Available Cap Space**
**And** it is visually **quieter than every row above it** — it is context, not a verdict

**Given** an even number of Teams
**When** the League Median is computed
**Then** it is the **lower of the two middle values, not their mean**
**And** it therefore always sits on the $500,000 grid and renders losslessly at one decimal
**And** §10 example 28 passes — a 15th value of $4,000,000 and a 16th of $4,500,000 yield **$4,000,000**, not $4,250,000; and a 15th of 2 slots and a 16th of 3 yield **2**, not 2.5
**And** the median lives in `core/money` as pure arithmetic on the branded type, **not** behind `evaluate()` or `decide()`, because a read-model aggregate authorises nothing and is not a rule

**Given** the whole index
**When** it renders
**Then** **no Team is coloured, badged, ranked, arrowed, ordinal-numbered or annotated by its position relative to the median**
**And** no copy characterises a Team as ahead, behind, rich, poor, stacked, thin or under pressure
**And** a greyscale screenshot of this surface is not merely readable but **identical** — the acceptance test for this story

**Given** sorting
**When** it is offered
**Then** it covers Available Cap Space, Free Active/Bench Slots, Cap Space and Team name
**And** the **default is Team name**, the only ordering that expresses no editorial view — opening on a cap-space sort would make the screen a leaderboard
**And** sorting is view state and **never changes a figure**

**Given** the phase
**When** the index renders
**Then** in **Auction Phase** it shows the columns above
**And** in **Contract Assignment** the slot columns are replaced by remaining **Year Allotment** (4-year, 3-year and both 2-year deals shown as used or unused) plus assignment completion, with cap columns retained and now describing settled contracts
**And** in **Archived** that state is frozen and read-only
**And** the index is **not offered in Setup**, where the per-Team import preview does a different job

**Given** the index carries no bid or nomination control
**When** the connection degrades
**Then** it takes the **other branch of the freshness rule** — the figures carry their age rather than a control being disabled
**And** the absence of a control is not a reason to say less; it is the reason the label has to do all the work alone

**Given** the index at 375px
**When** it renders
**Then** it is a **single-column list of rows, not a horizontally scrolling table**
**And** money and slot figures are legible without lateral scrolling, in three bands — identity, slots, money
**And** on desktop it becomes a genuine table
**And** every figure comes from the same computation as the Story 4.5 Team view and cannot disagree with it

---

## Epic 5: Nobody loses a player to inattention

Every auction event reaches the league Discord channel, and every Manager affected by one gets an `@mention` that pushes to their phone within 60 seconds. Validates SM-3, a primary success metric with a target of 100%.

### Story 5.1: The transactional outbox and its dispatcher

As a Manager,
I want a Discord outage to cost me a notification and never a bid,
So that the channel carrying every alert can fail without the auction failing with it.

**Acceptance Criteria:**

**Given** a transaction that appends auction events
**When** it commits
**Then** it **also inserts the delivery intents** for those events, in the same transaction
**And** delivery itself **never runs inside the auction transaction** and can never fail it

**Given** the dispatcher
**When** it runs
**Then** it drains the outbox **inside the same tick as the close sweep**, after the sweep, per AD-10's single combined schedule
**And** it retries with backoff on failure
**And** a Discord delivery failure **never blocks or reverses the underlying auction action**
**And** failures are logged and **surfaced to the Commissioner**, not to Managers

**Given** the idempotency key
**When** it is defined
**Then** it is **`(event seq, channel, recipient)`** — not the event alone
**And** an automated test appends one Team-affecting event for a **co-managed Team** and asserts that **two** mentions are dispatched and delivered, one per co-Manager
**And** a retry of that same tick dispatches **neither** a second time

**Given** the Discord webhook's documented limit of **30 requests per minute**
**When** the dispatcher has many pending intents
**Then** it batches multiple events into one message where it can
**And** it backs off on a 429 rather than dropping intents
**And** an automated test simulates a sweep closing many Auctions at once — the case that hits the ceiling — and asserts every intent is eventually delivered exactly once

**Given** every dispatch
**When** it is recorded
**Then** **dispatch and delivery outcome are written to the event log** (NFR11), from the first notification onward, because an insert-only log cannot be backfilled and SM-3 cannot be computed retroactively

**Given** the outbox implementation choice
**When** it is made
**Then** it is decided between Supabase Queues (pgmq) and a hand-rolled table, and the decision is recorded
**And** AD-17's contract above holds unchanged either way

**Given** the Discord delivery shape choice
**When** it is made
**Then** one message per event versus batched is decided against the 30 req/min ceiling
**And** it is flagged for **revisit at the Epic 8 rehearsal**, which is the first point burst behaviour becomes observable

### Story 5.2: Broadcast auction events to the league channel

As a Manager,
I want every auction event posted publicly in the league channel,
So that the record of what happened and the alert that it happened are one artifact rather than two that can disagree.

**Acceptance Criteria:**

**Given** the configured Discord channel
**When** auction events occur
**Then** **Nominations, Bids, Auction Closes, Randomizer draws, Auction Phase start and Auction Phase end** are each posted
**And** a draw post carries the **seed and the ordered Contender list**

**Given** any post
**When** it is composed
**Then** it names the **Team, the acting Manager, the Player, the amount** and the **new close time** where applicable
**And** the Team is spelled out with its Manager attached — `Lakers — Meakel` — and a three-letter capitalised abbreviation means the player's **real-life NBA team and nothing else**
**And** money renders as `$14.5M` at exactly one decimal, because Discord payloads are a view of the same figures for the same readers
**And** the abbreviated rendering is structurally unable to reach a CSV cell

**Given** any outbound payload
**When** it is sent
**Then** it sets **`allowed_mentions` explicitly**, so no message can mass-ping the league by accident

**Given** retry
**When** the dispatcher re-attempts a delivery
**Then** the event is posted **at most once**

**Given** the channel used for broadcasts
**When** it is configured
**Then** it is the **same channel** carrying the FR-27 mentions, so a Manager's alert and the public record are one artifact

**Given** the product's voice
**When** any post is composed
**Then** it contains **no exclamation marks**, no urgency framing, no "ending soon" or "last chance", and no suggested action

### Story 5.3: Notify Managers by Discord mention

As a Manager who has been outbid while at work,
I want to be named in the channel I actually read, within a minute,
So that a 24-hour clock is a fair contest rather than a trap for whoever happens to be looking.

**Acceptance Criteria:**

**Given** a Team-affecting event
**When** it occurs
**Then** the affected Manager is **`@mention`ed by their Discord id** in the league channel
**And** the Discord id is the one captured at sign-in, because authentication and notification addressing are the same fact

**Given** the events that trigger a mention
**When** they are enumerated
**Then** they are: the Manager's Team is **outbid**; an Auction their Team **leads or contends in closes**; their **Nomination Slot is released**; their **unbid Nomination hits 24 hours**; and the **Contract Assignment Phase opens**

**Given** an outbidding Bid
**When** the previous Leading Bidder is notified
**Then** the mention is posted **within 60 seconds** of that Bid

**Given** a co-managed Team
**When** any Team-affecting event occurs
**Then** **both** Managers are mentioned **individually**
**And** a single post naming only the Team does **not** satisfy this

**Given** any mention post
**When** it renders in Discord
**Then** it **links directly to the relevant Auction**
**And** following that link lands the Manager on that Auction, already signed in, with their position on it visible without a further tap

**Given** the 24-hour unbid-Nomination warning
**When** it fires
**Then** it is driven by the tick evaluating Nomination age, not by a per-nomination timer
**And** it complements the board flag already derived on read in Story 2.3

### Story 5.4: Notification settings — three mutable categories, and only three

As a Manager,
I want to turn down the noise without turning off the alert that actually matters,
So that a busy channel does not cost me a player.

**Acceptance Criteria:**

**Given** the notification settings surface
**When** it renders
**Then** it offers exactly **three** mutable categories: **Nomination Slot released**, the **unbid-Nomination 24-hour warning**, and **closes for Auctions the viewer's Team did not lead or contend in**

**Given** a muted category
**When** an event in it occurs
**Then** **the post still appears in the channel** and only the `@mention` is withheld
**And** the public record therefore stays complete — muting suppresses the ping, never the record

**Given** **outbid** notices and **Contract Assignment Phase** notices
**When** a Manager looks for a way to mute them
**Then** **no control to do so exists** — they are structurally unmutable, because muting an outbid notice would undermine the fairness premise of a 24/7 clock
**And** a direct request attempting to mute either is refused server-side

**Given** the settings surface
**When** it renders at 375px
**Then** it is single-column and fully operable one-handed
**And** each category states in words what muting it will and will not do, rather than presenting a bare toggle

---

## Epic 6: Close the books — assignment, export, archive

Every Manager assigns contract lengths against their Year Allotment, and the Commissioner reviews the complete outcome on screen and downloads both Fantrax files, then marks the auction archived. Realizes PRD UJ-4's back half.

### Story 6.1: Assign contract lengths against the Year Allotment

As a Manager,
I want to spend one 4-year, one 3-year and two 2-year deals across the players I won,
So that the dynasty tradeoff the league actually cares about is made deliberately, with the remaining budget in front of me.

**Acceptance Criteria:**

**Given** the Contract Assignment Phase
**When** a Manager opens their assignment surface
**Then** it lists every Player their Team won with contract length unset
**And** available lengths are **1, 2, 3 and 4 years**
**And** the **4-year and 3-year may each be used once, the 2-year twice, and the 1-year without limit**

**Given** an assignment in progress
**When** the Manager assigns a length
**Then** the **remaining allotment is displayed as they go**
**And** an assignment exceeding the allotment is **refused**, stating what remains
**And** §10 example 14 passes as a named test — a Team having spent its 4-year, 3-year and both 2-year deals can assign only 1-year deals, with longer options unavailable

**Given** a Team that has not submitted as final
**When** the Manager revisits
**Then** assignments may be **changed freely**
**And** submitting as final is a **two-part act**, never a single tap

**Given** the Year Allotment
**When** the phase ends
**Then** **unused allotment expires** and does not carry to a future offseason
**And** the Allotment applies only to **Auction Contracts** — Existing Contracts cannot be extended or altered here

**Given** an assigned Contract
**When** it is recorded
**Then** the app records **amount and length only** and computes no future-year escalation
**And** the winning amount is the annual Cap Hit for an Active/Bench placement, per the distinct-fields rule of Story 3.4
**And** the assignment is appended as an event with the acting Manager and Team

### Story 6.2: Track completion, and a deadline that resolves nothing

As the Commissioner,
I want to see who has not finished and to nudge them, without the app quietly deciding on their behalf,
So that an unresponsive Team is cleared by a visible act rather than a silent default nobody can audit.

**Acceptance Criteria:**

**Given** the Contract Assignment Phase
**When** the Commissioner opens assignment monitoring
**Then** it shows a **live per-Team roster of which Teams have submitted and which have not**
**And** it is fully operable at 375px and becomes multi-column on desktop

**Given** Managers with unassigned Players
**When** the configured reminder interval before the deadline is reached
**Then** they are reminded by **Discord `@mention`** through the Story 5.3 path
**And** the interval is Commissioner-configurable

**Given** the deadline passes
**When** the tick evaluates it
**Then** **the deadline resolves nothing by itself**
**And** **no contract length is ever assigned by default** — an automated test asserts no code path can write a length without an acting actor
**And** the affected Teams and the Commissioner are notified
**And** unassigned Players stay unassigned
**And** **the export stays blocked** until every Auction Contract has a length

**Given** a Team that will not or cannot respond
**When** the Commissioner resolves it
**Then** the only path is the Commissioner **assigning lengths on its behalf**, with a recorded reason — deliberately a visible act rather than a silent fallback
**And** that override is **delivered in Story 7.3**, so this story builds only the block and the notification, not the escape hatch
**And** until it exists, an unassigned Team simply blocks the export, which is the correct behaviour in its own right

**Given** the deadline
**When** the Commissioner extends it
**Then** the extension is permitted and **logged**

### Story 6.3: Review and export the Auction Contracts

As the Commissioner,
I want to read the whole outcome on screen and then download it in the shape Fantrax wants,
So that I upload sixty contracts by file rather than transcribing them by hand at midnight.

**Acceptance Criteria:**

**Given** the export review screen
**When** it renders
**Then** it lists **every Auction Contract** with Team, Player, Fantrax player ID, winning amount, contract length and Slot Placement
**And** it shows each Team's resulting total salary and Cap Space
**And** on-screen money renders as `$14.5M` at exactly one decimal

**Given** the export gate
**When** the Commissioner attempts to download
**Then** it is **blocked, naming the offending Teams**, if any Team's post-auction salary exceeds **$165,000,000**
**And** blocked if any Team's Roster Count is **other than exactly 12** — below leaves a hole, above breaches the ceiling
**And** blocked if **any Auction Contract still lacks a contract length**

**Given** Free Agents not won in the auction
**When** the export is produced
**Then** they require **no export treatment and are omitted entirely** — they simply remain free agents in Fantrax

**Given** the exported file
**When** it is written
**Then** it carries the **stable Fantrax player and team IDs** from the import, so rows match on upload without name-based reconciliation
**And** it emits **exact integer dollars**, and an automated test asserts the abbreviated `$14.5M` renderer is unreachable from the export path
**And** **winning amount and Cap Hit are emitted as distinct columns**, because a Minor League placement resolves to a $0 Cap Hit while the winning amount stands
**And** every CSV column name lives in the single Fantrax adapter module and nowhere else

**Given** a produced export
**When** the Commissioner downloads it
**Then** it can be **re-downloaded any number of times** and is written to the Audit Log **each time**
**And** the screen states plainly that **exporting does not write to Fantrax** and that upload is a manual Commissioner step

### Story 6.4: Export full post-auction rosters

As the Commissioner,
I want a second file covering every player on every roster, not just the ones this auction created,
So that whichever import path Fantrax wants, I have the file it needs.

**Acceptance Criteria:**

**Given** the roster export
**When** it is produced
**Then** it lists **every Player on every Team** — Existing Contracts and Auction Contracts alike
**And** each row carries Fantrax team ID, Fantrax player ID, Cap Hit, contract length and Roster Slot

**Given** Existing Contracts
**When** they are exported
**Then** they are reproduced **exactly as imported**, unless altered by a Commissioner override
**And** where altered, the current value is exported and the override remains traceable in the Audit Log

**Given** the two exports
**When** they are compared
**Then** **every Auction Contract in the contract export appears in the roster export at the same amount and the same Slot**
**And** an automated reconciliation test asserts this across a full synthetic auction

**Given** the two exports
**When** they are offered
**Then** they are **separate downloads**, because Fantrax's commissioner import may accept them through different paths
**And** both emit exact integer dollars and never the abbreviated rendering

### Story 6.5: Archive the auction

As the Commissioner,
I want to freeze the auction once the results are in Fantrax,
So that the record stays readable forever and nothing can be changed after the fact.

**Acceptance Criteria:**

**Given** the results are uploaded to Fantrax
**When** the Commissioner marks the auction archived
**Then** the archive act is a two-part Commissioner act with a recorded reason
**And** a phase-transition event is appended and the phase projection folds to **Archived**

**Given** an archived auction
**When** any mutation is attempted
**Then** **no Bids, Nominations, assignments or overrides are accepted** — by UI and by direct request alike
**And** the destination list for every role reflects the Archived phase, offering the frozen Bid Board, Teams, Audit Log and the re-downloadable Export

**Given** an archived auction
**When** any Manager visits it
**Then** the full **Bid Board, Audit Log and export remain viewable indefinitely**
**And** the Teams index shows the frozen final state of its Contract Assignment columns, read-only

**Given** the free tier pauses a project after roughly a week of inactivity, and this app idles about eleven months
**When** archive reachability is planned
**Then** an option is chosen and recorded — a paid month, a static export of final state, or accepted manual resume (AR-35)
**And** whichever is chosen is documented alongside the outage recovery procedure

---

## Epic 7: The referee's controls and the record

The Commissioner can void a Bid, adjust Cap Space, terminate an Auction, release a Nomination Slot, extend or expire any Clock, assign a length on a Team's behalf, and pause and resume the whole auction — every act carrying a mandatory free-text reason and a before/after — and any Manager can read the complete append-only Audit Log.

### Story 7.1: The Commissioner control class and the reason sheet

As the Commissioner who is also a competing manager,
I want the referee controls to be a visibly different object from the player controls,
So that I can never reach for one at 4am and hit the other by muscle memory.

**Acceptance Criteria:**

**Given** the Commissioner control class established in Story 1.1
**When** it is applied to every override control in this epic
**Then** its four independent, non-colour properties hold unchanged — never filled, dashed 1px `admin` border, recessed `admin-ground` behind a dashed rule, and the persistent ***"Commissioner · visible only to you"*** label
**And** no override control is styled as a variant of a Manager control

**Given** a Commissioner control
**When** it is placed
**Then** it lives **in place, on the object being acted on** — the Auction, the Team, the Bid, the Nomination Slot — so an override is performed with full context on screen
**And** it is visible only to the Commissioner, and its route refuses server-side to anyone else regardless of what is rendered

**Given** genuinely global administrative acts
**When** they are placed
**Then** they get their own admin destination — import and preview, Minor League Eligibility, the auction-open gate, pause and resume, assignment monitoring, export and archive, and operational health

**Given** any Commissioner act
**When** it is initiated
**Then** **no Commissioner act is ever a single tap** — every one opens a reason sheet
**And** the sheet names the act in Georgia
**And** it shows **before → after for every affected value, including both Clocks**
**And** it states any **non-obvious downstream consequence in words**, carrying an `attention` note where the consequence is non-obvious
**And** the reason field is **empty on open with no placeholder suggestion, no default and no skip**
**And** the commit control on the sheet is **itself dashed** — even the confirmation is not a Manager button

**Given** any override
**When** it commits
**Then** it is written to the Audit Log with **actor, timestamp, before-state, after-state and the free-text reason**
**And** **no override path can skip the reason** — an automated test asserts a reasonless submission is refused server-side

**Given** an archived auction
**When** any override is attempted
**Then** it is refused

**Given** the Commissioner's own Team
**When** ordinary Manager controls render on it
**Then** they behave exactly as they do for anyone else, with no privilege altering its Cap Space, Maximum Bid or Nomination Slot

### Story 7.2: Void a Bid and restore the Auction

As the Commissioner,
I want to undo a bid that should not have stood, with every consequence stated before I commit,
So that a correction is a visible, reconstructible act rather than a rewrite of what happened.

**Acceptance Criteria:**

**Given** an accepted Bid
**When** the Commissioner voids it
**Then** a **`BidVoided` compensating event is appended** — the original `BidPlaced` is **never** deleted or mutated, because the log is insert-only for every role
**And** the reason sheet is mandatory, per Story 7.1

**Given** a voided Bid
**When** the Auction is refolded
**Then** it is restored to its state before that Bid, including the **prior Leading Bidder** and the **prior Auction Clock value**
**And** the voided Team's committed capital is released and the restored Leading Bidder's is re-committed

**Given** a voided Bid
**When** the League Clock is refolded
**Then** **that Bid's reset is removed** and the Clock is recomputed from the remaining surviving reset events
**And** the recomputation can make the Auction Phase end **sooner**
**And** §10 example 27 passes **against real appended events**, reproducing the result Story 3.7 already tested against a state literal — a Nomination at 09:00 Monday and a Bid at 15:00 Monday, with the Bid voided at 18:00, moving expiry from 15:00 Wednesday to **09:00 Wednesday**

**Given** a recomputation landing the League Clock's expiry in the past
**When** the next tick evaluates
**Then** the Auction Phase ends **at that evaluation, prospectively only**
**And** **nothing accepted in the interim is invalidated** — Nominations and Bids between the recomputed expiry and the void stand

**Given** the reason sheet for a void
**When** it renders
**Then** it states the downstream consequence in words — that voiding removes the Bid's League Clock reset and can end the Auction Phase sooner
**And** it shows the League Clock's before and after expiry alongside the Auction Clock's

**Given** a voided Bid
**When** it is broadcast
**Then** it is posted to Discord like any other event, with the actor and reason

### Story 7.3: The remaining overrides

As the Commissioner,
I want a way to fix an import error, a stuck slot, a wrong clock or an unresponsive team,
So that rules meeting reality does not require a database console.

**Acceptance Criteria:**

**Given** a Team whose imported Cap Space is wrong
**When** the Commissioner adjusts it
**Then** the adjustment is appended as a reference-data mutation **event**, so a projection rebuild reproduces the figure as it stood at each point
**And** the reason sheet shows before → after Cap Space and the resulting Available Cap Space and Maximum Bid effect

**Given** an Auction that must not resolve
**When** the Commissioner terminates it
**Then** it closes with **no winner** and the Player returns to the Free Agent pool
**And** the board shows it as **Terminated** with the reason
**And** the nominating Team's Nomination Slot releases through the Story 2.3 fold

**Given** a Nomination Slot held by a dead Nomination
**When** the Commissioner releases it
**Then** the Slot frees and the nominating Team's Managers are notified
**And** this is the **only** path to clearing an unbid Nomination, since no automatic expiry exists

**Given** any Clock
**When** the Commissioner extends or expires it
**Then** the new absolute close time is persisted and broadcast
**And** the reason sheet shows the before and after close times in the viewer's timezone
**And** expiring an Auction Clock causes the next tick to close it under the ordinary rules of Story 3.4

**Given** a Team that has not assigned its contract lengths by the deadline
**When** the Commissioner assigns on its behalf
**Then** the assignment carries the Commissioner as actor with a recorded reason
**And** it respects the Team's Year Allotment exactly as the Manager's own assignment would
**And** this is the **only** path past an unresponsive Team, since no default is ever applied

**Given** every override in this story
**When** it commits
**Then** it appends an event, requires a reason, records before-state and after-state, is refused once archived, and is broadcast to Discord

### Story 7.4: Pause and resume the auction

As the Commissioner during an outage,
I want to stop every clock from wherever I physically am,
So that a fifteen-minute failure costs the league nothing rather than deciding a player.

**Acceptance Criteria:**

**Given** a running auction
**When** the Commissioner pauses it
**Then** **each running Clock's remaining duration and the pause instant are persisted**
**And** **absolute close times are never shifted in place**
**And** a pause event is appended

**Given** a paused auction
**When** the tick runs
**Then** it **checks paused state under the same global lock** and **closes nothing while paused**
**And** an automated test asserts no Auction resolves during a pause of arbitrary length

**Given** a paused auction
**When** a Bid or Nomination is attempted
**Then** it is refused **with the pause stated as the reason**, worded distinctly from every rules refusal

**Given** a paused auction
**When** the Commissioner resumes it
**Then** every Clock's absolute close time is **recomputed forward from the resume instant** using the stored remaining duration
**And** each Clock continues with **exactly the remaining time it held at pause**

**Given** any surface during a pause
**When** it renders
**Then** the **paused banner is present on every one of them** — `attention` border on a warm ground
**And** it states that Clocks are stopped, that Bids and Nominations are refused, and that each Clock resumes with exactly the time it held
**And** it carries **who paused it, when, and their reason**
**And** it is unmissable, because an outage that looks like an ordinary quiet period is worse than one that announces itself

**Given** Netlify is the component that has failed
**When** the Commissioner needs to pause
**Then** a **break-glass path independent of Netlify exists** — a flag settable directly in the database
**And** it is documented and rehearsed, because pause is the universal escape hatch and the web host is one of the things it must escape

**Given** a pause or resume
**When** it commits
**Then** it is announced to all Managers and posted to Discord

### Story 7.5: The league-visible Audit Log

As a Manager,
I want to read the complete record of everything that happened, including everything the Commissioner did,
So that verifiable fairness is something I can check rather than something I am asked to trust.

**Acceptance Criteria:**

**Given** the Audit Log
**When** it is implemented
**Then** it is a **read of the insert-only event log**, not a second table maintained in parallel
**And** **no entry can be edited or deleted by any role — the Commissioner included**
**And** the interface offers no affordance suggesting otherwise

**Given** the Audit Log
**When** it renders
**Then** it covers every **Nomination, Bid, Auction Close, Randomizer draw with its revealed seed, Commissioner override, pause and resume, import and export**
**And** each entry names the acting Manager alongside the Team
**And** Teams are spelled out with their Manager attached, and a three-letter abbreviation means the player's real-life NBA team and nothing else
**And** money renders at exactly one decimal

**Given** the Audit Log
**When** a Manager searches it
**Then** it is **filterable by Team, by Player and by event type**
**And** it is **exportable**

**Given** a Commissioner override entry
**When** it renders
**Then** it shows actor, timestamp, before-state, after-state and the free-text reason

**Given** a Randomizer draw entry
**When** it renders
**Then** it shows the **revealed seed, the ordered Contender list as it stood at expiry, and the selection** — the three things a losing Manager needs to reproduce the result

**Given** the Audit Log at 375px
**When** it renders
**Then** it is single-column, legible without lateral scrolling, and readable by any Manager in every phase including Archived

---

## Epic 8: Ready to open — rehearsal, liveness, and restore

The Commissioner can open the auction knowing an outage is survivable rather than decisive: the whole auction has been run once end to end against a compressed clock, a dead tick alerts a sleeping operator, the auction is restorable from outside Supabase, and the recovery procedure is written down. This epic is the gate on opening the auction for real.

### Story 8.1: Replay the auction against a synthetic clock

As the Commissioner-builder,
I want to run a complete auction in minutes against a fake league,
So that the 24-hour and 48-hour clock paths are not first exercised in production with thirty people watching.

**Acceptance Criteria:**

**Given** a fake 30-Team league and a synthetic pool
**When** a rehearsal is driven
**Then** it runs a **full auction end to end** — nomination, bidding, refusals, a lottery that draws, a lottery that dissolves, sequential closes, League Clock expiry, phase transition, contract assignment, and both exports
**And** it completes with **no wall-clock waiting**

**Given** the rehearsal
**When** the code paths it exercises are inspected
**Then** **no code path is special-cased for the rehearsal** — it works because `now` is a parameter, not because of a test mode
**And** an automated check fails the build if any branch keys on a rehearsal flag

**Given** a close sweep running late during the rehearsal
**When** its outcomes are compared against an on-time sweep
**Then** they are **identical**, because `now` for each Auction is that Auction's own nominal expiry
**And** the comparison is asserted, not eyeballed

**Given** the rehearsal
**When** it drives notifications
**Then** burst behaviour against the **30 requests/minute** webhook ceiling becomes observable
**And** the Story 5.1 delivery-shape decision — one message per event versus batched — is **revisited and confirmed or changed** against what is observed

**Given** the rehearsal
**When** it runs against the dev Supabase project
**Then** the dev Cron schedule is **enabled only for the rehearsal** and disabled again afterward
**And** the rehearsal's Edge invocation cost is counted against the org-wide free-tier ceiling shared with production

**Given** the §10 suite
**When** the rehearsal completes
**Then** all 28 examples are green as named tests calling the core directly
**And** the suite is green before any deploy to the production project

### Story 8.2: Detect that the tick has stopped

As the Commissioner-builder asleep at 3am,
I want to be woken when the sweep dies,
So that a dead tick is not indistinguishable from a quiet night until thirty people find out in the morning.

**Acceptance Criteria:**

**Given** the tick
**When** each pass completes
**Then** it writes a **heartbeat row**

**Given** the detector
**When** it is deployed
**Then** it runs **outside both Netlify and Supabase**, in a third failure domain
**And** it **shares no component with the outbox path it must report on**
**And** it is **not routed through Discord**, because it may need to report that Discord is down
**And** in-platform scheduling cannot discharge this: `pg_cron` → `pg_net` is fire-and-forget with no retry and no alert on a 5xx, and a paused or unhealthy project stops every schedule silently

**Given** the detector
**When** it evaluates health
**Then** it alerts on a **stale heartbeat**
**And** on a **growing outbox backlog**
**And** on a **projection-integrity check disagreeing with a rebuild**

**Given** free-tier quotas
**When** they are monitored
**Then** **Netlify credit burn** (300/month; exhaustion pauses the site) and **Supabase Edge invocations** (500K/month, shared org-wide; exhaustion stops the tick) are alerted on **well before their ceilings**
**And** both are treated as silent-outage sources on the same footing as liveness

**Given** any alert
**When** it fires
**Then** it **reaches a sleeping operator**
**And** the alert path is tested by deliberately stopping the tick and confirming the operator is woken

### Story 8.3: Reconstruct the auction from outside Supabase

As the Commissioner-builder,
I want a copy of the auction held somewhere Supabase cannot take with it,
So that a free tier with no backups, no point-in-time recovery and no SLA is a survivable dependency rather than a single point of total loss.

**Acceptance Criteria:**

**Given** the Auction Phase
**When** it is running
**Then** a **scheduled export of the event log plus the reference data a fold needs** runs for its duration
**And** it writes to storage in a **third failure domain** — outside both Supabase and Netlify

**Given** an exported copy
**When** a restore is attempted
**Then** it reproduces state that **reconciles against the Discord record**
**And** the restore is **rehearsed at least once before the auction opens** — an untested restore is not a restore
**And** the rehearsal is recorded with its date and outcome

**Given** the Discord channel
**When** restore paths are enumerated
**Then** it is documented as a **corroborating human-readable record and a reconciliation aid, and explicitly not a restore path**, because an incoming webhook is write-only

**Given** the exported reference data
**When** its completeness is checked
**Then** it includes everything a fold reads — cap hits, eligibility flags as their event history, and commissioner corrections — so a rebuild reproduces the world **as it stood**, not as it is now

### Story 8.4: The outage recovery procedure and the go-live gate

As the Commissioner at 3am with the site down and clocks running,
I want a procedure I follow rather than one I improvise,
So that the fifteen minutes I spend deciding what to do are not the fifteen minutes that decide a player.

**Acceptance Criteria:**

**Given** the availability posture
**When** it is documented
**Then** it states plainly that **no uptime percentage is committed to**, because nothing in this stack can underwrite one
**And** it states the actual requirement: an outage must be **survivable rather than decisive** — late closes never wrong ones, a reachable pause, and a restorable auction

**Given** an outage beyond **15 minutes**
**When** the procedure is followed
**Then** it prescribes a **Commissioner pause plus a compensating clock adjustment**, not a wait-and-see
**And** it names who does what, in what order, and how the league is told
**And** it covers the case where **Discord itself is the failed component**, routing through the break-glass sign-in and the non-Discord alert path

**Given** the procedure
**When** the auction is about to open
**Then** it **exists in writing** and **auction open is blocked on it**
**And** it is stored alongside the archive-reachability decision from Story 6.5

**Given** the go-live gate
**When** the Commissioner runs it before opening
**Then** the **§10 suite is green** across all 28 examples
**And** the **restore has been rehearsed** and its outcome recorded (Story 8.3)
**And** the **liveness detector has been proven** to wake a sleeping operator (Story 8.2)
**And** **`coreVersion` parity** holds between the Node and Deno deployments
**And** a **real Fantrax export** has been obtained and the salary and roster-slot columns confirmed against the adapter (Story 9.5)
**And** **all 31 Managers are confirmed to hold Discord accounts**, since FR-4 makes Discord load-bearing for access rather than convenience (Story 9.8)
**And** the **moderator pilot has been run** against the dev project and every finding it produced is triaged — fixed, or logged in `deferred-work.md` with the risk of opening without it stated (Story 9.7)
**And** the **pause control has been exercised** against a running auction, including the break-glass path independent of Netlify, because pause is the one control whose first use must not be during the outage it exists for (Story 7.4)
**And** where the gate is opened with a condition unmet, the **unmet condition is named in writing** alongside the decision to proceed — the gate may be knowingly overridden, but never silently

**Given** Story 8.1's time-compressed synthetic rehearsal has **not** been run
**When** the gate is evaluated
**Then** this is recorded as an **accepted deviation**, not an oversight
**And** the substitution is stated plainly: the moderator pilot exercised the real code paths with real people and real data, but **not** against a compressed clock — so the 24-hour and 48-hour clock paths remain first exercised in production
**And** the §10 suite's clock examples are the only standing evidence for those paths

---

## Epic 9: Stand it up and let the league in

The app stops being code and becomes a thing people use: both vendors provisioned, the schema applied dev-first, the league's real data seeded, the Fantrax column maps confirmed against a real export, and a group of league moderators signed in with their own Discord accounts driving a real import and a real auction on the dev project — before thirty people depend on it.

Added 2026-09-05 by `sprint-change-proposal-2026-09-05.md`. The work in this epic was always required; it existed only as `source_spec: none` entries in `deferred-work.md`, which `AGENTS.md` marks as not-a-backlog, making it simultaneously mandatory and unbuildable. This epic is where it becomes buildable.

**Execution order within the epic:** 9.5 and 9.1 in parallel first — 9.5 because it is the only story whose shape is unknown until a real file is in hand, 9.1 because provisioning has latency that cannot be compressed. Then 9.2, 9.3, 9.4, 9.6. Then 9.7. Story 9.8 runs last, after Stories 7.4, 8.2, 8.3 and 8.4.

### Story 9.1: Provision Supabase dev and apply the schema

As the Commissioner-builder,
I want a real database with the real schema on it,
So that thirty-eight stories of code stop being a hypothesis.

**Acceptance Criteria:**

**Given** no Supabase project exists
**When** the dev project is created
**Then** it is the **wipeable** project of AD-26's two-project topology, and prod is **not** created by this story
**And** its Postgres major version satisfies the stack pin (`>=15.1.1.61`, required for sub-minute Supabase Cron), matching `supabase/config.toml`
**And** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `SUPABASE_DB_URL`, `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` are set in the Netlify **deploy-preview and branch-deploy contexts only**, never in production

**Given** the thirteen migrations in `supabase/migrations/`
**When** they are applied
**Then** they are applied **dev-first** by migration file (AD-26)
**And** **nothing is typed into the Supabase dashboard** — not schema, not a policy, not a grant
**And** the applied state is verified against the repository, not assumed from a successful command

**Given** the migrations have been applied
**When** the `bbsl-tick` cron job is inspected
**Then** it exists and is **inactive**, exactly as `20260831000000_tick.sql` creates it
**And** it stays inactive until Story 9.7 enables it for the pilot

**Given** the branch-to-environment mapping committed in `netlify.toml`
**When** it is checked account-side
**Then** it is confirmed to be **actually configured**, closing the half of `deferred-work.md:12` that has been outstanding since 2026-08-20
**And** the Netlify credit cost of the configuration is recorded

**Given** the deployed branch
**When** `curl -I` is run against it
**Then** every header `netlify.toml` declares is **actually served**, discharging the manual check `tests/headers.test.ts` cannot perform
**And** the result is recorded, because the repository can prove the file declares them and nothing more

### Story 9.2: Provision the Discord application, channel and webhook

As a Manager,
I want to sign in with the Discord account I already have,
So that there is no password, no email, and no new account to create.

**Acceptance Criteria:**

**Given** Discord is the only identity provider (AD-15, FR-4)
**When** the OAuth2 application is created
**Then** `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` and `DISCORD_REDIRECT_URI` are set server-side
**And** the redirect URI matches the branch-deploy origin the pilot runs against, exactly
**And** **no Discord value takes a `PUBLIC_` prefix**, because SvelteKit inlines every such variable into the client bundle permanently

**Given** the league channel does not exist yet
**When** it is created
**Then** an **incoming webhook** is created on it and `DISCORD_WEBHOOK_URL` and `DISCORD_GUILD_ID` are set
**And** the webhook is understood as **write-only** — it is a corroborating record and a reconciliation aid, and explicitly **not** a restore path (AD-21, Story 8.3)
**And** the pilot uses a channel **separate from the one the real auction will use**, so pilot noise never contaminates the real league's record

**Given** the outbox has never dispatched to a real webhook
**When** the first message is posted
**Then** `allowed_mentions` is confirmed present and explicit on the payload, as AD-18 requires
**And** the **30 requests/minute** ceiling is confirmed as the real limit against real responses
**And** whether the Story 5.1 delivery shape — one message per event versus batched — survives contact with that ceiling is **observed and recorded**, discharging for real the question Story 8.1 was to answer synthetically

**Given** `APP_ORIGIN` is unset
**When** a Discord mention is posted
**Then** the notification still sends and only the deep link is lost, as `.env.example` states
**And** `APP_ORIGIN` is set anyway, to the branch-deploy origin

### Story 9.3: Admit Realtime to the CSP

As a Manager watching the board,
I want live updates rather than a poll,
So that the freshness indicator reads Live and means it.

**Acceptance Criteria:**

**Given** `connect-src 'self'` in `netlify.toml`
**When** it is widened
**Then** it names the dev project's **literal hosts** — `https://<ref>.supabase.co` and `wss://<ref>.supabase.co`
**And** it names **no wildcard host**, because `https://*.supabase.co` would admit every other tenant on the platform
**And** the prod project's literal hosts are added by Story 9.8, not guessed here

**Given** `tests/headers.test.ts` pins `connect-src` to exactly `["'self'"]`
**When** the directive is widened
**Then** the test is updated **in the same commit**, because `deferred-work.md:91` requires that the widening cannot happen silently
**And** the test continues to assert that the CSP names no wildcard host and no third-party host beyond `https://discord.com` and the two Supabase literals

**Given** the widened policy
**When** a browser loads the deployed app
**Then** the `auction_watermark` socket **connects**, and the freshness indicator reaches **Live** rather than sitting in Reconnecting
**And** this is verified against a real deploy, not inferred from the committed file

### Story 9.4: Seed thirty Teams and the moderator Managers

As the Commissioner,
I want the league's roster of people and teams to exist before anyone tries to sign in,
So that a moderator's first experience of the app is not a refusal.

**Acceptance Criteria:**

**Given** no admin UI exists for `managers` or `teams`, by design (`teams.sql:14`, `spec-1-4` Never list)
**When** the league is seeded
**Then** it is done by a **checked-in, re-runnable script**, not by SQL typed at a prompt
**And** the script is idempotent, so re-running it does not duplicate a Team or a Manager
**And** it can **wipe and reseed** the dev project in one command, because the pilot's data must not survive into the real auction

**Given** thirty Teams
**When** they are seeded
**Then** each carries its spelled-out fantasy Team name, never a three-letter abbreviation — which always and only means a player's real-life NBA team
**And** names are unique, as `teams_name_not_blank` and the unique constraint require

**Given** the moderators taking part in the pilot
**When** their `managers` rows are seeded
**Then** each carries the moderator's **real Discord snowflake**, their display name, and a `team_id` binding
**And** exactly the intended moderators carry `is_commissioner = true`
**And** an unregistered account attempting to sign in is refused **without enumerating the league** (AD-15) — verified, not assumed

**Given** a Team with two Managers
**When** both are seeded against one `team_id`
**Then** co-management is exercised for the first time against real accounts, and both resolve to identical Cap Space, Maximum Bid and Nomination Slot status

### Story 9.5: Confirm the Fantrax column maps against a real export

As the Commissioner on setup day,
I want the importer to accept the files Fantrax actually produces,
So that thirty-one files do not refuse at content altitude with the league watching.

**Acceptance Criteria:**

**Given** `ROSTER_COLUMNS` (`src/lib/adapters/fantrax/roster-file.ts`) and `POOL_COLUMNS` (`pool-file.ts`), both marked `TODO-confirm`
**When** a **real Fantrax export** is obtained
**Then** every header name is confirmed against the real file, or corrected to match it
**And** the `TODO-confirm` markers are removed, because they no longer describe the state of knowledge
**And** the change is confined to those two objects, as AR-33 and AD-24 intend — nothing else in the codebase names a Fantrax CSV column

**Given** `ROSTER_SLOT_ALIASES`
**When** the real export's slot wording is known
**Then** the alias set is **narrowed to the confirmed strings**, per the module's own instruction, rather than left permissive against wording that turned out not to exist
**And** an unrecognised slot value still refuses at content altitude and names the offending row

**Given** the import is **thirty-one files** — one Free Agent pool export plus one roster export per Team
**When** the shape of the real export is examined
**Then** it is confirmed that Fantrax produces them as thirty-one separate files and not as one combined file
**And** if it does not, the discrepancy is escalated immediately rather than absorbed, because the file count is load-bearing on the import UI

**Given** the Minor League Eligible flag
**When** the export is examined
**Then** it is confirmed **absent**, as already settled — it is Commissioner-set application data defaulting to not-eligible so omission fails safe

### Story 9.6: The setup runbook

As whoever stands this up next — including the Commissioner in eleven months,
I want the setup written down,
So that the knowledge does not live only in `.gitkeep` comments and one person's memory.

**Acceptance Criteria:**

**Given** the repository has no README and no `docs/`
**When** the runbook is written
**Then** it covers the **two-project Supabase topology**, the full environment-variable contract, the Discord OAuth application and webhook setup, the `COMMISSIONER_RECOVERY_SECRET`, the migration workflow, the Edge Function deploy, and how to run the tests
**And** it states the **`PUBLIC_` prefix rule** prominently, because a secret behind that prefix is a breach and not a typo

**Given** the cron schedule ships inactive
**When** the runbook covers the tick
**Then** it documents **enabling it and disabling it again**, and states that an enabled dev schedule burns the same org-wide Supabase invocation ceiling production shares

**Given** the seed script from Story 9.4
**When** the runbook covers league setup
**Then** it documents seeding, wiping and reseeding, and states plainly that there is **no admin UI by design**

**Given** the runbook
**When** it is checked against reality
**Then** it has been **followed end to end by someone other than its author**, or its author has followed it from a clean checkout — an unfollowed runbook is not a runbook
**And** it is distinct from Story 8.4's outage recovery procedure, which is a different document for a different moment

### Story 9.7: Run the moderator pilot

As a league moderator,
I want to use the app the way a Manager will,
So that the first person to find a problem is not someone with a real player at stake.

**Acceptance Criteria:**

**Given** the pilot
**When** it is run
**Then** it runs against the **dev project via a branch deploy**, never against prod
**And** the `bbsl-tick` schedule is **enabled only for the pilot and disabled again afterward**
**And** its Edge invocation and Netlify credit burn are counted against the org-wide free-tier ceilings production shares

**Given** the moderators
**When** they sign in
**Then** each signs in with their **own Discord account**, through the real OAuth handshake
**And** at least one signs in as a **non-Commissioner** and confirms a Commissioner-only route refuses by direct URL, not merely by a hidden control

**Given** the thirty-one real Fantrax files
**When** a moderator drives the import
**Then** the full **stage-then-promote** path runs — per-Team preview, atomic promotion, and a deliberate refusal of a bad file to confirm the refusal names the row
**And** Minor League Eligibility is set by hand on a real pool, exercising the surface `deferred-work.md:166` flags as the epic's highest design-drift risk
**And** any friction found there is captured against that entry

**Given** the auction
**When** moderators drive it
**Then** they nominate, bid, hit both gates, trigger a refusal panel, enter a Minimum-Bid Contention, and watch an Auction **close on the tick** rather than by hand
**And** the Discord broadcast and the `@mention` are confirmed to arrive on a phone
**And** the freshness indicator is confirmed to read **Live**, which is only true if Story 9.3 has landed

**Given** the pilot has ended
**When** its findings are handled
**Then** every finding is **triaged before the real auction opens** — fixed, or logged in `deferred-work.md` with the risk of opening without it stated
**And** the pilot's date, participants and outcome are recorded
**And** the dev project is **wiped and reseeded**, so no pilot data is mistaken for real data

### Story 9.8: Provision prod and run setup day for real

As the Commissioner,
I want the real auction to open on a project that has never been improvised on,
So that setup day is a rehearsal I have already done rather than one I am doing live.

**Acceptance Criteria:**

**Given** the pilot is complete and its findings triaged
**When** the prod project is created
**Then** the same thirteen migrations are applied **dev-first** (AD-26) — dev first even though dev already has them, because the order is the rule
**And** **nothing is typed into the prod dashboard**, ever
**And** prod's literal Supabase hosts are added to the CSP alongside dev's, still with no wildcard
**And** prod credentials are set in the Netlify **production context only**

**Given** the league
**When** it is seeded on prod
**Then** all thirty Teams and **all 31 Managers** are seeded — not just moderators — using the Story 9.4 script
**And** **every one of the 31 Managers is confirmed to hold a Discord account**, because FR-4 makes Discord load-bearing for access rather than convenience and an unregistered Manager cannot be let in later by any self-service path

**Given** setup day
**When** it is run for real
**Then** all thirty-one real Fantrax files are imported and promoted, and Minor League Eligibility is set
**And** the runbook from Story 9.6 is the thing being followed, and any place it fails is corrected in the runbook as it is found

**Given** the auction is about to open
**When** the go-live gate from Story 8.4 is run
**Then** it passes, or every unmet condition is **named in writing** alongside the decision to open anyway

---

## Epic 10: Chase two players with one slot

A Manager can hold one more outstanding Bid than they have room for, and enter as many minimum lotteries as their cap space allows — because the auction has to *finish*. The surplus is taken back automatically: when a win fills the last Slot, the leftover Bid is cancelled and the Auction it was on returns to whoever bid under it.

**Ships as one unit.** The allowance without the cascade lets a Team win a thirteenth Player, which is the invariant FR-37 exists to protect. Stories 10.1 and 10.2 widen what may be held; 10.3 and 10.4 take the surplus back. **No subset of this epic is safe to deploy alone**, and 10.1 must not reach production without 10.3 and 10.4 behind it.

### Story 10.1: The Outstanding Bid Allowance in the slots gate

As a Manager with one open slot and two players I want,
I want to chase both at once,
So that I am not idling for a day waiting on a close I cannot influence.

**Acceptance Criteria:**

**Given** a prospective Bid
**When** Roster Capacity is evaluated
**Then** it passes when `Projected Active/Bench Additions = 0`, **or** when the Team holds at least one Free Active/Bench Slot **and** `Projected Active/Bench Additions ≤ Free Active/Bench Slots + 1`
**And** the `+ 1` is a **named constant** beside `ACTIVE_BENCH_SLOTS` in `core/constants.ts`, never an inline literal
**And** the gate still takes the `BidState` and **not** the amount, so it remains structurally incapable of reading a Bid's size (AD-7, Story 2.7)

**Given** a Team at Roster Count 12 with no Free Minor League Slot and $40,000,000 of Cap Space
**When** it bids on a Player who is not Minor League Eligible
**Then** the Bid is **refused on capacity** — the free-slot precondition fails before the allowance arithmetic is reached
**And** §10 example 30 passes as a named test, including its statement of the arithmetic that *would* have admitted the Bid without the precondition

**Given** a Team at Roster Count 12 with a Free Minor League Slot
**When** it bids on a Minor League Eligible Player whose win that Slot absorbs
**Then** the Bid is **permitted** on the `Projected Active/Bench Additions = 0` branch, which needs no free Active/Bench Slot
**And** the pre-existing FR-37 carve-out is therefore unchanged by this story

**Given** any evaluation of the slots gate
**When** its outcome is returned
**Then** it carries `rosterCount`, `projectedAdditions`, `freeActiveBenchSlots`, the `allowance`, and `ceiling` of 12 — **on a pass and a refusal alike**, keeping the one-branch discipline Story 2.7 established
**And** the ceiling of 12 is still reported, because a refusal quoting only the allowance would imply a Team may hold thirteen players

**Given** a refusal or a pass on the slots gate
**When** the refusal panel words it
**Then** three distinct sentences exist and never collapse into one — passed (*"your 2nd of 2 permitted bids; Roster Count would be 10 of 12"*), refused at the allowance (*"this would be your 3rd outstanding bid; 1 free slot permits 2"*), and refused on the precondition (*"no free Active/Bench slot, so no bid is permitted"*)
**And** this satisfies UX-DR32, whose reason is that the first refusal resolves itself at the next close and the second lasts the whole auction

**Given** a Team at its allowance
**When** the Bid Board renders
**Then** its controls are disabled with *"at your allowance"* stated, **distinctly from** a Team at Roster Count 12 with no room at all
**And** both are stated on the board rather than discovered at submission, as Story 2.7 already requires

**Given** Roster Reserve
**When** a Team bids at its allowance
**Then** `Roster Count + Projected Active/Bench Additions` reaches 13 and the `max(0, …)` clamp correctly yields `$0`
**And** the clamp is documented as **reachable in ordinary play**, no longer a Commissioner-override-only safeguard

**Given** the §10 suite
**When** it runs
**Then** examples **29** and **30** pass as new named tests, examples **24** and **25** pass as rewritten, example **23** passes with its added capacity clause
**And** examples **18–22** are re-verified unchanged, per AD-25's instruction to re-check the block rather than only the ceiling cases

### Story 10.2: Lottery entries leave the slots gate

As a Manager with one open roster spot,
I want to enter every minimum-bid lottery on the board,
So that I am not rationing entries against an outcome I will probably lose.

**Acceptance Criteria:**

**Given** a Minimum-Bid Contention entry
**When** Roster Capacity is evaluated for any Bid
**Then** the entry contributes **nothing** to Projected Active/Bench Additions and does **not** consume the Outstanding Bid Allowance
**And** a Team may be a Contender in any number of open Contentions simultaneously

**Given** a Team entering or joining a Contention
**When** the entry is gated
**Then** it is permitted if the Team holds at least one Free Active/Bench Slot, **or** the Player is Minor League Eligible and the Team holds at least one Free Minor League Slot
**And** it is refused when neither holds, because the win would have nowhere to land

**Given** the money rules
**When** an entry is committed
**Then** FR-14's flat $1,000,000 per non-eligible Contention still reaches Committed Bids, and an eligible Contention still feeds Minors Exposure through Overflow Count — **both unchanged by this story**
**And** cap space is the **only quantitative limit**: a Team with $9,000,000 of Available Cap Space may hold nine non-eligible entries, and a tenth is refused **on money, not on capacity**

**Given** `Overflow Count` and `Active/Bench Overflow`
**When** they are computed
**Then** they are **two separately named derivations**, each stating in its own documentation which rule it serves — the money side counting Contention entries, the slots side excluding them
**And** a single shared call serving both gates is a **defect** (AR-40), notwithstanding that Story 2.7 deliberately shared one and documented the sharing as load-bearing
**And** the comment Story 2.7 left — that the two gates *"cannot disagree about the count"* — is replaced with one stating why they now must

**Given** the §10 suite
**When** it runs
**Then** example **34**'s entry half passes — six entries permitted against one free Slot, a tenth refused on money

### Story 10.3: Cancel the surplus commitment at Close

As a Manager whose roster has just filled,
I want my surplus bid stood down automatically,
So that I cannot win a thirteenth player and discover it on export day.

**Acceptance Criteria:**

**Given** an Auction Close that **reduces the winning Team's free Slots** — Active/Bench **or** Minor League
**When** the Close completes its placement
**Then** the cancellation cascade runs against that Team's remaining commitments
**And** **no other event triggers it** — not a Bid, not a Nomination, not a clock, and never a restoration

**Given** a Team over capacity after a Close
**When** the cascade runs
**Then** commitments are cancelled **one at a time, most recent first by log `seq`**, re-testing Roster Capacity (FR-37) and contention capacity (FR-18) after each
**And** it **stops as soon as the Team is within both** — nothing further is cancelled
**And** an eligible leading Bid a Free Minor League Slot can still absorb is left untouched however recent

**Given** a Close that leaves the Team still within capacity
**When** the cascade evaluates
**Then** **nothing is cancelled** — §10 example 31's first close, where a Team at Roster Count 11 holding two commitments remains within an allowance of two

**Given** a cancellation
**When** it is recorded
**Then** a `BidCancelled` compensating event is appended; the original `BidPlaced` is **never** deleted or mutated and remains a visible history line
**And** the cancelled Team's committed capital is released
**And** the Team is notified with **the win that caused it named**, not merely the fact of the cancellation

**Given** one Close's transaction
**When** its events are appended
**Then** `AuctionClosed` is written **first**, then each `BidCancelled` in the order the cascade decided them
**And** `close.ts` is the **sole appender** — `restore.ts` decides and appends nothing (AR-36)
**And** the whole effect is committed to the state the **next** Close is evaluated against (AD-11)

**Given** a Team at Roster Count 12 holding one Free Minor League Slot and three eligible Contention entries
**When** it wins one and the Player takes that last Minor League Slot at a $0 Cap Hit
**Then** Roster Count stays 12, `M` falls to 0, and the cascade **still fires** because a free Slot was reduced
**And** the two remaining entries are cancelled before their lotteries draw
**And** §10 example **35** passes — the case a trigger reading *"a Close that increases Roster Count"* would miss, and which would otherwise finish that Team at Roster Count 14

**Given** the schema
**When** `BidCancelled` is appended
**Then** **no migration is required** — `auction_events.event_type` is a generic `text` column (AR-36)

### Story 10.4: Restore the next-highest bidder

As a Manager who was outbid and then outbid again,
I want my bid to lead again when the bid above mine is cancelled,
So that the auction settles on what teams actually offered rather than on who happened to fill a roster.

**Acceptance Criteria:**

**Given** a cancelled leading Bid on an Auction in Standard Contention
**When** restoration runs
**Then** the **next-highest surviving Bid** becomes the leading Bid and that Team's capital is re-committed at that amount
**And** the restored Team is notified — it stopped watching this Auction and is being told it is winning again

**Given** a candidate for restoration
**When** it is re-validated
**Then** **only** the `cap` and `slots` gates run, declared in `core/types.ts` as the `RestoreLeadingBid` command type with its own fixed gate set (AR-37)
**And** it is **never** implemented as a synthetic `PlaceBid` — which would re-run the increment rule against a price that has just fallen and refuse every restoration that mattered
**And** the evaluation reads **post-close state**: after the triggering Close's placement and after every cancellation already decided in this cascade

**Given** a candidate that fails either gate
**When** restoration continues
**Then** that candidate is **skipped** and the next-highest Bid below is tried, and so on down the history
**And** a candidate is **never** restored and then cancelled — a restoration must not be able to trigger a cascade
**And** §10 example **32** passes: the second-highest bidder has itself reached Roster Count 12, is skipped, and the third-highest is restored at a lower price

**Given** an Auction where **no** surviving Bid passes
**When** restoration exhausts the history
**Then** the Auction returns to **Awaiting Opening Bid** with no leading Bid
**And** its **Auction Clock is cleared**, not left running — an Auction with no Bid has no Clock
**And** the Player stays on the Board, the nominating Team's Nomination Slot stays held (FR-9), and the Auction resolves as any unbid nomination does
**And** §10 example **33** passes, including its negative assertion: the Auction does **not** close at the cancelled bidder's old expiry with no winner

**Given** a restoration where a Bid survives
**When** the clocks are folded
**Then** the **Auction Clock is untouched** — the Auction closes when it always would have, and a Restored Leading Bidder may inherit very little time
**And** the **League Clock is not reset and no prior reset is removed**, which is the opposite of a Commissioner void (AR-39, AD-22)
**And** a reducer treating `BidCancelled` and `BidVoided` alike is a defect that would end the Auction Phase early every time a roster fills

**Given** the restoration decision
**When** it is recorded
**Then** the `BidCancelled` event carries the cancelled `seq`, the cause, and **either** the restored Team, Bid `seq` and amount **or** `null`
**And** the projection **reads** that recorded decision rather than re-deriving it by re-running gates inside a fold (AR-36, AD-31)

**Given** the selection algorithm
**When** it is implemented
**Then** it lives in **one** pure function in `core/rules/restore.ts` — walk the surviving history downward, re-evaluate, skip failures, stop at the first pass
**And** it is parameterised on the three axes that separate a cancellation from a void: retain-vs-erase in the fold, leave-vs-restore the Auction Clock, keep-vs-remove the League Clock reset
**And** **Story 7.2 consumes this function** rather than implementing its own; 7.2's specification is updated to cite it

**Given** the §10 suite
**When** it runs
**Then** examples **31**, **32** and **33** pass as named tests

### Story 10.5: A lottery whose contenders were cancelled

As a Manager reading a closed lottery,
I want the recorded contender list to be exactly who was eligible to win it,
So that I can still reproduce the draw by hand and satisfy myself it was fair.

**Acceptance Criteria:**

**Given** a Minimum-Bid Contention at Clock expiry
**When** the Randomizer draws
**Then** the recorded Contender list is the list **after** any FR-40 cancellations have been applied
**And** a cancelled Contender does not appear in it and cannot be drawn
**And** the Auction's history still shows that the Team entered and that its entry was cancelled, so the record stays complete

**Given** the recorded seed and Contender list
**When** a Manager reproduces the draw independently
**Then** it still yields the recorded selection — FR-20's verifiable-fairness contract is unchanged by this story
**And** every remaining Contender still has probability `1/n` over the post-cancellation list

**Given** a Contention whose Contender list is **empty** at expiry
**When** it closes
**Then** it closes with **no winner** and the Player returns to the Free Agent pool
**And** the empty list and the reason are recorded exactly as a drawn one would be
**And** the nominating Team's Nomination Slot is released as on any Close (FR-9)

**Given** several lotteries expiring in the same sweep with one Team contending in each
**When** the sweep runs
**Then** that Team winning the first is removed from the remainder **before** they are drawn, because each Close commits before the next is evaluated (AD-11)
**And** §10 example **34**'s draw half passes, including the lottery left with zero Contenders

### Story 10.6: Say it on the board and in Discord

As a Manager,
I want to know which of my bids is the one at risk before I place it,
So that losing it is a trade I chose rather than something the app did to me.

**Acceptance Criteria:**

**Given** a Bid that would be the Team's allowance Bid
**When** the bid control renders, **before** the confirm step
**Then** it states the trade in words: *"This is your 2nd of 2 permitted bids. If you win a player before this auction closes, this bid is cancelled and the next highest bid leads."*
**And** it is stated **once**, at the moment of the decision — not a warning dialog, not a checkbox, and not repeated on every later view (UX-DR34)

**Given** the persistent strip
**When** it renders on any surface
**Then** it carries bids against the allowance beside the roster figure — `Roster 9 of 12 · 2 of 4 bids`
**And** a Team at parity shows the figure alone with **no colour, badge or warning treatment** (UX-DR35)

**Given** a Teams index row
**When** it renders
**Then** it carries outstanding bids against the allowance, with open lottery entries counted **separately**
**And** the separation is preserved because entries consume no allowance and folding them in would imply a ceiling that does not exist (UX-DR36)

**Given** the refusal panel
**When** the slots gate reports
**Then** its sentence wraps to a second line rather than truncating, at line-height `1.6`, aligned to the sentence's first line (UX-DR33)

**Given** a cancellation
**When** the three parties are notified
**Then** the cancelled Manager's notice leads with the **cause** and then the effect, with no apology, no alarm styling and no congratulation wrapped around it
**And** the restored Manager's notice re-establishes context, then states what it costs their cap **and how long they have**, since the Clock did not reset
**And** the league channel carries one line in the existing register (UX-DR37)
**And** both mentions are carried by the **`outbid` category**, adding two new clauses to `clauseFor` in `adapters/discord/mention.ts` — **no fourth category is added**, and the mutable set stays exactly `slot_release` as Story 5.4 left it
**And** they are therefore **unmutable server-side** like every `outbid` mention: a posted request naming the category is refused with the stated wording, unchanged from Story 5.4
**And** the category's *name* now covers three things that are not literally an outbid — being outbid, having a Bid cancelled, and being restored — which is accepted deliberately: the category is the **"your position in an Auction changed without you"** class, and a Manager must not be able to mute the notice telling them they lost a Player through no act of their own

**Given** an Auction with a cancelled Bid
**When** its history renders
**Then** the cancelled Bid remains visible, struck through and labelled *cancelled*, with the causing win named — never deleted, hidden or reordered
**And** the copy distinguishes it from a void: a void says someone decided the Bid should not have stood, a cancellation says nothing of the kind (UX-DR38)

**Given** an Auction returned to Awaiting Opening Bid
**When** the board renders it
**Then** it renders as an **unbid nomination**, the state the board already has a treatment for, rather than a new "restarted" state
**And** its history remains, so it reads as an Auction a Team led and then did not

**Given** Your Positions
**When** a Manager opens it after a cancellation
**Then** the won Player appears in the won group, the cancelled Auction has left the leading group, and the released capital is reflected in Available Cap Space — with nothing for the Manager to reconcile by hand

---
