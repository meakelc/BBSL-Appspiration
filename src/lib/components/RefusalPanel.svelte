<script lang="ts">
	// The refusal panel (Story 2.6).
	//
	// `EXPERIENCE.md` calls this the most important screen in the product and
	// `DESIGN.md` gives it the only dedicated visual anatomy in the system.
	// Its job is narrow and absolute: a Manager refused at 4am must be able to
	// check the arithmetic by hand, find that it adds up, and put the phone
	// down annoyed at themselves rather than suspicious of the rival manager
	// who built the app.
	//
	// **Nothing here is worded here.** Every sentence, label and figure
	// arrives already produced by `core/rules/bidding.ts` — the headline, the
	// delta, the reassurance, each gate's row, every line of the breakdown and
	// the caption around the timestamp. This component chooses no words and
	// formats no money. That is what makes a refusal read the same in the
	// panel, in the disabled control beneath it and in the tests.
	//
	// **The 3px top accent bar is load-bearing, not decoration.** It is the
	// only top bar in the system, so a refusal is identifiable before a word
	// is read (`DESIGN.md`). Nothing else may borrow the device.
	//
	// **Both chip treatments must survive greyscale.** The refusing gate takes
	// a FILLED `attention` chip and a passing gate an OUTLINED one; the
	// difference is fill, not hue, because a colour difference alone would
	// fail exactly the colourblind manager this design exists to protect. No
	// red appears anywhere — `attention` amber marks Outbid and refusal and
	// nothing else.
	//
	// **The arithmetic is never behind a disclosure.** There is no
	// `<details>`, no toggle and no "show working" control in this markup,
	// deliberately: a breakdown a Manager has to ask for is a breakdown they
	// will not check.
	//
	// Types are declared structurally rather than imported from a server
	// module, the rule `nominate/+page.svelte` states. `$lib/core` is a
	// different matter: it is the pure core both runtimes load (AD-2).
	import { REFUSAL_HEADLINE, REFUSAL_REASSURANCE } from '$lib/core/rules/bidding.ts';
	import CapBreakdown from './CapBreakdown.svelte';

	type GateRow = {
		readonly gate: string;
		readonly label: string;
		readonly passed: boolean;
		readonly chip: string;
		readonly figure: string;
	};

	type BreakdownLine = {
		readonly label: string;
		readonly figure: string;
		readonly operator: string;
		readonly kind: 'term' | 'detail' | 'subtotal';
	};

	/**
	 * The panel's own element, so it can take focus when it appears.
	 *
	 * `role="alert"` alone is not enough here. This form posts without
	 * `use:enhance`, so a refusal arrives as a full page load and the panel is
	 * present in the document at parse time — and a live region that already
	 * exists when the screen reader registers it is not reliably announced,
	 * because announcement fires on MUTATION. Moving focus to the panel on
	 * mount is what makes `EXPERIENCE.md`'s "announced as it appears" true for
	 * a server-rendered refusal as well as a client-rendered one.
	 */
	let panel = $state<HTMLElement | null>(null);

	$effect(() => {
		panel?.focus();
	});

	let {
		/** The refusal's own sentence — part two, the delta, from the core. */
		delta,
		/** Every gate in `PLACE_BID_GATES`, refused and passed alike. */
		gates,
		/** The Maximum Bid breakdown. Empty when there is no arithmetic to show. */
		breakdown,
		/** `figuresAtCaption()`'s finished caption, or `null` while it resolves. */
		caption
	}: {
		delta: string;
		gates: readonly GateRow[];
		breakdown: readonly BreakdownLine[];
		caption: string | null;
	} = $props();
</script>

<!--
	`role="alert"` rather than `role="status"`: a refusal is assertive, and
	`EXPERIENCE.md` requires it ANNOUNCED as it appears rather than merely
	rendered. The element is created by the surrounding `{#if}` at the moment
	of the refusal, which is what makes the announcement fire — a permanently
	present live region that merely changes text announces less reliably, and
	an empty one announces nothing at all.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<section
	class="refusal"
	role="alert"
	tabindex="-1"
	bind:this={panel}
	aria-labelledby="refusal-headline"
