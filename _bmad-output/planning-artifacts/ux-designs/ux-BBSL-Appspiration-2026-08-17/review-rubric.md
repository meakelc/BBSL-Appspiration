# Spine Pair Review — BBSL-Appspiration

**Reviewed:** `DESIGN.md` + `EXPERIENCE.md`, 2026-08-17
**Source of record:** `_bmad-output/specs/spec-BBSL-Appspiration/SPEC.md` (CAP-1 – CAP-19)

> ## Resolution — applied 2026-08-17
>
> **Fixed:**
> - **Critical, §4** — Connection and freshness added to `EXPERIENCE.md` State Patterns. Three states (Live / Reconnecting / Stale), with controls disabling and money labelled by age in anything but Live.
> - **High, §2** — Contrast measured, not promised. Two genuine failures found and corrected: `text-tertiary` `#67796E` → `#7F9187` (3.59 → 4.98) and control boundaries `#46584D` → new `border-interactive` `#5E7568` (2.18 → 3.34, WCAG 1.4.11). Full measured table now in `DESIGN.md`. All five mockups updated to match.
> - **High, §3** — Refusal panel now has a full visual anatomy in `DESIGN.md.Components`, including the filled-versus-outlined gate chip contrast that survives greyscale.
> - **High, §4** — Sign-in states specified: signed out, not registered, session expired, Commissioner fallback.
>
> **Not fixed, by decision:**
> - **High, §1** — CAP-14 still has no Key Flow. Deliberately skipped; the Commissioner control class is mocked and specified as a component, so it remains buildable, just not narrated.
> - All medium and low findings stand as written below.

## Overall verdict

The pair is a usable downstream contract: tokens resolve, the visual system is committed rather than gestured at, and the decisions that matter most — the refusal pattern, the naming rule, the Commissioner control class — are specified tightly enough to build from without asking follow-up questions. The weakness is **coverage breadth, not depth**. Five capabilities have no Key Flow, three of them Commissioner-facing; several surfaces named in the IA have no specified states at all; and the connection-loss case is unaddressed on a product whose entire premise is that a displayed figure can be trusted. Nothing here is wrong. Several things are absent.

## 1. Flow coverage — adequate

Checked all nineteen capabilities in `SPEC.md` against the five Key Flows.

Covered: CAP-1, CAP-3, CAP-4, CAP-5, CAP-6, CAP-8, CAP-9, CAP-10, CAP-12, CAP-18, CAP-19.

### Findings

- **high** CAP-14 (Override, pause, and account for it) has no Key Flow (§ Key Flows). The Commissioner control class is mocked and specified as a component, but no narrated journey walks an override end to end — including the case the SPEC singles out, where voiding a Bid recomputes the League Clock shorter and can end the Auction Phase sooner. This is the highest-stakes act in the product and the one where the builder is most visibly also a competitor. *Fix:* add "The 1am override" as flow 6, with the League Clock recomputation as its climax.
- **medium** CAP-2 (Authenticate Managers and bind them to Teams) has no flow and no surface states (§ Key Flows, § State Patterns). The SPEC requires an unregistered Discord account be unable to obtain a session, and a Commissioner sign-in path independent of Discord. Neither has a specified screen. *Fix:* specify the refused-sign-in state and the Commissioner fallback path.
- **medium** CAP-13 (Export the result to Fantrax and archive) is referenced in flow 5 step 6 but no flow lands on the export surface (§ Key Flows). Its blocking conditions — cap breach, Roster Count ≠ 12, missing contract length — are named in the SPEC and have no specified presentation. *Fix:* either extend flow 5 through export, or add a short sixth flow.
- **medium** CAP-16 (Detect that the tick has stopped) lists an "operational health" destination in the IA but specifies nothing about it (§ Information Architecture). The SPEC requires the alert to reach *a sleeping operator*, which is a UX requirement, not only an ops one. *Fix:* specify the alert's shape and the health surface, or state explicitly that alerting is out of UX scope.
- **low** CAP-15 and CAP-17 (synthetic-clock replay, reconstruct from outside Supabase) have no flows. Both are plausibly out of UX scope. *Fix:* say so in the spine rather than leaving it inferred.

## 2. Token completeness — adequate

Every token in the `DESIGN.md` frontmatter carries a concrete value. Every `{path.to.token}` reference in both spines resolves: `colors.text-tertiary`, `colors.surface`, `colors.lottery`, `colors.attention`, `colors.admin`, `colors.admin-text`, `colors.admin-ground`, `colors.border-strong`, `components.control-height`.

