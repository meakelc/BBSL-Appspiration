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
		BOARD_CLOSED_AT_LABEL,
		BOARD_CLOSES_LABEL,
		BOARD_FILTER_LEGEND,
		BOARD_FINAL_LABEL,
		BOARD_LEADING_LABEL,
		BOARD_NOMINATED_LABEL,
		BOARD_NOMINATED_LABEL_NARROW,
		BOARD_PANEL_HEADING,
		BOARD_PRICE_LABEL,
		BOARD_SORT_LEGEND,
		BOARD_TITLE,
		BOARD_WON_BY_LABEL,
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
		openCardCount,
		sortBoard,
		unbidPhrase
	} from '$lib/core/board.ts';
	import type {
		BoardCardState,
		BoardFilter,
		BoardSort,
		BoardViewerState
	} from '$lib/core/board.ts';
	// The Auction deep-link shape is written ONCE, in the core, so `/board`,
	// `/positions` and Story 5.3's Discord notification all emit one shape.
	import { auctionPathFor } from '$lib/core/auction-link.ts';
	import { closesInPhrase, contenderCountSentence } from '$lib/core/projection/auctions.ts';
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
		readonly auctionStateLabelNarrow: string;
		readonly auctionStateIcon: string;
		readonly state: BoardCardState;
		readonly contenderCount: number;
		readonly viewerState: BoardViewerState;
		readonly viewerStateLabel: string;
		readonly viewerStateIcon: string;
		// Both `null` on a closed card: the close deleted the nomination, so
		// there is no nominating Team and no nominated instant to render.
		readonly nominatedBy: string | null;
		readonly nominatedAt: string | null;
		// The three a closed card carries and an open one does not, all
		// pre-worded by the core exactly as every other field here is.
		readonly wonBy: string | null;
		readonly closedAt: string | null;
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
	 * Whether either control is showing its choices. Presentation only — a
	 * disclosure's own open flag, and the one thing on this page that is
	 * neither a figure nor a view of one. Both start CLOSED: the board is what
	 * the board's first screen is for, and the closed row still states which
	 * sort and which filter are in force.
	 */
	let sortOpen = $state(false);
	let filterOpen = $state(false);

	/**
	 * How often the page re-reads its own elapsed time. A named constant, and
	 * a plain interval — no backoff, no visibility heuristic and no network of
	 * any kind: this tick touches nothing but a number in this component.
	 */
	const TICK_MS = 1000;

	/**
	 * How long a Player's name may be before it is set a step down the scale.
	 *
	 * `Giannis Antetokounmpo` at `--size-18` takes the whole identity row on a
	 * 375px phone and pushes the Auction state onto a line of its own, which
	 * costs the card a row and breaks the alignment of every state word down
	 * the board. Above this length the name takes `--size-15` — the adjacent
	 * step, so the card still sets its name from the same ten-step scale as
	 * everything else on it.
	 *
	 * A LENGTH, not a viewport: the name is the one thing on this card that may
	 * never be truncated, and the longest names are long at every width. The
	 * threshold is a presentation measure and lives here rather than in
	 * `board.ts`, which owns what a card SAYS and not how wide it sets.
	 */
	const LONG_NAME_LENGTH = 18;

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

	/**
	 * How many Auctions are OPEN — the whole board, never the filtered view,
	 * and never the closed cards either.
	 *
	 * The sentence says "are open", so the figure has to be the open ones. The
	 * count is the core's, not a `filter` written here: the surface prints
	 * fields and words nothing, and that includes counting nothing.
	 */
	const countSentence = $derived(boardCountSentence(openCardCount(board.cards)));

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
	let closedAtAbsolute = $state<Record<string, string>>({});

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
		const closed: Record<string, string> = {};
		for (const card of board.cards) {
			if (card.closesAt !== null) closes[card.fantraxPlayerId] = formatAbsolute(card.closesAt);
			if (card.nominatedAt !== null) {
				nominated[card.fantraxPlayerId] = formatAbsolute(card.nominatedAt);
			}
			if (card.closedAt !== null) closed[card.fantraxPlayerId] = formatAbsolute(card.closedAt);
		}
		closesAtAbsolute = closes;
		nominatedAbsolute = nominated;
		closedAtAbsolute = closed;
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
			<p class="section-label">{BOARD_PANEL_HEADING}</p>
			<p class="prose" id="board-count">{countSentence}</p>

			<!-- Every price on this board carries its age in anything but Live
			     (AD-29). The countdowns are exempt and keep running; the
			     figures are what cannot be confirmed. -->
			{#if figuresAge !== null}
				<p class="prose" id="board-figures-age">{figuresAge}</p>
			{/if}

			<!-- Sorting and filtering are view state. Neither posts anything,
			     neither reloads anything, and neither changes a figure on a
			     card — the list is reordered and narrowed, and nothing else.

			     Both are CLOSED by default and each states its own current
			     view on the closed row: the board's first screen is the board,
			     not eight radios above it, and what a Manager needs to know
			     without opening anything is which view they are looking at.
			     The choices appear on a tap and the row that opened them keeps
			     saying what is chosen, so the answer is never hidden by the
			     control that holds it.

			     `<details>`/`<summary>` and no script beyond the two flags:
			     the disclosure opens on tap AND on Enter and is announced as
			     expanded or collapsed, the same pattern `/nominate` already
			     uses. Choosing closes it, because the choice is the whole
			     reason it was opened and the list beneath is what the Manager
			     came to read. -->
			<details class="controls-disclosure" bind:open={sortOpen}>
				<summary>
					<span class="section-label">{BOARD_SORT_LEGEND}</span>
					<span class="prose controls-current">{SORT_LABELS[sort]}</span>
					<span class="controls-mark" aria-hidden="true">
						<svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
							<path d="M4 6.5 8 10.5 12 6.5" />
						</svg>
					</span>
				</summary>
				<fieldset class="controls">
					<!-- The legend still names the group for a screen reader
					     reading the radios; the summary above is what names it
					     on screen, and two visible copies would be the control
					     titled twice. -->
					<legend class="visually-hidden">{BOARD_SORT_LEGEND}</legend>
					{#each SORT_KEYS as key (key)}
						<label class="choice" for={`board-sort-${key}`}>
							<input
								id={`board-sort-${key}`}
								type="radio"
								name="board-sort"
								value={key}
								bind:group={sort}
								onchange={() => (sortOpen = false)}
							/>
							<span class="prose">{SORT_LABELS[key]}</span>
						</label>
					{/each}
				</fieldset>
			</details>

			<details class="controls-disclosure" bind:open={filterOpen}>
				<summary>
					<span class="section-label">{BOARD_FILTER_LEGEND}</span>
					<span class="prose controls-current">{FILTER_LABELS[filter]}</span>
					<span class="controls-mark" aria-hidden="true">
						<svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
							<path d="M4 6.5 8 10.5 12 6.5" />
						</svg>
					</span>
				</summary>
				<fieldset class="controls">
					<legend class="visually-hidden">{BOARD_FILTER_LEGEND}</legend>
					{#each FILTER_KEYS as key (key)}
						<label class="choice" for={`board-filter-${key}`}>
							<input
								id={`board-filter-${key}`}
								type="radio"
								name="board-filter"
								value={key}
								bind:group={filter}
								onchange={() => (filterOpen = false)}
							/>
							<span class="prose">{FILTER_LABELS[key]}</span>
						</label>
					{/each}
				</fieldset>
			</details>

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
				<!-- The pale green left edge marks an Auction THIS reader leads, and
				     only this reader: `viewerState` is computed for the signed-in
				     Manager, so nobody else's board shows it. Like the lottery bar it
				     never carries the state alone — the filled `LEADING` chip on the
				     figure row below carries the icon and the word. A card that is
				     both leading and in a Minimum-Bid Contention shows the lottery
				     bar: that 3px device is exclusive, and the chip still says the
				     reader leads. -->
				<li
					class="card"
					class:closed={card.state === 'closed'}
					class:leading={card.viewerState === 'you_lead'}
					class:lottery={card.state === 'minimum_bid'}
				>
					<!-- ROW 1 — identity and the Auction's own state.
					     The name, the NBA team and position beside it, and the state
					     word pushed to the far edge. The metadata is not a fact owed a
					     line of its own, and the Auction state describes the same
					     Player the name does; a card that gave each its own row cost
					     vertical space a board of thirty cannot spare. It WRAPS rather
					     than truncates — a long name takes a second line and the rest
					     follows it, because a Player's name is the one thing on this
					     card that may never be cut off. -->
					<div class="card-head">
						<a class="card-link" href={auctionPathFor(card.fantraxPlayerId)}>
							<span
								class="display card-player"
								class:card-player-long={card.playerName.length > LONG_NAME_LENGTH}
								>{card.playerName}</span
							>
						</a>
						{#if card.metadata !== null}
							<span class="card-metadata">{card.metadata}</span>
						{/if}
						<!-- Every state carries an ICON and a WORD, never colour alone.
						     The Auction state is never a chip: it describes the Auction,
						     not the reader. -->
						<!-- The state's name TWICE, one of them displayed: `Minimum
						     Lottery` set at `--size-10` beside a Player's name still
						     wraps this row on a phone, and a wrapped identity row is
						     what the short name exists to prevent.

						     Two spans rather than one string chosen in script, because
						     the choice is a VIEWPORT question and CSS is what can see a
						     viewport — a `matchMedia` here would re-answer it on every
						     resize, and answer it wrong for one paint during SSR.
						     Whichever span is `display: none` is not announced either,
						     so a screen reader reads exactly the name that is on
						     screen. Both spellings are the core's. -->
						<p class="state state-ambient card-state">
							<span class="chip-icon" aria-hidden="true">{card.auctionStateIcon}</span>
							<span class="chip-word chip-word-narrow">{card.auctionStateLabelNarrow}</span>
							<span class="chip-word chip-word-wide">{card.auctionStateLabel}</span>
						</p>
					</div>

					{#if card.state === 'closed'}
						<!-- THE CLOSED CARD — one row, two columns. `EXPERIENCE.md:168`
						     asks a Closed state for the winner, the final amount and the
						     Slot placement, and this row carries all three: the two
						     labelled lines stacked at the leading edge, the final amount
						     opposite them at the trailing edge.

						     The figure moves to the RIGHT rather than sitting above,
						     because a closed Auction is read as a record and not as a
						     price to act on — and because the two lines it now sits
						     beside rise into the space it vacated, which is what takes
						     three rows down to one. A board mixing open and closed cards
						     is then legible by SHAPE before any word on it is read.

						     There is NO countdown and no clock: the Auction is over, and
						     a timer on it would be an urgency device pointed at nothing.
						     There is no "Nominated by" either — `nominationsReducer`
						     deletes the nomination at the close, so the nominating Team
						     is not durable and must not be invented. And nothing here
						     congratulates: a win is stated. -->
						<div class="card-closed">
							<div class="card-closed-facts">
								<p class="card-leader">
									<span class="section-label">{BOARD_WON_BY_LABEL}</span>
									{card.wonBy}
								</p>
								<!-- The closed instant in the viewer's own timezone.
								     Labelled, because a bare date on a card carrying no
								     clock names nothing. -->
								<p class="card-when">
									{#if closedAtAbsolute[card.fantraxPlayerId] !== undefined}
										<span class="section-label">{BOARD_CLOSED_AT_LABEL}</span>
										{closedAtAbsolute[card.fantraxPlayerId]}
									{/if}
								</p>
							</div>
							<!-- The figure and, under it, the viewer's own relation to the
							     close. `won` and `not_involved` are the only two a closed
							     card can carry, and neither earns a chip: the one that
							     prints is ambient, the other prints nothing. -->
							<div class="card-closed-figure">
								<!-- No absent treatment here: a closed Auction's price is the
								     Contract's own winning amount, which is never null. The
								     unbid nomination below is the ONE place a null price is
								     drawn. -->
								<p class="card-price">
									<span class="visually-hidden">{BOARD_FINAL_LABEL}</span>
									{card.priceLabel}
								</p>
								{#if card.viewerState !== 'not_involved'}
									<p class="state state-ambient">
										<span class="chip-icon" aria-hidden="true">{card.viewerStateIcon}</span>
										<span class="chip-word">{card.viewerStateLabel}</span>
									</p>
								{/if}
							</div>
						</div>
					{:else}
						<!-- ROW 2 — the price, with the viewer's own state opposite it.
						     The four `section-label` rows this card used to carry are gone:
						     DESIGN.md's Board card names no labels, and the price figure, a
						     spelled-out Team and a countdown identify themselves by
						     typography and position. The WORDS are not gone — each is still
						     the core's own constant, rendered for a screen reader, so a
						     value is never announced without its name.

						     The CHIP is reserved for the two states DESIGN.md:194 gives one
						     to: filled `attention` for Outbid, filled `leading` for
						     Leading. Contender is ambient — a plain `text-secondary` label,
						     no chip. `not_involved` prints NOTHING at all: it is the state
						     of most cards on most boards, and a marker on every one of them
						     is a row of noise saying the reader has nothing to do here,
						     which the absence of a marker already says. -->
						<div class="card-figure">
							<!-- One figure, two words. `Price` is what an Auction is
							     asking; `Final amount` is what it went for, and the same
							     number under the same word would leave a Manager scanning
							     a mixed board unable to tell which they were reading.
							     Both constants are the core's. -->
							<p class="card-price" class:card-price-absent={card.price === null}>
								<span class="visually-hidden">{BOARD_PRICE_LABEL}</span>
								{card.priceLabel}
							</p>
							{#if card.viewerState !== 'not_involved'}
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
							{/if}
						</div>

						{#if card.state === 'minimum_bid'}
							<!-- The Contender count, the fold's own sentence. -->
							<p class="prose">{contenderCountSentence(card.contenderCount)}</p>
						{/if}
						<!-- ROW 3 — who leads, and how long is left. One row, because they
						     are the two halves of the same question and a Manager reads
						     them together. -->
						<div class="card-line">
							<p class="card-leader">
								<span class="visually-hidden">{BOARD_LEADING_LABEL}</span>
								{card.leadingBidder}
							</p>
							{#if card.closesAt === null}
								<!-- No clock at all: no Opening Bid has started one. What the
								     card states instead is how long the nomination has stood
								     unbid, from the core's own phrase. -->
								<p class="card-when">{unbidPhrase(card.nominatedAt ?? '', nowIso)}</p>
							{:else}
								<p class="card-when">
									<span class="visually-hidden">{BOARD_CLOSES_LABEL}</span>
									{closesInPhrase(card.closesAt, nowIso)}
								</p>
							{/if}
						</div>

						<!-- ROW 4 — the footnote line: time TWICE, the absolute stamp in
						     the viewer's own timezone beside the relative phrase above it,
						     and never dropped to save space. The nominating Team rides the
						     same row and keeps a VISIBLE label: two bare `Team — Manager`
						     strings on one card would be indistinguishable from each other,
						     and the Leading Bidder is the one the countdown beside it
						     identifies. -->
						<div class="card-line card-footnote">
							<p class="card-when">
								{#if card.closesAt === null}
									{#if nominatedAbsolute[card.fantraxPlayerId] !== undefined}
										{nominatedAbsolute[card.fantraxPlayerId]}
									{/if}
								{:else if closesAtAbsolute[card.fantraxPlayerId] !== undefined}
									{closesAtAbsolute[card.fantraxPlayerId]}
								{/if}
							</p>
							<p class="card-when">
								<span class="section-label chip-word-narrow">{BOARD_NOMINATED_LABEL_NARROW}</span>
								<span class="section-label chip-word-wide">{BOARD_NOMINATED_LABEL}</span>
								{card.nominatedBy}
							</p>
						</div>
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
	 * a select: a native menu would hide the current view behind a tap, and
	 * the radios are still radios — every choice visible at once, with the one
	 * in force marked — once the row above is opened.
	 *
	 * The DISCLOSURE is what changed: eight radios stood permanently between
	 * the masthead and the first card, which on a 375px screen is most of the
	 * first screen spent on a view that is almost always the default one. The
	 * closed row is not a hidden control — it prints the choice in force, so
	 * the answer the radios used to give by which one is ticked is now given
	 * in words, and the choices themselves are one tap away.
	 */
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		/*
		 * The two axes are NOT the same gap. Across, the gap is what keeps two
		 * choices from reading as one phrase. Down — which is what happens at
		 * 375px, where five filters stack — each choice already carries a
		 * touch-floor box, so a gap between two of them adds to slack that is
		 * there anyway and the stack drifts apart. The rows meet; their boxes
		 * do the spacing.
		 */
		column-gap: var(--space-row-gap);
		row-gap: 0;
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
	 * The closed row: the control's name, the view in force, and the mark that
	 * says there is more behind it.
	 *
	 * NO `--control-height` and no `--touch-min` — `/nominate`'s explainer made
	 * the same call for the same reason. A touch-floor box around a body-size
	 * line left most of its height empty above and below each of two rows, and
	 * stacked they were a band of empty panel between the count and the board.
	 *
	 * The target is not lost with it: the summary spans the panel's full
	 * width, so the row is a wide target however short it is, and this is a
	 * control whose mis-tap costs nothing — it opens a list of radios, each of
	 * which keeps the floor on its own row. The floor stays, untouched, on
	 * every control that spends something.
	 */
	.controls-disclosure > summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-row-gap);
		cursor: pointer;
		/* The mark below carries the affordance; the default triangle beside
		   it would be two of them stacked — `/nominate`'s own reasoning. */
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
	 * The view in force, set at the body size against the small uppercase
	 * label beside it: the LABEL says which control this is and the value is
	 * the thing being read, so the value is the one that carries the weight.
	 */
	.controls-current {
		color: var(--color-text);
	}

	/*
	 * The chevron, pushed to the trailing edge, drawn in `em` off the summary's
	 * own font and stroked from `currentColor` — the same construction as
	 * `/nominate`'s explainer mark, so the two disclosures in this codebase
	 * carry one affordance rather than two.
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
	 *
	 * The same box is why the open list is pulled back INTO the panel's row
	 * gap at the bottom. Each choice keeps its touch floor — that is not
	 * negotiable on a control — but the floor is a hit area, not spacing, and
	 * the empty part of the last row's box already reads as the gap beneath
	 * it. Adding the panel's own gap on top of it stacked two separations
	 * where the eye sees one. The negative margin cancels the second; the
	 * target it hangs off is untouched, the same way `/nominate`'s mark grows
	 * its hit box without growing its row.
	 */
	.controls-disclosure[open] > .controls {
		margin-bottom: calc(-1 * var(--space-row-gap));
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
	 * The Closed edge: the same 2px rule the Leading edge uses, in the grey
	 * that already carries secondary text and labels everywhere else. A closed
	 * Auction is a RECORD, so its accent is the quietest ink on the surface —
	 * it marks the card as a different kind of thing without claiming any of
	 * the attention the two live edges below are for.
	 *
	 * Declared FIRST so those two always win, though neither can actually
	 * collide with it: `minimum_bid` is not `closed`, and a closed card's
	 * viewer state is only ever `won` or `not_involved`.
	 */
	.card.closed {
		border-left: var(--leading-edge-width) solid var(--color-text-secondary);
	}

	/*
	 * The Leading edge: a 2px pale green rule on an Auction the reader leads.
	 * Deliberately NOT the 3px lottery bar below — that device is exclusive to
	 * Minimum-Bid Contention — and declared FIRST so that a card which is both
	 * leading and in a contention takes the lottery bar, never this one.
	 */
	.card.leading {
		border-left: var(--leading-edge-width) solid var(--color-leading);
	}

	/*
	 * The 3px left accent bar marking a Minimum-Bid Contention — the one
	 * structural exception in the design, and no other element on any surface
	 * may borrow the device. It never carries the state alone.
	 */
	.card.lottery {
		border-left: var(--accent-bar-width) solid var(--color-lottery);
	}

	/*
	 * The identity row: the name, the NBA team and position beside it, and
	 * the Auction state at the far edge. Baseline-aligned, so the small
	 * metadata and the state word sit on the name's own baseline rather than
	 * their box centres, and wrapping, so 375px never scrolls sideways.
	 */
	.card-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-row-gap);
	}

	/*
	 * Pushed to the trailing edge by the free space rather than by a width,
	 * so a long Player name simply takes the state word to the next line
	 * instead of squeezing it.
	 */
	.card-state {
		margin-left: auto;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		font-size: var(--size-10);
	}

	/*
	 * The short name below 640px and the full one at and above it — the same
	 * breakpoint `global.css` already uses for the strip, so the layout has
	 * one width where it changes its mind rather than two.
	 *
	 * The state chip and the footnote's `Nominated by` label both take this
	 * pair: one rule for every place on the card that has a narrow spelling,
	 * so they all abbreviate at the same width.
	 */
	.chip-word-wide {
		display: none;
	}

	@media (min-width: 640px) {
		.chip-word-narrow {
			display: none;
		}

		.chip-word-wide {
			display: inline;
		}
	}

	/*
	 * On a Minimum-Bid Contention the state takes `lottery-text` — the icon and
	 * the word together, so the diamond and the name it belongs to read as one
	 * mark and the card's own accent bar has a word in its colour to point at.
	 *
	 * Selected through the card rather than by a class of its own: `lottery` is
	 * already on the `<li>` and is the one fact this rule depends on, so the
	 * state's class attribute keeps stating which state it is and nothing else.
	 * Colour is never the carrier — the diamond and the word are.
	 */
	.card.lottery .card-state {
		color: var(--color-lottery-text);
	}

	/*
	 * The price, with the viewer's own state opposite it. Centred rather than
	 * baselined: a chip is a box, and aligning its text baseline to a
	 * `--size-26` figure would hang it off the bottom of the row.
	 */
	.card-figure {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-row-gap);
	}

	/*
	 * The closed card's one body row: the two labelled lines at the leading
	 * edge, the final amount at the trailing one.
	 *
	 * `align-items: center` rather than baseline, for the same reason
	 * `.card-figure` gives: a `--size-26` figure baselined against two small
	 * lines would hang below both of them. The facts column takes the free
	 * space with `flex: 1`, so the figure sits hard against the trailing edge
	 * at every width, and the whole row WRAPS — at 375px a long Team name
	 * pushes the figure onto its own line instead of colliding with it.
	 */
	.card-closed {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-row-gap);
	}

	.card-closed-facts {
		display: flex;
		flex-direction: column;
		gap: calc(var(--space-row-gap) / 2);
		flex: 1 1 auto;
		min-width: 0;
	}

	/*
	 * The closed instant stays the quietest line on the card — the `--size-11`
	 * the footnote row gives a timestamp — even though it no longer sits on a
	 * footnote row of its own.
	 */
	.card-closed-facts .card-when {
		font-size: var(--size-11);
	}

	/* Both labels ride inline with their values, not above them. */
	.card-closed-facts .section-label {
		margin-right: 0.4em;
	}

	/*
	 * The figure column: the amount, and under it the viewer's own relation to
	 * the close. Right-aligned so the figure and the word beneath it share one
	 * edge with the card, which is what lets a reader scan a column of final
	 * amounts down the board.
	 */
	.card-closed-figure {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: calc(var(--space-row-gap) / 2);
		text-align: right;
	}

	/*
	 * The two-column lines: leader and countdown, then the absolute stamp and
	 * the nominator. `space-between` with `flex-wrap`, so at 375px a long
	 * pairing stacks instead of colliding.
	 */
	.card-line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-row-gap);
	}

	/*
	 * The footnote line is the quietest on the card — DESIGN.md's `--size-11`
	 * `text-tertiary` for timestamps and footnotes — so the absolute stamp and
	 * the nominator sit a step below the leader row above them.
	 */
	.card-footnote .card-when {
		font-size: var(--size-11);
	}

	/* The nominator's label rides inline with its value, not above it. */
	.card-footnote .section-label {
		margin-right: 0.4em;
	}

	/*
	 * The Player's name is the card's one control -- it opens that Player's own
	 * Auction page -- so it is UNDERLINED and says so. The `none` that stood
	 * here left a link identifiable only by its cursor, which a phone does not
	 * have: on touch the only way to discover the card was tappable was to tap
	 * it. Thickness and offset come from `global.css`'s own `a` rule, so this
	 * underline is the same one every other link in the product draws.
	 *
	 * The colour stays `text` rather than taking the brand green a bare `a`
	 * would: the name is the card's identity first and its control second, and
	 * a board of thirty green names would read as thirty calls to act. The RULE
	 * under it is `text-secondary`, the grey of the labels and the closed
	 * card's edge — present enough to mark the control, quiet enough that the
	 * name itself stays the brightest ink on the card.
	 */
	.card-link {
		color: var(--color-text);
		text-decoration: underline;
		text-decoration-color: var(--color-text-secondary);
	}

	.card-player {
		font-size: var(--size-18);
		color: var(--color-text);
	}

	/*
	 * A long name, set one step down the scale — see `LONG_NAME_LENGTH`. This
	 * is the ONLY size the card varies by content, and it varies the name
	 * rather than clipping it: `text-overflow: ellipsis` on a Player's name
	 * would cut off the one thing on this card a Manager identifies it by.
	 */
	.card-player-long {
		font-size: var(--size-15);
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

	/*
	 * `text-secondary` at the metadata size, matching the countdown it now
	 * shares a row with — the two read as one line, not as a sentence with a
	 * timestamp appended.
	 */
	.card-leader {
		color: var(--color-text-secondary);
		font-size: var(--size-12);
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

	/*
	 * Filled pale green, the Outbid chip's own treatment in the opposite
	 * colour: leading is the one other fact on this card that is about the
	 * READER, and the two read as a pair. Not `brand`, which may never signal
	 * leading, and not `attention`, which marks Outbid and nothing else.
	 */
	.chip-lead {
		background-color: var(--color-leading);
		color: var(--color-leading-ink);
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
