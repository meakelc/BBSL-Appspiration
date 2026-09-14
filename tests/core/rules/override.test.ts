/**
 * The override record and its reason (Story 7.1).
 *
 * Every "Record"/"Reason" row of the story's I/O matrix is driven here,
 * against `src/lib/core/rules/override.ts` directly. The claim under test is
 * structural rather than behavioural: not "a blank reason produces a bad
 * record" but "a blank reason produces NO record", so that a future override
 * route cannot forget the check it never had the option of performing.
 *
 * The core refuses by returning, never by throwing — the shell's job is to
 * turn a refusal into an HTTP status, and a core that throws makes that
 * decision for it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	OVERRIDE_REASON_FIELD,
	buildOverrideRecord,
	validateReason
} from '../../../src/lib/core/rules/override.ts';
import type { OverrideActor, OverrideState } from '../../../src/lib/core/rules/override.ts';

const ACTOR: OverrideActor = {
	managerId: '00000000-0000-4000-8000-000000000002',
	teamId: '00000000-0000-4000-8000-0000000000bb',
	displayName: 'Commissioner Bob'
};

const BEFORE: OverrideState = { 'Leading bid': '$14.5M', 'Leading bidder': 'Lakers' };
const AFTER: OverrideState = { 'Leading bid': '$14.0M', 'Leading bidder': 'Bucks' };

/** Every shape of blank the matrix names, and the ones a `<textarea>` submits. */
const BLANKS: ReadonlyArray<[string, string]> = [
	['empty', ''],
	['one space', ' '],
	['many spaces', '     '],
	['a tab', '\t'],
	['a newline', '\n'],
	['a carriage return and newline', '\r\n'],
	['spaces, tabs and newlines together', ' \t\n \r\n\t '],
	['a non-breaking space', '\u00a0'],
	['a line separator', '\u2028'],
	// The four `trim()` does NOT remove — formatting characters rather than
	// whitespace. Each of these survives `trim()` with a non-zero length and
	// would be written to the Audit Log as a permanent entry that renders
	// blank: a record asserting something was explained, showing nothing.
	['a zero-width space', '\u200b'],
	['a zero-width non-joiner', '\u200c'],
	['a zero-width joiner', '\u200d'],
	['a byte-order mark', '\ufeff'],
	['zero-width characters mixed with spaces', ` ${'\u200b'} ${'\ufeff'}${'\u200d'} `],
	['every invisible at once', ` ${'\u200b'}${'\u200c'}${'\u200d'}${'\ufeff'}\t\n`]
];

describe('validateReason', () => {
	it('accepts a real reason and returns it trimmed', () => {
		const outcome = validateReason(
			'  Wrong co-manager account; confirmed in #bbsl-general\n'
		);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.reason).toBe('Wrong co-manager account; confirmed in #bbsl-general');
		}
	});

	it('preserves the interior of a multi-line reason', () => {
		const outcome = validateReason('First line.\nSecond line.');
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.reason).toBe('First line.\nSecond line.');
	});

	it.each(BLANKS)('refuses a reason that is only %s', (_label, raw) => {
		const outcome = validateReason(raw);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.refusal.kind).toBe('blank');
	});

	it.each([
		['undefined — the field was absent', undefined],
		['null — `FormData.get` on a missing key', null],
		['a File — a hand-rolled multipart submission', new File([], 'reason.txt')],
		['a number', 7]
	])('refuses %s as an absent reason', (_label, raw) => {
		const outcome = validateReason(raw);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.refusal.kind).toBe('absent');
	});

	it('never throws — the core refuses by returning', () => {
		for (const raw of [undefined, null, '', '   ', {}, []]) {
			expect(() => validateReason(raw)).not.toThrow();
		}
	});

	it('names the form field once, for the guard and the sheet to share', () => {
		expect(OVERRIDE_REASON_FIELD).toBe('reason');
	});
});

