<script lang="ts">
	// The Roster Move surface (Story 7.11, FR-44, UX-DR41).
	//
	// **Two blocks, never one block with a flag.** A Manager's own act renders
	// in a `manager-block` and commits through `ManagerSheet.svelte`; the
	// Commissioner's on-behalf act renders in a `commissioner-block` and
	// commits through `ReasonSheet.svelte`. The server decides which, from the
	// session's own manager row — nothing here can ask for the other one, and
	// `tests/signin-surface.test.ts` walks this file to prove no control ever
	// sits in the wrong block.
	//
	// **Three steps, each of them ordinary navigation.** The Commissioner picks
	// a Team; a Manager's is already decided from the session and step one
	// never renders for them. Then tick the Contracts to move — there are
	// exactly two participating Slots, so each row is a toggle to the other one
	// — then read the sheet and commit. Only the third step posts. Nothing here
	// needs client JavaScript: with it switched off the pickers still submit,
	// the sheet still renders, and the Move still commits or is still refused.
	//
	// **It words no OUTCOME.** Everything that states what the app decided
	// arrives already worded from elsewhere and is rendered verbatim: the act
	// sentence, every before → after row, the sentence saying which way Maximum
	// Bid actually moved and both sheets' titles, labels and footers are
	// `reason-sheet-view`'s, and every refusal sentence is the pure core's
	// through `rearrangeRefusalDetail`. Nothing on this page computes, pairs or
	// paraphrases any of them.
	//
	// What IS written here is the standing instructional prose above each
	// picker — the paragraphs explaining what a Roster Move does and which
	// Slots participate. Those describe the SURFACE rather than any decision,
	// they are the same words whatever the state, and they are the one kind of
	// copy that belongs in the markup it labels. `vite.config.ts` pins
	// `environment: 'node'` and no `.svelte` file renders under the suite, so
	// anything asserted here could only be asserted by reading source text —
	// which is exactly why no outcome wording is allowed to live here.
	//
	// **No control on this page cancels a Bid.** A refused Move states what
	// must clear first and offers a way back to the picker, and that is all:
	// FR-40's cancellation trigger is a Close and only a Close.
	//
	// Types are declared structurally rather than imported from a server-only
	// module: nothing in the server-only library may ever be reachable from a
	// `.svelte` file.
	import ManagerSheet from '$lib/components/ManagerSheet.svelte';
	import ReasonSheet from '$lib/components/ReasonSheet.svelte';
	import type { ConfirmSheetView, ReasonSheetView } from '$lib/reason-sheet-view.ts';

	import type { ActionData, PageData } from './$types';

	type TeamRow = { readonly id: string; readonly name: string };

	type PickerPlayer = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly slotLabel: string;
		readonly targetLabel: string;
		readonly capHit: string;
		readonly value: string;
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
	const commissioner = $derived(data.commissioner as boolean);
	const teams = $derived((data.teams as readonly TeamRow[]) ?? []);
	const team = $derived(data.team as Picker | null);
	const sheet = $derived(data.sheet as ReasonSheetView | null);
	const managerSheet = $derived(data.managerSheet as ConfirmSheetView | null);
	const refusal = $derived(data.refusal as { readonly detail: string } | null);
	const moveValues = $derived((data.moveValues as readonly string[]) ?? []);
	const recordForm = $derived(form as RecordForm | undefined);
	const notice = $derived(recordForm?.notice);
	// Built server-side and posted to verbatim. The reviewed selection travels
	// in the action's own query string rather than as hidden fields, because
	// the sheet's `<form>` is the sheet component's and nesting a second form
	// inside it is invalid HTML the browser silently drops.
	const commitAction = $derived((data.commitAction as string | null) ?? '?/record');
</script>

