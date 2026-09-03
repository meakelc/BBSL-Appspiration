---
title: 'Story 4.6: The Teams index and the League Median'
type: 'feature'
created: '2026-09-03'
status: 'done'
baseline_commit: 'e89ffe3a26cd003278bc8846fdecaa791554c7d4'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-5-view-any-team.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `teams` is a live destination in all three post-Setup phases resolving to `/teams` (`destinations.ts:79,87,94`), and **`/teams` has no route** — the header menu and the strip's sheet both 404 today, and Story 4.5's `/teams/[teamId]` is reachable only by typing an id. A Manager cannot answer "who else can actually chase this Player" without opening thirty URLs, and the League Median that would make `$6.0M of room` mean something does not exist anywhere in the core.

**Approach:** One page at `/teams` that is thirty calls to Story 4.5's `teamViewFor` over **one** fold of the log, plus a League Median in `core/money` as pure arithmetic — the lower of the two middle values, spelled once and used for both money and slots. The index states figures and nothing about them.

## Boundaries & Constraints

**Always:**
- **Thirty renderings of `teamViewFor`, never a second computation.** `epic-4-context.md:56` and `spec-4-5`'s whole seam depend on it: the index and `/teams/[teamId]` cannot disagree because they are the same function. Every figure on a row is a field of the `TeamView` that function returns.
- **One transaction, one `loadEventsViaClient`, one set of folds, one `select now()`** for all thirty Teams. The identity join and the roster read become league-wide reads; only `teamMoneyStateFor` and `teamViewFor` run per Team.
- **The League Median is the lower of the two middle values, never their mean** — `$4,000,000` and `$4,500,000` yield `$4,000,000`; 2 slots and 3 yield `2`. It lives in `core/money.ts` as pure arithmetic on the branded type, **not** behind `evaluate()` or `decide()` (`ARCHITECTURE-SPINE.md:122`). The rule is written **once** and both the money and the slot median call it.
- The median result is **always on the `MINIMUM_INCREMENT` grid** because it is always a value some real Team holds. `isOnMoneyGrid` (`money.ts:155`) makes that assertable rather than argued.
- **All 30 Teams, never a subset and never paginated.** The viewer's own row is marked and **not** pinned, reordered or exempted from the sort.
- The own-row marker is a **2px `border-strong` left edge plus `— you`** in place of the Manager name — never the 3px `lottery` bar (`DESIGN.md:185`). Every Team name sits in `--color-text`, the viewer's included; the Manager half in `--color-text-secondary` (`DESIGN.md:187`).
- **Sorting is view state and never changes a figure.** The sorter is a core function over rows it does not construct, held in one `$state` on the page — `board/+page.svelte:110-111` + `core/board.ts:527` is the pattern, copied not reinvented. Default is Team name.
- **The median is computed over the unsorted set** and is identical under every sort order. It states how many Teams it covers.
- The page carries `figuresAgeSentence` page-level in anything but Live. The index takes the **age** branch of the freshness rule — there is no control here to disable (`EXPERIENCE.md:139`).
- No `.svelte` file words anything: every string originates in `src/lib/core/`. Money through `describeAmount`/`formatMoney` only; a Team is spelled out with its Manager(s).
- The guard is `requireLiveDestination(session, phase, 'teams')` FIRST, before any read.
- Absolute times derive **only inside `$effect`** (`teams/[teamId]/+page.svelte:145-147`).

**Ask First:**
- Any new `--size-*` or `--color-*` token (`tokens.test.ts` pins exactly ten sizes and twenty colours); any change to `evaluate()`, to any gate, or to `teamViewFor`'s **existing** fields; any edit to a planning artifact.

