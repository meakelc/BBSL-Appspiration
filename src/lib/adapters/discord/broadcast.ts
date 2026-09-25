/**
 * What a broadcast notice SAYS. Story 5.2, AD-18.
 *
 * **The second file in `adapters/discord/`**, and the one AR-2's tree means by
 * copy: `webhook.ts` knows the wire shape of a request and nothing about
 * auctions; this knows what an auction event reads like in a Discord message
 * and nothing about transports, outbox rows, retries or budgets. Story 5.1
 * shipped `BBSL auction update — BidPlaced (event #1).` as a placeholder and
 * named this story as the one that replaces it.
 *
 * **Addressed to the CHANNEL, never to a person.** Every line here is the
 * league's public record of something that happened. There is no mention text,
 * no `@`, and no Manager is singled out — Story 5.3 owns the mention and 5.4
 * owns muting, and both of them work by adding a recipient beside this body
 * rather than by changing a word of it (`DiscordWebhookMessage` keeps `body`
 * and `recipients` separate all the way to the wire for exactly that reason).
 *
 * **Pure, and that is load-bearing twice over.** It performs no I/O and reads
 * no clock: every name and every instant it needs is passed in, which is what
 * lets `tests/adapters/discord-broadcast.test.ts` drive every event type
 * against a literal payload with no database. And it is Deno-loadable (AD-2) —
 * relative `.ts` imports only, no `$lib`, no `$env`, no Node builtin — because
 * `server/outbox.ts` reaches it and the tick reaches `server/outbox.ts`.
 *
 * **Nothing here throws.** `noticeFor` degrades a malformed or unrecognised
 * payload to a plain factual line naming the event and its `seq`. The log is
 * insert-only, so a historical row cannot be corrected in place, and a reader
 * that crashed on one would stall the outbox forever — the same defensive
 * reading `core/projection/*.ts` applies to `AppendedEvent.payload`.
 *
 * **The copy rules, from the story's boundaries.** No exclamation mark, no
 * urgency framing, no "ending soon" or "last chance", no suggested action.
 * These are notices, not prompts. Money renders through `formatMoney` and a
 * fantasy Team through `formatTeamManager`, never by hand — a three-letter
 * capitalised abbreviation always and only means a real-life NBA team.
 */

import { formatMoney } from '../../core/money.ts';
import type { Money } from '../../core/money.ts';
import { formatTeamManager, formatTeamManagers } from '../../core/team-identity.ts';

// --- What is broadcast ----------------------------------------------------

/**
 * The seven event types the league channel hears about, and nothing else.
 *
 * Deliberately NOT every appended event. `AuctionTerminated` and
 * `ContentionDissolved` are quiet outcomes nobody is waiting on; eligibility
 * and import writes are Commissioner bookkeeping; and the dispatcher's own
 * `NotificationDispatched` would notify the league that the league had been
 * notified. Membership of this list is the whole of the broadcast decision,
 * and `server/outbox.ts`'s `enqueueBroadcasts` is the only reader of it.
 */
export const BROADCAST_EVENT_TYPES: readonly string[] = [
	'NominationPlaced',
	'BidPlaced',
	'AuctionClosed',
	'ContentionDrawn',
	'AuctionOpened',
	'ContractAssignmentOpened',
	// Story 6.2. The DEADLINE only — `AssignmentRemindersSent` is deliberately
	// absent. Membership here is what files a CHANNEL-ADDRESSED intent, and the
	// deadline passing is a league-wide fact that earns one even in the league
	// where every Team had already submitted. A reminder is addressed to the
	// Teams that still owe a length, so it files mention intents alone and no
	// line of its own is owed to the channel. It still gets copy below, because
	// `composeNotice` words every group it drains and the fallback line is not
	// a sentence anybody should have to read.
	'AssignmentDeadlinePassed',
	// Story 7.13. A reversed Close IS announced — unlike a Trade, a Drop or a
	// Move — because it takes a Player off a Team that won him in public, and
	// the league heard about that win here. The notice names the actor and the
	// reason; the winning Team's Managers are mentioned.
	'AuctionCloseReversed',
	// Story 7.14. A reinstated Bid IS announced, for the reversal's reason: it
	// hands a Team back a lead the league saw cancelled, and it erases Bids the
	// league saw placed. The notice names the actor, the reason, the
	// reinstated Team and every Team whose Bid was erased; they are mentioned.
	'BidCancellationReversed'
];

