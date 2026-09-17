# Adversarial Divergence Review — FR-15 Retraction Amendment
**Lens:** Two units, each obeying every AD to the letter, built incompatibly
**Document:** ARCHITECTURE-SPINE.md (amended 2026-09-16)
**Reviewer date:** 2026-09-16

---

## Finding 1 (CRITICAL) — AD-29 does not name the retract control, and FR-24 forbids the only behavior AD-29's staleness rule would otherwise require

**The two readings.** Developer A reads AD-29's table literally: *"Stale ... bid and nomination controls disable with the reason stated."* The retract control is neither — AD-29 was written before FR-15 existed and enumerates only "bid and nomination" controls (spine lines 279, 284-288). Dev A concludes retract is simply outside AD-29's governed set and implements it exactly as FR-24 (PRD, amended 2026-09-16) literally requires: *"it... disappears the instant the window closes — whether by expiry or by the displaced Team's figures moving — and is never shown disabled"* (prd.md line 677). Under Dev A's build, the retract control stays live and actionable through a Stale connection state, showing a ticking countdown computed from possibly-stale cut-short inputs.

Developer B reads AD-29's *purpose* clause instead of its literal enumeration: *"the worst failure mode in this product — a stale board that still looks live, where a manager reads a figure, believes it current, and bids against it"* (line 280), and treats the retract control as a mutating control exactly like Maximum Bid, which AD-29 explicitly binds (line 279: "the persistent Maximum Bid strip"). Dev B disables the retract control whenever the client is not in the Live state, with the reason stated — directly contradicting FR-24's "never shown disabled."

**The input they disagree on.** A Manager loses realtime connectivity (channel `CHANNEL_ERROR`) 20 seconds into their own 90-second retraction window, while the displaced Team's Drop (example 50's shape) has just fired server-side and would cut the window short — information the client has not yet received. Dev A's build shows the retract control live and counting down; the Manager taps retract; the server correctly refuses it (the cut-short already fired), and the Manager is told after the fact that a control they were shown as live has failed — precisely the "control that sits there and fails on submit is worse than no control" failure FR-24 itself warns against, produced by AD-29's staleness posture applied honestly. Dev B's build never shows this failure but violates FR-24's explicit UX requirement outright, and would fail any acceptance test built against FR-24's literal text.

**Which text permits both.** AD-29 (spine lines 277-297) enumerates "bid and nomination controls" and was never amended alongside AD-13's 2026-09-16 retraction bullet to add "retract" to that set or to carve it out. AD-13's own retraction bullet cites AD-29 only for a narrower claim — *"a control that offers itself and a command that accepts it cannot disagree (AD-1, AD-29)"* (line 161) — which is about evaluate()/read-path consistency, not about freshness disabling. Nothing in the amendment states whether the retract control is inside or outside AD-29's Stale-disables rule, and FR-24's "never shown disabled" is not reconciled against it anywhere in the spine.

**Fix direction.** AD-29's binds line and its Stale-row obligation need "retract" named explicitly, with an explicit statement of how "never shown disabled" (FR-24) is squared with "disable with the reason stated" (AD-29) — e.g., a stale countdown that is exempted like other countdowns (AD-29's own countdown carve-out, line 296) while the *submit* affordance separately disables, which is not what FR-24's prose currently describes ("never shown disabled" reads as the whole control, not just its countdown face).

---

## Finding 2 (CRITICAL) — AD-22's League-Clock-reset suppression rule names no anchor field, and the one test guarding it (example 54) cannot distinguish the two readings

**The two readings.** AD-22 states: *"A Bid placed by a Team within ninety seconds of that same Team's own retraction earns no reset"* (line 225), and PRD FR-22 repeats it verbatim (line 640). Developer A anchors the 90-second suppression window to the `BidRetracted` event's own `occurredAt` (the retraction act itself) — the plain grammatical reading of "of that... retraction." Developer B, building `league-clock.ts` "beside the `BidVoided` case" as AD-22 instructs, pattern-matches the *retraction window's* own anchoring idiom — repeated three times in the surrounding text as "anchored to a Bid's own timestamp, not to anything later" (FR-15 §4.4: *"The window is ninety seconds from the retracted Bid's own timestamp, and from nothing later,"* prd.md line 394; AD-31: *"every retraction is anchored to its own Bid's timestamp,"* spine line 317) — and anchors the suppression window instead to the **original retracted Bid's** timestamp, treating "of that... retraction" as shorthand for "of the Bid that retraction concerns."

