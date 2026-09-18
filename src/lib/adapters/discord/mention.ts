/**
 * What a MENTION says, and where on the message it says it. Story 5.3, AD-18,
 * FR-27.
 *
 * **The third file in `adapters/discord/`.** `webhook.ts` knows the wire shape
 * of a request and owns `<@id>` and `allowed_mentions`; `broadcast.ts` knows
 * what an auction event reads like as a public record; this knows how to point
 * one of those lines at the people it happened to. It performs no I/O, reads no
 * clock, and never throws — the same three properties `broadcast.ts` states,
 * for the same three reasons.
 *
 * **The mention rides its own event's notice, and is never prepended to the
 * head of the message.** The drain batches by channel, so one post can cover
 * several events; a Manager pinged at the top of a five-event post cannot tell
 * which line is theirs, and with several links in one body "links directly to
 * the relevant Auction" stops being true. Placing the mention on the notice for
 * its own event makes the addressing and the fact one sentence. That is why
 * `webhook.ts`'s `contentFor` no longer prepends: PLACEMENT is this module's,
 * ADDRESSING (the de-dupe and `allowed_mentions.users`) is still `webhook.ts`'s.
 *
 * **One line per affected TEAM, not one per Manager.** Both Managers of a
 * co-managed Team are separate intents — the outbox key `(event_seq, channel,
 * recipient)` makes that the natural shape and 5.4 will make each of them
 * mutable independently — but they are one Team and one fact, so they share a
 * line and appear on it as two distinct `<@id>`. A Team the directory cannot
 * name degrades to the plain factual line rather than rendering a stray dash.
 *
 * **The link is absolute or it is absent.** `core/auction-link.ts` answers a
 * PATH and explicitly no origin; the origin is deployment configuration that
 * reaches the drain from the tick's environment (`APP_ORIGIN`). With no origin
 * configured the mention still posts, without a link — a ping with no link is a
 * notice, and no ping at all is a silence.
 *
 * **Voice, from the story's boundaries and 5.2's**: no exclamation mark, no
 * urgency framing, no "ending soon", no suggested action. A mention states what
 * happened to the reader and stops.
 *
 * **NOTHING IS SUPPRESSED HERE, and something used to be.** Story 5.4 withheld
 * the snowflake of a Manager who had muted `slot_release`, the one category
 * this league let anybody mute. That category was retired when FR-9 was
 * amended: the Slot release stopped being a notice of its own addressed to the
 * nominator and became half a sentence on the winner's close line, which is a
 * notice about a Contract and was never mutable. No category is mutable now,
 * so this module renders every addressee it is handed, and `LeagueDirectory`
 * no longer carries a mute set for it to consult.
 *
 * **`allowed_mentions` follows from `addressees`, UNCHANGED.** `server/outbox.ts`
 * filters the wire recipients through `mentionsPresentIn` against the body this
 * module actually rendered, so a snowflake this module declines to name drops
 * out of `allowed_mentions.users` by construction rather than by a second
 * filter somebody has to remember to apply. That was true while the mute
 * existed and is true without it.
 *
 * **Deno-loadable** (AD-2): relative `.ts` imports only, no `$lib`, no `$env`,
 * no Node builtin — `server/outbox.ts` reaches this and the tick reaches
 * `server/outbox.ts`.
 */

import { auctionPathFor } from '../../core/auction-link.ts';
import type { NotificationCategory } from '../../core/notification-categories.ts';
import { formatTeamManagers } from '../../core/team-identity.ts';
import type { BroadcastEvent, LeagueDirectory } from './broadcast.ts';
// `mentionFor` is the one place `<@id>` is spelled (AR-2 puts Discord's message
// grammar in `webhook.ts`), and it is imported rather than re-spelled here.
import { mentionFor } from './webhook.ts';

/** Between the addressees and what happened to them. U+2014 EM DASH. */
const EM_DASH = '—';

/**
 * The trigger set, as clauses. One sentence fragment per trigger, and nothing
 * for any other event type — a mention intent on a type with no clause here
 * degrades to the plain factual line rather than inventing a sentence.
 *
 * The subject of every clause is the addressed TEAM, so each reads as
 * `Bulls — Ari were outbid.` The plural verb is deliberate:
 * a Team is the subject, and a co-managed one legitimately has two Managers on
 * the line.
 */
const OUTBID_CLAUSE = 'were outbid.';
const LED_AT_CLOSE_CLAUSE = 'led this Auction at its close.';
const CONTENDER_CLAUSE = 'were a Contender in this draw.';

