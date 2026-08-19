---
title: 'Story 1.1: Deployable skeleton on the pinned stack'
type: 'feature'
created: '2026-08-18'
status: 'done'
baseline_commit: 'NO_COMMITS' # repository initialised for this story; HEAD is unborn, so the entire working tree is the diff
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-BBSL-Appspiration-2026-08-17/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The repository is empty. Every later story needs a deployable SvelteKit application on an exactly-pinned stack, an enforced source-tree layout, and the design tokens declared once — otherwise each story re-decides the stack and the product drifts visually from its first screen.

**Approach:** Scaffold SvelteKit 2.70.2 on `adapter-netlify` 6.0.4 with strict TypeScript, create the AR-2 source tree, declare `DESIGN.md`'s frontmatter tokens verbatim as CSS custom properties, establish the Commissioner control class, and gate the build on a version-drift check. Account-side provisioning (Netlify site, two Supabase projects) is deferred to `deferred-work.md`; this story delivers only what lives in the repository.

## Boundaries & Constraints

**Always:** Pinned versions are exact, never ranges — SvelteKit `2.70.2`, `@sveltejs/adapter-netlify` `6.0.4` with `edge: false`, Node `24`. TypeScript `strict` with `noUncheckedIndexedAccess`. Token values are copied from `DESIGN.md` frontmatter character-for-character. The source tree matches AR-2 exactly. `font-variant-numeric: tabular-nums` is the default in every numeric context. Secrets are server-only env vars, never behind a `PUBLIC_` prefix.

**Ask First:** Adding any runtime dependency beyond SvelteKit, the Netlify adapter, and their transitive deps. Changing a pinned version. Introducing a browser-based test runner.

**Never:** No light-theme declaration of any kind — no `prefers-color-scheme: light` block, no light token set. No override/reason-sheet implementation (Story 7.1). No Supabase client code, auth, routes, or schema beyond empty directories (Stories 1.2–1.5). No shadows or elevation; depth is a 1px border. No emoji. No hand-typed dashboard schema changes — migrations only.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Versions match pins | `package.json` at 2.70.2 / 6.0.4, Node 24 | Drift check exits 0, build proceeds | N/A |
| Dependency drifts | SvelteKit bumped to 2.71.0 | Drift check exits non-zero, build fails | Message names the package, pinned value, and found value |
| Range instead of pin | `"^2.70.2"` in `package.json` | Drift check exits non-zero | Message states an exact version is required |
| Node major drifts | Node 22 or 26 in engines/`.nvmrc` | Drift check exits non-zero | Message names the required major (24) |
| Token drifts from DESIGN.md | A colour edited in `tokens.css` only | Parity test fails | Names the token and both values |
| Token missing | A frontmatter token absent from `tokens.css` | Parity test fails | Names the missing token |
| Light theme reintroduced | Any light-scheme declaration in CSS | Test fails | Names the offending file |

</frozen-after-approval>

## Code Map

The repository contains no source code — `git init` ran fresh at project root; only `.claude/`, `_bmad/`, `_bmad-output/` exist. Every path below is created by this story. Authoritative inputs are read-only:

- `_bmad-output/planning-artifacts/ux-designs/.../DESIGN.md` -- **read-only.** Lines 1–49 are the token frontmatter: 20 colours (`ground`…`admin-ground`), 2 type families (`display`, `ui`), `numerals: tabular-nums`, 10-step scale `10 / 11 / 12 / 12.5 / 13 / 15 / 18 / 19 / 21 / 26`, 3× `3px` radius, 5 spacing values, 5 component dimensions. Line 224–236 is the Commissioner control table. Line 229 gives the Manager control fill `#223028` — a raw hex, not one of the 20 frontmatter tokens.
- `_bmad-output/planning-artifacts/architecture/.../ARCHITECTURE-SPINE.md` -- **read-only.** Lines 308–324 pin the stack; lines 452–479 give the AR-2 source tree verbatim.
- `_bmad-output/implementation-artifacts/epic-1-context.md` -- compiled epic context; the standing invariants for Epic 1.
- `package.json`, `.nvmrc`, `svelte.config.js`, `vite.config.ts`, `tsconfig.json`, `netlify.toml` -- stack configuration and the drift gate's inputs.
- `scripts/check-pins.js` -- the version-drift gate; runs before `vite build`.
- `src/lib/styles/tokens.css`, `global.css`, `commissioner.css` -- the visual foundation.
- `tests/pins.test.ts`, `tests/tokens.test.ts`, `tests/commissioner.test.ts`, `tests/structure.test.ts` -- the four checks.

## Tasks & Acceptance

