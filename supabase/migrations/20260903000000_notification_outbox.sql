-- The transactional outbox: one delivery INTENT per (event, channel,
-- recipient), inserted by the same transaction that appends the event it
-- describes. Story 5.1, AD-17.
--
-- AD-17: "the transaction that appends events also inserts delivery intents. A
-- separate dispatcher drains the outbox with retry and backoff, inside the same
-- tick as the sweep (AD-10). Delivery never runs inside the auction transaction
-- and can never fail it. The idempotency key is (event seq, channel,
-- recipient)". That key is the `unique` constraint below and nothing else --
-- keying on the event alone would deduplicate the SECOND co-manager's mention,
-- and FR-27 requires both Managers of a co-managed Team receive every
-- team-affecting notice (SM-3 targets 100%). A co-managed Team therefore yields
-- two rows for one event, which is the whole reason `recipient` is in the key.
--
-- **INSERT-ONLY, like the log it points at, and that is why no delivery state
-- lives here.** Every table in this schema either grants `service_role`
-- nothing (`20260828000000_contention_seeds.sql`) or grants it exactly what it
-- needs; NONE grants `update` or `delete`, and this one does not either. So
-- there is no `dispatched_at`, no `attempts` column and no `delivered` flag to
-- toggle: a row here says only that a notice is OWED. Whether it has been sent
-- is re-derived from `NotificationDispatched` events in `auction_events`, which
-- is the same "re-derives, never remembers" discipline `src/lib/server/sweep.ts`
-- already states for the sweep -- and it makes restart-safety structural rather
-- than something a test has to catch.
--
-- It also satisfies NFR §5's measurability for free. `auction_events`
-- (`20260821020000_auction_events.sql:71-73`) carries `dispatch_outcome` and
-- `delivery_outcome` as nullable columns for exactly this, and `service_role`
-- holds `select, insert` there and nothing more -- so those columns can never
-- be back-filled onto an existing row. The dispatcher populates them on its OWN
-- appended event instead, which is the only place an insert-only log can put
-- them.
--
-- **The intent is not a queue message and pgmq is not used.** pgmq is not
-- installed, and every extension in this repo is justified in the migration
-- that adds it. Decisively: the AD's key is a declarative `unique (event_seq,
-- channel, recipient)`, which a table expresses and a visibility-timeout lease
-- cannot. AD-17's contract holds unchanged either way.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

create table if not exists public.notification_outbox (
  -- A surrogate key so a row has an identity of its own; the BUSINESS key is
  -- the unique constraint below. `identity` rather than a default sequence
  -- expression, so nothing can supply its own value on insert --
  -- `auction_events.seq`'s discipline.
  id bigint generated always as identity primary key,

  -- The event this notice is about. A real foreign key, so an intent can never
  -- outlive or precede the event it describes: the insert happens inside the
  -- appending transaction, after the event's own INSERT returned its `seq`, and
  -- a rejected write rolls both back together.
  event_seq bigint not null references public.auction_events(seq),

  -- The transport. `discord` is the only value today (AD-18 -- "Discord is the
  -- only notification transport"), and the column is deliberately not an enum
  -- or a check-constrained list: AD-17's own note names web push as the second
  -- transport this seam exists to accept, and a new channel should be a new
  -- adapter rather than a migration on a live auction.
  channel text not null,

  -- Who the notice is FOR, in whatever identifier that channel addresses. For
  -- Discord that is `managers.discord_user_id` -- the snowflake AD-18's
  -- @mention payload needs -- copied rather than joined, because the intent
  -- records who was owed a notice at the moment the event happened and must not
  -- silently re-target if the registry changes afterwards.
  recipient text not null,

  -- The appending transaction's own clock (AD-3), copied from the event's
  -- `occurred_at`. Never `default now()`: a second clock read could disagree
  -- with the event this row belongs to, which is the exact drift AD-3 exists to
  -- prevent, and `auction_contention_seeds.created_at` already sets this
  -- precedent.
  created_at timestamptz not null,

  -- **AD-17's idempotency key, declared.** The dispatcher's derived pending set
  -- stops a re-dispatch; this stops a duplicate INTENT, which is the half a
  -- retried transaction could otherwise create.
  constraint notification_outbox_intent_key unique (event_seq, channel, recipient),

  -- A blank channel names no transport and a blank recipient addresses nobody;
  -- either would be a row the dispatcher could only ever fail on, forever.
  constraint notification_outbox_channel_not_blank check (length(btrim(channel)) > 0),
  constraint notification_outbox_recipient_not_blank check (length(btrim(recipient)) > 0)
);

comment on table public.notification_outbox is
  'Delivery intents, inserted inside the transaction that appends the event they describe (AD-17). INSERT-ONLY: no role holds UPDATE or DELETE, so no delivery state is stored here. Whether an intent has been delivered is re-derived from NotificationDispatched events in auction_events, which also carry NFR §5''s dispatch_outcome and delivery_outcome. The idempotency key is the unique (event_seq, channel, recipient) constraint — recipient is in the key so a co-managed Team''s second Manager is never deduplicated away (FR-27).';

comment on column public.notification_outbox.recipient is
  'The channel''s own address for the Manager owed this notice — managers.discord_user_id for the discord channel. Copied at insert, never joined at dispatch.';

-- **An index on `auction_events.event_type`, which this story is the first to
-- need.** `src/lib/server/outbox.ts`'s drain answers "has this intent already
-- been delivered?" by reading every `NotificationDispatched` row -- `select
-- occurred_at, payload, delivery_outcome from auction_events where event_type =
-- $1` -- and the tick runs that every ten seconds, forever. Without an index
-- that is a sequential scan of the whole append-only log on every pass, and the
-- log only ever grows: the one read that must stay cheap for the life of the
-- auction is the one read that would degrade fastest.
--
-- It lands here rather than in 20260821020000_auction_events.sql because that
-- migration is applied and immutable (AD-26), and because no reader filtered on
-- event_type before this one -- every fold reads the whole log by `seq` and
-- discriminates in TypeScript. `create index if not exists`, following
-- 20260831000000_tick.sql:115-116.
create index if not exists auction_events_event_type_idx
  on public.auction_events (event_type);

-- RLS on, and forced, so the table owner is not silently exempt either --
-- auction_events.sql/managers.sql/contention_seeds.sql, unchanged.
alter table public.notification_outbox enable row level security;
alter table public.notification_outbox force row level security;

-- No `create policy` statement follows, and that is the design. With RLS
-- enabled and no policy, every row is invisible and unwritable to every role
-- RLS applies to. A Manager must not be able to read who the league is about to
-- be notified about, which is a read of the auction's state by another name.

-- Belt as well as braces, as every table before this one establishes: the
-- client-facing roles hold nothing regardless of RLS.
revoke all on table public.notification_outbox from anon;
revoke all on table public.notification_outbox from authenticated;

-- ...and `service_role`'s default `ALL` is revoked and narrowed to exactly
-- SELECT and INSERT, `auction_events`' pattern and for its reason. UPDATE and
-- DELETE are deliberately absent: a dispatcher that could mark a row done, or
-- delete a drained one, would be storing delivery state here instead of
-- deriving it from the log — and the first thing it would lose is the ability
-- to answer "was this actually delivered?" after a crash.
revoke all on table public.notification_outbox from service_role;
grant select, insert on table public.notification_outbox to service_role;