/**
 * The close clause when this close ALSO freed the winner's Nomination Slot
 * (FR-9, amended).
 *
 * **Two facts on one line, because they are one event and one Team.** A close
 * mentions the winner and nobody else, so a second line addressed to the same
 * Team would be the same ping twice; and a Manager who has just won a Player
 * wants to know in the same breath that they may nominate again.
 *
 * **Chosen by `releasedNominationSlot` and never assumed.** A winner who held
 * no Slot — one whose earlier win already paid it back, or who never nominated
 * — gets `LED_AT_CLOSE_CLAUSE` instead, because "free again" would claim a
 * release that did not happen.
 *
 * This is the clause that used to be addressed to the NOMINATOR, saying they
 * no longer held the Slot. Under the amended rule that was false for exactly
 * the Manager it was sent to: nominating and losing keeps the Slot held, and
 * winning is what frees it.
 */
const LED_AT_CLOSE_SLOT_FREED_CLAUSE =
	'led this Auction at its close, and your Nomination Slot is free again.';

/**
 * The Contract Assignment clause. Rendered FLAT — every addressee on one line
 * with no Team naming at all — because this trigger addresses every Manager in
 * the league at once, and thirty `<@id> — Team — Manager` lines would be most
 * of Discord's 2000-character ceiling for one notice. Thirty bare mentions and
 * one sentence is a fifth of the size and says the same thing.
 */
const CONTRACT_ASSIGNMENT_CLAUSE = 'Contract Assignment is open.';

/**
 * The two Story 6.2 clauses, keyed on the EVENT TYPE rather than on the
 * category.
 *
 * Both belong to `contract_assignment` — no new category exists and none is
 * wanted — but a category maps to exactly one clause, and these three events
 * say three different things. So the category still decides muting and
 * classification (`categoryFor` below names all three), and the clause is
 * chosen by type where a type needs its own.
 *
 * The subject of each is the addressed TEAM, so a line reads
 * `Bulls — Ari still have 3 Players with no contract length.` — the plural verb
 * is deliberate, as it is for every other clause here: a Team is the subject,
 * and a co-managed one legitimately has two Managers on the line.
 *
 * No exclamation mark, no urgency framing and no suggested action. The
 * reminder states that a deadline is approaching and the notice states that it
 * passed; neither tells a Manager what to do, and neither claims anything was
 * written.
 */
// It does NOT say "one reminder interval away". That is true of the instant the
// reminder became due, not of the moment it is read, and it is not true at all
// when the interval is longer than the window the deadline was set with — the
// reminder is then due the moment it is configured. The notice line this rides
// under already states the deadline itself, so the clause states only the fact
// about the addressee that the deadline does not.
const ASSIGNMENT_REMINDER_CLAUSE = 'still have Players with no contract length.';
const ASSIGNMENT_DEADLINE_PASSED_CLAUSE =
	'still have Players with no contract length, and the assignment deadline has passed. No length was assigned.';

const CLAUSE_FOR_EVENT_TYPE: Readonly<Record<string, string>> = Object.freeze({
	AssignmentRemindersSent: ASSIGNMENT_REMINDER_CLAUSE,
	AssignmentDeadlinePassed: ASSIGNMENT_DEADLINE_PASSED_CLAUSE
});

/** A payload as an object, or an empty one. `broadcast.ts`'s `fields`. */
function fields(payload: unknown): Record<string, unknown> {
	return typeof payload === 'object' && payload !== null
		? (payload as Record<string, unknown>)
		: {};
}

