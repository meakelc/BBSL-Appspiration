/**
 * The tick's Deno entry point: verify the secret, build the gateway, run one
 * pass, answer with the summary. Story 3.5.
 *
 * **All the judgement is in `src/lib/server/sweep.ts`.** This file decides
 * nothing about what to close, in what order, or whether to close at all — it
 * is the thin shell around `runTick`, and everything it knows is
 * runtime-specific: how a request arrives, where a secret lives, how a
 * connection is opened. `sweep.ts` is ordinary TypeScript with relative `.ts`
 * imports only, so Deno loads the exact file Node unit-tests (AD-2). That is
 * the property this check exists to prove, and it is not optional:
 *
 *     npx deno check --config supabase/functions/tick/deno.json  *       supabase/functions/tick/index.ts
 *
 * `--config` is load-bearing. Deno discovers a config file by walking up from
 * the CWD, not from the entry module, so running the bare form at the
 * repository root finds no import map and fails on `Import "postgres" not a
 * dependency` — which looks like a broken import and is really a missing flag.
 *
 * **The secret is checked FIRST**, before any connection is opened, before any
 * heartbeat is written and before anything is closed. A request that does not
 * present `TICK_INVOCATION_SECRET` gets a bare `401` and leaves no trace: an
 * unauthenticated caller must not be able to make the heartbeat table grow, or
 * to learn anything about the auction's state from a timing difference.
 *
 * **The comparison is constant-time over the encoded bytes**, and it lives in
 * `auth.ts` rather than here — this file calls `Deno.serve` at module scope and
 * therefore cannot be imported by Vitest, which would leave the tick's one
 * security boundary with no automated proof. `auth.ts` takes both secrets as
 * arguments and touches no global, so `tests/server/tick-auth.test.ts` drives
 * it directly.
 *
 * **A pass never returns a non-2xx for its own outcome.** A refusal
 * (`refused_version_mismatch`), a failed close and a thrown drain are all
 * recorded facts, not transport errors; pg_cron cannot read a body and would
 * retry nothing either way, so the heartbeat table is the record and the
 * response body is for a human running `curl`. Only a pass that could not
 * write its heartbeat at all reaches the `500`.
 *
 * Not this story: no draw (3.6), no pause check (Epic 7), no outbox and no
 * Discord (5.1), no League Clock evaluation (3.7), no external heartbeat
 * detector (8.2).
 */

import { closeAuction } from '../../../src/lib/server/close.ts';
import { runTick } from '../../../src/lib/server/sweep.ts';
import type { TickSummary } from '../../../src/lib/server/sweep.ts';
import { isAuthorisedRequest } from './auth.ts';
import { tickGateway } from './gateway.ts';

/**
 * Is this request the cron job?
 *
 * **Exactly one thing is left here: reading the variable.** Everything else —
 * which header is consulted, which side is the expected secret, and the
 * comparison itself — lives in `auth.ts`, where `tests/server/tick-auth.test.ts`
 * drives it with a real `Request`. This file cannot be imported by Vitest at
 * all (`Deno.serve` runs at module scope), so anything decided here is
 * unprovable; an earlier draft kept the wiring here and a source-text position
 * check was the only thing standing behind it, which would not have noticed the
 * two arguments being swapped.
 */
function isAuthorised(request: Request): boolean {
	return isAuthorisedRequest(Deno.env.get('TICK_INVOCATION_SECRET'), request.headers);
}

/** The pass summary, as the response body. */
function summaryResponse(summary: TickSummary, status: number): Response {
	return new Response(JSON.stringify(summary, null, 2), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

Deno.serve(async (request: Request): Promise<Response> => {
	if (!isAuthorised(request)) {
		// No connection opened, no heartbeat written, no Auction closed.
		return new Response('unauthorised', { status: 401 });
	}

	// **Built INSIDE the try, and that placement is load-bearing.**
	// `tickGateway` calls `required('SUPABASE_DB_URL')`, which throws on a
	// misconfigured deployment. Constructed above the try, that throw would
	// escape `Deno.serve` as an unhandled rejection — bypassing both the 500
	// below and the log line beside it, and making this file's own claim that
	// "only a pass that could not write its heartbeat reaches the 500" false
	// for the most likely deployment failure there is.
	let close: (() => Promise<void>) | undefined;
	try {
		const built = tickGateway();
		const gateway = built.gateway;
		close = built.close;

		const summary = await runTick({
			gateway,
			// One whole locked transaction per Auction, committed before the
			// next is evaluated (AD-11). The sweep never batches.
			closeOne: (fantraxPlayerId) => closeAuction(gateway, fantraxPlayerId),
			// Epic 5.1's outbox drain (AD-17): ordered after the sweep, always,
			// and a documented no-op until that story gives it an
			// implementation. It is passed explicitly rather than omitted so
			// that the ORDER — sweep, then drain, then heartbeat — is stated
			// here at the one place both halves are wired together, exactly as
			// `enqueue` is stated in `shell/write.ts`.
			drain: () => {
				/* Epic 5.1's outbox dispatcher. Nothing to drain yet. */
			}
		});
		return summaryResponse(summary, 200);
	} catch (error) {
		// Two ways here, and both are configuration or infrastructure rather
		// than anything the pass decided: a gateway that could not be built
		// (no `SUPABASE_DB_URL`), or a heartbeat write that itself failed.
		// Every failure INSIDE the pass becomes a recorded outcome instead of
		// an exception, so neither of these has a row to describe it — which is
		// why they go to the function log as well as the response.
		console.error('tick: the pass could not run or could not record a heartbeat', error);
		return new Response(
			JSON.stringify({
				outcome: 'failed',
				detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
			}),
			{ status: 500, headers: { 'content-type': 'application/json' } }
		);
	} finally {
		// `close` is undefined when `tickGateway()` itself threw — there is no
		// pool to drain in that case, and calling through would replace the 500
		// above with a TypeError about calling undefined.
		if (close !== undefined) {
			await close().catch((error: unknown) => {
				console.error('tick: draining the connection pool failed', error);
			});
		}
	}
});
