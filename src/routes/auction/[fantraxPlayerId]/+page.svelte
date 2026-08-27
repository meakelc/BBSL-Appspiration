<script lang="ts">
	// The Auction page (Stories 2.4, 2.5).
	//
	// Story 2.4 built the read-only half — Player identity, the nominating
	// Team, an honest "no bids yet" price and an empty history region — and
	// deliberately shipped no bidding control, because `core/rules/bidding`
	// did not exist and a pre-filled figure for the smallest allowed offer
	// would have been invented. Story 2.5 built those rules, so the control,
	// the price, the Leading Bidder and the chronological history land here
	// now, every figure and every sentence coming from the core.
	//
	// **Bidding is a TWO-PART act.** Entering an amount is not bidding it.
	// The field states, the confirm says what it costs, the submit acts. A
	// Bid cannot be undone once placed, so a mis-tap must not place one.
	//
	// **No control to undo, revise or reduce an accepted Bid exists here at
	// all** — absent, not disabled. There is nothing of the sort in this
	// markup to turn off.
	//
	// **No suggested amount and no urgency.** The field is pre-filled with
	// the smallest LEGAL Bid — which is a rule, not advice — and nothing on
	// this page recommends an amount, ranks anything, or styles the Auction
	// Clock to create pressure. The clock is one plain sentence.
	//
	// **No rule and no refusal is worded here.** Every refusal, the
	// consequence, the disabled reason, the contention state and the
	// statement of what was appended arrive already worded by the pure core,
	// so each has exactly one definition in the codebase. What this file does
	// write is the field's own label and the panel headings — the surface's
	// own furniture, as on `/nominate`.
	//
	// **The control is disabled against the amount actually TYPED**, by
	// calling the core's own `bidControlState()` — the same function the read
	// path calls for the pre-fill, reaching the same `evaluate()` the locked
	// transaction calls. No gate arithmetic is re-implemented here and none
	// could be: this file has the two facts `BidState` carries and nothing
	// else. AD-9 sanctions exactly this and no more — client-side validation
	// exists to disable controls and pre-fill amounts, and is never the
	// check. The server re-derives everything under the global lock.
	//
	// Types are declared structurally rather than imported from a server-only
	// module — the rule `nominate/+page.svelte:25-27` states and this page
	// follows identically. `$lib/core` is a different matter: it is the pure
	// core, it is what AD-2 says both runtimes load, and the helpers below
	// are the same ones the server calls.
	import { closesInPhrase } from '$lib/core/projection/auctions.ts';
	import { relativePhrase } from '$lib/core/instant.ts';
	import { parseMoney } from '$lib/core/money.ts';
	import {
		bidAppendedSentence,
		bidConsequenceSentence,
		bidControlState,
		bidGateReport,
		bidRefusalDelta,
		capBreakdown,
		evaluate,
		figuresAtCaption,
		readBidAmount
	} from '$lib/core/rules/bidding.ts';
	import type { BidState, TeamMoneyState } from '$lib/core/rules/bidding.ts';
	import type { PlaceBidGateResults } from '$lib/core/types.ts';
	import CapBreakdown from '$lib/components/CapBreakdown.svelte';
	import RefusalPanel from '$lib/components/RefusalPanel.svelte';

	import type { ActionData, PageData } from './$types';

	type AuctionMetadata = {
		readonly positions: string;
		readonly nbaTeam: string;
	};

	type AuctionBid = {
		readonly seq: string;
		readonly bidder: string;
		readonly amount: string;
		readonly occurredAt: string;
	};

	/**
	 * The viewer Team's money FACTS as the read path serialised them — Cap
	 * Space and the leading amounts arrive as integer dollars, because `Money`
	 * is a brand and a brand does not survive JSON (AD-8).
	 *
	 * Deliberately NOT Maximum Bid. AD-7 forbids a derived money figure being
	 * cached client-side for validation, and this file is the client: a
	 * transported `maximumBid` compared here would BE the check. What arrives
	 * are the inputs, and `evaluate()` derives the figure again on every
	 * keystroke from the same core function the locked transaction calls.
	 */
	type TeamMoney = {
		readonly capSpace: number;
		readonly rosterCount: number;
		readonly leading: readonly { readonly fantraxPlayerId: string; readonly amount: number }[];
	};

	type BidControl = {
		readonly available: boolean;
		readonly detail: string;
		readonly minimumLegal: number;
		readonly minimumLegalSentence: string | null;
		readonly leadingAmount: number | null;
		readonly leadingTeamId: string | null;
		readonly viewerTeamId: string | null;
		readonly team: TeamMoney | null;
		readonly figuresAt: string;
	};

	type Auction = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly metadata: AuctionMetadata | null;
		readonly nominatingTeam: string;
		readonly nominatedAt: string;
		readonly contention: string;
		readonly price: string | null;
		readonly leadingBidder: string | null;
		readonly closesAt: string | null;
		readonly bids: readonly AuctionBid[];
		readonly bidControl: BidControl;
	};

	type BidForm = {
		readonly notice?: string;
		readonly appended?: { readonly seq: string } | null;
		/**
		 * The refusal's own sentence, unframed — the panel's part two.
		 *
		 * Present on EVERY refusal, including the three raised before a
		 * transaction opens, because the matrix requires the panel on any
		 * refused submit. Its presence is what the panel keys on.
		 */
		readonly delta?: string;
		/**
		 * The gate set exactly as the LOCKED TRANSACTION decided it, and the
		 * clock it decided at. `null` on a refusal with no arithmetic behind
		 * it — the panel checks before drawing a breakdown of nothing.
		 *
		 * Named for what it holds. It is a `PlaceBidGateResults`, not the
		 * `BidRefusal` that `BidRejection.refusal` carries, and calling both
		 * "refusal" made two unrelated shapes share a name across four files.
		 */
		readonly gates?: PlaceBidGateResults | null;
		readonly figuresAt?: string | null;
	};

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const auction = $derived(data.auction as Auction);
	const control = $derived(auction.bidControl);
	const bidForm = $derived(form as BidForm | undefined);
	const notice = $derived(bidForm?.notice);
	const appended = $derived(bidForm?.appended ?? null);

	/**
	 * The typed amount. Typing is not bidding: the server decides.
	 *
	 * Seeded at declaration rather than only in an effect, because effects do
	 * not run during server rendering — an empty initial value would ship a
	 * first paint whose control said "the amount is not a whole number of
	 * dollars" about a field the Manager has not touched.
	 */
	// svelte-ignore state_referenced_locally
	let amount = $state(String((data.auction as Auction).bidControl.minimumLegal));

	/** The confirmation. Ticking it is not bidding either. */
	let confirmed = $state(false);

	// Re-seed whenever the server's figure changes — a raise landed, or the
	// page reloaded after a submit.
	$effect(() => {
		amount = String(control.minimumLegal);
	});

	/**
	 * The two facts every gate decides from, rebuilt from what the read path
	 * serialised. `Money` is branded, so the integer dollars that came over
	 * the wire are re-parsed at this boundary rather than cast (AD-8).
	 */
	const teamMoney: TeamMoneyState | null = $derived(
		control.team === null
			? null
			: {
					capSpace: parseMoney(control.team.capSpace),
					rosterCount: control.team.rosterCount,
					leading: control.team.leading.map((lead) => ({
						fantraxPlayerId: lead.fantraxPlayerId,
						amount: parseMoney(lead.amount)
					}))
				}
	);

	const gateState: BidState = $derived({
		leadingBid:
			control.leadingAmount === null || control.leadingTeamId === null
				? null
				: { teamId: control.leadingTeamId, amount: parseMoney(control.leadingAmount) },
		team: teamMoney
	});

	/**
	 * What the control says about the amount as it stands, from the core.
	 *
	 * `now` is the empty string, deliberately: no gate in `PLACE_BID_GATES`
	 * reads it, and the viewer's own clock must never be an input to a rule
	 * (AD-3 — server time, injected). When Story 3.1 adds the expiry gate,
	 * this call must take the server's instant, not this machine's.
	 */
	const typed = $derived(
		bidControlState({
			state: gateState,
			fantraxPlayerId: auction.fantraxPlayerId,
			viewerTeamId: control.viewerTeamId,
			amountText: amount,
			confirmed,
			now: ''
		})
	);

	/**
	 * The one flag both the affordance and the stated reason read from. The
	 * server re-derives every gate under the lock regardless — disabling a
	 * control is never the check.
	 */
	const blocked = $derived(typed.blocked);


	/**
	 * The one sentence beneath the control, and never two.
	 *
	 * A standing condition the server already stated — your Team leads, or you
	 * are bound to none — is what a Manager is shown, because the field is
	 * disabled on it and nothing they could type would change the answer.
	 * Otherwise the live per-amount reason, which tracks the field. Both come
	 * out of the same core function, so the two branches cannot word the same
	 * refusal differently.
	 */
	const reason = $derived(control.available ? typed.detail : control.detail);

	/**
	 * What confirming commits, naming the amount being confirmed. Falls back
	 * to the amount-free sentence when the field holds no usable amount —
	 * `bidConsequenceSentence` handles that and the off-grid case alike.
	 */
	const reading = $derived(readBidAmount(amount));
	const consequence = $derived(
		bidConsequenceSentence(reading.kind === 'usable' ? reading.amount : null)
	);

	/**
	 * Every gate's outcome for the amount as it stands — the same `evaluate()`
	 * `decide()` calls inside the lock, reached through the same command shape
	 * `bidControlState` builds.
	 *
	 * This is what makes the displayed Maximum Bid a rendering of the
	 * evaluator's own output rather than a second computation of it (AD-7:
	 * "the displayed Maximum Bid is `evaluate()` output on the read path"). It
	 * recomputes on every keystroke and on every reload, which is also how the
	 * one-second recomputation requirement is met: nothing is memoised, so
	 * there is no stale value to invalidate.
	 */
	const liveGates = $derived(
		evaluate(
			gateState,
			{
				kind: 'PlaceBid' as const,
				fantraxPlayerId: auction.fantraxPlayerId,
				teamId: control.viewerTeamId ?? '',
				// Neither is read by any gate — both ride the command for the
				// event's sake — so a render passes placeholders rather than
				// resolving names for a command it will never append.
				teamName: '',
				managerId: '',
				amount: reading.kind === 'usable' ? reading.amount : parseMoney(control.minimumLegal)
			},
			// The empty string, for the same reason `typed` passes it: no gate
			// in `PLACE_BID_GATES` reads `now`, and the viewer's own clock must
			// never be an input to a rule (AD-3 — server time, injected). Story
			// 3.1's `expiry` gate is the first that will need one, and it must
			// be sourced from the server here rather than invented.
			''
		)
	);

	/**
	 * Maximum Bid, broken into its components — never a bare number (FR-12).
	 *
	 * Empty for a viewer bound to no Team, which is the surface's cue to omit
	 * the whole panel rather than render a column of zeroes that would read as
	 * a Team that is broke rather than one that does not exist.
	 */
	const standingBreakdown = $derived(capBreakdown(liveGates.cap));

	/**
	 * The gate set a REFUSED SUBMIT came back with, or `null`.
	 *
	 * Not `liveGates`: these are the figures the locked transaction actually
	 * judged the Bid against, at its own clock, which is what FR-13 requires a
	 * refusal to show. A Bid composed against one Cap Space and refused
	 * against another must display the second, or the panel explains a
	 * decision with numbers that did not make it.
	 *
	 * The amounts inside arrive as plain integers — `Money`'s brand is a
	 * compile-time phantom and does not survive JSON — which is exactly what
	 * every money function here already accepts at runtime.
	 */
	const refusedGates = $derived(bidForm?.gates ?? null);

	/**
	 * The refusal panel's part two, from the server.
	 *
	 * Read off the form rather than recomputed, so a refusal decided before a
	 * transaction opened — a mis-typed amount, a missing confirmation, an
	 * unbound Manager — gets the same panel as one that ran the gates. Those
	 * have a sentence without having arithmetic, and the matrix requires the
	 * panel on ANY refused submit.
	 *
	 * `null` when nothing was refused, which is the cue that there is no panel
	 * to draw. Checked for emptiness as well: `bidRefusalDelta` returns `''`
	 * for a gate set in which nothing actually failed, and an empty paragraph
	 * under a headline saying a Bid was not placed would state nothing.
	 */
	const refusalDelta = $derived(
		bidForm?.delta === undefined || bidForm.delta === '' ? null : bidForm.delta
	);

	/** Every gate's chip row, refused and passed alike — built from the core's list. */
	const refusalGateRows = $derived(refusedGates === null ? [] : bidGateReport(refusedGates));

	/** The arithmetic the refusal was decided from. */
	const refusalBreakdown = $derived(refusedGates === null ? [] : capBreakdown(refusedGates.cap));

	// The viewer's own clock, read once at render time — never fed back into
	// the pure core, which takes `now` as an argument and reads no clock of
	// its own (AD-3). This is display-only arithmetic in the component, the
	// same split `core/instant.ts`'s own header describes: the pure helpers
	// derive the phrases, and `Intl.DateTimeFormat` here renders the absolute
	// stamps in the viewer's own timezone.
	//
	// The relative phrases are safe to derive on the server as well as the
	// client: both instants are UTC and the arithmetic between them is the
	// same wherever it runs.
	const nowIso = $derived(new Date().toISOString());
	const relative = $derived(relativePhrase(auction.nominatedAt, nowIso));
	// `closesInPhrase` rather than `relativePhrase`: a close time is ahead of
	// the reader, and the "ago" phrasing would read a future instant as
	// "moments ago".
	const closesIn = $derived(
		auction.closesAt === null ? null : closesInPhrase(auction.closesAt, nowIso)
	);

	// The absolute stamps are NOT safe to derive during SSR.
	// `Intl.DateTimeFormat(undefined, ...)` resolves `undefined` to the
	// timezone of whatever machine formats it, and this route is
	// server-rendered like every other, so deriving them during SSR would
	// ship the SERVER's timezone in the delivered HTML — which Svelte does
	// not diff-correct on hydration. The AC asks for the VIEWER's timezone,
	// so each stamp is computed in an effect, which runs only in the browser,
	// and the markup omits it until it exists rather than rendering a stamp
	// that is wrong for one paint.
	//
	// This is not the "dropped to save space" the Boundaries forbid: neither
	// stamp is ever traded away for layout, and both are present for every
	// viewer that runs scripts. A viewer that does not gets the relative
	// phrase, which is honest, rather than a time in a timezone that is not
	// theirs, which is not.
	let nominatedAbsolute = $state<string | null>(null);
	let closesAtAbsolute = $state<string | null>(null);

	// `Intl.DateTimeFormat.format` throws `RangeError` on an Invalid Date,
	// so an unparseable instant is checked for rather than formatted. The
	// pure helpers beside it deliberately return a stated phrase instead of
	// throwing for exactly this input, and `core/instant.ts`'s own header
	// justifies that by saying the absolute stamp renders regardless — which
	// is only true if this cannot crash the page.
	function formatAbsolute(iso: string): string {
		const parsed = new Date(iso);
		if (Number.isNaN(parsed.getTime())) return 'at an unknown time';
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(parsed);
	}

	$effect(() => {
		nominatedAbsolute = formatAbsolute(auction.nominatedAt);
	});

	$effect(() => {
		closesAtAbsolute = auction.closesAt === null ? null : formatAbsolute(auction.closesAt);
	});

	// The arithmetic's timestamp, in the viewer's own timezone and therefore
	// client-only for the same reason the two stamps above are. The caption is
	// omitted until it resolves rather than rendered in the server's timezone:
	// "your figures at" a time the reader does not live in is worse than no
	// caption, because the figures beside it are the ones they are being asked
	// to check.
	let figuresAtAbsolute = $state<string | null>(null);

	$effect(() => {
		const stamp = bidForm?.figuresAt ?? control.figuresAt;
		figuresAtAbsolute = formatAbsolute(stamp);
	});