/** Whether an appended event's type earns a line in the league channel. */
export function isBroadcastEventType(eventType: string): boolean {
	return BROADCAST_EVENT_TYPES.includes(eventType);
}

// --- The inputs -----------------------------------------------------------

/**
 * One appended event, as much of it as composition reads.
 *
 * `payload` is `unknown` because `AppendedEvent.payload` is: this module is
 * handed whatever the log holds and narrows it itself, rather than trusting a
 * cast made by the caller that read the row.
 */
export type BroadcastEvent = {
	/** `auction_events.seq`, as a string — `int8` (AD-8). */
	readonly seq: string;
	readonly eventType: string;
	readonly payload: unknown;
	/** The acting Manager, or `null` for a system event. */
	readonly managerId: string | null;
	/** The event's own `occurred_at`, ISO-8601. Never used as "now". */
	readonly occurredAt: string;
	/**
	 * The Player's name, resolved by the caller's join on the payload's
	 * `fantraxPlayerId`. `BidPlaced` carries no `playerName` of its own and
	 * adding one would mean editing `core/rules/bidding.ts`, so the name is
	 * joined from `free_agent_players` — which a close writes neither of.
	 */
	readonly playerName: string | null;
};

/**
 * Every name the league has, as composition needs them.
 *
 * Passed in whole rather than looked up, because purity is what makes this
 * testable and Deno-loadable. `server/outbox.ts` reads it inside the same
 * transaction as the intents, so one pass composes against one snapshot of
 * the registry.
 */
export type LeagueDirectory = {
	/** `teams.id` -> `teams.name`. */
	readonly teamNames: ReadonlyMap<string, string>;
	/** `managers.id` -> `managers.display_name`. Never the Discord snowflake. */
	readonly managerNames: ReadonlyMap<string, string>;
	/**
	 * `teams.id` -> every Manager acting for it, in a stable order.
	 *
	 * Co-management is a supported state, so a Team legitimately has more than
	 * one Manager to name — `formatTeamManagers` renders the pair.
	 */
	readonly managersOfTeam: ReadonlyMap<string, readonly string[]>;
	/**
	 * `managers.discord_user_id` -> `managers.id` (Story 5.3).
	 *
	 * The mention composer is handed SNOWFLAKES — the outbox addresses an
	 * intent by the thing Discord can ping, not by the league's own surrogate
	 * key — and it has to be able to say whose Team a snowflake acts for. This
	 * is the only edge that goes that way; nothing here ever renders a
	 * snowflake as a NAME, which is what `managerNames` is for.
	 *
	 * Nothing in this module reads it: the broadcast copy is addressed to the
	 * channel and mentions nobody. It lives on the directory rather than beside
	 * `mention.ts` because the directory is read once per pass, off one
	 * snapshot, and a second read would let one message carry two spellings of
	 * the league.
	 */
	readonly managerIdsByDiscordUserId: ReadonlyMap<string, string>;
	/**
	 * `managers.id` -> `managers.team_id`. Absent for a Manager with no Team,
	 * which is a supported state (a nullable FK) rather than an error.
	 *
	 * The inverse of `managersOfTeam`, and both are needed: composition walks
	 * team-to-Managers to NAME a Team, and Manager-to-Team to GROUP the
	 * addressees of one event by the Team the notice is about.
	 */
	readonly teamOfManager: ReadonlyMap<string, string>;
};

/** An empty directory. Every notice it cannot name degrades rather than throws. */
export const EMPTY_LEAGUE_DIRECTORY: LeagueDirectory = {
	teamNames: new Map(),
	managerNames: new Map(),
	managersOfTeam: new Map(),
	managerIdsByDiscordUserId: new Map(),
	teamOfManager: new Map()
};

// --- Rendering primitives -------------------------------------------------

/**
 * An instant as Discord's own timestamp markup, so every reader sees it in
 * THEIR timezone rather than in the server's.
 *
 * `f` is Discord's "long date/time" style — `3 September 2026 14:30`. The
 * league spans timezones and a bare UTC string would make half of it do
 * arithmetic; this is the one piece of Discord message grammar besides
 * `webhook.ts`'s `<@id>` that this application spells.
 *
 * `null` for an unparseable instant, which degrades the notice rather than
 * rendering `<t:NaN:f>`.
 */
