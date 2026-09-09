<script lang="ts">
	// The Commissioner-only Minor League Eligibility surface (Story 1.10).
	//
	// Every row STATES ITS CONSEQUENCE IN WORDS rather than offering a bare
	// checkbox (EXPERIENCE.md's voice rule). The sentence is not written here:
	// it arrives already worded by the pure core through the server
	// (`eligibilityRowSentence`), so the consequence has exactly one
	// definition in the codebase and this file cannot drift from it.
	//
	// The state of a row is carried by its words — "Minor League Eligible" or
	// "Not Minor League Eligible", plus the sentence — never by colour alone,
	// so a greyscale screenshot stays fully readable.
	//
	// Types are declared structurally rather than imported from a server-only
	// module: nothing in the server-only library may ever be reachable from a
	// `.svelte` file.
	import type { ActionData, PageData } from './$types';

	type PoolRow = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly positions: string;
		readonly nbaTeam: string;
		readonly eligible: boolean;
		/** The consequence sentence, worded server-side. Printed, never re-worded. */
		readonly consequence: string;
	};

	type SetForm = {
		readonly notice?: string;
		readonly appended?: ReadonlyArray<{ readonly seq: string; readonly occurredAt: string }>;
	};

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const players = $derived((data.players as readonly PoolRow[]) ?? []);
	const setForm = $derived(form as SetForm | undefined);
	const notice = $derived(setForm?.notice);
	const appended = $derived(setForm?.appended ?? []);

	/** Which Players this submission names. Bound to every row checkbox. */
	let selected = $state<string[]>([]);

	const poolIsEmpty = $derived(players.length === 0);
	const nothingSelected = $derived(selected.length === 0);
	const allSelected = $derived(!poolIsEmpty && selected.length === players.length);

	/**
	 * Bulk selection. Selecting is not committing: the two submit controls
	 * below still state which direction is meant, and the server decides.
	 */
	function toggleAll(): void {
		selected = allSelected ? [] : players.map((player) => player.fantraxPlayerId);
	}
</script>

