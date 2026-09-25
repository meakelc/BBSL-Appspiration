<script lang="ts">
	// The Commissioner-only Bid-reinstatement surface (Story 7.14, FR-32, FR-40).
	//
	// **One step.** The control on a cancelled row of the Auction page's Bid
	// history links here with `?cancellation=<seq>`; this page renders the
	// reason sheet for that Bid Cancellation, or the core's refusal sentence.
	// Only the sheet posts, and it works with JavaScript switched off.
	//
	// **It words nothing.** The act sentence, every before → after row and each
	// consequence note arrive worded by `reason-sheet-view` and the pure core;
	// the refusal sentence arrives from `bidReinstatementRefusalDetail` through
	// the server.
	//
	// Types are declared structurally rather than imported from a server-only
	// module: nothing server-only may be reachable from a `.svelte` file.
	import ReasonSheet from '$lib/components/ReasonSheet.svelte';
	import type { ReasonSheetView } from '$lib/reason-sheet-view.ts';

	import type { ActionData, PageData } from './$types';

	type RecordForm = {
		readonly notice?: string;
		readonly appended?: { readonly seq: string; readonly occurredAt: string } | null;
	};

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const sheet = $derived(data.sheet as ReasonSheetView | null);
	const refusal = $derived(data.refusal as { readonly detail: string } | null);
	const auctionHref = $derived(data.auctionHref as string | null);
	const notice = $derived((form as RecordForm | undefined)?.notice);
	const commitAction = $derived((data.commitAction as string | null) ?? '?/reinstate');
</script>

<svelte:head>
	<title>Reinstate a Bid — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1>Reinstate a Bid</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	{#if notice !== undefined}
		<!-- The outcome of the last submission, worded server-side. -->
		<p class="prose notice" role="status">{notice}</p>
	{/if}

	{#if sheet !== null}
		<!-- Every word of the sheet is `reasonSheetView`'s: the act, the
		     Leading Bid, the Auction Clock, the Bids erased, the League Clock,
		     and the notes on what each change means. -->
		<ReasonSheet view={sheet} action={commitAction} />
	{:else if refusal !== null}
		<section class="commissioner-block">
			<p class="commissioner-label">Reinstate this Bid</p>
			<!-- The refusal, worded by the pure core. Nothing was written. -->
			<p class="prose refusal" role="status">{refusal.detail}</p>
			{#if auctionHref !== null}
				<a class="back" href={auctionHref}>Back to the Auction</a>
			{/if}
		</section>
	{/if}
</main>

<style>
	/*
	 * Every colour and dimension is a token from `styles/tokens.css`. The
	 * Commissioner block's ground and dashed rule are the stylesheet's.
	 */
	.notice,
	.refusal {
		width: 100%;
		margin: 0;
		border-left: var(--accent-bar-width) solid var(--color-attention);
		background-color: var(--color-surface-sunken);
		padding: var(--space-row-gap) var(--space-card-gap);
	}

	/* A quiet way back, never a second filled control. */
	.back {
		display: inline-flex;
		align-items: center;
		min-height: var(--touch-min);
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: var(--size-13);
		text-decoration: none;
	}
</style>
