/**
 * The Commissioner-only `/roster-trade` route: a three-step gated `load` and
 * one `record` action that commits the Trade (Story 7.7, FR-41).
 *
 * **Three guards, in order, on `load` AND on the action** — a Commissioner
 * only, this destination live for this phase and this role, and the League
 * not Archived. `/minor-league-eligibility` is the template for the first
 * two; the third is `override-guard.ts`'s, and this route is its first call
 * site. Hiding a form is never the check, and neither is rendering a sheet.
 *
 * **Three steps, all of them ordinary navigation.** Pick the two Teams, pick
 * the Players from each roster, then read the sheet and commit. The first two
 * steps carry their selection in the query string and the third is a plain
 * `POST` — no `use:enhance`, no client state that matters, and the reason
 * still typed and the Trade still refused with JavaScript switched off. That
 * is `ReasonSheet.svelte`'s own discipline and the reason it is a form rather
 * than a modal.
 *
 * **Nothing this file decides is a rules gate.** The two Teams, the Players
 * named, the contested ground, both Teams' money and both Teams' capacity are
 * all re-derived inside `recordRosterTrade`'s transaction, under the global
 * lock, from the log and the tables that transaction itself read. The sheet
 * is rendered from the SAME `evaluateTrade` a moment earlier, so the two
 * cannot disagree about the rule — only about when they read the world
 * (AD-9).
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
import { describeActAmount } from '$lib/core/rules/roster-act.ts';
import { rosterTradeRefusalDetail } from '$lib/core/rules/roster-trade.ts';
import type { TradingTeam } from '$lib/core/rules/roster-trade.ts';
import {
	ROSTER_TRADE_COMMIT_LABEL,
	reasonSheetView,
	rosterTradeActSentence,
	rosterTradeReasonRows
} from '$lib/reason-sheet-view.ts';
import { requireCommissioner } from '$lib/server/commissioner-guard.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import { requireOverridablePhase, requireOverrideReason } from '$lib/server/override-guard.ts';
import {
	loadRosterTradeTeams,
	previewRosterTrade,
	recordRosterTrade
} from '$lib/server/roster-trade.ts';
import type { RosterTradeRejection } from '$lib/server/roster-trade.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { Actions, PageServerLoad } from './$types';

const ROSTER_TRADE_DESTINATION_ID = 'roster-trade';

/** Every guard this surface has, in one place, so `load` and the action cannot drift. */
function guard(locals: App.Locals): void {
	requireCommissioner(locals.session);
	requireLiveDestination(locals.session, locals.phase.name, ROSTER_TRADE_DESTINATION_ID);
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

/** One roster row as the picker lists it. Dead Money is not a Contract and is not offered. */
function pickerRowsFor(team: TradingTeam) {
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
				// — a stash reads $0 here and the sheet is where it changes.
				// `describeActAmount`, for the sheet's reason: an imported Cap Hit
				// carries whatever Fantrax held and need not sit on the $500,000
				// grid, and a picker that hedged would ask the Commissioner to
				// choose a Contract by a figure it would not state.
				capHit: describeActAmount(
					chargedCapHit({ capHit: row.value, rosterSlotKind: row.rosterSlotKind })
				),
				won: row.won
			}))
			.sort((left, right) => left.playerName.localeCompare(right.playerName))
	};
}

