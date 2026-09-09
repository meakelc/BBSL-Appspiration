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
	// **No rule and no refusal is worded here.** Every refusal, the disabled
	// reason, the contention state and the statement of what was appended
	// arrive already worded by the pure core, so each has exactly one
	// definition in the codebase. What this file does
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
	import {
		AUCTION_EXPIRED,
		CONTENTION_CLOCK_UNMOVED,
		MINIMUM_LOTTERY_LABEL,
		SEED_COMMITMENT,
		SEED_COMMITMENT_UNVERIFIABLE,
		closesInPhrase,
		contenderCountSentence,
		hasExpired
	} from '$lib/core/projection/auctions.ts';
	import type { ContentionState } from '$lib/core/projection/auctions.ts';
	import type { LeaguePhase } from '$lib/core/projection/phase.ts';
	import { formatInstant, parseInstant, relativePhrase } from '$lib/core/instant.ts';
	import { parseMoney } from '$lib/core/money.ts';
	import {
		bidAppendedSentence,
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
	import { MAXIMUM_BID_LABELS, STALE_BID_REASON } from '$lib/core/freshness.ts';
	import { freshness } from '$lib/client/freshness.svelte.ts';
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
	type LeadElsewhere = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly amount: number;
	};

	type TeamMoney = {
		readonly capSpace: number;
		readonly rosterCount: number;
		readonly leading: readonly LeadElsewhere[];
		// The eligible half of the same partition, and the raw count of
		// occupied minors slots. Both are facts the server read; every figure
		// they imply is derived in the core, here, on every keystroke.
		readonly eligibleLeading: readonly LeadElsewhere[];
		readonly minorLeagueOccupied: number;
	};

	type BidControl = {
		readonly available: boolean;
		readonly detail: string;
		// `minimumLegalSentence` is deliberately NOT mirrored: the minimum is
		// what the field is pre-filled to, and the sentence about it no
		// longer appears anywhere on this surface.
		readonly minimumLegal: number;
		// The folded League phase (Story 3.7) — the ninth gate's one input, off
		// the same narrowing the locked transaction uses. A FACT, not a verdict:
		// nothing on this wire says "bidding is open", because that is the one
		// comparison the core makes on every keystroke.
		readonly phase: LeaguePhase;
		readonly leadingAmount: number | null;
		readonly leadingTeamId: string | null;
		// The two contention FACTS the gates decide from — the fold's own
		// state literal and the Contender Teams by id. Not a derived flag:
		// nothing on this wire says "this is a lottery" or "you are in it",
		// because both are one comparison the core makes on every keystroke.
		readonly contention: ContentionState;
		readonly contenderTeamIds: readonly string[];
		readonly viewerTeamId: string | null;
		// A fact about this Auction that the gates decide from, carried so the
		// browser rebuilds exactly the state the locked transaction will.
		readonly playerIsMinorLeagueEligible: boolean;
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
		// Team names in join order, and the count. The ORDER is the server's
		// and is never re-sorted here: AD-14 makes it an input to the winner.
		readonly contenders: readonly string[];
		readonly contenderCount: number;
		readonly seedHash: string | null;
		// The revealed seed, once the contention dissolved. `null` otherwise —
		// and it is the fold's own value: nothing is hashed on this page.
		readonly seed: string | null;
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
	const reBrand = (lead: LeadElsewhere) => ({
		fantraxPlayerId: lead.fantraxPlayerId,
		playerName: lead.playerName,
		amount: parseMoney(lead.amount)
	});

	const teamMoney: TeamMoneyState | null = $derived(
		control.team === null
			? null
			: {
					capSpace: parseMoney(control.team.capSpace),
					rosterCount: control.team.rosterCount,
					leading: control.team.leading.map(reBrand),
					eligibleLeading: control.team.eligibleLeading.map(reBrand),
					minorLeagueOccupied: control.team.minorLeagueOccupied
				}
	);

	/**
	 * How often the page re-reads its own elapsed time. A named constant, and
	 * a plain interval — no backoff, no visibility heuristic and no network
	 * of any kind: this tick touches nothing but a number in this component.
	 */
	const TICK_MS = 1000;

	/**
	 * Milliseconds measured on this device since the first paint.
	 *
	 * A DELTA, never an origin. It starts at zero, which is what makes the
	 * server-rendered HTML and the first client paint agree.
	 *
	 * **Never negative.** `Date.now()` is a wall clock, and a device whose
	 * system time is adjusted BACKWARD mid-interval — an NTP correction, a
	 * timezone-fiddling user — would otherwise produce a negative delta,
	 * pulling `nowIso` earlier than the server's own instant and letting an
	 * Auction that has expired read as live again. The clamp is why the
	 * anchor is a floor: this page can run late, never early.
	 */
	let elapsedMs = $state(0);

	/**
	 * The instant every gate, phrase and countdown on this page reads.
	 *
	 * **The origin is the server's, and only the elapsed time is local.**
	 * `control.figuresAt` is the database clock, read once by the read path
	 * and handed over; `elapsedMs` is how long this device has measured since
	 * then. NFR §5 requires that a skewed client neither see a different
	 * close time nor bid after expiry, and both hold here: a device three
	 * hours fast crosses the close at the same real moment a correct one
	 * does, because its own wall clock never enters the sum. AD-29 exempts
	 * countdowns from freezing for exactly this reason — they derive from an
	 * absolute close instant the client already holds.
	 *
	 * Deriving this from `new Date()` would hand a skewed device a different
	 * answer. Deriving it from `$derived(new Date())` — which is what this
	 * page used to do — derives from nothing reactive at all, so it froze at
	 * load and a tab left open never crossed its own close.
	 *
	 * An unreadable anchor is passed through unchanged rather than replaced:
	 * `hasExpired` reads an unreadable `now` as NOT expired and the phrase
	 * helpers say so plainly, which is the honest answer when the server's
	 * own stamp cannot be read.
	 */
	const nowIso = $derived.by(() => {
		const anchor = parseInstant(control.figuresAt);
		if (anchor === null) return control.figuresAt;
		return formatInstant(anchor + elapsedMs);
	});

	// The tick, client-only because `$effect` never runs during SSR, and
	// cleaned up by the function it returns — Svelte calls that on teardown
	// and before every re-run, so a re-anchor cannot leave two intervals
	// running. `Date.now()` appears here and nowhere else on this page: it
	// measures a duration between two readings of the same clock, which is
	// the one thing a client clock is allowed to do.
	//
	// `control.figuresAt` is read for its DEPENDENCY, not its value: a
	// refused submit or any other reload hands over a fresh server instant,
	// and the elapsed count has to restart with it. Without this the new
	// origin would be added to the old device measurement and the page would
	// run ahead of the server by however long the tab had been open.
	$effect(() => {
		void control.figuresAt;
		elapsedMs = 0;
		const startedAt = Date.now();
		const ticking = setInterval(() => {
			// Clamped at zero: a backward system-clock adjustment must not
			// move this page's instant behind the server's anchor.
			elapsedMs = Math.max(0, Date.now() - startedAt);
		}, TICK_MS);
		return () => {
			clearInterval(ticking);
		};
	});

	const gateState: BidState = $derived({
		// The folded phase, straight off the wire. The ninth gate reads this and
		// nothing else, so the disabled control and the locked transaction refuse
		// a Bid outside the Auction Phase for one reason worded in one place.
		phase: control.phase,
		leadingBid:
			control.leadingAmount === null || control.leadingTeamId === null
				? null
				: { teamId: control.leadingTeamId, amount: parseMoney(control.leadingAmount) },
		// The persisted absolute close instant, straight off the wire — the
		// same string the fold holds and the lock will re-read. Nothing here
		// recomputes it, and no remaining duration is ever sent (AD-3).
		closesAt: auction.closesAt,
		// The fold's own contention state and Contender ids, straight off the
		// wire. Nothing here decides whether a lottery is running — the core
		// does, from these two facts, exactly as the locked transaction will.
		contention: control.contention,
		// The published commitment, off the wire. No gate reads it — it is
		// what `decide()` verifies a revealed seed against inside the lock,
		// and it is public, which is why it is already on this page.
		seedHash: auction.seedHash,
		contenders: control.contenderTeamIds,
		team: teamMoney,
		playerIsMinorLeagueEligible: control.playerIsMinorLeagueEligible
	});

	/**
	 * What the control says about the amount as it stands, from the core.
	 *
	 * `now` is `nowIso` below: the SERVER's instant plus the elapsed time
	 * this device has measured since it was handed over. Story 3.1's `expiry`
	 * gate reads it, so it had to become real — and it is anchored on the
	 * server's clock rather than read from this machine's, because AD-3 makes
	 * server time the only time a rule may be decided against and NFR §5
	 * requires a skewed device to see the same close as a correct one.
	 *
	 * Disabling the control is still never the check (AD-9): the same gate
	 * runs again inside the lock, against the database's own clock.
	 */
	const typed = $derived(
		bidControlState({
			state: gateState,
			fantraxPlayerId: auction.fantraxPlayerId,
			viewerTeamId: control.viewerTeamId,
			amountText: amount,
			confirmed,
			now: nowIso
		})
	);

	/**
	 * The freshness state, from the ONE contract the layout mounts (AD-29).
	 *
	 * Read, never derived: `deriveFreshness` in `core/freshness.ts` decides
	 * which of the three states holds, and this page asks which one it is the
	 * same way it asks which contention state the fold produced.
	 */
	const staleBlocked = $derived(freshness.state === 'stale');

	/**
	 * The one flag both the affordance and the stated reason read from. The
	 * server re-derives every gate under the lock regardless — disabling a
	 * control is never the check.
	 *
	 * Stale JOINS this existing path rather than adding a second one. AD-29's
	 * obligation in Stale is "bid controls disable with the reason stated", and
	 * this page already had exactly that mechanism for nine gates; a parallel
	 * disable would have been a second way for this control to be off, with a
	 * second place to word why.
	 */
	const blocked = $derived(typed.blocked || staleBlocked);


	/**
	 * The one reason the disabled control carries, and never two.
	 *
	 * It is VISUALLY HIDDEN (see the markup): the page no longer explains a
	 * refusal in prose beneath the control — the refusal panel above carries
	 * the headline, the delta, the reassurance and the arithmetic — but a
	 * disabled control that names no reason at all is exactly what a screen
	 * reader user is left with nothing by, and it is the justification for a
	 * disabled control's label being exempt from WCAG 1.4.3.
	 *
	 * Stale is stated FIRST (Story 4.1): when the app cannot confirm its own
	 * figures, the arithmetic those gates ran on is exactly what is in doubt.
	 * All three sentences come out of the core, so no two branches can word
	 * the same refusal differently.
	 */
	const reason = $derived(
		staleBlocked ? STALE_BID_REASON : control.available ? typed.detail : control.detail
	);

	/**
	 * The amount as the field holds it, read through the core's own parser —
	 * the gate state below is derived from THIS rather than from the raw
	 * string, so the control is disabled against the figure a Manager typed.
	 */
	const reading = $derived(readBidAmount(amount));

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
			// The server-anchored instant, for the same reason `typed` passes
			// it: `expiry` is the one gate that reads `now`, and the viewer's
			// own clock must never be an input to a rule (AD-3 — server time,
			// injected). Only the ELAPSED delta is measured locally.
			nowIso
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

	// The two relative phrases, from the same server-anchored instant every
	// gate above reads — so the countdown a Manager watches and the gate that
	// would refuse their Bid cannot describe two different moments. The pure
	// helpers derive the phrases; `Intl.DateTimeFormat` below renders the
	// absolute stamps in the viewer's own timezone, which is the split
	// `core/instant.ts`'s own header describes.
	//
	// Both are safe to derive on the server as well as the client: every
	// instant involved is UTC, and the arithmetic between two of them is the
	// same wherever it runs.
	const relative = $derived(relativePhrase(auction.nominatedAt, nowIso));
	// `closesInPhrase` rather than `relativePhrase`: a close time is ahead of
	// the reader, and the "ago" phrasing would read a future instant as
	// "moments ago".
	const closesIn = $derived(
		auction.closesAt === null ? null : closesInPhrase(auction.closesAt, nowIso)
	);
	// Whether the Auction Clock has run out, through the core's ONE
	// derivation — the identical function the `expiry` gate calls and the
	// locked transaction reaches. The panel states it for EVERY viewer,
	// bound to a Team or not: an expiry is a fact about the Auction, not
	// about who is looking at it, and the control's own refusal for an
	// unbound Manager is a different and standing one.
	const expired = $derived(hasExpired(auction.closesAt, nowIso));

	// Whether a lottery is running: the FOLD's own state literal, compared
	// against, not a rule re-derived here and not a boolean the server sent.
	// The server decided this when it folded the log and serialised the
	// literal; the page is asking which of three named states it is in, the
	// same way it asks whether `auction.closesAt` is null.
	const isContention = $derived(gateState.contention === 'minimum_bid');

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
	<!-- The identity block: the name, and the line that identifies the Player
	     beneath it. The metadata had a `.panel` of its own — a background, a
	     border, a `Player` label and twelve characters inside it — for two
	     fields that belong to the name they sit under.

	     Rendered only when the reference row exists, and OMITTED rather than
	     blanked when it does not: the matrix names a blank rendering as the
	     wrong answer, and an absent line is absent, not empty. -->
	<header class="masthead">
		<h1 class="display">{auction.playerName}</h1>
		{#if auction.metadata !== null}
			<p class="metadata" id="auction-metadata">
				{auction.metadata.nbaTeam} &middot; {auction.metadata.positions}
			</p>
		{/if}
	</header>

	<section class="panel">
		<p class="section-label">Price</p>
		<!-- The current price and who holds it, both from the fold. The
		     Leading Bidder is spelled out with the acting Manager: there is
		     no anonymity at any point on this page.

		     The price takes the money size DESIGN.md gives a figure on the
		     surface that bids — it is the one number a Manager reads before
		     anything else. "No bids yet." is a STATEMENT rather than a figure,
		     so it stays at the prose size: what distinguishes an absent price
		     from a small one is the weight it is set in. -->
		{#if auction.price === null}
			<p class="prose" id="auction-price">No bids yet.</p>
		{:else}
			<p class="price" id="auction-price">{auction.price}</p>
		{/if}
		<p class="prose" id="auction-leading-bidder">
			{#if auction.leadingBidder === null}
				No Team leads this Auction yet.
			{:else}
				Leading Bidder: {auction.leadingBidder}
			{/if}
		</p>
		<!-- The contention state, worded by the fold that decides it. A plain
		     label and no chip for the ambient states: `DESIGN.md` gives those
		     a plain label, and the one attention colour marks Outbid and
		     refusal.

		     A lottery is the ONE exception `DESIGN.md:162` grants — the 3px
		     left accent bar in `lottery`, which no other element on any
		     surface may borrow. It carries an icon AND a word beside the
		     colour, because no state on this page may be conveyed by colour
		     alone: a greyscale screenshot has to read identically, and the
		     word is what makes it.

		     Every string here is the core's. The label is the glossary term
		     from the fold, the count and the clock statement are sentences
		     from the same module, and this file spells none of them. -->
		<div class="contention" class:lottery={isContention}>
			{#if isContention}
				<!--
					The state, and what it MEANS one tap behind it.

					The label carried the fold's sentence beside it — `Minimum-Bid
					Contention` as a chip and `Minimum-Bid Contention.` as prose,
					the same words twice on one line — so the sentence is gone from
					the lottery branch and the label states the state alone. It is
					`MINIMUM_LOTTERY_LABEL`, the card name the Bid Board and Your
					Positions print, so one contention goes by one name on every
					surface a Manager scans.

					`<details>`/`<summary>` and not a tooltip element, for
					`/nominate`'s reason: a real tooltip is hover, and this is a
					phone. It opens on tap AND on Enter, is announced expanded or
					collapsed, and needs no script.

					What it holds is the two EXPLANATIONS — that joining does not
					move the clock, and what the published digest commits to.
					~90 words of prose sat between the price and the Contender list
					on a surface a Manager opens to answer one question. The FACTS
					stay in the open: the Contender count, the Contenders in the
					fold's own order, the digest itself, and the link to the
					procedure for checking it. EXPERIENCE.md:155 asks the card to
					state the clock in words; it does, one tap from the label the
					statement is about.
				-->
				<details class="explainer" id="auction-contention">
					<summary>
						<span class="contention-icon" aria-hidden="true">&#9670;</span>
						<span class="contention-label">{MINIMUM_LOTTERY_LABEL}</span>
						<!-- The affordance as a mark rather than a sentence, drawn
						     from `currentColor` so it tracks the text beside it.
						     `aria-hidden`, because a screen reader is already told
						     this is a disclosure and whether it is expanded; the
						     words it stands in for are in the hidden span below. -->
						<span class="explainer-mark" aria-hidden="true">
							<svg viewBox="0 0 16 16" focusable="false">
								<circle cx="8" cy="8" r="6.5" />
								<path d="M8 7.25v4" />
								<path d="M8 4.75v.5" />
							</svg>
						</span>
						<span class="visually-hidden">How this contention works</span>
					</summary>
					<p class="prose" id="auction-contention-clock">{CONTENTION_CLOCK_UNMOVED}</p>
					<!-- The commit half of the commit-reveal, explained. The digest
					     itself stays in the open below — this says what it is FOR,
					     and only where there is one to explain. -->
					{#if auction.seedHash !== null}
						<p class="prose" id="auction-seed-commitment">{SEED_COMMITMENT}</p>
					{/if}
				</details>
				<!-- The count, then the Teams. The list is the
				     fold's own order — ascending join `seq` — and is never
				     re-sorted here: AD-14 makes that order an input to the
				     winner, so a surface that reordered it would be showing a
				     list the draw will not run over. Keyed on the position
				     rather than the name, because two Teams may legitimately
				     share a display name and a duplicate key is a render
				     error. -->
				<p class="prose" id="auction-contender-count">
					{contenderCountSentence(auction.contenderCount)}
				</p>
				{#if auction.contenders.length > 0}
					<ul class="contenders" id="auction-contenders">
						{#each auction.contenders as contender, position (position)}
							<li class="prose">{contender}</li>
						{/each}
					</ul>
				{/if}
				<!-- The commit half of the commit-reveal, published from the
				     moment the lottery opens so a Manager can record it now
				     and check the reveal against it at the draw. The seed
				     itself is in a table no role can read, and nothing on this
				     page has ever seen it. The VALUE stays in the open; what it
				     commits to is stated behind the label above.

				     One rendering or the other, never both, and never neither.
				     A lottery whose commitment folded to null used to render
				     nothing at all here, which was indistinguishable from a
				     commitment that simply failed to appear — and AD-14's
				     trust rests on a Manager being able to SEE the commitment,
				     so its absence is exactly the case worth naming out loud.
				     The sentence is the core's own, the same one the
				     dissolution prints for the same absence. -->
				{#if auction.seedHash !== null}
					<p class="prose seed-hash" id="auction-seed-hash">{auction.seedHash}</p>
				{:else}
					<p class="prose" id="auction-seed-unverifiable">{SEED_COMMITMENT_UNVERIFIABLE}</p>
				{/if}
				<!-- What to DO with the value above. A 64-character hex string
				     nobody has been told the procedure for is not a check, and
				     the procedure is prose rather than a control: it is run in
				     a spreadsheet, by hand, off this page. Not a destination
				     in the catalog — the question is asked here, looking at a
				     commitment, and nowhere else. -->
				<p class="prose">
					<a href="/verify" id="auction-verify-link">How the draw is checked</a>
				</p>
			{:else}
				<!-- Every other state is one sentence from the fold, and the
				     label above belongs to the lottery alone: `Open` and
				     `Awaiting an Opening Bid` have no accent bar, no icon and
				     nothing behind them to explain. -->
				<p class="prose" id="auction-contention">{auction.contention}</p>
			{/if}
		</div>

		<!-- The Auction Clock, on the price panel rather than a panel of its
		     own: what a Manager weighs is the standing price AND how long is
		     left to answer it, and a border between the two made them two
		     questions. Absent until the first Bid, because until then there is
		     no clock to state — the server persists an ABSOLUTE close instant
		     and this page counts down from it; "seconds remaining" is never
		     sent (AD-3).

		     Rendered TWICE on one ruled row, relative and absolute in the
		     viewer's own timezone, and the absolute is never dropped. -->
		{#if auction.closesAt !== null}
			<p class="clock" id="auction-closes-at">
				{#if closesAtAbsolute !== null}
					<span class="clock-absolute" id="auction-closes-absolute">{closesAtAbsolute}</span>
				{/if}
				<span id="auction-closes-relative">{closesIn}</span>
			</p>
			<!-- The core's own sentence, printed. Not worded here, and not a
			     second reading of the countdown beside it: both derive from
			     the same absolute close instant and the same server-anchored
			     now, so a tab left open with no update at all still crosses
			     its own close (AD-29). -->
			{#if expired}
				<p class="prose" id="auction-expired">{AUCTION_EXPIRED}</p>
			{/if}
		{/if}
	</section>

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
			<!-- Labelled LAST-KNOWN in anything but Live (AD-29): in a non-Live
			     state money either carries its age or the control it would
			     authorise is disabled, and while the control is still enabled
			     this label is the carrying half. The label is the core's, in
			     every state including Live — the surface prints one field. The
			     age itself is stated once, by the notice the layout mounts, so
			     it is not repeated here. -->
			<p class="section-label">{MAXIMUM_BID_LABELS[freshness.state]}</p>
			<CapBreakdown lines={standingBreakdown} id="auction-maximum-bid" />
		</section>
	{/if}

	<section class="manager-block">
		<p class="section-label">Place a Bid</p>

		<!-- The refusal panel, above the control it is about, ending with the
		     disabled control that follows it. It appears only for a refusal
		     that HAS arithmetic behind it; the three raised before any
		     transaction opens carry none, and the control is simply off. -->
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

		<form method="POST" action="?/bid">
			<!-- The three parts of the act on one row, in the order they are
			     performed: type an amount, tick the confirmation, press the
			     submit. It is the only horizontal pairing on this page, and it
			     wraps rather than shrinking any of the three below the touch
			     floor at 375px.

			     The confirmation sits BETWEEN the field and the submit rather
			     than beneath them: it is the second half of a two-part act,
			     and a Manager's hand travels amount → confirm → place without
			     passing over the button that commits on the way. The act is
			     unchanged — the submit is still disabled until the box is
			     ticked, and the core is still what decides that.

			     The field is pre-filled with the smallest LEGAL Bid — a rule,
			     never a recommendation. -->
			<div class="bid-row">
				<label class="visually-hidden" for="auction-bid-amount">
					Your Bid, in whole dollars
				</label>
				<!-- The FIELD is disabled on the standing condition, not just the
				     submit: when this Auction will take no Bid from your Team at
				     any amount, there is nothing to type.
				     `control.available` is the server's answer at LOAD, and it
				     cannot change in place — so expiry is named beside it. A
				     clock that has run out is exactly the kind of standing
				     condition this binding is for: no amount will change it.
				     Without this, a tab left open across its own close would
				     grey the submit and leave the field typable, which is the
				     one case AD-29 exempts countdowns from freezing FOR.
				     Stale is the third such standing condition (Story 4.1): when
				     the app cannot confirm the figures beside the field, there is
				     nothing to type either — and unlike the two above, it clears
				     by itself the moment the server is reachable again. -->
				<input
					id="auction-bid-amount"
					class="bid-amount"
					name="amount"
					type="text"
					inputmode="numeric"
					autocomplete="off"
					aria-describedby="auction-bid-availability"
					disabled={!control.available || expired || staleBlocked}
					bind:value={amount}
				/>
				<!-- The second part of the act, between the amount and the
				     control that commits it. The consequence sentence that
				     stood beside this box, and again as a paragraph above the
				     form, is gone from both: it said one thing twice on the one
				     surface that must read cleanly, and what it named — the
				     amount — is in the field beside it, being typed. -->
				<label class="confirm" for="auction-bid-confirm">
					<input
						id="auction-bid-confirm"
						name="confirm"
						type="checkbox"
						value="yes"
						bind:checked={confirmed}
					/>
					<span class="prose">I confirm this Bid.</span>
				</label>
				<button
					class="control-manager"
					type="submit"
					disabled={blocked}
					aria-describedby="auction-bid-availability"
				>
					Place the Bid
				</button>
			</div>
		</form>

		<!-- The reason, BENEATH the control it is about and always in the DOM
		     so the two `aria-describedby` references above can never dangle —
		     but VISUALLY HIDDEN. The sentence it prints is every
		     `bidRefusalDetail` framing ("No Bid was placed: …"), which read as
		     explainer clutter on the one surface that must read cleanly: the
		     panel above already states a refusal, and the control being off is
		     the visible answer for the rest. It stays in the accessibility
		     tree because a disabled control naming no reason is what WCAG
		     1.4.3's exemption is conditioned on. Worded by the core in every
		     branch, including the ready one — the surface prints one field. -->
		<p class="visually-hidden" id="auction-bid-availability">{reason}</p>

		<!-- The outcome of a submit is the only place a Manager learns whether
		     the Bid landed, and after a form post the focus is still on the
		     control that was pressed. `role="status"` announces it politely
		     rather than leaving a screen reader user to go looking. -->
		<div role="status">
			<!-- The framed refusal sentence that stood here is gone, along with
			     the availability line and the minimum-legal line that stood
			     beneath the control: the panel above carries the headline, the
			     delta, the reassurance and the arithmetic, and nothing on this
			     screen restates them in prose. -->
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
					<!-- Who bid and when on the left, what they bid on the right —
					     one row instead of three stacked lines, so a seven-Bid
					     history is read rather than scrolled. The amounts share a
					     trailing edge, which is what makes a column of tabular
					     figures scannable. -->
					<li class="history-row">
						<span class="history-bidder">
							<span class="prose">{bid.bidder}</span>
							<span class="history-when">{relativePhrase(bid.occurredAt, nowIso)}</span>
						</span>
						<span class="history-amount">{bid.amount}</span>
					</li>
				{/each}
			</ul>
		{/if}

		<!-- The nomination, in the footnote position the mock gives it: who put
		     this Player up and when. It had two `.panel`s of its own above the
		     price — a Team name and a timestamp, each with a heading, in the
		     two most valuable inches on the page — and it belongs at the foot
		     of the record it opens, which is what the history IS.

		     The Team is spelled out with its acting Manager attached, from
		     `formatTeamManager`'s one rendering, never re-worded here. Time
		     appears TWICE: a relative phrase and an absolute stamp in the
		     viewer's own timezone, and the absolute is never dropped for
		     space. -->
		<p class="footnote" id="auction-nominated-at">
			<span class="section-label">Nominated by</span>
			<span id="auction-nominating-team">{auction.nominatingTeam}</span>
			&middot;
			<span id="auction-nominated-relative">{relative}</span>
			{#if nominatedAbsolute !== null}
				&middot;
				<span id="auction-nominated-absolute">{nominatedAbsolute}</span>
			{/if}
		</p>
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

	/* The line that identifies the Player, directly under the name it names. */
	.metadata {
		color: var(--color-text-secondary);
		font-size: var(--size-13);
		font-variant-numeric: var(--numerals);
	}

	/*
	 * The standing price. The money treatment DESIGN.md specifies for a figure
	 * on a bidding surface: the UI face at the largest size in the scale,
	 * tabular, tightened, in `text`.
	 */
	.price {
		font-family: var(--font-ui);
		font-size: var(--size-26);
		font-variant-numeric: var(--numerals);
		letter-spacing: -0.025em;
		color: var(--color-text);
	}

	/*
	 * The clock row: the absolute stamp and the countdown at opposite edges,
	 * ruled off from the price above them. `space-between` with `flex-wrap`,
	 * so at 375px the pair stacks instead of colliding.
	 */
	.clock {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-row-gap);
		padding-top: var(--space-row-gap);
		border-top: var(--border-width) solid var(--color-border);
		color: var(--color-text);
		font-size: var(--size-12-5);
		font-variant-numeric: var(--numerals);
	}

	.clock-absolute {
		color: var(--color-text-secondary);
	}

	/*
	 * The footnote line at the foot of the history — DESIGN.md's `--size-11`
	 * `text-tertiary` for timestamps and footnotes, so the record's provenance
	 * sits a step below the Bids themselves.
	 */
	.footnote {
		color: var(--color-text-tertiary);
		font-size: var(--size-11);
		line-height: 1.55;
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

	/*
	 * The confirmation, between the amount and the submit. Centred against
	 * the 46px field it sits beside rather than top-aligned, and the optical
	 * nudge below goes with it: against a centred line it would only push the
	 * box off centre by the same 2px it was added to correct.
	 */
	.confirm {
		display: flex;
		align-items: center;
		gap: var(--space-row-gap);
		min-height: var(--touch-min);
	}

	/*
	 * 22px sizes a native checkbox's own box, which `tokens.css` has no token
	 * for — it sizes controls and spacing, not a browser widget. Copied
	 * verbatim from `/nominate`'s confirm so the two read identically;
	 * inventing a token is an Ask First item and this is not the story to open
	 * it in.
	 */
	.confirm input[type='checkbox'] {
		width: 22px;
		height: 22px;
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

	/*
	 * Bidder and instant on the left, amount on the right, baseline-aligned so
	 * the Team name and its figure sit on one line. It wraps rather than
	 * shrinking either side at 375px.
	 */
	.history-row {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-row-gap);
		padding-top: var(--space-row-gap);
		border-top: var(--border-width) solid var(--color-border);
	}

	/* The two halves of one fact, stacked tight: who bid, and when. */
	.history-bidder {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.history-amount {
		color: var(--color-text);
		font-size: var(--size-15);
		font-variant-numeric: var(--numerals);
	}

	.history-when {
		color: var(--color-text-tertiary);
		font-size: var(--size-11);
	}

	/*
	 * The contention block inside the Price panel. Flow layout with the page's
	 * own row gap, so it reads as part of the panel rather than a panel of its
	 * own — there is no second background and no second border.
	 */
	.contention {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
	}

	/*
	 * The 3px left accent bar marking a Minimum-Bid Contention — DESIGN.md's
	 * one structural exception, and no other element may borrow the device.
	 * It never carries the state ALONE: the icon and the label beside it are
	 * what make a greyscale screenshot read identically.
	 */
	.lottery {
		border-left: var(--accent-bar-width) solid var(--color-lottery);
		padding-left: var(--space-panel-padding);
	}

	/*
	 * The disclosure behind the state label — `/nominate`'s explainer,
	 * unchanged in behaviour: the summary is the whole row, so the target is
	 * wide however short it is, and the default marker is dropped because the
	 * mark beside the label already carries the affordance.
	 */
	.explainer > summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-row-gap);
		cursor: pointer;
		list-style: none;
	}

	.explainer > summary::-webkit-details-marker {
		display: none;
	}

	/*
	 * The sighted affordance and nothing else — the words it stands in for
	 * are in the hidden span beside it, which is what a screen reader reads.
	 * The padding is the tap target; the glyph is sized off a type token
	 * rather than a literal, so it tracks the label beside it.
	 */
	.explainer-mark {
		display: flex;
		flex-shrink: 0;
		padding: var(--space-row-gap);
		color: var(--color-text-tertiary);
	}

	.explainer-mark svg {
		width: var(--size-13);
		height: var(--size-13);
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
	 * The disclosure's own rows, which `.contention`'s flex gap does not reach
	 * — a `<details>` is one flex child, and its contents lay out inside it.
	 */
	.explainer > .prose + .prose {
		margin-top: var(--space-row-gap);
	}

	.contention-icon {
		color: var(--color-lottery);
	}

	.contention-label {
		color: var(--color-lottery-text);
	}

	.contenders {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		list-style: none;
	}

	/*
	 * 64 hex characters have no word boundary in them, so they must be told to
	 * wrap or the panel scrolls sideways at 375px. `break-all` rather than
	 * `break-word`: every character of a commitment is load-bearing, and a
	 * hash that wraps mid-run is still checkable while one that overflows the
	 * viewport is not.
	 */
	.seed-hash {
		color: var(--color-text-secondary);
		font-size: var(--size-12-5);
		font-variant-numeric: var(--numerals);
		word-break: break-all;
	}

</style>
