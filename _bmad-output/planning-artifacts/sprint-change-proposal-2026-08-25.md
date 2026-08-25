# Sprint Change Proposal — AD-22 does not name the League Clock's origin

- **Date:** 2026-08-25
- **Raised by:** Meakel (Commissioner / builder)
- **Trigger:** `_bmad-output/implementation-artifacts/deferred-work.md:168-170`, logged by
  `spec-1-11-open-the-auction.md` during bmad-build planning
- **Workflow:** bmad-correct-course, batch mode
- **Scope classification:** **Minor** — documentation amendment only. No code change, no
  story change, no schema change, no test change.

---

## 1. Issue Summary

**Problem statement.** AD-22 fixes the League Clock's reset set at exactly two event types —
a Nomination and an accepted Bid — and closes with a default rule: *"New event types default to
not resetting it; extending the set requires changing this AD."* It says nothing about where the
clock **starts**. But `epics.md:740` requires that on auction open "the League Clock starts at
48 hours", and PRD FR-3 (`prd.md:167`) says the same. Read literally and together, the two
documents contradict: the open must start the clock, and AD-22 says only two event types may
touch it.

**How it was discovered.** During Story 1.11 planning. The story implemented
`src/lib/core/projection/league-clock.ts`, which folds the clock's **origin** from
`AuctionOpened` while leaving the reset set at two. The distinction it drew — *an origin is not
a reset* — is sound, and the module's header comment argues it at length, but the authority for
that reasoning lives only in a source comment and a story spec. AD-22, which is the binding
document, does not carry it.

**Evidence.**

- `ARCHITECTURE-SPINE.md:211-216` — AD-22 as written; reset set of two, default-not-resetting
  rule, no mention of an origin.
- `epics.md:740` — Story 1.11 AC: "And the League Clock starts at 48 hours".
- `prd.md:167` — FR-3: "On open, all 30 Teams receive an unused Nomination Slot, the League
  Clock starts at 48 hours, and every Manager is notified."
- `src/lib/core/projection/league-clock.ts:11-17` — the shipped code's own defence of the
  distinction, written as a comment because there was no AD to cite.
- `tests/core/auction-open.test.ts:251` — `it('does not reset on any other event type — AD-22's
  reset set is not widened here')`, a test that already asserts the invariant the AD does not
  state.

**Why the distinction is real and not a dodge.** A reset can be unwound: `BidVoided` is a
compensating event that removes a bid's reset and the clock recomputes shorter (AD-22's second
bullet, FR-32, §10 example 27). The open can never be unwound — there is no `AuctionClosed`-the-
phase compensating event, and the phase reducer refuses a second `AuctionOpened`. Folding the
origin separately therefore preserves AD-22's invariant rather than widening it: no compensating
event can ever move the origin, so the "exactly two resets" arithmetic is untouched.

---

## 2. Impact Analysis

### Epic impact

| Epic | Impact |
| --- | --- |
| Epic 1 | **None to scope.** Story 1.11 is `done` and its implementation is already correct under the amended AD. No rework, no rollback. |
| Epic 2 (Nominate and bid) | **Clarifying only.** Stories 2.1 and 2.3 add the two *real* resets. The amendment makes explicit that they add to a set of two, on top of an origin already folded — which is what the code does today. |
| Epic 3 (Auction Clock and closes) | **Clarifying only.** The sweep is the first production reader of the League Clock; it will add `LEAGUE_CLOCK` to whichever is later, the origin or the latest surviving reset. The amendment names that arithmetic. |
| Epics 4–8 | None. |

No epic is added, removed, resequenced or redefined. No planned epic is invalidated.

### Story impact

- **Story 1.11 — done.** No change. The amendment ratifies what shipped.
- **No story added, modified or removed.** `sprint-status.yaml` needs no edit (checklist 6.4:
  N/A — no epic or story membership changed).

### Artifact conflicts

| Artifact | Conflict | Action |
| --- | --- | --- |
| `ARCHITECTURE-SPINE.md` AD-22 | **The conflict itself.** Silent on the origin. | **Amend** — Proposal A |
| `epics.md` AR-22 | Restates AD-22's reset set; inherits the same silence. | **Amend** — Proposal B |
| `prd.md` FR-22 | "reset to 48 hours by any Nomination or any valid Bid, and by nothing else" sits beside FR-3's "the League Clock starts at 48 hours" with nothing reconciling them. | **Amend** — Proposal C |
| `SPEC.md` CAP-9 | Same shape as FR-22; canonical contract, so the silence is load-bearing. | **Amend** — Proposal D |
| `prd.md` FR-3 | Already correct — it states the start. | No change |
| `prd.md` §10 examples | Example 13 turns on quiet time after the last nomination/bid; example 27 on a void. Neither reaches the origin. **No example's outcome changes** — AD-25's same-commit rule is not triggered. | No change |
| `traceability.md` | CAP-9 row already maps AD-22. Mapping unchanged. | No change |
| UX (`DESIGN.md`, `EXPERIENCE.md`) | The clock's derivation is not a UX concern; no surface renders the origin. | No change |
| `src/lib/core/projection/league-clock.ts` | Already implements the amended rule. Its comment can now cite the AD instead of arguing for it. | **Optional** — Proposal E |
| `tests/`, migrations, CI, deployment | None. No behaviour changes. | No change |