**Never:**
- **Any comparison against the median.** No colour, badge, rank, ordinal, arrow, chip or annotation by a Team's position relative to it; no copy calling a Team ahead, behind, rich, poor, stacked, thin or under pressure (`EXPERIENCE.md:131-133`). The word is *median*, never *average*.
- A **mean of two middles**, a rounded mean, or a second money format. `$4.25M` and a two-decimal rendering are both defects.
- A **hardcoded 30.** No such constant exists and none is added; the median and the count are over the list actually read.
- The **Contract Assignment Year Allotment column swap** — resolved 2026-09-03: deferred to Epic 6. No `ContractLengthAssigned` event, no allotment projection and no `contract_length` column exists (`constants.ts:133` is a bare constant); 4.2 and 4.5 logged the same gap. The index renders its cap and slot columns in Contract Assignment and Archived unchanged.
- **Maximum Bid, its breakdown, or Roster Reserve** on any row — including the viewer's own. `teamViewFor` is called with `viewerIsThisTeam: false` for every row, so the three optional fields are structurally absent and a published Roster Reserve cannot recover a rival's Maximum Bid by subtraction (`spec-4-5` Spec Change Log).
- A write, a lock, or any client write path. The route reads and rolls back.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 30 Teams, any viewer | `teams` rows exist | every Team is a row carrying identity, `Roster N of 12`, Minor League `N of 3`, Injury Reserve outside the twelve, Cap Space, Committed Bids, Available Cap Space and Nomination Slot status; each links to `/teams/<id>` | N/A |
| **§10 example 28, money** | 15th Available Cap Space `$4,000,000`, 16th `$4,500,000` | median is **`$4,000,000`** → `$4.0M`; never `$4,250,000`, never `$4.3M`, never `$4.25M`; `isOnMoneyGrid` true | N/A |
| **§10 example 28, slots** | 15th Free Active/Bench `2`, 16th `3` | median is **`2`**, never `2.5` | N/A |
| Odd count | 29 Teams | the single middle value, both figures | N/A |
| One Team | 1 row | that Team's own figures are the median | N/A |
| No Teams | zero `teams` rows | median is stated unavailable, not `$0.0M` and not `0`; a designed empty state | N/A |
| A figure missing on some Team | `availableCapSpace === null` for a Team | that Team contributes no value; the median line states the count it actually covers | N/A |
| Viewer bound to a Team | `viewerTeamId` matches one row | that row carries the 2px left edge and `— you` **in place of** the Manager name, and sits wherever the sort puts it | N/A |
| Viewer bound to no Team | `viewerTeamId` null | thirty ordinary rows, no marker anywhere, median unchanged | N/A |
| Any viewer, any row | any Team | **no** Maximum Bid, cap breakdown or Roster Reserve in the rendered payload or the source | N/A |
| Sort changed | user picks Available Cap Space | rows reorder; **every figure and the median are byte-identical** to the default order | N/A |
| Co-managed Team | two `managers` rows share `team_id` | every Manager named, Team named once — unless it is the viewer's, where `— you` replaces the Manager half | N/A |
| Contract Assignment | phase is `Contract Assignment` | the index renders with cap and slot columns unchanged (swap deferred to Epic 6) | N/A |
| Archived | phase is `Archived` | renders frozen and read-only | N/A |
| Setup | phase is `Setup` | 403 via `requireLiveDestination` — `teams` is absent from Setup's catalog (`destinations.ts:63-73`) | the guard |
| Signed-out viewer | non-registered session | 403 via `requireLiveDestination` | the guard |
| Freshness below Live | client not Live | page-level `figuresAgeSentence`; nothing disabled, because nothing here authorises | N/A |
| Read fails | database unreachable | rollback, rethrow — never a page of zeroes or a short list | rollback, rethrow |

</frozen-after-approval>

## Code Map

