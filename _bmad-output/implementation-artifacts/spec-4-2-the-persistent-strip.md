---
title: 'Story 4.2: The persistent strip'
type: 'feature'
created: '2026-09-01'
status: 'done'
baseline_commit: '4c65c94f3e22a5d40005031529804bd55a284915'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-BBSL-Appspiration-2026-08-16/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The one number the whole app exists to compute is reachable on exactly one screen. A Manager on the Nominate page, the import screen or the eligibility list has no idea what they can spend or how many Slots they hold, and must navigate to an Auction to find out. Navigation is equally thin: the only trigger is a `<details>` disclosure in the header.

**Approach:** A 52px strip, present on every surface, carrying Maximum Bid and Roster Count and doubling as the destinations trigger. The figure is `evaluate()` output derived in the browser from transported facts — never a stored, memoised or server-computed number — so it recomputes on every projection change the freshness contract already forces a reload for.

## Boundaries & Constraints

**Always:**
- The strip's Maximum Bid is the **baseline** figure: `evaluate()` run against a no-Auction state with the Player treated as not Minor League Eligible. That is the money ceiling applying to every non-eligible Auction, and it means one label with one meaning on every screen.
- On the Auction page the strip may legitimately read **lower** than that page's own panel, which excludes that Auction's own lead from Committed Bids. The panel remains the authority for bidding; the strip is orientation.
- Facts cross the wire, never derived money (AD-7). The layout ships `TeamMoneyState`; the browser calls `evaluate()` itself. Shipping `maximumBid` would make the transported number the check.
- The sheet renders the **same `DestinationsList` component** the header menu renders (AD-30). One list, two triggers — never a copy, never a second resolution.
- Sized from `--strip-height` (`tokens.css:101`), never a `52px` literal.
- Non-Live states label the figure via the existing `MAXIMUM_BID_LABELS` (`core/freshness.ts:208`). No second wording, no second freshness derivation.
- Every sentence the strip says is worded in `src/lib/core/`. No `.svelte` file words a figure or a label.
- Nothing under `src/lib/client/` or any component imports `$lib/server` (`tests/structure.test.ts:261-279`).

**Ask First:**
- Any new `--size-*` token, or any edit to `DESIGN.md` (see `deferred-work.md`, appended this story).
- Any breakpoint other than the 640px four route files already use.

**Never:**
- The Bid Board (4.3), Your Positions (4.4), any Team view (4.5/4.6), or the League Median.
- Assignment progress in Contract Assignment — the Year Allotment does not exist (deferred to 6.1).
- A per-Auction figure on the strip, a memoised figure, or a figure computed server-side and serialised.
- A countdown, an "ending soon", a suggested amount, or any urgency device.
- A focus-trapping modal. The disclosure pattern is `<details>`, as `HeaderMenu.svelte:44` already establishes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Auction Phase, team bound | signed in, `teamId` set, phase `Auction` | strip renders `Maximum Bid` + figure + `Roster 9 of 12` | N/A |
| Contract Assignment | same, phase `Contract Assignment` | Roster Count only; no Maximum Bid half, no progress figure | N/A |
| Archived | same, phase `Archived` | Roster Count only | N/A |
| Setup | same, phase `Setup` | no strip at all — no roster has been promoted, so there is no count to state | N/A |
| Signed out | no session | no strip, no sheet, no server read | N/A |
| Signed in, no team | `manager.teamId` is `null` | no strip — a Commissioner with no Team has no figure and no Slots | N/A |
| Unbounded is unreachable here | baseline probes a non-eligible Player | an ordinary money figure, never "no cap limit" | N/A |
| Negative Maximum Bid | overcommitted Team | rendered as the negative it is, never clamped to `$0.0M` | N/A |
| Reconnecting / Stale | freshness non-Live | label becomes `Maximum Bid — last known`; figure still shown | N/A |
| Tap the strip | any rendered state | opens the destinations sheet: the same list, same phase and role filtering | N/A |
| Desktop | viewport ≥ 640px | strip sits in the header, not pinned to the bottom; Maximum Bid still visible | N/A |
| Roster read fails | database unreachable | no strip; the page still renders | the layout load must not 500 a whole page over a strip |

</frozen-after-approval>

## Code Map

