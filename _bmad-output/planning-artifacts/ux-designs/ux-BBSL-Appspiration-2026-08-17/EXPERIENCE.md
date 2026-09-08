---
title: Appspiration Experience
status: final
updated: '2026-09-08'
sources:
  - ../../../specs/spec-BBSL-Appspiration/SPEC.md
design: ./DESIGN.md
---

# Appspiration — Experience

## Foundation

**Form factor.** One responsive web application, mobile-first at 375px. Manager surfaces must work one-handed on a phone. Commissioner surfaces expand on desktop but stay fully operable at 375px, because a pause during an outage happens wherever the Commissioner physically is.

**No UI system.** Nothing is inherited; there is no component library, design system or existing app. [DESIGN.md](./DESIGN.md) is the sole visual identity reference and this document specifies behaviour against it.

**The vocabulary is fixed.** Every capitalised domain term — Maximum Bid, Committed Bids, Minors Exposure, Roster Reserve, Nomination Slot, Minimum-Bid Contention, Auction Clock, League Clock, Year Allotment — is defined in PRD §3 and appears in the interface with exactly that meaning. A synonym in UI copy is a defect, the same as a synonym in code. The interface never invents a friendlier word for a defined term.

**The product's centre of gravity is the refusal, not the bid.** Placing a bid is trivial; being told no at 4am by an app built and operated by a rival manager is the moment the whole trust premise is won or lost. Design effort is allocated accordingly.

## Information Architecture

### Phases

The app changes shape four times. Destinations are filtered by phase and role, and a Manager is never offered a destination that is not live.

| Phase | Live destinations |
|---|---|
| **Setup** | Sign-in · Import · Minor League Eligibility · Manager registration · Auction-open gate |
| **Auction** | Your Positions · Bid Board · Auction · Nominate · Teams · Audit Log · Notification settings · *(Commissioner: admin, overrides in place)* |
| **Contract Assignment** | Contract Assignment · Teams · Audit Log · *(Commissioner: assignment monitoring, export gate)* |
| **Archived** | Bid Board (frozen, readable) · Teams · Audit Log · Export (re-downloadable) |

### Navigation

Two affordances, **one destination list**:

1. **The persistent strip** at the bottom of the thumb zone — shows Maximum Bid and Roster Count at all times per CAP-10, and tapping it opens the destinations sheet. This is the mobile primary.
2. **The header menu** — the same destinations, expandable. This is what survives the trip to desktop, where a bottom strip reads wrong.

They are not two lists kept in sync. They are **one list, rendered twice**, filtered by phase and role. They can never offer different sets.

### Landing

Opening the app mid-auction lands on **Your Positions** — what you lead, what you have been outbid on, and the Minimum-Bid Contentions you are a Contender in. Not a filter on the board and not a pinned group: a destination of its own, because the dominant session is the wake-up and nobody opens this app to browse. See [mockups/Positions.dc.html](./mockups/Positions.dc.html).

It is grouped in the order the wake-up actually asks: **won while you slept · outbid · you lead · contending · Nomination Slot**. An outbid card carries the answer to the next question before it is asked — whether a legal re-entry exists at all — so nobody taps into an Auction to discover it is arithmetically gone.

The full Bid Board is one tap away and **opens unfiltered**, so a filtered view can never be mistaken for the whole board. See [mockups/Board.dc.html](./mockups/Board.dc.html) and [mockups/Auction.dc.html](./mockups/Auction.dc.html).

### Commissioner surfaces

Override controls live **in place, on the object being acted on** — the Auction, the Team, the Bid, the Nomination Slot — visible only to the Commissioner, so an override is performed with full context on screen and its mandatory reason is written against something visible.

Genuinely global acts get their own admin destination: import and preview, Minor League Eligibility, the auction-open gate, pause/resume, assignment monitoring, export and archive, operational health.

## Voice and Tone

Brand voice lives in [DESIGN.md](./DESIGN.md); this is how it behaves in microcopy.

**Refusals state the fact, then the arithmetic.** "This bid was not placed." — not "Oops!", not "Sorry, you can't do that." No exclamation marks anywhere in the product.

**Reassure about state, not about feelings.** "Nothing has been committed and the Auction is unchanged" is worth more at 4am than any apology, because the real fear is that something happened invisibly.

**Consequences are stated in words, not implied by controls.** CAP-18 requires the eligibility screen to say "this Player can be stashed at a $0 Cap Hit" rather than showing a bare checkbox. Generalise it: wherever a control has a non-obvious rules consequence, the interface says the consequence in a sentence.

