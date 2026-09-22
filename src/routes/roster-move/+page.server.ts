/**
 * The `/roster-move` route: a gated `GET` state machine and one `record`
 * action that commits the Roster Move (Story 7.11, FR-44).
 *
 * **Two branches, one route, and the branch is decided server-side.** A
 * Manager acts on their OWN Team only — the Team is resolved from
 * `locals.session.registered.manager.teamId` and never from a form field, and
 * a `team` parameter naming anybody else is refused whatever the page
 * rendered. The Commissioner may name any Team, and pays for it with the
 * dashed reason sheet and a mandatory free-text reason. `isCommissioner` on
 * the session's own manager row is what chooses, so there is no way to reach
 * the Commissioner branch by asking for it.
 *
 * **Every guard runs on `load` AND on the action.** This destination live for
 * this phase and this role, and the League not overridable once Archived —
 * plus, on the Commissioner branch only, `requireCommissioner` and
 * `requireOverrideReason`. Hiding a form is never the check, and neither is
 * rendering a sheet.
 *
 * **Three steps, all of them ordinary navigation.** The Commissioner picks a
 * Team; a Manager's is already decided. Then pick the Contracts and the Slot
 * each is to occupy, then read the sheet and commit. The first two steps
 * carry their selection in the query string and the third is a plain `POST` —
 * no `use:enhance`, no client state that matters, and the Move still commits
 * and is still refused with JavaScript switched off.
 *
 * **Nothing this file decides is a rules gate.** The Team, the Contracts
 * named, their commanded Slots, the contested ground, the money and the
 * capacity are all re-derived inside `recordRearrange`'s transaction, under
 * the global lock, from the log and the tables that transaction itself read.
 * The sheet is rendered from the SAME `evaluateRearrange` a moment earlier, so
 * the two cannot disagree about the rule — only about when they read the
 * world (AD-9).
 *
 * All writes go through `writeGateway()`, the direct Postgres connection
 * `auction_events` writes through.
 */

import { error, fail } from '@sveltejs/kit';

import { classifyDeviceClass } from '$lib/core/device-class.ts';
import { SLOT_LABELS, chargedCapHit } from '$lib/core/rules/roster-import.ts';
import { describeActAmount } from '$lib/core/rules/roster-act.ts';
import {
	REARRANGEABLE_SLOTS,
	isRearrangeableSlot,
	rearrangeActSentence,
	rearrangeRefusalDetail
} from '$lib/core/rules/roster-rearrange.ts';
import type { RearrangingTeam } from '$lib/core/rules/roster-rearrange.ts';
import type { RosterSlotKind } from '$lib/core/types.ts';
import {
	ROSTER_MOVE_COMMIT_LABEL,
	confirmSheetView,
	rearrangeReasonRows,
	reasonSheetView
} from '$lib/reason-sheet-view.ts';
import { requireCommissioner } from '$lib/server/commissioner-guard.ts';
import { requireLiveDestination } from '$lib/server/destinations.ts';
import { requireOverridablePhase, requireOverrideReason } from '$lib/server/override-guard.ts';
import {
	FOREIGN_TEAM_REFUSAL,
	FOREIGN_TEAM_REFUSAL_STATUS,
	NO_TEAM_REFUSAL,
	UNKNOWN_TEAM_REFUSAL,
	UNKNOWN_TEAM_STATUS,
	loadRosterRearrangeTeams,
	previewRosterRearrange,
	recordRearrange
} from '$lib/server/roster-rearrange.ts';
import type { RosterRearrangeRejection } from '$lib/server/roster-rearrange.ts';
import { writeGateway } from '$lib/shell/db.ts';

import type { Actions, PageServerLoad } from './$types';

const ROSTER_MOVE_DESTINATION_ID = 'roster-move';

/**
 * The prefix every per-Player Slot choice is submitted under — `move.<id>`.
 */
const MOVE_FIELD_PREFIX = 'move.';

