/**
 * The Discord webhook adapter: payload shape, `allowed_mentions`, and 429
 * (Story 5.1, AD-18).
 *
 * `tests/adapters/fantrax-pool.test.ts`'s shape — a flattened filename, and
 * assertions driven straight against the adapter with no I/O. The one
 * difference is that this adapter HAS a transport, so `fetch` and the response
 * are handed over by hand. There is no `vi.mock` and no `vi.stubGlobal` here,
 * because there is none anywhere in this repository: `server/auth.ts`'s
 * `DiscordOAuthPort` established injection as how this codebase substitutes a
 * provider, and `tests/auth.test.ts` fakes it the same way.
 */

import { describe, expect, it } from 'vitest';

import {
	DEFAULT_RETRY_AFTER_MS,
	contentFor,
	createDiscordWebhookPort,
	mentionFor,
	payloadFor,
	retryAfterMsFrom
} from '../../src/lib/adapters/discord/webhook.ts';
import type {
	DiscordWebhookPort,
	FetchLike,
	HttpResponse
} from '../../src/lib/adapters/discord/webhook.ts';
import type { NotificationChannelPort } from '../../src/lib/server/outbox.ts';

const WEBHOOK_URL = 'https://discord.example/api/webhooks/1/secret-token';

/** One recorded request, as the fake transport saw it. */
type Recorded = { url: string; method: string; headers: Record<string, string>; body: string };

/**
 * A hand-built `Response`, structurally. Not a real `Response`: the point is
 * that this adapter reads exactly four things off one, and a stub carrying
 * exactly those four is what proves it.
 */
function response(input: {
	status: number;
	body?: string;
	headers?: Record<string, string>;
}): HttpResponse {
	const headers = input.headers ?? {};
	return {
		ok: input.status >= 200 && input.status < 300,
		status: input.status,
		headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
		text: async () => input.body ?? ''
	};
}

/** A transport that records what it was asked to send and answers `answer`. */
function fakeFetch(answer: HttpResponse | (() => never)): {
	fetch: FetchLike;
	sent: Recorded[];
} {
	const sent: Recorded[] = [];
	const fetch: FetchLike = async (url, init) => {
		sent.push({ url, method: init.method, headers: init.headers, body: init.body });
		// `() => never` returns `never`, which is assignable to the response
		// type — so the throwing case needs no separate branch shape.
		if (typeof answer === 'function') return answer();
		return answer;
	};
	return { fetch, sent };
}

function portWith(answer: HttpResponse | (() => never)): {
	port: DiscordWebhookPort;
	sent: Recorded[];
} {
	const { fetch, sent } = fakeFetch(answer);
	return { port: createDiscordWebhookPort({ webhookUrl: WEBHOOK_URL, fetch }), sent };
}

