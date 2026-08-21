import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NETLIFY_TOML = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');

/**
 * The security headers, asserted against the file that serves them.
 *
 * The site is live and public. Until Story 1.3 it served no CSP, no
 * X-Frame-Options, no Referrer-Policy and no X-Robots-Tag at all — a private
 * thirty-manager league's app, indexable. A header block that quietly stops
 * being served fails nothing otherwise, which is the entire reason this file
 * exists.
 *
 * This proves the committed configuration. It cannot prove a real response —
 * that is the `curl -I` manual check in the story's verification section, and
 * it stays manual because it needs a deploy.
 */

// --- Read the [[headers]] block ---------------------------------------------

/**
 * `readSimpleToml` in check-pins.js does not model TOML's array-of-tables
 * syntax (`[[headers]]`), and teaching it to would be scope it does not need.
 * A direct read of the one block is clearer and asserts the same thing.
 */
function headerValues(source: string): Map<string, string> {
	const values = new Map<string, string>();
	const block = /\[headers\.values\]([\s\S]*?)(?=\n\[|\s*$)/.exec(source);
	if (block === null) return values;
	for (const rawLine of (block[1] ?? '').split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === '' || line.startsWith('#')) continue;
		const pair = /^([A-Za-z0-9_.-]+)\s*=\s*"(.*)"$/.exec(line);
		if (pair === null) continue;
		values.set(pair[1] ?? '', pair[2] ?? '');
	}
	return values;
}

const HEADERS = headerValues(NETLIFY_TOML);
const CSP = HEADERS.get('Content-Security-Policy') ?? '';

/** The CSP as directive -> source list. */
function directives(policy: string): Map<string, string[]> {
	const parsed = new Map<string, string[]>();
	for (const part of policy.split(';')) {
		const tokens = part.trim().split(/\s+/).filter((token) => token !== '');
		const name = tokens.shift();
		if (name === undefined) continue;
		parsed.set(name, tokens);
	}
	return parsed;
}

const CSP_DIRECTIVES = directives(CSP);

// --- The block itself -------------------------------------------------------

describe('netlify.toml serves security headers', () => {
	it('declares a headers block covering every path', () => {
		expect(NETLIFY_TOML).toMatch(/^\[\[headers\]\]$/m);
		expect(NETLIFY_TOML).toMatch(/for\s*=\s*"\/\*"/);
		expect(NETLIFY_TOML).toMatch(/^\s*\[headers\.values\]$/m);
	});

	it('parses at least one header out of it', () => {
		expect(HEADERS.size).toBeGreaterThan(0);
	});
});

// --- The four the story names -----------------------------------------------

describe('the headers the live deploy was missing', () => {
	it('keeps a private league out of every search index', () => {
		const robots = HEADERS.get('X-Robots-Tag') ?? '';
		expect(robots).toContain('noindex');
		expect(robots).toContain('nofollow');
	});

	it('does not leak full URLs as referrers', () => {
		const referrer = HEADERS.get('Referrer-Policy') ?? '';
		expect(referrer).not.toBe('');
		// Anything that sends the path cross-origin is a leak; anything that
		// sends nothing at all breaks same-origin navigation analytics we do not
		// have. These are the two policies that are correct here.
		expect(['strict-origin-when-cross-origin', 'same-origin', 'no-referrer']).toContain(referrer);
	});

	it('refuses to be framed, in both the modern and the legacy control', () => {
		expect(HEADERS.get('X-Frame-Options')).toBe('DENY');
		expect(CSP_DIRECTIVES.get('frame-ancestors')).toEqual(["'none'"]);
	});

	it('serves a Content-Security-Policy at all', () => {
		expect(CSP).not.toBe('');
	});
});

// --- The CSP ----------------------------------------------------------------

