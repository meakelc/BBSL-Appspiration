---
title: 'Story 1.6: One destination list, gated by phase and role'
type: 'feature'
created: '2026-08-22'
status: 'done'
baseline_commit: 'c213640324a22e0511efb5517cf7dd9f67e23612'
review_loop_iteration: 3
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `resolveLeaguePhase()` (`src/lib/server/phase.ts`) still hardcodes `phaseOf('Setup')` — Story 1.5's placeholder, never wired to the event log it built. No navigation exists at all: no header, no menu, no route guard. AD-30 requires phase and role to gate one server-resolved destination list, rendered identically everywhere, with every route refusing independently of the nav.

**Approach:** Replace `resolveLeaguePhase`'s body with a real fold over `auction_events` (AD-5/AD-24), using a new pure phase reducer. Add a server-only destination catalog — the phase table from `EXPERIENCE.md`/epics.md Story 1.6, literally — plus a resolver and a reusable server-side guard (mirroring `requireCommissioner`'s zero-call-site precedent). Wire it into a new root layout that renders one header menu; the persistent strip itself is Story 4.2's build, so only the header menu ships now, backed by a list component 4.2 can point a second trigger at later.

## Boundaries & Constraints

**Always:** Phase resolves via `fold(INITIAL_PHASE, events, phaseReducer)` (AD-5) over the full `auction_events` log, ordered by `seq`; zero events folds to `Setup`. Phase and the viewer's role resolve server-side, once per request, in `hooks.server.ts` / `+layout.server.ts` — never client-side. `resolveDestinations(phase, session)` is the one function both the header menu and (later) the strip's sheet call; there is no second implementation. Every destination not live for the resolved phase/role is absent from the rendered list, and a reusable `requireLiveDestination` guard exists so any future route can refuse server-side independent of the nav (same pattern as `commissioner-guard.ts`, unit-tested with no live call site yet — no route in this story needs to call it, since only Sign-in exists today and it isn't phase-gated). Every sign-in-adjacent surface keeps stating phase from `locals.phase`, unchanged.

**Ask First:** none — the one open scope question (the ownerless "Manager registration" destination) is resolved: it is a stub catalog entry with no route, logged in `deferred-work.md`.

**Never:** No persistent strip (Story 4.2's build) — the header menu is the only nav trigger this story ships. No pages for Import, Minor League Eligibility, Manager registration, or the auction-open gate — those are 1.7-1.11's stubs; this story's catalog entries point at routes that don't exist yet. No materialized phase-projection table — the log is empty-to-tiny through all of Epic 1, so a per-request full fold is correct and simple; a persisted table is a later optimization if ever needed. No component-render test harness (already tracked in `deferred-work.md`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No events yet | `auction_events` empty | phase folds to `Setup` | N/A |
| Unrecognized event type | any event whose `type` the reducer doesn't recognize | phase unchanged (reducer default case) — true today since no domain event type exists yet | N/A |
| Full rebuild vs incremental | same events, folded from empty vs. folded onto an already-advanced state | converge on the identical phase (AD-5) | N/A |
| Registered Manager, non-Commissioner | `session.kind === 'registered'`, `isCommissioner === false` | sees phase's Manager-visible destinations only | Commissioner-only entries absent, not disabled |
| Registered Commissioner | `isCommissioner === true` | sees Manager entries plus Commissioner-only entries for that phase | N/A |
| Not registered (signed-out/unregistered/expired/discord-unavailable) | any non-`registered` `SessionState` | destination list is `[Sign-in]` only, every phase | N/A |
| Guard called for a live destination | matching phase/role | returns normally | N/A |
| Guard called for a non-live destination | wrong phase or role | throws `error(403, ...)`, stating the fact | N/A |

</frozen-after-approval>

## Code Map

**Comment style note (review-loop-iteration 2):** the prior pass's code comments named "review-loop-iteration 1" and "human-confirmed" directly in shipped files (`destinations.ts`, `signin-surface.test.ts`). That provenance belongs in this spec's Change Log, which is durable and legible without this specific review's context — not in code comments meant to outlive it. State the *rule* and its *rationale* in code (why Setup is Commissioner-gated, why Sign-in is excluded for registered sessions), not the fact that a review round produced it.

- `src/lib/core/projection/phase.ts` -- new: pure `Reducer<LeaguePhase>` (`fold.ts`'s `Reducer<State>`) plus `INITIAL_PHASE: LeaguePhase = 'Setup'`. Its `switch` on `event.type` has no real case yet — falls through to `state` unchanged — and is the exact extension point Story 1.11's `AuctionOpened` (and later phase-transition events) fill in. Part of the PURE core (AD-2): no I/O, relative `.ts` imports only.
- `src/lib/shell/write.ts:145` -- export `toAppendedEvent` (currently private) so the new event-log reader below reuses the same row-mapping discipline instead of a second copy.
- `src/lib/server/event-log.ts` -- new: `loadAppendedEvents(client: SupabaseClient): Promise<AppendedEvent[]>` against `auction_events` through the service-role client (reads may query directly per the spine's Database access convention; `service_role` already holds `SELECT`, granted in 1.5), mapped via the reused `toAppendedEvent`. **Paginate rather than a single unbounded `select('*')`**: loop `.range(offset, offset + PAGE_SIZE - 1).order('seq')`, accumulating pages until a page returns fewer than `PAGE_SIZE` rows (review-loop-iteration 1 — a single unbounded select relies on PostgREST's row cap never being hit, and hitting it arrives as a successful *partial* response, silently truncating the fold below "the full log"). **Guard the response shape** (review-loop-iteration 2): if `data` is non-null but not an array, throw the same descriptive `auction_events read failed` error rather than letting `rows.push(...page)` throw an opaque non-iterable error.
- `src/lib/server/phase.ts:44` -- replace `resolveLeaguePhase()`'s body as before (loads events, `fold(INITIAL_PHASE, events, phaseReducer)`, wraps via `phaseOf`; throws on a read failure, unchanged from review-loop-iteration 1). **Add `async function resolveLeaguePhaseOrDefault(client = serviceRoleClient()): Promise<ResolvedPhase>`, new at review-loop-iteration 2** — calls `resolveLeaguePhase`, catching any error and returning `phaseOf('Setup')` on failure. The prior pass put this exact `try`/`catch` inline in `hooks.server.ts` instead, which is documented as untestable by its own module header ("the test suite cannot import it") — so the fail-closed behavior this story's own AC requires had zero test coverage and could not get any without this split. `hooks.server.ts` now calls `resolveLeaguePhaseOrDefault` and never sees the throw; `resolveLeaguePhase` stays exported, throwing, for any caller that wants the raw failure. Both are injectable-client, same shape as `managerRegistry(client = serviceRoleClient())`.
- `src/lib/server/destinations.ts` -- new: the `Destination = { id, label, href, commissionerOnly }` catalog (**each entry `Object.freeze`d individually, review-loop-iteration 2** — `SIGN_IN_DESTINATION` already was; the phase-array entries weren't, an inconsistency worth closing even though nothing in this story mutates one), one literal table per `LeaguePhase` copied verbatim from `EXPERIENCE.md`'s Information Architecture table and epics.md's Story 1.6 AC. **Human-confirmed role split (review-loop-iteration 1 — supersedes the prior draft's "Setup/Archived carry no split" reading):** Setup's `Import`, `Minor League Eligibility`, `Manager registration` and `auction-open gate` are all `commissionerOnly: true` — these are Commissioner administrative actions per `EXPERIENCE.md`'s "genuinely global acts" list, consistent with how Auction and Contract Assignment are already gated. Archived is unchanged (still no split — `Bid Board`, `Teams`, `Audit Log`, `Export` all `commissionerOnly: false`; re-download is for every Manager). Auction: Your Positions, Bid Board, Auction, Nominate, Teams, Audit Log, Notification settings (`commissionerOnly: false`) + Pause/Resume, Operational health (`commissionerOnly: true`, per the same "genuinely global acts" list). Contract Assignment: Contract Assignment, Teams, Audit Log (`false`) + assignment monitoring, export gate (`true`). `resolveDestinations(phase, session): readonly Destination[]` — a non-registered session gets exactly `[Sign-in]` regardless of phase (human-confirmed, review-loop-iteration 1: a registered session, Commissioner or not, never sees Sign-in in its own list); a registered session gets its phase's catalog filtered by `commissionerOnly`. `requireLiveDestination(session, phase, destinationId): void` (403). Refusal constant reworded (review-loop-iteration 1) so it does not name "the current phase" when the actual cause may be role.
- `src/lib/destinations-view.ts` -- **new, review-loop-iteration 2.** Pure function `classifyDestinations(destinations: readonly Destination[]): { signIn: Destination | undefined; managerDestinations: readonly Destination[]; commissionerDestinations: readonly Destination[] }` (the `Destination` shape declared structurally, same reason `.svelte` files already duplicate it). Extracted from `DestinationsList.svelte`'s three `$derived` filters so this classification logic is a plain function a `vitest` test can call directly — closing the gap the prior pass's AC6 promised and did not deliver: the block-placement guard is a static-text regex over fixed markup and structurally cannot detect a swapped filter predicate (e.g. `!destination.commissionerOnly` flipped), because the class names in the template never move. A unit test on this function catches exactly that regression; the guard extension from review-loop-iteration 1 remains, catching the markup-structure half of the same class of bug.
- `src/hooks.server.ts:41` -- `event.locals.phase = await resolveLeaguePhaseOrDefault();` (calls the review-loop-iteration-2 helper above; no local `try`/`catch` needed here anymore — the fail-closed behavior now lives in a testable module).
- `src/routes/+layout.server.ts` -- new: `{ phase: locals.phase, destinations: resolveDestinations(locals.phase.name, locals.session) }`.
- `src/routes/+layout.svelte` -- modify: render `<HeaderMenu {destinations} phaseSentence={phase.sentence} />` around `{@render children()}`; keep the existing `global.css` import.
- `src/lib/components/DestinationsList.svelte` -- new: given `destinations`, calls `classifyDestinations` (above) and renders the result — the component itself holds no classification logic. This is what Story 4.2's strip-triggered sheet reuses; nothing about it is header-menu-specific. The Sign-in entry renders in its own neutral wrapper, outside the manager/commissioner grouping (review-loop-iteration 1). **Empty state restored (review-loop-iteration 2):** when `classifyDestinations` returns no `signIn` and both destination arrays empty — the actual state every non-Commissioner Manager sees through all of Setup, now that Setup's four entries are Commissioner-only (review-loop-iteration 1) — render a stated sentence (e.g. "Nothing is live for you right now.") rather than an empty disclosure with no content. **Minimal neutral styling** for the component's own wrapper classes (`--space-*`/`--color-text-*` tokens, no new visual language) — the manager/commissioner/sign-in sub-elements already inherit `control-manager`/`control-commissioner`/token-backed classes; only the component's own outer wrapper was unstyled.
- `src/lib/components/HeaderMenu.svelte` -- new: expandable disclosure wrapping `DestinationsList`, per `EXPERIENCE.md`'s "header menu — the same destinations, expandable." No dedicated mock exists (`EXPERIENCE.md` flags the sheet/menu interaction as `[DEFERRED]`) — follow `DESIGN.md`'s existing tokens and the `control-manager`/`control-commissioner` class precedent rather than inventing new visual language. Closes the `<details>` on navigation via `afterNavigate` (review-loop-iteration 1). **Minimal neutral styling** for its own wrapper class, same rationale as above (review-loop-iteration 2).
- `tests/phase-projection.test.ts` -- new: reducer default-case and `INITIAL_PHASE` behavior; full-rebuild-vs-incremental equivalence via `fold()` directly (mirrors `tests/projection-fold.test.ts`'s style).
- `tests/phase.test.ts` -- extend/new: `resolveLeaguePhaseOrDefault`/`foldPhase` against a fake client. **Strengthen the pagination test (review-loop-iteration 2):** assert the actual accumulated event count (or a per-row marker) reaching the fold across pages, not only that more than one `.range()` call happened — the prior test only checked `ranges.length > 1`, which stays green even if a page is silently dropped. **Add an explicit error-branch test:** a fake client whose `.range()` returns `{ data: null, error: {...} }`, asserting `resolveLeaguePhaseOrDefault` still resolves to `Setup` (the fail-closed path) and that the undefaulted `foldPhase`/`resolveLeaguePhase` actually rejects — closing the review-loop-iteration-1 gap where nothing exercised the throw this fail-closed behavior depends on. **Fix the AD-5 rebuild test:** the prior version folded the same events from empty state twice and called that "incremental" — build a genuine incremental case (fold a prefix, then fold the remainder onto that result) at the `resolveLeaguePhase`/`foldPhase` level, matching what `tests/phase-projection.test.ts` already does correctly at the reducer level.
- `tests/destinations-view.test.ts` -- **new, review-loop-iteration 2.** Unit tests for `classifyDestinations`: a Commissioner-only destination lands in `commissionerDestinations` and never `managerDestinations` (and vice versa) — proven by calling the function directly, not by scanning markup — plus the Sign-in-only and empty-list cases.
- `tests/destinations.test.ts` -- new: `resolveDestinations` across all four phases × {Commissioner, non-Commissioner Manager, each non-registered `SessionState` kind} — updated to the human-confirmed Setup role split above; `requireLiveDestination` allow/refuse pairs.
- `tests/layout.test.ts` -- new: `+layout.server.ts`'s `load` function, asserting it returns `{ phase, destinations }` built from `locals.phase`/`locals.session` (review-loop-iteration 1).
- `tests/structure.test.ts` -- extend `AR2_DIRECTORIES`-style listing, or add a standalone check, asserting `src/lib/components/` exists (not in the original AR-2 tree; a natural SvelteKit addition, not a spine violation).
- `tests/signin-surface.test.ts` -- extend the existing repo-wide `blocksOf`-style block-placement guard to **also walk `src/lib/components/*.svelte`**, not only `src/routes/**/*.svelte`, and to match `<div class="...-block">` as well as `<section class="...-block">` (review-loop-iteration 1 — catches a markup-structure regression; `tests/destinations-view.test.ts` above catches the filter-predicate regression the markup guard alone cannot see, review-loop-iteration 2).

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/phase.ts` -- add the pure phase reducer -- AC1.
- [x] `src/lib/shell/write.ts` -- export `toAppendedEvent` -- reuse point for the new reader.
- [x] `src/lib/server/event-log.ts` -- add `loadAppendedEvents`, paginated via `.range()`, with a response-shape guard -- feeds the fold; AC1.
- [x] `src/lib/server/phase.ts` -- `resolveLeaguePhase` (throwing, async, DB-backed) plus `resolveLeaguePhaseOrDefault` (fail-closed wrapper) -- AC1, AC3.
- [x] `src/lib/server/destinations.ts` -- add the catalog (Setup Commissioner-gated per the human-confirmed split, entries individually frozen), `resolveDestinations`, `requireLiveDestination` with a phase/role-neutral refusal message -- AC2, AC4, AC5.
- [x] `src/lib/destinations-view.ts` -- add `classifyDestinations`, extracted from the component -- AC6.
- [x] `src/hooks.server.ts` -- `await resolveLeaguePhaseOrDefault()`, no local `try`/`catch` -- AC3.
- [x] `src/routes/+layout.server.ts`, `src/routes/+layout.svelte` -- wire destinations into every page -- AC2.
- [x] `src/lib/components/DestinationsList.svelte` (calls `classifyDestinations`, restores the empty state, minimal styling), `src/lib/components/HeaderMenu.svelte` (closes on navigation, minimal styling) -- render the one list, twice-reusable -- AC2, AC6, AC7.
- [x] `tests/phase-projection.test.ts`, `tests/phase.test.ts` (strengthened pagination assertion, explicit error-branch test, a genuine incremental-fold test) -- cover the I/O matrix above and AC1/AC3.
- [x] `tests/destinations-view.test.ts` -- unit-test `classifyDestinations` directly -- AC6.
- [x] `tests/destinations.test.ts` -- updated Setup expectations.
- [x] `tests/layout.test.ts` -- cover `+layout.server.ts`'s load function.
- [x] `tests/structure.test.ts` -- assert `src/lib/components/` exists.
- [x] `tests/signin-surface.test.ts` -- extend the block-placement guard to scan `src/lib/components/*.svelte` and `<div class="...-block">`.

**Acceptance Criteria:**
- Given the League phase, when it is determined, then it is `fold`ed from the **entire** `auction_events` log (paginated if needed) by `seq`, folds to `Setup` with no events, and a full rebuild converges on the same value as a genuinely incremental fold — a prefix folded, then the remainder folded onto that result (AD-5).
- Given a request from a signed-in Manager, when any page renders, then phase and role resolve server-side from `locals`, and `resolveDestinations` produces the one list `+layout.svelte` passes to `HeaderMenu`.
- Given the `auction_events` read fails, when a request comes in, then `locals.phase` still resolves — to `Setup`, failing closed — and the request does not 500; Sign-in and the Commissioner break-glass path remain reachable. This is proven by a test that exercises the fail-closed wrapper directly with an injected failing client, not only by reading the source of an untestable file.
- Given a destination absent from the current phase/role's set, when `requireLiveDestination` is called for it, then it throws a 403 stating the fact without asserting a specific cause (phase vs. role) it cannot always know, independent of whether any nav renders it.
- Given each of the four phases, when `resolveDestinations` runs for a Commissioner and for a non-Commissioner Manager, then the returned set matches the phase table above exactly, including which entries are Commissioner-only — Setup's Import/Minor League Eligibility/Manager registration/auction-open gate among them.
- Given a destination array with at least one Commissioner-only and one general entry, when `classifyDestinations` runs, then a Commissioner-only entry never lands in `managerDestinations` and a general entry never lands in `commissionerDestinations` — asserted by calling the function directly, independent of any markup scan.
- Given a non-Commissioner Manager during Setup — an empty destination list, since all four Setup entries are Commissioner-only — when the header menu renders, then it states that nothing is live rather than showing an empty disclosure.
- Given `npm test`, `npm run check`, and `npm run build`, when they run, then all three pass with zero errors.

## Spec Change Log

**review-loop-iteration 1 (2026-08-22).** Triggering findings, from four parallel review layers on the first implementation pass (Blind Hunter, Edge Case Hunter, Verification Gap, Acceptance Auditor), classified `bad_spec` (root cause in the non-frozen Code Map/Design Notes, not `<frozen-after-approval>`):

1. **Unguarded DB read in `hooks.server.ts`.** All four layers independently flagged `event.locals.phase = await resolveLeaguePhase();` with no `try`/`catch`: a Supabase read failure now 500s every request, including Sign-in and the Commissioner break-glass path, contradicting the file's own fail-closed philosophy and this story's Boundaries. Amended: Code Map now directs a `try`/`catch` failing closed to `phaseOf('Setup')`; added a matching AC.
2. **Setup/Archived role-split ambiguity, self-flagged in the original Design Notes and independently confirmed as a real inconsistency by the Acceptance Auditor** (Setup and Archived had no Commissioner split while Auction and Contract Assignment did, despite `EXPERIENCE.md`'s "genuinely global acts" list naming Setup's admin actions the same way). Put to the human: Setup's Import/Minor League Eligibility/Manager registration/auction-open gate are now `commissionerOnly: true`; Archived is confirmed to stay flat; Sign-in-exclusion-for-registered-sessions is confirmed correct as originally implemented.
3. **`LIVE_DESTINATION_REFUSAL` names "the current phase" even for a role-caused refusal** (Acceptance Auditor) — demonstrably false wording for a Commissioner-only refusal in the *correct* phase. Amended: Code Map now directs a phase/role-neutral message.
4. **Unpaginated full-log read** (Acceptance Auditor) — a single `select('*')` silently truncates once the log exceeds PostgREST's default row cap, which would arrive as a successful partial response, not an error, violating this story's own "fold over the full log" Boundary once the log is no longer tiny. Amended: Code Map now directs a paginated `.range()` loop in `loadAppendedEvents`.
5. **`DestinationsList.svelte` wraps the Sign-in entry in `manager-block`/`control-manager` styling** (Edge Case Hunter) — mislabels an unauthenticated visitor's one action as a Manager control. Amended: Code Map now directs a neutral wrapper for Sign-in.
6. **No automated guard against a Commissioner-only destination rendering into a Manager block** (Verification Gap, the most substantiated single finding — traced the exact repo-wide guard this codebase already relies on for this class of bug and showed precisely why it doesn't reach the new component). Amended: Code Map now directs extending `tests/signin-surface.test.ts`'s block-placement guard to `src/lib/components/*.svelte` and `<div class="...-block">`.
7. **The `<details>` header menu has no reason to close after a SvelteKit client-side navigation** (Blind Hunter) — amended: Code Map now directs closing it via `afterNavigate`.
8. **No test coverage for `+layout.server.ts`'s load function** (Blind Hunter) — amended: added `tests/layout.test.ts` to the Code Map and Tasks.

**KEEP — what worked and must survive re-derivation:** the overall shape (pure `phaseReducer` in `core/projection/`, `loadAppendedEvents`/`resolveLeaguePhase` reading via the service-role client, `resolveDestinations`/`requireLiveDestination` as the single-implementation pair, `DestinationsList`/`HeaderMenu` split so Story 4.2 reuses the former unchanged, structural `Destination` type duplication in `.svelte` files rather than importing a server-only module, reuse of `toAppendedEvent` from `write.ts`) is sound and specifically endorsed — re-derive it as before, with only the eight amendments above changed. The test style in `destinations.test.ts`/`phase.test.ts`/`phase-projection.test.ts` (full phase×role matrices, fake-client injection, `fold()` exercised directly for the pure reducer) is also endorsed and should be extended, not replaced.

Not classified `bad_spec` — logged to `deferred-work.md` instead (pre-existing pattern, not introduced by this story): `serviceRoleClient()` constructed fresh as a default-parameter value on every `resolveLeaguePhase()` call, now exercised on every request rather than per-registry-lookup; worth confirming/fixing singleton reuse.

**review-loop-iteration 2 (2026-08-22).** Triggering findings from a second round of the same four review layers, run against the review-loop-iteration-1 re-derivation, classified `bad_spec`:

1. **AC6 (the block-placement guard "would fail" a Commissioner-only entry rendered into a Manager block) was not actually satisfied — independently caught by three of four layers with an identical, concrete demonstration.** `DestinationsList.svelte` assigns entries to `manager-block`/`commissioner-block` via a runtime `$derived` filter, but the guard extended at iteration 1 is a static-text regex over fixed markup — the `class="control-manager"`/`class="control-commissioner"` literals never move in source text regardless of which array a filter routes an entry into. Swapping the filter's `!` would leave every Commissioner-only destination rendered as a Manager control, and both the markup guard and `tests/destinations.test.ts` (which only tests the server-side resolver) would stay green. Root cause: the iteration-1 Code Map directed extending the markup guard as if that alone closed the AC, without noticing the guard category (static markup) cannot observe the defect category (dynamic classification). Amended: extract the classification into `src/lib/destinations-view.ts`'s `classifyDestinations`, a plain function `tests/destinations-view.test.ts` calls directly — the markup guard now catches structural regressions, this catches logical ones, and between them the AC is actually enforced.
2. **AC3's fail-closed behavior (added at iteration 1) had zero test coverage and, as structured, could get none.** The `try`/`catch` lived inline in `hooks.server.ts`, which is documented — in its own module header, since Story 1.3 — as unimportable by the test suite. Amended: extracted `resolveLeaguePhaseOrDefault` into `phase.ts` (testable), mirroring exactly why `session.ts`/`auth.ts` were split out of the same file for the same reason originally.
3. **The pagination test proved the loop iterates more than once, not that it accumulated every row** — a dropped page would leave the same assertions green. Amended: assert the actual accumulated count/rows, not just call count.
4. **`loadAppendedEvents`'s error-throw branch — the one the fail-closed wrapper depends on — was never exercised by a failing fake client.** Amended: add an explicit error-branch test.
5. **The "full rebuild vs. incremental" test at the `resolveLeaguePhase` level folded the same events from empty state twice and called the second one "incremental."** It wasn't — `tests/phase-projection.test.ts` already gets this right at the reducer level; the `phase.ts`-level test claimed the same guarantee without earning it. Amended: build a genuine prefix-then-remainder incremental fold.
6. **The empty-state message for `DestinationsList` was dropped between iteration 1's original draft and its re-derivation** (iteration 1's own review had called it unreachable, which was true *then* — before the Setup role split was confirmed later in the same round). With Setup's four entries now Commissioner-only, a non-Commissioner Manager sees a genuinely empty list through all of Setup, and the disclosure opened onto nothing with no message. Amended: restore the empty-state sentence.
7. **`CATALOG`'s destination literals were not individually frozen**, unlike `SIGN_IN_DESTINATION` — an inconsistency, not a bug (nothing in this diff mutates one), closed for consistency.
8. **Three new CSS class names had no rules behind them** — the two component wrapper classes and the Sign-in neutral wrapper the iteration-1 amendment asked for. Amended: minimal token-backed styling, no new visual language.
9. **Code comments named the review process itself** ("review-loop-iteration 1", "human-confirmed") rather than stating the durable rule and its rationale — added the Comment style note above the Code Map.

**KEEP, reaffirmed:** everything kept at iteration 1, plus the iteration-1 amendments themselves (Setup's role split, the fail-closed *intent*, the reworded refusal message, the pagination *intent*, the empty-state *intent* before it was dropped, the block-placement guard extension) — none of that is being reverted; iteration 2 only replaces *how* two of those intents (fail-closed testability, block classification correctness) are structurally achieved.

**review-loop-iteration 3 (2026-08-22).** Triggering findings from a third round of the same four review layers, run against the review-loop-iteration-2 re-derivation. Applied as direct, targeted patches to the working implementation rather than a full revert-and-re-derive cycle — by this point every finding was small, mechanical, and fully understood, so patching in place was the lower-risk path; the spec's Code Map below is updated for traceability even though no fresh implementation subagent re-derived the code from it this round. Classified `bad_spec`/`patch` (no `intent_gap`; nothing here touched frozen content):

1. **`resolveLeaguePhaseOrDefault(client = serviceRoleClient())` — the fail-closed wrapper added at iteration 2 — did not actually fail closed for its own most likely real trigger.** A default-parameter expression evaluates before a function's body runs, so a throwing `serviceRoleClient()` (e.g. a missing required server-only variable) rejected before the `try`/`catch` inside the wrapper ever ran — and since `hooks.server.ts` no longer wraps the call itself (that was moved into this function at iteration 2), the rejection would have propagated uncaught, 500ing every request on exactly the configuration-error case this whole fix exists for. Caught independently by the Edge Case Hunter layer. Amended: `client` takes no default value; the client is built inside the `try` via `client ?? serviceRoleClient()`. A new test calls the function with zero arguments (its only path that reaches the real default) against a mocked missing environment variable, proving the fix.
2. **The "nothing is live" empty-state logic, added at iteration 2, was computed inline in `DestinationsList.svelte` rather than extracted — the same class of gap iteration 2 closed for the manager/commissioner split, reopened in the part iteration 2 itself added.** Caught by the Verification Gap and Acceptance Auditor layers (AC7 had no automated guard, and the Spec Change Log already recorded this exact string being lost once during re-derivation). Amended: `classifyDestinations` now returns a computed `hasNothingLive` field; the component reads it rather than deriving its own copy. A source-text assertion (matching `tests/signin-surface.test.ts`'s existing style for markup claims) proves the sentence itself is still rendered.
3. **`loadAppendedEvents`'s pagination terminated on a page shorter than `PAGE_SIZE`, not on an empty page — silently re-truncating the log exactly like the single-unbounded-select case pagination was added to prevent, if the real deployment's row cap is ever smaller than `PAGE_SIZE`.** Caught by the Acceptance Auditor, who noted the code comment's claim ("never a guess about server-side behaviour") was demonstrably false and unverified by any test, since the fake client hardcoded the simulated cap to equal `PAGE_SIZE`. Amended: the loop now advances `offset` by the page's actual length and terminates only on an empty page — correct for any server-side cap. A new test simulates a server capping every response at 100 rows against a 250-row log and proves every row is still accumulated.
4. **The `'sign-in'` id was duplicated three times (the catalog, the view module, and its test) with nothing pinning them together** — a rename in one place would silently make `classifyDestinations` stop recognizing Sign-in, re-rendering it as a Manager control (the exact defect iteration 1 removed). Caught by the Blind Hunter and Acceptance Auditor layers. Amended: `tests/destinations-view.test.ts` now also asserts `classifyDestinations` recognizes the real `SIGN_IN_DESTINATION` imported from the server catalog, not only a hand-built stand-in — pinning the two without undoing the deliberate server/client type decoupling.
5. **A test reimplemented the `AppendedEvent` row-mapping by hand instead of reusing `toAppendedEvent`, the exact duplication that function was exported to prevent.** Caught by the Blind Hunter layer. Amended: the test now calls `toAppendedEvent` directly.
6. **Code comments in three test files still named the review process itself** ("human-confirmed", "iteration-2 strengthening") rather than the durable rule and its rationale — the iteration-2 Comment style note was applied to source files but missed test files. Caught by the Acceptance Auditor. Amended: reworded in `tests/destinations-view.test.ts`, `tests/phase.test.ts`, and `tests/destinations.test.ts`.

**KEEP, reaffirmed:** everything kept at iterations 1 and 2. Nothing here reverses a prior decision; every amendment strengthens how an already-agreed intent is verified or guarded.

Findings raised again this round and not actioned, consistent with prior triage: the full per-request fold with no cache/memoization, a fresh `serviceRoleClient()` per request, silent error-swallowing with no logging, no timeout around the log read, `requireLiveDestination` having no live call site, stub `href`s for not-yet-built routes, no click-outside/Escape close on the header menu, no explicit `aria-expanded`. All remain accepted tradeoffs or already logged in `deferred-work.md` for the reasons given at iterations 1-2. Two new low-priority notes worth a mention, not action: `HeaderMenu` now renders on `/commissioner-recovery` too (no security leak — the menu doesn't know about break-glass — but a footprint inconsistency with that page's otherwise-minimal design, worth a look if that page ever gets real design attention); a signed-out visitor on `/signin` now sees a redundant second "Sign-in" link in the header pointing at the same page.

**Noted, not changed:** the Acceptance Auditor flagged that a non-registered `'unregistered'` session now receives an always-rendered `[Sign-in]` link in the header nav, while the `/signin` page itself deliberately withholds the actionable button for that exact state (AD-15's anti-probe-loop discipline). This is not a security regression — the header link only navigates to `/signin`, which still refuses to offer the button once there; no OAuth exchange is reachable through it — but it is a UX inconsistency between a frozen I/O matrix row (human-confirmed at drafting, reaffirmed at iteration 1) and the sign-in page's more careful three-way handling. Left as specified rather than reopened, since the underlying security property holds; noted here for visibility.

## Design Notes

**Why a per-request full fold, not a materialized table.** Nothing appends a phase-changing event until Story 1.11 (`AuctionOpened`), so the log stays empty-to-tiny through the rest of Epic 1. A materialized projection table would need its own migration, its own `ProjectionUpdater` registration against a write path that doesn't exist yet (no command appends phase-relevant events in this story), and buys nothing at this volume. Reading directly via the service-role client — "reads may query projections directly" — is the simple, correct choice now; revisit if a later epic's event volume makes the full replay costly. The read is still paginated (see Code Map), because "empty-to-tiny for now" bounds cost, not the silent-truncation risk once it isn't — a capped PostgREST response is a successful partial result, not an error.

**Why non-registered sessions see only `[Sign-in]`, human-confirmed at review-loop-iteration 1.** Epics.md lists "Sign-in" among Setup's destinations, but a signed-in Manager has no use for a sign-in link in their own nav. Read literally as: an unauthenticated visitor's only reachable destination, in any phase, is Sign-in; a registered viewer's list is the phase's Manager/Commissioner catalog, Sign-in excluded, any phase.

**Why Setup's admin actions are Commissioner-only, human-confirmed at review-loop-iteration 1.** The first draft read Setup's and Archived's AC sentences literally — no "(Commissioner: ...)" clause, unlike Auction and Contract Assignment — and left both flat. Review surfaced the inconsistency (`EXPERIENCE.md`'s "genuinely global acts" list names Import, Minor League Eligibility and the auction-open gate as exactly the kind of Commissioner-only administrative action Auction's Pause/Resume and Operational health are) and asked the human to rule. Setup's four admin entries are now `commissionerOnly: true`; Archived stays flat — re-downloading the Export is for every Manager, not an administrative act, and nothing raised that reading as inconsistent.

**Why the DB read fails closed to `Setup` rather than throwing through `hooks.server.ts`.** The first draft let `resolveLeaguePhase`'s error propagate uncaught from `hooks.server.ts`, which 500s every request — including Sign-in and the Commissioner break-glass path — on a transient Supabase hiccup. That contradicts this file's own stated philosophy ("A configuration or database failure resolves to `signed-out`, never to a session. Failing closed is the only safe direction here") and this story's own Boundaries ("every sign-in-adjacent surface keeps stating phase... unchanged"). `Setup` is the same value an empty log already produces, so failing closed to it on a read error is not a new behavior to reason about — it's the existing "no confirmed phase progression" answer, applied uniformly.

## Verification

**Commands:**
- `npm test` -- expected: all suites pass, including the new reducer/resolver/guard coverage.
- `npm run check` -- expected: zero errors under `strict`/`noUncheckedIndexedAccess`.
- `npm run build` -- expected: exit 0, purity gate passes (`core/projection/phase.ts` stays pure).

**Manual checks (if no CLI):**
- `HeaderMenu`/`DestinationsList` render correctness (no component-test harness exists yet, per `deferred-work.md`): load the app locally and confirm the header menu opens, lists Sign-in only when signed out, and reflects the Setup-phase catalog once signed in.

## Suggested Review Order

**Phase: the pure reducer and the fail-closed DB-backed resolver (AC1, AC3)**

- Entry point — the extension point Story 1.11's `AuctionOpened` fills in; today every event type falls through unchanged.
  [`phase.ts:43`](../../src/lib/core/projection/phase.ts#L43)

- The throwing half of the fail-closed pair — folds the full log via the pure reducer.
  [`phase.ts:62`](../../src/lib/server/phase.ts#L62)

- The fail-closed wrapper, fixed at review-loop-iteration 3 to build its client inside the `try`, not as a throwing default parameter.
  [`phase.ts:94`](../../src/lib/server/phase.ts#L94)

- Paginates by the page's actual length and terminates on an empty page — correct even if the server's real row cap is smaller than requested.
  [`event-log.ts:56`](../../src/lib/server/event-log.ts#L56)

- `hooks.server.ts` calls the fail-closed wrapper only — no local `try`/`catch`, since it can't be unit-tested.
  [`hooks.server.ts:46`](../../src/hooks.server.ts#L46)

**The destination catalog and the server-side guard (AC2, AC4, AC5)**

- The catalog's Setup entries — the human-confirmed Commissioner-only split, settled at review-loop-iteration 1.
  [`destinations.ts:63`](../../src/lib/server/destinations.ts#L63)

- The one function both nav surfaces call — non-registered sessions get `[Sign-in]`, registered ones get their phase's catalog filtered by role.
  [`destinations.ts:107`](../../src/lib/server/destinations.ts#L107)

- The reusable server-side refusal — no live call site yet, mirroring `commissioner-guard.ts`'s precedent.
  [`destinations.ts:136`](../../src/lib/server/destinations.ts#L136)

**Rendering the one list, twice-reusable (AC2, AC6, AC7)**

- The classification a `vitest` test can call directly — closes the gap a markup-only guard structurally can't catch.
  [`destinations-view.ts:61`](../../src/lib/destinations-view.ts#L61)

- `hasNothingLive`, added at review-loop-iteration 3 so the empty-Setup-for-a-Manager state is also testable, not just the split.
  [`destinations-view.ts:43`](../../src/lib/destinations-view.ts#L43)

- The component holds no classification logic of its own — calls `classifyDestinations` and renders its result, including the empty state.
  [`DestinationsList.svelte:23`](../../src/lib/components/DestinationsList.svelte#L23)

- Closes the header menu's `<details>` on navigation — SvelteKit's client-side routing wouldn't otherwise give it a reason to.
  [`HeaderMenu.svelte:38`](../../src/lib/components/HeaderMenu.svelte#L38)

- Resolves the list once per request from `locals`, server-side — the one place both nav surfaces will ever read it from.
  [`+layout.server.ts:18`](../../src/routes/+layout.server.ts#L18)

- Wires the header menu around every page's content.
  [`+layout.svelte:12`](../../src/routes/+layout.svelte#L12)

**Peripherals**

- The default-parameter regression test — calls the fail-closed wrapper with zero arguments against a mocked missing environment variable.
  [`phase.test.ts`](../../tests/phase.test.ts)

- The pagination-under-a-smaller-server-cap regression test.
  [`phase.test.ts`](../../tests/phase.test.ts)

- The reducer's own fold/rebuild guarantees, exercised directly.
  [`phase-projection.test.ts`](../../tests/phase-projection.test.ts)

- The classification filter, proven directly rather than only by scanning markup — the AC6 gap two prior rounds missed.
  [`destinations-view.test.ts`](../../tests/destinations-view.test.ts)

- The full phase × role matrix against the human-confirmed catalog.
  [`destinations.test.ts`](../../tests/destinations.test.ts)

- The layout `load` function's wiring.
  [`layout.test.ts`](../../tests/layout.test.ts)

- The `src/lib/components/` existence check and the AC7 empty-state source-text assertion.
  [`structure.test.ts`](../../tests/structure.test.ts)

- The block-placement guard, extended to `src/lib/components/*.svelte` and `<div class="...-block">`.
  [`signin-surface.test.ts`](../../tests/signin-surface.test.ts)

