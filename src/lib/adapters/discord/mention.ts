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
 * **Deno-loadable** (AD-2): relative `.ts` imports only, no `$lib`, no `$env`,
 * no Node builtin — `server/outbox.ts` reaches this and the tick reaches
 * `server/outbox.ts`.
 */

import { auctionPathFor } from '../../core/auction-link.ts';
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
 * `Bulls — Ari no longer hold the leading Bid.` The plural verb is deliberate:
 * a Team is the subject, and a co-managed one legitimately has two Managers on
 * the line.
 */
const OUTBID_CLAUSE = 'no longer hold the leading Bid.';
const LED_AT_CLOSE_CLAUSE = 'led this Auction at its close.';
const SLOT_RELEASED_CLAUSE = 'no longer hold this Nomination Slot.';
const CONTENDER_CLAUSE = 'were a Contender in this draw.';

/**
 * The Contract Assignment clause. Rendered FLAT — every addressee on one line
 * with no Team naming at all — because this trigger addresses every Manager in
 * the league at once, and thirty `<@id> — Team — Manager` lines would be most
 * of Discord's 2000-character ceiling for one notice. Thirty bare mentions and
 * one sentence is a fifth of the size and says the same thing.
 */
const CONTRACT_ASSIGNMENT_CLAUSE = 'Contract Assignment is open.';

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

/**
 * The clause for one addressed Team on one event, or `null` when this event
 * type carries no mention copy.
 *
 * `AuctionClosed` is the only one that branches, and it branches on a fact the
 * PAYLOAD already carries: the winner is named on it, so the Team that led the
 * Auction at its close is the one whose id matches, and any other addressed
 * Team is there because its Nomination Slot was released by that same close.
 * Nothing is re-derived about who was affected — the write site decided that
 * (`server/close.ts`); this only chooses which of two sentences fits.
 */
function clauseFor(event: BroadcastEvent, teamId: string | null): string | null {
	const payload = fields(event.payload);
	switch (event.eventType) {
		case 'BidPlaced':
			return OUTBID_CLAUSE;
		case 'AuctionClosed':
			return teamId !== null && teamId === text(payload, 'teamId')
				? LED_AT_CLOSE_CLAUSE
				: SLOT_RELEASED_CLAUSE;
		case 'ContentionDrawn':
			return CONTENDER_CLAUSE;
		default:
			return null;
	}
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
		discordUserIds = addressees(recipients);
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
	if (discordUserIds.length === 0) return '';

	// The phase trigger addresses the whole league, so it is flat by design —
	// see `CONTRACT_ASSIGNMENT_CLAUSE`. No link: the phase is not an Auction.
	if (event.eventType === 'ContractAssignmentOpened') {
		return flatLine(discordUserIds, CONTRACT_ASSIGNMENT_CLAUSE, null);
	}

	const link = auctionLink(event, origin);

	// Grouped by Team, in first-appearance order — deterministic, and never
	// re-sorted: the recipients arrive in the outbox's own total order.
	const order: Array<string | null> = [];
	const byTeam = new Map<string | null, string[]>();
	for (const discordUserId of discordUserIds) {
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
