-- The rookie-scale draft round, persisted end to end. Story 7.8, FR-43.
--
-- FR-43's one exception to Dead Money turns on a fact the app parsed and then
-- threw away. A released Contract normally keeps charging the Cap in full; a
-- SECOND-ROUND rookie-scale deal released with its full term unelapsed is
-- removed instead and its Cap Hit returns to Cap Space. The exception needs
-- BOTH facts -- the draft round AND the unelapsed term -- and only the second
-- of them had a column.
--
-- `adapters/fantrax/roster-file.ts` has captured the round since Story 7.6
-- (`2RK31` -> round 2, five years remaining), but `server/staged-roster-row.ts`
-- hardcoded `rookieScaleRound: null` because neither table could hold it. The
-- designation was therefore gone by the time a Drop could read it, which made
-- the exception unimplementable rather than merely unimplemented.
--
-- **Nullable, on BOTH tables, and `null` means "an ordinary Contract".** Most
-- Contracts are not rookie-scale deals and there is no round to state for
-- them; a `not null` default of `0` would invent a draft round that does not
-- exist. The column travels staging -> promotion -> `team_rosters` so the
-- Drop reads it off the live table it already reads every other roster fact
-- from.
--
-- **The already-imported-rosters hazard.** Every existing row gets `null`,
-- which is indistinguishable from "ordinary Contract" -- so a Team imported
-- before this migration has its `2RK` deals treated as ordinary on a Drop.
-- This migration cannot fix that: the round was discarded at parse time
-- before Story 7.6 and never persisted after it, so there is nothing to
-- backfill FROM. The remedy is a re-import of the affected rosters, which is
-- a Commissioner act and not this migration's business.
--
-- **Unlike the roster slot kind, this column IS widened on the staging table.**
-- Dead Money is produced inside this product and must never be importable;
-- the rookie round is the opposite -- it is read off the Fantrax export and
-- has to survive staging to reach the live table at all.
--
-- `if not exists` on both, so re-running is safe. Applied dev-first (AD-26).
-- Nothing is typed into the Supabase dashboard.

alter table public.import_staged_rosters
  add column if not exists rookie_scale_round integer;

comment on column public.import_staged_rosters.rookie_scale_round is
  'The draft round of a rookie-scale Contract -- 2 for a 2RK31 Contract cell -- or null for an ordinary Contract. Parsed by adapters/fantrax/roster-file.ts and carried through to team_rosters, where FR-43''s Drop exception reads it.';

alter table public.team_rosters
  add column if not exists rookie_scale_round integer;

comment on column public.team_rosters.rookie_scale_round is
  'The draft round of a rookie-scale Contract, or null for an ordinary Contract. FR-43''s one exception to Dead Money turns on BOTH this being 2 AND contract_years_remaining still standing at the full second-round term of 5: such a Contract is REMOVED on a Drop and its Cap Hit returns to Cap Space, while every other released Contract is reclassified dead_money at the amount it was already charging. Null on every row imported before Story 7.8; a re-import is the only way to recover the designation for those.';
