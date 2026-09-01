-- The system actor: `auction_events.manager_id` and `team_id` become nullable,
-- together or not at all. Story 3.7.
--
-- 20260821020000_auction_events.sql:53-58 declared both columns `not null` and
-- said why in as many words: "no system-originated event exists yet that would
-- need to resolve who 'acts' for it; that is deliberately left to whichever
-- story first emits one". This is that story, and this file is where the
-- decision is recorded -- the original migration is NOT edited, because an
-- applied migration is immutable and a comment amended after the fact would
-- describe a schema the file never produced.
--
-- **What emits one.** `ContractAssignmentOpened` (`src/lib/core/rules/phase-end.ts`)
-- is appended when the League Clock expires. Nobody acts: the tick reads a
-- clock and the log says the phase ended. Attributing it to the Commissioner
-- would be worse than leaving it unattributed -- the Audit Log would then read
-- as though the one person AD-14's commit-reveal exists to keep out of the
-- outcome had adjudicated the close of the books. A null pair records honestly
-- that nobody did.
--
-- **The `AuctionTerminated` events beside it are NOT system events.** Each one
-- carries the NOMINATING Manager and Team, off the open nomination it ends,
-- exactly as an `AuctionClosed` carries the winner's. Only the phase-end event
-- itself is unattributed.
--
-- **No backfill, and none is possible or needed.** Relaxing `not null` on an
-- insert-only table (AD-4) cannot invalidate a row that already exists: every
-- historical event carries both ids and still does. This migration widens what
-- MAY be written from here on and rewrites nothing.
--
-- **The pair is constrained to move together.** An event with a Manager and no
-- Team -- or a Team and no Manager -- is neither a Manager's act nor the
-- system's, and there is no third kind of actor in this product. The check
-- makes the half-null row unwritable rather than merely unwritten, so a later
-- story cannot introduce one by omission.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

alter table public.auction_events alter column manager_id drop not null;
alter table public.auction_events alter column team_id drop not null;

alter table public.auction_events
  add constraint auction_events_actor_pair_null_together
  check ((manager_id is null) = (team_id is null));

comment on column public.auction_events.manager_id is
  'The acting Manager, or null for a system-originated event (Story 3.7). Null exactly when team_id is null, enforced by auction_events_actor_pair_null_together.';

comment on column public.auction_events.team_id is
  'The acting Team, or null for a system-originated event (Story 3.7). Null exactly when manager_id is null, enforced by auction_events_actor_pair_null_together.';
