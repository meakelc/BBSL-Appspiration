<script lang="ts">
	// The Manager-facing nomination gate (Story 2.1).
	//
	// Every control here is a MANAGER control in a Manager block. Nothing on
	// this page is an administrative act: nominating is the ordinary thing a
	// Manager came here to do, so the Commissioner classes — dashed, never
	// filled, labelled "Commissioner" — would be a lie about who this
	// belongs to.
	//
	// Nomination is a TWO-PART act: choosing a Player is not nominating them.
	// The radio selects; the confirm is a separate deliberate tick; the submit
	// acts. Selecting never submits, because the Slot is spent for the whole
	// of that Player's Auction and a mis-tap must not spend it. What the act
	// costs is stated ONCE, behind the disclosure on the section heading —
	// beneath the confirmation as well it was the same sentence twice on one
	// screen, and was read as small print.
	//
	// No sentence here is written here. The pool arrives already worded by
	// the pure core through the server, so each refusal and the consequence
	// have exactly one definition in the codebase and this file cannot drift
	// from them.
	//
	// No suggested Player, no ranking, no "similar players": the list is the
	// pool in the order the Fantrax export supplied it and nothing else. A
	// ranked list is advice the product does not have the standing to give,
	// and it would make the nomination the app's decision rather than the
	// Manager's — repeating the file's own order is not that, and it is the
	// order every Manager has already been reading in Fantrax. The server
	// decides it (`server/nomination.ts`); nothing here re-sorts.
	//
	// Types are declared structurally rather than imported from a server-only
	// module: nothing in the server-only library may ever be reachable from a
	// `.svelte` file.
	//
	// Since Story 4.1 the Nomination control joins the freshness contract: in
	// Stale it is disabled with its reason stated, from the same one derivation
	// every other surface reads. `$lib/core` is the pure core and is what AD-2
	// says both runtimes load, so importing the sentence from it is the same
	// move the Auction page already makes; nothing server-only is reachable
	// from here.
	import { STALE_NOMINATION_REASON } from '$lib/core/freshness.ts';
	import { nominationConfirmPrompt } from '$lib/core/rules/nomination.ts';
	import {
		POOL_POSITIONS,
		POOL_POSITION_LEGEND,
		POOL_POSITION_NAMES,
		POOL_SEARCH_LABEL,
		POOL_SHOW_UNAVAILABLE_LABEL,
		countUnavailable,
		filterPool,
		hiddenPoolSentence,
		isFiltering,
		poolCountSentence
	} from '$lib/core/pool-filter.ts';
	import { freshness } from '$lib/client/freshness.svelte.ts';

	import type { ActionData, PageData } from './$types';

	type PoolPlayer = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly positions: string;
		readonly nbaTeam: string;
		readonly available: boolean;
		readonly status: string;
	};

	type Pool = {
		readonly players: readonly PoolPlayer[];
		readonly slotAvailable: boolean;
		readonly slotDetail: string | null;
		/** The Slot at rest, in one line, or `null` when a refusal owns it. */
		readonly slotStatus: string | null;
		readonly consequence: string;
		/** Whether this actor's nomination spends a Slot (Story 9.8). */
		readonly spendsSlot: boolean;
	};

	type NominateForm = {
		readonly notice?: string;
		readonly appended?: {
			readonly seq: string;
			readonly occurredAt: string;
			readonly deviceClass: string | null;
		} | null;
	};

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const pool = $derived(data.pool as Pool);
	const nominateForm = $derived(form as NominateForm | undefined);
	const notice = $derived(nominateForm?.notice);
	const appended = $derived(nominateForm?.appended ?? null);

	/** The chosen Player. Choosing is not nominating: the server decides. */
	let selected = $state('');

	/** The confirmation. Ticking it is not nominating either. */
	let confirmed = $state(false);

	const chosen = $derived(pool.players.find((player) => player.fantraxPlayerId === selected) ?? null);

	/**
	 * What the Manager has asked to look at. Narrowing only — it changes what
	 * is RENDERED and nothing else.
	 *
	 * No control here is posted, none is a gate, and none is sent to the
	 * server: the pool arrives whole and the server re-derives every gate under
	 * the lock on submit regardless of what this page was showing. A filter
	 * that could change a refusal would be a rule wearing a control's costume.
	 *
	 * Held here as plain state, decided in `core/pool-filter.ts`. This file
	 * words nothing about it, exactly as it words no refusal.
	 */
	let search = $state('');
	let positions = $state<string[]>([]);

	/**
	 * Whether the Players who cannot be nominated are listed.
	 *
	 * `false` at rest, which is the one default on this page that hides
	 * something. By the middle of an auction most of the pool is a Player
	 * somebody already nominated, and those rows cannot be tapped — a list
	 * whose majority refuses the tap is a list a Manager scrolls past rather
	 * than reads. They are one control away, not gone.
	 *
	 * It is still only RENDERING. Hiding a row changes nothing about the gate:
	 * an unavailable Player was already unnominatable with their row on
	 * screen, and the server re-derives every refusal under the lock.
	 */
	let showUnavailable = $state(false);

	const filter = $derived({ search, positions, showUnavailable });

	/** How much of the pool the availability default is holding back. */
	const hiddenCount = $derived(countUnavailable(pool.players));

	/**
	 * The rows to render.
	 *
	 * The CHOSEN Player always survives, and that is not a nicety: their radio
	 * is the only thing carrying the selection, so filtering them out would
	 * unmount it and submit a form naming nobody. `filterPool` owns that rule;
	 * this passes the one id it applies to.
	 */
	const shown = $derived(filterPool(pool.players, filter, selected === '' ? [] : [selected]));

	/** Whether the chosen Player is on screen only because they were chosen. */
	const chosenPinned = $derived(
		chosen !== null && isFiltering(filter) && !matchesFilter(chosen)
	);

	function matchesFilter(player: PoolPlayer): boolean {
		// Asked of the ONE evaluator rather than re-tested here: a second
		// predicate is how a list and its own explanation come to disagree.
		return filterPool([player], filter).length === 1;
	}

	/**
	 * The freshness state, from the ONE contract the layout mounts (AD-29).
	 * Read, never derived — `core/freshness.ts` decides it.
	 */
	const staleBlocked = $derived(freshness.state === 'stale');

	/**
	 * The one flag both the affordance and the stated reason read from. The
	 * server re-derives every gate under the lock regardless — disabling a
	 * control is never the check.
	 *
	 * Stale JOINS this existing path rather than adding a second one: AD-29's
	 * obligation is a disabled control with its reason stated, and that
	 * mechanism is already right here.
	 */
	const blocked = $derived(
		!pool.slotAvailable || chosen === null || !confirmed || staleBlocked
	);
