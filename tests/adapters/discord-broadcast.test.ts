/**
 * What a broadcast notice SAYS (Story 5.2, AD-18).
 *
 * Every case here is a literal payload and a hand-built directory against a
 * pure function — no database, no transport, no clock. That is the whole point
 * of composition being pure: the copy the league reads is decided by a function
 * whose entire input is visible in the test that asserts it.
 *
 * The suite that covers WHICH intents are attempted, in what order and how
 * often is `tests/server/outbox.test.ts`. This one covers only the words.
 */

import { describe, expect, it } from 'vitest';

import {
	BROADCAST_EVENT_TYPES,
	DISCORD_MESSAGE_CEILING,
	broadcastBodyFor,
	discordTimestamp,
	isBroadcastEventType,
	noticeFor
} from '../../src/lib/adapters/discord/broadcast.ts';
import type {
	BroadcastEvent,
	LeagueDirectory
} from '../../src/lib/adapters/discord/broadcast.ts';

const LAKERS = 't-lakers';
const BULLS = 't-bulls';
const MEAKEL = 'm-meakel';
const ARI = 'm-ari';
const DANA = 'm-dana';

const PLAYER = 'p-davis';
const CLOSES_AT = '2026-09-04T02:30:00.000Z';
const CLOSES_AT_MARKUP = `<t:${String(Math.floor(Date.parse(CLOSES_AT) / 1000))}:f>`;

/** Two Teams, three Managers, one of the Teams co-managed. */
const DIRECTORY: LeagueDirectory = {
	teamNames: new Map([
		[LAKERS, 'Lakers'],
		[BULLS, 'Bulls']
	]),
	managerNames: new Map([
		[MEAKEL, 'Meakel'],
		[ARI, 'Ari'],
		[DANA, 'Dana']
	]),
	managersOfTeam: new Map([
		[LAKERS, [MEAKEL]],
		[BULLS, [ARI]]
	])
};

function event(
	eventType: string,
	payload: unknown,
	overrides: Partial<BroadcastEvent> = {}
): BroadcastEvent {
	return {
		seq: '1',
		eventType,
		payload,
		managerId: MEAKEL,
		occurredAt: CLOSES_AT,
		playerName: 'Anthony Davis',
		...overrides
	};
}

// --- the broadcast set ----------------------------------------------------

describe('BROADCAST_EVENT_TYPES — six types, and nothing else', () => {
	it('names exactly the six the story enumerates', () => {
		expect([...BROADCAST_EVENT_TYPES]).toEqual([
			'NominationPlaced',
			'BidPlaced',
			'AuctionClosed',
			'ContentionDrawn',
			'AuctionOpened',
			'ContractAssignmentOpened'
		]);
	});

	it('excludes the quiet outcomes, the bookkeeping and its own dispatch record', () => {
		for (const excluded of [
			'AuctionTerminated',
			'ContentionDissolved',
			'MinorLeagueEligibilityChanged',
			'RosterImportPromoted',
			'NotificationDispatched'
		]) {
			expect(isBroadcastEventType(excluded)).toBe(false);
		}
	});
});

// --- one case per event type ----------------------------------------------

