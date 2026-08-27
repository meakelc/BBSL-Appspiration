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
	//
	// The relative phrase is safe to derive on the server as well as the
	// client: both instants are UTC and the arithmetic between them is the
	// same wherever it runs.
	const nowIso = $derived(new Date().toISOString());
	const relative = $derived(relativePhrase(auction.nominatedAt, nowIso));

	// The absolute stamp is NOT. `Intl.DateTimeFormat(undefined, ...)`
	// resolves `undefined` to the timezone of whatever machine formats it,
	// and this route is server-rendered like every other, so deriving it
	// during SSR would ship the SERVER's timezone in the delivered HTML —
	// which Svelte does not diff-correct on hydration. AC3 asks for the
	// VIEWER's timezone, so the stamp is computed in an effect, which runs
	// only in the browser, and the markup omits it until it exists rather
	// than rendering a stamp that is wrong for one paint.
	//
	// This is not the "dropped to save space" the Boundaries forbid: the
	// stamp is never traded away for layout, and it is present for every
	// viewer that runs scripts. A viewer that does not gets the relative
	// phrase, which is honest, rather than a time in a timezone that is not
	// theirs, which is not.
	let absolute = $state<string | null>(null);

	// `Intl.DateTimeFormat.format` throws `RangeError` on an Invalid Date,
	// so an unparseable instant is checked for rather than formatted. The
	// pure `relativePhrase` beside it deliberately returns a stated phrase
	// instead of throwing for exactly this input, and `core/instant.ts`'s
	// own header justifies that by saying the absolute stamp renders
	// regardless — which is only true if this cannot crash the page.
	function formatAbsolute(iso: string): string {
		const parsed = new Date(iso);
		if (Number.isNaN(parsed.getTime())) return 'at an unknown time';
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(parsed);
	}

	$effect(() => {
		absolute = formatAbsolute(auction.nominatedAt);
	});
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

	<!-- Exactly two fields when the reference row exists — NBA team as a
	     three-letter capitalised abbreviation (real-life team only, per the
	     glossary) and positions. No cap figure and no years-remaining field:
	     those columns do not exist on `free_agent_players`.
	     The WHOLE panel is conditional, not just the line inside it: `.panel`
	     carries a background, a border and padding, so leaving the section up
	     with its label and no content is precisely the blanked rendering the
	     matrix names as the wrong answer. Omitted entirely means omitted. -->
	{#if auction.metadata !== null}
		<section class="panel">
			<p class="section-label">Player</p>
			<p class="prose" id="auction-metadata">
				{auction.metadata.nbaTeam} &middot; {auction.metadata.positions}
			</p>
		</section>
	{/if}

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
			{#if absolute !== null}
				&mdash;
				<span id="auction-nominated-absolute">{absolute}</span>
			{/if}
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
