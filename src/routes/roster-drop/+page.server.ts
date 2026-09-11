/**
 * The Commissioner-only `/roster-drop` route: a three-step gated `load` and
 * one `record` action that commits the Drop (Story 7.8, FR-43).
 *
 * **Three guards, in order, on `load` AND on the action** — a Commissioner
 * only, this destination live for this phase and this role, and the League
 * not Archived. `/roster-move` is the template for all three, and this route
 * copies it rather than inventing a second shape. Hiding a form is never the
 * check, and neither is rendering a sheet.
 *
 * **Three steps, all of them ordinary navigation.** Pick the Team, pick the
 * Players from its roster, then read the sheet and commit. The first two
 * steps carry their selection in the query string and the third is a plain
 * `POST` — no `use:enhance`, no client state that matters, and the reason
 * still typed and the Drop still refused with JavaScript switched off.
 *
 * **Nothing this file decides is a rules gate.** The Team, the Players named,
 * the contested ground, the money and the capacity are all re-derived inside
 * `recordDrop`'s transaction, under the global lock, from the log and the
 * tables that transaction itself read. The sheet is rendered from the SAME
 * `evaluateDrop` a moment earlier, so the two cannot disagree about the rule
 * — only about when they read the world (AD-9).
 *
 * **The reason is validated server-side**, by `requireOverrideReason`, over
 * what was submitted rather than over what was rendered. The `required`
 * attribute on the sheet's textarea is a courtesy; that call is the check.
 *
 * All writes go through `writeGateway()`, the direct Postgres connection
 * `auction_events` writes through.
 */

import { fail } from '@sveltejs/kit';

import { classifyDeviceClass } from '$lib/core/device-class.ts';
import { SLOT_LABELS, chargedCapHit } from '$lib/core/rules/roster-import.ts';
import { describeMoveAmount } from '$lib/core/rules/roster-move.ts';
import { dropActSentence, dropRefusalDetail } from '$lib/core/rules/roster-drop.ts';
import type { DroppingTeam } from '$lib/core/rules/roster-drop.ts';
import {
	DROP_COMMIT_LABEL,
	dropReasonRows,
	reasonSheetView
} from '$lib/reason-sheet-view.ts';
import { requireCommissioner } from '$lib/server/commissioner-guard.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import { requireOverridablePhase, requireOverrideReason } from '$lib/server/override-guard.ts';
import { loadRosterDropTeams, previewRosterDrop, recordDrop } from '$lib/server/roster-drop.ts';
import type { RosterDropRejection } from '$lib/server/roster-drop.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { Actions, PageServerLoad } from './$types';

const ROSTER_DROP_DESTINATION_ID = 'roster-drop';

/** Every guard this surface has, in one place, so `load` and the action cannot drift. */
function guard(locals: App.Locals): void {
	requireCommissioner(locals.session);
	requireLiveDestination(locals.session, locals.phase.name, ROSTER_DROP_DESTINATION_ID);
	// NOT covered by the destination gate: `/board` and `/teams` are live in
	// Archived, so an override reached from one of those would pass it. The
	// archived refusal is its own gate and its own wording.
	requireOverridablePhase(locals.phase.name);
}

/** The acting Commissioner, resolved from the session (AD-15) — never a form field. */
function actorFrom(session: App.Locals['session']) {
	if (session.kind !== 'registered') return null;
	const { manager } = session;
	if (manager.teamId === null) return null;
	return {
		managerId: manager.id,
		teamId: manager.teamId,
		displayName: manager.displayName
	};
}

/** Every non-empty string value submitted under one name, deduplicated. */
function idsFrom(values: readonly (string | null)[]): readonly string[] {
	const seen = new Set<string>();
	for (const value of values) {
		if (typeof value === 'string' && value !== '') seen.add(value);
	}
	// Sorted, so the same selection produces the same command whichever order
	// the checkboxes were ticked in (AD-5).
	return [...seen].sort();
}

/**
 * The Team's roster as the picker lists it.
 *
 * **Dead Money is not offered**, because it is a charge and not a Player —
 * the core refuses one named anyway, and the picker not offering it is the
 * same fact said once more where it stops a pointless refusal. A WON Player
 * IS listed, marked as won: he cannot be dropped, and a Commissioner looking
 * for a Player who is not in the list would reasonably conclude the roster
 * read was wrong rather than that the act is refused.
 */
function pickerRowsFor(team: DroppingTeam) {
	return {
		teamId: team.teamId,
		teamName: team.teamName,
		players: team.rows
			.filter((row) => row.rosterSlotKind !== 'dead_money')
			.map((row) => ({
				fantraxPlayerId: row.fantraxPlayerId,
				playerName: row.playerName,
				slotLabel: SLOT_LABELS[row.rosterSlotKind],
				// The CHARGED figure, which is what the Team's Cap Space counted
				// — a stash reads $0 here, and that is also exactly what a Drop
				// would leave behind for it. `describeMoveAmount` for the sheet's
				// reason: an imported Cap Hit need not sit on the $500,000 grid,
				// and a picker that hedged would ask the Commissioner to choose a
				// Contract by a figure it would not state.
				capHit: describeMoveAmount(
					chargedCapHit({ capHit: row.value, rosterSlotKind: row.rosterSlotKind })
				),
				won: row.won
			}))
			.sort((left, right) => left.playerName.localeCompare(right.playerName))
	};
}

