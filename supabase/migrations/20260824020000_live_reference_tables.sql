-- The live reference tables: the League's promoted rosters and Free Agent
-- pool. Story 1.9.
--
-- These are the FIRST live tables in the product. Everything before them was
-- either the append-only auction_events log (Story 1.5) or independent Setup
-- staging (Stories 1.7/1.8). They are deliberately MUTABLE reference data,
-- not an event-sourced projection: AD says "the world is not event-sourced,
-- only the auction is". Nothing rebuilds these from the log, and nothing
-- should ever be written that implies it could.
--
-- They are written by exactly one path: src/lib/server/import-promotion.ts's
-- promoteImport, inside ONE runTransactionalWrite transaction covering all
-- thirty-one staged sources. Promotion holds the global advisory write lock
-- (AD-6), reads the phase from the log in that same transaction, appends one
-- ImportPromoted event, and replaces every row in both tables through the
-- projection seam (AD-5) -- which is used because it is the one hook that
-- persists INSIDE the appending transaction, not because these tables are a
-- projection. A partial commit is unreachable by construction.
--
-- Re-import during Setup replaces live state entirely: delete-then-insert
-- inside that same transaction. Once the phase folds to Auction, promotion is
-- refused server-side and these tables stop changing.
--
-- RLS enabled+forced, no policy, matching managers.sql/teams.sql/
-- import_staging.sql/pool_import_staging.sql exactly. Reached only through
-- the direct Postgres connection (SUPABASE_DB_URL/src/lib/shell/db.ts).
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

-- The League's live rosters -- every Team's Players as promoted.
create table if not exists public.team_rosters (
  id uuid primary key default gen_random_uuid(),

  team_id uuid not null references public.teams(id),

  -- The stable Fantrax player id. Rows join on this, never on name (AD-24).
  --
  -- UNIQUE ACROSS EVERY TEAM, and that is the point (this story's Design
  -- Notes). Staging cannot enforce it: thirty roster files are staged
  -- independently, so the same Player on two Teams is only detectable when
  -- all thirty meet. They meet exactly once -- at promotion -- so the
  -- constraint belongs here, on the live table, where a violation aborts the
  -- one transaction and rolls every source back rather than half-importing
  -- the League. This is what makes deferred-work.md's logged "nothing
  -- detects the same Player on two Teams' staged rosters" gap structural.
  fantrax_player_id text not null unique,

  player_name text not null,

  -- Whole-dollar cap hit, the same integer-dollar shape core/money.ts brands
  -- at the boundary. Carries exactly what the staged row stated, even for a
  -- Minor League row -- core/rules/roster-import.ts's computeCapSpace is what
  -- treats a Minor League row's cap hit as $0 against the Cap, not this
  -- column.
  cap_hit bigint not null,

  roster_slot_kind text not null,

  contract_years_remaining integer not null,

  constraint team_rosters_roster_slot_kind_check
    check (roster_slot_kind in ('active_bench', 'injury_reserve', 'minor_league')),

  constraint team_rosters_fantrax_player_id_not_blank
    check (length(btrim(fantrax_player_id)) > 0),

  constraint team_rosters_player_name_not_blank
    check (length(btrim(player_name)) > 0),

  constraint team_rosters_contract_years_remaining_non_negative
    check (contract_years_remaining >= 0)
);

comment on table public.team_rosters is
  'The live rosters of the League (Story 1.9). Mutable reference data, NOT an event-sourced projection -- never rebuilt from auction_events. Written only by import promotion, wholesale, in one transaction.';

-- Every read of this table fans out per Team.
create index if not exists team_rosters_team_id_idx
  on public.team_rosters (team_id);

alter table public.team_rosters enable row level security;
alter table public.team_rosters force row level security;

-- No `create policy` statement follows, and that is the design. With RLS
-- enabled and no policy, every row is invisible and unwritable to every role
-- that RLS applies to.

-- Belt as well as braces: revoke the default grants Postgres hands the
-- client-facing roles, so the answer does not depend on RLS alone.
revoke all on table public.team_rosters from anon;
revoke all on table public.team_rosters from authenticated;

-- The live Free Agent pool -- the set of Players available for Nomination.
create table if not exists public.free_agent_players (
  id uuid primary key default gen_random_uuid(),

  fantrax_player_id text not null unique,

  player_name text not null,

  -- The export's own position text, verbatim; nothing parses it apart.
  positions text not null,

  -- The three-letter capitalised abbreviation of the Player's real-life NBA
  -- team (glossary: an abbreviation always and only means this, never a
  -- fantasy Team).
  nba_team text not null,

  -- Minor League Eligibility is APP-OWNED, not imported. Promotion carries
  -- the staged `false` default across and does nothing else with it; Story
  -- 1.10 builds the Commissioner's path to change it, recorded as events.
  minor_league_eligible boolean not null default false,

  constraint free_agent_players_fantrax_player_id_not_blank
    check (length(btrim(fantrax_player_id)) > 0),

  constraint free_agent_players_player_name_not_blank
    check (length(btrim(player_name)) > 0),

  constraint free_agent_players_positions_not_blank
    check (length(btrim(positions)) > 0),

  constraint free_agent_players_nba_team_not_blank
    check (length(btrim(nba_team)) > 0)
);

comment on table public.free_agent_players is
  'The live Free Agent pool (Story 1.9). Mutable reference data, NOT an event-sourced projection. Written only by import promotion, wholesale, in one transaction. minor_league_eligible carries the staged false default across.';

alter table public.free_agent_players enable row level security;
alter table public.free_agent_players force row level security;

revoke all on table public.free_agent_players from anon;
revoke all on table public.free_agent_players from authenticated;
