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
	import { STRIP_REGION_LABEL, STRIP_SHEET_LABEL, baselineMaximumBid, rosterCountSentence, stripShowsMaximumBid } from '$lib/core/strip.ts';
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
		closeSheet();
	});

	function closeSheet() {
		if (detailsEl !== undefined) detailsEl.open = false;
	}

	// Escape closes it, and a click landing anywhere outside closes it. A
	// `<details>` gives neither for free, and without them the sheet is a
	// panel a keyboard user can open on every page and then only dismiss by
	// finding the trigger again. This is NOT a focus trap and does not become
	// one: nothing is trapped, nothing is made modal, and the page underneath
	// stays reachable throughout — the disclosure pattern the spec requires,
	// with the two dismissals a disclosure is expected to honour.
	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		if (detailsEl === undefined || !detailsEl.open) return;
		closeSheet();
		// Return focus to the control that opened it, or the dismissal
		// silently strands a keyboard user at the top of the document.
		detailsEl.querySelector('summary')?.focus();
	}

	function onWindowPointerdown(event: MouseEvent) {
		if (detailsEl === undefined || !detailsEl.open) return;
		if (event.target instanceof Node && detailsEl.contains(event.target)) return;
		closeSheet();
	}

	const showsMaximumBid = $derived(stripShowsMaximumBid(phase));

	// `null` only when the core says there is no figure. `describeAmount`
	// renders the negative a Team over its Cap genuinely has, unclamped: a
	// `$0.0M` in place of it would state something false to the Team that most
	// needs told.
	//
	// **Guarded, for the same reason `stripTeamFor` catches server-side.** This
	// component is mounted by the ROOT layout, so an unexpected throw in here —
	// a `TeamMoneyState` of an unexpected shape after a schema drift, say —
	// would not break the strip, it would break the render of every page in the
	// product. The server half of that discipline was already enforced; this is
	// the client half. A caught throw yields no figure, exactly as a phase with
	// no figure does, and the Roster Count still states what it knows.
	const maximumBid = $derived.by(() => {
		try {
			return baselineMaximumBid(team, phase, now);
		} catch {
			return null;
		}
	});
	const figure = $derived.by(() => {
		if (maximumBid === null) return null;
		try {
			return describeAmount(maximumBid);
		} catch {
			return null;
		}
	});

	// The label is the core's in EVERY state, including Live — the surface
	// prints one field rather than choosing between two wordings. In anything
	// but Live it says "last known", which is the half of AD-29's obligation
	// that applies while the figure is still on screen. The AGE itself is
	// stated once, by the notice the layout mounts, so it is not repeated.
	const maximumBidLabel = $derived(MAXIMUM_BID_LABELS[freshness.state]);

	const roster = $derived(rosterCountSentence(team.rosterCount));
</script>

<svelte:window on:keydown={onWindowKeydown} on:pointerdown={onWindowPointerdown} />

<!-- A `region` landmark rather than a live region: this states standing
     figures, and re-announcing them on every navigation is how a live region
     becomes noise nobody can turn off.

     The region and the sheet carry DIFFERENT names, because they are different
     things: the landmark holds Maximum Bid and the Roster Count, and the sheet
     is one control within it. Naming both "Destinations" announced a landmark
     that then read out money. -->
<section class="strip" aria-label={STRIP_REGION_LABEL}>
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
		/*
		 * Above page content, below nothing else yet. `HeaderMenu`'s
		 * disclosure establishes no stacking context of its own and sits
		 * above this in the document, so 1 is sufficient rather than
		 * arbitrary; the value is local to the one fixed element in the
		 * layout and there is no scale to belong to.
		 */
		z-index: 1;
		background-color: var(--color-surface);
		border-top: var(--border-width) solid var(--color-border-strong);
		/*
		 * The border is INSIDE the reserved height. `global.css` reserves
		 * exactly `--strip-height` of room, so a border added on top of a
		 * `min-height` of the same token would occupy one pixel more than was
		 * reserved and cover the last row of the page by that much.
		 */
		box-sizing: border-box;
	}

	.strip-summary {
		display: flex;
		align-items: baseline;
		gap: var(--space-card-gap);
		min-height: var(--strip-height);
		padding: 0 var(--space-panel-padding);
		cursor: pointer;
		/*
		 * One line, always. The reserved room below the page is a fixed
		 * `--strip-height`; a strip free to wrap to two lines would grow past
		 * the room reserved for it and cover the last control — the one thing
		 * the reservation exists to prevent. The figure and the Roster Count
		 * are short by construction, and the label is the part that may be
		 * elided if a narrow viewport genuinely cannot fit all three.
		 */
		flex-wrap: nowrap;
		white-space: nowrap;
		overflow: hidden;
	}

	.strip-figure,
	.strip-roster {
		flex-shrink: 0;
	}

	/*
	 * A persistent control on every page needs a visible focus ring. The
	 * global rule at `global.css:184` covers `a, button, input, select,
	 * textarea` — a `<summary>` is none of those, so it gets the identical
	 * treatment stated here rather than a different one invented here.
	 */
	.strip-summary:focus-visible {
		outline: 2px solid var(--color-border-interactive);
		/* Inset, not offset: an outward ring on an element flush with the
		   viewport edge is clipped on the outer side. */
		outline-offset: -2px;
	}

	/* "Maximum Bid" in Georgia `brand` — DESIGN.md:222, epics.md:1435.
	   Also the one part that may shrink: the figure and the Roster Count are
	   the facts, and the label is the word introducing one of them, so if
	   something has to give at 320px it is the word and never the number. */
	.strip-label {
		font-family: var(--font-display);
		font-size: var(--size-12);
		color: var(--color-brand);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
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
		   screen and the page keeps its last control.

		   This works because the strip is mounted immediately AFTER
		   `HeaderMenu` in `+layout.svelte` and before the page content:
		   `static` renders it where it sits in the document, so its DOM
		   position is what puts it under the header rather than at the foot
		   of the page. Moving the mount moves the strip. */
		.strip {
			position: static;
			border-top: none;
			border-bottom: var(--border-width) solid var(--color-border-strong);
		}
	}
</style>