export const load: PageServerLoad = async ({ locals, url }) => {
	guard(locals);

	const from = url.searchParams.get('from') ?? '';
	const to = url.searchParams.get('to') ?? '';
	const sendingPlayerIds = idsFrom(url.searchParams.getAll('send'));
	const receivingPlayerIds = idsFrom(url.searchParams.getAll('recv'));
	const confirming = url.searchParams.get('confirm') === 'yes';

	// Step one: two Teams, and nothing else is asked yet.
	if (from === '' || to === '' || from === to) {
		return {
			phase: locals.phase,
			step: 'teams' as const,
			teams: await loadRosterTradeTeams(writeGateway()),
			// Stated so step one can say why it is step one again.
			sameTeam: from !== '' && from === to,
			from,
			to,
			sending: null,
			receiving: null,
			sendingPlayerIds,
			receivingPlayerIds,
			sheet: null,
			refusal: null,
			commitAction: null
		};
	}

	const preview = await previewRosterTrade(writeGateway(), {
		sendingTeamId: from,
		receivingTeamId: to,
		sendingPlayerIds,
		receivingPlayerIds,
		// The sheet is a READ. The reason is typed on it and validated when it
		// posts; a placeholder here would never reach a write.
		reason: 'preview'
	});

	const base = {
		phase: locals.phase,
		teams: preview.teams,
		sameTeam: false,
		from,
		to,
		sending: pickerRowsFor(preview.sending),
		receiving: pickerRowsFor(preview.receiving),
		sendingPlayerIds,
		receivingPlayerIds
	};

	// Step three: the sheet. Only a Trade the core PERMITS gets one — a refused
	// Trade is reported in the same sentence the transaction would have used,
	// and offers no control that would cancel a Bid.
	if (confirming) {
		if (preview.outcome.kind === 'permitted') {
			const delta = preview.outcome.delta;
			// The reviewed selection, in ONE string built here.
			//
			// It travels on the commit's action URL rather than as hidden fields
			// inside the sheet, because the sheet's `<form>` belongs to
			// `ReasonSheet.svelte` and a second form nested in it is invalid HTML
			// the browser silently drops — which would post a Trade naming no
			// Players at all. SvelteKit reads the action name off the
			// `/`-prefixed search param and leaves the rest for `url` in the
			// action, so what commits is exactly what was rendered.
			const query = new URLSearchParams();
			query.set('from', from);
			query.set('to', to);
			for (const id of sendingPlayerIds) query.append('send', id);
			for (const id of receivingPlayerIds) query.append('recv', id);
			return {
				...base,
				step: 'sheet' as const,
				sheet: reasonSheetView({
					act: rosterTradeActSentence(delta),
					commitLabel: ROSTER_TRADE_COMMIT_LABEL,
					rows: rosterTradeReasonRows(delta),
					// Back to the picker with the selection intact. Cancel is a way
					// back, never a refusal.
					cancelHref: `/roster-trade?${query.toString()}`
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
				detail: rosterTradeRefusalDetail(preview.outcome.refusal, preview.outcome.gates)
			}
		};
	}

	// Step two: the two rosters, with nothing decided.
	return { ...base, step: 'players' as const, sheet: null, refusal: null, commitAction: null };
};

export const actions: Actions = {
	record: async ({ request, locals, url }) => {
		guard(locals);

		// **The selection comes off the action URL and the reason off the form.**
		// The sheet's own `<form>` is `ReasonSheet.svelte`'s and carries exactly
		// one field; the Players reviewed ride the URL `load` built, so what
		// commits is what was rendered rather than what a second form re-stated.
		const sendingTeamId = url.searchParams.get('from') ?? '';
		const receivingTeamId = url.searchParams.get('to') ?? '';
		const sendingPlayerIds = idsFrom(url.searchParams.getAll('send'));
		const receivingPlayerIds = idsFrom(url.searchParams.getAll('recv'));

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
				notice: 'This account is not bound to a Team, so there is no actor to record the Trade under.'
			});
		}

		// Read here and only here, at the transport boundary: the pure core
		// classifies the string and never sees the header.
		const deviceClass = classifyDeviceClass(request.headers.get('user-agent'));

		const outcome = await recordRosterTrade(
			writeGateway(),
			actor,
			{ sendingTeamId, receivingTeamId, sendingPlayerIds, receivingPlayerIds, reason },
			deviceClass
		);

		if (outcome.kind === 'rejected') {
			const rejection = outcome.reason as RosterTradeRejection | undefined;
			return fail(409, { notice: rejection?.detail ?? 'The Trade was refused.' });
		}

		const appended = outcome.events[0];
		return {
			notice:
				'The Roster Trade is recorded. Both Teams’ Cap Space, Roster Count and Slot ' +
				'occupancy are recomputed from it, and the entry is in the Audit Log with the ' +
				'reason. It is not announced in Discord.',
			appended:
				appended === undefined
					? null
					: { seq: appended.seq, occurredAt: appended.occurredAt }
		};
	}
};
