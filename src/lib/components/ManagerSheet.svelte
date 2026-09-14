<script lang="ts">
	// The Manager's own confirmation sheet (Story 7.11, FR-44, UX-DR41) — the
	// step that stands between a Manager control and a committed Roster Move.
	//
	// **A sibling of `ReasonSheet.svelte`, never a variant of it.** That
	// component wraps everything in a commissioner-block section
	// unconditionally and takes a mandatory reason; this one wraps everything
	// in a manager-block section and takes none. UX-DR41 forbids one
	// component with a conditional reason field, and the reason is structural
	// rather than stylistic: `tests/signin-surface.test.ts` proves no Manager
	// control ever sits in a Commissioner block by reading the markup, and a
	// component that could render either block would be a component that guard
	// cannot decide about.
	//
	// **It words nothing.** Every sentence is `$lib/reason-sheet-view.ts`',
	// through `confirmSheetView` — the `core/strip.ts` / `PersistentStrip.svelte`
	// split. This file places the words; it does not choose them, and it pairs
	// no before with any after.
	//
	// **The commit is the Epic 1 Manager control class itself**, taken by name
	// from `styles/commissioner.css` rather than restyled here: filled, solid
	// 1px border, on the surface ground, and with no persistent label. All
	// four properties are the exact opposite of the Commissioner control's,
	// which is the whole point — the referee control and the player control
	// must never be confusable by muscle memory at 4am.
	//
	// **It is a form, not a modal.** No `<dialog>`, no popover, no focus trap
	// and no `use:enhance`. The sheet is the SECOND STEP of an ordinary form:
	// the picker navigated here, this posts. With JavaScript disabled the Move
	// still commits — or is still refused.
	import type { ConfirmSheetView } from '../reason-sheet-view.ts';

	let {
		/** Every word the sheet says — `confirmSheetView()`'s output. */
		view,
		/** Where the commit posts. */
		action
	}: {
		view: ConfirmSheetView;
		action: string;
	} = $props();
</script>

<form class="manager-sheet" method="POST" {action}>
	<section class="manager-block">
		<p class="manager-sheet-title">{view.title}</p>

		<h2 class="manager-sheet-act">{view.act}</h2>

		{#if view.rows.length > 0}
			<div class="manager-sheet-states">
				<p class="manager-sheet-states-heading">{view.rowsHeading}</p>
				<!--
					Keyed on `row.key`, which is positional — two rows that read the
					same must not collide on a duplicate key, and a Move naming the
					same figure twice is an ordinary thing to want to say.

					The consequence sentence renders INSIDE its own row: amber marks
					a consequence the two states do not show, and a note detached
					from its row cannot say which value it is about. The Maximum Bid
					row is the one this sheet exists for.
				-->
				{#each view.rows as row (row.key)}
					<div class="manager-sheet-state-row">
						<p class="manager-sheet-state-line">
							<span class="manager-sheet-state-label">{row.label}</span>
							<span class="manager-sheet-state-change">{row.change}</span>
						</p>
						{#if row.attention !== null}
							<p class="manager-sheet-attention">{row.attention}</p>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		<!--
			**There is no reason field here, and there is no branch that could
			add one.** FR-44 gives a Manager acting on their own Team a
			confirmation and no justification: it is an ordinary strategic
			decision, not a referee intervention. The Commissioner's on-behalf
			act goes through `ReasonSheet.svelte` instead.
		-->
		<div class="manager-sheet-controls">
			<!--
				Cancel is a link, not a button: it performs no act, and a second
				submit beside the commit is the thing a tired thumb gets wrong.
			-->
			<a class="manager-sheet-cancel" href={view.cancelHref}>{view.cancelLabel}</a>
			<button class="control-manager" type="submit">{view.commitLabel}</button>
		</div>

		<p class="manager-sheet-footer">{view.auditFooter}</p>
	</section>
</form>

<style>
	/*
	 * Every colour and dimension here is a token from `styles/tokens.css`.
	 *
	 * No selector below names either control class. The block's ground,
	 * padding and gap are `styles/commissioner.css`', and the commit control's
	 * fill and border are too — unweakened and unreached-for. A look-alike
	 * declared locally would be a control that resembles the class instead of
	 * being it.
	 */
	.manager-sheet {
		display: block;
	}

	.manager-sheet-title {
		margin: 0;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: var(--size-10);
		text-transform: uppercase;
		letter-spacing: 0.16em;
	}

	/* The act is set in the display face, as Player names are: it is the
	   sentence to be read, not a label to be scanned. */
	.manager-sheet-act {
		margin: 0;
		color: var(--color-text);
		font-family: var(--font-display);
		font-size: var(--size-18);
		font-weight: normal;
		line-height: 1.3;
	}

	.manager-sheet-states {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
	}

	.manager-sheet-states-heading {
		margin: 0;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: var(--size-10);
	}

	.manager-sheet-state-row {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
	}

	.manager-sheet-state-line {
		margin: 0;
		display: flex;
		justify-content: space-between;
		gap: var(--space-card-gap);
		font-family: var(--font-ui);
		font-size: var(--size-12);
		font-variant-numeric: var(--numerals);
	}

	.manager-sheet-state-label {
		color: var(--color-text-secondary);
	}

	.manager-sheet-state-change {
		color: var(--color-text);
	}

	/* The one attention accent in this component. Amber, never red — the
	   product has a single attention colour and no red anywhere. */
	.manager-sheet-attention {
		width: 100%;
		margin: 0;
		border-left: var(--accent-bar-width) solid var(--color-attention);
		background-color: var(--color-surface-sunken);
		padding: var(--space-row-gap) var(--space-card-gap);
		color: var(--color-text-prose);
		font-family: var(--font-ui);
		font-size: var(--size-11);
		line-height: 1.55;
	}

	.manager-sheet-controls {
		display: flex;
		align-items: center;
		gap: var(--space-card-gap);
	}

	/* A quiet way back, never a second filled control beside the commit. */
	.manager-sheet-cancel {
		display: inline-flex;
		align-items: center;
		min-height: var(--touch-min);
		padding: 0 var(--space-panel-padding);
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: var(--size-13);
		text-decoration: none;
	}

	.manager-sheet-footer {
		margin: 0;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: var(--size-11);
		line-height: 1.55;
	}
</style>
