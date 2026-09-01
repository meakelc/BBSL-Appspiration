/**
 * The tick's invocation check, extracted so a test can drive it (Story 3.5).
 *
 * **Why this is not in `index.ts`.** Everything here is ordinary TypeScript
 * over two strings, but `index.ts` reads `Deno.env` and calls `Deno.serve` at
 * module scope, so importing it from Vitest is impossible and the one security
 * boundary the tick has would ship with no automated proof at all. This file
 * takes the expected secret and the presented one as ARGUMENTS and touches no
 * global, which is `scripts/check-core-purity.js`'s own discipline — "the
 * checking logic is exported as a pure function so the test suite can drive it
 * with synthetic inputs" — applied to the other runtime.
 *
 * **The WIRING lives here too, and that is the point of the second function
 * below.** Extracting only the comparison left the security-critical part
 * untested: which variable is read, which header is read, and which argument
 * goes where. Swapping the two arguments to `isAuthorisedSecret` inverts the
 * boundary completely — it would compare the presented header against itself
 * — and a source-text position check cannot see that. `isAuthorisedRequest`
 * takes the expected secret and a `Headers`-like object, so the whole decision
 * is drivable from Vitest with a real `Request`, and the only thing left in
 * `index.ts` is `Deno.env.get`.
 */

/** The header the cron job presents. Named in the migration, not guessed. */
export const SECRET_HEADER = 'x-tick-invocation-secret';

const encoder = new TextEncoder();

/**
 * Is the presented secret the configured one?
 *
 * Returns `false` — never throws, and never distinguishes the cases — when the
 * variable is unset, when it is empty, when the header is absent or empty, and
 * when the two simply differ. A caller must not be able to tell "this
 * deployment has no secret configured" from "your secret is wrong", and an
 * unset variable must never read as "no secret required".
 */
export function isAuthorisedSecret(
	expected: string | undefined | null,
	presented: string | null
): boolean {
	if (expected === undefined || expected === null || expected === '') return false;
	if (presented === null || presented === '') return false;
	return constantTimeEqual(encoder.encode(expected), encoder.encode(presented));
}

/**
 * Do two byte sequences match, in time that does not depend on WHERE they
 * first differ?
 *
 * The loop runs over every byte regardless, accumulating differences rather
 * than returning at the first one — an early return is what turns a comparison
 * into an oracle a caller can walk a secret out of, one byte at a time. An
 * unequal length short-circuits, which reveals the length and nothing else.
 *
 * `crypto.subtle`'s `timingSafeEqual` is deliberately NOT used: it is an
 * unstable Deno API that `deno check` rejects without a flag and that the
 * Supabase Edge Runtime does not guarantee, so this is the portable form.
 */
export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	let difference = 0;
	for (let index = 0; index < left.byteLength; index += 1) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return difference === 0;
}

/**
 * The minimum of `Headers` this module needs: one lookup that answers `null`
 * for an absent name.
 *
 * Structural on purpose. A real `Headers` satisfies it, and so does a
 * `Request`'s `.headers`, but nothing here imports a Deno global or a DOM lib
 * — which is what lets `tests/server/tick-auth.test.ts` drive this function
 * under Node with the genuine article rather than with a stand-in that could
 * differ from it (header names are case-insensitive in `Headers`, and a
 * hand-rolled `Map` would quietly not be).
 */
export type HeaderLookup = {
	get(name: string): string | null;
};

/**
 * Is this request the cron job?
 *
 * **The one security boundary the tick has, entire.** It answers `false` for
 * an unset or empty configured secret, for an absent or empty header, and for
 * a header that simply differs — and never distinguishes them, so a caller
 * cannot learn whether the deployment is configured at all.
 *
 * The parameter types are deliberately different shapes rather than two
 * strings: `expected` is the secret, `headers` is the source of the presented
 * one, and there is no way to pass them the wrong way round that also
 * type-checks. That is the inversion this signature exists to make
 * unrepresentable rather than merely tested for.
 */
export function isAuthorisedRequest(
	expected: string | undefined | null,
	headers: HeaderLookup
): boolean {
	return isAuthorisedSecret(expected, headers.get(SECRET_HEADER));
}
