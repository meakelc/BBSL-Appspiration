import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	CLOSED_PILOT_HTML,
	LIVE_AUCTION_URL,
	closedPilotResponse,
	isClosedPilot
} from '../src/lib/server/pilot-closed.ts';
import { CONSTANT_SECURITY_HEADERS } from '../src/lib/server/security-headers.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NETLIFY_TOML = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');

/**
 * The closed-pilot signpost.
 *
 * The gate reads ONE string — `APP_ENV` — and the value it compares against is
 * written in `netlify.toml`, not here. A rename of that value in either place
 * would either leave the dead pilot serving a live auction or take production
 * down, so the first test reads the file rather than trusting the constant.
 */
describe('the closed pilot', () => {
	it('serves the notice for the value netlify.toml gives a branch deploy', () => {
		const branch = /\[context\.branch-deploy\.environment\]([\s\S]*?)(?=\n\[|\s*$)/.exec(
			NETLIFY_TOML
		);
		expect(branch).not.toBeNull();
		const appEnv = /^\s*APP_ENV\s*=\s*"(.*)"$/m.exec(branch?.[1] ?? '');
		expect(appEnv).not.toBeNull();
		expect(isClosedPilot(appEnv?.[1])).toBe(true);
	});

	it('serves the app for the value netlify.toml gives production', () => {
		const production = /\[context\.production\.environment\]([\s\S]*?)(?=\n\[|\s*$)/.exec(
			NETLIFY_TOML
		);
		expect(production).not.toBeNull();
		const appEnv = /^\s*APP_ENV\s*=\s*"(.*)"$/m.exec(production?.[1] ?? '');
		expect(appEnv).not.toBeNull();
		expect(isClosedPilot(appEnv?.[1])).toBe(false);
	});

	/**
	 * An unset `APP_ENV` is `vite dev` and the test suite. Failing OPEN is right
	 * here and only here: the cost of guessing wrong is a local dev server
	 * showing a notice, whereas a gate that defaulted closed would blank the app
	 * for every developer and, if a context ever stopped setting the variable,
	 * production too.
	 */
	it('serves the app when APP_ENV is unset or unrecognised', () => {
		expect(isClosedPilot(undefined)).toBe(false);
		expect(isClosedPilot('')).toBe(false);
		expect(isClosedPilot('preview')).toBe(false);
		expect(isClosedPilot('Branch')).toBe(false);
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
