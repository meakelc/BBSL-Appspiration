<script lang="ts">
	// The read-only Auction page (Story 2.4).
	//
	// Sourced entirely from the nomination fold and `free_agent_players`: it
	// renders what is real now — Player identity, the nominating Team, an
	// honest "no bids yet" price and an empty history region — and
	// structurally reserves nothing for later. There is no bidding control
	// here at all: `core/rules/bidding` does not exist, so a pre-filled
	// figure for the smallest allowed offer would be invented. That half
	// belongs to a later story.
	//
	// This page offers no way to withdraw, amend or reduce an accepted
	// offer — nothing of the sort is present, not merely turned off,
	// because there is no offer to act on yet either.
	//
	// Types are declared structurally rather than imported from a server-only
	// module — the rule `nominate/+page.svelte:25-27` states and this page
	// follows identically.
	import { relativePhrase } from '$lib/core/instant.ts';

	import type { PageData } from './$types';

	type AuctionMetadata = {
		readonly positions: string;
		readonly nbaTeam: string;
	};

	type Auction = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly metadata: AuctionMetadata | null;
		readonly nominatingTeam: string;
		readonly nominatedAt: string;
	};

	let { data }: { data: PageData } = $props();

	const auction = $derived(data.auction as Auction);

	// The viewer's own clock, read once at render time — never fed back into
	// the pure core, which takes `now` as an argument and reads no clock of
	// its own (AD-3). This is display-only arithmetic in the component, the
	// same split `core/instant.ts`'s own header describes: the pure helper
	// derives the relative phrase, and `Intl.DateTimeFormat` here renders the
	// absolute stamp in the viewer's own timezone.
	const nowIso = $derived(new Date().toISOString());
	const relative = $derived(relativePhrase(auction.nominatedAt, nowIso));

	const absoluteFormatter = new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short'
	});
	const absolute = $derived(absoluteFormatter.format(new Date(auction.nominatedAt)));
</script>

<svelte:head>
	<title>{auction.playerName} — Auction — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1 class="display">{auction.playerName}</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	<section class="panel">
		<p class="section-label">Phase</p>
		<p class="prose">{data.phase.sentence}</p>
	</section>

	<section class="panel">
		<p class="section-label">Player</p>
		<!-- Exactly two fields when the reference row exists — NBA team as a
		     three-letter capitalised abbreviation (real-life team only, per
		     the glossary) and positions. No cap figure and no years-remaining
		     field: those columns do not exist on `free_agent_players`.
		     Omitted entirely, not blanked, when the reference row is missing. -->
		{#if auction.metadata !== null}
			<p class="prose" id="auction-metadata">
				{auction.metadata.nbaTeam} &middot; {auction.metadata.positions}
			</p>
		{/if}
	</section>

	<section class="panel">
		<p class="section-label">Nominating Team</p>
		<!-- The fantasy Team spelled out with its acting Manager attached —
		     `formatTeamManager`'s one rendering, never re-worded here. -->
		<p class="prose" id="auction-nominating-team">{auction.nominatingTeam}</p>
	</section>

	<section class="panel">
		<p class="section-label">Nominated</p>
		<!-- Time appears TWICE: a relative phrase and an absolute stamp in
		     the viewer's own timezone. The absolute is never dropped to save
		     space. -->
		<p class="prose" id="auction-nominated-at">
			<span id="auction-nominated-relative">{relative}</span>
			&mdash;
			<span id="auction-nominated-absolute">{absolute}</span>
		</p>
	</section>

	<section class="panel">
		<p class="section-label">Price</p>
		<!-- An honest "no bids yet" — never a pre-filled smallest-offer
		     figure, never an offer ceiling, never wording about why an
		     action is unavailable. Those all require `core/rules/bidding`,
		     which does not exist yet. -->
		<p class="prose" id="auction-price">No bids yet.</p>
	</section>

	<section class="panel">
		<p class="section-label">History</p>
		<!-- No BidPlaced event exists, so this is the whole of the history
		     region: an explicit sentence, not an empty box. Nothing here
		     lets a Bid be withdrawn, amended or reduced — that whole class
		     of control is absent, because there is no bidding surface on
		     this page at all. -->
		<p class="prose" id="auction-history">No bids have been placed yet.</p>
	</section>
</main>

<style>
	.masthead {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
	}

	.masthead h1 {
		font-size: var(--size-26);
		color: var(--color-text);
	}
</style>
