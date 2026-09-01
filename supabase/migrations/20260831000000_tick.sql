-- The tick: ONE cron schedule, ONE Edge Function, sweep then drain. Story 3.5.
--
-- Nothing was scheduled anywhere in this repository before this file. An
-- expired Auction stayed expired-but-unrecorded forever -- AD-12 kept it
-- CORRECT, because the expiry gate refuses Bids on it, but nobody was ever
-- awarded the Player. This migration is the mechanism AD-10, AD-11, AD-19 and
-- AD-20 all assume exists.
--
-- Three things land here and nothing else:
--
--   1. pg_cron and pg_net, the two extensions a database-side schedule needs.
--   2. tick_heartbeats, the append-only record of every pass (AD-19).
--   3. exactly ONE cron.schedule, at a 10-second interval, created INACTIVE.
--
-- **One schedule, one function.** AD-10 fixes the interval at 10 seconds and
-- does the arithmetic out loud: ~259,200 invocations a month, which is inside
-- the platform's free allowance. A second schedule, or a second function,
-- would mean two things could close the same Auction and would put the whole
-- of AD-6's single-writer property in the hands of the advisory lock alone.
-- There is no Netlify scheduled function and no in-memory timer anywhere;
-- netlify.toml names no schedule at all.
--
-- **Created INACTIVE, deliberately.** `active = false` is the AC's "dev's
-- schedule is disabled by default": applying this migration to a fresh
-- database must not start closing Auctions before anybody has said so.
-- Enabling it is an explicit act against a specific project --
--
--     select cron.alter_job(
--       job_id := (select jobid from cron.job where jobname = 'bbsl-tick'),
--       active := true
--     );
--
-- -- and is not this migration's to perform.
--
-- **No secret is written here.** The invocation secret and the function URL
-- are read from Vault BY NAME at invocation time. A literal in a migration is
-- a literal in git, permanently, and cannot be un-published by rotating it.
-- The two Vault secrets are created out of band, per project:
--
--     select vault.create_secret('<value>', 'tick_invocation_secret');
--     select vault.create_secret('<url>',   'tick_function_url');
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

-- --------------------------------------------------------------------------
-- 1. The extensions.
-- --------------------------------------------------------------------------

-- pg_cron creates and owns the `cron` schema itself, so it takes no
-- `with schema` clause. It is installed into the database named by
-- cron.database_name (`postgres` on Supabase and on the local CLI stack).
create extension if not exists pg_cron;

-- pg_net is what lets a cron job make the HTTP call. `with schema extensions`
-- is Supabase's convention for where the EXTENSION is recorded; pg_net's own
-- control file relocates its functions to the `net` schema regardless, which
-- is why the job below calls `net.http_post` and not `extensions.http_post`.
-- Verified against the local Supabase stack (pg_net 0.14.0).
create extension if not exists pg_net with schema extensions;

-- --------------------------------------------------------------------------
-- 2. tick_heartbeats -- AD-19.
-- --------------------------------------------------------------------------
--
-- **Every pass writes one row, including a refused or a failed pass.** That is
-- the entire point: a pass that recorded nothing is indistinguishable from a
-- tick that is not running at all, and "the auction quietly stopped closing"
-- is the failure mode this table exists to make visible.
--
-- This is NOT an event-sourced projection and is not part of auction_events.
-- It records that the machinery ran, not what the auction decided -- AD-4 puts
-- the auction's own output in the log, and a heartbeat is neither an input to
-- nor an output of any rule. Nothing folds it and nothing replays it.

create table if not exists public.tick_heartbeats (
  id bigint generated always as identity primary key,

  -- The database clock the pass derived its overdue set against, defaulted in
  -- SQL rather than supplied by the caller for the one case that cannot
  -- supply it: the pass whose clock read is what failed. Never a clock read in
  -- application code (AD-3).
  ran_at timestamptz not null default now(),

  -- One word for the pass: 'ok', 'completed_with_failures',
  -- 'refused_version_mismatch', 'failed'. Deliberately text with no check
  -- constraint -- a later story adding an outcome must not need a migration to
  -- record one, and an unrecognised outcome recorded honestly beats a pass
  -- that could not write its row at all.
  outcome text not null,

  -- The three counts the AC requires the row to state.
  closed integer not null default 0,
  skipped integer not null default 0,
  failed integer not null default 0,

  -- AD-20's fail-stop, with BOTH numbers on the row: the version this tick
  -- carries and the newest core_version in auction_events. A refusal that
  -- named only one of them would not say which side moved.
  tick_core_version integer,
  log_core_version integer,

  -- One human sentence: which Players closed, which were skipped and why,
  -- which failed and with what, and whether the drain threw afterwards.
  detail text
);

comment on table public.tick_heartbeats is
  'One row per tick pass (Story 3.5, AD-19). Append-only. Written by the Edge Function through the direct SUPABASE_DB_URL connection. Not an event-sourced projection: it records that the sweep ran, never what the auction decided.';

comment on column public.tick_heartbeats.log_core_version is
  'The newest auction_events.core_version at this pass, or null for an empty log. Compared against tick_core_version; a difference refuses the pass and closes nothing (AD-20). Also null when the newest row carries a core_version that will not read as an integer -- that refuses the pass too, and detail names the unreadable value verbatim, because binding it here would fail the INSERT and leave the refusal with no row at all.';

-- Newest first, which is the only question anybody asks of this table: "did
-- the tick run, and what did the last few passes say".
create index if not exists tick_heartbeats_ran_at_idx
  on public.tick_heartbeats (ran_at desc);