describe('the Content-Security-Policy', () => {
	it('defaults to same-origin and forbids a base-tag or plugin rewrite', () => {
		expect(CSP_DIRECTIVES.get('default-src')).toEqual(["'self'"]);
		expect(CSP_DIRECTIVES.get('base-uri')).toEqual(["'self'"]);
		expect(CSP_DIRECTIVES.get('object-src')).toEqual(["'none'"]);
	});

	it('admits the Discord OAuth redirect, by name', () => {
		const formAction = CSP_DIRECTIVES.get('form-action') ?? [];
		expect(formAction).toContain("'self'");
		expect(formAction).toContain('https://discord.com');
	});

	it('names no wildcard host anywhere', () => {
		// `https://*.netlify.app` or `https://*.supabase.co` would admit every
		// other tenant on those platforms. Every host in this policy is a literal.
		expect(CSP).not.toContain('*');
		for (const [directive, sources] of CSP_DIRECTIVES) {
			for (const source of sources) {
				expect(source, `${directive} carries a wildcard source`).not.toContain('*');
				// A bare scheme is a wildcard by another name: `https:` admits every
				// host on the internet. `data:` is permitted for inline images only.
				if (source.endsWith(':')) {
					expect(source, `${directive} admits a whole scheme`).toBe('data:');
				}
			}
		}
	});

	it('admits no third-party host it does not need', () => {
		const permitted = new Set(['https://discord.com']);
		for (const [directive, sources] of CSP_DIRECTIVES) {
			for (const source of sources) {
				if (!/^[a-z]+:\/\//.test(source)) continue;
				expect(permitted.has(source), `${directive} admits ${source}`).toBe(true);
			}
		}
	});

	it('never permits eval, in any directive', () => {
		expect(CSP).not.toContain("'unsafe-eval'");
	});

	it('confines the inline allowance to script-src and style-src', () => {
		// SvelteKit emits an inline bootstrap <script> in every SSR'd document and
		// Svelte emits inline style attributes; the nonce-based alternative would
		// be a SECOND policy alongside this one, enforced as the intersection,
		// which blocks the very script it exists to allow. The allowance is real
		// and is confined to the two directives that need it.
		for (const [directive, sources] of CSP_DIRECTIVES) {
			if (directive === 'script-src' || directive === 'style-src') continue;
			expect(sources, `${directive} permits inline`).not.toContain("'unsafe-inline'");
		}
	});

	it('keeps connect-src same-origin until a Supabase project exists to name', () => {
		// The Realtime socket is admitted by adding that project's literal host,
		// never `*.supabase.co`. Both projects are still unprovisioned (see
		// deferred-work.md), and this story ships no Realtime client, so
		// admitting one now would widen the policy ahead of the need.
		expect(CSP_DIRECTIVES.get('connect-src')).toEqual(["'self'"]);
	});
});

// --- The rest ---------------------------------------------------------------

describe('the supporting headers', () => {
	it('forbids MIME sniffing', () => {
		expect(HEADERS.get('X-Content-Type-Options')).toBe('nosniff');
	});

	it('gives no cross-origin window a handle on this document', () => {
		expect(HEADERS.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
	});

	it('turns off every browser feature this app does not use', () => {
		const permissions = HEADERS.get('Permissions-Policy') ?? '';
		for (const feature of ['camera', 'microphone', 'geolocation', 'payment']) {
			expect(permissions, `${feature} is not disabled`).toContain(`${feature}=()`);
		}
	});
});

// --- Two sources, one value -------------------------------------------------

describe('the routes that set their own headers agree with the block', () => {
	// `/auth/callback` writes its refusals as a raw Response with its own
	// headers, and `for = "/*"` matches that path too. Netlify does not document
	// which wins on a collision, so two different values for one header name
	// would make the served response depend on undocumented behaviour — and
	// nothing in the repository would say which value a browser actually got.
	// Identical values make the question moot.
	const callback = readFileSync(
		join(ROOT, 'src', 'routes', 'auth', 'callback', '+server.ts'),
		'utf8'
	);

	function routeHeader(name: string): string | undefined {
		const pattern = new RegExp(`'${name}':\\s*'([^']*)'`);
		return pattern.exec(callback)?.[1];
	}

	it.each(['x-robots-tag', 'referrer-policy'])(
		'sets the same %s the header block does',
		(name: string) => {
			const fromRoute = routeHeader(name);
			expect(fromRoute, `${name} is not set by the callback route`).toBeDefined();

			// Header names are case-insensitive; the two files spell them
			// differently by local convention.
			const fromBlock = [...HEADERS].find(
				([key]) => key.toLowerCase() === name
			)?.[1];
			expect(fromBlock, `${name} is not served by the header block`).toBeDefined();
			expect(fromRoute).toBe(fromBlock);
		}
	);

	it('marks its refusals uncacheable, which the block deliberately does not do globally', () => {
		// This one is route-only on purpose: a no-store default would defeat the
		// immutable asset caching the built client depends on.
		expect(routeHeader('cache-control')).toBe('no-store');
		expect(HEADERS.has('Cache-Control')).toBe(false);
	});
});

// --- The block cannot quietly stop applying ---------------------------------

describe('the header block is not shadowed', () => {
	it('declares exactly one headers block, so none can override another', () => {
		expect((NETLIFY_TOML.match(/^\[\[headers\]\]$/gm) ?? []).length).toBe(1);
	});

	it('sits after [functions] and before nothing that would re-scope it', () => {
		// A `[headers.values]` table placed inside another table's scope would be
		// read as that table's key, and the headers would silently stop being
		// served with no error anywhere.
		const blockAt = NETLIFY_TOML.indexOf('[[headers]]');
		const valuesAt = NETLIFY_TOML.indexOf('[headers.values]');
		expect(blockAt).toBeGreaterThan(-1);
		expect(valuesAt).toBeGreaterThan(blockAt);
		const between = NETLIFY_TOML.slice(blockAt, valuesAt);
		expect(between).not.toMatch(/^\[(?!\[headers\]\])/m);
	});
});
