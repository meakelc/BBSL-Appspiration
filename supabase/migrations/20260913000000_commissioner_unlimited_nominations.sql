-- The Commissioner exemption from the one-Nomination-Slot rule, at the data
-- layer. Story 9.8.
--
-- 20260825000000_open_nominations.sql made a second Slot spend by the same
-- Team PHYSICALLY impossible, and that is still the rule for the thirty
-- Managers. It is the wrong rule for the seven Commissioners: Managers do not
-- always spend their Slot promptly, and a Commissioner nominates to keep the
-- number of open Auctions high so the phase FINISHES. One Slot each turns
-- seven administrators into seven more bottlenecks.
--
-- The exemption is expressed as a column, not as a lookup. `holds_slot` says
-- what was true when the nomination was placed, and the unique constraint
-- applies to the rows that claim a Slot and to no others. Reading
-- managers.is_commissioner from here instead would make the constraint
-- retroactive: promoting a Manager mid-auction would silently release a Slot
-- they really had spent. This column matches core/projection/nominations.ts's
-- `holdsSlot`, folded from the NominationPlaced payload, for the same reason
-- and with the same default.
--
-- **The constraint NAME survives the change, and that is load-bearing.**
-- src/lib/server/pg-errors.ts classifies SQLSTATE 23505 by constraint name to
-- choose between the already_nominated and slot_in_use refusals. A unique
-- INDEX reports its own name in that field exactly as a unique CONSTRAINT
-- does, so re-creating `open_nominations_team_id_key` as a partial index keeps
-- the named refusal a named refusal. Renaming it turns one into a 500.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

alter table public.open_nominations
  add column if not exists holds_slot boolean not null default true;

comment on column public.open_nominations.holds_slot is
  'Whether this claim spends the nominating Team''s one Nomination Slot (Story 9.8). True for every Manager nomination and for every row written before this column existed; false for a Commissioner''s, who nominates without limit. The partial unique index below applies to the true rows only.';

-- The whole-table uniqueness goes, and comes straight back narrowed to the
-- rows it was always about. Done in this order deliberately: dropping first
-- means the index below is built against a table with no competing
-- constraint, and `if exists` / `if not exists` make the pair re-runnable.
alter table public.open_nominations
  drop constraint if exists open_nominations_team_id_key;

create unique index if not exists open_nominations_team_id_key
  on public.open_nominations (team_id)
  where holds_slot;

comment on index public.open_nominations_team_id_key is
  'A Team holds ONE Nomination Slot (FR-8) -- over the claims that hold one. Story 9.8 narrowed this from a table-wide unique constraint so a Commissioner may hold several open nominations at once. The NAME is matched by src/lib/server/pg-errors.ts to raise the slot_in_use refusal; do not rename it.';