describe('noticeFor — one line per event type', () => {
	it('NominationPlaced names the Team, its Manager and the Player', () => {
		expect(
			noticeFor(
				event('NominationPlaced', {
					fantraxPlayerId: PLAYER,
					playerName: 'Anthony Davis',
					teamId: LAKERS,
					teamName: 'Lakers',
					managerId: MEAKEL
				}),
				DIRECTORY
			)
		).toBe('Lakers — Meakel nominated Anthony Davis.');
	});

	it('BidPlaced names the amount and the new close time, in the reader’s timezone', () => {
		// The matrix's "A Bid is placed" row, and the story's first golden
		// example. The Player name comes off the JOIN, not the payload —
		// `BidPlacedPayload` has none, and adding one would have meant editing
		// `core/rules/bidding.ts`.
		expect(
			noticeFor(
				event('BidPlaced', {
					fantraxPlayerId: PLAYER,
					teamId: LAKERS,
					teamName: 'Lakers',
					managerId: MEAKEL,
					amount: 14_500_000,
					closesAt: CLOSES_AT
				}),
				DIRECTORY
			)
		).toBe(`Lakers — Meakel bid $14.5M on Anthony Davis. Closes ${CLOSES_AT_MARKUP}.`);
	});

	it('AuctionClosed names the winner and the price', () => {
		expect(
			noticeFor(
				event('AuctionClosed', {
					fantraxPlayerId: PLAYER,
					playerName: 'Anthony Davis',
					teamId: LAKERS,
					teamName: 'Lakers',
					managerId: MEAKEL,
					winningAmount: 14_500_000,
					capHit: 14_500_000,
					contractYears: null,
					closedAt: CLOSES_AT
				}),
				DIRECTORY
			)
		).toBe('Anthony Davis to Lakers — Meakel for $14.5M.');
	});

	it('ContentionDrawn spells out every contender, in payload order, plus the seed', () => {
		// AD-14 makes the contender ORDER an input to the winner, so the list
		// is a fact to be reproduced rather than a presentation choice. Every
		// Team is spelled out — a three-letter abbreviation would mean an NBA
		// team and nothing else.
		expect(
			noticeFor(
				event('ContentionDrawn', {
					fantraxPlayerId: PLAYER,
					seed: '9f3c8a1d',
					seedHash: 'h',
					contenders: [LAKERS, BULLS],
					selectedIndex: 0,
					winningTeamId: LAKERS,
					winningTeamName: 'Lakers',
					winningManagerId: MEAKEL,
					drawnAt: CLOSES_AT
				}),
				DIRECTORY
			)
		).toBe(
			'Anthony Davis drawn to Lakers — Meakel. Seed: 9f3c8a1d. ' +
				'Contenders, in order: Lakers — Meakel, Bulls — Ari.'
		);
	});

	it('puts the seed BEFORE the contender list, so truncation can never reach it', () => {
		// The ordering is the whole guarantee. `truncateToFit` cuts from the
		// tail, and the draw is the one notice the story names as the
		// truncation case, so whatever sits last is what a ceiling destroys.
		// A Manager discharges Story 3.6's commit-reveal by hashing this seed
		// against the `seedHash` on the opening `BidPlaced`; a truncated seed
		// hashes to nothing, while a truncated contender list is recoverable in
		// full from the `ContentionDrawn` event itself.
		const seed = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
		const notice = noticeFor(
			event('ContentionDrawn', {
				seed,
				contenders: Array.from({ length: 30 }, (_unused, index) => `t-${String(index)}`),
				winningTeamId: LAKERS,
				winningTeamName: 'Lakers',
				winningManagerId: MEAKEL
			}),
			DIRECTORY
		);

		// Forced through a ceiling far below the notice's own length.
		const { body, included } = broadcastBodyFor([notice], 90);
		expect(included).toBe(1);
		expect(body.length).toBe(90);
		expect(body).toContain(`Seed: ${seed}`);
		// And it is the contender list that was eaten.
		expect(body).not.toContain('t-29');
	});

	it('carries a real 32-byte seed IN FULL, so the commitment can be re-hashed', () => {
		// The seed as `contention-seed.ts` actually generates it: 32 random
		// bytes as hex, 64 characters. A Manager discharges Story 3.6's
		// commit-reveal by hashing this exact string and comparing it to the
		// `seedHash` published on the opening `BidPlaced`. A prefix hashes to
		// nothing, so any truncation here silently makes the fairness premise
		// unverifiable — which is precisely what this test exists to catch.
		const seed = 'a'.repeat(64);

		const notice = noticeFor(
			event('ContentionDrawn', {
				fantraxPlayerId: PLAYER,
				seed,
				seedHash: 'h',
				contenders: [LAKERS, BULLS],
				selectedIndex: 0,
				winningTeamId: LAKERS,
				winningTeamName: 'Lakers',
				winningManagerId: MEAKEL,
				drawnAt: CLOSES_AT
			}),
			DIRECTORY
		);

		expect(notice).toContain(`Seed: ${seed}`);
		expect(notice?.includes('…')).toBe(false);
	});

	it('names a co-managed contender with BOTH its Managers', () => {
		const coManaged: LeagueDirectory = {
			...DIRECTORY,
			managersOfTeam: new Map([
				[LAKERS, [MEAKEL, DANA]],
				[BULLS, [ARI]]
			])
		};
		expect(
			noticeFor(
				event('ContentionDrawn', {
					fantraxPlayerId: PLAYER,
					seed: 'abcd',
					contenders: [LAKERS],
					winningTeamId: BULLS,
					winningTeamName: 'Bulls',
					winningManagerId: ARI,
					drawnAt: CLOSES_AT
				}),
				coManaged
			)
		).toContain('Contenders, in order: Lakers — Meakel & Dana.');
	});

	it('AuctionOpened states the league it opened with', () => {
		expect(
			noticeFor(
				event('AuctionOpened', {
					teams: [
						{ teamId: LAKERS, teamName: 'Lakers' },
						{ teamId: BULLS, teamName: 'Bulls' }
					],
					minorLeagueEligibleCount: 12
				}),
				DIRECTORY
			)
		).toBe('The Auction Phase is open with 2 Teams and 12 Minor League eligible Players.');
	});

	it('ContractAssignmentOpened is keyed on no Team at all', () => {
		// The matrix's "The phase ends" row: a broadcast is not keyed on a
		// Team, unlike a mention, so a null actor pair composes fine.
		expect(
			noticeFor(
				event(
					'ContractAssignmentOpened',
					{
						expiredAt: CLOSES_AT,
						evaluatedAt: CLOSES_AT,
						terminatedPlayerIds: ['p-9', 'p-8']
					},
					{ managerId: null, playerName: null }
				),
				DIRECTORY
			)
		).toBe(
			'The Auction Phase has ended and Contract Assignment is open. ' +
				'2 nominated Players ended with no Bid.'
		);
	});

	it('says so plainly when every nominated Player drew a Bid', () => {
		expect(
			noticeFor(
				event(
					'ContractAssignmentOpened',
					{ expiredAt: CLOSES_AT, evaluatedAt: CLOSES_AT, terminatedPlayerIds: [] },
					{ managerId: null, playerName: null }
				),
				DIRECTORY
			)
		).toBe(
			'The Auction Phase has ended and Contract Assignment is open. ' +
				'Every nominated Player drew a Bid.'
		);
	});
});