**Never advise.** The app has no opinion about who is worth what. No suggested bids, no "good value", no comparison beyond the facts already imported. The SPEC's "not a valuation engine" is a voice rule as much as a feature rule. The Teams index tests this hardest — see Component Patterns → Teams index, where a League Median is permitted and every possible reading of it is not.

**Never manufacture urgency.** No "ending soon", no "last chance", no "don't miss out". Time remaining is stated as a fact and never as pressure.

**When the app acts against a manager, it leads with the cause** (added 2026-09-08, FR-40). A cancelled bid is the only thing in this product the app takes away from someone who did nothing wrong, and the effect stated without its cause — *"your bid on Marcus Carter was cancelled"* — is indistinguishable from a defect. The cause comes first and the effect second: *"You won Tyrese Maxey, which filled your last roster spot. Your $2.0M bid on Marcus Carter was cancelled."* No apology, which would concede the app erred; no alarm styling, which would say the same thing louder; and no congratulation wrapped around it, because pairing a win with a confiscation in a cheerful voice is worse than either alone. The register is the one the whole product already uses — a bank stating what it did and why, receipts attached.

## Component Patterns

Visual specifications live in [DESIGN.md](./DESIGN.md); these are behaviours.

### Board card

Shows identity, price, Leading Bidder, state and time remaining per CAP-10. The player metadata line — `NBA · POS · $0.0M · Nyr` — carries the player's real-life team, position, existing salary and contract length, because managers compare candidates positionally and by production and this is the raw material they use.

**Naming rule, absolute and app-wide:** a three-letter capitalised abbreviation always means a player's **real-life NBA team** and never anything else. A fantasy Team is always spelled out plus the acting Manager — `Lakers — Meakel`. Every BBSL Team is named after an NBA franchise, so without this rule a Lakers manager bidding on a Laker prints `LAL` twice meaning two different entities. The rule holds on the board, the Auction, bid history, the Audit Log, Team views, Discord posts and both exports.

### Refusal

The most important screen in the product. Its parts, in order:

1. **Headline** — "This bid was not placed."
2. **The delta in one sentence** — "$15.0M exceeds your Maximum Bid of $14.0M by $1.0M."
3. **Reassurance of state** — "Nothing has been committed and the Auction is unchanged."
4. **Both gates, always** — `Cap · Refused` alongside `Slots · Passed — your 2nd of 2 permitted bids; Roster Count would be 10 of 12`, neither collapsed behind a disclosure.
5. **The full arithmetic**, timestamped "Your figures at 2:14 AM Wed".
6. **The bid control, disabled, with its reason stated** where no legal bid exists.

Point 4 exceeds the SPEC, which only requires the two grounds be *distinguishable*. Reporting the gate that **passed** proves every check ran and this is the only obstacle, which forecloses "what else is it not telling me". It costs one line on every refusal; auditability over convenience is the SPEC's stated tiebreaker.

**The slots figure carries two numbers, not one** (added 2026-09-08, FR-37). Since a Team may hold one outstanding bid beyond its free slots, the roster count alone no longer explains the gate — a manager at `Roster Count 10 of 12` may be permitted two more bids or none, depending on what they already hold. Both figures appear on pass and on refusal alike, in the one-branch discipline this panel already keeps:

- Passed: `Slots · Passed — your 2nd of 2 permitted bids; Roster Count would be 10 of 12`
- Refused on the allowance: `Slots · Refused — this would be your 3rd outstanding bid; 1 free slot permits 2`
- Refused on the precondition: `Slots · Refused — no free Active/Bench slot, so no bid is permitted`

The three read differently on purpose. **"You are at your allowance" and "you have no room at all" have different remedies** — the first resolves itself when an auction closes, the second lasts the whole auction — and a manager who cannot tell them apart will either wait for a close that fixes nothing or give up on a wait that would have.

Money and slots are two independent gates (CAP-4/CAP-6 and CAP-19). They carry distinct machine-readable reasons and distinct arithmetic. **Reporting a capacity refusal as a cap refusal is a defect**, and the interface must make the two visibly different, not merely differently worded.

### Arithmetic breakdown

Every breakdown visibly sums. This is the load-bearing property of the whole product: a manager checking the maths by hand at 4am must find that it adds up. Because all BBSL money sits on the $500,000 grid, the abbreviated figures sum exactly as displayed.

An unbounded Maximum Bid is rendered in words per CAP-4. It appears in the breakdown as a stated outcome, not as a large number, and the breakdown explains *why* — a Free Minor League Slot can absorb this Player at a $0 Cap Hit.

### Bid control

