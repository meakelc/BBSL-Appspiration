# Research-Verification Review — ARCHITECTURE-SPINE.md

**Artifact:** `_bmad-output/planning-artifacts/architecture/architecture-BBSL-Appspiration-2026-08-16/ARCHITECTURE-SPINE.md`
**Lens:** Research verification — was every committed decision web-researched or reality-checked, or asserted from training data?
**Reviewed:** 2026-08-17
**Verdict:** **PASS WITH FINDINGS**

---

## Summary

The spine's Stack table carries the header **"Verified current 2026-08-16."** That is a strong claim, and it mostly holds up: fourteen specific, checkable assertions were tested against primary sources, and **nine verified exactly**, including the single most correctness-critical one (`pg_advisory_xact_lock` under Supavisor transaction-mode pooling). The version discipline around SvelteKit is genuinely good — the spine correctly identified that SvelteKit 3 entered RC four days before the architecture date and deliberately refused to bind to it. That is the behaviour of a document that was researched, not recalled.

But two bindings are **factually wrong as of today**, and both are wrong in the same direction: they reflect the state of the world some months ago rather than August 2026.

1. **Netlify's free tier no longer works the way the spine says it does.** The "125,000 function invocations/month" figure — which AD-10 uses as the load-bearing arithmetic justifying the entire off-host sweep decision — was replaced by a credit-based model on 2026-04-14. Functions are now billed by compute (GB-hours), not invocations, and the free plan is a 300-credit hard cap that **takes the whole site offline** when exhausted.
2. **Node 26 is not LTS.** It is the *Current* line. Node 24 is Active LTS. Node 26 enters LTS in October 2026 — after this auction runs.

Neither error changes the *shape* of the architecture. AD-10's conclusion (run the sweep on Supabase, not on the web host) survives and is arguably strengthened under the credit model. But a stack table that asserts its own currency and is wrong twice cannot be trusted as-is by a builder, and one of the two errors (Netlify's credit cliff) introduces an unmitigated single-point-of-failure into a hard-deadline production system.

---

## Claim-by-claim verification

| # | Claim as written in the spine | Verdict | Evidence |
|---|---|---|---|
| 1 | Supabase Cron supports sub-minute schedules (1–59 seconds) | **VERIFIED** | Supabase Cron docs confirm the pg_cron seconds syntax, "recurring jobs that run every 1–59 seconds." |
| 2 | …requiring Postgres ≥ 15.1.1.61 | **VERIFIED** | Supabase docs: seconds intervals require "Postgres version 15.1.1.61 or later." The spine correctly captured the version gate, which is an unusual detail to get right from memory. |
| 3 | Supabase Edge Functions free tier = 500,000 invocations/month | **VERIFIED** | supabase.com/pricing, Free plan: "500,000 included." |
| 4 | Netlify free tier = 125,000 function invocations/month | **STALE / NO LONGER TRUE** | See Finding 1. Netlify moved to credit-based pricing on 2026-04-14. Free = 300 credits/month, hard cap. Functions compute = 10 credits per GB-hour. Netlify's own credit-pricing docs contain no invocation-based allowance. |
| 5 | Supabase Realtime free tier = 200 concurrent connections, 2M messages/month | **VERIFIED** | supabase.com/pricing, Free plan: "200 included" peak connections, "2 Million included" messages/month. |
| 6 | Supabase free tier has NO automatic backups and NO PITR | **VERIFIED** | supabase.com/pricing — neither feature is included on Free. (Pro gets 7-day backups; PITR is a $100/mo add-on even there.) AD-15 is correctly founded. |
| 7 | Free-tier projects pause after one week of inactivity | **VERIFIED** | supabase.com/pricing: "Free projects are paused after 1 week of inactivity." |
| 8 | 2 active projects max on free tier | **VERIFIED** | supabase.com/pricing: "Limit of 2 active projects." AD-16's "there is no third environment" reasoning is sound. |
| 9 | Supabase built-in email capped at 2 emails/hour, not for production | **VERIFIED** | Supabase auth-SMTP docs: "2 messages per hour," explicitly scoped to "non-production use cases." |
| 10 | Custom SMTP defaults to a 30/hour auth email rate limit | **VERIFIED** | Same doc: after configuring custom SMTP, "a starting rate limit of 30 messages per hour is imposed." AD-14's warning about 31 simultaneous magic links is a real, correctly-identified trap. |
| 11 | SvelteKit 3 entered RC on 2026-08-13; 2.70.2 is current stable | **VERIFIED** | `npm view @sveltejs/kit dist-tags` → `latest: 2.70.2`, `next: 3.0.0-next.23`. The RC announcement post is dated 2026-08-13. |
| 12 | `@sveltejs/adapter-netlify` 6.0.4 stable; 7.0.0-next.0 is a prerelease | **VERIFIED (one detail stale)** | `npm view @sveltejs/adapter-netlify dist-tags` → `latest: 6.0.4`, `next: 7.0.0-next.8`. The stable pin is right; the prerelease it names has moved eight releases on. Cosmetic, but see Finding 5. |
| 13 | Node 26 is current LTS | **FALSE** | See Finding 2. Node 26 is Current (released 2026-05-05); Node 24 is Active LTS; Node 26 enters LTS October 2026. |
| 14 | `pg_advisory_xact_lock` is transaction-scoped and survives Supavisor transaction-mode pooling | **VERIFIED — and it is the documented correct choice** | PgBouncer explicitly recommends against session-level advisory locks under transaction pooling; transaction-level locks "are guaranteed to be released before the connection returns to the pool." AD-6 picked the right primitive for the right stated reason. This was the highest-stakes claim in the document and it is correct. |
| 15 | Resend free tier = 3,000/month with a hard 100/day cap | **VERIFIED** | Resend account quotas doc and 2026 pricing coverage: 3,000/month, 100/day. AD-14's disqualification of Resend Free is correct; Resend Pro at $20/mo is correctly priced. |
| 16 | Amazon SES ~$0.10/1000 | **PARTIALLY STALE** | See Finding 4. $0.10/1k now exists only under the à la carte model; the current Essentials plan is $0.16/1k for 0–10M. |
| 17 | SES production access request "takes ~24h" | **OPTIMISTIC / MISREAD** | See Finding 4. AWS commits to an *initial response* within 24 hours, not a grant. Public reports show multi-day and multi-week waits. |

