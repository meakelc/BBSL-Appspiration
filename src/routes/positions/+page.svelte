<script lang="ts">
	// Your Positions (Story 4.4) — the landing.
	//
	// Five groups in the wake-up's order and no other: Won · Outbid · You lead
	// · Contending · Nomination Slot. The order is not a sort and there is no
	// control that changes it.
	//
	// **No wording of its own.** Every heading, label, icon and sentence
	// arrives from `$lib/core/positions.ts` — including the re-entry answer on
	// every outbid card, which is `bidControlState`'s output at that Auction's
	// own minimum legal Bid, computed server-side against the database clock.
	// What this file holds is structure and CSS.
	//
	// **The outbid card states the answer before it is asked.** Whether a legal
	// re-entry exists, at what amount, and — when it does not — the cap
	// arithmetic AND the capacity outcome, both always, never one standing in
	// for the other.
	//
	// **No urgency device anywhere.** No "ending soon", no one-tap raise, no
	// suggested amount, no ranking, and no celebration on a won card.
	//
	// **The countdown derives from the server-authoritative `closesAt`**, plus
	// the elapsed time this device has measured since the server's own instant
	// — the board's anchor, for its reason. Countdowns are exempt from
	// freshness (AD-29); the figures are not, and the page carries their age.
	//
	// Types are declared structurally rather than imported from a server-only
	// module — the rule `nominate/+page.svelte` states and every page since
	// follows. `$lib/core` is a different matter: it is the pure core.
	import {
		BOARD_PATH,
		EMPTY_POSITIONS_HEADING,
		EMPTY_POSITIONS_STATEMENT,
		GROUP_HEADINGS,
		NOMINATE_PATH,
		POSITIONS_BOARD_ACTION,
		POSITIONS_CLOSED_LABEL,
		POSITIONS_CLOSES_LABEL,
		POSITIONS_NOMINATE_ACTION,
		POSITIONS_PRICE_LABEL,
		POSITIONS_TITLE,
		POSITIONS_WON_LABEL,
		POSITIONS_YOUR_BID_LABEL,
		emptyPositionsSentence
	} from '$lib/core/positions.ts';
	import { closesInPhrase } from '$lib/core/projection/auctions.ts';
	import type { ContentionState } from '$lib/core/projection/auctions.ts';
	import { figuresAgeSentence } from '$lib/core/freshness.ts';
	import { freshness } from '$lib/client/freshness.svelte.ts';
	import { formatInstant, parseInstant } from '$lib/core/instant.ts';

	import type { PageData } from './$types';

	type GateRow = {
		readonly gate: string;
		readonly label: string;
		readonly passed: boolean;
		readonly chip: string;
		readonly figure: string;
	};

	type WonCardView = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly metadata: string | null;
		readonly winningAmountLabel: string;
		readonly placement: string;
		readonly sentence: string;
		readonly closedAt: string;
		readonly href: string;
	};

	type OutbidCardView = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly metadata: string | null;
		readonly priceLabel: string;
		readonly yourBidLabel: string;
		readonly leadingBidder: string;
		readonly closesAt: string;
		readonly contention: ContentionState;
		readonly stateLabel: string;
		readonly stateIcon: string;
		readonly reEntrySentence: string;
		readonly reEntryBlocked: boolean;
		readonly reEntryGates: readonly GateRow[];
		readonly href: string;
	};

	type LeadCardView = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly metadata: string | null;
		readonly priceLabel: string;
		readonly closesAt: string;
		readonly contention: ContentionState;
		readonly stateLabel: string;
		readonly stateIcon: string;
		readonly commitmentSentence: string;
		readonly href: string;
	};

	type ContendingCardView = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly metadata: string | null;
		readonly priceLabel: string;
		readonly closesAt: string;
		readonly contention: ContentionState;
		readonly contentionLabel: string;
		readonly stateLabel: string;
		readonly stateIcon: string;
		readonly contenderCountSentence: string;
		readonly clockSentence: string;
		readonly href: string;
	};

	type NominationSlotCard = {
		readonly used: boolean;
		readonly fantraxPlayerId: string | null;
		readonly playerName: string | null;
		readonly sentence: string;
		readonly href: string | null;
	};

	type Positions = {
		readonly viewerTeamId: string | null;
		readonly won: readonly WonCardView[];
		readonly outbid: readonly OutbidCardView[];
		readonly youLead: readonly LeadCardView[];
		readonly contending: readonly ContendingCardView[];
		readonly nominationSlot: NominationSlotCard;
		readonly empty: boolean;
		readonly openAuctionCount: number;
		readonly figuresAt: string;
	};

	let { data }: { data: PageData } = $props();

	const positions = $derived(data.positions as Positions);

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
	 * The instant every phrase on this page reads. The ORIGIN is the server's
	 * — `positions.figuresAt` is the database clock, read once by the read
	 * path — and only the elapsed time is local, so a skewed device crosses
	 * every close at the same real moment a correct one does (AD-3).
	 */
	const nowIso = $derived.by(() => {
		const anchor = parseInstant(positions.figuresAt);
		if (anchor === null) return positions.figuresAt;
		return formatInstant(anchor + elapsedMs);
	});

	// Client-only, because `$effect` never runs during SSR, and cleaned up by
	// the function it returns. `positions.figuresAt` is read for its
	// DEPENDENCY: any reload hands over a fresh server instant and the elapsed
	// count has to restart with it.
	$effect(() => {
		void positions.figuresAt;
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
	 * The age of every figure on this page, in anything but Live (AD-29) —
	 * the 4.3 review finding applied here, page-level rather than per card.
	 *
	 * This page carries MORE than prices: the re-entry answer on every outbid
	 * card is `evaluate()` output over a Cap Space read at `figuresAt`, so a
	 * stale page can state that a Bid is within reach when the capital behind
	 * it has since been committed elsewhere. **Countdowns stay exempt**: they
	 * derive from absolute close timestamps this page already holds.
	 *
	 * ONE line for the page, because every card came from a single transaction
	 * anchored on a single `figuresAt`; a stamp per card would repeat one fact
	 * many times and read as urgency on a surface that refuses it.
	 */
	const figuresAge = $derived(
		freshness.state === 'live'
			? null
			: figuresAgeSentence(freshness.lastLivenessOkAt, freshness.now)
	);

	/**
	 * The empty screen's own sentence — the Nomination Slot's state and the
	 * open-Auction count, from the core.
	 */
	const emptySentence = $derived(
		emptyPositionsSentence(!positions.nominationSlot.used, positions.openAuctionCount)
	);

	/**
	 * The absolute stamps, computed in an `$effect` and therefore only in the
	 * browser — the SSR-leak rule the Auction page and the board establish.
	 * `Intl.DateTimeFormat(undefined, ...)` resolves `undefined` to the
	 * timezone of whatever machine formats it, so deriving these during SSR
	 * would ship the SERVER's timezone in the delivered HTML, which Svelte
	 * does not diff-correct on hydration. The markup omits a stamp until it
	 * exists rather than rendering one that is wrong for a paint.
	 *
	 * Keyed on the Player id, so a re-render cannot hand a card another card's
	 * stamp.
	 */
	let absolute = $state<Record<string, string>>({});

	// `Intl.DateTimeFormat.format` throws `RangeError` on an Invalid Date, so
	// an unreadable instant is checked for rather than formatted.
	function formatAbsolute(iso: string): string {
		const parsed = new Date(iso);
		if (Number.isNaN(parsed.getTime())) return 'at an unknown time';
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(parsed);
	}

	$effect(() => {
		const stamps: Record<string, string> = {};
		for (const card of positions.won) stamps[card.fantraxPlayerId] = formatAbsolute(card.closedAt);
		for (const card of positions.outbid) stamps[card.fantraxPlayerId] = formatAbsolute(card.closesAt);
		for (const card of positions.youLead) stamps[card.fantraxPlayerId] = formatAbsolute(card.closesAt);
		for (const card of positions.contending) {
			stamps[card.fantraxPlayerId] = formatAbsolute(card.closesAt);
		}
		absolute = stamps;
	});
</script>

<svelte:head>
	<title>{POSITIONS_TITLE} — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1 class="display">{POSITIONS_TITLE}</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	<section class="panel">
		<p class="section-label">Phase</p>
		<p class="prose">{data.phase.sentence}</p>

		<!-- Every figure on this page carries its age in anything but Live
		     (AD-29). The countdowns are exempt and keep running; the figures
		     and the re-entry answers are what cannot be confirmed. -->
		{#if figuresAge !== null}
			<p class="prose" id="positions-figures-age">{figuresAge}</p>
		{/if}
	</section>

	{#if positions.empty}
		<!-- The designed empty screen, not an edge case: it states what the
		     state is and points at the board and at the unused Nomination
		     Slot, with the open-Auction count. Every word is the core's. -->
		<section class="panel" id="positions-empty">
			<h2 class="display" id="positions-empty-heading">{EMPTY_POSITIONS_HEADING}</h2>
			<p class="prose" id="positions-empty-statement">{EMPTY_POSITIONS_STATEMENT}</p>
			<p class="prose" id="positions-empty-count">{emptySentence}</p>
			<p class="prose">
				<a href={NOMINATE_PATH} id="positions-empty-nominate">{POSITIONS_NOMINATE_ACTION}</a>
			</p>
			<p class="prose"><a href={BOARD_PATH} id="positions-empty-board">{POSITIONS_BOARD_ACTION}</a></p>
		</section>
	{:else}
		{#if positions.won.length > 0}
			<section class="group" id="group-won">
				<h2 class="section-label">{GROUP_HEADINGS.won}</h2>
				<ul class="cards">
					{#each positions.won as card (card.fantraxPlayerId)}
						<li class="card">
							<a class="card-link" href={card.href}>
								<span class="display card-player">{card.playerName}</span>
							</a>
							{#if card.metadata !== null}
								<p class="card-metadata">{card.metadata}</p>
							{/if}
							<p class="section-label">{POSITIONS_WON_LABEL}</p>
							<p class="card-price">{card.winningAmountLabel}</p>
							<!-- The placement and the Cap Hit in words: the two are
							     independent (AD-23), and a card stating only the
							     amount would let a $0 minors charge read as the
							     winning figure. -->
							<p class="prose">{card.sentence}</p>
							<p class="section-label">{POSITIONS_CLOSED_LABEL}</p>
							<p class="card-when">
								{#if absolute[card.fantraxPlayerId] !== undefined}
									{absolute[card.fantraxPlayerId]}
								{/if}
							</p>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if positions.outbid.length > 0}
			<section class="group" id="group-outbid">
				<h2 class="section-label">{GROUP_HEADINGS.outbid}</h2>
				<ul class="cards">
					{#each positions.outbid as card (card.fantraxPlayerId)}
						<li class="card" class:lottery={card.contention === 'minimum_bid'}>
							<a class="card-link" href={card.href}>
								<span class="display card-player">{card.playerName}</span>
							</a>
							{#if card.metadata !== null}
								<p class="card-metadata">{card.metadata}</p>
							{/if}

							<!-- The chip is reserved for Outbid and You lead
							     (DESIGN.md:194): filled `attention` here. It carries an
							     ICON and a WORD together, so a greyscale screenshot
							     reads identically. -->
							<p class="state chip chip-outbid">
								<span class="chip-icon" aria-hidden="true">{card.stateIcon}</span>
								<span class="chip-word">{card.stateLabel}</span>
							</p>

							<p class="section-label">{POSITIONS_PRICE_LABEL}</p>
							<p class="card-price">{card.priceLabel}</p>
							<p class="section-label">{POSITIONS_YOUR_BID_LABEL}</p>
							<p class="prose card-leader">{card.yourBidLabel}</p>
							<p class="prose card-leader">{card.leadingBidder}</p>

							<p class="section-label">{POSITIONS_CLOSES_LABEL}</p>
							<!-- Time TWICE: the relative phrase, and the absolute stamp
							     in the viewer's own timezone. -->
							<p class="card-when">{closesInPhrase(card.closesAt, nowIso)}</p>
							<p class="card-when">
								{#if absolute[card.fantraxPlayerId] !== undefined}
									{absolute[card.fantraxPlayerId]}
								{/if}
							</p>

							<!-- The re-entry answer, stated before it is asked. -->
							<p class="re-entry" class:re-entry-blocked={card.reEntryBlocked}>
								{card.reEntrySentence}
							</p>
							<!-- BOTH gates, always — refused and passed alike (AD-7).
							     A capacity refusal may never be reported as a cap
							     refusal, and each row carries its own arithmetic so
							     two rows cannot be read as one. -->
							<ul class="gates">
								{#each card.reEntryGates as gate (gate.gate)}
									<li class="gate">
										<span class="gate-chip">{gate.chip}</span>
										<span class="gate-figure">{gate.figure}</span>
									</li>
								{/each}
							</ul>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if positions.youLead.length > 0}
			<section class="group" id="group-you-lead">
				<h2 class="section-label">{GROUP_HEADINGS.you_lead}</h2>
				<ul class="cards">
					{#each positions.youLead as card (card.fantraxPlayerId)}
						<li class="card" class:lottery={card.contention === 'minimum_bid'}>
							<a class="card-link" href={card.href}>
								<span class="display card-player">{card.playerName}</span>
							</a>
							{#if card.metadata !== null}
								<p class="card-metadata">{card.metadata}</p>
							{/if}

							<!-- Outlined, never filled: leading is a standing fact,
							     not an alert. -->
							<p class="state chip chip-lead">
								<span class="chip-icon" aria-hidden="true">{card.stateIcon}</span>
								<span class="chip-word">{card.stateLabel}</span>
							</p>

							<p class="section-label">{POSITIONS_PRICE_LABEL}</p>
							<p class="card-price">{card.priceLabel}</p>
							<p class="section-label">{POSITIONS_CLOSES_LABEL}</p>
							<p class="card-when">{closesInPhrase(card.closesAt, nowIso)}</p>
							<p class="card-when">
								{#if absolute[card.fantraxPlayerId] !== undefined}
									{absolute[card.fantraxPlayerId]}
								{/if}
							</p>
							<!-- What the lead commits against the Cap, and when it is
							     released — a per-Auction consequence, never a
							     per-Team Maximum Bid. The strip owns that figure. -->
							<p class="prose">{card.commitmentSentence}</p>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if positions.contending.length > 0}
			<section class="group" id="group-contending">
				<h2 class="section-label">{GROUP_HEADINGS.contending}</h2>
				<ul class="cards">
					{#each positions.contending as card (card.fantraxPlayerId)}
						<!-- The 3px `lottery` left bar marks a Minimum-Bid Contention
						     and nothing else in the system. It never carries the
						     state alone: the icon and the word beside it are what
						     make a greyscale screenshot read identically. -->
						<li class="card lottery">
							<a class="card-link" href={card.href}>
								<span class="display card-player">{card.playerName}</span>
							</a>
							{#if card.metadata !== null}
								<p class="card-metadata">{card.metadata}</p>
							{/if}

							<!-- Ambient, so no chip: a Team in a lottery has not been
							     outbid and does not lead, it is waiting on a draw. -->
							<p class="state state-ambient">
								<span class="chip-icon" aria-hidden="true">{card.stateIcon}</span>
								<span class="chip-word">{card.stateLabel}</span>
							</p>
							<p class="state state-lottery">
								<span class="chip-word">{card.contentionLabel}</span>
							</p>

							<p class="section-label">{POSITIONS_PRICE_LABEL}</p>
							<p class="card-price">{card.priceLabel}</p>
							<p class="prose">{card.contenderCountSentence}</p>
							<p class="prose">{card.clockSentence}</p>
							<p class="section-label">{POSITIONS_CLOSES_LABEL}</p>
							<p class="card-when">{closesInPhrase(card.closesAt, nowIso)}</p>
							<p class="card-when">
								{#if absolute[card.fantraxPlayerId] !== undefined}
									{absolute[card.fantraxPlayerId]}
								{/if}
							</p>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<section class="group" id="group-nomination-slot">
			<h2 class="section-label">{GROUP_HEADINGS.nomination_slot}</h2>
			<div class="card">
				<p class="prose" id="nomination-slot-statement">{positions.nominationSlot.sentence}</p>
				{#if positions.nominationSlot.used && positions.nominationSlot.href !== null}
					<p class="prose">
						<a href={positions.nominationSlot.href} id="nomination-slot-link">
							{positions.nominationSlot.playerName}
						</a>
					</p>
				{:else}
					<p class="prose">
						<a href={NOMINATE_PATH} id="nomination-slot-action">{POSITIONS_NOMINATE_ACTION}</a>
					</p>
				{/if}
			</div>
		</section>

		<section class="panel">
			<p class="prose"><a href={BOARD_PATH} id="positions-board-link">{POSITIONS_BOARD_ACTION}</a></p>
		</section>
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
	 * One column at every width. `EXPERIENCE.md` requires every Manager
	 * surface to be single-column at 375px with no lateral scrolling.
	 */
	.group {
		display: flex;
		flex-direction: column;
		gap: var(--space-card-gap);
		width: 100%;
	}

	.cards {
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
	 * `text-secondary` label DESIGN.md:194 specifies for the ambient states.
	 * `.chip` is added on top for the two states that earn one.
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

	/* The lottery's own label takes the lottery text colour and no chip. */
	.state-lottery {
		color: var(--color-lottery-text);
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
	 * else.
	 */
	.chip-outbid {
		background-color: var(--color-attention);
		color: var(--color-attention-ink);
	}

	/*
	 * The re-entry answer sits above the gate rows, separated from the card's
	 * facts by a rule — it is a conclusion drawn from them, not another one.
	 * A blocked answer takes `text` rather than `attention`: the chip already
	 * carries the one attention colour on this card, and a second use of it
	 * would stop the chip meaning anything.
	 */
	.re-entry {
		border-top: var(--border-width) solid var(--color-border);
		padding-top: var(--space-row-gap);
		font-size: var(--size-11);
		line-height: 1.55;
		color: var(--color-text-prose);
	}

	.re-entry-blocked {
		color: var(--color-text);
	}

	.gates {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		list-style: none;
		width: 100%;
	}

	.gate {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.gate-chip {
		font-size: var(--size-10);
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--color-text-secondary);
	}

	.gate-figure {
		font-size: var(--size-11);
		font-variant-numeric: var(--numerals);
		color: var(--color-text-tertiary);
	}
</style>
