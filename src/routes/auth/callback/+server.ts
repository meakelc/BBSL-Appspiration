/**
 * The Discord OAuth callback. This is the registry gate.
 *
 * The gate sits **server-side of the session, not beside it**: the code is
 * exchanged, the registry is consulted, and if the account is not registered
 * the session the exchange established is destroyed *before* anything is
 * written back. A refusal that leaves a cookie behind is not a refusal, and a
 * gate that only hides a destination is not a gate.
 *
 * A refused caller receives a terminal response, not a redirect back to the
 * sign-in surface. AD-15 requires that an unregistered account be refused
 * "without a retry loop to probe with", and a page carrying a Sign-in button
 * *is* a retry loop. Every unregistered caller receives the same status, the
 * same body and the same headers, so two ids cannot be told apart by anything
 * this route emits.
 */

import type { RequestHandler } from './$types';

import {
	EXCHANGE_REFUSAL,
	EXCHANGE_REFUSAL_STATUS,
	completeCallback,
	safeReturnTo
} from '$lib/server/auth.ts';
import { discordOAuthPort, managerRegistry, requestClient } from '$lib/server/supabase.ts';

/**
 * The headers every refusal carries, whatever the reason. Constant, so the
 * response an unregistered caller sees differs in no byte from the one any
 * other unregistered caller sees.
 *
 * The two security headers deliberately carry the SAME values as the
 * `[[headers]]` block in `netlify.toml`, which matches `for = "/*"` and so also
 * applies to this path. Netlify merges its rules with a function's own headers
 * and does not document which wins on a collision, so two different values for
 * one header name would make the served response depend on undocumented
 * behaviour — and nothing in the repository would say which value a browser
 * actually got. Identical values make the question moot: whichever precedence
 * applies, the result is the same. `tests/headers.test.ts` asserts the two
 * sources agree, so changing one and not the other fails the suite.
 */
const REFUSAL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
	'content-type': 'text/plain; charset=utf-8',
	'cache-control': 'no-store',
	'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet',
	'referrer-policy': 'strict-origin-when-cross-origin'
});

function refuse(status: number, message: string): Response {
	return new Response(message, { status, headers: { ...REFUSAL_HEADERS } });
}

export const GET: RequestHandler = async (event) => {
	const code = event.url.searchParams.get('code');
	const providerError = event.url.searchParams.get('error');
	const next = safeReturnTo(event.url.searchParams.get('next') ?? '/');

	// Discord refused at its own end, or the browser arrived with no code at
	// all — a bookmarked callback, or a replay stripped of its parameters.
	if (providerError !== null || code === null || code.trim() === '') {
		return refuse(EXCHANGE_REFUSAL_STATUS, EXCHANGE_REFUSAL);
	}

	let outcome: Awaited<ReturnType<typeof completeCallback>>;
	try {
		const client = requestClient(event.cookies);
		outcome = await completeCallback({
			code,
			oauth: discordOAuthPort(client, event.url.origin),
			registry: managerRegistry()
		});
	} catch {
		// Configuration or database failure. It is not a session, and it is not
		// reported as a registry answer — saying anything about the registry here
		// would leak whether the code belonged to a known account.
		return refuse(EXCHANGE_REFUSAL_STATUS, EXCHANGE_REFUSAL);
	}

	if (outcome.kind === 'refused') {
		// `completeCallback` has already destroyed any partial session.
		return refuse(outcome.status, outcome.message);
	}

	// Accepted. The session cookies were written by the exchange through the
	// per-request client; nothing else needs to be minted here.
	return new Response(null, {
		status: 303,
		headers: { location: next, 'cache-control': 'no-store' }
	});
};
