---
title: Appspiration Design
status: final
updated: '2026-09-08'
sources:
  - ../../../specs/spec-BBSL-Appspiration/SPEC.md
colors:
  ground: "#0D1712"
  surface: "#15211B"
  surface-sunken: "#101B15"
  border: "#24332A"
  border-strong: "#5E7568"
  border-interactive: "#5E7568"
  text: "#E8F0E9"
  text-prose: "#C3D0C6"
  text-secondary: "#93A69A"
  text-tertiary: "#7F9187"
  text-disabled: "#4E5F55"
  brand: "#6FD3A0"
  attention: "#E8B366"
  attention-ink: "#16110A"
  lottery: "#8B98E0"
  lottery-text: "#A3AFE8"
  admin: "#6E8592"
  admin-text: "#8FA6B2"
  admin-label: "#7E939D"
  admin-ground: "#131C1C"
typography:
  display: "Georgia, 'Palatino Linotype', Palatino, serif"
  ui: "system-ui, 'Segoe UI', -apple-system, sans-serif"
  numerals: "tabular-nums"
  scale: "10 / 11 / 12 / 12.5 / 13 / 15 / 18 / 19 / 21 / 26"
rounded:
  panel: "3px"
  chip: "3px"
  control: "3px"
spacing:
  panel-padding: "12px"
  row-gap: "7px"
  card-gap: "8px"
  section-gap: "22px"
  page-padding: "18px 14px 26px"
components:
  control-height: "46px"
  touch-min: "44px"
  strip-height: "52px"
  border-width: "1px"
  accent-bar-width: "3px"
---

# Appspiration — Design

## Brand & Style

Appspiration is the BBSL's offseason free agent auction, and its visual identity is a joke with a straight face: it dresses as an **eco-friendly banking startup**. The name is a play on Aspiration Inc, the sustainable-banking company at the centre of the alleged Clippers/Kawhi Leonard salary-cap circumvention. The irony is load-bearing, not decorative — the app wears the clothes of the most famous alleged cap-circumvention vehicle in recent memory while being structurally incapable of permitting one.

That pun rhymes exactly with the SPEC's stated posture: **referee, not croupier**. A calm, institutional fintech surface over an engine that cannot be talked round. Every refusal that shows its arithmetic lands the joke again.

**The single strongest shaping force is the SPEC's ban on urgency design.** No countdown pressure, no pulsing, no one-tap raises, no suggested amounts. Nothing on any surface may be built to raise engagement. Where a visual choice would make the auction feel more exciting at the cost of making it feel less trustworthy, it is wrong here.

The audience is 31 fantasy basketball managers fluent in dense stat tables. **Density is a feature, not a compromise.** Design for a reader, not a tourist.

### Voice

Sincere, quietly institutional, faintly overpolished — the register of a bank that wants you to know about its tree-planting programme. A refusal declines you the way a bank declines a transfer: unbothered, precise, receipts attached. Never apologetic, never alarmed, never exclamatory. No exclamation marks anywhere in the product.

## Colors

Dark only. There is no light theme and none is planned — the token set, the contrast audit and the palette all commit to a single surface.

| Token | Value | Use |
|---|---|---|
| `ground` | `#0D1712` | Page background. Deep green-black — the eco-bank ground. |
| `surface` | `#15211B` | Panels, cards, the persistent strip. |
| `surface-sunken` | `#101B15` | Input fields and disabled controls. |
| `border` | `#24332A` | Panel borders and internal rules — **decorative only**, never the boundary of a control. |
| `border-strong` | `#5E7568` | Totals rules, strip top edge. |
| `border-interactive` | `#5E7568` | **Mandatory** on every input, button and meaning-carrying chip outline. |
| `text` | `#E8F0E9` | Primary text and money figures. |
| `text-prose` | `#C3D0C6` | Body sentences in refusals and explanations. |
| `text-secondary` | `#93A69A` | Row labels, player metadata, bidder line. |
| `text-tertiary` | `#7F9187` | Section labels, timestamps, footnotes. |
| `text-disabled` | `#4E5F55` | Disabled control labels. |
| `brand` | `#6FD3A0` | **Brand only.** |
| `attention` | `#E8B366` | The single attention colour. |
| `lottery` | `#8B98E0` | Minimum-Bid Contention accent bar. |
| `admin` | `#6E8592` | Commissioner control class — dashed rules and outlines only. |
| `admin-ground` | `#131C1C` | The recessed ground a Commissioner control block sits on. |

