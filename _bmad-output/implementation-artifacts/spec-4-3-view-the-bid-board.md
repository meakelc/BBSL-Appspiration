---
title: 'Story 4.3: View the Bid Board'
type: 'feature'
created: '2026-09-01'
status: 'in-review'
baseline_commit: '805ed496c340675d68dad072924c117d27203f89'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-BBSL-Appspiration-2026-08-16/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `/board` is a live destination in both the Auction and Archived catalogs (`destinations.ts:76,93`) with no route behind it. A Manager can reach exactly one Auction at a time — by knowing its Player id — and has no way to see what is on the board, what is closing, or where they stand. `deferred-work.md:179,237` both park work here.

**Approach:** One scrollable list of every open Auction, each card carrying Player identity, price, Leading Bidder, Auction state, viewer-relative state and time shown twice. Sorting and filtering are view state computed in the browser over a list the server transports as facts; every word and every ordering rule is worded in `src/lib/core/board.ts` so the `.svelte` file states nothing of its own.

## Boundaries & Constraints

**Always:**
- Three Auction states only: **Awaiting Opening Bid**, **Open**, **Minimum-Bid Contention**. These are the three `ContentionState` members (`auctions.ts:115`) and the whole of what the projection can answer.
- Four viewer-relative states: **You lead**, **Outbid**, **Contender**, **Not involved**. Every chip carries an icon **and** a word (`DESIGN.md:175`); `attention` marks Outbid and nothing else in the system; the 3px `lottery` left bar marks Minimum-Bid Contention and nothing else.
- Time twice: relative via `closesInPhrase` / `relativePhrase` (`auctions.ts:850`, `instant.ts:173`), absolute in the viewer's timezone derived **only inside `$effect`** — the SSR-leak rule `auction/[fantraxPlayerId]/+page.svelte:550-589` already establishes.
- The countdown is derived from the server-authoritative `closesAt`, never from client clock arithmetic against page load, and is exempt from freshness.
- Sorting and filtering are view state and never change a figure. A filtered view is visibly filtered and states its own count.
- The route calls `requireLiveDestination(...)` **first** in `load`, as `nominate/+page.server.ts:71` and `auction/[fantraxPlayerId]/+page.server.ts:80` do. Destination id is `'bid-board'`.
- One transaction, one `loadEventsViaClient`, always `rollback` — `server/auction-page.ts:465-675`'s discipline exactly.
- Money renders through `formatMoney` (`money.ts:169`) only. Fantasy Teams are spelled out with their Manager via `formatTeamManager` (`team-identity.ts:36`); a three-letter capital is the NBA team and nothing else.

**Ask First:**
- Any new `--size-*` token (`tokens.test.ts` pins exactly ten), any edit to a planning artifact, any breakpoint other than 640px.

**Never:**
- **Closed and Terminated cards.** `ContentionState` has no such member — a close removes the Auction from the projection (`auctions.ts:39-43`) and `readTerminatedPlayerId` (`nominations.ts:382`) yields a Player id and no reason. Both need a closed-auction projection that does not exist; deferred.
- **Salary and contract years in the metadata line.** `free_agent_players` carries `player_name`, `positions`, `nba_team` only (`auction-page.ts:547-560,62-68`). The line renders `NBA · POS`; deferred.
- Editing `EXPERIENCE.md` to settle its `:32` / `:320` contradiction. Adopt **Archived** (the reading `destinations.ts:93` already implements) and escalate the document fix.
- Position filters (`Board.dc.html:26-36` shows `G/F/C`; `epics.md:1490-1491` is the authority and does not).
- Any urgency device: no "ending soon", no reddening or pulsing clock, no one-tap raise, no suggested amount, no ranking of what is worth bidding on.
- Storing or transporting any derived money figure; a per-viewer Maximum Bid on a card (the strip owns that figure).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Open Auction | `leadingBid` present, `contention: 'standard'` | price, Leading Bidder as `Lakers — Meakel`, countdown, absolute close time | N/A |
| Awaiting Opening Bid | nomination with no Auction row | no clock at all, "No opening bid" in `text-tertiary`, the nominating Team, hours unbid from `occurredAt` | N/A |
| Minimum-Bid Contention | `contention: 'minimum_bid'` | `lottery` left bar, icon, label, Contender count, and `CONTENTION_CLOCK_UNMOVED` | N/A |
| Viewer leads | `leadingBid.teamId === viewerTeamId` | outlined `border-strong` chip, word "You lead", icon | N/A |
| Viewer outbid | viewer has a bid in `bids`, not leading | filled `attention` chip with `attention-ink`, word "Outbid", icon | N/A |
| Viewer contending | viewer in `contenders`, not leading | own word and own shape, not `attention` | N/A |
| Not involved | neither | plain `text-secondary` label, no chip | N/A |
| Signed out / no team | `viewerTeamId` null | the board renders in full; every card is Not involved | N/A |
| Sort | by time remaining / price / Player name | stable total order; ties broken by Player name so the list never reshuffles on equal keys | N/A |
| Filter | leading, contending, all | the filtered list plus a visible statement of what is hidden | N/A |
| Empty board | no open nominations | a designed screen explaining the state and pointing at Nominate | N/A |
| Wrong phase | phase without `bid-board` | 403 via `requireLiveDestination` | the guard, not a redirect |
| Read fails | database unreachable | the load throws as `auction-page.ts:668-672` does | rollback, rethrow |

