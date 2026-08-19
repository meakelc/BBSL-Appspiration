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

**Three findings drove the v1 decision:**

1. **Salaries and contracts are absent from the documented read surface.** `go-fantrax` states plainly that player salaries/contracts are not included. That is the single most load-bearing data the app needs, so an API-read path would still require a CSV for the important half.
2. **There is no documented write path.** Roster edits and transactions appear only behind an undocumented `auth_client` using session cookies. Pushing 60 contracts into the league of record through an unsupported, reverse-engineered, cookie-authenticated endpoint is the highest-consequence failure mode available to this project.
3. **Auth is a `userSecretId`** taken from a Fantrax user profile — an API-key-shaped shared secret, not OAuth. Fine for a commissioner-operated tool; still a credential to hold.

### Why the league can't just use Fantrax's built-in features

Worth recording, because "why are we building this at all" will be asked:

- **Fantrax blind bidding** is FAAB-style: a fixed budget, sealed bids, processed in fixed nightly windows. No ascending prices, no rolling clock, no nomination gating.
- **Fantrax slow auction** is a *draft* mode — a startup/rookie draft construct, not an offseason free-agency mechanism, and it has no concept of a per-team nomination slot that releases on close, nor of a minimum-salary lottery.

Neither can express: a 24h clock that resets per bid, a nomination right gated on your own prior nomination closing, a `$1M`-tie randomizer that dissolves on a `$1.5M` bid, or a cap-space calculation that reserves `$1M` per unfilled roster hole. That gap is the product.

### Rejected alternatives

| Option | Why rejected |
|---|---|
| Full automated two-way API sync | Undocumented write endpoints; could corrupt the league of record. Deferred to v2 pending official API access. |
| API read + CSV write | The read surface omits salaries, so setup still needs a CSV. Buys convenience on the FA pool only, at the cost of a dependency that can break silently between offseasons. Reasonable v1.1. |
| Scraping the Fantrax web UI | Same fragility as undocumented endpoints, plus ToS exposure, plus no better data. |
| Running the auction inside Fantrax with manual adjudication | The status quo. It is what the app exists to replace. |

**v2 trigger:** if Fantrax grants documented API access on request (as they evidently have to other developers), revisit — starting with read-side population of the free agent pool, which is the highest-toil part of setup.

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

Three races, all of which produce disputed outcomes if mishandled:

1. **Two bids on one auction.** Serialize per auction. Validate the bid against committed state inside the same transaction that accepts it — a check-then-write with a gap admits two winners.
2. **Two nominations of the same player.** Uniqueness must be enforced at the data layer, not by a prior read (FR-8).
3. **Cross-auction cap validation.** A team's Maximum Bid depends on its leading position in *other* auctions, which other teams are concurrently changing. A bid must be validated against the team's cap state as of commit, not as of page render (FR-13). This is the least obvious of the three and the most likely to ship broken.
4. **Minors Exposure recomputation (FR-35).** The hardest of the four. A team's exposure is a function of the *set* of eligible auctions it leads and its free Minor League Slots, so being outbid on one eligible auction, or winning one, changes the legality of its bids on every other. Exposure must be derived from committed state at validation time, never cached on the team record. Note the asymmetry worth testing: exposure can make a *smaller* bid illegal while a larger earlier one stands — the app refuses the new bid and never retroactively voids an accepted one.

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

## G. Deferred features — rationale kept for the v2 conversation

- **Web push / PWA notifications.** Was the best notification UX by a distance when the alternative was email. Largely moot since FR-27 moved to Discord `@mentions`: Discord's own push already delivers an instant, phone-native alert through an app every manager has installed, which is most of what web push would have bought. iOS PWA push remains disproportionate for v1. The failure mode now worth watching is not latency but *notification fatigue* — a mention lost in a busy channel.
- **Overnight clock freeze.** Rejected as a *rules change*, not as an engineering problem — the league runs 24/7 clocks by rule and changing that needs league buy-in, not a PM decision. Note that FR-34's pause machinery already implements most of the mechanism, so if the league votes for it later, the lift is small.
- **Proxy/max bidding.** Rejected outright rather than deferred. It interacts badly with the `$1M` lottery (what does a proxy bid do when the auction converts at `$1.5M`?), and it removes the social, readable quality of an open ascending auction.
- **Multi-tenancy / configurable rules.** Every league constant should be a named value in code so a future extraction is tractable, but no admin UI in v1. If other dynasty leagues ever want this, that is a product decision, not a refactor decision.
