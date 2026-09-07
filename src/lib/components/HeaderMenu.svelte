<script lang="ts">
	// The header menu — an expandable disclosure wrapping `DestinationsList`,
	// per EXPERIENCE.md's "the header menu — the same destinations,
	// expandable. This is what survives the trip to desktop." No dedicated
	// mock exists (EXPERIENCE.md flags the sheet/menu interaction
	// `[DEFERRED]`), so this follows DESIGN.md's existing tokens and the
	// control-manager/control-commissioner class precedent rather than
	// inventing new visual language.
	//
	// The persistent strip itself is Story 4.2's build — this is the one nav
	// trigger this story ships, backed by `DestinationsList`, which 4.2
	// points a second trigger at unchanged.

	import { afterNavigate } from '$app/navigation';

	import DestinationsList from './DestinationsList.svelte';

	// Declared structurally rather than imported from the server-only
	// destinations module — that module must never be reachable from a
	// `.svelte` file.
	type Destination = {
		readonly id: string;
		readonly label: string;
		readonly href: string;
		readonly commissionerOnly: boolean;
		/** False for a permission with no menu row — `classifyDestinations` drops it. */
		readonly listed: boolean;
	};

	let {
		destinations,
		phaseSentence
	}: { destinations: readonly Destination[]; phaseSentence: string } = $props();

	let detailsEl: HTMLDetailsElement | undefined = $state();

	// A SvelteKit client-side navigation swaps the page underneath an open
	// disclosure with no reason to leave it open — a menu still covering the
	// page it just navigated to reads as broken, not helpful.
	afterNavigate(() => {
		if (detailsEl !== undefined) detailsEl.open = false;
	});
</script>

<header class="header-menu">
	<details bind:this={detailsEl}>
		<summary>Menu</summary>
		<div class="header-menu-body">
			<p class="section-label">Phase</p>
			<p class="prose">{phaseSentence}</p>
			<DestinationsList {destinations} />
		</div>
	</details>
</header>

<style>
	/* Minimal, neutral: token-backed spacing and colour only, no new visual
	   language — this component's own wrapper had no rules behind it. Every
	   layout here is flex with gap, never margins between siblings. */
	.header-menu {
		background-color: var(--color-surface);
		border-bottom: var(--border-width) solid var(--color-border);
		padding: var(--space-panel-padding);
	}

	.header-menu summary {
		cursor: pointer;
		color: var(--color-text);
		font-family: var(--font-ui);
		font-size: var(--size-15);
	}

	.header-menu-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		margin-top: var(--space-row-gap);
	}
</style>