export const load: PageServerLoad = async ({ locals, url }) => {
	guard(locals);

	const teamId = url.searchParams.get('team') ?? '';
	const fantraxPlayerIds = idsFrom(url.searchParams.getAll('drop'));
	const confirming = url.searchParams.get('confirm') === 'yes';

	// Step one: one Team, and nothing else is asked yet.
	if (teamId === '') {
		return {
			phase: locals.phase,
			step: 'team' as const,
			teams: await loadRosterDropTeams(writeGateway()),
			teamId,
			team: null,
			fantraxPlayerIds,
			sheet: null,
			refusal: null,
			commitAction: null
		};
	}

	const preview = await previewRosterDrop(writeGateway(), {
		teamId,
		fantraxPlayerIds,
		// The sheet is a READ. The reason is typed on it and validated when it
		// posts; a placeholder here would never reach a write.
		reason: 'preview'
	});

	const base = {
		phase: locals.phase,
		teams: preview.teams,
		teamId,
		team: pickerRowsFor(preview.team),
		fantraxPlayerIds
	};

	// Step three: the sheet. Only a Drop the core PERMITS gets one — a refused
	// Drop is reported in the same sentence the transaction would have used,
	// and offers no control that would cancel a Bid.
	if (confirming) {
		if (preview.outcome.kind === 'permitted') {
			const delta = preview.outcome.delta;
			// The reviewed selection, in ONE string built here.
			//
			// It travels on the commit's action URL rather than as hidden fields
			// inside the sheet, because the sheet's `<form>` belongs to
			// `ReasonSheet.svelte` and a second form nested in it is invalid HTML
			// the browser silently drops — which would post a Drop naming no
			// Players at all.
			const query = new URLSearchParams();
			query.set('team', teamId);
			for (const id of fantraxPlayerIds) query.append('drop', id);
			return {
				...base,
				step: 'sheet' as const,
				sheet: reasonSheetView({
					act: dropActSentence(delta),
					commitLabel: DROP_COMMIT_LABEL,
					rows: dropReasonRows(delta),
					// Back to the picker with the selection intact. Cancel is a way
					// back, never a refusal.
					cancelHref: `/roster-drop?${query.toString()}`
				}),
				refusal: null,
				commitAction: `?/record&${query.toString()}`
			};
		}
		return {
			...base,
			step: 'players' as const,
			sheet: null,
			commitAction: null,
			refusal: {
				// The sentence is the pure core's, through the rejection — this
				// route words no refusal of its own, so the page, the tests and
				// the transaction all read one wording.
				detail: dropRefusalDetail(preview.outcome.refusal, preview.outcome.gates)
			}
		};
	}

	// Step two: the roster, with nothing decided.
	return { ...base, step: 'players' as const, sheet: null, refusal: null, commitAction: null };
};

export const actions: Actions = {
	record: async ({ request, locals, url }) => {
		guard(locals);

		// **The selection comes off the action URL and the reason off the form.**
		// The sheet's own `<form>` is `ReasonSheet.svelte`'s and carries exactly
		// one field; the Players reviewed ride the URL `load` built, so what
		// commits is what was rendered rather than what a second form re-stated.
		const teamId = url.searchParams.get('team') ?? '';
		const fantraxPlayerIds = idsFrom(url.searchParams.getAll('drop'));

		const form = await request.formData();

		// **Before the write, and before anything else is decided.** A reasonless
		// override is a 400 raised here, so nothing is written and no transaction
		// is even opened for it.
		const reason = requireOverrideReason(form);

		const actor = actorFrom(locals.session);
		if (actor === null) {
			// `auction_events.manager_id`/`team_id` carry the actor, so there is
			// no event to append for a Commissioner bound to no Team.
			return fail(400, {
				notice: 'This account is not bound to a Team, so there is no actor to record the Drop under.'
			});
		}

		// Read here and only here, at the transport boundary: the pure core
		// classifies the string and never sees the header.
		const deviceClass = classifyDeviceClass(request.headers.get('user-agent'));

		const outcome = await recordDrop(
			writeGateway(),
			actor,
			{ teamId, fantraxPlayerIds, reason },
			deviceClass
		);

		if (outcome.kind === 'rejected') {
			const rejection = outcome.reason as RosterDropRejection | undefined;
			return fail(409, { notice: rejection?.detail ?? 'The Drop was refused.' });
		}

		const appended = outcome.events[0];
		return {
			notice:
				'The Drop is recorded. The Team’s Cap Space, Roster Count and Slot occupancy are ' +
				'recomputed from it, any Dead Money keeps charging under nobody’s name, and the entry ' +
				'is in the Audit Log with the reason. It is not announced in Discord.',
			appended:
				appended === undefined
					? null
					: { seq: appended.seq, occurredAt: appended.occurredAt }
		};
	}
};
