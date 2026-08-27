/**
 * Open Auctions, folded from the log (Story 2.5).
 *
 * **Nothing here is stored.** No `auctions` table, no `bids` table, no
 * migration: the leading Bid, the current price, the contention state, the
 * absolute close instant and the whole chronological Bid history are this
 * fold over `auction_events`. `projection/nominations.ts`'s own header states
 * the reasoning and it is unchanged here — the log already carries every
 * fact, and AD-5 makes a projection disposable and rebuildable, so a table
 * would only have to be undone.
 *
 * **The close instant rides the `BidPlaced` payload.** AD-3 requires the
 * server to persist ABSOLUTE close timestamps — never "seconds remaining" —
 * and AD-12 requires validation to compare `now` against a *persisted* one
 * rather than a projection's open flag. A projection table is the wrong home
 * for it precisely because AD-5 makes projections disposable. Carrying
 * `closesAt` on the payload persists it in the insert-only log, keeps it
 * foldable, and leaves AD-13's pause — which recomputes forward and never
 * shifts a close time in place — somewhere to stand.
 *
 * **This fold answers a bid question, never the "is there an Auction"
 * question.** An Auction exists because a Player was nominated, which is
 * `nominationsReducer`'s fold; this one only knows what has been BID. A
 * nominated Player nobody has bid on has no entry here at all, and
 * `auctionForPlayer` returns `null` for them — which is "no bids yet", not
 * "no Auction". Two folds over one loaded events array, exactly as
 * `server/nomination.ts` already runs phase and nominations together.
 *
 * **The highest Bid leads, and history keeps everything.** The gate refuses
 * anything at or below the current high, so in practice every `BidPlaced` in
 * the log is a raise and "latest leads" and "highest leads" agree. A reducer
 * must nonetheless be total over any log it is handed, and only "strictly
 * higher takes the lead" is idempotent under replay: folding the same log
 * twice converges, because a second fold of an already-leading Bid is not
 * strictly higher than itself. History appends unconditionally — an event
 * that happened, happened — and is de-duplicated on `seq`, which the
 * database assigns and never reissues.
 *
 * **`AuctionClosed` removes the Auction**, keyed on the Player and read
 * through `nominations.ts`'s own exported `readClosedPlayerId`, so this fold
 * and the Slot's release can never disagree about what a malformed close
 * means. **Nothing in this story appends one** — Epic 3 owns closing — so
 * the case ships proven against a synthetic event.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { MINIMUM_BID } from '../constants.ts';
import { formatInstant, parseInstant } from '../instant.ts';
import type { Money } from '../money.ts';
import { compareMoney, parseMoney } from '../money.ts';
import type { Reducer } from './fold.ts';
import { AUCTION_CLOSED_EVENT, readClosedPlayerId } from './nominations.ts';

/**
 * The event type a successful Bid appends (`server/bidding.ts`).
 *
 * Declared here rather than beside the transaction that appends it, for
 * `NOMINATION_PLACED_EVENT`'s reason: this is the reducer that gives it
 * meaning. The price, the Leading Bidder, the contention state and the
 * Auction Clock ARE this fold.
 */
export const BID_PLACED_EVENT = 'BidPlaced';

/**
 * Which contention an Auction is in.
 *
 * `awaiting_opening_bid` is a nominated Player nobody has bid on. `standard`
 * is the ordinary case: one Leading Bidder, raises of at least the Minimum
 * Increment, a 24-hour clock from the latest Bid.
 *
 * **`minimum_bid` is a state literal this story can fold but never
 * produces.** An Opening Bid of exactly `MINIMUM_BID` opens a Minimum-Bid
 * Contention, whose Contender list, seed table, fixed clock and draw are
 * Stories 3.2/3.3 — so `rules/bidding.ts`'s opening gate refuses that amount
 * outright and no path in this codebase writes a `BidPlaced` at it. The
 * literal exists because a reducer must be total over any log it is handed,
 * and because PRD §10 example 26's second half needs a lottery state to
 * submit `$1,000,001` into: `tests/examples/example-26-off-grid-everywhere.test.ts`
 * builds one directly, which is exactly what AD-25 means by "a state literal".
 */
export type ContentionState = 'awaiting_opening_bid' | 'standard' | 'minimum_bid';