---

## Findings

### Finding 1 — CRITICAL: Netlify's free tier was re-platformed onto credits; the spine's Netlify numbers and its risk model both predate the change

**Where:** AD-10 and its footnote; Stack table row "Netlify | Free tier; SvelteKit SSR + form actions"; Deployment diagram.

The spine writes:

> Forced by arithmetic: a 10-second sweep over three weeks is ~181,000 invocations against Netlify's **125,000/month free budget**, versus Supabase Edge's 500,000/month.

The invocation arithmetic itself is right (10s → 8,640/day → ~181,440 over 21 days), and 500,000/month for Supabase Edge is verified. But **Netlify no longer meters functions by invocation.** As of 2026-04-14 Netlify replaced per-metric allowances with a unified credit model:

- Free plan: **300 credits/month, hard cap, no auto-recharge.**
- Functions compute: **10 credits per GB-hour** (not per invocation).
- Web requests: 2 credits per 10,000. Bandwidth: 20 credits/GB. **Production deploys: 15 credits each.**

Three consequences the spine does not account for:

**(a) The stated justification for AD-10 no longer describes reality.** The conclusion is still right — probably more right, since a 10s sweep as a Netlify function would burn compute credits continuously — but the *number* a builder would check is wrong, and the first person to verify it will lose confidence in the rest of the table.

**(b) There is an undocumented single point of failure.** Netlify's own docs state that when free-plan credits are exhausted: *"all of your web projects (sites/apps) are paused and visitors to your web projects will find a `Site not available` page at each of your web project's URLs."* This is not a soft throttle. For a three-week hard-deadline auction with 31 users, an entire-site outage triggered by a billing meter is a first-order risk — and it sits in the one column of the deployment diagram the spine explicitly declared *safe*, having reasoned only about the Supabase column ("The auction's most damaging failure — a missed close — depends only on the Supabase column of this diagram"). A total web outage is not a missed close, but for a live auction it is close to equally damaging.

**(c) The deploy budget is tight enough to matter.** At 15 credits per production deploy, **300 credits is ~20 production deploys per month before anything else is counted** — and bandwidth, web requests and function compute draw from the same pool. A solo builder shipping fixes during a live three-week auction can plausibly exceed 20 production deploys in a fortnight and take the site down. Nothing in the spine flags this.

