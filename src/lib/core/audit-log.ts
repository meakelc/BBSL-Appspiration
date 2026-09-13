/**
 * The Audit Log's one normalisation (Story 7.5, FR-33, FR-41).
 *
 * `auction_events` has been insert-only and complete since Story 1.5 and
 * nineteen event types append to it, but nothing in `src/` has ever read it
 * for a human. This module is that reading: it turns one `AppendedEvent` into
 * one `AuditRow` — actor, instant, a sentence, detail rows, and the Team and
 * Player ids the filters match on — so the three filters work over ONE derived
 * shape rather than over nineteen payload shapes. Normalising first is what
 * keeps the route free of a switch and keeps the export identical to the page.
 *
 * **Completeness is the load-bearing property.** `RENDERERS` is a LOOKUP with a
 * total fallback, never a union: an `event_type` with no entry renders as its
 * envelope plus its raw payload, and is still counted, still filterable by its
 * own type and still exported. Dropping an unrecognised row is the one defect
 * this surface cannot have — `BidVoided` is declared at
 * `projection/league-clock.ts:108` and has never been emitted, and it must
 * render the day Story 7.2 emits it with no change here.
 *
 * **This does not contradict `types.ts:40-44`.** That rule forbids a central
 * DOMAIN union — a list a reducer must be added to. This is a rendering
 * registry, total by construction; a new event type ships without touching it
 * and renders plainly until somebody writes its sentence.
 *
 * **Every renderer is written from the DECLARED payload type**, read at the
 * anchor named in its own comment. `event_type` is free `text` and `payload`
 * is `jsonb`, so a renderer reading a key no emitter writes is not a type
 * error, not a test failure and not visible in a diff — only the declared type
 * stands between a wrong key and a blank row. Where a field the declared type
 * carries is deliberately NOT rendered, the omission is stated in a comment
 * rather than left to a silently-null read.
 *
 * **No raw id reaches the reader.** Where a payload carries a name this renders
 * it; where it carries only ids — `contenders`, `formerContenders`,
 * `outstandingTeamIds`, `ContentionDrawn`'s Player — the caller supplies
 * resolved names through `AuditReferences`, and an id that resolves to nothing
 * renders as a stated absence. The one place an id may still show is a filter
 * OPTION whose name is unresolved, and it is labelled as an id there.
 *
 * **No money rendering may throw.** `formatMoney` raises `RangeError` off the
 * $500,000 grid; here that would take the whole page down rather than one cell,
 * so `renderAuditAmount` tests `isOnMoneyGrid` first and falls back to
 * `formatExactDollars`.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { formatExactDollars, formatMoney, isOnMoneyGrid } from './money.ts';
import type { Money } from './money.ts';
import { formatTeamManager } from './team-identity.ts';
import {
	BID_CANCELLED_EVENT,
	BID_PLACED_EVENT,
	CONTENTION_DISSOLVED_EVENT,
	MINIMUM_BID_CONTENTION_LABEL
} from './projection/auctions.ts';
import type { ContentionState } from './projection/auctions.ts';
import {
	AUCTION_CLOSED_EVENT,
	AUCTION_TERMINATED_EVENT,
	NOMINATION_PLACED_EVENT
} from './projection/nominations.ts';
import { CONTENTION_DRAWN_EVENT } from './projection/draws.ts';
import { AUCTION_OPENED_EVENT, CONTRACT_ASSIGNMENT_OPENED_EVENT } from './projection/phase.ts';
import {
	CONTRACT_LENGTH_ASSIGNED_EVENT,
	DROP_RECORDED_EVENT,
	ROSTER_REARRANGED_EVENT,
	ROSTER_TRADE_RECORDED_EVENT
} from './projection/contracts.ts';
import { MINOR_LEAGUE_ELIGIBILITY_SET } from './projection/eligibility.ts';
import { ASSIGNMENTS_SUBMITTED_EVENT } from './projection/assignments.ts';
import {
	ASSIGNMENT_DEADLINE_PASSED_EVENT,
	ASSIGNMENT_DEADLINE_SET_EVENT,
	ASSIGNMENT_REMINDERS_SENT_EVENT,
	ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT
} from './projection/assignment-deadline.ts';
import { IMPORT_PROMOTED_EVENT } from './projection/promotion.ts';
import { BID_VOIDED_EVENT } from './projection/league-clock.ts';
import { SEED_COMMITMENT_LABEL, SEED_REVEALED_LABEL } from './projection/closed.ts';
import type { AppendedEvent, RosterSlotKind } from './types.ts';

// --- The surface's own words -----------------------------------------------

/** The page title and the destination's own label. */
export const AUDIT_LOG_TITLE = 'Audit Log';

/** What the surface says of itself, above the rows. */
export const AUDIT_LOG_STATEMENT =
	'Every event this League has recorded, newest first. Nothing on this page can be edited, corrected or removed.';

/** The designed empty state — a League that has recorded nothing yet. */
export const EMPTY_LOG_HEADING = 'Nothing has been recorded yet';
export const EMPTY_LOG_STATEMENT =
	'The Log is empty. That is not a failure: no event has been appended to this League yet.';

/** What a filter that matches nothing says. Never a blank page. */
export const NO_MATCHES_HEADING = 'No entries match';
export const NO_MATCHES_STATEMENT =
	'The Log holds entries, but none of them match the filters in force. Widen a filter to see more.';

/** A Team, Player or Manager whose id no reference row answers for. */
export const UNNAMED_TEAM = 'a Team this log no longer names';
export const UNNAMED_PLAYER = 'a Player this log no longer names';
export const UNNAMED_MANAGER = 'a Manager this log no longer names';

/** How an unattributed event is attributed. Never to the Commissioner. */
export const SYSTEM_ACTOR = 'The system';

/** The separator between a before figure and the after figure beside it. */
const TO = ' → ';

/** How a list of named parties is joined inside one detail cell. */
const LIST_SEPARATOR = ', ';

/** What a list with nothing in it says, rather than an empty cell. */
const EMPTY_LIST = 'None';

/** The three query parameters, spelled once. */
export const AUDIT_FILTER_KEYS = Object.freeze({
	team: 'team',
	player: 'player',
	type: 'type'
} as const);

/** What the "no filter" option on each control reads. */
export const ANY_OPTION_LABEL = 'Any';

/** The legends the three filter controls carry. */
export const AUDIT_FILTER_LEGENDS = Object.freeze({
	team: 'Team',
	player: 'Player',
	type: 'Event'
} as const);

/** The one submit on the filter form. It re-reads the Log and mutates nothing. */
export const APPLY_FILTERS_LABEL = 'Apply filters';

/** The export link's own words and the file it produces. */
export const AUDIT_EXPORT_LABEL = 'Download these entries as CSV';
export const AUDIT_EXPORT_PATH = '/audit-log/export';

// --- Machine tokens, worded ------------------------------------------------

/**
 * The four `RosterSlotKind` tokens, worded.
 *
 * `types.ts:162,185` are DATABASE literals — `active_bench` is a check
 * constraint's spelling, not a thing to show a Manager — and this is the one
 * place in the Log that translates them. `SlotPlacement` is a narrowing of the
 * same union, so it needs no second table.
 */
export const SLOT_KIND_WORDS: Readonly<Record<RosterSlotKind, string>> = Object.freeze({
	active_bench: 'Active/Bench',
	injury_reserve: 'Injury Reserve',
	minor_league: 'Minor League',
	dead_money: 'Dead Money'
});

/**
 * The three `ContentionState` tokens, worded
 * (`projection/auctions.ts:151`). `minimum_bid` borrows the League's own
 * label rather than spelling a synonym of it.
 *
 * Typed against the UNION and not against `Record<string, string>`, exactly as
 * `SLOT_KIND_WORDS` is: a renamed or added member is then a compile error here
 * rather than a token that quietly reaches a Manager through `wordToken`'s
 * unrecognised-value branch. That discipline is the whole reason this story
 * exists.
 */
export const CONTENTION_WORDS: Readonly<Record<ContentionState, string>> = Object.freeze({
	awaiting_opening_bid: 'No Bid had been placed',
	standard: 'Standard',
	minimum_bid: MINIMUM_BID_CONTENTION_LABEL
});

/**
 * Word a token, or state that the Log does not recognise it.
 *
 * Total over `unknown` on purpose: a machine token is exactly the kind of
 * value a historical payload may hold a spelling of that this table has never
 * seen, and a raw `active_bench` reaching a Manager is the defect.
 */
function wordToken(words: Readonly<Record<string, string>>, value: unknown): string | null {
	if (typeof value !== 'string' || value === '') return null;
	return words[value] ?? `an unrecognised value (${value})`;
}

// --- Reading an untyped payload safely -------------------------------------

