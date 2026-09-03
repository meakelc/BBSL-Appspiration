---
title: 'Story 4.4: Your Positions — the landing'
type: 'feature'
created: '2026-09-02'
status: 'done'
baseline_commit: '5921c1357446c5b564389bc06ed845cbc416ca72'
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-BBSL-Appspiration-2026-08-16/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `your-positions` is a live Auction-phase destination (`destinations.ts:73`, `/positions`) with no route behind it, and `/` still renders the 1.1 skeleton (`routes/+page.svelte`, 76 lines). A Manager waking at 7:40am has to hunt thirty board cards to find their own five. Worse, an outbid card on the board says only *Outbid* — nothing computes, per viewer per Auction, whether a legal re-entry exists, so the only way to learn the Player is arithmetically gone is to tap through and be refused.

**Approach:** One destination at `/positions`, five groups in wake-up order, and the first read-path caller of `evaluate()` across *many* Auctions: each outbid card runs `bidControlState` at that Auction's own `minimumLegalBid`, off the same single fold, and states the answer before it is asked. Every word lives in `src/lib/core/positions.ts`.

## Boundaries & Constraints

**Always:**
- Five groups, in this order and no other: **Won · Outbid · You lead · Contending · Nomination Slot**. Group order is the wake-up's order, not a sort, and is not viewer-configurable.
- The re-entry answer is `bidControlState` output (`rules/bidding.ts:2649`) at `minimumLegalBid(state, viewerTeamId)` (`:713`), reached through `bidStateFor` + `teamMoneyStateFor` — **the same narrowing `server/bidding.ts:274-302` uses**, never a second derivation. AD-1's "one evaluator, two consumers"; a card, the Auction page's control and the server's refusal cannot disagree.
- Both gates always run and both are reported: a refusal names the cap arithmetic *and* the slots outcome, never one standing in for the other (AD-7:111).
- Every derived figure — `maximumBid`, the next legal Bid, Committed Bids — is computed at read and transported as a rendering only; nothing is stored, memoised or cached (AD-7:109).
- One transaction, one `loadEventsViaClient`, always `rollback`, rethrow on failure — `server/board.ts:238-325`'s discipline exactly. No advisory lock.
- The page carries `figuresAgeSentence` page-level in anything but Live (AD-29; the 4.3 review finding). Countdowns stay exempt and are derived from server-authoritative `closesAt`.
- Absolute times derive **only inside `$effect`** — the SSR-leak rule `board/+page.svelte` and `auction/[fantraxPlayerId]/+page.svelte:550-589` establish.
- Money through `formatMoney` only; Teams spelled out via `formatTeamManager`; a three-letter capital is the NBA team and nothing else.
- The Auction deep link is named **once**, in the core, and both `/board` and `/positions` link through it — Story 5.3 emits that one shape without knowing Discord exists.

**Ask First:**
- Any new `--size-*` token (`tokens.test.ts` pins exactly ten); any edit to a planning artifact; any change to `evaluate()` or any gate.

