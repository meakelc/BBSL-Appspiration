---
title: BBSL Offseason Free Agent Auction
status: final
created: 2026-08-16
updated: 2026-08-18
---

# PRD: BBSL Offseason Free Agent Auction
*Working title — confirm.*

## 0. Document Purpose

This PRD is for the builder-commissioner of the BBSL (a 30-team dynasty fantasy basketball league, now entering its 6th season) and for the downstream BMad workflows that will consume it — UX, architecture, and epic/story breakdown. It is structured Glossary-first because this product is fundamentally a *rules engine*: almost every requirement is a precise statement about money, timers, or eligibility, and a single synonym slipping into the vocabulary is how a league loses trust in its auction. §3 fixes the vocabulary; §4 groups features with globally numbered FRs nested underneath; §10 walks worked rule-resolution examples that exist specifically to keep implementers from guessing at the edge cases. Inferences are tagged inline as `[ASSUMPTION]` and indexed in §12.

No prior design or research artifacts exist for this product. Technical mechanism — CSV column shapes, timer implementation strategies, concurrency approach — deliberately lives in `addendum.md` alongside this file, not here.

> **Status: no blocking items, no open questions.** Every rule needed to compute a bid is settled. The one rule most likely to surprise a reader is **FR-35**: a team with a free Minor League Slot can bid without any cap limit, because a stashed contract carries a $0 cap hit and the real constraint is applied at activation, inside Fantrax. Read FR-35, **FR-37**, and §10 examples 18–25 before touching cap or roster logic.
>
> **Amended 2026-08-17 (first pass)** after the architecture spine's reviewers found two contradictions inside FR-35's orbit — the §10 examples disagreed with the Glossary on Free Minor League Slots, and a minimum-bid lottery on an eligible player was governed by two incompatible commitment rules. Both are resolved in the text and recorded in §12; the Glossary was correct in both cases. The same pass moved authentication to Discord OAuth (FR-4) and notifications to Discord mentions (FR-27) under a zero-budget constraint, and corrected §5's concurrency requirement from per-Auction to global serialization.
>
> **Amended 2026-08-17 (second pass)** when the commissioner answered every open question. Six of the nine were confirmations; three changed rules, and one of those is new arithmetic:
>
> - **OQ-1 became FR-37 — Active/Bench capacity is a hard ceiling of 12** (8 active + 4 bench), not merely a minimum. A Bid is now refused when `Roster Count + Projected Active/Bench Additions` would exceed 12, with no carve-out for an eligible win that overflows out of minors. This is a **second, independent refusal ground alongside Maximum Bid**, and it forced §10 examples 18–20 to move Team P from Roster Count 12 to 11 — at 12 the new ceiling would have refused example 20's bid on capacity and contradicted its stated outcome.
> - **OQ-4 — bid granularity is $500,000**, not the $100,000 previously assumed. Granularity and Minimum Increment now coincide, which means no grid-valid Bid can ever be sub-increment and the $1M–$1.5M lottery dead zone contains no grid-valid amount at all. Both are reachable only by an off-grid submission (FR-11, §10 examples 2 and 10).
> - **OQ-2 — the Fantrax export does not carry the eligibility flag.** It becomes commissioner-set app data (FR-38), defaulting to *not* eligible so the flag can never hand out unbounded bidding by omission.
> - **OQ-3** — the export now blocks until every Team assigns; FR-29's 1-year auto-default is removed. **OQ-7** — voiding a Bid recomputes the League Clock without that Bid's reset. **OQ-8** — §5's availability target is restated as a posture rather than a number. **OQ-5, OQ-6, OQ-9** — confirmed with no rule change; §11 records all nine.
>
> Examples **24–27** were added to §10 to give each of the new rules a worked case.
>
> **Amended 2026-08-18 (third pass)** when the commissioner identified a missing read surface: a list of all 30 Teams with their remaining roster slots and cap position. It became **FR-39**, and pulled two other things with it:
>
> - **FR-25's public/private split was removed.** It had reserved Free Minor League Slots and Minors Exposure to the viewer's own Team, but both are derivable from figures FR-23 and FR-25 already publish, so the concealment was never real — and FR-39 would have made the derivation trivial for all thirty Teams at once. Every Team figure is now explicitly public, stated once in §4.6's preamble.
> - **A new Glossary term, League Median, carries a rounding trap** worth reading before implementing: with 30 Teams the conventional median is the mean of the two middle values, which can land at $250,000 granularity — off the $500,000 grid, and therefore **not** losslessly renderable at one decimal, which is the property the whole product's money rendering depends on. The League Median is defined as the *lower* middle value instead. §10 example **28** was added to make that executable.
>
> FR-39 adds no new rule to the auction engine. It is a read surface over figures the app already computes, and it authorises nothing.

## 1. Vision

For five offseasons the BBSL has run its free agent auction by hand. The rules are genuinely good — an open ascending auction with a rolling 24-hour clock, a nomination system that paces the market, a minimum-salary lottery that gives every team a shot at depth, and a contract-length allotment that forces real dynasty tradeoffs. The rules are also, run manually, a part-time job. Somebody has to notice a clock expired. Somebody has to check whether a team can actually afford the bid it just posted. Somebody has to remember that a team already spent its 4-year contract. And when somebody gets it wrong at 1am, thirty people find out in the morning.

This app runs that auction. It is a responsive web app the whole league lives in for the two or three weeks the auction takes: nominate a player, watch the board, place a bid, get told the instant you're outbid. It knows every team's cap space to the dollar, knows exactly what each team is allowed to bid right now, and refuses invalid bids at the moment they're attempted rather than after the damage is done. It runs the clocks itself. It draws the minimum-salary lottery with a seed anyone can verify. It ends the auction on its own when the league goes quiet for 48 hours, walks every manager through assigning contract years against their allotment, and hands the commissioner a file to upload back into Fantrax.

The point is not automation for its own sake. The point is that the commissioner gets to play in their own league again, and that when a team loses a player by $500k at 4 in the morning, nobody has to wonder whether the app got it right.

## 2. Target User

Thirty-one people: thirty team managers (one team is co-managed by two people) plus one of them wearing a commissioner hat. They are adults with jobs who check their phone. They have been in this league five years and care about it disproportionately.

### 2.1 Jobs To Be Done

- **Don't let me lose a player because I wasn't looking.** Tell me the moment I'm outbid, on the channel I actually read.
- **Tell me what I can afford, right now, without me doing arithmetic.** I have pre-existing contracts, roster holes to fill, and live bids out on three other players. Just show me my number.
- **Stop me from making an illegal bid** before I make it, not after everyone's seen it.
- **Let me bid from my phone in ninety seconds** — I'm not opening a laptop to move $500k.
- **Make the lottery provably fair.** When I lose a $1M coinflip I want to be able to check.
- **Let me nominate strategically** — put a player on the board to shake loose someone else's cap space, without being forced to bid on him.
- **(Commissioner) Let me run this without being the timer, the calculator, and the referee.** And when something does go wrong, let me fix it with a record of what I did.
- **(Commissioner) Get the results back into Fantrax** without transcribing 60 contracts by hand.

### 2.2 Non-Users (v1)

- **Other dynasty leagues.** This is single-tenant and hard-wired to BBSL rules. Making the ruleset configurable is a v2 conversation, not a v1 constraint.
- **Spectators / the public.** No anonymous read-only view of the board.
- **In-season users.** This app runs the offseason auction and then goes quiet. Waivers, trades, lineups, and scoring all stay in Fantrax.

### 2.3 Key User Journeys

- **UJ-1. Marcus gets sniped at work and answers in ninety seconds.**
  Marcus manages a rebuilding team with real cap room and has been leading on a starting center at $14M for most of a day. Already signed in on his phone from a previous session. Mid-afternoon his phone buzzes — Discord, where the league channel has just named him: he's been outbid at $14.5M. He taps through to the player's auction page. The page shows the current price, the bid history with team names, the clock now reading 23h 58m, and — the part that matters — **his** maximum allowable bid of $19M, already net of the two other auctions he's leading and the $2M he must reserve for his last two roster holes. He taps the $15M quick-bid chip and confirms. The board updates; the clock resets to 24h; the Discord channel announces it. Total elapsed: under two minutes, standing in a hallway. **Edge case:** had he tried $19.5M, the app would have refused before submission and shown him the arithmetic — cap space, committed bids, roster reserve — rather than a bare "invalid bid."

- **UJ-2. Dana takes a flyer on a rookie and wins a coinflip she can audit.**
  Dana's team is capped out and she needs bodies at the minimum. She opens the board on her laptop and nominates a fringe wing nobody has mentioned, opening at $1,000,000. The player card immediately shows a distinct **Minimum-Bid Contention** state: a lottery badge, a clock that reads *24h, does not reset*, and a list of contending teams — currently just hers. Over the next day three other managers add their own $1M bids; each appears in the contention list, the clock keeps counting down untouched. At expiry the app draws. Dana loses. The player page now shows the winner, the four contenders, the seed the draw used, and the resulting draw order — she can re-run the check herself and see her name wasn't third for convenient reasons. She's annoyed but not suspicious. **Edge case:** had anyone bid $1.5M during that day, the lottery would have dissolved on the spot, the clock would have reset to a fresh 24h, and the auction would have continued under ordinary ascending rules.

- **UJ-3. Priya and her co-manager split a team without stepping on each other.**
  Priya co-manages with her brother; they each have their own login bound to the same team. She opens the board and sees their team is leading on two players — the bid history shows **her brother's name** on one, not just the team name. Their shared max-bid figure already accounts for both. She wants a third player; the app tells her the team's remaining nomination slot is already spent on a player still sitting unbid, so she can't nominate — but she can still bid on anything on the board. She bids, and the notification that goes out to the league names her specifically. **Edge case:** if her brother is composing a bid on the same player at the same moment, the second bid to land is validated against the state the first one created, and one of them is told the price moved.

- **UJ-4. Meakel closes the books and gets it back into Fantrax.**
  As commissioner, Meakel gets the notification that 48 hours have passed with no nomination and no bid. The app has moved the league into the contract-assignment phase and every manager has been told they have a deadline to spend their year allotment. He watches the completion tracker fill in — 26 of 30 teams done, four nudged. When the last one lands, he opens the export screen, reviews the full contract table on screen, and downloads the Fantrax-shaped CSV. He uploads it through Fantrax commissioner controls, comes back, and marks the auction archived. **Edge case:** two teams miss the deadline; he uses commissioner controls to assign their remaining players 1-year deals, and the override is stamped with his name and reason in the audit log for anyone to read.

## 3. Glossary

*Downstream workflows and readers must use these terms exactly. Introducing a synonym anywhere is a discipline violation.*

