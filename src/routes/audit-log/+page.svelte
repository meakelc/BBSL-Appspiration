<script lang="ts">
	// The Audit Log (Story 7.5, FR-33).
	//
	// One ruled list of every event this League has recorded, newest first,
	// each entry carrying its actor, its instant, one sentence and its detail
	// rows. Above it, three filters; beside them, a link that exports exactly
	// what is on screen.
	//
	// **Nothing on this surface mutates anything.** There is no form action,
	// no `method="post"`, no button, no edit, delete, redact or correct
	// affordance anywhere in this file. The Log is a read of an insert-only
	// table and the absence of every one of those controls IS the feature.
	//
	// **The filters are a plain `method="get"` form and the export is an
	// ordinary link.** Not `$state` and `bind:group` like the Bid Board's
	// control — deliberately, and it is the one place this page departs from
	// that precedent. The board filters a list the browser already holds; this
	// filters a log the server holds, so the filter must survive being
	// bookmarked, shared and reloaded, and the export must be able to carry
	// the same query string. Both work with JavaScript switched off.
	//
	// **No wording of its own.** Every label, sentence and option arrives from
	// `$lib/core/audit-log.ts`, so each has exactly one definition in the
	// codebase and a synonym cannot appear in markup. What this file holds is
	// structure and CSS.
	//
	// Types are declared structurally rather than imported from a server-only
	// module — the rule `nominate/+page.svelte` states and every page since
	// follows. `$lib/core` is a different matter: it is the pure core, and the
	// constants below are the same ones the server reads.
	import {
		ANY_OPTION_LABEL,
		APPLY_FILTERS_LABEL,
		AUDIT_EXPORT_LABEL,
		AUDIT_EXPORT_PATH,
		AUDIT_FILTER_KEYS,
		AUDIT_FILTER_LEGENDS,
		AUDIT_LOG_STATEMENT,
		AUDIT_LOG_TITLE,
		EMPTY_LOG_HEADING,
		EMPTY_LOG_STATEMENT,
		ID_OPTION_KINDS,
		NO_MATCHES_HEADING,
		NO_MATCHES_STATEMENT,
		auditReadStatement,
		idOption,
		isFiltered
	} from '$lib/core/audit-log.ts';
	import type { AuditFilter, AuditFilterOption, AuditRow } from '$lib/core/audit-log.ts';

	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const rows = $derived(data.rows as readonly AuditRow[]);
	const filter = $derived(data.filter as AuditFilter);
	const countSentence = $derived(data.countSentence as string);
	const readStatement = $derived(auditReadStatement(data.figuresAt as string));
	const exportHref = $derived(`${AUDIT_EXPORT_PATH}${data.exportQuery as string}`);

	/**
	 * Whether any filter is in force — the core's own predicate, so the page
	 * cannot come to disagree with the server about what "filtered" means.
	 */
	const filtered = $derived(isFiltered(filter));

	/**
	 * A filter value absent from its own option list, as an extra option.
	 *
	 * Without this a `?team=` naming a Team no entry mentions would leave the
	 * control reading "Any" while the filter was in force and the list was
	 * empty — the control lying about the view it is showing.
	 *
	 * The value is an id, and it is LABELLED as one through the core's
	 * `idOption` rather than printed bare: a raw uuid sitting where a name
	 * belongs reads as though the log knew a name for it, and choosing that
	 * wording here would also be this page wording something of its own. An
	 * event type is its own label already — it is the machine value the filter
	 * matches on and the text the Log prints for it — so it needs no kind.
	 */
	function optionsWith(
		options: readonly AuditFilterOption[],
		selected: string | null,
		kind: string | null
	): readonly AuditFilterOption[] {
		if (selected === null) return options;
		if (options.some((option) => option.value === selected)) return options;
		const label = kind === null ? selected : idOption(kind, selected);
		return [{ value: selected, label }, ...options];
	}

	const teamOptions = $derived(
		optionsWith(data.teamOptions as readonly AuditFilterOption[], filter.team, ID_OPTION_KINDS.team)
	);
	const playerOptions = $derived(
		optionsWith(
			data.playerOptions as readonly AuditFilterOption[],
			filter.player,
			ID_OPTION_KINDS.player
		)
	);
	const typeOptions = $derived(
		optionsWith(data.typeOptions as readonly AuditFilterOption[], filter.type, null)
	);

	/**
	 * The absolute stamps, computed in an `$effect` and therefore only in the
	 * browser — the SSR-leak rule `teams/+page.svelte` establishes.
	 * `Intl.DateTimeFormat(undefined, ...)` resolves `undefined` to the
	 * timezone of whatever machine formats it, so deriving this during SSR
	 * would ship the SERVER's timezone in the delivered HTML. Until it runs,
	 * and if it never runs, the ISO-8601 UTC instant the log itself holds is
	 * what shows — which is honest rather than absent.
	 */
	let localStamps = $state<Record<string, string>>({});

	$effect(() => {
		const formatter = new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		});
		const stamps: Record<string, string> = {};
		for (const entry of rows) {
			const parsed = new Date(entry.occurredAt);
			if (Number.isNaN(parsed.getTime())) continue;
			stamps[entry.seq] = formatter.format(parsed);
		}
		localStamps = stamps;
	});
