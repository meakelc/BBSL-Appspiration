<script lang="ts">
	// The Maximum Bid breakdown column (Story 2.6).
	//
	// **One definition, two surfaces.** The Auction page shows this column
	// standing, beside the bid control; the refusal panel shows it again as
	// part five of a refusal. They must be recognisably the same column — a
	// Manager who reads the standing figures and then reads a refusal has to
	// see the same ledger, or the refusal looks like a different claim about a
	// different thing. Two copies of this markup and CSS would be free to
	// drift into exactly that.
	//
	// **It sums as displayed, and nothing here does the summing.** Every label
	// and figure arrives finished from `capBreakdown()` in
	// `core/rules/bidding.ts`, which derives them beside the arithmetic they
	// come from. This component formats no money and computes nothing.
	//
	// `kind` is the core's instruction about what each row IS, so no component
	// decides which rows are ledger lines and which are commentary:
	// a `detail` row sits outside the column's arithmetic, and a `subtotal` is
	// ruled above. `summary` is the core's instruction about which rows stand
	// while the column is COLLAPSED, decided the same way and for the same
	// reason — see `CapBreakdownLine` in `core/rules/bidding.ts`.
	//
	// **Collapsing is opt-in, and the refusal panel does not take it.** A
	// breakdown a Manager has to ask for is a breakdown they will not check,
	// which is exactly what a refusal may not be; the panel renders the column
	// whole and this control never appears there. The STANDING column is a
	// different question — a Manager reading it before they type has an answer
	// they mostly want, and a ledger they occasionally want — so that one asks
	// for the disclosure.
	//
	// Types are declared structurally rather than imported from a server
	// module, the rule `nominate/+page.svelte` states.

	import { CAP_BREAKDOWN_COLLAPSE, CAP_BREAKDOWN_EXPAND } from '$lib/core/rules/bidding.ts';

	type BreakdownLine = {
		readonly label: string;
		readonly figure: string;
		readonly operator: string;
		readonly kind: 'term' | 'detail' | 'subtotal';
		/**
		 * Optional so a caller building its own lines need not answer a
		 * question it never asks: a column that is not `collapsible` renders
		 * every row regardless, and this field is read nowhere else.
		 */
		readonly summary?: boolean;
	};

	let {
		lines,
		/** Set on the page's standing column so its rows can be found in a test. */
		id = undefined,
		/**
		 * Whether the column opens showing only its `summary` rows, with a
		 * control that reveals the rest. `false` renders the whole ledger and
		 * no control at all — which is what a refusal gets.
		 */
		collapsible = false
	}: {
		lines: readonly BreakdownLine[];
		id?: string | undefined;
		collapsible?: boolean;
	} = $props();

	let expanded = $state(false);

	/**
	 * Whether the control has anything to reveal.
	 *
	 * A column whose every row is a summary row is already whole, and a
	 * control offering to show what is already shown is a control that lies.
	 */
	const hasMore = $derived(collapsible && lines.some((line) => line.summary !== true));

	/** Which rows stand right now. The core decided which; this decides when. */
	const shown = $derived(
		!hasMore || expanded ? lines : lines.filter((line) => line.summary === true)
	);
</script>

<dl class="breakdown" {id}>
	{#each shown as line (line.label)}
		<div
			class="line"
			class:detail={line.kind === 'detail'}
			class:total={line.kind === 'subtotal'}
		>
			<dt>{line.label}</dt>
			<dd>{line.operator}{line.operator === '' ? '' : ' '}{line.figure}</dd>
		</div>
	{/each}
</dl>

<!--
	A BUTTON, not a `<details>`: the rows it reveals belong to the `<dl>` above
	in ledger order, interleaved with the ones already standing, and a
	`<details>` could only append them after the summary — a column that does
	not sum in the order it is read.

	`aria-expanded` is what announces the state, and `aria-controls` points at
	the list it opens where the caller gave that list an id.
-->
{#if hasMore}
	<button
		type="button"
		class="disclosure"
		aria-expanded={expanded}
		aria-controls={id}
		onclick={() => (expanded = !expanded)}
	>
		{expanded ? CAP_BREAKDOWN_COLLAPSE : CAP_BREAKDOWN_EXPAND}
	</button>
{/if}

<style>
	.breakdown {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		margin: 0;
	}

	.line {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--space-card-gap);
		font-size: var(--size-13);
		color: var(--color-text);
	}

	.line dt,
	.line dd {
		margin: 0;
	}

	.line dt {
		color: var(--color-text-secondary);
	}

	/*
	 * A ledger figure is one token and must not be broken across lines. A
	 * DETAIL row's figure is a sentence, and is allowed to wrap — see below.
	 */
	.line dd {
		font-variant-numeric: var(--numerals);
		white-space: nowrap;
	}

	/* Commentary on the term above it — outside the column's arithmetic. */
	.line.detail {
		font-size: var(--size-11);
		color: var(--color-text-tertiary);
		padding-left: var(--space-panel-padding);
		/*
		 * A detail row carries a sentence rather than a figure ("Roster Count
		 * 9, Projected Active/Bench Additions 3, of 12"), which cannot sit on
		 * one line beside its label at 375px. It wraps and aligns left of its
		 * own accord rather than pushing the column into a horizontal scroll,
		 * which on the most important surface in the product would hide the
		 * arithmetic a Manager is being asked to check.
		 */
		flex-wrap: wrap;
	}

	.line.detail dt,
	.line.detail dd {
		color: var(--color-text-tertiary);
	}

	.line.detail dd {
		white-space: normal;
		text-align: right;
	}

	/* A running total, ruled above in border-strong. */
	.line.total {
		border-top: var(--border-width) solid var(--color-border-strong);
		padding-top: var(--space-row-gap);
	}

	/*
	 * The disclosure reads as a link rather than a control with a box: it
	 * reveals rows already on the page and commits nothing, and a bordered
	 * button beside the bid control would be a second thing to press on the
	 * one surface whose single button matters.
	 *
	 * It still has the touch target a control needs — the padding is vertical
	 * so the text stays flush with the column's left edge.
	 */
	.disclosure {
		align-self: flex-start;
		margin-top: var(--space-row-gap);
		padding: var(--space-row-gap) 0;
		border: none;
		background: none;
		font-family: inherit;
		font-size: var(--size-12-5);
		color: var(--color-text-secondary);
		text-align: left;
		text-decoration: underline;
		cursor: pointer;
	}
</style>
