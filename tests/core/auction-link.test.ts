/**
 * The Auction deep-link shape (Story 4.4).
 *
 * `epic-4-context.md` requires a "stable, addressable shape" for a single
 * Auction because Epic 5 emits those links into Discord without this epic
 * knowing Discord exists. Stability is only meaningful if there is exactly ONE
 * spelling, so this suite asserts both halves: what the shape is, and that no
 * surface spells it itself.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { AUCTION_PATH_PREFIX, auctionPathFor } from '../../src/lib/core/auction-link.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const at = (...parts: string[]): string => join(ROOT, ...parts);

const BOARD_PAGE = readFileSync(at('src', 'routes', 'board', '+page.svelte'), 'utf8');
const POSITIONS_PAGE = readFileSync(at('src', 'routes', 'positions', '+page.svelte'), 'utf8');

describe('the deep-link shape', () => {
	it('is the route the Auction page actually lives at', () => {
		// `src/routes/auction/[fantraxPlayerId]/+page.svelte` is the route, so
		// the prefix is what a browser must ask for to reach it.
		expect(AUCTION_PATH_PREFIX).toBe('/auction/');
		expect(auctionPathFor('p-1')).toBe('/auction/p-1');
	});

	it('is composed from the prefix rather than restating it', () => {
		// If the prefix ever moves, the function moves with it — there is no
		// second literal inside the function to leave behind.
		expect(auctionPathFor('abc123').startsWith(AUCTION_PATH_PREFIX)).toBe(true);
		expect(auctionPathFor('abc123')).toBe(`${AUCTION_PATH_PREFIX}abc123`);
	});

	it('is a PATH and never an absolute URL', () => {
		// The origin is deployment configuration the core cannot see, and a
		// core module that spelled a host would be reading the world (AD-2).
		expect(auctionPathFor('p-1')).not.toMatch(/^https?:/);
		expect(auctionPathFor('p-1').startsWith('/')).toBe(true);
	});

	it('is total over any id the log can hold, including an empty one', () => {
		// The ids are the log's own keys and a malformed historical one must
		// produce a link that 404s rather than a thrown render.
		expect(() => auctionPathFor('')).not.toThrow();
		expect(auctionPathFor('')).toBe(AUCTION_PATH_PREFIX);
	});
});

describe('it is the ONLY spelling — no surface writes the shape itself', () => {
	it.each([
		['board', BOARD_PAGE],
		['positions', POSITIONS_PAGE]
	])('%s renders no literal /auction/ template', (_name: string, source: string) => {
		// A template literal is what stood in `board/+page.svelte:335` before
		// this story, and it was the only such site in the repository. Two
		// surfaces spelling it would be two shapes that agree by coincidence,
		// and the first one edited is the one that starts sending Managers to
		// a 404 from a Discord message nobody can recall.
		expect(source).not.toMatch(/`\/auction\//);
		expect(source).not.toMatch(/href="\/auction\//);
	});

	it('reaches the shape through the core on the board', () => {
		expect(BOARD_PAGE).toContain("from '$lib/core/auction-link.ts'");
		expect(BOARD_PAGE).toContain('auctionPathFor(');
	});

	it('reaches the shape through the core on Your Positions', () => {
		// The Positions page prints `card.href`, which `core/positions.ts`
		// built by calling `auctionPathFor` — so the surface holds no route
		// knowledge at all, which is one step further than the board.
		expect(POSITIONS_PAGE).toContain('card.href');
	});
});
