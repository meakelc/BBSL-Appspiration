/**
 * The Commissioner-only `/import` route: gated `load`, the `upload` action
 * that stages a thirty-one-file drop — thirty Team roster files plus the one
 * Free Agent pool file — as one batch, and the `promote` action that commits
 * all thirty-one sources to the live reference tables in one transaction or
 * none (Story 1.9).
 *
 * Two server-side gates, in order — `requireCommissioner` (a Commissioner
 * only, whichever session kind) and `requireLiveDestination` (this
 * destination is live for Setup and this role) — on both `load` and the
 * `upload` action AND the `promote` action, per Boundaries & Constraints
 * ("Route keeps requireCommissioner + requireLiveDestination(..., 'import')
 * on load and on BOTH actions"). Hiding a form is never the check; a
 * non-Commissioner or a request outside Setup refuses here regardless of
 * what any client renders.
 *
 * **The confirm checkbox is never the check either.** `promote` refuses a
 * request without the explicit confirm field with a 400 and writes nothing,
 * but every real gate — all thirty-one sources staged, no slot ceiling
 * breached, the phase folded from the log — is re-derived server-side INSIDE
 * `promoteImport`'s transaction, so a page that loaded during Setup cannot
 * race a promotion past an auction that has since opened.
 *
 * `service-role writes only`: `upload` never reaches the browser's own
 * credentials — every write goes through `writeGateway()`, the same direct
 * Postgres connection `auction_events` writes through.
 */

import { fail } from '@sveltejs/kit';

import { promotionRefusalDetail } from '$lib/core/rules/import-preview.ts';
import { requireCommissioner } from '$lib/server/commissioner-guard.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import {
	loadImportStatus,
	loadPoolStatus,
	outstandingSourceNames
} from '$lib/server/import-status.ts';
import { loadImportPreview } from '$lib/server/import-preview.ts';
import { promoteImport } from '$lib/server/import-promotion.ts';
import type { PromotionRejection } from '$lib/server/import-promotion.ts';
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

	const [statuses, pool, preview] = await Promise.all([
		loadImportStatus(),
		loadPoolStatus(),
		// Staging only — the preview never reads a live table (Boundaries &
		// Constraints). It reports what the NEXT promotion would commit, which
		// after a promotion is not the same question as what is already live.
		loadImportPreview()
	]);

	return {
		phase: locals.phase,
		statuses,
		pool,
		preview,
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
	},

	/**
	 * Commit all thirty-one staged sources to the live reference tables, in
	 * one transaction or none.
	 *
	 * Both guards re-run — this is a separate request from the `load` that
	 * rendered the preview. The confirm field is a deliberate,
	 * explicitly-checked step ("confirm before commit"), not a gate: it only
	 * establishes that this request meant to commit. Everything that could
	 * make committing wrong is decided inside the transaction.
	 */
	promote: async ({ request, locals }) => {
		requireCommissioner(locals.session);
		requireLiveDestination(locals.session, locals.phase.name, IMPORT_DESTINATION_ID);

		const form = await request.formData();
		if (form.get('confirm') !== 'yes') {
			// A distinct field from `upload`'s `notice`: both actions render into
			// the same page, and a promotion refusal shown under the upload form
			// would name the wrong control.
			return fail(400, {
				promoteNotice:
					'Promotion was not confirmed. Nothing was written. Tick the confirmation and submit again.'
			});
		}

		// The actor, resolved server-side from the application tables the
		// session already carries (AD-4) — never from a form field. The guard
		// above has already established this session is a registered
		// Commissioner, so the narrowing below cannot fail; it exists because
		// `requireCommissioner` returns void rather than the manager.
		const session = locals.session;
		// `auction_events.manager_id` and `team_id` are both NOT NULL from the
		// first event onward (AD-4), so an actor with no Team binding has no
		// event to append and must be refused before the transaction opens
		// rather than by a constraint violation inside it. The SENTENCE still
		// comes from the pure core, like every other refusal on this route —
		// only the decision is made here, because it is the one gate that
		// cannot wait for the transaction to open. Story 1.4 binds the
		// Commissioner's own Team like any other Manager's; this is the
		// unbound-row case, not a special case for the Commissioner.
		if (session.kind !== 'registered' || session.manager.teamId === null) {
			return fail(400, {
				promoteNotice: promotionRefusalDetail({ kind: 'unbound_actor' })
			});
		}
		const teamId = session.manager.teamId;

		const outcome = await promoteImport(writeGateway(), {
			managerId: session.manager.id,
			teamId
		});

		if (outcome.kind === 'rejected') {
			// The refusal sentence comes from the pure core, through
			// `promoteImport`'s rejection — the route never words a refusal
			// itself, so the page, the tests and the transaction all read one
			// wording.
			const rejection = outcome.reason as PromotionRejection | undefined;
			return fail(409, {
				promoteNotice: rejection?.detail ?? 'Promotion was refused.'
			});
		}

		const appended = outcome.events[0];
		return {
			promoted: {
				// Exactly one ImportPromoted event, and the surface states its
				// place in the log so the Commissioner can find it in the Audit
				// Log.
				seq: appended?.seq ?? null,
				occurredAt: appended?.occurredAt ?? null
			},
			promoteNotice:
				'Promoted. Every one of the thirty-one sources was committed to the live tables in one transaction.'
		};
	}
};
