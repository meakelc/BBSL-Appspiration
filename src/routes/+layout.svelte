<script lang="ts">
	import '$lib/styles/global.css';
	import type { Snippet } from 'svelte';

	import HeaderMenu from '$lib/components/HeaderMenu.svelte';

	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<HeaderMenu destinations={data.destinations} phaseSentence={data.phase.sentence} />

{@render children()}