**Never:**
- A "won **while you slept**" label. Nothing records a last-seen instant, and inventing one is a storage decision this story has no basis for. The group is **Won**, every Auction the viewer's Team has won this phase, newest `closedAt` first — bounded by construction at the roster ceiling.
- Salary and contract years in the metadata line. `free_agent_players` carries `player_name`, `positions`, `nba_team` only; the line renders `NBA · POS`, as 4.3 already narrowed it.
- Any urgency device: no "ending soon", no one-tap raise, no suggested amount, no ranking, no celebration on a won card.
- A per-Team rendering of Maximum Bid. The strip owns the team-level figure; a card states only the per-Auction consequence.
- Making `/positions` a filter on the board, a pinned group, or the board with a query param.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Won | `AuctionContract` for viewer's team | player, `NBA · POS`, winning amount, placement and Cap Hit in words, absolute `closedAt`; newest first | N/A |
| Outbid, re-entry refused on cap | `bidControlState` blocked, `cap` among refusing gates | the next legal Bid and the viewer's Maximum Bid, both named, in one sentence | N/A |
| Outbid, re-entry refused on slots | blocked, `slots` refusing | the capacity refusal in its own words, with the cap outcome that passed stated beside it | N/A |
| Outbid, re-entry legal | `bidControlState` not blocked | the next legal Bid named, stated as within reach; no amount suggested | N/A |
| Outbid, viewer's own last amount | viewer's highest bid in `auction.bids` | rendered beside the current price | N/A |
| You lead | `leadingBid.teamId === viewerTeamId`, `standard` | price, countdown, absolute close, and what the lead commits against the cap | N/A |
| Contending | viewer in `contenders`, `contention === 'minimum_bid'` | `lottery` left bar, icon and word, `contenderCountSentence`, `CONTENTION_CLOCK_UNMOVED` | N/A |
| Dissolved contention | `contention === 'standard'`, contenders non-empty | the viewer appears under You lead or Outbid, never Contending (`board.ts:385-408`'s gate) | N/A |
| Nomination Slot free | `nominationForTeam` null | states the slot is free and offers Nominate | N/A |
| Nomination Slot used | `nominationForTeam` non-null | names the Player nominated and links to that Auction | N/A |
| Empty | no won, no leads, no outbids, no contentions | a designed screen pointing at the board and at the unused Nomination Slot, stating the open-Auction count | N/A |
| Viewer bound to no Team | `viewerTeamId` null | 403 via `requireLiveDestination`; no group renders with a null Team | the guard |
| Wrong phase | phase whose catalog omits `your-positions` | 403 via `requireLiveDestination`, not a redirect | the guard |
| Root landing | `/` requested, `your-positions` live for that session | redirect to `/positions` | N/A |
| Root landing, not live | signed out, or a phase without the destination | `/` keeps its current behaviour; no redirect into a 403 | N/A |
| Read fails | database unreachable | rollback, rethrow — never an empty Positions page | rollback, rethrow |

</frozen-after-approval>

## Code Map

- `src/lib/core/rules/bidding.ts` — `bidStateFor` `:502`, `teamMoneyStateFor` `:596`, `minimumLegalBid` `:713`, `evaluate` `:1550`, `failedGates` `:1604`, `bidRefusalDetail` `:2528`, `minimumLegalSentence` `:2599`, `BidControlState` `:2635`, `bidControlState` `:2649` (options `{state, fantraxPlayerId, viewerTeamId, amountText, confirmed, now}`; refuses `unbound_actor` when `viewerTeamId` null `:2659-2666`; returns `blocked` / `detail` / `refusingGates` `:2690-2693`), `capBreakdown` `:1992`, `bidGateReport` `:2433`, `describeAmount` `:2114`. `maximumBid` is a FIELD on the cap outcome (`:1349`, `types.ts:479`) — no standalone function. Gate order and identifiers: `types.ts:654-664`, `PlaceBidGateResults` `:677-687`.
- `src/lib/server/auction-page.ts:704-738` `readBidControl` — the single-Auction precedent this story generalises: `bidStateFor` `:720`, `minimumLegalBid` `:724`, `bidControlState({..., amountText: String(minimumLegal), confirmed: true, now: figuresAt})` `:726-733`. Read it before writing anything.
- `src/lib/server/bidding.ts:222-306` `loadBidState` — the canonical assembly: one `loadEventsViaClient` `:227`, five folds `:228-244`, `loadTeamRoster` `:246`, then `bidStateFor(auction, teamMoneyStateFor({teamId, fantraxPlayerId, capSpace, rosterCount, minorLeagueOccupied, auctions, isMinorLeagueEligible, playerNameFor}), isEligible(...), phase)` `:274-302`. **Per-Auction, over one fold** — a Positions load calls the narrowing N times against the same folded state and reads the log once.
- `src/lib/core/projection/contracts.ts` — `AuctionContract` `:85-103` (`playerName`, `teamId`, `teamName`, `winningAmount`, `capHit`, `placement`, `contractYears: null`, `closedAt` = the Auction's own nominal expiry `:79-83`); `AuctionContracts.byPlayer` `:105-107`; `contractForPlayer` `:126-132`; `contractRowsFor(contracts, teamId)` `:154-166` returns `CapHitRow[]` **only** — it is the Cap bridge and carries no name or `closedAt`, so the Won group needs a new selector beside it, not a reuse of it.
- `src/lib/core/projection/auctions.ts` — `ContentionState` `:115`, `Contender` `:144-151`, `Bid` `:154-180`, `Auction` `:194-243`, `OpenAuctions.byPlayer` `:246-248`, `auctionForPlayer` `:266`, `contentionOf` `:278`, `MINIMUM_BID_CONTENTION_LABEL` `:323`, `CONTENTION_CLOCK_UNMOVED` `:340`, `contenderCountSentence` `:482`, `wasDissolved` `:461`, `closesInPhrase` `:850`. Closed Auctions are DELETED from `byPlayer` `:806-815`.
- `src/lib/core/projection/nominations.ts` — `OpenNomination` `:123-153`, `nominationForTeam` `:199-205` (non-null = slot used), `nominationForPlayer` `:190`, `openNominations` `:208-210`.
- `src/lib/core/board.ts` — the sibling module to parallel, not to extend: `BoardViewerState` `:65`, `VIEWER_STATE_LABELS` `:165`, `VIEWER_STATE_ICONS` `:182`, `metadataLine` `:328`, `priceLabel` `:344`, `viewerStateFor` `:385-408` (the dissolved-contention gate — reuse this predicate's reasoning, and import the labels/icons rather than respelling them), `boardCardsFor` `:430`, `sortBoard` `:527`.
- `src/lib/server/board.ts:238-325` `loadBoard` — transaction shape to copy: `begin` `:243`, one read `:250`, folds `:251-252`, `select now()` → `figuresAt` `:259-260`, batched `free_agent_players` select `:266-269,128-151`, batched `managers` select `:270,172-191`, `rollback` `:274`, catch → rollback + rethrow `:317-321`. `BoardState` `:104-114`.
- `src/lib/server/team-roster.ts:113-142` `loadTeamRoster(client, teamId, contracts)` — the roster facts `teamMoneyStateFor` needs, folded contracts included.
- `src/routes/board/+page.server.ts` — guard-first shape: `requireLiveDestination(...)` FIRST at `:50`, `actorFrom(session)` `:42-47`, `loadBoard(writeGateway(), actor?.teamId ?? null)` `:53`. `src/routes/+layout.server.ts:60-78` supplies `phase`, `destinations`, `watermark`, `serverInstant`, `signedIn`, `stripTeam`.
- `src/routes/board/+page.svelte` (571 ln) — the presentation precedent: core-wording imports `:34-58`, `figuresAgeSentence` at `:194`, empty-state branching on phase `:253-271`, the sole `/auction/${card.fantraxPlayerId}` link `:335` (**the only deep-link call site in the repo today** — this story names the shape once and rewrites this one to use it).
- `src/lib/server/destinations.ts:73` `destination('your-positions', 'Your Positions', '/positions', false)`; `requireLiveDestination` `:128-135` → `error(403, LIVE_DESTINATION_REFUSAL)`. `src/routes/+page.server.ts` returns `{ phase: locals.phase }` and redirects nowhere.
- Tests: `tests/routes/board.test.ts` (route module executed, `vi.mock` of `$lib/server/board.ts` `:64-69` and `$lib/shell/db.ts` `:71-75`, dynamic import `:77`, `stripComments` `:44-49`); `tests/server/board.test.ts` `fakeGateway()` `:20-46` with `options.failOn` and snake_case `row()` builder; `tests/board.test.ts` pure-core shape. **Nothing renders a `.svelte` file** — `vite.config.ts` is `environment: node`; every surface claim is source-text. Purity: `scripts/check-core-purity.js` FORBIDDEN_GLOBALS `:58-79`, `.ts` extension on every relative core import (`tests/purity.test.ts:40-58`).
- `_bmad-output/planning-artifacts/ux-designs/.../mockups/Positions.dc.html` — group order `:28,44,88,105,124`, the refused sentence `:65`, the legal sentence `:82`, the won card `:29-40`, the empty screen `:135-143`. Reference only.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/contracts.ts` — add `contractsWonBy(contracts, teamId): readonly AuctionContract[]`, newest `closedAt` first with `fantraxPlayerId` as the total tie-break. Beside `contractRowsFor`, not instead of it: that one is the Cap bridge and yields `CapHitRow` with no name or timestamp.
- [x] `src/lib/core/auction-link.ts` — new. `AUCTION_PATH_PREFIX` and `auctionPathFor(fantraxPlayerId): string`. The one place the deep-link shape is written, so Story 5.3 emits it without re-deriving it.
- [x] `src/lib/core/positions.ts` — new pure module. `PositionsGroup` (`won | outbid | you_lead | contending | nomination_slot`) and `POSITIONS_GROUP_ORDER`; the card types; `ReEntry` — the outbid card's answer, built from a `BidControlState` and the Auction's `minimumLegalBid`, carrying `nextLegalBid`, `blocked`, the refusing gates and the sentence; `reEntrySentence`; `positionsFor(...)` assembling the five groups from folded nominations, auctions, contracts and per-Auction control states; `GROUP_HEADINGS`, `wonCardSentence`, `leadCommitmentSentence`, `nominationSlotSentence`, `EMPTY_POSITIONS_*`. Import `VIEWER_STATE_LABELS` / `VIEWER_STATE_ICONS` / `metadataLine` / `priceLabel` from `board.ts`; import `MINIMUM_BID_CONTENTION_LABEL`, `CONTENTION_CLOCK_UNMOVED`, `contenderCountSentence` from the projection. Respell nothing.
- [x] `src/lib/server/positions.ts` — new `loadPositions(gateway, viewerTeamId)`: one transaction, one `loadEventsViaClient`, folds nominations + auctions + eligibility + phase + contracts, one `loadTeamRoster`, `select now()`, batched `free_agent_players` and `managers` selects over the union of nominated and won Player ids, then per relevant Auction the `bidStateFor`/`teamMoneyStateFor` narrowing and `bidControlState` at `minimumLegalBid`. Always `rollback`; rethrow.
- [x] `src/routes/positions/+page.server.ts` — `requireLiveDestination(locals.session, locals.phase.name, 'your-positions')` FIRST, then `loadPositions(writeGateway(), actorFrom(locals.session)?.teamId ?? null)`; return `{ phase, positions }`.
- [x] `src/routes/positions/+page.svelte` — the five groups in fixed order, the re-entry line, the empty screen, absolute time in `$effect` only, page-level `figuresAgeSentence` in anything but Live, the `lottery` left bar on a contending card, chips as icon **and** word with `.chip` on Outbid and You lead only (`DESIGN.md:194`). No wording of its own.
- [x] `src/routes/+page.server.ts` — redirect to `/positions` when `your-positions` resolves live for the session's phase and role; otherwise leave the existing return untouched. Resolve through `resolveDestinations`, never a hardcoded phase test.
- [x] `src/routes/board/+page.svelte` — replace the literal `/auction/${...}` at `:335` with `auctionPathFor(...)`, so one shape exists.
- [x] `tests/positions.test.ts` — every I/O matrix row through `src/lib/core/positions.ts`: each group, the three re-entry outcomes, the dissolved-contention placement, both Nomination Slot states, the empty screen, and the group order asserted as a literal sequence.
- [x] `tests/server/positions.test.ts` — execute `loadPositions` against `tests/server/board.test.ts`'s `fakeGateway()`: one log read, no advisory lock, always `rollback`, rethrow rather than an empty page, and a real card assembly exercising the metadata and manager-name lookups. Its own file — the route suite mocks the module.
- [x] `tests/routes/positions.test.ts` — the guard runs first; the load shape; source-text assertions that the page imports no `$lib/server`, words nothing itself, renders each state's icon and word, and carries `figuresAgeSentence`. Add `tests/routes/root-landing.test.ts` for the redirect and the no-redirect case — `src/routes/+page.server.ts` has no test today, and `tests/routes.test.ts:2` already imports `isRedirect` for this exact assertion shape.
- [x] `tests/core/auction-link.test.ts` — the deep-link shape is stable and is the only spelling; assert `board/+page.svelte` and `positions/+page.svelte` contain no literal `/auction/` template.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` — append one entry: the "won **while you slept**" framing needs a per-Manager last-seen instant that nothing in the log records; the group ships as **Won** until a story adds one.

**Acceptance Criteria:**
- Given a greyscale screenshot of Your Positions, when each card is read, then every group and every viewer-relative state is identifiable from its word and shape alone.
- Given any string on the page is traced, then it originates in `src/lib/core/`, and no `.svelte` file under `src/routes/positions/` contains a user-facing sentence.
- Given an outbid card whose next legal Bid exceeds the viewer's Maximum Bid, when it renders, then the refusal is stated on the card with both figures named, and the capacity gate's outcome is stated beside it — the Manager never taps through to discover it.
- Given a signed-in Manager in the Auction Phase requests `/`, when the load runs, then they arrive at Your Positions; and given a session for whom the destination is not live, then `/` does not redirect them into a 403.
- Given the full board is wanted, when the Manager follows the board link from Your Positions, then `/board` opens unfiltered.

## Spec Change Log

**2026-09-02 — code review, orchestrator.** Five corrections from the review's four layers.
None touches `evaluate()` or any gate; all five are in this story's own modules.

*A won Player is no longer a link.* Raised by the Acceptance Auditor. `auctionPathFor` on a
won Player resolves to a page that raises `error(404)`, because a close deletes the Player
from the folds the Auction route reads — so the **first** group on the landing page was
entirely dead links. `WonCard.href` is now `string | null` and `null`; the surface renders a
plain span in that branch. Appended to `deferred-work.md` beside the spec-3-6 entry that
already owns the closed-Auction surface, which is what will restore the link.

*The empty screen no longer offers Nominate to a Manager whose Slot is spent.* `empty`
counts the four Auction groups only — deliberate, and documented, because a free Slot is
what the screen points at — but a Manager who nominated a Player nobody has bid on yet
reaches it with a **spent** Slot, and read "Your Nomination Slot is already spent" directly
above a Nominate link `/nominate` refuses, with the Player they hold named nowhere. The
branch now tests the Slot's actual state and names and links that Player.

*The re-entry answer reports the gate that actually refused.* `bidControlState` blocks on
any of the nine `PLACE_BID_GATES`, but the card reported `cap` and `slots` alone — so a
paused Phase or an expired-but-unswept Auction rendered "You cannot re-enter at $15.0M"
above `Cap · Passed` and `Slots · Passed`. The sentence was right, but a card arguing with
itself on the one surface built to answer before being asked is the same defect as being
wrong. `reportedGates` now returns the AD-7 floor **plus** any refusing gate, in
`PLACE_BID_GATES` order; the floor is unchanged and untouchable. Mutation-checked: pinning
it back to the two gates fails both the core and the server suite.

*The leading bidder has its own label.* `POSITIONS_LEADING_LABEL` existed in the core and
was never imported, so the rival's Team-Manager sat as a second bare line under "Your Bid" —
in greyscale, reading as part of the viewer's own bid.

*`POSITIONS_GROUP_ORDER` is now load-bearing.* Its docblock claims the surface iterates it;
the page hard-codes five `{#if}` sections, and the route test listed the five ids by hand
beside a `toHaveLength` check — so reordering the core constant left page and test green.
The ids are now derived from the constant.

**2026-09-02 — step-03 exit audit, orchestrator.** One correction before the story left
implementation.

*Two copies of one ordering rule in the core.* `positions.ts`'s `groupFor` re-derived
`board.ts:385` `viewerStateFor`'s three ordered tests by hand rather than calling it —
including the live-contention gate that was a **4.3 review finding** (a dissolved lottery
is `standard` with `contenders` still populated, so an ungated test puts the Team whose
raise dissolved it under Contending rather than under You lead). The implementation was
correct and its docblock cited the right reasoning, but the rule now existed twice in
`src/lib/core/**`, and a later correction to either copy would silently leave the other
wrong — the two surfaces a Manager cross-reads would then disagree about where they stand.
`groupFor` now delegates to `viewerStateFor` and maps its four-way union onto the group,
`not_involved → null`. Mutation-checked: removing the `contention === 'minimum_bid'` gate
from `board.ts` now fails `tests/positions.test.ts`'s two dissolved-contention tests as
well as the board's own, and restoring it goes green. Before the change, breaking the board
left the Positions suite entirely green — which is exactly the coupling the delegation buys.

## Design Notes

**Why `bidControlState` and not a new predicate.** AD-1 fixes two entry points and says the read path calls `evaluate()` directly "to disable controls with stated reasons". `bidControlState` is already that call, already used by `auction-page.ts:726` at exactly `minimumLegalBid`, and already refuses `unbound_actor` for a viewer with no Team. A second "can they re-enter" predicate would be a third statement of the gate set, and the first one to fall out of step with a gate change. The generalisation this story makes is N-at-once over one fold, not a new rule.

**Why the Won group is bounded without a window.** A Team holds at most twelve Active/Bench Slots plus its Minor League slots, so `contractsWonBy` cannot return an unbounded list however long the phase runs. That is why no arbitrary "last 24 hours" cut is needed — and why introducing one would be a stored last-seen decision wearing a presentation costume.

**Why the redirect resolves through `resolveDestinations`.** A hardcoded `phase === 'Auction'` test would send an unregistered visitor, or a Manager in Archived, straight into `requireLiveDestination`'s 403. Asking the same resolver the guard asks makes the redirect and the refusal structurally incapable of disagreeing.

## Verification

**Commands:**
- `npm test` — expected: green, with `tests/positions.test.ts`, `tests/server/positions.test.ts`, `tests/routes/positions.test.ts` and `tests/core/auction-link.test.ts` all collected and executed.
- `npm run check` — expected: 0 errors, 0 warnings.
- `npm run check:pins` — expected: pass.

**Manual checks (if no CLI):**
- Open `src/routes/positions/+page.svelte` beside `DESIGN.md:194` and the mockup and match each visual rule to the selector carrying it — nothing in this repo can render a component, so this reading is the only gate that exists.
