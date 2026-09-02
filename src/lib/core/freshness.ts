/**
 * The three-state freshness derivation, and the sentences the surfaces print
 * for it (AD-29, Story 4.1).
 *
 * **The whole rule is `deriveFreshness` and nothing else in the codebase may
 * re-state any part of it.** A `.svelte` file asking "is the channel down?" or
 * "has it been two minutes?" would be a second derivation of the one question
 * AD-29 fixes, in the file furthest from the constants that answer it. The
 * client module owns the channel object, the timer and the network; it owns no
 * part of the decision, and it hands this function three plain values.
 *
 * **`now` is injected, and nothing here reads a clock** (AD-1, AD-3). The
 * caller anchors `now` on a server instant plus locally measured elapsed time,
 * exactly as the Auction page anchors its countdown — a device whose wall clock
 * is three hours fast must not read a fresh page as stale.
 *
 * **Silence is not staleness.** No watermark, no event count and no "last
 * message received" appears anywhere in this file's inputs, and that absence is
 * the point: this league has genuinely quiet six-hour stretches at 4am Pacific,
 * and a client that conflated "nothing changed" with "cannot reach the server"
 * would disable bidding all night. The only positive evidence this function
 * accepts is the instant of the last successful liveness re-read.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { FRESHNESS_WINDOW, STALE_WINDOW } from './constants.ts';
import { parseInstant, relativePhrase } from './instant.ts';

/**
 * What the Realtime channel last reported about itself.
 *
 * The four uppercase literals are Supabase's own `subscribe` callback statuses,
 * spelled verbatim so a caller passes the value it was handed rather than
 * translating it. `CONNECTING` is this codebase's own addition and covers the
 * window between building the channel and the first callback firing — a
 * channel that has not yet said it is subscribed has not said it is, and
 * inventing `SUBSCRIBED` for that gap would make a page claim Live before it
 * had any grounds to.
 */
export type ChannelStatus =
	| 'SUBSCRIBED'
	| 'CHANNEL_ERROR'
	| 'TIMED_OUT'
	| 'CLOSED'
	| 'CONNECTING';

/** Exactly one of these is always true of a client (AD-29). */
export type FreshnessState = 'live' | 'reconnecting' | 'stale';

/** The three facts the derivation reads, and the only three. */
export type FreshnessInput = {
	/** What the channel last reported. */
	readonly channel: ChannelStatus;
	/**
	 * The instant of the last liveness re-read that SUCCEEDED, ISO-8601 UTC.
	 *
	 * Never null: it is seeded from the server instant the page was rendered
	 * at, so a freshly loaded page is never born Stale. A failed re-read does
	 * not move it — that is what makes the window elapse.
	 */
	readonly lastLivenessOkAt: string;
	/** The instant to judge it against, ISO-8601 UTC. Injected (AD-3). */
	readonly now: string;
};

/**
 * The age of the last successful liveness check, in milliseconds, or `null`
 * when either instant cannot be read.
 *
 * Clamped at zero. A negative age means `now` is earlier than the last
 * successful check — a re-anchor arriving out of order, or a backward clock
 * adjustment — and "less than no time has passed" is not a thing this
 * derivation has an answer for. Zero is.
 */
function livenessAgeMs(input: FreshnessInput): number | null {
	const then = parseInstant(input.lastLivenessOkAt);
	const current = parseInstant(input.now);
	if (then === null || current === null) return null;
	return Math.max(0, current - then);
}

/**
 * The one derivation. Total: it always returns one of the three states.
 *
 * **The order is deliberate and is itself the rule.**
 *
 *   1. **Stale first**, so a channel still reporting `SUBSCRIBED` while
 *      delivering nothing still degrades. AD-29 requires insufficiency in both
 *      directions, and a channel-first ordering would let a silently dead
 *      socket hold a page at Live indefinitely
 *      (supabase/realtime#1414 is that failure, observed in the wild).
 *   2. **Then the channel**, so a reported `CHANNEL_ERROR` / `TIMED_OUT` /
 *      `CLOSED` degrades to Reconnecting even while the same-origin poll is
 *      still succeeding. That is exactly the production case today: the socket
 *      is blocked by `connect-src 'self'`, the poll is not, and the honest
 *      answer is Reconnecting rather than Live.
 *   3. **Then the lapsed check**, so one missed poll inside `FRESHNESS_WINDOW`
 *      is not treated as a fault and two are.
 *   4. **Live last**, reached only when the channel says it is subscribed AND a
 *      positive check succeeded inside the window. Both, together — never
 *      either alone.
 *
 * An instant that cannot be read yields `reconnecting`. It cannot be Live: no
 * check has been confirmed inside any window. It must not be Stale either: no
 * window has been MEASURED, and disabling every bid and nomination control in
 * the league on a string that failed to parse would be the most damaging
 * possible response to the least meaningful possible failure.
 */