- `src/lib/core/strip.ts` -- NEW. `stripPresent`, `stripShowsMaximumBid`, `rosterCountSentence`, `STRIP_SHEET_LABEL`, `STRIP_REGION_LABEL`, `baselineMaximumBid`. The private `probeFor()` builds the `PlaceBid` `evaluate()` requires.
- `src/lib/server/strip.ts` -- NEW. `loadStripTeam(gateway, teamId)`; one transaction, one `loadEventsViaClient`, four folds, `loadTeamRoster`, `teamMoneyStateFor`, always `rollback`, `null` on any failure.
- `src/lib/components/PersistentStrip.svelte` -- NEW. `<details>` + `DestinationsList`, `$derived.by` figure (guarded), `MAXIMUM_BID_LABELS[freshness.state]`, `afterNavigate` / Escape / click-outside close, `--strip-height` / `--strip-figure-size`, the 640px reflow.
- `tests/strip.test.ts` -- NEW. The phase table, the baseline (including the negative and the null-Team rows), `loadStripTeam` executed against a fake client, and the source-text surface claims.
- `src/lib/core/constants.ts` -- `NO_AUCTION_PROBE_ID`.
- `src/lib/styles/tokens.css` -- `--strip-figure-size: 17px`, in the non-frontmatter block.
- `src/lib/styles/global.css` -- `body:has(.strip) { padding-bottom: var(--strip-height) }`, released at 640px.
- `src/routes/+layout.server.ts` -- `stripTeamFor`; `stripTeam` on the returned object.
- `src/routes/+layout.svelte` -- the mount, gated on `data.stripTeam !== null`, positioned between `HeaderMenu` and the page content.
- `tests/layout.test.ts` -- `load` is async now; `loadLayout` helper, `$lib/shell/db.ts` faked, plus the strip's own gate assertions.

### As planned


