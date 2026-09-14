<script lang="ts">
	// One Team's view (Story 4.5).
	//
	// Three bands, in `DESIGN.md:178-192`'s own anatomy for the Teams row:
	// identity · slots · money. There is no per-Team mockup — `Teams.dc.html`
	// is the index ROW — so the row's three bands are what this page's summary
	// follows, at page scale.
	//
	// **No wording of its own.** Every heading, label and sentence arrives from
	// `$lib/core/team-view.ts`, which reaches its figures through
	// `baselineCapOutcome` — the persistent strip's own no-Auction probe. What
	// this file holds is structure and CSS.
	//
	// **Maximum Bid renders for the viewer's own Team and no other.** On a
	// rival's page the property is not on the payload at all, so the `{#if}`
	// below has nothing to render rather than something to hide.
	//
	// **Nothing here is coloured by comparison, ever** (`DESIGN.md:191`). No
	// median, no rank, no arrow, no chip. A greyscale screenshot of this
	// surface is not merely readable, it is identical.
	//
	// Types are declared structurally rather than imported from a server-only
	// module — the rule `nominate/+page.svelte` states and every page since
	// follows. `$lib/core` is a different matter: it is the pure core.
	import { TEAM_VIEW_LABELS, TEAM_VIEW_TITLE } from '$lib/core/team-view.ts';
	import { figuresAgeSentence } from '$lib/core/freshness.ts';
	import { freshness } from '$lib/client/freshness.svelte.ts';

	import CapBreakdown from '$lib/components/CapBreakdown.svelte';

	import type { PageData } from './$types';

	type RosterEntry = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly capHitLabel: string;
		readonly slotKind: string;
		readonly won: boolean;
		readonly wonSentence: string | null;
	};

	type RosterGroup = {
		readonly slotKind: string;
		readonly label: string;
		readonly entries: readonly RosterEntry[];
	};

	type AuctionEntry = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly amountLabel: string;
		readonly href: string;
	};

	type NominationSlotStatus = {
		readonly used: boolean;
		readonly fantraxPlayerId: string | null;
		readonly playerName: string | null;
		readonly sentence: string;
		readonly href: string | null;
	};

	type BreakdownLine = {
		readonly label: string;
		readonly figure: string;
		readonly operator: string;
		readonly kind: 'term' | 'detail' | 'subtotal';
	};

	type SlotSentenceHalves = {
		readonly full: string;
		readonly lead: string;
		readonly qualifier: string;
	};

	type TeamViewState = {
		readonly teamId: string;
		readonly teamName: string;
		readonly identity: string;
		readonly managerSuffix: string;
		readonly managerNames: readonly string[];
		readonly viewerIsThisTeam: boolean;
		readonly capSpaceLabel: string;
		readonly committedBidsLabel: string;
		readonly minorsExposureLabel: string;
		readonly availableCapSpaceLabel: string;
		readonly rosterCount: number;
		readonly rosterCountSentence: string;
		readonly activeBenchSentence: string;
		readonly minorLeagueSentence: string;
		readonly injuryReserveSentence: string;
		readonly rosterCountHalves: SlotSentenceHalves;
		readonly activeBenchHalves: SlotSentenceHalves;
		readonly minorLeagueHalves: SlotSentenceHalves;
		readonly injuryReserveHalves: SlotSentenceHalves;
		readonly deadMoneyHalves: SlotSentenceHalves | null;
		readonly roster: readonly RosterGroup[];
		readonly nominationSlot: NominationSlotStatus;
		readonly maximumBidLabel?: string;
		readonly capBreakdown?: readonly BreakdownLine[];
		readonly auctions?: readonly AuctionEntry[];
		readonly figuresAt: string;
	};

	let { data }: { data: PageData } = $props();

	const team = $derived(data.team as TeamViewState);

	/**
	 * The age of every figure on this page, in anything but Live (AD-29).
	 *
	 * The page takes the AGE branch of the freshness rule and not the disable
	 * branch, because there is no control here to disable — nothing on this
	 * surface authorises anything (`EXPERIENCE.md:139`). ONE line for the
	 * page, because every figure came from a single transaction anchored on a
	 * single `figuresAt`.
	 */
	const figuresAge = $derived(
		freshness.state === 'live'
			? null
			: figuresAgeSentence(freshness.lastLivenessOkAt, freshness.now)
	);

	/**
	 * The absolute stamp, computed in an `$effect` and therefore only in the
	 * browser — the SSR-leak rule `positions/+page.svelte:216-260` establishes.
	 * `Intl.DateTimeFormat(undefined, ...)` resolves `undefined` to the
	 * timezone of whatever machine formats it, so deriving this during SSR
	 * would ship the SERVER's timezone in the delivered HTML, which Svelte does
	 * not diff-correct on hydration. The markup omits the stamp until it exists
	 * rather than rendering one that is wrong for a paint.
	 */
	let readAt = $state<string | null>(null);

	// `Intl.DateTimeFormat.format` throws `RangeError` on an Invalid Date, so
	// an unreadable instant is checked for rather than formatted.
	function formatAbsolute(iso: string): string | null {
		const parsed = new Date(iso);
		if (Number.isNaN(parsed.getTime())) return null;
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(parsed);
	}

	$effect(() => {
		readAt = formatAbsolute(team.figuresAt);
	});
