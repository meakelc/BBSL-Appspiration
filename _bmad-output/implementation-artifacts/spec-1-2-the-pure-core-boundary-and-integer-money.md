---
title: 'Story 1.2: The pure core boundary and integer money'
type: 'feature'
created: '2026-08-20'
status: 'done'
baseline_commit: '7a2d74af6ca1ad67769aa0d73ce8f872cdf4f6b8'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `src/lib/core/{constants,money,types}.ts` are empty stubs and nothing enforces the core's purity, so the next story is free to import `$lib`, read a clock, or write `"8500000" + 500000` — and AD-2's divergence, an auction that closes under different rules than it bids under, becomes reachable rather than prevented.

**Approach:** Fill `constants.ts` with every league constant and the single advisory lock key; fill `money.ts` with a branded integer-dollar type, its edge parsers, its abbreviated renderer and a distinct export encoder the renderer cannot reach; seal `src/lib/core/**` behind a static purity walk gating both the build and CI, plus a CI-only `deno check` proving the same source loads under the second runtime.

## Boundaries & Constraints

**Always:** Money is integer dollars, branded at every runtime boundary — the same `int8` arrives as a `string` through node-postgres and a `number` through PostgREST. Rendering is `$14.5M`: exactly one decimal never dropped, U+2212 for negatives, loud failure rather than a silent round for any value off the $500,000 grid. The purity walk recurses `src/lib/core/**` rather than reading a file list, and strips comments and string literals first so a doc comment naming `Date.now()` is not a false failure. New scripts copy `scripts/check-pins.js`: a pure exported checker the tests drive with synthetic inputs, plus a thin CLI setting the exit code.

**Ask First:** Any new dependency. Changing a pinned version. Adding a constant the epic AC does not name. Giving the renderer a second permitted destination.

**Never:** No float, decimal library, cents, `toFixed` or `parseFloat` on the money path. No `evaluate()`, `decide()`, gate sets, commands or events — `types.ts` keeps its stub for Epic 2. No `leagueMedian()`; AD-8 assigns it to `core/money` but it ships with the Teams index (4.6). No "no cap limit" rendering — that needs unbounded Maximum Bid (2.8). No admin UI, config file or environment variable may supply any constant here.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| int8 via node-postgres | `parseMoney("8500000")` | `Money` 8500000 | N/A |
| int8 via PostgREST | `parseMoney(8500000)` | `Money` 8500000 | N/A |
| Non-integer | `8500000.5`, `"8.5e6"` | throws | Names the received value |
| Beyond safe integer | `"9007199254740993"` | throws | States it exceeds safe-integer range; never rounds |
| Null / empty / NaN | `null`, `""`, `NaN` | throws | Names the received type; never coerces to 0 |
| Ordinary render | `formatMoney(14500000)` | `$14.5M` | N/A |
| Whole million | `formatMoney(12000000)` | `$12.0M` — decimal never dropped | N/A |
| Negative | `formatMoney(-4000000)` | `−$4.0M`, U+2212 not `-` | N/A |
| Sub-million and zero | `500000`, `0` | `$0.5M`, `$0.0M` | N/A |
| Off-grid | `formatMoney(4250000)` | throws | States it is not on the $500,000 grid |
| Export encoding | `toExportDollars(14500000)` | `"14500000"` as `ExportCell` | N/A |
| Renderer into a CSV cell | `DisplayMoney` where `ExportCell` is required | Fails to compile | `npm run check` reports it |
| Unparsed arithmetic | `"8500000" + 500000` as `Money` | Fails to compile | Same |
| Forbidden import in core | `$lib`, `node:fs`, any bare specifier | Purity gate exits non-zero | Names file, line, specifier |
| Extensionless core import | `from './money'` or `'./money.js'` | Purity gate exits non-zero | States `.ts` is required |
| Clock or randomness in core | `Date.now()`, `new Date()`, `Math.random()`, `fetch`, `process` | Purity gate exits non-zero | Names file, line, reference |
| Core breaks the second runtime | a construct Deno cannot resolve or type-check | CI Deno step fails | `deno check` names the file |

</frozen-after-approval>

## Code Map

