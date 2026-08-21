<script lang="ts">
	// The skeleton's page. It exists to prove the stack serves a server-rendered
	// document on the design tokens, and to give the Commissioner control class
	// one place to be looked at before Story 1.7 consumes it.
	//
	// No auction surface, no data, no client write path. Those arrive with their
	// own stories.
	//
	// The Phase sentence is NOT typed here. It comes from `locals.phase`, the
	// same server-resolved source the sign-in surface states it from — two
	// copies of that sentence would be two sources, and they would drift.
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Appspiration</title>
	<meta name="description" content="The BBSL offseason free agent auction." />
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

	<!--
		Both controls are disabled, and both state their reason in words beside
		them, associated by aria-describedby rather than merely adjacent. That
		association is the whole justification DESIGN.md:118 gives for text-disabled
		being exempt from WCAG 1.4.3: a disabled control without a stated reason is
		a defect, not a styling choice. A reason a screen reader never reaches is
		not a stated reason.
	-->
	<section class="manager-block">
		<p class="section-label">Manager control</p>
		<button class="control-manager" type="button" disabled aria-describedby="bid-reason">
			Place bid
		</button>
		<p class="prose" id="bid-reason">Bidding is unavailable. The auction has not opened.</p>
	</section>

	<section class="commissioner-block">
		<button
			class="control-commissioner"
			type="button"
			disabled
			aria-describedby="open-auction-reason"
		>
			Open the auction
		</button>
		<p class="prose" id="open-auction-reason">
			The auction cannot open. Thirty-one sources are outstanding and no Team is bound to a
			Manager.
		</p>
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
</style>
