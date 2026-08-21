/**
 * The Commissioner break-glass sign-in. Server-only.
 *
 * ## Why this exists (AD-27, and the design record deferred-work.md assigns here)
 *
 * Discord carries **both** authentication (AD-15) and notification (AD-18), so
 * a Discord outage is total: nobody can sign in and nobody can be told. FR-34's
 * pause control must stay reachable when Discord is the component that failed,
 * which means the Commissioner needs one sign-in path that depends on Discord
 * for nothing.
 *
 * ## Why it is not a Supabase session
 *
 * Every other first-party path Supabase Auth offers sends a code or a link to
 * an address, which reintroduces the address field FR-4 forbids anywhere in
 * this product — and the outbound mail FR-4 forbids the system sending for any
 * purpose. A shared secret traded for an application-signed cookie depends on
 * neither vendor's identity plane: it works while Discord is down, and it
 * works while Supabase Auth is down.
 *
 * ## Its operational controls
 *
 * - **Rate limiting.** A shared secret with no throttle is a guessing oracle.
 *   Attempts are counted per source over a sliding window; once the ceiling is
 *   reached the request is refused *before* the secret is compared, so a
 *   throttled attacker learns nothing at all.
 * - **Constant-time comparison.** Both sides are hashed to a fixed 32 bytes and
 *   compared with `timingSafeEqual`, so neither the secret's length nor the
 *   position of the first wrong byte is observable.
 * - **Expiry.** The cookie carries a signed absolute expiry and is minted for
 *   {@link BREAK_GLASS_TTL_MS}. It is an outage tool, not a second front door
 *   to live in.
 * - **Rotation.** The secret is a Netlify per-context environment variable.
 *   Rotating it invalidates every outstanding break-glass cookie immediately,
 *   because the signing key is derived from the secret itself. Rotate after
 *   every use, and after any deploy log or screen share that could have shown
 *   it.
 * - **Audit.** Every attempt — accepted or refused — is worth a line in the
 *   append-only log. That log is Story 1.5 and does not exist yet, so this
 *   story records the intent and leaves the wiring to the story that owns it.
 *
 * ## What it is not
 *
 * It is not secret, and its route is not hidden by obscurity. The path is
 * unadvertised — nothing links to it and the Manager sign-in never mentions it
 * — but the secret is the control. It is also not a Manager sign-in: it
 * establishes a Commissioner break-glass session and nothing else.
 *
 * The pure half of this module (mint, verify, and the throttle arithmetic) is
 * exported so the whole matrix is a unit test with no clock and no network.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// --- Constants --------------------------------------------------------------

/** The cookie name. Prefixed so it cannot collide with Supabase's own. */
export const BREAK_GLASS_COOKIE = 'bbsl_break_glass';

/** Format version, signed along with everything else so it cannot be swapped. */
export const BREAK_GLASS_VERSION = 'bg1';

/**
 * Domain-separation label for the signing key. The signing key is
 * HMAC(secret, label) rather than the secret itself, so the bytes that sign a
 * cookie are never the bytes a caller submits.
 */
export const BREAK_GLASS_KEY_LABEL = 'bbsl.break-glass.v1';

/** Twelve hours. Long enough to work an outage, short enough not to linger. */
export const BREAK_GLASS_TTL_MS = 12 * 60 * 60 * 1000;

/** The lifetime in whole hours, for the sentence the surface reads. */
export const BREAK_GLASS_TTL_HOURS = Math.round(BREAK_GLASS_TTL_MS / (60 * 60 * 1000));

/** The sliding window attempts are counted over. */
export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;

/** Attempts permitted per source within the window, before refusal. */
export const THROTTLE_MAX_ATTEMPTS = 5;

/**
 * The one refusal a wrong secret receives — and the one an unset secret
 * receives. It states the fact and nothing else: a caller cannot tell from it
 * whether the secret was wrong, whether one is configured, or whether this
 * deploy has the feature at all.
 */
export const RECOVERY_REFUSAL = 'That secret is not accepted.';

/** What a throttled source is told. It says nothing about the secret. */
export const RECOVERY_THROTTLED =
	'Too many attempts from this source. Attempts are limited; wait and try again.';

