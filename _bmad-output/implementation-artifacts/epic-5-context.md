# Epic 5 Context: Nobody loses a player to inattention

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Make the rolling 24-hour clock a fair contest rather than a trap for whoever happens to be looking. Every auction event is posted to the league Discord channel as a permanent public record, and every Manager whose Team is affected by one is `@mention`ed in that same channel — which is what turns the public record into a personal push alert on a phone — within 60 seconds. The channel is the only outbound transport in the system; no email is sent for any purpose (AR-18/AD-18). The whole epic hangs off a transactional outbox so that Discord, a knowingly accepted single point of failure for both sign-in and alerting, can fail without the auction failing with it. This validates SM-3, a *primary* success metric with a target of 100%, and it covers FR-26 (broadcast) and FR-27 (mentions and muting).

## Stories

- Story 5.1: The transactional outbox and its dispatcher
- Story 5.2: Broadcast auction events to the league channel
- Story 5.3: Notify Managers by Discord mention
- Story 5.4: Notification settings — three mutable categories, and only three

## Requirements & Constraints

- **Delivery is decoupled from auction state.** A Discord delivery failure never blocks or reverses the underlying auction action. Failures are logged and surfaced to the **Commissioner**, never to Managers.
- **At most once per event, per recipient.** A retry may not produce a duplicate post or a duplicate mention.
- **Broadcast set:** Nominations, Bids, Auction Closes, Randomizer draws, Auction Phase start and Auction Phase end. A draw post carries the revealed seed and the ordered Contender list. Each post names Team, acting Manager, Player, amount, and the new close time where applicable.
- **Mention triggers (FR-27):** the Manager's Team is outbid; an Auction their Team leads or contends in closes; their Nomination Slot is released; their unbid Nomination hits 24 hours; the Contract Assignment Phase opens. Outbid mentions land **within 60 seconds** of the outbidding Bid.
- **Co-managed Teams get two mentions, individually.** A single post naming only the Team does not satisfy the requirement — this is why the idempotency key is shaped the way it is.
- **Muting suppresses the mention, never the post.** Exactly three categories are mutable: Nomination Slot released, the unbid-Nomination 24-hour warning, and closes for Auctions the viewer's Team did not lead or contend in. Outbid and Contract Assignment Phase notices are structurally unmutable, and a direct request to mute either is refused **server-side**, not merely hidden in the UI.
- **One channel, not two.** Mentions and broadcasts share the same configured channel so the alert and the public record cannot disagree.
- **Every payload sets `allowed_mentions` explicitly**, so no message can mass-ping the league by accident.
- **Measurability cannot be retrofitted (NFR11).** Dispatch and delivery outcome must be recorded on notification events from the very first notification — an insert-only log cannot be backfilled, and SM-3 cannot be computed in hindsight.
- **The webhook ceiling is 30 requests/minute.** Batch where possible and back off on 429 rather than dropping intents; a sweep closing many Auctions at once is the case that hits it.

## Technical Decisions