**Execution:**
- [x] `package.json` -- create with exact-pinned `svelte-kit@2.70.2`, `@sveltejs/adapter-netlify@6.0.4`, vite, vitest, typescript, `svelte-check`; `engines.node: "24.x"`; `build` script runs `node scripts/check-pins.js && vite build` -- the drift gate must be unskippable from the build path (AC: build fails on drift).
- [x] `.nvmrc`, `netlify.toml` -- pin Node 24; declare build command, publish dir, and `production` / `deploy-preview` / `branch-deploy` contexts mapping production→prod Supabase and every other context→dev -- the branch-to-environment contract in committed form.
- [x] `svelte.config.js`, `tsconfig.json`, `vite.config.ts` -- adapter-netlify with `edge: false`; `strict` + `noUncheckedIndexedAccess`; Vitest wired to `tests/`.
- [x] `scripts/check-pins.js` -- read `package.json`, `.nvmrc`, `netlify.toml`; assert each pinned name equals its exact literal version with no range prefix; exit non-zero naming package, expected, and found -- covers every drift row in the I/O Matrix.
- [x] `src/app.html`, `src/app.d.ts`, `src/routes/+layout.svelte`, `src/routes/+page.svelte` -- minimal SSR-rendering route importing the global stylesheet, so the skeleton serves a real page.
- [x] AR-2 tree -- create `src/lib/core/{rules,projection}/`, `core/{money,constants,types}.ts` as empty typed stubs, `src/lib/{shell,server}/`, `src/lib/adapters/{fantrax,discord}/`, `supabase/migrations/`, `supabase/functions/tick/`, `tests/examples/`; `.gitkeep` where a directory would otherwise be empty -- AR-2 must exist before the stories that fill it.
- [x] `src/lib/styles/tokens.css` -- declare all 20 colours, both type families, the 10-step scale, the 3px radii, and every named spacing and component dimension as custom properties, values verbatim from `DESIGN.md` frontmatter.
- [x] `src/lib/styles/global.css` -- reset, `ground`/`text` defaults, `font-variant-numeric: tabular-nums` as the inherited default; no light-scheme declaration anywhere.
- [x] `src/lib/styles/commissioner.css` -- `.control-manager` (solid fill, solid 1px `border-strong`, full-width) and `.control-commissioner` (never filled, dashed 1px `admin`, recessed `admin-ground` behind a dashed rule, persistent "Commissioner · visible only to you" label in `admin-text`, inline content-width).
- [x] `tests/pins.test.ts`, `tests/tokens.test.ts`, `tests/commissioner.test.ts`, `tests/structure.test.ts` -- one test per I/O Matrix row group: drift detection, token parity against `DESIGN.md` frontmatter, greyscale distinguishability of the two control classes, and AR-2 tree presence.
- [x] `.env.example`, `.gitignore` -- name every required variable with server-only names for secrets and a comment stating no secret may take a `PUBLIC_` prefix; ignore `node_modules`, `.svelte-kit`, `build`, `.env*` except the example.

**Acceptance Criteria:**
- Given a clean checkout, when `npm install && npm run build` runs, then it completes and emits a Netlify-adapter build.
- Given any pinned version edited away from its literal value, when the build runs, then it fails before Vite compiles and the message names the drifted package.
- Given `npm run check`, when it runs, then `svelte-check` reports zero errors under strict + `noUncheckedIndexedAccess`.
- Given `npm test`, when it runs, then all four test files pass.
- Given the whole `src/` tree, when grepped for light-scheme declarations, then there are none.
- Given a Commissioner and a Manager control with all colour removed, when compared, then they differ by fill, border style, ground, and the presence of the persistent label.

## Spec Change Log

- **Iteration 1 — WCAG 1.4.11 violation in the Manager control (`bad_spec`, patched in place by human decision).**
  **Triggering finding:** the verification-gap review computed the contrast of `--color-border-strong` `#5E7568` against `--control-fill` `#223028` at **2.77:1**, below the 3:1 WCAG 1.4.11 requires of a non-text element needed to identify a control. Independently reproduced. `DESIGN.md:116` audits control boundaries at 3.34:1, but that figure is measured against `--color-surface` `#15211B`; the filled Manager control was never re-audited against its own fill, so the design document contradicts itself and this spec's Tasks section inherited the contradiction by naming `border-strong`.
  **Amended:** the visual-foundation task now specifies `--control-fill: #1D2922` (measured 3.031:1) and `.control-manager` bounded by `--color-border-interactive`, which is the token `DESIGN.md:116` actually assigns to control boundaries. The Verification section gains a contrast assertion.
  **Known-bad state avoided:** shipping a control boundary below the accessibility floor inside a test block named "the accessibility floor" that reported it as met — in a product whose architecture makes a greyscale/contrast check the stated acceptance test.
  **KEEP:** the 20-token parity test asserting frontmatter tokens by name while permitting additions; the four-differentiator structure of the Commissioner class (fill, border, ground, label) as governed by `epics.md:393`; the CSS-generated label so no call site can omit it; and the drift gate's placement ahead of `vite build` in the build script.