### Technical impact

**None.** No code path changes, no schema change, no migration, no test outcome changes.
`npm test` and `npm run check` results are unaffected by Proposals A–D. Proposal E is a comment
edit inside `core/` and touches no expression — but note AD-20: any commit touching `core/`
during a live Auction Phase requires a pause. The auction is not live, so this is free today;
it would not be in October.

---

## 3. Recommended Approach

**Option 1 — Direct Adjustment. Selected.**
Effort: **Low**. Risk: **Low**.

Amend AD-22 in place with a third bullet naming `AuctionOpened` as the clock's **origin**, and
propagate the same sentence to the three documents that restate the reset set. This is the
narrowest change that makes the shipped code defensible from the rulebook rather than from a
source comment.

**Option 2 — Potential Rollback. Not viable.**
Rolling back Story 1.11 would remove a correct implementation to fix a documentation gap. The
reducer is right; the AD is incomplete. Nothing is simplified by reverting.

**Option 3 — PRD MVP Review. Not viable, and not needed.**
The MVP is unaffected. FR-3 and FR-22 both stand as written in substance; only their
reconciliation is missing. No scope is reduced, deferred or redefined.

**Rationale.** The gap is real but small, and the cost of leaving it is deferred rather than
absent: the next agent to touch the League Clock reads AD-22, sees "exactly two, and new types
default to not resetting", and either (a) deletes the origin fold as an AD violation, or
(b) adds Story 2.1's nomination reset by widening the set the AD forbids widening. Both are
plausible misreadings of a document that is otherwise the project's strictest authority.
Writing one bullet now closes both.

---

## 4. Detailed Change Proposals

### Proposal A — `ARCHITECTURE-SPINE.md`, AD-22 (architecture)

Insert a new bullet between the existing **Rule** bullet and the existing **"The League Clock is
a fold, never a stored countdown"** bullet. Nothing existing is deleted.

**NEW (inserted):**

> - **An origin is not a reset** (added 2026-08-25, from Story 1.11). The clock's **origin** is
>   the `AuctionOpened` event's own `occurredAt` — there is no League Clock during Setup, and
>   FR-3 requires the open to start one at 48 hours. This does **not** widen the reset set to
>   three: a reset can be unwound by a compensating `BidVoided`, whereas the open can never be
>   unwound, so the origin is folded separately and no compensating event can move it. The
>   expiry is therefore `LEAGUE_CLOCK` after the **later** of the origin and the latest surviving
>   reset — which, before the first Nomination, is the origin alone. The default-not-resetting
>   rule above is unchanged and still governs every event type that is not one of the two.

**Rationale.** Gives the shipped fold a written authority, and closes the literal contradiction
with `epics.md:740` and FR-3 without loosening the invariant the AD exists to protect.

---

### Proposal B — `epics.md`, AR-22 (architectural requirements)

**OLD (`epics.md:139`):**

> - **AR-22 — The League Clock is a fold with exactly two reset event types (AD-22).** Reset by a
>   Nomination and an accepted Bid (lottery join included) and nothing else; new event types
>   default to not resetting it. Derived as 48 hours from the latest surviving reset event, so a
>   `BidVoided` compensating event removes that reset and the clock recomputes shorter —
>   prospectively only. The fold must treat a voided Bid as a non-reset rather than expecting the
>   original event to be gone.

**NEW:**

> - **AR-22 — The League Clock is a fold with one origin and exactly two reset event types
>   (AD-22).** Its **origin** is `AuctionOpened` — an origin, not a third reset, because the open
>   can never be unwound. Reset by a Nomination and an accepted Bid (lottery join included) and
>   nothing else; new event types default to not resetting it. Derived as 48 hours from the later
>   of the origin and the latest surviving reset event, so a `BidVoided` compensating event
>   removes that reset and the clock recomputes shorter — prospectively only, and never back past
>   the origin. The fold must treat a voided Bid as a non-reset rather than expecting the original
>   event to be gone.

**Rationale.** AR-22 is what a story author reads; it must not restate the incomplete version.
The "never back past the origin" clause also settles a real edge: a void of the only bid in a
just-opened auction recomputes to the origin, not to nothing.

---

### Proposal C — `prd.md`, FR-22 consequences (requirements)

**OLD (`prd.md:444`):**

> - The League Clock is reset to 48 hours by any Nomination or any valid Bid, and by nothing else.

**NEW (one line replaced, one line added beneath it):**

