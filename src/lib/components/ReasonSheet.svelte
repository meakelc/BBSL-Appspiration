<script lang="ts">
	// The reason sheet (Story 7.1) — the interstitial that stands between a
	// Commissioner control and a committed override.
	//
	// **It words nothing.** Every sentence is `$lib/reason-sheet-view.ts`',
	// which is a plain module `vitest` calls directly — the `core/strip.ts` /
	// `PersistentStrip.svelte` split. This file places the words; it does not
	// choose them, and it pairs no before with any after.
	//
	// **It is a form, not a modal.** No `<dialog>`, no popover, no focus trap
	// and no `use:enhance` — none of which appear anywhere in `src/`. The
	// sheet is the SECOND STEP of an ordinary form: the first step's control
	// navigated here, this posts. The one act in the product that must never
	// be skippable is therefore not gated on client JavaScript running. With
	// JS disabled, a broken bundle, or a hostile network, the reason is still
	// typed and the override still commits — or still refuses.
	//
	// **The commit is the Epic 1 Commissioner control class itself**, taken by
	// name from `styles/commissioner.css` rather than restyled here. All four
	// properties arrive with it: never filled, dashed border, the recessed
	// `commissioner-block` ground, and the generated persistent label. Nothing
	// in this file's scoped styles names either class, so nothing here can weaken
	// one — a look-alike declared locally would be a fifth control that
	// resembles the class instead of being it.
	//
	// **The block is a `<section>` inside the form, not the form itself.** The
	// repo-wide guard at `tests/signin-surface.test.ts:212-260` reads
	// `<section|div class="commissioner-block">…</section|div>` to prove no
	// Manager control ever sits in a Commissioner block and no control sits
	// outside a block at all. Wrapping the block in the form rather than
	// merging the two keeps this sheet inside that guard's reach.
	//
	// **The reason field is empty on open.** No placeholder, no default value,
	// no "same as last time", and no control that bypasses it. A placeholder
	// is a suggestion, and the suggestion would be taken at 4am by the one
	// person this whole class exists to protect from themselves.
	import type { ReasonSheetView } from '../reason-sheet-view.ts';

	let {
		/** Every word the sheet says — `reasonSheetView()`'s output. */
		view,
		/** Where the commit posts. The route is Story 7.2's; the sheet is not. */
		action
	}: {
		view: ReasonSheetView;
		action: string;
	} = $props();
</script>

