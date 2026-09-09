<script lang="ts">
	// The Manager sign-in surface.
	//
	// One Discord action. One sentence. The current phase, from the same
	// server-resolved source every other surface states it from.
	//
	// No address field, no secret field, no invitation to make a second attempt
	// with a different account — AD-15 refuses an unregistered account without
	// a loop to probe the league with, and a prompt here would be that loop.
	//
	// Nothing on this page names, links to or hints at the Commissioner's
	// Discord-independent sign-in. That path is unadvertised on purpose.
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// A failed sign-in attempt overrides the loaded state, so a Discord outage
	// discovered on submit reads the same as one discovered on load.
	const state = $derived(form?.state ?? data.state);
	const notice = $derived(form?.notice ?? data.notice);

	// The action is offered in exactly two states: a signed-out visitor, and one
	// whose session expired. A refused account is NOT offered it — AD-15 refuses
	// an unregistered account with no loop to probe the league with, and a live
	// button under the refusal is that loop. When the provider is unreachable
	// the action would fail anyway, and a control that cannot work states why.
	const actionable = $derived(state === 'signed-out' || state === 'expired');
</script>

<svelte:head>
	<title>Sign in — Appspiration</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1>Appspiration</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	<section class="manager-block">
		<p class="section-label">Sign in</p>

		<!--
			One sentence, and which sentence it is IS the state. An expired session
			says so in words rather than presenting as a fresh sign-out; an
			unregistered account reads the same refusal as every other unregistered
			account, with nothing in it that varies by caller.
		-->
		<p class="prose" id="signin-notice">{notice}</p>

		<form method="POST" action="?/discord">
			<input type="hidden" name="returnTo" value={data.returnTo} />
			<button
				class="control-manager"
				type="submit"
				disabled={!actionable}
				aria-describedby="signin-notice"
			>
				Sign in with Discord
			</button>
		</form>
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
		width: 100%;
	}
</style>
