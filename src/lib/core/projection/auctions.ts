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
 * **`minimum_bid` is produced for real since Story 3.2.** An Opening Bid of
 * exactly `MINIMUM_BID` opens a Minimum-Bid Contention: the `opening` gate
 * passes it, the `contention` gate owns every amount question inside it, and
 * `contenders` below is the Contender list folded from the Bids this log
 * already holds. Until 3.2 the literal existed only so the fold could be
 * total over a log carrying one — the opening gate refused the amount by name
 * and no path wrote a `BidPlaced` at it. That is no longer true, and the
 * state is now reached the ordinary way.
 *
 * A conversion OUT of it — a Bid of `MINIMUM_BID + MINIMUM_INCREMENT` or more
 * into a live contention — is still refused by name, because dissolution
 * releases every Contender's commitment and reveals the seed, and both are
 * Story 3.3's.
 */
export type ContentionState = 'awaiting_opening_bid' | 'standard' | 'minimum_bid';

/**
 * One Contender in a Minimum-Bid Contention (Story 3.2, AD-14).
 *
 * **Ordered by ascending join `seq`, and that order is an input to the
 * winner**, not a rendering preference — AD-14 pins it outright, because the
 * seed→winner derivation has to be reproducible by hand from the published
 * commitment and a list whose order could differ between two readings would
 * make the draw uncheckable. `seq` is the log's own ordering column, assigned
 * by the database and never reissued, so it is the one ordering that cannot
 * drift.
 *
 * Carried here rather than derived by each caller for the reason every other
 * fact on this shape is: the gate, the read path and the Auction page all
 * read ONE derivation, and a second `filter(...).sort(...)` somewhere else
 * could disagree about which Bids counted.
 *
 * `teamName` rides along because the Auction page names the Contenders out
 * loud — there is no anonymity at any point — while `teamId` is what the
 * `contention` gate matches an acting Team against.
 */
export type Contender = {
	/** The joining Bid's own log position. The order AD-14 pins. */
	readonly seq: string;
	readonly teamId: string;
	readonly teamName: string;
};

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
	/**
	 * `hash(seed)` — the commit half of AD-14's commit-reveal — present only
	 * on the Bid that OPENED a Minimum-Bid Contention, and `null` on every
	 * other Bid in the log.
	 *
	 * The raw seed is never here and never anywhere in `auction_events`: it is
	 * sealed in `auction_contention_seeds`, which grants no Postgres role
	 * anything. This is the published commitment a Manager checks the reveal
	 * against at the draw (Story 3.6).
	 */
	readonly seedHash: string | null;
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
	/**
	 * The Contenders in a Minimum-Bid Contention, in ascending join `seq`
	 * (AD-14) — folded from the Bids this log already holds, deduplicated on
	 * `teamId` keeping the EARLIEST join.
	 *
	 * Empty for an Auction that is not a lottery. Nothing is stored: a
	 * Contender is a Bid of exactly `MINIMUM_BID`, which the log already
	 * records, so a `contenders` table would only have to be undone (AD-5).
	 *
	 * The dedup keeps the earliest because a Team joins ONCE — the
	 * `contention` gate refuses a second join by name — and because AD-14
	 * makes the order an input to the winner: a Team that somehow appeared
	 * twice in a historical log must not get two chances at the draw.
	 */
	readonly contenders: readonly Contender[];
	/**
	 * The published `hash(seed)` for this contention, off the opening Bid's
	 * payload — `null` for an Auction that is not a lottery, and `null` for
	 * one whose opening event predates the commitment or carries a malformed
	 * one.
	 *
	 * The FIRST one seen wins, which is what makes replay converge: a fold of
	 * the same log twice cannot swap one commitment for another.
	 */
	readonly seedHash: string | null;
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
 * `minimum_bid` is a state this codebase produces since Story 3.2, and the
 * Auction page prints THIS sentence above the lottery's own label, accent
 * bar, Contender count and list — the sentence states which contention is
 * running; `MINIMUM_BID_CONTENTION_LABEL` names it beside the icon.
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
 * The Minimum-Bid Contention's own label — the WORD that rides beside the
 * icon and the `lottery` accent bar on the Auction page.
 *
 * The PRD §3 glossary term verbatim, and worded here rather than in
 * `+page.svelte` for `contentionSentence`'s reason: a synonym in UI copy is a
 * defect, the same as a synonym in code (`EXPERIENCE.md`), and a second
 * spelling in a `.svelte` file is exactly where one would appear. It is the
 * label rather than the sentence because the panel already carries
 * `contentionSentence` above it, and a chip that ended in a full stop would
 * read as prose.
 *
 * It is also the name the `contention` gate goes by on the refusal panel, so
 * the chip and the accent bar name one thing.
 */
export const MINIMUM_BID_CONTENTION_LABEL = 'Minimum-Bid Contention';

