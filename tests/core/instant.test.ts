/**
 * `core/instant.ts`'s pure relative-phrase helper (Story 2.4).
 *
 * State-literal, injected `now` — no clock read anywhere in this suite or
 * the module under test.
 */

import { describe, expect, it } from 'vitest';

import { relativePhrase } from '../../src/lib/core/instant.ts';

describe('relativePhrase', () => {
	it('reads "moments ago" for anything under a minute', () => {
		expect(relativePhrase('2026-08-26T09:00:00.000Z', '2026-08-26T09:00:00.000Z')).toBe(
			'moments ago'
		);
		expect(relativePhrase('2026-08-26T09:00:00.000Z', '2026-08-26T09:00:59.000Z')).toBe(
			'moments ago'
		);
	});

	it('reads whole minutes under an hour, singular and plural', () => {
		expect(relativePhrase('2026-08-26T09:00:00.000Z', '2026-08-26T09:01:00.000Z')).toBe(
			'1 minute ago'
		);
		expect(relativePhrase('2026-08-26T09:00:00.000Z', '2026-08-26T09:02:30.000Z')).toBe(
			'2 minutes ago'
		);
		expect(relativePhrase('2026-08-26T09:00:00.000Z', '2026-08-26T09:59:59.000Z')).toBe(
			'59 minutes ago'
		);
	});

	it('reads whole hours under a day, singular and plural', () => {
		expect(relativePhrase('2026-08-26T09:00:00.000Z', '2026-08-26T10:00:00.000Z')).toBe(
			'1 hour ago'
		);
		expect(relativePhrase('2026-08-26T09:00:00.000Z', '2026-08-26T12:30:00.000Z')).toBe(
			'3 hours ago'
		);
		expect(relativePhrase('2026-08-26T00:00:00.000Z', '2026-08-26T23:59:59.000Z')).toBe(
			'23 hours ago'
		);
	});

	it('reads whole days at a day or more, singular and plural', () => {
		expect(relativePhrase('2026-08-25T09:00:00.000Z', '2026-08-26T09:00:00.000Z')).toBe(
			'1 day ago'
		);
		expect(relativePhrase('2026-08-20T09:00:00.000Z', '2026-08-26T09:00:00.000Z')).toBe(
			'6 days ago'
		);
	});

	it('treats a negative delta (clock skew) as "moments ago" rather than a negative count', () => {
		expect(relativePhrase('2026-08-26T09:00:05.000Z', '2026-08-26T09:00:00.000Z')).toBe(
			'moments ago'
		);
	});

	it('reads an unknown time rather than throwing on a malformed instant', () => {
		expect(relativePhrase('not-an-instant', '2026-08-26T09:00:00.000Z')).toBe(
			'at an unknown time'
		);
		expect(relativePhrase('2026-08-26T09:00:00.000Z', 'not-an-instant')).toBe(
			'at an unknown time'
		);
		expect(() => relativePhrase('nonsense', 'also-nonsense')).not.toThrow();
	});

	it('rejects a date that does not exist, such as 2026-02-30', () => {
		expect(relativePhrase('2026-02-30T00:00:00.000Z', '2026-08-26T09:00:00.000Z')).toBe(
			'at an unknown time'
		);
	});

	it('is pure — the same two instants always produce the same phrase', () => {
		const a = relativePhrase('2026-08-25T09:00:00.000Z', '2026-08-26T09:00:00.000Z');
		const b = relativePhrase('2026-08-25T09:00:00.000Z', '2026-08-26T09:00:00.000Z');
		expect(a).toBe(b);
	});
});
