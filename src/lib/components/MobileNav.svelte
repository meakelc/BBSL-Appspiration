<script lang="ts">
	// The mobile destination bar — the five pages a Manager actually moves
	// between, one tap away at the bottom of every surface below 640px.
	//
	// **It is a SELECTION from the one destination list, never a second one.**
	// `navDestinations` narrows exactly what `resolveDestinations` already
	// returned for this phase and this role (AD-30, AR-29/UX-DR19); it can drop
	// entries and can never add one. A destination absent from the sheet can
	// therefore never appear here, in any phase, for any viewer — which is the
	// whole reason the selection is a function in `destinations-view.ts` a
	// `vitest` test can call, rather than a filter written inline in markup.
	//
	// **It words nothing.** Every label on every button is the catalog's own
	// `destination.label`, the same string the sheet prints. There is no short
	// form, no abbreviation and no per-button wording in this file: a bar
	// reading "Positions" beside a sheet reading "Your Positions" would be two
	// names for one page, which is how a product starts disagreeing with
	// itself.
	//
	// **The icons are drawn, and they are decoration.** Each is `aria-hidden`
	// and every button is named by the visible label beneath it, so nothing is
	// identified by picture alone (and nothing by colour alone — the current
	// page is marked by `aria-current`, a filled-in icon AND a brand-coloured
	// label). An id with no icon of its own falls back to a neutral mark rather
	// than rendering an empty box: the catalog may grow a row before this file
	// learns to draw it, and a missing picture must never cost a Manager the
	// destination.
	//
	// **Below 640px only.** Above it the strip is in the flow under the header
	// with its sheet, the pointer is a cursor rather than a thumb, and a bar
	// pinned across the bottom of a wide window is a tap nobody was going to
	// have to make anyway. It is `display: none` there, not merely restyled.
	import { page } from '$app/state';

	import { navDestinations } from '../destinations-view.ts';

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

	const entries = $derived(navDestinations(destinations));

	/**
	 * The bar's own name, stated here rather than in `core/strip.ts`.
	 *
	 * `STRIP_SHEET_LABEL` names the SHEET, and the two must not share a name:
	 * a screen reader that meets "Destinations" twice on one page — once as a
	 * landmark across the bottom and once as a control in the strip — is being
	 * told there is one thing in two places rather than two things.
	 */
	const NAV_LABEL = 'Pages';

	/**
	 * Which button, if any, is the page being viewed.
	 *
	 * A prefix match as well as an exact one, because a destination's href is
	 * an index and the surfaces beneath it are its children: a Manager looking
	 * at one Team under `/teams/…` is still in Teams. `/` is matched exactly
	 * and never as a prefix, or a landing-page row would claim every route in
	 * the product.
	 */
	function isCurrent(href: string): boolean {
		const path = page.url.pathname;
		if (href === '/') return path === '/';
		return path === href || path.startsWith(`${href}/`);
	}
</script>

<!--
	`nav`, so it is reachable by landmark navigation as the thing it is, and
	named, because the strip's sheet is a second navigation on the same page
	and an unnamed one cannot be told from it.

	Rendered only when the selection carries something. A Manager with no
	listed destination of their own — a non-Commissioner through all of Setup —
	would otherwise get an empty 60px bar, and `global.css` reserves room for
	`.mobile-nav` by `:has()`, so an empty bar is also 60px of dead page.