/** One Bid, as the history line and the Leading Bidder both need it. */
export type Bid = {
	/** The log's own ordering column. Also this Bid's identity in history. */
	readonly seq: string;
	/** The bidding Team. */
	readonly teamId: string;
	/** That Team's name — what the Leading Bidder line says out loud. */
	readonly teamName: string;
	/** The acting Manager. Bid history names them; there is no anonymity. */
	readonly managerId: string;
	/** The amount offered, in integer dollars (AD-8). */
	readonly amount: Money;
	/** The Bid's own instant, as the shell read the database clock (AD-3). */
	readonly occurredAt: string;
	/** `AUCTION_CLOCK` after `occurredAt`, absolute, as the payload persisted it. */
	readonly closesAt: string;
};

/**
 * One Auction's bid state. Absent entirely until its first Bid.
 *
 * **`leadingBid` and `closesAt` are not nullable, and that is the invariant
 * rather than an oversight.** An entry exists in this projection if and only
 * if at least one `BidPlaced` was folded for that Player, and any non-empty
 * set of Bids has a highest one. Typing them as nullable invited a branch
 * that could never be taken — `contention` and `closesAt` each re-testing a
 * leader the reducer had just guaranteed — and a dead branch hides the real
 * invariant instead of stating it. "No Auction row" IS the no-Bid state, and
 * `auctionForPlayer` returning `null` is how a caller reads it.
 */
export type Auction = {
	readonly fantraxPlayerId: string;
	readonly contention: ContentionState;
	/** The highest Bid so far — the current price and the Leading Bidder. */
	readonly leadingBid: Bid;
	/** The Auction Clock's absolute expiry: the leading Bid's own `closesAt`. */
	readonly closesAt: string;
	/** Every Bid, oldest first. Ordered by `seq`, never by `occurredAt` (AD-5). */
	readonly bids: readonly Bid[];
};

/** Every Auction that has seen a Bid, keyed on the Player. */
export type OpenAuctions = {
	readonly byPlayer: Readonly<Record<string, Auction>>;
};

/** With no `BidPlaced` event, no Auction has a price. */
export const INITIAL_AUCTIONS: OpenAuctions = Object.freeze({
	byPlayer: Object.freeze({}) as Readonly<Record<string, Auction>>
});

/**
 * `Object.prototype.hasOwnProperty`, called against the record rather than
 * through it — `nominations.ts`'s `hasOwn`, for its reason: the keys are
 * Fantrax player ids, which are data, so a key of `constructor` must not read
 * back as an inherited function.
 */
