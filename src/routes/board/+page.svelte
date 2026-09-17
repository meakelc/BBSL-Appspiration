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
		BOARD_FINAL_LABEL,
		BOARD_HIDE_CLOSED_LABEL,
		BOARD_LEADING_LABEL,
		BOARD_NOMINATED_LABEL,
		BOARD_NOMINATED_LABEL_NARROW,
		BOARD_OPEN_HEADING,
		BOARD_PANEL_HEADING,
		BOARD_CLOSED_HEADING,
		BOARD_PRICE_LABEL,
		BOARD_SORT_LEGEND,
		BOARD_TITLE,
		BOARD_WON_BY_LABEL,
		DEFAULT_SORT,
		DEFAULT_SORT_DIRECTION,
		EMPTY_BOARD_ACTION,
		EMPTY_BOARD_HEADING,
		EMPTY_BOARD_STATEMENT,
		SORT_DIRECTION_ICONS,
		SORT_DIRECTION_LABELS,
		SORT_KEYS,
		SORT_LABELS,
		boardCountSentence,
		filterBoard,
		flipDirection,
		openCardCount,
		sortBoard,
		sortSummary,
		unbidPhrase
	} from '$lib/core/board.ts';
	import type {
		BoardCardState,
		BoardSort,
		BoardSortDirection,
		BoardViewerState
	} from '$lib/core/board.ts';
	// The Auction deep-link shape is written ONCE, in the core, so `/board`,
	// `/positions` and Story 5.3's Discord notification all emit one shape.
	import { auctionPathFor } from '$lib/core/auction-link.ts';
	import { closesInPhrase, contenderCountSentence } from '$lib/core/projection/auctions.ts';
	import { figuresAgeSentence } from '$lib/core/freshness.ts';
	import { freshness } from '$lib/client/freshness.svelte.ts';
	// Outbid cards dismissed on Your Positions lose their chip here too.
	import { dismissals } from '$lib/client/dismissals.svelte.ts';
	// The switch outlives this component, so the setting it holds does too.
	import { boardView } from '$lib/client/board-view.svelte.ts';
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
	 * The pieces of view state, and they are the whole of it. None touches the
	 * server, and none can change a figure on a card: the sort reorders the
	 * list, the direction turns that order over, and the switch narrows it.
	 *
	 * The sort and its direction live HERE and reset on a reload, because an
	 * ordering is how a Manager is reading the board this minute. The switch
	 * lives in `boardView` and persists, because hiding the closed cards is a
	 * standing preference about what the board IS — the distinction the user
	 * drew, and the module comment explains the mechanism.
	 */
	let sort = $state<BoardSort>(DEFAULT_SORT);
	let direction = $state<BoardSortDirection>(DEFAULT_SORT_DIRECTION[DEFAULT_SORT]);

	/**
	 * Choosing a sort. A key that is NOT in force is simply chosen, and it opens
	 * in its own natural direction — the core's `DEFAULT_SORT_DIRECTION`, so
	 * "which end does Price start at" is answered in one place rather than here.
	 * Choosing the key that IS in force is the second tap, and a second tap on a
	 * chosen key means the other end of it.
	 *
	 * The disclosure closes on a CHOICE and stays open on a FLIP: the choice is
	 * why it was opened and the list beneath is what the Manager came to read,
	 * but a flip is a comparison — a Manager turning a board over is often about
	 * to turn it back — and closing the control under them would cost a tap
	 * every time.
	 */
	function chooseSort(key: BoardSort): void {
		if (key === sort) {
			direction = flipDirection(direction);
			return;
		}
		sort = key;
		direction = DEFAULT_SORT_DIRECTION[key];
		sortOpen = false;
	}

	/**
	 * Whether the sort control is showing its choices. Presentation only — a
	 * disclosure's own open flag, and the one thing on this page that is neither
	 * a figure nor a view of one. It starts CLOSED: the board is what the
	 * board's first screen is for, and the closed row still states which
	 * ordering is in force.
	 *
	 * There is no second flag beside it any more. The filter was a disclosure
	 * over five radios and is now one switch, which has nothing to disclose:
	 * it states its own name, shows its own position, and is one tap deep
	 * rather than two.
	 */
	let sortOpen = $state(false);

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

	// Client-only, like every storage read: the switch starts at the core's
	// default on both sides of hydration and takes its stored position after.
	$effect(() => {
		boardView.load();
	});

	// Client-only, like every storage read. Any dismissal the reader is no
	// longer outbid on is dropped, so a later outbid shows its chip again.
	$effect(() => {
		dismissals.load(
			board.cards.filter((card) => card.viewerState === 'outbid').map((card) => card.fantraxPlayerId)
		);
	});

	/** An outbid the reader dismissed on Your Positions prints no chip. */
	function outbidDismissed(card: BoardCardView): boolean {
		return card.viewerState === 'outbid' && dismissals.has(card.fantraxPlayerId);
	}

	/**
	 * The list as it is read: filtered, then ordered.
	 *
	 * Both are the core's own functions — the comparator that makes every sort
	 * total and tie-break on the Player name lives beside the fold rules, not
	 * here, so a list re-derived on every projection change cannot visibly
	 * reshuffle while a Manager is reading it.
	 */
	const shown = $derived(
		sortBoard(filterBoard(board.cards, boardView.hideClosed), sort, nowIso, direction)
	);

	/**
	 * The same list, split at the one seam the board has: what is live, and
	 * what is settled.
	 *
	 * Split from `shown` rather than sorted twice, so the ordering a Manager
	 * chose is applied ONCE and both groups are windows onto the one result.
	 * `sortBoard` already tiers the closed cards last, so the split takes a
	 * contiguous run out of each end — but the partition does not RELY on that
	 * tiering, it reads each card's own `state`, which is the field that decides
	 * what closed means everywhere else in this codebase.
	 *
	 * `closedCards` is empty whenever the switch is on, because `filterBoard`
	 * has already dropped those cards upstream — the switch and the grouping are
	 * the same division of the board, and neither is re-deciding it here.
	 */
	const openCards = $derived(shown.filter((card) => card.state !== 'closed'));
	const closedCards = $derived(shown.filter((card) => card.state === 'closed'));

	/**
	 * How many Auctions are OPEN — the whole board, never the filtered view,
	 * and never the closed cards either.
	 *
	 * The sentence says "are open", so the figure has to be the open ones. The
	 * count is the core's, not a `filter` written here: the surface prints
	 * fields and words nothing, and that includes counting nothing.
	 */
	const countSentence = $derived(boardCountSentence(openCardCount(board.cards)));

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
		<!-- What the panel below is: the Auction, singular — the event this
		     league is running, not one of the Auctions counted inside it. The
		     count of what is open, the switch that hides what is closed and the
		     ordering are all facts about the Auction rather than about any
		     Auction, which is what this one word says.

		     It labels the PANEL and nothing beyond it. The two group headings
		     further down name the lists, and a plural here would have been a
		     third label in that column — `Auctions`, then `Open`, then a screen
		     later `Closed`, the top one naming lists that do not begin until
		     after the second.

		     An `h2.section-label`, exactly as the Positions groups and the two
		     group headings below are — the ELEMENT matters and a `<p>` here was
		     wrong twice over. `.section-label` sets the size, the case, the
		     tracking and the colour and does NOT set a weight, so the weight is
		     whatever the element brings: an `h2` is bold from the browser's own
		     default and a `<p>` is not, and this label rendered a shade lighter
		     than the `OPEN` and `CLOSED` it is meant to match. It is also a
		     heading in fact — it names the block that follows it — so the tag
		     that says so is the one that looks right.

		     The `display` face was tried and does not hold, because this page
		     already spends the serif on the masthead above and on every Player
		     name below, and a third serif line between them reads as neither —
		     too quiet to be a title, too loud to be furniture. -->
		<!-- The label and the panel it names, in the shared `group` shape —
		     the same wrapper the two card groups below use, and here for the
		     same reason. As a bare child of `.page` this heading took the
		     SECTION gap, which is what divides the blocks of a page, and a
		     label that far from the thing it labels reads as detached from it.
		     `group` closes it to the card gap, so all three headings on this
		     page sit the same distance above what they name. -->
		<section class="group">
			<h2 class="section-label" id="board-panel-heading">{BOARD_PANEL_HEADING}</h2>

			<section class="panel">
				<!-- The panel's top row: what the board CONTAINS at the leading
				     edge, and the one control that changes what it contains at the
				     trailing one. They belong on one row because they are two halves
				     of the same fact — the count says how many Auctions are closed,
				     the switch decides whether those are on screen, and the count's
				     own wording changes when it is thrown.

				     The block's `Auctions` heading used to stand here. It is gone,
				     and down over the cards where it names the list it is actually
				     over: a panel of controls does not need titling — a sort and a
				     switch say what they are — and the heading was keeping the
				     count sentence from leading the panel.

				     The count is a `--size-12-5` line and the switch's own box is
				     shorter than a touch floor, so this row is as tall as the text
				     on it and no taller. -->
				<div class="panel-top">
					<!-- How many Auctions are OPEN, and that alone.

					     A closed count stood beside it and is gone: on a phone, which
					     is where this board is read, two sentences took this row onto
					     a second and sometimes a third line, and pushed the switch off
					     the count it belongs beside. One figure, one line.

					     The visibly-filtered obligation survives it — the SWITCH is
					     what discharges it. A labelled control on this row, stating
					     its own position, is a stronger guarantee than a sentence
					     describing the setting: it is visible whether or not anything
					     is hidden, and it is what a Manager passes on the way to the
					     cards. The obligation was written against a filter buried in a
					     collapsed disclosure, which this board no longer has. -->
					<p class="prose" id="board-count">{countSentence}</p>

					<!-- The board's one filter, and it is a SWITCH rather than a
					     disclosure over radios: one question with a yes and a no does
					     not need a list, and burying it under a tap would hide the
					     one control on this page whose position a Manager cannot
					     infer from the board in front of them.

					     A native checkbox with `role="switch"`, so it is announced as
					     on or off rather than checked or unchecked, and so the label,
					     the focus ring and the Space key are the browser's own. It
					     posts nothing: the only thing it writes is this browser's own
					     storage, which is why it is still on when the Manager comes
					     back.

					     The BOX follows its label here, which is the reverse of the
					     sort radios below and is the trailing edge's doing: this
					     control is pushed to the right of the panel, so the box last
					     is the box at the edge — where a thumb reaching across a
					     phone arrives, and where a Manager scanning down the right of
					     the panel finds it against the same margin the figures on the
					     cards below share. Reading order is unaffected: the label
					     wraps both, so the accessible name is the same sentence
					     whichever side it is written on. -->
					<label class="switch" for="board-hide-closed">
						<span class="prose switch-label">{BOARD_HIDE_CLOSED_LABEL}</span>
						<input
							id="board-hide-closed"
							type="checkbox"
							role="switch"
							checked={boardView.hideClosed}
							onchange={(event) => boardView.set(event.currentTarget.checked)}
						/>
					</label>
				</div>

				<!-- Every price on this board carries its age in anything but Live
				     (AD-29). The countdowns are exempt and keep running; the
				     figures are what cannot be confirmed. -->
				{#if figuresAge !== null}
					<p class="prose" id="board-figures-age">{figuresAge}</p>
				{/if}

				<!-- Sorting and hiding are view state. Neither posts anything,
				     neither reloads anything, and neither changes a figure on a
				     card — the list is reordered and narrowed, and nothing else.

				     The SORT is CLOSED by default and states its own current
				     ordering on the closed row: the board's first screen is the
				     board, not a stack of radios above it, and what a Manager
				     needs to know without opening anything is which order they are
				     looking at. The choices appear on a tap and the row that
				     opened them keeps saying what is chosen, so the answer is
				     never hidden by the control that holds it.

				     `<details>`/`<summary>` and no script beyond the one flag:
				     the disclosure opens on tap AND on Enter and is announced as
				     expanded or collapsed, the same pattern `/nominate` already
				     uses. -->
				<details class="controls-disclosure" bind:open={sortOpen}>
					<summary>
						<span class="section-label">{BOARD_SORT_LEGEND}</span>
						<span class="prose controls-current">{sortSummary(sort, direction)}</span>
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
						<!-- Each key carries its DIRECTION, and the chosen one shows
						     which end it is running from — the arrow beside the word
						     that names it, never the arrow alone, so the control
						     reads in greyscale like every state on the cards below.
						     Tapping the chosen key again turns the board over, and the
						     direction word beside it is what says so, so the second
						     tap is a labelled act rather than a thing to discover.

						     `onclick` rather than `onchange`, and `checked` rather
						     than `bind:group`: a radio already selected fires no
						     `change` event, so the flip — which is by definition a tap
						     on the selected one — would never reach the page.
						     `chooseSort` is then the ONE place that decides what a tap
						     means, for the keyboard and the touch alike: Space and
						     Enter dispatch a click on a radio too. -->
						{#each SORT_KEYS as key (key)}
							<label class="choice" for={`board-sort-${key}`}>
								<input
									id={`board-sort-${key}`}
									type="radio"
									name="board-sort"
									value={key}
									checked={sort === key}
									onclick={() => chooseSort(key)}
								/>
								<span class="prose">{SORT_LABELS[key]}</span>
								{#if sort === key}
									<span class="prose controls-direction">
										<span aria-hidden="true">{SORT_DIRECTION_ICONS[direction]}</span>
										{SORT_DIRECTION_LABELS[key][direction]}
									</span>
								{/if}
							</label>
						{/each}
					</fieldset>
				</details>

			</section>
		</section>

		<!-- The board is ONE list divided in two, each group named where it
		     starts — `/positions`' own shape, and the shape the `Hide Closed
		     Auctions` switch already implies: a Manager scanning for
		     somewhere to bid and a Manager looking for a draw to check are
		     asking opposite questions of one screen, and the heading is what
		     lets the first stop reading at the second.

		     A group with no cards renders NOTHING, heading included. An
		     empty `CLOSED` on the first morning of the phase would be a
		     label over nothing, and `OPEN` standing alone over a board where
		     everything has settled would be the same. The board's own empty
		     screen, above, is what covers the case where there are no cards
		     at all.

		     The card itself is a SNIPPET, rendered by both groups. Two
		     copies of two hundred lines of card markup is two places for a
		     chip to be added to one of them, and the card does not differ by
		     the group it is in — the Closed arm inside it is keyed on the
		     card's own `state`, exactly as it was when this was one list. -->
		{#if openCards.length > 0}
			<section class="group" id="board-open">
				<h2 class="section-label" id="board-open-heading">{BOARD_OPEN_HEADING}</h2>
				<ul class="board" id="board-cards">
					{#each openCards as card (card.fantraxPlayerId)}
						{@render boardCard(card)}
					{/each}
				</ul>
			</section>
		{/if}

		{#if closedCards.length > 0}
			<section class="group" id="board-closed">
				<h2 class="section-label" id="board-closed-heading">{BOARD_CLOSED_HEADING}</h2>
				<ul class="board" id="board-closed-cards">
					{#each closedCards as card (card.fantraxPlayerId)}
						{@render boardCard(card)}
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</main>

<!-- One card, rendered by both groups.

     A snippet rather than two copies, for the reason every shared
     fragment in this codebase is one: the card does not differ by the
     group it is in. Its Closed arm is keyed on the card's own `state`,
     exactly as it was when the board was a single list, so the grouping
     above decides ORDER and headings and nothing about what a card says.

     Typed structurally, like the `board` it comes from: `BoardCardView` is
     this file's own shape, declared here for the reason the header gives —
     a server-only module is never reachable from a `.svelte` file. -->
{#snippet boardCard(card: BoardCardView)}
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
					<!-- The viewer's own relation to the close, then the figure —
					     ONE line, the state at its leading edge. `won` and
					     `not_involved` are the only two a closed card can carry,
					     and neither earns a chip: the one that prints is ambient,
					     the other prints nothing.

					     Beside the amount rather than beneath it, because it is
					     printed on SOME closed cards and not others: stacked, the
					     cards a Manager won stood a line taller than the ones they
					     did not, so a column of closed cards had two heights and the
					     final amounts down it no longer lined up. On one line every
					     closed card is the same height whatever the reader's
					     relation to it, and the state reads INTO the amount it
					     qualifies — which is the order the sentence has anyway. -->
					<div class="card-closed-figure">
						{#if card.viewerState !== 'not_involved'}
							<p class="state state-ambient">
								<span class="chip-icon" aria-hidden="true">{card.viewerStateIcon}</span>
								<span class="chip-word">{card.viewerStateLabel}</span>
							</p>
						{/if}
						<!-- No absent treatment here: a closed Auction's price is the
						     Contract's own winning amount, which is never null. The
						     unbid nomination below is the ONE place a null price is
						     drawn. -->
						<p class="card-price">
							<span class="visually-hidden">{BOARD_FINAL_LABEL}</span>
							{card.priceLabel}
						</p>
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
					{#if card.viewerState !== 'not_involved' && !outbidDismissed(card)}
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
{/snippet}

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
	 * The direction beside the key it belongs to, set a step quieter than the
	 * key itself: the key is the choice and the direction is a fact about it,
	 * and two lines at the same weight would read as two separate options. It
	 * prints only on the key in force, so the row never carries three of them.
	 */
	.controls-direction {
		color: var(--color-text-secondary);
		font-size: var(--size-12);
	}

	/*
	 * The one switch. A row at the touch floor, like every `.choice` above it —
	 * the floor stays on every control that spends something, and this one
	 * spends a Manager's view of the board and then REMEMBERS having spent it.
	 *
	 * The native checkbox, sized to match the radios rather than redrawn as a
	 * track and a knob: a custom switch would have to reimplement the focus
	 * ring, the Space key and the disabled state that the browser already
	 * carries, and `role="switch"` is what makes it announce as on or off.
	 */
	/*
	 * The panel's top row: the count at the leading edge, the switch pushed to
	 * the far edge by the free space rather than by a width — `.card-head`'s own
	 * device, so the rows in this file that pair a line with something at the
	 * opposite edge all do it the same way.
	 *
	 * It WRAPS, and at 375px it does: two count sentences beside `Hide Closed
	 * Auctions` are wider than the panel. The switch keeps its `margin-left:
	 * auto` on the second line, so a wrapped row still puts it at the trailing
	 * edge instead of dropping it back to the leading one.
	 *
	 * `align-items: center` against a count line that may itself wrap to two
	 * lines: the switch then centres on the pair, which is what keeps it from
	 * hanging off the first line of a sentence it belongs to the whole of.
	 */
	.panel-top {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		column-gap: var(--space-row-gap);
		row-gap: 0;
	}

	/*
	 * NO `--touch-min` — `/nominate`'s explainer summary made the same call for
	 * the same reason, and this row is the case it was describing. The floor is
	 * twice the height of the checkbox it would box, so most of it was empty
	 * above and below — and because the heading beside it is a `--size-10` label
	 * with no height of its own, that emptiness became the height of the whole
	 * row: the heading ended up floating in a band of panel it had not asked
	 * for.
	 *
	 * The target is not lost with it, and this is the idiom the explainer mark
	 * already uses: the PADDING is the tap area and the negative margin is what
	 * stops it being layout. The margin box collapses back to the content, so
	 * the hit area grows and the row does not — and the label text is inside
	 * the target too, so what a Manager taps is the whole pairing rather than a
	 * 22px box.
	 *
	 * `margin-left` is `auto` rather than negative: that edge has nothing to
	 * collapse against, because the free space is what pushes this to the
	 * trailing edge. The `--touch-min` floor is kept, untouched, on every
	 * control that SPENDS something. This one spends nothing — it hides cards,
	 * it is reversible by the same tap, and it states its own position.
	 */
	.switch {
		display: flex;
		align-items: center;
		gap: var(--space-row-gap);
		cursor: pointer;
		padding: var(--space-row-gap);
		margin: calc(-1 * var(--space-row-gap));
		margin-left: auto;
	}

	.switch input[type='checkbox'] {
		width: 22px;
		height: 22px;
		accent-color: var(--color-border-interactive);
	}

	/*
	 * The switch's name carries the weight its `section-label` neighbours do
	 * not: it is the only control on the panel whose position a Manager cannot
	 * read off the board, so it is set as text rather than as a label.
	 */
	.switch-label {
		color: var(--color-text);
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
	 * The Closed card is set in the grey its own edge takes.
	 *
	 * The Player name and the final amount are the two things on any card set
	 * in full-strength `text`, and on a closed card they were the brightest ink
	 * on the board — a settled record shouting over the Auctions a Manager can
	 * still act on. Dropped to `text-secondary` they read as what they are:
	 * still perfectly legible, no longer competing. The name keeps its
	 * underline, because it is still the control that opens the Closed page,
	 * and the underline's own colour comes with it.
	 *
	 * Colour is never a carrier here — it is not doing the work of saying the
	 * Auction is closed. The card already says that three times over: the state
	 * word on the identity row, the `Won by` and `Closed` labels, and the edge
	 * below. A greyscale screenshot loses none of them.
	 */
	.card.closed .card-link,
	.card.closed .card-player,
	.card.closed .card-price {
		color: var(--color-text-secondary);
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
	 * The figure and, to its left, the viewer's own relation to the close. ONE
	 * row, and that is the point of it: the state prints on some closed cards
	 * and not others, so stacking it gave a won card an extra line and left a
	 * column of closed cards with two heights. Beside the amount, every closed
	 * card sets the same, and the final amounts line up down the board however
	 * the reader's league went.
	 *
	 * `align-items: center`, for `.card-figure`'s own reason: the state is a
	 * line of `--size-12-5` text and baselining it against a `--size-26` figure
	 * would hang it off the bottom of the row. It does NOT wrap — the pair is a
	 * short word and a short figure, and the row ABOVE it is the one that wraps
	 * at 375px, taking this whole column onto its own line rather than breaking
	 * it in half.
	 */
	.card-closed-figure {
		display: flex;
		align-items: center;
		gap: var(--space-row-gap);
		text-align: right;
	}

	/*
	 * `.state` sets `align-self: flex-start`, which on a row this tall would
	 * drop the word to the top of the figure beside it. Centred here, and only
	 * here: every other state on this page sits in a column where the flex-start
	 * is what keeps it off the full width.
	 */
	.card-closed-figure .state {
		align-self: center;
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

	/* The two chips that concern the reader set in capitals. */
	.chip {
		padding: 2px var(--space-row-gap);
		text-transform: uppercase;
		letter-spacing: 0.06em;
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
