-- The Free Agent pool's FILE order, carried from the export to the surface.
--
-- The nomination list was ordered by `player_name asc`, which is the one
-- order a Manager never has in their head. The Fantrax export arrives already
-- sorted -- its own default, by Score descending -- and that ordering is the
-- one every Manager has been reading all week in Fantrax itself. Alphabetical
-- was not neutral; it was a second, worse ranking silently substituted for
-- the one the file states.
--
-- The rank is the ROW'S POSITION IN THE FILE, nothing more. It is
-- deliberately NOT the export's `Score` or `RkOv` column: reading either
-- would put a Fantrax valuation into the domain, and the app has no standing
-- to hold a number it does not use. Position-in-file makes the app repeat the
-- file's order without ever claiming to know why that order is what it is.
--
-- It carries staging -> live exactly as the four other pool columns do:
-- imported reference data, replaced wholesale on every promotion, never
-- rebuilt from the log. `minor_league_eligible` remains the sole
-- event-sourced column of `free_agent_players`.
--
-- `not null default 0` rather than nullable: a pool staged before this
-- migration keeps every row at 0, where a stable tie-break on
-- `player_name` reproduces exactly today's alphabetical list. Re-supplying
-- the file is what gives the pool its real order, and nothing is required
-- to happen before then.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

alter table public.import_staged_pool_players
  add column if not exists source_rank integer not null default 0;

comment on column public.import_staged_pool_players.source_rank is
  'The row''s 0-based position in the supplied pool CSV. The export''s own order, carried verbatim; never a parsed Score or RkOv.';

alter table public.free_agent_players
  add column if not exists source_rank integer not null default 0;

comment on column public.free_agent_players.source_rank is
  'The row''s 0-based position in the promoted pool CSV. Imported reference data, like player_name/positions/nba_team; not a projection.';
