/**
 * The Discord incoming webhook, as a port plus one `fetch`-backed
 * implementation. Story 5.1, AD-18.
 *
 * **The first real file in `adapters/discord/`**, which AR-2's tree describes
 * as "webhook posts + @mention payloads (allowed_mentions)". That is exactly
 * and only what this module does: it knows the wire shape of a Discord webhook
 * request and nothing about auctions, outbox rows, retries or budgets. What to
 * send and when is `server/outbox.ts`'s; how a Discord request looks is here.
 *
 * **No message composition lives here either.** `content` arrives already
 * built. Story 5.2/5.3 own what a notice SAYS; this story ships the transport
 * and a generic payload, and the one piece of copy in this file is the
 * `<@id>` mention syntax, which is a fact about Discord rather than a fact
 * about the league.
 *
 * **`allowed_mentions` is set on EVERY payload, unconditionally** (AD-18 —
 * "every outbound payload sets `allowed_mentions` explicitly, so no message can
 * mass-ping the league by accident"). It is not conditional on there being
 * mentions: a message with none still sends `parse: []`, because the field's
 * job is to state what MAY ping, and omitting it hands that decision back to
 * Discord's default, which honours `@everyone` in the message text. A generic
 * notice that happened to contain the literal string `@everyone` would then
 * ping thirty people at 3am.
 *
 * **Deno-loadable, like everything the tick reaches** (AD-2): relative `.ts`
 * imports only, no `$env`, no `$lib`, no Node builtin, no bare specifier.
 * `fetch` and the webhook URL are INJECTED rather than read here — the URL is a
 * server-only secret that must never appear behind a `PUBLIC_` name (AD-16),
 * and injecting the transport is what lets `tests/adapters/discord-webhook.test.ts`
 * drive this with a hand-built response and no global patching. There is no
 * `vi.mock` or `vi.stubGlobal` anywhere in this repository and this file does
 * not introduce the need for one — `server/auth.ts`'s `DiscordOAuthPort` is the
 * same pattern.
 *
 * **A 429 is a RESULT, never a throw.** The rate limit is the documented,
 * expected behaviour of a 30-requests-per-minute webhook under a sweep that
 * closed many Auctions at once (AD-18), so it comes back as a typed
 * `rate_limited` carrying `retryAfterMs`. The dispatcher records that on the
 * failed `NotificationDispatched` and waits at least that long; a thrown
 * exception would have lost the number.
 */

/**
 * One outbound webhook message: what it says, and who it is directed at.
 *
 * The two halves are separate all the way to the wire, and that separation is
 * AD-18's muting design (FR-27, Story 5.4) made structural: "muting is
 * implemented as posting the event WITHOUT the mention, so the public record
 * stays complete while the ping is suppressed". Dropping a recipient here
 * leaves `body` byte-identical, so a muted notice and an unmuted one are the
 * same message with and without a ping — not two different messages.
 */
export type DiscordWebhookMessage = {
	/**
	 * What the notice says, with no mention text in it. Composed by the caller;
	 * Story 5.1 sends a generic sentence and 5.2/5.3 own the real copy.
	 */
	readonly body: string;
	/**
	 * Who the notice is directed at — for Discord, `managers.discord_user_id`
	 * snowflakes. Each becomes an `<@id>` at the front of the message AND an
	 * entry in `allowed_mentions.users`, and it takes BOTH to ping: the text
	 * alone renders as plain text unless the id is whitelisted, and the
	 * whitelist alone pings nobody.
	 */
	readonly recipients: readonly string[];
};

/**
 * What one webhook POST amounted to.
 *
 * Three cases rather than a boolean, because `rate_limited` is genuinely
 * different from `failed`: it carries a number the caller must obey, and it is
 * an expected outcome of a burst rather than a sign anything is wrong.
 */
export type DiscordWebhookResult =
	| { readonly kind: 'delivered' }
	| {
			readonly kind: 'rate_limited';
			/** How long Discord asked us to wait, in milliseconds. Never negative. */
			readonly retryAfterMs: number;
			readonly detail: string;
	  }
	| { readonly kind: 'failed'; readonly detail: string };

/**
 * The transport, as `server/outbox.ts` needs it. Injected so a test can make it
 * rate-limit, fail or throw, and so no module outside `adapters/discord/`
 * knows what a Discord request looks like.
 */
