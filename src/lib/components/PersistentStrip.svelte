<script lang="ts">
	// The persistent strip (Story 4.2) — the one number the whole app exists
	// to compute, on every surface, doubling as the destinations trigger.
	//
	// **The figure is derived HERE, in the browser, from transported facts.**
	// `baselineMaximumBid` calls `evaluate()` over the `TeamMoneyState` the
	// layout shipped; no `maximumBid` field crosses the wire (AD-7), because a
	// transported figure would be the check rather than a rendering of one. It
	// is a `$derived`, so every projection change the freshness contract
	// already forces a reload for recomputes it — there is nothing memoised
	// and therefore nothing to invalidate.
	//
	// **It words nothing.** The label is `MAXIMUM_BID_LABELS`', which is
	// already the Auction page's, including in Live; the Roster Count sentence
	// and the phase table are `core/strip.ts`'; the money is `describeAmount`,
	// the core's ONE money renderer (AD-8). No sentence, no figure and no
	// number-to-text step lives in this file.
	//
	// **The sheet renders the SAME `DestinationsList` the header menu
	// renders** (AD-30). One list, two triggers — never a copy, and never a
	// second resolution of what a Manager may reach. The disclosure is
	// `<details>`, the pattern `HeaderMenu.svelte` established: no focus trap,
	// no modal, nothing to escape from.
	//
	// **The figure this strip states may read LOWER than the Auction page's
	// own panel, and that is correct.** The panel excludes that Auction's own
	// lead from Committed Bids because a raise replaces it; the baseline
	// excludes nothing, so a Team leading elsewhere sees its own commitments
	// held against it — the true answer to "what can I spend on something
	// new". The panel remains the authority for bidding; this is orientation.
	import { afterNavigate } from '$app/navigation';

	import { MAXIMUM_BID_LABELS } from '$lib/core/freshness.ts';
	import { describeAmount } from '$lib/core/rules/bidding.ts';
	import type { TeamMoneyState } from '$lib/core/rules/bidding.ts';
	import { STRIP_SHEET_LABEL, baselineMaximumBid, rosterCountSentence, stripShowsMaximumBid } from '$lib/core/strip.ts';
	import type { LeaguePhase } from '$lib/core/projection/phase.ts';
	import { freshness } from '$lib/client/freshness.svelte.ts';

	import DestinationsList from './DestinationsList.svelte';

	// Declared structurally rather than imported from the server-only
	// destinations module — that module must never be reachable from a
	// `.svelte` file.
	type Destination = {
		readonly id: string;
		readonly label: string;
		readonly href: string;
		readonly commissionerOnly: boolean;
	};

	let {
		team,
		phase,
		destinations,
		now
	}: {
		/** The FACTS the figure is derived from. Never a derived figure. */
		team: TeamMoneyState;
		phase: LeaguePhase;
		destinations: readonly Destination[];
		/** A server instant, for the one gate that asks what time it is. */
		now: string;
	} = $props();

	let detailsEl: HTMLDetailsElement | undefined = $state();

	// A client-side navigation swaps the page underneath an open sheet with no
	// reason to leave it open — `HeaderMenu.svelte`'s own reasoning, and the
	// same three lines, because a sheet still covering the page it just
	// navigated to reads as broken rather than helpful.
	afterNavigate(() => {
		if (detailsEl !== undefined) detailsEl.open = false;
	});

	const showsMaximumBid = $derived(stripShowsMaximumBid(phase));

	// `null` only when the core says there is no figure. `describeAmount`
	// renders the negative a Team over its Cap genuinely has, unclamped: a
	// `$0.0M` in place of it would state something false to the Team that most
	// needs told.
	const maximumBid = $derived(baselineMaximumBid(team, phase, now));
	const figure = $derived(maximumBid === null ? null : describeAmount(maximumBid));

	// The label is the core's in EVERY state, including Live — the surface
	// prints one field rather than choosing between two wordings. In anything
	// but Live it says "last known", which is the half of AD-29's obligation
	// that applies while the figure is still on screen. The AGE itself is
	// stated once, by the notice the layout mounts, so it is not repeated.
	const maximumBidLabel = $derived(MAXIMUM_BID_LABELS[freshness.state]);

	const roster = $derived(rosterCountSentence(team.rosterCount));
</script>

<!-- A `region` landmark rather than a live region: this states standing
     figures, and re-announcing them on every navigation is how a live region
     becomes noise nobody can turn off. -->
<section class="strip" aria-label={STRIP_SHEET_LABEL}>
	<details bind:this={detailsEl}>
		<summary class="strip-summary">
			<!-- The trigger names itself for a screen reader, since what is
			     VISIBLE on it is two figures rather than a verb. The word is
			     the core's, like every other on this strip. -->
			<span class="visually-hidden">{STRIP_SHEET_LABEL}</span>
			{#if showsMaximumBid && figure !== null}
				<span class="strip-label">{maximumBidLabel}</span>
				<span class="strip-figure money">{figure}</span>
				<span class="strip-separator" aria-hidden="true">·</span>
			{/if}
			<span class="strip-roster">{roster}</span>
		</summary>
		<div class="strip-sheet">
			<DestinationsList {destinations} />
		</div>
	</details>
</section>

<style>
	/*
	 * Pinned to the bottom on a phone, in the flow at 640px — the one
	 * breakpoint four route files already use, so this introduces none.
	 * Sized from `--strip-height`; the 52px literal appears nowhere.
	 *
	 * Legible without colour: the label is the display face and the figure
	 * the `ui` face a size up, so the two are told apart by typeface and
	 * size rather than by hue. `brand` on the words is DESIGN.md's own
	 * pairing and carries no state meaning — it is brand, never a signal
	 * that anything is leading, winning or approved.
	 */
	.strip {
		position: fixed;
		inset-inline: 0;
		bottom: 0;
		z-index: 1;
		background-color: var(--color-surface);
		border-top: var(--border-width) solid var(--color-border-strong);
	}

	.strip-summary {
		display: flex;
		align-items: baseline;
		gap: var(--space-card-gap);
		min-height: var(--strip-height);
		padding: 0 var(--space-panel-padding);
		cursor: pointer;
	}

	/* "Maximum Bid" in Georgia `brand` — DESIGN.md:222, epics.md:1435. */
	.strip-label {
		font-family: var(--font-display);
		font-size: var(--size-12);
		color: var(--color-brand);
	}

	/* The figure at 17px in the `ui` face — DESIGN.md:173. */
	.strip-figure {
		font-size: var(--strip-figure-size);
		letter-spacing: -0.02em;
		color: var(--color-text);
	}

	.strip-separator {
		font-size: var(--size-12);
		color: var(--color-text-tertiary);
	}

	.strip-roster {
		font-size: var(--size-12);
		color: var(--color-text-secondary);
	}

	.strip-sheet {
		padding: var(--space-panel-padding);
		border-top: var(--border-width) solid var(--color-border);
		max-height: 60svh;
		overflow-y: auto;
	}

	@media (min-width: 640px) {
		/* In the header, not pinned to the bottom — Maximum Bid stays on
		   screen and the page keeps its last control. */
		.strip {
			position: static;
			border-top: none;
			border-bottom: var(--border-width) solid var(--color-border-strong);
		}
	}
</style>
