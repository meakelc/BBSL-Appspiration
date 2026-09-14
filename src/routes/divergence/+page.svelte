<script lang="ts">
	// The Commissioner-only Fantrax divergence surface (Story 7.9, FR-42).
	//
	// **The whole page exists to make SEVEN states visibly and textually
	// different from one another**, and one of them is the only one that may
	// ever read as good news:
	//
	//   1. STOPPED — the last read failed. States the reason and when the last
	//      good read was, and raises NOTHING: a membership up to an hour old
	//      compared against rosters that have moved since would propose acts
	//      against a world nobody has confirmed. `core/freshness.ts` is the
	//      app's precedent for a surface that says a pipe is down rather than
	//      showing nothing, and this is worded the same way.
	//   2. NEVER READ — configured, but the reader has not run yet. Distinct
	//      from stopped, because there is no "last good read" to name.
	//   3. NOT CONFIGURED (the READER) — a FANTRAX_* variable is unset, so no
	//      read has ever been attempted and none ever will be. Distinct from
	//      NEVER READ, because that one resolves by waiting and this one does
	//      not.
	//   4. UNREADABLE — a successful read whose stored membership will not read
	//      back. Stated rather than silently compared against nothing.
	//   5. NOT CONFIGURED (the TEAM MAP) — a Team has no Fantrax team id, or a
	//      Fantrax roster no Team claims. The Teams are NAMED, never counted
	//      (`server/import-status.ts:113-115`).
	//   6. TRIPPED — the plausibility guard refused the payload. It never
	//      clears itself: it stays tripped on every reload until the
	//      Commissioner acknowledges it, and acknowledging REVEALS the
	//      proposals rather than discarding them.
	//   7. CLEAN — and only this one says "no divergences".
	//
	// No sentence about any of them is written here. Every heading, statement
	// and proposal sentence arrives already worded by the pure core, so each has
	// exactly one definition in the codebase and this file cannot drift from it.
	//
	// **Every proposal is an ordinary link, not a form.** Following one opens
	// `/roster-trade` or `/roster-drop` pre-filled through the query string
	// those routes already read, with their own three guards and their own
	// mandatory reason still in front of the write. Nothing on this page can
	// commit anything, which is a property of it having no such control rather
	// than of a check.
	//
	// Types are declared structurally rather than imported from a server-only
	// module: nothing in the server-only library may ever be reachable from a
	// `.svelte` file. The wording constants ARE imported, from the pure core,
	// which AD-2 says both runtimes load.
	import {
		GUARD_HEADINGS,
		GUARD_STATEMENTS,
		NOT_CONFIGURED_HEADING,
		NO_DIVERGENCES_STATEMENT
	} from '$lib/core/rules/divergence.ts';

	import type { ActionData, PageData } from './$types';

	type TeamRef = { readonly teamId: string; readonly teamName: string };
	type Player = {
		readonly playerId: string;
		readonly fantraxPlayerId: string;
		readonly playerName: string;
	};

	type Proposal =
		| {
				readonly kind: 'trade';
				readonly fingerprint: string;
				readonly fromTeam: TeamRef;
				readonly toTeam: TeamRef;
				readonly sending: readonly Player[];
				readonly receiving: readonly Player[];
				readonly href: string;
				readonly sentence: string;
		  }
		| {
				readonly kind: 'drop';
				readonly fingerprint: string;
				readonly team: TeamRef;
				readonly players: readonly Player[];
				readonly href: string;
				readonly sentence: string;
		  };

	type Guard =
		| { readonly tripped: false }
		| {
				readonly tripped: true;
				readonly reason: 'missing_teams' | 'empty_roster' | 'volume';
				readonly fingerprint: string;
				readonly acknowledged: boolean;
				readonly detail: string;
		  };

	type Report = {
		readonly unmappedTeamNames: readonly string[];
		readonly unclaimedFantraxTeamIds: readonly string[];
		readonly configured: boolean;
		readonly guard: Guard;
		readonly proposals: readonly Proposal[];
		readonly suppressedCount: number;
		readonly dismissedCount: number;
		readonly arrivals: ReadonlyArray<{
			readonly playerId: string;
			readonly playerName: string;
			readonly fantraxTeamId: string;
			readonly teamName: string;
		}>;
		readonly clean: boolean;
	};

	type ReadState =
		| { readonly kind: 'never_read' }
		| { readonly kind: 'not_configured'; readonly missing: readonly string[] }
		| {
				readonly kind: 'stopped';
				readonly outcome: string;
				readonly detail: string | null;
				readonly failedAt: string;
				readonly lastGoodReadAt: string | null;
		  }
		| { readonly kind: 'unreadable'; readonly readAt: string }
		| { readonly kind: 'read'; readonly readAt: string; readonly moneyWarnings: readonly string[] };

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const read = $derived(data.read as ReadState);
	const report = $derived(data.report as Report | null);
	const volumeFraction = $derived(data.volumeFraction as number);
	const notice = $derived((form as { notice?: string } | undefined)?.notice);

	const guard = $derived(report?.guard ?? { tripped: false as const });
	const guardUnacknowledged = $derived(guard.tripped && !guard.acknowledged);

	/**
	 * The one boolean that decides whether the empty state may be shown at all.
	 *
	 * A blank list is only ever honest when a read succeeded, the Team map is
	 * complete, no guard is holding anything back and the comparison genuinely
	 * found nothing. Every other combination has its own sentence above.
	 */
	const clean = $derived(read.kind === 'read' && report !== null && report.clean);
