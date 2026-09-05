/**
 * The inline mention line (Story 5.3, AD-18, FR-27).
 *
 * Pure and total, so every composition row of the story's I/O matrix is driven
 * against a literal payload and a literal directory with no database, no clock
 * and no transport — the same shape `tests/adapters/discord-broadcast.test.ts`
 * gets for the same reason. There is no `vi.mock` and no `vi.stubGlobal`.
 *
 * What is NOT here: which Teams an event affects (that is a fact about the
 * write site, proved in `tests/server/outbox.test.ts`), and whether the
 * snowflakes reach `allowed_mentions.users` (that is the payload's shape,
 * proved in `tests/adapters/discord-webhook.test.ts`).
 */

import { describe, expect, it } from 'vitest';

import { mentionSuffixFor, mentionsPresentIn } from '../../src/lib/adapters/discord/mention.ts';
import type {
	BroadcastEvent,
	LeagueDirectory
} from '../../src/lib/adapters/discord/broadcast.ts';

const LAKERS = 't-lakers';
const BULLS = 't-bulls';
const SUNS = 't-suns';
const MEAKEL = 'm-meakel';
const ARI = 'm-ari';
const KAI = 'm-kai';
const NOOR = 'm-noor';

/** Discord snowflakes — digits, as Discord serialises a 64-bit integer. */
const MEAKEL_ID = '111111111111111111';
const ARI_ID = '222222222222222222';
const KAI_ID = '333333333333333333';
const NOOR_ID = '444444444444444444';

const PLAYER = 'p-davis';
const ORIGIN = 'https://bbsl.example';
const LINK = `${ORIGIN}/auction/${PLAYER}`;

/** Three Teams; the Suns are co-managed, which is the case that matters. */
const DIRECTORY: LeagueDirectory = {
	teamNames: new Map([
		[LAKERS, 'Lakers'],
		[BULLS, 'Bulls'],
		[SUNS, 'Suns']
	]),
	managerNames: new Map([
		[MEAKEL, 'Meakel'],
		[ARI, 'Ari'],
		[KAI, 'Kai'],
		[NOOR, 'Noor']
	]),
	managersOfTeam: new Map([
		[LAKERS, [MEAKEL]],
		[BULLS, [ARI]],
		[SUNS, [KAI, NOOR]]
	]),
	managerIdsByDiscordUserId: new Map([
		[MEAKEL_ID, MEAKEL],
		[ARI_ID, ARI],
		[KAI_ID, KAI],
		[NOOR_ID, NOOR]
	]),
	teamOfManager: new Map([
		[MEAKEL, LAKERS],
		[ARI, BULLS],
		[KAI, SUNS],
		[NOOR, SUNS]
	]),
	/**
	 * Nobody has muted. Story 5.4's suppression rows below build their own
	 * directories off this one with `muting(...)`, so every assertion above
	 * stays a statement about an UNMUTED league and cannot drift.
	 */
	mutedSlotReleaseManagerIds: new Set<string>()
};

/** `DIRECTORY`, with exactly these Managers having muted `slot_release`. */
function muting(...managerIds: readonly string[]): LeagueDirectory {
	return { ...DIRECTORY, mutedSlotReleaseManagerIds: new Set(managerIds) };
}

function event(
	eventType: string,
	payload: unknown,
	overrides: Partial<BroadcastEvent> = {}
): BroadcastEvent {
	return {
		seq: '7',
		eventType,
		payload,
		managerId: MEAKEL,
		occurredAt: '2026-09-04T02:30:00.000Z',
		playerName: 'Anthony Davis',
		...overrides
	};
}

/** A `BidPlaced` payload, as `core/rules/bidding.ts` builds it. */
function bidPlaced(): BroadcastEvent {
	return event('BidPlaced', {
		fantraxPlayerId: PLAYER,
		teamId: LAKERS,
		teamName: 'Lakers',
		managerId: MEAKEL,
		amount: 14_500_000,
		closesAt: '2026-09-04T02:30:00.000Z'
	});
}