### Findings

- **high** No contrast ratios are stated for any load-bearing combination (§ Colors → Contrast). The section commits to AA and flags `text-tertiary` on `surface` as needing measurement, but downstream code mirrors the spine and currently has no number to build against. `text-tertiary` `#67796E` on `surface` `#15211B` is used at 10–11px for timestamps, section labels and consequence notes — small type doing real work. *Fix:* measure and state ratios for `text` / `text-prose` / `text-secondary` / `text-tertiary` / `text-disabled` against both `ground` and `surface`, plus `attention-ink` on `attention`.
- **low** `admin-label` (`#7E939D`) is declared in frontmatter but appears in no prose reference and no Colors row (§ frontmatter, § Colors). *Fix:* document it or drop it.
- **low** `typography.scale` is a bare list of sizes rather than named steps (§ frontmatter). Workable, but a consumer cannot tell which step a "section label" uses without reading the prose. *Fix:* name the steps.

## 3. Component coverage — adequate

Extracted every component named across both spines and the five mockups.

Fully paired (visual spec in `DESIGN.md.Components` **and** behaviour in `EXPERIENCE.md.Component Patterns`): Board card, Arithmetic breakdown, Bid control, Persistent strip, Commissioner control, Override reason sheet.

### Findings

- **high** The **refusal panel** has no row in `DESIGN.md.Components` (§ Components). It is specified behaviourally in six numbered parts and is repeatedly called the most important screen in the product, but its visual anatomy exists only in the mockup and a passing mention of the accent bar under Elevation & Depth. A consumer building from `DESIGN.md` alone has no spec for it. *Fix:* add a Components row.
- **medium** **Filter chips** appear on the Bid Board mockup and are unspecified in either spine (§ Components, § Component Patterns). *Fix:* specify, including which filters exist and the selected treatment.
- **medium** The **destinations sheet** is referenced three times — twice in `EXPERIENCE.md.Information Architecture`, once under the persistent strip in `DESIGN.md` — and specified nowhere. It is the primary navigation on mobile. *Fix:* specify its contents, ordering, and how phase/role filtering presents.
- **low** **State chip** has a `DESIGN.md` row but its behaviour lives under State Patterns rather than Component Patterns (§ Component Patterns). Defensible; note it so a consumer knows where to look.
- **low** The **Nomination Slot panel** appears in the Your Positions mockup and is unspecified. *Fix:* fold into Component Patterns or accept as a plain composition.

## 4. State coverage — thin

Walked every surface in the phase table against the applicable state list.

Well covered: Auction states (all five), viewer-relative states, phase transitions, paused, Bid Board empty at open, Your Positions empty.

### Findings

- **critical** **No realtime-disconnected state exists** (§ State Patterns). The spines require board changes within 5 seconds and Maximum Bid recomputation within 1 second, both without manual refresh — and specify nothing for when that channel drops. On a product whose entire premise is that a displayed figure can be trusted, **a stale board that still looks live is the worst failure mode in the system**: a manager reads a figure, believes it is current, and bids against it. The SPEC's own constraint that "a displayed figure is a rendering; only a freshly computed figure authorises a Bid" is satisfied server-side but has no client presentation. *Fix:* specify a degraded state — what the strip shows, whether bidding controls disable, and how a viewer learns the figures are no longer live.
- **high** **Sign-in has no specified states at all** (§ State Patterns). Permission-denied for an unregistered Discord account is a SPEC requirement with no screen. *Fix:* specify denied, expired-session, and the Commissioner fallback.
- **medium** **No cold-load state** anywhere (§ State Patterns). The performance floor is 2 seconds interactive on mobile data; what occupies those 2 seconds is unspecified, and it matters most on the wake-up session entered from a Discord link on a phone. *Fix:* specify the loading treatment for board and Auction.
- **medium** **Contract Assignment has no states** (§ State Patterns) — not started, partially assigned, complete-but-unsubmitted, submitted final, or assigned-by-Commissioner-on-your-behalf. The last is a SPEC-mandated visible act and needs a visible presentation. *Fix:* specify all five.
- **medium** **Import error states** are narrated inside flow 1 but absent from State Patterns (§ State Patterns). A consumer reading State Patterns for the import surface finds nothing. *Fix:* lift them out of the flow.

## 5. Visual reference coverage — strong

Five artboards in `mockups/`, each linked inline from at least one spine section with a description of what it illustrates, plus a `mockups/README.md` mapping file to purpose and naming the canvas URL. Spines-win-on-conflict is stated once in each spine.

