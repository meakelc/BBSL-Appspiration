/**
 * The notification-category copy and its refusals (Story 5.4, FR-27).
 *
 * This module holds EVERY sentence `/notifications` renders and every sentence
 * its action refuses with, so the wording is asserted here rather than at the
 * surface — `tests/core/pool-import-rules.test.ts` and its siblings do the same
 * for their copy, including the `not.toContain('!')` voice check this file
 * repeats over the whole exported surface.
 *
 * **The per-Manager wording is asserted, not assumed.** The preference is keyed
 * on `managers.id`, so a sentence saying "your Team is not mentioned" would be
 * false for a co-managed Team with one Manager muted — the exact case
 * `tests/adapters/discord-mention.test.ts` proves still renders the other
 * Manager's `<@id>` on a line that still names the Team. The rows below pin the
 * subject of each sentence so it cannot regress to the Team.
 */

import { describe, expect, it } from 'vitest';

import {
	MUTABLE_CATEGORY_MUTED_STATEMENT,
	MUTABLE_CATEGORY_MUTE_EFFECT,
	MUTABLE_CATEGORY_MUTE_LIMIT,
	MUTABLE_CATEGORY_UNMUTED_STATEMENT,
	MUTABLE_NOTIFICATION_CATEGORY,
	NOTIFICATION_CATEGORIES,
	isMutableNotificationCategory,
	isNotificationCategory,
	notificationCategoryCopy,
	notificationMuteOutcomeDetail,
	notificationMuteRefusalDetail,
	notificationMuteStateDetail
} from '../../src/lib/core/notification-categories.ts';
import type { UnmutableNotificationCategory } from '../../src/lib/core/notification-categories.ts';

/** The four categories no Manager may mute. */
const UNMUTABLE: readonly UnmutableNotificationCategory[] = [
	'outbid',
	'led_at_close',
	'contender',
	'contract_assignment'
];

/** Every sentence this module can produce, over its whole surface. */
const EVERY_SENTENCE: readonly string[] = [
	MUTABLE_CATEGORY_MUTE_EFFECT,
	MUTABLE_CATEGORY_MUTE_LIMIT,
	MUTABLE_CATEGORY_MUTED_STATEMENT,
	MUTABLE_CATEGORY_UNMUTED_STATEMENT,
	...NOTIFICATION_CATEGORIES.flatMap((category) =>
		[category.label, category.statement, category.unmutableReason].filter(
			(sentence): sentence is string => sentence !== null
		)
	),
	notificationMuteStateDetail(true),
	notificationMuteStateDetail(false),
	notificationMuteOutcomeDetail(true),
	notificationMuteOutcomeDetail(false),
	...UNMUTABLE.map((category) =>
		notificationMuteRefusalDetail({ kind: 'unmutable_category', category })
	),
	notificationMuteRefusalDetail({ kind: 'unknown_category', requested: 'nomination_warning' }),
	notificationMuteRefusalDetail({ kind: 'unstated_target' }),
	notificationMuteRefusalDetail({ kind: 'unregistered_actor' })
];