### Two rules that govern every colour decision

**1. Green is brand, never state.** `brand` appears on the wordmark mark, on links, and on the words *Maximum Bid*. It never signals that you are leading, winning, safe, or approved. If green meant "you lead", every screen would turn green and the signal would die in the noise — and green/red is the exact pairing that collapses for a red-green colourblind manager, of whom 31 managers will likely include one or two.

**2. Amber, not red.** `attention` is the only attention colour in the product. Red reads as alarm and alarm is urgency design, which the SPEC forbids outright. Amber is the register of a bank declining a transfer: this did not go through, here is why, nothing is on fire.

### Contrast — measured

WCAG 2.1 AA is a floor, not a target. Every pairing below is **measured, not estimated**. Ratios are stated against `surface` (the tightest ground; every value is higher against `ground`).

| Foreground | On `surface` | On `ground` | Verdict |
|---|---|---|---|
| `text` `#E8F0E9` | **14.28** | 15.74 | AA |
| `text-prose` `#C3D0C6` | **10.40** | 11.46 | AA |
| `text-secondary` `#93A69A` | **6.45** | 7.11 | AA |
| `text-tertiary` `#7F9187` | **4.98** | 5.49 | AA |
| `brand` `#6FD3A0` | **9.09** | 10.01 | AA |
| `attention` `#E8B366` | **8.75** | 9.64 | AA |
| `lottery-text` `#A3AFE8` | **7.79** | 8.58 | AA |
| `admin-text` `#8FA6B2` | **6.53** | 7.20 | AA |
| `border-interactive` `#5E7568` | **3.34** | 3.67 | AA (1.4.11 non-text) |
| `attention-ink` on `attention` | **9.90** | — | AA |

**Two corrections came out of measuring rather than assuming**, and both are recorded here because the original values looked fine to the eye:

- `text-tertiary` was `#67796E` — **3.59:1, a failure**. It carries timestamps, section labels and consequence notes at 10–11px, which is exactly where AA's 4.5:1 applies. Lightened to `#7F9187` rather than enlarging the type, because those small sizes are load-bearing for density.
- Control boundaries were `#46584D` at **2.18:1**, below the 3:1 that WCAG 1.4.11 requires of non-text elements needed to identify a control. Inputs and buttons now use `border-interactive` at 3.34:1. `border` `#24332A` (1.25:1) is decorative panel edging only and must never bound a control.

`text-disabled` `#4E5F55` measures 2.44:1 and is **deliberately exempt** — WCAG 1.4.3 excludes inactive controls. It is only ever legitimate because a disabled control always carries its reason beside it in `text-prose` at 10.40:1. A disabled control without a stated reason is a defect, not a styling choice.

**Auction state is never conveyed by colour alone** — a SPEC constraint and a hard build rule. Every state carries a word *and* a shape (icon, border treatment, or fill) in addition to any colour. A greyscale screenshot of any surface must remain fully readable; that is the acceptance test.

## Typography

Two families. No third.

**Georgia** (`display`) — player names, the wordmark, the words *Maximum Bid*, and refusal headlines. Nothing else.

**system-ui** (`ui`) — every label, number, control, and body string, always with `font-variant-numeric: tabular-nums`.

The split is the personality of the product. In a monospace or a plain sans, a player name is another cell in a table; in Georgia it reads as a *name* — which is what a manager is actually shopping for — while the numbers underneath stay ruthlessly aligned. Names are prose. Money is evidence. They should not look alike.

Explicitly rejected: monospace throughout (fatiguing in prose, and it reads Bloomberg rather than sustainable bank), and Inter/Roboto/Arial.

### Money

