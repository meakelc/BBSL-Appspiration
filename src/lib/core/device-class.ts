/**
 * The device-class classifier (Story 2.1).
 *
 * `auction_events.device_class` has existed, nullable and unpopulated, since
 * `20260821020000_auction_events.sql:71`. NFR §5 wants it because "the
 * auction is a phone product" is a claim the log should be able to settle,
 * and an insert-only log cannot be backfilled — so the first event type that
 * a Manager appends from their own device is the first one that must carry
 * it. `NominationPlaced` is that event.
 *
 * **This is a measurement, never a rule input.** No reducer and no gate in
 * this codebase may read `deviceClass`: it rides the envelope
 * (`shell/write.ts`'s `device_class` column), not the payload, precisely so
 * that no refusal can ever come to depend on what phone somebody used. The
 * classifier lives in the core only because it is pure arithmetic over a
 * string, not because the core consumes its output.
 *
 * **Total, and `'unknown'` is a real answer.** A request with no
 * `user-agent` header, a blank one, or one this table does not recognise
 * classifies as `'unknown'` — never null, never a throw. A missing header is
 * an ordinary condition (curl, a privacy extension, a corporate proxy), and
 * a measurement field that failed a write because a header was absent would
 * be a measurement field that broke the product.
 *
 * **No regular expressions.** Every test below is a substring check on a
 * lowercased copy, so there is no pattern for a hostile User-Agent to force
 * into catastrophic backtracking. The header is attacker-controlled text of
 * arbitrary length; `includes` is linear and cannot be made otherwise.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

/**
 * The four classes. Deliberately coarse: the question NFR §5 asks is "is
 * this a phone product", not "which handset", and a finer taxonomy would be
 * a fingerprint kept forever in an insert-only log.
 */
export type DeviceClass = 'mobile' | 'tablet' | 'desktop' | 'unknown';

/** Every class, for exhaustiveness checks and tests. */
export const DEVICE_CLASSES: readonly DeviceClass[] = Object.freeze([
	'mobile',
	'tablet',
	'desktop',
	'unknown'
]);

/**
 * Tablet markers, tested FIRST.
 *
 * An iPad's User-Agent contains the word `Mobile`, and an Android tablet's
 * is an Android string with `Mobile` deliberately absent. Testing mobile
 * first would therefore classify every iPad as a phone and every Android
 * tablet as a desktop, so the order of the two checks below is load-bearing
 * rather than incidental.
 */
const TABLET_MARKERS: readonly string[] = Object.freeze([
	'ipad',
	'tablet',
	'kindle',
	'silk',
	'playbook',
	'nexus 7',
	'nexus 10'
]);

/** Phone markers. Only reached once no tablet marker matched. */
const MOBILE_MARKERS: readonly string[] = Object.freeze([
	'iphone',
	'ipod',
	'windows phone',
	'iemobile',
	'blackberry',
	'bb10',
	'opera mini',
	'opera mobi',
	'webos',
	'mobile'
]);

/** Desktop markers, tested last of the three. */
const DESKTOP_MARKERS: readonly string[] = Object.freeze([
	'windows nt',
	'macintosh',
	'mac os x',
	'cros',
	'x11',
	'linux'
]);

/** Whether `haystack` contains any of `markers`. */
function containsAny(haystack: string, markers: readonly string[]): boolean {
	for (const marker of markers) {
		if (haystack.includes(marker)) return true;
	}
	return false;
}

/**
 * Classify one `user-agent` header value.
 *
 * The order is tablet, then mobile, then desktop, then `'unknown'`, with one
 * special case: an Android string is a tablet exactly when it does NOT say
 * `mobile`, which is the convention Android's own browser guidance states
 * and the only signal in the string that distinguishes the two.
 *
 * Known and accepted imprecision: iPadOS 13 and later report a Macintosh
 * User-Agent by default and classify here as `'desktop'`. Recovering the
 * truth needs a client-side touch-point probe, which is a rule input
 * gathered from the browser — exactly what this field must not become. A
 * measurement that is honest about its own resolution is worth more than one
 * that guesses.
 */
export function classifyDeviceClass(userAgent: string | null | undefined): DeviceClass {
	if (typeof userAgent !== 'string') return 'unknown';
	const agent = userAgent.trim().toLowerCase();
	if (agent === '') return 'unknown';

	const saysMobile = agent.includes('mobile');

	// Android tablets are Android strings WITHOUT `mobile`; Android phones
	// have it. This is checked alongside the marker table rather than inside
	// it because it is a negative condition, which a substring list cannot
	// express.
	if (agent.includes('android') && !saysMobile) return 'tablet';
	if (containsAny(agent, TABLET_MARKERS)) return 'tablet';

	if (containsAny(agent, MOBILE_MARKERS)) return 'mobile';

	if (containsAny(agent, DESKTOP_MARKERS)) return 'desktop';

	return 'unknown';
}
