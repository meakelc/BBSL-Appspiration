import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FRESHNESS_WINDOW, LIVENESS_INTERVAL, STALE_WINDOW } from '../src/lib/core/constants.ts';
import {
	FRESHNESS_HEADINGS,
	FRESHNESS_STATEMENTS,
	MAXIMUM_BID_LABELS,
	STALE_ANNOUNCEMENT,
	STALE_BID_REASON,
	STALE_NOMINATION_REASON,
	deriveFreshness,
	figuresAgeSentence
} from '../src/lib/core/freshness.ts';
import type { ChannelStatus, FreshnessState } from '../src/lib/core/freshness.ts';
import { formatInstant, parseInstant } from '../src/lib/core/instant.ts';
import {
	FreshnessContract,
	freshness,
	readServerRead
} from '../src/lib/client/freshness.svelte.ts';
import type { FreshnessPorts } from '../src/lib/client/freshness.svelte.ts';

/**
 * Neither Supabase project is provisioned, so both public variables are empty —
 * which is exactly the state a deployed client is in today. Substituted rather
 * than left to whatever the environment happens to hold, so the degradation
 * below is driven deliberately.
 */
vi.mock('$env/dynamic/public', () => ({ env: {} }));

/**
 * The three-state derivation, every row of Story 4.1's I/O matrix, and the
 * negation the whole contract turns on.
 *
 * Realtime itself cannot be exercised here — the suite runs in a node
 * environment with no DOM, and no `.svelte` file is renderable under this
 * vite config — so the socket is proven by the same means every other markup
 * claim in this repository is: the source text of the files that wire it.
 * `deriveFreshness` is where all the behaviour actually lives, and it is pure,
 * so all of it is driven directly below.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');

/** An instant `ms` after the epoch anchor below, so ages are stated in ms. */
const ANCHOR = parseInstant('2026-09-01T12:00:00.000Z') ?? 0;
const at = (ms: number): string => formatInstant(ANCHOR + ms);

