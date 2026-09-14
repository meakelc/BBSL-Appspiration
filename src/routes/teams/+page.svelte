<script lang="ts">
	// The Teams index (Story 4.6).
	//
	// Every Team in the League as one ruled list, each row linking to that
	// Team's own page, with the League Median at the foot.
	//
	// **No wording of its own.** Every label, sentence, ordering and href
	// arrives from `$lib/core/teams-index.ts`, so each has exactly one
	// definition in the codebase and a synonym cannot appear in markup. What
	// this file holds is structure and CSS.
	//
	// **Sorting is VIEW STATE and never changes a figure.** One rune over a
	// list the server transported as facts, handed to the core's own
	// comparator; no figure and no median is recomputed when it changes, and
	// the median was taken over the unsorted set before any of this ran.
	//
	// **Nothing here is coloured by comparison, ever** (`DESIGN.md:191`). No
	// rank, no arrow, no chip, no badge, and nothing on the surface is
	// distinguished by a Team's position relative to the median. The viewer's
	// own row is marked by a 2px `border-strong` left edge and `— you` in
	// place of the Manager name — never the 3px `lottery` bar — and it is not
	// pinned, reordered or exempted from the sort. A greyscale screenshot of
	// this surface is not merely readable, it is identical.
	//
	// Types are declared structurally rather than imported from a server-only
	// module — the rule `nominate/+page.svelte` states and every page since
	// follows. `$lib/core` is a different matter: it is the pure core, and
	// `sortTeamsIndex` below is the same function the tests drive.
	import {
		DEFAULT_TEAMS_SORT,
		EMPTY_TEAMS_HEADING,
		EMPTY_TEAMS_STATEMENT,
		TEAMS_INDEX_TITLE,
		TEAMS_SORT_KEYS,
		TEAMS_SORT_LABELS,
		TEAMS_SORT_LEGEND,
		sortTeamsIndex
	} from '$lib/core/teams-index.ts';
	import type { TeamsIndex, TeamsSort } from '$lib/core/teams-index.ts';
	import { TEAM_VIEW_LABELS } from '$lib/core/team-view.ts';
	import { figuresAgeSentence } from '$lib/core/freshness.ts';
	import { freshness } from '$lib/client/freshness.svelte.ts';

	import type { PageData } from './$types';

	/**
	 * The index's own shape, imported from the CORE rather than restated.
	 *
	 * `teams/[teamId]/+page.svelte` declares its type structurally because
	 * `TeamViewState` lives in the server-only library, which a `.svelte` file
	 * may not reach. That does not apply here: `TeamsIndex` is the pure core's,
	 * which is what AD-2 says both runtimes load, so restating twenty fields by
	 * hand would be a second declaration nothing forces to stay in step — the
	 * exact duplication Story 4.5's review removed for `TeamRosterEntryRow`.
	 * Only `figuresAt` is the server's addition.
	 */
	type TeamsIndexState = TeamsIndex & { readonly figuresAt: string };

	let { data }: { data: PageData } = $props();

	const index = $derived(data.index as TeamsIndexState);

	/**
	 * The whole of this page's view state. It touches no server, and it cannot
	 * change a figure: `sortTeamsIndex` is generic over rows it does not
	 * construct, so there is no expression in it that could produce a number.
	 */
	let sort = $state<TeamsSort>(DEFAULT_TEAMS_SORT);

	/**
	 * Whether the sort's choices are showing. View state about VIEW STATE: it
	 * reorders nothing and narrows nothing, it only decides whether the radios
	 * are on screen. Closed to begin with — see the disclosure's own note in
	 * the markup below.
	 */
	let sortOpen = $state(false);

	/** The list in the order the reader asked for. Nothing else moves. */
	const shown = $derived(sortTeamsIndex(index.rows, sort));

	/**
	 * The age of every figure on this page, in anything but Live (AD-29).
	 *
	 * The index takes the AGE branch of the freshness rule and not the disable
	 * branch, because there is no control here to disable — nothing on this
	 * surface authorises anything (`EXPERIENCE.md:139`). ONE line for the page,
	 * because thirty Teams' figures came from a single transaction anchored on
	 * a single `figuresAt`.
	 */
	const figuresAge = $derived(
		freshness.state === 'live'
			? null
			: figuresAgeSentence(freshness.lastLivenessOkAt, freshness.now)
	);

	/**
	 * The absolute stamp, computed in an `$effect` and therefore only in the
	 * browser — the SSR-leak rule `teams/[teamId]/+page.svelte:145-147`
	 * establishes. `Intl.DateTimeFormat(undefined, ...)` resolves `undefined`
	 * to the timezone of whatever machine formats it, so deriving this during
	 * SSR would ship the SERVER's timezone in the delivered HTML, which Svelte
	 * does not diff-correct on hydration.
	 */
	let readAt = $state<string | null>(null);

	function formatAbsolute(iso: string): string | null {
		const parsed = new Date(iso);
		if (Number.isNaN(parsed.getTime())) return null;
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(parsed);
	}

	$effect(() => {
		readAt = formatAbsolute(index.figuresAt);
	});
