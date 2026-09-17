/**
 * The notification-category copy and its refusals (Story 5.4, FR-27).
 *
 * This module holds EVERY sentence `/notifications` renders and every sentence
 * its action refuses with, so the wording is asserted here rather than at the
 * surface — `tests/core/pool-import-rules.test.ts` and its siblings do the same
 * for their copy, including the `not.toContain('!')` voice check this file
 * repeats over the whole exported surface.
 *
 * **NO CATEGORY IS MUTABLE, and the rows below are what hold that.** Story 5.4
 * shipped `slot_release` as the one mutable category; FR-9's amendment retired
 * it, because a close no longer frees the NOMINATING Team's Slot and the
 * release became half a sentence on the winner's close line. So the table is
 * four categories, every one of them carrying a reason, and every refusal says
 * there is no category a mute would have worked for.
 */

import { describe, expect, it } from 'vitest';

import {
	MUTABLE_NOTIFICATION_CATEGORIES,
	NOTIFICATION_CATEGORIES,
	NO_MUTABLE_CATEGORY_STATEMENT,
	isMutableNotificationCategory,
	isNotificationCategory,
	notificationCategoryCopy,
	notificationMuteRefusalDetail
} from '../../src/lib/core/notification-categories.ts';
import type { UnmutableNotificationCategory } from '../../src/lib/core/notification-categories.ts';

/** Every category — which is every category no Manager may mute. */
const UNMUTABLE: readonly UnmutableNotificationCategory[] = [
	'outbid',
	'led_at_close',
	'contender',
	'contract_assignment'
];

/** Every sentence this module can produce, over its whole surface. */
const EVERY_SENTENCE: readonly string[] = [
	NO_MUTABLE_CATEGORY_STATEMENT,
	...NOTIFICATION_CATEGORIES.flatMap((category) => [
		category.label,
		category.statement,
		category.unmutableReason
	]),
	...UNMUTABLE.map((category) =>
		notificationMuteRefusalDetail({ kind: 'unmutable_category', category })
	),
	notificationMuteRefusalDetail({ kind: 'unknown_category', requested: 'nomination_warning' }),
	notificationMuteRefusalDetail({ kind: 'unstated_target' }),
	notificationMuteRefusalDetail({ kind: 'unregistered_actor' })
];

describe('the category table', () => {
	it('names exactly four categories, each once, in the order the page lists them', () => {
		// `slot_release` used to head this list. It was retired with FR-9's
		// amendment; nothing is mentioned under it, so nothing names it.
		const ids = NOTIFICATION_CATEGORIES.map((category) => category.id);
		expect(ids).toEqual(['led_at_close', 'outbid', 'contender', 'contract_assignment']);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).not.toContain('slot_release');
	});

	it('gives EVERY category a non-empty reason, so no control is a bare absence', () => {
		for (const category of NOTIFICATION_CATEGORIES) {
			expect(category.unmutableReason.trim().length, `${category.id} states no reason`)
				.toBeGreaterThan(0);
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

	it('folds the Slot release into the close, where winning it now happens', () => {
		// FR-9, amended: a Slot frees when the Team WINS. The close is the only
		// notice that can report it, so `led_at_close` says both things and no
		// category of its own remains.
		const statement = notificationCategoryCopy('led_at_close')?.statement ?? '';
		expect(statement).toContain('led an Auction at the moment it closed');
		expect(statement).toContain('Nomination Slot');
		expect(statement).not.toMatch(/nominated|outbid/i);
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

	it('holds NO category mutable', () => {
		expect(MUTABLE_NOTIFICATION_CATEGORIES).toEqual([]);
		for (const category of NOTIFICATION_CATEGORIES) {
			expect(isMutableNotificationCategory(category.id), category.id).toBe(false);
		}
		// Including the retired id, which is no longer a category at all.
		expect(isMutableNotificationCategory('slot_release')).toBe(false);
		expect(isMutableNotificationCategory(undefined)).toBe(false);
	});
});

describe('the page says there is no control, rather than showing none', () => {
	it('states the fact and that each category says why', () => {
		expect(NO_MUTABLE_CATEGORY_STATEMENT).toContain('none of them can be muted');
		expect(NO_MUTABLE_CATEGORY_STATEMENT).toContain('states why');
	});

	it('does not describe a setting that used to exist', () => {
		// A Manager reading this page wants to know what reaches them, not what
		// the league changed its mind about.
		expect(NO_MUTABLE_CATEGORY_STATEMENT.toLowerCase()).not.toMatch(
			/no longer|used to|previously|removed|retired/
		);
	});
});

describe('each refusal names its own cause, and states that nothing was written', () => {
	it.each(UNMUTABLE)('names %s, carries its reason, and states there is no way through', (category) => {
		const detail = notificationMuteRefusalDetail({ kind: 'unmutable_category', category });
		const copy = notificationCategoryCopy(category);

		expect(detail).toContain(copy?.label ?? '');
		expect(detail).toContain('cannot be muted');
		// The REASON travels with the refusal, so a request posted straight at
		// the action gets the same explanation the page prints beside the
		// missing control.
		expect(detail).toContain(copy?.unmutableReason ?? '');
		expect(detail).toContain('allows no notification category to be muted');
		expect(detail).toContain('Nothing was written.');
	});

	it('points at no way through, because there is none', () => {
		// The refusal used to name the one category a mute would have worked
		// for. Naming one now would send a Manager somewhere that does not
		// exist, which is worse than ending the matter.
		for (const category of UNMUTABLE) {
			const detail = notificationMuteRefusalDetail({ kind: 'unmutable_category', category });
			expect(detail).not.toMatch(/is the one category/);
			expect(detail).not.toContain('Nomination Slot released');
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