describe('the payload', () => {
	it('always carries allowed_mentions, even with no recipients at all', () => {
		// AD-18: "every outbound payload sets allowed_mentions explicitly, so no
		// message can mass-ping the league by accident". Unconditional is the
		// whole claim — a payload that omitted the field for an unaddressed
		// notice would hand the decision back to Discord's default, which
		// honours @everyone in the message text.
		const payload = payloadFor({ body: 'anything at all', recipients: [] });

		expect(payload.allowed_mentions).toEqual({ parse: [], users: [] });
		expect(Object.keys(payload).sort()).toEqual(['allowed_mentions', 'content']);
	});

	it('leaves parse empty so @everyone, @here and role mentions can never ping', () => {
		// The body deliberately contains the text that would mass-ping if
		// `parse` were absent or permissive.
		const payload = payloadFor({ body: '@everyone @here', recipients: ['111'] });

		expect(payload.allowed_mentions.parse).toEqual([]);
		expect(payload.allowed_mentions.users).toEqual(['111']);
	});

	it('whitelists exactly the recipients the body mentions — both halves, or nobody pings', () => {
		// **Both halves, and since Story 5.3 they meet in the BODY rather than in
		// a prefix.** `server/outbox.ts` composes the `<@id>`s inline, on the
		// notice for each one's own event, and sends here exactly the snowflakes
		// that body spells. This file's remaining job is the whitelist.
		const body = `${mentionFor('111')} — Bulls — Ari no longer hold the leading Bid.`;
		const payload = payloadFor({ body, recipients: ['111', '222'] });

		expect(payload.content).toBe(body);
		expect(payload.allowed_mentions.users).toEqual(['111', '222']);
	});

	it('de-duplicates a recipient and drops blanks', () => {
		// A co-managed Team batched into one message can legitimately arrive
		// with the same snowflake twice — two intents, two events, one Manager.
		const payload = payloadFor({ body: 'a notice', recipients: ['111', ' 111 ', '', '  '] });

		expect(payload.allowed_mentions.users).toEqual(['111']);
		// And the body is untouched: it is composed elsewhere, and de-duping the
		// whitelist must never rewrite what a Manager reads.
		expect(payload.content).toBe('a notice');
	});

	it('never prepends a mention to the head of the message (Story 5.3)', () => {
		// **The property that replaced “mentions lead”.** The drain batches by
		// channel, so one post can cover several events; a Manager pinged at the
		// top of a five-event post cannot tell which line is theirs, and with
		// several links in one body “links directly to the relevant Auction”
		// stops being true. Placement moved to `adapters/discord/mention.ts`;
		// addressing stayed here.
		const content = contentFor({ body: 'the body', recipients: ['9'] });

		expect(content).toBe('the body');
		expect(content).not.toContain(mentionFor('9'));
	});

	it('leaves an already-inline mention exactly where the composer put it', () => {
		const body =
			'Lakers — Meakel bid $14.5M on Anthony Davis.\n' +
			'<@9> — Bulls — Ari no longer hold the leading Bid.';

		expect(contentFor({ body, recipients: ['9'] })).toBe(body);
	});

	it('treats a whitespace-only body as absent, not as a word', () => {
		// Discord rejects an empty `content`, and a body of `'   '` is as absent
		// as one of `''`. Nothing is left to separate it from now that the
		// mentions no longer lead, but the normalisation is still the honest one.
		expect(contentFor({ body: '', recipients: ['9'] })).toBe('');
		expect(contentFor({ body: '   ', recipients: ['9'] })).toBe('');
		expect(contentFor({ body: '\n\t ', recipients: ['9'] })).toBe('');
		expect(payloadFor({ body: '  ', recipients: ['9'] }).content).toBe('');
	});

	it('trims a body that has real content, without eating the content', () => {
		expect(contentFor({ body: '  a notice  ', recipients: ['9'] })).toBe('a notice');
	});
});

describe('the request', () => {
	it('POSTs JSON at the injected webhook URL and answers delivered on 204', async () => {
		const { port, sent } = portWith(response({ status: 204 }));

		const result = await port.post({ body: 'a notice', recipients: ['111'] });

		expect(result).toEqual({ kind: 'delivered' });
		expect(sent).toHaveLength(1);
		expect(sent[0]?.url).toBe(WEBHOOK_URL);
		expect(sent[0]?.method).toBe('POST');
		expect(sent[0]?.headers['content-type']).toBe('application/json');
		expect(JSON.parse(String(sent[0]?.body))).toEqual({
			// The body verbatim: the mention is the composer's now.
			content: 'a notice',
			allowed_mentions: { parse: [], users: ['111'] }
		});
	});
});