- **League** — the BBSL. Exactly one, containing 30 Teams. Single-tenant.
- **Team** — one of 30 roster-holding entities. Has a Salary Cap, a set of Contracts, and one or more Managers.
- **Manager** — a human user account. 31 exist. Each is bound to exactly one Team; one Team has two Managers.
- **Commissioner** — a Manager additionally holding league-administrative privileges. Exactly one. Retains full Manager rights over their own Team.
- **Salary Cap** — $165,000,000. Identical for every Team.
- **Contract** — a Player held by a Team at a stated annual Cap Hit for a stated number of years. Contracts predating this auction are **Existing Contracts**; those created by it are **Auction Contracts**.
- **Cap Hit** — the annual dollar amount a Contract charges against the Salary Cap. Players in Minor League Slots have a Cap Hit of $0; players in Injury Reserve Slots have their full Cap Hit.
- **Cap Space** — Salary Cap minus the sum of all Cap Hits currently on a Team's roster.
- **Committed Bids** — the money a Team must hold against its cap for auctions still open: the sum of its leading amounts on all open Auctions for Players who are **not** Minor League Eligible, plus its **Minors Exposure**. A Minimum-Bid Contention the Team is contending in counts as a leading amount of $1,000,000, since any Contender may win — included directly in Committed Bids when the Player is **not** Minor League Eligible, and treated as an **Eligible Leading Bid of $1,000,000** feeding Minors Exposure when he is. See FR-18.
- **Available Cap Space** — Cap Space minus Committed Bids.
- **Free Minor League Slots (M)** — 3 minus the number of Minor League Slots the Team currently occupies.
- **Eligible Leading Bids (N)** — the Team's leading amounts on open Auctions for Minor League Eligible Players, including $1,000,000 for each open Minimum-Bid Contention on a Minor League Eligible Player in which the Team is a Contender.
- **Overflow Count** — `max(0, N − M)`. How many Eligible Leading Bids must land in an Active/Bench Slot in the worst case, because the Team's Minor League Slots will be full by the time they close.
- **Minors Exposure** — the sum of the **Overflow Count largest** Eligible Leading Bids. Zero when `N ≤ M`. The worst case is that the Team's most expensive eligible wins are the ones that overflow, because Slot Placement follows close order, which no bidder controls.
- **Roster Slot** — a position on a Team's roster. Three kinds: **Active/Bench Slot** (**exactly 12 per Team — 8 active plus 4 bench**; incurs Cap Hit), **Injury Reserve Slot** (2 per Team, incurs Cap Hit, does **not** count toward the 12), **Minor League Slot** (3 per Team, no Cap Hit, does not count toward the 12, requires a Minor League Eligible player).
- **Roster Count** — the number of players a Team holds in Active/Bench Slots. Injury Reserve and Minor League players are excluded. **Bounded by 12 at both ends: a Team must reach 12 before the export will accept it (FR-30) and can never exceed 12 (FR-37).**
- **Free Active/Bench Slots** — `12 − Roster Count`. The Active/Bench counterpart to Free Minor League Slots, and the plain-language answer to "how many roster holes does that Team still have". A **display** figure only: it takes no account of Projected Active/Bench Additions and therefore never authorises a Bid. Roster Capacity (FR-37) is the gate; this is the number a manager reads on the Teams index (FR-39).
- **Roster Capacity** — the constraint `Roster Count + Projected Active/Bench Additions ≤ 12`. A Bid that would breach it is refused regardless of the Team's cap position, because there is no Slot to place the won Player in. Independent of Maximum Bid: a Team can fail this check with unlimited money and pass it with none. See FR-37.
- **Slot Placement** — the automatic assignment of a won Player to a Roster Slot at Auction Close. A Minor League Eligible Player is placed in a Minor League Slot if one is free, and in an Active/Bench Slot otherwise. Every Player who is not Minor League Eligible is placed in an Active/Bench Slot. No Manager or Commissioner choice is involved.
- **Projected Active/Bench Additions** — the number of Active/Bench Slots a Team's open bids will fill in the worst case, counting the bid being placed: its leading amounts on non-eligible Players, plus the Overflow Count, each computed as though the prospective bid were already placed.
- **Roster Reserve** — money a Team must hold back to fill its remaining Active/Bench holes at the minimum: `$1,000,000 × max(0, 12 − (Roster Count + Projected Active/Bench Additions))`.
- **Maximum Bid** — the largest legal bid a Team may place **on a specific Auction** at this instant. For a Player who is not Minor League Eligible, and for a Minor League Eligible Player whose addition would push the Team into Overflow: `Available Cap Space − Roster Reserve`. For a Minor League Eligible Player the Team's Free Minor League Slots can absorb, the bid commits nothing and Maximum Bid is **unbounded**, provided Roster Reserve remains coverable. Maximum Bid is therefore a per-Auction figure, not a single per-Team number. **Maximum Bid governs money only; Roster Capacity is a separate gate a Bid must also pass (FR-37), and an unbounded Maximum Bid does not exempt a Bid from it.**
- **Minor League Eligible** — a Player who has played fewer than 82 lifetime NBA games. Required to occupy a Minor League Slot. **The Fantrax export does not carry this flag, so it is Commissioner-set app data (FR-38), applied before the auction opens and defaulting to *not* eligible.**
- **Free Agent** — a Player in the imported pool, not under Contract to any Team, and not yet won in this auction.
- **Nomination** — the act of placing a Free Agent onto the Bid Board. Does not obligate the nominating Team to bid.
- **Nomination Slot** — a Team's right to have one Nomination in play. Released when the auction for that nominated Player closes.
- **Bid Board** — the set of all Players with open auctions.
- **Auction** — the contest for a single nominated Player. Has a state: **Awaiting Opening Bid**, **Standard Contention**, **Minimum-Bid Contention**, or **Closed**.
- **Opening Bid** — the first Bid placed on an Auction. Minimum $1,000,000. Starts the Auction Clock.
- **Bid** — a Team's offer on an Auction. Must be a whole multiple of **$500,000**. Because that equals the Minimum Increment, every legal Bid in Standard Contention is exactly one or more increments above the current high; a sub-increment Bid is necessarily also off-grid.
- **Leading Bidder** — the Team holding the highest Bid on an Auction in Standard Contention.
- **Minimum Increment** — $500,000. The least a new Bid must exceed the current high Bid by in Standard Contention.
- **Auction Clock** — the 24-hour countdown whose expiry closes an Auction.
- **Minimum-Bid Contention** — the Auction state entered when the Opening Bid is exactly $1,000,000. Additional Teams may join by bidding exactly $1,000,000; the Auction Clock does **not** reset; the winner is drawn by Randomizer at expiry.
- **Contender** — a Team that has bid exactly $1,000,000 into a Minimum-Bid Contention.
- **Randomizer** — the seeded, auditable random draw that selects the winner of a Minimum-Bid Contention.
- **Standard Contention** — the ordinary ascending-auction state. Minimum Increment applies; every valid Bid resets the Auction Clock.
- **Auction Close** — the moment an Auction's Clock expires and a winner is determined.
- **League Clock** — the 48-hour countdown, reset by any Nomination or Bid, whose expiry ends the Auction Phase.
- **Auction Phase** — the period from auction open until the League Clock expires.
- **Contract Assignment Phase** — the period after the Auction Phase in which Teams choose contract lengths for the Players they won.
- **Year Allotment** — each Team's per-offseason budget of contract lengths: one 4-year, one 3-year, two 2-year, unlimited 1-year.
- **League Median** — the middle value of a figure across all 30 Teams, used only on the Teams index (FR-39) as a comparison line. **With an even number of Teams it is the lower of the two middle values, not their mean.** The conventional mean-of-two-middles can land halfway between two grid values — a median of $4,000,000 and $4,500,000 is $4,250,000 — which is off the $500,000 grid and therefore *not* losslessly renderable at one decimal place, breaking the property that makes abbreviated money safe everywhere else in the product. The lower middle value is always a figure some real Team actually holds, and is always on the grid. See §10 example 28.
- **Audit Log** — the append-only, league-visible record of every Nomination, Bid, Auction Close, Randomizer draw, and Commissioner override.

## 4. Features

### 4.1 League Setup and Fantrax Import

**Description:** Before the auction opens, the Commissioner loads the league's starting state from Fantrax. Fantrax offers no supported write API and does not expose salary or contract data through its documented read surface, so v1 uses a CSV round-trip: the Commissioner exports from Fantrax commissioner controls and uploads the files here. The app validates them hard and refuses to open the auction on a bad import — a silently wrong cap figure discovered mid-auction is unrecoverable. Import is re-runnable up until the auction opens, and locked afterward except through §4.10 overrides. Realizes UJ-4.

**Functional Requirements:**

#### FR-1: Import team rosters and existing contracts

Commissioner can upload Fantrax-exported roster/salary files establishing, for all 30 Teams, their Existing Contracts, each Contract's Cap Hit, and each player's Roster Slot kind. **Fantrax exports one file per Team, so this is thirty files, supplied together as a batch — not one file covering the league.**

**Consequences (testable):**
- System computes and displays each Team's Cap Space as `$165,000,000 − Σ(Cap Hits)`, treating Minor League Slot players as $0.
- System resolves each file to exactly one of the 30 Teams, and rejects the file — naming the file, not a row — when it resolves to no Team or to a Team already supplied.
- System rejects the import and names the offending row when a Team's computed Cap Space is negative, a required column is absent, a Team ID does not resolve to one of the 30 Teams, or **a Team's Roster Count exceeds 12, its Injury Reserve players exceed 2, or its Minor League players exceed 3** — the slot ceilings of FR-37 must hold from the starting state onward.
- System reports parse status per file and **names** every Team still outstanding rather than reporting a count.
- A single Team's file can be re-supplied to replace that Team's rows without re-supplying the other twenty-nine.
- System reports, before commit, a per-Team preview of Roster Count and Cap Space across all 30 Teams for Commissioner confirmation. Commit is all-or-nothing; a partially imported League is never a reachable state.
- Re-importing before auction open replaces prior state entirely; re-importing after auction open is refused.

#### FR-2: Import the free agent pool

Commissioner can upload the Fantrax free agent export, establishing the set of Players eligible for Nomination.

**Consequences (testable):**
- Each imported Player carries a stable Fantrax player ID, name, position, and NBA team.
- **Minor League Eligible is not imported.** The Fantrax export does not carry the flag; every imported Player defaults to **not** eligible and the Commissioner sets it by hand under FR-38.
- A Player appearing both in the free agent pool and on a Team's roster is rejected as a conflict, naming the Player and Team.
- System reports the imported pool size for confirmation before commit.

#### FR-3: Open the auction

Commissioner can transition the League from setup to Auction Phase.

**Consequences (testable):**
- System refuses to open unless the FR-2 pool import and all thirty FR-1 Team imports are committed and every Team has at least one bound Manager. Anything outstanding is named.
- System reports the count of Players marked Minor League Eligible (FR-38) for explicit Commissioner confirmation before opening. It does **not** block on that count: nothing external defines completeness, and the default of *not* eligible is the safe direction.
- On open, all 30 Teams receive an unused Nomination Slot, the League Clock starts at 48 hours, and every Manager is notified.
- Auction open is recorded in the Audit Log with timestamp and actor.

#### FR-38: Set Minor League Eligibility

*(Numbered after FR-37 because it was added when OQ-2 resolved; it belongs to this feature.)*

Commissioner can mark which Players in the Free Agent pool are Minor League Eligible.

**Consequences (testable):**
- Eligibility is app-owned data, not an imported column. Every Player defaults to **not** eligible, so an unset flag can never grant the unbounded bidding of FR-35 by omission.
- The Commissioner can set and unset the flag on any pooled Player, individually and in bulk, up until the auction opens.
- After the auction opens the flag is locked and changeable only by Commissioner override (FR-32), because it changes cap arithmetic under FR-35 for every open Auction on that Player.
- Every change is written to the Audit Log with actor, Player, before and after values, and — post-open — a reason. Because eligibility is reference data that cap arithmetic folds against, each change is recorded as an event so a state rebuild reproduces the flag as it stood, not as it is now.
- The screen shows, per Player, the flag and the Team-facing consequence in words, so the Commissioner is setting "this Player can be stashed at a $0 Cap Hit" rather than an unexplained checkbox.

### 4.2 Identity, Teams, and Roles

