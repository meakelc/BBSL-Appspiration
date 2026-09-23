# Addendum — BBSL Offseason Free Agent Auction

Companion to `prd.md`. Holds depth that belongs to downstream documents — architecture, solution design, UX spec — rather than to the PRD's requirements narrative. Nothing here is a requirement; it is context, rationale, and mechanism for whoever picks up `bmad-architecture` and `bmad-ux` next.

---

## A. Fantrax integration — research findings and rejected alternatives

### What actually exists

Fantrax publishes no official, documented, public API. What the ecosystem has:

| Surface | Nature | Notes |
|---|---|---|
| `fantrax.com/developer` | Gated page | Fantrax has supplied beta API documentation to individual developers on request — the Go wrapper cites docs Fantrax provided in April 2025. Worth requesting for v2. |
| `FantraxAPI` (Python, meisnate12) | Community wrapper | Built and tested against an NHL H2H points league; coverage for other sports/league types is unverified. |
| `go-fantrax` (Go, pmurley) | Community wrapper | Cleanest documented picture of the endpoint surface. |

Endpoint surface observed via `go-fantrax`: `getPlayerIds`, `getAdp`, `getLeagues`, `getLeagueInfo`, `getDraftPicks`, `getTeamRosters`, `getStandings`.

**Re-verified 2026-09-10** when the commissioner asked whether the API could carry trades. `fantrax.com/developer` still returns **403** to an unauthenticated request; it remains a gated page. Both community wrappers were re-read, and the August findings hold unchanged — with one shape now pinned that matters:

`getTeamRosters` (`GET /fxea/general/getTeamRosters?leagueId=<id>&period=<n>`) returns, per `go-fantrax` v0.1.18:

```
LeagueRosters { Period, Rosters: map[teamId]TeamRosterInfo }
  TeamRosterInfo { TeamName, RosterItems: []RosterItem }
    RosterItem { ID, Position, Status }
```

**That struct is wrong**, and the correction matters more than the original note. **Called against the real BBSL league on 2026-09-10**, unauthenticated, the endpoint returned all 30 Teams and 303 roster rows shaped like this:

```json
{"contract":{"smallId":"5","name":"2027"}, "id":"01eon",
 "position":"F", "salary":2.25E7, "status":"ACTIVE"}
```

plus `teamName`, a Fantrax team id, and `salaryCap: 165000000.0` per Team. **Salary, contract designation and slot kind are all present.** `go-fantrax` models three fields of a payload that carries six; finding 1 above — *"salaries and contracts are absent from the documented read surface"* — is **false for this endpoint**, and was believed on the strength of a community wrapper rather than a live call. The lesson is the plainer one: a wrapper's struct is evidence about the wrapper, not about the API.

**Finding 2 stands unchanged.** Every method exposed by either wrapper is still a GET; there is no write path to reverse-engineer, not merely no documented one.

**Three integration hazards found in the live payload**, none of which the wrapper documentation would have revealed:

1. **Money is float, and truncation corrupts it.** Salaries arrive as scientific-notation floats carrying representation error — `23499999.999999993`, `46499999.999999985`, `28499999.999999993`. `int()` puts 4 of 303 rows a dollar low and **off the $500,000 grid**; `round()` was clean on all 303. Anything reading this endpoint rounds, then asserts the grid. **The CSV is the safer source for setup** precisely because it carries exact integers (`25,000,000`) with no float in the path.
2. **Player ids are unwrapped here** (`01eon`) and asterisk-wrapped in the CSV export (`*04ewu*`), which the importer stores verbatim. Compared unnormalised, every row reads simultaneously as a departure and an unknown arrival.
3. **`status` carries all four slot kinds** — `ACTIVE`, `RESERVE`, `MINORS`, `INJURED_RESERVE` — but the underscore form does not match the CSV importer's `injured reserve` alias. Two mappings, not one.