export type DiscordWebhookPort = {
	post(message: DiscordWebhookMessage): Promise<DiscordWebhookResult>;
};

/**
 * As much of a `Response` as this module reads, declared structurally.
 *
 * Structural rather than the global `Response` for `server/auth.ts`'s reason
 * (`ProviderIdentity`, `AuthenticatedUser`): the test hands one over built by
 * hand, and this file stays loadable under both runtimes without depending on
 * either's DOM lib. A real `Response` satisfies it.
 */
export type HttpResponse = {
	readonly ok: boolean;
	readonly status: number;
	readonly headers: { get(name: string): string | null };
	text(): Promise<string>;
};

/** As much of `fetch` as this module calls. A real `fetch` satisfies it. */
export type FetchLike = (
	url: string,
	init: {
		readonly method: string;
		readonly headers: Record<string, string>;
		readonly body: string;
	}
) => Promise<HttpResponse>;

/** The `allowed_mentions` object, as Discord's API documents it. */
export type AllowedMentions = {
	/**
	 * Which mention CLASSES may ping. Empty, always: `@everyone`, `@here` and
	 * role mentions are never permitted from this application, so the only
	 * pings that can leave it are the specific user ids listed beside this.
	 */
	readonly parse: readonly string[];
	readonly users: readonly string[];
};

/** The JSON body of one webhook POST. */
export type DiscordWebhookPayload = {
	readonly content: string;
	readonly allowed_mentions: AllowedMentions;
};

/** How long to wait when a 429 arrives with no number we can read. */
export const DEFAULT_RETRY_AFTER_MS = 5_000;

/** Discord's 429. Named rather than inlined, because two places test for it. */
const TOO_MANY_REQUESTS = 429;

/**
 * The `<@id>` mention Discord renders as a ping. AD-18's "a notice directed at
 * a manager carries an @mention of their Discord id, which is what turns the
 * league's public record into a personal push alert".
 *
 * The one piece of Discord's message grammar this application knows, and it
 * lives here because AR-2's tree puts "@mention payloads" in
 * `adapters/discord/`. Nothing in `server/` or `core/` spells it.
 */
export function mentionFor(discordUserId: string): string {
	return `<@${discordUserId}>`;
}

/**
 * The recipients, trimmed, de-duplicated and blank-free, in the order given.
 *
 * De-duplication is not cosmetic: `allowed_mentions.users` is validated by
 * Discord, and a co-managed Team batched into one message can legitimately
 * arrive with the same snowflake twice if two intents for two events share a
 * Manager. One ping per person per message is also simply what a reader
 * expects.
 */
function addressees(message: DiscordWebhookMessage): readonly string[] {
	const users: string[] = [];
	for (const id of message.recipients) {
		const trimmed = id.trim();
		if (trimmed === '' || users.includes(trimmed)) continue;
		users.push(trimmed);
	}
	return users;
}

/**
 * The rendered message text: every recipient's mention, then the body.
 *
 * Mentions lead rather than trail, because Discord's mobile notification
 * preview truncates, and the ping is the part a Manager has to see first to
 * know the notice is about their Team.
 */
export function contentFor(message: DiscordWebhookMessage): string {
	const mentions = addressees(message).map(mentionFor);
	// Trimmed emptiness, not `!== ''`: a body of `'   '` is as absent as one of
	// `''`, and the exact-match filter let it through and rendered a message
	// ending in a stray separator.
	return [...mentions, message.body.trim()].filter((part) => part !== '').join(' ');
}

/**
 * The exact JSON body for one message. Separated from the POST so the payload
 * shape is testable without a transport at all — the same split
 * `adapters/fantrax/pool-file.ts` gets for free by being pure.
 */
export function payloadFor(message: DiscordWebhookMessage): DiscordWebhookPayload {
	return {
		content: contentFor(message),
		// Unconditional, and `parse` is empty even when `users` is: see the
		// module header. This is the one field that stops a message body from
		// deciding who gets pinged.
		allowed_mentions: { parse: [], users: addressees(message) }
	};
}

/**
 * How long to wait after a 429, in milliseconds.
 *
 * Two sources, in order, because Discord populates both and neither is
 * guaranteed: the `Retry-After` header (seconds, possibly fractional) and the
 * JSON body's `retry_after` (also seconds). A value that will not parse, is
 * negative, or is absent falls back to `DEFAULT_RETRY_AFTER_MS` rather than to
 * zero — zero would turn a rate limit into a hot retry loop against the exact
 * endpoint that just asked us to stop.
 *
 * Rounded UP, so the wait is never a millisecond short of what was asked for.
 */