/** `deriveFreshness` with the anchor as the last successful check. */
function stateAfter(ageMs: number, channel: ChannelStatus): FreshnessState {
	return deriveFreshness({ channel, lastLivenessOkAt: at(0), now: at(ageMs) });
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('the I/O matrix, row by row', () => {
	it('Live — SUBSCRIBED and a liveness check 5s ago', () => {
		expect(stateAfter(5 * SECOND, 'SUBSCRIBED')).toBe('live');
	});

	it('Quiet auction — six hours with no event never degrades on its own', () => {
		// THE invariant, and it is a negation: nothing in a diff shows it
		// holding. This league runs as a relay of timezone clusters and six
		// quiet hours at 4am Pacific is a HEALTHY auction — which is exactly
		// why the League Clock is 48 hours. A client that read silence as
		// staleness would disable bidding across every quiet stretch of the
		// night.
		//
		// The proof is structural as well as behavioural: six hours of silence
		// is simulated by advancing NOTHING except the wall clock while the
		// liveness check keeps succeeding, because there is no watermark, no
		// event count and no "last message received" among `deriveFreshness`'s
		// inputs at all. Silence is not representable as an input, which is the
		// strongest form this guarantee can take.
		for (let elapsed = 0; elapsed <= 6 * HOUR; elapsed += 15 * MINUTE) {
			// The check keeps succeeding: `lastLivenessOkAt` tracks `now`, which
			// is what a poll returning 200 every ten seconds actually does.
			const stillLive = deriveFreshness({
				channel: 'SUBSCRIBED',
				lastLivenessOkAt: at(elapsed),
				now: at(elapsed + 5 * SECOND)
			});
			expect(stillLive, `at ${String(elapsed / HOUR)}h of silence`).toBe('live');
		}
	});

	it('Channel silently dead — SUBSCRIBED but the last check was 45s ago', () => {
		// supabase/realtime#1414: a channel can report SUBSCRIBED while
		// delivering nothing. The positive check is what closes that gap, and
		// it must be able to degrade a channel that still claims to be up.
		expect(stateAfter(45 * SECOND, 'SUBSCRIBED')).toBe('reconnecting');
	});

	it('Channel dropped — every failure status degrades even with a fresh check', () => {
		for (const channel of ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'] as const) {
			expect(stateAfter(5 * SECOND, channel), channel).toBe('reconnecting');
		}
	});

	it('Stale — no successful liveness check within STALE_WINDOW, channel notwithstanding', () => {
		// Stale is decided BEFORE the channel is consulted, so a socket still
		// reporting SUBSCRIBED cannot hold a client out of Stale.
		expect(stateAfter(STALE_WINDOW, 'SUBSCRIBED')).toBe('stale');
		expect(stateAfter(STALE_WINDOW, 'CLOSED')).toBe('stale');
		expect(stateAfter(10 * MINUTE, 'SUBSCRIBED')).toBe('stale');
	});

	it('Recovery — Stale returns to Live the moment both halves hold again', () => {
		const stale = deriveFreshness({
			channel: 'CLOSED',
			lastLivenessOkAt: at(0),
			now: at(5 * MINUTE)
		});
		expect(stale).toBe('stale');

		// A successful check at 5 minutes, judged a second later: the window is
		// measured from the LAST SUCCESS, so recovery is immediate rather than
		// requiring the outage to be "worked off".
		const recovered = deriveFreshness({
			channel: 'SUBSCRIBED',
			lastLivenessOkAt: at(5 * MINUTE),
			now: at(5 * MINUTE + SECOND)
		});
		expect(recovered).toBe('live');
	});

	it('Empty log — the watermark plays no part in the derivation at all', () => {
		// The AC's "empty log -> watermark '0', freshness derives normally".
		// There is nowhere in `FreshnessInput` to put a watermark, so an empty
		// log cannot affect this; the assertion records that as intended rather
		// than accidental.
		expect(stateAfter(SECOND, 'SUBSCRIBED')).toBe('live');
		expect(Object.keys({ channel: 1, lastLivenessOkAt: 1, now: 1 })).toHaveLength(3);
	});
});

describe('the window boundaries', () => {
	it('degrades AT FRESHNESS_WINDOW, not after it', () => {
		expect(stateAfter(FRESHNESS_WINDOW - 1, 'SUBSCRIBED')).toBe('live');
		expect(stateAfter(FRESHNESS_WINDOW, 'SUBSCRIBED')).toBe('reconnecting');
	});

	it('goes Stale AT STALE_WINDOW, not after it', () => {
		expect(stateAfter(STALE_WINDOW - 1, 'SUBSCRIBED')).toBe('reconnecting');
		expect(stateAfter(STALE_WINDOW, 'SUBSCRIBED')).toBe('stale');
	});

	it('keeps one missed poll Live and two not — the interval is chosen against the window', () => {
		// LIVENESS_INTERVAL exists to be checked against FRESHNESS_WINDOW, not
		// picked. One missed poll leaves the last success two intervals old;
		// two consecutive misses put it at three, which crosses.
		expect(stateAfter(2 * LIVENESS_INTERVAL, 'SUBSCRIBED')).toBe('live');
		expect(stateAfter(3 * LIVENESS_INTERVAL, 'SUBSCRIBED')).toBe('reconnecting');
		expect(STALE_WINDOW / LIVENESS_INTERVAL).toBeGreaterThanOrEqual(6);
	});

	it('reads a clock skewed backwards as zero age, never as negative', () => {
		// `now` earlier than the last check — an out-of-order re-anchor, or a
		// device whose system time was adjusted backward. Clamped, so a page
		// cannot be pulled behind a check it already confirmed.
		const skewed = deriveFreshness({
			channel: 'SUBSCRIBED',
			lastLivenessOkAt: at(10 * MINUTE),
			now: at(0)
		});
		expect(skewed).toBe('live');
	});
});

describe('an unreadable instant', () => {
	it('is Reconnecting — never Live, and never Stale', () => {
		// Never Live: nothing has been confirmed inside any window. Never
		// Stale: no window has been MEASURED, and disabling every bid and
		// nomination control in the league on a string that failed to parse
		// would be the worst possible response to the least meaningful
		// possible failure.
		for (const bad of ['', 'nonsense', '2026-13-45T99:99:99Z']) {
			expect(
				deriveFreshness({ channel: 'SUBSCRIBED', lastLivenessOkAt: bad, now: at(0) }),
				`lastLivenessOkAt=${bad}`
			).toBe('reconnecting');
			expect(
				deriveFreshness({ channel: 'SUBSCRIBED', lastLivenessOkAt: at(0), now: bad }),
				`now=${bad}`
			).toBe('reconnecting');
		}
	});
});

describe('the sentences, which live in the core and nowhere else', () => {
	it('says nothing at all while Live', () => {
		// AD-29: announcing "live" constantly is noise. There is no heading and
		// no statement to render, so the notice cannot draw a reassurance.
		expect(FRESHNESS_HEADINGS.live).toBeNull();
		expect(FRESHNESS_STATEMENTS.live).toBeNull();
	});

	it('states the condition and what still holds, in both degraded states', () => {
		for (const state of ['reconnecting', 'stale'] as const) {
			const statement = FRESHNESS_STATEMENTS[state] ?? '';
			expect(statement, state).not.toBe('');
			// Countdowns are exempt from freshness and keep running; saying so
			// is what stops a Manager reading a degraded banner as "the clock
			// has stopped".
			expect(statement, `${state} names the countdowns`).toContain('countdowns are still running');
			// No advice to refresh: the client re-reads on an interval and
			// reloads itself, and telling a Manager to do by hand what the app
			// does automatically is telling them to distrust the app.
			expect(statement.toLowerCase(), `${state} advises a refresh`).not.toContain('refresh');
		}
	});

	it('names the disabling in the Stale statement and in neither other state', () => {
		expect(FRESHNESS_STATEMENTS.stale).toContain('disabled');
		expect(FRESHNESS_STATEMENTS.reconnecting).not.toContain('disabled');
	});

	it('gives each control its own reason, each stating the act it refuses', () => {
		expect(STALE_BID_REASON).toContain('Bidding is disabled');
		expect(STALE_NOMINATION_REASON).toContain('Nominating is disabled');
		// Each also states the reassurance its own Manager needs.
		expect(STALE_BID_REASON).toContain('Nothing about this Auction has changed');
		expect(STALE_NOMINATION_REASON).toContain('Slot has not been spent');
	});

	it('has one announcement, for the Stale transition, and none for recovery', () => {
		expect(STALE_ANNOUNCEMENT).toContain('stopped reaching the server');
		// There is deliberately no RECOVERY_ANNOUNCEMENT to import: recovery is
		// silent, and the absence is the mechanism.
		const source = read('src', 'lib', 'core', 'freshness.ts');
		expect(source).not.toMatch(/RECOVERY_ANNOUNCEMENT|LIVE_ANNOUNCEMENT/);
	});

	it('labels Maximum Bid last-known in every non-Live state and plainly in Live', () => {
		expect(MAXIMUM_BID_LABELS.live).toBe('Maximum Bid');
		expect(MAXIMUM_BID_LABELS.reconnecting).toContain('last known');
		expect(MAXIMUM_BID_LABELS.stale).toContain('last known');
	});

	it('renders the age through `relativePhrase`, never a second implementation', () => {
		expect(figuresAgeSentence(at(0), at(2 * MINUTE))).toBe(
			'These figures were last confirmed 2 minutes ago.'
		);
		expect(figuresAgeSentence(at(0), at(30 * SECOND))).toContain('moments ago');
		// An unreadable instant states "at an unknown time" rather than
		// throwing — the rendering helper's own discipline, inherited.
		expect(figuresAgeSentence('nonsense', at(0))).toContain('at an unknown time');
	});
});

describe('the derivation is pure and the rule lives in one place', () => {
	it('reads no clock, no channel object and no network', () => {
		const source = read('src', 'lib', 'core', 'freshness.ts');
		// The purity gate proves this for the whole core; asserting it here
		// records that THIS module's purity is load-bearing rather than
		// incidental — `now` is injected precisely so the six-hour case above
		// can be driven without waiting six hours.
		expect(source).not.toMatch(/\bDate\b|setInterval|fetch\(|createClient/);
		expect(source).not.toMatch(/from '\$lib/);
	});

	it('is the only place the two windows are compared to anything', () => {
		// A `.svelte` file or the client module asking "has it been two
		// minutes?" would be a second derivation of the one question AD-29
		// fixes. The constants are imported by the core module and by the tests
		// that check them, and by nothing that renders.
		for (const path of [
			['src', 'lib', 'client', 'freshness.svelte.ts'],
			['src', 'lib', 'components', 'FreshnessNotice.svelte'],
			['src', 'routes', 'auction', '[fantraxPlayerId]', '+page.svelte'],
			['src', 'routes', 'nominate', '+page.svelte']
		]) {
			const source = read(...path);
			expect(source, `${path.join('/')} compares a window itself`).not.toMatch(
				/FRESHNESS_WINDOW|STALE_WINDOW/
			);
		}
	});
});

describe('the client module degrades and never crashes', () => {
	it('refuses a body that is not `{ watermark, at }` rather than trusting it', () => {
		expect(readServerRead({ watermark: '7', at: at(0) })).toEqual({ watermark: '7', at: at(0) });
		// Every shape a proxy, an error page or a captive portal can produce.
		for (const bad of [
			null,
			undefined,
			'a string',
			42,
			{},
			{ watermark: 7, at: at(0) },
			{ watermark: '7' },
			{ watermark: '7', at: 'nonsense' }
		]) {
			expect(readServerRead(bad), JSON.stringify(bad) ?? 'undefined').toBeNull();
		}
	});

	it('degrades to Reconnecting on an unopenable socket, and throws nothing', () => {
		// The production case today, driven rather than read: with no project to
		// connect to, `start()` must record a channel error and carry on. The
		// same path covers a CSP refusal, since both arrive as "the socket could
		// not be opened".
		freshness.observeServerRead({ watermark: '5', at: at(0) });
		expect(() => {
			freshness.start();
		}).not.toThrow();
		expect(freshness.channel).toBe('CHANNEL_ERROR');
		expect(freshness.state).toBe('reconnecting');
		// It is not Stale, and cannot become Stale on the socket's account: the
		// same-origin poll is what moves `lastLivenessOkAt`, and the blocked
		// socket never touches it.
		expect(freshness.lastLivenessOkAt).toBe(at(0));
		expect(freshness.watermark).toBe('5');

		expect(() => {
			freshness.stop();
		}).not.toThrow();
	});

	it('is a singleton, so every surface reads one state and one age', () => {
		const source = read('src', 'lib', 'client', 'freshness.svelte.ts');
		expect(source).toContain('export const freshness = new FreshnessContract()');
	});

	it('treats a blocked socket and an unset project as a channel error, not a throw', () => {
		const source = read('src', 'lib', 'client', 'freshness.svelte.ts');
		// The production case today: `connect-src 'self'` refuses the socket and
		// neither project is provisioned, so `PUBLIC_SUPABASE_URL` is empty.
		// Both must land on CHANNEL_ERROR, which derives Reconnecting, while the
		// same-origin poll keeps working — so the client never reaches Stale on
		// that account.
		expect(source).toContain("this.channel = 'CHANNEL_ERROR'");
		expect(source).toMatch(/try\s*\{[\s\S]*createBrowserClient/);
		expect(source).toMatch(/catch\s*\{/);
		// Every promise is voided or caught: an unhandled rejection is the one
		// way a freshness monitor could take a page down with it.
		expect(source).not.toMatch(/^\s*(await )?invalidateAll\(\);\s*$/m);
	});

	it('moves `lastLivenessOkAt` only on a successful read, never on silence', () => {
		const source = read('src', 'lib', 'client', 'freshness.svelte.ts');
		// Exactly one assignment ADVANCES it — `observeServerRead`, reached only
		// from the layout's server data and from a 200 response. Nothing in the
		// channel handler touches it: a pushed message is not the liveness
		// question, and its absence is not an answer. `stop()`'s reset to `''`
		// is the only other assignment and is counted separately, because
		// clearing a torn-down contract is not a liveness claim.
		const advances = source.match(/this\.lastLivenessOkAt = read\.at/g) ?? [];
		expect(advances).toHaveLength(1);

		const all = source.match(/this\.lastLivenessOkAt = [^;]+/g) ?? [];
		expect(all).toHaveLength(2);
		expect(all[1]).toBe("this.lastLivenessOkAt = ''");
	});

	it('holds no write path — it subscribes, polls and reloads (AD-9)', () => {
		const source = read('src', 'lib', 'client', 'freshness.svelte.ts');
		expect(source).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(|method: 'POST'/);
	});

	it('subscribes to the watermark row and to no other table', () => {
		const source = read('src', 'lib', 'client', 'freshness.svelte.ts');
		expect(source).toContain("const WATERMARK_TABLE = 'auction_watermark'");
		expect(source).not.toContain('auction_events');
	});

	it('derives the socket host from PUBLIC_SUPABASE_URL and writes no host down', () => {
		const source = read('src', 'lib', 'client', 'freshness.svelte.ts');
		expect(source).toContain("env['PUBLIC_SUPABASE_URL']");
		expect(source).not.toMatch(/supabase\.co|wss:\/\//);
	});
});

describe('the surfaces join the existing disabled-reason path', () => {
	const auction = read('src', 'routes', 'auction', '[fantraxPlayerId]', '+page.svelte');
	const nominate = read('src', 'routes', 'nominate', '+page.svelte');
	const notice = read('src', 'lib', 'components', 'FreshnessNotice.svelte');
	const layout = read('src', 'routes', '+layout.svelte');

	it('disables the bid control in Stale, with the core’s reason', () => {
		expect(auction).toContain("freshness.state === 'stale'");
		expect(auction).toContain('typed.blocked || staleBlocked');
		expect(auction).toContain('STALE_BID_REASON');
	});

	it('disables the Nomination control in Stale, with the core’s reason', () => {
		expect(nominate).toContain("freshness.state === 'stale'");
		expect(nominate).toContain('|| staleBlocked');
		expect(nominate).toContain('STALE_NOMINATION_REASON');
	});

	it('labels Maximum Bid from the core, per state, rather than hard-coding it', () => {
		expect(auction).toContain('MAXIMUM_BID_LABELS[freshness.state]');
		// The bare label is gone from the markup — a second, unlabelled copy
		// would be the one a stale page rendered.
		expect(auction).not.toContain('<p class="section-label">Maximum Bid</p>');
	});

	it('leaves the countdown untouched — it is anchored on the close instant, not on freshness', () => {
		// AD-29 exempts countdowns: they derive from absolute close timestamps
		// the client already holds, so freezing them on disconnect would invent
		// a problem. `closesInPhrase` and `hasExpired` must still read `nowIso`,
		// which is anchored on the server's `figuresAt`, and not the freshness
		// state.
		expect(auction).toContain('closesInPhrase(auction.closesAt, nowIso)');
		expect(auction).toContain('hasExpired(auction.closesAt, nowIso)');
		expect(auction).not.toMatch(/closesIn[\s\S]{0,80}freshness/);
	});

	it('words none of it itself — every sentence comes from `core/freshness.ts`', () => {
		const markup = notice.replace(/^\s*\/\/.*$/gm, '');
		expect(markup).not.toMatch(/last confirmed|disabled until/);
		expect(notice).toContain('FRESHNESS_STATEMENTS');
		expect(notice).toContain('figuresAgeSentence');
	});

	it('announces the Stale transition assertively and renders nothing on recovery', () => {
		expect(notice).toContain('role="alert"');
		expect(notice).toContain("state === 'stale'");
		// The live region is always in the DOM and EMPTY otherwise: a region
		// inserted with its content is not reliably announced, and an empty one
		// announces nothing, which is the required silence on recovery.
		expect(notice).toMatch(/<div role="alert"[\s\S]*\{#if state === 'stale'\}/);
		// Nothing renders at all while Live.
		expect(notice).toContain('heading !== null && statement !== null');
	});

	it('mounts once, in the layout, so every surface reads one state and one age', () => {
		expect(layout).toContain('<FreshnessNotice');
		expect(layout).toContain('freshness.start()');
		expect(layout).toContain('freshness.stop()');
		expect(layout).toContain('freshness.observeServerRead');
		expect(layout).toContain('{@render children()}');
	});
});

describe('the watermark rides on the one load every page inherits', () => {
	it('is exposed alongside the server instant, from `locals`', () => {
		const layoutServer = read('src', 'routes', '+layout.server.ts');
		expect(layoutServer).toContain('watermark: locals.watermark');
		expect(layoutServer).toContain('serverInstant: serverInstant()');
	});

	it('has no per-table stamp anywhere — one watermark, one source', () => {
		// AD-29's "not a per-table stamp". The only `watermark` a load returns
		// is the one from `locals`, folded once per request in hooks.server.ts.
		const hooks = read('src', 'hooks.server.ts');
		expect(hooks).toContain('event.locals.watermark = read.watermark');
		const loads = hooks.match(/resolveLeagueReadOrDefault\(/g) ?? [];
		expect(loads).toHaveLength(1);
	});
});

/**
 * The poll and the channel, DRIVEN — not read.
 *
 * Review round 1 found two bugs here that every source-text assertion in this
 * file was blind to: `#poll` could never reload (`observeServerRead` raised the
 * watermark before the raise decision was taken, so the guard always returned
 * first), and a higher `seq` arriving during an in-flight reload was swallowed.
 * Both are behaviour, and behaviour is what the tests below assert.
 *
 * `FreshnessContract` takes four ports with real defaults, so a test substitutes
 * `fetch`, `createClient`, `credentials` and `reload` and drives the private
 * paths through the public surface. No DOM and no socket are involved.
 */

/** A `Response`-shaped stub. Only what the poll reads. */
function jsonResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body
	} as unknown as Response;
}

/** Captures the two callbacks the channel is wired with, for direct invocation. */
function channelSpy() {
	const captured: {
		push?: (payload: { new?: Record<string, unknown> }) => void;
		status?: (status: string) => void;
	} = {};
	const channel = {
		on(_event: string, _filter: unknown, handler: typeof captured.push) {
			captured.push = handler;
			return channel;
		},
		subscribe(handler: typeof captured.status) {
			captured.status = handler;
			return channel;
		}
	};
	const client = { channel: () => channel, removeChannel: () => undefined };
	return { captured, client };
}

function contractWith(ports: FreshnessPorts): FreshnessContract {
	return new FreshnessContract({
		credentials: () => ({ url: 'https://example.test', key: 'anon-key' }),
		...ports
	});
}

const reading = (watermark: string, at: string) => ({ watermark, at });
const AT = '2026-09-01T12:00:00.000Z';

describe('the poll, driven', () => {
	/**
	 * Runs `start()` and lets the interval fire exactly once.
	 *
	 * It deliberately does NOT call `stop()`: `stop()` clears every field the
	 * assertions below are about — that is patch 9 working as intended — so
	 * tearing down here would make every one of them read the reset state
	 * instead of the polled one. Each test stops the contract itself, after it
	 * has read what it came for.
	 */
	async function pollOnce(contract: FreshnessContract): Promise<void> {
		vi.useFakeTimers();
		try {
			contract.start();
			await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL + 1);
		} finally {
			vi.useRealTimers();
		}
	}

	it('reloads when the watermark it read is higher than the one held', async () => {
		let reloads = 0;
		const contract = contractWith({
			fetch: async () => jsonResponse(200, reading('9', AT)),
			reload: async () => {
				reloads += 1;
			}
		});
		contract.observeServerRead(reading('4', AT));

		await pollOnce(contract);

		// The regression guard for review finding 2. Against the original
		// ordering this is 0, because the raise returned before the reload.
		expect(reloads).toBe(1);
		contract.stop();
	});

	it('does not reload when the watermark has not moved', async () => {
		let reloads = 0;
		const contract = contractWith({
			fetch: async () => jsonResponse(200, reading('4', AT)),
			reload: async () => {
				reloads += 1;
			}
		});
		contract.observeServerRead(reading('4', AT));

		await pollOnce(contract);

		expect(reloads).toBe(0);
		contract.stop();
	});

	it('advances the liveness stamp on a 200', async () => {
		const later = '2026-09-01T12:00:30.000Z';
		const contract = contractWith({
			fetch: async () => jsonResponse(200, reading('4', later))
		});
		contract.observeServerRead(reading('4', AT));

		await pollOnce(contract);

		expect(contract.lastLivenessOkAt).toBe(later);
		contract.stop();
	});

	it.each([
		['401 — signed out', 401],
		['503 — the database could not be read', 503]
	])('treats %s as a lapsed check: no reload, no advance, no throw', async (_label, status) => {
		let reloads = 0;
		const contract = contractWith({
			fetch: async () => jsonResponse(status as number, { detail: 'refused' }),
			reload: async () => {
				reloads += 1;
			}
		});
		contract.observeServerRead(reading('4', AT));

		await pollOnce(contract);

		expect(reloads).toBe(0);
		// Unmoved: a refusal is not evidence the server was reached usefully,
		// so the state must go on degrading on schedule.
		expect(contract.lastLivenessOkAt).toBe(AT);
		contract.stop();
	});

	it('treats a thrown fetch as a lapsed check rather than a crash', async () => {
		const contract = contractWith({
			fetch: async () => {
				throw new Error('network down');
			}
		});
		contract.observeServerRead(reading('4', AT));

		await pollOnce(contract);

		expect(contract.lastLivenessOkAt).toBe(AT);
		contract.stop();
	});

	it('ignores a body that is not a well-formed reading', async () => {
		let reloads = 0;
		const contract = contractWith({
			fetch: async () => jsonResponse(200, { watermark: 12, at: null }),
			reload: async () => {
				reloads += 1;
			}
		});
		contract.observeServerRead(reading('4', AT));

		await pollOnce(contract);

		expect(reloads).toBe(0);
		expect(contract.watermark).toBe('4');
		contract.stop();
	});
});

describe('the channel callbacks, invoked directly', () => {
	it('raises the watermark and reloads on a pushed row', () => {
		let reloads = 0;
		const { captured, client } = channelSpy();
		const contract = contractWith({
			createClient: () => client as never,
			reload: async () => {
				reloads += 1;
			}
		});
		contract.observeServerRead(reading('4', AT));
		contract.start();

		captured.push?.({ new: { seq: 11 } });

		expect(contract.watermark).toBe('11');
		expect(reloads).toBe(1);
		contract.stop();
	});

	it('ignores a push that does not carry a higher seq', () => {
		let reloads = 0;
		const { captured, client } = channelSpy();
		const contract = contractWith({
			createClient: () => client as never,
			reload: async () => {
				reloads += 1;
			}
		});
		contract.observeServerRead(reading('9', AT));
		contract.start();

		captured.push?.({ new: { seq: 4 } });
		captured.push?.({});

		expect(contract.watermark).toBe('9');
		expect(reloads).toBe(0);
		contract.stop();
	});

	it('never lets a throw inside the push handler escape into the socket', () => {
		const { captured, client } = channelSpy();
		const contract = contractWith({
			createClient: () => client as never
		});
		contract.start();

		expect(() => {
			captured.push?.({
				get new(): Record<string, unknown> {
					throw new Error('malformed payload');
				}
			});
		}).not.toThrow();
		contract.stop();
	});

	it.each([
		['SUBSCRIBED', 'SUBSCRIBED'],
		['CHANNEL_ERROR', 'CHANNEL_ERROR'],
		['TIMED_OUT', 'TIMED_OUT'],
		['CLOSED', 'CLOSED'],
		// Anything this codebase does not understand has NOT reported itself
		// subscribed, and Live requires a positive SUBSCRIBED.
		['SOMETHING_NEW', 'CHANNEL_ERROR']
	])('maps the status %s to %s', (status, expected) => {
		const { captured, client } = channelSpy();
		const contract = contractWith({ createClient: () => client as never });
		contract.start();

		captured.status?.(status as string);

		expect(contract.channel).toBe(expected);
		contract.stop();
	});

	it('degrades to CHANNEL_ERROR when the client cannot be built at all', () => {
		const contract = contractWith({
			createClient: () => {
				throw new Error('blocked by Content-Security-Policy');
			}
		});

		expect(() => {
			contract.start();
		}).not.toThrow();
		expect(contract.channel).toBe('CHANNEL_ERROR');
		contract.stop();
	});
});

describe('a raise arriving while a reload is in flight', () => {
	it('is not swallowed — the newer seq gets its own reload', async () => {
		const seen: string[] = [];
		let release: (() => void) | null = null;
		const { captured, client } = channelSpy();
		const contract = contractWith({
			createClient: () => client as never,
			reload: () => {
				seen.push(contract.watermark);
				return new Promise<void>((resolve) => {
					release = resolve;
				});
			}
		});
		contract.observeServerRead(reading('1', AT));
		contract.start();

		captured.push?.({ new: { seq: 2 } });
		// Still in flight. The regression guard for review finding 3: the older
		// code bumped the watermark and returned, so this seq reloaded nothing.
		captured.push?.({ new: { seq: 3 } });

		(release as unknown as () => void)?.();
		await vi.waitFor(() => {
			expect(seen).toHaveLength(2);
		});
		expect(seen).toEqual(['2', '3']);
		contract.stop();
	});
});
