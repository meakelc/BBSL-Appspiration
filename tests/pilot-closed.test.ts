import { describe, expect, it } from 'vitest';

import {
	CLOSED_PILOT_HTML,
	LIVE_AUCTION_URL,
	closedPilotResponse,
	isClosedPilotHost
} from '../src/lib/server/pilot-closed.ts';
import { CONSTANT_SECURITY_HEADERS } from '../src/lib/server/security-headers.ts';

/**
 * The closed-pilot signpost.
 *
 * The gate reads the request HOSTNAME. The first cut read `APP_ENV` from
 * `netlify.toml`, deployed, and left the pilot serving a live auction: variables
 * declared in `netlify.toml` are build-time only and never reach a Netlify
 * Function. These tests pin the hostname behaviour on both sides — the pilot
 * closed, and production emphatically not.
 */
describe('the closed pilot', () => {
	it('closes the pilot branch deploy', () => {
		expect(isClosedPilotHost('pilot--bbslapp.netlify.app')).toBe(true);
		// A hostname is case-insensitive.
		expect(isClosedPilotHost('PILOT--BBSLAPP.NETLIFY.APP')).toBe(true);
		// Still true if the site is ever renamed.
		expect(isClosedPilotHost('pilot--somethingelse.netlify.app')).toBe(true);
	});

	/**
	 * The shapes the three call sites actually pass: a bare hostname from
	 * `event.url`, a `host` header carrying a port, and an `x-forwarded-host`
	 * that may be a proxy chain.
	 */
	it('reads the branch out of any hostname shape a proxy produces', () => {
		expect(isClosedPilotHost('pilot--bbslapp.netlify.app:443')).toBe(true);
		expect(isClosedPilotHost('pilot--bbslapp.netlify.app, bbslapp.netlify.app')).toBe(true);
		expect(isClosedPilotHost(' pilot--bbslapp.netlify.app ')).toBe(true);
	});

	/**
	 * Any ONE signal naming the branch closes the deployment, and an empty one
	 * never vetoes a populated one. The first version of this gate read a single
	 * signal that was empty at runtime and silently served a live auction.
	 */
	it('closes on any one signal, whichever of the three is populated', () => {
		expect(isClosedPilotHost(undefined, 'pilot--bbslapp.netlify.app', null)).toBe(true);
		expect(isClosedPilotHost('', null, 'pilot--bbslapp.netlify.app')).toBe(true);
		expect(isClosedPilotHost('localhost', null, 'pilot--bbslapp.netlify.app')).toBe(true);
		// All three empty is local development, not a closed pilot.
		expect(isClosedPilotHost(undefined, null, '')).toBe(false);
	});

	/**
	 * The one test that must never go green by accident. Production has no `--`
	 * in its host, so no deploy setting and no rename can route it here.
	 */
	it('never closes production', () => {
		expect(isClosedPilotHost('bbslapp.netlify.app')).toBe(false);
		expect(isClosedPilotHost('www.bbslapp.netlify.app')).toBe(false);
		// Not a prefix match anywhere but the branch label.
		expect(isClosedPilotHost('bbslapp.netlify.app/pilot--')).toBe(false);
	});

	it('leaves deploy previews and local development alone', () => {
		// A pull request still needs a working app to review.
		expect(isClosedPilotHost('deploy-preview-66--bbslapp.netlify.app')).toBe(false);
		expect(isClosedPilotHost('localhost')).toBe(false);
		expect(isClosedPilotHost('127.0.0.1')).toBe(false);
		expect(isClosedPilotHost(undefined)).toBe(false);
		expect(isClosedPilotHost('')).toBe(false);
	});

	/**
	 * `pilot` must not be an allow-listed branch once this ships — it is the
	 * Netlify half of the same takedown, and a branch that can still build is a
	 * branch someone can reopen the auction on by pushing to it. That setting
	 * lives in Netlify rather than in the repository, so this only pins the
	 * half the repository owns: the notice does not name the dead host as the
	 * place to go.
	 */
	it('does not send a Manager back to the deployment serving the notice', () => {
		expect(isClosedPilotHost(new URL(LIVE_AUCTION_URL).hostname)).toBe(false);
	});

	/**
	 * Every request to the closed deployment returns this same document, the
	 * ones that would have fetched an asset included — so a reference to a
	 * script, stylesheet, image or font would resolve to the notice itself.
	 */
	it('is a self-contained document that fetches nothing', () => {
		expect(CLOSED_PILOT_HTML).not.toMatch(/<script/i);
		expect(CLOSED_PILOT_HTML).not.toMatch(/<link\b/i);
		expect(CLOSED_PILOT_HTML).not.toMatch(/<img\b/i);
		expect(CLOSED_PILOT_HTML).not.toMatch(/\bsrc=/i);
	});

	it('names the real auction, and does not name itself as it', () => {
		expect(CLOSED_PILOT_HTML).toContain(LIVE_AUCTION_URL);
		expect(LIVE_AUCTION_URL).not.toContain('pilot--');
	});

	it('answers 200 so the notice is actually read, and is never cached', () => {
		const response = closedPilotResponse({ 'X-Frame-Options': 'DENY' });
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
		expect(response.headers.get('Cache-Control')).toContain('no-store');
	});

	/**
	 * The notice is still a response this private league's app serves, so it
	 * carries the same headers every other one does — a page that dropped
	 * `X-Robots-Tag` would be the one page on the origin a crawler may index.
	 */
	it('carries the security headers it is handed', () => {
		const response = closedPilotResponse(CONSTANT_SECURITY_HEADERS);
		for (const [name, value] of Object.entries(CONSTANT_SECURITY_HEADERS)) {
			expect(response.headers.get(name)).toBe(value);
		}
	});
});
