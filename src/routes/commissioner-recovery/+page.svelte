<script lang="ts">
	// The Commissioner break-glass surface (AD-27).
	//
	// A Commissioner control, in a Commissioner block, on the recessed
	// admin ground — so the referee control and the player control are never
	// confusable, with colour or without it.
	//
	// One field, and it is a secret, not an identity. There is no email input
	// here and no account to name.
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const notice = $derived(form?.notice ?? data.sentence);
</script>

<svelte:head>
	<title>Commissioner recovery — Appspiration</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1>Appspiration</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	<section class="panel">
		<p class="section-label">Phase</p>
		<p class="prose">{data.phase.sentence}</p>
	</section>

	<section class="commissioner-block">
		<p class="commissioner-label">Commissioner recovery</p>
		<p class="prose" id="recovery-notice">{notice}</p>

		{#if data.active}
			<p class="prose">
				This session is marked break-glass. It does not depend on Discord and it expires on its
				own; rotate the secret once the outage is over.
			</p>
		{:else}
			<form method="POST">
				<label class="section-label" for="recovery-secret">Recovery secret</label>
				<input
					id="recovery-secret"
					name="secret"
					type="password"
					autocomplete="off"
					spellcheck="false"
					required
					aria-describedby="recovery-notice"
				/>
				<button class="control-commissioner" type="submit" aria-describedby="recovery-notice">
					Sign in without Discord
				</button>
			</form>
		{/if}
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

	input {
		width: 100%;
		min-height: var(--control-height);
		padding: 0 var(--space-panel-padding);
		background-color: var(--color-surface-sunken);
		border: var(--border-width) solid var(--color-border-interactive);
		border-radius: var(--rounded-control);
		color: var(--color-text);
		font-family: var(--font-ui);
		font-size: var(--size-15);
	}
</style>
