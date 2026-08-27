---
title: 'Story 2.4: The Auction page'
type: 'feature'
created: '2026-08-26'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'a96c79f358fb479af10160f63baaf7943cfa18a3'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `destinations.ts:77` advertises `/auction`, but no such route exists — a nominated Player has no page. Epic 2's remaining stories all need one surface to attach to, and nothing today renders a single Auction's identity, state or history.

**Approach:** A read-only Auction page at the repo's first dynamic segment, sourced entirely from the existing nomination fold and `free_agent_players`. It renders what is real now — Player identity, the nominating Team, an honest "no bids yet" price and an empty history region — and structurally reserves nothing for later. The bid control is **not** built here: `core/rules/bidding` does not exist, so a pre-filled minimum legal Bid and per-cause disabled wording would be invented figures. That half moves to Story 2.5.

## Boundaries & Constraints

**Always:** State comes from folding `auction_events` through `nominationsReducer` — the same accessor path (`nominationForPlayer`) every other gate uses. Player reference fields come from `free_agent_players` and nothing else. Time appears **twice**, relative and absolute in the viewer's timezone, and the absolute is never dropped to save space. A three-letter capitalised abbreviation means the real-life NBA team only; the fantasy Team is spelled out with its acting Manager attached. Single-column at 375px, ≥44×44px on any interactive target, readable in greyscale, dark tokens only. An unknown or un-nominated Player is a 404, not an empty page.

**Ask First:** Any write path, command, event or migration. Any read of `open_nominations`. Any figure not present in the fold or the reference table. Any new design token. Changing the route's URL shape once written — Epic 4's Bid Board will link to it.

**Never:** No bid control, no amount input, no submit button, no minimum-legal-Bid figure, no `maximumBid`, no disabled-reason wording — all of that is Story 2.5/2.6/2.7 and would be fabricated here. **No control to cancel, edit or lower a Bid — absent, not disabled.** No suggested amount, no recommended bid, no countdown pressure. No close timestamp, no auction clock, no "time remaining" — no close exists to count to. No salary or contract-length field in the metadata line — the columns do not exist for a Free Agent. No anonymity anywhere. No hand-edit of `planning-artifacts/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Open Auction | `NominationPlaced`(P, team A) folded | Page renders P's name, `NBA · POS`, nominating Team spelled out with Manager, "No bids yet" | N/A |
| Metadata line | P has `nba_team`/`positions` | Renders `NBA · POS` — exactly two fields, no salary, no contract length | N/A |
| Missing reference row | P in the fold, absent from `free_agent_players` | Player name from the fold renders; metadata line omitted entirely, not blanked | No throw |
| Empty history | No `BidPlaced` event exists | History region renders with an explicit "no bids" sentence, not an empty box | N/A |
| Time rendered twice | Nomination `occurredAt` | Both a relative phrase and an absolute viewer-timezone stamp; neither omitted | N/A |
| Closed / never nominated | `AuctionClosed`(P) folded, or P never nominated | 404 | `error(404, ...)` |
| Unknown player id | Id matching nothing anywhere | 404 | `error(404, ...)` |
| Wrong phase | Phase is not the live Auction Phase | 403 through the existing destination gate | `error(403, ...)` |
| Signed out | No registered session | Whatever `requireLiveDestination` already does for `auction` | Existing behaviour |
| No cancel control | Page source inspected | No cancel/edit/lower control present at all | N/A |

</frozen-after-approval>

## Code Map

Story 2.1's and 2.3's Code Maps carry the fold discipline and route idiom reused here. Nothing in this story touches `src/lib/core/rules/` or writes anything.

- `src/routes/auction/[fantraxPlayerId]/+page.server.ts` -- new, the story's load. **First dynamic segment in the repo** (task-0 confirmed zero `[...]` routes exist). Mirror `nominate/+page.server.ts:70-82`: `requireLiveDestination(locals.session, locals.phase.name, 'auction')` (`destinations.ts:136-144`, id already declared at `:77`) first, then a new server reader, then `return { phase: locals.phase, auction }`. **`load` only — no `actions` export.**
- `src/lib/server/auction-page.ts` -- new. `loadAuctionPage(gateway, fantraxPlayerId)`: `loadEventsViaClient` (`event-log.ts:123-126`) → `fold(INITIAL_NOMINATIONS, events, nominationsReducer)` (`fold.ts:40-53`) → `nominationForPlayer` (`nominations.ts:124-130`). Null ⇒ caller 404s. Then one `select fantrax_player_id, player_name, positions, nba_team from free_agent_players where fantrax_player_id = $1` — reference columns per `20260824020000_live_reference_tables.sql:94-125`; **there is no salary or contract column on this table.** Manager name joins from `managers`/`teams` the way `auction-open.ts:93-98` does. Reached via `writeGateway()` (`shell/db.ts:59-63`) like every other route.
- `src/routes/auction/[fantraxPlayerId]/+page.svelte` -- new. Svelte 5 runes (`$props`/`$derived`), structurally re-declared page types, never importing server types — the rule stated at `nominate/+page.svelte:25-27,30-55`. Tokens only, from `src/lib/styles/tokens.css:19-58`; responsive card pattern at `nominate/+page.svelte:368`.
- `src/lib/core/instant.ts` -- new, tiny, pure. Relative-phrase derivation from two ISO instants, injected `now`, no clock read (AD-3). Absolute rendering stays in the component via `Intl.DateTimeFormat` on the viewer's timezone. **This file was named and deferred by Story 2.3's split** (`deferred-work.md:228-233`) — check that entry before designing it.
- `src/lib/core/team-identity.ts` -- read-only, reuse. Already owns "spell the fantasy Team out with its Manager"; do not re-implement.
- `src/lib/core/money.ts` -- read-only. `formatMoney` (`:169-187`) is the only legal renderer if any figure appears. No figure should.
- `tests/routes/auction-page.test.ts` -- new. Source-text assertions in the established pattern (`signin-surface.test.ts:29-36` states why rendering is impossible; `structure.test.ts:145-187` is the regex idiom). Absence claims — no bid input, no cancel/edit/lower control, no "time remaining" — are provable here and are the point.
- `tests/server/auction-page.test.ts` -- new. `loadAuctionPage` against the fake gateway harness (`tests/server/nomination.test.ts:45-175`, which throws on unrecognised SQL — add a label).
- `tests/core/instant.test.ts` -- new. Pure, state-literal, injected `now`.
- `tests/structure.test.ts` -- extend. Register the new route in the AR-2 expectations if the existing shape requires it; do **not** loosen an assertion to pass.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/instant.ts` -- pure relative-phrase helper, injected `now` -- AC3
- [x] `src/lib/server/auction-page.ts` -- fold + reference read, returns null for no open nomination -- AC1, AC4
- [x] `src/routes/auction/[fantraxPlayerId]/+page.server.ts` -- gate, load, 404 on null -- AC1, AC4
- [x] `src/routes/auction/[fantraxPlayerId]/+page.svelte` -- the surface -- AC1, AC2, AC3, AC5
- [x] `tests/core/instant.test.ts` -- the helper -- AC3
- [x] `tests/server/auction-page.test.ts` -- the reader, covers the I/O matrix -- AC1, AC4
- [x] `tests/routes/auction-page.test.ts` -- surface and absence claims -- AC2, AC5
- [x] `tests/structure.test.ts` -- extend for the new route -- AC5 -- **not required**: the existing AR-2 and route expectations (`structure.test.ts:15-47`) enumerate fixed directories and files and none of them constrain a new dynamic route, so registering it would have meant inventing an assertion rather than satisfying one. The task's own wording ("if the existing shape requires it") gates on exactly this.

