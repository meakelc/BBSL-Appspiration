<script lang="ts">
	// The Manager-facing Contract Assignment surface (Story 6.1, FR-21).
	//
	// Every control here is a MANAGER control in a Manager block. Nothing on
	// this page is an administrative act: spending the Year Allotment is the
	// whole reason this phase exists, so the Commissioner classes — dashed,
	// never filled, labelled "visible only to you" — would be a lie about who
	// this belongs to.
	//
	// BOTH acts are two-part, and for the same reason `/nominate`'s nomination
	// is. Choosing a length is not assigning it: the radios select, the confirm
	// states what the selection spends, and the submit acts. Submitting the Team
	// is the heavier of the two — it is one-way — and carries its own separate
	// confirmation rather than sharing one.
	//
	// No sentence here is written here. The board arrives already worded by the
	// pure core through the server, so each refusal, the remaining allotment and
	// the consequence have exactly one definition in the codebase and this file
	// cannot drift from them.
	//
	// **Exhausted lengths are not offered at all.** `row.offerable` is the core's
	// answer, counted with that Player's OWN current length excluded, so a Player
	// already on the 4-year is still offered the 4-year and a Player on nothing
	// is offered only what is left. The server re-derives the same gate under the
	// lock regardless — a missing radio is never the check.
	//
	// Types are declared structurally rather than imported from a server-only
	// module: nothing in the server-only library may ever be reachable from a
	// `.svelte` file.
	import type { ActionData, PageData } from './$types';

	type AssignmentRow = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly winningAmountLabel: string;
		readonly placement: string;
		readonly contractYears: number | null;
		readonly lengthLabel: string;
		readonly offerable: readonly number[];
	};

	type AssignmentBoard = {
		readonly rows: readonly AssignmentRow[];
		readonly remainingSentence: string;
		readonly unsetCount: number;
		readonly submitted: boolean;
		readonly submittedDetail: string | null;
		readonly canSubmit: boolean;
		readonly submitBlockedDetail: string | null;
		readonly submitConsequence: string;
	};

	type AssignmentForm = {
		readonly notice?: string;
		readonly appended?: {
			readonly seq: string;
			readonly occurredAt: string;
			readonly deviceClass: string | null;
		} | null;
	};

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const board = $derived(data.board as AssignmentBoard | null);
	const unboundDetail = $derived(data.unboundDetail as string | null);
	const assignmentForm = $derived(form as AssignmentForm | undefined);
	const notice = $derived(assignmentForm?.notice);
	const appended = $derived(assignmentForm?.appended ?? null);

	/** The chosen length per Player. Choosing is not assigning: the server decides. */
	let chosenLength = $state<Record<string, string>>({});

	/** The per-Player confirmation. Ticking it is not assigning either. */
	let rowConfirmed = $state<Record<string, boolean>>({});

	/** The separate confirmation for the one-way act of going final. */
	let submitConfirmed = $state(false);

	function lengthLabel(years: number): string {
		return years === 1 ? '1 year' : `${String(years)} years`;
	}

	function rowBlocked(row: AssignmentRow): boolean {
		const chosen = chosenLength[row.fantraxPlayerId] ?? '';
		return chosen === '' || rowConfirmed[row.fantraxPlayerId] !== true;
	}
</script>

