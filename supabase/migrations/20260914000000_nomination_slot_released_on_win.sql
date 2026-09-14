-- The Nomination Slot is released by WINNING a Player, not by the nominated
-- Player's Auction closing. FR-9, amended.
--
-- 20260825000000_open_nominations.sql made two rules physically impossible to
-- break with ONE row, because at the time they were one fact read two ways: a
-- Player was nominated once (the primary key), a Team spent one Slot (the
-- unique constraint on team_id), and BOTH claims ended at the same moment --
-- when that Player's Auction closed and the row was deleted.
--
-- They are no longer one fact, and the row can no longer carry both:
--
--   * The BOARD SEAT still ends when the Auction ends, either way it can end
--     -- an AuctionClosed with a winner, or an AuctionTerminated with none.
--     That is what open_nominations.fantrax_player_id has always constrained
--     and it is untouched here.
--
--   * The NOMINATION SLOT now ends when the nominating Team WINS a Player,
--     and at no other time. A Manager who nominates and is outbid keeps the
--     Slot held; a Player nobody bid on frees the pool but frees no Slot.
--     Losing does not give it back -- winning is what pays it back.
--
-- So the Slot outlives the seat, usually by a long way: most held Slots late
-- in an auction name a Player who left the board days earlier. A row deleted
-- on close cannot express a claim that survives the close, which is why the
-- Slot claim moves to its own table keyed on the TEAM rather than staying a
-- second constraint on a row keyed on the Player.
--
-- This is still a WRITE-SIDE CONSTRAINT AND NEVER A READ, exactly as
-- open_nominations is. Nothing selects from either table. "Is this Team's Slot
-- held" is answered by nominationForTeam over the nominationsReducer fold of
-- auction_events, which releases on the same event this table's delete keys
-- on. The table exists solely so that a second writer collides.
--
-- Written and deleted by exactly one module, src/lib/server/nomination.ts,
-- through runTransactionalWrite's projection seam (AD-5) -- the one hook that
-- persists INSIDE the appending transaction. The claim and its event commit
-- together or roll back together.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

create table if not exists public.nomination_slots (
  -- A Team holds ONE Nomination Slot. The primary key IS the rule, and it is
  -- the whole reason this table exists rather than a column somewhere: a
  -- second Slot-spending nomination by the same Team must fail at the data
  -- layer, not merely lose a race the advisory lock was already serialising.
  team_id uuid not null references public.teams(id),

  -- What the Slot was spent on. Carried so the row says which nomination this
  -- claim belongs to -- audit detail, not a key. It is deliberately NOT a
  -- foreign key to open_nominations: that row is deleted when the Auction
  -- closes and this one is not, which is the entire point of the change.
  fantrax_player_id text not null,

  -- The NominationPlaced event this claim was written from, in the same
  -- transaction. The log remains the source of truth; this column only says
  -- which event the claim belongs to.
  seq bigint not null references public.auction_events(seq),

  occurred_at timestamptz not null,

  constraint nomination_slots_fantrax_player_id_not_blank
    check (length(btrim(fantrax_player_id)) > 0),

  -- Named EXPLICITLY, because src/lib/server/nomination.ts matches on this
  -- exact string to turn a SQLSTATE 23505 into the slot_in_use refusal the
  -- pure core already words. Renaming it turns a named refusal into a 500.
  constraint nomination_slots_pkey primary key (team_id)
);

comment on table public.nomination_slots is
  'Nomination Slot claims: FR-8''s one Slot per Team, released under the amended FR-9. A WRITE-SIDE CONSTRAINT, never a read: nothing selects from it. Its primary key makes a second Slot-spending nomination by the same Team impossible at the data layer. A row is written by placeNomination and deleted only when that Team WINS a Player -- never when the Player it names leaves the board. Commissioner nominations write no row at all (Story 9.8).';

comment on column public.nomination_slots.fantrax_player_id is
  'The Player this Slot was spent on. Audit detail, not a key, and deliberately not a foreign key: the matching open_nominations row is deleted when that Auction closes while this row survives until the Team wins.';

comment on column public.nomination_slots.seq is
  'The NominationPlaced event this claim was written from. The log stays the source of truth.';

alter table public.nomination_slots enable row level security;
alter table public.nomination_slots force row level security;

-- RLS enabled with no policy makes every row invisible and unwritable to
-- every role RLS applies to. Reached only through the direct Postgres
-- connection (SUPABASE_DB_URL / src/lib/shell/db.ts). open_nominations'
-- own argument, unchanged.
revoke all on table public.nomination_slots from anon;
revoke all on table public.nomination_slots from authenticated;

-- SELECT, INSERT and DELETE, and DELETE deliberately: a claim is written once
-- and then removed when the Team wins. UPDATE is absent -- a claim is never
-- amended, and a Team that wins twice deletes a row that is already gone.
revoke all on table public.nomination_slots from service_role;
grant select, insert, delete on table public.nomination_slots to service_role;

-- Carry the Slots that are currently held across to the new table.
--
-- This is the best answer available and it is not a perfect one. Under the
-- OLD rule a Slot was released the moment its Player's Auction closed, so the
-- open_nominations rows that survive are exactly the Slots held under the old
-- rule -- and under the NEW rule some Teams would additionally still hold a
-- Slot spent on a Player whose Auction has already closed, which this table
-- cannot know, because the row recording it was deleted. Reconstructing those
-- would mean replaying auction_events here, and a migration must not encode a
-- fold the core owns (AD-2).
--
-- It errs toward the LOOSER answer, which is the right direction: a Team that
-- should be locked out is merely allowed one more nomination, rather than a
-- Team being locked out of an auction on a claim nobody can point at. The
-- fold over auction_events is the authority in either case, and it is what
-- every gate and every sentence reads.
insert into public.nomination_slots (team_id, fantrax_player_id, seq, occurred_at)
select team_id, fantrax_player_id, seq, occurred_at
  from public.open_nominations
 where holds_slot
on conflict on constraint nomination_slots_pkey do nothing;

-- The Slot constraint has moved, so the one on open_nominations goes. Leaving
-- it would enforce the OLD rule alongside the new one: it is deleted with the
-- board seat, so it would silently permit the second nomination the table
-- above exists to refuse, and would refuse a Commissioner nothing it does not
-- already refuse. One rule, one constraint, one place.
drop index if exists public.open_nominations_team_id_key;

comment on column public.open_nominations.holds_slot is
  'Whether this claim spent the nominating Team''s one Nomination Slot (Story 9.8). Now DESCRIPTIVE only: the constraint it used to drive moved to nomination_slots when FR-9 was amended, because a Slot outlives the board seat this row records. Kept because it states what was true when the nomination was placed, matching core/projection/nominations.ts''s holdsSlot, and because it is what this migration''s backfill read.';