/**
 * The field name the row for one Player submits under.
 *
 * **The Player is in the NAME and the Slot is the VALUE**, which is what lets
 * each row be an independent radio group. HTML groups radios by name alone, so
 * one shared `move` field could only ever have held one row's answer — the
 * two-Slot picker got away with a checkbox per row because "ticked" meant "to
 * the other one" and there was only ever one other one. With three Slots each
 * row has two possible targets and a "leave it where it is", which is a choice
 * rather than a toggle.
 *
 * It stays an ordinary repeated `GET` field that a form produces with no
 * script, and the same shape is what the sheet's cancel link and the commit
 * action carry, so one parser reads every entry point.
 */
function moveFieldFor(fantraxPlayerId: string): string {
	return `${MOVE_FIELD_PREFIX}${fantraxPlayerId}`;
}

/**
 * The reason the SHEET is previewed under, which is never written anywhere.
 *
 * `previewRosterRearrange` evaluates the act without committing it, and
 * `RearrangeRoster.reason` is part of the command's shape — but no gate reads
 * it and no event is appended, so the value is inert. The Commissioner's real
 * reason is typed on the sheet and validated by `requireOverrideReason` when
 * it posts; a Manager's Move carries `null` here as well as at commit,
 * because FR-44 asks them for none.
 *
 * Named rather than inlined so that property is stated where the literal is,
 * and so nothing can mistake it for a default that could reach a write.
 */
const PREVIEW_REASON = 'preview';

/** Every guard both entry points share, in one place, so they cannot drift. */
function guard(locals: App.Locals): void {
	requireLiveDestination(locals.session, locals.phase.name, ROSTER_MOVE_DESTINATION_ID);
	// NOT covered by the destination gate: `/board` and `/teams` are live in
	// Archived, so a Move reached from one of those would pass it. The archived
	// refusal is its own gate and its own wording.
	requireOverridablePhase(locals.phase.name);
}

/** Whether this session acts as the Commissioner — the one thing that branches. */
function actsAsCommissioner(session: App.Locals['session']): boolean {
	return session.kind === 'registered' && session.manager.isCommissioner;
}

/**
 * The Team this request may act on — **resolved from the session for a
 * Manager, and never from the form** (FR-44).
 *
 * A Manager naming another Team is refused server-side whatever the page
 * rendered, which is the one guard this route exists to hold. The
 * Commissioner's branch takes the requested Team from the query string and is
 * protected by `requireCommissioner` and by `requireKnownTeam` below instead.
 *
 * Returns `''` for the Commissioner's first step, where no Team has been
 * chosen yet.
 */
function resolveTeamId(locals: App.Locals, requested: string): string {
	if (actsAsCommissioner(locals.session)) {
		requireCommissioner(locals.session);
		return requested;
	}
	if (locals.session.kind !== 'registered') {
		// Unreachable: `requireLiveDestination` gives a non-registered session
		// exactly `[Sign-in]` and has already refused. The guard is what lets
		// the type say so.
		error(FOREIGN_TEAM_REFUSAL_STATUS, FOREIGN_TEAM_REFUSAL);
	}
	const own = locals.session.manager.teamId;
	if (own === null) error(FOREIGN_TEAM_REFUSAL_STATUS, NO_TEAM_REFUSAL);
	// **Refused, not silently substituted.** Quietly swapping the Team would
	// commit an act the submitter did not ask for; the refusal says what the
	// rule is.
	if (requested !== '' && requested !== own) {
		error(FOREIGN_TEAM_REFUSAL_STATUS, FOREIGN_TEAM_REFUSAL);
	}
	return own;
}

/**
 * Refuse a Team id no `teams` row answers to.
 *
 * **Without this the id becomes the Team's NAME.**
 * `loadRosterRearrangeState` falls back `teams.find(...)?.name ?? teamId`, so
 * a mistyped or stale id renders an empty picker headed by a machine token
 * and — if a Move somehow committed — would write that token into a permanent
 * payload as `teamName`. This story's whole position on ids is that an id is
 * not a name.
 *
 * A Manager's own id never reaches this: it came from their session row,
 * which is a Team by construction. It is the Commissioner's query-string id
 * that can be anything.
 */