### Findings

- **low** `House.dc.html` is linked only from the `DESIGN.md` footer and the mockups README, not inline at a section (§ Components). It illustrates the board card states, Maximum Bid panel, refusal and persistent strip — all of which have sections it could anchor to. *Fix:* link it inline.
- **low** `.working/` retains `Main.dc.html`, `Terminal.dc.html` and `Sustainable.dc.html` (the three rejected directions), unlinked from either spine. Deliberate and documented in the canvas notes; noted only so it is not mistaken for an oversight.

## 6. Bloat & overspecification — strong

`DESIGN.md` prose carries editorial voice, which is permitted and is doing real work — the Brand & Style section explains *why* the pun constrains the palette, which a consumer needs. `EXPERIENCE.md` stays largely declarative outside the Key Flows, where narrative is required by the spine shape.

### Findings

- **low** Interaction Primitives restates several SPEC constraints nearly verbatim (server-authoritative validation, performance floors) (§ Interaction Primitives). Defensible as a consumer convenience, but it is duplication that can drift. *Fix:* consider citing rather than restating.
- **low** `EXPERIENCE.md` writes "46px" for the bid control rather than referencing `{components.control-height}` (§ Component Patterns → Bid control). *Fix:* use the token.

## 7. Inheritance discipline — strong

`sources` frontmatter resolves in both spines. Domain vocabulary is used verbatim throughout and matches `SPEC.md` §Vocabulary exactly — no synonyms found. Capability identifiers cited in `EXPERIENCE.md` (CAP-1, 3, 4, 5, 6, 8, 9, 10, 18, 19) all exist. Component names are identical across all sections of both files. `EXPERIENCE.md` token references all resolve to `DESIGN.md` frontmatter by name.

### Findings

- **medium** Key Flows carry invented names with no traceability to capabilities (§ Key Flows). `SPEC.md` defines no user-journey names, so invention was necessary — but nothing maps "The wake-up" to CAP-10/CAP-3/CAP-11, so coverage cannot be checked mechanically by a later consumer. *Fix:* add a realized-capabilities line to each flow, mirroring the SPEC's own `Realizes FR-…` convention.

## 8. Shape fit — adequate

`DESIGN.md` sections appear in canonical order: Brand & Style → Colors → Typography → Layout & Spacing → Elevation & Depth → Shapes → Components → Do's and Don'ts. No order violations.

`EXPERIENCE.md` carries all eight required defaults. Responsive & Platform is correctly present (multi-surface triggered). The invented section **Timezone and Clock Presentation** earns its place — a California league with EU and Australian contingents makes clock rendering a first-class product concern, and the section changes build decisions rather than decorating.

### Findings

- **medium** **Inspiration & Anti-patterns is triggered but absent** (§ EXPERIENCE.md). The memlog and canvas notes record explicit reference products and explicit rejects — Aspiration Inc as the brand reference; monospace-terminal, soft elevated cards, red-as-alarm, pill chips and 14px radii all rejected with reasons; and a standing list of forbidden patterns (countdown pressure, one-tap raise, suggested bids, celebration animation). The forbidden list survives in `DESIGN.md.Do's and Don'ts`, but the *rejected directions and why* live only in the canvas annotations, which are not part of the contract. A later consumer will re-propose soft cards. *Fix:* add the section.

## Mechanical notes

- Cross-references between the two spines resolve in both directions; `mockups/` links resolve; the canvas URL resolves.
- Frontmatter is complete in both files. `status: draft` in both — to be set `final` at close.
- No Mermaid diagrams present; none needed at this altitude.
- One name inconsistency: the SPEC says *"Minimum-Bid Contention"*; the mockups and one State Patterns row use the shorthand chip label **"Lottery"**. The SPEC itself uses "lottery" in prose (CAP-8) so this is not a vocabulary violation, but the spine should say once that "Lottery" is the UI shorthand for Minimum-Bid Contention rather than leaving a consumer to infer it.
- `EXPERIENCE.md` Open items correctly retains the CAP-1 two-imports-versus-thirty-one conflict as unresolved and out of UX scope to fix.

## Summary

| Category | Verdict |
|---|---|
| 1. Flow coverage | adequate |
| 2. Token completeness | adequate |
| 3. Component coverage | adequate |
| 4. State coverage | **thin** |
| 5. Visual reference coverage | strong |
| 6. Bloat & overspecification | strong |
| 7. Inheritance discipline | strong |
| 8. Shape fit | adequate |

**Findings: 1 critical · 4 high · 9 medium · 8 low**