Pre-fills the minimum legal Bid. Never offers an amount above the viewer's Maximum Bid. Disables with a stated reason where the figure is below the minimum legal Bid — the state is reachable straight from import, so it must be visible on arrival rather than discovered at submission.

**The allowance bid is named before it is placed, not after it is lost** (added 2026-09-08, FR-11/FR-40). When the bid about to be submitted would be the Team's allowance bid — one beyond its free slots — the control says so above the confirm step, in words and without alarm: *"This is your 2nd of 2 permitted bids. If you win a player before this auction closes, this bid is cancelled and the next highest bid leads."* Stated once, at the moment of the decision. It is not a warning dialog, not a checkbox, and not repeated on every subsequent view — a manager who understood it the first time should not be nagged, and a manager who did not should not meet the rule for the first time as a loss.

**No control exists to cancel, edit, or lower an accepted Bid.** Not disabled — absent. The **system** can cancel one under FR-40, and that asymmetry is deliberate and worth stating plainly wherever it shows: a manager cannot withdraw a bid, and the app can. Presenting the cancellation as anything the manager did, chose, or could have avoided would be false.

Submission is a deliberate two-part act: enter an amount, then confirm. One-tap raising is forbidden.

### Persistent strip

Present on every surface. Recomputes within one second of any Bid, Auction Close or override. Doubles as navigation.

**It carries the allowance beside the roster** (added 2026-09-08). `Roster 9 of 12` alone stopped answering "can I bid on this" the moment the allowance existed, so the strip reads `Roster 9 of 12 · 2 of 4 bids` — commitments held against commitments permitted. A Team at its allowance shows the figure at parity (`4 of 4 bids`) and that is the whole signal; no colour, no badge, no warning treatment. It is a fact about the manager's own position, not a judgement about it, and the strip is the one surface every screen inherits — a nag here would be a nag everywhere.

### Commissioner control

Visible only to the Commissioner, attached to the object being acted on. Distinguished from Manager controls by four independent differences — never filled, dashed border, its own recessed ground behind a dashed rule, and a persistent *"visible only to you"* label. See [mockups/Commissioner.dc.html](./mockups/Commissioner.dc.html).

**No Commissioner act is ever a single tap.** Every one opens a reason sheet that shows before → after for each affected value including both Clocks, states any non-obvious downstream consequence in words, and requires free text with no default and no skip. The commit control on that sheet is itself dashed — even the confirmation is not a Manager button.

Overrides are refused once the auction is archived. The Commissioner's own Team is subject to every ordinary rule, and the ordinary Manager controls on it behave exactly as they do for anyone else.

### Teams index

The destination the IA has always listed and nothing specified until CAP-20 arrived. It answers one question — *who else can actually chase this player* — for all thirty Teams at once.

**Row shape.** Team name and Manager(s) per the naming rule, then `Roster 9 of 12`, **outstanding bids against the allowance as `2 of 4 bids`** with open lottery entries counted separately, minor-league occupancy as `2 of 3`, Injury Reserve shown and visibly outside the twelve, Cap Space, Committed Bids, Available Cap Space, and Nomination Slot status. Every figure is one CAP-10 publishes for every Team; the index contributes adjacency, not access.

The bids column is not decoration. This screen exists to answer *who else can actually chase this player*, and since 2026-09-08 the roster column alone answers it wrongly in both directions — a Team at `Roster 11 of 12` may have two bids in flight and no capacity left, while a Team that looks fuller may have just had one cancelled. Publishing slots without commitments would leave the index confidently misleading about its own question. Lottery entries are shown apart because they are governed by a different rule and consume no allowance; folding them into one figure would imply a ceiling that does not exist.

**The viewer's own Team is marked and not moved.** No pinning to the top, no exemption from the sort. A manager should have to find themselves in the ordering, because seeing where you sit is the whole function of the screen and a pinned row quietly answers a different question.

**The median line is a fact and nothing more.** One line, labelled *median* and never *average*, reporting Free Active/Bench Slots and Available Cap Space. **Nothing is coloured, badged, or ranked against it.** No "above league median" chip, no green and red, no ordinal position, no copy calling a Team rich, poor, stacked, or thin.

This is the single most dangerous surface in the product for the "never advise" rule. A comparison figure invites a normative read — *you are behind, spend* — and that read would be manufactured by the interface rather than found in the data. It also runs directly at SM-C1, which counts total bid volume as something never to optimise. The median earns its place because a manager genuinely cannot otherwise tell whether $6.0M of room is a lot or a little in this particular offseason. It earns nothing beyond that.