// --- degrading rather than throwing ---------------------------------------

describe('noticeFor — a payload it cannot read degrades, and never throws', () => {
	it('falls back to a plain factual line for a missing field', () => {
		// The matrix's "A payload is unrecognised or malformed" row.
		expect(
			noticeFor(event('BidPlaced', { teamId: LAKERS, teamName: 'Lakers' }, { seq: '42' }), DIRECTORY)
		).toBe('A BidPlaced was recorded (event #42).');
	});

	it('falls back for an amount off the money grid rather than letting formatMoney throw', () => {
		// `formatMoney` raises a `RangeError` off the `MINIMUM_INCREMENT` grid,
		// and an insert-only log can hold a payload that predates a rule.
		expect(
			noticeFor(
				event('AuctionClosed', {
					playerName: 'Anthony Davis',
					teamId: LAKERS,
					teamName: 'Lakers',
					managerId: MEAKEL,
					winningAmount: 14_500_001
				}),
				DIRECTORY
			)
		).toBe('A AuctionClosed was recorded (event #1).');
	});

	it('falls back for an unparseable close instant rather than rendering <t:NaN:f>', () => {
		expect(
			noticeFor(
				event('BidPlaced', {
					teamId: LAKERS,
					teamName: 'Lakers',
					managerId: MEAKEL,
					amount: 14_500_000,
					closesAt: 'not an instant'
				}),
				DIRECTORY
			)
		).toBe('A BidPlaced was recorded (event #1).');
	});

	it('falls back for a type it does not recognise, and for a payload that is not an object', () => {
		expect(noticeFor(event('SomethingNew', { anything: true }), DIRECTORY)).toBe(
			'A SomethingNew was recorded (event #1).'
		);
		expect(noticeFor(event('BidPlaced', 'not an object'), DIRECTORY)).toBe(
			'A BidPlaced was recorded (event #1).'
		);
		expect(noticeFor(event('BidPlaced', null), DIRECTORY)).toBe(
			'A BidPlaced was recorded (event #1).'
		);
	});

	it('falls back when the contender list is empty, rather than posting a broken sentence', () => {
		// `ids()` answers `null` only when the field is not an array — an array
		// of non-strings, or of blanks, filters down to `[]` and would have
		// rendered `Contenders, in order: .` as a sentence. A draw always ran
		// over at least one Team, so an empty list describes a draw that cannot
		// have happened.
		for (const contenders of [[], ['', '   '], [1, 2, null]]) {
			expect(
				noticeFor(
					event('ContentionDrawn', {
						seed: '9f3c8a1d',
						contenders,
						winningTeamId: LAKERS,
						winningTeamName: 'Lakers',
						winningManagerId: MEAKEL
					}),
					DIRECTORY
				)
			).toBe('A ContentionDrawn was recorded (event #1).');
		}
	});

	it('names a Team the directory has never heard of by its id, so the draw still checks out', () => {
		// A contender list shorter than the one the draw ran over would be a
		// list nobody could verify the reduction against.
		expect(
			noticeFor(
				event('ContentionDrawn', {
					seed: 'abcd',
					contenders: [LAKERS, 't-unknown'],
					winningTeamId: LAKERS,
					winningTeamName: 'Lakers',
					winningManagerId: MEAKEL
				}),
				DIRECTORY
			)
		).toContain('Contenders, in order: Lakers — Meakel, t-unknown.');
	});

	it('names the Team alone when the acting Manager cannot be resolved', () => {
		expect(
			noticeFor(
				event('NominationPlaced', {
					playerName: 'Anthony Davis',
					teamId: LAKERS,
					teamName: 'Lakers',
					managerId: 'm-nobody'
				}),
				DIRECTORY
			)
		).toBe('Lakers nominated Anthony Davis.');
	});
});