**Aggravating context:** multiple Netlify support threads dated 12–15 August 2026 report free-plan teams having production deploys paused *while credits remain available* ("29.4/30 credits remaining", "30/30 credits available"), with no staff resolution posted. Whatever the root cause, the free tier is visibly unstable in the same week this architecture was written.

**Recommended action:** Re-derive AD-10's footnote against the credit model. Add an explicit credit-budget estimate to the spine (deploys × 15 + bandwidth × 20/GB + requests × 2/10k + function GB-hours × 10) and state the headroom. Then treat **Netlify Personal ($9/month) or Pro ($20/month flat, per-seat pricing dropped 2026-04-14) as near-mandatory insurance for the auction month** — the same reasoning the spine already applies to the email vendor, where it correctly concluded that a free tier with a hard cap that drops mail is disqualifying. A free tier with a hard cap that drops *the entire site* deserves the identical treatment. Precedent exists inside the document: AD-14 disqualifies Resend Free on exactly this principle.

---

### Finding 2 — HIGH: "Node 26 LTS" is false; Node 26 is the Current line, and Netlify's functions runtime is Node 24

**Where:** Stack table, "Node | 26 LTS (Netlify functions)".

As of August 2026:

- **Node 24 is Active LTS.**
- **Node 26 is Current** (released 2026-05-05). It **enters LTS in October 2026** — after this auction's build and run window.
- Node 26 is also the last release under the old cadence; Node 27 begins the new one-major-per-year, everything-is-LTS model.

Two separate problems flow from this:

**(a) The spine binds a non-LTS runtime while explicitly refusing a non-stable framework.** The document is admirably disciplined about SvelteKit — it names the RC, dates it, and refuses it. Applying the opposite standard to Node one row later is an internal inconsistency, not just a factual slip. For a system whose stated thesis is *"rule correctness is the product"* on a hard deadline, running on Current rather than Active LTS is the wrong side of the same trade the spine already made correctly.

**(b) Node 26 may not be selectable on Netlify at all.** Netlify Functions require a Node version that is a valid AWS Lambda runtime not slated for deprecation within two months, selected via `AWS_LAMBDA_JS_RUNTIME` (e.g. `nodejs24.x`). Netlify's documented fallback default is **Node 24**. I found no evidence of a `nodejs26.x` Lambda runtime or Netlify support for it. This is not a preference question — it may simply not be available, which would surface as a deploy-time failure.

**Recommended action:** Change the Stack row to **Node 24 (Active LTS; Netlify Functions default)**, and verify the exact runtime string against Netlify's functions-configuration docs before the first deploy. If Node 26 is genuinely wanted, it should be justified as a deliberate Current-line bet, not mislabelled as LTS.

---

### Finding 3 — HIGH: The cron→sweep invocation channel is fire-and-forget, which the spine's reliability claim does not survive intact

**Where:** AD-10 ("the sweep is restart-safe by construction"), Stack table "Supabase … Cron", and the Deferred item on observability.

The spine's *sweep logic* is genuinely restart-safe — re-deriving what is overdue rather than remembering what is pending is the right design, and I want to be clear that this part is correct. But AD-10 binds NFR "timer reliability" to Supabase Cron without verifying the **delivery semantics of the invocation channel**, and those semantics are weaker than the invariant implies:

- Supabase Cron invokes Edge Functions through **`pg_net`**, which is **fire-and-forget**. The response lands in `net._http_response`; **a 5xx neither retries nor alerts.**
- `pg_cron` only fires while the database is healthy. An incident, a connection-ceiling hit, or **a paused free-tier project stops every schedule with no alert** — the run-history table simply has a gap.
- There are open Supabase discussions reporting `pg_net` failing silently, including from triggers.
- Supabase's own guidance recommends no more than 8 concurrent jobs and ≤10 minutes per job — fine at this cadence, but worth recording.

The spine partly anticipates this: the Deferred section notes *"a stalled sweep is silent by nature — auctions simply stop closing."* That instinct is right. What is missing is that the silence is not merely an *operational monitoring* gap deferred to "before the rehearsal" — it is a property of the transport that AD-10 binds. An invariant claiming to satisfy a "timer reliability" NFR should state the delivery guarantee it actually has (at-most-once, unretried, unalerted) rather than leaving a reader to infer at-least-once.

