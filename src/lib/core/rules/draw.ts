/**
 * Drawing a Minimum-Bid Contention winner (Story 3.6, FR-19, AD-14). Pure.
 *
 * **The winner is DERIVED, not chosen, and the derivation is arithmetic a
 * Manager can do in a spreadsheet.** That is the whole of what makes AD-14's
 * premise hold: a Commissioner who is also a rival is acceptable *because* the
 * draw can be checked by anyone who holds the revealed seed and the ordered
 * Contender list. A procedure that needed a computer to reproduce would move
 * the trust back to the machine that ran it.
 *
 * Read the seed's 64 hex digits left to right as one 256-bit number and take
 * its remainder modulo the Contender count. Every intermediate stays under
 * `16 x n + 15`, so at any Contender count this league can produce nothing
 * exceeds 500 — pencil, paper or one spreadsheet column all work:
 *
 *     r = 0
 *     for each hex digit d of the seed, left to right:
 *         r = (r * 16 + value(d)) mod n
 *     winner = contenders[r]          # 0-based, ascending join `seq`
 *
 * **Full-width reduction rather than one 8-digit window.**
 * `HEX2DEC(LEFT(seed,8)) mod n` is one spreadsheet cell but carries
 * `(2^32 mod n)/2^32 ~ 7e-9` of modulo bias, so "probability exactly `1/n`"
 * would be false as stated. Rejection sampling over such windows is exactly
 * uniform but adds a step to the hand procedure and a branch that fires with
 * probability `~7e-9` — untestable except through a crafted seed. Reducing the
 * whole width has bias below `n / 2^256`, far under the chance of a SHA-256
 * collision, and no branch at all.
 *
 * **The derivation reads the SEED and never `hash(seed)`.** The commitment is
 * published the instant a lottery opens. If the winning position were
 * `hash(seed) mod n`, any watcher could compute — before joining — whether
 * becoming Contender `n+1` would make them the winner, which is exactly the
 * exploit AD-14's commit-reveal exists to prevent, reached without ever seeing
 * the seed. The seed is the only input, and it stays sealed in
 * `auction_contention_seeds` until the reveal this story appends opens it.
 *
 * **The seed reaches this module as an ARGUMENT.** `core/` reads no random
 * source and generates nothing (`scripts/check-core-purity.js` enforces it);
 * the shell reads the sealed row under the same lock that will append and
 * hands the value in, exactly as it hands in `now`.
 *
 * **Contender order is ascending join `seq`, from the fold's own `contenders`
 * list and nothing else.** AD-14 pins that order because it is an INPUT to the
 * winner rather than a rendering preference: a list whose order could differ
 * between two readings would make the draw uncheckable. Nothing here sorts,
 * filters or dedupes — `contendersFor` already did all three, once.
 *
 * **Every failure here THROWS** (AD-1). A draw is not a command a Manager
 * issues and there is nothing about it a rule can refuse: a missing seed, a
 * malformed one, a commitment that does not match, an empty list and a
 * Contender missing an identity are each a bug, and each of them silently
 * papered over is a lottery nobody can check. `close.ts` takes the identical
 * posture, for the identical reason.
 *
 * `close.ts` does NOT import this module — it only declares the `ClosedWinner`
 * shape this one produces — so the type import below closes no cycle.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import { hash } from '../hash.ts';
import type { Auction } from '../projection/auctions.ts';
import type { ClosedWinner } from './close.ts';

/**
 * The alphabet a seed is written in, and the value of each digit is its
 * position in it.
 *
 * Lowercase hex because that is what `sha256sum` prints and therefore what a
 * Manager comparing by hand will have in front of them — `core/hash.ts` fixed
 * that casing for the commitment and this is the same string in the same
 * alphabet. An uppercase seed is a DIFFERENT string, would hash to a different
 * commitment, and is refused rather than folded to lowercase: normalising here
 * would mean the value this module drew from was not the value the log holds.
 */
const HEX_DIGITS = '0123456789abcdef';

/** How many hex digits a seed is: 64, the full 256 bits `hash` commits to. */
const SEED_DIGITS = 64;

