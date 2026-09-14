-- Detecting a roster divergence from Fantrax. Story 7.9, FR-42.
--
-- A trade executed in Fantrax and never reported to the Commissioner leaves
-- the app charging the wrong Team for a Contract, and because every Cap Space,
-- Maximum Bid and Roster Count is a function of the rosters at that instant,
-- the arithmetic stays wrong for the rest of the auction with nothing on any
-- screen saying so. Stories 7.7 and 7.8 gave the Commissioner the acts; this
-- is the schema behind the thing that tells him an act is needed.
--
-- THREE PIECES, and each one exists for a stated reason:
--
--   1. `teams.fantrax_team_id` -- the EXPLICIT Team map (AD-24). Fantrax's
--      `getTeamRosters` keys its rosters by a Fantrax team id, and the only
--      honest way to know which of our Teams that is, is to have been told.
--      Matching on `teamName` is forbidden: `server/team-registry.ts`'s
--      `resolveTeamByFileName` is the import path's one name-based match and
--      it must not be reused here, because a Team renamed in Fantrax would
--      silently read as thirty departures and thirty unknown arrivals at once.
--      A Team with no id is NOT CONFIGURED, which renders like *stopped* and
--      never like *no divergences*.
--
--   2. `fantrax_reads` -- one row per attempt, WHATEVER the outcome. This is
--      `tick_heartbeats` copied deliberately, and AD-19's reasoning is the
--      same one: the dangerous state is the outage that looks like health. A
--      reader that has stopped answering must render as **stopped**, and it
--      can only do that if a failed read left a record of itself. The row also
--      carries the normalised membership the comparison runs against, so the
--      hourly job stores exactly what Fantrax said and derives nothing -- see
--      the column comment.
--
--   3. `fantrax_divergence_dismissals` -- "not now" about an unconfirmed
--      reading of a third-party system, keyed on a CONTENT fingerprint so that
--      a changed divergence is a different row and raises again by itself.
--      Deliberately NOT an event: every Epic 7 override appends one because it
--      changes what the arithmetic computes, and a dismissal changes nothing
--      the app computes. Giving it an event and a reason sheet would put
--      auction-grade ceremony on a "seen it" click, and a third party's noise
--      in the league-visible log.
--
-- Plus the hourly `pg_cron` job, INACTIVE, with the URL and the secret read
-- from Vault by name exactly as `20260831000000_tick.sql` reads them. Nothing
-- here writes an event, a `team_rosters` row or a projection, and nothing here
-- rides the 10-second tick: the read is a rate-limit courtesy to an
-- undocumented third party, at most once an hour, in the shell, outside the
-- write lock.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

-- --------------------------------------------------------------------------
-- 1. teams.fantrax_team_id -- the explicit Team map (AD-24).
-- --------------------------------------------------------------------------

alter table public.teams
  add column if not exists fantrax_team_id text;

-- Unique, because two Teams claiming one Fantrax roster would make every
-- membership answer ambiguous and the comparison would have no correct
-- output to produce. Created as a named index rather than inline in the
-- `add column` so that re-applying this file is a no-op instead of an error.
create unique index if not exists teams_fantrax_team_id_key
  on public.teams (fantrax_team_id);

-- A whitespace-only value would pass the unique index above (it is a distinct
-- string) and then read as UNMAPPED to `loadTeams`, which treats a blank as the
-- same absence as a NULL. That is the worst of both: the column looks populated
-- to anyone reading the table and the detector says *not configured* anyway.
-- NULL is the supported way to say "not mapped yet"; blank is not a second one.
-- `fantrax_divergence_dismissals.fingerprint` carries the identical constraint
-- for the identical reason.
alter table public.teams
  drop constraint if exists teams_fantrax_team_id_not_blank;
alter table public.teams
  add constraint teams_fantrax_team_id_not_blank
  check (fantrax_team_id is null or length(btrim(fantrax_team_id)) > 0);

comment on column public.teams.fantrax_team_id is
  'This Team''s id in the Fantrax league, as getTeamRosters keys its rosters. NULL until seeded; a NULL Team makes the divergence detector *not configured* for that Team and nothing is raised about it. Written by scripts/seed-fantrax-team-ids.js -- no admin UI ships for this column, exactly as 20260821010000_teams.sql:14 says of name and is_commissioner.';

-- --------------------------------------------------------------------------
-- 2. fantrax_reads -- the read record (AD-19).
-- --------------------------------------------------------------------------