**Sorting.** Available Cap Space, Free Active/Bench Slots, Cap Space, Team name. **Default is Team name**, because alphabetical is the only ordering that expresses no editorial view — opening on a cap-space sort would make the screen a leaderboard, which is precisely what it must not be. Sorting is view state and never alters a figure.

**Phase shape.** In Contract Assignment every Team reads 12 of 12 by definition, so the slot columns stop carrying information and are replaced by remaining Year Allotment — 4-year, 3-year and both 2-year deals shown as used or unused — plus assignment completion. Cap columns stay and now describe settled contracts. Archived freezes that state. Setup does not offer the index; CAP-1's per-Team import preview is a different screen doing a different job, and conflating them would put a market-reading tool in front of a commissioner who is confirming a parse.

**Freshness.** The index carries no bid or nomination control, so there is nothing to disable when the connection degrades. It therefore takes the *other* branch of the freshness rule: in anything but Live, the figures carry their age. Thirty rows of money that quietly went stale is exactly the failure the freshness rules exist to prevent, and the absence of a control is not a reason to say less — it is the reason the label has to do all the work alone.

**375px.** A single-column list of Team rows, not a horizontally scrolling table. Thirty rows is a long scroll and that is acceptable; lateral scrolling is not, because a table that needs it is a table nobody reads on a phone, and this league lives on phones. Money and slots must both be legible without moving sideways. On desktop it becomes a genuine table — thirty rows of comparable figures is the one manager surface that honestly wants to be tabular, and the Commissioner surfaces already establish that pattern at width.

### Audit Log

Readable by any Manager, filterable by Team, Player and event type, exportable. It cannot be edited or deleted by any role including the Commissioner, and the interface offers no affordance that suggests otherwise. Full bid history shows Team, acting Manager, amount and timestamp — **no anonymity at any point**.

## State Patterns

### Auction states

| State | Treatment |
|---|---|
| **Awaiting Opening Bid** | No clock at all. The money slot reads "No opening bid" in `{colors.text-tertiary}`. States that it holds the nominator's Nomination Slot, and shows hours unbid. |
| **Open** (Standard Contention) | Price, Leading Bidder, countdown, absolute close time. |
| **Minimum-Bid Contention** | `{colors.lottery}` left accent bar, icon and label. Contender count. States in words that the clock will not reset on a join. |
| **Closed** | Winner, final amount, Slot placement, and for a lottery the seed and ordered Contender list. |
| **Terminated** | No winner. Player returned to the pool, with the reason if by override. |

**Awaiting Opening Bid keeps the sting.** The public board shows the nominating Team and hours unbid — a Nomination Slot sitting dead is visible to the whole league, not only to its owner. The SPEC records as an accepted consequence that an unbid Nomination holds its Slot for the rest of the Auction Phase, and that the app "surfaces it rather than mitigating it". This is where that surfacing happens, and it should sting a little.

### Viewer-relative states

**You lead** · **Outbid** · **Contender** (in a lottery) · **Not involved**. Each carries a word and a shape. `{colors.attention}` marks Outbid only.

### Cancelled and restored

*(Added 2026-09-08 with FR-40. Three parties see one event, and they need three different things from it.)*

**The manager whose bid was cancelled.** The notice leads with the **cause, not the effect**, because the effect without the cause reads as a malfunction: *"You won Jalen Duren, which filled your last roster spot. Your $2.0M bid on Marcus Carter was cancelled — you had no slot left to place him in."* Then the state: the $2.0M is released and back in Available Cap Space, and Marcus Carter now leads to another Team. **No apology and no alarm treatment.** The app did what the rules say and the manager gained a player; framing it as a loss, or as an error, would misdescribe a win. Equally, no congratulation — pairing "you won" with "we took something" in a cheerful voice is worse than either alone.

**The restored manager.** They stopped watching this auction, possibly days ago. The notice has to re-establish context before it delivers news: *"You lead Marcus Carter again at $1.5M. The bid above yours was cancelled when that Team's roster filled."* Then the two things they need to act: **what it costs them now** ($1.5M re-committed against their cap) and **how long they have** — the clock did not reset, so it may be minutes. A restored manager finding out at expiry that they won a player they had forgotten bidding on is the failure mode this notice exists to prevent.

**The league.** One line in the channel, stating the fact and its cause, in the same register as every other broadcast. The cancelled Team is named without editorial: no "unfortunately", no "had to be".

**On the auction itself,** the cancelled bid stays in the visible history, struck through and labelled *cancelled*, with the win that caused it named. It is not deleted, hidden, or quietly reordered — a manager scrolling the history must be able to see that the bid was real, that it led, and why it stopped leading. This is the same posture the Audit Log takes toward a voided bid, with one difference the copy must carry: **a void says someone decided this bid should not have stood; a cancellation says nothing of the kind.** The bid was good. The slot went away.