</script>

<svelte:head>
	<title>Fantrax divergence — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1>Fantrax divergence</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	<!-- The pipe itself. Stated FIRST, because every figure below it is only as
	     current as the read that produced it. Five branches, no catch-all. -->
	<section class="panel">
		<h2 class="section-label">The last read</h2>

		{#if read.kind === 'not_configured'}
			<p class="prose" id="read-state">
				The Fantrax reader is not configured on this deployment, so no read has ever been
				attempted and none will be until it is. Unset: {read.missing.join(', ')}. This is
				not a statement about the League's rosters, and it does not resolve by waiting.
			</p>
		{:else if read.kind === 'never_read'}
			<p class="prose" id="read-state">
				Fantrax is configured but has never been read on this deployment, so there is
				nothing to compare against. This is not a statement about the League's rosters — it
				is a statement that the reader has not run yet.
			</p>
		{:else if read.kind === 'stopped'}
			<h3 class="section-label" id="read-heading">Stopped</h3>
			<p class="prose" id="read-state">
				The last attempt to read Fantrax, at {read.failedAt}, did not succeed
				({read.outcome}). Nothing below is a statement that the League's rosters agree — it
				is a statement that this app could not ask.
				{#if read.lastGoodReadAt}
					The last good read was at {read.lastGoodReadAt}, and nothing is proposed from it:
					a membership that old, compared against rosters that have moved since, would
					propose acts against a world nobody has confirmed.
				{:else}
					No read has ever succeeded, so there is nothing to compare against at all.
				{/if}
			</p>
			{#if read.detail}
				<p class="prose" id="read-detail">{read.detail}</p>
			{/if}
			<p class="prose">
				No Auction is affected. Bidding, nomination and every close carry on exactly as
				they would if this page did not exist — the read runs outside the write lock and
				can neither block nor reverse any of them.
			</p>
		{:else if read.kind === 'unreadable'}
			<p class="prose" id="read-state">
				The read at {read.readAt} succeeded, but what it stored will not read back as a
				roster membership, so there is nothing to compare. Nothing below is a statement
				that the League's rosters agree. The next read replaces it.
			</p>
		{:else}
			<p class="prose" id="read-state">Fantrax was last read successfully at {read.readAt}.</p>
			{#if read.moneyWarnings.length > 0}
				<!-- NAMED, never counted (`server/import-status.ts:113-115`). The
				     Player stays a member: dropping a row from the membership set
				     over an unused field would manufacture a departure. -->
				<p class="prose" id="money-warning">
					These Players' salary figures in that read rounded to a value off the $500,000
					grid: {read.moneyWarnings.join(', ')}. The figure is refused, never the Player —
					nobody was removed from a roster because of it, and no money on this page comes
					from Fantrax.
				</p>
			{/if}
		{/if}
	</section>

	<!-- 3: not configured. Named Teams, never a count. -->
	{#if report && !report.configured}
		<section class="panel">
			<h2 class="section-label" id="not-configured-heading">{NOT_CONFIGURED_HEADING}</h2>
			{#if report.unmappedTeamNames.length > 0}
				<p class="prose" id="unmapped-teams">
					These Teams carry no Fantrax team id, so nothing can be compared for them:
					{report.unmappedTeamNames.join(', ')}. Teams are matched by a stored id and never
					by name, so there is no fallback — seed the ids and this page starts working.
				</p>
			{/if}
			{#if report.unclaimedFantraxTeamIds.length > 0}
				<p class="prose" id="unclaimed-teams">
					Fantrax returned rosters for team id(s) no Team in this app claims:
					{report.unclaimedFantraxTeamIds.join(', ')}. That is the same fault seen from the
					other side — either the ids are wrong or the league id is.
				</p>
			{/if}
			<p class="prose">
				Nothing is raised while the map is incomplete. A half-mapped League would read every
				unmapped Team's whole roster as having left, which is worse than saying nothing.
			</p>
		</section>
	{/if}

	<!-- 4: the plausibility guard. It never clears itself. -->
	{#if report && guard.tripped}
		<section class="commissioner-block">
			<h2 class="commissioner-label" id="guard-heading">{GUARD_HEADINGS[guard.reason]}</h2>
			<p class="prose" id="guard-statement">{GUARD_STATEMENTS[guard.reason]}</p>
			<p class="prose" id="guard-detail">{guard.detail}</p>
			<p class="prose">
				The threshold is {Math.round(volumeFraction * 100)}% of the League, set by
				configuration rather than in code.
			</p>

			{#if guard.acknowledged}
				<p class="prose" id="guard-acknowledged">
					You have acknowledged this read. Its proposals are shown below — acknowledging
					revealed them, it did not discard them.
				</p>
			{:else}
				<p class="prose" id="guard-suppressed">
					{report.suppressedCount} proposal(s) are held back until you acknowledge this. This
					page will keep saying so on every reload; it does not clear itself, and nothing
					below is a statement that the League agrees.
				</p>
				<form method="POST" action="?/dismiss">
					<input type="hidden" name="fingerprint" value={guard.fingerprint} />
					<!-- Which of the two acts this is. Acknowledging a guard REVEALS
					     the proposals it was holding back; dismissing a divergence puts
					     one away. One notice for both told the Commissioner the
					     opposite of what had just happened. -->
					<input type="hidden" name="kind" value="guard" />
					<button class="control-commissioner" type="submit">
						I have checked this read — show me the proposals
					</button>
				</form>
			{/if}
		</section>
	{/if}

	<!-- The unknown arrivals: an ERROR, never a proposal, and named. -->
	{#if report && report.arrivals.length > 0}
		<section class="panel">
			<h2 class="section-label" id="arrivals-heading">Unknown arrivals</h2>
			<p class="prose">
				These Players are on a Fantrax roster, are held by no Team in this app and won no
				Auction here. There is no act that fixes this from inside the app: it means the
				league id is wrong, the period is wrong, or somebody changed a roster out of band.
			</p>
			<ul class="stack">
				{#each report.arrivals as arrival (arrival.playerId)}
					<li class="row">
						<span class="row-lead">{arrival.playerName}</span>
						<span class="prose">on {arrival.teamName}'s Fantrax roster</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<!-- The proposals. Each one is a link into the act that already exists. -->
	{#if report && report.proposals.length > 0}
		<section class="panel">
			<h2 class="section-label" id="proposals-heading">Proposals</h2>
			<p class="prose">
				Each of these opens the existing act, pre-filled. Nothing is written by following a
				link: the Trade and the Drop each still demand their own reason before they commit,
				and each is still recorded in the Audit Log under your name.
			</p>

			<ul class="stack">
				{#each report.proposals as proposal (proposal.fingerprint)}
					<li class="proposal">
						<span class="row-lead">
							{#if proposal.kind === 'trade'}
								{proposal.fromTeam.teamName} ↔ {proposal.toTeam.teamName}
							{:else}
								{proposal.team.teamName}
							{/if}
						</span>
						<span class="prose">{proposal.sentence}</span>
						<a class="control-commissioner" href={proposal.href}>
							{proposal.kind === 'trade' ? 'Record this Trade' : 'Record this Drop'}
						</a>
						<form method="POST" action="?/dismiss">
							<input type="hidden" name="fingerprint" value={proposal.fingerprint} />
							<input type="hidden" name="kind" value="divergence" />
							<button class="dismiss" type="submit">Not now</button>
						</form>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<!-- 5: the genuinely-empty state, and the ONLY place the words appear. -->
	{#if clean}
		<section class="panel">
			<p class="prose" id="no-divergences">{NO_DIVERGENCES_STATEMENT}</p>
		</section>
	{/if}

	{#if report && report.dismissedCount > 0 && !guardUnacknowledged}
		<section class="panel">
			<p class="prose" id="dismissed-count">
				{report.dismissedCount} divergence(s) you dismissed earlier are still true and are not
				listed. Each returns by itself the moment its content changes.
			</p>
		</section>
	{/if}

	<!-- After a form post the focus is still on the control that was pressed, so
	     the outcome is announced politely rather than left to be found. -->
	<section class="panel">
		<div role="status">
			{#if notice}
				<p class="prose" id="dismiss-notice">{notice}</p>
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

	/* One column at every width. At 375px each proposal is a stack of its own
	   words — the Teams, the sentence, the act, the dismissal — so nothing
	   depends on a column header or on horizontal room. */
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		width: 100%;
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.row,
	.proposal {
		display: flex;
		flex-direction: column;
		gap: calc(var(--space-row-gap) / 2);
	}

	.row-lead {
		color: var(--color-text);
	}

	.proposal a.control-commissioner {
		align-self: flex-start;
		text-decoration: none;
	}

	/* Deliberately NOT a Commissioner control. `styles/commissioner.css`'s
	   filled block is for an act that changes what the arithmetic computes; a
	   dismissal changes nothing and undoes itself when the content does, so it
	   reads as the quieter of the two things on a proposal row. */
	.dismiss {
		align-self: flex-start;
		background: none;
		border: none;
		padding: 0;
		color: var(--color-text-secondary);
		text-decoration: underline;
	}
</style>
