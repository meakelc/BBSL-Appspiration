import adapter from '@sveltejs/adapter-netlify';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// edge: false — Netlify Node functions, not Deno edge functions.
		// The transactional shell needs the Node runtime; see ARCHITECTURE-SPINE Stack.
		// split: false — one Netlify function for the whole app rather than
		// one per route. Conservative default for a 31-route app on the free
		// tier; not itself a pinned value, so it can be revisited per-route
		// if a later story needs isolated cold starts.
		adapter: adapter({ edge: false, split: false })
	}
};

export default config;
