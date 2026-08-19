# Editorial Review — BBSL PRD + Addendum

*`bmad-review`, lenses `structure` then `prose`, run inline per request. Style guide: Microsoft Writing Style Guide. Reader type: humans.*

**Purpose read:** this document exists to help a builder-commissioner and the downstream BMad workflows (UX, architecture, epics) implement a fantasy-basketball auction whose rules are unusually precise and whose failure mode is a league losing trust in a result.

**Structure model:** Strategic/Context (Pyramid) — top-down, most critical first, MECE grouping, evidence supporting rather than leading.

**Word metrics:** `prd.md` 10,233 words across 12 sections; `addendum.md` 1,649 words across 7. Level-4 FR bodies account for ~4,309 words of the PRD (36 FRs, ~120 words each).

---

## Findings

| Pass | Original Text | Revised Text | Changes |
|---|---|---|---|
| structure | §11 OQ-2, marked `[BLOCKING]`, sitting ~9,000 words into the document | MOVE (surface, don't relocate) — added a status callout to §0 Document Purpose naming OQ-2 as the single blocker and stating that the other six OQs are safe to carry | Pyramid violation: the one item gating architecture was the last thing a reader met. The callout front-loads it while leaving the full question in §11 (+62 words, high comprehension value) |
| structure | §7.2 "Rules configurability" vs §6 "Not multi-tenant" | CONDENSE — §7.2 now names itself the implementation half of the §6 non-goal instead of restating the position | Two negatives 400 words apart read as either duplication or an unnoticed distinction (+14 words, removes ambiguity) |
| structure | §3 Glossary (824 words), placed ahead of §4 | PRESERVE | Looks like appendix material in a pyramid document and is not. This is a rules engine; dependency-first definition is what stops synonym drift from poisoning story generation downstream |
| structure | §10 Rule Resolution Examples (737 words) | PRESERVE | Reads as an appendix and earns main-document placement: it is the only section that makes the lottery and reserve edges unambiguous, and it is written to be lifted into a test suite |
| structure | §12 Assumptions Index (385 words), a round-trip of inline tags | PRESERVE | Deliberate redundancy with reinforcement value — the confirmation surface. Cutting it would save ~385 words and lose the mechanism that makes assumptions reviewable |
| structure | §9 Risks entries overlapping OQ-2 and OQ-3 | PRESERVE | Not true redundancy — the risk entries cite the OQ numbers rather than restating them, and the two sections serve different readers (operator vs. decision-maker) |
| structure | Whole document at 10,233 words against the ~5–8 page internal-tool guidance | QUESTION — no cut recommended | Runs ~2.5× the nominal guidance. Judged earned: 36 FRs against a dense ruleset, with mechanism already displaced to `addendum.md`. No section justifies cutting; flagging the overrun so the length is a decision rather than an accident |
| prose | "…the last thing standing between the league and its export" (§4.8) and "…the last thing standing between this PRD and architecture" (§11 OQ-2) | §4.8 → "…the last step before the results can leave the app" | A distinctive metaphor used twice ~4,000 words apart reads as authorial tic and weakens the OQ-2 instance, which is the one that matters |
| prose | "The minor-league-eligibility flag isn't actually in the Fantrax export" (§9) | "The minor-league-eligibility flag isn't in the Fantrax export" | Filler adverb; Microsoft style prefers the direct statement. "actually" appears 5× — the other four are emphatic and intentional, so only this one was cut |
| prose | "…show the live Contender list and state plainly that the clock does not reset" (FR-24) | "…state in words, not just iconography, that the clock does not reset" | "plainly" appeared 3× in the PRD. Here the replacement also does requirement work — it names what the UI must not do, which the vaguer word left open |
| prose | "Somebody has to notice a clock expired. Somebody has to check… Somebody has to remember…" (§1) | PRESERVE | Intentional anaphora carrying the Vision's argument. Noted so a later editor does not flatten it as repetition |
| prose | Title-case section headings throughout | No change | Microsoft style prefers sentence case, but the headings follow the BMad PRD template and downstream workflows may match on them. Consistency with the template beats consistency with the style guide here |

---

## Summary

**12 recommendations: 5 applied, 4 explicit PRESERVE, 1 QUESTION with no cut, 2 declined.**

Net word change: **+76** (≈ +0.7%). This review recommended no net reduction, which is the unusual outcome — the structure pass found the document dense rather than padded, and the single genuine shape problem was ordering, not volume.

**Comprehension trade-offs:** none. No recommendation cut reader-serving material; the four PRESERVE rows exist specifically to stop a future editor cutting sections that look redundant and are not.

**Unresolved:** the length overrun is recorded, not fixed. If the PRD needs to reach ~8 pages, the only honest lever is moving §10 (737 words) to the addendum — which this review advises against, since §10 is the section most likely to prevent an implementation bug.