- **Transactional outbox (AR-17/AD-17).** The same transaction that appends auction events also inserts the delivery intents. A separate dispatcher drains the outbox with retry and backoff. Delivery never runs inside the auction transaction and can never fail it.
- **The idempotency key is `(event seq, channel, recipient)`** — not the event alone. Keying on the event would silently deduplicate the second co-Manager's mention, which is exactly the FR-27 failure the key exists to prevent.
- **One tick, one schedule (AR-10/AD-10).** A single Supabase Cron schedule invokes a single Edge Function that performs the close sweep and *then* drains the outbox. There is no second schedule and no in-memory timer — two schedules would blow the shared 500K/month Edge invocation cap, whose exhaustion stops the tick silently. The 24-hour unbid-Nomination warning is therefore driven by the tick re-deriving Nomination age, never by a per-nomination timer.
- **Insert-only event log (AR-5/AD-4).** Notification events carry the standard envelope — database-assigned monotonic `seq`, `occurredAt`, `schemaVersion`, `coreVersion`, acting manager and team — plus NFR11's dispatch and delivery-outcome fields. Corrections append; nothing is updated or deleted.
- **The dispatcher is shell, not core (AR-3).** Message composition, HTTP, retry and backoff live in the shell and in `adapters/discord/`; the pure rules core has no `fetch`, no clock, and no knowledge that Discord exists. Time enters as an injected `now` sourced from the database server clock (AR-4).
- **Discord knowledge is confined to its adapter.** Webhook payload shape, `allowed_mentions` and mention formatting live in one module. The webhook URL and the OAuth client secret are server-only environment variables and must never sit behind a `PUBLIC_`-prefixed name, which the framework inlines into the client bundle (AR-10/AD-16).
- **Discord ids come from sign-in.** The id used to address a Manager is the one captured by Discord OAuth — authentication and notification addressing are the same fact, obtained once (AD-15).
- **Two open build-time decisions (AR-34), both of which must be recorded:** whether the outbox is **Supabase Queues (pgmq)** or a hand-rolled table — AD-17's contract holds unchanged either way — and whether delivery is one message per event or batched, decided against the 30 req/min ceiling and **flagged for revisit at the Epic 8 rehearsal**, the first point at which burst behaviour becomes observable.
- **Money in Discord renders as `$14.5M` at exactly one decimal.** Discord payloads are a view of the same figures for the same readers, so the abbreviated renderer is correct there — and must remain structurally unable to reach a CSV cell, where exports emit exact integer dollars (AD-24).
- **Naming rule, absolute:** a three-letter capitalised abbreviation always means a player's real-life NBA team and nothing else; a fantasy Team is always spelled out with its acting Manager (`Lakers — Meakel`). This holds in Discord exactly as it does in the UI.
- **Monitoring deliberately does not run on this path.** The detector that alerts on a growing outbox backlog lives outside both vendors and is not routed through Discord (AR-19). It is Epic 8 work, but nothing here may assume Discord can report its own failure.

## UX & Interaction Patterns

- **Voice.** Sincere, quietly institutional, never alarmed. No exclamation marks anywhere in the product, Discord posts included; no urgency framing, no "ending soon" or "last chance", and no suggested action. The app states facts; it never advises.
- **Entry to the app is usually from Discord.** A mention post links directly to the relevant Auction, and following that link must land the Manager on that Auction, already signed in, with their position on it visible without a further tap. Sessions persist at least 30 days precisely so this holds.
- **Notification settings is a spec-only surface** — no mockup exists, so drift risk is highest here. At 375px it is single-column and fully operable one-handed, and each of the three categories states in words what muting it will and will not do rather than presenting a bare toggle.
- **The absence of a mute control is itself the message.** Where no control exists, the reason — muting an outbid notice would undermine the fairness premise of a 24/7 clock — must be legible rather than merely enforced.

## Cross-Story Dependencies

- **5.1 lands first and everything else drains through it.** 5.2 and 5.3 are payload shapes on top of the outbox; building either before the delivery contract means retrofitting idempotency onto live posts.
- **Depends on Epic 3's tick.** The dispatcher runs inside the existing sweep tick, after the sweep, on the one combined schedule — never as a new job.
- **Depends on Epic 1's Discord OAuth**, which supplies the Manager-to-Discord-id binding, and on the append-only write path and event envelope.
- **Depends on Epic 4's deep-link shape.** Story 4.4 fixed a stable, addressable per-Auction URL specifically so mentions have something to emit; Epic 4 was built without knowing Discord exists.
- **Consumed by later epics.** Epic 6's assignment reminders and deadline notices go through the 5.3 mention path; Epic 7's overrides and pauses broadcast like any other event; Epic 8's rehearsal is where burst behaviour against the 30 req/min ceiling is first observed and the delivery-shape decision revisited.
- **Complements, does not replace, in-app signals.** The 24-hour unbid-Nomination warning sits alongside the board flag already derived on read in Story 2.3.
