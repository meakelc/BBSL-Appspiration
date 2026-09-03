<script lang="ts">
	// The Bid Board (Story 4.3).
	//
	// One scrollable list of every open Auction, each card carrying Player
	// identity, price, Leading Bidder, Auction state, the viewer's own
	// relation to it, and time shown TWICE — relative and absolute in the
	// viewer's own timezone.
	//
	// **No wording of its own.** Every label, every icon, every sentence and
	// every ordering rule arrives from `$lib/core/board.ts`, so each has
	// exactly one definition in the codebase and a synonym cannot appear in
	// markup. What this file holds is structure and CSS.
	//
	// **Sorting and filtering are VIEW STATE and never change a figure.** They
	// are two runes over a list the server transported as facts; no price, no
	// count and no time on any card is recomputed when either changes. A
	// filtered view is visibly filtered and states its own count.
	//
	// **No urgency device anywhere.** No "ending soon", no reddening or
	// pulsing clock, no one-tap raise, no suggested amount, no ranking of what
	// is worth bidding on. The countdown is one plain phrase.
	//
	// **The countdown derives from the server-authoritative `closesAt`**, plus
	// the elapsed time this device has measured since the server's own instant
	// — the anchor the Auction page establishes, for its reason: a device
	// three hours fast must cross a close at the same real moment a correct
	// one does. Countdowns are exempt from freshness (AD-29), so nothing here
	// freezes on a disconnect.
	//
	// Types are declared structurally rather than imported from a server-only
	// module — the rule `nominate/+page.svelte` states and every page since
	// follows. `$lib/core` is a different matter: it is the pure core, it is
	// what AD-2 says both runtimes load, and the helpers below are the same
	// ones the server calls.
	import {
		ARCHIVED_EMPTY_BOARD_HEADING,
		ARCHIVED_EMPTY_BOARD_STATEMENT,
		BOARD_CLOSES_LABEL,
		BOARD_FILTER_LEGEND,
		BOARD_LEADING_LABEL,
		BOARD_NOMINATED_LABEL,
		BOARD_PRICE_LABEL,
		BOARD_SORT_LEGEND,
		BOARD_TITLE,
		DEFAULT_FILTER,
		DEFAULT_SORT,
		EMPTY_BOARD_ACTION,
		EMPTY_BOARD_HEADING,
		EMPTY_BOARD_STATEMENT,
		FILTER_KEYS,
		FILTER_LABELS,
		SORT_KEYS,
		SORT_LABELS,
		boardCountSentence,
		filterBoard,
		filteredNoticeSentence,
		sortBoard,
		unbidPhrase
	} from '$lib/core/board.ts';
	import type { BoardFilter, BoardSort, BoardViewerState } from '$lib/core/board.ts';
	// The Auction deep-link shape is written ONCE, in the core, so `/board`,
	// `/positions` and Story 5.3's Discord notification all emit one shape.
	import { auctionPathFor } from '$lib/core/auction-link.ts';
	import {
		CONTENTION_CLOCK_UNMOVED,
		closesInPhrase,
		contenderCountSentence
	} from '$lib/core/projection/auctions.ts';
	import type { ContentionState } from '$lib/core/projection/auctions.ts';
	import { figuresAgeSentence } from '$lib/core/freshness.ts';
	import { freshness } from '$lib/client/freshness.svelte.ts';
	import { formatInstant, parseInstant } from '$lib/core/instant.ts';

	import type { PageData } from './$types';

	type BoardCardView = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly metadata: string | null;
		readonly price: number | null;
		readonly priceLabel: string;
		readonly leadingBidder: string;
		readonly closesAt: string | null;
		readonly auctionStateLabel: string;
		readonly auctionStateIcon: string;
		readonly contention: ContentionState;
		readonly contenderCount: number;
		readonly viewerState: BoardViewerState;
		readonly viewerStateLabel: string;
		readonly viewerStateIcon: string;
		readonly nominatedBy: string;
		readonly nominatedAt: string;
	};

	type Board = {
		readonly cards: readonly BoardCardView[];
		readonly figuresAt: string;
		readonly viewerTeamId: string | null;
	};

	let { data }: { data: PageData } = $props();

	const board = $derived(data.board as Board);

	/**
	 * The two pieces of view state, and they are the whole of it. Neither
	 * touches the server, and neither can change a figure on a card: the sort
	 * reorders the list and the filter narrows it.
	 */
	let sort = $state<BoardSort>(DEFAULT_SORT);
	let filter = $state<BoardFilter>(DEFAULT_FILTER);

	/**
	 * How often the page re-reads its own elapsed time. A named constant, and
	 * a plain interval — no backoff, no visibility heuristic and no network of
	 * any kind: this tick touches nothing but a number in this component.
	 */
	const TICK_MS = 1000;

	/**
	 * Milliseconds measured on this device since the first paint. A DELTA,
	 * never an origin — it starts at zero, which is what makes the
	 * server-rendered HTML and the first client paint agree, and it is clamped
	 * so a backward system-clock adjustment can never pull this page's instant
	 * behind the server's anchor.
	 */
	let elapsedMs = $state(0);

	/**
	 * The instant every phrase on this page reads.
	 *
	 * The ORIGIN is the server's — `board.figuresAt` is the database clock,
	 * read once by the read path — and only the elapsed time is local. A
	 * skewed device therefore crosses every close at the same real moment a
	 * correct one does, because its own wall clock never enters the sum
	 * (AD-3).
	 */
	const nowIso = $derived.by(() => {
		const anchor = parseInstant(board.figuresAt);
		if (anchor === null) return board.figuresAt;
		return formatInstant(anchor + elapsedMs);
	});

	// Client-only, because `$effect` never runs during SSR, and cleaned up by
	// the function it returns. `board.figuresAt` is read for its DEPENDENCY:
	// any reload hands over a fresh server instant and the elapsed count has
	// to restart with it, or the new origin would be added to the old device
	// measurement and this page would run ahead of the server.
	$effect(() => {
		void board.figuresAt;
		elapsedMs = 0;
		const startedAt = Date.now();
		const ticking = setInterval(() => {
			elapsedMs = Math.max(0, Date.now() - startedAt);
		}, TICK_MS);
		return () => {
			clearInterval(ticking);
		};
	});

	/**
	 * The list as it is read: filtered, then ordered.
	 *
	 * Both are the core's own functions — the comparator that makes every sort
	 * total and tie-break on the Player name lives beside the fold rules, not
	 * here, so a list re-derived on every projection change cannot visibly
	 * reshuffle while a Manager is reading it.
	 */
	const shown = $derived(sortBoard(filterBoard(board.cards, filter), sort, nowIso));

	/** How many Auctions are open — the WHOLE board, never the filtered view. */
	const countSentence = $derived(boardCountSentence(board.cards.length));

	/** What the filter is hiding, or `null` for the unfiltered view. */
	const filteredNotice = $derived(
		filteredNoticeSentence(filter, shown.length, board.cards.length)
	);

	/**
	 * The age of every price on this board, in anything but Live (AD-29).
	 *
	 * The board renders up to thirty prices and authorises nothing — there is
	 * no bid control here, so the "disable the control" half of AD-29's
	 * obligation has nothing to disable and the "carry the age" half is the
	 * whole of what applies. **Countdowns stay exempt**: they derive from
	 * absolute close timestamps this page already holds, so they keep running.
	 *
	 * ONE line for the page rather than one per card: every card came from a
	 * single transaction anchored on a single `figuresAt`, so thirty stamps
	 * would repeat one fact thirty times and read as urgency on a surface that
	 * refuses it. The sentence is the core's, shared with the strip and the
	 * notice, so an age is worded once in this codebase.
	 */
	const figuresAge = $derived(
		freshness.state === 'live'
			? null
			: figuresAgeSentence(freshness.lastLivenessOkAt, freshness.now)
	);

	/**
	 * The absolute stamps, computed in an `$effect` and therefore only in the
	 * browser — the SSR-leak rule the Auction page establishes.
	 * `Intl.DateTimeFormat(undefined, ...)` resolves `undefined` to the
	 * timezone of whatever machine formats it, so deriving these during SSR
	 * would ship the SERVER's timezone in the delivered HTML, which Svelte
	 * does not diff-correct on hydration. The markup omits a stamp until it
	 * exists rather than rendering one that is wrong for a paint.
	 *
	 * Keyed on the Player id, so a re-sort cannot hand a card another card's
	 * stamp.
	 */
	let closesAtAbsolute = $state<Record<string, string>>({});
	let nominatedAbsolute = $state<Record<string, string>>({});

	// `Intl.DateTimeFormat.format` throws `RangeError` on an Invalid Date, so
	// an unreadable instant is checked for rather than formatted — the pure
	// phrase helpers beside it return a stated phrase for the same input, and
	// that is only honest if this cannot crash the page.
	function formatAbsolute(iso: string): string {
		const parsed = new Date(iso);
		if (Number.isNaN(parsed.getTime())) return 'at an unknown time';
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(parsed);
	}

	$effect(() => {
		const closes: Record<string, string> = {};
		const nominated: Record<string, string> = {};
		for (const card of board.cards) {
			if (card.closesAt !== null) closes[card.fantraxPlayerId] = formatAbsolute(card.closesAt);
			nominated[card.fantraxPlayerId] = formatAbsolute(card.nominatedAt);
		}
		closesAtAbsolute = closes;
		nominatedAbsolute = nominated;
	});
