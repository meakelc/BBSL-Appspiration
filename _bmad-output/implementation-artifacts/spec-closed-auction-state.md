---
title: 'The Closed state of an Auction'
type: 'feature'
created: '2026-09-09'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'd7c6ebb29f35a44f72309bca3f9d4e004e93a53c'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A closed Auction has no surface anywhere. The route 404s, the Player vanishes from the Bid Board, and Your Positions' won cards are deliberately unlinked — so `EXPERIENCE.md:168`'s Closed state (winner, final amount, Slot placement, and for a lottery the seed and ordered Contender list) is unrendered, and `drawForPlayer` has no production caller. AD-14's whole premise is that a losing Manager can check the draw afterwards; today there is nowhere to check it.

**Approach:** Additive reads only. Compose the two folds that already survive a close — `contractsReducer` and `drawsReducer` — into one pure derivation, then render it three times: as the Auction page's Closed state, as a Closed card on the Bid Board, and as the link Your Positions' won cards have been missing. No fold changes, no new event, no migration.

## Boundaries & Constraints

**Always:**
- The close keeps deleting the Player from `auctionsReducer` and `nominationsReducer`. Nothing in this story touches either removal case.
- One derivation, read by all three surfaces. The board and the Auction page may not each compose contracts and draws their own way.
- Every word lives in the core, never in a `.svelte` file — `MINIMUM_LOTTERY_LABEL`'s rule. A Closed label needs a narrow spelling decided too.
- State is never colour alone: the Closed marker is an icon **and** a word, and its glyph is disjoint from every glyph that can appear beside it on one card.
- The Contender list renders Team **names** in the fold's `seq` order, never ids and never re-sorted — AD-14 makes the order an input to the winner.
- One log read per request, one database clock, as both existing loaders already do.

**Ask First:**
- Any change to `ContentionState`'s membership.
- Any change to what a board card means beyond "open nominations plus closed Auctions".

**Never:**
- Do not bump `CORE_VERSION`. No gate verdict or fold outcome may change.
- No Terminated card. `AuctionTerminated` records a Player id and no reason, and no override can append one until Epic 7 — it stays deferred.
- No bid history on a closed page. `auctionsReducer` deletes the Auction, so the Bids are not durable; showing a partial history would invent one.
- No migration, no deploy, no Discord send. Never write to the pilot database.
- Do not touch `supabase/config.toml`, `supabase/functions/tick/adapt.ts`, `tests/server/tick-adapt.test.ts`.
- No countdown, no urgency device and no celebration on a Closed card. A win is stated, never congratulated.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Closed standard Auction | Contract exists, no draw | Auction page Closed state: winner, final amount, placement sentence, closed instant | N/A |
| Closed lottery | Contract + `DrawnDraw` | Adds revealed seed, published commitment, ordered Contender names, selected index, link to `/verify` | N/A |
| Emptied lottery | Contract + `UndrawnDraw` | Seed and commitment shown; states the list was empty and no draw ran | N/A |
| Draw with no contract | `ContentionDrawn`, no `AuctionClosed` | 404 — a draw alone is not a Closed Auction | 404 |
| Never nominated / unknown id | No nomination, no contract | 404, reworded: this Player has no Auction | 404 |
| Winning Team's own view | Viewer holds the contract | Board card reads `You won`; Your Positions won card links here | N/A |
| Missing `free_agent_players` row | Reference row absent | Metadata line omitted; name falls back to the contract's own copy | N/A |
| Contender id naming no Team | `teams` lookup misses | The id is printed as-is rather than dropping the Contender from an ordered list | N/A |

</frozen-after-approval>

## Code Map

**Reuse — verified, do not re-derive:**
- `src/lib/core/projection/contracts.ts:211` `contractForPlayer` → `AuctionContract` (`:170`): `playerName`, `teamId`, `teamName`, `winningAmount`, `capHit`, `placement`, `contractYears`, `closedAt`. No removal case; survives the close.
- `src/lib/core/projection/draws.ts:154` `drawForPlayer` → `Draw = DrawnDraw | UndrawnDraw` (`:78`). `contenders` is **team ids only** (`:88`) — names need a `teams` lookup. `DrawnDraw` carries `winningTeamName`, `selectedIndex`, `seed`, `seedHash`. No production caller today.
- `src/lib/core/positions.ts:517` `PLACEMENT_LABELS` and `:531` `wonCardSentence` — the placement sentence, already used by `src/lib/core/team-view.ts:515`.
- `src/lib/core/auction-link.ts:44` `auctionPathFor`.
- `src/lib/core/instant.ts:173` `relativePhrase`; `src/routes/auction/[fantraxPlayerId]/+page.svelte:626` `formatAbsolute` (client-only, per `:602-616`).