**Where nothing survives** and the auction returns to Awaiting Opening Bid, the board shows it as an unbid nomination again — the state it already has a treatment for — rather than inventing a "restarted" state. The history remains, so the auction reads as one a Team led and then did not, which is what happened.

### Phase transitions

League Clock expiry disables Nomination and bidding league-wide, terminates Auctions still in Awaiting Opening Bid with no winner, and moves the League to Contract Assignment. Every Manager is notified. The transition is announced in the app, not merely reflected by controls quietly ceasing to work.

### Paused

Every Clock stops advancing; Bids and Nominations are refused **with the pause stated as the reason**, distinct from every rules refusal. The paused state is unmissable on every surface — an outage that looks like an ordinary quiet period is worse than an outage that announces itself.

### Empty and first-run states

**The board at auction open is empty, and that is a designed screen, not an edge case.** At 12:00pm PST on 14 September the Bid Board has nothing on it and every awake manager is on the nomination surface hunting a first target. The empty board explains this and points at Nominate.

**Your Positions, empty** — for a manager who leads nothing and contends in nothing — points at the board and at their unused Nomination Slot.

### Connection and freshness

**A stale board that still looks live is the worst failure mode in this product.** Everything else the app claims rests on a displayed figure being current; a manager who reads $14.0M, believes it, and bids against it has been misled by the interface even though the server behaved correctly. The SPEC settles this server-side — *"a displayed figure is a rendering; only a freshly computed figure authorises a Bid"* — and that guarantee must be visible on the client, not merely true underneath it.

Three states, and the app is always in exactly one:

| State | Condition | Presentation |
|---|---|---|
| **Live** | Realtime connected, last update < 5s | Default. Nothing is said, because saying "live" constantly is noise. |
| **Reconnecting** | Channel dropped, recovery in progress | The persistent strip changes to state that figures may be stale and gives the age of the last update ("as of 2 minutes ago"). Countdowns continue from the server-authoritative absolute close time — they remain correct because they were never driven by the channel. |
| **Stale** | No update for longer than the reconnect window | **Bid and Nomination controls disable, with the reason stated**, exactly as any other unavailable-control case. Maximum Bid renders as a last-known figure explicitly labelled as such, never as a current one. |

Rules that follow:

- **Money in a non-Live state is never displayed as though it were current.** Either it carries its age, or the control it would authorise is disabled.
- **The transition to Stale is announced, not merely rendered** — a manager who set the phone down and picked it up must not have to notice a subtle label.
- **Recovery is silent and immediate.** Returning to Live restores controls without a dialog; no one needs congratulating for a network.
- **Countdowns never freeze on disconnect.** They derive from an absolute close time already held by the client, so freezing them would invent a problem that does not exist.
- Because expiry is authoritative for validation from the instant it passes, an Auction that expires while the client is Stale displays as expired and refuses bids, whether or not the close sweep has recorded it.

### Sign-in states

Discord OAuth is the only Manager identity path, with a Commissioner sign-in that does not depend on it. Four states:

| State | Presentation |
|---|---|
| **Signed out** | A single Discord action and one sentence of explanation. No email field exists anywhere — this system sends no email for any purpose. |
| **Not registered** | A Discord account the Commissioner has not pre-registered cannot obtain a session. The refusal says so plainly, names the Commissioner as the route to being added, and **does not disclose whether the account exists in the league** beyond that. No retry loop, no "try another account" prompt. |
| **Session expired** | Sessions persist ≥30 days, so this is rare and disorienting when it happens. It states that the session expired rather than presenting as a fresh sign-out, and returns the manager to the surface they were on. |
| **Commissioner fallback** | A sign-in path independent of Discord, reachable without a Discord session, because Discord is a knowingly accepted single point of failure for both identity and transport. It is not advertised on the Manager sign-in screen but must be reachable by someone who knows where it is — a Commissioner locked out during a Discord outage cannot pause the auction, and a reachable pause is the SPEC's core outage mitigation. |

Every sign-in surface renders the phase the league is currently in, so a manager arriving during Setup or Archived is not left wondering whether the app is broken.

### Degraded states

A Discord delivery failure never blocks or reverses the underlying auction action, and is surfaced to the Commissioner rather than to Managers. A stalled close sweep produces *late* closes, never wrong ones: an Auction past its nominal expiry but not yet swept displays as expired and refuses bids, because expiry is authoritative for validation from the instant it passes.

## Interaction Primitives