</script>

<svelte:head>
	<title>{team.teamName} — Appspiration</title>
</svelte:head>

<main class="page">
	<!-- Band one: identity. `ui` 15px, not Georgia — a fantasy Team is an
	     entity rather than a name being shopped for (DESIGN.md:181). Spelled
	     out with its Manager(s), never abbreviated. The two halves take two
	     registers (DESIGN.md:187): the Team name in `text` because the name is
	     the row's identity, the Manager beside it in `text-secondary`. Both
	     strings come from the core; this file never joins or splits them. -->
	<header class="masthead">
		<p class="section-label">{TEAM_VIEW_TITLE}</p>
		<h1 class="team-identity" id="team-identity"
			>{team.teamName}<span class="team-manager">{team.managerSuffix}</span></h1
		>
	</header>

	<!-- Every figure on this page carries its age in anything but Live
	     (AD-29). Nothing here is disabled, because nothing here authorises.

	     The panel is inside the guard rather than around it: in Live there is
	     neither an age nor a read-at to state, and a bordered box with nothing
	     in it reads as a figure that failed to load. -->
	{#if figuresAge !== null || readAt !== null}
		<section class="panel">
			{#if figuresAge !== null}
				<p class="prose" id="team-figures-age">{figuresAge}</p>
			{/if}
			{#if readAt !== null}
				<p class="when" id="team-figures-at">{readAt}</p>
			{/if}
		</section>
	{/if}

	<!-- Band two: slots. The Roster Count is Active/Bench only; Minor League
	     renders `N of 3`; Injury Reserve is stated and visibly outside the
	     twelve, in its own quieter row.

	     Each sentence is set in TWO registers (DESIGN.md:183): the count
	     carries the information and reads first, the `of 12` beside it is one
	     step quieter. Both halves come from the core — this file never
	     searches a string for ` of `. The whole sentence rides on
	     `aria-label` so a screen reader gets it unbroken rather than as two
	     fragments. -->
	<section class="panel" id="team-slots">
		<h2 class="section-label">{TEAM_VIEW_LABELS.slots}</h2>
		<p class="figure" id="team-roster-count" aria-label={team.rosterCountHalves.full}>
			<span>{team.rosterCountHalves.lead}</span><span class="figure-qualifier"
				>{team.rosterCountHalves.qualifier}</span
			>
		</p>
		<p class="figure" id="team-active-bench" aria-label={team.activeBenchHalves.full}>
			<span>{team.activeBenchHalves.lead}</span><span class="figure-qualifier"
				>{team.activeBenchHalves.qualifier}</span
			>
		</p>
		<p class="figure" id="team-minor-league" aria-label={team.minorLeagueHalves.full}>
			<span>{team.minorLeagueHalves.lead}</span><span class="figure-qualifier"
				>{team.minorLeagueHalves.qualifier}</span
			>
		</p>
		<p
			class="figure-tertiary"
			id="team-injury-reserve"
			aria-label={team.injuryReserveHalves.full}
		>
			<span>{team.injuryReserveHalves.lead}</span><span class="figure-qualifier"
				>{team.injuryReserveHalves.qualifier}</span
			>
		</p>
		<!-- Dead Money: money this Team still charges for Contracts it has
		     released (FR-43). ABSENT rather than zero for a Team carrying
		     none — the core decides which, and this file words nothing. It
		     reads last in the band and in `text-tertiary`, beside Injury
		     Reserve, because both are figures deliberately outside the twelve.
		     The Dead Money GROUP at the foot of the page lists the contracts
		     this figure sums, so Cap Space reconciles against what is on
		     screen (UX-DR40). -->
		{#if team.deadMoneyHalves !== null}
			<p class="figure-tertiary" id="team-dead-money" aria-label={team.deadMoneyHalves.full}>
				<span>{team.deadMoneyHalves.lead}</span><span class="figure-qualifier"
					>{team.deadMoneyHalves.qualifier}</span
				>
			</p>
		{/if}
	</section>

	<!-- Band three: money. Every figure is a field of one `CapGateOutcome`;
	     nothing on this page recomputes one. -->
	<section class="panel" id="team-money">
		<h2 class="section-label">{TEAM_VIEW_LABELS.money}</h2>

		<p class="section-label">{TEAM_VIEW_LABELS.capSpace}</p>
		<p class="figure" id="team-cap-space">{team.capSpaceLabel}</p>

		<p class="section-label">{TEAM_VIEW_LABELS.committedBids}</p>
		<p class="figure" id="team-committed-bids">{team.committedBidsLabel}</p>
		<p class="figure-tertiary" id="team-minors-exposure">
			{TEAM_VIEW_LABELS.minorsExposure} {team.minorsExposureLabel}
		</p>

		<p class="section-label">{TEAM_VIEW_LABELS.availableCapSpace}</p>
		<p class="figure" id="team-available-cap-space">{team.availableCapSpaceLabel}</p>

		<!-- Maximum Bid is shown for the viewer's own Team and no other
		     (epic-4-context.md:20). On a rival's payload the field is ABSENT,
		     not blank — there is nothing here to render rather than something
		     hidden. -->
		{#if team.viewerIsThisTeam && team.maximumBidLabel !== undefined}
			<p class="section-label">{TEAM_VIEW_LABELS.maximumBid}</p>
			<p class="figure figure-display" id="team-maximum-bid">{team.maximumBidLabel}</p>
		{/if}
	</section>

	{#if team.viewerIsThisTeam && team.capBreakdown !== undefined && team.capBreakdown.length > 0}
		<section class="panel" id="team-breakdown">
			<h2 class="section-label">{TEAM_VIEW_LABELS.breakdown}</h2>
			<CapBreakdown lines={team.capBreakdown} id="team-cap-breakdown" />
		</section>
	{/if}

	{#if team.viewerIsThisTeam && team.auctions !== undefined && team.auctions.length > 0}
		<section class="panel" id="team-auctions">
			<h2 class="section-label">{TEAM_VIEW_LABELS.auctions}</h2>
			<ul class="rows">
				{#each team.auctions as auction (auction.fantraxPlayerId)}
					<li class="row">
						<a class="row-name" href={auction.href}>{auction.playerName}</a>
						<span class="row-figure">{auction.amountLabel}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<section class="panel" id="team-nomination-slot">
		<h2 class="section-label">{TEAM_VIEW_LABELS.nominationSlot}</h2>
		<p class="prose" id="team-nomination-statement">{team.nominationSlot.sentence}</p>
		{#if team.nominationSlot.used && team.nominationSlot.href !== null}
			<p class="prose">
				<a href={team.nominationSlot.href} id="team-nomination-link">
					{team.nominationSlot.playerName}
				</a>
			</p>
		{/if}
	</section>

	<section class="panel" id="team-roster">
		<h2 class="section-label">{TEAM_VIEW_LABELS.roster}</h2>
		<!-- Every group renders even when empty — an absent Minor League group
		     and an empty one say different things — with ONE exception. Dead
		     Money is not an occupancy every Team has some of; it is a
		     consequence of an act most Teams never take, so an empty group
		     would print a heading about nothing on thirty pages and teach a
		     reader to skip the one page where it is real. Same reasoning as
		     the core's null `deadMoneySentence`. -->
		{#each team.roster as group (group.slotKind)}
			{#if group.slotKind !== 'dead_money' || group.entries.length > 0}
				<div
					class="group"
					class:group-apart={group.slotKind === 'dead_money'}
					id="roster-group-{group.slotKind}"
				>
					<h3 class="section-label">{group.label}</h3>
					<ul class="rows">
						{#each group.entries as entry (entry.fantraxPlayerId)}
							<li class="row">
								<span class="row-name">{entry.playerName}</span>
								<span class="row-figure">{entry.capHitLabel}</span>
								{#if entry.wonSentence !== null}
									<span class="row-note">{entry.wonSentence}</span>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		{/each}
	</section>
</main>

<style>
	.masthead {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
	}

	/*
	 * `ui` at 15px, not Georgia (DESIGN.md:181). Georgia is reserved for player
	 * names, the wordmark, Maximum Bid and refusal headlines; a fantasy Team is
	 * an entity, and setting it in the display face would put it in the same
	 * register as the players it competes for.
	 */
	.team-identity {
		font-family: var(--font-ui);
		font-size: var(--size-15);
		color: var(--color-text);
	}

	/*
	 * The Manager half, one step quieter (DESIGN.md:187). The Team name is the
	 * row's identity and stays in `text`; dimming the name to make the Manager
	 * stand out was drafted and rejected at the mock, and this is the
	 * arrangement that survived.
	 */
	.team-manager {
		color: var(--color-text-secondary);
	}

	/*
	 * One column at every width. `EXPERIENCE.md` requires every Manager
	 * surface to be single-column at 375px with no lateral scrolling.
	 */
	.group {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		width: 100%;
	}

	/*
	 * Dead Money is not part of the roster, and the layout says so before the
	 * label is read (UX-DR40): a rule and a full row gap set it off from the
	 * three groups above, the way Injury Reserve is set outside the twelve in
	 * the band of figures. These Players are not on this Team; only their
	 * money is.
	 */
	.group-apart {
		margin-top: var(--space-row-gap);
		padding-top: var(--space-row-gap);
		border-top: var(--border-width) solid var(--color-border);
	}

	/*
	 * Rows separated by a 1px `border` rule rather than by card gaps
	 * (DESIGN.md:179) — a ruled list reads as a table on a phone, and a roster
	 * of fifteen cards at 8px apart is a scroll nobody finishes.
	 */
	.rows {
		display: flex;
		flex-direction: column;
		list-style: none;
		width: 100%;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--space-row-gap);
		padding: var(--space-row-gap) 0;
		border-bottom: var(--border-width) solid var(--color-border);
	}

	.row-name {
		font-family: var(--font-ui);
		font-size: var(--size-15);
		color: var(--color-text);
	}

	.row-figure {
		font-family: var(--font-ui);
		font-size: var(--size-15);
		font-variant-numeric: var(--numerals);
		color: var(--color-text);
	}

	/* A won Player's placement sentence, beneath the row it belongs to. */
	.row-note {
		flex-basis: 100%;
		font-size: var(--size-11);
		color: var(--color-text-tertiary);
	}

	/*
	 * Figures in `ui` `tabular-nums` at 15px, under the 10px uppercase
	 * section labels the rest of the product already uses (DESIGN.md:183) —
	 * the treatment is reused so a figure and its name never separate when the
	 * row wraps.
	 */
	.figure {
		font-family: var(--font-ui);
		font-size: var(--size-15);
		font-variant-numeric: var(--numerals);
		color: var(--color-text);
	}

	/* The page's own headline figure — the one Maximum Bid gets. */
	.figure-display {
		font-size: var(--size-21);
		letter-spacing: -0.025em;
	}

	/*
	 * The ceiling half of a slot sentence — `of 12`, `of 3` — one step
	 * quieter than the count beside it (DESIGN.md:183), so the number
	 * carrying the information reads first. It inherits size and face from
	 * the `.figure` it sits inside; only the colour steps back, which is what
	 * keeps the pair on one baseline.
	 */
	.figure-qualifier {
		color: var(--color-text-secondary);
	}

	/*
	 * Injury Reserve and the of-which line: `text-tertiary`, outside the group
	 * above them. IR is the figure most often wrongly folded into the twelve.
	 */
	.figure-tertiary {
		font-family: var(--font-ui);
		font-size: var(--size-12-5);
		font-variant-numeric: var(--numerals);
		color: var(--color-text-tertiary);
	}

	.when {
		color: var(--color-text-tertiary);
		font-size: var(--size-12-5);
	}
</style>