Money renders **abbreviated everywhere** — `$14.5M` — including in the Auction view, the refusal arithmetic, the Audit Log and the exports' on-screen review. There is no long-form fallback and no "tap for exact figure."

This is safe because it is not a rounding. A Bid is a whole multiple of **$500,000**, and BBSL Existing Contract salaries sit on the same grid, so every money value in the product — bids, salaries, Available Cap Space, Committed Bids, Minors Exposure, Roster Reserve, Maximum Bid — is exactly representable at one decimal place. `$14.5M` **is** $14,500,000 and can be nothing else. A refusal's arithmetic column sums correctly as displayed, which is the entire reason this is allowed.

**Always exactly one decimal, never dropped** — `$12.0M`, not `$12M`. With tabular numerals the money column aligns on the decimal point, which is what makes a dense table scannable and a four-line breakdown read as arithmetic rather than as a list.

Negative amounts in a breakdown use a true minus sign (`−`, U+2212), not a hyphen.

An unbounded Maximum Bid renders **in words** — "no cap limit" — never as a number, per CAP-4.

## Layout & Spacing

Mobile-first at **375px**, one responsive app across manager and Commissioner surfaces.

Page padding `18px 14px 26px`. Section gap `22px`. Cards `8px` apart. Inside a panel: `12px` padding, `7px` between rows. Section labels are 10px, uppercase, `0.16em` tracking, `text-tertiary`.

Every layout is flex or grid with `gap`. Never margins between siblings, never whitespace-as-spacing.

Commissioner surfaces — the 31-file import and its per-Team preview, the override console, assignment monitoring, export — expand properly on a wide screen but stay fully operable at 375px. A pause during an outage happens wherever the Commissioner physically is, and the SPEC requires the pause to be reachable.

## Elevation & Depth

**There is none.** No drop shadows, no elevation layers, no glows. Depth comes from a 1px border and a surface one step lighter than the ground.

Soft elevated cards were explicitly tried and rejected: their radii and shadow padding cost vertical room the 375px board cannot spare, and the softness undercut the institutional register.

The one exception is the **3px left accent bar** marking Minimum-Bid Contention, and the **3px top accent bar** in `attention` on a refusal panel. These are structural markers, not decoration, and no other element may borrow the device.

## Shapes

`3px` radius on everything — panels, chips, inputs, buttons. Near-square, deliberately. Not 0 (which reads unfinished) and not 12–14px (which reads consumer-friendly and costs space).

Icons are inline stroke SVG on a 24px viewBox at 1.6–3px stroke weight, sized 9–18px. One consistent style. **No emoji anywhere.** Icons never appear without an accompanying word.

## Components

### Money figure
`ui` at 26px on a board card, 21px on a totals row, 17px in the persistent strip. `tabular-nums`, `-0.025em` tracking, `text`. Always one decimal.

### Board card
Flat panel. Player name in Georgia 18px; metadata line in `text-secondary` 12px as `NBA · POS · $0.0M · Nyr`; the current price at 26px with the state chip opposite; the leading Team and manager; time remaining and the absolute close time in the viewer's timezone.

### Teams row
The row of the Teams index (CAP-20). Flat, `surface`, separated from its neighbours by a 1px `border` rule rather than by card gaps — thirty cards at `8px` apart is a scroll nobody finishes, and a ruled list reads as a table on a phone.

Team name and Manager(s) in **`ui` at 15px**, not Georgia. Georgia is reserved for player names, the wordmark, *Maximum Bid* and refusal headlines; a fantasy Team is an entity, not a name a manager is shopping for, and setting it in the display face would put it in the same register as the players it competes for.

Figures in `ui` `tabular-nums` at 15px, labels above them at 10px uppercase `0.16em` `text-tertiary` — the section-label treatment, reused so a figure and its name never separate when the row wraps. Slot counts render as `9 of 12`, with the `of 12` in `text-secondary` so the number carrying the information is the one that reads first. Injury Reserve sits in `text-tertiary` and outside the slot group, because it is the figure most often wrongly folded into the twelve.

