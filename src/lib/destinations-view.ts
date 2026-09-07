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
