-- The append-only auction event log. Story 1.5.
--
-- AD-4: `auction_events` is insert-only. No role holds UPDATE or DELETE on
-- it, not the service role, not the Commissioner. FR-33's audit log is a read
-- of this table, not a second table. Correcting anything appends a
-- compensating event and never mutates history.
--
-- AD-5/AD-6: every event carries a database-assigned monotonic `seq`, folds
-- are ordered by `seq` alone (never `occurred_at` — under the single global
-- write lock a transaction queued on the lock can commit later while holding
-- an earlier timestamp), and `occurred_at` is the shell's captured
-- transaction-start clock read, not a column default: the shell computes it
-- once (`select now()`, which is Postgres' transaction-start timestamp
-- regardless of when within the transaction it is read) and writes the same
-- value onto every event the transaction appends.
--
-- Every row carries `schema_version`, `core_version`, `manager_id` and
-- `team_id` from the first row onward — an insert-only log cannot be
-- backfilled, so these cannot be added later the way an ordinary column
-- could. `device_class`, `dispatch_outcome` and `delivery_outcome` are the
-- measurement fields future stories populate (bid/nomination device class;
-- notification dispatch and delivery outcome) and are nullable because no
-- story populates them yet.
--
-- `event_type`/`payload` are the generic envelope this story's shell needs.
-- No domain event type is named here (`BidPlaced`, etc.) — that is Epic 2's
-- `core/rules`, which does not exist yet. This table has no opinion on what
-- `event_type` values are legal or what shape `payload` takes for any of
-- them; it only guarantees the envelope and the columns every event needs
-- regardless of what it is.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

create table if not exists public.auction_events (
  -- Database-assigned and monotonic — the one order AD-5 requires folds to
  -- use. `identity` rather than a default sequence expression, so nothing
  -- can supply its own value on insert.
  seq bigint generated always as identity primary key,

  -- The shell's single transaction-start clock read, reused for every event
  -- the transaction appends (AD-3). Never a column default: a `default now()`
  -- here would let each row in a multi-event transaction take a distinct
  -- timestamp, which is exactly the drift AD-3 exists to prevent.
  occurred_at timestamptz not null,

  -- AD-20: the schema this row's columns were written under, and the
  -- rules-core version that produced the event. Both are small integers from
  -- `core/constants.ts`, present from the first row so a future migration
  -- never has to backfill them into an insert-only log.
  schema_version integer not null,
  core_version integer not null,

  -- The acting Manager and Team. Not null from the first row onward — no
  -- system-originated event exists yet that would need to resolve who
  -- "acts" for it; that is deliberately left to whichever story first emits
  -- one (see this story's Design Notes), not decided here.
  manager_id uuid not null references public.managers(id),
  team_id uuid not null references public.teams(id),

  -- The generic envelope. What `event_type` values are legal, and what
  -- `payload` holds for each, is Epic 2's `core/rules` to define — this
  -- table only guarantees the envelope every event needs to carry.
  event_type text not null,
  payload jsonb not null,

  -- The measurement fields NFR §5 "Measurability" requires, present as
  -- nullable columns from the first row (an insert-only log cannot be
  -- backfilled) and populated by the stories that emit the events they
  -- describe: device class on bid and nomination events, dispatch and
  -- delivery outcome on notification events.
  device_class text,
  dispatch_outcome text,
  delivery_outcome text,

  constraint auction_events_event_type_not_blank check (length(btrim(event_type)) > 0)
);

comment on table public.auction_events is
  'The insert-only auction event log (AD-4). No role holds UPDATE or DELETE, including service_role. Corrections append a compensating event; history is never mutated.';

-- RLS on, and forced, so the table owner is not silently exempt either —
-- mirrors managers.sql/teams.sql exactly.
alter table public.auction_events enable row level security;
alter table public.auction_events force row level security;

-- No `create policy` statement follows, and that is the design. With RLS
-- enabled and no policy, every row is invisible and unwritable to every role
-- that RLS applies to.

-- Belt as well as braces, as managers.sql/teams.sql already establish: the
-- client-facing roles hold nothing on this table regardless of RLS.
revoke all on table public.auction_events from anon;
revoke all on table public.auction_events from authenticated;

-- The new pattern beyond managers.sql/teams.sql, which never grant
-- service_role write at all: Supabase's default privileges grant service_role
-- ALL on a newly created table (it is meant to be the server's privileged
-- role). An insert-only log needs that narrowed, not merely left alone — so
-- every privilege is revoked first and exactly SELECT and INSERT granted
-- back. UPDATE and DELETE are deliberately absent from the grant, which is
-- the entire content of AC1: no role, including service_role, ever holds
-- them on this table.
revoke all on table public.auction_events from service_role;
grant select, insert on table public.auction_events to service_role;