**One fact confirmed against live data:** `2RK31` appears exactly 30 times, one per Team — this year's second-round class — confirming the five-year second-round term. The first-round ladder runs `1RK27`–`1RK30` with no `1RK31`, so **first-round scale is four years, not five**; nobody should generalise the five-year term to `1RK`. *(Amended 2026-09-16. This originally also validated the *"full term unelapsed"* test that FR-43's rookie-scale drop exception relied on. **That exception is removed** — the league waives Dead Money only in the amnesty period before the auction opens, so no rule tests the term any more. The rookie-scale designation still survives the import and still decides nothing; the term figures above stand on their own.)*

**Three findings drove the v1 decision:**

1. **Salaries and contracts are absent from the documented read surface.** `go-fantrax` states plainly that player salaries/contracts are not included. That is the single most load-bearing data the app needs, so an API-read path would still require a CSV for the important half.
2. **There is no documented write path.** Roster edits and transactions appear only behind an undocumented `auth_client` using session cookies. Pushing 60 contracts into the league of record through an unsupported, reverse-engineered, cookie-authenticated endpoint is the highest-consequence failure mode available to this project.
3. **Auth is a `userSecretId`** taken from a Fantrax user profile — an API-key-shaped shared secret, not OAuth. Fine for a commissioner-operated tool; still a credential to hold.

### What the August assessment got wrong

Finding 1 concluded that a read surface without salaries is useless, because salary is "the single most load-bearing data the app needs." That is correct **for setup**, and it is why FR-1 remains a CSV import. It was then applied too broadly, to a job that had not yet been asked about.

For **reconciliation** the arithmetic reverses. A trade does not change a Contract — it changes who holds it. The app already holds every Contract's Cap Hit, years and Slot kind from the FR-1 import, and under FR-41 those travel with the Player unchanged. So the only fact the app is missing is **which Team holds whom**, and that is precisely the one fact `getTeamRosters` returns.

The endpoint is worthless for establishing state and sufficient for detecting that state has drifted. Those are different jobs, and the August note evaluated it against only the first.

The consequence is FR-42, and it is deliberately shaped so the dependency can never do harm: the read proposes and never writes, it runs hourly rather than per tick, its failure degrades to FR-41 alone, and repeated failure is **stated on the Commissioner's surface** rather than rendering as a clean bill of health. A detector that has silently stopped is worse than no detector, because it displaces the manual check it was meant to support.

### Why the league can't just use Fantrax's built-in features

Worth recording, because "why are we building this at all" will be asked:

- **Fantrax blind bidding** is FAAB-style: a fixed budget, sealed bids, processed in fixed nightly windows. No ascending prices, no rolling clock, no nomination gating.
- **Fantrax slow auction** is a *draft* mode — a startup/rookie draft construct, not an offseason free-agency mechanism, and it has no concept of a per-team nomination slot that releases on close, nor of a minimum-salary lottery.

Neither can express: a 24h clock that resets per bid, a nomination right gated on your own prior nomination closing, a `$1M`-tie randomizer that dissolves on a `$1.5M` bid, or a cap-space calculation that reserves `$1M` per unfilled roster hole. That gap is the product.

### Rejected alternatives

| Option | Why rejected |
|---|---|
| Full automated two-way API sync | Undocumented write endpoints; could corrupt the league of record. Deferred to v2 pending official API access. |
| API read + CSV write | **Partly adopted 2026-09-10, for a different reason than this row assessed.** Rejected for *setup*, which still needs the CSV — the read surface omits salary. Adopted for *reconciliation* (FR-42), where membership alone suffices because the app already holds the money. The "breaks silently between offseasons" objection stands and is answered by FR-42 failing loudly rather than by the dependency being safe. |
| Scraping the Fantrax web UI | Same fragility as undocumented endpoints, plus ToS exposure, plus no better data. |
| Running the auction inside Fantrax with manual adjudication | The status quo. It is what the app exists to replace. |

**v2 trigger:** if Fantrax grants documented API access on request (as they evidently have to other developers), revisit — starting with read-side population of the free agent pool, which is the highest-toil part of setup. **Note that the write half may not exist to be granted:** as of 2026-09-10 no write endpoint is documented, undocumented, or reverse-engineered by anyone in the ecosystem, so "Not writing to Fantrax" (PRD §6) should be read as a property of the integration and not only as a v1 scope choice.

---

## B. CSV contracts (shape to be pinned during architecture)