**Acceptance Criteria:**
- Given an open Auction, when a Manager opens its page, then Player identity, the metadata line, the nominating Team spelled out with its acting Manager, and an explicit no-bids price all render from folded state and reference data — no figure is derived or invented.
- Given the page source, when it is inspected, then it contains no bid input, no submit control, no minimum-bid or `maximumBid` figure, no disabled-reason wording, and **no control to cancel, edit or lower a Bid at all**.
- Given the nomination timestamp, when the page renders, then the time appears twice — a relative phrase and an absolute stamp in the viewer's timezone — with the absolute never omitted, and the relative phrase computed by a pure helper taking `now` as an argument.
- Given a Player who was never nominated, whose Auction has closed, or who does not exist, when the page is requested, then it 404s rather than rendering an empty Auction.
- Given the page at 375px, when it renders, then it is single-column, every interactive target is ≥44×44px, it uses only existing dark tokens, and it carries no state conveyed by colour alone.

## Design Notes

**Why the bid control is out.** `evaluate()`/`decide()` for bidding do not exist — task-1 confirmed no `BidPlaced` event, no Auction entity, no `core/rules/bidding`, nothing Bid-related in `src/` beyond CSS variable names and one static caption. `epic-2-context.md:57` says it directly: build the rules before the surface, or the page invents figures. A pre-filled "minimum legal Bid" here would be a number with no rule behind it — the exact failure the refusal design exists to prevent.

**Why an Auction is a nomination.** Until Epic 3 closes anything, "open Auction" and "open Nomination" are the same row of the same fold. Reading `nominationForPlayer` rather than inventing an auction projection means Story 2.5 adds bids to a page that already exists, and Story 3.4's close makes it 404 with no change here.

## Verification

**Commands:**
- `npm test` -- all pass. Baseline is 1231 passed / 1 failed, the failure being the pre-existing `SUPABASE_DB_URL is not set` integration case (`deferred-work.md:224-226`) — it must not grow.
- `npm run check` -- 0 errors, 0 warnings.
- `npm run check:purity` -- clean; `core/instant.ts` reads no clock and imports nothing outside the stdlib.

