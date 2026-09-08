<script lang="ts">
	// The Manager-facing nomination gate (Story 2.1).
	//
	// Every control here is a MANAGER control in a Manager block. Nothing on
	// this page is an administrative act: nominating is the ordinary thing a
	// Manager came here to do, so the Commissioner classes — dashed, never
	// filled, labelled "visible only to you" — would be a lie about who this
	// belongs to.
	//
	// Nomination is a TWO-PART act: choosing a Player is not nominating them.
	// The radio selects; the confirm states what the selection will cost; the
	// submit acts. Selecting never submits, because the Slot is spent for the
	// whole of that Player's Auction and a mis-tap must not spend it.
	//
	// No sentence here is written here. The pool arrives already worded by
	// the pure core through the server, so each refusal and the consequence
	// have exactly one definition in the codebase and this file cannot drift
	// from them.
	//
	// No suggested Player, no ranking, no "similar players": the list is the
	// pool in the order the Fantrax export supplied it and nothing else. A
	// ranked list is advice the product does not have the standing to give,
	// and it would make the nomination the app's decision rather than the
	// Manager's — repeating the file's own order is not that, and it is the
	// order every Manager has already been reading in Fantrax. The server
	// decides it (`server/nomination.ts`); nothing here re-sorts.
	//
	// Types are declared structurally rather than imported from a server-only
	// module: nothing in the server-only library may ever be reachable from a
	// `.svelte` file.
	//
	// Since Story 4.1 the Nomination control joins the freshness contract: in
	// Stale it is disabled with its reason stated, from the same one derivation
	// every other surface reads. `$lib/core` is the pure core and is what AD-2
	// says both runtimes load, so importing the sentence from it is the same
	// move the Auction page already makes; nothing server-only is reachable
	// from here.
	import { STALE_NOMINATION_REASON } from '$lib/core/freshness.ts';
	import { freshness } from '$lib/client/freshness.svelte.ts';

	import type { ActionData, PageData } from './$types';

	type PoolPlayer = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly positions: string;
		readonly nbaTeam: string;
		readonly available: boolean;
		readonly unavailableDetail: string | null;
	};

	type Pool = {
		readonly players: readonly PoolPlayer[];
		readonly slotAvailable: boolean;
		readonly slotDetail: string | null;
		readonly consequence: string;
	};

	type NominateForm = {
		readonly notice?: string;
		readonly appended?: {
			readonly seq: string;
			readonly occurredAt: string;
			readonly deviceClass: string | null;
		} | null;
	};

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const pool = $derived(data.pool as Pool);
	const nominateForm = $derived(form as NominateForm | undefined);
	const notice = $derived(nominateForm?.notice);
	const appended = $derived(nominateForm?.appended ?? null);

	/** The chosen Player. Choosing is not nominating: the server decides. */
	let selected = $state('');

	/** The confirmation. Ticking it is not nominating either. */
	let confirmed = $state(false);

	const chosen = $derived(pool.players.find((player) => player.fantraxPlayerId === selected) ?? null);

	/**
	 * The freshness state, from the ONE contract the layout mounts (AD-29).
	 * Read, never derived — `core/freshness.ts` decides it.
	 */
	const staleBlocked = $derived(freshness.state === 'stale');

	/**
	 * The one flag both the affordance and the stated reason read from. The
	 * server re-derives every gate under the lock regardless — disabling a
	 * control is never the check.
	 *
	 * Stale JOINS this existing path rather than adding a second one: AD-29's
	 * obligation is a disabled control with its reason stated, and that
	 * mechanism is already right here.
	 */
	const blocked = $derived(
		!pool.slotAvailable || chosen === null || !confirmed || staleBlocked
	);
</script>

