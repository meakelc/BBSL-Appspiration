<script lang="ts">
	// The Commissioner-only Roster Trade surface (Story 7.7, FR-41, UX-DR39).
	//
	// **Three steps, each of them ordinary navigation.** Pick the two Teams,
	// pick the Players from each roster, then read the sheet and commit. The
	// first two steps are `GET` links and a `GET` form, so the selection lives
	// in the URL and the back button is the undo. Only the third step posts.
	// Nothing here needs client JavaScript to work: with it switched off the
	// two pickers still submit, the sheet still renders, and the reason is
	// still typed and still enforced server-side.
	//
	// **It words nothing.** The act sentence, every before → after row and
	// every consequence sentence arrive already worded by `reason-sheet-view`
	// and the pure core; the refusal sentence arrives from
	// `rosterTradeRefusalDetail` through the server. `vite.config.ts` pins
	// `environment: 'node'` and no `.svelte` file renders under the suite, so
	// words asserted in a component are words asserted by reading source text
	// — which is another reason none of them are here.
	//
	// **No control on this page cancels a Bid.** A refused Trade states what
	// must clear first and offers a way back to the picker, and that is all:
	// FR-40's cancellation trigger is a Close and only a Close.
	//
	// Types are declared structurally rather than imported from a server-only
	// module: nothing in the server-only library may ever be reachable from a
	// `.svelte` file.
	import ReasonSheet from '$lib/components/ReasonSheet.svelte';
	import type { ReasonSheetView } from '$lib/reason-sheet-view.ts';

	import type { ActionData, PageData } from './$types';

	type TeamRow = { readonly id: string; readonly name: string };

	type PickerPlayer = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly slotLabel: string;
		readonly capHit: string;
		readonly won: boolean;
	};

	type Picker = {
		readonly teamId: string;
		readonly teamName: string;
		readonly players: readonly PickerPlayer[];
	};

	type RecordForm = {
		readonly notice?: string;
		readonly appended?: { readonly seq: string; readonly occurredAt: string } | null;
	};

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const step = $derived(data.step as 'teams' | 'players' | 'sheet');
	const teams = $derived((data.teams as readonly TeamRow[]) ?? []);
	const sending = $derived(data.sending as Picker | null);
	const receiving = $derived(data.receiving as Picker | null);
	const sheet = $derived(data.sheet as ReasonSheetView | null);
	const refusal = $derived(data.refusal as { readonly detail: string } | null);
	const sendingPlayerIds = $derived((data.sendingPlayerIds as readonly string[]) ?? []);
	const receivingPlayerIds = $derived((data.receivingPlayerIds as readonly string[]) ?? []);
	const recordForm = $derived(form as RecordForm | undefined);
	const notice = $derived(recordForm?.notice);
	// Built server-side and posted to verbatim. The reviewed selection travels
	// in the action's own query string rather than as hidden fields, because
	// the sheet's `<form>` is `ReasonSheet.svelte`'s and nesting a second form
	// inside it is invalid HTML the browser silently drops — which would post a
	// Trade naming no Players at all.
	const commitAction = $derived((data.commitAction as string | null) ?? '?/record');
</script>