**Manual checks (if no CLI):**
- `rg -n "maximumBid|minimum legal|cancel|lower" src/routes/auction/ src/lib/server/auction-page.ts src/lib/core/instant.ts` returns nothing. The route directory alone is too narrow: the story's forbidden vocabulary could leak just as easily into the server reader or the pure helper, neither of which lives under `src/routes/auction/`, and the automated test already covers the wider surface.
- `git diff` touches nothing under `src/lib/core/rules/`, adds no migration, and adds no `actions` export.

### Review Findings

- [x] [Review][Patch] Absolute stamp is SSR'd in the *server's* timezone, not the viewer's — `+page.svelte:49-53` builds `Intl.DateTimeFormat(undefined, ...)` and `$derived`s the stamp. No route in `src/` opts out of SSR, so the HTML first delivered resolves `undefined` to the server's timezone; the viewer's timezone only applies once hydration re-derives it, and Svelte 5 does not diff-correct hydrated text. AC3 asks for "an absolute stamp in the viewer's timezone" while Boundaries/Always forbids ever dropping it, so the two obvious fixes trade against each other: render it client-only (correct timezone, momentarily absent in SSR HTML) or pin an explicit `timeZone` server-side (always present, not the viewer's).
- [x] [Review][Patch] An unresolvable Manager renders as a fabricated name — `auction-page.ts:146-151` falls back to `nomination.teamName` as the Manager display name, so `formatTeamManager` emits `Lakers — Lakers`, which reads as a Manager literally named "Lakers"; the story's own test asserts that string. Boundaries/Ask First forbids "any figure not present in the fold or the reference table". `formatTeamManager` already has a stated shape for an absent pairing (`teamName === null` drops the em dash) but no shape for "Team known, Manager unknown". Compounding it, the Code Map says the Manager "joins from `managers`/`teams` the way `auction-open.ts:93-98` does" — a `teams left join managers` — whereas the code scans the `NominationPlaced` payload (`findNominationManagerId`, `:80-95`) then point-reads `managers`; `AppendedEvent.managerId` (`core/types.ts:89`) already carries the same id on the envelope, making the payload scan a third source for a field the loaded events expose directly.
- [x] [Review][Patch] `core/instant.ts` duplicates `league-clock.ts`'s instant math rather than sharing it — `daysFromCivil`, `civilFromDays` and `parseInstant` now exist twice, verbatim, and can silently drift on a fix applied to one. The header's stated reason (`instant.ts:7-13`, "check:purity's own verification for this story requires this file to import nothing outside the stdlib") does not hold: the gate forbids imports *outside* the core, and `core/instant.ts` importing `core/projection/league-clock.ts` is a relative `.ts` core import the gate allows. The real obstacle is only that those three helpers are module-private in `league-clock.ts` (`:176`, `:186`, `:209`). Story 2.3's deferred note called this an *extraction*, which is what a shared module would have been.
- [x] [Review][Patch] Route tests never execute `load` — gate ordering, the 403 rows and the 404 row are unverified [tests/routes/auction-page.test.ts:114-140]
- [x] [Review][Patch] Player name never comes from `free_agent_players` — the Code Map's own query names `player_name` and Boundaries/Always says reference fields come from that table and nothing else [src/lib/server/auction-page.ts:125-138]
- [x] [Review][Patch] Missing reference row still renders a labelled, bordered, empty "Player" panel — the matrix says omitted entirely, not blanked [src/routes/auction/[fantraxPlayerId]/+page.svelte:71-83]
- [x] [Review][Patch] `Intl.DateTimeFormat.format` throws `RangeError` on an unparseable instant while `relativePhrase` beside it deliberately degrades — and `instant.ts`'s own docstring justifies not throwing on the grounds that the absolute stamp renders regardless [src/routes/auction/[fantraxPlayerId]/+page.svelte:53]
- [x] [Review][Patch] AC5 is claimed as covered by a test file that asserts nothing about 375px single-column, ≥44×44px targets, dark-token-only styling or greyscale [tests/routes/auction-page.test.ts]
- [x] [Review][Patch] The Verification section's manual `rg` scopes only `src/routes/auction/`, narrower than the surface the story added and narrower than the automated test's own coverage [_bmad-output/implementation-artifacts/spec-2-4-the-auction-page.md:88]
- [x] [Review][Defer] `sprint-status.yaml` key still reads `2-4-the-auction-page-and-its-bid-control` after the bid control moved to Story 2.5 [_bmad-output/implementation-artifacts/sprint-status.yaml:56] — deferred, pre-existing
- [x] [Review][Defer] The relative phrase never refreshes — `nowIso` is read once at render with no interval or invalidation, so "moments ago" silently ages on a long-open tab [src/routes/auction/[fantraxPlayerId]/+page.svelte:46] — deferred, pre-existing