**Description:** Thirty-one accounts, thirty teams, one team with two managers. Ceremony is kept to a minimum — this is a private league, not a product with a signup funnel. Every action in the app is attributed to the individual human who took it, not merely to their team, because a co-managed team needs to be able to reconstruct who did what. Realizes UJ-3.

**Functional Requirements:**

#### FR-4: Manager authentication

A Manager can sign in and reach their Team's auction view without a password.

**Consequences (testable):**
- Sign-in is by **Discord OAuth**. The Commissioner pre-registers each Manager's Discord account; no self-service registration exists.
- A Discord account not pre-registered cannot obtain a session.
- A session persists at least 30 days so a returning mobile user is not re-authenticating under time pressure — and so a Discord outage does not log the league out.
- Sign-in records the Manager's Discord user ID, which FR-27 uses to address them. Authentication and notification addressing are the same fact, captured once.
- **This system sends no email for any purpose.** There is no address to verify, no magic link, and no password to reset.
- A Commissioner-only sign-in path that does not depend on Discord must exist, so FR-34's pause remains reachable when Discord is the component that has failed.

#### FR-5: Team binding and co-management

A Manager acts on behalf of exactly one Team; a Team may have more than one Manager.

**Consequences (testable):**
- Both Managers of a co-managed Team see identical Team state — same Cap Space, same Maximum Bid, same Nomination Slot status.
- Every Nomination and Bid records the acting Manager's identity alongside the Team's, and both are shown in the Audit Log.
- Public-facing displays (Bid Board, notifications) show the Team name with the acting Manager's name attached.
- Neither co-Manager can outbid their own Team (see FR-11).

#### FR-6: Commissioner role

The Commissioner holds league-administrative privileges in addition to full ordinary Manager rights over their own Team.

**Consequences (testable):**
- Commissioner-only capabilities (§4.1, §4.9, §4.10) are unreachable by a non-Commissioner Manager, by UI and by direct request alike.
- The Commissioner's own Team is subject to every ordinary rule without exception; no commissioner privilege alters their Cap Space, Maximum Bid, or Nomination Slot.
- Every Commissioner action taken in an administrative capacity is written to the Audit Log with actor, timestamp, and stated reason.

### 4.3 Nomination

**Description:** Nomination paces the auction. Each Team may have one Nomination in play at a time, and gets its Nomination Slot back only when that Player's Auction closes. Crucially, nominating does not oblige you to bid — you can put a player on the board purely to make rivals spend. The league has explicitly chosen to keep this rule as written, accepting its consequence: a Team that nominates a Player nobody ever bids on has spent its Nomination Slot for the remainder of the auction. Realizes UJ-2, UJ-3.

**Functional Requirements:**

#### FR-7: Nominate a free agent

A Manager can nominate any Free Agent to the Bid Board when their Team's Nomination Slot is unused.

**Consequences (testable):**
- The nominated Player appears on the Bid Board in **Awaiting Opening Bid** state with no Auction Clock running.
- The Team's Nomination Slot is marked used and shows which Player holds it.
- Nomination does not commit any of the nominating Team's cap space and does not make them Leading Bidder.
- A Team may nominate a Player it could not afford to bid on.
- The League Clock resets to 48 hours.
- The Nomination is written to the Audit Log and broadcast per §4.7.

#### FR-8: Nomination eligibility enforcement

The system refuses Nominations that violate league rules.

**Consequences (testable):**
- A Nomination is refused when the Team's Nomination Slot is in use, naming the Player currently holding it.
- A Nomination is refused when the Player is already on the Bid Board, already won in this auction, or under Contract to any Team.
- A Nomination is refused when the League is not in Auction Phase.
- Two Managers nominating the same Player concurrently result in exactly one Nomination; the loser is told the Player is already on the board.

#### FR-9: Nomination Slot release

A Team's Nomination Slot is released at the Auction Close of the Player it nominated.

**Consequences (testable):**
- The Slot is released regardless of which Team won the Player, and regardless of whether the nominating Team ever bid.
- The Slot is released at Auction Close and not before — not when the nominating Team is outbid, and not on any timer of its own.
- The Team's Managers are notified that they may nominate again.
- A Player in **Awaiting Opening Bid** never closes, so its Nominator's Slot remains held until the Auction Phase ends. `[ASSUMPTION: this is the accepted consequence of the rules as written, confirmed by the league; the app surfaces it prominently rather than mitigating it — see FR-10.]`

#### FR-10: Dead nomination visibility

The system makes an unbid Nomination visible to its owner and to the league.

**Consequences (testable):**
- A Player in **Awaiting Opening Bid** for more than 24 hours is visually flagged on the Bid Board as having attracted no bids.
- The nominating Team's own view states plainly that this Nomination is holding their Slot and will continue to until someone bids.
- The nominating Team's Managers are notified at the 24-hour mark.
- No automatic expiry, withdrawal, or return-to-pool occurs; only a Commissioner override (FR-31) can clear it.

### 4.4 Bidding and Cap Enforcement

**Description:** The heart of the app. A Team may bid on anything on the board up to its Maximum Bid, which the app computes continuously from cap space, money already committed to auctions it is leading, and the money it must hold back to fill its roster to twelve at the minimum salary. The number is always on screen — a manager should never have to derive it. Invalid bids are refused at submission with the arithmetic shown, never silently accepted and reversed later. Realizes UJ-1, UJ-3.

**Functional Requirements:**

#### FR-11: Place a bid

A Manager can bid on any Auction on the Bid Board that their Team is not currently leading.

**Consequences (testable):**
- In Standard Contention, a Bid is valid only if it is at least `current high Bid + $500,000`.
- Every Bid must be a whole multiple of **$500,000**. Since that equals the Minimum Increment, the two rules coincide: no off-grid Bid can be valid, and no grid-valid Bid above the current high can be sub-increment. An implementer should still write both checks — the granularity check is what catches an off-grid amount in **Minimum-Bid Contention**, where the increment rule does not apply.
- A Bid at or below the current high Bid is refused.
- A Team already holding the leading Bid on an Auction cannot bid against itself; the control is disabled and a direct submission is refused.
- On a valid Bid the Team becomes Leading Bidder, the previous Leading Bidder's Committed Bids are released immediately, and the previous Leading Bidder is notified per §4.7.
- The League Clock resets to 48 hours.
- The Bid is written to the Audit Log with Team, Manager, amount, and timestamp.

#### FR-12: Compute and display Maximum Bid

The system continuously computes each Team's Maximum Bid **for each open Auction** and displays it wherever bidding occurs.

**Consequences (testable):**
- For a Player who is not Minor League Eligible: `Maximum Bid = Available Cap Space − Roster Reserve`, where `Available Cap Space = Cap Space − Committed Bids` and `Roster Reserve = $1,000,000 × max(0, 12 − (Roster Count + Projected Active/Bench Additions))`.
- For a Minor League Eligible Player the Team's Free Minor League Slots can absorb (`N + 1 ≤ M` counting the prospective bid): Maximum Bid is unbounded, and the auction page says so rather than displaying a number.
- For a Minor League Eligible Player whose addition would push the Team into Overflow: the ordinary formula applies, computed with the resulting Minors Exposure.
- Worked: a Team with $12,000,000 Cap Space, Roster Count 9, no leading Bids, bidding on a non-eligible Player. Projected Active/Bench Additions = 1, so Roster Reserve = $1,000,000 × (12 − 10) = $2,000,000 and Maximum Bid = $10,000,000.
- Worked: the same Team, now leading on two other non-eligible Auctions at $3,000,000 and $2,000,000. Available Cap Space $7,000,000; Projected Active/Bench Additions = 3; Roster Reserve $0; Maximum Bid $7,000,000.
- Maximum Bid recomputes for all affected Teams and Auctions within one second of any Bid, Auction Close, or Commissioner override.
- The figure is shown with its components broken out — Cap Space, Committed Bids, Minors Exposure, Roster Reserve — not as a bare number.
- A Team whose Maximum Bid on a given Auction is below the minimum legal Bid for that Auction sees its bidding controls disabled there, with the reason stated.
- Maximum Bid is a **money** figure only. A Bid must additionally pass Roster Capacity (FR-37), which an unbounded Maximum Bid does not exempt it from; where capacity is the binding constraint the Auction says so rather than showing a money figure the Team cannot in fact use.

#### FR-13: Reject over-cap bids

The system refuses any Bid exceeding the bidding Team's Maximum Bid.

**Consequences (testable):**
- A Bid exceeding Maximum Bid is refused before it enters the Auction; it never appears on the Bid Board or in the Audit Log as a valid Bid.
- No cap-based refusal occurs on an Auction where Maximum Bid is unbounded under FR-35; only the Roster Reserve check and the ordinary increment rules apply there.
- The refusal message shows the full arithmetic: Cap Space, Committed Bids, Minors Exposure, Roster Reserve, and the resulting Maximum Bid.
- Validation is performed server-side against committed state at the moment of submission, not against state the client held when the page rendered.
- A Bid valid when composed but invalid by the time it lands (because another Auction the Team leads was outbid-then-reclaimed, or the price moved) is refused with the current figures shown.

#### FR-14: Commit and release capital

The system holds a Team's leading money against its cap for the life of the Auction.

**Consequences (testable):**
- A Team's Committed Bids include its leading amount on every open Standard Contention Auction for a Player who is not Minor League Eligible.
- A Team's Committed Bids include $1,000,000 for every open Minimum-Bid Contention on a Player who is **not** Minor League Eligible in which it is a Contender, because any Contender may win.
- A Minimum-Bid Contention on a Minor League Eligible Player instead contributes an **Eligible Leading Bid of $1,000,000**, which reaches Committed Bids only through Minors Exposure — and therefore commits nothing while the Team has a Free Minor League Slot to absorb the win. A won Contender is placed in a Minor League Slot at a $0 Cap Hit like any other eligible win, so holding $1,000,000 against the cap for him would over-commit. See FR-35.
- Committed capital is released the instant the Team ceases to be Leading Bidder, or the instant a Minimum-Bid Contention it lost is drawn.
- On Auction Close the winning Team's committed amount converts to an Auction Contract Cap Hit and its Roster Count increases by one.

#### FR-15: No bid retraction

A Bid, once accepted, cannot be withdrawn by the Team that placed it.

**Consequences (testable):**
- No user-facing control to cancel, edit, or lower a Bid exists.
- Only a Commissioner override (FR-32) can void an accepted Bid, and doing so is recorded with a reason.

#### FR-35: Unbounded bidding on Minor League Eligible players, bounded by overflow

*(Numbered after FR-34 because it was added during finalize; it belongs to this feature.)*

A Team may bid without cap limit on a Minor League Eligible Player its Free Minor League Slots can absorb, and is constrained only by the surplus that would overflow into Active/Bench Slots.