-->
{#if entries.length > 0}
	<nav class="mobile-nav" aria-label={NAV_LABEL}>
		{#each entries as destination (destination.id)}
			{@const current = isCurrent(destination.href)}
			<a class="nav-button" href={destination.href} aria-current={current ? 'page' : undefined}>
				<!-- Decoration: the button is named by the label below it. A
				     second accessible name here would announce every
				     destination twice. -->
				<span class="nav-icon" aria-hidden="true">
					<svg viewBox="0 0 20 20" width="20" height="20" focusable="false">
						{#if destination.id === 'your-positions'}
							<!-- A Manager's own roster: one figure. -->
							<circle cx="10" cy="6.25" r="2.75" />
							<path d="M4 16.5c0-2.8 2.7-4.5 6-4.5s6 1.7 6 4.5" />
						{:else if destination.id === 'bid-board'}
							<!-- The board: a header rule and a column of rows. -->
							<rect x="3" y="4" width="14" height="12" rx="1.5" />
							<path d="M3 8h14M8 8v8" />
						{:else if destination.id === 'nominate'}
							<!-- Putting a Player up: a plus. -->
							<circle cx="10" cy="10" r="6.75" />
							<path d="M10 7v6M7 10h6" />
						{:else if destination.id === 'teams'}
							<!-- The thirty Teams: a crest. -->
							<path d="M10 3l6 2.2v4.6c0 3.4-2.4 6-6 7.2-3.6-1.2-6-3.8-6-7.2V5.2L10 3Z" />
						{:else if destination.id === 'audit-log'}
							<!-- The record: a document of lines. -->
							<path d="M5 2.75h7l3 3v11.5H5z" />
							<path d="M7.5 9h5M7.5 12.25h5" />
						{:else if destination.id === 'contract-assignment'}
							<!-- The same document, settled: a check. -->
							<path d="M5 2.75h7l3 3v11.5H5z" />
							<path d="M7.5 10.5l2 2 3.5-4" />
						{:else if destination.id === 'export'}
							<!-- Taking the file away: down, into a tray. -->
							<path d="M10 3v8m0 0 3-3m-3 3-3-3" />
							<path d="M4 13.5v3h12v-3" />
						{:else}
							<!-- No icon drawn for this id yet. A neutral mark, so
							     the destination still renders and is still
							     reachable — see the header comment. -->
							<circle cx="10" cy="10" r="6.75" />
							<circle cx="10" cy="10" r="1.5" />
						{/if}
					</svg>
				</span>
				<span class="nav-label">{destination.label}</span>
			</a>
		{/each}
	</nav>
{/if}

<style>
	/*
	 * Pinned to the bottom edge below 640px — the thumb's edge, which is why
	 * the strip gave it up. Sized from `--nav-height`; the 60px literal
	 * appears nowhere, so the room `global.css` reserves and the bar
	 * occupying it can only ever be the same value.
	 */
	.mobile-nav {
		position: fixed;
		inset-inline: 0;
		bottom: 0;
		/* The same 1 the strip stands at. Both are fixed elements owned by the
		   layout, neither overlaps the other, and there is no scale here to
		   belong to. */
		z-index: 1;
		display: flex;
		align-items: stretch;
		background-color: var(--color-surface);
		/* Faces the page above it, as the strip's bottom border faces the page
		   below it. `border-strong` because this is a viewport edge and not a
		   panel seam — the same rule the strip uses, for the same reason. */
		border-top: var(--border-width) solid var(--color-border-strong);
		/* The border is INSIDE the reserved height, exactly as the strip's is:
		   `global.css` reserves `--nav-height` and no more, so a border added
		   on top of it would cover the last row of the page by that much. */
		min-height: var(--nav-height);
		box-sizing: border-box;
	}

	/*
	 * Equal widths, whatever the count. `flex: 1 1 0` rather than
	 * `space-evenly`, so three destinations in Contract Assignment fill the
	 * bar the same way five do in the Auction — a phase with fewer pages gets
	 * wider buttons, never a huddle in the middle with dead edges either side.
	 *
	 * `min-width: 0` is what lets a long label wrap instead of forcing the row
	 * wider than the viewport.
	 */
	.nav-button {
		flex: 1 1 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		padding: var(--space-row-gap) 2px;
		box-sizing: border-box;
		/* The whole button is the target, and it clears the 44px floor by the
		   height of the bar alone. */
		min-height: var(--touch-min);
		color: var(--color-text-secondary);
		/* A nav button is a destination, not prose: the underline every other
		   link in the product carries would put five rules across the bottom
		   of every page. */
		text-decoration: none;
	}

	.nav-icon {
		display: flex;
		flex-shrink: 0;
	}

	.nav-icon svg {
		width: 20px;
		height: 20px;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
		fill: none;
	}

	/*
	 * 10px, the smallest step on the scale, and it is a NAME rather than a
	 * label — no uppercase and no tracking, which at this size is what makes
	 * "Contract Assignment" unreadable rather than merely small.
	 *
	 * Two lines at most: at 320px a fifth of the bar is 64px, which "Your
	 * Positions" does not fit on one line at any size this product declares.
	 * Wrapping is the honest answer; eliding to "Your Posi…" is not. The
	 * clamp bounds it at two so a third line can never push the bar past the
	 * room reserved for it.
	 */
	.nav-label {
		max-width: 100%;
		font-size: var(--size-10);
		line-height: 1.15;
		text-align: center;
		overflow: hidden;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow-wrap: anywhere;
	}

	/*
	 * The page being viewed, marked TWICE over: the icon fills in and the
	 * label takes `brand`. Colour alone would fail anyone who cannot see it,
	 * and `aria-current="page"` in the markup states it a third time for a
	 * reader. `brand` here is the same brand the strip's label carries and
	 * carries no state meaning — it marks where you are, never that something
	 * is leading, winning or approved.
	 */
	.nav-button[aria-current='page'] {
		color: var(--color-brand);
	}

	.nav-button[aria-current='page'] .nav-icon svg {
		fill: color-mix(in srgb, var(--color-brand) 22%, transparent);
	}

	/*
	 * Inset, not offset: an outward ring on a control flush with the viewport
	 * edge is clipped on the outer side. The strip's summary states the same
	 * rule for the same reason — the global one offsets outward, which is
	 * right everywhere except against an edge.
	 */
	.nav-button:focus-visible {
		outline: 2px solid var(--color-border-interactive);
		outline-offset: -2px;
	}

	/* Above the breakpoint the strip is in the flow under the header with its
	   sheet, and a bar pinned across the bottom of a wide window saves a tap
	   nobody had to make. Not rendered at all — `body:has(.mobile-nav)` still
	   matches a hidden element, which is why the room `global.css` reserves is
	   released at this same breakpoint rather than left to this rule. */
	@media (min-width: 640px) {
		.mobile-nav {
			display: none;
		}
	}
</style>