The viewer's own row is marked by a **2px `border-strong` left edge** plus `— you` in place of a Manager name. No fill, no accent bar — the 3px left bar belongs to Minimum-Bid Contention and nothing may borrow it, and 2px stays clear of that device while still reading at a glance.

**Every Team name sits in `text`, the viewer's included.** Dimming twenty-nine names to `text-secondary` to make one stand out was drafted and rejected at the mock: the Team name is the row's identity, and inverting that hierarchy across the whole screen is too high a price for a marker the left edge already carries. The Manager name beside it takes `text-secondary`.

**The median line** sits at the foot of the list, separated by a `border-strong` rule, labelled *median* at 10px uppercase, its figures in `text-secondary` at 15px. It is visually quieter than every row above it — it is context, not a verdict.

**Nothing in this component is ever coloured by comparison.** No `attention`, no green, no arrows, no chips, no rank numbers. `attention` marks Outbid and nothing else in the entire system, and there is no state here for it to mark. A greyscale screenshot of this surface is not merely readable, it is identical.

### State chip
Uppercase, 9.5px, `0.09em` tracking, `3px` radius, always carrying an icon and a word. Filled `attention` with `attention-ink` for **Outbid**. Outlined `border-strong` with `text` for **You lead**. Plain `text-secondary` label, no chip, for ambient states (**Open**, **Awaiting bid**).

### Arithmetic breakdown
Label left in `text-secondary`, figure right in `text`, `tabular-nums`, `7px` row gap. Subtotals separated by a `border` rule; the final total by a `border-strong` rule with the label in Georgia. Every breakdown must visibly sum.

### Bid control
Input `46px` tall (above the 44px floor), `surface-sunken`, bounded by `{colors.border-interactive}`, pre-filled with the minimum legal Bid, never offering an amount above the viewer's Maximum Bid. The submit button sits beside it at the same height. When bidding is unavailable both are disabled and **the reason is stated in words beneath them** — never discovered at submission.

### Refusal panel
The most important surface in the product, and the only one with a dedicated visual anatomy.

`{colors.surface}` panel with a **`3px` top accent bar in `{colors.attention}`** — the sole use of a top bar in the system, so a refusal is identifiable before a word is read. Padding `13px 12px 12px`; internal gap `11px` (looser than the standard `7px`, because this is read rather than scanned).

Vertical order and treatment:

| Part | Treatment |
|---|---|
| Headline | Georgia 19px, `{colors.text}`, line-height 1.3 |
| The delta | `ui` 12.5px, `{colors.text-prose}`, line-height 1.6 |
| Gate rows | Two rows, `7px` apart. The refusing gate takes a filled `{colors.attention}` chip with `{colors.attention-ink}`; the passing gate an outlined `{colors.border-interactive}` chip with `{colors.text-secondary}`. Chip left, sentence right, top-aligned. The sentence **wraps to a second line rather than truncating** — since 2026-09-08 the slots row carries two figures (bids against the allowance, and the projected roster count), and a truncated gate sentence is a gate that did not report. Line-height `1.6`, aligned to the first line of the sentence, never centred on the chip. |
| Arithmetic | Separated above by a `{colors.border}` rule. Timestamp caption in `{colors.text-tertiary}` 10.5px, then the standard breakdown, total ruled in `{colors.border-strong}` |
| Bid control | Disabled, with the reason beneath in `{colors.text-tertiary}` 11px |

The filled-versus-outlined chip contrast is what makes the two gates readable as *different kinds of thing* rather than two similar sentences — and it survives greyscale, which a colour difference would not.

See [mockups/House.dc.html](./mockups/House.dc.html).

### Persistent strip
`52px`, full-bleed, `surface`, `border-strong` top edge. Shows *Maximum Bid* in Georgia `brand`, the figure, and Roster Count, at all times, on every surface. Tapping it opens the destinations sheet. Recomputes within one second of any Bid, Auction Close or override.

### Commissioner control
Distinguished from Manager controls by **form, not colour** — colour alone would fail exactly the person it exists to protect. The builder of this app is simultaneously the Commissioner and a competing manager; the referee control and the player control must never be confusable by muscle memory at 4am.