function hasOwn(record: Readonly<Record<string, Auction>>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

/** The Auction for a Player, or `null` when nobody has bid on them. */
export function auctionForPlayer(auctions: OpenAuctions, fantraxPlayerId: string): Auction | null {
	if (!hasOwn(auctions.byPlayer, fantraxPlayerId)) return null;
	return auctions.byPlayer[fantraxPlayerId] ?? null;
}

/**
 * The contention state of an Auction that may not have one yet.
 *
 * The one place `null` — "nominated, no Bid" — is mapped to
 * `awaiting_opening_bid`, so the read path, the gate and the tests cannot
 * each answer it differently.
 */
export function contentionOf(auction: Auction | null): ContentionState {
	return auction === null ? 'awaiting_opening_bid' : auction.contention;
}

/**
 * The one wording for each contention state, for a surface to print.
 *
 * The Auction page shows "state" among the things `epics.md` lists for it,
 * and a state is a fact about the Auction — so it is worded here, beside the
 * fold that decides it, rather than in a `.svelte` file where a second
 * spelling could drift from the literal. A plain sentence and no chip:
 * `DESIGN.md` assigns ambient states a plain label, and the one attention
 * colour in the product marks Outbid and refusal and nothing else.
 *
 * `minimum_bid` is worded even though nothing in this story can produce it,
 * for `ContentionState`'s own reason: the fold is total over a log that
 * carries one, so a surface rendering that fold must be too.
 */
export function contentionSentence(state: ContentionState): string {
	switch (state) {
		case 'awaiting_opening_bid':
			return 'Awaiting an Opening Bid.';
		case 'standard':
			return 'Standard Contention.';
		case 'minimum_bid':
			return 'Minimum-Bid Contention.';
	}
}

/**
 * Which contention a leading Bid puts an Auction in.
 *
 * Exactly `MINIMUM_BID` is a Minimum-Bid Contention; anything above it is
 * Standard. Derived from the leading amount rather than stored on the event,
 * because a stored contention state could disagree with the price beside it
 * and AD-5 makes the fold the answer.
 */
function contentionFor(leading: Bid): ContentionState {
	return compareMoney(leading.amount, parseMoney(MINIMUM_BID)) === 0 ? 'minimum_bid' : 'standard';
}

/**
 * The `BidPlaced` payload as this reducer needs it, read defensively.
 *
 * `AppendedEvent.payload` is `unknown` — whatever JSON the column holds — and
 * an insert-only log cannot be corrected in place, so a malformed historical
 * row must never crash the fold. Returning `null` rather than throwing is
 * `nominations.ts`'s discipline for the same reason, and a Bid naming no
 * Player, no Team or no amount is *skipped*: it cannot be a price, cannot be
 * a Leading Bidder, and cannot be a history line naming who acted.
 *
 * The amount is the one field parsed rather than trusted. `parseMoney`
 * accepts both shapes an `int8` arrives as and throws on everything else
 * (AD-8); that throw is caught here and turned into a skip, because a
 * corrupt payload in an insert-only log is not this fold's to crash over —
 * the same trade `readPayload` already makes for a missing Player id.
 *
 * `closesAt` falls back to the event's own `occurredAt` when absent or
 * unparseable, which is the conservative direction: an Auction whose close
 * cannot be read reads as already due rather than as running forever. It
 * never invents a later one.
 */
function readPayload(
	payload: unknown,
	event: { readonly seq: string; readonly occurredAt: string }
): { readonly fantraxPlayerId: string; readonly bid: Bid } | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const record = payload as Record<string, unknown>;

	const fantraxPlayerId = record['fantraxPlayerId'];
	const teamId = record['teamId'];
	const managerId = record['managerId'];
	if (typeof fantraxPlayerId !== 'string' || fantraxPlayerId === '') return null;
	if (typeof teamId !== 'string' || teamId === '') return null;
	if (typeof managerId !== 'string' || managerId === '') return null;

	let amount: Money;
	try {
		amount = parseMoney(record['amount']);
	} catch {
		return null;
	}
	// A negative amount is skipped for the same reason a missing Team id is:
	// it cannot be a price. `parseMoney` accepts an optionally-signed digit
	// run — legitimately, because Available Cap Space is legitimately
	// negative — so the sign has to be refused HERE, exactly as
	// `readBidAmount` refuses it at the form boundary. Without this a
	// malformed historical row carrying `-500000` would fold in as a Bid, and
	// while it could never take the lead from a positive one, it would become
	// the leading Bid of an Auction whose only Bids were negative.
	if (amount < 0) return null;

	const teamName = record['teamName'];
	const rawClosesAt = record['closesAt'];
	const closesAt =
		typeof rawClosesAt === 'string' && parseInstant(rawClosesAt) !== null
			? rawClosesAt
			: event.occurredAt;

	return {
		fantraxPlayerId,
		bid: {
			seq: event.seq,
			teamId,
			// The Team's name is audit detail the Leading Bidder line prints; the
			// id is what the self-bid gate matches on. A missing name falls back
			// to the id, which still identifies the Team, rather than dropping a
			// Bid that was genuinely placed.
			teamName: typeof teamName === 'string' && teamName !== '' ? teamName : teamId,
			managerId,
			amount,
			occurredAt: event.occurredAt,
			closesAt
		}
	};
}

/**
 * Every entry of a record except the named key, built through
 * `Object.entries`/`Object.fromEntries` for `hasOwn`'s reason: the keys are
 * data, and `record[key] = value` on `__proto__` would set a prototype.
 */
function omitKey(
	record: Readonly<Record<string, Auction>>,
	key: string
): Readonly<Record<string, Auction>> {
	return Object.fromEntries(Object.entries(record).filter(([existing]) => existing !== key));
}

/**
 * Fold one event onto the open Auctions.
 *
 * The `default: return state` discipline is `phase.ts`'s, for the same
 * reason: an event type this reducer has not been taught is not an error, it
 * is simply not about bidding.
 *
 * Replay converges. A `BidPlaced` already in history — same `seq` — is
 * ignored outright, and a Bid that is not strictly higher than the current
 * leader never takes the lead, so a second fold of the same log produces the
 * identical state. A close for a Player with no Auction changes nothing, for
 * the reason `nominationsReducer` gives.
 */
