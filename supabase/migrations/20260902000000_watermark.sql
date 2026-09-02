-- The global watermark: one row, one integer, subscribable by a browser.
-- Story 4.1, AD-29 / AD-16 / AD-9.
--
-- **Why a table at all, rather than subscribing to `auction_events`.** AD-16
-- revokes every client grant on every table, and 20260821020000 does exactly
-- that for the log: `revoke all ... from anon` and `... from authenticated`,
-- RLS enabled and forced with no policy. That is not an obstacle to route
-- around -- the log carries bid amounts, actors and payloads, and a browser
-- holding SELECT on it would be able to read every Team's position and every
-- pre-reveal detail the rest of the system is careful about. A single row
-- holding one monotonic integer is the smallest thing a browser can subscribe
-- to that still answers "has anything happened", and it makes AD-29's "one
-- watermark, one source" literally one row.
--
-- **Why a TRIGGER, not the shell.** `src/lib/shell/write.ts` is not the only
-- thing that appends to `auction_events`: the Deno tick
-- (`supabase/functions/tick/`) opens its own direct connection and inserts
-- through its own gateway. Anything maintained in the shell alone would miss
-- every Auction close and every phase end -- which is to say, it would miss
-- precisely the events nobody is watching a screen for. A trigger covers both
-- runtimes by construction rather than by two call sites remembering.
--
-- **The row exposes one integer and nothing else.** No timestamp, no event
-- type, no actor, no count. A subscriber learns that the log advanced and its
-- height; to learn anything more it must go back through the server, which is
-- the whole of AD-16's read-side posture.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

-- --------------------------------------------------------------------------
-- 1. The table -- exactly one row, forever.
-- --------------------------------------------------------------------------
--
-- The singleton is enforced by the schema, not by convention: the primary key
-- is a boolean constrained to `true`, so a second row is unwritable rather
-- than merely unwritten. A second row would be a second watermark, which is
-- the one thing AD-29 forbids.

create table if not exists public.auction_watermark (
  id boolean primary key default true,
  seq bigint not null default 0,
  constraint auction_watermark_single_row check (id)
);

comment on table public.auction_watermark is
  'The single global watermark (AD-29, Story 4.1): the highest auction_events.seq, maintained by an after-insert trigger on that table. Exactly one row. Readable by `authenticated` and by nothing else; written by no role at all, only by the trigger. Not an event-sourced projection -- it is a derived cache of one number and is rebuildable from `select max(seq) from auction_events` at any time.';

comment on column public.auction_watermark.seq is
  'The highest auction_events.seq observed. 0 for an empty log, which is a value no row can hold: seq is `generated always as identity` and starts at 1.';

-- Seeded from the log as it stands, so a database with events already in it
-- does not start life claiming an empty log. `on conflict do nothing` makes
-- re-applying this file a no-op rather than a reset to a stale maximum.
insert into public.auction_watermark (id, seq)
  values (true, coalesce((select max(seq) from public.auction_events), 0))
  on conflict (id) do nothing;

-- --------------------------------------------------------------------------
-- 2. The trigger -- covering both write runtimes.
-- --------------------------------------------------------------------------
--
-- `security definer` so the raise does not depend on what privilege the
-- INSERTing role happens to hold on this table: `service_role` (the SvelteKit
-- shell) and the tick's direct connection are different roles, and neither is
-- granted anything here. The function owns the write; nobody else has one.
--
-- `set search_path = public` pins the schema the function resolves names in --
-- a `security definer` function without it is the standard privilege-escalation
-- shape, since a caller could otherwise prepend a schema of their own.
--
-- `where seq < new.seq` rather than an unconditional assignment: the watermark
-- is monotonic and must never go backwards. Nothing in this design inserts an
-- out-of-order `seq` -- the column is `generated always as identity` -- but a
-- watermark that could be lowered by a badly ordered write would be a watermark
-- a surface could not trust, and the guard costs nothing.
--
-- Returns `null`, which is correct and idiomatic for an AFTER trigger: the
-- return value is ignored, and returning `new` would suggest otherwise.

create or replace function public.raise_auction_watermark()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.auction_watermark set seq = new.seq where seq < new.seq;
  return null;
end;
$$;

comment on function public.raise_auction_watermark() is
  'Raises public.auction_watermark to the seq just inserted into auction_events (Story 4.1). Runs for both write runtimes -- the SvelteKit shell and the Deno tick -- because it hangs off the table rather than off either caller.';

