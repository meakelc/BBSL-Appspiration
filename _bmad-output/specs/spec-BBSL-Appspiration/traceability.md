# Traceability — BBSL Offseason Free Agent Auction

Companion to `SPEC.md`. Maps every capability to the requirements it realizes, the architecture decisions that govern it, the PRD §10 worked examples that test it, and where it lives in the source tree. Use it to check coverage before and after a change; use it when breaking capabilities into stories.

Referenced documents: `prd.md` (FR-1 – FR-44, §10 examples 1–57), `ARCHITECTURE-SPINE.md` (AD-1 – AD-32), `addendum.md` (§A–§G), `DESIGN.md` and `EXPERIENCE.md` (the UX contract, adopted as companions 2026-08-18).

Updated 2026-09-16: **CAP-24 (Retract a Bid inside ninety seconds) and CAP-25 (Rearrange a Roster's Slot Placements) added**, and this spec brought current across **three** upstream passes it had missed. FR-15 reversed from a prohibition to a rule, so CAP-5 stopped asserting that a Bid can never be withdrawn by its own Team. **CAP-22 was renamed Roster Trade** — the PRD gave "Roster Move" to FR-44 on 2026-09-12, so the old name made this contract violate its own fixed-vocabulary rule — and **FR-43's rookie-scale exception was struck from it**, having been deleted upstream on 2026-09-16 while this document still asserted it as current law. CAP-6, CAP-8, CAP-9, CAP-10, CAP-11, CAP-14 and CAP-21 each took an amendment. The example table below, which had silently stopped at 28, now runs to 57.

Updated 2026-09-10: **CAP-22 (Record a Roster Move or a Drop — *renamed Roster Trade 2026-09-16, when the PRD gave "Roster Move" to FR-44*) and CAP-23 (Detect a Roster Divergence) added**, by `sprint-change-proposal-2026-09-10.md` — managers trade and drop players in Fantrax while the auction runs, and both change the inputs to Maximum Bid. Two non-goals gave way: *"not a trade machine"* became *"not a trade broker"*, and *"not writing to Fantrax"* was restated as a **finding** rather than a choice, since re-verification found no write endpoint exists at all. The success signal now counts **corrective** overrides only — the old wording would have scored a recorded trade as an override and read a busy trade market as a failing product. New AD-32; **AD-31 is deliberately unamended**, its cancellation trigger preserved word for word by the decision to refuse rather than cascade. A second, unrelated gap surfaced while specifying this and is carried in the same change: Dead Money was not modelled and the `2RK` rookie designation was discarded at import — latent, since no Team carries dead money today, but wrong from the first mid-auction drop. **CAP-23 is the first capability in this spec carrying a contingency marker**; it depends on an undocumented endpoint that has never been called against this league. *This time the correct-course impact analysis routed a step to the SPEC — see the 2026-09-08 note below for why that is worth recording.*

Updated 2026-09-08: **CAP-21 (Cancel a surplus commitment and restore the Auction) added and CAP-19 rewritten**, by `sprint-change-proposal-2026-09-07.md` — the Outstanding Bid Allowance. A Team may hold one outstanding Bid beyond its free Slots, and the surplus is cancelled at the Close that fills its roster. Ripples: CAP-8's lottery entries leave the capacity gate entirely (cap space is now their only limit); CAP-11's cancellation and restoration mentions ride the **existing `outbid` category** rather than a fourth; CAP-5, CAP-6, CAP-7 and CAP-20 each gained a clause. New AD-31, with AD-2, AD-11, AD-22 and AD-25 amended. **This spec was the last artifact still carrying the pre-allowance rule** — caught by the sprint-planning readiness gate, three artifacts after the change was approved, because the correct-course impact analysis listed the SPEC in scope but routed no step to it. *Fourth instance of the standing lesson: what nobody is assigned to update does not get updated.*

Updated 2026-09-05: **Epic 9 (Stand it up and let the league in) added** by `sprint-change-proposal-2026-09-05.md`, carrying provisioning, league seeding, the AR-33 real-export confirmation, the setup runbook, a moderator pilot and prod setup day. **No capability changed, no FR moved, no AD touched, and no row in the map below is affected** — Epic 9 adds nothing to the contract; it executes CAP-1 – CAP-14 against real infrastructure for the first time. The one row worth reading alongside it is CAP-15/16/17, whose Epic 8 stories are the go-live gate Epic 9 feeds.

Updated 2026-08-18 (second): **CAP-20 (Teams index) and FR-39 added**, with §10 example 28. Two ripples: CAP-10's own-team-only reservation on Free Minor League Slots and Minors Exposure was removed as unenforceable, making every Team figure public except the per-Auction Maximum Bid; and the $500,000 grid was restated as a product-wide invariant binding every derived figure, which is what forces League Median to be the lower middle value rather than the mean of the two middle values. No AD changed and no other capability moved.

Updated 2026-08-18: the architecture spine grew to 30 ADs and the UX spines were adopted. AD-28 (staged import), AD-29 (read freshness) and AD-30 (phase/role surface gating) are new; AD-1's contract widened to `evaluate()` + `Rejected<GateResults>`. No capability IDs changed and no FR moved. Previously updated 2026-08-17 for the commissioner's answers to all nine open questions, which brought CAP-18, CAP-19, FR-37, FR-38 and examples 24–27.

## Capability map

| Capability | FRs | ADs | §10 examples | Lives in |
| --- | --- | --- | --- | --- |
| CAP-1 Import and open | FR-1, FR-2, FR-3 | AD-24, **AD-28**, AD-8, AD-23, AD-26, AD-5 | — | `adapters/fantrax/`, `routes/admin/import` |
| CAP-18 Set eligibility by hand | FR-38 | AD-24, AD-5, AD-4, AD-16 | 18–22, 25 (all depend on the flag) | `routes/admin/eligibility` |
| CAP-2 Identity and roles | FR-4, FR-5, FR-6 | AD-15, AD-16, AD-27, AD-9, **AD-30** | 15 | Supabase Auth (Discord OAuth), `server/auth`, `routes/` guards |
| CAP-3 Nomination | FR-7, FR-8, FR-9, FR-10 | AD-1, AD-4, AD-6, AD-22 | 12 | `core/rules/nomination`, `shell/` |
| CAP-4 Maximum Bid | FR-12, FR-25 | AD-1, AD-7, AD-8 | 3, 4, 5, 23 | `core/rules/bidding`, `core/money.ts` |
| CAP-5 Place a Bid | FR-11, FR-13 | AD-1, AD-6, AD-7, AD-9, AD-12 | 1, 2, 15, 26 | `core/rules/bidding`, `shell/`, `routes/` form actions |
| CAP-19 Roster Capacity | FR-37 | AD-7, AD-1, AD-11, AD-23 | 23, 24, 25, 29, 30 (and passes in 18, 19, 20) | `core/rules/bidding` |
| **CAP-21 Cancel and restore** | **FR-40** | **AD-31**, AD-2, AD-4, AD-5, AD-11, AD-14, AD-22, AD-23 | 31, 32, 33, 34, 35 | `core/rules/restore`, `core/rules/close`, `core/projection/auctions` |
| **CAP-24 Retract a Bid** | **FR-15** | **AD-31**, **AD-22**, AD-2, AD-3, AD-4, AD-5, AD-12, AD-13, AD-29 | **47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57** | `core/rules/retract`, `core/rules/restore`, `core/projection/league-clock`, `core/projection/auctions` |
| CAP-6 Commit and release capital | FR-14, FR-35 | AD-7, AD-6, AD-11, AD-23 | 16, 17, 18, 19, 20, 21, 22 | `core/rules/bidding` |
| CAP-7 Clock and close | FR-16, FR-21 | AD-3, AD-10, AD-11, AD-12, AD-23 | 16, 17, 31, 35 | `core/rules/clock`, `supabase/functions/tick` |
| CAP-8 Minimum-Bid Contention | FR-17, FR-18, FR-19, FR-20 | AD-14, AD-3, **AD-11**, AD-12 | 6, 7, 8, 9, 10, 11, 21, 22, 34, 35 | `core/rules/clock`, `core/rules/bidding`, `functions/tick` |
| CAP-9 League Clock and phase end | FR-22 | AD-22, AD-3, AD-4 | 13, 27 | `core/rules/clock` |
| CAP-10 Board and views | FR-23, FR-24, FR-25 | AD-5, AD-9, AD-16, AD-3, AD-7, **AD-29**, **AD-30** | — | `routes/`, projections, Supabase Realtime |
| CAP-20 Teams index | FR-39 | AD-5, AD-7, AD-8, **AD-29**, **AD-30** | 28 | `routes/teams`, projections, `core/money.ts` |
| CAP-11 Discord notification | FR-26, FR-27 | AD-17, AD-18, AD-27 | — | `adapters/discord`, `functions/tick` |
| CAP-12 Contract assignment | FR-28, FR-29 | AD-1, AD-4, AD-23 | 14 | `core/rules/allotment`, `routes/team/contracts` |
| CAP-13 Export and archive | FR-30, FR-31, FR-36 | AD-24, AD-8, AD-23 | — | `adapters/fantrax/export`, `routes/admin/export` |
| CAP-14 Overrides, pause, audit | FR-32, FR-33, FR-34 | AD-4, AD-13, AD-15, AD-20, AD-22 | 27 | `core/rules/override`, `routes/admin` |
| **CAP-22 Roster Trade and Drop** | **FR-41, FR-43** | **AD-32**, AD-4, AD-5, AD-6, AD-23, AD-26, AD-31 | **36, 37, 38, 39, 40, 42, 43** (41 retired) | `core/rules/bidding` (gates reused), `core/rules/roster-import`, `core/projection/contracts`, `routes/admin`, one migration |
| **CAP-25 Roster Move (within a Team)** | **FR-44** | **AD-32**, AD-4, AD-5, AD-6, AD-7, AD-23, AD-31 | **44, 45, 46** | `core/rules/roster-rearrange`, `core/rules/bidding` (gates reused), `core/projection/contracts`, `core/projection/minors-history` |
| **CAP-23 Roster Divergence** | **FR-42** | **AD-32**, AD-24, AD-19 | — | `adapters/fantrax/`, shell reader, `routes/admin` |
| CAP-15 Synthetic-clock replay | — (NFR §5 rule correctness) | AD-3, AD-1, AD-25 | all 1–27 (28 is clock-independent) | `tests/`, rehearsal harness against the dev project |
| CAP-16 Liveness and quota alerting | — (NFR §5 availability) | AD-19, AD-10, AD-17 | — | heartbeat row, external detector (third failure domain) |
| CAP-17 Offsite export and restore | — (NFR §5 durability) | AD-21, AD-5, AD-4 | — | scheduled export job, offsite storage |

Every FR-1 … FR-44 appears exactly once as a realizing capability. CAP IDs are issue-ordered, not reading-ordered: CAP-18, CAP-19 and CAP-20 are placed beside their topical siblings but keep the next unused numbers, per Spec Law 6.

## The two independent bid gates

CAP-4/CAP-6 (money) and CAP-19 (slots) are evaluated on every Bid and neither subsumes the other. Getting this wrong in either direction is a rules bug, which PRD §5 rates worse than an outage.

| Team state | Money gate | Slot gate | Outcome |
| --- | --- | --- | --- |
| Roster Count 12, $40M free, bids on a non-eligible Player | passes | **fails** | refused — example 24 |
| Roster Count 12, all 3 minor slots free, bids on an eligible Player | passes (unbounded) | passes (`12 + 0`) | permitted — example 25 |
| Roster Count 12, 3 eligible leads against 3 slots, bids a 4th eligible | passes | **fails** (`12 + 1`) | refused on capacity — example 25 |
| Roster Count 11, $2M free, leading a $30M eligible bid, bids $1M on a 2nd eligible | **fails** (exposure $30M) | passes (`11 + 1`) | refused on money — example 19 |

## Architecture decisions with no single owning capability

These bind across the whole build rather than to one capability. They are constraints in `SPEC.md`, listed here so no AD is orphaned.

| AD | What it governs |
| --- | --- |
| AD-1 | The rules core is pure, and exposes `evaluate()` + `decide()` — binds every capability with a rule in it (CAP-3 – CAP-9, CAP-12, CAP-14, CAP-19), and the read path of CAP-4 and CAP-10 which call `evaluate()` directly |
| AD-2 | One core, one source location, two runtimes — binds `core/**` and both callers |
| AD-4 | Append-only event log — binds every mutating capability |
| AD-5 | Projections derived, folded by `seq` — binds every read capability, and the eligibility-flag history CAP-18 writes |
| AD-6 | One global write lock, one key, one arity — binds every mutating transaction |
| AD-8 | Integer dollars branded at every boundary — binds schema, core, adapters, wire |
| AD-20 | `coreVersion` on every event; version mismatch fail-stops the tick |
| AD-25 | §10 examples 1–28 are the executable specification |
| AD-26 | Schema changes are migrations in the repository, applied dev-first |

## The UX contract by capability

`DESIGN.md` and `EXPERIENCE.md` were adopted as companions on 2026-08-18. They bind broadly rather than to one capability; these are the places a builder must read them rather than the SPEC alone.

| What | Where it binds |
| --- | --- |
| Refusal pattern — both gates, full arithmetic, disabled control with its reason | CAP-4, CAP-5, CAP-19 |
| Freshness states (Live / Reconnecting / Stale) and the stalled-watermark trap | CAP-10, CAP-4 |
| Landing on Your Positions; one phase-and-role-filtered destination list | CAP-10, CAP-2 |
| Board card anatomy and the three-letter-caps naming rule | CAP-3, CAP-10, CAP-11, CAP-13 |
| 31-file import status list, Teams named not counted | CAP-1 |
| Commissioner control class — separated by form, mandatory reason sheet | CAP-14, CAP-18 |
| Sign-in states, including the unregistered refusal disclosing nothing | CAP-2 |
| Money rendered at one decimal, and never in a CSV cell | CAP-4, CAP-6, CAP-13, CAP-20 |
| Teams row anatomy; own row marked not moved; median quieter than the rows; no comparative colour | CAP-20 |
| Measured contrast, 44px targets, greyscale acceptance test, no urgency design | CAP-10, and every surface |

## §10 examples by capability

Every example must exist as a named test calling the core directly (AD-25).

| # | Example | Capability |
| --- | --- | --- |
| 1 | Ordinary raise | CAP-5 |
| 2 | Insufficient increment, and off-grid | CAP-5 |
| 3 | Roster Reserve bites | CAP-4 |
| 4 | Reserve clears as commitments accumulate | CAP-4 |
| 5 | Outbid frees capital immediately | CAP-4, CAP-6 |
| 6 | Lottery opens | CAP-8 |
| 7 | Lottery grows, clock unmoved | CAP-8 |
| 8 | Lottery draws | CAP-8 |
| 9 | Lottery dissolves | CAP-8 |
| 10 | The dead zone (now empty of grid-valid amounts) | CAP-8, CAP-5 |
| 11 | Single-contender lottery | CAP-8 |
| 12 | Nomination Slot held by an unbid Player | CAP-3 |
| 13 | League Clock not reset by a close | CAP-9 |
| 14 | Allotment exhaustion | CAP-12 |
| 15 | Co-manager race | CAP-5, CAP-2 |
| 16 | Minors placement | CAP-7, CAP-6 |
| 17 | Minors overflow | CAP-7, CAP-6 |
| 18 | Stashing beats the cap, on purpose *(Team P now at Roster Count 11)* | CAP-6, CAP-19 |
| 19 | Overflow refuses the cheap bid, not the expensive one *(capacity passes; money is the ground)* | CAP-6, CAP-19 |
| 20 | A resolved win stops being exposure *(Team P now at Roster Count 11)* | CAP-6, CAP-19 |
| 21 | A lottery on an eligible Player commits nothing | CAP-6, CAP-8 |
| 22 | A lottery that overflows does commit | CAP-6, CAP-8 |
| 23 | IR does not fill the twelve | CAP-4, CAP-19 |
| 24 | **A full roster ends non-eligible bidding, money or not** | CAP-19 |
| 25 | **The same full roster can still stash, until it overflows** | CAP-19, CAP-6 |
| 26 | **Off-grid amounts are refused everywhere** | CAP-5, CAP-8 |
| 27 | **A voided bid shortens the League Clock** | CAP-14, CAP-9 |
| 28 | **The median lands between two grid values** | CAP-20 |
| 29 | The allowance in the ordinary case | CAP-19 |
| 30 | The allowance needs a Slot to extend | CAP-19 |
| 31 | The cascade fires only as far as it must | CAP-21 |
| 32 | A restoration that is skipped, not undone | CAP-21 |
| 33 | A restoration with nothing to restore | CAP-21, CAP-7 |
| 34 | Unlimited lotteries, ended by one win | CAP-8, CAP-21 |
| 35 | The trigger is a free Slot, of either kind | CAP-21, CAP-19 |
| 36 | The Trade that clears the room | CAP-22 |
| 37 | The Team pushed over by giving something away | CAP-22 |
| 38 | The stash that becomes expensive by moving | CAP-22, CAP-6 |
| 39 | One act, evaluated once | CAP-22 |
| 40 | A Drop lowers the Maximum Bid | CAP-22 |
| 41 | **RETIRED** — the three characters decide nothing | CAP-22, CAP-1 |
| 42 | A won Player traded after the Auction Phase | CAP-22, CAP-12 |
| 43 | A stashed Drop moves the Maximum Bid the other way | CAP-22 |
| 44 | The optimization after the Trade | CAP-25 |
| 45 | The Move that buys bidding power by spending cap | CAP-25, CAP-6 |
| 46 | The promotion the app must refuse, and the one it must allow | CAP-25 |
| 47 | The typo the window exists for | CAP-24 |
| 48 | The retraction that closes the Auction immediately | CAP-24, CAP-7 |
| 49 | The change that cuts the window short, and the change that does not | CAP-24 |
| 50 | The Drop that closes the window by freeing a Slot | CAP-24, CAP-22 |
| 51 | Leaving a lottery, and emptying one | CAP-24, CAP-8 |
| 52 | The chain that terminates without a depth limit | CAP-24 |
| 53 | The window that outlived the Auction | CAP-24, CAP-8 |
| 54 | The stall the League Clock rule closes | CAP-24, CAP-9 |
| 55 | The anchor the stall rule hangs on | CAP-24, CAP-9 |
| 56 | The window that stops with every other clock | CAP-24, CAP-14 |
| 57 | Exactly ninety seconds, both halves | CAP-24, CAP-9 |

Rows 29–57 were added 2026-09-16. This table had stopped at 28 since the 2026-09-08 pass while the heading above it claimed every example must exist as a named test — fifteen examples were live and unmapped here before FR-15 added another fourteen. **Twelve of the fifty-seven have no test file**: `tests/examples/` holds 45 files, and the gap is example **12** plus examples **47–57**. See the open item below.

Examples 18–20 were amended when FR-37 arrived: at Roster Count 12 the new ceiling refuses example 20's bid on capacity and contradicts its stated outcome. At 11 all three keep their original lessons and additionally exercise the capacity check. This is the second time §10 examples 18–20 have needed correction against the Glossary — treat that neighbourhood as the highest-risk arithmetic in the document.

## Success metrics to capabilities

| Metric | Validated by |
| --- | --- |
| SM-1 Zero disputed outcomes (primary) | CAP-4 – CAP-9, CAP-19, CAP-15 |
| SM-2 The Commissioner plays their own league (primary) | CAP-1, CAP-18, CAP-13, CAP-14 |
| SM-3 Nobody loses a player to unwarned inattention (primary, 100%) | CAP-11 |
| SM-4 Mobile is the primary surface | CAP-10 |
| SM-5 The auction completes without manual intervention | CAP-9, CAP-12, CAP-13 |
| SM-6 Managers use the audit trail | CAP-8, CAP-14 |
| SM-C1 Total bid volume (counter — do not optimize) | CAP-10 |
| SM-C2 Auction duration (counter — do not optimize) | CAP-7, CAP-9 |
| SM-C3 Override count driven to zero by removing the tool (counter) | CAP-14 |

Measurement fields cannot be backfilled into an insert-only log (AD-4), so SM-3's dispatch and delivery outcome and SM-4's device class must be captured on the first event onward — a CAP-5, CAP-3 and CAP-11 build requirement, not an instrumentation pass afterward.

## Open items with a capability owner

All nine PRD open questions were answered on 2026-08-17 and are recorded with their answers in PRD §11. What remains is build-time judgement and one scheduled document.

| Item | Owner | Blocking |
| --- | --- | --- |
| **Twelve §10 examples have no test file** — example 12, plus 47–57 | CAP-24, CAP-3 | **Yes — AD-25 requires the suite green before any deploy.** 47–57 are the FR-15 stories' to write. Example **12** is a pre-existing gap from before 2026-09-16 (the unbid-nomination case CAP-21's cleared-clock decision leans on) and is either genuinely inexpressible as a state literal — in which case AD-25 needs an exception clause naming it — or simply missing |
| Outage recovery procedure (>15-minute outage → pause + compensating clock adjustment) | CAP-14, CAP-16 | **Yes — blocking on auction open.** Scheduled inside the build epics per OQ-9 |
| Obtain a real Fantrax export and confirm the salary and roster-slot columns | CAP-1 | Before setup day |
| ~~Call `getTeamRosters` against the real league~~ | CAP-23 | **CLOSED 2026-09-10** — answers unauthenticated, 30 Teams, 303 rows, `status` distinguishes all four Slot kinds. CAP-23 viable. The probe falsified addendum §A finding 1 and surfaced three integration hazards, all now ACs on Story 7.9 |
| Normalise player ids and establish an explicit Team mapping before the divergence diff runs | CAP-23 | **Yes — a silent total failure if missed.** Bare ids here vs asterisk-wrapped in the CSV; no Fantrax team id in the `teams` table |
| Round-then-assert-the-grid on any read of the endpoint's `salary` | CAP-22, CAP-23 | Whenever anything reads that field. Truncation put 4 of 303 live rows off the $500,000 grid |
| Confirm how Fantrax exports a Team carrying Dead Money | CAP-1, CAP-22 | Not this offseason — no Team carries any. An unrecognised `Status` refuses the file loudly on a future setup day |
| Discord delivery shape (one message per event, or batched against 30 req/min) | CAP-11 | Decide at build time; revisit at rehearsal |
| Outbox implementation (hand-rolled table vs Supabase Queues/pgmq) | CAP-11 | Decide at build time; AD-17's contract is unchanged either way |
| Archive reachability across the dormant year (free tier pauses after a week idle) | CAP-13 | Revisit at archive time |
