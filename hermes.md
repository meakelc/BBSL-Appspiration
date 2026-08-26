# hermes.md — working guide for BBSL-Appspiration

Orientation for any agent or human picking this repository up. Read this first, then the
document it points you at. It is a map, not a rulebook — the rulebook is `ARCHITECTURE-SPINE.md`.

Verified 2026-08-20 against `38373fc`.

**Relationship to `AGENTS.md`:** `AGENTS.md` is the short block agents load automatically; it is
managed by the `bmad-project-context` skill and edits inside its `<!-- bmad:context -->` markers
are replaced on refresh. This file is unmanaged, longer, and safe to edit by hand. Where the two
overlap, `AGENTS.md` is the one that gets read first — keep them consistent, and prefer fixing
`AGENTS.md` by re-running its owning skill rather than editing the block directly.

---

## 1. What this is

**Appspiration** — the BBSL offseason free agent auction. A private app for one 30-team dynasty
fantasy basketball league, live for one offseason phase per year. It runs an open ascending
auction on a rolling 24-hour clock: nominations, bids validated against a hard salary cap and a
hard 12-slot roster ceiling, a $1,000,000 minimum-bid lottery, contract-length assignment against
a Year Allotment, and a CSV export the Commissioner uploads back into Fantrax by hand.

The builder is also the Commissioner and a competing manager. That single fact drives the whole
design: **auditability is structural, not decorative**. Rule correctness is the product; a rules
bug is a worse failure than an outage. Scale is not a concern — 31 users, ~30 concurrent auctions,
a few thousand events.

**The stack is pinned exactly and the build fails on drift.** SvelteKit 2.70.2 (not 3.x),
`@sveltejs/adapter-netlify` 6.0.4 with `edge: false`, TypeScript strict + `noUncheckedIndexedAccess`,
Node 24 LTS, Deno for the Supabase Edge tick, Supabase-managed Postgres >= 15.1.1.61, Netlify free
tier. Zero budget — stacked free tiers with no SLA between them.

---

## 2. Document hierarchy — who wins when two documents disagree

Read down this list. Anything higher wins.

1. `_bmad-output/planning-artifacts/architecture/architecture-BBSL-Appspiration-2026-08-16/ARCHITECTURE-SPINE.md`
   — **the rulebook.** 30 numbered architecture decisions, AD-1 … AD-30, binding in full. Read the
   ADs a change touches *before* writing code, and cite them by number in comments as the existing
   source does. Also holds the Consistency Conventions table, the pinned Stack table, and the
   canonical source tree.
2. `_bmad-output/specs/spec-BBSL-Appspiration/SPEC.md` — the canonical contract. 20 capabilities
   (CAP-1 … CAP-20), the constraints that bend decisions before you open the spine, and the
   non-goals. Its `companions:` frontmatter lists the rest of the contract.
3. `_bmad-output/planning-artifacts/prds/prd-BBSL-Appspiration-2026-08-16/prd.md` (+ `addendum.md`)
   — FR-1 … FR-39, the NFR set, the §3 glossary, and **§10 rule-resolution examples 1–28, which
   are the executable specification** (AD-25).
4. `DESIGN.md` (colour, type, component anatomy, measured contrast ratios) and `EXPERIENCE.md`
   (information architecture, state patterns, key flows), under
   `_bmad-output/planning-artifacts/ux-designs/ux-BBSL-Appspiration-2026-08-17/`.
   **Where a mock disagrees with either, the spine wins; where either disagrees with an AD, the
   spine wins.**
5. `mockups/*.dc.html` — reference only. Lowest authority. `.working/` is scratch, ignore it.

`_bmad-output/planning-artifacts/epics.md` is the implementation map: the FR coverage map, all 8
epics, and every story with its acceptance criteria. `traceability.md` maps FR → CAP → epic.

---

## 3. Current state

**Epic 1, Story 1.1 — `feat(1.1): deployable skeleton on the pinned stack` (`f6f7be4`) — is
implemented and the story file reads `status: done`, but `sprint-status.yaml` still has it at
`review`. Treat the review pass as outstanding; that is the next thing to finish.** The two files
disagree, and `sprint-status.yaml` is the authority — do not read the story's own `status: done`
as evidence the review happened.

