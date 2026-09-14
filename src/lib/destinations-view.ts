/**
 * Classifying one resolved destination list into what a render needs (AC6).
 *
 * Extracted from `DestinationsList.svelte`'s classification logic so it is a
 * plain function `vitest` can call directly. `tests/signin-surface.test.ts`'s
 * block-placement guard reads rendered markup and catches a Commissioner-only
 * entry landing in the wrong CSS block once the template's class names
 * themselves move — but the class names `control-manager`/`control-commissioner`
 * never move in source text regardless of which array a filter routes an
 * entry into, so that guard is structurally unable to see a swapped filter
 * predicate (`!destination.commissionerOnly` flipped). This function, and
 * `tests/destinations-view.test.ts` calling it directly, close that gap: the
 * markup guard catches a structural regression, this one catches a logical
 * one.
 *
 * The `Destination` shape is declared structurally here rather than imported
 * from `server/destinations.ts` — the same reason other `.svelte`-adjacent
 * modules duplicate it: nothing server-only may be reachable from a
 * client-facing module.
 */

/** One entry in a destination list — structurally the same shape as `server/destinations.ts`'s `Destination`. */
export type Destination = {
	readonly id: string;
	readonly label: string;
	readonly href: string;
	readonly commissionerOnly: boolean;
	/**
	 * Whether this entry renders as a row. A catalog entry is a PERMISSION
	 * first — `requireLiveDestination` refuses out of the same table — and
	 * `auction` is one that gates a route (`/auction/[fantraxPlayerId]`, on
	 * the load and on the bid action) without having a page of its own to
	 * link to. Filtering here rather than in the catalog is what keeps the
	 * permission intact while the dead row goes.
	 */
	readonly listed: boolean;
};

/** What a render of one destination list needs, split apart. */
export type ClassifiedDestinations = {
	readonly signIn: Destination | undefined;
	readonly managerDestinations: readonly Destination[];
	readonly commissionerDestinations: readonly Destination[];
	/**
	 * True when none of the three groups above carry anything — the state a
	 * non-Commissioner Manager sees through all of Setup, now that Setup's
	 * four entries are Commissioner-only. Computed here, not in
	 * `DestinationsList.svelte`, for the same reason the split itself is:
	 * so a `vitest` test can assert it directly rather than only by scanning
	 * rendered markup.
	 */
	readonly hasNothingLive: boolean;
};

/**
 * The Sign-in entry's id, matching `server/destinations.ts`'s
 * `SIGN_IN_DESTINATION.id` — a data convention, not a type import, so this
 * module keeps its structural, server-free shape.
 */
const SIGN_IN_ID = 'sign-in';

/**
 * Split a resolved destination list into what a render needs: the Sign-in
 * entry, if present, held apart from the manager/commissioner grouping —
 * mislabelling it as a Manager or Commissioner control would misstate an
 * unauthenticated visitor's one action as one of theirs — and every other
 * entry sorted into exactly one of the other two arrays by its
 * `commissionerOnly` flag. Entries with `listed: false` are permissions with
 * no menu row and are dropped before the split.
 */
export function classifyDestinations(destinations: readonly Destination[]): ClassifiedDestinations {
	// Unlisted entries are dropped before anything else looks at them, so
	// `hasNothingLive` counts rows a Manager can actually see rather than
	// permissions they merely hold. Sign-in is always listed.
	const listed = destinations.filter((entry) => entry.listed);
	const signIn = listed.find((entry) => entry.id === SIGN_IN_ID);
	const rest = listed.filter((entry) => entry.id !== SIGN_IN_ID);
	const managerDestinations = rest.filter((entry) => !entry.commissionerOnly);
	const commissionerDestinations = rest.filter((entry) => entry.commissionerOnly);

	return {
		signIn,
		managerDestinations,
		commissionerDestinations,
		hasNothingLive:
			signIn === undefined && managerDestinations.length === 0 && commissionerDestinations.length === 0
	};
}

/**
 * How many destinations the mobile bar may show at once.
 *
 * Five is not a preference, it is what a 320px viewport fits: five buttons
 * leave 64px each, which clears the 44px touch floor with room for a drawn
 * icon over a label. A sixth would either drop below that floor or push the
 * bar into a scrolling row, and a nav bar you have to scroll saves nobody a
 * tap. The Auction phase's Manager list is exactly five — Your Positions,
 * Bid Board, Nominate, Teams, Audit Log — so in the phase the product spends
 * most of its life in, nothing is cut.
 */
export const NAV_DESTINATION_LIMIT = 5;

/**
 * The destinations the mobile bar carries: a Manager's own, in catalog order,
 * capped at `NAV_DESTINATION_LIMIT`.
 *
 * Derived from the SAME resolved list the sheet renders (AD-30) rather than
 * from a second table of its own — a bar offering a destination the sheet
 * does not, or in a different phase, would be exactly the second resolution
 * of "what may this Manager reach" that AR-29/UX-DR19 exists to prevent. So
 * this only ever SELECTS from what `resolveDestinations` already returned;
 * it can narrow that set and can never widen it.
 *
 * Commissioner-only entries are deliberately excluded. They are
 * administrative acts — Import, the Export gate, the three roster acts —
 * performed rarely and not from a thumb bar, and with the Auction phase
 * alone holding six of them there is no cap under which they and a Manager's
 * own five could coexist. Every one of them stays one tap away in the sheet,
 * which the strip carries on every surface.
 *
 * Sign-in is excluded for the reason `classifyDestinations` holds it apart:
 * an unauthenticated visitor's one action is not a Manager's navigation, and
 * a one-button bar reading "Sign-in" beneath a page that is already the
 * Sign-in page is not navigation at all.
 */
export function navDestinations(
	destinations: readonly Destination[]
): readonly Destination[] {
	const { managerDestinations } = classifyDestinations(destinations);
	return managerDestinations.slice(0, NAV_DESTINATION_LIMIT);
}