export const auctionsReducer: Reducer<OpenAuctions> = (state, event) => {
	switch (event.type) {
		case BID_PLACED_EVENT: {
			const read = readPayload(event.payload, event);
			if (read === null) return state;
			const { fantraxPlayerId, bid } = read;

			const existing = hasOwn(state.byPlayer, fantraxPlayerId)
				? (state.byPlayer[fantraxPlayerId] ?? null)
				: null;

			if (existing === null) {
				const auction: Auction = {
					fantraxPlayerId,
					contention: contentionFor(bid),
					leadingBid: bid,
					closesAt: bid.closesAt,
					bids: [bid]
				};
				return { byPlayer: { ...state.byPlayer, [fantraxPlayerId]: auction } };
			}

			// `seq` is database-assigned and never reissued, so it is the one
			// field that identifies a Bid across two folds of the same log.
			if (existing.bids.some((recorded) => recorded.seq === bid.seq)) return state;

			// An existing Auction always has a leading Bid — that is what makes
			// it exist — so there is exactly one question here: is this Bid
			// strictly higher? Nothing below re-tests for a leader that cannot
			// be absent.
			const leadingBid =
				compareMoney(bid.amount, existing.leadingBid.amount) > 0 ? bid : existing.leadingBid;

			const auction: Auction = {
				fantraxPlayerId,
				contention: contentionFor(leadingBid),
				leadingBid,
				closesAt: leadingBid.closesAt,
				// Appended in fold order, which `fold()` guarantees is `seq` order
				// (AD-5) — so the history is chronological by construction and
				// nothing here sorts by `occurredAt`, which under the global lock
				// can run backwards relative to commit order.
				bids: [...existing.bids, bid]
			};
			return { byPlayer: { ...state.byPlayer, [fantraxPlayerId]: auction } };
		}
		case AUCTION_CLOSED_EVENT: {
			// The SAME reader `nominationsReducer` folds a close through, so a
			// close naming no Player is skipped here exactly as it is skipped
			// there — the board seat, the Nomination Slot and the Auction can
			// never be released apart from one another.
			const fantraxPlayerId = readClosedPlayerId(event.payload);
			if (fantraxPlayerId === null) return state;
			if (!hasOwn(state.byPlayer, fantraxPlayerId)) return state;
			return { byPlayer: omitKey(state.byPlayer, fantraxPlayerId) };
		}
		default:
			return state;
	}
};

// --- Rendering the Auction Clock -------------------------------------------

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * How much of the Auction Clock is left, as of `now` — both ISO-8601 UTC
 * instants. Pure: the same two instants always produce the same phrase.
 *
 * The counterpart of `instant.ts`'s `relativePhrase`, which words a PAST
 * instant ("4 hours ago") and would read a future close as "moments ago".
 * A close time is always ahead of the reader, so it needs its own phrasing,
 * and it lives here — beside the fold that owns `closesAt` — rather than
 * being re-worded in a `.svelte` file where a second definition could drift.
 *
 * **This is a rendering, not authority.** AD-12 makes the persisted absolute
 * close instant the thing validation compares `now` against, and no gate in
 * `PLACE_BID_GATES` reads this function: Story 3.1 owns expiry-as-authority.
 * The phrase carries no urgency styling and no pressure — it is one plain
 * sentence fragment, and the absolute stamp renders beside it regardless.
 *
 * Either instant failing to parse returns a stated phrase rather than
 * throwing, which is `relativePhrase`'s discipline for the same input: a
 * malformed instant is not this function's business to crash over.
 */
export function closesInPhrase(closesAt: string, now: string): string {
	const close = parseInstant(closesAt);
	const current = parseInstant(now);
	if (close === null || current === null) return 'an unknown time left';

	const remaining = close - current;
	if (remaining <= 0) return 'no time left';

	// Under a minute is stated in words rather than as `0m left`, which reads
	// as "none" beside the `no time left` above it and is not what it means.
	// This is `relativePhrase`'s "moments ago" band, pointed the other way.
	if (remaining < MS_PER_MINUTE) return 'less than a minute left';

	if (remaining < MS_PER_HOUR) {
		return `${String(Math.floor(remaining / MS_PER_MINUTE))}m left`;
	}
	if (remaining < MS_PER_DAY) {
		const hours = Math.floor(remaining / MS_PER_HOUR);
		const minutes = Math.floor((remaining % MS_PER_HOUR) / MS_PER_MINUTE);
		return `${String(hours)}h ${String(minutes)}m left`;
	}
	const days = Math.floor(remaining / MS_PER_DAY);
	const hours = Math.floor((remaining % MS_PER_DAY) / MS_PER_HOUR);
	return `${String(days)}d ${String(hours)}h left`;
}

/**
 * `AUCTION_CLOCK` after a Bid's own instant, as an ISO-8601 UTC string.
 *
 * The one definition of an Auction's close instant, so `decide()` (which
 * stamps it onto the payload) and any later story that recomputes one cannot
 * disagree by a millisecond. Pure arithmetic on an instant the caller
 * supplies — nothing here reads a clock (AD-3).
 *
 * Returns `null` when `occurredAt` is not an instant this core can read,
 * rather than inventing one. `decide()` treats that as the bug it is.
 */
export function closeInstantFor(occurredAt: string, auctionClockMs: number): string | null {
	const start = parseInstant(occurredAt);
	if (start === null) return null;
	return formatInstant(start + auctionClockMs);
}
