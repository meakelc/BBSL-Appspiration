/**
 * The browser half of the freshness contract (AD-29, Story 4.1).
 *
 * **This module holds no rule.** It owns the Supabase browser client, the
 * `auction_watermark` subscription, the `LIVENESS_INTERVAL` poll and the
 * reload, and it feeds three plain values to `deriveFreshness` in
 * `core/freshness.ts`. Which of the three states those values mean is decided
 * there and nowhere else — a second opinion about "is this stale" living in a
 * `.svelte.ts` file is exactly the drift AD-29's single derivation exists to
 * prevent.
 *
 * **It runs only for a signed-in Manager.** The layout gates `start()` on the
 * session, because a visitor with no session has no figures to protect and no
 * controls to disable — and the endpoint's `401` is indistinguishable here from
 * an outage, so an ungated contract would show the sign-in page an assertive
 * "cannot reach the server" alert two minutes in, about a server that answered
 * the very request that rendered it. A session that lapses MID-VISIT is the
 * opposite case and is handled exactly as an outage: those figures really are
 * no longer refreshable.
 *
 * **The client only ever reads** (AD-9). It subscribes, it polls, it reloads. It
 * holds no write path of any kind, and the key it carries is the anon key,
 * whose only grant anywhere is `select` on the single watermark row.
 *
 * **Liveness is the poll, never the silence.** Nothing here treats the absence
 * of a pushed message as evidence of anything. `lastLivenessOkAt` moves only
 * when a same-origin `GET` actually comes back `200` — the question is "can I
 * reach the server", never "has anything changed" — because this league has
 * genuinely quiet six-hour stretches and a client that conflated the two would
 * disable bidding all night.
 *
 * **Nothing here can crash a page.** Every network act is wrapped, and so is
 * every callback the Realtime library invokes LATER — a `try` around
 * construction does not cover a handler the socket calls ten minutes on. Each
 * failure degrades to "the channel is in error" or "that check lapsed", which
 * are states the contract already has words for. A freshness monitor that could
 * throw would be a freshness monitor that took the auction down with it.
 *
 * **The anchor discipline is the Auction page's, deliberately.** The origin of
 * `now` is always a SERVER instant; only the elapsed time since it arrived is
 * measured locally, from `Date.now()` differences and clamped at zero. A device
 * whose wall clock is three hours fast therefore reads a fresh page as fresh,
 * and a backward NTP correction cannot pull a page's instant behind the last
 * check it confirmed.
 *
 * **Every collaborator is a port.** The Supabase client, the `fetch`, the
 * credentials and the reload are injectable — the same shape `server/auth.ts`
 * uses for Discord and the registry, and for the same reason: the poll and the
 * channel callbacks are where this module's real behaviour lives, and a test
 * that can only read the source text is not a test of any of it.
 */

import { createBrowserClient } from '@supabase/ssr';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/public';
import { invalidateAll } from '$app/navigation';

import { LIVENESS_INTERVAL, LIVENESS_TIMEOUT } from '$lib/core/constants.ts';
import { deriveFreshness } from '$lib/core/freshness.ts';
import type { ChannelStatus, FreshnessState } from '$lib/core/freshness.ts';
import { formatInstant, parseInstant } from '$lib/core/instant.ts';
import { INITIAL_WATERMARK, higherSeq } from '$lib/core/projection/watermark.ts';

/** The same-origin liveness endpoint. Named once; `/api/watermark` owns it. */
const LIVENESS_ENDPOINT = '/api/watermark';

/** The single-row table the browser subscribes to, and the only one it may. */
const WATERMARK_TABLE = 'auction_watermark';

/** The channel's own name. One channel, for one table, for the whole app. */
const WATERMARK_CHANNEL = 'auction-watermark';

/** What a server read hands over: the height of the log, and when it was read. */
export type ServerRead = {
	readonly watermark: string;
	readonly at: string;
};

/** The project's public credentials, or empty strings when unprovisioned. */
export type Credentials = { readonly url: string; readonly key: string };

/**
 * Everything this module reaches the world through.
 *
 * All five have real defaults, so production constructs the contract with no
 * arguments at all; a test substitutes the ones it needs and drives the poll
 * and the channel callbacks directly.
 */
export type FreshnessPorts = {
	/** Builds the browser Supabase client. */
	readonly createClient?: (url: string, key: string) => SupabaseClient;
	/** The liveness request. */
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	/** The project credentials, read at `start()` rather than at import. */
	readonly credentials?: () => Credentials;
	/** Re-runs every `load`. `invalidateAll` in production. */
	readonly reload?: () => Promise<void>;
	/** Whether the tab is hidden, and a way to hear it change. `document` in production. */
	readonly visibility?: Visibility;
};