- **Iteration 1 — verification gaps closed without spec change (`patch`).** Fourteen further findings were applied directly to the code: four were demonstrated by mutating the implementation and observing all 113 tests still pass (deleting `global.css`'s `@import`s, swapping the page's Commissioner control class, filling the Commissioner control via the `background` shorthand, and declaring a wildcard range in `optionalDependencies`). Remaining patches hardened `check-pins.js` (unbounded context iteration, TOML inline comments, `majorOf` range handling, `process.exit` stderr truncation, all-failures contract) and removed tautological tests that asserted their own re-implementation.

## Design Notes

**Two discrepancies in the source material, resolved:**

1. `DESIGN.md:229` specifies the Manager control fill as `#223028`, which is not one of the 20 frontmatter colour tokens. It is declared as an additional custom property (`--control-fill`) rather than hardcoded, and the token-parity test asserts the 20 frontmatter tokens by name — it does not forbid additions. Flagged rather than silently invented.

2. `DESIGN.md:227-236` lists the four Commissioner differentiators as fill, border, ground, and *the mandatory reason sheet*. Story 1.1's AC lists them as fill, border, ground, and *the persistent label*. The reason sheet is explicitly Story 7.1 and out of scope here (`epic-1-context.md:60`), so the story's four govern. The label is a visual property this story can deliver; the reason sheet is not.

**Greyscale check without a browser:** the test converts each declared colour to relative luminance and asserts the two control classes remain distinguishable on properties that survive desaturation — `border-style: dashed` vs `solid`, absence vs presence of a fill, distinct ground luminance, and the label's presence. This is a structural assertion over token values, not a rendered screenshot; a Playwright visual check is the stronger form and belongs with the first real Commissioner surface in Story 1.7.

## Verification

**Commands:**
- `npm install` -- expected: lockfile resolves at the exact pinned versions
- `npm run build` -- expected: exit 0; drift gate runs first and passes
- `npm run check` -- expected: zero TypeScript and Svelte errors
- `npm test` -- expected: all four test files pass
- `node scripts/check-pins.js` after hand-editing SvelteKit to `2.71.0` -- expected: exit non-zero naming `@sveltejs/kit`, expected `2.70.2`, found `2.71.0`; revert after

## Suggested Review Order

**The pinned stack and its drift gate**

- Start here: the gate is sequenced ahead of Vite, so drift cannot reach a build.
  [`package.json:12`](../../package.json#L12)

- The gate's contract; read this before any test that drives it.
  [`check-pins.js:154`](../../scripts/check-pins.js#L154)

- Five versioned fields, not two — a wildcard in `optionalDependencies` used to pass.
  [`check-pins.js:44`](../../scripts/check-pins.js#L44)

- Rejects `>=24`, `^24`, `18 || 24` — ranges that previously read as a pinned major.
  [`check-pins.js:64`](../../scripts/check-pins.js#L64)

- Only `production` may point at prod; every context is now iterated, not three.
  [`netlify.toml:27`](../../netlify.toml#L27)

**The visual foundation and the contrast correction**

- The 20 frontmatter tokens, declared verbatim; everything visual resolves from here.
  [`tokens.css:16`](../../src/lib/styles/tokens.css#L16)

- Corrected from DESIGN.md's `#223028`, which measured 2.77:1 against the boundary.
  [`tokens.css:128`](../../src/lib/styles/tokens.css#L128)

- The token DESIGN.md:116 assigns to control boundaries; `border-strong` was wrong.
  [`tokens.css:32`](../../src/lib/styles/tokens.css#L32)

**The Commissioner control class**

- Filled, solid, full-width — the Manager baseline the referee control departs from.
  [`commissioner.css:56`](../../src/lib/styles/commissioner.css#L56)

- Never filled, dashed, content-width: three of the four differentiators in one rule.
  [`commissioner.css:89`](../../src/lib/styles/commissioner.css#L89)

- Each interactive state must declare it stays unfilled; a shorthand once defeated this.
  [`commissioner.css:112`](../../src/lib/styles/commissioner.css#L112)

- The fourth differentiator, generated so no call site can omit it.
  [`commissioner.css:130`](../../src/lib/styles/commissioner.css#L130)

**Tests and supporting files**

- Six measured ratios; the assertion that would have caught the 2.77:1 violation.
  [`commissioner.test.ts:105`](../../tests/commissioner.test.ts#L105)

- WCAG 2.1 relative luminance, driving both the contrast and greyscale assertions.
  [`commissioner.test.ts:94`](../../tests/commissioner.test.ts#L94)
