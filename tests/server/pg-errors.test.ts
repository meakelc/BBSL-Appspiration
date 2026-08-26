/**
 * The SQLSTATE classifier. Server-only (Story 2.2).
 *
 * The whole reason this module exists is that a `23505` from the
 * `open_nominations` claim insert must become a *named refusal* rather than a
 * 500 — so its table of cases is asserted directly, including every shape of
 * thrown value that is not a `pg` error at all. A classifier that throws on a
 * `null` would reintroduce the very crash it exists to prevent.
 */

import { describe, expect, it } from 'vitest';

import { UNIQUE_VIOLATION, constraintOf, isUniqueViolation } from '../../src/lib/server/pg-errors.ts';

/** A `pg` error as the driver really shapes one: an Error with extra fields. */
function pgError(code: string, constraint?: string): Error {
	const error = new Error(
		`duplicate key value violates unique constraint "${constraint ?? 'unknown'}"`
	);
	Object.assign(error, { code, constraint, severity: 'ERROR', table: 'open_nominations' });
	return error;
}

describe('isUniqueViolation', () => {
	it('recognises SQLSTATE 23505 on a real-shaped pg error', () => {
		expect(isUniqueViolation(pgError(UNIQUE_VIOLATION, 'open_nominations_pkey'))).toBe(true);
	});

	it('pins the SQLSTATE to the standard string, not a message match', () => {
		expect(UNIQUE_VIOLATION).toBe('23505');
	});

	it('rejects a different SQLSTATE — a foreign-key violation is not this', () => {
		expect(isUniqueViolation(pgError('23503', 'open_nominations_team_id_fkey'))).toBe(false);
	});

	it('rejects an error carrying no code at all', () => {
		expect(isUniqueViolation(new Error('the insert failed partway'))).toBe(false);
	});

	it('rejects a non-string code — a shape it was never promised', () => {
		expect(isUniqueViolation({ code: 23505 })).toBe(false);
	});

	it('answers false rather than throwing for a string', () => {
		expect(isUniqueViolation('23505')).toBe(false);
	});

	it('answers false rather than throwing for null and undefined', () => {
		expect(isUniqueViolation(null)).toBe(false);
		expect(isUniqueViolation(undefined)).toBe(false);
	});

	it('never matches on the message text, however suggestive', () => {
		expect(isUniqueViolation(new Error('duplicate key value violates unique constraint'))).toBe(
			false
		);
	});
});

describe('constraintOf', () => {
	it('reads the constraint name a pg error names', () => {
		expect(constraintOf(pgError(UNIQUE_VIOLATION, 'open_nominations_pkey'))).toBe(
			'open_nominations_pkey'
		);
		expect(constraintOf(pgError(UNIQUE_VIOLATION, 'open_nominations_team_id_key'))).toBe(
			'open_nominations_team_id_key'
		);
	});

	it('answers null when the error names no constraint', () => {
		expect(constraintOf(new Error('boom'))).toBeNull();
	});

	it('answers null for a string, a number and null', () => {
		expect(constraintOf('open_nominations_pkey')).toBeNull();
		expect(constraintOf(42)).toBeNull();
		expect(constraintOf(null)).toBeNull();
	});

	it('is independent of the SQLSTATE — it reports the name, it does not judge', () => {
		expect(constraintOf(pgError('23503', 'some_fkey'))).toBe('some_fkey');
	});
});
