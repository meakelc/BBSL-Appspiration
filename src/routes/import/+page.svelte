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
				readonly teamId: string;
				readonly teamName: string;
				readonly fileName: string;
				readonly rowCount: number;
		  }
		| { readonly kind: 'refused_file'; readonly fileName: string; readonly detail: string }
		| {
				readonly kind: 'refused_content';
				readonly teamId: string;
				readonly teamName: string;
				readonly fileName: string;
				readonly detail: string;
		  }
		| {
				// One file's `stageRosterFile` call threw — the route caught it and
				// converted it into this file's own result rather than aborting the
				// rest of the batch (review-loop-iteration 1).
				readonly kind: 'error';
				readonly fileName: string;
				readonly detail: string;
		  };
	type UploadForm = { readonly notice?: string; readonly results?: readonly UploadResult[] };

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
	// `form`'s generated type is a union of every action's return shape, so
	// neither field is on every member — read it through one cast, here,
	// rather than at each template access site.
	const uploadForm = $derived(form as UploadForm | undefined);
	const notice = $derived(uploadForm?.notice);
	const results = $derived(uploadForm?.results ?? []);
</script>

<svelte:head>
	<title>Import — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1>Import</h1>
		<p class="section-label">BBSL offseason free agent auction</p>
	</header>

	<section class="panel">
		<p class="section-label">Phase</p>
		<p class="prose">{data.phase.sentence}</p>
	</section>

	<section class="commissioner-block">
		<p class="commissioner-label">Roster import</p>
		<p class="prose">
			Drop up to thirty Team roster files as one batch. Each file resolves to one Team by its
			file name and stages independently — a Team already staged may be re-supplied, which
			replaces only that Team's rows.
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
					{#if result.kind === 'staged'}
						<p class="prose result result-staged">
							Staged — {result.teamName} ("{result.fileName}"): {result.rowCount} rows.
						</p>
					{:else if result.kind === 'refused_file'}
						<p class="prose result result-refused-file">
							File refusal — "{result.fileName}": {result.detail}
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
			<p class="prose">Every Team has staged.</p>
		{/if}

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

	.status-team {
		color: var(--color-text);
		font-family: var(--font-ui);
		font-size: var(--size-15);
	}

	.status-label {
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: var(--size-12-5);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
</style>
