# Deferred Work

- source_spec: none
  summary: Provision the two Supabase projects (wipeable dev, never-hand-touched prod) and wire their connection details as server-only environment variables.
  evidence: Story 1.1 AC 3 requires both projects to exist before a migration can be applied dev-first. Creating Supabase projects requires the Commissioner's own account and credentials, which the build agent cannot hold. Story 1.1 delivers the migrations directory, the env-var contract and the dev-first workflow; the projects themselves are provisioned by hand.

- source_spec: none
  summary: Create the Netlify site, run a production deploy reachable over HTTPS, configure deploy previews and branch deploys against dev Supabase with the production branch against prod, and record the credit cost of the configuration.
  evidence: Story 1.1 AC 5 requires a live deploy. Netlify site creation, branch-deploy configuration and deploy authorization all require the Commissioner's own account. Story 1.1 delivers netlify.toml, the pinned adapter configuration and the branch-to-environment mapping in committed form; the account-side setup and the first real deploy are done by hand.
  partial: 2026-08-20 — the site exists and is deployed. `https://bbslapp.netlify.app` answers HTTP 200 serving the built app, and deploy-preview, header-rule and redirect-rule checks run on pull requests. Still outstanding: confirming the branch-to-environment mapping is actually configured account-side against two Supabase projects that do not yet demonstrably exist, and recording the credit cost. Also note the site is now publicly reachable with no authentication in front of it.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-deployable-skeleton-on-the-pinned-stack.md`
  summary: Add a CI workflow that runs the test suite and svelte-check on every push and pull request.
  evidence: Story 1.1's build path is `check-pins && vite build`; nothing invokes `vitest` or `svelte-check`. A reviewer demonstrated that all 113 tests can be red — or the drift gate removed from the build script entirely — while a Netlify deploy still succeeds. The four suites guarding the AR-2 tree, token parity, the pin contract and the Commissioner distinction can rot indefinitely without a runner.
  resolved: 2026-08-20 in `.github/workflows/ci.yml` (PR #2, merged as 86b58fd). Runs `npm ci`, `npm test` and `npm run check` on every push to `main` and every pull request; actions pinned to commit SHAs rather than tags. Verified green on main at 38373fc — 183 tests pass, svelte-check reports 0 errors. Note this covers the GitHub Actions builder only; the separate `npm ci` entry below concerns the Netlify build command and is untouched by this.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-deployable-skeleton-on-the-pinned-stack.md`
  summary: Add `supabase/config.toml` and document the migration and Edge Function deploy commands.
  evidence: `supabase/migrations/` and `supabase/functions/tick/` are established as canonical locations, but without a config file `supabase start`, `supabase db push` and `supabase functions serve` cannot run. The dev-first, migrations-only rule the .gitkeep states has no local workflow behind it. Belongs with Story 1.5, which first writes schema.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-deployable-skeleton-on-the-pinned-stack.md`
  summary: Write a README covering setup, environment configuration, the two-project Supabase topology, and how to run the tests.
  evidence: The repository ships a Discord OAuth app, a webhook, an out-of-band Commissioner recovery secret and a cron-invoked Edge Function with no setup path documented. Much of the current reasoning lives in .gitkeep comments that will be deleted the moment those directories receive real files.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-deployable-skeleton-on-the-pinned-stack.md`
  summary: Establish CSP, frame-ancestors, Referrer-Policy and a noindex posture for the private league.
  evidence: netlify.toml declares no headers block and svelte.config.js sets no kit.csp. An app carrying a Discord OAuth redirect and a secret-based Commissioner sign-in should establish its security headers before the first auth surface lands in Story 1.3.
  escalated: 2026-08-20 — no longer theoretical. The site is live and publicly reachable at `https://bbslapp.netlify.app`, and `curl -I` confirms no Content-Security-Policy, X-Frame-Options, Referrer-Policy or X-Robots-Tag is served. The noindex half now matters immediately rather than at Story 1.3: a private league's app is currently indexable.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-deployable-skeleton-on-the-pinned-stack.md`
  summary: Record the design rationale, rate limiting, rotation policy and audit logging for COMMISSIONER_RECOVERY_SECRET.
  evidence: The out-of-band Commissioner sign-in is currently documented only as a comment in .env.example. Its rationale — Discord carries both authentication and notification, so an outage must not lock out the referee — is sound and belongs in a design record with its operational controls. Belongs with Story 1.3.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-deployable-skeleton-on-the-pinned-stack.md`
  summary: Add a component-test harness (jsdom or browser project) and an +error.svelte page.
  evidence: vite.config.ts sets `environment: 'node'` and includes only `tests/**`, so no .svelte file can be rendered in a test and no colocated test under src/ is collected. There is also no +error.svelte, so an error renders on the browser default white background, outside the dark-only contract. The Playwright greyscale check that Story 1.7 inherits has no harness waiting for it.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-deployable-skeleton-on-the-pinned-stack.md`
  summary: Enforce the pure-core import boundary by walking src/lib/core/** and asserting explicit .ts extensions on relative specifiers.
  evidence: structure.test.ts checks a hardcoded three-file list and its stated ".ts imports only" rule is not actually asserted — `from './money'` and `from './money.js'` both pass, and both fail to load under Deno. src/lib/core/rules/ and projection/ are never scanned. Story 1.2's acceptance criteria own this purity check in CI; building it here would pre-empt that story.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-deployable-skeleton-on-the-pinned-stack.md`
  summary: Replace the CSS-generated Commissioner label with a Svelte component that emits it into the DOM with aria-describedby.
  evidence: The ::before label cannot be translated or selected and vanishes if the stylesheet fails to load, leaving an unmarked dashed button. Story 1.1 patches it to be presentational so it is not announced twice; the durable fix is a component, and it belongs with Story 1.7, which builds the first real Commissioner surface.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-deployable-skeleton-on-the-pinned-stack.md`
  summary: Handle Windows High Contrast / forced-colors mode so the Commissioner differentiators survive it.
  evidence: Under forced-colors the author-declared fill and ground are overridden by the OS palette, collapsing two of the four differentiators and leaving the referee control harder to distinguish from a player control — the exact confusion the four-property design exists to prevent.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-deployable-skeleton-on-the-pinned-stack.md`
  summary: Replace structure.test.ts's `.gitkeep`-presence assertion with a non-empty-directory assertion.
  evidence: The test requires a .gitkeep in nine directories, but each marker should be deleted the moment a real file lands there — so the test is built to fail on a correct change. Story 1.5 will be the first to trip it.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-deployable-skeleton-on-the-pinned-stack.md`
  summary: Verify tsconfig.json actually type-checks scripts/ and tests/, and add an explicit include if it does not.
  evidence: tsconfig inherits `include` from the generated .svelte-kit/tsconfig.json, which covers src/** and not sibling top-level directories — so allowJs/checkJs may never check scripts/check-pins.js, and npm run check may give no coverage of the test suite that imports it. Confirm with `npx tsc --showConfig`.
  verified: 2026-08-20 at 38373fc — the suspicion is confirmed and the remedy is still outstanding. `npx tsc --showConfig` resolves `include` to `.svelte-kit/ambient.d.ts`, `.svelte-kit/env.d.ts`, `.svelte-kit/non-ambient.d.ts`, `.svelte-kit/types/**/$types.d.ts`, `vite.config.{js,ts}`, `src/**/*.{js,ts,svelte}`, `test/**/*.{js,ts,svelte}` and `tests/**/*.{js,ts,svelte}`. So `tests/` IS covered, `scripts/` is NOT, and `checkJs` is true — `scripts/check-pins.js` is never type-checked despite being the build's first gate. Only the verification half of this entry is discharged; the explicit `include` has not been added.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-deployable-skeleton-on-the-pinned-stack.md`
  summary: Reconcile whether the design intends `#1D2922` as the corrected Manager control fill in DESIGN.md itself.
  evidence: Story 1.1 corrected `--control-fill` from DESIGN.md:229's `#223028` to `#1D2922` because the original measured 2.77:1 against the control boundary, below WCAG 1.4.11's 3:1. DESIGN.md is status:final and its line 229 still carries the failing value, so the design document and the implementation now disagree until the correction is folded back at source.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-deployable-skeleton-on-the-pinned-stack.md`
  summary: Commit the planning artifacts, or vendor DESIGN.md's token frontmatter into the repository.
  evidence: tests/tokens.test.ts reads DESIGN.md out of _bmad-output/ at module load. Story 1.1 patches the path to resolve by glob, but the token suite still depends on a planning directory being committed alongside the source and never moved. Vendoring the frontmatter would make the repository self-contained.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-deployable-skeleton-on-the-pinned-stack.md`
  summary: Use `npm ci` rather than `npm install` in the Netlify build command once the lockfile is committed.
  evidence: Direct dependencies are pinned exactly, but transitive versions resolve fresh on every build unless the lockfile is both committed and installed from. `npm ci` is the flag that makes the pin contract hold below the top level.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-deployable-skeleton-on-the-pinned-stack.md`
  summary: Make `check-pins.js`'s CLI entry-point detection case-insensitive on Windows drive letters.
  evidence: bmad-code-review (2026-08-20) on `f6f7be4`, Edge Case Hunter layer. The guard `import.meta.url === pathToFileURL(invokedPath).href` compares two URL strings whose drive-letter casing can legitimately differ on Windows (`C:` vs `c:`) depending on how the process was invoked. When they disagree the CLI branch never runs, so `node scripts/check-pins.js` silently does nothing — no drift check, no error, no exit code — on a local Windows dev machine, this repository's actual environment. CI is unaffected (`ubuntu-latest`), and `npm run build`'s own invocation was verified to still trip the check correctly in the current tree, so this is a latent gap rather than an observed regression. Fix is a case-insensitive comparison of the two URL strings before deciding whether to run.
