---
title: 'Story 1.3: Sign in with Discord'
type: 'feature'
created: '2026-08-21'
status: 'done'
baseline_commit: '5da527364222f4d648f0f7bd573b57d47a5a8b3c'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The app has no identity at all — `src/lib/server/` is a `.gitkeep`, `supabase/migrations/` is empty, and the live site at `bbslapp.netlify.app` serves every surface to anyone who finds it, with no CSP and no `noindex`. Nothing downstream can record *who* acted, and AD-27's break-glass path — the one thing that keeps the pause control reachable when Discord is the component that failed — does not exist.

**Approach:** Add the two pinned Supabase client packages; create a `managers` registry migration the Commissioner alone writes; gate Discord OAuth on that registry server-side so an unregistered account never obtains a session; render one sign-in surface with a single Discord action, the current phase, and no email field; add an unadvertised Commissioner sign-in that trades `COMMISSIONER_RECOVERY_SECRET` for its own signed cookie, independent of Supabase Auth and Discord; and serve the security headers the live deploy is missing.

## Boundaries & Constraints

**Always:** Registry membership, the Discord user ID and every authorization decision resolve **server-side from the `managers` table** — never from JWT app-metadata or any claim `updateUser` lets a client write (AD-15). Sessions persist ≥30 days (AD-27). The refusal for an unregistered account states only that the Commissioner must add the account: no retry prompt, no "try another account", nothing that distinguishes an unknown Discord identity from a known one, and the same response body and status for every unregistered caller. Session expiry is a **distinct, explicitly stated outcome** from a fresh sign-out and returns the Manager to the surface they were on. The Discord provider is reached through an injectable port so a test can simulate it being down. Secrets are compared in constant time. New scripts and gates copy `scripts/check-pins.js`: a pure exported checker driven by synthetic inputs, plus a thin CLI. Every table carries an explicit RLS policy and anonymous roles read nothing (AD-16).

**Ask First:** Any dependency beyond the two named below. Changing a pinned version. Any schema column beyond the registry's own identity fields. Widening the CSP beyond what Discord OAuth and Supabase Realtime actually require.

**Never:** No email field, email input, magic link, password reset or SMTP anywhere — this system sends no email for any purpose. No self-service registration. No Team binding, `is_commissioner` column, co-management or Commissioner-only route guard — those are Story 1.4, and this story must not pre-empt them. No client write path and no `PUBLIC_`-prefixed secret. No events, no `auction_events` table, no projections — Story 1.5. The break-glass path is never linked, listed or hinted at on the Manager sign-in screen. No `.gitkeep` deletion: `tests/structure.test.ts` still asserts every AR-2 marker is present.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Registered Discord account | OAuth callback, `provider_id` present in `managers` | Session established; Discord user ID recorded | N/A |
| Unregistered Discord account | callback, `provider_id` absent from registry | No session — any partial session is destroyed before responding; refusal names the Commissioner only | Identical response for every unregistered caller |
| Registry probe attempt | two different unregistered IDs | Byte-identical status, body and headers | Nothing timing- or content-distinguishable |
| Expired session | cookie present, refresh refused | States the session expired, not a sign-out; preserves the attempted path for return | N/A |
| Signed-out visitor | no cookie | One Discord action, one sentence, current phase named | N/A |
| Discord unavailable | OAuth port throws / non-2xx | Manager sign-in states Discord is unreachable; break-glass path still issues a Commissioner session | Failure surfaced, never swallowed |
| Break-glass, correct secret | secret matches | Signed cookie marked break-glass; Commissioner reaches the app without Discord | N/A |
| Break-glass, wrong secret | mismatch, or secret unset | Refused; no hint whether the secret is wrong or absent | Attempts throttled per source |
| Break-glass cookie tampered | signature or expiry altered | Treated as no session at all | Rejected before any lookup |
| Callback replayed | code already exchanged | No second session | Refused, states nothing about the registry |

</frozen-after-approval>

## Code Map

