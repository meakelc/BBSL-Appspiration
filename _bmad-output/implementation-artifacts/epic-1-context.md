# Epic 1 Context: Setup day — the league's data in, the auction open

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Take the product from an empty repository to a live auction: a deployable skeleton with design tokens in place, Discord sign-in with server-bound Team and Commissioner identity, the append-only event log and projection machinery, a phase-and-role-gated destination list, the thirty-one-file Fantrax import (staged, previewed, promoted atomically), Commissioner-set Minor League Eligibility, and the gate that opens the auction. It also lays the foundations every later epic builds on — the pure rules core, branded integer money, one global write lock, migrations-only schema change, no client write path. Its defining moment is the app refusing the Commissioner's own import and naming the offending row. Every surface here is specified in prose with no visual mock, making it the build's highest design-drift risk.

## Stories

- Story 1.1: Deployable skeleton on the pinned stack
- Story 1.2: The pure core boundary and integer money
- Story 1.3: Sign in with Discord
- Story 1.4: Teams, Managers, and the Commissioner role
- Story 1.5: The append-only log and the transactional write path
- Story 1.6: One destination list, gated by phase and role
- Story 1.7: Import thirty Team roster files
- Story 1.8: Import the Free Agent pool
- Story 1.9: Per-Team preview and atomic promotion
- Story 1.10: Set Minor League Eligibility by hand
- Story 1.11: Open the auction

## Requirements & Constraints

- **The import is thirty-one files, not two** — one Free Agent pool export plus one roster export per Team, droppable as a single batch, with per-file parse status persisting across a refresh or a closed tab and a re-supplied file replacing only that Team's rows.
- **Two refusal altitudes, visibly distinct.** A *file* is refused by name (matches no Team, or a Team already supplied); a *row* is refused by row (missing column, unresolvable ID, negative Cap Space, breached slot ceiling).
- **Anything outstanding is named, never counted** — on the import status list and the auction-open gate alike. A count is useless at 11am on setup day.
- **Promotion is all-or-nothing** across all thirty-one sources; a partially imported League is never a reachable state. Re-import is allowed in Setup and refused once the auction opens.
- **Minor League Eligibility is app-owned, not imported.** Default is *not* eligible, so omission fails safe rather than granting unbounded bidding. Settable individually and in bulk during Setup, locked after open, every change audited.
- **Identity is Discord OAuth only** — pre-registered accounts, no self-service registration, sessions ≥30 days. No email field exists anywhere and the system sends no email for any purpose. An unregistered account is refused without disclosing whether that identity or any Team exists and without a probeable retry loop; an expired session is a distinct, explicitly stated outcome from a fresh sign-out. A Commissioner sign-in independent of Discord must exist, unadvertised but reachable, because Discord carries both authentication and notification.
- **The Commissioner's own Team is subject to every ordinary rule** without exception, and league constants live in code with no admin UI able to edit them.
- **Accessibility floor:** WCAG 2.1 AA; state is never conveyed by colour alone — a greyscale screenshot of any surface must stay fully readable, and that is the acceptance test. Touch targets ≥44px; a disabled control always states its reason.

## Technical Decisions

