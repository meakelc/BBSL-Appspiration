<script lang="ts">
	// The Commissioner-only auction-open gate (Story 1.11).
	//
	// The whole page is a report and one control. Everything outstanding is
	// NAMED — each Team, each source — never counted: a Commissioner at 11:55
	// with thirty managers waiting cannot act on "3 outstanding".
	//
	// No sentence here is written here. The report arrives already worded by
	// the pure core through the server (`preOpenReport`), so each refusal and
	// the consequence have exactly one definition in the codebase and this
	// file cannot drift from them.
	//
	// Types are declared structurally rather than imported from a server-only
	// module: nothing in the server-only library may ever be reachable from a
	// `.svelte` file.
	import type { ActionData, PageData } from './$types';

	type Report = {
		readonly ready: boolean;
		readonly refusalDetail: string | null;
		readonly outstandingSources: readonly string[];
		readonly unboundTeams: readonly string[];
		readonly eligibilitySentence: string;
		readonly consequence: string;
	};

	type OpenForm = {
		readonly notice?: string;
		readonly appended?: { readonly seq: string; readonly occurredAt: string } | null;
	};

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const report = $derived(data.report as Report);
	const openForm = $derived(form as OpenForm | undefined);
	const notice = $derived(openForm?.notice);
	const appended = $derived(openForm?.appended ?? null);

	/** The confirmation. Ticking it is not opening: the server decides. */
	let confirmed = $state(false);

	/**
	 * The one flag both the affordance and the stated reason read from. The
	 * server re-derives every gate under the lock regardless — disabling a
	 * control is never the check.
	 */
	const blocked = $derived(!report.ready || !confirmed);
</script>