**The input they disagree on.** Team A joins a lottery (or bids) at T0. It retracts late in its own window, at T0+85s (still legally inside the 90s window). It re-bids/rejoins at T0+91s — 6 seconds after the retraction. Dev A (anchor = retraction time, T0+85): elapsed since retraction = 6s < 90s → **suppressed, no reset**, correctly closing the stall AD-22 exists to prevent. Dev B (anchor = original Bid time, T0): elapsed since original Bid = 91s > 90s → **not suppressed, reset granted** — exactly the "hold the Auction Phase open indefinitely and for free" exploit AD-22's own text calls out (line 225: "the sole thing standing between FR-15 and a Team holding the Auction Phase open indefinitely and for free").

**Why example 54 does not catch this.** AD-25 states plainly: *"Example 54 is not a clock test among others — it is the only executable statement that the ninety-second suppression is not a rate limit"* (spine line 253) — i.e., it is the sole guardrail. But example 54's own numbers are join-to-retract = 70s, retract-to-rejoin = 10s, so total join-to-rejoin = 80s (prd.md line 1162). Both Dev A's and Dev B's readings compute "suppressed" for this input (80s < 90s under either anchor), so **both builds pass the only named test** while disagreeing on the input above. This is the precise failure mode AD-25 exists to prevent, occurring inside the rule AD-25 names as its own hardest case.

**Which text permits both.** AD-22 (line 225) and the addendum's §G "one rule here that must not be built as an implementation detail" (line 184-186) both state the *effect* ("no reset") without ever naming which event's `occurredAt` field the 90-second comparison reads. Given the surrounding prose's dense repetition of "anchored to a Bid's own timestamp, not later events" for the *different* chain-termination rule, a reader has textual cover for either anchor.

**Fix direction.** Add one sentence to AD-22's retraction bullet: "measured from the `BidRetracted` event's own `occurredAt`, never from the retracted Bid's," and add a ninth example (or amend 54) with a retraction occurring late in its own window to force the anchor choice to matter.

---

## Finding 3 (HIGH) — AD-13's pause-interval fold is defined over paired pause/resume events; an *open* (unresumed) pause has no such pair, and the amendment has zero example coverage for it

**The two readings.** AD-13's new derivation: *"the window's elapsed time is `now − the Bid's occurredAt` minus every paused interval intersecting that span, folded from the pause and resume events this AD already appends"* (line 161). Developer A implements this as literally specified: a "paused interval" requires both a `Paused` and a matching `Resumed` event to exist before it can be folded in as a subtraction term. While a pause is *currently open* (no `Resumed` event yet appended), there is no interval to fold, so the live countdown render keeps advancing against wall-clock `now`. Developer B implements the *intent* stated one clause earlier in the same AD — *"a resume after an indeterminate outage silently resolving auctions that should still be open"* and *"the sweep checks paused state under the same lock and closes nothing while paused"* (line 160) — and treats an open pause as contributing `now − pauseStart` to the subtraction even with no `Resumed` event, freezing the render at the value it held when the pause began.

**The input they disagree on.** Team A retracts a Bid at T0, opening a 90-second window. At T0+50s the Commissioner pauses the auction (break-glass or ordinary FR-34 pause) and it is still paused ten minutes later. Under Dev A's build, the live countdown keeps ticking from T0+50s using wall-clock `now` (no interval exists to subtract), so the control shows the window as expired at T0+90s — 40 seconds into an outage the Manager cannot act during, since "a retraction is refused while paused" (line 161) means they could not have submitted anyway even if the control had stayed live. Under Dev B's build, the countdown correctly freezes at "40 seconds remaining" for the duration of the pause, matching AD-13's own promise for every other clock: "on resume the window continues with exactly the time it held at pause" (prd.md line 396).

**Why this is not academic.** AD-13's whole justification for touching FR-15 at all is this exact scenario: *"the window drains across the pause — expiring while the Manager is locked out of acting on it, which is this product taking a remedy away from someone for a reason wholly outside their control"* (line 161) — the AD explicitly names Dev A's outcome as the bug it exists to prevent, yet its own derivation formula (paired pause/resume events) permits building exactly that bug for the duration of any pause that has not yet been resumed. None of PRD examples 47-54 involve a pause at all, so AD-25's suite provides no check on this path.

**Which text permits both.** "Folded from the pause and resume events this AD already appends" (line 161) is stated as requiring both event types as the fold's inputs, without addressing the half-open case where only `Paused` exists so far — a gap the surrounding sentence's own stated intent argues against but does not close.

**Fix direction.** State explicitly that an unresumed `Paused` event contributes `(now − pauseStart)` to the subtraction for rendering purposes (using the same `now` the read path already has), independent of whether a `Resumed` event exists yet, and add an example exercising a retraction window with an in-progress pause.

---

## Finding 4 (MEDIUM) — boundary inclusivity of "ninety seconds" is never pinned, and none of examples 47-54 tests the boundary

