/**
 * The Commissioner's assignment monitor: which Teams have submitted, which
 * have not, how many Players each still owes, and what the deadline and the
 * reminder interval currently are (Story 6.2, FR-29).
 *
 * **Every sentence on `/assignment-monitoring` is worded here.** The route
 * prints them and re-words none, `assignmentBoardFor`'s discipline for its
 * reason: this whole view is reachable with no database, so a route that built
 * it itself would be a second statement of what "submitted" and "outstanding"
 * mean and the two could drift.
 *
 * **It states, and it never prompts.** No exclamation mark, no urgency
 * framing, no suggested action, no "chase these Teams". The Commissioner reads
 * facts and decides what to do with them.
 *
 * **Every Team appears, including one that won nothing.** The roster of Teams
 * comes from the identities the caller read, not from the contracts fold —
 * otherwise a Team that took no Auction would be silently absent from a page
 * whose whole job is to say who has finished, and absence would read as
 * outstanding. Such a Team has no length to assign and is counted as done the
 * moment it submits, which is exactly what `refuseSubmission` lets it do.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { formatTeamManagers } from '../team-identity.ts';
import { hasSubmittedAssignments } from '../projection/assignments.ts';
import type { SubmittedTeams } from '../projection/assignments.ts';
import type { AssignmentDeadlineState } from '../projection/assignment-deadline.ts';
import type { AuctionContracts } from '../projection/contracts.ts';
import { outstandingAssignmentTeams, reminderInstantFor } from './assignment-deadline.ts';

/** One Team's name and every Manager acting for it, as the caller read them. */
export type MonitoredTeamIdentity = {
	readonly teamId: string;
	readonly teamName: string;
	readonly managerNames: readonly string[];
};

/** Everything the monitor is built from. */
export type AssignmentMonitorInput = {
	readonly teams: readonly MonitoredTeamIdentity[];
	readonly contracts: AuctionContracts;
	readonly submitted: SubmittedTeams;
	readonly deadline: AssignmentDeadlineState;
};

/** One Team, as the monitoring page lists it. */
export type AssignmentMonitorRow = {
	readonly teamId: string;
	/** `Lakers — Meakel & Dana`, through the one formatter (AD naming). */
	readonly teamLabel: string;
	readonly teamName: string;
	readonly submitted: boolean;
	/** How many won Players still carry no contract length. */
	readonly unsetCount: number;
	/** `Submitted` or `Not submitted` — the column, in the core's words. */
	readonly statusLabel: string;
	/** The same fact as a sentence, for the stacked list at 375px. */
	readonly detail: string;
};

/** Everything `/assignment-monitoring` renders, worded by the core. */
export type AssignmentMonitor = {
	readonly rows: readonly AssignmentMonitorRow[];
	readonly teamCount: number;
	readonly submittedCount: number;
	/** Teams with at least one won Player carrying no length. */
	readonly outstandingCount: number;
	/** How many Players across the league still carry no length. */
	readonly outstandingPlayerCount: number;
	readonly completionSentence: string;
	/** The standing deadline, or `null` while it is unset. */
	readonly deadline: string | null;
	readonly deadlineSentence: string;
	readonly reminderIntervalHours: number | null;
	readonly reminderSentence: string;
	/** Whether the one notice has already gone out for the standing deadline. */
	readonly noticeSent: boolean;
	readonly noticeSentence: string;
};

/** `1 Player` / `3 Players`. The noun alone, `broadcast.ts`'s `plural`. */
function plural(quantity: number, noun: string): string {
	return quantity === 1 ? noun : `${noun}s`;
}

/**
 * The whole view, derived from the folds and the identities and nothing else.
 *
 * Rows are sorted by Team name and tie-broken TOTALLY on the Team id, for
 * `contractsWonBy`'s reason: two Teams may legitimately share a name in a
 * league nobody has stopped from doing so, and a comparator returning 0 would
 * leave `Array.prototype.sort` free to reorder them between two renders of the
 * same state.
 */
