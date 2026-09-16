# Adversarial review — FR-15, "Bid retraction inside a five-minute window"

**Lens:** adversarial / edge-case recall, applied to FR-15 (added 2026-09-16, seventh pass) and its
interaction with the rest of `prd.md` and `addendum.md` §G.
**Reviewer posture:** hunt for holes. No praise, no softening. Uncertainty is marked as uncertainty
with the fact that would settle it.
**Verdict:** **Do not implement as written.** FR-15 is well-argued and unusually self-aware — it
anticipates the chain-termination argument, the clock restore into the past, the directional test,
and the Drop trap — but it has **three critical defects**, one of which (retracting the Bid that
dissolved a lottery) has **no defined outcome at all**, and one of which (the exhaustiveness claim)
is falsified by FR-15's own machinery. The document's claim that the cut-short list is exhaustive
is **false**: three further triggers are reachable, and one of them is created by retraction itself.
The document's claim that a re-bid floor is unnecessary is **answering the wrong objection**.

Finding counts: **3 critical, 5 high, 8 medium, 2 low.**

---

## CRITICAL

### C-1. Retracting the Bid that dissolved a Minimum-Bid Contention has no defined outcome, and FR-15's chosen machinery cannot produce one

FR-19 (line 545): *"The Contender list is **discarded** and every Contender's $1,000,000 commitment
is released immediately."*
FR-15 (line 406): *"The Auction is handed to its **next-highest surviving Bid by the same selector
FR-40 uses**."*
FR-15 (line 400): a retraction *"is the Commissioner void's treatment (FR-32)."*

These cannot both hold on a converting Bid. Timeline:

- **09:00 Mon** — Player Y opened at exactly $1,000,000 by Team E. Minimum-Bid Contention, Clock
  fixed at 09:00 Tue (FR-17).
- **12:00 Mon** — Teams F and G join at $1,000,000 each. Contender list [E, F, G].
- **20:30 Mon** — Team I bids **$1,500,000**. FR-19 fires: the Contender list is **discarded**, all
  three $1,000,000 commitments release, Standard Contention begins, Auction Clock resets to
  20:30 Tue, League Clock resets to 48h.
- **20:33 Mon** — Team I retracts. It is inside five minutes; I's Bid still stands; I is the
  Leading Bidder.

What now? The document supports three mutually exclusive readings and states none:

1. **The contention is reinstated** — [E, F, G] restored, Clock restored to 09:00 Tue, three
   $1,000,000 commitments re-taken. This is what "the void's treatment" means under FR-32
   (line 823: *"restores the Auction to its state before that Bid"*) and is almost certainly the
   intended outcome. But FR-15 does not say it, and FR-15's **selector cannot express it**: FR-40's
   walk hands the Auction to a *single* next-highest surviving Bid and re-validates *that Team*.
   There is no next-highest Bid here — there are three equal $1,000,000 entries that were
   **discarded**, not outbid. The restorer AD-31 is parameterised over three axes
   (`withdrawnBid`/`auctionClock`/`leagueClockReset`, addendum §G line 164); reinstating a
   discarded Contender list is a **fourth behaviour**, and §G's claim that retraction is "a third
   caller passing the void's existing triple, unchanged" and needs "no fourth axis" is **wrong for
   this case**.
2. **A single $1,000,000 entry becomes the Standard-Contention Leading Bid** — nonsense: it is
   below the Opening Bid minimum for Standard Contention in spirit, it arbitrarily picks one of
   three equals, and it silently converts two other Teams' lottery entries into losses.
3. **Awaiting Opening Bid, Clock cleared** — destroys three uninvolved Teams' entries because a
   fourth Team mistyped, and the Player's lottery is gone.