/** A non-blank string field, or `null`. `broadcast.ts`'s `text`. */
function text(payload: Record<string, unknown>, key: string): string | null {
	const value = payload[key];
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

/**
 * The recipients, trimmed, de-duplicated and blank-free, in the order given.
 *
 * The same normalisation `webhook.ts`'s `addressees` applies to the wire, done
 * again here because the two answer different questions: that one decides who
 * may PING, this one decides who is NAMED. They have to agree, and the
 * acceptance criterion that `allowed_mentions.users` is exactly the set of
 * snowflakes in the body is what holds them together — `server/outbox.ts`
 * filters the wire list down to what this module actually rendered.
 */
function addressees(recipients: readonly string[]): readonly string[] {
	const ids: string[] = [];
	for (const recipient of recipients) {
		const trimmed = recipient.trim();
		if (trimmed === '' || ids.includes(trimmed)) continue;
		ids.push(trimmed);
	}
	return ids;
}

/** The plain factual line, `broadcast.ts`'s `fallbackNotice` verbatim. */
function plainSentence(event: BroadcastEvent): string {
	return `A ${event.eventType} was recorded (event #${event.seq}).`;
}

/**
 * The absolute link to the Auction this event is about, or `null`.
 *
 * `auctionPathFor` is the one place the path shape is spelled (Story 4.4 built
 * it saying this story would call it rather than re-derive the route). The
 * origin is joined here because the core may not name a host.
 */
function auctionLink(event: BroadcastEvent, origin: string | null): string | null {
	if (origin === null || origin === '') return null;
	const fantraxPlayerId = text(fields(event.payload), 'fantraxPlayerId');
	if (fantraxPlayerId === null) return null;
	return `${origin}${auctionPathFor(fantraxPlayerId)}`;
}

/** One clause per category, so the two never drift apart. */
const CLAUSE_FOR_CATEGORY: Readonly<Record<NotificationCategory, string>> = {
	outbid: OUTBID_CLAUSE,
	led_at_close: LED_AT_CLOSE_CLAUSE,
	contender: CONTENDER_CLAUSE,
	contract_assignment: CONTRACT_ASSIGNMENT_CLAUSE
};

/**
 * Whether this close's payload says it released the winner's Nomination Slot.
 *
 * Read defensively and defaulting to `false`, which is this module's posture
 * everywhere: an `AuctionClosed` written before the field existed, or one
 * whose payload is some other shape, gets the shorter clause rather than a
 * sentence claiming a release nobody recorded. Only the literal `true` says a
 * Slot came back.
 */
function releasedNominationSlot(payload: Record<string, unknown>): boolean {
	return payload['releasedNominationSlot'] === true;
}

/**
 * Which category one addressed Team's mention on one event belongs to, or
 * `null` when this event type carries no mention copy.
 *
 * **`AuctionClosed` addresses one Team, and the payload names it.** The winner
 * is on the payload, and since FR-9's amendment the winner is the only Team a
 * close is about: they led the Auction into it and their Nomination Slot is
 * what it released. `server/close.ts` addresses nobody else, so an addressed
 * Team whose id does not match is a targeting bug rather than a second
 * category — it gets no clause and degrades to the plain factual line, which
 * is what this module does with every fact it cannot vouch for.
 *
 * It used to answer `slot_release` for that non-matching Team, on the old rule
 * that a close freed the NOMINATOR's Slot. It does not any more, and nothing
 * is mentioned under that category, because it no longer exists.
 */
function categoryFor(event: BroadcastEvent, teamId: string | null): NotificationCategory | null {
	const payload = fields(event.payload);
	switch (event.eventType) {
		case 'BidPlaced':
			return 'outbid';
		case 'AuctionClosed':
			return teamId !== null && teamId === text(payload, 'teamId') ? 'led_at_close' : null;
		case 'ContentionDrawn':
			return 'contender';
		case 'ContractAssignmentOpened':
		// Story 6.2's two markers ride the SAME category — the phase's own —
		// because they are the same conversation: a Manager who wants to hear
		// about Contract Assignment wants to hear all three, and a category
		// exists to be muted rather than to label an event. `contract_assignment`
		// is unmutable, so nothing about mute handling changes either.
		case 'AssignmentRemindersSent':
		case 'AssignmentDeadlinePassed':
			return 'contract_assignment';
		default:
			return null;
	}
}

/**
 * The clause for one addressed Team on one event, or `null` when this event
 * type carries no mention copy.
 *
 * `ContractAssignmentOpened` never reaches here in practice — `composed`
 * returns its flat line before the grouping loop, because that trigger
 * addresses the whole league and names no Team — but the mapping is total so
 * that adding a category cannot leave a clause unassigned.
 */
function clauseFor(event: BroadcastEvent, teamId: string | null): string | null {
	// The per-type override first — see `CLAUSE_FOR_EVENT_TYPE`. Three event
	// types share one category and two of them need their own sentence, so the
	// type is consulted before the category rather than the category being
	// split to carry them.
	const override = CLAUSE_FOR_EVENT_TYPE[event.eventType];
	if (override !== undefined) return override;
	const category = categoryFor(event, teamId);
	if (category === null) return null;
	// The one clause chosen by a payload FACT rather than by the category
	// alone. `led_at_close` covers both closes; which sentence it renders turns
	// on whether this close also freed the winner's Slot. A second category
	// would have been the wrong shape: it is the same notice, to the same
	// Team, about the same event, and splitting it would have made one of the
	// two halves separately addressable when neither ever is.
	if (category === 'led_at_close' && releasedNominationSlot(fields(event.payload))) {
		return LED_AT_CLOSE_SLOT_FREED_CLAUSE;
	}
	return CLAUSE_FOR_CATEGORY[category];
}

/**
 * `discordUserIds` without anybody THIS EVENT CANNOT BE ABOUT.
 *
 * **One rule, and it exists because the recipient list is frozen at enqueue
 * time.** `server/outbox.ts` writes an intent row per recipient inside the
 * transaction that appends the event, and the drain reads the recipients back
 * off those rows — so an intent filed by a WRITE SITE THAT HAS SINCE BEEN
 * FIXED keeps its original addressee forever. Every `AuctionClosed` enqueued
 * before `server/close.ts` stopped addressing the nominator (FR-9, amended)
 * still carries a row for a Team the close is not about, and those rows drain
 * whenever the drain next runs — on a build that may be days newer than the
 * build that filed them.
 *
 * Without this filter those stale rows do not vanish; they degrade. The
 * nominator's group gets no clause (`categoryFor` answers `null` for a
 * non-winner), falls to the plain factual line, and pings a Manager with
 * `A AuctionClosed was recorded (event #123).` — which is worse than the
 * wrong sentence it replaced, because it is a ping with no fact attached at
 * all.
 *
 * **So the targeting rule is enforced at BOTH seams rather than only at the
 * write site.** A Close is about the winner; the payload names them; a Team
 * that is not them is not an addressee, whoever filed the row and whenever.
 *
 * **A snowflake the directory cannot place on a Team is KEPT**, and that is
 * the module's usual posture rather than an oversight: this function drops the
 * addressees it can prove wrong, never the ones it merely cannot verify. An
 * unresolvable recipient still degrades to the plain factual line, exactly as
 * it did before, because "a mention that renders no `<@id>` is a silence" and
 * an unreadable directory must not manufacture one.
 *
 * Total, and it narrows nothing on any other event type.
 */
function withoutMistargeted(
	event: BroadcastEvent,
	discordUserIds: readonly string[],
	directory: LeagueDirectory
): readonly string[] {
	if (event.eventType !== 'AuctionClosed') return discordUserIds;
	const winnerTeamId = text(fields(event.payload), 'teamId');
	// A close whose payload names no winner is not one this filter can judge.
	// It is already malformed and every addressee degrades to the plain line.
	if (winnerTeamId === null) return discordUserIds;
	return discordUserIds.filter((discordUserId) => {
		const teamId = teamOf(discordUserId, directory);
		return teamId === null || teamId === winnerTeamId;
	});
}

/** The Team one snowflake acts for, through the directory, or `null`. */
function teamOf(discordUserId: string, directory: LeagueDirectory): string | null {
	const managerId = directory.managerIdsByDiscordUserId.get(discordUserId);
	if (managerId === undefined) return null;
	return directory.teamOfManager.get(managerId) ?? null;
}

/** `Lakers — Meakel & Dana`, for exactly the addressees on this line. */
function subjectFor(
	teamId: string | null,
	discordUserIds: readonly string[],
	directory: LeagueDirectory
): string | null {
	if (teamId === null) return null;
	const teamName = directory.teamNames.get(teamId);
	if (teamName === undefined) return null;
	const names = discordUserIds
		.map((id) => directory.managerIdsByDiscordUserId.get(id))
		.map((managerId) => (managerId === undefined ? undefined : directory.managerNames.get(managerId)))
		.filter((name): name is string => name !== undefined);
	return formatTeamManagers(teamName, names);
}

/**
 * The inline mention line (or lines) for one event, appended under its notice.
 *
 * **Never throws**, and the try/catch is the guarantee rather than the
 * per-branch guards alone: a payload shape nobody anticipated must not fail a
 * drain pass, and the drain has no other exit — `broadcast.ts`'s `noticeFor`
 * makes the same promise for the same reason.
 *
 * **The addressees are normalised in their OWN guard, before the composition's,
 * and the catch reuses that value rather than recomputing it.** A catch block
 * that re-entered the very call that threw would let the second exception
 * escape and defeat the promise above at exactly the moment it is needed. Two
 * guards rather than one, so the promise is total: an unreadable recipient list
 * degrades to no addressees (and therefore to `''`, a notice that posts alone),
 * and a composition that fails afterwards still has the addressees in hand for
 * the fallback line.
 *
 * Returns `''` when there is nothing to say: no recipients, or every recipient
 * blank. `''` means the notice posts alone, which is the "a Team has no
 * Manager rows" and "a Team outbids itself" answer both — in each case the
 * write site supplied no affected Team, or the Team resolved to no Manager, and
 * the public record still states the fact.
 */
export function mentionSuffixFor(
	event: BroadcastEvent,
	recipients: readonly string[],
	directory: LeagueDirectory,
	origin: string | null = null
): string {
	// In its own guard and outside the composition's, deliberately: see the
	// header. Recomputing this in the catch below would be re-running a call
	// that may be what threw.
	let discordUserIds: readonly string[] = [];
	try {
		// Normalised and then narrowed to the Teams this event can be about, in
		// ONE guard: what the fallback below may name is exactly what the
		// composition may name, so a stale intent cannot be pinged by the
		// degradation path either. That is the property the suppression filter
		// held in this same position before it was retired.
		discordUserIds = withoutMistargeted(event, addressees(recipients), directory);
	} catch {
		// The recipient list itself is unreadable, so there is nobody this
		// module can honestly name. `''` posts the notice alone, which is the
		// same answer as an event that affected nobody.
		return '';
	}

	try {
		return composed(event, discordUserIds, directory, origin);
	} catch {
		// The addressees are still named, because a mention that renders no
		// `<@id>` is a silence and this module's whole job is not to produce
		// one. Whatever went wrong, the ping survives it — without a
		// clause it can no longer vouch for, and without a link.
		return flatLine(discordUserIds, plainSentence(event), null);
	}
}

/** `<@1> <@2> — <sentence>[ <link>]`, or `''` for no addressees. */
function flatLine(
	discordUserIds: readonly string[],
	sentence: string,
	link: string | null
): string {
	if (discordUserIds.length === 0) return '';
	const mentions = discordUserIds.map(mentionFor).join(' ');
	return [`${mentions} ${EM_DASH} ${sentence}`, link].filter((part) => part !== null).join(' ');
}

function composed(
	event: BroadcastEvent,
	discordUserIds: readonly string[],
	directory: LeagueDirectory,
	origin: string | null
): string {
	// **Normally a no-op, and deliberately kept anyway.** The only caller,
	// `mentionSuffixFor`, has already run this in its own guard so that the
	// fallback line honours it too — so on every real call this list arrives
	// filtered and this pass removes nothing. It is the SAME filter and not a
	// second one: `withoutMistargeted` is total and idempotent, and keeping the
	// call here is what makes the targeting rule a property of composition
	// rather than of one caller remembering to apply it first.
	const addressed = withoutMistargeted(event, discordUserIds, directory);
	if (addressed.length === 0) return '';

	// The phase trigger addresses the whole league, so it is flat by design —
	// see `CONTRACT_ASSIGNMENT_CLAUSE`. No link: the phase is not an Auction.
	if (event.eventType === 'ContractAssignmentOpened') {
		return flatLine(addressed, CONTRACT_ASSIGNMENT_CLAUSE, null);
	}

	const link = auctionLink(event, origin);

	// Grouped by Team, in first-appearance order — deterministic, and never
	// re-sorted: the recipients arrive in the outbox's own total order.
	const order: Array<string | null> = [];
	const byTeam = new Map<string | null, string[]>();
	for (const discordUserId of addressed) {
		const teamId = teamOf(discordUserId, directory);
		const bucket = byTeam.get(teamId);
		if (bucket === undefined) {
			byTeam.set(teamId, [discordUserId]);
			order.push(teamId);
		} else {
			bucket.push(discordUserId);
		}
	}

	return order
		.map((teamId) => {
			const group = byTeam.get(teamId) ?? [];
			const clause = clauseFor(event, teamId);
			const subject = subjectFor(teamId, group, directory);
			// A missing name or an unrecognised type degrades to the plain
			// factual line — the addressees and the event, and no invented
			// sentence. The story's matrix names both rows.
			if (clause === null || subject === null) {
				return flatLine(group, plainSentence(event), null);
			}
			return flatLine(group, `${subject} ${clause}`, link);
		})
		.filter((line) => line !== '')
		.join('\n');
}

/**
 * Which of `discordUserIds` actually appear as an `<@id>` in `body`.
 *
 * **The one guarantee `allowed_mentions.users` needs.** `server/outbox.ts`
 * derives the wire recipients from the intents it POSTED, and a notice that
 * alone exceeds Discord's 2000-character ceiling is truncated rather than
 * dropped (`broadcast.ts` explains why that is the only exit that terminates).
 * A truncated tail can take a mention with it, and whitelisting a snowflake the
 * body never spells would make the payload claim to ping somebody it does not.
 * Filtering the list through the body it will be sent with closes that by
 * construction rather than by argument.
 */
export function mentionsPresentIn(
	body: string,
	discordUserIds: readonly string[]
): readonly string[] {
	return discordUserIds.filter((id) => body.includes(mentionFor(id)));
}
