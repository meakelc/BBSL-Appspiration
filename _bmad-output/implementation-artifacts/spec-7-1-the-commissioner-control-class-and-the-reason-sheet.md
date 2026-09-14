---
title: 'Story 7.1: The Commissioner control class and the reason sheet'
type: 'feature'
created: '2026-09-10'
status: 'done'
baseline_commit: '30a2824acba54fee912de445ed8c2eff8635662f'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 1 shipped the Commissioner control's four visual properties (`commissioner.css`) and the server-side Commissioner guard, but the other half of the class — *no Commissioner act is ever a single tap* — is unbuilt: nothing in `src/` renders a reason sheet, no path refuses a reasonless submission, and no shape carries actor / before-state / after-state / reason. Every override in Epic 7 inherits this, so building it inside the first override (7.2) would make it that override's private detail.

**Approach:** Ship the mechanism with **zero override call sites**, exactly as Epic 1 shipped `commissioner-guard.ts` with none: a pure override-record module that cannot construct a record without a non-blank reason, a shell guard that refuses a reasonless submission and refuses any override once Archived, a pure view-model holding the sheet's words and its before→after rows, and a thin `ReasonSheet.svelte` that renders it. Story 7.2 adds a control and a route — not a sheet.

## Boundaries & Constraints

**Always:**
- The reason travels in the event `payload`. `auction_events` states it holds no opinion on which `event_type` values are legal, so a reason CHECK keyed on event type is not available to it — enforcement is structural in the core type, not in the database.
- An override record is unconstructible without a non-blank reason. Blank means blank after `trim()`.
- The sheet's commit control is dashed and never filled: reuse the Epic 1 `.control-commissioner` class, never a new look-alike. All four properties of the class survive unweakened.
- The sheet's words and rows live in a pure, unit-tested view-model; the `.svelte` file stays thin — the `PersistentStrip.svelte` / `core/strip.ts` precedent.
- The sheet is a **second step of an ordinary form**, not a JS modal. No `use:enhance` exists anywhere in `src/` and none is introduced; a commit must be reachable without client JS.
- The reason field is empty on open — no placeholder, no default, no skip control.

**Ask First:**
- Any edit to `src/lib/styles/commissioner.css`, or to the scope guard at `tests/commissioner.test.ts:385-398` that asserts `reason-` text does **not** appear in that file.
- Any migration, or any new `auction_events` column.

**Never:**
- No override control, override route, or override event is placed or emitted by this story.
- No Audit Log read surface — that is Story 7.5.
- No restoration, refold, or clock arithmetic — that is Story 7.2.
- No privilege for the Commissioner's own Team anywhere.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Reason accepted | `reason` = "Wrong co-manager account; confirmed in #bbsl-general" | Validated reason returned, trimmed | N/A |
| Reason absent | `reason` field missing from the submission | Refused server-side, refusal states a reason is required | Refusal constant, no event |
| Reason blank | `reason` is whitespace only (spaces, tabs, newlines) | Refused server-side, identical refusal | Refusal constant, no event |
| Record built | actor + before + after + non-blank reason | An override record carrying all four | N/A |
| Record refused | any construction with a blank reason | Construction refuses; no partial record escapes | Pure refusal value, never a throw in core |
| Archived phase | phase = `Archived`, override attempted | Refused, worded distinctly from the Commissioner-only refusal | Refusal constant, no event |
| Live phase | phase = `Auction` or `Contract Assignment` | Passes the phase gate | N/A |
| Consequence row | an affected value whose change is non-obvious | Row carries an `attention` note and a sentence in words | N/A |
| No consequence | every affected value obvious | Rows render, no `attention` note | N/A |

</frozen-after-approval>

## Code Map