/** An `AuctionClosed` payload, whose `teamId` is the WINNER's. */
function auctionClosed(winner = SUNS): BroadcastEvent {
	return event('AuctionClosed', {
		fantraxPlayerId: PLAYER,
		playerName: 'Anthony Davis',
		teamId: winner,
		teamName: DIRECTORY.teamNames.get(winner),
		managerId: KAI,
		winningAmount: 3_000_000,
		capHit: 3_000_000,
		contractYears: null,
		closedAt: '2026-09-04T02:30:00.000Z'
	});
}

// --- the trigger copy -----------------------------------------------------

describe('mentionSuffixFor — one line per affected Team, on that event’s notice', () => {
	it('addresses the outbid Team by snowflake, names it, and carries the link', () => {
		// The matrix's "A Manager is outbid" row, and the story's golden
		// example's second line.
		expect(mentionSuffixFor(bidPlaced(), [ARI_ID], DIRECTORY, ORIGIN)).toBe(
			`<@${ARI_ID}> — Bulls — Ari no longer hold the leading Bid. ${LINK}`
		);
	});

	it('gives a co-managed Team TWO distinct snowflakes on ONE line', () => {
		// The matrix's "A co-managed Team is outbid" row, and the manual
		// spot-check `BMAD-EFFORT-TRIAGE.md` names for this story. Two
		// mentions, both Managers named, one Team, one fact.
		const line = mentionSuffixFor(bidPlaced(), [KAI_ID, NOOR_ID], DIRECTORY, ORIGIN);

		expect(line).toBe(
			`<@${KAI_ID}> <@${NOOR_ID}> — Suns — Kai & Noor no longer hold the leading Bid. ${LINK}`
		);
		// Distinct, and neither collapsed into the other or into a Team name.
		expect(line).toContain(`<@${KAI_ID}>`);
		expect(line).toContain(`<@${NOOR_ID}>`);
		expect(line.split('\n')).toHaveLength(1);
	});

	it('says nothing at all when no Team was affected', () => {
		// Three matrix rows collapse to one assertion, because all three reach
		// composition the same way — the write site supplied no affected Team,
		// so the intent does not exist and the composer is handed nobody: a
		// Team outbidding ITSELF, the FIRST Bid on an Auction, and a Team with
		// no `managers` rows at all.
		expect(mentionSuffixFor(bidPlaced(), [], DIRECTORY, ORIGIN)).toBe('');
		expect(mentionSuffixFor(bidPlaced(), ['', '   '], DIRECTORY, ORIGIN)).toBe('');
	});

	it('names the Team that led an Auction into its close', () => {
		// The matrix's "An Auction the Team led closes" row. The payload names
		// the winner, so the addressed Team matching it is the one that led.
		expect(mentionSuffixFor(auctionClosed(), [KAI_ID, NOOR_ID], DIRECTORY, ORIGIN)).toBe(
			`<@${KAI_ID}> <@${NOOR_ID}> — Suns — Kai & Noor led this Auction at its close. ${LINK}`
		);
	});

	it('tells the NOMINATING Team its Slot released, on that same close', () => {
		// The matrix's "The Nomination Slot is released" row: one event, two
		// Teams, two clauses — and the nominator is not the winner. The Slot's
		// release is not an event of its own, so this close is where it is
		// said.
		const line = mentionSuffixFor(auctionClosed(SUNS), [KAI_ID, ARI_ID], DIRECTORY, ORIGIN);

		expect(line).toBe(
			`<@${KAI_ID}> — Suns — Kai led this Auction at its close. ${LINK}\n` +
				`<@${ARI_ID}> — Bulls — Ari no longer hold this Nomination Slot. ${LINK}`
		);
	});

	it('mentions every Contender on the draw itself', () => {
		// The matrix's "A contention closes" row. The draw is the event that
		// can tell a Contender how the lottery went; the close beside it
		// addresses the leader and the nominator instead.
		const drawn = event('ContentionDrawn', {
			fantraxPlayerId: PLAYER,
			seed: '9f3c8a1d',
			seedHash: 'h',
			contenders: [LAKERS, BULLS],
			selectedIndex: 0,
			winningTeamId: LAKERS,
			winningTeamName: 'Lakers',
			winningManagerId: MEAKEL,
			drawnAt: '2026-09-04T02:30:00.000Z'
		});

		expect(mentionSuffixFor(drawn, [MEAKEL_ID, ARI_ID], DIRECTORY, ORIGIN)).toBe(
			`<@${MEAKEL_ID}> — Lakers — Meakel were a Contender in this draw. ${LINK}\n` +
				`<@${ARI_ID}> — Bulls — Ari were a Contender in this draw. ${LINK}`
		);
	});

	it('addresses the whole league flat when the phase opens', () => {
		// The matrix's "The phase opens" row. Every Manager of every Team, on
		// one line and with no Team naming — thirty `<@id> — Team — Manager`
		// lines would be most of Discord's 2000-character ceiling for one
		// notice, and the phase is not an Auction so there is no link.
		const opened = event('ContractAssignmentOpened', {
			expiredAt: '2026-09-04T02:30:00.000Z',
			evaluatedAt: '2026-09-04T02:30:00.000Z',
			terminatedPlayerIds: ['p-9']
		});

		expect(
			mentionSuffixFor(opened, [MEAKEL_ID, ARI_ID, KAI_ID, NOOR_ID], DIRECTORY, ORIGIN)
		).toBe(
			`<@${MEAKEL_ID}> <@${ARI_ID}> <@${KAI_ID}> <@${NOOR_ID}> — Contract Assignment is open.`
		);
	});
});