<svelte:head>
	<title>Minor League Eligibility — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1>Minor League Eligibility</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	{#if poolIsEmpty}
		<!-- The designed empty state: nothing has been promoted, so there is
		     nothing to flag and NO control is offered. What is outstanding is
		     named — Import — rather than counted. -->
		<section class="panel">
			<p class="section-label">No Players in the pool</p>
			<p class="prose">
				The Free Agent pool is empty, so there is no Player to set Minor League Eligibility
				for. Import is what is outstanding: promote the thirty-one sources on the Import
				screen, and every promoted Player will be listed here.
			</p>
		</section>
	{:else}
		<section class="commissioner-block">
			<p class="commissioner-label">Set Minor League Eligibility</p>
			<p class="prose">
				Minor League Eligibility is set here by hand: it is not in the Fantrax export, and
				the default is not eligible. Tick the Players to change, then state the direction.
				A Player already at the value you ask for is reported as unchanged and records no
				event. Once the auction opens, this is refused.
			</p>

			<!-- A disabled control ALWAYS states its reason, and the reason is
			     always in the DOM carrying this id, so the `aria-describedby`
			     below is static and can never dangle (1.9 change-log item 3).
			     Both submits take `disabled` from the same flag, so the
			     affordance always matches the sentence. The server refuses
			     regardless — disabling a control is never the check. -->
			<p class="prose" id="eligibility-availability">
				{#if nothingSelected}
					No Player is selected. Tick at least one Player to set or unset Minor League
					Eligibility.
				{:else}
					{selected.length === 1 ? 'One Player is' : `${selected.length} Players are`} selected.
					Both controls act on exactly that selection.
				{/if}
			</p>

			<form method="POST" action="?/set">
				<label class="select-all" for="select-all">
					<input
						id="select-all"
						type="checkbox"
						checked={allSelected}
						onchange={toggleAll}
					/>
					<span class="prose">
						Select every Player in the pool ({players.length} Players).
					</span>
				</label>

				<!--
					One markup for both widths, not two. A second, hidden copy of
					this list would post a second `ids` field for every Player,
					which is a submission bug rather than a layout choice. Below
					640px every cell is a block and each states its own word, so no
					column header has to be visible; at 640px the same rows become
					a real table with `scope` headers.
				-->
				<table class="pool-table">
					<caption class="section-label">The Free Agent pool</caption>
					<thead>
						<tr>
							<th scope="col">Selected</th>
							<th scope="col">Player</th>
							<th scope="col">Positions</th>
							<th scope="col">NBA team</th>
							<th scope="col">Minor League Eligibility</th>
						</tr>
					</thead>
					<tbody>
						{#each players as player (player.fantraxPlayerId)}
							<tr>
								<td class="cell-select">
									<label class="row-select" for={`player-${player.fantraxPlayerId}`}>
										<input
											id={`player-${player.fantraxPlayerId}`}
											name="ids"
											type="checkbox"
											value={player.fantraxPlayerId}
											bind:group={selected}
										/>
										<span class="visually-hidden">Select {player.playerName}</span>
									</label>
								</td>
								<th scope="row" class="cell-player">{player.playerName}</th>
								<td class="cell-detail">Positions: {player.positions}</td>
								<td class="cell-detail">NBA team: {player.nbaTeam}</td>
								<td class="cell-state">
									<span class="state-label">
										{player.eligible ? 'Minor League Eligible' : 'Not Minor League Eligible'}
									</span>
									<span class="prose">{player.consequence}</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>

				<!-- Two submits, one form: the button that was pressed carries the
				     direction as its own value, so no submission can reach the
				     server without stating which way it meant. -->
				<div class="submit-row">
					<button
						class="control-commissioner"
						type="submit"
						name="eligible"
						value="yes"
						disabled={nothingSelected}
						aria-describedby="eligibility-availability"
					>
						Set selected Players Minor League Eligible
					</button>
					<button
						class="control-commissioner control-unset"
						type="submit"
						name="eligible"
						value="no"
						disabled={nothingSelected}
						aria-describedby="eligibility-availability"
					>
						Unset selected Players
					</button>
				</div>
			</form>

			<!-- The outcome of a submit is the only place a Commissioner learns
			     whether a bulk change landed, and after a form post the focus is
			     still on the control that was pressed. `role="status"` announces
			     it politely rather than leaving a screen reader user to go
			     looking for it. -->
			<div role="status">
				{#if notice}
					<p class="prose" id="eligibility-notice">{notice}</p>
				{/if}
				{#if appended.length > 0}
					<p class="prose">
						{appended.length === 1
							? 'One MinorLeagueEligibilitySet event was appended'
							: `${appended.length} MinorLeagueEligibilitySet events were appended`}, one per
						Player whose value changed, each naming the actor and both values.
					</p>
				{/if}
			</div>
		</section>
	{/if}
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

	.select-all,
	.row-select {
		display: flex;
		align-items: flex-start;
		gap: var(--space-row-gap);
		min-height: var(--touch-min);
	}

	.select-all input[type='checkbox'],
	.row-select input[type='checkbox'] {
		width: 22px;
		height: 22px;
		margin-top: 2px;
		/* The admin token, not the interactive one: these controls sit in a
		   Commissioner block and must not borrow the Manager control's colour.
		   They deliberately do NOT carry `control-commissioner` — that class
		   generates the persistent "visible only to you" ::before label, which
		   belongs on the block and the submits, not stamped onto every row. */
		accent-color: var(--color-admin);
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	/*
	 * 375px is the design width and the smallest supported; 640px is where
	 * the table takes over, the same breakpoint `/import` established.
	 *
	 * Below the breakpoint every part of the table is laid out as a block, so
	 * one row is a stacked card and nothing scrolls laterally. The column
	 * headers are removed from the layout AND from the accessibility tree
	 * there (`display: none`), which is correct only because every cell below
	 * states its own word — "Positions: …", "NBA team: …", and the state as a
	 * sentence — rather than depending on a header to be meaningful. If a
	 * cell is ever added that does not, this is the comment that stops being
	 * true first.
	 */
	.pool-table {
		display: block;
		width: 100%;
	}

	.pool-table caption {
		display: block;
		text-align: left;
		padding-bottom: var(--space-row-gap);
	}

	.pool-table thead {
		display: none;
	}

	.pool-table tbody {
		display: block;
	}

	.pool-table tr {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: var(--space-row-gap) 0;
		border-top: var(--border-width) solid var(--color-border);
	}

	.pool-table td,
	.pool-table th {
		display: block;
		text-align: left;
		font-size: var(--size-12-5);
		color: var(--color-text-prose);
	}

	.pool-table .cell-player {
		color: var(--color-text);
		font-size: var(--size-15);
		font-weight: 400;
	}

	/* The state reads as a word first, then a sentence — never as a tick mark
	   alone, and never by colour. */
	.state-label {
		display: block;
		color: var(--color-text);
		font-family: var(--font-ui);
		font-size: var(--size-13);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.submit-row {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-row-gap);
		width: 100%;
	}

	/* The unset control differs from the set control without colour: its label
	   names the opposite act, and its border is doubled where the set
	   control's is the dashed Commissioner default. */
	.control-unset {
		border-style: double;
		border-width: var(--accent-bar-width);
	}

	@media (min-width: 640px) {
		.pool-table {
			display: table;
			border-collapse: collapse;
		}

		.pool-table caption {
			display: table-caption;
		}

		.pool-table thead {
			display: table-header-group;
		}

		.pool-table tbody {
			display: table-row-group;
		}

		.pool-table tr {
			display: table-row;
		}

		.pool-table td,
		.pool-table th {
			display: table-cell;
			padding: var(--space-row-gap) var(--space-row-gap) var(--space-row-gap) 0;
			border-top: var(--border-width) solid var(--color-border);
			vertical-align: top;
		}

		.pool-table thead th {
			color: var(--color-text-tertiary);
			font-size: var(--size-10);
			text-transform: uppercase;
			letter-spacing: 0.16em;
		}

		.submit-row {
			flex-direction: row;
			align-items: center;
		}
	}
</style>
