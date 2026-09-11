/**
 * The Audit Log's `load` (Story 7.5, FR-33).
 *
 * `requireLiveDestination` FIRST, before any read, mirroring
 * `board/+page.server.ts:41-59` exactly. The `audit-log` destination is live
 * for every Manager in the Auction, Contract Assignment and Archived phases
 * (`server/destinations.ts:114,127,135`) and is absent from `Setup`, so a
 * request from Setup receives the guard's 403 — never a redirect, and never an
 * empty Log, which on this surface would be indistinguishable from a League
 * that has recorded nothing.
 *
 * **There is no action here at all, and there never may be.** This is a read
 * surface over an insert-only log: nothing on it edits, deletes, redacts or
 * "corrects" an entry, and there is no form action, no POST and no control
 * that mutates anything. That is not a gap to be filled later — it is the
 * property that makes the Log worth reading.
 *
 * **Every Manager reads it in full**, the Commissioner included and with no
 * viewer-relative content whatsoever: there is no per-Team view of an audit
 * trail, so unlike the Bid Board this `load` resolves no actor from the session
 * beyond what the guard needs.
 *
 * The read goes through `writeGateway()` — the same direct Postgres connection
 * `auction_events` is read through, which is what `loadEventsViaClient` needs;
 * the browser's own credentials are never a read path for the log (AD-9).
 */

import { auditQueryString, auditCountSentence } from '$lib/core/audit-log.ts';
import { AUDIT_LOG_DESTINATION_ID, readFilteredAuditLog } from '$lib/server/audit-log.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requireLiveDestination(locals.session, locals.phase.name, AUDIT_LOG_DESTINATION_ID);

	// The read, then the three filters parsed against a type catalogue that
	// includes the types actually present in the log. An unrecognised `type`
	// refuses with a 400 from inside here rather than being ignored.
	const { log, filter, rows } = await readFilteredAuditLog(writeGateway(), url.searchParams);

	return {
		phase: locals.phase,
		// Every word of every entry is already chosen by `core/audit-log.ts` —
		// the surface prints them and words nothing itself.
		rows,
		filter,
		figuresAt: log.figuresAt,
		countSentence: auditCountSentence(rows.length, log.rows.length),
		teamOptions: log.teamOptions,
		playerOptions: log.playerOptions,
		typeOptions: log.typeOptions,
		// The export link's query string, built by the core off the same filter
		// the rows were taken with, so the page and the CSV cannot disagree.
		exportQuery: auditQueryString(filter)
	};
};