<form class="reason-sheet" method="POST" {action}>
	<section class="commissioner-block">
		<p class="reason-sheet-title">{view.title}</p>

		<h2 class="reason-sheet-act">{view.act}</h2>

		{#if view.rows.length > 0}
			<div class="reason-sheet-states">
				<p class="reason-sheet-states-heading">{view.rowsHeading}</p>
				<!--
					Keyed on `row.key`, which is positional. Keying on the label or
					the sentence would make two rows that read the same collide on
					a duplicate key, and an override naming the same value twice is
					an ordinary thing to want to say.

					The consequence sentence renders INSIDE its own row, not as a
					list below the block: amber marks a consequence the two states
					do not show, and a note detached from its row cannot say which
					value it is about. A row with nothing non-obvious to say renders
					no marker at all.
				-->
				{#each view.rows as row (row.key)}
					<div class="reason-sheet-state-row">
						<p class="reason-sheet-state-line">
							<span class="reason-sheet-state-label">{row.label}</span>
							<span class="reason-sheet-state-change">{row.change}</span>
						</p>
						{#if row.attention !== null}
							<p class="reason-sheet-attention">{row.attention}</p>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		<div class="reason-sheet-reason">
			<label class="reason-sheet-reason-label" for="override-reason">{view.reasonLabel}</label>
			<textarea id="override-reason" name={view.reasonFieldName} rows="3" required></textarea>
		</div>

		<div class="reason-sheet-controls">
			<!--
				Cancel is a link, not a button: it performs no act, and a second
				submit beside the commit is the thing a tired thumb gets wrong.
			-->
			<a class="reason-sheet-cancel" href={view.cancelHref}>{view.cancelLabel}</a>
			<button class="control-commissioner" type="submit">{view.commitLabel}</button>
		</div>

		<p class="reason-sheet-footer">{view.auditFooter}</p>
	</section>
</form>

<style>
	/*
	 * Every colour and dimension here is a token from `styles/tokens.css`,
	 * which is copied character-for-character from DESIGN.md's frontmatter and
	 * asserted in both directions by `tests/tokens.test.ts`.
	 *
	 * No selector below names either Commissioner class. The block's ground,
	 * dashed rule, padding and gap are the stylesheet's, and the commit
	 * control's fill, border and generated label are too — unweakened and
	 * unreached-for. That is also why the sheet's own anatomy lives here
	 * rather than in `styles/commissioner.css`:
	 * `tests/commissioner.test.ts:385-398` asserts that stylesheet holds no
	 * reason-sheet text, and keeping the anatomy in the component is what
	 * keeps that guard green.
	 *
	 * The block lays its children out as a `flex-start` column, so each one
	 * takes its own full width rather than the block being told to stretch
	 * them.
	 */
	.reason-sheet {
		display: block;
	}

	.reason-sheet-title {
		margin: 0;
		color: var(--color-admin-text);
		font-family: var(--font-ui);
		font-size: var(--size-10);
		text-transform: uppercase;
		letter-spacing: 0.16em;
	}

	/* The act is set in the display face, as Player names and refusal
	   headlines are: it is the sentence to be read, not a label to be scanned. */
	.reason-sheet-act {
		margin: 0;
		color: var(--color-text);
		font-family: var(--font-display);
		font-size: var(--size-18);
		font-weight: normal;
		line-height: 1.3;
	}

	.reason-sheet-states {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
	}

	.reason-sheet-states-heading {
		margin: 0;
		color: var(--color-admin-label);
		font-family: var(--font-ui);
		font-size: var(--size-10);
	}

	/* The row is a column: the two states on one line, and the consequence
	   sentence — where the row has one — directly beneath them. */
	.reason-sheet-state-row {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
	}

	.reason-sheet-state-line {
		margin: 0;
		display: flex;
		justify-content: space-between;
		gap: var(--space-card-gap);
		font-family: var(--font-ui);
		font-size: var(--size-12);
		font-variant-numeric: var(--numerals);
	}

	.reason-sheet-state-label {
		color: var(--color-text-secondary);
	}

	.reason-sheet-state-change {
		color: var(--color-text);
	}

	/* The one attention accent in this component. Amber, never red — the
	   product has a single attention colour and no red anywhere. */
	.reason-sheet-attention {
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

	.reason-sheet-reason {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
	}

	.reason-sheet-reason-label {
		color: var(--color-admin-text);
		font-family: var(--font-ui);
		font-size: var(--size-11);
	}

	.reason-sheet-reason textarea {
		background-color: var(--color-surface-sunken);
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--rounded-control);
		padding: var(--space-card-gap);
		color: var(--color-text-prose);
		font-family: var(--font-ui);
		font-size: var(--size-12-5);
		line-height: 1.55;
		resize: vertical;
	}

	.reason-sheet-controls {
		display: flex;
		align-items: center;
		gap: var(--space-card-gap);
	}

	/* Deliberately not the filled Manager control: a filled button anywhere on
	   this sheet would put the two control classes side by side, which is the
	   one confusion the class exists to prevent. Cancel is a quiet way back. */
	.reason-sheet-cancel {
		display: inline-flex;
		align-items: center;
		min-height: var(--touch-min);
		padding: 0 var(--space-panel-padding);
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: var(--size-13);
		text-decoration: none;
	}

	.reason-sheet-footer {
		margin: 0;
		color: var(--color-admin-label);
		font-family: var(--font-ui);
		font-size: var(--size-11);
		line-height: 1.55;
	}
</style>