- `src/lib/core/constants.ts` -- stub, doc comment then `export {}`. Values fixed by `prd.md:714` and `ARCHITECTURE-SPINE.md:307`: $165,000,000 cap, $1,000,000 minimum, **one** $500,000 constant serving both Minimum Increment and grid, 24h and 48h clocks, 12 Active/Bench, 2 Injury Reserve, 3 Minor League, Year Allotment one 4-year / one 3-year / two 2-year / unlimited 1-year. `FRESHNESS_WINDOW` 30s and `STALE_WINDOW` 120s are a human decision of 2026-08-20 — no artifact names them (Design Notes). The AD-6 lock key is one `bigint` for the one-argument `pg_advisory_xact_lock`.
- `src/lib/core/money.ts` -- stub. Fill with the `Money` brand, `parseMoney`, brand-preserving arithmetic, `formatMoney → DisplayMoney`, `toExportDollars → ExportCell`.
- `src/lib/core/types.ts` -- **leave as-is**; amend only its "Story 1.2 fills this in" line to name Epic 2.
- `scripts/check-pins.js` -- **the shape to copy**: frozen constants (line 27), pure `checkPins(inputs)` and `readRepositoryInputs()` exported, CLI at the bottom setting the exit code.
- `tests/pins.test.ts` -- **the test shape to copy**: drives the checker with synthetic drifted inputs, then separately asserts the real repository passes.
- `tests/structure.test.ts:68-78` -- `describe('the pure core boundary is not pre-broken')` checks three hardcoded files and its ".ts imports only" claim does not hold (`from './money'` passes). **Delete that block only**; the `.gitkeep` assertions at line 48 still bind.
- `.github/workflows/ci.yml` -- gains the Deno step; actions are pinned by commit SHA with the tag in a trailing comment.
- `package.json:14` -- `build` is `check-pins && vite build`; the new gate joins that chain. `deferred-work.md:38` is the entry this story discharges.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/constants.ts` -- declare every constant above as a named `const` with a one-line comment citing its PRD or AD source, keeping the purity header -- Epics 2–6 read these for every import, cap and gate computation.
- [x] `src/lib/core/money.ts` -- `Money`, `DisplayMoney` and `ExportCell` as distinct unique-symbol brands; `parseMoney(value: unknown): Money` accepting `string` and `number`, throwing on all else; brand-preserving `addMoney`, `subtractMoney`, `multiplyMoney`, `compareMoney`; `formatMoney` by integer division on the $500,000 grid with no float operation; `toExportDollars` -- distinct brands are what make the renderer structurally unreachable from a CSV cell.
- [x] `scripts/check-core-purity.js` -- export `readCoreSources()` walking `src/lib/core/**` and pure `checkCorePurity(sources)` returning every violation with file, line and offending text; CLI sets the exit code -- report all failures, not the first.
- [x] `package.json` -- add `check:purity`; run the purity gate after the pin gate and before `vite build` -- a broken core boundary must not reach a deploy.
- [x] `.github/workflows/ci.yml` -- add `denoland/setup-deno` pinned to `22d081ff2d3a40755e97629de92e3bcbfa7cf2ed` (v2.0.5) with `deno-version: v2.9.5`, then `deno check src/lib/core/*.ts` -- only CI has the second runtime AD-2 exists for.
- [x] `tests/purity.test.ts` -- drive `checkCorePurity` with synthetic sources covering every purity row of the matrix; assert the real tree passes; assert `ci.yml` still contains the Deno step -- the gate must not be removable while the suite stays green.
- [x] `tests/money.test.ts` -- cover every parse, render and export row; assert `money.ts` source contains no `toFixed`, `parseFloat` or decimal literal; add `// @ts-expect-error` cases for `"8500000" + 500000` as `Money` and `DisplayMoney` as `ExportCell` -- `npm run check` type-checks `tests/**`, so those compile-time claims are genuinely verified.
- [x] `tests/structure.test.ts` -- delete the superseded block only.
- [x] `tsconfig.json` -- add `allowImportingTsExtensions` -- **not anticipated at planning time.** TypeScript rejects the explicit `.ts` specifier AD-2 requires unless this is on, and it is only legal because the generated SvelteKit config sets `noEmit`. Without it `npm run check` reports three errors on the core's own import style.
- [x] `tests/constants.test.ts` -- **added.** The epic AC's `constants.ts` group ("when it is inspected, then it holds every league constant") had no covering test in the planned file list. Asserts every value, that exactly one constant declares `500_000`, that the lock key is a single `bigint` inside int8 range, and that nothing in the module reads an environment variable.

**Acceptance Criteria:**
- Given a violating file added under `core/rules/` or `core/projection/`, when `npm test` or `npm run build` runs, then it fails naming that file — the walk reaches directories no hardcoded list covered.
- Given `npm run check`, when it runs, then svelte-check reports zero errors and no unused `@ts-expect-error`.
- Given a pull request, when CI runs, then `deno check` resolves and type-checks the core with no `deno.json` and no node_modules resolution.
- Given `deferred-work.md`'s pure-core-boundary entry, when this story is done, then the walk exists and the entry is discharged.

## Spec Change Log

- **Iteration 1 — the purity gate parses instead of stripping, and the frozen text still names stripping (`patch`, with an open question for the human).**
  **Triggering finding:** the Acceptance Auditor read the `<frozen-after-approval>` **Always** clause — "the purity walk ... strips comments and string literals first so a doc comment naming `Date.now()` is not a false failure" — against `scripts/check-core-purity.js`, which has no stripping stage and instead parses each file with the TypeScript compiler.
  **Amended:** nothing in the frozen block, which only the human may change. The Design Note claiming "comment stripping is load-bearing" is corrected below to describe what shipped. **The frozen clause still names a mechanism the code does not use** — the constraint's stated *purpose* is met and met more strongly (a comment is not an identifier, and `tests/purity.test.ts`'s "comments and strings are not code" proves it), but the named means differs. Routed as `patch` rather than `bad_spec` because reverting verified work to re-derive a weaker regex scanner would trade a correct implementation for a literal one; the human owns the frozen text and can amend it or order the loopback.
  **Known-bad state avoided:** a regex scanner failing on the core's own doc comments, which name every forbidden construct verbatim — the exact false positive the clause exists to prevent.
  **KEEP:** the AST approach; the `comments and strings are not code` regression test; the three mutually unassignable brands; and the CLI's optional root argument, which is what makes the failing path testable without writing a violation into `src/`.

- **Iteration 1 — six real bypasses in the purity gate, closed (`patch`).** Every one was reproduced before fixing. `Math['random']()`, `eval`, `Function`, `Intl`, `WeakRef`/`FinalizationRegistry` and `import x = require(...)` all passed the gate untouched; `new.target` was reported as "import.meta"; and `class C { process() {} }` was a false positive. The visitor now checks element access as well as property access, the forbidden list covers code-from-strings and cross-runtime ICU, `ImportEqualsDeclaration` is refused, `MetaProperty` names the construct actually present, and member declarations are no longer treated as global references. `FORBIDDEN_GLOBALS` is a frozen array with the working `Set` built privately — `Object.freeze` on a `Set` does not prevent `.delete()`, so the previous export could be used to disarm the gate.

- **Iteration 1 — `parseMoney("-00")` returned `0` instead of throwing (`patch`).** The round-trip check special-cased negative zero-magnitude text by comparing against the literal `'0'` rather than the supplied text, so `"-00"`, `"-000"` and `"-0000000"` all parsed while the positive `"00"` was correctly refused. `INTEGER_TEXT` now matches only canonical integers, and the round-trip check has one legal exception (`"-0"`). Verified by probe before and after.

- **Iteration 1 — the CLI entry point had no test, which both verification-gap passes flagged as the gap that matters (`patch`).** Every test called `checkCorePurity()` directly, so the module-identity guard, the stderr write and `process.exitCode` — the three things that actually fail a build — were never executed. The guard's own comment records that this comparison already broke once on Windows drive-letter casing. `tests/purity.test.ts` now spawns the real script against a temp fixture and asserts exit 1 with the violation on stderr, exit 0 on a clean core, and that `package.json`'s `build` runs the gate ahead of Vite.

- **Iteration 1 — smaller patches.** `--node-modules-dir=none` added to the Deno step so AC 3's "no node_modules resolution" clause is enforced by the command rather than asserted by its comment. `INJURY_RESERVE_SLOTS` and `MINOR_LEAGUE_SLOTS` gained the PRD citations every other constant carries. `constants.test.ts`'s "declared exactly once" now counts declarations rather than textual mentions. `money.test.ts` gained the `-00` family, `+8500000`, the deliberate whitespace leniency, the numeric `-0` branch, a negative scale factor, and off-grid amounts either side of a grid value. `purity.test.ts` now asserts *which* rule fired rather than that something did. A new test asserts the generated tsconfig still covers `tests/`, without which every `@ts-expect-error` guarantee could stop being enforced silently.
  **Deviation recorded:** the Deno step runs `find src/lib/core -name '*.ts'` rather than the task's literal `src/lib/core/*.ts`, because the glob would not reach `rules/` or `projection/` — the recursion the spec requires everywhere else.

## Design Notes

**Two windows nobody specified.** The AC requires `FRESHNESS_WINDOW` and `STALE_WINDOW` in `constants.ts`, but no PRD, spine or epic text assigns a number. Chosen by human decision 2026-08-20: 30s and 120s, against CAP-10's 5-second board floor and AD-29's "can I still reach the server?" liveness re-read. Story 4.1 consumes them and may renegotiate; nothing here depends on the values.

**Arity is the whole point of the lock key.** Postgres' one- and two-argument advisory lock forms occupy disjoint lock spaces, so a mixed arity excludes nothing and fails silently and totally. One constant, one `bigint`, one-argument form.

**No float, provably.** On the `MINIMUM_INCREMENT` grid the tenths digit can only be `0` or `5`, so the rendering is taken by remainder and division and concatenated, never formatted. *Correction to this note as first written:* it claimed the renderer "never divides by `1e6`", and it does — but only after subtracting the remainder, so both operands are exact multiples and IEEE-754 division of them is exact. The property that matters is that no fractional value ever exists, which `tests/money.test.ts` proves by parsing the module and asserting it declares no fractional numeric literal at all.

**Ignoring comments and strings is load-bearing — and it is done by parsing, not stripping.** The stubs' own doc comments name every forbidden construct, so a raw-text scanner fails on the files it protects. `scripts/check-core-purity.js` therefore parses each file with the TypeScript compiler, where a comment is not an identifier and a string's contents are not references; that also removes any need to solve regex-literal detection and template interpolation. See the Spec Change Log — the frozen **Always** clause still names stripping.

**`AGENTS.md` goes stale** — its block says structure.test.ts "checks only three named files today". It is owned by `bmad-project-context`; run that skill after merge rather than hand-editing.

## Verification

**Commands:**
- `npm test` -- expected: all suites pass, including the new `purity` and `money` files
- `npm run check` -- expected: zero errors; every `@ts-expect-error` used
- `npm run build` -- expected: exit 0, both gates ahead of Vite
- `node scripts/check-core-purity.js` after adding `import { readFileSync } from 'node:fs';` to `core/money.ts` -- expected: non-zero naming file, line, specifier; revert after
- `node scripts/check-core-purity.js` after dropping `.ts` from a core import -- expected: non-zero stating the extension is required; revert after
- `npm run build` with a violating file under `src/lib/core/rules/` -- expected: exit 1 before Vite runs, naming the nested file; the walk reaches where no file list did

**Manual checks (if no CLI):**
- Deno is not installed locally, so its step cannot run here. Confirm it green on the pull request before calling this story done.

## Suggested Review Order

**The boundary itself — what makes impurity unreachable**

- Start here: three unique-symbol brands are the whole structural argument.
  [`money.ts:32`](../../src/lib/core/money.ts#L32)

- The CSV path takes `ExportCell`; a rendering is a compile error, not a convention.
  [`money.ts:173`](../../src/lib/core/money.ts#L173)

- The walk's contract: every violation, with file and line, never just the first.
  [`check-core-purity.js:169`](../../scripts/check-core-purity.js#L169)

- Parses rather than strips, so the core's own doc comments are not false failures.
  [`purity.test.ts:123`](../../tests/purity.test.ts#L123)

**The evasions the review found, now closed**

- Bracket access: `Math['random']()` is the same call, written to slip a name check.
  [`check-core-purity.js:267`](../../scripts/check-core-purity.js#L267)

- `import x = require(...)` is CommonJS Deno will not resolve.
  [`check-core-purity.js:241`](../../scripts/check-core-purity.js#L241)

- Frozen array, private Set — `Object.freeze` does not stop `Set.delete`.
  [`check-core-purity.js:59`](../../scripts/check-core-purity.js#L59)

- Canonical integers only; the old regex let `"-00"` through as zero.
  [`money.ts:55`](../../src/lib/core/money.ts#L55)

- One legal exception, replacing the special case that caused the hole.
  [`money.ts:94`](../../src/lib/core/money.ts#L94)

**The constants everything downstream reads**

- One constant serves the Minimum Increment and the grid; two could drift.
  [`constants.ts:34`](../../src/lib/core/constants.ts#L34)

- One `bigint`, one-argument form — mixed arity excludes nothing, silently.
  [`constants.ts:99`](../../src/lib/core/constants.ts#L99)

- The two windows no planning artifact ever assigned a number.
  [`constants.ts:56`](../../src/lib/core/constants.ts#L56)

**Where the gate actually fires**

- Spawned for real against a fixture; every other test bypasses this guard.
  [`purity.test.ts:180`](../../tests/purity.test.ts#L180)

- The optional root argument is what makes the failing path testable.
  [`check-core-purity.js:359`](../../scripts/check-core-purity.js#L359)

- Only CI has the second runtime AD-2 exists for.
  [`ci.yml:80`](../../.github/workflows/ci.yml#L80)

- Verified by svelte-check, not vitest — vitest strips types without checking.
  [`money.test.ts:183`](../../tests/money.test.ts#L183)
