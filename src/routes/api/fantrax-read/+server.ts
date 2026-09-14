/**
 * The scheduled Fantrax roster read, as an endpoint. `POST /api/fantrax-read`.
 * Story 7.9, FR-42.
 *
 * **Guarded by a constant-time compare of a shared secret, exactly as the tick
 * is — and by IMPORTING the tick's own check rather than restating it.**
 * `supabase/functions/tick/auth.ts` takes the expected secret and a
 * `Headers`-like object as arguments and touches no Deno global, precisely so
 * it can be driven from Node; a second implementation of a constant-time
 * compare is a second place for an early return to creep back in and turn the
 * comparison into an oracle. The header name differs because the secret does:
 * this endpoint and the tick are separately revocable.
 *
 * **A recorded failure answers 2xx. Only a record that could not be written
 * answers non-2xx.** That inversion is the whole contract: an unreachable
 * Fantrax, a 429, a 5xx and malformed JSON are all NORMAL outcomes of asking an
 * undocumented third party a question, and each of them appends a
 * `fantrax_reads` row that the surface renders as **stopped**. The scheduler
 * has nothing to retry and nothing to alert on for those. What it must see is
 * the case where the row itself failed — because a read that left no record is
 * the outage that looks like health (AD-19).
 *
 * **Unauthenticated in the session sense, like the tick.** There is no browser
 * here and no `SessionState`; the secret is the whole boundary, and it is
 * checked before any connection is opened.
 *
 * Nothing this endpoint reaches takes the global write lock, appends an event
 * or writes a `team_rosters` row. A read that hangs is abandoned by its own
 * `AbortSignal` after `FANTRAX_READ_TIMEOUT`, so a bid or a close in the same
 * window is neither blocked, delayed nor reversed.
 */

import { json, text } from '@sveltejs/kit';

import {
	FANTRAX_READ_SECRET_HEADER,
	FANTRAX_READ_TIMEOUT,
	NOT_CONFIGURED_STATUS,
	RECORD_FAILED_STATUS,
	UNAUTHORISED_STATUS,
	configuredFantraxPort,
	fantraxReadInvocationSecret,
	missingFantraxConfiguration,
	runFantraxRead
} from '$lib/server/divergence.ts';
import { writeGateway } from '$lib/shell/db.ts';

import { isAuthorisedSecret } from '../../../../supabase/functions/tick/auth.ts';

import type { RequestHandler } from './$types';

/**
 * A `+server.ts` may export only SvelteKit's own names, so the three constants
 * this endpoint is tested against live in `server/divergence.ts` beside the
 * secret they belong to, and are imported here.
 */
const RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
	'cache-control': 'no-store',
	'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet'
});

export const POST: RequestHandler = async ({ request }) => {
	// **Before any connection is opened**, and before `$env` is read for
	// anything else. A caller must not be able to tell "this deployment has no
	// secret configured" from "your secret is wrong", which `isAuthorisedSecret`
	// guarantees by answering `false` to both without distinguishing them.
	if (!isAuthorisedSecret(fantraxReadInvocationSecret(), request.headers.get(FANTRAX_READ_SECRET_HEADER))) {
		return text('', { status: UNAUTHORISED_STATUS, headers: { ...RESPONSE_HEADERS } });
	}

	// The read's own deadline. An undocumented third party can hang where a
	// webhook does not, and a hung socket must become a recorded `unreachable`
	// rather than an endpoint that never answers.
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, FANTRAX_READ_TIMEOUT);

	try {
		// **Built BEFORE the try that records a read, and answered on its own
		// terms.** A deployment whose FANTRAX_* variables are unset has not
		// suffered a write anomaly — it has never been configured, and returning
		// the identical 500 and body as a failed insert while appending no
		// `fantrax_reads` row at all is the outage that looks like health (AD-19).
		// The status differs, the wording names the missing variable, and the
		// surface has its own `not_configured` state for the same fact.
		const port = configuredFantraxPort({
			fetch: globalThis.fetch as never,
			signal: controller.signal
		});
		if (port === null) {
			const missing = missingFantraxConfiguration();
			return json(
				{
					detail:
						`The Fantrax reader is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unset. ` +
						'No read was attempted and nothing was recorded.',
					missing
				},
				{ status: NOT_CONFIGURED_STATUS, headers: { ...RESPONSE_HEADERS } }
			);
		}

		const summary = await runFantraxRead(writeGateway(), port);
		// 2xx for EVERY recorded outcome, and for a skip. The scheduler has
		// nothing to do about an unreachable Fantrax; the surface does.
		return json(summary, { headers: { ...RESPONSE_HEADERS } });
	} catch (error) {
		// The record itself could not be written — the one case the scheduler
		// must see, because it is the only one that leaves no evidence behind.
		console.error('POST /api/fantrax-read: the read could not be recorded', error);
		return json(
			{ detail: 'The Fantrax read could not be recorded.' },
			{ status: RECORD_FAILED_STATUS, headers: { ...RESPONSE_HEADERS } }
		);
	} finally {
		clearTimeout(timer);
	}
};