/**
 * The page's visibility, as the poll needs it.
 *
 * A port rather than a direct `document` read for the reason every other
 * collaborator here is one: the suite runs in `node`, where there is no
 * `document`, and the pause-while-hidden behaviour is exactly the kind of
 * thing a source-text assertion cannot see.
 */
export type Visibility = {
	/** True when the tab is backgrounded. False wherever there is no document. */
	readonly hidden: () => boolean;
	/** Call `listener` on every visibility change; returns the unsubscribe. */
	readonly watch: (listener: () => void) => () => void;
};

/** The real page's visibility, inert during SSR where `document` does not exist. */
const documentVisibility: Visibility = {
	hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
	watch: (listener) => {
		if (typeof document === 'undefined') return () => {};
		document.addEventListener('visibilitychange', listener);
		return () => document.removeEventListener('visibilitychange', listener);
	}
};

/**
 * The freshness contract as the browser runs it.
 *
 * A class rather than loose module state so the anchors and the timer handle
 * are genuinely private — a surface can read the state and cannot reach in and
 * move the clock.
 */
export class FreshnessContract {
	/** What the channel last said about itself. Fed straight to the core. */
	channel = $state<ChannelStatus>('CONNECTING');

	/** The last liveness re-read that SUCCEEDED, ISO-8601 UTC. Fed to the core. */
	lastLivenessOkAt = $state('');

	/** The instant to judge it against, ISO-8601 UTC. Fed to the core. */
	now = $state('');

	/** The highest `seq` this client knows about. Compared, never rendered. */
	watermark = $state(INITIAL_WATERMARK);

	/** The server instant the anchor was taken at, epoch ms. */
	#anchorServerMs = 0;

	/** `Date.now()` at the moment that anchor arrived, epoch ms. */
	#anchorLocalMs = 0;

	/**
	 * Whether the browser has actually started the contract.
	 *
	 * **This is what keeps a server-rendered page from claiming Reconnecting.**
	 * During SSR there is no channel, no poll and no browser clock, and the
	 * document being produced is by construction current at the instant it is
	 * produced — the request that made it IS the liveness proof. Reporting
	 * anything but Live for that would be a page describing a connection it has
	 * not tried to open yet. The moment `start()` runs in the browser, the real
	 * three-value derivation takes over, including the honest `CONNECTING` →
	 * `CHANNEL_ERROR` walk a blocked socket produces.
	 *
	 * It is also what a signed-out visitor leaves false: the layout never calls
	 * `start()` without a session, so the notice never renders on `/signin`.
	 */
	#started = false;

	#client: SupabaseClient | null = null;
	#subscription: RealtimeChannel | null = null;
	#ticking: ReturnType<typeof setInterval> | null = null;
	#unwatchVisibility: (() => void) | null = null;

	/** A reload is in flight. */
	#reloading = false;

	/** A raise landed while one was in flight, and must be honoured after it. */
	#pendingReload = false;

	/** A poll is in flight. Two overlapping polls can be applied out of order. */
	#polling = false;

	readonly #ports: Required<FreshnessPorts>;

