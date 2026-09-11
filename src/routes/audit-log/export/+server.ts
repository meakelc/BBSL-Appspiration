/**
 * The Audit Log's export. `GET /audit-log/export?team=&player=&type=` -> CSV.
 * Story 7.5, FR-33.
 *
 * **The same guard, the same read, the same filters, the same rows.**
 * `requireLiveDestination` runs FIRST here exactly as it does on the page
 * load, before any read: an export path that answered in a phase the page is
 * refused in would be a hole straight through the destination catalog. Both
 * entry points then go through `readFilteredAuditLog`, so the CSV is a
 * serialisation of the array the page renders rather than a second derivation
 * that could drift from it.
 *
 * **Nothing here writes.** It is a `GET` and there is no other handler in this
 * file: no `POST`, no `DELETE`, and no way to reach a mutation from this path.
 *
 * `cache-control: no-store`, `api/watermark/+server.ts:48-75`'s posture: the
 * whole value of this response is that it states what the Log held at the
 * moment it was asked, and a cached audit export is a stale record presented
 * as a current one. The global security headers come from `hooks.server.ts`
 * via `server/security-headers.ts:36-54` and are deliberately not re-added.
 */

import { auditRowsToCsv } from '$lib/core/audit-export.ts';
import { AUDIT_LOG_DESTINATION_ID, readFilteredAuditLog } from '$lib/server/audit-log.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { RequestHandler } from './$types';

/** What the browser saves it as. Stable, so a second export overwrites the first. */
const EXPORT_FILENAME = 'audit-log.csv';

export const GET: RequestHandler = async ({ locals, url }) => {
	requireLiveDestination(locals.session, locals.phase.name, AUDIT_LOG_DESTINATION_ID);

	const { rows } = await readFilteredAuditLog(writeGateway(), url.searchParams);

	return new Response(auditRowsToCsv(rows), {
		headers: {
			// `charset=utf-8` stated explicitly: the Log renders an em dash, a
			// U+2212 minus sign and a right arrow, and a reader that guessed
			// Latin-1 would mangle every one of them.
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${EXPORT_FILENAME}"`,
			'cache-control': 'no-store'
		}
	});
};