>
	<h2 class="refusal-headline" id="refusal-headline">{REFUSAL_HEADLINE}</h2>

	<p class="refusal-delta">{delta}</p>
	<p class="refusal-reassurance">{REFUSAL_REASSURANCE}</p>

	<!--
		Every gate, always — the passing ones beside the refusing one. That
		costs a line per gate and proves every check ran, which forecloses
		"what else is it not telling me". The list is built from
		`PLACE_BID_GATES` in the core, so Story 2.7's `slots` gate appears here
		the moment it is declared and no markup changes.
	-->
	{#if gates.length > 0}
		<ul class="gates">
			{#each gates as row (row.gate)}
			<li class="gate-row">
				<span class="chip" class:refused={!row.passed}>{row.chip}</span>
					<span class="gate-figure">{row.figure}</span>
				</li>
			{/each}
		</ul>
	{/if}

	{#if breakdown.length > 0}
		<div class="arithmetic">
			<!--
				`null` until the client resolves the instant in the viewer's own
				timezone. The caption is omitted rather than rendered in UTC:
				"Your figures at 06:14Z" is a figure about a moment the reader
				does not live in.
			-->
			{#if caption !== null}
				<p class="caption">{caption}</p>
			{/if}
			<CapBreakdown lines={breakdown} />
		</div>
	{/if}
</section>

<style>
	/*
	 * **Every colour is a token**, from `src/lib/styles/tokens.css`, which is
	 * itself copied character-for-character from DESIGN.md's frontmatter and
	 * asserted in both directions by `tests/tokens.test.ts` — so a colour
	 * cannot be introduced here without going through the design source
	 * first. Same for every dimension that HAS a token.
	 *
	 * The handful of literal measurements below — the 11px internal gap, the
	 * 13px top padding, the 9.5px/0.09em chip, the 10.5px caption — are this
	 * panel's own anatomy, specified literally in DESIGN.md's refusal-panel
	 * table and deliberately NOT tokenised. They appear nowhere else in the
	 * product: this is the only surface in the system with a dedicated
	 * anatomy, and a token exists to stop a value drifting between the places
	 * that share it. Promoting them would also mean adding design tokens,
	 * which this story's Ask First list gates.
	 */
	.refusal {
		display: flex;
		flex-direction: column;
		/* Looser than the standard 7px: this panel is read, not scanned. */
		gap: 11px;
		background: var(--color-surface);
		border-radius: var(--rounded-panel);
		/* The sole top accent bar in the system. */
		border-top: var(--accent-bar-width) solid var(--color-attention);
		padding: 13px var(--space-panel-padding) var(--space-panel-padding);
	}

	.refusal-headline {
		margin: 0;
		font-family: var(--font-display);
		font-size: var(--size-19);
		font-weight: normal;
		line-height: 1.3;
		color: var(--color-text);
	}

	.refusal-delta,
	.refusal-reassurance {
		margin: 0;
		font-size: var(--size-12-5);
		line-height: 1.6;
		color: var(--color-text-prose);
	}

	/*
	 * The panel takes focus when it appears so a screen reader announces it on
	 * a full page load, and a focus ring on a container a Manager did not
	 * click would read as an interactive element. The announcement is the
	 * point, not the outline.
	 */
	.refusal:focus {
		outline: none;
	}

	.gates {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.gate-row {
		display: flex;
		/* Chip left, sentence right, top-aligned. */
		align-items: flex-start;
		gap: var(--space-card-gap);
		flex-wrap: wrap;
	}

	/*
	 * Outlined is the PASSING treatment and filled the refusing one. The two
	 * differ by fill rather than by hue so the distinction survives greyscale
	 * — a manager who cannot separate the colours can still separate a solid
	 * block from an outline.
	 */
	.chip {
		flex: none;
		text-transform: uppercase;
		font-size: 9.5px;
		letter-spacing: 0.09em;
		border-radius: var(--rounded-chip);
		padding: 3px 6px;
		border: var(--border-width) solid var(--color-border-interactive);
		color: var(--color-text-secondary);
	}

	.chip.refused {
		background: var(--color-attention);
		border-color: var(--color-attention);
		color: var(--color-attention-ink);
	}

	.gate-figure {
		flex: 1 1 12rem;
		font-size: var(--size-12-5);
		line-height: 1.6;
		color: var(--color-text-prose);
	}

	.arithmetic {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		/* Separated above by a rule, per the design's anatomy table. */
		border-top: var(--border-width) solid var(--color-border);
		padding-top: 11px;
	}

	.caption {
		margin: 0;
		font-size: 10.5px;
		color: var(--color-text-tertiary);
	}

</style>
