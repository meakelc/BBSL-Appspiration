# Epic 4 Context: The screens the league lives on

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Build the read surfaces the auction is actually lived on, and make them honest about their own age. A Manager opening the app lands on what they lead, have been outbid on and are contending in; can read the whole board unfiltered; can read any Team's cap position in full; and can see all thirty Teams at once against a League Median — all of it one-handed at 375px, and none of it ever showing a figure as current when the client can no longer promise it is. Nothing here is a new rule: every figure is a rendering of something the core already computes, so the work is presentation, freshness and adjacency, not arithmetic. The one exception is the League Median, which is a read-model aggregate and lives with the money arithmetic rather than with the rules.

## Stories

- Story 4.1: Live updates and the freshness contract
- Story 4.2: The persistent strip
- Story 4.3: View the Bid Board
- Story 4.4: Your Positions — the landing
- Story 4.5: View any Team
- Story 4.6: The Teams index and the League Median

## Requirements & Constraints

- **Everything is public.** Every Team figure — Cap Space, Committed Bids, Available Cap Space, Roster Count by slot kind, Free Active/Bench and Free Minor League Slots, Minors Exposure, Nomination Slot status — is visible to every Manager for every Team. There is no partial-information layer and no fog of war. **Maximum Bid is the single exception**, shown only for the viewer's own Team, because it is per-Auction and a team-level rendering of it would authorise nothing.
- **Freshness is three states and exactly one is always true**: Live, Reconnecting, Stale, derived from connection status *and* a positive liveness check together. In anything but Live, money either carries its age or the control it would authorise is disabled. Silence alone can never mean stale — this league has genuinely quiet six-hour stretches, and a client that conflates "nothing changed" with "cannot reach the server" disables bidding all night.
- **Performance floors:** a board change visible within 5 seconds of the originating action with no manual refresh; Maximum Bid recomputed within 1 second of any Bid, Auction Close or override; board and Auction views interactive within 2 seconds on mobile data; a Bid acknowledged within 1 second.
- **No figure on these surfaces is stored.** All are computed from committed state on read, and the Teams index and the individual Team view must be produced by the same computation so they cannot disagree.
- **The League Median with an even count is the lower of the two middle values, never their mean** — the mean lands at $250,000 granularity, falls off the $500,000 grid, and breaks the one-decimal rendering that makes abbreviated money safe everywhere. The lower middle is always a figure some real Team holds. §10 example 28 is its test.
- **The index shows all 30 Teams, never a subset and never paginated**, defaulting to a Team-name sort. Sorting is view state and never changes a figure.
- **Phase changes the shape of these surfaces**: the Teams index is not offered in Setup; in Contract Assignment its slot columns give way to remaining Year Allotment and assignment completion with cap columns retained; Archived is frozen and read-only.
- **No urgency design, anywhere on these screens.** No pulsing or reddening countdown, no "ending soon", no one-tap raise, no suggested amount, no leaderboard, no celebration. A comparison figure is the most tempting place in the product to acquire an opinion, and the median earns its place only as a bare fact.

## Technical Decisions

- **One global watermark, not per-table stamps.** Every projection read carries the highest event `seq` folded, read from a single source, so the board and the Maximum Bid strip can never report different ages.
- **Liveness is an explicit lightweight periodic re-read of that watermark**, not the absence of pushed messages — and it is needed in both directions, since a channel can report `SUBSCRIBED` while delivering nothing. `FRESHNESS_WINDOW` and `STALE_WINDOW` are named constants in `core/constants.ts`, never per-caller guesses.
- **Countdowns are exempt from freshness.** They derive from server-authoritative absolute close timestamps the client already holds, so they keep running in every state; freezing them would invent a problem. Expiry stays authoritative for validation regardless of what the client believes.
- **Maximum Bid on the read path is `evaluate()` output**, recomputed per viewer on every relevant projection change and never memoised, cached or persisted.
- **The League Median lives in `core/money` as pure arithmetic on the branded integer type**, not behind `evaluate()` or `decide()` — a read-model aggregate authorises nothing and is not a rule.
- **The client key is read-only.** These surfaces subscribe to projection tables via Realtime and hold no write path; client-side logic only disables controls and pre-fills amounts.
- **One server-resolved destination list**, filtered by phase and role, rendered twice — by the strip's sheet and by the header menu. They are never two lists kept in sync, and a destination not live in the current phase also refuses server-side.
- **Naming rule, absolute:** a three-letter capitalised abbreviation always means a player's real NBA team; a fantasy Team is always spelled out with its Manager (`Lakers — Meakel`). Money renders abbreviated at exactly one decimal, never dropped.
- Deep links to a single Auction need a **stable, addressable shape**, because Epic 5 emits them into Discord without this epic knowing Discord exists.