- `src/lib/core/money.ts` — `Money` `:32`, `parseMoney` `:66`, `compareMoney` `:133` (**exists precisely for "explicitly sorted sequences (AD-1 forbids incidental order)"** — the median's ordering primitive, not a new one), `isOnMoneyGrid` `:155`, `formatMoney` `:169`, `MINIMUM_INCREMENT` imported `:25`. The median goes **here** per `ARCHITECTURE-SPINE.md:122`. There is **no** median/average/percentile/mean helper anywhere under `src/lib/core/` today — verified by grep; this story creates the first.
- `src/lib/core/constants.ts` — `MINIMUM_INCREMENT = 500_000` `:34` (the grid), `SALARY_CAP :18`, `ACTIVE_BENCH_SLOTS = 12 :98`, `INJURY_RESERVE_SLOTS :120`, `MINOR_LEAGUE_SLOTS = 3 :126`, `NO_AUCTION_PROBE_ID :117`, `YEAR_ALLOTMENT :133` (**a bare constant — no event, projection or column backs it**). **No team-count constant exists; do not add one.**
- `src/lib/core/team-view.ts` — the whole story's engine. `teamViewFor` `:478-552` (params `:478-487`); `TeamView` `:207-255`; `baselineCapOutcome` called once per Team `:490`; `amountLabel` `:269` and `FIGURE_UNAVAILABLE :112`; `rosterSlotSentence :290` (**the clamped `ACTIVE_BENCH_SLOTS − rosterCount` derivation — the slot median must reuse this number, not respell it**); `slotSentenceHalves :146`; `TEAM_VIEW_LABELS :76`; `ROSTER_GROUP_ORDER :63`. **`TeamView` carries only `*Label` strings for money (`:222-225`) — no raw `Money`.** The index needs numbers to sort and to median, so this story widens `TeamView` with the raw figures beside their labels; `outcome.capSpace` and friends are `Money | null` (`amountLabel :269` proves it), so the raw fields are `Money | null` too. Doc-comments `:8`, `:32-34` already say the median is this story's and belongs in `core/money`.
- `src/lib/core/board.ts` — **the view-state and wording template, copied not invented.** `BoardSort :60`, `SORT_KEYS :66`, `DEFAULT_SORT :76`, `SORT_LABELS :190`, `BOARD_SORT_LEGEND :205`, `sortBoard<T extends Sortable> :527` (generic over rows it does not build — why sorting cannot change a figure), `boardCountSentence :284` (the 0/1/N count-sentence pattern for `30 teams`), `filteredNoticeSentence :261`, `EMPTY_BOARD_HEADING :225`. Module header `:23-29` states the "every string is here, imported never respelled" rule.
- `src/lib/core/team-identity.ts` — `formatTeamManagers :69`, `teamManagerSuffix :101` (the Manager half alone, so the row sets two registers without splitting on the em dash).
- `src/lib/core/freshness.ts` — `figuresAgeSentence :166`, `deriveFreshness :111`, `FRESHNESS_HEADINGS :131`.
- `src/lib/server/team-view.ts` — the assembly to generalise. `loadTeamView :130`; `begin :137`; one `loadEventsViaClient :145`; five folds `:146-150` (**all league-wide already — hoist unchanged**); `select now()` + `requireDatabaseClock :156-157`; `loadTeamIdentity :95-118` with `where t.id::text = $1 :103` (**the only single-Team filter — drop it, add `order by t.name asc`, collapse into a `Map` by team id**); `loadTeamRosterDetail :169`; `teamMoneyStateFor :171-186` (per Team, `NO_AUCTION_PROBE_ID :175`); `teamViewFor :188-197`; `rollback :199`; catch/rethrow `:202-206`; `finally release :207-209`.
- `src/lib/server/team-roster.ts` — `loadTeamRosterDetail :162-219`, SQL `:167-172` `where team_id = $1`; the concat with `contractsWonBy :187`; the single counting loop `:199-212` (**sums across all rows into one Team's figures — a league-wide read must group by `team_id` before this loop, not after**); `computeCapSpace :216`; `TeamRosterDetail :139`; `loadTeamRoster :222` delegates.
- `src/lib/server/positions.ts` — the batch-read precedent: `where fantrax_player_id::text = any($1::text[])` `:164-169`, same shape for managers `:199-203`. No advisory lock, and why: `:9-11`.
- `src/lib/server/auction-open.ts:93-98` — the league-wide `teams left join managers ... order by t.name asc` with **no `where`**, and the Map-collapse by team id `:104-117` that keeps a co-managed Team from being named twice. This is the identity read for thirty Teams.
- `src/lib/server/destinations.ts` — `destination('teams', 'Teams', '/teams', false)` at `:79` (Auction), `:87` (Contract Assignment), `:94` (Archived); absent from Setup `:63-73`. `requireLiveDestination :136-143`, refusing with 403 `:124,127`.
- `src/lib/core/projection/nominations.ts` — `nominationForTeam :199-205`; `nominations.byTeam` is the `Record<string, OpenNomination>` `:165` to read directly for thirty Teams rather than calling the accessor in a loop.
- `src/routes/teams/[teamId]/+page.server.ts` — guard FIRST `:51`, `actorFrom :43-48`, `error(404) :58-60`, return shape `:62-68`. The new index route copies its guard order and its `actorFrom`.
- `src/routes/teams/[teamId]/+page.svelte` — the presentation precedent: core-wording imports `:25`, `figuresAge` derived once `:117-121` and rendered at `:176`, absolute time `$effect` `:145-147`, `{#each}` rows `:287-295`, and the `<style>` rules that already implement `DESIGN.md`'s Teams row: `.team-identity :315-319`, `.team-manager :327-329`, `.row` with `border-bottom :354-362`, `.figure :390-395`, `.figure-qualifier :410-412`, `.figure-tertiary :418-423`.
- `src/routes/board/+page.svelte` — `$state<BoardSort>` `:110-111`, native radio `fieldset`/`legend` with `bind:group` `:292-322`, `$derived(sortBoard(...))` `:169`, and the rule stated in comment `:14-17`.
- `_bmad-output/planning-artifacts/ux-designs/ux-BBSL-Appspiration-2026-08-17/DESIGN.md:178-191` — the Teams row verbatim: 1px `border` rules not card gaps `:179`; `ui` 15px not Georgia `:181`; labels 10px uppercase `0.16em` `text-tertiary`, `of 12` in `text-secondary`, IR in `text-tertiary` outside the group `:183`; the 2px own-row edge `:185`; both name registers `:187`; **the median line at the foot behind a `border-strong` rule, labelled *median* at 10px uppercase, figures in `text-secondary` at 15px, quieter than every row `:189`**; nothing coloured by comparison, greyscale **identical** `:191`.
- `.../mockups/Teams.dc.html` — the only index mockup: header with a `30 teams` count `:23`; sort chips `:26-34` (`Team name` active, `Available`, `Free slots`, `Cap space`); the viewer's row `:38-58` with `border-left: 2px` and `— you` `:40`; ordinary rows `:60-190`; the median block `:196-203` captioned `Median · 30 teams` with `2 free slots` / `$4.0M available` and the grid rationale spelled out.
- `_bmad-output/planning-artifacts/prds/.../prd.md:780` — §10 example 28 verbatim, both halves. `:126` the Glossary entry. `:495-520` FR-39's testable consequences.
- Tests: `tests/server/team-view.test.ts:25-61` `fakeGateway()` — options `{failOn, events, teams, rosterRows}` `:26-31`, dispatch `:46-52`, and it **throws on any unexpected statement** `:53`, so a new league-wide read must be added to the fake deliberately. `tests/money.test.ts` — `describe` blocks `:29,101,134,167,191,208,257`; the median's tests join it. `tests/examples/example-26-off-grid-everywhere.test.ts:1-25` — the §10 example shape: JSDoc citing `PRD §10 example N — **title** (AD-25)`, the example restated as a `>` blockquote, prose on what it proves, then core-only imports via relative `../../src/lib/core/*.ts`. `tests/routes/team-view.test.ts:263-283` — the source-text assertions (`not.toMatch(/\$lib\/server/)`, every label literal absent from the page, `figuresAgeSentence` present). `tests/tokens.test.ts:157-177,216-230` pins the twenty colours and ten sizes. Purity: `scripts/check-core-purity.js` — relative core imports must carry `.ts`; no ambient globals.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/money.ts` — add the League Median. One private helper holding the **lower-of-two-middles index rule spelled exactly once**, and two exports over it: `medianMoney(values: readonly Money[]): Money | null` sorting a **copy** via `compareMoney`, and `medianCount(values: readonly number[]): number | null` for slots. Empty input → `null`, never `0`. Document why the mean is refused, citing the grid and `ARCHITECTURE-SPINE.md:122`.
- [x] `src/lib/core/team-view.ts` — widen `TeamView` with the raw figures the index must sort and median: `capSpace`, `committedBids`, `minorsExposure`, `availableCapSpace` (each `Money | null`, taken from the same `outcome` fields their labels already use) and `freeActiveBenchSlots: number`. Extract the clamped free-slot arithmetic out of `rosterSlotSentence` `:290` into one function both it and the new field call, so the figure and the sentence cannot disagree. No existing field changes shape.
- [x] `src/lib/core/teams-index.ts` — new pure module owning **every string and every ordering** the index prints. `TeamsSort = 'name' | 'availableCapSpace' | 'freeActiveBenchSlots' | 'capSpace'`, `TEAMS_SORT_KEYS`, `DEFAULT_TEAMS_SORT = 'name'`, `TEAMS_SORT_LABELS`, `TEAMS_INDEX_TITLE`, `TEAMS_SORT_LEGEND`, `teamCountSentence`, `MEDIAN_LABEL` (*median*, never *average*), `medianCoverageSentence`, the empty-state wording, and the own-row `— you` marker string. `sortTeamsIndex(rows, key)` sorts a copy and is generic over rows it does not construct (`board.ts:527`'s shape), tie-breaking totally on Team name so no order is incidental. `teamsIndexFor({views, viewerTeamId})` returns the rows plus the median line, computing the median from the **unsorted** views and stating its coverage count. `href` per row via the existing path shape, not a respelt literal.
- [x] `src/lib/server/team-roster.ts` — add a league-wide `loadLeagueRosterDetail(client, teamIds, contracts)` reading `team_rosters` for all Teams in one statement (`any($1::text[])`, `positions.ts:164-169`'s pattern), grouping rows by `team_id` **before** the counting loop, and returning `Map<string, TeamRosterDetail>`. Extract the existing concat-and-count body `:174-219` into one function both it and `loadTeamRosterDetail` call; `loadTeamRosterDetail` and `loadTeamRoster` keep their signatures. A Team with no rows yields a real empty detail, not a missing map entry.
- [x] `src/lib/server/teams-index.ts` — new `loadTeamsIndex(gateway, viewerTeamId)`: one transaction, one `loadEventsViaClient`, the same five folds, one `select now()`, then the league-wide identity join (`auction-open.ts:93-98` with the `Map` collapse) and `loadLeagueRosterDetail`; then per Team `teamMoneyStateFor` at `NO_AUCTION_PROBE_ID` and `teamViewFor` with **`viewerIsThisTeam: false`**, and finally `teamsIndexFor`. Always `rollback`; rethrow a read failure. Zero Teams is a real empty answer, not `null`.
- [x] `src/routes/teams/+page.server.ts` — `requireLiveDestination(locals.session, locals.phase.name, 'teams')` FIRST, then `loadTeamsIndex(writeGateway(), actorFrom(locals.session)?.teamId ?? null)`; return `{ phase, index }`. Copies `teams/[teamId]/+page.server.ts:43-68`.
- [x] `src/routes/teams/+page.svelte` — the thirty rows, each linking to `/teams/<id>`; sort as one `$state<TeamsSort>` feeding `$derived(sortTeamsIndex(...))` with native radio `fieldset`/`legend` (`board/+page.svelte:292-322`); the own row's 2px `--color-border-strong` left edge and `— you` replacing the Manager half; the median line at the foot behind a `border-strong` rule, quieter than every row; page-level `figuresAgeSentence` in anything but Live; the empty state. No wording of its own, no colour by comparison, no new token.
- [x] `tests/examples/example-28-the-median-lands-between-two-grid-values.test.ts` — §10 example 28 in the established shape (`example-26`'s JSDoc + blockquote + core-only imports). Both halves: the 15th/16th of `$4,000,000`/`$4,500,000` yielding `$4,000,000` and rendering `$4.0M`, asserting `isOnMoneyGrid` and that `formatMoney` does **not** throw; and the 15th/16th of 2/3 slots yielding `2`. Assert the mean is *not* produced.
- [x] `tests/money.test.ts` — the median's own unit coverage beside the existing describes: odd and even counts, one value, empty → `null`, unsorted and reverse-sorted input reaching the same answer, negative amounts, and that the input array is not mutated.
- [x] `tests/teams-index.test.ts` — the I/O matrix through the core: all rows present, the own-row marker on exactly one row and never a reorder, every sort producing identical figures and an identical median, the median over the unsorted set, a null figure shrinking the stated coverage, co-managed naming, the empty state, and an assertion that no exported string contains "average", "above", "below", "rank", "rich" or "poor".
- [x] `tests/server/teams-index.test.ts` — `loadTeamsIndex` against an extended `fakeGateway()`: **exactly one** log read and one `select now()` for thirty Teams (the no-second-computation guarantee, asserted by counting statements), no advisory lock, always `rollback`, rethrow rather than a short list, and a real assembly exercising the roster grouping and the co-manager collapse.
- [x] `tests/routes/teams-index.test.ts` — the guard runs first; the load shape; source-text assertions that the page imports no `$lib/server`, words nothing itself, carries `figuresAgeSentence`, and contains no Maximum Bid or cap-breakdown symbol.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` — append the Contract Assignment Year Allotment column swap (owner Story 6.1), and close the loop on 4.5's entry that `/teams/[teamId]` was reachable only by direct URL.

**Acceptance Criteria:**
- Given the index and `/teams/<id>` for the same Team side by side, when every shared figure is compared, then each is identical — because both are the same `teamViewFor` call over the same fold, and no figure is computed in `teams-index.ts`.
- Given a greyscale screenshot of the index, when it is compared to the colour original, then it is **identical** — nothing on the surface is distinguished by colour, including the viewer's own row and the median line.
- Given any string on the page is traced, then it originates in `src/lib/core/`, and no `.svelte` file under `src/routes/teams/` contains a user-facing sentence.
- Given the rendered payload and the page source are both searched, then neither contains a Maximum Bid figure, a cap breakdown row, or a Roster Reserve figure for any Team.
- Given a Manager sorts the index every available way, when the figures and the median line are compared across all four orders, then they are byte-identical and only the row order differs.
- Given `npm run check:purity`, when it runs over `core/money.ts` and `core/teams-index.ts`, then both pass — the median reaches no clock, no randomness and no I/O.

## Design Notes

**Why `TeamView` gains raw figures rather than the index parsing labels.** `TeamView` publishes `availableCapSpaceLabel` and no `availableCapSpace`. A median needs the number. The two ways to get one are to widen the type or to re-derive the figure in `teams-index.ts` — and the second is exactly the second computation `epic-4-context.md:56` exists to forbid. Widening is additive, changes no existing field, and keeps the label and the number provably the same value because they are taken from one `outcome` field on one line.

**Why the median is not `Math.round(mean)`.** The mean of `$4,000,000` and `$4,500,000` is `$4,250,000`, which `formatMoney` **throws** on (`money.ts:169`, `RangeError`) because it is off the `MINIMUM_INCREMENT` grid. Rounding it publishes a figure no Team holds and that no Manager can reproduce by hand. The lower middle is always some real Team's number, always on the grid, and renders losslessly at one decimal — which is the property every abbreviated figure in the product rests on.

**Why one index rule for two types.** The slot half of example 28 (`2`, not `2.5`) is the same rule as the money half. Written twice they can drift; written once as an index into a sorted copy, `medianMoney` and `medianCount` differ only in their comparator. Half a roster slot is not a thing that exists, and neither is a quarter-million-dollar grid step.

**Sort chips versus the board's fieldset.** `Teams.dc.html:26-34` draws chips; `board/+page.svelte:292-322` ships native radios in a `fieldset` styled to read as chips. Follow the board — it is the built, tested and accessible precedent, and it makes "sorting is view state" visible in the markup rather than asserted in a comment.

## Verification

**Commands:**
- `npm test` — expected: green, with `tests/examples/example-28-*.test.ts`, `tests/teams-index.test.ts`, `tests/server/teams-index.test.ts` and `tests/routes/teams-index.test.ts` collected and executed, and `tests/team-view.test.ts`, `tests/server/team-view.test.ts`, `tests/routes/team-view.test.ts`, `tests/strip.test.ts` and `tests/board.test.ts` still passing.
- `npm run check` — expected: 0 errors, 0 warnings.
- `npm run check:pins` — expected: pass.
- `npm run check:purity` — expected: pass.

**Manual checks (if no CLI):**
- Open `src/routes/teams/+page.svelte` beside `DESIGN.md:178-191` and `mockups/Teams.dc.html:38-58,196-203` and match each visual rule to the selector carrying it — nothing in this repository can render a component, so this reading is the only gate that exists.
- Reproduce example 28 by hand from the rendered index: sort by Available Cap Space, read the 15th and 16th rows, and confirm the median line reports the 15th.

## Suggested Review Order

**The League Median — the one rule this story adds**

- The lower-of-two-middles index, spelled once; `ceil(n/2)-1` picks the 15th of 30.
  [`money.ts:221`](../../src/lib/core/money.ts#L221)

- Money median over a sorted copy via `compareMoney`; `null` on empty, never `$0.0M`.
  [`money.ts:249`](../../src/lib/core/money.ts#L249)

- Slot median through the same index — 2 and 3 give 2, never 2.5.
  [`money.ts:266`](../../src/lib/core/money.ts#L266)

- §10 example 28 made executable, both halves.
  [`example-28.test.ts:1`](../../tests/examples/example-28-the-median-lands-between-two-grid-values.test.ts#L1)

**One computation, thirty renderings**

- The index assembled from `TeamView`s; median taken over the unsorted set.
  [`teams-index.ts:507`](../../src/lib/core/teams-index.ts#L507)

- One transaction, one log read, one clock; `viewerIsThisTeam: false` on every row.
  [`teams-index.ts:141`](../../src/lib/server/teams-index.ts#L141)

- `TeamView` widened with raw figures so nothing re-derives a number to sort it.
  [`team-view.ts:350`](../../src/lib/core/team-view.ts#L350)

**The league-wide reads**

- Thirty Teams' rosters in one statement, grouped by team before the counting loop.
  [`team-roster.ts:273`](../../src/lib/server/team-roster.ts#L273)

- Identity join with no `where`; orders managers so the index and Team view agree.
  [`teams-index.ts:103`](../../src/lib/server/teams-index.ts#L103)

**Wording and ordering, all core-owned**

- Sorting generic over rows it does not construct — why it cannot change a figure.
  [`teams-index.ts:407`](../../src/lib/core/teams-index.ts#L407)

- The median phrase composed in core, so the surface joins nothing.
  [`teams-index.ts:329`](../../src/lib/core/teams-index.ts#L329)

- The grid note states exact dollars, not the abbreviation it exists to justify.
  [`teams-index.ts:175`](../../src/lib/core/teams-index.ts#L175)

- `— you` derived through `teamManagerSuffix`, so the em dash is spelled once.
  [`teams-index.ts:205`](../../src/lib/core/teams-index.ts#L205)

**The surface**

- Guard first, before any read; no 404, because an empty League is an answer.
  [`+page.server.ts:47`](../../src/routes/teams/+page.server.ts#L47)

- Sort held as one piece of view state over the core's function.
  [`+page.svelte:71`](../../src/routes/teams/+page.svelte#L71)

**Supporting**

- Every row reserves the marker edge, so marking one never moves it.
  [`teams-index.test.ts:396`](../../tests/routes/teams-index.test.ts#L396)

- A Manager-less Team stays on the index — the `left join` regression guard.
  [`teams-index.test.ts:339`](../../tests/server/teams-index.test.ts#L339)
