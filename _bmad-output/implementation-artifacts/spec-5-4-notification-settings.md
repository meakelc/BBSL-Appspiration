---
title: 'Story 5.4: Notification settings — the mutable category, and only one'
type: 'feature'
created: '2026-09-04'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'f65150d4a7ccba6081907afe475570a74ba6b8c4'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Every mention 5.3 files fires unconditionally. A Manager has no way to turn down the one notice that is genuinely optional — that a close released a Nomination Slot they were holding — and the destination catalog already advertises a "Notification settings" page (`destinations.ts:81`) that resolves to nothing.

**Approach:** Persist one per-Manager mute, carry it on the directory the drain already reads once per pass, and withhold the `<@id>` at composition time so the post is untouched. Build the `/notifications` page the catalog already points at, and refuse a mute of any other category server-side rather than merely omitting its control.

## Boundaries & Constraints

**Always:**
- **Muting suppresses the mention, never the post.** The broadcast notice still posts, still names the Team, and still states what happened. Only the `<@id>` is withheld.
- **Exactly one mutable category: `slot_release`** — the `no longer hold this Nomination Slot.` clause (`mention.ts:65`). FR-27 names three; see **Never** for why one is all that has a trigger.
- `allowed_mentions.users` must stay exactly the set of snowflakes the body spells. `addressees` (`mention.ts:102-110`) already guarantees this from what was rendered — suppression must flow through it, never around it.
- The unmutable categories are unmutable **server-side**. A posted request naming one is refused with stated wording, not silently ignored and not merely absent from the UI.
- Where no control exists, the **reason** is legible on the page: muting an outbid notice would undermine the fairness premise of a 24/7 clock.
- Single column at 375px and one-hand operable. Each control states in words what muting will and will not do, rather than presenting a bare toggle.
- Voice unchanged: no exclamation mark, no urgency framing, no suggested action, on the page as in the Discord copy.
- `outbox.ts`, `mention.ts`, `broadcast.ts` and anything they import stay Deno-loadable (AD-2): relative `.ts` only, no `$lib`, no `$env`, no node builtin.
- A Manager with no preference row reads as **not muted**. Absence is the default, not an error.

**Ask First:**
- Any change to `src/lib/core/**` beyond adding the new pure category module.
- Any change to the `notification_outbox` schema, its `(event_seq, channel, recipient)` key, or the tick's sweep → clock → drain order.
- Writing a Manager-settable column onto `public.managers`, which is documented as Commissioner-written only (`20260821000000_managers.sql:45-46`).

**Never:**
- **No second and third mutable category.** FR-27 names three. The unbid-Nomination 24-hour warning was **removed from scope by user decision (2026-09-04, reaffirmed for this story)** — it is unnecessary, not deferred, so no `deferred-work.md` entry records it. "Closes for Auctions their Team did not lead or contend in" has **no population of its own**: `affectedTeamsForClose` (`close.ts:195-219`) addresses only the leader and the nominator, so a Team that neither led nor contended is never mentioned on a close at all, and the category reduces to a strict subset of `slot_release`. Reviewers should read both absences as intended.
- **No suppression at enqueue time.** The intent is still filed and still recorded as dispatched; only the ping is absent. This is deliberate — see Design Notes.
- No change to `AffectedTeamsFn` and no change to any write site (`bidding.ts`, `close.ts`, `phase-end.ts`). The auction write path is not touched by a settings story.
- No new mention trigger, no change to any existing clause's wording, no per-category batching or regrouping.
- No Commissioner view of who has muted what, no audit event for a preference change, no notification history surface.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Default state | A Manager with no preference row | Not muted; the page renders the control off | N/A |
| Mute the one category | The Manager submits `slot_release` muted | Row upserted; the next slot-release close posts the notice with no `<@id>` for them | N/A |
| The post survives the mute | A muted Manager's Slot is released | The broadcast notice posts in full, naming the Team; `allowed_mentions.users` omits that snowflake | N/A |
| Co-managed, one muted | Two Managers of the nominating Team, one muted | One `<@id>` on the line, not two; the other still pinged | N/A |
| Co-managed, both muted | Both Managers of the nominating Team muted | No mention line for that Team; the broadcast notice still posts alone | N/A |
| A mute never touches an unmutable notice | The same muted Manager is outbid | Mentioned as normal — the mute is per category, not per Manager | N/A |
| The nominator also led | Nominator and winner are the same Team | Clause is `led at close`, which is unmutable; the mute does not apply | N/A |
| A direct request to mute an unmutable category | Form posts `outbid` or `contract_assignment` | `fail(400)` with stated refusal wording; nothing is written | Refused server-side |
| An unknown category id | Form posts a category no module names | `fail(400)` with the same refusal shape; nothing is written | Refused server-side |
| The page outside the Auction phase | Destination not live for this viewer | 403 through `requireLiveDestination`, before any read | `LIVE_DESTINATION_REFUSAL` |
| Every recipient in a batch is muted | One event, all mentions withheld | `recipients` empties; the batch posts as broadcast only | Never throws; the pass completes |