</script>

<svelte:head>
	<title>{auction.playerName} — Auction — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1 class="display">{auction.playerName}</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	<section class="panel">
		<p class="section-label">Phase</p>
		<p class="prose">{data.phase.sentence}</p>
	</section>

	<!-- Exactly two fields when the reference row exists — NBA team as a
	     three-letter capitalised abbreviation (real-life team only, per the
	     glossary) and positions. No cap figure and no years-remaining field:
	     those columns do not exist on `free_agent_players`.
	     The WHOLE panel is conditional, not just the line inside it: `.panel`
	     carries a background, a border and padding, so leaving the section up
	     with its label and no content is precisely the blanked rendering the
	     matrix names as the wrong answer. Omitted entirely means omitted. -->
	{#if auction.metadata !== null}
		<section class="panel">
			<p class="section-label">Player</p>
			<p class="prose" id="auction-metadata">
				{auction.metadata.nbaTeam} &middot; {auction.metadata.positions}
			</p>
		</section>
	{/if}

	<section class="panel">
		<p class="section-label">Nominating Team</p>
		<!-- The fantasy Team spelled out with its acting Manager attached —
		     `formatTeamManager`'s one rendering, never re-worded here. -->
		<p class="prose" id="auction-nominating-team">{auction.nominatingTeam}</p>
	</section>

	<section class="panel">
		<p class="section-label">Nominated</p>
		<!-- Time appears TWICE: a relative phrase and an absolute stamp in
		     the viewer's own timezone. The absolute is never dropped to save
		     space. -->
		<p class="prose" id="auction-nominated-at">
			<span id="auction-nominated-relative">{relative}</span>
			{#if nominatedAbsolute !== null}
				&mdash;
				<span id="auction-nominated-absolute">{nominatedAbsolute}</span>
			{/if}
		</p>
	</section>

	<section class="panel">
		<p class="section-label">Price</p>
		<!-- The current price and who holds it, both from the fold. The
		     Leading Bidder is spelled out with the acting Manager: there is
		     no anonymity at any point on this page. -->
		<p class="prose" id="auction-price">
			{#if auction.price === null}
				No bids yet.
			{:else}
				{auction.price}
			{/if}
		</p>
		<p class="prose" id="auction-leading-bidder">
			{#if auction.leadingBidder === null}
				No Team leads this Auction yet.
			{:else}
				Leading Bidder: {auction.leadingBidder}
			{/if}
		</p>
		<!-- The contention state, worded by the fold that decides it. A plain
		     label and no chip: `DESIGN.md` gives ambient states a plain
		     label, and the one attention colour marks Outbid and refusal. -->
		<p class="prose" id="auction-contention">{auction.contention}</p>
	</section>

	<!-- The Auction Clock. Absent until the first Bid, because until then
	     there is no clock to state — the server persists an ABSOLUTE close
	     instant and this page counts down from it; "seconds remaining" is
	     never sent (AD-3). Rendered TWICE, relative and absolute in the
	     viewer's own timezone, and the absolute is never dropped. -->
	{#if auction.closesAt !== null}
		<section class="panel">
			<p class="section-label">Auction Clock</p>
			<p class="prose" id="auction-closes-at">
				<span id="auction-closes-relative">{closesIn}</span>
				{#if closesAtAbsolute !== null}
					&mdash;
					<span id="auction-closes-absolute">{closesAtAbsolute}</span>
				{/if}
			</p>
		</section>
	{/if}

	<!-- Maximum Bid, wherever bidding occurs (FR-12), and never as a bare
	     number: the four components are broken out and the column sums
	     exactly as displayed, which the $500,000 grid makes possible at one
	     decimal. Every figure is `evaluate()`'s own output, recomputed on
	     each keystroke and each reload — nothing is memoised, so there is no
	     stale figure to invalidate. Omitted entirely for a viewer bound to no
	     Team: there is no Maximum Bid, and a column of zeroes would read as a
	     Team that is broke rather than one that does not exist. -->
	{#if standingBreakdown.length > 0}
		<section class="panel">
			<p class="section-label">Maximum Bid</p>
			<CapBreakdown lines={standingBreakdown} id="auction-maximum-bid" />
		</section>
	{/if}

	<section class="manager-block">
		<p class="section-label">Place a Bid</p>

		<!-- The refusal panel, above the control it is about — the six-part
		     anatomy `EXPERIENCE.md` specifies, ending with the disabled
		     control and its reason, which are the markup that follows. It
		     appears only for a refusal that HAS arithmetic behind it; the
		     three raised before any transaction opens carry none and are said
		     in the notice below instead. -->
		{#if refusalDelta !== null}
			<RefusalPanel
				delta={refusalDelta}
				gates={refusalGateRows}
				breakdown={refusalBreakdown}
				caption={refusalBreakdown.length === 0 || figuresAtAbsolute === null
					? null
					: figuresAtCaption(figuresAtAbsolute)}
			/>
		{/if}

		<p class="prose">{consequence}</p>

		<form method="POST" action="?/bid">
			<!-- The field and its submit sit on one row at the same 46px
			     height, which is the only horizontal pairing on this page.
			     Pre-filled with the smallest LEGAL Bid — a rule, never a
			     recommendation. -->
			<div class="bid-row">
				<label class="visually-hidden" for="auction-bid-amount">
					Your Bid, in whole dollars
				</label>
				<!-- The FIELD is disabled on the standing condition, not just the
				     submit: when this Auction will take no Bid from your Team at
				     any amount, there is nothing to type. -->
				<input
					id="auction-bid-amount"
					class="bid-amount"
					name="amount"
					type="text"
					inputmode="numeric"
					autocomplete="off"
					disabled={!control.available}
					aria-describedby="auction-bid-availability auction-bid-minimum"
					bind:value={amount}
				/>
				<button
					class="control-manager"
					type="submit"
					disabled={blocked}
					aria-describedby="auction-bid-availability"
				>
					Place the Bid
				</button>
			</div>

			<!-- Omitted, never blanked, when the figure has no lossless
			     rendering — which only a historical off-grid Bid could cause,
			     and which the fold deliberately does not rewrite (AD-20). -->
			{#if control.minimumLegalSentence !== null}
				<p class="prose" id="auction-bid-minimum">{control.minimumLegalSentence}</p>
			{/if}

			<!-- The second part of the two-part act, separate from the amount
			     above and stating what it costs, at the amount entered. -->
			<label class="confirm" for="auction-bid-confirm">
				<input
					id="auction-bid-confirm"
					name="confirm"
					type="checkbox"
					value="yes"
					bind:checked={confirmed}
				/>
				<span class="prose">
					I confirm this Bid. {consequence}
				</span>
			</label>
		</form>

		<!-- The reason, BENEATH the control it is about, and always in the
		     DOM so the two `aria-describedby` references above can never
		     dangle — which is the entire justification for a disabled
		     control's label being exempt from WCAG 1.4.3. Worded by the core
		     in every branch, including the ready one: the surface prints one
		     field and decides nothing. -->
		<p class="prose" id="auction-bid-availability">{reason}</p>

		<!-- The outcome of a submit is the only place a Manager learns whether
		     the Bid landed, and after a form post the focus is still on the
		     control that was pressed. `role="status"` announces it politely
		     rather than leaving a screen reader user to go looking. -->
		<div role="status">
			<!-- Suppressed whenever the panel above carries this refusal — which
			     is every refusal now, not only the ones with arithmetic. The
			     panel's headline, delta and reassurance ARE this sentence,
			     broken into its parts, and printing both would say the same
			     thing twice on the one surface that must read cleanly. -->
			{#if notice && refusalDelta === null}
				<p class="prose" id="auction-bid-notice">{notice}</p>
			{/if}
			{#if appended}
				<p class="prose" id="auction-bid-appended">{bidAppendedSentence(appended.seq)}</p>
			{/if}
		</div>
	</section>

	<section class="panel">
		<p class="section-label">History</p>
		<!-- Every Bid, oldest first, each naming the Team and the acting
		     Manager. No anonymity at any point. Nothing here lets a Bid be
		     taken back, revised or reduced — that whole class of control is
		     absent from this page, not merely turned off. -->
		{#if auction.bids.length === 0}
			<p class="prose" id="auction-history">No bids have been placed yet.</p>
		{:else}
			<ul class="history" id="auction-history">
				{#each auction.bids as bid (bid.seq)}
					<li class="history-row">
						<span class="history-amount">{bid.amount}</span>
						<span class="prose">{bid.bidder}</span>
						<span class="history-when">{relativePhrase(bid.occurredAt, nowIso)}</span>
					</li>
				{/each}
			</ul>
		{/if}
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
	 * The one horizontal pairing on the page: the amount field and the
	 * control that submits it, at the same height so they read as one act.
	 * It wraps rather than shrinking below the touch floor at 375px.
	 */
	.bid-row {
		display: flex;
		flex-wrap: wrap;
		align-items: stretch;
		gap: var(--space-row-gap);
		width: 100%;
	}

	.bid-amount {
		flex: 1 1 10ch;
		min-height: var(--control-height);
		padding: 0 var(--space-row-gap);
		color: var(--color-text);
		background-color: var(--color-surface-sunken);
		border: var(--border-width) solid var(--color-border-interactive);
		border-radius: var(--rounded-control);
		font-family: var(--font-ui);
		font-size: var(--size-18);
		font-variant-numeric: var(--numerals);
	}

	.bid-row .control-manager {
		min-height: var(--control-height);
	}

	.confirm {
		display: flex;
		align-items: flex-start;
		gap: var(--space-row-gap);
		min-height: var(--touch-min);
	}

	/*
	 * 22px and the 2px nudge that optically aligns the box with the first
	 * line of its label have no token in `tokens.css`, which sizes controls
	 * and spacing but not a native checkbox's own box. Copied verbatim from
	 * `/nominate`'s confirm so the two read identically; inventing a token is
	 * an Ask First item and this is not the story to open it in.
	 */
	.confirm input[type='checkbox'] {
		width: 22px;
		height: 22px;
		margin-top: 2px;
		/* The interactive token: this is a Manager control in a Manager block. */
		accent-color: var(--color-border-interactive);
	}

	/* The standard clipping rectangle. Its 1px box is the technique, not a
	   spacing decision, so no token applies. */
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

	.history {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		list-style: none;
		width: 100%;
	}

	.history-row {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		padding-top: var(--space-row-gap);
		border-top: var(--border-width) solid var(--color-border);
	}

	.history-amount {
		color: var(--color-text);
		font-size: var(--size-18);
		font-variant-numeric: var(--numerals);
	}

	.history-when {
		color: var(--color-text-tertiary);
		font-size: var(--size-12-5);
	}

</style>
