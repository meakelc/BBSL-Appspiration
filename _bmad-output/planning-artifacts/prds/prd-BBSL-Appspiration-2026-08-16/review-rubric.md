# PRD Quality Review — BBSL Offseason Free Agent Auction

> **Postscript (after this review ran):** the blocking item named below — OQ-2, Minor League Slot cap treatment — was resolved by the league. Stashing at a $0 cap hit is permitted, because a team cannot activate the player without absorbing the full amount. FR-35 was rewritten from conservative full commitment to unbounded-with-overflow, Maximum Bid became a per-auction figure, and the open questions renumbered. The verdict below stands on every other point; read "the material risk is OQ-2" as historical.

*Run at Finalize step 3 against the seven-dimension rubric in `assets/prd-validation-checklist.md`. Run in-session rather than dispatched to a subagent, per this session's standing instruction not to spawn agents unless asked — noted so the provenance of this review is not misread.*

## Overall verdict

This PRD holds up well where it matters most: it treats the auction as a rules engine and specifies it like one, with a fixed glossary, arithmetic stated as formulas rather than prose, and nineteen worked examples that convert the ambiguous edges into test cases. The thesis — trust is the product, and trust comes from verifiable arithmetic and an auditable lottery — runs coherently from Vision through the counter-metrics. The material risk is not in the document's craft but in one unresolved rule: OQ-2, the cap treatment of Minor League Slots, is genuinely blocking and touches the single most-used computation in the app. Second-order concern is that several success metrics assumed instrumentation the FRs did not produce; that gap was closed during this pass.

## Decision-readiness — **strong**

Decisions are stated as decisions and their costs are named. §7.2 distinguishes *deferred* from *rejected* rather than blurring both into "out of scope" — proxy bidding and the overnight freeze are marked rejected with reasons, while push notifications and API sync are marked deferred with revisit triggers. The addendum's rejected-alternatives table (§A) gives an architect the reasoning without making the PRD carry it.

The Open Questions are genuinely open. None is rhetorical, and OQ-2 is explicitly marked `[BLOCKING]` rather than filed alongside cosmetic items — a reader scanning §11 cannot mistake which one gates architecture. The two `[NOTE FOR PM]` callouts sit at real tensions (push-notification regret, 3am-sniping resentment) rather than at safe checkpoints.

### Findings
- **medium** FR-21 and FR-35 read as being in tension (§4.5, §4.4) — one says a minors placement yields a $0 Cap Hit, the other says the full amount is committed during bidding. They are consistent (commit conservatively, resolve at placement) but a reader meeting FR-21 first will think the PRD contradicts itself. *Fix:* FR-21's consequence now carries an explicit forward-reference to FR-35. **Applied.**

## Substance over theater — **strong**

No standalone persona section; persona context is carried inline by four named-protagonist journeys, each of which drives at least one requirement (UJ-1 → FR-12's component breakdown, UJ-2 → FR-20's seed disclosure, UJ-3 → FR-5's per-Manager attribution, UJ-4 → FR-29's completion tracker). The Vision could not be swapped into another PRD — it is about *this* league's five years of manual adjudication.

NFR thresholds are mostly real numbers rather than adjectives. Counter-metrics are the strongest evidence against theater: SM-C1 and SM-C2 name specific design temptations (urgency countdowns, one-tap raises, suggested amounts) that would raise a metric while degrading the product.

### Findings
- **medium** §5 Availability and Accessibility were adjectives where the rest of §5 was bounds — "reachable 24/7," "sufficient contrast and touch targets." *Fix:* replaced with an outage budget (≤1h total, ≤15min single) and explicit WCAG 2.1 AA ratios plus 44×44px targets. **Applied.**
- **low** §5 "Scale is not a concern — design for correctness" is unusual and correct for this product; flagged only so a reviewer does not read it as an omission.

## Strategic coherence — **strong**

There is a thesis and the document bets on it. Feature ordering follows the auction's own lifecycle rather than implementation convenience, and the metrics validate the thesis rather than measuring activity — SM-1 is "zero disputed outcomes," not "bids placed." SM-6 (does anyone actually check the audit trail) is a well-chosen test of whether verifiable fairness is real or decorative.

