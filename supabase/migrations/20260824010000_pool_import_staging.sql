-- Fantrax Free Agent pool import staging. Story 1.8.
--
-- AD-24: all Fantrax knowledge sits in adapters/fantrax/; these tables hold
-- only the domain rows the pool adapter emits. AD-28: the pool is exactly
-- ONE distinguished staging source, keyed by pool, alongside the thirty
-- per-Team sources 20260824000000_import_staging.sql created. Staging is
-- independent Setup state -- deliberately NOT the append-only auction_events
-- log and NOT gated by the global write lock, for the same reason 1.7's
-- Design Notes give: a per-file local transaction suffices because the pool
-- file never contends with any Team's rows.
--
-- import_pool_source is the pool-keyed analogue of import_team_sources.
-- Where that table's PK is team_id -- "exactly one status row per Team, by
-- construction" -- this table's PK is a single fixed text value with a check
-- constraint pinning it to 'pool', so "exactly one status row for the pool"
-- is true by construction too. A nullable team_id on import_team_sources was
-- deliberately rejected: widening that PK to admit a null would trade away
-- the per-Team guarantee, and every read would then have to remember to
-- filter (see this story's Design Notes).
--
-- Status values match import_team_sources' vocabulary exactly: 'staged'
-- (rows populated), 'refused_content' (a bad column, a duplicate Fantrax
-- Player ID, or a Player also present in a Team's staged roster), or
-- 'refused_file' (reserved on the same terms 1.7 reserved it -- the pool
-- file supplied twice in one drop has no separate key to record against
-- without destroying the status the first file in that drop just
-- established, so src/lib/server/pool-import.ts never writes it today).
--
-- A missing row, or a row with any status other than 'staged', means the
-- pool is outstanding (epic-1-context.md: "outstanding sources named, not
-- counted") -- src/lib/server/import-status.ts is the one place that rule
-- is decided.
--
-- A REFUSED (re-)supply never destroys an already-staged pool:
-- src/lib/server/pool-import.ts's writeOutcome reads the current status
-- first and writes nothing at all when it is already 'staged', exactly as
-- 1.7 amended for Teams.
--
-- RLS enabled+forced, no policy, matching managers.sql/teams.sql/
-- import_staging.sql exactly. Reached only through the direct Postgres
-- connection (SUPABASE_DB_URL/src/lib/shell/db.ts).
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

create table if not exists public.import_pool_source (
  -- One row by construction: the PK admits exactly one value.
  id text primary key default 'pool',

  file_name text not null,

  status text not null,

  -- States the offending row or the conflicting Player and Team (product
  -- voice: fact, then the specifics). Null only when status = 'staged'.
  refusal_detail text,

  updated_at timestamptz not null default now(),

  constraint import_pool_source_singleton_check
    check (id = 'pool'),

  constraint import_pool_source_status_check
    check (status in ('staged', 'refused_file', 'refused_content')),

  constraint import_pool_source_file_name_not_blank
    check (length(btrim(file_name)) > 0)
);

comment on table public.import_pool_source is
  'Status of the most recently supplied Free Agent pool file (AD-24, AD-28). A singleton row: the pool is exactly one source. Independent Setup state, not part of the auction_events log.';

alter table public.import_pool_source enable row level security;
alter table public.import_pool_source force row level security;

-- No `create policy` statement follows, and that is the design. With RLS
-- enabled and no policy, every row is invisible and unwritable to every role
-- that RLS applies to.

-- Belt as well as braces: revoke the default grants Postgres hands the
-- client-facing roles, so the answer does not depend on RLS alone.
revoke all on table public.import_pool_source from anon;
revoke all on table public.import_pool_source from authenticated;

-- The staged Free Agent pool. Replaced wholesale, in one transaction, on
-- every successful (re-)supply -- src/lib/server/pool-import.ts.
create table if not exists public.import_staged_pool_players (
  id uuid primary key default gen_random_uuid(),

  -- The stable Fantrax player id. Rows join on this, never on name (AD-24).
  -- UNIQUE because the pool is exactly one source: a repeated id here is a
  -- defect, not a re-supply (a re-supply deletes every row first). The
  -- adapter already refuses a duplicate within the file at content altitude;
  -- this constraint is the schema saying the same thing.
  fantrax_player_id text not null unique,

  player_name text not null,

  -- The Player's listed position(s), verbatim from the export -- possibly
  -- several, in whatever separator that export uses. Nothing in this story
  -- parses them apart.
  positions text not null,

  -- The three-letter capitalised abbreviation of the Player's real-life NBA
  -- team (glossary: an abbreviation always and only means this, never a
  -- fantasy Team).
  nba_team text not null,

  -- Minor League Eligibility is APP-OWNED, not imported (epic-1-context.md).
  -- The default is `false` -- not eligible -- so omission fails safe rather
  -- than granting unbounded bidding. The pool adapter never reads, derives,
  -- infers or fails on this: it is set here, as a column default, and by
  -- nothing else in this story. Story 1.10 builds the Commissioner's path to
  -- change it, recorded as events.
  minor_league_eligible boolean not null default false,

  constraint import_staged_pool_players_fantrax_player_id_not_blank
    check (length(btrim(fantrax_player_id)) > 0),

  constraint import_staged_pool_players_player_name_not_blank
    check (length(btrim(player_name)) > 0),

  constraint import_staged_pool_players_positions_not_blank
    check (length(btrim(positions)) > 0),

  constraint import_staged_pool_players_nba_team_not_blank
    check (length(btrim(nba_team)) > 0)
);

comment on table public.import_staged_pool_players is
  'The staged Free Agent pool (AD-24, AD-28). Replaced wholesale, in one transaction, on every successful (re-)supply. minor_league_eligible is app-owned and defaults to false -- never read from the file.';

-- The cross-source conflict check (a Player in both the pool and a Team's
-- staged roster) queries this table by fantrax_player_id in the roster
-- direction; the unique constraint above already indexes it.

alter table public.import_staged_pool_players enable row level security;
alter table public.import_staged_pool_players force row level security;

revoke all on table public.import_staged_pool_players from anon;
revoke all on table public.import_staged_pool_players from authenticated;

-- The pool's status and its size, read as ONE row from ONE snapshot.
--
-- src/lib/server/import-status.ts used to read these as two independent
-- queries -- the status row, then a count of the staged players. A (re-)stage
-- committing between those two reads returned a status and a playerCount that
-- never coexisted: the Commissioner would confirm a pool size belonging to a
-- different stage than the status shown beside it, and the story's "pool size
-- is reported for explicit confirmation" is exactly the figure that must not
-- be a mirage. A view collapses both into a single statement, so Postgres'
-- own statement-level snapshot makes the pair consistent by construction
-- rather than by luck of timing.
--
-- left join, not join: the pool's status row exists before any player row
-- does (a content-altitude refusal writes status with no rows at all), and a
-- count of zero is the correct answer there, not a vanished row.
create or replace view public.import_pool_status as
  select
    s.id,
    s.file_name,
    s.status,
    s.refusal_detail,
    s.updated_at,
    (select count(*) from public.import_staged_pool_players) as player_count
  from public.import_pool_source s;

comment on view public.import_pool_status is
  'The Free Agent pool status joined to its staged size, read as one consistent snapshot (Story 1.8, review-loop-iteration 1).';

-- A view runs with its definer's privileges by default; both underlying
-- tables are RLS-forced with no policy and revoked from the client roles, and
-- this view must not become the hole in that wall.
alter view public.import_pool_status set (security_invoker = on);

revoke all on public.import_pool_status from anon;
revoke all on public.import_pool_status from authenticated;
