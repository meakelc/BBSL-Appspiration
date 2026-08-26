-- The open-nomination claim table: the data-layer uniqueness FR-8 requires.
-- Story 2.2.
--
-- Story 2.1's gate reads the board, decides, then appends -- a check-then-write
-- gap that is correct today only because one advisory lock serialises every
-- writer. This table closes it where it belongs: two constraints that make a
-- second nomination of the same Player, or a second Slot spend by the same
-- Team, PHYSICALLY impossible rather than merely improbable.
--
-- It is a WRITE-SIDE CONSTRAINT, NEVER A READ. Nothing selects from it. Every
-- gate, the Nomination Slot, the Bid Board and the League Clock stay folds of
-- auction_events -- which is exactly why this does not violate Story 2.3's
-- "Slot status is never a stored flag": a stored flag is one that is READ, and
-- this one is only ever collided with. The question "is this Slot held" is
-- still answered by nominationForTeam over the fold.
--
-- Written by exactly one path: src/lib/server/nomination.ts's placeNomination,
-- through runTransactionalWrite's projection seam (AD-5) -- the one hook that
-- persists INSIDE the appending transaction. The claim row and the
-- NominationPlaced event therefore commit together or roll back together, and
-- a partial commit is unreachable by construction.
--
-- The constraint names below are LOAD-BEARING. src/lib/server/pg-errors.ts
-- classifies a SQLSTATE 23505 by constraint name to choose between the
-- already_nominated and slot_in_use refusals the pure core already words.
-- Renaming either constraint silently turns a named refusal into a 500.
--
-- This follows 20260824020000_live_reference_tables.sql's own argument that
-- uniqueness belongs "on the live table, where a violation aborts the
-- transaction" (:38-45), applied to the auction instead of the import.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

create table if not exists public.open_nominations (
  -- A Player is nominated once. The primary key IS the rule: there is no
  -- second row for the same Player while their Auction is open.
  --
  -- Deliberately not a partial unique index over auction_events'
  -- payload->>'fantraxPlayerId': an index cannot see a later event that undoes
  -- an earlier one, so it would enforce "one nomination per Player EVER" and
  -- block Story 2.3's close and Epic 7.3's release. A row a later story
  -- DELETES expresses "open right now", which is the fact being constrained.
  fantrax_player_id text not null,

  -- A Team holds ONE Nomination Slot. The unique constraint IS that rule.
  team_id uuid not null references public.teams(id),

  -- The NominationPlaced event this claim was written from, in the same
  -- transaction. The log remains the source of truth; this column only says
  -- which event the claim belongs to.
  seq bigint not null references public.auction_events(seq),

  occurred_at timestamptz not null,

  constraint open_nominations_fantrax_player_id_not_blank
    check (length(btrim(fantrax_player_id)) > 0),

  -- The two constraints that are the whole story, named EXPLICITLY because
  -- pg-errors.ts matches on these exact strings.
  constraint open_nominations_pkey primary key (fantrax_player_id),
  constraint open_nominations_team_id_key unique (team_id)
);

comment on table public.open_nominations is
  'Open nomination claims (Story 2.2). A WRITE-SIDE CONSTRAINT, never a read: nothing selects from it. Its two named constraints make a second nomination of a Player, or a second Slot spend by a Team, impossible at the data layer (FR-8). Written only by placeNomination, inside the same transaction as the NominationPlaced event.';

comment on column public.open_nominations.seq is
  'The NominationPlaced event this claim was written from. The log stays the source of truth.';

alter table public.open_nominations enable row level security;
alter table public.open_nominations force row level security;

-- No `create policy` statement follows, and that is the design: RLS enabled
-- with no policy makes every row invisible and unwritable to every role RLS
-- applies to. Reached only through the direct Postgres connection
-- (SUPABASE_DB_URL / src/lib/shell/db.ts).

-- Belt as well as braces: revoke the default grants Postgres hands the
-- client-facing roles, so the answer does not depend on RLS alone.
revoke all on table public.open_nominations from anon;
revoke all on table public.open_nominations from authenticated;

-- service_role holds SELECT, INSERT and DELETE here -- and DELETE deliberately,
-- unlike auction_events, whose insert-only grants (20260821020000_auction_events.sql:103-104)
-- are untouched by this migration. A claim is not a log entry: Story 2.3's
-- AuctionClosed and Epic 7.3's override release must REMOVE the claim so the
-- Player returns to the pool and the Team's Slot returns to them. UPDATE is
-- absent: a claim is written once and then deleted, never amended.
revoke all on table public.open_nominations from service_role;
grant select, insert, delete on table public.open_nominations to service_role;