### Findings
- **high** Several metrics had no data source anywhere in the FRs. SM-4 requires knowing which device a bid came from; SM-3 requires notification delivery outcomes; nothing in §4 captured either, so these were unmeasurable as written. *Fix:* added a Measurability NFR to §5 requiring bid and notification events to carry the context the §8 metrics need. **Applied.**
- **low** SM-2 targets "fewer than 5 Commissioner overrides." Reasonable, but it is a guess rather than a baseline — there is no prior-year figure to compare against. Acceptable for a first run; treat the first auction as the baseline rather than the target.

## Done-ness clarity — **strong**

The dimension the PRD is best on, and the right one to be best on. Every FR carries testable consequences; the formulas in FR-12 are stated symbolically *and* worked numerically; §10's nineteen examples are written to be lifted directly into a test suite. FR-13's requirement that validation run "against committed state at the moment of submission, not against state the client held when the page rendered" is precisely the kind of specificity that prevents a plausible-looking wrong implementation.

Searched for weasel words — "gracefully," "reasonable," "user-friendly," "as appropriate." None present.

### Findings
- **medium** FR-27 allowed muting "non-urgent categories" without saying which. *Fix:* the three mutable categories are now enumerated, and the two non-mutable ones named. **Applied.**
- **low** FR-29's reminder interval is "Commissioner-configured" with no bound. Acceptable — it is genuinely a league preference — but architecture should give it a sane default rather than an empty field.

## Scope honesty — **strong**

Non-Goals does real work, particularly "not a valuation engine" and "not a chat app," which pre-empt the two most likely scope creeps for a fantasy tool. Every inference is tagged inline and round-trips to §12, and §12 additionally retains resolved assumptions under a provenance heading rather than deleting them — useful when someone asks in a year why IR players were excluded from the twelve.

Open-items density: 7 Open Questions and 9 live assumptions against a build-ready PRD is on the high side by the rubric's own standard. It is defensible here because exactly one is blocking and the remainder fail safe — a wrong guess on bid granularity or roster maximum produces a small, late, cheap correction, not a rebuild.

### Findings
- **medium** The original draft exported auction contracts but not full post-auction rosters, though the source brief asked for "post-auction rosters *and* final contract amounts." A silent narrowing of stated scope. *Fix:* added FR-36. **Applied.** *(Surfaced by input reconciliation, Finalize step 2.)*

## Downstream usability — **strong**

Glossary is present, comprehensive, and actually observed — spot-checking "Cap Space," "Available Cap Space," "Committed Bids," and "Roster Count" across §4, §8, and §10 found no synonym drift, which is the failure mode most likely to poison story generation. Cross-references resolve. Sections stand alone; §10 in particular can be handed to an implementer with only §3 for context.

### Findings
- **low** FR-35 and FR-36 are numbered out of sequence, appearing at the end of §4.4 and §4.9 respectively despite numbering after FR-34. This is the correct trade — the template makes FR IDs stable references precisely so they survive reorganization — but each carries an inline note so a reader does not suspect an editing error. **Accepted, not a defect.**
- **low** FRs reference user journeys at the feature level (§4.x Description) rather than per-FR. Cleaner to read; slightly less mechanical for a tool tracing UJ → FR coverage. Acceptable at this stakes level.

## Shape fit — **strong**

The rubric warns that internal, single-operator tools often do not warrant user journeys. This one does: 31 users across two roles, a mobile-primary interaction under time pressure, and a co-management case that genuinely changes requirements (FR-5). Four journeys is the right count and each earns its place.

The invented §10 (Rule Resolution Examples) is the strongest structural decision in the document. No template section covered it, and without it every ambiguity in the lottery and reserve rules would have been resolved silently by whoever wrote the code first.

## Mechanical notes

- **ID continuity:** FR-1 – FR-36 unique, no gaps, no duplicates. UJ-1 – UJ-4 contiguous. SM-1 – SM-6 plus SM-C1 – SM-C3 contiguous. OQ-1 – OQ-7 renumbered after two resolutions; no stale references remain.
- **Cross-references:** one stale reference found and fixed — FR-15 pointed at FR-30 for commissioner bid-voiding where it meant FR-32. **Applied.**
- **Assumptions Index round-trip:** all 9 live inline `[ASSUMPTION]` tags appear in §12; §12 introduces none that are absent from the body. 2 resolved assumptions retained under a provenance heading.
- **Glossary coverage:** every domain noun used in §4, §8, and §10 resolves to a §3 entry. "Slot Placement" added during finalize to cover the new rule.
- **§7.1 scope list** updated to include FR-35 and FR-36 after both were added.
