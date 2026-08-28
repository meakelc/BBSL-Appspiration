-- The sealed lottery seed table: AD-14's "stored outside the league-readable
-- event log, in a table no manager-facing role can read". Story 3.2.
--
-- When a Minimum-Bid Contention opens, src/lib/server/bidding.ts generates a
-- 32-byte seed, hands it to the pure core's decide(), and the core publishes
-- ONLY hash(seed) on the opening BidPlaced payload. The raw seed lands here,
-- in the same transaction as the event, and never enters auction_events and
-- never leaves the server. Story 3.6's draw is the first and only reader, and
-- the reveal is what finally puts the seed in the log.
--
-- > The builder of this app is also the commissioner and a competing manager.
-- > This AD is what makes that acceptable, and it fails completely if the seed
-- > is readable before the draw.  (AD-14)
--
-- **This table grants service_role NOTHING, which no other table in this
-- schema does, and that is the entire security property.** Every existing
-- table revokes the client-facing roles and then grants service_role what it
-- needs -- auction_events gets SELECT and INSERT
-- (20260821020000_auction_events.sql:103-104), open_nominations gets SELECT,
-- INSERT and DELETE (20260825000000_open_nominations.sql:89-90). This one
-- grants nobody anything: with RLS forced and no policy, the sole reachable
-- identity is the direct Postgres connection src/lib/shell/db.ts:35-50 opens
-- from SUPABASE_DB_URL, which is the one path a browser can never travel and
-- the one src/lib/shell/write.ts already inserts through.
--
-- AD-14 says the seed must be unreadable by every manager-facing role, the
-- Commissioner's included. The Commissioner is an application FLAG --
-- managers.is_commissioner (20260821010000_teams.sql:67) -- and never a
-- database role, so there is no separate role to deny. Denying every role is
-- therefore the only assertion that means what the AD says, and
-- tests/integration/auction-events.test.ts asserts exactly that against real
-- Postgres: anon, authenticated AND service_role each hold zero grants here.
--
-- Written by exactly one path: src/lib/server/bidding.ts's recordContentionSeed,
-- through runTransactionalWrite's projection seam (AD-5) -- the one hook that
-- persists INSIDE the appending transaction. The seed row and the opening
-- BidPlaced event therefore commit together or roll back together, and a
-- contention whose seed was never stored is unreachable by construction.
--
-- Applied dev-first (AD-26). Nothing is typed into the Supabase dashboard.

create table if not exists public.auction_contention_seeds (
  -- One seed per Minimum-Bid Contention, and a contention is one Player's
  -- Auction. The primary key IS that rule: a second opening for the same
  -- Player while the first is unresolved cannot write a second seed and
  -- quietly invalidate the published commitment.
  fantrax_player_id text primary key,

  -- The seed itself, exactly as the shell generated it -- 32 random bytes as
  -- lowercase hex. Text rather than bytea so the value a Manager verifies at
  -- reveal is byte-for-byte the string hash() was computed over, with no
  -- encoding step between the two that could differ per runtime.
  seed text not null,

  -- When the contention opened: the appending transaction's own clock (AD-3),
  -- copied from the BidPlaced event's occurred_at. Never now() -- a second
  -- clock read could disagree with the event this row belongs to.
  created_at timestamptz not null
);

comment on table public.auction_contention_seeds is
  'Minimum-Bid Contention seeds (Story 3.2, AD-14). Sealed: no Postgres role holds any privilege here, so the only reachable identity is the direct SUPABASE_DB_URL connection. Only hash(seed) is ever published, on the opening BidPlaced payload. Story 3.6 reveals the seed at the draw; nothing reads this table before then.';

comment on column public.auction_contention_seeds.seed is
  'The raw seed. Never appears in auction_events and never leaves the server before the draw.';

alter table public.auction_contention_seeds enable row level security;
alter table public.auction_contention_seeds force row level security;

-- No `create policy` statement follows, and that is the design: RLS enabled
-- with no policy makes every row invisible and unwritable to every role RLS
-- applies to. Reached only through the direct Postgres connection
-- (SUPABASE_DB_URL / src/lib/shell/db.ts).

-- Belt as well as braces, as every table before this one establishes: the
-- client-facing roles hold nothing regardless of RLS.
revoke all on table public.auction_contention_seeds from anon;
revoke all on table public.auction_contention_seeds from authenticated;

-- ...and service_role holds nothing either, with NO grant back. This is the
-- line that makes this table different from every other one in the schema.
-- Supabase's default privileges grant service_role ALL on a newly created
-- table; leaving that alone -- or narrowing it to SELECT, as a "the server
-- needs to read its own seeds" instinct would -- would put the seed behind
-- the same key that serves the whole application, and AD-14 fails completely
-- if the seed is readable before the draw. The seed is written by the direct
-- connection and read by the direct connection, and by nothing else.
revoke all on table public.auction_contention_seeds from service_role;