	constructor(ports: FreshnessPorts = {}) {
		this.#ports = {
			createClient: ports.createClient ?? ((url, key) => createBrowserClient(url, key)),
			fetch: ports.fetch ?? ((input, init) => fetch(input, init)),
			credentials:
				ports.credentials ??
				(() => ({
					url: env['PUBLIC_SUPABASE_URL'] ?? '',
					key: env['PUBLIC_SUPABASE_ANON_KEY'] ?? ''
				})),
			reload: ports.reload ?? (() => invalidateAll()),
			visibility: ports.visibility ?? documentVisibility
		};
	}

	/**
	 * One of the three states, from the core and only from the core.
	 *
	 * Nothing in this file compares an instant to a window or asks whether a
	 * channel status is good news; it hands over three values and prints the
	 * answer.
	 */
	get state(): FreshnessState {
		if (!this.#started) return 'live';
		return deriveFreshness({
			channel: this.channel,
			lastLivenessOkAt: this.lastLivenessOkAt,
			now: this.now
		});
	}

	/** Whether the contract is running. Read by a test, never by a surface. */
	get running(): boolean {
		return this.#started;
	}

	/**
	 * Record a successful read from the server: SSR's own instant, or a poll
	 * that came back.
	 *
	 * Re-anchors `now` on the server's instant and resets the local origin, so
	 * the age is zero at this moment and grows by locally measured elapsed time
	 * from here.
	 *
	 * **It deliberately does NOT reload**, and callers depend on that: the layout
	 * data carrying this instant IS the reload, so reloading here would loop. The
	 * poll compares the watermark it held BEFORE calling this against the one it
	 * holds after, and asks for the reload itself.
	 */
	observeServerRead(read: ServerRead): void {
		const anchor = parseInstant(read.at);
		// An unreadable instant is not recorded as a success. A liveness check
		// whose stamp cannot be parsed has not established when it happened, and
		// treating it as "now" would hold a client at Live on a malformed
		// response — the one direction this contract must never fail in.
		if (anchor === null) return;

		// **The anchor only ever moves forward.** Two reads can settle out of
		// order — a slow poll answered after a fast one, a navigation load racing
		// a tick — and an older instant adopted as the anchor would silently add
		// the gap between them to every age this page renders. Equal is accepted:
		// the same instant re-proved is still proof, and re-anchoring the LOCAL
		// origin to now is what makes it fresh again.
		if (anchor < this.#anchorServerMs) return;

		this.#anchorServerMs = anchor;
		this.#anchorLocalMs = Date.now();
		this.lastLivenessOkAt = read.at;
		this.now = read.at;
		this.watermark = higherSeq(this.watermark, read.watermark);
	}

	/**
	 * Start the channel and the poll. Idempotent: calling it twice does nothing
	 * the second time, so a layout effect that re-runs cannot leave two
	 * subscriptions or two intervals alive.
	 */
	start(): void {
		if (this.#started) return;
		this.#started = true;
		this.#openChannel();
		if (!this.#ports.visibility.hidden()) this.#startInterval();
		this.#watchVisibility();
	}

	/** Begin polling on `LIVENESS_INTERVAL`. A no-op when already polling. */
	#startInterval(): void {
		if (this.#ticking !== null) return;
		this.#ticking = setInterval(() => {
			this.#tick();
		}, LIVENESS_INTERVAL);
	}

	/** Stop polling. A no-op when not polling. */
	#stopInterval(): void {
		if (this.#ticking === null) return;
		clearInterval(this.#ticking);
		this.#ticking = null;
	}

	/**
	 * Tear down everything, and forget everything.
	 *
	 * **The state is reset, not merely the timers.** This is a singleton: a later
	 * `start()` — a Manager signing back in, a layout remounting — would
	 * otherwise compute `now` from an anchor taken before the gap, and render an
	 * age measured from a moment that has nothing to do with this session. The
	 * layout re-seeds from `+layout.server.ts` on the way back in, so there is
	 * nothing here worth keeping.
	 */
	stop(): void {
		this.#stopInterval();
		if (this.#unwatchVisibility !== null) {
			this.#unwatchVisibility();
			this.#unwatchVisibility = null;
		}
		if (this.#subscription !== null) {
			// `removeChannel` returns a promise; a rejection during teardown is
			// nothing anybody can act on and must not become an unhandled one.
			try {
				void Promise.resolve(this.#client?.removeChannel(this.#subscription)).catch(() => {});
			} catch {
				// A library that threw synchronously on teardown. Nothing to do.
			}
			this.#subscription = null;
		}
		this.#client = null;
		this.#started = false;
		this.#polling = false;
		this.#pendingReload = false;
		this.channel = 'CONNECTING';
		this.lastLivenessOkAt = '';
		this.now = '';
		this.watermark = INITIAL_WATERMARK;
		this.#anchorServerMs = 0;
		this.#anchorLocalMs = 0;
	}

	/**
	 * Stop polling while the tab is hidden, and poll the moment it is looked at
	 * again.
	 *
	 * **A hidden tab does not poll at all.** Every poll is a billed Netlify
	 * Function invocation, and a tab left open overnight was one a minute even
	 * under the browser's background throttling — for a page nobody is reading.
	 * Pausing costs nothing the freshness contract promises: a hidden tab renders
	 * no state for anyone to be misled by, and the tick on return advances `now`
	 * BEFORE it polls, so the returning Manager's first frame shows the true age
	 * of what they are looking at, never a stale page dressed as Live.
	 *
	 * **Recovery is still immediate and silent**, as the AC requires: the first
	 * thing a returning tab does is a liveness check, and only then does the
	 * interval resume.
	 */
	#watchVisibility(): void {
		this.#unwatchVisibility = this.#ports.visibility.watch(() => {
			if (this.#ports.visibility.hidden()) {
				this.#stopInterval();
				return;
			}
			this.#tick();
			this.#startInterval();
		});
	}

	/**
	 * One interval: advance `now`, then ask the server whether it is there.
	 *
	 * The advance happens FIRST and unconditionally. It is what makes the state
	 * degrade on schedule when the poll is failing — if `now` only moved on a
	 * successful response, a client that had lost the server entirely would sit
	 * at whatever state it was in when the connection died, which is precisely
	 * the silent-stale failure AD-29 names as the worst in the product.
	 */
	#tick(): void {
		if (!this.#started) return;
		this.#advance();
		void this.#poll();
	}

	/**
	 * `now` = the anchored server instant plus the time this device has measured
	 * since it arrived.
	 *
	 * `Date.now()` appears here and in `observeServerRead` and nowhere else in
	 * this file: it measures a duration between two readings of the same clock,
	 * which is the one thing a client clock is allowed to do. Clamped at zero so
	 * a backward system-clock adjustment cannot move this instant behind the
	 * anchor and make a stale page read as fresh.
	 */
	#advance(): void {
		if (this.#anchorServerMs === 0) return;
		const elapsed = Math.max(0, Date.now() - this.#anchorLocalMs);
		this.now = formatInstant(this.#anchorServerMs + elapsed);
	}

	/**
	 * The liveness re-read.
	 *
	 * A non-`200` — `401` a lapsed session, `503` a database that could not be
	 * read — and a thrown or timed-out `fetch` are the same outcome here: the
	 * check lapsed, nothing is recorded, and the state degrades on schedule. No
	 * status is surfaced as a fault, because none of them says anything happened
	 * to the auction.
	 *
	 * **Bounded and non-overlapping.** A request with no timeout can hang past
	 * several intervals, and two in flight at once can settle out of order and
	 * apply the older answer last. `LIVENESS_TIMEOUT` sits inside
	 * `LIVENESS_INTERVAL` so a hung request is abandoned before the next tick
	 * rather than accumulating, and `#polling` means a tick that finds one still
	 * running does nothing — the answer it wants is already on its way.
	 *
	 * **The reload decision is made against the watermark held BEFORE the
	 * response is absorbed.** `observeServerRead` raises `this.watermark` as part
	 * of recording the read, so comparing against it afterwards would compare a
	 * value with itself and never reload — and with the socket CSP-blocked, that
	 * would mean a deployed client never refreshing at all.
	 */
	async #poll(): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;

		const controller = new AbortController();
		const abort = setTimeout(() => {
			controller.abort();
		}, LIVENESS_TIMEOUT);

		try {
			const response = await this.#ports.fetch(LIVENESS_ENDPOINT, {
				headers: { accept: 'application/json' },
				// The response's whole value is that it was produced now.
				cache: 'no-store',
				signal: controller.signal
			});
			if (!response.ok) return;

			const body: unknown = await response.json();
			const read = readServerRead(body);
			if (read === null) return;

			const held = this.watermark;
			this.observeServerRead(read);
			this.#reloadIfRaised(held, this.watermark);
		} catch {
			// A lapsed check, not a crash. Nothing to record and nothing to say.
		} finally {
			clearTimeout(abort);
			this.#polling = false;
		}
	}

	/**
	 * A `seq` pushed down the channel.
	 *
	 * `higherSeq` decides, not `!==`: a watermark that arrived LOWER than the one
	 * held — a replayed message, or a read served by a lagging replica — must not
	 * trigger a reload that would then reload again when the correct value came
	 * back.
	 */
	#observePush(seq: string): void {
		const held = this.watermark;
		this.watermark = higherSeq(held, seq);
		this.#reloadIfRaised(held, this.watermark);
	}

	/**
	 * Reload the page's data if the watermark actually went up.
	 *
	 * `invalidateAll()` re-runs every `load`, which is what makes a Bid placed by
	 * another Manager appear here without a manual refresh. It is also what
	 * re-anchors the contract, since the layout load returns a fresh
	 * `serverInstant` on the way through.
	 */
	#reloadIfRaised(before: string, after: string): void {
		if (after === before) return;
		if (this.#reloading) {
			// **Queued, not dropped.** `this.watermark` is already at the newer
			// value, so a later comparison against it would find nothing to do and
			// the newest data would never be fetched. The flag is what carries
			// "something landed while we were busy" past the in-flight reload.
			this.#pendingReload = true;
			return;
		}
		this.#runReload();
	}

	/** The reload itself, re-entrant through the queued flag. */
	#runReload(): void {
		this.#reloading = true;
		void this.#ports
			.reload()
			.catch(() => {
				// A failed reload is a failed read like any other: the poll comes
				// round again, and the state degrades meanwhile.
			})
			.finally(() => {
				this.#reloading = false;
				if (!this.#pendingReload) return;
				this.#pendingReload = false;
				this.#runReload();
			});
	}

	/**
	 * Open the subscription, or record that it could not be opened.
	 *
	 * **A blocked socket is a channel error, not an exception.** Until the two
	 * Supabase projects are provisioned and their literal hosts are named in
	 * `connect-src`, this cannot connect in production at all — and the required
	 * behaviour is that the app sits honestly in Reconnecting while the
	 * same-origin poll keeps working, never that it throws. The same holds for
	 * an unset `PUBLIC_SUPABASE_URL`, which is the state of both projects today.
	 *
	 * The socket host is whatever `PUBLIC_SUPABASE_URL` names and is never
	 * written down here, so admitting it to the CSP later is one line in
	 * `netlify.toml` naming that same host — and never a wildcard.
	 */
	#openChannel(): void {
		const { url, key } = this.#ports.credentials();
		if (url.trim() === '' || key.trim() === '') {
			this.channel = 'CHANNEL_ERROR';
			return;
		}

		try {
			// `createBrowserClient` rather than a bare `createClient`: it reads
			// the auth cookies `@supabase/ssr` wrote server-side, so the socket
			// authorises as `authenticated` and the watermark row's RLS policy
			// admits it. A client with no session would be `anon`, which holds
			// nothing on any table in this schema — correctly.
			this.#client = this.#ports.createClient(url, key);
			this.#subscription = this.#client
				.channel(WATERMARK_CHANNEL)
				.on(
					'postgres_changes',
					{ event: '*', schema: 'public', table: WATERMARK_TABLE },
					(payload: { new?: Record<string, unknown> }) => {
						// **Wrapped, because this runs LATER.** The `try` around the
						// construction below cannot cover a callback the socket
						// invokes ten minutes from now, and an exception thrown
						// inside a library's own event dispatch is an unhandled one.
						try {
							const seq = payload?.new?.['seq'];
							if (seq === undefined || seq === null) return;
							this.#observePush(String(seq));
						} catch {
							// A malformed payload is not evidence of anything, and the
							// poll is what establishes liveness regardless.
						}
					}
				)
				.subscribe((status: string) => {
					try {
						this.channel = asChannelStatus(status);
					} catch {
						this.channel = 'CHANNEL_ERROR';
					}
				});
		} catch {
			// A CSP refusal, a malformed URL, a library that threw: all one
			// outcome. The poll is untouched and the app degrades honestly.
			this.channel = 'CHANNEL_ERROR';
			this.#client = null;
			this.#subscription = null;
		}
	}
}