// --- the timestamp --------------------------------------------------------

describe('discordTimestamp — every reader sees their own timezone', () => {
	it('renders <t:unix:f> in whole seconds', () => {
		expect(discordTimestamp('1970-01-01T00:00:10.000Z')).toBe('<t:10:f>');
	});

	it('answers null for an instant it cannot parse', () => {
		expect(discordTimestamp('yesterday')).toBeNull();
	});
});

// --- the message ceiling --------------------------------------------------

describe('broadcastBodyFor — whole notices, up to the ceiling', () => {
	it('joins every notice one per line when they all fit', () => {
		expect(broadcastBodyFor(['one.', 'two.'])).toEqual({ body: 'one.\ntwo.', included: 2 });
	});

	it('posts whole notices up to the ceiling and leaves the remainder out', () => {
		// The matrix's "A batch would exceed the message ceiling" row. The
		// excluded notice is NOT posted, gets no outcome, and is therefore
		// still pending — never dropped, never split mid-notice.
		const notices = ['aaaa', 'bbbb', 'cccc'];
		// Two notices plus one separator is 9 characters; three would be 14.
		expect(broadcastBodyFor(notices, 9)).toEqual({ body: 'aaaa\nbbbb', included: 2 });
	});

	it('truncates the ONE notice that alone exceeds the ceiling, rather than stalling forever', () => {
		// The matrix's "One notice alone exceeds the ceiling" row. It cannot be
		// split and it cannot be dropped: an intent that can never be posted
		// would stall the outbox for good.
		const huge = 'x'.repeat(50);
		const { body, included } = broadcastBodyFor([huge, 'next.'], 10);
		expect(included).toBe(1);
		expect(body).toBe('xxxxxxxxx…');
		expect(body.length).toBe(10);
	});

	it('keeps a real 30-contender draw under Discord’s own limit', () => {
		const contenders = Array.from({ length: 30 }, (_unused, index) => `t-${String(index)}`);
		const notice = noticeFor(
			event('ContentionDrawn', {
				seed: '9f3c8a1d',
				contenders,
				winningTeamId: LAKERS,
				winningTeamName: 'Lakers',
				winningManagerId: MEAKEL
			}),
			DIRECTORY
		);
		const { body, included } = broadcastBodyFor([notice]);
		expect(included).toBe(1);
		expect(body.length).toBeLessThanOrEqual(DISCORD_MESSAGE_CEILING);
		expect(body).toBe(notice);
	});

	it('answers an empty body for an empty batch', () => {
		expect(broadcastBodyFor([])).toEqual({ body: '', included: 0 });
	});

	it('includes NOTHING when the ceiling is zero or negative', () => {
		// A ceiling that can carry no notice must report none included.
		// Reporting one would hand the caller an empty — or ellipsis-only —
		// body to post and then mark that intent delivered, retiring a notice
		// that said nothing at all.
		expect(broadcastBodyFor(['something happened.'], 0)).toEqual({ body: '', included: 0 });
		expect(broadcastBodyFor(['something happened.'], -5)).toEqual({ body: '', included: 0 });
	});

	it('never splits a surrogate pair when it truncates', () => {
		// `teams.name` and `managers.display_name` are `text` and permit an
		// emoji. A `slice` on UTF-16 units would cut between the two halves of
		// one and post a lone surrogate, which renders as a replacement
		// character. The emoji below starts at unit index 4, so a naive cut to
		// 5 units would land inside it.
		const notice = 'aaaa\u{1F600}bbbb';
		const { body } = broadcastBodyFor([notice], 5);

		expect(body).toBe('aaaa…');
		expect(body.length).toBeLessThanOrEqual(5);
		// No unpaired surrogate survived: re-encoding is lossless.
		expect([...body].join('')).toBe(body);
		for (const unit of body) expect(unit.codePointAt(0)).toBeLessThan(0xd800);

		// And with room for the whole pair plus the ellipsis, it is kept whole.
		expect(broadcastBodyFor([notice], 7).body).toBe('aaaa\u{1F600}…');
	});
});