export function deriveFreshness(input: FreshnessInput): FreshnessState {
	const age = livenessAgeMs(input);
	if (age === null) return 'reconnecting';
	if (age >= STALE_WINDOW) return 'stale';
	if (input.channel !== 'SUBSCRIBED') return 'reconnecting';
	if (age >= FRESHNESS_WINDOW) return 'reconnecting';
	return 'live';
}

// --- What the surfaces print ------------------------------------------------
//
// Worded HERE, for the reason `server/phase.ts` words the phase sentences here
// rather than in a `.svelte` file: two copies of a sentence are two sources and
// they drift the first time one is edited. No route and no component words any
// of this.

/**
 * The heading over the notice, per state. `null` for Live — announcing "live"
 * constantly is noise, and AD-29 says so in as many words.
 */
export const FRESHNESS_HEADINGS: Readonly<Record<FreshnessState, string | null>> = Object.freeze({
	live: null,
	reconnecting: 'Reconnecting',
	stale: 'Not reaching the server'
});

/**
 * What the state MEANS, in the product voice: state the fact, then what it
 * changes. No apology, no exclamation mark, no advice beyond naming what is
 * still true.
 *
 * Neither sentence tells a Manager to refresh. The client is already re-reading
 * on an interval and reloads itself the moment it can; advice to do by hand
 * what the app does automatically is advice to distrust the app.
 */
export const FRESHNESS_STATEMENTS: Readonly<Record<FreshnessState, string | null>> = Object.freeze({
	live: null,
	reconnecting:
		'This app is not currently receiving updates from the server. Every figure below is ' +
		'the last one it confirmed, and the countdowns are still running from the close times ' +
		'it already holds.',
	stale:
		'This app has not reached the server for over two minutes, so it cannot promise any ' +
		'figure below is current. Bidding and nomination are disabled until it can. The ' +
		'countdowns are still running from the close times it already holds, and no Auction ' +
		'has been affected.'
});

/**
 * The age of the figures, as one sentence.
 *
 * `relativePhrase` is `core/instant.ts`'s and is not re-implemented here: "as of
 * 2 minutes ago" is one rendering with one definition, and this is a caller of
 * it rather than a second one.
 */
export function figuresAgeSentence(lastLivenessOkAt: string, now: string): string {
	return `These figures were last confirmed ${relativePhrase(lastLivenessOkAt, now)}.`;
}

/**
 * What an assertive live region says on the transition into Stale, and nothing
 * else says.
 *
 * A Manager who put the phone down must not have to NOTICE a subtle label
 * (`EXPERIENCE.md`: degradation is announced, recovery is silent). There is
 * deliberately no counterpart for the return to Live — recovery restores the
 * controls and says nothing at all.
 */
export const STALE_ANNOUNCEMENT =
	'This app has stopped reaching the server. Bidding and nomination are disabled until it ' +
	'can, and the figures on screen are the last ones it confirmed.';

/**
 * The bid control's stated reason while Stale.
 *
 * A disabled control ALWAYS states its reason in words — that is what makes the
 * disabled token's low contrast legitimate. Disabling is still never the check
 * (AD-9): the server re-derives every gate under the lock, and AD-12 refuses an
 * expired Auction whatever the client believed.
 */
export const STALE_BID_REASON =
	'This app cannot reach the server, so the figures beside this control cannot be confirmed ' +
	'as current. Bidding is disabled until it can. Nothing about this Auction has changed.';

/** The Nomination control's stated reason while Stale. Same fact, its own act. */
export const STALE_NOMINATION_REASON =
	'This app cannot reach the server, so the pool and your Nomination Slot cannot be confirmed ' +
	'as current. Nominating is disabled until it can. Your Slot has not been spent.';

/**
 * The Maximum Bid panel's label, per state.
 *
 * In anything but Live the figure is explicitly a LAST-KNOWN one, which is the
 * half of AD-29's obligation that applies while the control is still enabled:
 * money either carries its age or the control it would authorise is disabled,
 * and in Reconnecting it is the former.
 */
export const MAXIMUM_BID_LABELS: Readonly<Record<FreshnessState, string>> = Object.freeze({
	live: 'Maximum Bid',
	reconnecting: 'Maximum Bid — last known',
	stale: 'Maximum Bid — last known'
});