**Consequences (testable):**
- A Minor League Slot placement yields a Cap Hit of $0 regardless of the winning amount. A Team may therefore bid any amount on a Minor League Eligible Player while it has a Free Minor League Slot to absorb the win, and the app neither refuses nor warns about the bid on cap grounds.
- A Team's Committed Bids include, for eligible Players, only its **Minors Exposure** — the sum of the Overflow Count largest Eligible Leading Bids. When `N ≤ M`, that sum is zero and eligible bids commit nothing.
- Minors Exposure recomputes on every bid, so a later cheap eligible bid can be refused because it pushes the Team into Overflow and exposes an earlier expensive one. The app refuses the **new** bid; it never retroactively invalidates an accepted Bid.
- Worked: a Team with one Free Minor League Slot leads an eligible Auction at $40,000,000. `N=1, M=1`, Overflow Count 0, Minors Exposure $0 — permitted regardless of the Team's Cap Space. It then attempts $1,000,000 on a second eligible Player: `N=2, M=1`, Overflow Count 1, Minors Exposure $40,000,000. The $1,000,000 bid is refused unless the Team can cover $40,000,000.
- A Minimum-Bid Contention on a Minor League Eligible Player contributes an Eligible Leading Bid of $1,000,000 and is governed by this rule, not by the flat $1,000,000 commitment in FR-14 — which applies only to contentions on Players who are not Minor League Eligible. A Contender who wins is placed in a Minor League Slot at a $0 Cap Hit like any other eligible win.
- Slot Placement is evaluated against the Team's slot occupancy at the moment of Auction Close, so two Auctions closing in sequence can place the first Player in minors and the second in Active/Bench. Minors Exposure is sized for that worst case.
- The refusal message for an Overflow-driven rejection names the specific earlier eligible Bid creating the exposure, so a Manager can see why a $1M bid was refused.
- This app does not model or enforce activation. Moving a stashed Player from a Minor League Slot to an Active/Bench Slot requires the Team to absorb the full contract amount against its cap, and that constraint is enforced in Fantrax during the season, not here. See §6.
- Roster Capacity (FR-37) applies to eligible Auctions too. An unbounded Maximum Bid is a statement about money, not about whether a Slot exists to receive the Player.

#### FR-37: Enforce Roster Capacity

*(Numbered after FR-36 because it was added when OQ-1 resolved; it belongs to this feature.)*

A Team has exactly 12 Active/Bench Slots — 8 active plus 4 bench — and the system refuses any Bid that would commit it to more players than it has Slots for.

**Consequences (testable):**
- A Bid is refused when `Roster Count + Projected Active/Bench Additions > 12`, computed as though the prospective Bid were already placed — the same post-bid basis Roster Reserve uses.
- This is a **second, independent refusal ground alongside Maximum Bid**. A Team can fail it with unlimited cap space and pass it with none; neither check subsumes the other, and both are evaluated on every Bid.
- A Team at Roster Count 12 cannot bid on any Player who is not Minor League Eligible, whatever its Cap Space. It **can** bid on a Minor League Eligible Player while a Free Minor League Slot would absorb him, because that win adds nothing to Active/Bench.
- A Bid on a Minor League Eligible Player that would create Overflow is refused when the overflow has nowhere to land — there is **no carve-out** for automatic Slot Placement. The refusal names the earlier eligible Auction creating the overflow, exactly as an exposure refusal does.
- The refusal message states the capacity arithmetic — Roster Count, Projected Active/Bench Additions, and the ceiling of 12 — and never reports a capacity refusal as a cap refusal.
- A Team that reaches Roster Count 12 has its bidding controls disabled on every non-eligible Auction with the reason stated on the board, not only on discovery at submission. This state is reachable directly from import, so it must be announced rather than found.
- Because the ceiling holds, `Roster Count + Projected Active/Bench Additions` can never exceed 12 in ordinary play and Roster Reserve's `max(0, …)` clamp becomes unreachable. Keep the clamp: a Commissioner override (FR-32) can still produce a Team above 12.
- Slot ceilings hold on import as well as on bid: FR-1 rejects a starting state with more than 12 Active/Bench, more than 2 Injury Reserve, or more than 3 Minor League players.

### 4.5 Auction Clock, Contention, and Closing

**Description:** Every open auction runs a 24-hour clock. In ordinary ascending bidding, each valid bid resets it. The one exception is the minimum-salary lottery: when a player is opened at exactly $1,000,000, the clock is fixed from that moment and does not reset, additional teams may join at exactly $1,000,000, and at expiry a random draw picks the winner among them. Any bid of $1,500,000 or more dissolves the lottery, resets the clock, and returns the auction to ordinary rules — regardless of how many teams had joined. Clocks run 24/7 with no overnight freeze and no anti-snipe extension, per league rules as written. Realizes UJ-1, UJ-2.

**Functional Requirements:**

#### FR-16: Standard Contention clock

In Standard Contention, the Auction Clock is set to 24 hours by each valid Bid.

**Consequences (testable):**
- An Auction enters Standard Contention when its Opening Bid exceeds $1,000,000, or when a Bid of $1,500,000 or more is placed into a Minimum-Bid Contention.
- Every subsequent valid Bid sets the Clock to exactly 24 hours from that Bid's timestamp.
- The Clock runs continuously; no pause, freeze window, or business-hours adjustment applies.
- The Clock's absolute close time is displayed alongside the countdown, in the viewer's local timezone.

#### FR-17: Enter Minimum-Bid Contention

An Auction whose Opening Bid is exactly $1,000,000 enters Minimum-Bid Contention.

**Consequences (testable):**
- The Auction Clock is set to 24 hours from the Opening Bid and is thereafter fixed.
- The opening bidder is recorded as the first Contender.
- The Auction displays a state visually distinct from Standard Contention, showing the full Contender list, the lottery mechanic in plain language, and the fact that the clock will not reset.

#### FR-18: Join a Minimum-Bid Contention

A Manager can join an open Minimum-Bid Contention by bidding exactly $1,000,000.

**Consequences (testable):**
- The joining Team is added to the Contender list. For a Player who is not Minor League Eligible, $1,000,000 is added to its Committed Bids. For a Minor League Eligible Player, the $1,000,000 becomes an Eligible Leading Bid and commits capital only through Minors Exposure (FR-14, FR-35).
- The Auction Clock is **not** reset, extended, or otherwise altered.
- A Team already a Contender cannot join twice.
- A Bid strictly between $1,000,000 and $1,500,000 is refused as neither a valid lottery entry nor a valid ascending Bid.
- Joining resets the League Clock to 48 hours.

#### FR-19: Dissolve a Minimum-Bid Contention

A Bid of $1,500,000 or more into a Minimum-Bid Contention converts it to Standard Contention.

**Consequences (testable):**
- The Contender list is discarded and every Contender's $1,000,000 commitment is released immediately.
- The Auction Clock is reset to 24 hours from the converting Bid.
- The converting Team becomes Leading Bidder and all ordinary rules apply from that point, including the $500,000 Minimum Increment.
- Conversion occurs regardless of Contender count — one Contender or twenty, the result is identical.
- A Team that was a Contender may itself be the converting bidder.
- Every former Contender is notified that the lottery dissolved and the auction is now ascending.

#### FR-20: Draw a Minimum-Bid Contention winner

At Clock expiry in Minimum-Bid Contention, the system selects the winner by Randomizer.

**Consequences (testable):**
- The winner is drawn uniformly at random from the Contender list; every Contender has probability `1/n`.
- A single-Contender lottery resolves to that Contender without ambiguity.
- The draw records a seed, the ordered Contender list as it stood at expiry, and the resulting selection — all three permanently visible on the closed Auction and in the Audit Log.
- The recorded seed and Contender list are sufficient for any Manager to independently reproduce the result. `[ASSUMPTION: verifiable-fairness treated as a hard requirement rather than a nicety, on the grounds that an unauditable lottery is the single most trust-corrosive thing this app could ship.]`
- Losing Contenders' committed capital is released at the draw.

#### FR-21: Close an auction

At Auction Clock expiry, the system closes the Auction and awards the Player.

**Consequences (testable):**
- In Standard Contention the Leading Bidder wins at their bid amount; in Minimum-Bid Contention the drawn Contender wins at $1,000,000.
- The Player is removed from the Bid Board and from the Free Agent pool, and is recorded as an Auction Contract at the winning amount with contract length unset.
- Slot Placement is applied automatically: a Minor League Eligible Player takes a free Minor League Slot if one exists, otherwise an Active/Bench Slot; any other Player takes an Active/Bench Slot.
- The winning Team's Roster Count increases by one **only if** the Player was placed in an Active/Bench Slot.
- The Cap Hit recorded is the winning amount for an Active/Bench placement, and $0 for a Minor League placement. Any Minors Exposure the Team was carrying for this Auction is released and recomputed across its remaining eligible bids. See FR-35.
- The nominating Team's Nomination Slot is released (FR-9).
- Auction Close does **not** reset the League Clock.
- Close occurs within 60 seconds of the Clock's nominal expiry even if no user is looking at the page.
- Winner, price, and full bid history are written to the Audit Log and broadcast per §4.7.

#### FR-22: End the Auction Phase

The system ends the Auction Phase when the League Clock expires.

**Consequences (testable):**
- The League Clock **starts** at 48 hours when the auction opens (FR-3) and is **reset** to 48 hours by any Nomination or any valid Bid, and by nothing else.
- Starting and resetting are distinct: a Bid voided under FR-32 removes that Bid's reset, but nothing removes the start, so the Clock never recomputes to earlier than 48 hours after the auction opened.
- The League Clock is **derived from the surviving reset events**, not carried as a stored countdown. A Bid voided under FR-32 stops counting as a reset, and the Clock is recomputed without it — prospectively, per FR-32.
- On expiry, Nomination and bidding are disabled league-wide and the League transitions to Contract Assignment Phase.
- Any Auction still in **Awaiting Opening Bid** at expiry is terminated with no winner and its Player returns to the Free Agent pool unclaimed.
- All Managers are notified that the auction has ended and contract assignment has begun.

### 4.6 The Bid Board

**Description:** The screen the league lives on. It must be genuinely usable one-handed on a phone, because that is where most bids will be placed, and it must make the three things that matter — what's closing soon, where am I leading, what can I afford — legible without scrolling or arithmetic. Alongside it sits the Teams index (FR-39): the same question asked of the other twenty-nine teams, which is how a manager decides whether a player is worth chasing at all. Realizes UJ-1, UJ-2, UJ-3.

**On what is public.** Every figure in this feature is visible to every Manager. There is no partial-information layer and no fog of war: the auction is an open ascending market whose entire premise is that the arithmetic is checkable, and a figure that some managers can derive and others cannot is worse than one nobody can hide. This is stated once here and governs FR-23 – FR-25 and FR-39 alike.

**Functional Requirements:**

#### FR-23: View the Bid Board

Any Manager can view all open Auctions with live state.

**Consequences (testable):**
- Each Auction shows Player identity, current price, Leading Bidder team name, Auction state, and time remaining.
- Auctions are sortable by time remaining, price, and Player name, and filterable to those the viewer's Team is leading or contending in.
- The board updates without a manual refresh; a change is reflected within 5 seconds of the originating action.
- Countdown timers are accurate to the second and derived from a server-authoritative close time, not from client clock arithmetic against page load.
- The viewer's Maximum Bid is persistently visible on the board, not only on individual Auction pages.

#### FR-24: View an auction in detail

Any Manager can open a single Auction and see its complete history.

**Consequences (testable):**
- Full Bid history in chronological order with Team name, acting Manager name, amount, and timestamp — visible to all Managers, with no anonymity at any point.
- Minimum-Bid Contention Auctions show the live Contender list and state in words, not just iconography, that the clock does not reset.
- The bid control pre-fills the minimum legal Bid and offers quick-increment options; it never offers an amount exceeding the viewer's Maximum Bid for this Auction.
- Where Maximum Bid is unbounded under FR-35, the control says so in words and accepts a free-entry amount, rather than displaying a misleadingly large ceiling.
- The viewer's own bid affordances are disabled with a stated reason when their Team is already leading, their Maximum Bid is insufficient, or Roster Capacity is exhausted (FR-37) — and the three reasons are worded distinctly, since "you have no money" and "you have no roster slot" call for different responses.

#### FR-25: View team state

Any Manager can view any Team's roster, cap position, and auction activity.