Note also that this composes badly with Finding 1: **the free-tier pause behaviours on both platforms are silent.** A paused Supabase project stops all cron with no alert; an exhausted Netlify credit balance serves `Site not available`. Neither pages anyone.

**Recommended action:** Either (i) state the transport's real guarantee in AD-10 and pair it with an **external** dead-man's-switch (a third-party cron pinging a health endpoint that asserts "no auction is overdue by more than N seconds"), or (ii) promote the observability Deferred item to an invariant, since it is what makes AD-10's SLA claim true rather than aspirational. Given SM-1 and the 60-second close SLA, an external heartbeat that does not share a failure domain with Supabase is the cheap correct answer. This is also the one place where scheduling from outside Supabase would materially help — the general guidance in this space is explicit: *"when a missed call is a real problem, schedule from outside."*

---

### Finding 4 — MEDIUM: Both Amazon SES numbers in the Deferred section are optimistic

**Where:** Deferred → "Email vendor."

> Amazon SES (~$0.30, but needs domain verification and a production-access request that takes ~24h and therefore cannot be left to setup day)

**Pricing.** SES has been restructured into Essentials / Pro / Enterprise plans plus a legacy à la carte model. The **$0.10/1,000 rate now exists only under à la carte**; the current **Essentials** plan is **$0.16 per 1,000** for 0–10M/month. At the spine's estimated 1,500–2,500 messages this moves the bill from ~$0.30 to ~$0.40 — immaterial in absolute terms, and it does not change the recommendation. It is listed only because it is another data point sourced from a pre-2026 snapshot rather than from the live pricing page.

