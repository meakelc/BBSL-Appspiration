<script lang="ts">
	// The Commissioner-only Drop surface (Story 7.8, FR-43, UX-DR40).
	//
	// **Three steps, each of them ordinary navigation.** Pick the Team, pick
	// the Contracts released, then read the sheet and commit. The first two
	// steps are `GET` forms, so the selection lives in the URL and the back
	// button is the undo. Only the third step posts. Nothing here needs client
	// JavaScript to work: with it switched off the pickers still submit, the
	// sheet still renders, and the reason is still typed and still enforced
	// server-side.
	//
	// **It words nothing.** The act sentence, every before → after row and the
	// consequence sentence stating what a Drop does to the Maximum Bid arrive already
	// worded by `reason-sheet-view` and the pure core; the refusal sentence
	// arrives from `dropRefusalDetail` through the server. `vite.config.ts`
	// pins `environment: 'node'` and no `.svelte` file renders under the suite,
	// so words asserted in a component are words asserted by reading source
	// text — which is another reason none of them are here.
	//
	// **No control on this page cancels a Bid.** A refused Drop states what
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

	const step = $derived(data.step as 'team' | 'players' | 'sheet');
	const teams = $derived((data.teams as readonly TeamRow[]) ?? []);
	const team = $derived(data.team as Picker | null);
	const sheet = $derived(data.sheet as ReasonSheetView | null);
	const refusal = $derived(data.refusal as { readonly detail: string } | null);
	const fantraxPlayerIds = $derived((data.fantraxPlayerIds as readonly string[]) ?? []);
	const recordForm = $derived(form as RecordForm | undefined);
	const notice = $derived(recordForm?.notice);
	// Built server-side and posted to verbatim. The reviewed selection travels
	// in the action's own query string rather than as hidden fields, because
	// the sheet's `<form>` is `ReasonSheet.svelte`'s and nesting a second form
	// inside it is invalid HTML the browser silently drops — which would post a
	// Drop naming no Players at all.
	const commitAction = $derived((data.commitAction as string | null) ?? '?/record');
</script>

<svelte:head>
	<title>Record a Drop — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1>Record a Drop</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	{#if notice !== undefined}
		<!-- The outcome of the last submission, worded server-side. `role="status"`
		     so it is announced without stealing focus. -->
		<p class="prose notice" role="status">{notice}</p>
	{/if}

	{#if step === 'team'}
		<section class="commissioner-block">
			<p class="commissioner-label">Choose the Team</p>
			<p class="prose">
				A Drop records a release the Team already made in Fantrax. The Contract stops
				counting against the twelve and keeps charging the Cap as Dead Money, at exactly
				what it was charging before — the League waives Dead Money only in the amnesty
				before the auction opens, never here. Nothing is recorded until you have read the
				sheet and given a reason.
			</p>

			<!--
				A GET form, not a POST: choosing a Team decides nothing and writes
				nothing, so it belongs in the URL where the back button can undo
				it. There is no `<select>` anywhere in `src/routes` and there is
				not one here either — a radio list says the same thing and stays
				operable at 375px.
			-->
			<form method="GET" action="/roster-drop">
				<fieldset class="team-choice">
					<legend class="section-label">Team</legend>
					{#each teams as row (row.id)}
						<label class="choice">
							<input type="radio" name="team" value={row.id} checked={data.teamId === row.id} />
							<span class="prose">{row.name}</span>
						</label>
					{/each}
				</fieldset>

				<button class="control-commissioner" type="submit">Choose this Team</button>
			</form>
		</section>
	{:else if step === 'players' && team !== null}
		<section class="commissioner-block">
			<p class="commissioner-label">Choose the Contracts released</p>
			<p class="prose">
				Tick every Contract the Team released. A Minor League Contract was charging nothing
				and leaves nothing behind; an Active/Bench or Injury Reserve Contract keeps charging
				in full as Dead Money. A Player being bid on in an open Auction cannot be dropped,
				and neither can one won at auction — he is not in Fantrax yet.
			</p>

			{#if refusal !== null}
				<!-- The refusal, worded by the pure core. It names what must clear
				     first and offers no control that would cancel a Bid. -->
				<p class="prose refusal" role="status">{refusal.detail}</p>
			{/if}

			<form method="GET" action="/roster-drop">
				<input type="hidden" name="team" value={team.teamId} />
				<input type="hidden" name="confirm" value="yes" />

				<fieldset class="roster">
					<legend class="section-label">{team.teamName} released</legend>
					{#if team.players.length === 0}
						<p class="prose">{team.teamName} holds no Contract that can be dropped.</p>
					{/if}
					{#each team.players as player (player.fantraxPlayerId)}
						<label class="choice">
							<input
								type="checkbox"
								name="drop"
								value={player.fantraxPlayerId}
								checked={fantraxPlayerIds.includes(player.fantraxPlayerId)}
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
					<a class="back" href="/roster-drop">Choose a different Team</a>
					<button class="control-commissioner" type="submit">Review this Drop</button>
				</div>
			</form>
		</section>
	{:else if step === 'sheet' && sheet !== null && team !== null}
		<!--
			The sheet is the SECOND STEP of an ordinary form: the picker above
			navigated here, and this posts. Every word of it is
			`reasonSheetView`'s — including the sentence saying that an
			Active/Bench release does to this Team's Maximum Bid — the reserve on
			the freed Slot, and then the net direction, which falls when the Cap
			Hit is carried and rises when it goes back to Cap Space. That is the
			one consequence neither state on the sheet shows.
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