**Consequences (testable):**
- Every Team's Cap Space, Committed Bids, Available Cap Space, Roster Count by slot kind, Free Active/Bench Slots, Free Minor League Slots, Minors Exposure, and Nomination Slot status are visible to **all** Managers, for every Team.
- The viewer's own Team view additionally shows Maximum Bid with components broken out and the list of Auctions they lead or contend in. **Maximum Bid remains the one figure shown for the viewer's Team only**, because it is per-Auction rather than per-Team (FR-12) and a team-level rendering of it would be a number that authorises nothing.
- Won Players appear on the Team's roster immediately at Auction Close, in their assigned Roster Slot, before contract length is assigned.
- Every one of the above figures must be reproducible by hand from figures already on the Bid Board, and none may be presented as privileged information.

*Amended 2026-08-18.* This requirement previously reserved Free Minor League Slots and Minors Exposure to the viewer's own Team. **That split was not enforceable and has been removed.** Both are derivable from figures FR-25 already published: Free Minor League Slots is `3 − minor-league occupancy`, and occupancy is part of "Roster Count by slot kind"; Minors Exposure is the difference between Committed Bids and the sum of a Team's non-eligible leading amounts, every one of which is public on the Bid Board under FR-23. Any manager willing to do the subtraction had both figures already, and FR-39's index would have handed all thirty of them to everyone at a glance. Concealment that survives only until someone bothers is worse than none, because it misleads the managers who trust it. See §12.

#### FR-39: View the Teams index

*(Numbered after FR-38 because it was added on 2026-08-18, when the commissioner identified the surface as missing; it belongs to this feature.)*

Any Manager can see all 30 Teams in one list, each with its remaining roster slots and cap position, ranked against a League Median.

**Consequences (testable):**

*Rows*
- The index lists all 30 Teams, never a subset and never paginated. The viewer's own Team is marked but is **not** pinned, reordered, or otherwise exempted from the sort — it sits wherever the figures put it, which is the point of the screen.
- Each row carries: Team name and Manager(s), **Free Active/Bench Slots** as `Roster Count of 12`, **Free Minor League Slots** as `occupied of 3`, **Cap Space**, **Committed Bids**, **Available Cap Space**, and **Nomination Slot** status (free, or the Player holding it).
- Injury Reserve occupancy is shown, and is visibly excluded from the twelve — this is the arithmetic managers most often get wrong by hand (§10 example 23).
- Every figure is one FR-25 publishes for every Team. The index introduces no new visibility, only new adjacency.

*The League Median line*
- One comparison line reports the **League Median** of Free Active/Bench Slots and of Available Cap Space, labelled *median*, never *average*.
- It is the lower of the two middle values across the 30 Teams, so it always sits on the $500,000 grid and renders losslessly at one decimal. §10 example 28 covers this.
- The median is stated as a fact and nothing more. **No Team is coloured, badged, ranked, or annotated by its position relative to it**, and no copy characterises a Team as ahead, behind, rich, poor, or under pressure. The app has no opinion about whether a manager should spend, and a comparison figure is the single most tempting place to acquire one — see §6 "not a valuation engine" and SM-C1.

*Sorting*
- Sortable by Available Cap Space, Free Active/Bench Slots, Cap Space, and Team name; the default sort is Team name, which is the ordering that expresses no editorial view.
- Sorting is a view state and never changes a figure.

*Phase behaviour*
- **Auction Phase** — as above.
- **Contract Assignment Phase** — Roster Count reads 12 for every Team by definition (FR-30 blocks the export otherwise), so slot columns lose their information value and are replaced by **remaining Year Allotment** (4-year, 3-year, and both 2-year deals shown as used or unused) and assignment completion. Cap columns remain and now reflect settled contracts rather than open exposure.
- **Archived** — the final frozen state of the Contract Assignment columns, read-only, consistent with FR-31.
- The index is not offered in Setup. The equivalent surface there is FR-1's per-Team import preview, which is a different screen with a different job: confirming an import rather than reading a market.

*Correctness and freshness*
- Every figure is computed from committed state on read and none is stored, exactly as FR-12 requires — the index is thirty renderings of figures the app already computes, never a second source for them.
- A Team's figures on the index and on its FR-25 detail view are produced by the same computation and cannot disagree.
- The index authorises no action: it contains no bid control and no nomination control. Under the freshness rules it therefore **carries the age of its figures rather than disabling anything**, since there is no control to disable.
- The index updates on the same terms as the Bid Board — within 5 seconds of the originating action, without a manual refresh.

*Presentation*
- At 375px the index is a single-column list of rows, not a horizontally scrolling table. Money and slot figures must be readable without lateral scrolling, because a table that requires it is a table nobody reads on the surface where most of this league lives.
- On desktop it becomes a genuine table, which is the shape 30 rows of comparable figures actually want.

### 4.7 Notifications

**Description:** A rolling 24-hour clock without notifications is a trap. Every alert goes to the league Discord channel, which doubles as a public, permanent record of the auction; a notice aimed at a particular manager carries an `@mention`, which is what turns that public record into a personal push alert on their phone. Discord is the only outbound channel — this system sends no email. That concentration is deliberate and cheap, but it makes a Discord outage total, so FR-4 carries a Commissioner sign-in that does not depend on it. Realizes UJ-1, UJ-3.

**Functional Requirements:**

#### FR-26: Broadcast auction events to Discord

The system posts league-wide auction events to a configured Discord channel.

**Consequences (testable):**
- Nominations, Bids, Auction Closes, Randomizer draws (including seed and Contender list), Auction Phase start, and Auction Phase end are each posted.
- Each post names the Team, the acting Manager, the Player, the amount, and the new close time where applicable.
- A Discord delivery failure never blocks or reverses the underlying auction action; failures are logged and surfaced to the Commissioner.
- Posts are emitted at most once per event even if delivery is retried.

#### FR-27: Notify managers by Discord mention

The system alerts Managers about events affecting their Team by `@mention` in the league Discord channel.

**Consequences (testable):**
- A Manager is mentioned when their Team is outbid, when an Auction their Team leads or contends in closes, when their Nomination Slot is released, when their unbid Nomination hits 24 hours (FR-10), and when the Contract Assignment Phase opens.
- Both Managers of a co-managed Team are mentioned on every Team-affecting event, individually — a single post naming only the Team does not satisfy this.
- Outbid mentions are posted within 60 seconds of the outbidding Bid.
- Each post links directly to the relevant Auction.
- A Manager can mute exactly three categories — Nomination Slot released, unbid-Nomination 24-hour warning, and closes for Auctions their Team did not lead or contend in. **Muting suppresses the `@mention`, not the post**: the event still appears in the channel, so the public record stays complete and only the personal ping is withheld. Outbid notices and Contract Assignment Phase notices cannot be muted. `[ASSUMPTION: outbid notices treated as non-optional because muting them undermines the fairness premise of a 24/7 clock.]`
- Every outbound post declares explicitly which mentions are permitted, so no message can mass-ping the league by accident.
- The channel used for these mentions is the same one carrying the FR-26 broadcast, so a Manager's alert and the public record are one artifact rather than two that can disagree.

### 4.8 Contract Assignment

**Description:** Once the auction ends, every team assigns contract lengths to the players it won, spending from a fixed annual allotment: one 4-year, one 3-year, two 2-year, and unlimited 1-year deals. This is where the dynasty decisions get made, and it is the last step before the results can leave the app. Realizes UJ-4.

**Functional Requirements:**

#### FR-28: Assign contract lengths

A Manager can assign a contract length to each Player their Team won, drawing from the Team's Year Allotment.

**Consequences (testable):**
- Available lengths are 1, 2, 3, and 4 years; 4-year and 3-year may each be used once, 2-year twice, 1-year without limit.
- The remaining allotment is displayed as the Manager assigns, and an assignment exceeding it is refused.
- Assignments may be changed freely until the Manager submits their Team as final.
- Unused allotment expires at the end of the phase and does not carry to a future offseason.
- Year Allotment applies only to Auction Contracts; Existing Contracts cannot be extended or altered here.
- The winning amount is the annual Cap Hit; the app records amount and length only and computes no future-year escalation.

#### FR-29: Track and enforce phase completion

The system tracks per-Team completion of contract assignment and enforces a deadline.

**Consequences (testable):**
- Commissioner sees a live roster of which Teams have submitted and which have not.
- Managers with unassigned Players are reminded by Discord mention at a Commissioner-configured interval before the deadline.
- **The deadline does not resolve anything by itself.** No contract length is ever assigned by default. At the deadline the affected Teams and the Commissioner are notified, unassigned Players stay unassigned, and **the export stays blocked until every Auction Contract has a length** (FR-30).
- A Team that will not or cannot respond is resolved by the Commissioner assigning lengths on its behalf under FR-32, with a reason recorded like any other override. This is the only path past an unresponsive Team, and it is deliberately a visible act rather than a silent default.
- The Commissioner can extend the deadline, and the extension is logged.

### 4.9 Export to Fantrax

**Description:** The final deliverable: a file the Commissioner uploads through Fantrax commissioner controls to write the auction results into the league of record. Because Fantrax offers no supported write API, this is deliberately a human-in-the-loop handoff — the Commissioner reviews on screen before anything leaves the app. Realizes UJ-4.

**Functional Requirements:**

#### FR-30: Review and export results

Commissioner can review the complete auction outcome and download it in Fantrax's expected import format.