</script>

<svelte:head>
	<title>{TEAMS_INDEX_TITLE} — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1 class="section-label">{TEAMS_INDEX_TITLE}</h1>
		<p class="prose" id="teams-count">{index.countSentence}</p>
		<!-- Every figure on this page carries its age in anything but Live
		     (AD-29). Nothing here is disabled, because nothing here
		     authorises. -->
		{#if figuresAge !== null}
			<p class="prose" id="teams-figures-age">{figuresAge}</p>
		{/if}
		{#if readAt !== null}
			<p class="when" id="teams-figures-at">{readAt}</p>
		{/if}
	</header>

	{#if index.rows.length === 0}
		<!-- A designed empty screen, not an edge case: a League with no Teams
		     is a real state and the median has nothing to cover. -->
		<section class="panel" id="teams-empty">
			<h2 class="section-label">{EMPTY_TEAMS_HEADING}</h2>
			<p class="prose">{EMPTY_TEAMS_STATEMENT}</p>
		</section>
	{:else}
		<!-- Sorting is view state. It posts nothing, reloads nothing, and
		     changes no figure — the list is reordered and nothing else. Native
		     radios in a fieldset, `board/+page.svelte`'s pattern, so the rule
		     is visible in the markup rather than asserted in a comment.

		     CLOSED by default, behind the board's own disclosure: four radios
		     standing permanently between the masthead and the first Team is
		     most of a 375px first screen spent on a view that is almost always
		     the default one. The closed row is not a hidden control — it prints
		     the order in force, so the answer the radios gave by which one is
		     ticked is now given in words. `<details>`/`<summary>` and one flag:
		     it opens on tap AND on Enter and is announced expanded or
		     collapsed. Choosing closes it, because the choice is the whole
		     reason it was opened and the list beneath is what the Manager came
		     to read. -->
		<details class="controls-disclosure" bind:open={sortOpen}>
			<summary>
				<span class="section-label">{TEAMS_SORT_LEGEND}</span>
				<span class="prose controls-current">{TEAMS_SORT_LABELS[sort]}</span>
				<span class="controls-mark" aria-hidden="true">
					<svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
						<path d="M4 6.5 8 10.5 12 6.5" />
					</svg>
				</span>
			</summary>
			<fieldset class="controls">
				<!-- The legend still names the group for a screen reader reading
				     the radios; the summary above is what names it on screen,
				     and two visible copies would be the control titled twice. -->
				<legend class="visually-hidden">{TEAMS_SORT_LEGEND}</legend>
				{#each TEAMS_SORT_KEYS as key (key)}
					<label class="choice" for={`teams-sort-${key}`}>
						<input
							id={`teams-sort-${key}`}
							type="radio"
							name="teams-sort"
							value={key}
							bind:group={sort}
							onchange={() => (sortOpen = false)}
						/>
						<span class="prose">{TEAMS_SORT_LABELS[key]}</span>
					</label>
				{/each}
			</fieldset>
		</details>

		<ul class="rows" id="teams-rows">
			{#each shown as row (row.teamId)}
				<!-- The viewer's own row: a 2px `border-strong` left edge and
				     `— you` in place of the Manager name (DESIGN.md:185). No
				     fill, no accent bar — the 3px left bar belongs to
				     Minimum-Bid Contention and nothing may borrow it. The row
				     sits wherever the sort puts it. -->
				<li class="row" class:own={row.isViewer}>
					<a class="row-link" href={row.href}>
						<span class="team-identity"
							>{row.teamName}<span class="team-manager">{row.managerSuffix}</span></span
						>
					</a>

					<!-- Each slot sentence in TWO registers (DESIGN.md:183):
					     the count carries the information and reads first, the
					     `of 12` beside it is one step quieter. Both halves come
					     from the core — this file never searches a string for
					     ` of `. The whole sentence rides on `aria-label` so a
					     screen reader gets it unbroken.

					     PAIRED ACROSS, not stacked: the roster count with the
					     Outstanding Bids beside it, and the Minor League count
					     with Injury Reserve beside it, each pair read as one
					     phrase behind a `·` — `PersistentStrip.svelte`'s
					     construction, which is where a Manager has already
					     learnt to read `7 of 12 · 2 of 3`.
					     Six figures on six lines made one card most of a phone
					     screen tall, and thirty of them a scroll nobody finishes
					     — which on a surface whose whole job is comparing Teams
					     is the thing that breaks it. The pairing costs nothing
					     legibility can miss: each figure keeps its own
					     `aria-label`ed sentence and its own register, the `·`
					     between them is `aria-hidden` so neither sentence is
					     interrupted, and at a width where two would collide they
					     wrap and stack again. -->
					<div class="row-line">
						<p class="figure" aria-label={row.rosterCountHalves.full}>
							<span>{row.rosterCountHalves.lead}</span><span class="figure-qualifier"
								>{row.rosterCountHalves.qualifier}</span
							>
						</p>
						<!-- Outstanding Bids against the allowance, and open
						     lottery entries, as TWO figures and never one
						     (UX-DR36): an entry consumes no allowance, so a
						     combined figure would state a ceiling that does not
						     exist. That is why the entries figure keeps its OWN
						     line below rather than joining this pair — two bid
						     figures at the two ends of one line is the reading
						     UX-DR36 forbids, while the roster count opposite is
						     a different kind of thing entirely. Both come worded
						     from the core, in the same two registers as the slot
						     sentences above — this file words nothing and, at
						     parity, gives the figure no colour, badge or warning
						     treatment (UX-DR35).

						     Either may be ABSENT rather than zero, and the core
						     decides which: both go outside the Auction Phase,
						     when no Bid is accepted at any amount, and the
						     entries figure goes for a Team holding none, because
						     entries have no ceiling and a zero there states
						     nothing. The separator LEADS this figure rather than
						     trailing the roster count, which is what keeps a
						     single `·` between the pair whether or not this half
						     is present — the strip's own arrangement, for the
						     same reason. An absent Bids figure leaves the roster
						     count alone on the card's left margin, where it
						     already sits — nothing slides along to fill the
						     gap. -->
						{#if row.outstandingBidsHalves !== null}
							<span class="row-separator" aria-hidden="true">·</span>
							<p class="figure" aria-label={row.outstandingBidsHalves.full}>
								<span>{row.outstandingBidsHalves.lead}</span><span class="figure-qualifier"
									>{row.outstandingBidsHalves.qualifier}</span
								>
							</p>
						{/if}
					</div>
					{#if row.contentionEntriesHalves !== null}
						<p class="figure" aria-label={row.contentionEntriesHalves.full}>
							<span>{row.contentionEntriesHalves.lead}</span><span class="figure-qualifier"
								>{row.contentionEntriesHalves.qualifier}</span
							>
						</p>
					{/if}
					<div class="row-line">
						<p class="figure" aria-label={row.minorLeagueHalves.full}>
							<span>{row.minorLeagueHalves.lead}</span><span class="figure-qualifier"
								>{row.minorLeagueHalves.qualifier}</span
							>
						</p>
						<!-- Injury Reserve in `text-tertiary` and visibly outside
						     the twelve — the figure most often wrongly folded
						     into it. Beside the Minor League count now rather
						     than under it, and the quieter register is what keeps
						     the pairing from reading as one group of slots: the
						     two are set in two different colours and each states
						     its own ceiling. Its separator is unconditional
						     because, unlike the Bids figure above, this half is
						     never absent. -->
						<span class="row-separator" aria-hidden="true">·</span>
						<p class="figure-tertiary" aria-label={row.injuryReserveHalves.full}>
							<span>{row.injuryReserveHalves.lead}</span><span class="figure-qualifier"
								>{row.injuryReserveHalves.qualifier}</span
							>
						</p>
					</div>
					<!-- Dead Money, in the same quiet register and for the same
					     reason: money charged for Contracts the Team has
					     released, outside the twelve (FR-43). ABSENT rather
					     than zero for a Team carrying none — the core decides
					     which. A card lists no rows, so this line is the only
					     thing that reconciles a Cap Space reduced by players
					     who are not on the Team (UX-DR40). -->
					{#if row.deadMoneyHalves !== null}
						<p
							class="figure-tertiary"
							id={`teams-dead-money-${row.teamId}`}
							aria-label={row.deadMoneyHalves.full}
						>
							<span>{row.deadMoneyHalves.lead}</span><span class="figure-qualifier"
								>{row.deadMoneyHalves.qualifier}</span
							>
						</p>
					{/if}

					<div class="money">
						<div class="cell">
							<span class="section-label">{TEAM_VIEW_LABELS.capSpace}</span>
							<span class="figure">{row.capSpaceLabel}</span>
						</div>
						<div class="cell">
							<span class="section-label">{TEAM_VIEW_LABELS.committedBids}</span>
							<span class="figure">{row.committedBidsLabel}</span>
						</div>
						<div class="cell">
							<span class="section-label">{TEAM_VIEW_LABELS.availableCapSpace}</span>
							<span class="figure">{row.availableCapSpaceLabel}</span>
						</div>
					</div>

					<p class="figure-tertiary">{row.nominationSlotSentence}</p>
				</li>
			{/each}
		</ul>

		<!-- The median line at the foot, behind a `border-strong` rule
		     (DESIGN.md:189): labelled at 10px uppercase, its figures in
		     `text-secondary` at 15px, visually quieter than every row above
		     it. It is context, not a verdict, and nothing above is coloured,
		     badged or ordered by its relation to it. Each figure states the
		     count it actually covers. -->
		<section class="median" id="teams-median">
			<!-- Each figure is set in two registers — the label one step
			     quieter than the number — but the composed PHRASE is the
			     core's, and rides on `aria-label` so a screen reader gets it
			     unbroken rather than as two fragments. This file joins
			     nothing. -->
			<div class="cell">
				<span class="section-label"
					>{index.median.freeActiveBenchSlots.coverageSentence}</span
				>
				<p class="median-figure" aria-label={index.median.freeActiveBenchSlots.sentence}>
					<span class="median-label">{index.median.freeActiveBenchSlots.label}</span><span
						>{index.median.freeActiveBenchSlots.figure}</span
					>
				</p>
			</div>
			<div class="cell">
				<span class="section-label">{index.median.availableCapSpace.coverageSentence}</span>
				<p class="median-figure" aria-label={index.median.availableCapSpace.sentence}>
					<span class="median-label">{index.median.availableCapSpace.label}</span><span
						>{index.median.availableCapSpace.figure}</span
					>
				</p>
				<!-- The grid note is about the $500,000 MONEY grid, so it sits
				     inside the Available Cap Space cell and under no other. A
				     note after both cells would read as an explanation of the
				     free-Slot count too, which has no grid and no decimal. -->
				<p class="median-note">{index.median.gridNote}</p>
			</div>
		</section>
	{/if}
</main>

<style>
	.masthead {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
	}

	/*
	 * One column at every width. `EXPERIENCE.md` requires every Manager
	 * surface to be single-column at 375px with no lateral scrolling.
	 */
	.rows {
		display: flex;
		flex-direction: column;
		list-style: none;
		width: 100%;
	}

	/*
	 * Rows separated by a 1px `border` rule rather than by card gaps
	 * (DESIGN.md:179) — thirty cards at 8px apart is a scroll nobody
	 * finishes, and a ruled list reads as a table on a phone.
	 */
	/*
	 * **Every row reserves the own-row edge, and only the viewer's paints it.**
	 * A marker that added a border and a left padding to one row alone would
	 * inset that row by its own width, and on a ruled comparison list the
	 * marked Team's figures would then sit out of column with the other
	 * twenty-nine — working directly against the surface's whole job. So the
	 * edge and its padding are declared HERE, transparent, and `.own` changes
	 * nothing but the colour. Marking a row changes its appearance and never
	 * its layout.
	 */
	.row {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		padding: var(--space-row-gap) 0;
		padding-left: var(--space-row-gap);
		border-bottom: var(--border-width) solid var(--color-border);
		border-left: var(--own-row-edge-width) solid transparent;
	}

	/*
	 * The viewer's own row: the reserved edge, painted `border-strong`
	 * (DESIGN.md:185). Deliberately NOT `--accent-bar-width`, whose 3px belongs
	 * to Minimum-Bid Contention and which nothing else in the system may
	 * borrow; 2px stays clear of that device while still reading at a glance.
	 *
	 * ONE declaration, and it is a colour: no width, no padding, no fill, no
	 * text colour — so the row cannot move. `border-strong` against the rows'
	 * `border` is a step in the greyscale ramp rather than a hue, so the
	 * marker survives a greyscale screenshot exactly as it renders.
	 */
	.own {
		border-left-color: var(--color-border-strong);
	}

	.row-link {
		text-decoration: none;
	}

	/*
	 * `ui` at 15px, not Georgia (DESIGN.md:181). A fantasy Team is an entity,
	 * and setting it in the display face would put it in the same register as
	 * the players it competes for.
	 */
	.team-identity {
		font-family: var(--font-ui);
		font-size: var(--size-15);
		color: var(--color-text);
	}

	/*
	 * The Manager half — or `— you` in its place — one step quieter
	 * (DESIGN.md:187). EVERY Team name sits in `text`, the viewer's included:
	 * dimming twenty-nine names to make one stand out was drafted and rejected
	 * at the mock, and the left edge already carries the marker.
	 */
	.team-manager {
		color: var(--color-text-secondary);
	}

	/*
	 * A PAIR of figures read as one phrase behind a `·` —
	 * `PersistentStrip.svelte`'s own construction, which is where a Manager has
	 * already learnt to read `7 of 12 · 2 of 3`. The two halves were at
	 * opposite ends of the line for one revision, and split like that they read
	 * as two unrelated readouts that happened to share a row; the strip's
	 * answer is better and it is already built.
	 *
	 * `flex-start` rather than `space-between`, so the two stay together
	 * however short they are, and a pair whose trailing half is ABSENT leaves
	 * the leading one exactly where it already sits rather than sliding along
	 * the row. Every line of the card therefore starts on the same left margin
	 * — the Team name above and the Cap Space cells below share it, so the card
	 * reads as one block down one edge rather than two columns of text pulling
	 * apart. Stated rather than left to the default, because the whole point of
	 * this rule is WHICH edge the pair sits on.
	 *
	 * `--space-card-gap` is the strip's gap around its own separators, not this
	 * page's tighter row gap: the `·` needs air on both sides or it reads as
	 * punctuation inside one of the figures.
	 *
	 * Baseline-aligned, because the halves are set at different sizes — the
	 * 15px Minor League count against the 12.5px Injury Reserve — and centring
	 * would float the smaller one off the larger's baseline. Wrapping, so a
	 * width that genuinely cannot fit the pair stacks it instead of scrolling
	 * sideways.
	 */
	.row-line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: flex-start;
		gap: var(--space-card-gap);
	}

	/*
	 * `.strip-separator`'s own two declarations, so the dot between two figures
	 * is the same dot in both places it appears in the product. `aria-hidden`
	 * in the markup: each figure already rides on its own `aria-label`ed
	 * sentence, and a spoken "middle dot" between them is noise.
	 */
	.row-separator {
		font-size: var(--size-12);
		color: var(--color-text-tertiary);
	}

	.money {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-card-gap);
	}

	.cell {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	/*
	 * The controls are a plain wrapping row of radios at the touch floor, not
	 * a select — `board/+page.svelte`'s own block, copied because it is the
	 * built, tested and accessible precedent for "sorting is view state" being
	 * visible in the markup. The board's disclosure came with it, for the same
	 * reason: the radios are still radios, every choice visible at once with
	 * the one in force marked, once the row above is opened.
	 */
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		/*
		 * The two axes are NOT the same gap. Across, the gap is what keeps two
		 * choices from reading as one phrase. Down — which is what happens at
		 * 375px, where the choices stack — each already carries a touch-floor
		 * box, so a gap between two of them adds to slack that is there anyway
		 * and the stack drifts apart. The rows meet; their boxes do the
		 * spacing.
		 */
		column-gap: var(--space-row-gap);
		row-gap: 0;
		border: 0;
		padding: 0;
		margin: 0;
	}

	/*
	 * The closed row: the control's name, the order in force, and the mark
	 * that says there is more behind it.
	 *
	 * NO `--control-height` and no `--touch-min` — `board/+page.svelte`'s own
	 * call, for its own reason. A touch-floor box around a body-size line
	 * leaves most of its height empty above and below, which between the
	 * masthead and the first Team is a band of empty page.
	 *
	 * The target is not lost with it: the summary spans the full width, so the
	 * row is a wide target however short it is, and this is a control whose
	 * mis-tap costs nothing — it opens a list of radios, each of which keeps
	 * the floor on its own row. The floor stays, untouched, on every control
	 * that spends something.
	 */
	.controls-disclosure > summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-row-gap);
		cursor: pointer;
		/* The mark below carries the affordance; the default triangle beside
		   it would be two of them stacked. */
		list-style: none;
	}

	.controls-disclosure > summary::-webkit-details-marker {
		display: none;
	}

	.controls-disclosure > summary:focus-visible {
		outline: 2px solid var(--color-text);
		outline-offset: 2px;
	}

	/*
	 * The order in force, set at the body size against the small uppercase
	 * label beside it: the LABEL says which control this is and the value is
	 * the thing being read, so the value is the one that carries the weight.
	 */
	.controls-current {
		color: var(--color-text);
	}

	/*
	 * The chevron, pushed to the trailing edge, drawn in `em` off the summary's
	 * own font and stroked from `currentColor` — the board's construction,
	 * character for character, so every disclosure in this codebase carries
	 * one affordance rather than three.
	 */
	.controls-mark {
		display: flex;
		flex-shrink: 0;
		margin-left: auto;
		color: var(--color-text-tertiary);
	}

	.controls-mark svg {
		width: 1.1em;
		height: 1.1em;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
		fill: none;
	}

	/* Open or closed, the same mark; it turns to point at what it opened. */
	.controls-disclosure[open] > summary .controls-mark {
		color: var(--color-text);
		transform: rotate(180deg);
	}

	/*
	 * Open, the row needs no margin of its own: the first radio below it
	 * carries a full touch-floor box, which is already more separation than a
	 * gap would add.
	 */
	.controls-disclosure[open] > .controls {
		margin-bottom: calc(-1 * var(--space-row-gap));
	}

	.choice {
		display: flex;
		align-items: center;
		gap: var(--space-row-gap);
		min-height: var(--touch-min);
	}

	/* `board/+page.svelte:449-453`'s own sizing, character for character, so
	   the two sort controls in this product are one control. */
	.choice input[type='radio'] {
		width: 22px;
		height: 22px;
		accent-color: var(--color-border-interactive);
	}

	/*
	 * Figures in `ui` `tabular-nums` at 15px, under the 10px uppercase section
	 * labels the rest of the product already uses (DESIGN.md:183).
	 */
	.figure {
		font-family: var(--font-ui);
		font-size: var(--size-15);
		font-variant-numeric: var(--numerals);
		color: var(--color-text);
	}

	/*
	 * The ceiling half of a slot sentence — `of 12`, `of 3` — one step quieter
	 * than the count beside it (DESIGN.md:183), so the number carrying the
	 * information reads first. It inherits size and face from the element it
	 * sits inside; only the colour steps back.
	 */
	.figure-qualifier {
		color: var(--color-text-secondary);
	}

	/*
	 * Injury Reserve and the Nomination Slot line: `text-tertiary`, outside
	 * the slot group above them.
	 */
	.figure-tertiary {
		font-family: var(--font-ui);
		font-size: var(--size-12-5);
		font-variant-numeric: var(--numerals);
		color: var(--color-text-tertiary);
	}

	/*
	 * The median line at the foot, behind a `border-strong` rule
	 * (DESIGN.md:189). It is context, not a verdict.
	 */
	.median {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		padding-top: var(--space-panel-padding);
		border-top: var(--border-width) solid var(--color-border-strong);
	}

	/*
	 * Quieter than every row above it: `text-secondary` at 15px against the
	 * rows' `text`, which is the whole of how the foot reads as context. The
	 * distinction is a step in the greyscale ramp, not a hue.
	 */
	.median-figure {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-row-gap);
		font-family: var(--font-ui);
		font-size: var(--size-15);
		font-variant-numeric: var(--numerals);
		color: var(--color-text-secondary);
	}

	/*
	 * The median's label half, one step quieter than its figure — the row's
	 * own count/ceiling arrangement, pointed the other way: here the FIGURE
	 * carries the information and the label reads second.
	 */
	.median-label {
		color: var(--color-text-tertiary);
	}

	.median-note {
		font-size: var(--size-11);
		color: var(--color-text-tertiary);
	}

	.when {
		color: var(--color-text-tertiary);
		font-size: var(--size-12-5);
	}
</style>