describe('a 429 becomes retryAfterMs, never a throw', () => {
	it('reads the Retry-After header, in seconds, rounded up', async () => {
		const { port } = portWith(
			response({ status: 429, headers: { 'retry-after': '1.25' }, body: '{}' })
		);

		const result = await port.post({ body: 'a notice', recipients: ['111'] });

		expect(result.kind).toBe('rate_limited');
		if (result.kind !== 'rate_limited') return;
		expect(result.retryAfterMs).toBe(1250);
	});

	it('falls back to the body’s retry_after when no header is present', async () => {
		const { port } = portWith(
			response({ status: 429, body: JSON.stringify({ retry_after: 2 }) })
		);

		const result = await port.post({ body: 'a notice', recipients: ['111'] });

		expect(result.kind).toBe('rate_limited');
		if (result.kind !== 'rate_limited') return;
		expect(result.retryAfterMs).toBe(2000);
	});

	it('falls back to the default rather than to zero when neither can be read', () => {
		// Zero would turn a rate limit into a hot retry loop against the exact
		// endpoint that just asked us to stop.
		expect(retryAfterMsFrom(null, 'not json at all')).toBe(DEFAULT_RETRY_AFTER_MS);
		expect(retryAfterMsFrom('nonsense', '{}')).toBe(DEFAULT_RETRY_AFTER_MS);
		expect(retryAfterMsFrom('-1', '{}')).toBe(DEFAULT_RETRY_AFTER_MS);
		expect(retryAfterMsFrom(null, JSON.stringify({ retry_after: 'x' }))).toBe(
			DEFAULT_RETRY_AFTER_MS
		);
	});

	it('survives an HTML error page in place of Discord’s JSON', async () => {
		// A 429 is exactly the moment an upstream proxy is most likely to have
		// replaced the JSON body; a JSON.parse throw here would turn a handled
		// rate limit into an unhandled exception.
		const { port } = portWith(response({ status: 429, body: '<html>too many</html>' }));

		const result = await port.post({ body: 'a notice', recipients: ['111'] });

		expect(result.kind).toBe('rate_limited');
		if (result.kind !== 'rate_limited') return;
		expect(result.retryAfterMs).toBe(DEFAULT_RETRY_AFTER_MS);
	});
});

describe('everything else is a failed result, and never a throw', () => {
	it('reports a 5xx with its status and body', async () => {
		const { port } = portWith(response({ status: 503, body: 'service unavailable' }));

		const result = await port.post({ body: 'a notice', recipients: ['111'] });

		expect(result.kind).toBe('failed');
		if (result.kind !== 'failed') return;
		expect(result.detail).toContain('503');
		expect(result.detail).toContain('service unavailable');
	});

	it('reports a transport that threw before any response arrived', async () => {
		const { port } = portWith(() => {
			throw new Error('getaddrinfo ENOTFOUND discord.example');
		});

		const result = await port.post({ body: 'a notice', recipients: ['111'] });

		expect(result.kind).toBe('failed');
		if (result.kind !== 'failed') return;
		expect(result.detail).toContain('ENOTFOUND');
	});

	it('never puts the webhook URL in a detail that will reach the event log', async () => {
		// The incoming webhook URL IS the credential (AD-16 names it beside the
		// service-role key), and `detail` is written into `auction_events`,
		// which is the league's audit log.
		const { port } = portWith(() => {
			throw new Error('boom');
		});

		const result = await port.post({ body: 'a notice', recipients: ['111'] });

		expect(result.kind).toBe('failed');
		if (result.kind !== 'failed') return;
		expect(result.detail).not.toContain('secret-token');
		expect(result.detail).not.toContain(WEBHOOK_URL);
	});

	it('truncates an unbounded body rather than writing all of it to the log', async () => {
		const { port } = portWith(response({ status: 500, body: 'x'.repeat(5000) }));

		const result = await port.post({ body: 'a notice', recipients: ['111'] });

		expect(result.kind).toBe('failed');
		if (result.kind !== 'failed') return;
		expect(result.detail.length).toBeLessThan(700);
		expect(result.detail).toContain('truncated');
	});
});

describe('the port satisfies the dispatcher’s port', () => {
	it('is assignable to NotificationChannelPort, so the two declarations cannot drift', () => {
		// `server/outbox.ts` declares what it needs from a transport rather than
		// importing Discord's own type, so it carries no notion of Discord at
		// all — `server/auth.ts`'s `DiscordOAuthPort` pattern. This assignment
		// is the compile-time proof that the adapter still satisfies it; it goes
		// red under `npm run check` the moment either side changes shape.
		const { fetch } = fakeFetch(response({ status: 204 }));
		const channel: NotificationChannelPort = createDiscordWebhookPort({
			webhookUrl: WEBHOOK_URL,
			fetch
		});

		expect(typeof channel.post).toBe('function');
	});
});