/** One field of a rendered entry: a label, and what it says. */
export type AuditDetail = {
	readonly label: string;
	readonly value: string;
};

/**
 * A payload as this module may read it.
 *
 * `AppendedEvent.payload` is `unknown` because the column is `jsonb` and
 * nothing guarantees an object — a historical row may hold a string, a number
 * or `null`. Every reader below goes through these helpers rather than
 * indexing, so a non-object payload produces a row with no detail rows rather
 * than a thrown `TypeError` that would take the page down.
 */
type Payload = Readonly<Record<string, unknown>>;

/** The empty record for any payload that is not a plain object. */
const NO_FIELDS: Payload = Object.freeze({});

function asPayload(value: unknown): Payload {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return NO_FIELDS;
	return value as Payload;
}

/** A non-empty string field, or `null`. Never a coerced `String(...)`. */
function text(payload: Payload, key: string): string | null {
	const value = payload[key];
	return typeof value === 'string' && value !== '' ? value : null;
}

/** A finite number field, or `null`. */
function count(payload: Payload, key: string): number | null {
	const value = payload[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A boolean field, or `null` — distinct from `false`. */
function flag(payload: Payload, key: string): boolean | null {
	const value = payload[key];
	return typeof value === 'boolean' ? value : null;
}

/** A list of non-empty strings, in the payload's own order. */
function textList(payload: Payload, key: string): readonly string[] {
	const value = payload[key];
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/** A list of objects, in the payload's own order. */
function payloadList(payload: Payload, key: string): readonly Payload[] {
	const value = payload[key];
	if (!Array.isArray(value)) return [];
	return value.map((entry) => asPayload(entry));
}

// --- Money, without a throw ------------------------------------------------

/**
 * Render an amount for the Log: `$14.5M` on the grid, exact dollars off it.
 *
 * `formatMoney` throws `RangeError` for an amount that is not a multiple of
 * `MINIMUM_INCREMENT` (`money.ts:169-187`). An off-grid figure is real — the
 * CSV roster importer asserts no grid, so an imported Cap Hit carries whatever
 * Fantrax held — and on this surface a throw would take the WHOLE page down
 * rather than one cell. So the grid is tested first, exactly as
 * `money.ts:145-158` intends `isOnMoneyGrid` to be used, and the diagnostic
 * renderer answers everything it refuses.
 *
 * Not `toExportDollars`: `money.ts:229-239` reserves that brand for the
 * Fantrax round-trip, where `$14.5M` in a cell would corrupt an import. This
 * is a record of what the Log SAID, read by a human, on the page and in the
 * CSV alike.
 */
export function renderAuditAmount(amount: number): string {
	const money = amount as Money;
	return isOnMoneyGrid(money) ? formatMoney(money) : formatExactDollars(money);
}

/** An amount field rendered, or `null` when the payload carries no number. */
function amount(payload: Payload, key: string): string | null {
	const value = count(payload, key);
	return value === null ? null : renderAuditAmount(value);
}

// --- Resolved reference data -----------------------------------------------

/**
 * The names the Log needs and the log itself cannot supply.
 *
 * Every map is id -> name, resolved by `server/audit-log.ts` in ONE batched
 * statement each over every party id any row names — never one statement per
 * row. The core stays pure: it is handed answers, it never asks.
 */
export type AuditReferences = {
	readonly teamNames: ReadonlyMap<string, string>;
	readonly playerNames: ReadonlyMap<string, string>;
	readonly managerNames: ReadonlyMap<string, string>;
};

/** The references a first pass runs with, to learn which ids to resolve. */
export const NO_REFERENCES: AuditReferences = Object.freeze({
	teamNames: new Map<string, string>(),
	playerNames: new Map<string, string>(),
	managerNames: new Map<string, string>()
});

/**
 * A Team, named: the payload's own name where it carries one, the resolved
 * name where it does not, and a stated absence where neither answers.
 *
 * A Team is spelled out and never abbreviated (`team-identity.ts:4-6`): a
 * three-letter abbreviation on this surface means a Player's real-life NBA
 * team and nothing else.
 */
function teamNamed(refs: AuditReferences, teamId: string | null, stated: string | null): string {
	if (stated !== null) return stated;
	if (teamId === null) return UNNAMED_TEAM;
	return refs.teamNames.get(teamId) ?? UNNAMED_TEAM;
}

/** A Player, named — the payload's own name first, then the resolved one. */
function playerNamed(
	refs: AuditReferences,
	fantraxPlayerId: string | null,
	stated: string | null
): string {
	if (stated !== null) return stated;
	if (fantraxPlayerId === null) return UNNAMED_PLAYER;
	return refs.playerNames.get(fantraxPlayerId) ?? UNNAMED_PLAYER;
}

/** A list of Team ids, named and joined — `None` for an empty list. */
function teamsNamed(refs: AuditReferences, teamIds: readonly string[]): string {
	if (teamIds.length === 0) return EMPTY_LIST;
	return teamIds.map((id) => teamNamed(refs, id, null)).join(LIST_SEPARATOR);
}

/** A list of Player ids, named and joined — `None` for an empty list. */
function playersNamed(refs: AuditReferences, playerIds: readonly string[]): string {
	if (playerIds.length === 0) return EMPTY_LIST;
	return playerIds.map((id) => playerNamed(refs, id, null)).join(LIST_SEPARATOR);
}

// --- What one renderer produces --------------------------------------------

/**
 * One event's rendering, before the envelope is put around it.
 *
 * `teams` and `players` are the PARTIES — every Team and Player the entry
 * names, whether or not the sentence spells them out. They are what the two
 * id filters match on, which is why a Team released by a dissolution finds
 * that row under its own filter exactly as a Team on either side of a Roster
 * Trade finds that one.
 */
type AuditRender = {
	readonly headline: string;
	readonly details: readonly AuditDetail[];
	readonly teams: readonly string[];
	readonly players: readonly string[];
};

type AuditRenderer = (payload: Payload, refs: AuditReferences) => AuditRender;

/** One registry entry: the noun a reader reads, and how the entry renders. */
type AuditEntry = {
	readonly label: string;
	readonly render: AuditRenderer;
};

/** Drop the `null`s a defensive read produces, keeping the stated rows. */
function rows(...entries: ReadonlyArray<AuditDetail | null>): readonly AuditDetail[] {
	return entries.filter((entry): entry is AuditDetail => entry !== null);
}

/** A detail row, or nothing at all when the payload carries no value. */
function row(label: string, value: string | null): AuditDetail | null {
	return value === null ? null : { label, value };
}

/** The distinct members of a list, in first-seen order (AD-1's discipline). */
function distinct(values: ReadonlyArray<string | null | undefined>): readonly string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const value of values) {
		if (typeof value !== 'string' || value === '' || seen.has(value)) continue;
		seen.add(value);
		ordered.push(value);
	}
	return ordered;
}

// --- The renderers, one per declared payload type ---------------------------

/**
 * `BidPlaced` — `rules/bidding.ts:3559`.
 *
 * `managerId` is deliberately NOT a detail row: it restates the envelope's
 * actor, which the entry already renders as its actor. `seedHash` is the
 * COMMIT half of AD-14 and is rendered; the raw seed is not in this payload
 * and never reaches this surface from it.
 */
function renderBidPlaced(payload: Payload, refs: AuditReferences): AuditRender {
	const teamId = text(payload, 'teamId');
	const fantraxPlayerId = text(payload, 'fantraxPlayerId');
	const team = teamNamed(refs, teamId, text(payload, 'teamName'));
	// No `playerName` on this payload — the name is resolved, never invented.
	const player = playerNamed(refs, fantraxPlayerId, null);
	return {
		headline: `${team} bid on ${player}.`,
		details: rows(
			row('Amount', amount(payload, 'amount')),
			row('Auction closes', text(payload, 'closesAt')),
			row(SEED_COMMITMENT_LABEL, text(payload, 'seedHash'))
		),
		teams: distinct([teamId]),
		players: distinct([fantraxPlayerId])
	};
}

/**
 * `ContentionDissolved` — `rules/bidding.ts:3628`.
 *
 * There is NO `teamId`/`teamName` on this payload. The converting Team is
 * `convertingTeamId` and its name is resolved. `formerContenders` is the
 * Contender list as it STOOD, unfiltered — the converting Team is on it — so
 * it is rendered as that rather than as "the Teams released", and every id on
 * it becomes a party so a released Team finds this row under its own filter.
 */
function renderContentionDissolved(payload: Payload, refs: AuditReferences): AuditRender {
	const fantraxPlayerId = text(payload, 'fantraxPlayerId');
	const convertingTeamId = text(payload, 'convertingTeamId');
	const formerContenders = textList(payload, 'formerContenders');
	const converting = teamNamed(refs, convertingTeamId, null);
	const player = playerNamed(refs, fantraxPlayerId, null);
	return {
		headline: `${converting} dissolved the ${MINIMUM_BID_CONTENTION_LABEL} on ${player}.`,
		details: rows(
			row('Converting amount', amount(payload, 'amount')),
			row(SEED_REVEALED_LABEL, text(payload, 'seed')),
			row(SEED_COMMITMENT_LABEL, text(payload, 'seedHash')),
			row('Contenders as they stood', teamsNamed(refs, formerContenders))
		),
		teams: distinct([convertingTeamId, ...formerContenders]),
		players: distinct([fantraxPlayerId])
	};
}

/**
 * `BidCancelled` — `rules/close.ts:675`.
 *
 * `restoration` is a nested `Restoration` (`projection/auctions.ts:246`) and
 * carries a Team this entry must name AND make a party: a Team handed the lead
 * by a cancellation it was not otherwise in must find this row under its own
 * filter. `restoration.seq` and `restoration.managerId` are not rendered —
 * `cancelledSeq` is the log position a reader needs, and the restored Manager
 * is named through the Team pairing rather than as a second bare row. The
 * payload's own `managerId` restates the envelope's actor, which the entry
 * already renders as its actor, so it is not a row either.
 */
function renderBidCancelled(payload: Payload, refs: AuditReferences): AuditRender {
	const fantraxPlayerId = text(payload, 'fantraxPlayerId');
	const teamId = text(payload, 'teamId');
	const causeFantraxPlayerId = text(payload, 'causeFantraxPlayerId');
	const causeTeamId = text(payload, 'causeTeamId');
	const restoration = asPayload(payload['restoration']);
	const restoredTeamId = text(restoration, 'teamId');
	const restoredTeamName = text(restoration, 'teamName');
	const team = teamNamed(refs, teamId, text(payload, 'teamName'));
	const player = playerNamed(refs, fantraxPlayerId, text(payload, 'playerName'));
	const wasEntry = flag(payload, 'wasContentionEntry');

	const restoredAmount = amount(restoration, 'amount');
	const restored =
		restoredTeamId === null && restoredTeamName === null
			? 'No Bid was restored'
			: `${teamNamed(refs, restoredTeamId, restoredTeamName)}${
					restoredAmount === null ? '' : ` at ${restoredAmount}`
				}`;

	return {
		headline: `${team}'s bid on ${player} was cancelled.`,
		details: rows(
			row('Amount released', amount(payload, 'amount')),
			row('Cancelled entry', text(payload, 'cancelledSeq')),
			row(
				`Was a ${MINIMUM_BID_CONTENTION_LABEL} entry`,
				wasEntry === null ? null : wasEntry ? 'Yes' : 'No'
			),
			row(
				'Caused by the close of',
				playerNamed(refs, causeFantraxPlayerId, text(payload, 'causePlayerName'))
			),
			row('Won at that close by', teamNamed(refs, causeTeamId, null)),
			row('Leading now', restored)
		),
		teams: distinct([teamId, causeTeamId, restoredTeamId]),
		players: distinct([fantraxPlayerId, causeFantraxPlayerId])
	};
}

/**
 * `AuctionClosed` — `rules/close.ts:525`.
 *
 * `contractYears` is typed `null` at a close (FR-21) and is rendered as the
 * stated absence rather than omitted, because "unset" is the fact Epic 6 later
 * changes. `placement` and `contention` are machine tokens and are worded.
 * `managerId` restates the envelope actor and is not a row of its own.
 */
function renderAuctionClosed(payload: Payload, refs: AuditReferences): AuditRender {
	const teamId = text(payload, 'teamId');
	const fantraxPlayerId = text(payload, 'fantraxPlayerId');
	const team = teamNamed(refs, teamId, text(payload, 'teamName'));
	const player = playerNamed(refs, fantraxPlayerId, text(payload, 'playerName'));
	const years = count(payload, 'contractYears');
	return {
		headline: `${team} won ${player}.`,
		details: rows(
			row('Winning amount', amount(payload, 'winningAmount')),
			row('Cap Hit', amount(payload, 'capHit')),
			row('Placement', wordToken(SLOT_KIND_WORDS, payload['placement'])),
			row('Contention', wordToken(CONTENTION_WORDS, payload['contention'])),
			row('Contract length', years === null ? 'Not yet assigned' : `${String(years)} years`),
			row('Auction closed at', text(payload, 'closedAt'))
		),
		teams: distinct([teamId]),
		players: distinct([fantraxPlayerId])
	};
}

/**
 * `AuctionTerminated` — `rules/phase-end.ts:138`.
 *
 * There is NO `reason` on this payload and none is invented. The Team named is
 * the NOMINATING Team, which gets its Nomination Slot back; `managerId` is
 * nullable here and restates the envelope actor, so it is not a row.
 */
function renderAuctionTerminated(payload: Payload, refs: AuditReferences): AuditRender {
	const teamId = text(payload, 'teamId');
	const fantraxPlayerId = text(payload, 'fantraxPlayerId');
	const player = playerNamed(refs, fantraxPlayerId, text(payload, 'playerName'));
	return {
		headline: `The Auction on ${player} expired with no winner.`,
		details: rows(
			row('Nominating Team', teamNamed(refs, teamId, text(payload, 'teamName'))),
			row('Due at', text(payload, 'expiredAt')),
			row('Evaluated at', text(payload, 'evaluatedAt'))
		),
		teams: distinct([teamId]),
		players: distinct([fantraxPlayerId])
	};
}

/**
 * `ContentionDrawn` — `rules/close.ts:579-615`, the drawn and undrawn shapes.
 *
 * There is NO `playerName`: the Player is resolved. The union makes a
 * half-drawn row unrepresentable, so the winner is read as ONE decision —
 * `winningTeamId` present or absent — rather than field by field. `contenders`
 * renders in the payload's own order because AD-14 makes that order an INPUT
 * to the winner, and every id on it is a party.
 */
function renderContentionDrawn(payload: Payload, refs: AuditReferences): AuditRender {
	const fantraxPlayerId = text(payload, 'fantraxPlayerId');
	const contenders = textList(payload, 'contenders');
	const winningTeamId = text(payload, 'winningTeamId');
	const winningTeamName = text(payload, 'winningTeamName');
	const player = playerNamed(refs, fantraxPlayerId, null);
	const drawn = winningTeamId !== null || winningTeamName !== null;
	const selectedIndex = count(payload, 'selectedIndex');

	const common = rows(
		row(SEED_REVEALED_LABEL, text(payload, 'seed')),
		row(SEED_COMMITMENT_LABEL, text(payload, 'seedHash')),
		row('Contenders, in draw order', teamsNamed(refs, contenders)),
		// `drawnAt` is the AUCTION's own persisted expiry and never the
		// transaction clock (`rules/close.ts:598-599`) — but it is not the same
		// clock as the League Clock expiry `AuctionTerminated` and
		// `ContractAssignmentOpened` file under `Due at`, and one word over two
		// clocks is what an auditor cannot afford. It carries its own label.
		row('Auction due at', text(payload, 'drawnAt'))
	);

	if (!drawn) {
		return {
			// The lottery every Contender was cancelled from (Story 10.5): the
			// seed is revealed and the commitment discharged, and there is no
			// winner to name rather than a winner this entry withholds.
			headline: `The ${MINIMUM_BID_CONTENTION_LABEL} on ${player} dissolved with no winner.`,
			details: common,
			teams: distinct(contenders),
			players: distinct([fantraxPlayerId])
		};
	}

	const winner = teamNamed(refs, winningTeamId, winningTeamName);
	return {
		headline: `The ${MINIMUM_BID_CONTENTION_LABEL} on ${player} drew ${winner}.`,
		details: [
			...common,
			// The 0-based position, stated as the number a Manager who ran the
			// procedure by hand actually holds. `winningManagerId` is not a row
			// of its own: the winning Manager is named through the Team pairing.
			...rows(
				row('Selected position', selectedIndex === null ? null : String(selectedIndex)),
				row('Selected', winner)
			)
		],
		teams: distinct([...contenders, winningTeamId]),
		players: distinct([fantraxPlayerId])
	};
}

/** `NominationPlaced` — `server/nomination.ts:129`. */
function renderNominationPlaced(payload: Payload, refs: AuditReferences): AuditRender {
	const teamId = text(payload, 'teamId');
	const fantraxPlayerId = text(payload, 'fantraxPlayerId');
	const team = teamNamed(refs, teamId, text(payload, 'teamName'));
	const player = playerNamed(refs, fantraxPlayerId, text(payload, 'playerName'));
	return {
		headline: `${team} nominated ${player}.`,
		// `managerId` restates the envelope actor and is not repeated here.
		details: rows(row('Nominated by', team)),
		teams: distinct([teamId]),
		players: distinct([fantraxPlayerId])
	};
}

/**
 * `AuctionOpened` — `server/auction-open.ts:67`.
 *
 * There is NO `openedAt` on this payload: the envelope's own instant is when
 * the auction opened, and the entry already renders it.
 */
function renderAuctionOpened(payload: Payload, refs: AuditReferences): AuditRender {
	const teams = payloadList(payload, 'teams');
	const eligible = count(payload, 'minorLeagueEligibleCount');
	const named =
		teams.length === 0
			? EMPTY_LIST
			: teams
					.map((team) => teamNamed(refs, text(team, 'teamId'), text(team, 'teamName')))
					.join(LIST_SEPARATOR);
	return {
		headline: 'The Auction Phase opened.',
		details: rows(
			row('Teams', named),
			row('Minor League Eligible Players', eligible === null ? null : String(eligible))
		),
		teams: distinct(teams.map((team) => text(team, 'teamId'))),
		players: []
	};
}

/**
 * `ContractAssignmentOpened` — `rules/phase-end.ts:168`.
 *
 * There is NO `terminatedCount`: the count is the length of
 * `terminatedPlayerIds`, and the ids themselves are parties so a terminated
 * Player finds this row under their own filter.
 */
function renderContractAssignmentOpened(payload: Payload, refs: AuditReferences): AuditRender {
	const terminated = textList(payload, 'terminatedPlayerIds');
	return {
		headline: 'The Contract Assignment Phase opened.',
		details: rows(
			row('Due at', text(payload, 'expiredAt')),
			row('Evaluated at', text(payload, 'evaluatedAt')),
			row('Players terminated', playersNamed(refs, terminated))
		),
		teams: [],
		players: distinct(terminated)
	};
}

/** `ContractLengthAssigned` — `projection/contracts.ts:114`. */
function renderContractLengthAssigned(payload: Payload, refs: AuditReferences): AuditRender {
	const teamId = text(payload, 'teamId');
	const fantraxPlayerId = text(payload, 'fantraxPlayerId');
	const team = teamNamed(refs, teamId, text(payload, 'teamName'));
	const player = playerNamed(refs, fantraxPlayerId, text(payload, 'playerName'));
	const years = count(payload, 'contractYears');
	return {
		headline: `${team} assigned a contract length to ${player}.`,
		// `managerId` restates the envelope actor and is not repeated here.
		details: rows(row('Contract length', years === null ? null : `${String(years)} years`)),
		teams: distinct([teamId]),
		players: distinct([fantraxPlayerId])
	};
}

/**
 * One `RosterActTeamFigures` pair — `projection/contracts.ts:452-471`.
 *
 * FR-41's "before-state and after-state for both Teams" is these figures per
 * side, and every one of them renders as `before → after` on one row so nobody
 * has to hold two numbers in their head to see what changed. `teamId` and
 * `teamName` on the figures are the Team the block is headed by, so they are
 * the block's label rather than rows inside it.
 */
function figureRows(label: string, before: Payload, after: Payload): readonly AuditDetail[] {
	const pair = (field: string, render: (side: Payload) => string | null): AuditDetail | null => {
		const left = render(before);
		const right = render(after);
		if (left === null && right === null) return null;
		return {
			label: `${label} — ${field}`,
			value: `${left ?? '—'}${TO}${right ?? '—'}`
		};
	};
	const whole = (key: string) => (side: Payload) => {
		const value = count(side, key);
		return value === null ? null : String(value);
	};
	return rows(
		pair('Cap Space', (side) => amount(side, 'capSpace')),
		pair('Roster Count', whole('rosterCount')),
		pair(SLOT_KIND_WORDS.injury_reserve, whole('injuryReserveOccupied')),
		pair(SLOT_KIND_WORDS.minor_league, whole('minorLeagueOccupied'))
	);
}

/**
 * One `RosterTradeTransfer` — `projection/contracts.ts:426`.
 *
 * NOT an event type of its own: it is an element of `RosterMoveRecorded`'s
 * `transfers`, and the Code Map lists it separately because its fields must
 * each be rendered. `won` is the Existing-Contract-versus-Auction-Contract
 * distinction the epic requires be visible, so it is WORDED rather than shown
 * as a boolean; `fromPlacement`/`toPlacement` are `RosterSlotKind` tokens and
 * are worded; `winningAmount` stands beside the two CHARGED cap hits unchanged
 * (AD-23), and `clearedContractYears` states what the Trade cleared.
 */
function transferRow(transfer: Payload, refs: AuditReferences): AuditDetail {
	const player = playerNamed(refs, text(transfer, 'fantraxPlayerId'), text(transfer, 'playerName'));
	const won = flag(transfer, 'won');
	const from = teamNamed(refs, text(transfer, 'fromTeamId'), text(transfer, 'fromTeamName'));
	const to = teamNamed(refs, text(transfer, 'toTeamId'), text(transfer, 'toTeamName'));
	const fromPlacement = wordToken(SLOT_KIND_WORDS, transfer['fromPlacement']);
	const toPlacement = wordToken(SLOT_KIND_WORDS, transfer['toPlacement']);
	const capBefore = amount(transfer, 'capHitBefore');
	const capAfter = amount(transfer, 'capHitAfter');
	const winning = amount(transfer, 'winningAmount');
	const cleared = count(transfer, 'clearedContractYears');

	const parts: string[] = [`${from}${TO}${to}`];
	if (won !== null) parts.push(won ? 'Auction Contract' : 'Existing Contract');
	if (fromPlacement !== null || toPlacement !== null) {
		parts.push(`${fromPlacement ?? '—'}${TO}${toPlacement ?? '—'}`);
	}
	if (capBefore !== null || capAfter !== null) {
		parts.push(`Cap Hit ${capBefore ?? '—'}${TO}${capAfter ?? '—'}`);
	}
	if (winning !== null) parts.push(`Won for ${winning}`);
	parts.push(
		cleared === null ? 'No assigned contract length cleared' : `Cleared ${String(cleared)} years`
	);
	return { label: player, value: parts.join(LIST_SEPARATOR) };
}

/**
 * `RosterMoveRecorded` — `projection/contracts.ts:473`.
 *
 * ONE entry, not two: `projection/contracts.ts:461-471` states that this
 * payload IS the audit entry, and both Teams' figures sit on it precisely so a
 * Trade reads as one act. FR-41 deliberately does not broadcast a Trade to
 * Discord, which is what makes this the only surface it can be looked up on.
 */
function renderRosterTrade(payload: Payload, refs: AuditReferences): AuditRender {
	const sendingTeamId = text(payload, 'sendingTeamId');
	const receivingTeamId = text(payload, 'receivingTeamId');
	const sending = teamNamed(refs, sendingTeamId, text(payload, 'sendingTeamName'));
	const receiving = teamNamed(refs, receivingTeamId, text(payload, 'receivingTeamName'));
	const transfers = payloadList(payload, 'transfers');

	return {
		headline: `${sending} and ${receiving} recorded a Roster Trade.`,
		details: [
			// The Commissioner's stated reason, verbatim and first — it is what
			// FR-41 requires the record carry, and the first thing a reader wants.
			...rows(row('Reason', text(payload, 'reason'))),
			...transfers.map((transfer) => transferRow(transfer, refs)),
			...figureRows(
				sending,
				asPayload(payload['sendingBefore']),
				asPayload(payload['sendingAfter'])
			),
			...figureRows(
				receiving,
				asPayload(payload['receivingBefore']),
				asPayload(payload['receivingAfter'])
			)
		],
		teams: distinct([
			sendingTeamId,
			receivingTeamId,
			...transfers.flatMap((transfer) => [text(transfer, 'fromTeamId'), text(transfer, 'toTeamId')])
		]),
		players: distinct(transfers.map((transfer) => text(transfer, 'fantraxPlayerId')))
	};
}

/**
 * One `DroppedContract` — `projection/contracts.ts`'s `DroppedContract`.
 *
 * NOT an event type of its own: it is an element of `DropRecorded`'s
 * `released`. The Slot he LEFT is stated because the Drop freed it, and what
 * is CARRIED is stated beside what he was charging — the two differ only for
 * the two cases that leave nothing behind, and FR-43's whole subtlety is that
 * they look identical on the Cap until you read this row.
 *
 * **"Released to nothing" is worded, never inferred from a `$0`.** A Minor
 * League row was charging `$0` already and a full-term second-round rookie
 * deal is released to `$0` by the exception; both leave no Dead Money, and
 * the round and the term are printed so a later reading can see which of the
 * two happened rather than guess.
 */
function releaseRow(release: Payload, refs: AuditReferences): AuditDetail {
	const player = playerNamed(refs, text(release, 'fantraxPlayerId'), text(release, 'playerName'));
	const from = wordToken(SLOT_KIND_WORDS, release['fromPlacement']);
	const charged = amount(release, 'chargedCapHit');
	const dead = amount(release, 'deadMoney');
	const removed = flag(release, 'removed');
	const round = count(release, 'rookieScaleRound');
	const years = count(release, 'contractYearsRemaining');

	const parts: string[] = [];
	if (from !== null) parts.push(`Left ${from}`);
	if (charged !== null) parts.push(`Was charging ${charged}`);
	parts.push(
		dead === null
			? 'Dead Money —'
			: removed === true
				? `No Dead Money carried; the Contract was removed and ${charged ?? dead} returned to Cap Space`
				: `Dead Money ${dead}`
	);
	if (round !== null) parts.push(`Round ${String(round)} rookie scale`);
	if (years !== null) parts.push(`${String(years)} years remaining`);
	return { label: player, value: parts.join(LIST_SEPARATOR) };
}

/**
 * `DropRecorded` — `projection/contracts.ts`'s `DropRecordedPayload`.
 *
 * ONE entry however many Players were released, because a Drop is one act
 * evaluated once. FR-43 does not broadcast a Drop to Discord, which makes
 * this the only surface it can be looked up on — so the reason comes first
 * and verbatim, then each Player, then the Team's before → after.
 */
function renderDrop(payload: Payload, refs: AuditReferences): AuditRender {
	const teamId = text(payload, 'teamId');
	const team = teamNamed(refs, teamId, text(payload, 'teamName'));
	const released = payloadList(payload, 'released');

	return {
		headline: `${team} recorded a Drop.`,
		details: [
			// The Commissioner's stated reason, verbatim and first — it is what
			// FR-43 requires the record carry, and the first thing a reader wants.
			...rows(row('Reason', text(payload, 'reason'))),
			...released.map((release) => releaseRow(release, refs)),
			...figureRows(team, asPayload(payload['teamBefore']), asPayload(payload['teamAfter']))
		],
		teams: distinct([teamId]),
		players: distinct(released.map((release) => text(release, 'fantraxPlayerId')))
	};
}

/** `MinorLeagueEligibilitySet` — `projection/eligibility.ts:49`. */
function renderEligibilitySet(payload: Payload, refs: AuditReferences): AuditRender {
	const fantraxPlayerId = text(payload, 'fantraxPlayerId');
	const player = playerNamed(refs, fantraxPlayerId, text(payload, 'playerName'));
	const before = flag(payload, 'before');
	const after = flag(payload, 'after');
	const word = (value: boolean | null) =>
		value === null ? '—' : value ? 'Eligible' : 'Not eligible';
	return {
		headline: `${player}'s ${SLOT_KIND_WORDS.minor_league} Eligibility was set.`,
		details: rows(
			before === null && after === null
				? null
				: { label: 'Eligibility', value: `${word(before)}${TO}${word(after)}` }
		),
		teams: [],
		players: distinct([fantraxPlayerId])
	};
}

/** `AssignmentsSubmitted` — `projection/assignments.ts:44`. */
function renderAssignmentsSubmitted(payload: Payload, refs: AuditReferences): AuditRender {
	const teamId = text(payload, 'teamId');
	const team = teamNamed(refs, teamId, text(payload, 'teamName'));
	const assigned = count(payload, 'assignedCount');
	return {
		headline: `${team} submitted their contract assignments as final.`,
		// `managerId` restates the envelope actor and is not repeated here.
		details: rows(row('Contracts submitted', assigned === null ? null : String(assigned))),
		teams: distinct([teamId]),
		players: []
	};
}

/** `AssignmentDeadlineSet` — `projection/assignment-deadline.ts:76`. */
function renderDeadlineSet(payload: Payload, refs: AuditReferences): AuditRender {
	const teamId = text(payload, 'teamId');
	const team = teamNamed(refs, teamId, text(payload, 'teamName'));
	const previous = text(payload, 'previousDeadline');
	const deadline = text(payload, 'deadline');
	return {
		headline: 'The contract assignment deadline was set.',
		// `managerId` restates the envelope actor and is not repeated here.
		details: rows(
			deadline === null && previous === null
				? null
				: {
						label: 'Deadline',
						value: `${previous ?? 'None'}${TO}${deadline ?? '—'}`
					},
			row('Set against', text(payload, 'setAt')),
			row('Set by', team)
		),
		teams: distinct([teamId]),
		players: []
	};
}

/** `AssignmentReminderIntervalSet` — `projection/assignment-deadline.ts:87`. */
function renderReminderIntervalSet(payload: Payload, refs: AuditReferences): AuditRender {
	const teamId = text(payload, 'teamId');
	const team = teamNamed(refs, teamId, text(payload, 'teamName'));
	const hours = count(payload, 'intervalHours');
	const previous = count(payload, 'previousIntervalHours');
	const word = (value: number | null, absent: string) =>
		value === null ? absent : `${String(value)} hours`;
	return {
		headline: 'The assignment reminder interval was set.',
		// `managerId` restates the envelope actor and is not repeated here.
		details: rows(
			hours === null && previous === null
				? null
				: {
						label: 'Reminder interval',
						value: `${word(previous, 'None')}${TO}${word(hours, '—')}`
					},
			row('Set by', team)
		),
		teams: distinct([teamId]),
		players: []
	};
}

/**
 * `AssignmentRemindersSent` and `AssignmentDeadlinePassed` — ONE payload shape
 * for both markers, `projection/assignment-deadline.ts:107`.
 *
 * `outstandingTeamIds` carries ids and no names, so the names are resolved and
 * every id becomes a party: a Team that was outstanding finds these markers
 * under its own filter. Both markers are system-originated — a tick compared a
 * clock, nobody acted — so their envelopes carry the null actor pair.
 */
function markerRenderer(headline: string): AuditRenderer {
	return (payload, refs) => {
		const outstanding = textList(payload, 'outstandingTeamIds');
		const players = count(payload, 'outstandingPlayerCount');
		return {
			headline,
			details: rows(
				row('Deadline', text(payload, 'deadline')),
				row('Teams outstanding', teamsNamed(refs, outstanding)),
				row('Players still without a length', players === null ? null : String(players)),
				row('Evaluated at', text(payload, 'evaluatedAt'))
			),
			teams: distinct(outstanding),
			players: []
		};
	};
}

/**
 * `ImportPromoted` — `server/import-promotion.ts:250`.
 *
 * There are NO `teamIds`/`teamNames` fields: the payload carries `teams`, a
 * list of `{teamId, teamName, rosterCount}` objects, and every `teamId` on it
 * is a party.
 */
function renderImportPromoted(payload: Payload, refs: AuditReferences): AuditRender {
	const teams = payloadList(payload, 'teams');
	const poolSize = count(payload, 'poolSize');
	const named =
		teams.length === 0
			? EMPTY_LIST
			: teams
					.map((team) => {
						const name = teamNamed(refs, text(team, 'teamId'), text(team, 'teamName'));
						const rosterCount = count(team, 'rosterCount');
						return rosterCount === null ? name : `${name} (${String(rosterCount)})`;
					})
					.join(LIST_SEPARATOR);
	return {
		headline: 'An import was promoted to the live reference tables.',
		details: rows(
			row('Teams, with Roster Count', named),
			row('Free Agent pool size', poolSize === null ? null : String(poolSize))
		),
		teams: distinct(teams.map((team) => text(team, 'teamId'))),
		players: []
	};
}

/**
 * `BidVoided` — declared at `projection/league-clock.ts:108`, never emitted.
 *
 * Story 7.2 defines the payload and this story invents NO field name for it.
 * What it renders is the envelope plus whatever `mergeOverride` finds: a void
 * is an override, so the moment 7.2 appends one carrying an `OverrideRecord`
 * it renders with its actor, its before/after rows and its reason, with no
 * change here. Until then the headline is the whole of what can honestly be
 * said, and any payload it does carry is not guessed at.
 */
function renderBidVoided(): AuditRender {
	return {
		headline: 'A Bid was voided by the Commissioner.',
		details: [],
		teams: [],
		players: []
	};
}

/**
 * One `RosterRearrangedMove` — `projection/contracts.ts`'s
 * `RosterRearrangedMove`.
 *
 * NOT an event type of its own: it is an element of `RosterRearranged`'s
 * `moves`. Both placements are stated because the placement IS the act, and
 * both Cap Hits beside them because Cap Hit follows placement (FR-44) — a
 * Contract reading `$18,000,000 → $0` on a row that only moved Slots is the
 * least obvious thing in this requirement, and the `value` stands unchanged
 * beside the pair (AD-23) so nobody has to derive one from the other.
 *
 * `won` is the Existing-Contract-versus-Auction-Contract distinction, WORDED
 * rather than shown as a boolean: it is what says whether a `team_rosters`
 * row was updated or the Contract moved by this event alone.
 */
function rearrangedRow(move: Payload, refs: AuditReferences): AuditDetail {
	const player = playerNamed(refs, text(move, 'fantraxPlayerId'), text(move, 'playerName'));
	const won = flag(move, 'won');
	const fromPlacement = wordToken(SLOT_KIND_WORDS, move['fromPlacement']);
	const toPlacement = wordToken(SLOT_KIND_WORDS, move['toPlacement']);
	const capBefore = amount(move, 'capHitBefore');
	const capAfter = amount(move, 'capHitAfter');
	const value = amount(move, 'value');

	const parts: string[] = [];
	if (fromPlacement !== null || toPlacement !== null) {
		parts.push(`${fromPlacement ?? '—'}${TO}${toPlacement ?? '—'}`);
	}
	if (won !== null) parts.push(won ? 'Auction Contract' : 'Existing Contract');
	if (capBefore !== null || capAfter !== null) {
		parts.push(`Cap Hit ${capBefore ?? '—'}${TO}${capAfter ?? '—'}`);
	}
	if (value !== null) parts.push(`Value ${value}`);
	return { label: player, value: parts.join(LIST_SEPARATOR) };
}

/**
 * `RosterRearranged` — `projection/contracts.ts`'s `RosterRearrangedPayload`.
 *
 * ONE entry however many Contracts moved, because a Move is one act evaluated
 * once. FR-44 does not broadcast a Move to Discord, which makes this the only
 * surface it can be looked up on.
 *
 * **The reason row renders only when there IS one.** A Manager acting on
 * their own Team gives none — FR-44 requires a confirmation and no
 * justification — and `rows()` drops a `null`, so the entry simply carries no
 * Reason line rather than an empty one. The Commissioner's on-behalf Move
 * carries the reason verbatim and first, exactly as the Trade's and the
 * Drop's do.
 */
function renderRosterMove(payload: Payload, refs: AuditReferences): AuditRender {
	const teamId = text(payload, 'teamId');
	const team = teamNamed(refs, teamId, text(payload, 'teamName'));
	const moves = payloadList(payload, 'moves');

	return {
		headline: `${team} recorded a Roster Move.`,
		details: [
			...rows(row('Reason', text(payload, 'reason'))),
			...moves.map((move) => rearrangedRow(move, refs)),
			...figureRows(team, asPayload(payload['teamBefore']), asPayload(payload['teamAfter']))
		],
		teams: distinct([teamId]),
		players: distinct(moves.map((move) => text(move, 'fantraxPlayerId')))
	};
}

/**
 * The registry: a LOOKUP from `event_type` to a renderer, never a union.
 *
 * An absent key is not an error — `renderAuditEvent` falls back to the
 * envelope plus the raw payload — so a new event type ships without touching
 * this object and renders plainly until somebody writes its sentence. A
 * `switch` with no `default` would invert exactly the property this surface
 * needs.
 */
const RENDERERS: Readonly<Record<string, AuditEntry>> = Object.freeze({
	[BID_PLACED_EVENT]: { label: 'Bid placed', render: renderBidPlaced },
	[CONTENTION_DISSOLVED_EVENT]: {
		label: 'Contention dissolved',
		render: renderContentionDissolved
	},
	[BID_CANCELLED_EVENT]: { label: 'Bid cancelled', render: renderBidCancelled },
	[AUCTION_CLOSED_EVENT]: {
		label: 'Auction closed',
		render: renderAuctionClosed
	},
	[AUCTION_TERMINATED_EVENT]: {
		label: 'Auction terminated',
		render: renderAuctionTerminated
	},
	[CONTENTION_DRAWN_EVENT]: {
		label: 'Contention drawn',
		render: renderContentionDrawn
	},
	[NOMINATION_PLACED_EVENT]: {
		label: 'Nomination placed',
		render: renderNominationPlaced
	},
	[AUCTION_OPENED_EVENT]: {
		label: 'Auction opened',
		render: renderAuctionOpened
	},
	[CONTRACT_ASSIGNMENT_OPENED_EVENT]: {
		label: 'Contract Assignment opened',
		render: renderContractAssignmentOpened
	},
	[CONTRACT_LENGTH_ASSIGNED_EVENT]: {
		label: 'Contract length assigned',
		render: renderContractLengthAssigned
	},
	[ROSTER_TRADE_RECORDED_EVENT]: {
		label: 'Roster Trade recorded',
		render: renderRosterTrade
	},
	// `RENDERERS` is OPEN — an absent key falls back to the envelope plus the
	// raw payload — so a missing entry here is not a compile error but a
	// silently plain entry. Story 7.8's Drop is the record FR-43 requires, and
	// it is the only surface the act appears on.
	[DROP_RECORDED_EVENT]: { label: 'Drop recorded', render: renderDrop },
	// `RENDERERS` is OPEN, so a missing entry here is not a compile error but a
	// silently plain entry rendering machine tokens at a reader — which is why
	// `tests/core/audit-log.test.ts` is the only proof this key exists. Story
	// 7.11's Roster Move is the record FR-44 requires, and the Audit Log is the
	// only surface the act appears on.
	[ROSTER_REARRANGED_EVENT]: { label: 'Roster Move recorded', render: renderRosterMove },
	[MINOR_LEAGUE_ELIGIBILITY_SET]: {
		label: 'Minor League Eligibility set',
		render: renderEligibilitySet
	},
	[ASSIGNMENTS_SUBMITTED_EVENT]: {
		label: 'Assignments submitted',
		render: renderAssignmentsSubmitted
	},
	[ASSIGNMENT_DEADLINE_SET_EVENT]: {
		label: 'Assignment deadline set',
		render: renderDeadlineSet
	},
	[ASSIGNMENT_REMINDER_INTERVAL_SET_EVENT]: {
		label: 'Reminder interval set',
		render: renderReminderIntervalSet
	},
	[ASSIGNMENT_REMINDERS_SENT_EVENT]: {
		label: 'Assignment reminders sent',
		render: markerRenderer('An assignment reminder was sent.')
	},
	[ASSIGNMENT_DEADLINE_PASSED_EVENT]: {
		label: 'Assignment deadline passed',
		render: markerRenderer('The contract assignment deadline passed.')
	},
	[IMPORT_PROMOTED_EVENT]: {
		label: 'Import promoted',
		render: renderImportPromoted
	},
	[BID_VOIDED_EVENT]: { label: 'Bid voided', render: renderBidVoided }
});

/** Every type the registry words, for the filter catalogue. */
export const KNOWN_AUDIT_TYPES: readonly string[] = Object.freeze(Object.keys(RENDERERS).sort());

// --- The override shape, merged onto any payload that carries it ------------

/** The one label the override's own stated reason renders under. */
const OVERRIDE_REASON_LABEL = 'Reason';

/** The one label the override's own actor renders under. */
const OVERRIDE_ACTOR_LABEL = 'Overridden by';

/** Both labels this merge synthesises, and therefore both it must protect. */
const OVERRIDE_OWN_LABELS: readonly string[] = Object.freeze([
	OVERRIDE_REASON_LABEL,
	OVERRIDE_ACTOR_LABEL
]);

/**
 * What an override STATE field named literally `Reason` renders under.
 *
 * `OverrideState` is a free field-name map (`rules/override.ts:137-146`), so
 * nothing stops a future override from carrying a field called `Reason` — and
 * two rows both labelled `Reason`, one the Commissioner's stated reason and
 * one a changed field, would be unreadable. The collision is disambiguated
 * rather than dropped: exactly ONE row on any entry carries the bare label,
 * and no before/after pair is lost.
 */
const OVERRIDE_FIELD_COLLISION_SUFFIX = ' (overridden field)';

/**
 * Whether a base renderer has ALREADY filed a row under one of this merge's own
 * labels.
 *
 * `RosterMoveRecorded` is the case that makes this load-bearing:
 * `RosterTradeRecordedPayload` declares a top-level `reason`, the Roster Trade
 * renderer files it as its first row, and this merge reads the SAME key off the
 * same payload. Without this check the Commissioner's reason prints twice on
 * the one event type FR-41 makes this whole surface exist for — and twice in
 * the CSV. The base renderer wins, because it is the one that knows what its
 * own payload's `reason` means.
 */
function alreadyFiled(base: AuditRender, label: string): boolean {
	return base.details.some((detail) => detail.label === label);
}

/** The label one override state field renders under. */
function overrideFieldLabel(field: string): string {
	return OVERRIDE_OWN_LABELS.includes(field) ? `${field}${OVERRIDE_FIELD_COLLISION_SUFFIX}` : field;
}

/**
 * Render the `OverrideRecord` shape (`rules/override.ts:131-172`) off ANY
 * payload that carries it, and fold it into the entry.
 *
 * Written against the SHAPE and not against an event type, deliberately:
 * Story 7.1 shipped `OverrideRecord` with zero call sites, and 7.2's void,
 * 7.3's overrides and 7.4's pause will each append a payload carrying one.
 * Rendering the shape means none of them needs a change in this module.
 *
 * `actor.teamId` becomes a PARTY. A Commissioner overriding on behalf of a
 * Team that no base renderer and no id harvest already surfaces must still
 * find that entry under that Team's filter.
 */
function mergeOverride(payload: Payload, refs: AuditReferences, base: AuditRender): AuditRender {
	const before = asPayload(payload['before']);
	const after = asPayload(payload['after']);
	const actor = asPayload(payload['actor']);
	const reason = text(payload, 'reason');
	const actorTeamId = text(actor, 'teamId');
	const actorManagerId = text(actor, 'managerId');
	// The payload's own `displayName` first — it is what the record stored at
	// the moment of the act — and the RESOLVED name behind it.
	// `renderAuditEvent` harvests `actor.managerId` into `managers` precisely so
	// the server batches this lookup, and a fallback that never consulted it
	// would make that read dead weight.
	const actorName =
		text(actor, 'displayName') ??
		(actorManagerId === null ? null : (refs.managerNames.get(actorManagerId) ?? null));

	const fields = distinct([...Object.keys(before), ...Object.keys(after)]);
	const stateRows: readonly AuditDetail[] = fields.map((field) => {
		const left = before[field];
		const right = after[field];
		return {
			label: overrideFieldLabel(field),
			value: `${typeof left === 'string' ? left : '—'}${TO}${
				typeof right === 'string' ? right : '—'
			}`
		};
	});

	const namesAnActor = actorName !== null || actorTeamId !== null || actorManagerId !== null;
	const overrideRows = rows(
		!namesAnActor || alreadyFiled(base, OVERRIDE_ACTOR_LABEL)
			? null
			: {
					label: OVERRIDE_ACTOR_LABEL,
					value: formatTeamManager(
						actorTeamId === null ? null : (refs.teamNames.get(actorTeamId) ?? UNNAMED_TEAM),
						actorName ?? UNNAMED_MANAGER
					)
				},
		reason === null || alreadyFiled(base, OVERRIDE_REASON_LABEL)
			? null
			: { label: OVERRIDE_REASON_LABEL, value: reason }
	);

	if (stateRows.length === 0 && overrideRows.length === 0) return base;

	return {
		headline: base.headline,
		// The base entry's own rows first, then the override's — an override is
		// something that happened TO the event, and reads after it.
		details: [...base.details, ...overrideRows, ...stateRows],
		teams: distinct([...base.teams, actorTeamId]),
		players: base.players
	};
}

// --- One row --------------------------------------------------------------

/** How an entry attributes itself. */
export type AuditActor = {
	/** `The system` for the null actor pair; otherwise the Manager's pairing. */
	readonly label: string;
	/** `true` only for the null `manager_id`/`team_id` pair. */
	readonly isSystem: boolean;
};

/**
 * One event, normalised — everything the page, the filters and the CSV read.
 *
 * `teams` and `players` are the ids the two id filters match on. `managers` is
 * NOT a filter axis: it is the ids the actor rendering resolves, carried so the
 * server can harvest every id it must resolve from the rows themselves in one
 * pass rather than walking nineteen payload shapes a second time.
 */
export type AuditRow = {
	readonly seq: string;
	readonly occurredAt: string;
	readonly type: string;
	/** The type as a reader reads it — the raw `event_type` for an unworded one. */
	readonly typeLabel: string;
	readonly actor: AuditActor;
	readonly headline: string;
	readonly details: readonly AuditDetail[];
	readonly teams: readonly string[];
	readonly players: readonly string[];
	readonly managers: readonly string[];
};

/** The label an entry with no renderer carries its raw payload under. */
const RAW_PAYLOAD_LABEL = 'Recorded payload';

/** What an unrecognised entry says instead of a sentence nobody wrote. */
function unwordedHeadline(type: string): string {
	return `This League recorded a ${type} event. The Log has no wording for this event type, so it is shown exactly as it was recorded.`;
}

/**
 * The raw payload, serialised — the fallback's whole content.
 *
 * `JSON.stringify` returns `undefined` for `undefined` and throws only on a
 * cycle, which `jsonb` cannot hold; the `catch` is belt as well as braces, for
 * the same reason the rest of this module never throws.
 */
function serialisePayload(payload: unknown): string {
	if (payload === undefined) return 'No payload was recorded.';
	try {
		return JSON.stringify(payload) ?? 'No payload was recorded.';
	} catch {
		return 'This payload could not be shown.';
	}
}

/**
 * The envelope fallback: no renderer, and the row is STILL complete.
 *
 * Counted, filterable by its own type, exported, and carrying the payload
 * verbatim so nothing recorded is hidden from a reader. This is the one
 * behaviour this surface cannot do without.
 */
function renderUnknown(type: string, payload: unknown): AuditRender {
	return {
		headline: unwordedHeadline(type),
		details: [{ label: RAW_PAYLOAD_LABEL, value: serialisePayload(payload) }],
		teams: [],
		players: []
	};
}

/**
 * Attribute one entry.
 *
 * `supabase/migrations/20260901000000_system_actor.sql:43` constrains
 * `(manager_id is null) = (team_id is null)`, so a half-null row is unwritable
 * and the pair is ONE decision taken in ONE place rather than two halves tested
 * separately. An unattributed event is the SYSTEM acting — a tick that compared
 * a clock — and never the Commissioner.
 */
function attribute(event: AppendedEvent, refs: AuditReferences): AuditActor {
	if (event.managerId === null || event.teamId === null) {
		return { label: SYSTEM_ACTOR, isSystem: true };
	}
	const managerName = refs.managerNames.get(event.managerId) ?? null;
	const teamName = refs.teamNames.get(event.teamId) ?? null;
	// BOTH halves missing, and only both: the row carried an actor pair and
	// neither id resolves, so there is one absence to state rather than a
	// pairing to render. A `||` here would take this branch for a row that
	// resolved one half, and throw away the half it had.
	if (managerName === null && teamName === null) {
		return { label: UNNAMED_MANAGER, isSystem: false };
	}
	// A resolved half is NEVER paired with a silent gap. `formatTeamManager`
	// returns the Manager alone for a `null` Team — the right answer for a
	// Manager bound to no Team, and the WRONG one here, where the row does name
	// a Team and this read simply could not find its name. The absence is
	// stated instead, exactly as `teamNamed` and `playerNamed` state theirs.
	return {
		label: formatTeamManager(teamName ?? UNNAMED_TEAM, managerName ?? UNNAMED_MANAGER),
		isSystem: false
	};
}

/** Normalise one event. Total over every `event_type`, known or not. */
export function renderAuditEvent(event: AppendedEvent, refs: AuditReferences): AuditRow {
	const payload = asPayload(event.payload);
	const entry = RENDERERS[event.type];
	const base =
		entry === undefined ? renderUnknown(event.type, event.payload) : entry.render(payload, refs);
	const merged = mergeOverride(payload, refs, base);
	return {
		seq: event.seq,
		occurredAt: event.occurredAt,
		type: event.type,
		typeLabel: entry?.label ?? event.type,
		actor: attribute(event, refs),
		headline: merged.headline,
		details: merged.details,
		// The envelope's own Team is a party too: an entry a Team ACTED on must
		// be findable under that Team's filter even where the payload names no
		// Team at all.
		teams: distinct([...merged.teams, event.teamId]),
		players: merged.players,
		managers: distinct([event.managerId, text(asPayload(payload['actor']), 'managerId')])
	};
}

/** Exactly an optionally-signed canonical integer — `money.ts:55`'s pattern. */
const CANONICAL_SEQ = /^-?(?:0|[1-9][0-9]*)$/;

/**
 * Compare two canonical `seq` strings as the numbers they are.
 *
 * `BigInt` and never `Number` or `<`, for `projection/fold.ts:16`'s reason:
 * `seq` is a `bigint` column and a string comparison would put `"9"` after
 * `"10"`.
 */
function compareSeqDescending(left: string, right: string): number {
	const a = BigInt(left);
	const b = BigInt(right);
	return a === b ? 0 : a < b ? 1 : -1;
}

/** The lexical fallback, for a log this reader cannot read as numbers. */
function compareTextDescending(left: string, right: string): number {
	return left === right ? 0 : left < right ? 1 : -1;
}

/**
 * Every event, normalised, NEWEST FIRST.
 *
 * Ordered over `seq` and never `occurred_at`: a transaction queued on the
 * global advisory lock commits later while holding an earlier timestamp
 * (AD-5), so timestamp order would misreport causality in exactly the case an
 * auditor is looking at.
 *
 * The count of rows out ALWAYS equals the count of events in — there is no
 * branch here that can drop one.
 */
export function auditRowsFor(
	events: readonly AppendedEvent[],
	refs: AuditReferences
): readonly AuditRow[] {
	const normalised = events.map((event) => renderAuditEvent(event, refs));
	// ONE decision for the WHOLE array, taken before the sort rather than per
	// pair inside a `catch`. A comparator that read some pairs as numbers and
	// others as text would be NON-TRANSITIVE, and a non-transitive comparator is
	// undefined behaviour in `Array.prototype.sort` — the array could come back
	// in no order at all, on the one surface whose order is the evidence. `seq`
	// is a database identity column, so a non-canonical one is unreachable
	// today; this makes the unreachable case merely lexical rather than
	// undefined.
	const numeric = normalised.every((entry) => CANONICAL_SEQ.test(entry.seq));
	return normalised.sort((left, right) =>
		numeric
			? compareSeqDescending(left.seq, right.seq)
			: compareTextDescending(left.seq, right.seq)
	);
}

/** Every id a set of rows names, for the server's batched reference reads. */
export function auditPartyIds(rows: readonly AuditRow[]): {
	readonly teamIds: readonly string[];
	readonly playerIds: readonly string[];
	readonly managerIds: readonly string[];
} {
	return {
		teamIds: distinct(rows.flatMap((entry) => entry.teams)),
		playerIds: distinct(rows.flatMap((entry) => entry.players)),
		managerIds: distinct(rows.flatMap((entry) => entry.managers))
	};
}

// --- Filtering -------------------------------------------------------------

/** The three filters, as the query string carries them. */
export type AuditFilter = {
	readonly team: string | null;
	readonly player: string | null;
	readonly type: string | null;
};

/** No filter at all. */
export const NO_AUDIT_FILTER: AuditFilter = Object.freeze({
	team: null,
	player: null,
	type: null
});

/** Whether one row satisfies all three filters — a conjunction, always. */
export function matchesAuditFilter(entry: AuditRow, filter: AuditFilter): boolean {
	if (filter.team !== null && !entry.teams.includes(filter.team)) return false;
	if (filter.player !== null && !entry.players.includes(filter.player)) return false;
	if (filter.type !== null && entry.type !== filter.type) return false;
	return true;
}

/** The rows a filter admits, in the order they were given. */
export function filterAuditRows(
	rows: readonly AuditRow[],
	filter: AuditFilter
): readonly AuditRow[] {
	return rows.filter((entry) => matchesAuditFilter(entry, filter));
}

/** Whether any filter at all is in force — what the page states. */
export function isFiltered(filter: AuditFilter): boolean {
	return filter.team !== null || filter.player !== null || filter.type !== null;
}

// --- The filter catalogues -------------------------------------------------

/** One choice on a filter control. */
export type AuditFilterOption = {
	readonly value: string;
	readonly label: string;
};

/**
 * How an id with no resolved name is labelled on a control.
 *
 * This is the ONE place on the surface an id may still show, and it is
 * labelled as an id rather than presented as a name. Everywhere else an
 * unresolved id renders as a stated absence.
 */
export function idOption(kind: string, id: string): string {
	return `Unnamed ${kind} — id ${id}`;
}

/**
 * The two kinds `idOption` is ever asked for.
 *
 * Exported with it because the SURFACE needs both: a filter value that is in
 * force but absent from its option list is rendered as the selected option, and
 * it has to be labelled through this one function rather than shown as a bare
 * id — which would put a uuid in front of a reader as though it were a name,
 * and would be the page wording something of its own.
 */
export const ID_OPTION_KINDS = Object.freeze({ team: 'Team', player: 'Player' } as const);

/** Case-insensitive-free, stable ordering by the label a reader sees. */
function byLabel(left: AuditFilterOption, right: AuditFilterOption): number {
	if (left.label === right.label) return 0;
	return left.label < right.label ? -1 : 1;
}

/**
 * The Team and Player catalogues are drawn from the WHOLE Log and never from
 * the filtered rows, so a filter can be widened without being cleared first —
 * a control whose options collapse to what is already selected is a control a
 * reader cannot get back out of.
 */
export function auditTeamOptions(
	rows: readonly AuditRow[],
	refs: AuditReferences
): readonly AuditFilterOption[] {
	return distinct(rows.flatMap((entry) => entry.teams))
		.map((id) => ({
			value: id,
			label: refs.teamNames.get(id) ?? idOption(ID_OPTION_KINDS.team, id)
		}))
		.sort(byLabel);
}

/** The Player catalogue, drawn from the whole Log for `auditTeamOptions`' reason. */
export function auditPlayerOptions(
	rows: readonly AuditRow[],
	refs: AuditReferences
): readonly AuditFilterOption[] {
	return distinct(rows.flatMap((entry) => entry.players))
		.map((id) => ({
			value: id,
			label: refs.playerNames.get(id) ?? idOption(ID_OPTION_KINDS.player, id)
		}))
		.sort(byLabel);
}

/**
 * The type catalogue: the union of the registry and the types actually in the
 * Log, so an event type this story does not word is still SELECTABLE — the
 * same completeness property the fallback renderer gives the rows.
 */
export function auditTypeOptions(rows: readonly AuditRow[]): readonly AuditFilterOption[] {
	return distinct([...KNOWN_AUDIT_TYPES, ...rows.map((entry) => entry.type)])
		.map((type) => ({ value: type, label: RENDERERS[type]?.label ?? type }))
		.sort(byLabel);
}

// --- Parsing the query string ---------------------------------------------

/** What a refused query says. Never silently ignored. */
export const UNKNOWN_TYPE_REFUSAL = 'That is not an event type this League has recorded.';

/** The status a refused query receives. */
export const UNKNOWN_TYPE_REFUSAL_STATUS = 400;

/** A parsed query, or the refusal it earned. */
export type AuditQueryOutcome =
	| { readonly ok: true; readonly filter: AuditFilter }
	| { readonly ok: false; readonly refusal: string };

/** One query parameter, trimmed — absent and blank are the same absence. */
function param(read: (key: string) => string | null, key: string): string | null {
	const raw = read(key);
	if (raw === null) return null;
	const value = raw.trim();
	return value === '' ? null : value;
}

/**
 * Parse `?team=&player=&type=` into a filter.
 *
 * An unrecognised `type` is REFUSED rather than ignored: a filter silently
 * dropped would show the reader the whole Log while the control claimed a
 * filter was in force, which on an audit surface is the worst available
 * failure. An unknown `team` or `player` is NOT refused — the Log genuinely
 * holds no entry naming it, and the designed empty result states exactly that.
 *
 * `knownTypes` is the type catalogue, so a type present in the log but unworded
 * by the registry is accepted.
 */
export function parseAuditQuery(
	read: (key: string) => string | null,
	knownTypes: readonly string[]
): AuditQueryOutcome {
	const type = param(read, AUDIT_FILTER_KEYS.type);
	if (type !== null && !knownTypes.includes(type)) {
		return { ok: false, refusal: UNKNOWN_TYPE_REFUSAL };
	}
	return {
		ok: true,
		filter: {
			team: param(read, AUDIT_FILTER_KEYS.team),
			player: param(read, AUDIT_FILTER_KEYS.player),
			type
		}
	};
}

/**
 * The query string an export link must carry to export exactly what the page
 * is showing. Built here rather than in markup so the page and the CSV cannot
 * disagree about which rows are in force.
 */
export function auditQueryString(filter: AuditFilter): string {
	const parts: string[] = [];
	const add = (key: string, value: string | null) => {
		if (value === null) return;
		parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
	};
	add(AUDIT_FILTER_KEYS.team, filter.team);
	add(AUDIT_FILTER_KEYS.player, filter.player);
	add(AUDIT_FILTER_KEYS.type, filter.type);
	return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/**
 * The count sentence the page states, so a reader knows whether they are
 * looking at the whole Log or at a view of it.
 */
export function auditCountSentence(shown: number, total: number): string {
	if (shown === total) {
		return total === 1 ? '1 entry.' : `${String(total)} entries.`;
	}
	return `${String(shown)} of ${String(total)} entries.`;
}

/**
 * When this reading of the Log was taken, in the Log's own words.
 *
 * The Log is a record rather than a set of live figures, so this is NOT the
 * freshness contract the board and the Teams index carry — nothing here goes
 * stale in the sense a price does, and there is no control to disable. What it
 * states is the instant the read happened, which is the one thing a reader
 * comparing two exports or two screenshots needs and cannot otherwise recover:
 * the log itself is append-only, so the only way two readings differ is that
 * one was taken later.
 *
 * The instant is the DATABASE clock the read was taken on (AD-3), never Node's
 * and never the browser's.
 */
export function auditReadStatement(figuresAt: string): string {
	return `This reading was taken at ${figuresAt}.`;
}