The PRD deliberately specifies *capabilities*, not columns. Concrete shapes must be derived from real Fantrax exports before FR-1/FR-2 are implementable.

**Import — rosters/salaries (per row):** Fantrax team ID, Fantrax player ID, player name, cap hit, roster slot kind (Active/Bench, IR, Minor League), contract years remaining.

**Import — free agent pool (per row):** Fantrax player ID, player name, position(s), NBA team.

> **Settled 2026-08-17 (OQ-2): the export does not carry a minor-league-eligible flag.** It is not a column to map — it is app-owned data the commissioner sets by hand before the auction opens (FR-38), defaulting to *not* eligible. The adapter must not invent it, derive it, or fail on its absence.

**Export — auction contracts (per row):** Fantrax team ID, Fantrax player ID, player name, winning amount, contract length in years, slot placement (Active/Bench or Minor League), resulting cap hit.

Note that **winning amount and cap hit are not the same column** — a minor-league placement resolves to a $0 cap hit while the winning amount stands as the contract value. Whether Fantrax's import wants one, the other, or both is an open item to settle against a real export.

**Design guidance:**
- Keep column mapping in exactly one module. Fantrax export shapes change between seasons; a single mapping layer makes the next offseason a config edit rather than a rewrite.
- Match on **Fantrax player ID**, never on name. Name matching across systems is where fantasy tools go to die (suffixes, accents, "Jr.", nickname variants).
- Validate on import and report the offending row, not just a failure. Setup day is high-stress and low-patience.

**Open action:** obtain a real BBSL export from Fantrax commissioner controls and confirm the salary and roster-slot columns. The minor-league flag no longer needs confirming — it is settled as absent (OQ-2) and handled by FR-38.

---

## C. Timer engine — implementation considerations

The PRD requires close-within-60-seconds-of-expiry, restart survival, and server-authoritative time (§5). Mechanism options for the architect:

- **Durable scheduled job per auction** (close time persisted, scheduler reconciles on startup). Most robust; requires a reconciliation sweep on boot to catch closes missed during downtime.
- **Polling sweep** (a job every N seconds asking "what's expired?"). Simpler, naturally restart-safe, trivially correct at this scale — 30 concurrent auctions is nothing. Probably the right answer here.
- **In-memory timers.** Rejected: they do not survive a deploy, and a missed close silently extends an auction, which is exactly the SM-1 failure.

**Clock display:** the server emits absolute close timestamps; the client renders countdowns from them. Never send "seconds remaining" and let the client decrement — clock skew and backgrounded mobile tabs both break it.

**Pause semantics (FR-34):** pausing must store *remaining duration*, not shift absolute close times, so a resume after an indeterminate outage is correct.

---

## D. Concurrency — the subtle correctness surface

Three races, all of which produce disputed outcomes if mishandled. *(A fourth was added on 2026-08-17 and **retired on 2026-09-18** with the rule it belonged to; it is kept below because what it warned about did not go away, it moved.)*

1. **Two bids on one auction.** Serialize per auction. Validate the bid against committed state inside the same transaction that accepts it — a check-then-write with a gap admits two winners.
2. **Two nominations of the same player.** Uniqueness must be enforced at the data layer, not by a prior read (FR-8).
3. **Cross-auction cap validation.** A team's Maximum Bid depends on its leading position in *other* auctions, which other teams are concurrently changing. A bid must be validated against the team's cap state as of commit, not as of page render (FR-13). This is the least obvious of the three and the most likely to ship broken.
4. **~~Minors Exposure recomputation (FR-35).~~ RETIRED 2026-09-18.** It read: a team's exposure is a function of the *set* of eligible auctions it leads and its free Minor League Slots, so being outbid on one eligible auction, or winning one, changes the legality of its bids on every other; exposure must be derived from committed state at validation time and never cached on the team record. **FR-35 is retired and Minors Exposure is permanently zero** — a Free Agent cannot be won into the minors, so every lead commits its full amount and no Free Minor League Slot absorbs anything. **The hazard survives the arithmetic that carried it, and race 3 is now the whole of it:** Committed Bids is still a function of the *set* of auctions a team leads, so being outbid on one still changes the legality of its bids on every other, and it must still be derived from committed state at validation time rather than cached. If anything the race is **wider**, because every lead feeds it now where an eligible one used to feed nothing. The asymmetry worth testing survives too, in its plainer form: **a smaller bid can be refused while a larger earlier one stands** — the app refuses the new bid and never retroactively voids an accepted one.