/**
 * The statement, in words, that joining does not restart the Auction Clock.
 *
 * `EXPERIENCE.md` asks for it by name — the lottery's card "states in words
 * that the clock will not reset on a join" — and DESIGN.md's rule that no
 * state may be conveyed by colour alone is why it is words rather than the
 * absence of a moving countdown. A Manager watching a lottery has to be able
 * to tell "the clock did not move" from "the page did not update", and only a
 * sentence does that.
 *
 * It quotes the clock's LENGTH but no instant: the absolute close renders
 * beside it from the fold's own `closesAt`, and a duration stated here that
 * disagreed with the persisted instant would be the invented figure the
 * refusal design exists to prevent.
 */
export const CONTENTION_CLOCK_UNMOVED =
	'The Auction Clock will not reset on a join. It closes 24 hours after the Opening Bid ' +
	'that started this contention, however many Teams join and however late they join.';

/**
 * What the published commitment IS, in words — the sentence the Auction page
 * prints above `hash(seed)` itself.
 *
 * A 64-character hex string on a page with no explanation beside it is a
 * figure a Manager cannot act on. This says what it commits to, that the
 * value behind it is sealed, and what they will be able to do with it at the
 * draw — which is the whole of why AD-14 publishes it this early.
 *
 * It quotes NO figure: the digest renders beside it from the fold's own
 * `seedHash`, so a sentence that named one would be a second copy of a value
 * that must be checkable character by character.
 */
export const SEED_COMMITMENT =
	'The seed for this draw was generated when the contention opened and sealed where no role ' +
	'can read it. Only its SHA-256 is published, and it is published now rather than at the ' +
	'draw — so when the seed is revealed you can hash it yourself and check it against this ' +
	'value.';

/**
 * How many Teams have joined, as a finished sentence.
 *
 * A count is a figure, and `EXPERIENCE.md` requires the lottery's card to
 * carry one — so it is worded here beside the fold that derives the list,
 * rather than left to a surface to interpolate into prose of its own. The
 * singular is written out because "1 Contenders" is the kind of sentence that
 * tells a Manager at 4am that nobody proof-read the thing they are being
 * asked to trust.
 *
 * Zero is a real state a total function must answer for: an Auction that is
 * not a lottery has no Contenders, and so — briefly, in a log this codebase
 * cannot write — would a lottery whose only Bids were malformed.
 */
export function contenderCountSentence(count: number): string {
	if (count === 0) return 'No Teams have joined this contention yet.';
	if (count === 1) return 'One Contender so far.';
	return `${String(count)} Contenders so far.`;
}

/**
 * Which contention an amount puts an Auction in.
 *
 * Exactly `MINIMUM_BID` is a Minimum-Bid Contention; anything above it is
 * Standard. Derived from the leading amount rather than stored on the event,
 * because a stored contention state could disagree with the price beside it
 * and AD-5 makes the fold the answer.
 *
 * **Exported since Story 3.2, and the export is the point.** `decide()` has
 * to know whether the Bid it is authorising OPENS a contention, because that
 * is the one Bid that carries `hash(seed)` and the one opening that writes a
 * seed row. Asking this function is what keeps the payload's commitment and
 * the fold's contention state from being two independent judgements about the
 * same amount — a rule stated in `rules/bidding.ts` and re-stated here could
 * drift, and a contention that folded without a published commitment is
 * exactly the state AD-14 cannot survive.
 *
 * Takes an AMOUNT rather than a `Bid`, so the caller that has only a
 * prospective amount can ask it as easily as the reducer that has a folded
 * one.
 */
export function contentionForAmount(amount: Money): ContentionState {
	return compareMoney(amount, parseMoney(MINIMUM_BID)) === 0 ? 'minimum_bid' : 'standard';
}

/**
 * The Contenders a Bid history yields, in ascending `seq`, one per Team.
 *
 * A Contender is a Bid of EXACTLY `MINIMUM_BID` — the join amount — and
 * nothing else. A malformed historical `BidPlaced` at `$1,000,001` on a
 * lottery folds into `bids` and into the visible history exactly as it does
 * today, and is NOT a Contender: it did not join, and AD-14's draw runs over
 * the Teams that did.
 *
 * `bids` is already in `seq` order by construction — `fold()` guarantees it
 * (AD-5) and this reducer appends in fold order — so nothing here sorts. The
 * dedup keeps the earliest join per Team, which is both what "ascending join
 * `seq`" means and what stops a Team appearing twice in the ordered list the
 * winner is derived from.
 */
