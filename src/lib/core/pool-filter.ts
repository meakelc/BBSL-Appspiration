/**
 * Narrowing the Free Agent pool: the search text, the position filter, the
 * hiding of the Players who cannot be nominated, and every word any of them
 * says (Story 9.8).
 *
 * **Narrowing is not ranking, and this module must never become ranking.**
 * `/nominate` renders the pool in the order the Fantrax export supplied it,
 * and nothing here reorders anything: `filterPool` returns a subsequence of
 * the list it was handed, in the order it was handed it. A Manager saying
 * "show me the centres" is the Manager deciding what to look at; the app
 * deciding which centre is worth looking at would be advice this product has
 * no standing to give. There is no relevance score, no fuzzy match ranking,
 * and no suggested Player — for the same reason `/nominate` has never had one.
 *
 * **The whole of it is pure, and that is what makes it testable.** The page
 * holds the controls' state and prints what comes back; every decision
 * about what matches, and every sentence about what was found, is decided
 * once here. A filter that disagreed with its own count would be the same
 * defect as a refusal that disagreed with its own gate.
 *
 * **Filtering NEVER touches the submission.** Nothing in this module knows
 * that a form exists. The caller's obligation — stated here because it is the
 * one way this feature could break nomination — is that a Player the Manager
 * has already chosen must not be filtered out from under them: their radio
 * would unmount and the form would post no Player at all. `filterPool` takes
 * `keepIds` for exactly that, so "the chosen Player always survives the
 * filter" is a rule with one implementation rather than a thing every caller
 * has to remember.
 *
 * **`Positions` here means the basketball position text on a pool row** — the
 * export's `Position` cell, verbatim, like `PG,SG,G`. It is unrelated to
 * `core/positions.ts`, which is the five groups of Your Positions (Story
 * 4.4). The collision is Fantrax's word against the product's; both are load
 * bearing in their own place, so neither is renamed and this note is the
 * pointer between them.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

/**
 * The position tokens a Fantrax export uses, in the order the chips are read.
 *
 * Confirmed 2026-09-07 against the real 1,467-Player BBSL pool: these seven
 * are exactly the tokens that appear, across fifteen distinct cells. `G` and
 * `F` are the export's own umbrella tokens and are LISTED ALONGSIDE the
 * specific ones on every row that has them — every guard's cell carries `G`,
 * every forward's carries `F`. So "any guard" needs no derivation and this
 * module infers nothing: it matches the tokens the file states, and a chip is
 * a question about the file rather than about basketball.
 */
export const POOL_POSITIONS: readonly string[] = Object.freeze([
	'PG',
	'SG',
	'G',
	'SF',
	'PF',
	'F',
	'C'
] as const);

/**
 * What each token is called, spelled out.
 *
 * The chip's visible text is the abbreviation, because that is what the pool
 * rows say and a Manager scanning both should not have to translate between
 * two vocabularies. The spelled-out name is the chip's accessible name, so a
 * screen reader says "Point guard" rather than spelling "P G" — the same
 * split the abbreviation-heavy board already makes.
 */
export const POOL_POSITION_NAMES: Readonly<Record<string, string>> = Object.freeze({
	PG: 'Point guard',
	SG: 'Shooting guard',
	G: 'Any guard',
	SF: 'Small forward',
	PF: 'Power forward',
	F: 'Any forward',
	C: 'Centre'
});

/** One pooled Player, in the only shape narrowing needs to see. */
export type FilterablePlayer = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** The export's `Position` cell, verbatim — `PG,SG,G`. */
	readonly positions: string;
	readonly nbaTeam: string;
	/**
	 * Whether this Player can be nominated at all.
	 *
	 * NOT re-derived here, and this module must never learn how to derive it:
	 * it is `refuseNomination`'s answer, computed per row by the server from
	 * the same gate the submit runs under the lock. Narrowing reads that flag
	 * and holds no opinion about why it is false — already nominated, already
	 * in an Auction, or under contract are three states with one consequence,
	 * and the row's own `status` phrase is where they are told apart.
	 */
	readonly available: boolean;
};

/** What the Manager has asked to see. Every part is optional and they combine. */
export type PoolFilter = {
	/** Free text, as typed. Empty or blank means "no text filter". */
	readonly search: string;
	/** Selected position tokens. Empty means "every position", never "none". */
	readonly positions: readonly string[];
	/**
	 * Whether the Players who cannot be nominated are listed.
	 *
	 * **`false` is the resting state, and that is the one place this module's
	 * default hides something.** By the middle of an auction most of the pool
	 * is a Player somebody already nominated, and a list whose majority is
	 * rows that refuse the tap is a list a Manager scrolls past rather than
	 * reads. They are hidden by default and revealed by one control, because
	 * they are still the answer to "who went already" and that question is
	 * worth a tap.
	 *
	 * It narrows RENDERING and nothing else: an unavailable Player stays
	 * unavailable whether or not their row is on screen, and the server
	 * re-derives every gate under the lock regardless of what was shown.
	 */
	readonly showUnavailable: boolean;
};

