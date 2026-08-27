/**
 * The core's instant arithmetic, and a pure relative-phrase derivation over
 * it (Story 2.4).
 *
 * Deferred from Story 2.3's split (`deferred-work.md:228-233`), which named
 * this file and called for `core/projection/league-clock.ts`'s instant
 * arithmetic to be *extracted* into it. This module is that extraction and
 * the one home for it: `parseInstant` and `formatInstant` live here and
 * `league-clock.ts` imports them, so there is exactly one implementation of
 * the calendar math and no way for two copies to drift apart under a fix
 * applied to only one.
 *
 * An earlier revision of this file kept a second, private copy on the
 * grounds that `npm run check:purity` forbade the import. That was wrong:
 * the gate forbids imports from *outside* the core, and a relative `.ts`
 * import between two core modules is exactly what AD-2 permits. The only
 * real obstacle was that the helpers were module-private in
 * `league-clock.ts`, which this change fixes at the source rather than
 * working around.
 *
 * `Date` is forbidden in the core (`scripts/check-core-purity.js`), so both
 * conversions — ISO-8601 UTC text to epoch milliseconds and back — are
 * written out by hand (AD-2).
 *
 * `now` is always an argument, never read (AD-3). This module contains no
 * clock of any kind; every caller supplies both instants it compares.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2). It has
 * no imports at all — not because a gate demands it, but because it is the
 * bottom of the core's dependency order and has nothing to import.
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * `YYYY-MM-DDTHH:MM:SS[.sss]Z`, anchored, with an optional fractional part
 * of one to three digits and an optional `+00:00` spelling of `Z`.
 *
 * Anchored and made entirely of bounded, non-overlapping digit runs, so
 * there is no alternation for a hostile input to force into backtracking.
 * A non-UTC offset does not match and reads back as unparseable — correct
 * for this log, which only ever carries UTC, and a great deal safer than
 * silently treating `+05:00` as `Z`.
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
 * not one.
 *
 * The field ranges are checked rather than assumed: `2026-13-45T99:99:99Z`
 * matches the shape above and is not an instant, and folding it as one would
 * silently invent an expiry months away from anything that happened.
 *
 * Exported because `projection/league-clock.ts` computes the League Clock's
 * expiry with it — one implementation, two callers.
 */
export function parseInstant(text: string): number | null {
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
	// A day number that does not round-trip is a date that does not exist —
	// 2026-02-30 and 2027-02-29 both land here.
	const back = civilFromDays(civil);
	if (back.year !== year || back.month !== month || back.day !== day) return null;

	return (
		civil * MS_PER_DAY +
		hour * MS_PER_HOUR +
		minute * MS_PER_MINUTE +
		second * MS_PER_SECOND +
		millisecond
	);
}

/** Left-pad an integer to `width` digits. */
function pad(value: number, width: number): string {
	return String(value).padStart(width, '0');
}

/**
 * The `YYYY-MM-DDTHH:MM:SS.sssZ` spelling of an epoch-millisecond instant —
 * byte-identical to what `Date.prototype.toISOString` produces for the same
 * value, which is what the rest of the log holds.
 *
 * Exported for the same reason as `parseInstant`: the League Clock's expiry
 * is the one caller, and one implementation is the point of this module.
 */
export function formatInstant(ms: number): string {
	// `Math.floor`, not truncation: instants before 1970 are negative, and
	// truncating toward zero would put them on the wrong day.
	const days = Math.floor(ms / MS_PER_DAY);
	const rest = ms - days * MS_PER_DAY;
	const { year, month, day } = civilFromDays(days);

	const hour = Math.floor(rest / MS_PER_HOUR);
	const minute = Math.floor((rest % MS_PER_HOUR) / MS_PER_MINUTE);
	const second = Math.floor((rest % MS_PER_MINUTE) / MS_PER_SECOND);
	const millisecond = rest % MS_PER_SECOND;

	return (
		`${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T` +
		`${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(millisecond, 3)}Z`
	);
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
