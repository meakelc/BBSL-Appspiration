<!-- bmad:context -->
<!-- Verified 2026-08-20 against a21dacb. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## BBSL-Appspiration

The BBSL offseason free agent auction — a private 30-team league app. SvelteKit 2 on Netlify,
Supabase Postgres, TypeScript, npm. Built as a functional core / imperative shell over an
event-sourced auction domain. The architecture spine is the rulebook; this file is a pointer to it.

## Policy

- Never commit to `main` — branch, then PR.
- Never hand-edit `_bmad-output/` — the `bmad-*` skills own that tree. Run the owning skill instead.
- Never type schema into the Supabase dashboard. Every change is a migration file in
  `supabase/migrations/`, applied dev-first across the two projects.
- Never give a client-facing role a write path. Mutations go through server-side code holding the
  service role; the browser's key is read-only Realtime.

## Where things are

- The rules are the 30 numbered ADs in `ARCHITECTURE-SPINE.md`, under the newest dated directory in
  `_bmad-output/planning-artifacts/architecture/`. Read the ADs a change touches before writing
  code, and cite them by number in comments as the existing source does.
- Touching `src/lib/core/`, `src/lib/shell/`, or `supabase/`? Read AD-1 through AD-12 first —
  core purity, the single advisory lock, the append-only log, injected time.
- Known gaps are already logged with evidence in
  `_bmad-output/implementation-artifacts/deferred-work.md`. Check it before proposing work, and do
  not build a deferred item unprompted.

## Running and verifying

- CI (`.github/workflows/ci.yml`) runs `npm test` and `npm run check` on every push to `main` and
  every pull request. `npm run build` runs neither, so a green local build proves nothing about the
  suite — run both before calling a change done.
- `npm run check` does not cover `scripts/`. The resolved tsconfig `include` is `src/**` and
  `tests/**` only, so `scripts/check-pins.js` is never type-checked despite `checkJs`.
- Vitest collects `tests/**/*.test.ts` only, in the `node` environment. A test placed beside its
  source under `src/` is silently never run, and no `.svelte` file can be rendered in a test.

## Conventions that differ from defaults

- `src/lib/core/**` is pure: no I/O, no clock, no randomness, no `$lib` alias, no `node:` builtins,
  stdlib only. Relative imports carry an explicit `.ts` extension so Deno loads the same files.
  (`tests/structure.test.ts` checks only three named files today; Story 1.2 makes it a walk.)
- Money is integer dollars, branded at every runtime boundary — never floats, never cents, never a
  decimal library. The same `int8` arrives as a string through one client and a number through the other.

## Known pitfalls

- Adding the first real file to an AR-2 directory? `tests/structure.test.ts` still requires that
  directory's `.gitkeep`, so deleting the marker fails the suite. Leave it until that test is fixed.

<!-- /bmad:context -->