- `package.json:20` -- devDependencies only today; add a `dependencies` block with `@supabase/supabase-js` `2.112.3` and `@supabase/ssr` `0.12.4`, exact literals (`check-pins.js:36` rejects any range).
- `scripts/check-pins.js:27` -- `PINNED_PACKAGES`; add both. Its `byName` map (line 205) already reads `dependencies` as well as `devDependencies`, so no logic change.
- `tests/pins.test.ts:53` -- asserts `PINNED_PACKAGES` `toEqual` exactly the current two. **Must be updated** or the suite goes red on the pin addition alone.
- `supabase/migrations/` -- empty but for `.gitkeep`; this story writes the first migration, `20260821000000_managers.sql` (Supabase's UTC-timestamp convention).
- `src/lib/server/` -- `.gitkeep` says "Filled by Stories 1.3-1.5". Leave the marker (AGENTS.md pitfall); add the Supabase clients, the registry lookup and the break-glass module here.
- `src/app.d.ts:10` -- `App.Locals` is commented out and its comment says Story 1.4 fills it. **Amend that comment**: 1.3 establishes the session/registry locals, 1.4 adds the Team binding and Commissioner flag.
- `src/routes/+page.svelte:22` -- already renders a Phase block from a hardcoded sentence; the sign-in surface states phase from the same server-resolved source, so factor the sentence rather than copying it.
- `src/lib/styles/commissioner.css` + `tests/commissioner.test.ts` -- the Commissioner control class the break-glass surface uses. `tests/structure.test.ts:99` proves the class must match the block it sits in.
- `netlify.toml:28` -- no `[[headers]]` block; add one after `[functions]`. `deferred-work.md:26` is the entry this discharges; `:30` is the COMMISSIONER_RECOVERY_SECRET design record, also discharged here.
- `.env.example:22-39` -- every variable this story needs is already declared. `tests/structure.test.ts:149` asserts the file names them and carries no values.
- `vite.config.ts:8` -- `environment: 'node'`, `include: ['tests/**']`. **No `.svelte` file can be rendered in a test** (`deferred-work.md:35`), so surface claims are asserted against source text as `structure.test.ts:104` does.

## Tasks & Acceptance

**Execution:**
- [x] `package.json`, `scripts/check-pins.js`, `tests/pins.test.ts` -- add both Supabase packages as exact-pinned `dependencies`, add them to `PINNED_PACKAGES`, update the `toEqual` assertion -- an unpinned auth client is the drift gate's whole point.
- [x] `supabase/migrations/20260821000000_managers.sql` -- `managers` table: surrogate id, `discord_user_id` unique not null, `display_name` not null, `created_at`; RLS enabled with **no** policy granting any client-facing role read or write -- AD-15's "written only by the Commissioner", AD-16's "anonymous roles read nothing".
- [x] `src/lib/server/supabase.ts` -- the service-role client and the per-request `@supabase/ssr` client bound to the request's cookies -- one place holds the service key, so no route can reach it by accident.
- [x] `src/lib/server/auth.ts` -- the injectable OAuth port, `findRegisteredManager(discordUserId)`, and pure `resolveSessionState(input)` returning `signed-out | registered | unregistered | expired | discord-unavailable` -- purity is what lets every matrix row be a unit test with no network.
- [x] `src/lib/server/commissioner-recovery.ts` -- constant-time secret comparison, signed cookie mint/verify with explicit expiry, and per-source attempt throttling; export the pure half -- a shared secret with no throttle is a guessing oracle.
- [x] `src/hooks.server.ts`, `src/app.d.ts` -- resolve session state once per request into `locals`; amend the `app.d.ts` comment to name 1.3 and 1.4 correctly -- one resolution per request, never per surface.
- [x] `src/routes/signin/+page.svelte` + `+page.server.ts` -- single Discord action, one sentence, current phase, and the distinct refusal/expired/Discord-down states; `control-manager` class -- four states, one surface, no email field.
- [x] `src/routes/auth/callback/+server.ts` -- exchange the code, gate on the registry, destroy any partial session before refusing -- the gate must sit server-side of the session, not beside it.
- [x] `src/routes/commissioner-recovery/+page.svelte` + `+page.server.ts` -- the break-glass surface, `control-commissioner` class, reachable without a Discord session and linked from nowhere -- the path is unadvertised, never secret; the secret is the control.
- [x] `netlify.toml` -- `[[headers]]` serving `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy`, `X-Frame-Options`/`frame-ancestors 'none'`, and a CSP admitting only the Discord OAuth redirect and the Supabase Realtime WebSocket -- the site is live and currently indexable.
- [x] `tests/auth.test.ts` -- drive `resolveSessionState` and the registry gate across every matrix row, including two distinct unregistered IDs producing byte-identical refusals and the Discord-down simulation -- the non-enumeration claim is the one an attacker tests.
- [x] `tests/commissioner-recovery.test.ts` -- correct secret, wrong secret, unset secret, tampered cookie, expired cookie, throttle -- and that the path works with the OAuth port throwing.
- [x] `tests/signin-surface.test.ts` -- assert **no** `.svelte` file in `src/routes/**` contains an email input, that the sign-in surface names the phase and offers exactly one Discord action, that it never mentions the break-glass route, and that each control's block matches its class -- "no email field anywhere" is a repository-wide claim, so assert it repository-wide.
- [x] `tests/headers.test.ts` -- parse `netlify.toml` with `readSimpleToml`'s sibling logic or a direct read, asserting each header is present and the CSP names no wildcard host -- headers that stop being served fail nothing otherwise.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- append `resolved:` lines to the security-headers and COMMISSIONER_RECOVERY_SECRET entries; do not modify their existing text.

**Acceptance Criteria:**
- Given `npm test` and `npm run check`, when they run, then both pass with zero errors and every new module is type-checked under `strict` and `noUncheckedIndexedAccess`.
- Given `npm run build`, when it runs, then the pin gate accepts the two new dependencies and fails if either is written as a range.
- Given a reviewer reading the migration, when they inspect it, then `managers` carries RLS with no client-facing policy, and the story adds no Team, co-management or Commissioner column.
- Given the live deploy, when `curl -I` fetches any URL, then `X-Robots-Tag`, `Referrer-Policy`, a frame-ancestors control and a CSP are all served.

## Spec Change Log

- **Iteration 1 — a live authentication bypass in the identity path, closed (`patch`).**
  **Triggering finding:** the Blind Hunter read `src/hooks.server.ts:89` and `src/lib/server/supabase.ts:161`, both resolving identity as `user_metadata?.['provider_id'] ?? identities?.[0]?.id` — metadata **first**. `user_metadata` is self-writable through `updateUser`, and `PUBLIC_SUPABASE_ANON_KEY` is public by design, so any Discord account could authenticate directly against the project, name a registered Manager's Discord id, and be resolved as that Manager. Supabase also merges provider data *into* `user_metadata` on sign-in, so a forged value is shape-identical to a genuine one. This inverted the frozen **Always** clause and AD-15, and `auth.ts`'s own docblock asserted the opposite of what the code did.
  **Amended:** nothing in the frozen block, which already forbade this correctly — the spec was right and the code was wrong, which is why this routed as `patch` rather than `bad_spec`. One exported `discordIdentityOf()` now reads `identities` only, selects by `provider === 'discord'` rather than index `[0]`, and fails closed on zero, blank, or two disagreeing Discord identities.
  **Known-bad state avoided:** impersonation of any registered Manager by any Discord account — and, because Story 1.4's AC requires a test that "a client-forged metadata claim changes nothing", a hole introduced here that the *next* story's acceptance would have been expected to catch.
  **KEEP:** the single `discordIdentityOf()` reader (two copies are what let the call sites drift); the forged-metadata test naming a registered Manager; the control case proving a forger still resolves to her *own* row if registered; and the source-level assertion that `user_metadata`/`app_metadata` appear in no identity path — a behavioural test alone would miss a fallback that only fires when `identities` is empty. Verified by mutation: reintroducing the metadata read turns 4 tests red.

- **Iteration 1 — the request glue had no test coverage, which is how the bypass shipped (`patch`).** `hooks.server.ts` and `supabase.ts` were the only new modules without a test file, and `hooks.server.ts` reads `$env/dynamic/private`, so the suite could not import it. `gatherSessionFacts` moved to `src/lib/server/session.ts` behind an injected `SessionGateway`; `hooks.server.ts` keeps source-level assertions that it stays thin wiring. 29 tests cover cookie-absent (asserting no round trip), refresh-refused, registered, unregistered, forged metadata, registry throw and gateway throw.

- **Iteration 1 — four verification gaps where a test existed but proved nothing (`patch`).** `noticeFor`'s state→sentence mapping was asserted by grepping the source for four identifiers, so swapping two `case` arms stayed green; it moved to `auth.ts` (a `+page.server.ts` may only export SvelteKit's own symbols) and is now driven state by state. The callback route's exported `GET`, the break-glass action's `cookies.set`, and `AttemptLedger`'s eviction were all untested; each now has a test, and each was confirmed to go red against a deliberately reverted fix before being accepted.

