<script lang="ts">
	// The Commissioner-only assignment monitoring surface (Story 6.2, FR-29).
	//
	// Two things are on this page and they are different in kind. The ROSTER —
	// which Teams have submitted and how many Players each still owes — is a
	// readout, and it is the whole reason the page exists: until now the only
	// way to tell a stalled league from a finished one was to ask in Discord by
	// hand. The two CONTROLS — the deadline and the reminder interval — are
	// administrative acts, so they sit in Commissioner blocks: dashed, never
	// filled, labelled as visible only to the Commissioner.
	//
	// BOTH acts are two-part, for `/nominate`'s and `/contract-assignment`'s
	// reason. Typing an instant is not setting it: the field carries the value,
	// a separate confirmation states what it arms, and the submit acts. The
	// server refuses an unconfirmed post independently of anything here —
	// disabling a control is never the check.
	//
	// **Nothing on this page assigns a contract length**, and nothing on it
	// changes a phase. The deadline passing appends a marker and sends
	// messages; unassigned Players stay unassigned.
	//
	// No sentence here is written here. The monitor arrives already worded by
	// the pure core through the server, so each figure and each refusal has
	// exactly one definition in the codebase and this file cannot drift from
	// them.
	//
	// Types are declared structurally rather than imported from a server-only
	// module: nothing in the server-only library may ever be reachable from a
	// `.svelte` file.
	// The one spelling a deadline is submitted in, imported from the pure core
	// rather than restated here: the refusal sentence prints the same constant,
	// and a local copy would be the second place it is written down. `$lib/core`
	// is the pure core, which AD-2 says both runtimes load, so nothing
	// server-only is reachable from this file.
	import { DEADLINE_EXAMPLE } from '$lib/core/rules/assignment-deadline.ts';

	import type { ActionData, PageData } from './$types';

	type MonitorRow = {
		readonly teamId: string;
		readonly teamLabel: string;
		readonly teamName: string;
		readonly submitted: boolean;
		readonly unsetCount: number;
		readonly statusLabel: string;
		readonly detail: string;
	};

	type Monitor = {
		readonly rows: readonly MonitorRow[];
		readonly teamCount: number;
		readonly submittedCount: number;
		readonly outstandingCount: number;
		readonly outstandingPlayerCount: number;
		readonly completionSentence: string;
		readonly deadline: string | null;
		readonly deadlineSentence: string;
		readonly reminderIntervalHours: number | null;
		readonly reminderSentence: string;
		readonly noticeSent: boolean;
		readonly noticeSentence: string;
	};

	type MonitorForm = {
		readonly deadlineNotice?: string;
		readonly intervalNotice?: string;
		readonly appended?: {
			readonly seq: string;
			readonly occurredAt: string;
			readonly deviceClass: string | null;
		} | null;
	};

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const monitor = $derived(data.monitor as Monitor);
	const monitorForm = $derived(form as MonitorForm | undefined);
	const deadlineNotice = $derived(monitorForm?.deadlineNotice);
	const intervalNotice = $derived(monitorForm?.intervalNotice);
	const appended = $derived(monitorForm?.appended ?? null);

	/** The instant typed into the deadline field. Typing is not setting. */
	let deadlineValue = $state('');
	/** The separate confirmation for the deadline act. */
	let deadlineConfirmed = $state(false);

	/** The hours typed into the interval field, and its own confirmation. */
	let intervalValue = $state('');
	let intervalConfirmed = $state(false);

	const deadlineBlocked = $derived(deadlineValue.trim() === '' || !deadlineConfirmed);
	const intervalBlocked = $derived(intervalValue.trim() === '' || !intervalConfirmed);
</script>