export function discordTimestamp(instant: string): string | null {
	const ms = Date.parse(instant);
	if (!Number.isFinite(ms)) return null;
	return `<t:${String(Math.floor(ms / 1000))}:f>`;
}

/** U+2026 HORIZONTAL ELLIPSIS. One character, never three dots. */
const ELLIPSIS = '…';

/**
 * An amount as `$14.5M`, or `null` if it is not renderable.
 *
 * `formatMoney` throws a `RangeError` for an amount off the `MINIMUM_INCREMENT`
 * grid, and an insert-only log can hold a historical payload that predates a
 * rule. Guarded here rather than at every call site, and a `null` degrades the
 * notice — the alternative is a thrown exception in the drain.
 */
function displayMoney(value: unknown): string | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	try {
		return formatMoney(value as Money);
	} catch {
		return null;
	}
}

// --- Reading a payload defensively ----------------------------------------

/** A payload as an object, or an empty one. Never a throw. */
function fields(payload: unknown): Record<string, unknown> {
	return typeof payload === 'object' && payload !== null
		? (payload as Record<string, unknown>)
		: {};
}

/** A non-blank string field, or `null`. */
function text(payload: Record<string, unknown>, key: string): string | null {
	const value = payload[key];
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

/** A finite, non-negative integer field, or `null`. */
function count(payload: Record<string, unknown>, key: string): number | null {
	const value = payload[key];
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
	return Math.trunc(value);
}

/** A string-array field, blanks removed, or `null` if it is not an array. */
function ids(payload: Record<string, unknown>, key: string): readonly string[] | null {
	const value = payload[key];
	if (!Array.isArray(value)) return null;
	return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

// --- Naming a Team --------------------------------------------------------

/**
 * Where the acting pair lives on an ordinary auction payload.
 * `NominationPlacedPayload`, `BidPlacedPayload` and `AuctionClosedPayload` all
 * spell it the same three ways, which is why one constant serves three cases.
 */
const ACTING_KEYS = { teamId: 'teamId', teamName: 'teamName', managerId: 'managerId' } as const;

/**
 * Where it lives on `ContentionDrawnPayload`, which names the WINNER rather
 * than an actor — a draw has no acting Manager, so the pair is the Team the
 * reduction selected and the Manager whose joining Bid put it in the draw.
 */
const DRAW_WINNER_KEYS = {
	teamId: 'winningTeamId',
	teamName: 'winningTeamName',
	managerId: 'winningManagerId'
} as const;

/**
 * The acting Team, paired with the ONE Manager who acted: `Lakers — Meakel`.
 *
 * The acting Manager rather than every Manager of the Team, because a Bid is
 * placed by a person: a co-managed Team's notice should name who actually did
 * it. `teamName` comes off the payload first — every one of these payloads
 * carries it, recorded at the moment the event happened, so a Team renamed
 * afterwards does not rewrite history — and falls back to the directory.
 */
function actingTeam(
	payload: Record<string, unknown>,
	directory: LeagueDirectory,
	keys: { readonly teamId: string; readonly teamName: string; readonly managerId: string }
): string | null {
	const teamId = text(payload, keys.teamId);
	const teamName =
		text(payload, keys.teamName) ??
		(teamId === null ? null : directory.teamNames.get(teamId) ?? null);
	if (teamName === null) return null;

	const managerId = text(payload, keys.managerId);
	const managerName =
		managerId === null ? null : directory.managerNames.get(managerId) ?? null;
	// No Manager to name is not a failure: `formatTeamManagers` with an empty
	// list is the Team name alone, which is honest rather than a stray dash.
	return managerName === null
		? formatTeamManagers(teamName, [])
		: formatTeamManager(teamName, managerName);
}

/**
 * A Team named by id alone, with EVERY Manager acting for it:
 * `Lakers — Meakel & Dana`.
 *
 * The contender list is the only place a Team arrives as a bare id — AD-14
 * makes the draw's order an input to the winner, so `contenders` is the fold's
 * own list of ids in the fold's own order and nothing may re-sort or re-shape
 * it. An id the directory cannot name is spelled as itself rather than
 * dropped: the list a Manager checks the draw against must have the same
 * length as the one the draw ran over.
 */
function contenderName(teamId: string, directory: LeagueDirectory): string {
	const teamName = directory.teamNames.get(teamId);
	if (teamName === undefined) return teamId;
	const managerNames = (directory.managersOfTeam.get(teamId) ?? [])
		.map((managerId) => directory.managerNames.get(managerId))
		.filter((name): name is string => name !== undefined);
	return formatTeamManagers(teamName, managerNames);
}

/**
 * A Team named off a payload — its recorded name first, the directory's
 * second — with EVERY Manager acting for it: `Lakers — Meakel & Dana`.
 *
 * For a notice about a Team that did not act (Story 7.14's reinstatement
 * names the reinstated Team and every Team whose Bid it erased), so no single
 * Manager is the one named. `null` when neither source names the Team.
 */
function teamWithEveryManager(
	teamId: string | null,
	statedName: string | null,
	directory: LeagueDirectory
): string | null {
	const teamName = statedName ?? (teamId === null ? null : (directory.teamNames.get(teamId) ?? null));
	if (teamName === null) return null;
	const managerNames = (teamId === null ? [] : (directory.managersOfTeam.get(teamId) ?? []))
		.map((managerId) => directory.managerNames.get(managerId))
		.filter((name): name is string => name !== undefined);
	return formatTeamManagers(teamName, managerNames);
}

// --- The composer ---------------------------------------------------------

/**
 * The line for one event, or the plain fallback.
 *
 * **Never throws**, and the try/catch is the guarantee rather than the
 * per-branch guards alone: the whole point of the fallback is that a payload
 * shape nobody anticipated cannot fail a drain pass. Every branch that cannot
 * name the facts its sentence needs returns `null` and lands in the same
 * place.
 */
export function noticeFor(event: BroadcastEvent, directory: LeagueDirectory): string {
	try {
		return composed(event, directory) ?? fallbackNotice(event);
	} catch {
		return fallbackNotice(event);
	}
}

/**
 * The plain factual line: what happened and where to find it.
 *
 * It names the event type and its `seq` and claims nothing else. A reader with
 * the log can look it up; a reader without one at least knows the league did
 * something rather than seeing silence.
 */
function fallbackNotice(event: BroadcastEvent): string {
	return `A ${event.eventType} was recorded (event #${event.seq}).`;
}

/** The per-type copy. `null` for "the facts this sentence needs are absent". */
function composed(event: BroadcastEvent, directory: LeagueDirectory): string | null {
	const payload = fields(event.payload);

	switch (event.eventType) {
		case 'NominationPlaced': {
			const team = actingTeam(payload, directory, ACTING_KEYS);
			const player = text(payload, 'playerName') ?? event.playerName;
			if (team === null || player === null) return null;
			return `${team} nominated ${player}.`;
		}

		case 'BidPlaced': {
			const team = actingTeam(payload, directory, ACTING_KEYS);
			// `BidPlacedPayload` carries no `playerName` — the joined name is
			// the only source, and resolving it that way is what kept this
			// story out of `core/rules/bidding.ts`.
			const player = event.playerName ?? text(payload, 'playerName');
			const amount = displayMoney(payload['amount']);
			const closesAt = text(payload, 'closesAt');
			const closes = closesAt === null ? null : discordTimestamp(closesAt);
			if (team === null || player === null || amount === null || closes === null) return null;
			return `${team} bid ${amount} on ${player}. Closes ${closes}.`;
		}

		case 'AuctionClosed': {
			const team = actingTeam(payload, directory, ACTING_KEYS);
			const player = text(payload, 'playerName') ?? event.playerName;
			const amount = displayMoney(payload['winningAmount']);
			if (team === null || player === null || amount === null) return null;
			return `${player} to ${team} for ${amount}.`;
		}

		case 'ContentionDrawn': {
			const winner = actingTeam(payload, directory, DRAW_WINNER_KEYS);
			const player = event.playerName ?? text(payload, 'playerName');
			const contenders = ids(payload, 'contenders');
			const seed = text(payload, 'seed');
			// An EMPTY contender list is malformed, not merely uninteresting. A
			// draw always ran over at least one Team, so a `contenders` that is
			// an array of non-strings, or of blanks, has filtered down to
			// nothing and describes a draw that cannot have happened — rendering
			// it would post `Contenders, in order: .` as a sentence. The
			// fallback line is the honest answer.
			if (winner === null || player === null || seed === null) return null;
			if (contenders === null || contenders.length === 0) return null;
			// In payload order, spelled out, every one of them. The order IS
			// the draw's input (AD-14), so the list is a fact and not a
			// presentation choice.
			const listed = contenders.map((teamId) => contenderName(teamId, directory)).join(', ');
			// **The seed in full, and BEFORE the contender list.** The draw post
			// is where the commit-reveal is discharged: a Manager hashes this
			// string and checks it against the `seedHash` published on the
			// opening `BidPlaced` (Story 3.6). A truncated seed hashes to
			// nothing, so abbreviating it — or letting a ceiling eat it — would
			// leave the fairness premise unverifiable while still looking
			// correct.
			//
			// The ORDER is what makes that structural rather than a promise.
			// `truncateToFit` cuts from the tail, and the draw is the one notice
			// the story names as the truncation case, so whatever sits last is
			// what a ceiling destroys. With the seed leading, the truncator can
			// only reach the contender list — which is recoverable in full from
			// the `ContentionDrawn` event, where the seed's verifiability would
			// not be.
			return `${player} drawn to ${winner}. Seed: ${seed}. Contenders, in order: ${listed}.`;
		}

		case 'AuctionCloseReversed': {
			// The actor is the ENVELOPE's Manager — the Commissioner who acted —
			// and the Team is the payload's: the one the Contract left. Stated
			// plainly, with the reason verbatim and nothing added to it.
			// The Team the Contract left, with EVERY Manager acting for it —
			// nobody on that Team acted, so no single Manager is the one named.
			const teamId = text(payload, 'teamId');
			const teamName =
				text(payload, 'teamName') ??
				(teamId === null ? null : (directory.teamNames.get(teamId) ?? null));
			const team =
				teamName === null
					? null
					: formatTeamManagers(
							teamName,
							(teamId === null ? [] : (directory.managersOfTeam.get(teamId) ?? []))
								.map((managerId) => directory.managerNames.get(managerId))
								.filter((name): name is string => name !== undefined)
						);
			// Normalised to `null`: a joined name that arrived `undefined` must
			// not reach the sentence as the word "undefined".
			const player = text(payload, 'playerName') ?? event.playerName ?? null;
			const reason = text(payload, 'reason');
			const actor =
				event.managerId === null ? null : (directory.managerNames.get(event.managerId) ?? null);
			if (team === null || player === null || reason === null) return null;
			const who = actor === null ? 'The Commissioner' : `The Commissioner, ${actor},`;
			return (
				`${who} reversed the Close that gave ${player} to ${team}. ${player} is back in the pool. ` +
				`Reason: ${reason}`
			);
		}

		case 'BidCancellationReversed': {
			// The actor is the ENVELOPE's Manager — the Commissioner — and every
			// Team is the payload's. Nobody on the reinstated Team acted, so it is
			// named with every Manager acting for it, as a reversal names its Team.
			const team = teamWithEveryManager(
				text(payload, 'teamId'),
				text(payload, 'teamName'),
				directory
			);
			const player = text(payload, 'playerName') ?? event.playerName ?? null;
			const amount = displayMoney(payload['amount']);
			const reason = text(payload, 'reason');
			const actor =
				event.managerId === null ? null : (directory.managerNames.get(event.managerId) ?? null);
			if (team === null || player === null || amount === null || reason === null) return null;
			const erasedRaw = payload['erasedBids'];
			const erasedEntries = (Array.isArray(erasedRaw) ? erasedRaw : []).map((entry) => fields(entry));
			// A Bid another Close had ALREADY cancelled is erased too, but it
			// committed nothing and its Team lost nothing by this act — so it is
			// not named among the erased bidders.
			const live = erasedEntries.filter((bid) => bid['wasCancelled'] !== true);
			// One unnameable entry does not sink the notice: it is named by its
			// id, or stated as unnamed, and the rest of the list still reads.
			const erasedNames = [
				...new Set(
					live.map((bid) => {
						const teamId = text(bid, 'teamId');
						return (
							teamWithEveryManager(teamId, text(bid, 'teamName'), directory) ??
							teamId ??
							'an unnamed Team'
						);
					})
				)
			];
			const who = actor === null ? 'The Commissioner' : `The Commissioner, ${actor},`;
			// The noun follows the number of Bids erased, never the number of
			// distinct Teams — one Team can have placed two of them.
			const erasedSentence =
				live.length === 0
					? erasedEntries.length === 0
						? 'No later Bid was erased.'
						: 'No standing later Bid was erased.'
					: `Erased: the later ${live.length === 1 ? 'Bid' : 'Bids'} by ${erasedNames.join(', ')}.`;
			const closesAt = text(payload, 'closesAt');
			const closes = closesAt === null ? null : discordTimestamp(closesAt);
			const clock =
				payload['clockExpired'] === true
					? 'Its Auction Clock has passed, so the next close awards it.'
					: closes === null
						? ''
						: `Closes ${closes}.`;
			return (
				`${who} reinstated ${team}'s ${amount} Bid on ${player}, which leads again. ` +
				`${erasedSentence}${clock === '' ? '' : ` ${clock}`} Reason: ${reason}`
			);
		}

		case 'AuctionOpened': {
			const teams = payload['teams'];
			if (!Array.isArray(teams)) return null;
			const eligible = count(payload, 'minorLeagueEligibleCount');
			if (eligible === null) return null;
			return (
				`The Auction Phase is open with ${String(teams.length)} ${plural(teams.length, 'Team')} ` +
				`and ${String(eligible)} Minor League eligible ${plural(eligible, 'Player')}.`
			);
		}

		case 'ContractAssignmentOpened': {
			const terminated = ids(payload, 'terminatedPlayerIds');
			if (terminated === null) return null;
			const unbid =
				terminated.length === 0
					? 'Every nominated Player drew a Bid.'
					: `${String(terminated.length)} nominated ${plural(terminated.length, 'Player')} ended with no Bid.`;
			return `The Auction Phase has ended and Contract Assignment is open. ${unbid}`;
		}

		case 'AssignmentRemindersSent': {
			const deadline = text(payload, 'deadline');
			if (deadline === null) return null;
			// **This event files no channel-addressed intent** — see
			// `BROADCAST_EVENT_TYPES`. It is worded here because its MENTIONS
			// ride the same channel post, and the drain composes one notice per
			// event whether or not the channel itself was addressed. Without
			// this case the reminder would sit under
			// `A AssignmentRemindersSent was recorded (event #N).`
			//
			// **It states the deadline and NOTHING about who is late.** The
			// count belongs to `AssignmentDeadlinePassed`, which is a league-wide
			// fact once the deadline has actually elapsed. Publishing it an
			// interval EARLIER would name the Teams still working, in the
			// channel, before anything is owed — the reminder is addressed to
			// them by mention for that reason. Whoever is addressed already
			// knows it is them; nobody else needs a tally.
			return `The contract assignment deadline is ${deadline}.`;
		}

		case 'AssignmentDeadlinePassed': {
			const deadline = text(payload, 'deadline');
			if (deadline === null) return null;
			const outstanding = ids(payload, 'outstandingTeamIds');
			// An absent list is not a rendering this notice can vouch for: the
			// sentence below counts it, and a count nobody supplied would be an
			// invented figure. The fallback line is the honest answer.
			if (outstanding === null) return null;
			// **No urgency framing and no suggested action.** The deadline
			// passing changes no phase, blocks nothing and unlocks nothing, so
			// the line states the instant, states who was outstanding at it, and
			// stops. Zero outstanding Teams is an ordinary outcome and still
			// earns the line — it is the record that the deadline arrived.
			const who =
				outstanding.length === 0
					? 'Every Team had submitted its contract assignments.'
					: `${String(outstanding.length)} ${plural(outstanding.length, 'Team')} ` +
						`${outstanding.length === 1 ? 'has' : 'have'} Players with no contract length.`;
			return `The contract assignment deadline of ${deadline} has passed. ${who} No contract length was assigned by it.`;
		}

		default:
			return null;
	}
}

/**
 * `Team` / `Teams`. The noun alone — every sentence here is built so the verb
 * does not have to agree, which is what keeps the counted clauses readable at
 * zero as well as at thirty.
 */
function plural(quantity: number, noun: string): string {
	return quantity === 1 ? noun : `${noun}s`;
}

// --- The message ceiling --------------------------------------------------

/**
 * Discord's hard limit on `content`, in characters.
 *
 * A message over it is REJECTED, not truncated by Discord — so an unbounded
 * batch would fail the whole post, back off, and fail again identically
 * forever. `deferred-work.md` logged this as Story 5.1's open item and named
 * this story as its owner.
 */
export const DISCORD_MESSAGE_CEILING = 2000;

/** One notice per line. A wall of prose would be unreadable at a glance. */
const NOTICE_SEPARATOR = '\n';

/** What `broadcastBodyFor` composed, and how much of the batch it covers. */
export type BroadcastBody = {
	readonly body: string;
	/**
	 * How many of the notices, from the front, the body actually carries.
	 *
	 * The caller records an outcome for exactly these and leaves the rest
	 * pending — an intent with no recorded outcome is still pending, so an
	 * excluded notice goes out next pass for free. That is the same
	 * "re-derives, never remembers" property the drain already has.
	 */
	readonly included: number;
};

/**
 * Join whole notices up to the ceiling.
 *
 * **Whole notices, never a truncated batch.** Cutting the joined body at 2000
 * characters would deliver a half-sentence AND mark every intent in it
 * delivered, because the drain records an outcome per intent it posted.
 * Dropping the overflow instead costs nothing: those intents have no outcome,
 * so they are still pending and the next pass picks them up.
 *
 * **One notice that alone exceeds the ceiling is the one case that truncates**
 * — a draw with thirty contenders, say. It cannot be split and it cannot be
 * dropped, because an intent that can never be posted would stall the outbox
 * forever, and AD-17's promise is that a notice is never dropped. So it is cut
 * to fit and marked delivered, which is the only exit that terminates.
 */
export function broadcastBodyFor(
	notices: readonly string[],
	ceiling: number = DISCORD_MESSAGE_CEILING
): BroadcastBody {
	if (notices.length === 0) return { body: '', included: 0 };
	// A ceiling of zero or less can carry no notice at all. Reporting one as
	// included would hand the caller an empty — or ellipsis-only — body to post
	// and then mark that intent delivered, retiring a notice that said nothing.
	// Nothing included is the only answer that keeps the intent pending.
	if (ceiling <= 0) return { body: '', included: 0 };

	const included: string[] = [];
	let length = 0;
	for (const notice of notices) {
		const cost = (included.length === 0 ? 0 : NOTICE_SEPARATOR.length) + notice.length;
		if (length + cost > ceiling) break;
		included.push(notice);
		length += cost;
	}

	if (included.length === 0) {
		// The FIRST notice alone is over the ceiling. Truncate that one and
		// count it as included — see the header.
		return { body: truncateToFit(notices[0] ?? '', ceiling), included: 1 };
	}

	return { body: included.join(NOTICE_SEPARATOR), included: included.length };
}

/**
 * Cut to at most `ceiling` UTF-16 units, marking the cut with one ellipsis.
 *
 * **By code point, not by `slice`.** A JavaScript string is UTF-16, and
 * `slice` will happily cut between the two halves of a surrogate pair — an
 * emoji in a Team or a Manager name, which `managers.display_name` and
 * `teams.name` both permit — leaving a lone surrogate that renders as a
 * replacement character. `Array.from` iterates code points, so the cut can only
 * ever land between whole characters.
 *
 * The budget is still counted in UTF-16 units, because that is what Discord's
 * own 2000 limit counts. A code point outside the BMP therefore costs two, and
 * the result may come back one unit short of the ceiling rather than split a
 * character to fill it.
 */
function truncateToFit(notice: string, ceiling: number): string {
	if (ceiling <= 0) return '';
	if (notice.length <= ceiling) return notice;

	const budget = ceiling <= ELLIPSIS.length ? ceiling : ceiling - ELLIPSIS.length;
	let kept = '';
	for (const character of notice) {
		if (kept.length + character.length > budget) break;
		kept += character;
	}

	return ceiling <= ELLIPSIS.length ? kept : `${kept}${ELLIPSIS}`;
}