- **Confirm before commit.** Bids, Nominations, contract assignments and every override are two-part acts. Nothing consequential happens on a single tap.
- **Server-authoritative validation.** Client-side logic only disables controls and pre-fills amounts. A Bid valid when composed but stale on arrival is refused with current figures.
- **Live without refresh.** Board changes appear within 5 seconds of the originating action; Maximum Bid recomputes within 1 second; a Bid is acknowledged within 1 second. When that channel drops, the interface says so and stops presenting figures as current — see State Patterns → Connection and freshness.
- **Countdowns derive from a server-authoritative absolute close time** and are displayed alongside that absolute time in the viewer's own timezone. A countdown alone is never sufficient.
- **Overrides require a free-text reason before they commit**, with no default text and no skip.
- **Entry is usually from Discord.** A notification link must land on the specific Auction it concerns, already signed in, with the manager's position on it visible without a further tap.

## Accessibility Floor

WCAG 2.1 AA. Touch targets ≥44×44px on every bidding and nomination control; the bid control is specified at 46px.

**Auction state is never conveyed by colour alone.** Every state carries a word and a shape. A greyscale screenshot of any surface must remain fully readable — this is the acceptance test.

Green never signals state, which removes the green/red pairing that fails for red-green colourblind viewers. Across 31 managers, one or two are likely affected.

Money is `tabular-nums` throughout so columns align on the decimal, which serves scanning generally and low-vision reading specifically.

Refusals are announced to assistive technology as they appear, not merely rendered — a refusal that a screen reader user must go hunting for is a refusal they may act against.

The 30-day session requirement means a manager rarely re-authenticates, which matters disproportionately for anyone for whom an OAuth round trip on a phone is difficult.

## Responsive & Platform

375px is the design width and the smallest supported. Manager surfaces are single-column throughout.

On desktop the header menu becomes the primary navigation and the persistent strip moves into the header rather than pinning to the bottom of a 1400px viewport. **Maximum Bid remains persistently visible at every width** — this is a CAP-10 requirement, not a mobile convenience.

Commissioner surfaces gain multi-column layouts on desktop: the 31-file import status list, the per-Team preview, and assignment monitoring are all genuinely tabular and benefit from width. All remain operable at 375px.

No native app, no PWA, no web push. Discord is the only notification transport.

## Timezone and Clock Presentation

The BBSL is California-centred with members across the US and contingents in the EU and Australia. The auction runs as a **relay of timezone clusters** — flurries when a region wakes, long quiet stretches between — which is what makes the 48-hour League Clock a plausible ending rather than a formality.

Every time is shown twice: relative ("4h 12m left") and absolute in the viewer's own timezone ("closes 2:14 AM Wed"). The absolute time is the one that matters to a manager deciding whether they will be awake, and it is never omitted to save space.

The Auction Clock never pauses for hours of day. The interface states this plainly rather than letting a manager in Perth discover it.

## Key Flows

### 1. Opening night — the Commissioner alone with thirty-one files

**Meakel, California, 14 September, late morning.** Thirty managers across four continents are waiting on a 12:00pm PST start, and he has thirty-one Fantrax CSV exports: one free agent pool, and one per Team.

1. He opens **Import** and drops all thirty-one files at once.
2. A thirty-one row status list resolves each file to a Team by name. Two rows are flagged — one file did not match any Team, one Team is still missing. Both are named. The malformed file names its offending row per CAP-1.
3. He re-drops the two corrected files. Only those rows change.
4. He reviews the **per-Team preview** — Roster Count and Cap Space for all thirty — and finds a Team whose starting state breaches the 12 Active/Bench ceiling. The import refuses to commit and names it.
5. Fixed and re-dropped, he **commits**. Re-import is now still permitted, and will be refused once the auction opens.
6. He opens **Minor League Eligibility**. Every imported Player defaults to *not* eligible. He marks the eligible ones in bulk, each row stating the consequence in words: *this Player can be stashed at a $0 Cap Hit*.
7. He hits the **open gate**. It checks that the pool import and all thirty Team imports are committed and every Team has a bound Manager, and names anything outstanding.
8. **12:00pm PST.** The auction opens. The Bid Board is empty and says so, pointing at Nominate. Discord announces the phase transition.

> **The climax is step 4** — the moment the app refuses *him*. Meakel is the Commissioner, the builder, and a competing manager, and the first thing the product does in front of the league is decline his own import and name the row. Everything the app claims about itself for the next several days is underwritten by that.

### 2. The wake-up — the session that repeats a hundred times

**A manager in Melbourne, 7:40am local, three days in.** This is the dominant shape of every session in the auction.