- `src/lib/styles/commissioner.css:42,89,126` -- the four shipped properties: `.commissioner-block`, `.control-commissioner`, the `::before` persistent label. Header `:23-28` names the reason sheet as this story's. **Read-only.**
- `tests/commissioner.test.ts:385-398` -- guard asserting `commissioner.css` holds no `reason-sheet`/`.reason-` text. Keeping sheet styles in the component keeps this green.
- `src/lib/server/commissioner-guard.ts:33,36,50-53` -- **the pattern to copy**: refusal constant, status, `requireCommissioner` throwing SvelteKit `error()`. Docblock `:25-28` is the zero-call-site precedent this story repeats.
- `tests/commissioner-guard.test.ts:41-67` -- `expectRefusal`; the shape for asserting a server-side refusal.
- `src/lib/server/destinations.ts:170-181` -- `requireLiveDestination`, the phase/role refusal precedent. `:126-131` the `Archived` catalog: `/board` and `/teams` **are** live there, so an in-place override control would pass this gate — which is why a separate archived refusal is needed.
- `src/lib/core/projection/phase.ts:45` -- `LeaguePhase = 'Setup' | 'Auction' | 'Contract Assignment' | 'Archived'`.
- `src/lib/shell/write.ts:170-177` -- `INSERT_EVENT_SQL`: no `reason` and no `actor` column; `manager_id`/`team_id` carry the actor, `payload` jsonb carries the rest. `:235-241` `runTransactionalWrite` — **not called by this story.**
- `src/lib/core/types.ts:40-44,119-133` -- `AppendedEvent`, and the rule that event types are declared beside their reducer, never in a union here.
- `src/lib/components/RefusalPanel.svelte:34-36,72-86,146-264` -- `$props()` convention (inline structural type, `readonly`, types declared locally not imported from server) and scoped `<style>` from tokens.
- `src/lib/core/strip.ts` + `tests/strip.test.ts:1-13,354-361` -- the view-model split, and the **source-text assertion** convention: `vite.config.ts` pins `environment: 'node'`; no `.svelte` renders under the suite.
- `src/lib/styles/tokens.css:47-48,53-57,62` -- `--color-attention(-ink)`, the `admin` tokens, `--font-display` (Georgia).
- `.../ux-designs/ux-BBSL-Appspiration-2026-08-17/mockups/Commissioner.dc.html` -- panel 3 is the sheet: act sentence, before→after rows for both Clocks, the consequence sentence, labelled reason field, Cancel + dashed commit, Audit Log footer.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/rules/override.ts` -- new pure module: the override record type (actor, before-state, after-state, reason), a reason validator, and a constructor that returns a refusal rather than a record when the reason is blank -- the architecture spine names `core/rules/override` as this epic's home, and structural refusal is what makes "no override path can skip the reason" true rather than remembered.
- [x] `src/lib/server/override-guard.ts` -- new shell guard mirroring `commissioner-guard.ts`: exported refusal constants and statuses, a reason-parsing refusal over submitted form data, and an archived-phase refusal worded distinctly from the Commissioner-only one -- so 7.2 adds a route rather than inventing a guard under deadline.
- [x] `src/lib/reason-sheet-view.ts` -- new pure view-model: the sheet's title, act sentence, before→after rows, the `attention` consequence note, the reason field's label, and the Audit Log footer sentence -- keeps every word unit-testable under the node suite.
- [x] `src/lib/components/ReasonSheet.svelte` -- new component rendering that view-model: act named in `--font-display`, before→after rows, `attention` note where present, an empty reason field with no placeholder or default, a Cancel and a `.control-commissioner` commit, and the Audit Log footer -- thin, scoped `<style>` from tokens only.
- [x] `tests/core/rules/override.test.ts` -- drive every record and reason row of the I/O matrix.
- [x] `tests/server/override-guard.test.ts` -- drive the reason-refusal and archived rows using the `expectRefusal` shape; assert the two refusals are distinct strings.
- [x] `tests/reason-sheet.test.ts` -- view-model rows plus source-text assertions over `ReasonSheet.svelte`: the commit uses `.control-commissioner`, the reason field carries no `placeholder` and no `value`, no skip control exists, no `use:enhance`, and no `<dialog>` or JS-only gate.

**Acceptance Criteria:**
- Given the Epic 1 Commissioner class, when the sheet renders its commit control, then all four properties still hold and the commit is dashed and never filled, with no Manager-button variant anywhere on the sheet.
- Given a submission carrying no reason or a whitespace-only reason, when it reaches the server, then it is refused server-side and nothing is written — asserted by an automated test, not by the UI hiding a control.
- Given the `Archived` phase, when any override is attempted, then it is refused, with wording distinct from the Commissioner-only refusal.
- Given the Commissioner's own Team, when ordinary Manager controls render on it, then nothing in this story alters its Cap Space, Maximum Bid or Nomination Slot — asserted as a negative test.
- Given this story completes, when the repository is searched, then no override control, route or event exists yet, and `commissioner.css` is unchanged.

## Spec Change Log

## Design Notes

**Why the reason is not a column.** `supabase/migrations/20260821020000_auction_events.sql:24-30` states the table "has no opinion on what `event_type` values are legal", so a `check` keyed on the override event types contradicts its stated design, and an unkeyed non-null column breaks every existing insert. The payload carries it; the core type enforces it.

**Why no modal.** No `<dialog>`, modal or popover exists anywhere in `src/`, and `use:enhance` appears in zero files. The sheet is the second step of an ordinary form. A JS modal would make the one act that must never be skippable depend on client JS.

**Placement is a convention here, not code.** "In place, on the object acted on" and "global acts get an admin destination" bind the stories that add controls; those admin destinations already exist in `destinations.ts`. This story records the rule in the guard's docblock and asserts nothing about controls that do not exist yet.

## Verification

**Commands:**
- `npm test` -- expected: full Vitest suite green, including the untouched `tests/commissioner.test.ts` scope guard.
- `npm run check` -- expected: no TypeScript or svelte-check errors.
- `npm run check:purity` -- expected: clean; the new `core/rules/override.ts` imports nothing from the shell.

**Manual checks (if no CLI):**
- `git diff --stat` shows no change to `src/lib/styles/commissioner.css`, no file under `supabase/migrations/`, and no new route directory.

## Suggested Review Order

**The structural promise — a reasonless override cannot be built**

- The entry point: a unique-symbol brand makes `OverrideRecord` nominal, not structural.
  [`override.ts:161`](../../src/lib/core/rules/override.ts#L161)

- The single `as OverrideRecord` assertion, placed after the only check that can refuse.
  [`override.ts:194`](../../src/lib/core/rules/override.ts#L194)

- Blank is whitespace *and* zero-width, stripped at the edges only so interior joiners survive.
  [`override.ts:90`](../../src/lib/core/rules/override.ts#L90)

- Refuses by value, never by throw — this is the core.
  [`override.ts:109`](../../src/lib/core/rules/override.ts#L109)

**The two server refusals a future override route must pass**

- The reason refusal: 400, because the submission is incomplete rather than forbidden.
  [`override-guard.ts:104`](../../src/lib/server/override-guard.ts#L104)

- The archived refusal: 403, worded around the closed record, not around permission.
  [`override-guard.ts:120`](../../src/lib/server/override-guard.ts#L120)

- Both refusal strings, deliberately sharing no wording with each other or Epic 1's.
  [`override-guard.ts:55`](../../src/lib/server/override-guard.ts#L55)

**The sheet's words, held apart from its markup**

- Every sentence the sheet says, unit-testable under the node suite.
  [`reason-sheet-view.ts:178`](../../src/lib/reason-sheet-view.ts#L178)

- The row shape: a positional key, and an attention note normalized to null when empty.
  [`reason-sheet-view.ts:70`](../../src/lib/reason-sheet-view.ts#L70)

**The surface**

- An ordinary POST form wrapping the Commissioner block — no modal, no client JS.
  [`ReasonSheet.svelte:50`](../../src/lib/components/ReasonSheet.svelte#L50)

- Each consequence renders on the row it belongs to, keyed so duplicates cannot collide.
  [`ReasonSheet.svelte:71`](../../src/lib/components/ReasonSheet.svelte#L71)

**Verification**

- The mutation-resistant surface assertions: extracted textarea and button, not whole-file matches.
  [`reason-sheet.test.ts`](../../tests/reason-sheet.test.ts)

- The exclusivity scan: no second builder can appear, in any export syntax.
  [`override.test.ts`](../../tests/core/rules/override.test.ts)

- AC4's negative test, and the three-way refusal distinctness assertions.
  [`override-guard.test.ts`](../../tests/server/override-guard.test.ts)