| | Manager control | Commissioner control |
|---|---|---|
| Fill | Solid `#223028` | **Never filled** |
| Border | Solid 1px `{colors.border-strong}` | **Dashed** 1px `{colors.admin}` |
| Width | Full-width or paired with an input | Inline, wrapping, content-width |
| Ground | `{colors.surface}` | `{colors.admin-ground}`, recessed behind a dashed rule |
| Label | None | Persistent *"Commissioner · visible only to you"* in `{colors.admin-text}` |
| Commit | Confirm step | **Always** a reason sheet — free text, no default, no skip |

*The Manager confirmation sheet below is a different object, not a variant of this row: it confirms without demanding a reason.*

Four independent differences — fill, border style, ground, and a mandatory interstitial. Any one alone would be a colour variant; together they are a different object. See [mockups/Commissioner.dc.html](./mockups/Commissioner.dc.html).

### Override reason sheet
Names the act in Georgia. Shows **before → after** for every affected value including both Clocks. States the downstream consequence in words where one exists — voiding a Bid removes its League Clock reset and can end the Auction Phase sooner. Carries an `{colors.attention}` note where the consequence is non-obvious. The reason field is empty on open with no placeholder suggestion. The commit control is itself dashed — even the confirmation is not a Manager button.

### Manager confirmation sheet
The Manager-side counterpart, and the only sheet in the product that is **not** a Commissioner control. Introduced for the Roster Move (FR-44), which a Manager performs on their own Team. Shows **before → after** for that one Team — Cap Space, Roster Count and all three Slot occupancies — names every moved Contract with both placements and both Cap Hits, and states **the direction Maximum Bid moved, in words**, with an `{colors.attention}` note where it is counterintuitive, which for this act is most of the time. **No reason field:** a Manager's strategic decision is not a referee intervention, and demanding a justification for it would be the product asking a manager to explain himself to himself. The commit control is a **solid** Manager control.

**The two sheets are two components.** A single sheet that grows a dashed border and a reason field when the actor is the Commissioner would collapse the four independent differences the table above exists to maintain — and it would collapse them at the exact moment they matter, when the Commissioner is acting on somebody else's Team.

### Paused banner
`{colors.attention}` border on a warm ground, present on every surface, stating that Clocks are stopped, that Bids and Nominations are refused, and that each Clock resumes with exactly the time it held. Carries who paused it, when, and their reason. An outage that looks like an ordinary quiet period is worse than one that announces itself.

## Do's and Don'ts

**Do** let money be dense and aligned. **Don't** abbreviate below one decimal or drop the decimal.

**Do** keep green on the brand. **Don't** let it signal leading, winning, or approval.

**Do** state a disabled control's reason in words beside it. **Don't** let a manager discover a limit by pressing a button.

**Do** reserve three-letter caps for a player's real NBA team, everywhere. **Don't** abbreviate a fantasy Team — every BBSL Team is named after an NBA franchise, so `LAL` bidding on a Laker would print `LAL` twice meaning two different things. Fantasy Teams are always spelled: `Lakers — Meakel`.

**Do** show the arithmetic, always, in full. **Don't** hide it behind a disclosure — auditability over convenience is the SPEC's stated tiebreaker.

**Don't** ever build: a pulsing or reddening countdown, a one-tap raise, a suggested bid amount, a "hurry" state, a leaderboard of spending, or any celebration animation on winning. All are urgency design and all are forbidden.

---

*Companion: [EXPERIENCE.md](./EXPERIENCE.md) — information architecture, behaviour, states and flows.*

*Visual references: [mockups/](./mockups/) — `House.dc.html` (board card states, Maximum Bid panel, refusal, persistent strip), `Positions.dc.html`, `Board.dc.html`, `Auction.dc.html`, `Commissioner.dc.html`. Rendered at the [design canvas](https://claude.ai/code/artifact/53dcf7ff-c80d-4a4d-a75d-28c950a12e96), which also carries the three source directions on its* Direction study *page.*

***Where any mock, wireframe or import disagrees with this document, this document wins.***