**Change:**
- `src/lib/core/board.ts:134-140` — the docblock stating there is no Closed member. Rewrite, do not delete. `AUCTION_STATE_LABELS` `:148`, narrow `:164`, `AUCTION_STATE_ICONS` `:179` (glyphs in use: `○ ● ◆`). `VIEWER_STATE_ICONS` `:206` (`▲ ▼ ◧ –`). `sortBoard` `:539`, `filterBoard` `:640`, `FILTER_KEYS` `:73`, `boardCardsFor` `:466`, `BoardCard` `:110`, `viewerStateFor` `:409`.
- `src/lib/server/board.ts` — `BoardCardView` `:70`, `loadBoard` `:241`, folds at `:254-255`, `loadMetadata` `:131`, card assembly `:282-318`. Labels are baked **server-side** here (`:303-310`); the `.svelte` prints pre-resolved fields.
- `src/routes/board/+page.svelte` — card `<li>` `:329`, link `:340`, state chip `:362-364`, price `:385`, leading bidder `:413`, clock `:423`, nominated-by `:447`; narrow/wide is pure CSS at `:559-571`; sort/filter are local runes `:107-108`, radios `:284-314`.
- `src/lib/server/auction-page.ts` — `AuctionPageState` `:345`, `loadAuctionPage` `:491`, the `nomination === null` early return at `:505-507`, `rollback` `:650`, manager lookup SQL `:623-628`.
- `src/routes/auction/[fantraxPlayerId]/+page.server.ts:93` — the 404.
- `src/routes/auction/[fantraxPlayerId]/+page.svelte` — header `:661-677`, price panel `:684-774`; a Closed render is a new top-level branch.
- `src/lib/core/positions.ts:759` `href: null` and its docblock `:389-405`; `src/routes/positions/+page.svelte:325-331` the `{#if card.href !== null}`.
- `_bmad-output/implementation-artifacts/deferred-work.md` — entries at `:413` (spec-3-6), `:491` (spec-4-3), `:516` (spec-4-4).