/**
 * The filter the page opens in.
 *
 * It is no longer the filter that hides NOTHING — it hides the Players who
 * cannot be nominated, which is the point of the default above. It is still
 * the filter a Manager has asked nothing of.
 */
export const NO_POOL_FILTER: PoolFilter = Object.freeze({
	search: '',
	positions: Object.freeze([]) as readonly string[],
	showUnavailable: false
});

/**
 * Whether what is on screen is narrower than the pool.
 *
 * All THREE controls count, the availability default included: at rest the
 * list really is shorter than the pool. It matters for the no-match sentence,
 * which has to fire when the pool is hidden down to nothing by a default the
 * Manager never set — an empty list with no explanation is the one failure
 * that reads as a broken page.
 */
export function isFiltering(filter: PoolFilter): boolean {
	return filter.search.trim() !== '' || filter.positions.length > 0 || !filter.showUnavailable;
}

/** Whether the Manager has typed or picked anything. Not the hiding default. */
function isNarrowedByHand(filter: PoolFilter): boolean {
	return filter.search.trim() !== '' || filter.positions.length > 0;
}

/** How many of these Players cannot be nominated — what the default hides. */
export function countUnavailable(players: readonly FilterablePlayer[]): number {
	return players.filter((player) => !player.available).length;
}

/**
 * The export's `Position` cell split into its tokens.
 *
 * Comma-separated is what the real file uses (`PG,SG,G`), and the cell is
 * quoted so the CSV's own comma never reaches here. Blanks are dropped rather
 * than becoming an empty token that could match an empty chip.
 */
export function splitPositions(cell: string): readonly string[] {
	return cell
		.split(',')
		.map((token) => token.trim().toUpperCase())
		.filter((token) => token !== '');
}

/**
 * Search text reduced to what comparison should ignore.
 *
 * `toLowerCase`, never `toLocaleLowerCase`, and no `Intl` anywhere: AD-2 has
 * this module loading in both Node and Deno, and locale-dependent casing is
 * exactly the class of divergence that rule exists to close.
 *
 * No diacritic folding, deliberately. The real export spells every one of its
 * 1,467 names in plain ASCII — `Nikola Jokic`, not `Jokić` — so stripping
 * combining marks would be machinery against a case this data does not have.
 * If a future export ships accents, this is the one function that changes.
 */
function normalise(text: string): string {
	return text.trim().toLowerCase();
}

/**
 * Whether one Player answers the filter.
 *
 * The two controls are ANDed — text AND position — because they answer
 * different questions and a Manager who typed a name and picked `C` is asking
 * for both. Position tokens are ORed among themselves: picking `PG` and `SG`
 * asks for either, which is the only reading of a multi-select that is not a
 * contradiction.
 *
 * The text matches a substring of the Player's name OR their NBA team, so
 * `LAL` finds the Lakers' Free Agents and `white` finds Derrick White. It is
 * a substring, not a prefix: half the value of a search box on a list this
 * long is finding a Player by their surname alone.
 *
 * Availability is ANDed in with the rest, and it is tested FIRST because it is
 * the one term that is true by default rather than by something the Manager
 * typed. A Player who cannot be nominated fails the filter unless the Manager
 * has asked to see them — so searching a name that is already on the Bid Board
 * finds nothing until that control is on, which is exactly what the count
 * sentence below then says.
 */
export function matchesPoolFilter(player: FilterablePlayer, filter: PoolFilter): boolean {
	if (!filter.showUnavailable && !player.available) return false;

	const needle = normalise(filter.search);
	if (needle !== '') {
		const haystack = `${normalise(player.playerName)} ${normalise(player.nbaTeam)}`;
		if (!haystack.includes(needle)) return false;
	}

	if (filter.positions.length > 0) {
		const held = splitPositions(player.positions);
		if (!filter.positions.some((wanted) => held.includes(wanted.toUpperCase()))) return false;
	}

	return true;
}

/**
 * The pool narrowed to what the Manager asked for, in the order it arrived.
 *
 * `keepIds` survives the filter unconditionally. It exists for the chosen
 * Player and for nothing else: a radio that unmounts takes the selection with
 * it, so a Manager who chose a Player and then typed a search would submit a
 * form naming nobody. Keeping the row rendered is the fix that needs no second
 * hidden input — and a second input carrying the same name is exactly the
 * submission bug `/nominate` already refuses to introduce for layout.
 */
export function filterPool<T extends FilterablePlayer>(
	players: readonly T[],
	filter: PoolFilter,
	keepIds: readonly string[] = []
): readonly T[] {
	if (!isFiltering(filter) && keepIds.length === 0) return players;
	return players.filter(
		(player) => keepIds.includes(player.fantraxPlayerId) || matchesPoolFilter(player, filter)
	);
}

/** The search control's label. Stated here so the surface prints, never words. */
export const POOL_SEARCH_LABEL = 'Find a Player by name or NBA team';

