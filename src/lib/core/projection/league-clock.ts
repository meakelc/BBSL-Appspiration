/**
 * The League Clock's origin and its resets, folded from the log
 * (Stories 1.11, 2.1).
 *
 * The League Clock is 48 hours long (`LEAGUE_CLOCK`, `core/constants.ts`)
 * and its expiry ends the Auction Phase (PRD §3). This reducer answers where
 * it started — the `AuctionOpened` event's own `occurredAt`, which is the
 * database's transaction-start clock as the shell read it once (AD-3) — and
 * where it was last reset. The core never learns what time it *is*:
 * `leagueClockExpiry` below is arithmetic on instants the log already
 * carries, and comparing its answer to the present is the shell's job.
 *
 * **An origin is not a reset.** AD-22 names `AuctionOpened` as the League
 * Clock's origin and fixes the reset set at exactly two event types. Story
 * 2.1 adds the first of them, `NominationPlaced`; `BidPlaced` is Story 2.2's
 * and its absence here is a decision, not an omission. The set is not
 * widened past those two, and a reset stays distinguishable from the origin
 * because a reset can be unwound by a compensating `BidVoided` while the
 * open can never be unwound.
 *
 * **Two fields, not one.** AD-22's amended third bullet fixes expiry at
 * `LEAGUE_CLOCK` after the *later* of the origin and the latest surviving
 * reset. A single field would let a void recompute the clock back past the
 * open, which the AD forbids — so `origin` and `lastReset` are folded
 * separately and `leagueClockExpiry` takes the later of the two.
 * `lastReset` stays `null` until the auction's first nomination.
 *
 * **The first open wins; the last reset wins.** `AuctionOpened` can only be
 * appended once in practice — the gate refuses when the phase has already
 * folded to Auction — but a reducer must be total over any log it is handed,
 * and "the origin is the first open" is the only answer that cannot move an
 * already-running clock forward. A reset is the opposite: the whole point of
 * one is to move the clock forward, so the latest reset in `seq` order is
 * the one that holds. Both rules make a double replay converge.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2). That
 * is why the instant arithmetic at the bottom of this file is written out by
 * hand rather than handed to `Date`: `Date` is a forbidden reference in the
 * core (`scripts/check-core-purity.js`) precisely because `Date.now()` and
 * `new Date()` are indistinguishable from `Date.parse` to a static walk, and
 * a core that could reach one could reach the others.
 */

import { LEAGUE_CLOCK } from '../constants.ts';
import type { Reducer } from './fold.ts';
import { NOMINATION_PLACED_EVENT } from './nominations.ts';
import { AUCTION_OPENED_EVENT } from './phase.ts';

/**
 * Where the League Clock starts, and when it was last restarted.
 *
 * `origin` is the ISO-8601 instant of the `AuctionOpened` event, or `null`
 * while the auction has not opened — which is a state, not a failure: there
 * is no League Clock during Setup.
 *
 * `lastReset` is the ISO-8601 instant of the latest event in AD-22's reset
 * set, or `null` when nothing has reset it since the open. It is never
 * conflated with `origin`: an auction that has opened and seen no nomination
 * has an origin and no reset, and those are different facts.
 */
export type LeagueClock = {
	readonly origin: string | null;
	readonly lastReset: string | null;
};

/** With no `AuctionOpened` event, the League Clock has not started. */
export const INITIAL_LEAGUE_CLOCK: LeagueClock = Object.freeze({
	origin: null,
	lastReset: null
});

/**
 * Fold one event onto the League Clock.
 *
 * The `default: return state` discipline is `phase.ts`'s, for the same
 * reason. Folding the same events twice converges: a second `AuctionOpened`
 * leaves the already-set origin alone, and re-folding the same
 * `NominationPlaced` sets `lastReset` to the value it already held.
 *
 * A `NominationPlaced` appended before any open — unreachable through the
 * gate, which refuses outside the Auction Phase — still records its reset.
 * `leagueClockExpiry` returns `null` without an origin, so a stray reset can
 * never manufacture a clock that never started.
 */
export const leagueClockReducer: Reducer<LeagueClock> = (state, event) => {
	switch (event.type) {
		case AUCTION_OPENED_EVENT: {
			if (state.origin !== null) return state;
			return { ...state, origin: event.occurredAt };
		}
		case NOMINATION_PLACED_EVENT: {
			// The latest reset in `seq` order wins. `fold()` orders by `seq`
			// (AD-5), so "latest" is simply "the last one folded" — never a
			// timestamp comparison, which would be wrong under the global lock
			// where a later commit can hold an earlier `occurred_at`.
			return { ...state, lastReset: event.occurredAt };
		}
		default:
			return state;
	}
};

/**
 * When the League Clock expires, as an ISO-8601 instant, or `null` while the
 * auction has not opened.
 *
 * `LEAGUE_CLOCK` after the LATER of the origin and the latest surviving
 * reset — AD-22's amended third bullet, stated once, here, so the sweep, the
 * surface and the tests cannot each compute a different expiry.
 *
 * Taking the later of the two rather than "the reset if there is one" is
 * what stops a compensating void from recomputing the clock back past the
 * open.
 *
 * Total over any state the reducer can produce: an unparseable origin, or a
 * `lastReset` that predates the origin or fails to parse, falls back to the
 * origin rather than throwing. Nothing here asks what time it is now — every
 * input is an instant the log already carries.
 */
export function leagueClockExpiry(clock: LeagueClock): string | null {
	if (clock.origin === null) return null;
	const origin = parseInstant(clock.origin);
	if (origin === null) return null;

	let from = origin;
	if (clock.lastReset !== null) {
		const reset = parseInstant(clock.lastReset);
		if (reset !== null && reset > from) from = reset;
	}

	return formatInstant(from + LEAGUE_CLOCK);
}

// --- Instant arithmetic, by hand ------------------------------------------
//
// `Date` is forbidden in the core, so the two conversions the expiry needs —
// ISO-8601 UTC text to epoch milliseconds and back — are written here. Both
// are pure integer arithmetic over the proleptic Gregorian calendar and are
// deterministic for every input; neither reads a clock, a locale or a time
// zone. UTC only, which is the only thing the log ever holds: `occurredAt`
// arrives from `toAppendedEvent`'s `Date.toISOString()` in the shell, where
// `Date` is allowed.

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;

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

/**
 * Days since 1970-01-01 for a proleptic Gregorian civil date.
 *
 * Howard Hinnant's `days_from_civil`, which is exact for every year in the
 * range this product can produce and needs no table of month lengths or leap
 * rules — the era arithmetic encodes both.
 */
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
	// `.5` means 500ms, not 5ms — a fractional part is padded on the right.
	const millisecond = Number((match[7] ?? '0').padEnd(3, '0'));

	if (month < 1 || month > 12) return null;
	if (day < 1 || day > 31) return null;
	if (hour > 23 || minute > 59) return null;
	// 60 is a leap second, which UTC allows and this product never records;
	// it is refused rather than folded as the next minute.
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
 */
function formatInstant(ms: number): string {
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