describe('the category table', () => {
	it('names exactly five categories, each once, in the order the page lists them', () => {
		const ids = NOTIFICATION_CATEGORIES.map((category) => category.id);
		expect(ids).toEqual([
			'slot_release',
			'outbid',
			'led_at_close',
			'contender',
			'contract_assignment'
		]);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('gives the ONE mutable category no reason, because it has a control', () => {
		expect(notificationCategoryCopy(MUTABLE_NOTIFICATION_CATEGORY)?.unmutableReason).toBeNull();
	});

	it('gives every other category a non-empty reason, so no control is a bare absence', () => {
		for (const id of UNMUTABLE) {
			const reason = notificationCategoryCopy(id)?.unmutableReason;
			expect(reason, `${id} states no reason`).not.toBeNull();
			expect((reason ?? '').trim().length).toBeGreaterThan(0);
		}
	});

	it('states the outbid reason as the fairness premise, with no urgency framing', () => {
		// The frozen boundary: no urgency framing, no suggested action. This
		// project already rejected "while you slept" wording on Positions.
		const reason = notificationCategoryCopy('outbid')?.unmutableReason ?? '';
		expect(reason).toBe(
			'Muting an outbid notice would undermine the fairness premise of a 24/7 clock.'
		);
		expect(reason).not.toMatch(/asleep|sleep|hurry|act now|still open/i);
	});

	it('states the Slot release as a fact and suggests nothing', () => {
		const statement = notificationCategoryCopy('slot_release')?.statement ?? '';
		expect(statement).toBe('A close released the Nomination Slot your Team was holding.');
		expect(statement).not.toMatch(/again|you can|nominate with/i);
	});

	it('recognises every id it names, and nothing else', () => {
		for (const category of NOTIFICATION_CATEGORIES) {
			expect(isNotificationCategory(category.id)).toBe(true);
		}
		// `toString` and `constructor` specifically: a lookup object would have
		// resolved either to an inherited `Object.prototype` member.
		for (const value of ['', 'nomination_warning', 'toString', 'constructor', 7, null]) {
			expect(isNotificationCategory(value)).toBe(false);
		}
	});

	it('holds exactly one category mutable', () => {
		const mutable = NOTIFICATION_CATEGORIES.filter((category) =>
			isMutableNotificationCategory(category.id)
		);
		expect(mutable.map((category) => category.id)).toEqual([MUTABLE_NOTIFICATION_CATEGORY]);
		expect(isMutableNotificationCategory('outbid')).toBe(false);
		expect(isMutableNotificationCategory(undefined)).toBe(false);
	});
});

describe('the mute copy has the READER as its subject, never their Team', () => {
	/**
	 * The wording that would be false for a co-managed Team with one Manager
	 * muted: the line still exists, still names the Team, and still carries the
	 * other Manager's `<@id>`.
	 */
	const TEAM_SUBJECT = [
		'your team is no longer pinged',
		'your team is not mentioned',
		'your team is mentioned',
		'your team is no longer mentioned'
	];

	it.each([
		['the mute effect', MUTABLE_CATEGORY_MUTE_EFFECT],
		['the mute limit', MUTABLE_CATEGORY_MUTE_LIMIT],
		['the muted state', MUTABLE_CATEGORY_MUTED_STATEMENT],
		['the unmuted state', MUTABLE_CATEGORY_UNMUTED_STATEMENT],
		['the accepted mute', notificationMuteOutcomeDetail(true)],
		['the accepted unmute', notificationMuteOutcomeDetail(false)]
	])(
		'%s never claims the TEAM is what stops being mentioned',
		(_label: string, sentence: string) => {
			for (const claim of TEAM_SUBJECT) {
				expect(sentence.toLowerCase(), sentence).not.toContain(claim);
			}
		}
	);

	it('says what stops, what does not, and that a co-Manager still gets theirs', () => {
		expect(MUTABLE_CATEGORY_MUTE_EFFECT).toContain('withholds your own mention');
		expect(MUTABLE_CATEGORY_MUTE_LIMIT).toContain('still posts');
		expect(MUTABLE_CATEGORY_MUTE_LIMIT).toContain('still names your Team');
		expect(MUTABLE_CATEGORY_MUTE_LIMIT).toContain('co-Manager');
	});

	it('distinguishes the STATE from an accepted CHANGE', () => {
		// Otherwise a Manager could not tell a page they merely loaded from one
		// they just changed.
		expect(notificationMuteStateDetail(true)).not.toBe(notificationMuteOutcomeDetail(true));
		expect(notificationMuteOutcomeDetail(true)).toContain('The change was accepted');
		expect(notificationMuteStateDetail(true)).toBe(MUTABLE_CATEGORY_MUTED_STATEMENT);
		expect(notificationMuteStateDetail(false)).toBe(MUTABLE_CATEGORY_UNMUTED_STATEMENT);
	});
});

describe('each refusal names its own cause, and states that nothing was written', () => {
	it.each(UNMUTABLE)('names %s, carries its reason, and names the way through', (category) => {
		const detail = notificationMuteRefusalDetail({ kind: 'unmutable_category', category });
		const copy = notificationCategoryCopy(category);

		expect(detail).toContain(copy?.label ?? '');
		expect(detail).toContain('cannot be muted');
		// The REASON travels with the refusal, so a request posted straight at
		// the action gets the same explanation the page prints beside the
		// missing control.
		expect(detail).toContain(copy?.unmutableReason ?? '');
		expect(detail).toContain('Nomination Slot released is the one category');
		expect(detail).toContain('Nothing was written.');
	});

	it('never renders an empty reason clause — the mutable category cannot reach this refusal', () => {
		// `UnmutableNotificationCategory` excludes it at the type level; this
		// asserts the sentence that would result if it ever stopped doing so.
		for (const category of UNMUTABLE) {
			const detail = notificationMuteRefusalDetail({ kind: 'unmutable_category', category });
			expect(detail).not.toContain('cannot be muted. Nomination Slot released is');
		}
	});

	it('names an unknown id back, quoted', () => {
		expect(
			notificationMuteRefusalDetail({
				kind: 'unknown_category',
				requested: 'nomination_warning'
			})
		).toContain('"nomination_warning"');
	});

	it('states a blank id as a blank id rather than as empty quotes', () => {
		const detail = notificationMuteRefusalDetail({ kind: 'unknown_category', requested: '   ' });
		expect(detail).toContain('a blank id');
		expect(detail).not.toContain('""');
	});

	it('clamps a long id by CODE POINT, so no surrogate pair is cut in half', () => {
		// U+1D51E is one code point and TWO UTF-16 units, so a code-unit slice
		// at 60 would land mid-pair and put a lone surrogate in a sentence a
		// page then renders.
		const glyph = '\u{1D51E}';
		const detail = notificationMuteRefusalDetail({
			kind: 'unknown_category',
			requested: glyph.repeat(200)
		});

		expect(detail).toContain(glyph.repeat(60));
		expect(detail).not.toContain(glyph.repeat(61));
		// No unpaired surrogate anywhere: a high one not followed by a low, or
		// a low one not preceded by a high.
		expect(detail).not.toMatch(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
		);
	});

	it('escapes a double quote inside an id rather than closing the quotation early', () => {
		const detail = notificationMuteRefusalDetail({
			kind: 'unknown_category',
			requested: 'bad" id'
		});
		expect(detail).toContain('"bad\\" id"');
	});

	it('states that neither direction was given, and guesses neither', () => {
		const detail = notificationMuteRefusalDetail({ kind: 'unstated_target' });
		expect(detail).toContain('did not state whether to mute or unmute');
		expect(detail).toContain('Nothing was written.');
	});

	it('states that an unregistered session names no Manager', () => {
		const detail = notificationMuteRefusalDetail({ kind: 'unregistered_actor' });
		expect(detail).toContain('not a registered Manager');
		expect(detail).toContain('Nothing was written.');
	});
});

describe('the house voice', () => {
	it('carries no exclamation mark in any sentence this module can produce', () => {
		for (const sentence of EVERY_SENTENCE) {
			expect(sentence, `"${sentence}" shouts`).not.toContain('!');
		}
	});

	it('apologises to nobody and advises nobody', () => {
		// `core/rules/eligibility.ts`'s stated voice: state the fact, then the
		// arithmetic. No apology, no exclamation mark, no advice.
		for (const sentence of EVERY_SENTENCE) {
			expect(sentence.toLowerCase(), sentence).not.toMatch(/\bsorry\b|apolog|\bplease\b/);
			expect(sentence.toLowerCase(), sentence).not.toMatch(/you should|we recommend|make sure/);
		}
	});

	it('leaves no sentence blank — every one of them is printed somewhere', () => {
		for (const sentence of EVERY_SENTENCE) {
			expect(sentence.trim().length).toBeGreaterThan(0);
		}
	});
});