- **Iteration 1 — smaller patches.** `safeReturnTo` rejects C0/DEL/C1 characters: `trim()` left an interior CRLF intact, so `?next=/x%0d%0a…` passed every guard and reached the `location` header, where undici throws and the callback 500s. `completeCallback` destroys the partial session when `findRegisteredManager` *throws*, not only when the registry answers. The callback route's `referrer-policy` and `x-robots-tag` were made identical to `netlify.toml`'s rather than picking a precedence Netlify does not document. `RECOVERY_ACCEPTED` interpolates `BREAK_GLASS_TTL_HOURS` instead of hardcoding "12 hours" as prose.

- **Iteration 1 — three deviations recorded rather than fixed.**
  1. **The frozen block and its own tasks disagree on RLS.** The **Always** clause says "every table carries an explicit RLS policy"; the task and AC 3 say "RLS enabled with **no** policy granting any client-facing role read or write". What shipped is the second — `enable row level security`, `force row level security`, `revoke all from anon, authenticated`, no `create policy`. In Postgres, RLS with no policy denies all, so the clause's *purpose* is met and met more strongly than a `using (false)` policy would. **The frozen clause still names a mechanism the code does not use**; only the human may amend that text.
  2. **CSP `connect-src` is narrower than the task line**, which named the Supabase Realtime WebSocket. No project exists to name, the spec forbids a wildcard host, and this story ships no Realtime client. `tests/headers.test.ts` pins the narrow form so the widening cannot happen silently; `deferred-work.md` carries the exact hosts to add.
  3. **`DISCORD_REDIRECT_URI` is never read.** The redirect is derived from the request origin, which is correct for Supabase Auth: Discord redirects to Supabase's `/auth/v1/callback`, and Supabase then redirects to `redirectTo`. The Verification check naming it was wrong — a fixed portal URI could never match a per-PR deploy-preview origin — and is corrected below. The variable stays declared in `.env.example` because the Discord application still needs its own redirect configured; it is simply not read by app code.