function requireKnownTeam(teams: readonly { readonly id: string }[], teamId: string): void {
	if (teams.some((team) => team.id === teamId)) return;
	error(UNKNOWN_TEAM_STATUS, UNKNOWN_TEAM_REFUSAL);
}

/** The acting Manager or Commissioner, resolved from the session (AD-15). */
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

/**
 * Whether a submitted string is one of the four Slot kinds at all.
 *
 * **The four, not the three.** `isRearrangeableSlot` answers a RULE — which
 * Slots a Move may name — and asking it here would make this route the check
 * for it, which the story forbids and which `evaluateRearrange` already does
 * properly. This asks only whether the string is a `RosterSlotKind`, so
 * `dead_money` is parsed and handed to the core, which refuses the WHOLE act
 * as `unmovable_slot`.
 *
 * `SLOT_LABELS` is keyed by the full union, so this test is exhaustive by
 * construction: a fifth Slot kind added to `RosterSlotKind` makes that record
 * a compile error until it gains a label, and this predicate follows it
 * without being edited.
 */
function isSlotKind(value: string): value is RosterSlotKind {
	return Object.hasOwn(SLOT_LABELS, value);
}

/**
 * Every `move.<id>` choice submitted, parsed into the command's own shape.
 *
 * Deduplicated on the Player — the FIRST value for a field wins, so a crafted
 * URL repeating one row's field cannot depart the same Contract twice — and
 * sorted by id, so the same selection produces the same command whichever
 * order the rows were answered in (AD-5).
 *
 * **An empty value means "leave it where it is" and is not a move.** It is the
 * radio each row is rendered with selected, so an untouched picker submits one
 * blank field per Contract and commands nothing.
 *
 * **It parses; it does not judge.** Only a value that names no Slot kind at
 * all is dropped, because there is nothing to hand the core — every real Slot
 * kind is passed through, INCLUDING the one a Move may not name. That is the
 * difference between a parser and a gate: the refusal for a Dead Money target
 * has to come from the rules core rather than from this screen, and a
 * per-entry drop here would let a POST carrying one legitimate move alongside
 * `move.p-x=dead_money` commit the legitimate leg instead of refusing the
 * whole act.
 */
function movesFrom(
	params: URLSearchParams
): readonly { fantraxPlayerId: string; toPlacement: RosterSlotKind }[] {
	const byPlayer = new Map<string, RosterSlotKind>();
	for (const [name, value] of params) {
		if (!name.startsWith(MOVE_FIELD_PREFIX)) continue;
		const fantraxPlayerId = name.slice(MOVE_FIELD_PREFIX.length);
		if (fantraxPlayerId === '') continue;
		// "Leave it where it is" — the default every row carries.
		if (value === '') continue;
		if (!isSlotKind(value)) continue;
		if (byPlayer.has(fantraxPlayerId)) continue;
		byPlayer.set(fantraxPlayerId, value);
	}
	return [...byPlayer.entries()]
		.map(([fantraxPlayerId, toPlacement]) => ({ fantraxPlayerId, toPlacement }))
		.sort((left, right) =>
			left.fantraxPlayerId === right.fantraxPlayerId
				? 0
				: left.fantraxPlayerId < right.fantraxPlayerId
					? -1
					: 1
		);
}

/**
 * The reviewed selection as a query string — the one place its shape is built.
 *
 * The sheet's cancel link and the commit action both carry it, and `movesFrom`
 * above reads exactly what this writes, so the two cannot drift.
 */
function moveQuery(
	teamId: string,
	moves: readonly { fantraxPlayerId: string; toPlacement: RosterSlotKind }[]
): URLSearchParams {
	const query = new URLSearchParams();
	query.set('team', teamId);
	for (const move of moves) query.set(moveFieldFor(move.fantraxPlayerId), move.toPlacement);
	return query;
}