/**
 * Exactly 64 lowercase hex digits, anchored at both ends.
 *
 * `server/bidding.ts` writes `randomBytes(32).toString('hex')`, so every seed
 * this app has ever sealed matches. The check is here for what a hand-written
 * or corrupt row could hold: an insert-only table cannot be corrected in place
 * (AD-4), and a draw run over a value that is not a seed would produce a
 * winner nobody could reproduce.
 */
const SEED_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Whether a string is shaped like a seed — the ONE definition of that, shared
 * rather than restated.
 *
 * `rules/close.ts` asks this too, because `decideClose` publishes the seed and
 * re-checks what it publishes whatever route the `ClosedWinner` took to reach
 * it. Two literals would be two answers to one question, and the failure mode
 * is a reveal that one of them would have refused.
 *
 * Exported as a predicate rather than as the pattern so no caller can come to
 * depend on the regular expression's own object identity or state.
 *
 * The import this creates runs `close.ts` -> `draw.ts` only: this module's
 * `import type { ClosedWinner }` is erased at compile time, so there is no
 * runtime cycle in either runtime that loads these files.
 */
export function isSeedShaped(value: string): boolean {
	return SEED_PATTERN.test(value);
}

/**
 * The 0-based position in the Contender list the seed selects.
 *
 * The ONE expression a Manager reproduces, and the reason it is exported on
 * its own rather than buried in `drawnWinnerFor`: `/verify` prints this
 * procedure in prose, and `tests/core/draw.test.ts` drives the same function
 * the close does, so the printed procedure and the executed one cannot be two
 * different derivations.
 *
 * Spreadsheet form, filled down 64 rows:
 *
 *     B2 = MOD(B1*16 + HEX2DEC(MID($seed, ROW()-1, 1)), $n)
 *
 * Both arguments are validated rather than trusted. `contenderCount` of zero
 * would make the modulus zero and every intermediate `NaN`, which would then
 * index the list with a non-number and read back `undefined` — a "winner" that
 * is the absence of one. A count of one is NOT a special case and needs none:
 * `seed mod 1 = 0` selects the only Contender there is (PRD SS10 example 11).
 */
export function drawIndex(seed: string, contenderCount: number): number {
	if (!Number.isInteger(contenderCount) || contenderCount < 1) {
		throw new TypeError(
			`drawIndex: a draw needs at least one Contender to select from; received a count of ` +
				`${JSON.stringify(contenderCount)} (AD-14)`
		);
	}
	if (!SEED_PATTERN.test(seed)) {
		throw new TypeError(
			`drawIndex: a seed is ${String(SEED_DIGITS)} lowercase hex digits, as sha256sum prints ` +
				`them; received ${JSON.stringify(seed)} (AD-14)`
		);
	}

	// Left to right, every intermediate under `16 * n + 15`. No branch, no
	// rejection step, and nothing that varies with anything but these two
	// arguments.
	let position = 0;
	for (let at = 0; at < seed.length; at += 1) {
		position = (position * 16 + HEX_DIGITS.indexOf(seed[at] ?? '')) % contenderCount;
	}
	return position;
}

