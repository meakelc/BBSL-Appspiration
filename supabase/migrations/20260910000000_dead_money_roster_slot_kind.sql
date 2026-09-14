-- Dead Money: the fourth roster slot kind, on the LIVE table only. Story 7.6.
--
-- A released Contract does not stop charging the Cap. FR-43 keeps the money
-- on the Team that committed it, as Dead Money: charged in full, occupying no
-- Roster Slot, bounded by no ceiling. `team_rosters` is where such a row
-- lives, and its check constraint admitted exactly three kinds, so until this
-- migration the schema itself forbade the state the rule requires.
--
-- **`import_staged_rosters` is deliberately NOT widened, and the asymmetry is
-- the feature.** Dead Money is produced by an act inside this product -- a
-- Commissioner Drop -- and never read off a Fantrax export. The staging
-- table's own three-value check is therefore the database backstop under the
-- adapter's content-altitude refusal: an import file whose Status somehow
-- mapped to Dead Money is refused by `adapters/fantrax/roster-file.ts` first,
-- and by `import_staged_rosters_roster_slot_kind_check` if it ever were not.
-- Widening both constraints would make Dead Money importable and remove the
-- backstop. `src/lib/server/staged-roster-row.ts`'s `KNOWN_SLOT_KINDS` stays
-- at three for the identical reason.
--
-- Postgres cannot alter a check constraint in place and this repository has
-- no precedent for trying, so the constraint is dropped and recreated under
-- the same name. Re-running the migration is safe: the `drop` carries
-- `if exists`, and the `add` that follows it therefore always finds the name
-- free. The `add` is deliberately UNGUARDED -- an `add constraint` that
-- silently skipped an existing constraint would leave a stale three-value
-- check in place and report success.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

alter table public.team_rosters
  drop constraint if exists team_rosters_roster_slot_kind_check;

alter table public.team_rosters
  add constraint team_rosters_roster_slot_kind_check
    check (roster_slot_kind in ('active_bench', 'injury_reserve', 'minor_league', 'dead_money'));

comment on column public.team_rosters.roster_slot_kind is
  'One of active_bench, injury_reserve, minor_league, dead_money. Dead Money is a released Contract that keeps charging the Cap IN FULL (core/rules/roster-import.ts''s chargedCapHit zeroes minor_league alone) while occupying no Roster Slot and answering to no ceiling. It is never importable: import_staged_rosters admits three kinds only.';
