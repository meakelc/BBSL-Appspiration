/**
 * Reading a Postgres error's SQLSTATE and constraint name. Server-only
 * (Story 2.2).
 *
 * The FIRST such reader in the repo: nothing in `src/` inspected `err.code`
 * before this story, and `import-promotion.ts:257-260` merely narrates that a
 * violation "propagates after the transaction has rolled back". Story 2.2
 * needs one violation — a unique constraint on `open_nominations` — to become
 * a *returned refusal* rather than a raw `pg` throw reaching the route as a
 * 500, so the losing Manager is told who beat them.
 *
 * This module classifies and nothing else. It does not decide what a
 * violation MEANS: that mapping (which constraint is which refusal) lives in
 * `nomination.ts`, beside the refusals it chooses between.
 *
 * **Total and defensive, and never throws.** `catch (error)` in TypeScript
 * hands back `unknown`: the value may be a `pg` error, a plain `Error`, a
 * string, `null`, or anything else a library chose to throw. Every one of
 * those answers `false` / `null` rather than crashing the classifier — a
 * throw here would replace the very 500 this module exists to prevent.
 */

/** The SQLSTATE for `unique_violation`. */
export const UNIQUE_VIOLATION = '23505';

/**
 * Read `code`/`constraint` off an unknown thrown value, without assuming its
 * shape. `pg` puts both on the error object as plain string properties.
 */
function stringProperty(error: unknown, name: string): string | null {
	if (typeof error !== 'object' || error === null) return null;
	const value = (error as Record<string, unknown>)[name];
	return typeof value === 'string' ? value : null;
}

/**
 * Is this thrown value a Postgres unique-constraint violation (SQLSTATE
 * `23505`)?
 *
 * Matched on the SQLSTATE, never on the message text: a message is localised
 * and reworded between Postgres versions, whereas `23505` is fixed by the
 * standard.
 */
export function isUniqueViolation(error: unknown): boolean {
	return stringProperty(error, 'code') === UNIQUE_VIOLATION;
}

/**
 * The name of the constraint a Postgres error names, or `null` when it names
 * none — which includes every value that is not a `pg` error at all.
 *
 * Deliberately independent of `isUniqueViolation`: a caller asks both
 * questions and decides for itself, rather than this module inventing a
 * combined answer no caller asked for.
 */
export function constraintOf(error: unknown): string | null {
	return stringProperty(error, 'constraint');
}