**Read-only evidence:**
- A close does **not** delete the `free_agent_players` row — only `src/lib/server/import-promotion.ts:359` does. Metadata survives.
- `/verify` (`src/routes/verify/+page.server.ts`, 40 lines) is a static procedure with an invented example and no `load`; the Auction page never prints `seedHash` or `seed` (`+page.svelte:178-186`). This page is the only home real values can have.
- Tests to extend: `tests/board.test.ts` (43), `tests/server/board.test.ts` (8), `tests/routes/board.test.ts` (29), `tests/positions.test.ts:304` (`href` null), `tests/routes/positions.test.ts:422-423` (the `{#if}`), `tests/server/auction-page.test.ts:535-544` (returns null on close), `tests/routes/auction-page.test.ts:876-878` and `:953-964` (the 404), `tests/projection-draws.test.ts` (20).

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/closed.ts` -- NEW. `ClosedAuction` + `closedAuctionFor(contracts, draws, fantraxPlayerId)` composing the two existing folds; `null` unless a contract exists. Relocate `PLACEMENT_LABELS`/`wonCardSentence` here and word the Closed labels (`CLOSED_LABEL`, `CLOSED_LABEL_NARROW`, the emptied-lottery sentence, the `/verify` invitation) -- the one derivation spec-4-3's entry asks for, in a module `board.ts` can import without the cycle `positions.ts` would create.
- [x] `src/lib/core/positions.ts` + `src/lib/core/team-view.ts` -- import the relocated placement wording from `projection/closed.ts`; set `WonCard.href` to `auctionPathFor(...)` and rewrite the `:389-405` docblock -- one spelling of one sentence, and the link the deferred entry names.
- [x] `src/lib/core/board.ts` -- add `BoardCardState = ContentionState | 'closed'`, rekey the three label/icon records onto it, rewrite the `:134-140` docblock, widen `BoardCard` for a closed card, add `won` to `BoardViewerState`, tier closed last in `sortBoard`, add `open`/`closed` to the filter -- the board's Closed card and the readability the retention decision depends on.
- [x] `src/lib/server/board.ts` -- fold contracts and draws over the same `events` array, emit closed cards through `BoardCardView`, resolve winner Manager names in the existing lookup -- one read, one clock, labels still baked here.
- [x] `src/routes/board/+page.svelte` -- render the Closed card (no countdown, no nominated-by), add the two filter radios -- the surface prints fields and words nothing.
- [x] `src/lib/server/auction-page.ts` -- return a discriminated `{ kind: 'open' | 'closed' }`; on a null nomination fold contracts and draws and resolve Contender names from `teams` before rolling back -- so the Closed read shares the open read's single log fold and clock.
- [x] `src/routes/auction/[fantraxPlayerId]/+page.server.ts` -- 404 only when both reads miss; reword the message, which no longer means "not open".
- [x] `src/routes/auction/[fantraxPlayerId]/+page.svelte` -- a Closed branch: winner, final amount, placement sentence, closed instant twice, and for a lottery the commitment, revealed seed, ordered Contenders with the selected position marked, and a link to `/verify`.
- [x] `src/routes/positions/+page.svelte` -- delete the `{#if card.href !== null}` and its `{:else}`.
- [x] `tests/core/closed.test.ts` (new) + `tests/board.test.ts`, `tests/server/board.test.ts`, `tests/routes/board.test.ts`, `tests/positions.test.ts`, `tests/routes/positions.test.ts`, `tests/server/auction-page.test.ts`, `tests/routes/auction-page.test.ts` -- cover every I/O matrix row; invert the assertions that pinned the 404 and the null `href`.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- resolve the spec-3-6 and spec-4-4 entries; narrow spec-4-3's to its Terminated half and re-own it to Epic 7.2/7.3.

**Acceptance Criteria:**
- Given a closed Auction, when a Manager opens its deep link, then the page states the winner, the final amount and the placement instead of 404ing, and the link Discord already emits resolves for the rest of the phase.
- Given a drawn lottery, when its closed page renders, then the revealed seed, the published commitment and the ordered Contender names appear with the selected position marked, so the `/verify` procedure can be run against real values.
- Given a greyscale screenshot of a board carrying open and closed cards, when it is read, then every state is still distinguishable by glyph and word alone.
- Given the board's default sort, when closed cards are present, then every open Auction sorts above every closed one, and the `open` filter hides closed cards entirely.
- Given `CORE_VERSION` and every gate, when the suite runs, then no verdict, fold outcome or version has changed.

## Design Notes

**`ContentionState` does not gain a member.** It is the fold's answer about a *live* Auction, and the close deletes the Auction — so `closed` is a value the fold can never produce, while the union is switched on inside the bidding gates. Widening it would force a dead case into every one of them. The Closed state is therefore **card-level**: `BoardCardState = ContentionState | 'closed'`, declared in `board.ts` beside the labels it keys. Rekeying the three records is a widening, so every existing site indexing them with a `ContentionState` still type-checks unchanged.

**A closed card carries no "Nominated by" and no clock.** `nominationsReducer` deletes the nomination at the close (`nominations.ts:458-473`), so the nominating Team is not durable and must not be invented. `EXPERIENCE.md:168` asks for winner, amount and placement — that is the whole card.

**Closed sorts last in every ordering, not by having no clock.** `sortBoard`'s `closing` key is ascending time *remaining*, so a closed card carrying its `closedAt` would sort **first**, above every running Auction. Closed is an explicit final tier, ordered among itself by the chosen key.

**`won` is the fifth viewer state and the only one added.** On a closed card the viewer axis has exactly two answers — `won` or `not_involved`. "You lead" and "Contender" describe standings a settled Auction no longer holds, and `contender`'s `◧` therefore never co-occurs with the Closed glyph.

## Verification

**Commands:**
- `npx vitest run` -- expected: 3517+ passing with only `tests/integration/auction-events.test.ts` failing (the documented FK/database mismatch, `README.md:311`).
- `npx tsc --noEmit` (or the repo's check script) -- expected: clean.
- `npm run build` -- expected: succeeds; runs `check-pins` and `check-core-purity`. (Corrected 2026-09-09: this repo has no eslint or prettier config and no lint script — CI runs `npm test`, `npm run check` and Deno checks on the core. The original eslint/prettier line was a planning error, not an implementation gap.)
- CI-only, not runnable here: `deno check` over `src/lib/core/**` (Deno is not installed on this machine). New core module verified by inspection to use relative `.ts` imports throughout.
- `git diff --stat src/lib/core/` -- expected: `CORE_VERSION` unchanged; no file under `src/lib/core/rules/` modified.
- `git status --porcelain` -- expected: the three tick-hotfix paths untouched.

**Manual checks:**
- Run a local dev server against the pilot data read-only and open a real closed lottery's deep link: the seed, the commitment and the ordered Contenders must match the log, and `/verify`'s procedure must reproduce the recorded `selectedIndex`.

## Suggested Review Order

**The one derivation (start here)**

- The whole story in one function: a contract makes an Auction closed, a draw only decorates it.
  [`closed.ts:101`](../../src/lib/core/projection/closed.ts#L101)

- Two folds joined into one claim about a person — cross-checked before composing, not trusted.
  [`closed.ts:101`](../../src/lib/core/projection/closed.ts#L101)

- The shape all three surfaces read; nothing else composes contracts and draws.
  [`closed.ts:65`](../../src/lib/core/projection/closed.ts#L65)

**Words and shapes (the greyscale rule)**

- Not the won glyph: that claims something about the reader, and this reader usually lost.
  [`closed.ts:263`](../../src/lib/core/projection/closed.ts#L263)

- Closed is card-level, never a `ContentionState` member the gates would switch on.
  [`board.ts:97`](../../src/lib/core/board.ts#L97)

- The spent docblock, rewritten rather than deleted, explaining why the reasoning expired.
  [`board.ts:227`](../../src/lib/core/board.ts#L227)

- Three records rekeyed by widening, so every existing indexing site still type-checks.
  [`board.ts:243`](../../src/lib/core/board.ts#L243)

**The board: retention, order, filter**

- Closed is an explicit final tier; by remaining time it would otherwise sort first.
  [`board.ts:836`](../../src/lib/core/board.ts#L836)

- `open` and `closed` are complements, so `all` can keep meaning the whole board.
  [`board.ts:933`](../../src/lib/core/board.ts#L933)

- Open nominations and closed contracts joined into one card list.
  [`board.ts:736`](../../src/lib/core/board.ts#L736)

- The count says "open" and now counts only open, docblock and caller agreeing again.
  [`board.ts:428`](../../src/lib/core/board.ts#L428)

**The Auction page: 404 becomes a state**

- The discriminated read — one log fold, one clock, two possible answers.
  [`auction-page.ts:514`](../../src/lib/server/auction-page.ts#L514)

- The closed branch: reference row, winner's Manager, Contender names in one `teams` statement.
  [`auction-page.ts:655`](../../src/lib/server/auction-page.ts#L655)

- 404 now means no Auction of any kind, not merely none open.
  [`+page.server.ts:103`](../../src/routes/auction/%5BfantraxPlayerId%5D/+page.server.ts#L103)

- One cast at the wire boundary, then narrowing the compiler checks.
  [`+page.svelte:316`](../../src/routes/auction/%5BfantraxPlayerId%5D/+page.svelte#L316)

- The Closed branch: winner, amount, placement, and the lottery's real seed and list.
  [`+page.svelte:792`](../../src/routes/auction/%5BfantraxPlayerId%5D/+page.svelte#L792)

**Your Positions: the link that was missing**

- `href` is a `string` again; the deferred entry's one-line fix, in its one place.
  [`positions.ts:739`](../../src/lib/core/positions.ts#L739)

- The `{#if}` is gone — every won card is a link now.
  [`+page.svelte:328`](../../src/routes/positions/+page.svelte#L328)

**Surfaces and supporting changes**

- The Closed card: no countdown, no "Nominated by", nothing that congratulates.
  [`board/+page.svelte:444`](../../src/routes/board/+page.svelte#L444)

- A price and a final amount are not the same claim about a number.
  [`board/+page.svelte:420`](../../src/routes/board/+page.svelte#L420)

- The derivation's own tests, including the glyph disjointness and the cross-check.
  [`closed.test.ts:117`](../../tests/core/closed.test.ts#L117)
