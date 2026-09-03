/**
 * The deep link to one Auction — written ONCE, here (Story 4.4).
 *
 * `epic-4-context.md` requires a "stable, addressable shape" for a single
 * Auction because Epic 5 emits those links into Discord without this epic
 * knowing Discord exists. A shape spelled in each `.svelte` file that happens
 * to link to an Auction is not stable: it is several literals that agree
 * today, and the first one to be edited is the one that starts sending
 * Managers to a 404 from a Discord message nobody can recall.
 *
 * Before this module the repository held exactly one such literal
 * (`routes/board/+page.svelte`'s card link) and Story 4.4 adds a second
 * surface, which is the moment a literal becomes a duplication rather than a
 * fact. Both call this now, and Story 5.3 emits the same shape by calling it
 * too rather than by re-deriving it from the route tree.
 *
 * It is a PATH and never an absolute URL: the origin is deployment
 * configuration the core cannot see, and a core module that spelled a host
 * would be reading the world (AD-2). A notification that needs an absolute
 * link joins its own origin onto this.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

/**
 * The path prefix every Auction link carries, with its trailing slash.
 *
 * Exported beside the function so a test — and a future notification
 * template — can assert the shape without rebuilding it from a Player id
 * that would make the assertion circular.
 */
export const AUCTION_PATH_PREFIX = '/auction/';

/**
 * The path of one Player's Auction page.
 *
 * The Fantrax player id is the route parameter `routes/auction/[fantraxPlayerId]`
 * declares, and it is passed through unencoded for the reason the board's own
 * literal did: these ids are the log's own keys, they appear in the URL bar of
 * every Auction page already, and encoding one here would produce a path that
 * does not match the link the Auction page itself was reached by.
 */
export function auctionPathFor(fantraxPlayerId: string): string {
	return `${AUCTION_PATH_PREFIX}${fantraxPlayerId}`;
}