<svelte:head>
	<title>Record a Roster Trade — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1>Record a Roster Trade</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	{#if notice !== undefined}
		<!-- The outcome of the last submission, worded server-side. `role="status"`
		     so it is announced without stealing focus. -->
		<p class="prose notice" role="status">{notice}</p>
	{/if}

	{#if step === 'teams'}
		<section class="commissioner-block">
			<p class="commissioner-label">Choose the two Teams</p>
			<p class="prose">
				A Roster Trade is one act between two Teams, and Contracts may travel in both
				directions or in one. Choose the Team the trade is written from and the Team it is
				written to; either side may end up sending nothing. Nothing is recorded until you
				have read the sheet and given a reason.
			</p>

			{#if data.sameTeam}
				<p class="prose" role="status">
					A Roster Trade is between two different Teams. Choose a second Team.
				</p>
			{/if}

			<!--
				A GET form, not a POST: choosing two Teams decides nothing and
				writes nothing, so it belongs in the URL where the back button can
				undo it. There is no `<select>` anywhere in `src/routes` and there
				is not one here either — two radio lists say the same thing and
				stay operable at 375px.
			-->
			<form method="GET" action="/roster-trade">
				<fieldset class="team-choice">
					<legend class="section-label">Sending Team</legend>
					{#each teams as team (team.id)}
						<label class="choice">
							<input type="radio" name="from" value={team.id} checked={data.from === team.id} />
							<span class="prose">{team.name}</span>
						</label>
					{/each}
				</fieldset>

				<fieldset class="team-choice">
					<legend class="section-label">Receiving Team</legend>
					{#each teams as team (team.id)}
						<label class="choice">
							<input type="radio" name="to" value={team.id} checked={data.to === team.id} />
							<span class="prose">{team.name}</span>
						</label>
					{/each}
				</fieldset>

				<button class="control-commissioner" type="submit">Choose these two Teams</button>
			</form>
		</section>
	{:else if step === 'players' && sending !== null && receiving !== null}
		<section class="commissioner-block">
			<p class="commissioner-label">Choose the Contracts that move</p>
			<p class="prose">
				Tick every Contract leaving each Team. A Player arriving from a Minor League Slot
				is re-placed against the receiving Team's own occupancy, and his Cap Hit follows
				that placement — the sheet states it in words before anything commits. A Player
				being bid on in an open Auction cannot move: nobody holds him yet.
			</p>

			{#if refusal !== null}
				<!-- The refusal, worded by the pure core. It names what must clear
				     first and offers no control that would cancel a Bid. -->
				<p class="prose refusal" role="status">{refusal.detail}</p>
			{/if}

			<form method="GET" action="/roster-trade">
				<input type="hidden" name="from" value={sending.teamId} />
				<input type="hidden" name="to" value={receiving.teamId} />
				<input type="hidden" name="confirm" value="yes" />

				<fieldset class="roster">
					<legend class="section-label">{sending.teamName} sends</legend>
					{#if sending.players.length === 0}
						<p class="prose">{sending.teamName} holds no Contract that can move.</p>
					{/if}
					{#each sending.players as player (player.fantraxPlayerId)}
						<label class="choice">
							<input
								type="checkbox"
								name="send"
								value={player.fantraxPlayerId}
								checked={sendingPlayerIds.includes(player.fantraxPlayerId)}
							/>
							<span class="prose">
								{player.playerName} — {player.slotLabel}, Cap Hit {player.capHit}{player.won
									? ', won at auction'
									: ''}
							</span>
						</label>
					{/each}
				</fieldset>

				<fieldset class="roster">
					<legend class="section-label">{receiving.teamName} sends</legend>
					{#if receiving.players.length === 0}
						<p class="prose">{receiving.teamName} holds no Contract that can move.</p>
					{/if}
					{#each receiving.players as player (player.fantraxPlayerId)}
						<label class="choice">
							<input
								type="checkbox"
								name="recv"
								value={player.fantraxPlayerId}
								checked={receivingPlayerIds.includes(player.fantraxPlayerId)}
							/>
							<span class="prose">
								{player.playerName} — {player.slotLabel}, Cap Hit {player.capHit}{player.won
									? ', won at auction'
									: ''}
							</span>
						</label>
					{/each}
				</fieldset>

				<div class="controls">
					<a class="back" href="/roster-trade">Choose different Teams</a>
					<button class="control-commissioner" type="submit">Review this Trade</button>
				</div>
			</form>
		</section>
	{:else if step === 'sheet' && sheet !== null && sending !== null && receiving !== null}
		<!--
			The sheet is the SECOND STEP of an ordinary form: the picker above
			navigated here, and this posts. Every word of it is
			`reasonSheetView`'s. The reviewed selection travels in the action's
			own query string, built server-side, so the commit names exactly what
			was reviewed and this file assembles none of it.
		-->
		<ReasonSheet view={sheet} action={commitAction} />
	{/if}
</main>

<style>
	/*
	 * Every colour and dimension is a token from `styles/tokens.css`. The
	 * Commissioner block's ground, dashed rule and the commit control's own
	 * fill and generated label are the stylesheet's and are not named here.
	 */
	.notice,
	.refusal {
		width: 100%;
		margin: 0;
		border-left: var(--accent-bar-width) solid var(--color-attention);
		background-color: var(--color-surface-sunken);
		padding: var(--space-row-gap) var(--space-card-gap);
	}

	.team-choice,
	.roster {
		width: 100%;
		margin: 0 0 var(--space-panel-padding);
		border: none;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
	}

	/* Each row is its own touch target at 375px: the whole label is tappable
	   and never narrower than the minimum. */
	.choice {
		display: flex;
		align-items: center;
		gap: var(--space-card-gap);
		min-height: var(--touch-min);
	}

	.controls {
		display: flex;
		align-items: center;
		gap: var(--space-card-gap);
		flex-wrap: wrap;
	}

	/* A quiet way back, never a second filled control beside the commit. */
	.back {
		display: inline-flex;
		align-items: center;
		min-height: var(--touch-min);
		padding: 0 var(--space-panel-padding);
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: var(--size-13);
		text-decoration: none;
	}
</style>
