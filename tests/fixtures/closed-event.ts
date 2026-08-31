/**
 * A well-formed `AuctionClosed` payload, for every test that needs a close it
 * is not itself asserting the shape of.
 *
 * **Why this exists.** Until Story 3.4 no producer of `AuctionClosed` existed,
 * so tests built synthetic ones carrying only `fantraxPlayerId` — the one
 * field `nominationsReducer` and `auctionsReducer` read. Story 3.4's code
 * review made `projection/nominations.ts`'s `readClosedFacts` the single
 * definition of a well-formed close, shared by all three reducers that fold
 * one, so that a payload any of them skips is skipped by all of them. A close
 * naming a Player but no Team, placement or price is no longer a close: it
 * releases no board seat, drops no Auction and records no contract, which is
 * the whole point — previously it did the first two and not the third, and a
 * won Player fell silently back into the nominatable pool.
 *
 * So a synthetic close now has to carry what a real one carries. This builder
 * is that shape in one place; pass overrides for the fields a given test is
 * actually about, including `undefined` to blank a required field when the
 * test IS about a malformed close being skipped.
 */

/** The default winning Team — arbitrary, and overridden wherever it matters. */
export const CLOSED_TEAM_ID = 't-w';

export function closedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		fantraxPlayerId: 'p-1',
		playerName: 'A Won Player',
		teamId: CLOSED_TEAM_ID,
		teamName: 'Team W',
		managerId: 'm-w',
		winningAmount: 1_000_000,
		capHit: 1_000_000,
		placement: 'active_bench',
		contention: 'standard',
		contractYears: null,
		closedAt: '2026-08-27T09:00:00.000Z',
		...overrides
	};
}