</frozen-after-approval>

## Code Map

- `src/lib/adapters/discord/mention.ts` -- **the suppression point.** `composed` (:245-289) maps snowflakes to Teams via `teamOf` (:158-163) and picks copy via `clauseFor` (:142-156), which already branches leader-vs-nominator off the payload's `teamId` (:148) — so the category is known here without any write-site change. Filter `discordUserIds` (:250-251) **before** the grouping loop (:263-273). `addressees` (:102-110) narrows `allowed_mentions` to what was rendered and needs no change. `SLOT_RELEASED_CLAUSE` (:65) is the mutable one; `OUTBID_CLAUSE` (:63), `LED_AT_CLOSE_CLAUSE` (:64), `CONTENDER_CLAUSE` (:66) and `CONTRACT_ASSIGNMENT_CLAUSE` (:75, special-cased flat at :254-257) are not.
- `src/lib/adapters/discord/broadcast.ts` -- `LeagueDirectory` (:103-139) is the type to widen with the mute set. Its `managerIdsByDiscordUserId` doc (:116-129) states the rule to follow: one read, one snapshot per pass, so one message cannot carry two spellings of the league.
- `src/lib/server/outbox.ts` -- `MANAGER_NAMES_SQL` (:749-750) already selects `id, display_name, team_id, discord_user_id`; add the left-joined mute. `toLeagueDirectory` (:962) is the fold, called at (:908-911) inside the read transaction, only when `due.length > 0`. `MANAGERS_OF_TEAM_SQL` (:255-260) and `enqueueMentions` (:355-395) are **read-only for this story** — suppression is not here.
- `src/lib/server/destinations.ts` -- `destination('notification-settings', 'Notification settings', '/notifications', false)` at :81, present in the `Auction` phase array only (:74-84). `requireLiveDestination` (:136-144), `LIVE_DESTINATION_REFUSAL` (:124), status 403 (:127). **The entry exists; the route does not.**
- `src/routes/minor-league-eligibility/+page.server.ts` -- the form precedent: guard in `load` (:61-62), guards re-run inside the action (:75-78), manual `formData` validation (:54-58, :81-83), `fail(400, { notice: eligibilityRefusalDetail(...) })` (:90), accepted copy (:128). `+page.svelte` renders the notice through `$derived` (:34-38) into a `role="status"` region (:203-206).
- `src/lib/core/rules/eligibility.ts` -- the refusal-wording precedent: the union type (:155-160), the wording function (:176-186), and the house voice stated verbatim (:165-167) — "state the fact, then the arithmetic. No apology, no exclamation mark, no advice."
- `supabase/migrations/20260903000000_notification_outbox.sql` -- migration conventions to copy: `comment on table/column` citing the AD and story (:87-91), RLS enabled **and** forced with no policy (:112-118), `revoke all` from `anon`/`authenticated` then the minimum grant back to `service_role` (:125-132), constraint naming `<table>_<column>_<rule>` (:79-84).
- `supabase/migrations/20260902000000_watermark.sql:87,113-114` -- **the schema's only prior update-in-place**, and it says so: "the one place in this schema that departs from the pattern every other table follows". A preferences table is the second; `roster-import.ts:321` and `pool-import.ts:245` are the existing `on conflict ... do update` precedents.
- `src/lib/styles/tokens.css` -- `--control-height: 46px`, `--touch-min: 44px` (:99-105); spacing (:90-94); colors (:22-57). `src/lib/styles/global.css` -- `.panel` (:150-158), `.prose` (:168-172), `.section-label` (:161-166); the single breakpoint is `@media (min-width: 640px)` (:144), so single-column is already the base.
- `tests/routes/minor-league-eligibility.test.ts:1-59` -- the route-test shape: real guards unmocked, only I/O modules mocked (:30-49), dynamic import of the route (:51), drive `load` and `actions` directly, assert `isHttpError` for refusals. `tests/routes/positions.test.ts:40-45` -- the source-text assertion that a `.svelte` file imports no `$lib/server`.
- `tests/adapters/discord-mention.test.ts` -- 5.3's matrix suite and its `DIRECTORY` fixture, to extend with the mute set.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/notification-categories.ts` -- new, pure. Name every mention category, state which single one is mutable, and supply the refusal wording for a request to mute any other, following `core/rules/eligibility.ts`'s union-plus-wording shape. Relative `.ts` imports only; nothing here does I/O.
- [x] `supabase/migrations/<ts>_manager_notification_preferences.sql` -- new table keyed on `manager_id`, one mute column defaulting to not-muted, RLS enabled and forced with no policy, grants revoked from client roles and only what `service_role` needs granted back. Comment the table with why it is update-in-place where the rest of the schema is not, citing the watermark as the precedent.
- [x] `src/lib/adapters/discord/broadcast.ts` -- widen `LeagueDirectory` with the muted-Manager set, documented like `managerIdsByDiscordUserId`: one read, one snapshot per pass.
- [x] `src/lib/server/outbox.ts` -- left-join the preferences table into `MANAGER_NAMES_SQL` so an absent row reads as not muted, and fold the set in `toLeagueDirectory`. No other change; `enqueueMentions` is untouched.
- [x] `src/lib/adapters/discord/mention.ts` -- withhold a muted Manager's snowflake in `composed` before grouping, per category, so a Team whose every addressee is muted emits no line. State in the header that suppression is composition's and that `allowed_mentions` follows from `addressees` unchanged.
- [x] `src/lib/server/notification-preferences.ts` -- read one Manager's preference and upsert it. SvelteKit-side only; the Deno path reads the same rows through `outbox.ts`'s SQL and must not import this.
- [x] `src/routes/notifications/+page.server.ts` -- `load` and one action, both gated by `requireLiveDestination` on the existing `notification-settings` destination. Validate the posted category against the core module and `fail(400)` with its wording for anything not mutable, writing nothing.
- [x] `src/routes/notifications/+page.svelte` -- single-column at 375px on the existing `.panel`/`.prose` vocabulary. The one control states in words what muting does and does not do; the unmutable categories are listed with the reason no control exists, not hidden.
- [x] `tests/adapters/discord-mention.test.ts` -- every composition row of the matrix: one of two co-Managers muted, both muted, the mute not touching an outbid, the nominator who also led, and `allowed_mentions` matching the body in each.
- [x] `tests/routes/notifications.test.ts` -- new. The 403 before any read, the accepted mute, the server-side refusal for each unmutable category and for an unknown id, and that the `.svelte` file imports no `$lib/server`.
- [x] `tests/server/outbox.test.ts` -- the directory fold carries the mute, and an absent preference row reads as not muted.