/** The sentence above the single control on the break-glass surface. */
export const RECOVERY_SENTENCE =
	'Commissioner sign-in that does not use Discord. Enter the recovery secret.';

/**
 * What the surface says once a break-glass session is established.
 *
 * The duration is derived from {@link BREAK_GLASS_TTL_MS}, not typed out. A
 * sentence that hardcodes "12 hours" keeps saying so after someone shortens the
 * constant, and the one thing this sentence exists to tell the Commissioner is
 * how long they have.
 */
export const RECOVERY_ACCEPTED =
	`Break-glass session established. It is marked break-glass and expires in ` +
	`${BREAK_GLASS_TTL_HOURS} hours.`;

// --- Constant-time secret comparison ---------------------------------------

/**
 * Compare a submitted secret against the configured one in constant time.
 *
 * Both sides are hashed first. That fixes the compared length at 32 bytes
 * whatever the inputs are, so `timingSafeEqual` cannot throw on a length
 * mismatch and the secret's length is not observable from how long the
 * comparison takes.
 *
 * An unset (or empty) configured secret always refuses, and does so *after*
 * the same hashing and comparison work, so "no secret configured" and "wrong
 * secret" are the same refusal on the same path.
 */
export function secretsMatch(supplied: string, configured: string | undefined | null): boolean {
	const expected = typeof configured === 'string' ? configured : '';
	const a = createHash('sha256').update(supplied, 'utf8').digest();
	const b = createHash('sha256').update(expected, 'utf8').digest();
	const equal = timingSafeEqual(a, b);
	// An empty configured secret must never match, not even an empty submission.
	return equal && expected.length > 0;
}

// --- The signed cookie ------------------------------------------------------

/** The signing key, derived from the secret so rotation invalidates cookies. */
function signingKey(secret: string): Buffer {
	return createHmac('sha256', secret).update(BREAK_GLASS_KEY_LABEL, 'utf8').digest();
}

/** The signed payload: everything except the signature itself. */
function payloadOf(nonce: string, expiresAt: number): string {
	return `${BREAK_GLASS_VERSION}.${nonce}.${expiresAt}`;
}

function sign(secret: string, payload: string): string {
	return createHmac('sha256', signingKey(secret)).update(payload, 'utf8').digest('hex');
}

/**
 * Mint a break-glass cookie value.
 *
 * Pure given its inputs — the clock and the randomness are both parameters, so
 * a test mints a cookie for any instant it likes. `nonce` exists so two cookies
 * minted in the same millisecond are still distinguishable.
 */
export function mintBreakGlassCookie(input: {
	readonly secret: string;
	readonly issuedAt: number;
	readonly nonce: string;
	readonly ttlMs?: number;
}): string {
	const ttl = input.ttlMs ?? BREAK_GLASS_TTL_MS;
	const expiresAt = input.issuedAt + ttl;
	if (input.nonce.includes('.')) {
		// A nonce containing the separator would let one field be read as two.
		throw new Error('break-glass nonce must not contain "."');
	}
	const payload = payloadOf(input.nonce, expiresAt);
	return `${payload}.${sign(input.secret, payload)}`;
}

/** Why a cookie was not accepted, or that it was. */
export type BreakGlassVerdict =
	| { readonly kind: 'valid'; readonly nonce: string; readonly expiresAt: number }
	| { readonly kind: 'malformed' }
	| { readonly kind: 'forged' }
	| { readonly kind: 'expired'; readonly expiresAt: number }
	| { readonly kind: 'absent' };

/**
 * Verify a break-glass cookie.
 *
 * The signature covers the version, the nonce **and the expiry**, so altering
 * the expiry is forgery rather than an extension — a tampered cookie is
 * rejected here, before any lookup happens anywhere.
 *
 * `malformed`, `forged`, `expired` and `absent` are all "no session at all" to
 * every caller; they are distinguished only so a test can prove each path is
 * actually reached, and so an operator reading a log can tell a clock problem
 * from an attack.
 */