</script>

<svelte:head>
	<title>Nominate — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1>Nominate a Free Agent</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	<section class="manager-block">
		<p class="section-label">Your Nomination Slot</p>
		<!-- Whether this Team may nominate at all, stated once and in words,
		     rather than greying out every row as though every Player were
		     unavailable. The sentence is the core's.

		     ONE LINE, and it used to be three. The panel was printing a
		     refusal sentence at rest — a reply, ending in "Nothing was
		     written", to a submit nobody had made — and on a phone those lines
		     pushed the filter, the list and the control itself off the first
		     screen. `nominationSlotStatus` is the status the panel actually
		     wanted: open, or the name of the Player holding the Slot.

		     `slotDetail` still speaks for every OTHER reason the Slot is
		     unavailable — the wrong phase, an unbound actor — because those
		     are refusals and its sentence is the one that owns them. A refused
		     submit still gets it in full, below. -->
		<p class="prose" id="nominate-slot">
			{#if pool.slotStatus !== null}
				{pool.slotStatus}
			{:else}
				{pool.slotDetail}
			{/if}
		</p>
	</section>

	<section class="manager-block">
		<!--
			The heading, with what a nomination costs behind it.

			`<details>`/`<summary>` and not a tooltip element: a real tooltip is
			hover, and this page is designed for a phone where there is no
			hover. The disclosure opens on tap AND on Enter, is announced as
			expanded or collapsed, and needs no script — the same pattern the
			persistent strip's own sheet already uses, so this introduces none.

			It is CLOSED by default, and since the confirmation stopped
			repeating it this is the ONE place the consequence is stated. That
			is a deliberate trade: the sentence ran beneath the confirmation as
			well until the same ~40 words appeared twice on one screen, at
			which point the second copy read as small print rather than as a
			thing to read. What a Manager cannot miss is the act itself — the
			Slot is spent by a separate, deliberate tick, and the control says
			so — and the cost is one tap from the heading of the box it belongs
			to rather than set under a checkbox.
		-->
		<details class="explainer">
			<summary>
				<span class="section-label">Nominate a Player</span>
				<!-- The affordance, as a mark rather than a sentence. Drawn in
				     `em` off the summary's own font and stroked from
				     `currentColor`, the way the strip's burger is, so it tracks
				     the text instead of pinning a second size literal in.

				     `aria-hidden`, because a screen reader is already told this
				     is a disclosure and whether it is expanded — an icon
				     announced beside that would be the control named twice. The
				     words the icon stands in for are carried by the hidden span
				     below, so the trigger still says what expanding it reveals
				     rather than leaving "Nominate a Player" to imply it. -->
				<span class="explainer-mark" aria-hidden="true">
					<svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
						<circle cx="8" cy="8" r="6.5" />
						<path d="M8 7.25v4" />
						<path d="M8 4.75v.5" />
					</svg>
				</span>
				<span class="visually-hidden">What does nominating cost?</span>
			</summary>
			<p class="prose">{pool.consequence}</p>
		</details>

		{#if pool.players.length === 0}
			<p class="prose">
				The Free Agent pool is empty. There is nobody to nominate until an import has been
				promoted.
			</p>
		{:else}
			<!--
				Narrowing the list, above the list it narrows.

				~1,470 Players is more than anyone scrolls. Both controls change
				only what is RENDERED: neither is posted, neither is a gate, and
				the server re-derives everything under the lock on submit
				regardless of what this page was showing.

				They sit OUTSIDE the form on purpose. A text input inside a form
				submits it on Enter in every browser, and on this form that key
				press would be a nomination — the one act that must never happen
				by accident, because the Slot is spent for the whole of that
				Player's Auction. Keeping them out of the form makes that
				impossible in the markup rather than prevented by a handler.
			-->
			<div class="pool-filter">
				<label class="filter-search" for="pool-search">
					<span class="section-label">{POOL_SEARCH_LABEL}</span>
					<input
						id="pool-search"
						type="search"
						autocomplete="off"
						placeholder="Derrick White, or LAL"
						bind:value={search}
					/>
				</label>

				<fieldset class="filter-positions">
					<legend class="section-label">{POOL_POSITION_LEGEND}</legend>
					<!--
						Checkboxes, not radios: the tokens are ORed, so picking
						`PG` and `SG` asks for either. A single-select would make
						"guards" unaskable except through the export's own `G`
						umbrella, which is a different question.

						The chip shows the abbreviation because that is what the
						rows say; the spelled-out name is the accessible name, so
						a screen reader says "Point guard" and not "P G".
					-->
					{#each POOL_POSITIONS as position (position)}
						<label class="chip" for={`position-${position}`}>
							<input
								id={`position-${position}`}
								type="checkbox"
								value={position}
								bind:group={positions}
							/>
							<span aria-hidden="true">{position}</span>
							<span class="visually-hidden">{POOL_POSITION_NAMES[position]}</span>
						</label>
					{/each}
				</fieldset>

				<!--
					The Players who cannot be nominated, and the one control that
					brings them back.

					HIDDEN BY DEFAULT. Every one of these rows is a radio that
					refuses the tap, and by the middle of an auction they are
					most of the pool — so the list a Manager scrolls is mostly
					Players they cannot have, with the ones they can scattered
					through it. Hiding them is a change to what is RENDERED and
					to nothing else: the gate that made the row unavailable is
					the server's, it is unchanged, and it is re-derived under the
					lock on submit.

					They are not gone, because "who went already" is a real
					question and this page is the only list that answers it. One
					tap opens the disclosure, one tick puts them back — greyed,
					with the same state phrase their rows always carried.

					A `<details>` and not a permanently visible checkbox, for the
					reason the cost disclosure above is one: this is a phone-first
					page whose first screen already carries a search field, seven
					chips, a count and the list itself. The summary states the
					fact so a collapsed control still says what it is holding
					back; the instruction is on the checkbox inside it.
				-->
				<details class="explainer filter-hidden">
					<summary>
						<span class="prose">{hiddenPoolSentence(hiddenCount, filter)}</span>
						<!-- The affordance as a mark, `aria-hidden` because the
						     disclosure is already announced as expanded or
						     collapsed — the cost disclosure's own reasoning, and
						     its styles. A chevron rather than the info circle:
						     what opens here is a control, not a sentence. -->
						<span class="explainer-mark" aria-hidden="true">
							<svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
								<path d="M4 6.5 8 10.5l4-4" />
							</svg>
						</span>
					</summary>
					<label class="show-unavailable" for="show-unavailable">
						<input id="show-unavailable" type="checkbox" bind:checked={showUnavailable} />
						<span class="prose">{POOL_SHOW_UNAVAILABLE_LABEL}</span>
					</label>
				</details>

				<!--
					How much of the pool is showing, once there is something to
					say — and it is announced, because a Manager who types into
					the search has no other way to learn that they narrowed
					1,467 Players down to none.

					It says ONE thing: that the filter matched nobody. There is
					no running count — "Showing 42 of 1,467" was arithmetic
					about a list that is on screen to be read, it moved on every
					keystroke, and neither number is one a Manager does anything
					with.

					The empty region stays in the DOM while it has nothing to
					say, because a live region that is added and removed is not
					announced by every screen reader — and the sentence it
					carries is the one a Manager who narrowed the pool to
					nothing cannot do without. `poolCountSentence` decides when
					it speaks.

					There is no line explaining that no position is picked
					either. Seven unfilled chips already say that, and a
					sentence restating the state of a control the Manager is
					looking at is the page talking to itself.
				-->
				<p class="prose" role="status">
					{poolCountSentence(shown.length, pool.players.length, filter)}
				</p>
				{#if chosenPinned && chosen !== null}
					<p class="prose">
						{chosen.playerName} does not match the filter and is listed anyway, because
						they are the Player you chose. Choosing another, or clearing the choice,
						removes them.
					</p>
				{/if}
			</div>

			<form method="POST" action="?/nominate">
				<!--
					One markup for both widths, not two. A second, hidden copy of
					this list would post a second `fantraxPlayerId` for every
					Player, which is a submission bug rather than a layout choice.
					Below 640px every cell is a block and states its own word —
					in hidden text, since `PG,SG,G` and `BOS` are legible
					without a label in front of them — so no column header has
					to be visible; at 640px the same rows become a real table
					with `scope` headers, and those hidden words are dropped
					rather than doubling the headers. The breakpoint is the one
					`/import` established.

					Single-select by `type="radio"`, not a checkbox: a Team has one
					Nomination Slot, so the markup itself makes two selections
					impossible rather than leaving the server to refuse a second.
				-->
				<!--
					Rendered only when the filter left something to render. An
					empty `tbody` still draws its column headers at 640px, which
					reads as a pool that has lost its Players rather than a
					filter that matched none — and the sentence saying which of
					those it is has already been printed above.
				-->
				{#if shown.length > 0}
					<table class="pool-table">
						<caption class="section-label">The Free Agent pool</caption>
						<thead>
							<tr>
								<th scope="col">Chosen</th>
								<th scope="col">Player</th>
								<th scope="col">Positions</th>
								<th scope="col">NBA team</th>
								<th scope="col">Availability</th>
							</tr>
						</thead>
						<tbody>
							{#each shown as player (player.fantraxPlayerId)}
								<!-- The row carries the availability, not just the state cell:
								     the NAME is what a Manager scans, and a name at full
								     strength beside a disabled radio reads as a Player they
								     may still pick. Greying it is the second half of what the
								     state phrase says, in the place the eye actually lands. -->
								<tr class:unavailable={!player.available}>
									<td class="cell-select">
										<label class="row-select" for={`player-${player.fantraxPlayerId}`}>
											<input
												id={`player-${player.fantraxPlayerId}`}
												name="fantraxPlayerId"
												type="radio"
												value={player.fantraxPlayerId}
												disabled={!player.available}
												aria-describedby={player.available
													? undefined
													: `state-${player.fantraxPlayerId}`}
												bind:group={selected}
											/>
											<span class="visually-hidden">Choose {player.playerName}</span>
										</label>
									</td>
									<th scope="row" class="cell-player">{player.playerName}</th>
									<!-- The words "Positions" and "NBA team" are SPOKEN, not shown.
									     `PG,SG,G` and `BOS` say what they are; a label in front of
									     each is clutter on a phone and a second copy of the column
									     header at 640px. But below 640px the table is laid out as
									     blocks, which strips its table semantics from the
									     accessibility tree along with the headers — so the label is
									     carried in hidden text there, and dropped at 640px where the
									     real `scope="col"` headers are announced again. -->
									<td class="cell-detail">
										<span class="visually-hidden cell-label">Positions: </span>{player.positions}
									</td>
									<td class="cell-detail">
										<span class="visually-hidden cell-label">NBA team: </span>{player.nbaTeam}
									</td>
									<!-- ONE phrase, and the disabled radio is described BY it:
									     `Nominated`, `In-Auction` or `Closed to <Team>` says which
									     state the row is in, which is what the reason paragraph
									     underneath it used to spend a whole sentence saying. The
									     paragraph was a submit's refusal — it ended in "Nothing was
									     written" about a submit nobody had made — repeated down a
									     pool of ~1,470 rows. Still worded by the core; the surface
									     prints. -->
									<td class="cell-state">
										<span class="visually-hidden cell-label">Availability: </span><span
											class="state-label"
											id={player.available ? undefined : `state-${player.fantraxPlayerId}`}
											>{player.status}</span
										>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}

				<!--
					The second half of the act travels WITH the Manager down the
					list, rather than waiting at the bottom of it.

					The pool is ~1,470 Players. Choosing a Player used to leave
					the confirmation and the control an entire pool's worth of
					scrolling away, with no sign at the point of choosing that
					either existed — so the two-part act read as a broken
					one-part act. Sticking this bar to the bottom of the viewport
					does not make it one part: the confirmation is still a
					separate deliberate tick, and choosing still never submits.
					It only stops the second part being hidden.

					`position: sticky` and not `fixed`: the bar belongs to the
					form, so it scrolls into its own place at the end of the list
					and does not sit over the page when there is nothing below it.

					The reason a disabled control is disabled now sits INSIDE the
					bar, beside the control it describes, instead of above a list
					the Manager has already scrolled past. It is the same one
					sentence set, still the core's words, still carrying the id
					`aria-describedby` names — and it lives in the same branch as
					the button, so the reference cannot dangle.
				-->
				<div class="action-bar">
					<p class="prose" id="nominate-availability">
						<!-- Stale is stated FIRST, above every other reason. When the app
						     cannot confirm the pool or the Slot, the facts the other
						     branches speak from are exactly what is in doubt. -->
						{#if staleBlocked}
							{STALE_NOMINATION_REASON}
						{:else if !pool.slotAvailable}
							<!-- The fact, and not a pointer to where the fact is. The
							     Slot panel states WHY in one line, at the top of a page
							     short enough that "see above" is a sentence spent
							     telling a Manager to look up. -->
							You cannot nominate right now.
						{:else if chosen === null}
							No Player is chosen. Choose exactly one Player from the list to enable
							the confirmation.
						{:else if !confirmed}
							<!-- The core's sentence, not this file's (Story 9.8). It used to
							     be markup here, saying a Slot was held — which is false for
							     a Commissioner, who spends none. A surface may not word a
							     rule, and this is the rule about what confirming does. -->
							{nominationConfirmPrompt(chosen.playerName, pool.spendsSlot)}
						{:else}
							{chosen.playerName} is chosen and the confirmation has been given. The
							gate is re-derived from the event log when you submit.
						{/if}
					</p>

					<!-- The second part of the two-part act, separate from the
					     selection above.

					     It no longer repeats the consequence. That sentence has one
					     home now — the disclosure on this section's heading — and
					     printing it here as well put the same ~40 words twice on
					     one screen, where the second copy read as small print
					     rather than as a thing to read. The act is still two parts
					     and the tick is still deliberate; what is gone is the
					     duplicate, not the telling. -->
					<label class="confirm" for="nominate-confirm">
						<input
							id="nominate-confirm"
							name="confirm"
							type="checkbox"
							value="yes"
							bind:checked={confirmed}
						/>
						<span class="prose">I confirm this nomination.</span>
					</label>

					<button
						class="control-manager"
						type="submit"
						disabled={blocked}
						aria-describedby="nominate-availability"
					>
						Nominate the chosen Player
					</button>
				</div>
			</form>
		{/if}

		<!-- The outcome of a submit is the only place a Manager learns whether
		     the nomination landed, and after a form post the focus is still on
		     the control that was pressed. `role="status"` announces it
		     politely rather than leaving a screen reader user to go looking. -->
		<div role="status">
			{#if notice}
				<p class="prose" id="nominate-notice">{notice}</p>
			{/if}
			{#if appended}
				<p class="prose">
					One NominationPlaced event was appended, at sequence {appended.seq}, naming you,
					your Team and the Player. Your Slot, the Bid Board and the League Clock are
					folds of that event; no flag was set anywhere.
				</p>
			{/if}
		</div>
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

	form {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-row-gap);
		width: 100%;
	}

	/*
	 * The second half of the act, stuck to the bottom of the viewport for as
	 * long as there is list left below it, and settling into place at the end.
	 *
	 * It is opaque and bordered on purpose: it sits over pool rows while
	 * scrolling, and a translucent bar would leave a Player's name showing
	 * through the sentence that states what nominating costs.
	 *
	 * `bottom: 0` and not a negative offset: the seam under the bar is closed
	 * by whatever the bar is sitting on — the strip's own top border below
	 * 640px, and the end of the page otherwise. A negative offset to hide a
	 * hairline is how the bar came to sit ON the strip in the first place.
	 */
	.action-bar {
		position: sticky;
		bottom: 0;
		/*
		 * NO `z-index`, deliberately, and this is the whole of what keeps the
		 * strip's menu usable.
		 *
		 * `position: sticky` already puts this above the pool rows: a
		 * positioned element paints above non-positioned content, and every
		 * row here is non-positioned. It needs nothing more than that.
		 *
		 * It carried `z-index: 1` until the strip's sheet was opened over it.
		 * The strip is `z-index: 1` too, and the layout mounts it BEFORE the
		 * page content — so at equal z-index the later element wins and this
		 * bar painted on top of the menu. The sheet expands upward from a
		 * bottom-pinned strip to as much as 60svh, so what it covered was most
		 * of the open menu.
		 *
		 * Leaving this at `auto` makes the strip authoritative over page
		 * content, which is the right way round: the strip is the app's chrome
		 * and is on every surface, and a route's own bar has no business
		 * outranking it.
		 */
		align-self: stretch;
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		align-items: flex-start;
		padding: var(--space-row-gap) 0;
		/* The Manager block's own ground, so the bar reads as part of it. */
		background-color: var(--color-surface);
		border-top: var(--border-width) solid var(--color-border-strong);
	}

	/*
	 * The MOBILE DESTINATION BAR is FIXED to the bottom of the viewport below
	 * 640px (`MobileNav.svelte`), and a sticky element's offset is measured
	 * against that same viewport — so `bottom: 0` would park this bar
	 * underneath the nav and hide the control this whole change exists to
	 * make reachable. It clears it by exactly `--nav-height`, the token the
	 * nav is sized from and the room `global.css` reserves, so the two can
	 * only ever agree.
	 *
	 * **It used to clear `--strip-height`, and the swap is the whole point of
	 * the move.** The persistent strip held this edge until the nav bar took
	 * it; the strip is pinned to the TOP now and nothing about it is down
	 * here to clear. Clearing the strip's token against the nav's bar would
	 * be 52px of clearance for a 60px obstruction — the control eight pixels
	 * under the thing it must sit above.
	 *
	 * Gated on `body:has(.mobile-nav)` for `global.css`'s reason: the nav does
	 * not mount for every viewer on every page, and clearing 60px of nothing
	 * would float the bar above the fold of its own accord.
	 *
	 * The WHOLE token, not the token minus a pixel. The nav occupies exactly
	 * `--nav-height`, its 1px border inside that height, so clearing the full
	 * token puts this bar's bottom edge against the nav's top border with
	 * nothing behind it and nothing over it.
	 */
	:global(body:has(.mobile-nav)) .action-bar {
		bottom: var(--nav-height);
	}

	/* At 640px the nav bar does not render at all, so there is nothing down
	   here to clear — and the strip is `position: static` under the header
	   rather than pinned anywhere. */
	@media (min-width: 640px) {
		:global(body:has(.mobile-nav)) .action-bar {
			bottom: 0;
		}
	}

	/*
	 * Centred, not top-aligned, and that is what closes the gap to the button.
	 *
	 * The `min-height` is the touch target and stays: this is the control that
	 * spends the Nomination Slot. But `flex-start` pinned one short line of
	 * text to the top of a 44px box and left the whole remainder as dead space
	 * underneath — so the confirmation floated ~25px above the button it
	 * belongs with, and no gap anywhere was responsible for it. The sentence
	 * used to run to three lines and fill that box; it has been one line since
	 * the consequence stopped being repeated here.
	 */
	.confirm {
		display: flex;
		align-items: center;
		gap: var(--space-row-gap);
		min-height: var(--touch-min);
	}

	.confirm input[type='checkbox'] {
		width: 22px;
		height: 22px;
		/* No `margin-top`. It nudged the box onto the first line of text under
		   `flex-start`; against a centred line it would only push the box off
		   centre by the same 2px. */
		/* The interactive token: this is a Manager control in a Manager block. */
		accent-color: var(--color-border-interactive);
	}

	/*
	 * The heading and the cost behind it.
	 *
	 * NO `--control-height` here. A 46px row around a 12px section label put
	 * 17px of nothing above and below the heading of the box that holds the
	 * whole list — the tallest thing in the panel was its own title.
	 *
	 * The target is not lost with it. The summary spans the panel's full
	 * width, so the row is a wide target however short it is, and the mark
	 * below carries a padded hit box of its own. This is also the one control
	 * on the page whose mis-tap costs nothing: it opens a sentence. The 44px
	 * floor is kept, untouched, on every control that spends something — the
	 * row radios, the confirmation and the submit.
	 */
	.explainer > summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-row-gap);
		cursor: pointer;
		/* The hint carries the affordance; a second marker beside it would be
		   two affordances stacked against each other — the strip's reasoning
		   for dropping the default marker on its own disclosure. */
		list-style: none;
	}

	.explainer > summary::-webkit-details-marker {
		display: none;
	}

	/*
	 * The sighted affordance, and nothing else — the words it stands in for
	 * are in the hidden span beside it, which is what a screen reader reads.
	 *
	 * Sized in `em` off the summary's own font and stroked from
	 * `currentColor`, exactly as `.strip-burger` is: the icon tracks the text
	 * rather than pinning a second size literal into the page.
	 */
	/*
	 * The padding is the tap target and the negative margin is what stops it
	 * being layout: the mark's margin box collapses back to the size of the
	 * glyph, so the hit area grows and the heading row does not.
	 */
	.explainer-mark {
		display: flex;
		flex-shrink: 0;
		padding: var(--space-row-gap);
		margin: calc(-1 * var(--space-row-gap));
		color: var(--color-text-tertiary);
	}

	.explainer-mark svg {
		width: 1.1em;
		height: 1.1em;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		fill: none;
	}

	/* Open or closed, the mark is the same mark; only the panel below moves. */
	.explainer[open] > summary .explainer-mark {
		color: var(--color-text);
	}

	.explainer[open] > summary {
		margin-bottom: var(--space-row-gap);
	}

	.explainer > summary:focus-visible {
		outline: 2px solid var(--color-text);
		outline-offset: 2px;
	}

	/*
	 * The narrowing controls, above the list they narrow.
	 *
	 * Not sticky, deliberately, and this is the asymmetry with the action bar
	 * below. The bar has to follow the Manager because the act it carries is
	 * one they are in the middle of; the filter is set once and then read past.
	 * A second sticky band would eat a third of a 375px viewport to save a
	 * scroll to the top that a Manager makes once.
	 */
	.pool-filter {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		width: 100%;
	}

	.filter-search {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	/*
	 * `--color-surface-sunken` is the token for an input field, and the
	 * interactive border is mandatory on every input (DESIGN.md), which is
	 * what keeps the control legible as a control without relying on hue.
	 */
	.filter-search input {
		min-height: var(--control-height);
		padding: 0 var(--space-row-gap);
		color: var(--color-text);
		font: inherit;
		background-color: var(--color-surface-sunken);
		border: var(--border-width) solid var(--color-border-interactive);
		border-radius: var(--rounded-panel);
	}

	/* A fieldset's own chrome says nothing here; the legend carries the label. */
	/*
	 * Held off the search field above it. `.pool-filter`'s own gap spaces
	 * every sibling equally, which read as one undifferentiated stack: the
	 * legend sat as close to the field it has nothing to do with as to the
	 * chips it names. Doubling the gap here is what makes the two controls
	 * two groups.
	 */
	.filter-positions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-row-gap);
		align-items: center;
		padding: 0;
		margin: var(--space-row-gap) 0 0;
		border: 0;
	}

	.filter-positions legend {
		/* Its own line above the chips rather than notched into a border. */
		float: left;
		width: 100%;
		padding: 0;
		/*
		 * NO margin. The fieldset is a wrapped flex row, so its own
		 * `row-gap` already sets the distance to the chips; a margin on top
		 * of it doubled that and left the legend floating between the two
		 * groups rather than belonging to the one below it.
		 */
	}

	/*
	 * The hidden-Player disclosure, sitting under the chips as a third filter.
	 *
	 * It borrows `.explainer`'s summary rules — the flex row, the dropped
	 * marker, the mark's tap target — because it IS that pattern: a summary
	 * that states something and a body that carries the rest. What it adds is
	 * the room above, which separates it from the chips the way the chips are
	 * separated from the search field.
	 *
	 * Its summary carries a sentence rather than a section label, so the text
	 * is allowed to wrap and the mark is pinned to the first line rather than
	 * centred against two.
	 */
	.filter-hidden {
		margin-top: var(--space-row-gap);
		color: var(--color-text-tertiary);
	}

	.filter-hidden > summary {
		align-items: flex-start;
	}

	/* The sentence takes the row and the mark keeps its place at the end of
	   it: a wrapped flex row would otherwise drop the mark to its own line
	   the moment the count reached four digits. */
	.filter-hidden > summary .prose {
		flex: 1 1 auto;
		min-width: 0;
	}

	/* The chevron turns to point at what it opened, which is the one state a
	   collapsed disclosure cannot say in words it is already using. */
	.filter-hidden[open] .explainer-mark svg {
		transform: rotate(180deg);
	}

	/*
	 * The control itself, at the full touch height.
	 *
	 * It is `--control-height` here and NOT the chips' lighter padding: a chip
	 * is one of seven on a wrapped line and its mis-tap is undone by the next
	 * tap, while this is a single control behind a disclosure whose mis-tap
	 * re-lists ~1,200 rows and moves everything below it.
	 */
	.show-unavailable {
		display: flex;
		align-items: center;
		gap: var(--space-row-gap);
		min-height: var(--control-height);
		color: var(--color-text);
	}

	.show-unavailable input[type='checkbox'] {
		width: 22px;
		height: 22px;
		accent-color: var(--color-border-interactive);
	}

	/*
	 * A chip is a label wrapping its own checkbox, so the whole chip is the
	 * target at the full control height — the same reason `.row-select` is
	 * the target for a pool row rather than the 22px dot inside it.
	 *
	 * The checkbox itself stays in the accessibility tree and stays operable
	 * by keyboard; it is only its default rendering that is dropped, because
	 * a box beside a two-letter word doubles the width of every chip and
	 * seven of them then do not fit a 375px line.
	 */
	.chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		/*
		 * Sized by its own padding, not by `--control-height`. That token is
		 * the BID control's height and carries the 44px touch floor with it,
		 * which is right for a control that spends money or a Nomination Slot
		 * — a mis-tap there is unrecoverable, and this page says so out loud.
		 * A filter chip is the opposite: a mis-tap changes what is on screen
		 * and is undone by tapping again. Seven 46px slabs for two-letter
		 * words made the filter look heavier than the list it filters.
		 *
		 * The width still holds the floor, so the target stays generous in
		 * the axis the chips are actually scanned and tapped along.
		 */
		min-width: var(--touch-min);
		padding: var(--space-row-gap) var(--space-card-gap);
		color: var(--color-text);
		background-color: var(--color-surface-sunken);
		border: var(--border-width) solid var(--color-border-interactive);
		/* The chip radius, which exists for exactly this. */
		border-radius: var(--rounded-chip);
	}

	.chip input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
	}

	/*
	 * A picked chip is told apart by its FILL and its border weight, not by
	 * hue alone — the same legible-without-colour rule the strip follows. The
	 * focus ring is left to the browser's own `:focus-visible` on the input,
	 * which `:has` forwards to the chip so the ring is drawn around the thing
	 * that looks like the control.
	 */
	.chip:has(input:checked) {
		color: var(--color-ground);
		background-color: var(--color-border-interactive);
		border-color: var(--color-border-strong);
		font-weight: 600;
	}

	.chip:has(input:focus-visible) {
		outline: 2px solid var(--color-text);
		outline-offset: 2px;
	}

	/*
	 * The whole row is the target, at the 46px control height, so the list is
	 * operable one-handed at 375px without aiming at a 22px dot.
	 */
	.row-select {
		display: flex;
		align-items: center;
		gap: var(--space-row-gap);
		min-height: var(--control-height);
	}

	.row-select input[type='radio'] {
		width: 22px;
		height: 22px;
		accent-color: var(--color-border-interactive);
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}

	.state-label {
		display: block;
		color: var(--color-text);
		font-size: var(--size-12-5);
	}

	/*
	 * 375px is the design width and the smallest supported; 640px is where
	 * the table takes over, the same breakpoint `/import` established.
	 *
	 * Below the breakpoint every part of the table is laid out as a block, so
	 * one row is a stacked card and nothing scrolls laterally. The column
	 * headers are removed from the layout AND from the accessibility tree
	 * there (`display: none`), which is correct only because every cell below
	 * states its own words.
	 */
	.pool-table {
		display: block;
		width: 100%;
	}

	.pool-table caption {
		display: block;
		text-align: left;
		padding-bottom: var(--space-row-gap);
	}

	.pool-table thead {
		display: none;
	}

	.pool-table tbody {
		display: block;
	}

	/*
	 * ONE LINE per Player below 640px, not a four-line stack.
	 *
	 * A row was the radio, the name, the positions, the NBA team and the
	 * state, each on its own line: ~120px of card for four short facts, so a
	 * 375px screen held three Players out of 1,467. Laid out as a wrapping
	 * row instead, the same facts read as `◯ Derrick White  PG,SG,G  BOS
	 * Available` and a row is the height of its own tap target.
	 *
	 * `flex-wrap`, so nothing is ever cut off: a long name simply pushes the
	 * details onto a second line rather than truncating or overflowing. The
	 * vertical padding goes with the stack — `.row-select` already holds the
	 * row open at the 46px control height, and padding on top of that was
	 * spacing a card that no longer exists.
	 */
	.pool-table tr {
		display: flex;
		flex-direction: row;
		flex-wrap: wrap;
		align-items: center;
		column-gap: var(--space-card-gap);
		row-gap: 2px;
		border-top: var(--border-width) solid var(--color-border);
	}

	.pool-table td,
	.pool-table th {
		display: block;
		text-align: left;
		font-size: var(--size-12-5);
		color: var(--color-text-prose);
	}

	/*
	 * The name is the thing being read; the details sit beside it a size down
	 * and a shade back, which is what tells them apart now that no label
	 * does. `min-width: 0` lets a long name wrap rather than force the row
	 * wider than the screen.
	 */
	.pool-table .cell-player {
		flex: 0 1 auto;
		min-width: 0;
		color: var(--color-text);
		font-size: var(--size-15);
		font-weight: 400;
	}

	/*
	 * A Player who cannot be nominated recedes, and `--color-text-secondary`
	 * is how far: 7.1:1 on the ground, a clear step down from the 15.7:1 of
	 * `--color-text` and still comfortably past AA. NOT
	 * `--color-text-disabled` — that token is 2.7:1 and is exempt from 1.4.3
	 * only because it labels a CONTROL that states its reason beside it. A
	 * Player's name is content: it is the one thing on the row a Manager is
	 * reading, and it stays legible whether or not they may pick them.
	 *
	 * Colour alone carries nothing here. The state cell says `Nominated`,
	 * `In-Auction` or `Closed to <Team>` in words on the same row, and the
	 * radio is disabled and described by it, so nothing is known only by
	 * being grey (1.4.1).
	 */
	.pool-table tr.unavailable .cell-player {
		color: var(--color-text-secondary);
	}

	.pool-table .cell-select,
	.pool-table .cell-detail {
		flex: 0 0 auto;
	}

	/*
	 * Every state is now a PHRASE, not a sentence: "Available", "Nominated",
	 * "In-Auction", or "Closed to <Team>". The longest of them is a Team name
	 * wide, so the cell rides the same line as the rest of the row and simply
	 * wraps when the name is long — the whole-width row this used to take,
	 * when it carried a refusal paragraph, has nothing left to carry.
	 */
	.pool-table .cell-state {
		flex: 0 1 auto;
		min-width: 0;
	}

	@media (min-width: 640px) {
		/*
		 * The in-cell labels go, because the column headers are back and
		 * announced: at this width the table is a real table again, its
		 * `scope="col"` headers are in the accessibility tree, and a hidden
		 * "Positions:" inside the cell would have a screen reader say the
		 * column's name twice for every row of a 1,467-row list.
		 */
		.cell-label {
			display: none;
		}

		.pool-table {
			display: table;
			border-collapse: collapse;
		}

		.pool-table caption {
			display: table-caption;
		}

		.pool-table thead {
			display: table-header-group;
		}

		.pool-table tbody {
			display: table-row-group;
		}

		.pool-table tr {
			display: table-row;
		}

		.pool-table td,
		.pool-table th {
			display: table-cell;
			padding: var(--space-row-gap) var(--space-row-gap) var(--space-row-gap) 0;
			border-top: var(--border-width) solid var(--color-border);
			vertical-align: top;
		}

		.pool-table thead th {
			color: var(--color-text-tertiary);
			font-size: var(--size-10);
			text-transform: uppercase;
			letter-spacing: 0.16em;
		}
	}
</style>