**Acceptance Criteria:**
- Given a muted Manager and a close releasing their Slot, when the pass posts, then the notice appears in the channel in full and neither the body nor `allowed_mentions.users` names them.
- Given a request that names an unmutable category, when it is posted directly to the action, then it is refused with stated wording and no row is written — asserted without going through the page.
- Given the settings page, when a Manager loads it during the Auction phase, then exactly one mutable control renders, and the unmutable categories are stated with the reason they carry no control.
- Given the whole story, when `npm test`, `npm run check` and `npx deno check --config supabase/functions/tick/deno.json supabase/functions/tick/index.ts` are run, then all three pass.

## Spec Change Log

## Design Notes

**Why suppression sits at composition and not at enqueue.** 5.3's principle is that the affected Team is decided at write time by the code that knows it, which argues for filtering in `enqueueMentions`. It is the wrong call here. The enqueue receives a flat `readonly string[]` of Team ids (`outbox.ts:312`) with no role attached, so filtering there means widening `AffectedTeamsFn` and editing all three write sites — putting a settings story on the critical auction write path, inside the transaction where "a `TypeError` here would roll back an otherwise valid close over a notice" (`close.ts:205-210`). Composition already knows the category: `clauseFor` derives leader-vs-nominator from the payload (`mention.ts:148`), and `addressees` already narrows `allowed_mentions` to what was actually rendered. The mute costs one left join on a read that happens once per pass and nothing at all on the write path.

**What the muted intent still records.** The row is filed and dispatched either way, so NFR11's measurement can distinguish *muted* from *failed* — which enqueue-time suppression, leaving no row, could not. SM-3 counts Managers who asked to be notified.

**Why a new table rather than a column on `managers`.** `public.managers` is documented as "Written by the Commissioner only" (`20260821000000_managers.sql:45-46`), and this is the first thing a Manager writes about themselves. A separate table keeps that ownership statement true, and the left join makes an absent row mean not-muted without a backfill.

