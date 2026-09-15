-- A Manager's LOGIN account and their GUILD account need not be the same
-- Discord account. Requested by the Commissioner on 2026-09-14.
--
-- The GSW Manager is a member of the league server as `gauchovic` and signs in
-- through OAuth as `victor_arias7503`. Those are two Discord accounts and so
-- two snowflakes, and `managers.discord_user_id` has until now had to be both:
--
--   * `src/lib/server/supabase.ts` matches it against the OAuth subject, which
--     is the ONLY thing that decides whether a session is a registered
--     Manager. It must hold the login snowflake or they cannot sign in, bid or
--     nominate.
--   * `src/lib/server/outbox.ts` copies it into
--     `notification_outbox.recipient`, which becomes `<@id>` in the message
--     body and an entry in `allowed_mentions.users`. It must hold the GUILD
--     snowflake or Discord cannot resolve the id to a member, and the ping
--     renders as the literal text `@unknown-user`.
--
-- One column cannot be both, so the two jobs are split. This column is the
-- ADDRESS; `discord_user_id` stays the IDENTITY and its meaning is unchanged.
--
-- **Nullable, and NULL is the normal state.** NULL means "address this Manager
-- at `discord_user_id`", which is true of twenty-nine of the thirty rows and
-- of every Manager registered from here on. A `not null` column with a
-- backfill would have made the exception look like the rule and given every
-- future insert a second snowflake to get right. Absence reads as the default,
-- the way `manager_notification_preferences` already does it — the resolution
-- is a `coalesce` at the two read sites and nothing anywhere else.
--
-- **Unique, so two Managers cannot share one ping target.** A nullable unique
-- column permits many NULLs and at most one of each real value, which is
-- exactly the rule wanted. Without it a typo could quietly redirect one
-- Manager's every notice to another Manager, and nothing in the outbox would
-- report it: both rows would look delivered.
--
-- **And it may not collide with any row's `discord_user_id` either** — see the
-- trigger below. The unique index alone does not cover that: the override and
-- the identity live in different columns, so `discord_mention_user_id` could
-- be set to another Manager's login snowflake and both constraints would be
-- satisfied while two Managers again resolved to one address.
--
-- What this does NOT do is change who anyone IS. `managers.id` is the
-- surrogate key every other table points at, `discord_user_id` is untouched,
-- and no session is invalidated by applying this.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

alter table public.managers
  add column if not exists discord_mention_user_id text;

-- Set-but-blank is the one state that would be worse than absent: it addresses
-- nobody, and `coalesce` would return it happily in place of a snowflake that
-- works. NULL or a real value, never the empty string.
alter table public.managers
  drop constraint if exists managers_discord_mention_user_id_not_blank;
alter table public.managers
  add constraint managers_discord_mention_user_id_not_blank
  check (discord_mention_user_id is null or length(btrim(discord_mention_user_id)) > 0);

create unique index if not exists managers_discord_mention_user_id_key
  on public.managers (discord_mention_user_id);

comment on column public.managers.discord_mention_user_id is
  'The guild snowflake to @mention this Manager at, when it differs from the account they sign in with. NULL — the normal case — means address them at discord_user_id. Read ONLY by the notification path (src/lib/server/outbox.ts, via coalesce); never by authentication, which matches discord_user_id and nothing else.';

-- The cross-column guard the unique index cannot express.
--
-- A statement-level trigger over the whole table rather than a row-level one:
-- the check is "does any override equal any identity", which is a question
-- about pairs of rows, and a row-level BEFORE trigger cannot see a conflicting
-- row inserted later in the same statement. Thirty rows makes the cost of
-- re-asking it in full irrelevant, and this table is written by the
-- Commissioner a handful of times a season.
create or replace function public.managers_mention_id_is_not_another_identity()
returns trigger
language plpgsql
as $$
declare
  clash text;
begin
  select m.discord_mention_user_id into clash
  from public.managers m
  where m.discord_mention_user_id is not null
    and exists (
      select 1 from public.managers other
      where other.discord_user_id = m.discord_mention_user_id
        and other.id <> m.id
    )
  limit 1;

  if clash is not null then
    raise exception
      'discord_mention_user_id % is another Manager''s discord_user_id', clash
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

drop trigger if exists managers_mention_id_is_not_another_identity on public.managers;
create constraint trigger managers_mention_id_is_not_another_identity
  after insert or update of discord_user_id, discord_mention_user_id
  on public.managers
  deferrable initially deferred
  for each row
  execute function public.managers_mention_id_is_not_another_identity();

-- A Manager whose override equals their OWN `discord_user_id` is allowed and
-- means nothing: it resolves to the same address NULL would have. It is not
-- worth a constraint to forbid, and forbidding it would make an idempotent
-- "set the address to X" script fail on the row it had already set.