drop trigger if exists auction_events_raise_watermark on public.auction_events;

create trigger auction_events_raise_watermark
  after insert on public.auction_events
  for each row
  execute function public.raise_auction_watermark();

-- --------------------------------------------------------------------------
-- 3. Row-level security -- `select` to `authenticated`, and nothing else.
-- --------------------------------------------------------------------------
--
-- AD-16: anonymous roles read nothing, and authentication is required for all
-- data (PRD §6 "no public/spectator access"). AD-9: no client-facing role holds
-- INSERT, UPDATE or DELETE on any table -- the browser's key is read-only and
-- is used solely for Realtime subscriptions to projection tables. Both hold
-- here literally: `authenticated` is granted SELECT and nothing else, `anon` is
-- granted nothing, and no role anywhere is granted a write.
--
-- **RLS is enabled and NOT forced, and that is deliberate** -- the one place in
-- this schema that departs from the pattern every other table follows.
-- `force row level security` subjects the table OWNER to its policies too, and
-- the owner is exactly who `raise_auction_watermark()` runs as. Forcing it
-- would mean the UPDATE above needs an update policy of its own, and an update
-- policy is a thing that can be granted to a role by mistake. Leaving the owner
-- unforced keeps the write path a `security definer` function and nothing else,
-- which is a narrower opening than a policy would be. Client roles are subject
-- to RLS either way: neither `anon` nor `authenticated` is the owner.

alter table public.auction_watermark enable row level security;

-- Belt as well as braces, as every table in this schema establishes: the
-- client-facing roles hold nothing except what is granted back below.
revoke all on table public.auction_watermark from anon;
revoke all on table public.auction_watermark from authenticated;

-- Supabase's default privileges grant service_role ALL on a newly created
-- table. Revoked outright, with nothing granted back, so the table comment
-- above is literally true: `authenticated` reads this row and no other role
-- does.
--
-- **Not even SELECT, and that is the point.** The server never reads this
-- table: `server/watermark.ts` answers the liveness endpoint from
-- `auction_events`' own `max(seq)`, which AD-29 calls the source, so the server
-- never depends on this cache being correct. A grant nothing uses is a grant
-- nobody notices growing, and a service role that could WRITE this row would be
-- a second maintainer of a number that must have exactly one.
--
-- The trigger is unaffected: `raise_auction_watermark()` is `security definer`
-- and runs as the table owner, so an INSERT by service_role into
-- `auction_events` still raises this row without service_role holding anything
-- here at all.
revoke all on table public.auction_watermark from service_role;

-- The one client grant this story adds anywhere. SELECT only, on this table
-- only -- never on `auction_events`, never on a projection table.
grant select on table public.auction_watermark to authenticated;

-- Dropped first, for `drop trigger if exists` above's reason: `create policy`
-- is not idempotent, and every other statement in this file is. A migration
-- that cannot be re-applied to a database it has already touched is a migration
-- nobody can safely re-run against a half-migrated environment.
drop policy if exists auction_watermark_select_authenticated on public.auction_watermark;

create policy auction_watermark_select_authenticated
  on public.auction_watermark
  for select
  to authenticated
  using (true);

-- No insert, update or delete policy follows, for any role, and that is the
-- design: with RLS enabled, a write with no policy is refused outright. The
-- trigger function is the only writer and it bypasses RLS as the unforced
-- owner.

-- --------------------------------------------------------------------------
-- 4. Realtime -- publish this table, and only this table.
-- --------------------------------------------------------------------------
--
-- Supabase Realtime's `postgres_changes` reads the `supabase_realtime`
-- publication and re-checks RLS against the SUBSCRIBER's JWT, so a browser sees
-- these rows for the same reason and under the same policy as a plain select.
--
-- `replica identity default` (the primary key) is left as it is: the UPDATE's
-- new row is what a subscriber needs, and `full` would additionally publish the
-- OLD row for no reader that exists.
--
-- Guarded, because `alter publication ... add table` errors if the table is
-- already a member -- which re-applying this file would otherwise cause -- and
-- because a database without the publication at all (a bare Postgres, not a
-- Supabase stack) must still be able to apply the migration.

do $migration$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'auction_watermark'
    ) then
      alter publication supabase_realtime add table public.auction_watermark;
    end if;
  end if;
end
$migration$;
