import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
	CONSTANT_SECURITY_HEADERS,
	connectSrc,
	contentSecurityPolicy
} from '../src/lib/server/security-headers.ts';
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

	it('keeps connect-src same-origin in the STATIC policy, which needs no socket', () => {
		// Unchanged from Story 1.3, and now for a sharper reason than "no
		// project exists to name" (Story 9.3).
		//
		// This block reaches CDN-served static files only — Story 9.1's `curl -I`
		// established that Netlify does not apply it to Function responses. No
		// static asset opens a WebSocket, so widening THIS connect-src would
		// grant nothing to anybody. The Realtime socket is governed by the
		// policy on the DOCUMENT response, which `hooks.server.ts` sets from
		// `lib/server/security-headers.ts` — see the block below.
		//
		// Leaving it at `'self'` is therefore the tighter choice, not a
		// leftover: the static policy admits exactly what static assets need.
		expect(CSP_DIRECTIVES.get('connect-src')).toEqual(["'self'"]);
	});

	it('names no wildcard host in any directive, socket or otherwise', () => {
		// AC: "no wildcard host appears anywhere in the policy". Asserted over
		// the whole policy rather than over connect-src alone, because the
		// temptation a shipped-but-blocked socket creates is to widen SOME
		// directive, and default-src would admit it just as effectively.
		expect(CSP).not.toMatch(/\*\.[a-z]/i);
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

// --- The SSR half: what netlify.toml cannot reach ---------------------------

describe('the SSR security headers', () => {
	// Story 9.1's AC 5 ran `curl -I` against a real deploy and found that
	// netlify.toml's block reaches static assets and NOT Function responses: a
	// static asset returned all seven headers, the page a human loads returned
	// none. Every page here is a Function response, so the app was framable,
	// indexable and had no CSP. `hooks.server.ts` now applies this module's
	// output to every response it generates.
	//
	// Two sources for one set of values is a drift risk, which is what the
	// first assertion here exists to remove.

	it('agrees with netlify.toml byte-for-byte on every constant header', () => {
		for (const [name, value] of Object.entries(CONSTANT_SECURITY_HEADERS)) {
			const fromBlock = [...HEADERS].find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
			expect(fromBlock, `${name} is not declared in netlify.toml`).toBeDefined();
			expect(value, `${name} differs between the two sources`).toBe(fromBlock);
		}
	});

	it('covers every header netlify.toml declares, so SSR is not the weaker half', () => {
		for (const name of HEADERS.keys()) {
			const covered =
				name === 'Content-Security-Policy' ||
				Object.keys(CONSTANT_SECURITY_HEADERS).some(
					(key) => key.toLowerCase() === name.toLowerCase()
				);
			expect(covered, `${name} is served to static assets but not to pages`).toBe(true);
		}
	});

	it('admits the deployment’s own Supabase host to connect-src, and only it', () => {
		const policy = contentSecurityPolicy('https://ymtermqgujdemgxnbgku.supabase.co');
		const parsed = directives(policy);
		expect(parsed.get('connect-src')).toEqual([
			"'self'",
			'https://ymtermqgujdemgxnbgku.supabase.co',
			'wss://ymtermqgujdemgxnbgku.supabase.co'
		]);
	});

	it('never interpolates a wildcard, whatever it is handed', () => {
		// The specific mistake deferred-work.md names twice: `*.supabase.co`
		// would admit every other tenant on the platform. A URL whose host is
		// not a plain hostname degrades to 'self' rather than being
		// interpolated, and an unparseable or empty one does the same.
		for (const hostile of ['https://*.supabase.co', 'https://sub.*.supabase.co', 'not-a-url', '']) {
			expect(connectSrc(hostile), `connect-src widened for ${hostile}`).toBe("connect-src 'self'");
		}
	});

	it('holds the no-wildcard property across arbitrary input', () => {
		for (const url of [
			'https://*.supabase.co',
			'https://ymtermqgujdemgxnbgku.supabase.co',
			'https://example.com',
			'not-a-url',
			undefined
		]) {
			expect(contentSecurityPolicy(url), `wildcard reached the policy for ${String(url)}`).not.toMatch(
				/\*/
			);
		}
	});

	it('follows PUBLIC_SUPABASE_URL wherever it legitimately points', () => {
		// Deliberately NOT constrained to `*.supabase.co`. The directive exists
		// to admit the Realtime socket, whose host supabase-js derives from this
		// same variable — so constraining it here could only ever disagree with
		// the client. And anyone able to set PUBLIC_SUPABASE_URL already governs
		// where the app reads its data from; the CSP is not the control that
		// would save it. Pinning the vendor's domain would buy no security and
		// would break the day a custom domain is used.
		expect(connectSrc('https://db.example.org')).toBe(
			"connect-src 'self' https://db.example.org wss://db.example.org"
		);
	});

	it('degrades to same-origin when no project is configured', () => {
		// Story 4.1's honest failure: the freshness contract sits in
		// Reconnecting and the same-origin poll keeps the board refreshing,
		// rather than anything being shown as live that is not.
		expect(connectSrc(undefined)).toBe("connect-src 'self'");
	});

	it('carries every directive the static policy does', () => {
		const ssr = directives(contentSecurityPolicy('https://example.supabase.co'));
		for (const name of CSP_DIRECTIVES.keys()) {
			expect(ssr.has(name), `${name} is missing from the SSR policy`).toBe(true);
		}
	});

	it('confines the inline allowance to the two directives that need it', () => {
		const ssr = directives(contentSecurityPolicy('https://example.supabase.co'));
		for (const [directive, sources] of ssr) {
			if (directive === 'script-src' || directive === 'style-src') continue;
			expect(sources, `${directive} permits inline`).not.toContain("'unsafe-inline'");
		}
	});
});

// --- Two sources, one value -------------------------------------------------

describe('the routes that set their own headers agree with the block', () => {
	// `/auth/callback` writes its refusals as a raw Response with its own
	// headers. It used to restate two security headers so that a collision with
	// netlify.toml's block would be moot whichever precedence applied; Story 9.3
	// established there is no collision, because that block never reaches this
	// path, and that those two were consequently the ONLY security headers this
	// route had. `hooks.server.ts` now sets the full set on every response, so
	// the route restates none of them — a second writer on a value that must
	// have one is exactly what this file exists to prevent.
	const callback = readFileSync(
		join(ROOT, 'src', 'routes', 'auth', 'callback', '+server.ts'),
		'utf8'
	);

	function routeHeader(name: string): string | undefined {
		const pattern = new RegExp(`'${name}':\\s*'([^']*)'`);
		return pattern.exec(callback)?.[1];
	}

	it.each(['x-robots-tag', 'referrer-policy'])(
		'no longer restates %s, leaving the hook as its single writer',
		(name: string) => {
			expect(routeHeader(name), `${name} is still set by the callback route`).toBeUndefined();
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
