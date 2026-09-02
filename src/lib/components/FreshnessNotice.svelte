<script lang="ts">
	// The freshness notice (Story 4.1, AD-29).
	//
	// **Live renders nothing at all.** AD-29 says so in as many words —
	// announcing "live" constantly is noise — so there is no "connected" badge,
	// no green dot and no reassurance anywhere in this file. The only thing this
	// component can put on a screen is a statement that something is wrong.
	//
	// **It words none of it.** Every sentence arrives finished from
	// `core/freshness.ts`, for the reason `server/phase.ts` words the phase
	// sentences: two copies of a sentence are two sources and they drift the
	// first time one is edited. The age phrase is `relativePhrase`'s, reached
	// through the core's own `figuresAgeSentence` — this file does no time
	// arithmetic and formats nothing.
	//
	// **Degradation is announced, recovery is silent.** The visible panel states
	// the condition; a separate assertive live region carries the Stale
	// announcement and is EMPTY in every other state. A Manager who set the
	// phone down must not have to notice a subtle label — and the return to Live
	// empties the region, which announces nothing, which is exactly the required
	// silence.
	//
	// **It borrows no reserved device.** `DESIGN.md` reserves `attention` for
	// Outbid "and nothing else in the entire system", and the 3px accent bar for
	// the Minimum-Bid Contention and the refusal panel. So this is a plain
	// `.panel` inside a `.page` band, exactly as the phase announcement in
	// `+layout.svelte` is, and it introduces no token, no colour and no new
	// spacing value — the single rule in the style block below zeroes one edge
	// of the shared `.page` padding so the band sits against the page it is
	// about, and adds nothing of its own.
	import {
		FRESHNESS_HEADINGS,
		FRESHNESS_STATEMENTS,
		STALE_ANNOUNCEMENT,
		figuresAgeSentence
	} from '$lib/core/freshness.ts';
	import type { FreshnessState } from '$lib/core/freshness.ts';

	let {
		state,
		lastLivenessOkAt,
		now
	}: {
		state: FreshnessState;
		/** The last successful liveness check, ISO-8601 UTC. */
		lastLivenessOkAt: string;
		/** The instant to render the age against, ISO-8601 UTC. */
		now: string;
	} = $props();

	const heading = $derived(FRESHNESS_HEADINGS[state]);
	const statement = $derived(FRESHNESS_STATEMENTS[state]);
	const age = $derived(figuresAgeSentence(lastLivenessOkAt, now));
</script>

{#if heading !== null && statement !== null}
	<div class="page freshness">
		<section class="panel" aria-labelledby="freshness-heading">
			<h2 id="freshness-heading" class="section-label">{heading}</h2>
			<p class="prose">{statement}</p>
			<!-- The age, always beside the statement: in anything but Live, money
			     either carries its age or the control it would authorise is
			     disabled, and this is the carrying half. -->
			<p class="prose">{age}</p>
		</section>
	</div>
{/if}

<!--
	The announcement, and nothing else.

	Always in the DOM and empty except in Stale, rather than conditionally
	rendered: a live region inserted at the same moment as its content is not
	reliably announced by every screen reader, whereas one that is already
	present and then filled is. `role="alert"` is assertive by definition, which
	is what "must not have to notice" requires — this interrupts.

	Visually hidden because the panel above already states it on screen. The
	region exists to reach a Manager who is not looking, not to say it twice to
	one who is.

	Recovery empties it. An empty live region announces nothing, so returning to
	Live is silent by construction rather than by remembering to keep it so.
-->
<div role="alert" class="visually-hidden">
	{#if state === 'stale'}{STALE_ANNOUNCEMENT}{/if}
</div>

<style>
	/*
	 * The band sits directly above the page it is about — it is a statement
	 * about everything below it, not a card in a list. Zeroing the bottom edge
	 * of the shared `.page` padding is the whole of it: no new spacing value is
	 * introduced, and the token stack still owns every other dimension here.
	 */
	.freshness {
		padding-bottom: 0;
	}
</style>
