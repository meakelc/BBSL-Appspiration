/**
 * The closed-pilot signpost, served in place of the whole app on a branch
 * deploy.
 *
 * **Why this exists.** The pilot ran at `https://pilot--bbslapp.netlify.app`, a
 * long-lived branch deploy of `pilot` pointed at the **dev** Supabase project
 * (`netlify.toml` maps `branch-deploy -> dev`). Managers were sent that URL
 * directly, so it is in their history, their bookmarks and their Discord
 * scrollback. Removing `pilot` from Netlify's `allowed_branches` stops future
 * builds and does NOT take the URL down: a branch subdomain keeps serving its
 * last successful deploy indefinitely. A Manager returning to that link would
 * therefore find a fully working auction and could nominate and bid in it — on
 * the wipeable dev database, against a League that no longer exists, with
 * nothing on screen to say so.
 *
 * Deleting the deploys instead would 404 them, which stops the bidding but
 * tells a confused Manager nothing. This module is the third option: the URL
 * stays up and answers every request with a page that says the pilot is over
 * and names where the real auction is.
 *
 * **Why it gates on `APP_ENV`.** `netlify.toml` already sets `APP_ENV` per
 * context and commits that mapping rather than clicking it — `production` for
 * prod, `branch` for a branch deploy. So the gate needs no new variable set by
 * hand in the Netlify UI, and it cannot reach production by any value of any
 * setting: the production context sets `APP_ENV = "production"`, and this
 * returns the notice for `"branch"` and nothing else. An unset or unknown value
 * serves the app, which is what keeps `vite dev` and the test suite normal.
 *
 * **This module reads no environment and performs no I/O**, so the test suite
 * can import it — the same split `security-headers.ts` documents. Only the
 * `APP_ENV` read lives in `hooks.server.ts`.
 */

/**
 * Where the real auction lives.
 *
 * The production context's own origin, named as a literal because the notice is
 * served BY the dead deployment and cannot derive the live one from anything it
 * has.
 */
export const LIVE_AUCTION_URL = 'https://bbslapp.netlify.app';

/**
 * Does this deployment serve the signpost instead of the app?
 *
 * `'branch'` is the value `netlify.toml` sets for `[context.branch-deploy]`.
 * Everything else — `'production'`, `'preview'`, and the `undefined` of a local
 * `vite dev` or a test run — serves the app.
 */
export function isClosedPilot(appEnv: string | undefined): boolean {
	return appEnv === 'branch';
}

/**
 * The notice, as one self-contained document.
 *
 * No script, no stylesheet, no image, no font — every request to this
 * deployment returns this same page, including the ones that would have
 * fetched an asset, so a document that referenced one would be referencing
 * itself. Inline styles only, which the Content-Security-Policy already admits.
 */
export const CLOSED_PILOT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>The pilot is over</title>
<style>
  /* The token values from lib/styles/tokens.css, as literals. The notice cannot
     import the stylesheet: every request to this deployment returns this
     document, so the request for a stylesheet would return it too. Dark only,
     the same as the app (tests/tokens.test.ts bans a light scheme in src/). */
  :root { color-scheme: dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    box-sizing: border-box;
    background: #0D1712;
    color: #E8F0E9;
    font-family: system-ui, 'Segoe UI', -apple-system, sans-serif;
    font-size: 15px;
    line-height: 1.6;
  }
  main { max-width: 34rem; }
  h1 {
    font-family: Georgia, 'Palatino Linotype', Palatino, serif;
    font-size: 24px;
    line-height: 1.25;
    margin: 0 0 16px;
  }
  p { margin: 0 0 16px; color: #C3D0C6; }
  a.cta {
    display: inline-block;
    margin-top: 4px;
    padding: 12px 20px;
    background: #15211B;
    /* Every button in this product carries an interactive border. */
    border: 1px solid #5E7568;
    border-radius: 6px;
    color: #E8F0E9;
    font-weight: 600;
    text-decoration: none;
  }
  .note { font-size: 13px; color: #93A69A; }
  code { font-size: 13px; color: #E8F0E9; }
</style>
</head>
<body>
<main>
  <h1>The pilot is over.</h1>
  <p>
    This was the practice auction. Nothing you do here counts, and nothing here
    is connected to your real roster or your real budget.
  </p>
  <p>The real auction is on a different address:</p>
  <p><a class="cta" href="${LIVE_AUCTION_URL}">Go to the real auction</a></p>
  <p class="note">
    Update your bookmark to <strong>bbslapp.netlify.app</strong> &mdash; no
    <code>pilot--</code> in front of it.
  </p>
</main>
</body>
</html>
`;

/**
 * The signpost as a response, with the security headers the caller supplies.
 *
 * `200` rather than `404` or `410`: a Manager following an old link should read
 * the notice, and a browser or link preview treating a 4xx as "nothing here"
 * would hide the one thing this page exists to say. `no-store` so a Manager who
 * loaded the working app from this origin minutes earlier does not keep a
 * cached copy of it.
 */
export function closedPilotResponse(securityHeaders: Record<string, string>): Response {
	return new Response(CLOSED_PILOT_HTML, {
		status: 200,
		headers: {
			...securityHeaders,
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store, must-revalidate'
		}
	});
}