**Suggested framing:** model bids as append-only events and derive auction state and committed capital from them. It makes the audit log (FR-33) a byproduct rather than a parallel system to keep in sync, and it makes "void this bid and restore prior state" (FR-32) a well-defined operation rather than an ad-hoc unwind.

---

## E. Randomizer — auditability mechanism

FR-20 requires a draw any manager can independently reproduce. Mechanism guidance:

- Record the **seed**, the **ordered contender list as of expiry**, and the **selection** — all three, permanently, on the closed auction.
- The derivation from seed + list to winner must be a documented, deterministic procedure a manager can run by hand or in a spreadsheet. A seed nobody can apply is theatre.
- **Commit-reveal is the stronger option** if the league wants it: publish a hash of the seed when the lottery opens, reveal the seed at the draw. This removes the theoretical objection that the commissioner-operated server chose a convenient seed after seeing the contender list. Worth raising with the league — it is cheap to build and it is the difference between "trust the app" and "verify the app."

---

## F. Platform and surface notes for UX

- **Responsive web, mobile-first.** Not native. 375px is the design target; desktop earns density, never exclusive capability.
- **Three things must be legible without scrolling on a phone:** what closes soonest, where am I leading, what can I afford right now.
- **Maximum Bid is the app's signature number.** It should be persistently visible and always broken into its components (cap space − committed − reserve). A bare figure invites distrust; the arithmetic builds it.
- **Auction state must not be conveyed by color alone.** Standard Contention vs. Minimum-Bid Contention vs. closing-soon each need a label. The lottery state especially — a manager who does not realize the clock will not reset will misplay it.
- **Resist urgency design.** Countdown pressure, one-tap raises without confirmation, and suggested bid amounts would all raise engagement metrics and degrade the auction (see SM-C1). The app's posture is referee, not croupier.

---

## G. The retraction window — what the downstream documents must amend

*Added 2026-09-16 with FR-15. This section is a handoff, not a design: it names the amendments the retraction window forces in documents this workflow does not own, so that `bmad-architecture` and `bmad-spec` inherit the list rather than rediscovering it.*

### The restorer already fits, with one forbidden exception

`ARCHITECTURE-SPINE.md` AD-31 is titled *"one restorer, two callers, three parameters"* and parameterises `core/rules/restore.ts` over exactly the three axes on which a cancellation and a void disagree — `withdrawnBid` retain/erase, `auctionClock` leave/restore, `leagueClockReset` keep/remove. A retraction is a **third caller passing the void's existing triple**, `erase`/`restore`/`remove`, unchanged. No fourth axis and no new selector: the walk-down-and-skip already does what FR-15 needs.

**With exactly one exception, and it is forbidden rather than parameterised.** The Bid that *dissolves* a Minimum-Bid Contention under FR-19 discards the Contender list and releases every Contender's $1,000,000. Retracting it cannot use this selector at all, because the selector walks to the next-highest **surviving Bid** and a dissolved contention has none — only a discarded list of equal entries. Restoring that state would be a genuine **fourth restoration shape**. FR-15 therefore makes a converting Bid final on submission, so the shape is never needed. An implementation that finds itself reaching for a fourth axis has mis-read the requirement.

### AD-22 needs a sentence it does not currently have

