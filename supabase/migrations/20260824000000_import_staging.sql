-- Fantrax roster import staging. Story 1.7.
--
-- AD-24: all Fantrax knowledge sits in adapters/fantrax/; these tables hold
-- only the domain rows the adapter emits, keyed by Team. Staging is
-- independent per-Team Setup state (AD-28) -- deliberately NOT the
-- append-only auction_events log and NOT gated by the global write lock.
-- See this story's Design Notes for why runTransactionalWrite does not
-- apply here: a per-file local transaction suffices because files never
-- contend for the same Team's rows.
--
-- import_team_sources is keyed by team_id (its PK), one row per Team,
-- carrying the outcome of the most recently supplied file for that Team --
-- 'staged' (rows populated), 'refused_content' (rows cleared, refusal_detail
-- states the offending row or the arithmetic -- but ONLY when the Team had
-- nothing staged before this attempt; see the next paragraph), or
-- 'refused_file' (reserved for a file-altitude outcome persisted against a
-- known Team; src/lib/server/roster-import.ts never writes it today,
-- because every file-altitude refusal it can reach either has no team_id to
-- key by at all -- no Team matches the file name -- or does have one but
-- must NOT overwrite that Team's status from earlier in the same upload
-- batch -- a Team already claimed by an earlier file in this drop. The
-- value is kept in the check constraint for schema completeness and any
-- future caller that can attribute a file-altitude refusal to a Team
-- without that risk).
--
-- A Team absent from this table entirely, or present with any status other
-- than 'staged', is outstanding (epic-1-context.md: "outstanding Teams
-- named not counted").
--
-- import_staged_rosters holds the parsed rows for whichever Team most
-- recently staged successfully. A SUCCESSFUL (re-)supply always deletes a
-- Team's existing rows before writing the new ones. A REFUSED (re-)supply
-- never does: src/lib/server/roster-import.ts's writeOutcome reads the
-- Team's current status first when the outcome is a refusal, and if it is
-- already 'staged', writes nothing at all -- the Team's rows and status
-- survive the failed attempt untouched, and the refusal is communicated only
-- through that request's own returned result (Boundaries & Constraints,
-- amended at review-loop-iteration 1). Only a Team with nothing currently
-- staged records a refusal's status/detail, because there is nothing staged
-- there to protect.
--
-- RLS enabled+forced, no policy, matching managers.sql/teams.sql exactly.
-- Reached only through the direct Postgres connection
-- (SUPABASE_DB_URL/src/lib/shell/db.ts) that already writes auction_events
-- -- staging does not route through PostgREST/service_role.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

create table if not exists public.import_team_sources (
  -- The PK IS the Team FK: exactly one status row per Team, by construction,
  -- so "re-supply replaces this Team's status" is an upsert, not a query.
  team_id uuid primary key references public.teams(id),

  file_name text not null,

  status text not null,

  -- States the offending row or the arithmetic (product voice: fact, then
  -- arithmetic). Null only when status = 'staged'.
  refusal_detail text,

  updated_at timestamptz not null default now(),

  constraint import_team_sources_status_check
    check (status in ('staged', 'refused_file', 'refused_content')),

  constraint import_team_sources_file_name_not_blank
    check (length(btrim(file_name)) > 0)
);

comment on table public.import_team_sources is
  'Per-Team status of the most recently supplied roster file (AD-24, AD-28). Independent Setup state, not part of the auction_events log.';

alter table public.import_team_sources enable row level security;
alter table public.import_team_sources force row level security;

-- No `create policy` statement follows, and that is the design. With RLS
-- enabled and no policy, every row is invisible and unwritable to every role
-- that RLS applies to.

-- Belt as well as braces: revoke the default grants Postgres hands the
-- client-facing roles, so the answer does not depend on RLS alone.
revoke all on table public.import_team_sources from anon;
revoke all on table public.import_team_sources from authenticated;

-- Staged roster rows for a Team. Replaced wholesale, in one transaction, on
-- every (re-)supply attempt -- src/lib/server/roster-import.ts.
create table if not exists public.import_staged_rosters (
  id uuid primary key default gen_random_uuid(),

  team_id uuid not null references public.teams(id),

  -- The stable Fantrax player id. Rows join on this, never on name (AD-24).
  fantrax_player_id text not null,

  player_name text not null,

  -- Whole-dollar cap hit, the same integer-dollar shape `core/money.ts`
  -- brands at the boundary. Carries exactly what the file stated, even for a
  -- Minor League row -- `core/rules/roster-import.ts`'s computeCapSpace is
  -- what treats a Minor League row's cap hit as $0 against the Cap, not this
  -- column.
  cap_hit bigint not null,

  roster_slot_kind text not null,

  contract_years_remaining integer not null,

  constraint import_staged_rosters_roster_slot_kind_check
    check (roster_slot_kind in ('active_bench', 'injury_reserve', 'minor_league')),

  constraint import_staged_rosters_fantrax_player_id_not_blank
    check (length(btrim(fantrax_player_id)) > 0),

  constraint import_staged_rosters_player_name_not_blank
    check (length(btrim(player_name)) > 0),

  constraint import_staged_rosters_contract_years_remaining_non_negative
    check (contract_years_remaining >= 0)
);

comment on table public.import_staged_rosters is
  'Parsed roster rows for a Team''s most recently staged file (AD-24). Replaced wholesale, in one transaction, on every (re-)supply attempt.';

-- Every read of this table so far (the status list, a future promotion
-- story) fans out per Team, never scans the whole table unfiltered.
create index if not exists import_staged_rosters_team_id_idx
  on public.import_staged_rosters (team_id);

alter table public.import_staged_rosters enable row level security;
alter table public.import_staged_rosters force row level security;

revoke all on table public.import_staged_rosters from anon;
revoke all on table public.import_staged_rosters from authenticated;