<svelte:head>
	<title>Record a Roster Move — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1>Record a Roster Move</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	{#if notice !== undefined}
		<!-- The outcome of the last submission, worded server-side. `role="status"`
		     so it is announced without stealing focus. -->
		<p class="prose notice" role="status">{notice}</p>
	{/if}

	{#if step === 'team'}
		<!--
			The Commissioner's first step, and only the Commissioner's: a Manager
			never reaches it, because their Team came from the session and the
			server refuses a `team` parameter naming anybody else.
		-->
		<section class="commissioner-block">
			<p class="commissioner-label">Choose the Team</p>
			<p class="prose">
				A Roster Move re-places one Team’s own Contracts between its Active/Bench Slots and its
				Minor League Slots. No Contract changes hands and no amount is edited — what changes is
				what each Contract charges. Nothing is recorded until you have read the sheet and given a
				reason.
			</p>

			<!--
				A GET form, not a POST: choosing a Team decides nothing and writes
				nothing, so it belongs in the URL where the back button can undo
				it. A radio list, not a `<select>` — there is not one in
				`src/routes` and there is not one here.
			-->
			<form method="GET" action="/roster-move">
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
	{:else if step === 'players' && team !== null && commissioner}
		<section class="commissioner-block">
			<p class="commissioner-label">Choose the Contracts to re-place</p>
			<p class="prose">
				Tick every Contract to move, and it moves to the other Slot. A Contract in a Minor League
				Slot charges nothing; the same Contract in an Active/Bench Slot charges in full. Injury
				Reserve is a Fantrax fact about a player’s health and is not offered, and Dead Money is a
				charge rather than a Player. A Player being bid on in an open Auction cannot be moved.
			</p>

			{#if refusal !== null}
				<!-- The refusal, worded by the pure core. It names what must clear
				     first and offers no control that would cancel a Bid. -->
				<p class="prose refusal" role="status">{refusal.detail}</p>
			{/if}

			<form method="GET" action="/roster-move">
				<input type="hidden" name="team" value={team.teamId} />
				<input type="hidden" name="confirm" value="yes" />

				<fieldset class="roster">
					<legend class="section-label">{team.teamName} re-places</legend>
					{#if team.players.length === 0}
						<p class="prose">{team.teamName} holds no Contract that can be re-placed.</p>
					{/if}
					{#each team.players as player (player.fantraxPlayerId)}
						<label class="choice">
							<input
								type="checkbox"
								name="move"
								value={player.value}
								checked={moveValues.includes(player.value)}
							/>
							<span class="prose">
								{player.playerName} — {player.slotLabel}, Cap Hit {player.capHit} → move to
								{player.targetLabel}{player.won ? ', won at auction' : ''}
							</span>
						</label>
					{/each}
				</fieldset>

				<div class="controls">
					<a class="back" href="/roster-move">Choose a different Team</a>
					<button class="control-commissioner" type="submit">Review this Roster Move</button>
				</div>
			</form>
		</section>
	{:else if step === 'players' && team !== null}
		<section class="manager-block">
			<p class="section-label">Choose the Contracts to re-place</p>
			<p class="prose">
				Tick every Contract to move, and it moves to the other Slot. A Contract in a Minor League
				Slot charges nothing; the same Contract in an Active/Bench Slot charges in full — so a
				Roster Move is a deliberate cap decision, and it can move your Maximum Bid in either
				direction. Injury Reserve is not offered, and a Player being bid on in an open Auction
				cannot be moved.
			</p>

			{#if refusal !== null}
				<p class="prose refusal" role="status">{refusal.detail}</p>
			{/if}

			<form method="GET" action="/roster-move">
				<input type="hidden" name="confirm" value="yes" />

				<fieldset class="roster">
					<legend class="section-label">{team.teamName} re-places</legend>
					{#if team.players.length === 0}
						<p class="prose">{team.teamName} holds no Contract that can be re-placed.</p>
					{/if}
					{#each team.players as player (player.fantraxPlayerId)}
						<label class="choice">
							<input
								type="checkbox"
								name="move"
								value={player.value}
								checked={moveValues.includes(player.value)}
							/>
							<span class="prose">
								{player.playerName} — {player.slotLabel}, Cap Hit {player.capHit} → move to
								{player.targetLabel}{player.won ? ', won at auction' : ''}
							</span>
						</label>
					{/each}
				</fieldset>

				<div class="controls">
					<button class="control-manager" type="submit">Review this Roster Move</button>
				</div>
			</form>
		</section>
	{:else if step === 'sheet' && sheet !== null}
		<!--
			The Commissioner's sheet: dashed, and it will not proceed without a
			reason. Every word of it is `reasonSheetView`'s — including the
			sentence stating which way this Team's Maximum Bid actually moved,
			which is the one consequence neither state on the sheet shows.
		-->
		<ReasonSheet view={sheet} action={commitAction} />
	{:else if step === 'sheet' && managerSheet !== null}
		<!--
			The Manager's own sheet: solid, and it asks for no reason. FR-44 is
			explicit that a Manager rearranging their own Roster is making an
			ordinary strategic decision rather than a referee intervention. It
			states exactly the same consequences.
		-->
		<ManagerSheet view={managerSheet} action={commitAction} />
	{/if}
</main>

<style>
	/*
	 * Every colour and dimension is a token from `styles/tokens.css`. Both
	 * blocks' grounds and both commit controls' own fill, border and generated
	 * label are the stylesheet's and are not named here.
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