function contendersFor(bids: readonly Bid[]): readonly Contender[] {
	const contenders: Contender[] = [];
	const joined = new Set<string>();
	for (const bid of bids) {
		if (contentionForAmount(bid.amount) !== 'minimum_bid') continue;
		if (joined.has(bid.teamId)) continue;
		joined.add(bid.teamId);
		contenders.push({ seq: bid.seq, teamId: bid.teamId, teamName: bid.teamName });
	}
	return contenders;
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

	// The commit half of AD-14, read DEFENSIVELY: absent is `null`, and so is
	// anything that is not a non-empty string. It is never validated as a
	// digest and never re-derived here — this fold has no seed to hash and no
	// business deciding whether a published commitment is well formed. A
	// malformed one is a fact about the log for Story 3.6's reveal to refuse,
	// not a reason for the price and the Leading Bidder to stop folding.
	const rawSeedHash = record['seedHash'];
	const seedHash = typeof rawSeedHash === 'string' && rawSeedHash !== '' ? rawSeedHash : null;

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
			closesAt,
			seedHash
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
					contention: contentionForAmount(bid.amount),
					leadingBid: bid,
					closesAt: bid.closesAt,
					bids: [bid],
					contenders: contendersFor([bid]),
					seedHash: bid.seedHash
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

			// Appended in fold order, which `fold()` guarantees is `seq` order
			// (AD-5) — so the history is chronological by construction and
			// nothing here sorts by `occurredAt`, which under the global lock
			// can run backwards relative to commit order.
			const bids = [...existing.bids, bid];

			const auction: Auction = {
				fantraxPlayerId,
				contention: contentionForAmount(leadingBid.amount),
				leadingBid,
				closesAt: leadingBid.closesAt,
				bids,
				// **A join never moves the lead, so it never moves the clock —
				// and that is a second guarantee, not the rule.** A Bid of
				// exactly `MINIMUM_BID` into a live contention is not strictly
				// higher than the `MINIMUM_BID` already leading, so `leadingBid`
				// and `closesAt` above are unchanged by construction. Story 3.2
				// does not rely on that: `decide()` stamps the contention's
				// EXISTING `closesAt` onto every join's own payload, so the
				// persisted log states one close instant per contention whether
				// or not this fold happens to preserve it.
				contenders: contendersFor(bids),
				// The FIRST commitment seen, kept. A second `seedHash` in the
				// same Auction cannot replace the published one — replay would
				// otherwise be able to swap the commitment a Manager already
				// checked.
				seedHash: existing.seedHash ?? bid.seedHash
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
 * close instant the thing validation compares `now` against, and `hasExpired`
 * below is the ONE derivation that makes that comparison — Story 3.1's
 * `expiry` gate reads it, and so does the Auction page. This function is
 * still only a rendering: it words how much clock is left, and no gate in
 * `PLACE_BID_GATES` decides anything from the phrase it returns. The phrase
 * carries no urgency styling and no pressure — it is one plain sentence
 * fragment, and the absolute stamp renders beside it regardless.
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
 * The one sentence the board states about an Auction whose clock has run out.
 *
 * Worded here, beside the fold that owns `closesAt` and beside `hasExpired`
 * which decides it, so the gate's refusal and the Auction page's panel
 * compose from ONE string rather than spelling the same fact twice — the way
 * `bidPlacedNotice()` composes from `BID_CONSEQUENCE`. A complete sentence,
 * so a surface prints it verbatim and words nothing itself.
 *
 * It quotes no figure of any kind. An expiry is a fact about a clock, and a
 * money figure or a count on this sentence would be the invented figure the
 * refusal design exists to prevent.
 */
export const AUCTION_EXPIRED = 'This Auction expired.';

/**
 * Whether an Auction's persisted absolute close instant has been reached, as
 * of `now` — the ONE derivation of expiry-as-authority (AD-12).
 *
 * **The persisted instant is the authority and nothing else.** This function
 * is handed two instants and reads no projection, no contention state and no
 * nomination: an Auction whose close has passed is expired whether or not a
 * fold still holds a row for it, which is exactly AD-12's "never reads a
 * projection's open flag as authority". Story 3.5's sweep records the close
 * LATE when it stalls; nothing may be accepted in the gap it leaves.
 *
 * **At the close instant the Auction is closed.** `now >= closesAt`, not `>`:
 * Story 3.5 hands each Auction its own nominal expiry as `now`, so a Bid at
 * that exact instant must not beat the close it is being compared against.
 *
 * `null` PASSES — it is a nominated Player nobody has bid on, and no clock
 * exists until an Opening Bid starts one (`EXPERIENCE.md`'s Awaiting Opening
 * Bid card has no clock at all).
 *
 * **The two unreadable cases go opposite ways, deliberately.** An unreadable
 * `closesAt` reads as EXPIRED, which is the trade `readPayload` above already
 * makes in words: "an Auction whose close cannot be read reads as already due
 * rather than as running forever". An unreadable or empty `now` reads as NOT
 * expired, because `now` is the shell's to supply and AD-1 makes a shell bug
 * a throw rather than a returned refusal — passing keeps `decide()`'s
 * existing `TypeError` at `closeInstantFor` reachable, where refusing would
 * swallow it into a Manager-facing statement that is not true.
 *
 * Pure: the same two instants always give the same answer, and nothing here
 * reads a clock.
 */
export function hasExpired(closesAt: string | null, now: string): boolean {
	if (closesAt === null) return false;
	const close = parseInstant(closesAt);
	if (close === null) return true;
	const current = parseInstant(now);
	if (current === null) return false;
	return current >= close;
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
