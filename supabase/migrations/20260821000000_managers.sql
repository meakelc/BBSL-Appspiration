-- The Manager registry. Story 1.3.
--
-- AD-15: identity is Discord OAuth, and the Discord user id lives in an
-- application table written only by the Commissioner and resolved server-side
-- on every request. It is never read from JWT app-metadata or any claim the
-- client can influence, because Supabase's `updateUser` makes user metadata
-- self-writable and a metadata-based binding is therefore self-assignable.
--
-- AD-16: every table carries an explicit row-level policy and anonymous roles
-- read nothing. This table carries RLS with NO policy at all, which is the
-- explicit statement that no client-facing role reads or writes it. Only the
-- service role — held by server-side code alone — reaches these rows, and it
-- bypasses RLS by definition.
--
-- This story creates the identity half only: which Discord accounts may sign
-- in, and what to call them. Team binding, the Commissioner flag and
-- co-management are Story 1.4 and are deliberately absent here.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

create table if not exists public.managers (
  -- A surrogate key, so a Manager's identity survives a Discord account being
  -- re-created. Every later foreign key points here, never at the Discord id.
  id uuid primary key default gen_random_uuid(),

  -- Discord snowflakes are 64-bit integers that Discord itself serialises as
  -- strings; text is the shape every client returns and the shape AD-18's
  -- @mention payload needs. Unique because two rows for one Discord account
  -- would make "is this account registered?" ambiguous, which is the one
  -- question this table exists to answer.
  discord_user_id text not null unique,

  -- What the league calls this person. Not an email, not a Discord handle that
  -- changes underneath us — a name the Commissioner sets.
  display_name text not null,

  created_at timestamptz not null default now(),

  -- A blank id or name would register an account that can never match a real
  -- Discord identity, or a Manager with no name to attribute an event to.
  constraint managers_discord_user_id_not_blank check (length(btrim(discord_user_id)) > 0),
  constraint managers_display_name_not_blank check (length(btrim(display_name)) > 0)
);

comment on table public.managers is
  'Pre-registered Discord accounts permitted to sign in (AD-15). Written by the Commissioner only; read server-side through the service role. No client-facing role holds any grant on this table.';

-- RLS on, and forced, so the table owner is not silently exempt either.
alter table public.managers enable row level security;
alter table public.managers force row level security;

-- No `create policy` statement follows, and that is the design. With RLS
-- enabled and no policy, every row is invisible and unwritable to every role
-- that RLS applies to. Adding a permissive policy here would hand the browser
-- the league roster.

-- Belt as well as braces: revoke the default grants Postgres hands the
-- client-facing roles, so the answer does not depend on RLS alone.
revoke all on table public.managers from anon;
revoke all on table public.managers from authenticated;