## UX & Interaction Patterns

- **Landing is Your Positions** — a destination of its own, not a filter on the board and not a pinned group — grouped in the order the wake-up asks: won while you slept · outbid · you lead · contending · Nomination Slot. An outbid card answers "can I legally re-enter at all" before the question is asked. The full board is one tap away and opens unfiltered; a filtered view must be visibly filtered.
- **The persistent strip** is 52px, full-bleed `surface` with a `border-strong` top edge at the bottom of the thumb zone, carrying *Maximum Bid* in Georgia `brand`, the figure at 17px, and Roster Count at all times. On desktop it moves into the header — persistent visibility of Maximum Bid is a requirement at every width, not a mobile convenience. Tapping it opens the destinations sheet.
- **Board card anatomy:** player name in Georgia 18px, metadata line `NBA · POS · $0.0M · Nyr` in `text-secondary` 12px, price at 26px with the state chip opposite, leading Team and Manager, and time shown **twice** — relative and absolute in the viewer's own timezone.
- **State is never colour alone.** Every state chip carries an icon *and* a word. `attention` marks Outbid and nothing else in the entire system; `brand` green is brand only and never signals leading, winning or approval; the 3px `lottery` left bar belongs to Minimum-Bid Contention and nothing may borrow it. **A greyscale screenshot of the board must remain fully readable** — and of the Teams index, identical.
- **Teams row:** name and Manager(s) in `ui` 15px, not Georgia, because a fantasy Team is an entity rather than a name being shopped for; slot counts as `9 of 12` with the `of 12` in `text-secondary`; Injury Reserve in `text-tertiary` and visibly outside the twelve; rows separated by a 1px `border` rule rather than card gaps. The viewer's own row is marked by a **2px `border-strong` left edge plus `— you`** and is not pinned, reordered or exempted from the sort. The median line sits at the foot behind a `border-strong` rule, labelled *median* and never *average*, visually quieter than every row above it.
- **Empty states are designed screens, not edge cases:** the board at auction open explains the state and points at Nominate; Your Positions with nothing to show points at the board and the unused Nomination Slot.
- **Degradation is announced, recovery is silent.** The transition into Stale must be announced rather than merely rendered — a Manager who set the phone down must not have to notice a subtle label — while returning to Live restores controls immediately with no dialog. A disabled control always states its reason in words.
- At 375px every Manager surface is single-column with no lateral scrolling; the Teams index becomes a genuine table only on desktop.

## Cross-Story Dependencies

- **4.1 lands first.** The watermark, the window constants and the three-state derivation are consumed by 4.2's strip, 4.3's board and 4.6's index; building the surfaces before the contract means retrofitting age labelling onto four screens.
- **4.2 depends on Story 1.6's single destination list** — the strip's sheet renders that same list, not a copy — and on Epic 2's `evaluate()` for the figure itself.
- **4.5 and 4.6 must share one computation.** Build the Team figures once; the index is thirty renderings of it, and a second implementation is exactly the disagreement the requirement exists to prevent.
- **4.3 renders the five Auction states and the four viewer-relative states** produced by Epics 2 and 3 — Awaiting Opening Bid, Open, Minimum-Bid Contention, Closed, Terminated — including the revealed seed and ordered Contender list on a closed lottery.
- **4.4's deep-link shape is consumed by Epic 5** (Discord mentions); fix it here so 5.3 has something stable to emit.
- **Out of scope here:** the Contract Assignment surface itself and Year Allotment mechanics (Epic 6) — 4.6 only renders the column swap; notification delivery (Epic 5); and Commissioner override controls (Epic 7), whose commits these surfaces must nonetheless reflect within the same one-second recompute floor.