export function verifyBreakGlassCookie(input: {
	readonly secret: string | undefined | null;
	readonly value: string | undefined | null;
	readonly now: number;
}): BreakGlassVerdict {
	const secret = typeof input.secret === 'string' ? input.secret : '';
	const value = typeof input.value === 'string' ? input.value : '';
	if (value === '') return { kind: 'absent' };
	// No configured secret means no cookie can be valid. Reported as forged
	// rather than as a distinct state: a caller must not learn the difference.
	if (secret === '') return { kind: 'forged' };

	const parts = value.split('.');
	if (parts.length !== 4) return { kind: 'malformed' };
	const [version, nonce, expiresAtText, signature] = parts as [string, string, string, string];
	if (version !== BREAK_GLASS_VERSION) return { kind: 'malformed' };
	if (nonce === '') return { kind: 'malformed' };
	if (!/^-?\d+$/.test(expiresAtText)) return { kind: 'malformed' };
	if (!/^[0-9a-f]{64}$/.test(signature)) return { kind: 'malformed' };

	const expiresAt = Number(expiresAtText);
	if (!Number.isSafeInteger(expiresAt)) return { kind: 'malformed' };

	const expected = sign(secret, payloadOf(nonce, expiresAt));
	const supplied = Buffer.from(signature, 'hex');
	const computed = Buffer.from(expected, 'hex');
	if (supplied.length !== computed.length || !timingSafeEqual(supplied, computed)) {
		return { kind: 'forged' };
	}

	// Expiry is checked only after the signature, so an attacker cannot use the
	// expiry check as an oracle for a payload they did not sign.
	if (input.now >= expiresAt) return { kind: 'expired', expiresAt };

	return { kind: 'valid', nonce, expiresAt };
}

/** The only verdict that is a session. Everything else is no session at all. */
export function isBreakGlassSession(verdict: BreakGlassVerdict): boolean {
	return verdict.kind === 'valid';
}

/**
 * The cookie attributes. `httpOnly` so script cannot read it, `sameSite: strict`
 * because nothing ever navigates to this route from another origin, `secure`
 * because the site is HTTPS-only, and `path: '/'` because the session it marks
 * applies to the whole app.
 */
export const BREAK_GLASS_COOKIE_OPTIONS = Object.freeze({
	path: '/',
	httpOnly: true,
	secure: true,
	sameSite: 'strict'
} as const);

// --- The throttle (pure) ----------------------------------------------------

/** Drop attempts that have aged out of the window. */
export function pruneAttempts(
	attempts: readonly number[],
	now: number,
	windowMs: number = THROTTLE_WINDOW_MS
): number[] {
	return attempts.filter((at) => at > now - windowMs);
}

/** Is this source over the ceiling right now? */
export function isThrottled(
	attempts: readonly number[],
	now: number,
	max: number = THROTTLE_MAX_ATTEMPTS,
	windowMs: number = THROTTLE_WINDOW_MS
): boolean {
	return pruneAttempts(attempts, now, windowMs).length >= max;
}

/** The attempt list after recording one more, already pruned. */
export function recordAttempt(
	attempts: readonly number[],
	now: number,
	windowMs: number = THROTTLE_WINDOW_MS
): number[] {
	return [...pruneAttempts(attempts, now, windowMs), now];
}

/** How long until this source may try again. Zero when it may try now. */
export function retryAfterMs(
	attempts: readonly number[],
	now: number,
	max: number = THROTTLE_MAX_ATTEMPTS,
	windowMs: number = THROTTLE_WINDOW_MS
): number {
	const live = pruneAttempts(attempts, now, windowMs);
	if (live.length < max) return 0;
	// The window clears when the oldest attempt still counted ages out.
	const oldest = live[live.length - max];
	if (oldest === undefined) return 0;
	return Math.max(0, oldest + windowMs - now);
}

// --- The throttle (imperative) ----------------------------------------------

/**
 * A per-source attempt ledger.
 *
 * In-memory, and therefore per-instance: on a serverless platform two
 * concurrent function instances hold two ledgers, so the effective ceiling is
 * the stated one multiplied by the instance count. That is a real weakening and
 * it is stated rather than hidden. It is still the difference between a
 * guessing oracle and a slow one, and the durable form — counting attempts in
 * the database — belongs with Story 1.5, which is the first story to have a
 * write path at all.
 */
