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
	import { STRIP_REGION_LABEL, STRIP_SHEET_LABEL, baselineMaximumBid, outstandingBidLines, rosterCountSentence, stripShowsMaximumBid, stripShowsOutstandingBids } from '$lib/core/strip.ts';
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
		/** False for a permission with no menu row — `classifyDestinations` drops it. */
		readonly listed: boolean;
	};

	let {
		team,
		phase,
		phaseSentence,
		destinations,
		now
	}: {
		/** The FACTS the figure is derived from. Never a derived figure. */
		team: TeamMoneyState;
		phase: LeaguePhase;
		/**
		 * The ambient phase sentence, already worded by `server/phase.ts`.
		 * It lived in the header menu until that menu became the second copy
		 * of this sheet; it is passed through here for the same reason it was
		 * passed through there, and is worded no more here than it was.
		 */
		phaseSentence: string;
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

	// The bids figure, derived here from the SAME transported facts (AD-7) and
	// worded by the same core module the Roster Count beside it is worded by.
	// `null` for a viewer bound to no Team is the core's own answer, and it is
	// what makes the segment absent rather than `0 of 0`.
	//
	// The phase gate is the core's too, and it is its OWN predicate rather
	// than the money half's: outside the Auction Phase no Bid is accepted at
	// any amount, so a figure about outstanding Bids would describe an act
	// nobody can perform. The Roster Count beside it is unaffected.
	//
	// **Only `.bids` — the entries figure is deliberately not on the strip.**
	// UX-DR35 words this strip as the roster figure and the bids figure and
	// nothing else, and it is inherited by every screen, so a third figure
	// here is a third figure everywhere. The Teams index and the Team view
	// carry the entries count; a Manager who wants it goes to a Team record.
	// `.entries` is therefore never read here rather than computed and
	// thrown away.
	const bids = $derived(
		stripShowsOutstandingBids(phase) ? outstandingBidLines(team).bids : null
	);
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
			<!-- The hamburger, and it is the whole reason this strip is now the
			     ONLY menu trigger. What is otherwise visible on the summary is
			     two figures, which announce a readout and not a control; the
			     header menu used to be the thing that looked openable, and
			     removing it took that signal with it. Drawn rather than
			     lettered, so it costs none of the one line's width — the
			     figures are the facts and never shrink. `aria-hidden`: the
			     trigger is already named by the core's word above, and a
			     second name here would announce the control twice. -->
			<span class="strip-burger" aria-hidden="true">
				<svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
					<path d="M1 3.5h14M1 8h14M1 12.5h14" />
				</svg>
			</span>
			<!-- The facts share a baseline with each other; the row as a whole
			     is centred in the strip by `.strip-summary`. Two containers
			     because one cannot do both — `align-items: baseline` pins a
			     single flex line to the top of the box, which is what left the
			     text all but touching the top border. -->
			<span class="strip-facts">
				<span class="strip-roster">{roster}</span>
				<!-- The bids figure, behind the SAME `·` the money half already
				     uses. Plain type and nothing else: at parity the figure
				     alone is the signal (UX-DR35), and this strip is inherited
				     by every screen, so a warning treatment here would be a
				     warning everywhere. -->
				{#if bids !== null}
					<span class="strip-separator" aria-hidden="true">·</span>
					<span class="strip-bids">{bids}</span>
				{/if}
				<!-- Maximum Bid LAST, so the one number the app exists to
				     compute sits hard against the trailing edge the facts are
				     pushed to. Its separator leads it rather than trails it,
				     which is what keeps a single `·` between every pair of
				     segments whether or not the bids half is present. -->
				{#if showsMaximumBid && figure !== null}
					<span class="strip-separator" aria-hidden="true">·</span>
					<span class="strip-label">{maximumBidLabel}</span>
					<span class="strip-figure money">{figure}</span>
				{/if}
			</span>
		</summary>
		<div class="strip-sheet">
			<!-- The ambient phase sentence, which lived in the header menu
			     until this sheet became the only menu. Same words, same
			     source, one place. -->
			<p class="section-label">Phase</p>
			<p class="prose">{phaseSentence}</p>
			<DestinationsList {destinations} />
		</div>
	</details>
</section>

<style>
	/*
	 * Pinned to the TOP on a phone, in the flow at 640px — the one
	 * breakpoint four route files already use, so this introduces none.
	 * Sized from `--strip-height`; the 52px literal appears nowhere.
	 *
	 * **It was pinned to the bottom until the mobile destination bar
	 * arrived.** The bottom edge is the thumb's edge, and a five-button nav
	 * earns it far more than a readout does: the bar saves a tap on every
	 * navigation, where the strip is read and never pressed for its figures.
	 * Two fixed elements stacked at the same edge would also have cost 112px
	 * of a phone's height, so the readout moved to the top rather than
	 * doubling up. It stays persistent at every width, which is the actual
	 * requirement (`epic-4-context.md:44`) — which edge it is persistent on
	 * never was.
	 *
	 * Top-pinned also puts the sheet back where a disclosure belongs: it
	 * opens DOWNWARD over the page, rather than growing upward out of an
	 * element whose bottom edge is the viewport's.
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
		top: 0;
		/*
		 * Above page content, below nothing else yet. `HeaderMenu`'s
		 * disclosure establishes no stacking context of its own and sits
		 * above this in the document, so 1 is sufficient rather than
		 * arbitrary; the value is local to the one fixed element in the
		 * layout and there is no scale to belong to.
		 */
		z-index: 1;
		background-color: var(--color-surface);
		/* The strip's edge faces the page it sits above, so the rule is on the
		   BOTTOM at every width now — there is no longer a top-pinned and a
		   bottom-pinned case to tell apart. */
		border-bottom: var(--border-width) solid var(--color-border-strong);
		/*
		 * The border is INSIDE the reserved height. `global.css` reserves
		 * exactly `--strip-height` of room, so a border added on top of a
		 * `min-height` of the same token would occupy one pixel more than was
		 * reserved and cover the first row of the page by that much.
		 *
		 * `box-sizing` alone did NOT achieve that, and said so for a year.
		 * It governs an element's OWN specified height, and this element
		 * specifies none — the `min-height` is on `.strip-summary`, a child,
		 * where this rule cannot reach it. So the strip stood at 53px against
		 * 52px of reserved room: it covered a row of the page by exactly the
		 * pixel the comment promised it would not, and `/nominate`'s sticky
		 * action bar, which then cleared `--strip-height`, sat 2px over the
		 * strip.
		 * The height is subtracted on the summary instead, below, where the
		 * `min-height` actually is.
		 */
		box-sizing: border-box;
	}

	.strip-summary {
		display: flex;
		/*
		 * The ROW is centred in the strip; the facts inside it share a
		 * baseline with each other (`.strip-facts`). `align-items: baseline`
		 * here instead put the single flex line at the top of the box, so the
		 * text sat all but against the top border with the whole of the
		 * reserved height empty beneath it.
		 */
		align-items: center;
		gap: var(--space-card-gap);
		/*
		 * The strip's border is subtracted HERE, because this is the element
		 * that carries the height. `.strip` + this row must total exactly
		 * `--strip-height` — the room `global.css` reserves — and the border
		 * lives on the parent, so the row is that much shorter.
		 */
		min-height: calc(var(--strip-height) - var(--border-width));
		padding: var(--space-row-gap) var(--space-panel-padding);
		/* The vertical padding is INSIDE the reserved height, for the same
		   reason the strip's border is: `global.css` reserves exactly
		   `--strip-height`, and anything added on top of it covers the last
		   row of the page by that much. */
		box-sizing: border-box;
		cursor: pointer;
		/* The hamburger IS the disclosure marker now. The browser default
		   would sit to its left, giving the one control on every page two
		   affordances stacked against each other. */
		list-style: none;
		/*
		 * One line, always. The reserved room above the page is a fixed
		 * `--strip-height`; a strip free to wrap to two lines would grow past
		 * the room reserved for it and cover the first row of the page — the
		 * one thing the reservation exists to prevent. The figure and the Roster Count
		 * are short by construction, and the label is the part that may be
		 * elided if a narrow viewport genuinely cannot fit all three.
		 */
		flex-wrap: nowrap;
		white-space: nowrap;
		overflow: hidden;
	}

	/* The inner row: the baseline the label, the figure and the Roster Count
	   share, so a 12px word and a 17px number sit on one line rather than
	   floating against each other. It carries the one-line discipline too —
	   it is the element that actually holds the text.

	   Pushed to the trailing edge by the auto margin, so the hamburger keeps
	   the leading edge and the facts read against the far side of the strip.
	   An auto margin rather than `justify-content` on the row, because the
	   burger must stay put whether or not the money half is present — with
	   `space-between` a strip carrying only the Roster Count would still split
	   two items to opposite ends, which is the same result by accident. */
	.strip-facts {
		display: flex;
		align-items: baseline;
		margin-inline-start: auto;
		gap: var(--space-card-gap);
		flex-wrap: nowrap;
		white-space: nowrap;
		overflow: hidden;
		min-width: 0;
	}

	/* Drawn from the token palette and sized in `em` off the summary's own
	   font, so it tracks the text rather than pinning a second size literal
	   into the strip. It never shrinks: it is the affordance. */
	.strip-burger {
		display: flex;
		flex-shrink: 0;
		color: var(--color-text-secondary);
	}

	.strip-burger svg {
		width: 1em;
		height: 1em;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		fill: none;
	}

	.strip-figure,
	.strip-roster {
		flex-shrink: 0;
	}

	.strip-summary::-webkit-details-marker {
		display: none;
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

	/*
	 * The two count figures share one rule: they are one register, read in
	 * sequence, and a second declaration is a second thing to keep in step.
	 */
	.strip-roster,
	.strip-bids {
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
		/* In the flow under the header, not pinned — Maximum Bid stays on
		   screen and the page needs no room reserved for it.

		   This works because the strip is mounted immediately AFTER
		   `HeaderMenu` in `+layout.svelte` and before the page content:
		   `static` renders it where it sits in the document, so its DOM
		   position is what puts it under the header rather than at the foot
		   of the page. Moving the mount moves the strip.

		   Only the pinning is released. The border already faces the page at
		   both widths, so nothing about the strip's own edge changes here. */
		.strip {
			position: static;
		}
	}
</style>