describe('buildOverrideRecord', () => {
	it('builds a record carrying all four of actor, before, after and reason', () => {
		const outcome = buildOverrideRecord({
			actor: ACTOR,
			before: BEFORE,
			after: AFTER,
			reason: 'Wrong co-manager account; confirmed in #bbsl-general'
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.record.actor).toEqual(ACTOR);
		expect(outcome.record.before).toEqual(BEFORE);
		expect(outcome.record.after).toEqual(AFTER);
		expect(outcome.record.reason).toBe('Wrong co-manager account; confirmed in #bbsl-general');
	});

	it('stores the trimmed reason, so two submissions differing only in whitespace record the same thing', () => {
		const bare = buildOverrideRecord({ actor: ACTOR, before: BEFORE, after: AFTER, reason: 'Duplicate bid.' });
		const padded = buildOverrideRecord({ actor: ACTOR, before: BEFORE, after: AFTER, reason: '\n Duplicate bid. \t' });
		expect(bare.ok && padded.ok).toBe(true);
		if (bare.ok && padded.ok) expect(padded.record.reason).toBe(bare.record.reason);
	});

	it.each(BLANKS)('refuses construction when the reason is only %s — no partial record escapes', (_label, raw) => {
		const outcome = buildOverrideRecord({
			actor: ACTOR,
			before: BEFORE,
			after: AFTER,
			reason: raw
		});
		expect(outcome.ok).toBe(false);
		expect(outcome).not.toHaveProperty('record');
	});

	it('refuses construction when the reason is absent entirely', () => {
		const outcome = buildOverrideRecord({
			actor: ACTOR,
			before: BEFORE,
			after: AFTER,
			reason: undefined
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.refusal.kind).toBe('absent');
	});

	it('refuses by value rather than by throwing', () => {
		expect(() =>
			buildOverrideRecord({ actor: ACTOR, before: BEFORE, after: AFTER, reason: '   ' })
		).not.toThrow();
	});

	it('is the only exported way to obtain a record — nothing else returns one', () => {
		// The structural claim the whole module exists for: a future override
		// route cannot assemble an `OverrideRecord` around the reason check,
		// because no other export hands one back.
		//
		// Matching only `export function` was a hole: `export const build = () =>`
		// is a second builder this file could gain without the assertion
		// noticing. Both declaration forms are collected, so an arrow-function
		// export has to be named here before it can ship.
		const source = readOverrideSource();
		const declared = [
			...source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm),
			...source.matchAll(
				/^export\s+(?:const|let|var)\s+(\w+)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:<[^>]*>\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]*)?=>/gm
			),
			...source.matchAll(/^export\s+(?:const|let|var)\s+(\w+)\s*(?::[^=]*)?=\s*(?:async\s+)?function\b/gm)
		].map((match) => match[1]);
		expect(declared.sort()).toEqual(['buildOverrideRecord', 'trimReason', 'validateReason']);
	});

	it('applies the record brand in exactly one place — the builder', () => {
		// `OverrideRecord` carries a `declare`d unique symbol that is not
		// exported, so no module outside this file can write the shape out and
		// have it typecheck. Inside the file, one assertion applies the brand,
		// and it sits after the only check that can refuse.
		const source = readOverrideSource();
		expect(source).toContain('declare const OVERRIDE_RECORD: unique symbol');
		expect(source).not.toContain('export declare const OVERRIDE_RECORD');
		expect(source.match(/as OverrideRecord/g) ?? []).toHaveLength(1);
	});
});

describe('the module holds no privilege for the Commissioner’s own Team', () => {
	it('names no money, slot or bid rule anywhere in its code', () => {
		// AC4's negative test, at this module's boundary: an override record
		// records; it never adjusts what the acting Commissioner's own Team may
		// spend, bid or nominate. Comments are stripped so prose ABOUT the rule
		// is not a read of one.
		//
		// The comparison is CASE-INSENSITIVE: a case-sensitive scan passes for
		// `CapSpace`, `cap_space` and `MAXIMUMBID` alike, which makes it a
		// spelling check rather than an invariant.
		const code = readOverrideSource()
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '')
			.toLowerCase();
		for (const forbidden of [
			'capspace',
			'cap_space',
			'maximumbid',
			'maximum_bid',
			'nominationslot',
			'nomination_slot',
			'salary_cap',
			'salarycap',
			'evaluate('
		]) {
			expect(code, `override.ts reaches for ${forbidden}`).not.toContain(forbidden);
		}
	});
});

function readOverrideSource(): string {
	return readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'lib', 'core', 'rules', 'override.ts'),
		'utf8'
	);
}