</script>

<svelte:head>
	<title>{AUDIT_LOG_TITLE} — Appspiration</title>
</svelte:head>

<main class="page">
	<header class="masthead">
		<h1 class="section-label">{AUDIT_LOG_TITLE}</h1>
		<p class="prose">{AUDIT_LOG_STATEMENT}</p>
		<p class="prose" id="audit-count">{countSentence}</p>
		<p class="prose read-at">{readStatement}</p>
	</header>

	<!--
		`method="get"`, so submitting puts the filters in the URL and the page
		is reloaded with them — bookmarkable, shareable, and working with
		JavaScript switched off. There is no `action` and there is deliberately
		no POST anywhere on this surface.
	-->
	<form class="controls" method="get" id="audit-filters">
		<p class="field">
			<label class="section-label" for="audit-team">{AUDIT_FILTER_LEGENDS.team}</label>
			<select class="prose" id="audit-team" name={AUDIT_FILTER_KEYS.team}>
				<option value="" selected={filter.team === null}>{ANY_OPTION_LABEL}</option>
				{#each teamOptions as option (option.value)}
					<option value={option.value} selected={filter.team === option.value}
						>{option.label}</option
					>
				{/each}
			</select>
		</p>

		<p class="field">
			<label class="section-label" for="audit-player">{AUDIT_FILTER_LEGENDS.player}</label>
			<select class="prose" id="audit-player" name={AUDIT_FILTER_KEYS.player}>
				<option value="" selected={filter.player === null}>{ANY_OPTION_LABEL}</option>
				{#each playerOptions as option (option.value)}
					<option value={option.value} selected={filter.player === option.value}
						>{option.label}</option
					>
				{/each}
			</select>
		</p>

		<p class="field">
			<label class="section-label" for="audit-type">{AUDIT_FILTER_LEGENDS.type}</label>
			<select class="prose" id="audit-type" name={AUDIT_FILTER_KEYS.type}>
				<option value="" selected={filter.type === null}>{ANY_OPTION_LABEL}</option>
				{#each typeOptions as option (option.value)}
					<option value={option.value} selected={filter.type === option.value}
						>{option.label}</option
					>
				{/each}
			</select>
		</p>

		<!--
			The one submit on this page, and it changes nothing: it re-reads the
			Log through the query string it builds. It is a `submit` on a GET
			form, not a control that authorises anything.

			It sits in a `manager-block` because every control in this product
			sits in the block that declares which kind of control it is
			(`styles/commissioner.css`) — and a Manager block is the correct one:
			reading the Log is not a Commissioner act, and the Commissioner
			treatment on it would say it were.
		-->
		<div class="manager-block">
			<button class="control-manager" type="submit">{APPLY_FILTERS_LABEL}</button>
		</div>
	</form>

	<!--
		An ordinary link carrying the query string the server built off the same
		filter the rows were taken with. No client JS, no blob, no generated
		file in the browser — the CSV is served by `/audit-log/export`.
	-->
	<p class="prose"><a class="export" href={exportHref}>{AUDIT_EXPORT_LABEL}</a></p>

	{#if rows.length === 0}
		<!--
			Two designed empty screens and never a blank page. An empty Log and a
			filter that matched nothing are different facts and say different
			things; neither is an error.
		-->
		<section class="panel" id="audit-empty">
			<h2 class="section-label">{filtered ? NO_MATCHES_HEADING : EMPTY_LOG_HEADING}</h2>
			<p class="prose">{filtered ? NO_MATCHES_STATEMENT : EMPTY_LOG_STATEMENT}</p>
		</section>
	{:else}
		<ul class="entries" id="audit-entries">
			{#each rows as entry (entry.seq)}
				<li class="entry">
					<p class="entry-head">
						<span class="entry-type">{entry.typeLabel}</span>
						<time class="when" datetime={entry.occurredAt}
							>{localStamps[entry.seq] ?? entry.occurredAt}</time
						>
					</p>
					<p class="prose">{entry.headline}</p>
					<p class="actor">{entry.actor.label}</p>
					{#if entry.details.length > 0}
						<dl class="details">
							{#each entry.details as detail, index (index)}
								<dt class="section-label">{detail.label}</dt>
								<dd class="detail-value">{detail.value}</dd>
							{/each}
						</dl>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</main>

<style>
	.masthead {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
	}

	/*
	 * One column at every width. `EXPERIENCE.md` requires every Manager
	 * surface to be single-column at 375px with no lateral scrolling, and a
	 * log of entries has no second axis to gain from a wider one.
	 */
	.controls {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		width: 100%;
		border: 0;
		padding: 0;
		margin: 0;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		min-width: 0;
	}

	/*
	 * A native `select` at the touch floor, and no fixed width — a Team name
	 * or a Player name is long enough to force a lateral scroll at 375px if
	 * the control is given one.
	 */
	.field select {
		width: 100%;
		min-width: 0;
		min-height: var(--touch-min);
		font-family: var(--font-ui);
		font-size: var(--size-15);
		color: var(--color-text);
		background-color: var(--color-surface);
		border: var(--border-width) solid var(--color-border-interactive);
		border-radius: var(--rounded-control);
		padding: 0 var(--space-row-gap);
	}

	.export {
		color: var(--color-text);
	}

	.entries {
		display: flex;
		flex-direction: column;
		list-style: none;
		width: 100%;
	}

	/*
	 * Entries separated by a 1px rule rather than by card gaps
	 * (`teams/+page.svelte`'s own reasoning): a log is long, and a ruled list
	 * reads as a record on a phone where a stack of cards does not.
	 */
	.entry {
		display: flex;
		flex-direction: column;
		gap: var(--space-row-gap);
		padding: var(--space-row-gap) 0;
		border-bottom: var(--border-width) solid var(--color-border);
		min-width: 0;
	}

	/* Wrapping, so the stamp drops below the type word at 375px rather than
	   squeezing it or scrolling the page sideways. */
	.entry-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-row-gap);
	}

	.entry-type {
		font-family: var(--font-ui);
		font-size: var(--size-10);
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--color-text-secondary);
	}

	.when {
		margin-left: auto;
		font-family: var(--font-ui);
		font-size: var(--size-12-5);
		font-variant-numeric: var(--numerals);
		color: var(--color-text-tertiary);
	}

	.actor {
		font-family: var(--font-ui);
		font-size: var(--size-12-5);
		color: var(--color-text-secondary);
	}

	/*
	 * The detail rows as a definition list, one label above its value in one
	 * column. A two-column grid was drafted and rejected: a Roster Move's
	 * `Lakers — Meakel — Cap Space` label and a long transfer sentence cannot
	 * share a 375px row without one of them scrolling.
	 */
	.details {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0;
		min-width: 0;
	}

	.detail-value {
		margin: 0;
		font-family: var(--font-ui);
		font-size: var(--size-12-5);
		font-variant-numeric: var(--numerals);
		color: var(--color-text);
		/* A serialised payload on an unworded entry can be one very long
		   token. It wraps rather than taking the page sideways with it. */
		overflow-wrap: anywhere;
	}
</style>