/**
 * Supabase's status string, narrowed to the core's type.
 *
 * An unrecognised status is `CHANNEL_ERROR` rather than anything optimistic: a
 * channel reporting something this codebase does not understand has not
 * reported that it is subscribed, and Live requires a positive `SUBSCRIBED`.
 */
function asChannelStatus(status: string): ChannelStatus {
	switch (status) {
		case 'SUBSCRIBED':
		case 'CHANNEL_ERROR':
		case 'TIMED_OUT':
		case 'CLOSED':
			return status;
		default:
			return 'CHANNEL_ERROR';
	}
}

/**
 * Read `{ watermark, at }` off a response body, or `null` if it is not one.
 *
 * Exported for the test suite: this is the boundary where an unexpected body
 * either becomes a lapsed check or becomes a crash, and it should be the
 * former under every shape a proxy, an error page or a captive portal can
 * produce.
 */
export function readServerRead(body: unknown): ServerRead | null {
	if (typeof body !== 'object' || body === null) return null;
	const record = body as Record<string, unknown>;
	const watermark = record['watermark'];
	const at = record['at'];
	if (typeof watermark !== 'string' || typeof at !== 'string') return null;
	if (parseInstant(at) === null) return null;
	return { watermark, at };
}

/**
 * The one contract, for the whole app.
 *
 * A module-level singleton because AD-29 requires one freshness state and one
 * age across every surface: the Auction page's disabled control and the notice
 * in the layout must be reading the same object, or a Manager could be told the
 * app is Live by one element and Stale by another on the same screen.
 *
 * Safe to import into a server-rendered module: nothing mutates until `start()`
 * runs, `start()` is only ever called from an effect, and effects do not run
 * during SSR. `state` answers `'live'` until then — see `#started`.
 */
export const freshness = new FreshnessContract();