create table if not exists public.fantrax_reads (
  id bigint generated always as identity primary key,

  -- The database clock the read happened at, defaulted in SQL rather than
  -- supplied by the caller. Never a clock read in application code (AD-3).
  read_at timestamptz not null default now(),

  -- One word for the attempt, and exactly the four members of the reader's own
  -- result union: 'ok', 'unreachable', 'rate_limited', 'malformed'.
  --
  -- There is deliberately NO 'implausible' here, though the plausibility guard
  -- is real: that guard runs at RENDER, over the stored membership, and never
  -- reaches this insert at all. A read that Fantrax answered successfully and
  -- that the guard later refuses is an `ok` ROW with an implausible content —
  -- which is the honest record, because the read did succeed and it is the
  -- comparison that declines to trust it. Naming an outcome nothing can write
  -- would send the next operator hunting for rows that cannot exist.
  --
  -- Deliberately text with no check constraint,
  -- for tick_heartbeats' reason: a later story adding an outcome must not need
  -- a migration to record one, and an unrecognised outcome recorded honestly
  -- beats an attempt that could not write its row at all.
  outcome text not null,

  -- One human sentence: what failed, or how many Teams and rows arrived.
  -- NEVER the endpoint URL and never a credential -- adapters/fantrax's
  -- reader keeps both out of every string it returns, the same discipline
  -- adapters/discord/webhook.ts applies to a webhook URL.
  detail text,

  -- What Fantrax said, normalised, and NOTHING derived from it: an object of
  -- Fantrax team id -> array of { playerId, playerName, slotKind }. The
  -- comparison runs at RENDER against this row, not at read time, which is
  -- what makes "once the Trade is recorded, the divergence resolves on the
  -- next page view" arrive immediately instead of up to an hour later -- and
  -- it keeps this row a transcript of a third party rather than an opinion
  -- about the league. Nothing folds it, no rule reads it, and no money is ever
  -- taken from it.
  membership jsonb,

  -- WHICH Players' `salary` figures rounded to a value off the $500,000 grid,
  -- by name. NAMED and not merely counted, for src/lib/server/import-status.ts's
  -- reason -- an outstanding item a Commissioner can act on is one they can
  -- identify, and "4 figures were off the grid" is a fact nobody can do
  -- anything with.
  --
  -- A WARNING and never a refusal: a membership-only detector that discarded a
  -- row over an unused field would manufacture a departure, so the Player stays
  -- a member and the read carries this list beside him.
  money_warnings jsonb not null default '[]'::jsonb,

  -- The same fact as a number. Denormalised deliberately and only so that an
  -- operator can ask "did any read carry a warning" with a plain integer
  -- predicate rather than unpacking JSON; the array above is the fact, and the
  -- application derives this from it on write rather than counting twice.
  money_warning_count integer not null default 0
);

comment on table public.fantrax_reads is
  'One row per Fantrax roster read attempt (Story 7.9, AD-19). Append-only. Copies tick_heartbeats for the same reason: a read that recorded nothing is indistinguishable from a reader that is not running at all, and "the detector quietly stopped detecting" is the failure this table exists to make visible. Not an event-sourced projection -- nothing folds it and nothing replays it.';

comment on column public.fantrax_reads.membership is
  'The normalised Fantrax team id -> Players map, exactly as the endpoint stated it and with nothing derived. NULL for any outcome but ''ok''. Read only by the divergence surface, which compares it against team_rosters and the Auction Contracts at render time.';

-- Newest first, which is the only question anybody asks of this table: "did
-- the read run, and what did the last one say".
create index if not exists fantrax_reads_read_at_idx
  on public.fantrax_reads (read_at desc);

alter table public.fantrax_reads enable row level security;
alter table public.fantrax_reads force row level security;

-- No `create policy` follows, and that is the design: RLS enabled with no
-- policy makes every row invisible and unwritable to every role RLS applies
-- to. The writer is the direct Postgres connection opened from
-- SUPABASE_DB_URL, which is the one path a browser can never travel.

revoke all on table public.fantrax_reads from anon;
revoke all on table public.fantrax_reads from authenticated;

-- SELECT and INSERT only, exactly as auction_events and tick_heartbeats
-- narrow it. UPDATE and DELETE are deliberately absent -- a read record that
-- can be edited after the fact is not evidence of anything.
revoke all on table public.fantrax_reads from service_role;
grant select, insert on table public.fantrax_reads to service_role;

-- --------------------------------------------------------------------------
-- 3. fantrax_divergence_dismissals -- "not now", keyed on content.
-- --------------------------------------------------------------------------

create table if not exists public.fantrax_divergence_dismissals (
  -- The CONTENT fingerprint of the divergence, or of a tripped guard. The
  -- primary key IS the rule: a dismissal suppresses exactly the reading it was
  -- taken against, and any change to the Players, the Teams or the direction
  -- produces a different fingerprint and therefore raises again, with no
  -- expiry, no timer and nothing to remember to undo.
  fingerprint text primary key,

  dismissed_at timestamptz not null default now(),

  -- Who clicked it. Audit detail, not a key -- nothing reads it to decide
  -- anything, and a dismissal is not an act the arithmetic can see.
  --
  -- ON DELETE SET NULL, chosen rather than defaulted. The dismissal OUTLIVES the
  -- person: it is a statement about a reading of Fantrax, and it must go on
  -- suppressing that reading whether or not the Manager who took it still has a
  -- row. The default (RESTRICT) would make one "seen it" click permanently block
  -- removing that manager, which is a very large consequence for a very small
  -- act. CASCADE would be worse still -- deleting a Manager would silently
  -- re-raise every divergence they had dismissed.
  dismissed_by uuid references public.managers(id) on delete set null,

  constraint fantrax_divergence_dismissals_fingerprint_not_blank
    check (length(btrim(fingerprint)) > 0)
);