/** The position chips' group label. */
export const POOL_POSITION_LEGEND = 'Filter by position';

/**
 * The availability control's label — an instruction, because it is a checkbox
 * and the state it leads to is what a Manager is deciding about.
 *
 * It says what it reveals rather than what it hides, so the checked state and
 * the sentence agree: ticking it shows them, unticking it puts them back.
 */
export const POOL_SHOW_UNAVAILABLE_LABEL = 'Show nominated Players';

/**
 * The ONE thing narrowing has to say: that it matched nobody.
 *
 * **There is no running count, and that is the whole shape of this function.**
 * It used to print "Showing 42 of 1,467 Players" whenever the list was
 * narrower than the pool, which by the end was almost always — and neither
 * number is a thing a Manager does anything with. They came to find a Player,
 * not to audit how many rows the filter left; the line changed under them on
 * every keystroke, and it cost a line of a phone's first screen that the
 * search, the chips, the disclosure and the list itself are already competing
 * for. A count is arithmetic about a list that is on screen to be read.
 *
 * What survives is the case where there IS no list to read. "No Player
 * matches" is the one sentence this page cannot do without: without it a
 * Manager who typed a name that is already on the Bid Board sees an empty
 * space and no reason for it. It names the controls that are actually
 * narrowing, so the way back is the control they touched.
 *
 * The empty string, not `null`: the caller renders one live region that is
 * always in the DOM and usually empty. A region that is added and removed is
 * not announced by every screen reader, and this is exactly the sentence that
 * has to be announced.
 *
 * No `Intl.NumberFormat` — it is forbidden in the core (AD-2), and the
 * separator is inserted by hand below for that reason.
 */
export function poolCountSentence(shown: number, total: number, filter: PoolFilter): string {
	if (!isFiltering(filter)) return '';
	if (shown > 0) return '';
	return `No Player matches. ${groupDigits(total)} are in the pool; ${wideningAdvice(filter)} to see them.`;
}

/**
 * What to undo to get the pool back, naming only the controls that are on.
 *
 * A Manager who has typed nothing and picked nothing is looking at an empty
 * list for exactly one reason — every match is a Player already nominated —
 * and telling them to "clear the search" is advice about a control they never
 * touched. Naming the controls that are actually narrowing is the difference
 * between a sentence that helps and a sentence that is always printed.
 */
function wideningAdvice(filter: PoolFilter): string {
	const byHand = isNarrowedByHand(filter) ? 'clear the search or the positions' : '';
	const hiding = filter.showUnavailable ? '' : 'show the nominated Players';
	if (byHand !== '' && hiding !== '') return `${byHand}, or ${hiding}`;
	return byHand !== '' ? byHand : hiding;
}

/**
 * What the availability control is hiding, in words, for its own disclosure.
 *
 * It is the summary of a collapsed control, so it states the FACT rather than
 * the instruction: a Manager reads how much of the pool is out of sight and
 * opens the disclosure only if that is a number they want back. The
 * instruction is the label on the checkbox inside.
 *
 * The count is of the WHOLE pool, not of what survived the search — the
 * question this answers is "how many Players are gone already", which does not
 * change because somebody typed a name. `poolCountSentence` is the one that
 * tracks the visible list.
 *
 * **"Nominated" is the word, for all of them.** The flag this counts is every
 * Player the gate refuses, which is three states — already nominated, in an
 * Auction, or under contract. Spelling all three out was a taxonomy in the
 * summary of a collapsed control: a Manager reading it is deciding whether to
 * open a disclosure, not learning the refusal vocabulary, and "nominated" is
 * what they call a Player who has gone already. The distinction is not lost,
 * it is just not here — every revealed row still carries its own state phrase,
 * `Nominated`, `In-Auction` or `Closed to <Team>`, which is where the three
 * are told apart and always was.
 */
export function hiddenPoolSentence(hidden: number, filter: PoolFilter): string {
	if (filter.showUnavailable) {
		return 'The nominated Players are listed, greyed out with their state.';
	}
	if (hidden === 0) {
		return 'Every Player in the pool can be nominated.';
	}
	const plural = hidden === 1 ? 'Player is' : 'Players are';
	return `${groupDigits(hidden)} nominated ${plural} hidden.`;
}

/**
 * Thousands separators, by hand.
 *
 * `Number.prototype.toLocaleString` and `Intl.NumberFormat` both read ICU data
 * that differs between Node and Deno, which is the divergence AD-2 forbids;
 * `check-core-purity.js` fails the build on `Intl` for that reason. A pool
 * count is a plain non-negative integer, so grouping it is four lines rather
 * than a dependency.
 */
function groupDigits(value: number): string {
	const digits = String(Math.trunc(Math.abs(value)));
	let grouped = '';
	for (let at = 0; at < digits.length; at += 1) {
		if (at > 0 && (digits.length - at) % 3 === 0) grouped += ',';
		grouped += digits[at];
	}
	return value < 0 ? `-${grouped}` : grouped;
}