**Production-access timing.** This one does matter for scheduling. AWS's actual wording is that *"the AWS Support team provides an initial response to your request within 24 hours"* — an initial response, not a grant. AWS adds that if further information is needed "it might take longer," and public re:Post threads document waits of **eight days and longer** with no response. The spine's instinct is right (don't leave it to setup day) but "~24h" understates the buffer needed.

**Also unstated, and load-bearing:** while in the sandbox, SES permits **a maximum of 200 messages per 24-hour period** and only to **verified** addresses. That is below AD-14's own **≥500/day** floor and would block every manager who hadn't individually verified. So production access is not an optimisation for SES — it is a **hard precondition**, and if it is not granted, SES is disqualified outright by AD-14.

**Recommended action:** Restate as "~$0.40 at Essentials rates; production access is a hard precondition (sandbox is 200/day, verified recipients only) with a 24h–multi-day approval window — submit at least two weeks before setup day, and keep Resend Pro as the fallback that requires no approval."

---

### Finding 5 — LOW: Prerelease pin has drifted, and the Postgres constraint should name the actual version

**(a) adapter-netlify.** The spine says *"**Not** 7.0.0-next.0."* The `next` tag is now **7.0.0-next.8**. The stable pin (6.0.4) is correct and the intent is clear, but naming a specific superseded prerelease dates the document. Prefer "not the 7.x `next` line."

**(b) Postgres.** The spine writes *"Supabase-managed, ≥15.1.1.61 — required for sub-minute Supabase Cron."* The requirement is real and correctly sourced. But Supabase's default moved to **Postgres 17** during 2026 (the self-hosted db image moved on 2026-06-17, and Postgres 14 support ended 2026-07-01), so any project created now already satisfies it. Two small improvements: state the version the projects will actually run (**Postgres 17.x**), and note that `15.1.1.61` is a Supabase *platform build string*, not an upstream Postgres version — a naive comparison against "17.x" reads as *lower*, which is exactly the kind of thing that gets checked wrong at 2am on setup day.

---

## Newer or better options the spine should have weighed

The spine is not obliged to adopt any of these, but a document asserting "verified current" should show it saw them.

**Supabase Queues (pgmq) — directly relevant to AD-13.** AD-13 specifies a hand-rolled transactional outbox with idempotency keys, retry and backoff. Supabase now ships **Queues**, built on the `pgmq` extension: Postgres-native, transactional with the enqueueing write, with **exactly-once delivery within a configurable visibility window**, built-in retry, and archival — i.e. precisely AD-13's requirements, as a managed primitive. It is available on the free tier. The spine's outbox is a fine design and hand-rolling it is defensible for a solo builder who wants full control of retry semantics, but *not mentioning that the platform ships the pattern* reads as an unexamined default. Worth one line either adopting it or recording why not (most likely: the visibility-window semantics and the desire to keep the idempotency key derived from event identity under AD-13's own control).

**Cloudflare Workers — relevant to Finding 1.** Given that Netlify's free tier now carries a site-offline credit cliff, the obvious alternative deserves a mention: Cloudflare Workers free is **100,000 requests/day** with no equivalent whole-site kill switch, and `@sveltejs/adapter-cloudflare` is a first-party SvelteKit adapter. The caveat is real and would probably decide against it — the free tier limits **CPU time to 10ms per request**, which an SSR route doing event-log reads plus a projection fold may well exceed. But that is a *reason*, and the spine should be able to give it rather than being silent.

**Netlify Personal ($9/mo).** Introduced with the credit repricing; sits between Free and Pro and includes auto-recharge, which removes the hard-cap outage mode. For a one-month auction this is the cheapest available fix for Finding 1 and belongs in the same Deferred paragraph that already accepts ~$20 for Resend Pro.

**Supabase Branching — correctly unavailable.** Worth recording that this was checked: branching is **paid-plans-only**, so AD-16's two-free-projects arrangement really is the only free option, and the spine's "there is no third environment to fall back on" is accurate rather than merely assumed.

---

## Anything bound that is too new or unstable for a hard deadline?

**No — with one exception, and one caveat.**

The spine's version discipline is the strongest thing in this review. It correctly refuses SvelteKit 3 (RC as of 2026-08-13, breaking changes, stable date unannounced) and correctly refuses `adapter-netlify` 7.x prereleases, pinning both to the stable line. For a solo builder against a hard offseason deadline this is exactly right, and the reasoning is stated rather than assumed.

**The exception is Node 26** (Finding 2) — a Current-line runtime mislabelled as LTS, applying the opposite standard to the one the spine applies to SvelteKit one row above, and possibly not even offered by the chosen host.

**The caveat is the Netlify free tier itself** (Finding 1) — not "too new" as a technology, but a **billing platform that changed four months ago and is visibly misbehaving this week**, carrying an undisclosed whole-site-outage failure mode. For a three-week hard-deadline auction, that is the single largest unexamined risk in the Stack table.

Everything else — Supabase Cron sub-minute, Edge Functions, Realtime, `pg_advisory_xact_lock`, Deno on Supabase Edge Runtime, Postgres 17 — is mature, generally available, and verified to do what the spine claims.

---

## What was right, and worth preserving

Stated plainly, because a review that only lists defects misrepresents this document:

- **AD-6's lock primitive is correct**, for the correct stated reason, and it was the highest-consequence claim in the spine. `pg_advisory_xact_lock` under Supavisor transaction-mode pooling is precisely what PgBouncer's own documentation prescribes; a session-scoped lock here would have leaked across pooled connections and produced exactly the ghost-serialization class the spine set out to eliminate. The reasoning in the AD-6 note — that the *team* is raced, not the auction — is independent of any external source and is the sharpest observation in the document.
- **The sub-minute-cron Postgres version gate (15.1.1.61)** is an obscure, easily-missed detail that is correctly stated. That is a research fingerprint, not a recall fingerprint.
- **The Supabase email trap (2/hour built-in, 30/hour post-SMTP default) is correctly identified**, including the specific failure mode of 31 simultaneous magic links on setup day. This is the kind of thing that is only ever found by reading the docs.
- **The free-tier durability position (AD-15)** is correctly founded: no backups, no PITR, no SLA are all confirmed. Treating the Discord channel as load-bearing durability rather than convenience is a sound response to a verified constraint.
- **Resend's 100/day cap is correctly identified as disqualifying**, and the principle behind AD-14 — "any hard cap that drops mail is disqualified" — is the right one. Finding 1 essentially asks the spine to apply its own AD-14 principle to its web host.

---

## Recommended edits, in priority order

1. **Rewrite AD-10's footnote** against Netlify's credit model; add a credit budget with stated headroom; add the site-pause failure mode to the deployment narrative. *(Finding 1)*
2. **Change the Stack row to Node 24 (Active LTS)** and verify the Netlify Lambda runtime string before first deploy. *(Finding 2)*
3. **State AD-10's real delivery guarantee** (`pg_net` is fire-and-forget, unretried, unalerted) and promote an **external, different-failure-domain heartbeat** from Deferred into the spine. *(Finding 3)*
4. **Budget for a paid month on Netlify** (Personal $9 or Pro $20) alongside the already-accepted Resend Pro $20 — or record explicitly why the free-tier outage risk is accepted. *(Finding 1)*
5. **Correct the SES figures** to ~$0.16/1,000 (Essentials), reframe production access as a hard precondition with a 24h-to-multi-day window, and note the 200/day verified-recipients-only sandbox ceiling. *(Finding 4)*
6. **De-drift the prerelease reference** ("not the 7.x `next` line") and **name Postgres 17.x** while keeping the 15.1.1.61 gate as the sourced requirement. *(Finding 5)*
7. **Add one line each** on Supabase Queues (vs the hand-rolled AD-13 outbox) and Cloudflare Workers (vs Netlify), adopting or rejecting with a reason.
8. **Re-date the Stack header** once the above land — and consider narrowing "Verified current" to the rows that were actually verified against a primary source, so the claim stays honest as the document ages.

---

## Sources

- [Supabase pricing](https://supabase.com/pricing)
- [Supabase Cron docs](https://supabase.com/docs/guides/cron) · [Cron quickstart](https://supabase.com/docs/guides/cron/quickstart) · [Scheduling Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions)
- [Supabase custom SMTP / auth email rate limits](https://supabase.com/docs/guides/auth/auth-smtp)
- [Supabase Queues docs](https://supabase.com/docs/guides/queues) · [pgmq extension](https://supabase.com/docs/guides/queues/pgmq)
- [Supabase changelog](https://supabase.com/changelog) · [Postgres 14 deprecation notice](https://supabase.com/changelog/45827-deprecation-notice-support-for-postgres-14-ending-on-1st-july-2026)
- [Supabase discussion: pg_net failing silently from a database trigger](https://github.com/orgs/supabase/discussions/37591) · [pg_cron/pg_net error handling](https://github.com/orgs/supabase/discussions/27488) · [Supabase cron jobs guide, 2026](https://crontap.com/guides/supabase-cron-jobs)
- [Netlify credit-based pricing plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/) · [How credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/) · [Netlify pricing](https://www.netlify.com/pricing/) · [Introducing Netlify's Free plan](https://www.netlify.com/blog/introducing-netlify-free-plan/)
- [Netlify support: free plan production deploys paused despite credits remaining (Aug 2026)](https://answers.netlify.com/t/free-plan-production-deploys-paused-despite-29-4-30-credits-remaining/166927)
- [Netlify functions configuration](https://docs.netlify.com/build/functions/configuration/)
- [SvelteKit 3 Release Candidate announcement](https://svelte.dev/blog/sveltekit-3-release-candidate) · [What's new in Svelte, August 2026](https://svelte.dev/blog/whats-new-in-svelte-august-2026) · npm dist-tags for `@sveltejs/kit` and `@sveltejs/adapter-netlify`
- [Node.js releases](https://nodejs.org/en/about/previous-releases) · [Node.js 26.0.0 (Current)](https://nodejs.org/en/blog/release/v26.0.0) · [Evolving the Node.js release schedule](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule) · [endoflife.date/nodejs](https://endoflife.date/nodejs)
- [PgBouncer / advisory locks under transaction pooling](https://jpcamara.com/2023/04/12/pgbouncer-is-useful.html) · [Postgres advisory locks and connection pooling](https://www.snowinch.com/en/blog/postgres-advisory-lock-connection-pool-leak) · [with_advisory_lock issue #43](https://github.com/ClosureTree/with_advisory_lock/issues/43)
- [Resend account quotas and limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits) · [Resend new free tier](https://resend.com/blog/new-free-tier)
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) · [Request production access (SES sandbox)](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) · [AWS re:Post: SES production access pending 8+ days](https://repost.aws/questions/QUyyYVwcDSSwC8zcmBWjlGHg/ses-production-access-pending-for-over-8-days-no-response-from-trust-safety)
- [SvelteKit Cloudflare adapter](https://svelte.dev/docs/kit/adapter-cloudflare) · [Cloudflare Workers free tier limits 2026](https://agentdeals.dev/vendor/cloudflare-workers)