/**
 * The Team's roster as the picker lists it.
 *
 * **Only the rearrangeable rows are offered.** Dead Money is a charge and not
 * a Player; the rules core refuses it if it is named anyway, and the picker not
 * offering it is the same fact said once more where it stops a pointless
 * refusal. Injury Reserve rows ARE offered, and so is Injury Reserve as a
 * target (FR-44) — `REARRANGEABLE_SLOTS` is the one statement of which Slots
 * participate, and this reads it rather than repeating it.
 *
 * Each row carries every OTHER participating Slot as a target — three Slots
 * means two of them, so the choice is a short list rather than a toggle — and
 * the CHARGED figure it takes off Cap Space today, which is `$0` for a stash
 * and is exactly the number a Move changes.
 *
 * **The targets come from the rules core's own list, in its own order**, and
 * the row's current Slot is the only one removed. Nothing here decides which
 * Slots a Move may name.
 */
function pickerRowsFor(
	team: RearrangingTeam,
	chosen: readonly { fantraxPlayerId: string; toPlacement: RosterSlotKind }[]
) {
	const commanded = new Map(chosen.map((move) => [move.fantraxPlayerId, move.toPlacement]));
	return {
		teamId: team.teamId,
		teamName: team.teamName,
		players: team.rows
			.filter((row) => isRearrangeableSlot(row.rosterSlotKind))
			.map((row) => ({
				fantraxPlayerId: row.fantraxPlayerId,
				playerName: row.playerName,
				slotLabel: SLOT_LABELS[row.rosterSlotKind],
				// The CHARGED figure, which is what the Team's Cap Space counted.
				// `describeActAmount` for the sheet's reason: an imported Cap Hit
				// need not sit on the $500,000 grid.
				capHit: describeActAmount(
					chargedCapHit({ capHit: row.value, rosterSlotKind: row.rosterSlotKind })
				),
				field: moveFieldFor(row.fantraxPlayerId),
				targets: REARRANGEABLE_SLOTS.filter((slot) => slot !== row.rosterSlotKind).map(
					(slot) => ({ value: slot, label: SLOT_LABELS[slot] })
				),
				/** The target commanded by the query string, or `''` for "leave it". */
				chosen: commanded.get(row.fantraxPlayerId) ?? '',
				won: row.won
			}))
			.sort((left, right) => left.playerName.localeCompare(right.playerName))
	};
}

export const load: PageServerLoad = async ({ locals, url }) => {
	guard(locals);

	const commissioner = actsAsCommissioner(locals.session);
	const teamId = resolveTeamId(locals, url.searchParams.get('team') ?? '');
	const moves = movesFrom(url.searchParams);
	const confirming = url.searchParams.get('confirm') === 'yes';

	const base = {
		phase: locals.phase,
		commissioner,
		teamId
	};

	// Step one, the Commissioner's only: one Team, and nothing else is asked
	// yet. A Manager never sees it — their Team came from the session.
	if (teamId === '') {
		return {
			...base,
			step: 'team' as const,
			teams: await loadRosterRearrangeTeams(writeGateway()),
			team: null,
			sheet: null,
			managerSheet: null,
			refusal: null,
			commitAction: null
		};
	}

	// **Before the picker renders.** Only the Commissioner can supply an
	// arbitrary Team id; a Manager's came from their own session row.
	if (commissioner) requireKnownTeam(await loadRosterRearrangeTeams(writeGateway()), teamId);

	const preview = await previewRosterRearrange(writeGateway(), {
		teamId,
		moves,
		// The sheet is a READ — see `PREVIEW_REASON`. A Manager's Move carries
		// no reason at all, here or at commit.
		reason: commissioner ? PREVIEW_REASON : null
	});

	const withTeam = {
		...base,
		teams: commissioner ? preview.teams : [],
		// The selection is carried on the ROWS, as each one's chosen target —
		// there is no separate list of values for the page to match against.
		team: pickerRowsFor(preview.team, moves)
	};

	// Step three: the sheet. Only a Move the core PERMITS gets one — a refused
	// Move is reported in the same sentence the transaction would have used,
	// and offers no control that would cancel a Bid.
	if (confirming) {
		if (preview.outcome.kind === 'permitted') {
			const { delta, capBefore, gates, maximumBid } = preview.outcome;
			// The reviewed selection, in ONE string built by `moveQuery`.
			//
			// It travels on the commit's action URL rather than as hidden fields
			// inside the sheet, because the sheet's `<form>` belongs to the sheet
			// component and a second form nested in it is invalid HTML the
			// browser silently drops — which would post a Move naming nothing.
			const query = moveQuery(teamId, moves);
			const input = {
				act: rearrangeActSentence(delta),
				commitLabel: ROSTER_MOVE_COMMIT_LABEL,
				// Both sheets read the SAME rows, from the same evaluation: the
				// Manager's sheet is not a shorter sheet, it is the same statement
				// of consequences without a demand for a justification.
				rows: rearrangeReasonRows(delta, capBefore, gates.cap, maximumBid),
				// Back to the picker with the selection intact. Cancel is a way
				// back, never a refusal.
				cancelHref: `/roster-move?${query.toString()}`
			};
			return {
				...withTeam,
				step: 'sheet' as const,
				sheet: commissioner ? reasonSheetView(input) : null,
				managerSheet: commissioner ? null : confirmSheetView(input),
				refusal: null,
				commitAction: `?/record&${query.toString()}`
			};
		}
		return {
			...withTeam,
			step: 'players' as const,
			sheet: null,
			managerSheet: null,
			commitAction: null,
			refusal: {
				// The sentence is the pure core's, through the preview — this route
				// words no refusal of its own, so the page, the tests and the
				// transaction all read one wording.
				detail: rearrangeRefusalDetail(preview.outcome.refusal, preview.outcome.gates)
			}
		};
	}

	// Step two: the roster, with nothing decided.
	return {
		...withTeam,
		step: 'players' as const,
		sheet: null,
		managerSheet: null,
		refusal: null,
		commitAction: null
	};
};