export function assignmentMonitorFor(input: AssignmentMonitorInput): AssignmentMonitor {
	// ONE derivation, for the rows and the league line alike. This is the same
	// function the tick addresses its reminders with, so a row's count, the
	// completion sentence and who is actually mentioned cannot come to disagree
	// — counting a row separately is exactly how two answers start to differ.
	const outstanding = outstandingAssignmentTeams(input.contracts);
	const unsetByTeam = new Map(outstanding.map((team) => [team.teamId, team.unsetCount]));

	const rows: AssignmentMonitorRow[] = input.teams
		.map((team) => {
			const submitted = hasSubmittedAssignments(input.submitted, team.teamId);
			// Absent from the outstanding list means nothing is owed: a Team that
			// won nothing and a Team that has assigned everything are both zero,
			// which is what `refuseSubmission` lets go final.
			const unsetCount = unsetByTeam.get(team.teamId) ?? 0;
			return {
				teamId: team.teamId,
				teamLabel: formatTeamManagers(team.teamName, team.managerNames),
				teamName: team.teamName,
				submitted,
				unsetCount,
				statusLabel: submitted ? 'Submitted' : 'Not submitted',
				detail: submitted
					? 'Submitted as final. No length on this Team changes again.'
					: unsetCount === 0
						? 'Not submitted. Every Player it won carries a length, so it may submit.'
						: `Not submitted. ${String(unsetCount)} won ${plural(unsetCount, 'Player')} ` +
							`${unsetCount === 1 ? 'carries' : 'carry'} no contract length.`
			};
		})
		.sort((left, right) => {
			if (left.teamName !== right.teamName) return left.teamName < right.teamName ? -1 : 1;
			if (left.teamId === right.teamId) return 0;
			return left.teamId < right.teamId ? -1 : 1;
		});

	const submittedCount = rows.filter((row) => row.submitted).length;
	const outstandingPlayerCount = outstanding.reduce((sum, team) => sum + team.unsetCount, 0);

	const teamCount = rows.length;
	const completionSentence =
		`${String(submittedCount)} of ${String(teamCount)} ${plural(teamCount, 'Team')} ` +
		`${submittedCount === 1 ? 'has' : 'have'} submitted contract assignments as final. ` +
		`${String(outstandingPlayerCount)} won ${plural(outstandingPlayerCount, 'Player')} across ` +
		`the league still ${outstandingPlayerCount === 1 ? 'carries' : 'carry'} no contract length.`;

	const deadline = input.deadline.deadline;
	const intervalHours = input.deadline.reminderIntervalHours;
	const reminderAt = reminderInstantFor(deadline, intervalHours);

	const deadlineSentence =
		deadline === null
			? 'The assignment deadline is not set. Until it is, no reminder and no deadline ' +
				'notice is sent, and nothing about the phase depends on it.'
			: `The assignment deadline is ${deadline}. A deadline may only move later: setting ` +
				'an earlier or equal instant is refused, and setting a later one is the extension.';

	const reminderSent = deadline !== null && input.deadline.remindedFor === deadline;
	const reminderSentence =
		intervalHours === null
			? 'No reminder interval is set, so no reminder is sent. The deadline notice does ' +
				'not depend on it.'
			: deadline === null
				? `The reminder interval is ${String(intervalHours)} ${plural(intervalHours, 'hour')}. ` +
					'No reminder is sent until a deadline is set.'
				: reminderSent
					? `The one reminder for this deadline was sent. It was due at ${reminderAt ?? deadline}, ` +
						`${String(intervalHours)} ${plural(intervalHours, 'hour')} before the deadline.`
					: `One reminder is sent at ${reminderAt ?? deadline}, ` +
						`${String(intervalHours)} ${plural(intervalHours, 'hour')} before the deadline. ` +
						'Extending the deadline moves it and it is sent once for each deadline.';

	const noticeSent = deadline !== null && input.deadline.passedFor === deadline;
	const noticeSentence =
		deadline === null
			? 'No deadline notice is sent while the deadline is unset.'
			: noticeSent
				? 'The deadline notice was sent for this deadline. No contract length was written ' +
					'by it, no phase changed, and unassigned Players stay unassigned.'
				: 'The deadline notice has not been sent for this deadline. When it is, it writes ' +
					'no contract length and changes no phase.';

	return {
		rows,
		teamCount,
		submittedCount,
		outstandingCount: outstanding.length,
		outstandingPlayerCount,
		completionSentence,
		deadline,
		deadlineSentence,
		reminderIntervalHours: intervalHours,
		reminderSentence,
		noticeSent,
		noticeSentence
	};
}