**Golden example** (the nominating Team is co-managed; `<@790>` has muted):

```
Jrue Holiday to Heat — Dana for $3.0M.
<@789> — Suns — Kai no longer hold this Nomination Slot. https://bbsl.example/auction/5678
```

## Verification

**Commands:**
- `npm test` -- expected: all pass, including 5.1's mechanism suites, 5.2's broadcast suites and 5.3's mention suites unchanged.
- `npm run check` -- expected: no type errors.
- `npx deno check --config supabase/functions/tick/deno.json supabase/functions/tick/index.ts` -- expected: clean; the widened directory is reachable from the tick and pulls in no `$lib` or `$env`.

**Manual checks:**
- Read the composed body for a co-managed nominating Team with one Manager muted and confirm one `<@id>`, and that the notice sentence is unchanged from the unmuted case.
- View `/notifications` at 375px and confirm one column, every control at or above the 44px touch minimum, and no exclamation mark anywhere on the page.
- `git status --short` before review — confirm no new file is left untracked, so the whole diff reaches the reviewers.

## Suggested Review Order

**What a mute is, and whose fact it is**

- One mutable category, named once; everything else derives from this constant.
  [`notification-categories.ts:60`](../../src/lib/core/notification-categories.ts#L60)

- The reader is the subject, not their Team — the co-managed case makes Team wording false.
  [`notification-categories.ts:182`](../../src/lib/core/notification-categories.ts#L182)

- Unmutable is a type, not a convention, so the empty-reason sentence is unconstructible.
  [`notification-categories.ts:76`](../../src/lib/core/notification-categories.ts#L76)

**Where the mention is withheld**

- Category per addressed Team, off the payload — no write site had to change.
  [`mention.ts:175`](../../src/lib/adapters/discord/mention.ts#L175)

- Total and fail-open: an unresolvable snowflake reads as not muted, never as silence.
  [`mention.ts:217`](../../src/lib/adapters/discord/mention.ts#L217)

- Filtered before grouping, so a wholly-muted Team emits no line at all.
  [`mention.ts:246`](../../src/lib/adapters/discord/mention.ts#L246)

- `allowed_mentions` still narrows to what the body spells — unchanged by construction.
  [`mention.ts:300`](../../src/lib/adapters/discord/mention.ts#L300)

**How the preference reaches the drain**

- Left-joined onto the registry read, so absence means not-muted with no backfill.
  [`outbox.ts:761`](../../src/lib/server/outbox.ts#L761)

- Folded into the one per-pass snapshot; a mute landing mid-pass lands on the next.
  [`outbox.ts:1006`](../../src/lib/server/outbox.ts#L1006)

- One driver-tolerant flag reader, exported so the SvelteKit side cannot drift from it.
  [`outbox.ts:1052`](../../src/lib/server/outbox.ts#L1052)

- The directory's new edge, carried beside the snowflake map it is read with.
  [`broadcast.ts:164`](../../src/lib/adapters/discord/broadcast.ts#L164)

**The surface, and the refusal that is not in the UI**

- The unmutable refusal, server-side — the AC that is asserted off-page.
  [`+page.server.ts:110`](../../src/routes/notifications/+page.server.ts#L110)

- The destination gate runs on the action too, before anything is read or written.
  [`+page.server.ts:91`](../../src/routes/notifications/+page.server.ts#L91)

- Unmuting stores a value rather than deleting a row; last writer wins.
  [`notification-preferences.ts:66`](../../src/lib/server/notification-preferences.ts#L66)

- The absent controls are rendered with their reasons, not omitted.
  [`+page.svelte:126`](../../src/routes/notifications/+page.svelte#L126)

**Schema**

- One column, defaulted false, cascading with the Manager it describes.
  [`manager_notification_preferences.sql:50`](../../supabase/migrations/20260904000000_manager_notification_preferences.sql#L50)

- `service_role` alone, and no delete — the grant is the real control.
  [`manager_notification_preferences.sql:95`](../../supabase/migrations/20260904000000_manager_notification_preferences.sql#L95)

**Peripherals**

- The co-managed row the review turned up: one `<@id>` survives, the notice is whole.
  [`outbox.test.ts:1680`](../../tests/server/outbox.test.ts#L1680)

- Guards the copy against regressing to Team wording, and against an exclamation mark.
  [`notification-categories.test.ts:1`](../../tests/core/notification-categories.test.ts#L1)

- The real SQL, previously reached only through a mock.
  [`notification-preferences.test.ts:1`](../../tests/server/notification-preferences.test.ts#L1)
