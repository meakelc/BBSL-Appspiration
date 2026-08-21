/**
 * The Commissioner break-glass sign-in (AD-27).
 *
 * Reachable with no Discord session, no Supabase session and no Discord at all
 * — it trades `COMMISSIONER_RECOVERY_SECRET` for an application-signed cookie
 * and touches neither vendor's identity plane. That is the entire point: FR-34's
 * pause control must stay reachable when Discord is the component that failed.
 *
 * The path is **unadvertised, not secret**. Nothing links here, the Manager
 * sign-in never mentions it, and it is excluded from indexing — but obscurity
 * is not the control. The secret, the constant-time comparison and the throttle
 * are the control.
 */

import { fail, redirect } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';

import {
	AttemptLedger,
	BREAK_GLASS_COOKIE,
	BREAK_GLASS_COOKIE_OPTIONS,
	BREAK_GLASS_TTL_MS,
	RECOVERY_ACCEPTED,
	RECOVERY_SENTENCE,
	attemptRecovery,
	throttleSource
} from '$lib/server/commissioner-recovery.ts';

import type { Actions, PageServerLoad } from './$types';

/**
 * One ledger per function instance. Its limits are documented on the class:
 * in-memory means per-instance, which weakens the ceiling by the instance
 * count and is stated rather than hidden. The durable form belongs with the
 * story that first has a write path.
 */
const ledger = new AttemptLedger();

export const load: PageServerLoad = ({ locals }) => {
	return {
		phase: locals.phase,
		active: locals.breakGlass,
		sentence: locals.breakGlass ? RECOVERY_ACCEPTED : RECOVERY_SENTENCE
	};
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const supplied = form.get('secret')?.toString() ?? '';
		const now = Date.now();
		const source = throttleSource(safeClientAddress(event));

		const outcome = attemptRecovery({
			supplied,
			configured: env['COMMISSIONER_RECOVERY_SECRET'],
			ledger,
			source,
			now,
			nonce: randomUUID().replaceAll('-', '')
		});

		if (outcome.kind !== 'accepted') {
			// Wrong secret and unset secret return the same message on the same
			// path; a throttled source never reaches the comparison at all.
			return fail(outcome.status, { notice: outcome.message });
		}

		event.cookies.set(BREAK_GLASS_COOKIE, outcome.cookie, {
			...BREAK_GLASS_COOKIE_OPTIONS,
			maxAge: Math.floor(BREAK_GLASS_TTL_MS / 1000)
		});

		redirect(303, '/');
	}
};

/**
 * The client address, or nothing. SvelteKit's `getClientAddress()` throws when
 * the adapter cannot determine one; an attempt that cannot be attributed still
 * counts, against the shared `unknown` bucket, rather than escaping the ceiling.
 */
function safeClientAddress(event: { getClientAddress: () => string }): string | null {
	try {
		return event.getClientAddress();
	} catch {
		return null;
	}
}
