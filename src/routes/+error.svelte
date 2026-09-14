<script lang="ts">
	// The one error surface, for every status the app raises.
	//
	// **Before this existed, every refusal was a blank white page.** SvelteKit
	// falls back to its own built-in error document when no `+error.svelte` is
	// present — near-white, one small line of text — which reads as "the app is
	// broken" rather than as an answer. That matters most where the app refuses
	// ON PURPOSE, and it refuses on purpose in three routine places: a closed
	// Auction (`routes/auction/[fantraxPlayerId]/+page.server.ts` raises 404 on
	// a null read, and a close deletes the Auction from the projection), a
	// destination not live for the viewer's phase and role
	// (`requireLiveDestination`'s 403), and an unknown Team. A Manager
	// following a Discord link to an Auction that closed while they slept is
	// the single most likely arrival here, and "There is no open Auction for
	// this Player" is a complete answer — it just had nowhere to be printed.
	//
	// **It words almost nothing itself.** `page.error.message` is the sentence
	// the server already chose, and the routes and guards that raise these
	// errors have their wording reviewed with them — `LIVE_DESTINATION_REFUSAL`
	// is the catalog's, the Auction 404's is that route's. This page prints
	// what it is handed. The one sentence written here is the fallback for a
	// status raised with no message at all, which is a state no route in this
	// app produces deliberately.
	//
	// **It claims nothing about what was or was not written.** EXPERIENCE.md:64
	// asks error copy to "reassure about state, not about feelings", and its
	// example — "Nothing has been committed and the Auction is unchanged" — is
	// exactly the right sentence in the place that can prove it. This page
	// cannot: it renders for a failed form action as readily as for a mistyped
	// URL, and a blanket "nothing was committed" would be a falsehood on the
	// one arrival where it matters most. The reassurance belongs to the
	// surfaces that know, not to the generic page that does not.
	//
	// **The way back is the menu, which is already on screen.** `+layout.svelte`
	// renders either the header menu or the strip's sheet around this page, so
	// this offers one link home and does not re-render `DestinationsList` — a
	// second copy of the menu is the thing that was just removed from the top
	// bar, and it would be no better here.
	import { page } from '$app/state';

	// A status is always present. The message is the server's whenever it set
	// one, which every deliberate refusal in this app does.
	const message = $derived(
		page.error?.message ?? 'That page could not be shown.'
	);
</script>

<svelte:head>
	<title>{page.status} — Appspiration</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="page">
	<section class="panel" aria-labelledby="error-heading">
		<p class="section-label" id="error-status">{page.status}</p>
		<h1 id="error-heading">{message}</h1>
		<p class="prose">
			If you followed a link here, it may point at something that has since closed. The menu has
			everything currently open to you.
		</p>
		<p class="prose"><a href="/">Go to your positions</a></p>
	</section>
</main>
