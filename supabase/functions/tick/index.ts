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
 * **The draw runs behind this entry point since Story 3.6.** `closeOne` below
 * is `closeAuction`, which reads a Minimum-Bid Contention's sealed seed under
 * the same lock it appends on and closes it on the drawn Contender — so an
 * expired lottery is swept like any other overdue Auction rather than being
 * passed over. Nothing about that is decided here; this file still only checks
 * the secret, builds the gateway and reports what the pass did.
 *
 * **The League Clock is evaluated behind this entry point since Story 3.7.**
 * `endPhase` below is `evaluateLeagueClock`, which folds the clock, the
 * nominations, the Auctions and the phase off one read inside its own locked
 * transaction and — when the clock has run out — appends one
 * `AuctionTerminated` per still-unbid nomination and then the
 * `ContractAssignmentOpened` that ends the phase. Nothing about that is
 * decided here; the ORDER (sweep, then the League Clock, then the drain) is
 * stated at the one place all three are wired together, exactly as `drain`
 * already was.
 *
 * **The outbox is drained behind this entry point since Story 5.1.** `drain`
 * below is `drainOutbox`, which re-derives which delivery intents are still
 * pending, posts at most the per-pass budget's worth through the Discord
 * webhook and appends one `NotificationDispatched` per attempt (AD-17, AD-18).
 * Nothing about that is decided here either; this file supplies the two
 * runtime-specific things the dispatcher cannot have — the webhook URL, read
 * from the environment, and `fetch`.
 *
 * **The webhook URL is read LAZILY, on the first message of a pass that has
 * one to send.** `required('DISCORD_WEBHOOK_URL')` throws on a misconfigured
 * deployment. Read beside the gateway it would take the whole pass down with it
 * — no sweep, no League Clock, no heartbeat — for a missing NOTIFICATION
 * secret. Read once per pass it would instead write a `drainFailure` every ten
 * seconds forever on a deployment that has nothing to notify about, which is
 * noise where there was previously silence. Read on the first actual `post`, it
 * is caught by `runTick`'s drain guard, recorded as `drainFailure` and as a
 * failed delivery attempt against the notice it belongs to, and retried — which
 * is exactly what "a Discord outage costs a notification and never a bid" means
 * for the configuration case too.
 *
 * **`APP_ORIGIN` reaches the drain the same lazy way since Story 5.3.** A
 * mention carries an absolute deep link to the Auction, and
 * `src/lib/core/auction-link.ts` answers a PATH and explicitly no origin —
 * a host is deployment configuration the core may not read, and the tick has no
 * request to take one from. It is passed as a THUNK the drain calls only once
 * it knows a notice is owed, so an idle pass evaluates no notification setting
 * at all. Unlike the webhook URL it is read with `Deno.env.get` rather than
 * `required`: an unset origin costs the LINK, never the ping, so failing a pass
 * over it would trade a working notification for a missing one.
 *
 * `APP_ORIGIN` is server-only and must never take a `PUBLIC_` prefix (AD-16).
 * It is not a secret, but nothing in the browser needs it — the browser already
 * knows its own origin — and putting it behind the prefix would inline a
 * deployment's host into the client bundle for no reader.
 *
 * Not this story: no pause check (Epic 7), no mute settings (5.4), no external
 * heartbeat detector (8.2).
 */

import { createDiscordWebhookPort } from '../../../src/lib/adapters/discord/webhook.ts';
import { closeAuction } from '../../../src/lib/server/close.ts';
import { DISCORD_CHANNEL, drainOutbox } from '../../../src/lib/server/outbox.ts';
import { evaluateLeagueClock } from '../../../src/lib/server/phase-end.ts';
import { runTick } from '../../../src/lib/server/sweep.ts';
import type { TickSummary } from '../../../src/lib/server/sweep.ts';
import { isAuthorisedRequest } from './auth.ts';
import { required, tickGateway } from './gateway.ts';

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

/**
 * The Discord channel port, built on the FIRST message and not before.
 *
 * **The laziness is the whole point of this wrapper.** `required` throws when
 * `DISCORD_WEBHOOK_URL` is unset, and the drain cannot know whether it has
 * anything to deliver until it has read the outbox. Constructing the port
 * eagerly — even inside the drain closure — evaluated `required` on every
 * single pass, so a deployment without the variable wrote a `drainFailure` to
 * `tick_heartbeats` every ten seconds for a drain that had nothing to do.
 * Before Story 5.1 an unset webhook URL had no effect on the tick at all, and
 * it should not have acquired one for the empty case.
 *
 * Built here, the refusal only ever reaches a pass that had a real notice to
 * send — where it is genuine news, is recorded as a failed delivery attempt
 * against that notice, backs off, and retries the moment the variable is set.
 *
 * One instance per drain, memoised across the batches of a single pass: the
 * isolate may be torn down between requests, so nothing is cached beyond it.
 */
function discordChannel() {
	let port: ReturnType<typeof createDiscordWebhookPort> | undefined;
	return {
		post(message: { readonly body: string; readonly recipients: readonly string[] }) {
			port ??= createDiscordWebhookPort({
				webhookUrl: required('DISCORD_WEBHOOK_URL'),
				// The runtime's own `fetch`, injected rather than reached for
				// inside the adapter — which is what keeps
				// `adapters/discord/webhook.ts` testable under Vitest with no
				// global patching.
				fetch: (url, init) => fetch(url, init)
			});
			return port.post(message);
		}
	};
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
			// The League Clock, after every close and before the drain (Story
			// 3.7). Its own whole locked transaction, so it folds a log that
			// already carries this pass's closes and a throw inside it rolls back
			// nothing that has already committed.
			endPhase: () => evaluateLeagueClock(gateway),
			// The outbox drain (AD-17), and the ORDER is the thing stated here:
			// sweep, then the League Clock, then the drain, then the heartbeat.
			// It runs last of the three because every close and every phase-end
			// event it might have to notify about must already be committed —
			// and because nothing it does can reach back into them.
			//
			// The port is built LAZILY, on the first message there is actually
			// something to send. See `discordChannel` below.
			// The braces are load-bearing: `DrainFn` answers `void`, and an
			// expression body would return the `DrainSummary` into it.
			drain: async () => {
				await drainOutbox(gateway, {
					channels: { [DISCORD_CHANNEL]: discordChannel() },
					// The app's own origin, for the deep link a mention carries
					// (Story 5.3). A THUNK for `discordChannel`'s reason: the
					// drain calls it only once it knows a notice is owed, so an
					// idle pass — by far the commonest — evaluates no
					// notification setting at all.
					//
					// `Deno.env.get` rather than `required`: an unset
					// `APP_ORIGIN` must not fail a pass. The mention posts
					// without a link rather than not at all, which is the
					// matrix's "the app origin is unset" row.
					origin: () => Deno.env.get('APP_ORIGIN') ?? null
				});
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
