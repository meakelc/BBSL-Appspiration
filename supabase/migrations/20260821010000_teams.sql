-- The Team registry, and the Manager/Commissioner binding. Story 1.4.
--
-- AD-15: Team binding and the Commissioner flag resolve server-side from
-- application tables the Commissioner alone writes, never from auth metadata
-- or any client-influenceable claim. `managers.team_id` and
-- `managers.is_commissioner` are that table; the registry read path in
-- `src/lib/server/supabase.ts` is the only place that resolves them.
--
-- AD-16: every table carries an explicit row-level policy and anonymous roles
-- read nothing. `teams` carries RLS with NO policy at all, mirroring
-- `managers.sql` exactly — only the service role, held by server-side code
-- alone, reaches these rows.
--
-- No admin UI ships for assigning either column. The Commissioner writes them
-- directly, the same way `managers` rows were seeded in Story 1.3.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

create table if not exists public.teams (
  -- A surrogate key, so a Team's identity survives a rename. Every later
  -- foreign key points here, never at the name.
  id uuid primary key default gen_random_uuid(),

  -- The spelled-out fantasy Team name. Glossary rule: a three-letter
  -- capitalised abbreviation always and only means a player's real-life NBA
  -- team, so a fantasy Team is never abbreviated — it is spelled out, and it
  -- is unique so "which Team is this" is never ambiguous.
  name text not null unique,

  created_at timestamptz not null default now(),

  -- A blank name would register a Team with nothing to display alongside its
  -- acting Manager (AD's "Lakers — Meakel" convention).
  constraint teams_name_not_blank check (length(btrim(name)) > 0)
);

comment on table public.teams is
  'Fantasy Teams (AD-15). Written by the Commissioner only; read server-side through the service role. No client-facing role holds any grant on this table.';

-- RLS on, and forced, so the table owner is not silently exempt either.
alter table public.teams enable row level security;
alter table public.teams force row level security;

-- No `create policy` statement follows, and that is the design. With RLS
-- enabled and no policy, every row is invisible and unwritable to every role
-- that RLS applies to. Adding a permissive policy here would hand the browser
-- the league roster.

-- Belt as well as braces: revoke the default grants Postgres hands the
-- client-facing roles, so the answer does not depend on RLS alone.
revoke all on table public.teams from anon;
revoke all on table public.teams from authenticated;

-- The Manager/Team binding and the Commissioner flag. Story 1.3 left both
-- deliberately absent from `managers`; this is the story that owes them.
--
-- `team_id` is nullable so onboarding can register a Manager before their
-- Team is assigned — a Manager with no Team yet is a real, supported state,
-- not an error. A single column already makes "exactly one Team" structural:
-- there is no shape in which a Manager could resolve to two.
alter table public.managers
  add column if not exists team_id uuid references public.teams(id);

-- Default false: an un-set Commissioner flag must fail safe, the same way
-- Minor League Eligibility fails safe on omission elsewhere in this epic.
alter table public.managers
  add column if not exists is_commissioner boolean not null default false;

comment on column public.managers.team_id is
  'The Team this Manager acts for. Null until the Commissioner assigns one. Two managers rows may share one team_id — that is co-management, not an error.';

comment on column public.managers.is_commissioner is
  'Whether this Manager may reach a Commissioner-only route (AD-15). Set by the Commissioner directly; no admin UI. Resolved server-side only, never from auth metadata.';
