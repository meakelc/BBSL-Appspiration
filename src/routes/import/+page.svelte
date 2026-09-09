<script lang="ts">
	// The Commissioner-only roster import surface (Story 1.7).
	//
	// Two refusal altitudes must read as visibly distinct without colour
	// (accessibility floor: a greyscale screenshot stays fully readable): a
	// file refusal and a content refusal carry different words ("File
	// refusal" / "Content refusal") and different structure, never only a
	// colour. Outstanding Teams are named, never counted
	// (epic-1-context.md) — the status list below lists names, and the
	// summary line above it does the same rather than printing a number as
	// the primary signal.
	//
	// Declared structurally rather than imported from a server-only module —
	// nothing under the server library may ever be reachable from a `.svelte` file.
	import type { ActionData, PageData } from './$types';

	type ImportStatus = 'staged' | 'refused_file' | 'refused_content' | 'outstanding';

	type PoolImportStatus = {
		readonly status: ImportStatus;
		readonly fileName: string | null;
		readonly refusalDetail: string | null;
		readonly updatedAt: string | null;
		readonly playerCount: number;
	};

	/**
	 * One Team's preview row — Roster Count and Cap Space from staging alone,
	 * with the Cap Space already rendered server-side so the money rule keeps
	 * one definition (`core/rules/import-preview.ts`).
	 */
	type TeamPreviewRow = {
		readonly teamId: string;
		readonly teamName: string;
		readonly rosterCount: number;
		readonly capSpace: number;
		readonly capSpaceText: string;
		readonly offGridDetail: string | null;
		readonly breachDetail: string | null;
		readonly capHitTotal: number;
		readonly breaches: ReadonlyArray<{
			readonly slotKind: string;
			readonly count: number;
			readonly ceiling: number;
		}>;
	};

	type ImportPreview = {
		readonly teams: readonly TeamPreviewRow[];
		readonly poolSize: number;
	};

	type TeamImportStatus = {
		readonly teamId: string;
		readonly teamName: string;
		readonly status: ImportStatus;
		readonly fileName: string | null;
		readonly refusalDetail: string | null;
		readonly updatedAt: string | null;
	};

	/** `actions.upload`'s two possible return shapes — a `fail()` or a batch of results. */
	type UploadResult =
		| {
				readonly kind: 'staged';
				readonly source: 'team';
				readonly teamId: string;
				readonly teamName: string;
				readonly fileName: string;
				readonly rowCount: number;
		  }
		| {
				// The Free Agent pool staged. `rowCount` is the pool size, stated
				// back for explicit confirmation (Story 1.8).
				readonly kind: 'staged';
				readonly source: 'pool';
				readonly fileName: string;
				readonly rowCount: number;
		  }
		| {
				readonly kind: 'refused_file';
				readonly source: 'unknown';
				readonly fileName: string;
				readonly detail: string;
		  }
		| {
				readonly kind: 'refused_content';
				readonly source: 'team';
				readonly teamId: string;
				readonly teamName: string;
				readonly fileName: string;
				readonly detail: string;
		  }
		| {
				readonly kind: 'refused_content';
				readonly source: 'pool';
				readonly fileName: string;
				readonly detail: string;
		  }
		| {
				// One file's staging call threw — the route caught it and converted
				// it into this file's own result rather than aborting the rest of
				// the batch (1.7's review-loop-iteration 1).
				readonly kind: 'error';
				readonly source: 'unknown';
				readonly fileName: string;
				readonly detail: string;
		  };
	type UploadForm = {
		readonly notice?: string;
		readonly results?: readonly UploadResult[];
		/** `promote`'s success shape — the one appended `ImportPromoted` event. */
		readonly promoted?: { readonly seq: string | null; readonly occurredAt: string | null };
		/** `promote`'s own sentence, separate from `upload`'s so neither renders under the other's control. */
		readonly promoteNotice?: string;
	};

	let { data, form }: { data: PageData; form: ActionData } = $props();

	function statusLabel(status: ImportStatus): string {
		switch (status) {
			case 'staged':
				return 'Staged';
			case 'outstanding':
				return 'Outstanding';
			case 'refused_file':
				return 'Refused — file';
			case 'refused_content':
				return 'Refused — content';
		}
	}

	const statuses = $derived((data.statuses as readonly TeamImportStatus[]) ?? []);
	const outstanding = $derived((data.outstanding as readonly string[]) ?? []);
	const everySourceStaged = $derived(outstanding.length === 0);
	const pool = $derived(data.pool as PoolImportStatus);
	// `form`'s generated type is a union of every action's return shape, so
	// neither field is on every member — read it through one cast, here,
	// rather than at each template access site.
	const uploadForm = $derived(form as UploadForm | undefined);
	const notice = $derived(uploadForm?.notice);
	const results = $derived(uploadForm?.results ?? []);
	const promoted = $derived(uploadForm?.promoted);
	const promoteNotice = $derived(uploadForm?.promoteNotice);
	const preview = $derived(data.preview as ImportPreview);

	/**
	 * The preview arrives with its Cap Space ALREADY RENDERED
	 * (`server/import-preview.ts`'s `TeamPreviewRow.capSpaceText`), and with
	 * the off-grid sentence already worded. Nothing here re-implements the
	 * money rule: `renderCapSpace` has exactly one definition, in the pure
	 * core, and a second copy on this page would be free to drift from it.
	 */
	const previewTeams = $derived(preview?.teams ?? []);
	const offGridSentences = $derived(
		previewTeams
			.map((team) => team.offGridDetail)
			.filter((detail): detail is string => detail !== null)
	);