// --- degradation ----------------------------------------------------------

describe('mentionSuffixFor — it degrades and it never throws', () => {
	it('posts the mention without a link when no origin is configured', () => {
		// The matrix's "The app origin is unset" row: the mention posts without
		// a link rather than not at all.
		expect(mentionSuffixFor(bidPlaced(), [ARI_ID], DIRECTORY, null)).toBe(
			`<@${ARI_ID}> — Bulls — Ari no longer hold the leading Bid.`
		);
		// The default is the same answer — a caller that passes nothing has no
		// origin either.
		expect(mentionSuffixFor(bidPlaced(), [ARI_ID], DIRECTORY)).not.toContain('http');
	});

	it('drops the link when the payload names no Player, and keeps the ping', () => {
		const line = mentionSuffixFor(event('BidPlaced', { teamId: LAKERS }), [ARI_ID], DIRECTORY, ORIGIN);

		expect(line).toBe(`<@${ARI_ID}> — Bulls — Ari no longer hold the leading Bid.`);
	});

	it('falls back to a plain factual line for an unrecognised event type', () => {
		// The matrix's "An unrecognised event carries a mention intent" row: a
		// plain line naming the addressees and the event, and no invented
		// sentence.
		expect(mentionSuffixFor(event('SomethingNew', {}), [ARI_ID], DIRECTORY, ORIGIN)).toBe(
			`<@${ARI_ID}> — A SomethingNew was recorded (event #7).`
		);
	});

	it('falls back the same way for a snowflake the directory cannot place', () => {
		// A recipient with no `managers` row — a Manager deleted between the
		// enqueue and the drain. The ping survives; the naming does not.
		expect(mentionSuffixFor(bidPlaced(), ['999999999999999999'], DIRECTORY, ORIGIN)).toBe(
			'<@999999999999999999> — A BidPlaced was recorded (event #7).'
		);
	});

	it('falls back for a Manager whose Team the directory cannot name', () => {
		const orphaned: LeagueDirectory = { ...DIRECTORY, teamNames: new Map() };

		expect(mentionSuffixFor(bidPlaced(), [ARI_ID], orphaned, ORIGIN)).toBe(
			`<@${ARI_ID}> — A BidPlaced was recorded (event #7).`
		);
	});

	it('never throws, whatever the payload is', () => {
		for (const payload of [null, undefined, 'a string', 42, [], { teamId: 7 }]) {
			expect(() =>
				mentionSuffixFor(event('AuctionClosed', payload), [ARI_ID], DIRECTORY, ORIGIN)
			).not.toThrow();
		}
	});

	it('catches a THROWING directory and still names the addressees', () => {
		// **The catch branch's output, asserted.** Every case above is handled by
		// a defensive guard, so none of them reaches the try/catch at all — which
		// would leave the one path that exists purely to keep a drain pass alive
		// unproven. A directory whose lookups throw forces it for real: the
		// registry is read from a live transaction, and a driver handing back a
		// shape these maps choke on is the class of failure the guarantee is for.
		const exploding: LeagueDirectory = {
			...DIRECTORY,
			get teamNames(): ReadonlyMap<string, string> {
				throw new TypeError('the registry snapshot is unreadable');
			}
		};

		const line = mentionSuffixFor(bidPlaced(), [ARI_ID, KAI_ID], exploding, ORIGIN);

		// The `<@id>`s survive — a mention that pings nobody is a silence, and
		// avoiding one is this module's whole job. The clause and the link do
		// not: neither can be vouched for once composition has failed.
		expect(line).toBe(
			`<@${ARI_ID}> <@${KAI_ID}> — A BidPlaced was recorded (event #7).`
		);
		expect(line).not.toContain('leading Bid');
		expect(line).not.toContain(ORIGIN);
	});

	it('never throws even when normalising the recipients is what fails', () => {
		// The catch cannot recompute the addressees, because that call is what may
		// have thrown — so normalising them has a guard of its own. Proved by
		// making the ITERATION itself throw: a single try/catch around the whole
		// function would have re-entered this on the way out and rethrown.
		const hostile: readonly string[] = {
			[Symbol.iterator]() {
				throw new TypeError('the recipient list is not iterable');
			}
		} as unknown as readonly string[];

		// A silence, and the honest one: with no readable recipient list there is
		// nobody to name, so the broadcast notice posts alone — the same answer
		// an event that affected nobody gets.
		expect(mentionSuffixFor(bidPlaced(), hostile, DIRECTORY, ORIGIN)).toBe('');
	});

	it('de-duplicates a snowflake that arrives twice', () => {
		expect(mentionSuffixFor(bidPlaced(), [ARI_ID, ` ${ARI_ID} `], DIRECTORY, ORIGIN)).toBe(
			`<@${ARI_ID}> — Bulls — Ari no longer hold the leading Bid. ${LINK}`
		);
	});
});

