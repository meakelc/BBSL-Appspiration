-- The Fantrax divergence read moves from hourly to every thirty minutes.
-- Story 7.9, FR-42. Requested by the Commissioner on 2026-09-14.
--
-- **Why a second migration rather than an edit to 20260915000000.** That file
-- creates the job inside `if not exists (select 1 from cron.job where jobname
-- = 'bbsl-fantrax-read')`, precisely so that re-applying it cannot silently
-- switch off a schedule an operator has since ENABLED. That guard is doing its
-- job here: editing the original would change nothing on any database that
-- already has the row, so the dev project and prod would keep reading hourly
-- while the file claimed otherwise. A migration is the only honest mechanism.
--
-- **`cron.alter_job`, never `update cron.job`, and never `cron.schedule`.**
-- cron.job is owned by the extension (see 20260831000000_tick.sql, which
-- states this rule first). `cron.schedule` would also work by upsert, but it
-- sets `active := true` on the way through -- so a project that has
-- deliberately left this job disabled would find it running after a migration
-- that only meant to change its spacing. `cron.alter_job` changes the schedule
-- and touches `active` not at all, which is the whole reason to prefer it.
--
-- **Still a five-field expression, not an interval string.** pg_cron's
-- interval form accepts sub-minute values only; '30 minutes' would raise
-- inside this DO block, and the failure would look like a migration that
-- applied. On the hour and on the half hour.
--
-- **The cron schedule is not the binding constraint.** `DIVERGENCE_READ_INTERVAL`
-- in src/lib/core/constants.ts is, because src/lib/server/divergence.ts
-- enforces the interval from the last `fantrax_reads` row rather than from a
-- timer. A cron firing more often than the constant is simply skipped, and
-- cheaply. The two must agree or the schedule is misleading -- the constant
-- moved to thirty minutes in the same commit as this file -- but if they ever
-- drift, the constant is what actually governs and the schedule is the thing
-- to correct.
--
-- **What this costs.** Twice the invocations, which is still noise beside the
-- 10-second tick's ~259,200 a month. The real figure to watch is storage: an
-- `ok` read stores the whole normalised membership, `fantrax_reads` has no
-- retention and nothing prunes it, so the table's growth roughly doubles to an
-- estimated ~50MB a month. Revisit with a retention policy before shortening
-- this again.
--
-- Guarded on the job EXISTING, so applying this to a project that never
-- created the job (or that removed it deliberately) is a no-op with a notice
-- rather than an error.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

do $migration$
begin
  if exists (select 1 from cron.job where jobname = 'bbsl-fantrax-read') then
    perform cron.alter_job(
      job_id := (select jobid from cron.job where jobname = 'bbsl-fantrax-read'),
      schedule := '0,30 * * * *'
    );
    raise notice 'bbsl-fantrax-read rescheduled to every thirty minutes (active unchanged).';
  else
    raise notice 'bbsl-fantrax-read not present; nothing rescheduled.';
  end if;
end;
$migration$;