/**
 * The Contender the seed selected, as the `ClosedWinner` a lottery's close
 * requires — after verifying the commitment the log already published.
 *
 * Story 3.4 declared `ClosedWinner` and produced nothing; this is its one
 * producer. It is pure and takes only what it is handed, which is what lets
 * `server/close.ts` ask it inside `load` — it must know the winning Team
 * before it can read that Team's roster — and lets `decideClose` be handed the
 * answer rather than re-deriving it from a random source it may not read.
 *
 * **`hash(seed)` is verified against the folded `seedHash` BEFORE any winner
 * is built**, and a mismatch throws with nothing selected. Story 3.3 took the
 * identical posture at the identical question on a dissolution: a reveal that
 * does not answer the commitment a Manager already recorded is the one failure
 * AD-14 cannot survive, so it is foreclosed rather than merely reported.
 *
 * **A `seedHash` of `null` is unverifiable, not fatal.** It is reachable only
 * from a corrupt or hand-written log — `decide()` refuses an opening with no
 * seed, and `readPayload` nulls a malformed commitment rather than throwing —
 * and refusing to draw would strand the Auction in a contention forever, with
 * every Contender's capital committed and no second exit. So the draw runs,
 * and the reveal states `seedHash: null` for the record without implying a
 * check that was never available.
 *
 * Four throws, all of them bugs (AD-1):
 *
 *  - no sealed seed. The seeds table holds nothing for this Player, so there
 *    is no commit-reveal to open and no winner to derive. The Auction stays
 *    open and visibly unclosed, which is the honest state.
 *  - a malformed seed, named against what was required.
 *  - an empty Contender list. There is nobody to draw and no winner to invent.
 *  - a selected Contender missing an identity. `auction_events.manager_id` and
 *    `.team_id` are `not null` and reference real rows, so this would fail at
 *    the foreign key otherwise — at the insert, rather than at the rule that
 *    can name which field was empty.
 */
export function drawnWinnerFor(auction: Auction, seed: string | null): ClosedWinner {
	if (seed === null) {
		throw new TypeError(
			`drawnWinnerFor: no sealed seed exists for "${auction.fantraxPlayerId}", so this ` +
				'Minimum-Bid Contention has no commit-reveal to open and no winner to derive. The ' +
				'Auction stays open rather than being closed on an invented one (AD-14)'
		);
	}
	if (!SEED_PATTERN.test(seed)) {
		throw new TypeError(
			`drawnWinnerFor: the sealed seed for "${auction.fantraxPlayerId}" is not ` +
				`${String(SEED_DIGITS)} lowercase hex digits; received ${JSON.stringify(seed)} (AD-14)`
		);
	}

	// **Before any winner is built, and before the seed is put anywhere it
	// could be read.** `seedHash === null` is the corrupt-log case above: it
	// is not a mismatch, it is the absence of anything to mismatch with.
	if (auction.seedHash !== null) {
		const revealed = hash(seed);
		if (revealed !== auction.seedHash) {
			throw new TypeError(
				`drawnWinnerFor: the sealed seed does not match the published commitment; hash(seed) ` +
					`is ${revealed} and the log published ${auction.seedHash} (AD-14)`
			);
		}
	}

	// The fold's own list, in the fold's own order. Never re-sorted here.
	const contenders = auction.contenders;
	if (contenders.length === 0) {
		throw new TypeError(
			`drawnWinnerFor: "${auction.fantraxPlayerId}" is in a Minimum-Bid Contention with no ` +
				'Contenders. There is nobody to draw and no winner to invent (AD-14)'
		);
	}

	// Computed ONCE and carried onto the winner. `decideClose` publishes this
	// number rather than looking the winner back up, because a lookup answers
	// with the first occurrence of a Team and would agree with the arithmetic
	// only while the list holds no duplicate.
	const selectedIndex = drawIndex(seed, contenders.length);
	const selected = contenders[selectedIndex];
	if (selected === undefined) {
		// Unreachable: `drawIndex` returns `0 <= r < contenders.length` and the
		// list is non-empty one line above. The guard is the narrowing
		// `noUncheckedIndexedAccess` needs, not a reachable state.
		throw new TypeError('drawnWinnerFor: the derived position is outside the Contender list');
	}
	if (selected.teamId === '' || selected.teamName === '' || selected.managerId === '') {
		throw new TypeError(
			`drawnWinnerFor: the drawn Contender at position ` +
				`${String(contenders.indexOf(selected))} carries an empty teamId, teamName or ` +
				`managerId, and a close names all three (AD-1)`
		);
	}

	return {
		kind: 'drawn',
		teamId: selected.teamId,
		teamName: selected.teamName,
		managerId: selected.managerId,
		// The revealed seed and the list it was applied to, carried through to
		// the reveal `decideClose` appends — so the event a Manager checks
		// holds the derivation's inputs beside its output.
		seed,
		contenders: contenders.map((contender) => contender.teamId),
		// The output itself, beside those inputs.
		selectedIndex
	};
}