// --- the mute (Story 5.4) -------------------------------------------------

describe('a muted Manager loses the mention and nothing else', () => {
	/**
	 * The close that releases a CO-MANAGED Team's Nomination Slot: the Bulls
	 * won, so the Suns are addressed as the nominator and their clause is the
	 * one mutable category. Every row below drives this one event, because the
	 * mute has to be read per CATEGORY and this is the only category that
	 * carries one.
	 */
	const slotReleased = () => auctionClosed(BULLS);

	it('drops one snowflake of two, and names only the Manager still on the line', () => {
		// The matrix's "Co-managed, one muted" row. One `<@id>`, not two — and
		// the subject narrows with it, because `subjectFor` is given the group
		// that survived suppression rather than the Team's whole roster.
		const line = mentionSuffixFor(slotReleased(), [ARI_ID, KAI_ID, NOOR_ID], muting(KAI), ORIGIN);

		expect(line).toBe(
			`<@${ARI_ID}> — Bulls — Ari led this Auction at its close. ${LINK}\n` +
				`<@${NOOR_ID}> — Suns — Noor no longer hold this Nomination Slot. ${LINK}`
		);
		expect(line).not.toContain(`<@${KAI_ID}>`);
		expect(line).not.toContain('Kai');
	});

	it('emits NO line for a Team whose every addressee has muted', () => {
		// The matrix's "Co-managed, both muted" row. The suppression happens
		// before the grouping loop, so the Suns group never exists — there is
		// no empty subject and no stray dash. The winner's line is untouched.
		const line = mentionSuffixFor(
			slotReleased(),
			[ARI_ID, KAI_ID, NOOR_ID],
			muting(KAI, NOOR),
			ORIGIN
		);

		expect(line).toBe(`<@${ARI_ID}> — Bulls — Ari led this Auction at its close. ${LINK}`);
		expect(line.split('\n')).toHaveLength(1);
	});

	it('says nothing at all when every recipient in the batch has muted', () => {
		// The matrix's last row. `''` is the same answer an event that affected
		// nobody gets, and it is the answer that lets the broadcast notice post
		// alone — the pass completes and nothing throws.
		expect(mentionSuffixFor(slotReleased(), [KAI_ID, NOOR_ID], muting(KAI, NOOR), ORIGIN)).toBe(
			''
		);
	});

	it('leaves the sentence for the surviving addressee byte-identical to the unmuted case', () => {
		// The story's manual check: the notice sentence must not change because
		// somebody else muted. Only the addressee list narrows.
		const muted = mentionSuffixFor(slotReleased(), [NOOR_ID], muting(KAI), ORIGIN);
		const unmuted = mentionSuffixFor(slotReleased(), [NOOR_ID], DIRECTORY, ORIGIN);

		expect(muted).toBe(unmuted);
		expect(muted).toContain('no longer hold this Nomination Slot.');
	});

	it('does not touch an OUTBID notice for the same muted Manager', () => {
		// The matrix's "A mute never touches an unmutable notice" row. The mute
		// is per category, not per Manager.
		expect(mentionSuffixFor(bidPlaced(), [KAI_ID, NOOR_ID], muting(KAI, NOOR), ORIGIN)).toBe(
			`<@${KAI_ID}> <@${NOOR_ID}> — Suns — Kai & Noor no longer hold the leading Bid. ${LINK}`
		);
	});

	it('does not touch a Contender notice, or the phase notice, for a muted Manager', () => {
		const drawn = event('ContentionDrawn', {
			fantraxPlayerId: PLAYER,
			seed: '9f3c8a1d',
			seedHash: 'h',
			contenders: [SUNS],
			selectedIndex: 0,
			winningTeamId: SUNS,
			winningTeamName: 'Suns',
			winningManagerId: KAI,
			drawnAt: '2026-09-04T02:30:00.000Z'
		});

		expect(mentionSuffixFor(drawn, [KAI_ID], muting(KAI), ORIGIN)).toBe(
			`<@${KAI_ID}> — Suns — Kai were a Contender in this draw. ${LINK}`
		);
		expect(
			mentionSuffixFor(event('ContractAssignmentOpened', {}), [KAI_ID], muting(KAI), ORIGIN)
		).toBe(`<@${KAI_ID}> — Contract Assignment is open.`);
	});

	it('does not apply when the nominator ALSO led — that clause is unmutable', () => {
		// The matrix's "The nominator also led" row. The payload names the Suns
		// as the winner, so their clause is `led at close`, which no Manager may
		// mute, and `muting(KAI)` changes nothing about it.
		expect(mentionSuffixFor(auctionClosed(SUNS), [KAI_ID], muting(KAI), ORIGIN)).toBe(
			`<@${KAI_ID}> — Suns — Kai led this Auction at its close. ${LINK}`
		);
	});

	it('keeps allowed_mentions exactly the set the body spells, in every muted case', () => {
		// The acceptance criterion, asserted through the very function
		// `server/outbox.ts` narrows the wire list with. A withheld snowflake
		// drops out of `allowed_mentions.users` by construction, because the
		// filter runs against the body that was rendered.
		const wire = [ARI_ID, KAI_ID, NOOR_ID];

		const oneMuted = mentionSuffixFor(slotReleased(), wire, muting(KAI), ORIGIN);
		expect(mentionsPresentIn(oneMuted, wire)).toEqual([ARI_ID, NOOR_ID]);

		const bothMuted = mentionSuffixFor(slotReleased(), wire, muting(KAI, NOOR), ORIGIN);
		expect(mentionsPresentIn(bothMuted, wire)).toEqual([ARI_ID]);

		const allMuted = mentionSuffixFor(slotReleased(), [KAI_ID, NOOR_ID], muting(KAI, NOOR), ORIGIN);
		expect(mentionsPresentIn(allMuted, [KAI_ID, NOOR_ID])).toEqual([]);
	});

	it('reads a Manager absent from the mute set as NOT muted', () => {
		// Absence is the default, not an error — the same direction an absent
		// preference row reads in through the drain's left join.
		expect(mentionSuffixFor(slotReleased(), [KAI_ID], muting(), ORIGIN)).toBe(
			`<@${KAI_ID}> — Suns — Kai no longer hold this Nomination Slot. ${LINK}`
		);
	});

	it('reads a muted Manager the directory cannot resolve as NOT muted', () => {
		// A snowflake with no Manager id behind it has no preference to read, so
		// it degrades to the plain factual line exactly as it did before 5.4 —
		// the mute cannot turn an unnameable addressee into a silence.
		expect(mentionSuffixFor(slotReleased(), ['999999999999999999'], muting(KAI), ORIGIN)).toBe(
			`<@999999999999999999> — A AuctionClosed was recorded (event #7).`
		);
	});
});