AD-22 enumerates what **resets** the League Clock and says new event types default to **not** resetting it. FR-15 introduces a type that **removes** a reset, which AD-22 addresses only for `BidVoided` and only by name. The amendment must say that a retraction takes the void's treatment and not the cancellation's — the AD already warns that these two are "one line apart in any reducer" and that conflating them "will shorten the Auction Phase every time a roster fills." A retraction is now the third line in that neighbourhood and the most likely to be built wrong, because it resembles a cancellation socially (a Team's Bid goes away) and a void mechanically.

### AD-31's termination argument does not cover retraction, and must be extended rather than assumed

AD-31 bounds the cascade with *"cancellation is triggered only by a Close, and never by a restoration."* That argument is about re-entrancy inside one close and says nothing about a human-invoked withdrawal. FR-15's termination argument is different in kind: **every retraction is anchored to a Bid's own timestamp, and each step down the history is anchored to a strictly older Bid**, so a chain shortens by construction and cannot extend itself (PRD §10 example 52). Both arguments should stand in AD-31 side by side. Note also that FR-40's trigger bound is **unchanged** — a retraction calls the restorer without being a cancellation and without causing one.

**Relevant precedent, and why it does not apply.** On 2026-09-10 the commissioner rejected reusing the restorer for Roster Trades and Drops, on the recorded grounds that it would require amending AD-31's deliberately bounded trigger and would *"let an administrative act strip a Player from a Team that took no action."* Neither half transfers: a retraction **restores** rather than strips, and it is invoked by the bidding Team itself. That decision stands for FR-41/FR-43/FR-44 and is not disturbed.

### Documents that still assert the old FR-15, and are out of scope here

- **`SPEC.md` CAP-5** carries the prohibition almost verbatim — *"no control to cancel, edit, or lower an accepted Bid exists"* and *"A Bid once accepted cannot be withdrawn **by the Team that placed it**"* — plus the enumeration *"Two things outside the Team can end it."* All three statements need the matching amendment — and the enumeration's count is now three, not two. Owned by `bmad-spec`.
- **`epics.md`** line 257 summarises FR-15 as *"No **voluntary** bid retraction — the control is absent, not disabled · narrowed by Epic 10 (the system may cancel; the Team still may not)."* Owned by `bmad-create-epics-and-stories`.
- **`sprint-change-proposal-2026-09-07.md`** §5.1.4 also carries it. That is a dated historical input and correctly stays as written.

### The one rule here that must not be built as an implementation detail

A Bid placed within ninety seconds of the same Team's own retraction earns **no League Clock reset** (FR-15). It is not a rate limit and must not be built as one: it is the only thing standing between this feature and a Team holding the Auction Phase open indefinitely for free, since FR-18 resets the League Clock on every lottery join and the League Clock is the sole terminator. It belongs in `league-clock.ts`, beside the `BidVoided` case. PRD §10 example 54 is its test, and §10 example **55** is the one that pins the **anchor** — the ninety seconds run from the retraction, not from the retracted Bid, and 54 passes under either reading. *(Added 2026-09-16 by the architecture spine's binding pass, which found the anchor unstated. Anchored to the retracted Bid the stall returns: retract at `T+89s`, re-bid at `T+91s`, fresh reset every cycle.)*

### One note that genuinely is not a rule

The window is a **fold over the log and nothing else** — a comparison between a Bid's own timestamp, the injected server time, and the sequence of events touching the displaced Team since. There is no timer to schedule, no row to expire, and nothing for the close sweep to do, which is the reason this requirement is cheap despite reversing a load-bearing one. The read path may render a live countdown from the same derivation it uses to enable the control, and must not cache it.

---

## H. Deferred features — rationale kept for the v2 conversation

- **Web push / PWA notifications.** Was the best notification UX by a distance when the alternative was email. Largely moot since FR-27 moved to Discord `@mentions`: Discord's own push already delivers an instant, phone-native alert through an app every manager has installed, which is most of what web push would have bought. iOS PWA push remains disproportionate for v1. The failure mode now worth watching is not latency but *notification fatigue* — a mention lost in a busy channel.
- **Overnight clock freeze.** Rejected as a *rules change*, not as an engineering problem — the league runs 24/7 clocks by rule and changing that needs league buy-in, not a PM decision. Note that FR-34's pause machinery already implements most of the mechanism, so if the league votes for it later, the lift is small.
- **Proxy/max bidding.** Rejected outright rather than deferred. It interacts badly with the `$1M` lottery (what does a proxy bid do when the auction converts at `$1.5M`?), and it removes the social, readable quality of an open ascending auction.
- **Multi-tenancy / configurable rules.** Every league constant should be a named value in code so a future extraction is tractable, but no admin UI in v1. If other dynasty leagues ever want this, that is a product decision, not a refactor decision.