- **Iteration 1 — a planning defect in this spec.** The `## Spec Change Log` section was omitted when the spec was first written and was added at review time. Nothing was lost, but the template's section was missing through steps 2 and 3.

## Design Notes

**Why the registry table and not an env allowlist.** AD-15 requires the binding to live in an application table the Commissioner alone writes. This story creates only the identity half — `discord_user_id` and `display_name`. Story 1.4 adds Team binding and the Commissioner flag to the same table or a related one; deliberately not decided here.

**Why the break-glass session is not a Supabase session.** AD-27 requires a path that survives Discord being down. Supabase Auth's other first-party paths all reintroduce an email field, which FR-4 forbids anywhere in the product. A shared secret exchanged for an app-signed cookie depends on neither vendor's identity plane. Its rationale, throttle, expiry and rotation posture are recorded here because `deferred-work.md:30` assigns that record to this story.

**The ≥30-day session is a dashboard setting, not code.** Supabase governs refresh-token lifetime and inactivity timeout in project Auth settings. Nothing in the repository can assert it, so it is a manual check below and belongs with the outstanding provisioning entry.

**Neither Supabase project exists yet.** `deferred-work.md:3` is still open, so nothing here can be exercised against a real Discord app or database. Every test therefore drives the pure resolver and the injected port; the end-to-end sign-in is a manual check once provisioning lands.

