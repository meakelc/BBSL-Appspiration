/**
 * The Manager sign-in surface.
 *
 * One action, four states, no address field. The four states are the ones
 * AD-15 requires to be distinguishable: a signed-out visitor, an account the
 * Commissioner has not registered, a session that *expired* rather than ended,
 * and Discord being unreachable.
 *
 * The refusal an unregistered account receives is a module constant in
 * `auth.ts`, returned byte-identically here for every caller. Nothing on this
 * page varies with who is asking, and nothing on it names the Commissioner's
 * Discord-independent sign-in — that path is unadvertised, and a link here
 * would advertise it.
 */

import { fail, redirect } from '@sveltejs/kit';

import {
	DISCORD_UNAVAILABLE_NOTICE,
	beginSignIn,
	noticeFor,
	safeReturnTo
} from '$lib/server/auth.ts';
import { discordOAuthPort, requestClient } from '$lib/server/supabase.ts';

import type { Actions, PageServerLoad } from './$types';

// `noticeFor` lives in `auth.ts`, beside the sentences and the states it maps
// between, so a test can drive the mapping directly. A `+page.server.ts` may
// only export SvelteKit's own symbols, so a helper exported from here would not
// be testable anyway.

export const load: PageServerLoad = ({ locals, url }) => {
	// A registered Manager has no business on the sign-in surface.
	if (locals.session.kind === 'registered') redirect(303, '/');

	// An expired session returns to the surface it was on. The path is narrowed
	// to a same-origin absolute path first, so the notice cannot be turned into
	// an open redirect by whoever crafted the link.
	const returnTo =
		locals.session.kind === 'expired'
			? locals.session.returnTo
			: safeReturnTo(url.searchParams.get('next') ?? '/');

	return {
		phase: locals.phase,
		state: locals.session.kind,
		notice: noticeFor(locals.session),
		returnTo
	};
};

export const actions: Actions = {
	/**
	 * The single Discord action. There is no second action on this page, and
	 * there is no field to fill in.
	 */
	discord: async (event) => {
		const returnTo = safeReturnTo(
			(await event.request.formData()).get('returnTo')?.toString() ?? '/'
		);

		let outcome: Awaited<ReturnType<typeof beginSignIn>>;
		try {
			const client = requestClient(event.cookies);
			outcome = await beginSignIn({
				oauth: discordOAuthPort(client, event.url.origin),
				returnTo
			});
		} catch {
			// Missing configuration is indistinguishable from an outage to a
			// Manager standing here, and both are surfaced rather than swallowed.
			outcome = { kind: 'unavailable' };
		}

		if (outcome.kind === 'unavailable') {
			return fail(503, { state: 'discord-unavailable', notice: DISCORD_UNAVAILABLE_NOTICE });
		}

		redirect(303, outcome.url);
	}
};