<svelte:head>
	<title>Nominate — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1>Nominate a Free Agent</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	<section class="panel">
		<p class="section-label">Phase</p>
		<p class="prose">{data.phase.sentence}</p>
	</section>

	<section class="manager-block">
		<p class="section-label">Your Nomination Slot</p>
		<!-- Whether this Team may nominate at all, stated once and in words,
		     rather than greying out every row as though every Player were
		     unavailable. The sentence is the core's. -->
		<p class="prose" id="nominate-slot">
			{#if pool.slotAvailable}
				Your Team&rsquo;s Nomination Slot is free. Choose one Player below, confirm, and
				nominate.
			{:else}
				{pool.slotDetail}
			{/if}
		</p>
	</section>

	<section class="manager-block">
		<p class="section-label">Nominate a Player</p>
		<p class="prose">{pool.consequence}</p>

		{#if pool.players.length === 0}
			<p class="prose">
				The Free Agent pool is empty. There is nobody to nominate until an import has been
				promoted.
			</p>
		{:else}
			<form method="POST" action="?/nominate">
				<!--
					One markup for both widths, not two. A second, hidden copy of
					this list would post a second `fantraxPlayerId` for every
					Player, which is a submission bug rather than a layout choice.
					Below 640px every cell is a block and states its own word, so
					no column header has to be visible; at 640px the same rows
					become a real table with `scope` headers — the breakpoint
					`/import` established.

					Single-select by `type="radio"`, not a checkbox: a Team has one
					Nomination Slot, so the markup itself makes two selections
					impossible rather than leaving the server to refuse a second.
				-->
				<table class="pool-table">
					<caption class="section-label">The Free Agent pool</caption>
					<thead>
						<tr>
							<th scope="col">Chosen</th>
							<th scope="col">Player</th>
							<th scope="col">Positions</th>
							<th scope="col">NBA team</th>
							<th scope="col">Availability</th>
						</tr>
					</thead>
					<tbody>
						{#each pool.players as player (player.fantraxPlayerId)}
							<tr>
								<td class="cell-select">
									<label class="row-select" for={`player-${player.fantraxPlayerId}`}>
										<input
											id={`player-${player.fantraxPlayerId}`}
											name="fantraxPlayerId"
											type="radio"
											value={player.fantraxPlayerId}
											disabled={!player.available}
											aria-describedby={player.available
												? undefined
												: `unavailable-${player.fantraxPlayerId}`}
											bind:group={selected}
										/>
										<span class="visually-hidden">Choose {player.playerName}</span>
									</label>
								</td>
								<th scope="row" class="cell-player">{player.playerName}</th>
								<td class="cell-detail">Positions: {player.positions}</td>
								<td class="cell-detail">NBA team: {player.nbaTeam}</td>
								<td class="cell-state">
									{#if player.available}
										<span class="state-label">Available</span>
									{:else}
										<span class="state-label">Not available</span>
										<!-- The disabled radio's own reason, carrying the id its
										     `aria-describedby` points at. Worded by the core. -->
										<span class="prose" id={`unavailable-${player.fantraxPlayerId}`}>
											{player.unavailableDetail}
										</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>

				<!--
					The second half of the act travels WITH the Manager down the
					list, rather than waiting at the bottom of it.

					The pool is ~1,470 Players. Choosing a Player used to leave
					the confirmation and the control an entire pool's worth of
					scrolling away, with no sign at the point of choosing that
					either existed — so the two-part act read as a broken
					one-part act. Sticking this bar to the bottom of the viewport
					does not make it one part: the confirmation is still a
					separate deliberate tick, and choosing still never submits.
					It only stops the second part being hidden.

					`position: sticky` and not `fixed`: the bar belongs to the
					form, so it scrolls into its own place at the end of the list
					and does not sit over the page when there is nothing below it.

					The reason a disabled control is disabled now sits INSIDE the
					bar, beside the control it describes, instead of above a list
					the Manager has already scrolled past. It is the same one
					sentence set, still the core's words, still carrying the id
					`aria-describedby` names — and it lives in the same branch as
					the button, so the reference cannot dangle.
				-->
				<div class="action-bar">
					<p class="prose" id="nominate-availability">
						<!-- Stale is stated FIRST, above every other reason. When the app
						     cannot confirm the pool or the Slot, the facts the other
						     branches speak from are exactly what is in doubt. -->
						{#if staleBlocked}
							{STALE_NOMINATION_REASON}
						{:else if !pool.slotAvailable}
							You cannot nominate right now. The reason is stated at the top of this
							page; nothing in the list will change it.
						{:else if chosen === null}
							No Player is chosen. Choose exactly one Player from the list to enable
							the confirmation.
						{:else if !confirmed}
							The confirmation has not been given. Tick it to enable the control:
							nominating {chosen.playerName} holds your Slot until that Auction
							closes.
						{:else}
							{chosen.playerName} is chosen and the confirmation has been given. The
							gate is re-derived from the event log when you submit.
						{/if}
					</p>

					<!-- The second part of the two-part act, separate from the
					     selection above and stating what it costs. -->
					<label class="confirm" for="nominate-confirm">
						<input
							id="nominate-confirm"
							name="confirm"
							type="checkbox"
							value="yes"
							bind:checked={confirmed}
						/>
						<span class="prose">
							I confirm this nomination. {pool.consequence}
						</span>
					</label>

					<button
						class="control-manager"
						type="submit"
						disabled={blocked}
						aria-describedby="nominate-availability"
					>
						Nominate the chosen Player
					</button>
				</div>
			</form>
		{/if}

		<!-- The outcome of a submit is the only place a Manager learns whether
		     the nomination landed, and after a form post the focus is still on
		     the control that was pressed. `role="status"` announces it
		     politely rather than leaving a screen reader user to go looking. -->
		<div role="status">
			{#if notice}
				<p class="prose" id="nominate-notice">{notice}</p>
			{/if}
			{#if appended}
				<p class="prose">
					One NominationPlaced event was appended, at sequence {appended.seq}, naming you,
					your Team and the Player. Your Slot, the Bid Board and the League Clock are
					folds of that event; no flag was set anywhere.
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

	/*
	 * The second half of the act, stuck to the bottom of the viewport for as
	 * long as there is list left below it, and settling into place at the end.
	 *
	 * It is opaque and bordered on purpose: it sits over pool rows while
	 * scrolling, and a translucent bar would leave a Player's name showing
	 * through the sentence that states what nominating costs.
	 *
	 * `bottom: -1px` closes the sub-pixel gap some browsers leave under a
	 * sticky element at a fractional zoom, through which a row would show.
	 */
	.action-bar {
		position: sticky;
		bottom: -1px;
		z-index: 1;
		align-self: stretch;
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		align-items: flex-start;
		padding: var(--space-row-gap) 0;
		/* The Manager block's own ground, so the bar reads as part of it. */
		background-color: var(--color-surface);
		border-top: var(--border-width) solid var(--color-border-strong);
	}

	/*
	 * The persistent strip is FIXED to the bottom of the viewport below 640px
	 * (`PersistentStrip.svelte`), and a sticky element's offset is measured
	 * against that same viewport — so `bottom: 0` would park this bar
	 * underneath the strip and hide the control this whole change exists to
	 * make reachable. The bar clears it by exactly `--strip-height`, the token
	 * the strip is sized from and the room `global.css` reserves, so the two
	 * can only ever agree.
	 *
	 * Gated on `body:has(.strip)` for `global.css`'s reason: the strip does
	 * not mount for every Manager on every page, and clearing 52px of nothing
	 * would float the bar above the fold of its own accord.
	 */
	:global(body:has(.strip)) .action-bar {
		bottom: calc(var(--strip-height) - var(--border-width));
	}

	/* At 640px the strip is in the flow like anything else; nothing to clear. */
	@media (min-width: 640px) {
		:global(body:has(.strip)) .action-bar {
			bottom: -1px;
		}
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
	 * The whole row is the target, at the 46px control height, so the list is
	 * operable one-handed at 375px without aiming at a 22px dot.
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

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}

	.state-label {
		display: block;
		color: var(--color-text);
		font-size: var(--size-12-5);
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
	}
</style>
