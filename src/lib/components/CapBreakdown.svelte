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
	// ruled above.
	//
	// Types are declared structurally rather than imported from a server
	// module, the rule `nominate/+page.svelte` states.

	type BreakdownLine = {
		readonly label: string;
		readonly figure: string;
		readonly operator: string;
		readonly kind: 'term' | 'detail' | 'subtotal';
	};

	let {
		lines,
		/** Set on the page's standing column so its rows can be found in a test. */
		id = undefined
	}: { lines: readonly BreakdownLine[]; id?: string | undefined } = $props();
</script>

<dl class="breakdown" {id}>
	{#each lines as line (line.label)}
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
</style>