- **Functional core / imperative shell.** The core is pure — no clock, database or randomness, stdlib only, relative `.ts` imports so one source loads under both runtimes — enforced by a CI purity check. Two entry points only: `evaluate()`, returning a fixed gate set per command type, and `decide()`, which calls `evaluate()` rather than re-deriving its outcomes.
- **Money is integer dollars, branded at every runtime boundary** — the same `int8` arrives as a string through one client and a number through the other, so both parse at the edge. Rendered `$14.5M`, exactly one decimal never dropped, true minus sign for negatives, failing loudly rather than rounding off the $500k grid. That renderer serves the UI and Discord and must be structurally unable to reach a CSV cell.
- **The event log is insert-only** — no role holds UPDATE or DELETE, not the service role, not the Commissioner; corrections append compensating events. Every event carries a database-assigned monotonic sequence number, timestamp, schema and core versions, acting Manager and Team, plus the measurement fields, which must be present from the first event because an insert-only log cannot be backfilled.
- **Projections fold by sequence number, never by timestamp** — a transaction queued on the lock commits later while holding an earlier timestamp. Folds run only inside the transaction that appends, and a full rebuild must be possible at any time and idempotent. This epic delivers the fold-and-rebuild machinery only; projection tables are created by the story that first reads them.
- **One global advisory transaction lock, one named constant, one arity**, taken before reading any state — the one- and two-argument forms occupy disjoint lock spaces, so mixing them is a silent total failure. Shell order is lock → load → decide → persist → enqueue, with `now` from the database clock at transaction start.
- **No client write path.** No client-facing role holds any write privilege; the browser key is read-only for Realtime. Every table carries an explicit row-level policy, anonymous roles read nothing, and server secrets never sit behind a client-inlined env prefix.
- **Team binding and the Commissioner flag resolve server-side from application tables the Commissioner alone writes** — never from auth metadata or any client-influenceable claim, which is self-writable. Commissioner-only routes refuse server-side; hiding UI is never the check.
- **Phase is a projection folded from the log, never a hand-set flag**; with no events it folds to Setup. Phase and role resolve server-side per request and produce *one* destination list rendered twice (strip sheet, header menu); a destination not live is not rendered *and* its route refuses server-side.
- **All Fantrax knowledge sits in one adapter module.** Rows join on the stable Fantrax player ID, never on name; the adapter never derives, infers or fails on eligibility; the core receives domain types with no notion of a file. Rows stage keyed by Team, with the pool as one distinguished source keyed by pool. Eligibility changes are recorded as events, not column updates, so a rebuild reproduces the flag as it stood at each point.
- **Schema changes are migration files applied dev-first** across exactly two projects — a wipeable dev and a production never touched by hand. The stack is pinned, the build fails on drift, and the source tree matches the specified layout exactly.
- **Glossary terms are the identifier names, verbatim** — a synonym is a defect. A three-letter capitalised abbreviation always and only means a player's real-life NBA team; a fantasy Team is spelled out with the acting Manager attached.

## UX & Interaction Patterns

- **Design tokens are declared verbatim** from the design frontmatter as CSS custom properties — every colour, both type families, the type scale, the radius, every named spacing and component dimension — with tabular numerals defaulted in every numeric context. **No light-theme declaration of any kind.** No elevation or shadows; depth is a 1px border and a surface one step above the ground. No emoji, and icons never appear without a word.
- **The Commissioner control class** is established here, differing from a Manager control by four independent non-colour properties — never filled, dashed border, its own recessed ground, a persistent "visible only to you" label — inline and content-width, with an automated greyscale check proving they stay distinguishable without colour.
- **Voice:** refusals state the fact, then the arithmetic. No apologies, no exclamation marks. Reassure about state, not feelings. Where a control has a non-obvious rules consequence, say it in a sentence rather than showing a bare checkbox. Never advise, never manufacture urgency.
- **Confirm before commit** — the import preview and the open gate are both explicit confirmations. Every sign-in surface states the current phase from the same server-resolved source as every other surface, and an empty just-opened board is a designed screen pointing at Nominate. 375px is the design width and the smallest supported; the status list and per-Team preview expand on desktop while staying fully operable at 375px.

## Cross-Story Dependencies

- 1.1 and 1.2 are foundational: the tokens and Commissioner control class are first consumed by 1.7 and 1.10, and the money type and constants are needed by every import, cap and gate computation.
- 1.5's log and projection machinery underpins 1.6's phase projection, 1.10's eligibility events and 1.11's open event — which is what folds the phase from Setup to Auction. 1.3's identity and 1.4's binding are prerequisites for 1.6's gating and the actor fields every event carries.
- 1.7, 1.8 and 1.9 form the import chain; 1.11's gate requires all thirty-one sources promoted plus every Team bound to a Manager from 1.4.
- **Deliberately out of scope:** the override path and its reason sheet (Epic 7). 1.10 locks eligibility after open and states an override is required, but builds no override path and depends on none. Downstream, Epic 2's rules engine builds on 1.2's core boundary and Epic 8's time-compressed rehearsal on 1.5's injected time.
- **Open action before setup day:** obtain a real Fantrax export and confirm the salary and roster-slot columns against the adapter's mapping. The eligibility flag is settled as absent.