// --- voice ----------------------------------------------------------------

describe('the copy rules hold for mention text as they do for broadcast text', () => {
	/** Every sentence this module can compose, over the whole trigger set. */
	const samples = [
		mentionSuffixFor(bidPlaced(), [ARI_ID], DIRECTORY, ORIGIN),
		mentionSuffixFor(bidPlaced(), [KAI_ID, NOOR_ID], DIRECTORY, ORIGIN),
		mentionSuffixFor(auctionClosed(), [KAI_ID, ARI_ID], DIRECTORY, ORIGIN),
		mentionSuffixFor(
			event('ContentionDrawn', { fantraxPlayerId: PLAYER, contenders: [LAKERS] }),
			[MEAKEL_ID],
			DIRECTORY,
			ORIGIN
		),
		mentionSuffixFor(event('ContractAssignmentOpened', {}), [MEAKEL_ID], DIRECTORY, ORIGIN),
		mentionSuffixFor(event('SomethingNew', {}), [ARI_ID], DIRECTORY, ORIGIN)
	];

	it('uses no exclamation mark anywhere', () => {
		for (const sample of samples) expect(sample).not.toContain('!');
	});

	it('uses no urgency framing and suggests no action', () => {
		// The story's boundaries, and 5.2's: these are notices, not prompts.
		const forbidden = [
			'ending soon',
			'last chance',
			'hurry',
			'act now',
			'don’t miss',
			"don't miss",
			'click',
			'you should',
			'urgent',
			'immediately'
		];
		for (const sample of samples) {
			for (const word of forbidden) {
				expect(sample.toLowerCase()).not.toContain(word);
			}
		}
	});

	it('mentions by snowflake and never by display name or Team name alone', () => {
		// A mention is `<@id>`; a name is not a ping. Every sample that
		// addresses somebody spells at least one.
		for (const sample of samples) {
			expect(sample).toMatch(/<@\d+>/);
		}
	});
});