**The two readings.** AD-2 (line 80: "window (ninety seconds from that Bid's own timestamp...)"), AD-13, and FR-15 (prd.md line 394) all state the bound as "ninety seconds" without an operator. Developer A implements `elapsed < 90` (strictly less than); Developer B implements `elapsed <= 90` (inclusive). Both satisfy every prose statement equally, since none of the examples exercises the exact boundary.

**The input they disagree on.** A retraction command arrives when `now − bid.occurredAt` is exactly `90.000` seconds (a real possibility given millisecond-precision ISO-8601 timestamps and a request that happens to land on the boundary, or a client-timed submit tuned to the displayed countdown reaching `0:00`). Dev A's core refuses it as expired; Dev B's core accepts it. Because AD-12's expiry posture ("late, not wrong") and AD-3's server-time authority are the closest analogues in the spine, and neither states which side of the boundary the window itself closes on, both readings are equally defensible constructions of "ninety seconds."

**Which text permits both.** No AD or FR-15 clause states `<` vs `<=`, and AD-25's added examples (47-54) all use round numbers well clear of the boundary — the AD-25 entry for 47-54 even flags that they "turn on **seconds**" (line 1153) without stating the boundary is closed or open at exactly 90.

**Fix direction.** Pin the operator explicitly (e.g., "a retraction is valid while elapsed time is strictly less than ninety seconds") and add a boundary example (or explicit note that one is deliberately omitted as sub-second and untestable).

---

## Finding 5 (MEDIUM) — AD-31's two-case `BidRetracted` restoration shape does not name the third outcome FR-15 itself describes for an ongoing Minimum-Bid Contention

**The two readings.** AD-31 specifies the retraction event's restoration payload as: *"either the restored Team, Bid `seq`, amount and the Auction Clock instant being restored, or `null` for an Auction returning to Awaiting Opening Bid"* (line 313) — a binary shape copied verbatim from the earlier `BidCancelled` spec (line 310). But FR-15's own Minimum-Bid Contention section states a **third**, distinct outcome: *"There is no restoration ... and no seed is revealed ... The Auction Clock is untouched while any Contender remains"* (prd.md line 424-425) — as opposed to *"A list emptied by retraction returns the Auction to Awaiting Opening Bid with its Clock cleared"* (line 427). Developer A, implementing the fold strictly from AD-31's literal two-case text, writes the projection so that any `BidRetracted` event carrying a `null` restoration payload triggers "clear the clock, return to Awaiting Opening Bid" — because that is the only meaning AD-31 gives to `null`. Developer B, reading FR-15's contention section, adds a third discriminator to the event or to the fold logic so that a contention retraction with Contenders still remaining leaves the clock untouched and the auction open.

**The input they disagree on.** A Minimum-Bid Contention has three Contenders (E, F, G); G retracts (example 51's first case, prd.md line 1159). Dev A's fold sees `BidRetracted` with `restoration: null` (no next-highest Bid applies to a lottery) and — per its literal reading of AD-31 — folds it as "Auction returns to Awaiting Opening Bid, Clock cleared," incorrectly dissolving a lottery that still has two live Contenders (E, F) and a Clock that should be untouched. Dev B's fold correctly leaves the contention open with E and F remaining, matching example 51 exactly.

**Which text permits both.** AD-31's restoration-field sentence (line 313) is stated as a general rule for the `BidRetracted` shape without qualification, and never states that the contention case is a third, `null`-but-not-Awaiting-Opening-Bid outcome distinguished elsewhere (e.g., by whether the Contender list is empty, which the fold must consult separately). The equivalent ambiguity already exists for `BidCancelled` under FR-40's contention-cancellation text (FR-40, prd.md line 629), so this may already be resolved by inherited, already-built fold logic — but AD-31's amendment for retraction does not say so explicitly, and a developer reading only the amended bullets (rather than re-deriving the precedent) has no textual signal that `null` is contention-conditional.

**Fix direction.** Add a sentence to AD-31's retraction bullet naming the third case explicitly, or state plainly that the fold determines Awaiting-Opening-Bid vs. contention-continues from the Contender-list projection rather than from the restoration field alone (mirroring whatever the codebase already does for `BidCancelled`, if it already exists).

---

## Summary of severities

| # | Finding | Severity |
|---|---|---|
| 1 | AD-29 vs FR-24: retract control staleness/disabling contradiction | Critical |
| 2 | AD-22 suppression-window anchor unpinned; example 54 cannot discriminate | Critical |
| 3 | AD-13 pause-interval fold undefined for an open/unresumed pause | High |
| 4 | "Ninety seconds" boundary inclusivity unpinned, untested | Medium |
| 5 | `BidRetracted` restoration payload's two-case shape omits the contention-continues outcome | Medium |