<svelte:head>
	<title>Assignment monitoring — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1>Assignment monitoring</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	<section class="panel">
		<p class="section-label">Completion</p>
		<p class="prose" id="completion">{monitor.completionSentence}</p>
		<p class="prose">{monitor.deadlineSentence}</p>
		<p class="prose">{monitor.reminderSentence}</p>
		<p class="prose">{monitor.noticeSentence}</p>
	</section>

	<!-- The roster of Teams. A stacked list at 375px — every field carries its
	     own word, so nothing depends on a column header being visible —
	     becoming a real <table> with scope="col" headers at 640px. Both render
	     the same data from the same source; only one is in the accessibility
	     tree at a time, so a screen reader never hears a Team twice. -->
	<section class="panel">
		<p class="section-label">Teams</p>

		{#if monitor.rows.length === 0}
			<p class="prose">
				No Team is registered, so there is nothing to monitor. The roster of Teams is the
				league's own, not a list this page keeps.
			</p>
		{:else}
			<ul class="monitor-list">
				{#each monitor.rows as row (row.teamId)}
					<li class="monitor-row">
						<span class="row-team">{row.teamLabel}</span>
						<!-- The state is carried by its WORDS, never by colour alone,
						     so a greyscale screenshot stays fully readable. -->
						<span class="section-label">{row.statusLabel}</span>
						<span class="prose">{row.detail}</span>
					</li>
				{/each}
			</ul>

			<table class="monitor-table">
				<caption class="section-label">Contract assignment by Team</caption>
				<thead>
					<tr>
						<th scope="col">Team</th>
						<th scope="col">Status</th>
						<th scope="col">Players with no length</th>
					</tr>
				</thead>
				<tbody>
					{#each monitor.rows as row (row.teamId)}
						<tr>
							<th scope="row">{row.teamLabel}</th>
							<td>{row.statusLabel}</td>
							<td class="money">{row.unsetCount}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>

	<section class="commissioner-block">
		<p class="commissioner-label">Assignment deadline</p>
		<p class="prose">{monitor.deadlineSentence}</p>

		<!-- A disabled control ALWAYS states its reason, and the reason is
		     always in the DOM carrying this id, so the `aria-describedby` below
		     is static and can never dangle. The server re-derives every gate
		     inside the transaction regardless. -->
		<p class="prose" id="deadline-availability">
			The act needs both parts: give an instant, then tick the confirmation. The log carries
			UTC and nothing else, so the instant is written as an ISO-8601 UTC instant — {DEADLINE_EXAMPLE}.
			It is checked against the database clock and against the standing deadline when you
			submit; a local clock is never consulted.
		</p>

		<form method="POST" action="?/deadline">
			<!-- A plain text field rather than `datetime-local`, deliberately.
			     That widget submits a LOCAL wall-clock time with no offset, and
			     the log is UTC — reading one as the other would put a deadline
			     hours from where the Commissioner meant it, silently. The field
			     asks for the spelling the core actually accepts and the refusal
			     names the same one. -->
			<label class="field" for="deadline-input">
				<span class="section-label">Deadline (ISO-8601 UTC)</span>
				<input
					id="deadline-input"
					name="deadline"
					type="text"
					inputmode="text"
					autocomplete="off"
					placeholder={DEADLINE_EXAMPLE}
					bind:value={deadlineValue}
				/>
			</label>

			<label class="confirm" for="deadline-confirm">
				<input
					id="deadline-confirm"
					name="confirm"
					type="checkbox"
					value="yes"
					bind:checked={deadlineConfirmed}
				/>
				<span class="prose">
					I confirm this deadline. It is appended as an event, it may only move later
					afterwards, and the one reminder and the one deadline notice are both keyed to
					it — so setting a later instant re-arms both for the new one.
				</span>
			</label>

			<button
				class="control-commissioner"
				type="submit"
				disabled={deadlineBlocked}
				aria-describedby="deadline-availability"
			>
				Set the assignment deadline
			</button>
		</form>

		<div role="status">
			{#if deadlineNotice}
				<p class="prose" id="deadline-notice">{deadlineNotice}</p>
			{/if}
		</div>
	</section>

	<section class="commissioner-block">
		<p class="commissioner-label">Reminder interval</p>
		<p class="prose">{monitor.reminderSentence}</p>

		<p class="prose" id="interval-availability">
			The act needs both parts: give a whole number of hours from 1 to 168, then tick the
			confirmation. With no interval set, no reminder is sent; the deadline notice does not
			depend on it.
		</p>

		<form method="POST" action="?/interval">
			<label class="field" for="interval-input">
				<span class="section-label">Hours before the deadline</span>
				<input
					id="interval-input"
					name="intervalHours"
					type="number"
					min="1"
					max="168"
					step="1"
					bind:value={intervalValue}
				/>
			</label>

			<label class="confirm" for="interval-confirm">
				<input
					id="interval-confirm"
					name="confirm"
					type="checkbox"
					value="yes"
					bind:checked={intervalConfirmed}
				/>
				<span class="prose">
					I confirm this interval. One reminder is sent for each deadline, to the Teams
					that still have Players with no contract length at that moment.
				</span>
			</label>

			<button
				class="control-commissioner"
				type="submit"
				disabled={intervalBlocked}
				aria-describedby="interval-availability"
			>
				Set the reminder interval
			</button>
		</form>

		<div role="status">
			{#if intervalNotice}
				<p class="prose" id="interval-notice">{intervalNotice}</p>
			{/if}
		</div>
	</section>

	<!-- After a form post the focus is still on the control that was pressed,
	     so the outcome is announced politely rather than left to be found. -->
	<section class="panel">
		<div role="status">
			{#if appended}
				<!-- Both actions return this same shape, so this sentence must be
				     true of EITHER act. Which one it was is already stated by the
				     action's own notice above; naming the deadline here read as a
				     deadline having been set every time an interval was. -->
				<p class="prose">
					One event was appended, at sequence {appended.seq}, naming you and your Team.
					Both settings are that fold; neither was stored in a column.
				</p>
			{/if}
		</div>
	</section>
</main>

<style>
	.masthead {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
	}

	.masthead h1 {
		font-size: var(--size-26);
		color: var(--color-text);
	}

	.monitor-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		width: 100%;
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.monitor-row {
		display: flex;
		flex-direction: column;
		gap: calc(var(--space-row-gap) / 2);
	}

	.row-team {
		color: var(--color-text);
		font-size: var(--size-15);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: calc(var(--space-row-gap) / 2);
		margin-bottom: var(--space-row-gap);
	}

	.confirm {
		display: flex;
		align-items: flex-start;
		gap: var(--space-row-gap);
		margin-bottom: var(--space-row-gap);
	}

	/*
	 * 375px is the design width and the smallest supported; 640px is where the
	 * table takes over, the same breakpoint `/import`'s preview uses. Below it
	 * the roster is the stacked list above and the table is not rendered at
	 * all. `display: none` on the inactive one removes it from the
	 * accessibility tree too, so each Team is announced once, not twice.
	 *
	 * Nothing scrolls laterally, and no scroll container is needed to make that
	 * true: below the breakpoint the table does not exist, and above it there
	 * is width for three columns. If a column is ever added, this is the
	 * comment that stops being true first.
	 */
	.monitor-table {
		display: none;
	}

	@media (min-width: 640px) {
		.monitor-list {
			display: none;
		}

		.monitor-table {
			display: table;
			width: 100%;
			border-collapse: collapse;
		}

		.monitor-table caption {
			text-align: left;
			padding-bottom: var(--space-row-gap);
		}

		.monitor-table th,
		.monitor-table td {
			text-align: left;
			padding: var(--space-row-gap) var(--space-row-gap) var(--space-row-gap) 0;
			border-top: var(--border-width) solid var(--color-border);
			font-size: var(--size-12-5);
			color: var(--color-text-prose);
		}

		.monitor-table thead th {
			color: var(--color-text-tertiary);
			font-size: var(--size-10);
			text-transform: uppercase;
			letter-spacing: 0.16em;
		}

		.monitor-table tbody th {
			color: var(--color-text);
			font-size: var(--size-13);
			font-weight: 400;
		}
	}
</style>