export function retryAfterMsFrom(header: string | null, body: string): number {
	const fromHeader = secondsToMs(header);
	if (fromHeader !== null) return fromHeader;

	const fromBody = secondsToMs(readRetryAfterField(body));
	if (fromBody !== null) return fromBody;

	return DEFAULT_RETRY_AFTER_MS;
}

/** `"1.5"` -> `1500`. `null` for anything not a finite, non-negative number. */
function secondsToMs(value: string | null): number | null {
	if (value === null) return null;
	const seconds = Number(value.trim());
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	return Math.ceil(seconds * 1000);
}

/**
 * `retry_after` off a 429 body, as a string, or `null`.
 *
 * The body is parsed defensively: a rate-limited response is exactly the
 * moment a proxy is most likely to have replaced Discord's JSON with an HTML
 * error page, and a `JSON.parse` throw here would turn a handled rate limit
 * into an unhandled exception.
 */
function readRetryAfterField(body: string): string | null {
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== 'object' || parsed === null) return null;
		const value = (parsed as Record<string, unknown>)['retry_after'];
		if (typeof value === 'number' && Number.isFinite(value)) return String(value);
		if (typeof value === 'string') return value;
		return null;
	} catch {
		return null;
	}
}

/**
 * How much of a response body may reach the event log as `detail`.
 *
 * `server/sweep.ts`'s `MAX_MESSAGE_LENGTH` for the identical reason: the
 * `NotificationDispatched` payload is written on every failed attempt, and an
 * upstream proxy's HTML error page is unbounded. The informative part of a
 * webhook error is always its beginning.
 */
const MAX_DETAIL_LENGTH = 500;

function truncate(text: string): string {
	if (text.length <= MAX_DETAIL_LENGTH) return text;
	return `${text.slice(0, MAX_DETAIL_LENGTH)}… [truncated, ${text.length} characters]`;
}

/**
 * The real port: POST the payload at the webhook URL through the injected
 * `fetch`.
 *
 * **Never throws.** Every outcome — a 2xx, a 429, a 5xx, a DNS failure, an
 * aborted socket — comes back as a `DiscordWebhookResult`, because the caller
 * has to record an attempt for each of them and a thrown transport error would
 * be the one case it could not describe. The dispatcher's own try/catch around
 * this is belt as well as braces, not the mechanism.
 *
 * The URL is a parameter and is never logged or returned in `detail`: a Discord
 * incoming webhook URL IS the credential (AD-16 names it beside the service-role
 * key), and an error string carrying it would put it in `auction_events`, which
 * is the league's audit log.
 */
export function createDiscordWebhookPort(input: {
	readonly webhookUrl: string;
	readonly fetch: FetchLike;
}): DiscordWebhookPort {
	return {
		async post(message: DiscordWebhookMessage): Promise<DiscordWebhookResult> {
			let response: HttpResponse;
			try {
				response = await input.fetch(input.webhookUrl, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payloadFor(message))
				});
			} catch (error) {
				// The webhook was unreachable. Never a throw out of here — the
				// caller must be able to record this attempt like any other.
				return {
					kind: 'failed',
					detail: truncate(
						`the Discord webhook request failed before a response: ${describe(error)}`
					)
				};
			}

			// Read the body ONCE, before branching: `text()` may only be
			// consumed once, and both the 429 path (for `retry_after`) and the
			// failure path (for `detail`) need it.
			let body: string;
			try {
				body = await response.text();
			} catch (error) {
				body = `the response body could not be read: ${describe(error)}`;
			}

			if (response.status === TOO_MANY_REQUESTS) {
				return {
					kind: 'rate_limited',
					retryAfterMs: retryAfterMsFrom(response.headers.get('retry-after'), body),
					detail: truncate(`Discord answered 429: ${body}`)
				};
			}

			if (!response.ok) {
				return {
					kind: 'failed',
					detail: truncate(`Discord answered ${response.status}: ${body}`)
				};
			}

			return { kind: 'delivered' };
		}
	};
}

/** A thrown value's text, without assuming it is an `Error`. */
function describe(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
