/**
 * Narrowing the Free Agent pool: the search text, the position filter, and
 * every word either of them says (Story 9.8).
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
 * holds the two controls' state and prints what comes back; every decision
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
};

/** What the Manager has asked to see. Both parts are optional and combine. */
export type PoolFilter = {
	/** Free text, as typed. Empty or blank means "no text filter". */
	readonly search: string;
	/** Selected position tokens. Empty means "every position", never "none". */
	readonly positions: readonly string[];
};

/** The filter that hides nothing — the state the page opens in. */
export const NO_POOL_FILTER: PoolFilter = Object.freeze({
	search: '',
	positions: Object.freeze([]) as readonly string[]
});

/** Whether either control is actually narrowing anything. */
export function isFiltering(filter: PoolFilter): boolean {
	return filter.search.trim() !== '' || filter.positions.length > 0;
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
 */
export function matchesPoolFilter(player: FilterablePlayer, filter: PoolFilter): boolean {
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
 * How much of the pool is showing, in words — or NOTHING, when the Manager
 * has not asked for anything.
 *
 * **Silence is the unnarrowed answer.** The line used to state the pool size
 * at rest, and a size is not news: it is the same figure on every visit, it
 * answers a question nobody asked, and it cost a line of the first screen on
 * a phone where the list, the filter and the control are all competing for
 * one. A count earns its line only once a Manager has narrowed something and
 * the count has therefore changed.
 *
 * Always BOTH numbers when narrowed — "42 of 1,467" — because the question a
 * Manager then has is not "how many can I see" but "how much of the pool am I
 * not looking at". A bare "42 Players" answers the first and hides the second.
 *
 * The empty string, not `null`: the caller renders one live region that is
 * always in the DOM and sometimes empty. A region that is added and removed
 * is not announced by every screen reader, and the no-match case is the one
 * sentence on this page a Manager cannot do without.
 *
 * No `Intl.NumberFormat` — it is forbidden in the core (AD-2), and the
 * separator is inserted by hand below for that reason.
 */
export function poolCountSentence(shown: number, total: number, filter: PoolFilter): string {
	if (!isFiltering(filter)) return '';
	if (shown === 0) {
		return `No Player matches. ${groupDigits(total)} are in the pool; clear the search or the positions to see them.`;
	}
	return `Showing ${groupDigits(shown)} of ${groupDigits(total)} ${total === 1 ? 'Player' : 'Players'}.`;
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