## Verification

**Commands:**
- `npm test` -- expected: all suites pass, including the new auth, recovery, surface and header files
- `npm run check` -- expected: zero errors
- `npm run build` -- expected: exit 0; both gates ahead of Vite
- `npm run build` after rewriting `@supabase/ssr` as `^0.12.4` -- expected: exit 1 naming the package; revert after
- `grep -rniE 'type="email"|name="email"|magic.?link' src/` -- expected: no matches

**Manual checks (if no CLI):**
- Supabase dev project → Auth settings: confirm refresh-token lifetime and inactivity timeout leave a session valid ≥30 days. Blocked on the provisioning entry in `deferred-work.md`.
- Discord Developer Portal: the OAuth2 application's redirect URI is the **Supabase** callback, `https://<ref>.supabase.co/auth/v1/callback`, one per project. *(Corrected at review — see the Spec Change Log. The original check asked for a match against `DISCORD_REDIRECT_URI`, which app code never reads and which a per-PR deploy-preview origin could never satisfy.)*
- Supabase dev project → Auth → URL Configuration: the app's own `/auth/callback` is on the allowed redirect list, including a wildcard for Netlify deploy-preview origins. This is what actually gates the redirect the app builds from the request origin.

## Suggested Review Order

**Identity — the one thing this story must get right**

- Reads provider-managed identities only; `user_metadata` is self-writable.
  [`auth.ts:213`](../../src/lib/server/auth.ts#L213)

- Selects by `provider`, not index `[0]`, and fails closed when two disagree.
  [`auth.ts:213`](../../src/lib/server/auth.ts#L213)

- The forged claim naming a registered Manager, proved inert.
  [`session.test.ts:78`](../../tests/session.test.ts#L78)

- The gateway seam: `hooks.server.ts` reads `$env`, so the logic moved here to be testable.
  [`session.ts:51`](../../src/lib/server/session.ts#L51)

**Refusing without enumerating the league**

- Every unregistered caller gets one frozen sentence, one status, one header set.
  [`auth.ts:400`](../../src/lib/server/auth.ts#L400)

- The partial session is destroyed even when the registry throws.
  [`auth.ts:446`](../../src/lib/server/auth.ts#L446)

- State chooses the sentence; no two states share one.
  [`auth.ts:113`](../../src/lib/server/auth.ts#L113)

- An interior CRLF survived `trim()` and reached the `location` header.
  [`auth.ts:331`](../../src/lib/server/auth.ts#L331)

**Break-glass — reachable when Discord is what failed**

- Throttle runs before the comparison, so a throttled source learns nothing.
  [`commissioner-recovery.ts:218`](../../src/lib/server/commissioner-recovery.ts#L218)

- Digests, not raw secrets — the length is not observable either.
  [`commissioner-recovery.ts:128`](../../src/lib/server/commissioner-recovery.ts#L128)

- The expiry lives inside the signature, so extending it is forgery.
  [`commissioner-recovery.ts:71`](../../src/lib/server/commissioner-recovery.ts#L71)

**The registry table**

- RLS enabled *and* forced, with no policy — in Postgres that denies all.
  [`managers.sql:49`](../../supabase/migrations/20260821000000_managers.sql#L49)

- Belt as well as braces: the grants are revoked explicitly too.
  [`managers.sql:59`](../../supabase/migrations/20260821000000_managers.sql#L59)

**Headers the live site was missing**

- One policy, every host literal, no wildcard — `connect-src` waits for a project to name.
  [`netlify.toml:105`](../../netlify.toml#L105)

**Peripherals**

- The two runtime pins join the drift gate that already fails the build.
  [`check-pins.js:27`](../../scripts/check-pins.js#L27)

- Locals declared once; 1.4 adds the Team binding and Commissioner flag.
  [`app.d.ts:1`](../../src/app.d.ts#L1)
- After deploy, `curl -I https://bbslapp.netlify.app` -- expected: every header from the `[[headers]]` block present on a real response, not only in the committed file.