> - The League Clock **starts** at 48 hours when the auction opens (FR-3) and is **reset** to
>   48 hours by any Nomination or any valid Bid, and by nothing else.
> - Starting and resetting are distinct: a Bid voided under FR-32 removes that Bid's reset, but
>   nothing removes the start, so the Clock never recomputes to earlier than 48 hours after the
>   auction opened.

**Rationale.** Reconciles FR-22 with FR-3 in the document where both live. Changes no outcome —
FR-3 already required the start; FR-22 simply never acknowledged it.

**AD-25 check:** no §10 example outcome changes, so this does not trigger the same-commit rule.
Examples 13 and 27 both run well after open and turn on resets only.

---

### Proposal D — `SPEC.md`, CAP-9 success criteria (canonical contract)

**OLD (`SPEC.md:69`, opening clause):**

> The League Clock is reset by a Nomination and by an accepted Bid (including a lottery join) and
> by nothing else — not by an Auction Close, draw, dissolution, void, override, or pause/resume;

**NEW:**

> The League Clock starts when the auction opens and is reset by a Nomination and by an accepted
> Bid (including a lottery join) and by nothing else — not by an Auction Close, draw, dissolution,
> void, override, or pause/resume; the start is not a reset, and no void recomputes the Clock back
> past it;

The remainder of the CAP-9 success sentence is unchanged.

**Rationale.** SPEC is the canonical contract and its companions list includes the spine; leaving
CAP-9 stating the narrow version would put the contract at odds with its own companion.

---

### Proposal E — `src/lib/core/projection/league-clock.ts` (code comment, optional)

**OLD (lines 11-13):**

> `* **An origin is not a reset.** AD-22 fixes the League Clock's reset set at`
> `* exactly two event types and says a new type defaults to not resetting; this`
> `* reducer does not widen that set and deliberately has no case for either.`

**NEW:**

> `* **An origin is not a reset.** AD-22 names AuctionOpened as the League Clock's`
> `* origin and fixes the reset set at exactly two event types; this reducer does`
> `* not widen that set and deliberately has no case for either.`

**Rationale.** Once the AD says it, the comment should cite it rather than argue it. Purely
cosmetic — recommended but severable, and the only proposal that touches `core/` (AD-20;
harmless while the auction is not live).

---

## 5. Implementation Handoff

**Scope: Minor.** Route to the **Developer agent** for direct implementation.

**Deliverables:**

1. Apply Proposals A–D to the four planning artifacts.
2. Apply Proposal E if approved.
3. Append a `resolved:` annotation beneath the `deferred-work.md:168-170` entry, per the
   append-only convention — do **not** edit or delete the original entry.
4. Commit on a branch, PR to `main` (never commit to `main` directly).

**Success criteria:**

- AD-22 names `AuctionOpened` as the origin and still fixes the reset set at two.
- AR-22, FR-22 and CAP-9 all state the origin and none of them describes it as a reset.
- `npm test` and `npm run check` still pass unchanged (183 tests, 0 svelte-check errors as of
  the 1.11 baseline — reconfirm rather than assume).
- The `deferred-work.md` entry carries a dated `resolved:` line and its original text is intact.

**Not in scope for this correction:** the other four Story 1.11 deferred entries (the missing
open notification, the unbuilt empty Bid Board, the League Clock's absent production consumer,
the `.svelte` render-verification gap, the unbounded log read). Each is separately logged and
assigned to a later story.

---

## Checklist Record

| § | Item | Status |
| --- | --- | --- |
| 1.1 | Triggering story identified — Story 1.11 | Done |
| 1.2 | Problem categorised — misunderstanding/incompleteness of original requirement | Done |
| 1.3 | Evidence gathered — 5 cited locations | Done |
| 2.1 | Epic 1 completable as planned | Done — yes, unaffected |
| 2.2 | Epic-level changes required | N/A — none |
| 2.3 | Remaining epics reviewed | Done — Epics 2 and 3 clarified, not changed |
| 2.4 | Epics invalidated or newly needed | N/A — none |
| 2.5 | Epic order or priority | N/A — unchanged |
| 3.1 | PRD conflicts | Done — FR-22 amended (Proposal C) |
| 3.2 | Architecture conflicts | Done — AD-22 amended (Proposal A) |
| 3.3 | UI/UX conflicts | N/A — no surface renders the clock's origin |
| 3.4 | Other artifacts | Done — SPEC CAP-9 (D), epics AR-22 (B), one source comment (E) |
| 4.1 | Option 1 Direct Adjustment | Viable — selected. Effort Low, Risk Low |
| 4.2 | Option 2 Rollback | Not viable — would revert correct code |
| 4.3 | Option 3 MVP Review | Not viable — MVP unaffected |
| 4.4 | Path selected | Done — Option 1 |
| 5.1–5.5 | Proposal components | Done — §§1–5 above |
| 6.4 | `sprint-status.yaml` update | N/A — no epic or story membership changed |