Everything else — Epics 1.2 through 8.4, 52 stories — is `backlog`. Nothing but the skeleton
exists yet: `src/lib/core/{money,constants,types}.ts` are typed stubs, `rules/` and `projection/`
are `.gitkeep` only, there is no schema, no auth, no route beyond a placeholder page.

Story status lives in `_bmad-output/implementation-artifacts/sprint-status.yaml` — that file is
the authority on what is done, not this one.

### Branches in flight

**None.** `main` (`38373fc`) is the single branch; the three branches that were open on 2026-08-19
— `ci/test-and-typecheck`, `chore/gitattributes`, `docs/agent-instructions` — are all merged and
deleted. CI is green on main.

### Infrastructure

- **Netlify: provisioned and live.** The site is `bbslapp`, serving at
  `https://bbslapp.netlify.app` (HTTP 200, serving the built SvelteKit app). Deploy previews,
  header-rule and redirect-rule checks run on every pull request. The branch-to-environment
  mapping is committed in `netlify.toml`; whether it is *also* configured correctly account-side,
  and the credit cost of that configuration, are unverified.
- **CI: live.** `.github/workflows/ci.yml` runs `npm ci`, `npm test` and `npm run check` on every
  push to `main` and every pull request. Actions are pinned to commit SHAs, not tags.
- **Supabase: unverified — assume not provisioned.** Both projects (wipeable dev, never-hand-touched
  prod) need the Commissioner's own account. There is no `supabase/config.toml`, no migration, and
  no local `.env`, so nothing in the repository proves either project exists. This blocks Story 1.5,
  which is the first to apply a migration. Check before planning that story.

---

## 4. Workflow — BMAD

This project is driven by the BMAD suite, installed per-project at `_bmad/` with the agent skills
under `.claude/skills/bmad-*`. Planning (PRD, architecture, UX, spec, epics) is complete. The build
loop is now:

1. `bmad-create-story` — write the next story spec into `_bmad-output/implementation-artifacts/`.
2. `bmad-dev-story` — implement it. Story moves to `review`.
3. `bmad-code-review` — **fresh context, and a different model than the one that implemented it.**
4. `bmad-sprint-status` / `bmad-retrospective` at epic boundaries.

**Rules:**

- **Never hand-edit `_bmad-output/`.** The `bmad-*` skills own that tree. Run the owning skill.
  The one exception is `epic-1-context.md`, which is explicitly marked "edit freely."
- **Never commit to `main`** — branch, then PR.
- Story order inside Epic 1 is not arbitrary: 1.1 and 1.2 are foundational, 1.5's log and
  projection machinery underpins 1.6, 1.10 and 1.11; 1.7–1.9 are the import chain. Cross-story
  dependencies are spelled out at the bottom of `epic-1-context.md`.

### Subagent model tiers — where they live and why they must stay tracked

Every BMAD subagent this project spawns runs at a deliberately chosen model tier, not the
session's. Two halves, and **both are required** — if either goes untracked, every subagent
silently reverts to the session model and the only symptom is the bill:

- `.claude/agents/*.md` — one file per role, `model:` in the frontmatter, reasoning in the
  body. Un-ignored explicitly in `.gitignore` (note it excludes `.claude/*`, not `.claude/`,
  because git will not descend into an excluded *directory* to honour a `!` re-include).
- `_bmad/custom/bmad-*.toml` — **team-scoped, not `.user.toml`.** `_bmad/custom/.gitignore`
  excludes `*.user.toml` for personal preference; these are cost architecture and are named
  without the `.user` segment so they survive a clone.

