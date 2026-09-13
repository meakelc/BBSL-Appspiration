# Appspiration — setup runbook

The BBSL offseason free agent auction. This file is how you stand it up.

It is written from an actual provisioning run (Story 9.1–9.4, 2026-09-05), not
from memory, and every command in it has been executed against a real project.

**What this is not:** the outage recovery procedure. That is a different
document for a different moment — what to do at 3am with the site down and
clocks running — and it is owed by Story 8.4. This file gets you from an empty
account to a running league; that one gets you out of trouble afterwards.

Orientation for working *on* the code is `hermes.md`; the rules are the 30 ADs
in `ARCHITECTURE-SPINE.md`, and `AGENTS.md` is the short block agents load.

---

## The one rule that is not recoverable

> **No secret may take a `PUBLIC_` prefix.**

SvelteKit inlines every `PUBLIC_`-prefixed variable into the client bundle at
build time. Anything behind that prefix is published to every browser that ever
loads the app, permanently, and **cannot be un-published by rotating the
deployment**. A secret that appears with that prefix is a breach, not a typo.

Exactly two variables are meant to be world-readable: `PUBLIC_SUPABASE_URL` and
`PUBLIC_SUPABASE_ANON_KEY`. Nothing else.

---

## Prerequisites

- Node 24 (`.nvmrc`), npm
- A Supabase account, a Netlify account, a Discord account
- `npm ci` — never `npm install`; the pin contract holds below the top level
  only if you install from the lockfile

---

## The environment contract

**Three different places consume these, and putting a variable in the wrong one
fails silently.** This table is the authority; `.env.example` lists names only.

| Variable | Consumed by | Where it goes |
| --- | --- | --- |
| `SUPABASE_URL` | SvelteKit app | Netlify |
| `SUPABASE_SERVICE_ROLE_KEY` | SvelteKit app | Netlify (**never** `PUBLIC_`) |
| `SUPABASE_DB_URL` | app **and** Edge Function | Netlify **and** Supabase secrets |
| `COMMISSIONER_RECOVERY_SECRET` | SvelteKit app | Netlify |
| `PUBLIC_SUPABASE_URL` | browser | Netlify |
| `PUBLIC_SUPABASE_ANON_KEY` | browser | Netlify |
| `APP_ORIGIN` | Edge Function only | Supabase function secrets |
| `TICK_INVOCATION_SECRET` | Edge Function only | Supabase function secrets + Vault |
| `DISCORD_WEBHOOK_URL` | Edge Function only | Supabase function secrets |
| `DISCORD_CLIENT_ID` | `supabase config push` | local `.env` only |
| `DISCORD_CLIENT_SECRET` | `supabase config push` | local `.env` only |

**Read by nothing at all:** `SUPABASE_JWT_SECRET`, `DISCORD_REDIRECT_URI`,
`DISCORD_GUILD_ID`. They were removed from `.env.example` in Story 9.6. The app
never verifies a JWT itself — Supabase does — and Discord's redirect URI is
configured in Supabase, not here.

> **Known drift:** Story 9.1 set `APP_ORIGIN` and `TICK_INVOCATION_SECRET` as
> Netlify variables. Only the Edge Function reads them, so they do nothing
> there. Harmless, but they must also be set as Supabase function secrets before
> the tick can run — see *The tick* below.

---

## 1. Supabase

Two projects, always: a **wipeable dev** and a **never-hand-touched prod**
(AD-26). Dev first, every time — the order is the rule, not a convenience.

### Create the project

Dashboard → New project. Name it unmistakably (`bbsl-dev`). **Save the database
password immediately** — it is shown once and becomes part of `SUPABASE_DB_URL`.

Region is **not changeable afterwards**. Pick one near Netlify's functions;
prod must use the **same region as dev** so the pilot predicts the real thing.

Note the Postgres version and reconcile `supabase/config.toml`'s
`major_version` against it. Local must track hosted, not the pinned floor —
otherwise the integration tests prove things about a version nothing deploys on.

> Free-tier Edge invocations (500K/month) are shared **org-wide** (AD-19). Dev
> and prod in one organisation spend one allowance, and exhaustion stops the
> tick.

### The connection string

Dashboard → **Connect** (top bar, not Settings). Take a **pooler** URI:

- The direct connection is IPv6-only; Netlify Functions are IPv4. It will not
  connect from a deploy.
- Transaction mode is safe here because `write.ts` uses `pg_advisory_xact_lock`,
  which is transaction-scoped. Session-scoped `pg_advisory_lock` would not be.
- Percent-encode the password if it contains `@ : / ? # [ ] & = +` or a space.
  An unencoded `@` splits the host and fails in a way that looks nothing like
  its cause.

### Apply the schema

```bash
npx supabase db push --db-url "$SUPABASE_DB_URL" --dry-run   # look first
npx supabase db push --db-url "$SUPABASE_DB_URL"
```

`--db-url` talks straight to Postgres and needs no `supabase login`.