Also unaddressed even under reading 1: re-committing E, F and G's $1,000,000 each is a
**multi-Team** re-validation. FR-40's restorer re-validates **one** candidate and skips it. If F has
since spent its capital (F's own activity is not watched by FR-15 — see C-2), does F return to the
list, get skipped, or block the reinstatement? Nothing says.

**Severity: critical.** This is the one case where "takes the void's treatment" and "uses FR-40's
selector" point at different outcomes, FR-15 asserts both, and the affected parties are three Teams
who did nothing. **What would settle it:** a commissioner ruling on whether a conversion is
retractable at all. The cheapest correct answer is almost certainly *a converting Bid is not
retractable* — it is a category FR-15's machinery does not cover, and it is not the fat-finger case
the window exists for.

### C-2. The cut-short list is not exhaustive — the sixth trigger is *a restoration granted to the displaced Team on another Auction*, and FR-15 creates it

FR-15 (line 393) names five triggers and calls them exhaustive; line 407 concludes
*"Because the cut-short list is complete, the displaced Team is in practice always restorable."*

The Glossary (line 141) says a **Restored Leading Bidder** is a Team *"whose capital is
**re-committed** at that moment."* A restoration therefore **raises** the displaced Team's Committed
Bids — the exact direction that makes restoration fail. Restoration can be handed to Team B by
**FR-40** (some other Team's win cancelling a bid above B), by **FR-32** (a Commissioner void of the
bid above B), or — most damningly — by **another Team's FR-15 retraction**. None is on the list.

Timeline (two auctions, four Teams, explicit figures):

- Team **B**: Cap Space $40,000,000, Roster Count 10, no other commitments. Available Cap Space
  $40,000,000.
- **13:00** — On Player X, B leads at **$6,500,000**. On Player W, Team D leads at **$36,000,000**
  and B is the next-highest at **$35,000,000** (B was outbid at 11:00; B's $35,000,000 released).
- **17:00:00** — Team A bids **$7,000,000** on X. B is displaced and notified. A's window opens,
  running to 17:05:00. B's Committed Bids: $0.
- **17:02:00** — Team D retracts on W (D's $36,000,000 was placed at 16:59; the Team D displaced —
  B — has not moved, so **D's window is legitimately open**). The FR-40 selector restores **B at
  $35,000,000**. B's Committed Bids become $35,000,000; Available Cap Space $5,000,000; with
  Projected Active/Bench Additions 1, Roster Reserve $1,000,000, and B's **Maximum Bid is
  $4,000,000**.
- **17:03:00** — Team A retracts on X. **Nothing on the cut-short list has fired**: B placed no Bid,
  won no Close, won no Draw, had no Bid cancelled, and had no Trade/Drop/Move recorded. The
  retraction is therefore **permitted**.
- The restorer tries B at $6,500,000. B's Maximum Bid is $4,000,000. **B fails the money gate and is
  skipped.** Player X falls to whoever is below B, or to Awaiting Opening Bid.

FR-15 line 408 says exactly what this is: *"A retraction that reaches a Team other than the one it
displaced is a signal that the cut-short list has a hole in it, and should be treated as a defect to
investigate."* **The hole is reachable on day one, using nothing but FR-15 itself.** Worse, B is
*penalised* by FR-40's re-commitment on an Auction it had stopped watching (the §9 risk at line
1056 concedes B cannot decline it), and then loses a second Auction because of it.

**Two further missing triggers, both reachable and both directionally adverse:**

- **FR-32 Cap Space adjustment.** Line 819: *"Commissioner can void a Bid, **adjust a Team's Cap
  Space**, …"* — the stated purpose (§6 line 997) is correcting a wrong imported figure. Correcting
  Team B's Cap Space **downward** by $2,000,000 at 14:02 makes B fail the money gate on the Bid it
  would be restored to at 14:03. Not on the list.
- **FR-38 post-open eligibility flip.** Line 227: *"After the auction opens the flag is locked and
  changeable only by Commissioner override (FR-32), **because it changes cap arithmetic under
  FR-35 for every open Auction on that Player**."* If B leads an eligible Auction at $40,000,000
  absorbed by a Free Minor League Slot — Minors Exposure $0, committing **nothing** (§10 example 18)
  — and the Commissioner un-flags that Player at 14:02, B's $40,000,000 moves straight into
  Committed Bids at full amount. B goes from unconstrained to unrestorable in one override. Not on
  the list, and FR-38 itself names cap arithmetic as the reason the flag is locked.

**Severity: critical.** The exhaustiveness claim is load-bearing — line 407 uses it to promise
managers that "a retraction gives the Auction back to exactly the Team you outbid." That promise is
false as written, and the §12 entry at line 1200 already concedes the list "must be **maintained**"
and "is the gap that list already had on the day it was written." It has at least three more.

### C-3. The open-outcry defence answers the wrong objection: the cut-short protects only the *displaced* Team, so a retractable Bid is a free instrument against *third* parties

FR-15 line 382: *"It is not a negotiating instrument, and the cut-short rule is what stops it
becoming one."* Line 390: *"a retract-then-lower sequence gains a Team nothing it could not have had
by bidding the lower amount first."*

Both claims fail, for the same reason: **the cut-short watches only the displaced Team B. A third
Team C's reaction to the Bid never closes the window.** And FR-12 line 350 guarantees C *reacts*:
*"A Team whose Maximum Bid on a given Auction is below the minimum legal Bid for that Auction sees
its bidding controls **disabled** there, with the reason stated."*

Timeline:

- Player X stands at **$4,500,000**, held by Team B. Team C has Available Cap Space $12,000,000 and
  intends **$9,000,000** on X tonight. Team A wants X for as little as possible.
- **14:00:00** — A bids **$20,000,000** on X. Legal on every ground (A must momentarily cover it,
  FR-13). The Bid Board publishes it; C's controls on X go **disabled with "your Maximum Bid is
  $12,000,000" stated** (FR-12). The Auction Clock resets to 24h; the League Clock resets to 48h.
- **14:01:30** — C, reading a $20,000,000 market it cannot enter, commits its $9,000,000 to Player Y
  instead. **C's own Bid does not cut A's window** — only B's activity does, and B has done nothing.
- **14:04:30** — A **retracts**. B is restored at $4,500,000; the Auction Clock is restored to B's
  instant; A's League Clock reset is removed.
- **14:04:40** — A bids **$5,000,000**. Legal; **no floor forbids it** (FR-15 line 390, §10 example
  47). C's capital is now committed on Y and its Maximum Bid on X has moved.
- A wins X at $5,000,000 against a market that valued him at $9,000,000. **A paid nothing for the
  bluff** — four and a half minutes of a $20,000,000 commitment.

The open-outcry argument ("the number it is bidding against was already public") defends against
the wrong harm. The harm is not that A learned B's price; it is that **A published a price that was
never real and that other Teams acted on irreversibly**. FR-15's own Record clause (line 423)
concedes the class of harm — *"A retraction visible only to the two Teams involved would be a
private probing instrument"* — and then only fixes visibility, which does not help C at all: C saw
the $20,000,000, and seeing the retraction afterwards does not return C's $9,000,000 from Y.

**The same shape gives a costless call option on a closing Auction:**

- Player Z, B leading at $4,500,000, Auction Clock expires **09:00:00 Tuesday**.
- **08:59:55** — A bids $5,000,000. Clock resets to 08:59:55 **Wednesday**.
- A now holds, free, until 09:04:55: *if anybody else moves on Z in the next five minutes, keep the
  player and the Auction stays live a further day; if nobody does, retract and hand Z back to B at
  the price and instant that would have obtained anyway.* A has bought a five-minute probe of
  whether the market still wants Z, at zero cost, on an Auction that was seconds from closing.

**Severity: critical**, judged by league trust. This is the exact instrument FR-15 asserts it is
not, and the assertion is the only thing standing between the rule and the behaviour.
**What would settle it:** a commissioner ruling. The cheapest mitigations are (a) a re-bid floor at
the retracted amount *for that Team on that Auction* — which does not defeat the typo case, since a
typo is corrected **downward** only when the typo was upward, and the floor can be set at the
*displaced* price rather than the retracted one; or (b) barring retraction of a Bid more than N
increments above the price it displaced, which is the only shape a genuine fat-finger takes.

---

## HIGH

### H-1. A Contender list emptied by retraction has two contradictory outcomes in FR-15, and one of them reinstates a state §12 declares must not exist

FR-15 line 415: *"A list reduced to **zero** **closes with no winner at expiry** and the Player
returns to the pool."*
FR-15 line 414: *"the **Opening Bid that created the contention**: retracting it **while the Team is
the only Contender** exhausts the history and returns the Auction to **Awaiting Opening Bid with the
Clock cleared**."*

These disagree whenever the history is exhausted *without* the opening bidder being the last to go:

- **09:00:00** — Team E opens Player Y at exactly $1,000,000. Contention; Clock fixed 09:00 Tue.
- **09:01:00** — Team F joins at $1,000,000. List [E, F].
- **09:02:00** — **E retracts.** Legal: E's Bid is 2 minutes old, an Opening Bid has no cut-short
  subject (line 397), and E is still in the Contender list (line 389). E was **not** the only
  Contender, so line 414's clause does not apply. List [F].
- **09:04:00** — **F retracts.** Legal: 3 minutes old, a join displaces nobody, F still listed.
  List **[ ]**.

The history is now **exhausted** — every Bid on the Auction has been erased — yet neither retraction
met line 414's "only Contender" condition. Line 415 therefore governs, and Player Y sits on the
Board with **an Auction Clock running to 09:00 Tuesday on an Auction nobody is in**, closing with no
winner 24 hours later and only then returning to the pool.

That is precisely the state the commissioner ruled out. §12 line 1193, **a settled rule**:
*"Applied literally to an Auction with no surviving bid, that would leave a clock running on an
auction nobody is in, which closes with no winner at an arbitrary hour — **a state FR-21 does not
define**."* FR-40's Restoration clause (line 607) says the same: *"If no surviving Bid passes, the
Auction returns to Awaiting Opening Bid with no leading Bid. Its Auction Clock is **cleared**, not
left running."*

The outcomes differ materially: under the settled rule Player Y is immediately re-openable and any
Team may start a fresh 24 hours; under line 415 he is frozen for a day and then lost.

**Severity: high.** FR-15 contradicts a rule §12 marks CONFIRMED, and the condition that triggers
it is a two-line sequence any two managers can produce. The fix is one word — the exhausted-history
rule is about exhaustion, not about who was the last Contender — but as written the document says
both things.

### H-2. FR-34's pause freezes every clock in the product except the one that decides whether a manager can undo a $50,000,000 typo

FR-34 line 843: *"While paused, all **Auction Clocks and the League Clock** stop advancing, and
**Nominations and Bids** are refused with the pause stated as the reason."*
FR-15 line 388: the window is *"derived, never stored… the **server's clock** decides."*

The Retraction Window is neither an Auction Clock nor the League Clock, and a retraction is neither
a Nomination nor a Bid. FR-15 contains **no pause clause at all** — unlike FR-44 (line 493,
*"Refused while the auction is paused (FR-34). A Move changes Maximum Bids, and a paused auction
changes nothing"*), FR-41 and FR-43. Two consequences, both unhandled:

1. **The window expires during a pause.** §5 line 982: *"Any outage beyond 15 minutes is a
   Commissioner pause (FR-34)."* Timeline: **14:00:00** Team A fat-fingers **$50,000,000** on Player
   X (§10 example 47's exact case). **14:01:00** the Commissioner pauses for a Supabase outage. The
   pause lasts 40 minutes. **14:41:00** resume. A's window closed at **14:05:00** — during a period
   in which A could not reach the app, and in which the product's own doctrine says nothing changes.
   A is now holding a $50,000,000 Bid on a $5,000,000 player, and its only remedy is the
   Commissioner override FR-15 exists to eliminate (line 382). The §9 risk at line 1057 covers a
   manager finding the window closed for a reason they cannot see; it does not cover the window
   closing *because the app was down*.
   Note the aggravating case is the documented one: §9 line 1063 names a **Discord outage** as a
   pause trigger, and FR-4 guarantees only the **Commissioner** a non-Discord sign-in. During a
   Discord outage, A cannot sign in at all while its window drains.
2. **If retraction *is* permitted during a pause, it moves frozen clocks.** FR-15 restores the
   Auction Clock and removes a League Clock reset. Both are explicitly stopped under FR-34, and the
   addendum's pause mechanism (§C line 121) *"must store remaining duration, not shift absolute
   close times."* A retraction during a pause writes a new absolute Auction Clock value and
   recomputes the League Clock — against a pause implementation that is specified in terms of
   remaining durations. Nothing in the document reconciles the two.

**Severity: high.** Both readings are defensible from the text and they produce opposite behaviour
on the exact scenario (outage during a typo) that a solo-builder league will actually hit.
**What would settle it:** a rule stating whether paused time counts against the window. The
consistent answer is that it does not — the window should be measured in *unpaused* server time,
which is a one-line change to the derivation and matches FR-34's "every Clock continues with exactly
the remaining time it held at pause."

### H-3. A Team can hold the Auction Phase open indefinitely, for free, by staggering lottery joins and retractions

FR-18 line 534: *"**Joining resets the League Clock to 48 hours**."*
FR-18 line 532 / FR-15: an entry may be retracted within five minutes, releasing the $1,000,000,
with *"no fee, no cooldown"* (line 390).
FR-15 line 402: the retraction removes **that Bid's** reset, and the recomputation is prospective.

Retraction only removes the reset the retracted Bid earned. So stagger them:

- **00:00:00** — Team Z joins Minimum-Bid Contention on Player P at $1,000,000. League Clock → 48h
  from 00:00. Z commits $1,000,000.
- **00:04:00** — Z joins the contention on Player Q. League Clock → 48h from 00:04. Z now commits
  $2,000,000.
- **00:04:30** — Z **retracts on P** (30 seconds before P's window closes). P's reset is removed;
  **Q's reset at 00:04 stands.** Z's commitment back to $1,000,000.
- **00:08:00** — Z joins on Player R. Reset → 48h from 00:08.
- **00:08:30** — Z retracts on Q. Q's reset removed; R's stands.
- …repeat.

Steady state: **Z holds exactly one live entry, $1,000,000 of commitment, no roster exposure
whatsoever** (FR-18 line 536: entries *"do not count toward Projected Active/Bench Additions, are
not subject to Roster Capacity, and do not consume the Outstanding Bid Allowance"*), and the League
Clock never falls below 47h56m. The Auction Phase **cannot end** while Z keeps this up. A single
manager with $1,000,000 of Available Cap Space and one open Slot can hold thirty people hostage
indefinitely, and every act in the chain is individually legal.

Before FR-15 this was not free: resetting the League Clock required a Bid that stayed placed, which
committed capital and risked winning a player. FR-15 removes both the cost and the risk.

Note the document worked the *opposite* direction carefully — §9 line 1058, *"A retraction can end
the Auction Phase"* — and did not look at the lengthening direction at all. FR-22 line 626 makes the
League Clock the **only** terminator (OQ-5, line 1145: *"Hard calendar end. RESOLVED: no."*), so
there is no backstop.

**Severity: high.** A held-open auction is a league-trust failure of the first order and the app has
no rule to stop it. The Commissioner's remedies are FR-32 (expire the League Clock — a visible
override adjudicating a dispute, which is what SM-2 exists to avoid) or nothing.

### H-4. For up to five minutes after every Bid, every Auction Clock on the board is provisional, and nothing says so

FR-15 line 401: *"The Auction Clock is **restored** to the value the retracted Bid displaced."*
FR-23 line 646/649: the Board shows *"time remaining"*, *"accurate to the second and derived from a
server-authoritative close time."*
FR-16 line 513: *"The Clock's absolute close time is displayed alongside the countdown."*

§10 example 48 works the mechanics correctly and then draws the wrong boundary around them. It calls
the outcome *"correct rather than a race"* — but it is a race for **every Team that is not A or B**:

- **09:00:00 Tue** was Player Y's close time (B leading at $4,500,000 since 09:00 Mon).
- **08:58:00 Tue** — Team A bids $5,000,000. Every manager's board now reads **08:58 Wednesday** —
  "23h 59m" remaining.
- **08:58 – 09:03** — Team C opens the board, sees a full day of runway on a player it wants at
  $6,000,000, and decides to bid after work.
- **09:02:00** — A retracts. The Clock snaps back to **09:00:00 Tue, two minutes in the past.** The
  Auction closes at the next sweep and B wins at $4,500,000.
- C never had a chance to react to a close time that, for those four minutes, the app displayed as
  being a day away.

Two distinct defects:

1. **No surface carries the provisionality.** §9's mitigation (line 1057) requires the *retracting*
   manager to see a live countdown; nothing requires the board to tell **everyone else** that this
   Auction's close time may revert. FR-23 and FR-24 were not amended. A close time that can move
   backwards without any event visible to the viewer is a direct hit on SM-1 ("zero disputed
   outcomes") and on the product's whole premise that nobody should have to wonder whether the app
   got it right.
2. **The sweep race is undefined.** Between the restore at 09:02:00 and the sweep firing (up to 60
   seconds later, §5 line 981), the Auction is open with an expired Clock. Can Team C bid at
   09:02:30? §5 line 980 says a client *"must not be able to bid after expiry"*, but this Auction's
   expiry moved into the past *after* the fact. If the bid is accepted the Clock resets 24h and
   example 48's stated outcome ("B wins at $4,500,000") does not happen. FR-15 nowhere seals the
   Auction at the moment of restoration, and FR-21's sweep has no concept of an Auction that expired
   retroactively.

**Severity: high**, mostly on (2), which decides who gets a player.

### H-5. FR-15 states no phase applicability — the only act of its class that does not

Every comparable requirement bounds itself by Phase:

- FR-44 line 492: *"Permitted in the **Auction** and **Contract Assignment** Phases; refused in Setup
  and once Archived."*
- FR-41 line 879, FR-43 line 973: the same sentence.
- FR-32 line 826: *"permitted during the Auction Phase and Contract Assignment Phase, and refused
  once archived."*

FR-15 says nothing. This is not academic, because an Auction with a live Bid is **not** terminated
at Phase End — FR-22 line 630 terminates only Auctions *"still in Awaiting Opening Bid at expiry"*,
so a contested Auction's 24-hour Clock runs on into the Contract Assignment Phase (a gap that
predates FR-15, but which FR-15 now has to answer). Concretely: FR-32 lets the Commissioner *"expire
any Clock"*; if the League Clock is expired at 14:02 while Team A's 14:00 Bid is 2 minutes old, may
A retract at 14:03 — reopening an Auction, restoring a clock, and recomputing a League Clock that has
already fired? The document has no answer.

**Severity: high**, because it is trivially fixable and its absence is the kind of omission that
ships.

---

## MEDIUM

### M-1. The "Bid cancelled under FR-40" entry on the cut-short list contradicts the directional test, and is redundant besides

FR-15 line 393 lists, as a cut-short: *"a Bid of its own is **cancelled under FR-40**."*
FR-15 line 395: *"A change that can only make restoration **easier** does **not** cut the window
short… capital **released** rather than committed."*
FR-40 line 602: *"The cancelled Team's committed capital is **released**."*

A cancellation is pure relief for the cancelled Team — it is the same direction as being outbid,
which line 395 explicitly rules *out* of the list. So the entry contradicts the stated test. It is
also **redundant**: FR-40 line 593 says cancellation is *"triggered only by an Auction Close that
reduces the **winning** Team's free Slots"* and cancels **that winning Team's** commitments — so a
Team that has a Bid cancelled has necessarily just **won a Close or a Draw**, which are already
entries 2 and 3. The list therefore has four real members, not five, and one member that is
stated in the direction the rule says does not count.

Harmless in outcome (it only refuses retractions unnecessarily) but it corrupts the reasoning the
rest of the rule stands on, and it inflates the exhaustiveness claim of C-2 by one.

### M-2. FR-32 says a void restores the prior Leading Bidder unconditionally; FR-40 and FR-15 say all three withdrawals skip-and-walk

FR-32 line 823: *"Voiding a Bid **restores the Auction to its state before that Bid, including the
prior Leading Bidder** and the prior Auction Clock value."* No gate, no re-validation, no skip.
FR-40 line 594: *"**All three** hand the Auction to the next-highest surviving Bid by the **same
selector, under the same skip rule**."*

FR-15 leans on this equivalence twice (lines 400, 406) — it claims the void's *treatment* and the
cancellation's *selector*. The two source requirements disagree about what the void's selector even
is. Under FR-32 a void can restore a Team into a cap breach; under FR-40 it cannot. Pre-existing,
but FR-15 makes it load-bearing and should not have left it unresolved.

### M-3. FR-33's and FR-26's enumerations do not carry Bid Retraction

FR-33 line 835: *"Entries cover every **Nomination, Bid, Auction Close, Randomizer draw with seed,
Commissioner override, import, and export**."* No Bid Retraction; no Bid Cancellation either
(missing since 2026-09-08).
FR-26 line 726: *"**Nominations, Bids, Auction Closes, Randomizer draws** (including seed and
Contender list), **Auction Phase start, and Auction Phase end** are each posted."* No retraction, no
cancellation, no restoration.

The Glossary's Audit Log entry (line 175) *does* list both, and FR-15 line 423 requires a retraction
be *"written to the Audit Log and broadcast to the league per §4.7."* But §4.7 is FR-26/FR-27, whose
enumerations FR-15 did not amend, and FR-33 is the requirement that governs the Log — the Glossary
is vocabulary. Similarly FR-27 line 736's mention list has no "your Bid was restored" event, though
FR-40 line 619 and FR-15 line 424 both require that notification. An implementer building from the
requirements will ship a log and a channel that are silent about the three things this pass added.

### M-4. Either co-Manager may retract the other's deliberate Bid, with no confirmation and no reason field

FR-15 line 378: *"A Bid may be retracted by **the Team that placed it**."* Team-level, not
Manager-level. FR-5 line 254: co-Managers *"see identical Team state."* FR-15 line 420 then removes
the one thing that would make this auditable: a retraction *"carries **no reason field at all**."*

So Priya's brother's considered $20,000,000 bid can be undone by Priya ninety seconds later and
re-placed at $5,000,000, and the Audit Log shows a Manager name and nothing else — indistinguishable
from a typo correction. FR-44, the other Manager-invoked act, requires *"a **confirmation** sheet"*
(line 491); FR-15 requires none. UJ-3's premise is that *"a co-managed team needs to be able to
reconstruct who did what"* (line 233), and this is the one act where it cannot reconstruct **why**.

Note the tension with §12 line 1202, which justifies the no-reason rule solely from the typo case
and marks it *"confirm at UX"* — the co-management case was not considered when that inference was
drawn.

### M-5. FR-15's own defect-detector produces a guaranteed false positive after a Commissioner void

FR-15 line 408: *"**A retraction that reaches a Team other than the one it displaced is a signal
that the cut-short list has a hole in it**, and should be treated as a defect to investigate rather
than an outcome to accept."*

But a void **erases** the voided Bid (FR-40 line 594). Sequence: A bids $7,000,000 at 14:00,
displacing B at $6,500,000. At 14:02 the Commissioner **voids B's $6,500,000** for an unrelated
reason (wrong co-manager, say — §4.10's own example, line 813). At 14:03 A retracts. B's Bid no
longer exists, so the restorer necessarily reaches Team C below — **correctly**, with no hole in the
list anywhere. The diagnostic fires anyway. A defect signal that fires on correct behaviour is a
signal that gets ignored, which is the SM-C4 failure mode stated about a different detector.

### M-6. FR-18's retraction bullet specifies the Auction Clock and omits the League Clock

FR-18 line 532 spells out the Auction Clock treatment at length — *"the Auction Clock is untouched
in both directions"* — and says nothing about the League Clock, even though the very next bullet
(line 534) establishes that *"Joining resets the League Clock to 48 hours."* An implementer working
from FR-18 alone (which is where the join lives) will leave the 48-hour reset in place, because the
bullet appears to be exhaustive about clocks. The correct behaviour is in FR-15 line 402. This is
exactly the conflation addendum §G line 168 warns about — *"one line apart in any reducer"* — and it
is the one place the PRD's own text invites it. Cross-reference H-3, which turns on this reset.

### M-7. "The displaced Team" is singular; a converting Bid displaces every Contender

FR-15's cut-short is written entirely in the singular — *"the displaced Team's position"*, *"the
Team it displaced"*, *"it bids, wins a Close, wins a Draw"* (lines 378, 393, 396). A $1,500,000
conversion under FR-19 displaces the **whole Contender list**, potentially twenty Teams. Whose
activity cuts the window short — any of them, all of them, the opening bidder? Unspecified.
Compounds C-1: even if C-1 is resolved by making the conversion retractable, the cut-short test
cannot be evaluated without this answer.

### M-8. Unlimited free retract/re-bid cycling weaponises the one notification FR-27 forbids muting

FR-15 line 390: *"no fee, **no cooldown**"*, and no per-Auction or per-day limit anywhere in the
requirement. FR-44, by contrast, states its unlimitedness deliberately and gives the reason (line
494). FR-27 line 740: *"**Outbid mentions**… **cannot be muted**"*, with §12 line 1160 recording that
as a deliberate assumption.

So: Team A bids the minimum increment on Team B's Auction, waits four minutes, retracts, waits, bids
again. Each cycle fires an unmutable `@mention` at both of B's Managers plus a restoration notice,
and posts two lines to the league channel. Twelve cycles an hour, overnight, costs A nothing and
changes no price. There is no rule against it, no rate limit, and the only mitigations in the
document (publication, §12 line 1203) *amplify* it — the assumption entry already concedes *"the
cost is noise."* The addendum's own watch-item for FR-27 is *"notification fatigue"* (§H line 188).

**Severity: medium**, not high, because it is social rather than arithmetic — but it is the cheapest
grief vector the product now contains, and the league is 31 people who know each other.

---

## LOW

### L-1. Glossary definitions of Bid Retraction and Retraction Window omit the leading-only and most-recent restrictions

Glossary line 162: *"a Team withdrawing **its own Bid** inside the Retraction Window."* Line 163:
*"the five minutes following a Bid, during which **its Team may retract it**."* Neither carries
FR-15 line 389's restriction — *"only its own **most recent** Bid on an Auction, and only **while
that Bid still stands**"* — which §12 line 1199 records as a **chosen, settled rule**. §3's preamble
(line 118) says downstream workflows *"must use these terms exactly"*; as written the Glossary
authorises the rule the commissioner explicitly rejected (withdrawing a surviving losing Bid).

### L-2. The compound "retraction ends the Phase and strands its own nomination" is unworked

Not a contradiction, but the sharpest user-facing case is not in §10 and the §9 risk (line 1058)
stops one step short. Take §10 example 51's second shape: Team H opened Player Z at exactly
$1,000,000 and retracts two minutes later, returning Z to Awaiting Opening Bid with the Clock
cleared. Now place it at hour **47:58** of a quiet League Clock, where H's own Opening Bid was the
last league-wide event. The single retraction (a) removes the reset that was holding the Phase open,
so the recomputed expiry is in the past and the Phase ends at the next evaluation (FR-22, FR-32,
§10 example 27); and (b) leaves Z in Awaiting Opening Bid, which FR-22 line 630 then **terminates
with no winner**, returning Z to the pool. H spent its Nomination Slot on Z, won nobody, and FR-9
line 303 is explicit that *"an Auction that ends with no winner at all"* does **not** return the
Slot. So one retraction of one $1,000,000 typo ends the auction for thirty teams, destroys the
Player, and permanently consumes the retractor's only Nomination Slot. Every step is the documented
behaviour of a different requirement; the compound appears nowhere, and it is the case a manager
will describe as the app having eaten their offseason.

Also unworked and worth a line in §10: when the restorer **skips** the displaced Team (which FR-15
line 408 insists must still be evaluated), the Auction Clock is restored to *"the value the retracted
Bid displaced"* — i.e. the clock the **skipped** Team's Bid bought. The Auction then closes at an
instant purchased by a Bid that is not the winning one. FR-40 line 611 justifies leaving a clock
alone with *"the Auction was always going to close then"*; that justification does not survive the
skip, and FR-15 does not address it.

---

## Summary table

| # | Finding | Severity |
|---|---|---|
| C-1 | Retracting a lottery-dissolving Bid has no defined outcome; FR-15's selector cannot restore a discarded Contender list | critical |
| C-2 | Cut-short list not exhaustive — restoration-elsewhere (reachable via FR-15 itself), FR-32 Cap Space adjustment, FR-38 eligibility flip | critical |
| C-3 | Retraction is a free bluff/denial instrument against third parties; the open-outcry defence answers the wrong objection | critical |
| H-1 | Contender list emptied by retraction: FR-15 gives two contradictory outcomes, one reinstating a state §12 forbids | high |
| H-2 | FR-34 pause vs the window — window drains while the app is frozen; retraction during pause moves frozen clocks | high |
| H-3 | Auction Phase can be held open indefinitely, free, by staggered lottery join/retract | high |
| H-4 | Auction Clocks are provisional for 5 minutes with nothing flagging it; the restore-into-past sweep race is undefined | high |
| H-5 | FR-15 states no phase applicability, unlike FR-32/41/43/44 | high |
| M-1 | The FR-40-cancellation cut-short entry contradicts the directional test and is redundant | medium |
| M-2 | FR-32 restores the prior Leading Bidder unconditionally; FR-40/FR-15 skip-and-walk | medium |
| M-3 | FR-33 and FR-26 enumerations omit Retraction (and Cancellation, and restoration notices) | medium |
| M-4 | Co-Manager may retract a partner's deliberate Bid, no confirmation, no reason field | medium |
| M-5 | FR-15's "reached a different Team = defect" diagnostic false-positives after any void | medium |
| M-6 | FR-18's retraction bullet specifies the Auction Clock and omits the League Clock | medium |
| M-7 | "The displaced Team" is singular; a conversion displaces the whole Contender list | medium |
| M-8 | Unlimited free retract/re-bid cycling weaponises FR-27's unmutable outbid mention | medium |
| L-1 | Glossary omits the leading-only / most-recent restrictions §12 records as settled | low |
| L-2 | Unworked compounds: retraction ending the Phase and stranding its own nomination; whose clock is restored when the displaced Team is skipped | low |

## What I could not settle from the document

- Whether a converting ($1,500,000) Bid is intended to be retractable at all (C-1). The
  commissioner's 2026-09-16 session (§12 line 1198) considered whether *entries* are retractable and
  chose uniformity; the record does not show the *conversion* being put to him.
- Whether paused time is intended to count against the five minutes (H-2). Nothing in FR-15, FR-34
  or addendum §C speaks to it.
- Whether the bluff exploit (C-3) is considered acceptable. The league is 31 people who know each
  other and the social cost may be judged sufficient deterrent — but that is a probability argument
  of exactly the kind §12 line 1201 records the commissioner as having *rejected* when the roster
  acts were put to him, so it should at least be asked rather than assumed.