Current tiers: recall layers (Blind Hunter, Edge Case Hunter, Verification Gap) sonnet;
step-02 investigators sonnet; validation-gate recall lenses sonnet; Intent Alignment opus;
Acceptance Auditor **chosen per story** from `BMAD-EFFORT-TRIAGE.md` — Safe rows get sonnet,
Tier A/B and anything unlisted get opus. The implementer stays on the session tier on
purpose (see that file's closing section for the loopback argument).

Verify a change to any of this with the resolver — never assume the merge did what you
expected, since `id` matching **replaces the whole table rather than deep-merging keys**:

```
uv run --no-cache _bmad/scripts/resolve_customization.py --skill .claude/skills/bmad-build --key workflow
```

Then re-render, because a rendered snapshot is frozen at activation and a running session
keeps the generation it started with:

```
uv run --no-cache _bmad/scripts/render_skill.py --project-root . --skill .claude/skills/bmad-build
```

`BMAD-EFFORT-TRIAGE.md` is now load-bearing configuration rather than advice — re-running
the triage at an epic boundary changes what reviews cost.

---

## 5. Commands

```
npm test          # vitest run — collects tests/**/*.test.ts only, node environment
npm run check     # svelte-kit sync && svelte-check, strict + noUncheckedIndexedAccess
npm run build     # node scripts/check-pins.js && vite build — the drift gate runs FIRST
npm run dev       # vite dev
npm run check:pins
```

Baseline as of `38373fc`: **183 tests across 4 files pass; svelte-check reports 0 errors,
0 warnings.** CI runs both on every push to `main` and every pull request — but `npm run build`
runs neither, so a green build proves nothing about the suite. Run both locally before calling a
change done.

Coverage gaps to know about:

- `npm run check` does **not** cover `scripts/`. The resolved tsconfig `include` is `src/**` and
  `tests/**` only, so `scripts/check-pins.js` is never type-checked despite `checkJs`.
- Vitest collects `tests/**` only, in the `node` environment. A test placed beside its source
  under `src/` is silently never run, and **no `.svelte` file can be rendered in a test** — there
  is no jsdom or browser project yet.

---

## 6. Invariants you must not break

These are the ones that get violated by accident. Each maps to an AD; read the AD before working
in its area.

- **The core is pure** (AD-1, AD-2). `src/lib/core/**` reads no clock, no database, no random
  source, and imports nothing outside the TypeScript stdlib. No `$lib` alias, no bare specifiers,
  no `node:` builtins, no `process`. **Relative imports carry an explicit `.ts` extension** so the
  identical files load under Deno. One core directory, two runtimes, never forked or
  re-implemented in SQL.
- **Two rules entry points, and only two** (AD-1). `evaluate(state, command, now) → GateResults`
  is total and returns *every* gate's outcome with its own arithmetic, gate set fixed per command
  type. `decide(state, command, now, seed)` returns `Accepted<Event[]> | Rejected<GateResults>` and
  **obtains its gates by calling `evaluate()`, never by re-deriving them.** A rejection is a
  returned value, never a thrown exception. Exceptions signal bugs only. This governs the *rules*
  surface, not the whole directory — `core/money.ts` is pure arithmetic reached by neither.
- **Money and slots are two independent gates and neither short-circuits the other** (AD-7,
  CAP-19). Every bid runs both Maximum Bid and Roster Capacity, with distinct machine-readable
  reasons and distinct arithmetic. A refusal reports the gate that **passed** alongside the one
  that refused. An unbounded Maximum Bid exempts nothing from the 12-slot ceiling. Reporting a
  capacity refusal as a cap refusal is a defect.
- **Money is integer dollars, branded at every runtime boundary** (AD-8). No floats, no cents, no
  decimal library. `int8` deserialises as a `string` through node-postgres and a `number` through
  PostgREST, so both edges parse explicitly into the branded type. Rendered `$14.5M` — always
  exactly one decimal, never dropped — in the UI and Discord. **That rendering must be structurally
  unable to reach a CSV cell**; exports emit exact integers. Every derived and aggregate figure
  must land on the **$500,000 grid** — that is why League Median is the *lower* middle value.
- **Derived money is never stored** (AD-7). Available Cap Space, Committed Bids, Minors Exposure,
  Overflow Count, Roster Reserve, Projected Active/Bench Additions and Maximum Bid are computed at
  validation time against the hypothetical state *if the prospective bid were accepted*. A
  displayed figure is a rendering; only a freshly computed figure authorises a bid.
- **The event log is insert-only for every role, the Commissioner included** (AD-4). No UPDATE, no
  DELETE, not even for the service role. Corrections append compensating events. The Audit Log is
  a read of that table, not a second table. Measurement fields (device class on bids/nominations,
  dispatch and delivery outcome on notifications) must be captured **from the first event onward** —
  an insert-only log cannot be backfilled.
- **Projections fold by `seq`, never by `occurredAt`** (AD-5). A transaction queued on the lock
  commits later while holding an earlier timestamp. Folds run only inside the transaction that
  appends. A full rebuild must be possible at any time and idempotent.
- **One global advisory lock, one named constant, one arity** (AD-6). `pg_advisory_xact_lock`
  before reading any state, key defined once in `core/constants.ts`. Postgres' one- and two-argument
  forms occupy **disjoint lock spaces** — mixing arities is a silent, total failure. Per-auction
  locking is insufficient: the *team* is raced, not the auction.
- **Time is injected, never ambient** (AD-3). `now` comes from the database clock at transaction
  start. The server persists absolute close timestamps; clients render countdowns from them and
  never receive "seconds remaining." In a close sweep, `now` for each auction is **that auction's
  own nominal expiry** — a late sweep must produce late closes, never wrong ones.
- **No client write path** (AD-9). No client-facing role holds INSERT/UPDATE/DELETE on any table.
  The browser key is read-only, used solely for Realtime. Team binding and the Commissioner flag
  resolve server-side from application tables — **never from JWT app-metadata**, which Supabase's
  `updateUser` makes self-writable. Hiding UI is never the check; the route refuses server-side.
- **Schema changes are migration files, applied dev-first** (AD-26). Nothing is typed into the
  Supabase dashboard. Two projects total — the free tier's cap — so there is no third environment
  and the discipline is load-bearing rather than tidy.
- **Glossary terms are the identifier names, verbatim** — `committedBids`, `minorsExposure`,
  `rosterReserve`, `maximumBid`, `overflowCount`, `freeMinorLeagueSlots`, `minorLeagueEligible`.
  **A synonym is a defect.** A three-letter capitalised abbreviation always and only means a
  player's real-life NBA team; a fantasy Team is spelled out with its Manager — `Lakers — Meakel`.
- **PRD §10 examples 1–28 are the executable specification** (AD-25). Each is a named test in
  `tests/examples/` calling the core directly — no database, no HTTP, no clock mocking, no fixtures
  beyond a state literal. **A rule change that alters any example's outcome changes the PRD in the
  same commit.** The suite is green before any production deploy.
- **Accessibility is the acceptance test, not a checkbox.** WCAG 2.1 AA; state is never conveyed by
  colour alone — every state carries a word **and** a shape, and a greyscale screenshot of any
  surface must stay fully readable. Touch targets >= 44x44px on every bidding and nomination
  control. A disabled control always states its reason. Contrast is measured, not asserted.
- **No urgency design.** No countdown pressure, no one-tap raise without confirmation, no suggested
  bid amount. The app's posture is referee, not croupier. Refusals state the fact, then the
  arithmetic — no apologies, no exclamation marks. Reassure about state, not feelings.
- **Dark theme only.** No `prefers-color-scheme: light` block, no light token set, anywhere. No
  shadows or elevation — depth is a 1px border and a surface one step above the ground. No emoji;
  icons never appear without a word. 375px is the design width and the smallest supported.

Two numbers that changed on 2026-08-17 and are easy to carry a stale copy of: a bid is a whole
multiple of **$500,000** (not $100,000), and a Team has exactly **12** Active/Bench Slots — a
ceiling, not just a floor.

---

## 7. Known traps in the current code

Every one of these is already logged with evidence in
`_bmad-output/implementation-artifacts/deferred-work.md`. **Check that file before proposing work,
and do not build a deferred item unprompted** — most are deliberately assigned to a later story.

- **`tests/structure.test.ts` is built to fail on a correct change.** It asserts a `.gitkeep` is
  present in nine AR-2 directories, but each marker should be deleted the moment a real file lands
  there. Story 1.5 is the first to trip it. Leave the marker until that test is fixed.
- **`structure.test.ts`'s stated ".ts imports only" rule is not actually asserted.** It checks a
  hardcoded three-file list; `from './money'` and `from './money.js'` both pass, and both fail to
  load under Deno. `core/rules/` and `core/projection/` are never scanned. Story 1.2 owns the real
  purity check.
- **`tests/tokens.test.ts` reads `DESIGN.md` out of `_bmad-output/` at module load.** The path
  resolves by glob, but the token suite depends on the planning directory staying committed and
  never moving.
- **`DESIGN.md:229` and the implementation disagree.** Story 1.1 corrected `--control-fill` from
  `#223028` to `#1D2922` because the original measured 2.77:1 against the control boundary, below
  WCAG 1.4.11's 3:1. `DESIGN.md` is `status: final` and still carries the failing value. The
  correction has not been folded back at source.
- **The Commissioner label is CSS-generated (`::before`)** so no call site can omit it — but it
  cannot be translated or selected and vanishes if the stylesheet fails to load. The durable fix is
  a Svelte component with `aria-describedby`, assigned to Story 1.7.
- **No `+error.svelte`**, so an error renders on the browser default white background, outside the
  dark-only contract.
- **No `supabase/config.toml`**, so `supabase start`, `db push` and `functions serve` cannot run
  locally. Belongs with Story 1.5.
- **No security headers.** `netlify.toml` declares no headers block and `svelte.config.js` sets no
  `kit.csp`. CSP, frame-ancestors, Referrer-Policy and a noindex posture should land before the
  first auth surface in Story 1.3. Note the site is already publicly reachable at
  `bbslapp.netlify.app`, so the noindex half is live-relevant now, not later.
- **No README.** The repo ships a Discord OAuth app, a webhook, an out-of-band Commissioner
  recovery secret and a cron-invoked Edge Function with no setup path documented. Much of the
  current reasoning lives in `.gitkeep` comments that get deleted the moment those directories
  receive real files.

`deferred-work.md` is **append-only by skill design** — `bmad-build` and `bmad-code-review` both
say "append one new entry… do not modify existing entries," and no skill in the suite prunes or
resolves anything. So entries there are never struck; status is recorded as an annotation line
(`resolved:` / `partial:` / `verified:` / `escalated:`) beneath the original, which is left intact.
Current annotations, all dated 2026-08-20:

- **CI — `resolved`.** `.github/workflows/ci.yml` closed it.
- **Netlify — `partial`.** The site is live; account-side environment mapping and credit cost are
  still unconfirmed.
- **tsconfig / `scripts/` — `verified`.** The suspicion is confirmed (`tests/` covered, `scripts/`
  not), but the remedy — an explicit `include` — is still outstanding.
- **Security headers — `escalated`.** Confirmed absent on the live public site.

The `npm ci` entry is **not** resolved: it concerns the *Netlify* build command, which still runs
`npm run build`. The `npm ci` in CI is a different builder.

---

## 8. Single points of failure, accepted knowingly

- **Discord is both the only identity provider and the only outbound transport.** Its failure is
  total. Three mitigations are mandatory, not optional: sessions persist >= 30 days; a Commissioner
  sign-in that does **not** depend on Discord exists (`COMMISSIONER_RECOVERY_SECRET`); and liveness
  alerting does **not** route through Discord, since it may need to report that Discord is down.
  **No email is sent by this system for any purpose.** There is no email field anywhere.
- **The Supabase free tier has no automatic backups, no PITR and no SLA** (AD-21). A scheduled
  export of the event log plus the reference data a fold needs must run to a third failure domain
  for the duration of the Auction Phase, and the restore must be **rehearsed** before the auction
  opens. A Discord incoming webhook is write-only and is not a restore path.
- **Free-tier quota burn is a silent-outage source** (AD-19). Netlify credits (300/month;
  exhaustion pauses the site) and Supabase Edge invocations (500K/month, shared org-wide;
  exhaustion stops the tick) are both alerted on well before their ceilings, by a detector outside
  both vendors that shares no component with the outbox path it reports on.
- **Availability is a posture, not a percentage.** No uptime figure is committed to. The
  requirement is that an outage be survivable rather than decisive: late closes instead of wrong
  ones, a reachable pause, a restorable auction. Anything beyond 15 minutes is a pause plus a
  compensating clock adjustment, not wait-and-see.

---

## 9. Open action before setup day

Obtain a real Fantrax export and confirm the salary and roster-slot columns against the adapter's
mapping. The import is **thirty-one files** — one Free Agent pool export plus one roster export per
Team — not two; that defect was invisible in every requirements review and obvious the moment
someone described their actual morning. The Minor League Eligible flag is settled as **absent**
from the export: it is Commissioner-set application data, defaulting to *not* eligible so omission
fails safe.