</frozen-after-approval>

## Code Map

- `src/lib/core/projection/auctions.ts:115` `ContentionState`; `:144-151` `Contender`; `:154-180` `Bid` (`teamId`, `teamName`, `managerId`, `amount`, `occurredAt`, `closesAt`); `:194-243` `Auction` (`leadingBid`, `closesAt`, `bids`, `contenders`, `seed`, `seedHash`); `:246-248` `OpenAuctions.byPlayer`. `:266` `auctionForPlayer`, `:278` `contentionOf(null) => 'awaiting_opening_bid'`, `:297` `contentionSentence`, `:323` `MINIMUM_BID_CONTENTION_LABEL`, `:340` `CONTENTION_CLOCK_UNMOVED`, `:482` `contenderCountSentence`, `:850` `closesInPhrase`, `:980` `overdueAuctions` (the sorting precedent, `byCloseThenPlayer`). **No helper lists all Auctions** — `Object.values(byPlayer)` is the only route.
- `src/lib/core/projection/nominations.ts:123-163` `OpenNomination` (`fantraxPlayerId`, `playerName`, `teamId`, `teamName`, `managerId`, `occurredAt`); `:208-210` `openNominations()` returns the full set "in no stated order" — **this is the board's spine**: every Player on the board has a nomination, bid or not.
- `src/lib/core/instant.ts:88` `parseInstant`, `:133` `formatInstant`, `:173` `relativePhrase`. No `unbid.ts` exists.
- `src/lib/core/money.ts:169` `formatMoney`; `src/lib/core/team-identity.ts:36` `formatTeamManager`.
- `src/lib/server/auction-page.ts:465-675` — the load precedent: `connect`, `begin` `:472`, `loadEventsViaClient` `:474`, folds `:475,490,492,504`, `select now()` `:526`, reference-table select `:547-560` (`player_name`, `positions`, `nba_team` from `FREE_AGENT_PLAYERS_TABLE`, const `:157`), manager-name selects `:573-602`, `rollback` `:624`, catch `:668-672`, `release` `:673`.
- `src/lib/server/destinations.ts:76` `destination('bid-board', 'Bid Board', '/board', false)` under Auction, `:93` under Archived, none under Contract Assignment; `:136-144` `requireLiveDestination`.
- `src/routes/auction/[fantraxPlayerId]/+page.server.ts:60,79-101` — guard-first load shape. `src/routes/+layout.server.ts:74-90` supplies `phase`, `destinations`, `watermark`, `serverInstant`, `signedIn`, `stripTeam`; `hooks.server.ts:55-56` sets `locals.phase` / `locals.watermark`; `actorFrom(locals.session)` `:68-77`.
- `src/routes/auction/[fantraxPlayerId]/+page.svelte:518-524` relative time, `:550-589` the SSR-safe absolute-time `$effect` + `formatAbsolute`, `:677-696` the icon+word contention treatment, `:1107-1118` the `lottery` bar CSS, `:381` `freshness.state` consumption.
- `src/lib/styles/tokens.css:24` surface, `:30` border-strong, `:38` text-secondary, `:40` text-tertiary, `:45` brand, `:47-48` attention/attention-ink, `:50-51` lottery/lottery-text, `:69-78` the ten `--size-*` steps, `:62,64` display/ui faces.
- `tests/structure.test.ts:416-429` `sources()` / `code()` comment-stripping helpers, `:309-313` `blockFor(className)`, `:249-291` the `$lib/server` prohibition and source-text convention. `tests/routes/auction-page.test.ts` is the route-test shape. No `.svelte` renders (`vite.config.ts` node environment).
- `mockups/Board.dc.html:40-118` card anatomy, `:21-23` header with open count. Reference only.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/board.ts` -- new pure module. `BoardCard` (identity, `nbaTeam`, `positions`, price `Money | null`, leader ids/names, `closesAt | null`, `contention`, `contenderCount`, `nominatedByTeamName`, `nominatedAt`); `viewerStateFor(auction, viewerTeamId)` returning the four-way union; `boardCardsFor(nominations, auctions, metadata, viewerTeamId)`; `sortBoard(cards, key, now)` for `'closing' | 'price' | 'name'`, each falling back to Player name; `filterBoard(cards, filter)`; `unbidPhrase(nominatedAt, now)`; `filteredNoticeSentence`, `boardCountSentence`, `EMPTY_BOARD_*`, `VIEWER_STATE_LABELS`, `SORT_LABELS`, `FILTER_LABELS` -- every word and every ordering rule in one testable place, none of it in a `.svelte` file.
- [x] `src/lib/server/board.ts` -- new `loadBoard(gateway, viewerTeamId)`: one transaction, one `loadEventsViaClient`, folds nominations + auctions + phase, `select now()`, one batched reference-table select over the nominated Player ids, one batched manager-name select, always `rollback`, rethrow on failure -- `auction-page.ts`'s discipline over a list instead of one Player.
- [x] `src/routes/board/+page.server.ts` -- `requireLiveDestination('bid-board', ...)` first, then `loadBoard(writeGateway(), actorFrom(locals.session)?.teamId ?? null)`; return `{ phase, board }`.
- [x] `src/routes/board/+page.svelte` -- the card list, the sort and filter controls, the empty screen, the absolute time in `$effect` only, the `lottery` left bar, chips as icon+word. No wording of its own.
- [x] `tests/board.test.ts` -- unit-test every I/O matrix row through `src/lib/core/board.ts`, including each viewer state, each sort's tie-break, the filtered notice and the unbid phrase.
- [x] `tests/routes/board.test.ts` -- the guard runs first; the load shape; source-text assertions that the page imports no `$lib/server`, carries no `52px`-style literals for tokenised values, words nothing itself, and renders each state's icon **and** word.
- [x] `tests/server/board.test.ts` -- execute `loadBoard` against a fake client: one read of the log, no advisory lock, always `rollback`, and a rethrow rather than an empty board. Its own file because the route suite mocks the module (see Spec Change Log).
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- append three entries: the Closed/Terminated board half; the pool's absent salary and contract-years columns; and an annotation under the existing `:418` entry recording **Archived** as the resolution and escalating the `EXPERIENCE.md:320` correction to `bmad-correct-course`.

**Acceptance Criteria:**
- Given a greyscale screenshot of the board, when each card is read, then every Auction state and every viewer-relative state is identifiable from its word and shape alone.
- Given the board renders, when any string on it is traced, then it originates in `src/lib/core/`, and no `.svelte` file under `src/routes/board/` contains a user-facing sentence.
- Given the viewer sorts or filters, when the list changes, then no price, count or time on any card changes with it.
- Given a Manager on a phase whose catalog omits `bid-board`, when they request `/board`, then the response is the 403 `requireLiveDestination` produces, not a redirect and not an empty board.

## Spec Change Log

**2026-09-01 — step-03 exit audit, orchestrator.** Two corrections before the story left
implementation.

*The matrix's read-failure row had no test.* `loadBoard` was never executed by anything:
`tests/routes/board.test.ts` mocks `$lib/server/board.ts` to prove the guard runs first, so
the module's own transaction discipline — one read of the log, no advisory lock, always
`rollback`, and a **rethrow** rather than an empty board — was asserted only as source
text. Six executing tests were added in a new `tests/server/board.test.ts` (its own file
precisely because the route suite's mock would otherwise have exercised the stub and
asserted nothing), following `tests/strip.test.ts:511-536`'s fake-client pattern.
Mutation-checked: replacing the rethrow with an empty board fails exactly the two tests
that own the row, and restoring it goes green.

*Nobody leads a lottery, but the earliest joiner's card said they did.* `viewerStateFor`
tested `you_lead` before `contender`. Every Bid in a Minimum-Bid Contention is exactly
`MINIMUM_BID`, so `leadingBid` names whoever joined first purely as the fold's `seq`
tiebreak, while AD-14 decides the winner by a seeded draw over the ordered Contender list.
The earliest joiner therefore read **You lead** on an Auction they were no likelier to win
than the Team beside them — a standing they do not hold, on the one surface a Manager scans
to decide where to act. The Auction page makes no such claim, swapping its Leading Bidder
line for the contention panel (`auction/[fantraxPlayerId]/+page.svelte:692`). `contender` is
now tested ahead of **both** `you_lead` and `outbid`, and two tests pin it: the earliest
joiner reads `contender` and reads identically to the later one, and `you_lead` is
reachable only on a `standard` Auction with an empty Contender list. The original ordering
passed every existing test, because the suite only ever asked what the *second* joiner saw.

## Design Notes

**Why nominations, not auctions, are the spine.** `OpenAuctions.byPlayer` holds only Players who have received a bid; a Player Awaiting an Opening Bid has a nomination and no Auction row (`auctions.ts:266-280`). Iterating auctions would silently omit exactly the state `epics.md:1474` describes most precisely. `openNominations()` returns every Player on the board, and `auctionForPlayer` decorates the ones that have bids.

**Why the sorts all tie-break on Player name.** `overdueAuctions` (`auctions.ts:980-993`) already sorts `byCloseThenPlayer` for the same reason: several Auctions legitimately share a close instant or a price, and a comparator that returns 0 leaves `Array.sort` free to reorder them between renders. On a surface that re-derives on every projection change, that is a list that visibly shuffles while a Manager is reading it.