</script>

<svelte:head>
	<title>Import — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1>Import</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	<section class="commissioner-block">
		<p class="commissioner-label">Roster import</p>
		<p class="prose">
			Drop all thirty-one files as one batch: one roster file per Team, plus the Free Agent
			pool file. Each file resolves to one source by its file name and stages independently —
			a source already staged may be re-supplied, which replaces only that source's rows.
		</p>

		<form method="POST" action="?/upload" enctype="multipart/form-data">
			<label class="section-label" for="roster-files">Roster files</label>
			<input id="roster-files" name="files" type="file" accept=".csv" multiple required />
			<button class="control-commissioner" type="submit">Stage roster files</button>
		</form>

		{#if notice}
			<p class="prose" id="upload-notice">{notice}</p>
		{/if}

		{#if results.length > 0}
			<div class="upload-results">
				<p class="section-label">This batch</p>
				{#each results as result, index (result.fileName + '-' + index)}
					{#if result.kind === 'staged' && result.source === 'pool'}
						<p class="prose result result-staged">
							Staged — Free Agent pool ("{result.fileName}"): {result.rowCount} players.
						</p>
					{:else if result.kind === 'staged'}
						<p class="prose result result-staged">
							Staged — {result.teamName} ("{result.fileName}"): {result.rowCount} rows.
						</p>
					{:else if result.kind === 'refused_file'}
						<p class="prose result result-refused-file">
							File refusal — "{result.fileName}": {result.detail}
						</p>
					{:else if result.kind === 'refused_content' && result.source === 'pool'}
						<p class="prose result result-refused-content">
							Content refusal — Free Agent pool ("{result.fileName}"): {result.detail}
						</p>
					{:else if result.kind === 'refused_content'}
						<p class="prose result result-refused-content">
							Content refusal — {result.teamName} ("{result.fileName}"): {result.detail}
						</p>
					{:else}
						<p class="prose result result-error">
							Error — "{result.fileName}": {result.detail}
						</p>
					{/if}
				{/each}
			</div>
		{/if}
	</section>

	<section class="panel">
		<p class="section-label">Status</p>
		{#if outstanding.length > 0}
			<p class="prose">Outstanding: {outstanding.join(', ')}.</p>
		{:else}
			<p class="prose">Every source has staged.</p>
		{/if}

		<!-- The Free Agent pool is the thirty-first source, and reads as its own
		     kind of row rather than a thirty-first Team: it carries a source
		     label ("Source: Free Agent pool" vs a bare Team name), states a
		     player count no Team row states, and sits above the Team list behind
		     its own rule. Every one of those is a non-colour difference, so a
		     greyscale screenshot still tells the two apart. -->
		<ul class="status-list">
			<li class="status-row status-pool status-{pool.status}">
				<span class="status-source-label">Source: Free Agent pool</span>
				<span class="status-label">{statusLabel(pool.status)}</span>
				{#if pool.status === 'staged'}
					<span class="prose status-detail">{pool.playerCount} players.</span>
				{/if}
				{#if pool.fileName}
					<span class="prose status-file">"{pool.fileName}"</span>
				{/if}
				{#if pool.refusalDetail}
					<span class="prose status-detail">{pool.refusalDetail}</span>
				{/if}
			</li>
		</ul>

		<ul class="status-list">
			{#each statuses as team (team.teamId)}
				<li class="status-row status-{team.status}">
					<span class="status-team">{team.teamName}</span>
					<span class="status-label">{statusLabel(team.status)}</span>
					{#if team.fileName}
						<span class="prose status-file">"{team.fileName}"</span>
					{/if}
					{#if team.refusalDetail}
						<span class="prose status-detail">{team.refusalDetail}</span>
					{/if}
				</li>
			{/each}
		</ul>
	</section>

	<!-- The per-Team preview: Roster Count and Cap Space for all thirty Teams,
	     read from staging alone. A stacked list at 375px — every field carries
	     its own word, so nothing depends on a column header being visible —
	     becoming a real <table> with scope="col" headers at the first
	     min-width media query in this codebase. Both render the same data from
	     the same markup source; only one is in the accessibility tree at a
	     time, so a screen reader never hears the figures twice. -->
	<section class="panel">
		<p class="section-label">Preview</p>
		<p class="prose">
			Roster Count and Cap Space for all thirty Teams, computed from the staged rows. The Free
			Agent pool holds {preview?.poolSize ?? 0} players. Nothing here reads a live table: this is
			what promotion would commit.
		</p>

		<ul class="preview-list">
			{#each previewTeams as team (team.teamId)}
				<li class="status-row">
					<span class="status-team">{team.teamName}</span>
					<span class="prose">Roster Count: {team.rosterCount}</span>
					<span class="money">Cap Space: {team.capSpaceText}</span>
					{#if team.breachDetail}
						<span class="prose preview-breach">Slot ceiling breached — {team.breachDetail}</span>
					{/if}
				</li>
			{/each}
		</ul>

		<table class="preview-table">
			<caption class="section-label">Per-Team preview</caption>
			<thead>
				<tr>
					<th scope="col">Team</th>
					<th scope="col">Roster Count</th>
					<th scope="col">Cap Space</th>
					<th scope="col">Slot ceilings</th>
				</tr>
			</thead>
			<tbody>
				{#each previewTeams as team (team.teamId)}
					<tr>
						<th scope="row">{team.teamName}</th>
						<td class="money">{team.rosterCount}</td>
						<td class="money">{team.capSpaceText}</td>
						<td>
							{#if team.breachDetail}
								{team.breachDetail}
							{:else}
								Within every ceiling.
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>

		<!-- An off-grid Cap Space is stated exactly, named by Team, and does
		     NOT block the commit. It is information about the export, not a
		     rule violation. -->
		{#each offGridSentences as sentence, index (index)}
			<p class="prose">{sentence}</p>
		{/each}
	</section>

	<section class="commissioner-block">
		<p class="commissioner-label">Promote to the live tables</p>
		<p class="prose">
			Promotion commits all thirty-one sources in one transaction or none. Re-importing during
			Setup replaces the live rosters and Free Agent pool entirely. Once the auction has opened,
			promotion is refused.
		</p>

		<!-- A disabled control always states its reason (accessibility floor).
		     The reason is ALWAYS in the DOM and always carries this id, so the
		     `aria-describedby` below is static and can never dangle: when a
		     source is outstanding it names them, and when none is it says the
		     promotion is available. Both controls take `disabled` from the same
		     `everySourceStaged`, so the affordance matches the sentence
		     (review-loop-iteration 1: the sentence rendered while the control
		     stayed live). The server refuses regardless — disabling a control is
		     never the check. -->
		<p class="prose" id="promote-availability">
			{#if everySourceStaged}
				Every one of the thirty-one sources is staged. Promotion is available.
			{:else}
				Promotion is unavailable while a source is outstanding: {outstanding.join(', ')}.
			{/if}
		</p>

		<form method="POST" action="?/promote">
			<label class="confirm-line" for="promote-confirm">
				<input
					id="promote-confirm"
					name="confirm"
					type="checkbox"
					value="yes"
					required
					disabled={!everySourceStaged}
					aria-describedby="promote-availability"
				/>
				<span class="prose">
					Confirm: replace the live rosters and Free Agent pool with the staged data.
				</span>
			</label>
			<button
				class="control-commissioner control-promote"
				type="submit"
				disabled={!everySourceStaged}
				aria-describedby="promote-availability"
			>
				Promote all thirty-one sources
			</button>
		</form>

		{#if promoteNotice}
			<p class="prose" id="promote-notice">{promoteNotice}</p>
		{/if}
		{#if promoted}
			<p class="prose">
				One ImportPromoted event was appended{promoted.seq ? ` at sequence ${promoted.seq}` : ''}.
			</p>
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

	input[type='file'] {
		width: 100%;
		min-height: var(--control-height);
		padding: var(--space-row-gap) var(--space-panel-padding);
		background-color: var(--color-surface-sunken);
		border: var(--border-width) solid var(--color-border-interactive);
		border-radius: var(--rounded-control);
		color: var(--color-text);
		font-family: var(--font-ui);
		font-size: var(--size-13);
	}

	.upload-results {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		width: 100%;
	}

	/* The two refusal altitudes read as visibly distinct through wording and
	   structure — "File refusal" vs "Content refusal" is stated in words, and
	   the accent bar's dash pattern differs too, so the distinction survives
	   desaturation rather than depending on colour. */
	.result {
		padding: var(--space-row-gap) var(--space-panel-padding);
		border-left: var(--accent-bar-width) solid var(--color-border-interactive);
	}

	.result-staged {
		border-left-style: solid;
	}

	.result-refused-file {
		border-left-style: dashed;
	}

	.result-refused-content {
		border-left-style: dotted;
	}

	.result-error {
		border-left-style: double;
	}

	.status-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
	}

	.status-row {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: var(--space-row-gap) 0;
		border-top: var(--border-width) solid var(--color-border);
	}

	.status-row:first-child {
		border-top: none;
	}

	/* The pool row's non-colour distinctions from a Team row: an underline
	   rule beneath it, and a source label rendered as small caps rather than
	   a plain name. */
	.status-pool {
		padding-bottom: var(--space-row-gap);
		border-bottom: var(--border-width) solid var(--color-border);
	}

	.status-source-label {
		color: var(--color-text);
		font-family: var(--font-ui);
		font-size: var(--size-13);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.status-team {
		color: var(--color-text);
		font-family: var(--font-ui);
		font-size: var(--size-15);
	}

	.preview-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
	}

	.preview-breach {
		border-left: var(--accent-bar-width) dotted var(--color-border-interactive);
		padding-left: var(--space-row-gap);
	}

	/*
	 * 375px is the design width and the smallest supported; 640px is where
	 * the table takes over, and it is the first min-width breakpoint in this
	 * codebase. Below it the preview is the stacked list above and the table
	 * is not rendered at all. `display: none` on the inactive one removes it
	 * from the accessibility tree too, so the figures are announced once, not
	 * twice.
	 *
	 * Nothing scrolls laterally, and no scroll container is needed to make
	 * that true: below the breakpoint the table simply does not exist, and
	 * above it there is width for four columns. If a column is ever added,
	 * this is the comment that stops being true first.
	 */
	.preview-table {
		display: none;
	}

	@media (min-width: 640px) {
		.preview-list {
			display: none;
		}

		.preview-table {
			display: table;
			width: 100%;
			border-collapse: collapse;
		}

		.preview-table caption {
			text-align: left;
			padding-bottom: var(--space-row-gap);
		}

		.preview-table th,
		.preview-table td {
			text-align: left;
			padding: var(--space-row-gap) var(--space-row-gap) var(--space-row-gap) 0;
			border-top: var(--border-width) solid var(--color-border);
			font-size: var(--size-12-5);
			color: var(--color-text-prose);
		}

		.preview-table thead th {
			color: var(--color-text-tertiary);
			font-size: var(--size-10);
			text-transform: uppercase;
			letter-spacing: 0.16em;
		}

		.preview-table tbody th {
			color: var(--color-text);
			font-size: var(--size-13);
			font-weight: 400;
		}
	}

	/*
	 * The promote control differs from the upload control without colour: it
	 * sits behind an explicit confirmation checkbox (a second, stated step no
	 * other control on this page has), it is wider-spaced with a doubled
	 * border, and its label names the whole set it commits. `.control-commissioner`
	 * already supplies the four non-colour Commissioner properties.
	 */
	.confirm-line {
		display: flex;
		align-items: flex-start;
		gap: var(--space-row-gap);
		min-height: var(--touch-min);
	}

	.confirm-line input[type='checkbox'] {
		width: 22px;
		height: 22px;
		margin-top: 2px;
		accent-color: var(--color-border-interactive);
	}

	.control-promote {
		border-style: double;
		border-width: var(--accent-bar-width);
		letter-spacing: 0.04em;
	}

	.status-label {
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: var(--size-12-5);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
</style>