**Consequences (testable):**
- The review screen lists every Auction Contract with Team, Player, Fantrax player ID, winning amount, contract length, and Slot Placement, plus each Team's resulting total salary and Cap Space.
- Export is blocked, with the offending Teams named, if any Team's post-auction salary exceeds $165,000,000, any Team's Roster Count is other than exactly 12 (below it leaves a hole; above it breaches FR-37's ceiling), or **any Auction Contract still lacks a contract length** (FR-29).
- Free Agents not won require no export treatment. They simply remain free agents in Fantrax, and the export omits them entirely.
- The exported file carries the stable Fantrax player IDs from the FR-2 import so rows match on upload without name-based reconciliation.
- Export can be re-downloaded any number of times and is recorded in the Audit Log each time.
- Exporting does not itself write to Fantrax; the app states plainly that upload is a manual Commissioner step.

#### FR-36: Export full post-auction rosters

*(Numbered after FR-35 because it was added during finalize; it belongs to this feature.)*

Commissioner can additionally export each Team's complete post-auction roster, not only the contracts created by this auction.

**Consequences (testable):**
- The roster export lists every Player on every Team — Existing Contracts and Auction Contracts alike — with Fantrax team ID, Fantrax player ID, Cap Hit, contract length, and Roster Slot.
- Existing Contracts are reproduced exactly as imported in FR-1, unless altered by a Commissioner override, in which case the current value is exported and the override is traceable in the Audit Log.
- The roster export and the contract export (FR-30) are separate downloads, because Fantrax's commissioner import may accept them through different paths.
- Both exports reconcile: every Auction Contract in the FR-30 export appears in the roster export at the same amount and slot.

#### FR-31: Archive the auction

Commissioner can mark the auction archived once results are in Fantrax.

**Consequences (testable):**
- An archived auction is read-only: no Bids, Nominations, assignments, or overrides are accepted.
- The full Bid Board, Audit Log, and export remain viewable by all Managers indefinitely.

### 4.10 Commissioner Controls and Audit

**Description:** Rules engines meet reality. A manager gets locked out at a critical moment; an import turns out to have a wrong salary; a bid is placed by the wrong co-manager. The Commissioner needs to be able to fix things — and every fix needs to be visible to the whole league, because an unlogged override in a money auction is how a five-year league ends. Realizes UJ-3, UJ-4.

**Functional Requirements:**

#### FR-32: Commissioner overrides

Commissioner can void a Bid, adjust a Team's Cap Space, terminate an Auction, release a Nomination Slot, extend or expire any Clock, and assign a contract length on a Team's behalf.

**Consequences (testable):**
- Every override requires a free-text reason before it commits.
- Voiding a Bid restores the Auction to its state before that Bid, including the prior Leading Bidder and the prior Auction Clock value.
- **Voiding a Bid also removes that Bid's League Clock reset.** The League Clock is recomputed from the remaining reset events (FR-22) as though the voided Bid had never landed, which can shorten the Auction Phase.
- Where that recomputation lands the League Clock in the past, the Auction Phase ends at the **next** clock evaluation and takes effect **prospectively only**: Nominations and Bids accepted between the recomputed expiry and the void stand, and nothing is retroactively invalidated. A void produces a *sooner* phase end, never a rewritten history.
- Overrides are permitted during the Auction Phase and Contract Assignment Phase, and refused once archived.
- Every override is written to the Audit Log with actor, timestamp, before-state, after-state, and reason.

#### FR-33: League-visible audit log

Any Manager can read the complete Audit Log.

**Consequences (testable):**
- The Log is append-only; no entry can be edited or deleted by any role, Commissioner included.
- Entries cover every Nomination, Bid, Auction Close, Randomizer draw with seed, Commissioner override, import, and export.
- The Log is filterable by Team, Player, and event type, and is exportable.

#### FR-34: Pause the auction

Commissioner can pause and resume the entire auction.

**Consequences (testable):**
- While paused, all Auction Clocks and the League Clock stop advancing, and Nominations and Bids are refused with the pause stated as the reason.
- On resume, every Clock continues with exactly the remaining time it held at pause.
- Pause and resume are announced to all Managers and posted to Discord.
- `[ASSUMPTION: pause included as the escape hatch for outages and disputes even though the league runs clocks 24/7 by rule. It is an administrative tool, not a scheduled freeze.]`

## 5. Cross-Cutting NFRs

- **Rule correctness is the product.** Every bid-validity, clock, and cap computation must be deterministic and covered by automated tests, with the §10 worked examples as executable cases. A rules bug is a worse failure than an outage.
- **Concurrency safety.** State mutation must be serialized **globally**, not merely per Auction. Two Bids arriving within the same instant must produce one winner and one clear rejection — never two accepted Bids, a lost Bid, or a Committed Bids figure that double-counts. Per-Auction serialization is insufficient and was corrected here: Maximum Bid depends on the bidding Team's leading positions in *other* Auctions (Committed Bids, and Minors Exposure under FR-35), so two Managers of one co-managed Team bidding simultaneously on two *different* Auctions each pass their own per-Auction check and jointly breach the cap. No Auction is raced — the Team is. At this scale global serialization costs nothing measurable.
- **Server-authoritative time.** All clock arithmetic derives from server time. A client with a skewed clock must not see a different close time or be able to bid after expiry.
- **Timer reliability.** Auction Close must fire within 60 seconds of nominal expiry with no user present, and must survive process restarts — a missed close during a deploy silently extends an auction.
- **Availability — a posture, not a number.** The app should be reachable 24/7 through the Auction Phase, but this runs on stacked free tiers with no SLA between them and with Discord on the sign-in path, so no uptime percentage is committed to. *(The previous "no more than 1 hour of unplanned unavailability" implied 99.8% across ~504 hours, which nothing in the stack can underwrite. Restated 2026-08-17 per OQ-8.)* What is required instead is that an outage be **survivable rather than decisive**: a stalled close sweep produces late closes and never wrong ones, the Commissioner can pause every clock, and the auction is restorable from outside Supabase. Any outage beyond 15 minutes is a Commissioner pause (FR-34) plus a compensating clock adjustment — not a wait-and-see. **That recovery procedure must be written down before the auction opens, not improvised during one**; it is scheduled work inside the build epics, and auction open is blocked on it.
- **Mobile-first responsive.** Bidding, nominating, and reading the board must work one-handed on a phone at 375px width. Desktop gets density; mobile gets nothing removed.
- **Performance.** Board and auction views interactive within 2 seconds on mobile data; a Bid submission acknowledged within 1 second.
- **Auditability over convenience.** Where a design choice trades away a record for a simpler flow, keep the record.
- **Scale is not a concern.** 31 users, ~30 concurrent auctions, a few thousand events across three weeks. Do not design for load; design for correctness.
- **Accessibility.** WCAG 2.1 AA contrast ratios (4.5:1 for text, 3:1 for UI components) and touch targets of at least 44×44px on every bidding and nomination control. Auction state must never be conveyed by color alone — a closing-soon auction and a lottery auction need labels, not just hues.
- **Measurability.** Every Bid, Nomination, Auction Close, and notification dispatch must be recorded with enough context to compute the §8 metrics without retrofitting instrumentation — including, for Bids, the device class the bid was placed from (SM-4) and, for notifications, dispatch and delivery outcome (SM-3). Because the auction record is append-only, these fields must be captured from the first event onward; they cannot be backfilled later.

## 6. Non-Goals (Explicit)

- **Not a Fantrax replacement.** Scoring, lineups, trades, waivers, and in-season roster management stay in Fantrax. This app is live for one offseason phase per year.
- **Not enforcing activation.** Promoting a stashed player out of a Minor League Slot requires the team to absorb his full contract against the cap. That rule is what makes FR-35's unbounded bidding self-correcting, and it is enforced by Fantrax in-season. This app never models it, never warns about it, and never blocks a bid on account of it.
- **Not multi-tenant.** One league, hard-wired rules. No league creation, no rule configuration UI, no other sports.
- **Not writing to Fantrax.** v1 never mutates Fantrax state; the Commissioner uploads the export by hand.
- **Not a draft tool.** No rookie draft, no draft pick trading, no draft board.
- **Not a trade machine.** No trades during the auction; committed capital and won players cannot be exchanged.
- **Not a valuation engine.** No projections, rankings, ADP, or "suggested bid." The app enforces rules; it does not advise.
- **Not a chat app.** Discussion stays in Discord. The app posts to Discord; it does not host conversation.
- **No public/spectator access.** Authentication required for everything.

## 7. MVP Scope

### 7.1 In Scope

- CSV import of rosters, existing contracts, and the free agent pool, with hard validation, plus commissioner-set minor-league eligibility (FR-1 – FR-3, FR-38).
- Discord OAuth for 31 pre-registered Managers, co-management, and the Commissioner role (FR-4 – FR-6).
- Full nomination lifecycle including slot gating and dead-nomination visibility (FR-7 – FR-10).
- Bidding with continuous Maximum Bid computation, server-side rejection of illegal bids, conservative commitment on Minor League Eligible players, and Roster Capacity enforcement (FR-11 – FR-15, FR-35, FR-37).
- Complete clock engine: 24h standard clock, the $1M lottery with dissolution, auditable randomizer, auction close, and the 48h league end (FR-16 – FR-22).
- Mobile-first Bid Board, auction detail, per-Team views, and the 30-Team index with its League Median (FR-23 – FR-25, FR-39).
- Discord broadcast and per-Manager Discord mentions (FR-26, FR-27).
- Contract assignment against Year Allotment with completion tracking (FR-28, FR-29).
- Reviewed CSV export of contracts and full rosters, plus archive (FR-30, FR-31, FR-36).
- Commissioner overrides, pause, and league-visible append-only audit log (FR-32 – FR-34).

### 7.2 Out of Scope for MVP

- **Fantrax API sync** — deferred to v2. No supported write path exists and the read surface omits salaries; the CSV round-trip is the reliable path. Revisit if Fantrax grants documented API access.
- **Web push / PWA notifications** — deferred to v2, and largely answered by FR-27's move to Discord mentions: Discord's own push already delivers the instant, phone-native alert that web push would have provided, on an app managers already have installed. iOS PWA push remains disproportionate work for v1. `[NOTE FOR PM: revisit only if managers report they miss mentions in a busy channel — the failure mode to watch is notification fatigue, not latency.]`
- **Proxy / max auto-bidding** — explicitly rejected, not merely deferred. It changes auction dynamics and interacts badly with the lottery rule.
- **Overnight clock freeze and anti-snipe extension** — rejected for v1 as rules changes requiring league buy-in. `[NOTE FOR PM: if the first auction produces genuine 3am-sniping resentment, this is the change to propose to the league — and FR-34's pause machinery already provides most of the mechanism.]`
- **Future-year cap projection** — the app records amount and length only; multi-year cap accounting lives in Fantrax.
- **Existing-contract extensions or restructures** — Year Allotment applies to auction winners only.
- **Historical archive across offseasons** — v1 covers one auction. Prior years are not imported.
- **Rules configurability** — every constant ($165M cap, $1M minimum, $500k increment *and* granularity, 24h, 48h, 12 Active/Bench Slots, 2 IR, 3 minors, allotment counts) may be a named configuration value in code, but no admin UI edits them. This is the implementation half of the "not multi-tenant" non-goal in §6.

## 8. Success Metrics

**Primary**
- **SM-1: Zero disputed outcomes.** No auction result is contested on grounds that the app computed a cap figure, clock, increment, or lottery draw incorrectly. Validates FR-11 – FR-22.
- **SM-2: The commissioner plays their own league.** Commissioner time spent adjudicating the auction drops from hours to effectively zero — measured by Commissioner override count, targeting fewer than 5 overrides across the whole auction, none of them correcting an app error. Validates FR-1 – FR-3, FR-30, FR-32.
- **SM-3: Nobody loses a player to inattention they weren't warned about.** Every outbid manager received a notification before the auction closed against them. Target: 100%. Validates FR-26, FR-27.

**Secondary**
- **SM-4: Mobile is the primary surface.** A majority of bids are placed from a phone — evidence the one-handed flow actually works. Validates FR-23, FR-24.
- **SM-5: The auction completes without manual intervention.** Auction Phase ends by League Clock expiry, contract assignment completes, and export succeeds first-try with no cap or roster violations. Validates FR-22, FR-28 – FR-30.
- **SM-6: Managers use the audit trail.** The Audit Log and randomizer seeds get looked at at least once by someone other than the Commissioner — evidence that verifiable fairness is real rather than decorative. Validates FR-20, FR-33.

**Counter-metrics (do not optimize)**
- **SM-C1: Total bid volume.** More bidding is not better. A UI that nudges managers toward bidding — countdown urgency, one-tap raises without confirmation, suggested amounts — would raise this while degrading the auction. Counterbalances SM-4.
- **SM-C2: Auction duration.** Do not optimize for a faster auction. The 24h and 48h clocks exist to give people time to think; shortening the effective auction would look like efficiency and feel like pressure. Counterbalances SM-5.
- **SM-C3: Commissioner override count driven to zero by removing the tool.** SM-2 targets few overrides because few are *needed* — not because the escape hatch was made hard to reach. Counterbalances SM-2.

## 9. Risks and Mitigations

- **A rules bug decides a player.** The one failure the league won't forgive. *Mitigation:* §10 worked examples as an executable test suite; server-side validation with no client-trusted path; append-only audit log making any error reconstructible and correctable via FR-32.
- **Timer misses fire during a deploy or restart.** Silently extends an auction and changes who wins. *Mitigation:* durable scheduled closes reconciled on startup; the 60-second close SLA in §5 tested against a forced restart.
- **Fantrax export format changes between offseasons.** Breaks import at the worst moment — setup day. *Mitigation:* validate and report on import rather than assuming shape; keep column mapping in one place (see `addendum.md`); import is re-runnable pre-open.
- **The minor-league-eligibility flag isn't in the Fantrax export — confirmed, no longer a risk but a design input.** FR-38 makes it commissioner-set. *The residual risk is different and sharper:* the flag now depends on one person marking players correctly by hand, and FR-35 gives it real economic weight — a player wrongly marked eligible lets a capped-out team win him at any price. *Mitigation:* default is *not* eligible so omission fails safe rather than permissive; FR-3 surfaces the flagged count for explicit confirmation before open; every change is logged, and post-open changes require an override with a reason.
- **A team arrives from import with a full roster and cannot bid at all.** Under FR-37 a Team at Roster Count 12 is locked out of every non-eligible auction for the whole auction, no matter how much cap space it has. This is correct, and it will feel broken the first time. *Mitigation:* FR-37 requires the reason to be shown on the board rather than discovered at submission; FR-1's per-Team preview shows Roster Count before the auction opens, so the condition is visible on setup day.
- **Minor League stashing looks like a bug to anyone who did not read FR-35.** A team $2M under the cap winning a $30M player is correct behavior here, not a defect — the contract is $0 while stashed and the cap is applied at activation, in Fantrax. The risk is that an implementer, a reviewer, or a manager reads it as broken and "fixes" it. *Mitigation:* stated in the §0 status callout, specified in FR-35, and worked through in §10 examples 18–20; the auction page shows "no cap limit" explicitly rather than a suspicious-looking large number.
- **Overflow exposure is the non-obvious half of that rule.** A team leading on more eligible players than it has free Minor League Slots is exposed on the surplus at full price, and which players overflow depends on close order. *Mitigation:* FR-35 sizes Minors Exposure to the worst case (the largest surplus bids), refuses the newest bid rather than retroactively voiding an accepted one, and names the auction causing the exposure in the refusal.
- **A dead nomination locks a manager out for the whole auction.** Accepted by league decision, but it will feel bad the first time it happens. *Mitigation:* FR-10 makes it loud and early rather than a discovery; FR-32 lets the Commissioner release the slot if the league decides to.
- **Discord is a single point of failure for both sign-in and alerting.** Since FR-4 authenticates through Discord and FR-27 notifies through it, a Discord outage locks every Manager out *and* silences every alert at the same moment, while the Auction Clocks keep running. This is the cost of the zero-budget, single-channel design and it is accepted knowingly. *Mitigation:* sessions persist 30 days so an outage does not log anyone out; FR-4 provides a Commissioner sign-in independent of Discord so FR-34's pause stays reachable; delivery is decoupled from auction state so a failed post never reverses a Bid; and the operator's own liveness alerting must not route through Discord, since it may need to report that Discord is down. An outage beyond the recovery threshold is a pause, not a wait-and-see.
- **Every Manager must have a Discord account.** FR-4 makes this load-bearing for *access*, not merely for convenience. *Mitigation:* confirm all 31 before setup day, not on it.
- **Solo-builder bus factor.** One person builds and operates this, live, for 31 people. *Mitigation:* Commissioner pause (FR-34) as the universal escape hatch; keep the deployment boring.

## 10. Rule Resolution Examples

*These exist to remove interpretation from the implementer. Each should become an automated test.*

1. **Ordinary raise.** Player at $8,000,000 held by Team A. Team B bids $8,500,000 — valid (exactly +$500k). Clock resets to 24h. A's $8,000,000 commitment releases; B's $8,500,000 commits.
2. **Insufficient increment, and off-grid.** Same auction. Team B bids $8,400,000 — refused on **both** grounds: it is below `current high + $500,000` and it is not a whole multiple of $500,000. Board and clock unchanged. Note that under $500,000 granularity these two grounds cannot be separated in Standard Contention — the next grid value above $8,000,000 is $8,500,000, which is exactly one increment — so no test can exercise a sub-increment bid that is on-grid. The granularity check earns its keep in Minimum-Bid Contention instead (example 10).
3. **Roster reserve bites.** Team C: Cap Space $12,000,000, Roster Count 9, no leading bids. Maximum Bid = $12,000,000 − ($1,000,000 × (12 − 10)) = $10,000,000. A $10,500,000 bid is refused with the arithmetic shown.
4. **Reserve clears as commitments accumulate.** Same Team C, now leading two auctions at $3,000,000 and $2,000,000. Available Cap Space $7,000,000; reserve = $1,000,000 × max(0, 12 − (9 + 2 + 1)) = $0. Maximum Bid $7,000,000.
5. **Outbid frees capital immediately.** Team C is outbid on the $3,000,000 auction. Available Cap Space returns to $10,000,000; Projected Active/Bench Additions drops to 2, so reserve becomes $1,000,000 × max(0, 12 − 11) = $1,000,000; Maximum Bid $9,000,000.
6. **Lottery opens.** Player nominated by Team D, opened by Team E at exactly $1,000,000 at 09:00 Monday. State = Minimum-Bid Contention, close fixed at 09:00 Tuesday. E commits $1,000,000.
7. **Lottery grows, clock unmoved.** Teams F, G, H each bid exactly $1,000,000 at 14:00, 20:00, and 08:55 Tuesday. All join; each commits $1,000,000; close time remains 09:00 Tuesday.
8. **Lottery draws.** At 09:00 Tuesday the Randomizer draws from [E, F, G, H]. Seed, ordered list, and selection are recorded and displayed. Winner holds a $1,000,000 Auction Contract; the other three release their commitments. Team D's Nomination Slot releases.
9. **Lottery dissolves.** Same auction, but Team I bids $1,500,000 at 20:30 Monday. Contenders E, F, G release immediately; I becomes Leading Bidder; state = Standard Contention; close resets to 20:30 Tuesday. The next valid bid is $2,000,000.
10. **The dead zone.** In a Minimum-Bid Contention, a bid of $1,200,000 is refused — too high to join the lottery, too low to convert it, and off-grid besides. Under $500,000 granularity the dead zone contains **no** legal amount at all: between $1,000,000 (join) and $1,500,000 (convert) there is no whole multiple of $500,000. The zone is therefore reachable only by an off-grid submission, which is exactly the case the granularity check exists to catch.
11. **Single-contender lottery.** Only Team E ever bids $1,000,000. At expiry, E wins outright; the draw is recorded with a one-team list.
12. **Nomination slot held by an unbid player.** Team J nominates a player at 10:00 Monday. Nobody bids. At 10:00 Tuesday the board flags it and J is notified. J still cannot nominate again. The player remains until the Auction Phase ends, then returns to the pool unclaimed.
13. **League clock.** Last bid league-wide lands 12:00 Friday; last nomination 09:00 Friday. An auction closes 12:00 Saturday — this does *not* reset the League Clock. With no further nomination or bid, the Auction Phase ends 12:00 Sunday.
14. **Allotment exhaustion.** Team K won five players and has already used its 4-year, 3-year, and both 2-year deals. Every remaining player must be assigned 1 year; longer options are unavailable.
15. **Co-manager race.** Both of Team L's Managers submit a bid on the same auction within the same second. Exactly one is accepted; the other is refused because the price moved, and the Audit Log names which Manager placed the accepted bid.
16. **Minors placement.** Team M holds two players in Minor League Slots and wins a Minor League Eligible player at $4,000,000. He takes the third Minor League Slot. Cap Hit is $0, and Team M's Roster Count is unchanged — it still owes the same number of Active/Bench holes.
17. **Minors overflow.** Same Team M immediately wins a second Minor League Eligible player at $3,000,000. All three Minor League Slots are now occupied, so he takes an Active/Bench Slot at a $3,000,000 Cap Hit and Roster Count increases by one.
18. **Stashing beats the cap, on purpose.** Team P is $2,000,000 under the cap, occupies two of its three Minor League Slots, and has Roster Count 11 — so `M = 3 − 2 = 1` and one Active/Bench Slot stands empty. It bids $30,000,000 on a Minor League Eligible player. `N+1 = 1 ≤ M = 1`, so Minors Exposure is $0. Projected Active/Bench Additions is 0 (the win goes to minors), so Roster Reserve is `$1,000,000 × max(0, 12 − 11) = $1,000,000`, which its $2,000,000 covers. Roster Capacity passes at `11 + 0 = 11 ≤ 12`. The bid is **permitted** — the auction page shows "no cap limit" rather than a figure. On close he is stashed at a $0 Cap Hit and Roster Count stays 11. Team P can never activate him without finding $30,000,000, but that constraint lives in Fantrax, not here.
19. **Overflow refuses the cheap bid, not the expensive one.** Team P, still holding that $30,000,000 leading bid, bids $1,000,000 on a second eligible player. That makes `N = 2` against `M = 1`, Overflow Count 1, and Minors Exposure $30,000,000 — the largest surplus bid, which Team P cannot cover. The **$1,000,000 bid is refused**, and the message names the $30,000,000 auction as the cause. The earlier bid stands untouched. Roster Capacity is *not* the reason: at `11 + 1 = 12 ≤ 12` it passes, which isolates Minors Exposure as the sole ground. Compare example 25, where capacity is the ground and money is not.
20. **A resolved win stops being exposure.** The $30,000,000 auction closes and the player takes Team P's last Free Minor League Slot at a $0 Cap Hit; Roster Count is still 11. He is no longer an Eligible Leading Bid, so he no longer contributes exposure at all. Team P re-bids $1,000,000 on the second eligible player: now `N = 1` against `M = 0`, Overflow Count 1, and Minors Exposure is $1,000,000 — the bid's own amount, which Team P's $2,000,000 of room covers. Projected Active/Bench Additions is 1, so Roster Reserve is `$1,000,000 × max(0, 12 − 12) = $0` and Maximum Bid is $1,000,000; capacity passes at `11 + 1 = 12`. The bid is **permitted**. The lesson is that an *open* leading bid creates exposure at full price while a *closed* one creates none, because it has already become a $0 Cap Hit in a slot.
21. **A lottery on an eligible player commits nothing.** Team Q is capped out with $0 of Available Cap Space but has all three Minor League Slots free and no other eligible leading bids. A Minor League Eligible fringe player is opened at exactly $1,000,000; Team Q joins the contention. That $1,000,000 is an Eligible Leading Bid, so `N = 1` against `M = 3`, Overflow Count 0, Minors Exposure $0 — the join is **permitted despite Team Q having no cap space at all**. Had the same lottery been on a player who is *not* Minor League Eligible, the flat $1,000,000 of FR-14 would apply and Team Q could not join.
22. **A lottery that overflows does commit.** Same Team Q, now already leading three eligible auctions at $5,000,000, $4,000,000 and $3,000,000 against its three free slots. It tries to join a $1,000,000 contention on a fourth eligible player: `N = 4` against `M = 3`, Overflow Count 1, Minors Exposure $5,000,000 — the largest of the four. With $0 Available Cap Space the join is **refused**, and the message names the $5,000,000 auction.
23. **IR does not fill the twelve.** Team N holds 11 players in Active/Bench Slots and 1 in an Injury Reserve Slot. Roster Count is 11, not 12, so with no leading bids its Projected Active/Bench Additions on a new non-eligible bid is 1 and Roster Reserve is $1,000,000 × max(0, 12 − 12) = $0 — the bid itself fills the last hole. Adding a second IR player would not change that figure.
24. **A full roster ends non-eligible bidding, money or not.** Team R holds 12 players in Active/Bench Slots, has $40,000,000 of Cap Space, and leads nothing. It bids $5,000,000 on a player who is not Minor League Eligible. Projected Active/Bench Additions is 1, so Roster Capacity is `12 + 1 = 13 > 12` and the bid is **refused** — with the capacity arithmetic, not a cap figure, since Maximum Bid here is a healthy $40,000,000. Team R's controls are disabled on every non-eligible auction on the board with the reason shown, not only at submission. This state is reachable straight from import.
25. **The same full roster can still stash, until it overflows.** Team R, still at Roster Count 12, has all three Minor League Slots free. It bids $9,000,000 on a Minor League Eligible player: `N+1 = 1 ≤ M = 3`, Overflow Count 0, Projected Active/Bench Additions 0, capacity `12 + 0 = 12 ≤ 12` — **permitted**, and Maximum Bid is unbounded. It goes on to lead all three eligible auctions within its three slots, all permitted. It then bids on a fourth eligible player: `N = 4` against `M = 3`, Overflow Count 1, so Projected Active/Bench Additions is 1 and capacity is `12 + 1 = 13 > 12`. **Refused on capacity**, naming the overflow — even though the money is there. There is no carve-out for automatic Slot Placement: an overflow with nowhere to land is refused at the bid, not resolved at the close.
26. **Off-grid amounts are refused everywhere.** A player stands at $6,000,000 in Standard Contention. A bid of $6,750,000 is refused as off-grid, though it clears the increment. In a separate Minimum-Bid Contention, a bid of $1,000,001 is refused as off-grid, though it is neither a valid join nor a conversion either. The granularity check runs independently of contention state.
27. **A voided bid shortens the League Clock.** The last two league-wide events are a Nomination at 09:00 Monday and a Bid at 15:00 Monday, so the League Clock expires 15:00 Wednesday. The Commissioner voids that Bid at 18:00 Monday with a reason. The League Clock is recomputed from the surviving reset events and now expires **09:00 Wednesday**, six hours earlier. The auction the voided bid was on returns to its prior Leading Bidder and prior Auction Clock value. Nothing that happened between 15:00 and 18:00 Monday is invalidated. Had the recomputed expiry already passed, the Auction Phase would end at the next clock evaluation rather than retroactively.

28. **The median lands between two grid values.** The 30 Teams' Available Cap Space figures are sorted ascending; the 15th is $4,000,000 and the 16th is $4,500,000. The conventional median — the mean of the two middle values — is **$4,250,000**, which is *not* a whole multiple of $500,000 and cannot be rendered losslessly at one decimal: `$4.3M` is wrong by $50,000, and `$4.25M` breaks the one-decimal rule the entire money rendering depends on. The **League Median is therefore $4,000,000**, the lower middle value, which renders as `$4.0M` and is a figure a real Team actually holds. The same rule applies to slots: with a 15th value of 2 Free Active/Bench Slots and a 16th of 3, the League Median is **2**, not 2.5 — half a roster slot is not a thing that exists. The lesson is that the $500,000 grid is a product-wide invariant, not a bidding rule: **any new derived figure must land on it, and an aggregate is the easiest place to fall off it.**

## 11. Open Questions

**All resolved by the commissioner on 2026-08-17.** None remain open. Retained with their answers so the reasoning behind each rule is traceable.

1. **OQ-1 — Roster maximum. RESOLVED: yes, 12 is a hard ceiling** — 8 active plus 4 bench. Not merely a minimum. Became **FR-37**, a second refusal ground independent of Maximum Bid, with no carve-out for eligible overflow. Forced §10 examples 18–20 to move Team P from Roster Count 12 to 11, and added the upper bound to FR-30's export check, which now requires exactly 12.
2. **OQ-2 — Eligibility flag in the export. RESOLVED: it does not carry.** The commissioner sets it by hand before the auction opens. Became **FR-38**; FR-2 no longer imports it and the default is *not* eligible, so an unset flag can never grant FR-35's unbounded bidding by omission.
3. **OQ-3 — Assignment deadline behavior. RESOLVED: yes, block the export.** FR-29's 1-year auto-default is removed entirely; an unresponsive Team is resolved by a visible FR-32 override rather than a silent default.
4. **OQ-4 — Bid granularity. RESOLVED: $500,000**, equal to the Minimum Increment. FR-11 updated; §10 examples 2 and 10 gained the granularity ground, and example 26 was added.
5. **OQ-5 — Hard calendar end. RESOLVED: no.** The League Clock is the only terminator. No change.
6. **OQ-6 — Free agents not won. RESOLVED: they simply remain free agents in Fantrax** and need no export treatment. Stated explicitly in FR-30 so nobody builds an unwon-players export.
7. **OQ-7 — Bid void versus the League Clock. RESOLVED: recompute without the voided reset.** FR-22 and FR-32 updated; example 27 added. The prospective-only qualifier is an inference, indexed in §12.
8. **OQ-8 — Availability target. RESOLVED: restate it.** §5's availability NFR is now a posture with a recovery requirement rather than an uptime percentage nothing in the stack can underwrite.
9. **OQ-9 — Outage recovery procedure. RESOLVED: written as scheduled work inside the build epics**, not up front. It remains blocking on auction open.

## 12. Assumptions Index

*Every `[ASSUMPTION]` in this document, surfaced for confirmation:*

- **§4.4 / FR-32** — When voiding a Bid recomputes the League Clock to an instant already past, the Auction Phase ends at the *next* clock evaluation and takes effect prospectively only; nothing accepted in the interim is invalidated. Inferred from OQ-7's answer rather than stated by it. The alternative — retroactive invalidation — contradicts the append-only posture of FR-33 and the "late, not wrong" principle the close sweep runs on. **This is the one live inference introduced by the 2026-08-17 answers.**
- **§4.2 / FR-4** — Discord OAuth chosen for authentication over magic-link email or passwords. Originally specified as magic-link on friction grounds; changed because the project runs on a zero budget and no free email tier delivers the required burst without a deliverability risk that would break SM-3 invisibly. Discord OAuth is also lower-friction for this roster — one tap on a phone already signed in — and yields the Discord user ID FR-27 addresses Managers by, making authentication and notification the same fact. *(Resolved by decision, recorded for provenance.)*
- **§4.3 / FR-9** — An unbid nomination holding its Team's Nomination Slot indefinitely is the accepted consequence of the rules as written; the app surfaces it rather than mitigating it. *(Confirmed by league decision, recorded for visibility.)*
- **§4.4 / FR-35** — Worst-case Minors Exposure is sized as the sum of the *largest* surplus Eligible Leading Bids, on the reasoning that Slot Placement follows close order and a bidder cannot steer which of its wins lands in minors. A cheaper worst-case assumption would let a Team over-commit.
- **§4.5 / FR-20** — Verifiable randomizer fairness (recorded seed and contender list, independently reproducible) treated as a hard requirement rather than a nicety.
- **§4.7 / FR-27** — Outbid notifications cannot be muted, on the grounds that muting them undermines the fairness premise of a 24/7 clock.
- **§4.10 / FR-34** — Commissioner pause included as an outage/dispute escape hatch, despite the league running clocks continuously by rule.
- **§3 Glossary / FR-14** — Every Contender in a Minimum-Bid Contention on a Player who is **not** Minor League Eligible has $1,000,000 committed against their cap for the life of the lottery, since any of them may win. *(Originally written to cover all contentions; narrowed when the contradiction with FR-35 was found — see below.)*

*Added 2026-08-18 with FR-39:*

- **§3 Glossary / FR-39 — League Median is the lower of the two middle values, not their mean.** `[ASSUMPTION]` The commissioner asked for a median and did not specify the even-count rule. The conventional definition can produce a figure at $250,000 granularity, which falls off the $500,000 grid and is therefore not losslessly renderable at one decimal — and the losslessness of that rendering is what permits abbreviated money everywhere in the product, including in refusal arithmetic that must visibly sum. The lower middle value is always a real Team's figure and always on the grid. The alternatives were rejected as worse: rounding the mean to the grid publishes a number no Team holds and that no manager can reproduce, and rendering the median at two decimals would make it the only money figure in the app with its own format. §10 example 28 makes this executable. **Confirm if you would rather see the true mean-of-two-middles and accept a second money format for it.**
- **§4.6 / FR-25 — every Team figure is public.** *(Decided by the commissioner, 2026-08-18.)* The previous own-team-only reservation on Free Minor League Slots and Minors Exposure was removed rather than extended, on the grounds that both were already derivable from published figures and FR-39 makes the derivation trivial. Recorded here because it is a deliberate widening of what rivals can see, not an oversight — a manager can now read another Team's exposure directly instead of computing it.

*Resolved during finalize, retained for provenance:*

- **§3 Glossary** — Roster Count counts only Active/Bench Slots; IR and Minor League players are excluded from the 12-player minimum and therefore from Roster Reserve. **Confirmed by the league.**
- **§4.5 / FR-21** — A won Minor League Eligible Player is placed automatically in a free Minor League Slot, or in an Active/Bench Slot when all three are occupied. **Confirmed by the league.**
- **§4.4 / FR-35** — A Minor League placement yields a $0 Cap Hit even on a large winning bid, so a Team with a free slot bids without cap limit. **Confirmed by the league:** the evasion is temporary and self-correcting, because the Team cannot activate the Player without absorbing the full amount — a constraint enforced in Fantrax, not in this app.

*Contradictions found and resolved after finalize, retained for provenance:*

- **§3 Glossary vs §10 examples 18–20** — the examples computed `M = 1` for a Team with zero occupied Minor League Slots, where the Glossary's `M = 3 − currently occupied` gives `M = 3`. Traced to a slip introduced when examples 18–20 were added during the FR-35 rewrite. **The Glossary rule was tested and kept unchanged; the examples' setup was corrected** to a Team occupying two Minor League Slots, which is the only value that makes all three cohere. Example 20's lesson consequently sharpened from "exposure returns to $0" to "an *open* leading bid creates exposure while a *closed* one does not."
- **§3 Glossary / FR-14 vs FR-35** — a Minimum-Bid Contention on a Minor League Eligible Player was governed by two contradictory rules: a flat $1,000,000 commitment, or Minors Exposure only. Traced to an assumption recorded *before* the FR-35 rewrite and never revisited when that rewrite superseded it. **FR-35 wins:** such a contention is an Eligible Leading Bid of $1,000,000 and commits nothing while a Free Minor League Slot exists, because a winning Contender is placed in a slot at a $0 Cap Hit. Examples 21 and 22 were added to work both branches.

*Retired by the commissioner's answers on 2026-08-17 — the assumption is gone because the question behind it was answered:*

- **§4.1 / FR-2 — eligibility flag in the export.** Assumed present; **it is not.** Replaced by FR-38, commissioner-set, defaulting to not eligible. (OQ-2)
- **§4.4 / FR-11 — $100,000 bid granularity.** Inferred; **the real figure is $500,000**, equal to the Minimum Increment. (OQ-4)
- **§4.8 / FR-29 — 1-year default at the deadline.** Assumed as the least-consequential fallback; **rejected.** The export blocks instead and the commissioner resolves stragglers visibly under FR-32. (OQ-3)

*Ripple recorded for provenance — §10 examples 18–20 amended a second time:*

- Team P's Roster Count moved from **12 to 11**. This is not a defect in the examples; it is FR-37 arriving after they were written. At Roster Count 12 the new capacity ceiling refuses example 20's bid on capacity grounds, contradicting its stated "permitted" outcome. At 11 all three examples keep their original lessons intact and each now also exercises the capacity check — 18 passes it at `11 + 0`, 19 passes it at `11 + 1` (isolating Minors Exposure as the sole refusal ground), and 20 passes it at `11 + 1`. Example 25 was added to cover the case where capacity *is* the ground and money is not.