-- RLS on, and forced, so the table owner is not silently exempt either --
-- every table in this schema does the same.
alter table public.tick_heartbeats enable row level security;
alter table public.tick_heartbeats force row level security;

-- No `create policy` follows, and that is the design: RLS enabled with no
-- policy makes every row invisible and unwritable to every role RLS applies
-- to. The writer is the direct Postgres connection the Edge Function opens
-- from SUPABASE_DB_URL, which is the one path a browser can never travel.

-- Belt as well as braces, as every table before this one establishes.
revoke all on table public.tick_heartbeats from anon;
revoke all on table public.tick_heartbeats from authenticated;

-- Supabase's default privileges grant service_role ALL on a newly created
-- table. An append-only operational record needs that narrowed, exactly as
-- auction_events narrows it: revoke everything, then grant back SELECT and
-- INSERT only. UPDATE and DELETE are deliberately absent -- a heartbeat that
-- can be edited after the fact is not evidence of anything.
revoke all on table public.tick_heartbeats from service_role;
grant select, insert on table public.tick_heartbeats to service_role;

-- No sequence grant follows, and that is checked rather than assumed:
-- `generated always as identity` does not consult the sequence's own
-- privileges the way `serial` does, so an INSERT by service_role succeeds on
-- the table grant alone. Verified against the local Supabase stack. A blanket
-- `grant usage on all sequences in schema public` would have widened
-- service_role's reach across every other table for no reason.

-- --------------------------------------------------------------------------
-- 3. The one schedule -- AD-10.
-- --------------------------------------------------------------------------
--
-- 10 seconds, which pg_cron 1.5+ accepts as an interval string rather than a
-- five-field cron expression. ARCHITECTURE-SPINE.md pins Postgres at
-- >= 15.1.1.61 for exactly this reason: a one-MINUTE floor would leave an
-- Auction open for up to a minute past its own expiry, which AD-12 tolerates
-- (bids are already refused in that gap) but which every Manager watching the
-- clock would read as the app being broken.
--
-- Guarded on the job not already existing, so re-applying this file to a
-- database whose schedule an operator has since ENABLED does not silently
-- switch it back off. `cron.schedule` upserts by jobname and sets active =
-- true on the way through, which is precisely the surprise the guard avoids.
--
-- **`cron.alter_job`, never `update cron.job`.** cron.job is owned by
-- supabase_admin and `postgres` holds SELECT on it and nothing else -- a
-- direct UPDATE fails with "permission denied for table job", and
-- `grant all privileges on all tables in schema cron` does NOT fix that,
-- because a non-owner granting privileges it does not hold with grant option
-- silently grants nothing. `cron.alter_job` is pg_cron's own SECURITY DEFINER
-- entry point and is the supported way to deactivate a job. Verified against
-- the local Supabase stack (Postgres 15.8, pg_cron 1.6).
--
-- The SELECT in the guard is RLS-filtered to this role's own jobs, which is
-- the same scope `cron.schedule` and the jobname_username_uniq index use.

do $migration$
declare
  tick_job_id bigint;
begin
  if not exists (select 1 from cron.job where jobname = 'bbsl-tick') then
    tick_job_id := cron.schedule(
      'bbsl-tick',
      '10 seconds',
      $job$
        select net.http_post(
          -- Both values are read from Vault BY NAME, at invocation time. No
          -- secret and no project-specific URL is committed anywhere in this
          -- repository; a project whose secrets are absent gets a null url,
          -- which pg_net rejects outright and pg_cron records as a failed run
          -- in cron.job_run_details. That is the correct, visible outcome for
          -- a project nobody configured to tick -- and it cannot happen by
          -- accident, because the schedule ships inactive.
          url := (
            select decrypted_secret from vault.decrypted_secrets
            where name = 'tick_function_url'
          ),
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            -- The shared secret .env.example has named as
            -- TICK_INVOCATION_SECRET since Story 1.1. The function refuses
            -- with 401 before it opens a connection when this does not match.
            'x-tick-invocation-secret', (
              select decrypted_secret from vault.decrypted_secrets
              where name = 'tick_invocation_secret'
            )
          ),
          body := '{}'::jsonb,
          -- **This bounds the RESPONSE wait, not the function.** pg_net is
          -- asynchronous: this job queues the request and returns immediately,
          -- so the timeout only decides how long pg_net's background worker
          -- waits for a reply before abandoning it and recording a failed
          -- response. It does NOT cancel an Edge Function that is still
          -- sweeping, and it does not stop the next 10-second tick from POSTing
          -- while a slow pass is in flight. Two overlapping passes are SAFE:
          -- every close takes GLOBAL_WRITE_LOCK_KEY in its own transaction
          -- (AD-6), so nothing is ever closed twice, and a second pass that
          -- reads the log after the first committed simply does not see the
          -- Auction at all.
          --
          -- They are safe, not silent. A second pass that read the log BEFORE
          -- the first committed still offers that Auction to closeAuction,
          -- loses the race for the lock, and finds the Auction gone by the time
          -- it holds it — which throws and is recorded as a close failure. The
          -- outcome is right and the heartbeat reads worse than the truth;
          -- deferred-work.md carries it against the story that first reads this
          -- table for alerting.
          --
          -- 8 seconds is chosen to sit inside the interval so a stalled reply is
          -- abandoned before the next tick rather than accumulating queued
          -- responses in pg_net's own tables.
          timeout_milliseconds := 8000
        );
      $job$
    );

    -- INACTIVE. Enabling it is a deliberate act against a specific project,
    -- not something applying a migration does on anybody's behalf.
    perform cron.alter_job(job_id := tick_job_id, active := false);
  end if;
end
$migration$;