// --- the copy rules -------------------------------------------------------

describe('the composed copy carries no urgency and no exclamation', () => {
	/** Every sample this suite composes, in one place. */
	const samples: readonly string[] = [
		noticeFor(
			event('NominationPlaced', {
				playerName: 'Anthony Davis',
				teamId: LAKERS,
				teamName: 'Lakers',
				managerId: MEAKEL
			}),
			DIRECTORY
		),
		noticeFor(
			event('BidPlaced', {
				teamId: LAKERS,
				teamName: 'Lakers',
				managerId: MEAKEL,
				amount: 14_500_000,
				closesAt: CLOSES_AT
			}),
			DIRECTORY
		),
		noticeFor(
			event('AuctionClosed', {
				playerName: 'Anthony Davis',
				teamId: LAKERS,
				teamName: 'Lakers',
				managerId: MEAKEL,
				winningAmount: 14_500_000
			}),
			DIRECTORY
		),
		noticeFor(
			event('ContentionDrawn', {
				seed: '9f3c8a1d',
				contenders: [LAKERS, BULLS],
				winningTeamId: LAKERS,
				winningTeamName: 'Lakers',
				winningManagerId: MEAKEL
			}),
			DIRECTORY
		),
		noticeFor(
			event('AuctionOpened', { teams: [{ teamId: LAKERS }], minorLeagueEligibleCount: 1 }),
			DIRECTORY
		),
		noticeFor(
			event('ContractAssignmentOpened', { terminatedPlayerIds: ['p-9'] }, { managerId: null }),
			DIRECTORY
		),
		noticeFor(event('SomethingNew', {}), DIRECTORY)
	];

	it('composes a real sentence for every sample, so the assertions below mean something', () => {
		expect(samples).toHaveLength(7);
		for (const sample of samples) {
			expect(sample.length).toBeGreaterThan(0);
			expect(sample).not.toContain('undefined');
			expect(sample).not.toContain('NaN');
		}
	});

	it('contains no exclamation mark anywhere', () => {
		for (const sample of samples) expect(sample).not.toContain('!');
	});

	it('contains no urgency framing, no countdown pressure and no suggested action', () => {
		// The story's **Never** list, asserted rather than merely intended.
		const forbidden = [
			'hurry',
			'soon',
			'last chance',
			'ending',
			'ends soon',
			'act now',
			'don’t miss',
			"don't miss",
			'final call',
			'quick',
			'urgent',
			'now is'
		];
		for (const sample of samples) {
			const lowered = sample.toLowerCase();
			for (const word of forbidden) expect(lowered).not.toContain(word);
		}
	});

	it('never abbreviates a fantasy Team to three capitals', () => {
		// The glossary rule: a three-letter capitalised abbreviation always and
		// only means a player's real-life NBA team.
		for (const sample of samples) expect(sample).not.toMatch(/\b[A-Z]{3}\b/);
	});

	it('mentions nobody: no `<@` appears in any composed line', () => {
		// 5.2 is addressed to the channel. The mention is 5.3's, and it arrives
		// as a recipient beside this body rather than as a word inside it.
		for (const sample of samples) expect(sample).not.toContain('<@');
	});
});