// --- the whitelist agrees with the body -----------------------------------

describe('mentionsPresentIn — allowed_mentions can only name what the body spells', () => {
	it('keeps the snowflakes the body mentions and drops the rest', () => {
		const body = `<@${ARI_ID}> — Bulls — Ari no longer hold the leading Bid.`;

		expect(mentionsPresentIn(body, [ARI_ID, KAI_ID])).toEqual([ARI_ID]);
	});

	it('drops everything from a body a ceiling truncated away', () => {
		expect(mentionsPresentIn('Lakers — Meakel bid $14.5M…', [ARI_ID])).toEqual([]);
	});
});

// --- Story 6.2: the deadline reminder and the deadline notice --------------

describe('mentionSuffixFor — the assignment deadline’s two markers', () => {
	/** A marker payload, as `core/rules/assignment-deadline.ts` builds one. */
	function markerEvent(eventType: string): BroadcastEvent {
		return event(eventType, {
			deadline: '2026-09-10T17:00:00.000Z',
			outstandingTeamIds: [LAKERS, BULLS],
			outstandingPlayerCount: 3,
			evaluatedAt: '2026-09-10T17:00:00.000Z'
		});
	}

	it('groups the reminder by Team and names each one, with no link', () => {
		// It is not an Auction, so `auctionLink` finds no Player on the payload
		// and the line carries no link — the same reason the phase notice
		// carries none.
		expect(
			mentionSuffixFor(markerEvent('AssignmentRemindersSent'), [MEAKEL_ID, ARI_ID], DIRECTORY, ORIGIN)
		).toBe(
			`<@${MEAKEL_ID}> — Lakers — Meakel still have Players with no contract length.\n` +
				`<@${ARI_ID}> — Bulls — Ari still have Players with no contract length.`
		);
	});

	it('does not claim the deadline is "one reminder interval away"', () => {
		// True of the instant the reminder fell due, not of the moment it is
		// read — and false outright when the interval is longer than the window
		// the deadline was set with, where the reminder is due immediately. The
		// notice line above it states the deadline itself.
		const suffix = mentionSuffixFor(
			markerEvent('AssignmentRemindersSent'),
			[MEAKEL_ID],
			DIRECTORY,
			ORIGIN
		);
		expect(suffix).not.toContain('interval away');
	});

	it('says the deadline passed, and says no length was assigned', () => {
		expect(
			mentionSuffixFor(markerEvent('AssignmentDeadlinePassed'), [MEAKEL_ID], DIRECTORY, ORIGIN)
		).toBe(
			`<@${MEAKEL_ID}> — Lakers — Meakel still have Players with no contract length, and ` +
				'the assignment deadline has passed. No length was assigned.'
		);
	});

	it('renders both Managers of a co-managed Team on ONE line', () => {
		expect(
			mentionSuffixFor(
				markerEvent('AssignmentDeadlinePassed'),
				[KAI_ID, NOOR_ID],
				DIRECTORY,
				ORIGIN
			)
		).toBe(
			`<@${KAI_ID}> <@${NOOR_ID}> — Suns — Kai & Noor still have Players with no contract ` +
				'length, and the assignment deadline has passed. No length was assigned.'
		);
	});

	it('is not silenced by a slot_release mute — the category is contract_assignment', () => {
		// `contract_assignment` is unmutable (`core/notification-categories.ts`),
		// and both markers ride it. A Manager who muted `slot_release` still
		// hears about the deadline.
		expect(
			mentionSuffixFor(markerEvent('AssignmentRemindersSent'), [MEAKEL_ID], muting(MEAKEL), ORIGIN)
		).toContain(`<@${MEAKEL_ID}>`);
	});

	it('carries no exclamation mark and no suggested action', () => {
		for (const type of ['AssignmentRemindersSent', 'AssignmentDeadlinePassed']) {
			const line = mentionSuffixFor(markerEvent(type), [MEAKEL_ID], DIRECTORY, ORIGIN);
			expect(line).not.toContain('!');
			expect(line.toLowerCase()).not.toContain('please');
			expect(line.toLowerCase()).not.toContain('hurry');
		}
	});
});
