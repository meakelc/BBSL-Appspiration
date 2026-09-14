<script lang="ts">
	// The shell every page renders inside: the header menu, and — since Story
	// 3.7 — the phase-transition announcement.
	//
	// **The announcement is not the ambient phase sentence.** `HeaderMenu`
	// already prints `data.phase.sentence` on every page and has since Story
	// 1.4; that says what the phase IS. This says it CHANGED, and it is the one
	// thing a Manager who was asleep when the League Clock expired needs told.
	// Both are worded in `src/lib/server/phase.ts` and neither is written here:
	// no route, component or test words a phase.
	//
	// **It is a standing statement, not a live one.** `role="status"` would
	// re-announce the identical sentence to a screen reader on every single
	// navigation for the weeks Contract Assignment lasts, which is how a live
	// region becomes noise nobody can turn off. This is an ordinary `region`
	// landmark named by its own heading, so it is reachable by landmark and
	// heading navigation and announced exactly when a reader goes looking for
	// it.
	//
	// **It borrows no reserved device.** `DESIGN.md` reserves the 3px accent
	// bar for the Minimum-Bid Contention's left bar and the refusal panel's top
	// bar and says no other element may borrow it, and reserves `attention` for
	// Outbid "and nothing else in the entire system". So this is a plain
	// `.panel` — the shared 1px border and one-step-lighter surface — inside a
	// `.page` band, and it introduces no token, no colour and no sizing
	// literal.
	//
	// **Since Story 4.1 it also mounts the freshness contract, once.** AD-29
	// requires ONE freshness state and ONE age across every surface; mounting the
	// notice here rather than per page is what makes that structural instead of
	// a habit each new screen has to remember. 4.2's strip, 4.3's board, 4.4's
	// landing and 4.6's index inherit it by existing.
	//
	// The notice itself renders nothing while Live, so on a healthy client this
	// adds no element to any page.
	//
	// **And it runs ONLY for a signed-in Manager.** A visitor with no session has
	// no figures to protect and no controls to disable, and the liveness
	// endpoint's `401` is indistinguishable from an outage on the client — so an
	// ungated contract showed `/signin` an assertive "cannot reach the server"
	// alert two minutes in, about the server that had just rendered the page.
	// Both the mount and `start()` are gated on the one boolean
	// `+layout.server.ts` sends. A session that lapses MID-VISIT is a different
	// case and is deliberately NOT gated out: the contract is already running,
	// the `401` degrades it on schedule, and "these figures are no longer
	// refreshable" is then true and worth saying.
	import '$lib/styles/global.css';
	import type { Snippet } from 'svelte';

	import { freshness } from '$lib/client/freshness.svelte.ts';
	import FreshnessNotice from '$lib/components/FreshnessNotice.svelte';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import MobileNav from '$lib/components/MobileNav.svelte';
	import PersistentStrip from '$lib/components/PersistentStrip.svelte';

	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	// Every server read re-anchors the contract, including the very first one.
	// A load that came back IS proof the server was reachable, which is why a
	// freshly rendered page is never born Stale — and why an `invalidateAll()`
	// triggered by a raised watermark pays for its own liveness check on the way
	// through. Reactive on purpose: this re-runs on every navigation and every
	// reload, and does no network work of its own.
	$effect(() => {
		if (!data.signedIn) return;
		freshness.observeServerRead({ watermark: data.watermark, at: data.serverInstant });
	});

	// The channel and the poll, started once and torn down with the layout.
	// `data.signedIn` is the ONLY reactive value it reads, so it does not re-run
	// on navigation — a socket reopened on every page change would churn the
	// connection the contract exists to watch — but it does re-run when a
	// Manager signs out, which tears the contract down through the cleanup
	// below. `start()` is idempotent regardless.
	$effect(() => {
		if (!data.signedIn) return;
		freshness.start();
		return () => {
			freshness.stop();
		};
	});
</script>

