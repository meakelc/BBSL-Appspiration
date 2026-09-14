<script lang="ts">
	// The one destination list, rendered (AR-29/UX-DR19: one list, rendered
	// twice — the header menu here, and the persistent strip's sheet Story
	// 4.2 builds against this same component). All classification lives in
	// `classifyDestinations` (`$lib/destinations-view.ts`) — this component
	// holds none of its own, so a `vitest` test can cover the classification
	// directly rather than only by scanning rendered markup.

	import { classifyDestinations } from '../destinations-view.ts';

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

	let { destinations }: { destinations: readonly Destination[] } = $props();

	const classified = $derived(classifyDestinations(destinations));
</script>

<div class="destinations-list">
	{#if classified.hasNothingLive}
		<!--
			The state every non-Commissioner Manager sees through all of Setup,
			now that Setup's four entries are Commissioner-only: a stated
			sentence, not an empty disclosure with no content.
		-->
		<p class="prose">Nothing is live for you right now.</p>
	{/if}

	{#if classified.signIn !== undefined}
		<!--
			Its own neutral wrapper, outside the manager/commissioner grouping —
			an unauthenticated visitor's only reachable action is not a Manager
			control, and rendering it as one would mislabel it as such.
		-->
		<div class="sign-in-block">
			<a href={classified.signIn.href}>{classified.signIn.label}</a>
		</div>
	{/if}

	{#if classified.managerDestinations.length > 0}
		<div class="manager-block">
			{#each classified.managerDestinations as destination (destination.id)}
				<a class="control-manager" href={destination.href}>{destination.label}</a>
			{/each}
		</div>
	{/if}

	{#if classified.commissionerDestinations.length > 0}
		<div class="commissioner-block">
			{#each classified.commissionerDestinations as destination (destination.id)}
				<a class="control-commissioner" href={destination.href}>{destination.label}</a>
			{/each}
		</div>
	{/if}
</div>

<style>
	/* Minimal, neutral: token-backed spacing only, no new visual language.
	   The manager/commissioner sub-elements already inherit control-manager /
	   control-commissioner / commissioner.css's block grounds; only this
	   component's own outer wrapper and the Sign-in wrapper were unstyled. */
	.destinations-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-section-gap);
	}

	.sign-in-block {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		color: var(--color-text);
	}
</style>