export const actions: Actions = {
	record: async ({ request, locals, url }) => {
		guard(locals);

		const commissioner = actsAsCommissioner(locals.session);
		// **The Team is resolved again, here, from the session.** A POST naming
		// a foreign Team is refused whatever the page rendered.
		const teamId = resolveTeamId(locals, url.searchParams.get('team') ?? '');
		// **The same check the `load` makes, on the write path.** Without it an
		// unknown id would be written into a permanent payload as the Team's
		// NAME, through `loadRosterRearrangeState`'s `?? teamId` fallback.
		if (commissioner) requireKnownTeam(await loadRosterRearrangeTeams(writeGateway()), teamId);
		const moves = movesFrom(url.searchParams);

		const form = await request.formData();

		// **Before the write, and before anything else is decided.** A reasonless
		// Commissioner override is a 400 raised here, so nothing is written and
		// no transaction is even opened for it. A Manager's own Move carries no
		// reason at all — FR-44 requires a confirmation, not a justification —
		// so the guard is not called on that branch and there is no field for it
		// to read.
		const reason = commissioner ? requireOverrideReason(form) : null;

		const actor = actorFrom(locals.session);
		if (actor === null) {
			// `auction_events.manager_id`/`team_id` carry the actor, so there is
			// no event to append for an account bound to no Team.
			return fail(400, { notice: NO_TEAM_REFUSAL });
		}

		// Read here and only here, at the transport boundary: the pure core
		// classifies the string and never sees the header.
		const deviceClass = classifyDeviceClass(request.headers.get('user-agent'));

		const outcome = await recordRearrange(
			writeGateway(),
			actor,
			{ teamId, moves, reason },
			deviceClass
		);

		if (outcome.kind === 'rejected') {
			const rejection = outcome.reason as RosterRearrangeRejection | undefined;
			return fail(409, { notice: rejection?.detail ?? 'The Roster Move was refused.' });
		}

		const appended = outcome.events[0];
		return {
			notice:
				'The Roster Move is recorded. The Team’s Cap Space, Roster Count, Slot occupancy and ' +
				'Maximum Bid are recomputed from it, and the entry is in the Audit Log. It is not ' +
				'announced in Discord, and it can be undone by moving the Contract back.',
			appended:
				appended === undefined ? null : { seq: appended.seq, occurredAt: appended.occurredAt }
		};
	}
};