**Never type schema into the dashboard** (`AGENTS.md`). Anything typed there is
invisible to the next `db push`, so dev and prod diverge and no file in the
repository describes reality. If a migration fails, bring the error — do not
reach for the SQL editor.

### Verify it, do not assume it

```bash
npm run verify:supabase        # needs SUPABASE_DB_URL in the environment
```

`db push` exiting 0 proves the CLI issued statements. This proves the schema
matches the repository: all 13 migrations, all 15 tables with RLS enabled and
forced, exactly one policy, `anon` holding nothing anywhere, the exact grant set
per table, both extensions, and `bbsl-tick` present and **inactive**.

It is read-only by construction and safe to run against prod.

---

## 2. Discord

**The app does not hand-roll OAuth.** Supabase owns the handshake, so the hops
are:

```
app /signin → <project>.supabase.co/auth/v1/authorize
            → discord.com/oauth2/authorize        ← the user consents
            → <project>.supabase.co/auth/v1/callback   ← Discord's redirect URI
            → app /auth/callback                  ← Supabase's allow-list
```

Two allow-lists, in two places, and **Discord's points at Supabase — never at
this app.** Getting that backwards is the usual way this fails.

1. **discord.com/developers** → New Application. Under OAuth2 → Redirects, add
   exactly `https://<project-ref>.supabase.co/auth/v1/callback`.
2. Copy the Client ID and Secret into your local `.env`.
3. Create the league channel and an **incoming webhook** on it. Use a channel
   **separate from the real auction's** for any pilot — the real channel is a
   corroborating record Story 8.3 reconciles against, and pilot noise
   contaminates it.

Then push the provider configuration, which lives in `supabase/config.toml` so
it is reviewable and reproducible rather than clicked:

```bash
npx supabase login
npx supabase link --project-ref <ref> -p "$DB_PASSWORD"
npx supabase config push          # env() reads DISCORD_* from .env
```

`additional_redirect_urls` must name every origin a Manager may sign in from.
Deploy previews are deliberately absent: admitting `deploy-preview-*` makes
every pull request a valid destination for a real OAuth code.

> Supabase's Discord provider requests the `email` scope and offers no way to
> drop it, so Managers see Discord ask for their address. Nothing reads it —
> `discordIdentityOf` takes only `identities[].id`. "No email field exists
> anywhere" still holds, but expect the question.

---

## 3. Netlify

The branch-to-environment mapping is committed in `netlify.toml`:

| Context | Supabase project |
| --- | --- |
| `production` | prod |
| `deploy-preview` | dev |
| `branch-deploy` | dev |

**Set the app's variables in the dev contexts only — never in `production`**
until prod exists. Do **not** set `SUPABASE_ENVIRONMENT` or `APP_ENV`;
`netlify.toml` sets both per context, and duplicating them in the UI is how the
committed mapping quietly stops being the truth.

⚠️ **Branch deploys are off by default.** `build_settings.allowed_branches` ships
as `["main"]`, so the committed `branch-deploy → dev` mapping cannot be
exercised at all until the branch is allow-listed. Allow-list specific branches
rather than all of them: Netlify credits are 300/month and exhaustion **pauses
the site** (AD-19).

⚠️ **`PUBLIC_`-prefixed values are inlined at build time.** Setting one does not
change an existing deploy — you need a fresh *build*, not a redeploy.

For a stable URL people can be sent to, use a long-lived branch (`pilot`) rather
than a deploy preview, which dies with its pull request.

---

## 4. Seed the league

**There is no admin UI for this, by design** — `teams.sql` states it: "the
Commissioner writes them directly."

```bash
npm run seed:league            # thirty Teams and their Managers
npm run seed:league -- --wipe  # clear both first
```

The table in `scripts/seed-league.js` names a Manager for **all thirty** Teams.
It refuses to seed while any row is missing a display name, and it refuses two
rows sharing one snowflake — a duplicate would not fail the upsert, it would
silently re-bind the first Manager to the second's Team and leave one Team
unbound.

Idempotent: Teams insert on-conflict-do-nothing, Managers upsert on their
Discord id, so correcting a Team binding or a Commissioner flag is an edit to
the table in `scripts/seed-league.js` plus a re-run.

Team names are the NBA franchises **spelled out**. A three-letter capitalised
abbreviation always and only means a player's real-life NBA team, so a fantasy
Team is never abbreviated.

You need each Manager's Discord **snowflake**: Discord → Settings → Advanced →
Developer Mode, then right-click their name → Copy User ID. An account absent
from `managers` is refused at sign-in without the refusal revealing whether it,
or any Team, exists.

`--wipe` deliberately does not delete `auction_events`. If it fails on that
foreign key, the auction has real history and the script will not destroy it
quietly.

### Ending a pilot

`seed:league --wipe` is the wrong tool for that — it leaves the history, the
staged imports, the promoted rosters and the heartbeats exactly where they were.
Use the loud version, which archives every table to JSON before deleting
anything:

```bash
npm run reset:pilot -- --archive-to=_bmad-output/pilot-2-archive
npm run reset:pilot -- --archive-to=_bmad-output/pilot-2-archive --confirm-wipe
```

The first run is a **dry run**: it prints the row count per table and writes
nothing, locally or in the database. Read those counts before adding
`--confirm-wipe`, which is the run that writes the archive and then deletes.

`_bmad-output/pilot-*-archive/` is git-ignored, so the archive is local — a
pilot's dump is the only surviving evidence of how that iteration behaved, and
the script refuses to write into a directory that already holds one.

It refuses to run when `SUPABASE_ENVIRONMENT` is `prod`, checked before it
connects. `auction_watermark` is reset to 0 rather than deleted (its row is a
schema-enforced singleton no INSERT re-creates), and `auction_events.seq`
restarts at 1 so the new pilot's log reads against the old one's.

**Disable the tick schedule first.** A sweep landing mid-wipe writes events
against Teams the transaction is deleting.

---

## 5. Import the Fantrax exports

Thirty-one files: one Free Agent pool export plus one roster export per Team.

**Fantrax names every export after the LEAGUE, not the team**, so all thirty
rosters arrive identically named with a `(n)` suffix, and the roster CSV carries
no team column. **The only thing identifying a roster is the order you
downloaded them in.**

```bash
npm run name:rosters           # team_rosters/ -> team_rosters/by-team/
```

The ordering is declared in `scripts/name-roster-exports.js`: the unsuffixed
export is the Commissioner's own Team, and `(1)`–`(29)` are the rest
alphabetically **by full city name** — not by abbreviation, which orders BKN
before BOS where the city order is Boston before Brooklyn.

> ### Required gate — do not skip
>
> The script prints each Team's highest-paid player. **Check several against
> the league before importing.** This is the only thing that can catch a wrong
> ordering while it is still cheap. Two rosters swapped produce two Teams whose
> Cap Space, Roster Count and every bid gate are computed against the wrong
> players — and **every screen will look entirely normal.**
>
> During a pilot, have each Manager confirm their own roster before promotion.

Then upload `team_rosters/by-team/` through `/import`, read the per-Team preview,
and promote.

---

## 6. The tick

One cron schedule, one Edge Function, sweep then drain (AD-10).

**The schedule ships inactive.** `20260831000000_tick.sql` creates `bbsl-tick`
with `active = false` so that applying migrations to a fresh database does not
start closing Auctions before anybody has said so.

Before it can run, the Edge Function needs its own secrets — these are **not**
Netlify variables:

```bash
npx supabase secrets set SUPABASE_DB_URL='...' TICK_INVOCATION_SECRET='...' \
                         DISCORD_WEBHOOK_URL='...' APP_ORIGIN='https://...'
npx supabase functions deploy tick
```

and two Vault secrets, created per project (the migration reads them by name so
that no secret is ever a literal in git):

```sql
select vault.create_secret('<value>', 'tick_invocation_secret');
select vault.create_secret('<url>',   'tick_function_url');
```

Enable and disable it explicitly:

```sql
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'bbsl-tick'),
  active := true      -- false again afterwards
);
```

> **Enable it only for as long as you need it.** At a 10-second interval a
> continuously-running tick is roughly 260K invocations a month against a 500K
> org-wide ceiling shared with production. A dev schedule left on spends the
> real auction's budget.

---

## 7. Running the tests

```bash
set -a; . ./.env; set +a      # REQUIRED — see below
npx vitest run
npm run check
```

⚠️ **Export `.env` first.** `tests/integration/auction-events.test.ts` resolves
its database from raw `process.env`, which Vitest does not populate from
`.env`, while the code under test reads it through `$env/dynamic/private`,
which SvelteKit *does* back with `.env`. Run the suite without exporting, with
a local stack up and `.env` naming a hosted project, and the fixtures seed one
database while the write path targets another — producing a foreign-key
violation that reads exactly like a bug in `write.ts` and is not one.

⚠️ **CI runs no Postgres**, so every integration test silently self-skips there.
A green CI run is not evidence that any integration assertion executed.

---

## Order of operations

1. Create the Supabase dev project; save the password
2. Reconcile `config.toml`'s `major_version`
3. `db push`, then `npm run verify:supabase`
4. Create the Discord app, channel and webhook; `supabase config push`
5. Set Netlify variables in the dev contexts; allow-list the branch; build
6. `curl -I` the deploy and confirm the security headers are served
7. `npm run seed:league`
8. `npm run name:rosters` — **and check the ordering table**
9. Import, preview per Team, promote
10. Set eligibility by hand
11. Function secrets, Vault secrets, deploy the tick, enable the schedule
12. Open the auction

Steps 1–6 are Story 9.1–9.3; 7–10 are setup day; 11–12 need Story 8.4's go-live
gate first.