- `src/lib/core/rules/bidding.ts:1550` -- `evaluate(state, command, now)`. `:1303` `evaluateCap` computes `maximumBid` at `:1349`. `:502` `bidStateFor(auction, team, playerIsMinorLeagueEligible, phase)` — passing `auction: null` gives the no-Auction state the baseline needs. `:596` `teamMoneyStateFor({...})` is the one narrowing; `:2114` `describeAmount` renders money in words.
- `src/lib/core/types.ts:249-256` -- `PlaceBid` requires `teamName` and `managerId`; no gate the baseline reads touches either. `:677` `PlaceBidGateResults`; `:479` `cap.maximumBid: Money | null`.
- `src/lib/core/constants.ts:98` -- `ACTIVE_BENCH_SLOTS = 12`. The `of 12` comes from here, never a literal.
- `src/lib/core/freshness.ts:208-212` -- `MAXIMUM_BID_LABELS`, already `Maximum Bid` / `Maximum Bid — last known`. `src/lib/client/freshness.svelte.ts` exports the `freshness` singleton; read `.state` as `auction/[fantraxPlayerId]/+page.svelte:381,834` does.
- `src/lib/server/auction-page.ts:465-545` -- `loadAuctionPage`: `begin`, `loadEventsViaClient`, folds nominations/auctions/eligibility/contracts/phase over ONE events array, `loadTeamRoster`, then `teamMoneyStateFor`. The strip's server read is this shape minus the Auction-specific half. Copy the one-read discipline.
- `src/lib/server/team-roster.ts:113` -- `loadTeamRoster(client, teamId, contracts) => { capSpace, rosterCount, minorLeagueOccupied }`. Team-level already; nothing new is needed to count Slots.
- `src/routes/+layout.server.ts:41-48` -- the one load every page inherits; `watermark`, `serverInstant` and `signedIn` already ride here. `src/hooks.server.ts:54-56` puts `locals.phase` and `locals.watermark` on the request.
- `src/routes/+layout.svelte:84-108` -- `HeaderMenu`, then the gated `FreshnessNotice`, then the phase panel, then `{@render children()}`. The strip mounts here, once, for the same AD-29 reason the notice does.
- `src/lib/components/DestinationsList.svelte` -- the list, taking `destinations` as a prop and declaring `Destination` structurally. Reuse unchanged. `HeaderMenu.svelte:43-52` is the `<details>` trigger precedent, `:38-40` the `afterNavigate` close.
- `src/lib/styles/tokens.css:101` `--strip-height: 52px`; `:24` `--color-surface`; `:30` `--color-border-strong`; `:45` `--color-brand`; `:38` `--color-text-secondary`; `:62` `--font-display`; `:107-128` the `--control-fill` precedent for a documented non-frontmatter token.
- `tests/tokens.test.ts:216-230` -- exactly ten `--size-*` tokens; a `--size-17` would fail. `tests/structure.test.ts:249-279` allows `src/lib/client` but forbids `$lib/server` reaching it; `:281-291` is the source-text assertion convention, since no `.svelte` file is renderable (`vite.config.ts:4-10`, node environment).
- `src/routes/nominate/+page.svelte:395` -- the `@media (min-width: 640px)` value the repo already uses in four route files.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/constants.ts` -- add `NO_AUCTION_PROBE_ID`, the id the baseline probe carries -- the probe needs an id AD-5's exposure tiebreak can sort on, and a named constant says it addresses no real Auction.
- [x] `src/lib/core/strip.ts` -- new pure module: `stripShowsMaximumBid(phase)`, `stripPresent(phase)`, `baselineMaximumBid(team, phase, now)` calling `bidStateFor(null, team, false, phase)` then `evaluate()` and returning `cap.maximumBid`, `rosterCountSentence(rosterCount)` built from `ACTIVE_BENCH_SLOTS`, and `STRIP_SHEET_LABEL` -- the whole phase table and every word in one testable place.
- [x] `src/lib/server/strip.ts` -- new `loadStripTeam(gateway, teamId)`: one transaction, one `loadEventsViaClient`, the folds `teamMoneyStateFor` needs, `loadTeamRoster`, returning `TeamMoneyState | null` -- facts only, no derived money crosses the wire (AD-7).
- [x] `src/routes/+layout.server.ts` -- return `stripTeam`, resolved only when signed in with a `teamId` and `stripPresent(phase)`; a read failure yields `null`, never a 500.
- [x] `src/lib/components/PersistentStrip.svelte` -- new: the `<details>` trigger wrapping `DestinationsList`, the figure derived by calling `baselineMaximumBid` in the browser, the label from `MAXIMUM_BID_LABELS[freshness.state]`, `afterNavigate` closing the sheet.
- [x] `src/routes/+layout.svelte` -- mount the strip once, gated on `data.stripTeam !== null` -- one strip, every surface.
- [x] `src/lib/styles/tokens.css` -- add `--strip-figure-size: 17px` to the documented non-frontmatter block, citing the `deferred-work.md` entry -- `DESIGN.md`'s scale has no 17px step and may not be hand-edited.
- [x] `src/lib/styles/global.css` -- reserve `--strip-height` of bottom room below page content on mobile so the strip never covers the last control; release it at 640px where the strip moves into the header.
- [x] `tests/strip.test.ts` -- unit-test every I/O matrix row through `src/lib/core/strip.ts`, plus source-text assertions that `PersistentStrip.svelte` renders `DestinationsList`, consumes `--strip-height`, imports no `$lib/server`, and contains no `52px` literal.

**Acceptance Criteria:**
- Given the strip renders, when its figure is traced, then it came from `evaluate()` called in the browser over transported facts, and no `maximumBid` field exists on anything the layout serialises.
- Given the strip's sheet and the header menu are both open, when their entries are compared, then they are the same component instance type over the same prop, and no second destination resolution exists in the codebase.
- Given a greyscale screenshot of any surface, when the strip is read, then the label, the figure and the Roster Count are all legible without colour.
- Given the viewport crosses 640px, when the layout adapts, then Maximum Bid remains visible and the strip is no longer pinned to the bottom.

## Spec Change Log

**2026-09-01 — code review, review loop 1.** The Desktop matrix row was implemented in CSS
but not in DOM order: the strip mounted after the page content, so `position: static` at
640px placed it at the FOOT of the document rather than in the header, and Maximum Bid was
reachable on desktop only by scrolling to the bottom of every surface. The mount moved to
sit between `HeaderMenu` and the page content. The row's test asserted only that
`position: fixed` / `position: static` appeared somewhere in the file — true of both the
correct and the broken arrangement — and was replaced by an assertion on the three mount
positions, read from the comment-stripped source.

Also corrected in the same pass: the strip's 1px border sat outside the height
`global.css` reserved (`box-sizing: border-box`); the bottom room was reserved on every
page including those where the strip does not mount (`body:has(.strip)`); the region
landmark was named for the sheet it contains rather than for the figures it announces
(`STRIP_REGION_LABEL`); the figure derivation had no client-side guard despite the
component being mounted by the root layout (`$derived.by` + `try`); the summary could wrap
past its reserved height (`flex-wrap: nowrap`, with the label as the only part that
elides); the persistent trigger had no focus ring, since `<summary>` is not covered by
`global.css`'s `:focus-visible` rule; the sheet closed only on navigation, not on Escape
or a click outside; and `rosterCountSentence` floors a corrupt negative count while still
stating a genuine overflow as the overflow it is.

Documentation corrected: the probe carries `MINIMUM_BID`, not the non-existent
`MINIMUM_OPENING_BID`, and `NO_AUCTION_PROBE_ID` as its `teamId` — verified harmless
because no cap gate reads `command.teamId`. Stale Code Map line numbers and the "41
assertions" count were removed rather than re-pinned, since both go stale on the next edit.

## Design Notes

**Why a probe command.** `epics.md:1450` fixes the figure as `evaluate()` output, and `evaluate` takes a `PlaceBid`. The baseline builds one — `NO_AUCTION_PROBE_ID` for every id field, and `MINIMUM_BID` for the amount — and reads `cap.maximumBid` alone. `passed` is deliberately ignored: the strip authorises nothing, and a probe reporting a refusal would answer a question nobody asked. `playerIsMinorLeagueEligible: false` is what makes the figure a single number rather than sometimes-unbounded. The probe carries `NO_AUCTION_PROBE_ID` as its `teamId` rather than the real Team's, which is safe because `command.teamId` is read only by `evaluateContention` and `evaluateSelfBid` (`bidding.ts:1566-1567`) and never by `evaluateCap` — a command that named a real Manager would look appendable, and this one is never appended.

**Why the strip can read lower than the Auction page.** `teamMoneyStateFor` excludes the Auction being bid on from `leading`, because a raise replaces that Team's own lead rather than adding to it. The strip excludes nothing, so a Team leading elsewhere sees its own commitments held against it — the true answer to "what can I spend on something new". The Auction page's panel keeps the per-Auction arithmetic, and 2.6's refusal remains the only place a bid is judged.

**The typographic pairing is load-bearing and was inverted once.** `DESIGN.md:222`, `epics.md:1435` and `House.dc.html:143-146` all put *Maximum Bid* — the words — in Georgia `brand`, with the figure at 17px in the `ui` face. The first implementation had it exactly backwards: Georgia on the figure, an invented uppercase-tracked register on the label. Nothing behavioural could see it, because both orderings render and every other assertion still passed. `tests/strip.test.ts` now pins each rule to its own selector, including that `--color-brand` never reaches the figure — `brand` is brand, and DESIGN.md forbids it signalling leading, winning or approval.

**What the build changed beyond the task list.**

- `tests/layout.test.ts` had to move: `+layout.server.ts`'s `load` is now `async` (it awaits the strip's read), so every existing assertion awaits it through one `loadLayout` helper, and the file faked `$lib/shell/db.ts` the way four route tests already do. The strip's own gate — signed out, unbound Manager, Setup, and the FACTS-only shape — is asserted there because that is where the real `load` is executed rather than read.
- `stripTeamFor` catches around `writeGateway()` as well as around the read. `writeGateway()` throws when `SUPABASE_DB_URL` is unset, which is a CONFIGURATION failure rather than a read one — but the matrix's requirement is identical either way, and a layout load that throws takes every page in the product down.
- The bottom room is reserved on `body`, not on `.page`. A surface that does not use the `.page` band still ends somewhere and still has a last control.
- The strip's summary carries a `visually-hidden` `STRIP_SHEET_LABEL`. What is VISIBLE on the trigger is two figures, so a screen reader reaching a `<summary>` reading "Maximum Bid $162.0M Roster 9 of 12" is told nothing about what expanding it does. The word is still the core's.

**Why `bare − committed` is not the lead's own amount.** `tests/strip.test.ts` asserts the difference a $5.0M lead makes as `$5.0M − $1.0M`, not `$5.0M`. The lead enters Committed Bids AND counts as a Projected Active/Bench Addition, so one unfilled Slot stops being reserved and $1,000,000 of Roster Reserve is released against it. Asserting the raw $5.0M would have been asserting that one of the two derivations does not run.

## Verification

**Commands:**
- `npm test` -- expected: all suites pass, including `tests/strip.test.ts` and the unchanged `tokens.test.ts` ten-`--size-*` assertion.
- `npm run check` -- expected: 0 errors.
- `npm run check:purity` -- expected: passes with `core/strip.ts` present — no `Date`, no `$lib`, explicit `.ts` specifiers.

**Manual checks (if no CLI):**
- No `.svelte` file is renderable by the suite. At 375px confirm the strip is 52px, does not cover the last control on the longest page, and that tapping it opens the same destinations the header menu lists; at 640px confirm it has moved into the header and Maximum Bid is still on screen.