<svelte:head>
	<title>Contract Assignment — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1>Assign contract lengths</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	<section class="panel">
		<p class="section-label">Phase</p>
		<p class="prose">{data.phase.sentence}</p>
	</section>

	{#if board === null}
		<section class="manager-block">
			<p class="section-label">Your Team</p>
			<p class="prose">{unboundDetail}</p>
		</section>
	{:else}
		<section class="manager-block">
			<p class="section-label">Your Year Allotment</p>
			<!-- The remaining allotment, stated in words rather than drawn as a
			     meter: it is four counts and one of them is unlimited, which no
			     bar can say. The sentence is the core's. -->
			<p class="prose" id="allotment-remaining">{board.remainingSentence}</p>
			<p class="prose">
				{#if board.submitted}
					{board.submittedDetail}
				{:else if board.unsetCount === 0}
					Every Player your Team won carries a length. You may still change any of them
					until you submit your Team as final.
				{:else}
					{board.unsetCount} of the Players your Team won {board.unsetCount === 1
						? 'has'
						: 'have'} no length yet.
				{/if}
			</p>
		</section>

		<section class="manager-block">
			<p class="section-label">The Players your Team won</p>

			<!-- A disabled control ALWAYS states its reason, and the reason is
			     always in the DOM carrying this id, so the `aria-describedby`
			     on every row's control is static and can never dangle. It is one
			     paragraph rather than one per row because the reason is the same
			     for every row — the act is two-part — and the row's own current
			     length is already stated on the row. The server refuses
			     regardless: disabling a control is never the check. -->
			<p class="prose" id="assign-availability">
				Each Player's control needs both parts of the act: choose a length, then tick
				that Player's confirmation. Exhausted lengths are not offered, and the gate is
				re-derived from the event log when you submit.
			</p>

			{#if board.rows.length === 0}
				<p class="prose">
					Your Team won no Auctions, so there is no length to assign. You may still submit
					your Team as final below.
				</p>
			{:else}
				<ul class="won-list">
					{#each board.rows as row (row.fantraxPlayerId)}
						<li class="won-row">
							<p class="row-player">{row.playerName}</p>
							<p class="row-detail">
								Won for {row.winningAmountLabel} · {row.placement === 'minor_league'
									? 'Minor League'
									: 'Active/Bench'}
							</p>
							<p class="row-detail" id={`length-${row.fantraxPlayerId}`}>
								Contract length: {row.lengthLabel}
							</p>

							{#if !board.submitted}
								<form method="POST" action="?/assign">
									<input type="hidden" name="fantraxPlayerId" value={row.fantraxPlayerId} />

									<fieldset class="lengths">
										<legend class="section-label">Choose a length</legend>
										<!-- Only the offerable lengths appear. An exhausted length is
										     not a disabled control here: there is nothing about this
										     Player to explain, and the reason lives once, above, in
										     the remaining-allotment sentence. -->
										{#each row.offerable as years (years)}
											<label
												class="row-select"
												for={`years-${row.fantraxPlayerId}-${String(years)}`}
											>
												<input
													id={`years-${row.fantraxPlayerId}-${String(years)}`}
													name="contractYears"
													type="radio"
													value={String(years)}
													bind:group={chosenLength[row.fantraxPlayerId]}
												/>
												<span class="prose">{lengthLabel(years)}</span>
											</label>
										{/each}
									</fieldset>

									<!-- The second part of the two-part act, separate from the
									     selection above and stating what it costs. -->
									<label class="confirm" for={`confirm-${row.fantraxPlayerId}`}>
										<input
											id={`confirm-${row.fantraxPlayerId}`}
											name="confirm"
											type="checkbox"
											value="yes"
											bind:checked={rowConfirmed[row.fantraxPlayerId]}
										/>
										<span class="prose">
											I confirm this length for {row.playerName}. It spends that deal from
											your Year Allotment, and is changeable until your Team is final.
										</span>
									</label>

									<button
										class="control-manager"
										type="submit"
										disabled={rowBlocked(row)}
										aria-describedby="assign-availability"
									>
										Assign this length
									</button>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if !board.submitted}
			<section class="manager-block">
				<p class="section-label">Submit your Team</p>
				<p class="prose">{board.submitConsequence}</p>

				<!-- A disabled control ALWAYS states its reason, and the reason is
				     always in the DOM carrying this id, so the `aria-describedby`
				     below is static and can never dangle. The server refuses
				     regardless — disabling a control is never the check. -->
				<p class="prose" id="submit-availability">
					{#if !board.canSubmit}
						{board.submitBlockedDetail}
					{:else if !submitConfirmed}
						The confirmation has not been given. Tick it to enable the control:
						submitting is one-way.
					{:else}
						Every won Player carries a length and the confirmation has been given. The
						gate is re-derived from the event log when you submit.
					{/if}
				</p>

				<form method="POST" action="?/submit">
					<label class="confirm" for="submit-confirm">
						<input
							id="submit-confirm"
							name="confirm"
							type="checkbox"
							value="yes"
							bind:checked={submitConfirmed}
						/>
						<span class="prose">
							I confirm my Team is final. {board.submitConsequence}
						</span>
					</label>

					<button
						class="control-manager"
						type="submit"
						disabled={!board.canSubmit || !submitConfirmed}
						aria-describedby="submit-availability"
					>
						Submit my Team as final
					</button>
				</form>
			</section>
		{/if}
	{/if}

	<!-- The outcome of a submit is the only place a Manager learns whether the
	     act landed, and after a form post the focus is still on the control
	     that was pressed. `role="status"` announces it politely rather than
	     leaving a screen reader user to go looking. -->
	<section class="panel">
		<div role="status">
			{#if notice}
				<p class="prose" id="assignment-notice">{notice}</p>
			{/if}
			{#if appended}
				<p class="prose">
					One event was appended, at sequence {appended.seq}, naming you and your Team.
					Your Year Allotment is a count over that fold; no length was stored in a column.
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

	/*
	 * Single column at 375px, the design width and the smallest supported.
	 * There is no table here and no breakpoint: one won Player is one card of
	 * stacked lines, which is what a form-per-row wants at every width.
	 */
	.won-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		width: 100%;
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.won-row {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: var(--space-row-gap) 0;
		border-top: var(--border-width) solid var(--color-border);
	}

	.row-player {
		color: var(--color-text);
		font-size: var(--size-15);
	}

	.row-detail {
		color: var(--color-text-prose);
		font-size: var(--size-12-5);
	}

	form {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-row-gap);
		width: 100%;
	}

	.lengths {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		width: 100%;
		border: 0;
		padding: 0;
		margin: 0;
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
		/* The interactive token: this is a Manager control in a Manager block. */
		accent-color: var(--color-border-interactive);
	}

	/*
	 * The whole row is the target, at the 46px control height, so the lengths
	 * are operable one-handed at 375px without aiming at a 22px dot.
	 */
	.row-select {
		display: flex;
		align-items: center;
		gap: var(--space-row-gap);
		min-height: var(--control-height);
	}

	.row-select input[type='radio'] {
		width: 22px;
		height: 22px;
		accent-color: var(--color-border-interactive);
	}
</style>