</script>

<svelte:head>
	<title>{BOARD_TITLE} — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1 class="display">{BOARD_TITLE}</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	<section class="panel">
		<p class="section-label">Phase</p>
		<p class="prose">{data.phase.sentence}</p>
	</section>

	{#if board.cards.length === 0}
		<!-- The designed empty screen, not an edge case: it explains the state
		     and points at Nominate, which is the act that fills the board.
		     Every word is the core's.

		     Phase-aware, because the board is live in TWO phases and the act
		     only exists in one: `nominate` is absent from the Archived
		     catalog, so offering it there would hand a Manager a link that
		     answers with the guard's 403. A frozen empty board states what
		     happened and offers nothing. -->
		{#if data.phase.name === 'Archived'}
			<section class="panel" id="board-empty">
				<h2 class="display" id="board-empty-heading">{ARCHIVED_EMPTY_BOARD_HEADING}</h2>
				<p class="prose" id="board-empty-statement">{ARCHIVED_EMPTY_BOARD_STATEMENT}</p>
			</section>
		{:else}
			<section class="panel" id="board-empty">
				<h2 class="display" id="board-empty-heading">{EMPTY_BOARD_HEADING}</h2>
				<p class="prose" id="board-empty-statement">{EMPTY_BOARD_STATEMENT}</p>
				<p class="prose"><a href="/nominate" id="board-empty-action">{EMPTY_BOARD_ACTION}</a></p>
			</section>
		{/if}
	{:else}
		<section class="panel">
			<p class="section-label">Open Auctions</p>
			<p class="prose" id="board-count">{countSentence}</p>

			<!-- Every price on this board carries its age in anything but Live
			     (AD-29). The countdowns are exempt and keep running; the
			     figures are what cannot be confirmed. -->
			{#if figuresAge !== null}
				<p class="prose" id="board-figures-age">{figuresAge}</p>
			{/if}

			<!-- Sorting and filtering are view state. Neither posts anything,
			     neither reloads anything, and neither changes a figure on a
			     card — the list is reordered and narrowed, and nothing else. -->
			<fieldset class="controls">
				<legend class="section-label">{BOARD_SORT_LEGEND}</legend>
				{#each SORT_KEYS as key (key)}
					<label class="choice" for={`board-sort-${key}`}>
						<input
							id={`board-sort-${key}`}
							type="radio"
							name="board-sort"
							value={key}
							bind:group={sort}
						/>
						<span class="prose">{SORT_LABELS[key]}</span>
					</label>
				{/each}
			</fieldset>

			<fieldset class="controls">
				<legend class="section-label">{BOARD_FILTER_LEGEND}</legend>
				{#each FILTER_KEYS as key (key)}
					<label class="choice" for={`board-filter-${key}`}>
						<input
							id={`board-filter-${key}`}
							type="radio"
							name="board-filter"
							value={key}
							bind:group={filter}
						/>
						<span class="prose">{FILTER_LABELS[key]}</span>
					</label>
				{/each}
			</fieldset>

			<!-- A filtered view is VISIBLY filtered and states its own count, so
			     a short board is never mistaken for a quiet league. -->
			{#if filteredNotice !== null}
				<p class="prose" id="board-filtered-notice">{filteredNotice}</p>
			{/if}
		</section>

		<ul class="board" id="board-cards">
			{#each shown as card (card.fantraxPlayerId)}
				<!-- The 3px `lottery` left bar marks a Minimum-Bid Contention and
				     nothing else in the system. It never carries the state ALONE:
				     the icon and the word beside it are what make a greyscale
				     screenshot read identically. -->
				<li class="card" class:lottery={card.contention === 'minimum_bid'}>
					<a class="card-link" href={auctionPathFor(card.fantraxPlayerId)}>
						<span class="display card-player">{card.playerName}</span>
					</a>
					{#if card.metadata !== null}
						<p class="card-metadata">{card.metadata}</p>
					{/if}

					<p class="section-label">{BOARD_PRICE_LABEL}</p>
					<p class="card-price" class:card-price-absent={card.price === null}>
						{card.priceLabel}
					</p>

					<!-- Every state carries an ICON and a WORD, never colour
					     alone. The CHIP, though, is reserved for the two states
					     DESIGN.md:194 gives one to: filled `attention` for
					     Outbid, outlined `border-strong` for You lead. Ambient
					     states — Open, Awaiting Opening Bid, Contender and Not
					     involved — take a plain `text-secondary` label and no
					     chip, so the chip keeps meaning "this one concerns
					     you" rather than decorating every line on the card. -->
					<p class="state state-ambient">
						<span class="chip-icon" aria-hidden="true">{card.auctionStateIcon}</span>
						<span class="chip-word">{card.auctionStateLabel}</span>
					</p>
					<p
						class="state"
						class:chip={card.viewerState === 'you_lead' || card.viewerState === 'outbid'}
						class:chip-lead={card.viewerState === 'you_lead'}
						class:chip-outbid={card.viewerState === 'outbid'}
						class:state-ambient={card.viewerState !== 'you_lead' &&
							card.viewerState !== 'outbid'}
					>
						<span class="chip-icon" aria-hidden="true">{card.viewerStateIcon}</span>
						<span class="chip-word">{card.viewerStateLabel}</span>
					</p>

					{#if card.contention === 'minimum_bid'}
						<!-- The Contender count and the statement that joining does
						     not move the clock, both the fold's own sentences. -->
						<p class="prose">{contenderCountSentence(card.contenderCount)}</p>
						<p class="prose">{CONTENTION_CLOCK_UNMOVED}</p>
					{/if}

					<p class="section-label">{BOARD_LEADING_LABEL}</p>
					<p class="prose card-leader">{card.leadingBidder}</p>

					<p class="section-label">{BOARD_NOMINATED_LABEL}</p>
					<p class="prose">{card.nominatedBy}</p>

					{#if card.closesAt === null}
						<!-- No clock at all: no Opening Bid has started one. What
						     the card states instead is how long the nomination has
						     stood unbid, from the core's own phrase. -->
						<p class="card-when">{unbidPhrase(card.nominatedAt, nowIso)}</p>
						<p class="card-when">
							{#if nominatedAbsolute[card.fantraxPlayerId] !== undefined}
								{nominatedAbsolute[card.fantraxPlayerId]}
							{/if}
						</p>
					{:else}
						<p class="section-label">{BOARD_CLOSES_LABEL}</p>
						<!-- Time TWICE: the relative phrase, and the absolute stamp
						     in the viewer's own timezone. The absolute is never
						     dropped to save space. -->
						<p class="card-when">{closesInPhrase(card.closesAt, nowIso)}</p>
						<p class="card-when">
							{#if closesAtAbsolute[card.fantraxPlayerId] !== undefined}
								{closesAtAbsolute[card.fantraxPlayerId]}
							{/if}
						</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
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
	 * The controls are a plain wrapping row of radios at the touch floor, not
	 * a select: three choices each, and a native menu would hide the current
	 * view behind a tap on the one surface whose view state must be obvious.
	 */
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-row-gap);
		border: 0;
		padding: 0;
		margin: 0;
	}

	.choice {
		display: flex;
		align-items: center;
		gap: var(--space-row-gap);
		min-height: var(--touch-min);
	}

	.choice input[type='radio'] {
		width: 22px;
		height: 22px;
		accent-color: var(--color-border-interactive);
	}

	/*
	 * One column at every width. `EXPERIENCE.md` requires every Manager
	 * surface to be single-column at 375px with no lateral scrolling, and a
	 * board of cards has no second axis to gain from a wider one.
	 */
	.board {
		display: flex;
		flex-direction: column;
		gap: var(--space-card-gap);
		list-style: none;
		width: 100%;
	}

	.card {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		background-color: var(--color-surface);
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--rounded-panel);
		padding: var(--space-panel-padding);
	}

	/*
	 * The 3px left accent bar marking a Minimum-Bid Contention — the one
	 * structural exception in the design, and no other element on any surface
	 * may borrow the device. It never carries the state alone.
	 */
	.card.lottery {
		border-left: var(--accent-bar-width) solid var(--color-lottery);
	}

	.card-link {
		color: var(--color-text);
		text-decoration: none;
	}

	.card-player {
		font-size: var(--size-18);
		color: var(--color-text);
	}

	.card-metadata {
		color: var(--color-text-secondary);
		font-size: var(--size-12);
	}

	.card-price {
		font-family: var(--font-ui);
		font-size: var(--size-26);
		font-variant-numeric: var(--numerals);
		letter-spacing: -0.025em;
		color: var(--color-text);
	}

	/*
	 * "No opening bid" is a statement, not a figure, so it is not rendered at
	 * the price's own weight — `text-tertiary` at the body size, which is what
	 * distinguishes an absent price from a small one.
	 */
	.card-price-absent {
		font-size: var(--size-12-5);
		color: var(--color-text-tertiary);
	}

	.card-leader {
		color: var(--color-text-secondary);
	}

	.card-when {
		color: var(--color-text-tertiary);
		font-size: var(--size-12-5);
	}

	/*
	 * A state line is an icon and a word together, always — that pairing is
	 * what makes a greyscale screenshot read, and it is unconditional.
	 *
	 * `.state` is the shared layout; `.state-ambient` is the plain
	 * `text-secondary` label DESIGN.md:194 specifies for the ambient states,
	 * and it carries no fill, no outline and no padding. `.chip` is added on
	 * top for the two states that earn one.
	 */
	.state {
		display: flex;
		align-items: center;
		gap: var(--space-row-gap);
		align-self: flex-start;
		font-size: var(--size-12-5);
		border-radius: var(--rounded-chip);
	}

	.state-ambient {
		color: var(--color-text-secondary);
	}

	.chip {
		padding: 2px var(--space-row-gap);
	}

	.chip-icon {
		font-size: var(--size-12-5);
	}

	/* Outlined, never filled: leading is a standing fact, not an alert. */
	.chip-lead {
		border: var(--border-width) solid var(--color-border-strong);
		color: var(--color-text);
	}

	/*
	 * The one attention colour in the product, marking Outbid and nothing
	 * else. Filled, because it is the one state on this surface that is about
	 * the reader rather than about the Auction.
	 */
	.chip-outbid {
		background-color: var(--color-attention);
		color: var(--color-attention-ink);
	}
</style>