<svelte:head>
	<title>Auction-open gate — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1>Auction-open gate</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	<section class="panel">
		<p class="section-label">What is outstanding</p>
		{#if report.ready}
			<p class="prose">
				Nothing is outstanding. Every import source has been promoted and every Team has a
				Manager bound.
			</p>
		{:else}
			<!-- The gate's own sentence, worded once in the pure core. The lists
			     below name the individual items that sentence summarises. -->
			<p class="prose" id="auction-open-refusal">{report.refusalDetail}</p>
		{/if}

		{#if report.outstandingSources.length > 0}
			<!--
				One markup for both widths, not two. Below 640px every cell is a
				block and states its own word, so no column header has to be
				visible; at 640px the same rows become a real table with `scope`
				headers — the breakpoint `/import` established.
			-->
			<table class="named-table">
				<caption class="section-label">Sources the last promotion did not commit</caption>
				<thead>
					<tr>
						<th scope="col">Source</th>
						<th scope="col">What is outstanding</th>
					</tr>
				</thead>
				<tbody>
					{#each report.outstandingSources as sourceName, i (i)}
						<tr>
							<th scope="row" class="cell-name">{sourceName}</th>
							<td class="cell-detail">Not promoted.</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}

		{#if report.unboundTeams.length > 0}
			<table class="named-table">
				<caption class="section-label">Teams with no Manager bound</caption>
				<thead>
					<tr>
						<th scope="col">Team</th>
						<th scope="col">What is outstanding</th>
					</tr>
				</thead>
				<tbody>
					{#each report.unboundTeams as teamName, i (i)}
						<tr>
							<th scope="row" class="cell-name">{teamName}</th>
							<td class="cell-detail">No Manager is bound to this Team.</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>

	<section class="panel">
		<p class="section-label">Minor League Eligibility</p>
		<!-- Stated for confirmation, and stated as a sentence rather than as a
		     bare number. Whatever it says, it does not block the open. -->
		<p class="prose">{report.eligibilitySentence}</p>
	</section>

	<section class="commissioner-block">
		<p class="commissioner-label">Open the auction</p>
		<p class="prose">{report.consequence}</p>

		<!-- A disabled control ALWAYS states its reason, and the reason is
		     always in the DOM carrying this id, so the `aria-describedby`
		     below is static and can never dangle. The server refuses
		     regardless — disabling a control is never the check. -->
		<p class="prose" id="auction-open-availability">
			{#if !report.ready}
				The auction cannot be opened while anything above is outstanding. Every item is
				named above; resolve each one and this page will say so.
			{:else if !confirmed}
				The confirmation has not been given. Tick it to enable the control: opening the
				auction cannot be undone.
			{:else}
				Everything is ready and the confirmation has been given. The gate is re-derived
				from the event log when you submit.
			{/if}
		</p>

		<form method="POST" action="?/open">
			<label class="confirm" for="auction-open-confirm">
				<input
					id="auction-open-confirm"
					name="confirm"
					type="checkbox"
					value="yes"
					bind:checked={confirmed}
				/>
				<span class="prose">
					I confirm the auction should open now. This cannot be undone.
				</span>
			</label>

			<button
				class="control-commissioner"
				type="submit"
				disabled={blocked}
				aria-describedby="auction-open-availability"
			>
				Open the auction
			</button>
		</form>

		<!-- The outcome of a submit is the only place a Commissioner learns
		     whether the open landed, and after a form post the focus is still
		     on the control that was pressed. `role="status"` announces it
		     politely rather than leaving a screen reader user to go looking. -->
		<div role="status">
			{#if notice}
				<p class="prose" id="auction-open-notice">{notice}</p>
			{/if}
			{#if appended}
				<p class="prose">
					One AuctionOpened event was appended, at sequence {appended.seq}, naming the
					actor and the time it occurred. The phase and the League Clock are folds of
					that event; no flag was set anywhere.
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

	form {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-row-gap);
		width: 100%;
	}

	.confirm {
		display: flex;
		align-items: flex-start;
		gap: var(--space-row-gap);
		min-height: var(--touch-min);
	}

	.confirm input[type='checkbox'] {
		width: 22px;
		height: 22px;
		margin-top: 2px;
		/* The admin token, not the interactive one: this control sits in a
		   Commissioner block and must not borrow the Manager control's colour.
		   It deliberately does NOT carry `control-commissioner` — that class
		   generates the persistent "visible only to you" ::before label, which
		   belongs on the block and the submit. */
		accent-color: var(--color-admin);
	}

	/*
	 * 375px is the design width and the smallest supported; 640px is where
	 * the table takes over, the same breakpoint `/import` established.
	 *
	 * Below the breakpoint every part of the table is laid out as a block, so
	 * one row is a stacked card and nothing scrolls laterally. The column
	 * headers are removed from the layout AND from the accessibility tree
	 * there (`display: none`), which is correct only because every cell below
	 * states its own words.
	 */
	.named-table {
		display: block;
		width: 100%;
	}

	.named-table caption {
		display: block;
		text-align: left;
		padding-bottom: var(--space-row-gap);
	}

	.named-table thead {
		display: none;
	}

	.named-table tbody {
		display: block;
	}

	.named-table tr {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: var(--space-row-gap) 0;
		border-top: var(--border-width) solid var(--color-border);
	}

	.named-table td,
	.named-table th {
		display: block;
		text-align: left;
		font-size: var(--size-12-5);
		color: var(--color-text-prose);
	}

	.named-table .cell-name {
		color: var(--color-text);
		font-size: var(--size-15);
		font-weight: 400;
	}

	@media (min-width: 640px) {
		.named-table {
			display: table;
			border-collapse: collapse;
		}

		.named-table caption {
			display: table-caption;
		}

		.named-table thead {
			display: table-header-group;
		}

		.named-table tbody {
			display: table-row-group;
		}

		.named-table tr {
			display: table-row;
		}

		.named-table td,
		.named-table th {
			display: table-cell;
			padding: var(--space-row-gap) var(--space-row-gap) var(--space-row-gap) 0;
			border-top: var(--border-width) solid var(--color-border);
			vertical-align: top;
		}

		.named-table thead th {
			color: var(--color-text-tertiary);
			font-size: var(--size-10);
			text-transform: uppercase;
			letter-spacing: 0.16em;
		}
	}
</style>