<!-- The header menu is now the FALLBACK trigger, not a second one. The strip
     carries the same `DestinationsList` and, since it gained a hamburger, says
     so — two identical menus, one at each end of the screen, was one menu too
     many. But the strip does not mount for a signed-out visitor, for a Manager
     bound to no Team, or in Setup (`+layout.server.ts`'s three gates), and a
     page with neither is a page with no navigation and no way to reach
     Sign-in. So exactly one of the two renders, decided by the one gate that
     already decides the strip. -->
{#if data.stripTeam === null}
	<HeaderMenu destinations={data.destinations} phaseSentence={data.phase.sentence} />
{/if}

<!-- The persistent strip, mounted ONCE for every surface beneath the layout —
     the same AD-29 reason the freshness notice is mounted here rather than
     per page. It is gated on `data.stripTeam`, which the server load resolves
     to `null` for a signed-out visitor, for a Manager bound to no Team, in
     Setup, and on any read failure: one gate, decided server-side, rather
     than four conditions restated in markup.

     **It is mounted HERE, immediately after the header, and that position is
     load-bearing.** On a phone the strip is `position: fixed` to the top, so
     DOM order is invisible; at 640px it becomes `position: static` and
     renders exactly where it sits in the document. Mounted after the page
     content — where it once was — `static` put it at the FOOT of the page, so
     Maximum Bid was reachable on desktop only by scrolling to the bottom of
     every surface. The requirement is persistent visibility at every width,
     not a mobile convenience (`epic-4-context.md:44`), so the strip must
     precede the page content it is meant to stay in front of. On a phone that
     now agrees with where it renders as well: it is the top edge, and it is
     announced first, because it states the figures the page beneath it is
     read against.

     It carries FACTS and derives the figure itself (AD-7). The `serverInstant`
     it is handed is the same one the freshness contract anchors on, so the one
     gate that asks what time it is is answered by the server's clock and never
     the device's. -->
{#if data.stripTeam !== null}
	<PersistentStrip
		team={data.stripTeam}
		phase={data.phase.name}
		phaseSentence={data.phase.sentence}
		destinations={data.destinations}
		now={data.serverInstant}
	/>
{/if}

<!-- Gated on the session, not merely on the state: a signed-out visitor must
     get no notice and no live region at all, not an empty one that could
     later be filled by a contract that should never have started. -->
{#if data.signedIn}
	<FreshnessNotice
		state={freshness.state}
		lastLivenessOkAt={freshness.lastLivenessOkAt}
		now={freshness.now}
	/>
{/if}

{#if data.phase.announcement !== null}
	<div class="page">
		<section class="panel" aria-labelledby="phase-announcement-heading">
			<h2 id="phase-announcement-heading" class="section-label">
				{data.phase.announcement.heading}
			</h2>
			<p class="prose">{data.phase.announcement.body}</p>
		</section>
	</div>
{/if}

{@render children()}

<!-- The mobile destination bar, mounted ONCE for every surface beneath the
     layout, for the same AD-29/AD-30 reason the strip and the freshness
     notice are: one bar, one selection from one destination list, inherited
     by every screen rather than restated per page.

     **It is mounted LAST, after the page content, and that position is
     load-bearing in the opposite direction to the strip's.** The bar is
     `position: fixed` below 640px and `display: none` at 640px and above, so
     it never renders in the flow and its DOM position never places it
     visually. What its position does decide is READING order: a bar of five
     destinations announced before the page would put the navigation between
     a Manager and the content on every single surface. After the content is
     where a screen reader and a keyboard both expect to find it, and it is
     reachable at any moment by landmark regardless.

     Gated on `data.signedIn` alone — NOT on `data.stripTeam`, which is the
     strip's gate. A Manager bound to no Team has no figures to state and so
     gets no strip, but they still have destinations and still deserve to
     reach them in one tap. The component renders nothing when the selection
     is empty, so the Setup case needs no condition here.

     It is handed the SAME `data.destinations` the strip's sheet is handed.
     One resolved list, two renderings of it; `navDestinations` narrows, and
     can never widen, what the server already decided this viewer may
     reach. -->
{#if data.signedIn}
	<MobileNav destinations={data.destinations} />
{/if}
