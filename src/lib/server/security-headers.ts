/**
 * The security headers, in one place, for the responses `netlify.toml` cannot
 * reach (Story 9.3).
 *
 * **Why this module exists.** `netlify.toml`'s `[[headers]]` block declares
 * seven headers `for = "/*"` and has since Story 1.3. Story 9.1's AC 5 finally
 * ran `curl -I` against a real deploy and found that Netlify applies those
 * rules to **CDN-served static files only, never to Function responses** — and
 * with `adapter-netlify`, every page in this app is a Function response. A
 * static asset returned all seven; the page a human loads returned none. The
 * private league's app was framable, indexable and without a
 * Content-Security-Policy, which is the state `deferred-work.md` escalated on
 * 2026-08-20 and recorded as closed by Story 1.3. Story 1.3 closed the
 * DECLARATION half only, and `tests/headers.test.ts` still passed throughout
 * because it parses the file rather than a response.
 *
 * `netlify.toml` keeps covering static assets. This module covers everything
 * SSR emits, applied in `src/hooks.server.ts`. Two sources for one set of
 * values is a drift risk, so `tests/headers.test.ts` asserts the two agree —
 * changing one without the other fails the suite.
 *
 * **This module reads no environment and performs no I/O**, so the test suite
 * can import it. `hooks.server.ts` cannot be imported by a test (it reads
 * `$env/dynamic/private` at module load), which is exactly why the values and
 * the policy construction live here and only the wiring lives there.
 */

/**
 * The six headers whose value never varies by environment.
 *
 * These are byte-for-byte what `netlify.toml` declares. That is not
 * duplication for its own sake: a Function response and a static asset from
 * the same origin disagreeing about whether the app may be framed would be a
 * policy nobody could reason about.
 */
export const CONSTANT_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
	// The league is private (PRD §6: no public or spectator access). Nothing in
	// this app should ever appear in a search result, including the
	// unadvertised Commissioner recovery path.
	'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',

	// Full URLs carry auction state and the recovery path. Same-origin gets the
	// path, cross-origin gets the origin and nothing more.
	'Referrer-Policy': 'strict-origin-when-cross-origin',

	// Clickjacking, twice: the modern control is frame-ancestors in the CSP,
	// this is the legacy header for anything predating it. They must agree.
	'X-Frame-Options': 'DENY',

	'X-Content-Type-Options': 'nosniff',
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Permissions-Policy':
		'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'
});

/**
 * Every CSP directive except `connect-src`, which alone varies by environment.
 *
 * `script-src` and `style-src` carry `'unsafe-inline'` because SvelteKit emits
 * an inline bootstrap `<script>` in every SSR'd document and Svelte emits
 * scoped inline style attributes. The stronger form is a per-response nonce
 * via `kit.csp` — deliberately not used, because it would emit a SECOND policy
 * alongside this one, enforced as the intersection, which blocks the very
 * script it exists to allow. One policy per response is the coherent choice
 * and the inline allowance is its stated price. Note CSP3 browsers ignore
 * `'unsafe-inline'` the moment a nonce or hash is present, so this cannot
 * silently weaken a future nonce-based policy.
 */
const BASE_DIRECTIVES: readonly string[] = Object.freeze([
	"default-src 'self'",
	"base-uri 'self'",
	"object-src 'none'",
	"frame-ancestors 'none'",
	"frame-src 'none'",
	// 'self' plus discord.com: sign-in POSTs to this origin and the OAuth
	// handshake then navigates to Discord.
	"form-action 'self' https://discord.com",
	"img-src 'self' data:",
	"font-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"script-src 'self' 'unsafe-inline'",
	"manifest-src 'self'",
	"worker-src 'self'",
	'upgrade-insecure-requests'
]);

/**
 * Build `connect-src` for one deployment's Supabase project.
 *
 * Story 4.1 ships a Realtime client whose `auction_watermark` socket this
 * directive governs. It is derived from `PUBLIC_SUPABASE_URL` at runtime
 * rather than written into `netlify.toml` as a literal, and that is a
 * deliberate improvement on the plan `deferred-work.md` recorded: a static
 * literal would have to name BOTH the dev and prod projects, since one TOML
 * file serves every context — so production would admit dev's host and dev
 * would admit production's, forever. Deriving it means each deployment admits
 * exactly its own project and nothing else, and Story 9.8 adds prod without
 * touching this policy at all.
 *
 * A wildcard is refused rather than emitted. `https://*.supabase.co` would
 * admit every other tenant on the platform, which is the specific mistake
 * `deferred-work.md` names twice; a URL that would produce one degrades to
 * `'self'` instead, which costs the socket and never the correctness.
 *
 * An absent or unparseable URL also degrades to `'self'`. That is the honest
 * failure Story 4.1 designed for: the freshness contract sits in Reconnecting,
 * the same-origin liveness poll keeps the board refreshing, and nothing is
 * shown as live that is not.
 */
export function connectSrc(supabaseUrl: string | undefined): string {
	if (supabaseUrl === undefined || supabaseUrl.trim() === '') return "connect-src 'self'";

	let host: string;
	try {
		host = new URL(supabaseUrl).host;
	} catch {
		return "connect-src 'self'";
	}

	// A host containing anything but the characters a hostname is made of —
	// most importantly `*` — is refused outright rather than interpolated.
	if (host === '' || !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) return "connect-src 'self'";

	return `connect-src 'self' https://${host} wss://${host}`;
}

/** The full Content-Security-Policy for one deployment. */
export function contentSecurityPolicy(supabaseUrl: string | undefined): string {
	// connect-src is placed among the others rather than appended, so the
	// policy reads in the same order `netlify.toml`'s does.
	const directives = [...BASE_DIRECTIVES];
	directives.splice(6, 0, connectSrc(supabaseUrl));
	return directives.join('; ');
}

/**
 * Every security header an SSR response carries.
 *
 * Applied by `hooks.server.ts` to the response of every request this app
 * serves — pages, form actions, the OAuth callback and the liveness endpoint
 * alike. There is no allow-list of paths to keep in step with the routes.
 */
export function securityHeaders(supabaseUrl: string | undefined): Record<string, string> {
	return {
		...CONSTANT_SECURITY_HEADERS,
		'Content-Security-Policy': contentSecurityPolicy(supabaseUrl)
	};
}
