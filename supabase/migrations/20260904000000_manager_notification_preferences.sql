-- What a Manager has asked NOT to be mentioned on: one row per Manager, one
-- mute column. Story 5.4, FR-27, AD-18.
--
-- **This is the first thing in the schema a MANAGER decides about themselves,
-- and that is why it is a table rather than a column on `managers`.**
-- `20260821000000_managers.sql:45-46` states that `public.managers` is "Written
-- by the Commissioner only", and that sentence is load-bearing: it is what
-- makes "who may change a Manager's Team, name or Commissioner flag?" have one
-- answer. Adding a Manager-settable column there would quietly make it false. A
-- separate table keeps the statement true, and the left join in
-- `src/lib/server/outbox.ts`'s `MANAGER_NAMES_SQL` makes an ABSENT row mean not
-- muted, so no backfill is needed and a Manager who has never opened the
-- settings page is in exactly the state the default describes.
--
-- **Exactly one mute column, and adding a second is a product decision rather
-- than a migration.** `src/lib/core/notification-categories.ts` names all five
-- mention categories and states why `slot_release` is the only one that is
-- mutable: an outbid notice muted would undermine the fairness premise of a
-- 24/7 clock, a close reports an outcome the Team is bound by, a draw is
-- resolved without a further Bid, and Contract Assignment is announced once to
-- the whole league. The refusal for a request naming any other category is
-- worded in that module and enforced in the route, not merely omitted from the
-- page.
--
-- **UPDATE-IN-PLACE, which is the second place in this schema that departs from
-- the pattern every other table follows.** The first says so itself:
-- `20260902000000_watermark.sql:87,113-114` calls itself "the one place in this
-- schema that departs from the pattern every other table follows". This is the
-- second, and for a different reason than the watermark's. A preference is not
-- an event and is not derived from the log: it is the current answer to a
-- question the owner alone asks, it has no history anybody reads (this story
-- adds no audit event for a preference change and no Commissioner view of who
-- has muted what), and the drain needs the answer as a single row it can join
-- rather than as a fold. So the write is an `on conflict (manager_id) do
-- update` — `src/lib/server/roster-import.ts:321` and
-- `src/lib/server/pool-import.ts:245` are the existing precedents for that
-- idiom — and `service_role` therefore holds UPDATE here where it holds none on
-- `notification_outbox`.
--
-- **What a mute does NOT do.** It withholds the `<@id>`, never the post. The
-- broadcast notice still posts to the league channel, still names the Team and
-- still states what happened; suppression happens at composition
-- (`src/lib/adapters/discord/mention.ts`) and never at enqueue, so the intent is
-- still filed and still recorded as dispatched. That is deliberate: NFR11's
-- measurement can then distinguish a MUTED notice from a FAILED one, which
-- enqueue-time suppression — leaving no row at all — could not.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

create table if not exists public.manager_notification_preferences (
  -- The Manager, and the whole key. One row per Manager, so "what has this
  -- Manager muted?" has exactly one answer and the drain's join is a lookup
  -- rather than an aggregate. `on delete cascade` because a preference about a
  -- Manager who no longer exists is not a fact about anything.
  manager_id uuid primary key references public.managers (id) on delete cascade,

  -- The one mutable category, `notification-categories.ts`'s
  -- `MUTABLE_NOTIFICATION_CATEGORY`. `default false` and `not null` together
  -- are what make ABSENCE and FALSE read the same: a Manager with no row reads
  -- as not muted through the left join, and a Manager with a row and no
  -- opinion reads the same way.
  slot_release_muted boolean not null default false
);

comment on table public.manager_notification_preferences is
  'What a Manager has asked not to be @mentioned on (Story 5.4, FR-27). One row per Manager, written by that Manager alone -- the first Manager-owned row in this schema, which is why it is not a column on public.managers (documented there as Commissioner-written only). UPDATE-IN-PLACE, the second table in this schema to depart from the append-only pattern: a preference is the current answer to a question with no history anybody reads, so the write is an on conflict do update rather than a fold of events. An ABSENT row means not muted; src/lib/server/outbox.ts left-joins this table so no backfill is ever needed.';

comment on column public.manager_notification_preferences.slot_release_muted is
  'True when this Manager has asked not to be mentioned on the notice that a close released the Nomination Slot their Team was holding -- the one mutable category in src/lib/core/notification-categories.ts. It withholds the <@id> and nothing else: the broadcast notice still posts, still names the Team and still states what happened.';

-- RLS on, and forced, so the table owner is not silently exempt either --
-- managers.sql/auction_events.sql/notification_outbox.sql, unchanged.
alter table public.manager_notification_preferences enable row level security;
alter table public.manager_notification_preferences force row level security;

-- No `create policy` statement follows, and that is the design. With RLS
-- enabled and no policy, every row is invisible and unwritable to every role
-- RLS applies to. A Manager changes their own preference through a SvelteKit
-- form action running as `service_role`, which resolves the actor server-side
-- from the session (AD-4/AD-15) -- never from a form field, and never from the
-- browser's own credentials. A permissive policy here would be the point at
-- which one Manager could read, or set, another's.
--
-- Belt as well as braces, as every table before this one establishes: the
-- client-facing roles hold nothing regardless of RLS.
revoke all on table public.manager_notification_preferences from anon;
revoke all on table public.manager_notification_preferences from authenticated;

-- ...and `service_role`'s default `ALL` is revoked and narrowed to exactly what
-- this story needs: SELECT for the settings page and the drain's left join,
-- INSERT and UPDATE for the one upsert. DELETE is deliberately absent --
-- unmuting is `slot_release_muted = false`, which is a value and not the
-- absence of a row, and a delete path would give the same state two spellings.
revoke all on table public.manager_notification_preferences from service_role;
grant select, insert, update on table public.manager_notification_preferences to service_role;