export class AttemptLedger {
	readonly #attempts = new Map<string, number[]>();
	readonly #max: number;
	readonly #windowMs: number;

	constructor(max: number = THROTTLE_MAX_ATTEMPTS, windowMs: number = THROTTLE_WINDOW_MS) {
		this.#max = max;
		this.#windowMs = windowMs;
	}

	/** Attempts currently counted against a source. */
	attemptsFor(source: string): readonly number[] {
		return this.#attempts.get(source) ?? [];
	}

	/** Is this source refused before its secret is even looked at? */
	isThrottled(source: string, now: number): boolean {
		return isThrottled(this.attemptsFor(source), now, this.#max, this.#windowMs);
	}

	/** How long this source must wait. */
	retryAfterMs(source: string, now: number): number {
		return retryAfterMs(this.attemptsFor(source), now, this.#max, this.#windowMs);
	}

	/** Record an attempt. Called for every attempt, accepted or refused. */
	record(source: string, now: number): void {
		this.#attempts.set(source, recordAttempt(this.attemptsFor(source), now, this.#windowMs));
		this.#forgetExpired(now);
	}

	/** How many sources are currently held. Exposed so a test can watch it. */
	get size(): number {
		return this.#attempts.size;
	}

	/**
	 * Drop sources whose attempts have all aged out.
	 *
	 * Without this the Map only ever grows: trimming a source's array on lookup
	 * left the empty array — and its key — behind forever. One key per distinct
	 * source address, on a long-lived serverless instance, is an unbounded
	 * attacker-controlled allocation. Sweeping on write keeps it bounded by the
	 * number of sources actually inside the window.
	 */
	#forgetExpired(now: number): void {
		for (const [source, attempts] of this.#attempts) {
			if (pruneAttempts(attempts, now, this.#windowMs).length === 0) {
				this.#attempts.delete(source);
			}
		}
	}

	/** Forget a source entirely. Used after a successful sign-in. */
	clear(source: string): void {
		this.#attempts.delete(source);
	}
}

/**
 * A stable key for "where did this attempt come from".
 *
 * An absent address collapses to one shared bucket rather than to no throttle
 * at all — a caller that can hide its address must not thereby escape the
 * ceiling.
 */
export function throttleSource(address: string | null | undefined): string {
	const trimmed = (address ?? '').trim();
	return trimmed === '' ? 'unknown' : trimmed;
}

// --- The whole attempt ------------------------------------------------------

/** What a break-glass attempt should do. */
export type RecoveryOutcome =
	| { readonly kind: 'accepted'; readonly cookie: string; readonly expiresAt: number }
	| { readonly kind: 'refused'; readonly message: string; readonly status: number }
	| { readonly kind: 'throttled'; readonly message: string; readonly status: number };

/**
 * Decide one break-glass attempt.
 *
 * Throttle first, then compare — a source over the ceiling never reaches the
 * comparison, so it cannot use the response to learn anything about the secret.
 * The attempt is recorded whatever the outcome, because only counting failures
 * lets a caller alternate a guess with a known-bad value to stay under the
 * ceiling forever.
 */
export function attemptRecovery(input: {
	readonly supplied: string;
	readonly configured: string | undefined | null;
	readonly ledger: AttemptLedger;
	readonly source: string;
	readonly now: number;
	readonly nonce: string;
	readonly ttlMs?: number;
}): RecoveryOutcome {
	if (input.ledger.isThrottled(input.source, input.now)) {
		return { kind: 'throttled', message: RECOVERY_THROTTLED, status: 429 };
	}

	input.ledger.record(input.source, input.now);

	if (!secretsMatch(input.supplied, input.configured)) {
		return { kind: 'refused', message: RECOVERY_REFUSAL, status: 403 };
	}

	input.ledger.clear(input.source);
	const secret = input.configured ?? '';
	const ttl = input.ttlMs ?? BREAK_GLASS_TTL_MS;
	return {
		kind: 'accepted',
		cookie: mintBreakGlassCookie({
			secret,
			issuedAt: input.now,
			nonce: input.nonce,
			ttlMs: ttl
		}),
		expiresAt: input.now + ttl
	};
}
