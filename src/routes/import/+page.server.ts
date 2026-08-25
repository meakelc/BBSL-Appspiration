/**
 * The Commissioner-only `/import` route: gated `load`, and the `upload`
 * action that stages a thirty-one-file drop — thirty Team roster files plus the one
 * Free Agent pool file — as one batch.
 *
 * Two server-side gates, in order — `requireCommissioner` (a Commissioner
 * only, whichever session kind) and `requireLiveDestination` (this
 * destination is live for Setup and this role) — on both `load` and the
 * `upload` action, per this story's Boundaries & Constraints ("Route:
 * requireCommissioner + requireLiveDestination(..., 'import') at /import").
 * Hiding the upload form is never the check; a non-Commissioner or a request
 * outside Setup refuses here regardless of what any client renders.
 *
 * `service-role writes only`: `upload` never reaches the browser's own
 * credentials — every write goes through `writeGateway()`, the same direct
 * Postgres connection `auction_events` writes through.
 */

import { fail } from '@sveltejs/kit';

import { requireCommissioner } from '$lib/server/commissioner-guard.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import {
	loadImportStatus,
	loadPoolStatus,
	outstandingSourceNames
} from '$lib/server/import-status.ts';
import { stagePoolFile } from '$lib/server/pool-import.ts';
import { isPoolFileName } from '$lib/server/pool-registry.ts';
import { stageRosterFile } from '$lib/server/roster-import.ts';
import type { StageOutcome } from '$lib/server/roster-import.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { Actions, PageServerLoad } from './$types';

const IMPORT_DESTINATION_ID = 'import';

export const load: PageServerLoad = async ({ locals }) => {
	requireCommissioner(locals.session);
	requireLiveDestination(locals.session, locals.phase.name, IMPORT_DESTINATION_ID);

	const [statuses, pool] = await Promise.all([loadImportStatus(), loadPoolStatus()]);

	return {
		phase: locals.phase,
		statuses,
		pool,
		// One list, thirty-one sources — the Teams still outstanding plus the
		// Free Agent pool when it is not staged (Story 1.8).
		outstanding: outstandingSourceNames(statuses, pool)
	};
};

export const actions: Actions = {
	upload: async ({ request, locals }) => {
		requireCommissioner(locals.session);
		requireLiveDestination(locals.session, locals.phase.name, IMPORT_DESTINATION_ID);

		const form = await request.formData();
		// No size filter: a zero-byte File is a real upload attempt that
		// deserves a status like any other, not silent omission. `parseRosterCsv`
		// already refuses an empty file at content altitude (Boundaries &
		// Constraints, amended at review-loop-iteration 1), so it reaches the
		// same path as any other invalid file.
		const files = form.getAll('files').filter((value): value is File => value instanceof File);

		if (files.length === 0) {
			return fail(400, { notice: 'No files were supplied.' });
		}

		const gateway = writeGateway();
		// One shared batch state across BOTH routers: `claimedInBatch` for the
		// thirty Team sources, `poolClaimed` for the one pool source. A drop is
		// thirty-one files, and each source may be claimed once within it.
		const claimedInBatch = new Set<string>();
		const poolClaimed = { claimed: false };
		const results: StageOutcome[] = [];
		for (const file of files) {
			// Each file is staged independently (this story's Intent). A thrown
			// error here — a genuine bug or an infrastructure failure inside
			// `stageRosterFile`/`stagePoolFile` — must not abort every file still
			// queued behind it in the batch, so it is caught per file and
			// converted into that file's own result rather than propagating out
			// of the action (amended at 1.7's review-loop-iteration 1).
			try {
				const csvText = await file.text();

				// Pool routing runs BEFORE Team resolution (Story 1.8): the pool
				// file is not a roster and must never be put through
				// `resolveTeamByFileName`. `stagePoolFile` does the
				// refuse-not-guess check for a name that would resolve BOTH ways,
				// inside its own transaction and against the same Team list
				// `stageRosterFile` reads — silently staging a Team's roster as
				// the pool, or the reverse, is a data-loss shape, not a mismatch.
				results.push(
					isPoolFileName(file.name)
						? await stagePoolFile(gateway, file.name, csvText, poolClaimed)
						: await stageRosterFile(gateway, file.name, csvText, claimedInBatch)
				);
			} catch (error) {
				results.push({
					kind: 'error',
					source: 'unknown',
					fileName: file.name,
					detail: error instanceof Error ? error.message : String(error)
				});
			}
		}

		return { results };
	}
};
