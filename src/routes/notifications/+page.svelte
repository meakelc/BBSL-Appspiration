<script lang="ts">
	// Notification settings (Story 5.4, FR-27) — the surface
	// `src/lib/server/destinations.ts` has advertised since Story 1.6.
	//
	// **ONE control, and four categories listed without one.** Exactly one
	// mention category is mutable, and the mute is PER MANAGER rather than per
	// Team — every sentence on this page has the reader as its subject for that
	// reason. The four categories that are not mutable are listed here
	// WITH THE REASON no control exists — not hidden, because an absent control
	// with no explanation leaves a Manager to guess whether the setting is
	// missing or refused. Every label, statement and reason arrives from
	// `src/lib/core/notification-categories.ts`; this file words none of them.
	//
	// **The control states what muting will and will not do**, in two sentences
	// rather than presenting a bare toggle: the mention stops, the notice does
	// not. That is the whole design of the story and a switch would state
	// neither half.
	//
	// **No JavaScript is required to use this page.** One form, one submit, and
	// the direction is stated by a hidden field rather than by a bound
	// checkbox — so the control works with scripting unavailable and the server
	// receives an explicit direction instead of inferring one.
	//
	// Voice: no exclamation mark, no urgency framing, no suggested action.
	//
	// Types are declared structurally rather than imported from a server-only
	// module — the rule every page since `nominate` follows. `$lib/core` is a
	// different matter: it is the pure core.
	import {
		MUTABLE_CATEGORY_MUTE_EFFECT,
		MUTABLE_CATEGORY_MUTE_LIMIT,
		MUTABLE_NOTIFICATION_CATEGORY,
		NOTIFICATION_CATEGORIES,
		notificationMuteStateDetail
	} from '$lib/core/notification-categories.ts';

	import type { ActionData, PageData } from './$types';

	type MuteForm = {
		readonly notice?: string;
		readonly slotReleaseMuted?: boolean;
	};

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const muteForm = $derived(form as MuteForm | undefined);
	const notice = $derived(muteForm?.notice);

	/**
	 * The state the page renders from: the action's answer when a submit has
	 * just landed, otherwise the `load`'s. A failed submit carries no value —
	 * nothing was written — so the loaded state stands, which is the truth.
	 */
	const muted = $derived(muteForm?.slotReleaseMuted ?? data.slotReleaseMuted === true);

	/** The one mutable category's copy, and the four that are not. */
	const mutable = $derived(
		NOTIFICATION_CATEGORIES.find((category) => category.id === MUTABLE_NOTIFICATION_CATEGORY)
	);
	const unmutable = $derived(
		NOTIFICATION_CATEGORIES.filter((category) => category.unmutableReason !== null)
	);

	/** The current state, in the core's words. */
	const stateSentence = $derived(notificationMuteStateDetail(muted));
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
		<p class="section-label">Phase</p>
		<p class="prose">{data.phase.sentence}</p>
	</section>

	<section class="panel">
		<p class="section-label">What a mute changes</p>
		<p class="prose">
			A mute is set per Manager and withholds your own mention. Every notice still posts
			in the league channel, still names the Team it happened to, and still states what
			happened. One category can be muted; the four below it cannot, and each states
			why.
		</p>
	</section>

	{#if mutable}
		<section class="manager-block" id="mutable-category">
			<h2 class="category-label">{mutable.label}</h2>
			<p class="prose">{mutable.statement}</p>
			<p class="prose">{MUTABLE_CATEGORY_MUTE_EFFECT}</p>
			<p class="prose">{MUTABLE_CATEGORY_MUTE_LIMIT}</p>

			<!-- The current state as a SENTENCE, never as a tick mark alone and
			     never by colour, so a greyscale screenshot stays readable. -->
			<p class="prose state" id="mutable-category-state">{stateSentence}</p>

			<form method="POST" action="?/mute">
				<input type="hidden" name="category" value={MUTABLE_NOTIFICATION_CATEGORY} />
				<!-- The direction, stated rather than inferred. The server refuses a
				     submission that states neither. -->
				<input type="hidden" name="muted" value={muted ? 'no' : 'yes'} />
				<button class="control-manager" type="submit" id="mutable-category-submit">
					{muted ? 'Unmute this category' : 'Mute this category'}
				</button>
			</form>

			<!-- The outcome of a submit is the only place a Manager learns whether
			     the change landed, and after a form post the focus is still on the
			     control that was pressed. `role="status"` announces it politely
			     rather than leaving a screen reader user to go looking for it. -->
			<div role="status">
				{#if notice}
					<p class="prose" id="mute-notice">{notice}</p>
				{/if}
			</div>
		</section>
	{/if}

	<section class="panel" id="unmutable-categories">
		<p class="section-label">Categories with no control, and why</p>
		<ul class="categories">
			{#each unmutable as category (category.id)}
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

	/* The state sentence reads as the page's own answer rather than as more
	   explanation, so it takes the primary text colour. Not a colour signal:
	   the words say which state it is. */
	.state {
		color: var(--color-text);
	}

	form {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-row-gap);
		width: 100%;
	}
</style>
