<script lang="ts">
	// The shell every page renders inside: the header menu, and — since Story
	// 3.7 — the phase-transition announcement.
	//
	// **The announcement is not the ambient phase sentence.** `HeaderMenu`
	// already prints `data.phase.sentence` on every page and has since Story
	// 1.4; that says what the phase IS. This says it CHANGED, and it is the one
	// thing a Manager who was asleep when the League Clock expired needs told.
	// Both are worded in `src/lib/server/phase.ts` and neither is written here:
	// no route, component or test words a phase.
	//
	// **It is a standing statement, not a live one.** `role="status"` would
	// re-announce the identical sentence to a screen reader on every single
	// navigation for the weeks Contract Assignment lasts, which is how a live
	// region becomes noise nobody can turn off. This is an ordinary `region`
	// landmark named by its own heading, so it is reachable by landmark and
	// heading navigation and announced exactly when a reader goes looking for
	// it.
	//
	// **It borrows no reserved device.** `DESIGN.md` reserves the 3px accent
	// bar for the Minimum-Bid Contention's left bar and the refusal panel's top
	// bar and says no other element may borrow it, and reserves `attention` for
	// Outbid "and nothing else in the entire system". So this is a plain
	// `.panel` — the shared 1px border and one-step-lighter surface — inside a
	// `.page` band, and it introduces no token, no colour and no sizing
	// literal.
	import '$lib/styles/global.css';
	import type { Snippet } from 'svelte';

	import HeaderMenu from '$lib/components/HeaderMenu.svelte';

	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<HeaderMenu destinations={data.destinations} phaseSentence={data.phase.sentence} />

{#if data.phase.announcement !== null}
	<div class="page">
		<section class="panel" aria-labelledby="phase-announcement-heading">
			<h2 id="phase-announcement-heading" class="section-label">
				{data.phase.announcement.heading}
			</h2>
			<p class="prose">{data.phase.announcement.body}</p>
		</section>
	</div>
{/if}

{@render children()}
