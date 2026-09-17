<script lang="ts">
	// Notification settings (Story 5.4, FR-27) — the surface
	// `src/lib/server/destinations.ts` has advertised since Story 1.6.
	//
	// **NO CONTROL, and four categories listed without one.** This page shipped
	// with exactly one mutable category, `slot_release`, and it was retired when
	// FR-9 was amended: a close no longer frees the NOMINATING Team's Nomination
	// Slot, so the notice that category existed for has nobody to send to. The
	// Slot release is now half a sentence on the winner's close line, and the
	// other half reports a Contract the Team is bound by. Nothing is mutable.
	//
	// **So the page says that, rather than looking broken.** An absent control
	// with no explanation leaves a Manager to guess whether the setting is
	// missing or refused, which is the same argument that put the reasons beside
	// the categories in the first place. Every label, statement and reason
	// arrives from `src/lib/core/notification-categories.ts`; this file words
	// none of them.
	//
	// **The form is gone, and the ACTION is not.** A page somebody already had
	// open can still post one, and `+page.server.ts` answers it with a stated
	// refusal — hiding a form was never the check.
	//
	// Voice: no exclamation mark, no urgency framing, no suggested action.
	//
	// Types are declared structurally rather than imported from a server-only
	// module — the rule every page since `nominate` follows. `$lib/core` is a
	// different matter: it is the pure core.
	import {
		NOTIFICATION_CATEGORIES,
		NO_MUTABLE_CATEGORY_STATEMENT
	} from '$lib/core/notification-categories.ts';
</script>

<svelte:head>
	<title>Notification settings — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1>Notification settings</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	<section class="panel">
		<p class="section-label">What reaches you</p>
		<p class="prose" id="no-mutable-category">{NO_MUTABLE_CATEGORY_STATEMENT}</p>
		<p class="prose">
			A notice posts in the league channel and mentions the Managers of the Team it
			happened to. A co-managed Team is mentioned once, with both Managers on the line.
		</p>
	</section>

	<section class="panel" id="unmutable-categories">
		<p class="section-label">Categories with no control, and why</p>
		<ul class="categories">
			{#each NOTIFICATION_CATEGORIES as category (category.id)}
				<li class="category">
					<h3 class="category-label">{category.label}</h3>
					<p class="prose">{category.statement}</p>
					<p class="prose">{category.unmutableReason}</p>
				</li>
			{/each}
		</ul>
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

	/*
	 * One column at every width, and the base is 375px: the single breakpoint
	 * in this codebase is `@media (min-width: 640px)` and this page declares
	 * none, so nothing here has a second layout to disagree with itself in.
	 * `EXPERIENCE.md` requires every Manager surface to be single-column at
	 * 375px with no lateral scrolling.
	 */
	.categories {
		display: flex;
		flex-direction: column;
		gap: var(--space-card-gap);
		list-style: none;
		width: 100%;
	}

	.category {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding-top: var(--space-row-gap);
		border-top: var(--border-width) solid var(--color-border);
	}

	.category-label {
		color: var(--color-text);
		font-size: var(--size-15);
		font-weight: 400;
	}

</style>