1. **Discord notifications surface first.** The app is entered *from* Discord, not opened cold. An outbid mention landed within 60 seconds of the outbidding Bid.
2. The link lands them on **Your Positions**: what they won overnight, what they were outbid on, which lotteries they are still a Contender in.
3. They were outbid on Jalen Duren at $14.5M. They check the persistent strip — **Maximum Bid $14.0M, Roster 9 of 12 · 2 of 4 bids**. They cannot re-enter, and the Auction says so in words rather than letting them find out by pressing a button.
4. They open the **Bid Board** and filter to centres, comparing candidates on the metadata line — real team, position, existing salary and length. The app arranges; it does not advise. There is no "similar players" suggestion and no recommended amount.
5. Their **Nomination Slot** is free. They nominate a comparable free agent — not because they want him, but to pull competing money away from the player they do want. The app has no opinion about that either, which is exactly what makes the move worth making.
6. They go to work. The auction continues without them.

> **The climax is step 3** — Maximum Bid $14.0M against a $14.5M leading bid. The player is gone, arithmetically, and the app tells them so before they can waste a bid finding out. That is the difference between a referee and a slot machine.

### 3. The 4am refusal — where trust is won

**A manager, half awake, chasing a player they have wanted all offseason.**

1. They type $15.0M on Jalen Duren.
2. **Refused at submission.** Nothing was accepted and reversed; nothing appears in the Bid Board or the Audit Log as valid.
3. The screen states the delta — $1.0M over — and reassures that nothing was committed.
4. **Both gates report.** Cap refused; Slots passed — their 2nd of 2 permitted bids, Roster Count would have been 10 of 12. Every check ran; this is the only obstacle.
5. The full arithmetic sums, timestamped, in figures they can verify by hand.
6. The bid control is disabled, with the reason stated: the next legal bid is $15.0M and their Maximum Bid is $14.0M.

> **The climax is step 4→5** — the moment the arithmetic adds up. They put the phone down annoyed at themselves rather than at the Commissioner. In every other auction tool this is a red toast reading "Insufficient funds", followed by twenty minutes in Discord accusing a rival manager of rigging it.

### 4. Losing the draw — the lottery that must prove itself

**Four managers, one $1,000,000 opening bid.**

1. The Auction opens at exactly $1.0M and becomes a **Minimum-Bid Contention**. Its card carries the `{colors.lottery}` accent, an icon, a label, and the words *the clock will not reset on a join*.
2. A manager joins at exactly $1.0M. The clock does not move. $1.0M is committed against their cap.
3. Another attempts $1.2M and is refused — neither a valid entry nor a valid raise, stated as such.
4. At expiry the draw runs. It is uniform at 1/n.
5. The closed Auction shows, permanently: the **seed**, the **ordered Contender list as it stood at expiry**, and the selection. Discord carries the same.
6. The losers can reproduce the result independently. Their commitments release instantly.

> **The climax is step 5** — a losing manager, at 4am, being handed everything needed to check the draw themselves. The seed is commit-reveal and unreadable before the draw by any client-facing role, including the Commissioner who is also playing. That is what makes it acceptable that he built it.

### 5. The morning after the clock dies

**48 hours of league silence. Nobody is present when it happens.**

1. The League Clock expires. It was reset only by Nominations and accepted Bids — never by an Auction Close, draw, dissolution, void, override, or pause.
2. Nomination and bidding are disabled league-wide. Auctions still in **Awaiting Opening Bid** terminate with no winner and their Players return to the pool.
3. The League moves to **Contract Assignment**. Every Manager is notified.
4. Managers wake to a changed app: the Bid Board is frozen and readable, Contract Assignment has appeared, and the persistent strip now reports assignment progress rather than Maximum Bid.
5. Each assigns a length to every Player they won, spending from one 4-year, one 3-year, two 2-year and unlimited 1-year deals, with remaining allotment shown as they go. **No length is ever assigned by default.**
6. The deadline notifies but resolves nothing. Export stays blocked until every Auction Contract has a length. An unresponsive Team is resolved by the Commissioner assigning on its behalf with a recorded reason — a visible act, never a silent fallback.

> **The climax is step 4** — thirty people waking up to an app that has changed shape without anyone touching it. It has to be immediately obvious what happened and what is now being asked, because the one thing nobody will do is read an explanation.

---

### 6. The bid that was taken away — the rule most likely to be read as a bug

**A manager in Denver, mid-morning, four days in.** They have one roster spot left and two players they want.

