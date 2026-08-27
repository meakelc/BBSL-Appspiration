/**
 * A pure relative-phrase derivation between two ISO-8601 UTC instants
 * (Story 2.4).
 *
 * Deferred from Story 2.3's split (`deferred-work.md:228-233`), which named
 * this file and extracted it from `core/projection/league-clock.ts`'s own
 * instant arithmetic. It is NOT a re-export of that module: `npm run
 * check:purity`'s own verification for this story requires this file to
 * import nothing outside the stdlib, so the instant parser below is a
 * second, independent, small copy of the same pure math rather than a
 * shared import — the two are allowed to exist side by side because both
 * are total, deterministic functions over the same ISO-8601 UTC text and
 * cannot disagree about what a given instant means.
 *
 * `Date` is forbidden in the core (`scripts/check-core-purity.js`), so the
 * one conversion this module needs — ISO-8601 UTC text to epoch
 * milliseconds — is written out by hand, exactly as `league-clock.ts` does
 * for the same reason (AD-2).
 *
 * `now` is always an argument, never read (AD-3). This module contains no
 * clock of any kind; every caller supplies both instants it compares.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2). It has
 * no imports at all, deliberately, since its own verification note demands
 * it.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * `YYYY-MM-DDTHH:MM:SS[.sss]Z`, anchored, with an optional fractional part
 * of one to three digits and an optional `+00:00` spelling of `Z`.
 *
 * Anchored and made entirely of bounded, non-overlapping digit runs, so
 * there is no alternation for a hostile input to force into backtracking.
 */
const ISO_UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|\+00:00)$/;

/** Days since 1970-01-01 for a proleptic Gregorian civil date (Hinnant). */
function daysFromCivil(year: number, month: number, day: number): number {
	const y = year - (month <= 2 ? 1 : 0);
	const era = Math.floor(y / 400);
	const yoe = y - era * 400;
	const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}

/** The inverse of `daysFromCivil` — Hinnant's `civil_from_days`. */
function civilFromDays(days: number): { year: number; month: number; day: number } {
	const z = days + 719468;
	const era = Math.floor(z / 146097);
	const doe = z - era * 146097;
	const yoe = Math.floor(
		(doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
	);
	const y = yoe + era * 400;
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
	const month = mp + (mp < 10 ? 3 : -9);
	return { year: y + (month <= 2 ? 1 : 0), month, day };
}

/**
 * Epoch milliseconds for an ISO-8601 UTC instant, or `null` when the text is
 * not one. Field ranges are checked rather than assumed, exactly as
 * `league-clock.ts`'s `parseInstant` does.
 */
function parseInstant(text: string): number | null {
	const match = ISO_UTC_INSTANT.exec(text);
	if (match === null) return null;

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const millisecond = Number((match[7] ?? '0').padEnd(3, '0'));

	if (month < 1 || month > 12) return null;
	if (day < 1 || day > 31) return null;
	if (hour > 23 || minute > 59) return null;
	if (second > 59) return null;

	const civil = daysFromCivil(year, month, day);
	const back = civilFromDays(civil);
	if (back.year !== year || back.month !== month || back.day !== day) return null;

	return civil * MS_PER_DAY + hour * MS_PER_HOUR + minute * MS_PER_MINUTE + second * 1000 + millisecond;
}

/** Left-pad a whole count to make "1" read "1 minute" and "2" read "2 minutes". */
function pluralise(count: number, unit: string): string {
	return `${String(count)} ${unit}${count === 1 ? '' : 's'} ago`;
}

/**
 * A relative phrase for `occurredAt`, as of `now` — both ISO-8601 UTC
 * instants. Pure: the same two instants always produce the same phrase.
 *
 * Four bands, coarsest unit that still reads honestly: under a minute is
 * "moments ago" rather than a false-precision "37 seconds ago"; under an
 * hour is whole minutes; under a day is whole hours; a day or more is whole
 * days. A negative delta — `now` earlier than `occurredAt`, which a clock
 * skew between the reader's device and the server that stamped the event
 * could produce — reads the same as "moments ago" rather than a nonsensical
 * negative count.
 *
 * Either instant failing to parse returns a stated "unknown" phrase rather
 * than throwing (AD-1's discipline applied to a rendering helper): a
 * malformed instant is not this function's business to crash over, and the
 * absolute stamp beside it is what a caller renders regardless.
 */
export function relativePhrase(occurredAt: string, now: string): string {
	const then = parseInstant(occurredAt);
	const current = parseInstant(now);
	if (then === null || current === null) return 'at an unknown time';

	const deltaMs = current - then;
	if (deltaMs < MS_PER_MINUTE) return 'moments ago';
	if (deltaMs < MS_PER_HOUR) return pluralise(Math.floor(deltaMs / MS_PER_MINUTE), 'minute');
	if (deltaMs < MS_PER_DAY) return pluralise(Math.floor(deltaMs / MS_PER_HOUR), 'hour');
	return pluralise(Math.floor(deltaMs / MS_PER_DAY), 'day');
}