comment on table public.fantrax_divergence_dismissals is
  'Dismissed divergences and acknowledged plausibility guards (Story 7.9). Keyed on a content fingerprint, so a changed divergence is a new row and re-raises by itself. Deliberately NOT an event: a dismissal changes nothing the app computes, and putting a "seen it" click in the league-visible log with a mandatory reason would be auction-grade ceremony over a third party''s noise.';

comment on column public.fantrax_divergence_dismissals.fingerprint is
  'Derived from the divergence''s CONTENT alone by core/rules/divergence.ts -- never from a row id, a timestamp or a read. That is what makes "dismissed stays dismissed until it changes" a property of the data rather than of a policy.';

alter table public.fantrax_divergence_dismissals enable row level security;
alter table public.fantrax_divergence_dismissals force row level security;

revoke all on table public.fantrax_divergence_dismissals from anon;
revoke all on table public.fantrax_divergence_dismissals from authenticated;

-- SELECT and INSERT. No UPDATE -- a dismissal is written once and never
-- amended; a second dismissal of the same fingerprint is `on conflict do
-- nothing`. No DELETE either: un-dismissing is not a control this story
-- offers, because the content changing is what brings a divergence back and
-- that path needs no row removed.
revoke all on table public.fantrax_divergence_dismissals from service_role;
grant select, insert on table public.fantrax_divergence_dismissals to service_role;

-- --------------------------------------------------------------------------
-- 4. The hourly schedule.
-- --------------------------------------------------------------------------
--
-- ONE HOUR, and the number is a rate-limit courtesy to an undocumented third
-- party rather than a freshness figure -- `core/constants.ts`'s
-- DIVERGENCE_READ_INTERVAL states the same hour on the application side, and
-- `server/divergence.ts` enforces it from the last `fantrax_reads` row, so a
-- second invocation inside the interval is SKIPPED regardless of what any
-- scheduler does. This job being enabled twice, or invoked by hand, cannot
-- produce two reads in an hour.
--
-- It deliberately does NOT ride the 10-second tick. That pass closes Auctions
-- under the global write lock; hanging an unauthenticated third-party HTTP
-- read off it would put a stranger's latency in the path of every close.
--
-- Guarded on the job not already existing, so re-applying this file to a
-- database whose schedule an operator has since ENABLED does not silently
-- switch it back off. `cron.schedule` upserts by jobname and sets active =
-- true on the way through, which is precisely the surprise the guard avoids.
-- `cron.alter_job`, never `update cron.job` -- see 20260831000000_tick.sql.

do $migration$
declare
  fantrax_job_id bigint;
begin
  if not exists (select 1 from cron.job where jobname = 'bbsl-fantrax-read') then
    fantrax_job_id := cron.schedule(
      'bbsl-fantrax-read',
      -- **A five-field cron expression, NOT an interval string.** pg_cron's
      -- interval-string form ('10 seconds', as 20260831000000_tick.sql uses for
      -- the tick) accepts SUB-MINUTE values only; anything a minute or longer
      -- must be a cron expression, and passing '1 hour' raises inside this
      -- DO block -- which would leave neither the job nor its `active := false`
      -- guard created, and the failure would look like a migration that applied.
      -- On the hour, every hour.
      '0 * * * *',
      $job$
        select net.http_post(
          -- Both values are read from Vault BY NAME, at invocation time. No
          -- secret and no project-specific URL is committed anywhere in this
          -- repository; a project whose secrets are absent gets a null url,
          -- which pg_net rejects outright and pg_cron records as a failed run
          -- in cron.job_run_details. That is the correct, visible outcome for
          -- a project nobody configured to read Fantrax.
          url := (
            select decrypted_secret from vault.decrypted_secrets
            where name = 'fantrax_read_function_url'
          ),
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            -- The shared secret .env.example names FANTRAX_READ_INVOCATION_SECRET.
            -- /api/fantrax-read refuses with a bare 401 before it opens any
            -- connection when this does not match.
            'x-fantrax-read-invocation-secret', (
              select decrypted_secret from vault.decrypted_secrets
              where name = 'fantrax_read_invocation_secret'
            )
          ),
          body := '{}'::jsonb,
          -- Bounds the RESPONSE wait, not the read. pg_net is asynchronous:
          -- this job queues the request and returns. 60 seconds sits far
          -- inside the hourly interval, so a stalled reply is abandoned long
          -- before the next run rather than accumulating queued responses.
          -- The reader has its own AbortSignal besides, because an
          -- undocumented third party can hang where a webhook does not.
          timeout_milliseconds := 60000
        );
      $job$
    );

    -- INACTIVE. Enabling it is a deliberate act against a specific project,
    -- not something applying a migration does on anybody's behalf -- and it
    -- must not be enabled against a project holding real rosters until the
    -- Fantrax team ids are seeded, because until they are every Team reads as
    -- unmapped.
    perform cron.alter_job(job_id := fantrax_job_id, active := false);
  end if;
end
$migration$;