1. They lead **Marcus Carter at $2.0M**. They go to bid on **Tyrese Maxey** as well. The bid control tells them, before they confirm: *"This is your 2nd of 2 permitted bids. If you win a player before this auction closes, this bid is cancelled and the next highest bid leads."* They read it, decide the double chase is worth it, and confirm.
2. Overnight, **Maxey closes first** and they win him. Their roster fills.
3. The Discord mention that wakes them leads with the win: *"You won Tyrese Maxey at $7.5M, which filled your last roster spot. Your $2.0M bid on Marcus Carter was cancelled — you had no slot left to place him in."*
4. They open **Your Positions**. Maxey is in the won column. Carter is gone from their leading column, and the $2.0M is back in Available Cap Space. Nothing has to be reconciled by hand.
5. They open the Carter auction out of curiosity. Their bid is **still there in the history**, struck through and labelled *cancelled*, naming the Maxey win as the cause. Another Team leads at $1.5M.
6. They are annoyed at the trade-off they knowingly took, not at the app.

> **The climax is step 1, not step 3.** The notice in step 3 is well-written and it is not what does the work — by then the outcome is fixed and the only question is whether the manager was ambushed. Step 1 is where that is decided. A product that explains this rule beautifully *after* it fires has already failed; the entire job is to have said it once, plainly, at the moment the manager chose to accept it. This is the one flow in the product where the interface's obligation is almost entirely discharged before anything happens.

## Open items

- **`[RESOLVED 2026-08-18]`** The two-file import conflict is reconciled upstream. `SPEC.md` CAP-1, and the PRD's FR-1 and FR-3, now describe **thirty-one files** — one Free Agent pool plus one per Team — with per-file parse status, Team resolution by name, outstanding Teams named rather than counted, single-Team re-supply, and an all-or-nothing commit. The retired-assumptions note in `SPEC.md` records the correction.
- **`[RESOLVED 2026-08-18]`** The **Teams index** (CAP-20 / FR-39) was named in the IA from the start and specified nowhere. It now has a Component Pattern above. Resolving it also removed CAP-10's own-team-only reservation on Free Minor League Slots and Minors Exposure, which was never enforceable — both were derivable from published figures, and a thirty-row index made the derivation free. **Every Team figure is public**, Maximum Bid excepted because it is per-Auction.
- **`[ASSUMPTION]`** Co-managed Teams: the acting Manager varies bid to bid, and the naming rule renders `Lakers — Meakel`. Where both co-managers must be distinguished in history and Discord mentions, the acting Manager is authoritative. Not yet walked as a flow.
- **`[RESOLVED 2026-08-17]`** Contrast was measured rather than promised. Two failures were found and fixed: `text-tertiary` (3.59:1 → 4.98:1) and control boundaries (2.18:1 → 3.34:1). Full table in [DESIGN.md § Colors → Contrast](./DESIGN.md).
- **`[DEFERRED]`** Nine medium and eight low findings from `review-rubric.md` are documented and unfixed — chiefly: no Key Flow for CAP-14 (override), CAP-13 (export) or CAP-16 (operational alerting); no cold-load, Contract Assignment or import-error states in State Patterns; the destinations sheet and filter chips unspecified; no flow→capability traceability; and no Inspiration & Anti-patterns section, so the rejected visual directions and their reasons live only in the canvas annotations.

### Surfaces built from the spines alone

These have no mock and are specified by table and rule only: Sign-in, Nominate, Audit Log, Notification settings, Import and its 30-Team preview, Minor League Eligibility, the auction-open gate, assignment monitoring, Contract Assignment, Export and archive, and operational health. Say so if any of them turns out to need a visual reference before it is built.

**Teams was on that list and came off it 2026-08-18**, mocked as [mockups/Teams.dc.html](./mockups/Teams.dc.html). It was flagged as the highest-drift-risk spec-only surface, and drawing it settled two things prose had left ambiguous — recorded in [DESIGN.md § Components → Teams row](./DESIGN.md): the own-row marker is a 2px left edge plus `— you` rather than a dimmed field of other Teams' names, and every Team name stays in `text` because the name is the row's identity. The density held: seven figures per row at 375px reads without lateral scrolling in three bands — identity, slots, money.

---

*Companion: [DESIGN.md](./DESIGN.md) — visual identity, colour, type and component specifications.*

*Visual references: [mockups/](./mockups/) — `Positions.dc.html`, `Board.dc.html`, `Auction.dc.html`, `Commissioner.dc.html`, `Teams.dc.html`, `House.dc.html`. Rendered at the [design canvas](https://claude.ai/code/artifact/53dcf7ff-c80d-4a4d-a75d-28c950a12e96).*

***Where any mock, wireframe or import disagrees with this document, this document wins.***
