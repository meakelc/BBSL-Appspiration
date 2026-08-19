import adapter from '@sveltejs/adapter-netlify';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// edge: false — Netlify Node functions, not Deno edge functions.
		// The transactional shell needs the Node runtime; see ARCHITECTURE-SPINE Stack.
		adapter: adapter({ edge: false, split: false })
	}
};

export default config;
